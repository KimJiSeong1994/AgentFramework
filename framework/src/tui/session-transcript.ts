import { EXECUTION_ROLES } from "../hosts/types.ts"
import { CLI_TOOL_NAMES, type CliToolName } from "../hosts/cli-tools.ts"
import type { CliHostActivity, CliTaskStatus } from "../hosts/cli-progress.ts"
import type { SessionStore, TranscriptRecord } from "../sessions/store.ts"
import type { TranscriptModel } from "./transcript-model.ts"

/** Persistence projection deliberately excludes tool arguments, bodies and call clocks. */
export function persistToolActivity(store: SessionStore, activity: CliHostActivity): void {
  if (activity.kind !== "tool-started" && activity.kind !== "tool-finished") return
  const outcome = activity.kind === "tool-started" ? "running" : activity.outcome
  const kind = activity.kind === "tool-started" ? "tool-start" : outcome === "denied" ? "tool-denied" : "tool-result"
  store.append(kind, { name: activity.tool, role: activity.role, executionID: activity.executionID,
    callID: activity.callID, taskID: activity.taskID, outcome }, `${kind}:${JSON.stringify([activity.executionID, activity.callID])}`)
}

export function restoreTranscript(
  model: TranscriptModel,
  records: readonly TranscriptRecord[],
  ordinalFor?: (executionID: string, callID: string) => number,
  shellOrdinalFor?: (eventID: string) => number,
): { history: string[]; draft: string; queued: string[] } {
  const history: string[] = []
  let draft = ""
  let queued: string[] = []
  for (const record of records) {
    const data = record.data
    if (record.kind === "user" && typeof data.text === "string") {
      history.push(data.text)
      model.append({ provenance: "user", text: data.text })
    } else if (record.kind === "assistant" && typeof data.text === "string") model.append({ provenance: "assistant", text: data.text })
    else if (record.kind === "canonical-plan" && typeof data.text === "string") model.append({ provenance: "canonical-plan", text: data.text })
    else if (record.kind === "notice") {
      if (typeof data.text === "string") model.append({ provenance: data.provenance === "error" ? "error" : "notice", text: data.text })
      if (typeof data.draft === "string" && Array.isArray(data.queued) && data.queued.every(value => typeof value === "string")) {
        draft = data.draft
        queued = data.queued as string[]
      }
    } else if (["tool-start", "tool-result", "tool-denied"].includes(record.kind)) {
      if (typeof data.role !== "string" || !EXECUTION_ROLES.includes(data.role as typeof EXECUTION_ROLES[number]) ||
          typeof data.name !== "string" || !CLI_TOOL_NAMES.includes(data.name as CliToolName) ||
          typeof data.callID !== "string" || typeof data.executionID !== "string" || typeof data.taskID !== "string") {
        throw new Error("invalid stored tool correlation")
      }
      const base = { role: data.role as typeof EXECUTION_ROLES[number], tool: data.name as CliToolName,
        callID: data.callID, executionID: data.executionID, taskID: data.taskID, execution: record.seq }
      const ordinal = ordinalFor?.(base.executionID, base.callID)
      if (record.kind === "tool-start") model.activity({ kind: "tool-started", ...base }, ordinal, true)
      else {
        if (data.outcome !== "succeeded" && data.outcome !== "failed" && data.outcome !== "denied") throw new Error("invalid stored tool outcome")
        model.activity({ kind: "tool-finished", ...base, outcome: data.outcome, ok: data.outcome === "succeeded" }, ordinal, true)
      }
    } else if (record.kind === "task-state") {
      if (typeof data.taskID !== "string" || !["pending", "running", "done", "failed", "cancelled"].includes(String(data.status))) throw new Error("invalid stored task state")
      model.taskSnapshot([{ id: data.taskID, status: data.status as CliTaskStatus }], true)
    } else if (record.kind === "task-evidence") {
      if (typeof data.executionID !== "string" || typeof data.terminal !== "string" || typeof data.reconciliation !== "string" ||
          typeof data.quiescent !== "boolean" || typeof data.claim !== "boolean" || typeof data.fence !== "boolean" ||
          data.cancel !== null && data.cancel !== "unconfirmed" && data.cancel !== "stopped with proof") throw new Error("invalid stored execution evidence")
      model.evidenceSnapshot(data.executionID, [
        `Execution terminal: ${data.terminal}`, `Reconciliation: ${data.reconciliation}`, `Quiescent: ${data.quiescent ? "observed" : "unconfirmed"}`,
        ...(data.cancel ? [`Cancellation: ${data.cancel}`] : []), ...(data.claim ? ["Execution claim retained"] : []),
        ...(data.fence ? ["Unresolved execution fence retained"] : []),
      ], { state: "historical", fence: data.fence, claim: data.claim })
    } else if (record.kind === "shell") {
      const status = data.status
      if (typeof data.command !== "string" || !Array.isArray(data.lines) || !data.lines.every(line => typeof line === "string") ||
          typeof data.totalLines !== "number" || typeof data.durationMs !== "number" ||
          (status !== "complete" && status !== "error" && status !== "cancelled" && status !== "timeout") ||
          !(data.exitCode === null || typeof data.exitCode === "number") || !(data.signal === null || typeof data.signal === "string")) {
        throw new Error("invalid stored shell run")
      }
      model.shellStarted(record.eventID, data.command, shellOrdinalFor?.(record.eventID))
      model.shellFinished(record.eventID, { status, exitCode: data.exitCode, signal: data.signal, durationMs: data.durationMs, lines: data.lines as string[], totalLines: data.totalLines })
    } else if (record.kind === "carried-context") {
      const messages = Array.isArray(data.messages) ? data.messages as Array<{ role?: unknown; text?: unknown }> : []
      if (typeof data.engine !== "string" || typeof data.model !== "string" ||
          !messages.every(message => (message.role === "user" || message.role === "assistant") && typeof message.text === "string")) {
        throw new Error("invalid stored carried context")
      }
      const turns = messages.length / 2
      model.append({ provenance: "notice", text: `Earlier conversation with ${data.engine} / ${data.model} (${turns} turn${turns === 1 ? "" : "s"})` })
      for (const message of messages) {
        if (message.role === "user") history.push(message.text as string)
        model.append({ provenance: message.role as "user" | "assistant", text: message.text as string })
      }
    } else if (record.kind === "workflow-choice" || record.kind === "workflow-stage") {
      if (typeof data.text === "string") model.append({ provenance: "notice", text: data.text })
    }
  }
  return { history, draft, queued }
}
