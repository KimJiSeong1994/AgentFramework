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

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const whitespace = /^\p{White_Space}+$/u
const resizeNotice = "Terminal too small: resize to at least 80×24"

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

function clipToWidth(value: string, columns: number): string {
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

function transcriptRowsFor(rows: number, composerLineCount: number, statusRows = 1): number {
  const maxComposerRows = Math.max(1, Math.floor(rows / 3))
  const composerRows = Math.min(composerLineCount, maxComposerRows)
  return rows - composerRows - Math.max(1, Math.min(2, statusRows))
}

export function transcriptViewportRows(input: {
  columns: number
  rows: number
  draft: string
  cursor: number
  prompt?: string
  statusRows?: number
}): number {
  const columns = terminalDimension(input.columns)
  const rows = terminalDimension(input.rows)
  if (columns < 80 || rows < 24) return 0
  const composer = layoutComposer(input.draft, input.prompt ?? "> ", columns, input.cursor)
  return transcriptRowsFor(rows, composer.rows.length, input.statusRows)
}

function makeFrame(lines: readonly string[], cursor: CursorPosition): string {
  const output: string[] = []
  for (let row = 0; row < lines.length; row += 1) {
    output.push(`\x1b[${row + 1};1H\x1b[2K${lines[row] ?? ""}`)
  }
  output.push(`\x1b[${cursor.line + 1};${cursor.column + 1}H`)
  return output.join("")
}

export function renderFrame(input: {
  columns: number
  rows: number
  transcript: readonly string[]
  transcriptOffset?: number
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

  const composer = layoutComposer(input.draft, input.prompt ?? "> ", columns, input.cursor)
  const maxComposerRows = Math.max(1, Math.floor(rows / 3))
  const composerRows = Math.min(composer.rows.length, maxComposerRows)
  const requestedStatus = Array.isArray(input.status) ? input.status : [input.status]
  const statusRows = Math.max(1, Math.min(2, requestedStatus.length))
  const transcriptRows = transcriptRowsFor(rows, composer.rows.length, statusRows)
  const composerStart = transcriptRows + statusRows
  const firstVisibleComposerRow = Math.max(
    0,
    Math.min(composer.cursor.line - composerRows + 1, composer.rows.length - composerRows),
  )

  let visualTranscriptRows = 0
  for (const entry of input.transcript) visualTranscriptRows += wrapText(entry, columns).length
  const maximumTranscriptOffset = Math.max(0, visualTranscriptRows - transcriptRows)
  const requestedTranscriptOffset = input.transcriptOffset ?? 0
  const transcriptOffset = Number.isFinite(requestedTranscriptOffset)
    ? Math.max(0, Math.min(maximumTranscriptOffset, Math.floor(requestedTranscriptOffset)))
    : 0
  const firstVisibleTranscriptRow = Math.max(0, visualTranscriptRows - transcriptRows - transcriptOffset)
  const endVisibleTranscriptRow = firstVisibleTranscriptRow + transcriptRows
  const transcriptLines: string[] = []
  let visualRowIndex = 0
  for (const entry of input.transcript) {
    const semantic: SemanticToken = entry.startsWith("[Error]") ? "error" :
      entry.includes("[+] ") ? "diff-add" :
      entry.includes("[-] ") ? "diff-remove" :
      entry.includes("[code] ") ? "code" :
      entry.startsWith("[Assistant]") ? "notice" :
      entry.startsWith("[Notice]") ? "muted" : "text"
    const wrapped = wrapText(entry, columns).map(line => input.color === true
      ? wrapAnsiText(semanticStyle(line, semantic, input.theme ?? resolveTheme(), true), columns)[0] ?? line
      : line)
    const firstEntryRow = Math.max(0, firstVisibleTranscriptRow - visualRowIndex)
    const endEntryRow = Math.min(wrapped.length, endVisibleTranscriptRow - visualRowIndex)
    if (endEntryRow > firstEntryRow) transcriptLines.push(...wrapped.slice(firstEntryRow, endEntryRow))
    visualRowIndex += wrapped.length
    if (visualRowIndex >= endVisibleTranscriptRow) break
  }
  const transcriptStart = transcriptRows - transcriptLines.length
  for (let index = 0; index < transcriptLines.length; index += 1) {
    frameLines[transcriptStart + index] = transcriptLines[index]!
  }

  const statusValues = requestedStatus.length ? requestedStatus.slice(0, statusRows) : [""]
  if (input.notice) statusValues[0] = `${statusValues[0] ?? ""} | ${input.notice}`
  for (let index = 0; index < statusRows; index += 1) {
    const safeStatus = clipToWidth(oneLineText(statusValues[index] ?? ""), columns)
    if (input.color === true && safeStatus) {
      const styledStatus = wrapAnsiText(semanticStyle(safeStatus, "notice", input.theme ?? resolveTheme(), true), columns)[0] ?? ""
      frameLines[transcriptRows + index] = displayAnsiWidth(styledStatus) <= columns ? styledStatus : safeStatus
    } else {
      frameLines[transcriptRows + index] = safeStatus
    }
  }

  for (let index = 0; index < composerRows; index += 1) {
    const sourceRow = firstVisibleComposerRow + index
    let text = composer.rows[sourceRow]?.text ?? ""
    const up = input.ascii ? "^" : "↑"
    const down = input.ascii ? "v" : "↓"
    const separator = input.ascii ? " | " : " · "
    if (index === 0 && firstVisibleComposerRow > 0) text = clipToWidth(`${up} ${firstVisibleComposerRow} hidden${separator}${text}`, columns)
    if (index === composerRows - 1 && sourceRow + 1 < composer.rows.length) {
      text = clipToWidth(`${text}${separator}${down} ${composer.rows.length - sourceRow - 1} hidden`, columns)
    }
    frameLines[composerStart + index] = text
  }

  const cursorRow = composerStart + composer.cursor.line - firstVisibleComposerRow
  const cursorPrefix = composer.cursor.line === firstVisibleComposerRow && firstVisibleComposerRow > 0
    ? displayWidth(`${input.ascii ? "^" : "↑"} ${firstVisibleComposerRow} hidden${input.ascii ? " | " : " · "}`)
    : 0
  return makeFrame(frameLines, {
    line: Math.max(composerStart, Math.min(rows - 1, cursorRow)),
    column: Math.max(0, Math.min(columns - 1, composer.cursor.column + cursorPrefix)),
  })
}
