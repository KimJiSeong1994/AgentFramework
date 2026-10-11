// Advisory plan review (ralplan §5/§6 M1): a `reviewer` child session judges the submitted plan before it reaches
// pending_approval. Runs INSIDE the lca_flow tool call (main is blocked, so it never races a running queue).
// The only model text read is the verdict line (parsePlanVerdict, reuses the parseVerdict normalisation ideas);
// findings are advisory only — approval is the user's decision (/approve), never this reviewer's.
import { randomUUID } from "node:crypto"
import { LinuxAdmissionRefused, type ExecutionHandle, type ExecutionOutcome, type ExecutionRuntime } from "../hosts/types.ts"
import { assertPreparedHostReference, hostReferenceHasVendorID } from "../hosts/run-state.ts"
import { beginExecutionActivity } from "../hosts/runtime.ts"
import { estimateTokens } from "../tokens.ts"
import { getQueue } from "../orchestration/queue.ts"
import { renderPlanMd, type Plan } from "./plan.ts"
import { readWorkflow, type Workflow } from "./state.ts"

/** <= 350 est. tokens (asserted in test and by doctor D12c); the rendered plan is appended after this and capped separately. */
export const PLAN_REVIEW_TEMPLATE = `Review this plan before it goes to the user for approval. You are read-only: never edit, write or run commands.

Check: are the steps concrete and in a sane order? Does each step's files match what its verify command exercises? Is anything the goal needs missing, or present that it does not need? Are the risks real, not filler?

Reply with at most 5 short findings, one per line starting with "- " (omit if none), then a last line, exactly:
VERDICT: OKAY
or
VERDICT: ITERATE

OKAY: good enough to show the user, even if imperfect. ITERATE: one concrete, fixable problem worth another pass. Do not invent problems. Approval is the user's decision, not yours; you are advisory only.

Plan:
`

export type PlanReviewVerdict = "okay" | "iterate" | "none"
export type PlanReviewResult = { verdict: PlanReviewVerdict; findings: string[]; note?: "aborted" }

const PLAN_TOKEN_CAP = 1500

/** Trim the rendered plan from the end (whole lines) until it fits the review-prompt token budget. */
function capPlanText(text: string, maxTokens = PLAN_TOKEN_CAP): string {
  if (estimateTokens(text) <= maxTokens) return text
  const lines = text.split("\n")
  while (lines.length > 4 && estimateTokens(lines.join("\n")) > maxTokens) lines.pop()
  return lines.join("\n") + "\n… (truncated)"
}

/**
 * Verdict contract: the last line starting with (optionally) "VERDICT:" then one of OKAY|ACCEPT(ED)|승인 (okay) or
 * ITERATE|REJECT(ED)|거부 (iterate); anything else is `none` (never silently accepted). Up to 5 "- " findings.
 */
export function parsePlanVerdict(text: string): { verdict: PlanReviewVerdict; findings: string[] } {
  const rawLines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
  const findings = rawLines
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean)
    .slice(0, 5)
  const re = /^(?:verdict[\s*_`]*[:：]?)?\s*[*_`]*(okay|accept(?:ed)?|iterate|reject(?:ed)?|승인|거부)(?![A-Za-z])/i
  for (let i = rawLines.length - 1; i >= 0; i--) {
    const stripped = rawLines[i]!.replace(/^[\s*_`#>\-]+/, "")
    const m = re.exec(stripped)
    if (!m) continue
    const word = m[1]!.toLowerCase()
    if (word === "okay" || word.startsWith("accept") || word === "승인") return { verdict: "okay", findings }
    if (word === "iterate" || word.startsWith("reject") || word === "거부") return { verdict: "iterate", findings }
  }
  return { verdict: "none", findings }
}

// ---------------------------------------------------------------- tool-call cap (reviewer child sessions only)
// tool-before.ts consults this for a session it did not create; keyed by session id, cleared when the review ends.
const reviewToolCalls = new Map<string, number>()

export function markReviewSession(sessionID: string): void {
  reviewToolCalls.set(sessionID, 0)
}
export function clearReviewSession(sessionID: string): void {
  reviewToolCalls.delete(sessionID)
}
export function isReviewSession(sessionID: string): boolean {
  return reviewToolCalls.has(sessionID)
}

/** tool.execute.before for a marked review session: increments the count, returns a refusal reason past the cap. */
export function reviewToolCapProblem(sessionID: string, max: number): string | null {
  const n = (reviewToolCalls.get(sessionID) ?? 0) + 1
  reviewToolCalls.set(sessionID, n)
  return n > max ? "give your verdict now" : null
}

// ---------------------------------------------------------------- child session

/**
 * Run an advisory review under the same durable claim and fence as worker executions.
 * No vendor response, including an abort acknowledgement, proves quiescence by itself.
 */
export async function runPlanReview(runtime: ExecutionRuntime, wf: Workflow, plan: Plan, signal?: AbortSignal): Promise<PlanReviewResult> {
  runtime.linuxAdmission?.assertBootEpoch()
  if (getQueue(runtime).isRunning(wf.sessionID)) return { verdict: "none", findings: [] }
  if (signal?.aborted) return { verdict: "none", findings: [], note: "aborted" }
  const releaseActivity = beginExecutionActivity(runtime, wf.sessionID, "review")
  if (!releaseActivity) return { verdict: "none", findings: [] }
  const abortController = new AbortController()
  const reviewSignal = abortController.signal
  const forwardAbort = () => abortController.abort()
  if (signal) {
    if (signal.aborted) abortController.abort()
    else signal.addEventListener("abort", forwardAbort, { once: true })
  }
  let workflowCancelTimer: ReturnType<typeof setInterval> | undefined
  const runs = runtime.runs
  const aborted: PlanReviewResult = { verdict: "none", findings: [], note: "aborted" }
  let claim: ReturnType<typeof runs.claim> | undefined
  let executionID: string | undefined
  let handle: ExecutionHandle | undefined
  let vendorSessionID: string | undefined
  let quiescent = false
  let registered = false
  let quiescenceAsserted = false
  let admissionReleaseFailed = false
  const cancelAndReconcile = async (): Promise<boolean> => {
    if (!claim || !executionID || !handle) return false
    const requestedAt = Date.now()
    const cancelDeadline = requestedAt + 1000
    runs.recordCancel(claim, executionID, { requestedAt })
    const cancel = await Promise.race([
      handle.requestCancel("review timeout or abort", cancelDeadline).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ])
    if (cancel?.acknowledged) runs.recordCancel(claim, executionID, { requestedAt, acknowledgedAt: Date.now() })
    let proven = false
    if (cancel?.terminal && cancel.quiescent) {
      runs.recordTerminal(claim, executionID, { outcome: "cancelled", terminalAt: Date.now(), quiescentAt: Date.now() })
      proven = true
    } else {
      const reconciled = await Promise.race([
        handle.reconcile().catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
      ])
      if (reconciled) {
        runs.reconcile(claim, executionID, reconciled)
        proven = reconciled.outcome === "terminal" && reconciled.quiescent
      }
    }
    if (proven) {
      try {
        runs.assertQuiescent(claim)
        return true
      } catch { /* Fence below; the store is the final authority. */ }
    }
    runs.fence(claim, executionID, "review cancellation ended without terminal quiescence")
    return false
  }
  let markedReviewSessionID: string | undefined
  const captureReference = (candidate: unknown): void => {
    assertPreparedHostReference(candidate, executionID!)
    runs.bindVendorRef(claim!, executionID!, JSON.stringify(candidate))
    if (candidate.vendorSessionID) {
      vendorSessionID = candidate.vendorSessionID
      if (markedReviewSessionID !== vendorSessionID) {
        if (markedReviewSessionID) throw new Error("review vendor session reference changed")
        markedReviewSessionID = vendorSessionID
        markReviewSession(vendorSessionID)
      }
    }
  }
  try {
    const observeWorkflowCancellation = () => {
      if (reviewSignal.aborted) return
      let current: ReturnType<typeof readWorkflow>
      try { current = readWorkflow(runtime.worktree) }
      catch { return }
      if (current?.id !== wf.id || current.sessionID !== wf.sessionID || !(current.pendingCancel || current.phase === "cancelled")) return
      abortController.abort()
      if (workflowCancelTimer) clearInterval(workflowCancelTimer)
    }
    let currentWorkflow: ReturnType<typeof readWorkflow>
    try { currentWorkflow = readWorkflow(runtime.worktree) }
    catch { currentWorkflow = null }
    if (currentWorkflow?.id === wf.id && currentWorkflow.sessionID === wf.sessionID) {
      observeWorkflowCancellation()
      if (!reviewSignal.aborted) workflowCancelTimer = setInterval(observeWorkflowCancellation, 50)
    }
    if (reviewSignal.aborted) return aborted
    claim = runs.claim(wf.sessionID, runtime.instance, process.pid)
    runs.assertQuiescent(claim)
    quiescenceAsserted = true
    try {
      await runtime.linuxAdmission?.admitNewExecution()
    } catch (e) {
      if (e instanceof LinuxAdmissionRefused && claim && quiescenceAsserted && !registered) {
        const held = claim
        claim = undefined
        try {
          runs.release(held)
        } catch (releaseError) {
          admissionReleaseFailed = true
          throw releaseError
        }
      }
      throw e
    }
    const policy = runtime.policy.resolve("reviewer")
    executionID = randomUUID()
    const deadlineAt = Date.now() + runtime.config.delegate.review_ttl_ms
    const base = {
      executionID, supervisorSessionID: wf.sessionID, taskID: wf.id, attemptID: randomUUID(),
      generation: claim.generation, role: "reviewer" as const, title: `lca plan review: ${wf.id}`,
      cwd: runtime.directory, text: `${PLAN_REVIEW_TEMPLATE}\n${capPlanText(renderPlanMd(wf.id, plan))}`,
      deadlineAt, policy,
    }
    runs.registerIntent(claim, { executionId: executionID, ownerSession: wf.sessionID, taskId: wf.id,
      attemptId: base.attemptID, generation: claim.generation, role: "reviewer", cwd: runtime.directory, policyID: policy.id,
      kind: "host", engine: runtime.host.identity.engine, profile: "legacy-unowned",
      ...(runtime.host.identity.controlProfile ? { controlProfile: runtime.host.identity.controlProfile } : {}) })
    registered = true
    let prepareTimer: ReturnType<typeof setTimeout> | undefined
    let onPrepareAbort: (() => void) | undefined
    let prepared: ExecutionHandle | null
    try {
      prepared = await Promise.race([
        runtime.host.prepare({ ...base, handlers: runtime.policy.handlers(base),
          onReference: (reference) => { captureReference(reference) } }),
        new Promise<null>((resolve) => { prepareTimer = setTimeout(() => resolve(null), Math.max(0, deadlineAt - Date.now())) }),
        new Promise<null>((resolve) => {
          onPrepareAbort = () => resolve(null)
          reviewSignal.addEventListener("abort", onPrepareAbort, { once: true })
          if (reviewSignal.aborted) resolve(null)
        }),
      ])
    } finally {
      if (prepareTimer) clearTimeout(prepareTimer)
      if (onPrepareAbort) reviewSignal.removeEventListener("abort", onPrepareAbort)
    }
    if (!prepared) {
      runs.fence(claim, executionID, "review preparation timed out without a known vendor reference")
      return aborted
    }
    handle = prepared
    assertPreparedHostReference(handle.reference, executionID)
    if (hostReferenceHasVendorID(handle.reference)) captureReference(handle.reference)
    if (reviewSignal.aborted) {
      quiescent = await cancelAndReconcile()
      return aborted
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadlineAt - Date.now()))
      onAbort = () => resolve(null)
      reviewSignal.addEventListener("abort", onAbort, { once: true })
      if (reviewSignal.aborted) resolve(null)
    })
    try {
      runs.markHostDispatched(claim, executionID)
      let outcome = await Promise.race<ExecutionOutcome | null>([handle.run(), timeout])
      if (outcome !== null) {
        observeWorkflowCancellation()
        if (reviewSignal.aborted) outcome = null
      }
      if (outcome === null) {
        quiescent = await cancelAndReconcile()
        return aborted
      }
      runs.recordTerminal(claim, executionID, { outcome: outcome.status, terminalAt: Date.now() })
      const reconciled = await Promise.race([
        handle.reconcile().catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
      ])
      if (reconciled) {
        runs.reconcile(claim, executionID, reconciled)
        quiescent = reconciled.outcome === "terminal" && reconciled.quiescent
      }
      if (quiescent) {
        try { runs.assertQuiescent(claim) }
        catch { quiescent = false }
      }
      if (!quiescent) {
        runs.fence(claim, executionID, "review terminal response lacks quiescence proof")
        return aborted
      }
      observeWorkflowCancellation()
      if (reviewSignal.aborted) return aborted
      return outcome.status === "completed" && outcome.text ? parsePlanVerdict(outcome.text) : aborted
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) reviewSignal.removeEventListener("abort", onAbort)
    }
  } catch (e) {
    if (e instanceof LinuxAdmissionRefused) throw e
    if (admissionReleaseFailed) throw e
    runtime.log("plan review: execution failed", { error: e instanceof Error ? e.message : String(e) })
    if (claim && executionID && registered) {
      if (!quiescent) runs.fence(claim, executionID, "review preparation or execution failed without quiescence proof")
    }
    return aborted
  } finally {
    try {
      if (claim && quiescent) {
        runs.assertQuiescent(claim)
        runs.release(claim)
        if (vendorSessionID) {
          clearReviewSession(vendorSessionID)
          runtime.policy.unbindSession(vendorSessionID)
        }
      }
    } finally {
      if (workflowCancelTimer) clearInterval(workflowCancelTimer)
      if (signal) signal.removeEventListener("abort", forwardAbort)
      releaseActivity()
    }
  }
}
