import { describe, expect, test } from "bun:test"
import { commandInsertions, interactiveActions, interactiveHelp } from "../src/hosts/interactive-actions.ts"
import { commandCompletions } from "../src/tui/skill-completion.ts"
import { TuiApp } from "../src/tui/app.ts"
import { transcriptViewportRows, wrapText, wrapTranscriptLine } from "../src/tui/render.ts"

type AppInput = {
  input(event: unknown): void
  draw(): void
  driver: { write(frame: string): void }
  editor: { cursor: number }
  detailsVisible: boolean
  themeName: string
  asciiChrome: boolean
  choice?: { documentOffset: number; documentAnchorLine: number; focus: string; selected: number }
  completionDismissed: boolean
  completions(): string[]
  skillCompletions(): object | undefined
  dimensions(): { columns: number; rows: number }
  currentStatusLines(): string[]
  viewFacts?: { selection: { engine: string; model: string } }
  transcriptScrollBounds(): { pageRows: number; maximumOffset: number }
  queue: string[]
  transcript: {
    lines(): string[]
    append(value: { provenance: "assistant"; text: string }): void
  }
}

describe("shared interactive actions", () => {
  test("completion derives from the shared command descriptors", () => {
    expect(commandCompletions("/se")).toEqual(commandInsertions("/se"))
    expect(commandCompletions("/se")).toEqual(["/sessions", "/search"])
  })

  test("contextual help does not promise work Resume in read-only history", () => {
    const readOnly = interactiveActions("read-only")
    expect(readOnly.some(action => action.id === "continue")).toBe(false)
    expect(interactiveHelp("read-only")).toContain("/resume <sid>")
    expect(interactiveHelp("read-only")).toContain("(local)")
  })

  test("unselected completion is actionable and never inserts skill placeholders", () => {
    const commands = commandInsertions("/", "unselected")
    expect(commands).toContain("/model")
    expect(commands).not.toContain("/sessions")
    expect(commands).not.toContain("/plan")
    expect(commandInsertions("/", "chat").join(" ")).not.toContain("<name>")
  })
})

describe("exclusive application input ownership", () => {
  test("canonical /quit remains an app control and /exit is not an alias", () => {
    const app = new TuiApp()
    const internal = app as unknown as AppInput
    internal.dimensions = () => ({ columns: 80, rows: 24 })
    const actions: string[] = []
    app.controls(action => actions.push(action))

    app.setDraft("/exit")
    internal.input({ type: "key", key: "enter" })
    expect(actions).toEqual([])

    app.setDraft("/quit")
    internal.input({ type: "key", key: "enter" })
    expect(actions).toEqual(["quit"])
    app.close()
  })

  test("empty selected view shows compact guidance and only fact-backed selection in the header", () => {
    const app = new TuiApp()
    const internal = app as unknown as AppInput
    internal.dimensions = () => ({ columns: 80, rows: 24 })
    internal.currentStatusLines = () => ["status"]
    internal.viewFacts = { selection: { engine: "local", model: "model-known" } }
    const frames: string[] = []
    internal.driver.write = frame => frames.push(frame)

    internal.draw()

    expect(frames.at(-1)).toContain("LCA · Home · local / model-known")
    expect(frames.at(-1)).toContain("\u001b[3;1H\u001b[2K  No messages yet.")
    expect(frames.at(-1)).not.toContain("ready")
    app.close()
  })

  test("unselected local transcript actions show choose-model guidance; theme and ASCII stay local", async () => {
    const app = new TuiApp()
    app.resume = () => {}
    app.actionContext("unselected")
    const internal = app as unknown as AppInput
    const actions: string[] = []
    app.controls(action => actions.push(action))
    const pending = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, new AbortController().signal)
    let settled = false
    void pending.then(() => { settled = true })

    for (const command of ["/details", "/search secret", "/expand 1"]) {
      internal.input({ type: "text", text: command })
      internal.input({ type: "key", key: "enter" })
    }
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(internal.transcript.lines().join("\n")).toContain("Choose an engine and model with /model before using transcript tools.")
    expect(internal.transcript.lines().join("\n")).not.toContain("/search secret")
    expect(actions).toEqual([])

    internal.input({ type: "text", text: "/theme dark" })
    internal.input({ type: "key", key: "enter" })
    internal.input({ type: "text", text: "/ascii" })
    internal.input({ type: "key", key: "enter" })
    expect(internal.themeName).toBe("dark")
    expect(internal.asciiChrome).toBe(true)
    expect(actions).toEqual([])
    app.close()
    expect(await pending).toBeUndefined()
  })

  test("cancelling manual selection restores the original draft and cursor", async () => {
    const app = new TuiApp()
    app.resume = () => {}
    const internal = app as unknown as AppInput
    app.setDraft("original draft")
    internal.editor.cursor = 3
    const pending = app.readInput({ title: "Model ID", hint: "Escape cancels", prompt: "Model ID> ", kind: "selection" }, new AbortController().signal)
    let settled = false
    void pending.then(() => { settled = true })
    internal.input({ type: "paste", text: "partial-model-id" })
    internal.input({ type: "key", key: process.platform === "linux" ? "alt+enter" : "alt+q" })
    await Promise.resolve()
    expect(settled).toBe(false)
    internal.input({ type: "key", key: "escape" })
    expect(await pending).toBeUndefined()
    expect(app.draftSnapshot().draft).toBe("original draft")
    expect(internal.editor.cursor).toBe(3)
    app.close()
  })

  test("details cannot mutate the draft or consume safe exit controls", async () => {
    const app = new TuiApp()
    app.resume = () => {}
    const internal = app as unknown as AppInput
    const frames: string[] = []
    internal.driver.write = frame => frames.push(frame)
    const actions: string[] = []
    app.controls(action => actions.push(action))
    const pending = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, new AbortController().signal)
    app.setDraft("keep this draft")
    internal.editor.cursor = 4
    internal.detailsVisible = true
    internal.input({ type: "text", text: "/sessions" })
    internal.input({ type: "paste", text: "/quit\nAPPROVE" })
    internal.input({ type: "key", key: "enter" })
    const detailsFrame = frames.at(-1)!
    expect(detailsFrame).toContain("Task/evidence details · evidence list focus")
    expect(detailsFrame).not.toContain("keep this draft")
    expect(detailsFrame).not.toContain("You> ")
    expect(detailsFrame).toContain("\u001b[?25l")
    expect(app.draftSnapshot()).toEqual({ draft: "keep this draft", queued: [] })
    expect(internal.editor.cursor).toBe(4)
    internal.input({ type: "key", key: "ctrl+d" })
    expect(actions).toEqual(["quit"])
    internal.input({ type: "key", key: "escape" })
    expect(internal.detailsVisible).toBe(false)
    expect(app.draftSnapshot().draft).toBe("keep this draft")
    expect(internal.editor.cursor).toBe(4)
    app.close()
    expect(await pending).toBeUndefined()
  })

  test("first Ctrl+C preserves details and its exact draft/cursor; second requests shutdown", async () => {
    const app = new TuiApp()
    app.resume = () => {}
    const internal = app as unknown as AppInput
    const actions: string[] = []
    app.controls(action => actions.push(action))
    const pending = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, new AbortController().signal)
    app.setDraft("draft stays here")
    internal.editor.cursor = 6
    internal.detailsVisible = true

    internal.input({ type: "key", key: "ctrl+c" })
    expect(internal.detailsVisible).toBe(true)
    expect(app.draftSnapshot()).toEqual({ draft: "draft stays here", queued: [] })
    expect(internal.editor.cursor).toBe(6)
    expect(actions).toEqual([])

    internal.input({ type: "key", key: "ctrl+c" })
    expect(actions).toEqual(["shutdown"])
    app.close()
    expect(await pending).toBeUndefined()
  })

  test("first Ctrl+C preserves picker ownership and the exact draft/cursor; second requests shutdown", async () => {
    const app = new TuiApp()
    const internal = app as unknown as AppInput
    const actions: string[] = []
    app.controls(action => actions.push(action))
    app.setDraft("keep picker origin")
    internal.editor.cursor = 5
    const choice = app.choose("Engine", ["local", "codex"], new AbortController().signal, {
      kind: "picker", purpose: "selection", rows: ["Local", "Codex"],
    })

    internal.input({ type: "key", key: "ctrl+c" })
    expect(internal.choice).toBeDefined()
    expect(app.draftSnapshot()).toEqual({ draft: "keep picker origin", queued: [] })
    expect(internal.editor.cursor).toBe(5)
    expect(actions).toEqual([])

    internal.input({ type: "key", key: "ctrl+c" })
    expect(actions).toEqual(["shutdown"])
    app.close()
    expect(await choice).toBeUndefined()
  })

  test("first Ctrl+C preserves the command palette and exact draft/cursor; second requests shutdown", async () => {
    const app = new TuiApp()
    app.resume = () => {}
    const internal = app as unknown as AppInput
    const actions: string[] = []
    app.controls(action => actions.push(action))
    const pending = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, new AbortController().signal)
    internal.input({ type: "text", text: "/se" })
    expect(internal.completions().length).toBeGreaterThan(0)
    internal.editor.cursor = 1

    internal.input({ type: "key", key: "ctrl+c" })
    expect(internal.completions().length).toBeGreaterThan(0)
    expect(internal.completionDismissed).toBe(false)
    expect(app.draftSnapshot()).toEqual({ draft: "/se", queued: [] })
    expect(internal.editor.cursor).toBe(1)
    expect(actions).toEqual([])

    internal.input({ type: "key", key: "ctrl+c" })
    expect(actions).toEqual(["shutdown"])
    app.close()
    expect(await pending).toBeUndefined()
  })

  test("first Ctrl+C preserves skill suggestions and exact draft/cursor; second requests shutdown", async () => {
    const app = new TuiApp()
    app.resume = () => {}
    const internal = app as unknown as AppInput
    const actions: string[] = []
    app.controls(action => actions.push(action))
    const pending = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, new AbortController().signal)
    internal.input({ type: "text", text: "/skill:" })
    expect(internal.skillCompletions()).toBeDefined()
    internal.editor.cursor = 3

    internal.input({ type: "key", key: "ctrl+c" })
    expect(internal.skillCompletions()).toBeDefined()
    expect(app.draftSnapshot()).toEqual({ draft: "/skill:", queued: [] })
    expect(internal.editor.cursor).toBe(3)
    expect(actions).toEqual([])

    internal.input({ type: "key", key: "ctrl+c" })
    expect(actions).toEqual(["shutdown"])
    app.close()
    expect(await pending).toBeUndefined()
  })

  test.each([80, 120])("transcript page bounds use the renderer's attributed physical rows at %i columns", columns => {
    const app = new TuiApp()
    const internal = app as unknown as AppInput
    internal.dimensions = () => ({ columns, rows: 24 })
    internal.currentStatusLines = () => ["ready"]
    const text = "x".repeat(columns * 24)
    internal.transcript.append({ provenance: "assistant", text })

    const rows = wrapTranscriptLine(`[Assistant] ${text}`, columns).length
    const pageRows = transcriptViewportRows({ columns, rows: 24, draft: "", cursor: 0, prompt: "You> " })
    expect(internal.transcriptScrollBounds()).toEqual({ pageRows, maximumOffset: rows - pageRows })
    app.close()
  })

  test.each([[80, 24], [120, 40]] as const)("approval document paging follows the shared viewport and preserves bounded decision focus at %ix%i", async (columns, rows) => {
    const app = new TuiApp()
    const internal = app as unknown as AppInput
    internal.dimensions = () => ({ columns, rows })
    const frames: string[] = []
    internal.driver.write = frame => frames.push(frame)
    app.setDraft("private approval draft")
    const values = ["Approve exact plan", "Reject"]
    const document = Array.from({ length: 60 }, (_, index) => `line-${index} ${"x".repeat(68)}`).join("\n")
    const result = app.choose("Review canonical plan", values, new AbortController().signal, {
      kind: "approval",
      document,
      binding: { sessionID: "session-1", workflowID: "workflow-1", expectedRevision: 3, planSha: "a".repeat(64), path: "plan.json" },
    })
    expect(frames.at(-1)).toContain("Review canonical plan · document focus")
    expect(frames.at(-1)).not.toContain("private approval draft")
    expect(frames.at(-1)).not.toContain("You> ")
    expect(frames.at(-1)).toContain("\u001b[?25l")
    const bodyRows = transcriptViewportRows({ columns, rows, draft: "", cursor: 0, prompt: "" })
    const pageRows = Math.max(1, bodyRows - 6 - values.length)
    const totalRows = document.split("\n").flatMap(line => wrapText(line, columns)).length

    internal.input({ type: "key", key: "pageDown" })
    expect(internal.choice?.documentOffset).toBe(pageRows)
    expect(internal.choice?.documentAnchorLine).toBe(pageRows)
    internal.input({ type: "key", key: "pageDown" })
    expect(internal.choice?.documentOffset).toBe(Math.min(totalRows - pageRows, pageRows * 2))
    expect(internal.choice?.documentOffset).toBeLessThanOrEqual(totalRows - pageRows)
    internal.input({ type: "key", key: "tab" })
    expect(internal.choice?.focus).toBe("decisions")
    internal.input({ type: "key", key: "down" })
    expect(internal.choice?.selected).toBe(1)
    internal.input({ type: "key", key: "enter" })
    expect(await result).toBe(1)
    app.close()
  })

  test("filtering chooses original indexes without changing the composer or selecting on paste", async () => {
    const app = new TuiApp()
    const internal = app as unknown as AppInput
    internal.dimensions = () => ({ columns: 80, rows: 24 })
    const frames: string[] = []
    internal.driver.write = frame => frames.push(frame)
    const actions: string[] = []
    app.controls(action => actions.push(action))
    app.setDraft("retained draft")
    internal.editor.cursor = 4
    const result = app.choose("Engine", ["local", "codex", "claude"], new AbortController().signal, {
      kind: "picker", purpose: "selection", rows: ["Local", "Codex", "Claude"],
    })
    let settled = false
    void result.then(() => { settled = true })
    internal.input({ type: "key", key: "pageDown" })
    expect(internal.choice?.selected).toBe(2)
    internal.input({ type: "key", key: "pageDown" })
    expect(internal.choice?.selected).toBe(2)
    internal.input({ type: "paste", text: "claude" })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(frames.at(-1)).toContain("Engine · filter and selection focus")
    expect(frames.at(-1)).toContain("Filter> claude")
    expect(frames.at(-1)).not.toContain("You> ")
    expect(frames.at(-1)).not.toContain("retained draft")
    expect(app.draftSnapshot().draft).toBe("retained draft")
    internal.input({ type: "key", key: "enter" })
    expect(await result).toBe(2)
    expect(app.draftSnapshot().draft).toBe("retained draft")
    expect(internal.editor.cursor).toBe(4)
    internal.input({ type: "key", key: "ctrl+d" })
    expect(actions).toEqual(["quit"])
    app.close()
  })

  for (const failure of ["incomplete", "throw"] as const) test(`${failure} replay stays visible and blocks new or queued work`, async () => {
    const app = new TuiApp()
    app.resume = () => {}
    const internal = app as unknown as AppInput
    const controller = new AbortController()
    const actions: string[] = []
    app.controls(action => {
      actions.push(action)
      if (action === "quit") controller.abort()
    })
    app.setDraft("retained")
    internal.queue.push("never dispatch")
    app.transcriptSource(() => {
      if (failure === "throw") throw new Error("secret-provider-token")
      return { records: [], complete: false }
    })
    app.queueAdmission(true)
    const result = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, controller.signal)
    let settled = false
    void result.then(() => { settled = true })
    internal.input({ type: "paste", text: "new input\n" })
    internal.input({ type: "key", key: "enter" })
    internal.input({ type: "key", key: "escape" })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(actions).toEqual([])
    expect(app.draftSnapshot()).toEqual({ draft: "retained", queued: ["never dispatch"] })
    expect(internal.transcript.lines().join("\n")).toContain("Session read failure")
    expect(internal.transcript.lines().join("\n")).not.toContain("secret-provider-token")
    internal.input({ type: "key", key: "ctrl+d" })
    expect(await result).toBeUndefined()
    expect(actions).toEqual(["quit"])
    app.close()
  })

  test("nonadvancing history search quarantines input instead of reporting terminal disconnect", () => {
    const app = new TuiApp()
    const internal = app as unknown as AppInput
    const actions: string[] = []
    let broken = false
    app.controls(action => actions.push(action))
    app.transcriptSource(() => ({ records: [], complete: true, ...(broken ? { nextOffset: 0 } : {}) }))
    broken = true
    internal.input({ type: "key", key: "ctrl+r" })
    expect(actions).toEqual([])
    expect(internal.transcript.lines().join("\n")).toContain("Session read failure")
    internal.input({ type: "text", text: "must not enter the draft" })
    expect(app.draftSnapshot().draft).toBe("")
    app.close()
  })
})
