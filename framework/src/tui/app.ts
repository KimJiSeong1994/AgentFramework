import type { ShellView, Terminal, TerminalControl } from "../hosts/interactive-session.ts"
import { Editor, searchSubmittedHistory } from "./editor.ts"
import type { InputEvent } from "./keys.ts"
import { belowPanelRows, bodyPanelRows, ellipsize, panelInnerColumns, renderFrame, transcriptViewportRows, transcriptVisualRows, wrapText, type FrameHome } from "./render.ts"
import { TerminalDriver } from "./terminal.ts"
import { MIN_COLUMNS, MIN_ROWS, MIN_SIZE_LABEL } from "./capability.ts"
import { TranscriptModel } from "./transcript-model.ts"
import type { CliHostActivity, CliToolDisplay } from "../hosts/cli-progress.ts"
import type { CliProgressTask } from "../hosts/cli-progress.ts"
import type { ExecutionRunStatus } from "../hosts/run-state.ts"
import type { ReplayOptions, ReplayResult } from "../sessions/store.ts"
import type { SkillCatalog } from "../skills/session.ts"
import { restoreTranscript } from "./session-transcript.ts"
import { commandInsertion, interactiveActions, type InteractiveContext } from "../hosts/interactive-actions.ts"
import { formatPaletteRow, palette, paletteInsertion, paletteLabelColumns, paletteWindow } from "./skill-completion.ts"
import { sameViewIdentity, selectionLabel, type AskAnswer, type AskPrompt, type ChoicePresentation, type InteractiveViewFacts, type TranscriptText, type ViewIdentity } from "../hosts/interactive-view.ts"
import { statusLines } from "./status-view.ts"
import { formatDuration, progressState, renderProgress, type WorkflowProgress } from "./progress.ts"
import { resolveTheme, type ThemeName } from "./theme.ts"
import { WorkspaceLabel } from "./workspace.ts"
import { copyText } from "./clipboard.ts"
import { selectionOverlay, selectionText, type SelectionPoint } from "./selection.ts"

const SPINNER_INTERVAL_MS = 120
const UNICODE_SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const ASCII_SPINNER = "-\\|/"

type Pending = { finish: (text: string | undefined) => void; kind: "chat" | "selection"; title: string }
type Choice = {
  title: string
  values: readonly string[]
  selected: number
  presentation: ChoicePresentation
  focus: "document" | "decisions" | "list"
  documentOffset: number
  documentAnchorLine: number
  documentAnchorOffset: number
  windowStart: number
  filterEditor?: Editor
  finish: (index: number | undefined) => void
}

type AskState = {
  prompt: AskPrompt
  /** Row index; `prompt.options.length` is the automatic custom row. */
  selected: number
  custom?: Editor
  finish: (answer: AskAnswer | undefined) => void
}

const CUSTOM_ANSWER_LIMIT = 2000
/** Transcript rows one mouse-wheel notch scrolls. */
const WHEEL_ROWS = 3

function documentRows(document: string, columns: number): Array<{ text: string; sourceLine: number; sourceOffset: number }> {
  return document.split("\n").flatMap((line, sourceLine) => {
    let sourceOffset = 0
    return wrapText(line, columns).map(text => {
      const row = { text, sourceLine, sourceOffset }
      sourceOffset += text.length
      return row
    })
  })
}

/** Presentation only: plan validation, receipts and execution belong to the shared coordinator. */
export class TuiApp implements Terminal {
  readonly fullscreen = true
  readonly stdinIsTTY = process.stdin.isTTY === true
  readonly stderrIsTTY = process.stderr.isTTY === true
  private readonly editor = new Editor({ platform: process.platform })
  private readonly overlayControls = new Editor({ platform: process.platform })
  private readonly driver = new TerminalDriver(event => this.input(event), () => this.draw(), () => this.control?.("disconnect"))
  private transcript = new TranscriptModel("selection")
  private transcriptQuery: string | undefined
  private scrollOffset = 0
  private catalog?: SkillCatalog
  private source?: (options: ReplayOptions) => ReplayResult
  private pageOffset = 0
  private nextPageOffset?: number
  private readonly pageSize = 200
  private ordinals = new Map<string, number>()
  private expandedCalls = new Set<string>()
  private readonly queue: string[] = []
  private pending?: Pending
  private choice?: Choice
  private askState?: AskState
  private control?: (action: TerminalControl) => void
  private status = "Otter · selection"
  private workflow: string | undefined
  private viewIdentity?: ViewIdentity
  private viewFacts?: InteractiveViewFacts
  private requestStarted?: { operationID: string; at: number }
  // One spinner clock for all live work: a submitted turn the host has not answered yet, an in-progress
  // model request, a running shell or tool call. It stops while input or a choice is waiting on the user.
  private spinnerTimer?: ReturnType<typeof setInterval>
  private busySince?: number
  private hostWorking = false
  // Coalesces bursty shell output into one redraw.
  private shellDraw?: ReturnType<typeof setTimeout>
  private prompt = "You> "
  private lastSubmittedDraft: string | undefined
  private lastSubmittedCursor: number | undefined
  private interactionContext: InteractiveContext = "chat"
  private suspended = false
  private closed = false
  private choiceSettled = false
  private queueAllowed = false
  private detailsVisible = false
  private detailsIndex = 0
  private readFailure = false
  private themeName: ThemeName = "neutral"
  private asciiChrome = false
  private clipboard = copyText
  private copying = false
  private renderedFrame = ""
  private renderedTranscript: readonly string[] = []
  private dragSelection?: {
    anchor: SelectionPoint
    focus: SelectionPoint
    frame: string
    rows: readonly string[]
    transcript: TranscriptModel
    columns: number
    height: number
  }
  private workflowProgress?: WorkflowProgress
  private readonly workspace = new WorkspaceLabel()
  queueAdmission(allowed: boolean): void { this.queueAllowed = allowed && !this.readFailure }
  workflowStatus(line: string | undefined, progress?: WorkflowProgress): void {
    const nextProgress = line === undefined ? undefined : progress
    const sameProgress = this.workflowProgress?.kind === nextProgress?.kind && this.workflowProgress?.stage === nextProgress?.stage &&
      this.workflowProgress?.phase === nextProgress?.phase && this.workflowProgress?.goals?.complete === nextProgress?.goals?.complete &&
      this.workflowProgress?.goals?.total === nextProgress?.goals?.total
    if (this.workflow === line && sameProgress) return
    this.workflow = line
    this.workflowProgress = nextProgress
    this.draw()
  }
  /** Input-box progress line (bar + label) for live work, or undefined when nothing is live. */
  private progressLine(width: number): string | undefined {
    const frame = this.busySince === undefined ? 0 : Math.floor((Date.now() - this.busySince) / SPINNER_INTERVAL_MS)
    const state = progressState({
      tasks: this.transcript.taskCounts(),
      ...(this.workflowProgress ? { workflow: this.workflowProgress } : {}),
      busy: this.busySince !== undefined,
      frame,
      ...(this.transcript.currentTask ? { activity: this.transcript.currentTask } : this.requestStarted ? { activity: "model working" } : {}),
    })
    return state ? renderProgress(state, width, this.asciiChrome) : undefined
  }
  bindView(identity: ViewIdentity): void {
    if (sameViewIdentity(this.viewIdentity, identity)) return
    this.viewIdentity = identity
    this.viewFacts = undefined
    this.trackRequest()
    this.detailsVisible = false
    this.draw()
  }
  viewSnapshot(facts: InteractiveViewFacts): void {
    if (!sameViewIdentity(this.viewIdentity, facts.identity)) return
    this.viewFacts = facts
    this.trackRequest()
    this.draw()
  }

  private trackRequest(): void {
    const request = this.closed ? undefined : this.viewFacts?.request
    if (request?.state === "in-progress") {
      if (this.requestStarted?.operationID !== request.operationID) this.requestStarted = { operationID: request.operationID, at: Date.now() }
    } else this.requestStarted = undefined
    this.syncSpinner()
  }

  private busy(): boolean {
    if (this.closed || this.readFailure) return false
    if (this.requestStarted || this.transcript.liveActivity) return true
    return this.hostWorking && !this.pending && !this.choice && !this.askState
  }
  private syncSpinner(): void {
    if (this.busy() && !this.suspended) {
      this.busySince ??= Date.now()
      if (!this.spinnerTimer) {
        this.spinnerTimer = setInterval(() => this.draw(), SPINNER_INTERVAL_MS)
        this.spinnerTimer.unref?.()
      }
      return
    }
    if (!this.busy()) this.busySince = undefined
    if (this.spinnerTimer) clearInterval(this.spinnerTimer)
    this.spinnerTimer = undefined
  }
  private spinnerGlyph(): string | undefined {
    if (this.busySince === undefined) return undefined
    const frames = this.asciiChrome ? ASCII_SPINNER : UNICODE_SPINNER
    return frames[Math.floor((Date.now() - this.busySince) / SPINNER_INTERVAL_MS) % frames.length]!
  }
  skillCatalog(catalog: SkillCatalog): void {
    this.catalog = catalog
    this.completionIndex = 0
    this.completionDismissed = false
    this.draw()
  }
  sessionChanged(): void {
    if (this.queue.length) this.transcript.append("Queued input expired with the previous session.")
    this.queue.length = 0
    this.queueAllowed = false
    this.workflow = undefined
    this.viewIdentity = undefined
    this.viewFacts = undefined
    this.trackRequest()
    this.detailsVisible = false
    this.catalog = undefined
    this.completionIndex = 0
    this.completionDismissed = false
    this.draw()
  }
  bindSession(sessionID: string): void {
    if (this.transcript.sessionID === sessionID) return
    const previous = this.transcript
    this.transcript = new TranscriptModel(sessionID)
    if (previous.sessionID === "selection") {
      for (const item of previous.items) {
        if (item.kind === "text") this.transcript.append({ provenance: item.provenance, text: item.text })
        else if (item.kind === "shell" && item.status !== "running") {
          this.transcript.shellStarted(item.id, item.command, item.ordinal)
          this.transcript.shellFinished(item.id, { status: item.status, exitCode: item.exitCode, signal: item.signal,
            durationMs: item.durationMs ?? 0, lines: item.lines, totalLines: item.totalLines })
        }
      }
    }
    this.transcriptQuery = undefined
    this.scrollOffset = 0
    this.pageOffset = 0
    this.nextPageOffset = undefined
    this.catalog = undefined
    this.completionIndex = 0
    this.completionDismissed = false
    this.source = undefined
    this.editor.historySearchSource = undefined
    this.ordinals.clear()
    this.expandedCalls.clear()
    this.draw()
  }
  transcriptSource(source: (options: ReplayOptions) => ReplayResult): void {
    this.source = source
    this.editor.historySearchSource = query => {
      try { return searchSubmittedHistory(this.submittedHistory(), query) }
      catch {
        this.quarantineReadFailure()
        return []
      }
    }
    this.reloadTranscript(true)
  }
  private *submittedHistory(): Generator<string> {
    if (!this.source) return
    let offset = 0
    for (;;) {
      const page = this.source({ order: "desc", offset, limit: this.pageSize, kind: "user" })
      if (!page.complete) throw new Error("Submitted history is incomplete; work remains held.")
      for (const record of page.records) if (typeof record.data.text === "string") yield record.data.text
      if (page.nextOffset === undefined) return
      if (page.nextOffset <= offset) throw new Error("Submitted history pagination did not advance.")
      offset = page.nextOffset
    }
  }
  draftSnapshot(): { draft: string; queued: string[] } { return { draft: this.editor.text, queued: [...this.queue] } }
  private reloadTranscript(restoreDraft = false): void {
    if (!this.source) return
    try {
      const replay = this.source({ order: "desc", offset: this.pageOffset, limit: this.pageSize, query: this.transcriptQuery })
      if (!replay.complete) throw new Error("Transcript replay incomplete; session remains held.")
      const model = new TranscriptModel(this.transcript.sessionID)
      const ordinalFor = (executionID: string, callID: string) => this.ordinalFor(executionID, callID)
      const restored = restoreTranscript(model, [...replay.records].reverse(), ordinalFor)
      restoreTranscript(model, replay.relatedRecords ?? [], ordinalFor)
      for (const id of this.expandedCalls) model.toggle(id)
      this.transcript = model
      this.nextPageOffset = replay.nextOffset
      this.scrollOffset = 0
      if (restoreDraft) {
        const history = this.source({ order: "desc", limit: 100, kind: "user" })
        if (!history.complete) throw new Error("Submitted history incomplete; session remains held.")
        this.editor.history = [...history.records].reverse().flatMap(record => typeof record.data.text === "string" ? [record.data.text] : [])
        this.editor.setText(restored.draft)
        if (restored.queued.length) this.transcript.append(`Unsent queued drafts retained (not admitted):\n${restored.queued.map((text, index) => `${index + 1}. ${text}`).join("\n")}`)
      }
    } catch {
      this.nextPageOffset = undefined
      this.quarantineReadFailure()
    }
  }
  private quarantineReadFailure(): void {
    if (!this.readFailure) {
      this.transcript.append({ provenance: "error", text: "Session read failure. New input is blocked; Ctrl+D exits. Active work is not confirmed stopped." })
    }
    this.readFailure = true
    this.queueAllowed = false
    this.detailsVisible = false
    this.draw()
  }
  private ordinalFor(executionID: string, callID: string): number {
    const key = JSON.stringify([executionID, callID])
    if (!this.ordinals.has(key)) this.ordinals.set(key, this.ordinals.size + 1)
    return this.ordinals.get(key)!
  }
  toolDisplay(display: CliToolDisplay): void {
    this.transcript.toolDisplay(display)
    this.draw()
  }
  activity(activity: CliHostActivity): void {
    this.transcript.activity(activity, activity.kind === "tool-started" || activity.kind === "tool-finished" ? this.ordinalFor(activity.executionID, activity.callID) : undefined)
    this.draw()
  }
  taskSnapshot(tasks: readonly CliProgressTask[]): void { this.transcript.taskSnapshot(tasks); this.draw() }
  queueActivity(message: string, fields?: Record<string, unknown>): void {
    if (!fields || typeof fields.task !== "string") return
    if (message === "task start" || message === "data task start") this.taskSnapshot([{ id: fields.task, status: "running" }])
    if (message === "task finished" && ["done", "failed", "cancelled"].includes(String(fields.status))) {
      this.taskSnapshot([{ id: fields.task, status: fields.status as "done" | "failed" | "cancelled" }])
    }
  }
  executionSnapshot(state: ExecutionRunStatus, active: boolean): void { this.transcript.executionSnapshot(state, active); this.draw() }
  private completionIndex = 0
  private completionDismissed = false
  /** The `/` palette for the current draft: commands and invocable skills, fuzzy-matched. */
  private palette() {
    if (this.readFailure || this.choice || this.askState || this.editor.searchState || this.completionDismissed || this.pending?.kind === "selection") return undefined
    return palette(this.catalog, this.editor.text, this.interactionContext)
  }

  // The renderer owns terminal escapes; shared coordinator prose stays plain.
  presentation = () => ({ columns: process.stdout.columns, color: false })
  controls(handler: (action: TerminalControl) => void): void { this.control = handler }
  actionContext(context: InteractiveContext): void {
    if (this.interactionContext === context) return
    this.interactionContext = context
    this.completionIndex = 0
    this.completionDismissed = false
    this.draw()
  }
  setDraft(draft: string): void {
    this.editor.setText(draft)
    this.completionIndex = 0
    this.completionDismissed = true
    this.draw()
  }
  private dimensions() { return { columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 } }
  private separator(): string { return this.asciiChrome ? " | " : " · " }
  private usable(): boolean { const size = this.dimensions(); return size.columns >= MIN_COLUMNS && size.rows >= MIN_ROWS }

  private transcriptScrollBounds(): { pageRows: number; maximumOffset: number } {
    const { columns, rows } = this.dimensions()
    const viewportRows = transcriptViewportRows({ columns, rows, draft: this.editor.text, cursor: this.editor.cursor, prompt: this.prompt })
    const visualRows = transcriptVisualRows(this.transcript.lines(this.transcriptQuery), columns, this.asciiChrome)
    return { pageRows: Math.max(1, viewportRows), maximumOffset: Math.max(0, visualRows - viewportRows) }
  }

  /** Scrolls the transcript by `rows` (a page by default); at either edge it pages the stored conversation. */
  private scrollTranscript(direction: "older" | "newer", rows?: number): void {
    const { pageRows, maximumOffset } = this.transcriptScrollBounds()
    const step = rows ?? pageRows
    this.scrollOffset = Math.min(this.scrollOffset, maximumOffset)
    if (direction === "older") {
      if (this.scrollOffset < maximumOffset) this.scrollOffset = Math.min(maximumOffset, this.scrollOffset + step)
      else if (this.source && this.nextPageOffset !== undefined) {
        this.pageOffset = this.nextPageOffset
        this.reloadTranscript()
      }
    } else if (this.scrollOffset > 0) {
      this.scrollOffset = Math.max(0, this.scrollOffset - step)
    } else if (this.source && this.pageOffset > 0) {
      this.pageOffset = Math.max(0, this.pageOffset - this.pageSize)
      this.reloadTranscript()
    }
    this.draw()
  }

  /** Content rows inside a bordered body panel; the composer is hidden there. */
  private panelRows(): number {
    return bodyPanelRows(this.dimensions())
  }

  /** Rows a list may use beneath the composer for the given composer text. */
  private belowRows(draft: string, prompt: string): number {
    return belowPanelRows({ ...this.dimensions(), draft, cursor: draft.length, prompt })
  }

  private approvalPageRows(choice: Choice): number {
    return Math.max(1, this.panelRows() - 5 - choice.values.length)
  }

  private pickerWindowRows(choice: Choice): number {
    if (choice.presentation.kind !== "picker") return 1
    const filter = choice.filterEditor?.text ?? ""
    const hintRows = choice.presentation.hint === undefined ? 0 : 1
    return Math.max(1, Math.min(10, this.belowRows(filter, "Filter> ") - 2 - hintRows))
  }

  private currentStatusLines(): string[] {
    if (this.readFailure) return ["History unavailable | new input blocked", "Ctrl+D exit | active work may remain"]
    const { columns } = this.dimensions()
    const frame = this.spinnerGlyph()
    const overlayHint = this.choice?.presentation.kind === "picker"
      ? ["Up/Down move", `Enter ${this.choice.presentation.purpose === "command" ? "inserts" : "selects"}`, "Esc back", "Ctrl+D quit"].join(this.separator())
      : this.detailsVisible ? ["Details", "Up/Down move", "Enter expands", "Esc closes", "Ctrl+D quits"].join(this.separator()) : undefined
    const live = overlayHint === undefined ? this.liveRow(frame) : undefined
    // A choice or ask owns the input: its hint replaces the stale "working" text from the turn that opened it.
    const awaitingAnswer = this.askState !== undefined || (this.choice !== undefined && this.choice.presentation.kind !== "picker")
    const activity = overlayHint ?? (awaitingAnswer ? "Waiting for your choice" : this.status)
    // The live row already names the workflow stage; repeat the workflow line only when the row does not.
    const liveNamesStage = live !== undefined && this.workflowProgress !== undefined && live.includes(`${this.workflowProgress.kind}${this.separator()}${this.workflowProgress.stage}`)
    return statusLines({
      facts: this.viewFacts,
      selectionInHeader: true,
      ...(liveNamesStage ? {} : { workflow: this.workflow }),
      activity,
      ...(live !== undefined ? { live } : {}),
      search: this.transcriptQuery,
      queued: this.queue.length,
      columns,
      ...(!this.usable() ? { notice: `Resize terminal to at least ${MIN_SIZE_LABEL}. Cancellation remains available.` } : {}),
      ascii: this.asciiChrome,
    })
  }

  /** GJC-style muted hint inside an empty chat composer; it names only actions valid in the current context. */
  private composerPlaceholder(prompt: string): string | undefined {
    if (prompt !== "You> " && prompt !== "History> ") return undefined
    const keys = this.separator()
    switch (this.interactionContext) {
      case "chat": return ["Type a message", "Drag to copy", "/ commands", "! shell", "Ctrl+R history", "Ctrl+J newline", "Ctrl+C clear"].join(keys)
      case "unselected": return ["Choose a model with /model", "/ commands", "! shell", "/quit exit"].join(keys)
      case "held": return ["Session held", "/status explains", "/ commands", "! shell"].join(keys)
      case "observer": return ["Another session owns the active workflow", "/model switch", "/status", "! shell"].join(keys)
      case "read-only": return ["Read-only history", "/resume or /new to switch", "/ commands"].join(keys)
      default: return undefined
    }
  }

  private cursorGlyph(): string { return this.asciiChrome ? ">" : "❯" }
  private selectHint(): string {
    return (this.asciiChrome ? ["Up/Down move", "Enter select", "1-9 jump", "Esc cancel"] : ["↑↓ move", "Enter select", "1-9 jump", "Esc cancel"]).join(this.separator())
  }
  private askRows(ask: AskState): string[] {
    const labels = ask.prompt.options.map((option, index) => `${option.label}${ask.prompt.recommended === index ? " (Recommended)" : ""}`)
    if (ask.prompt.allowCustom) labels.push(ask.prompt.customLabel ?? "Other (type your own)")
    return labels.map((label, index) => `${index === ask.selected ? this.cursorGlyph() : " "} ${index + 1}. ${label}`)
  }
  private askRowCount(ask: AskState): number { return ask.prompt.options.length + (ask.prompt.allowCustom ? 1 : 0) }

  /** `<spinner> <most specific step> · <elapsed> ⟦esc⟧` while work is live; undefined when nothing is running. */
  private liveRow(frame: string | undefined): string | undefined {
    if (frame === undefined || this.busySince === undefined) return undefined
    const step = this.transcript.liveStep
    const progress = this.workflowProgress
    const label = step?.label ?? this.transcript.liveTask ??
      (progress ? `${progress.kind}${this.separator()}${progress.stage}` : undefined) ??
      (this.requestStarted ? "Model request" : "Working")
    const since = step?.startedAt ?? this.requestStarted?.at ?? this.busySince
    const esc = this.asciiChrome ? "[esc]" : "⟦esc⟧"
    return `${frame} ${label}${this.separator()}${formatDuration(Date.now() - since)} ${esc}`
  }

  private pickerMatches(choice: Choice): number[] {
    const presentation = choice.presentation
    if (presentation.kind !== "picker") return []
    const filter = (choice.filterEditor?.text ?? "").toLocaleLowerCase()
    return choice.values.flatMap((value, index) =>
      !filter || `${value} ${presentation.rows[index] ?? ""}`
        .toLocaleLowerCase().includes(filter) ? [index] : [])
  }

  /** Empty-session welcome content; selection text comes only from authoritative view facts. */
  private homeScreen(): FrameHome {
    const ascii = this.asciiChrome
    const logo = ascii
      ? [" OO  TTTT TTTT EEEE RRR ", "O  O  TT   TT  EEE  R  R", "O  O  TT   TT  E    RRR ", " OO   TT   TT  EEEE R  R"]
      : ["▄██▄ ████ ████ ████ ███▄", "█  █  ██   ██  █▄▄  █  █", "█  █  ██   ██  █    ███▀", "▀██▀  ██   ██  ████ █ ▀▄"]
    const selection = this.viewFacts ? selectionLabel(this.viewFacts.selection) : undefined
    const keys = this.separator()
    return {
      title: "Otter · local coding agent",
      left: ["", ...logo, "", "plan · approve · prove", "", selection ? `${ascii ? "*" : "⬢"} ${selection}` : "No model is selected."],
      sections: this.interactionContext === "observer"
        ? [
          { heading: "Observing", lines: ["Another session owns the active workflow;", "new chat waits until it is resolved.", "/resume <owner>  open it to continue or /cancel", "/model  switch model"] },
          { heading: "Flow keys", lines: [["/ commands", "! shell"].join(keys), ["Ctrl+R history", "Wheel/PgUp scroll"].join(keys)] },
        ]
        : this.interactionContext === "held"
        ? [
          { heading: "Session held", lines: ["New chat waits until the active work is resolved.", "/status  why, and what to do", "/sessions  open another session"] },
          { heading: "Flow keys", lines: [["/ commands", "! shell"].join(keys), ["Ctrl+R history", "Wheel/PgUp scroll"].join(keys)] },
        ]
        : this.interactionContext === "unselected"
        ? [
          { heading: "Get started", lines: ["/model  choose a model", "/help   commands and keys", "/quit   leave"] },
          { heading: "Flow keys", lines: [["/ commands", "Ctrl+R history"].join(keys), ["Ctrl+J newline", "Ctrl+C clear"].join(keys)] },
        ]
        : [
          { heading: "Get started", lines: ["No messages yet.", "Type, then press Enter.", "/model  switch model", "/model default  keep it"] },
          { heading: "Flow keys", lines: [["/ commands", "Ctrl+R history"].join(keys), ["Ctrl+J newline", "Wheel/PgUp scroll"].join(keys)] },
        ],
    }
  }

  private draw(): void {
    this.syncSpinner()
    if (this.suspended || this.closed) return
    const drag = this.dragSelection
    if (drag) {
      const dimensions = this.dimensions()
      if (drag.transcript === this.transcript && dimensions.columns === drag.columns && dimensions.rows === drag.height &&
          !this.choice && !this.askState && !this.detailsVisible && !this.readFailure && this.pending?.kind !== "selection") {
        this.driver.write(drag.frame + selectionOverlay(drag.rows, drag.anchor, drag.focus) + "\x1b[?25l")
        return
      }
      this.dragSelection = undefined
    }
    let lines = this.transcript.lines(this.transcriptQuery)
    let panel: NonNullable<Parameters<typeof renderFrame>[0]["panel"]> | undefined
    let screen = this.pending?.kind === "selection" ? this.pending.title : "Chat"
    let composerVisible = true
    let draft = this.editor.text
    let cursor = this.editor.cursor
    let prompt = this.prompt
    if (this.readFailure) {
      screen = "Read-only history"
      panel = {
        title: "Session read failure",
        focus: "new input blocked",
        placement: "body",
        lines: [
        "The retained history could not be read safely.",
        "New messages, queued input and approval decisions are blocked.",
        "Ctrl+D exits. Inspect read-only otter status before reopening.",
        "Active work is not confirmed stopped.",
        ],
      }
      composerVisible = false
    } else if (this.choice?.presentation.kind === "approval") {
      const columns = panelInnerColumns(this.dimensions().columns)
      const wrapped = documentRows(this.choice.presentation.document, columns)
      const availableRows = this.approvalPageRows(this.choice)
      const maximumOffset = Math.max(0, wrapped.length - availableRows)
      const anchoredOffset = wrapped.findIndex(row =>
        row.sourceLine > this.choice!.documentAnchorLine ||
        row.sourceLine === this.choice!.documentAnchorLine && row.sourceOffset >= this.choice!.documentAnchorOffset)
      this.choice.documentOffset = Math.min(anchoredOffset < 0 ? maximumOffset : anchoredOffset, maximumOffset)
      const end = Math.min(wrapped.length, this.choice.documentOffset + availableRows)
      const binding = this.choice.presentation.binding
      const fixed = (value: string) => wrapText(value, columns)[0] ?? ""
      screen = "Approval"
      panel = {
        title: this.choice.title,
        focus: this.choice.focus,
        placement: "body",
        lines: [
        fixed(`source ${binding.path}`),
        fixed(`session ${binding.sessionID}${this.separator()}workflow ${binding.workflowID}${this.separator()}rev ${binding.expectedRevision}`),
        fixed(`plan sha256 ${binding.planSha}`),
        fixed(`Document rows ${wrapped.length ? this.choice.documentOffset + 1 : 0}-${end}/${wrapped.length}${this.separator()}Up/Down scroll${this.separator()}PageUp/PageDown page`),
        ...wrapped.slice(this.choice.documentOffset, end).map(row => row.text),
        `Decisions${this.separator()}Enter acts only while decisions are focused${this.separator()}Escape keeps pending`,
        ...this.choice.values.map((value, index) => `${this.choice!.focus === "decisions" && index === this.choice!.selected ? ">" : " "} ${value}`),
        ],
      }
      composerVisible = false
    } else if (this.choice?.presentation.kind === "generic-list") {
      const height = Math.max(1, this.panelRows() - 3)
      const maximumStart = Math.max(0, this.choice.values.length - height)
      this.choice.windowStart = Math.max(0, Math.min(maximumStart, this.choice.windowStart))
      if (this.choice.selected < this.choice.windowStart) this.choice.windowStart = this.choice.selected
      if (this.choice.selected >= this.choice.windowStart + height) this.choice.windowStart = this.choice.selected - height + 1
      const end = Math.min(this.choice.values.length, this.choice.windowStart + height)
      const detail = this.choice.presentation.rows[this.choice.selected]
      screen = this.choice.title
      panel = {
        title: this.choice.title,
        focus: "list selection",
        placement: "body",
        lines: [
        `${this.choice.selected + 1}/${this.choice.values.length}${this.separator()}showing ${this.choice.windowStart + 1}-${end}`,
        ...this.choice.values.slice(this.choice.windowStart, end).map((value, index) =>
          `${this.choice!.windowStart + index === this.choice!.selected ? ">" : " "} ${value}`),
        ...(detail ? [`Selected: ${detail}`] : []),
        "Up/Down move · PageUp/PageDown page · Enter opens · Escape cancels",
        ],
      }
      composerVisible = false
    } else if (this.choice?.presentation.kind === "picker") {
      const filter = this.choice.filterEditor?.text ?? ""
      const height = this.pickerWindowRows(this.choice)
      const matches = this.pickerMatches(this.choice)
      if (this.choice.selected >= matches.length) this.choice.selected = Math.max(0, matches.length - 1)
      this.choice.windowStart = Math.max(0, Math.min(Math.max(0, matches.length - height), this.choice.windowStart))
      if (this.choice.selected < this.choice.windowStart) this.choice.windowStart = this.choice.selected
      if (this.choice.selected >= this.choice.windowStart + height) this.choice.windowStart = this.choice.selected - height + 1
      const end = Math.min(matches.length, this.choice.windowStart + height)
      const selectedOriginal = matches[this.choice.selected]
      const selectedDetail = selectedOriginal === undefined ? undefined : this.choice.presentation.rows[selectedOriginal]
      screen = this.choice.title
      panel = {
        title: this.choice.title,
        focus: "filter and selection",
        placement: "below",
        lines: [
        ...(this.choice.presentation.hint ? [this.choice.presentation.hint] : []),
        ...matches.slice(this.choice.windowStart, end).map((original, index) =>
          `${this.choice!.windowStart + index === this.choice!.selected ? ">" : " "} ${this.choice!.values[original]}`),
        [
          `(${matches.length ? this.choice.selected + 1 : 0}/${matches.length}) ${matches.length} matches${this.separator()}showing ${matches.length ? `${this.choice.windowStart + 1}-${end}` : "0"}`,
          ...(selectedDetail && selectedDetail !== this.choice.values[selectedOriginal!] ? [`Selected: ${selectedDetail}`] : []),
          ...(matches.length ? [] : ["No matching choices."]),
        ].join(this.separator()),
        ],
      }
      draft = filter
      cursor = this.choice.filterEditor?.cursor ?? filter.length
      prompt = "Filter> "
    } else if (this.choice) {
      screen = this.choice.title
      const rows = this.choice.values.map((value, i) => `${i === this.choice!.selected ? this.cursorGlyph() : " "} ${i + 1}. ${value}`)
      panel = {
        title: this.choice.title,
        focus: "choice selection",
        placement: "body",
        lines: [...rows, "", this.selectHint()],
        accentLines: [this.choice.selected],
        mutedLines: [rows.length + 1],
      }
      composerVisible = false
    } else if (this.askState) {
      const ask = this.askState
      screen = "Question"
      if (ask.custom) {
        panel = {
          title: "Question",
          focus: "custom answer",
          placement: "below",
          lines: [...ask.prompt.question.split("\n"), ["Enter submit", "Esc back to options"].join(this.separator())],
        }
        draft = ask.custom.text
        cursor = ask.custom.cursor
        prompt = "Answer> "
      } else {
        const rows = this.askRows(ask)
        const detail = ask.prompt.options[ask.selected]?.detail
        const question = ask.prompt.question.split("\n")
        panel = {
          title: "Question",
          focus: "answer selection",
          placement: "body",
          lines: [...question, "", ...rows, ...(detail ? ["", ...detail.split("\n").map(line => `  ${line}`)] : []), "", this.selectHint()],
          accentLines: [question.length + 1 + ask.selected],
          mutedLines: [...(detail ? Array.from({ length: detail.split("\n").length }, (_, i) => question.length + 1 + rows.length + 1 + i) : []),
            question.length + 1 + rows.length + (detail ? detail.split("\n").length + 1 : 0) + 1],
        }
        composerVisible = false
      }
    }
    const search = this.readFailure ? undefined : this.editor.searchState
    if (search && !panel) {
      const first = Math.max(0, search.selected - 4)
      panel = {
        title: "History search",
        focus: "query and results",
        placement: "below",
        lines: [
          ...search.results.slice(first, first + 8).map((value, index) => `${index + first === search.selected ? ">" : " "} ${value}`),
          [`${search.results.length ? search.selected + 1 : 0}/${search.results.length} matches`, "Up/Down navigate", "Enter selects", "Escape cancels"].join(this.separator()),
        ],
      }
      screen = "History search"
      draft = search.query
      cursor = search.query.length
      prompt = "History> "
    }
    const suggestions = this.palette()
    if (suggestions && !panel) {
      const { columns } = this.dimensions()
      const maximumRows = Math.min(8, Math.max(1, this.belowRows(this.editor.text, this.prompt) - 1))
      const visible = paletteWindow(suggestions.rows, this.completionIndex, maximumRows)
      const labelColumns = paletteLabelColumns(suggestions.rows)
      const panelLines = visible.rows.map((row, index) =>
        `${visible.start + index === this.completionIndex ? this.cursorGlyph() : " "} ${ellipsize(formatPaletteRow(row, labelColumns), Math.max(1, columns - 2), this.asciiChrome)}`)
      if (!panelLines.length) panelLines.push(this.catalog ? "No matching skills" : "No skill catalog is available for this session")
      const position = suggestions.rows.length
        ? [`(${Math.min(suggestions.rows.length, this.completionIndex + 1)}/${suggestions.rows.length})`] : []
      panelLines.push([...position, this.asciiChrome ? "Up/Down move" : "↑↓ move", "Tab/Enter insert", "Esc dismiss"].join(this.separator()))
      panel = { title: suggestions.skillsOnly ? "Skills" : "Commands", focus: "composer", placement: "below", columns: true, lines: panelLines }
      screen = suggestions.skillsOnly ? "Skill suggestions" : "Command suggestions"
    }
    if (this.detailsVisible && !this.choice && !this.askState && !panel) {
      const details = this.transcript.details()
      this.detailsIndex = Math.max(0, Math.min(Math.max(0, details.length - 1), this.detailsIndex))
      const selected = details[this.detailsIndex]
      const contentRows = Math.max(1, this.panelRows() - 1)
      const visibleDetailCount = Math.min(5, Math.max(1, Math.floor((contentRows - 1) / 2)))
      const selectedLines = Math.max(0, contentRows - visibleDetailCount - 1)
      const detailStart = Math.max(0, this.detailsIndex - visibleDetailCount + 1)
      const detailRows = details.map((detail, index) => `${index === this.detailsIndex ? ">" : " "} ${detail.summary}`)
      panel = {
        title: "Task/evidence details",
        focus: "evidence list",
        placement: "body",
        lines: [
          `${details.length ? `${this.detailsIndex + 1}/${details.length}` : "empty"}`,
          ...(detailRows.length ? detailRows.slice(detailStart, detailStart + visibleDetailCount) : ["No task evidence is available."]),
          ...(selected ? selected.lines.slice(0, selectedLines).map(line => `  ${line}`) : []),
        ],
      }
      screen = "Task/evidence details"
      composerVisible = false
    }
    const home = this.transcript.items.length === 0 && panel?.placement !== "body" ? this.homeScreen() : undefined
    if (home && !panel) screen = "Home"
    if (panel?.placement === "body") composerVisible = false
    if (!composerVisible) { draft = ""; cursor = 0; prompt = "" }
    this.renderedFrame = renderFrame({ ...this.dimensions(), transcript: panel?.placement === "body" ? [] : lines,
      onTranscriptRows: rows => { this.renderedTranscript = rows },
      header: {
        screen,
        ...(this.viewFacts ? { selection: selectionLabel(this.viewFacts.selection) } : {}),
        context: this.workspace.value(this.asciiChrome),
      },
      ...(panel ? { panel } : {}),
      composerVisible,
      ...(panel?.placement === "below" ? { composerTitle: panel.title } : {}),
      ...(composerVisible && panel?.placement !== "below" ? (() => {
        const line = this.progressLine(Math.max(1, this.dimensions().columns - 6))
        return line ? { progress: line } : {}
      })() : {}),
      transcriptOffset: panel || this.readFailure ? 0 : this.scrollOffset,
      ...(!panel && !this.readFailure ? {
        transcriptOlder: this.nextPageOffset !== undefined,
        transcriptNewer: this.pageOffset > 0,
      } : {}),
      ...(home ? { home } : {}),
      status: this.currentStatusLines(),
      draft,
      cursor,
      prompt,
      ...(composerVisible && !panel && this.composerPlaceholder(prompt) ? { placeholder: this.composerPlaceholder(prompt)! } : {}),
      color: process.env.NO_COLOR === undefined,
      theme: resolveTheme(this.themeName),
      ascii: this.asciiChrome,
      ...(this.spinnerGlyph() !== undefined ? { spinner: this.spinnerGlyph()! } : {}),
    })
    this.driver.write(this.renderedFrame)
  }

  private askInput(ask: AskState, event: Exclude<InputEvent, { type: "mouse" }>): void {
    if (event.type === "key" && event.key === "ctrl+d") { this.control?.("quit"); return }
    if (event.type === "key" && event.key === "ctrl+c") {
      if (this.overlayControls.handle(event) === "shutdown") this.control?.("shutdown")
      return
    }
    if (ask.custom) {
      if (event.type === "text" || event.type === "paste") {
        const remaining = Math.max(0, CUSTOM_ANSWER_LIMIT - ask.custom.text.length)
        ask.custom.handle({ type: event.type, text: event.text.replace(/[\r\n\t]/gu, " ").slice(0, remaining) })
      } else if (event.key === "escape") ask.custom = undefined
      else if (event.key === "enter") {
        const text = ask.custom.text.trim()
        if (!text) return
        ask.finish({ kind: "custom", text: text.slice(0, CUSTOM_ANSWER_LIMIT) })
        return
      } else if (["backspace", "delete", "left", "right", "home", "end", "ctrl+a", "ctrl+e"].includes(event.key)) ask.custom.handle(event)
      this.draw()
      return
    }
    const count = this.askRowCount(ask)
    const activate = (row: number): void => {
      if (row < ask.prompt.options.length) ask.finish({ kind: "option", index: row })
      else { ask.selected = row; ask.custom = new Editor({ platform: process.platform }); this.draw() }
    }
    if (event.type === "text" && /^[1-9]$/u.test(event.text)) {
      if (Number(event.text) - 1 < count) activate(Number(event.text) - 1)
      return
    }
    if (event.type !== "key") return
    if (event.key === "escape") { ask.finish(undefined); return }
    if (event.key === "up") ask.selected = (ask.selected + count - 1) % count
    else if (event.key === "down" || event.key === "tab") ask.selected = (ask.selected + 1) % count
    else if (event.key === "enter") { activate(ask.selected); return }
    this.draw()
  }

  private async copyAnswer(): Promise<void> {
    if (this.copying || this.closed || this.suspended) return
    const transcript = this.transcript
    const answer = transcript.items.findLast(item => item.kind === "text" && item.provenance === "assistant" && item.text.trim())
    if (!answer || answer.kind !== "text") {
      transcript.append("No assistant answer to copy in this transcript page.")
      this.draw()
      return
    }
    await this.copyToClipboard(answer.text, "Answer")
  }

  private async copyToClipboard(text: string, label: string): Promise<void> {
    if (this.copying || this.closed || this.suspended || !text.trim()) return
    const transcript = this.transcript
    this.copying = true
    try {
      const destination = await this.clipboard(text, sequence => {
        if (this.closed || this.suspended) throw new Error("Terminal unavailable")
        this.driver.write(sequence)
      })
      if (!this.closed && this.transcript === transcript) {
        transcript.append(destination === "native" ? `${label} copied to clipboard.` :
          "Copy request sent to terminal (requires OSC 52 clipboard support).")
      }
    } catch {
      if (!this.closed && this.transcript === transcript) transcript.append("Could not copy the answer. Try selecting text with Shift+drag and your terminal's Copy command.")
    } finally {
      this.copying = false
      this.draw()
    }
  }

  private mouseInput(event: Extract<InputEvent, { type: "mouse" }>): void {
    if (this.closed || this.suspended || this.readFailure || this.choiceSettled || this.choice || this.askState ||
        this.detailsVisible || this.editor.searchState || this.pending?.kind === "selection" || !this.usable()) return
    const point = { x: event.x, y: event.y }
    if (event.action === "down") {
      this.dragSelection = undefined
      if (this.copying || !this.renderedFrame || event.y > this.renderedTranscript.length) return
      const { columns, rows } = this.dimensions()
      this.dragSelection = { anchor: point, focus: point, frame: this.renderedFrame,
        rows: this.renderedTranscript, transcript: this.transcript, columns, height: rows }
      return
    }
    const drag = this.dragSelection
    if (!drag) return
    drag.focus = point
    if (event.action === "move") {
      this.draw()
      return
    }
    this.dragSelection = undefined
    const moved = drag.anchor.x !== point.x || drag.anchor.y !== point.y
    const text = moved ? selectionText(drag.rows, drag.anchor, point) : ""
    if (text.trim()) void this.copyToClipboard(text, "Selected text")
    this.draw()
  }

  private input(event: InputEvent): void {
    if (event.type === "mouse") {
      this.mouseInput(event)
      return
    }
    // Keyboard and wheel input resume the live view and cancel an unfinished selection.
    if (this.dragSelection) this.dragSelection = undefined
    if (this.readFailure) {
      if (event.type === "key" && event.key === "ctrl+d") this.control?.("quit")
      else if (event.type === "key" && event.key === "ctrl+c" && this.overlayControls.handle(event) === "shutdown") this.control?.("shutdown")
      return
    }
    if (this.choiceSettled) {
      if (event.type === "key" && event.key === "ctrl+d") this.control?.("quit")
      else if (event.type === "key" && event.key === "ctrl+c" && this.overlayControls.handle(event) === "shutdown") this.control?.("shutdown")
      return
    }
    const suggestions = this.palette()
    const overlayVisible = !!this.choice || !!this.askState || !!this.editor.searchState || !!suggestions || this.detailsVisible
    if (event.type === "key" && event.key === "ctrl+y" && !this.choice && !this.askState &&
        !this.editor.searchState && !this.detailsVisible && this.pending?.kind !== "selection" &&
        interactiveActions(this.interactionContext).some(action => action.id === "copy")) {
      void this.copyAnswer()
      return
    }
    if (event.type === "key" && (event.key === "wheelUp" || event.key === "wheelDown")) {
      // The mouse wheel scrolls the conversation; in an overlay it moves the selection. It never recalls input history.
      if (!this.usable()) return
      if (!overlayVisible) {
        this.scrollTranscript(event.key === "wheelUp" ? "older" : "newer", WHEEL_ROWS)
        return
      }
      if (this.editor.searchState) return
      event = { type: "key", key: event.key === "wheelUp" ? "up" : "down" }
    }
    if (!overlayVisible && this.usable() && event.type === "key" && (event.key === "pageUp" || event.key === "pageDown" || event.key === "pageup" || event.key === "pagedown")) {
      this.scrollTranscript(event.key.toLowerCase() === "pageup" ? "older" : "newer")
      return
    }
    if (event.type === "key" && event.key === "ctrl+z") { this.control?.("suspend"); return }
    if (!this.usable() && !(event.type === "key" && ["ctrl+c", "ctrl+d", "escape"].includes(event.key))) return
    if (this.askState) {
      this.askInput(this.askState, event)
      return
    }
    if (this.choice) {
      if (event.type === "key" && event.key === "escape") { this.choice.finish(undefined); return }
      if (event.type === "key" && event.key === "ctrl+d") { this.control?.("quit"); return }
      if (event.type === "key" && event.key === "ctrl+c") {
        if (this.overlayControls.handle(event) === "shutdown") this.control?.("shutdown")
        return
      }
      if (this.choice.presentation.kind === "picker") {
        const matches = this.pickerMatches(this.choice)
        if (event.type === "text" || event.type === "paste") {
          const remaining = Math.max(0, 256 - (this.choice.filterEditor?.text.length ?? 0))
          const text = event.text.replace(/[\r\n\t]/gu, " ").slice(0, remaining)
          if (event.type === "text") this.choice.filterEditor?.handle({ type: "text", text })
          else this.choice.filterEditor?.handle({ type: "paste", text })
          this.choice.selected = 0
          this.choice.windowStart = 0
        } else if (event.type === "key") {
          if (event.key === "enter") {
            const command = this.choice.filterEditor?.text.trim().toLocaleLowerCase()
            if (command === "/cancel" || command === "escape") this.choice.finish(undefined)
            else if (command === "/quit") this.control?.("quit")
            else if (matches.length) this.choice.finish(matches[this.choice.selected]!)
            else return
          } else if (event.key === "up" || event.key === "down" || event.key === "tab") {
            if (matches.length) {
              const direction = event.key === "up" ? -1 : 1
              this.choice.selected = (this.choice.selected + direction + matches.length) % matches.length
            }
          } else if (event.key === "pageUp" || event.key === "pageup" || event.key === "pageDown" || event.key === "pagedown") {
            if (matches.length) {
              const page = this.pickerWindowRows(this.choice)
              this.choice.selected = Math.max(0, Math.min(matches.length - 1,
                this.choice.selected + (event.key.toLowerCase() === "pageup" ? -page : page)))
            }
          } else if (["backspace", "delete", "left", "right", "home", "end", "ctrl+a", "ctrl+e"].includes(event.key)) {
            this.choice.filterEditor?.handle(event)
            this.choice.selected = 0
            this.choice.windowStart = 0
          }
        }
        this.draw()
        return
      }
      // Paste and multi-character text can never answer a choice, much less mint an execution receipt.
      // A single typed digit jumps only in plain lists; approvals and generic lists ignore it.
      if (event.type === "text" && this.choice.presentation.kind === "plain" && /^[1-9]$/u.test(event.text)) {
        const jump = Number(event.text) - 1
        if (jump < this.choice.values.length) this.choice.finish(jump)
        return
      }
      if (event.type !== "key") return
      if (this.choice.presentation.kind === "approval") {
        const columns = panelInnerColumns(this.dimensions().columns)
        const wrapped = documentRows(this.choice.presentation.document, columns)
        const totalRows = wrapped.length
        const pageRows = this.approvalPageRows(this.choice)
        const maximumOffset = Math.max(0, totalRows - pageRows)
        if (event.key === "tab") this.choice.focus = this.choice.focus === "document" ? "decisions" : "document"
        else if (event.key === "pageUp" || event.key === "pageup") this.choice.documentOffset = Math.max(0, this.choice.documentOffset - pageRows)
        else if (event.key === "pageDown" || event.key === "pagedown") this.choice.documentOffset = Math.min(maximumOffset, this.choice.documentOffset + pageRows)
        else if (event.key === "up") {
          if (this.choice.focus === "document") this.choice.documentOffset = Math.max(0, this.choice.documentOffset - 1)
          else this.choice.selected = (this.choice.selected + this.choice.values.length - 1) % this.choice.values.length
        } else if (event.key === "down") {
          if (this.choice.focus === "document") this.choice.documentOffset = Math.min(maximumOffset, this.choice.documentOffset + 1)
          else this.choice.selected = (this.choice.selected + 1) % this.choice.values.length
        } else if (event.key === "enter" && this.choice.focus === "decisions") { this.choice.finish(this.choice.selected); return }
        this.choice.documentAnchorLine = wrapped[this.choice.documentOffset]?.sourceLine ?? this.choice.documentAnchorLine
        this.choice.documentAnchorOffset = wrapped[this.choice.documentOffset]?.sourceOffset ?? this.choice.documentAnchorOffset
      } else if (this.choice.presentation.kind === "generic-list") {
        const height = Math.max(1, this.panelRows() - 3)
        if (event.key === "up") this.choice.selected = (this.choice.selected + this.choice.values.length - 1) % this.choice.values.length
        else if (event.key === "down" || event.key === "tab") this.choice.selected = (this.choice.selected + 1) % this.choice.values.length
        else if (event.key === "pageUp" || event.key === "pageup") this.choice.selected = Math.max(0, this.choice.selected - height)
        else if (event.key === "pageDown" || event.key === "pagedown") this.choice.selected = Math.min(this.choice.values.length - 1, this.choice.selected + height)
        else if (event.key === "enter") { this.choice.finish(this.choice.selected); return }
        if (this.choice.selected < this.choice.windowStart) this.choice.windowStart = this.choice.selected
        if (this.choice.selected >= this.choice.windowStart + height) this.choice.windowStart = Math.max(0, this.choice.selected - height + 1)
      } else if (event.key === "up") this.choice.selected = (this.choice.selected + this.choice.values.length - 1) % this.choice.values.length
      else if (event.key === "down" || event.key === "tab") this.choice.selected = (this.choice.selected + 1) % this.choice.values.length
      else if (event.key === "enter") { this.choice.finish(this.choice.selected); return }
      this.draw()
      return
    }
    if (this.detailsVisible) {
      if (event.type !== "key") return
      if (event.key === "ctrl+d") { this.control?.("quit"); return }
      if (event.key === "ctrl+c") {
        if (this.overlayControls.handle(event) === "shutdown") this.control?.("shutdown")
        return
      }
      const details = this.transcript.details()
      if (event.key === "escape") this.detailsVisible = false
      else if (event.key === "up" && details.length) this.detailsIndex = (this.detailsIndex + details.length - 1) % details.length
      else if (event.key === "down" && details.length) this.detailsIndex = (this.detailsIndex + 1) % details.length
      else if (event.key === "enter") {
        const selected = details[this.detailsIndex]
        if (selected?.expandable) this.transcript.toggle(selected.id)
      }
      this.draw()
      return
    }
    if (event.type === "key" && event.key === "escape" && this.pending?.kind === "selection") {
      this.pending.finish(undefined)
      return
    }
    if (suggestions && event.type === "key") {
      const selected = suggestions.rows[this.completionIndex]
      // A fully typed command (`/quit`) submits on Enter instead of re-inserting itself. A skill always needs a
      // request, so Enter on a complete skill name still inserts it and never submits a bare invocation.
      const typed = event.key === "enter" && selected?.kind === "command" && selected.insertion?.trimEnd() === this.editor.text
      if (event.key === "ctrl+c") {
        if (this.overlayControls.handle(event) === "shutdown") this.control?.("shutdown")
        return
      }
      if ((event.key === "enter" || event.key === "tab") && !typed) {
        const insertion = paletteInsertion(selected)
        if (insertion !== undefined) this.editor.setText(insertion)
        this.completionDismissed = true
        this.draw()
        return
      }
      if (event.key === "up" || event.key === "down") {
        if (suggestions.rows.length) {
          this.completionIndex = (this.completionIndex + (event.key === "up" ? -1 : 1) + suggestions.rows.length) % suggestions.rows.length
        }
        this.draw()
        return
      }
      if (event.key === "escape") { this.completionDismissed = true; this.draw(); return }
    }
    if (event.type === "text" || event.type === "paste") { this.completionDismissed = false; this.completionIndex = 0 }
    const previousDraft = this.editor.text
    const action = this.editor.handle(event)
    if (this.editor.text !== previousDraft) { this.completionDismissed = false; this.completionIndex = 0 }
    if (action === "shutdown") { this.control?.(event.type === "key" && event.key === "ctrl+c" ? "shutdown" : "quit"); return }
    if (action === "cancel") { this.control?.("interrupt"); this.draw(); return }
    if (action === "queue" && this.pending?.kind === "selection") return
    if (action === "submit" || action === "queue") {
      const command = this.editor.text.trim()
      const commandName = command.split(/\s/u, 1)[0] ?? ""
      const localAction = interactiveActions()
        .find(candidate => candidate.local && commandInsertion(candidate) === commandName)
      if (localAction) {
        const allowed = interactiveActions(this.interactionContext).some(candidate => candidate.id === localAction.id)
        this.editor.submit()
        if (!allowed) {
          this.transcript.append(this.interactionContext === "unselected"
            ? "Choose an engine and model with /model before using transcript tools."
            : "This local command is unavailable in the current interaction.")
          this.draw()
          return
        }
        if (localAction.id === "copy") {
          if (command === "/copy") void this.copyAnswer()
          else this.transcript.append("Usage: /copy (copies the latest assistant answer in this transcript page)")
        } else if (localAction.id === "details") {
          this.detailsVisible = !this.detailsVisible
        } else if (localAction.id === "ascii") {
          this.asciiChrome = !this.asciiChrome
        } else if (localAction.id === "theme") {
          const requested = command.slice(commandName.length).trim()
          if (requested === "neutral" || requested === "light" || requested === "dark") this.themeName = requested
          else this.transcript.append("Usage: /theme <neutral|light|dark>")
        } else if (localAction.id === "expand") {
          const argument = command.slice(commandName.length).trim()
          const shell = argument.startsWith("$")
          const ordinal = Number(shell ? argument.slice(1) : argument)
          const item = this.transcript.items.find(item => item.kind === (shell ? "shell" : "tool") && item.ordinal === ordinal)
          if (argument && Number.isInteger(ordinal) && item && item.kind !== "text") {
            this.transcript.toggle(item.id)
            if (item.expanded) this.expandedCalls.add(item.id)
            else this.expandedCalls.delete(item.id)
          }
          else this.transcript.append("Usage: /expand <tool item number> or /expand $<shell number>")
        } else if (localAction.id === "search") {
          this.transcriptQuery = command.slice(commandName.length).trim() || undefined
          this.pageOffset = 0
          this.reloadTranscript()
        }
        this.scrollOffset = this.transcriptQuery ? this.transcriptScrollBounds().maximumOffset : 0
        this.draw()
        return
      }
      if (!this.pending && ["/quit", "/cancel", "/pause"].includes(command)) {
        this.editor.submit()
        this.control?.(command === "/cancel" ? "cancel" : command === "/pause" ? "pause" : "quit")
      } else if (this.pending) {
        if (this.pending.kind === "chat" && !command) return
        const draft = this.editor.text
        const cursor = this.editor.cursor
        const text = this.pending.kind === "chat" ? this.editor.submit() : this.editor.text
        if (this.pending.kind === "chat") {
          this.lastSubmittedDraft = draft
          this.lastSubmittedCursor = cursor
        }
        if (this.pending.kind === "selection") this.editor.setText("")
        const transientSelection = this.interactionContext === "unselected" &&
          (command === "/help" || command === "/model" || command.startsWith("/model "))
        // `!command` is shown as its shell window, not as a chat message.
        const operatorShell = this.pending.kind === "chat" && command.startsWith("!") && command.slice(1).trim().length > 0
        if (!transientSelection && !operatorShell) this.transcript.append({ provenance: "user", text })
        this.pending.finish(text)
      } else if (action === "queue" && command) {
        this.queue.push(this.editor.submit())
      } else if (command) {
        this.status = "Busy · use Alt+Q (macOS) / Alt+Enter (Linux) to queue the next turn"
      }
    }
    this.draw()
  }

  readInput(input: { title: string; hint: string; prompt: string; kind: "chat" | "selection" }, signal: AbortSignal): Promise<string | undefined> {
    if (this.closed || signal.aborted) return Promise.resolve(undefined)
    if (this.pending || this.choice || this.askState) throw new Error("terminal input already has an owner")
    const selectionOrigin = input.kind === "selection" ? { text: this.editor.text, cursor: this.editor.cursor } : undefined
    if (selectionOrigin) this.editor.setText("")
    this.lastSubmittedDraft = undefined
    this.lastSubmittedCursor = undefined
    this.choiceSettled = false
    this.hostWorking = false
    this.status = input.kind === "chat" && this.viewFacts ? input.hint : `${input.title} · ${input.hint}`
    this.prompt = input.prompt
    this.resume()
    if (input.kind === "chat" && this.queueAllowed && this.queue.length && this.usable()) {
      const text = this.queue.shift()!
      this.transcript.append({ provenance: "user", text })
      this.draw()
      return Promise.resolve(text)
    }
    return new Promise(resolve => {
      const aborted = () => finish(undefined)
      const finish = (text: string | undefined) => {
        if (this.pending?.finish !== finish) return
        this.pending = undefined
        signal.removeEventListener("abort", aborted)
        if (text === undefined && selectionOrigin) {
          this.editor.setText(selectionOrigin.text)
          this.editor.cursor = selectionOrigin.cursor
        }
        this.status = text === undefined ? "Input closed" : "Otter · working · Escape cancels"
        this.hostWorking = text !== undefined
        resolve(text)
        this.draw()
      }
      this.pending = { finish, kind: input.kind, title: input.title }
      signal.addEventListener("abort", aborted, { once: true })
      if (signal.aborted) finish(undefined)
      this.draw()
    })
  }

  readLine(prompt: string, signal = new AbortController().signal): Promise<string | undefined> {
    return this.readInput({ title: "Otter", hint: "Enter select", prompt, kind: "selection" }, signal)
  }

  choose(title: string, values: readonly string[], signal: AbortSignal, presentation: ChoicePresentation = { kind: "plain" }): Promise<number | undefined> {
    if (this.closed || signal.aborted) return Promise.resolve(undefined)
    if (this.pending || this.choice || this.askState || !values.length) throw new Error("invalid terminal choice ownership")
    if (this.editor.searchState) this.editor.handle({ type: "key", key: "escape" })
    this.choiceSettled = false
    this.hostWorking = false
    const returnDraft = presentation.kind === "picker" && presentation.purpose === "command"
      ? this.lastSubmittedDraft ?? ""
      : undefined
    const returnCursor = presentation.kind === "picker" && presentation.purpose === "command"
      ? this.lastSubmittedCursor
      : undefined
    this.lastSubmittedDraft = undefined
    this.lastSubmittedCursor = undefined
    // A chooser can be the first interaction (the `otter --resume` session picker): take the terminal like readInput does, or
    // stdin is never read, nothing holds the event loop and the process exits silently before the picker is drawn.
    this.resume()
    return new Promise(resolve => {
      const abort = () => finish(undefined)
      const finish = (index: number | undefined) => {
        if (this.choice?.finish !== finish) return
        this.choiceSettled = true
        this.choice = undefined
        signal.removeEventListener("abort", abort)
        if (presentation.kind === "picker") {
          if (presentation.purpose === "command" && index === undefined) {
            this.editor.setText(returnDraft ?? "")
            this.editor.cursor = returnCursor ?? (returnDraft ?? "").length
            this.completionDismissed = false
          }
        } else {
          this.transcript.append(`${title}: ${index === undefined ? "No decision (dismissed)" : values[index]}`)
        }
        resolve(index)
        this.draw()
      }
      this.choice = {
        title,
        values,
        selected: presentation.kind === "generic-list" || presentation.kind === "picker"
          ? Math.min(values.length - 1, Math.max(0, presentation.initialIndex ?? 0))
          : 0,
        presentation,
        focus: presentation.kind === "approval" ? "document" : presentation.kind === "generic-list" || presentation.kind === "picker" ? "list" : "decisions",
        documentOffset: 0,
        documentAnchorLine: 0,
        documentAnchorOffset: 0,
        windowStart: 0,
        ...(presentation.kind === "picker" ? { filterEditor: new Editor({ platform: process.platform }) } : {}),
        finish,
      }
      signal.addEventListener("abort", abort, { once: true })
      this.draw()
    })
  }

  ask(prompt: AskPrompt, signal: AbortSignal): Promise<AskAnswer | undefined> {
    if (this.closed || signal.aborted) return Promise.resolve(undefined)
    if (this.pending || this.choice || this.askState || !(prompt.options.length || prompt.allowCustom)) throw new Error("invalid terminal ask ownership")
    if (this.editor.searchState) this.editor.handle({ type: "key", key: "escape" })
    this.choiceSettled = false
    this.hostWorking = false
    this.lastSubmittedDraft = undefined
    this.lastSubmittedCursor = undefined
    const initial = prompt.recommended !== undefined && prompt.recommended >= 0 && prompt.recommended < prompt.options.length ? prompt.recommended : 0
    this.resume()
    return new Promise(resolve => {
      const abort = () => finish(undefined)
      const finish = (answer: AskAnswer | undefined) => {
        if (this.askState?.finish !== finish) return
        this.choiceSettled = true
        this.askState = undefined
        signal.removeEventListener("abort", abort)
        const shown = answer === undefined ? "No decision (dismissed)" : answer.kind === "custom" ? answer.text : prompt.options[answer.index]?.label ?? ""
        this.transcript.append(`${prompt.question}: ${shown}`)
        this.hostWorking = answer !== undefined
        resolve(answer)
        this.draw()
      }
      this.askState = { prompt, selected: initial, finish }
      signal.addEventListener("abort", abort, { once: true })
      this.draw()
    })
  }

  write(text: string): void {
    const normalized = text.replace(/\r\n/g, "\n")
    this.transcript.append({ provenance: "notice", text: normalized })
    if (this.source && this.transcript.items.length > this.pageSize * 2) {
      this.pageOffset = 0
      this.reloadTranscript()
    }
    this.draw()
  }
  writeText(value: TranscriptText): void {
    this.transcript.append({ ...value, text: value.text.replace(/\r\n/g, "\n") })
    this.draw()
  }
  suspend(): void { this.dragSelection = undefined; this.driver.handoff(); this.suspended = true; this.syncSpinner() }
  resume(): void {
    if (this.closed) return
    this.choiceSettled = false
    this.suspended = false
    this.driver.start()
    this.draw()
  }
  /** A finished queue verify command, drawn as a Bash card with its task, attempt and timeout. */
  verifyRun(run: { id: string; command: string; taskID: string; attempt: number; timeoutMs: number; result: { status: "complete" | "error" | "cancelled" | "timeout"; exitCode: number | null; signal: null; durationMs: number; lines: readonly string[]; totalLines: number } }): void {
    this.transcript.shellStarted(run.id, run.command, undefined, { source: "verify", taskID: run.taskID, attempt: run.attempt, timeoutMs: run.timeoutMs })
    this.transcript.shellFinished(run.id, run.result)
    this.draw()
  }
  shellStart(run: { id: string; command: string }): ShellView {
    this.transcript.shellStarted(run.id, run.command)
    this.scrollOffset = 0
    this.draw()
    return {
      output: snapshot => {
        // A transcript reload during the run replaces the model; re-seat the live window by its id.
        this.transcript.shellStarted(run.id, run.command)
        this.transcript.shellOutput(run.id, snapshot.lines, snapshot.totalLines)
        this.scheduleShellDraw()
      },
      finish: result => {
        this.transcript.shellStarted(run.id, run.command)
        this.transcript.shellFinished(run.id, result)
        this.draw()
      },
    }
  }
  private scheduleShellDraw(): void {
    if (this.shellDraw) return
    this.shellDraw = setTimeout(() => { this.shellDraw = undefined; this.draw() }, 50)
    this.shellDraw.unref?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.trackRequest()
    if (this.shellDraw) clearTimeout(this.shellDraw)
    this.shellDraw = undefined
    this.queue.length = 0
    this.pending?.finish(undefined)
    this.choice?.finish(undefined)
    this.askState?.finish(undefined)
    this.driver.stop()
  }
}
