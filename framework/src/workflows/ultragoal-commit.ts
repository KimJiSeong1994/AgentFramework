// Ultragoal commit (P6b S2): compare-and-swap publish of one transition inside the flow transaction. The session guard
// (live attachment epoch, no hold) and the committed stop intent are re-checked in the same transaction, and
// commitRevision re-verifies the required artifacts, receipts and (at done) the all-goal evidence before publishing.
import { readAnyWorkflowForWrite, withFlowTransaction, workflowReadError, type FlowTx } from "../flow/state.ts"
import { commitRevision, type CommitEvent } from "./commit.ts"
import { sessionGuard } from "./session-guard.ts"
import { isUltragoal, type Transition, type UgEvent, type UltragoalWorkflow } from "./ultragoal.ts"
import type { WorkflowEnvelope } from "./types.ts"

export type CommitOutcome = { ok: true; wf: UltragoalWorkflow } | { ok: false; text: string }
export type CommitBuild = (fresh: UltragoalWorkflow, tx: FlowTx) => Transition & { receipts?: readonly string[] }

const toEvents = (wf: UltragoalWorkflow, events: readonly UgEvent[], actor: CommitEvent["actor"]): CommitEvent[] =>
  events.map(event => ({ wf: wf.id, type: event.type, actor, ...(event.data ? { data: event.data } : {}) }))

/**
 * The committed workflow must still be exactly `expected` (same revision, stage, phase) with no stop intent, otherwise
 * nothing is written. `build` runs against the fresh record, so artifact, receipt and aggregate checks happen in the
 * same transaction as the publish; a refusal returns the reason and leaves the previous index authoritative.
 */
export function commitUltragoal(worktree: string, expected: UltragoalWorkflow, build: CommitBuild, now = Date.now(), actor: CommitEvent["actor"] = "code"): CommitOutcome {
  return withFlowTransaction(worktree, (tx): CommitOutcome => {
    const checked = readAnyWorkflowForWrite(tx)
    if (checked.corrupt) throw workflowReadError(checked)
    const fresh = checked.wf
    if (!fresh || !isUltragoal(fresh) || fresh.id !== expected.id || fresh.lastSeq !== expected.lastSeq || fresh.stage !== expected.stage || fresh.phase !== expected.phase) {
      return { ok: false, text: "workflow changed meanwhile; stop and check /status" }
    }
    if (fresh.stopIntent) return { ok: false, text: `workflow ${fresh.stopIntent.kind} is pending` }
    const guard = sessionGuard(worktree, fresh)
    if (guard) return { ok: false, text: guard }
    try {
      const built = build(fresh, tx)
      const committed = commitRevision(tx, { ...built.wf, lastSeq: fresh.lastSeq } as WorkflowEnvelope, toEvents(fresh, built.events, actor), now, { receipts: built.receipts ?? [] })
      return { ok: true, wf: committed as UltragoalWorkflow }
    } catch (error) {
      return { ok: false, text: (error as Error).message }
    }
  })
}
