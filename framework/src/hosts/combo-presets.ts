import { EXECUTION_ROLES, type ComboRoute, type ComboRoutes } from "./types.ts"

export type ComboPreset = {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly routes: ComboRoutes
}

const astra: ComboRoute = Object.freeze({ engine: "codex", model: "gpt-6-astra" })
const luna: ComboRoute = Object.freeze({ engine: "codex", model: "gpt-6-luna" })
const sol: ComboRoute = Object.freeze({ engine: "codex", model: "gpt-6-sol" })
const terra: ComboRoute = Object.freeze({ engine: "codex", model: "gpt-5.6-terra" })
const fable: ComboRoute = Object.freeze({ engine: "claude", model: "fable" })
const opus: ComboRoute = Object.freeze({ engine: "claude", model: "opus" })
const sonnet: ComboRoute = Object.freeze({ engine: "claude", model: "sonnet" })

/** Complete role maps make switching templates deterministic. The main /model selection stays separate. */
function routes(planner: ComboRoute, worker: ComboRoute, review: ComboRoute): ComboRoutes {
  return Object.freeze(Object.fromEntries(EXECUTION_ROLES.filter(role => role !== "main").map(role => [role,
    ["architect", "critic", "reviewer", "contrarian", "data-verifier", "answer-judge"].includes(role) ? review
      : ["worker", "simplifier", "data-analyst", "ontology-evolver"].includes(role) ? worker : planner,
  ])))
}

/** GJC-inspired templates using Otter's bundled Codex slugs and native Claude aliases. */
export const COMBO_PRESETS: readonly ComboPreset[] = Object.freeze([
  Object.freeze({ id: "astra-fable", label: "Astra + Fable", description: "Astra plans, Luna executes, Fable reviews.", routes: routes(astra, luna, fable) }),
  Object.freeze({ id: "astra-fable-opus", label: "Astra / Fable / Opus", description: "Opus plans, Luna executes, Fable reviews; pairs with an Astra main model.", routes: routes(opus, luna, fable) }),
  Object.freeze({ id: "opus-codex", label: "Opus + Codex", description: "Sonnet plans, Terra executes, Sol reviews; pairs with an Opus main model.", routes: routes(sonnet, terra, sol) }),
])

export function comboPresetSummary(preset: ComboPreset): string {
  const grouped = new Map<string, string[]>()
  for (const [role, route] of Object.entries(preset.routes)) {
    const key = `${route.engine} / ${route.model}`
    grouped.set(key, [...(grouped.get(key) ?? []), role])
  }
  return [...grouped].map(([model, roles]) => `${roles.join(", ")} → ${model}`).join("\n")
}
