// Shared test helpers (reconstructed to the API used by config-hook / chat-params tests: fakeDeps, LogEntry, BASE_CONFIG).
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG, type LcaConfig } from "../src/config.ts"
import type { HookDeps } from "../src/hooks/types.ts"

export type LogEntry = { msg: string; extra?: Record<string, unknown> }

export const BASE_CONFIG: LcaConfig = DEFAULT_CONFIG

function mergeConfig(overrides: Partial<LcaConfig>): LcaConfig {
  return {
    ...BASE_CONFIG,
    ...overrides,
    budget: { ...BASE_CONFIG.budget, ...(overrides.budget ?? {}) },
    guards: { ...BASE_CONFIG.guards, ...(overrides.guards ?? {}) },
    loop: { ...BASE_CONFIG.loop, ...(overrides.loop ?? {}) },
    models: { ...BASE_CONFIG.models, ...(overrides.models ?? {}) },
    max_output: { ...BASE_CONFIG.max_output, ...(overrides.max_output ?? {}) },
    delegate: { ...BASE_CONFIG.delegate, ...(overrides.delegate ?? {}) },
    data: { ...BASE_CONFIG.data, ...(overrides.data ?? {}), evo: { ...BASE_CONFIG.data.evo, ...((overrides.data as any)?.evo ?? {}) } },
  }
}

/** Deps bag with a stub client; `logs` (if given) collects every log call. */
export function fakeDeps(worktree: string, overrides: Partial<LcaConfig> = {}, logs?: LogEntry[]): HookDeps {
  process.env.LCA_STATE_HOME ??= join(tmpdir(), "lca-state-fakedeps")
  return {
    client: {} as HookDeps["client"],
    directory: worktree,
    worktree,
    config: mergeConfig(overrides),
    log: (msg, extra) => {
      logs?.push({ msg, extra })
    },
  }
}
