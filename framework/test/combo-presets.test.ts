import { expect, test } from "bun:test"
import { COMBO_PRESETS, comboPresetSummary } from "../src/hosts/combo-presets.ts"
import { validateComboRoutes } from "../src/hosts/default-model.ts"
import { EXECUTION_ROLES } from "../src/hosts/types.ts"

test("recommended combos cover every routable role with supported models", () => {
  expect(new Set(COMBO_PRESETS.map(preset => preset.id)).size).toBe(COMBO_PRESETS.length)
  for (const preset of COMBO_PRESETS) {
    expect(validateComboRoutes(preset.routes)).toEqual(preset.routes)
    expect(Object.keys(preset.routes).sort()).toEqual(EXECUTION_ROLES.filter(role => role !== "main").sort())
    for (const [role, route] of Object.entries(preset.routes)) {
      expect(comboPresetSummary(preset)).toContain(role)
      expect(comboPresetSummary(preset)).toContain(`${route.engine} / ${route.model}`)
    }
  }
})
