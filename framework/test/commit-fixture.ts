// Test-only commit fixture: publishes an already-formed workflow as an index-bound immutable snapshot without
// appending events, so tests can stage arbitrary states (stale owners, phases, v1-era shapes) through the real v2
// on-disk layout. Production code has exactly one writer: commitRevision.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { durableWriteBytes } from "../src/state/durable.ts"
import { stateRoot } from "../src/state/store.ts"
import { withFlowTransaction, flowTxWorktree, flowTxSessionID, readWorkflowForWrite, workflowPath, workflowReadError, type FlowTx, type Workflow } from "../src/flow/state.ts"
import { parseEnvelope } from "../src/workflows/registry.ts"
import { readCommitted, sha256Hex, snapshotRelativePath } from "../src/workflows/commit.ts"
import type { WorkflowIndex } from "../src/workflows/types.ts"
import { REGISTRY } from "../src/workflows/registry.ts"

type Fixture = Omit<Workflow, "version" | "stage" | "stopIntent" | "artifacts" | "owner"> & {
  version?: 2
  stage?: Workflow["stage"]
  stopIntent?: Workflow["stopIntent"]
  artifacts?: Workflow["artifacts"]
  owner: { instance: string; pid: number; heartbeatAt?: number }
  /** v1-era shorthand for a pending cancel; becomes a cancel stopIntent. */
  pendingCancel?: boolean
}

/** Normalize a v1-era fixture shape into a valid v2 plan envelope. */
export function fixtureEnvelope(input: Fixture, now = Date.now()): Workflow {
  const { pendingCancel, owner, ...rest } = input as Fixture & Record<string, unknown>
  const wf = {
    ...rest,
    version: 2,
    stage: input.stage ?? REGISTRY.plan.stageOf(input.phase),
    stopIntent: input.stopIntent ?? (pendingCancel ? { kind: "cancel", token: "fixture-cancel", requestedFrom: { phase: input.phase, stage: input.stage ?? REGISTRY.plan.stageOf(input.phase) }, checkpoint: null, reason: "fixture" } : null),
    artifacts: input.artifacts ?? [],
    owner: { instance: owner.instance, pid: owner.pid },
    updatedAt: now,
  } as Workflow
  parseEnvelope(wf)
  return wf
}

export function writeWorkflow(tx: FlowTx, input: Fixture, now = Date.now()): Workflow {
  const worktree = flowTxWorktree(tx)
  // Same refusals as the real writer: corrupt or non-terminal legacy state is never overwritten.
  const existing = readWorkflowForWrite(tx)
  if (existing.corrupt) throw workflowReadError(existing)
  return publishWorkflow(worktree, input, now, flowTxSessionID(tx))
}

/** Publish without the corrupt-state refusal: simulates an operator repairing state out of band. */
export function publishWorkflow(worktree: string, input: Fixture, now = Date.now(), sessionID?: string): Workflow {
  const wf = fixtureEnvelope(input, now)
  const bytes = Buffer.from(`${JSON.stringify(wf)}\n`, "utf8")
  const relative = snapshotRelativePath(wf.sessionID, wf.id, wf.lastSeq)
  durableWriteBytes(join(stateRoot(worktree), relative), bytes)
  const index: WorkflowIndex = { version: 2, id: wf.id, sessionID: wf.sessionID, kind: wf.kind, revision: wf.lastSeq, path: relative, sha256: sha256Hex(bytes) }
  durableWriteBytes(workflowPath(worktree, sessionID), Buffer.from(`${JSON.stringify(index)}\n`, "utf8"))
  return wf
}

/** The committed snapshot bytes currently bound by the index. */
export function committedSnapshot(worktree: string, sessionID?: string): Workflow {
  const index = JSON.parse(readFileSync(workflowPath(worktree, fixtureSession(worktree, sessionID)), "utf8")) as WorkflowIndex
  return JSON.parse(readFileSync(join(stateRoot(worktree), index.path), "utf8")) as Workflow
}

/** Publish `patch` over the current committed workflow as a new snapshot (a raw-edit fixture, e.g. an engine swap). */
export function rewriteCommitted(worktree: string, patch: Partial<Workflow> | ((wf: Workflow) => Workflow), sessionID?: string): Workflow {
  sessionID = fixtureSession(worktree, sessionID)
  const current = committedSnapshot(worktree, sessionID)
  const next = typeof patch === "function" ? patch(current) : { ...current, ...patch }
  return withFlowTransaction(worktree, (tx) => writeWorkflow(tx, next as never, next.updatedAt), sessionID)
}

/**
 * Publish an arbitrary (possibly malformed) value as the index-bound snapshot with a matching index hash, so a
 * parse failure is attributable to the snapshot itself (status `invalid_state`), not to a hash or identity mismatch.
 */
export function writeRawSnapshot(worktree: string, value: unknown, identity: { id: string; sessionID: string; kind?: string; revision?: number }): { index: WorkflowIndex; path: string } {
  const bytes = Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value)}\n`, "utf8")
  const revision = identity.revision ?? 0
  const relative = snapshotRelativePath(identity.sessionID, identity.id, revision)
  const target = join(stateRoot(worktree), relative)
  durableWriteBytes(target, bytes)
  const index = { version: 2, id: identity.id, sessionID: identity.sessionID, kind: identity.kind ?? "plan", revision, path: relative, sha256: sha256Hex(bytes) } as WorkflowIndex
  durableWriteBytes(workflowPath(worktree), Buffer.from(`${JSON.stringify(index)}\n`, "utf8"))
  return { index, path: target }
}

/** Byte length of the index-bound snapshot (status reads index + snapshot). */
export function committedSnapshotBytes(worktree: string, sessionID?: string): number {
  const index = JSON.parse(readFileSync(workflowPath(worktree, fixtureSession(worktree, sessionID)), "utf8")) as WorkflowIndex
  return readFileSync(join(stateRoot(worktree), index.path)).byteLength
}

/** Test-only convenience: infer only one verified committed session, never orphan snapshots. */
function fixtureSession(worktree: string, sessionID?: string): string | undefined {
  if (sessionID !== undefined || existsSync(workflowPath(worktree))) return sessionID
  let names: string[]
  try { names = readdirSync(join(stateRoot(worktree), "sessions")) } catch { return undefined }
  const candidates = names.filter(sid => /^[A-Za-z0-9_-]{1,128}$/u.test(sid) && readCommitted(worktree, {}, sid).state === "ok")
  if (candidates.length > 1) throw new Error("fixture requires explicit session ID for multiple committed sessions")
  return candidates[0]
}
