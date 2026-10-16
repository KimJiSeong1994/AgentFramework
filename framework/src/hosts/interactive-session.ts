import { randomUUID } from "node:crypto"
import { STOP_LABEL } from "../flow/status.ts"
import { taskPartition } from "../workflows/checkpoint.ts"
import { readLedger } from "../state/ledger.ts"
import { isPauseSettled, stopDisplay } from "../workflows/types.ts"
import { spawnSync } from "node:child_process"
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { createInterface } from "node:readline"
import { activeAnyWorkflow, activeWorkflow, readAnyWorkflowChecked, readWorkflowChecked, type Workflow } from "../flow/state.ts"
import { savedPlan } from "../flow/actions.ts"
import { ledgerPath } from "../state/ledger.ts"
import { createCliRuntime, type CliRuntimeOptions } from "./cli-runtime.ts"
import { inputColorSupported, inputLine, renderInput, type InputPresentation } from "./cli-input.ts"
import { createCliProgressPresenter, type CliHostActivity, type CliProgressTask, type CliTaskStatus } from "./cli-progress.ts"
import { createPlanConversation, MAX_PLAN_CONVERSATION_CHARS, type ConversationMessage, type ConversationTurn, type SkillConversationInvocation } from "./plan-conversation.ts"
import { PROTECTED_WORKFLOWS, resolveSkillRoots } from "../skills/roots.ts"
import { SkillSession, type PreparedSkillInvocation, type SkillCatalog } from "../skills/session.ts"
import { readSkillTrust } from "../skills/trust.ts"
import { attachAdmission, detachAdmission, effectiveHold, holdAdmission, resumeAdmission } from "../sessions/admission.ts"
import { inspectSessions, MAX_CARRIED_MESSAGES, MAX_SHELL_COMMAND_BYTES, readSessionMetadata, replaySession, type SessionStore, type ReplayOptions, type ReplayResult, type TranscriptKind } from "../sessions/store.ts"
import { persistToolActivity } from "../tui/session-transcript.ts"
import { createForegroundController, readForegroundStatus, type ForegroundController } from "./controller.ts"
import { discoverModels as discoverModelCatalog, type ModelCatalog } from "./model-catalog.ts"
import { incompleteArtifactSummary } from "../workflows/artifacts.ts"
import { readSessionCommitted } from "../workflows/commit.ts"
import { humanDecision } from "./operator.ts"
import type { OperatorDecision } from "./operator.ts"
import { AdmissionRefusal, assertHostAdmission } from "./required-controls.ts"
import { boundedTerminalDiagnostic, terminalSafeText } from "./terminal-text.ts"
import { createWorkflowHost, requestWorkflowStop, type WorkflowHost } from "./workflow-session.ts"
import { startRefusal } from "../workflows/registry.ts"
import { ModelRequestError } from "../workflows/turn.ts"
import { beginExecutionActivity } from "./runtime.ts"
import { settled, type ExecutionRunStatus } from "./run-state.ts"
import { LinuxAdmissionRefused, type ExecutionRuntime } from "./types.ts"
import type { ChoicePresentation, InteractiveViewFacts, RequestObservation, SessionCandidate, TranscriptText, ViewIdentity } from "./interactive-view.ts"
import { commandInsertion, interactiveActions, interactiveHelp, type InteractiveContext } from "./interactive-actions.ts"
import { fileDefaultModelStore, validModelID, type DefaultModelLookup, type DefaultModelStore } from "./default-model.ts"
import { runOperatorShell, type ShellResult, type ShellSnapshot } from "./operator-shell.ts"

export type CliEngine = CliRuntimeOptions["engine"]
export type InteractiveArgs = { worktree: string; engine?: CliEngine; model?: string }
export type InteractiveExit = { code: number }
export type TerminalControl = "cancel" | "pause" | "shutdown" | "quit" | "disconnect" | "suspend"

export type Terminal = {
  stdinIsTTY: boolean
  stderrIsTTY: boolean
  fullscreen?: boolean
  presentation?: () => InputPresentation
  actionContext?: (context: InteractiveContext) => void
  setDraft?: (draft: string) => void
  readInput?: (input: { title: string; hint: string; prompt: string; kind: "chat" | "selection" }, signal: AbortSignal) => Promise<string | undefined>
  choose?: (title: string, choices: readonly string[], signal: AbortSignal, presentation?: ChoicePresentation) => Promise<number | undefined>
  controls?: (handler: (action: TerminalControl) => void) => void
  queueAdmission?: (allowed: boolean) => void
  activity?: (activity: CliHostActivity) => void
  bindSession?: (sessionID: string) => void
  executionSnapshot?: (state: ExecutionRunStatus, active: boolean) => void
  taskSnapshot?: (tasks: readonly CliProgressTask[]) => void
  queueActivity?: (message: string, fields?: Record<string, unknown>) => void
  sessionChanged?: () => void
  skillCatalog?: (catalog: SkillCatalog) => void
  /** Committed `kind · stage · phase` of the live planning workflow in this session, or undefined when none is live. */
  workflowStatus?: (line: string | undefined) => void
  viewSnapshot?: (facts: InteractiveViewFacts) => void
  bindView?: (identity: ViewIdentity) => void
  transcriptSource?: (source: (options: ReplayOptions) => ReplayResult) => void
  draftSnapshot?: () => { draft: string; queued: string[] }
  suspend?: () => void
  resume?: () => void
  readLine: (prompt: string, signal?: AbortSignal) => Promise<string | undefined>
  write: (text: string) => void
  writeText?: (text: TranscriptText) => void
  /** Live operator shell window (full-screen TUI); readline prints output lines instead. */
  shellStart?: (run: { id: string; command: string }) => ShellView
  close: () => void
}

export type ShellView = {
  output: (snapshot: ShellSnapshot) => void
  finish: (result: ShellResult) => void
}

type PlanConversation = {
  turn: (text: string, signal?: AbortSignal, skill?: SkillConversationInvocation) => Promise<ConversationTurn>
}

type SignalName = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGTSTP" | "SIGCONT"
type SignalSource = {
  on: (signal: SignalName, listener: () => void) => unknown
  off: (signal: SignalName, listener: () => void) => unknown
}

type RuntimeOptions = CliRuntimeOptions

export type InteractiveDependencies = {
  cwd: string
  terminal: Terminal
  gitTopLevel: (directory: string) => string | undefined
  createRuntime: (options: RuntimeOptions) => ExecutionRuntime
  admitRuntime: (runtime: ExecutionRuntime) => Promise<void>
  createConversation: (runtime: ExecutionRuntime, sessionID: string, prior?: readonly ConversationMessage[]) => PlanConversation
  createController: (runtime: ExecutionRuntime) => ForegroundController
  discoverModels: (engine: CliEngine, worktree: string, signal?: AbortSignal) => Promise<ModelCatalog>
  /** Persisted `chat.default_model`; used only when neither --engine nor --model is given. */
  defaultModel: DefaultModelStore
  humanDecision: typeof humanDecision
  randomUUID: () => string
  signals: SignalSource
}

function approvedTaskIDs(value: unknown): { ids: string[]; total: number } {
  if (!Array.isArray(value)) return { ids: [], total: 0 }
  const ids = new Set<string>()
  for (let index = 0; index < Math.min(value.length, 1024); index++) {
    const id = value[index]
    if (typeof id === "string" && /^t\d{1,8}$/u.test(id)) ids.add(id)
  }
  return { ids: [...ids], total: value.length }
}

function approvedPlanTitles(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).steps)) return []
  const steps = (value as { steps: unknown[] }).steps
  return steps.slice(0, 1024).map(step => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return ""
    const title = (step as Record<string, unknown>).title
    return typeof title === "string" ? title : ""
  })
}

function skillConsentTerminal(terminal: Terminal): Pick<Terminal, "stdinIsTTY" | "stderrIsTTY" | "choose" | "resume"> {
  return {
    stdinIsTTY: terminal.stdinIsTTY,
    stderrIsTTY: terminal.stderrIsTTY,
    ...(terminal.choose ? { choose: (title: string, choices: readonly string[], signal: AbortSignal) =>
      terminal.choose!(terminalSafeText(title), choices.map(terminalSafeText), signal) } : {}),
    ...(terminal.resume ? { resume: () => terminal.resume?.() } : {}),
  }
}

function readProgressTasks(worktree: string, sessionID: string, taskIDs: readonly string[]): CliProgressTask[] | undefined {
  try {
    const path = ledgerPath(worktree, sessionID)
    if (statSync(path).size > 1024 * 1024) return undefined
    const ledger: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return undefined
    const value = ledger as Record<string, unknown>
    if (value.version !== 1 || value.sessionID !== sessionID || !Array.isArray(value.tasks)) return undefined
    const statuses = new Set<CliTaskStatus>(["pending", "running", "done", "failed", "cancelled"])
    const observed = new Map<string, CliTaskStatus>()
    for (const task of value.tasks) {
      if (!task || typeof task !== "object" || Array.isArray(task)) continue
      const record = task as Record<string, unknown>
      if (typeof record.id !== "string" || !taskIDs.includes(record.id) ||
          typeof record.status !== "string" || !statuses.has(record.status as CliTaskStatus)) continue
      observed.set(record.id, record.status as CliTaskStatus)
    }
    if (taskIDs.some(id => !observed.has(id))) return undefined
    return taskIDs.map(id => ({ id, status: observed.get(id)! }))
  } catch {
    return undefined
  }
}

/** Keep the newest complete pairs that fit the turn cap and the conversation character budget. */
function boundedPairs(pairs: readonly ConversationMessage[]): ConversationMessage[] {
  const kept: ConversationMessage[] = []
  let chars = 0
  for (let index = pairs.length - 2; index >= 0 && kept.length < MAX_CARRIED_MESSAGES; index -= 2) {
    const user = pairs[index]!
    const assistant = pairs[index + 1]!
    chars += user.text.length + assistant.text.length
    if (chars > MAX_PLAN_CONVERSATION_CHARS && kept.length) break
    kept.unshift(user, assistant)
  }
  return kept
}

export class InteractiveLaunchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InteractiveLaunchError"
  }
}

export { validModelID } from "./default-model.ts"

export function parseInteractiveArgs(argv: string[], cwd = process.cwd()): InteractiveArgs {
  const fields: Record<string, string> = {}
  const allowed = new Set(["--worktree", "--engine", "--model"])
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    if (!allowed.has(flag)) throw new InteractiveLaunchError("unknown chat option; use --worktree, --engine, or --model")
    if (Object.hasOwn(fields, flag)) throw new InteractiveLaunchError(`duplicate ${flag} option`)
    const value = argv[index + 1]
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new InteractiveLaunchError(`missing value for ${flag}`)
    }
    fields[flag] = value
    index++
  }
  const engine = fields["--engine"]
  if (engine !== undefined && engine !== "local" && engine !== "codex" && engine !== "claude") {
    throw new InteractiveLaunchError("invalid --engine; choose local, codex, or claude")
  }
  const model = fields["--model"]
  if (model !== undefined && !validModelID(model)) {
    throw new InteractiveLaunchError("invalid --model; enter a native model ID without whitespace")
  }
  return {
    worktree: fields["--worktree"] ?? cwd,
    ...(engine ? { engine } : {}),
    ...(model ? { model } : {}),
  }
}

function defaultGitTopLevel(directory: string): string | undefined {
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  delete gitEnv.GIT_DIR
  delete gitEnv.GIT_WORK_TREE
  delete gitEnv.GIT_COMMON_DIR
  const result = spawnSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
    encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0) return undefined
  const topLevel = result.stdout.trim()
  if (!topLevel) return undefined
  try { return realpathSync(topLevel) } catch { return undefined }
}

export function createReadlineTerminal(): Terminal {
  let reader: ReturnType<typeof createInterface> | undefined
  let inputClosed = false
  const read = (prompt: string, signal?: AbortSignal, cancelOnEscape = false): Promise<string | undefined> => {
    if (signal?.aborted || inputClosed) return Promise.resolve(undefined)
    if (!reader) {
      const created = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stderr.isTTY === true })
      reader = created
      created.once("close", () => {
        if (reader === created) {
          reader = undefined
          inputClosed = true
        }
      })
    }
    const activeReader = reader
    if (!activeReader) return Promise.resolve(undefined)
    const keypressInput = process.stdin as unknown as {
      on: (event: "keypress", listener: (text: string, key: { name?: string }) => void) => unknown
      off: (event: "keypress", listener: (text: string, key: { name?: string }) => void) => unknown
    }
    return new Promise(resolveLine => {
      let settled = false
      const finish = (line: string | undefined, discardReader = false) => {
        if (settled) return
        settled = true
        activeReader.off("line", onLine)
        activeReader.off("close", onClose)
        activeReader.off("SIGINT", onReadlineInterrupt)
        if (cancelOnEscape) keypressInput.off("keypress", onKeypress)
        signal?.removeEventListener("abort", onAbort)
        if (discardReader && reader === activeReader) {
          reader = undefined
          activeReader.close()
        }
        resolveLine(line)
      }
      const onLine = (line: string) => finish(line)
      const onClose = () => finish(undefined)
      const onReadlineInterrupt = () => finish(undefined)
      const onAbort = () => finish(undefined)
      const onKeypress = (_text: string, key: { name?: string }) => {
        if (key.name === "escape") finish(undefined, true)
      }
      activeReader.once("line", onLine)
      activeReader.once("close", onClose)
      activeReader.once("SIGINT", onReadlineInterrupt)
      if (cancelOnEscape) keypressInput.on("keypress", onKeypress)
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) return finish(undefined)
      activeReader.setPrompt(prompt)
      activeReader.prompt()
    })
  }
  const terminal: Terminal = {
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    presentation: () => ({
      columns: process.stderr.columns,
      color: inputColorSupported(
        process.stdin.isTTY === true && process.stderr.isTTY === true && Bun.enableANSIColors,
        { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM },
      ),
    }),
    readInput(input, signal) {
      if (signal.aborted || inputClosed) return Promise.resolve(undefined)
      const rendered = renderInput(input.title, input.hint, input.prompt, terminal.presentation?.())
      terminal.write(rendered.chrome)
      return read(rendered.prompt, signal, input.kind === "selection")
    },
    readLine(prompt, signal) { return read(prompt, signal) },
    async choose(title, choices, signal) {
      if (!choices.length || signal.aborted) return undefined
      const lines = [...terminalSafeText(title).split("\n"), ...choices.map((choice, index) => `  ${index + 1}) ${terminalSafeText(choice)}`)]
      // Consent identities and hashes must remain complete; let the terminal wrap rather than clipping them.
      process.stderr.write(lines.join("\n") + "\n")
      for (;;) {
        if (signal.aborted) return undefined
        const answer = await terminal.readLine(`Choice [1-${choices.length}; Enter cancels]: `, signal)
        if (answer === undefined || signal.aborted || answer.trim() === "") return undefined
        const selected = Number(answer.trim())
        if (Number.isSafeInteger(selected) && selected >= 1 && selected <= choices.length) return selected - 1
        process.stderr.write("Choose a listed number or press Enter to cancel.\n")
      }
    },
    write: (text) => { process.stderr.write(text) },
    close: () => {
      inputClosed = true
      reader?.close()
      reader = undefined
    },
  }
  return terminal
}

export function defaultDependencies(): InteractiveDependencies {
  return {
    cwd: process.cwd(),
    terminal: createReadlineTerminal(),
    gitTopLevel: defaultGitTopLevel,
    createRuntime: (options) => createCliRuntime(options),
    admitRuntime: async (runtime) => {
      assertHostAdmission(await runtime.host.preflight(runtime.host.identity.profile), runtime.host.identity.controlProfile)
    },
    createConversation: (runtime, sessionID, prior) => createPlanConversation(runtime, sessionID, prior),
    createController: createForegroundController,
    discoverModels: discoverModelCatalog,
    defaultModel: fileDefaultModelStore,
    humanDecision,
    randomUUID,
    signals: {
      on: (signal, listener) => { process.on(signal, listener) },
      off: (signal, listener) => { process.off(signal, listener) },
    },
  }
}

function canonicalWorktree(requested: string, deps: InteractiveDependencies): string {
  let directory: string
  try {
    directory = realpathSync(resolve(deps.cwd, requested))
    if (!statSync(directory).isDirectory()) throw new Error()
    accessSync(directory, constants.R_OK | constants.X_OK)
  } catch {
    throw new InteractiveLaunchError("chat requires an accessible Git worktree")
  }
  const topLevel = deps.gitTopLevel(directory)
  if (!topLevel || !isAbsolute(topLevel)) throw new InteractiveLaunchError("chat requires a canonical Git worktree")
  try {
    const canonical = realpathSync(topLevel)
    if (!statSync(canonical).isDirectory()) throw new Error()
    accessSync(canonical, constants.R_OK | constants.X_OK)
    return canonical
  } catch {
    throw new InteractiveLaunchError("chat requires a canonical Git worktree")
  }
}

function signalExit(signal: SignalName | undefined): InteractiveExit {
  return { code: signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : signal === "SIGHUP" ? 129 : 0 }
}

function readInput(terminal: Terminal, title: string, hint: string, prompt: string, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve(undefined)
  if (terminal.readInput) return terminal.readInput({ title, hint, prompt, kind: prompt === "You> " || prompt === "History> " ? "chat" : "selection" }, signal)
  const rendered = renderInput(title, hint, prompt, terminal.presentation?.())
  terminal.write(rendered.chrome)
  return terminal.readLine(rendered.prompt, signal)
}

async function chooseEngine(terminal: Terminal, signal: AbortSignal): Promise<CliEngine | null | undefined> {
  const engines: readonly CliEngine[] = ["local", "codex", "claude"]
  if (terminal.fullscreen && terminal.choose) {
    const selected = await terminal.choose("Choose an execution engine", [
      "local — Ollama CLI", "codex — Codex CLI", "claude — Claude CLI",
    ], signal, {
      kind: "picker", purpose: "selection", rows: ["Local Ollama runtime", "Codex CLI runtime", "Claude CLI runtime"],
      hint: "Enter selects this engine only; Escape or /cancel returns to the composer.",
    })
    if (signal.aborted) return undefined
    return selected === undefined ? null : engines[selected] ?? null
  }
  const menu = "Choose an execution engine:\n  1) local  — Ollama CLI\n  2) codex  — Codex CLI\n  3) claude — Claude CLI\nEnter /cancel, Escape or empty input to return.\n"
  terminal.write(menu.trimEnd().split("\n").map(line => inputLine(line, terminal.presentation?.())).join("\n") + "\n")
  while (!signal.aborted) {
    const answer = await readInput(terminal, "Engine selection", "Enter a number or engine name", "Engine [1-3]: ", signal)
    if (signal.aborted) return undefined
    if (answer === undefined) return null
    const normalized = answer.trim().toLowerCase()
    if (normalized === "" || normalized === "/cancel" || normalized === "escape") return null
    if (normalized === "1" || normalized === "local") return "local"
    if (normalized === "2" || normalized === "codex") return "codex"
    if (normalized === "3" || normalized === "claude") return "claude"
    terminal.write("Choose local, codex, or claude (1, 2, or 3).\n")
  }
  return undefined
}

type ModelChoice = {
  value: string | null | undefined
  discovery: InteractiveViewFacts["discovery"]
  backToEngine: boolean
}

async function chooseModel(
  terminal: Terminal,
  engine: CliEngine,
  worktree: string,
  signal: AbortSignal,
  discoverModels: InteractiveDependencies["discoverModels"],
): Promise<ModelChoice> {
  let catalog: ModelCatalog
  let discovery: ModelChoice["discovery"] = "completed"
  try {
    catalog = await discoverModels(engine, worktree, signal)
  } catch {
    if (signal.aborted) return { value: undefined, discovery, backToEngine: false }
    discovery = "failed"
    catalog = { models: [], notice: "Model discovery was unavailable." }
  }
  if (signal.aborted) return { value: undefined, discovery, backToEngine: false }
  const models = Array.isArray(catalog?.models)
    ? catalog.models.filter(model => !!model && validModelID(model.id) && typeof model.label === "string")
    : []
  const notice = typeof catalog?.notice === "string" ? catalog.notice : ""
  if (terminal.fullscreen && terminal.choose) {
    const entries = [
      ...models.map(model => ({ kind: "model" as const, value: model.id,
        label: model.label === model.id ? model.id : `${terminalSafeText(model.label)} - ${model.id}`,
        detail: model.id })),
      { kind: "manual" as const, label: "Enter a native model ID", detail: "An entered ID is not proof of model availability." },
      { kind: "back" as const, label: "Back to engine selection", detail: "Choose a different runtime engine." },
    ]
    const selected = await terminal.choose(
      `Choose a model · ${engine}`,
      entries.map(entry => entry.label),
      signal,
      {
        kind: "picker", purpose: "selection", rows: entries.map(entry => entry.detail),
        hint: discovery === "failed"
          ? "Model list unavailable. Enter an ID manually or cancel."
          : "Selection does not verify model availability.",
      },
    )
    if (signal.aborted) return { value: undefined, discovery, backToEngine: false }
    if (selected === undefined) return { value: null, discovery, backToEngine: false }
    const entry = entries[selected]
    if (!entry) return { value: null, discovery, backToEngine: false }
    if (entry.kind === "back") return { value: null, discovery, backToEngine: true }
    if (entry.kind === "model") return { value: entry.value, discovery, backToEngine: false }
    while (!signal.aborted) {
      const answer = await readInput(terminal, `Model ID · ${engine}`, "Enter a native model ID; /cancel or Escape returns.", "Model ID: ", signal)
      if (signal.aborted) return { value: undefined, discovery, backToEngine: false }
      if (answer === undefined || answer.trim() === "" || answer.trim().toLowerCase() === "/cancel" || answer.trim().toLowerCase() === "escape") {
        return { value: null, discovery, backToEngine: false }
      }
      const nativeID = answer.startsWith("id:") ? answer.slice(3) : answer
      if (validModelID(nativeID)) return { value: nativeID, discovery, backToEngine: false }
      terminal.write("Invalid model ID; use a non-empty native name without whitespace.\n")
    }
    return { value: undefined, discovery, backToEngine: false }
  }
  const presentation = terminal.presentation?.()
  const menu = [
    models.length ? `Model choices for ${engine}:` : `No model choices were discovered for ${engine}.`,
    ...models.map((model, index) => `  ${index + 1}) ${terminalSafeText(model.label)} — ${model.id}`),
    ...(notice ? [terminalSafeText(notice)] : []),
    "Select a number or native model ID; id:<ID> for numeric IDs.",
    "Enter /back to choose another engine; /cancel, Escape or empty input cancels selection. No default is selected.",
  ]
  terminal.write(menu.map(line => inputLine(line, presentation)).join("\n") + "\n")
  while (!signal.aborted) {
    const prompt = models.length ? `Model [1-${models.length} or native ID]: ` : "Model [native ID]: "
    const answer = await readInput(terminal, `Model selection · ${engine}`, "Enter select · /cancel back · no default", prompt, signal)
    if (signal.aborted) return { value: undefined, discovery, backToEngine: false }
    if (answer === undefined || answer.trim() === "" || answer.trim() === "/cancel" || answer.trim().toLowerCase() === "escape") {
      return { value: null, discovery, backToEngine: false }
    }
    if (answer.trim() === "/back") return { value: null, discovery, backToEngine: true }
    if (/^[0-9]+$/u.test(answer)) {
      const index = Number(answer)
      if (index >= 1 && index <= models.length) return { value: models[index - 1]!.id, discovery, backToEngine: false }
      terminal.write("Invalid model choice; select a listed number or enter a native model ID.\n")
      continue
    }
    const nativeID = answer.startsWith("id:") ? answer.slice(3) : answer
    if (validModelID(nativeID)) return { value: nativeID, discovery, backToEngine: false }
    terminal.write("Invalid model ID; use a non-empty native name without whitespace.\n")
  }
  return { value: undefined, discovery, backToEngine: false }
}

function selectionBanner(worktree: string, engine: CliEngine, model: string, presentation?: InputPresentation, note?: string): string {
  return "\n" + [
    "Native execution selection:",
    `  Engine: ${engine}`,
    `  Model: ${model}`,
    `  Worktree: ${worktree}`,
    ...(note ? [`  ${note}`] : []),
  ].map(line => inputLine(line, presentation)).join("\n") + "\n\n"
}

function switchNote(turns: number, source: { engine: string; model: string } | undefined): string {
  return turns && source
    ? `Conversation continues: ${turns} earlier turn${turns === 1 ? "" : "s"} from ${source.engine} / ${source.model}, sent with your next message.`
    : "New conversation: no earlier turns to carry."
}

function helpText(context: InteractiveContext = "chat"): string {
  return interactiveHelp(context)
}

function hasInteractiveAction(context: InteractiveContext, id: string): boolean {
  return interactiveActions(context).some(action => action.id === id)
}

function commandDraft(actionSyntax: string, insertion: string): string {
  return actionSyntax.includes(" <") ? `${insertion} ` : insertion
}

async function presentHelp(terminal: Terminal, context: InteractiveContext, signal: AbortSignal): Promise<void> {
  const entries = interactiveActions(context).flatMap(action => {
    const insertion = commandInsertion(action)
    return insertion ? [{ action, insertion }] : []
  })
  if (terminal.fullscreen && terminal.choose && terminal.setDraft) {
    const selected = await terminal.choose(
      "Commands",
      entries.map(({ action, insertion }) => `${insertion} — ${action.summary}`),
      signal,
      {
        kind: "picker",
        purpose: "command",
        rows: entries.map(({ action }) => action.syntax),
        hint: "Enter inserts only; press Enter again to submit. Escape keeps the draft.",
      },
    )
    if (selected !== undefined) {
      const entry = entries[selected]
      if (entry) terminal.setDraft?.(commandDraft(entry.action.syntax, entry.insertion))
    }
    return
  }
  terminal.write(helpText(context))
}

function safeSkillAudit(
  value: unknown,
  expected: { sessionID: string; epoch: string; name: string; contentHash: string },
): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const audit = value as Record<string, unknown>
  const keys = ["supervisorSessionID", "attachmentEpoch", "source", "name", "contentHash", "invocationID"]
  if (Object.keys(audit).length !== keys.length || keys.some(key => !Object.hasOwn(audit, key)) ||
      audit.supervisorSessionID !== expected.sessionID || audit.attachmentEpoch !== expected.epoch ||
      audit.name !== expected.name || audit.contentHash !== expected.contentHash ||
      typeof audit.source !== "string" || !audit.source || audit.source.length > 4096 ||
      typeof audit.invocationID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(audit.invocationID)) return undefined
  return Object.freeze({
    supervisorSessionID: expected.sessionID,
    attachmentEpoch: expected.epoch,
    name: expected.name,
    contentHash: expected.contentHash,
    invocationID: audit.invocationID,
  })
}

function skillCatalogLines(catalog: SkillCatalog): string[] {
  const lines = ["Skills available for explicit invocation:"]
  for (const entry of catalog.entries) {
    const descriptor = entry.descriptor
    const classification = descriptor.kind === "protected-workflow" ? "protected workflow" : entry.classification
    const description = boundedTerminalDiagnostic(descriptor.description, 180)
    const scope = descriptor.kind === "skill" && descriptor.allowedTools !== undefined
      ? ` · declared tools: ${descriptor.allowedTools.join(", ") || "none"}`
      : ""
    const refusal = entry.refusal ? ` · unavailable: ${terminalSafeText(entry.refusal)}` : ""
    const trusted = entry.trusted ? " · trusted" : ""
    lines.push(`  /skill:${descriptor.name} · ${descriptor.source} · ${classification}${trusted}${description ? ` · ${description}` : ""}${scope}${refusal}`)
  }
  for (const refusal of catalog.refusals) {
    const name = refusal.name ? ` ${boundedTerminalDiagnostic(refusal.name, 120)}` : ""
    lines.push(`  Refused ${refusal.source}${name} · ${refusal.reason}`)
  }
  if (!catalog.entries.length && !catalog.refusals.length) lines.push("  No skills or protected workflows were discovered.")
  if (catalog.entries.some(entry => entry.trusted)) lines.push("Trusted skills (skill_trust in the user lca.jsonc) skip the consent prompt; tool and execution approvals are unchanged.")
  lines.push("Only a submitted /skill:<name> command invokes a skill. deep-interview, ralplan, ultragoal and autoresearch start LCA-owned workflows; invoking a name is not execution consent, and unit/experiment work still needs typed approval.")
  return lines
}

function defaultSessionID(uuid: string): string {
  return `lca-${uuid}`
}

function planForImport(value: unknown, worktree: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InteractiveLaunchError("conversation did not return a valid plan")
  }
  const existing = activeWorkflow(worktree)
  const revision = existing
    ? 1 + existing.counters.code_invalid + existing.counters.review_iterations + existing.counters.user_rejections
    : 1
  const parsed = { ...(value as Record<string, unknown>) }
  delete parsed.revision
  return { ...parsed, revision }
}

function planValidationFeedback(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message.startsWith("invalid plan:")) return undefined
  const detail = terminalSafeText(error.message.slice("invalid plan:".length))
    .replace(/[ \t\n]+/g, " ")
    .trim()
  const limit = 240
  const bounded = detail.length > limit ? `${detail.slice(0, limit - 3)}...` : detail
  return `Plan rejected by LCA validation${bounded ? `: ${bounded}` : ""}. Revise the plan or enter /quit.\n`
}

export async function runInteractiveSession(
  args: InteractiveArgs,
  overrides: Partial<InteractiveDependencies> = {},
): Promise<InteractiveExit> {
  const deps = { ...defaultDependencies(), ...overrides }
  const terminal = deps.terminal
  const skillTerminal = skillConsentTerminal(terminal)
  if (!terminal.stdinIsTTY || !terminal.stderrIsTTY) {
    terminal.close()
    throw new InteractiveLaunchError("chat requires an interactive terminal on stdin and stderr")
  }

  const abort = new AbortController()
  let sessionStore: SessionStore | undefined
  let attachedRuntime: ExecutionRuntime | undefined
  let skillSession: SkillSession | undefined
  let retainedSDKSessionID: string | undefined
  let retainedViewSelection: { engine: string; model: string } | undefined
  let persistenceFailed = false
  const visibleWrite = terminal.write.bind(terminal)
  const persist = (kind: TranscriptKind, data: Record<string, unknown>, eventID?: string) => {
    if (persistenceFailed) throw new InteractiveLaunchError("Session transcript persistence failed; the session remains held.")
    if (!sessionStore) return undefined
    try { return sessionStore.append(kind, data, eventID) }
    catch (error) { persistenceFailed = true; abort.abort(); throw error }
  }
  terminal.write = text => { persist("notice", { text }); visibleWrite(text) }
  const showExecution = terminal.executionSnapshot?.bind(terminal)
  const showTasks = terminal.taskSnapshot?.bind(terminal)
  const evidenceSnapshots = new Map<string, string>()
  const taskSnapshots = new Map<string, CliTaskStatus>()
  terminal.executionSnapshot = (state, active) => {
    for (const execution of state.executions) {
      if (!sessionStore || execution.ownerSession !== sessionStore.sessionID) continue
      const quiescent = execution.reconciliation?.outcome === "terminal" && execution.reconciliation.quiescent === true || execution.terminal?.quiescentAt !== undefined
      const proven = !!execution.terminal && quiescent && settled(execution) && !state.claim && !active
      const data = { executionID: execution.executionId, taskID: execution.taskId,
        terminal: execution.terminal?.outcome ?? "unconfirmed", reconciliation: execution.reconciliation?.outcome ?? "unobserved",
        quiescent, cancel: execution.cancel ? proven ? "stopped with proof" : "unconfirmed" : null, claim: !!state.claim, fence: !!execution.fence }
      const key = JSON.stringify([sessionStore.epoch, execution.executionId])
      const serialized = JSON.stringify(data)
      if (evidenceSnapshots.get(key) !== serialized) {
        persist("task-evidence", data)
        evidenceSnapshots.set(key, serialized)
      }
    }
    showExecution?.(state, active)
  }
  terminal.taskSnapshot = tasks => {
    for (const task of tasks) {
      if (!sessionStore) continue
      const key = JSON.stringify([sessionStore.epoch, task.id])
      if (taskSnapshots.get(key) !== task.status) {
        persist("task-state", { taskID: task.id, status: task.status })
        taskSnapshots.set(key, task.status)
      }
    }
    showTasks?.(tasks)
  }
  const progress = createCliProgressPresenter(text => terminal.write(text), activity => {
    if (sessionStore) {
      try { persistToolActivity(sessionStore, activity) }
      catch (error) { persistenceFailed = true; abort.abort(); throw error }
    }
    terminal.activity?.(activity)
  }, { toolLines: !terminal.activity, mainModelLines: !terminal.fullscreen })
  const queueProgress = progress.queue
  progress.queue = (message, fields) => {
    if (fields && typeof fields.task === "string") {
      const status = message === "task start" || message === "data task start" ? "running" : message === "task finished" ? fields.status : undefined
      if (typeof status === "string") persist("task-state", { taskID: fields.task, status })
    }
    queueProgress(message, fields)
    terminal.queueActivity?.(message, fields)
  }
  const scopedProgress = () => {
    let epoch: string | undefined
    let sessionID: string | undefined
    const current = () => epoch !== undefined && sessionStore?.epoch === epoch && sessionStore.sessionID === sessionID
    return {
      bind(store: SessionStore) { epoch = store.epoch; sessionID = store.sessionID },
      sink: {
        host(activity: CliHostActivity) { if (current()) progress.host(activity) },
        queue(message: string, fields?: Record<string, unknown>) { if (current()) progress.queue(message, fields) },
      },
    }
  }
  let observedTasks: { worktree: string; sessionID: string; ids: string[] } | undefined
  let receivedSignal: SignalName | undefined
  const signalCancel = (signal?: SignalName) => {
    receivedSignal ??= signal
    try { progress.cancelRequested() } catch { persistenceFailed = true }
    abort.abort()
  }
  const onSigint = () => shellAbort ? shellAbort.abort() : signalCancel("SIGINT")
  const onSigterm = () => signalCancel("SIGTERM")
  const onSighup = () => signalCancel("SIGHUP")
  let requestCancel = () => { progress.cancelRequested(); abort.abort() }
  let requestPause = () => { terminal.write("Pause unavailable: no live workflow.\n") }
  let requestSuspend = () => { terminal.write("Suspension refused: execution quiescence has not been established.\n") }
  const onSigtstp = () => requestSuspend()
  let signalWorktree: string | undefined
  const onSigcont = () => {
    terminal.resume?.()
    terminal.write("Terminal resumed; no work was automatically restarted.\n")
    // B7: redraw the Keep/Resume decision for a settled pause. It is shown, never taken: /continue asks and rechecks.
    try {
      const paused = signalWorktree ? activeWorkflow(signalWorktree) : null
      if (signalWorktree && paused && isPauseSettled(paused)) {
        const partition = taskPartition(readLedger(signalWorktree, paused.sessionID), paused.id, paused.planRef?.jsonSha ?? null)
        terminal.write(terminalSafeText(`Paused from ${paused.pausedFrom?.phase ?? "?"}/${paused.pausedFrom?.stage ?? "?"}: residual ${partition.residual.join(", ") || "none"}; done ${partition.done.join(", ") || "none"}. Kept held; /continue offers Keep or Resume.\n`))
      } else if (paused?.stopIntent) terminal.write(`${stopDisplay(paused) === "cancelling" ? STOP_LABEL.cancelling : STOP_LABEL.pausing}\n`)
    } catch { /* display only */ }
  }
  // Operator `!command`: the host owns the run (cwd, cancellation, persistence); the terminal only renders it.
  let shellAbort: AbortController | undefined
  async function runShell(command: string, cwd: string): Promise<void> {
    const id = `shell:${deps.randomUUID()}`
    const controller = new AbortController()
    const onSessionAbort = () => controller.abort()
    shellAbort = controller
    abort.signal.addEventListener("abort", onSessionAbort, { once: true })
    const view = terminal.shellStart?.({ id, command })
    if (!view) visibleWrite(terminalSafeText(`$ ${command}\n`))
    let printed = 0
    const printCompleted = (completed: number, tail: readonly string[]) => {
      const fresh = Math.min(completed - printed, tail.length)
      if (fresh > 0) visibleWrite(terminalSafeText(`${tail.slice(-fresh).join("\n")}\n`))
      printed = completed
    }
    try {
      const result = await runOperatorShell(command, {
        cwd, signal: controller.signal,
        onUpdate: snapshot => view ? view.output(snapshot) : printCompleted(snapshot.completed, snapshot.completedTail),
      })
      if (view) view.finish(result)
      else {
        printCompleted(result.totalLines, result.lines)
        const seconds = `${(result.durationMs / 1000).toFixed(1)}s`
        const outcome = result.status === "cancelled" ? "cancelled" : result.status === "timeout" ? "timed out" :
          result.signal ? `signal ${result.signal}` : `exit ${result.exitCode ?? "?"}`
        visibleWrite(`[shell] ${outcome} · ${seconds}\n`)
      }
      persist("shell", { command, status: result.status, exitCode: result.exitCode, signal: result.signal,
        durationMs: result.durationMs, lines: [...result.lines], totalLines: result.totalLines }, id)
    } finally {
      abort.signal.removeEventListener("abort", onSessionAbort)
      if (shellAbort === controller) shellAbort = undefined
    }
  }
  terminal.controls?.(action => {
    // Esc / Ctrl+C / /cancel stop a running operator shell before they reach the session.
    if (shellAbort && (action === "cancel" || action === "shutdown")) shellAbort.abort()
    else if (action === "shutdown") onSigint()
    else if (action === "quit") signalCancel()
    else if (action === "disconnect") onSighup()
    else if (action === "suspend") requestSuspend()
    else if (action === "pause") requestPause()
    else requestCancel()
  })
  async function withProgressSuspended<T>(operation: () => Promise<T>): Promise<T> {
    progress.suspend()
    try { return await operation() }
    finally { progress.resume() }
  }
  let sigintRegistered = false
  let sigtermRegistered = false
  try {
    deps.signals.on("SIGINT", onSigint)
    sigintRegistered = true
    deps.signals.on("SIGTERM", onSigterm)
    sigtermRegistered = true
    deps.signals.on("SIGHUP", onSighup)
    if (terminal.fullscreen) {
      deps.signals.on("SIGTSTP", onSigtstp)
      deps.signals.on("SIGCONT", onSigcont)
    }
    const worktree = canonicalWorktree(args.worktree, deps)
    signalWorktree = worktree
    let latestSkillCatalog: SkillCatalog | undefined
    async function bindSkillSession(store: SessionStore): Promise<void> {
      skillSession?.close()
      skillSession = undefined
      latestSkillCatalog = undefined
      try {
        const roots = await resolveSkillRoots({ projectRoot: worktree, homeDirectory: homedir() })
        const trust = readSkillTrust()
        if (trust.problem) visibleWrite(terminalSafeText(`Skill trust ignored: ${boundedTerminalDiagnostic(trust.problem)}. Skills still ask for consent.\n`))
        const candidate = await SkillSession.create({ roots, store, terminal: skillTerminal, trust: trust.trust }, abort.signal)
        if (abort.signal.aborted || sessionStore !== store || retainedSDKSessionID) {
          candidate.close()
          return
        }
        skillSession = candidate
        await refreshSkillCatalog(candidate)
      } catch {
        if (abort.signal.aborted || sessionStore !== store || retainedSDKSessionID) return
        terminal.skillCatalog?.({ entries: [], refusals: [] })
        visibleWrite("Skill catalog unavailable; source invocation is disabled for this session.\n")
      }
    }
    async function refreshSkillCatalog(target = skillSession): Promise<void> {
      if (!target || target !== skillSession || abort.signal.aborted || !sessionStore || target.store !== sessionStore) return
      try {
        const catalog = await target.catalog(abort.signal)
        if (target !== skillSession || target.store !== sessionStore || abort.signal.aborted) return
        terminal.skillCatalog?.(catalog)
        latestSkillCatalog = catalog
      } catch {
        if (abort.signal.aborted || target !== skillSession) return
        target.close()
        skillSession = undefined
        terminal.skillCatalog?.({ entries: [], refusals: [] })
        latestSkillCatalog = undefined
        visibleWrite("Skill catalog unavailable; source invocation is disabled for this session.\n")
      }
    }
    const describeDefault = (lookup: DefaultModelLookup): string => lookup.state === "configured"
      ? `Default model: ${lookup.value.engine} / ${lookup.value.model} (${lookup.source} config).`
      : lookup.state === "invalid"
        ? `Default model ignored: ${boundedTerminalDiagnostic(lookup.reason)}.`
        : "No default model is set."
    /**
     * `/model default` shows the default; `save` stores the current selection; `<engine> <id>` stores that model;
     * `clear` removes it. Saving never switches an active session. Returns a model to select only when none is
     * selected yet and the operator named one explicitly.
     */
    // Notices that must outlive selection: the full-screen transcript reloads from the new session's history.
    const startupNotices: string[] = []
    const defaultModelCommand = (rest: readonly string[], current: { engine: CliEngine; model: string } | undefined): { engine: CliEngine; model: string } | undefined => {
      let deferNext = false
      const write = (text: string) => {
        if (deferNext) startupNotices.push(text)
        else terminal.write(terminalSafeText(`${text}\n`))
      }
      const save = (value: { engine: CliEngine; model: string }): boolean => {
        try {
          const path = deps.defaultModel.save(value)
          const effective = deps.defaultModel.read(worktree)
          const overridden = effective.state === "configured" && effective.source === "project" &&
            (effective.value.engine !== value.engine || effective.value.model !== value.model)
          write(`Saved default model ${value.engine} / ${value.model} to ${path}.${overridden ? ` This project's .lca/lca.jsonc still selects ${effective.value.engine} / ${effective.value.model}.` : ""}`)
          return true
        } catch (error) {
          write(`Default model not saved: ${boundedTerminalDiagnostic(String(error))}`)
          return false
        }
      }
      if (rest.length === 0 || (rest.length === 1 && rest[0] === "show")) {
        write(`${describeDefault(deps.defaultModel.read(worktree))} Use /model default save, /model default <local|codex|claude> <native-id>, or /model default clear.`)
        return undefined
      }
      if (rest.length === 1 && rest[0] === "clear") {
        try { write(deps.defaultModel.clear() ? "Default model cleared from user config." : "No user default model was set.") }
        catch (error) { write(`Default model not cleared: ${boundedTerminalDiagnostic(String(error))}`) }
        return undefined
      }
      if (rest.length === 1 && rest[0] === "save") {
        if (!current) write("No model is selected yet; use /model default <local|codex|claude> <native-id>.")
        else if (save(current)) write("The current session is unchanged.")
        return undefined
      }
      if (rest.length === 2 && ["local", "codex", "claude"].includes(rest[0]!) && validModelID(rest[1]!)) {
        const value = { engine: rest[0] as CliEngine, model: rest[1]! }
        deferNext = !current
        const saved = save(value)
        deferNext = false
        if (!saved) {
          for (const notice of startupNotices.splice(0)) write(notice)
          return undefined
        }
        if (current) {
          write(`The current session is unchanged; use /model ${value.engine} ${value.model} to switch now.`)
          return undefined
        }
        return value
      }
      write("Usage: /model default [show | save | clear | <local|codex|claude> <native-id>]")
      return undefined
    }
    let engine: CliEngine | undefined
    let model: string | undefined
    let startupDiscovery: InteractiveViewFacts["discovery"] = "not-observed"
    // Explicit flags win; a persisted default applies only when neither flag was given.
    const configuredDefault: DefaultModelLookup = args.engine === undefined && args.model === undefined
      ? deps.defaultModel.read(worktree)
      : { state: "unset" }
    if (args.engine !== undefined && args.model !== undefined) {
      engine = args.engine
      model = args.model
    } else if (configuredDefault.state === "configured") {
      engine = configuredDefault.value.engine
      model = configuredDefault.value.model
      if (!terminal.fullscreen) {
        terminal.write(terminalSafeText(`Using default model ${engine} / ${model} from ${configuredDefault.source} config; /model switches, /model default clear removes it.\n`))
      }
    } else {
      if (configuredDefault.state === "invalid") {
        terminal.write(terminalSafeText(`Default model ignored: ${boundedTerminalDiagnostic(configuredDefault.reason)}. Choose with /model.\n`))
      }
      terminal.actionContext?.("unselected")
      const selectionTitle = args.engine
        ? `Engine ${args.engine} selected; model unselected`
        : args.model
          ? "Model supplied; engine unselected"
          : "Model not selected"
      selection: while (!abort.signal.aborted) {
        const input = await withProgressSuspended(() => readInput(
          terminal,
          selectionTitle,
          "/model choose | /help | /quit",
          "You> ",
          abort.signal,
        ))
        if (abort.signal.aborted) return signalExit(receivedSignal)
        if (input === undefined) return { code: 0 }
        const message = input.trim()
        if (!message) continue
        if (message.startsWith("!")) {
          // No session exists yet: the run is shown but not recorded.
          const shellCommand = message.slice(1).trim()
          if (!shellCommand) visibleWrite("Usage: !<command> runs one shell command in the worktree.\n")
          else if (Buffer.byteLength(shellCommand, "utf8") > MAX_SHELL_COMMAND_BYTES) visibleWrite(`Shell command exceeds ${MAX_SHELL_COMMAND_BYTES} bytes; no command was run.\n`)
          else await runShell(shellCommand, worktree)
          continue
        }
        const [command, ...commandArgs] = message.split(/\s+/u)
        if (command === "/quit" && commandArgs.length === 0) return { code: 0 }
        if (command === "/help" && hasInteractiveAction("unselected", "help")) {
          if (commandArgs.length === 0) await presentHelp(terminal, "unselected", abort.signal)
          else terminal.write("Usage: /help\n")
          continue
        }
        if (["/search", "/expand", "/details", "/theme", "/ascii"].includes(command!)) {
          terminal.write(`${command} is a local full-screen TUI action; it is unavailable in readline and no model turn was dispatched.\n`)
          continue
        }
        if (command === "/model" && commandArgs[0] === "default" && hasInteractiveAction("unselected", "model")) {
          const chosen = defaultModelCommand(commandArgs.slice(1), undefined)
          if (chosen) {
            engine = chosen.engine
            model = chosen.model
            break
          }
          continue
        }
        if (command === "/model" && hasInteractiveAction("unselected", "model")) {
          if (commandArgs.length === 2 && ["local", "codex", "claude"].includes(commandArgs[0]!) && validModelID(commandArgs[1]!)) {
            engine = commandArgs[0] as CliEngine
            model = commandArgs[1]!
            break
          }
          if (commandArgs.length !== 0) {
            terminal.write("Usage: /model or /model <local|codex|claude> <native-id>\n")
            continue
          }
          let nextEngine: CliEngine | null | undefined = args.engine
          if (!nextEngine) {
            nextEngine = await withProgressSuspended(() => chooseEngine(terminal, abort.signal))
            if (abort.signal.aborted) return signalExit(receivedSignal)
            if (!nextEngine) continue
          }
          while (!abort.signal.aborted) {
            const picked = args.model !== undefined
              ? { value: args.model, discovery: "not-observed" as const, backToEngine: false }
              : await withProgressSuspended(() => chooseModel(terminal, nextEngine!, worktree, abort.signal, deps.discoverModels))
            if (abort.signal.aborted) return signalExit(receivedSignal)
            if (picked.backToEngine) {
              nextEngine = await withProgressSuspended(() => chooseEngine(terminal, abort.signal))
              if (abort.signal.aborted) return signalExit(receivedSignal)
              if (!nextEngine) break
              continue
            }
            if (picked.value === null) break
            if (picked.value === undefined) return signalExit(receivedSignal)
            if (!validModelID(picked.value)) {
              terminal.write("Invalid model ID; enter a native model name without whitespace.\n")
              break
            }
            engine = nextEngine!
            model = picked.value
            startupDiscovery = picked.discovery
            break selection
          }
          if (abort.signal.aborted) return signalExit(receivedSignal)
          continue
        }
        if (message.startsWith("/")) {
          terminal.write("Unknown local command. Enter /help for usage, or /model to choose an engine and model. Nothing was sent.\n")
        } else {
          terminal.write("No model selected; use /model to choose an engine and model. Nothing was sent.\n")
        }
      }
      if (abort.signal.aborted) return signalExit(receivedSignal)
    }
    if (!engine || !model || abort.signal.aborted) return signalExit(receivedSignal)
    if (!validModelID(model)) throw new InteractiveLaunchError("invalid model ID; enter a native model name without whitespace")
    terminal.actionContext?.("chat")

    terminal.write("\nNative CLI limitations: input size is estimated and output limits are reactive; these are not strict guarantees. No process or filesystem containment is claimed.\n\n")
    const initialSessionID = defaultSessionID(deps.randomUUID())
    const initialProgress = scopedProgress()
    const initialRuntime = deps.createRuntime({ worktree, engine, model, progress: initialProgress.sink })
    initialRuntime.linuxAdmission?.assertBootEpoch()
    await deps.admitRuntime(initialRuntime)
    if (abort.signal.aborted) return signalExit(receivedSignal)
    sessionStore = attachAdmission(initialRuntime, initialSessionID, { engine, model })
    initialProgress.bind(sessionStore)
    attachedRuntime = initialRuntime
    let selection = {
      engine,
      model,
      sessionID: initialSessionID,
      runtime: initialRuntime,
      controller: deps.createController(initialRuntime),
      conversation: deps.createConversation(initialRuntime, initialSessionID),
    }
    let requestObservation: RequestObservation = { state: "not-observed" }
    let discoveryObservation: InteractiveViewFacts["discovery"] = startupDiscovery
    const currentViewIdentity = (): ViewIdentity => sessionStore
      ? { mode: "writable", sessionID: selection.sessionID, epoch: sessionStore.epoch }
      : { mode: "retained-read-only", sessionID: retainedSDKSessionID ?? selection.sessionID }
    let requestSequence = 0
    const publishView = (): void => {
      if (!terminal.viewSnapshot) return
      const identity = currentViewIdentity()
      let workflow: InteractiveViewFacts["workflow"] = { state: "unknown" }
      let owner: InteractiveViewFacts["owner"] = "unknown"
      try {
        const current = activeAnyWorkflow(worktree)
        workflow = { state: "known", value: current ? {
          id: current.id,
          kind: current.kind,
          stage: current.stage,
          phase: current.phase,
          revision: current.lastSeq,
        } : null }
        owner = !current ? "none" : current.sessionID === identity.sessionID ? "current-session" : "foreign"
      } catch {}
      let claim: InteractiveViewFacts["claim"] = { state: "unknown" }
      let fence: InteractiveViewFacts["fence"] = { state: "unknown" }
      let termination: InteractiveViewFacts["termination"] = "not-observed"
      try {
        const state = selection.runtime.runs.status()
        claim = { state: "known", value: !!state.claim }
        fence = { state: "known", value: state.executions.some(execution => !!execution.fence) }
        if (state.executions.some(execution => execution.cancel && !settled(execution))) termination = "unconfirmed"
        else if (state.executions.some(execution => execution.terminal && settled(execution))) termination = "proven"
      } catch {}
      terminal.viewSnapshot({
        identity,
        selection: retainedViewSelection ?? { engine: selection.engine, model: selection.model },
        hold: sessionStore
          ? { state: "known", value: { held: effectiveHold(worktree, selection.sessionID), ...(sessionStore.metadata.holdReason ? { reason: sessionStore.metadata.holdReason } : {}) } }
          : { state: "known", value: { held: true, reason: "retained read-only history" } },
        workflow,
        owner,
        claim,
        fence,
        termination,
        discovery: discoveryObservation,
        request: requestObservation,
      })
    }
    const usedSessionIDs = new Set([initialSessionID])
    terminal.bindSession?.(initialSessionID)
    terminal.bindView?.(currentViewIdentity())
    terminal.transcriptSource?.(options => replaySession(worktree, initialSessionID, options))
    for (const notice of startupNotices.splice(0)) terminal.write(terminalSafeText(`${notice}\n`))
    publishView()
    await bindSkillSession(sessionStore)
    if (abort.signal.aborted) return signalExit(receivedSignal)
    let operationAbort: AbortController | undefined
    /** The committed non-plan (planning-kind) workflow this session owns, if any. */
    function ownedPlanningWorkflow() {
      const wf = activeAnyWorkflow(worktree)
      return wf && wf.kind !== "plan" && wf.sessionID === selection.sessionID ? wf : undefined
    }
    const workflowHost: WorkflowHost = createWorkflowHost({
      worktree, terminal, processSignal: abort.signal,
      runtime: () => selection.runtime,
      sessionID: () => selection.sessionID,
      persist: (kind, data) => { persist(kind, data) },
      readInput: (input, signal) => withProgressSuspended(() => readInput(terminal, input.title, input.hint, input.prompt, signal)),
      runApprovedUnit: (sessionID, signal, resumed) => selection.controller.runApprovedUnit(sessionID, signal, resumed),
      admit: async () => {
        selection.runtime.linuxAdmission?.assertBootEpoch()
        await deps.admitRuntime(selection.runtime)
      },
      resumeHeld: async revision => {
        const epoch = sessionStore?.epoch
        if (!epoch || sessionStore?.epoch !== epoch) throw new InteractiveLaunchError("Session attachment changed during Resume preflight.")
        selection.runtime.linuxAdmission?.assertBootEpoch()
        await deps.admitRuntime(selection.runtime)
        if (sessionStore?.epoch !== epoch) throw new InteractiveLaunchError("Session attachment changed during Resume preflight.")
        sessionStore = resumeAdmission(selection.runtime, selection.sessionID, revision)
        await refreshSkillCatalog()
      },
      setOperation: controller => { operationAbort = controller },
      statusText: () => String(selection.controller.status(selection.sessionID)),
    })
    const reportTurnCancellation = () => {
      const state = selection.runtime.runs.status()
      terminal.executionSnapshot?.(state, false)
      terminal.write(!state.claim && state.executions.every(settled)
        ? "Conversation stopped with termination proof; no plan was admitted.\n"
        : "Conversation cancellation unconfirmed; execution fence retained.\n")
    }
    const reportSkillCancellation = () => {
      visibleWrite("Skill source consent cancelled; no model turn was dispatched.\n")
    }
    requestCancel = () => {
      if (retainedSDKSessionID) {
        terminal.write(`Retained SDK session ${retainedSDKSessionID} is read-only; cancellation is unavailable.\n`)
        return
      }
      const current = activeWorkflow(worktree)
      const planning = ownedPlanningWorkflow()
      if (!operationAbort && current?.sessionID !== selection.sessionID && !planning) return
      progress.cancelRequested()
      const interrupting = operationAbort !== undefined
      operationAbort?.abort()
      try {
        if (planning) {
          // Escape interrupts the running step or answer prompt and leaves the workflow committed; only an explicit
          // /cancel (no operation running) stops it.
          if (!interrupting) {
            const stopped = requestWorkflowStop(selection.runtime, worktree, selection.sessionID, "cancel")
            terminal.write(`${stopped.text}\n`)
          }
          workflowHost.syncStatus()
        } else if (current?.sessionID === selection.sessionID) {
          const result = selection.controller.cancel(selection.sessionID)
          if (!result.ok) terminal.write(`Cancellation refused: ${boundedTerminalDiagnostic(result.text)}\n`)
          else {
            // B6: a cancel request is never a stopped display; the label says what is proven.
            const latest = activeWorkflow(worktree)
            terminal.write(latest?.sessionID === selection.sessionID && stopDisplay(latest) === "cancelling" ? `${STOP_LABEL.cancelling}\n` : "cancelled\n")
          }
        }
        terminal.executionSnapshot?.(selection.runtime.runs.status(), true)
      } catch (error) {
        terminal.write(`Cancellation unconfirmed: ${boundedTerminalDiagnostic(String(error))}\n`)
      }
    }
    /** Pause is a request: the label stays "pausing — termination unconfirmed" until the owner proves quiescence. */
    requestPause = () => {
      if (retainedSDKSessionID) {
        terminal.write(`Retained SDK session ${retainedSDKSessionID} is read-only; pause is unavailable.\n`)
        return
      }
      const current = activeWorkflow(worktree)
      if (current?.sessionID !== selection.sessionID) {
        if (ownedPlanningWorkflow()) {
          operationAbort?.abort()
          terminal.write(`${requestWorkflowStop(selection.runtime, worktree, selection.sessionID, "pause").text}\n`)
          workflowHost.syncStatus()
        } else terminal.write("Pause refused: no live workflow in this session.\n")
        return
      }
      try {
        const result = selection.controller.pause(selection.sessionID)
        if (!result.ok) terminal.write(`Pause refused: ${boundedTerminalDiagnostic(result.text)}\n`)
        else {
          const latest = activeWorkflow(worktree)
          terminal.write(latest && stopDisplay(latest) === "paused" ? "paused\n" : `${STOP_LABEL.pausing}\n`)
        }
        terminal.executionSnapshot?.(selection.runtime.runs.status(), true)
      } catch (error) {
        terminal.write(`Pause refused: ${boundedTerminalDiagnostic(String(error))}\n`)
      }
    }
    /** Ctrl+Z: request a pause and suspend only once the pause is settled with no blockers (B7). */
    requestSuspend = () => {
      if (retainedSDKSessionID) {
        terminal.write(`Retained SDK session ${retainedSDKSessionID} is read-only; suspension is unavailable.\n`)
        return
      }
      const current = activeAnyWorkflow(worktree)
      if (current?.sessionID === selection.sessionID && !isPauseSettled(current)) {
        if (current.stopIntent?.kind !== "cancel") requestPause()
        else terminal.write(`${STOP_LABEL.cancelling}\n`)
      } else if (!current || current.sessionID !== selection.sessionID) requestCancel()
      const latest = activeAnyWorkflow(worktree)
      const state = selection.runtime.runs.status()
      const stopped = latest?.sessionID === selection.sessionID && isPauseSettled(latest)
      // Refuse suspension rather than stopping a worker's process group with the UI.
      if (operationAbort || (!stopped && latest) || state.claim || state.executions.some(execution => !settled(execution))) {
        terminal.write("Suspension refused: pause/termination remains unconfirmed.\n")
        return
      }
      terminal.suspend?.()
      // SIGSTOP targets this UI process only, not its process group.
      process.kill(process.pid, "SIGSTOP")
    }
    if (!terminal.fullscreen) terminal.write(selectionBanner(worktree, selection.engine, selection.model, terminal.presentation?.()))

    async function runOwned(resumed: boolean) {
      if (persistenceFailed) throw new InteractiveLaunchError("Session transcript persistence failed; the session remains held.")
      if (effectiveHold(worktree, selection.sessionID)) throw new InteractiveLaunchError("Session held; explicit Resume required.")
      const result = resumed
        ? await selection.controller.resume(selection.sessionID, abort.signal)
        : await selection.controller.run(selection.sessionID, abort.signal)
      if (observedTasks) {
        const tasks = readProgressTasks(worktree, selection.sessionID, observedTasks.ids)
        if (tasks) { progress.taskSnapshot(tasks); terminal.taskSnapshot?.(tasks) }
      }
      terminal.executionSnapshot?.(selection.runtime.runs.status(), false)
      persist("workflow-stage", { workflowID: result.workflow.id, phase: result.workflow.phase, text: `Workflow ${result.workflow.id}: ${result.workflow.phase}` })
      const incompleteArtifacts = incompleteArtifactSummary(worktree, result.workflow)
      if (incompleteArtifacts) terminal.write(terminalSafeText(`[artifacts] ${incompleteArtifacts}\n`))
      progress.final({
        workflowID: result.workflow.id, phase: result.workflow.phase,
        done: result.run.done, failed: result.run.failed, cancelled: result.run.cancelled,
        ...(result.run.skipped ? { skipped: result.run.skipped } : {}),
      })
      return result
    }

    /**
     * Complete user/assistant pairs, oldest first, including context carried into this session by a model switch.
     * Bounded to the turns and characters a conversation window can use.
     */
    function restoredConversation(sessionID: string): ConversationMessage[] {
      const pairs: ConversationMessage[] = []
      let response: string | undefined
      let offset = 0
      for (;;) {
        const replay = replaySession(worktree, sessionID, { order: "desc", offset, limit: 256 })
        if (!replay.complete) throw new InteractiveLaunchError("Incomplete session replay; work remains held.")
        for (const record of replay.records) {
          if (record.kind === "assistant" && typeof record.data.text === "string") response = record.data.text
          else if (record.kind === "user" && typeof record.data.text === "string" && response !== undefined) {
            pairs.unshift({ role: "user", text: record.data.text }, { role: "assistant", text: response })
            response = undefined
            if (pairs.length >= MAX_CARRIED_MESSAGES) return boundedPairs(pairs)
          } else if (record.kind === "carried-context" && Array.isArray(record.data.messages)) {
            // The carried record is written first in a session, so everything before it is older context.
            response = undefined
            pairs.unshift(...record.data.messages as ConversationMessage[])
            return boundedPairs(pairs)
          }
        }
        if (replay.nextOffset === undefined) return boundedPairs(pairs)
        if (replay.nextOffset <= offset) throw new InteractiveLaunchError("Session replay did not advance; work remains held.")
        offset = replay.nextOffset
      }
    }

    async function decidePlan(workflow: Workflow, planSha: string, renderedPlan: string, parsedPlan: unknown): Promise<InteractiveExit | undefined> {
      const header = terminalSafeText(`\n[approval] Inspect the canonical plan below before deciding.\n\nCanonical plan (${workflow.planRef?.mdPath ?? "saved plan"}):\n`)
      const displayPlan = terminalSafeText(renderedPlan)
      const footer = terminalSafeText(`\nPlan SHA: ${planSha}\n`)
      persist("canonical-plan", { text: renderedPlan })
      if (terminal.writeText) {
        terminal.write(header)
        terminal.writeText({ provenance: "canonical-plan", text: displayPlan })
        terminal.write(footer)
      } else {
        visibleWrite(`${header}${displayPlan}${footer}`)
      }
      const chosen = terminal.choose ? await terminal.choose(
        "Execution decision",
        ["Approve", "Reject", "Keep pending"],
        abort.signal,
        {
          kind: "approval",
          document: renderedPlan,
          binding: {
            sessionID: selection.sessionID,
            workflowID: workflow.id,
            expectedRevision: workflow.lastSeq,
            planSha,
            path: workflow.planRef?.mdPath ?? "saved plan",
          },
        },
      ) : undefined
      if (terminal.choose && (chosen === undefined || chosen === 2)) {
        holdAdmission(worktree, selection.sessionID, "keep_pending")
        terminal.resume?.()
        terminal.write("Plan remains pending; no execution was started.\n")
        return undefined
      }
      progress.suspend()
      if (terminal.suspend) terminal.suspend()
      else terminal.close()
      if (abort.signal.aborted) return signalExit(receivedSignal)
      if (sigintRegistered) { deps.signals.off("SIGINT", onSigint); sigintRegistered = false }
      if (sigtermRegistered) { deps.signals.off("SIGTERM", onSigterm); sigtermRegistered = false }
      let decision: OperatorDecision
      try {
        if (terminal.fullscreen) process.stderr.write(`Canonical plan:\n${terminalSafeText(renderedPlan)}\nPlan SHA: ${planSha}\n`)
        decision = await deps.humanDecision(terminal.choose ? chosen === 0 ? "approve" : "reject" : "choose", {
          sessionID: selection.sessionID, workflowID: workflow.id, expectedRevision: workflow.lastSeq,
          subject: { kind: "plan", id: workflow.id, sha256: planSha },
        }, abort.signal)
      } finally {
        terminal.resume?.()
        progress.resume()
        if (!abort.signal.aborted) {
          deps.signals.on("SIGINT", onSigint); sigintRegistered = true
          deps.signals.on("SIGTERM", onSigterm); sigtermRegistered = true
        }
      }
      if (abort.signal.aborted) return signalExit(receivedSignal)
      persist("workflow-choice", { text: `Operator chose ${decision.action} for workflow ${workflow.id}.`, workflowID: workflow.id, planSha })
      const decided = selection.controller.decide(decision)
      if (!decided.ok) throw new InteractiveLaunchError("local plan decision could not be applied; inspect read-only status")
      persist("workflow-stage", { workflowID: decided.wf.id, phase: decided.wf.phase, text: `Workflow ${decided.wf.id}: ${decided.wf.phase}` })
      if (decision.action === "reject") {
        const rejected = terminalSafeText(`Workflow ${workflow.id} rejected; execution was not started.\n`)
        // Rejection exits the full-screen frontend immediately. Leave the alternate screen before writing the
        // terminal receipt so tmux/SSH transports cannot lose the final frame during process teardown.
        persist("notice", { text: rejected })
        if (terminal.fullscreen) {
          terminal.close()
          process.stderr.write(rejected)
        } else {
          visibleWrite(rejected)
        }
        return { code: 0 }
      }
      if (decision.action !== "approve") return { code: 1 }
      if (abort.signal.aborted) return signalExit(receivedSignal)
      const approvedTasks = approvedTaskIDs(decided.wf.taskIds)
      const taskIDs = approvedTasks.ids
      const taskTitles = approvedPlanTitles(parsedPlan)
      observedTasks = { worktree, sessionID: selection.sessionID, ids: taskIDs }
      const currentTasks = readProgressTasks(worktree, selection.sessionID, taskIDs) ?? taskIDs.map(id => ({ id, status: "pending" as const }))
      const titledTasks = currentTasks.map((task, index) => ({ ...task, title: taskTitles[index] ?? "" }))
      progress.tasks(titledTasks, approvedTasks.total)
      terminal.taskSnapshot?.(titledTasks)
      const result = await runOwned(false)
      if (receivedSignal) return signalExit(receivedSignal)
      if (terminal.fullscreen) return undefined
      return { code: result.workflow.phase === "done" && result.run.failed === 0 && result.run.cancelled === 0 ? 0 : 1 }
    }

    function acquireSwitchGuard(allowHeldWorkflow = false): { release?: () => void; refusal?: string } {
      const release = beginExecutionActivity(selection.runtime, selection.sessionID, "review")
      if (!release) return { refusal: "Model switch refused: another local execution is still active.\n" }
      try {
        const workflowState = readAnyWorkflowChecked(worktree)
        if (workflowState.corrupt) {
          release()
          return { refusal: "Model switch refused: workflow state is corrupt and must be inspected first.\n" }
        }
        if (activeAnyWorkflow(worktree) && !allowHeldWorkflow) {
          release()
          return { refusal: "Model switch refused: resolve the active workflow first.\n" }
        }
        const status = selection.runtime.runs.status()
        if (status.claim) {
          release()
          return { refusal: "Model switch refused: execution ownership is unresolved; use recovery first.\n" }
        }
        if (status.executions.some(execution => !settled(execution))) {
          release()
          return { refusal: "Model switch refused: execution ownership is unresolved; use recovery first.\n" }
        }
        return { release }
      } catch {
        release()
        return { refusal: "Model switch refused: workflow or execution ownership state could not be verified.\n" }
      }
    }

    async function switchSelection(
      nextEngine: CliEngine,
      nextModel: string,
      targetSessionID?: string,
      forceNew = false,
      discovery: InteractiveViewFacts["discovery"] = "not-observed",
    ): Promise<boolean> {
      if (!forceNew && !targetSessionID && nextEngine === selection.engine && nextModel === selection.model) {
        discoveryObservation = discovery
        publishView()
        terminal.write("Already using that engine and model; conversation context is unchanged.\n")
        return true
      }
      const guard = acquireSwitchGuard(targetSessionID !== undefined || retainedSDKSessionID !== undefined)
      if (!guard.release) {
        terminal.write(guard.refusal ?? "Model switch refused; current selection is unchanged.\n")
        return true
      }
      try {
        // An explicit /model switch carries the conversation; /new and opening another session do not.
        const carrySource = !forceNew && !targetSessionID && sessionStore && !retainedSDKSessionID
          ? { sessionID: selection.sessionID, engine: selection.engine, model: selection.model }
          : undefined
        let carried: ConversationMessage[] = []
        if (carrySource) {
          try { carried = restoredConversation(carrySource.sessionID) }
          catch {
            // Never drop context silently: keep the current model and conversation.
            terminal.write("Model switch refused: the current conversation could not be read in full; selection and conversation are unchanged. Use /new to start without it.\n")
            return true
          }
        }
        const sessionID = targetSessionID ?? defaultSessionID(deps.randomUUID())
        if (!targetSessionID && usedSessionIDs.has(sessionID)) throw new Error("new conversation identity was not unique")
        const retained = targetSessionID ? readSessionMetadata(worktree, sessionID) : undefined
        const nextProgress = scopedProgress()
        const runtime = deps.createRuntime({ worktree, engine: nextEngine, model: nextModel, progress: nextProgress.sink })
        if (!retained) {
          runtime.linuxAdmission?.assertBootEpoch()
          await deps.admitRuntime(runtime)
        }
        if (abort.signal.aborted) return false
        const controller = deps.createController(runtime)
        const conversation = deps.createConversation(runtime, sessionID, retained ? restoredConversation(sessionID) : carried.length ? carried : undefined)
        if (abort.signal.aborted) return false
        const drafts = terminal.draftSnapshot?.()
        if (drafts) persist("notice", drafts)
        guard.release()
        terminal.queueAdmission?.(false)
        if (sessionStore) {
          if (!attachedRuntime || !await detachAdmission(attachedRuntime, selection.sessionID, sessionStore.epoch, "session_switch")) {
            terminal.write("Session switch refused: attachment release is not proven.\n")
            return true
          }
          skillSession?.close()
          skillSession = undefined
          latestSkillCatalog = undefined
          sessionStore = undefined
          attachedRuntime = undefined
        }
        skillSession?.close()
        skillSession = undefined
        latestSkillCatalog = undefined
        terminal.skillCatalog?.({ entries: [], refusals: [] })
        terminal.sessionChanged?.()
        const nextStore = attachAdmission(runtime, sessionID, { engine: nextEngine, model: nextModel })
        sessionStore = nextStore
        if (carrySource && carried.length) {
          persist("carried-context", { sourceSessionID: carrySource.sessionID, engine: carrySource.engine, model: carrySource.model, messages: carried })
        }
        nextProgress.bind(nextStore)
        attachedRuntime = runtime
        retainedSDKSessionID = undefined
        retainedViewSelection = undefined
        requestObservation = { state: "not-observed" }
        discoveryObservation = discovery
        selection = { engine: nextEngine, model: nextModel, sessionID, runtime, controller, conversation }
        usedSessionIDs.add(sessionID)
        terminal.bindSession?.(sessionID)
        terminal.bindView?.(currentViewIdentity())
        terminal.transcriptSource?.(options => replaySession(worktree, sessionID, options))
        publishView()
        await bindSkillSession(nextStore)
        if (abort.signal.aborted) return false
        const note = nextStore.restored ? undefined : switchNote(carried.length / 2, carrySource)
        if (terminal.fullscreen) {
          terminal.write(terminalSafeText(nextStore.restored ? `Selected: ${selection.engine} / ${selection.model}.` : `Now using ${selection.engine} / ${selection.model}. ${note}`))
        } else {
          // The banner clips to the terminal width; the carry note states what is sent, so it is never clipped.
          terminal.write(selectionBanner(worktree, selection.engine, selection.model, terminal.presentation?.()))
          if (note) terminal.write(terminalSafeText(`${note}\n`))
        }
        if (nextStore.restored) {
          terminal.write("Restored session held. Drafts remain unsent; use /continue for an explicit Resume decision.\n")
          // Restore recomputes artifact state from disk: a tampered or missing artifact shows as incomplete, never as remembered-verified.
          const retainedWorkflow = readSessionCommitted(worktree, sessionID)
          if (retainedWorkflow) {
            terminal.write(terminalSafeText(`[workflow] ${retainedWorkflow.wf.id} ${retainedWorkflow.wf.phase} · ${retainedWorkflow.path} · sha256 ${retainedWorkflow.sha256}\n`))
            const incompleteArtifacts = incompleteArtifactSummary(worktree, retainedWorkflow.wf)
            terminal.write(terminalSafeText(`[artifacts] ${incompleteArtifacts ?? "all verified"}\n`))
          }
        }
      } catch (error) {
        if (!sessionStore && !retainedSDKSessionID) throw error
        if (!sessionStore) {
          terminal.write("Session switch failed; retained read-only history remains selected.\n")
          return true
        }
        if (!(error instanceof AdmissionRefusal) && !(error instanceof TypeError)) throw error
        if (abort.signal.aborted) return false
        terminal.write("Model switch failed; the current selection and conversation are unchanged.\n")
      } finally {
        guard.release()
      }
      return true
    }

    async function switchToRetainedSDKSession(sessionID: string): Promise<boolean> {
      let replay: ReplayResult
      try {
        const metadata = readSessionMetadata(worktree, sessionID)
        if (!metadata || metadata.engine !== "opencode") {
          terminal.write("Session restore refused: no retained SDK LCA history exists for that session.\n")
          return true
        }
        replay = replaySession(worktree, sessionID, { limit: 1 })
        if (!replay.complete) {
          terminal.write(`Session restore refused: ${boundedTerminalDiagnostic(replay.recoveryNotice ?? "retained history is incomplete")}.\n`)
          return true
        }
      } catch (error) {
        terminal.write(`Session restore refused: ${boundedTerminalDiagnostic(String(error))}\n`)
        return true
      }

      let guard: ReturnType<typeof acquireSwitchGuard> | undefined
      if (sessionStore) {
        guard = acquireSwitchGuard(true)
        if (!guard.release) {
          terminal.write(guard.refusal ?? "Session switch refused; current selection is unchanged.\n")
          return true
        }
      }
      try {
        const drafts = terminal.draftSnapshot?.()
        if (drafts && sessionStore) persist("notice", drafts)
        terminal.queueAdmission?.(false)
        if (sessionStore) {
          guard!.release!()
          if (!attachedRuntime || !await detachAdmission(attachedRuntime, selection.sessionID, sessionStore.epoch, "session_switch")) {
            terminal.write("Session switch refused: attachment release is not proven.\n")
            return true
          }
          skillSession?.close()
          skillSession = undefined
          latestSkillCatalog = undefined
          sessionStore = undefined
          attachedRuntime = undefined
        }
        skillSession?.close()
        skillSession = undefined
        latestSkillCatalog = undefined
        terminal.skillCatalog?.({ entries: [], refusals: [] })
        terminal.sessionChanged?.()
        retainedSDKSessionID = sessionID
        retainedViewSelection = { engine: "opencode", model: "retained unknown" }
        requestObservation = { state: "not-observed" }
        discoveryObservation = "not-observed"
        terminal.executionSnapshot?.({ generation: 0, executions: [] }, false)
        terminal.taskSnapshot?.([])
        terminal.bindSession?.(sessionID)
        terminal.bindView?.(currentViewIdentity())
        terminal.transcriptSource?.(options => replaySession(worktree, sessionID, options))
        publishView()
        terminal.write(`Retained SDK session ${sessionID} · read-only history\n`)
      } catch (error) {
        terminal.write(`Session restore refused: ${boundedTerminalDiagnostic(String(error))}\n`)
      } finally {
        guard?.release?.()
      }
      return true
    }

    async function openRetainedSession(
      sessionID: string,
      captured?: Pick<SessionCandidate, "engine" | "model">,
    ): Promise<boolean> {
      const currentSessionID = retainedSDKSessionID ?? selection.sessionID
      if (sessionID === currentSessionID) {
        terminal.write(`Session ${sessionID} is already selected; no work was started.\n`)
        return true
      }
      try {
        const saved = readSessionMetadata(worktree, sessionID)
        if (captured && (!saved || saved.engine !== captured.engine || saved.model !== captured.model)) {
          terminal.write("Session restore refused: the captured target changed or was deleted.\n")
          return true
        }
        if (saved?.engine === "opencode") return switchToRetainedSDKSession(sessionID)
        if (!saved || !["local", "codex", "claude"].includes(saved.engine) || !saved.model) {
          terminal.write("Session restore refused: no compatible saved CLI selection.\n")
          return true
        }
        return switchSelection(saved.engine as CliEngine, saved.model, sessionID)
      } catch (error) {
        if (!sessionStore) throw error
        terminal.write(`Session restore refused: ${boundedTerminalDiagnostic(String(error))}\n`)
        return true
      }
    }

    async function chooseRetainedSession(): Promise<boolean> {
      const inspected = inspectSessions(worktree)
      if (!inspected.length) {
        terminal.write("No retained sessions are available.\n")
        return true
      }
      const seen = new Set<string>()
      if (inspected.some(session => !session.sessionID || seen.has(session.sessionID) || !seen.add(session.sessionID))) {
        terminal.write("Session list refused: captured candidates have duplicate or invalid stable IDs.\n")
        return true
      }
      const currentSessionID = retainedSDKSessionID ?? selection.sessionID
      const candidates: readonly SessionCandidate[] = inspected.map(session => ({
        sessionID: session.sessionID,
        engine: session.engine,
        ...(session.model ? { model: session.model } : {}),
        current: session.sessionID === currentSessionID,
        state: session.corrupt ? "corrupt" : session.sessionID === retainedSDKSessionID ? "read-only" : session.held ? "held" : "retained",
        ...(session.corrupt ? { detail: boundedTerminalDiagnostic(session.corrupt) } : {}),
      }))
      const labels = candidates.map(candidate =>
        `${candidate.current ? "current · " : ""}${candidate.sessionID} · ${candidate.engine} ${candidate.model ?? "model unknown"} · ${candidate.state}`)
      const origin: ViewIdentity = sessionStore
        ? { mode: "writable", sessionID: selection.sessionID, epoch: sessionStore.epoch }
        : { mode: "retained-read-only", sessionID: currentSessionID }
      const chosen = terminal.choose
        ? await terminal.choose("Retained sessions", labels, abort.signal, { kind: "generic-list", rows: labels, origin })
        : undefined
      if (chosen === undefined) return true
      const candidate = candidates[chosen]
      if (!candidate) {
        terminal.write("Session restore refused: captured selection is no longer valid.\n")
        return true
      }
      const currentIdentity: ViewIdentity = sessionStore
        ? { mode: "writable", sessionID: selection.sessionID, epoch: sessionStore.epoch }
        : { mode: "retained-read-only", sessionID: retainedSDKSessionID ?? selection.sessionID }
      if (JSON.stringify(currentIdentity) !== JSON.stringify(origin)) {
        terminal.write("Session restore refused: the chooser origin changed.\n")
        return true
      }
      return openRetainedSession(candidate.sessionID, candidate)
    }

    function showRetainedSearch(sessionID: string, query: string): void {
      if (!query) {
        terminal.write("Usage: /search <retained text>\n")
        return
      }
      try {
        const replay = replaySession(worktree, sessionID, { order: "asc", limit: 10000, query })
        if (!replay.complete) throw new Error(replay.recoveryNotice ?? "retained history is incomplete")
        if (!replay.records.length) {
          terminal.write("No retained history matches that search.\n")
          return
        }
        for (const record of replay.records) {
          const detail = typeof record.data.text === "string" ? record.data.text : JSON.stringify(record.data)
          terminal.write(`${record.seq} · ${record.kind} · ${terminalSafeText(detail)}\n`)
        }
      } catch (error) {
        terminal.write(`Retained history search refused: ${boundedTerminalDiagnostic(String(error))}\n`)
      }
    }

    function showRetainedExpansion(sessionID: string, ordinalText: string): void {
      const ordinal = Number(ordinalText)
      if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
        terminal.write("Usage: /expand <tool item number>\n")
        return
      }
      try {
        const replay = replaySession(worktree, sessionID, { order: "asc", limit: 10000 })
        if (!replay.complete) throw new Error(replay.recoveryNotice ?? "retained history is incomplete")
        const calls = new Map<string, typeof replay.records>()
        for (const record of replay.records) {
          if (record.kind !== "tool-start" && record.kind !== "tool-result" && record.kind !== "tool-denied") continue
          const key = JSON.stringify([record.data.executionID, record.data.callID])
          const values = calls.get(key) ?? []
          values.push(record)
          calls.set(key, values)
        }
        const selected = [...calls.values()][ordinal - 1]
        if (!selected) {
          terminal.write(`No retained tool item ${ordinal}.\n`)
          return
        }
        for (const record of selected) terminal.write(`${record.kind} · ${terminalSafeText(JSON.stringify(record.data))}\n`)
      } catch (error) {
        terminal.write(`Retained history expansion refused: ${boundedTerminalDiagnostic(String(error))}\n`)
      }
    }

    while (!abort.signal.aborted) {
      if (persistenceFailed) throw new InteractiveLaunchError("Session transcript persistence failed; the session remains held.")
      let actionContext: InteractiveContext = "chat"
      if (retainedSDKSessionID) {
        terminal.queueAdmission?.(false)
        actionContext = "read-only"
      } else {
        workflowHost.syncStatus()
        const queueState = selection.runtime.runs.status()
        terminal.executionSnapshot?.(queueState, false)
        const queueAllowed = !effectiveHold(worktree, selection.sessionID) && !readAnyWorkflowChecked(worktree).corrupt &&
          !activeAnyWorkflow(worktree) && !queueState.claim && queueState.executions.every(settled)
        terminal.queueAdmission?.(queueAllowed && requestObservation.state !== "failed")
        actionContext = queueAllowed ? "chat" : "held"
      }
      terminal.actionContext?.(actionContext)
      publishView()
      const promptTitle = retainedSDKSessionID
        ? `Retained SDK session ${retainedSDKSessionID} · read-only history`
        : `${selection.engine} · ${selection.model}`
      const text = await withProgressSuspended(() => readInput(
        terminal, promptTitle,
        retainedSDKSessionID ? "Read-only history · /resume or /new to switch · /quit exit" : "Enter send · /help commands · /model switch · /quit exit",
        retainedSDKSessionID ? "History> " : "You> ", abort.signal,
      ))
      if (abort.signal.aborted) return signalExit(receivedSignal)
      if (text === undefined) return { code: 0 }
      const message = text.trim()
      if (!message) continue

      if (message.startsWith("!")) {
        const command = message.slice(1).trim()
        if (!command) visibleWrite("Usage: !<command> runs one shell command in the worktree.\n")
        else if (retainedSDKSessionID) visibleWrite("Shell is unavailable in read-only history; no command was run.\n")
        else if (Buffer.byteLength(command, "utf8") > MAX_SHELL_COMMAND_BYTES) visibleWrite(`Shell command exceeds ${MAX_SHELL_COMMAND_BYTES} bytes; no command was run.\n`)
        else await runShell(command, worktree)
        continue
      }

      if (retainedSDKSessionID) {
        const sessionID = retainedSDKSessionID
        const [command, ...commandArgs] = message.split(/\s+/u)
        if (command === "/quit") return { code: 0 }
        if (command === "/help" && commandArgs.length === 0 && hasInteractiveAction("read-only", "help")) {
          await presentHelp(terminal, "read-only", abort.signal)
          continue
        }
        if (command === "/sessions" && commandArgs.length === 0) {
          if (!await chooseRetainedSession()) return signalExit(receivedSignal)
          continue
        }
        if (command === "/status" && commandArgs.length === 0) {
          try { terminal.write(readForegroundStatus(selection.runtime, sessionID) + "\n") }
          catch (error) { terminal.write(`Read-only status unavailable: ${boundedTerminalDiagnostic(String(error))}\n`) }
          continue
        }
        if (command === "/skills" && commandArgs.length === 0) {
          visibleWrite("Skill catalog is unavailable in retained read-only SDK history; no LCA writer or SDK runtime was created.\n")
          continue
        }
        if (command === "/search") {
          showRetainedSearch(sessionID, commandArgs.join(" "))
          continue
        }
        if (command === "/expand") {
          showRetainedExpansion(sessionID, commandArgs[0] ?? "")
          continue
        }
        if (command === "/new" && commandArgs.length === 0) {
          if (!await switchSelection(selection.engine, selection.model, undefined, true)) return signalExit(receivedSignal)
          continue
        }
        if (command === "/resume" && commandArgs.length === 1) {
          if (!await openRetainedSession(commandArgs[0]!)) return signalExit(receivedSignal)
          continue
        }
        terminal.write(`Retained SDK session ${sessionID} is read-only; command or message was not applied.\n`)
        continue
      }

      if (message === "/quit") return { code: 0 }
      if (message === "/pause") {
        requestPause()
        continue
      }
      if (message === "/cancel") {
        requestCancel()
        // B6: a cancel request is not a stopped display or an exit; leave only once no workflow awaits proof.
        const pending = activeAnyWorkflow(worktree)
        if (pending?.sessionID === selection.sessionID) terminal.write(`${pending.stopIntent?.kind === "cancel" ? STOP_LABEL.cancelling : "cancel refused"}; the process stays until termination is proven.\n`)
        else if (!terminal.fullscreen) return { code: 0 }
        continue
      }

      const [command, ...commandArgs] = message.split(/\s+/u)
      if (["/search", "/expand", "/details", "/theme", "/ascii"].includes(command!)) {
        terminal.write(`${command} is a local full-screen TUI action; it is unavailable in readline and no model turn was dispatched.\n`)
        continue
      }
      if (command === "/help" && commandArgs.length === 0 && hasInteractiveAction(actionContext, "help")) {
        await presentHelp(terminal, actionContext, abort.signal)
        continue
      }
      if (command === "/sessions" && commandArgs.length === 0) {
        if (!await chooseRetainedSession()) return signalExit(receivedSignal)
        continue
      }
      if (command === "/skills") {
        if (commandArgs[0] === "grants" && commandArgs.length === 1) {
          if (!skillSession) visibleWrite("Skill grants unavailable in this session.\n")
          else {
            const grants = skillSession.listGrants()
            const grantSessionID = skillSession.store.sessionID
            visibleWrite(grants.length ? grants.map(grant =>
              `${terminalSafeText(grantSessionID)} · ${terminalSafeText(grant.name)} · ${grant.source} · ${grant.classification}${grant.trusted ? " · trusted by config" : ""} · ${grant.contentHash} · ${grant.allowedTools?.join(", ") ?? "current role tools"}`,
            ).join("\n") + "\n" : "No session skill grants.\n")
          }
          continue
        }
        if (commandArgs[0] === "revoke" && commandArgs.length === 2 && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(commandArgs[1]!)) {
          if (!skillSession) visibleWrite("Skill grants unavailable in this session.\n")
          else {
            const count = skillSession.revoke(commandArgs[1]!)
            visibleWrite(`Revoked ${count} session skill grant(s) for ${commandArgs[1]}; pending authorization cancelled.\n`)
          }
          continue
        }
        if (commandArgs.length) {
          visibleWrite("Usage: /skills | /skills grants | /skills revoke <name>\n")
          continue
        }
        await refreshSkillCatalog()
        if (latestSkillCatalog) visibleWrite(skillCatalogLines(latestSkillCatalog).join("\n") + "\n")
        else visibleWrite("Skill catalog unavailable; source invocation is disabled for this session.\n")
        continue
      }
      if (command === "/new" && commandArgs.length === 0) {
        const sessionID = defaultSessionID(deps.randomUUID())
        if (usedSessionIDs.has(sessionID)) throw new InteractiveLaunchError("new session identity was not unique")
        if (!await switchSelection(selection.engine, selection.model, sessionID, true)) return signalExit(receivedSignal)
        continue
      }
      if (command === "/resume" && commandArgs.length === 1) {
        if (!await openRetainedSession(commandArgs[0]!)) return signalExit(receivedSignal)
        continue
      }
      if (command === "/status" && commandArgs.length === 0) {
        terminal.write(selection.controller.status(selection.sessionID) + "\n")
        continue
      }
      if (command === "/continue" && commandArgs.length === 0) {
        const planning = activeAnyWorkflow(worktree)
        if (planning && planning.kind !== "plan") {
          const outcome = await workflowHost.continueActive(planning)
          terminal.resume?.()
          if (outcome.quit) return { code: 0 }
          continue
        }
        const current = activeWorkflow(worktree)
        if (current && current.sessionID !== selection.sessionID) {
          terminal.write(`Resume refused: workflow belongs to ${current.sessionID}; use /resume ${current.sessionID}.\n`)
          continue
        }
        if (current && current.stopIntent?.kind === "cancel") {
          terminal.write("Resume refused: workflow cancellation is pending; termination is unconfirmed.\n")
          continue
        }
        if (current && (current.phase === "paused" || current.stopIntent)) {
          // Pause: the residual is shown, Keep starts nothing, Resume rechecks every precondition before one commit.
          terminal.write(selection.controller.status(selection.sessionID) + "\n")
          try {
            const outcome = await selection.controller.resumePaused(selection.sessionID, async (view) => {
              terminal.write(terminalSafeText(`Paused from ${view.pausedFrom.phase}/${view.pausedFrom.stage}: residual ${view.residual.join(", ") || "none"}; done ${view.done.join(", ") || "none"}${view.worktreeChanged ? "; worktree changed since the pause" : ""}; attempt ${view.attempt}.\n`))
              const picked = terminal.choose
                ? await terminal.choose("Resume the residual approved work?", ["Keep held", "Resume"], abort.signal)
                : (await withProgressSuspended(() => readInput(terminal, "Resume session", "Type RESUME to resume the residual; anything else keeps the hold.", "Resume> ", abort.signal))) === "RESUME" ? 1 : 0
              terminal.resume?.()
              return picked === 1 && !abort.signal.aborted
            }, abort.signal)
            if (outcome.kept) terminal.write("Kept held; no work was started.\n")
            else {
              await refreshSkillCatalog()
              terminal.write(`Resumed workflow ${outcome.workflow.id}: ${outcome.workflow.phase}.\n`)
              if (outcome.workflow.phase === "pending_approval") {
                // The resume changed the revision, so any earlier receipt is dead: a fresh human decision is required.
                const fresh = activeWorkflow(worktree)
                const plan = fresh && savedPlan(selection.runtime, fresh)
                if (!fresh || fresh.sessionID !== selection.sessionID || !fresh.planRef || !plan) throw new InteractiveLaunchError("Canonical restored plan is unavailable; approval refused.")
                const rendered = readFileSync(resolve(worktree, fresh.planRef.mdPath), "utf8")
                const exit = await decidePlan(fresh, fresh.planRef.jsonSha, rendered, plan)
                if (exit) return exit
              }
              else if (outcome.workflow.phase === "executing") {
                const finished = outcome.run ? `done ${outcome.run.done}, failed ${outcome.run.failed}` : "residual run complete"
                terminal.write(`Residual tasks ran: ${finished}.\n`)
              }
            }
          }
          catch (error) { terminal.write(`Resume refused or incomplete: ${boundedTerminalDiagnostic(String(error))}\n`) }
          continue
        }
        terminal.write(selection.controller.status(selection.sessionID) + "\n")
        const choice = terminal.choose
          ? await terminal.choose("Resume residual approved work after recovery checks?", ["Keep held", "Resume"], abort.signal)
          : (await withProgressSuspended(() => readInput(terminal, "Resume session", "Type RESUME to admit held work; anything else keeps the hold.", "Resume> ", abort.signal))) === "RESUME" ? 1 : 0
        terminal.resume?.()
        if (choice !== 1 || abort.signal.aborted) continue
        try {
          const epoch = sessionStore?.epoch
          selection.runtime.linuxAdmission?.assertBootEpoch()
          await deps.admitRuntime(selection.runtime)
          if (abort.signal.aborted) continue
          if (!epoch || sessionStore?.epoch !== epoch) throw new InteractiveLaunchError("Session attachment changed during Resume preflight.")
          sessionStore = resumeAdmission(selection.runtime, selection.sessionID, current?.lastSeq)
          terminal.bindView?.(currentViewIdentity())
          await refreshSkillCatalog()
          if (current?.phase === "executing") await runOwned(true)
          else if (current?.phase === "pending_approval") {
            const fresh = activeWorkflow(worktree)
            const plan = fresh && savedPlan(selection.runtime, fresh)
            if (!fresh || fresh.sessionID !== selection.sessionID || !fresh.planRef || !plan) throw new InteractiveLaunchError("Canonical restored plan is unavailable; approval refused.")
            const rendered = readFileSync(resolve(worktree, fresh.planRef.mdPath), "utf8")
            const exit = await decidePlan(fresh, fresh.planRef.jsonSha, rendered, plan)
            if (exit) return exit
          }
          else terminal.write("Session admitted by explicit Resume; no work was automatically dispatched.\n")
        }
        catch (error) { terminal.write(`Resume refused or incomplete: ${boundedTerminalDiagnostic(String(error))}\n`) }
        continue
      }
      if (command === "/model" && !hasInteractiveAction(actionContext, "model")) {
        terminal.write("Model selection is unavailable while this session is held; resolve the active workflow first or recover execution ownership. No discovery or switch was attempted.\n")
        continue
      }
      if (command === "/model" && commandArgs[0] === "default" && hasInteractiveAction(actionContext, "model")) {
        defaultModelCommand(commandArgs.slice(1), { engine: selection.engine, model: selection.model })
        continue
      }
      if (command === "/model" && hasInteractiveAction(actionContext, "model")) {
        if (commandArgs.length === 0) {
          const guard = acquireSwitchGuard()
          if (!guard.release) {
            terminal.write(guard.refusal ?? "Model switch refused; current selection is unchanged.\n")
            continue
          }
          guard.release()
          let nextEngine = await withProgressSuspended(() => chooseEngine(terminal, abort.signal))
          if (abort.signal.aborted) return signalExit(receivedSignal)
          if (!nextEngine) continue
          let switched = false
          while (!abort.signal.aborted) {
            const picked = await withProgressSuspended(() => chooseModel(terminal, nextEngine!, worktree, abort.signal, deps.discoverModels))
            if (abort.signal.aborted) return signalExit(receivedSignal)
            if (picked.backToEngine) {
              nextEngine = await withProgressSuspended(() => chooseEngine(terminal, abort.signal))
              if (abort.signal.aborted) return signalExit(receivedSignal)
              if (!nextEngine) break
              continue
            }
            if (picked.value === null) break
            if (picked.value === undefined) return signalExit(receivedSignal)
            switched = await switchSelection(nextEngine, picked.value, undefined, false, picked.discovery)
            if (!switched) return signalExit(receivedSignal)
            break
          }
          if (!switched && abort.signal.aborted) return signalExit(receivedSignal)
          continue
        }
        if (commandArgs.length !== 2 || !["local", "codex", "claude"].includes(commandArgs[0]!) ||
            !validModelID(commandArgs[1]!)) {
          terminal.write("Usage: /model <local|codex|claude> <native-id>\n")
          continue
        }
        if (!await switchSelection(commandArgs[0] as CliEngine, commandArgs[1]!)) return signalExit(receivedSignal)
        continue
      }
      const explicitSkill = /^\/skill:([a-z0-9][a-z0-9_-]{0,63})(?:\s+([\s\S]*))?$/u.exec(message)
      if (message.startsWith("/skill:") && !explicitSkill) {
        visibleWrite("Usage: /skill:<name> [request]\n")
        continue
      }
      if (command === "/finish" && commandArgs.length === 0) {
        const outcome = await workflowHost.finish()
        terminal.resume?.()
        if (outcome.quit) return { code: 0 }
        continue
      }
      // The kind comes only from the matched builtin descriptor: a project/home file of the same name, the request text
      // and model output cannot choose or redirect it. Naming a workflow is a start request, never consent to execute.
      const protectedWorkflow = explicitSkill ? PROTECTED_WORKFLOWS.find(workflow => workflow.name === explicitSkill[1]) : undefined
      if (explicitSkill && protectedWorkflow) {
        const refusal = startRefusal(protectedWorkflow.workflow)
        if (refusal) {
          visibleWrite(`Protected workflow ${protectedWorkflow.name} is not available here: ${refusal}.\n`)
          continue
        }
        const request = (explicitSkill[2] ?? "").trim()
        if (!request) {
          visibleWrite(`Usage: /skill:${protectedWorkflow.name} <request>\n`)
          continue
        }
        if (retainedSDKSessionID) { visibleWrite("Retained read-only history cannot start a workflow.\n"); continue }
        if (effectiveHold(worktree, selection.sessionID)) {
          terminal.write("Session held: use /continue to review and explicitly resume; the workflow was not started.\n")
          continue
        }
        const state = selection.runtime.runs.status()
        if (state.claim || state.executions.some(execution => !settled(execution))) {
          terminal.write("Workflow not started: execution ownership is unresolved; explicit recovery is required.\n")
          continue
        }
        if (readAnyWorkflowChecked(worktree).corrupt) {
          terminal.write("Workflow not started: workflow state is corrupt; inspect read-only status before new work.\n")
          continue
        }
        const outcome = await workflowHost.start(protectedWorkflow, request)
        terminal.resume?.()
        if (outcome.quit) return { code: 0 }
        continue
      }
      if (message.startsWith("/") && command !== "/plan" && !explicitSkill) {
        terminal.write("Unknown local command. Enter /help for usage.\n")
        continue
      }

      if (effectiveHold(worktree, selection.sessionID)) {
        terminal.write("Session held: use /continue to review and explicitly resume; draft was not sent.\n")
        continue
      }
      const executionState = selection.runtime.runs.status()
      if (executionState.claim || executionState.executions.some(execution => !settled(execution))) {
        terminal.write("Conversation held: execution ownership is unresolved; explicit recovery is required.\n")
        continue
      }
      const workflowRecord = readAnyWorkflowChecked(worktree)
      if (workflowRecord.corrupt) {
        terminal.write("Conversation held: workflow state is corrupt; inspect read-only status before new work.\n")
        continue
      }
      const occupant = activeAnyWorkflow(worktree)
      if (occupant && occupant.kind !== "plan") {
        if (occupant.sessionID !== selection.sessionID) {
          terminal.write(`Read-only observer: ${occupant.kind} workflow belongs to ${occupant.sessionID}; open with /resume ${occupant.sessionID}. No new workflow can start here.\n`)
          continue
        }
        // A plain chat line is the answer to an interview that awaits one; any other planning workflow holds the slot.
        const answered = message.startsWith("/") ? undefined : await workflowHost.answer(message)
        if (answered) {
          terminal.resume?.()
          if (answered.quit) return { code: 0 }
          continue
        }
        terminal.write(`Conversation held: ${occupant.kind} workflow ${occupant.id} is ${occupant.phase} at ${occupant.stage}. Use /status, /continue, /pause or /cancel.\n`)
        continue
      }
      const existingWorkflow = activeWorkflow(worktree)
      if (existingWorkflow && existingWorkflow.sessionID === selection.sessionID && existingWorkflow.phase !== "planning") {
        terminal.write(`Conversation held: workflow ${existingWorkflow.id} is ${existingWorkflow.phase}; owner session ${existingWorkflow.sessionID}. Use /status or the owner-session recovery command.\n`)
        continue
      }
      if (existingWorkflow && existingWorkflow.sessionID !== selection.sessionID) {
        terminal.write(`Read-only observer: workflow belongs to ${existingWorkflow.sessionID}; open with /resume ${existingWorkflow.sessionID}. No new workflow can start here.\n`)
        continue
      }
      const turnSelection = selection
      const turnStore: SessionStore | undefined = sessionStore
      const turnEpoch = turnStore?.epoch
      const turnWorkflowSnapshot = JSON.stringify(readAnyWorkflowChecked(worktree))
      const turnSkills = skillSession
      const userFact = persist("user", { text: message })
      progress.waiting()
      operationAbort = new AbortController()
      const requestID = `${turnStore?.epoch ?? "read-only"}:request:${++requestSequence}`
      const cancelTurn = () => operationAbort?.abort()
      abort.signal.addEventListener("abort", cancelTurn, { once: true })
      let turn: Awaited<ReturnType<PlanConversation["turn"]>>
      let skillInvocation: SkillConversationInvocation | undefined
      let preparedSkill: PreparedSkillInvocation | undefined
      let dispatched = false
      const modelFailureMayReturnToComposer = (): boolean => {
        try {
          if (persistenceFailed || abort.signal.aborted || operationAbort?.signal.aborted || receivedSignal || retainedSDKSessionID || !turnStore || !turnEpoch ||
              sessionStore !== turnStore || attachedRuntime !== turnSelection.runtime || selection !== turnSelection ||
              turnStore.sessionID !== turnSelection.sessionID ||
              turnStore.epoch !== turnEpoch || turnStore.isReleased) return false
          turnStore.assertOwner()
          if (turnStore.metadata.held || effectiveHold(worktree, turnStore.sessionID)) return false
          const state = turnSelection.runtime.runs.status()
          if (state.claim || state.executions.some(execution => !settled(execution) || !!execution.fence)) return false
          const workflowState = readAnyWorkflowChecked(worktree)
          if (workflowState.corrupt || workflowState.legacy || JSON.stringify(workflowState) !== turnWorkflowSnapshot) return false
          const occupant = activeAnyWorkflow(worktree)
          if (occupant && (occupant.sessionID !== turnStore.sessionID || occupant.kind !== "plan" || occupant.phase !== "planning")) return false
          return true
        } catch {
          return false
        }
      }
      try {
        if (explicitSkill) {
          if (!turnSkills || !turnStore || turnSkills.store !== turnStore) {
            visibleWrite("Skill invocation unavailable; no model turn was dispatched.\n")
            progress.responseReceived()
            continue
          }
          try {
            preparedSkill = await turnSkills.prepare(explicitSkill[1]!, operationAbort.signal)
            if (operationAbort.signal.aborted || abort.signal.aborted) {
              if (!abort.signal.aborted) reportSkillCancellation()
              progress.responseReceived()
              continue
            }
            if (selection !== turnSelection || sessionStore !== turnStore || skillSession !== turnSkills || retainedSDKSessionID) {
              visibleWrite("Skill invocation refused after a session ownership change; no model turn was dispatched.\n")
              progress.responseReceived()
              continue
            }
            skillInvocation = { prepared: preparedSkill, terminal: skillTerminal }
          } catch {
            if (operationAbort.signal.aborted && !abort.signal.aborted) {
              reportSkillCancellation()
              progress.responseReceived()
              continue
            }
            if (abort.signal.aborted) return signalExit(receivedSignal)
            visibleWrite("Skill invocation refused; source instructions were not dispatched.\n")
            progress.responseReceived()
            continue
          }
        }
        if (operationAbort.signal.aborted || abort.signal.aborted) {
          if (!abort.signal.aborted) reportSkillCancellation()
          progress.responseReceived()
          continue
        }
        dispatched = true
        requestObservation = { state: "in-progress", operationID: requestID }
        publishView()
        turn = skillInvocation
          ? await turnSelection.conversation.turn(message, operationAbort.signal, skillInvocation)
          : await turnSelection.conversation.turn(message, operationAbort.signal)
        if (operationAbort.signal.aborted && !abort.signal.aborted) {
          requestObservation = { state: "cancellation-unconfirmed", operationID: requestID }
          publishView()
          reportTurnCancellation()
          continue
        }
        requestObservation = { state: "completed", operationID: requestID }
        publishView()
      } catch (error) {
        if (dispatched && error instanceof ModelRequestError) {
          requestObservation = {
            state: "failed", operationID: requestID,
            category: { state: "known", value: error.category }, retryable: { state: "unknown" },
          }
          publishView()
          if (modelFailureMayReturnToComposer()) {
            progress.responseReceived()
            persist("notice", { text: error.diagnostic, provenance: "error" })
            if (terminal.writeText) terminal.writeText({ provenance: "error", text: error.diagnostic })
            else visibleWrite(`[error] ${error.diagnostic}\n`)
            if (terminal.draftSnapshot?.().draft === "") terminal.setDraft?.(message)
            continue
          }
        } else if (dispatched) {
          requestObservation = { state: "failed", operationID: requestID, category: { state: "unknown" }, retryable: { state: "unknown" } }
          publishView()
        }
        if (operationAbort.signal.aborted && !abort.signal.aborted) {
          if (dispatched) reportTurnCancellation()
          else reportSkillCancellation()
          progress.responseReceived()
          continue
        }
        if (explicitSkill && !dispatched) {
          if (abort.signal.aborted) return signalExit(receivedSignal)
          visibleWrite("Skill invocation refused; source instructions were not dispatched.\n")
          progress.responseReceived()
          continue
        }
        throw error
      } finally {
        operationAbort = undefined
        abort.signal.removeEventListener("abort", cancelTurn)
      }
      progress.responseReceived()
      if (abort.signal.aborted) return signalExit(receivedSignal)
      let assistantFact: ReturnType<SessionStore["append"]> | undefined
      if (turn.text) {
        assistantFact = persist("assistant", { text: turn.text })
        const assistantText = terminalSafeText(turn.text)
        if (terminal.writeText) terminal.writeText({ provenance: "assistant", text: assistantText })
        else visibleWrite(`\nConversation:\n${assistantText}\n`)
      }
      if (skillInvocation && preparedSkill && turnStore) {
        const audit = safeSkillAudit(turn.skill, {
          sessionID: turnSelection.sessionID, epoch: turnStore.epoch,
          name: preparedSkill.name, contentHash: preparedSkill.contentHash,
        })
        if (audit) {
          persist("notice", { text: `Skill invocation audit ${JSON.stringify({ userSeq: userFact?.seq ?? null, assistantSeq: assistantFact?.seq ?? null, ...audit })}` })
        }
      }
      if (turn.plan === undefined) continue
      const ownerWorkflow = activeWorkflow(worktree)
      if (ownerWorkflow && ownerWorkflow.sessionID !== selection.sessionID) {
        terminal.write(`Plan proposal not admitted: workflow owned by ${ownerWorkflow.sessionID}. Use /resume ${ownerWorkflow.sessionID}.\n`)
        continue
      }

      const parsedPlan = planForImport(turn.plan, worktree)
      try {
        selection.controller.validateImportedPlan(parsedPlan, selection.sessionID)
      } catch (error) {
        const feedback = planValidationFeedback(error)
        if (feedback === undefined) throw error
        terminal.write(terminalSafeText(`[error] ${feedback}`))
        continue
      }
      if (abort.signal.aborted) return signalExit(receivedSignal)
      const submitted = await selection.controller.importPlan(selection.sessionID, "", abort.signal, parsedPlan)
      if (abort.signal.aborted) return signalExit(receivedSignal)
      if (!submitted.result.ok) {
        const diagnostic = boundedTerminalDiagnostic(submitted.result.text)
        terminal.write(`[error] Plan submission failed${diagnostic ? `: ${diagnostic}` : ""}; no execution was started.\n`)
        return { code: 1 }
      }
      if (submitted.result.wf.phase !== "pending_approval") {
        terminal.write("[error] Plan did not reach pending approval; no execution was started.\n")
        return { code: 1 }
      }
      if (!submitted.renderedPlan) {
        terminal.write("[error] Canonical plan rendering is unavailable; no execution was started.\n")
        return { code: 1 }
      }

      const workflow = submitted.result.wf
      persist("workflow-stage", { workflowID: workflow.id, phase: workflow.phase, text: `Workflow ${workflow.id}: ${workflow.phase}` })
      const exit = await decidePlan(workflow, submitted.planSha, submitted.renderedPlan, parsedPlan)
      if (exit) return exit
    }
    return signalExit(receivedSignal)
  } catch (error) {
    if (persistenceFailed) throw new InteractiveLaunchError("Session transcript persistence failed; the session remains held.")
    if (observedTasks) {
      const finalTasks = readProgressTasks(observedTasks.worktree, observedTasks.sessionID, observedTasks.ids)
      if (finalTasks) progress.taskSnapshot(finalTasks)
    }
    if (abort.signal.aborted && !(error instanceof AdmissionRefusal) && !(error instanceof LinuxAdmissionRefused)) {
      return signalExit(receivedSignal)
    }
    progress.error()
    throw error
  } finally {
    skillSession?.close()
    skillSession = undefined
    terminal.skillCatalog?.({ entries: [], refusals: [] })
    if (sessionStore && attachedRuntime) {
      try {
        const drafts = terminal.draftSnapshot?.()
        if (drafts && !persistenceFailed) persist("notice", drafts)
        await detachAdmission(attachedRuntime, sessionStore.sessionID, sessionStore.epoch, receivedSignal ?? "terminal_exit")
      } catch (error) {
        visibleWrite(persistenceFailed
          ? "Session cleanup remains held after transcript persistence failed.\n"
          : `Session cleanup remains held: ${boundedTerminalDiagnostic(String(error))}\n`)
      }
    }
    sessionStore = undefined
    terminal.close()
    terminal.write = visibleWrite
    terminal.executionSnapshot = showExecution
    terminal.taskSnapshot = showTasks
    if (sigintRegistered) deps.signals.off("SIGINT", onSigint)
    if (sigtermRegistered) deps.signals.off("SIGTERM", onSigterm)
    deps.signals.off("SIGHUP", onSighup)
    if (terminal.fullscreen) {
      deps.signals.off("SIGTSTP", onSigtstp)
      deps.signals.off("SIGCONT", onSigcont)
    }
  }
}
