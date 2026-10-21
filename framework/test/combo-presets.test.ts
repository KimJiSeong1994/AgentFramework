import { expect, test } from "bun:test"
import { COMBO_PRESETS, comboPresetSummary } from "../src/hosts/combo-presets.ts"
import { createCodexProfile } from "../src/hosts/codex-profile.ts"
import { validateComboRoutes } from "../src/hosts/default-model.ts"
import { EXECUTION_ROLES } from "../src/hosts/types.ts"

test("recommended combos cover every routable role with supported models", () => {
  expect(new Set(COMBO_PRESETS.map(preset => preset.id)).size).toBe(COMBO_PRESETS.length)
  for (const preset of COMBO_PRESETS) {
    expect(validateComboRoutes(preset.routes)).toEqual(preset.routes)
    expect(Object.keys(preset.routes).sort()).toEqual(EXECUTION_ROLES.filter(role => role !== "main").sort())
    // Every Codex model is one Otter's pinned profile admits.
    for (const route of [preset.main, ...Object.values(preset.routes)]) if (route.engine === "codex") expect(() => createCodexProfile(route.model)).not.toThrow()
    expect(comboPresetSummary(preset)).toContain(`main → ${preset.main.engine} / ${preset.main.model}`)
    for (const [role, route] of Object.entries(preset.routes)) {
      expect(comboPresetSummary(preset)).toContain(role)
      expect(comboPresetSummary(preset)).toContain(`${route.engine} / ${route.model}`)
    }
  }
})

test("each preset mixes Codex and Claude with its main, planner, executor, architect and critic", () => {
  const binding = (id: string) => {
    const preset = COMBO_PRESETS.find(candidate => candidate.id === id)!
    const at = (role: string) => { const route = preset.routes[role as keyof typeof preset.routes]!; return `${route.engine}/${route.model}` }
    return { main: `${preset.main.engine}/${preset.main.model}`, planner: at("planner"), executor: at("worker"), architect: at("architect"), critic: at("critic") }
  }
  expect(COMBO_PRESETS.map(preset => preset.id)).toEqual(["astra-fable", "astra-fable-opus", "fable-opus-codex", "opus-codex"])
  expect(binding("astra-fable")).toEqual({ main: "codex/gpt-6-astra", planner: "codex/gpt-6-astra", executor: "codex/gpt-5.6-luna", architect: "claude/fable", critic: "claude/fable" })
  expect(binding("astra-fable-opus")).toEqual({ main: "codex/gpt-6-astra", planner: "claude/opus", executor: "codex/gpt-5.6-luna", architect: "claude/fable", critic: "claude/fable" })
  expect(binding("fable-opus-codex")).toEqual({ main: "claude/fable", planner: "claude/opus", executor: "codex/gpt-5.6-terra", architect: "codex/gpt-5.6-sol", critic: "claude/opus" })
  expect(binding("opus-codex")).toEqual({ main: "claude/opus", planner: "claude/sonnet", executor: "codex/gpt-5.6-terra", architect: "codex/gpt-5.6-sol", critic: "codex/gpt-5.6-sol" })
  for (const preset of COMBO_PRESETS) {
    const engines = new Set([preset.main.engine, ...Object.values(preset.routes).map(route => route.engine)])
    expect([...engines].sort()).toEqual(["claude", "codex"])
    // Roles that judge work follow the critic; execution roles follow the executor; planning roles follow the planner.
    for (const role of ["reviewer", "contrarian", "data-verifier", "answer-judge"] as const) expect(preset.routes[role]).toEqual(preset.routes.critic)
    for (const role of ["simplifier", "data-analyst", "ontology-evolver"] as const) expect(preset.routes[role]).toEqual(preset.routes.worker)
    for (const role of ["interviewer", "researcher"] as const) expect(preset.routes[role]).toEqual(preset.routes.planner)
  }
})
