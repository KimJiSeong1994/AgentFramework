import { describe, expect, test } from "bun:test"
import type { SkillCatalog, SkillCatalogEntry } from "../src/skills/session.ts"
import type { ProtectedWorkflowName } from "../src/skills/types.ts"
import {
  commandCompletions,
  formatPaletteRow,
  fuzzyScore,
  palette,
  paletteInsertion,
  paletteWindow,
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

describe("TUI command and skill palette", () => {
  test("/ fuzzy-matches skills and commands together, ranked by match quality", () => {
    // GJC example: a typo still finds the skill, and unrelated names are not listed.
    expect(palette(catalog, "/depp")?.rows.map(row => row.label)).toEqual(["skill:deep-interview"])
    // Best match first; looser in-order-letter matches follow it.
    expect(palette(catalog, "/rev")?.rows[0]?.label).toBe("skill:review")
    expect(palette(catalog, "/review")?.rows.map(row => row.label)).toEqual(["skill:review"])
    const re = palette(catalog, "/re")!.rows.map(row => row.label)
    expect(re.slice(0, 3)).toEqual(["/resume", "skill:review", "skill:release-check"])
    expect(palette(catalog, "/mod")?.rows[0]).toMatchObject({ kind: "command", label: "/model", insertion: "/model " })
    expect(palette(catalog, "/zzzz")).toBeUndefined()
    const all = palette(catalog, "/")!.rows
    expect(all.findIndex(row => row.kind === "skill")).toBeGreaterThan(all.findLastIndex(row => row.kind === "command"))
  })

  test("fuzzy score orders prefix, substring, in-order letters and a single typo", () => {
    const prefix = fuzzyScore("deep", "deep-interview")!
    const substring = fuzzyScore("inter", "deep-interview")!
    const letters = fuzzyScore("dpi", "deep-interview")!
    const typo = fuzzyScore("depp", "deep-interview")!
    expect(prefix).toBeLessThan(substring)
    expect(substring).toBeLessThan(letters)
    expect(letters).toBeLessThan(typo)
    expect(fuzzyScore("xq", "deep-interview")).toBeUndefined()
    expect(fuzzyScore("dx", "deep-interview")).toBeUndefined()
  })

  test("/skill lists every skill, not only names containing 'skill'", () => {
    const skills = palette(catalog, "/skill")!.rows.filter(row => row.kind === "skill").map(row => row.name).sort()
    expect(skills).toEqual(["blocked-skill", "deep-interview", "hidden", "ralplan", "release-check", "review"])
    expect(palette(catalog, "/skill")!.rows[0]?.label).toBe("/skills")
    // `/skills` is the command; it does not widen into every skill by loose letters.
    expect(palette(catalog, "/skills")!.rows.map(row => row.label)).toEqual(["/skills"])
  })

  test("before a model is chosen /skill explains why no skills are listed and inserts nothing", () => {
    for (const draft of ["/sk", "/skill", "/skill:", "/skill:rev"]) {
      const row = palette(catalog, draft, "unselected")!.rows.find(item => item.label === "skill:…")!
      expect(row.description).toContain("/model")
      expect(paletteInsertion(row)).toBeUndefined()
    }
    expect(palette(catalog, "/mo", "unselected")!.rows.some(row => row.label === "skill:…")).toBe(false)
  })

  test("skills appear only where they can be invoked; commands follow the context", () => {
    // Before model selection "/rev" offers no skill (the `review` skill is hidden); only commands such as /resume match.
    const unselected = palette(catalog, "/rev", "unselected")
    expect(unselected?.rows.some(row => row.kind === "skill")).toBe(false)
    expect(unselected?.rows.every(row => row.kind === "command")).toBe(true)
    expect(palette(catalog, "/rev", "chat")?.rows.some(row => row.kind === "skill" && row.name === "review")).toBe(true)
    expect(palette(catalog, "/mo", "unselected")?.rows.map(row => row.label)).toEqual(["/model", "/memory"])
    expect(palette(catalog, "/", "read-only")!.rows.some(row => row.kind === "skill")).toBe(false)
  })

  test("/skill: narrows to skills and also matches descriptions case-insensitively", () => {
    expect(palette(catalog, "/skill:REVIEW")?.rows.map(row => row.name)).toEqual(["review"])
    expect(palette(catalog, "/skill:deployment")?.rows.map(row => row.name)).toEqual(["release-check"])
    expect(palette(catalog, "/skill:missing")).toMatchObject({ skillsOnly: true, rows: [] })
  })

  test("rows are one aligned label/description line; unavailable rows show why and cannot insert", () => {
    const rows = palette(catalog, "/skill:")!.rows
    expect(formatPaletteRow(rows.find(row => row.name === "release-check")!, 22)).toBe("skill:release-check     Check deployment readiness")
    const unavailable = rows.find(row => row.name === "hidden")!
    expect(unavailable.description).toBe("unavailable · unsafe path")
    const refusal = rows.find(row => row.name === "blocked-skill")!
    expect(refusal.description).toBe("unavailable · unsafe-path")
    expect(paletteInsertion(unavailable)).toBeUndefined()
    expect(paletteInsertion(refusal)).toBeUndefined()
    expect(formatPaletteRow({ kind: "command", label: "/a-very-long-command-name-here", name: "x", description: "d" }, 10)).toBe("/a-very-l…  d")
  })

  test("a Codex copy of a builtin workflow is not listed beside the builtin", () => {
    const shadowed: SkillCatalog = { ...catalog, refusals: [...catalog.refusals,
      { source: "home", name: "deep-interview", identities: ["home:.codex/skills/deep-interview"], reason: "protected-name" }] }
    const rows = palette(shadowed, "/deep")!.rows
    expect(rows.filter(row => row.name === "deep-interview")).toHaveLength(1)
    expect(paletteInsertion(rows[0])).toBe("/skill:deep-interview ")
  })

  test("keeps protected names non-selectable unless the descriptor is builtin", () => {
    const rows = palette(catalog, "/skill:")!.rows
    expect(paletteInsertion(rows.find(row => row.name === "ralplan"))).toBeUndefined()
    expect(rows.find(row => row.name === "ralplan")?.refusal).toContain("protected-name")
    expect(paletteInsertion(rows.find(row => row.name === "deep-interview"))).toBe("/skill:deep-interview ")
  })

  test("selection inserts composer text only and never invokes a skill", () => {
    const row = palette(catalog, "/review")!.rows[0]!
    const unchangedCatalog = structuredClone(catalog)
    expect(paletteInsertion(row)).toBe("/skill:review ")
    expect(catalog).toEqual(unchangedCatalog)
  })

  test("completed names and request arguments return Enter to normal submission", () => {
    expect(palette(catalog, "/skill:review ")).toBeUndefined()
    expect(palette(catalog, "/skill:review inspect the changes")).toBeUndefined()
    expect(palette(catalog, "/skill:review\ninspect")).toBeUndefined()
    expect(palette(catalog, "/model codex")).toBeUndefined()
  })

  test("bounds the candidate viewport while keeping the selected row visible and completes /skills", () => {
    const rows = palette(catalog, "/skill:")!.rows
    const window = paletteWindow(rows, rows.length - 1, 2)
    expect(window.rows).toHaveLength(2)
    expect(window.start).toBe(rows.length - 2)
    expect(window.rows.at(-1)).toBe(rows.at(-1))
    expect(commandCompletions("/ski")).toContain("/skills")
  })
})
