import { describe, expect, test } from "bun:test"
import { RepeatGuard, canonicalJson, repeatBlockMessage, errorExcerpt } from "../src/guards/repeat.ts"

describe("RepeatGuard", () => {
  test("allows `limit` identical calls then blocks the next one", () => {
    const g = new RepeatGuard(2)
    expect(g.check("s", "write", { filePath: "a.ts", content: "x" }, "c1").blocked).toBe(false)
    expect(g.check("s", "write", { filePath: "a.ts", content: "x" }, "c2").blocked).toBe(false)
    const third = g.check("s", "write", { filePath: "a.ts", content: "x" }, "c3")
    expect(third.blocked).toBe(true)
    expect(third.count).toBe(3)
  })

  test("argument key order does not change the signature", () => {
    const g = new RepeatGuard(1)
    g.check("s", "edit", { a: 1, b: { c: 2, d: [1, 2] } }, "c1")
    expect(g.check("s", "edit", { b: { d: [1, 2], c: 2 }, a: 1 }, "c2").blocked).toBe(true)
    expect(canonicalJson({ b: 1, a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}],"b":1}')
  })

  test("different args or tools are independent; sessions are isolated", () => {
    const g = new RepeatGuard(1)
    g.check("s", "read", { filePath: "a" }, "c1")
    expect(g.check("s", "read", { filePath: "b" }, "c2").blocked).toBe(false)
    expect(g.check("s", "glob", { filePath: "a" }, "c3").blocked).toBe(false)
    expect(g.check("other", "read", { filePath: "a" }, "c4").blocked).toBe(false)
  })

  test("a success resets the counter; failures keep the last error for the message", () => {
    const g = new RepeatGuard(2)
    g.check("s", "write", { f: 1 }, "c1")
    g.recordResult("s", "c1", false, "Error: File already exists: /tmp/a.ts")
    g.check("s", "write", { f: 1 }, "c2")
    g.recordResult("s", "c2", true)
    expect(g.countOf("s", "write", { f: 1 })).toBe(0)
    expect(g.check("s", "write", { f: 1 }, "c3").blocked).toBe(false)
    g.recordResult("s", "c3", false, "Error: File already exists: /tmp/a.ts")
    g.check("s", "write", { f: 1 }, "c4")
    const blocked = g.check("s", "write", { f: 1 }, "c5")
    expect(blocked.blocked).toBe(true)
    expect(blocked.lastError).toContain("File already exists")
    const msg = repeatBlockMessage("write", blocked.count, blocked.lastError)
    expect(msg).toContain("lca: blocked repeated call to write with identical arguments (3x)")
    expect(msg).toContain("The previous attempts failed with: Error: File already exists")
    expect(msg).toContain("Change the approach")
  })

  test("our own block message never overwrites the real error excerpt", () => {
    const g = new RepeatGuard(1)
    g.check("s", "bash", { command: "foo" }, "c1")
    g.recordResult("s", "c1", false, "bash: foo: command not found")
    const b = g.check("s", "bash", { command: "foo" }, "c2")
    expect(b.blocked).toBe(true)
    g.recordResult("s", "c2", false, repeatBlockMessage("bash", 2, b.lastError))
    expect(g.check("s", "bash", { command: "foo" }, "c3").lastError).toBe("bash: foo: command not found")
  })

  test("memory is bounded to the last 50 signatures per session", () => {
    const g = new RepeatGuard(1)
    for (let i = 0; i < 60; i++) g.check("s", "read", { i }, `c${i}`)
    expect(g.countOf("s", "read", { i: 0 })).toBe(0)
    expect(g.countOf("s", "read", { i: 59 })).toBe(1)
    // the evicted signature starts over instead of being blocked
    expect(g.check("s", "read", { i: 0 }, "again").blocked).toBe(false)
  })

  test("recordResult with an unknown callID is a no-op", () => {
    const g = new RepeatGuard(1)
    expect(() => g.recordResult("s", "nope", false, "x")).not.toThrow()
  })

  test("errorExcerpt collapses whitespace and caps length", () => {
    expect(errorExcerpt("  a \n  b  ")).toBe("a b")
    expect(errorExcerpt("x".repeat(500))!.length).toBe(240)
    expect(errorExcerpt("")).toBeUndefined()
  })
})
