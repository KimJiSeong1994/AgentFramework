import { describe, expect, test } from "bun:test"
import { statusLines } from "../src/tui/status-view.ts"
import { displayWidth } from "../src/tui/render.ts"
import type { InteractiveViewFacts } from "../src/hosts/interactive-view.ts"

const facts: InteractiveViewFacts = {
  identity: { mode: "retained-read-only", sessionID: "s" },
  selection: { engine: "local", model: "길고-정확한-모델-식별자" },
  hold: { state: "known", value: { held: true, reason: "unsettled fence" } },
  workflow: { state: "unknown" }, owner: "foreign", claim: { state: "known", value: true },
  fence: { state: "known", value: true }, termination: "unconfirmed", discovery: "completed",
  request: { state: "cancellation-unconfirmed", operationID: "operation" },
}

describe("priority status layout", () => {
  for (const columns of [80, 81, 100, 120, 200]) test(`keeps safety facts within ${columns} columns`, () => {
    const rows = statusLines({ facts, workflow: "ultragoal · execution · active", activity: "very long ordinary activity detail", search: "tool", queued: 3, columns })
    expect(rows.length).toBeLessThanOrEqual(2)
    expect(rows.every(row => displayWidth(row) <= columns)).toBe(true)
    expect(rows.join(" ")).toContain("termination:?")
    expect(rows.join(" ")).toContain("read-only")
    expect(rows.join(" ")).toContain("claim")
    expect(rows.join(" ")).toContain("fence")
    expect(rows.join(" ")).toContain("owner:foreign")
  })
})
