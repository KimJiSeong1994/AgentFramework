import { describe, expect, test } from "bun:test"
import fixtureSet from "./fixtures/gjc-keys-8cd17c0.json"
import { displayAnsiWidth, displayWidth, renderFrame, transcriptDisplayRows, transcriptRowText, transcriptViewportRows, wrapAnsiText, wrapText, wrapTranscriptLine } from "../src/tui/render.ts"

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
const frameRows = (value: string): string[] => [...value.matchAll(/\u001b\[\d+;1H\u001b\[2K((?:[^\u001b]|\u001b\[[0-9;]*m)*)/g)]
  .map(match => match[1]!.replace(/\u001b\[[0-9;]*m/g, "").trimEnd())
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
  const composerContent = (drawn: readonly string[]): string[] => {
    const bottom = drawn.findLastIndex(row => row.startsWith("╰") && !row.includes("┴"))
    const top = drawn.slice(0, bottom).findLastIndex(row => row.startsWith("╭"))
    return drawn.slice(top + 1, bottom).map(row => row.replace(/^│ /u, "").replace(/ *│$/u, ""))
  }

  test("redraws every row at 80x24 and positions the cursor inside the composer box", () => {
    const frame = basicFrame()
    expect((frame.match(/\u001b\[\d+;1H\u001b\[2K/g) ?? [])).toHaveLength(24)
    const drawn = frameRows(frame)
    expect(drawn[0]).toBe("  transcript row")
    expect(drawn[20]).toStartWith(" ⬢ no model ─")
    expect(drawn[21]).toBe(`╭${"─".repeat(78)}╮`)
    expect(drawn[22]).toBe(`│ > ok${" ".repeat(73)}│`)
    expect(drawn[23]).toBe(`╰${"─".repeat(78)}╯`)
    expect(drawn[19]).toBe("ready")
    expect(finalCursor(frame)).toEqual([23, 7])
  })

  test.each([[80, 24], [120, 40]] as const)("arranges transcript, status, model rule and bordered composer at %ix%i", (columns, rows) => {
    const frame = basicFrame({
      columns,
      rows,
      transcript: ["[You] question", "[Assistant] first message"],
      header: { screen: "Chat", selection: "local / model-a" },
      status: ["status one", "status two"],
    })
    const drawn = frameRows(frame)
    expect(drawn).toHaveLength(rows)
    expect(drawn.slice(0, 5)).toEqual(["you", "  question", "", "otter", "  first message"])
    expect(drawn[rows - 6]).toBe("status one")
    expect(drawn[rows - 5]).toBe("status two")
    expect(drawn[rows - 4]).toStartWith(" ⬢ local / model-a ─")
    expect(drawn[rows - 4]).toEndWith("─ Otter")
    expect(displayWidth(drawn[rows - 4]!)).toBe(columns)
    expect(composerContent(drawn)).toEqual(["> ok"])
    expect(finalCursor(frame)).toEqual([rows - 1, 7])
    expect(transcriptViewportRows({ columns, rows, draft: "ok", cursor: 2 })).toBe(rows - 6)
  })

  test("shows a bounded resize notice below minimum without changing the model", () => {
    const input = Object.freeze({
      columns: 59,
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

    const shortFrame = renderFrame({ ...input, columns: 80, rows: 19 })
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
    const small = renderFrame({ ...state, columns: 59 })
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

  test("scrolls within one paragraph by wrapped visual rows and reports position on the rule", () => {
    const paragraph = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index).repeat(80)).join("")
    const physical = transcriptDisplayRows([paragraph], 80).map(transcriptRowText)
    const viewport = transcriptViewportRows({ columns: 80, rows: 24, draft: "ok", cursor: 2 })
    const frame = (transcriptOffset?: number) => renderFrame({
      columns: 80,
      rows: 24,
      transcript: [paragraph],
      ...(transcriptOffset === undefined ? {} : { transcriptOffset }),
      status: "ready",
      draft: "ok",
      cursor: 2,
    })

    expect(frameRows(frame())[0]).toBe(physical[physical.length - viewport])
    expect(frameRows(frame(1))[0]).toBe(physical[physical.length - viewport - 1])
    expect(frameRows(frame(Number.MAX_SAFE_INTEGER))[0]).toBe(physical[0])
    expect(stripCsi(frame())).toContain(`Latest · ${physical.length - viewport} older · 0 newer · PgUp/PgDn`)
    expect(stripCsi(frame(1))).toContain(`History · ${physical.length - viewport - 1} older · 1 newer · PgUp/PgDn`)
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
    expect(colored).toContain("\u001b[2mready\u001b[0m")
  })

  test("user messages keep a speaker label without color and a full-width bar with color", () => {
    const plain = frameRows(basicFrame({ transcript: ["[You] mine", "[Assistant] reply"], color: false }))
    expect(plain.slice(0, 5)).toEqual(["you", "  mine", "", "otter", "  reply"])
    const colored = basicFrame({ transcript: ["[You] mine"], color: true })
    expect(colored).toContain(`\u001b[1;48;5;236;97m  mine${" ".repeat(74)}\u001b[0m`)
    expect(colored).toContain("\u001b[1;36myou\u001b[0m")
  })

  test("wraps a full-width cursor onto a valid following row", () => {
    const frame = basicFrame({ draft: "x".repeat(74), cursor: 74 })
    expect(finalCursor(frame)).toEqual([23, 5])
    expect(frameRows(frame)[21]).toBe(`│ > ${"x".repeat(74)} │`)
  })

  test("uses grapheme display width for cursor placement and scrolls multiline input with it", () => {
    const unicode = basicFrame({ draft: "a👩‍💻é", cursor: 1 })
    expect(finalCursor(unicode)).toEqual([23, 6])

    const draft = "line\n".repeat(20)
    const multiline = renderFrame({
      columns: 80,
      rows: 40,
      transcript: ["transcript survives"],
      status: "ready",
      draft,
      cursor: draft.length,
    })
    expect(finalCursor(multiline)).toEqual([39, 5])
    expect(stripCsi(multiline)).toContain("transcript survives")
  })

  test("welcome box shows identity and sections without leaking into the undersized recovery frame", () => {
    const home = {
      title: "Otter · local coding agent",
      left: ["Otter", "No model is selected."],
      sections: [
        { heading: "Get started", lines: ["/model  choose a model", "/help   commands and keys"] },
        { heading: "Flow keys", lines: ["/ commands"] },
      ],
    }
    for (const [columns, rows] of [[60, 20], [70, 58], [80, 24], [120, 40]] as const) {
      const frame = basicFrame({ columns, rows, transcript: [], home })
      const drawn = frameRows(frame)
      expect(drawn[0]).toStartWith("╭─ Otter · local coding agent ─")
      expect(drawn[0]).toEndWith("╮")
      expect(drawn.findIndex(row => row.startsWith("╰") && row.includes("┴"))).toBeGreaterThan(0)
      expect(stripCsi(frame)).toContain("No model is selected.")
      expect(stripCsi(frame)).toContain("/model  choose a model")
      expect(stripCsi(frame)).toContain("Flow keys")
      expect(drawn.every(row => displayWidth(row) <= columns)).toBe(true)
      const small = basicFrame({ columns: 59, rows, transcript: [], home })
      expect(stripCsi(small)).not.toContain("No model is selected")
      expect(stripCsi(small)).toContain("Terminal too small")
    }
  })

  test.each([[80, 24], [120, 40]] as const)("renders a bordered body panel without transcript or inactive composer leakage at %ix%i", (columns, rows) => {
    const frame = basicFrame({
      columns,
      rows,
      transcript: ["private transcript context"],
      header: { screen: "Task/evidence details", selection: "local / model-a" },
      panel: { title: "Task/evidence details", focus: "evidence list", placement: "body", lines: ["No task evidence is available."] },
      status: "Escape closes",
      draft: "private draft",
      cursor: 8,
      prompt: "You> ",
      composerVisible: false,
    })
    const plain = stripCsi(frame)
    const drawn = frameRows(frame)
    expect(drawn[0]).toStartWith("╭─ Task/evidence details · evidence list focus ─")
    expect(drawn[1]).toStartWith("│ No task evidence is available.")
    expect(drawn[2]).toStartWith("╰")
    expect(plain.match(/Task\/evidence details/g)).toHaveLength(1)
    expect(plain).not.toContain("private transcript context")
    expect(plain).not.toContain("private draft")
    expect(plain).not.toContain("You>")
    expect(drawn[rows - 1]).toStartWith(" ⬢ local / model-a ─")
    expect(drawn[rows - 1]).toEndWith("─ Otter")
    expect(frame).toContain("\u001b[?25l")
    expect(finalCursor(frame)).toEqual([rows, 1])
  })

  test("a below panel keeps the transcript and composer and lists choices under the box", () => {
    const frame = basicFrame({
      transcript: ["[Assistant] still visible"],
      header: { screen: "Choose an execution engine", selection: "local / model-a" },
      composerTitle: "Choose an execution engine",
      panel: { title: "Choose an execution engine", focus: "filter", placement: "below", lines: ["> local — Ollama CLI", "  codex — Codex CLI", "(1/2) 2 matches"] },
      status: "Up/Down move",
      draft: "lo",
      cursor: 2,
      prompt: "Filter> ",
    })
    const drawn = frameRows(frame)
    expect(drawn.slice(0, 2)).toEqual(["otter", "  still visible"])
    expect(drawn.at(-3)).toBe("> local — Ollama CLI")
    expect(drawn.at(-2)).toBe("  codex — Codex CLI")
    expect(drawn.at(-1)).toBe("(1/2) 2 matches")
    expect(drawn.at(-6)).toStartWith("╭─ Choose an execution engine ─")
    expect(drawn.at(-5)).toStartWith("│ Filter> lo")
    expect(drawn.at(-7)).toEndWith("─ Otter")
    expect(stripCsi(frame).match(/Choose an execution engine/g)).toHaveLength(1)
    expect(finalCursor(frame)).toEqual([20, 13])
  })

  test("overflow is reported on the composer border even when draft lines fill every column", () => {
    for (const columns of [80, 120]) {
      const line = "x".repeat(columns - 4)
      const draft = Array.from({ length: 20 }, () => line).join("\n")
      const frame = basicFrame({ columns, draft, cursor: 0 })
      const drawn = frameRows(frame)
      const top = drawn.findLastIndex(row => row.startsWith("╭"))
      expect(drawn[top]).toMatch(/^╭─ Draft 1-\d+\/\d+ · ↑ 0 above · ↓ \d+ below ─+╮$/u)
      expect(drawn.every(row => displayWidth(row) <= columns)).toBe(true)
      const [row, column] = finalCursor(frame)
      expect(row - 1).toBe(top + 1)
      expect(drawn[row - 1]).toStartWith(`│ > ${"x".repeat(columns - 6)}`)
      expect(column).toBe(5)
      expect(stripCsi(basicFrame({ columns, draft, cursor: draft.length, ascii: true }))).toMatch(/Draft .* \| \^ \d+ above \| v 0 below/)
    }
  })

  test("retained page metadata never labels an old page as latest", () => {
    const frame = basicFrame({ transcriptNewer: true, transcriptOlder: true })
    expect(stripCsi(frame)).toContain("History · 0+ older · 0+ newer · PgUp/PgDn")
  })

  test("a scrolled multiline message retains its speaker even without color", () => {
    const transcript = ["[Assistant] first line", ...Array.from({ length: 30 }, (_, index) => `  | continuation ${index}`)]
    for (const color of [false, true]) {
      const frame = basicFrame({ transcript, color })
      expect(stripCsi(frame)).not.toContain("first line")
      expect(stripCsi(frame)).toContain("Assistant continued")
      expect(stripCsi(frame)).toContain("  continuation 29")
    }
  })

  test.each([80, 120])("physical transcript wraps keep distinct provenance and share scroll row accounting at %i columns", columns => {
    const labels = ["You", "Assistant", "Error", "Notice", "Canonical plan"] as const
    const leads = ["you", "otter", "✗ ", "· ", "plan"]
    const transcript = labels.map(label => `[${label}] ${"x ".repeat(columns)}`)
    labels.forEach((label, index) => {
      const wrapped = wrapTranscriptLine(transcript[index]!, columns)
      expect(wrapped.length).toBeGreaterThan(2)
      if (leads[index]!.length > 2) {
        expect(wrapped[0]).toBe(leads[index])
        expect(wrapped.slice(1).every(row => row.startsWith("  "))).toBe(true)
      } else {
        expect(wrapped[0]).toStartWith(leads[index]!)
        expect(wrapped.slice(1).every(row => row.startsWith("  "))).toBe(true)
      }
      expect(wrapped.every(row => displayWidth(row) <= columns)).toBe(true)
    })

    const expected = transcriptDisplayRows(transcript, columns).map(row => transcriptRowText(row).trimEnd())
    expect(expected.filter(row => row === "")).toHaveLength(transcript.length - 1)
    const viewportRows = transcriptViewportRows({ columns, rows: 24, draft: "ok", cursor: 2 })
    const frame = renderFrame({ columns, rows: 24, transcript, status: "ready", draft: "ok", cursor: 2, color: false })
    const shown = expected.slice(-viewportRows)
    const firstShown = shown[0] === "" ? shown.slice(1) : shown
    expect(frameRows(frame).slice(0, firstShown.length)).toEqual(firstShown)
    expect(frame).not.toMatch(/\u001b\[[0-9;]*m/)

    const long = `[Assistant] ${"y".repeat(columns * 24)}`
    const physicalRows = wrapTranscriptLine(long, columns)
    const scrolled = renderFrame({ columns, rows: 24, transcript: [long], transcriptOffset: 1, status: "ready", draft: "ok", cursor: 2, color: false })
    expect(frameRows(scrolled).slice(0, viewportRows)).toEqual(physicalRows.slice(-(viewportRows + 1), -1))
    expect(stripCsi(scrolled)).toContain(`History · Assistant continued · ${physicalRows.length - viewportRows - 1} older · 1 newer · PgUp/PgDn`)
  })

  test("assistant Markdown renders structure instead of raw syntax", () => {
    const reply = [
      "## Plan", "", "* **Analyze** the `bun test` output.", "  continues the item", "1. first", "", "```ts",
      "const x = 1  // keep  spacing", "```", "", "> quoted", "---", "snake_case_name and 2 * 3 * 4 stay literal.",
      "See [docs](https://example.com).",
    ]
    const lines = reply.map((line, index) => index === 0 ? `[Assistant] ${line}` : `  | ${line}`)
    const rows = transcriptDisplayRows(lines, 60).map(transcriptRowText)
    expect(rows).toEqual([
      "otter",
      "  Plan",
      "",
      "  • Analyze the bun test output.",
      "    continues the item",
      "  1. first",
      "",
      "  ```ts",
      "    const x = 1  // keep  spacing",
      "  ```",
      "",
      "  ▏ quoted",
      `  ${"─".repeat(58)}`,
      "  snake_case_name and 2 * 3 * 4 stay literal.",
      "  See docs (https://example.com).",
    ])
    expect(transcriptDisplayRows(lines, 60, true).map(transcriptRowText)).toContain("  * Analyze the bun test output.")

    const colored = renderFrame({ columns: 80, rows: 30, transcript: lines, status: "", draft: "", cursor: 0, color: true })
    expect(colored).toContain("\u001b[1;36mPlan\u001b[0m")
    expect(colored).toContain("\u001b[1mAnalyze\u001b[0m")
    expect(colored).toContain("\u001b[36mbun test\u001b[0m")
    expect(colored).toContain("\u001b[35mconst x = 1  // keep  spacing\u001b[0m")
    const plain = renderFrame({ columns: 80, rows: 30, transcript: lines, status: "", draft: "", cursor: 0, color: false })
    expect(plain).not.toMatch(/\u001b\[[0-9;]*m/)
    expect(stripCsi(plain)).not.toContain("**")
    expect(stripCsi(plain)).not.toContain("## ")
  })

  test("Markdown layout never interprets model-supplied terminal controls", () => {
    const rows = transcriptDisplayRows(["[Assistant] **bold\u001b[2J** and `code\u001b]52;x\u0007`"], 80).map(transcriptRowText)
    expect(rows.join("\n")).not.toMatch(/[\u001b\u0007]/u)
    expect(rows[1]).toBe("  bold�[2J and code�]52;x�")
  })

  test("tool rows show outcome status and keep the logical summary searchable", () => {
    const rows = transcriptDisplayRows([
      "[+] #1 read · call succeeded · execution not observed · task Implement · t1 done",
      "[-] #2 grep · call failed · execution unconfirmed · task Implement · t1 running",
      "  Call call-2 · execution exec-2 · worker",
      "[+] #3 bash · call running · execution not observed · task Implement · t1 running",
    ], 120).map(transcriptRowText)
    expect(rows).toEqual([
      "✔ ▸ #1 read · call succeeded · execution not observed · task Implement · t1 done",
      "✘ ▾ #2 grep · call failed · execution unconfirmed · task Implement · t1 running",
      "    Call call-2 · execution exec-2 · worker",
      "⟳ ▸ #3 bash · call running · execution not observed · task Implement · t1 running",
    ])
    expect(transcriptDisplayRows(["[+] #1 read · call denied · task t · t1"], 80, true).map(transcriptRowText)[0]).toBe("x > #1 read · call denied · task t · t1")
  })

  test("live tool and shell icons take the spinner frame; last-recorded state stays static", () => {
    const lines = [
      "[+] #1 bash · call running · execution not observed · task Implement · t1 running",
      "[+] #2 read · call running (last recorded; unconfirmed) · execution last recorded · task Implement · t1 running (last recorded)",
      "[+] #3 grep · call succeeded · execution not observed · task Implement · t1 done",
      "[Shell] $1 $ sleep 5",
      "  = running · 2s · Esc cancels",
      "[Shell] $2 $ true",
      "  = exit 0 · 0.0s",
    ]
    const rows = transcriptDisplayRows(lines, 160, false, "⠹").map(transcriptRowText)
    expect(rows[0]).toStartWith("⠹ ▸ #1 bash")
    expect(rows[1]).toStartWith("⟳ ▸ #2 read")
    expect(rows[2]).toStartWith("✔ ▸ #3 grep")
    expect(rows).toContainEqual(expect.stringMatching(/^│ ⠹ running · 2s · Esc cancels\s+│$/u))
    expect(rows).toContainEqual(expect.stringMatching(/^│ ✔ exit 0 · 0\.0s\s+│$/u))
    // Without a frame (not busy) the running shell keeps its static marker.
    expect(transcriptDisplayRows(lines, 100).map(transcriptRowText)).toContainEqual(expect.stringMatching(/^│ ⟳ running/u))
    // The frame never changes layout.
    expect(transcriptDisplayRows(lines, 100, false, "⠹")).toHaveLength(transcriptDisplayRows(lines, 100).length)
  })

})
