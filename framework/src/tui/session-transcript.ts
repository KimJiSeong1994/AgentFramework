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

export function restoreTranscript(model: TranscriptModel, records: readonly TranscriptRecord[], ordinalFor?: (executionID: string, callID: string) => number): { history: string[]; draft: string; queued: string[] } {
  const history: string[] = []
  let draft = ""
  let queued: string[] = []
  for (const record of records) {
    const data = record.data
    if (record.kind === "user" && typeof data.text === "string") {
      history.push(data.text)
      model.append(`You> ${data.text}`)
    } else if (record.kind === "assistant" && typeof data.text === "string") model.append(`Conversation:\n${data.text}`)
    else if (record.kind === "notice") {
      if (typeof data.text === "string") model.append(data.text)
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
      ])
    } else if (record.kind === "workflow-choice" || record.kind === "workflow-stage") {
      if (typeof data.text === "string") model.append(data.text)
    }
  }
  return { history, draft, queued }
}
