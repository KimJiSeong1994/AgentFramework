import { describe, expect, test } from "bun:test"
import { tuiCapability, type TerminalCapabilities } from "../src/tui/capability.ts"

const base: TerminalCapabilities = {
  stdinTTY: true,
  stdoutTTY: true,
  stderrTTY: true,
  term: "xterm-256color",
  columns: 60,
  rows: 20,
  rawSupported: true,
}

describe("TUI capability", () => {
  test("enables only when all terminal requirements are met", () => {
    expect(tuiCapability(base)).toEqual({ enabled: true })
    expect(tuiCapability({ ...base, columns: 59 }).enabled).toBe(false)
    expect(tuiCapability({ ...base, rows: 19 }).enabled).toBe(false)
    expect(tuiCapability({ ...base, columns: 70, rows: 58 })).toEqual({ enabled: true })
    expect(tuiCapability({ ...base, stdinTTY: false }).enabled).toBe(false)
    expect(tuiCapability({ ...base, stdoutTTY: false }).enabled).toBe(false)
    expect(tuiCapability({ ...base, stderrTTY: false }).enabled).toBe(false)
    expect(tuiCapability({ ...base, rawSupported: false }).enabled).toBe(false)
    expect(tuiCapability({ ...base, term: "" }).enabled).toBe(false)
    expect(tuiCapability({ ...base, term: "dumb" }).enabled).toBe(false)
    expect(tuiCapability({ ...base, term: "DUMB" }).enabled).toBe(false)
    expect(tuiCapability({ ...base, columns: Number.NaN }).enabled).toBe(false)
    expect(tuiCapability({ ...base, rows: Number.POSITIVE_INFINITY }).enabled).toBe(false)
  })

  test("explicit OTTER_TUI=0 opt-out wins and reasons are bounded plain text", () => {
    const result = tuiCapability({ ...base, optOut: "0" })
    expect(result).toEqual({ enabled: false, reason: "disabled by OTTER_TUI=0" })
    expect(result.reason).toBeDefined()
    expect(result.reason!.length).toBeLessThanOrEqual(80)
    expect(result.reason).not.toMatch(/[\u001b-\u001f\u007f-\u009f]/)
  })

  test("NO_COLOR does not disable terminal capability", () => {
    const withNoColor = { ...base, NO_COLOR: "" }
    expect(tuiCapability(withNoColor)).toEqual({ enabled: true })
  })
})
