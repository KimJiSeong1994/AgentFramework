// Composer progress bar: a single line shown in the input box's top border while work is live.
// Every value comes from observed state (task snapshots, the committed workflow stage, a live request); nothing is
// estimated. Stage position is a position, not a completion percentage, because stages can loop (revision, rounds).
import { displayWidth } from "./render.ts"

/** Structured workflow facts pushed with the workflow status line. */
export type WorkflowProgress = {
  readonly kind: string
  readonly stage: string
  readonly phase: string
  /** Goals for ultragoal: completed of total, when known. */
  readonly goals?: { readonly complete: number; readonly total: number }
}

/** Elapsed or limit time for tool cards: 42ms, 1.8s, 12s, 2m05s. */
export function formatDuration(ms: number): string {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 10_000) return `${(value / 1000).toFixed(1)}s`
  const total = Math.round(value / 1000)
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`
}

export type TaskCounts = { readonly done: number; readonly failed: number; readonly cancelled: number; readonly running: number; readonly total: number }

export type ProgressState =
  | { readonly kind: "tasks"; readonly counts: TaskCounts }
  | { readonly kind: "goals"; readonly complete: number; readonly total: number; readonly label: string }
  | { readonly kind: "stage"; readonly index: number; readonly count: number; readonly label: string; readonly settled: boolean }
  | { readonly kind: "busy"; readonly frame: number; readonly label: string }

const ACTIVE_PHASES = new Set(["planning", "reviewing", "executing"])
const IDLE_PHASES = new Set(["pending_approval", "paused", "stuck"])

/**
 * Steps in the order each driver moves through them (the registry lists stages by declaration, not by flow). Loops
 * share a step: a ralplan revision redrafts like the planner, and a deep-interview round is question -> answer ->
 * scoring. Ultragoal and autoresearch repeat their middle steps per goal/experiment.
 */
const FLOW: Readonly<Record<string, readonly (readonly string[])[]>> = {
  plan: [["draft"], ["review"], ["decision"], ["unit"]],
  ralplan: [["planner", "revision"], ["architect"], ["critic"], ["consensus_emit"], ["pending_execution"]],
  "deep-interview": [["intake"], ["topology"], ["question", "answer", "scoring"], ["panel"], ["closure"], ["restate"], ["crystallize"]],
  ultragoal: [["decompose"], ["goal_select"], ["unit_plan"], ["unit_review"], ["unit_approval"], ["unit_execute"], ["verify"], ["checkpoint"], ["final_review"]],
  autoresearch: [["intake"], ["hypothesis"], ["evidence"], ["experiment_prepare"], ["experiment_approval"], ["experiment_run"], ["evaluate"], ["verdict_emit"]],
}

/** 1-based step position in the kind's flow; undefined for unknown kinds or stages (including terminal). */
export function stagePosition(kind: string, stage: string): { index: number; count: number } | undefined {
  const flow = FLOW[kind]
  if (!flow) return undefined
  const at = flow.findIndex(step => step.includes(stage))
  return at < 0 ? undefined : { index: at + 1, count: flow.length }
}

/**
 * Pick what the bar shows, most concrete evidence first: a live task run, ultragoal goals, the workflow stage,
 * then a bare busy indicator. Returns undefined when nothing is live (the input box keeps its plain border).
 */
export function progressState(input: {
  tasks?: TaskCounts
  workflow?: WorkflowProgress
  busy: boolean
  frame: number
  activity?: string
}): ProgressState | undefined {
  const { tasks, workflow } = input
  const taskRunLive = tasks && tasks.total > 0 && (tasks.running > 0 || (input.busy && tasks.done + tasks.failed + tasks.cancelled < tasks.total))
  if (tasks && taskRunLive) return { kind: "tasks", counts: tasks }
  const workflowLive = workflow && (ACTIVE_PHASES.has(workflow.phase) || IDLE_PHASES.has(workflow.phase))
  if (workflow && workflowLive) {
    if (workflow.kind === "ultragoal" && workflow.goals && workflow.goals.total > 0) {
      return { kind: "goals", complete: workflow.goals.complete, total: workflow.goals.total, label: `${workflow.kind} · ${workflow.stage}` }
    }
    const position = stagePosition(workflow.kind, workflow.stage)
    if (position) {
      return {
        kind: "stage", index: position.index, count: position.count,
        label: `${workflow.kind} · ${workflow.stage}${IDLE_PHASES.has(workflow.phase) ? ` · ${workflow.phase.replace("_", " ")}` : ""}`,
        settled: IDLE_PHASES.has(workflow.phase),
      }
    }
  }
  if (input.busy) return { kind: "busy", frame: input.frame, label: input.activity ?? "working" }
  return undefined
}

function bar(filled: number, total: number, cells: number, ascii: boolean): string {
  const full = ascii ? "#" : "█"
  const empty = ascii ? "-" : "░"
  const on = total <= 0 ? 0 : Math.max(0, Math.min(cells, Math.round((filled / total) * cells)))
  return full.repeat(on) + empty.repeat(cells - on)
}

/** Indeterminate bar: a short block sliding across the track, driven by the shared spinner clock. */
function slider(frame: number, cells: number, ascii: boolean): string {
  const block = Math.max(2, Math.floor(cells / 4))
  const span = cells + block
  const head = frame % span
  let out = ""
  for (let index = 0; index < cells; index += 1) out += index < head && index >= head - block ? (ascii ? "#" : "█") : (ascii ? "-" : "░")
  return out
}

/** One-line rendering that fits `width` display columns; the bar shrinks before the label is clipped. */
export function renderProgress(state: ProgressState, width: number, ascii = false): string {
  const separator = ascii ? " | " : " · "
  let tail: string
  if (state.kind === "tasks") {
    const { done, failed, cancelled, total } = state.counts
    const finished = done + failed + cancelled
    tail = `${finished}/${total} tasks${failed ? `${separator}${failed} failed` : ""}${cancelled ? `${separator}${cancelled} cancelled` : ""}${separator}${Math.floor((finished / total) * 100)}%`
  } else if (state.kind === "goals") {
    tail = `${state.complete}/${state.total} goals${separator}${state.label}`
  } else if (state.kind === "stage") {
    tail = `step ${state.index}/${state.count}${separator}${state.label}`
  } else {
    tail = state.label
  }
  const cells = Math.max(6, Math.min(24, width - displayWidth(tail) - 1))
  const track = state.kind === "tasks"
    ? bar(state.counts.done + state.counts.failed + state.counts.cancelled, state.counts.total, cells, ascii)
    : state.kind === "goals" ? bar(state.complete, state.total, cells, ascii)
      : state.kind === "stage" ? bar(state.index, state.count, cells, ascii)
        : slider(state.frame, cells, ascii)
  return `${track} ${tail}`
}
