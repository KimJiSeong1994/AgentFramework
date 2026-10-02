// Workflow authority (ralplan §5.3). Authority key = wf.sessionID; owner = the plugin instance that last acted for
// that session. Liveness = the pid exists AND (same instance OR heartbeat < 90 s). The owning instance refreshes the
// heartbeat every 30 s while its workflow is non-terminal, so long queue runs stay live.
import { randomBytes } from "node:crypto"
import type { Owner, Workflow } from "./state.ts"

export const HEARTBEAT_MS = 30_000
export const STALE_MS = 90_000

/** One id per plugin instance (module load). */
export const INSTANCE_ID = `inst_${process.pid}_${randomBytes(3).toString("hex")}`

export function currentOwner(now = Date.now(), instance = INSTANCE_ID, pid = process.pid): Owner {
  return { instance, pid, heartbeatAt: now }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: exists but belongs to another user
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

export type LivenessCtx = { now: number; instance: string; pidAlive: (pid: number) => boolean; sessionExists: (id: string) => boolean }

export function defaultLiveness(sessionExists: (id: string) => boolean, now = Date.now()): LivenessCtx {
  return { now, instance: INSTANCE_ID, pidAlive, sessionExists }
}

export function ownerLive(wf: Workflow, ctx: LivenessCtx): boolean {
  if (!ctx.sessionExists(wf.sessionID)) return false
  if (!ctx.pidAlive(wf.owner.pid)) return false
  if (wf.owner.instance === ctx.instance) return true
  return ctx.now - wf.owner.heartbeatAt < STALE_MS
}

export type Command = "status" | "plan" | "approve" | "reject" | "cancel"

export type Authority =
  | { kind: "allow" }
  | { kind: "takeover" }
  | { kind: "refuse"; text: string }
  /** T20: another session starts a plan while the owner is dead or its session is gone */
  | { kind: "foreign_dead_cancel" }
  | { kind: "none" }

/**
 * §5.3 matrix. `wf` is the non-terminal workflow (or null). Only the owning session ever takes over; another
 * session never mutates a live or dead owner's workflow except via T20 on its own /plan (or plan keyword).
 */
export function authorize(cmd: Command, sessionID: string, wf: Workflow | null, ctx: LivenessCtx): Authority {
  if (!wf) return { kind: "none" }
  const owning = wf.sessionID === sessionID
  const live = ownerLive(wf, ctx)
  if (owning) return live ? { kind: "allow" } : { kind: "takeover" }
  if (cmd === "status") return { kind: "allow" }
  if (cmd === "plan") {
    if (live) return { kind: "refuse", text: `plan workflow ${wf.id} is already active in session ${wf.sessionID}; use /status there or /cancel` }
    return { kind: "foreign_dead_cancel" }
  }
  return {
    kind: "refuse",
    text: live
      ? `plan workflow ${wf.id} is owned by session ${wf.sessionID}`
      : `plan workflow ${wf.id} is owned by session ${wf.sessionID}, owner dead; /plan from this session replaces it`,
  }
}

/** Rewrite the owner to this instance (takeover never changes the phase). */
export function takeOver(wf: Workflow, now = Date.now(), instance = INSTANCE_ID, pid = process.pid): Workflow {
  return { ...wf, owner: currentOwner(now, instance, pid) }
}

export type Heartbeat = { stop(): void }

/**
 * unref'd timer that refreshes the owner heartbeat while `tick` returns true. A throwing tick (e.g. a transient
 * write error) is reported and retried on the next interval; only `false` stops the timer, so one bad write cannot
 * silently let a live owner go stale.
 */
export function startHeartbeat(tick: () => boolean, interval = HEARTBEAT_MS, onError: (e: unknown) => void = () => {}): Heartbeat {
  const timer = setInterval(() => {
    let keep = true
    try {
      keep = tick()
    } catch (e) {
      onError(e)
    }
    if (!keep) clearInterval(timer)
  }, interval)
  ;(timer as { unref?: () => void }).unref?.()
  return { stop: () => clearInterval(timer) }
}
