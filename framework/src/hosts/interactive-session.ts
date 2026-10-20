import { randomUUID } from "node:crypto"
import { STOP_LABEL } from "../flow/status.ts"
import { taskPartition } from "../workflows/checkpoint.ts"
import { handoffDir, readLedger } from "../state/ledger.ts"
import { isPauseSettled, stopDisplay } from "../workflows/types.ts"
import { spawnSync } from "node:child_process"
import { accessSync, constants, copyFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { createInterface } from "node:readline"
import { activeAnyWorkflow, activeWorkflow, readAnyWorkflowChecked, readWorkflowChecked, type Workflow } from "../flow/state.ts"
import { savedPlan } from "../flow/actions.ts"
import { ledgerPath } from "../state/ledger.ts"
import { createCliRuntime, type CliRuntimeOptions } from "./cli-runtime.ts"
import { inputColorSupported, inputLine, renderInput, type InputPresentation } from "./cli-input.ts"
import { AUTH_ENGINES, authStatus, describeAuth, loginArgv, logoutArgv, runVendorAuth, type AuthEngine, type AuthRun, type AuthState, type LoginMethod } from "./engine-auth.ts"
import { createCliProgressPresenter, type CliHostActivity, type CliProgressTask, type CliTaskStatus, type CliToolDisplay } from "./cli-progress.ts"
import { formatDuration, type WorkflowProgress } from "../tui/progress.ts"
import { createPlanConversation, MAX_PLAN_CONVERSATION_CHARS, skillInstructionBudget, type ConversationMessage, type ConversationTurn, type SkillConversationInvocation } from "./plan-conversation.ts"
import type { WorkflowEnvelope } from "../workflows/types.ts"
import { PROTECTED_WORKFLOWS, resolveSkillRoots } from "../skills/roots.ts"
import { chatIntentMode, chatWorktreeMode } from "../config.ts"
import { classifyIntent, hasIntentForcePrefix, INTENT_CLASSIFIER, type IntentClass } from "../modes/detect.ts"
import { claimPreparedSkillInvocation, SkillSession, type AutoSkillCandidate, type PreparedSkillInvocation, type SkillCatalog } from "../skills/session.ts"
import { readSkillTrust, type SkillTrustLookup } from "../skills/trust.ts"
import { createAutoSkillSelector, type AutoSkillSelection } from "../routing/router.ts"
import { recordSkillToolLoad, recordSkillToolTurn } from "../telemetry/routing.ts"
import { attachAdmission, detachAdmission, effectiveHold, holdAdmission, rebindAdmissionModel, resumeAdmission } from "../sessions/admission.ts"
import { canonicalRoutes, inspectSessions, MAX_CARRIED_MESSAGES, routesKey, MAX_SHELL_COMMAND_BYTES, MAX_SHELL_LINES, MAX_SHELL_OUTPUT_BYTES, readSessionMetadata, replaySession, type SessionStore, type ReplayOptions, type ReplayResult, type TranscriptKind } from "../sessions/store.ts"
import { persistToolActivity } from "../tui/session-transcript.ts"
import { createForegroundController, PlanIsolationUnavailableError, readForegroundStatus, type ForegroundController } from "./controller.ts"
import { discoverModels as discoverModelCatalog, type ModelCatalog } from "./model-catalog.ts"
import { incompleteArtifactSummary } from "../workflows/artifacts.ts"
import { readSessionCommitted } from "../workflows/commit.ts"
import { humanDecision } from "./operator.ts"
import type { OperatorDecision } from "./operator.ts"
import { AdmissionRefusal, assertHostAdmission } from "./required-controls.ts"
import { CODEX_SUPPORTED_VERSIONS } from "./codex-profile.ts"
import { boundedTerminalDiagnostic, terminalSafeText } from "./terminal-text.ts"
import { createWorkflowHost, requestWorkflowStop, type WorkflowHost } from "./workflow-session.ts"
import { startRefusal } from "../workflows/registry.ts"
import { ModelRequestError } from "../workflows/turn.ts"
import { beginExecutionActivity } from "./runtime.ts"
import { settled, type ExecutionRunStatus } from "./run-state.ts"
import { EXECUTION_ROLES, LinuxAdmissionRefused, type ComboRoutes, type ExecutionRole, type ExecutionRuntime, type SkillToolProvider, type VerifyRunObservation } from "./types.ts"
import type { AskPrompt, ChoicePresentation, InteractiveViewFacts, RequestObservation, SessionCandidate, TranscriptText, ViewIdentity } from "./interactive-view.ts"
import { commandInsertion, interactiveActions, interactiveHelp, type InteractiveContext } from "./interactive-actions.ts"
import { fileComboStore, fileDefaultModelStore, validateComboRoutes, validModelID, type ComboLookup, type ComboStore, type DefaultModelLookup, type DefaultModelStore } from "./default-model.ts"
import { runOperatorShell, type ShellResult, type ShellSnapshot } from "./operator-shell.ts"
import { fileMemoryStore, memoryCommand, type MemoryCommandStore } from "./memory-command.ts"

export type CliEngine = CliRuntimeOptions["engine"]
export type InteractiveArgs = { worktree: string; engine?: CliEngine; model?: string; resume?: string | true; continue?: boolean; newSession?: boolean }
export type InteractiveExit = { code: number }
/** `interrupt` is Escape: it stops running work only; `cancel` is the explicit /cancel that may also stop a workflow. */
export type TerminalControl = "cancel" | "interrupt" | "pause" | "shutdown" | "quit" | "disconnect" | "suspend"

export type Terminal = {
  stdinIsTTY: boolean
  stderrIsTTY: boolean
  fullscreen?: boolean
  presentation?: () => InputPresentation
  actionContext?: (context: InteractiveContext) => void
  setDraft?: (draft: string) => void
  readInput?: (input: { title: string; hint: string; prompt: string; kind: "chat" | "selection" }, signal: AbortSignal) => Promise<string | undefined>
  choose?: (title: string, choices: readonly string[], signal: AbortSignal, presentation?: ChoicePresentation) => Promise<number | undefined>
  /** GJC-style question with options (HITL). Returns the chosen option index, the typed custom answer, or undefined (dismissed/aborted). */
  ask?: (prompt: AskPrompt, signal: AbortSignal) => Promise<{ kind: "option"; index: number } | { kind: "custom"; text: string } | undefined>
  controls?: (handler: (action: TerminalControl) => void) => void
  queueAdmission?: (allowed: boolean) => void
  activity?: (activity: CliHostActivity) => void
  /** Full-screen only: tool target/result/duration for the live transcript row (display, never persisted). */
  toolDisplay?: (display: CliToolDisplay) => void
  bindSession?: (sessionID: string) => void
  executionSnapshot?: (state: ExecutionRunStatus, active: boolean) => void
  taskSnapshot?: (tasks: readonly CliProgressTask[]) => void
  queueActivity?: (message: string, fields?: Record<string, unknown>) => void
  sessionChanged?: () => void
  skillCatalog?: (catalog: SkillCatalog) => void
  /** Committed `kind · stage · phase` of the live planning workflow in this session, or undefined when none is live. */
  /** Full-screen only: draw a finished queue verify command as a Bash card. */
  verifyRun?: (run: { id: string; command: string; taskID: string; attempt: number; timeoutMs: number; result: { status: "complete" | "error" | "cancelled" | "timeout"; exitCode: number | null; signal: null; durationMs: number; lines: readonly string[]; totalLines: number } }) => void
  /** Status line for the owned planning workflow; `progress` carries the same workflow's structured stage facts. */
  workflowStatus?: (line: string | undefined, progress?: WorkflowProgress) => void
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
  turn: (text: string, signal?: AbortSignal, skill?: SkillConversationInvocation, skillTool?: SkillToolProvider) => Promise<ConversationTurn>
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
  /** Persisted `chat.combo`; read when a session starts, never applied to a running or resumed session. */
  combo: ComboStore
  /** Persisted `memory.engine`/`memory.model` for `/memory`; recall reads it per call. Defaults to the user config. */
  memory?: MemoryCommandStore
  /** Vendor sign-in for codex/claude: read-only status, and the vendor's own interactive login/logout. */
  auth: EngineAuth
  /** User-config skill trust and `skill_auto` policy, read once per skill session. */
  skillPolicy: () => SkillTrustLookup
  /** Per-turn automatic skill choice over consent-free candidates; never loads, prompts or authorizes anything. */
  selectSkill: (runtime: ExecutionRuntime, input: AutoSkillSelectInput) => Promise<AutoSkillSelection>
  humanDecision: typeof humanDecision
  randomUUID: () => string
  signals: SignalSource
}

export type AutoSkillSelectInput = Readonly<{
  sessionID: string
  messageID: string
  text: string
  /** Intent-offer ranking only; ordinary skills are loaded by the model through the `skill` tool. */
  mode: "offer"
  candidates: readonly AutoSkillCandidate[]
  signal: AbortSignal
}>

const autoSkillSelectors = new WeakMap<ExecutionRuntime, ReturnType<typeof createAutoSkillSelector>>()
function selectSkillWithRuntime(runtime: ExecutionRuntime, input: AutoSkillSelectInput): Promise<AutoSkillSelection> {
  let selector = autoSkillSelectors.get(runtime)
  if (!selector) autoSkillSelectors.set(runtime, selector = createAutoSkillSelector(runtime))
  return selector.select(input)
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
  const allowed = new Set(["--worktree", "--engine", "--model", "--resume", "--continue", "--new"])
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    if (!allowed.has(flag)) throw new InteractiveLaunchError("unknown chat option; use --worktree, --engine, --model, --resume [ID], --continue, or --new")
    if (Object.hasOwn(fields, flag)) throw new InteractiveLaunchError(`duplicate ${flag} option`)
    if (flag === "--continue" || flag === "--new") {
      fields[flag] = "true"
      continue
    }
    if (flag === "--resume" && (argv[index + 1] === undefined || argv[index + 1]!.startsWith("--"))) {
      fields[flag] = ""
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new InteractiveLaunchError(`missing value for ${flag}`)
    }
    fields[flag] = value
    index++
  }
  const restoring = Object.hasOwn(fields, "--resume") || Object.hasOwn(fields, "--continue")
  if (["--resume", "--continue", "--new"].filter(flag => Object.hasOwn(fields, flag)).length > 1) {
    throw new InteractiveLaunchError("choose only one of --resume, --continue, or --new")
  }
  if (restoring && (fields["--engine"] !== undefined || fields["--model"] !== undefined)) {
    throw new InteractiveLaunchError("restoring uses the saved model; omit --engine and --model, then switch with /model")
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
    ...(Object.hasOwn(fields, "--resume") ? { resume: fields["--resume"] || true as const } : {}),
    ...(fields["--continue"] ? { continue: true } : {}),
    ...(fields["--new"] ? { newSession: true } : {}),
  }
}

function sessionLabel(session: ReturnType<typeof inspectSessions>[number]): string {
  const when = session.lastActivityAt ? new Date(session.lastActivityAt).toLocaleString() : "time unknown"
  return terminalSafeText(`${session.summary ?? "Untitled conversation"} · ${session.engine} ${session.model ?? "model unknown"} · ${when} · ${session.sessionID}${session.corrupt ? ` · unavailable: ${boundedTerminalDiagnostic(session.corrupt)}` : ""}`)
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
    // Hand stdin to another reader (the operator decision) without ending input: the next read opens a fresh reader,
    // so post-run prompts (the plan worktree Apply/Keep/Discard choice) can still be answered.
    suspend: () => {
      const current = reader
      reader = undefined
      current?.close()
    },
    resume: () => {},
    close: () => {
      inputClosed = true
      reader?.close()
      reader = undefined
    },
  }
  return terminal
}

/** The vendor CLIs own credentials; otter only asks their status and hands them the terminal to sign in or out. */
export type EngineAuth = {
  status: (engine: AuthEngine, cwd: string) => Promise<AuthState>
  run: (engine: AuthEngine, argv: readonly string[], cwd: string) => Promise<AuthRun>
}
const vendorAuth: EngineAuth = { status: authStatus, run: runVendorAuth }

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
    createController: runtime => createForegroundController(runtime, { planWorktree: chatWorktreeMode(runtime.config) === "plan" }),
    discoverModels: discoverModelCatalog,
    skillPolicy: () => readSkillTrust(),
    selectSkill: selectSkillWithRuntime,
    defaultModel: fileDefaultModelStore,
    combo: fileComboStore,
    auth: vendorAuth,
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

/** Full-screen model selection is explicit about whether it changes future launches. */
async function chooseModelScope(terminal: Terminal, engine: CliEngine, model: string, signal: AbortSignal): Promise<"session" | "default" | null | undefined> {
  if (!terminal.fullscreen || !terminal.choose) return "session"
  const selected = await chooseFrom(terminal, `Apply model · ${engine} / ${model}`,
    ["This session only", "Set as default"],
    ["Use this model now; keep the saved startup default unchanged.", "Use this model now and save it as the default for future launches."],
    "Enter applies the selected scope; Escape cancels the model change.", signal)
  if (selected === null || selected === undefined) return selected
  return selected === 0 ? "session" : selected === 1 ? "default" : null
}

/** `/model` engine step. With `combo`, a fourth entry opens the per-role combo menu instead of picking an engine. */
function chooseEngine(terminal: Terminal, signal: AbortSignal): Promise<CliEngine | null | undefined>
function chooseEngine(terminal: Terminal, signal: AbortSignal, options: { combo: true }): Promise<CliEngine | "combo" | null | undefined>
async function chooseEngine(terminal: Terminal, signal: AbortSignal, options: { combo?: boolean } = {}): Promise<CliEngine | "combo" | null | undefined> {
  const engines: readonly CliEngine[] = ["local", "codex", "claude"]
  const combo = options.combo === true
  if (terminal.fullscreen && terminal.choose) {
    const selected = await terminal.choose("Choose an execution engine", [
      "local — Ollama CLI", "codex — Codex CLI", "claude — Claude CLI", ...(combo ? ["combo — per-role models"] : []),
    ], signal, {
      kind: "picker", purpose: "selection",
      rows: ["Local Ollama runtime", "Codex CLI runtime", "Claude CLI runtime", ...(combo ? ["Route planner/architect/critic/worker… to other engines and models."] : [])],
      hint: "Enter selects this engine only; Escape or /cancel returns to the composer.",
    })
    if (signal.aborted) return undefined
    if (selected === undefined) return null
    if (combo && selected === 3) return "combo"
    return engines[selected] ?? null
  }
  const menu = `Choose an execution engine:\n  1) local  — Ollama CLI\n  2) codex  — Codex CLI\n  3) claude — Claude CLI\n${combo ? "  4) combo  — per-role models\n" : ""}Enter /cancel, Escape or empty input to return.\n`
  terminal.write(menu.trimEnd().split("\n").map(line => inputLine(line, terminal.presentation?.())).join("\n") + "\n")
  while (!signal.aborted) {
    const answer = await readInput(terminal, "Engine selection", "Enter a number or engine name", combo ? "Engine [1-4]: " : "Engine [1-3]: ", signal)
    if (signal.aborted) return undefined
    if (answer === undefined) return null
    const normalized = answer.trim().toLowerCase()
    if (normalized === "" || normalized === "/cancel" || normalized === "escape") return null
    if (normalized === "1" || normalized === "local") return "local"
    if (normalized === "2" || normalized === "codex") return "codex"
    if (normalized === "3" || normalized === "claude") return "claude"
    if (combo && (normalized === "4" || normalized === "combo")) return "combo"
    terminal.write(combo ? "Choose local, codex, claude, or combo (1-4).\n" : "Choose local, codex, or claude (1, 2, or 3).\n")
  }
  return undefined
}

/** Pick one row: full-screen picker when available, otherwise a numbered readline menu. undefined = aborted, null = cancelled. */
async function chooseFrom(
  terminal: Terminal, title: string, labels: readonly string[], details: readonly string[], hint: string, signal: AbortSignal,
): Promise<number | null | undefined> {
  if (terminal.fullscreen && terminal.choose) {
    const selected = await terminal.choose(title, labels, signal, { kind: "picker", purpose: "selection", rows: details, hint })
    if (signal.aborted) return undefined
    return selected === undefined ? null : selected
  }
  const presentation = terminal.presentation?.()
  terminal.write([/[?:]$/u.test(title) ? title : `${title}:`, ...labels.map((label, index) => `  ${index + 1}) ${terminalSafeText(label)}`), "Enter /cancel, Escape or empty input to return."]
    .map(line => inputLine(line, presentation)).join("\n") + "\n")
  while (!signal.aborted) {
    const answer = await readInput(terminal, title, hint, `Choice [1-${labels.length}]: `, signal)
    if (signal.aborted) return undefined
    const normalized = answer?.trim().toLowerCase() ?? ""
    if (answer === undefined || normalized === "" || normalized === "/cancel" || normalized === "escape") return null
    if (/^[0-9]+$/u.test(normalized) && Number(normalized) >= 1 && Number(normalized) <= labels.length) return Number(normalized) - 1
    terminal.write(`Choose a listed number (1-${labels.length}).\n`)
  }
  return undefined
}

/** Decision prompt for the plan worktree: the terminal chooser when present, else a numbered readline menu. undefined = dismissed. */
async function chooseDecision(terminal: Terminal, title: string, labels: readonly string[], signal: AbortSignal): Promise<number | undefined> {
  if (terminal.choose) return terminal.choose(title, labels, signal)
  const presentation = terminal.presentation?.()
  terminal.write([`${title}:`, ...labels.map((label, index) => `  ${index + 1}) ${label}`), "Enter /cancel, Escape or empty input to dismiss."]
    .map(line => inputLine(line, presentation)).join("\n") + "\n")
  while (!signal.aborted) {
    const answer = await readInput(terminal, title, "Pick an option; empty input dismisses.", `Choice [1-${labels.length}]: `, signal)
    const normalized = answer?.trim().toLowerCase() ?? ""
    if (answer === undefined || normalized === "" || normalized === "/cancel" || normalized === "escape") return undefined
    if (/^[0-9]+$/u.test(normalized) && Number(normalized) >= 1 && Number(normalized) <= labels.length) return Number(normalized) - 1
    terminal.write(`Choose a listed number (1-${labels.length}).\n`)
  }
  return undefined
}

type IntentOption =
  | { kind: "chat"; label: string }
  | { kind: "cancel"; label: string }
  | { kind: "workflow"; label: string; descriptor: (typeof PROTECTED_WORKFLOWS)[number] }

function intentOptions(cls: IntentClass): IntentOption[] {
  const workflow = (name: string, label: string): IntentOption[] => {
    const descriptor = PROTECTED_WORKFLOWS.find(candidate => candidate.name === name)
    return descriptor ? [{ kind: "workflow", label, descriptor }] : []
  }
  if (cls === "ambiguous") return [{ kind: "chat", label: "Continue in chat" }, ...workflow("deep-interview", "Start deep-interview"), { kind: "cancel", label: "Cancel" }]
  if (cls === "architecture") {
    return [{ kind: "chat", label: "Continue in chat" }, ...workflow("ralplan", "Start ralplan"),
      ...workflow("deep-interview", "Start deep-interview first"), { kind: "cancel", label: "Cancel" }]
  }
  return []
}

/** Intent offer: the terminal chooser when present, else a numbered readline menu. undefined = dismissed (nothing is sent). */
async function chooseIntentRoute(terminal: Terminal, title: string, labels: readonly string[], signal: AbortSignal): Promise<number | undefined> {
  if (terminal.choose) return terminal.choose(title, labels, signal)
  const presentation = terminal.presentation?.()
  terminal.write([`${title}:`, ...labels.map((label, index) => `  ${index + 1}) ${label}`), "Enter /cancel, Escape or empty input to dismiss; nothing is sent."]
    .map(line => inputLine(line, presentation)).join("\n") + "\n")
  while (!signal.aborted) {
    const answer = await readInput(terminal, title, "Pick a route; empty input dismisses.", `Choice [1-${labels.length}]: `, signal)
    const normalized = answer?.trim().toLowerCase() ?? ""
    if (answer === undefined || normalized === "" || normalized === "/cancel" || normalized === "escape") return undefined
    if (/^[0-9]+$/u.test(normalized) && Number(normalized) >= 1 && Number(normalized) <= labels.length) return Number(normalized) - 1
    terminal.write(`Choose a listed number (1-${labels.length}).\n`)
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

const COMBO_ROLES = EXECUTION_ROLES.filter(role => role !== "main")

/** Picker order and one-line purpose of each routable role (workflow roles first). */
const COMBO_ROLE_INFO: readonly (readonly [ExecutionRole, string])[] = [
  ["planner", "ralplan/ultragoal: drafts and revises the plan"],
  ["architect", "ralplan/ultragoal/deep-interview: architecture review"],
  ["critic", "ralplan/ultragoal/autoresearch: critique and verdict"],
  ["worker", "executes approved tasks (may write files)"],
  ["reviewer", "reviews plans and task diffs"],
  ["interviewer", "deep-interview: asks the questions"],
  ["researcher", "deep-interview/autoresearch: research lane"],
  ["contrarian", "deep-interview: contrarian panel"],
  ["simplifier", "deep-interview: simplifier panel"],
  ["data-analyst", "data tools: analysis"],
  ["data-verifier", "data tools: verification"],
  ["ontology-evolver", "ontology evolution batch"],
  ["answer-judge", "answer judging"],
]

/** A route equal to the anchor is not a route; the session records only roles that differ. */
function effectiveRoutes(engine: CliEngine, model: string, routes: ComboRoutes | undefined): ComboRoutes {
  return canonicalRoutes(Object.fromEntries(Object.entries(routes ?? {})
    .filter(([, route]) => route.engine !== engine || route.model !== model)) as ComboRoutes) ?? {}
}

/** Routes for a new session from the saved combo; a combo the runtime would reject is reported as invalid, never thrown. */
function comboRoutesFor(lookup: ComboLookup, engine: CliEngine, model: string): { routes: ComboRoutes; invalid?: string } {
  if (lookup.state === "invalid") return { routes: {}, invalid: lookup.reason }
  if (lookup.state === "unset") return { routes: {} }
  const checked = validateComboRoutes(lookup.routes)
  if (typeof checked === "string") return { routes: {}, invalid: checked }
  return { routes: effectiveRoutes(engine, model, checked) }
}

function routeLines(routes: ComboRoutes): string[] {
  return (Object.entries(routes) as Array<[ExecutionRole, { engine: string; model: string }]>)
    .map(([role, route]) => `  Route ${role}: ${route.engine} / ${route.model}`)
}

function selectionBanner(worktree: string, engine: CliEngine, model: string, presentation?: InputPresentation, note?: string, routes: ComboRoutes = {}): string {
  return "\n" + [
    "Native execution selection:",
    `  Engine: ${engine}`,
    `  Model: ${model}`,
    ...routeLines(routes),
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
  if (catalog.entries.some(entry => entry.trusted)) lines.push("Trusted skills (skill_trust in the user otter.jsonc) skip the consent prompt; tool and execution approvals are unchanged.")
  lines.push("A submitted /skill:<name> invokes any listed skill. With skill_auto.mode auto (the default; user otter.jsonc), the model may also load consent-free skills on its own when the conversation calls for them and the reply says which; /skills auto shows candidates. deep-interview, ralplan, ultragoal and autoresearch are never started automatically; invoking a name is not execution consent, and unit/experiment work still needs typed approval.")
  return lines
}

function defaultSessionID(uuid: string): string {
  return `otter-${uuid}`
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
  return `Plan rejected by Otter validation${bounded ? `: ${bounded}` : ""}. Revise the plan or enter /quit.\n`
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
  }, { toolLines: !terminal.activity, mainModelLines: !terminal.fullscreen, progressLines: !terminal.fullscreen })
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
        toolDisplay(display: CliToolDisplay) { if (current()) terminal.toolDisplay?.(display) },
        queue(message: string, fields?: Record<string, unknown>) { if (current()) progress.queue(message, fields) },
        verifyRun(run: VerifyRunObservation) { if (current()) showVerifyRun(run) },
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
  let requestInterrupt = () => requestCancel()
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
  /** A queue verify command, shown as a Bash card and recorded with a bounded output tail (display only). */
  function showVerifyRun(run: VerifyRunObservation): void {
    const all = run.output.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n")
    const lines: string[] = []
    let bytes = 0
    for (let index = all.length - 1; index >= 0 && lines.length < MAX_SHELL_LINES; index--) {
      const line = all[index]!.length > 2000 ? `${all[index]!.slice(0, 1999)}…` : all[index]!
      bytes += Buffer.byteLength(line, "utf8") + 1
      if (bytes > MAX_SHELL_OUTPUT_BYTES) break
      lines.unshift(line)
    }
    const status = run.cancelled ? "cancelled" : run.timedOut ? "timeout" : run.ok ? "complete" : "error"
    const command = Buffer.byteLength(run.command, "utf8") > MAX_SHELL_COMMAND_BYTES ? run.command.slice(0, 2000) : run.command
    const id = `verify:${run.taskID}:${run.attempt}:${deps.randomUUID()}`
    const result = { status, exitCode: run.exitCode, signal: null, durationMs: Math.max(0, Math.round(run.durationMs)), lines, totalLines: Math.max(all.length, lines.length) } as const
    if (terminal.verifyRun) terminal.verifyRun({ id, command, taskID: run.taskID, attempt: run.attempt, timeoutMs: run.timeoutMs, result })
    else {
      const tail = lines.slice(-12)
      const outcome = status === "cancelled" ? "cancelled" : status === "timeout" ? "timed out" : `exit ${run.exitCode ?? "?"}`
      visibleWrite(terminalSafeText([`[verify] ${run.taskID} attempt ${run.attempt} $ ${command}`,
        ...(result.totalLines > tail.length ? [`  … ${result.totalLines - tail.length} earlier line(s)`] : []),
        ...tail.map(line => `  | ${line}`),
        `  = ${outcome} · ${formatDuration(result.durationMs)} (timeout ${formatDuration(run.timeoutMs)})`].join("\n") + "\n"))
    }
    persist("verify", { taskID: run.taskID, attempt: run.attempt, command, status, exitCode: run.exitCode,
      durationMs: result.durationMs, timeoutMs: Math.max(0, Math.round(run.timeoutMs)), lines, totalLines: result.totalLines }, id)
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
    if (shellAbort && (action === "cancel" || action === "interrupt" || action === "shutdown")) shellAbort.abort()
    else if (action === "interrupt") requestInterrupt()
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
    // Automatic skill selection: the user-config policy, the session toggle (`/skills auto on|off`) and the cached
    // consent-free candidate list (refreshed with the catalog). Candidates are re-prepared per use, so a stale entry
    // can only be refused, never applied with changed content.
    let skillPolicy: SkillTrustLookup | undefined
    let autoSkillEnabled = true
    let autoSkillCandidates: readonly AutoSkillCandidate[] = []
    let autoSkillRequiredTools: readonly string[] = []
    let autoCandidateGeneration = 0
    let autoCandidateWork: Promise<void> = Promise.resolve()
    async function bindSkillSession(store: SessionStore): Promise<void> {
      skillSession?.close()
      skillSession = undefined
      latestSkillCatalog = undefined
      autoSkillCandidates = []
      try {
        const roots = await resolveSkillRoots({ projectRoot: worktree, homeDirectory: homedir() })
        const trust = deps.skillPolicy()
        skillPolicy = trust
        if (trust.problem) visibleWrite(terminalSafeText(`Skill config ignored: ${boundedTerminalDiagnostic(trust.problem)}. Skills still ask for consent and automatic selection is off.\n`))
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
        return
      }
      // Optional and off the startup path: the composer never waits for candidate capture, and a failure only disables
      // automatic selection, never explicit /skill: invocation. A newer refresh supersedes an older one.
      autoSkillCandidates = []
      const generation = ++autoCandidateGeneration
      const policy = skillPolicy
      const runtime = attachedRuntime
      if (!policy || policy.auto.mode === "off" || !runtime) return
      const main = runtime.policy.resolve("main").tools
      const required = main.allowed.filter(tool => !main.denied.includes(tool))
      autoSkillRequiredTools = required
      const current = () => generation === autoCandidateGeneration && target === skillSession && target.store === sessionStore && !abort.signal.aborted
      autoCandidateWork = target.autoCandidates(policy.auto, skillInstructionBudget(runtime.config.delegate.verify_allow), required, abort.signal)
        .then(candidates => { if (current()) autoSkillCandidates = candidates }, () => {
          if (current()) visibleWrite("Automatic skill candidates unavailable; explicit /skill: invocation still works.\n")
        })
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
    const saveDefaultModel = (value: { engine: CliEngine; model: string }, write = (text: string) => terminal.write(terminalSafeText(`${text}\n`))): boolean => {
      try {
        const path = deps.defaultModel.save(value)
        const effective = deps.defaultModel.read(worktree)
        const overridden = effective.state === "configured" && effective.source === "project" &&
          (effective.value.engine !== value.engine || effective.value.model !== value.model)
        write(`Saved default model ${value.engine} / ${value.model} to ${path}.${overridden ? ` This project's .otter/otter.jsonc still selects ${effective.value.engine} / ${effective.value.model}.` : ""}`)
        return true
      } catch (error) {
        write(`Default model not saved: ${boundedTerminalDiagnostic(String(error))}`)
        return false
      }
    }
    const defaultModelCommand = (rest: readonly string[], current: { engine: CliEngine; model: string } | undefined): { engine: CliEngine; model: string } | undefined => {
      let deferNext = false
      const write = (text: string) => {
        if (deferNext) startupNotices.push(text)
        else terminal.write(terminalSafeText(`${text}\n`))
      }
      const save = (value: { engine: CliEngine; model: string }): boolean => saveDefaultModel(value, write)
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
    const comboUsage = "Usage: /model combo (menu) or /model combo [show | <role> <local|codex|claude> <native-id> | clear [role] | apply]; roles: " + COMBO_ROLES.join(", ")
    /**
     * `/model combo` shows the effective routes; `<role> <engine> <id>` and `clear` edit user config only. Neither
     * changes the running session: a combo applies to new sessions, via `apply`. Returns "apply" for the caller.
     */
    const comboCommand = (rest: readonly string[], current: { engine: CliEngine; model: string; routes: ComboRoutes } | undefined): "apply" | undefined => {
      const write = (text: string) => terminal.write(terminalSafeText(`${text}\n`))
      const show = (): void => {
        const lookup = deps.combo.read(worktree)
        if (lookup.state === "invalid") {
          write(`Combo is invalid and is not applied: ${boundedTerminalDiagnostic(lookup.reason)}. Fix the config or run /model combo clear.`)
          return
        }
        const routes = lookup.state === "configured" ? lookup.routes : {}
        const lines = ["Combo routes (main is the /model selection):"]
        if (current) lines.push(`  main: ${current.engine} / ${current.model} (current /model)`)
        for (const role of COMBO_ROLES) {
          const route = routes[role]
          if (route) lines.push(`  ${role}: ${route.engine} / ${route.model} (${lookup.state === "configured" ? lookup.sources[role] : "user"} config)`)
        }
        if (lookup.state === "unset") lines.push("  No roles are routed; every role uses the main model.")
        if (current) {
          const wanted = effectiveRoutes(current.engine, current.model, routes)
          lines.push(routesKey(wanted) === routesKey(current.routes)
            ? "The current session uses these routes."
            : `The current session ${Object.keys(current.routes).length ? `uses ${Object.keys(current.routes).length} different pinned role${Object.keys(current.routes).length === 1 ? "" : "s"}` : "uses no routes"}; /model combo apply starts a new session with the saved combo.`)
        }
        write(lines.join("\n"))
      }
      if (rest.length === 1 && rest[0] === "show") { show(); return undefined }
      if (rest.length === 1 && rest[0] === "apply") return "apply"
      if (rest[0] === "clear" && rest.length <= 2) {
        const role = rest[1]
        if (role !== undefined && !(COMBO_ROLES as readonly string[]).includes(role)) { write(comboUsage); return undefined }
        try {
          const removed = role === undefined ? deps.combo.clear() : deps.combo.clearRole(role as ExecutionRole)
          const after = deps.combo.read(worktree)
          const projectRoles = after.state === "configured"
            ? COMBO_ROLES.filter(candidate => (role === undefined || candidate === role) && after.sources[candidate] === "project")
            : []
          write(`${removed ? `Combo ${role === undefined ? "cleared" : `route ${role} cleared`} from user config.` : `No user combo ${role === undefined ? "was" : `route for ${role} was`} set.`}${projectRoles.length ? ` The effective combo still routes ${projectRoles.join(", ")} from this project's .otter/otter.jsonc.` : ""}${current ? " The current session is unchanged." : ""}`)
        } catch (error) { write(`Combo not cleared: ${boundedTerminalDiagnostic(String(error))}`) }
        return undefined
      }
      if (rest.length === 3 && ["local", "codex", "claude"].includes(rest[1]!) && (COMBO_ROLES as readonly string[]).includes(rest[0]!) && validModelID(rest[2]!)) {
        const role = rest[0] as ExecutionRole
        const route = { engine: rest[1] as CliEngine, model: rest[2]! }
        try {
          const path = deps.combo.save(role, route)
          const effective = deps.combo.read(worktree)
          const winner = effective.state === "configured" ? effective.routes[role] : undefined
          const overridden = effective.state === "configured" && effective.sources[role] === "project" && winner &&
            (winner.engine !== route.engine || winner.model !== route.model)
          write(`Saved combo route ${role} -> ${route.engine} / ${route.model} to ${path}.${overridden ? ` This project's .otter/otter.jsonc still routes ${role} to ${winner.engine} / ${winner.model}.` : ""} ${current ? "The current session is unchanged; /model combo apply starts a new session with it." : "It applies when a model is selected."}`)
        } catch (error) { write(`Combo route not saved: ${boundedTerminalDiagnostic(error instanceof Error ? error.message : String(error))}`) }
        return undefined
      }
      write(comboUsage)
      return undefined
    }
    /**
     * `/model combo` (and the /model "combo" entry): menu-driven editing of the saved combo (role -> engine -> model). Every save and clear goes through
     * comboCommand, so validation and messages are identical to the typed form. Returns "apply" when the operator
     * chose to apply, undefined when they finished, and "aborted" when the turn was aborted.
     */
    const comboPicker = async (current: { engine: CliEngine; model: string; routes: ComboRoutes } | undefined): Promise<"apply" | "aborted" | undefined> => {
      const signal = abort.signal
      const write = (text: string) => terminal.write(terminalSafeText(`${text}\n`))
      while (!signal.aborted) {
        const lookup = deps.combo.read(worktree)
        const saved = lookup.state === "configured" ? lookup.routes : {}
        const roleLabels = COMBO_ROLE_INFO.map(([role]) => {
          const route = saved[role]
          return `${role} — ${route ? `${route.engine} / ${route.model}` : "main model"}`
        })
        const actions = [
          ...(current ? [{ id: "apply" as const, label: "Apply to a new session", detail: "Start a new session under the saved combo; the current one is kept." }] : []),
          { id: "clear" as const, label: "Clear all routes", detail: "Every role uses the main model." },
          { id: "done" as const, label: "Done", detail: current ? "Keep the current session unchanged." : "The combo applies when a model is selected." },
        ]
        if (lookup.state === "invalid") write(`Combo is invalid and is not applied: ${boundedTerminalDiagnostic(lookup.reason)}.`)
        const main = current ? `main: ${current.engine} / ${current.model}` : "main: not selected yet"
        const picked = await chooseFrom(terminal, `Combo · ${main}`,
          [...roleLabels, ...actions.map(action => action.label)],
          [...COMBO_ROLE_INFO.map(([, info]) => info), ...actions.map(action => action.detail)],
          "Pick a role to route it to another engine and model; saved to ~/.config/otter/otter.jsonc.", signal)
        if (picked === undefined) return "aborted"
        if (picked === null) return undefined
        const action = actions[picked - COMBO_ROLE_INFO.length]
        if (action?.id === "done") return undefined
        if (action?.id === "apply") return "apply"
        if (action?.id === "clear") { comboCommand(["clear"], current); continue }
        const role = COMBO_ROLE_INFO[picked]![0]
        const engineChoice = await chooseFrom(terminal, `Combo · ${role} · engine`,
          ["local — Ollama CLI", "codex — Codex CLI", "claude — Claude CLI", "Use the main model (remove this route)"],
          ["Local Ollama runtime", "Codex CLI runtime", "Claude CLI runtime", "Clear the saved route for this role."],
          "Escape returns to the role list.", signal)
        if (engineChoice === undefined) return "aborted"
        if (engineChoice === null) continue
        if (engineChoice === 3) { comboCommand(["clear", role], current); continue }
        const routeEngine = (["local", "codex", "claude"] as const)[engineChoice]!
        const modelChoice = await chooseModel(terminal, routeEngine, worktree, signal, deps.discoverModels)
        if (modelChoice.value === undefined) return "aborted"
        if (modelChoice.value === null) continue
        comboCommand([role, routeEngine, modelChoice.value], current)
      }
      return "aborted"
    }
    /**
     * `/auth` (status), `/login [codex|claude] [browser|device|console|api-key]`, `/logout [codex|claude]`. The vendor
     * CLI owns every credential: status is its read-only status command; login/logout get the real terminal.
     */
    const authUsage = "Usage: /auth · /login [codex|claude] [browser|device|console|api-key] · /logout [codex|claude]"
    /** After a failure, name engines the vendor CLI reports as signed out (status is read-only and bounded). */
    const signInHint = async (engines: Iterable<CliEngine>): Promise<string | undefined> => {
      const wanted = [...new Set(engines)].filter((engine): engine is AuthEngine => (AUTH_ENGINES as readonly string[]).includes(engine))
      if (!wanted.length) return undefined
      let states: AuthState[]
      try { states = await Promise.all(wanted.map(engine => deps.auth.status(engine, worktree))) } catch { return undefined }
      const out = states.filter(state => state.state === "signed-out").map(state => state.engine)
      return out.length ? `${out.join(" and ")} ${out.length === 1 ? "is" : "are"} not signed in; run ${out.map(engine => `/login ${engine}`).join(" or ")}.` : undefined
    }
    const modelSwitchHint = async (engines: Iterable<CliEngine>): Promise<string | undefined> => {
      const targets = [...engines]
      const auth = await signInHint(targets)
      return auth ?? (targets.includes("codex")
        ? `Check Codex CLI compatibility: supported versions are ${CODEX_SUPPORTED_VERSIONS.join(", ")}. Run codex --version and otter doctor for diagnostics.`
        : undefined)
    }
    const engineSet = (anchor: CliEngine, routes: ComboRoutes): CliEngine[] => [anchor, ...Object.values(routes).map(route => route!.engine)]
    const authCommand = async (command: "/auth" | "/login" | "/logout", rest: readonly string[]): Promise<"aborted" | undefined> => {
      const write = (text: string) => visibleWrite(terminalSafeText(`${text}\n`))
      const signal = abort.signal
      if (command === "/auth") {
        if (rest.length) { write(authUsage); return undefined }
        const states = await Promise.all(AUTH_ENGINES.map(engine => deps.auth.status(engine, worktree)))
        write(["Engine sign-in (checked with each vendor CLI; otter stores no credentials):", ...states.map(state => `  ${describeAuth(state)}`),
          "  local: no sign-in (Ollama on this machine)"].join("\n"))
        return undefined
      }
      if (rest.length > (command === "/login" ? 2 : 1) || (rest[0] !== undefined && !(AUTH_ENGINES as readonly string[]).includes(rest[0]))) {
        write(rest[0] === "local" ? "The local engine (Ollama) needs no sign-in." : authUsage)
        return undefined
      }
      let engine = rest[0] as AuthEngine | undefined
      if (engine === undefined) {
        const states = await Promise.all(AUTH_ENGINES.map(candidate => deps.auth.status(candidate, worktree)))
        const picked = await chooseFrom(terminal, command === "/login" ? "Sign in to which engine?" : "Sign out of which engine?",
          states.map(state => describeAuth(state)), AUTH_ENGINES.map(candidate => candidate === "codex" ? "OpenAI Codex CLI" : "Anthropic Claude CLI"),
          "The vendor CLI opens its own sign-in; otter stores no credentials.", signal)
        if (picked === undefined) return "aborted"
        if (picked === null) return undefined
        engine = AUTH_ENGINES[picked]!
      }
      let argv: string[]
      if (command === "/login") {
        const methods: readonly LoginMethod[] = engine === "codex" ? ["browser", "device", "api-key"] : ["browser", "console"]
        let method = rest[1] as LoginMethod | undefined
        if (method !== undefined && !methods.includes(method)) { write(`${engine} sign-in methods: ${methods.join(", ")}.`); return undefined }
        if (method === undefined) {
          const labels: Record<LoginMethod, string> = {
            browser: engine === "codex" ? "browser — ChatGPT account (opens a browser)" : "browser — Claude subscription (opens a browser)",
            device: "device — one-time code for a remote or headless machine",
            console: "console — Anthropic Console (API billing)",
            "api-key": "api-key — paste an OpenAI API key into the codex prompt",
          }
          const picked = await chooseFrom(terminal, `Sign in to ${engine}`, methods.map(candidate => labels[candidate]),
            methods.map(() => "Runs the vendor's own sign-in command in this terminal."), "Escape returns without signing in.", signal)
          if (picked === undefined) return "aborted"
          if (picked === null) return undefined
          method = methods[picked]!
        }
        argv = loginArgv(engine, method)
      } else {
        const confirm = await chooseFrom(terminal, `Sign out of ${engine}? This removes the ${engine} CLI's saved sign-in for every program that uses it.`,
          ["Keep signed in", `Sign out of ${engine}`], ["Nothing changes.", `Runs ${engine} ${logoutArgv(engine).join(" ")}.`], "Escape keeps you signed in.", signal)
        if (confirm === undefined) return "aborted"
        if (confirm !== 1) { write(`Still signed in to ${engine}.`); return undefined }
        argv = logoutArgv(engine)
      }
      // Give the vendor CLI the real terminal: no raw mode, no progress redraws. Ctrl+C reaches the vendor's process
      // group; otter ignores SIGINT meanwhile so it only stops the sign-in, never this session.
      progress.suspend()
      terminal.suspend?.()
      const ignoreInterrupt = () => {}
      if (sigintRegistered) deps.signals.off("SIGINT", onSigint)
      deps.signals.on("SIGINT", ignoreInterrupt)
      let run: AuthRun | undefined
      let failure: string | undefined
      try {
        process.stderr.write(`\n$ ${engine} ${argv.join(" ")}\n`)
        run = await deps.auth.run(engine, argv, worktree)
      } catch (error) {
        failure = boundedTerminalDiagnostic(error instanceof Error ? error.message : String(error))
      } finally {
        deps.signals.off("SIGINT", ignoreInterrupt)
        if (sigintRegistered) deps.signals.on("SIGINT", onSigint)
        terminal.resume?.()
        progress.resume()
      }
      if (failure !== undefined) { write(`${engine} ${argv.join(" ")} could not run: ${failure}`); return undefined }
      const after = await deps.auth.status(engine, worktree)
      const outcome = run!.signal ? `stopped by ${run!.signal}` : `exited ${run!.exitCode ?? "?"}`
      write(`${engine} ${argv.join(" ")} ${outcome}. Now ${describeAuth(after).replace(/^\w+: /u, "")}.`)
      persist("notice", { text: `Engine sign-in: ${engine} ${command === "/login" ? "login" : "logout"} ${outcome}; ${after.state}` })
      return undefined
    }
    let engine: CliEngine | undefined
    let model: string | undefined
    let startupDiscovery: InteractiveViewFacts["discovery"] = "not-observed"
    let startupModelScope: "session" | "default" = "session"
    let startupSession: (NonNullable<ReturnType<typeof readSessionMetadata>> & { sessionID: string }) | undefined
    function selectStartupSession(sessionID: string): void {
      const saved = readSessionMetadata(worktree, sessionID)
      if (!saved || !["local", "codex", "claude"].includes(saved.engine) || !saved.model) {
        throw new InteractiveLaunchError("No compatible saved CLI session; use /sessions to choose another session.")
      }
      const replay = replaySession(worktree, sessionID, { limit: 1 })
      if (!replay.complete) throw new InteractiveLaunchError("Incomplete saved session; restore refused.")
      startupSession = { ...saved, sessionID }
      engine = saved.engine as CliEngine
      model = saved.model
    }
    const startupCandidates = () => inspectSessions(worktree).filter(session =>
      session.corrupt || (["local", "codex", "claude"].includes(session.engine) && session.model))
    async function chooseStartupSession(): Promise<void> {
      const sessions = startupCandidates()
      if (!sessions.length) {
        terminal.write("No saved CLI sessions in this worktree. Start a new conversation with /model.\n")
        return
      }
      const labels = sessions.map(sessionLabel)
      const picked = await withProgressSuspended(() => chooseFrom(terminal, "Previous sessions", [...labels, "Start a new conversation"],
        [...labels, "Choose a model or use your default."], "Choose a previous session; Escape starts a new conversation.", abort.signal))
      if (picked === undefined || picked === null || picked === sessions.length) return
      const captured = sessions[picked]
      if (!captured) throw new InteractiveLaunchError("Invalid saved session selection")
      if (captured.corrupt) throw new InteractiveLaunchError(`Saved session ${captured.sessionID} is unavailable: ${boundedTerminalDiagnostic(captured.corrupt)}`)
      selectStartupSession(captured.sessionID)
      if (startupSession!.engine !== captured.engine || startupSession!.model !== captured.model) {
        throw new InteractiveLaunchError("The selected session changed; restore refused.")
      }
    }
    if (typeof args.resume === "string") selectStartupSession(args.resume)
    else if (args.continue) {
      const latest = startupCandidates()[0]
      if (!latest) throw new InteractiveLaunchError("No saved CLI sessions in this worktree; start a new conversation with otter.")
      if (latest.corrupt) throw new InteractiveLaunchError(`Latest saved session ${latest.sessionID} is unavailable: ${boundedTerminalDiagnostic(latest.corrupt)}. Use --resume to choose another session.`)
      selectStartupSession(latest.sessionID)
    } else if (args.resume || (!args.newSession && !args.engine && !args.model && terminal.fullscreen && terminal.choose &&
      startupCandidates().length > 0)) {
      await chooseStartupSession()
    }
    if (abort.signal.aborted) return signalExit(receivedSignal)
    // Explicit flags win; a persisted default applies only when neither flag was given.
    const configuredDefault: DefaultModelLookup = args.engine === undefined && args.model === undefined
      ? deps.defaultModel.read(worktree)
      : { state: "unset" }
    if (startupSession) {
      // The retained selection and routes take precedence over today's defaults.
    } else if (args.engine !== undefined && args.model !== undefined) {
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
          "/model choose | /sessions resume | /help | /quit",
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
        if ((command === "/sessions" && commandArgs.length === 0) || (command === "/resume" && commandArgs.length <= 1)) {
          try {
            if (commandArgs[0]) selectStartupSession(commandArgs[0])
            else await chooseStartupSession()
            if (startupSession) break selection
          } catch (error) {
            startupSession = undefined
            engine = undefined
            model = undefined
            terminal.write(`Session restore refused: ${boundedTerminalDiagnostic(String(error))}\n`)
          }
          continue
        }
        if (command === "/help" && hasInteractiveAction("unselected", "help")) {
          if (commandArgs.length === 0) await presentHelp(terminal, "unselected", abort.signal)
          else terminal.write("Usage: /help\n")
          continue
        }
        if (["/search", "/expand", "/details", "/theme", "/ascii"].includes(command!)) {
          terminal.write(`${command} is a local full-screen TUI action; it is unavailable in readline and no model turn was dispatched.\n`)
          continue
        }
        if (command === "/memory" && hasInteractiveAction("unselected", "memory")) {
          if (commandArgs[0] === "test") terminal.write("Testing the memory engine with one fixed request; this can take up to memory.timeout_ms...\n")
          terminal.write(terminalSafeText(`${await memoryCommand(commandArgs, worktree, deps.memory ?? fileMemoryStore)}\n`))
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
        if ((command === "/auth" || command === "/login" || command === "/logout") && hasInteractiveAction("unselected", "auth")) {
          if (await withProgressSuspended(() => authCommand(command, commandArgs)) === "aborted" && abort.signal.aborted) return signalExit(receivedSignal)
          continue
        }
        if (command === "/model" && commandArgs[0] === "combo" && hasInteractiveAction("unselected", "model")) {
          const rest = commandArgs.slice(1)
          if (rest.length === 0) {
            if (await withProgressSuspended(() => comboPicker(undefined)) === "aborted" && abort.signal.aborted) return signalExit(receivedSignal)
          } else if (comboCommand(rest, undefined) === "apply") {
            terminal.write("No model is selected yet; select one with /model, then run /model combo apply.\n")
          }
          continue
        }
        if (command === "/model" && hasInteractiveAction("unselected", "model")) {
          if (commandArgs.length === 2 && ["local", "codex", "claude"].includes(commandArgs[0]!) && validModelID(commandArgs[1]!)) {
            const scope = await withProgressSuspended(() => chooseModelScope(terminal, commandArgs[0] as CliEngine, commandArgs[1]!, abort.signal))
            if (scope === undefined || abort.signal.aborted) return signalExit(receivedSignal)
            if (scope === null) continue
            startupModelScope = scope
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
            const chosen = await withProgressSuspended(() => chooseEngine(terminal, abort.signal, { combo: true }))
            if (abort.signal.aborted) return signalExit(receivedSignal)
            if (chosen === "combo") {
              if (await withProgressSuspended(() => comboPicker(undefined)) === "aborted" && abort.signal.aborted) return signalExit(receivedSignal)
              continue
            }
            nextEngine = chosen
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
            const scope = await withProgressSuspended(() => chooseModelScope(terminal, nextEngine!, picked.value!, abort.signal))
            if (scope === undefined || abort.signal.aborted) return signalExit(receivedSignal)
            if (scope === null) break
            startupModelScope = scope
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
    const initialSessionID = startupSession?.sessionID ?? defaultSessionID(deps.randomUUID())
    const initialProgress = scopedProgress()
    const startupCombo = startupSession ? { routes: startupSession.routes ?? {}, invalid: undefined } : comboRoutesFor(deps.combo.read(worktree), engine, model)
    if (startupCombo.invalid !== undefined) startupNotices.push(`Combo ignored: ${boundedTerminalDiagnostic(startupCombo.invalid)}. No role routes are applied; every role uses ${engine} / ${model}.`)
    const initialRoutes = startupCombo.routes
    const initialRuntime = deps.createRuntime({ worktree, engine, model, progress: initialProgress.sink, ...(Object.keys(initialRoutes).length ? { routes: initialRoutes } : {}) })
    initialRuntime.linuxAdmission?.assertBootEpoch()
    if (!startupSession) await deps.admitRuntime(initialRuntime)
    if (abort.signal.aborted) return signalExit(receivedSignal)
    sessionStore = attachAdmission(initialRuntime, initialSessionID, { engine, model, ...(Object.keys(initialRoutes).length ? { routes: initialRoutes } : {}) })
    initialProgress.bind(sessionStore)
    attachedRuntime = initialRuntime
    let selection = {
      engine,
      model,
      routes: initialRoutes,
      sessionID: initialSessionID,
      runtime: initialRuntime,
      controller: deps.createController(initialRuntime),
      conversation: deps.createConversation(initialRuntime, initialSessionID, startupSession ? restoredConversation(initialSessionID) : undefined),
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
        selection: retainedViewSelection ?? { engine: selection.engine, model: selection.model, ...(Object.keys(selection.routes).length ? { routes: selection.routes } : {}) },
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
    if (startupSession) {
      terminal.write(`Restored session ${initialSessionID}. Previous conversation and model restored; use /continue to resume.\n`)
      const retainedWorkflow = readSessionCommitted(worktree, initialSessionID)
      if (retainedWorkflow) {
        terminal.write(terminalSafeText(`[workflow] ${retainedWorkflow.wf.id} ${retainedWorkflow.wf.phase} · ${retainedWorkflow.path} · sha256 ${retainedWorkflow.sha256}\n`))
        terminal.write(terminalSafeText(`[artifacts] ${incompleteArtifactSummary(worktree, retainedWorkflow.wf) ?? "all verified"}\n`))
      }
    }
    if (startupModelScope === "default") saveDefaultModel({ engine, model })
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
      finishIsolation: async workflowID => {
        if (selection.controller.pendingPlanWorktree?.(selection.sessionID) === workflowID) await offerPlanWorktree(workflowID)
      },
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
    /**
     * Escape stops only work that is running now (a model turn or step, a queue execution, an unconfirmed cancel). With
     * nothing running it never stops a workflow: an idle Escape must not discard an interview or an approved plan.
     */
    requestInterrupt = () => {
      if (retainedSDKSessionID) return
      let live = operationAbort !== undefined
      try {
        const state = selection.runtime.runs.status()
        live ||= !!state.claim || state.executions.some(execution => !settled(execution))
      } catch { live = true }
      if (live) { requestCancel(); return }
      try {
        const current = activeAnyWorkflow(worktree)
        if (current?.sessionID === selection.sessionID) terminal.write(`Nothing is running; Escape does not stop the ${current.kind} workflow. Use /cancel to stop it or /pause to keep it.\n`)
      } catch { /* display only */ }
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
    if (!terminal.fullscreen) terminal.write(selectionBanner(worktree, selection.engine, selection.model, terminal.presentation?.(), undefined, selection.routes))

    async function runOwned(resumed: boolean) {
      if (persistenceFailed) throw new InteractiveLaunchError("Session transcript persistence failed; the session remains held.")
      if (effectiveHold(worktree, selection.sessionID)) throw new InteractiveLaunchError("Session held; explicit Resume required.")
      const start = (inPlace: boolean) => resumed
        ? selection.controller.resume(selection.sessionID, abort.signal, { inPlace })
        : selection.controller.run(selection.sessionID, abort.signal, { inPlace })
      let result: Awaited<ReturnType<typeof start>>
      try { result = await start(false) }
      catch (error) {
        if (!(error instanceof PlanIsolationUnavailableError)) throw error
        // No commit / not a git repository: never a silent fallback. The human picks, and the pick is recorded.
        terminal.write(terminalSafeText(`${error.message}. Nothing has run yet. In-place edits land directly in your checkout and cannot be reviewed or discarded as one patch.\n`))
        const picked = await chooseDecision(terminal, `Plan worktree unavailable: ${error.reason === "no-git" ? "not a git repository" : "no commit yet"}`,
          ["Run in place in my checkout", "Cancel"], abort.signal)
        terminal.resume?.()
        const inPlace = picked === 0
        persist("workflow-choice", { text: inPlace ? "Operator chose to run in place in the checkout (no plan worktree available)." : "Operator cancelled the run (no plan worktree available).", planIsolation: inPlace ? "in-place" : "cancelled", reason: error.reason })
        if (!inPlace) return undefined
        result = await start(true)
      }
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
      if (result.planWorktree && !result.run.aborted && !receivedSignal) await offerPlanWorktree(result.planWorktree.workflowID)
      return result
    }

    /**
     * The end of an isolated run: show what changed (files, diff stat, patch path) and ask Apply / Keep / Discard. Only
     * Apply touches the checkout (`git apply --check` first). A conflict keeps the worktree, copies the patch to
     * `.otter/handoffs/<sid>/` and leaves the checkout alone; `/continue` offers the choice again.
     */
    async function offerPlanWorktree(workflowID: string): Promise<void> {
      const sessionID = selection.sessionID
      const review = await selection.controller.reviewPlanWorktree(sessionID, workflowID)
      if (!review.ok) {
        terminal.write(terminalSafeText(`Plan worktree for workflow ${workflowID} could not be reviewed: ${review.reason}. It was kept; your checkout is untouched.\n`))
        return
      }
      const changed = review.files.length ? review.files.map(file => `  ${file}`).join("\n") : "  (no changes)"
      terminal.write(terminalSafeText(`\n[worktree] Workflow ${workflowID} ran in ${review.path}\nChanged files (${review.files.length}):\n${changed}\n${review.stat ? `${review.stat}\n` : ""}${review.patch ? `Patch: ${review.patch}\n` : ""}Excluded paths (diff_exclude) are not carried. Your checkout is unchanged until you apply.\n`))
      const picked = await chooseDecision(terminal, "Apply the plan worktree?", ["Apply to my checkout", "Keep worktree", "Discard"], abort.signal)
      terminal.resume?.()
      const choice = picked === 0 ? "apply" : picked === 2 ? "discard" : "keep"
      persist("workflow-choice", { text: `Operator chose ${choice} for the plan worktree of workflow ${workflowID}.`, workflowID, planWorktree: choice })
      try {
        if (choice === "keep") {
          terminal.write(terminalSafeText(`Worktree kept at ${review.path}. /continue offers Apply, Keep or Discard again.\n`))
        } else if (choice === "discard") {
          await selection.controller.discardPlanWorktree(sessionID, workflowID)
          terminal.write("Worktree discarded; your checkout was not changed.\n")
        } else {
          const applied = await selection.controller.applyPlanWorktree(sessionID, workflowID)
          if (applied.ok) terminal.write(terminalSafeText(`Applied ${applied.files.length} file(s) to your checkout; worktree removed.\n`))
          else {
            let kept = applied.patch
            try {
              if (!applied.patch) throw new Error("no patch was produced")
              const dir = handoffDir(worktree, sessionID)
              mkdirSync(dir, { recursive: true })
              kept = resolve(dir, `plan-${workflowID}.patch`)
              copyFileSync(applied.patch, kept)
            } catch { /* the original patch path is still reported */ }
            terminal.write(terminalSafeText(`Apply refused: ${applied.reason}. Your checkout is untouched and the worktree was kept. Patch: ${kept || "(none)"}. /continue offers the choice again.\n`))
          }
        }
      } catch (error) {
        terminal.write(terminalSafeText(`Plan worktree ${choice} failed: ${boundedTerminalDiagnostic(String(error))}. The worktree was kept.\n`))
      }
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
      if (!result) {
        terminal.write("Run cancelled before dispatch; the approved plan stays executing. /continue retries.\n")
        return undefined
      }
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
        const occupant = activeAnyWorkflow(worktree)
        // Another session's workflow is untouched by this session's model choice; only this session's own workflow blocks it.
        if (occupant && occupant.sessionID === selection.sessionID && !allowHeldWorkflow) {
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

    /** Chat is held only because another session owns the active workflow; this session itself is clean. */
    function foreignWorkflowOnly(): boolean {
      try {
        if (retainedSDKSessionID || effectiveHold(worktree, selection.sessionID) || readAnyWorkflowChecked(worktree).corrupt) return false
        const occupant = activeAnyWorkflow(worktree)
        const state = selection.runtime.runs.status()
        return !!occupant && occupant.sessionID !== selection.sessionID && !state.claim && state.executions.every(settled)
      } catch { return false }
    }

    /** The live workflow owned by this session whose model may be changed in place (not held, stopped or foreign). */
    function rebindableWorkflow(): WorkflowEnvelope | undefined {
      try {
        if (retainedSDKSessionID || !sessionStore || !attachedRuntime) return undefined
        const wf = activeAnyWorkflow(worktree)
        return wf && wf.sessionID === selection.sessionID && !effectiveHold(worktree, selection.sessionID) ? wf : undefined
      } catch { return undefined }
    }

    /**
     * Change the model/routes under an active workflow in place: same session ID, same history, same workflow. Only at a
     * step boundary (the switch guard refuses while any execution or activity is unsettled) and never across engines.
     */
    async function rebindSelection(wf: WorkflowEnvelope, nextEngine: CliEngine, nextModel: string, nextRoutes: ComboRoutes, discovery: InteractiveViewFacts["discovery"], comboNotice: string | undefined, onSelected?: () => void): Promise<boolean> {
      if (nextEngine !== wf.engine) {
        terminal.write(terminalSafeText(`Model switch refused: the active workflow ${wf.id} runs on ${wf.engine}; pick another ${wf.engine} model, or finish/cancel the workflow to switch engines.\n`))
        return true
      }
      const guard = acquireSwitchGuard(true)
      if (!guard.release) {
        terminal.write(guard.refusal ?? "Model switch refused; current selection is unchanged.\n")
        return true
      }
      const store = sessionStore!
      try {
        let prior: ConversationMessage[]
        try { prior = restoredConversation(selection.sessionID) }
        catch {
          terminal.write("Model switch refused: the current conversation could not be read in full; selection and conversation are unchanged.\n")
          return true
        }
        const nextProgress = scopedProgress()
        const runtime = deps.createRuntime({ worktree, engine: nextEngine, model: nextModel, progress: nextProgress.sink, ...(Object.keys(nextRoutes).length ? { routes: nextRoutes } : {}) })
        runtime.linuxAdmission?.assertBootEpoch()
        await deps.admitRuntime(runtime)
        if (abort.signal.aborted) return false
        const controller = deps.createController(runtime)
        const conversation = deps.createConversation(runtime, selection.sessionID, prior.length ? prior : undefined)
        if (abort.signal.aborted) return false
        // The admission check below requires no live local activity, so the guard's own activity is released first.
        guard.release()
        const changed = rebindAdmissionModel(runtime, selection.sessionID, store.epoch, { engine: nextEngine, model: nextModel, ...(Object.keys(nextRoutes).length ? { routes: nextRoutes } : {}) })
        nextProgress.bind(store)
        attachedRuntime = runtime
        requestObservation = { state: "not-observed" }
        discoveryObservation = discovery
        selection = { engine: nextEngine, model: nextModel, routes: nextRoutes, sessionID: selection.sessionID, runtime, controller, conversation }
        const side = (value: { engine: string; model?: string; routes?: ComboRoutes }) => ({ engine: value.engine, model: value.model ?? "", ...(value.routes && Object.keys(value.routes).length ? { routes: value.routes } : {}) })
        persist("model-rebind", { from: side(changed.from), to: side(changed.to), workflowID: wf.id })
        terminal.bindView?.(currentViewIdentity())
        publishView()
        terminal.write(terminalSafeText(`Now using ${nextEngine} / ${nextModel}. Same session and workflow ${wf.id} continue; the next step uses this model.\n`))
        if (comboNotice) terminal.write(terminalSafeText(comboNotice))
        onSelected?.()
      } catch (error) {
        if (!(error instanceof AdmissionRefusal) && !(error instanceof TypeError) && !(error instanceof Error && /^model rebind refused/.test(error.message))) throw error
        if (abort.signal.aborted) return false
        if (error instanceof Error && /^model rebind refused/.test(error.message)) terminal.write(terminalSafeText(`Model switch refused: ${boundedTerminalDiagnostic(error.message)}; the current selection and conversation are unchanged.\n`))
        else {
          const route = error instanceof AdmissionRefusal && error.comboRoutes ? ` Combo route unavailable: ${error.comboRoutes}.` : ""
          const hint = await modelSwitchHint(engineSet(nextEngine, nextRoutes))
          terminal.write(terminalSafeText(`Model switch failed; the current selection and conversation are unchanged.${route}${hint ? ` ${hint}` : ""}\n`))
        }
      } finally {
        guard.release()
      }
      return true
    }

    async function switchSelection(
      nextEngine: CliEngine,
      nextModel: string,
      targetSessionID?: string,
      forceNew = false,
      discovery: InteractiveViewFacts["discovery"] = "not-observed",
      pinnedRoutes?: ComboRoutes,
      onSelected?: () => void,
    ): Promise<boolean> {
      // /resume uses the pinned routes as stored. Every other new session (plain switch, /new, apply) derives its
      // routes from the current saved combo, normalized against the new anchor; an invalid combo is reported, not applied.
      const resuming = targetSessionID !== undefined && !forceNew
      let comboNotice: string | undefined
      let nextRoutes: ComboRoutes
      if (resuming) nextRoutes = canonicalRoutes(pinnedRoutes) ?? {}
      else {
        const derived = comboRoutesFor(deps.combo.read(worktree), nextEngine, nextModel)
        if (derived.invalid !== undefined) comboNotice = `Combo ignored: ${boundedTerminalDiagnostic(derived.invalid)}. No role routes are applied; every role uses ${nextEngine} / ${nextModel}.\n`
        nextRoutes = derived.routes
      }
      if (!forceNew && !targetSessionID && nextEngine === selection.engine && nextModel === selection.model && routesKey(nextRoutes) === routesKey(selection.routes)) {
        discoveryObservation = discovery
        publishView()
        terminal.write("Already using that engine, model and routes; conversation context is unchanged.\n")
        onSelected?.()
        return true
      }
      if (!forceNew && !targetSessionID) {
        const workflow = rebindableWorkflow()
        if (workflow) return rebindSelection(workflow, nextEngine, nextModel, nextRoutes, discovery, comboNotice, onSelected)
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
        const runtime = deps.createRuntime({ worktree, engine: nextEngine, model: nextModel, progress: nextProgress.sink, ...(Object.keys(nextRoutes).length ? { routes: nextRoutes } : {}) })
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
        const nextStore = attachAdmission(runtime, sessionID, { engine: nextEngine, model: nextModel, ...(Object.keys(nextRoutes).length ? { routes: nextRoutes } : {}) })
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
        selection = { engine: nextEngine, model: nextModel, routes: nextRoutes, sessionID, runtime, controller, conversation }
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
          terminal.write(selectionBanner(worktree, selection.engine, selection.model, terminal.presentation?.(), undefined, selection.routes))
          if (note) terminal.write(terminalSafeText(`${note}\n`))
        }
        if (comboNotice) terminal.write(terminalSafeText(comboNotice))
        onSelected?.()
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
        const route = error instanceof AdmissionRefusal && error.comboRoutes ? ` Combo route unavailable: ${error.comboRoutes}.` : ""
        const hint = await modelSwitchHint(engineSet(nextEngine, nextRoutes))
        terminal.write(terminalSafeText(`Model switch failed; the current selection and conversation are unchanged.${route}${hint ? ` ${hint}` : ""}\n`))
      } finally {
        guard.release()
      }
      return true
    }

    async function switchModelWithScope(nextEngine: CliEngine, nextModel: string, discovery: InteractiveViewFacts["discovery"] = "not-observed"): Promise<boolean> {
      const scope = await withProgressSuspended(() => chooseModelScope(terminal, nextEngine, nextModel, abort.signal))
      if (scope === undefined || abort.signal.aborted) return false
      if (scope === null) return true
      return switchSelection(nextEngine, nextModel, undefined, false, discovery, undefined,
        scope === "default" ? () => { saveDefaultModel({ engine: nextEngine, model: nextModel }) } : undefined)
    }

    async function switchToRetainedSDKSession(sessionID: string): Promise<boolean> {
      let replay: ReplayResult
      try {
        const metadata = readSessionMetadata(worktree, sessionID)
        if (!metadata || metadata.engine !== "opencode") {
          terminal.write("Session restore refused: no retained SDK Otter history exists for that session.\n")
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
        return switchSelection(saved.engine as CliEngine, saved.model, sessionID, false, "not-observed", saved.routes ?? {})
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
      const labels = candidates.map((candidate, index) =>
        `${candidate.current ? "current · " : ""}${sessionLabel(inspected[index]!)} · ${candidate.state}`)
      const origin: ViewIdentity = sessionStore
        ? { mode: "writable", sessionID: selection.sessionID, epoch: sessionStore.epoch }
        : { mode: "retained-read-only", sessionID: currentSessionID }
      const chosen = terminal.choose
        ? await terminal.choose("Retained sessions", labels, abort.signal, { kind: "generic-list", rows: labels, origin })
        : await chooseFrom(terminal, "Retained sessions", labels, labels, "Choose a session; empty input returns.", abort.signal)
      if (abort.signal.aborted) return false
      if (chosen === undefined || chosen === null) return true
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

    /** Why chat is held, in the same order the submit path checks it, so the hint matches what Enter will do. */
    const heldInputHint = (): string => {
      if (effectiveHold(worktree, selection.sessionID)) return "Session held · /continue reviews and resumes · /status · /quit exit"
      const executionState = selection.runtime.runs.status()
      if (executionState.claim || executionState.executions.some(execution => !settled(execution))) {
        return "Execution ownership unresolved · /status · /cancel · /quit exit"
      }
      if (readAnyWorkflowChecked(worktree).corrupt) return "Workflow state is corrupt · /status inspects it · /quit exit"
      const occupant = activeAnyWorkflow(worktree)
      if (occupant && occupant.sessionID !== selection.sessionID) {
        return `Observer · /model switch · /status · /resume ${occupant.sessionID} opens the owner · /quit exit`
      }
      if (occupant) return `${occupant.kind} workflow ${occupant.phase} at ${occupant.stage} · /status · /pause · /cancel`
      return "Session held · /status · /help commands · /quit exit"
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
        actionContext = queueAllowed ? "chat" : foreignWorkflowOnly() ? "observer" : "held"
      }
      terminal.actionContext?.(actionContext)
      publishView()
      const promptTitle = retainedSDKSessionID
        ? `Retained SDK session ${retainedSDKSessionID} · read-only history`
        : `${selection.engine} · ${selection.model}`
      const deferredCommand = workflowHost.takeDeferredCommand()
      const text = deferredCommand ?? await withProgressSuspended(() => readInput(
        terminal, promptTitle,
        retainedSDKSessionID ? "Read-only history · /resume or /new to switch · /quit exit"
          : actionContext === "held" || actionContext === "observer" ? heldInputHint() : "Enter send · /help commands · /model switch · /quit exit",
        retainedSDKSessionID ? "History> " : "You> ", abort.signal,
      ))
      if (abort.signal.aborted) return signalExit(receivedSignal)
      if (text === undefined) return { code: 0 }
      const message = text.trim()
      if (!message) continue
      // Candidate capture registers skill permission activity, which execution admission treats as busy; let the
      // background capture settle before any submitted line can start a turn, workflow or shell.
      await autoCandidateWork

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
        if ((command === "/sessions" || command === "/resume") && commandArgs.length === 0) {
          if (!await chooseRetainedSession()) return signalExit(receivedSignal)
          continue
        }
        if (command === "/status" && commandArgs.length === 0) {
          try { terminal.write(readForegroundStatus(selection.runtime, sessionID) + "\n") }
          catch (error) { terminal.write(`Read-only status unavailable: ${boundedTerminalDiagnostic(String(error))}\n`) }
          continue
        }
        if (command === "/skills" && commandArgs.length === 0) {
          visibleWrite("Skill catalog is unavailable in retained read-only SDK history; no Otter writer or SDK runtime was created.\n")
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
      if ((command === "/sessions" || command === "/resume") && commandArgs.length === 0) {
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
        if (commandArgs[0] === "auto" && commandArgs.length <= 2 && (commandArgs[1] === undefined || commandArgs[1] === "on" || commandArgs[1] === "off")) {
          if (commandArgs[1]) autoSkillEnabled = commandArgs[1] === "on"
          await autoCandidateWork
          const mode = skillPolicy?.auto.mode ?? "off"
          const names = autoSkillCandidates.map(candidate => terminalSafeText(candidate.name)).join(", ") || "none"
          terminal.write(`Automatic skills: ${autoSkillEnabled ? "on" : "off"} for this session · skill_auto.mode ${mode} · candidates: ${names}\n`)
          continue
        }
        if (commandArgs.length) {
          visibleWrite("Usage: /skills | /skills grants | /skills revoke <name> | /skills auto [on|off]\n")
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
      // Config-only: selecting the memory engine never dispatches a model or touches the session.
      if (command === "/memory") {
        if (commandArgs[0] === "test") terminal.write("Testing the memory engine with one fixed request; this can take up to memory.timeout_ms...\n")
        terminal.write(terminalSafeText(`${await memoryCommand(commandArgs, worktree, deps.memory ?? fileMemoryStore)}\n`))
        continue
      }
      if (command === "/continue" && commandArgs.length === 0) {
        const planning = activeAnyWorkflow(worktree)
        if (!planning) {
          const kept = selection.controller.pendingPlanWorktree?.(selection.sessionID)
          if (kept) {
            await offerPlanWorktree(kept)
            continue
          }
        }
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
                const ran = "run" in outcome ? outcome : undefined
                const finished = ran ? `done ${ran.run.done}, failed ${ran.run.failed}` : "residual run complete"
                terminal.write(`Residual tasks ran: ${finished}.\n`)
              }
              if ("planWorktree" in outcome && outcome.planWorktree && !("run" in outcome && outcome.run.aborted)) await offerPlanWorktree(outcome.planWorktree.workflowID)
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
      // A live workflow this session owns keeps /model available at its step boundaries (the rebind path checks the rest).
      const modelAllowed = hasInteractiveAction(actionContext, "model") || (actionContext === "held" && rebindableWorkflow() !== undefined)
      // Combo show/set/clear only read or edit config, so they work while held; only apply starts a session.
      /** Run the combo menu (no args) or a typed combo command; false means the chat must exit. */
      const runCombo = async (rest: readonly string[]): Promise<boolean> => {
        const current = { engine: selection.engine, model: selection.model, routes: selection.routes }
        const outcome = rest.length === 0 ? await withProgressSuspended(() => comboPicker(current)) : comboCommand(rest, current)
        if (outcome === "aborted") return !abort.signal.aborted
        if (outcome === "apply") {
          const derived = comboRoutesFor(deps.combo.read(worktree), selection.engine, selection.model)
          if (!modelAllowed) terminal.write("Combo not applied: model selection is unavailable while this session is held; resolve the active workflow first or recover execution ownership. The current session is unchanged.\n")
          else if (derived.invalid !== undefined) terminal.write(terminalSafeText(`Combo is invalid and was not applied: ${boundedTerminalDiagnostic(derived.invalid)}. The current session is unchanged.\n`))
          else if (!await switchSelection(selection.engine, selection.model)) return false
        }
        return true
      }
      if (command === "/model" && commandArgs[0] === "combo" && (actionContext === "chat" || actionContext === "held" || actionContext === "observer")) {
        if (!await runCombo(commandArgs.slice(1))) return signalExit(receivedSignal)
        continue
      }
      // Sign-in only touches the vendor CLI's own credential store; it works while held, never while a turn runs.
      if ((command === "/auth" || command === "/login" || command === "/logout") && hasInteractiveAction(actionContext, "auth")) {
        if (await withProgressSuspended(() => authCommand(command, commandArgs)) === "aborted" && abort.signal.aborted) return signalExit(receivedSignal)
        continue
      }
      if (command === "/model" && !modelAllowed) {
        terminal.write("Model selection is unavailable while this session is held; resolve the active workflow first or recover execution ownership. No discovery or switch was attempted.\n")
        continue
      }
      if (command === "/model" && commandArgs[0] === "default" && modelAllowed) {
        defaultModelCommand(commandArgs.slice(1), { engine: selection.engine, model: selection.model })
        continue
      }
      if (command === "/model" && modelAllowed) {
        if (commandArgs.length === 0) {
          const guard = acquireSwitchGuard(rebindableWorkflow() !== undefined)
          if (!guard.release) {
            terminal.write(guard.refusal ?? "Model switch refused; current selection is unchanged.\n")
            continue
          }
          guard.release()
          const chosen = await withProgressSuspended(() => chooseEngine(terminal, abort.signal, { combo: true }))
          if (abort.signal.aborted) return signalExit(receivedSignal)
          if (chosen === "combo") {
            if (!await runCombo([])) return signalExit(receivedSignal)
            continue
          }
          let nextEngine: CliEngine | null | undefined = chosen
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
            switched = await switchModelWithScope(nextEngine, picked.value, picked.discovery)
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
        if (!await switchModelWithScope(commandArgs[0] as CliEngine, commandArgs[1]!)) return signalExit(receivedSignal)
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
      // Intent step (code-owned heuristic, no model call). Runs only for plain chat lines that already passed every hold
      // above, so an offer can appear exactly where an explicit /skill:<name> start would be allowed.
      let outbound = message
      let intentClass: IntentClass | undefined
      if (!message.startsWith("/") && chatIntentMode(selection.runtime.config) === "offer") {
        const intent = classifyIntent(message)
        intentClass = intent.class
        if (intent.force) outbound = intent.body
        const options = intent.force ? [] : intentOptions(intent.class)
        let offered = options.filter(option => option.kind === "chat" || option.kind === "cancel" ||
          startRefusal(option.descriptor.workflow) === undefined)
        const workflows = offered.flatMap(option => option.kind === "workflow" ? [option] : [])
        if (workflows.length > 1 && autoSkillEnabled && skillPolicy?.auto.mode === "auto" && sessionStore) {
          // Ranking only: the selector's pick moves first among the workflow choices and is marked. Nothing starts
          // without the operator choosing it; a failure keeps the fixed order.
          let ranked: AutoSkillSelection | undefined
          try {
            ranked = await deps.selectSkill(selection.runtime, {
              sessionID: sessionStore.sessionID, messageID: `offer-${requestSequence + 1}`, text: intent.body, mode: "offer",
              candidates: workflows.map(option => ({ name: option.descriptor.name, description: option.descriptor.description, bytes: 0 })),
              signal: abort.signal,
            })
          } catch { ranked = undefined }
          if (abort.signal.aborted) return signalExit(receivedSignal)
          const first = workflows.find(option => option.descriptor.name === ranked?.skill)
          if (first) {
            const rest = workflows.filter(option => option !== first)
            const chat = offered.filter(option => option.kind === "chat")
            const cancel = offered.filter(option => option.kind === "cancel")
            offered = [...chat, { ...first, label: `${first.label} (suggested)` }, ...rest, ...cancel]
          }
        }
        const record = (choice: string | null, route: string) => persist("notice", {
          text: `Intent route ${JSON.stringify({ classifier: INTENT_CLASSIFIER, class: intent.class, signals: intent.signals,
            offered: offered.map(option => option.label), choice, route })}`,
        })
        if (offered.length === 0) record(null, "chat")
        else {
          const labels = offered.map(option => option.label)
          const picked = await chooseIntentRoute(terminal, `This looks ${intent.class === "architecture" ? "like a design-level change" : "under-specified"}. How should I proceed?`, labels, abort.signal)
          terminal.resume?.()
          if (abort.signal.aborted) return signalExit(receivedSignal)
          const option = picked === undefined ? undefined : offered[picked]
          if (!option || option.kind === "cancel") {
            record(option?.label ?? "Dismissed", "none")
            if (terminal.setDraft) {
              terminal.setDraft(message)
              terminal.write("Cancelled; nothing was sent. Your draft was restored.\n")
            } else terminal.write("Cancelled; nothing was sent.\n")
            continue
          }
          if (option.kind === "workflow") {
            record(option.label, option.descriptor.name)
            const outcome = await workflowHost.start(option.descriptor, intent.body)
            terminal.resume?.()
            if (outcome.quit) return { code: 0 }
            continue
          }
          record(option.label, "chat")
        }
      }
      const turnSelection = selection
      const turnStore: SessionStore | undefined = sessionStore
      const turnEpoch = turnStore?.epoch
      const turnWorkflowSnapshot = JSON.stringify(readAnyWorkflowChecked(worktree))
      const turnSkills = skillSession
      const userFact = persist("user", { text: outbound })
      progress.waiting()
      operationAbort = new AbortController()
      const requestID = `${turnStore?.epoch ?? "read-only"}:request:${++requestSequence}`
      const cancelTurn = () => operationAbort?.abort()
      abort.signal.addEventListener("abort", cancelTurn, { once: true })
      let turn: Awaited<ReturnType<PlanConversation["turn"]>>
      let skillInvocation: SkillConversationInvocation | undefined
      let preparedSkill: PreparedSkillInvocation | undefined
      let skillTool: SkillToolProvider | undefined
      const loadedSkills: Array<{ name: string; contentHash: string }> = []
      // One skill_turn record per turn that offered the skill tool, written exactly once when the turn ends.
      let finishSkillTurn: (outcome: "completed" | "failed" | "cancelled", failure?: string) => void = () => {}
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
        } else if (turnSkills && turnStore && turnSkills.store === turnStore && autoSkillEnabled && !retainedSDKSessionID &&
            !message.startsWith("/") && !hasIntentForcePrefix(message) && skillPolicy?.auto.mode === "auto" &&
            activeAnyWorkflow(worktree) === null && (await autoCandidateWork, autoSkillCandidates.length > 0)) {
          // Model-chosen skills: the main model sees the consent-free catalog and may load entries with the `skill` tool
          // as the conversation calls for them. A load never prompts (consent "never") and is re-checked against the
          // current content and the role's tools; protected workflows are never in the catalog.
          const budget = skillInstructionBudget(turnSelection.runtime.config.delegate.verify_allow, outbound)
          const catalog = autoSkillCandidates.filter(candidate => candidate.bytes <= budget)
          const runtime = turnSelection.runtime
          const sessionID = turnStore.sessionID
          const turnID = `turn-${requestSequence}`
          const requiredTools = autoSkillRequiredTools
          const pendingHashes = new Map<string, string>()
          const turnOffered: string[] = []
          const turnRefused: string[] = []
          const turnWithdrawn: string[] = []
          let turnCatalogDropped = false
          let turnRecorded = false
          // Set by the host's `offered` report: a turn that never reached a host execution (empty catalog, input budget
          // refused before dispatch, a busy conversation) offered nothing and is not a skill-tool turn.
          let turnReached = false
          finishSkillTurn = (outcome, failure) => {
            if (turnRecorded || !turnReached) return
            turnRecorded = true
            recordSkillToolTurn(runtime, {
              sessionID, turnID, offered: turnOffered, catalogDropped: turnCatalogDropped,
              loaded: loadedSkills.map(skill => skill.name), refused: turnRefused, withdrawn: turnWithdrawn, outcome,
              ...(failure ? { failure } : {}),
            })
          }
          skillTool = catalog.length === 0 ? undefined : Object.freeze({
            catalog: Object.freeze(catalog.map(candidate => Object.freeze({ name: candidate.name, description: candidate.description }))),
            query: outbound,
            async load(name: string, signal: AbortSignal) {
              if (selection !== turnSelection || sessionStore !== turnStore || skillSession !== turnSkills || retainedSDKSessionID) {
                recordSkillToolLoad(runtime, sessionID, turnID, name, "superseded")
                return { ok: false as const, error: "Tool refused: the session changed during this turn." }
              }
              try {
                const prepared = await turnSkills.prepare(name, signal, { consent: "never", requiredTools })
                const text = claimPreparedSkillInvocation(prepared).text
                pendingHashes.set(name, prepared.contentHash)
                return { ok: true as const, text }
              } catch {
                recordSkillToolLoad(runtime, sessionID, turnID, name, "refused")
                turnRefused.push(name)
                return { ok: false as const, error: "Tool refused: this skill is not usable without consent right now." }
              }
            },
            delivered(name: string) {
              const contentHash = pendingHashes.get(name)
              if (contentHash === undefined || loadedSkills.some(skill => skill.name === name)) return
              recordSkillToolLoad(runtime, sessionID, turnID, name, "loaded")
              loadedSkills.push({ name, contentHash })
            },
            withdrawn(name: string) {
              const index = loadedSkills.findIndex(skill => skill.name === name)
              if (index < 0) return
              loadedSkills.splice(index, 1)
              turnWithdrawn.push(name)
              recordSkillToolLoad(runtime, sessionID, turnID, name, "withdrawn")
            },
            offered(names: readonly string[], dropped: boolean) {
              turnReached = true
              turnOffered.splice(0, turnOffered.length, ...names)
              turnCatalogDropped = dropped
            },
          })
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
          ? await turnSelection.conversation.turn(outbound, operationAbort.signal, skillInvocation)
          : skillTool
            ? await turnSelection.conversation.turn(outbound, operationAbort.signal, undefined, skillTool)
            : await turnSelection.conversation.turn(outbound, operationAbort.signal)
        if (operationAbort.signal.aborted && !abort.signal.aborted) {
          finishSkillTurn("cancelled")
          requestObservation = { state: "cancellation-unconfirmed", operationID: requestID }
          publishView()
          reportTurnCancellation()
          continue
        }
        finishSkillTurn(abort.signal.aborted ? "cancelled" : "completed")
        requestObservation = { state: "completed", operationID: requestID }
        publishView()
      } catch (error) {
        if (dispatched) {
          if (operationAbort?.signal.aborted || abort.signal.aborted) finishSkillTurn("cancelled")
          else finishSkillTurn("failed", error instanceof ModelRequestError ? error.reason ?? error.category : "other")
        }
        if (dispatched && error instanceof ModelRequestError) {
          requestObservation = {
            state: "failed", operationID: requestID,
            category: { state: "known", value: error.category }, retryable: { state: "unknown" },
          }
          publishView()
          if (modelFailureMayReturnToComposer()) {
            progress.responseReceived()
            const hint = error.category === "model_failed" ? await signInHint(engineSet(turnSelection.engine, turnSelection.routes)) : undefined
            const shown = hint ? `${error.diagnostic} ${hint}` : error.diagnostic
            persist("notice", { text: shown, provenance: "error" })
            if (terminal.writeText) terminal.writeText({ provenance: "error", text: shown })
            else visibleWrite(`[error] ${shown}\n`)
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
      if (loadedSkills.length) {
        // terminal.write persists the notice, so a full-screen transcript reload keeps it.
        terminal.write(`Skills used: ${loadedSkills.map(skill => terminalSafeText(skill.name)).join(", ")} (force: skips skills for one message; /skills auto off for this session)\n`)
      }
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
      for (const skill of loadedSkills) {
        persist("notice", { text: `Skill tool load ${JSON.stringify({ userSeq: userFact?.seq ?? null, assistantSeq: assistantFact?.seq ?? null, name: skill.name, contentHash: skill.contentHash })}` })
      }
      if (turn.plan === undefined) continue
      if (intentClass === "question") {
        // A question is answer-only: a plan in the reply never becomes a pending approval without an explicit /plan.
        terminal.write("The reply contains a plan proposal; send /plan to submit it.\n")
        continue
      }
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
