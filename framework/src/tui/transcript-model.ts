import type { CliHostActivity, CliToolDetail, CliToolDisplay } from "../hosts/cli-progress.ts"
import type { CliProgressTask } from "../hosts/cli-progress.ts"
import { settled, type ExecutionRunStatus } from "../hosts/run-state.ts"
import type { TranscriptText } from "../hosts/interactive-view.ts"
import { formatDuration } from "./progress.ts"

export type ExecutionDisplay = {
  state: "not-observed" | "unconfirmed" | "settled" | "historical"
  fence: boolean
  claim: boolean
}

export type ShellItemStatus = "running" | "complete" | "error" | "cancelled" | "timeout"
export type ShellItem = {
  kind: "shell"; id: string; ordinal: number; command: string; lines: string[]; totalLines: number
  status: ShellItemStatus; exitCode: number | null; signal: string | null; startedAt: number; durationMs?: number; expanded: boolean
  /** "operator" = a `!command`; "verify" = a task's verify command run by the queue. */
  source?: "operator" | "verify"; taskID?: string; attempt?: number; timeoutMs?: number
}
/** Collapsed shell windows show this many trailing output lines (GJC preview). */
export const SHELL_PREVIEW_LINES = 20

export type TranscriptItem =
  | { kind: "text"; id: string; text: string; provenance: TranscriptText["provenance"] }
  | ShellItem
  | { kind: "tool"; id: string; ordinal: number; executionID: string; callID: string; taskID: string; name: string; role: string;
      outcome: "running" | "succeeded" | "failed" | "denied"; expanded: boolean; evidence: string[]; execution: ExecutionDisplay
      /** Live-only (never restored): what the call targeted, its result size or error, and how long it ran. */
      detail?: CliToolDetail; startedAt?: number; durationMs?: number }
export type TranscriptDetail = { id: string; summary: string; lines: string[]; expandable: boolean }

/** Session-scoped facts only. It cannot approve, cancel, or settle execution. */
export class TranscriptModel {
  private readonly entries: TranscriptItem[] = []
  private readonly calls = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>()
  private sequence = 0
  private nextOrdinal = 0
  private readonly tasks = new Map<string, { status: string; title?: string }>()
  private readonly historicalTasks = new Set<string>()
  private readonly historicalCalls = new Set<string>()
  private readonly shells = new Map<string, ShellItem>()
  private readonly pendingDisplay = new Map<string, Partial<CliToolDisplay>>()
  private nextShellOrdinal = 0
  constructor(readonly sessionID: string, private readonly now: () => number = Date.now) {}
  get runningShell(): boolean {
    for (const shell of this.shells.values()) if (shell.status === "running") return true
    return false
  }
  /** A shell or tool call observed running in this process (restored, last-recorded state is excluded). */
  get liveActivity(): boolean {
    if (this.runningShell) return true
    for (const item of this.calls.values()) if (item.outcome === "running" && !this.historicalCalls.has(item.id)) return true
    return false
  }
  /**
   * Most specific live step: a running shell/verify command, else the newest running tool call (live only).
   * `startedAt` is the step's own start so the row can show how long it has run.
   */
  get liveStep(): { label: string; startedAt: number } | undefined {
    const clip = (value: string): string => {
      const flat = value.replace(/\s+/gu, " ").trim()
      return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat
    }
    let shell: ShellItem | undefined
    for (const item of this.shells.values()) if (item.status === "running") shell = item
    if (shell) return { label: `Bash: ${clip(shell.command)}`, startedAt: shell.startedAt }
    let call: Extract<TranscriptItem, { kind: "tool" }> | undefined
    for (const item of this.calls.values()) if (item.outcome === "running" && !this.historicalCalls.has(item.id)) call = item
    if (!call) return undefined
    const target = toolTarget(call.name, call.detail)
    const name = call.name.charAt(0).toUpperCase() + call.name.slice(1)
    return { label: clip(target ? `${name} ${target}` : name), startedAt: call.startedAt ?? this.now() }
  }
  /** The running task (observed in this process) as `Task t2: Title`. */
  get liveTask(): string | undefined {
    for (const [id, task] of this.tasks) if (task.status === "running" && !this.historicalTasks.has(id)) {
      const text = `Task ${id}${task.title ? `: ${task.title}` : ""}`.replace(/\s+/gu, " ")
      return text.length > 60 ? `${text.slice(0, 59)}…` : text
    }
    return undefined
  }
  get items(): readonly TranscriptItem[] { return this.entries }
  /** Counts over tasks observed in this process (restored, last-recorded tasks are excluded). */
  taskCounts(): { done: number; failed: number; cancelled: number; running: number; total: number } {
    const counts = { done: 0, failed: 0, cancelled: 0, running: 0, total: 0 }
    for (const [id, task] of this.tasks) {
      if (this.historicalTasks.has(id)) continue
      counts.total += 1
      if (task.status === "done" || task.status === "failed" || task.status === "cancelled" || task.status === "running") counts[task.status] += 1
    }
    return counts
  }
  get currentTask(): string | undefined {
    for (const [id, task] of this.tasks) if (task.status === "running" && !this.historicalTasks.has(id)) return `${task.title ?? id} running`
    return undefined
  }
  detailLines(): string[] {
    const lines: string[] = []
    for (const [id, task] of this.tasks) {
      const historical = this.historicalTasks.has(id)
      lines.push(`Task ${task.title ?? "title unavailable"} · ${id} · ${historical ? `${task.status} (last recorded)` : task.status}`)
      for (const item of this.calls.values()) {
        if (item.taskID !== id) continue
        const outcome = item.outcome === "running" && this.historicalCalls.has(item.id) ? "running (last recorded; unconfirmed)" : item.outcome
        lines.push(`  #${item.ordinal} ${item.name} · ${outcome}`)
        for (const evidence of item.evidence) lines.push(`    ${evidence}`)
      }
    }
    return lines
  }
  details(): TranscriptDetail[] {
    const details: TranscriptDetail[] = []
    for (const shell of this.shells.values()) {
      details.push({ id: shell.id, summary: `$${shell.ordinal} ${shell.command} · ${shellFooter(shell, this.now())}`, lines: shell.lines.slice(-SHELL_PREVIEW_LINES), expandable: true })
    }
    for (const [id, task] of this.tasks) {
      const historical = this.historicalTasks.has(id)
      details.push({ id: `task:${id}`, summary: `Task ${task.title ?? "title unavailable"} · ${id} · ${historical ? `${task.status} (last recorded)` : task.status}`, lines: [], expandable: false })
      for (const item of this.calls.values()) {
        if (item.taskID !== id) continue
        const outcome = item.outcome === "running" && this.historicalCalls.has(item.id) ? "running (last recorded; unconfirmed)" : item.outcome
        details.push({
          id: item.id,
          summary: `#${item.ordinal} ${item.name} · ${outcome}`,
          lines: [`Task ${item.taskID} · role ${item.role}`, ...item.evidence],
          expandable: true,
        })
      }
    }
    return details
  }
  taskSnapshot(tasks: readonly CliProgressTask[], historical = false): void {
    for (const task of tasks) {
      const prior = this.tasks.get(task.id)
      this.tasks.set(task.id, { status: task.status, ...(task.title ? { title: task.title } : prior?.title ? { title: prior.title } : {}) })
      if (historical) this.historicalTasks.add(task.id)
      else this.historicalTasks.delete(task.id)
    }
  }
  evidenceSnapshot(executionID: string, evidence: readonly string[], execution: ExecutionDisplay): void {
    for (const item of this.calls.values()) if (item.executionID === executionID) {
      item.evidence = [...evidence]
      item.execution = { ...execution }
    }
  }
  executionSnapshot(state: ExecutionRunStatus, active: boolean): void {
    for (const item of this.calls.values()) {
      const execution = state.executions.find(record => record.executionId === item.executionID && record.ownerSession === this.sessionID)
      if (!execution) continue
      const quiescent = execution.reconciliation?.outcome === "terminal" && execution.reconciliation.quiescent === true ||
        execution.terminal?.quiescentAt !== undefined
      const proven = !!execution.terminal && quiescent && settled(execution) && !state.claim && !active
      item.execution = { state: proven ? "settled" : "unconfirmed", fence: !!execution.fence, claim: !!state.claim }
      item.evidence = [
        `Execution terminal: ${execution.terminal?.outcome ?? "unconfirmed"}`,
        `Reconciliation: ${execution.reconciliation?.outcome ?? "unobserved"}`,
        `Quiescent: ${quiescent ? "observed" : "unconfirmed"}`,
        ...(execution.cancel ? [`Cancellation: ${proven ? "stopped with proof" : "unconfirmed"}`] : []),
        ...(state.claim ? ["Execution claim retained"] : []),
        ...(execution.fence ? ["Unresolved execution fence retained"] : []),
      ]
    }
  }

  append(value: string | TranscriptText): void {
    const entry = typeof value === "string" ? { text: value, provenance: "notice" as const } : value
    this.entries.push({ kind: "text", id: `text:${++this.sequence}`, text: entry.text, provenance: entry.provenance })
  }

  activity(activity: CliHostActivity, ordinal?: number, historical = false): void {
    if (activity.kind !== "tool-started" && activity.kind !== "tool-finished") return
    const id = `tool:${JSON.stringify([activity.executionID, activity.callID])}`
    if (historical) this.historicalCalls.add(id)
    else this.historicalCalls.delete(id)
    let item = this.calls.get(id)
    if (!item) {
      const assignedOrdinal = ordinal ?? this.nextOrdinal + 1
      if (!Number.isSafeInteger(assignedOrdinal) || assignedOrdinal < 1) throw new Error("invalid transcript tool ordinal")
      this.nextOrdinal = Math.max(this.nextOrdinal, assignedOrdinal)
      item = { kind: "tool", id, ordinal: assignedOrdinal, executionID: activity.executionID, callID: activity.callID,
        taskID: activity.taskID, name: activity.tool, role: activity.role, outcome: "running", expanded: false, evidence: [],
        execution: { state: "not-observed", fence: false, claim: false } }
      this.calls.set(id, item)
      this.entries.push(item)
      const pending = historical ? undefined : this.pendingDisplay.get(id)
      if (pending) {
        this.pendingDisplay.delete(id)
        if (pending.detail && Object.keys(pending.detail).length) item.detail = { ...pending.detail }
        if (pending.durationMs !== undefined) item.durationMs = pending.durationMs
      }
    }
    if (item.name !== activity.tool || item.taskID !== activity.taskID || item.role !== activity.role) {
      throw new Error("conflicting transcript tool identity")
    }
    if (!historical && activity.kind === "tool-started") item.startedAt ??= this.now()
    if (activity.kind === "tool-finished") {
      if (item.outcome !== "running" && item.outcome !== activity.outcome) throw new Error("conflicting transcript terminal outcome")
      item.outcome = activity.outcome
      if (!historical && item.durationMs === undefined && item.startedAt !== undefined) item.durationMs = Math.max(0, this.now() - item.startedAt)
    }
  }

  /** Live-only target/result/duration for a tool call already in the transcript (or arriving just before it). */
  toolDisplay(display: CliToolDisplay): void {
    const id = `tool:${JSON.stringify([display.executionID, display.callID])}`
    const item = this.calls.get(id)
    if (!item || this.historicalCalls.has(id)) {
      this.pendingDisplay.set(id, { ...this.pendingDisplay.get(id), ...display, detail: { ...this.pendingDisplay.get(id)?.detail, ...display.detail } })
      if (this.pendingDisplay.size > 256) this.pendingDisplay.delete(this.pendingDisplay.keys().next().value!)
      return
    }
    if (display.detail) item.detail = { ...item.detail, ...display.detail }
    if (display.durationMs !== undefined) item.durationMs = display.durationMs
  }

  /** Start a live shell window; `id` is the durable event identity used when it is persisted. */
  shellStarted(id: string, command: string, ordinal?: number, origin?: { source: "verify"; taskID: string; attempt: number; timeoutMs: number }): ShellItem {
    const existing = this.shells.get(id)
    if (existing) return existing
    const assigned = ordinal ?? this.nextShellOrdinal + 1
    this.nextShellOrdinal = Math.max(this.nextShellOrdinal, assigned)
    const item: ShellItem = { kind: "shell", id, ordinal: assigned, command, lines: [], totalLines: 0, status: "running",
      exitCode: null, signal: null, startedAt: this.now(), expanded: false, ...(origin ?? {}) }
    this.shells.set(id, item)
    this.entries.push(item)
    return item
  }

  shellOutput(id: string, lines: readonly string[], totalLines: number): void {
    const item = this.shells.get(id)
    if (!item || item.status !== "running") return
    item.lines = [...lines]
    item.totalLines = totalLines
  }

  shellFinished(id: string, result: { status: Exclude<ShellItemStatus, "running">; exitCode: number | null; signal: string | null; durationMs: number; lines: readonly string[]; totalLines: number }): void {
    const item = this.shells.get(id)
    if (!item) return
    Object.assign(item, { status: result.status, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, lines: [...result.lines], totalLines: result.totalLines })
  }

  toggle(id: string): boolean {
    const shell = this.shells.get(id)
    if (shell) {
      shell.expanded = !shell.expanded
      return true
    }
    const item = this.calls.get(id)
    if (!item) return false
    item.expanded = !item.expanded
    return true
  }

  search(query: string): readonly TranscriptItem[] {
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    return this.entries.filter(item => {
      const task = item.kind === "tool" ? this.tasks.get(item.taskID) : undefined
      if (item.kind === "shell") return terms.every(term => `${item.command} ${item.lines.join(" ")}`.toLocaleLowerCase().includes(term))
      const text = item.kind === "text" ? item.text : `${item.name} ${item.outcome} ${item.taskID} ${task?.title ?? ""} ${task?.status ?? ""} ${item.role} ${item.evidence.join(" ")}`
      return terms.every(term => text.toLocaleLowerCase().includes(term))
    })
  }

  lines(query?: string): string[] {
    return (query === undefined ? this.entries : this.search(query)).flatMap(item => {
      if (item.kind === "text") {
        const label = item.provenance === "user" ? "You" :
          item.provenance === "assistant" ? "Assistant" :
          item.provenance === "error" ? "Error" :
          item.provenance === "canonical-plan" ? "Canonical plan" : "Notice"
        // Logical lines keep the raw message; the renderer lays out Markdown and diff semantics.
        const presented = item.text.split("\n").map((row, index) => `${index === 0 ? `[${label}] ` : "  | "}${row}`)
        return presented.length ? presented : [`[${label}]`]
      }
      if (item.kind === "shell") {
        const shown = item.expanded ? item.lines : item.lines.slice(-SHELL_PREVIEW_LINES)
        const hidden = item.totalLines - shown.length
        const origin = item.source === "verify" && item.taskID
          ? [`  : verify ${item.taskID} · attempt ${item.attempt ?? 1}${item.timeoutMs ? ` · timeout ${formatDuration(item.timeoutMs)}` : ""}`] : []
        return [
          `[Shell] $${item.ordinal} $ ${item.command}`,
          ...origin,
          ...(hidden > 0 ? [`  : … ${hidden} earlier line${hidden === 1 ? "" : "s"}${item.expanded ? " not retained" : ` · /expand $${item.ordinal}`}`] : []),
          ...shown.map(line => `  | ${line}`),
          `  = ${shellFooter(item, this.now())}`,
        ]
      }
      const outcome = item.outcome === "running" && this.historicalCalls.has(item.id) ? "running (last recorded; unconfirmed)" : item.outcome
      const task = this.tasks.get(item.taskID)
      const taskStatus = task?.status === "running" && this.historicalTasks.has(item.taskID) ? "running (last recorded)" : task?.status ?? ""
      const execution = [
        ...(item.execution.state === "settled" ? [] : [
          item.execution.state === "historical" ? "execution last recorded" :
            item.execution.state === "unconfirmed" ? "execution unconfirmed" : "execution not observed",
        ]),
        ...(item.execution.fence ? ["fence retained"] : []),
        ...(item.execution.claim ? ["claim retained"] : []),
      ]
      const target = toolTarget(item.name, item.detail)
      const timing = item.durationMs !== undefined ? ` · ${formatDuration(item.durationMs)}`
        : item.outcome === "running" && item.startedAt !== undefined && !this.historicalCalls.has(item.id) ? ` · ${formatDuration(this.now() - item.startedAt)}` : ""
      const summary = `${item.expanded ? "[-]" : "[+]"} #${item.ordinal} ${item.name}${target ? ` ${target}` : ""}${timing} · call ${outcome}${execution.length ? ` · ${execution.join("; ")}` : ""}${item.taskID === item.executionID && !task ? "" : ` · task ${task?.title ?? "title unavailable"} · ${item.taskID}${taskStatus ? ` ${taskStatus}` : ""}`}`
      const result = item.detail?.error ? [`  Error: ${item.detail.error}`]
        : item.detail?.resultLines !== undefined ? [`  Result: ${item.detail.resultLines} line${item.detail.resultLines === 1 ? "" : "s"}`] : []
      return item.expanded ? [summary, `  Call ${item.callID} · execution ${item.executionID} · ${item.role}`, ...result, ...item.evidence.map(line => `  ${line}`)] : [summary]
    })
  }
}


/**
 * GJC-style target for a tool row: `path:120-140`, `pattern in path`, `path ⟦+3 / -1⟧`. Counts and paths only.
 * The `·` separator is reserved for row fields, so targets never contain it.
 */
export function toolTarget(name: string, detail: CliToolDetail | undefined): string {
  if (!detail) return ""
  const path = detail.path?.replace(/ · /gu, " - ")
  const pattern = detail.pattern?.replace(/ · /gu, " - ")
  if (name === "read" && path) {
    if (detail.offset === undefined && detail.limit === undefined) return path
    const first = detail.offset ?? 1
    return detail.limit !== undefined ? `${path}:${first}-${first + detail.limit - 1}` : `${path}:${first}-`
  }
  if ((name === "glob" || name === "grep") && pattern) return path ? `${JSON.stringify(pattern)} in ${path}` : JSON.stringify(pattern)
  if ((name === "write" || name === "edit") && path) {
    const counts = detail.added !== undefined || detail.removed !== undefined
      ? ` ⟦+${detail.added ?? 0} / -${detail.removed ?? 0}⟧` : ""
    return `${path}${counts}`
  }
  return path ?? pattern ?? ""
}

/** Status text for a shell window; the renderer picks its icon and color from the leading word. */
export function shellFooter(item: ShellItem, now: number): string {
  if (item.status === "running") return `running · ${Math.floor((now - item.startedAt) / 1000)}s · Esc cancels`
  const duration = formatDuration(item.durationMs ?? 0)
  if (item.status === "cancelled") return `cancelled · ${duration}`
  if (item.status === "timeout") return `timed out · ${duration}`
  if (item.signal) return `signal ${item.signal} · ${duration}`
  return `exit ${item.exitCode ?? "?"} · ${duration}`
}
