import { describe, expect, test } from "bun:test"
import { TuiApp } from "../src/tui/app.ts"
import { TranscriptModel } from "../src/tui/transcript-model.ts"
import { restoreTranscript } from "../src/tui/session-transcript.ts"
import { interactiveActions, interactiveHelp } from "../src/hosts/interactive-actions.ts"
import type { InputEvent } from "../src/tui/keys.ts"
import { KeyDecoder } from "../src/tui/keys.ts"

type Internals = {
  input(event: InputEvent): void
  draw(): void
  renderedTranscript: readonly string[]
  clipboard(text: string, write: (sequence: string) => void): Promise<"native" | "terminal">
  copyAnswer(): Promise<void>
  transcript: TranscriptModel
  editor: { cursor: number }
  dimensions(): { columns: number; rows: number }
  driver: { write(frame: string): void }
}

function fixture() {
  const app = new TuiApp()
  app.resume = () => {}
  const internal = app as unknown as Internals
  internal.dimensions = () => ({ columns: 100, rows: 30 })
  internal.driver.write = () => {}
  const copies: string[] = []
  internal.clipboard = async text => { copies.push(text); return "native" }
  return { app, internal, copies }
}

describe("TUI answer copying", () => {
  test("dragging a visible answer highlights and copies only the selected text on release", async () => {
    const { app, internal, copies } = fixture()
    try {
      internal.transcript.append({ provenance: "assistant", text: "alpha beta gamma" })
      app.setDraft("keep this draft")
      internal.editor.cursor = 4
      internal.draw()
      const y = internal.renderedTranscript.findIndex(row => row.includes("alpha beta gamma")) + 1
      const x = internal.renderedTranscript[y - 1]!.indexOf("beta") + 1
      expect(y).toBeGreaterThan(0)
      const frames: string[] = []
      internal.driver.write = frame => frames.push(frame)
      const decoder = new KeyDecoder()
      const packet = (value: string) => { for (const event of decoder.feed(value)) internal.input(event) }
      packet(`\x1b[<0;${x};${y}M\x1b[<32;${x + 3};${y}M`)
      expect(frames.at(-1)).toContain("\x1b[7m")
      expect(copies).toEqual([])
      packet(`\x1b[<0;${x + 3};${y}m`)
      await Promise.resolve()
      expect(copies).toEqual(["beta"])
      expect(internal.transcript.lines().join("\n")).toContain("Selected text copied to clipboard.")
      expect(app.draftSnapshot().draft).toBe("keep this draft")
      expect(internal.editor.cursor).toBe(4)
    } finally { app.close() }
  })

  test("drag snapshots remain stable while new output arrives and resume after release", async () => {
    const { app, internal, copies } = fixture()
    try {
      internal.transcript.append({ provenance: "assistant", text: "original answer" })
      internal.draw()
      const y = internal.renderedTranscript.findIndex(row => row.includes("original answer")) + 1
      const x = internal.renderedTranscript[y - 1]!.indexOf("original") + 1
      const frames: string[] = []
      internal.driver.write = frame => frames.push(frame)
      internal.input({ type: "mouse", action: "down", x, y })
      internal.input({ type: "mouse", action: "move", x: x + 7, y })
      internal.transcript.append({ provenance: "assistant", text: "new live output" })
      internal.draw()
      expect(frames.at(-1)).not.toContain("new live output")
      internal.input({ type: "mouse", action: "up", x: x + 7, y })
      await Promise.resolve()
      expect(copies).toEqual(["original"])
      expect(frames.at(-1)).toContain("new live output")
    } finally { app.close() }
  })

  test("single clicks and drags starting outside the transcript do not copy", () => {
    const { app, internal, copies } = fixture()
    try {
      internal.transcript.append({ provenance: "assistant", text: "answer" })
      internal.draw()
      internal.input({ type: "mouse", action: "down", x: 1, y: 1 })
      internal.input({ type: "mouse", action: "up", x: 1, y: 1 })
      internal.input({ type: "mouse", action: "down", x: 1, y: 29 })
      internal.input({ type: "mouse", action: "move", x: 8, y: 1 })
      internal.input({ type: "mouse", action: "up", x: 8, y: 1 })
      expect(copies).toEqual([])
    } finally { app.close() }
  })

  test.each(["typing", "wheel", "resize", "session"])("%s cancels an unfinished drag", change => {
    const { app, internal, copies } = fixture()
    try {
      internal.transcript.append({ provenance: "assistant", text: "answer" })
      internal.draw()
      internal.input({ type: "mouse", action: "down", x: 1, y: 1 })
      internal.input({ type: "mouse", action: "move", x: 6, y: 1 })
      if (change === "typing") internal.input({ type: "text", text: "a" })
      if (change === "wheel") internal.input({ type: "key", key: "wheelUp" })
      if (change === "resize") { internal.dimensions = () => ({ columns: 80, rows: 24 }); internal.draw() }
      if (change === "session") app.bindSession("new-session")
      internal.input({ type: "mouse", action: "up", x: 6, y: 1 })
      expect(copies).toEqual([])
    } finally { app.close() }
  })

  test("Ctrl+Y copies the complete latest answer and preserves draft, cursor and pending input", async () => {
    const { app, internal, copies } = fixture()
    try {
      const pending = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, new AbortController().signal)
      let settled = false
      void pending.then(() => { settled = true })
      const answer = "## 한글 🦦\n\n```ts\nconst value = 1\n```\n" + "long answer ".repeat(1000)
      internal.transcript.append({ provenance: "assistant", text: "older answer" })
      internal.transcript.append({ provenance: "assistant", text: answer })
      internal.transcript.append({ provenance: "user", text: "do not copy me" })
      internal.transcript.append("notice is not an answer")
      app.setDraft("keep my draft")
      internal.editor.cursor = 4
      internal.input({ type: "key", key: "ctrl+y" })
      await Promise.resolve()
      expect(copies).toEqual([answer])
      expect(app.draftSnapshot()).toEqual({ draft: "keep my draft", queued: [] })
      expect(internal.editor.cursor).toBe(4)
      expect(settled).toBe(false)
      expect(internal.transcript.lines().join("\n")).toContain("Answer copied to clipboard.")
    } finally { app.close() }
  })

  test("/copy is a local palette command and never submits a model turn", async () => {
    const { app, internal, copies } = fixture()
    try {
      const pending = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, new AbortController().signal)
      let settled = false
      void pending.then(() => { settled = true })
      internal.transcript.append({ provenance: "assistant", text: "answer" })
      internal.input({ type: "text", text: "/copy" })
      internal.input({ type: "key", key: "enter" })
      await Promise.resolve()
      expect(copies).toEqual(["answer"])
      expect(settled).toBe(false)
      expect(app.draftSnapshot().draft).toBe("")
      expect(interactiveHelp("chat")).toContain("/copy")
      for (const context of ["chat", "busy", "held", "observer", "read-only"] as const) {
        expect(interactiveActions(context).some(action => action.id === "copy" && action.local)).toBe(true)
      }
    } finally { app.close() }
  })

  test("a restored history page copies raw answer text without presentation labels", async () => {
    const { app, internal, copies } = fixture()
    try {
      const text = "**restored**\n\n- first\n- second"
      restoreTranscript(internal.transcript, [{
        kind: "assistant", seq: 1, eventID: "answer-1", data: { text },
      }] as Parameters<typeof restoreTranscript>[1])
      await internal.copyAnswer()
      expect(copies).toEqual([text])
    } finally { app.close() }
  })

  test("empty or non-assistant transcripts leave the clipboard untouched", async () => {
    const { app, internal, copies } = fixture()
    try {
      internal.transcript.append({ provenance: "user", text: "prompt" })
      internal.transcript.append({ provenance: "canonical-plan", text: "plan" })
      internal.transcript.append({ provenance: "assistant", text: " \n" })
      await internal.copyAnswer()
      expect(copies).toEqual([])
      expect(internal.transcript.lines().join("\n")).toContain("No assistant answer to copy")
    } finally { app.close() }
  })

  test("Ctrl+Y does not interfere with a picker", async () => {
    const { app, internal, copies } = fixture()
    try {
      internal.transcript.append({ provenance: "assistant", text: "answer" })
      app.setDraft("keep")
      const choice = app.choose("Engine", ["local", "codex"], new AbortController().signal, {
        kind: "picker", purpose: "selection", rows: ["Local", "Codex"],
      })
      internal.input({ type: "key", key: "ctrl+y" })
      expect(copies).toEqual([])
      expect(app.draftSnapshot().draft).toBe("keep")
      internal.input({ type: "key", key: "escape" })
      expect(await choice).toBeUndefined()
    } finally { app.close() }
  })

  test("fallback and failure feedback are truthful and preserve input", async () => {
    const { app, internal } = fixture()
    try {
      internal.transcript.append({ provenance: "assistant", text: "answer" })
      app.setDraft("draft")
      const writes: string[] = []
      internal.driver.write = sequence => writes.push(sequence)
      internal.clipboard = async (_text, write) => { write("terminal-copy"); return "terminal" }
      await internal.copyAnswer()
      expect(writes).toContain("terminal-copy")
      expect(internal.transcript.lines().join("\n")).toContain("requires OSC 52")
      internal.clipboard = async () => { throw new Error("private error details") }
      await internal.copyAnswer()
      expect(internal.transcript.lines().join("\n")).toContain("Could not copy the answer")
      expect(internal.transcript.lines().join("\n")).not.toContain("private error details")
      expect(app.draftSnapshot().draft).toBe("draft")
    } finally { app.close() }
  })

  test("repeated shortcuts do not start concurrent copies or leak notices into a new session", async () => {
    const { app, internal } = fixture()
    try {
      internal.transcript.append({ provenance: "assistant", text: "answer" })
      let finish!: (value: "native") => void
      let calls = 0
      internal.clipboard = () => { calls++; return new Promise(resolve => { finish = resolve }) }
      const pending = internal.copyAnswer()
      await internal.copyAnswer()
      expect(calls).toBe(1)
      app.bindSession("another-session")
      finish("native")
      await pending
      expect(internal.transcript.lines().join("\n")).not.toContain("Answer copied")
    } finally { app.close() }
  })
})
