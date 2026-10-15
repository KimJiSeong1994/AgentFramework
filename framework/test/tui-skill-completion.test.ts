import { describe, expect, test } from "bun:test"
import type { SkillCatalog, SkillCatalogEntry } from "../src/skills/session.ts"
import type { ProtectedWorkflowName } from "../src/skills/types.ts"
import {
  commandCompletions,
  formatSkillCompletionRow,
  skillCompletion,
  skillCompletionInsertion,
  skillCompletionWindow,
} from "../src/tui/skill-completion.ts"

function entry(input: {
  name: string
  description: string
  source: "builtin" | "project" | "home"
  classification: "common" | "custom" | "unavailable"
  refusal?: string
}): SkillCatalogEntry {
  const descriptor = input.source === "builtin"
    ? (() => {
      const workflow = input.name as ProtectedWorkflowName
      return { kind: "protected-workflow" as const, source: "builtin" as const,
        identity: `builtin:${workflow}` as `builtin:${ProtectedWorkflowName}`, name: workflow,
        description: input.description, workflow }
    })()
    : { kind: "skill" as const, source: input.source, identity: `${input.source}:${input.name}`, name: input.name, description: input.description }
  return { descriptor, classification: input.classification, ...(input.refusal === undefined ? {} : { refusal: input.refusal }) }
}

const catalog: SkillCatalog = {
  entries: [
    entry({ name: "review", description: "Review code changes", source: "project", classification: "common" }),
    entry({ name: "release-check", description: "Check deployment readiness", source: "home", classification: "custom" }),
    entry({ name: "hidden", description: "Not available", source: "project", classification: "unavailable", refusal: "unsafe path" }),
    entry({ name: "ralplan", description: "Protected workflow", source: "project", classification: "common" }),
    entry({ name: "deep-interview", description: "Protected built-in workflow", source: "builtin", classification: "common" }),
  ],
  refusals: [{ source: "home", name: "blocked-skill", identities: [], reason: "unsafe-path" }],
}

describe("TUI skill completion", () => {
  test("filters skill names and descriptions case-insensitively", () => {
    expect(skillCompletion(catalog, "/skill:REVIEW")?.rows.map(row => row.name)).toEqual(["review"])
    expect(skillCompletion(catalog, "/skill:deployment")?.rows.map(row => row.name)).toEqual(["release-check"])
    expect(skillCompletion(catalog, "/skill:missing")?.rows).toEqual([])
  })

  test("exposes source, classification, description, and refusal labels", () => {
    const rows = skillCompletion(catalog, "/skill:")!.rows
    const custom = rows.find(row => row.name === "release-check")!
    expect(formatSkillCompletionRow(custom)).toEqual([
      "release-check — Check deployment readiness",
      "Source: home · Classification: custom",
    ])

    const unavailable = rows.find(row => row.name === "hidden")!
    expect(formatSkillCompletionRow(unavailable)[1]).toContain("Source: project · Classification: unavailable · Refusal: unsafe path")
    const refusal = rows.find(row => row.name === "blocked-skill")!
    expect(formatSkillCompletionRow(refusal)[1]).toContain("Source: home · Classification: unavailable · Refusal: unsafe-path")
    expect(skillCompletionInsertion(unavailable)).toBeUndefined()
    expect(skillCompletionInsertion(refusal)).toBeUndefined()
  })

  test("keeps protected names non-selectable unless the descriptor is builtin", () => {
    const rows = skillCompletion(catalog, "/skill:")!.rows
    expect(skillCompletionInsertion(rows.find(row => row.name === "ralplan"))).toBeUndefined()
    expect(rows.find(row => row.name === "ralplan")?.refusal).toContain("protected-name")
    expect(skillCompletionInsertion(rows.find(row => row.name === "deep-interview"))).toBe("/skill:deep-interview ")
  })

  test("selection inserts composer text only and never invokes a skill", () => {
    const row = skillCompletion(catalog, "/skill:review")!.rows[0]!
    const unchangedCatalog = structuredClone(catalog)
    expect(skillCompletionInsertion(row)).toBe("/skill:review ")
    expect(catalog).toEqual(unchangedCatalog)
  })

  test("completed skill names and request arguments return Enter to normal submission", () => {
    expect(skillCompletion(catalog, "/skill:review ")).toBeUndefined()
    expect(skillCompletion(catalog, "/skill:review inspect the changes")).toBeUndefined()
    expect(skillCompletion(catalog, "/skill:review\ninspect")).toBeUndefined()
  })

  test("bounds the candidate viewport while keeping the selected row visible and completes /skills", () => {
    const rows = skillCompletion(catalog, "/skill:")!.rows
    const window = skillCompletionWindow(rows, rows.length - 1, 2)
    expect(window.rows).toHaveLength(2)
    expect(window.start).toBe(rows.length - 2)
    expect(window.rows.at(-1)).toBe(rows.at(-1))
    expect(commandCompletions("/ski")).toContain("/skills")
  })
})
