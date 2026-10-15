// Re-checked inside every planning-kind commit transaction: the session must still be held by no one and the workflow
// must still belong to this process's live attachment epoch (a held, ended or re-attached session cannot advance state).
import type { ExecutionRuntime } from "../hosts/types.ts"
import { effectiveHold } from "../sessions/admission.ts"
import { getOwnedSession, readSessionMetadata } from "../sessions/store.ts"
import type { WorkflowEnvelope } from "./types.ts"

export function sessionGuard(worktree: string, wf: Pick<WorkflowEnvelope, "sessionID" | "owner">): string | undefined {
  try {
    const store = getOwnedSession(worktree, wf.sessionID)
    if (!store || store.epoch !== wf.owner.instance || wf.owner.pid !== process.pid) return "workflow is not bound to this live session attachment; /resume is required"
    if (effectiveHold(worktree, wf.sessionID)) return "session is held; explicit Resume is required"
  } catch (error) {
    return `session attachment is unavailable: ${(error as Error).message}`
  }
  return undefined
}

/** Admission shared by start and handoff: the session must be live, unheld and on this host's engine. */
export function liveAdmission(runtime: Pick<ExecutionRuntime, "worktree" | "host">, sessionID: string): { epoch: string } | string {
  let store: ReturnType<typeof getOwnedSession>
  try { store = getOwnedSession(runtime.worktree, sessionID) }
  catch (error) { return `session attachment is unavailable: ${(error as Error)?.message ?? String(error)}` }
  if (!store || effectiveHold(runtime.worktree, sessionID)) return `session ${sessionID} has no live admission; use /resume ${sessionID} before starting a workflow`
  let metadata: ReturnType<typeof readSessionMetadata>
  try { metadata = readSessionMetadata(runtime.worktree, sessionID) }
  catch (error) { return `session attachment state is unavailable: ${(error as Error)?.message ?? String(error)}` }
  if (store.metadata.held || !metadata || metadata.held || metadata.engine !== runtime.host.identity.engine) {
    return "session attachment is held or its engine does not match; /resume is required before starting a workflow"
  }
  return { epoch: store.epoch }
}
