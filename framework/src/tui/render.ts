import { MIN_COLUMNS, MIN_ROWS, MIN_SIZE_LABEL } from "./capability.ts"
import { assistantDisplayText } from "../hosts/terminal-text.ts"
import { parseMarkdown, type InlineSpan, type InlineStyle } from "./markdown.ts"
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
 * `below` panels list under the composer (pickers, completions, history search), `above`
 * panels sit between status and composer for HITL choices, and `body` panels replace the
 * transcript and hide the composer.
 */
export type FramePanel = {
  readonly title: string
  readonly focus: string
  readonly lines: readonly string[]
  readonly placement?: "below" | "above" | "body"
  /** Option rows are `label  description`: the description after the first two-space gap is muted. */
  readonly columns?: boolean
  /** Indexes into `lines` painted as the highlighted row / dimmed text. */
  readonly accentLines?: readonly number[]
  readonly mutedLines?: readonly number[]
}

/** `selection` is the authoritative engine/model fact; `screen` names the active surface. */
export type FrameHeader = {
  readonly screen: string
  readonly selection?: string
  /** Workspace context after the model badge, e.g. `⑂ main / ~/repo`. */
  readonly context?: string
}

/** Empty-session welcome box: left column identity, right column titled sections. */
export type FrameHome = {
  readonly title: string
  readonly left: readonly string[]
  readonly sections: ReadonlyArray<{ readonly heading: string; readonly lines: readonly string[] }>
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const whitespace = /^\p{White_Space}+$/u
const resizeNotice = `Terminal too small: resize to at least ${MIN_COLUMNS}×${MIN_ROWS}`
// Bottom block: status rows, a rule, then the bordered composer (top + bottom border).
const statusRows = 2
const ruleRows = 1
const composerBorderRows = 2
const panelBorderRows = 2
const minimumBodyRows = 3
const minimumTranscriptRows = 1
const maximumPanelRows = 12

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

/** A styled run within one physical row; styles map to theme tokens at paint time. */
export type TranscriptSegment = {
  readonly text: string
  readonly styles: readonly SemanticToken[]
}

/**
 * One physical transcript row. Speaker labels (`you`, `otter`, `plan`) and gutter glyphs
 * (`·` notice, `✗` error, tool status) carry provenance without relying on color.
 */
export type TranscriptRow = {
  readonly segments: readonly TranscriptSegment[]
  readonly speaker?: Speaker
  readonly role: "first" | "continuation" | "blank"
  /** Pad to the full width with this style (the user message bar) when color is on. */
  readonly fill?: SemanticToken
}

export function transcriptRowText(row: TranscriptRow): string {
  return row.segments.map(segment => segment.text).join("")
}

type StyledToken = DisplayToken & { styles: readonly SemanticToken[] }

function styledTokens(spans: ReadonlyArray<{ text: string; styles: readonly SemanticToken[] }>): StyledToken[] {
  const tokens: StyledToken[] = []
  for (const span of spans) {
    for (const token of displayTokens(displayGroups(span.text))) tokens.push({ ...token, styles: span.styles })
  }
  return tokens
}

function segmentsOf(tokens: readonly StyledToken[]): TranscriptSegment[] {
  const segments: Array<{ text: string; styles: readonly SemanticToken[] }> = []
  for (const token of tokens) {
    const last = segments[segments.length - 1]
    if (last && last.styles.join(" ") === token.styles.join(" ")) last.text += token.text
    else segments.push({ text: token.text, styles: token.styles })
  }
  return segments
}

/** Word-wrap styled spans; explicit newlines start new rows. Styles never affect widths. */
function wrapSpans(spans: ReadonlyArray<{ text: string; styles: readonly SemanticToken[] }>, columns: number): TranscriptSegment[][] {
  const width = safeColumns(columns)
  const result: TranscriptSegment[][] = []
  let paragraph: StyledToken[] = []
  const layout = (tokens: StyledToken[]): void => {
    const words: Array<{ tokens: StyledToken[]; width: number; whitespace: boolean }> = []
    for (const token of tokens) {
      const last = words[words.length - 1]
      if (last && last.whitespace === token.whitespace) { last.tokens.push(token); last.width += token.width }
      else words.push({ tokens: [token], width: token.width, whitespace: token.whitespace })
    }
    let current: StyledToken[] = []
    let currentWidth = 0
    let emitted = false
    const flush = (trim: boolean): void => {
      let end = current.length
      if (trim) while (end > 0 && current[end - 1]!.whitespace) end -= 1
      if (end > 0 || !emitted) result.push(segmentsOf(current.slice(0, end)))
      emitted = true
      current = []
      currentWidth = 0
    }
    for (const word of words) {
      if (word.width > width && !word.whitespace) {
        if (currentWidth > 0 && currentWidth + word.width > width) flush(true)
        for (const token of word.tokens) {
          if (currentWidth + token.width > width && currentWidth > 0) flush(true)
          current.push(token)
          currentWidth += token.width
        }
        continue
      }
      if (currentWidth + word.width > width && currentWidth > 0) {
        flush(true)
        if (word.whitespace) continue
      }
      current.push(...word.tokens)
      currentWidth += word.width
    }
    if (current.length > 0 || !emitted) flush(false)
  }
  for (const token of styledTokens(spans)) {
    if (token.newline) { layout(paragraph); paragraph = [] }
    else paragraph.push(token)
  }
  layout(paragraph)
  return result
}

/** Break by display width only, preserving every space (code blocks). */
function hardWrap(text: string, styles: readonly SemanticToken[], columns: number): TranscriptSegment[][] {
  const width = safeColumns(columns)
  const rows: TranscriptSegment[][] = []
  let current: StyledToken[] = []
  let used = 0
  for (const token of styledTokens([{ text, styles }])) {
    if (token.newline) continue
    if (used + token.width > width && used > 0) { rows.push(segmentsOf(current)); current = []; used = 0 }
    current.push(token)
    used += token.width
  }
  rows.push(segmentsOf(current))
  return rows
}

const inlineStyleTokens: Record<InlineStyle, SemanticToken> = {
  bold: "focus", italic: "italic", "inline-code": "inline-code", link: "link", muted: "muted",
}

function inlineSegments(spans: readonly InlineSpan[], base: readonly SemanticToken[]): Array<{ text: string; styles: readonly SemanticToken[] }> {
  return spans.map(span => ({ text: span.text, styles: [...base, ...span.styles.map(style => inlineStyleTokens[style])] }))
}

/** Lay out Markdown into rows of `width` display columns. */
function markdownRows(source: string, width: number, ascii: boolean): TranscriptSegment[][] {
  const rows: TranscriptSegment[][] = []
  const blank = (): void => { if (rows.length && rows[rows.length - 1]!.length) rows.push([]) }
  const prefixed = (lines: TranscriptSegment[][], first: TranscriptSegment[], rest: TranscriptSegment[]): void => {
    lines.forEach((line, index) => rows.push([...(index === 0 ? first : rest), ...line]))
  }
  for (const block of parseMarkdown(source)) {
    switch (block.kind) {
      case "blank":
        blank()
        break
      case "paragraph":
        rows.push(...wrapSpans(inlineSegments(block.spans, []), width))
        break
      case "heading": {
        const base: SemanticToken[] = ["heading"]
        const lead = block.level >= 3 ? [{ text: `${"#".repeat(block.level)} `, styles: base }] : []
        rows.push(...wrapSpans([...lead, ...inlineSegments(block.spans, base)], width))
        break
      }
      case "list-item": {
        const indent = " ".repeat(Math.min(8, block.indent))
        const marker = block.ordered ? `${block.marker} ` : `${ascii ? "*" : "•"} `
        const lead = `${indent}${marker}`
        const hang = " ".repeat(displayWidth(lead))
        prefixed(wrapSpans(inlineSegments(block.spans, []), Math.max(1, width - displayWidth(lead))),
          [{ text: indent, styles: [] }, { text: marker, styles: ["bullet"] }], [{ text: hang, styles: [] }])
        break
      }
      case "list-continuation": {
        const hang = " ".repeat(Math.min(10, block.indent))
        prefixed(wrapSpans(inlineSegments(block.spans, []), Math.max(1, width - hang.length)), [{ text: hang, styles: [] }], [{ text: hang, styles: [] }])
        break
      }
      case "quote": {
        const border = { text: `${ascii ? "|" : "▏"} `, styles: ["quote"] as SemanticToken[] }
        prefixed(wrapSpans(inlineSegments(block.spans, ["quote"]), Math.max(1, width - 2)), [border], [border])
        break
      }
      case "code": {
        const diff = block.language === "diff"
        rows.push([{ text: clipToWidth(`\`\`\`${block.language}`, width), styles: ["muted"] }])
        for (const line of block.lines) {
          const styles: SemanticToken[] = diff || /^[+-](?![+-]{2})/u.test(line)
            ? [line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : "code"]
            : ["code"]
          prefixed(hardWrap(line, styles, Math.max(1, width - 2)), [{ text: "  ", styles: [] }], [{ text: "  ", styles: [] }])
        }
        if (block.closed) rows.push([{ text: "```", styles: ["muted"] }])
        break
      }
      case "rule":
        rows.push([{ text: (ascii ? "-" : "─").repeat(Math.min(width, 80)), styles: ["rule"] }])
        break
    }
  }
  while (rows.length && rows[rows.length - 1]!.length === 0) rows.pop()
  return rows
}

type TranscriptEntry =
  | { kind: "text"; speaker: Speaker; lines: string[] }
  | { kind: "tool"; summary: string; details: string[] }
  | { kind: "shell"; ordinal: string; command: string; notes: string[]; output: string[]; footers: string[] }
  | { kind: "plain"; lines: string[] }

const speakerLabel = /^\[(You|Assistant|Error|Notice|Canonical plan)\](?: |$)/u
const toolSummary = /^\[([+-])\] (#\d+ \S+)(.*)$/u
const shellHeader = /^\[Shell\] (\$\d+) \$ (.*)$/u

function transcriptEntries(lines: readonly string[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const line of lines) {
    const current = entries[entries.length - 1]
    const label = speakerLabel.exec(line)
    const shell = shellHeader.exec(line)
    if (shell) {
      entries.push({ kind: "shell", ordinal: shell[1]!, command: shell[2]!, notes: [], output: [], footers: [] })
    } else if (current?.kind === "shell" && line.startsWith("  : ")) {
      current.notes.push(line.slice(4))
    } else if (current?.kind === "shell" && line.startsWith("  | ")) {
      current.output.push(line.slice(4))
    } else if (current?.kind === "shell" && line.startsWith("  = ")) {
      current.footers.push(line.slice(4))
    } else if (label) {
      entries.push({ kind: "text", speaker: label[1] as Speaker, lines: [line.slice(label[0].length)] })
    } else if (line.startsWith("  | ") && current?.kind === "text") {
      current.lines.push(line.slice(4))
    } else if (toolSummary.test(line)) {
      entries.push({ kind: "tool", summary: line, details: [] })
    } else if (/^\s/u.test(line) && current?.kind === "tool") {
      current.details.push(line.trim())
    } else if (/^\s/u.test(line) && current) {
      if (current.kind === "text") current.lines.push(line.replace(/^ {2}\| /u, ""))
      else if (current.kind === "plain") current.lines.push(line.trim())
    } else {
      entries.push({ kind: "plain", lines: [line.replace(/^ {2}\| /u, "")] })
    }
  }
  return entries
}

const speakerStyle: Record<Speaker, { label?: string; labelStyle: SemanticToken[]; glyph?: [string, string]; style: SemanticToken[] }> = {
  You: { label: "you", labelStyle: ["accent"], style: ["user"] },
  Assistant: { label: "otter", labelStyle: ["focus"], style: [] },
  "Canonical plan": { label: "plan", labelStyle: ["warning", "focus"], style: [] },
  Notice: { glyph: ["·", "-"], labelStyle: ["muted"], style: ["muted"] },
  Error: { glyph: ["✗", "x"], labelStyle: ["error"], style: ["error"] },
}

/**
 * Map logical transcript lines to physical rows, GJC style: a blank row between entries,
 * a speaker label above user/assistant/plan messages, Markdown for assistant and plan
 * text, compact glyph rows for notices, errors and tool calls. Rendering and scroll
 * bounds both use this so page arithmetic matches what is drawn.
 */
export function transcriptDisplayRows(lines: readonly string[], columns: number, ascii = false, spinner?: string): TranscriptRow[] {
  const width = safeColumns(columns)
  const body = Math.max(1, width - 2)
  const rows: TranscriptRow[] = []
  const indent: TranscriptSegment = { text: "  ", styles: [] }
  // Consecutive notices, errors or tool calls stay together; any other change of entry is spaced.
  const compactKind = (entry: TranscriptEntry): string | undefined =>
    entry.kind === "tool" ? "tool" : entry.kind === "text" && !speakerStyle[entry.speaker].label ? entry.speaker : undefined
  let previous: string | undefined
  for (const entry of transcriptEntries(lines)) {
    const kind = compactKind(entry)
    if (rows.length && (kind === undefined || kind !== previous)) rows.push({ segments: [], role: "blank" })
    previous = kind
    if (entry.kind === "text") {
      const speaker = entry.speaker
      const style = speakerStyle[speaker]
      const raw = entry.lines.join("\n")
      const text = speaker === "Assistant" ? assistantDisplayText(raw) : raw
      if (style.label) {
        rows.push({ segments: [{ text: style.label, styles: style.labelStyle }], speaker, role: "first" })
        const content = speaker === "You"
          ? wrapSpans([{ text, styles: style.style }], body)
          : markdownRows(text, body, ascii)
        for (const line of content) {
          rows.push({ segments: line.length ? [indent, ...line] : [], speaker, role: "continuation", ...(speaker === "You" ? { fill: "user" as const } : {}) })
        }
      } else {
        const glyph: TranscriptSegment = { text: `${ascii ? style.glyph![1] : style.glyph![0]} `, styles: style.labelStyle }
        wrapSpans([{ text, styles: style.style }], body).forEach((line, index) => {
          rows.push({ segments: [index === 0 ? glyph : indent, ...line], speaker, role: index === 0 ? "first" : "continuation" })
        })
      }
      continue
    }
    if (entry.kind === "shell") {
      rows.push(...shellWindowRows(entry, width, ascii, spinner))
      continue
    }
    if (entry.kind === "tool") {
      const match = toolSummary.exec(entry.summary)!
      const outcome = / · call (?:failed|denied)/u.test(entry.summary) ? "error" : / · call succeeded/u.test(entry.summary) ? "success" : "running"
      // Only a live call animates; a last-recorded/unconfirmed call keeps the static marker.
      const live = outcome === "running" && spinner !== undefined && / · call running · /u.test(entry.summary)
      const icon: TranscriptSegment = outcome === "error"
        ? { text: `${ascii ? "x" : "✘"} `, styles: ["error"] }
        : outcome === "success" ? { text: `${ascii ? "+" : "✔"} `, styles: ["success"] }
          : { text: `${live ? spinner : ascii ? "~" : "⟳"} `, styles: ["warning"] }
      const toggle = match[1] === "+" ? (ascii ? "> " : "▸ ") : (ascii ? "v " : "▾ ")
      // GJC style: `✔ Read path:120-140 · 42ms`, then the call/task facts on a muted line below.
      const [, ordinal, name] = /^#(\d+) (\S+)$/u.exec(match[2]!) ?? [, "", match[2]!]
      const at = match[3]!.indexOf(" · call ")
      const target = at >= 0 ? match[3]!.slice(0, at) : match[3]!
      const facts = at >= 0 ? match[3]!.slice(at + 3) : ""
      const firstSpace = target.startsWith(" ") ? target.slice(1) : target
      const timing = / · (\d+ms|\d+(?:\.\d)?s|\d+m\d{2}s)$/u.exec(firstSpace)
      const where = timing ? firstSpace.slice(0, timing.index) : firstSpace
      const label = name!.charAt(0).toLocaleUpperCase() + name!.slice(1)
      wrapSpans([
        { text: label, styles: ["focus"] },
        ...(where ? [{ text: ` ${where}`, styles: ["text"] as SemanticToken[] }] : []),
        ...(timing ? [{ text: ` · ${timing[1]}`, styles: ["muted"] as SemanticToken[] }] : []),
      ], body).forEach((line, index) => rows.push({ segments: [index === 0 ? icon : indent, ...line], role: index === 0 ? "first" : "continuation" }))
      // The icon already says succeeded/running; failure states keep their wording (call vs. execution evidence).
      const meta = facts.replace(/^call (?:succeeded|running)(?: · |$)/u, "")
      wrapSpans([{ text: toggle, styles: ["muted"] }, { text: `#${ordinal}${meta ? ` · ${meta}` : ""}`, styles: ["muted"] }], body)
        .forEach(line => rows.push({ segments: [indent, ...line], role: "continuation" }))
      for (const detail of entry.details) {
        wrapSpans([{ text: detail, styles: ["muted"] }], Math.max(1, width - 4))
          .forEach(line => rows.push({ segments: [{ text: "    ", styles: [] }, ...line], role: "continuation" }))
      }
      continue
    }
    wrapSpans([{ text: entry.lines.join("\n"), styles: [] }], body)
      .forEach((line, index) => rows.push({ segments: [indent, ...line], role: index === 0 ? "first" : "continuation" }))
  }
  return rows
}

/**
 * A GJC-style Bash card: a titled top border with the outcome icon, the full command (wrapped, `$ ` prefixed), an
 * Output divider, the output tail, and a footer with exit status, duration and (for verify runs) the timeout.
 */
function shellWindowRows(entry: Extract<TranscriptEntry, { kind: "shell" }>, width: number, ascii: boolean, spinner?: string): TranscriptRow[] {
  const box = ascii
    ? { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", lj: "+", rj: "+" }
    : { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘", lj: "├", rj: "┤" }
  const status = entry.footers.at(-1) ?? ""
  const state: { icon: string; style: SemanticToken } = status.startsWith("running")
    ? { icon: spinner ?? (ascii ? "~" : "⟳"), style: "warning" }
    : status.startsWith("exit 0 ") ? { icon: ascii ? "+" : "✔", style: "success" }
      : status.startsWith("cancelled") || status.startsWith("timed out") ? { icon: "!", style: "warning" }
        : { icon: ascii ? "x" : "✘", style: "error" }
  const border: SemanticToken[] = [state.style === "success" ? "border" : state.style]
  const inner = Math.max(1, width - 4)
  // A verify run carries `verify <task> · attempt <n> · timeout <t>` as its first note.
  const verifyNote = entry.notes.find(note => note.startsWith("verify "))
  const verify = verifyNote ? /^verify (\S+) · attempt (\d+)(?: · timeout (\S+))?$/u.exec(verifyNote) : null
  const notes = entry.notes.filter(note => note !== verifyNote)
  const title = verify ? `Verify · ${verify[1]}${verify[2] !== "1" ? ` · attempt ${verify[2]}` : ""}` : "Bash"
  const ruled = (left: string, label: string, right: string, styles: SemanticToken[], labelStyles: SemanticToken[]): TranscriptRow => {
    const lead = `${left}${box.h.repeat(3)} `
    const room = Math.max(0, width - displayWidth(lead) - 2)
    const text = clipToWidth(label, room)
    return { segments: [
      { text: lead, styles },
      { text, styles: labelStyles },
      { text: ` ${box.h.repeat(Math.max(0, width - displayWidth(lead) - displayWidth(text) - 2))}${right}`, styles },
    ], role: "continuation" }
  }
  const row = (content: TranscriptSegment[]): TranscriptRow => {
    const used = content.reduce((total, segment) => total + displayWidth(segment.text), 0)
    return { segments: [{ text: `${box.v} `, styles: border }, ...content, { text: `${" ".repeat(Math.max(0, inner - used))} ${box.v}`, styles: border }], role: "continuation" }
  }
  const rows: TranscriptRow[] = [{ ...ruled(box.tl, `${state.icon} ${title}`, box.tr, border, [state.style, "focus"]), role: "first" }]
  // Wrap at spaces like GJC; a single token longer than the card still hard-wraps.
  for (const wrapped of wrapSpans([{ text: `$ ${entry.command}`, styles: ["focus"] }], inner)) {
    const used = wrapped.reduce((total, segment) => total + displayWidth(segment.text), 0)
    if (used <= inner) rows.push(row(wrapped))
    else for (const piece of hardWrap(wrapped.map(segment => segment.text).join(""), ["focus"], inner)) rows.push(row(piece))
  }
  if (entry.output.length || notes.length) {
    rows.push(ruled(box.lj, "Output", box.rj, border, ["muted"]))
    for (const note of notes) for (const wrapped of wrapSpans([{ text: note, styles: ["muted"] }], inner)) rows.push(row(wrapped))
    for (const line of entry.output) for (const wrapped of hardWrap(line, ["muted"], inner)) rows.push(row(wrapped))
  }
  for (const footer of entry.footers.slice(0, -1)) for (const wrapped of wrapSpans([{ text: footer, styles: ["muted"] }], inner)) rows.push(row(wrapped))
  const limit = verify?.[3] ? ` · timeout ${verify[3]}` : ""
  for (const wrapped of wrapSpans([{ text: ascii ? "[" : "⟦", styles: ["muted"] }, { text: `${status}${limit}`, styles: [state.style] }, { text: ascii ? "]" : "⟧", styles: ["muted"] }], inner)) rows.push(row(wrapped))
  rows.push({ segments: [{ text: `${box.bl}${box.h.repeat(Math.max(0, width - 2))}${box.br}`, styles: border }], role: "continuation" })
  return rows
}

/** Physical rows for one logical line, as plain text. */
export function wrapTranscriptLine(text: string, columns: number, ascii = false): string[] {
  return transcriptDisplayRows([text], columns, ascii).map(transcriptRowText)
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

/** Clip to `columns`, ending in `…` when anything was cut. */
export function ellipsize(value: string, columns: number, ascii = false): string {
  const width = safeColumns(columns)
  const line = oneLineText(value)
  if (displayWidth(line) <= width) return line
  const mark = ascii ? "..." : "…"
  if (width <= displayWidth(mark)) return clipToWidth(line, width)
  return `${clipToWidth(line, width - displayWidth(mark)).trimEnd()}${mark}`
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

function bottomRows(rows: number, composerRows: number, belowRows: number, aboveRows = 0): number {
  return statusRows + ruleRows + (composerRows ? composerBorderRows + composerRows : 0) + belowRows + aboveRows
}

/** Rows a `below` panel may use under the composer while keeping a minimal transcript. */
export function belowPanelRows(input: { columns: number; rows: number; draft: string; cursor: number; prompt?: string }): number {
  const columns = terminalDimension(input.columns)
  const rows = terminalDimension(input.rows)
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) return 0
  const used = bottomRows(rows, composerRowCount({ ...input, columns, rows }), 0)
  return Math.max(1, Math.min(maximumPanelRows, rows - used - minimumBodyRows))
}

/** Content rows available to a bordered HITL panel between status and composer. */
export function abovePanelRows(input: { columns: number; rows: number; draft: string; cursor: number; prompt?: string }): number {
  const columns = terminalDimension(input.columns)
  const rows = terminalDimension(input.rows)
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) return 0
  const composerRows = composerRowCount({ ...input, columns, rows })
  const fixedRows = statusRows + ruleRows + composerBorderRows + composerRows + panelBorderRows + minimumTranscriptRows
  return Math.max(1, Math.min(maximumPanelRows, rows - fixedRows))
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
  aboveRows?: number
}): number {
  const columns = terminalDimension(input.columns)
  const rows = terminalDimension(input.rows)
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) return 0
  const composerRows = input.composerVisible === false ? 0 : composerRowCount({ ...input, columns, rows })
  return Math.max(0, rows - bottomRows(rows, composerRows, Math.max(0, input.belowRows ?? 0), Math.max(0, input.aboveRows ?? 0)))
}

/** Content rows inside a bordered body panel (composer hidden). */
export function bodyPanelRows(input: { columns: number; rows: number }): number {
  return Math.max(1, transcriptViewportRows({ ...input, draft: "", cursor: 0, prompt: "", composerVisible: false }) - panelBorderRows)
}

/** Total physical transcript rows, including entry separators. */
export function transcriptVisualRows(lines: readonly string[], columns: number, ascii = false): number {
  return transcriptDisplayRows(lines, columns, ascii).length
}

/** One retained layout per terminal. Callers must replace the immutable lines when content changes. */
export class TranscriptLayoutCache {
  private cached?: { lines: readonly string[]; columns: number; ascii: boolean; spinner?: string; rows: readonly TranscriptRow[] }

  get(lines: readonly string[], columns: number, ascii = false, spinner?: string): readonly TranscriptRow[] {
    const width = safeColumns(columns)
    const cached = this.cached
    if (cached?.lines === lines && cached.columns === width && cached.ascii === ascii && cached.spinner === spinner) return cached.rows
    const rows = transcriptDisplayRows(lines, width, ascii, spinner)
    this.cached = { lines, columns: width, ascii, spinner, rows }
    return rows
  }
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

type Glyphs = { h: string; v: string; tl: string; tr: string; bl: string; br: string; bj: string; model: string }
const unicodeGlyphs: Glyphs = { h: "─", v: "│", tl: "╭", tr: "╮", bl: "╰", br: "╯", bj: "┴", model: "⬢" }
const asciiGlyphs: Glyphs = { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", bj: "+", model: "*" }

function padToWidth(text: string, width: number): string {
  const clipped = clipToWidth(text, width)
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)))
}

/**
 * Render one full frame in the GJC arrangement: transcript (or a welcome/body panel) on top,
 * then status rows, a rule carrying the model badge, an optional HITL panel, the bordered
 * composer, and any list that belongs to the composer (picker, completions, history search) beneath it.
 */
export function renderFrame(input: {
  columns: number
  rows: number
  transcript: readonly string[]
  /** Reuse semantic transcript layout when only the composer, status, theme or viewport changes. */
  transcriptLayout?: TranscriptLayoutCache
  header?: FrameHeader
  panel?: FramePanel
  composerVisible?: boolean
  composerTitle?: string
  /** Live-work progress shown in the input box's top border when no title claims it. */
  progress?: string
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
  /** Current spinner frame while the host is working; live shell/tool icons animate with it. */
  spinner?: string
  notice?: string
  /** Muted hint shown after the prompt while the draft is empty (color only); never part of the draft. */
  placeholder?: string
  /** Plain physical transcript rows, indexed from the top of the rendered screen. */
  onTranscriptRows?: (rows: readonly string[]) => void
}): string {
  const columns = terminalDimension(input.columns)
  const rows = terminalDimension(input.rows)
  const frameLines = Array<string>(rows).fill("")

  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    input.onTranscriptRows?.([])
    frameLines[0] = clipToWidth(input.ascii ? `Terminal too small: resize to at least ${MIN_SIZE_LABEL}` : resizeNotice, columns)
    return makeFrame(frameLines, { line: 0, column: 0 })
  }

  const theme = input.theme ?? resolveTheme()
  const color = input.color === true
  const paint = (text: string, token: SemanticToken): string => color && text ? semanticStyle(text, token, theme, true) : text
  const glyph = input.ascii ? asciiGlyphs : unicodeGlyphs
  const separator = input.ascii ? " | " : " · "
  const horizontal = (width: number): string => glyph.h.repeat(Math.max(0, width))
  const innerWidth = columns - 4

  const bodyPanel = input.panel && (input.panel.placement === undefined || input.panel.placement === "body") ? input.panel : undefined
  const belowPanel = input.panel?.placement === "below" ? input.panel : undefined
  const abovePanel = input.panel?.placement === "above" ? input.panel : undefined
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
    ? belowPanel.lines.flatMap(line => wrapText(line, columns)).slice(0, Math.min(maximumPanelRows, belowLimit))
    : []
  const aboveCapacity = abovePanel && composerVisible
    ? abovePanelRows({ columns, rows, draft: input.draft, cursor: input.cursor, prompt: input.prompt })
    : 0
  const aboveContent = abovePanel && aboveCapacity > 0
    ? abovePanel.lines.flatMap((line, lineIndex) => wrapText(line, innerWidth).map(text => ({
      text,
      token: abovePanel.accentLines?.includes(lineIndex) ? "accent" as const : abovePanel.mutedLines?.includes(lineIndex) ? "muted" as const : undefined,
    }))).slice(0, aboveCapacity)
    : []
  const abovePanelFrameRows = aboveContent.length > 0 ? aboveContent.length + panelBorderRows : 0
  const bottom = bottomRows(rows, composerRows, belowLines.length, abovePanelFrameRows)
  const bodyRows = Math.max(0, rows - bottom)

  // Body: transcript rows, a welcome box, or a bordered panel.
  const displayRows = bodyPanel ? [] : input.transcriptLayout
    ? input.transcriptLayout.get(input.transcript, columns, input.ascii, input.spinner)
    : transcriptDisplayRows(input.transcript, columns, input.ascii, input.spinner)
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
  input.onTranscriptRows?.(bodyPanel ? [] : visible.slice(leadingBlank).map(transcriptRowText))
  const firstShown = displayRows[firstVisibleTranscriptRow + leadingBlank]
  const continuedSpeaker = firstShown && firstShown.role === "continuation" ? firstShown.speaker : undefined
  const styled = (text: string, styles: readonly SemanticToken[]): string => {
    const codes = styles.filter(style => style !== "text").map(style => theme.sgr[style]).join("")
    return color && text && codes ? `${codes}${text}\x1b[0m` : text
  }
  visible.slice(leadingBlank).forEach((row, index) => {
    if (row.role === "blank") return
    if (row.fill && color) {
      frameLines[index] = paint(padToWidth(transcriptRowText(row), columns), row.fill)
    } else {
      frameLines[index] = row.segments.map(segment => styled(segment.text, segment.styles)).join("")
    }
  })

  if (bodyPanel) {
    const title = clipToWidth(oneLineText(`${bodyPanel.title}${separator}${bodyPanel.focus} focus`), Math.max(1, columns - 6))
    const contentRows = Math.max(1, bodyRows - panelBorderRows)
    const wrappedLines = bodyPanel.lines.flatMap((line, lineIndex) => wrapText(line, innerWidth).map(text => ({
      text,
      token: bodyPanel.accentLines?.includes(lineIndex) ? "accent" as const : bodyPanel.mutedLines?.includes(lineIndex) ? "muted" as const : undefined,
    }))).slice(0, contentRows)
    const content = wrappedLines.map(line => line.text)
    frameLines[0] = `${paint(`${glyph.tl}${glyph.h} `, "border")}${paint(title, "focus")}${paint(` ${horizontal(columns - 5 - displayWidth(title))}${glyph.tr}`, "border")}`
    content.forEach((line, index) => {
      const token = wrappedLines[index]!.token
      const padded = padToWidth(line, innerWidth)
      frameLines[index + 1] = `${paint(`${glyph.v} `, "border")}${token ? paint(padded, token) : padded}${paint(` ${glyph.v}`, "border")}`
    })
    frameLines[content.length + 1] = paint(`${glyph.bl}${horizontal(columns - 2)}${glyph.br}`, "border")
  } else if (input.home && input.transcript.length === 0 && bodyRows >= 6) {
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
    frameLines[0] = `${paint(`${glyph.tl}${glyph.h} `, "border")}${paint(title, "accent")}${paint(` ${horizontal(columns - 5 - displayWidth(title))}${glyph.tr}`, "border")}`
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
  const abovePanelTop = ruleRow + 1
  const composerTop = abovePanelTop + abovePanelFrameRows
  const requestedStatus = (Array.isArray(input.status) ? input.status : [input.status]).filter(value => value !== "")
  const statusValues = requestedStatus.slice(0, statusRows)
  if (input.notice) statusValues.push(input.notice)
  const shownStatus = statusValues.slice(-statusRows)
  shownStatus.forEach((value, index) => {
    frameLines[statusStart + statusRows - shownStatus.length + index] = paint(clipToWidth(oneLineText(value), columns), "muted")
  })

  if (abovePanel && abovePanelFrameRows > 0) {
    const title = clipToWidth(oneLineText(`${abovePanel.title}${separator}${abovePanel.focus} focus`), Math.max(1, columns - 6))
    frameLines[abovePanelTop] = `${paint(`${glyph.tl}${glyph.h} `, "border")}${paint(title, "focus")}${paint(` ${horizontal(columns - 5 - displayWidth(title))}${glyph.tr}`, "border")}`
    aboveContent.forEach((line, index) => {
      const text = padToWidth(line.text, innerWidth)
      frameLines[abovePanelTop + index + 1] = `${paint(`${glyph.v} `, "border")}${line.token ? paint(text, line.token) : text}${paint(` ${glyph.v}`, "border")}`
    })
    const bottomRow = abovePanelTop + abovePanelFrameRows - 1
    frameLines[bottomRow] = paint(`${glyph.bl}${horizontal(columns - 2)}${glyph.br}`, "border")
  }

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
    right = duplicate ? "Otter" : `Otter${separator}${oneLineText(screen)}`
  }
  const badge = input.header?.selection ? `${glyph.model} ${oneLineText(input.header.selection)}` : `${glyph.model} no model`
  const leftBudget = Math.max(12, columns - displayWidth(right) - 5)
  const left = clipToWidth(badge, Math.max(12, Math.min(Math.floor(columns / 2), leftBudget)))
  const contextBudget = leftBudget - displayWidth(left) - 3
  const context = input.header?.context && contextBudget >= 8 ? ` / ${ellipsize(input.header.context, contextBudget, input.ascii)}` : ""
  const leftWidth = displayWidth(left) + displayWidth(context)
  const rightClipped = clipToWidth(right, Math.max(1, columns - leftWidth - 4))
  const fill = Math.max(1, columns - leftWidth - displayWidth(rightClipped) - 3)
  frameLines[ruleRow] = `${paint(` ${left}`, "accent")}${context ? paint(context, "muted") : ""}${paint(` ${horizontal(fill)} `, "border")}${paint(rightClipped, "muted")}`

  if (composerVisible) {
    const overflow = composerOverflow
      ? `Draft ${firstVisibleComposerRow + 1}-${firstVisibleComposerRow + composerRows}/${composer.rows.length}${separator}${input.ascii ? "^" : "↑"} ${firstVisibleComposerRow} above${separator}${input.ascii ? "v" : "↓"} ${composer.rows.length - firstVisibleComposerRow - composerRows} below`
      : undefined
    const title = overflow ?? input.composerTitle ?? belowPanel?.title
    const progress = title === undefined && input.progress ? input.progress : undefined
    const titleText = title ? clipToWidth(oneLineText(title), Math.max(1, columns - 6))
      : progress ? clipToWidth(oneLineText(progress), Math.max(1, columns - 6)) : ""
    frameLines[composerTop] = titleText
      ? `${paint(`${glyph.tl}${glyph.h} `, "border")}${paint(titleText, progress ? "accent" : "focus")}${paint(` ${horizontal(columns - 5 - displayWidth(titleText))}${glyph.tr}`, "border")}`
      : paint(`${glyph.tl}${horizontal(columns - 2)}${glyph.tr}`, "border")
    const promptText = input.prompt ?? "> "
    const placeholderBudget = innerWidth - displayWidth(promptText)
    // Without color a hint is indistinguishable from typed text, so NO_COLOR shows an empty composer instead.
    const placeholder = color && input.placeholder && input.draft === "" && placeholderBudget >= 4
      ? ellipsize(input.placeholder, placeholderBudget, input.ascii) : undefined
    for (let index = 0; index < composerRows; index += 1) {
      const text = composer.rows[firstVisibleComposerRow + index]?.text ?? ""
      const cell = placeholder && index === 0
        ? `${promptText}${paint(placeholder, "muted")}${" ".repeat(Math.max(0, placeholderBudget - displayWidth(placeholder)))}`
        : padToWidth(text, innerWidth)
      frameLines[composerTop + 1 + index] = `${paint(`${glyph.v} `, "border")}${cell}${paint(` ${glyph.v}`, "border")}`
    }
    frameLines[composerTop + 1 + composerRows] = paint(`${glyph.bl}${horizontal(columns - 2)}${glyph.br}`, "border")
    belowLines.forEach((line, index) => {
      const selected = line.startsWith("> ") || line.startsWith("❯ ")
      const option = selected || line.startsWith("  ")
      const split = belowPanel?.columns && option ? /^(. \S+?)( {2,}.*)$/u.exec(line) : null
      frameLines[composerTop + composerRows + composerBorderRows + index] = split
        ? `${selected ? paint(split[1]!, "accent") : split[1]!}${paint(split[2]!, "muted")}`
        : selected ? paint(line, "accent")
          : option ? line : paint(line, "muted")
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
