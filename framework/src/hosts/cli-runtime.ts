import { realpathSync, statSync } from "node:fs"
import { loadConfig } from "../config.ts"
import { createCliHost } from "./cli-host.ts"
import { createCodexProfile } from "./codex-profile.ts"
import type { CliEngine } from "./cli-transport.ts"
import { createExecutionRuntime } from "./runtime.ts"
import { CONFIG_MODEL_ROLES, type ExecutionRuntime } from "./types.ts"
import type { CliProgressSink } from "./cli-progress.ts"

export type CliRuntimeOptions = { worktree: string; engine: CliEngine; model: string; progress?: CliProgressSink }

/** The selected model applies to every role; vendor credentials remain vendor-owned. */
export function createCliRuntime(options: CliRuntimeOptions): ExecutionRuntime {
  if (!["local", "codex", "claude"].includes(options.engine)
    || typeof options.model !== "string" || !options.model || options.model.startsWith("-")
    || /[\s\\\x00-\x1f\x7f]/.test(options.model) || options.model.length > 256) {
    throw new TypeError("invalid CLI engine or model selection")
  }
  const worktree = realpathSync(options.worktree)
  if (!statSync(worktree).isDirectory()) throw new TypeError("invalid CLI worktree")
  const config = structuredClone(loadConfig(worktree))
  config.models = Object.fromEntries(CONFIG_MODEL_ROLES.map(role => [role, `${options.engine}/${options.model}`]))
  const nativeContext = options.engine === "codex"
    ? (() => {
      const profile = createCodexProfile(options.model)
      return { identity: profile.catalogHash, instructions: profile.instructions }
    })()
    : undefined
  return createExecutionRuntime({
    directory: worktree,
    worktree,
    config,
    log(message, safeFields) {
      try { options.progress?.queue(message, safeFields) } catch { /* Progress observers never affect queue behavior. */ }
    },
  }, ({ policy, runs }) =>
    createCliHost({
      engine: options.engine,
      model: options.model,
      policy,
      runs,
      ...(options.progress ? { observeActivity: options.progress.host } : {}),
    }), {
      planningOnlyMain: true,
      ...(nativeContext ? { nativeContext } : {}),
    })
}
