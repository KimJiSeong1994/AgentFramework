import { describe, expect, test } from "bun:test"
import fixtureSet from "./fixtures/gjc-keys-8cd17c0.json"
import { displayAnsiWidth, displayWidth, renderFrame, transcriptViewportRows, wrapAnsiText, wrapText, wrapTranscriptLine } from "../src/tui/render.ts"

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
const frameRows = (value: string): string[] => [...value.matchAll(/\u001b\[\d+;1H\u001b\[2K([^\u001b]*)/g)].map(match => match[1]!)
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
    expect(frameRows(frame)[2]).toBe("transcript row")
  })

  test.each([[80, 24], [120, 40]] as const)("anchors header, transcript, status and composer at %ix%i", (columns, rows) => {
    const frame = basicFrame({
      columns,
      rows,
      transcript: ["[Assistant] first message"],
      header: { screen: "Home", selection: "local / model-a" },
      status: ["status one", "status two"],
    })
    const drawn = frameRows(frame)
    expect(drawn).toHaveLength(rows)
    expect(drawn[0]).toBe("LCA · Home · local / model-a")
    expect(displayWidth(drawn[1]!)).toBe(columns)
    expect(drawn[2]).toBe("[Assistant] first message")
    expect(drawn[rows - 4]).toBe(drawn[1])
    expect(drawn[rows - 3]).toBe("status one")
    expect(drawn[rows - 2]).toBe("status two")
    expect(drawn[rows - 1]).toBe("> ok")
    expect(finalCursor(frame)).toEqual([rows, 5])
    expect(transcriptViewportRows({ columns, rows, draft: "ok", cursor: 2 })).toBe(rows - 6)
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
    const rows = frameRows
    const frame = (transcriptOffset?: number) => renderFrame({
      columns: 80,
      rows: 24,
      transcript: [paragraph],
      ...(transcriptOffset === undefined ? {} : { transcriptOffset }),
      status: "ready",
      draft: "ok",
      cursor: 2,
    })

    expect(rows(frame())[2]).toBe("I".repeat(80))
    expect(rows(frame(1))[2]).toBe("H".repeat(80))
    expect(rows(frame(Number.MAX_SAFE_INTEGER))[2]).toBe("A".repeat(80))
    expect(stripCsi(frame())).toContain("Latest | 8 older | 0 newer | PgUp/PgDn")
    expect(stripCsi(frame(1))).toContain("History | 7 older | 1 newer | PgUp/PgDn")
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

  test("home actions are visible without leaking into the undersized recovery frame", () => {
    for (const [columns, rows] of [[80, 24], [120, 40]] as const) {
      const home = ["LCA", "No model selected", "/model  Choose an engine and model", "/help  Commands", "/quit  Exit"]
      const frame = basicFrame({ columns, rows, transcript: [], home })
      expect(frameRows(frame)[2]).toBe("  LCA")
      expect(frameRows(frame)[3]).toBe("  No model selected")
      expect(stripCsi(frame)).toContain("No model selected")
      expect(stripCsi(frame)).toContain("/model  Choose an engine and model")
      const small = basicFrame({ columns: 79, rows, transcript: [], home })
      expect(stripCsi(small)).not.toContain("No model selected")
      expect(stripCsi(small)).toContain("Terminal too small")
    }
  })

  test.each([[80, 24], [120, 40]] as const)("renders a titled panel without transcript or inactive composer leakage at %ix%i", (columns, rows) => {
    const frame = basicFrame({
      columns,
      rows,
      transcript: ["private transcript context"],
      header: { screen: "Task/evidence details", selection: "local / model-a" },
      panel: { title: "Task/evidence details", focus: "evidence list", lines: ["No task evidence is available."] },
      status: "Escape closes",
      draft: "private draft",
      cursor: 8,
      prompt: "You> ",
      composerVisible: false,
    })
    const plain = stripCsi(frame)
    const drawn = frameRows(frame)
    expect(drawn[0]).toBe("LCA · local / model-a")
    expect(plain.match(/Task\/evidence details/g)).toHaveLength(1)
    expect(drawn[2]).toBe("Task/evidence details · evidence list focus")
    expect(drawn[3]).toBe("No task evidence is available.")
    expect(plain).not.toContain("private transcript context")
    expect(plain).not.toContain("private draft")
    expect(plain).not.toContain("You>")
    expect(drawn[rows - 1]).toBe("")
    expect(frame).toContain("\u001b[?25l")
    expect(finalCursor(frame)).toEqual([rows, 1])
  })

  test("overflow has its own visible row even when draft lines fill every column", () => {
    for (const columns of [80, 120]) {
      const line = "x".repeat(columns - 2)
      const draft = Array.from({ length: 20 }, () => line).join("\n")
      const frame = basicFrame({ columns, draft, cursor: 0 })
      const drawn = [...frame.matchAll(/\u001b\[\d+;1H\u001b\[2K([^\u001b]*)/g)].map(match => match[1]!)
      expect(drawn.some(row => row.includes("Draft ") && row.includes("↓ ") && row.includes(" below"))).toBe(true)
      expect(drawn.every(row => displayWidth(row) <= columns)).toBe(true)
      const [row, column] = finalCursor(frame)
      expect(drawn[row - 1]).toBe(`> ${line}`)
      expect(column).toBe(3)
      expect(stripCsi(basicFrame({ columns, draft, cursor: draft.length, ascii: true }))).toMatch(/Draft .* \| \^ \d+ above \| v 0 below/)
    }
  })

  test("retained page metadata never labels an old page as latest", () => {
    const frame = basicFrame({ transcriptNewer: true, transcriptOlder: true })
    expect(stripCsi(frame)).toContain("History | 0+ older | 0+ newer | PgUp/PgDn")
  })

  test("a scrolled multiline message retains its speaker even without color", () => {
    const transcript = ["[Assistant] first line", ...Array.from({ length: 30 }, (_, index) => `  | continuation ${index}`)]
    for (const color of [false, true]) {
      const frame = basicFrame({ transcript, color })
      expect(stripCsi(frame)).not.toContain("[Assistant] first line")
      expect(stripCsi(frame)).toContain("Assistant continued")
      expect(stripCsi(frame)).toContain("  | continuation 29")
    }
  })

  test.each([80, 120])("physical transcript wraps retain provenance gutters and share scroll row accounting at %i columns", columns => {
    const transcript = ["You", "Assistant", "Error", "Notice", "Canonical plan"]
      .map(label => `[${label}] ${"x".repeat(180)}`)
    const expected = transcript.flatMap(line => wrapTranscriptLine(line, columns))
    expect(expected.length).toBeGreaterThan(transcript.length)
    for (const line of transcript) {
      const wrapped = wrapTranscriptLine(line, columns)
      expect(wrapped[0]).toStartWith(line.slice(0, line.indexOf("]") + 2))
      expect(wrapped.slice(1).every(row => row.startsWith("  | "))).toBe(true)
      expect(wrapped.every(row => displayWidth(row) <= columns)).toBe(true)
    }

    const frame = renderFrame({
      columns,
      rows: 24,
      transcript,
      status: "ready",
      draft: "ok",
      cursor: 2,
      color: false,
    })
    const rows = frameRows(frame)
    const first = rows.indexOf(expected[0]!)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(rows.slice(first, first + expected.length)).toEqual(expected)
    expect(frame).not.toMatch(/\u001b\[[0-9;]*m/)

    const long = `[Assistant] ${"y".repeat(columns * 24)}`
    const physicalRows = wrapTranscriptLine(long, columns)
    const viewportRows = transcriptViewportRows({ columns, rows: 24, draft: "ok", cursor: 2 })
    const scrolled = renderFrame({
      columns,
      rows: 24,
      transcript: [long],
      transcriptOffset: 1,
      status: "ready",
      draft: "ok",
      cursor: 2,
      color: false,
    })
    const scrolledRows = frameRows(scrolled)
    const scrolledFirst = scrolledRows.indexOf(physicalRows.at(-(viewportRows + 1))!)
    expect(scrolledFirst).toBeGreaterThanOrEqual(0)
    expect(scrolledRows.slice(scrolledFirst, scrolledFirst + viewportRows)).toEqual(physicalRows.slice(-(viewportRows + 1), -1))
    expect(stripCsi(scrolled)).toContain(`History | Assistant continued | ${physicalRows.length - viewportRows - 1} older | 1 newer | PgUp/PgDn`)
  })
})
