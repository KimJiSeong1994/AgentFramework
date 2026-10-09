#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { pathToFileURL } from "node:url"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { loadConfig } from "../config.ts"
import { readWorkflow } from "../flow/state.ts"
import type { HookDeps } from "../hooks/types.ts"
import { getOpenCodeRuntime } from "./opencode-runtime.ts"
import { createForegroundController, readForegroundStatus } from "./controller.ts"
import { LinuxAdmissionRefused } from "./types.ts"

const COMMANDS = new Set(["status", "import", "approve", "reject", "run", "resume", "cancel"])
type CliArgs = { command: string; worktree: string; server?: string; session?: string; plan?: string; workflow?: string; sha?: string; engine: "opencode" | "claude" | "codex"; json: boolean }

export function parseCliArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv
  if (!command || !COMMANDS.has(command)) throw new Error("usage: lca <status|import|approve|reject|run|resume|cancel> --worktree PATH [options]")
  const fields: Record<string, string> = {}
  let json = false
  const allowed = new Set(["--worktree", "--server", "--session", "--plan", "--workflow", "--sha", "--engine"])
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!
    if (flag === "--json") { if (json) throw new Error("duplicate --json"); json = true; continue }
    if (!allowed.has(flag) || !rest[index + 1] || rest[index + 1]!.startsWith("--") || fields[flag]) throw new Error(`invalid or duplicate option ${flag}`)
    fields[flag] = rest[++index]!
  }
  if (!fields["--worktree"]) throw new Error("--worktree is required")
  if (json && command !== "status") throw new Error("--json is only available for read-only status")
  const engine = fields["--engine"] ?? "opencode"
  if (!["opencode", "claude", "codex"].includes(engine)) throw new Error("unknown execution engine")
  if (command !== "status" && !fields["--server"]) throw new Error("--server must name an already-running local OpenCode service")
  if (command === "import" && (!fields["--session"] || !fields["--plan"])) throw new Error("import requires --session and --plan")
  if ((command === "approve" || command === "reject") && (!fields["--workflow"] || !fields["--sha"])) throw new Error(`${command} requires --workflow and --sha`)
  if (command === "cancel" && !fields["--session"]) throw new Error("cancel requires --session")
  if (command === "resume" && !fields["--session"]) throw new Error("resume requires --session")
  if (command === "run" && !fields["--session"] && !fields["--plan"]) throw new Error("run requires --plan or --session")
  return { command, worktree: realpathSync(fields["--worktree"]),
    ...(fields["--server"] ? { server: fields["--server"] } : {}),
    ...(fields["--session"] ? { session: fields["--session"] } : {}),
    ...(fields["--plan"] ? { plan: fields["--plan"] } : {}),
    ...(fields["--workflow"] ? { workflow: fields["--workflow"] } : {}),
    ...(fields["--sha"] ? { sha: fields["--sha"] } : {}),
    engine: engine as CliArgs["engine"], json }
}

function localServer(address: string): string {
  const url = new URL(address)
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.port) {
    throw new Error("OpenCode server must be an explicit HTTP loopback IP and port")
  }
  return url.origin
}

async function checkedClient(server: string, root: string): Promise<OpencodeClient> {
  const { createOpencodeClient } = await import("@opencode-ai/sdk")
  const client = createOpencodeClient({ baseUrl: localServer(server), directory: root })
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

async function humanDecision(action: "approve" | "reject" | "choose", workflowID: string, sha: string): Promise<{ action: "approve" | "reject"; reason?: string }> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("local human approval or rejection requires an interactive terminal")
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const approve = `APPROVE ${workflowID} ${sha}`
    const reject = `REJECT ${workflowID} ${sha}`
    const answer = (await terminal.question(`Inspect the saved canonical plan first. Type '${approve}' or '${reject} <reason>': `)).trim()
    if (answer === approve && action !== "reject") return { action: "approve" }
    if (answer.startsWith(`${reject} `) && answer.slice(reject.length).trim() && action !== "approve") {
      return { action: "reject", reason: answer.slice(reject.length).trim() }
    }
    throw new Error("local operator decision did not match workflow ID and plan hash")
  } finally { terminal.close() }
}

/** Status never constructs an SDK client or loads an auth source. All other commands require an explicit local service. */
export async function runCli(args: CliArgs): Promise<string> {
  const root = args.worktree
  if (args.command === "status") {
    const sessionID = args.session ?? "no-session"
    const flow = { worktree: root, config: loadConfig(root), log: () => {} }
    const status = readForegroundStatus(flow, sessionID, args.json)
    return typeof status === "string" ? status : JSON.stringify(status)
  }
  if (args.engine !== "opencode") throw new Error("native coding profile is not admitted for this engine")
  if ((args.command === "run" && args.plan || args.command === "approve" || args.command === "reject") &&
    (!process.stdin.isTTY || !process.stderr.isTTY)) {
    throw new Error("local human approval or rejection requires an interactive terminal")
  }
  const config = loadConfig(root)
  const client = await checkedClient(args.server!, root)
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
    const entered = await humanDecision(args.command, args.workflow!, args.sha!)
    const decision = args.command === "approve"
      ? { source: "local_human" as const, action: "approve" as const, workflowID: args.workflow!, planSha: args.sha! }
      : { source: "local_human" as const, action: "reject" as const, workflowID: args.workflow!, planSha: args.sha!, reason: entered.reason! }
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
    const existing = readWorkflow(root)
    let sessionID = args.session ?? (existing?.phase === "planning" ? existing.sessionID : undefined)
    if (!sessionID) {
      const created = await client.session.create({ body: { title: "lca foreground imported plan" }, query: { directory: root } })
      if (created.error || !created.data?.id) throw new Error("could not create an inert parent session")
      sessionID = created.data.id
    }
    const submitted = await controller.importPlan(sessionID, args.plan, abort.signal, parsed)
    if (!submitted.result.ok || submitted.result.wf.phase !== "pending_approval") {
      throw new Error("plan did not reach pending operator approval")
    }
    console.error(`lca: inspect ${submitted.result.wf.planRef?.mdPath ?? "saved canonical plan"}; workflow ${submitted.result.wf.id}; sha ${submitted.planSha}`)
    const choice = await humanDecision("choose", submitted.result.wf.id, submitted.planSha)
    const decided = controller.decide({ source: "local_human", workflowID: submitted.result.wf.id, planSha: submitted.planSha,
      ...(choice.action === "approve" ? { action: "approve" } : { action: "reject", reason: choice.reason! }) })
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

if (import.meta.main) {
  const fail = (error: unknown) => {
    if (error instanceof LinuxAdmissionRefused) {
      console.error(error.message)
      process.exitCode = 3
      return
    }
    console.error("lca: command refused or failed; inspect read-only status for durable state")
    process.exitCode = 1
  }
  try { runCli(parseCliArgs(process.argv.slice(2))).then(text => console.log(text)).catch(fail) }
  catch (error) { fail(error) }
}
