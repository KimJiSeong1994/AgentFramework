// Shared dependency bag every hook factory receives. Owned by the scaffold; do not add per-hook state here.
import type { PluginInput } from "@opencode-ai/plugin"
import type { LcaConfig } from "../config.ts"

export type Logger = (msg: string, extra?: Record<string, unknown>) => void

export type HookDeps = {
  client: PluginInput["client"]
  directory: string
  worktree: string
  config: LcaConfig
  log: Logger
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
  "tool.data",
  "tool.history",
  "mcp.evo",
] as const
export type HookId = (typeof HOOK_IDS)[number]

export function enabled(config: LcaConfig, id: HookId): boolean {
  return !config.disabled_hooks.includes(id)
}
