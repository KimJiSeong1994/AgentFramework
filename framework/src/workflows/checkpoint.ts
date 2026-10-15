// Residual stop checkpoints (P5b D3). Two write-once files per stop token under
// `sessions/<sid>/workflows/<wid>/checkpoints/`: `<token>-request.json` (written with the stop intent) and
// `<token>-settled.json` (written with the proof). They are never deleted. `stopIntent.checkpoint` stores
// `"<state-relative path>#<sha256 of the file bytes>"`, so any later edit of the file is detected on Resume.
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { durableWriteBytes } from "../state/durable.ts"
import { readBoundedBytes, stateRoot } from "../state/store.ts"
import { OPEN_STATUSES, tasksForWorkflow, type Ledger } from "../state/ledger.ts"
import { sha256, readArtifactBytes } from "./artifacts.ts"
import type { Subject } from "./types.ts"

export type CheckpointWorktree = { head: string | null; statusSha: string | null }

export type RequestCheckpoint = {
  version: 1
  kind: "request"
  wid: string
  token: string
  revision: number
  requestedFrom: { phase: string; stage: string }
  subject: Subject | null
  plan: { jsonSha: string; mdPath: string; mdSha: string } | null
  done: string[]
  residual: string[]
}

export type SettledCheckpoint = {
  version: 1
  kind: "settled"
  wid: string
  token: string
  subject: Subject | null
  plan: { jsonSha: string; mdPath: string; mdSha: string } | null
  done: string[]
  residual: string[]
  interrupted: Array<{ id: string; cause: string }>
  worktree: CheckpointWorktree
}

export type Checkpoint = RequestCheckpoint | SettledCheckpoint

export function checkpointRelativePath(sessionID: string, workflowID: string, token: string, kind: Checkpoint["kind"]): string {
  return `sessions/${sessionID}/workflows/${workflowID}/checkpoints/${token}-${kind}.json`
}

/** Done and residual task ids for this workflow's current subject. Tasks tagged for another subject are not ours. */
export function taskPartition(ledger: Ledger, workflowID: string, subjectSha: string | null): { done: string[]; residual: string[]; interrupted: Array<{ id: string; cause: string }> } {
  const tagged = tasksForWorkflow(ledger, workflowID).filter(task => subjectSha === null || task.wf?.planSha === subjectSha)
  return {
    done: tagged.filter(task => task.status === "done").map(task => task.id),
    residual: tagged.filter(task => OPEN_STATUSES.has(task.status)).map(task => task.id),
    interrupted: tagged.filter(task => OPEN_STATUSES.has(task.status) && task.error?.startsWith("paused: ")).map(task => ({ id: task.id, cause: task.error!.slice("paused: ".length) })),
  }
}

/** HEAD plus a hash of the porcelain status; display evidence only, never authority. */
export function worktreeDigest(worktree: string): CheckpointWorktree {
  const git = (args: string[]): string | null => {
    try { return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }) }
    catch { return null }
  }
  const head = git(["rev-parse", "HEAD"])
  const status = git(["status", "--porcelain"])
  return { head: head === null ? null : head.trim(), statusSha: status === null ? null : sha256(status) }
}

/** Write-once: an existing file for this token is immutable and its reference is reused. */
export function writeCheckpoint(worktree: string, sessionID: string, token: string, value: Checkpoint): string {
  const relative = checkpointRelativePath(sessionID, value.wid, token, value.kind)
  const path = join(stateRoot(worktree), relative)
  if (existsSync(path)) {
    const bytes = readBoundedBytes(path, 1024 * 1024).bytes
    if (!bytes) throw new Error("existing stop checkpoint is unreadable")
    return `${relative}#${sha256(bytes)}`
  }
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8")
  durableWriteBytes(path, bytes, undefined, { createParents: true })
  return `${relative}#${sha256(bytes)}`
}

export type CheckpointRead = { ok: true; value: Checkpoint } | { ok: false; reason: string }

/** Verify the file bytes against the recorded hash and the identity of the workflow and token. */
export function readCheckpoint(worktree: string, sessionID: string, workflowID: string, token: string, ref: string | null): CheckpointRead {
  if (!ref) return { ok: false, reason: "no checkpoint recorded" }
  const at = ref.lastIndexOf("#")
  if (at < 1) return { ok: false, reason: "checkpoint reference is malformed" }
  const relative = ref.slice(0, at)
  const expected = ref.slice(at + 1)
  const kind = relative.endsWith("-settled.json") ? "settled" : "request"
  if (relative !== checkpointRelativePath(sessionID, workflowID, token, kind)) return { ok: false, reason: "checkpoint path does not belong to this stop" }
  const read = readArtifactBytes(join(stateRoot(worktree), relative))
  if (!read.ok) return { ok: false, reason: `checkpoint ${read.reason}` }
  if (sha256(read.bytes) !== expected) return { ok: false, reason: "checkpoint bytes changed" }
  try {
    const value = JSON.parse(read.bytes.toString("utf8")) as Checkpoint
    if (value?.version !== 1 || value.wid !== workflowID || value.token !== token || value.kind !== kind) return { ok: false, reason: "checkpoint identity mismatch" }
    return { ok: true, value }
  } catch { return { ok: false, reason: "checkpoint is not valid JSON" } }
}
