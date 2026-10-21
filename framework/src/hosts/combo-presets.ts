import { EXECUTION_ROLES, type ComboRoute, type ComboRoutes } from "./types.ts"

export type ComboPreset = {
  readonly id: string
  readonly label: string
  readonly description: string
  /** The chat (main) model the template is built around; choosing the preset selects it with the routes. */
  readonly main: ComboRoute
  readonly routes: ComboRoutes
}

const astra: ComboRoute = Object.freeze({ engine: "codex", model: "gpt-6-astra" })
const luna: ComboRoute = Object.freeze({ engine: "codex", model: "gpt-5.6-luna" })
const sol: ComboRoute = Object.freeze({ engine: "codex", model: "gpt-5.6-sol" })
const terra: ComboRoute = Object.freeze({ engine: "codex", model: "gpt-5.6-terra" })
const fable: ComboRoute = Object.freeze({ engine: "claude", model: "fable" })
const opus: ComboRoute = Object.freeze({ engine: "claude", model: "opus" })
const sonnet: ComboRoute = Object.freeze({ engine: "claude", model: "sonnet" })

/** A preset's role bindings (planner, executor, architect, critic) spread over Otter's roles. */
type RoleBindings = { planner: ComboRoute; executor: ComboRoute; architect: ComboRoute; critic: ComboRoute }
const PLANNER_ROLES = ["planner", "interviewer", "researcher"]
const EXECUTOR_ROLES = ["worker", "simplifier", "data-analyst", "ontology-evolver"]
const ARCHITECT_ROLES = ["architect"]
// Critic covers every role that judges or challenges work: review, contrarian, data verification, answer judging.

/** Complete role maps make switching templates deterministic; each preset also names its main model. */
function routes(bindings: RoleBindings): ComboRoutes {
  return Object.freeze(Object.fromEntries(EXECUTION_ROLES.filter(role => role !== "main").map(role => [role,
    PLANNER_ROLES.includes(role) ? bindings.planner
      : EXECUTOR_ROLES.includes(role) ? bindings.executor
        : ARCHITECT_ROLES.includes(role) ? bindings.architect
          : bindings.critic,
  ])))
}

/**
 * Codex × Claude combos: each names the main model and the planner, executor, architect and critic bindings. Codex models
 * are routed by slug, Claude by its CLI alias.
 */
export const COMBO_PRESETS: readonly ComboPreset[] = Object.freeze([
  Object.freeze({ id: "astra-fable", label: "ASTRA + Fable", main: astra,
    description: "Codex Astra chats and plans, Codex Luna executes, Claude Fable designs and reviews.",
    routes: routes({ planner: astra, executor: luna, architect: fable, critic: fable }) }),
  Object.freeze({ id: "astra-fable-opus", label: "ASTRA + Fable + Opus", main: astra,
    description: "Codex Astra chats, Claude Opus plans, Codex Luna executes, Claude Fable designs and reviews.",
    routes: routes({ planner: opus, executor: luna, architect: fable, critic: fable }) }),
  Object.freeze({ id: "fable-opus-codex", label: "Fable + Opus + Codex", main: fable,
    description: "Claude Fable chats, Claude Opus plans and reviews, Codex Terra executes, Codex Sol designs.",
    routes: routes({ planner: opus, executor: terra, architect: sol, critic: opus }) }),
  Object.freeze({ id: "opus-codex", label: "Opus + Codex", main: opus,
    description: "Claude Opus chats, Claude Sonnet plans, Codex Terra executes, Codex Sol designs and reviews.",
    routes: routes({ planner: sonnet, executor: terra, architect: sol, critic: sol }) }),
])

export function comboPresetSummary(preset: ComboPreset): string {
  const grouped = new Map<string, string[]>()
  for (const [role, route] of Object.entries(preset.routes)) {
    const key = `${route.engine} / ${route.model}`
    grouped.set(key, [...(grouped.get(key) ?? []), role])
  }
  return [`main → ${preset.main.engine} / ${preset.main.model}`, ...[...grouped].map(([model, roles]) => `${roles.join(", ")} → ${model}`)].join("\n")
}
