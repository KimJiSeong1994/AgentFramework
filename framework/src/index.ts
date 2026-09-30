// lca — local-first coding agent framework for OpenCode. Stage 1 core + stage 2 (ledger, delegate, /stop).
// Assembly: loadConfig -> deps -> hook factories -> Hooks. Each factory may return undefined when disabled.
import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin"
import { loadConfig } from "./config.ts"
import { enabled, type HookDeps } from "./hooks/types.ts"
// Factories are filled in by the team; each file exports create<Name>Hook(deps).
import { createConfigHook } from "./hooks/config.ts"
import { createChatParamsHook } from "./hooks/chat-params.ts"
import { createChatMessageHook } from "./hooks/chat-message.ts"
import { createToolBeforeHook } from "./hooks/tool-before.ts"
import { createToolAfterHook } from "./hooks/tool-after.ts"
import { createEventHook } from "./hooks/event.ts"
import { createCompactingHook } from "./hooks/compacting.ts"
import { createCommandHook } from "./hooks/command.ts"
import { createDelegateTool } from "./tools/delegate.ts"
import { createDbQueryTool } from "./tools/db-query.ts"
import { createSchemaLookupTool } from "./tools/schema-lookup.ts"

export const LcaPlugin: Plugin = async (input) => {
  const config = loadConfig(input.worktree)
  const log = (msg: string, extra?: Record<string, unknown>) => {
    if (process.env.LCA_DEBUG) console.error(`[lca] ${msg}`, extra ?? "")
  }
  const deps: HookDeps = { client: input.client, directory: input.directory, worktree: input.worktree, config, log }

  const hooks: Hooks = {}
  if (enabled(config, "config.agents")) hooks.config = createConfigHook(deps)
  if (enabled(config, "chat.params")) hooks["chat.params"] = createChatParamsHook(deps)
  if (enabled(config, "mode.detect")) hooks["chat.message"] = createChatMessageHook(deps)
  hooks["tool.execute.before"] = createToolBeforeHook(deps)
  hooks["tool.execute.after"] = createToolAfterHook(deps)
  hooks.event = createEventHook(deps)
  if (enabled(config, "compaction.checkpoint")) hooks["experimental.session.compacting"] = createCompactingHook(deps)
  hooks.tool = {}
  if (enabled(config, "tool.delegate")) hooks.tool.delegate = createDelegateTool(deps)
  if (config.data.backend !== "none" && enabled(config, "tool.data")) {
    hooks.tool.db_query = createDbQueryTool(deps)
    hooks.tool.schema_lookup = createSchemaLookupTool(deps)
  }
  if (Object.keys(hooks.tool).length === 0) delete hooks.tool
  // Registered for the router too: it marks command turns so their expanded templates are not skill-routed.
  const stopOn = enabled(config, "command.stop")
  if (stopOn || enabled(config, "mode.detect")) hooks["command.execute.before"] = createCommandHook(deps, { stop: stopOn })
  return hooks
}

const plugin: PluginModule = { id: "lca", server: LcaPlugin }
export default plugin
