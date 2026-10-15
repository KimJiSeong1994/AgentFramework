import { realpathSync, statSync } from "node:fs"
import { resolve } from "node:path"

type ActivitySet = Set<AbortController>

const activities = new Map<string, ActivitySet>()
const controllerOwners = new WeakMap<AbortController, string>()

export type SkillPermissionActivityOwner = Readonly<{ sessionID: string; epoch: string; count: number }>

function sessionKey(worktree: string, sessionID: string, epoch: string): string {
  if (typeof worktree !== "string" || worktree.length === 0 || worktree.includes("\0")) {
    throw new TypeError("invalid permission activity worktree")
  }
  if (typeof sessionID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionID)) {
    throw new TypeError("invalid permission activity session ID")
  }
  if (typeof epoch !== "string" || epoch.length === 0 || epoch.length > 256 || /[\u0000-\u001f\u007f]/u.test(epoch)) {
    throw new TypeError("invalid permission activity epoch")
  }
  const canonical = realpathSync.native(resolve(worktree))
  if (!statSync(canonical).isDirectory()) throw new TypeError("permission activity worktree is not a directory")
  return `${canonical}\0${sessionID}\0${epoch}`
}

function worktreeKey(worktree: string): string {
  if (typeof worktree !== "string" || worktree.length === 0 || worktree.includes("\0")) {
    throw new TypeError("invalid permission activity worktree")
  }
  const canonical = realpathSync.native(resolve(worktree))
  if (!statSync(canonical).isDirectory()) throw new TypeError("permission activity worktree is not a directory")
  return `${canonical}\0`
}

/** Register a pending permission wait as a blocker; registration never grants authority. */
export function registerSkillPermissionActivity(
  worktree: string,
  sessionID: string,
  epoch: string,
  controller: AbortController,
): () => void {
  const key = sessionKey(worktree, sessionID, epoch)
  if (!(controller instanceof AbortController) || controller.signal.aborted || controllerOwners.has(controller)) {
    throw new TypeError("permission activity requires one live, unregistered AbortController")
  }

  let set = activities.get(key)
  if (!set) {
    set = new Set()
    activities.set(key, set)
  }
  set.add(controller)
  controllerOwners.set(controller, key)

  let active = true
  return () => {
    if (!active) return
    active = false
    if (controllerOwners.get(controller) !== key) return
    controllerOwners.delete(controller)
    const current = activities.get(key)
    current?.delete(controller)
    if (current?.size === 0) activities.delete(key)
  }
}

/** Count waits for exactly this canonical worktree, session, and admission epoch. */
export function pendingSkillPermissionActivityCount(worktree: string, sessionID: string, epoch: string): number {
  return activities.get(sessionKey(worktree, sessionID, epoch))?.size ?? 0
}

/** Count every epoch for one session without exposing or changing its owners. */
export function pendingSkillPermissionActivityCountForSession(worktree: string, sessionID: string): number {
  if (typeof sessionID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionID)) {
    throw new TypeError("invalid permission activity session ID")
  }
  const prefix = `${worktreeKey(worktree)}${sessionID}\0`
  let count = 0
  for (const [key, set] of activities) if (key.startsWith(prefix)) count += set.size
  return count
}

/** Read-only coarse worktree evidence used by dispatch and lifecycle quiescence checks. */
export function firstSkillPermissionActivity(worktree: string): SkillPermissionActivityOwner | undefined {
  const prefix = worktreeKey(worktree)
  for (const [key, set] of activities) {
    if (!key.startsWith(prefix) || set.size === 0) continue
    const owner = key.slice(prefix.length)
    const separator = owner.indexOf("\0")
    if (separator < 1) continue
    return Object.freeze({ sessionID: owner.slice(0, separator), epoch: owner.slice(separator + 1), count: set.size })
  }
  return undefined
}

/** Abort only waits owned by this exact canonical worktree, session, and admission epoch. */
export function cancelSkillPermissionActivities(
  worktree: string,
  sessionID: string,
  epoch: string,
  reason: unknown = new Error("skill permission activity cancelled"),
): number {
  const set = activities.get(sessionKey(worktree, sessionID, epoch))
  if (!set) return 0
  let cancelled = 0
  for (const controller of [...set]) {
    if (controller.signal.aborted) continue
    controller.abort(reason)
    cancelled++
  }
  return cancelled
}
