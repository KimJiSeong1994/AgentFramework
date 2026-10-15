/**
 * KeyDecoder contract tests against the pinned GJC input fixtures.
 * Reference commit: 8cd17c0f636d3c541c0c2af184e01709b0e6f2c1.
 */

import { describe, expect, test } from "bun:test"
import fixtureSet from "./fixtures/gjc-keys-8cd17c0.json"
import { KeyDecoder } from "../src/tui/keys.ts"
import type { InputEvent } from "../src/tui/keys.ts"

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
})
