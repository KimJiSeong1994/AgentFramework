// Plan workflow persistence (ralplan §5.1). Control plane lives in the state root (outside the worktree, so a worker
// cannot edit it); only the human-readable plan view is rendered into <worktree>/.lca/plans/.
//   <stateRoot>/workflow/workflow.json     active-workflow index (at most one; terminal ones are rotated to archive/)
//   <stateRoot>/workflow/archive/<id>.json terminal workflows
//   <stateRoot>/workflow/events.jsonl      append-only, global monotonic seq across workflows
//   <stateRoot>/workflow/plans/<id>.json   canonical plan (M1)
import { createHash, randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { readJsonChecked, stateRoot, writeJsonAtomic } from "../state/store.ts"
import type { Counters, FlowCore, Phase, StuckCause } from "./machine.ts"
import { TERMINAL, ZERO_COUNTERS } from "./machine.ts"

export type Owner = { instance: string; pid: number; heartbeatAt: number }
export type EventActor = "code" | "user_command" | "user_keyword" | "user_message" | "model_tool"

export type Workflow = {
  version: 1
  id: string
  kind: "plan"
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

/** A corrupt or wrong-shaped workflow.json is moved aside (never silently overwritten). */
export function readWorkflowChecked(worktree: string): ReadWorkflowResult {
  const path = workflowPath(worktree)
  const r = readJsonChecked<unknown>(path, null)
  if (r.corrupt) return { wf: null, corrupt: r.corrupt }
  if (r.value === null) return { wf: null }
  if (!isWorkflow(r.value)) {
    const moved = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, moved)
    } catch {}
    return { wf: null, corrupt: moved }
  }
  return { wf: r.value }
}

export function readWorkflow(worktree: string): Workflow | null {
  return readWorkflowChecked(worktree).wf
}

export function writeWorkflow(worktree: string, wf: Workflow, now = Date.now()): Workflow {
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
export function rotate(worktree: string): string | null {
  const wf = readWorkflow(worktree)
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
export function appendEvents(worktree: string, events: Array<Omit<FlowEventLine, "seq" | "at"> & { at?: number }>, now = Date.now()): number {
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
export function renderArtifact(worktree: string, rel: string, text: string): string {
  const path = join(worktree, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return sha256(text)
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

export function newWorkflow(sessionID: string, owner: Owner, entry: Workflow["entry"], request: string, now = Date.now()): Workflow {
  return {
    version: 1,
    id: newWorkflowId(now),
    kind: "plan",
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
