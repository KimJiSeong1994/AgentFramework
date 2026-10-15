import { describe, expect, test } from "bun:test"
import fixtureSet from "./fixtures/gjc-keys-8cd17c0.json"
import { displayAnsiWidth, displayWidth, renderFrame, wrapAnsiText, wrapText } from "../src/tui/render.ts"

interface ReferenceFixture {
  id: string
  events?: Array<{ utf8: string }>
  expected?: {
    visibleWidthOfFirstGrapheme?: number
    wrappedLines?: string[]
    lineWidths?: number[]
    lineCount?: number
    firstAndSecondLineStartWith?: string
    secondLineContains?: string
  }
}

const referenceFixtures = (fixtureSet as unknown as { fixtures: ReferenceFixture[] }).fixtures

function fixture(id: string): ReferenceFixture {
  const found = referenceFixtures.find(candidate => candidate.id === id)
  if (!found) throw new Error(`Missing reference fixture: ${id}`)
  return found
}

const stripCsi = (value: string): string => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
const finalCursor = (value: string): [number, number] => {
  const match = value.match(/\u001b\[(\d+);(\d+)H$/)
  if (!match) throw new Error("frame has no final cursor position")
  return [Number(match[1]), Number(match[2])]
}

const basicFrame = (overrides: Partial<Parameters<typeof renderFrame>[0]> = {}) => renderFrame({
  columns: 80,
  rows: 24,
  transcript: ["transcript row"],
  status: "ready",
  draft: "ok",
  cursor: 2,
  ...overrides,
})

describe("TUI renderer text primitives", () => {
  test("uses the pinned terminal widths for Hangul, CJK, emoji, and combining text", () => {
    expect(displayWidth("한글")).toBe(4)
    expect(displayWidth("한")).toBe(2)
    expect(displayWidth("中文")).toBe(4)
    expect(displayWidth("👩‍💻")).toBe(2)
    expect(displayWidth("é")).toBe(1)
  })

  test("wraps at grapheme boundaries and preserves explicit blank lines", () => {
    expect(wrapText("ab cd", 4)).toEqual(["ab", "cd"])
    expect(wrapText("👩‍💻a", 2)).toEqual(["👩‍💻", "a"])
    expect(wrapText("a\n\nb", 80)).toEqual(["a", "", "b"])
  })

  test("matches the pinned combining-tone wrap boundary", () => {
    const pinned = fixture("width.combining-hangul-tone-mark-wrap-boundary")
    const text = pinned.events?.[0]?.utf8
    const expected = pinned.expected
    if (!text || !expected?.wrappedLines || !expected.lineWidths || expected.visibleWidthOfFirstGrapheme === undefined) {
      throw new Error("Incomplete tone-mark fixture")
    }

    expect(displayWidth("가〮")).toBe(expected.visibleWidthOfFirstGrapheme)
    expect(wrapAnsiText(text, 2)).toEqual(expected.wrappedLines)
    expect(wrapAnsiText(text, 2).map(displayAnsiWidth)).toEqual(expected.lineWidths)
  })

  test("measures and wraps pinned truecolor SGR without losing active color on continuation", () => {
    const pinned = fixture("width.ansi-color-preserved-across-wrap")
    const text = pinned.events?.[0]?.utf8
    const expected = pinned.expected
    if (!text || !expected?.lineCount || !expected.firstAndSecondLineStartWith || !expected.secondLineContains) {
      throw new Error("Incomplete ANSI wrapping fixture")
    }

    const lines = wrapAnsiText(text, 5)
    expect(displayAnsiWidth(text)).toBe(11)
    expect(lines).toHaveLength(expected.lineCount)
    expect(lines[0]?.startsWith(expected.firstAndSecondLineStartWith)).toBe(true)
    expect(lines[1]?.startsWith(expected.firstAndSecondLineStartWith)).toBe(true)
    expect(lines[1]).toContain(expected.secondLineContains)
    expect(lines.map(displayAnsiWidth)).toEqual([5, 5])
    expect(stripCsi(lines.join("\n"))).toBe("hello\nworld")
  })
})

describe("renderFrame", () => {
  test("redraws every row at 80x24 and positions the cursor after the draft", () => {
    const frame = basicFrame()
    expect((frame.match(/\u001b\[\d+;1H\u001b\[2K/g) ?? [])).toHaveLength(24)
    expect(finalCursor(frame)).toEqual([24, 5])
    expect(stripCsi(frame)).toContain("transcript row")
    expect(stripCsi(frame)).toContain("ready")
  })

  test("shows a bounded resize notice below minimum without changing the model", () => {
    const input = Object.freeze({
      columns: 79,
      rows: 24,
      transcript: Object.freeze(["private transcript"]),
      status: "private status",
      draft: "private draft",
      cursor: 7,
    })
    const before = structuredClone(input)
    const frame = renderFrame(input)
    const plain = stripCsi(frame)
    expect(plain).toContain("Terminal too small")
    expect(plain).not.toContain("private")
    expect(input).toEqual(before)
    expect(finalCursor(frame)).toEqual([1, 1])

    const shortFrame = renderFrame({ ...input, columns: 80, rows: 23 })
    expect(stripCsi(shortFrame)).toContain("Terminal too small")
    expect(finalCursor(shortFrame)).toEqual([1, 1])
  })

  test("is pure across resize and retains the transcript in the restored frame", () => {
    const state = Object.freeze({
      rows: 24,
      transcript: Object.freeze(["kept transcript"]),
      status: "ready",
      draft: "still here",
      cursor: 10,
    })
    const small = renderFrame({ ...state, columns: 79 })
    const restored = renderFrame({ ...state, columns: 80 })
    expect(stripCsi(small)).toContain("Terminal too small")
    expect(stripCsi(restored)).toContain("kept transcript")
    expect(stripCsi(restored)).toContain("still here")
    expect(state).toEqual({
      rows: 24,
      transcript: ["kept transcript"],
      status: "ready",
      draft: "still here",
      cursor: 10,
    })
  })

  test("scrolls within one paragraph by wrapped visual rows", () => {
    const paragraph = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index).repeat(80)).join("")
    const rows = (frame: string) => [...frame.matchAll(/\u001b\[\d+;1H\u001b\[2K([^\u001b]*)/g)].map(match => match[1]!)
    const frame = (transcriptOffset?: number) => renderFrame({
      columns: 80,
      rows: 24,
      transcript: [paragraph],
      ...(transcriptOffset === undefined ? {} : { transcriptOffset }),
      status: "ready",
      draft: "ok",
      cursor: 2,
    })

    expect(rows(frame())[0]).toBe("E".repeat(80))
    expect(rows(frame(1))[0]).toBe("D".repeat(80))
    expect(rows(frame(Number.MAX_SAFE_INTEGER))[0]).toBe("A".repeat(80))
  })

  test("neutralizes untrusted escapes and controls; optional status color is internal SGR only", () => {
    const frame = basicFrame({
      transcript: ["safe\u001b[2J\u0007\u009b31m \u001b[31minjected\u001b[0m"],
      status: "status\u001b]52;clipboard\u0007",
      draft: "draft\u001b[?25l",
      cursor: 12,
      prompt: "\u001b[?25l",
      notice: "notice\u001b[0m",
      color: false,
    })
    const plain = stripCsi(frame)
    expect(plain).toContain("safe�[2J��31m")
    expect(plain).toContain("�[31minjected�[0m")
    expect(plain).toContain("status�]52;clipboard�")
    expect(plain).toContain("draft�[?25l")
    expect(plain).not.toContain("\u0007")
    expect(plain).not.toContain("\u009b")
    expect(frame).not.toMatch(/\u001b\[[0-9;]*m/)

    const colored = basicFrame({ color: true })
    expect(colored).toContain("\u001b[36mready\u001b[0m")
  })

  test("wraps a full-width cursor onto a valid following row", () => {
    const frame = basicFrame({ draft: "x".repeat(78), cursor: 78 })
    const [row, column] = finalCursor(frame)
    expect(row).toBe(24)
    expect(column).toBe(3)
    expect(column).toBeLessThanOrEqual(80)
  })

  test("uses grapheme display width for cursor placement and scrolls multiline input with it", () => {
    const unicode = basicFrame({ draft: "a👩‍💻é", cursor: 1 })
    expect(finalCursor(unicode)).toEqual([24, 4])

    const draft = "line\n".repeat(20)
    const multiline = renderFrame({
      columns: 80,
      rows: 40,
      transcript: ["transcript survives"],
      status: "ready",
      draft,
      cursor: draft.length,
    })
    const [row, column] = finalCursor(multiline)
    expect(row).toBe(40)
    expect(column).toBe(3)
    expect(stripCsi(multiline)).toContain("transcript survives")
  })
})
