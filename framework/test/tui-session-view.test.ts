import { describe, expect, test } from "bun:test"
import { TuiApp } from "../src/tui/app.ts"

type Internal = { input(event: unknown): void; choice?: { selected: number; windowStart: number } }

describe("captured session chooser", () => {
  test("one candidate remains pending until explicit Enter", async () => {
    const tui = new TuiApp()
    tui.resume = () => {}
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

  // Regression: the `otter --resume` session picker is the first interaction. If choose/ask do not take the terminal,
  // stdin is never read, the event loop drains and otter exits 0 before anything is drawn.
  test("a chooser or ask that is the first interaction takes the terminal", async () => {
    for (const open of [
      (tui: TuiApp, signal: AbortSignal) => tui.choose("Previous sessions", ["session-one", "Start a new conversation"], signal),
      (tui: TuiApp, signal: AbortSignal) => tui.ask({ question: "Pick", options: [{ label: "a" }] } as Parameters<TuiApp["ask"]>[0], signal),
    ]) {
      const tui = new TuiApp()
      const driver = (tui as unknown as { driver: { start(): void; stop(): void; write(frame: string): void } }).driver
      let starts = 0
      driver.start = () => { starts++ }
      driver.stop = () => {}
      driver.write = () => {}
      const controller = new AbortController()
      const result = open(tui, controller.signal)
      expect(starts).toBe(1)
      controller.abort()
      expect(await result).toBeUndefined()
      tui.close()
    }
  })

  test("large candidate paging retains original indices", async () => {
    const tui = new TuiApp()
    tui.resume = () => {}
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
