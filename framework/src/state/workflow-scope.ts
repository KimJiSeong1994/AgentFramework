import { lstatSync } from "node:fs"
import { join } from "node:path"
import { readBoundedBytes, stateRoot } from "./store.ts"

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
    if (bytes) {
      const index: unknown = JSON.parse(bytes.toString("utf8"))
      if (index && typeof index === "object" && !Array.isArray(index) &&
          (index as Record<string, unknown>).sessionID === sessionID) return legacy
    }
  } catch { /* No validated matching legacy routing hint; the new session uses its own slot. */ }
  return scoped
}
