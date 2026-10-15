import { describe, expect, test } from "bun:test"
import { TuiApp } from "../src/tui/app.ts"

type Internal = { input(event: unknown): void; choice?: { selected: number; windowStart: number } }

describe("captured session chooser", () => {
  test("one candidate remains pending until explicit Enter", async () => {
    const tui = new TuiApp()
    const internal = tui as unknown as Internal
    const result = tui.choose("Sessions", ["session-one"], new AbortController().signal, {
      kind: "generic-list", rows: ["session-one · held"], origin: { mode: "retained-read-only", sessionID: "current" },
    })
    expect(internal.choice?.selected).toBe(0)
    internal.input({ type: "paste", text: "session-one\n" })
    expect(internal.choice?.selected).toBe(0)
    internal.input({ type: "key", key: "enter" })
    expect(await result).toBe(0)
    tui.close()
  })

  test("large candidate paging retains original indices", async () => {
    const tui = new TuiApp()
    const internal = tui as unknown as Internal
    const rows = Array.from({ length: 201 }, (_, index) => `session-${index}`)
    const result = tui.choose("Sessions", rows, new AbortController().signal, {
      kind: "generic-list", rows, origin: { mode: "writable", sessionID: "current", epoch: "epoch" },
    })
    internal.input({ type: "key", key: "pageDown" })
    internal.input({ type: "key", key: "down" })
    const originalIndex = internal.choice?.selected ?? -1
    expect(originalIndex).toBeGreaterThan(1)
    internal.input({ type: "key", key: "enter" })
    expect(await result).toBe(originalIndex)
    tui.close()
  })
})
