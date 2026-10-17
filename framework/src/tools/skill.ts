import { tool } from "@opencode-ai/plugin/tool"
import { realpathSync } from "node:fs"
import type { HookDeps } from "../hooks/types.ts"
import { currentOpenCodeToolCall } from "../hosts/opencode-tool-call.ts"
import { loadOpenCodeSkill, OpenCodeSkillRefused } from "../skills/opencode.ts"

/** Fixed schema/description: unchecked discovery metadata never enters the native tool definition. */
export function createSkillTool(deps: HookDeps) {
  return tool({
    description: "Load one registered Otter skill by name. Source, role, and current-session authorization are checked by the runtime.",
    args: { name: tool.schema.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u).describe("The explicitly requested ordinary skill name.") },
    async execute(args, context) {
      const callID = (context as { callID?: unknown }).callID
      if (typeof callID !== "string" || !callID) throw new OpenCodeSkillRefused()
      const input = {
        sessionID: context.sessionID, assistantMessageID: context.messageID, callID, tool: "skill",
      }
      try {
        const call = currentOpenCodeToolCall(deps, input)
        if (!call || context.agent !== call.role || !(context.abort instanceof AbortSignal) ||
            realpathSync.native(context.directory) !== realpathSync.native(deps.directory) ||
            realpathSync.native(context.worktree) !== realpathSync.native(deps.worktree)) throw new OpenCodeSkillRefused()
      } catch { throw new OpenCodeSkillRefused() }
      return loadOpenCodeSkill(deps, input, args, context.abort)
    },
  })
}
