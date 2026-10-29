import { expect, test } from "bun:test"
import { TuiApp } from "../src/tui/app.ts"

test("busy Enter queues FIFO; selection and held sessions cannot consume queued requests", async () => {
  const app = new TuiApp()
  const internal = app as unknown as { input(event: unknown): void; draw(): void; usable(): boolean }
  internal.draw = () => {}
  internal.usable = () => true
  app.resume = () => {}
  try {
    for (const text of ["first followup", "second followup"]) {
      app.setDraft(text)
      internal.input({ type: "key", key: "enter" })
    }
    expect(app.draftSnapshot()).toEqual({ draft: "", queued: ["first followup", "second followup"] })
    const selectionAbort = new AbortController()
    const selection = app.readInput({ kind: "selection", title: "Approval", hint: "", prompt: "" }, selectionAbort.signal)
    expect(app.draftSnapshot().queued).toHaveLength(2)
    selectionAbort.abort()
    expect(await selection).toBeUndefined()
    app.queueAdmission(false)
    const heldAbort = new AbortController()
    const held = app.readInput({ kind: "chat", title: "Held", hint: "", prompt: "" }, heldAbort.signal)
    expect(app.draftSnapshot().queued).toHaveLength(2)
    heldAbort.abort()
    await held
    app.queueAdmission(true)
    for (const text of ["first followup", "second followup"]) {
      expect(await app.readInput({ kind: "chat", title: "Chat", hint: "", prompt: "" }, new AbortController().signal)).toBe(text)
    }
    expect(app.draftSnapshot().queued).toEqual([])
  } finally { app.close() }
})

test("busy controls stay immediate and empty Enter does not queue", () => {
  const app = new TuiApp()
  const internal = app as unknown as { input(event: unknown): void; draw(): void }
  internal.draw = () => {}
  const controls: string[] = []
  app.controls(value => controls.push(value))
  try {
    for (const value of ["", "/pause", "/cancel", "/quit"]) {
      app.setDraft(value)
      internal.input({ type: "key", key: "enter" })
    }
    expect(controls).toEqual(["pause", "cancel", "quit"])
    expect(app.draftSnapshot().queued).toEqual([])
  } finally { app.close() }
})
