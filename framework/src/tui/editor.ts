/**
 * Pure editor input state for the framework TUI.
 *
 * This is an independent port shaped by the GJC reference fixtures at
 * 8cd17c0f636d3c541c0c2af184e01709b0e6f2c1, not a runtime GJC dependency or
 * copied module. Provenance: framework/src/tui/ATTRIBUTION.
 */

import type { InputEvent } from "./keys.ts"

export interface EditorOptions {
  platform?: string
  now?: () => number
}

interface SavedEditorState {
  text: string
  cursor: number
}

export interface EditorSearchState {
  query: string
  results: readonly string[]
  selected: number
}

interface HistorySearch {
  origin: SavedEditorState
  results: string[]
  selected: number
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function normalizeEditorText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x09\x0b-\x1f]/g, "")
    .normalize("NFC")
}

function sanitizePaste(value: string): string {
  const decoded = value.replace(/\x1b\[(\d+);5u/g, (match, code: string) => {
    const codepoint = Number(code)
    if (codepoint >= 97 && codepoint <= 122) return String.fromCharCode(codepoint - 96)
    if (codepoint >= 65 && codepoint <= 90) return String.fromCharCode(codepoint - 64)
    return match
  })
  const normalized = decoded.replace(/\r\n?/g, "\n").normalize("NFC").replace(/\t/g, "    ")
  return normalized
    .split("")
    .filter(character => character === "\n" || character.charCodeAt(0) >= 32)
    .join("")
}

function graphemeBoundaries(value: string): number[] {
  const result = [0]
  for (const segment of GRAPHEME_SEGMENTER.segment(value)) {
    const end = segment.index + segment.segment.length
    if (end > result[result.length - 1]!) result.push(end)
  }
  if (result[result.length - 1] !== value.length) result.push(value.length)
  return result
}

function floorBoundary(value: string, position: number): number {
  const bounded = Math.max(0, Math.min(position, value.length))
  let result = 0
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary > bounded) break
    result = boundary
  }
  return result
}

function floorBoundaryInLine(value: string, position: number): number {
  return floorBoundary(value, position)
}

function lineStart(value: string, position: number): number {
  return position <= 0 ? 0 : value.lastIndexOf("\n", position - 1) + 1
}

function lineEnd(value: string, position: number): number {
  const end = value.indexOf("\n", position)
  return end < 0 ? value.length : end
}

function lineStarts(value: string): number[] {
  const starts = [0]
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") starts.push(index + 1)
  }
  return starts
}

function historyTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 0)
}

/** Consume newest-first submitted inputs without retaining the full durable history. */
export function searchSubmittedHistory(prompts: Iterable<string>, query: string): string[] {
  const trimmed = query.trim()
  const tokens = historyTokens(trimmed)
  if (trimmed && tokens.length === 0) return []
  const prefix: string[] = []
  const substring: string[] = []
  for (const prompt of prompts) {
    const words = historyTokens(prompt)
    if (!trimmed || tokens.every(token => words.some(word => word.startsWith(token)))) {
      prefix.push(prompt)
      if (prefix.length === 100) break
    } else if (substring.length < 100 && tokens.every(token => prompt.toLowerCase().includes(token))) substring.push(prompt)
  }
  return [...prefix, ...substring].slice(0, 100)
}

/**
 * Minimal editor model. App/controller code owns rendering, key-choice UI,
 * completion-list interception, terminal lifecycle, and empty-chat suppression.
 */
export class Editor {
  #text = ""
  #cursor = 0
  #preferredColumn: number | undefined
  #historyIndex = -1
  #historyOrigin: SavedEditorState | undefined
  #historySearch: HistorySearch | undefined
  #lastCtrlC: number | undefined
  readonly #platform: string
  readonly #now: () => number

  /** Submitted entries are kept oldest-to-newest. */
  history: string[] = []
  historySearchSource?: (query: string) => string[]

  constructor(options: EditorOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#now = options.now ?? Date.now
  }

  get text(): string {
    return this.#text
  }

  set text(value: string) {
    this.setText(value)
  }

  /** UTF-16 offset kept on a grapheme boundary. */
  get cursor(): number {
    return this.#cursor
  }

  get searchState(): EditorSearchState | undefined {
    const search = this.#historySearch
    if (!search) return undefined
    return { query: this.#text, results: search.results, selected: search.selected }
  }

  set cursor(value: number) {
    this.#cursor = floorBoundary(this.#text, Number.isFinite(value) ? Math.trunc(value) : 0)
    this.#preferredColumn = undefined
  }

  setText(text: string): void {
    this.#resetHistoryContext()
    const normalized = normalizeEditorText(text)
    this.#setBuffer(normalized, normalized.length)
  }

  /** Insert completed text at the cursor; completion UI and replacement policy remain app-owned. */
  complete(text: string): void {
    this.#resetHistoryContext()
    this.#insert(normalizeEditorText(text))
  }

  /** Return trimmed submitted text, clear the buffer, and append only nonempty history entries. */
  submit(): string {
    const submitted = this.#text.trim()
    this.#setBuffer("", 0)
    this.#resetHistoryContext()
    if (submitted.length > 0) this.history.push(submitted)
    return submitted
  }

  handle(event: InputEvent): "submit" | "cancel" | "shutdown" | "queue" | undefined {
    if (event.type === "text") {
      if (this.#historySearch) {
        this.#insert(normalizeEditorText(event.text).replace(/\n/g, ""))
        this.#updateHistorySearch()
        return undefined
      }
      this.#resetHistoryContext()
      this.#insert(normalizeEditorText(event.text))
      return undefined
    }
    if (event.type === "paste") {
      if (this.#historySearch) {
        this.#insert(sanitizePaste(event.text).replace(/\n/g, ""))
        this.#updateHistorySearch()
        return undefined
      }
      this.#resetHistoryContext()
      this.#insert(sanitizePaste(event.text))
      return undefined
    }

    const pressed = event.key.toLowerCase()
    if (this.#historySearch) {
      this.#handleHistorySearchKey(pressed)
      return undefined
    }
    if (pressed === "escape") {
      if (this.#historyOrigin) {
        this.#restore(this.#historyOrigin)
        this.#resetHistoryContext()
        return undefined
      }
      return "cancel"
    }

    if (pressed === "ctrl+r") {
      this.#openHistorySearch()
      return undefined
    }
    if (this.#historyOrigin && !["up", "down"].includes(pressed)) {
      this.#resetHistoryContext()
    }

    if (pressed === "ctrl+c") {
      const currentTime = this.#now()
      if (this.#lastCtrlC !== undefined && currentTime - this.#lastCtrlC < 500) return "shutdown"
      this.#lastCtrlC = currentTime
      this.#setBuffer("", 0)
      this.#resetHistoryContext()
      return undefined
    }
    if (pressed === "ctrl+d") return "shutdown"

    if (pressed === "enter") return "submit"
    if (pressed === "alt+q" && (this.#platform === "darwin" || this.#platform === "win32")) return "queue"
    if (pressed === "alt+enter" && this.#platform !== "darwin" && this.#platform !== "win32") return "queue"

    if (pressed === "shift+enter" || pressed === "ctrl+j" || pressed === "ctrl+enter" || pressed === "ctrl+shift+enter") {
      this.#insert("\n")
      return undefined
    }
    if (pressed === "alt+enter") {
      this.#insert("\n")
      return undefined
    }
    if (pressed === "backspace") {
      this.#deleteBackward()
      return undefined
    }
    if (pressed === "delete") {
      this.#deleteForward()
      return undefined
    }
    if (pressed === "left") {
      this.#moveHorizontal(-1)
      return undefined
    }
    if (pressed === "right") {
      this.#moveHorizontal(1)
      return undefined
    }
    if (pressed === "up") {
      this.#moveVertical(-1)
      return undefined
    }
    if (pressed === "down") {
      this.#moveVertical(1)
      return undefined
    }
    if (pressed === "home" || pressed === "ctrl+a") {
      this.cursor = lineStart(this.#text, this.#cursor)
      return undefined
    }
    if (pressed === "end" || pressed === "ctrl+e") {
      this.cursor = lineEnd(this.#text, this.#cursor)
      return undefined
    }
    if (pressed === "space" || pressed === "shift+space") {
      this.#insert(" ")
      return undefined
    }
    return undefined
  }

  #setBuffer(value: string, cursor: number): void {
    this.#text = value
    this.#cursor = floorBoundary(value, cursor)
    this.#preferredColumn = undefined
  }

  #insert(value: string): void {
    if (value.length === 0) return
    const before = this.#text.slice(0, this.#cursor)
    const after = this.#text.slice(this.#cursor)
    const prefix = (before + value).normalize("NFC")
    const updated = (prefix + after).normalize("NFC")
    this.#setBuffer(updated, prefix.length)
  }

  #deleteBackward(): void {
    const boundaries = graphemeBoundaries(this.#text)
    let previous = 0
    for (const boundary of boundaries) {
      if (boundary >= this.#cursor) break
      previous = boundary
    }
    if (previous === this.#cursor) return
    const updated = this.#text.slice(0, previous) + this.#text.slice(this.#cursor)
    this.#setBuffer(updated.normalize("NFC"), previous)
  }

  #deleteForward(): void {
    const next = graphemeBoundaries(this.#text).find(boundary => boundary > this.#cursor)
    if (next === undefined) return
    const updated = this.#text.slice(0, this.#cursor) + this.#text.slice(next)
    this.#setBuffer(updated.normalize("NFC"), this.#cursor)
  }

  #moveHorizontal(direction: -1 | 1): void {
    const boundaries = graphemeBoundaries(this.#text)
    if (direction < 0) {
      for (let index = boundaries.length - 1; index >= 0; index -= 1) {
        if (boundaries[index]! < this.#cursor) {
          this.cursor = boundaries[index]!
          return
        }
      }
      return
    }
    const next = boundaries.find(boundary => boundary > this.#cursor)
    if (next !== undefined) this.cursor = next
  }

  #moveVertical(direction: -1 | 1): void {
    const starts = lineStarts(this.#text)
    const start = lineStart(this.#text, this.#cursor)
    const lineIndex = starts.indexOf(start)
    const currentEnd = lineEnd(this.#text, this.#cursor)
    const currentColumn = this.#cursor - start
    const preferredColumn = this.#preferredColumn ?? currentColumn
    const atFirstLine = lineIndex <= 0
    const atLastLine = lineIndex >= starts.length - 1

    if (direction < 0 && atFirstLine && this.#text.length === 0) {
      this.#navigateHistory(-1)
      return
    }
    if (direction < 0 && atFirstLine && this.#historyIndex >= 0 && this.#historyOrigin) {
      this.#navigateHistory(-1)
      return
    }
    if (direction > 0 && atLastLine && this.#historyIndex >= 0 && this.#historyOrigin) {
      this.#navigateHistory(1)
      return
    }
    if (direction < 0 && atFirstLine) {
      this.cursor = start
      return
    }
    if (direction > 0 && atLastLine) {
      this.cursor = currentEnd
      return
    }

    const targetStart = starts[lineIndex + direction]
    if (targetStart === undefined) return
    const targetEnd = lineEnd(this.#text, targetStart)
    const targetText = this.#text.slice(targetStart, targetEnd)
    const targetColumn = Math.min(preferredColumn, targetText.length)
    const targetCursor = targetStart + floorBoundaryInLine(targetText, targetColumn)
    this.cursor = targetCursor
    this.#preferredColumn = targetCursor - targetStart < preferredColumn ? preferredColumn : undefined
  }

  #navigateHistory(direction: -1 | 1): void {
    if (this.history.length === 0) return
    if (this.#historyIndex < 0) {
      if (direction > 0) return
      this.#historyOrigin = { text: this.#text, cursor: this.#cursor }
      this.#historyIndex = this.history.length - 1
      this.#showHistory(this.#historyIndex, "start")
      return
    }

    const nextIndex = this.#historyIndex + direction
    if (nextIndex < 0) return
    if (nextIndex >= this.history.length) {
      const origin = this.#historyOrigin
      this.#resetHistoryContext()
      if (origin) this.#restore(origin)
      return
    }
    this.#historyIndex = nextIndex
    this.#showHistory(nextIndex, direction < 0 ? "start" : "end")
  }

  #showHistory(index: number, anchor: "start" | "end"): void {
    const value = normalizeEditorText(this.history[index] ?? "")
    this.#setBuffer(value, anchor === "start" ? 0 : value.length)
  }

  #openHistorySearch(): void {
    const origin = { text: this.#text, cursor: this.#cursor }
    this.#resetHistoryContext()
    this.#setBuffer("", 0)
    this.#historySearch = { origin, results: [], selected: 0 }
    this.#updateHistorySearch()
  }

  #handleHistorySearchKey(pressed: string): void {
    const search = this.#historySearch
    if (!search) return

    if (pressed === "escape" || pressed === "ctrl+c") {
      this.#restore(search.origin)
      this.#resetHistoryContext()
      return
    }
    if (pressed === "enter" || pressed === "ctrl+j") {
      const selected = search.results[search.selected]
      if (selected !== undefined) {
        const prompt = normalizeEditorText(selected)
        this.#setBuffer(prompt, prompt.length)
        this.#resetHistoryContext()
      }
      return
    }
    if (pressed === "up") {
      search.selected = Math.max(0, search.selected - 1)
      return
    }
    if (pressed === "down") {
      search.selected = Math.min(search.results.length - 1, search.selected + 1)
      if (search.results.length === 0) search.selected = 0
      return
    }
    if (pressed === "ctrl+r") return

    if (pressed === "backspace") this.#deleteBackward()
    else if (pressed === "delete" || pressed === "ctrl+d") this.#deleteForward()
    else if (pressed === "left") this.#moveHorizontal(-1)
    else if (pressed === "right") this.#moveHorizontal(1)
    else if (pressed === "home" || pressed === "ctrl+a") this.cursor = 0
    else if (pressed === "end" || pressed === "ctrl+e") this.cursor = this.#text.length
    else if (pressed === "space" || pressed === "shift+space") this.#insert(" ")

    this.#updateHistorySearch()
  }

  #updateHistorySearch(): void {
    const search = this.#historySearch
    if (!search) return

    const query = this.#text.trim()
    search.results = this.historySearchSource?.(query) ?? searchSubmittedHistory([...this.history].reverse(), query)
    search.selected = 0
  }

  #restore(saved: SavedEditorState): void {
    this.#setBuffer(saved.text, saved.cursor)
  }

  #resetHistoryContext(): void {
    this.#historyIndex = -1
    this.#historyOrigin = undefined
    this.#historySearch = undefined
  }
}
