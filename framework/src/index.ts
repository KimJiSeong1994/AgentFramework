// lca — local-first coding agent framework for OpenCode. Stage 1 core + stage 2 (ledger, delegate, /stop).
// Assembly: loadConfig -> deps -> hook factories -> Hooks. Each factory may return undefined when disabled.
import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { taskWorktreeOwner } from "./orchestration/worktree.ts"
import { loadConfig } from "./config.ts"
import { enabled, type HookDeps } from "./hooks/types.ts"
// Factories are filled in by the team; each file exports create<Name>Hook(deps).
import { createConfigHook } from "./hooks/config.ts"
import { createChatParamsHook } from "./hooks/chat-params.ts"
import { createChatMessageHook } from "./hooks/chat-message.ts"
import { createToolBeforeHook } from "./hooks/tool-before.ts"
import { createToolAfterHook } from "./hooks/tool-after.ts"
import { createEventHook } from "./hooks/event.ts"
import { admissionEpoch, effectiveHold, isAdmissionCurrent } from "./sessions/admission.ts"
export { admissionEpoch, isAdmissionCurrent }
import { createCompactingHook } from "./hooks/compacting.ts"
import { APPROVE_COMMAND, APPROVE_TEMPLATE, createCommandHook } from "./hooks/command.ts"
import { createDelegateTool } from "./tools/delegate.ts"
import { createDbQueryTool } from "./tools/db-query.ts"
import { createSchemaLookupTool } from "./tools/schema-lookup.ts"
import { createLcaFlowTool } from "./tools/lca-flow.ts"
import { createSkillTool } from "./tools/skill.ts"
import { flowOn } from "./flow/status.ts"
import { repairOnLoad } from "./flow/runtime.ts"
import { getQueue } from "./orchestration/queue.ts"
import { getOpenCodeRuntime } from "./hosts/opencode-runtime.ts"
import {
  assertOpenCodeSystemHeaders, assertOpenCodeSystemMessages, assertOpenCodeSystemParams,
  createOpenCodeSystemTransformHook,
} from "./hosts/opencode-system.ts"
import { initializeSkillObservation } from "./telemetry/skill-observer.ts"
import { activeWorkflow, workflowEngineRefusal } from "./flow/state.ts"

function interactiveForWorktree(worktree: string): boolean {
  const requested = process.env.LCA_INTERACTIVE_WORKTREE
  if (requested === undefined) return false
  if (!requested.trim()) throw new Error("lca interactive startup refused: LCA_INTERACTIVE_WORKTREE is empty")

  let requestedRoot: string
  let actualRoot: string
  try {
    requestedRoot = realpathSync.native(resolve(requested))
    actualRoot = realpathSync.native(resolve(worktree))
  } catch (e) {
    throw new Error(`lca interactive startup refused: cannot canonicalize the bound worktree: ${(e as Error).message}`)
  }
  if (requestedRoot !== actualRoot) {
    let owner: ReturnType<typeof taskWorktreeOwner>
    try {
      owner = taskWorktreeOwner(actualRoot)
    } catch (e) {
      throw new Error(`lca interactive startup refused: cannot authenticate managed task worktree (${(e as Error).message})`)
    }
    if (!owner || owner.mainWorktree !== requestedRoot) {
      throw new Error(`lca interactive startup refused: LCA_INTERACTIVE_WORKTREE does not match this plugin worktree (${actualRoot})`)
    }
  }
  return true
}

function requireInteractiveConfig(config: HookDeps["config"]): void {
  const required = ["config.agents", "chat.params", "tool.delegate", "guard.plan_boundary", "flow"] as const
  const disabled: string[] = required.filter((id) => !enabled(config, id))
  if (!config.flow.enabled) disabled.push("flow.enabled")
  if (disabled.length) {
    throw new Error(`lca interactive startup refused: required hooks/config disabled: ${disabled.join(", ")}`)
  }
}

export const LcaPlugin: Plugin = async (input) => {
  const interactive = interactiveForWorktree(input.worktree)
  const config = loadConfig(input.worktree)
  if (interactive) requireInteractiveConfig(config)
  const log = (msg: string, extra?: Record<string, unknown>) => {
    if (process.env.LCA_DEBUG) console.error(`[lca] ${msg}`, extra ?? "")
  }
  const deps: HookDeps = { client: input.client, directory: input.directory, worktree: input.worktree, config, log, interactive: interactive || undefined }
  initializeSkillObservation(deps)

  // repairOnLoad is authority-free (ARCH-14) and must never break plugin startup.
  try {
    const runtime = getOpenCodeRuntime(deps)
    const workflow = activeWorkflow(deps.worktree)
    const refusal = workflow && workflowEngineRefusal(workflow, runtime.host.identity.engine)
    if (refusal) log("repairOnLoad skipped: workflow engine identity refused", { reason: refusal })
    else if (workflow && effectiveHold(deps.worktree, workflow.sessionID)) {
      // Held: only stop-event safety settlement of a recorded intent; never ordinary repair.
      log("repairOnLoad: session admission is held; stop safety settlement only", { sessionID: workflow.sessionID })
      repairOnLoad(runtime, runtime.host.identity.engine, (sessionID) => getQueue(runtime).isRunning(sessionID))
    }
    else repairOnLoad(runtime, runtime.host.identity.engine, (sessionID) => getQueue(runtime).isRunning(sessionID))
  } catch (e) {
    log("repairOnLoad failed", { error: (e as Error).message })
  }

  const hooks: Hooks = {}
  if (enabled(config, "config.agents")) {
    const configHook = createConfigHook(deps)
    hooks.config = interactive ? async (current) => {
      await configHook(current)
      const approval = (current as { command?: Record<string, { template?: string }> }).command?.[APPROVE_COMMAND]
      if (approval?.template !== APPROVE_TEMPLATE) {
        throw new Error(`lca interactive startup refused: user command "/${APPROVE_COMMAND}" conflicts with the typed approval command`)
      }
    } : configHook
  }
  const paramsHook = enabled(config, "chat.params") ? createChatParamsHook(deps) : undefined
  hooks["chat.params"] = async (input, output) => {
    assertOpenCodeSystemParams(deps, input)
    await paramsHook?.(input, output)
    assertOpenCodeSystemParams(deps, input)
  }
  hooks["chat.headers"] = async input => { assertOpenCodeSystemHeaders(deps, input) }
  hooks["experimental.chat.system.transform"] = createOpenCodeSystemTransformHook(deps)
  hooks["experimental.chat.messages.transform"] = async (_input, output) => {
    assertOpenCodeSystemMessages(deps, output.messages)
  }
  // Session admission and durable history are core; optional mode behavior remains gated inside the hook.
  hooks["chat.message"] = createChatMessageHook(deps)
  hooks["tool.execute.before"] = createToolBeforeHook(deps)
  hooks["tool.execute.after"] = createToolAfterHook(deps)
  hooks.event = createEventHook(deps)
  if (enabled(config, "compaction.checkpoint")) hooks["experimental.session.compacting"] = createCompactingHook(deps)
  hooks.tool = { skill: createSkillTool(deps) }
  if (enabled(config, "tool.delegate")) hooks.tool.delegate = createDelegateTool(deps)
  if (config.data.backend !== "none" && enabled(config, "tool.data")) {
    hooks.tool.db_query = createDbQueryTool(deps)
    hooks.tool.schema_lookup = createSchemaLookupTool(deps)
  }
  if (flowOn(config)) hooks.tool.lca_flow = createLcaFlowTool(deps)
  if (Object.keys(hooks.tool).length === 0) delete hooks.tool
  // Registered for the router too: it marks command turns so their expanded templates are not skill-routed.
  const stopOn = enabled(config, "command.stop")
  const statusOn = flowOn(config) && enabled(config, "command.status")
  const flowCmdsOn = flowOn(config)
  hooks["command.execute.before"] = createCommandHook(deps, { stop: stopOn, status: statusOn, flow: flowCmdsOn })
  return hooks
}

const plugin: PluginModule = { id: "lca", server: LcaPlugin }
export default plugin
