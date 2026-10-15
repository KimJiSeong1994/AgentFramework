import type { Terminal, TerminalControl } from "../hosts/interactive-session.ts"
import { Editor, searchSubmittedHistory } from "./editor.ts"
import type { InputEvent } from "./keys.ts"
import { renderFrame, transcriptViewportRows, wrapText } from "./render.ts"
import { TerminalDriver } from "./terminal.ts"
import { TranscriptModel } from "./transcript-model.ts"
import type { CliHostActivity } from "../hosts/cli-progress.ts"
import type { CliProgressTask } from "../hosts/cli-progress.ts"
import type { ExecutionRunStatus } from "../hosts/run-state.ts"
import type { ReplayOptions, ReplayResult } from "../sessions/store.ts"
import type { SkillCatalog } from "../skills/session.ts"
import { restoreTranscript } from "./session-transcript.ts"
import {
  commandCompletions,
  formatSkillCompletionRow,
  skillCompletion,
  skillCompletionInsertion,
  skillCompletionWindow,
} from "./skill-completion.ts"

type Pending = { finish: (text: string | undefined) => void; kind: "chat" | "selection" }
type Choice = { title: string; values: readonly string[]; selected: number; finish: (index: number | undefined) => void }

/** Presentation only: plan validation, receipts and execution belong to the shared coordinator. */
export class TuiApp implements Terminal {
  readonly fullscreen = true
  readonly stdinIsTTY = process.stdin.isTTY === true
  readonly stderrIsTTY = process.stderr.isTTY === true
  private readonly editor = new Editor({ platform: process.platform })
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
  private prompt = "You> "
  private suspended = false
  private closed = false
  private choiceSettled = false
  private queueAllowed = false
  queueAdmission(allowed: boolean): void { this.queueAllowed = allowed }
  workflowStatus(line: string | undefined): void {
    if (this.workflow === line) return
    this.workflow = line
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
    this.catalog = undefined
    this.completionIndex = 0
    this.completionDismissed = false
    this.draw()
  }
  bindSession(sessionID: string): void {
    if (this.transcript.sessionID === sessionID) return
    const previous = this.transcript
    this.transcript = new TranscriptModel(sessionID)
    if (previous.sessionID === "selection") for (const item of previous.items) if (item.kind === "text") this.transcript.append(item.text)
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
      catch (error) {
        this.transcript.append(`History search refused: ${String(error)}`)
        this.control?.("disconnect")
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
    } catch (error) {
      this.nextPageOffset = undefined
      this.transcript.append(`Session read failure: ${String(error)}`)
      this.control?.("disconnect")
    }
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
    return commandCompletions(this.editor.text)
  }
  private skillCompletions() {
    if (this.choice || this.editor.searchState || this.completionDismissed || this.pending?.kind === "selection") return undefined
    return skillCompletion(this.catalog, this.editor.text)
  }

  // The renderer owns terminal escapes; shared coordinator prose stays plain.
  presentation = () => ({ columns: process.stdout.columns, color: false })
  controls(handler: (action: TerminalControl) => void): void { this.control = handler }
  private dimensions() { return { columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 } }
  private usable(): boolean { const size = this.dimensions(); return size.columns >= 80 && size.rows >= 24 }

  private transcriptScrollBounds(): { pageRows: number; maximumOffset: number } {
    const { columns, rows } = this.dimensions()
    const viewportRows = transcriptViewportRows({ columns, rows, draft: this.editor.text, cursor: this.editor.cursor, prompt: this.prompt })
    const visualRows = this.transcript.lines(this.transcriptQuery)
      .reduce((total, line) => total + wrapText(line, columns).length, 0)
    return { pageRows: Math.max(1, viewportRows), maximumOffset: Math.max(0, visualRows - viewportRows) }
  }

  private draw(): void {
    if (this.suspended || this.closed) return
    const lines = this.transcript.lines(this.transcriptQuery)
    if (this.choice) lines.push(this.choice.title, ...this.choice.values.map((value, i) => `${i === this.choice!.selected ? ">" : " "} ${value}`))
    const search = this.editor.searchState
    if (search) {
      const first = Math.max(0, search.selected - 4)
      lines.push("Search input history · Up/Down navigate · Enter selects · Escape cancels",
        ...search.results.slice(first, first + 8).map((value, index) => `${index + first === search.selected ? ">" : " "} ${value}`),
        `${search.results.length ? search.selected + 1 : 0}/${search.results.length} matches`)
    }
    const skills = this.skillCompletions()
    const completions = skills ? [] : this.completions()
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
    const overlayVisible = !!this.choice || !!search || !!skills || completions.length > 0
    this.driver.write(renderFrame({ ...this.dimensions(), transcript: lines,
      transcriptOffset: overlayVisible ? 0 : this.scrollOffset,
      status: `${this.transcriptQuery ? `search: ${this.transcriptQuery} · ` : ""}${this.queue.length ? `queued ${this.queue.length} · ` : ""}${this.workflow ? `${this.workflow} · ` : ""}${this.transcript.currentTask ?? this.status}`,
      draft: search?.query ?? this.editor.text, cursor: search ? search.query.length : this.editor.cursor,
      prompt: search ? "History> " : this.prompt,
      color: process.env.NO_COLOR === undefined,
      ...(!this.usable() ? { notice: "Resize terminal to at least 80x24. Cancellation remains available." } : {}),
    }))
  }

  private input(event: InputEvent): void {
    if (this.choiceSettled) return
    const skills = this.skillCompletions()
    const overlayVisible = !!this.choice || !!this.editor.searchState || !!skills || this.completions().length > 0
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
      // Paste/text can never answer a choice, much less mint an execution receipt.
      if (event.type !== "key") return
      if (event.key === "up") this.choice.selected = (this.choice.selected + this.choice.values.length - 1) % this.choice.values.length
      else if (event.key === "down" || event.key === "tab") this.choice.selected = (this.choice.selected + 1) % this.choice.values.length
      else if (event.key === "enter") { this.choice.finish(this.choice.selected); return }
      else if (event.key === "escape") { this.choice.finish(undefined); return }
      else if (event.key === "ctrl+d") { this.control?.("quit"); return }
      else if (event.key === "ctrl+c" && this.editor.handle(event) === "shutdown") { this.control?.("shutdown"); return }
      this.draw()
      return
    }
    if (skills && event.type === "key") {
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
    if (action === "submit" || action === "queue") {
      const command = this.editor.text.trim()
      if (this.pending?.kind === "chat" && (command === "/search" || command.startsWith("/search ") || command.startsWith("/expand "))) {
        if (command.startsWith("/expand ")) {
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
        const text = this.pending.kind === "chat" ? this.editor.submit() : this.editor.text
        if (this.pending.kind === "selection") this.editor.setText("")
        this.transcript.append(`${this.prompt}${text}`)
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
    this.choiceSettled = false
    this.status = `${input.title} · ${input.hint}`
    this.prompt = input.prompt
    this.resume()
    if (input.kind === "chat" && this.queueAllowed && this.queue.length && this.usable()) {
      const text = this.queue.shift()!
      this.transcript.append(`${this.prompt}${text}`)
      this.draw()
      return Promise.resolve(text)
    }
    return new Promise(resolve => {
      const aborted = () => finish(undefined)
      const finish = (text: string | undefined) => {
        if (this.pending?.finish !== finish) return
        this.pending = undefined
        signal.removeEventListener("abort", aborted)
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

  choose(title: string, values: readonly string[], signal: AbortSignal): Promise<number | undefined> {
    if (this.closed || signal.aborted) return Promise.resolve(undefined)
    if (this.pending || this.choice || !values.length) throw new Error("invalid terminal choice ownership")
    if (this.editor.searchState) this.editor.handle({ type: "key", key: "escape" })
    this.choiceSettled = false
    return new Promise(resolve => {
      const abort = () => finish(undefined)
      const finish = (index: number | undefined) => {
        if (this.choice?.finish !== finish) return
        this.choiceSettled = true
        this.choice = undefined
        signal.removeEventListener("abort", abort)
        this.transcript.append(`${title}: ${index === undefined ? "No decision (dismissed)" : values[index]}`)
        resolve(index)
        this.draw()
      }
      this.choice = { title, values, selected: 0, finish }
      signal.addEventListener("abort", abort, { once: true })
      this.draw()
    })
  }

  write(text: string): void {
    this.transcript.append(text.replace(/\r\n/g, "\n"))
    if (this.source && this.transcript.items.length > this.pageSize * 2) {
      this.pageOffset = 0
      this.reloadTranscript()
    }
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
