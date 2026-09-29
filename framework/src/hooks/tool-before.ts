// tool.execute.before: repeat-call blocker + defensive `task` block for non-main agents.
// Throwing here reaches the model: OpenCode wraps the hook inside the AI-SDK tool execute (session/tools.ts), the
// AI SDK turns the rejection into `tool-error`, the processor stores ToolStateError.error and message-v2 sends it
// to the model as `errorText`. tool.execute.after is NOT called for a thrown call.
import type { Hooks } from "@opencode-ai/plugin"
import { enabled, type HookDeps } from "./types.ts"
import { readJson, sessionInfoPath, type SessionInfo } from "../state/store.ts"
import { getGuards } from "../guards/registry.ts"
import { repeatBlockMessage } from "../guards/repeat.ts"

export const MAIN_AGENT = "main"

export function createToolBeforeHook(deps: HookDeps): NonNullable<Hooks["tool.execute.before"]> {
  const guards = getGuards(deps)
  const repeatOn = enabled(deps.config, "guard.repeat")

  return async (input, output) => {
    if (input.tool === "task") {
      const info = readJson<SessionInfo | null>(sessionInfoPath(deps.worktree, input.sessionID), null)
      const agent = info?.agent
      if (agent && agent !== MAIN_AGENT) {
        deps.log("blocked task from non-main agent", { sessionID: input.sessionID, agent })
        throw new Error(`lca: the task tool is only available to the ${MAIN_AGENT} agent (current agent: ${agent}). Do the work directly.`)
      }
    }

    if (!repeatOn) return
    const res = guards.repeat.check(input.sessionID, input.tool, output.args, input.callID)
    if (res.blocked) {
      deps.log("blocked repeated call", { sessionID: input.sessionID, tool: input.tool, count: res.count })
      throw new Error(repeatBlockMessage(input.tool, res.count, res.lastError))
    }
  }
}
