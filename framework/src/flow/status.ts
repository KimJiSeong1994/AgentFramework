// `/status` (M0) and the future `lca status` CLI: derived only from workflow.json/archive + events + ledger + mode.
import type { FlowRuntime } from "../hosts/types.ts"
import type { LcaConfig } from "../config.ts"
import { readFileSync } from "node:fs"
import { counts, emptyLedger, ledgerPath, tasksForWorkflow, type Ledger } from "../state/ledger.ts"
import { EMPTY_MODE, modeStatePath, type ModeState } from "../state/store.ts"
import { authorize } from "./owner.ts"
import { liveness } from "./runtime.ts"
import { PHASES } from "./machine.ts"
import { readEvents, workflowPath, type Workflow } from "./state.ts"
import { createExecutionRunStore, settled } from "../hosts/run-state.ts"

export const STATUS_MARKER = "[lca status]"

export function flowOn(config: LcaConfig): boolean {
  return config.flow.enabled && !config.disabled_hooks.includes("flow")
}

export type StatusJson = {
  workflow: null | {
    id: string; phase: string; stuckCause?: string; sessionID: string; ownerLive: boolean
    engine?: string; planSha?: string
    plan?: string; review?: string; tasks?: { total: number; done: number; open: number; failed: number }
    counters: Workflow["counters"]; pendingCancel: boolean
  }
  session: { id: string; mode: string; modeActive: boolean; queueRunning: boolean; ledger: Record<string, number> }
  execution: { generation: number; ownerSessionID?: string; unresolved: number; cancelledAcknowledged: number; usage: "unknown"; verification?: string }
  events: Array<{ seq: number; type: string; to?: string }>
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readStatusJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")) as unknown }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
}

function statusWorkflow(worktree: string): Workflow | null {
  const value = readStatusJson(workflowPath(worktree))
  if (value === undefined) return null
  if (!object(value) || value.version !== 1 || value.kind !== "plan" || typeof value.id !== "string" || !value.id ||
    typeof value.sessionID !== "string" || !value.sessionID || !PHASES.includes(value.phase as Workflow["phase"]) ||
    !["command", "keyword"].includes(value.entry as string) || typeof value.request !== "string" ||
    !Number.isSafeInteger(value.lastSeq) || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) ||
    !object(value.owner) || typeof value.owner.instance !== "string" || !Number.isSafeInteger(value.owner.pid) ||
    !Number.isFinite(value.owner.heartbeatAt) || !object(value.counters) ||
    !["code_invalid", "review_iterations", "user_rejections", "nudges"].every(key => Number.isSafeInteger((value.counters as Record<string, unknown>)[key])) ||
    (value.planRef !== undefined && (!object(value.planRef) || typeof value.planRef.mdPath !== "string")) ||
    (value.review !== undefined && (!object(value.review) || typeof value.review.verdict !== "string" ||
      (value.review.note !== undefined && typeof value.review.note !== "string")))) throw new Error("invalid workflow state")
  return value as Workflow
}

function statusLedger(worktree: string, sessionID: string): Ledger {
  const value = readStatusJson(ledgerPath(worktree, sessionID))
  if (value === undefined) return emptyLedger(sessionID)
  if (!object(value) || value.version !== 1 || value.sessionID !== sessionID ||
    !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) || !Array.isArray(value.tasks) ||
    !value.tasks.every(task => object(task) && typeof task.id === "string" &&
      ["pending", "running", "done", "failed", "cancelled"].includes(task.status as string) &&
      (task.wf === undefined || (object(task.wf) && typeof task.wf.id === "string")))) throw new Error("invalid ledger state")
  return value as Ledger
}

function statusMode(worktree: string, sessionID: string): ModeState {
  const value = readStatusJson(modeStatePath(worktree, sessionID))
  if (value === undefined) return EMPTY_MODE
  if (!object(value) || !["none", "ulw", "plan", "data"].includes(value.mode as string) || typeof value.active !== "boolean" ||
    !["startedAt", "updatedAt", "iterations", "stagnation", "failures"].every(key => Number.isFinite(value[key]))) {
    throw new Error("invalid mode state")
  }
  return value as ModeState
}

export function statusJson(deps: FlowRuntime, sessionID: string, queueRunning: boolean, now = Date.now()): StatusJson {
  const run = createExecutionRunStore(deps.worktree).status()
  const unresolved = run.executions.filter((execution) => !settled(execution))
  const wf = statusWorkflow(deps.worktree)
  const mode = statusMode(deps.worktree, sessionID)
  const ledger = statusLedger(deps.worktree, sessionID)
  const passedLegacy = run.executions.findLast(execution => execution.ownerSession === sessionID &&
    execution.kind === "verifier" && execution.profile === "legacy-unowned" &&
    execution.descendantRisk === "unproven" && execution.terminal?.outcome === "ok" &&
    execution.terminal.verification?.integrity === "unchanged" &&
    ledger.tasks.some(task => task.id === execution.taskId && task.status === "done"))
  let workflow: StatusJson["workflow"] = null
  if (wf) {
    const live = authorize("status", wf.sessionID, wf, liveness(deps, now)).kind === "allow"
    const tagged = tasksForWorkflow(wf.sessionID === sessionID ? ledger : statusLedger(deps.worktree, wf.sessionID), wf.id)
    workflow = {
      id: wf.id,
      phase: wf.phase,
      ...(wf.stuckCause ? { stuckCause: wf.stuckCause } : {}),
      sessionID: wf.sessionID,
      ...(typeof wf.engine === "string" ? { engine: wf.engine } : {}),
      ...(typeof wf.planRef?.jsonSha === "string" && /^[a-f0-9]{64}$/.test(wf.planRef.jsonSha)
        ? { planSha: wf.planRef.jsonSha } : {}),
      ownerLive: live,
      ...(wf.planRef ? { plan: wf.planRef.mdPath } : {}),
      ...(wf.review ? { review: `${wf.review.verdict}${wf.review.note ? ` (${wf.review.note})` : ""}` } : {}),
      ...(tagged.length
        ? { tasks: {
            total: tagged.length,
            done: tagged.filter((t) => t.status === "done").length,
            open: tagged.filter((t) => t.status === "pending" || t.status === "running").length,
            failed: tagged.filter((t) => t.status === "failed" || t.status === "cancelled").length,
          } }
        : {}),
      counters: wf.counters,
      pendingCancel: !!wf.pendingCancel,
    }
  }
  const events = wf ? readEvents(deps.worktree, wf.id).slice(-5).map((e) => ({ seq: e.seq, type: e.type, ...(e.to ? { to: e.to } : {}) })) : []
  return {
    workflow,
    session: { id: sessionID, mode: mode.mode, modeActive: mode.active, queueRunning, ledger: counts(ledger) },
    execution: {
      generation: run.generation,
      ...(run.claim ? { ownerSessionID: run.claim.ownerSession } : {}),
      unresolved: unresolved.length,
      cancelledAcknowledged: unresolved.filter((execution) => execution.cancel?.acknowledgedAt !== undefined).length,
      usage: "unknown",
      ...(passedLegacy ? { verification: "passed (legacy-unowned, descendants unproven)" } : {}),
    },
    events,
  }
}

/** <= 25 lines, code-rendered; starts with STATUS_MARKER so e2e can prove the model did not write it. */
export function renderStatus(deps: FlowRuntime, sessionID: string, queueRunning: boolean, now = Date.now()): string {
  const s = statusJson(deps, sessionID, queueRunning, now)
  const lines = [STATUS_MARKER]
  const w = s.workflow
  if (!w) lines.push("workflow: none")
  else {
    const phase = w.stuckCause ? `${w.phase}(${w.stuckCause})` : w.phase
    const owner = w.sessionID === sessionID ? "this session" : `session ${w.sessionID}`
    lines.push(`workflow: ${w.id} ${phase}${w.pendingCancel ? " cancelling" : ""} — ${owner}${w.ownerLive ? "" : ", owner dead"}`)
    if (w.plan) lines.push(`plan: ${w.plan}`)
    if (w.review) lines.push(`review: ${w.review}`)
    if (w.tasks) lines.push(`plan tasks: ${w.tasks.done}/${w.tasks.total} done, ${w.tasks.open} open, ${w.tasks.failed} failed/cancelled`)
    const c = w.counters
    lines.push(`counters: invalid ${c.code_invalid}, review ${c.review_iterations}, rejects ${c.user_rejections}, nudges ${c.nudges}`)
  }
  const l = s.session.ledger
  lines.push(`mode: ${s.session.modeActive ? s.session.mode : "none"}`)
  lines.push(`ledger: ${l.done ?? 0} done, ${(l.pending ?? 0) + (l.running ?? 0)} open, ${l.failed ?? 0} failed, ${l.cancelled ?? 0} cancelled; queue ${s.session.queueRunning ? "running" : "idle"}`)
  if (s.execution.unresolved) lines.push(`execution: ${s.execution.unresolved} unresolved, ${s.execution.cancelledAcknowledged} cancel ACK; generation ${s.execution.generation}; usage unknown`)
  if (s.execution.verification) lines.push(`verification: ${s.execution.verification}`)
  if (s.events.length) lines.push(`events: ${s.events.map((e) => `#${e.seq} ${e.type}${e.to ? `→${e.to}` : ""}`).join(", ")}`)
  return lines.slice(0, 25).join("\n")
}
