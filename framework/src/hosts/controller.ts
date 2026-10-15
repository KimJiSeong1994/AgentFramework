import { mkdirSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { importedPlan, reviewSubmittedPlan, savedPlan, submitAdmittedImportedPlan, submitImportedPlan, type PlanSubmission } from "../flow/actions.ts"
import { canonicalPlanSha, planToTasks } from "../flow/plan.ts"
import { isAttachmentEpoch, pidAlive } from "../flow/owner.ts"
import { resumePaused, type ResumeView } from "../flow/resume.ts"
import { applyEvent, approveWorkflow, observeStopSettlement, requestStop, resolveAuthority, settleOwned, startWorkflow, type AnyFlowResult, type FlowResult } from "../flow/runtime.ts"
import { flowOn, renderStatus, statusJson } from "../flow/status.ts"
import { activeAnyWorkflow, activeWorkflow, readAnyWorkflowChecked, readWorkflow, workflowEngineRefusal, type Workflow } from "../flow/state.ts"
import { sessionActivityBlocker } from "./runtime.ts"
import { getQueue, type QueueRun } from "../orchestration/queue.ts"
import { readLedger, OPEN_STATUSES } from "../state/ledger.ts"
import { sessionDir, stateRoot } from "../state/store.ts"
import { admissionEpoch, admissionFence, effectiveHold, isAdmissionCurrent } from "../sessions/admission.ts"
import { getOwnedSession, inspectSessionAttachment, readSessionMetadata } from "../sessions/store.ts"
import { EXECUTION_ROLES, LinuxAdmissionRefused, type ExecutionHandle, type ExecutionReconciliation, type ExecutionRole, type ExecutionRuntime, type FlowRuntime } from "./types.ts"
import { persistedHostReference, settled } from "./run-state.ts"
import type { VerificationReference } from "../orchestration/verifier.ts"
import { authenticateLinuxVerification } from "./linux-domain.ts"
import { consumeOperatorDecision, type OperatorDecision } from "./operator.ts"
import { assertHostAdmission } from "./required-controls.ts"
import { isCancelPending, isStopPending, TERMINAL, type WorkflowEnvelope } from "../workflows/types.ts"
import { assertUnitCurrent, isUnitKind, planSubject, sameSubject, unitFor, unitTag, type ApprovedExecutionUnit } from "../workflows/execution-unit.ts"
import { kindAllowsRole, narrowPlan } from "../workflows/registry.ts"

const HOST_ENGINE_MISMATCH = "host engine identity mismatch; recovery refused"
const HOST_POLICY_MISMATCH = "host policy identity evidence is absent or mismatched; recovery refused"
const COMMON_ENGINES = new Set(["local", "codex", "claude"])

export type ForegroundController = ReturnType<typeof createForegroundController>

/** No SDK/client is synthesized here. The caller supplies a complete, single-host ExecutionRuntime. */
export function createForegroundController(runtime: ExecutionRuntime) {
  const queue = getQueue(runtime)
  const root = realpathSync(runtime.worktree)
  if (root !== runtime.worktree || runtime.stateRoot !== stateRoot(root)) throw new Error("runtime worktree/state root must be canonical")
  if (runtime.directory !== root) throw new Error("foreground commands must run from the source worktree root")

  function assertWorkflowEngine(wf: WorkflowEnvelope): void {
    const refusal = workflowEngineRefusal(wf, runtime.host.identity.engine)
    if (refusal) throw new Error(refusal)
  }

  function activeWorkflowForHost(): Workflow | null {
    const wf = activeWorkflow(root)
    if (wf) assertWorkflowEngine(wf)
    return wf
  }

  function assertAdmission(sessionID: string, expectedEpoch?: string): string {
    const persisted = readAnyWorkflowChecked(root).wf
    if (persisted?.sessionID === sessionID) assertWorkflowEngine(persisted)
    const epoch = admissionEpoch(root, sessionID)
    if (!epoch || effectiveHold(root, sessionID) || !isAdmissionCurrent(root, sessionID, epoch)) {
      throw new Error("session remains held; explicit owner Resume is required")
    }
    if (expectedEpoch !== undefined && epoch !== expectedEpoch) throw new Error("session attachment epoch changed")
    const store = getOwnedSession(root, sessionID)
    const metadata = readSessionMetadata(root, sessionID)
    if (!store || store.epoch !== epoch || store.sessionID !== sessionID || store.metadata.held ||
        !metadata || metadata.held || metadata.engine !== runtime.host.identity.engine) {
      throw new Error("session attachment is missing, held, or belongs to another engine")
    }
    return epoch
  }

  /** Any-kind active workflow: the approved-unit kinds (ultragoal/autoresearch) occupy the same slot as a plan. */
  function activeAnyForHost(): WorkflowEnvelope | null {
    const wf = activeAnyWorkflow(root)
    if (wf) assertWorkflowEngine(wf)
    return wf
  }

  /** The active workflow when it is a plan or an approved-unit kind; planning-only kinds stop through their own host. */
  function activeUnitHostWorkflow(): WorkflowEnvelope | null {
    const wf = activeAnyForHost()
    return wf && (wf.kind === "plan" || isUnitKind(wf.kind)) ? wf : null
  }

  function assertWorkflowOwner(wf: WorkflowEnvelope, sessionID: string, allowHeld = false): string {
    const store = getOwnedSession(root, sessionID)
    const metadata = readSessionMetadata(root, sessionID)
    if (!store || store.sessionID !== sessionID || !metadata || metadata.engine !== runtime.host.identity.engine ||
        metadata.held !== store.metadata.held) {
      throw new Error("session attachment is missing or its engine identity does not match")
    }
    store.assertOwner()
    if (wf.owner.instance !== store.epoch || wf.owner.pid !== process.pid) {
      if (pidAlive(wf.owner.pid)) throw new Error("a live foreign workflow owner must finish first")
      throw new Error("workflow owner is not bound to this attachment epoch")
    }
    if (!allowHeld) assertAdmission(sessionID, store.epoch)
    return store.epoch
  }

  function assertWorkflowUnchanged<T extends WorkflowEnvelope>(expected: T | null, sessionID: string, expectedEpoch: string): T | null {
    assertAdmission(sessionID, expectedEpoch)
    const current = (expected !== null && expected.kind !== "plan" ? activeAnyForHost() : activeWorkflowForHost()) as T | null
    if (current?.id !== expected?.id) throw new Error("workflow changed during foreground operation")
    if (current && current.sessionID !== sessionID) throw new Error("another session owns the workflow")
    if (current) {
      if (expected && current.lastSeq !== expected.lastSeq) throw new Error("workflow revision changed during foreground operation")
      assertWorkflowOwner(current, sessionID)
    }
    return current
  }

  function assertWorkflowRecordUnchanged<T extends WorkflowEnvelope>(expected: T, sessionID: string, expectedEpoch: string): T {
    const current = (expected.kind !== "plan" ? readAnyWorkflowChecked(root).wf : readWorkflow(root)) as T | null
    if (!current || current.id !== expected.id) throw new Error("workflow changed during foreground operation")
    assertWorkflowEngine(current)
    if (current.sessionID !== sessionID) throw new Error("another session owns the workflow")
    if (current.stopIntent !== null) {
      // a recorded stop (pending, or a settled pause) holds admission by design; ownership is still proven
      if (assertWorkflowOwner(current, sessionID, true) !== expectedEpoch) throw new Error("session attachment epoch changed")
    } else {
      assertAdmission(sessionID, expectedEpoch)
      assertWorkflowOwner(current, sessionID)
    }
    return current
  }

  function stopOwnerIsCurrent(sessionID: string, workflowID: string, expectedEpoch: string): boolean {
    try {
      const store = getOwnedSession(root, sessionID)
      const current = readAnyWorkflowChecked(root).wf
      return !!store && store.epoch === expectedEpoch && store.sessionID === sessionID &&
        current?.id === workflowID && current.sessionID === sessionID && current.owner.instance === expectedEpoch &&
        current.owner.pid === process.pid && isStopPending(current)
    } catch { return false }
  }

  function assertCancellationOwner(wf: WorkflowEnvelope, sessionID: string): void {
    if (!isAttachmentEpoch(wf.owner.instance)) throw new Error("workflow owner has no verifiable attachment epoch")
    const owned = getOwnedSession(root, sessionID)
    if (owned) {
      const metadata = readSessionMetadata(root, sessionID)
      if (owned.epoch !== wf.owner.instance || wf.owner.pid !== process.pid || !metadata ||
          metadata.engine !== runtime.host.identity.engine || metadata.held !== owned.metadata.held) {
        throw new Error("cancellation owner does not match the attached session epoch")
      }
      owned.assertOwner()
      return
    }
    const metadata = readSessionMetadata(root, sessionID)
    const attachment = inspectSessionAttachment(root, sessionID, wf.owner.instance)
    if (!metadata || metadata.engine !== runtime.host.identity.engine || !attachment || attachment.state !== "attached" ||
        attachment.identity !== "live" || attachment.pid !== wf.owner.pid) {
      throw new Error("live owner attachment proof is unavailable; cancellation refused")
    }
  }

  function wid(): string { return readAnyWorkflowChecked(root).wf?.id ?? "" }

  async function withAdmissionBoundDispatch<T>(sessionID: string, epoch: string, operation: () => Promise<T>): Promise<T> {
    const host = runtime.host
    const originalPreflight = host.preflight
    const originalPrepare = host.prepare
    const preflight = async (profile: string) => {
      assertAdmission(sessionID, epoch)
      const result = await originalPreflight.call(host, profile)
      assertAdmission(sessionID, epoch)
      return result
    }
    const prepare = async (request: Parameters<typeof originalPrepare>[0]): Promise<ExecutionHandle> => {
      assertAdmission(sessionID, epoch)
      const handle = await originalPrepare.call(host, request)
      assertAdmission(sessionID, epoch)
      return {
        reference: handle.reference,
        async run() {
          assertAdmission(sessionID, epoch)
          const result = await handle.run()
          // A stop recorded while the model ran closes admission by design; the finished execution is still this
          // owner's and must reach terminal+quiescent reconciliation, so its late result is diagnostic, not a throw.
          if (!stopOwnerIsCurrent(sessionID, wid(), epoch)) assertAdmission(sessionID, epoch)
          return result
        },
        requestCancel: (reason, deadlineAt) => handle.requestCancel(reason, deadlineAt),
        reconcile: () => handle.reconcile(),
      }
    }
    host.preflight = preflight
    host.prepare = prepare
    try {
      assertAdmission(sessionID, epoch)
      return await operation()
    } finally {
      if (host.preflight === preflight) host.preflight = originalPreflight
      if (host.prepare === prepare) host.prepare = originalPrepare
    }
  }

  function workflow(sessionID: string, phase?: Workflow["phase"]): Workflow
  function workflow(sessionID: string, phase: Workflow["phase"] | undefined, any: true): WorkflowEnvelope
  function workflow(sessionID: string, phase?: Workflow["phase"], any = false): WorkflowEnvelope {
    const wf = any ? activeAnyForHost() : activeWorkflowForHost()
    if (!wf || wf.sessionID !== sessionID) throw new Error("no workflow owned by this session")
    if (phase && wf.phase !== phase) throw new Error(`workflow is ${wf.phase}, expected ${phase}`)
    assertWorkflowOwner(wf, sessionID)
    return wf
  }

  /** The only way the controller turns a workflow into runnable work: an unit whose approval names the current subject. */
  function approvedUnit(wf: WorkflowEnvelope): ApprovedExecutionUnit {
    const unit = unitFor(wf, { worktree: root, tasks: readLedger(root, wf.sessionID).tasks })
    if (wf.kind === "plan" && !savedPlan(runtime, narrowPlan(wf))) throw new Error("approved plan or rendered file changed")
    return unit
  }

  /** The kind registry owns role scheduling: a host execution under a role the kind may not schedule is refused. */
  function assertKindRoles(wf: WorkflowEnvelope, sessionID: string): void {
    for (const execution of runtime.runs.status().executions) {
      if (execution.ownerSession === sessionID && execution.kind === "host" && !kindAllowsRole(wf.kind, execution.role)) {
        throw new Error(`role ${execution.role} is not schedulable by ${wf.kind} workflows; recovery refused`)
      }
    }
  }

  function recoveryIdentity(
    sessionID: string,
    workflowID: string | undefined,
    planSha: string | undefined,
    allowLocalActivity: boolean,
    allowHeldAttachment: boolean,
    anyUnitKind: boolean,
  ): WorkflowEnvelope {
    const wf = anyUnitKind ? activeUnitHostWorkflow() : activeWorkflowForHost()
    if (!wf || wf.sessionID !== sessionID) throw new Error("no workflow owned by this session")
    if ((workflowID !== undefined && wf.id !== workflowID) ||
      (planSha !== undefined && (wf.kind !== "plan" || wf.planRef?.jsonSha !== planSha))) {
      throw new Error("decision workflow ID or subject hash does not match")
    }
    if (!allowLocalActivity) assertWorkflowOwner(wf, sessionID, allowHeldAttachment)
    if (planSha !== undefined && wf.kind === "plan" && !savedPlan(runtime, wf)) throw new Error("canonical plan or rendered file changed; approval refused")
    if (wf.phase === "executing") approvedUnit(wf)
    assertKindRoles(wf, sessionID)
    // OpenCode and synthetic controller hosts retain their established recovery/error ordering.
    // The explicit common CLI runtimes need their model-bound intent evidence before recovery.
    if (!COMMON_ENGINES.has(runtime.host.identity.engine)) return wf
    const status = runtime.runs.status()
    const hostExecutions = status.executions.filter(execution => execution.ownerSession === sessionID && execution.kind === "host")
    if (hostExecutions.length === 0) throw new Error(HOST_POLICY_MISMATCH)
    for (const execution of hostExecutions) {
      if (execution.engine !== runtime.host.identity.engine) throw new Error(HOST_ENGINE_MISMATCH)
      const role = EXECUTION_ROLES.find(candidate => candidate === execution.role) as ExecutionRole | undefined
      if (!role || !execution.policyID || execution.policyID !== runtime.policy.resolve(role).id) {
        throw new Error(HOST_POLICY_MISMATCH)
      }
    }
    const localActivity = allowLocalActivity && (queue.isRunning(sessionID) || !!sessionActivityBlocker(root, sessionID))
    if (allowLocalActivity) {
      const unsettledOwnerExecution = status.executions.some(execution =>
        execution.ownerSession === sessionID && !settled(execution))
      const liveClaimOwner = status.claim?.ownerSession === sessionID && pidAlive(status.claim.pid)
      const liveOwner = pidAlive(wf.owner.pid) || liveClaimOwner
      // Cancellation is a durable request, not authority to take another process's lease or signal it.
      // Keep it available while the owner is alive, but do not turn a dead owner's unknown execution
      // into a cancellation that could later be mistaken for safe retirement.
      if (unsettledOwnerExecution && !localActivity && !liveOwner) {
        throw new Error("execution unresolved; recovery refused without changing durable state")
      }
      return wf
    }
    if (status.claim) throw new Error("execution run is owned by another operation")
    if (status.executions.some(execution => !settled(execution))) {
      throw new Error("execution unresolved; recovery refused without changing durable state")
    }
    return wf
  }

  function assertRecoveryIdentity(sessionID: string, workflowID?: string, planSha?: string, allowLocalActivity = false, allowHeldAttachment = false): Workflow {
    return recoveryIdentity(sessionID, workflowID, planSha, allowLocalActivity, allowHeldAttachment, false) as Workflow
  }

  /** Every foreground settle point is the one owner-aware routine; it settles only a recorded stop, never advances. */
  function settleStop(sessionID: string, workflowID: string): void {
    runtime.linuxAdmission?.assertBootEpoch()
    const current = readAnyWorkflowChecked(root).wf
    if (!current || current.id !== workflowID || current.sessionID !== sessionID || !isStopPending(current)) return
    assertWorkflowEngine(current)
    const result = observeStopSettlement(runtime, sessionID, current.owner.instance, "controller")
    if (result.kind === "refused") runtime.log("foreground stop settlement refused", { reason: result.reason })
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
    if (existing && existing.sessionID !== sessionID) throw new Error(`another session owns the workflow: ${existing.sessionID}; use /resume ${existing.sessionID}`)
    const epoch = assertAdmission(sessionID)
    if (existing && existing.phase !== "planning") throw new Error(`workflow is ${existing.phase}, not awaiting a plan`)
    if (existing) {
      workflow(sessionID, "planning")
      assertWorkflowUnchanged(existing, sessionID, epoch)
    }
    const plan = validateImportedPlan(parsed === undefined ? sourceJson(sourcePath) : parsed, sessionID)
    // A valid source and host must be established before creating any workflow or model execution.
    const preflight = await runtime.host.preflight(runtime.host.identity.profile)
    assertWorkflowUnchanged(existing, sessionID, epoch)
    assertHostAdmission(preflight, runtime.host.identity.controlProfile)
    await reconcile(sessionID, existing, epoch)
    assertWorkflowUnchanged(existing, sessionID, epoch)
    const admission = await runtime.linuxAdmission?.admitPlanSubmission(sessionID)
    assertWorkflowUnchanged(existing, sessionID, epoch)
    mkdirSync(sessionDir(root, sessionID), { recursive: true })
    assertWorkflowUnchanged(existing, sessionID, epoch)
    const authority = existing ? resolveAuthority(runtime, "approve", sessionID, runtime.host.identity.engine) : null
    if (authority?.wf) assertWorkflowEngine(authority.wf)
    if (authority?.refuse || (existing && authority?.wf?.id !== existing.id)) throw new Error(authority?.refuse ?? "workflow changed during reconciliation")
    const started = authority?.wf ? { ok: true as const, wf: authority.wf } : startWorkflow(runtime, sessionID, "command", plan.goal, "user_command", runtime.host.identity.engine)
    if (!started.ok) throw new Error(started.text)
    assertWorkflowEngine(started.wf)
    assertWorkflowUnchanged(started.wf, sessionID, epoch)
    const review = new AbortController()
    const abort = () => review.abort()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) review.abort()
    try {
      assertAdmission(sessionID, epoch)
      const submitted = await withAdmissionBoundDispatch(sessionID, epoch, () => admission
        ? submitAdmittedImportedPlan(runtime, started.wf, plan, admission, review.signal)
        : submitImportedPlan(runtime, started.wf, plan, review.signal))
      assertWorkflowRecordUnchanged(started.wf, sessionID, epoch)
      return submitted
    }
    finally {
      signal?.removeEventListener("abort", abort)
      if (isAdmissionCurrent(root, sessionID, epoch) || stopOwnerIsCurrent(sessionID, started.wf.id, epoch)) {
        settleStop(sessionID, started.wf.id)
      }
    }
  }

  function decide(receipt: OperatorDecision, expectedSessionID?: string): FlowResult {
    // Consume first: a receipt is spent even when a later check refuses it.
    const decision = consumeOperatorDecision(receipt)
    runtime.linuxAdmission?.assertBootEpoch()
    const persisted = readWorkflow(root)
    if (persisted) assertWorkflowEngine(persisted)
    if (!persisted) throw new Error("decision workflow ID or subject hash does not match")
    const sessionID = expectedSessionID ?? persisted.sessionID
    // Every refusal below happens before any effect: no index, ledger or event write has occurred yet.
    if (decision.sessionID !== sessionID || persisted.sessionID !== sessionID) throw new Error("decision receipt belongs to another session")
    if (TERMINAL.has(persisted.phase)) throw new Error(`workflow is ${persisted.phase}; decision refused`)
    if (decision.subject.kind !== "plan") throw new Error("decision subject kind does not match a plan workflow")
    if (persisted.id !== decision.workflowID || decision.subject.id !== persisted.id || !sameSubject(decision.subject, planSubject(persisted))) {
      throw new Error("decision workflow ID or subject hash does not match")
    }
    if (decision.expectedRevision !== persisted.lastSeq) throw new Error("workflow revision changed since the decision was issued; decision refused")
    const wf = assertRecoveryIdentity(sessionID, decision.workflowID, decision.subject.sha256)
    const epoch = assertAdmission(sessionID)
    workflow(wf.sessionID)
    const authority = resolveAuthority(runtime, decision.action, wf.sessionID, runtime.host.identity.engine)
    if (authority.wf) assertWorkflowEngine(authority.wf)
    if (authority.refuse || !authority.wf) throw new Error(authority.refuse ?? "no active workflow")
    if (authority.wf.id !== decision.workflowID || !sameSubject(decision.subject, planSubject(authority.wf))) {
      throw new Error("decision workflow ID or subject hash does not match")
    }
    if (authority.wf.lastSeq !== decision.expectedRevision) throw new Error("workflow revision changed since the decision was issued; decision refused")
    if (!savedPlan(runtime, authority.wf)) throw new Error("canonical plan or rendered file changed; approval refused")
    if (decision.action === "reject") {
      if (typeof decision.reason !== "string" || !decision.reason.trim()) throw new Error("rejection needs a local reason")
      const current = assertWorkflowUnchanged(authority.wf, wf.sessionID, epoch)
      if (!current || !sameSubject(decision.subject, planSubject(current))) throw new Error("decision workflow ID or subject hash does not match")
      return applyEvent(runtime, current, "reject", "user_command", {}, w => w, { reason: decision.reason.trim() })
    }
    const plan = savedPlan(runtime, authority.wf)!
    const queueRunning = queue.isRunning(wf.sessionID)
    const current = assertWorkflowUnchanged(authority.wf, wf.sessionID, epoch)
    if (!current || !sameSubject(decision.subject, planSubject(current))) throw new Error("decision workflow ID or subject hash does not match")
    return approveWorkflow(runtime, current, planToTasks(plan), {
      queueRunning, planShaOk: canonicalPlanSha(plan) === decision.subject.sha256,
      mdShaOk: true, subject: decision.subject, receiptRevision: decision.expectedRevision,
    })
  }

  async function reconcile(sessionID: string, expectedWorkflow: WorkflowEnvelope | null, expectedEpoch = assertAdmission(sessionID)): Promise<void> {
    assertWorkflowUnchanged(expectedWorkflow, sessionID, expectedEpoch)
    runtime.linuxAdmission?.assertBootEpoch()
    if (queue.isRunning(sessionID) || runtime.runs.status().claim) {
      throw new Error("execution run is owned by another operation")
    }
    const claim = runtime.runs.claim(sessionID, runtime.instance, process.pid)
    for (const execution of runtime.runs.status().executions) {
      assertWorkflowUnchanged(expectedWorkflow, sessionID, expectedEpoch)
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
            assertWorkflowUnchanged(expectedWorkflow, sessionID, expectedEpoch)
            if (observed) {
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
        assertWorkflowUnchanged(expectedWorkflow, sessionID, expectedEpoch)
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
          assertWorkflowUnchanged(expectedWorkflow, sessionID, expectedEpoch)
          if (observed) result = observed
        } catch { /* Unknown is never quiescent. */ }
      }
      assertWorkflowUnchanged(expectedWorkflow, sessionID, expectedEpoch)
      runtime.runs.reconcile(claim, execution.executionId, result)
    }
    assertWorkflowUnchanged(expectedWorkflow, sessionID, expectedEpoch)
    runtime.runs.assertQuiescent(claim)
    runtime.runs.release(claim)
  }

  /**
   * Run the residual of an approved unit through the existing queue. Plan units settle through `settleOwned`; ultragoal
   * and autoresearch units hand control back to their driver (verify / evaluate) and never settle here. The queue only
   * ever sees tasks tagged {parent id, subject sha}; this never starts a workflow.
   */
  async function runInternal(sessionID: string, signal: AbortSignal | undefined, resumed: boolean): Promise<{ run: QueueRun; workflow: WorkflowEnvelope }> {
    runtime.linuxAdmission?.assertBootEpoch()
    const wf = workflow(sessionID, "executing", true)
    const epoch = assertAdmission(sessionID, wf.owner.instance)
    if (isStopPending(wf)) {
      settleStop(sessionID, wf.id)
      throw new Error(isCancelPending(wf) ? "workflow cancellation is pending" : "workflow pause is pending")
    }
    if (wf.kind !== "plan" && !isUnitKind(wf.kind)) throw new Error(`${wf.kind} workflows have no execution unit`)
    const unit = approvedUnit(wf)
    assertKindRoles(wf, sessionID)
    for (const role of ["worker", "reviewer"] as const) {
      if (!kindAllowsRole(wf.kind, role)) throw new Error(`role ${role} is not schedulable by ${wf.kind} workflows`)
    }
    const preflight = await runtime.host.preflight(runtime.host.identity.profile)
    assertWorkflowUnchanged(wf, sessionID, epoch)
    assertHostAdmission(preflight, runtime.host.identity.controlProfile)
    const ledger = readLedger(root, sessionID)
    const tag = unitTag(unit)
    if (ledger.tasks.some(t => OPEN_STATUSES.has(t.status) && (t.wf?.id !== tag.id || t.wf.planSha !== tag.planSha))) {
      throw new Error("unrelated open tasks cannot run in a foreground workflow")
    }
    if (queue.isRunning(sessionID)) throw new Error("queue is already running")
    await reconcile(sessionID, wf, epoch)
    assertWorkflowUnchanged(wf, sessionID, epoch)
    let current: WorkflowEnvelope
    if (wf.kind === "plan") {
      const authority = resolveAuthority(runtime, "approve", sessionID, runtime.host.identity.engine)
      if (authority.wf) assertWorkflowEngine(authority.wf)
      if (authority.refuse || !authority.wf || authority.wf.id !== wf.id) throw new Error(authority.refuse ?? "workflow changed during reconciliation")
      current = authority.wf
    } else {
      // Non-plan owner authority: the committed unit workflow must still be this session's, owned by this epoch.
      const fresh = activeAnyForHost()
      if (!fresh || fresh.id !== wf.id || fresh.sessionID !== sessionID) throw new Error("workflow changed during reconciliation")
      current = fresh
    }
    assertWorkflowUnchanged(current, sessionID, epoch)
    if (isStopPending(current)) {
      settleStop(sessionID, wf.id)
      throw new Error(isCancelPending(current) ? "workflow cancellation is pending" : "workflow pause is pending")
    }
    try { assertUnitCurrent(unit, current) }
    catch { throw new Error("approved plan changed during reconciliation") }
    approvedUnit(current)
    if (signal?.aborted) throw new Error("run cancelled before dispatch")
    assertAdmission(sessionID, epoch)
    const abort = () => {
      try {
        const result = cancel(sessionID)
        if (!result.ok) runtime.log("foreground cancellation refused", { sessionID, error: result.text })
      }
      catch (error) { runtime.log("foreground cancellation failed", { error: String(error) }) }
    }
    signal?.addEventListener("abort", abort, { once: true })
    try {
      const result = await withAdmissionBoundDispatch(sessionID, epoch, () => queue.run(sessionID, resumed ? { resumed: true } : undefined))
      assertWorkflowRecordUnchanged(wf, sessionID, epoch)
      if (result.refused) throw new LinuxAdmissionRefused(result.refused.phase, result.refused.reasons)
      if (runtime.runs.status().executions.some(e => !settled(e))) throw new Error("execution unresolved; fence retained")
      const current = readAnyWorkflowChecked(root).wf
      if (!current || current.id !== wf.id || current.sessionID !== sessionID) throw new Error("workflow changed during foreground run")
      assertWorkflowEngine(current)
      if (isStopPending(current)) {
        settleStop(sessionID, wf.id)
      } else if (current.kind === "plan" && current.phase === "executing") {
        assertWorkflowEngine(current)
        assertWorkflowOwner(current, sessionID)
        const settled = settleOwned(runtime, { sessionID, workflowID: wf.id, epoch }, "controller")
        if (settled.kind === "settled" && !settled.result.ok) throw new Error(settled.result.text)
      }
      const finished = readAnyWorkflowChecked(root).wf
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

  /** Run an already-inserted approved unit (ultragoal/autoresearch) through the queue; the driver verifies afterwards. */
  function runApprovedUnit(sessionID: string, signal?: AbortSignal, resumed = false) {
    return runInternal(sessionID, signal, resumed)
  }

  /** The human decision for a paused workflow: shown the residual view, answers Keep (false) or Resume (true). */
  type ResumeChoice = (view: ResumeView) => Promise<boolean>

  async function resumePausedWorkflow(sessionID: string, wf: WorkflowEnvelope, choose: ResumeChoice, signal?: AbortSignal) {
    assertWorkflowEngine(wf)
    if (wf.sessionID !== sessionID) throw new Error("no workflow owned by this session")
    if (isCancelPending(wf)) throw new Error("workflow cancellation is pending")
    const store = getOwnedSession(root, sessionID)
    if (!store) throw new Error("session attachment is not owned by this process")
    // Role scheduling is checked before the resume commit, so a refusal never leaves a resumed workflow behind.
    // Autoresearch never schedules queue workers: its runner is the experiment runner, not runInternal.
    if (wf.kind === "ultragoal" && wf.pausedFrom?.phase === "executing") {
      assertKindRoles(wf, sessionID)
      for (const role of ["worker", "reviewer"] as const) {
        if (!kindAllowsRole(wf.kind, role)) throw new Error(`role ${role} is not schedulable by ${wf.kind} workflows`)
      }
    }
    const outcome = await resumePaused(runtime, sessionID, wf.lastSeq, {
      async preflight() {
        runtime.linuxAdmission?.assertBootEpoch()
        const preflight = await runtime.host.preflight(runtime.host.identity.profile)
        assertHostAdmission(preflight, runtime.host.identity.controlProfile)
      },
      fence: () => admissionFence(root, sessionID),
      choose,
    })
    if (outcome.kind === "refused") throw new Error(`resume refused (${outcome.precondition}): ${outcome.reason}`)
    if (outcome.kind === "kept") return { kept: true as const, view: outcome.view, workflow: readWorkflow(root) ?? wf }
    // Dispatch by the phase the pause was taken in. Only the residual of an approved execution runs tasks.
    const resumed = outcome.wf
    // Planning kinds resume at their stage with no dispatch here; their driver (P6a S2/S3) runs the next turn.
    // Unit kinds resumed into execution run only their residual tagged tasks; every other non-plan stage waits for its driver.
    if (resumed.kind !== "plan") {
      const after = readAnyWorkflowChecked(root).wf ?? resumed
      // Autoresearch resumes into its experiment_run stage and returns to its driver: no queue run, no worker prepare.
      if (resumed.kind === "ultragoal" && resumed.phase === "executing") {
        const result = await runInternal(sessionID, signal, true)
        return { kept: false as const, view: outcome.view, workflow: result.workflow, run: result.run }
      }
      return { kept: false as const, view: outcome.view, workflow: after }
    }
    if (resumed.phase === "executing") {
      const result = await runInternal(sessionID, signal, true)
      return { kept: false as const, view: outcome.view, workflow: result.workflow, run: result.run }
    }
    if (resumed.phase === "reviewing") {
      const plan = savedPlan(runtime, resumed)
      if (!plan) throw new Error("approved plan or rendered file changed; review not restarted")
      const epoch = assertAdmission(sessionID, resumed.owner.instance)
      const review = new AbortController()
      const abort = () => review.abort()
      signal?.addEventListener("abort", abort, { once: true })
      try {
        await withAdmissionBoundDispatch(sessionID, epoch, () => reviewSubmittedPlan(runtime, resumed, plan, review.signal))
      } finally {
        signal?.removeEventListener("abort", abort)
        settleStop(sessionID, resumed.id)
      }
    }
    // planning: admitted at its stage with no turn; pending_approval: the decision prompt needs a new receipt (revision changed)
    return { kept: false as const, view: outcome.view, workflow: readWorkflow(root) ?? resumed }
  }

  /** Resume of a settled pause: shows the residual, needs the human choice, rechecks, then dispatches by `pausedFrom`. */
  async function resumePausedBy(sessionID: string, choose: ResumeChoice, signal?: AbortSignal) {
    runtime.linuxAdmission?.assertBootEpoch()
    const persisted = activeUnitHostWorkflow()
    if (!persisted || persisted.sessionID !== sessionID) throw new Error("no workflow owned by this session")
    if (isCancelPending(persisted)) throw new Error("workflow cancellation is pending")
    if (persisted.phase !== "paused") {
      throw new Error(persisted.stopIntent ? "workflow pause is pending; termination is unconfirmed" : `workflow is ${persisted.phase}, not paused`)
    }
    return resumePausedWorkflow(sessionID, persisted, choose, signal)
  }

  async function resume(sessionID: string, signal?: AbortSignal) {
    runtime.linuxAdmission?.assertBootEpoch()
    const persisted = activeUnitHostWorkflow()
    if (persisted?.sessionID === sessionID) {
      if (isCancelPending(persisted)) throw new Error("workflow cancellation is pending")
      if (persisted.phase === "paused" || persisted.stopIntent) throw new Error("a paused or stopping workflow resumes only through the explicit Keep/Resume choice")
    }
    if (COMMON_ENGINES.has(runtime.host.identity.engine)) {
      assertRecoveryIdentity(sessionID)
    } else {
      const wf = activeWorkflowForHost()
      if (!wf) throw new Error("no active workflow to resume")
      if (wf.sessionID !== sessionID) throw new Error("no workflow owned by this session")
    }
    workflow(sessionID, "executing")
    return runInternal(sessionID, signal, true)
  }

  function status(sessionID: string, json = false) {
    return readForegroundStatus(runtime, sessionID, json, queue.isRunning(sessionID))
  }

  /** Pause/cancel request. Terminal state is committed only by the owner's settlement, never by this call. */
  function stop(sessionID: string, kind: "pause" | "cancel", reason: string): AnyFlowResult {
    runtime.linuxAdmission?.assertBootEpoch()
    const wf = recoveryIdentity(sessionID, undefined, undefined, true, false, true)
    assertCancellationOwner(wf, sessionID)
    const requested = requestStop(runtime, sessionID, kind, reason, { workflowID: wf.id })
    void requested.quiesce.then(() => {
      if (requested.result.ok) settleStop(sessionID, wf.id)
    }).catch(() => runtime.log("foreground stop settlement failed", { sessionID }))
    if (requested.result.ok) settleStop(sessionID, wf.id)
    const latest = readAnyWorkflowChecked(root).wf
    const result = requested.result
    if (result.ok && latest?.id === wf.id) return { ...result, wf: latest }
    return result
  }

  const cancel = (sessionID: string): AnyFlowResult => stop(sessionID, "cancel", "cancel requested")
  const pause = (sessionID: string): AnyFlowResult => stop(sessionID, "pause", "pause requested")

  return { validateImportedPlan, importPlan, decide, run, runApprovedUnit, resume, resumePaused: resumePausedBy, status, cancel, pause, assertRecoveryIdentity }
}

/** CLI status can call this with a FlowRuntime only: no host, SDK, policy, credential, claim or model construction. */
export function readForegroundStatus(runtime: FlowRuntime, sessionID: string, json = false, queueRunning = false) {
  return json ? statusJson(runtime, sessionID, { queueRunning }) : renderStatus(runtime, sessionID, queueRunning)
}
