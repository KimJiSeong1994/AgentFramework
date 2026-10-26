import { describe, expect, spyOn, test } from "bun:test"
import { TuiApp } from "../src/tui/app.ts"
import * as markdown from "../src/tui/markdown.ts"
import type { InputEvent } from "../src/tui/keys.ts"
import { renderFrame, TranscriptLayoutCache, transcriptDisplayRows, transcriptRowText } from "../src/tui/render.ts"
import { resolveTheme } from "../src/tui/theme.ts"

describe("composer redraw cost", () => {
  test("typing after an answer reuses its Markdown layout", () => {
    const app = new TuiApp()
    const internal = app as unknown as {
      input(event: InputEvent): void
      dimensions(): { columns: number; rows: number }
      driver: { write(frame: string): void }
      renderedFrame: string
      renderedTranscript: readonly string[]
    }
    internal.dimensions = () => ({ columns: 120, rows: 40 })
    internal.driver.write = () => {}
    const parse = spyOn(markdown, "parseMarkdown")
    try {
      app.writeText({ provenance: "assistant", text: "## Answer\n\n한글 **답변**입니다.\n".repeat(300) })
      const visible = [...internal.renderedTranscript]
      parse.mockClear()
      for (const text of "next question") internal.input({ type: "text", text })
      expect(app.draftSnapshot().draft).toBe("next question")
      expect(internal.renderedFrame).toContain("next question")
      expect(internal.renderedTranscript).toEqual(visible)
      expect(parse).not.toHaveBeenCalled()
    } finally { parse.mockRestore(); app.close() }
  })

  test("cached rendering matches full rendering through scrolling, resizing, theme and panel transitions", () => {
    const transcript = Object.freeze(["[Assistant] ## 한글 answer", "  | **bold** and `code`", "  | " + "wrap this line ".repeat(60)])
    const cache = new TranscriptLayoutCache()
    const base = { columns: 80, rows: 24, transcript, status: "ready", draft: "next", cursor: 4 }
    const variants: Array<Partial<Parameters<typeof renderFrame>[0]>> = [
      {}, { draft: "next question", cursor: 13 }, { transcriptOffset: 5 },
      { rows: 40 }, { columns: 100 }, { columns: 59 }, {},
      { ascii: true }, { color: true, theme: resolveTheme("dark") },
      { panel: { placement: "body", title: "Details", focus: "list", lines: ["details"] } },
      { panel: { placement: "above", title: "Approval", focus: "choice", lines: ["Allow", "Deny"] } },
      { transcript: Object.freeze(["[Assistant] A different session's answer"]) }, {},
    ]
    for (const variant of variants) {
      let cachedRows: readonly string[] = []
      let fullRows: readonly string[] = []
      const actual = renderFrame({ ...base, ...variant, transcriptLayout: cache, onTranscriptRows: rows => { cachedRows = rows } })
      const expected = renderFrame({ ...base, ...variant, onTranscriptRows: rows => { fullRows = rows } })
      expect(actual).toBe(expected)
      expect(cachedRows).toEqual(fullRows)
    }
  })

  test("layout reuse is bounded to one immutable source and includes width, glyph mode and spinner", () => {
    const cache = new TranscriptLayoutCache()
    const lines = Object.freeze(["[Shell] $1 $ echo hello", "  | hello", "  = running · 1s · Esc cancels"])
    const first = cache.get(lines, 80, false, "⠋")
    expect(cache.get(lines, 80, false, "⠋")).toBe(first)
    for (const [columns, ascii, spinner] of [[60, false, "⠋"], [60, true, "-"], [60, true, "\\"]] as const) {
      const actual = cache.get(lines, columns, ascii, spinner)
      expect(actual).toEqual(transcriptDisplayRows(lines, columns, ascii, spinner))
      expect(actual).not.toBe(first)
    }
    const changed = Object.freeze(["[Assistant] completed"])
    expect(cache.get(changed, 80).map(transcriptRowText).join("\n")).toContain("completed")
    expect(cache.get(lines, 80, false, "⠋")).not.toBe(first)
  })
})
