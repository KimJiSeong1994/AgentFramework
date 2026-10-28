// Resume of a settled pause (P5b D4). The preconditions are independent, each with its own id and refusal text, and
// are evaluated synchronously from persisted state so the same function runs before the human choice and again inside
// the commit transaction. Nothing here starts a model, queue, review or idle turn.
import { OPEN_STATUSES, readLedger } from "../state/ledger.ts"
import { getOwnedSession, readSessionMetadata } from "../sessions/store.ts"
import { assertAdmissionQuiescent, hasEndMarker, hasStopMarker, holdAdmission, readHoldBinding, resumeAdmission } from "../sessions/admission.ts"
import type { ExecutionRuntime } from "../hosts/types.ts"
import { describeArtifacts, verifyArtifact, planArtifactRefs } from "../workflows/artifacts.ts"
import { readCheckpoint, taskPartition, worktreeDigest, type SettledCheckpoint } from "../workflows/checkpoint.ts"
import { approvalIsCurrent, approvedSubjectOf, isUnitKind, planSubject, sameSubject, stopSubjectOf, unitFor, unitRecord } from "../workflows/execution-unit.ts"
import { isCancelPending } from "../workflows/types.ts"
import { savedPlan } from "./actions.ts"
import { assertFlowTxWorktree, readAnyWorkflowForWrite, readEvents, withFlowTransaction, workflowEngineRefusal, workflowReadError, type FlowTx } from "./state.ts"
import { applyAnyEventIn, stopBlockers } from "./runtime.ts"
import type { WorkflowEnvelope } from "../workflows/types.ts"

type Workflow = WorkflowEnvelope

export const RESUME_PRECONDITIONS = ["owner", "preflight", "subject", "stop-proof", "unrelated-tasks", "cancel-or-end", "artifacts"] as const
export type ResumePrecondition = (typeof RESUME_PRECONDITIONS)[number]

export type ResumeCheck =
  | { ok: false; precondition: ResumePrecondition; reason: string }
  | { ok: true; wf: Workflow; checkpoint: SettledCheckpoint }

const fail = (precondition: ResumePrecondition, reason: string): ResumeCheck => ({ ok: false, precondition, reason })

/**
 * Preconditions 1 and 3-7 (2, host preflight, is async and owned by the caller). `epoch` is the attachment epoch the
 * caller holds; a reattach alone is not a Resume, but the committed owner binding to this epoch is required.
 */
export function checkResumeIn(tx: FlowTx, runtime: ExecutionRuntime, sessionID: string, expectedRevision: number): ResumeCheck {
  assertFlowTxWorktree(tx, runtime.worktree)
  const checked = readAnyWorkflowForWrite(tx)
  if (checked.corrupt) throw workflowReadError(checked)
  const wf = checked.wf
  if (!wf || wf.sessionID !== sessionID) return fail("owner", "no workflow owned by this session")
  const engineRefusal = workflowEngineRefusal(wf, runtime.host.identity.engine)
  if (engineRefusal) return fail("owner", engineRefusal)
  if (wf.lastSeq !== expectedRevision) return fail("owner", "workflow revision changed; explicit resume refused")

  // 6. no pending cancel and no end marker (first: a cancel outranks every other reason)
  if (isCancelPending(wf)) return fail("cancel-or-end", "workflow cancellation is pending")
  if (hasEndMarker(runtime.worktree, sessionID)) return fail("cancel-or-end", "session end request remains held")
  if (hasStopMarker(runtime.worktree, sessionID)) return fail("cancel-or-end", "a user stop marker remains; acknowledge it before resuming the workflow")

  // 1. owner/attachment: the held marker is bound to this workflow and the committed owner is this attachment epoch
  let store: ReturnType<typeof getOwnedSession>
  try { store = getOwnedSession(runtime.worktree, sessionID) } catch { store = undefined }
  if (!store) return fail("owner", "session attachment is not owned by this process")
  try { store.assertOwner() } catch (error) { return fail("owner", (error as Error).message) }
  const metadata = readSessionMetadata(runtime.worktree, sessionID)
  if (!metadata || metadata.engine !== runtime.host.identity.engine || !metadata.held) return fail("owner", "session is not held by this owner")
  if (wf.owner.instance !== store.epoch || wf.owner.pid !== process.pid) return fail("owner", "workflow is not bound to this attachment epoch; reattach first")
  const binding = readHoldBinding(runtime.worktree, sessionID)
  if (!binding || !binding.held || binding.epoch !== store.epoch || binding.workflowID !== wf.id) return fail("owner", "durable held-owner binding does not name this workflow")

  // 4. stop proof
  const intent = wf.stopIntent
  if (wf.phase !== "paused" || intent?.kind !== "pause" || !wf.pausedFrom) return fail("stop-proof", "workflow is not a settled pause")
  const settledEvents = readEvents(runtime.worktree, wf.id, wf.sessionID).filter(event => event.type === "pause_settled" && event.data?.token === intent.token)
  if (settledEvents.length !== 1) return fail("stop-proof", "no committed pause_settled for this stop")
  const checkpoint = readCheckpoint(runtime.worktree, sessionID, wf.id, intent.token, intent.checkpoint)
  if (!checkpoint.ok) return fail("stop-proof", checkpoint.reason)
  if (checkpoint.value.kind !== "settled") return fail("stop-proof", "checkpoint is not the settled checkpoint")
  // The resumeAdmission quiescence precondition, run before the commit rather than after it.
  try { assertAdmissionQuiescent(runtime, sessionID) } catch (error) { return fail("stop-proof", `termination is not proven: ${(error as Error).message}`) }
  const blockers = stopBlockers(runtime, sessionID, store.epoch, false)
  if (blockers.length > 0) return fail("stop-proof", `termination is not proven: ${blockers.join("; ")}`)

  // Planning kinds (deep-interview, ralplan) resume their stage: no plan subject, no ledger tasks, never execution.
  // Unit kinds paused while executing resume only their approved unit; any other stage resumes like a planning stage.
  if (wf.kind !== "plan") {
    const bad = describeArtifacts(runtime.worktree, wf).find(item => item.state !== "verified")
    if (bad) return fail("artifacts", `artifact ${bad.key} is ${bad.state}: ${bad.reason}`)
    const ledger = readLedger(runtime.worktree, sessionID)
    if (!isUnitKind(wf.kind) || wf.pausedFrom.phase !== "executing") {
      const open = ledger.tasks.find(task => OPEN_STATUSES.has(task.status))
      if (open) return fail("unrelated-tasks", `open task ${open.id} is not part of this pause's residual`)
      return { ok: true, wf, checkpoint: checkpoint.value }
    }
    // 3. subject: the unit and its approval are unchanged, and its documents still verify from disk
    const subject = stopSubjectOf({ ...wf, stage: wf.pausedFrom.stage } as never)
    if (!subject || !checkpoint.value.subject || !sameSubject(checkpoint.value.subject, subject) || !sameSubject(approvedSubjectOf(wf), subject)) {
      return fail("subject", "approved subject changed since the pause; new execution approval required")
    }
    try { unitFor({ ...wf, phase: "executing", stage: wf.pausedFrom.stage } as never, { worktree: runtime.worktree }) }
    catch { return fail("subject", "approved unit or its documents changed; new execution approval required") }
    // 5. every open task is tagged for this unit and recorded as residual; completed work stays done
    const residual = new Set(checkpoint.value.residual)
    for (const task of ledger.tasks.filter(item => OPEN_STATUSES.has(item.status))) {
      if (task.wf?.id !== wf.id || task.wf.planSha !== subject.sha256 || !residual.has(task.id)) {
        return fail("unrelated-tasks", `open task ${task.id} is not part of this pause's residual`)
      }
    }
    // An autoresearch experiment's done set is its settled run slots (in the record), not ledger tasks.
    const now = wf.kind === "autoresearch" ? { done: unitRecord(wf)?.done ?? [] } : taskPartition(ledger, wf.id, subject.sha256)
    if (!checkpoint.value.done.every(id => now.done.includes(id))) return fail("unrelated-tasks", "a task completed before the pause is no longer done")
    return { ok: true, wf, checkpoint: checkpoint.value }
  }

  // 3. subject/hash: nothing approved may have changed while paused
  const from = wf.pausedFrom.phase
  if (from !== "planning") {
    const plan = savedPlan(runtime, wf)
    if (!plan || !wf.planRef) return fail("subject", "approved plan or rendered file changed; new execution approval required")
    if (!sameSubject(checkpoint.value.subject, planSubject(wf)) || checkpoint.value.plan?.jsonSha !== wf.planRef.jsonSha || checkpoint.value.plan.mdSha !== wf.planRef.mdSha) {
      return fail("subject", "approved subject changed since the pause; new execution approval required")
    }
    if (from === "executing" && !approvalIsCurrent(wf as never)) return fail("subject", "approval no longer names the current subject; new execution approval required")
    for (const ref of planArtifactRefs(wf)) {
      if (verifyArtifact(runtime.worktree, ref).state !== "verified") return fail("subject", "rendered plan changed; new execution approval required")
    }
  }

  // 5. no unrelated open tasks: every open task is ours and was recorded as residual
  const ledger = readLedger(runtime.worktree, sessionID)
  const open = ledger.tasks.filter(task => OPEN_STATUSES.has(task.status))
  const residual = new Set(checkpoint.value.residual)
  const sha = wf.planRef?.jsonSha
  for (const task of open) {
    if (task.wf?.id !== wf.id || (sha !== undefined && task.wf.planSha !== sha) || !residual.has(task.id)) {
      return fail("unrelated-tasks", `open task ${task.id} is not part of this pause's residual`)
    }
  }
  if (from === "executing") {
    const now = taskPartition(ledger, wf.id, sha ?? null)
    if (now.done.length < checkpoint.value.done.length || !checkpoint.value.done.every(id => now.done.includes(id))) {
      return fail("unrelated-tasks", "a task completed before the pause is no longer done")
    }
  }

  // 7. artifacts
  const bad = describeArtifacts(runtime.worktree, wf).find(item => item.state !== "verified")
  if (bad) return fail("artifacts", `artifact ${bad.key} is ${bad.state}: ${bad.reason}`)

  return { ok: true, wf, checkpoint: checkpoint.value }
}

// ---------------------------------------------------------------- the Resume flow
export type ResumeView = {
  workflowID: string
  pausedFrom: { phase: string; stage: string }
  residual: string[]
  done: string[]
  interrupted: Array<{ id: string; cause: string }>
  /** Display only: the worktree differs from the digest taken when the pause settled. */
  worktreeChanged: boolean
  attempt: number
}

export type ResumeOutcome =
  | { kind: "refused"; precondition: ResumePrecondition; reason: string }
  | { kind: "kept"; view: ResumeView }
  | { kind: "resumed"; wf: Workflow; view: ResumeView }

export type ResumeHooks = {
  /** Precondition 2, run before the choice and again after it (host preflight, required controls, boot epoch). */
  preflight(): Promise<void>
  /** Snapshot of admission authority; a change between the choice and the commit refuses the Resume. */
  fence(): string
  /** The human choice. Anything but `true` keeps the session held and starts nothing. */
  choose(view: ResumeView): Promise<boolean>
}

function viewOf(runtime: ExecutionRuntime, check: Extract<ResumeCheck, { ok: true }>): ResumeView {
  const { wf, checkpoint } = check
  const subjectSha = wf.kind === "plan" ? wf.planRef?.jsonSha ?? null : checkpoint.subject?.sha256 ?? null
  const current = taskPartition(readLedger(runtime.worktree, wf.sessionID), wf.id, subjectSha)
  const resumedBefore = readEvents(runtime.worktree, wf.id, wf.sessionID).filter(event => event.type === "resumed").length
  return {
    workflowID: wf.id, pausedFrom: wf.pausedFrom!, residual: current.residual, done: current.done,
    interrupted: checkpoint.interrupted, worktreeChanged: JSON.stringify(worktreeDigest(runtime.worktree)) !== JSON.stringify(checkpoint.worktree),
    attempt: resumedBefore + 2,
  }
}

function checkNow(runtime: ExecutionRuntime, sessionID: string, revision: number): ResumeCheck {
  return withFlowTransaction(runtime.worktree, tx => checkResumeIn(tx, runtime, sessionID, revision), sessionID)
}

/**
 * D4. Check, show, ask, recheck, then commit exactly one `resume`. Admission is cleared only after the commit, and only
 * for the current epoch (`resumeAdmission` mints a fresh token); a crash in between leaves the session held with the
 * workflow already resumed, so a normal Resume admits. Dispatch by `pausedFrom` belongs to the host.
 */
export async function resumePaused(runtime: ExecutionRuntime, sessionID: string, expectedRevision: number, hooks: ResumeHooks): Promise<ResumeOutcome> {
  const first = checkNow(runtime, sessionID, expectedRevision)
  if (!first.ok) return { kind: "refused", precondition: first.precondition, reason: first.reason }
  try { await hooks.preflight() } catch (error) { return { kind: "refused", precondition: "preflight", reason: (error as Error).message } }
  const fence = hooks.fence()
  const view = viewOf(runtime, first)
  if (!(await hooks.choose(view))) return { kind: "kept", view }

  // Recheck after the choice: async preflight, admission fence, then 1 and 3-7 again inside the commit transaction.
  try { await hooks.preflight() } catch (error) { return { kind: "refused", precondition: "preflight", reason: (error as Error).message } }
  if (hooks.fence() !== fence) return { kind: "refused", precondition: "owner", reason: "session authority changed during Resume" }
  const committed = withFlowTransaction(runtime.worktree, (tx): ResumeOutcome => {
    const check = checkResumeIn(tx, runtime, sessionID, expectedRevision)
    if (!check.ok) return { kind: "refused", precondition: check.precondition, reason: check.reason }
    const { wf, checkpoint } = check
    const from = wf.pausedFrom!
    const result = applyAnyEventIn(
      tx, runtime, wf, "resume", "user_command", { resumeChecked: true },
      (next) => ({ ...next, stage: from.stage as never }),
      { token: wf.stopIntent!.token, checkpointRef: wf.stopIntent!.checkpoint, attempt: view.attempt, residual: checkpoint.residual },
    )
    if (!result.ok) return { kind: "refused", precondition: "stop-proof", reason: result.text }
    return { kind: "resumed", wf: result.wf, view }
  }, sessionID)
  if (committed.kind !== "resumed") return committed
  // The hold marker still names the paused revision; rebind it to the resumed one, then mint the token for this epoch.
  holdAdmission(runtime.worktree, sessionID, "workflow_resume")
  resumeAdmission(runtime, sessionID, committed.wf.lastSeq)
  return committed
}
