import { mkdirSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { importedPlan, savedPlan, submitAdmittedImportedPlan, submitImportedPlan, type PlanSubmission } from "../flow/actions.ts"
import { canonicalPlanSha, planToTasks } from "../flow/plan.ts"
import { INSTANCE_ID, pidAlive } from "../flow/owner.ts"
import { applyEvent, approveWorkflow, cancelWorkflow, resolveAuthority, settle, startWorkflow, type FlowResult } from "../flow/runtime.ts"
import { flowOn, renderStatus, statusJson } from "../flow/status.ts"
import { activeWorkflow, readWorkflow, workflowEngineRefusal, type Workflow } from "../flow/state.ts"
import { getQueue, type QueueRun } from "../orchestration/queue.ts"
import { readLedger, OPEN_STATUSES } from "../state/ledger.ts"
import { sessionDir, stateRoot } from "../state/store.ts"
import { LinuxAdmissionRefused, type ExecutionReconciliation, type ExecutionRuntime, type FlowRuntime } from "./types.ts"
import { persistedHostReference, settled } from "./run-state.ts"
import type { VerificationReference } from "../orchestration/verifier.ts"
import { authenticateLinuxVerification } from "./linux-domain.ts"
import { consumeOperatorDecision, type OperatorDecision } from "./operator.ts"
import { assertHostAdmission } from "./required-controls.ts"

const HOST_ENGINE_MISMATCH = "host engine identity mismatch; recovery refused"

export type ForegroundController = ReturnType<typeof createForegroundController>

/** No SDK/client is synthesized here. The caller supplies a complete, single-host ExecutionRuntime. */
export function createForegroundController(runtime: ExecutionRuntime) {
  const queue = getQueue(runtime)
  let reviewActivity: { sessionID: string; workflowID: string; abort: AbortController } | undefined
  const root = realpathSync(runtime.worktree)
  if (root !== runtime.worktree || runtime.stateRoot !== stateRoot(root)) throw new Error("runtime worktree/state root must be canonical")
  if (runtime.directory !== root) throw new Error("foreground commands must run from the source worktree root")

  function assertWorkflowEngine(wf: Workflow): void {
    const refusal = workflowEngineRefusal(wf, runtime.host.identity.engine)
    if (refusal) throw new Error(refusal)
  }

  function activeWorkflowForHost(): Workflow | null {
    const wf = activeWorkflow(root)
    if (wf) assertWorkflowEngine(wf)
    return wf
  }

  function assertWorkflowUnchanged(expected: Workflow | null, sessionID: string): Workflow | null {
    const current = activeWorkflowForHost()
    if (current?.id !== expected?.id) throw new Error("workflow changed during foreground operation")
    if (current && current.sessionID !== sessionID) throw new Error("another session owns the workflow")
    return current
  }

  function assertWorkflowRecordUnchanged(expected: Workflow, sessionID: string): Workflow {
    const current = readWorkflow(root)
    if (!current || current.id !== expected.id) throw new Error("workflow changed during foreground operation")
    assertWorkflowEngine(current)
    if (current.sessionID !== sessionID) throw new Error("another session owns the workflow")
    return current
  }

  function workflow(sessionID: string, phase?: Workflow["phase"]): Workflow {
    const wf = activeWorkflowForHost()
    if (!wf || wf.sessionID !== sessionID) throw new Error("no workflow owned by this session")
    if (phase && wf.phase !== phase) throw new Error(`workflow is ${wf.phase}, expected ${phase}`)
    // Unlike the plugin command path, a live foreign instance must not be taken over by a new CLI process.
    if (wf.owner.instance !== INSTANCE_ID && pidAlive(wf.owner.pid)) throw new Error("a live foreign workflow owner must finish first")
    return wf
  }

  function settlePendingCancellation(sessionID: string, workflowID: string): void {
    runtime.linuxAdmission?.assertBootEpoch()
    const current = readWorkflow(root)
    if (!current || current.id !== workflowID || current.sessionID !== sessionID || !current.pendingCancel) return
    assertWorkflowEngine(current)
    if (queue.isRunning(sessionID) || (reviewActivity?.sessionID === sessionID && reviewActivity.workflowID === workflowID)) return
    const status = runtime.runs.status()
    if (status.claim) return
    if (status.executions.some(execution => execution.ownerSession === sessionID && !settled(execution))) return
    const latest = readWorkflow(root)
    if (!latest || latest.id !== workflowID || latest.sessionID !== sessionID || !latest.pendingCancel) return
    assertWorkflowEngine(latest)
    const result = settle(runtime, latest, false)
    if (result && !result.ok) runtime.log("foreground cancellation settlement failed", { error: result.text })
  }

  function sourceJson(path: string): unknown {
    const absolute = realpathSync(resolve(root, path))
    const rel = relative(root, absolute)
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("plan JSON source must be inside the worktree")
    }
    return JSON.parse(readFileSync(absolute, "utf8")) as unknown
  }

  function validateImportedPlan(value: unknown, sessionID?: string) {
    runtime.linuxAdmission?.assertBootEpoch()
    const existing = activeWorkflowForHost()
    if (existing && sessionID && existing.sessionID !== sessionID) throw new Error("another session owns the workflow")
    if (existing && existing.phase !== "planning") throw new Error(`workflow is ${existing.phase}, not awaiting a plan`)
    const revision = existing ? 1 + existing.counters.code_invalid + existing.counters.review_iterations + existing.counters.user_rejections : 1
    return importedPlan(value, revision, runtime)
  }

  async function importPlan(sessionID: string, sourcePath: string, signal?: AbortSignal, parsed?: unknown): Promise<PlanSubmission> {
    runtime.linuxAdmission?.assertBootEpoch()
    if (!flowOn(runtime.config)) throw new Error("plan workflow is disabled")
    if (!sessionID || sessionID.includes("/") || sessionID.includes("\\") || sessionID === "." || sessionID === "..") throw new Error("invalid session ID")
    const existing = activeWorkflowForHost()
    if (existing && existing.sessionID !== sessionID) throw new Error("another session owns the workflow")
    if (existing && existing.phase !== "planning") throw new Error(`workflow is ${existing.phase}, not awaiting a plan`)
    if (existing) workflow(sessionID, "planning")
    const plan = validateImportedPlan(parsed === undefined ? sourceJson(sourcePath) : parsed, sessionID)
    // A valid source and host must be established before creating any workflow or model execution.
    const preflight = await runtime.host.preflight(runtime.host.identity.profile)
    assertWorkflowUnchanged(existing, sessionID)
    assertHostAdmission(preflight)
    await reconcile(sessionID, existing)
    assertWorkflowUnchanged(existing, sessionID)
    const admission = await runtime.linuxAdmission?.admitPlanSubmission(sessionID)
    assertWorkflowUnchanged(existing, sessionID)
    mkdirSync(sessionDir(root, sessionID), { recursive: true })
    assertWorkflowUnchanged(existing, sessionID)
    const authority = existing ? resolveAuthority(runtime, "approve", sessionID, runtime.host.identity.engine) : null
    if (authority?.wf) assertWorkflowEngine(authority.wf)
    if (authority?.refuse || (existing && authority?.wf?.id !== existing.id)) throw new Error(authority?.refuse ?? "workflow changed during reconciliation")
    const started = authority?.wf ? { ok: true as const, wf: authority.wf } : startWorkflow(runtime, sessionID, "command", plan.goal, "user_command", runtime.host.identity.engine)
    if (!started.ok) throw new Error(started.text)
    assertWorkflowEngine(started.wf)
    assertWorkflowUnchanged(started.wf, sessionID)
    const review = new AbortController()
    reviewActivity = { sessionID, workflowID: started.wf.id, abort: review }
    const abort = () => review.abort()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) review.abort()
    try {
      const submitted = admission
        ? await submitAdmittedImportedPlan(runtime, started.wf, plan, admission, review.signal)
        : await submitImportedPlan(runtime, started.wf, plan, review.signal)
      assertWorkflowRecordUnchanged(started.wf, sessionID)
      return submitted
    }
    finally {
      signal?.removeEventListener("abort", abort)
      if (reviewActivity?.abort === review) reviewActivity = undefined
      settlePendingCancellation(sessionID, started.wf.id)
    }
  }

  function decide(receipt: OperatorDecision): FlowResult {
    const decision = consumeOperatorDecision(receipt)
    runtime.linuxAdmission?.assertBootEpoch()
    const wf = readWorkflow(root)
    if (wf) assertWorkflowEngine(wf)
    if (!wf || wf.id !== decision.workflowID || !wf.planRef || wf.planRef.jsonSha !== decision.planSha) throw new Error("decision workflow ID or plan hash does not match")
    workflow(wf.sessionID)
    const authority = resolveAuthority(runtime, decision.action, wf.sessionID, runtime.host.identity.engine)
    if (authority.wf) assertWorkflowEngine(authority.wf)
    if (authority.refuse || !authority.wf) throw new Error(authority.refuse ?? "no active workflow")
    if (authority.wf.id !== decision.workflowID || authority.wf.planRef?.jsonSha !== decision.planSha) {
      throw new Error("decision workflow ID or plan hash does not match")
    }
    if (!savedPlan(runtime, authority.wf)) throw new Error("canonical plan or rendered file changed; approval refused")
    if (decision.action === "reject") {
      if (typeof decision.reason !== "string" || !decision.reason.trim()) throw new Error("rejection needs a local reason")
      const current = assertWorkflowUnchanged(authority.wf, wf.sessionID)
      if (!current || current.planRef?.jsonSha !== decision.planSha) throw new Error("decision workflow ID or plan hash does not match")
      return applyEvent(runtime, current, "reject", "user_command", {}, w => w, { reason: decision.reason.trim() })
    }
    const plan = savedPlan(runtime, authority.wf)!
    const queueRunning = queue.isRunning(wf.sessionID)
    const current = assertWorkflowUnchanged(authority.wf, wf.sessionID)
    if (!current || current.planRef?.jsonSha !== decision.planSha) throw new Error("decision workflow ID or plan hash does not match")
    return approveWorkflow(runtime, current, planToTasks(plan), {
      queueRunning, planShaOk: canonicalPlanSha(plan) === decision.planSha,
      mdShaOk: true,
    })
  }

  async function reconcile(sessionID: string, expectedWorkflow: Workflow | null): Promise<void> {
    assertWorkflowUnchanged(expectedWorkflow, sessionID)
    runtime.linuxAdmission?.assertBootEpoch()
    if (queue.isRunning(sessionID) || runtime.runs.status().claim) {
      throw new Error("execution run is owned by another operation")
    }
    const claim = runtime.runs.claim(sessionID, runtime.instance, process.pid)
    for (const execution of runtime.runs.status().executions) {
      assertWorkflowUnchanged(expectedWorkflow, sessionID)
      if (settled(execution)) continue
      if (execution.kind === "verifier") {
        if (execution.generation < claim.generation && execution.verifierDispatch === "prepared") {
          // The durable prepared->started transition is written before run();
          // only its absence from an explicitly prepared record proves no launch.
          runtime.runs.retireUndispatchedVerifier(claim, execution.executionId)
          continue
        }
        if (execution.boundaryRef && execution.profile === "linux-single-use") {
          try {
            const ref = execution.boundaryRef as VerificationReference
            if (ref.kind !== "verifier" || ref.executionID !== execution.executionId || ref.profile !== execution.profile) throw new Error("verifier reference identity mismatch")
            const pending = runtime.verifier.reconcile(ref)
            const observed = await Promise.race([pending, new Promise<null>(r => setTimeout(() => r(null), 1000))])
            if (observed) {
              assertWorkflowUnchanged(expectedWorkflow, sessionID)
              const authenticated = observed.outcome === "terminal" && !!observed.result &&
                authenticateLinuxVerification(observed.result, ref)
              runtime.runs.reconcile(claim, execution.executionId, {
                outcome: observed.outcome, quiescent: authenticated,
                evidence: authenticated ? "authenticated Linux verifier retirement" : "linux verifier retirement not authenticated",
                ...(authenticated ? { verification: observed.result } : {}),
              })
            }
          } catch { /* No trusted domain proof: preserve the unresolved claim. */ }
        }
        continue
      }
      if (execution.kind === "host" && execution.engine !== runtime.host.identity.engine) {
        assertWorkflowUnchanged(expectedWorkflow, sessionID)
        runtime.runs.fence(claim, execution.executionId, HOST_ENGINE_MISMATCH)
        runtime.runs.reconcile(claim, execution.executionId, {
          outcome: "unknown", quiescent: false, evidence: HOST_ENGINE_MISMATCH,
        })
        continue
      }
      let result: ExecutionReconciliation = {
        outcome: "unknown", quiescent: false,
        evidence: "host recovery proof unavailable (absent, malformed, uncorroborated, or timed out)",
      }
      const ref = execution.kind === "host" ? persistedHostReference(execution) : undefined
      if (ref) {
        try {
          const pending = runtime.host.reconcile(ref)
          const observed = await Promise.race([pending, new Promise<null>(r => setTimeout(() => r(null), 1000))])
          if (observed) result = observed
        } catch { /* Unknown is never quiescent. */ }
      }
      assertWorkflowUnchanged(expectedWorkflow, sessionID)
      runtime.runs.reconcile(claim, execution.executionId, result)
    }
    assertWorkflowUnchanged(expectedWorkflow, sessionID)
    runtime.runs.assertQuiescent(claim)
    runtime.runs.release(claim)
  }

  async function runInternal(sessionID: string, signal: AbortSignal | undefined, resumed: boolean): Promise<{ run: QueueRun; workflow: Workflow }> {
    runtime.linuxAdmission?.assertBootEpoch()
    const wf = workflow(sessionID, "executing")
    if (wf.pendingCancel) {
      settlePendingCancellation(sessionID, wf.id)
      throw new Error("workflow cancellation is pending")
    }
    if (!wf.planRef || wf.approval?.planSha !== wf.planRef.jsonSha || !savedPlan(runtime, wf)) throw new Error("approved plan or rendered file changed")
    const preflight = await runtime.host.preflight(runtime.host.identity.profile)
    assertWorkflowUnchanged(wf, sessionID)
    assertHostAdmission(preflight)
    const ledger = readLedger(root, sessionID)
    if (ledger.tasks.some(t => OPEN_STATUSES.has(t.status) && (t.wf?.id !== wf.id || t.wf.planSha !== wf.planRef!.jsonSha))) {
      throw new Error("unrelated open tasks cannot run in a foreground workflow")
    }
    if (queue.isRunning(sessionID)) throw new Error("queue is already running")
    await reconcile(sessionID, wf)
    assertWorkflowUnchanged(wf, sessionID)
    const authority = resolveAuthority(runtime, "approve", sessionID, runtime.host.identity.engine)
    const current = authority.wf
    if (current) assertWorkflowEngine(current)
    if (authority.refuse || !current || current.id !== wf.id) throw new Error(authority.refuse ?? "workflow changed during reconciliation")
    assertWorkflowUnchanged(current, sessionID)
    if (current.pendingCancel) {
      settlePendingCancellation(sessionID, wf.id)
      throw new Error("workflow cancellation is pending")
    }
    if (current.phase !== "executing" || current.approval?.planSha !== current.planRef?.jsonSha || !savedPlan(runtime, current)) {
      throw new Error("approved plan changed during reconciliation")
    }
    if (signal?.aborted) throw new Error("run cancelled before dispatch")
    const abort = () => {
      try {
        const result = cancel(sessionID)
        if (!result.ok) runtime.log("foreground cancellation refused", { sessionID, error: result.text })
      }
      catch (error) { runtime.log("foreground cancellation failed", { error: String(error) }) }
    }
    signal?.addEventListener("abort", abort, { once: true })
    try {
      const result = await queue.run(sessionID, resumed ? { resumed: true } : undefined)
      assertWorkflowRecordUnchanged(wf, sessionID)
      if (result.refused) throw new LinuxAdmissionRefused(result.refused.phase, result.refused.reasons)
      if (runtime.runs.status().executions.some(e => !settled(e))) throw new Error("execution unresolved; fence retained")
      const current = readWorkflow(root)
      if (!current || current.id !== wf.id || current.sessionID !== sessionID) throw new Error("workflow changed during foreground run")
      assertWorkflowEngine(current)
      if (current.pendingCancel) {
        settlePendingCancellation(sessionID, wf.id)
      } else if (current.phase === "executing") {
        assertWorkflowEngine(current)
        const settled = settle(runtime, current, queue.isRunning(sessionID))
        if (settled && !settled.ok) throw new Error(settled.text)
      }
      const finished = readWorkflow(root)
      if (!finished || finished.id !== wf.id || finished.sessionID !== sessionID) throw new Error("workflow changed during foreground run")
      assertWorkflowEngine(finished)
      return { run: result, workflow: finished }
    } finally {
      signal?.removeEventListener("abort", abort)
    }
  }

  function run(sessionID: string, signal?: AbortSignal) {
    return runInternal(sessionID, signal, false)
  }

  async function resume(sessionID: string, signal?: AbortSignal) {
    runtime.linuxAdmission?.assertBootEpoch()
    const wf = activeWorkflowForHost()
    if (!wf) throw new Error("no active workflow to resume")
    if (wf.sessionID !== sessionID) throw new Error("no workflow owned by this session")
    workflow(sessionID, "executing")
    return runInternal(sessionID, signal, true)
  }

  function status(sessionID: string, json = false) {
    return readForegroundStatus(runtime, sessionID, json, queue.isRunning(sessionID))
  }

  function cancel(sessionID: string): FlowResult {
    const wf = activeWorkflowForHost()
    if (!wf || wf.sessionID !== sessionID) throw new Error("no workflow owned by this session")
    runtime.linuxAdmission?.assertBootEpoch()
    const status = runtime.runs.status()
    const running = queue.isRunning(sessionID)
    const active = running || !!status.claim ||
      (reviewActivity?.sessionID === sessionID && reviewActivity.workflowID === wf.id) ||
      status.executions.some(execution => execution.ownerSession === sessionID && !settled(execution)) ||
      // `reviewing` is persisted before the reviewer registers its first execution claim.
      (wf.phase === "reviewing" && pidAlive(wf.owner.pid))
    const current = activeWorkflowForHost()
    if (!current || current.id !== wf.id || current.sessionID !== sessionID) throw new Error("workflow changed during foreground operation")
    const result = cancelWorkflow(runtime, current, active, () => {
      if (running) {
        void queue.abort(sessionID, "workflow cancelled").catch(() => {
          runtime.log("foreground queue cancellation failed", { sessionID })
        })
      }
    })
    if (result.ok && reviewActivity?.sessionID === sessionID && reviewActivity.workflowID === current.id) reviewActivity.abort.abort()
    return result
  }

  return { validateImportedPlan, importPlan, decide, run, resume, status, cancel }
}

/** CLI status can call this with a FlowRuntime only: no host, SDK, policy, credential, claim or model construction. */
export function readForegroundStatus(runtime: FlowRuntime, sessionID: string, json = false, queueRunning = false) {
  return json ? statusJson(runtime, sessionID, queueRunning) : renderStatus(runtime, sessionID, queueRunning)
}
