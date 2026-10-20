/**
 * KeyDecoder contract tests against the pinned GJC input fixtures.
 * Reference commit: 8cd17c0f636d3c541c0c2af184e01709b0e6f2c1.
 */

import { describe, expect, test } from "bun:test"
import fixtureSet from "./fixtures/gjc-keys-8cd17c0.json"
import { KeyDecoder } from "../src/tui/keys.ts"
import type { InputEvent } from "../src/tui/keys.ts"
import { Editor } from "../src/tui/editor.ts"

interface ReferenceFixture {
  id: string
  events?: Array<{ utf8: string }>
  expected?: {
    actionsAfterEachEvent?: string[]
    counts?: Record<string, number>
  }
}

const referenceFixtures = (fixtureSet as unknown as { fixtures: ReferenceFixture[] }).fixtures

function fixture(id: string): ReferenceFixture {
  const found = referenceFixtures.find(candidate => candidate.id === id)
  if (!found) throw new Error(`Missing reference fixture: ${id}`)
  return found
}

describe("KeyDecoder", () => {
  test("keeps legacy Ctrl+J distinct from carriage-return submission", () => {
    const decoder = new KeyDecoder()
    expect(decoder.feed("\n\r")).toEqual([
      { type: "key", key: "ctrl+j" },
      { type: "key", key: "enter" },
    ])
  })

  test("decodes ordinary text and fragmented CSI packets", () => {
    const decoder = new KeyDecoder()
    expect(decoder.feed("hello ")).toEqual([{ type: "text", text: "hello " }])
    expect(decoder.feed("\x1b[")).toEqual([])
    expect(decoder.flushEscape()).toEqual([])
    expect(decoder.isPastePending()).toBe(true)
    expect(decoder.feed("A")).toEqual([{ type: "key", key: "up" }])
    expect(decoder.isPastePending()).toBe(false)
  })

  test("flushes only a standalone Escape and leaves partial CSI intact", () => {
    const decoder = new KeyDecoder()
    expect(decoder.feed("\x1b")).toEqual([])
    expect(decoder.flushEscape()).toEqual([{ type: "key", key: "escape" }])
    expect(decoder.feed("\x1b[1;5")).toEqual([])
    expect(decoder.flushEscape()).toEqual([])
    expect(decoder.feed("A")).toEqual([{ type: "key", key: "ctrl+up" }])
  })

  test("decodes Kitty, modifyOtherKeys, lock masks, repeats, and drops releases", () => {
    const decoder = new KeyDecoder()
    expect(decoder.feed("\x1b[13;66u")).toEqual([{ type: "key", key: "shift+enter" }])
    expect(decoder.feed("\x1b[106;5u")).toEqual([{ type: "key", key: "ctrl+j" }])
    expect(decoder.feed("\x1b[27;5;106~")).toEqual([{ type: "key", key: "ctrl+j" }])
    expect(decoder.feed("\x1b[97;5:2u")).toEqual([{ type: "key", key: "ctrl+a" }])
    expect(decoder.feed("\x1b[97;5:3u")).toEqual([])
  })

  test("maps legacy Escape aliases and navigation keys", () => {
    const decoder = new KeyDecoder()
    expect(decoder.feed("\x1b\r\x1bq\x1b[13;2~\x1b[B")).toEqual([
      { type: "key", key: "alt+enter" },
      { type: "key", key: "alt+q" },
      { type: "key", key: "shift+enter" },
      { type: "key", key: "down" },
    ])
  })

  test("keeps split bracketed paste atomic and reports pending frames", () => {
    const decoder = new KeyDecoder()
    expect(decoder.feed("\r\x1b[200")).toEqual([{ type: "key", key: "enter" }])
    expect(decoder.isPastePending()).toBe(true)
    expect(decoder.feed("~a\n\x03\x1b[20")).toEqual([])
    expect(decoder.isPastePending()).toBe(true)
    expect(decoder.feed("1~z")).toEqual([
      { type: "paste", text: "a\n\x03" },
      { type: "text", text: "z" },
    ])
    expect(decoder.isPastePending()).toBe(false)
  })

  test("reset clears incomplete keys and paste state", () => {
    const decoder = new KeyDecoder()
    decoder.feed("\x1b[200~partial")
    expect(decoder.isPastePending()).toBe(true)
    decoder.reset()
    expect(decoder.isPastePending()).toBe(false)
    expect(decoder.flushEscape()).toEqual([])
    expect(decoder.feed("x")).toEqual([{ type: "text", text: "x" }])
  })

  test("replays the reference Kitty Backspace press/repeat/release packet", () => {
    const reference = fixture("kitty.press-repeat-release-backspace")
    const decoder = new KeyDecoder()
    const events: InputEvent[] = []
    for (const packet of reference.events ?? []) events.push(...decoder.feed(packet.utf8))
    expect(events).toEqual([
      { type: "key", key: "backspace" },
      { type: "key", key: "backspace" },
    ])
    expect(reference.expected?.counts?.ignoredReleaseEvents).toBe(1)
  })
  test("SGR mouse wheel notches retain modified wheels and ignore unsupported buttons", () => {
    const decoder = new KeyDecoder()
    expect(decoder.feed("\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<68;1;1M")).toEqual([
      { type: "key", key: "wheelUp" },
      { type: "key", key: "wheelDown" },
      { type: "key", key: "wheelUp" },
    ])
    expect(decoder.feed("\x1b[<1;3;4M\x1b[<2;3;4m\x1b[<35;3;4M\x1b[<66;1;1M\x1b[<4;1;1M\x1b[<36;1;1M")).toEqual([])
    expect(decoder.feed("\x1b[<65;1")).toEqual([])
    expect(decoder.feed(";1Mx")).toEqual([{ type: "key", key: "wheelDown" }, { type: "text", text: "x" }])
  })

  test("fragmented left-button drag packets retain 1-based coordinates", () => {
    const decoder = new KeyDecoder()
    const sequence = "\x1b[<0;3;4M\x1b[<32;12;5M\x1b[<0;12;5m"
    const events = [...sequence].flatMap(character => decoder.feed(character))
    expect(events).toEqual([
      { type: "mouse", action: "down", x: 3, y: 4 },
      { type: "mouse", action: "move", x: 12, y: 5 },
      { type: "mouse", action: "up", x: 12, y: 5 },
    ])
    const editor = new Editor()
    editor.handle({ type: "text", text: "draft" })
    for (const event of events) expect(editor.handle(event)).toBeUndefined()
    expect(editor.text).toBe("draft")
  })

  test("rejects malformed SGR packets and unsafe coordinates without generating keys", () => {
    const decoder = new KeyDecoder()
    for (const packet of [
      "<0;0;1M", "<0;1;0M", "<0;-1;1M", "<0;1.5;1M", "<0;;1M", "<0;1M", "<0;1;1;2M",
      "<0;9007199254740992;1M", "<0;1;9007199254740992M", "<4294967360;1;1M",
      "<64;0;1M", "<64;1M", "<64;1;1m", "<96;1;1M", "<32;1;1m", "<0;1;1Z",
    ]) expect(decoder.feed(`\x1b[${packet}`)).toEqual([])
    expect(decoder.feed("ok")).toEqual([{ type: "text", text: "ok" }])
  })
})
