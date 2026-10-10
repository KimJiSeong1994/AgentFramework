#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { canonicalPlanSha, coercePlan, planToTasks, validatePlan, type Plan } from "../framework/src/flow/plan.ts"
import { loadConfig, type LcaConfig } from "../framework/src/config.ts"
import { authenticateLinuxVerification } from "../framework/src/hosts/linux-domain.ts"
import { createLinuxAdmission } from "../framework/src/hosts/runtime.ts"
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
import { enabled, type HookDeps } from "../framework/src/hooks/types.ts"
import { createQueue, type Queue, type QueueRun } from "../framework/src/orchestration/queue.ts"
import { createLinuxVerifierExecutor } from "../framework/src/orchestration/linux-verifier.ts"
import { ledgerPath, readLedger, type Ledger, type LedgerTask, type TaskInput } from "../framework/src/state/ledger.ts"
import type { VerificationProfile, VerificationReconciliation, VerificationReference, VerificationResult } from "../framework/src/orchestration/verifier.ts"
import {
  assertAuthenticatedResults,
  assertForgedEvidenceRefused,
  fileEvidence,
  readCgroupPopulated,
  taskOwnerPaths,
  verificationRecords,
  waitForAuthenticatedTerminal,
  waitUntil,
} from "./lca-linux-verifier-queue.ts"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const FRAMEWORK_PACKAGE = resolve(SCRIPT_DIR, "../framework/package.json")
const BUSY_POLL_MS = 10_000
const BUSY_POLL_INTERVAL_MS = 100
const INJECTED_CODE = 'def normalize_space(text):\n    return ""\n'

export type Scenario = "success" | "retry" | "reject" | "cancel" | "verifier-cancel" | "interrupt" | "checkpoint" | "active-verifier" | "resume"
export type VerifierMode = "legacy" | "linux-qualification" | "linux-production"
type Args = { worktree: string; server: string; scenario: Scenario; verifier: VerifierMode; receipt: string; session?: string }
type AnyRecord = Record<string, unknown>

type ChildRecord = {
  role: ExecutionRole
  cwd: string
  taskID: string
  attemptID: string
  executionID: string
  vendorSessionID?: string
  preparedAt: number
  dispatchedAt?: number
  runFinishedAt?: number
  hostRunReturn?: { status: ExecutionOutcome["status"]; childMessageID?: string; errorName?: string }
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

export type ModelAbortRecord = {
  errorName: "MessageAbortedError"
  scenario: Scenario
  lineage: AnyRecord[]
  taskID: string
  attempt: number
  phase: string
  merged: boolean
  ledgerPreserved: boolean
}

export type Receipt = {
  schemaVersion: 2
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
    verifier: VerifierMode
    sdkEntry?: string
  }
  nativeSessionIDs: { parentSessionID?: string; childSessionIDs: string[] }
  plan?: { path: string; sha256: string; stepCount: number }
  runs: AnyRecord[]
  modelAborts: ModelAbortRecord[]
  failures: Array<{ at: string; phase: string; name: string; message: string }>
}

function fail(message: string): never {
  throw new Error(message)
}

export function parseVerifierMode(value: string | undefined): VerifierMode {
  if (value === undefined) return "legacy"
  if (value === "legacy" || value === "linux-qualification" || value === "linux-production") return value
  return fail("--verifier must be legacy, linux-qualification, or linux-production")
}

export function verificationProfileForMode(mode: VerifierMode): VerificationProfile {
  return mode === "legacy" ? "legacy-unowned" : "linux-single-use"
}

export function assertResumeVerifierIdentity(identity: unknown, expected: VerifierMode): void {
  if (identity !== expected) fail("resume receipt is missing or has a mismatched verifier identity")
}

export function assertScenarioVerifierMode(scenario: Scenario, verifier: VerifierMode): void {
  if ((scenario === "success" || scenario === "verifier-cancel" || scenario === "active-verifier") &&
      verifier === "legacy") {
    fail(`scenario ${scenario} requires --verifier linux-qualification or linux-production`)
  }
}

export function assertReceiptSchemaForResume(schemaVersion: unknown, modelAborts: unknown): void {
  if (schemaVersion !== 2) {
    fail("resume requires a schema-2 receipt with modelAborts; schema-1 receipts are not upgraded")
  }
  if (!Array.isArray(modelAborts)) fail("schema-2 resume receipt is missing modelAborts")
}

export function selectVerifierRuntime(
  config: LcaConfig,
  baseRuntime: ExecutionRuntime,
  mode: VerifierMode,
): ExecutionRuntime {
  if (mode === "linux-production") {
    if (config.delegate.verifier !== "linux-single-use") {
      fail("linux-production requires fixture config delegate.verifier=linux-single-use")
    }
    if (baseRuntime.verificationProfile !== "linux-single-use" || !baseRuntime.linuxAdmission) {
      fail("linux-production did not receive the ordinary linux-single-use OpenCode runtime")
    }
    return baseRuntime
  }
  if (mode === "legacy") return baseRuntime
  return {
    ...baseRuntime,
    verificationProfile: "linux-single-use",
    verifier: createLinuxVerifierExecutor({ qualification: true }),
    linuxAdmission: createLinuxAdmission({ qualification: true }),
  }
}

export function appendModelAbort(
  receipt: Receipt,
  errorName: unknown,
  observation: Omit<ModelAbortRecord, "errorName">,
): boolean {
  if (errorName !== "MessageAbortedError") return false
  receipt.modelAborts.push({ errorName, ...observation })
  return true
}

export function modelAbortPreservation(
  before: { mainGitState: unknown; ledger: unknown } | undefined,
  after: { mainGitState: unknown; ledger: unknown } | undefined,
): Pick<ModelAbortRecord, "merged" | "ledgerPreserved"> {
  return {
    merged: !before || !after || !sameEvidence(before.mainGitState, after.mainGitState),
    ledgerPreserved: !!before && !!after && sameEvidence(before.ledger, after.ledger),
  }
}

function parseArgs(argv: string[]): Args {
  const fields = new Map<string, string>()
  const allowed = new Set(["--worktree", "--server", "--scenario", "--receipt", "--session", "--verifier"])
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
  const verifier = parseVerifierMode(fields.get("--verifier"))
  if (!worktreeArg || !serverArg || !scenario || !receipt) {
    fail("usage: bun scripts/lca-live-core-queue.ts --worktree ABSOLUTE_GIT_ROOT --server http://127.0.0.1:PORT --scenario success|retry|reject|cancel|verifier-cancel|interrupt|checkpoint|active-verifier|resume --receipt ABSOLUTE_JSON_PATH [--verifier legacy|linux-qualification|linux-production] [--session ID]")
  }
  if (!(scenario === "success" || scenario === "retry" || scenario === "reject" || scenario === "cancel" ||
    scenario === "verifier-cancel" || scenario === "interrupt" || scenario === "checkpoint" ||
    scenario === "active-verifier" || scenario === "resume")) {
    fail("--scenario must be success, retry, reject, cancel, verifier-cancel, interrupt, checkpoint, active-verifier, or resume")
  }
  if (!isAbsolute(worktreeArg)) fail("--worktree must be absolute and canonical")
  if (!isAbsolute(receipt)) fail("--receipt must be an absolute scratch JSON path")
  if (scenario === "resume" && !fields.get("--session")) fail("--session is required for resume")
  if (scenario !== "resume" && fields.has("--session")) fail("--session is only accepted for resume; other scenarios create a new inert parent session")
  assertScenarioVerifierMode(scenario, verifier)

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
    scenario: scenario as Scenario,
    verifier,
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
    schemaVersion: 2,
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
      verifier: args.verifier,
    },
    nativeSessionIDs: { childSessionIDs: [] },
    runs: [],
    modelAborts: [],
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
  assertReceiptSchemaForResume(prior.schemaVersion, prior.modelAborts)
  if (!["interrupt", "checkpoint", "active-verifier", "resume"].includes(prior.scenario) || prior.baseIdentity.worktree !== args.worktree
    || prior.baseIdentity.serverOrigin !== args.server || prior.nativeSessionIDs.parentSessionID !== args.session
    || !Array.isArray(prior.runs) || !["interrupt", "checkpoint", "active-verifier"].includes(String(prior.runs[0]?.scenario))
    || !Array.isArray(prior.failures) || !Array.isArray(prior.nativeSessionIDs.childSessionIDs)) {
    fail("resume receipt does not identify the matching interrupted worktree, server, and parent session")
  }
  assertResumeVerifierIdentity(prior.baseIdentity.verifier, args.verifier)
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
  verifierMode: VerifierMode,
  phase: () => string,
  receipt: Receipt,
  children: ChildRecord[],
  injection: AnyRecord,
  taskBaselineLineages: Record<string, TaskBaselineLineage>,
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
        cwd: request.cwd,
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
          let abortCheckpoint: { mainGitState: unknown; ledger: unknown } | undefined
          try {
            abortCheckpoint = {
              mainGitState: mainGitState(runtime.worktree),
              ledger: fileDigest(ledgerPath(runtime.worktree, request.supervisorSessionID)),
            }
          } catch { /* An abort still gets recorded conservatively below. */ }
          try {
            const outcome = await handle.run()
            child.runFinishedAt = Date.now()
            child.hostRunReturn = {
              status: outcome.status,
              ...(outcome.childMessageID ? { childMessageID: outcome.childMessageID } : {}),
              ...(outcome.errorName ? { errorName: outcome.errorName.slice(0, 128) } : {}),
            }
            if (outcome.errorName === "MessageAbortedError") {
              let attempt = 0
              let lineage: AnyRecord[] = []
              let captureFailure: Error | undefined = abortCheckpoint
                ? undefined
                : new Error("model abort pre-run preservation observation was unavailable")
              try {
                const ledger = readLedger(runtime.worktree, request.supervisorSessionID)
                attempt = ledger.tasks.find(task => task.id === request.taskID)?.attempts ?? 0
                lineage = taskExecutionLineage(runtime, request.supervisorSessionID, request.taskID)
                if (attempt < 1 || !lineage.length) throw new Error("model abort task lineage was unavailable")
              } catch {
                captureFailure ??= new Error("model abort task lineage observation was unavailable")
              }
              let after: { mainGitState: unknown; ledger: unknown } | undefined
              try {
                after = {
                  mainGitState: mainGitState(runtime.worktree),
                  ledger: fileDigest(ledgerPath(runtime.worktree, request.supervisorSessionID)),
                }
              } catch {
                captureFailure ??= new Error("model abort preservation observation was unavailable")
              }
              const preservation = modelAbortPreservation(abortCheckpoint, after)
              appendModelAbort(receipt, outcome.errorName, {
                scenario,
                lineage,
                taskID: request.taskID.slice(0, 128),
                attempt,
                phase: phase().slice(0, 128),
                ...preservation,
              })
              if (captureFailure) recordFailure(receipt, phase(), captureFailure)
            }
            if (verifierMode !== "legacy" && request.role === "worker" && outcome.status === "completed" &&
              !taskBaselineLineages[request.taskID]) {
              taskBaselineLineages[request.taskID] = captureTaskBaselineLineage(runtime, request.supervisorSessionID, request.taskID)
            }
            const injectAfterWorker = scenario === "reject" ||
              (scenario === "retry" && verifierMode !== "legacy")
            if (injectAfterWorker && request.role === "worker" && outcome.status === "completed" && !injection.appliedAt) {
              applyRejectInjection(child, injection)
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

function applyRejectInjection(child: ChildRecord, injection: AnyRecord): void {
  const path = resolve(child.cwd, "text_ops.py")
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
  injection.applicationCount = 1
  injection.appliedAt = new Date().toISOString()
}

async function waitForBusy(client: any, child: ChildRecord): Promise<BusyObservation> {
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
        client.session.status({ query: { directory: child.cwd } }),
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

type AuthenticatedVerificationEvidence = {
  executionID: string
  taskID: string
  reference: VerificationReference
  result: VerificationResult
}

type TaskBaselineLineage = {
  baseline: ReturnType<typeof fileEvidence>
  ownership: ReturnType<typeof fileEvidence>
  baselineTree: string
  originalHead: string
}

function executionRecordsFor(runtime: ExecutionRuntime, sessionID: string) {
  return runtime.runs.status().executions.filter(execution => execution.ownerSession === sessionID)
}

function durableExecutionIDs(runtime: ExecutionRuntime, sessionID: string): { host: string[]; verifier: string[] } {
  const records = executionRecordsFor(runtime, sessionID)
  return {
    host: records.filter(execution => execution.kind === "host").map(execution => execution.executionId).sort(),
    verifier: records.filter(execution => execution.kind === "verifier").map(execution => execution.executionId).sort(),
  }
}

function durableTaskExecutionIDs(runtime: ExecutionRuntime, sessionID: string): Record<string, { host: string[]; verifier: string[] }> {
  const byTask: Record<string, { host: string[]; verifier: string[] }> = {}
  for (const execution of executionRecordsFor(runtime, sessionID)) {
    const ids = byTask[execution.taskId] ?? (byTask[execution.taskId] = { host: [], verifier: [] })
    if (execution.kind === "host") ids.host.push(execution.executionId)
    if (execution.kind === "verifier") ids.verifier.push(execution.executionId)
  }
  for (const ids of Object.values(byTask)) {
    ids.host.sort()
    ids.verifier.sort()
  }
  return byTask
}

function taskExecutionLineage(runtime: ExecutionRuntime, sessionID: string, taskID: string): AnyRecord[] {
  return executionRecordsFor(runtime, sessionID)
    .filter(execution => execution.taskId === taskID)
    .map(execution => ({
      executionID: execution.executionId,
      attemptID: execution.attemptId,
      kind: execution.kind,
      role: execution.role,
      profile: execution.profile,
      outcome: execution.terminal?.outcome,
      inputSnapshotID: execution.inputSnapshotID,
      inputDigest: execution.inputDigest,
    }))
    .sort((left, right) => String(left.executionID).localeCompare(String(right.executionID)))
}

function captureTaskBaselineLineage(runtime: ExecutionRuntime, sessionID: string, taskID: string): TaskBaselineLineage {
  const paths = taskOwnerPaths(runtime.worktree, sessionID, taskID)
  const baseline = fileEvidence(paths.baseline)
  const ownership = fileEvidence(paths.ownership)
  if (!baseline.exists || !ownership.exists) fail(`task ${taskID} baseline lineage is unavailable before cleanup`)
  const owner = JSON.parse(readFileSync(paths.ownership, "utf8")) as { baselineTree?: unknown; originalHead?: unknown }
  if (typeof owner.baselineTree !== "string" || typeof owner.originalHead !== "string") {
    fail(`task ${taskID} ownership record lacks baseline lineage`)
  }
  return { baseline, ownership, baselineTree: owner.baselineTree, originalHead: owner.originalHead }
}

function taskHostExecutions(runtime: ExecutionRuntime, sessionID: string, taskID: string, role: "worker" | "reviewer") {
  return executionRecordsFor(runtime, sessionID).filter(execution =>
    execution.kind === "host" && execution.taskId === taskID && execution.role === role &&
    typeof execution.vendorRef === "string" && execution.terminal?.outcome === "completed")
}

function captureLinuxVerificationEvidence(run: AnyRecord, runtime: ExecutionRuntime, sessionID: string): AuthenticatedVerificationEvidence[] {
  const records = executionRecordsFor(runtime, sessionID)
  assertNativeRecordProfiles(runtime, sessionID)
  const proofs = assertAuthenticatedResults(records)
  const evidence = verificationRecords(records).map(({ record, reference, result }) => ({
    executionID: record.executionId,
    taskID: record.taskId,
    reference,
    result,
  }))
  run.authenticatedVerifierProofs = proofs
  run.authenticatedVerifierResults = evidence
  return evidence
}

function appendAuthenticatedVerificationEvidence(run: AnyRecord, evidence: AuthenticatedVerificationEvidence): void {
  if (!authenticateLinuxVerification(evidence.result, evidence.reference) ||
    !evidence.result.proof?.receipt || !evidence.result.proof.signature) {
    fail("native verifier retirement was not authenticated")
  }
  const proof = evidence.result.proof!
  const prior = Array.isArray(run.authenticatedVerifierResults)
    ? run.authenticatedVerifierResults as AuthenticatedVerificationEvidence[]
    : []
  if (!prior.some(item => item.executionID === evidence.executionID)) prior.push(evidence)
  run.authenticatedVerifierResults = prior
  const proofs = Array.isArray(run.authenticatedVerifierProofs)
    ? run.authenticatedVerifierProofs as AnyRecord[]
    : []
  if (!proofs.some(item => item.executionID === evidence.executionID)) {
    proofs.push({
      executionID: evidence.executionID,
      taskID: evidence.taskID,
      parentExit: evidence.result.parentExit,
      cancelled: evidence.result.cancelled,
      timedOut: evidence.result.timedOut,
      integrity: evidence.result.integrity,
      receipt: proof.receipt,
      signature: proof.signature,
    })
  }
  run.authenticatedVerifierProofs = proofs
}

function fileDigest(path: string): { sha256: string; size: number } {
  const bytes = readFileSync(path)
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength }
}

function untrackedPathsFromGit(bytes: Buffer): Buffer[] {
  if (bytes.length === 0) return []
  if (bytes[bytes.length - 1] !== 0) fail("Git returned an unterminated untracked-path list")
  const paths: Buffer[] = []
  let start = 0
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0) continue
    const path = bytes.subarray(start, index)
    if (path.length === 0) fail("Git returned an empty untracked path")
    validateUntrackedPath(path)
    paths.push(Buffer.from(path))
    start = index + 1
  }
  paths.sort(Buffer.compare)
  return paths
}

function validateUntrackedPath(path: Buffer): void {
  if (path.length === 0 || path[0] === 0x2f) fail("unsupported absolute untracked path")
  let start = 0
  for (let index = 0; index <= path.length; index++) {
    if (index !== path.length && path[index] !== 0x2f) continue
    const segment = path.subarray(start, index)
    if (segment.length === 0 || (segment.length === 1 && segment[0] === 0x2e) ||
      (segment.length === 2 && segment[0] === 0x2e && segment[1] === 0x2e)) {
      fail("unsupported untracked path component")
    }
    start = index + 1
  }
}

type BigintFileStat = {
  dev: bigint
  ino: bigint
  mode: bigint
  nlink: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

function sameFileIdentity(left: BigintFileStat, right: BigintFileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function assertUntrackedParentDirectories(root: Buffer, path: Buffer): void {
  let start = 0
  let current = Buffer.from(root.subarray(0, root.length - Buffer.byteLength(sep)))
  for (let index = 0; index < path.length; index++) {
    if (path[index] !== 0x2f) continue
    const component = path.subarray(start, index)
    current = Buffer.concat([current, Buffer.from(sep), component])
    const info = lstatSync(current, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) fail("unsupported untracked path: parent component is not a real directory")
    start = index + 1
  }
}

function hashUntrackedFiles(worktree: string, encodedPaths: Buffer): { sha256: string; size: number; count: number } {
  const paths = untrackedPathsFromGit(encodedPaths)
  const digest = createHash("sha256")
  let totalSize = 0
  const root = Buffer.from(resolve(worktree) + sep)
  for (const path of paths) {
    assertUntrackedParentDirectories(root, path)
    const absolutePath = Buffer.concat([root, path])
    const before = lstatSync(absolutePath, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      fail("unsupported untracked entry: only single-link regular files are supported")
    }
    const noFollow = (fsConstants as unknown as Record<string, number | undefined>).O_NOFOLLOW
    if (noFollow === undefined) fail("untracked evidence requires O_NOFOLLOW support")
    const descriptor = openSync(absolutePath, fsConstants.O_RDONLY | noFollow)
    try {
      const opened = fstatSync(descriptor, { bigint: true })
      if (!opened.isFile() || !sameFileIdentity(before, opened)) fail("untracked file changed or was substituted before hashing")
      const pathLength = Buffer.alloc(4)
      if (path.length > 0xffff_ffff) fail("untracked path exceeds supported length")
      pathLength.writeUInt32BE(path.length)
      const mode = Buffer.alloc(4)
      mode.writeUInt32BE(Number(opened.mode & 0o7777n))
      const fileSize = Buffer.alloc(8)
      fileSize.writeBigUInt64BE(opened.size)
      digest.update(pathLength).update(path).update(mode).update(fileSize)
      const chunk = Buffer.allocUnsafe(64 * 1024)
      let fileBytes = 0n
      for (;;) {
        const count = readSync(descriptor, chunk, 0, chunk.length, null)
        if (count === 0) break
        digest.update(chunk.subarray(0, count))
        fileBytes += BigInt(count)
      }
      const after = fstatSync(descriptor, { bigint: true })
      if (fileBytes !== opened.size || !sameFileIdentity(opened, after)) fail("untracked file changed while hashing")
      if (opened.size > BigInt(Number.MAX_SAFE_INTEGER - totalSize)) fail("untracked evidence size exceeds supported range")
      totalSize += Number(opened.size)
    } finally {
      closeSync(descriptor)
    }
  }
  return { sha256: digest.digest("hex"), size: totalSize, count: paths.length }
}

export function mainGitState(worktree: string): {
  head: string
  status: string
  statusBytes: { sha256: string; size: number }
  trackedDiff: { sha256: string; size: number }
  untracked: { sha256: string; size: number; count: number }
} {
  const trackedDiff = execFileSync("git", ["-C", worktree, "diff", "--binary", "--no-ext-diff", "--no-renames", "HEAD", "--"])
  const status = execFileSync("git", ["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" })
  const statusBytes = execFileSync("git", ["-C", worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"])
  const untrackedPaths = execFileSync("git", ["-C", worktree, "ls-files", "--others", "--exclude-standard", "-z"])
  const untracked = hashUntrackedFiles(worktree, untrackedPaths)
  return {
    head: execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    status,
    statusBytes: {
      sha256: createHash("sha256").update(statusBytes).digest("hex"),
      size: statusBytes.byteLength,
    },
    trackedDiff: {
      sha256: createHash("sha256").update(trackedDiff).digest("hex"),
      size: trackedDiff.byteLength,
    },
    untracked,
  }
}

function sameEvidence(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertNativeRecordProfiles(runtime: ExecutionRuntime, sessionID: string): void {
  if (executionRecordsFor(runtime, sessionID).some(execution =>
    (execution.kind === "verifier" && execution.profile !== "linux-single-use") ||
    (execution.kind === "host" && execution.profile !== "legacy-unowned"))) {
    fail("Linux execution changed the host or verifier execution profile")
  }
}

function linuxWaitDeadline(runtime: ExecutionRuntime): number {
  return Math.min(120_000, Math.max(BUSY_POLL_MS, runtime.config.delegate.verify_timeout_ms + 10_000))
}

const CANCELLATION_CLEANUP_STEP_MS = 5_000

type BoundedCleanupStep<T> =
  | { status: "completed"; value: T }
  | { status: "rejected"; error: { name: string; message: string }; cause: unknown }
  | { status: "timed_out" }
  | { status: "not_started" }
type CleanupStepReceipt<T> =
  | { status: "completed"; value: T }
  | { status: "rejected"; error: { name: string; message: string } }
  | { status: "timed_out" }
  | { status: "not_started" }

async function boundedCleanupStep<T>(
  operation: () => T | Promise<T>,
  deadlineAt: number,
  maxWaitMs: number,
): Promise<BoundedCleanupStep<T>> {
  const waitMs = Math.min(maxWaitMs, deadlineAt - Date.now())
  if (waitMs <= 0) return { status: "not_started" }
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = Promise.resolve().then(operation).then(
    (value): BoundedCleanupStep<T> => ({ status: "completed", value }),
    (error): BoundedCleanupStep<T> => ({ status: "rejected", error: errorRecord(error), cause: error }),
  )
  const expired = new Promise<BoundedCleanupStep<T>>(resolve => {
    timer = setTimeout(() => resolve({ status: "timed_out" }), waitMs)
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function cleanupStepReceipt<T>(step: BoundedCleanupStep<T>): CleanupStepReceipt<T> {
  if (step.status === "rejected") return { status: step.status, error: step.error }
  return step
}

type NativeRetirementInspection =
  | { status: "authenticated"; result: VerificationResult; attempts: number }
  | { status: "unresolved"; attempts: number; lastOutcome?: string; error?: { name: string; message: string } }

async function inspectNativeRetirement(
  reference: VerificationReference,
  reconcile: () => Promise<VerificationReconciliation>,
  deadlineAt: number,
): Promise<NativeRetirementInspection> {
  const endAt = Math.min(deadlineAt, Date.now() + 120_000)
  let attempts = 0
  let lastOutcome: string | undefined
  while (Date.now() < endAt) {
    attempts++
    const observed = await boundedCleanupStep(reconcile, endAt, endAt - Date.now())
    if (observed.status === "rejected") return { status: "unresolved", attempts, lastOutcome, error: observed.error }
    if (observed.status !== "completed") return { status: "unresolved", attempts, lastOutcome }
    lastOutcome = observed.value.outcome
    const result = observed.value.result
    if (observed.value.outcome === "terminal" && result) {
      if (authenticateLinuxVerification(result, reference)) return { status: "authenticated", result, attempts }
      return { status: "unresolved", attempts, lastOutcome: "terminal-without-authenticated-result" }
    }
    const delay = Math.min(100, endAt - Date.now())
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
  }
  return { status: "unresolved", attempts, lastOutcome }
}

export async function preserveVerifierCancellationFailure(options: {
  receipt: Receipt
  run: AnyRecord
  originalError: unknown
  reference?: VerificationReference
  deadlineAt: number
  abortQueue: () => Promise<unknown>
  queuePromise: Promise<unknown>
  reconcile?: () => Promise<VerificationReconciliation>
  persist: () => void
}): Promise<never> {
  void options.queuePromise.catch(() => undefined)
  if (!options.receipt.runs.includes(options.run)) options.receipt.runs.push(options.run)
  const cleanup: AnyRecord & { steps: AnyRecord } = {
    originalException: errorRecord(options.originalError),
    ...(options.reference ? { reference: options.reference } : {}),
    steps: {
      initialReceiptPersistence: { status: "not_attempted" },
      queueAbort: { status: "not_started" },
      queueSettlement: { status: "not_started" },
      finalReceiptPersistence: { status: "not_attempted" },
    },
    nativeRetirement: {
      status: "unresolved",
      reason: options.reference ? "cleanup has not authenticated native retirement" : "native verifier reference was not observed",
      attempts: 0,
    },
  }
  options.run.verifierCancellationCleanup = cleanup
  if (options.reference) {
    const previous = options.run.verifierCancelBoundary && typeof options.run.verifierCancelBoundary === "object"
      ? options.run.verifierCancelBoundary as AnyRecord
      : {}
    options.run.verifierCancelBoundary = {
      ...previous,
      boundaryRef: options.reference,
      nativeRetirement: { status: "unresolved", reason: "cleanup has not authenticated native retirement" },
    }
  }

  cleanup.steps.initialReceiptPersistence = { status: "persisted" }
  try {
    options.persist()
  } catch (error) {
    cleanup.steps.initialReceiptPersistence = { status: "failed", error: errorRecord(error) }
  }

  const queueAbort = await boundedCleanupStep(options.abortQueue, options.deadlineAt, CANCELLATION_CLEANUP_STEP_MS)
  cleanup.steps.queueAbort = cleanupStepReceipt(queueAbort)
  const queueSettlement = await boundedCleanupStep(() => options.queuePromise, options.deadlineAt, CANCELLATION_CLEANUP_STEP_MS)
  cleanup.steps.queueSettlement = cleanupStepReceipt(queueSettlement)

  if (options.reference && options.reconcile) {
    const inspected = await inspectNativeRetirement(options.reference, options.reconcile, options.deadlineAt)
    if (inspected.status === "authenticated") {
      cleanup.nativeRetirement = {
        status: "authenticated",
        attempts: inspected.attempts,
        result: inspected.result,
      }
      options.run.verifierCancelBoundary = {
        ...(options.run.verifierCancelBoundary as AnyRecord),
        nativeRetirement: { status: "authenticated", result: inspected.result },
      }
    } else {
      cleanup.nativeRetirement = {
        status: "unresolved",
        attempts: inspected.attempts,
        ...(inspected.lastOutcome ? { lastOutcome: inspected.lastOutcome } : {}),
        ...(inspected.error ? { error: inspected.error } : {}),
      }
      options.run.verifierCancelBoundary = {
        ...(options.run.verifierCancelBoundary as AnyRecord ?? {}),
        ...(options.reference ? { boundaryRef: options.reference } : {}),
        nativeRetirement: cleanup.nativeRetirement,
      }
    }
  }

  cleanup.steps.finalReceiptPersistence = { status: "persisted" }
  try {
    options.persist()
  } catch (error) {
    cleanup.steps.finalReceiptPersistence = { status: "failed", error: errorRecord(error) }
  }
  throw options.originalError
}

export function queueLifecycleWaitMs(config: Pick<LcaConfig["delegate"], "queue_ttl_ms" | "task_ttl_ms" | "review_ttl_ms" | "verify_timeout_ms">): number {
  const { queue_ttl_ms, task_ttl_ms, review_ttl_ms, verify_timeout_ms } = config
  const attemptLifecycle = task_ttl_ms + review_ttl_ms + verify_timeout_ms
  const wait = queue_ttl_ms + attemptLifecycle + BUSY_POLL_MS
  if (![queue_ttl_ms, task_ttl_ms, review_ttl_ms, verify_timeout_ms, wait].every(Number.isFinite) ||
    [queue_ttl_ms, task_ttl_ms, review_ttl_ms, verify_timeout_ms].some(value => value <= 0)) {
    fail("queue lifecycle wait requires finite positive task, review, verify, and queue timeouts")
  }
  return wait
}

function createRuntime(worktree: string, client: any, scenario: Scenario, verifierMode: VerifierMode): { runtime: ExecutionRuntime; queue: Queue } {
  const config = loadConfig(worktree)
  const attempts = scenario === "retry" ? 2 : 1
  if (!config.delegate.review || !config.delegate.review_strict ||
    config.delegate.max_attempts !== attempts) {
    fail(`fixture .lca/lca.jsonc must set review=true, review_strict=true, max_attempts=${attempts}; local overrides would conflict with the server's fixed policy`)
  }
  if (verifierMode === "linux-production" && config.delegate.verifier !== "linux-single-use") {
    fail("linux-production requires fixture config delegate.verifier=linux-single-use")
  }
  if (verifierMode !== "legacy") {
    if (config.delegate.worktree !== true) fail("Linux verifier modes require isolated task worktrees")
    if (!enabled(config, "config.agents") || !enabled(config, "chat.params")) {
      fail("Linux verifier modes require config.agents and chat.params hooks to be enabled")
    }
    if (!Number.isSafeInteger(config.delegate.verify_output_chars) || config.delegate.verify_output_chars < 1 ||
      config.delegate.verify_output_chars > 65_536) {
      fail("Linux verifier verify_output_chars must be an integer from 1 through 65536")
    }
  }
  const deps: HookDeps = {
    client,
    directory: worktree,
    worktree,
    config,
    log: () => {},
  }
  const baseRuntime = getOpenCodeRuntime(deps)
  const runtime = selectVerifierRuntime(config, baseRuntime, verifierMode)
  return { runtime, queue: createQueue(runtime) }
}

async function runVerifierCancellation(
  receipt: Receipt,
  runtime: ExecutionRuntime,
  queue: Queue,
  queuePromise: Promise<QueueRun>,
  worktree: string,
  sessionID: string,
  taskID: string,
  run: AnyRecord,
): Promise<void> {
  let reference: VerificationReference | undefined
  let nativeRetirementDeadlineAt: number | undefined
  void queuePromise.catch(() => undefined)
  try {
    const deadline = queueLifecycleWaitMs(runtime.config.delegate)
    await waitUntil(() => {
      const record = runtime.runs.status().executions.findLast(execution =>
        execution.ownerSession === sessionID && execution.kind === "verifier" && execution.taskId === taskID &&
        execution.verifierDispatch === "started" && !execution.terminal && execution.boundaryRef && "kind" in execution.boundaryRef)
      if (record?.boundaryRef && "kind" in record.boundaryRef && !reference) {
        reference = record.boundaryRef as VerificationReference
        nativeRetirementDeadlineAt = Date.now() + Math.min(120_000,
          Math.max(10_000, runtime.config.delegate.verify_timeout_ms + 10_000))
        run.verifierCancelBoundary = {
          boundaryRef: reference,
          referenceObservedAt: new Date().toISOString(),
          nativeRetirement: { status: "unresolved", reason: "native verifier is active" },
        }
        persistReceipt(receipt.receiptPath, receipt)
      }
      return !!reference && readCgroupPopulated() && queue.isRunning(sessionID)
    }, deadline, "native-verifier-not-running-for-queue-cancel")
    if (!reference) fail("queue-cancel native verifier reference missing")

    const ledger = readLedger(worktree, sessionID)
    if (ledger.tasks[0]?.status !== "running" || ledger.tasks[0]?.review) fail("queue-accepted-before-native-retirement")
    const paths = taskOwnerPaths(worktree, sessionID, taskID)
    const baselineBefore = fileEvidence(paths.baseline)
    const ownershipBefore = fileEvidence(paths.ownership)
    if (!baselineBefore.exists || !ownershipBefore.exists) fail("cancelled-task-baseline-missing")
    const gitBefore = mainGitState(worktree)
    const executionIDsBefore = durableExecutionIDs(runtime, sessionID)

    run.verifierCancelBoundary = {
      ...(run.verifierCancelBoundary as AnyRecord),
      boundaryRef: reference,
      ledger: summarizeLedger(ledger),
      ledgerFile: fileDigest(ledgerPath(worktree, sessionID)),
      baseline: baselineBefore,
      ownership: ownershipBefore,
      mainGitState: gitBefore,
      executionIDs: executionIDsBefore,
    }
    persistReceipt(receipt.receiptPath, receipt)
    nativeRetirementDeadlineAt ??= Date.now() + Math.min(120_000,
      Math.max(10_000, runtime.config.delegate.verify_timeout_ms + 10_000))
    const abortResult = await boundedCleanupStep(
      () => queue.abort(sessionID, "Linux verifier qualification cancellation"),
      nativeRetirementDeadlineAt,
      CANCELLATION_CLEANUP_STEP_MS,
    )
    if (abortResult.status === "rejected") throw abortResult.cause
    if (abortResult.status !== "completed") fail(`queue-abort did not settle: ${abortResult.status}`)
    const queueSettlement = await boundedCleanupStep(() => queuePromise, nativeRetirementDeadlineAt, CANCELLATION_CLEANUP_STEP_MS)
    if (queueSettlement.status === "rejected") throw queueSettlement.cause
    if (queueSettlement.status !== "completed") fail(`queue run did not settle after cancellation: ${queueSettlement.status}`)
    const queueResult = queueSettlement.value
    run.queueResult = queueResult
    if (!queueResult.aborted || queueResult.done !== 0 || queueResult.failed !== 0) fail("queue-cancellation-result-invalid")
    const executionIDsAfterAbort = durableExecutionIDs(runtime, sessionID)
    run.executionIDsAfterAbort = executionIDsAfterAbort

    const cancelledLedger = readLedger(worktree, sessionID)
    if (cancelledLedger.tasks[0]?.status !== "cancelled" || cancelledLedger.tasks[0]?.review) fail("cancelled-task-was-accepted")
    const ledgerWhileUnresolved = fileDigest(ledgerPath(worktree, sessionID))
    const baselineWhileUnresolved = fileEvidence(paths.baseline)
    const ownershipWhileUnresolved = fileEvidence(paths.ownership)
    if (!sameEvidence(baselineBefore, baselineWhileUnresolved) || !sameEvidence(ownershipBefore, ownershipWhileUnresolved) ||
      !sameEvidence(gitBefore, mainGitState(worktree))) fail("queue-cancel-mutated-task-owner-or-main-worktree")

    const recordBeforeRetirement = runtime.runs.status().executions.findLast(execution =>
      execution.ownerSession === sessionID && execution.kind === "verifier" && execution.taskId === taskID)
    if (!recordBeforeRetirement || !reference) fail("queue-cancel-verifier-record-missing")
    const immediate = recordBeforeRetirement.reconciliation?.verification ?? recordBeforeRetirement.terminal?.verification
    let result: VerificationResult
    if (recordBeforeRetirement.terminal && !recordBeforeRetirement.fence && immediate &&
      authenticateLinuxVerification(immediate, reference) && immediate.cancelled) {
      result = immediate
    } else {
      if (!recordBeforeRetirement.fence) fail("queue-cancel-did-not-fence-unproven-retirement")
      const retirement = await inspectNativeRetirement(
        reference,
        () => runtime.verifier.reconcile(reference!),
        nativeRetirementDeadlineAt!,
      )
      if (retirement.status !== "authenticated") fail(`queue-cancel native retirement remains unresolved: ${JSON.stringify(retirement)}`)
      result = retirement.result
    }
    if (!authenticateLinuxVerification(result, reference) || !result.cancelled || result.domainState !== "empty" || readCgroupPopulated()) {
      fail("queue-cancel-retirement-not-authenticated")
    }
    if (!sameEvidence(ledgerWhileUnresolved, fileDigest(ledgerPath(worktree, sessionID))) ||
      !sameEvidence(baselineWhileUnresolved, fileEvidence(paths.baseline)) ||
      !sameEvidence(ownershipWhileUnresolved, fileEvidence(paths.ownership))) {
      fail("queue-cancel-mutated-ledger-or-owner-while-native-retirement-was-unresolved")
    }
    appendAuthenticatedVerificationEvidence(run, {
      executionID: reference.executionID,
      taskID,
      reference,
      result,
    })

    const resumed = await createQueue(runtime).run(sessionID, { resumed: true })
    run.explicitResumedQueueResult = resumed
    const finalLedger = readLedger(worktree, sessionID)
    const records = executionRecordsFor(runtime, sessionID)
    const verifierRecord = records.findLast(execution => execution.kind === "verifier" && execution.taskId === taskID)
    const persistedResult = verifierRecord?.reconciliation?.verification ?? verifierRecord?.terminal?.verification
    const executionIDsAfter = durableExecutionIDs(runtime, sessionID)
    run.executionIDsAfterResume = executionIDsAfter
    if (resumed.aborted || resumed.done !== 0 || resumed.failed !== 0 || resumed.taskIds.length !== 0 ||
      finalLedger.tasks[0]?.status !== "cancelled" || finalLedger.tasks[0]?.review ||
      !verifierRecord || records.filter(execution => execution.kind === "verifier").length !== 1 ||
      !persistedResult || !authenticateLinuxVerification(persistedResult, reference) || !persistedResult.cancelled ||
      !sameEvidence(executionIDsBefore, executionIDsAfter) ||
      taskHostExecutions(runtime, sessionID, taskID, "worker").length !== 1 ||
      taskHostExecutions(runtime, sessionID, taskID, "reviewer").length !== 0 ||
      !sameEvidence(baselineBefore, fileEvidence(paths.baseline)) ||
      !sameEvidence(ownershipBefore, fileEvidence(paths.ownership)) ||
      !sameEvidence(gitBefore, mainGitState(worktree))) {
      fail("cancelled-resume-mutated-work-or-replayed-execution")
    }
    captureLinuxVerificationEvidence(run, runtime, sessionID)
    appendAuthenticatedVerificationEvidence(run, { executionID: reference.executionID, taskID, reference, result })
    run.nativeRetirement = { reference, result, authenticated: true }
  } catch (error) {
    if (reference) {
      const deadlineAt = nativeRetirementDeadlineAt ?? Date.now() + Math.min(120_000,
        Math.max(10_000, runtime.config.delegate.verify_timeout_ms + 10_000))
      await preserveVerifierCancellationFailure({
        receipt,
        run,
        originalError: error,
        reference,
        deadlineAt,
        abortQueue: () => queue.abort(sessionID, "Linux verifier cancellation cleanup"),
        queuePromise,
        reconcile: () => runtime.verifier.reconcile(reference!),
        persist: () => persistReceipt(receipt.receiptPath, receipt),
      })
    } else {
      await preserveVerifierCancellationFailure({
        receipt,
        run,
        originalError: error,
        deadlineAt: Date.now() + CANCELLATION_CLEANUP_STEP_MS * 2,
        abortQueue: () => queue.abort(sessionID, "Linux verifier cancellation cleanup"),
        queuePromise,
        persist: () => persistReceipt(receipt.receiptPath, receipt),
      })
    }
  }
}

// The first resume must let normal recovery observe the still-running verifier and refuse replay.
async function runActiveVerifierFirstResume(
  receipt: Receipt,
  run: AnyRecord,
  runtime: ExecutionRuntime,
  queue: Queue,
  worktree: string,
  sessionID: string,
): Promise<void> {
  const interruptedRun = receipt.runs.slice(0, -1).findLast(previous => previous.scenario === "active-verifier")
  const interruption = interruptedRun?.interruption as AnyRecord | undefined
  const reference = interruption?.boundaryRef as VerificationReference | undefined
  if (!interruption || !reference || reference.kind !== "verifier" || reference.profile !== "linux-single-use") {
    fail("active-verifier resume receipt is missing its exact native boundary")
  }
  const completedTaskID = (interruption.completedTaskIDs as string[] | undefined)?.[0]
  const expectedCompletedIDs = interruption.completedTaskExecutionIDs
  const expectedCompletedLineage = interruption.completedTaskExecutionLineage
  const expectedBaselineLineage = interruption.completedTaskBaselineLineage
  const originalTaskLineages = interruptedRun?.taskBaselineLineages as Record<string, TaskBaselineLineage> | undefined
  const completedIDs = expectedCompletedIDs as { host?: unknown; verifier?: unknown } | undefined
  if (!completedTaskID || !Array.isArray(completedIDs?.host) || !Array.isArray(completedIDs?.verifier) ||
    !Array.isArray(expectedCompletedLineage) ||
    !sameEvidence(expectedBaselineLineage, originalTaskLineages?.[completedTaskID])) {
    fail("active-verifier receipt is missing completed-task baseline lineage")
  }
  const expectedIDs = interruption.executionIDs as { host?: unknown; verifier?: unknown } | undefined
  const expectedLedger = interruption.ledgerFile as { sha256?: unknown; size?: unknown } | undefined
  const taskID = String(interruption.taskID ?? "")
  if (!taskID || !Array.isArray(expectedIDs?.host) || !Array.isArray(expectedIDs?.verifier) ||
    typeof expectedLedger?.sha256 !== "string" || typeof expectedLedger?.size !== "number" ||
    interruption.verifierDispatch !== "started" || interruption.cgroupPopulated !== true) {
    fail("active-verifier resume receipt is missing durable state evidence")
  }
  const paths = taskOwnerPaths(worktree, sessionID, taskID)
  const baselineBefore = fileEvidence(paths.baseline)
  const ownershipBefore = fileEvidence(paths.ownership)
  const ledgerBefore = fileDigest(ledgerPath(worktree, sessionID))
  const idsBefore = durableExecutionIDs(runtime, sessionID)
  const ledger = readLedger(worktree, sessionID)
  const completedTaskLineageBefore = taskExecutionLineage(runtime, sessionID, completedTaskID)
  if (!sameEvidence(ledgerBefore, expectedLedger) || !sameEvidence(baselineBefore, interruption.baseline) ||
    !sameEvidence(ownershipBefore, interruption.ownership) || !sameEvidence(idsBefore, expectedIDs) ||
    !sameEvidence(durableTaskExecutionIDs(runtime, sessionID)[completedTaskID], interruption.completedTaskExecutionIDs) ||
    !sameEvidence(completedTaskLineageBefore, expectedCompletedLineage) ||
    ledger.tasks[0]?.status !== "done" || ledger.tasks[1]?.status !== "running" || ledger.tasks[2]?.status !== "pending") {
    fail("active-verifier resume changed the recorded ledger, baseline, ownership, or execution identities")
  }
  const persistedActive = executionRecordsFor(runtime, sessionID).find(execution => execution.executionId === reference.executionID)
  if (!persistedActive || persistedActive.kind !== "verifier" || persistedActive.taskId !== taskID ||
    persistedActive.verifierDispatch !== "started" || persistedActive.terminal ||
    !persistedActive.boundaryRef || !("kind" in persistedActive.boundaryRef) ||
    !sameEvidence(persistedActive.boundaryRef, reference)) {
    fail("active-verifier receipt boundary does not match the durable verifier reference")
  }
  const live = await runtime.verifier.reconcile(reference)
  if (live.outcome !== "running" || !readCgroupPopulated()) fail("active native verifier retired before the bounded resume observation")

  const mainBefore = interruption.mainGitState
  run.before = snapshot(runtime, worktree, sessionID)
  run.beforeExecutionIDs = idsBefore
  run.completedTaskIDsBefore = ledger.tasks.filter(task => task.status === "done").map(task => task.id)
  const oldCompletedEvidence = interruption.completedTaskVerifierEvidence as AuthenticatedVerificationEvidence | undefined
  if (!oldCompletedEvidence || oldCompletedEvidence.taskID !== ledger.tasks[0]!.id ||
    !authenticateLinuxVerification(oldCompletedEvidence.result, oldCompletedEvidence.reference) ||
    oldCompletedEvidence.result.parentExit !== 0 || oldCompletedEvidence.result.cancelled || oldCompletedEvidence.result.timedOut) {
    fail("active-verifier receipt is missing the authenticated completed-task result")
  }
  const oldCompletedRecord = executionRecordsFor(runtime, sessionID).find(execution =>
    execution.executionId === oldCompletedEvidence.executionID)
  if (!oldCompletedRecord || oldCompletedRecord.kind !== "verifier" || oldCompletedRecord.taskId !== oldCompletedEvidence.taskID ||
    !oldCompletedRecord.boundaryRef || !("kind" in oldCompletedRecord.boundaryRef) ||
    !sameEvidence(oldCompletedRecord.boundaryRef, oldCompletedEvidence.reference)) {
    fail("completed-task verifier receipt reference changed in durable state")
  }
  const completedTaskPaths = taskOwnerPaths(worktree, sessionID, completedTaskID)
  const completedTaskOwnerState = {
    baseline: fileEvidence(completedTaskPaths.baseline),
    ownership: fileEvidence(completedTaskPaths.ownership),
  }
  if (!sameEvidence(completedTaskOwnerState, interruption.completedTaskOwnerState)) {
    fail("completed-task baseline owner state changed after checkpoint")
  }
  captureLinuxVerificationEvidence(run, runtime, sessionID)

  const queueResult = await queue.run(sessionID, { resumed: true })
  run.queueResult = queueResult
  const afterLedger = readLedger(worktree, sessionID)
  const ledgerAfterResume = fileDigest(ledgerPath(worktree, sessionID))
  const baselineAfterResume = fileEvidence(paths.baseline)
  const ownershipAfterResume = fileEvidence(paths.ownership)
  const idsAfterResume = durableExecutionIDs(runtime, sessionID)
  run.after = snapshot(runtime, worktree, sessionID)
  run.afterExecutionIDs = idsAfterResume
  run.completedTaskIDsAfter = afterLedger.tasks.filter(task => task.status === "done").map(task => task.id)
  const activeRecord = executionRecordsFor(runtime, sessionID).find(execution => execution.executionId === reference.executionID)
  if (!queueResult.aborted || queueResult.done !== 0 || queueResult.failed !== 0 ||
    !sameEvidence(ledgerBefore, ledgerAfterResume) || !sameEvidence(baselineBefore, baselineAfterResume) ||
    !sameEvidence(ownershipBefore, ownershipAfterResume) || !sameEvidence(idsBefore, idsAfterResume) ||
    !sameEvidence(completedTaskLineageBefore, taskExecutionLineage(runtime, sessionID, completedTaskID)) ||
    !sameEvidence(durableTaskExecutionIDs(runtime, sessionID)[completedTaskID], expectedCompletedIDs) ||
    !sameEvidence(completedTaskOwnerState, {
      baseline: fileEvidence(completedTaskPaths.baseline),
      ownership: fileEvidence(completedTaskPaths.ownership),
    }) ||
    afterLedger.tasks[0]?.status !== "done" || afterLedger.tasks[1]?.status !== "running" ||
    afterLedger.tasks[2]?.status !== "pending" || activeRecord?.terminal || activeRecord?.reconciliation?.outcome !== "running" ||
    !sameEvidence(mainBefore, mainGitState(worktree))) {
    fail("active-verifier resume replayed work or changed unresolved task ownership")
  }

  const result = await waitForAuthenticatedTerminal(runtime, reference, linuxWaitDeadline(runtime))
  if (!authenticateLinuxVerification(result, reference) || result.parentExit !== 0 || result.cancelled || result.timedOut ||
    result.domainState !== "empty" || result.integrity !== "unchanged" || readCgroupPopulated()) {
    fail("active verifier natural retirement was not authenticated")
  }
  const oldCompletion = await runtime.verifier.reconcile(oldCompletedEvidence.reference)
  if (oldCompletion.outcome !== "terminal" || !oldCompletion.result ||
    !authenticateLinuxVerification(oldCompletion.result, oldCompletedEvidence.reference) ||
    oldCompletion.result.proof?.receipt !== oldCompletedEvidence.result.proof?.receipt ||
    oldCompletion.result.proof?.signature !== oldCompletedEvidence.result.proof?.signature) {
    fail("completed task verifier receipt changed during active-verifier recovery")
  }
  const afterRetirementLedger = fileDigest(ledgerPath(worktree, sessionID))
  const afterRetirementIDs = durableExecutionIDs(runtime, sessionID)
  const afterRetirement = readLedger(worktree, sessionID)
  const durableActiveRecord = executionRecordsFor(runtime, sessionID).find(execution => execution.executionId === reference.executionID)
  if (!sameEvidence(ledgerBefore, afterRetirementLedger) || !sameEvidence(idsBefore, afterRetirementIDs) ||
    !sameEvidence(completedTaskLineageBefore, taskExecutionLineage(runtime, sessionID, completedTaskID)) ||
    !sameEvidence(durableTaskExecutionIDs(runtime, sessionID)[completedTaskID], expectedCompletedIDs) ||
    !sameEvidence(baselineBefore, fileEvidence(paths.baseline)) || !sameEvidence(ownershipBefore, fileEvidence(paths.ownership)) ||
    !sameEvidence(completedTaskOwnerState, {
      baseline: fileEvidence(completedTaskPaths.baseline),
      ownership: fileEvidence(completedTaskPaths.ownership),
    }) ||
    !sameEvidence(mainBefore, mainGitState(worktree)) || afterRetirement.tasks[1]?.status !== "running" ||
    afterRetirement.tasks[0]?.status !== "done" || durableActiveRecord?.terminal ||
    durableActiveRecord?.reconciliation?.outcome !== "running") {
    fail("native inspection fabricated completion or cleared the unresolved verifier record")
  }
  appendAuthenticatedVerificationEvidence(run, { executionID: reference.executionID, taskID, reference, result })
  run.nativeRetirement = { reference, result, authenticated: true }
  run.completedTaskVerifierEvidenceAfter = {
    executionID: oldCompletedEvidence.executionID,
    taskID: oldCompletedEvidence.taskID,
    reference: oldCompletedEvidence.reference,
    result: oldCompletion.result,
  }
  run.afterNaturalRetirement = snapshot(runtime, worktree, sessionID)
  run.ledgerAfterNaturalRetirement = afterRetirementLedger
  run.executionIDsAfterNaturalRetirement = afterRetirementIDs
  run.activeVerifierStage = "retirement-recorded"
}

// A later explicit resume authenticates the recorded natural retirement before normal queue recovery.
async function runActiveVerifierFollowupResume(
  receipt: Receipt,
  firstResume: AnyRecord,
  run: AnyRecord,
  runtime: ExecutionRuntime,
  queue: Queue,
  worktree: string,
  sessionID: string,
): Promise<void> {
  const interruptedRun = receipt.runs.slice(0, -1).findLast(previous => previous.scenario === "active-verifier")
  const interruption = interruptedRun?.interruption as AnyRecord | undefined
  const expectedRetirement = firstResume.nativeRetirement as { reference?: VerificationReference; result?: VerificationResult; authenticated?: unknown } | undefined
  const reference = interruption?.boundaryRef as VerificationReference | undefined
  if (!interruption || !reference || reference.kind !== "verifier" || reference.profile !== "linux-single-use" ||
    firstResume.activeVerifierStage !== "retirement-recorded" || expectedRetirement?.authenticated !== true ||
    !expectedRetirement.reference || !expectedRetirement.result || !sameEvidence(expectedRetirement.reference, reference) ||
    !authenticateLinuxVerification(expectedRetirement.result, reference)) {
    fail("follow-up active-verifier resume lacks the first resume's authenticated retirement evidence")
  }
  const completedTaskID = (interruption.completedTaskIDs as string[] | undefined)?.[0]
  const expectedTaskIDs = interruption.completedTaskExecutionIDs
  const expectedTaskLineage = interruption.completedTaskExecutionLineage
  const expectedBaselineLineage = interruption.completedTaskBaselineLineage
  const originalTaskLineages = interruptedRun?.taskBaselineLineages as Record<string, TaskBaselineLineage> | undefined
  if (!completedTaskID || !Array.isArray(expectedTaskLineage) ||
    !sameEvidence(expectedBaselineLineage, originalTaskLineages?.[completedTaskID])) {
    fail("follow-up resume is missing t1 execution or baseline lineage")
  }

  const activeTaskID = String(interruption.taskID ?? "")
  const activePaths = taskOwnerPaths(worktree, sessionID, activeTaskID)
  const completedPaths = taskOwnerPaths(worktree, sessionID, completedTaskID)
  const ledgerBefore = fileDigest(ledgerPath(worktree, sessionID))
  const ledger = readLedger(worktree, sessionID)
  const idsBefore = durableExecutionIDs(runtime, sessionID)
  const taskIDsBefore = durableTaskExecutionIDs(runtime, sessionID)
  const lineageBefore = taskExecutionLineage(runtime, sessionID, completedTaskID)
  const activeBaselineBefore = fileEvidence(activePaths.baseline)
  const activeOwnershipBefore = fileEvidence(activePaths.ownership)
  const completedOwnerState = {
    baseline: fileEvidence(completedPaths.baseline),
    ownership: fileEvidence(completedPaths.ownership),
  }
  if (!sameEvidence(ledgerBefore, interruption.ledgerFile) || !sameEvidence(idsBefore, interruption.executionIDs) ||
    !sameEvidence(taskIDsBefore[completedTaskID], expectedTaskIDs) || !sameEvidence(lineageBefore, expectedTaskLineage) ||
    !sameEvidence(activeBaselineBefore, interruption.baseline) || !sameEvidence(activeOwnershipBefore, interruption.ownership) ||
    !sameEvidence(completedOwnerState, interruption.completedTaskOwnerState) ||
    ledger.tasks[0]?.status !== "done" || ledger.tasks[1]?.status !== "running" || ledger.tasks[2]?.status !== "pending" ||
    !sameEvidence(interruption.mainGitState, mainGitState(worktree))) {
    fail("follow-up resume changed the unresolved ledger or completed t1 baseline lineage before native inspection")
  }
  const activeRecord = executionRecordsFor(runtime, sessionID).find(execution => execution.executionId === reference.executionID)
  if (!activeRecord || activeRecord.kind !== "verifier" || activeRecord.taskId !== activeTaskID ||
    !activeRecord.boundaryRef || !("kind" in activeRecord.boundaryRef) || !sameEvidence(activeRecord.boundaryRef, reference)) {
    fail("follow-up resume reference does not match the durable native execution")
  }

  const freshRetirement = await runtime.verifier.reconcile(reference)
  if (freshRetirement.outcome !== "terminal" || !freshRetirement.result ||
    !authenticateLinuxVerification(freshRetirement.result, reference) ||
    freshRetirement.result.proof?.receipt !== expectedRetirement.result.proof?.receipt ||
    freshRetirement.result.proof?.signature !== expectedRetirement.result.proof?.signature ||
    !sameEvidence(freshRetirement.result, expectedRetirement.result)) {
    fail("follow-up resume could not freshly authenticate the exact persisted native retirement")
  }
  run.freshlyAuthenticatedNativeRetirement = { reference, result: freshRetirement.result, authenticated: true }

  const completedEvidence = interruption.completedTaskVerifierEvidence as AuthenticatedVerificationEvidence | undefined
  if (!completedEvidence || completedEvidence.taskID !== completedTaskID ||
    !authenticateLinuxVerification(completedEvidence.result, completedEvidence.reference) ||
    completedEvidence.result.parentExit !== 0 || completedEvidence.result.cancelled || completedEvidence.result.timedOut) {
    fail("follow-up resume lacks the signed t1 verifier result")
  }
  const freshCompleted = await runtime.verifier.reconcile(completedEvidence.reference)
  if (freshCompleted.outcome !== "terminal" || !freshCompleted.result ||
    !authenticateLinuxVerification(freshCompleted.result, completedEvidence.reference) ||
    freshCompleted.result.proof?.receipt !== completedEvidence.result.proof?.receipt ||
    freshCompleted.result.proof?.signature !== completedEvidence.result.proof?.signature) {
    fail("follow-up resume changed the authenticated t1 verifier result")
  }

  run.before = snapshot(runtime, worktree, sessionID)
  run.beforeExecutionIDs = idsBefore
  run.beforeTaskExecutionIDs = taskIDsBefore
  run.completedTaskIDsBefore = ledger.tasks.filter(task => task.status === "done").map(task => task.id)
  run.completedTaskBaselineLineage = expectedBaselineLineage
  const queueResult = await queue.run(sessionID, { resumed: true })
  run.queueResult = queueResult
  const afterLedger = readLedger(worktree, sessionID)
  const idsAfter = durableExecutionIDs(runtime, sessionID)
  const taskIDsAfter = durableTaskExecutionIDs(runtime, sessionID)
  const lineageAfter = taskExecutionLineage(runtime, sessionID, completedTaskID)
  const completedTaskAfter = afterLedger.tasks.find(task => task.id === completedTaskID)
  run.after = snapshot(runtime, worktree, sessionID)
  run.afterExecutionIDs = idsAfter
  run.afterTaskExecutionIDs = taskIDsAfter
  run.completedTaskIDsAfter = afterLedger.tasks.filter(task => task.status === "done").map(task => task.id)
  const remaining = afterLedger.tasks.filter(task => task.id !== completedTaskID)
  const remainingHostCountsValid = remaining.every(task => {
    const expectedWorkers = task.id === activeTaskID ? 2 : 1
    const expectedVerifiers = task.id === activeTaskID ? 2 : 1
    return taskHostExecutions(runtime, sessionID, task.id, "worker").length === expectedWorkers &&
      taskHostExecutions(runtime, sessionID, task.id, "reviewer").length === 1 &&
      executionRecordsFor(runtime, sessionID).filter(execution => execution.kind === "verifier" && execution.taskId === task.id).length === expectedVerifiers
  })
  if (queueResult.aborted || queueResult.done !== 2 || queueResult.failed !== 0 ||
    afterLedger.tasks.some(task => task.status !== "done") || remaining.length !== 2 ||
    completedTaskAfter?.review?.verdict !== "accept" ||
    remaining.some(task => task.review?.verdict !== "accept") ||
    !remainingHostCountsValid ||
    !sameEvidence(taskIDsBefore[completedTaskID], taskIDsAfter[completedTaskID]) ||
    !sameEvidence(lineageBefore, lineageAfter) ||
    !sameEvidence(completedOwnerState, {
      baseline: fileEvidence(completedPaths.baseline),
      ownership: fileEvidence(completedPaths.ownership),
    })) {
    fail("follow-up resume did not complete remaining tasks without replaying t1 or changing its baseline lineage")
  }
  captureLinuxVerificationEvidence(run, runtime, sessionID)
  const finalCompleted = await runtime.verifier.reconcile(completedEvidence.reference)
  if (finalCompleted.outcome !== "terminal" || !finalCompleted.result ||
    !authenticateLinuxVerification(finalCompleted.result, completedEvidence.reference) ||
    finalCompleted.result.proof?.receipt !== completedEvidence.result.proof?.receipt ||
    finalCompleted.result.proof?.signature !== completedEvidence.result.proof?.signature) {
    fail("t1 native result changed after remaining task completion")
  }
  run.completedTaskVerifierEvidenceAfter = {
    executionID: completedEvidence.executionID,
    taskID: completedTaskID,
    reference: completedEvidence.reference,
    result: finalCompleted.result,
  }
  run.remainingTaskAcceptance = {
    done: queueResult.done,
    taskIDs: remaining.map(task => task.id),
    reviewerVerdicts: remaining.map(task => ({ taskID: task.id, verdict: task.review?.verdict })),
    workerExecutionIDs: remaining.flatMap(task => taskHostExecutions(runtime, sessionID, task.id, "worker").map(item => item.executionId)),
    reviewerExecutionIDs: remaining.flatMap(task => taskHostExecutions(runtime, sessionID, task.id, "reviewer").map(item => item.executionId)),
    verifierExecutionIDs: executionRecordsFor(runtime, sessionID).filter(execution => execution.kind === "verifier").map(item => item.executionId),
  }
  run.activeVerifierStage = "remaining-tasks-completed"
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
      verifier: args.verifier,
      parentSessionID: parentID,
      processID: process.pid,
      sdkEntry: sdk.entry,
      startedAt: new Date().toISOString(),
      planSha256: canonicalPlanSha(plan),
    }
    receipt.runs.push(run)
    let { runtime, queue } = createRuntime(args.worktree, client, args.scenario, args.verifier)
    runtime.linuxAdmission?.assertBootEpoch()
    if (args.verifier !== "legacy") {
      phase = "preflight native Linux verifier"
      const preflight = await runtime.verifier.preflight(runtime.verificationProfile)
      run.verifierPreflight = preflight
      if (!preflight.compatible) fail(`Linux verifier preflight failed: ${preflight.problems.join("; ")}`)
    }
    run.isolatedWorktrees = runtime.config.delegate.worktree
    const children: ChildRecord[] = []
    const injection: AnyRecord = {}
    const taskBaselineLineages: Record<string, TaskBaselineLineage> = {}
    run.taskBaselineLineages = taskBaselineLineages
    if (args.verifier !== "legacy" && (args.scenario === "retry" || args.scenario === "reject")) {
      run.driver_fault_injection = injection
    }
    installTrackedHost(runtime, args.scenario, args.verifier, () => phase, receipt, children, injection, taskBaselineLineages)
    run.children = children

    if (args.scenario === "resume") {
      phase = "read interrupted ledger without resetting it"
      const beforeLedger = readLedger(args.worktree, parentID)
      if (beforeLedger.tasks.length !== 3 || beforeLedger.tasks.some((task, index) => task.id !== `t${index + 1}`)) {
        fail("resume requires the existing three-task interrupt ledger; no tasks were added")
      }
      const previousScenario = receipt.runs.slice(0, -1).findLast(previous =>
        ["interrupt", "checkpoint", "active-verifier"].includes(String(previous.scenario)))?.scenario
      if (previousScenario === "active-verifier") {
        const previousActiveResume = receipt.runs.slice(0, -1).findLast(previous =>
          previous.scenario === "resume" && typeof previous.activeVerifierStage === "string")
        if (previousActiveResume?.activeVerifierStage === "retirement-recorded") {
          phase = "freshly authenticate native retirement and resume remaining tasks"
          await runActiveVerifierFollowupResume(receipt, previousActiveResume, run, runtime, queue, args.worktree, parentID)
          return
        }
        if (!previousActiveResume) {
          phase = "refuse running native verifier and record signed natural retirement"
          await runActiveVerifierFirstResume(receipt, run, runtime, queue, args.worktree, parentID)
          return
        }
      }
      const before = snapshot(runtime, args.worktree, parentID)
      run.before = before
      run.beforeChildSessionIDs = childSessionIDsFromState(before.executionState as AnyRecord)
      run.beforeAttempts = Object.fromEntries(beforeLedger.tasks.map((task) => [task.id, task.attempts]))
      run.completedTaskIDsBefore = beforeLedger.tasks.filter((task) => task.status === "done").map((task) => task.id)
      const beforeTaskExecutionIDs = durableTaskExecutionIDs(runtime, parentID)
      run.beforeTaskExecutionIDs = beforeTaskExecutionIDs
      if (args.verifier !== "legacy") captureLinuxVerificationEvidence(run, runtime, parentID)

      phase = "resume existing queue ledger"
      const queueResult: QueueRun = await queue.run(parentID, { resumed: true })
      run.queueResult = queueResult
      const afterLedger = readLedger(args.worktree, parentID)
      const after = snapshot(runtime, args.worktree, parentID)
      run.after = after
      run.afterChildSessionIDs = childSessionIDsFromState(after.executionState as AnyRecord)
      run.afterAttempts = Object.fromEntries(afterLedger.tasks.map((task) => [task.id, task.attempts]))
      run.completedTaskIDsAfter = afterLedger.tasks.filter((task) => task.status === "done").map((task) => task.id)
      const afterTaskExecutionIDs = durableTaskExecutionIDs(runtime, parentID)
      run.afterTaskExecutionIDs = afterTaskExecutionIDs
      if (args.verifier !== "legacy") {
        captureLinuxVerificationEvidence(run, runtime, parentID)
        assertNativeRecordProfiles(runtime, parentID)
      }
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
      if (completedBefore.some(taskID => !sameEvidence(beforeTaskExecutionIDs[taskID], afterTaskExecutionIDs[taskID]))) {
        addScenarioFailure(receipt, run, "resume changed durable host or verifier execution IDs for a completed task")
      }
      return
    }

    phase = "convert plan steps to real queue tasks"
    const allInputs: TaskInput[] = planToTasks(plan)
    const taskCount = args.scenario === "success" || args.scenario === "verifier-cancel" || args.scenario === "retry" || args.scenario === "reject"
      ? 1
      : args.scenario === "cancel" ? 2 : 3
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
    let queueFinished = false
    const queuePromise = queue.run(parentID).finally(() => { queueFinished = true })

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
        ? await waitForBusy(client, targetChild)
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
      if (args.verifier !== "legacy") assertNativeRecordProfiles(runtime, parentID)
      const workerCountBeforeRetry = workerDispatchCount(children)
      const executionIDsBeforeRetry = args.verifier !== "legacy" ? durableExecutionIDs(runtime, parentID) : undefined
      run.retryQueueResult = await queue.run(parentID)
      run.workerDispatchesBeforeRetry = workerCountBeforeRetry
      run.workerDispatchesAfterRetry = workerDispatchCount(children)
      const newWorkerDispatch = workerDispatchCount(children) > workerCountBeforeRetry
      run.newWorkerDispatchOnRetry = newWorkerDispatch
      run.afterRetry = snapshot(runtime, args.worktree, parentID)
      if (executionIDsBeforeRetry) {
        assertNativeRecordProfiles(runtime, parentID)
        const executionIDsAfterRetry = durableExecutionIDs(runtime, parentID)
        run.executionIDsBeforeRetry = executionIDsBeforeRetry
        run.executionIDsAfterRetry = executionIDsAfterRetry
        if (!sameEvidence(executionIDsBeforeRetry, executionIDsAfterRetry)) {
          addScenarioFailure(receipt, run, "a new durable host or verifier execution was dispatched by queue.run after user_stop")
        }
      }
      if (newWorkerDispatch) addScenarioFailure(receipt, run, "a new worker was dispatched by queue.run after user_stop")
      return
    }

    if (args.scenario === "verifier-cancel") {
      phase = "cancel active native verifier through queue.abort"
      await runVerifierCancellation(receipt, runtime, queue, queuePromise, args.worktree, parentID, added[0]!.id, run)
      return
    }

    if (args.scenario === "active-verifier") {
      phase = "observe active t2 native verifier before self-interrupt"
      let boundaryRef: VerificationReference | undefined
      const deadline = queueLifecycleWaitMs(runtime.config.delegate)
      await waitUntil(() => {
        const ledger = readLedger(args.worktree, parentID)
        const record = runtime.runs.status().executions.findLast(execution =>
          execution.ownerSession === parentID && execution.kind === "verifier" && execution.taskId === added[1]!.id &&
          execution.verifierDispatch === "started" && !execution.terminal && execution.boundaryRef && "kind" in execution.boundaryRef)
        if (record?.boundaryRef && "kind" in record.boundaryRef) boundaryRef = record.boundaryRef as VerificationReference
        return ledger.tasks[0]?.status === "done" && ledger.tasks[1]?.status === "running" &&
          ledger.tasks[2]?.status === "pending" && !!boundaryRef && readCgroupPopulated()
      }, deadline, "active-native-verifier-not-observed-before-self-sigkill")
      if (!boundaryRef) fail("active native verifier boundary reference missing")
      const ledger = readLedger(args.worktree, parentID)
      const runningVerifier = runtime.runs.status().executions.find(execution => execution.executionId === boundaryRef!.executionID)
      if (!runningVerifier || runningVerifier.kind !== "verifier" || runningVerifier.taskId !== added[1]!.id ||
        runningVerifier.verifierDispatch !== "started" || runningVerifier.terminal || !readCgroupPopulated()) {
        fail("active native verifier retired before the self-interrupt boundary was persisted")
      }
      const paths = taskOwnerPaths(args.worktree, parentID, added[1]!.id)
      const baseline = fileEvidence(paths.baseline)
      const ownership = fileEvidence(paths.ownership)
      if (!baseline.exists || !ownership.exists) fail("active native verifier task baseline or ownership is missing")
      const authenticated = captureLinuxVerificationEvidence(run, runtime, parentID)
      const completedTaskVerifierEvidence = authenticated.find(item => item.taskID === added[0]!.id)
      const completedTaskBaselineLineage = taskBaselineLineages[added[0]!.id]
      const completedTaskPaths = taskOwnerPaths(args.worktree, parentID, added[0]!.id)
      const completedTaskOwnerState = {
        baseline: fileEvidence(completedTaskPaths.baseline),
        ownership: fileEvidence(completedTaskPaths.ownership),
      }
      if (!completedTaskVerifierEvidence || !completedTaskBaselineLineage || completedTaskVerifierEvidence.result.parentExit !== 0 ||
        completedTaskVerifierEvidence.result.cancelled || completedTaskVerifierEvidence.result.timedOut ||
        ledger.tasks[0]?.status !== "done" || ledger.tasks[0]?.review?.verdict !== "accept" || ledger.tasks[1]?.status !== "running") {
        fail("active native verifier boundary lacks an authenticated completed t1 result")
      }
      assertNativeRecordProfiles(runtime, parentID)
      const executionIDs = durableExecutionIDs(runtime, parentID)
      run.interruption = {
        boundary: "active_native_verifier_before_t2_retirement",
        persistedAt: new Date().toISOString(),
        parentSessionID: parentID,
        taskID: added[1]!.id,
        boundaryRef,
        verifierDispatch: runningVerifier.verifierDispatch,
        cgroupPopulated: true,
        completedTaskIDs: [added[0]!.id],
        completedTaskExecutionIDs: durableTaskExecutionIDs(runtime, parentID)[added[0]!.id],
        completedTaskExecutionLineage: taskExecutionLineage(runtime, parentID, added[0]!.id),
        completedTaskBaselineLineage,
        completedTaskOwnerState,
        ledger: summarizeLedger(ledger),
        ledgerFile: fileDigest(ledgerPath(args.worktree, parentID)),
        baseline,
        ownership,
        mainGitState: mainGitState(args.worktree),
        executionIDs,
        completedTaskVerifierEvidence,
        executionState: summarizeExecutions(runtime, parentID),
      }
      run.finishedAt = new Date().toISOString()
      persistReceipt(args.receipt, receipt)
      writeSync(1, Buffer.from(`${JSON.stringify({ receipt: args.receipt })}\n`))
      process.kill(process.pid, "SIGKILL")
      throw new Error("SIGKILL returned unexpectedly")
    }

    if (args.scenario === "checkpoint") {
      const deadline = Date.now() + runtime.config.delegate.task_ttl_ms +
        runtime.config.delegate.review_ttl_ms + runtime.config.delegate.verify_timeout_ms + BUSY_POLL_MS
      while (Date.now() < deadline) {
        const ledger = readLedger(args.worktree, parentID)
        const state = runtime.runs.status()
        if (ledger.tasks[0]?.status === "done" && ledger.tasks.slice(1).every(task => task.status === "pending") &&
          !state.executions.some(execution => execution.ownerSession === parentID && execution.taskId === added[1]!.id)) {
          if (args.verifier !== "legacy") captureLinuxVerificationEvidence(run, runtime, parentID)
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
      while (Date.now() < deadline && !targetChild && !queueFinished) {
        targetChild = workerForTask(children, targetTaskID)
        if (!targetChild) await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_INTERVAL_MS))
      }
      const busy: BusyObservation = targetChild
        ? await waitForBusy(client, targetChild)
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
      if (args.verifier !== "legacy") captureLinuxVerificationEvidence(run, runtime, parentID)
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
    if (args.verifier !== "legacy" && injection.appliedAt !== undefined) {
      run.driver_fault_injection = injection
    }
    const after = snapshot(runtime, args.worktree, parentID)
    run.after = after
    const ledger = readLedger(args.worktree, parentID)
    if (args.scenario === "retry") validateRetryObservation(receipt, run, runtime, ledger.tasks)
    if (args.verifier !== "legacy") {
      captureLinuxVerificationEvidence(run, runtime, parentID)
      assertNativeRecordProfiles(runtime, parentID)
      if (args.scenario === "success" || args.scenario === "retry") {
        const targetID = added[0]!.id
        const task = ledger.tasks[0]
        const expectedWorkerRuns = args.scenario === "retry" ? 2 : 1
        const expectedVerifierRuns = args.scenario === "retry" ? 2 : 1
        const records = executionRecordsFor(runtime, parentID)
        const verifiers = records.filter(execution => execution.kind === "verifier" && execution.taskId === targetID)
        const evidence = verificationRecords(records).filter(item => item.record.taskId === targetID)
        const exits = evidence.map(item => item.result.parentExit)
        if (queueResult.aborted || queueResult.done !== 1 || queueResult.failed !== 0 || ledger.tasks.length !== 1 ||
          task?.status !== "done" || task?.review?.verdict !== "accept" ||
          taskHostExecutions(runtime, parentID, targetID, "worker").length !== expectedWorkerRuns ||
          taskHostExecutions(runtime, parentID, targetID, "reviewer").length !== 1 ||
          verifiers.length !== expectedVerifierRuns || evidence.length !== expectedVerifierRuns ||
          evidence.some(item => item.reference.profile !== "linux-single-use" ||
            !authenticateLinuxVerification(item.result, item.reference) || !item.result.proof?.receipt || !item.result.proof.signature)) {
          fail(`${args.scenario} did not complete through authenticated native verification and an actual ACCEPT review`)
        }
        if (args.scenario === "retry" && (task?.attempts !== 2 || exits.length !== 2 || exits[0] === 0 || exits[1] !== 0 ||
          injection.applicationCount !== 1 || injection.source !== "driver_fault_injection")) {
          fail("Linux retry did not produce exactly one injected native failure and one passing repair attempt")
        }
        if (args.scenario === "success" && (task?.attempts !== 1 || exits.length !== 1 || exits[0] !== 0)) {
          fail("success did not produce one passing authenticated native verification")
        }
        run.nativeAcceptance = {
          done: queueResult.done,
          reviewerVerdict: task?.review?.verdict,
          workerExecutionIDs: taskHostExecutions(runtime, parentID, targetID, "worker").map(execution => execution.executionId),
          reviewerExecutionIDs: taskHostExecutions(runtime, parentID, targetID, "reviewer").map(execution => execution.executionId),
          verifierExecutionIDs: verifiers.map(execution => execution.executionId),
          verifierExitCodes: exits,
        }
        run.forgedEvidence = await assertForgedEvidenceRefused(runtime, records)
      }
    }
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
  if (receipt.failures.length > priorFailureCount || receipt.modelAborts.length > 0) process.exitCode = 1
}

if (import.meta.main) void main()
