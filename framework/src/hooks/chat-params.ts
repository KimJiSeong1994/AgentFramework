// `chat.params` hook: per-agent output caps and reasoning setting.
//
// Contract (report section 3): the static prefix and the thinking toggle are fixed at session
// start and never change mid-session. This hook therefore only applies values that are constant
// for a given (agent, model) pair for the whole session; nothing here depends on mode or turn.
// Temperature is NOT touched here: it comes from the agent config (see hooks/config.ts).
import type { Hooks } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk"
import type { HookDeps } from "./types.ts"

type Role = "main" | "worker" | "reviewer" | "data-analyst" | "data-verifier" | "ontology-evolver" | "answer-judge"
const ROLES: ReadonlySet<string> = new Set<Role>(["main", "worker", "reviewer", "data-analyst", "data-verifier", "ontology-evolver", "answer-judge"])

function isRole(agent: string): agent is Role {
  return ROLES.has(agent)
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
  return async (input, output) => {
    const agent = input.agent
    if (!isRole(agent)) return // not an lca agent: leave OpenCode defaults alone

    const cap = deps.config.max_output[agent] ?? deps.config.max_output.worker
    output.maxOutputTokens = Math.min(output.maxOutputTokens ?? Infinity, cap)

    // Thinking stays as the session's model config set it for main. Workers and reviewers run
    // with reasoning off (fixed for their whole session, never toggled), only where we know the
    // option is understood: models served by Ollama (Gemma, qwen3.6, …).
    // `output.options` becomes the AI-SDK providerOptions (session/llm.ts -> ProviderTransform.providerOptions),
    // so the key is the AI-SDK camelCase `reasoningEffort` (the SDK serialises it to `reasoning_effort`); the same
    // key the user config's model `options` uses. A snake_case key here is silently ignored — stage-2 e2e on
    // 2026-09-22 showed reasoning parts in every worker/reviewer session and a reviewer hitting the 2048 output cap
    // while still thinking.
    if (agent === "main") return
    const providerID = input.provider?.info?.id ?? input.model.providerID
    if (isOnOllama(input.model, providerID)) {
      output.options = { ...output.options, reasoningEffort: "none" }
    }
  }
}
