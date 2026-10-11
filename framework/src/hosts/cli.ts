#!/usr/bin/env bun
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { loadConfig } from "../config.ts"
import { readWorkflow } from "../flow/state.ts"
import type { HookDeps } from "../hooks/types.ts"
import { getOpenCodeRuntime } from "./opencode-runtime.ts"
import { createForegroundController, readForegroundStatus } from "./controller.ts"
import { humanDecision } from "./operator.ts"
import { createCliRuntime } from "./cli-runtime.ts"
import type { CliEngine } from "./cli-transport.ts"
import { AdmissionRefusal, assertHostAdmission } from "./required-controls.ts"
import { LinuxAdmissionRefused } from "./types.ts"
import { InteractiveLaunchError, launchInteractive, parseInteractiveArgs } from "./interactive.ts"

const COMMANDS = new Set(["status", "import", "approve", "reject", "run", "resume", "cancel"])
const COMMON_RECOVERY_COMMANDS = new Set(["approve", "reject", "resume", "cancel"])
type CliArgs = { command: string; worktree: string; server?: string; session?: string; plan?: string; workflow?: string; sha?: string; engine: "opencode" | CliEngine; model?: string; json: boolean }

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CliUsageError"
  }
}

const CLI_USAGE = `Usage:
  lca [chat] [--worktree PATH] [--engine local|codex|claude] [--model ID]
  lca <command> --worktree PATH [options]

Interactive chat:
  lca
  lca chat [--worktree PATH] [--engine local|codex|claude] [--model ID]

Bare 'lca' and 'lca chat' start LCA's interactive terminal in the current Git worktree,
or in the canonical worktree selected by --worktree. Choose an engine from the menu, or
specify --engine. Enter a native model ID or supply --model; local selects the Ollama CLI,
not OpenCode. Plans require a separate local human approval.

Commands:
  status   --worktree PATH [--session ID] [--json]
  import   --worktree PATH --server URL --session ID --plan PATH
  approve  --worktree PATH --server URL --workflow ID --sha SHA
  reject   --worktree PATH --server URL --workflow ID --sha SHA
  run      --worktree PATH --server URL (--plan PATH | --session ID)
  resume   --worktree PATH --server URL --session ID
  cancel   --worktree PATH --server URL --session ID

Common-engine workflow recovery (no server; exact original engine, model and session required):
  approve  --worktree PATH --engine local|codex|claude --model ID --session ID --workflow ID --sha SHA
  reject   --worktree PATH --engine local|codex|claude --model ID --session ID --workflow ID --sha SHA
  resume   --worktree PATH --engine local|codex|claude --model ID --session ID
  cancel   --worktree PATH --engine local|codex|claude --model ID --session ID

Status reads local workflow state without an engine or server. OpenCode mutations still require the local service.

Examples:
  lca status --worktree /path/to/repo
  lca status --worktree /path/to/repo --json
  lca run --plan plan.json --worktree /path/to/repo --server http://127.0.0.1:4096
  lca resume --worktree /path/to/repo --engine codex --model gpt-5.6-sol --session SESSION_ID

Prerequisites and safety:
  The --worktree path must name an accessible directory. OpenCode mutations require an already-running,
  trusted local service and the project's LCA plugin. Common-engine recovery requires the exact original
  engine, model and session; unresolved execution ownership is refused without replay or forced release.
  Common-engine approve and reject require a local interactive terminal for explicit human decisions.
  Standalone commands do not start a server.
  Interactive chat requires a terminal on stdin and stderr; EOF or interruption never approves a plan.
  Native CLI input limits are estimated and output limits are reactive, not strict guarantees; no process
  or filesystem containment is claimed. Plans are never auto-approved. Host admission refuses when
  required control evidence is unavailable; the CLI does not expose raw vendor preflight diagnostics.

Run 'lca --help' for this usage. Exit codes: 0 success/help, 1 runtime refusal or failure,
2 invalid arguments or inaccessible worktree, 3 Linux admission refusal.`

export function parseCliArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv
  if (!command) throw new CliUsageError("missing command; see 'lca --help'")
  if (!COMMANDS.has(command)) throw new CliUsageError("unknown command; see 'lca --help' for supported commands")
  const fields: Record<string, string> = {}
  let json = false
  const allowed = new Set(["--worktree", "--server", "--session", "--plan", "--workflow", "--sha", "--engine", "--model"])
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!
    if (flag === "--json") {
      if (json) throw new CliUsageError("duplicate --json option")
      json = true
      continue
    }
    if (!allowed.has(flag)) throw new CliUsageError("unknown option; see 'lca --help' for supported options")
    if (!rest[index + 1] || rest[index + 1]!.startsWith("--")) {
      throw new CliUsageError(`missing value for ${flag}`)
    }
    if (Object.hasOwn(fields, flag)) throw new CliUsageError(`duplicate ${flag} option`)
    fields[flag] = rest[++index]!
  }
  if (!fields["--worktree"]) throw new CliUsageError("--worktree is required")
  if (json && command !== "status") throw new CliUsageError("--json is only available for read-only status")
  const engine = fields["--engine"] ?? "opencode"
  if (!["opencode", "local", "claude", "codex"].includes(engine)) {
    throw new CliUsageError("invalid --engine; choose opencode, local, codex, or claude")
  }
  const commonRecovery = engine !== "opencode" && COMMON_RECOVERY_COMMANDS.has(command)
  if (COMMON_RECOVERY_COMMANDS.has(command) && !fields["--server"] && !fields["--engine"]) {
    throw new CliUsageError("common-engine recovery requires explicit --engine, --model, and --session")
  }
  if (commonRecovery) {
    if (fields["--server"]) throw new CliUsageError("common-engine recovery does not accept --server")
    if (!fields["--model"]) throw new CliUsageError("common-engine recovery requires --model")
    if (!fields["--session"]) throw new CliUsageError("common-engine recovery requires --session")
  } else if (fields["--model"]) {
    throw new CliUsageError("--model is only available for common-engine recovery commands")
  }
  if (command !== "status" && !commonRecovery && !fields["--server"]) {
    throw new CliUsageError("--server must name an already-running local OpenCode service")
  }
  if (command === "import" && (!fields["--session"] || !fields["--plan"])) {
    throw new CliUsageError("import requires --session and --plan")
  }
  if ((command === "approve" || command === "reject") && (!fields["--workflow"] || !fields["--sha"])) {
    throw new CliUsageError("approve and reject require --workflow and --sha")
  }
  if (!commonRecovery && command === "cancel" && !fields["--session"]) throw new CliUsageError("cancel requires --session")
  if (!commonRecovery && command === "resume" && !fields["--session"]) throw new CliUsageError("resume requires --session")
  if (command === "run" && !fields["--session"] && !fields["--plan"]) {
    throw new CliUsageError("run requires --plan or --session")
  }
  let worktree: string
  try {
    worktree = realpathSync(fields["--worktree"])
    if (!statSync(worktree).isDirectory()) throw new Error()
    accessSync(worktree, constants.R_OK | constants.X_OK)
  } catch {
    throw new CliUsageError("--worktree must name an accessible directory; check the path and permissions")
  }
  return { command, worktree,
    ...(fields["--server"] ? { server: fields["--server"] } : {}),
    ...(fields["--session"] ? { session: fields["--session"] } : {}),
    ...(fields["--plan"] ? { plan: fields["--plan"] } : {}),
    ...(fields["--workflow"] ? { workflow: fields["--workflow"] } : {}),
    ...(fields["--sha"] ? { sha: fields["--sha"] } : {}),
    engine: engine as CliArgs["engine"],
    ...(fields["--model"] ? { model: fields["--model"] } : {}), json }
}

function localServer(address: string): string {
  let url: URL
  try { url = new URL(address) } catch {
    throw new CliUsageError("OpenCode server must be an explicit HTTP loopback IP and port")
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.port) {
    throw new CliUsageError("OpenCode server must be an explicit HTTP loopback IP and port")
  }
  return url.origin
}

async function checkedClient(server: string, root: string): Promise<OpencodeClient> {
  const { createOpencodeClient } = await import("@opencode-ai/sdk")
  const client = createOpencodeClient({ baseUrl: server, directory: root })
  const [path, config, agents] = await Promise.all([
    client.path.get({ query: { directory: root } }),
    client.config.get({ query: { directory: root } }),
    client.app.agents({ query: { directory: root } }),
  ])
  if (path.error || !path.data || realpathSync(path.data.worktree) !== root) throw new Error("server worktree does not match the canonical source worktree")
  const plugin = pathToFileURL(resolve(root, ".opencode/plugins/lca.ts")).href
  if (config.error || !config.data || !Array.isArray(config.data.plugin) ||
    config.data.plugin.length !== 1 || config.data.plugin[0] !== plugin) {
    throw new Error("server must advertise only the project LCA plugin")
  }
  const listed = agents.data
  if (agents.error || !listed || !["main", "worker", "reviewer"].every(name => listed.some(a => a.name === name))) {
    throw new Error("server lacks the LCA execution agent inventory")
  }
  if (listed.find(a => a.name === "worker")?.mode !== "subagent" || listed.find(a => a.name === "reviewer")?.mode !== "subagent") {
    throw new Error("server execution roles differ from the expected child profiles")
  }
  const expectedReviewer = loadConfig(root).models.reviewer
  const configuredReviewer = config.data.agent?.reviewer
  const listedReviewer = listed.find(a => a.name === "reviewer")!
  const effectiveModel = configuredReviewer?.model ?? config.data.model
  const listedModel = listedReviewer.model && `${listedReviewer.model.providerID}/${listedReviewer.model.modelID}`
  const dangerousTools = ["edit", "write", "patch", "bash", "task", "delegate", "webfetch"]
  const configuredPermissions = configuredReviewer?.permission as Record<string, unknown> | undefined
  const rules = listedReviewer.permission
  const deniedByNativeRules = (tool: string): boolean => {
    if (!Array.isArray(rules)) return false
    const denial = rules.findLastIndex(rule => rule.permission === tool && rule.pattern === "*" && rule.action === "deny")
    return denial >= 0 && !rules.slice(denial + 1).some(rule =>
      (rule.permission === tool || rule.permission === "*") && rule.action !== "deny")
  }
  if (configuredReviewer?.disable || configuredReviewer?.mode && configuredReviewer.mode !== "subagent" ||
    expectedReviewer && effectiveModel && effectiveModel !== expectedReviewer ||
    expectedReviewer && listedModel && listedModel !== expectedReviewer ||
    effectiveModel && listedModel && effectiveModel !== listedModel ||
    !dangerousTools.every(tool => configuredPermissions?.[tool] === "deny" && deniedByNativeRules(tool))) {
    throw new Error("server reviewer agent or model conflicts with the LCA execution profile")
  }
  return client
}

/** Status is engine-free; OpenCode uses its local service, while common recovery uses the selected CLI runtime. */
export async function runCli(
  args: CliArgs,
  cliRuntimeFactory: typeof createCliRuntime = createCliRuntime,
): Promise<string> {
  const root = args.worktree
  if (args.command === "status") {
    const sessionID = args.session ?? "no-session"
    const flow = { worktree: root, config: loadConfig(root), log: () => {} }
    const status = readForegroundStatus(flow, sessionID, args.json)
    return typeof status === "string" ? status : JSON.stringify(status)
  }
  if (args.engine !== "opencode" && COMMON_RECOVERY_COMMANDS.has(args.command)) {
    if (args.server !== undefined) throw new CliUsageError("common-engine recovery does not accept --server")
    if (!args.model || !args.session) throw new CliUsageError("common-engine recovery requires explicit --model and --session")
    if ((args.command === "approve" || args.command === "reject") &&
      (!args.workflow || !args.sha)) throw new CliUsageError("approve and reject require --workflow and --sha")
    if ((args.command === "approve" || args.command === "reject") &&
      (!process.stdin.isTTY || !process.stderr.isTTY)) {
      throw new Error("local human approval or rejection requires an interactive terminal")
    }
    const runtime = cliRuntimeFactory({ worktree: root, engine: args.engine, model: args.model })
    const controller = createForegroundController(runtime)
    if (args.command === "approve" || args.command === "reject") {
      const workflowID = args.workflow!
      const planSha = args.sha!
      controller.assertRecoveryIdentity(args.session, workflowID, planSha)
      const decision = await humanDecision(args.command, workflowID, planSha)
      const result = controller.decide(decision, args.session)
      if (!result.ok) throw new Error(result.text)
      return `workflow ${result.wf.id} ${result.wf.phase}`
    }
    if (args.command === "cancel") {
      const result = controller.cancel(args.session)
      if (!result.ok) throw new Error(result.text)
      return `workflow ${result.wf.id} ${result.wf.phase}${result.wf.pendingCancel ? "; cancellation requested; execution retirement pending" : ""}`
    }
    const abort = new AbortController()
    const stop = () => abort.abort()
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    try {
      const result = await controller.resume(args.session, abort.signal)
      if (result.workflow.phase !== "done" || result.run.failed > 0 || result.run.cancelled > 0 ||
        result.run.aborted || result.run.refused || result.run.skipped || result.run.noSnapshot) {
        throw new Error("common-engine resume incomplete; inspect read-only status")
      }
      return `workflow ${result.workflow.id} ${result.workflow.phase}; done ${result.run.done}, failed ${result.run.failed}, cancelled ${result.run.cancelled}${result.run.skipped ? `; ${result.run.skipped}` : ""}`
    } finally {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
    }
  }
  const server = localServer(args.server!)
  if (args.engine !== "opencode") throw new Error("native coding profile is not admitted for this engine")
  if ((args.command === "run" && args.plan || args.command === "approve" || args.command === "reject") &&
    (!process.stdin.isTTY || !process.stderr.isTTY)) {
    throw new Error("local human approval or rejection requires an interactive terminal")
  }
  const config = loadConfig(root)
  const client = await checkedClient(server, root)
  const deps: HookDeps = {
    client, directory: root, worktree: root, config,
    log: (message, fields) => console.error(`lca: ${message}`, fields ? Object.keys(fields).join(",") : ""),
  }
  const runtime = getOpenCodeRuntime(deps)
  runtime.linuxAdmission?.assertBootEpoch()
  const controller = createForegroundController(runtime)
  if (args.command === "import") {
    const session = await client.session.get({ path: { id: args.session! }, query: { directory: root } })
    if (session.error || !session.data || realpathSync(session.data.directory) !== root) throw new Error("parent session is absent from the source worktree")
    const result = await controller.importPlan(args.session!, args.plan!)
    if (!result.result.ok) throw new Error(result.result.text)
    return `workflow ${result.result.wf.id} ${result.result.wf.phase}; plan_sha ${result.planSha}; inspect ${result.result.wf.planRef?.mdPath ?? "saved plan"}`
  }
  if (args.command === "approve" || args.command === "reject") {
    const decision = await humanDecision(args.command, args.workflow!, args.sha!)
    const result = controller.decide(decision)
    if (!result.ok) throw new Error(result.text)
    return `workflow ${result.wf.id} ${result.wf.phase}`
  }
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
  if (args.command === "run" && args.plan) {
    const source = realpathSync(resolve(root, args.plan))
    if (!source.startsWith(`${root}/`)) throw new Error("plan source must be inside the canonical worktree")
    const parsed = JSON.parse(readFileSync(source, "utf8")) as unknown
    controller.validateImportedPlan(parsed, args.session)
    const preflight = await runtime.host.preflight(runtime.host.identity.profile)
    assertHostAdmission(preflight)
    if (abort.signal.aborted) throw new Error("run cancelled before parent session creation")
    const existing = readWorkflow(root)
    let sessionID = args.session ?? (existing?.phase === "planning" ? existing.sessionID : undefined)
    if (!sessionID) {
      const created = await client.session.create({ body: { title: "lca foreground imported plan" }, query: { directory: root } })
      if (created.error || !created.data?.id) throw new Error("could not create an inert parent session")
      sessionID = created.data.id
    }
    const submitted = await controller.importPlan(sessionID, args.plan, abort.signal, parsed)
    if (abort.signal.aborted) throw new Error("run cancelled before operator decision")
    if (!submitted.result.ok || submitted.result.wf.phase !== "pending_approval") {
      throw new Error("plan did not reach pending operator approval")
    }
    console.error(`lca: inspect ${submitted.result.wf.planRef?.mdPath ?? "saved canonical plan"}; workflow ${submitted.result.wf.id}; sha ${submitted.planSha}`)
    const choice = await humanDecision("choose", submitted.result.wf.id, submitted.planSha)
    const decided = controller.decide(choice)
    if (!decided.ok) throw new Error(decided.text)
    if (choice.action === "reject") return `workflow ${decided.wf.id} ${decided.wf.phase}; rejected by local operator`
    args = { ...args, session: sessionID }
  }
  const sessionID = args.command === "resume" ? args.session : args.session ?? readWorkflow(root)?.sessionID
  if (!sessionID) throw new Error("no workflow session to resume")
  if (args.command === "cancel") {
    const result = controller.cancel(sessionID)
    if (!result.ok) throw new Error(result.text)
    return `workflow ${result.wf.id} ${result.wf.phase}${result.wf.pendingCancel ? "; cancellation requested; execution retirement pending" : ""}`
  }
    const result = args.command === "resume" ? await controller.resume(sessionID, abort.signal) : await controller.run(sessionID, abort.signal)
    return `workflow ${result.workflow.id} ${result.workflow.phase}; done ${result.run.done}, failed ${result.run.failed}, cancelled ${result.run.cancelled}${result.run.skipped ? `; ${result.run.skipped}` : ""}`
  } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
}

function failCli(error: unknown): void {
  if (error instanceof AdmissionRefusal) {
    console.error("lca: host admission refused; required host control evidence is unavailable. Use a host that can provide all required execution controls before proceeding.")
    process.exitCode = 1
    return
  }
  if (error instanceof LinuxAdmissionRefused) {
    console.error(error.message)
    process.exitCode = 3
    return
  }
  if (error instanceof CliUsageError) {
    console.error(`lca: ${error.message}`)
    console.error("Run 'lca --help' for usage.")
    process.exitCode = 2
    return
  }
  if (error instanceof InteractiveLaunchError) {
    console.error(`lca: ${error.message}`)
    process.exitCode = 1
    return
  }
  console.error("lca: command refused or failed; inspect read-only status for durable state")
  process.exitCode = 1
}

function main(argv: string[]): void {
  const interactiveRequested = argv.length === 0 || argv[0] === "chat" ||
    ["--worktree", "--engine", "--model"].includes(argv[0]!)
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h") ||
    interactiveRequested && argv.some((arg) => arg === "--help" || arg === "-h")) {
    console.log(CLI_USAGE)
    return
  }
  if (interactiveRequested) {
    try {
      const args = parseInteractiveArgs(argv[0] === "chat" ? argv.slice(1) : argv)
      launchInteractive(args).then(({ code }) => { process.exitCode = code }).catch(failCli)
    } catch (error) {
      if (error instanceof InteractiveLaunchError) failCli(new CliUsageError(error.message))
      else failCli(error)
    }
    return
  }
  try { runCli(parseCliArgs(argv)).then(text => console.log(text)).catch(failCli) }
  catch (error) { failCli(error) }
}

if (import.meta.main) main(process.argv.slice(2))
