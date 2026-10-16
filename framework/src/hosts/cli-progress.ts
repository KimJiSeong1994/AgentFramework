import { CLI_TOOL_NAMES, type CliToolName } from "./cli-tools.ts"
import { EXECUTION_ROLES, type ExecutionRole } from "./types.ts"
import type { Phase } from "../workflows/types.ts"

/** Exhaustive over Phase: adding a phase without deciding whether a final summary may report it fails typecheck. */
const FINAL_PHASES: Record<Phase, true> = {
  planning: true, reviewing: true, pending_approval: true, executing: true, stuck: true, paused: true, done: true, cancelled: true,
}

export type CliTaskStatus = "pending" | "running" | "done" | "failed" | "cancelled"

export type CliProgressTask = { id: string; status: CliTaskStatus; title?: string }

export type CliHostActivity =
  | { kind: "model-started"; role: ExecutionRole; execution: number }
  | { kind: "model-returned"; role: ExecutionRole; execution: number; status: "completed" | "failed" | "cancelled" | "unresolved" | "incomplete" }
  | { kind: "tool-started"; role: ExecutionRole; execution: number; taskID: string; executionID: string; callID: string; tool: CliToolName }
  | { kind: "tool-finished"; role: ExecutionRole; execution: number; taskID: string; executionID: string; callID: string; tool: CliToolName; outcome: "succeeded" | "failed" | "denied"; ok: boolean }

export type CliProgressFinal = {
  workflowID?: string
  phase: string
  done: number
  failed: number
  cancelled: number
  skipped?: string
}

export type CliProgressSink = {
  queue: (message: string, safeFields?: Record<string, unknown>) => void
  host: (activity: CliHostActivity) => void
}

export type CliProgressPresenter = CliProgressSink & {
  waiting: () => void
  responseReceived: () => void
  tasks: (tasks: readonly CliProgressTask[], totalCount?: number) => void
  taskSnapshot: (tasks: readonly CliProgressTask[]) => void
  suspend: () => void
  resume: () => void
  cancelRequested: () => void
  final: (summary: CliProgressFinal) => void
  error: () => void
}

export type CliProgressPresenterOptions = { toolLines?: boolean; mainModelLines?: boolean }

const TASK_STATUSES: readonly CliTaskStatus[] = ["pending", "running", "done", "failed", "cancelled"]
const MODEL_STATUSES = ["completed", "failed", "cancelled", "unresolved", "incomplete"] as const
const MAX_TRACKED_TASKS = 1024
const MAX_SEEN_ACTIVITIES = 256
const MAX_BUFFERED_LINES = 32

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function taskID(value: unknown): value is string {
  return typeof value === "string" && /^t\d{1,8}$/u.test(value)
}

function safeTaskTitle(value: string): string {
  let bounded = ""
  for (const character of value) {
    if (bounded.length + character.length > 512) break
    bounded += character
  }
  const safe = bounded
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/gu,
      character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`)
    .replace(/[\s]+/gu, " ")
    .trim()
  const characters = Array.from(safe)
  return characters.length > 120 ? `${characters.slice(0, 117).join("")}...` : safe
}

function boundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0 && value <= 1_000_000
}

function activityOrdinal(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0
}

function activityIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
}

function status(value: unknown): value is CliTaskStatus {
  return typeof value === "string" && TASK_STATUSES.includes(value as CliTaskStatus)
}

function roleName(role: ExecutionRole): string {
  switch (role) {
    case "main": return "Planning"
    case "worker": return "Worker"
    case "reviewer": return "Reviewer"
    case "data-analyst": return "Data analyst"
    case "data-verifier": return "Data verifier"
    case "ontology-evolver": return "Ontology evolver"
    case "answer-judge": return "Answer judge"
    case "interviewer": return "Interviewer"
    case "planner": return "Planner"
    case "architect": return "Architect"
    case "critic": return "Critic"
    case "researcher": return "Researcher"
    case "contrarian": return "Contrarian"
    case "simplifier": return "Simplifier"
  }
}

function validatedHostActivity(value: unknown): CliHostActivity | undefined {
  if (!isRecord(value) || !EXECUTION_ROLES.includes(value.role as ExecutionRole) || !activityOrdinal(value.execution)) return
  const role = value.role as ExecutionRole
  const execution = value.execution
  switch (value.kind) {
    case "model-started":
      return Object.freeze({ kind: "model-started", role, execution })
    case "model-returned":
      if (typeof value.status === "string" && MODEL_STATUSES.includes(value.status as (typeof MODEL_STATUSES)[number])) {
        return Object.freeze({ kind: "model-returned", role, execution, status: value.status as (typeof MODEL_STATUSES)[number] })
      }
      return
    case "tool-started":
      if (!CLI_TOOL_NAMES.includes(value.tool as CliToolName) || !activityIdentifier(value.taskID) ||
          !activityIdentifier(value.executionID) || !activityIdentifier(value.callID)) return
      return Object.freeze({
        kind: "tool-started", role, execution, taskID: value.taskID,
        executionID: value.executionID, callID: value.callID, tool: value.tool as CliToolName,
      })
    case "tool-finished":
      if (!CLI_TOOL_NAMES.includes(value.tool as CliToolName) || !activityIdentifier(value.taskID) ||
          !activityIdentifier(value.executionID) || !activityIdentifier(value.callID) || typeof value.ok !== "boolean" ||
          (value.outcome !== "succeeded" && value.outcome !== "failed" && value.outcome !== "denied") ||
          (value.outcome === "succeeded") !== value.ok) return
      return Object.freeze({
        kind: "tool-finished", role, execution, taskID: value.taskID,
        executionID: value.executionID, callID: value.callID, tool: value.tool as CliToolName,
        outcome: value.outcome, ok: value.ok,
      })
    default:
      return
  }
}

/** Append-only, line-oriented progress output. It accepts only fixed event vocabularies and bounded identifiers. */
export function createCliProgressPresenter(
  write: (text: string) => void,
  observe?: (activity: CliHostActivity) => void,
  options: CliProgressPresenterOptions = {},
): CliProgressPresenter {
  if (typeof write !== "function") throw new TypeError("CLI progress writer must be a function")
  if ((observe !== undefined && typeof observe !== "function") || !options || typeof options !== "object" ||
      (options.toolLines !== undefined && typeof options.toolLines !== "boolean") ||
      (options.mainModelLines !== undefined && typeof options.mainModelLines !== "boolean")) {
    throw new TypeError("invalid CLI progress presenter options")
  }
  const toolLines = options.toolLines !== false
  const mainModelLines = options.mainModelLines !== false

  const tasks = new Map<string, { status: CliTaskStatus; attempt?: number }>()
  const seen = new Set<string>()
  const startedToolCalls = new Set<string>()
  const finishedToolCalls = new Set<string>()
  const buffered: string[] = []
  let suspended = false
  let planningWaitActive = false
  let planningResponseReported = false

  const output = (line: string): void => {
    if (suspended) {
      if (buffered.length < MAX_BUFFERED_LINES) buffered.push(line)
      return
    }
    try { write(`${line}\n`) } catch { /* Progress output is observational and never changes execution. */ }
  }

  const once = (key: string, line: string): void => {
    if (seen.has(key)) return
    if (seen.size >= MAX_SEEN_ACTIVITIES) seen.clear()
    seen.add(key)
    output(line)
  }

  const updateTask = (id: string, next: CliTaskStatus, attempt?: number): void => {
    if (!taskID(id) || !tasks.has(id)) return
    const previous = tasks.get(id)!
    if (previous.status === next && (next !== "running" || attempt === undefined || previous.attempt === attempt)) return
    if (previous.status === "done" || previous.status === "failed" || previous.status === "cancelled") return
    tasks.set(id, { status: next, ...(attempt === undefined ? {} : { attempt }) })
    const detail = next === "running" && attempt !== undefined ? ` (attempt ${attempt})` : ""
    output(`[tasks] ${id} ${next}${detail}.`)
  }

  const taskSnapshot = (values: readonly CliProgressTask[]): void => {
    for (let index = 0; index < Math.min(values.length, MAX_TRACKED_TASKS); index++) {
      const value = values[index]!
      if (!value || !taskID(value.id) || !status(value.status) || !tasks.has(value.id)) continue
      updateTask(value.id, value.status)
    }
  }

  const host = (value: CliHostActivity): void => {
    const activity = validatedHostActivity(value)
    if (!activity) return
    try { observe?.(activity) } catch { /* Observers are observational and never change execution. */ }
    const label = roleName(activity.role)
    const keySuffix = `${activity.execution}:${activity.role}`
    if (activity.kind === "model-started") {
      if (activity.role === "main" && (planningWaitActive || !mainModelLines)) return
      once(`model-started:${keySuffix}`, `[activity] ${label} model is working.`)
      return
    }
    if (activity.kind === "model-returned") {
      if (!MODEL_STATUSES.includes(activity.status)) return
      if (activity.role === "main") planningWaitActive = false
      if (activity.status === "completed") {
        if (activity.role === "main") {
          if (mainModelLines && !planningResponseReported) output("[activity] Planning model response received.")
          planningResponseReported = true
        } else once(`model-returned:${keySuffix}`, `[activity] ${label} model response received.`)
      } else {
        once(`model-error:${keySuffix}:${activity.status}`, `[error] ${label} model request ${activity.status}.`)
      }
      return
    }
    if (!toolLines) return
    const callKey = JSON.stringify([activity.executionID, activity.callID])
    if (activity.kind === "tool-started") {
      if (startedToolCalls.has(callKey)) return
      startedToolCalls.add(callKey)
      output(`[activity] ${label} started ${activity.tool} tool.`)
      return
    }
    if (activity.kind !== "tool-finished" || finishedToolCalls.has(callKey)) return
    finishedToolCalls.add(callKey)
    const outcome = activity.outcome === "succeeded" ? "finished" : activity.outcome
    const prefix = activity.ok ? "[activity]" : "[error]"
    output(`${prefix} ${label} ${outcome} ${activity.tool} tool.`)
  }

  const queue = (message: string, fields?: Record<string, unknown>): void => {
    if (typeof message !== "string" || !isRecord(fields)) return
    const id = fields.task
    if ((message === "task start" || message === "data task start") &&
        taskID(id) && boundedCount(fields.attempt) && fields.attempt > 0) {
      updateTask(id, "running", fields.attempt)
      return
    }
    if (message === "task verify started" && taskID(id) && tasks.has(id) &&
        boundedCount(fields.attempt) && fields.attempt > 0) {
      once(`verify-start:${id}:${fields.attempt}`, `[activity] ${id} verification started (attempt ${fields.attempt}).`)
      return
    }
    if (message === "task verify" && taskID(id) && tasks.has(id) && typeof fields.ok === "boolean") {
      const attempt = tasks.get(id)?.attempt ?? 0
      const result = fields.ok ? "passed" : "failed"
      once(`verify:${id}:${attempt}:${result}`, `[activity] ${id} verification ${result}.`)
      return
    }
    if ((message === "task attempt failed" || message === "data task attempt failed") &&
        taskID(id) && tasks.has(id) && boundedCount(fields.attempt) && fields.attempt > 0) {
      once(`attempt-failed:${id}:${fields.attempt}`, `[error] ${id} attempt ${fields.attempt} failed; final task status is not yet settled.`)
      return
    }
    if (message === "task finished" && taskID(id) && status(fields.status)) {
      updateTask(id, fields.status)
      return
    }
    if (message === "ledger: open tasks cancelled" && Array.isArray(fields.ids)) {
      for (let index = 0; index < Math.min(fields.ids.length, MAX_TRACKED_TASKS); index++) {
        const cancelledID = fields.ids[index]
        if (taskID(cancelledID)) updateTask(cancelledID, "cancelled")
      }
      return
    }
    if (message === "queue crashed") {
      once("queue-crashed", "[error] Task queue stopped unexpectedly; task state may require recovery.")
      return
    }
    if (message === "foreground cancellation refused" || message === "foreground cancellation failed") {
      once("foreground-cancel-error", "[error] Cancellation could not be confirmed; task settlement is still required.")
    }
  }

  return {
    queue,
    host,
    waiting() {
      if (planningWaitActive) return
      planningWaitActive = true
      planningResponseReported = false
      if (mainModelLines) output("[progress] Waiting for the planning model.")
    },
    responseReceived() {
      planningWaitActive = false
      if (planningResponseReported) return
      planningResponseReported = true
      if (mainModelLines) output("[activity] Planning model response received.")
    },
    tasks(values, requestedTotal = values.length) {
      const accepted: CliProgressTask[] = []
      const acceptedIDs = new Set<string>()
      for (let index = 0; index < Math.min(values.length, MAX_TRACKED_TASKS); index++) {
        const value = values[index]!
        if (value && taskID(value.id) && status(value.status) && !acceptedIDs.has(value.id)) {
          accepted.push(value)
          acceptedIDs.add(value.id)
        }
      }
      tasks.clear()
      for (const value of accepted) tasks.set(value.id, { status: value.status })
      const total = Number.isSafeInteger(requestedTotal) && requestedTotal >= values.length ? requestedTotal : values.length
      const omitted = Math.max(0, total - accepted.length)
      const noun = total === 1 ? "task" : "tasks"
      const omittedNoun = omitted === 1 ? "task" : "tasks"
      output(`[tasks] Approved task list (${total} ${noun}${omitted ? `; ${omitted} ${omittedNoun} not shown or tracked` : ""}):`)
      if (accepted.length === 0) output("[tasks] No task IDs were recorded.")
      for (const value of accepted) {
        const title = typeof value.title === "string" ? safeTaskTitle(value.title) : ""
        output(`[tasks] ${value.id} ${value.status}${title ? ` — ${title}` : ""}.`)
      }
    },
    taskSnapshot,
    suspend() { suspended = true },
    resume() {
      suspended = false
      for (const line of buffered.splice(0)) output(line)
    },
    cancelRequested() {
      once("cancel-requested", "[progress] Cancellation requested; outcome is not yet settled.")
    },
    final(summary) {
      if (!summary || !Object.hasOwn(FINAL_PHASES, summary.phase) ||
          !boundedCount(summary.done) || !boundedCount(summary.failed) || !boundedCount(summary.cancelled) ||
          (summary.skipped !== undefined && typeof summary.skipped !== "string")) return
      const skipped = summary.skipped ? "; skipped work" : ""
      const workflowID = taskWorkflowID(summary.workflowID) ? ` ${summary.workflowID}` : ""
      output(`[final] Workflow${workflowID} ${summary.phase}; done ${summary.done}, failed ${summary.failed}, cancelled ${summary.cancelled}${skipped}.`)
    },
    error() {
      once("interactive-error", "[error] Operation failed; diagnostic details are not shown in progress output.")
    },
  }
}

function taskWorkflowID(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^wf_[A-Za-z0-9._:-]+$/u.test(value)
}
