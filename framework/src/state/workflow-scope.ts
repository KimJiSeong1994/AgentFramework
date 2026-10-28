import { lstatSync } from "node:fs"
import { join } from "node:path"
import { readBoundedBytes, stateRoot } from "./store.ts"
import { parseIndex } from "../workflows/commit.ts"
import { ID_RE } from "../workflows/types.ts"

/** Explicit routing only; session ownership and execution admission remain separate checks. */
export function workflowDirectory(worktree: string, sessionID?: string): string {
  const legacy = join(stateRoot(worktree), "workflow")
  if (sessionID === undefined) return legacy
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionID)) throw new TypeError("invalid workflow session ID")
  const scoped = join(stateRoot(worktree), "sessions", sessionID, "workflow")
  try {
    lstatSync(scoped)
    // An existing but invalid scoped directory never falls back to another authority location.
    return scoped
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return scoped
  }
  // Keep an existing legacy session at its original commit point. New sessions get their own slot.
  try {
    const bytes = readBoundedBytes(join(legacy, "workflow.json"), 64 * 1024).bytes
    if (bytes !== undefined) {
      const index: unknown = JSON.parse(bytes.toString("utf8"))
      if (!index || typeof index !== "object" || Array.isArray(index)) return legacy
      const hint = index as Record<string, unknown>
      if (typeof hint.sessionID !== "string" || !ID_RE.test(hint.sessionID)) return legacy
      // Only a recognized index can establish that the legacy slot belongs elsewhere.
      if (hint.version !== 1) parseIndex(index)
      if (hint.sessionID === sessionID) return legacy
    }
  } catch {
    // Preserve the ambiguous authority location so checked readers report its corruption.
    // Treating a failed read as absence would allow a second workflow for its old session.
    return legacy
  }
  return scoped
}
