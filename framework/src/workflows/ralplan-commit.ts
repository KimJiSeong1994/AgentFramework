// Ralplan commit (P6a S3): compare-and-swap publish of one transition inside the flow transaction, and the seed check
// for a DI -> ralplan handoff. Evidence is verified in the same transaction as the publish (commitRevision re-verifies
// the required artifacts and every receipt it is given).
import { readAnyWorkflowForWrite, withFlowTransaction, workflowReadError, type FlowTx } from "../flow/state.ts"
import { verifyArtifact } from "./artifacts.ts"
import { sessionGuard } from "./session-guard.ts"
import { commitRevision, type CommitEvent } from "./commit.ts"
import { isRalplan, type RalplanEvent, type RalplanWorkflow, type Transition } from "./ralplan.ts"
import type { RalplanSeed } from "./ralplan-data.ts"
import type { WorkflowEnvelope } from "./types.ts"

export type CommitOutcome = { ok: true; wf: RalplanWorkflow } | { ok: false; text: string }
export type CommitBuild = (fresh: RalplanWorkflow, tx: FlowTx) => Transition & { receipts?: readonly string[] }

const toEvents = (wf: RalplanWorkflow, events: readonly RalplanEvent[]): CommitEvent[] =>
  events.map(event => ({ wf: wf.id, type: event.type, actor: "code" as const, ...(event.data ? { data: event.data } : {}) }))

/**
 * The committed workflow must still be exactly `expected` (same revision, stage, phase) with no stop intent, otherwise
 * nothing is written. `build` runs against the fresh record, so artifact and receipt checks happen in the same
 * transaction as the publish; a build or commit refusal returns the reason and leaves the previous index authoritative.
 */
export function commitRalplan(worktree: string, expected: RalplanWorkflow, build: CommitBuild, now = Date.now()): CommitOutcome {
  return withFlowTransaction(worktree, (tx): CommitOutcome => {
    const checked = readAnyWorkflowForWrite(tx)
    if (checked.corrupt) throw workflowReadError(checked)
    const fresh = checked.wf
    if (!fresh || !isRalplan(fresh) || fresh.id !== expected.id || fresh.lastSeq !== expected.lastSeq || fresh.stage !== expected.stage || fresh.phase !== expected.phase) {
      return { ok: false, text: "workflow changed meanwhile; stop and check /status" }
    }
    if (fresh.stopIntent) return { ok: false, text: `workflow ${fresh.stopIntent.kind} is pending` }
    const guard = sessionGuard(worktree, fresh)
    if (guard) return { ok: false, text: guard }
    try {
      const built = build(fresh, tx)
      const committed = commitRevision(tx, { ...built.wf, lastSeq: fresh.lastSeq } as WorkflowEnvelope, toEvents(fresh, built.events), now, { receipts: built.receipts ?? [] })
      return { ok: true, wf: committed as RalplanWorkflow }
    } catch (error) {
      return { ok: false, text: (error as Error).message }
    }
  })
}

/** Verify the DI spec a ralplan is seeded from: recorded with a hash and still hashing to it on disk. */
export function seedFromSpec(worktree: string, predecessor: WorkflowEnvelope, key = "spec.md"): RalplanSeed {
  if (predecessor.kind !== "deep-interview" || predecessor.phase !== "done") throw new Error("a ralplan seed needs a finished deep-interview")
  const ref = predecessor.artifacts.find(item => item.key === key)
  if (!ref?.sha256) throw new Error(`seed artifact ${key} is not recorded with a hash`)
  const verified = verifyArtifact(worktree, ref)
  if (verified.state !== "verified") throw new Error(`seed artifact ${key} is ${verified.state}: ${verified.reason}`)
  return { workflowID: predecessor.id, specPath: ref.path, specSha: ref.sha256 }
}
