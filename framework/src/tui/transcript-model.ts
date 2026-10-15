import type { CliHostActivity } from "../hosts/cli-progress.ts"
import type { CliProgressTask } from "../hosts/cli-progress.ts"
import { settled, type ExecutionRunStatus } from "../hosts/run-state.ts"
import type { TranscriptText } from "../hosts/interactive-view.ts"

export type TranscriptItem =
  | { kind: "text"; id: string; text: string; provenance: TranscriptText["provenance"] }
  | { kind: "tool"; id: string; ordinal: number; executionID: string; callID: string; taskID: string; name: string; role: string;
      outcome: "running" | "succeeded" | "failed" | "denied"; expanded: boolean; evidence: string[] }
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
  constructor(readonly sessionID: string) {}
  get items(): readonly TranscriptItem[] { return this.entries }
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
  evidenceSnapshot(executionID: string, evidence: readonly string[]): void {
    for (const item of this.calls.values()) if (item.executionID === executionID) item.evidence = [...evidence]
  }
  executionSnapshot(state: ExecutionRunStatus, active: boolean): void {
    for (const item of this.calls.values()) {
      const execution = state.executions.find(record => record.executionId === item.executionID && record.ownerSession === this.sessionID)
      if (!execution) continue
      const quiescent = execution.reconciliation?.outcome === "terminal" && execution.reconciliation.quiescent === true ||
        execution.terminal?.quiescentAt !== undefined
      const proven = !!execution.terminal && quiescent && settled(execution) && !state.claim && !active
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
        taskID: activity.taskID, name: activity.tool, role: activity.role, outcome: "running", expanded: false, evidence: [] }
      this.calls.set(id, item)
      this.entries.push(item)
    }
    if (item.name !== activity.tool || item.taskID !== activity.taskID || item.role !== activity.role) {
      throw new Error("conflicting transcript tool identity")
    }
    if (activity.kind === "tool-finished") {
      if (item.outcome !== "running" && item.outcome !== activity.outcome) throw new Error("conflicting transcript terminal outcome")
      item.outcome = activity.outcome
    }
  }

  toggle(id: string): boolean {
    const item = this.calls.get(id)
    if (!item) return false
    item.expanded = !item.expanded
    return true
  }

  search(query: string): readonly TranscriptItem[] {
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    return this.entries.filter(item => {
      const task = item.kind === "tool" ? this.tasks.get(item.taskID) : undefined
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
        const rows = item.text.split("\n")
        let fenced = false
        const presented = rows.map((row, index) => {
          const fence = /^\s*```/u.test(row)
          const semantic = fenced ? "[code] " : row.startsWith("+") ? "[+] " : row.startsWith("-") ? "[-] " : ""
          const value = `${index === 0 ? `[${label}] ` : ""}${semantic}${row}`
          if (fence) fenced = !fenced
          return value
        })
        return presented.length ? presented : [`[${label}]`]
      }
      const outcome = item.outcome === "running" && this.historicalCalls.has(item.id) ? "running (last recorded; unconfirmed)" : item.outcome
      const task = this.tasks.get(item.taskID)
      const taskStatus = task?.status === "running" && this.historicalTasks.has(item.taskID) ? "running (last recorded)" : task?.status ?? ""
      const summary = `${item.expanded ? "[-]" : "[+]"} #${item.ordinal} ${item.name} · ${outcome} · task ${task?.title ?? "title unavailable"} · ${item.taskID} ${taskStatus}`
      return item.expanded ? [summary, `  Call ${item.callID} · execution ${item.executionID} · ${item.role}`, ...item.evidence.map(line => `  ${line}`)] : [summary]
    })
  }
}
