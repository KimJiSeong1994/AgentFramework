import type { Terminal, TerminalControl } from "../hosts/interactive-session.ts"
import { Editor, searchSubmittedHistory } from "./editor.ts"
import type { InputEvent } from "./keys.ts"
import { renderFrame, transcriptViewportRows, wrapText, wrapTranscriptLine } from "./render.ts"
import { TerminalDriver } from "./terminal.ts"
import { TranscriptModel } from "./transcript-model.ts"
import type { CliHostActivity } from "../hosts/cli-progress.ts"
import type { CliProgressTask } from "../hosts/cli-progress.ts"
import type { ExecutionRunStatus } from "../hosts/run-state.ts"
import type { ReplayOptions, ReplayResult } from "../sessions/store.ts"
import type { SkillCatalog } from "../skills/session.ts"
import { restoreTranscript } from "./session-transcript.ts"
import { commandInsertions, type InteractiveContext } from "../hosts/interactive-actions.ts"
import {
  formatSkillCompletionRow,
  skillCompletion,
  skillCompletionInsertion,
  skillCompletionWindow,
} from "./skill-completion.ts"
import { sameViewIdentity, type ChoicePresentation, type InteractiveViewFacts, type TranscriptText, type ViewIdentity } from "../hosts/interactive-view.ts"
import { statusLines } from "./status-view.ts"
import { resolveTheme, type ThemeName } from "./theme.ts"

type Pending = { finish: (text: string | undefined) => void; kind: "chat" | "selection" }
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
  private control?: (action: TerminalControl) => void
  private status = "LCA · selection"
  private workflow: string | undefined
  private viewIdentity?: ViewIdentity
  private viewFacts?: InteractiveViewFacts
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
  queueAdmission(allowed: boolean): void { this.queueAllowed = allowed && !this.readFailure }
  workflowStatus(line: string | undefined): void {
    if (this.workflow === line) return
    this.workflow = line
    this.draw()
  }
  bindView(identity: ViewIdentity): void {
    if (sameViewIdentity(this.viewIdentity, identity)) return
    this.viewIdentity = identity
    this.viewFacts = undefined
    this.detailsVisible = false
    this.draw()
  }
  viewSnapshot(facts: InteractiveViewFacts): void {
    if (!sameViewIdentity(this.viewIdentity, facts.identity)) return
    this.viewFacts = facts
    this.draw()
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
      for (const item of previous.items) if (item.kind === "text") this.transcript.append({ provenance: item.provenance, text: item.text })
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
  private completions(): string[] {
    if (this.choice || this.editor.searchState || this.completionDismissed || this.pending?.kind === "selection") return []
    return commandInsertions(this.editor.text, this.interactionContext)
  }
  private skillCompletions() {
    if (this.interactionContext === "unselected" || this.choice || this.editor.searchState || this.completionDismissed || this.pending?.kind === "selection") return undefined
    return skillCompletion(this.catalog, this.editor.text)
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
  private usable(): boolean { const size = this.dimensions(); return size.columns >= 80 && size.rows >= 24 }

  private transcriptScrollBounds(): { pageRows: number; maximumOffset: number } {
    const { columns, rows } = this.dimensions()
    const viewportRows = transcriptViewportRows({ columns, rows, draft: this.editor.text, cursor: this.editor.cursor, prompt: this.prompt, statusRows: this.currentStatusLines().length })
    const visualRows = this.transcript.lines(this.transcriptQuery)
      .reduce((total, line) => total + wrapTranscriptLine(line, columns).length, 0)
    return { pageRows: Math.max(1, viewportRows), maximumOffset: Math.max(0, visualRows - viewportRows) }
  }

  private currentStatusLines(): string[] {
    if (this.readFailure) return ["History unavailable | new input blocked", "Ctrl+D exit | active work may remain"]
    const { columns } = this.dimensions()
    const overlayHint = this.choice?.presentation.kind === "picker"
      ? `Up/Down move | Enter ${this.choice.presentation.purpose === "command" ? "inserts" : "selects"} | Esc back | Ctrl+D quit`
      : this.detailsVisible ? "Details | Up/Down move | Enter expands | Esc closes | Ctrl+D quits" : undefined
    return statusLines({
      facts: this.viewFacts,
      workflow: this.workflow,
      activity: overlayHint ?? this.transcript.currentTask ?? this.status,
      search: this.transcriptQuery,
      queued: this.queue.length,
      columns,
      ...(!this.usable() ? { notice: "Resize terminal to at least 80x24. Cancellation remains available." } : {}),
      ascii: this.asciiChrome,
    })
  }

  private pickerMatches(choice: Choice): number[] {
    const presentation = choice.presentation
    if (presentation.kind !== "picker") return []
    const filter = (choice.filterEditor?.text ?? "").toLocaleLowerCase()
    return choice.values.flatMap((value, index) =>
      !filter || `${value} ${presentation.rows[index] ?? ""}`
        .toLocaleLowerCase().includes(filter) ? [index] : [])
  }

  private draw(): void {
    if (this.suspended || this.closed) return
    let lines = this.transcript.lines(this.transcriptQuery)
    if (this.readFailure) {
      lines = [
        "[Error] Session read failure",
        "The retained history could not be read safely.",
        "New messages, queued input and approval decisions are blocked.",
        "Ctrl+D exits. Inspect read-only lca status before reopening.",
        "Active work is not confirmed stopped.",
      ]
    } else if (this.choice?.presentation.kind === "approval") {
      const { columns, rows } = this.dimensions()
      const wrapped = documentRows(this.choice.presentation.document, columns)
      const availableRows = Math.max(1, rows - this.choice.values.length - 9)
      const maximumOffset = Math.max(0, wrapped.length - availableRows)
      const anchoredOffset = wrapped.findIndex(row =>
        row.sourceLine > this.choice!.documentAnchorLine ||
        row.sourceLine === this.choice!.documentAnchorLine && row.sourceOffset >= this.choice!.documentAnchorOffset)
      this.choice.documentOffset = Math.min(anchoredOffset < 0 ? maximumOffset : anchoredOffset, maximumOffset)
      const end = Math.min(wrapped.length, this.choice.documentOffset + availableRows)
      const binding = this.choice.presentation.binding
      const fixed = (value: string) => wrapText(value, columns)[0] ?? ""
      lines = [
        fixed(`${this.choice.title}${this.separator()}${this.choice.focus === "document" ? "document" : "decisions"} focus${this.separator()}Tab switches`),
        fixed(`source ${binding.path}`),
        fixed(`session ${binding.sessionID}${this.separator()}workflow ${binding.workflowID}${this.separator()}rev ${binding.expectedRevision}`),
        fixed(`plan sha256 ${binding.planSha}`),
        fixed(`Document rows ${wrapped.length ? this.choice.documentOffset + 1 : 0}-${end}/${wrapped.length}${this.separator()}Up/Down scroll${this.separator()}PageUp/PageDown page`),
        ...wrapped.slice(this.choice.documentOffset, end).map(row => row.text),
        `Decisions${this.separator()}Enter acts only while decisions are focused${this.separator()}Escape keeps pending`,
        ...this.choice.values.map((value, index) => `${this.choice!.focus === "decisions" && index === this.choice!.selected ? ">" : " "} ${value}`),
      ]
    } else if (this.choice?.presentation.kind === "generic-list") {
      const { rows } = this.dimensions()
      const height = Math.max(1, rows - 8)
      const maximumStart = Math.max(0, this.choice.values.length - height)
      this.choice.windowStart = Math.max(0, Math.min(maximumStart, this.choice.windowStart))
      if (this.choice.selected < this.choice.windowStart) this.choice.windowStart = this.choice.selected
      if (this.choice.selected >= this.choice.windowStart + height) this.choice.windowStart = this.choice.selected - height + 1
      const end = Math.min(this.choice.values.length, this.choice.windowStart + height)
      const detail = this.choice.presentation.rows[this.choice.selected]
      lines = [
        `${this.choice.title}${this.separator()}Up/Down navigate${this.separator()}PageUp/PageDown page${this.separator()}Enter opens${this.separator()}Escape cancels`,
        `${this.choice.selected + 1}/${this.choice.values.length}${this.separator()}showing ${this.choice.windowStart + 1}-${end}`,
        ...this.choice.values.slice(this.choice.windowStart, end).map((value, index) =>
          `${this.choice!.windowStart + index === this.choice!.selected ? ">" : " "} ${value}`),
        ...(detail ? [`Selected: ${detail}`] : []),
      ]
    } else if (this.choice?.presentation.kind === "picker") {
      const { rows } = this.dimensions()
      const height = Math.max(1, Math.min(10, rows - 11))
      const matches = this.pickerMatches(this.choice)
      if (this.choice.selected >= matches.length) this.choice.selected = Math.max(0, matches.length - 1)
      this.choice.windowStart = Math.max(0, Math.min(Math.max(0, matches.length - height), this.choice.windowStart))
      if (this.choice.selected < this.choice.windowStart) this.choice.windowStart = this.choice.selected
      if (this.choice.selected >= this.choice.windowStart + height) this.choice.windowStart = this.choice.selected - height + 1
      const end = Math.min(matches.length, this.choice.windowStart + height)
      const selectedOriginal = matches[this.choice.selected]
      const selectedDetail = selectedOriginal === undefined ? undefined : this.choice.presentation.rows[selectedOriginal]
      lines = [
        this.choice.title,
        ...(this.choice.presentation.hint ? [this.choice.presentation.hint] : []),
        `${matches.length} matches${this.separator()}showing ${matches.length ? `${this.choice.windowStart + 1}-${end}` : "0"}`,
        ...matches.slice(this.choice.windowStart, end).map((original, index) =>
          `${this.choice!.windowStart + index === this.choice!.selected ? ">" : " "} ${this.choice!.values[original]}`),
        ...(selectedDetail && selectedDetail !== this.choice.values[selectedOriginal!]
          ? [`Selected: ${selectedDetail}`] : matches.length ? [] : ["No matching choices."]),
      ]
    } else if (this.choice) {
      lines.push(this.choice.title, ...this.choice.values.map((value, i) => `${i === this.choice!.selected ? ">" : " "} ${value}`))
    }
    const search = this.readFailure ? undefined : this.editor.searchState
    if (search) {
      const first = Math.max(0, search.selected - 4)
      lines.push("Search input history · Up/Down navigate · Enter selects · Escape cancels",
        ...search.results.slice(first, first + 8).map((value, index) => `${index + first === search.selected ? ">" : " "} ${value}`),
        `${search.results.length ? search.selected + 1 : 0}/${search.results.length} matches`)
    }
    const skills = this.readFailure ? undefined : this.skillCompletions()
    const completions = this.readFailure || skills ? [] : this.completions()
    if (skills) {
      const { columns, rows } = this.dimensions()
      const viewportRows = transcriptViewportRows({ columns, rows, draft: this.editor.text, cursor: this.editor.cursor, prompt: this.prompt })
      const maximumRows = Math.min(6, Math.max(0, Math.floor((viewportRows - 1) / 2)))
      const visible = skillCompletionWindow(skills.rows, this.completionIndex, maximumRows)
      lines.push(`${this.catalog ? "Skills" : "Skills catalog unavailable"} · ${skills.rows.length} matches · Up/Down navigate · Tab/Enter insert · Escape dismiss`)
      if (visible.rows.length) {
        visible.rows.forEach((row, index) => {
          const [name, metadata] = formatSkillCompletionRow(row)
          lines.push(`${visible.start + index === this.completionIndex ? ">" : " "} ${wrapText(name, columns)[0] ?? ""}`,
            `  ${wrapText(metadata, columns)[0] ?? ""}`)
        })
        if (visible.start > 0 || visible.start + visible.rows.length < skills.rows.length) {
          lines.push(`  Showing ${visible.start + 1}-${visible.start + visible.rows.length} of ${skills.rows.length}`)
        }
      } else {
        lines.push(this.catalog ? "No matching skills" : "No skill catalog is available for this session")
      }
    } else if (completions.length) {
      lines.push("Commands · Tab/Enter inserts, Escape dismisses", ...completions.map((value, i) => `${i === this.completionIndex % completions.length ? ">" : " "} ${value}`))
    }
    if (this.detailsVisible && !this.choice) {
      const details = this.transcript.details()
      this.detailsIndex = Math.max(0, Math.min(Math.max(0, details.length - 1), this.detailsIndex))
      const selected = details[this.detailsIndex]
      const maximum = Math.max(1, Math.floor(this.dimensions().rows / 3))
      const detailRows = details.map((detail, index) => `${index === this.detailsIndex ? ">" : " "} ${detail.summary}`)
      lines.push(
        `Task/evidence details${this.separator()}${details.length ? `${this.detailsIndex + 1}/${details.length}` : "empty"}${this.separator()}Up/Down${this.separator()}Enter expands${this.separator()}Escape closes`,
        ...(detailRows.length ? detailRows.slice(Math.max(0, this.detailsIndex - maximum + 3), Math.max(0, this.detailsIndex - maximum + 3) + Math.max(1, maximum - 2)) : ["No task evidence is available."]),
        ...(selected ? selected.lines.slice(0, Math.max(0, maximum - 3)).map(line => `  ${line}`) : []),
      )
    }
    const overlayVisible = !!this.choice || !!search || !!skills || completions.length > 0 || this.detailsVisible
    const home = this.interactionContext === "unselected" && this.transcript.items.length === 0 &&
      !overlayVisible && !this.choice && !search && !skills && completions.length === 0
      ? ["LCA is ready; no model is selected.", "Enter /model to choose an engine and model.", "Enter /help for commands, or /quit to leave."]
      : undefined
    this.driver.write(renderFrame({ ...this.dimensions(), transcript: lines,
      transcriptOffset: overlayVisible || this.readFailure ? 0 : this.scrollOffset,
      ...(!overlayVisible && !this.readFailure ? {
        transcriptOlder: this.nextPageOffset !== undefined,
        transcriptNewer: this.pageOffset > 0,
      } : {}),
      ...(home ? { home } : {}),
      status: this.currentStatusLines(),
      draft: this.choice?.filterEditor?.text ?? search?.query ?? this.editor.text,
      cursor: this.choice?.filterEditor?.cursor ?? (search ? search.query.length : this.editor.cursor),
      prompt: this.readFailure ? "Read-only> " : this.choice?.filterEditor ? "Filter> " : search ? "History> " : this.prompt,
      color: process.env.NO_COLOR === undefined,
      theme: resolveTheme(this.themeName),
      ascii: this.asciiChrome,
    }))
  }

  private input(event: InputEvent): void {
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
    const skills = this.skillCompletions()
    const overlayVisible = !!this.choice || !!this.editor.searchState || !!skills || this.completions().length > 0 || this.detailsVisible
    if (!overlayVisible && this.usable() && event.type === "key" && (event.key === "pageUp" || event.key === "pageDown" || event.key === "pageup" || event.key === "pagedown")) {
      const { pageRows, maximumOffset } = this.transcriptScrollBounds()
      this.scrollOffset = Math.min(this.scrollOffset, maximumOffset)
      if (event.key.toLowerCase() === "pageup") {
        if (this.scrollOffset < maximumOffset) this.scrollOffset = Math.min(maximumOffset, this.scrollOffset + pageRows)
        else if (this.source && this.nextPageOffset !== undefined) {
          this.pageOffset = this.nextPageOffset
          this.reloadTranscript()
        }
      } else if (this.scrollOffset > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - pageRows)
      } else if (this.source && this.pageOffset > 0) {
        this.pageOffset = Math.max(0, this.pageOffset - this.pageSize)
        this.reloadTranscript()
      }
      this.draw()
      return
    }
    if (event.type === "key" && event.key === "ctrl+z") { this.control?.("suspend"); return }
    if (!this.usable() && !(event.type === "key" && ["ctrl+c", "ctrl+d", "escape"].includes(event.key))) return
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
            else if (command === "/quit" || command === "/exit") this.control?.("quit")
            else if (matches.length) this.choice.finish(matches[this.choice.selected]!)
            else return
          } else if (event.key === "up" || event.key === "down" || event.key === "tab") {
            if (matches.length) {
              const direction = event.key === "up" ? -1 : 1
              this.choice.selected = (this.choice.selected + direction + matches.length) % matches.length
            }
          } else if (event.key === "pageUp" || event.key === "pageup" || event.key === "pageDown" || event.key === "pagedown") {
            if (matches.length) {
              const page = Math.max(1, this.dimensions().rows - 11)
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
      // Paste/text can never answer a choice, much less mint an execution receipt.
      if (event.type !== "key") return
      if (this.choice.presentation.kind === "approval") {
        const { columns, rows } = this.dimensions()
        const wrapped = documentRows(this.choice.presentation.document, columns)
        const totalRows = wrapped.length
        const pageRows = Math.max(1, rows - this.choice.values.length - 9)
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
        const height = Math.max(1, this.dimensions().rows - 8)
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
    if (skills && event.type === "key") {
      if (event.key === "ctrl+c") {
        if (this.overlayControls.handle(event) === "shutdown") this.control?.("shutdown")
        return
      }
      if (event.key === "enter" || event.key === "tab") {
        const insertion = skillCompletionInsertion(skills.rows[this.completionIndex])
        if (insertion !== undefined) this.editor.setText(insertion)
        this.completionDismissed = true
        this.draw()
        return
      }
      if (event.key === "up" || event.key === "down") {
        if (skills.rows.length) {
          this.completionIndex = (this.completionIndex + (event.key === "up" ? -1 : 1) + skills.rows.length) % skills.rows.length
        }
        this.draw()
        return
      }
      if (event.key === "escape") { this.completionDismissed = true; this.draw(); return }
    }
    const completions = this.completions()
    if (completions.length && event.type === "key") {
      if (event.key === "ctrl+c") {
        if (this.overlayControls.handle(event) === "shutdown") this.control?.("shutdown")
        return
      }
      if (event.key === "enter" || event.key === "tab") {
        this.editor.setText(completions[this.completionIndex % completions.length]! + " ")
        this.completionDismissed = true
        this.draw()
        return
      }
      if (event.key === "up" || event.key === "down") {
        this.completionIndex = (this.completionIndex + (event.key === "up" ? -1 : 1) + completions.length) % completions.length
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
    if (action === "cancel") { this.control?.("cancel"); this.draw(); return }
    if (action === "queue" && this.pending?.kind === "selection") return
    if (action === "submit" || action === "queue") {
      const command = this.editor.text.trim()
      if (this.pending?.kind !== "selection" && (command === "/details" || command === "/ascii" || command.startsWith("/theme ") || command === "/search" || command.startsWith("/search ") || command.startsWith("/expand "))) {
        if (command === "/details") {
          this.detailsVisible = !this.detailsVisible
        } else if (command === "/ascii") {
          this.asciiChrome = !this.asciiChrome
        } else if (command.startsWith("/theme ")) {
          const requested = command.slice(7).trim()
          if (requested === "neutral" || requested === "light" || requested === "dark") this.themeName = requested
          else this.transcript.append("Usage: /theme <neutral|light|dark>")
        } else if (command.startsWith("/expand ")) {
          const ordinal = Number(command.slice(8).trim())
          const item = this.transcript.items.find(item => item.kind === "tool" && item.ordinal === ordinal)
          if (Number.isInteger(ordinal) && item?.kind === "tool") {
            this.transcript.toggle(item.id)
            if (item.expanded) this.expandedCalls.add(item.id)
            else this.expandedCalls.delete(item.id)
          }
          else this.transcript.append("Usage: /expand <tool item number>")
        } else {
          this.transcriptQuery = command.slice(7).trim() || undefined
          this.pageOffset = 0
          this.reloadTranscript()
        }
        this.editor.setText("")
        this.scrollOffset = this.transcriptQuery ? this.transcriptScrollBounds().maximumOffset : 0
        this.draw()
        return
      }
      if (!this.pending && ["/quit", "/exit", "/cancel", "/pause"].includes(command)) {
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
        if (!transientSelection) this.transcript.append({ provenance: "user", text })
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
    if (this.pending || this.choice) throw new Error("terminal input already has an owner")
    const selectionOrigin = input.kind === "selection" ? { text: this.editor.text, cursor: this.editor.cursor } : undefined
    if (selectionOrigin) this.editor.setText("")
    this.lastSubmittedDraft = undefined
    this.lastSubmittedCursor = undefined
    this.choiceSettled = false
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
        this.status = text === undefined ? "Input closed" : "LCA · working · Escape cancels"
        resolve(text)
        this.draw()
      }
      this.pending = { finish, kind: input.kind }
      signal.addEventListener("abort", aborted, { once: true })
      if (signal.aborted) finish(undefined)
      this.draw()
    })
  }

  readLine(prompt: string, signal = new AbortController().signal): Promise<string | undefined> {
    return this.readInput({ title: "LCA", hint: "Enter select", prompt, kind: "selection" }, signal)
  }

  choose(title: string, values: readonly string[], signal: AbortSignal, presentation: ChoicePresentation = { kind: "plain" }): Promise<number | undefined> {
    if (this.closed || signal.aborted) return Promise.resolve(undefined)
    if (this.pending || this.choice || !values.length) throw new Error("invalid terminal choice ownership")
    if (this.editor.searchState) this.editor.handle({ type: "key", key: "escape" })
    this.choiceSettled = false
    const returnDraft = presentation.kind === "picker" && presentation.purpose === "command"
      ? this.lastSubmittedDraft ?? ""
      : undefined
    const returnCursor = presentation.kind === "picker" && presentation.purpose === "command"
      ? this.lastSubmittedCursor
      : undefined
    this.lastSubmittedDraft = undefined
    this.lastSubmittedCursor = undefined
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
  suspend(): void { this.driver.handoff(); this.suspended = true }
  resume(): void {
    if (this.closed) return
    this.choiceSettled = false
    this.suspended = false
    this.driver.start()
    this.draw()
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue.length = 0
    this.pending?.finish(undefined)
    this.choice?.finish(undefined)
    this.driver.stop()
  }
}
