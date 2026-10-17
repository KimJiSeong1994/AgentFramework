// experimental.session.compacting: inject a ≤ 600-char checkpoint (mode, iterations, incomplete todos, preserve
// list) so the summary keeps what the loop needs; mirror it to sessionDir/checkpoint.json.
import type { Hooks } from "@opencode-ai/plugin"
import { join } from "node:path"
import type { HookDeps } from "./types.ts"
import { readModeState, readSessionInfo, sessionDir, writeJsonAtomic, type ModeState } from "../state/store.ts"
import { incompleteTodos, type Todo } from "../guards/todos.ts"
import { fetchOpenCodeTodos } from "../hosts/opencode-todos.ts"
import { openTasks, readLedger, type Ledger } from "../state/ledger.ts"
import { admissionEpoch, effectiveHold, isAdmissionCurrent } from "../sessions/admission.ts"

export const CHECKPOINT_MAX_CHARS = 600
const PRESERVE = "Preserve: files edited so far, the current task, and unresolved errors."

export function checkpointPath(worktree: string, sessionID: string): string {
  return join(sessionDir(worktree, sessionID), "checkpoint.json")
}

export function buildCheckpoint(state: ModeState, incomplete: Todo[], ledger?: Ledger): string {
  let head = `[otter checkpoint] mode=${state.mode}${state.active ? " (active)" : ""} iterations=${state.iterations}`
  if (ledger && ledger.tasks.length > 0) {
    const open = openTasks(ledger)
    const cur = ledger.tasks.find((t) => t.status === "running") ?? open[0]
    head += ` tasks=${ledger.tasks.length - open.length}/${ledger.tasks.length} done`
    if (cur) head += `; current: ${cur.n}. ${cur.title.slice(0, 60)}`
    head += open.length ? ` (unfinished: delegate resume:true continues them)` : ""
  }
  const budget = CHECKPOINT_MAX_CHARS - head.length - PRESERVE.length - 2
  let todoLine = ""
  if (incomplete.length > 0) {
    const titles: string[] = []
    let used = "Incomplete todos: ".length
    for (const t of incomplete) {
      const title = t.content.replace(/\s+/g, " ").trim().slice(0, 80)
      const piece = `${titles.length ? "; " : ""}${title}`
      if (used + piece.length > budget - 12) {
        titles.push(`… +${incomplete.length - titles.length} more`)
        break
      }
      titles.push(title)
      used += piece.length
    }
    todoLine = `Incomplete todos: ${titles.join("; ")}`
  }
  const text = [head, todoLine, PRESERVE].filter(Boolean).join("\n")
  return text.length > CHECKPOINT_MAX_CHARS ? text.slice(0, CHECKPOINT_MAX_CHARS - 1) + "…" : text
}

export function createCompactingHook(deps: HookDeps): NonNullable<Hooks["experimental.session.compacting"]> {
  return async (input, output) => {
    try {
      const agent = readSessionInfo(deps.worktree, input.sessionID)?.agent
      if (agent && agent !== "main") return // worker/reviewer compaction: nothing of ours to preserve
      const epoch = admissionEpoch(deps.worktree, input.sessionID)
      if (!epoch || effectiveHold(deps.worktree, input.sessionID)) {
        output.context.push("Otter session is held. Retained history is not permission to resume work.")
        return
      }
      const state = readModeState(deps.worktree, input.sessionID)
      const todos = await fetchOpenCodeTodos(deps.client, input.sessionID, deps.log)
      if (!isAdmissionCurrent(deps.worktree, input.sessionID, epoch)) return
      const incomplete = incompleteTodos(todos)
      const ledger = readLedger(deps.worktree, input.sessionID)
      const text = buildCheckpoint(state, incomplete, ledger)
      output.context.push(text)
      writeJsonAtomic(checkpointPath(deps.worktree, input.sessionID), {
        at: Date.now(),
        mode: state.mode,
        active: state.active,
        iterations: state.iterations,
        incomplete: incomplete.map((t) => ({ id: t.id, content: t.content, status: t.status })),
        text,
      })
      deps.log("checkpoint injected", { sessionID: input.sessionID, chars: text.length, incomplete: incomplete.length })
    } catch (e) {
      deps.log("compacting hook error", { error: (e as Error).message })
    }
  }
}
