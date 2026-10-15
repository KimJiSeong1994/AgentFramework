/**
 * Editor contract tests against the pinned GJC input fixtures.
 * Reference commit: 8cd17c0f636d3c541c0c2af184e01709b0e6f2c1.
 */

import { describe, expect, test } from "bun:test"
import fixtureSet from "./fixtures/gjc-keys-8cd17c0.json"
import { Editor } from "../src/tui/editor.ts"
import { KeyDecoder } from "../src/tui/keys.ts"
import type { InputEvent } from "../src/tui/keys.ts"

interface ReferenceFixture {
  id: string
  preconditions?: {
    editorBuffer?: { utf8: string }
    cursor?: { line: number; column: number }
    historyOldestToNewest?: string[]
  }
  events?: Array<{ utf8: string }>
  expected?: {
    editorBuffer?: { utf8: string }
    cursor?: { line: number; column: number }
    statesAfterEachEvent?: Array<{ buffer: string; cursor: { line: number; column: number } }>
    historySearchStatesAfterEachEvent?: Array<{
      text: string
      cursor: { line: number; column: number }
      searchState: { query: string; results: string[]; selected: number } | null
    }>
  }
}

const referenceFixtures = (fixtureSet as unknown as { fixtures: ReferenceFixture[] }).fixtures

function fixture(id: string): ReferenceFixture {
  const found = referenceFixtures.find(candidate => candidate.id === id)
  if (!found) throw new Error(`Missing reference fixture: ${id}`)
  return found
}

function decode(decoder: KeyDecoder, packet: string): InputEvent[] {
  return decoder.feed(packet)
}

function cursorOffset(text: string, position: { line: number; column: number }): number {
  let offset = 0
  for (let line = 0; line < position.line; line += 1) {
    const newline = text.indexOf("\n", offset)
    if (newline < 0) throw new Error(`Cursor line ${position.line} is outside editor text`)
    offset = newline + 1
  }
  return offset + position.column
}

describe("Editor", () => {
  test("submits trimmed text, records only nonempty history, and allows empty Enter", () => {
    const editor = new Editor()
    expect(editor.handle({ type: "key", key: "enter" })).toBe("submit")
    expect(editor.submit()).toBe("")
    expect(editor.history).toEqual([])

    editor.setText("  draft  ")
    expect(editor.handle({ type: "key", key: "enter" })).toBe("submit")
    expect(editor.submit()).toBe("draft")
    expect(editor.text).toBe("")
    expect(editor.history).toEqual(["draft"])
  })

  test("queue keys preserve text until the caller submits; defaults follow platform", () => {
    const mac = new Editor({ platform: "darwin" })
    mac.setText("queued")
    expect(mac.handle({ type: "key", key: "alt+q" })).toBe("queue")
    expect(mac.text).toBe("queued")
    expect(mac.submit()).toBe("queued")

    const linux = new Editor({ platform: "linux" })
    linux.setText("queued")
    expect(linux.handle({ type: "key", key: "alt+enter" })).toBe("queue")
    expect(linux.text).toBe("queued")
    expect(linux.submit()).toBe("queued")

    const macNewline = new Editor({ platform: "darwin" })
    macNewline.setText("a")
    macNewline.cursor = 1
    expect(macNewline.handle({ type: "key", key: "alt+enter" })).toBeUndefined()
    expect(macNewline.text).toBe("a\n")
  })

  test("Ctrl+C clears first and shuts down only when the next press is strictly within 500ms", () => {
    let clock = 1_000
    const editor = new Editor({ now: () => clock })
    editor.setText("draft")
    expect(editor.handle({ type: "key", key: "ctrl+c" })).toBeUndefined()
    expect(editor.text).toBe("")
    clock = 1_499
    expect(editor.handle({ type: "key", key: "ctrl+c" })).toBe("shutdown")

    clock = 2_000
    expect(editor.handle({ type: "key", key: "ctrl+c" })).toBeUndefined()
    editor.setText("again")
    clock = 2_500
    expect(editor.handle({ type: "key", key: "ctrl+c" })).toBeUndefined()
    expect(editor.text).toBe("")
    expect(editor.handle({ type: "key", key: "ctrl+d" })).toBe("shutdown")
  })

  test("inserts newlines for Shift+Enter and Ctrl+J without submitting", () => {
    const editor = new Editor()
    editor.setText("ab")
    editor.cursor = 1
    expect(editor.handle({ type: "key", key: "shift+enter" })).toBeUndefined()
    expect(editor.handle({ type: "key", key: "ctrl+j" })).toBeUndefined()
    expect(editor.text).toBe("a\n\nb")
    expect(editor.cursor).toBe(3)
  })

  test("keeps the cursor on grapheme boundaries and deletes whole graphemes", () => {
    const editor = new Editor()
    editor.setText("a👨‍👩‍👧‍👦b")
    editor.cursor = 3
    expect(editor.cursor).toBe(1)
    editor.handle({ type: "key", key: "right" })
    expect(editor.cursor).toBe("a👨‍👩‍👧‍👦".length)
    editor.handle({ type: "key", key: "backspace" })
    expect(editor.text).toBe("ab")
    expect(editor.cursor).toBe(1)
  })

  test("moves vertically by logical line and preserves the nearest grapheme column", () => {
    const editor = new Editor()
    editor.setText("abcd\nx")
    editor.cursor = 3
    editor.handle({ type: "key", key: "down" })
    expect(editor.cursor).toBe(6)
    editor.handle({ type: "key", key: "up" })
    expect(editor.cursor).toBe(3)
  })

  test("navigates submitted history at empty-editor boundaries and Escape restores the draft", () => {
    const editor = new Editor()
    editor.history.push("older", "newest")
    editor.setText("")
    expect(editor.handle({ type: "key", key: "up" })).toBeUndefined()
    expect(editor.text).toBe("newest")
    expect(editor.cursor).toBe(0)
    editor.handle({ type: "key", key: "up" })
    expect(editor.text).toBe("older")
    editor.handle({ type: "key", key: "up" })
    expect(editor.text).toBe("older")
    expect(editor.handle({ type: "key", key: "escape" })).toBeUndefined()
    expect(editor.text).toBe("")
    expect(editor.handle({ type: "key", key: "escape" })).toBe("cancel")
  })

  test("Ctrl+R opens transient history search and Escape restores the original draft", () => {
    const editor = new Editor()
    editor.history.push("open file", "close window")
    editor.setText("file")
    editor.cursor = 2
    editor.handle({ type: "key", key: "ctrl+r" })
    expect(editor.searchState).toEqual({ query: "", results: ["close window", "open file"], selected: 0 })
    expect(editor.text).toBe("")
    editor.handle({ type: "text", text: "filer" })
    expect(editor.searchState).toEqual({ query: "filer", results: [], selected: 0 })
    editor.handle({ type: "key", key: "backspace" })
    expect(editor.searchState).toEqual({ query: "file", results: ["open file"], selected: 0 })
    editor.handle({ type: "key", key: "escape" })
    expect(editor.text).toBe("file")
    expect(editor.cursor).toBe(2)
    expect(editor.searchState).toBeUndefined()
  })

  test("Ctrl+R search selection inserts on Ctrl+J, while Ctrl+C cancels to the saved draft", () => {
    const selected = new Editor()
    selected.history.push("older", "newest")
    selected.setText("draft")
    expect(selected.handle({ type: "key", key: "ctrl+r" })).toBeUndefined()
    expect(selected.handle({ type: "key", key: "ctrl+j" })).toBeUndefined()
    expect(selected.text).toBe("newest")
    expect(selected.searchState).toBeUndefined()

    const cancelled = new Editor()
    cancelled.history.push("recent")
    cancelled.setText("keep me")
    cancelled.cursor = 4
    cancelled.handle({ type: "key", key: "ctrl+r" })
    cancelled.handle({ type: "text", text: "no match" })
    expect(cancelled.handle({ type: "key", key: "ctrl+c" })).toBeUndefined()
    expect(cancelled.text).toBe("keep me")
    expect(cancelled.cursor).toBe(4)
    expect(cancelled.searchState).toBeUndefined()
  })

  test("Ctrl+R recent and filtered results are bounded to the newest 100 history entries", () => {
    const editor = new Editor()
    editor.history.push(...Array.from({ length: 120 }, (_, index) => `needle entry ${index}`))
    editor.handle({ type: "key", key: "ctrl+r" })
    expect(editor.searchState?.results).toHaveLength(100)
    expect(editor.searchState?.results[0]).toBe("needle entry 119")
    expect(editor.searchState?.results[99]).toBe("needle entry 20")

    editor.handle({ type: "text", text: "needle" })
    expect(editor.searchState?.results).toHaveLength(100)
    expect(editor.searchState?.results[0]).toBe("needle entry 119")
    expect(editor.searchState?.results[99]).toBe("needle entry 20")
  })

  test("completion is insertion only and does not submit", () => {
    const editor = new Editor()
    editor.setText("/mo")
    editor.complete("del")
    expect(editor.text).toBe("/model")
    expect(editor.handle({ type: "key", key: "enter" })).toBe("submit")
  })

  test("normalizes and sanitizes bracketed paste including re-encoded Ctrl+J", () => {
    const editor = new Editor()
    editor.handle({ type: "paste", text: "a\r\nb\t\x01\x1b[106;5u" })
    expect(editor.text).toBe("a\nb    \n")
    expect(editor.cursor).toBe(editor.text.length)
  })

  test("replays the reference Shift+Enter fixture through decoder and editor", () => {
    const reference = fixture("newline.kitty-shift-enter")
    const editor = new Editor()
    editor.setText(reference.preconditions?.editorBuffer?.utf8 ?? "")
    editor.cursor = reference.preconditions?.cursor?.column ?? 0
    const decoder = new KeyDecoder()
    for (const packet of reference.events ?? []) {
      for (const event of decode(decoder, packet.utf8)) editor.handle(event)
    }
    const expectedText = reference.expected?.editorBuffer?.utf8
    const expectedCursor = reference.expected?.cursor
    if (expectedText === undefined || expectedCursor === undefined) throw new Error("Shift+Enter fixture has no expected state")
    expect(editor.text).toBe(expectedText)
    expect(editor.cursor).toBe(cursorOffset(expectedText, expectedCursor))
  })

  test("replays split bracketed paste framing from the reference fixture", () => {
    const reference = fixture("paste.split-start-and-end-markers")
    const editor = new Editor()
    editor.setText(reference.preconditions?.editorBuffer?.utf8 ?? "")
    editor.cursor = reference.preconditions?.cursor?.column ?? 0
    const decoder = new KeyDecoder()
    for (const packet of reference.events ?? []) {
      for (const event of decode(decoder, packet.utf8)) editor.handle(event)
    }
    const expectedText = reference.expected?.editorBuffer?.utf8
    const expectedCursor = reference.expected?.cursor
    if (expectedText === undefined || expectedCursor === undefined) throw new Error("Paste fixture has no expected state")
    expect(editor.text).toBe(expectedText)
    expect(editor.cursor).toBe(cursorOffset(expectedText, expectedCursor))
  })

  test("replays source Up/Down history boundaries and anchor positions", () => {
    const reference = fixture("history.up-down-cursor-anchors-and-bounds")
    const editor = new Editor()
    editor.history.push(...(reference.preconditions?.historyOldestToNewest ?? []))
    const decoder = new KeyDecoder()
    for (const [eventIndex, packet] of (reference.events ?? []).entries()) {
      for (const event of decode(decoder, packet.utf8)) editor.handle(event)
      const expected = reference.expected?.statesAfterEachEvent?.[eventIndex]
      if (expected) {
        expect(editor.text).toBe(expected.buffer)
        expect(editor.cursor).toBe(cursorOffset(expected.buffer, expected.cursor))
      }
    }
  })

  test("replays source Ctrl+R prefix/substring ordering, result navigation, and insertion", () => {
    const reference = fixture("history.ctrl-r-search-prefix-and-substring-results")
    const editor = new Editor()
    const initialText = reference.preconditions?.editorBuffer?.utf8 ?? ""
    editor.history.push(...(reference.preconditions?.historyOldestToNewest ?? []))
    editor.setText(initialText)
    const initialCursor = reference.preconditions?.cursor
    if (initialCursor) editor.cursor = cursorOffset(initialText, initialCursor)
    const decoder = new KeyDecoder()

    for (const [eventIndex, packet] of (reference.events ?? []).entries()) {
      for (const event of decode(decoder, packet.utf8)) {
        const action = editor.handle(event)
        if (eventIndex === (reference.events?.length ?? 0) - 1) expect(action).toBeUndefined()
      }
      const expected = reference.expected?.historySearchStatesAfterEachEvent?.[eventIndex]
      if (expected) {
        expect(editor.text).toBe(expected.text)
        expect(editor.cursor).toBe(cursorOffset(expected.text, expected.cursor))
        expect(editor.searchState ?? null).toEqual(expected.searchState)
      }
    }
  })
})
