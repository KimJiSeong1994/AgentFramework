import { describe, expect, test } from "bun:test"
import { commandInsertions, interactiveActions, interactiveHelp } from "../src/hosts/interactive-actions.ts"
import { commandCompletions } from "../src/tui/skill-completion.ts"

describe("shared interactive actions", () => {
  test("completion derives from the shared command descriptors", () => {
    expect(commandCompletions("/se")).toEqual(commandInsertions("/se"))
    expect(commandCompletions("/se")).toEqual(["/sessions", "/search"])
  })

  test("contextual help does not promise work Resume in read-only history", () => {
    const readOnly = interactiveActions("read-only")
    expect(readOnly.some(action => action.id === "continue")).toBe(false)
    expect(interactiveHelp("read-only")).toContain("/resume <sid>")
    expect(interactiveHelp("read-only")).toContain("(local)")
  })
})
