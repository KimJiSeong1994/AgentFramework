// Shared read model for `/status`, `otter_flow status`, and the SDK-free CLI.
import type { FlowRuntime } from "../hosts/types.ts"
import type { OtterConfig } from "../config.ts"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { claimPidAlive, createExecutionRunStore, settled, ExecutionRunCorruptError, type ExecutionRecord } from "../hosts/run-state.ts"
import { counts, emptyLedger, ledgerPath, openTasks, parseLedger, tasksForWorkflow, type Ledger, type LedgerTask } from "../state/ledger.ts"
import { EMPTY_MODE, modeStatePath, parseModeState, readBoundedJson, readDirectoryBounded, sessionDir, stateRoot, type ModeState } from "../state/store.ts"
import { epochReleased, heartbeatOf, INSTANCE_ID, ownerLive as workflowOwnerLive, pidAlive } from "./owner.ts"
import { isCancelPending, stopDisplay, type Phase, type StopDisplay, type WorkflowEnvelope } from "../workflows/types.ts"
import { describeArtifactsBudgeted } from "../workflows/artifacts.ts"
import { readCommitted, committedEventBound } from "../workflows/commit.ts"
import { parseEnvelope } from "../workflows/registry.ts"
import { ralplanReview } from "../workflows/ralplan-evidence.ts"
import { deepInterviewView, verifiedSpec } from "../workflows/deep-interview-driver.ts"
import { flowDir, readEventsTail, readHeartbeat } from "./state.ts"

type Workflow = WorkflowEnvelope

/** Truth-first deep-interview line: round, final ambiguity, threshold and source, panel record states and the spec, all recomputed from disk. */
function interviewReview(worktree: string, wf: WorkflowEnvelope): { plan?: string; review: string } {
  try {
    const view = deepInterviewView(wf as never, worktree)
    const panel = view.panel.length ? `; panel ${view.panel.map(item => `${item.persona} ${item.state}`).join(", ")}` : ""
    const spec = wf.phase === "done" ? verifiedSpec(worktree, wf as never) : undefined
    const specText = spec ? (spec.ok ? `; spec verified (${spec.path})` : `; spec incomplete: ${spec.reason}`) : ""
    const ambiguity = view.ambiguity === undefined ? "ambiguity not scored" : `ambiguity ${Number(view.ambiguity.toFixed(4))} (${view.band})`
    const early = view.earlyExit ? `; early exit: ${view.earlyExit}` : ""
    return {
      ...(spec?.ok ? { plan: spec.path } : {}),
      review: `round ${view.round}; ${ambiguity}; threshold ${view.threshold} (${view.thresholdSource})${panel}${early}${specText}; records ${view.evidenceOk ? "verified" : view.evidence}`,
    }
  } catch { return { review: "interview state unreadable" } }
}

export const STATUS_MARKER = "[otter status]"

export function flowOn(config: OtterConfig): boolean {
  return config.flow.enabled && !config.disabled_hooks.includes("flow")
}

export type StatusSource = "workflow" | "ledger" | "mode" | "execution" | "events" | "detail"
export type StatusErrorCode = "invalid_state" | "unreadable" | "oversize"
export class StatusReadError extends Error {
  constructor(readonly source: StatusSource, readonly code: StatusErrorCode, readonly bytesRead = 0) {
    super(`status unavailable: ${source} ${code}`)
    this.name = "StatusReadError"
  }
}

export type QueueState = "running_here" | "running_elsewhere" | "stale" | "blocked" | "idle" | "unknown"
type QueueInput = {
  sessionID?: string
  inProcess?: boolean
  running?: Ledger["running"]
  taskStatus?: LedgerTask["status"]
  openTaskCount: number
  claim?: { ownerSession: string; pid: number }
  claimLive: boolean
  sameProcess: boolean
  executions: ExecutionRecord[]
  workflowPhase?: string
  workflowSessionID?: string
  now: number
}
export type QueueProjection = {
  state: QueueState
  evidence: string
  flag: "true" | "false" | "absent"
  taskId?: string
  since?: number
  ageMs?: number
  hint?: string
}

/** Pure classifier; uncertainty and fenced work are never presented as idle or proven progress. */
export function classifyQueue(input: QueueInput): QueueProjection {
  const flag = input.inProcess === undefined ? "absent" : input.inProcess ? "true" : "false"
  const sessionID = input.sessionID
  const running = input.running
  const ownerClaim = !!sessionID && input.claim?.ownerSession === sessionID ? input.claim : undefined
  const pidLive = !!ownerClaim && input.claimLive
  const here = !!ownerClaim && input.sameProcess
  const owned = input.executions.filter(e => e.ownerSession === sessionID)
  const unresolved = owned.filter(e => !settled(e))
  const fenced = unresolved.some(e => !!e.fence || !!e.reconciliation)
  const cancelledOnly = unresolved.some(e => !!e.cancel && !e.fence && !e.reconciliation)
  const taskId = running?.taskId
  const since = running?.since
  const ageMs = since === undefined ? undefined : Math.max(0, input.now - since)
  const withRunning = (state: QueueState, evidence: string, hint?: string): QueueProjection => ({
    state, evidence, flag, ...(taskId ? { taskId: safeDisplay(taskId, 80) } : {}), ...(since !== undefined ? { since, ageMs } : {}), ...(hint ? { hint } : {}),
  })
  if (!sessionID) return withRunning("unknown", "no_session", "pass --session")
  if (input.inProcess === true) return withRunning("running_here", "in_process_flag")
  if (ownerClaim && fenced) return withRunning("blocked", "claim_retained_unresolved", "resume re-attempts reconciliation; it refuses if quiescence cannot be proven")
  if (ownerClaim && !pidLive && unresolved.length) return withRunning("blocked", "dead_owner_unresolved", "resume re-attempts reconciliation; it refuses if quiescence cannot be proven")
  if (running && ownerClaim && pidLive && !here && input.taskStatus === "running") {
    return withRunning("running_elsewhere", `claim_pid_alive${cancelledOnly ? "+cancel_requested" : ""}`)
  }
  if (running && ownerClaim && pidLive && here) {
    const noOpenTasks = input.taskStatus !== "running" && input.openTaskCount === 0
    return withRunning("stale", `claim_retained_here_inactive${noOpenTasks ? "+no_open_tasks" : ""}`, noOpenTasks ? undefined : "resume")
  }
  if (running && ownerClaim && pidLive && input.taskStatus !== "running") {
    const noOpenTasks = input.openTaskCount === 0
    return withRunning("stale", `running_pointer_orphaned${noOpenTasks ? "+no_open_tasks" : ""}`, noOpenTasks ? undefined : "resume runs the pending work; the pointer is replaced at the next task start")
  }
  if (running && ownerClaim && !pidLive) {
    const noOpenTasks = input.taskStatus !== "running" && input.openTaskCount === 0
    return withRunning("stale", `claim_pid_dead${noOpenTasks ? "+no_open_tasks" : ""}`, noOpenTasks ? undefined : "resume")
  }
  if (running && !ownerClaim) {
    const noOpenTasks = input.taskStatus !== "running" && input.openTaskCount === 0
    return withRunning("stale", `running_without_matching_claim${noOpenTasks ? "+no_open_tasks" : ""}`,
      input.openTaskCount > 0 ? "resume runs the pending work; the pointer is replaced at the next task start" : undefined)
  }
  if (!running && ownerClaim && pidLive) return withRunning("unknown", `claim_alive_no_task${cancelledOnly ? "+cancel_requested" : ""}${input.workflowSessionID === sessionID && input.workflowPhase === "reviewing" ? "+phase_reviewing" : ""}`)
  const evidence = input.claim && input.claim.ownerSession !== sessionID ? "claim_other_session" : ownerClaim ? "claim_pid_dead" : "no_running"
  return withRunning("idle", evidence)
}

export type StatusJson = {
  schemaVersion: 1
  generatedAt: number
  workflow: null | {
    id: string; phase: string; stuckCause?: string; sessionID: string; ownerLive: boolean
    engine?: string; planSha?: string
    plan?: string; review?: string; tasks?: { total: number; done: number; open: number; failed: number }
    /** Plan only; planning kinds have no counters. */
    counters?: { code_invalid: number; review_iterations: number; user_rejections: number; nudges: number }; pendingCancel: boolean
    /** Truth-first stop presentation: paused only after the settled pause; pending stops stay "unconfirmed". */
    stop: StopDisplay; pausedFrom?: { phase: string; stage: string }
    /** Generic view (R7): committed envelope facts, not plan authority. */
    kind: string; stage: string; revision: number; stopIntent: "pause" | "cancel" | null
    /** Recomputed from disk on every read; never a stored verified flag. */
    artifacts: Array<{ key: string; path: string; state: "verified" | "present-unhashed" | "incomplete" | "unverified" }>
    /** Refs beyond the status read budget; they were not read at all. */
    artifactsOmitted?: number
  }
  session: { id: string; source: "arg" | "workflow" | "none"; mode: string; modeActive: boolean; queueRunning: boolean; queue: QueueProjection; ledger: Record<string, number> }
  execution: { generation: number; ownerSessionID?: string; unresolved: number; cancelledAcknowledged: number; usage: "unknown"; verification?: string; claim?: { ownerSessionID: string; sameSession: boolean; pid: number; pidAlive: boolean; sameProcess: boolean } }
  freshness: { workflowUpdatedAt?: number; ledgerUpdatedAt?: number; ownerHeartbeatAgeMs?: number; staleAfterMs: 90000; eventsWindowTruncated: boolean }
  events: Array<{ seq: number; type: string; to?: string }>
  detail?: { tasks: Array<Record<string, unknown>>; sessions: Array<Record<string, unknown>>; history: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; truncated: Record<string, number>; truncatedTasks?: number; sessionsScanTruncated?: boolean; archivesScanTruncated?: boolean; budgetExhausted?: boolean }
}

export type StatusLiveness = { instance?: string; ownerPidAlive?: (pid: number) => boolean; claimPidAlive?: (pid: number) => boolean; epochReleased?: (wf: Workflow) => boolean }
export type StatusOptions = { queueRunning?: boolean; sessionSource?: "arg" | "workflow" | "none"; detail?: boolean; now?: number; liveness?: StatusLiveness }

const STATUS_INTERNAL = Symbol("status-internal")
type StatusInternal = { worktree: string; queue: QueueInput; workflow?: Workflow; heartbeatAt?: number; liveness: StatusLiveness; bytesRead: number }

export function statusBytesRead(status: StatusJson): number {
  return (status as StatusJson & { [STATUS_INTERNAL]?: StatusInternal })[STATUS_INTERNAL]?.bytesRead ?? 0
}

export const STATUS_LIMITS = {
  workflow: 256 * 1024,
  mode: 64 * 1024,
  ledger: 4 * 1024 * 1024,
  execution: 4 * 1024 * 1024,
  events: 64 * 1024,
  extraLedger: 1024 * 1024,
  archive: 256 * 1024,
  detailOutput: 64 * 1024,
  detailInput: 8 * 1024 * 1024,
  sessionsEntries: 500,
  sessionsCount: 20,
  taskCount: 50,
  historyCount: 10,
  archiveEntries: 1000,
} as const

function safeDisplay(value: string, max = 160): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
}

function nativeFsError(error: unknown): error is NodeJS.ErrnoException & Error {
  if (!(error instanceof Error)) return false
  const fsError = error as NodeJS.ErrnoException
  return typeof fsError.errno === "number" && typeof fsError.syscall === "string" && typeof fsError.code === "string"
}

function missingFsError(error: unknown): boolean {
  return nativeFsError(error) && error.code === "ENOENT"
}

function oversizeError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "oversize"
}

function unreadableSentinel(error: unknown): boolean {
  return error instanceof Error && error.message === "unreadable" && (error as NodeJS.ErrnoException).code === "unreadable"
}

function errorBytesRead(error: unknown): number {
  if (!(error instanceof Error)) return 0
  const bytesRead = (error as Error & { bytesRead?: unknown }).bytesRead
  return typeof bytesRead === "number" && Number.isSafeInteger(bytesRead) && bytesRead >= 0 ? bytesRead : 0
}

function invalidStateError(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message
}

function readValue(path: string, source: StatusSource, maxBytes: number): { value: unknown | undefined; bytesRead: number } {
  try { return readBoundedJson(path, maxBytes) }
  catch (error) {
    if (oversizeError(error)) throw new StatusReadError(source, "oversize", errorBytesRead(error))
    if (error instanceof SyntaxError) throw new StatusReadError(source, "invalid_state", errorBytesRead(error))
    if (nativeFsError(error) || unreadableSentinel(error)) throw new StatusReadError(source, "unreadable", errorBytesRead(error))
    throw error
  }
}

function workflowAt(worktree: string, sessionID?: string): { workflow: Workflow | null; bytesRead: number } {
  const committed = readCommitted(worktree, { index: STATUS_LIMITS.workflow, snapshot: STATUS_LIMITS.workflow }, sessionID)
  switch (committed.state) {
    case "none": return { workflow: null, bytesRead: 0 }
    // A terminal pre-v2 record is retained history, not a current workflow. A non-terminal one is unreadable here
    // by design (read-only, no conversion): status reports invalid_state and never guesses at its authority.
    case "legacy":
      if (committed.terminal) return { workflow: null, bytesRead: committed.bytesRead }
      throw new StatusReadError("workflow", "invalid_state", committed.bytesRead)
    case "corrupt": throw new StatusReadError("workflow", committed.code === "invalid" ? "invalid_state" : committed.code, committed.bytesRead)
    case "ok":
      return { workflow: committed.wf, bytesRead: committed.bytesRead }
  }
}

function statusLedger(worktree: string, sessionID: string): { ledger: Ledger; bytesRead: number } {
  const { value, bytesRead } = readValue(ledgerPath(worktree, sessionID), "ledger", STATUS_LIMITS.ledger)
  if (value === undefined) return { ledger: emptyLedger(sessionID), bytesRead }
  try { return { ledger: parseLedger(value, sessionID), bytesRead } }
  catch (error) {
    if (invalidStateError(error, "invalid ledger state")) throw new StatusReadError("ledger", "invalid_state", bytesRead)
    throw error
  }
}

function statusMode(worktree: string, sessionID: string): { mode: ModeState; bytesRead: number } {
  const { value, bytesRead } = readValue(modeStatePath(worktree, sessionID), "mode", STATUS_LIMITS.mode)
  if (value === undefined) return { mode: EMPTY_MODE, bytesRead }
  try { return { mode: parseModeState(value), bytesRead } }
  catch (error) {
    if (invalidStateError(error, "invalid mode state")) throw new StatusReadError("mode", "invalid_state", bytesRead)
    throw error
  }
}

function detailTask(task: LedgerTask): Record<string, unknown> {
  const verify = task.verify_result
  const verdict = task.review?.verdict
  const outcome = task.blocked !== undefined ? "blocked" : verify?.timedOut ? "verify_timeout" : verify?.ok === false ? "verify_failed" :
    verdict === "reject" ? "review_rejected" : verdict === "error" ? "review_error" : task.status === "cancelled" ? "cancelled" : task.status === "failed" ? "failed_other" : undefined
  return {
    id: safeDisplay(task.id, 80), n: task.n, batch: task.batch, status: task.status, attempts: task.attempts, kind: task.kind ?? "code",
    ...(task.wf ? { wfId: safeDisplay(task.wf.id, 80) } : {}), title: task.wf ? safeDisplay(task.title ?? "", 80) : "unapproved task", createdAt: task.createdAt,
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}), ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(verify ? { verify: { ok: verify.ok, exitCode: verify.exitCode, timedOut: verify.timedOut } } : {}),
    ...(task.review ? { review: { verdict: task.review.verdict } } : {}), ...(outcome ? { outcome } : {}),
    ...(task.filesChanged ? { filesChangedCount: task.filesChanged.length } : {}), blocked: task.blocked !== undefined,
  }
}

function detailView(worktree: string, sessionID: string, ownerSessionID: string | undefined, ledger: Ledger, events: ReturnType<typeof readEventsTail>["events"]): { detail: NonNullable<StatusJson["detail"]>; bytesRead: number } {
  const truncated: Record<string, number> = {}
  const tasks = ledger.tasks.slice(-STATUS_LIMITS.taskCount).map(detailTask)
  const truncatedTasks = Math.max(0, ledger.tasks.length - tasks.length)
  if (truncatedTasks) truncated.tasks = truncatedTasks
  let extraBytes = 0
  let budgetExhausted = false
  const sessions: Array<Record<string, unknown>> = []
  const sessionRoot = join(stateRoot(worktree), "sessions")
  let sessionNames: string[] = []
  let sessionsScanTruncated = false
  try {
    const scan = readDirectoryBounded(sessionRoot, STATUS_LIMITS.sessionsEntries)
    sessionNames = scan.entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    sessionsScanTruncated = scan.truncated
  } catch (error) {
    if (!missingFsError(error)) {
      if (nativeFsError(error)) throw new StatusReadError("ledger", "unreadable", extraBytes)
      throw error
    }
  }
  const candidates = sessionNames.filter(id => id !== sessionID && id !== ownerSessionID).map(id => {
    try { return { id, mtime: statSync(ledgerPath(worktree, id)).mtimeMs } }
    catch (error) {
      if (missingFsError(error)) return { id, mtime: 0 }
      if (nativeFsError(error)) throw new StatusReadError("ledger", "unreadable", extraBytes)
      throw error
    }
  }).sort((a, b) => b.mtime - a.mtime).slice(0, STATUS_LIMITS.sessionsCount)
  for (const { id } of candidates) {
    const remaining = STATUS_LIMITS.detailInput - extraBytes
    if (remaining <= 0) { budgetExhausted = true; break }
    const path = ledgerPath(worktree, id)
    try {
      const size = statSync(path).size
      if (size > STATUS_LIMITS.extraLedger) { sessions.push({ id: safeDisplay(id, 256), oversize: true }); continue }
      if (size > remaining) { budgetExhausted = true; break }
      const { value, bytesRead } = readBoundedJson(path, Math.min(STATUS_LIMITS.extraLedger, remaining))
      extraBytes += bytesRead
      if (value === undefined) continue
      const other = parseLedger(value, id)
      sessions.push({ id: safeDisplay(id, 256), counts: counts(other), updatedAt: other.updatedAt, ...(other.running ? { running: { taskId: safeDisplay(other.running.taskId, 80), since: other.running.since } } : {}) })
    } catch (error) {
      extraBytes += errorBytesRead(error)
      if (missingFsError(error)) continue
      if (oversizeError(error) && remaining < STATUS_LIMITS.extraLedger) { budgetExhausted = true; break }
      if (oversizeError(error)) sessions.push({ id: safeDisplay(id, 256), oversize: true })
      else if (error instanceof SyntaxError || invalidStateError(error, "invalid ledger state")) truncated.invalidSessions = (truncated.invalidSessions ?? 0) + 1
      else if (nativeFsError(error) || unreadableSentinel(error)) throw new StatusReadError("ledger", "unreadable", extraBytes)
      else throw error
    }
  }
  const history: Array<Record<string, unknown>> = []
  const archiveDir = join(flowDir(worktree, sessionID), "archive")
  let archiveNames: string[] = []
  let archivesScanTruncated = false
  try {
    const scan = readDirectoryBounded(archiveDir, STATUS_LIMITS.archiveEntries)
    archiveNames = scan.entries.map(entry => entry.name).filter(name => name.endsWith(".json")).sort()
    archivesScanTruncated = scan.truncated
  } catch (error) {
    if (!missingFsError(error)) {
      if (nativeFsError(error)) throw new StatusReadError("workflow", "unreadable", extraBytes)
      throw error
    }
  }
  for (const name of archiveNames.slice(-STATUS_LIMITS.historyCount)) {
    const remaining = STATUS_LIMITS.detailInput - extraBytes
    if (remaining <= 0) { budgetExhausted = true; break }
    try {
      const path = join(archiveDir, name)
      const size = statSync(path).size
      if (size > STATUS_LIMITS.archive) { truncated.archives = (truncated.archives ?? 0) + 1; continue }
      if (size > remaining) { budgetExhausted = true; break }
      const { value, bytesRead } = readBoundedJson(path, Math.min(STATUS_LIMITS.archive, remaining))
      extraBytes += bytesRead
      if (value === undefined) continue
      const archived = parseEnvelope(value)
      history.push({ id: safeDisplay(archived.id, 256), phase: archived.phase, createdAt: archived.createdAt, updatedAt: archived.updatedAt })
    } catch (error) {
      extraBytes += errorBytesRead(error)
      if (missingFsError(error)) continue
      if (oversizeError(error) && remaining < STATUS_LIMITS.archive) { budgetExhausted = true; break }
      if (oversizeError(error) || error instanceof SyntaxError || invalidStateError(error, "invalid workflow state")) {
        truncated.archives = (truncated.archives ?? 0) + 1
      } else if (nativeFsError(error) || unreadableSentinel(error)) throw new StatusReadError("workflow", "unreadable", extraBytes)
      else throw error
    }
  }
  const result: NonNullable<StatusJson["detail"]> = {
    tasks, sessions, history, events: events.slice(-20).map(event => ({ seq: event.seq, type: safeDisplay(event.type, 80), at: event.at, ...(event.to ? { to: safeDisplay(event.to, 80) } : {}) })), truncated,
    ...(truncatedTasks ? { truncatedTasks } : {}),
    ...(sessionsScanTruncated ? { sessionsScanTruncated: true } : {}),
    ...(archivesScanTruncated ? { archivesScanTruncated: true } : {}),
    ...(budgetExhausted ? { budgetExhausted: true } : {}),
  }
  const dropOrder: Array<keyof Pick<NonNullable<StatusJson["detail"]>, "events" | "history" | "sessions" | "tasks">> = ["events", "history", "sessions", "tasks"]
  for (const key of dropOrder) {
    if (Buffer.byteLength(JSON.stringify(result)) <= STATUS_LIMITS.detailOutput) break
    result.truncated[key] = (result.truncated[key] ?? 0) + result[key].length
    result[key] = []
  }
  if (Buffer.byteLength(JSON.stringify(result)) > STATUS_LIMITS.detailOutput) throw new StatusReadError("detail", "oversize", extraBytes)
  return { detail: result, bytesRead: extraBytes }
}

export function statusJson(deps: FlowRuntime, sessionID?: string, options: StatusOptions = {}): StatusJson {
  const now = options.now ?? Date.now()
  let bytesRead = 0
  const accumulate = <T extends { bytesRead: number }>(read: () => T): T => {
    try {
      const result = read()
      bytesRead += result.bytesRead
      return result
    } catch (error) {
      if (error instanceof StatusReadError) throw new StatusReadError(error.source, error.code, bytesRead + error.bytesRead)
      throw error
    }
  }
  const wfRead = accumulate(() => workflowAt(deps.worktree, sessionID))
  const wf = wfRead.workflow
  const resolvedSession = sessionID ?? wf?.sessionID
  const sessionSource = options.sessionSource ?? (sessionID ? "arg" : resolvedSession ? "workflow" : "none")
  const id = resolvedSession ?? "no-session"
  const ledgerRead = resolvedSession ? accumulate(() => statusLedger(deps.worktree, id)) : { ledger: emptyLedger(id), bytesRead: 0 }
  const modeRead = resolvedSession ? accumulate(() => statusMode(deps.worktree, id)) : { mode: EMPTY_MODE, bytesRead: 0 }
  const runStore = createExecutionRunStore(deps.worktree)
  let runRead: ReturnType<typeof runStore.statusBounded>
  try { runRead = runStore.statusBounded(STATUS_LIMITS.execution) }
  catch (error) {
    if (oversizeError(error)) throw new StatusReadError("execution", "oversize", bytesRead + errorBytesRead(error))
    if (error instanceof ExecutionRunCorruptError) throw new StatusReadError("execution", "invalid_state", bytesRead + errorBytesRead(error))
    if (nativeFsError(error) || unreadableSentinel(error)) throw new StatusReadError("execution", "unreadable", bytesRead + errorBytesRead(error))
    throw error
  }
  const run = runRead.status
  bytesRead += runRead.bytesRead
  const unresolved = run.executions.filter(execution => !settled(execution))
  let workflow: StatusJson["workflow"] = null
  let heartbeatAt: number | undefined
  let workflowLedger = ledgerRead.ledger
  if (wf) {
    if (wf.sessionID !== id) {
      const ownerRead = accumulate(() => statusLedger(deps.worktree, wf.sessionID))
      workflowLedger = ownerRead.ledger
    }
    heartbeatAt = readHeartbeat(deps.worktree, wf, wf.sessionID)
    const live = workflowOwnerLive(wf, {
      now, instance: options.liveness?.instance ?? INSTANCE_ID, pidAlive: options.liveness?.ownerPidAlive ?? pidAlive,
      epochReleased: options.liveness?.epochReleased ?? epochReleased(deps.worktree),
      heartbeatAt: () => heartbeatAt,
    })
    const plan = wf.kind === "plan" ? wf : undefined
    const tagged = plan ? tasksForWorkflow(workflowLedger, wf.id) : []
    const engine = typeof wf.engine === "string" && wf.engine.length > 0 && wf.engine.length <= 512 ? safeDisplay(wf.engine, 512) : undefined
    const planSha = typeof plan?.planRef?.jsonSha === "string" && /^[a-f0-9]{64}$/.test(plan.planRef.jsonSha) ? plan.planRef.jsonSha : undefined
    const budgeted = describeArtifactsBudgeted(deps.worktree, plan ?? wf)
    const ralplanView = wf.kind === "ralplan" ? ralplanReview(deps.worktree, wf) : undefined
    const interviewView = wf.kind === "deep-interview" ? interviewReview(deps.worktree, wf) : undefined
    workflow = {
      id: safeDisplay(wf.id, 256), phase: wf.phase, ...(plan?.stuckCause ? { stuckCause: plan.stuckCause } : {}), sessionID: safeDisplay(wf.sessionID, 256), ownerLive: live,
      ...(engine ? { engine } : {}), ...(planSha ? { planSha } : {}),
      ...(plan?.planRef ? { plan: safeDisplay(plan.planRef.mdPath, 1024) } : {}), ...(plan?.review ? { review: safeDisplay(`${plan.review.verdict}${plan.review.note ? ` (${plan.review.note})` : ""}`, 512) } : {}),
      ...(interviewView ? { ...(interviewView.plan ? { plan: safeDisplay(interviewView.plan, 1024) } : {}), review: safeDisplay(interviewView.review, 512) } : {}),
      ...(ralplanView ? { ...(ralplanView.plan ? { plan: safeDisplay(ralplanView.plan, 1024) } : {}), review: safeDisplay(ralplanView.review, 512) } : {}),
      ...(tagged.length ? { tasks: {
        total: tagged.length, done: tagged.filter(task => task.status === "done").length,
        open: tagged.filter(task => task.status === "pending" || task.status === "running").length,
        failed: tagged.filter(task => task.status === "failed" || task.status === "cancelled").length,
      } } : {}),
      ...(plan ? { counters: {
        code_invalid: plan.counters.code_invalid, review_iterations: plan.counters.review_iterations,
        user_rejections: plan.counters.user_rejections, nudges: plan.counters.nudges,
      } } : {}), pendingCancel: isCancelPending(wf), stop: stopDisplay(wf),
      ...(wf.pausedFrom ? { pausedFrom: { phase: safeDisplay(wf.pausedFrom.phase, 32), stage: safeDisplay(wf.pausedFrom.stage, 64) } } : {}),
      kind: safeDisplay(wf.kind, 64), stage: safeDisplay(wf.stage, 64), revision: wf.lastSeq, stopIntent: wf.stopIntent?.kind ?? null,
      artifacts: budgeted.items.map(item => ({ key: safeDisplay(item.key, 128), path: safeDisplay(item.path, 1024), state: item.state })),
      ...(budgeted.omitted > 0 ? { artifactsOmitted: budgeted.omitted } : {}),
    }
  }
  const selectedTask = ledgerRead.ledger.running
  const taskStatus = selectedTask ? ledgerRead.ledger.tasks.find(task => task.id === selectedTask.taskId)?.status : undefined
  const sessionExecutions = run.executions.filter(execution => execution.ownerSession === resolvedSession)
  const queueInput: QueueInput = {
    ...(resolvedSession ? { sessionID: resolvedSession } : {}), inProcess: options.queueRunning,
    running: selectedTask, taskStatus, openTaskCount: openTasks(ledgerRead.ledger).length,
    claim: run.claim, claimLive: !!run.claim && (options.liveness?.claimPidAlive ?? claimPidAlive)(run.claim.pid), sameProcess: !!run.claim && run.claim.pid === process.pid,
    executions: sessionExecutions, workflowPhase: wf?.phase, workflowSessionID: wf?.sessionID, now,
  }
  const queue = classifyQueue(queueInput)
  const eventsRead = wf ? accumulate(() => {
    try { return readEventsTail(deps.worktree, { wfId: wf.id, limit: 20, maxBytes: STATUS_LIMITS.events, bound: committedEventBound(deps.worktree, wf.sessionID) }, wf.sessionID) }
    catch (error) {
      if (nativeFsError(error) || unreadableSentinel(error)) throw new StatusReadError("events", "unreadable", errorBytesRead(error))
      throw error
    }
  }) : { events: [], windowTruncated: false, bytesRead: 0 }
  const session: StatusJson["session"] = {
    id: safeDisplay(id, 256), source: sessionSource, mode: modeRead.mode.mode, modeActive: modeRead.mode.active,
    queueRunning: queue.state === "running_here" || queue.state === "running_elsewhere", queue,
    ledger: counts(ledgerRead.ledger),
  }
  const claim = run.claim
  const passedLegacy = run.executions.find(execution => execution.ownerSession === id && execution.kind === "verifier" && execution.profile === "legacy-unowned" &&
    execution.descendantRisk === "unproven" && execution.terminal?.outcome === "ok" && execution.terminal.verification?.integrity === "unchanged" &&
    ledgerRead.ledger.tasks.some(task => task.id === execution.taskId && task.status === "done"))
  const status: StatusJson = {
    schemaVersion: 1, generatedAt: now, workflow,
    session,
    execution: {
      generation: run.generation, ...(claim ? { ownerSessionID: safeDisplay(claim.ownerSession, 256) } : {}), unresolved: unresolved.length,
      cancelledAcknowledged: unresolved.filter(execution => execution.cancel?.acknowledgedAt !== undefined).length,
      usage: "unknown", ...(claim ? { claim: { ownerSessionID: safeDisplay(claim.ownerSession, 256), sameSession: claim.ownerSession === id,
        pid: claim.pid, pidAlive: (options.liveness?.claimPidAlive ?? claimPidAlive)(claim.pid), sameProcess: claim.pid === process.pid } } : {}),
      ...(passedLegacy ? { verification: "passed (legacy-unowned, descendants unproven)" } : {}),
    },
    freshness: {
      ...(wf ? { workflowUpdatedAt: wf.updatedAt, ownerHeartbeatAgeMs: Math.max(0, now - heartbeatOf(wf, { heartbeatAt: () => heartbeatAt })) } : {}),
      ...(resolvedSession && ledgerRead.bytesRead > 0 ? { ledgerUpdatedAt: ledgerRead.ledger.updatedAt } : {}), staleAfterMs: 90_000, eventsWindowTruncated: eventsRead.windowTruncated,
    },
    events: eventsRead.events.slice(-5).map(event => ({ seq: event.seq, type: safeDisplay(event.type, 80), ...(event.to ? { to: safeDisplay(event.to, 80) } : {}) })),
  }
  if (options.detail) {
    const detail = accumulate(() => detailView(deps.worktree, id, wf?.sessionID, ledgerRead.ledger, eventsRead.events))
    status.detail = detail.detail
  }
  Object.defineProperty(status, STATUS_INTERNAL, { value: { worktree: deps.worktree, queue: queueInput, liveness: options.liveness ?? {}, bytesRead, ...(wf ? { workflow: wf } : {}), ...(heartbeatAt !== undefined ? { heartbeatAt } : {}) } satisfies StatusInternal })
  try { capStatusDetail(status) }
  catch (error) {
    if (error instanceof StatusReadError) throw new StatusReadError(error.source, error.code, bytesRead + error.bytesRead)
    throw error
  }
  return status
}

function capStatusDetail(status: StatusJson): void {
  if (!status.detail) return
  const keys: Array<keyof Pick<NonNullable<StatusJson["detail"]>, "events" | "history" | "sessions" | "tasks">> = ["events", "history", "sessions", "tasks"]
  for (const key of keys) {
    if (Buffer.byteLength(JSON.stringify(status)) <= STATUS_LIMITS.detailOutput) return
    status.detail.truncated[key] = (status.detail.truncated[key] ?? 0) + status.detail[key].length
    status.detail[key] = []
  }
  if (Buffer.byteLength(JSON.stringify(status)) > STATUS_LIMITS.detailOutput) throw new StatusReadError("detail", "oversize")
}

/** Re-evaluate only OS/clock liveness from the previous parsed snapshot; no disk reads occur. */
export function refreshStatusLiveness(status: StatusJson, now: number, livenessOverride?: StatusLiveness): StatusJson {
  const internal = (status as StatusJson & { [STATUS_INTERNAL]?: StatusInternal })[STATUS_INTERNAL]
  if (!internal) return status
  const liveness = { ...internal.liveness, ...livenessOverride }
  status.generatedAt = now
  if (internal.workflow) {
    status.workflow!.ownerLive = workflowOwnerLive(internal.workflow, {
      now, instance: liveness.instance ?? INSTANCE_ID,
      pidAlive: liveness.ownerPidAlive ?? pidAlive,
      epochReleased: liveness.epochReleased ?? epochReleased(internal.worktree),
      heartbeatAt: () => internal.heartbeatAt,
    })
    status.freshness.ownerHeartbeatAgeMs = Math.max(0, now - heartbeatOf(internal.workflow, { heartbeatAt: () => internal.heartbeatAt }))
  }
  const claim = status.execution.claim
  if (claim) {
    claim.pidAlive = (liveness.claimPidAlive ?? claimPidAlive)(claim.pid)
    internal.queue.claimLive = claim.pidAlive
  }
  internal.queue.now = now
  status.session.queue = classifyQueue(internal.queue)
  status.session.queueRunning = status.session.queue.state === "running_here" || status.session.queue.state === "running_elsewhere"
  return status
}

function queueWord(state: QueueState): string {
  return ({ running_here: "running", running_elsewhere: "running elsewhere", idle: "idle", stale: "stale", blocked: "blocked", unknown: "unknown" })[state]
}

/** Exhaustive over Phase: a new phase fails compilation here instead of rendering as a raw literal. */
export const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  planning: "planning", reviewing: "reviewing", pending_approval: "pending_approval", executing: "executing",
  stuck: "stuck", paused: "paused", done: "done", cancelled: "cancelled",
}

/** Exhaustive over StopDisplay: a new display value fails compilation here. `paused` also names the phase it came from. */
export const STOP_LABEL: Readonly<Record<StopDisplay, string>> = {
  none: "",
  pausing: "pausing — termination unconfirmed",
  paused: "paused",
  cancelling: "cancelling — termination unconfirmed",
}

export function stopLabel(workflow: { stop: StopDisplay; pausedFrom?: { phase: string; stage: string } }): string {
  const base = STOP_LABEL[workflow.stop]
  return workflow.stop === "paused" && workflow.pausedFrom ? `${base} (from ${workflow.pausedFrom.phase}/${workflow.pausedFrom.stage})` : base
}

/** <= 25 lines; richer detail is deliberately excluded from the model-facing path. */
export function renderStatus(deps: FlowRuntime, sessionID?: string, queueRunning?: boolean, now = Date.now()): string {
  return renderStatusSnapshot(statusJson(deps, sessionID, { queueRunning, now }), sessionID)
}

export function renderStatusSnapshot(status: StatusJson, sessionID?: string): string {
  const lines = [STATUS_MARKER]
  const workflow = status.workflow
  if (!workflow) lines.push("workflow: none")
  else {
    const label = PHASE_LABEL[workflow.phase as Phase] ?? "unknown"
    const phase = workflow.stuckCause ? `${label}(${workflow.stuckCause})` : label
    const owner = workflow.sessionID === sessionID ? "this session" : `session ${workflow.sessionID}`
    const stop = stopLabel(workflow)
    lines.push(`workflow: ${workflow.id} ${workflow.stop === "paused" ? "" : `${phase}${stop ? " · " : ""}`}${stop} — ${owner}${workflow.ownerLive ? "" : ", owner dead"}`)
    if (workflow.plan) lines.push(`plan: ${workflow.plan}`)
    if (workflow.review) lines.push(`review: ${workflow.review}`)
    lines.push(`kind: ${workflow.kind} · stage ${workflow.stage} · revision ${workflow.revision}${workflow.stopIntent ? ` · stop intent ${workflow.stopIntent}` : ""}`)
    if (workflow.artifacts.length) lines.push(`artifacts: ${workflow.artifacts.map(item => `${item.key} ${item.state} (${item.path})`).join(", ")}${workflow.artifactsOmitted ? ` (+${workflow.artifactsOmitted} not read)` : ""}`)
    if (workflow.tasks) lines.push(`plan tasks: ${workflow.tasks.done}/${workflow.tasks.total} done, ${workflow.tasks.open} open, ${workflow.tasks.failed} failed/cancelled`)
    const c = workflow.counters
    if (c) lines.push(`counters: invalid ${c.code_invalid}, review ${c.review_iterations}, rejects ${c.user_rejections}, nudges ${c.nudges}`)
  }
  if (status.session.source === "none") lines.push("session: none (pass --session)")
  const ledger = status.session.ledger
  lines.push(`mode: ${status.session.modeActive ? status.session.mode : "none"}`)
  lines.push(`ledger: ${ledger.done ?? 0} done, ${(ledger.pending ?? 0) + (ledger.running ?? 0)} open, ${ledger.failed ?? 0} failed, ${ledger.cancelled ?? 0} cancelled; queue ${queueWord(status.session.queue.state)}`)
  const q = status.session.queue
  if (["stale", "blocked", "unknown", "running_elsewhere"].includes(q.state) || (q.state === "idle" && q.evidence !== "no_running")) {
    const noOpenTasks = q.evidence.endsWith("+no_open_tasks")
    const note = q.state === "running_elsewhere" ? "claim held by live pid; progress not proven" :
      noOpenTasks ? "stale running pointer from an interrupted run; no pending work. Status does not change it. The next plan approval or task start replaces it." :
      q.state === "idle" && q.evidence === "claim_pid_dead" ? "previous claim holder exited; the next run takes over automatically" :
      q.state === "idle" && q.evidence === "claim_other_session" ? "claim belongs to another session; it is not evidence for this session" : q.evidence
    lines.push(`queue: ${note}${q.taskId ? ` · ${q.taskId}` : ""}${q.ageMs !== undefined ? ` · ${Math.floor(q.ageMs / 1000)}s` : ""}${!noOpenTasks && q.state !== "running_elsewhere" && q.state !== "idle" && q.hint ? ` · ${q.hint}` : ""}`)
  }
  if (status.execution.unresolved) lines.push(`execution: ${status.execution.unresolved} unresolved, ${status.execution.cancelledAcknowledged} cancel ACK; generation ${status.execution.generation}; usage unknown`)
  if (status.execution.verification) lines.push(`verification: ${status.execution.verification}`)
  if (status.events.length) lines.push(`events: ${status.events.map(e => `#${e.seq} ${e.type}${e.to ? `→${e.to}` : ""}`).join(", ")}`)
  return lines.slice(0, 25).join("\n")
}

export function renderStatusError(error: StatusReadError): string {
  return `${STATUS_MARKER}\nstatus unavailable: ${error.source} ${error.code}`
}

export function renderStatusDetail(status: StatusJson): string {
  return status.detail ? JSON.stringify(status.detail) : "detail unavailable"
}
