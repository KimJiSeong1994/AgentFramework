// Autoresearch commit (P6b S3): compare-and-swap publish of one transition inside the flow transaction. The session guard
// (live attachment epoch, no hold) and the committed stop intent are re-checked in the same transaction, and
// commitRevision re-verifies the required artifacts, receipts and (at a terminal) the run/verdict evidence before
// publishing. `recording` is the one exception: the owner of an in-flight run records what actually happened even while a
// stop is pending (the run file and its verification receipt are evidence, never a lifecycle change).
import { readAnyWorkflowForWrite, withFlowTransaction, workflowReadError, type FlowTx } from "../flow/state.ts"
import type { ExecutionRuntime } from "../hosts/types.ts"
import { getOwnedSession } from "../sessions/store.ts"
import { commitRevision, readCommitted, type CommitEvent } from "./commit.ts"
import { sessionGuard } from "./session-guard.ts"
import { isAutoresearch, type ArEvent, type AutoresearchWorkflow, type Transition } from "./autoresearch.ts"
import type { WorkflowEnvelope } from "./types.ts"

export type CommitOutcome = { ok: true; wf: AutoresearchWorkflow } | { ok: false; text: string }
export type CommitBuild = (fresh: AutoresearchWorkflow, tx: FlowTx) => Transition & { receipts?: readonly string[] }

const toEvents = (wf: AutoresearchWorkflow, events: readonly ArEvent[], actor: CommitEvent["actor"]): CommitEvent[] =>
  events.map(event => ({ wf: wf.id, type: event.type, actor, ...(event.data ? { data: event.data } : {}) }))

/** The committed autoresearch of this session and id, or the reason there is none. */
export function committedAutoresearch(runtime: Pick<ExecutionRuntime, "worktree">, sessionID: string, workflowID: string): AutoresearchWorkflow | string {
  let read: ReturnType<typeof readCommitted>
  try { read = readCommitted(runtime.worktree) } catch { return "workflow state is unreadable" }
  if (read.state !== "ok") return "workflow state is unavailable"
  const { wf } = read
  if (wf.id !== workflowID || wf.sessionID !== sessionID) return "workflow identity changed"
  if (!isAutoresearch(wf)) return `workflow is a ${wf.kind} workflow`
  return wf
}

/**
 * The committed workflow must still be exactly `expected` (same revision, stage, phase), otherwise nothing is written.
 * `build` runs against the fresh record, so artifact, receipt and evidence checks happen in the same transaction as the
 * publish; a refusal returns the reason and leaves the previous index authoritative.
 */
export function commitAutoresearch(
  worktree: string, expected: AutoresearchWorkflow, build: CommitBuild, now = Date.now(), actor: CommitEvent["actor"] = "code", options: { recording?: boolean } = {},
): CommitOutcome {
  return withFlowTransaction(worktree, (tx): CommitOutcome => {
    const checked = readAnyWorkflowForWrite(tx)
    if (checked.corrupt) throw workflowReadError(checked)
    const fresh = checked.wf
    if (!fresh || !isAutoresearch(fresh) || fresh.id !== expected.id || fresh.lastSeq !== expected.lastSeq || fresh.stage !== expected.stage || fresh.phase !== expected.phase) {
      return { ok: false, text: "workflow changed meanwhile; stop and check /status" }
    }
    if (options.recording) {
      let store: ReturnType<typeof getOwnedSession>
      try { store = getOwnedSession(worktree, fresh.sessionID) } catch { store = undefined }
      if (!store || store.epoch !== fresh.owner.instance || fresh.owner.pid !== process.pid) return { ok: false, text: "workflow is not bound to this live session attachment" }
    } else {
      if (fresh.stopIntent) return { ok: false, text: `workflow ${fresh.stopIntent.kind} is pending` }
      const guard = sessionGuard(worktree, fresh)
      if (guard) return { ok: false, text: guard }
    }
    try {
      const built = build(fresh, tx)
      const committed = commitRevision(tx, { ...built.wf, lastSeq: fresh.lastSeq } as WorkflowEnvelope, toEvents(fresh, built.events, actor), now, { receipts: built.receipts ?? [] })
      return { ok: true, wf: committed as AutoresearchWorkflow }
    } catch (error) {
      return { ok: false, text: (error as Error).message }
    }
  })
}
