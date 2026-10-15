// Workflow authority (ralplan §5.3). Authority key = wf.sessionID; owner = the plugin instance that last acted for
// that session. Liveness = the pid exists AND (same instance OR heartbeat < 90 s). The owning instance refreshes the
// heartbeat every 30 s while its workflow is non-terminal, so long queue runs stay live.
import { randomBytes } from "node:crypto"
import type { Owner } from "./state.ts"
import type { WorkflowEnvelope as Workflow } from "../workflows/types.ts"
import { inspectSessionAttachment } from "../sessions/store.ts"

export const HEARTBEAT_MS = 30_000
export const STALE_MS = 90_000

/** One id per plugin instance (module load). */
export const INSTANCE_ID = `inst_${process.pid}_${randomBytes(3).toString("hex")}`

/**
 * Owner identity {instance(epoch), pid}. The optional `heartbeatAt` is a caller-side liveness hint only: it is
 * never stored in the committed envelope (the heartbeat lives in the non-authoritative sidecar).
 */
export function currentOwner(now = Date.now(), instance = INSTANCE_ID, pid = process.pid): Owner & { heartbeatAt: number } {
  return { instance, pid, heartbeatAt: now }
}

/** Only attachment epochs can support a held-owner rebind receipt. */
export function isAttachmentEpoch(instance: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instance)
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

export type LivenessCtx = {
  now: number
  instance: string
  pidAlive: (pid: number) => boolean
  /** True when the owner epoch's attachment lifecycle record says it was released (a released epoch owns nothing). */
  epochReleased: (wf: Workflow) => boolean
  /** Display-only heartbeat for this owner binding (sidecar); absent means "use the committed update time". */
  heartbeatAt?: (wf: Workflow) => number | undefined
}

/** The persisted owner epoch's attachment lifecycle; unreadable or non-attachment epochs are not "released". */
export function epochReleased(worktree: string): (wf: Workflow) => boolean {
  return (wf: Workflow) => {
    if (!isAttachmentEpoch(wf.owner.instance)) return false
    try { return inspectSessionAttachment(worktree, wf.sessionID, wf.owner.instance)?.state === "released" }
    catch { return false }
  }
}

export function defaultLiveness(epochReleased: (wf: Workflow) => boolean, now = Date.now(), heartbeatAt?: LivenessCtx["heartbeatAt"]): LivenessCtx {
  return { now, instance: INSTANCE_ID, pidAlive, epochReleased, ...(heartbeatAt ? { heartbeatAt } : {}) }
}

/** Last liveness evidence for the owner binding: the matching sidecar beat, else the last committed update. */
export function heartbeatOf(wf: Workflow, ctx: Pick<LivenessCtx, "heartbeatAt">): number {
  return ctx.heartbeatAt?.(wf) ?? wf.updatedAt
}

/** Display/status liveness only. Fences, authorization of mutation and takeover never consult the heartbeat. */
export function ownerLive(wf: Workflow, ctx: LivenessCtx): boolean {
  if (ctx.epochReleased(wf)) return false
  if (!ctx.pidAlive(wf.owner.pid)) return false
  if (wf.owner.instance === ctx.instance) return true
  return ctx.now - heartbeatOf(wf, ctx) < STALE_MS
}

export type Command = "status" | "plan" | "approve" | "reject" | "cancel"

export type Authority =
  | { kind: "allow" }
  | { kind: "refuse"; text: string }
  | { kind: "none" }

/**
 * Mutation authority is the persisted workflow sid plus the caller's current attachment epoch (`ctx.instance`).
 * PID liveness and heartbeat age never grant it, and a different epoch of the same sid must first pass the S6.2a
 * reattachment commit; a foreign sid never mutates. Liveness only selects the refusal wording.
 */
export function authorize(cmd: Command, sessionID: string, wf: Workflow | null, ctx: LivenessCtx): Authority {
  if (!wf) return { kind: "none" }
  if (cmd === "status") return { kind: "allow" }
  if (wf.sessionID === sessionID && wf.owner.instance === ctx.instance) return { kind: "allow" }
  const state = ownerLive(wf, ctx) ? "already active in" : "owned by"
  return { kind: "refuse", text: `plan workflow ${wf.id} is ${state} session ${wf.sessionID}; use /resume ${wf.sessionID} to continue` }
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
