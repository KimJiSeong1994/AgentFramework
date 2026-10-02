// Workflow operations shared by hooks and tools. Each operation: read -> authorize -> pure transition -> ordered
// writes (ledger first, then workflow.json, then events) -> side effects returned to the caller. Nothing here
// talks to the model; prompts and toasts are issued by the callers.
import { EMPTY_MODE, readModeState, sessionDir, writeModeState } from "../state/store.ts"
import { approvePlanTasks, cancelOpen, readLedger, tasksForWorkflow, type LedgerTask, type TaskInput, type Ledger, writeLedger, OPEN_STATUSES } from "../state/ledger.ts"
import { existsSync } from "node:fs"
import type { HookDeps } from "../hooks/types.ts"
import { transition, type FlowEvent, type TransitionCtx, type Limits, DEFAULT_LIMITS, TERMINAL } from "./machine.ts"
import {
  activeWorkflow, appendEvents, coreOf, newWorkflow, readWorkflow, rotate, withCore, writeWorkflow,
  type EventActor, type Workflow,
} from "./state.ts"
import { authorize, currentOwner, defaultLiveness, ownerLive, startHeartbeat, takeOver, type Command, type Heartbeat, type LivenessCtx } from "./owner.ts"

export type FlowResult = { ok: true; wf: Workflow; toast?: string; note?: string } | { ok: false; text: string; wf?: Workflow | null }

export function flowLimits(deps: HookDeps): Limits {
  const f = deps.config.flow
  return { max_code_invalid: f.max_code_invalid, max_review_iterations: f.max_review_iterations, nudge_max: f.nudge_max }
}

export function sessionExists(deps: HookDeps): (id: string) => boolean {
  return (id: string) => existsSync(sessionDir(deps.worktree, id))
}

export function liveness(deps: HookDeps, now = Date.now()): LivenessCtx {
  return defaultLiveness(sessionExists(deps), now)
}

export type TaskTally = { open: number; failedOrCancelled: number; total: number }

export function tally(tasks: LedgerTask[]): TaskTally {
  return {
    open: tasks.filter((t) => OPEN_STATUSES.has(t.status)).length,
    failedOrCancelled: tasks.filter((t) => t.status === "failed" || t.status === "cancelled").length,
    total: tasks.length,
  }
}

// ---------------------------------------------------------------- heartbeat (one per instance)
let beat: Heartbeat | null = null
let beatWorktree: string | null = null

/** Keep the owner heartbeat of this instance's workflow fresh; stops by itself when the workflow ends or moves. */
export function ensureHeartbeat(deps: HookDeps): void {
  if (beat && beatWorktree === deps.worktree) return
  beat?.stop()
  beatWorktree = deps.worktree
  beat = startHeartbeat(() => {
    const wf = readWorkflow(deps.worktree)
    if (!wf || TERMINAL.has(wf.phase) || wf.owner.pid !== process.pid) {
      beat = null
      beatWorktree = null
      return false
    }
    writeWorkflow(deps.worktree, { ...wf, owner: { ...wf.owner, heartbeatAt: Date.now() } })
    return true
  }, undefined, (e) => deps.log("flow heartbeat write failed; retrying", { error: (e as Error)?.message ?? String(e) }))
}

/** Test hook: stop the timer. */
export function stopHeartbeat(): void {
  beat?.stop()
  beat = null
  beatWorktree = null
}

// ---------------------------------------------------------------- transitions
/** Apply one machine event to `wf` and persist it (workflow first, then events). */
export function applyEvent(
  deps: HookDeps,
  wf: Workflow,
  event: FlowEvent,
  actor: EventActor,
  ctx: TransitionCtx = {},
  patch: (wf: Workflow) => Workflow = (w) => w,
  data?: Record<string, unknown>,
  now = Date.now(),
): FlowResult {
  // Compare-and-swap: the caller's record may be stale (e.g. lca_flow awaited a review for minutes while a /cancel
  // or a new /plan ran). Refuse without writing when the persisted workflow is a different one, has new events, or
  // a different phase. The transition applies to the fresh record, so a refreshed owner heartbeat is never rolled
  // back.
  const fresh = readWorkflow(deps.worktree)
  if (!fresh || fresh.id !== wf.id || fresh.lastSeq !== wf.lastSeq || fresh.phase !== wf.phase) {
    return { ok: false, text: "workflow changed meanwhile; stop and check /status", wf: fresh }
  }
  const base: Workflow = { ...wf, owner: fresh.owner }
  const r = transition(coreOf(base), event, { limits: flowLimits(deps), ...ctx })
  if ("error" in r) return { ok: false, text: r.error, wf }
  let next = patch(withCore(base, r.core))
  const typed = typedEvent(event)
  const events = [
    { wf: wf.id, type: "transition", from: phaseLabel(wf), to: phaseLabel(next), actor, data: { event, row: r.row, ...(data ?? {}) } },
    ...(typed ? [{ wf: wf.id, type: typed, actor, data }] : []),
  ]
  next = { ...next, lastSeq: wf.lastSeq, owner: patchOwner(next.owner, fresh.owner) }
  next = writeWorkflow(deps.worktree, next, now)
  const seq = appendEvents(deps.worktree, events, now)
  next = writeWorkflow(deps.worktree, { ...next, lastSeq: seq }, now)
  return { ok: true, wf: next, toast: r.toast }
}

/** Keep the fresher heartbeat unless the patch deliberately set a new owner (takeover). */
function patchOwner(patched: Workflow["owner"], fresh: Workflow["owner"]): Workflow["owner"] {
  if (patched.instance !== fresh.instance || patched.pid !== fresh.pid) return patched
  return patched.heartbeatAt >= fresh.heartbeatAt ? patched : fresh
}

function typedEvent(e: FlowEvent): string | null {
  switch (e) {
    case "approve": return "approved"
    case "reject": return "rejected"
    case "nudge": return "nudge"
    case "cancel": return "cancelled"
    case "owner_dead": return "owner_conflict"
    case "submit_valid": return "plan_submitted"
    case "submit_invalid": return "plan_rejected_by_code"
    default: return null
  }
}

function phaseLabel(wf: Workflow): string {
  return wf.stuckCause ? `${wf.phase}(${wf.stuckCause})` : wf.phase
}

function event(deps: HookDeps, wf: Workflow, type: string, actor: EventActor, data?: Record<string, unknown>): Workflow {
  const seq = appendEvents(deps.worktree, [{ wf: wf.id, type, actor, data }])
  return writeWorkflow(deps.worktree, { ...wf, lastSeq: seq })
}

/** §5.3 owning-session takeover: owner rewritten, heartbeat started, owner_takeover emitted; phase unchanged. */
export function applyTakeover(deps: HookDeps, wf: Workflow, now = Date.now()): Workflow {
  const prev = wf.owner
  const next = event(deps, writeWorkflow(deps.worktree, takeOver(wf, now), now), "owner_takeover", "code", {
    fromInstance: prev.instance, fromPid: prev.pid,
  })
  ensureHeartbeat(deps)
  return next
}

/**
 * Resolve authority for a command. Returns the workflow to act on (after takeover), or a refusal, or
 * `{ wf: null }` when there is no active workflow. T20 (foreign session, dead owner) is applied here for /plan.
 */
export function resolveAuthority(
  deps: HookDeps,
  cmd: Command,
  sessionID: string,
  now = Date.now(),
): { wf: Workflow | null; refuse?: string; replaced?: string; ownerDead?: boolean } {
  const wf = activeWorkflow(deps.worktree)
  const a = authorize(cmd, sessionID, wf, liveness(deps, now))
  switch (a.kind) {
    case "none": return { wf: null }
    case "allow": return { wf, ownerDead: wf ? wf.sessionID !== sessionID && !liveOwner(deps, wf, now) : false }
    case "takeover": return { wf: applyTakeover(deps, wf!, now) }
    case "refuse": return { wf, refuse: a.text }
    case "foreign_dead_cancel": {
      const r = applyEvent(deps, wf!, "owner_dead", "code", {}, (w) => w, { bySession: sessionID }, now)
      if (!r.ok) return { wf, refuse: r.text }
      cancelTaggedIdle(deps, r.wf)
      return { wf: null, replaced: wf!.id }
    }
  }
}

function liveOwner(deps: HookDeps, wf: Workflow, now: number): boolean {
  return authorize("status", wf.sessionID, wf, liveness(deps, now)).kind === "allow"
}

/** Cancel open tasks tagged with this workflow when no queue runs (T18/T19/T20 side effect). */
export function cancelTaggedIdle(deps: HookDeps, wf: Workflow, reason = `plan workflow ${wf.id} cancelled`): string[] {
  const ledger = readLedger(deps.worktree, wf.sessionID)
  const ids = new Set(tasksForWorkflow(ledger, wf.id).filter((t) => OPEN_STATUSES.has(t.status)).map((t) => t.id))
  if (ids.size === 0) return []
  const now = Date.now()
  const tasks = ledger.tasks.map((t) => (ids.has(t.id) ? { ...t, status: "cancelled" as const, error: reason, finishedAt: now } : t))
  writeLedger(deps.worktree, { ...ledger, tasks, running: undefined })
  return [...ids]
}

/**
 * T1: start a plan workflow for `sessionID`. The caller has resolved authority first (no active workflow, or T20
 * applied). A stuck workflow of the same session is cancelled first (T18 then T1). Rotation archives a terminal one.
 */
export function startWorkflow(deps: HookDeps, sessionID: string, entry: Workflow["entry"], request: string, actor: EventActor, now = Date.now()): FlowResult {
  const cur = activeWorkflow(deps.worktree)
  if (cur) {
    if (cur.sessionID === sessionID && cur.phase === "stuck") {
      const c = applyEvent(deps, cur, "cancel", actor, { queueRunning: false }, (w) => w, { reason: "restart" }, now)
      if (!c.ok) return c
      cancelTaggedIdle(deps, c.wf)
    } else {
      return { ok: false, text: `plan workflow ${cur.id} is already active; use /status or /cancel`, wf: cur }
    }
  }
  rotate(deps.worktree)
  // §5.6: a running legacy mode stops appending its suffix once the workflow starts.
  const mode = readModeState(deps.worktree, sessionID)
  if (mode.active) writeModeState(deps.worktree, sessionID, { ...EMPTY_MODE, stopReason: "workflow_started" })
  let wf = newWorkflow(sessionID, currentOwner(now), entry, request, now)
  wf = writeWorkflow(deps.worktree, wf, now)
  const seq = appendEvents(deps.worktree, [
    { wf: wf.id, type: "created", actor, data: { entry, chars: request.length } },
    { wf: wf.id, type: "transition", to: "planning", actor, data: { event: "start", row: "T1" } },
  ], now)
  wf = writeWorkflow(deps.worktree, { ...wf, lastSeq: seq }, now)
  ensureHeartbeat(deps)
  return { ok: true, wf }
}

/**
 * T9 with the §5.5 write order: (1) one ledger write (foreign open tasks cancelled, tagged tasks appended, ids
 * marked offered) — skipped when tasks for this planSha already exist; (2) workflow -> executing; (3) events.
 */
export function approveWorkflow(
  deps: HookDeps,
  wf: Workflow,
  inputs: TaskInput[],
  opts: { queueRunning: boolean; planShaOk: boolean; mdShaOk: boolean },
  now = Date.now(),
): FlowResult {
  if (wf.phase !== "pending_approval") return { ok: false, text: "no plan awaiting approval", wf }
  if (opts.queueRunning) return { ok: false, text: "a task queue is running; wait or /stop", wf }
  if (!opts.planShaOk || !wf.planRef) return { ok: false, text: "the saved plan does not match; /plan again", wf }
  if (!opts.mdShaOk) return { ok: false, text: "plan file edited; /plan again or revert", wf }
  const tag = { id: wf.id, planSha: wf.planRef.jsonSha }
  const ledger = readLedger(deps.worktree, wf.sessionID)
  const r = approvePlanTasks(ledger, inputs, tag, now)
  const written: Ledger = r.added.length > 0 ? writeLedger(deps.worktree, r.ledger) : ledger
  const taskIds = tasksForWorkflow(written, wf.id).filter((t) => t.wf?.planSha === tag.planSha).map((t) => t.id)
  const res = applyEvent(
    deps, wf, "approve", "user_command", {},
    (w) => ({ ...w, taskIds, approval: { by: "user_command", planSha: tag.planSha, at: now } }),
    { tasks: taskIds.length, cancelledForeign: r.cancelledForeign },
    now,
  )
  if (!res.ok) return res
  const next = event(deps, res.wf, "tasks_created", "code", { ids: taskIds })
  return { ok: true, wf: next }
}

/**
 * Settle (T15/T16 and the T18 pendingCancel completion) from the ledger tags. Runs at delegate return, session.idle
 * and plugin load. `queueRunning` keeps a pending cancel open while the queue still winds down.
 */
export function settle(deps: HookDeps, wf: Workflow, queueRunning: boolean, now = Date.now()): FlowResult | null {
  if (wf.phase !== "executing" && !(wf.pendingCancel && !TERMINAL.has(wf.phase))) return null
  const ledger = readLedger(deps.worktree, wf.sessionID)
  const tasks = tasksForWorkflow(ledger, wf.id)
  const t = tally(tasks)
  if (wf.pendingCancel) {
    if (queueRunning) return null
    cancelTaggedIdle(deps, wf)
    return applyEvent(deps, wf, "cancel_settled", "code", { queueRunning: false }, (w) => w, undefined, now)
  }
  if (t.open > 0 || t.total === 0) return null
  const stopped = tasks.some((x) => x.status === "cancelled" && /user_stop/.test(x.error ?? ""))
  if (stopped) return applyEvent(deps, wf, "user_stop", "code", {}, (w) => w, undefined, now)
  return t.failedOrCancelled > 0
    ? applyEvent(deps, wf, "settle_fail", "code", { tasks: t }, (w) => w, { tally: t }, now)
    : applyEvent(deps, wf, "settle_ok", "code", { tasks: t }, (w) => w, { tally: t }, now)
}

/** T18 cancel mirroring /stop. `abort` is called when the queue runs (the cancel completes at settle). */
export function cancelWorkflow(deps: HookDeps, wf: Workflow, queueRunning: boolean, abort: () => void, actor: EventActor = "user_command"): FlowResult {
  const r = applyEvent(deps, wf, "cancel", actor, { queueRunning })
  if (!r.ok) return r
  if (queueRunning) abort()
  else cancelTaggedIdle(deps, r.wf)
  return r
}

/** T19: the owning session was deleted (runs before the session dir is removed). */
export function onSessionDeleted(deps: HookDeps, sessionID: string, queueRunning: boolean, abort: () => void): FlowResult | null {
  const wf = activeWorkflow(deps.worktree)
  if (!wf || wf.sessionID !== sessionID) return null
  if (queueRunning) abort()
  const r = applyEvent(deps, wf, "session_deleted", "code")
  if (r.ok && !queueRunning) cancelTaggedIdle(deps, r.wf)
  return r
}

/**
 * Plugin-load repair, authority-free only (§5.2/§5.3, ARCH-14): T8 for an orphaned `reviewing`, finishing an
 * interrupted approve (tagged tasks exist but phase still pending_approval), settle. Never T20, never takeover.
 */
export function repairOnLoad(deps: HookDeps, isQueueRunning: (sessionID: string) => boolean = () => false): FlowResult | null {
  const wf = activeWorkflow(deps.worktree)
  if (!wf) return null
  // Another live instance owns it (a second opencode process on the same repo): its review or queue may be in
  // flight, so load-time repair must not touch it. Authority-free repair is only for dead or own owners.
  const ctx = liveness(deps)
  if (wf.owner.instance !== ctx.instance && ownerLive(wf, ctx)) return null
  if (wf.phase === "reviewing") return applyEvent(deps, wf, "review_aborted", "code", {}, (w) => ({ ...w, review: { verdict: "none", findings: [], planSha: w.planRef?.jsonSha ?? "", note: "aborted" } }), { repair: true })
  if (wf.phase === "pending_approval" && wf.planRef) {
    const ledger = readLedger(deps.worktree, wf.sessionID)
    const ids = tasksForWorkflow(ledger, wf.id).filter((t) => t.wf?.planSha === wf.planRef!.jsonSha).map((t) => t.id)
    if (ids.length > 0) {
      const r = applyEvent(deps, wf, "approve", "code", {}, (w) => ({ ...w, taskIds: ids, approval: w.approval ?? { by: "user_command", planSha: wf.planRef!.jsonSha, at: Date.now() } }), { repair: true })
      if (r.ok) return { ok: true, wf: event(deps, r.wf, "tasks_created", "code", { ids, repair: true }) }
      return r
    }
    return null
  }
  return settle(deps, wf, isQueueRunning(wf.sessionID))
}

export { cancelOpen, DEFAULT_LIMITS }
