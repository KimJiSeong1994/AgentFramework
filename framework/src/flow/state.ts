// Plan workflow persistence (ralplan §5.1). Control plane lives in the state root (outside the worktree, so a worker
// cannot edit it); only the human-readable plan view is rendered into <worktree>/.lca/plans/.
//   <stateRoot>/workflow/workflow.json     active-workflow index (at most one; terminal ones are rotated to archive/)
//   <stateRoot>/workflow/archive/<id>.json terminal workflows
//   <stateRoot>/workflow/events.jsonl      append-only, global monotonic seq across workflows
//   <stateRoot>/workflow/plans/<id>.json   canonical plan (M1)
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { stateRoot, writeJsonAtomic } from "../state/store.ts"
import type { Counters, FlowCore, Phase, StuckCause } from "./machine.ts"
import { TERMINAL, ZERO_COUNTERS } from "./machine.ts"
import { INSTANCE_ID } from "./owner.ts"
import type { Plan } from "./plan.ts"

declare const flowTxBrand: unique symbol
export type FlowTx = { readonly [flowTxBrand]: true }

type FlowTxState = { worktree: string; dir: string; lock: string; identity: string; active: boolean }
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
  constructor(path: string) {
    super(`corrupt workflow state at ${path}; refusing flow write`)
    this.name = "CorruptWorkflowError"
  }
}

/** Exclusive, synchronous transaction for cooperating writers sharing this external state root. */
export function withFlowTransaction<T>(
  worktree: string,
  fn: (tx: FlowTx) => T,
  ..._syncOnly: SynchronousCallbackResult<T>
): T {
  const dir = flowDir(worktree)
  const lock = join(dir, "workflow.lock")
  if (heldFlowDirs.has(dir)) throw new TypeError("nested flow transaction")
  mkdirSync(dir, { recursive: true })
  const identity = JSON.stringify({ pid: process.pid, instance: INSTANCE_ID, token: randomUUID() })
  try {
    symlinkSync(identity, lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new FlowTransactionBusyError()
    throw error
  }
  heldFlowDirs.add(dir)
  const tx = Object.freeze({}) as FlowTx
  const state: FlowTxState = { worktree, dir, lock, identity, active: true }
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
  if (owner !== state.identity) throw new FlowTransactionIntegrityError()
  return state
}

export function assertFlowTxWorktree(tx: FlowTx, worktree: string): void {
  if (flowDir(worktree) !== assertFlowTx(tx).dir) throw new TypeError("flow transaction belongs to a different worktree")
}

export type Owner = { instance: string; pid: number; heartbeatAt: number }
export type EventActor = "code" | "user_command" | "user_keyword" | "user_message" | "model_tool"

export type Workflow = {
  version: 1
  id: string
  kind: "plan"
  /** Observed host identity; legacy or malformed values remain readable but confer no execution authority. */
  engine?: unknown
  phase: Phase
  stuckCause?: StuckCause
  /** authority key */
  sessionID: string
  owner: Owner
  entry: "command" | "keyword"
  request: string
  planRef?: { jsonSha: string; mdPath: string; mdSha: string; revision: number }
  review?: { verdict: "okay" | "iterate" | "none"; findings: string[]; planSha: string; note?: "aborted" | "cap" }
  approval?: { by: "user_command"; planSha: string; at: number }
  taskIds?: string[]
  counters: Counters
  pendingCancel?: boolean
  lastSeq: number
  createdAt: number
  updatedAt: number
}

export type FlowEventLine = {
  seq: number
  at: number
  wf: string
  type: string
  from?: string
  to?: string
  actor: EventActor
  data?: Record<string, unknown>
}

export const REQUEST_MAX = 2000
const ENGINE_MAX = 512

function validEngine(engine: unknown): engine is string {
  return typeof engine === "string" && engine.length > 0 && engine.length <= ENGINE_MAX
}

/** Refuse host use unless the persisted workflow and this host identify the same bounded engine. */
export function workflowEngineRefusal(wf: Workflow, expectedEngine: unknown): string | undefined {
  if (!validEngine(wf.engine)) return "workflow engine identity is missing or malformed; recovery refused"
  if (!validEngine(expectedEngine)) return "host engine identity is missing or malformed; recovery refused"
  if (wf.engine !== expectedEngine) return "workflow engine identity mismatch; recovery refused"
  return undefined
}

export function flowDir(worktree: string): string {
  return join(stateRoot(worktree), "workflow")
}
export function workflowPath(worktree: string): string {
  return join(flowDir(worktree), "workflow.json")
}
export function archivePath(worktree: string, id: string): string {
  return join(flowDir(worktree), "archive", `${id}.json`)
}
export function eventsPath(worktree: string): string {
  return join(flowDir(worktree), "events.jsonl")
}
export function planJsonPath(worktree: string, id: string): string {
  return join(flowDir(worktree), "plans", `${id}.json`)
}

export function newWorkflowId(now = Date.now()): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, "0")
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  return `wf_${stamp}_${randomBytes(2).toString("hex")}`
}

function isWorkflow(v: unknown): v is Workflow {
  const w = v as Workflow | null
  return !!w && w.version === 1 && typeof w.id === "string" && typeof w.phase === "string" && typeof w.sessionID === "string"
}

export type ReadWorkflowResult = { wf: Workflow | null; corrupt?: string }

/** Corrupt workflow state is reported in place; even status reads never rename it. */
export function readWorkflowChecked(worktree: string): ReadWorkflowResult {
  const path = workflowPath(worktree)
  if (!existsSync(path)) return { wf: null }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch {
    return { wf: null, corrupt: path }
  }
  if (!isWorkflow(value)) return { wf: null, corrupt: path }
  return { wf: value }
}

export function readWorkflow(worktree: string): Workflow | null {
  return readWorkflowChecked(worktree).wf
}

export function readWorkflowForWrite(tx: FlowTx): ReadWorkflowResult {
  const { worktree } = assertFlowTx(tx)
  return readWorkflowChecked(worktree)
}

function assertNoCorruptWorkflow(tx: FlowTx): void {
  const result = readWorkflowForWrite(tx)
  if (result.corrupt) throw new CorruptWorkflowError(result.corrupt)
}

export function writeWorkflow(tx: FlowTx, wf: Workflow, now = Date.now()): Workflow {
  const { worktree } = assertFlowTx(tx)
  assertNoCorruptWorkflow(tx)
  const next = { ...wf, updatedAt: now }
  writeJsonAtomic(workflowPath(worktree), next)
  return next
}

/** Non-terminal workflow that currently blocks a new one (stuck counts: it still has an exit). */
export function activeWorkflow(worktree: string): Workflow | null {
  const wf = readWorkflow(worktree)
  return wf && !TERMINAL.has(wf.phase) ? wf : null
}

/** Move a terminal workflow.json into archive/<id>.json. Returns the archived id, or null when nothing moved. */
export function rotate(tx: FlowTx): string | null {
  const { worktree } = assertFlowTx(tx)
  assertNoCorruptWorkflow(tx)
  const wf = readWorkflowForWrite(tx).wf
  if (!wf || !TERMINAL.has(wf.phase)) return null
  writeJsonAtomic(archivePath(worktree, wf.id), wf)
  rmSync(workflowPath(worktree), { force: true })
  return wf.id
}

/** Last seq in events.jsonl (0 when empty). A torn last line is skipped. */
export function lastEventSeq(worktree: string): number {
  const path = eventsPath(worktree)
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

export function readEvents(worktree: string, wfId?: string): FlowEventLine[] {
  const path = eventsPath(worktree)
  if (!existsSync(path)) return []
  const out: FlowEventLine[] = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as FlowEventLine
      if (!wfId || e.wf === wfId) out.push(e)
    } catch {}
  }
  return out
}

/** Append events with a global monotonic seq. Returns the last seq written. */
export function appendEvents(tx: FlowTx, events: Array<Omit<FlowEventLine, "seq" | "at"> & { at?: number }>, now = Date.now()): number {
  const { worktree } = assertFlowTx(tx)
  assertNoCorruptWorkflow(tx)
  let seq = lastEventSeq(worktree)
  if (events.length === 0) return seq
  const path = eventsPath(worktree)
  mkdirSync(dirname(path), { recursive: true })
  const text = events.map((e) => JSON.stringify({ seq: ++seq, at: e.at ?? now, ...e })).join("\n") + "\n"
  appendFileSync(path, text)
  return seq
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** Write a code-rendered artifact under <worktree>/<rel>; returns its sha256. */
export function renderArtifact(tx: FlowTx, rel: string, text: string): string {
  const { worktree } = assertFlowTx(tx)
  assertNoCorruptWorkflow(tx)
  const path = join(worktree, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return sha256(text)
}

export function writePlanJson(tx: FlowTx, id: string, plan: Plan): void {
  const { worktree } = assertFlowTx(tx)
  assertNoCorruptWorkflow(tx)
  writeJsonAtomic(planJsonPath(worktree, id), plan)
}

export function fileSha(worktree: string, rel: string): string | null {
  const path = join(worktree, rel)
  return existsSync(path) ? sha256(readFileSync(path, "utf8")) : null
}

export function coreOf(wf: Workflow): FlowCore {
  return {
    phase: wf.phase,
    stuckCause: wf.stuckCause,
    counters: wf.counters,
    pendingCancel: wf.pendingCancel,
    reviewNote: wf.review?.note,
  }
}

/** Apply a machine result back onto the workflow record. */
export function withCore(wf: Workflow, core: FlowCore): Workflow {
  const next: Workflow = { ...wf, phase: core.phase, counters: core.counters }
  if (core.stuckCause) next.stuckCause = core.stuckCause
  else delete next.stuckCause
  if (core.pendingCancel) next.pendingCancel = true
  else delete next.pendingCancel
  if (next.review) {
    if (core.reviewNote) next.review = { ...next.review, note: core.reviewNote }
    else if (next.review.note) {
      const { note: _n, ...rest } = next.review
      next.review = rest
    }
  }
  return next
}

export function newWorkflow(sessionID: string, owner: Owner, entry: Workflow["entry"], request: string, engine: string, now = Date.now()): Workflow {
  if (!validEngine(engine)) throw new TypeError("workflow engine must be a nonempty string no longer than 512 characters")
  return {
    version: 1,
    id: newWorkflowId(now),
    kind: "plan",
    engine,
    phase: "planning",
    sessionID,
    owner,
    entry,
    request: request.slice(0, REQUEST_MAX),
    counters: { ...ZERO_COUNTERS },
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
  }
}
