// Workflow operations shared by hooks and tools. Each operation: read -> authorize -> pure transition -> ordered
// writes (ledger first, then workflow.json, then events) -> side effects returned to the caller. Nothing here
// talks to the model; prompts and toasts are issued by the callers.
import { EMPTY_MODE, readModeState, sessionDir, writeModeState } from "../state/store.ts"
import { approvePlanTasks, cancelOpen, readLedger, tasksForWorkflow, type LedgerTask, type TaskInput, type Ledger, writeLedger, OPEN_STATUSES } from "../state/ledger.ts"
import { existsSync } from "node:fs"
import type { FlowRuntime } from "../hosts/types.ts"
import { transition, type FlowEvent, type TransitionCtx, type Limits, DEFAULT_LIMITS, TERMINAL } from "./machine.ts"
import {
  appendEvents, assertFlowTxWorktree, CorruptWorkflowError, coreOf, newWorkflow, readWorkflowForWrite,
  rotate, withCore, withFlowTransaction, writeWorkflow,
  type EventActor, type FlowTx, type Workflow, workflowEngineRefusal, FlowTransactionBusyError,
} from "./state.ts"
import { authorize, currentOwner, defaultLiveness, INSTANCE_ID, ownerLive, startHeartbeat, takeOver, type Command, type Heartbeat, type LivenessCtx } from "./owner.ts"

export type FlowResult = { ok: true; wf: Workflow; toast?: string; note?: string } | { ok: false; text: string; wf?: Workflow | null }

export function flowLimits(deps: FlowRuntime): Limits {
  const f = deps.config.flow
  return { max_code_invalid: f.max_code_invalid, max_review_iterations: f.max_review_iterations, nudge_max: f.nudge_max }
}

export function sessionExists(deps: FlowRuntime): (id: string) => boolean {
  return (id: string) => existsSync(sessionDir(deps.worktree, id))
}

export function liveness(deps: FlowRuntime, now = Date.now()): LivenessCtx {
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
let beatEngine: unknown

/** Keep the owner heartbeat of this instance's workflow fresh; stops by itself when the workflow ends or moves. */
export function ensureHeartbeat(deps: FlowRuntime, engine: unknown): void {
  if (beat && beatWorktree === deps.worktree && beatEngine === engine) return
  beat?.stop()
  beatWorktree = deps.worktree
  beatEngine = engine
  const expectedEngine = engine
  beat = startHeartbeat(() => {
    try {
      const keep = withFlowTransaction(deps.worktree, (tx) => {
        assertFlowTxWorktree(tx, deps.worktree)
        const checked = readWorkflowForWrite(tx)
        if (checked.corrupt) return true
        const wf = checked.wf
        if (!wf || TERMINAL.has(wf.phase) || wf.owner.pid !== process.pid || wf.owner.instance !== INSTANCE_ID) return false
        if (workflowEngineRefusal(wf, expectedEngine)) return false
        writeWorkflow(tx, { ...wf, owner: { ...wf.owner, heartbeatAt: Date.now() } })
        return true
      })
      if (!keep) {
        beat = null
        beatWorktree = null
        beatEngine = undefined
      }
      return keep
    } catch (error) {
      if (error instanceof FlowTransactionBusyError) return true
      throw error
    }
  }, undefined, (e) => deps.log("flow heartbeat write failed; retrying", { error: (e as Error)?.message ?? String(e) }))
}

/** Test hook: stop the timer. */
export function stopHeartbeat(): void {
  beat?.stop()
  beat = null
  beatWorktree = null
  beatEngine = undefined
}

// ---------------------------------------------------------------- transitions
/** Apply one machine event to `wf` and persist it (workflow first, then events). */
export function applyEventIn(
  tx: FlowTx,
  deps: FlowRuntime,
  wf: Workflow,
  event: FlowEvent,
  actor: EventActor,
  ctx: TransitionCtx = {},
  patch: (wf: Workflow) => Workflow = (w) => w,
  data?: Record<string, unknown>,
  now = Date.now(),
): FlowResult {
  assertFlowTxWorktree(tx, deps.worktree)
  // Compare-and-swap: the caller's record may be stale (e.g. lca_flow awaited a review for minutes while a /cancel
  // or a new /plan ran). Refuse without writing when the persisted workflow is a different one, has new events, or
  // a different phase. The transition applies to the fresh record, so a refreshed owner heartbeat is never rolled
  // back.
  const checked = readWorkflowForWrite(tx)
  if (checked.corrupt) throw new CorruptWorkflowError(checked.corrupt)
  const fresh = checked.wf
  const engineRefusal = fresh ? workflowEngineRefusal(fresh, wf.engine) : undefined
  if (engineRefusal) return { ok: false, text: engineRefusal, wf: fresh }
  if (!fresh || fresh.id !== wf.id || fresh.lastSeq !== wf.lastSeq || fresh.phase !== wf.phase) {
    return { ok: false, text: "workflow changed meanwhile; stop and check /status", wf: fresh }
  }
  const base: Workflow = { ...wf, owner: fresh.owner }
  const r = transition(coreOf(base), event, { limits: flowLimits(deps), ...ctx })
  if ("error" in r) return { ok: false, text: r.error, wf }
  let next: Workflow = { ...patch(withCore(base, r.core)), engine: fresh.engine }
  const typed = typedEvent(event)
  const events = [
    { wf: wf.id, type: "transition", from: phaseLabel(wf), to: phaseLabel(next), actor, data: { event, row: r.row, ...(data ?? {}) } },
    ...(typed ? [{ wf: wf.id, type: typed, actor, data }] : []),
  ]
  next = { ...next, lastSeq: wf.lastSeq, owner: patchOwner(next.owner, fresh.owner) }
  next = writeWorkflow(tx, next, now)
  const seq = appendEvents(tx, events, now)
  next = writeWorkflow(tx, { ...next, lastSeq: seq }, now)
  return { ok: true, wf: next, toast: r.toast }
}

export function applyEvent(
  deps: FlowRuntime,
  wf: Workflow,
  event: FlowEvent,
  actor: EventActor,
  ctx: TransitionCtx = {},
  patch: (wf: Workflow) => Workflow = (w) => w,
  data?: Record<string, unknown>,
  now = Date.now(),
): FlowResult {
  return withFlowTransaction(deps.worktree, (tx) => applyEventIn(tx, deps, wf, event, actor, ctx, patch, data, now))
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

function readWorkflowIn(tx: FlowTx, deps: FlowRuntime): Workflow | null {
  assertFlowTxWorktree(tx, deps.worktree)
  const checked = readWorkflowForWrite(tx)
  if (checked.corrupt) throw new CorruptWorkflowError(checked.corrupt)
  return checked.wf
}

function activeWorkflowIn(tx: FlowTx, deps: FlowRuntime): Workflow | null {
  const wf = readWorkflowIn(tx, deps)
  return wf && !TERMINAL.has(wf.phase) ? wf : null
}

type WorkflowSnapshotCheck = { ok: true; fresh: Workflow } | { ok: false; fresh: Workflow | null; refusal: string }

function checkWorkflowSnapshotIn(tx: FlowTx, deps: FlowRuntime, wf: Workflow): WorkflowSnapshotCheck {
  const fresh = readWorkflowIn(tx, deps)
  if (!fresh) return { ok: false, fresh, refusal: "workflow changed meanwhile; stop and check /status" }
  const engineRefusal = workflowEngineRefusal(fresh, wf.engine)
  if (engineRefusal) return { ok: false, fresh, refusal: engineRefusal }
  if (fresh.id !== wf.id || fresh.lastSeq !== wf.lastSeq || fresh.phase !== wf.phase) {
    return { ok: false, fresh, refusal: "workflow changed meanwhile; stop and check /status" }
  }
  return { ok: true, fresh }
}

function refuseSnapshot(check: Extract<WorkflowSnapshotCheck, { ok: false }>): FlowResult {
  return { ok: false, text: check.refusal, wf: check.fresh }
}

function eventIn(tx: FlowTx, deps: FlowRuntime, wf: Workflow, type: string, actor: EventActor, data?: Record<string, unknown>, now = Date.now()): Workflow {
  const check = checkWorkflowSnapshotIn(tx, deps, wf)
  if (!check.ok) throw new Error(check.refusal)
  const seq = appendEvents(tx, [{ wf: check.fresh.id, type, actor, data }], now)
  return writeWorkflow(tx, { ...check.fresh, lastSeq: seq }, now)
}

/** §5.3 owning-session takeover, with heartbeat setup deferred until after transaction release. */
function applyTakeoverIn(tx: FlowTx, deps: FlowRuntime, wf: Workflow, now = Date.now()): Workflow {
  const check = checkWorkflowSnapshotIn(tx, deps, wf)
  if (!check.ok) throw new Error(check.refusal)
  const fresh = check.fresh
  const prev = fresh.owner
  const taken = writeWorkflow(tx, takeOver(fresh, now), now)
  return eventIn(tx, deps, taken, "owner_takeover", "code", { fromInstance: prev.instance, fromPid: prev.pid }, now)
}

export function applyTakeover(deps: FlowRuntime, wf: Workflow, now = Date.now()): Workflow {
  const next = withFlowTransaction(deps.worktree, (tx) => applyTakeoverIn(tx, deps, wf, now))
  ensureHeartbeat(deps, wf.engine)
  return next
}

/**
 * Resolve authority for a command. Returns the workflow to act on (after takeover), or a refusal, or
 * `{ wf: null }` when there is no active workflow. T20 (foreign session, dead owner) is applied under one lock.
 */
type AuthorityResult = { wf: Workflow | null; refuse?: string; replaced?: string; ownerDead?: boolean }
function resolveAuthorityIn(tx: FlowTx, deps: FlowRuntime, cmd: Command, sessionID: string, expectedEngine: string, now: number): { result: AuthorityResult; heartbeat: boolean } {
  const wf = activeWorkflowIn(tx, deps)
  const engineRefusal = wf ? workflowEngineRefusal(wf, expectedEngine) : undefined
  if (engineRefusal) return { result: { wf, refuse: engineRefusal }, heartbeat: false }
  const authority = authorize(cmd, sessionID, wf, liveness(deps, now))
  switch (authority.kind) {
    case "none": return { result: { wf: null }, heartbeat: false }
    case "allow": return { result: { wf, ownerDead: wf ? wf.sessionID !== sessionID && !liveOwner(deps, wf, now) : false }, heartbeat: false }
    case "takeover": return { result: { wf: applyTakeoverIn(tx, deps, wf!, now) }, heartbeat: true }
    case "refuse": return { result: { wf, refuse: authority.text }, heartbeat: false }
    case "foreign_dead_cancel": {
      const r = applyEventIn(tx, deps, wf!, "owner_dead", "code", {}, (w) => w, { bySession: sessionID }, now)
      if (!r.ok) return { result: { wf, refuse: r.text }, heartbeat: false }
      cancelTaggedIdleIn(tx, deps, r.wf)
      return { result: { wf: null, replaced: wf!.id }, heartbeat: false }
    }
  }
}

export function resolveAuthority(
  deps: FlowRuntime,
  cmd: Command,
  sessionID: string,
  engine: string,
  now = Date.now(),
): AuthorityResult {
  const outcome = withFlowTransaction(deps.worktree, (tx) => resolveAuthorityIn(tx, deps, cmd, sessionID, engine, now))
  if (outcome.heartbeat) ensureHeartbeat(deps, engine)
  return outcome.result
}

function liveOwner(deps: FlowRuntime, wf: Workflow, now: number): boolean {
  return authorize("status", wf.sessionID, wf, liveness(deps, now)).kind === "allow"
}

/** Cancel open tasks tagged with this workflow when no queue runs (T18/T19/T20 side effect). */
function cancelTaggedIdleIn(tx: FlowTx, deps: FlowRuntime, wf: Workflow, reason = `plan workflow ${wf.id} cancelled`): string[] {
  const check = checkWorkflowSnapshotIn(tx, deps, wf)
  if (!check.ok) throw new Error(check.refusal)
  const ledger = readLedger(deps.worktree, check.fresh.sessionID)
  const ids = new Set(tasksForWorkflow(ledger, check.fresh.id).filter((t) => OPEN_STATUSES.has(t.status)).map((t) => t.id))
  if (ids.size === 0) return []
  const now = Date.now()
  const tasks = ledger.tasks.map((t) => (ids.has(t.id) ? { ...t, status: "cancelled" as const, error: reason, finishedAt: now } : t))
  writeLedger(deps.worktree, { ...ledger, tasks, running: undefined })
  return [...ids]
}

export function cancelTaggedIdle(deps: FlowRuntime, wf: Workflow, reason = `plan workflow ${wf.id} cancelled`): string[] {
  return withFlowTransaction(deps.worktree, (tx) => cancelTaggedIdleIn(tx, deps, wf, reason))
}

/** T1 in one transaction: same-session stuck cancel, ledger cleanup, terminal rotation and creation. */
function startWorkflowIn(tx: FlowTx, deps: FlowRuntime, sessionID: string, entry: Workflow["entry"], request: string, actor: EventActor, engine: string, now: number): FlowResult {
  const existing = activeWorkflowIn(tx, deps)
  if (existing) {
    const refusal = workflowEngineRefusal(existing, engine)
    if (refusal) return { ok: false, text: refusal, wf: existing }
    if (existing.sessionID !== sessionID || existing.phase !== "stuck") {
      return { ok: false, text: `plan workflow ${existing.id} is already active; use /status or /cancel`, wf: existing }
    }
  }
  const created = newWorkflow(sessionID, currentOwner(now), entry, request, engine, now)
  if (existing) {
    const cancelled = applyEventIn(tx, deps, existing, "cancel", actor, { queueRunning: false }, (w) => w, { reason: "restart" }, now)
    if (!cancelled.ok) return cancelled
    cancelTaggedIdleIn(tx, deps, cancelled.wf)
  }
  rotate(tx)
  const mode = readModeState(deps.worktree, sessionID)
  if (mode.active) writeModeState(deps.worktree, sessionID, { ...EMPTY_MODE, stopReason: "workflow_started" })
  let wf = writeWorkflow(tx, created, now)
  const seq = appendEvents(tx, [
    { wf: wf.id, type: "created", actor, data: { entry, chars: request.length, engine } },
    { wf: wf.id, type: "transition", to: "planning", actor, data: { event: "start", row: "T1" } },
  ], now)
  wf = writeWorkflow(tx, { ...wf, lastSeq: seq }, now)
  return { ok: true, wf }
}

export function startWorkflow(deps: FlowRuntime, sessionID: string, entry: Workflow["entry"], request: string, actor: EventActor, engine: string, now = Date.now()): FlowResult {
  const result = withFlowTransaction(deps.worktree, (tx) => startWorkflowIn(tx, deps, sessionID, entry, request, actor, engine, now))
  if (result.ok) ensureHeartbeat(deps, engine)
  return result
}

/** T9: ledger approval, approve event and tasks_created event are serialized as one flow transaction. */
function approveWorkflowIn(tx: FlowTx, deps: FlowRuntime, wf: Workflow, inputs: TaskInput[], opts: { queueRunning: boolean; planShaOk: boolean; mdShaOk: boolean }, now: number): FlowResult {
  const check = checkWorkflowSnapshotIn(tx, deps, wf)
  if (!check.ok) return refuseSnapshot(check)
  wf = check.fresh
  if (wf.phase !== "pending_approval") return { ok: false, text: "no plan awaiting approval", wf }
  if (opts.queueRunning) return { ok: false, text: "a task queue is running; wait or /stop", wf }
  if (!opts.planShaOk || !wf.planRef) return { ok: false, text: "the saved plan does not match; /plan again", wf }
  if (!opts.mdShaOk) return { ok: false, text: "plan file edited; /plan again or revert", wf }
  const tag = { id: wf.id, planSha: wf.planRef.jsonSha }
  const ledger = readLedger(deps.worktree, wf.sessionID)
  const r = approvePlanTasks(ledger, inputs, tag, now)
  const written: Ledger = r.added.length > 0 ? writeLedger(deps.worktree, r.ledger) : ledger
  const taskIds = tasksForWorkflow(written, wf.id).filter((t) => t.wf?.planSha === tag.planSha).map((t) => t.id)
  const res = applyEventIn(
    tx, deps, wf, "approve", "user_command", {},
    (w) => ({ ...w, taskIds, approval: { by: "user_command", planSha: tag.planSha, at: now } }),
    { tasks: taskIds.length, cancelledForeign: r.cancelledForeign },
    now,
  )
  if (!res.ok) return res
  const next = eventIn(tx, deps, res.wf, "tasks_created", "code", { ids: taskIds }, now)
  return { ok: true, wf: next }
}

export function approveWorkflow(
  deps: FlowRuntime,
  wf: Workflow,
  inputs: TaskInput[],
  opts: { queueRunning: boolean; planShaOk: boolean; mdShaOk: boolean },
  now = Date.now(),
): FlowResult {
  return withFlowTransaction(deps.worktree, (tx) => approveWorkflowIn(tx, deps, wf, inputs, opts, now))
}

/** Settle ledger tags and phase in the same flow transaction. */
function settleIn(tx: FlowTx, deps: FlowRuntime, wf: Workflow, queueRunning: boolean, now: number): FlowResult | null {
  const check = checkWorkflowSnapshotIn(tx, deps, wf)
  if (!check.ok) return refuseSnapshot(check)
  wf = check.fresh
  if (wf.phase !== "executing" && !(wf.pendingCancel && !TERMINAL.has(wf.phase))) return null
  const ledger = readLedger(deps.worktree, wf.sessionID)
  const tasks = tasksForWorkflow(ledger, wf.id)
  const taskTally = tally(tasks)
  if (wf.pendingCancel) {
    if (queueRunning) return null
    cancelTaggedIdleIn(tx, deps, wf)
    return applyEventIn(tx, deps, wf, "cancel_settled", "code", { queueRunning: false }, (w) => w, undefined, now)
  }
  if (taskTally.open > 0 || taskTally.total === 0) return null
  const stopped = tasks.some((x) => x.status === "cancelled" && /user_stop/.test(x.error ?? ""))
  if (stopped) return applyEventIn(tx, deps, wf, "user_stop", "code", {}, (w) => w, undefined, now)
  return taskTally.failedOrCancelled > 0
    ? applyEventIn(tx, deps, wf, "settle_fail", "code", { tasks: taskTally }, (w) => w, { tally: taskTally }, now)
    : applyEventIn(tx, deps, wf, "settle_ok", "code", { tasks: taskTally }, (w) => w, { tally: taskTally }, now)
}

export function settle(deps: FlowRuntime, wf: Workflow, queueRunning: boolean, now = Date.now()): FlowResult | null {
  return withFlowTransaction(deps.worktree, (tx) => settleIn(tx, deps, wf, queueRunning, now))
}

function cancelWorkflowIn(tx: FlowTx, deps: FlowRuntime, wf: Workflow, queueRunning: boolean, actor: EventActor): FlowResult {
  const r = applyEventIn(tx, deps, wf, "cancel", actor, { queueRunning })
  if (!r.ok) return r
  if (!queueRunning) cancelTaggedIdleIn(tx, deps, r.wf)
  return r
}

/** T18 cancel. Queue abort runs only after the workflow transaction releases. */
export function cancelWorkflow(deps: FlowRuntime, wf: Workflow, queueRunning: boolean, abort: () => void, actor: EventActor = "user_command"): FlowResult {
  const result = withFlowTransaction(deps.worktree, (tx) => cancelWorkflowIn(tx, deps, wf, queueRunning, actor))
  if (result.ok && queueRunning) abort()
  return result
}

/** T19: the owning session was deleted (runs before the session dir is removed). */
export function onSessionDeleted(deps: FlowRuntime, sessionID: string, engine: string, queueRunning: boolean, abort: () => void): FlowResult | null {
  const outcome = withFlowTransaction(deps.worktree, (tx) => {
    const wf = activeWorkflowIn(tx, deps)
    const refusal = wf ? workflowEngineRefusal(wf, engine) : undefined
    if (refusal) return { result: { ok: false as const, text: refusal, wf }, abort: false }
    if (!wf || wf.sessionID !== sessionID) return { result: null, abort: false }
    const result = applyEventIn(tx, deps, wf, "session_deleted", "code")
    if (result.ok && !queueRunning) cancelTaggedIdleIn(tx, deps, result.wf)
    return { result, abort: queueRunning }
  })
  if (outcome.abort) abort()
  return outcome.result
}

/** Plugin-load repair is authorized against the fresh workflow while holding the transaction. */
function repairOnLoadIn(tx: FlowTx, deps: FlowRuntime, expectedEngine: string, isQueueRunning: (sessionID: string) => boolean): FlowResult | null {
  const wf = activeWorkflowIn(tx, deps)
  if (!wf) return null
  const engineRefusal = workflowEngineRefusal(wf, expectedEngine)
  if (engineRefusal) return { ok: false, text: engineRefusal, wf }
  const ctx = liveness(deps)
  if (wf.owner.instance !== ctx.instance && ownerLive(wf, ctx)) return null
  if (wf.phase === "reviewing") return applyEventIn(tx, deps, wf, "review_aborted", "code", {}, (w) => ({ ...w, review: { verdict: "none", findings: [], planSha: w.planRef?.jsonSha ?? "", note: "aborted" } }), { repair: true })
  if (wf.phase === "pending_approval" && wf.planRef) {
    const ledger = readLedger(deps.worktree, wf.sessionID)
    const ids = tasksForWorkflow(ledger, wf.id).filter((t) => t.wf?.planSha === wf.planRef!.jsonSha).map((t) => t.id)
    if (ids.length > 0) {
      const r = applyEventIn(tx, deps, wf, "approve", "code", {}, (w) => ({ ...w, taskIds: ids, approval: w.approval ?? { by: "user_command", planSha: wf.planRef!.jsonSha, at: Date.now() } }), { repair: true })
      if (r.ok) return { ok: true, wf: eventIn(tx, deps, r.wf, "tasks_created", "code", { ids, repair: true }) }
      return r
    }
    return null
  }
  return settleIn(tx, deps, wf, isQueueRunning(wf.sessionID), Date.now())
}

export function repairOnLoad(deps: FlowRuntime, engine: string, isQueueRunning: (sessionID: string) => boolean = () => false): FlowResult | null {
  return withFlowTransaction(deps.worktree, (tx) => repairOnLoadIn(tx, deps, engine, isQueueRunning))
}

export { cancelOpen, DEFAULT_LIMITS }
