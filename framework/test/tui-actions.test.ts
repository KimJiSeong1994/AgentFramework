import { describe, expect, test } from "bun:test"
import { commandInsertions, interactiveActions, interactiveHelp } from "../src/hosts/interactive-actions.ts"
import { commandCompletions } from "../src/tui/skill-completion.ts"
import { TuiApp } from "../src/tui/app.ts"
import { bodyPanelRows, panelInnerColumns, transcriptViewportRows, wrapText, wrapTranscriptLine } from "../src/tui/render.ts"

const plain = (frame: string | undefined): string => (frame ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")

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
  palette(): { rows: readonly { label: string }[] } | undefined
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

    const frame = plain(frames.at(-1))
    expect(frame).toContain("╭─ Otter · local coding agent ─")
    expect(frame).toContain("▄██▄ ████ ████ ████ ███▄")
    expect(frame).not.toContain("▄███▄  ▄███▄")
    expect(frame).toContain("⬢ local / model-known")
    expect(frame).toContain("No messages yet.")
    expect(frame).toContain("Type, then press Enter.")
    expect(frame).not.toContain("No model is selected.")
    expect(frame).not.toContain("ready")
    app.close()
  })

  test("input box shows workflow step and task progress, and clears when work ends", () => {
    const app = new TuiApp()
    const internal = app as unknown as AppInput
    internal.dimensions = () => ({ columns: 100, rows: 24 })
    internal.currentStatusLines = () => ["status"]
    internal.viewFacts = { selection: { engine: "local", model: "model-known" } }
    const frames: string[] = []
    internal.driver.write = frame => frames.push(frame)
    internal.transcript.append({ provenance: "assistant", text: "hello" })

    app.workflowStatus("ralplan · architect · reviewing", { kind: "ralplan", stage: "architect", phase: "reviewing" })
    expect(plain(frames.at(-1))).toMatch(/╭─ [█░]+ step 2\/5 · ralplan · architect ─/u)

    app.taskSnapshot([{ id: "t1", status: "done", title: "a" }, { id: "t2", status: "running", title: "b" }])
    expect(plain(frames.at(-1))).toContain("1/2 tasks · 50%")

    app.taskSnapshot([{ id: "t2", status: "done" }])
    app.workflowStatus(undefined)
    expect(plain(frames.at(-1))).not.toContain("tasks")
    expect(plain(frames.at(-1))).not.toContain("step ")
    app.close()
  })

  test("spinner animates only while the host reports an in-progress request", async () => {
    const app = new TuiApp()
    const internal = app as unknown as AppInput & { spinnerTimer?: unknown }
    internal.dimensions = () => ({ columns: 80, rows: 24 })
    const frames: string[] = []
    internal.driver.write = frame => frames.push(frame)
    const identity = { mode: "writable" as const, sessionID: "s", epoch: "e" }
    const facts = {
      identity, selection: { engine: "local", model: "m" }, hold: { state: "known" as const, value: { held: false } },
      workflow: { state: "known" as const, value: null }, owner: "current-session" as const, claim: { state: "known" as const, value: false },
      fence: { state: "known" as const, value: false }, termination: "not-observed" as const, discovery: "not-observed" as const,
    }
    app.bindView(identity)
    app.viewSnapshot({ ...facts, request: { state: "not-observed" } })
    expect(internal.spinnerTimer).toBeUndefined()
    app.viewSnapshot({ ...facts, request: { state: "in-progress", operationID: "op-1" } })
    expect(internal.spinnerTimer).toBeDefined()
    const before = frames.length
    await Bun.sleep(1100)
    expect(frames.length).toBeGreaterThan(before)
    const status = frames.at(-1)!.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    expect(status).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Model request · (?:\d+ms|\d+\.\ds) ⟦esc⟧/u)
    expect(status).not.toContain("Model request running")
    app.viewSnapshot({ ...facts, request: { state: "completed", operationID: "op-1" } })
    expect(internal.spinnerTimer).toBeUndefined()
    expect(frames.at(-1)!).not.toContain("Model request running")
    app.viewSnapshot({ ...facts, request: { state: "in-progress", operationID: "op-2" } })
    app.close()
    expect(internal.spinnerTimer).toBeUndefined()
  })

  test("a submitted turn spins until the host asks again; waiting on the user never spins", async () => {
    const app = new TuiApp()
    app.resume = () => {}
    const internal = app as unknown as AppInput & { spinnerTimer?: unknown }
    internal.dimensions = () => ({ columns: 80, rows: 24 })
    const frames: string[] = []
    internal.driver.write = frame => frames.push(frame)
    const first = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, new AbortController().signal)
    expect(internal.spinnerTimer).toBeUndefined()
    internal.input({ type: "text", text: "do the thing" })
    internal.input({ type: "key", key: "enter" })
    expect(await first).toBe("do the thing")
    expect(internal.spinnerTimer).toBeDefined()
    const before = frames.length
    await Bun.sleep(400)
    // The clock redraws on its own; successive frames show different spinner glyphs.
    expect(frames.length).toBeGreaterThan(before + 1)
    const glyphs = new Set(frames.slice(before).map(frame => /([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) Working · /u.exec(plain(frame))?.[1]).filter(Boolean))
    expect(glyphs.size).toBeGreaterThan(1)
    expect(plain(frames.at(-1))).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working · \d+ms ⟦esc⟧/u)
    expect(plain(frames.at(-1))).not.toContain("Otter · working")
    expect(plain(frames.at(-1))).not.toContain("Escape cancels")

    // A choice waits on the user: no spinner, no redraw clock.
    const choice = app.choose("Decide", ["Yes", "No"], new AbortController().signal)
    expect(internal.spinnerTimer).toBeUndefined()
    internal.input({ type: "key", key: "enter" })
    expect(await choice).toBe(0)
    const next = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, new AbortController().signal)
    expect(internal.spinnerTimer).toBeUndefined()
    expect(plain(frames.at(-1))).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u)
    app.close()
    expect(await next).toBeUndefined()
    expect(internal.spinnerTimer).toBeUndefined()
  })

  test("!command renders as a live shell window, not a chat message, and /expand $N shows retained output", async () => {
    const app = new TuiApp()
    app.resume = () => {}
    const internal = app as unknown as AppInput & { spinnerTimer?: unknown; hostWorking: boolean }
    internal.dimensions = () => ({ columns: 80, rows: 40 })
    internal.currentStatusLines = () => ["status"]
    const frames: string[] = []
    internal.driver.write = frame => frames.push(frame)
    const pending = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, new AbortController().signal)
    internal.input({ type: "text", text: "!seq 30" })
    internal.input({ type: "key", key: "enter" })
    expect(await pending).toBe("!seq 30")
    expect(internal.transcript.lines().join("\n")).not.toContain("[You]")

    // Even without a pending submitted turn, a live shell keeps the spinner clock running.
    internal.hostWorking = false
    const view = app.shellStart({ id: "shell:1", command: "seq 30" })
    expect(internal.spinnerTimer).toBeDefined()
    view.output({ lines: ["1", "2"], totalLines: 2, completed: 1, completedTail: ["1"] })
    await Bun.sleep(80)
    expect(plain(frames.at(-1))).toMatch(/┌─── ⠋ Bash ─+┐/u)
    expect(plain(frames.at(-1))).toMatch(/│ \$ seq 30\s+│/u)
    expect(plain(frames.at(-1))).toMatch(/├─── Output ─+┤/u)
    expect(plain(frames.at(-1))).toMatch(/┌─── [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Bash ─+┐/u)
    expect(plain(frames.at(-1))).toMatch(/│ ⟦running · 0s · Esc cancels⟧\s+│/u)

    const all = Array.from({ length: 30 }, (_, index) => String(index + 1))
    view.finish({ status: "complete", exitCode: 0, signal: null, durationMs: 120, lines: all, totalLines: 30 })
    expect(internal.spinnerTimer).toBeUndefined()
    const done = plain(frames.at(-1))
    expect(done).toContain("⟦exit 0 · 120ms⟧")
    expect(done).toContain("… 10 earlier lines · /expand $1")
    expect(done).not.toMatch(/│ 10\s/u)

    const next = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, new AbortController().signal)
    internal.input({ type: "text", text: "/expand $1" })
    internal.input({ type: "key", key: "enter" })
    expect(internal.transcript.lines()).toContain("  | 1")
    expect(internal.transcript.lines().join("\n")).not.toContain("Usage: /expand")
    app.close()
    expect(await next).toBeUndefined()
  })

  test("/ palette lists skills by fuzzy name, Enter inserts the skill, and a typed command still submits", async () => {
    const app = new TuiApp()
    app.resume = () => {}
    const internal = app as unknown as AppInput
    internal.dimensions = () => ({ columns: 100, rows: 30 })
    const frames: string[] = []
    internal.driver.write = frame => frames.push(frame)
    const descriptor = (name: string, description: string) => ({ descriptor: { kind: "skill" as const, source: "home" as const,
      identity: `home:${name}`, name, description }, classification: "custom" as const })
    app.skillCatalog({ entries: [
      { descriptor: { kind: "protected-workflow", source: "builtin", identity: "builtin:deep-interview", name: "deep-interview",
        description: "Socratic deep interview", workflow: "deep-interview" }, classification: "common" },
      descriptor("contribute-pr", "Dump redacted session context"),
    ], refusals: [] } as never)
    const actions: string[] = []
    app.controls(action => actions.push(action))
    const pending = app.readInput({ title: "Chat", hint: "Enter send", prompt: "You> ", kind: "chat" }, new AbortController().signal)
    internal.input({ type: "text", text: "/depp" })
    const frame = plain(frames.at(-1))
    expect(frame).toMatch(/> skill:deep-interview\s{2,}Socratic deep interview/u)
    expect(frame).not.toContain("skill:contribute-pr")
    internal.input({ type: "key", key: "enter" })
    expect(app.draftSnapshot().draft).toBe("/skill:deep-interview ")
    expect(internal.palette()).toBeUndefined()

    // A complete skill name inserts on Enter; it never submits a bare invocation.
    app.setDraft("")
    internal.input({ type: "text", text: "/skill:deep-interview" })
    internal.input({ type: "key", key: "enter" })
    expect(app.draftSnapshot().draft).toBe("/skill:deep-interview ")

    app.setDraft("")
    internal.input({ type: "text", text: "/quit" })
    expect(internal.palette()?.rows[0]?.label).toBe("/quit")
    internal.input({ type: "key", key: "enter" })
    // Enter submits the typed command to the host instead of re-inserting "/quit ".
    expect(await pending).toBe("/quit")
    expect(actions).toEqual([])
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
    expect(internal.palette()?.rows.length).toBeGreaterThan(0)
    internal.editor.cursor = 1

    internal.input({ type: "key", key: "ctrl+c" })
    expect(internal.palette()?.rows.length).toBeGreaterThan(0)
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
    expect(internal.palette()).toBeDefined()
    internal.editor.cursor = 3

    internal.input({ type: "key", key: "ctrl+c" })
    expect(internal.palette()).toBeDefined()
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
    expect(plain(frames.at(-1))).toContain("╭─ Review canonical plan · document focus ─")
    expect(frames.at(-1)).not.toContain("private approval draft")
    expect(frames.at(-1)).not.toContain("You> ")
    expect(frames.at(-1)).toContain("\u001b[?25l")
    const pageRows = Math.max(1, bodyPanelRows({ columns, rows }) - 5 - values.length)
    const totalRows = document.split("\n").flatMap(line => wrapText(line, panelInnerColumns(columns))).length

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
    expect(plain(frames.at(-1))).toContain("╭─ Engine ─")
    expect(plain(frames.at(-1))).toContain("│ Filter> claude")
    expect(plain(frames.at(-1))).toContain("> claude")
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
