import { describe, expect, test } from "bun:test"
import { renderFrame } from "../src/tui/render.ts"
import { selectionOverlay, selectionText } from "../src/tui/selection.ts"

const point = (x: number, y = 1) => ({ x, y })
const frame = (overrides: Partial<Parameters<typeof renderFrame>[0]> = {}) => renderFrame({
  columns: 80, rows: 24, transcript: ["[Assistant] hello"], status: "ready", draft: "", cursor: 0,
  ...overrides,
})
const paintedRows = (value: string): string[] => [...value.matchAll(/\u001b\[\d+;1H\u001b\[2K((?:[^\u001b]|\u001b\[[0-9;]*m)*)/g)]
  .map(match => match[1]!.replace(/\u001b\[[0-9;]*m/g, "").trimEnd())

describe("drag selection", () => {
  test("includes both endpoint cells and normalizes reverse drags", () => {
    expect(selectionText(["abcdef"], point(1), point(4))).toBe("abcd")
    expect(selectionText(["abcdef"], point(4), point(1))).toBe("abcd")
  })

  test("preserves multiline indentation and internal blanks, trimming row tails", () => {
    const rows = ["first tail  ", "  middle  ", "", "  last end"]
    expect(selectionText(rows, point(7), point(6, 4))).toBe("tail\n  middle\n\n  last")
    expect(selectionText(rows, point(6, 4), point(7))).toBe("tail\n  middle\n\n  last")
    expect(selectionText(rows, point(-10, -2), point(99, 99))).toBe("first tail\n  middle\n\n  last end")
    expect(selectionText([], point(1), point(8))).toBe("")
    expect(selectionText(["short"], point(10), point(20))).toBe("")
  })

  test("selects complete Unicode graphemes by terminal cells", () => {
    const rows = ["A한👩‍💻e\u0301Z"]
    expect(selectionText(rows, point(3), point(4))).toBe("한👩‍💻")
    expect(selectionText(rows, point(6), point(6))).toBe("e\u0301")
    expect(selectionText(["한가〮!"], point(2), point(3))).toBe("한가〮")
  })

  test("overlay paints selected segments at absolute cells without clearing a frame", () => {
    expect(selectionOverlay(["A한B", "  next"], point(3), point(4, 2)))
      .toBe("\x1b[1;2H\x1b[7m한B\x1b[0m\x1b[2;1H\x1b[7m  ne\x1b[0m")
    expect(selectionOverlay([], point(1), point(2))).toBe("")
  })
})

describe("selectable transcript render rows", () => {
  test("reports visible plain rows synchronously, retaining blanks without frame padding", () => {
    let rows: readonly string[] = []
    let calls = 0
    const rendered = frame({ color: true, transcript: ["[You] question", "[Assistant] **answer**\n\nsecond"],
      onTranscriptRows: value => { rows = value; calls += 1 } })
    expect(calls).toBe(1)
    expect(rows.map(row => row.trimEnd())).toEqual(paintedRows(rendered).slice(0, rows.length))
    expect(rows).toContain("")
    expect(rows.length).toBeLessThan(18)
    expect(rows.join("\n")).not.toContain("\x1b")
    expect(selectionText(rows, point(1), point(80, rows.length))).not.toContain("\x1b")
    expect(rows.join("\n")).not.toContain("ready")
  })

  test("maps scrolled and wrapped content to physical screen rows including trimmed leading blanks", () => {
    const transcript = Array.from({ length: 12 }, (_, index) => `[Assistant] answer ${index} ${"word ".repeat(25)}`)
    for (let offset = 0; offset < 30; offset += 1) {
      let rows: readonly string[] = []
      const rendered = frame({ transcript, color: true, transcriptOffset: offset, onTranscriptRows: value => { rows = value } })
      expect(rows.map(row => row.trimEnd())).toEqual(paintedRows(rendered).slice(0, rows.length))
      expect(rows[0]).not.toBe("")
    }
  })

  test("clears rows for small screens, body panels and welcome screens", () => {
    const variants: Array<Partial<Parameters<typeof renderFrame>[0]>> = [
      { columns: 30 },
      { panel: { title: "Settings", focus: "settings", lines: ["setting"] } },
      { transcript: [], home: { title: "Otter", left: ["welcome"], sections: [] } },
    ]
    for (const variant of variants) {
      const calls: Array<readonly string[]> = []
      frame({ ...variant, onTranscriptRows: rows => calls.push(rows) })
      expect(calls).toEqual([[]])
    }
  })
})
