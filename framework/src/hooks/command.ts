// `/stop` command (command.execute.before): the user's hard stop for the idle loop and the task queue.
// Writes abort.json (checked by every breaker), deactivates the mode, and aborts the running child session.
// The command's template text still reaches the model as a normal user message; chat.message turns it into the
// cancel suffix, so main finishes its current step and stops.
import type { Hooks } from "@opencode-ai/plugin"
import type { HookDeps } from "./types.ts"
import { EMPTY_MODE, abortPath, readModeState, writeJsonAtomic, writeModeState } from "../state/store.ts"
import { getQueue } from "../orchestration/queue.ts"
import { markCommandTurn } from "./command-turns.ts"

export const STOP_COMMAND = "stop"
export const STOP_TEMPLATE = "stop lca: cancel the active mode and the task queue. Finish the current step, then stop."
export const STOP_DESCRIPTION = "lca: stop the task queue / continuation loop"

export function createCommandHook(deps: HookDeps, opts: { stop?: boolean } = {}): NonNullable<Hooks["command.execute.before"]> {
  const queue = getQueue(deps)
  const stopOn = opts.stop ?? true
  return async (input) => {
    // Every explicit command keeps its own authority: its expanded template must not be skill-routed.
    markCommandTurn(input.sessionID)
    if (!stopOn || input.command !== STOP_COMMAND) return
    const { sessionID } = input
    try {
      writeJsonAtomic(abortPath(deps.worktree, sessionID), { reason: "user_stop", at: Date.now(), arguments: input.arguments })
      const prev = readModeState(deps.worktree, sessionID)
      writeModeState(deps.worktree, sessionID, { ...EMPTY_MODE, stopReason: "user_stop" })
      const queueWasRunning = queue.isRunning(sessionID)
      if (queueWasRunning) {
        // fire-and-forget: a hung abort endpoint must not hang the command hook
        void queue.abort(sessionID, "user_stop").catch((e: unknown) => deps.log("/stop: queue abort failed", { sessionID, error: String(e) }))
      } else {
        // nothing running: settle open tasks of an interrupted run so no resume is offered later
        queue.cancelOpen(sessionID, "user_stop")
      }
      deps.log("/stop", { sessionID, previousMode: prev.mode, wasActive: prev.active, queueWasRunning })
    } catch (e) {
      deps.log("/stop failed", { sessionID, error: (e as Error).message })
    }
  }
}
