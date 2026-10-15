import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { ReadStream, WriteStream } from "node:tty"
import { TerminalDriver } from "../src/tui/terminal.ts"
import type { InputEvent } from "../src/tui/keys.ts"

function terminal() {
  const input = Object.assign(new EventEmitter(), {
    isRaw: false, buffered: [] as Buffer[], raw: [] as boolean[],
    setRawMode(value: boolean) { this.isRaw = value; this.raw.push(value); return this },
    resume() { return this }, pause() { return this },
    read() { return this.buffered.shift() ?? null },
  })
  const output = Object.assign(new EventEmitter(), {
    frames: [] as string[],
    write(text: string, callback?: () => void) { this.frames.push(text); callback?.(); return true },
  })
  const events: InputEvent[] = []
  let disconnected = 0
  const driver = new TerminalDriver(event => events.push(event), () => {}, () => disconnected++, input as unknown as ReadStream, output as unknown as WriteStream)
  return { input, output, events, driver, disconnected: () => disconnected }
}

describe("exclusive raw terminal lifecycle", () => {
  test("one reader restores modes and invalidates buffered raw input on handoff", () => {
    const t = terminal()
    t.driver.start(); t.driver.start()
    expect(t.input.listenerCount("data")).toBe(1)
    t.input.emit("data", Buffer.from("hello"))
    expect(t.events.some(event => event.type === "text" && event.text.includes("h"))).toBe(true)
    t.input.buffered.push(Buffer.from("APPROVE stale pasted input\r"))
    t.driver.handoff()
    expect(t.input.listenerCount("data")).toBe(0)
    expect(t.input.isRaw).toBe(false)
    expect(t.input.buffered).toHaveLength(0)
    const count = t.events.length
    t.input.emit("data", Buffer.from("\r"))
    expect(t.events).toHaveLength(count)
    expect(t.output.frames.at(-1)).toContain("\x1b[?2004l")
    expect(t.output.frames.at(-1)).toContain("\x1b[<u")
    expect(t.output.frames.at(-1)).toContain("\x1b[?25h")
    t.driver.stop()
    expect(t.input.raw).toEqual([true, false])
  })

  test("a partial paste refuses cooked reader handoff, cleanup still restores raw mode", () => {
    const t = terminal()
    t.driver.start()
    t.input.emit("data", Buffer.from("\x1b[200~APPROVE "))
    expect(() => t.driver.handoff()).toThrow("paste is incomplete")
    expect(t.input.isRaw).toBe(true)
    expect(t.events).toHaveLength(0)
    t.driver.stop()
    expect(t.input.isRaw).toBe(false)
  })

  test("choice key followed by a paste prefix in the same read cannot open cooked input", () => {
    const t = terminal()
    t.driver.start()
    t.input.emit("data", Buffer.from("\r\x1b[200~APPROVE stale"))
    expect(t.events).toEqual([{ type: "key", key: "enter" }])
    expect(() => t.driver.handoff()).toThrow("paste is incomplete")
    t.driver.stop()
  })

  test("fragmented Unicode and complete multiline paste emit no submit key", () => {
    const t = terminal()
    t.driver.start()
    const bytes = Buffer.from("한글")
    t.input.emit("data", bytes.subarray(0, 2))
    t.input.emit("data", bytes.subarray(2))
    expect(t.events.filter(event => event.type === "text").map(event => event.text).join("")).toBe("한글")
    t.events.length = 0
    t.input.emit("data", Buffer.from("\x1b[20"))
    t.input.emit("data", Buffer.from("0~first\nsecond\r\x1b[201~"))
    expect(t.events).toHaveLength(1)
    expect(t.events[0]?.type).toBe("paste")
    t.driver.handoff()
  })

  test("disconnect restores modes before notifying coordinator", () => {
    const t = terminal()
    t.driver.start()
    t.input.emit("end")
    expect(t.input.isRaw).toBe(false)
    expect(t.disconnected()).toBe(1)
    expect(t.input.listenerCount("data")).toBe(0)
  })
})
