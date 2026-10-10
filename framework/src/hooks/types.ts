// Shared dependency bag every hook factory receives. Owned by the scaffold; do not add per-hook state here.
import type { PluginInput } from "@opencode-ai/plugin"
import type { LcaConfig } from "../config.ts"
import type { CoreDeps } from "../deps.ts"

export type HookDeps = CoreDeps & {
  client: PluginInput["client"]
  /** Interactive LCA launcher mode, enabled only after the plugin validates its worktree binding. */
  interactive?: boolean
}

/** Hook ids used with config.disabled_hooks. Keep in sync with src/index.ts. */
export const HOOK_IDS = [
  "config.agents",
  "chat.params",
  "mode.detect",
  "guard.repeat",
  "guard.trim",
  "guard.recover",
  "guard.repetition",
  "guard.wiki_raw",
  "loop.idle",
  "compaction.checkpoint",
  "tool.delegate",
  "command.stop",
  "command.status",
  "flow",
  "guard.plan_boundary",
  "tool.data",
  "tool.history",
  "mcp.evo",
] as const
export type HookId = (typeof HOOK_IDS)[number]

export function enabled(config: LcaConfig, id: HookId): boolean {
  return !config.disabled_hooks.includes(id)
}
