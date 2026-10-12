import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { createInterface } from "node:readline"
import { activeWorkflow, readWorkflowChecked } from "../flow/state.ts"
import { ledgerPath } from "../state/ledger.ts"
import { createCliRuntime, type CliRuntimeOptions } from "./cli-runtime.ts"
import { inputColorSupported, inputLine, renderInput, type InputPresentation } from "./cli-input.ts"
import { createCliProgressPresenter, type CliProgressTask, type CliTaskStatus } from "./cli-progress.ts"
import { createPlanConversation } from "./plan-conversation.ts"
import { createForegroundController, type ForegroundController } from "./controller.ts"
import { discoverModels as discoverModelCatalog, type ModelCatalog } from "./model-catalog.ts"
import { humanDecision } from "./operator.ts"
import type { OperatorDecision } from "./operator.ts"
import { AdmissionRefusal, assertHostAdmission } from "./required-controls.ts"
import { beginExecutionActivity } from "./runtime.ts"
import { settled } from "./run-state.ts"
import { LinuxAdmissionRefused, type ExecutionRuntime } from "./types.ts"

export type CliEngine = CliRuntimeOptions["engine"]
export type InteractiveArgs = { worktree: string; engine?: CliEngine; model?: string }
export type InteractiveExit = { code: number }

export type Terminal = {
  stdinIsTTY: boolean
  stderrIsTTY: boolean
  presentation?: () => InputPresentation
  readLine: (prompt: string, signal?: AbortSignal) => Promise<string | undefined>
  write: (text: string) => void
  close: () => void
}

type PlanConversation = {
  turn: (text: string, signal?: AbortSignal) => Promise<{ text: string; plan?: unknown }>
}

type SignalName = "SIGINT" | "SIGTERM"
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
  createConversation: (runtime: ExecutionRuntime, sessionID: string) => PlanConversation
  createController: (runtime: ExecutionRuntime) => ForegroundController
  discoverModels: (engine: CliEngine, worktree: string, signal?: AbortSignal) => Promise<ModelCatalog>
  humanDecision: typeof humanDecision
  randomUUID: () => string
  signals: SignalSource
}

function terminalSafeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/g, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`)
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

function boundedTerminalDiagnostic(value: string, limit = 240): string {
  const safe = terminalSafeText(value).replace(/\s+/gu, " ").trim()
  return safe.length > limit ? `${safe.slice(0, limit - 3)}...` : safe
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

function createTerminal(): Terminal {
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
    terminal: createTerminal(),
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
  return { code: signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 0 }
}

function readInput(terminal: Terminal, title: string, hint: string, prompt: string, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve(undefined)
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
  return "Local commands: /help, /model, /model <engine> <native-id>, /cancel, /quit, /exit. /plan remains a planning prompt.\n"
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

export async function launchInteractive(
  args: InteractiveArgs,
  overrides: Partial<InteractiveDependencies> = {},
): Promise<InteractiveExit> {
  const deps = { ...defaultDependencies(), ...overrides }
  const terminal = deps.terminal
  if (!terminal.stdinIsTTY || !terminal.stderrIsTTY) {
    terminal.close()
    throw new InteractiveLaunchError("chat requires an interactive terminal on stdin and stderr")
  }

  const abort = new AbortController()
  const progress = createCliProgressPresenter(text => terminal.write(text))
  let observedTasks: { worktree: string; sessionID: string; ids: string[] } | undefined
  let receivedSignal: SignalName | undefined
  const onSigint = () => { receivedSignal ??= "SIGINT"; progress.cancelRequested(); abort.abort() }
  const onSigterm = () => { receivedSignal ??= "SIGTERM"; progress.cancelRequested(); abort.abort() }
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
    const worktree = canonicalWorktree(args.worktree, deps)
    const engine = args.engine ?? await withProgressSuspended(() => chooseEngine(terminal, abort.signal))
    if (!engine || abort.signal.aborted) return signalExit(receivedSignal)
    const model = args.model ?? await withProgressSuspended(() => chooseModel(terminal, engine, worktree, abort.signal, deps.discoverModels))
    if (!model || abort.signal.aborted) return signalExit(receivedSignal)
    if (!validModelID(model)) throw new InteractiveLaunchError("invalid model ID; enter a native model name without whitespace")

    terminal.write("\nNative CLI limitations: input size is estimated and output limits are reactive; these are not strict guarantees. No process or filesystem containment is claimed.\n\n")
    const initialSessionID = defaultSessionID(deps.randomUUID())
    const initialRuntime = deps.createRuntime({ worktree, engine, model, progress })
    initialRuntime.linuxAdmission?.assertBootEpoch()
    await deps.admitRuntime(initialRuntime)
    if (abort.signal.aborted) return signalExit(receivedSignal)
    let selection = {
      engine,
      model,
      sessionID: initialSessionID,
      runtime: initialRuntime,
      controller: deps.createController(initialRuntime),
      conversation: deps.createConversation(initialRuntime, initialSessionID),
    }
    const usedSessionIDs = new Set([initialSessionID])
    terminal.write(selectionBanner(worktree, selection.engine, selection.model, terminal.presentation?.()))

    function acquireSwitchGuard(): { release?: () => void; refusal?: string } {
      const release = beginExecutionActivity(selection.runtime, selection.sessionID, "review")
      if (!release) return { refusal: "Model switch refused: another local execution is still active.\n" }
      try {
        const workflowState = readWorkflowChecked(worktree)
        if (workflowState.corrupt) {
          release()
          return { refusal: "Model switch refused: workflow state is corrupt and must be inspected first.\n" }
        }
        if (activeWorkflow(worktree)) {
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

    async function switchSelection(nextEngine: CliEngine, nextModel: string): Promise<boolean> {
      if (nextEngine === selection.engine && nextModel === selection.model) {
        terminal.write("Already using that engine and model; conversation context is unchanged.\n")
        return true
      }
      const guard = acquireSwitchGuard()
      if (!guard.release) {
        terminal.write(guard.refusal ?? "Model switch refused; current selection is unchanged.\n")
        return true
      }
      try {
        const sessionID = defaultSessionID(deps.randomUUID())
        if (usedSessionIDs.has(sessionID)) throw new Error("new conversation identity was not unique")
        const runtime = deps.createRuntime({ worktree, engine: nextEngine, model: nextModel, progress })
        runtime.linuxAdmission?.assertBootEpoch()
        await deps.admitRuntime(runtime)
        if (abort.signal.aborted) return false
        const controller = deps.createController(runtime)
        const conversation = deps.createConversation(runtime, sessionID)
        if (abort.signal.aborted) return false
        selection = { engine: nextEngine, model: nextModel, sessionID, runtime, controller, conversation }
        usedSessionIDs.add(sessionID)
        terminal.write(selectionBanner(worktree, selection.engine, selection.model, terminal.presentation?.(), true))
      } catch (error) {
        if (!(error instanceof AdmissionRefusal) && !(error instanceof TypeError)) throw error
        if (abort.signal.aborted) return false
        terminal.write("Model switch failed; the current selection and conversation are unchanged.\n")
      } finally {
        guard.release()
      }
      return true
    }

    while (!abort.signal.aborted) {
      const text = await withProgressSuspended(() => readInput(
        terminal, `${selection.engine} · ${selection.model}`,
        "Enter send · /help commands · /model switch · /quit exit", "You> ", abort.signal,
      ))
      if (abort.signal.aborted) return signalExit(receivedSignal)
      if (text === undefined) return { code: 0 }
      const message = text.trim()
      if (!message) continue
      if (message === "/quit" || message === "/exit") return { code: 0 }
      if (message === "/cancel") {
        progress.cancelRequested()
        abort.abort()
        return { code: 0 }
      }

      const [command, ...commandArgs] = message.split(/\s+/u)
      if (command === "/help" && commandArgs.length === 0) {
        terminal.write(helpText())
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
      if (message.startsWith("/") && command !== "/plan") {
        terminal.write("Unknown local command. Enter /help for usage.\n")
        continue
      }

      progress.waiting()
      const turn = await selection.conversation.turn(message, abort.signal)
      progress.responseReceived()
      if (abort.signal.aborted) return signalExit(receivedSignal)
      if (turn.text) terminal.write(terminalSafeText(`\nConversation:\n${turn.text}\n`))
      if (turn.plan === undefined) continue

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
      terminal.write(terminalSafeText(
        `\n[approval] Inspect the canonical plan below before deciding.\n\nCanonical plan (${workflow.planRef?.mdPath ?? "saved plan"}):\n${submitted.renderedPlan}\nPlan SHA: ${submitted.planSha}\n`,
      ))
      progress.suspend()
      terminal.close()
      if (abort.signal.aborted) return signalExit(receivedSignal)
      // The real operator reader owns process.stdin while it waits for a decision.
      // Do not swallow process signals with this session's abort listeners during that prompt.
      if (sigintRegistered) {
        deps.signals.off("SIGINT", onSigint)
        sigintRegistered = false
      }
      if (sigtermRegistered) {
        deps.signals.off("SIGTERM", onSigterm)
        sigtermRegistered = false
      }
      const decision: OperatorDecision = await deps.humanDecision("choose", workflow.id, submitted.planSha)
      progress.resume()
      if (!abort.signal.aborted) {
        deps.signals.on("SIGINT", onSigint)
        sigintRegistered = true
        deps.signals.on("SIGTERM", onSigterm)
        sigtermRegistered = true
      }
      if (abort.signal.aborted) return signalExit(receivedSignal)
      const decided = selection.controller.decide(decision)
      if (!decided.ok) throw new InteractiveLaunchError("local plan decision could not be applied; inspect read-only status")
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
      const currentTasks = readProgressTasks(worktree, selection.sessionID, taskIDs) ??
        taskIDs.map(id => ({ id, status: "pending" as const }))
      progress.tasks(currentTasks.map((task, index) => ({ ...task, title: taskTitles[index] ?? "" })), approvedTasks.total)
      const result = await selection.controller.run(selection.sessionID, abort.signal)
      const finalTasks = readProgressTasks(worktree, selection.sessionID, taskIDs)
      if (finalTasks) progress.taskSnapshot(finalTasks)
      progress.final({
        workflowID: result.workflow.id,
        phase: result.workflow.phase,
        done: result.run.done,
        failed: result.run.failed,
        cancelled: result.run.cancelled,
        ...(result.run.skipped ? { skipped: result.run.skipped } : {}),
      })
      if (receivedSignal) return signalExit(receivedSignal)
      return { code: result.workflow.phase === "done" && result.run.failed === 0 && result.run.cancelled === 0 ? 0 : 1 }
    }
    return signalExit(receivedSignal)
  } catch (error) {
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
    terminal.close()
    if (sigintRegistered) deps.signals.off("SIGINT", onSigint)
    if (sigtermRegistered) deps.signals.off("SIGTERM", onSigterm)
  }
}
