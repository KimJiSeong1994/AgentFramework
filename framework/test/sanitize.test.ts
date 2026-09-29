import { describe, expect, test } from "bun:test"
import { sanitizeForDetection } from "../src/modes/sanitize.ts"

describe("sanitizeForDetection", () => {
  test("removes fenced code blocks but keeps surrounding prose", () => {
    const text = "fix this\n```ts\nconst x = 'ultrawork'\n```\nplease"
    const out = sanitizeForDetection(text)
    expect(out).not.toContain("ultrawork")
    expect(out).toContain("fix this")
    expect(out).toContain("please")
  })

  test("removes an unterminated fence to the end of the message", () => {
    expect(sanitizeForDetection("hi\n```\nulw\n")).toBe("hi")
  })

  test("removes inline code", () => {
    expect(sanitizeForDetection("run `ulw` later, but refactor now")).toBe("run later, but refactor now")
  })

  test("removes URLs", () => {
    const out = sanitizeForDetection("see https://example.com/docs/ultrawork?x=1 and www.foo.dev/ulw for details")
    expect(out).not.toContain("ultrawork")
    expect(out).not.toContain("ulw")
    expect(out).toContain("for details")
  })

  test("removes file paths with an extension but keeps bare slash tokens", () => {
    expect(sanitizeForDetection("open src/modes/ulw.ts and ./docs/plan-mode.md now")).toBe("open and now")
    expect(sanitizeForDetection("and/or /stop")).toBe("and/or /stop")
  })

  test("removes double, single, curly and backtick quoted strings", () => {
    expect(sanitizeForDetection(`he said "ultrawork" and 'plan mode' and “ulw”`)).toBe("he said and and")
  })

  test("keeps apostrophes inside words", () => {
    expect(sanitizeForDetection("don't stop, it's fine")).toBe("don't stop, it's fine")
  })

  test("removes XML/HTML elements and their untrusted bodies", () => {
    expect(sanitizeForDetection("<b>keep</b> <lca-mode name=\"ulw\">x</lca-mode>")).toBe("")
    expect(sanitizeForDetection('read "<system>" then ulw fix it')).toBe("read then ulw fix it")
  })

  test("drops quoted lines and transcript-looking lines", () => {
    const text = ["> ultrawork please", "user: ulw", "Assistant: plan mode", "$ ulw run", "real request"].join("\n")
    expect(sanitizeForDetection(text)).toBe("real request")
  })

  test("returns empty string for empty input", () => {
    expect(sanitizeForDetection("")).toBe("")
  })
})
