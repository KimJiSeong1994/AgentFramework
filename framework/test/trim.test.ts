import { describe, expect, test } from "bun:test"
import { estimateTokens } from "../src/tokens.ts"
import { trimToolOutput, trimMarker, TRIM_TOOLS } from "../src/guards/trim.ts"

const cfg = { read_max_lines: 10, read_max_bytes: 100_000 }
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")

describe("trimToolOutput", () => {
  test("leaves short output untouched", () => {
    const r = trimToolOutput("bash", lines(5), cfg)
    expect(r.trimmed).toBe(false)
    expect(r.output).toBe(lines(5))
    expect(r.originalLines).toBe(5)
  })

  test("does not touch edit/write results even when long", () => {
    for (const tool of ["edit", "write", "todowrite"]) {
      const r = trimToolOutput(tool, lines(500), cfg)
      expect(r.trimmed).toBe(false)
      expect(r.output).toBe(lines(500))
    }
    expect(TRIM_TOOLS.has("edit")).toBe(false)
  })

  test("read keeps only the first read_max_lines lines plus a marker", () => {
    const r = trimToolOutput("read", lines(30), cfg)
    expect(r.trimmed).toBe(true)
    const out = r.output.split("\n")
    expect(out.slice(0, 10)).toEqual(lines(10).split("\n"))
    expect(out[10]).toMatch(/^\[otter: trimmed 20 lines \/ \d+ bytes — re-read with offset\/limit if needed\]$/)
    expect(out.length).toBe(11)
  })

  test("bash/grep/glob/list/webfetch keep head 70% + tail 30% around the marker", () => {
    for (const tool of ["bash", "grep", "glob", "list", "webfetch"]) {
      const r = trimToolOutput(tool, lines(100), cfg)
      expect(r.trimmed).toBe(true)
      const out = r.output.split("\n")
      expect(out.slice(0, 7)).toEqual(lines(7).split("\n"))
      expect(out[7]).toBe(trimMarker(90, r.originalBytes - Buffer.byteLength(out.filter((_, i) => i !== 7).join("\n"))))
      expect(out.slice(8)).toEqual(["line 98", "line 99", "line 100"])
    }
  })

  test("byte cap applies even when line count is fine", () => {
    const big = Array.from({ length: 5 }, (_, i) => `${i}:` + "x".repeat(1000)).join("\n")
    const r = trimToolOutput("bash", big, { read_max_lines: 100, read_max_bytes: 2500 })
    expect(r.trimmed).toBe(true)
    expect(Buffer.byteLength(r.output)).toBeLessThan(2500 + 120)
    expect(r.output).toContain("[otter: trimmed")
    expect(r.output.startsWith("0:xxx")).toBe(true)
  })

  test("byte cap on read cuts a single oversized line without corrupting utf-8", () => {
    const r = trimToolOutput("read", "한글".repeat(200), { read_max_lines: 100, read_max_bytes: 50 })
    expect(r.trimmed).toBe(true)
    expect(r.output).not.toContain("�")
    expect(r.output.endsWith("…\n" + trimMarker(0, r.originalBytes - Buffer.byteLength(r.output.split("\n")[0]!)))).toBe(true)
  })

  test("token cap cuts a byte-small but token-heavy path listing", () => {
    const line = "/private/tmp/very/long/absolute/path/segment-" + "x".repeat(60) + "/file.ts"
    const output = Array.from({ length: 130 }, (_, i) => line + i).join("\n") // ~19.5 KB, ~8-10K est. tokens
    const r = trimToolOutput("glob", output, { read_max_lines: 200, read_max_bytes: 20000, read_max_tokens: 2500 })
    expect(r.trimmed).toBe(true)
    expect(r.output).toContain("[otter: trimmed")
    expect(estimateTokens(r.output)).toBeLessThanOrEqual(2500)
  })

  test("token cap leaves small outputs alone", () => {
    const r = trimToolOutput("glob", "a.ts\nb.ts", { read_max_lines: 200, read_max_bytes: 20000, read_max_tokens: 2500 })
    expect(r.trimmed).toBe(false)
  })
})
