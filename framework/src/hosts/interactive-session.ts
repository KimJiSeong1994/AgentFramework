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
import { createPlanConversation, type ConversationMessage, type ConversationTurn, type SkillConversationInvocation } from "./plan-conversation.ts"
import { PROTECTED_WORKFLOWS, resolveSkillRoots } from "../skills/roots.ts"
import { SkillSession, type PreparedSkillInvocation, type SkillCatalog } from "../skills/session.ts"
import { attachAdmission, detachAdmission, effectiveHold, holdAdmission, resumeAdmission } from "../sessions/admission.ts"
import { inspectSessions, readSessionMetadata, replaySession, type SessionStore, type ReplayOptions, type ReplayResult, type TranscriptKind } from "../sessions/store.ts"
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
import { beginExecutionActivity } from "./runtime.ts"
import { settled, type ExecutionRunStatus } from "./run-state.ts"
import { LinuxAdmissionRefused, type ExecutionRuntime } from "./types.ts"

export type CliEngine = CliRuntimeOptions["engine"]
export type InteractiveArgs = { worktree: string; engine?: CliEngine; model?: string }
export type InteractiveExit = { code: number }
export type TerminalControl = "cancel" | "pause" | "shutdown" | "quit" | "disconnect" | "suspend"

export type Terminal = {
  stdinIsTTY: boolean
  stderrIsTTY: boolean
  fullscreen?: boolean
  presentation?: () => InputPresentation
  readInput?: (input: { title: string; hint: string; prompt: string; kind: "chat" | "selection" }, signal: AbortSignal) => Promise<string | undefined>
  choose?: (title: string, choices: readonly string[], signal: AbortSignal) => Promise<number | undefined>
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
  transcriptSource?: (source: (options: ReplayOptions) => ReplayResult) => void
  draftSnapshot?: () => { draft: string; queued: string[] }
  suspend?: () => void
  resume?: () => void
  readLine: (prompt: string, signal?: AbortSignal) => Promise<string | undefined>
  write: (text: string) => void
  close: () => void
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

export class InteractiveLaunchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InteractiveLaunchError"
  }
}

export function validModelID(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.startsWith("-") && value.trim() === value &&
    !/[\\\s\u0000-\u001f\u007f]/u.test(value)
}

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
    readLine(prompt, signal) {
      if (signal?.aborted) return Promise.resolve(undefined)
      reader ??= createInterface({ input: process.stdin, output: process.stderr, terminal: process.stderr.isTTY === true })
      return new Promise((resolveLine) => {
        let settled = false
        const finish = (line: string | undefined) => {
          if (settled) return
          settled = true
          reader?.off("line", onLine)
          reader?.off("close", onClose)
          reader?.off("SIGINT", onReadlineInterrupt)
          signal?.removeEventListener("abort", onAbort)
          resolveLine(line)
        }
        const onLine = (line: string) => finish(line)
        const onClose = () => finish(undefined)
        const onReadlineInterrupt = () => finish(undefined)
        const onAbort = () => finish(undefined)
        reader!.once("line", onLine)
        reader!.once("close", onClose)
        reader!.once("SIGINT", onReadlineInterrupt)
        signal?.addEventListener("abort", onAbort, { once: true })
        if (signal?.aborted) return finish(undefined)
        reader!.setPrompt(prompt)
        reader!.prompt()
      })
    },
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
      reader?.close()
      reader = undefined
    },
  }
  return terminal
}

function defaultDependencies(): InteractiveDependencies {
  return {
    cwd: process.cwd(),
    terminal: createReadlineTerminal(),
    gitTopLevel: defaultGitTopLevel,
    createRuntime: (options) => createCliRuntime(options),
    admitRuntime: async (runtime) => {
      assertHostAdmission(await runtime.host.preflight(runtime.host.identity.profile), runtime.host.identity.controlProfile)
    },
    createConversation: (runtime, sessionID) => createPlanConversation(runtime, sessionID),
    createController: createForegroundController,
    discoverModels: discoverModelCatalog,
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

async function chooseEngine(terminal: Terminal, signal: AbortSignal): Promise<CliEngine | undefined> {
  const menu = "Choose an execution engine:\n  1) local  — Ollama CLI\n  2) codex  — Codex CLI\n  3) claude — Claude CLI\n"
  terminal.write(menu.trimEnd().split("\n").map(line => inputLine(line, terminal.presentation?.())).join("\n") + "\n")
  while (!signal.aborted) {
    const answer = await readInput(terminal, "Engine selection", "Enter a number or engine name", "Engine [1-3]: ", signal)
    if (answer === undefined || signal.aborted) return undefined
    const normalized = answer.trim().toLowerCase()
    if (normalized === "1" || normalized === "local") return "local"
    if (normalized === "2" || normalized === "codex") return "codex"
    if (normalized === "3" || normalized === "claude") return "claude"
    terminal.write("Choose local, codex, or claude (1, 2, or 3).\n")
  }
  return undefined
}

async function chooseModel(
  terminal: Terminal,
  engine: CliEngine,
  worktree: string,
  signal: AbortSignal,
  discoverModels: InteractiveDependencies["discoverModels"],
): Promise<string | null | undefined> {
  let catalog: ModelCatalog
  try {
    catalog = await discoverModels(engine, worktree, signal)
  } catch {
    if (signal.aborted) return undefined
    catalog = { models: [], notice: "Model discovery was unavailable." }
  }
  if (signal.aborted) return undefined
  const models = Array.isArray(catalog?.models)
    ? catalog.models.filter(model => !!model && validModelID(model.id) && typeof model.label === "string")
    : []
  const notice = typeof catalog?.notice === "string" ? catalog.notice : ""
  const presentation = terminal.presentation?.()
  const menu = [
    models.length ? `Model choices for ${engine}:` : `No model choices were discovered for ${engine}.`,
    ...models.map((model, index) => `  ${index + 1}) ${model.label} — ${model.id}`),
    ...(notice ? [notice] : []),
    "Select a number or native model ID; id:<ID> for numeric IDs.",
    "Empty input or /cancel cancels selection. No default is selected.",
  ]
  terminal.write(menu.map(line => inputLine(line, presentation)).join("\n") + "\n")
  while (!signal.aborted) {
    const prompt = models.length ? `Model [1-${models.length} or native ID]: ` : "Model [native ID]: "
    const answer = await readInput(terminal, `Model selection · ${engine}`, "Enter select · /cancel back · no default", prompt, signal)
    if (answer === undefined || signal.aborted) return undefined
    if (answer.trim() === "" || answer.trim() === "/cancel") return null
    if (/^[0-9]+$/u.test(answer)) {
      const index = Number(answer)
      if (index >= 1 && index <= models.length) return models[index - 1]!.id
      terminal.write("Invalid model choice; select a listed number or enter a native model ID.\n")
      continue
    }
    const nativeID = answer.startsWith("id:") ? answer.slice(3) : answer
    if (validModelID(nativeID)) return nativeID
    terminal.write("Invalid model ID; use a non-empty native name without whitespace.\n")
  }
  return undefined
}

function selectionBanner(worktree: string, engine: CliEngine, model: string, presentation?: InputPresentation, reset = false): string {
  return "\n" + [
    "Native execution selection:",
    `  Engine: ${engine}`,
    `  Model: ${model}`,
    `  Worktree: ${worktree}`,
    ...(reset ? ["  Conversation context reset after model switch."] : []),
  ].map(line => inputLine(line, presentation)).join("\n") + "\n\n"
}

function helpText(): string {
  return "Local commands: /help, /model, /model <engine> <native-id>, /sessions, /resume <sid>, /new, /status, /continue, /pause, /cancel, /skills, /skills grants, /skills revoke <name>, /skill:<name> [request], /skill:deep-interview <request>, /skill:ralplan <request>, /skill:ultragoal <objective>, /skill:autoresearch <mission> (LCA workflows; /finish ends an interview early), /quit, /exit. TUI: /search <tool/status/task>, /search clears, /expand <item number>, PageUp/PageDown scroll. /plan remains a planning prompt.\n"
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
    lines.push(`  /skill:${descriptor.name} · ${descriptor.source} · ${classification}${description ? ` · ${description}` : ""}${scope}${refusal}`)
  }
  for (const refusal of catalog.refusals) {
    const name = refusal.name ? ` ${boundedTerminalDiagnostic(refusal.name, 120)}` : ""
    lines.push(`  Refused ${refusal.source}${name} · ${refusal.reason}`)
  }
  if (!catalog.entries.length && !catalog.refusals.length) lines.push("  No skills or protected workflows were discovered.")
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
  let persistenceFailure: unknown
  const visibleWrite = terminal.write.bind(terminal)
  const persist = (kind: TranscriptKind, data: Record<string, unknown>, eventID?: string) => {
    if (persistenceFailure) throw persistenceFailure
    if (!sessionStore) return undefined
    try { return sessionStore.append(kind, data, eventID) }
    catch (error) { persistenceFailure = error; abort.abort(); throw error }
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
      catch (error) { persistenceFailure = error; abort.abort(); throw error }
    }
    terminal.activity?.(activity)
  }, { toolLines: !terminal.activity })
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
    try { progress.cancelRequested() } catch (error) { persistenceFailure ??= error }
    abort.abort()
  }
  const onSigint = () => signalCancel("SIGINT")
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
  terminal.controls?.(action => {
    if (action === "shutdown") onSigint()
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
        const candidate = await SkillSession.create({ roots, store, terminal: skillTerminal }, abort.signal)
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
    const engine = args.engine ?? await withProgressSuspended(() => chooseEngine(terminal, abort.signal))
    if (!engine || abort.signal.aborted) return signalExit(receivedSignal)
    const model = args.model ?? await withProgressSuspended(() => chooseModel(terminal, engine, worktree, abort.signal, deps.discoverModels))
    if (!model || abort.signal.aborted) return signalExit(receivedSignal)
    if (!validModelID(model)) throw new InteractiveLaunchError("invalid model ID; enter a native model name without whitespace")

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
    const usedSessionIDs = new Set([initialSessionID])
    terminal.bindSession?.(initialSessionID)
    terminal.transcriptSource?.(options => replaySession(worktree, initialSessionID, options))
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
    terminal.write(selectionBanner(worktree, selection.engine, selection.model, terminal.presentation?.()))

    async function runOwned(resumed: boolean) {
      if (persistenceFailure) throw persistenceFailure
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
            if (pairs.length === 48) return pairs
          }
        }
        if (replay.nextOffset === undefined) return pairs
        if (replay.nextOffset <= offset) throw new InteractiveLaunchError("Session replay did not advance; work remains held.")
        offset = replay.nextOffset
      }
    }

    async function decidePlan(workflow: Workflow, planSha: string, renderedPlan: string, parsedPlan: unknown): Promise<InteractiveExit | undefined> {
      terminal.write(terminalSafeText(
        `\n[approval] Inspect the canonical plan below before deciding.\n\nCanonical plan (${workflow.planRef?.mdPath ?? "saved plan"}):\n${renderedPlan}\nPlan SHA: ${planSha}\n`,
      ))
      const chosen = terminal.choose ? await terminal.choose("Execution decision", ["Approve", "Reject", "Keep pending"], abort.signal) : undefined
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
        terminal.write(terminalSafeText(`Workflow ${workflow.id} rejected; execution was not started.\n`))
        return { code: 0 }
      }
      if (decision.action !== "approve") return { code: 1 }
      if (abort.signal.aborted) return signalExit(receivedSignal)
      const approvedTasks = approvedTaskIDs(decided.wf.taskIds)
      const taskIDs = approvedTasks.ids
      const taskTitles = approvedPlanTitles(parsedPlan)
      observedTasks = { worktree, sessionID: selection.sessionID, ids: taskIDs }
      const currentTasks = readProgressTasks(worktree, selection.sessionID, taskIDs) ?? taskIDs.map(id => ({ id, status: "pending" as const }))
      progress.tasks(currentTasks.map((task, index) => ({ ...task, title: taskTitles[index] ?? "" })), approvedTasks.total)
      terminal.taskSnapshot?.(currentTasks)
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

    async function switchSelection(nextEngine: CliEngine, nextModel: string, targetSessionID?: string, forceNew = false): Promise<boolean> {
      if (!forceNew && !targetSessionID && nextEngine === selection.engine && nextModel === selection.model) {
        terminal.write("Already using that engine and model; conversation context is unchanged.\n")
        return true
      }
      const guard = acquireSwitchGuard(targetSessionID !== undefined || retainedSDKSessionID !== undefined)
      if (!guard.release) {
        terminal.write(guard.refusal ?? "Model switch refused; current selection is unchanged.\n")
        return true
      }
      try {
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
        const conversation = deps.createConversation(runtime, sessionID, retained ? restoredConversation(sessionID) : undefined)
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
        nextProgress.bind(nextStore)
        attachedRuntime = runtime
        retainedSDKSessionID = undefined
        selection = { engine: nextEngine, model: nextModel, sessionID, runtime, controller, conversation }
        usedSessionIDs.add(sessionID)
        terminal.bindSession?.(sessionID)
        terminal.transcriptSource?.(options => replaySession(worktree, sessionID, options))
        await bindSkillSession(nextStore)
        if (abort.signal.aborted) return false
        terminal.write(selectionBanner(worktree, selection.engine, selection.model, terminal.presentation?.(), true))
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
        terminal.executionSnapshot?.({ generation: 0, executions: [] }, false)
        terminal.taskSnapshot?.([])
        terminal.bindSession?.(sessionID)
        terminal.transcriptSource?.(options => replaySession(worktree, sessionID, options))
        terminal.write(`Retained SDK session ${sessionID} · read-only history\n`)
      } catch (error) {
        terminal.write(`Session restore refused: ${boundedTerminalDiagnostic(String(error))}\n`)
      } finally {
        guard?.release?.()
      }
      return true
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
      if (persistenceFailure) throw persistenceFailure
      if (retainedSDKSessionID) {
        terminal.queueAdmission?.(false)
      } else {
        workflowHost.syncStatus()
        const queueState = selection.runtime.runs.status()
        terminal.executionSnapshot?.(queueState, false)
        terminal.queueAdmission?.(!effectiveHold(worktree, selection.sessionID) && !readAnyWorkflowChecked(worktree).corrupt && !activeAnyWorkflow(worktree) && !queueState.claim && queueState.executions.every(settled))
      }
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

      if (retainedSDKSessionID) {
        const sessionID = retainedSDKSessionID
        const [command, ...commandArgs] = message.split(/\s+/u)
        if (command === "/quit" || command === "/exit") return { code: 0 }
        if (command === "/help" && commandArgs.length === 0) {
          terminal.write(helpText())
          continue
        }
        if (command === "/sessions" && commandArgs.length === 0) {
          for (const session of inspectSessions(worktree)) {
            terminal.write(`${session.sessionID} · ${session.engine} ${session.model ?? ""} · ${session.corrupt ? "corrupt; read-only" : session.held ? "held" : "retained"}\n`)
          }
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
          const target = commandArgs[0]!
          if (target === sessionID) {
            terminal.write(`Already viewing retained SDK session ${sessionID}; it remains read-only.\n`)
            continue
          }
          let saved: ReturnType<typeof readSessionMetadata>
          try { saved = readSessionMetadata(worktree, target) }
          catch (error) {
            terminal.write(`Session restore refused: ${boundedTerminalDiagnostic(String(error))}\n`)
            continue
          }
          if (!saved) {
            terminal.write("Session restore refused: retained LCA history is unavailable.\n")
            continue
          }
          if (saved.engine === "opencode") {
            await switchToRetainedSDKSession(target)
            continue
          }
          if (!["local", "codex", "claude"].includes(saved.engine) || !saved.model) {
            terminal.write("Session restore refused: no compatible saved CLI selection.\n")
            continue
          }
          if (!await switchSelection(saved.engine as CliEngine, saved.model, target)) return signalExit(receivedSignal)
          continue
        }
        terminal.write(`Retained SDK session ${sessionID} is read-only; command or message was not applied.\n`)
        continue
      }

      if (message === "/quit" || message === "/exit") return { code: 0 }
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
      if (command === "/help" && commandArgs.length === 0) {
        terminal.write(helpText())
        continue
      }
      if (command === "/sessions" && commandArgs.length === 0) {
        for (const session of inspectSessions(worktree)) {
          terminal.write(`${session.sessionID} · ${session.engine} ${session.model ?? ""} · ${session.corrupt ? "corrupt; read-only" : session.held ? "held" : "retained"}\n`)
        }
        continue
      }
      if (command === "/skills") {
        if (commandArgs[0] === "grants" && commandArgs.length === 1) {
          if (!skillSession) visibleWrite("Skill grants unavailable in this session.\n")
          else {
            const grants = skillSession.listGrants()
            const grantSessionID = skillSession.store.sessionID
            visibleWrite(grants.length ? grants.map(grant =>
              `${terminalSafeText(grantSessionID)} · ${terminalSafeText(grant.name)} · ${grant.source} · ${grant.classification} · ${grant.contentHash} · ${grant.allowedTools?.join(", ") ?? "current role tools"}`,
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
        const sessionID = commandArgs[0]!
        if (sessionID === selection.sessionID) {
          terminal.write("Already in this session; /continue requests an explicit work Resume.\n")
          continue
        }
        try {
          const saved = readSessionMetadata(worktree, sessionID)
          if (saved?.engine === "opencode") {
            if (!await switchToRetainedSDKSession(sessionID)) return signalExit(receivedSignal)
            continue
          }
          if (!saved || !["local", "codex", "claude"].includes(saved.engine) || !saved.model) {
            terminal.write("Session restore refused: no compatible saved CLI selection.\n")
            continue
          }
          if (!await switchSelection(saved.engine as CliEngine, saved.model, sessionID)) return signalExit(receivedSignal)
        } catch (error) {
          if (!sessionStore) throw error
          terminal.write(`Session restore refused: ${boundedTerminalDiagnostic(String(error))}\n`)
        }
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
      if (command === "/model") {
        if (commandArgs.length === 0) {
          terminal.write(inputLine(`Current selection: ${selection.engine} ${selection.model}`, terminal.presentation?.()) + "\n")
          const guard = acquireSwitchGuard()
          if (!guard.release) {
            terminal.write(guard.refusal ?? "Model switch refused; current selection is unchanged.\n")
            continue
          }
          guard.release()
          const nextModel = await withProgressSuspended(() => chooseModel(terminal, selection.engine, worktree, abort.signal, deps.discoverModels))
          if (abort.signal.aborted) return signalExit(receivedSignal)
          if (nextModel === undefined) return { code: 0 }
          if (nextModel === null) continue
          if (!await switchSelection(selection.engine, nextModel)) return signalExit(receivedSignal)
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
      const turnSkills = skillSession
      const userFact = persist("user", { text: message })
      progress.waiting()
      operationAbort = new AbortController()
      const cancelTurn = () => operationAbort?.abort()
      abort.signal.addEventListener("abort", cancelTurn, { once: true })
      let turn: Awaited<ReturnType<PlanConversation["turn"]>>
      let skillInvocation: SkillConversationInvocation | undefined
      let preparedSkill: PreparedSkillInvocation | undefined
      let dispatched = false
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
        turn = skillInvocation
          ? await turnSelection.conversation.turn(message, operationAbort.signal, skillInvocation)
          : await turnSelection.conversation.turn(message, operationAbort.signal)
        if (operationAbort.signal.aborted && !abort.signal.aborted) {
          reportTurnCancellation()
          continue
        }
      } catch (error) {
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
        visibleWrite(terminalSafeText(`\nConversation:\n${turn.text}\n`))
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
    if (persistenceFailure) throw persistenceFailure
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
        if (drafts && !persistenceFailure) persist("notice", drafts)
        await detachAdmission(attachedRuntime, sessionStore.sessionID, sessionStore.epoch, receivedSignal ?? "terminal_exit")
      } catch (error) {
        visibleWrite(`Session cleanup remains held: ${boundedTerminalDiagnostic(String(error))}\n`)
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
