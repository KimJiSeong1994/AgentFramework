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

  test("idle status prioritizes actionable guidance rather than internal observation labels", () => {
    const idle: InteractiveViewFacts = {
      ...facts,
      identity: { mode: "writable", sessionID: "s", epoch: "epoch" },
      hold: { state: "known", value: { held: false } },
      owner: "current-session",
      claim: { state: "known", value: false },
      fence: { state: "known", value: false },
      termination: "not-observed",
      request: { state: "not-observed" },
    }
    const rows = statusLines({ facts: idle, activity: "Enter send | /help commands | /model switch", queued: 0, columns: 80 })
    expect(rows.join(" ")).toContain("/help commands")
    expect(rows.join(" ")).toContain(idle.selection.model)
    expect(rows.join(" ")).not.toContain("not-observed")
    expect(rows.join(" ")).not.toContain("discovery completed")
    const running = statusLines({ facts: { ...idle, request: { state: "in-progress", operationID: "op" } }, activity: "Waiting", queued: 0, columns: 80 })
    expect(running.join(" ")).toContain("Model request running")
  })

  test("omitted state has a bounded visible cue while safety stays first", () => {
    for (const columns of [1, 20, 80, 120]) {
      const rows = statusLines({
        facts, activity: "a".repeat(200), notice: "n".repeat(200),
        workflow: "Workflow running", queued: 2, columns,
      })
      expect(rows.every(row => displayWidth(row) <= columns)).toBe(true)
      if (columns >= 80) {
        expect(rows[0]).toContain("safety[")
        expect(rows.join(" ")).toMatch(/\+\d+ more/)
      }
    }
  })
})
