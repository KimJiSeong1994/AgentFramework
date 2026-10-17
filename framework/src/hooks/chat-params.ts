// `chat.params` hook: per-agent output caps and reasoning setting.
//
// Contract (report section 3): the static prefix and the thinking toggle are fixed at session
// start and never change mid-session. This hook therefore only applies values that are constant
// for a given (agent, model) pair for the whole session; nothing here depends on mode or turn.
// Temperature is NOT touched here: it comes from the agent config (see hooks/config.ts).
import type { Hooks } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk"
import type { HookDeps } from "./types.ts"
import { assertModelSelectionMatches, effectiveOutputLimit } from "../config.ts"
import { getOpenCodeRuntime, policyForOpenCodeSession } from "../hosts/opencode-runtime.ts"
import { EXECUTION_ROLES, isWorkflowReadOnlyRole, type ExecutionRole } from "../hosts/types.ts"
import { getOwnedSession } from "../sessions/store.ts"

function isRole(agent: string): agent is ExecutionRole {
  return (EXECUTION_ROLES as readonly string[]).includes(agent)
}

/** True when the model is served by Ollama or an Ollama-backed OpenAI-compatible provider (any model: Ollama maps
 * `reasoning_effort: none` to its `think` switch for every thinking model, and ignores it otherwise — stage 5: the
 * Gemma-only check left qwen3.6 thinking in every child session, 12 reasoning parts in the ulw3 run). */
export function isOnOllama(model: Model, providerID: string): boolean {
  const hay = [providerID, model.providerID, model.api?.npm, model.api?.url]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase())
  return hay.some((s) => s.includes("ollama") || s.includes(":11434"))
}

/** @deprecated stage-5: thinking is switched off for every Ollama-served model, not only Gemma */
export function isGemmaOnOllama(model: Model, providerID: string): boolean {
  const ids = [model.id, model.api?.id, model.name].filter(Boolean).map((s) => String(s).toLowerCase())
  return ids.some((s) => s.includes("gemma")) && isOnOllama(model, providerID)
}

export function createChatParamsHook(deps: HookDeps): NonNullable<Hooks["chat.params"]> {
  const policy = getOpenCodeRuntime(deps).policy
  return async (input, output) => {
    const agent = input.agent
    policyForOpenCodeSession(deps, input.sessionID)
    const bound = policy.snapshotForSession(input.sessionID)
    if (!isRole(agent)) {
      if (bound || getOwnedSession(deps.worktree, input.sessionID)) {
        throw new Error("otter: unknown role cannot dispatch in an owned session")
      }
      return
    }
    if (isWorkflowReadOnlyRole(agent) && !bound) {
      throw new Error("otter: workflow roles require a code-owned execution binding")
    }
    const snapshot = bound ?? policy.resolve(agent)
    if (snapshot.role !== agent) throw new Error(`Session ${input.sessionID} has a ${snapshot.role} policy but OpenCode selected ${agent}`)
    const providerID = input.provider?.info?.id ?? input.model.providerID
    if (input.model.providerID !== providerID) {
      throw new Error(`Conflicting provider IDs: provider=${providerID}, model=${input.model.providerID}`)
    }
    if (snapshot.model) assertModelSelectionMatches(snapshot.model, providerID, input.model.id)
    output.maxOutputTokens = effectiveOutputLimit(snapshot.maxOutputTokens, output.maxOutputTokens, input.model.limit?.output)

    // Thinking stays as the session's model config set it for main. Workers and reviewers run
    // with reasoning off (fixed for their whole session, never toggled), only where we know the
    // option is understood: models served by Ollama (Gemma, qwen3.6, …).
    // `output.options` becomes the AI-SDK providerOptions (session/llm.ts -> ProviderTransform.providerOptions),
    // so the key is the AI-SDK camelCase `reasoningEffort` (the SDK serialises it to `reasoning_effort`); the same
    // key the user config's model `options` uses. A snake_case key here is silently ignored — stage-2 e2e on
    // 2026-09-22 showed reasoning parts in every worker/reviewer session and a reviewer hitting the 2048 output cap
    // while still thinking.
    if (agent === "main") return
    if (input.model.capabilities.reasoning && (
      snapshot.thinking === "disabled"
      || (snapshot.thinking === "inherit" && isOnOllama(input.model, providerID))
    )) {
      output.options = { ...output.options, reasoningEffort: "none" }
    }
  }
}
