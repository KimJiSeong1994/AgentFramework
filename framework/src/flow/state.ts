// Plan workflow persistence (ralplan §5.1, P5a). Control plane lives in the state root (outside the worktree, so a
// worker cannot edit it); only the human-readable plan view is rendered into <worktree>/.otter/plans/.
// Session control files live in <stateRoot>/sessions/<sid>/workflow/: workflow.json (commit index),
// heartbeat.json, archive/, legacy/, events.jsonl (monotonic within this scope), and plans/.
// Matching existing legacy sessions retain <stateRoot>/workflow/; unscoped APIs use that legacy directory.
// Immutable snapshots live in <stateRoot>/sessions/<sid>/workflows/<wid>/revisions/<seq>.json.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { appendFileSync, closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { readBoundedJson } from "../state/store.ts"
import { workflowDirectory } from "../state/workflow-scope.ts"
import { durableWriteBytes, durableWriteJson } from "../state/durable.ts"
import type { Counters, FlowCore, StuckCause } from "./machine.ts"
import { ZERO_COUNTERS } from "./machine.ts"
import { INSTANCE_ID } from "./owner.ts"
import { canonicalPlanJson, type Plan } from "./plan.ts"
import { TERMINAL, type Owner, type Phase, type PlanWorkflow, type WorkflowEnvelope, type WorkflowKind } from "../workflows/types.ts"
import { narrowPlan, parseEnvelope, REGISTRY } from "../workflows/registry.ts"
import { retainContentAddressed } from "../workflows/artifacts.ts"
import { committedEventBound, eventAdmitted, legacyArchive, readCommitted, writeArchiveCopy, type EventBound } from "../workflows/commit.ts"

declare const flowTxBrand: unique symbol
export type FlowTx = { readonly [flowTxBrand]: true }

type FlowTxState = { worktree: string; sessionID?: string; dir: string; lock: string; identity: string; active: boolean }
type SynchronousCallbackResult<T> = Extract<T, PromiseLike<unknown>> extends never ? [] : [never]
const flowTxState = new WeakMap<FlowTx, FlowTxState>()
const heldFlowDirs = new Set<string>()

export class FlowTransactionBusyError extends Error {
  constructor() {
    super("flow transaction is busy; retry later")
    this.name = "FlowTransactionBusyError"
  }
}

export class FlowTransactionIntegrityError extends Error {
  constructor() {
    super("flow transaction lock ownership changed; lock left in place")
    this.name = "FlowTransactionIntegrityError"
  }
}

export class CorruptWorkflowError extends Error {
  constructor(path: string, message = `corrupt workflow state at ${path}; refusing flow write`) {
    super(message)
    this.name = "CorruptWorkflowError"
  }
}

/** A non-terminal pre-v2 inline record: every writer refuses and the bytes stay untouched (no migration). */
export class LegacyWorkflowError extends CorruptWorkflowError {
  constructor(path: string) {
    super(path, `legacy workflow format at ${path}; finish or cancel it with the prior version; refusing flow write`)
    this.name = "LegacyWorkflowError"
  }
}

/** Exclusive, synchronous transaction for cooperating writers sharing this external state root. */
export function withFlowTransaction<T>(
  worktree: string,
  fn: (tx: FlowTx) => T,
  sessionID?: string,
  ..._syncOnly: SynchronousCallbackResult<T>
): T {
  const dir = flowDir(worktree, sessionID)
  const lock = join(dir, "workflow.lock")
  if (heldFlowDirs.has(dir)) throw new TypeError("nested flow transaction")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const identity = JSON.stringify({ pid: process.pid, instance: INSTANCE_ID, token: randomUUID() })
  try {
    symlinkSync(identity, lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new FlowTransactionBusyError()
    throw error
  }
  heldFlowDirs.add(dir)
  const tx = Object.freeze({}) as FlowTx
  const state: FlowTxState = { worktree, sessionID, dir, lock, identity, active: true }
  flowTxState.set(tx, state)
  try {
    const result = (fn as (tx: FlowTx) => unknown)(tx)
    if (isThenable(result)) {
      void Promise.resolve(result).catch(() => {})
      throw new TypeError("flow transaction callback must be synchronous")
    }
    return result as T
  } finally {
    state.active = false
    heldFlowDirs.delete(dir)
    let owner: string
    try {
      owner = readlinkSync(lock)
    } catch {
      throw new FlowTransactionIntegrityError()
    }
    if (owner !== identity) throw new FlowTransactionIntegrityError()
    unlinkSync(lock)
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false
  return typeof (value as { then?: unknown }).then === "function"
}

function assertFlowTx(tx: FlowTx): FlowTxState {
  const state = flowTxState.get(tx)
  if (!state || !state.active) throw new TypeError("flow transaction is no longer active")
  let owner: string
  try {
    owner = readlinkSync(state.lock)
  } catch {
    throw new FlowTransactionIntegrityError()
  }
  if (owner !== state.identity || flowDir(state.worktree, state.sessionID) !== state.dir) throw new FlowTransactionIntegrityError()
  return state
}

/** Worktree a live flow transaction belongs to (throws when the transaction is inactive or its lock changed). */
export function flowTxWorktree(tx: FlowTx): string {
  return assertFlowTx(tx).worktree
}

export function flowTxSessionID(tx: FlowTx): string | undefined {
  return assertFlowTx(tx).sessionID
}

export function assertFlowTxWorktree(tx: FlowTx, worktree: string): void {
  const state = assertFlowTx(tx)
  if (flowDir(worktree, state.sessionID) !== state.dir) throw new TypeError("flow transaction belongs to a different worktree")
}

export type { Owner }

export type HeartbeatRecord = { wid: string; epoch: string; pid: number; heartbeatAt: number }

/** Non-authoritative, display-only owner liveness. Written without bumping any revision; never an authority fence. */
export function writeHeartbeat(tx: FlowTx, wf: Pick<Workflow, "id" | "owner">, heartbeatAt = Date.now()): void {
  const { worktree, sessionID } = assertFlowTx(tx)
  const record: HeartbeatRecord = { wid: wf.id, epoch: wf.owner.instance, pid: wf.owner.pid, heartbeatAt }
  durableWriteBytes(heartbeatPath(worktree, sessionID), Buffer.from(`${JSON.stringify(record)}\n`, "utf8"))
}

/** The beat for exactly this owner binding, or undefined (missing, unreadable or for another binding). */
export function readHeartbeat(worktree: string, wf: Pick<WorkflowEnvelope, "id" | "owner">, sessionID?: string): number | undefined {
  try {
    const { value } = readBoundedJson(heartbeatPath(worktree, sessionID), 4096)
    if (!value || typeof value !== "object") return undefined
    const r = value as Record<string, unknown>
    if (r.wid !== wf.id || r.epoch !== wf.owner.instance || r.pid !== wf.owner.pid ||
      typeof r.heartbeatAt !== "number" || !Number.isFinite(r.heartbeatAt) || r.heartbeatAt < 0) return undefined
    return r.heartbeatAt
  } catch { return undefined }
}
export type EventActor = "code" | "user_command" | "user_keyword" | "user_message" | "model_tool"

/** The only workflow kind with an engine in this gate; plan APIs never accept another kind (see `narrowPlan`). */
export type Workflow = PlanWorkflow

export type FlowEventLine = {
  seq: number
  at: number
  wf: string
  type: string
  from?: string
  to?: string
  actor: EventActor
  data?: Record<string, unknown>
  /** Non-committing audit line (e.g. a denied tool call): admitted regardless of revision and never authority. */
  audit?: true
}

export const REQUEST_MAX = 2000
const ENGINE_MAX = 512

function validEngine(engine: unknown): engine is string {
  return typeof engine === "string" && engine.length > 0 && engine.length <= ENGINE_MAX
}

/** Refuse host use unless the persisted workflow and this host identify the same bounded engine. */
export function workflowEngineRefusal(wf: Pick<WorkflowEnvelope, "engine">, expectedEngine: unknown): string | undefined {
  if (!validEngine(wf.engine)) return "workflow engine identity is missing or malformed; recovery refused"
  if (!validEngine(expectedEngine)) return "host engine identity is missing or malformed; recovery refused"
  if (wf.engine !== expectedEngine) return "workflow engine identity mismatch; recovery refused"
  return undefined
}

export function flowDir(worktree: string, sessionID?: string): string {
  return workflowDirectory(worktree, sessionID)
}
export function workflowPath(worktree: string, sessionID?: string): string {
  return join(flowDir(worktree, sessionID), "workflow.json")
}
export function archivePath(worktree: string, id: string, sessionID?: string): string {
  return join(flowDir(worktree, sessionID), "archive", `${id}.json`)
}
export function eventsPath(worktree: string, sessionID?: string): string {
  return join(flowDir(worktree, sessionID), "events.jsonl")
}
export function heartbeatPath(worktree: string, sessionID?: string): string {
  return join(flowDir(worktree, sessionID), "heartbeat.json")
}
export function planJsonPath(worktree: string, id: string, sessionID?: string): string {
  return join(flowDir(worktree, sessionID), "plans", `${id}.json`)
}

export function newWorkflowId(now = Date.now()): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, "0")
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  return `wf_${stamp}_${randomBytes(2).toString("hex")}`
}

/** A valid committed non-plan envelope that occupies the slot; plan readers see it as foreign, never as corrupt. */
export type Occupant = { id: string; kind: WorkflowKind; sessionID: string; phase: Phase }
export type ReadWorkflowResult = { wf: Workflow | null; corrupt?: string; legacy?: { terminal: boolean }; occupiedBy?: Occupant }
export type ReadAnyWorkflowResult = { wf: WorkflowEnvelope | null; corrupt?: string; legacy?: { terminal: boolean } }

/** Kind-generic checked read: any valid committed envelope. Corrupt state is reported in place; reads never rename it. */
export function readAnyWorkflowChecked(worktree: string, sessionID?: string): ReadAnyWorkflowResult {
  const path = workflowPath(worktree, sessionID)
  const committed = readCommitted(worktree, {}, sessionID)
  switch (committed.state) {
    case "none": return { wf: null }
    case "ok": return { wf: committed.wf }
    case "legacy": return committed.terminal ? { wf: null, legacy: { terminal: true } } : { wf: null, corrupt: path, legacy: { terminal: false } }
    case "corrupt": return { wf: null, corrupt: path }
  }
}

/** Plan-only checked read. A non-plan occupant yields `wf: null` with `occupiedBy`, so plan code can refuse by name. */
export function readWorkflowChecked(worktree: string, sessionID?: string): ReadWorkflowResult {
  const any = readAnyWorkflowChecked(worktree, sessionID)
  if (!any.wf) return any as ReadWorkflowResult
  if (any.wf.kind === "plan") return { wf: any.wf }
  return { wf: null, occupiedBy: { id: any.wf.id, kind: any.wf.kind, sessionID: any.wf.sessionID, phase: any.wf.phase } }
}

export function readAnyWorkflowForWrite(tx: FlowTx): ReadAnyWorkflowResult {
  const { worktree, sessionID } = assertFlowTx(tx)
  return readAnyWorkflowChecked(worktree, sessionID)
}

/** Non-terminal workflow of any kind that currently occupies the slot. */
export function activeAnyWorkflow(worktree: string, sessionID?: string): WorkflowEnvelope | null {
  const wf = readAnyWorkflowChecked(worktree, sessionID).wf
  return wf && !TERMINAL.has(wf.phase) ? wf : null
}

/** Pure strict parser for read-only consumers: a v2 plan envelope or "invalid workflow state". */
export function parseWorkflow(value: unknown): Workflow {
  try { return narrowPlan(parseEnvelope(value)) }
  catch { throw new Error("invalid workflow state") }
}

export function readWorkflow(worktree: string, sessionID?: string): Workflow | null {
  return readWorkflowChecked(worktree, sessionID).wf
}

export function readWorkflowForWrite(tx: FlowTx): ReadWorkflowResult {
  const { worktree, sessionID } = assertFlowTx(tx)
  return readWorkflowChecked(worktree, sessionID)
}

/** The refusal for a failed checked read: legacy non-terminal records and corrupt state both refuse writes. */
export function workflowReadError(result: { corrupt?: string; legacy?: { terminal: boolean } }): CorruptWorkflowError {
  return result.legacy?.terminal === false ? new LegacyWorkflowError(result.corrupt!) : new CorruptWorkflowError(result.corrupt!)
}

function assertNoCorruptWorkflow(tx: FlowTx): void {
  const result = readWorkflowForWrite(tx)
  if (result.corrupt) throw workflowReadError(result)
}

/** Non-terminal workflow that currently blocks a new one (stuck counts: it still has an exit). */
export function activeWorkflow(worktree: string, sessionID?: string): Workflow | null {
  const wf = readWorkflow(worktree, sessionID)
  return wf && !TERMINAL.has(wf.phase) ? wf : null
}

/**
 * Retain a terminal workflow's history before the next start replaces the index pointer. Nothing is deleted: a v2
 * terminal gets a derived archive/<id>.json copy and a terminal v1 inline record is copied byte-for-byte to
 * legacy/<id>.v1.json. Returns the retained id, or null when nothing was terminal.
 */
export function rotate(tx: FlowTx): string | null {
  const { worktree, sessionID } = assertFlowTx(tx)
  assertNoCorruptWorkflow(tx)
  const committed = readCommitted(worktree, {}, sessionID)
  if (committed.state === "ok" && TERMINAL.has(committed.wf.phase)) {
    writeArchiveCopy(worktree, committed.wf, sessionID)
    return committed.wf.id
  }
  if (committed.state === "legacy" && committed.terminal) {
    legacyArchive(worktree, committed.id, committed.bytes, sessionID)
    return committed.id
  }
  return null
}

/** Last seq in events.jsonl (0 when empty). A torn last line is skipped. */
export function lastEventSeq(worktree: string, sessionID?: string): number {
  const path = eventsPath(worktree, sessionID)
  if (!existsSync(path)) return 0
  const lines = readFileSync(path, "utf8").split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line) continue
    try {
      const seq = (JSON.parse(line) as FlowEventLine).seq
      if (Number.isSafeInteger(seq)) return seq
    } catch {}
  }
  return 0
}

/** Every event line in the file, committed or not. Only commit.ts (orphan classification) may use this. */
export function readAllEventLines(worktree: string, sessionID?: string): FlowEventLine[] {
  const path = eventsPath(worktree, sessionID)
  if (!existsSync(path)) return []
  const out: FlowEventLine[] = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as FlowEventLine) } catch {}
  }
  return out
}

/** Events admitted by the committed index: precommit orphans never appear. Audit lines are always admitted. */
export function readEvents(worktree: string, wfId?: string, sessionID?: string): FlowEventLine[] {
  const bound = committedEventBound(worktree, sessionID)
  return readAllEventLines(worktree, sessionID).filter((e) => (!wfId || e.wf === wfId) && eventAdmitted(bound, e))
}

export type EventTail = { events: FlowEventLine[]; windowTruncated: boolean; bytesRead: number }

function withBytesRead(error: unknown, bytesRead: number): Error {
  const failure = error instanceof Error ? error : new Error("unreadable")
  Object.defineProperty(failure, "bytesRead", { value: bytesRead, configurable: true, writable: true })
  return failure
}

/** Read only a bounded tail window; torn boundary lines are discarded and state is never modified. */
export function readEventsTail(worktree: string, opts: { wfId?: string; limit: number; maxBytes?: number; bound?: EventBound | null }, sessionID?: string): EventTail {
  const maxBytes = opts.maxBytes ?? 64 * 1024
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("invalid event tail limits")
  }
  const path = eventsPath(worktree, sessionID)
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], windowTruncated: false, bytesRead: 0 }
    throw withBytesRead(error, 0)
  }
  let bytesRead = 0
  let result: EventTail | undefined
  let failure: Error | undefined
  try {
    const file = fstatSync(fd)
    if (!file.isFile()) throw Object.assign(new Error("unreadable"), { code: "unreadable" })
    const size = file.size
    const start = Math.max(0, size - maxBytes)
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, start + offset)
      if (count === 0) break
      offset += count
      bytesRead = offset
    }
    let text = buffer.subarray(0, offset).toString("utf8")
    let windowTruncated = start > 0
    if (start > 0) {
      const newline = text.indexOf("\n")
      if (newline < 0) {
        result = { events: [], windowTruncated: true, bytesRead }
      } else {
        text = text.slice(newline + 1)
      }
    }
    if (!result) {
      const lines = text.split("\n")
      if (offset > 0 && buffer[offset - 1] !== 0x0a) {
        lines.pop()
        windowTruncated = true
      }
      const events: FlowEventLine[] = []
      for (const line of lines) {
        if (!line) continue
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { continue }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
        const event = parsed as Record<string, unknown>
        if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0 || !Number.isFinite(event.at) || (event.at as number) < 0 ||
          typeof event.wf !== "string" || typeof event.type !== "string" || (opts.wfId && event.wf !== opts.wfId)) continue
        if (opts.bound && !eventAdmitted(opts.bound, event as unknown as FlowEventLine)) continue
        const { to, ...rest } = event
        events.push({ ...rest, ...(typeof to === "string" ? { to } : {}) } as FlowEventLine)
      }
      result = { events: opts.limit === 0 ? [] : events.slice(-opts.limit), windowTruncated, bytesRead }
    }
  } catch (error) {
    failure = withBytesRead(error, bytesRead)
  }
  try { closeSync(fd) }
  catch (error) { if (!failure) failure = withBytesRead(error, bytesRead) }
  if (failure) throw failure
  return result!
}

/** A torn final line (no trailing newline) is never truncated; the next append starts on a fresh line instead. */
function tornTailPrefix(path: string): string {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return ""
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] === 0x0a ? "" : "\n"
  } finally { closeSync(fd) }
}

/** Append non-committing audit events with a global monotonic seq. Returns the last seq written. */
export function appendEvents(tx: FlowTx, events: Array<Omit<FlowEventLine, "seq" | "at" | "audit"> & { at?: number }>, now = Date.now()): number {
  const { worktree, sessionID } = assertFlowTx(tx)
  assertNoCorruptWorkflow(tx)
  let seq = lastEventSeq(worktree, sessionID)
  if (events.length === 0) return seq
  const path = eventsPath(worktree, sessionID)
  mkdirSync(dirname(path), { recursive: true })
  const text = tornTailPrefix(path) + events.map((e) => JSON.stringify({ seq: ++seq, at: e.at ?? now, ...e, audit: true })).join("\n") + "\n"
  appendFileSync(path, text)
  return seq
}

/** Append events and fsync the event file before a durable workflow revision refers to them. */
export function appendEventsDurable(tx: FlowTx, events: Array<Omit<FlowEventLine, "seq" | "at"> & { at?: number }>, now = Date.now(), beforeFsync?: () => void): number {
  const { worktree, sessionID } = assertFlowTx(tx)
  assertNoCorruptWorkflow(tx)
  let seq = lastEventSeq(worktree, sessionID)
  if (events.length === 0) return seq
  const path = eventsPath(worktree, sessionID)
  mkdirSync(dirname(path), { recursive: true })
  const text = tornTailPrefix(path) + events.map((event) => JSON.stringify({ seq: ++seq, at: event.at ?? now, ...event })).join("\n") + "\n"
  const bytes = Buffer.from(text, "utf8")
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    if (!fstatSync(fd).isFile()) throw new Error("workflow events are not a regular file")
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null)
      if (written <= 0) throw new Error("short write while appending workflow events")
      offset += written
    }
    beforeFsync?.()
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const directoryFD = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (!fstatSync(directoryFD).isDirectory()) throw new Error("workflow events directory is not a directory")
    fsyncSync(directoryFD)
  } finally {
    closeSync(directoryFD)
  }
  return seq
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** Immutable, content-addressed retention of plan artifacts, so a retained revision re-verifies after the live file moves on. */
export function planRevisionDir(worktree: string, id: string, sessionID?: string): string {
  return join(flowDir(worktree, sessionID), "plans", "revisions", id)
}

/** Durably write a code-rendered artifact under <worktree>/<rel> and an immutable `<sha256>.md` copy; returns its sha256. */
export function renderArtifact(tx: FlowTx, rel: string, text: string): string {
  const { worktree, sessionID } = assertFlowTx(tx)
  assertNoCorruptWorkflow(tx)
  const path = join(worktree, rel)
  mkdirSync(dirname(path), { recursive: true })
  const bytes = Buffer.from(text, "utf8")
  const sha = sha256(text)
  retainContentAddressed(planRevisionDir(worktree, basename(rel).replace(/\.md$/, ""), sessionID), bytes, "md", sha)
  durableWriteBytes(path, bytes, undefined, { createParents: false })
  return sha
}

export function writePlanJson(tx: FlowTx, id: string, plan: Plan): void {
  const { worktree, sessionID } = assertFlowTx(tx)
  assertNoCorruptWorkflow(tx)
  const canonical = canonicalPlanJson(plan)
  retainContentAddressed(planRevisionDir(worktree, id, sessionID), Buffer.from(canonical, "utf8"), "json", sha256(canonical))
  durableWriteJson(planJsonPath(worktree, id, sessionID), plan)
}

export function coreOf(wf: Workflow): FlowCore {
  return {
    phase: wf.phase,
    stuckCause: wf.stuckCause,
    counters: wf.counters,
    ...(wf.stopIntent ? { stop: { kind: wf.stopIntent.kind } } : {}),
    ...(wf.pausedFrom ? { pausedFrom: wf.pausedFrom.phase } : {}),
    reviewNote: wf.review?.note,
  }
}

/** Apply a machine result back onto the workflow record. */
export function withCore(wf: Workflow, core: FlowCore): Workflow {
  const next: Workflow = { ...wf, phase: core.phase, stage: REGISTRY.plan.stageOf(core.phase, wf.stage), counters: core.counters }
  if (core.stuckCause) next.stuckCause = core.stuckCause
  else delete next.stuckCause
  if (core.stop) {
    // The token, checkpoint and reason are minted only by requestStop (it patches them over this placeholder).
    next.stopIntent = wf.stopIntent?.kind === core.stop.kind ? wf.stopIntent : {
      kind: core.stop.kind, token: randomUUID(), requestedFrom: { phase: wf.phase, stage: wf.stage }, checkpoint: null, reason: `${core.stop.kind} requested`,
    }
  } else next.stopIntent = null
  if (core.pausedFrom) {
    next.pausedFrom = wf.pausedFrom?.phase === core.pausedFrom ? wf.pausedFrom : { phase: core.pausedFrom, stage: wf.stage }
  } else delete next.pausedFrom
  if (next.review) {
    if (core.reviewNote) next.review = { ...next.review, note: core.reviewNote }
    else if (next.review.note) {
      const { note: _n, ...rest } = next.review
      next.review = rest
    }
  }
  return next
}

/** `owner` may carry a liveness hint (heartbeatAt) from callers; it is never stored in the envelope. */
export function newWorkflow(sessionID: string, owner: Owner & { heartbeatAt?: number }, entry: Workflow["entry"], request: string, engine: string, now = Date.now()): Workflow {
  if (!validEngine(engine)) throw new TypeError("workflow engine must be a nonempty string no longer than 512 characters")
  return {
    version: 2,
    id: newWorkflowId(now),
    kind: "plan",
    stage: "draft",
    engine,
    phase: "planning",
    sessionID,
    owner: { instance: owner.instance, pid: owner.pid },
    stopIntent: null,
    artifacts: [],
    entry,
    request: request.slice(0, REQUEST_MAX),
    counters: { ...ZERO_COUNTERS },
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
  }
}
