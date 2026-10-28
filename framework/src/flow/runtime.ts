// Workflow operations shared by hooks and tools. Each operation: read -> authorize -> pure transition -> ordered
// writes (ledger first, then workflow.json, then events) -> side effects returned to the caller. Nothing here
// talks to the model; prompts and toasts are issued by the callers.
import { EMPTY_MODE, readBoundedBytes, readModeState, sessionDir, stateRoot, writeModeState } from "../state/store.ts"
import { approvePlanTasks, insertUnitTasks, cancelOpen, readLedger, tasksForWorkflow, type LedgerTask, type TaskInput, type Ledger, writeLedger, OPEN_STATUSES } from "../state/ledger.ts"
import { existsSync } from "node:fs"
import type { ExecutionRuntime, FlowRuntime } from "../hosts/types.ts"
import { createExecutionRunStore, settled, type ExecutionRunStore } from "../hosts/run-state.ts"
import { abortSessionActivities, executionActivity, sessionActivityBlocker } from "../hosts/runtime.ts"
import { cancelSkillPermissionActivities, pendingSkillPermissionActivityCount } from "../skills/activity.ts"
import { getQueue } from "../orchestration/queue.ts"
import { onQueueSettled, onQueueStopObserved } from "../orchestration/queue-observers.ts"
import { getOwnedSession, inspectSessionAttachment, readSessionMetadata, type SessionStore } from "../sessions/store.ts"
import { transition, ZERO_COUNTERS, type FlowEvent, type TransitionCtx, type Limits, DEFAULT_LIMITS, TERMINAL } from "./machine.ts"
import {
  appendEvents, assertFlowTxWorktree, lastEventSeq, workflowReadError, coreOf, newWorkflow, readEvents, readWorkflow, readWorkflowForWrite, LegacyWorkflowError,
  readAnyWorkflowChecked, readAnyWorkflowForWrite,
  rotate, withCore, withFlowTransaction, writeHeartbeat, readHeartbeat,
  type EventActor, type FlowTx, type Workflow, workflowEngineRefusal, FlowTransactionBusyError,
} from "./state.ts"
import { join } from "node:path"
import { coercePlan, planToTasks, type Plan } from "./plan.ts"
import { readArtifactBytes, verifyArtifact } from "../workflows/artifacts.ts"
import { randomUUID } from "node:crypto"
import { commitRevision, sha256Hex } from "../workflows/commit.ts"
import { authorize, currentOwner, pidAlive, defaultLiveness, epochReleased, isAttachmentEpoch, ownerLive, startHeartbeat, type Command, type Heartbeat, type LivenessCtx } from "./owner.ts"
import { effectiveHold, holdAdmission, holdOwnedAdmission } from "../sessions/admission.ts"
import { type StopKind, type Subject, type WorkflowEnvelope } from "../workflows/types.ts"
import { planSubject, sameSubject, stopSubjectOf, UNIT_DOC_MAX_BYTES, unitFor, unitRecord, unitTag, unitTaskProblem } from "../workflows/execution-unit.ts"
import { taskPartition, worktreeDigest, writeCheckpoint } from "../workflows/checkpoint.ts"

export type FlowResult = { ok: true; wf: Workflow; toast?: string; note?: string } | { ok: false; text: string; wf?: Workflow | null }
/** Result of a kind-generic operation (stop, settle, resume): the workflow may be any committed kind. */
export type AnyFlowResult = { ok: true; wf: WorkflowEnvelope; toast?: string; note?: string } | { ok: false; text: string; wf?: WorkflowEnvelope | null }

export function flowLimits(deps: FlowRuntime): Limits {
  const f = deps.config.flow
  return { max_code_invalid: f.max_code_invalid, max_review_iterations: f.max_review_iterations, nudge_max: f.nudge_max }
}

export function liveness(deps: FlowRuntime, now = Date.now(), wf?: WorkflowEnvelope): LivenessCtx {
  const beat = wf ? readHeartbeat(deps.worktree, wf, wf.sessionID) : undefined
  return defaultLiveness(epochReleased(deps.worktree), now, () => beat)
}

export type TaskTally = { open: number; failedOrCancelled: number; total: number }

export function tally(tasks: LedgerTask[]): TaskTally {
  return {
    open: tasks.filter((t) => OPEN_STATUSES.has(t.status)).length,
    failedOrCancelled: tasks.filter((t) => t.status === "failed" || t.status === "cancelled").length,
    total: tasks.length,
  }
}

// ---------------------------------------------------------------- heartbeat (one per session)
type SessionHeartbeat = { timer: Heartbeat; engine: unknown; workflowID: string; ownerInstance: string }
const beats = new Map<string, SessionHeartbeat>()
const heartbeatKey = (worktree: string, sessionID?: string) => JSON.stringify([worktree, sessionID ?? null])

/** Keep the captured owner binding fresh; stop when its workflow or attachment epoch changes. */
export function ensureHeartbeat(deps: FlowRuntime, engine: unknown, snapshot?: Workflow, interval?: number, sessionID?: string): void {
  const expected = snapshot ?? readAnyWorkflowChecked(deps.worktree, sessionID).wf
  const key = heartbeatKey(deps.worktree, expected?.sessionID ?? sessionID)
  const existing = beats.get(key)
  if (!expected || TERMINAL.has(expected.phase) || expected.owner.pid !== process.pid || workflowEngineRefusal(expected, engine)) {
    existing?.timer.stop()
    beats.delete(key)
    return
  }
  if (existing && existing.engine === engine && existing.workflowID === expected.id &&
      existing.ownerInstance === expected.owner.instance) return
  existing?.timer.stop()
  const expectedEngine = engine
  const expectedWorkflowID = expected.id
  const expectedOwner = expected.owner
  let expectedRevision = expected.lastSeq
  const timer = startHeartbeat(() => {
    try {
      const keep = withFlowTransaction(deps.worktree, (tx) => {
        assertFlowTxWorktree(tx, deps.worktree)
        const checked = readAnyWorkflowForWrite(tx)
        if (checked.corrupt) return true
        const wf = checked.wf
        if (!wf || wf.id !== expectedWorkflowID || TERMINAL.has(wf.phase) ||
            wf.owner.pid !== expectedOwner.pid || wf.owner.instance !== expectedOwner.instance || wf.lastSeq < expectedRevision) return false
        if (workflowEngineRefusal(wf, expectedEngine)) return false
        const binding = workflowOwnerBinding(deps, wf)
        if (!binding.active) return false
        // Sidecar only: a heartbeat never mints a revision, so receipts and expected-revision fences stay valid.
        writeHeartbeat(tx, wf)
        expectedRevision = wf.lastSeq
        return true
      }, expected.sessionID)
      if (!keep) beats.delete(key)
      return keep
    } catch (error) {
      if (error instanceof FlowTransactionBusyError) return true
      throw error
    }
  }, interval, (e) => deps.log("flow heartbeat write failed; retrying", { error: (e as Error)?.message ?? String(e) }))
  beats.set(key, { timer, engine, workflowID: expected.id, ownerInstance: expected.owner.instance })
}

/** Stop one session timer; no arguments clears all timers for process shutdown and tests. */
export function stopHeartbeat(worktree?: string, sessionID?: string): void {
  if (worktree !== undefined) {
    const key = heartbeatKey(worktree, sessionID)
    beats.get(key)?.timer.stop()
    beats.delete(key)
    return
  }
  for (const beat of beats.values()) beat.timer.stop()
  beats.clear()
}

type WorkflowOwnerBinding = { active: boolean; store?: SessionStore }

/** Identify epoch-bound workflows without treating missing lifecycle state as takeover permission. */
function workflowOwnerBinding(deps: FlowRuntime, wf: WorkflowEnvelope): WorkflowOwnerBinding {
  let store: SessionStore | undefined
  let storeUnreadable = false
  try { store = getOwnedSession(deps.worktree, wf.sessionID) }
  catch { storeUnreadable = true }
  let metadata: ReturnType<typeof readSessionMetadata> = null
  let metadataUnreadable = false
  try { metadata = readSessionMetadata(deps.worktree, wf.sessionID) }
  catch { metadataUnreadable = true }
  const active = !!store && !storeUnreadable && !metadataUnreadable && store.epoch === wf.owner.instance &&
    wf.owner.pid === process.pid && !store.metadata.held && metadata?.held === false && !effectiveHold(deps.worktree, wf.sessionID)
  return { active, store }
}

function heldOwnerRefusal(wf: Workflow): string {
  return `plan workflow ${wf.id} remains held by session ${wf.sessionID}; use /resume ${wf.sessionID} to continue`
}

function quiescenceRefusal(runtime: ExecutionRuntime, sid: string): string | undefined {
  if (executionActivity(runtime.worktree)) return "execution activity or reviewer is still active"
  if (getQueue(runtime).isRunning(sid)) return "session queue is still active"
  const status = runtime.runs.status()
  if (status.claim) return "execution run claim is still active"
  if (status.executions.some(execution => !settled(execution))) return "execution intent is unsettled"
  return undefined
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
  /** Additional events committed in the same revision (one commit per transaction). */
  extraEvents: Array<(next: Workflow) => Parameters<typeof commitRevision>[2][number]> = [],
): FlowResult {
  assertFlowTxWorktree(tx, deps.worktree)
  // Compare-and-swap: the caller's record may be stale (e.g. otter_flow awaited a review for minutes while a /cancel
  // or a new /plan ran). Refuse without writing when the persisted workflow is a different one, has new events, or
  // a different phase. The transition applies to the fresh record, so a refreshed owner heartbeat is never rolled
  // back.
  const checked = readWorkflowForWrite(tx)
  if (checked.corrupt) throw workflowReadError(checked)
  const fresh = checked.wf
  const engineRefusal = fresh ? workflowEngineRefusal(fresh, wf.engine) : undefined
  if (engineRefusal) return { ok: false, text: engineRefusal, wf: fresh }
  if (!fresh || fresh.id !== wf.id || fresh.lastSeq !== wf.lastSeq || fresh.phase !== wf.phase) {
    return { ok: false, text: "workflow changed meanwhile; stop and check /status", wf: fresh }
  }
  const base: Workflow = { ...wf, owner: fresh.owner, orphanedEvents: fresh.orphanedEvents }
  const r = transition(coreOf(base), event, { limits: flowLimits(deps), ...ctx })
  if ("error" in r) return { ok: false, text: r.error, wf }
  let next: Workflow = { ...patch(withCore(base, r.core)), engine: fresh.engine }
  const typed = typedEvent(event)
  const events = [
    { wf: wf.id, type: "transition", from: phaseLabel(wf), to: phaseLabel(next), actor, data: { event, row: r.row, ...(data ?? {}) } },
    ...(typed ? [{ wf: wf.id, type: typed, actor, data }] : []),
    ...extraEvents.map((build) => build(next)),
  ]
  next = { ...next, lastSeq: wf.lastSeq, owner: fresh.owner }
  next = commitWorkflow(tx, next, events, now)
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
  return withFlowTransaction(deps.worktree, (tx) => applyEventIn(tx, deps, wf, event, actor, ctx, patch, data, now), wf.sessionID)
}

/**
 * Kind-generic lifecycle event (stop/settle/resume). The plan kind delegates to `applyEventIn` unchanged. Planning kinds
 * reuse the same pure machine over their phase and stop fields (no counters or stuck cause): the machine decides, and
 * the stage follows the phase (`cancelled` -> `terminal`; a pause keeps its live stage; resume restores `pausedFrom`).
 */
export function applyAnyEventIn(
  tx: FlowTx,
  deps: FlowRuntime,
  wf: WorkflowEnvelope,
  event: FlowEvent,
  actor: EventActor,
  ctx: TransitionCtx = {},
  patch: (wf: WorkflowEnvelope) => WorkflowEnvelope = (w) => w,
  data?: Record<string, unknown>,
  now = Date.now(),
  extraEvents: Array<(next: WorkflowEnvelope) => Parameters<typeof commitRevision>[2][number]> = [],
): AnyFlowResult {
  if (wf.kind === "plan") {
    return applyEventIn(tx, deps, wf, event, actor, ctx, patch as (w: Workflow) => Workflow, data, now, extraEvents as Array<(next: Workflow) => Parameters<typeof commitRevision>[2][number]>)
  }
  assertFlowTxWorktree(tx, deps.worktree)
  const checked = readAnyWorkflowForWrite(tx)
  if (checked.corrupt) throw workflowReadError(checked)
  const fresh = checked.wf
  const engineRefusal = fresh ? workflowEngineRefusal(fresh, wf.engine) : undefined
  if (engineRefusal) return { ok: false, text: engineRefusal, wf: fresh }
  if (!fresh || fresh.id !== wf.id || fresh.lastSeq !== wf.lastSeq || fresh.phase !== wf.phase || fresh.kind !== wf.kind) {
    return { ok: false, text: "workflow changed meanwhile; stop and check /status", wf: fresh }
  }
  const base = { ...wf, owner: fresh.owner, orphanedEvents: fresh.orphanedEvents } as WorkflowEnvelope
  const core = {
    phase: base.phase, counters: { ...ZERO_COUNTERS },
    ...(base.stopIntent ? { stop: { kind: base.stopIntent.kind } } : {}),
    ...(base.pausedFrom ? { pausedFrom: base.pausedFrom.phase } : {}),
  }
  const r = transition(core, event, { limits: flowLimits(deps), ...ctx })
  if ("error" in r) return { ok: false, text: r.error, wf }
  const phase = r.core.phase
  let stopIntent: WorkflowEnvelope["stopIntent"] = null
  if (r.core.stop) {
    stopIntent = base.stopIntent?.kind === r.core.stop.kind ? base.stopIntent : {
      kind: r.core.stop.kind, token: randomUUID(), requestedFrom: { phase: base.phase, stage: base.stage }, checkpoint: null, reason: `${r.core.stop.kind} requested`,
    }
  }
  const { pausedFrom: _pf, ...withoutPaused } = base
  let next = {
    ...withoutPaused,
    phase,
    stage: phase === "cancelled" || phase === "done" ? "terminal" : base.stage,
    stopIntent,
    ...(r.core.pausedFrom ? { pausedFrom: base.pausedFrom?.phase === r.core.pausedFrom ? base.pausedFrom : { phase: r.core.pausedFrom, stage: base.stage } } : {}),
  } as WorkflowEnvelope
  next = { ...patch(next), engine: fresh.engine } as WorkflowEnvelope
  const typed = typedEvent(event)
  const events = [
    { wf: wf.id, type: "transition", from: wf.phase, to: next.phase, actor, data: { event, row: r.row, ...(data ?? {}) } },
    ...(typed ? [{ wf: wf.id, type: typed, actor, data }] : []),
    ...extraEvents.map((build) => build(next)),
  ]
  next = { ...next, lastSeq: wf.lastSeq, owner: fresh.owner } as WorkflowEnvelope
  return { ok: true, wf: commitRevision(tx, next, events, now), toast: r.toast?.replace("plan workflow", `${wf.kind} workflow`) }
}

/** The single mutation path: one event append + snapshot + index publish (workflows/commit.ts). */
function commitWorkflow(tx: FlowTx, wf: Workflow, events: Parameters<typeof commitRevision>[2], now: number): Workflow {
  const committed = commitRevision(tx, wf, events, now)
  if (committed.kind !== "plan") throw new TypeError("committed workflow is not a plan workflow")
  return committed
}

function typedEvent(e: FlowEvent): string | null {
  switch (e) {
    case "approve": return "approved"
    case "reject": return "rejected"
    case "nudge": return "nudge"
    case "cancel": return "cancelled"
    case "pause_settled": return "pause_settled"
    case "cancel_settled": return "cancel_settled"
    case "resume": return "resumed"
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
  if (checked.corrupt) throw workflowReadError(checked)
  return checked.wf
}

function readAnyWorkflowIn(tx: FlowTx, deps: FlowRuntime): WorkflowEnvelope | null {
  assertFlowTxWorktree(tx, deps.worktree)
  const checked = readAnyWorkflowForWrite(tx)
  if (checked.corrupt) throw workflowReadError(checked)
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
  return commitWorkflow(tx, check.fresh, [{ wf: check.fresh.id, type, actor, data }], now)
}

/**
 * Resolve authority without changing its owner. Returns the admitted workflow, a refusal, or
 * `{ wf: null }` when there is no active workflow.
 */
type AuthorityResult = { wf: Workflow | null; refuse?: string; ownerDead?: boolean }
export function resolveAuthorityIn(tx: FlowTx, deps: FlowRuntime, cmd: Command, sessionID: string, expectedEngine: string, now: number): AuthorityResult {
  const wf = activeWorkflowIn(tx, deps)
  if (!wf) return { wf: null }
  const engineRefusal = workflowEngineRefusal(wf, expectedEngine)
  if (engineRefusal) return { wf, refuse: engineRefusal }
  const binding = workflowOwnerBinding(deps, wf)
  if (!binding.active) {
    return cmd === "status"
      ? { wf, ownerDead: !liveOwner(deps, wf, now) }
      : { wf, refuse: heldOwnerRefusal(wf) }
  }
  const ctx = liveness(deps, now, wf)
  if (binding.active && binding.store) ctx.instance = binding.store.epoch
  const authority = authorize(cmd, sessionID, wf, ctx)
  switch (authority.kind) {
    case "none": return { wf: null }
    case "allow": return { wf, ownerDead: false }
    case "refuse": return { wf, refuse: authority.text }
  }
}

export function resolveAuthority(
  deps: FlowRuntime,
  cmd: Command,
  sessionID: string,
  engine: string,
  now = Date.now(),
): AuthorityResult {
  return withFlowTransaction(deps.worktree, (tx) => resolveAuthorityIn(tx, deps, cmd, sessionID, engine, now), sessionID)
}

export type ReattachHeldOwnerResult = { wf: WorkflowEnvelope } | { refuse: string; wf?: WorkflowEnvelope | null }

/** The one audit event name for a same-SID epoch reattachment; emit and idempotency lookup both use it. */
export const OWNER_REATTACHED = "owner_reattached"

function reattachEventsFor(worktree: string, workflowID: string, toEpoch: string, expectedRevision: number, sessionID: string) {
  return readEvents(worktree, workflowID, sessionID).filter(event => {
    if (event.type !== OWNER_REATTACHED || !event.data || typeof event.data !== "object") return false
    const data = event.data as Record<string, unknown>
    return data.toEpoch === toEpoch && data.expectedRevision === expectedRevision
  })
}

function reattachEventFor(worktree: string, workflowID: string, fromEpoch: string, toEpoch: string, expectedRevision: number, sessionID: string) {
  const matches = reattachEventsFor(worktree, workflowID, toEpoch, expectedRevision, sessionID).filter(event => {
    const data = event.data as Record<string, unknown>
    return data.fromEpoch === fromEpoch
  })
  return matches.length === 1 ? matches[0] : matches.length === 0 ? null : undefined
}

/** Injection seams for deterministic tests; production callers pass nothing. */
export type ReattachOptions = {
  now?: number
  inspect?: typeof inspectSessionAttachment
}

/**
 * S6.2a: rebind a held workflow only after a new exclusive attachment proves the old epoch released this exact
 * workflow revision or its recorded process identity is dead. One commitRevision CAS (event + snapshot + index) with
 * no heartbeat write; only owner and lastSeq differ between the old and new snapshots. This never clears the session
 * hold, issues a token or dispatches work.
 */
export function reattachOwner(
  runtime: ExecutionRuntime,
  store: SessionStore,
  expectedWorkflowID: string,
  expectedRevision: number,
  options: ReattachOptions = {},
): ReattachHeldOwnerResult {
  const inspect = options.inspect ?? inspectSessionAttachment
  const refuse = (text: string, wf?: WorkflowEnvelope | null): ReattachHeldOwnerResult => ({ refuse: text, ...(wf === undefined ? {} : { wf }) })
  try {
    if (!expectedWorkflowID || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return refuse("expected workflow ID or revision is invalid")
    if (store.sessionID.length === 0 || store.epoch.length === 0) return refuse("session attachment identity is invalid")
    store.assertOwner()
    if (getOwnedSession(runtime.worktree, store.sessionID)?.epoch !== store.epoch) return refuse("session attachment is not exclusively owned by this process")
    if (!store.metadata.held) return refuse("session attachment is not held")
    const metadata = readSessionMetadata(runtime.worktree, store.sessionID)
    if (!metadata || !metadata.held || metadata.engine !== runtime.host.identity.engine) return refuse("held session metadata is missing, corrupt, or belongs to another engine")
    const idle = quiescenceRefusal(runtime, store.sessionID)
    if (idle) return refuse(idle)

    return withFlowTransaction(runtime.worktree, tx => {
      const checked = readAnyWorkflowForWrite(tx)
      if (checked.corrupt) return refuse("workflow state is corrupt; reattach refused")
      const wf = checked.wf
      if (!wf || wf.sessionID !== store.sessionID) return refuse("workflow does not belong to the attached session", wf)
      if (wf.id !== expectedWorkflowID) return refuse("workflow ID changed; reattach refused", wf)
      if (workflowEngineRefusal(wf, runtime.host.identity.engine)) return refuse("workflow engine does not match this session", wf)
      // D5: a pending pause, a pending cancel and a settled pause reattach held and keep their intent.
      if (TERMINAL.has(wf.phase)) return refuse("terminal workflow cannot be reattached", wf)

      if (wf.owner.instance === store.epoch) {
        const committed = reattachEventsFor(runtime.worktree, wf.id, store.epoch, expectedRevision, wf.sessionID)
        if (wf.owner.pid === process.pid && committed.length === 1 && committed[0]!.seq === wf.lastSeq) return { wf }
        return refuse("workflow is already bound to this attachment without a matching reattach receipt", wf)
      }
      if (wf.lastSeq !== expectedRevision) return refuse("workflow revision changed; reattach refused", wf)
      if (!isAttachmentEpoch(wf.owner.instance)) return refuse("workflow owner has no verifiable attachment epoch", wf)
      const targetEvents = reattachEventsFor(runtime.worktree, wf.id, store.epoch, expectedRevision, wf.sessionID)
      const existing = reattachEventFor(runtime.worktree, wf.id, wf.owner.instance, store.epoch, expectedRevision, wf.sessionID)
      if (existing === undefined) return refuse("duplicate owner-reattached receipt; reattach refused", wf)
      if (targetEvents.length > 0 && (targetEvents.length !== 1 || !existing)) {
        return refuse("conflicting owner-reattached receipt; reattach refused", wf)
      }

      const previousOwner = wf.owner
      const inspection = inspect(runtime.worktree, wf.sessionID, previousOwner.instance)
      if (!inspection || inspection.epoch !== previousOwner.instance || inspection.sessionID !== wf.sessionID) {
        return refuse("previous attachment lifecycle proof is missing or corrupt", wf)
      }
      if (inspection.state === "released") {
        if (inspection.workflowID !== wf.id || inspection.revision !== expectedRevision || !inspection.releaseEvidence) {
          return refuse("previous attachment release does not prove this workflow revision", wf)
        }
      } else if (inspection.state === "attached") {
        if (inspection.identity !== "dead" || inspection.pid !== previousOwner.pid) {
          return refuse("previous attachment process identity is live or ambiguous", wf)
        }
      } else {
        return refuse("previous attachment lifecycle state is ambiguous", wf)
      }

      const quiescence = quiescenceRefusal(runtime, store.sessionID)
      if (quiescence) return refuse(quiescence, wf)
      store.assertOwner()
      const fresh = readAnyWorkflowForWrite(tx)
      const current = fresh.wf
      if (fresh.corrupt || !current || current.id !== wf.id || current.sessionID !== wf.sessionID ||
          current.lastSeq !== expectedRevision || current.owner.instance !== previousOwner.instance ||
          current.owner.pid !== previousOwner.pid) {
        return refuse("workflow owner or revision changed; reattach refused", current)
      }

      const now = options.now ?? Date.now()
      store.assertOwner()
      const proofBytes = readBoundedBytes(join(stateRoot(runtime.worktree), "sessions", wf.sessionID, "attachments", `${previousOwner.instance}.json`), 64 * 1024).bytes
      if (!proofBytes) return refuse("previous attachment lifecycle proof is missing or corrupt", wf)
      const proofRef = {
        path: `sessions/${wf.sessionID}/attachments/${previousOwner.instance}.json`,
        sha256: sha256Hex(proofBytes),
      }
      const newRevision = lastEventSeq(runtime.worktree, wf.sessionID) + 1
      // One commit: the owner_reattached event, the snapshot with the new owner, then the index. A crash before the
      // index leaves the old committed owner and an orphan event that readers ignore.
      const rebound = commitRevision(tx, { ...current, owner: { instance: store.epoch, pid: process.pid } } as WorkflowEnvelope, [{
        wf: wf.id,
        type: OWNER_REATTACHED,
        actor: "code",
        data: {
          sid: wf.sessionID,
          wid: wf.id,
          fromEpoch: previousOwner.instance,
          toEpoch: store.epoch,
          expectedRevision,
          newRevision,
          proofKind: inspection.state === "released" ? "released" : "dead",
          proofRef,
        },
      }], now)
      if (rebound.lastSeq !== newRevision) throw new Error("reattach revision did not match its audit row")
      return { wf: rebound }
    }, store.sessionID)
  } catch (error) {
    return refuse(`held workflow reattach refused: ${(error as Error)?.message ?? String(error)}`)
  }
}

function liveOwner(deps: FlowRuntime, wf: Workflow, now: number): boolean {
  return ownerLive(wf, liveness(deps, now, wf))
}

/** Cancel open tasks tagged with this workflow (any kind) when no queue runs (T18/T19 side effect). */
function cancelTaggedIdleIn(tx: FlowTx, deps: FlowRuntime, wf: WorkflowEnvelope, reason = `${wf.kind} workflow ${wf.id} cancelled`): string[] {
  const fresh = readAnyWorkflowIn(tx, deps)
  const refusal = !fresh ? "workflow changed meanwhile; stop and check /status"
    : workflowEngineRefusal(fresh, wf.engine) ?? (fresh.id !== wf.id || fresh.lastSeq !== wf.lastSeq || fresh.phase !== wf.phase ? "workflow changed meanwhile; stop and check /status" : undefined)
  if (refusal || !fresh) throw new Error(refusal)
  const ledger = readLedger(deps.worktree, fresh.sessionID)
  const ids = new Set(tasksForWorkflow(ledger, fresh.id).filter((t) => OPEN_STATUSES.has(t.status)).map((t) => t.id))
  if (ids.size === 0) return []
  const now = Date.now()
  const tasks = ledger.tasks.map((t) => (ids.has(t.id) ? { ...t, status: "cancelled" as const, error: reason, finishedAt: now } : t))
  writeLedger(deps.worktree, { ...ledger, tasks, running: undefined })
  return [...ids]
}

export function cancelTaggedIdle(deps: FlowRuntime, wf: WorkflowEnvelope, reason = `${wf.kind} workflow ${wf.id} cancelled`): string[] {
  return withFlowTransaction(deps.worktree, (tx) => cancelTaggedIdleIn(tx, deps, wf, reason), wf.sessionID)
}

/** T1 in one transaction: same-session stuck cancel, ledger cleanup, terminal rotation and creation. */
function startWorkflowIn(tx: FlowTx, deps: FlowRuntime, sessionID: string, entry: Workflow["entry"], request: string, actor: EventActor, engine: string, now: number): FlowResult {
  const occupant = readAnyWorkflowIn(tx, deps)
  if (occupant && occupant.kind !== "plan" && !TERMINAL.has(occupant.phase)) {
    return { ok: false, text: `${occupant.kind} workflow ${occupant.id} is active${occupant.sessionID === sessionID ? "; use /status or /cancel" : ` in session ${occupant.sessionID}`}` }
  }
  const existing = activeWorkflowIn(tx, deps)
  if (existing) {
    const refusal = workflowEngineRefusal(existing, engine)
    if (refusal) return { ok: false, text: refusal, wf: existing }
    if (existing.sessionID !== sessionID) {
      return { ok: false, text: `plan workflow ${existing.id} is owned by session ${existing.sessionID}; use /resume ${existing.sessionID} to continue`, wf: existing }
    }
    const binding = workflowOwnerBinding(deps, existing)
    if (!binding.active) return { ok: false, text: heldOwnerRefusal(existing), wf: existing }
    if (existing.phase !== "stuck") {
      return { ok: false, text: `plan workflow ${existing.id} is already active; use /status or /cancel`, wf: existing }
    }
  }
  let ownedSession: SessionStore | undefined
  try { ownedSession = getOwnedSession(deps.worktree, sessionID) }
  catch (error) { return { ok: false, text: `session attachment is unavailable: ${(error as Error)?.message ?? String(error)}`, wf: existing } }
  if (!ownedSession || effectiveHold(deps.worktree, sessionID)) {
    return { ok: false, text: `session ${sessionID} has no live admission; use /resume ${sessionID} before starting a workflow`, wf: existing }
  }
  {
    let metadata: ReturnType<typeof readSessionMetadata>
    try { metadata = readSessionMetadata(deps.worktree, sessionID) }
    catch (error) { return { ok: false, text: `session attachment state is unavailable: ${(error as Error)?.message ?? String(error)}`, wf: existing } }
    if (ownedSession.metadata.held || !metadata || metadata.held || metadata.engine !== engine) {
      return { ok: false, text: "session attachment is held or its engine does not match; /resume is required before starting a workflow", wf: existing }
    }
  }
  const owner = currentOwner(now, ownedSession.epoch)
  const created = newWorkflow(sessionID, owner, entry, request, engine, now)
  // Two commits by design: the index names exactly one workflow and one snapshot, so a single commit cannot publish
  // both the old workflow's terminal (cancelled) revision and the new workflow's first revision. Committing the
  // cancel first keeps the old workflow's terminal history durable and index-bound; the create commit then replaces
  // the pointer (legal because the occupant is terminal). A crash between them leaves a cancelled workflow and no
  // new one, never two active workflows.
  if (existing) {
    const cancelled = applyEventIn(tx, deps, existing, "cancel", actor, { active: false }, (w) => w, { reason: "restart" }, now)
    if (!cancelled.ok) return cancelled
    cancelTaggedIdleIn(tx, deps, cancelled.wf)
  }
  rotate(tx)
  const mode = readModeState(deps.worktree, sessionID)
  if (mode.active) writeModeState(deps.worktree, sessionID, { ...EMPTY_MODE, stopReason: "workflow_started" })
  const wf = commitWorkflow(tx, created, [
    { wf: created.id, type: "created", actor, data: { entry, chars: request.length, engine } },
    { wf: created.id, type: "transition", to: "planning", actor, data: { event: "start", row: "T1" } },
  ], now)
  return { ok: true, wf }
}

export function startWorkflow(deps: FlowRuntime, sessionID: string, entry: Workflow["entry"], request: string, actor: EventActor, engine: string, now = Date.now()): FlowResult {
  const result = withFlowTransaction(deps.worktree, (tx) => startWorkflowIn(tx, deps, sessionID, entry, request, actor, engine, now), sessionID)
  if (result.ok) ensureHeartbeat(deps, engine, result.wf)
  return result
}

/**
 * Ledger tags written by an approval that never reached the committed index carry no authority. Open tasks tagged
 * for this pending_approval workflow are cancelled and detached from the workflow (retained, never deleted), and a
 * non-committing audit row records the quarantine. Approval then needs a fresh receipt.
 */
function quarantineOrphanApprovalTagsIn(tx: FlowTx, deps: FlowRuntime, wf: Workflow, now: number): string[] {
  const ledger = readLedger(deps.worktree, wf.sessionID)
  const orphan = new Set(tasksForWorkflow(ledger, wf.id).filter((t) => OPEN_STATUSES.has(t.status)).map((t) => t.id))
  if (orphan.size === 0) return []
  const tasks = ledger.tasks.map((t) => {
    if (!orphan.has(t.id)) return t
    const { wf: _tag, ...rest } = t
    return { ...rest, status: "cancelled" as const, error: `approval of ${wf.id} never committed; tags quarantined, a fresh operator receipt is required`, finishedAt: now }
  })
  writeLedger(deps.worktree, { ...ledger, tasks, running: undefined })
  appendEvents(tx, [{ wf: wf.id, type: "approval_precommit_quarantined", actor: "code", data: { ids: [...orphan] } }], now)
  return [...orphan]
}

/** T9: ledger approval, approve event and tasks_created event are serialized as one flow transaction. */
function approveWorkflowIn(
  tx: FlowTx,
  deps: FlowRuntime,
  wf: Workflow,
  inputs: TaskInput[],
  opts: { queueRunning: boolean; planShaOk: boolean; mdShaOk: boolean; subject?: Subject; receiptRevision?: number },
  now: number,
): FlowResult {
  const check = checkWorkflowSnapshotIn(tx, deps, wf)
  if (!check.ok) return refuseSnapshot(check)
  wf = check.fresh
  if (wf.phase !== "pending_approval") return { ok: false, text: "no plan awaiting approval", wf }
  if (opts.queueRunning) return { ok: false, text: "a task queue is running; wait or /stop", wf }
  if (!opts.planShaOk || !wf.planRef) return { ok: false, text: "the saved plan does not match; /plan again", wf }
  if (!opts.mdShaOk) return { ok: false, text: "plan file edited; /plan again or revert", wf }
  const subject = planSubject(wf)!
  if (opts.subject && !sameSubject(opts.subject, subject)) return { ok: false, text: "the approval subject changed; /plan again", wf }
  const receiptRevision = opts.receiptRevision ?? wf.lastSeq
  if (receiptRevision !== wf.lastSeq) return { ok: false, text: "workflow revision changed since the approval was issued", wf }
  quarantineOrphanApprovalTagsIn(tx, deps, wf, now)
  const tag = unitTag({ parentWorkflowID: wf.id, subject })
  const ledger = readLedger(deps.worktree, wf.sessionID)
  const r = approvePlanTasks(ledger, inputs, tag, now)
  const written: Ledger = r.added.length > 0 ? writeLedger(deps.worktree, r.ledger) : ledger
  const taskIds = tasksForWorkflow(written, wf.id).filter((t) => t.wf?.planSha === tag.planSha).map((t) => t.id)
  const res = applyEventIn(
    tx, deps, wf, "approve", "user_command", {},
    (w) => ({ ...w, taskIds, approval: { by: "user_command", subject, receiptRevision, at: now } }),
    { tasks: taskIds.length, cancelledForeign: r.cancelledForeign, subject },
    now,
    // approve + tasks_created are one commit: exactly one revision snapshot per approval.
    [(next) => ({ wf: next.id, type: "tasks_created", actor: "code", data: { ids: taskIds } })],
  )
  return res
}

/** The unit's tasks from its verified `units/*.json` document (the canonical plan), or the reason there are none. */
function unitTaskInputs(worktree: string, record: NonNullable<ReturnType<typeof unitRecord>>): TaskInput[] | string {
  const docs = record.artifacts.filter(ref => ref.key.endsWith(".json"))
  if (docs.length !== 1) return "approved unit has no single plan document"
  const ref = docs[0]!
  if (verifyArtifact(worktree, ref).state !== "verified") return "approved unit or its documents changed"
  const read = readArtifactBytes(join(worktree, ref.path), UNIT_DOC_MAX_BYTES)
  if (!read.ok) return `unit document is ${read.reason}`
  try {
    const json = JSON.parse(read.bytes.toString("utf8")) as Plan
    return planToTasks(coercePlan(json, json.revision))
  } catch { return "unit document is not a valid plan" }
}

export type UnitInsertion = { ok: true; taskIds: string[] } | { ok: false; text: string }

/**
 * Insert the tasks of an approved ultragoal/autoresearch unit into the existing queue ledger, tagged
 * {parent workflow id, subject sha}. The unit is rebuilt from the committed workflow first (approval names the subject,
 * documents verify from disk), so an edited unit document refuses with zero tasks. Any open task not tagged for this
 * unit refuses the insertion and is left untouched. The index stays on the parent; no workflow is started.
 */
export function insertApprovedUnitTasks(deps: FlowRuntime & Pick<ExecutionRuntime, "host">, wf: WorkflowEnvelope, now = Date.now()): UnitInsertion {
  if (wf.kind === "plan") return { ok: false, text: "plan tasks are inserted by plan approval" }
  return withFlowTransaction(deps.worktree, (tx): UnitInsertion => {
    const fresh = readAnyWorkflowIn(tx, deps)
    if (!fresh || fresh.id !== wf.id || fresh.lastSeq !== wf.lastSeq || fresh.phase !== "executing") return { ok: false, text: "workflow changed meanwhile; stop and check /status" }
    if (fresh.stopIntent) return { ok: false, text: `workflow ${fresh.stopIntent.kind} is pending` }
    const engineRefusal = workflowEngineRefusal(fresh, deps.host.identity.engine)
    if (engineRefusal) return { ok: false, text: engineRefusal }
    const ledger = readLedger(deps.worktree, fresh.sessionID)
    let unit
    try { unit = unitFor(fresh, { worktree: deps.worktree, tasks: ledger.tasks }) }
    catch (error) { return { ok: false, text: (error as Error).message } }
    const record = unitRecord(fresh)
    if (!record) return { ok: false, text: "approved unit record is unreadable" }
    // The tasks are derived HERE, inside the transaction, from the hash-verified unit JSON the approval is bound to;
    // a caller can no longer supply different steps, files or details than the ones that were reviewed and approved.
    const inputs = unitTaskInputs(deps.worktree, record)
    if (typeof inputs === "string") return { ok: false, text: inputs }
    const taskProblem = unitTaskProblem(record, inputs)
    if (taskProblem) return { ok: false, text: taskProblem }
    const tag = unitTag(unit)
    const inserted = insertUnitTasks(ledger, inputs, tag, now)
    if (!inserted.ok) return { ok: false, text: inserted.reason }
    if (inserted.added.length > 0) writeLedger(deps.worktree, inserted.ledger)
    return { ok: true, taskIds: tasksForWorkflow(inserted.ledger, fresh.id).filter((t) => t.wf?.planSha === tag.planSha).map((t) => t.id) }
  }, wf.sessionID)
}

export function approveWorkflow(
  deps: FlowRuntime,
  wf: Workflow,
  inputs: TaskInput[],
  opts: { queueRunning: boolean; planShaOk: boolean; mdShaOk: boolean; subject?: Subject; receiptRevision?: number },
  now = Date.now(),
): FlowResult {
  return withFlowTransaction(deps.worktree, (tx) => approveWorkflowIn(tx, deps, wf, inputs, opts, now), wf.sessionID)
}

// ---------------------------------------------------------------- stop protocol (pause / cancel)
/** Everything the stop protocol needs: the flow runtime plus an optional run store (read-only status when absent). */
export type StopDeps = FlowRuntime & { runs?: ExecutionRunStore }

/**
 * The one activity predicate. Synchronous and called inside the flow transaction. A stopped label needs every term
 * empty: queue, registry activity (queue/review/stage), stage reservation, broker permission wait, run claim and any
 * owned execution that is not terminal+quiescent (fenced, unknown and prepared-but-undispatched included).
 */
export function stopBlockers(deps: StopDeps, sessionID: string, epoch: string, queueRunning = false): string[] {
  const blockers: string[] = []
  if (queueRunning) blockers.push("queue is running")
  const activity = sessionActivityBlocker(deps.worktree, sessionID)
  if (activity) blockers.push(activity)
  try {
    if (pendingSkillPermissionActivityCount(deps.worktree, sessionID, epoch) > 0) blockers.push("skill permission wait is still settling")
  } catch { blockers.push("skill permission activity is unreadable") }
  try {
    const status = (deps.runs ?? createExecutionRunStore(deps.worktree)).status()
    if (status.claim) blockers.push("execution run claim is held")
    if (status.executions.some((execution) => execution.ownerSession === sessionID && !settled(execution))) blockers.push("owned execution is not terminal and quiescent")
  } catch { blockers.push("execution state is unreadable") }
  return blockers
}

/** Owner proof for a stop request (the persisted sid, current epoch and either pid or a live attachment). Throws a refusal. */
export function assertStopOwner(runtime: Pick<ExecutionRuntime, "worktree" | "host">, wf: WorkflowEnvelope, sessionID: string): void {
  if (wf.sessionID !== sessionID) throw new Error(`${wf.kind} workflow ${wf.id} is owned by session ${wf.sessionID}; use /resume ${wf.sessionID} to continue`)
  if (!isAttachmentEpoch(wf.owner.instance)) throw new Error("workflow owner has no verifiable attachment epoch")
  const owned = getOwnedSession(runtime.worktree, sessionID)
  if (owned) {
    const metadata = readSessionMetadata(runtime.worktree, sessionID)
    if (owned.epoch !== wf.owner.instance || wf.owner.pid !== process.pid || !metadata ||
        metadata.engine !== runtime.host.identity.engine || metadata.held !== owned.metadata.held) {
      throw new Error("cancellation owner does not match the attached session epoch")
    }
    owned.assertOwner()
    return
  }
  const metadata = readSessionMetadata(runtime.worktree, sessionID)
  const attachment = inspectSessionAttachment(runtime.worktree, sessionID, wf.owner.instance)
  if (!metadata || metadata.engine !== runtime.host.identity.engine || !attachment || attachment.state !== "attached" ||
      attachment.identity !== "live" || attachment.pid !== wf.owner.pid) {
    throw new Error("live owner attachment proof is unavailable; cancellation refused")
  }
}

type StopEligibility = { refuse: string } | { idempotent: true } | undefined

/** Precedence cancel > pause: a cancel is never refused by a pause; a pause is refused under a cancel. */
function stopEligibility(wf: WorkflowEnvelope, kind: StopKind): StopEligibility {
  if (TERMINAL.has(wf.phase)) return { refuse: `workflow is already ${wf.phase}` }
  if (kind === "cancel") return wf.stopIntent?.kind === "cancel" ? { idempotent: true } : undefined
  if (wf.stopIntent?.kind === "cancel") return { refuse: "cancellation is pending; pause refused" }
  if (wf.stopIntent?.kind === "pause") return { idempotent: true }
  if (wf.phase === "planning" || wf.phase === "reviewing" || wf.phase === "pending_approval" || wf.phase === "executing") return undefined
  const cause = wf.kind === "plan" ? wf.stuckCause : undefined
  return { refuse: `cannot pause a ${wf.phase}${cause ? `(${cause})` : ""} workflow` }
}

export type StopRequestOptions = { workflowID?: string; expectedRevision?: number; actor?: EventActor; now?: number }

type StopPartition = { done: string[]; residual: string[]; interrupted: Array<{ id: string; cause: string }> }

/**
 * Done/residual for a stop checkpoint, against the subject the stop protects (`stopSubjectOf`): plan and ultragoal
 * units are the tagged ledger tasks; an autoresearch experiment's residual is its remaining run ids. Stages with no
 * approved subject own no tasks.
 */
function stopPartition(worktree: string, wf: WorkflowEnvelope): StopPartition {
  const empty: StopPartition = { done: [], residual: [], interrupted: [] }
  if (wf.kind === "plan") return taskPartition(readLedger(worktree, wf.sessionID), wf.id, wf.planRef?.jsonSha ?? null)
  const subject = stopSubjectOf(wf)
  if (!subject) return empty
  if (wf.kind === "autoresearch") {
    const record = unitRecord(wf)
    return record ? { done: [...record.done], residual: [...record.remaining], interrupted: [] } : empty
  }
  return taskPartition(readLedger(worktree, wf.sessionID), wf.id, subject.sha256)
}

/** Transaction body of a stop request: intent (and, with no blockers, its settlement) is one commit. */
export function requestStopIn(
  tx: FlowTx, runtime: ExecutionRuntime, sessionID: string, kind: StopKind, reason: string, options: StopRequestOptions = {},
): AnyFlowResult & { idempotent?: boolean } {
  const fresh = readAnyWorkflowIn(tx, runtime)
  if (!fresh || fresh.sessionID !== sessionID) return { ok: false, text: "no workflow owned by this session", wf: fresh }
  const engineRefusal = workflowEngineRefusal(fresh, runtime.host.identity.engine)
  if (engineRefusal) return { ok: false, text: engineRefusal, wf: fresh }
  if (options.workflowID !== undefined && fresh.id !== options.workflowID) return { ok: false, text: "workflow changed meanwhile; stop and check /status", wf: fresh }
  if (options.expectedRevision !== undefined && fresh.lastSeq !== options.expectedRevision) return { ok: false, text: "workflow changed meanwhile; stop and check /status", wf: fresh }
  try { assertStopOwner(runtime, fresh, sessionID) } catch (error) { return { ok: false, text: (error as Error).message, wf: fresh } }
  const eligibility = stopEligibility(fresh, kind)
  if (eligibility && "refuse" in eligibility) return { ok: false, text: eligibility.refuse, wf: fresh }
  if (eligibility) return { ok: true, wf: fresh, idempotent: true }
  const actor = options.actor ?? "user_command"
  const now = options.now ?? Date.now()
  const prior = fresh.stopIntent
  const token = randomUUID()
  const requestedFrom = prior?.requestedFrom ?? { phase: fresh.phase, stage: fresh.stage }
  // Only the owning process can prove quiescence: process-local activity is invisible from another process.
  const ownedHere = getOwnedSession(runtime.worktree, sessionID)?.epoch === fresh.owner.instance
  // Only the owning process can see queue, review, stage, reservation and broker activity. A non-owner never settles:
  // it records the intent and the owner's observers (held idle branch, controller, TUI loop) prove quiescence.
  const blockers = ownedHere
    ? stopBlockers(runtime, sessionID, fresh.owner.instance, getQueue(runtime).isRunning(sessionID))
    : ["owner process settles"]
  const settledNow = blockers.length === 0
  // D3: the request checkpoint (and, when the same commit also settles, the settled one) is written before the
  // intent is published, so a crash leaves an orphan file and no intent that names missing bytes.
  // Planning kinds own no ledger tasks and no plan subject: their checkpoints carry null subject/plan and empty sets.
  const planFresh = fresh.kind === "plan" ? fresh : null
  const stopSubject = fresh.kind === "plan" ? planSubject(fresh) : stopSubjectOf(fresh)
  const partition = stopPartition(runtime.worktree, fresh)
  const planOf = planFresh?.planRef ? { jsonSha: planFresh.planRef.jsonSha, mdPath: planFresh.planRef.mdPath, mdSha: planFresh.planRef.mdSha } : null
  let checkpoint = writeCheckpoint(runtime.worktree, sessionID, token, {
    version: 1, kind: "request", wid: fresh.id, token, revision: fresh.lastSeq, requestedFrom,
    subject: stopSubject, plan: planOf,
    done: partition.done, residual: partition.residual,
  })
  if (settledNow) checkpoint = writeCheckpoint(runtime.worktree, sessionID, token, {
    version: 1, kind: "settled", wid: fresh.id, token, subject: stopSubject,
    plan: planOf,
    done: partition.done, residual: partition.residual,
    interrupted: partition.interrupted, worktree: worktreeDigest(runtime.worktree),
  })
  // The outcome record of a proven cancel is written before the settling commit, never as the proof (the snapshot check
  // inside cancelTaggedIdleIn needs the pre-commit revision).
  if (settledNow && kind === "cancel") cancelTaggedIdleIn(tx, runtime, fresh, token)
  const result = applyAnyEventIn(
    tx, runtime, fresh, kind, actor, { active: !settledNow },
    (w) => (w.stopIntent ? { ...w, stopIntent: { kind, token, requestedFrom, checkpoint, reason } } : w),
    { token, reason, ...(prior ? { replaces: prior.token } : {}) }, now,
    [
      (next) => ({ wf: next.id, type: "stop_requested", actor, data: { kind, token, reason, requestedFrom, ...(prior ? { replaces: prior.token } : {}) } }),
      ...(settledNow ? [(next: WorkflowEnvelope) => ({ wf: next.id, type: kind === "pause" ? "pause_settled" : "cancel_settled", actor: "code" as const, data: { token, observer: "request", proof: { claim: false, activity: false } } })] : []),
    ],
  )
  return result
}

export type StopRequest = { result: AnyFlowResult; token?: string; quiesce: Promise<void> }

/**
 * D1. Validate the owner, hold admission first, persist the intent, then cancel everything the owner holds with the
 * cause `workflow_<kind>:<token>`. Acknowledgements are evidence only: settlement is `settleOwned`, never this call.
 */
export function requestStop(runtime: ExecutionRuntime, sessionID: string, kind: StopKind, reason: string, options: StopRequestOptions = {}): StopRequest {
  const done = Promise.resolve()
  const refuse = (text: string, wf?: WorkflowEnvelope | null): StopRequest => ({ result: { ok: false, text, wf }, quiesce: done })
  let before: WorkflowEnvelope | null
  try { before = readAnyWorkflowChecked(runtime.worktree, sessionID).wf } catch (error) { return refuse((error as Error).message) }
  if (!before || before.sessionID !== sessionID) return refuse(before ? `${before.kind} workflow ${before.id} is owned by session ${before.sessionID}; use /resume ${before.sessionID} to continue` : "no active workflow", before)
  const engineRefusal = workflowEngineRefusal(before, runtime.host.identity.engine)
  if (engineRefusal) return refuse(engineRefusal, before)
  try { assertStopOwner(runtime, before, sessionID) } catch (error) { return refuse((error as Error).message, before) }
  const eligibility = stopEligibility(before, kind)
  if (eligibility && "refuse" in eligibility) return refuse(eligibility.refuse, before)
  if (eligibility) return { result: { ok: true, wf: before }, token: before.stopIntent?.token, quiesce: done }
  // A pause closes admission durably first (a crash after the hold and before the intent leaves the session held,
  // and only an explicit Resume clears it). A cancel closes admission through the intent itself: `effectiveHold` is
  // true while any stop is pending, and the session is admitted again once the cancelled workflow is terminal.
  try {
    const store = getOwnedSession(runtime.worktree, sessionID)
    if (kind === "pause" && store && !store.metadata.held) holdOwnedAdmission(runtime.worktree, sessionID, "workflow_pause")
  } catch (error) { return refuse(`admission hold failed; ${kind} refused: ${(error as Error).message}`, before) }
  const result = withFlowTransaction(runtime.worktree, (tx) => requestStopIn(tx, runtime, sessionID, kind, reason, options), sessionID)
  if (!result.ok || result.idempotent) return { result, token: result.ok ? result.wf.stopIntent?.token : undefined, quiesce: done }
  const intent = result.wf.stopIntent
  if (!intent || getOwnedSession(runtime.worktree, sessionID)?.epoch !== result.wf.owner.instance) return { result, token: intent?.token, quiesce: done }
  const cause = `workflow_${intent.kind}:${intent.token}`
  // Broker waits end with the admission they were granted under.
  cancelSkillPermissionActivities(runtime.worktree, sessionID, result.wf.owner.instance, new Error(`workflow ${intent.kind} requested`))
  const queue = getQueue(runtime)
  const work: Array<Promise<unknown>> = []
  if (queue.isRunning(sessionID)) work.push(queue.abort(sessionID, cause).catch(() => runtime.log("stop: queue abort failed", { sessionID })))
  abortSessionActivities(runtime.worktree, sessionID, cause)
  return { result, token: intent.token, quiesce: Promise.allSettled(work).then(() => {}) }
}

export type SettleRef = { sessionID: string; workflowID?: string; epoch?: string }
export type SettleOptions = {
  /** Only stop events may change lifecycle (repair under hold, observers); ordinary settlement is never attempted. */
  heldSafety?: boolean
  /** Observer mode: act only on a recorded stop intent. */
  stopOnly?: boolean
  queueRunning?: boolean
  now?: number
}
export type SettleOutcome =
  | { kind: "refused"; reason: string }
  | { kind: "none" }
  | { kind: "held" }
  | { kind: "waiting"; blockers: string[] }
  | { kind: "settled"; result: AnyFlowResult }

/**
 * D2. The single settlement routine. One transaction, no awaits: fresh read, owner gate, intent re-read from the
 * fresh record, then cancel > pause > ordinary settle with the full activity predicate. Old-epoch, foreign-sid or
 * stale-revision callers get `refused` and change nothing.
 */
export function settleOwnedIn(
  tx: FlowTx, deps: StopDeps, engine: string, ref: SettleRef, observer: string, options: SettleOptions = {},
): SettleOutcome {
  const wf = readAnyWorkflowIn(tx, deps)
  if (!wf || wf.sessionID !== ref.sessionID) return { kind: "refused", reason: "no workflow owned by this session" }
  if (ref.workflowID !== undefined && wf.id !== ref.workflowID) return { kind: "refused", reason: "workflow identity changed" }
  if (TERMINAL.has(wf.phase)) return { kind: "none" }
  const engineRefusal = workflowEngineRefusal(wf, engine)
  if (engineRefusal) return { kind: "refused", reason: engineRefusal }
  let store: SessionStore | undefined
  try { store = getOwnedSession(deps.worktree, ref.sessionID) }
  catch (error) { return { kind: "refused", reason: `session attachment is unavailable: ${(error as Error).message}` } }
  const epoch = ref.epoch ?? store?.epoch
  if (!store || store.sessionID !== ref.sessionID || !epoch || store.epoch !== epoch ||
      wf.owner.instance !== epoch || wf.owner.pid !== process.pid) return { kind: "refused", reason: "caller is not the current owner epoch" }
  try { store.assertOwner() } catch (error) { return { kind: "refused", reason: (error as Error).message } }
  const now = options.now ?? Date.now()
  const intent = wf.stopIntent
  if (intent?.kind === "cancel" || (intent?.kind === "pause" && wf.phase !== "paused")) {
    // A settled pause must leave the session held (Resume clears it); an unheld owner has not adopted the stop yet.
    if (intent.kind === "pause" && !store.metadata.held) return { kind: "waiting", blockers: ["admission is not held"] }
    const blockers = stopBlockers(deps, ref.sessionID, epoch, options.queueRunning ?? false)
    if (blockers.length > 0) return { kind: "waiting", blockers }
    const data = { token: intent.token, observer, proof: { claim: false, activity: false } }
    if (intent.kind === "cancel") {
      // The outcome record is written after the proof, never as the proof.
      cancelTaggedIdleIn(tx, deps, wf, intent.token)
      return { kind: "settled", result: applyAnyEventIn(tx, deps, wf, "cancel_settled", "code", { active: false }, (w) => w, data, now) }
    }
    // D3: the final done/residual (including reverted tasks) replaces the request reference in the same commit.
    const planWf = wf.kind === "plan" ? wf : null
    const partition = stopPartition(deps.worktree, wf)
    const checkpoint = writeCheckpoint(deps.worktree, wf.sessionID, intent.token, {
      version: 1, kind: "settled", wid: wf.id, token: intent.token, subject: wf.kind === "plan" ? planSubject(wf) : stopSubjectOf(wf),
      plan: planWf?.planRef ? { jsonSha: planWf.planRef.jsonSha, mdPath: planWf.planRef.mdPath, mdSha: planWf.planRef.mdSha } : null,
      done: partition.done, residual: partition.residual,
      interrupted: partition.interrupted, worktree: worktreeDigest(deps.worktree),
    })
    return { kind: "settled", result: applyAnyEventIn(tx, deps, wf, "pause_settled", "code", { active: false },
      (w) => (w.stopIntent ? { ...w, stopIntent: { ...w.stopIntent, checkpoint } } : w), { ...data, checkpoint }, now) }
  }
  if (intent || options.stopOnly) return { kind: "none" }
  if (options.heldSafety || effectiveHold(deps.worktree, ref.sessionID)) return { kind: "held" }
  if (wf.kind !== "plan" || wf.phase !== "executing") return { kind: "none" }
  const blockers = stopBlockers(deps, ref.sessionID, epoch, options.queueRunning ?? false)
  if (blockers.length > 0) return { kind: "waiting", blockers }
  const tasks = tasksForWorkflow(readLedger(deps.worktree, wf.sessionID), wf.id)
  const taskTally = tally(tasks)
  if (taskTally.open > 0 || taskTally.total === 0) return { kind: "none" }
  const stopped = tasks.some((x) => x.status === "cancelled" && /user_stop/.test(x.error ?? ""))
  if (stopped) return { kind: "settled", result: applyEventIn(tx, deps, wf, "user_stop", "code", {}, (w) => w, undefined, now) }
  return {
    kind: "settled",
    result: taskTally.failedOrCancelled > 0
      ? applyEventIn(tx, deps, wf, "settle_fail", "code", { tasks: taskTally }, (w) => w, { tally: taskTally }, now)
      : applyEventIn(tx, deps, wf, "settle_ok", "code", { tasks: taskTally }, (w) => w, { tally: taskTally }, now),
  }
}

const cancelSettledListeners = new Set<(sessionID: string) => void>()
/** Subscribe to committed cancel settlements (deletion retention ends the session once proof arrives). */
export function onCancelSettled(listener: (sessionID: string) => void): () => void {
  cancelSettledListeners.add(listener)
  return () => { cancelSettledListeners.delete(listener) }
}

/**
 * An owner observer that sees a stop it did not issue (another process ran `otter pause|cancel`) closes admission durably and
 * aborts broker waits before anything can settle: a settled pause must leave the session held so Resume can admit it.
 */
export function adoptForeignStop(runtime: ExecutionRuntime, ref: SettleRef): void {
  try {
    const wf = readAnyWorkflowChecked(runtime.worktree, ref.sessionID).wf
    const store = getOwnedSession(runtime.worktree, ref.sessionID)
    if (!wf || wf.sessionID !== ref.sessionID || !wf.stopIntent || !store || store.metadata.held) return
    if (wf.owner.instance !== store.epoch || wf.owner.pid !== process.pid) return
    // A recorded stop already makes the in-process token non-current. Only a pause is held durably (Resume clears it);
    // a cancel closes admission through the intent alone, so the session is admitted again once it is terminal.
    if (wf.stopIntent.kind === "pause") holdAdmission(runtime.worktree, ref.sessionID, "workflow_pause")
    cancelSkillPermissionActivities(runtime.worktree, ref.sessionID, store.epoch, new Error(`workflow ${wf.stopIntent.kind} requested`))
  } catch (error) {
    runtime.log("foreign stop adoption failed; settlement waits", { sessionID: ref.sessionID, error: (error as Error)?.message ?? String(error) })
  }
}

export function settleOwned(runtime: ExecutionRuntime, ref: SettleRef, observer: string, options: SettleOptions = {}): SettleOutcome {
  adoptForeignStop(runtime, ref)
  const outcome = withFlowTransaction(runtime.worktree, (tx) =>
    settleOwnedIn(tx, runtime, runtime.host.identity.engine, ref, observer, { queueRunning: getQueue(runtime).isRunning(ref.sessionID), ...options }), ref.sessionID)
  if (outcome.kind === "settled" && outcome.result.ok && outcome.result.wf.phase === "cancelled") {
    for (const listener of [...cancelSettledListeners]) {
      try { listener(ref.sessionID) } catch (error) { runtime.log("cancel settled listener failed", { error: String(error) }) }
    }
  }
  return outcome
}

// The queue cannot import this module (cycle), so its finally-observer is injected here.
onQueueSettled((runtime, sessionID) => { observeStopSettlement(runtime, sessionID, undefined, "queue") })
onQueueStopObserved((runtime, sessionID) => adoptForeignStop(runtime, { sessionID }))

/** Stop-only observer for `finally` blocks: never throws and never advances a workflow that has no stop intent. */
export function observeStopSettlement(runtime: ExecutionRuntime, sessionID: string, epoch: string | undefined, observer: string): SettleOutcome {
  try {
    return settleOwned(runtime, { sessionID, ...(epoch ? { epoch } : {}) }, observer, { stopOnly: true })
  } catch (error) {
    runtime.log("stop settlement observer failed", { sessionID, observer, error: (error as Error)?.message ?? String(error) })
    return { kind: "refused", reason: "settlement observer failed" }
  }
}

/**
 * Plugin-load repair is authorized against the fresh workflow while holding the transaction. A held session may only
 * receive stop-event safety settlement of its own recorded intent; it never gets review_aborted, quarantine or ordinary
 * settlement.
 */
function repairOnLoadIn(tx: FlowTx, deps: StopDeps, expectedEngine: string, isQueueRunning: (sessionID: string) => boolean): AnyFlowResult | null {
  const any = readAnyWorkflowIn(tx, deps)
  const wf = any && !TERMINAL.has(any.phase) ? any : null
  if (!wf) return null
  const engineRefusal = workflowEngineRefusal(wf, expectedEngine)
  if (engineRefusal) return { ok: false, text: engineRefusal, wf }
  const binding = workflowOwnerBinding(deps, wf)
  if (!binding.active) {
    if (!wf.stopIntent) return null
    const held = settleOwnedIn(tx, deps, expectedEngine, { sessionID: wf.sessionID, workflowID: wf.id }, "repair", {
      heldSafety: true, stopOnly: true, queueRunning: isQueueRunning(wf.sessionID),
    })
    return held.kind === "settled" ? held.result : null
  }
  const ctx = liveness(deps, Date.now(), wf)
  if (binding.store) ctx.instance = binding.store.epoch
  if (wf.owner.instance !== ctx.instance && ownerLive(wf, ctx)) return null
  if (wf.stopIntent) {
    const stop = settleOwnedIn(tx, deps, expectedEngine, { sessionID: wf.sessionID, workflowID: wf.id }, "repair", { stopOnly: true, queueRunning: isQueueRunning(wf.sessionID) })
    return stop.kind === "settled" ? stop.result : null
  }
  // Planning kinds have no review/approval repair: only a recorded stop is settled; stage turns restart from the stage.
  if (wf.kind !== "plan") return null
  if (wf.phase === "reviewing") return applyEventIn(tx, deps, wf, "review_aborted", "code", {}, (w) => ({ ...w, review: { verdict: "none", findings: [], planSha: w.planRef?.jsonSha ?? "", note: "aborted" } }), { repair: true })
  if (wf.phase === "pending_approval") {
    // Tagged tasks under a still-pending workflow are an approval that never reached the index. They are never
    // approval authority: quarantine them and leave the workflow pending for a fresh receipt.
    const now = Date.now()
    const quarantined = quarantineOrphanApprovalTagsIn(tx, deps, wf, now)
    return quarantined.length > 0 ? { ok: true, wf, note: `quarantined ${quarantined.length} uncommitted approval task(s); a fresh operator receipt is required` } : null
  }
  const settled = settleOwnedIn(tx, deps, expectedEngine, { sessionID: wf.sessionID, workflowID: wf.id }, "repair", { queueRunning: isQueueRunning(wf.sessionID) })
  return settled.kind === "settled" ? settled.result : null
}

export function repairOnLoad(deps: StopDeps, engine: string, isQueueRunning: (sessionID: string) => boolean = () => false, sessionID?: string): AnyFlowResult | null {
  return withFlowTransaction(deps.worktree, (tx) => repairOnLoadIn(tx, deps, engine, isQueueRunning), sessionID)
}

export { cancelOpen, DEFAULT_LIMITS }
