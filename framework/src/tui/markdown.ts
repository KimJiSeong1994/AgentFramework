/**
 * Minimal Markdown structure for transcript display. It recognizes the blocks and inline
 * marks model replies commonly use and leaves everything else as literal text. Parsing
 * never interprets terminal controls; render.ts sanitizes every grapheme it lays out.
 */

export type InlineStyle = "bold" | "italic" | "inline-code" | "link" | "muted"

export type InlineSpan = {
  readonly text: string
  readonly styles: readonly InlineStyle[]
}

export type MarkdownBlock =
  | { readonly kind: "paragraph"; readonly spans: readonly InlineSpan[] }
  | { readonly kind: "heading"; readonly level: number; readonly spans: readonly InlineSpan[] }
  | { readonly kind: "list-item"; readonly indent: number; readonly marker: string; readonly ordered: boolean; readonly spans: readonly InlineSpan[] }
  | { readonly kind: "list-continuation"; readonly indent: number; readonly spans: readonly InlineSpan[] }
  | { readonly kind: "quote"; readonly spans: readonly InlineSpan[] }
  | { readonly kind: "code"; readonly language: string; readonly lines: readonly string[]; readonly closed: boolean }
  | { readonly kind: "table"; readonly headers: readonly (readonly InlineSpan[])[]; readonly rows: readonly (readonly (readonly InlineSpan[])[])[] }
  | { readonly kind: "rule" }
  | { readonly kind: "blank" }

const fenceOpen = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/u
const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u
const rule = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/u
const quote = /^ {0,3}>\s?(.*)$/u
const listItem = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/u
const wordCharacter = /[\p{L}\p{N}]/u

/** Pipes inside code spans and escaped pipes belong to a cell, not the table structure. */
function tableCells(line: string): string[] | undefined {
  const cells: string[] = []
  let cell = ""
  let separators = 0
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (char === "\\" && (line[index + 1] === "|" || line[index + 1] === "\\")) {
      cell += line[++index]
    } else if (char === "`") {
      let end = index + 1
      while (line[end] === "`") end += 1
      const marker = line.slice(index, end)
      const close = line.indexOf(marker, end)
      if (close >= 0) { cell += line.slice(index, close + marker.length); index = close + marker.length - 1 }
      else { cell += marker; index = end - 1 }
    } else if (char === "|") {
      cells.push(cell.trim()); cell = ""; separators += 1
    } else cell += char
  }
  if (!separators) return undefined
  cells.push(cell.trim())
  if (!cells[0]) cells.shift()
  if (!cells.at(-1)) cells.pop()
  return cells.length ? cells : undefined
}

function isWhitespace(value: string | undefined): boolean {
  return value === undefined || /\s/u.test(value)
}

/** Index of a closing delimiter that is not preceded by whitespace, or -1. */
function findClose(text: string, from: number, delimiter: string): number {
  for (let index = from; index <= text.length - delimiter.length; index += 1) {
    if (!text.startsWith(delimiter, index)) continue
    if (isWhitespace(text[index - 1])) continue
    const after = text[index + delimiter.length]
    // A single delimiter must not be half of a doubled one (`*a**`).
    if (delimiter.length === 1 && after === delimiter) { index += 1; continue }
    if (delimiter[0] === "_" && after !== undefined && wordCharacter.test(after)) continue
    return index
  }
  return -1
}

export function parseInline(text: string, inherited: readonly InlineStyle[] = []): InlineSpan[] {
  const spans: InlineSpan[] = []
  let plain = ""
  const flush = (): void => {
    if (plain) spans.push({ text: plain, styles: inherited })
    plain = ""
  }
  const emit = (value: string, styles: readonly InlineStyle[]): void => {
    flush()
    if (value) spans.push({ text: value, styles })
  }
  let index = 0
  while (index < text.length) {
    const character = text[index]!
    if (character === "`") {
      let run = 1
      while (text[index + run] === "`") run += 1
      const fence = "`".repeat(run)
      const close = text.indexOf(fence, index + run)
      if (close > index + run) {
        emit(text.slice(index + run, close).trim() || text.slice(index + run, close), [...inherited, "inline-code"])
        index = close + run
        continue
      }
      plain += fence
      index += run
      continue
    }
    if (character === "*" || character === "_") {
      const double = text[index + 1] === character
      const delimiter = double ? character.repeat(2) : character
      const opens = !isWhitespace(text[index + delimiter.length]) &&
        (character === "*" || !wordCharacter.test(text[index - 1] ?? ""))
      const close = opens ? findClose(text, index + delimiter.length, delimiter) : -1
      if (close > index + delimiter.length) {
        flush()
        spans.push(...parseInline(text.slice(index + delimiter.length, close), [...inherited, double ? "bold" : "italic"]))
        index = close + delimiter.length
        continue
      }
      plain += delimiter
      index += delimiter.length
      continue
    }
    if (character === "[") {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/u.exec(text.slice(index))
      if (link) {
        flush()
        spans.push(...parseInline(link[1]!, [...inherited, "link"]))
        if (link[2] !== link[1]) spans.push({ text: ` (${link[2]})`, styles: [...inherited, "muted"] })
        index += link[0].length
        continue
      }
    }
    plain += character
    index += 1
  }
  flush()
  return spans
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n")
  const blocks: MarkdownBlock[] = []
  let listContent: number | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const fence = fenceOpen.exec(line)
    if (fence) {
      const marker = fence[1]!
      const body: string[] = []
      let closed = false
      for (index += 1; index < lines.length; index += 1) {
        const candidate = lines[index]!
        if (new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`, "u").test(candidate)) { closed = true; break }
        body.push(candidate)
      }
      blocks.push({ kind: "code", language: fence[2] ?? "", lines: body, closed })
      listContent = undefined
      continue
    }
    if (!line.trim()) {
      blocks.push({ kind: "blank" })
      continue
    }
    const headers = tableCells(line)
    const divider = headers && tableCells(lines[index + 1] ?? "")
    if (headers && divider?.length === headers.length && divider.every(cell => /^:?-{3,}:?$/u.test(cell))) {
      const table: InlineSpan[][][] = []
      index += 1
      while (index + 1 < lines.length) {
        if (fenceOpen.test(lines[index + 1]!)) break
        const cells = tableCells(lines[index + 1]!)
        if (!cells || cells.length !== headers.length) break
        table.push(cells.map(cell => parseInline(cell)))
        index += 1
      }
      blocks.push({ kind: "table", headers: headers.map(cell => parseInline(cell)), rows: table })
      listContent = undefined
      continue
    }
    const headingMatch = heading.exec(line)
    if (headingMatch) {
      blocks.push({ kind: "heading", level: headingMatch[1]!.length, spans: parseInline(headingMatch[2]!) })
      listContent = undefined
      continue
    }
    if (rule.test(line)) {
      blocks.push({ kind: "rule" })
      listContent = undefined
      continue
    }
    const quoteMatch = quote.exec(line)
    if (quoteMatch) {
      blocks.push({ kind: "quote", spans: parseInline(quoteMatch[1]!) })
      listContent = undefined
      continue
    }
    const item = listItem.exec(line)
    if (item) {
      const indent = item[1]!.replace(/\t/gu, "    ").length
      const ordered = /\d/u.test(item[2]!)
      blocks.push({ kind: "list-item", indent, marker: item[2]!, ordered, spans: parseInline(item[3]!) })
      listContent = indent + item[2]!.length + 1
      continue
    }
    const leading = line.length - line.trimStart().length
    if (listContent !== undefined && leading >= Math.min(listContent, 2)) {
      blocks.push({ kind: "list-continuation", indent: listContent, spans: parseInline(line.trim()) })
      continue
    }
    blocks.push({ kind: "paragraph", spans: parseInline(line) })
    listContent = undefined
  }
  return blocks
}
