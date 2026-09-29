import { describe, expect, test } from "bun:test"
import { recoveryHint, appendHint, HINT_PREFIX, HINT_MAX_CHARS } from "../src/guards/recover.ts"

describe("recoveryHint", () => {
  test("write: file already exists", () => {
    expect(recoveryHint("write", {}, "Error: File already exists: /x/a.ts")).toContain("edit tool with oldString/newString")
  })
  test("edit: oldString not found / could not find", () => {
    expect(recoveryHint("edit", {}, "Error: oldString not found in content")).toContain("copy the exact text")
    expect(recoveryHint("edit", {}, "Could not find the string to replace")).toContain("oldString must be unique")
  })
  test("edit: multiple matches", () => {
    expect(recoveryHint("edit", {}, "Error: Found multiple matches for oldString")).toContain("more than once")
  })
  test("bash: command not found", () => {
    expect(recoveryHint("bash", {}, "zsh: command not found: foo")).toBe("Check the tool exists with `which`; do not retry the same command.")
  })
  test("any tool: JSON parse error", () => {
    expect(recoveryHint("todowrite", {}, "SyntaxError: JSON parse error: Unexpected token")).toContain("not valid JSON")
    expect(recoveryHint("grep", {}, "Unexpected token } in JSON at position 3")).toContain("not valid JSON")
  })
  test("patterns are tool-scoped", () => {
    expect(recoveryHint("bash", {}, "File already exists")).toBeNull()
    expect(recoveryHint("write", {}, "command not found")).toBeNull()
  })
  test("returns null for normal output and empty output", () => {
    expect(recoveryHint("read", {}, "00001| hello")).toBeNull()
    expect(recoveryHint("bash", {}, "")).toBeNull()
  })
  test("hints are ≤ 200 chars and appended with the marker", () => {
    const h = recoveryHint("write", {}, "File already exists")!
    expect(h.length).toBeLessThanOrEqual(HINT_MAX_CHARS)
    expect(appendHint("out", h)).toBe(`out${HINT_PREFIX}${h}`)
    expect(HINT_PREFIX).toBe("\n\n[lca hint] ")
  })
})
