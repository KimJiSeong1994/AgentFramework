import { StringDecoder } from "node:string_decoder"
import type { ReadStream, WriteStream } from "node:tty"
import { KeyDecoder, type InputEvent } from "./keys.ts"

// LCA terminal lifecycle; input semantics are attributed in ./ATTRIBUTION.
const ENTER = "\x1b[?1049h\x1b[?2004h\x1b[>4;2m\x1b[>1u\x1b[?25h"
const LEAVE = "\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l"

export class TerminalDriver {
  private active = false
  private decoder = new KeyDecoder()
  private utf8 = new StringDecoder("utf8")
  private escapeTimer?: ReturnType<typeof setTimeout>
  private previousRaw = false
  constructor(
    private readonly event: (event: InputEvent) => void,
    private readonly resize: () => void,
    private readonly disconnected: () => void,
    readonly input: ReadStream = process.stdin,
    readonly output: WriteStream = process.stdout,
  ) {}

  private data = (chunk: Buffer | string) => {
    if (!this.active) return
    clearTimeout(this.escapeTimer)
    const text = typeof chunk === "string" ? chunk : this.utf8.write(chunk)
    for (const event of this.decoder.feed(text)) {
      if (!this.active) break
      this.event(event)
    }
    if (this.active) this.escapeTimer = setTimeout(() => {
      for (const event of this.decoder.flushEscape()) if (this.active) this.event(event)
    }, 35)
  }
  private end = () => {
    try { this.stop() } catch { /* A disconnected descriptor cannot restore termios. */ }
    this.disconnected()
  }
  private error = this.end

  start(): void {
    if (this.active) return
    this.decoder.reset()
    this.utf8 = new StringDecoder("utf8")
    this.previousRaw = this.input.isRaw
    this.active = true
    this.input.on("data", this.data)
    this.input.on("end", this.end)
    this.input.on("error", this.error)
    this.output.off("error", this.error)
    this.output.on("error", this.error)
    this.output.on("resize", this.resize)
    try {
      this.input.setRawMode(true)
      this.input.resume()
      this.output.write(ENTER)
    } catch (error) {
      this.stop()
      throw error
    }
  }

  write(frame: string): void {
    if (!this.active) return
    try { this.output.write(frame) } catch { this.error() }
  }

  handoff(): void {
    if (this.decoder.isPastePending()) throw new Error("terminal handoff refused: bracketed paste is incomplete")
    this.stop()
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    clearTimeout(this.escapeTimer)
    this.input.off("data", this.data)
    this.input.off("end", this.end)
    this.input.off("error", this.error)
    this.output.off("resize", this.resize)
    this.input.pause()
    // Discard raw buffered choice/paste bytes before the private cooked reader
    // takes ownership. No queued composer text is ever forwarded to that reader.
    while (this.input.read() !== null) { /* Drain only already-buffered bytes. */ }
    this.decoder.reset()
    try { this.input.setRawMode(this.previousRaw) } finally {
      // A failed write may emit `error` after its callback. Retain this one
      // listener across cooked handoff so a disconnect cannot bypass cleanup.
      try { this.output.write(LEAVE) } catch { this.disconnected() }
    }
  }
}
