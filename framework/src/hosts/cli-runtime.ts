import { realpathSync, statSync } from "node:fs"
import { loadConfig } from "../config.ts"
import { createCliHost } from "./cli-host.ts"
import { createCodexProfile } from "./codex-profile.ts"
import type { CliEngine, CliTransportHandle, CliTransportOptions } from "./cli-transport.ts"
import { createExecutionRuntime } from "./runtime.ts"
import { validateComboRoutes } from "./default-model.ts"
import { CONFIG_MODEL_ROLES, type ComboRoutes, type ExecutionRole, type ExecutionRuntime } from "./types.ts"
import type { CliProgressSink } from "./cli-progress.ts"
import { currentMemoryConfig } from "../wiki/recall.ts"

export type CliRuntimeOptions = { worktree: string; engine: CliEngine; model: string; progress?: CliProgressSink
  /** Per-role routes pinned for this runtime; roles absent (or equal to the anchor) use engine/model. */
  routes?: ComboRoutes
  /** Test-only transport seam; production always uses the real CLI transport. */
  createTransport?: (options: CliTransportOptions) => CliTransportHandle
}

/** The selected model applies to every role except those with a pinned route; vendor credentials remain vendor-owned. */
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
  const validated = options.routes === undefined ? {} : validateComboRoutes(options.routes)
  if (typeof validated === "string") throw new TypeError(validated)
  // A route identical to the anchor is not a route; dropping it keeps the policy ID unchanged.
  const routes = Object.fromEntries(Object.entries(validated)
    .filter(([, route]) => route.engine !== options.engine || route.model !== options.model)) as ComboRoutes
  const routePolicies = Object.fromEntries(Object.entries(routes).map(([role, route]) => {
    const nativeContext = route.engine === "codex"
      ? (() => {
        const profile = createCodexProfile(route.model)
        return { identity: profile.catalogHash, instructions: profile.instructions }
      })()
      : undefined
    return [role, { model: { providerID: route.engine, modelID: route.model }, ...(nativeContext ? { nativeContext } : {}) }]
  })) as Partial<Record<ExecutionRole, { model: { providerID: string; modelID: string }; nativeContext?: { identity: string; instructions: string } }>>
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
    ...(options.progress?.verifyRun ? { verifyRun: run => { try { options.progress?.verifyRun?.(run) } catch { /* display only */ } } } : {}),
  }, ({ policy, runs }) =>
    createCliHost({
      engine: options.engine,
      model: options.model,
      ...(Object.keys(routes).length ? { routes } : {}),
      policy,
      runs,
      loadMemory: () => currentMemoryConfig(worktree),
      ...(options.progress ? { observeActivity: options.progress.host } : {}),
      ...(options.progress?.toolDisplay ? { observeToolDisplay: options.progress.toolDisplay } : {}),
      ...(options.createTransport ? { createTransport: options.createTransport } : {}),
    }), {
      planningOnlyMain: true,
      ...(nativeContext ? { nativeContext } : {}),
      ...(Object.keys(routePolicies).length ? { routes: routePolicies } : {}),
    })
}
