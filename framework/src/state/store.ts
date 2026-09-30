// Control-plane state store: single writer (this plugin), atomic writes.
//
// Location: OUTSIDE the worktree, under $XDG_STATE_HOME/lca/<sha1(worktree)[:12]>/ (default ~/.local/state/lca/...).
// Stage 2 review (security M3/M5): a ledger inside the worktree could be edited by a worker (bash/edit allowed
// inside the worktree) to schedule a `verify` command that the framework would later run outside any transcript,
// and other repositories would commit .lca/state by accident. Handoffs (data plane, human-readable) stay in the
// worktree under .lca/handoffs (see ledger.ts). The e2e script isolates this via XDG_STATE_HOME.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type { Mode } from "../config.ts"

function canonical(p: string): string {
  const abs = resolve(p)
  let base = abs
  let rest = ""
  for (;;) {
    try {
      const real = realpathSync.native(base)
      return rest ? join(real, rest) : real
    } catch {
      const parent = dirname(base)
      if (parent === base) return abs
      rest = rest ? join(basename(base), rest) : basename(base)
      base = parent
    }
  }
}

/** Base directory for all control-plane state. An override that points INSIDE the worktree is ignored (it would let a worker edit the ledger again). */
export function stateBase(worktree?: string): string {
  const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  const fallback = join(xdg, "lca")
  const override = process.env.LCA_STATE_HOME
  if (!override) return fallback
  if (worktree) {
    const root = canonical(worktree)
    const o = canonical(override)
    if (o === root || o.startsWith(root.endsWith("/") ? root : root + "/")) return fallback
  }
  return resolve(override)
}

export function worktreeKey(worktree: string): string {
  return createHash("sha1").update(canonical(worktree)).digest("hex").slice(0, 12)
}

export function stateRoot(worktree: string): string {
  return join(stateBase(worktree), worktreeKey(worktree))
}

export function sessionDir(worktree: string, sessionID: string): string {
  return join(stateRoot(worktree), "sessions", sessionID)
}

export type ReadJsonResult<T> = { value: T; corrupt?: string }

/** Parse a JSON file; a missing file gives the fallback, a corrupt one is moved aside (never silently overwritten). */
export function readJsonChecked<T>(path: string, fallback: T): ReadJsonResult<T> {
  if (!existsSync(path)) return { value: fallback }
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) as T }
  } catch {
    const moved = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, moved)
      return { value: fallback, corrupt: moved }
    } catch {
      return { value: fallback, corrupt: `${path} (unreadable, could not be moved aside)` }
    }
  }
}

export function readJson<T>(path: string, fallback: T): T {
  return readJsonChecked(path, fallback).value
}

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n")
  renameSync(tmp, path)
}

export function removeSessionDir(worktree: string, sessionID: string): void {
  rmSync(sessionDir(worktree, sessionID), { recursive: true, force: true })
}

export type ModeState = {
  mode: Mode
  active: boolean
  startedAt: number
  updatedAt: number
  iterations: number
  stagnation: number
  failures: number
  lastFingerprint?: string
  lastCompactedAt?: number
  /** why the loop stopped, if it did */
  stopReason?: string
}

export const EMPTY_MODE: ModeState = {
  mode: "none",
  active: false,
  startedAt: 0,
  updatedAt: 0,
  iterations: 0,
  stagnation: 0,
  failures: 0,
}

export type AbortMarker = { reason: string; at: number; [k: string]: unknown }

/** Presence of this file stops the idle loop and the task queue (written by /stop, repetition abort). */
export function abortPath(worktree: string, sessionID: string): string {
  return join(sessionDir(worktree, sessionID), "abort.json")
}

export function readAbort(worktree: string, sessionID: string): AbortMarker | null {
  return readJson<AbortMarker | null>(abortPath(worktree, sessionID), null)
}

/**
 * Remove a stale abort marker. A user's /stop (`user_stop`) is only cleared by a new user message (chat.message);
 * `delegate` must not clear it, otherwise a model reacting to the /stop text could restart the queue.
 */
export function clearAbort(worktree: string, sessionID: string, opts: { keepUserStop?: boolean } = {}): boolean {
  const p = abortPath(worktree, sessionID)
  if (!existsSync(p)) return false
  if (opts.keepUserStop && readAbort(worktree, sessionID)?.reason === "user_stop") return false
  rmSync(p, { force: true })
  return true
}

export function modeStatePath(worktree: string, sessionID: string): string {
  return join(sessionDir(worktree, sessionID), "mode.json")
}

export function readModeState(worktree: string, sessionID: string): ModeState {
  return readJson(modeStatePath(worktree, sessionID), EMPTY_MODE)
}

export function writeModeState(worktree: string, sessionID: string, state: ModeState): ModeState {
  const next = { ...state, updatedAt: Date.now() }
  writeJsonAtomic(modeStatePath(worktree, sessionID), next)
  return next
}

/** session -> agent map, kept because experimental.chat.system.transform does not pass the agent. */
export type SessionInfo = { agent?: string; model?: string; createdAt: number }

export function sessionInfoPath(worktree: string, sessionID: string): string {
  return join(sessionDir(worktree, sessionID), "session.json")
}

export function readSessionInfo(worktree: string, sessionID: string): SessionInfo | null {
  return readJson<SessionInfo | null>(sessionInfoPath(worktree, sessionID), null)
}
