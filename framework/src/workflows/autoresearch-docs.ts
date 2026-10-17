// Readable autoresearch artifacts: `<worktree>/.otter/workflows/<sid>/<wid>/<key>` as hash-recorded, worktree-relative refs.
import { join } from "node:path"
import { durableWriteBytes } from "../state/durable.ts"
import { sha256, workflowArtifactDirectory } from "./artifacts.ts"
import type { ArtifactRef } from "./types.ts"

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

/**
 * Write a document once. An identical document that is already committed is accepted (an identical approved experiment
 * re-runs against its existing documents); a different one under the same key is refused, never overwritten.
 */
export function writeDoc(worktree: string, wf: { sessionID: string; id: string; artifacts: readonly ArtifactRef[] }, key: string, text: string): ArtifactRef & { sha256: string } {
  if (!KEY_RE.test(key) || key.includes("..")) throw new TypeError("invalid artifact key")
  const bytes = Buffer.from(text, "utf8")
  const digest = sha256(bytes)
  const existing = wf.artifacts.find(ref => ref.key === key)
  if (existing) {
    if (existing.sha256 !== digest) throw new Error(`artifact ${key} is already committed with other bytes; refusing overwrite`)
    return { key, path: existing.path, sha256: digest }
  }
  durableWriteBytes(join(workflowArtifactDirectory(worktree, wf.sessionID, wf.id), key), bytes)
  return { key, path: join(".otter", "workflows", wf.sessionID, wf.id, key), sha256: digest }
}
