import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { accessSync, constants, realpathSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { createInterface } from "node:readline"
import { activeWorkflow } from "../flow/state.ts"
import { createCliRuntime, type CliRuntimeOptions } from "./cli-runtime.ts"
import { createPlanConversation } from "./plan-conversation.ts"
import { createForegroundController, type ForegroundController } from "./controller.ts"
import { humanDecision } from "./operator.ts"
import type { OperatorDecision } from "./operator.ts"
import { AdmissionRefusal } from "./required-controls.ts"
import { LinuxAdmissionRefused, type ExecutionRuntime } from "./types.ts"

export type CliEngine = CliRuntimeOptions["engine"]
export type InteractiveArgs = { worktree: string; engine?: CliEngine; model?: string }
export type InteractiveExit = { code: number }

export type Terminal = {
  stdinIsTTY: boolean
  stderrIsTTY: boolean
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
  createConversation: (runtime: ExecutionRuntime, sessionID: string) => PlanConversation
  createController: (runtime: ExecutionRuntime) => ForegroundController
  humanDecision: typeof humanDecision
  randomUUID: () => string
  signals: SignalSource
}

function terminalSafeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/g, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`)
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
    createRuntime: ({ worktree, engine, model }) => createCliRuntime({ worktree, engine, model }),
    createConversation: (runtime, sessionID) => createPlanConversation(runtime, sessionID),
    createController: createForegroundController,
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

async function chooseEngine(terminal: Terminal, signal: AbortSignal): Promise<CliEngine | undefined> {
  const menu = "Choose an execution engine:\n  1) local  — Ollama CLI\n  2) codex  — Codex CLI\n  3) claude — Claude CLI\n"
  while (!signal.aborted) {
    const answer = await terminal.readLine(`${menu}Engine [1-3]: `, signal)
    if (answer === undefined || signal.aborted) return undefined
    const normalized = answer.trim().toLowerCase()
    if (normalized === "1" || normalized === "local") return "local"
    if (normalized === "2" || normalized === "codex") return "codex"
    if (normalized === "3" || normalized === "claude") return "claude"
    terminal.write("Choose local, codex, or claude (1, 2, or 3).\n")
  }
  return undefined
}

async function chooseModel(terminal: Terminal, signal: AbortSignal): Promise<string | undefined> {
  terminal.write("Enter a native model ID; no provider/model prefix or default model is selected.\n")
  while (!signal.aborted) {
    const answer = await terminal.readLine("Model ID: ", signal)
    if (answer === undefined || signal.aborted) return undefined
    if (validModelID(answer)) return answer
    terminal.write("Invalid model ID; use a non-empty name without whitespace.\n")
  }
  return undefined
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
  let receivedSignal: SignalName | undefined
  const onSigint = () => { receivedSignal ??= "SIGINT"; abort.abort() }
  const onSigterm = () => { receivedSignal ??= "SIGTERM"; abort.abort() }
  let sigintRegistered = false
  let sigtermRegistered = false
  try {
    deps.signals.on("SIGINT", onSigint)
    sigintRegistered = true
    deps.signals.on("SIGTERM", onSigterm)
    sigtermRegistered = true
    const worktree = canonicalWorktree(args.worktree, deps)
    const engine = args.engine ?? await chooseEngine(terminal, abort.signal)
    if (!engine || abort.signal.aborted) return signalExit(receivedSignal)
    const model = args.model ?? await chooseModel(terminal, abort.signal)
    if (!model || abort.signal.aborted) return signalExit(receivedSignal)
    if (!validModelID(model)) throw new InteractiveLaunchError("invalid model ID; enter a native model name without whitespace")

    terminal.write("\nNative CLI limitations: input size is estimated and output limits are reactive; these are not strict guarantees. No process or filesystem containment is claimed.\n\n")
    const sessionID = defaultSessionID(deps.randomUUID())
    const runtime = deps.createRuntime({ worktree, engine, model })
    runtime.linuxAdmission?.assertBootEpoch()
    const controller = deps.createController(runtime)
    const conversation = deps.createConversation(runtime, sessionID)

    while (!abort.signal.aborted) {
      const text = await terminal.readLine("You> ", abort.signal)
      if (abort.signal.aborted) return signalExit(receivedSignal)
      if (text === undefined) return { code: 0 }
      const message = text.trim()
      if (!message) continue
      if (message === "/quit" || message === "/exit") return { code: 0 }
      if (message === "/cancel") {
        abort.abort()
        return { code: 0 }
      }

      const turn = await conversation.turn(message, abort.signal)
      if (abort.signal.aborted) return signalExit(receivedSignal)
      if (turn.text) terminal.write(terminalSafeText(`\n${turn.text}\n`))
      if (turn.plan === undefined) continue

      const parsedPlan = planForImport(turn.plan, worktree)
      try {
        controller.validateImportedPlan(parsedPlan, sessionID)
      } catch (error) {
        const feedback = planValidationFeedback(error)
        if (feedback === undefined) throw error
        terminal.write(terminalSafeText(feedback))
        continue
      }
      if (abort.signal.aborted) return signalExit(receivedSignal)
      const submitted = await controller.importPlan(sessionID, "", abort.signal, parsedPlan)
      if (abort.signal.aborted) return signalExit(receivedSignal)
      if (!submitted.result.ok) {
        terminal.write(terminalSafeText(`Plan was not approved for execution: ${submitted.result.text}\n`))
        return { code: 1 }
      }
      if (submitted.result.wf.phase !== "pending_approval") {
        terminal.write(terminalSafeText(`Plan did not reach pending approval (workflow ${submitted.result.wf.phase}); no execution was started.\n`))
        return { code: 1 }
      }
      if (!submitted.renderedPlan) {
        terminal.write("Canonical plan rendering is unavailable; no execution was started.\n")
        return { code: 1 }
      }

      const workflow = submitted.result.wf
      terminal.write(terminalSafeText(
        `\nCanonical plan (${workflow.planRef?.mdPath ?? "saved plan"}):\n${submitted.renderedPlan}\nPlan SHA: ${submitted.planSha}\n`,
      ))
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
      if (!abort.signal.aborted) {
        deps.signals.on("SIGINT", onSigint)
        sigintRegistered = true
        deps.signals.on("SIGTERM", onSigterm)
        sigtermRegistered = true
      }
      if (abort.signal.aborted) return signalExit(receivedSignal)
      const decided = controller.decide(decision)
      if (!decided.ok) throw new InteractiveLaunchError("local plan decision could not be applied; inspect read-only status")
      if (decision.action === "reject") {
        terminal.write(terminalSafeText(`Workflow ${workflow.id} rejected; execution was not started.\n`))
        return { code: 0 }
      }
      if (decision.action !== "approve") return { code: 1 }
      if (abort.signal.aborted) return signalExit(receivedSignal)
      const result = await controller.run(sessionID, abort.signal)
      terminal.write(terminalSafeText(
        `Workflow ${result.workflow.id} ${result.workflow.phase}; done ${result.run.done}, failed ${result.run.failed}, cancelled ${result.run.cancelled}${result.run.skipped ? `; ${result.run.skipped}` : ""}\n`,
      ))
      if (receivedSignal) return signalExit(receivedSignal)
      return { code: result.workflow.phase === "done" && result.run.failed === 0 && result.run.cancelled === 0 ? 0 : 1 }
    }
    return signalExit(receivedSignal)
  } catch (error) {
    if (abort.signal.aborted && !(error instanceof AdmissionRefusal) && !(error instanceof LinuxAdmissionRefused)) {
      return signalExit(receivedSignal)
    }
    throw error
  } finally {
    terminal.close()
    if (sigintRegistered) deps.signals.off("SIGINT", onSigint)
    if (sigtermRegistered) deps.signals.off("SIGTERM", onSigterm)
  }
}
