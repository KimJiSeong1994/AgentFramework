#!/usr/bin/env bun
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { loadConfig } from "../config.ts"
import { harnessProfile, renderProfile } from "../harness/profile.ts"
import { renderStatusDetail, renderStatusSnapshot, StatusReadError, statusJson } from "../flow/status.ts"
import { readWorkflow, workflowEngineRefusal, type Workflow } from "../flow/state.ts"
import type { WorkflowEnvelope } from "../workflows/types.ts"
import type { HookDeps } from "../hooks/types.ts"
import { getOpenCodeRuntime } from "./opencode-runtime.ts"
import { createForegroundController } from "./controller.ts"
import { settled } from "./run-state.ts"
import { incompleteArtifactSummary } from "../workflows/artifacts.ts"
import { humanDecision, type DecisionBinding } from "./operator.ts"
import { createCliRuntime } from "./cli-runtime.ts"
import { findExecutable, type CliEngine } from "./cli-transport.ts"
import { AdmissionRefusal, assertHostAdmission } from "./required-controls.ts"
import { EXECUTION_ROLES, LinuxAdmissionRefused, type ExecutionRuntime, type FlowRuntime } from "./types.ts"
import { InteractiveLaunchError, launchInteractive, parseInteractiveArgs } from "./interactive.ts"
import { createStatusWatchState, watchTick } from "./status-watch.ts"
import { admissionEpoch, admissionFence, attachAdmission, detachAdmission, effectiveHold, isAdmissionCurrent, resumeAdmission } from "../sessions/admission.ts"
import type { SessionStore } from "../sessions/store.ts"
import { getOwnedSession, readSessionMetadata, sessionWasRebound } from "../sessions/store.ts"
import { assertSDKSessionQuiescent, readSDKResumeIdentity } from "../sessions/sdk-quiescence.ts"
import { captureSDKSessionLifetime } from "../sessions/sdk-transcript.ts"
import { assertNever, isCancelPending, stopDisplay } from "../workflows/types.ts"
import { AUTH_ENGINES, authStatus, describeAuth, describeAuthFailure, describeDiagnosis, diagnoseAuth, loginArgv, loginHint, logoutArgv, runVendorAuth, type AuthEngine, type LoginMethod } from "./engine-auth.ts"
import { updateCli } from "./update-check.ts"
import { describeEngine, describeUpdateFailure, engineInfo, planEngineUpdate, runEngineUpdate, UPDATABLE_ENGINES, verifyEngineUpdate, type UpdatableEngine } from "./engine-update.ts"
import { createInterface } from "node:readline"

const COMMANDS = new Set(["status", "import", "approve", "reject", "run", "resume", "pause", "cancel"])
const COMMON_RECOVERY_COMMANDS = new Set(["approve", "reject", "resume", "pause", "cancel", "run"])
const HOST_POLICY_MISMATCH = "host policy identity evidence is absent or mismatched; recovery refused"
type CliArgs = { command: string; worktree: string; server?: string; session?: string; plan?: string; workflow?: string; sha?: string; engine: "opencode" | CliEngine; model?: string; json: boolean; detail: boolean; watch: boolean; interval: number }

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CliUsageError"
  }
}

const CLI_USAGE = `Usage:
  otter [chat] [--worktree PATH] [--engine local|codex|claude] [--model ID]
  otter <command> --worktree PATH [options]

Interactive chat:
  otter
  otter --continue                 Resume the most recent saved CLI session in this worktree
  otter --resume [ID]              Choose a saved session, or open one by ID
  otter chat [--worktree PATH] [--engine local|codex|claude] [--model ID]

Saved conversations are retained across restarts. Startup always opens a new conversation;
choose a previous one only when needed with --resume, /sessions or /resume [ID] (before model selection too). Restored sessions keep their saved
model and conversation; /continue performs the existing explicit work-resume checks.

Chat execution: by default (chat.execute "ask") the model may edit files and run commands, and you approve each action
(Allow once / Always allow / Deny); "auto-edit" applies edits without asking, "plan" keeps chat read-only. /permissions
shows the mode and saved rules.

Bare 'otter' and 'otter chat' start Otter's interactive terminal in the current Git worktree
(any other folder is used as is; approved plans then ask before running in place),
or in the canonical worktree selected by --worktree. Choose an engine from the menu, or
specify --engine. Enter a native model ID or supply --model; local selects the Ollama CLI,
not OpenCode. The model picker lists bounded native choices when available; explicit IDs are
also accepted. In chat, /model shows the current selection and picker, /model <engine> <native-id>
switches directly, and /help lists local commands. A switch requires no active workflow, valid
workflow state and settled execution ownership, and starts a new conversation context. Plans require a separate local human approval.
Harness profile (read-only, no model call):
  otter harness profile [--worktree PATH] [--json]   code-owned identity of the agent: components c1..c8 (not proposable)
                                                      plus the proposable task-data overlays, role policy IDs, skill hashes
                                                      and one fingerprint. Describes identity, not quality.
Role combo: chat.combo in otter.jsonc routes planner/architect/critic/worker/reviewer roles to other engines and models;
roles without a route use the main model. /model combo (or the "combo" entry in the /model engine list) opens a menu
(recommended combos or custom role -> engine -> model settings); /model combo presets lists templates,
/model combo preset <name> saves one and applies it to the current session at once, and /model combo custom opens role editing. Typed forms /model combo show, /model combo <role> <engine> <native-id>,
/model combo clear [role] and /model combo apply (which starts a new session under it) also work. A project route replaces the
user's route for that role as a whole object. Every new session (a plain /model switch, /new, apply) takes its routes from the
currently saved combo, normalized against the new main model; an invalid combo is reported and not applied. /resume and the
common-engine recovery commands use the session's pinned routes from its metadata, never current config.
Memory: /memory shows the engine that links requests to knowledge/wiki pages for the memory tool (default auto: the
Claude CLI with claude-haiku-5-5, else the Codex CLI with gpt-5.6-luna; no local model server needed); /memory test
times one fresh recall; /memory auto, /memory claude [model], /memory codex [slug], /memory local <ollama-model>,
/memory jev or /memory off saves it to the user config (auto/claude/codex send the request and wiki index titles to
that vendor). It applies to the next memory call.
Otter workflows (chat only; each start is a submitted /skill: command, and invoking a name is not consent to execute):
  /skill:deep-interview <request>   code-owned interview: topology, panels, closure, restatement, verified spec.md (available)
  /skill:ralplan <request>          consensus planning: planner, architect, critic, same-plan-hash join (available)
  /skill:ultragoal <objective>      goal ledger execution: every unit needs APPROVE-UNIT before queue work
  /skill:autoresearch <mission>     local research mission: every experiment needs RUN before verifier commands
  /finish                           early-exit request for an interview (round 3+, above threshold; closure still runs)
A verified interview spec connects to ralplan in the same live session; consensus never executes anything on its own
("execution pending"). Workflow choices are inline lists. Fake-model tests are not live-model proof.
Supported terminals default to a full-screen transcript, status line and composer (minimum 60x20).
OTTER_TUI=0 forces readline; unsupported terminals fall back with a notice. NO_COLOR disables styling.
Enter sends, enhanced Shift+Enter/Ctrl+J inserts a newline, Escape cancels, and a second Ctrl+C
strictly within 500ms requests shutdown. Busy turns can be queued with macOS Alt+Q / Linux Alt+Enter.

Engine sign-in (the vendor CLI keeps the credential; otter never reads or stores one):
  auth     [status | --diagnose]                     show codex/claude sign-in status; --diagnose compares your shell with otter's model calls
  login    <codex|claude> [browser|device|console|api-key]   run the vendor's own sign-in
  logout   <codex|claude>                            run the vendor's own sign-out
  In chat: /auth, /login [engine], /logout [engine]; a failed model request names a signed-out engine.

Updates (installs made by install.sh / install.ps1):
  update   [--check]                                 install the latest otter in place; --check only reports
  Interactive starts check in the background at most once a day and only notify ("Update available ... Run: otter update").
  Disable with "update": { "check": false } in ~/.config/otter/otter.jsonc or OTTER_NO_UPDATE_CHECK=1.
  Source checkouts are never checked; update them with git.

Engine CLIs:
  engines                                          codex/claude versions, install method, and the update that fits it
  engines update [codex|claude] [--yes]            run that update after confirming the exact command (in chat: /engines)
  Codex is pinned to the newest otter-supported version (may be a downgrade); Claude follows the vendor's stable channel.

Commands:
  status   --worktree PATH [--session ID] [--json] [--detail] [--watch [--interval 1..60]]
  import   --worktree PATH --server URL --session ID --plan PATH
  approve  --worktree PATH --server URL --workflow ID --sha SHA
  reject   --worktree PATH --server URL --workflow ID --sha SHA
  run      --worktree PATH --server URL (--plan PATH | --session ID)
  resume   --worktree PATH --server URL --session ID   (a paused workflow asks Keep/Resume on a terminal)
  pause    --worktree PATH --server URL --session ID   (request; "pausing — termination unconfirmed" until proof)
  cancel   --worktree PATH --server URL --session ID

Common-engine workflow commands (no server; exact original engine, model and session required):
  run      --worktree PATH --engine local|codex|claude --model ID --session ID [--plan PATH]
  approve  --worktree PATH --engine local|codex|claude --model ID --session ID --workflow ID --sha SHA
  reject   --worktree PATH --engine local|codex|claude --model ID --session ID --workflow ID --sha SHA
  resume   --worktree PATH --engine local|codex|claude --model ID --session ID
  pause    --worktree PATH --engine local|codex|claude --model ID --session ID
  cancel   --worktree PATH --engine local|codex|claude --model ID --session ID

Status reads local workflow state without an engine or server. OpenCode mutations still require the local service.
Status watch defaults to a two-second interval; --json watch emits newline-delimited JSON and works without a TTY.

Examples:
  otter status --worktree /path/to/repo
  otter status --worktree /path/to/repo --json
  otter run --plan plan.json --worktree /path/to/repo --server http://127.0.0.1:4096
  otter resume --worktree /path/to/repo --engine codex --model gpt-5.6-sol --session SESSION_ID

Prerequisites and safety:
  The --worktree path must name an accessible directory. OpenCode mutations require an already-running,
  trusted local service and the project's Otter plugin. Common-engine recovery requires the exact original
  engine, model and session; unresolved execution ownership is refused without replay or forced release.
  Common-engine approve and reject require a local interactive terminal for explicit human decisions.
  Standalone commands do not start a server.
  Interactive chat requires a terminal on stdin and stderr; EOF or interruption never approves a plan.
  Bare interactive chat opens with no engine or model selected; enter /model in the composer to choose.
  Startup selection is opt-in with both --engine and --model; partial flags leave the composer unselected.
  Without either flag, chat.default_model in ~/.config/otter/otter.jsonc (or the project .otter/otter.jsonc) is used;
  set it with /model default save or /model default <engine> <native-id>, remove it with /model default clear.
  Native CLI input limits are estimated and output limits are reactive, not strict guarantees; no process
  or filesystem containment is claimed. Plans are never auto-approved. Host admission refuses when
  required control evidence is unavailable; the CLI does not expose raw vendor preflight diagnostics.

Run 'otter --help' for this usage. Exit codes: 0 success/help, 1 runtime refusal/failure,
2 invalid arguments or inaccessible worktree, 3 status read failure or Linux admission refusal.`

export function parseCliArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv
  if (!command) throw new CliUsageError("missing command; see 'otter --help'")
  if (!COMMANDS.has(command)) throw new CliUsageError("unknown command; see 'otter --help' for supported commands")
  const usageError = (message: string): CliUsageError => new CliUsageError(message)
  const fields: Record<string, string> = {}
  let json = false
  let detail = false
  let watch = false
  const allowed = new Set(["--worktree", "--server", "--session", "--plan", "--workflow", "--sha", "--engine", "--model", "--interval"])
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!
    if (flag === "--json") {
      if (json) throw usageError("duplicate --json option")
      json = true
      continue
    }
    if (flag === "--detail") {
      if (detail) throw usageError("duplicate --detail option")
      detail = true
      continue
    }
    if (flag === "--watch") {
      if (watch) throw usageError("duplicate --watch option")
      watch = true
      continue
    }
    if (!allowed.has(flag)) throw usageError("unknown option; see 'otter --help' for supported options")
    if (!rest[index + 1] || rest[index + 1]!.startsWith("--")) {
      throw usageError(`missing value for ${flag}`)
    }
    if (Object.hasOwn(fields, flag)) throw usageError(`duplicate ${flag} option`)
    fields[flag] = rest[++index]!
  }
  if (!fields["--worktree"]) throw usageError("--worktree is required")
  if (json && command !== "status") throw new CliUsageError("--json is only available for read-only status")
  if (command !== "status" && (detail || watch || fields["--interval"] !== undefined)) {
    throw new CliUsageError("--detail, --watch, and --interval are only available for status")
  }
  if (fields["--interval"] !== undefined && !watch) throw usageError("--interval requires --watch")
  if (fields["--interval"] !== undefined && !/^\d+$/.test(fields["--interval"]!)) {
    throw usageError("--interval must be an integer from 1 to 60")
  }
  const interval = fields["--interval"] === undefined ? 2 : Number(fields["--interval"])
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) throw usageError("--interval must be an integer from 1 to 60")
  if (watch && !json && !process.stdout.isTTY) throw usageError("text status --watch requires a TTY; use --json")
  const engine = fields["--engine"] ?? "opencode"
  if (!["opencode", "local", "claude", "codex"].includes(engine)) {
    throw usageError("invalid --engine; choose opencode, local, codex, or claude")
  }
  const commonRecovery = engine !== "opencode" && COMMON_RECOVERY_COMMANDS.has(command)
  if (COMMON_RECOVERY_COMMANDS.has(command) && !fields["--server"] && !fields["--engine"]) {
    throw new CliUsageError("common-engine recovery requires explicit --engine, --model, and --session")
  }
  if (commonRecovery) {
    if (fields["--server"]) throw new CliUsageError("common-engine recovery does not accept --server")
    if (!fields["--model"]) throw new CliUsageError("common-engine recovery requires --model")
    if (!fields["--session"]) throw new CliUsageError("common-engine workflow command requires --model and --session")
  } else if (fields["--model"]) {
    throw usageError("--model is only available for common-engine workflow commands")
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
  if (!commonRecovery && (command === "cancel" || command === "pause") && !fields["--session"]) throw new CliUsageError(`${command} requires --session`)
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
    throw usageError("--worktree must name an accessible directory; check the path and permissions")
  }
  return { command, worktree,
    ...(fields["--server"] ? { server: fields["--server"] } : {}),
    ...(fields["--session"] ? { session: fields["--session"] } : {}),
    ...(fields["--plan"] ? { plan: fields["--plan"] } : {}),
    ...(fields["--workflow"] ? { workflow: fields["--workflow"] } : {}),
    ...(fields["--sha"] ? { sha: fields["--sha"] } : {}),
    engine: engine as CliArgs["engine"],
    ...(fields["--model"] ? { model: fields["--model"] } : {}), json, detail, watch, interval }
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
  const plugin = pathToFileURL(resolve(root, ".opencode/plugins/otter.ts")).href
  if (config.error || !config.data || !Array.isArray(config.data.plugin) ||
    config.data.plugin.length !== 1 || config.data.plugin[0] !== plugin) {
    throw new Error("server must advertise only the project Otter plugin")
  }
  const listed = agents.data
  if (agents.error || !listed || !["main", "worker", "reviewer"].every(name => listed.some(a => a.name === name))) {
    throw new Error("server lacks the Otter execution agent inventory")
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
    throw new Error("server reviewer agent or model conflicts with the Otter execution profile")
  }
  return client
}

async function runStatusWatch(args: CliArgs, runtime: FlowRuntime): Promise<void> {
  const state = createStatusWatchState({ sessionID: args.session, detail: args.detail })
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setInterval>
    let stopped = false
    let stop: () => void = () => {}
    const cleanup = () => {
      clearInterval(timer)
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
    }
    stop = () => {
      if (stopped) return
      stopped = true
      cleanup()
      resolve()
    }
    const tick = () => {
      if (stopped) return
      try {
        const { frame } = watchTick(state, runtime, Date.now())
        if (args.json && frame) process.stdout.write(`${JSON.stringify(frame)}\n`)
        else if (!args.json && frame?.type === "error") {
          process.stdout.write(`\u001b[2J\u001b[H[otter status]\nstatus unavailable: ${frame.error?.source} ${frame.error?.code}\n`)
        } else if (!args.json && state.errors.size > 0 && state.tick % 10 === 0) {
          const [source, code] = [...state.errors].at(-1)!.split(":", 2)
          process.stdout.write(`\u001b[2J\u001b[H[otter status]\nstatus unavailable: ${source} ${code}\n`)
        } else if (!args.json && state.errors.size === 0 && (frame || state.tick % 10 === 0) && state.status) {
          const text = renderStatusSnapshot(state.status, args.session)
          const detail = args.detail ? `\n${renderStatusDetail(state.status)}` : ""
          process.stdout.write(`\u001b[2J\u001b[H${text}${detail}\n`)
        }
      } catch (error) {
        if (!stopped) {
          stopped = true
          cleanup()
          reject(error)
        }
      }
    }
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    timer = setInterval(tick, args.interval * 1000)
    tick()
  })
}

async function withCliSession<T>(
  runtime: ExecutionRuntime,
  args: CliArgs,
  sessionID: string,
  action: (store: SessionStore) => Promise<T>,
): Promise<T> {
  const routes = readSessionMetadata(runtime.worktree, sessionID)?.routes
  const store = attachAdmission(runtime, sessionID, {
    engine: runtime.host.identity.engine,
    ...(args.model ? { model: args.model } : {}),
    ...(routes ? { routes } : {}),
  })
  let actionFailed = false
  try { return await action(store) }
  catch (error) {
    actionFailed = true
    throw error
  }
  finally {
    const detached = await detachAdmission(runtime, sessionID, store.epoch, "cli_command_exit")
    if (!detached && !actionFailed) throw new Error("CLI session attachment remains held because release quiescence was not proven")
  }
}

async function resumeCliSession(runtime: ExecutionRuntime, sessionID: string, store: SessionStore, revision?: number, client?: OpencodeClient): Promise<SessionStore> {
  if (effectiveHold(runtime.worktree, sessionID)) {
    let vendorCreatedAt: number | undefined
    if (runtime.host.identity.engine === "opencode") {
      if (!client) throw new Error("OpenCode native quiescence proof is required")
      const fence = admissionFence(runtime.worktree, sessionID)
      const revalidate = () => {
        store.assertOwner()
        if (getOwnedSession(runtime.worktree, sessionID) !== store || admissionFence(runtime.worktree, sessionID) !== fence) {
          throw new Error("session authority changed during explicit Resume")
        }
      }
      const context = { client, sessionID, directory: runtime.directory, worktree: runtime.worktree, revalidate }
      const vendor = await readSDKResumeIdentity(context)
      await assertSDKSessionQuiescent(context, vendor)
      vendorCreatedAt = vendor.createdAt
    }
    if (vendorCreatedAt !== undefined && !captureSDKSessionLifetime(runtime.worktree, sessionID, store.epoch, vendorCreatedAt)) {
      throw new Error("OpenCode session lifetime could not be retained; admission remains held")
    }
    return resumeAdmission(runtime, sessionID, revision)
  }
  const epoch = admissionEpoch(runtime.worktree, sessionID)
  if (epoch !== store.epoch || !isAdmissionCurrent(runtime.worktree, sessionID, epoch)) {
    throw new Error("session attachment is held; explicit owner Resume is required")
  }
  if (revision !== undefined) {
    const current = readWorkflow(runtime.worktree)
    if (!current || current.sessionID !== sessionID || current.lastSeq !== revision) {
      throw new Error("workflow revision changed; explicit resume refused")
    }
  }
  return store
}

function confirmationWorkflow(
  controller: ReturnType<typeof createForegroundController>,
  runtime: ExecutionRuntime,
  sessionID: string,
  expectedID?: string,
  expectedSha?: string,
): Workflow | null {
  const persisted = readWorkflow(runtime.worktree)
  if (!persisted || persisted.sessionID !== sessionID) {
    if (expectedID !== undefined) throw new Error("no workflow owned by this session")
    return null
  }
  if (expectedID !== undefined && persisted.id !== expectedID) throw new Error("decision workflow ID or plan hash does not match")
  const confirmed = controller.assertRecoveryIdentity(sessionID, persisted.id, expectedSha, false, true)
  if (confirmed.lastSeq !== persisted.lastSeq || confirmed.id !== persisted.id || confirmed.sessionID !== sessionID) {
    throw new Error("workflow revision changed; explicit owner confirmation refused")
  }
  return confirmed
}

/** Explicit human Keep/Resume for a settled pause. Needs a real terminal; anything but RESUME keeps the hold. */
async function pausedResumeText(controller: ReturnType<typeof createForegroundController>, sessionID: string): Promise<string> {
  const outcome = await controller.resumePaused(sessionID, async (view) => {
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("resuming a paused workflow requires an interactive terminal")
    console.error(`otter: paused from ${view.pausedFrom.phase}/${view.pausedFrom.stage}; residual ${view.residual.join(", ") || "none"}; done ${view.done.join(", ") || "none"}${view.worktreeChanged ? "; worktree changed since the pause" : ""}; attempt ${view.attempt}`)
    const { createInterface } = await import("node:readline/promises")
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    try { return (await rl.question("Type RESUME to resume the residual work; anything else keeps the hold: ")).trim() === "RESUME" }
    finally { rl.close() }
  })
  return outcome.kept
    ? `workflow ${outcome.workflow.id} ${outcome.workflow.phase}; kept held, no work started`
    : `workflow ${outcome.workflow.id} ${outcome.workflow.phase}; resumed (attempt ${outcome.view.attempt})`
}

/** CLI approve/reject syntax maps the canonical plan hash to the plan subject, bound to the revision the operator inspected. */
function planBinding(sessionID: string, wf: Pick<Workflow, "id" | "lastSeq">, planSha: string): DecisionBinding {
  return { sessionID, workflowID: wf.id, expectedRevision: wf.lastSeq, subject: { kind: "plan", id: wf.id, sha256: planSha } }
}

function validateCliOwnerIdentity(runtime: ExecutionRuntime, sessionID: string, model: string): void {
  const workflow = readWorkflow(runtime.worktree)
  if (!workflow || workflow.sessionID !== sessionID) throw new Error("no workflow owned by this session")
  const refusal = workflowEngineRefusal(workflow, runtime.host.identity.engine)
  if (refusal) throw new Error(refusal)
  const metadata = readSessionMetadata(runtime.worktree, sessionID)
  if (metadata && metadata.engine !== runtime.host.identity.engine) throw new Error("host engine identity mismatch; recovery refused")
  if (metadata && metadata.model !== model) throw new Error(HOST_POLICY_MISMATCH)
}

/** Pinned-route evidence is checked before attachment can rebind or mutate anything: tampered metadata routes change the role policy IDs. */
function assertPinnedPolicyEvidence(runtime: ExecutionRuntime, sessionID: string): void {
  const rebound = sessionWasRebound(runtime.worktree, sessionID)
  for (const execution of runtime.runs.status().executions) {
    // After an in-place model rebind, settled executions keep the policy they ran under; unsettled ones must match.
    if (execution.ownerSession !== sessionID || execution.kind !== "host" || (rebound && settled(execution))) continue
    const role = EXECUTION_ROLES.find(candidate => candidate === execution.role)
    if (!role || !execution.policyID || execution.policyID !== runtime.policy.resolve(role).id) throw new Error(HOST_POLICY_MISMATCH)
  }
}

function readCliPlan(root: string, path: string): unknown {
  const source = realpathSync(resolve(root, path))
  const rel = relative(root, source)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("plan source must be inside the canonical worktree")
  }
  return JSON.parse(readFileSync(source, "utf8")) as unknown
}

function completedRunText(result: Awaited<ReturnType<ReturnType<typeof createForegroundController>["run"]>>, worktree: string): string {
  const incomplete = incompleteArtifactSummary(worktree, result.workflow)
  return `workflow ${result.workflow.id} ${result.workflow.phase}; done ${result.run.done}, failed ${result.run.failed}, cancelled ${result.run.cancelled}${result.run.skipped ? `; ${result.run.skipped}` : ""}${incomplete ? `; ${incomplete}` : ""}`
}

/** Stop result text. `paused` only for a settled pause; a pending stop says termination is unconfirmed. */
function stopText(wf: WorkflowEnvelope): string {
  const display = stopDisplay(wf)
  switch (display) {
    case "pausing": return `workflow ${wf.id} ${wf.phase}; pause requested; termination unconfirmed`
    case "paused": return `workflow ${wf.id} paused (from ${wf.pausedFrom?.phase ?? wf.phase})`
    case "cancelling": return `workflow ${wf.id} ${wf.phase}; cancellation requested; execution retirement pending; termination unconfirmed`
    case "none": return `workflow ${wf.id} ${wf.phase}`
    default: return assertNever(display, "stop display")
  }
}

async function runCommonCommand(args: CliArgs, runtime: ExecutionRuntime): Promise<string> {
  const sessionID = args.session!
  const controller = createForegroundController(runtime)

  // Cancellation is deliberately a safety request, not an attachment or takeover operation.
  if (args.command === "pause" || args.command === "cancel") {
    // Stop requests never dispatch a model, so they verify only session/engine/anchor model and do not depend on pinned routes.
    validateCliOwnerIdentity(runtime, sessionID, args.model!)
    const result = args.command === "pause" ? controller.pause(sessionID) : controller.cancel(sessionID)
    if (!result.ok) throw new Error(result.text)
    return stopText(result.wf)
  }

  if (args.command !== "run" || !args.plan) {
    validateCliOwnerIdentity(runtime, sessionID, args.model!)
    assertPinnedPolicyEvidence(runtime, sessionID)
  }
  else if (readWorkflow(runtime.worktree)?.sessionID === sessionID) {
    throw new Error("an existing workflow must be explicitly resumed or approved before a new plan is submitted")
  }

  return withCliSession(runtime, args, sessionID, async store => {
    if (args.command === "approve" || args.command === "reject") {
      const workflowID = args.workflow!
      const planSha = args.sha!
      const before = confirmationWorkflow(controller, runtime, sessionID, workflowID, planSha)
      if (!before || before.phase !== "pending_approval") throw new Error("no plan awaiting approval")
      const decision = await humanDecision(args.command, planBinding(sessionID, before, planSha))
      if (runtime.linuxAdmission) runtime.linuxAdmission.assertBootEpoch()
      const after = confirmationWorkflow(controller, runtime, sessionID, workflowID, planSha)
      if (!after || after.lastSeq !== before.lastSeq) throw new Error("workflow revision changed during operator decision")
      await resumeCliSession(runtime, sessionID, store, after.lastSeq)
      const result = controller.decide(decision, sessionID)
      if (!result.ok) throw new Error(result.text)
      return `workflow ${result.wf.id} ${result.wf.phase}`
    }

    if (args.command === "run" && args.plan) {
      if (!process.stdin.isTTY || !process.stderr.isTTY) {
        throw new Error("local human approval or rejection requires an interactive terminal")
      }
      const parsed = readCliPlan(runtime.worktree, args.plan)
      controller.validateImportedPlan(parsed, sessionID)
      const preflight = await runtime.host.preflight(runtime.host.identity.profile)
      assertHostAdmission(preflight)
      if (runtime.linuxAdmission) runtime.linuxAdmission.assertBootEpoch()
      await resumeCliSession(runtime, sessionID, store)
      const submitted = await controller.importPlan(sessionID, args.plan, undefined, parsed)
      if (!submitted.result.ok || submitted.result.wf.phase !== "pending_approval") {
        throw new Error("plan did not reach pending operator approval")
      }
      console.error(`otter: inspect ${submitted.result.wf.planRef?.mdPath ?? "saved canonical plan"}; workflow ${submitted.result.wf.id}; sha ${submitted.planSha}`)
      const decision = await humanDecision("choose", planBinding(sessionID, submitted.result.wf, submitted.planSha))
      if (runtime.linuxAdmission) runtime.linuxAdmission.assertBootEpoch()
      const current = confirmationWorkflow(controller, runtime, sessionID, submitted.result.wf.id, submitted.planSha)
      if (!current || current.lastSeq !== submitted.result.wf.lastSeq) {
        throw new Error("workflow revision changed during operator decision")
      }
      const decided = controller.decide(decision, sessionID)
      if (!decided.ok) throw new Error(decided.text)
      if (decision.action === "reject") return `workflow ${decided.wf.id} ${decided.wf.phase}; rejected by local operator`
      const result = await controller.run(sessionID)
      return completedRunText(result, runtime.worktree)
    }

    const before = confirmationWorkflow(controller, runtime, sessionID)
    if (before && isCancelPending(before)) throw new Error("workflow cancellation is pending")
    if (before?.phase === "paused" && args.command === "resume") return pausedResumeText(controller, sessionID)
    if (!before || before.phase !== "executing") throw new Error("no approved workflow to run")
    const admitted = await resumeCliSession(runtime, sessionID, store, before.lastSeq)
    if (admitted.epoch !== store.epoch) throw new Error("session attachment epoch changed")

    const abort = new AbortController()
    const stop = () => abort.abort()
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    try {
      const result = args.command === "resume"
        ? await controller.resume(sessionID, abort.signal)
        : await controller.run(sessionID, abort.signal)
      if (args.command === "resume" && (result.workflow.phase !== "done" || result.run.failed > 0 || result.run.cancelled > 0 ||
        result.run.aborted || result.run.refused || result.run.skipped || result.run.noSnapshot)) {
        throw new Error("common-engine resume incomplete; inspect read-only status")
      }
      return completedRunText(result, runtime.worktree)
    } finally {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
    }
  })
}

/** Status is engine-free; OpenCode uses its local service, while common recovery uses the selected CLI runtime. */
export async function runCli(
  args: CliArgs,
  cliRuntimeFactory: typeof createCliRuntime = createCliRuntime,
): Promise<string> {
  const root = args.worktree
  if (args.command === "status") {
    const flow = { worktree: root, config: loadConfig(root), log: () => {} }
    if (args.watch) {
      await runStatusWatch(args, flow)
      return ""
    }
    const status = statusJson(flow, args.session, { detail: args.detail })
    if (args.json) return JSON.stringify(status)
    const text = renderStatusSnapshot(status, args.session)
    return args.detail ? `${text}\n${renderStatusDetail(status)}` : text
  }
  if (args.engine !== "opencode" && COMMON_RECOVERY_COMMANDS.has(args.command)) {
    if (args.server !== undefined) throw new CliUsageError("common-engine workflow commands do not accept --server")
    if (!args.model || !args.session) throw new CliUsageError("common-engine workflow command requires explicit --model and --session")
    if ((args.command === "approve" || args.command === "reject") &&
      (!args.workflow || !args.sha)) throw new CliUsageError("approve and reject require --workflow and --sha")
    if (((args.command === "approve" || args.command === "reject") || (args.command === "run" && args.plan)) &&
      (!process.stdin.isTTY || !process.stderr.isTTY)) {
      throw new Error("local human approval or rejection requires an interactive terminal")
    }
    // Recovery uses the session's pinned routes from metadata, never the current otter.jsonc combo.
    // pause/cancel only request a stop, never dispatch a model, and neither read nor construct routes.
    const stopOnly = args.command === "pause" || args.command === "cancel"
    const routes = args.session && !stopOnly ? readSessionMetadata(root, args.session)?.routes : undefined
    const runtime = cliRuntimeFactory({ worktree: root, engine: args.engine, model: args.model, ...(routes ? { routes } : {}) })
    return runCommonCommand(args, runtime)
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
    log: (message, fields) => console.error(`otter: ${message}`, fields ? Object.keys(fields).join(",") : ""),
  }
  const runtime = getOpenCodeRuntime(deps)
  runtime.linuxAdmission?.assertBootEpoch()
  const controller = createForegroundController(runtime)
  if (args.command === "pause") {
    const result = controller.pause(args.session!)
    if (!result.ok) throw new Error(result.text)
    return stopText(result.wf)
  }
  if (args.command === "cancel") {
    const result = controller.cancel(args.session!)
    if (!result.ok) throw new Error(result.text)
    return stopText(result.wf)
  }
  if (args.command === "import") {
    const session = await client.session.get({ path: { id: args.session! }, query: { directory: root } })
    if (session.error || !session.data || realpathSync(session.data.directory) !== root) throw new Error("parent session is absent from the source worktree")
    const parsed = readCliPlan(root, args.plan!)
    controller.validateImportedPlan(parsed, args.session)
    const preflight = await runtime.host.preflight(runtime.host.identity.profile)
    assertHostAdmission(preflight)
    return withCliSession(runtime, args, args.session!, async store => {
      const existing = readWorkflow(root)
      if (store.metadata.held && existing?.sessionID === args.session!) {
        const confirmed = confirmationWorkflow(controller, runtime, args.session!, existing.id)
        await resumeCliSession(runtime, args.session!, store, confirmed?.lastSeq, client)
      } else if (store.metadata.held) {
        await resumeCliSession(runtime, args.session!, store, undefined, client)
      }
      const result = await controller.importPlan(args.session!, args.plan!, undefined, parsed)
      if (!result.result.ok) throw new Error(result.result.text)
      return `workflow ${result.result.wf.id} ${result.result.wf.phase}; plan_sha ${result.planSha}; inspect ${result.result.wf.planRef?.mdPath ?? "saved plan"}`
    })
  }
  if (args.command === "approve" || args.command === "reject") {
    const sessionID = args.session ?? readWorkflow(root)?.sessionID
    if (!sessionID) throw new Error("no workflow session for operator decision")
    return withCliSession(runtime, args, sessionID, async store => {
      const workflowID = args.workflow!
      const planSha = args.sha!
      const before = confirmationWorkflow(controller, runtime, sessionID, workflowID, planSha)
      if (!before || before.phase !== "pending_approval") throw new Error("no plan awaiting approval")
      const decision = await humanDecision(args.command as "approve" | "reject", planBinding(sessionID, before, planSha))
      runtime.linuxAdmission?.assertBootEpoch()
      const after = confirmationWorkflow(controller, runtime, sessionID, workflowID, planSha)
      if (!after || after.lastSeq !== before.lastSeq) throw new Error("workflow revision changed during operator decision")
      await resumeCliSession(runtime, sessionID, store, after.lastSeq, client)
      const result = controller.decide(decision, sessionID)
      if (!result.ok) throw new Error(result.text)
      return `workflow ${result.wf.id} ${result.wf.phase}`
    })
  }
  if (args.command === "run" && args.plan) {
    const parsed = readCliPlan(root, args.plan)
    controller.validateImportedPlan(parsed, args.session)
    const preflight = await runtime.host.preflight(runtime.host.identity.profile)
    assertHostAdmission(preflight)
    const existing = readWorkflow(root)
    let sessionID = args.session ?? (existing?.phase === "planning" ? existing.sessionID : undefined)
    if (!sessionID) {
      const created = await client.session.create({ body: { title: "otter foreground imported plan" }, query: { directory: root } })
      if (created.error || !created.data?.id) throw new Error("could not create an inert parent session")
      sessionID = created.data.id
    }
    return withCliSession(runtime, args, sessionID, async store => {
      if (store.metadata.held && existing?.sessionID === sessionID) {
        const confirmed = confirmationWorkflow(controller, runtime, sessionID, existing.id)
        await resumeCliSession(runtime, sessionID, store, confirmed?.lastSeq, client)
      } else if (store.metadata.held) {
        if (existing?.sessionID === sessionID) throw new Error("restored workflow requires its explicit owner command")
        await resumeCliSession(runtime, sessionID, store, undefined, client)
      }
      const abort = new AbortController()
      const stop = () => abort.abort()
      process.on("SIGINT", stop)
      process.on("SIGTERM", stop)
      try {
        const submitted = await controller.importPlan(sessionID, args.plan!, abort.signal, parsed)
        if (abort.signal.aborted) throw new Error("run cancelled before operator decision")
        if (!submitted.result.ok || submitted.result.wf.phase !== "pending_approval") {
          throw new Error("plan did not reach pending operator approval")
        }
        console.error(`otter: inspect ${submitted.result.wf.planRef?.mdPath ?? "saved canonical plan"}; workflow ${submitted.result.wf.id}; sha ${submitted.planSha}`)
        const decision = await humanDecision("choose", planBinding(sessionID, submitted.result.wf, submitted.planSha))
        runtime.linuxAdmission?.assertBootEpoch()
        const current = confirmationWorkflow(controller, runtime, sessionID, submitted.result.wf.id, submitted.planSha)
        if (!current || current.lastSeq !== submitted.result.wf.lastSeq) throw new Error("workflow revision changed during operator decision")
        const decided = controller.decide(decision, sessionID)
        if (!decided.ok) throw new Error(decided.text)
        if (decision.action === "reject") return `workflow ${decided.wf.id} ${decided.wf.phase}; rejected by local operator`
        return completedRunText(await controller.run(sessionID, abort.signal), root)
      } finally {
        process.off("SIGINT", stop)
        process.off("SIGTERM", stop)
      }
    })
  }

  const sessionID = args.session
  if (!sessionID) throw new CliUsageError(`${args.command} requires --session`)
  return withCliSession(runtime, args, sessionID, async store => {
    const before = confirmationWorkflow(controller, runtime, sessionID)
    if (before && isCancelPending(before)) throw new Error("workflow cancellation is pending")
    if (before?.phase === "paused" && args.command === "resume") return pausedResumeText(controller, sessionID)
    if (!before || before.phase !== "executing") throw new Error("no approved workflow to run")
    await resumeCliSession(runtime, sessionID, store, before.lastSeq, client)
    const abort = new AbortController()
    const stop = () => abort.abort()
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    try {
      return completedRunText(args.command === "resume"
        ? await controller.resume(sessionID, abort.signal)
        : await controller.run(sessionID, abort.signal), root)
    } finally {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
    }
  })
}

function failCli(error: unknown, command?: string): void {
  if (command === "status" && error instanceof StatusReadError) {
    console.error(`otter status: ${error.source} ${error.code}`)
    process.exitCode = 3
    return
  }
  if (error instanceof AdmissionRefusal) {
    const route = error.comboRoutes ? ` Combo route unavailable: ${error.comboRoutes}.` : ""
    console.error(`otter: host admission refused; required host control evidence is unavailable.${route} Use a host that can provide all required execution controls before proceeding. Check engine sign-in with \`otter auth\`; sign in with \`otter login codex\` or \`otter login claude\`.`)
    process.exitCode = 1
    return
  }
  if (error instanceof LinuxAdmissionRefused) {
    console.error(error.message)
    process.exitCode = 3
    return
  }
  if (error instanceof CliUsageError) {
    console.error(`otter: ${error.message}`)
    console.error("Run 'otter --help' for usage.")
    process.exitCode = 2
    return
  }
  if (error instanceof InteractiveLaunchError) {
    console.error(`otter: ${error.message}`)
    process.exitCode = 1
    return
  }
  console.error("otter: command refused or failed; inspect read-only status for durable state")
  process.exitCode = 1
}

function main(argv: string[]): void {
  const interactiveRequested = argv.length === 0 || argv[0] === "chat" ||
    ["--worktree", "--engine", "--model", "--resume", "--continue"].includes(argv[0]!)
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h") ||
    interactiveRequested && argv.some((arg) => arg === "--help" || arg === "-h")) {
    console.log(CLI_USAGE)
    return
  }
  if (argv[0] === "update") {
    updateCli(argv.slice(1)).then(code => { process.exitCode = code }).catch(failCli)
    return
  }
  if (argv[0] === "engines") {
    enginesCli(argv.slice(1)).then(code => { process.exitCode = code }).catch(failCli)
    return
  }
  if (argv[0] === "harness") {
    harnessCli(argv.slice(1)).then(text => { console.log(text) }).catch(error => failCli(error, "harness"))
    return
  }
  if (argv[0] === "auth" || argv[0] === "login" || argv[0] === "logout") {
    authCli(argv).then(code => { process.exitCode = code }).catch(failCli)
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
  let command: string | undefined = argv[0]
  try {
    const args = parseCliArgs(argv)
    command = args.command
    runCli(args).then(text => { if (text) console.log(text) }).catch(error => failCli(error, command))
  } catch (error) { failCli(error, command) }
}

/** `otter harness profile [--worktree PATH] [--json]`: read-only identity profile; builds no runtime and calls no model. */
export async function harnessCli(argv: readonly string[]): Promise<string> {
  const [sub, ...rest] = argv
  if (sub !== "profile") throw new CliUsageError("usage: otter harness profile [--worktree PATH] [--json]")
  let json = false
  let worktreeArg: string | undefined
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!
    if (flag === "--json" && !json) json = true
    else if (flag === "--worktree" && worktreeArg === undefined && rest[index + 1] && !rest[index + 1]!.startsWith("--")) worktreeArg = rest[++index]!
    else throw new CliUsageError("usage: otter harness profile [--worktree PATH] [--json]")
  }
  let worktree: string
  try {
    worktree = realpathSync(worktreeArg ?? process.cwd())
    if (!statSync(worktree).isDirectory()) throw new Error()
    accessSync(worktree, constants.R_OK | constants.X_OK)
  } catch {
    throw new CliUsageError("--worktree must name an accessible directory; check the path and permissions")
  }
  const profile = await harnessProfile(loadConfig(worktree), worktree, { homeDirectory: homedir() })
  return json ? JSON.stringify(profile) : renderProfile(profile)
}

/**
 * `otter auth [status]`, `otter login <codex|claude> [browser|device|console|api-key]`, `otter logout <codex|claude>`.
 * Delegates to the vendor CLI; otter never reads or stores a credential. Exit 0 = signed in (status/login) or signed
 * out (logout); 1 = not; 2 = usage.
 */
async function authCli(argv: readonly string[]): Promise<number> {
  const usage = "Usage: otter auth [status | --diagnose] | otter login <codex|claude> [browser|device|console|api-key] | otter logout <codex|claude>"
  const cwd = process.cwd()
  const [command, engineArg, methodArg, ...extra] = argv
  if (command === "auth" && (engineArg === "--diagnose" || engineArg === "diagnose") && methodArg === undefined) {
    // Sign-in as your shell sees it vs as otter's model calls see it, and what differs (variable names only, no values).
    const diagnoses = await Promise.all(AUTH_ENGINES.map(engine => diagnoseAuth(engine, cwd)))
    for (const diagnosis of diagnoses) console.log(describeDiagnosis(diagnosis).join("\n").replace(/\/login (\w+)/gu, "otter login $1"))
    return diagnoses.every(d => d.otter.state === "signed-in") ? 0 : 1
  }
  if (command === "auth" && (engineArg === undefined || engineArg === "status") && methodArg === undefined) {
    const states = await Promise.all(AUTH_ENGINES.map(engine => authStatus(engine, cwd)))
    for (const state of states) console.log(describeAuth(state).replace(/\/login (\w+)/u, "otter login $1"))
    console.log("local: no sign-in (Ollama on this machine)")
    return states.every(state => state.state === "signed-in") ? 0 : 1
  }
  if ((command !== "login" && command !== "logout") || extra.length || !(AUTH_ENGINES as readonly string[]).includes(engineArg ?? "") ||
      (command === "logout" && methodArg !== undefined)) {
    console.error(engineArg === "local" ? "The local engine (Ollama) needs no sign-in." : usage)
    return 2
  }
  const engine = engineArg as AuthEngine
  let argvFor: string[]
  try { argvFor = command === "login" ? loginArgv(engine, (methodArg ?? "browser") as LoginMethod) : logoutArgv(engine) }
  catch (error) { console.error(`${(error as Error).message}. ${usage}`); return 2 }
  if (methodArg !== undefined && !["browser", "device", "console", "api-key"].includes(methodArg)) { console.error(usage); return 2 }
  console.error(`$ ${engine} ${argvFor.join(" ")}`)
  const hint = command === "login" ? loginHint(engine, (methodArg ?? "browser") as LoginMethod) : undefined
  if (hint) console.error(hint.replace("/login codex device", "otter login codex device"))
  try { findExecutable(engine) }
  catch (error) { console.error(`${engine} ${describeAuthFailure(error)}.`); return 1 }
  let run: Awaited<ReturnType<typeof runVendorAuth>>
  try { run = await runVendorAuth(engine, argvFor, cwd) }
  catch (error) { console.error(`${engine} ${describeAuthFailure(error)}.`); return 1 }
  const after = await authStatus(engine, cwd)
  console.log(describeAuth(after).replace(/\/login (\w+)/u, "otter login $1"))
  if (run.signal !== null) {
    console.error(`${engine} ${command} command was terminated by ${run.signal}.`)
    return 1
  }
  if (run.exitCode !== 0) {
    console.error(run.exitCode === null
      ? `${engine} ${command} command ended without an exit code.`
      : `${engine} ${command} command exited with code ${run.exitCode}.`)
    return 1
  }
  return command === "login" ? (after.state === "signed-in" ? 0 : 1) : (after.state === "signed-out" ? 0 : 1)
}

/**
 * `otter engines` shows each vendor CLI, its version (Codex: whether otter supports it) and the update that fits its
 * install method; `otter engines update [codex|claude] [--yes]` runs it after confirmation. Exit 0 = every requested
 * engine ends up current or updated; 1 = something failed or needs a manual step; 2 = usage.
 */
async function enginesCli(argv: readonly string[]): Promise<number> {
  const usage = "Usage: otter engines | otter engines update [codex|claude] [--yes]"
  const yes = argv.includes("--yes")
  const rest = argv.filter(arg => arg !== "--yes")
  if (rest.length === 0) {
    for (const engine of UPDATABLE_ENGINES) { const info = engineInfo(engine); console.log(describeEngine(info, planEngineUpdate(info))) }
    return 0
  }
  if (rest[0] !== "update" || rest.length > 2 || (rest[1] !== undefined && !(UPDATABLE_ENGINES as readonly string[]).includes(rest[1]))) { console.error(usage); return 2 }
  const targets = rest[1] ? [rest[1] as UpdatableEngine] : [...UPDATABLE_ENGINES]
  let ok = true
  for (const engine of targets) {
    const plan = planEngineUpdate(engineInfo(engine))
    if (plan.action === "current") { console.log(`${engine}: ${plan.summary}.`); continue }
    if (plan.action === "manual") { console.log(`${engine}: ${plan.summary}`); ok = false; continue }
    console.error(`${engine}: ${plan.summary}`)
    plan.choices.forEach((choice, index) => console.error(`  ${index + 1}) ${choice.label}${choice.note ? ` — ${choice.note}` : ""}\n     $ ${choice.argv.join(" ")}`))
    // --yes takes the recommended command (never an alternative such as sudo).
    let choice = plan.choices[0]!
    if (!yes) {
      if (!process.stdin.isTTY) { console.error("Not a terminal: re-run with --yes to run choice 1."); ok = false; continue }
      const answer = await new Promise<string>(resolve => {
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        rl.question(`Run which? [1-${plan.choices.length}, Enter = keep] `, value => { rl.close(); resolve(value) })
      })
      const picked = Number.parseInt(answer.trim(), 10)
      if (!Number.isInteger(picked) || picked < 1 || picked > plan.choices.length) { console.log(`${engine}: kept.`); continue }
      choice = plan.choices[picked - 1]!
    }
    const run = await runEngineUpdate(choice.argv)
    const { info: after, shadowed } = verifyEngineUpdate(engine)
    const succeeded = run.exitCode === 0 && !shadowed && after.version !== undefined && (engine !== "codex" || after.supported === true)
    const now = `${after.version ?? "unknown"}${engine === "codex" ? (after.supported ? " (otter-supported)" : " (not otter-supported)") : ""}`
    if (succeeded) console.log(`${engine}: updated — now ${now}.`)
    else if (shadowed) console.log(`${engine}: installed ${shadowed.version} at ${shadowed.path}, but PATH still runs ${after.path ?? "an older copy"} (${after.version ?? "unknown"}). Put ${shadowed.path.replace(/\/[^/]+$/u, "")} first on PATH or remove the older copy, then open a new terminal.`)
    else {
      const index = plan.choices.indexOf(choice)
      const next = plan.choices[index + 1]
      console.log(`${engine}: update did not finish (${describeUpdateFailure(choice.argv, run)}) — now ${now}.${next ? ` Try again and pick ${index + 2}) ${next.label}.` : ""}`)
    }
    if (!succeeded) ok = false
  }
  return ok ? 0 : 1
}

if (import.meta.main) main(process.argv.slice(2))
