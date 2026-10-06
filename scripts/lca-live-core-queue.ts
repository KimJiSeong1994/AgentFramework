#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { canonicalPlanSha, coercePlan, planToTasks, validatePlan, type Plan } from "../framework/src/flow/plan.ts"
import { loadConfig, type LcaConfig } from "../framework/src/config.ts"
import { getOpenCodeRuntime } from "../framework/src/hosts/opencode-runtime.ts"
import type {
  ExecutionCancelResult,
  ExecutionHandle,
  ExecutionHost,
  ExecutionOutcome,
  ExecutionReconciliation,
  ExecutionRequest,
  ExecutionRole,
  ExecutionRuntime,
} from "../framework/src/hosts/types.ts"
import type { HookDeps } from "../framework/src/hooks/types.ts"
import { createQueue, type Queue, type QueueRun } from "../framework/src/orchestration/queue.ts"
import { readLedger, type Ledger, type LedgerTask, type TaskInput } from "../framework/src/state/ledger.ts"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const FRAMEWORK_PACKAGE = resolve(SCRIPT_DIR, "../framework/package.json")
const BUSY_POLL_MS = 10_000
const BUSY_POLL_INTERVAL_MS = 100
const INJECTED_CODE = 'def normalize_space(text):\n    return ""\n'

type Scenario = "retry" | "reject" | "cancel" | "interrupt" | "checkpoint" | "resume"
type Args = { worktree: string; server: string; scenario: Scenario; receipt: string; session?: string }
type AnyRecord = Record<string, unknown>

type ChildRecord = {
  role: ExecutionRole
  taskID: string
  attemptID: string
  executionID: string
  vendorSessionID?: string
  preparedAt: number
  dispatchedAt?: number
  runFinishedAt?: number
  hostRunReturn?: { status: ExecutionOutcome["status"]; childMessageID?: string }
  runFailure?: { name: string; message: string }
  requestCancelCalls: Array<{
    requestedAt: number
    reason: string
    returnedAt?: number
    result?: ExecutionCancelResult
    failure?: { name: string; message: string }
  }>
}

type BusyObservation = {
  vendorSessionID: string
  taskID: string
  observed: "busy" | "not_busy_within_deadline" | "worker_finished_before_busy"
  polls: number
  statusErrors: number
  lastStatus?: string
  startedAt: number
  finishedAt: number
}

type Receipt = {
  schemaVersion: 1
  receiptPath: string
  scenario: Scenario
  baseIdentity: {
    worktree: string
    gitRoot: string
    serverOrigin: string
    script: string
    processID: number
    platform: string
    architecture: string
    startedAt: string
    sdkEntry?: string
  }
  nativeSessionIDs: { parentSessionID?: string; childSessionIDs: string[] }
  plan?: { path: string; sha256: string; stepCount: number }
  runs: AnyRecord[]
  failures: Array<{ at: string; phase: string; name: string; message: string }>
}

function fail(message: string): never {
  throw new Error(message)
}

function parseArgs(argv: string[]): Args {
  const fields = new Map<string, string>()
  const allowed = new Set(["--worktree", "--server", "--scenario", "--receipt", "--session"])
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (!allowed.has(flag) || fields.has(flag)) fail(`invalid or duplicate option ${flag}`)
    const value = argv[++i]
    if (!value || value.startsWith("--")) fail(`missing value for ${flag}`)
    fields.set(flag, value)
  }

  const worktreeArg = fields.get("--worktree")
  const serverArg = fields.get("--server")
  const scenario = fields.get("--scenario")
  const receipt = fields.get("--receipt")
  if (!worktreeArg || !serverArg || !scenario || !receipt) {
    fail("usage: bun scripts/lca-live-core-queue.ts --worktree ABSOLUTE_GIT_ROOT --server http://127.0.0.1:PORT --scenario retry|reject|cancel|interrupt|checkpoint|resume --receipt ABSOLUTE_JSON_PATH [--session ID]")
  }
  if (!(scenario === "retry" || scenario === "reject" || scenario === "cancel" || scenario === "interrupt" || scenario === "checkpoint" || scenario === "resume")) {
    fail("--scenario must be retry, reject, cancel, interrupt, checkpoint, or resume")
  }
  if (!isAbsolute(worktreeArg)) fail("--worktree must be absolute and canonical")
  if (!isAbsolute(receipt)) fail("--receipt must be an absolute scratch JSON path")
  if (scenario === "resume" && !fields.get("--session")) fail("--session is required for resume")
  if (scenario !== "resume" && fields.has("--session")) fail("--session is only accepted for resume; other scenarios create a new inert parent session")

  const worktree = realpathSync(worktreeArg)
  if (resolve(worktreeArg) !== worktree) fail("--worktree must be the canonical real path")
  const server = loopbackServer(serverArg)
  const receiptPath = canonicalReceiptPath(receipt)
  const rel = relative(worktree, receiptPath)
  if (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) {
    fail("--receipt must be outside the worktree")
  }
  return {
    worktree,
    server,
    scenario,
    receipt: receiptPath,
    ...(fields.get("--session") ? { session: fields.get("--session")! } : {}),
  }
}

function loopbackServer(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { return fail("--server must be an explicit loopback HTTP URL with a port") }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !url.port || !Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535) {
    fail("--server must be an explicit loopback HTTP URL with a port")
  }
  return url.origin
}

function canonicalReceiptPath(value: string): string {
  const absolute = resolve(value)
  if (!existsSync(dirname(absolute))) fail("--receipt parent directory must already exist")
  const parent = realpathSync(dirname(absolute))
  const path = resolve(parent, basename(absolute))
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail("--receipt cannot be a symlink")
  return path
}

function validateWorktree(worktree: string): void {
  const gitRoot = execFileSync("git", ["-C", worktree, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
  if (realpathSync(gitRoot) !== worktree) fail("--worktree must be the canonical Git root, not a subdirectory")
  for (const path of [
    resolve(worktree, "plan.json"),
    resolve(worktree, ".opencode/plugins/lca.ts"),
    resolve(worktree, ".lca/lca.jsonc"),
  ]) {
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      fail(`required fixture file is absent or not a regular file: ${relative(worktree, path)}`)
    }
  }
}

function readFixturePlan(worktree: string, config: LcaConfig): Plan {
  const path = resolve(worktree, "plan.json")
  const source = readFileSync(path, "utf8")
  const raw = JSON.parse(source) as { revision?: unknown }
  if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.revision)) fail("plan.json must contain a safe integer revision")
  const plan = coercePlan(raw, raw.revision as number)
  if (plan.steps.length !== 3) fail(`plan.json must contain exactly three canonical steps (got ${plan.steps.length})`)
  const problems = validatePlan(plan, worktree, config.delegate.verify_allow)
  if (problems.length) fail(`plan.json failed core plan validation: ${problems.join("; ")}`)
  return plan
}

function loadSDK(): Promise<{ createOpencodeClient: (options: { baseUrl: string; directory: string }) => any; entry: string }> {
  const entry = Bun.resolveSync("@opencode-ai/sdk", dirname(FRAMEWORK_PACKAGE))
  return import(pathToFileURL(entry).href).then((sdk: any) => {
    if (typeof sdk.createOpencodeClient !== "function") fail("resolved @opencode-ai/sdk does not export createOpencodeClient")
    return { createOpencodeClient: sdk.createOpencodeClient, entry }
  })
}

async function connect(client: any, worktree: string): Promise<void> {
  const [path, config, agents] = await Promise.all([
    client.path.get({ query: { directory: worktree } }),
    client.config.get({ query: { directory: worktree } }),
    client.app.agents({ query: { directory: worktree } }),
  ])
  if (path.error || !path.data?.worktree || realpathSync(path.data.worktree) !== worktree) {
    fail("OpenCode server worktree does not match the canonical fixture root")
  }
  const plugin = pathToFileURL(resolve(worktree, ".opencode/plugins/lca.ts")).href
  if (config.error || !Array.isArray(config.data?.plugin) || config.data.plugin.length !== 1 || config.data.plugin[0] !== plugin) {
    fail("OpenCode server must load only the fixture's LCA plugin")
  }
  if (agents.error || !Array.isArray(agents.data)
    || !["main", "worker", "reviewer"].every((name) => agents.data.some((agent: any) => agent.name === name))) {
    fail("OpenCode server lacks the real LCA main, worker, or reviewer agent")
  }
  if (agents.data.find((agent: any) => agent.name === "worker")?.mode !== "subagent"
    || agents.data.find((agent: any) => agent.name === "reviewer")?.mode !== "subagent") {
    fail("OpenCode worker and reviewer must be configured as subagents")
  }
}

async function parentSession(client: any, worktree: string, sessionID?: string): Promise<string> {
  if (sessionID) {
    const result = await client.session.get({ path: { id: sessionID }, query: { directory: worktree } })
    if (result.error || !result.data || !result.data.directory || realpathSync(result.data.directory) !== worktree) {
      fail("resume parent session is absent from the canonical fixture worktree")
    }
    return sessionID
  }
  const result = await client.session.create({
    body: { title: "lca live core queue fault driver" },
    query: { directory: worktree },
  })
  if (result.error || typeof result.data?.id !== "string" || !result.data.id) fail("OpenCode did not create an inert parent session")
  const checked = await client.session.get({ path: { id: result.data.id }, query: { directory: worktree } })
  if (checked.error || !checked.data?.directory || realpathSync(checked.data.directory) !== worktree) {
    fail("new inert parent session does not belong to the canonical fixture worktree")
  }
  return result.data.id
}

function initialReceipt(args: Args): Receipt {
  return {
    schemaVersion: 1,
    receiptPath: args.receipt,
    scenario: args.scenario,
    baseIdentity: {
      worktree: args.worktree,
      gitRoot: args.worktree,
      serverOrigin: args.server,
      script: basename(fileURLToPath(import.meta.url)),
      processID: process.pid,
      platform: process.platform,
      architecture: process.arch,
      startedAt: new Date().toISOString(),
    },
    nativeSessionIDs: { childSessionIDs: [] },
    runs: [],
    failures: [],
  }
}

function beginReceipt(args: Args): Receipt {
  if (args.scenario !== "resume") {
    const receipt = initialReceipt(args)
    const fd = openSync(args.receipt, "wx", 0o600)
    try { writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`); fsyncSync(fd) }
    finally { closeSync(fd) }
    return receipt
  }

  let prior: Receipt
  try { prior = JSON.parse(readFileSync(args.receipt, "utf8")) as Receipt }
  catch { return fail("resume requires a readable receipt from the interrupted run") }
  if (prior.schemaVersion !== 1 || !["interrupt", "checkpoint", "resume"].includes(prior.scenario) || prior.baseIdentity.worktree !== args.worktree
    || prior.baseIdentity.serverOrigin !== args.server || prior.nativeSessionIDs.parentSessionID !== args.session
    || !Array.isArray(prior.runs) || !["interrupt", "checkpoint"].includes(String(prior.runs[0]?.scenario))
    || !Array.isArray(prior.failures) || !Array.isArray(prior.nativeSessionIDs.childSessionIDs)) {
    fail("resume receipt does not identify the matching interrupted worktree, server, and parent session")
  }
  prior.scenario = "resume"
  prior.receiptPath = args.receipt
  return prior
}

function persistReceipt(path: string, receipt: Receipt): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  const fd = openSync(temporary, "wx", 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(temporary, path)
}

function recordFailure(receipt: Receipt, phase: string, error: unknown): void {
  const name = error instanceof Error ? error.name : "Error"
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .slice(0, 800)
  receipt.failures.push({ at: new Date().toISOString(), phase, name: name.slice(0, 100), message })
}

function executionSessionID(vendorRef: unknown): string | undefined {
  if (typeof vendorRef !== "string") return undefined
  try {
    const parsed = JSON.parse(vendorRef) as { vendorSessionID?: unknown }
    return typeof parsed.vendorSessionID === "string" ? parsed.vendorSessionID : undefined
  } catch { return undefined }
}

function summarizeLedger(ledger: Ledger): AnyRecord {
  return {
    sessionID: ledger.sessionID,
    running: ledger.running ? { ...ledger.running } : undefined,
    tasks: ledger.tasks.map((task: LedgerTask) => ({
      id: task.id,
      n: task.n,
      status: task.status,
      attempts: task.attempts,
      workerSessionID: task.workerSessionID,
      childSessions: [...task.childSessions],
      verify: task.verify,
      verifyResult: task.verify_result ? {
        command: task.verify_result.command,
        ok: task.verify_result.ok,
        exitCode: task.verify_result.exitCode,
        timedOut: task.verify_result.timedOut,
      } : undefined,
      review: task.review ? {
        verdict: task.review.verdict,
        sessionID: task.review.sessionID,
        reason: task.review.reason?.slice(0, 300),
      } : undefined,
      error: task.error?.slice(0, 300),
    })),
  }
}

function summarizeExecutions(runtime: ExecutionRuntime, ownerSessionID?: string): AnyRecord {
  const state = runtime.runs.status()
  return {
    generation: state.generation,
    claim: state.claim,
    executions: state.executions.filter((execution: any) => !ownerSessionID || execution.ownerSession === ownerSessionID).map((execution: any) => ({
      executionID: execution.executionId,
      kind: execution.kind,
      role: execution.role,
      ownerSession: execution.ownerSession,
      taskID: execution.taskId,
      attemptID: execution.attemptId,
      generation: execution.generation,
      vendorSessionID: executionSessionID(execution.vendorRef),
      cancel: execution.cancel ? { ...execution.cancel } : undefined,
      terminal: execution.terminal ? {
        outcome: execution.terminal.outcome,
        terminalAt: execution.terminal.terminalAt,
        verification: execution.terminal.verification ? {
          parentExit: execution.terminal.verification.parentExit,
          timedOut: execution.terminal.verification.timedOut,
          cancelled: execution.terminal.verification.cancelled,
          isolationEstablished: execution.terminal.verification.isolationEstablished,
          domainState: execution.terminal.verification.domainState,
          integrity: execution.terminal.verification.integrity,
        } : undefined,
      } : undefined,
      reconciliation: execution.reconciliation ? {
        outcome: execution.reconciliation.outcome,
        quiescent: execution.reconciliation.quiescent,
        evidence: String(execution.reconciliation.evidence ?? "").slice(0, 300),
      } : undefined,
      fence: execution.fence ? { reason: String(execution.fence.reason).slice(0, 300), at: execution.fence.at } : undefined,
    })),
  }
}

function snapshot(runtime: ExecutionRuntime, worktree: string, sessionID: string): AnyRecord {
  return {
    ledger: summarizeLedger(readLedger(worktree, sessionID)),
    executionState: summarizeExecutions(runtime, sessionID),
  }
}

function appendNativeChild(receipt: Receipt, id?: string): void {
  if (id && !receipt.nativeSessionIDs.childSessionIDs.includes(id)) receipt.nativeSessionIDs.childSessionIDs.push(id)
}

function childSessionIDsFromState(state: AnyRecord): string[] {
  const executions = Array.isArray(state.executions) ? state.executions as AnyRecord[] : []
  return executions.map((e) => e.vendorSessionID).filter((id): id is string => typeof id === "string")
}

function installTrackedHost(
  runtime: ExecutionRuntime,
  scenario: Scenario,
  worktree: string,
  receipt: Receipt,
  children: ChildRecord[],
  injection: AnyRecord,
): void {
  const actual: ExecutionHost = runtime.host
  const wrapped: ExecutionHost = {
    identity: actual.identity,
    preflight(profile: string) { return actual.preflight(profile) },
    reconcile(reference) { return actual.reconcile(reference) },
    async prepare(request: ExecutionRequest): Promise<ExecutionHandle> {
      const handle = await actual.prepare(request)
      const child: ChildRecord = {
        role: request.role,
        taskID: request.taskID,
        attemptID: request.attemptID,
        executionID: request.executionID,
        vendorSessionID: handle.reference.vendorSessionID,
        preparedAt: Date.now(),
        requestCancelCalls: [],
      }
      children.push(child)
      appendNativeChild(receipt, child.vendorSessionID)
      return {
        reference: handle.reference,
        async run(): Promise<ExecutionOutcome> {
          child.dispatchedAt = Date.now()
          try {
            const outcome = await handle.run()
            child.runFinishedAt = Date.now()
            child.hostRunReturn = {
              status: outcome.status,
              ...(outcome.childMessageID ? { childMessageID: outcome.childMessageID } : {}),
            }
            if (scenario === "reject" && request.role === "worker" && outcome.status === "completed" && !injection.appliedAt) {
              applyRejectInjection(worktree, child, injection)
            }
            return outcome
          } catch (error) {
            child.runFinishedAt = Date.now()
            child.runFailure = errorRecord(error)
            throw error
          }
        },
        async requestCancel(reason: string, deadlineAt: number): Promise<ExecutionCancelResult> {
          const call: ChildRecord["requestCancelCalls"][number] = { requestedAt: Date.now(), reason }
          child.requestCancelCalls.push(call)
          try {
            const result = await handle.requestCancel(reason, deadlineAt)
            call.returnedAt = Date.now()
            call.result = { ...result }
            return result
          } catch (error) {
            call.returnedAt = Date.now()
            call.failure = errorRecord(error)
            throw error
          }
        },
        reconcile(): Promise<ExecutionReconciliation> { return handle.reconcile() },
      }
    },
  }
  runtime.host = wrapped
}

function errorRecord(error: unknown): { name: string; message: string } {
  return {
    name: (error instanceof Error ? error.name : "Error").slice(0, 100),
    message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  }
}

function applyRejectInjection(worktree: string, child: ChildRecord, injection: AnyRecord): void {
  const path = resolve(worktree, "text_ops.py")
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(path) !== path) fail("reject injection target must be the regular root-level text_ops.py file")
  const before = readFileSync(path, "utf8")
  const separator = before.length === 0 || before.endsWith("\n") ? "\n" : "\n\n"
  const fd = openSync(path, "a")
  try { writeFileSync(fd, `${separator}${INJECTED_CODE}`); fsyncSync(fd) }
  finally { closeSync(fd) }
  injection.source = "driver_fault_injection"
  injection.relation = "after_completed_real_worker_host_run"
  injection.taskID = child.taskID
  injection.workerSessionID = child.vendorSessionID
  injection.path = "text_ops.py"
  injection.code = INJECTED_CODE
  injection.appliedAt = new Date().toISOString()
}

async function waitForBusy(client: any, worktree: string, child: ChildRecord): Promise<BusyObservation> {
  const startedAt = Date.now()
  const observation: BusyObservation = {
    vendorSessionID: child.vendorSessionID ?? "",
    taskID: child.taskID,
    observed: "not_busy_within_deadline",
    polls: 0,
    statusErrors: 0,
    startedAt,
    finishedAt: startedAt,
  }
  if (!child.vendorSessionID) return observation
  const deadline = startedAt + BUSY_POLL_MS
  while (Date.now() < deadline) {
    observation.polls++
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = Symbol("status-timeout")
      const result = await Promise.race([
        client.session.status({ query: { directory: worktree } }),
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), Math.max(0, deadline - Date.now()))
        }),
      ])
      if (result === timeout) {
        observation.statusErrors++
        break
      }
      if (result.error || !result.data) observation.statusErrors++
      else {
        const status = result.data[child.vendorSessionID]?.type
        if (typeof status === "string") observation.lastStatus = status
        if (status === "busy") {
          observation.observed = "busy"
          observation.finishedAt = Date.now()
          return observation
        }
      }
    } catch {
      observation.statusErrors++
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (child.runFinishedAt) {
      observation.observed = "worker_finished_before_busy"
      observation.finishedAt = Date.now()
      return observation
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(BUSY_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))))
  }
  observation.finishedAt = Date.now()
  return observation
}

function workerDispatchCount(children: ChildRecord[]): number {
  return children.filter((child) => child.role === "worker" && child.dispatchedAt !== undefined).length
}

function workerForTask(children: ChildRecord[], taskID: string): ChildRecord | undefined {
  return [...children].reverse().find((child) => child.role === "worker" && child.taskID === taskID && child.dispatchedAt !== undefined)
}

function addScenarioFailure(receipt: Receipt, run: AnyRecord, message: string): void {
  recordFailure(receipt, String(run.scenario), new Error(message))
}

function validateRetryObservation(receipt: Receipt, run: AnyRecord, runtime: ExecutionRuntime, tasks: LedgerTask[]): void {
  const verifications = summarizeExecutions(runtime, String(run.parentSessionID)).executions as AnyRecord[]
  const exits = verifications
    .filter((execution) => execution.kind === "verifier")
    .map((execution) => execution.terminal as AnyRecord | undefined)
    .filter((terminal) => terminal?.verification)
    .map((terminal) => (terminal!.verification as AnyRecord).parentExit)
  run.observedVerifierExitCodes = exits
  if (exits.length < 2 || exits[0] === 0 || exits.at(-1) !== 0) {
    addScenarioFailure(receipt, run, `retry did not observe a real verifier failure followed by a real verifier pass; exits=${JSON.stringify(exits)}`)
  }
  if (tasks[0]?.status !== "done" || tasks[0]?.attempts !== 2) {
    addScenarioFailure(receipt, run, `retry ledger outcome was ${tasks[0]?.status ?? "missing"} after ${tasks[0]?.attempts ?? 0} attempts`)
  }
}

function createRuntime(worktree: string, client: any, scenario: Scenario): { runtime: ExecutionRuntime; queue: Queue } {
  const config = loadConfig(worktree)
  const attempts = scenario === "retry" ? 2 : 1
  if (!config.delegate.review || !config.delegate.review_strict || config.delegate.worktree ||
    config.delegate.max_attempts !== attempts) {
    fail(`fixture .lca/lca.jsonc must set review=true, review_strict=true, worktree=false, max_attempts=${attempts}; local overrides would conflict with the server's fixed policy`)
  }
  const deps: HookDeps = {
    client,
    directory: worktree,
    worktree,
    config,
    log: () => {},
  }
  const runtime = getOpenCodeRuntime(deps)
  return { runtime, queue: createQueue(runtime) }
}

async function runDriver(args: Args, receipt: Receipt): Promise<void> {
  let phase = "validate fixture"
  try {
    validateWorktree(args.worktree)
    const loaded = loadConfig(args.worktree)
    const plan = readFixturePlan(args.worktree, loaded)
    receipt.plan = {
      path: resolve(args.worktree, "plan.json"),
      sha256: canonicalPlanSha(plan),
      stepCount: plan.steps.length,
    }

    phase = "resolve real OpenCode SDK"
    const sdk = await loadSDK()
    receipt.baseIdentity.sdkEntry = sdk.entry
    const client = sdk.createOpencodeClient({ baseUrl: args.server, directory: args.worktree })

    phase = "check running OpenCode server"
    await connect(client, args.worktree)

    phase = "create or validate native parent session"
    const parentID = await parentSession(client, args.worktree, args.session)
    receipt.nativeSessionIDs.parentSessionID = parentID

    const run: AnyRecord = {
      scenario: args.scenario,
      parentSessionID: parentID,
      processID: process.pid,
      sdkEntry: sdk.entry,
      startedAt: new Date().toISOString(),
      planSha256: canonicalPlanSha(plan),
    }
    receipt.runs.push(run)
    let { runtime, queue } = createRuntime(args.worktree, client, args.scenario)
    const children: ChildRecord[] = []
    const injection: AnyRecord = {}
    installTrackedHost(runtime, args.scenario, args.worktree, receipt, children, injection)
    run.children = children

    if (args.scenario === "resume") {
      phase = "read interrupted ledger without resetting it"
      const beforeLedger = readLedger(args.worktree, parentID)
      if (beforeLedger.tasks.length !== 3 || beforeLedger.tasks.some((task, index) => task.id !== `t${index + 1}`)) {
        fail("resume requires the existing three-task interrupt ledger; no tasks were added")
      }
      const before = snapshot(runtime, args.worktree, parentID)
      run.before = before
      run.beforeChildSessionIDs = childSessionIDsFromState(before.executionState as AnyRecord)
      run.beforeAttempts = Object.fromEntries(beforeLedger.tasks.map((task) => [task.id, task.attempts]))
      run.completedTaskIDsBefore = beforeLedger.tasks.filter((task) => task.status === "done").map((task) => task.id)

      phase = "resume existing queue ledger"
      const queueResult: QueueRun = await queue.run(parentID, { resumed: true })
      run.queueResult = queueResult
      const afterLedger = readLedger(args.worktree, parentID)
      const after = snapshot(runtime, args.worktree, parentID)
      run.after = after
      run.afterChildSessionIDs = childSessionIDsFromState(after.executionState as AnyRecord)
      run.afterAttempts = Object.fromEntries(afterLedger.tasks.map((task) => [task.id, task.attempts]))
      run.completedTaskIDsAfter = afterLedger.tasks.filter((task) => task.status === "done").map((task) => task.id)
      const completedBefore = run.completedTaskIDsBefore as string[]
      const completedAfter = run.completedTaskIDsAfter as string[]
      run.preservedCompletedTaskIDs = completedBefore.filter((id) => completedAfter.includes(id))
      for (const id of run.afterChildSessionIDs as string[]) appendNativeChild(receipt, id)
      if (queueResult.aborted || afterLedger.tasks.some(task => task.status !== "done")) {
        addScenarioFailure(receipt, run, "resume did not complete the remaining tasks; inspect the retained execution fence")
      }
      if (children.some(child => child.role === "worker" && completedBefore.includes(child.taskID))) {
        addScenarioFailure(receipt, run, "resume dispatched a previously completed task")
      }
      return
    }

    phase = "convert plan steps to real queue tasks"
    const allInputs: TaskInput[] = planToTasks(plan)
    const taskCount = args.scenario === "retry" || args.scenario === "reject" ? 1 : args.scenario === "cancel" ? 2 : 3
    const inputs = allInputs.slice(0, taskCount)
    const preexisting = readLedger(args.worktree, parentID)
    if (preexisting.tasks.length) fail("new inert parent session unexpectedly already has queue tasks")
    const added = queue.add(parentID, inputs)
    run.addedTaskIDs = added.map((task) => task.id)
    run.selectedPlanStepCount = inputs.length
    run.taskSelection = inputs.map((task, index) => ({ taskID: added[index]?.id, title: task.title, verify: task.verify }))

    if (args.scenario === "reject") {
      const target = resolve(args.worktree, "text_ops.py")
      if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) {
        fail("reject scenario requires a regular root-level text_ops.py injection target")
      }
    }

    phase = "run real queue workers"
    const queuePromise = queue.run(parentID)

    if (args.scenario === "cancel") {
      const targetTaskID = added[0]!.id
      const deadlineChild = async (): Promise<ChildRecord | undefined> => {
        const deadline = Date.now() + BUSY_POLL_MS
        while (Date.now() < deadline) {
          const child = workerForTask(children, targetTaskID)
          if (child) return child
          await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_INTERVAL_MS))
        }
        return undefined
      }
      const targetChild = await deadlineChild()
      const busy: BusyObservation = targetChild
        ? await waitForBusy(client, args.worktree, targetChild)
        : {
          vendorSessionID: "",
          taskID: targetTaskID,
          observed: "not_busy_within_deadline",
          polls: 0,
          statusErrors: 0,
          startedAt: Date.now() - BUSY_POLL_MS,
          finishedAt: Date.now(),
        }
      run.firstWorkerBusyObservation = busy
      if (busy.observed === "busy") {
        const cancelStartedAt = new Date().toISOString()
        const cancelCountBefore = children.reduce((sum, child) => sum + child.requestCancelCalls.length, 0)
        run.beforeAbort = snapshot(runtime, args.worktree, parentID)
        await queue.abort(parentID, "user_stop")
        const cancelCountAfter = children.reduce((sum, child) => sum + child.requestCancelCalls.length, 0)
        const cancelCalls = children.flatMap((child) => child.requestCancelCalls)
        run.queueAbort = {
          invoked: true,
          reason: "user_stop",
          startedAt: cancelStartedAt,
          returnedAt: new Date().toISOString(),
          handleRequestCancelCallsBefore: cancelCountBefore,
          handleRequestCancelCallsAfter: cancelCountAfter,
          handleRequestCancelCallDelta: cancelCountAfter - cancelCountBefore,
          serverAbortRequestsReported: cancelCalls.filter((call) => call.result?.requested === true).length,
          serverAbortAcknowledgementsReported: cancelCalls.filter((call) => call.result?.acknowledged === true).length,
        }
      } else {
        run.queueAbort = { invoked: false, reason: "user_stop", explanation: "first worker was not confirmed busy" }
        addScenarioFailure(receipt, run, `first worker was not confirmed busy within ${BUSY_POLL_MS}ms (${busy.observed})`)
      }

      const firstResult = await queuePromise
      run.queueResult = firstResult
      run.afterFirstRun = snapshot(runtime, args.worktree, parentID)
      const workerCountBeforeRetry = workerDispatchCount(children)
      run.retryQueueResult = await queue.run(parentID)
      run.workerDispatchesBeforeRetry = workerCountBeforeRetry
      run.workerDispatchesAfterRetry = workerDispatchCount(children)
      const newWorkerDispatch = workerDispatchCount(children) > workerCountBeforeRetry
      run.newWorkerDispatchOnRetry = newWorkerDispatch
      run.afterRetry = snapshot(runtime, args.worktree, parentID)
      if (newWorkerDispatch) addScenarioFailure(receipt, run, "a new worker was dispatched by queue.run after user_stop")
      return
    }

    if (args.scenario === "checkpoint") {
      const deadline = Date.now() + runtime.config.delegate.task_ttl_ms +
        runtime.config.delegate.review_ttl_ms + runtime.config.delegate.verify_timeout_ms + BUSY_POLL_MS
      while (Date.now() < deadline) {
        const ledger = readLedger(args.worktree, parentID)
        const state = runtime.runs.status()
        if (ledger.tasks[0]?.status === "done" && ledger.tasks.slice(1).every(task => task.status === "pending") &&
          !state.executions.some(execution => execution.ownerSession === parentID && execution.taskId === added[1]!.id)) {
          run.interruption = {
            boundary: "verified_task_checkpoint_before_next_execution_intent",
            persistedAt: new Date().toISOString(),
            parentSessionID: parentID,
            completedTaskIDs: [added[0]!.id],
            ledger: summarizeLedger(ledger),
            executionState: summarizeExecutions(runtime, parentID),
          }
          persistReceipt(args.receipt, receipt)
          writeSync(1, Buffer.from(`${JSON.stringify({ receipt: args.receipt })}\n`))
          process.kill(process.pid, "SIGKILL")
          throw new Error("SIGKILL returned unexpectedly")
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      addScenarioFailure(receipt, run, "verified checkpoint was not observed before the next execution intent")
      run.queueResult = await queuePromise
      run.after = snapshot(runtime, args.worktree, parentID)
      return
    }

    if (args.scenario === "interrupt") {
      const targetTaskID = added[1]!.id
      const deadline = Date.now() + runtime.config.delegate.task_ttl_ms +
        runtime.config.delegate.review_ttl_ms + runtime.config.delegate.verify_timeout_ms + BUSY_POLL_MS
      let targetChild: ChildRecord | undefined
      while (Date.now() < deadline && !targetChild) {
        targetChild = workerForTask(children, targetTaskID)
        if (!targetChild) await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_INTERVAL_MS))
      }
      const busy: BusyObservation = targetChild
        ? await waitForBusy(client, args.worktree, targetChild)
        : {
          vendorSessionID: "",
          taskID: targetTaskID,
          observed: "not_busy_within_deadline",
          polls: 0,
          statusErrors: 0,
          startedAt: Date.now() - BUSY_POLL_MS,
          finishedAt: Date.now(),
        }
      run.secondTaskWorkerBusyObservation = busy
      if (busy.observed !== "busy" || !targetChild) {
        addScenarioFailure(receipt, run, `task ${targetTaskID} worker was not confirmed busy (${busy.observed})`)
        run.queueResult = await queuePromise
        run.after = snapshot(runtime, args.worktree, parentID)
        run.finishedAt = new Date().toISOString()
        return
      }

      const currentLedger = readLedger(args.worktree, parentID)
      run.interruption = {
        persistedAt: new Date().toISOString(),
        parentSessionID: parentID,
        vendorChildSessionID: targetChild.vendorSessionID,
        targetTaskID,
        completedTaskIDs: currentLedger.tasks.filter((task) => task.status === "done").map((task) => task.id),
        runningTaskID: currentLedger.running?.taskId,
        ledger: summarizeLedger(currentLedger),
        executionState: summarizeExecutions(runtime, parentID),
      }
      run.finishedAt = new Date().toISOString()
      persistReceipt(args.receipt, receipt)
      writeSync(1, Buffer.from(`${JSON.stringify({ receipt: args.receipt })}\n`))
      process.kill(process.pid, "SIGKILL")
      throw new Error("SIGKILL returned unexpectedly")
    }

    const queueResult = await queuePromise
    run.queueResult = queueResult
    run.injection = Object.keys(injection).length ? injection : undefined
    const after = snapshot(runtime, args.worktree, parentID)
    run.after = after
    const ledger = readLedger(args.worktree, parentID)
    if (args.scenario === "retry") validateRetryObservation(receipt, run, runtime, ledger.tasks)
    if (args.scenario === "reject") {
      const task = ledger.tasks[0]
      run.observedReview = task?.review ? {
        verdict: task.review.verdict,
        sessionID: task.review.sessionID,
        reason: task.review.reason?.slice(0, 300),
      } : undefined
      if (injection.appliedAt === undefined) addScenarioFailure(receipt, run, "reject scenario did not apply the post-worker driver injection")
      if (task?.review?.verdict !== "reject") addScenarioFailure(receipt, run, `independent reviewer verdict was ${task?.review?.verdict ?? "missing"}, not reject`)
    }
  } catch (error) {
    recordFailure(receipt, phase, error)
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  let args: Args
  try { args = parseArgs(process.argv.slice(2)) }
  catch (error) {
    console.error(`lca-live-core-queue: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }

  let receipt: Receipt
  try { receipt = beginReceipt(args) }
  catch (error) {
    console.error(`lca-live-core-queue: ${error instanceof Error ? error.message : String(error)}`)
    process.stdout.write(`${JSON.stringify({ receipt: args.receipt })}\n`)
    process.exitCode = 1
    return
  }

  const priorFailureCount = receipt.failures.length
  const priorRunCount = receipt.runs.length
  await runDriver(args, receipt)
  const latest = receipt.runs.length > priorRunCount ? receipt.runs.at(-1) : undefined
  if (latest && typeof latest.finishedAt !== "string") latest.finishedAt = new Date().toISOString()
  if (latest) latest.failureCount = receipt.failures.length - priorFailureCount
  try { persistReceipt(args.receipt, receipt) }
  catch (error) {
    recordFailure(receipt, "persist receipt", error)
    try { persistReceipt(args.receipt, receipt) } catch {}
    process.exitCode = 1
  }
  process.stdout.write(`${JSON.stringify({ receipt: args.receipt })}\n`)
  if (receipt.failures.length > priorFailureCount) process.exitCode = 1
}

if (import.meta.main) void main()
