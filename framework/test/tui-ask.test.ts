import { describe, expect, test } from "bun:test"
import { TuiApp } from "../src/tui/app.ts"

const plain = (frame: string | undefined): string => (frame ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")

type Internal = {
  input(event: unknown): void
  driver: { write(frame: string): void }
  dimensions(): { columns: number; rows: number }
  asciiChrome: boolean
  spinnerTimer?: unknown
  hostWorking: boolean
  transcript: { lines(): string[] }
}

function setup(columns = 80, rows = 30) {
  const app = new TuiApp()
  app.resume = () => {}
  const internal = app as unknown as Internal
  internal.dimensions = () => ({ columns, rows })
  const frames: string[] = []
  internal.driver.write = frame => frames.push(frame)
  return { app, internal, frames, last: () => plain(frames.at(-1)) }
}
const key = (name: string) => ({ type: "key", key: name })
const prompt = {
  question: "Which storage backend?",
  options: [{ label: "SQLite", detail: "Single file, no server" }, { label: "Postgres", detail: "Networked, heavier" }, { label: "Memory" }],
  recommended: 1,
  allowCustom: true,
}

describe("GJC-style ask", () => {
  test("renders question, numbered options, (Recommended), highlighted detail, Other row and hint", () => {
    const { app, last } = setup()
    const answer = app.ask(prompt, new AbortController().signal)
    const frame = last()
    expect(frame).toContain("Which storage backend?")
    expect(frame).toContain("  1. SQLite")
    expect(frame).toContain("❯ 2. Postgres (Recommended)")
    expect(frame).toContain("  3. Memory")
    expect(frame).toContain("  4. Other (type your own)")
    expect(frame).toContain("Networked, heavier")
    expect(frame).not.toContain("Single file, no server")
    expect(frame).toContain("↑↓ move · Enter select · 1-9 jump · Esc cancel")
    app.close()
    return answer
  })

  test("Up/Down move the cursor, Enter returns the option index, recommended only pre-highlights", async () => {
    const { app, internal, last } = setup()
    const answer = app.ask(prompt, new AbortController().signal)
    internal.input(key("up"))
    expect(last()).toContain("❯ 1. SQLite")
    expect(last()).toContain("Single file, no server")
    internal.input(key("down"))
    internal.input(key("down"))
    expect(last()).toContain("❯ 3. Memory")
    internal.input(key("enter"))
    expect(await answer).toEqual({ kind: "option", index: 2 })
    expect(internal.transcript.lines().join("\n")).toContain("Which storage backend?: Memory")
    app.close()
  })

  test("Enter without moving answers the recommended option", async () => {
    const { app, internal } = setup()
    const answer = app.ask(prompt, new AbortController().signal)
    internal.input(key("enter"))
    expect(await answer).toEqual({ kind: "option", index: 1 })
    app.close()
  })

  test("digit keys jump-select immediately and out-of-range digits are ignored", async () => {
    const { app, internal } = setup()
    const answer = app.ask({ ...prompt, allowCustom: false }, new AbortController().signal)
    internal.input({ type: "text", text: "9" })
    internal.input({ type: "text", text: "4" })
    internal.input({ type: "text", text: "3" })
    expect(await answer).toEqual({ kind: "option", index: 2 })
    app.close()
  })

  test("Other opens an inline editor; Enter submits trimmed text; empty text does not submit", async () => {
    const { app, internal, last } = setup()
    const answer = app.ask(prompt, new AbortController().signal)
    internal.input({ type: "text", text: "4" })
    expect(last()).toContain("Answer> ")
    internal.input(key("enter"))
    internal.input({ type: "text", text: "  DuckDB  " })
    expect(last()).toContain("Answer>   DuckDB")
    internal.input(key("enter"))
    expect(await answer).toEqual({ kind: "custom", text: "DuckDB" })
    app.close()
  })

  test("Esc in the editor returns to the list; Esc in the list dismisses with undefined", async () => {
    const { app, internal, last } = setup()
    const answer = app.ask(prompt, new AbortController().signal)
    internal.input(key("down"))
    internal.input(key("down"))
    expect(last()).toContain("❯ 4. Other (type your own)")
    internal.input(key("enter"))
    internal.input({ type: "text", text: "draft" })
    internal.input(key("escape"))
    expect(last()).toContain("❯ 4. Other (type your own)")
    expect(last()).not.toContain("Answer> ")
    internal.input(key("escape"))
    expect(await answer).toBeUndefined()
    expect(internal.transcript.lines().join("\n")).toContain("No decision (dismissed)")
    app.close()
  })

  test("custom text is capped at 2000 characters", async () => {
    const { app, internal } = setup()
    const answer = app.ask(prompt, new AbortController().signal)
    internal.input({ type: "text", text: "4" })
    internal.input({ type: "paste", text: "x".repeat(3000) })
    internal.input(key("enter"))
    expect(await answer).toEqual({ kind: "custom", text: "x".repeat(2000) })
    app.close()
  })

  test("abort resolves undefined and a second concurrent ask is refused", async () => {
    const { app } = setup()
    const controller = new AbortController()
    const answer = app.ask(prompt, controller.signal)
    expect(() => app.ask(prompt, new AbortController().signal)).toThrow()
    controller.abort()
    expect(await answer).toBeUndefined()
    app.close()
  })

  test("ASCII chrome uses > and plain hint text", async () => {
    const { app, internal, last } = setup()
    internal.asciiChrome = true
    const answer = app.ask(prompt, new AbortController().signal)
    expect(last()).toContain("> 2. Postgres (Recommended)")
    expect(last()).not.toContain("❯")
    expect(last()).toContain("Up/Down move | Enter select | 1-9 jump | Esc cancel")
    internal.input(key("enter"))
    await answer
    app.close()
  })
})

describe("plain choose restyle", () => {
  test("numbered rows, cursor glyph, hint, and unchanged index results", async () => {
    const { app, internal, last } = setup()
    const picked = app.choose("Pick one", ["alpha", "beta", "gamma"], new AbortController().signal)
    expect(last()).toContain("❯ 1. alpha")
    expect(last()).toContain("  2. beta")
    expect(last()).toContain("↑↓ move · Enter select · 1-9 jump · Esc cancel")
    internal.input(key("down"))
    expect(last()).toContain("❯ 2. beta")
    internal.input(key("enter"))
    expect(await picked).toBe(1)

    const jumped = app.choose("Pick one", ["alpha", "beta", "gamma"], new AbortController().signal)
    internal.input({ type: "text", text: "3" })
    expect(await jumped).toBe(2)

    const dismissed = app.choose("Pick one", ["alpha", "beta"], new AbortController().signal)
    internal.input(key("escape"))
    expect(await dismissed).toBeUndefined()
    app.close()
  })

  test("generic text and paste still cannot answer a plain choice with a non-digit", async () => {
    const { app, internal } = setup()
    const picked = app.choose("Pick one", ["alpha", "beta"], new AbortController().signal)
    internal.input({ type: "text", text: "x" })
    internal.input({ type: "paste", text: "2" })
    internal.input({ type: "text", text: "12" })
    internal.input(key("enter"))
    expect(await picked).toBe(0)
    app.close()
  })
})

describe("live status row", () => {
  test("shows the most specific step, elapsed and the esc hint without duplicate generic text", () => {
    const { app, internal, last } = setup(100, 30)
    internal.hostWorking = true
    app.activity({ kind: "tool-started", executionID: "e1", callID: "c1", taskID: "t1", tool: "bash", role: "worker" } as never)
    const frame = last()
    expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Bash · \d+ms ⟦esc⟧/u)
    expect(frame).not.toContain("Model request running")
    expect(frame).not.toContain("Escape cancels")
    internal.asciiChrome = true
    app.activity({ kind: "tool-finished", executionID: "e1", callID: "c1", taskID: "t1", tool: "bash", role: "worker", outcome: "succeeded" } as never)
    expect(last()).toMatch(/[-\\|/] .* \| \d+ms \[esc\]/u)
    app.close()
  })

  test("a running tool call reads as `Read <target>`, a running task as `Task id: title`, a stage as kind · stage", () => {
    const { app, internal, last } = setup(100, 30)
    internal.hostWorking = true
    app.workflowStatus("ralplan · critic", { kind: "ralplan", stage: "critic", phase: "reviewing" })
    app.taskSnapshot([{ id: "t2", status: "running", title: "Add multiply" }])
    app.activity({ kind: "tool-started", executionID: "e1", callID: "c1", taskID: "t2", tool: "read", role: "worker" } as never)
    app.toolDisplay({ executionID: "e1", callID: "c1", detail: { path: "src/math.ts", offset: 1, limit: 40 } } as never)
    expect(last()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Read src\/math\.ts:1-40 · \d+ms ⟦esc⟧/u)
    app.activity({ kind: "tool-finished", executionID: "e1", callID: "c1", taskID: "t2", tool: "read", role: "worker", outcome: "succeeded" } as never)
    expect(last()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Task t2: Add multiply · \d+ms ⟦esc⟧/u)
    app.taskSnapshot([{ id: "t2", status: "done" }])
    app.close()
  })
})
