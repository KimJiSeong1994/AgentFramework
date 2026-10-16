import { resolveTheme, semanticStyle, type SemanticToken, type Theme } from "./theme.ts"

type DisplayToken = {
  text: string
  width: number
  newline: boolean
  whitespace: boolean
  sgr?: boolean
}

type DisplayGroup = {
  sourceStart: number
  sourceEnd: number
  tokens: DisplayToken[]
}

type ComposerRow = {
  text: string
  width: number
}

type CursorPosition = {
  line: number
  column: number
}

/**
 * `below` panels list under the composer (pickers, completions, history search) and keep
 * the transcript visible; `body` panels replace the transcript and hide the composer.
 */
export type FramePanel = {
  readonly title: string
  readonly focus: string
  readonly lines: readonly string[]
  readonly placement?: "below" | "body"
}

/** `selection` is the authoritative engine/model fact; `screen` names the active surface. */
export type FrameHeader = {
  readonly screen: string
  readonly selection?: string
}

/** Empty-session welcome box: left column identity, right column titled sections. */
export type FrameHome = {
  readonly title: string
  readonly left: readonly string[]
  readonly sections: ReadonlyArray<{ readonly heading: string; readonly lines: readonly string[] }>
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const whitespace = /^\p{White_Space}+$/u
const resizeNotice = "Terminal too small: resize to at least 80×24"
// Bottom block: status rows, a rule, then the bordered composer (top + bottom border).
const statusRows = 2
const ruleRows = 1
const composerBorderRows = 2
const panelBorderRows = 2
const minimumBodyRows = 3
const maximumBelowRows = 12

function isBidiControl(codePoint: number): boolean {
  return codePoint === 0x061c || codePoint === 0x200e || codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) || codePoint === 0xfeff
}

function sanitizeGrapheme(value: string): string {
  let safe = ""
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!
    const length = codePoint > 0xffff ? 2 : 1

    if (codePoint === 0x0d) {
      safe += "\n"
      index += value.charCodeAt(index + 1) === 0x0a ? 2 : length
      continue
    }
    if (codePoint === 0x0a || codePoint === 0x2028 || codePoint === 0x2029) {
      safe += "\n"
    } else if (codePoint === 0x09) {
      safe += "    "
    } else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) || isBidiControl(codePoint)) {
      safe += "�"
    } else {
      safe += String.fromCodePoint(codePoint)
    }
    index += length
  }
  return safe.normalize("NFC")
}

function tokenFor(value: string): DisplayToken {
  if (value === "\n") return { text: "", width: 0, newline: true, whitespace: false }
  const normalized = value.normalize("NFC")
  const width = /^[\uac00-\ud7a3][\u302e\u302f]+$/u.test(normalized)
    ? 2
    : Math.max(0, Bun.stringWidth(normalized))
  return {
    text: value,
    // NFC keeps decomposed Hangul aligned; Bun currently overcounts Hangul tone graphemes.
    width,
    newline: false,
    whitespace: whitespace.test(value),
  }
}

function displayGroups(value: string): DisplayGroup[] {
  const groups: DisplayGroup[] = []
  for (const part of graphemes.segment(value)) {
    const safe = sanitizeGrapheme(part.segment)
    const tokens = [...graphemes.segment(safe)].map(piece => tokenFor(piece.segment))
    groups.push({ sourceStart: part.index, sourceEnd: part.index + part.segment.length, tokens })
  }
  return groups
}

function displayTokens(groups: readonly DisplayGroup[]): DisplayToken[] {
  const tokens: DisplayToken[] = []
  for (const group of groups) tokens.push(...group.tokens)
  return tokens
}

export function displayWidth(text: string): number {
  let width = 0
  let maximum = 0
  for (const token of displayTokens(displayGroups(text))) {
    if (token.newline) {
      maximum = Math.max(maximum, width)
      width = 0
    } else {
      width += token.width
    }
  }
  return Math.max(maximum, width)
}

function sgrSequenceAt(text: string, index: number): string | undefined {
  if (text[index] !== "\u001b" || text[index + 1] !== "[") return undefined
  const match = /^\u001b\[([0-9;:]*)m/.exec(text.slice(index))
  return match?.[0]
}

function trustedAnsiTokens(text: string): DisplayToken[] {
  const tokens: DisplayToken[] = []
  let plainStart = 0
  let index = 0
  const appendPlain = (plain: string): void => {
    tokens.push(...displayTokens(displayGroups(plain)))
  }

  while (index < text.length) {
    const sequence = sgrSequenceAt(text, index)
    if (sequence) {
      appendPlain(text.slice(plainStart, index))
      tokens.push({ text: sequence, width: 0, newline: false, whitespace: false, sgr: true })
      index += sequence.length
      plainStart = index
    } else {
      index += 1
    }
  }
  appendPlain(text.slice(plainStart))
  return tokens
}

/** Measure trusted terminal text, ignoring only well-formed SGR sequences. */
export function displayAnsiWidth(text: string): number {
  let width = 0
  let maximum = 0
  for (const token of trustedAnsiTokens(text)) {
    if (token.newline) {
      maximum = Math.max(maximum, width)
      width = 0
    } else {
      width += token.width
    }
  }
  return Math.max(maximum, width)
}

function wrapParagraph(tokens: readonly DisplayToken[], columns: number): string[] {
  if (tokens.length === 0) return [""]

  const words: Array<{ tokens: DisplayToken[]; width: number; whitespace: boolean }> = []
  for (const token of tokens) {
    const isWhitespace = token.whitespace
    const last = words[words.length - 1]
    if (last && last.whitespace === isWhitespace) {
      last.tokens.push(token)
      last.width += token.width
    } else {
      words.push({ tokens: [token], width: token.width, whitespace: isWhitespace })
    }
  }

  const lines: string[] = []
  let current: DisplayToken[] = []
  let currentWidth = 0
  const flush = (trimTrailingWhitespace: boolean): void => {
    let end = current.length
    if (trimTrailingWhitespace) {
      while (end > 0 && current[end - 1]!.whitespace) end -= 1
    }
    const line = current.slice(0, end).map(token => token.text).join("")
    if (line || lines.length === 0) lines.push(line)
    current = []
    currentWidth = 0
  }

  for (const word of words) {
    if (word.width > columns && !word.whitespace) {
      if (currentWidth > 0 && currentWidth + word.width > columns) flush(true)
      for (const token of word.tokens) {
        if (currentWidth + token.width > columns && currentWidth > 0) flush(true)
        current.push(token)
        currentWidth += token.width
      }
      continue
    }

    if (currentWidth + word.width > columns && currentWidth > 0) {
      flush(true)
      if (word.whitespace) continue
    }
    current.push(...word.tokens)
    currentWidth += word.width
  }

  if (current.length > 0 || lines.length === 0) flush(false)
  return lines
}

function safeColumns(columns: number): number {
  return Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1
}

export function wrapText(text: string, columns: number): string[] {
  const width = safeColumns(columns)
  const lines: string[] = []
  let paragraph: DisplayToken[] = []
  for (const token of displayTokens(displayGroups(text))) {
    if (token.newline) {
      lines.push(...wrapParagraph(paragraph, width))
      paragraph = []
    } else {
      paragraph.push(token)
    }
  }
  lines.push(...wrapParagraph(paragraph, width))
  return lines
}

type Speaker = "You" | "Assistant" | "Error" | "Notice" | "Canonical plan"

/** One physical transcript row. `gutter` carries color-independent provenance. */
export type TranscriptRow = {
  readonly gutter: string
  readonly text: string
  readonly speaker?: Speaker
  readonly role: "first" | "continuation" | "blank"
  readonly semantic: SemanticToken
  readonly gutterSemantic: SemanticToken
}

const speakers: Record<Speaker, { glyph: string; ascii: string; semantic: SemanticToken; gutter: SemanticToken }> = {
  You: { glyph: "❯", ascii: ">", semantic: "user", gutter: "user" },
  Assistant: { glyph: "●", ascii: "*", semantic: "text", gutter: "accent" },
  Notice: { glyph: "·", ascii: "-", semantic: "muted", gutter: "muted" },
  Error: { glyph: "✗", ascii: "x", semantic: "error", gutter: "error" },
  "Canonical plan": { glyph: "◆", ascii: "#", semantic: "text", gutter: "warning" },
}
const gutterWidth = 2
const speakerLabel = /^\[(You|Assistant|Error|Notice|Canonical plan)\](?: |$)/u
const toolSummary = /^\[[+-]\] #\d+ /u

function contentSemantic(text: string): SemanticToken | undefined {
  if (/^\[\+\] \+/u.test(text)) return "diff-add"
  if (/^\[-\] -/u.test(text)) return "diff-remove"
  if (text.startsWith("[code] ")) return "code"
  return undefined
}

/**
 * Map logical transcript lines to physical rows. A blank row separates entries, the first
 * row of an entry carries its speaker glyph, and continuations are indented. Rendering and
 * scroll bounds both use this so page arithmetic matches what is drawn.
 */
export function transcriptDisplayRows(lines: readonly string[], columns: number, ascii = false): TranscriptRow[] {
  const width = Math.max(1, safeColumns(columns) - gutterWidth)
  const rows: TranscriptRow[] = []
  let speaker: Speaker | undefined
  let semantic: SemanticToken = "text"
  const blank = (): void => {
    if (rows.length) rows.push({ gutter: "", text: "", role: "blank", semantic: "text", gutterSemantic: "text" })
  }
  const push = (text: string, role: "first" | "continuation", rowSemantic: SemanticToken, gutter: string, gutterSemantic: SemanticToken): void => {
    wrapText(text, width).forEach((line, index) => rows.push({
      gutter: index === 0 && role === "first" ? gutter : "  ",
      text: line,
      ...(speaker ? { speaker } : {}),
      role: index === 0 ? role : "continuation",
      semantic: rowSemantic,
      gutterSemantic,
    }))
  }
  for (const line of lines) {
    const label = speakerLabel.exec(line)
    if (label) {
      speaker = label[1] as Speaker
      const style = speakers[speaker]
      let body = line.slice(label[0].length)
      if (speaker === "Canonical plan") body = `Plan: ${body}`
      semantic = speaker === "You" || speaker === "Error" ? style.semantic : contentSemantic(body) ?? style.semantic
      blank()
      push(body, "first", semantic, `${ascii ? style.ascii : style.glyph} `, style.gutter)
      semantic = style.semantic
      continue
    }
    if (line.startsWith("  | ")) {
      const body = line.slice(4)
      const rowSemantic = speaker === "You" || speaker === "Error" ? semantic : contentSemantic(body) ?? semantic
      push(body, "continuation", rowSemantic, "  ", "text")
      continue
    }
    if (toolSummary.test(line)) {
      speaker = undefined
      semantic = "muted"
      blank()
      push(line, "first", "text", `${ascii ? "+" : "⏺"} `, "success")
      continue
    }
    if (/^\s/u.test(line)) {
      push(line.trimStart(), "continuation", semantic, "  ", "text")
      continue
    }
    speaker = undefined
    semantic = "text"
    blank()
    push(line, "first", "text", "  ", "text")
  }
  return rows
}

/** Physical rows for one logical line, without the separator that precedes later entries. */
export function wrapTranscriptLine(text: string, columns: number, ascii = false): string[] {
  return transcriptDisplayRows([text], columns, ascii).map(row => `${row.gutter}${row.text}`)
}

function sgrResetState(sequence: string): { resets: boolean; finalReset: boolean } {
  const parameters = sequence.slice(2, -1).split(";")
  let reset = false
  let finalReset = false
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index]!
    const codeText = parameter.split(":", 1)[0]!
    const code = codeText === "" ? 0 : Number(codeText)
    if (code === 0) {
      reset = true
      finalReset = index === parameters.length - 1
    }
    if ((code === 38 || code === 48 || code === 58) && parameters[index + 1] === "2") {
      index += 4
    } else if ((code === 38 || code === 48 || code === 58) && parameters[index + 1] === "5") {
      index += 2
    }
  }
  return { resets: reset, finalReset }
}

function updateSgrState(sequence: string, active: string[]): void {
  const reset = sgrResetState(sequence)
  if (reset.resets) {
    active.length = 0
    if (!reset.finalReset) active.push(sequence)
  } else {
    active.push(sequence)
  }
}

/**
 * Wrap trusted terminal text while preserving well-formed SGR sequences.
 * Non-SGR control bytes are rendered as replacement characters, not executed.
 */
export function wrapAnsiText(text: string, columns: number): string[] {
  const width = safeColumns(columns)
  const lines: string[] = []
  let paragraph: DisplayToken[] = []
  for (const token of trustedAnsiTokens(text)) {
    if (token.newline) {
      lines.push(...wrapParagraph(paragraph, width))
      paragraph = []
    } else {
      paragraph.push(token)
    }
  }
  lines.push(...wrapParagraph(paragraph, width))

  const active: string[] = []
  return lines.map(line => {
    const prefix = active.join("")
    for (const token of trustedAnsiTokens(line)) {
      if (token.sgr) updateSgrState(token.text, active)
    }
    return `${prefix}${line}${active.length > 0 ? "\u001b[0m" : ""}`
  })
}

function oneLineText(value: string): string {
  return displayTokens(displayGroups(value))
    .map(token => token.newline ? " " : token.text)
    .join("")
}

export function clipToWidth(value: string, columns: number): string {
  const width = safeColumns(columns)
  let used = 0
  let result = ""
  for (const token of displayTokens(displayGroups(oneLineText(value)))) {
    if (token.newline || used + token.width > width) break
    result += token.text
    used += token.width
  }
  return result
}

function snapCursor(groups: readonly DisplayGroup[], requested: number, length: number): number {
  const cursor = Number.isFinite(requested) ? Math.max(0, Math.min(length, Math.floor(requested))) : 0
  for (const group of groups) {
    if (cursor === group.sourceStart || cursor === group.sourceEnd) return cursor
    if (cursor < group.sourceEnd) return group.sourceStart
  }
  return length
}

function layoutComposer(draft: string, prompt: string, columns: number, requestedCursor: number): {
  rows: ComposerRow[]
  cursor: CursorPosition
} {
  const safePrompt = clipToWidth(prompt, Math.max(1, columns - 1))
  const promptWidth = displayWidth(safePrompt)
  const continuation = " ".repeat(promptWidth)
  const rows: ComposerRow[] = [{ text: safePrompt, width: promptWidth }]
  let current = rows[0]!
  let cursor: CursorPosition | undefined
  const groups = displayGroups(draft)
  const cursorOffset = snapCursor(groups, requestedCursor, draft.length)

  const startRow = (): void => {
    current = { text: continuation, width: promptWidth }
    rows.push(current)
  }
  const setCursor = (): void => {
    cursor = { line: rows.length - 1, column: current.width }
  }

  for (const group of groups) {
    const boundaryAtStart = cursorOffset === group.sourceStart
    for (let index = 0; index < group.tokens.length; index += 1) {
      const token = group.tokens[index]!
      if (token.newline) {
        const full = current.width >= columns
        if (full) startRow()
        if (boundaryAtStart && index === 0) setCursor()
        if (!full) startRow()
        continue
      }

      if (current.width + token.width > columns) startRow()
      if (boundaryAtStart && index === 0) setCursor()
      current.text += token.text
      current.width += token.width
    }
  }

  if (!cursor) {
    if (current.width >= columns) startRow()
    setCursor()
  }
  if (cursor === undefined) throw new Error("composer cursor layout invariant violated")
  return { rows, cursor }
}

function terminalDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

/** Composer text columns inside `│ ` and ` │`. */
export function composerInnerColumns(columns: number): number {
  return Math.max(1, terminalDimension(columns) - 4)
}

/** Content columns inside a bordered body panel. */
export function panelInnerColumns(columns: number): number {
  return Math.max(1, terminalDimension(columns) - 4)
}

function maximumComposerRows(rows: number): number {
  return Math.max(1, Math.floor(rows / 3) - composerBorderRows)
}

function composerRowCount(input: { columns: number; rows: number; draft: string; cursor: number; prompt?: string }): number {
  const composer = layoutComposer(input.draft, input.prompt ?? "> ", composerInnerColumns(input.columns), input.cursor)
  return Math.min(composer.rows.length, maximumComposerRows(input.rows))
}

function bottomRows(rows: number, composerRows: number, belowRows: number): number {
  return statusRows + ruleRows + (composerRows ? composerBorderRows + composerRows : 0) + belowRows
}

/** Rows a `below` panel may use under the composer while keeping a minimal transcript. */
export function belowPanelRows(input: { columns: number; rows: number; draft: string; cursor: number; prompt?: string }): number {
  const columns = terminalDimension(input.columns)
  const rows = terminalDimension(input.rows)
  if (columns < 80 || rows < 24) return 0
  const used = bottomRows(rows, composerRowCount({ ...input, columns, rows }), 0)
  return Math.max(1, Math.min(maximumBelowRows, rows - used - minimumBodyRows))
}

/** Transcript rows above the bottom block; render and scroll bounds share this. */
export function transcriptViewportRows(input: {
  columns: number
  rows: number
  draft: string
  cursor: number
  prompt?: string
  composerVisible?: boolean
  belowRows?: number
}): number {
  const columns = terminalDimension(input.columns)
  const rows = terminalDimension(input.rows)
  if (columns < 80 || rows < 24) return 0
  const composerRows = input.composerVisible === false ? 0 : composerRowCount({ ...input, columns, rows })
  return Math.max(0, rows - bottomRows(rows, composerRows, Math.max(0, input.belowRows ?? 0)))
}

/** Content rows inside a bordered body panel (composer hidden). */
export function bodyPanelRows(input: { columns: number; rows: number }): number {
  return Math.max(1, transcriptViewportRows({ ...input, draft: "", cursor: 0, prompt: "", composerVisible: false }) - panelBorderRows)
}

/** Total physical transcript rows, including entry separators. */
export function transcriptVisualRows(lines: readonly string[], columns: number, ascii = false): number {
  return transcriptDisplayRows(lines, columns, ascii).length
}

function makeFrame(lines: readonly string[], cursor: CursorPosition, cursorVisible = true): string {
  const output: string[] = []
  for (let row = 0; row < lines.length; row += 1) {
    output.push(`\x1b[${row + 1};1H\x1b[2K${lines[row] ?? ""}`)
  }
  output.push(cursorVisible ? "\x1b[?25h" : "\x1b[?25l")
  output.push(`\x1b[${cursor.line + 1};${cursor.column + 1}H`)
  return output.join("")
}

type Glyphs = { h: string; v: string; tl: string; tr: string; bl: string; br: string; tj: string; bj: string; model: string; select: string }
const unicodeGlyphs: Glyphs = { h: "─", v: "│", tl: "╭", tr: "╮", bl: "╰", br: "╯", tj: "┬", bj: "┴", model: "⬢", select: "❯" }
const asciiGlyphs: Glyphs = { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", tj: "+", bj: "+", model: "*", select: ">" }

function padToWidth(text: string, width: number): string {
  const clipped = clipToWidth(text, width)
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)))
}

/**
 * Render one full frame in the GJC arrangement: transcript (or a welcome/body panel) on top,
 * then status rows, a rule carrying the model badge, the bordered composer, and any list
 * that belongs to the composer (picker, completions, history search) beneath it.
 */
export function renderFrame(input: {
  columns: number
  rows: number
  transcript: readonly string[]
  header?: FrameHeader
  panel?: FramePanel
  composerVisible?: boolean
  composerTitle?: string
  transcriptOffset?: number
  transcriptOlder?: boolean
  transcriptNewer?: boolean
  home?: FrameHome
  status: string | readonly string[]
  draft: string
  cursor: number
  prompt?: string
  color?: boolean
  theme?: Theme
  ascii?: boolean
  notice?: string
}): string {
  const columns = terminalDimension(input.columns)
  const rows = terminalDimension(input.rows)
  const frameLines = Array<string>(rows).fill("")

  if (columns < 80 || rows < 24) {
    frameLines[0] = clipToWidth(input.ascii ? "Terminal too small: resize to at least 80x24" : resizeNotice, columns)
    return makeFrame(frameLines, { line: 0, column: 0 })
  }

  const theme = input.theme ?? resolveTheme()
  const color = input.color === true
  const paint = (text: string, token: SemanticToken): string => color && text ? semanticStyle(text, token, theme, true) : text
  const glyph = input.ascii ? asciiGlyphs : unicodeGlyphs
  const separator = input.ascii ? " | " : " · "
  const horizontal = (width: number): string => glyph.h.repeat(Math.max(0, width))
  const innerWidth = columns - 4

  const bodyPanel = input.panel && input.panel.placement !== "below" ? input.panel : undefined
  const belowPanel = input.panel?.placement === "below" ? input.panel : undefined
  const composerVisible = input.composerVisible !== false && !bodyPanel
  const composer = layoutComposer(
    composerVisible ? input.draft : "",
    composerVisible ? input.prompt ?? "> " : "",
    innerWidth,
    composerVisible ? input.cursor : 0,
  )
  const maxComposer = maximumComposerRows(rows)
  const composerRows = composerVisible ? Math.min(composer.rows.length, maxComposer) : 0
  const composerOverflow = composerVisible && composer.rows.length > maxComposer
  const firstVisibleComposerRow = Math.max(
    0,
    Math.min(composer.cursor.line - composerRows + 1, composer.rows.length - composerRows),
  )
  const belowLimit = Math.max(0, rows - bottomRows(rows, composerRows, 0) - minimumBodyRows)
  const belowLines = belowPanel && composerVisible
    ? belowPanel.lines.flatMap(line => wrapText(line, columns)).slice(0, Math.min(maximumBelowRows, belowLimit))
    : []
  const bottom = bottomRows(rows, composerRows, belowLines.length)
  const bodyRows = Math.max(0, rows - bottom)

  // Body: transcript rows, a welcome box, or a bordered panel.
  const displayRows = bodyPanel ? [] : transcriptDisplayRows(input.transcript, columns, input.ascii)
  const visualTranscriptRows = displayRows.length
  const maximumTranscriptOffset = Math.max(0, visualTranscriptRows - bodyRows)
  const requestedTranscriptOffset = input.transcriptOffset ?? 0
  const transcriptOffset = Number.isFinite(requestedTranscriptOffset)
    ? Math.max(0, Math.min(maximumTranscriptOffset, Math.floor(requestedTranscriptOffset)))
    : 0
  const firstVisibleTranscriptRow = Math.max(0, visualTranscriptRows - bodyRows - transcriptOffset)
  const endVisibleTranscriptRow = Math.min(visualTranscriptRows, firstVisibleTranscriptRow + bodyRows)
  const visible = displayRows.slice(firstVisibleTranscriptRow, endVisibleTranscriptRow)
  const leadingBlank = visible[0]?.role === "blank" ? 1 : 0
  const firstShown = displayRows[firstVisibleTranscriptRow + leadingBlank]
  const continuedSpeaker = firstShown && firstShown.role === "continuation" ? firstShown.speaker : undefined
  visible.slice(leadingBlank).forEach((row, index) => {
    if (row.role === "blank") return
    if (row.semantic === "user") {
      frameLines[index] = paint(padToWidth(`${row.gutter}${row.text}`, columns), "user")
    } else {
      frameLines[index] = `${paint(row.gutter, row.gutterSemantic)}${paint(row.text, row.semantic)}`
    }
  })

  if (bodyPanel) {
    const title = clipToWidth(oneLineText(`${bodyPanel.title}${separator}${bodyPanel.focus} focus`), Math.max(1, columns - 6))
    const contentRows = Math.max(1, bodyRows - panelBorderRows)
    const content = bodyPanel.lines.flatMap(line => wrapText(line, innerWidth)).slice(0, contentRows)
    frameLines[0] = `${paint(`${glyph.tl}${glyph.h} `, "border")}${paint(title, "focus")}${paint(` ${horizontal(columns - 4 - displayWidth(title))}${glyph.tr}`, "border")}`
    content.forEach((line, index) => {
      frameLines[index + 1] = `${paint(`${glyph.v} `, "border")}${padToWidth(line, innerWidth)}${paint(` ${glyph.v}`, "border")}`
    })
    frameLines[content.length + 1] = paint(`${glyph.bl}${horizontal(columns - 2)}${glyph.br}`, "border")
  } else if (input.home && input.transcript.length === 0) {
    const home = input.home
    const split = Math.floor((columns - 3) / 2)
    const leftWidth = split
    const rightWidth = columns - 3 - split
    const left = home.left.map(line => clipToWidth(oneLineText(line), leftWidth))
    const right: Array<{ text: string; token: SemanticToken }> = []
    home.sections.forEach((section, index) => {
      if (index) right.push({ text: horizontal(rightWidth - 2), token: "border" })
      right.push({ text: clipToWidth(oneLineText(section.heading), rightWidth - 2), token: "focus" })
      for (const line of section.lines) {
        for (const wrapped of wrapText(oneLineText(line), rightWidth - 2)) right.push({ text: wrapped, token: "text" })
      }
    })
    const height = Math.min(Math.max(left.length, right.length) + 2, Math.max(0, bodyRows - 2))
    const title = clipToWidth(oneLineText(home.title), Math.max(1, columns - 6))
    frameLines[0] = `${paint(`${glyph.tl}${glyph.h} `, "border")}${paint(title, "accent")}${paint(` ${horizontal(columns - 4 - displayWidth(title))}${glyph.tr}`, "border")}`
    const leftStart = Math.max(0, Math.floor((height - left.length) / 2))
    for (let index = 0; index < height; index += 1) {
      const leftText = left[index - leftStart] ?? ""
      const leftPad = Math.max(0, Math.floor((leftWidth - displayWidth(leftText)) / 2))
      const leftCell = padToWidth(`${" ".repeat(leftPad)}${leftText}`, leftWidth)
      const rightCell = right[index - 1]
      const rightText = rightCell ? padToWidth(` ${rightCell.text}`, rightWidth) : " ".repeat(rightWidth)
      frameLines[index + 1] = `${paint(glyph.v, "border")}${index - leftStart === 0 ? paint(leftCell, "accent") : leftCell}${paint(glyph.v, "border")}${rightCell ? paint(rightText, rightCell.token) : rightText}${paint(glyph.v, "border")}`
    }
    frameLines[height + 1] = paint(`${glyph.bl}${horizontal(split)}${glyph.bj}${horizontal(columns - 3 - split)}${glyph.br}`, "border")
  }

  // Bottom block.
  const statusStart = bodyRows
  const ruleRow = statusStart + statusRows
  const composerTop = ruleRow + 1
  const requestedStatus = (Array.isArray(input.status) ? input.status : [input.status]).filter(value => value !== "")
  const statusValues = requestedStatus.slice(0, statusRows)
  if (input.notice) statusValues.push(input.notice)
  const shownStatus = statusValues.slice(-statusRows)
  shownStatus.forEach((value, index) => {
    frameLines[statusStart + statusRows - shownStatus.length + index] = paint(clipToWidth(oneLineText(value), columns), "muted")
  })

  const scrolled = visualTranscriptRows > bodyRows || input.transcriptOlder || input.transcriptNewer
  let right: string
  if (!bodyPanel && scrolled) {
    const older = firstVisibleTranscriptRow
    const newer = Math.max(0, visualTranscriptRows - endVisibleTranscriptRow)
    const historical = newer > 0 || input.transcriptNewer
    right = [historical ? "History" : "Latest", ...(continuedSpeaker ? [`${continuedSpeaker} continued`] : []),
      `${older}${input.transcriptOlder ? "+" : ""} older`, `${newer}${input.transcriptNewer ? "+" : ""} newer`, "PgUp/PgDn"].join(separator)
  } else {
    const screen = input.header?.screen
    const duplicate = screen === undefined || screen === input.panel?.title || screen === input.composerTitle || screen === "Chat" || screen === "Home"
    right = duplicate ? "LCA" : `LCA${separator}${oneLineText(screen)}`
  }
  const left = clipToWidth(input.header?.selection ? `${glyph.model} ${oneLineText(input.header.selection)}` : `${glyph.model} no model`, Math.floor(columns / 2))
  const rightClipped = clipToWidth(right, Math.max(1, columns - displayWidth(left) - 4))
  const fill = Math.max(1, columns - displayWidth(left) - displayWidth(rightClipped) - 3)
  frameLines[ruleRow] = `${paint(` ${left}`, "accent")}${paint(` ${horizontal(fill)} `, "border")}${paint(rightClipped, "muted")}`

  if (composerVisible) {
    const overflow = composerOverflow
      ? `Draft ${firstVisibleComposerRow + 1}-${firstVisibleComposerRow + composerRows}/${composer.rows.length}${separator}${input.ascii ? "^" : "↑"} ${firstVisibleComposerRow} above${separator}${input.ascii ? "v" : "↓"} ${composer.rows.length - firstVisibleComposerRow - composerRows} below`
      : undefined
    const title = overflow ?? input.composerTitle ?? belowPanel?.title
    const titleText = title ? clipToWidth(oneLineText(title), Math.max(1, columns - 6)) : ""
    frameLines[composerTop] = titleText
      ? `${paint(`${glyph.tl}${glyph.h} `, "border")}${paint(titleText, "focus")}${paint(` ${horizontal(columns - 4 - displayWidth(titleText))}${glyph.tr}`, "border")}`
      : paint(`${glyph.tl}${horizontal(columns - 2)}${glyph.tr}`, "border")
    for (let index = 0; index < composerRows; index += 1) {
      const text = composer.rows[firstVisibleComposerRow + index]?.text ?? ""
      frameLines[composerTop + 1 + index] = `${paint(`${glyph.v} `, "border")}${padToWidth(text, innerWidth)}${paint(` ${glyph.v}`, "border")}`
    }
    frameLines[composerTop + 1 + composerRows] = paint(`${glyph.bl}${horizontal(columns - 2)}${glyph.br}`, "border")
    belowLines.forEach((line, index) => {
      const selected = line.startsWith("> ")
      frameLines[composerTop + composerRows + composerBorderRows + index] = selected
        ? paint(`${glyph.select} ${line.slice(2)}`, "accent")
        : line
    })
  }

  const cursorRow = composerTop + 1 + composer.cursor.line - firstVisibleComposerRow
  return makeFrame(frameLines, composerVisible
    ? {
        line: Math.max(composerTop + 1, Math.min(composerTop + composerRows, cursorRow)),
        column: Math.max(0, Math.min(columns - 1, composer.cursor.column + 2)),
      }
    : { line: rows - 1, column: 0 }, composerVisible)
}
