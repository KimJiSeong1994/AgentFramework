import { describe, expect, test } from "bun:test"
import { estimateTokens, estimateToolSchemaTokens } from "../src/tokens.ts"

describe("estimateTokens", () => {
  test("empty input is 0", () => {
    expect(estimateTokens("")).toBe(0)
  })

  test("english prose is about 4 chars per token", () => {
    const text = "The quick brown fox jumps over the lazy dog and keeps running through the field"
    const est = estimateTokens(text)
    expect(est).toBeGreaterThanOrEqual(Math.floor(text.length / 4))
    expect(est).toBeLessThanOrEqual(Math.ceil(text.length / 3.5))
  })

  test("hangul is much denser than ascii per character", () => {
    const ko = "빠른 갈색 여우가 게으른 개를 뛰어넘는다"
    const en = "The quick brown fox jumps over the lazy dog"
    const koPerChar = estimateTokens(ko) / ko.length
    const enPerChar = estimateTokens(en) / en.length
    expect(koPerChar).toBeGreaterThan(enPerChar * 2)
    // ~1.3 chars/token for CJK
    expect(estimateTokens("가나다라마바사아자차")).toBeGreaterThanOrEqual(7)
    expect(estimateTokens("가나다라마바사아자차")).toBeLessThanOrEqual(9)
  })

  test("code is denser than prose of the same length", () => {
    const code = `const x = {a: 1, b: [2, 3]}; if (x.a > 0) { return fn(x) } else { throw new Error("no") }`
    const prose = "a".repeat(0) + "we walked along the river until the evening light faded and then we went home slowly".slice(0, code.length)
    expect(estimateTokens(code)).toBeGreaterThan(estimateTokens(prose))
  })

  test("newlines count as one token each", () => {
    expect(estimateTokens("\n\n\n")).toBe(3)
    expect(estimateTokens("a\nb")).toBeGreaterThanOrEqual(2)
  })

  test("is monotone in input length", () => {
    const a = "hello world ".repeat(10)
    expect(estimateTokens(a + a)).toBeGreaterThan(estimateTokens(a))
  })
})

describe("estimateToolSchemaTokens", () => {
  test("includes description, parameters and a fixed overhead", () => {
    const base = estimateToolSchemaTokens("", {})
    expect(base).toBeGreaterThan(0)
    const withDesc = estimateToolSchemaTokens("Read a file from disk and return its content", {})
    expect(withDesc).toBeGreaterThan(base)
    const withParams = estimateToolSchemaTokens("Read a file from disk and return its content", {
      type: "object",
      properties: { path: { type: "string", description: "absolute path" }, limit: { type: "number" } },
      required: ["path"],
    })
    expect(withParams).toBeGreaterThan(withDesc)
  })

  test("survives non-serialisable parameters", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => estimateToolSchemaTokens("x", circular)).not.toThrow()
  })
})
