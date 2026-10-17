#!/usr/bin/env bun
/**
 * Real Git/queue/Linux-verifier qualification with deliberately synthetic workers
 * and reviewer. This is not whole-agent containment or live-model qualification.
 * The Linux verifier remains explicitly opt-in with qualification:true; normal
 * framework runtime selection is not changed.
 * Run with Bun as the profile's controller UID: --scenario success|retry|cancel|crash-checkpoint|crash-ambiguous.
 */
import { createHash, randomUUID } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_CONFIG, type OtterConfig } from "../framework/src/config.ts"
import type { ExecutionRequest, ExecutionRuntime } from "../framework/src/hosts/types.ts"
import { createExecutionPolicy } from "../framework/src/hosts/tool-policy.ts"
import { authenticateLinuxVerification } from "../framework/src/hosts/linux-domain.ts"
import { createExecutionRunStore, type ExecutionRecord } from "../framework/src/hosts/run-state.ts"
import { stateRoot } from "../framework/src/state/store.ts"
import { createLinuxVerifierExecutor } from "../framework/src/orchestration/linux-verifier.ts"
import { createQueue, type QueueRun } from "../framework/src/orchestration/queue.ts"
import { ledgerPath, readLedger, type LedgerTask, type TaskInput } from "../framework/src/state/ledger.ts"
import { worktreeRoot } from "../framework/src/orchestration/worktree.ts"
import type { VerificationReference, VerificationResult } from "../framework/src/orchestration/verifier.ts"

const SCRIPT = fileURLToPath(import.meta.url)
const UNIT_CGROUP_EVENTS = "/sys/fs/cgroup/otter.slice/otter-verifier.service/cgroup.events"
const GIT_ENV = {
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TEMPLATE_DIR: "",
}
const SCENARIOS = ["success", "retry", "cancel", "crash-checkpoint", "crash-ambiguous"] as const

type Scenario = (typeof SCENARIOS)[number]
type CoordinatorArgs = {
  scratch: string
  repo: string
  stateHome: string
  sessionID: string
  eventLog: string
  resultPath: string
  phase: "initial" | "resume"
  taskIDs: string[]
  scenario: Scenario
  pauseTaskID?: string
}
type Args = {
  scenario: Scenario
  receipt: string
  keepSuccessArtifacts: boolean
  internal?: CoordinatorArgs
}
type EventRecord = { event: string; role: string; taskID: string; executionID: string; attemptID: string; at: number }
type Report = Record<string, unknown>

class QualificationFailure extends Error {
  constructor(readonly code: string) { super(code) }
}

function fail(code: string): never { throw new QualificationFailure(code) }
function nowISO(): string { return new Date().toISOString() }
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex") }

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>()
  let keepSuccessArtifacts = false
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    if (flag === "--keep-success-artifacts") {
      if (keepSuccessArtifacts) fail("duplicate-option")
      keepSuccessArtifacts = true
      continue
    }
    if (!new Set(["--scenario", "--receipt", "--internal"]).has(flag) || values.has(flag)) fail("invalid-or-duplicate-option")
    const value = argv[++index]
    if (!value || value.startsWith("--")) fail("missing-option-value")
    values.set(flag, value)
  }
  if (values.has("--internal")) {
    let internal: CoordinatorArgs | undefined
    try { internal = JSON.parse(values.get("--internal")!) as CoordinatorArgs }
    catch { fail("invalid-internal-coordinator-arguments") }
    if (!internal || !isAbsolute(internal.scratch) || !isAbsolute(internal.repo) || !isAbsolute(internal.stateHome) ||
      !isAbsolute(internal.eventLog) || !isAbsolute(internal.resultPath) ||
      !(internal.phase === "initial" || internal.phase === "resume") ||
      !(SCENARIOS as readonly string[]).includes(internal.scenario) || !Array.isArray(internal.taskIDs) ||
      internal.taskIDs.some(value => typeof value !== "string" || !value)) fail("invalid-internal-coordinator-arguments")
    if (internal.pauseTaskID !== undefined && (typeof internal.pauseTaskID !== "string" || !internal.pauseTaskID)) fail("invalid-internal-coordinator-arguments")
    return { scenario: "success", receipt: "", keepSuccessArtifacts, internal }
  }
  const scenario = values.get("--scenario") ?? "success"
  if (!(SCENARIOS as readonly string[]).includes(scenario)) fail("invalid-scenario")
  const receipt = values.get("--receipt")
  if (receipt && !isAbsolute(receipt)) fail("receipt-path-must-be-absolute")
  return {
    scenario: scenario as Scenario,
    receipt: receipt ?? join(tmpdir(), `otter-linux-verifier-queue-${randomUUID()}.json`),
    keepSuccessArtifacts,
  }
}

function canonicalNewFile(path: string): string {
  const absolute = resolve(path)
  let targetExists = false
  try { lstatSync(absolute); targetExists = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("receipt-path-unavailable") }
  if (!isAbsolute(path) || absolute !== path || !existsSync(dirname(absolute)) || realpathSync(dirname(absolute)) !== dirname(absolute) || targetExists) {
    fail("receipt-path-must-be-new-with-existing-canonical-parent")
  }
  return absolute
}

function writeNewJson(path: string, value: unknown): void {
  const descriptor = openSync(path, "wx", 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
}

function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    }).trim()
  } catch { fail("fixture-git-command-failed") }
}

function initializeRepository(path: string, scenario: Scenario, marker: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  git(path, "init", "--quiet")
  git(path, "config", "user.name", "Otter Linux verifier qualification")
  git(path, "config", "user.email", "verifier-qualification@localhost")
  writeFileSync(join(path, "README.md"), "isolated native-verifier queue fixture\n")
  writeFileSync(join(path, "verify_e2.sh"), "#!/bin/sh\ntest \"$(/usr/bin/cat qualification.txt)\" = PASS\n")
  writeFileSync(join(path, "verify_second.sh"), "#!/bin/sh\ntest \"$(/usr/bin/cat qualification.txt)\" = SECOND\n")
  writeFileSync(join(path, "verify_slow.sh"), "#!/bin/sh\n/usr/bin/sleep 20\ntest \"$(/usr/bin/cat qualification.txt)\" = SECOND\n")
  const writer = [
    "import os, signal, time",
    "pid = os.fork()",
    "if pid:",
    "    os._exit(0)",
    "os.setsid()",
    "pid = os.fork()",
    "if pid:",
    "    os._exit(0)",
    "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    `path = '/run/otter-verifier-output/${marker}'`,
    "with open(path + '.ready', 'x', encoding='ascii') as ready:",
    "    ready.write(str(os.getpid()))",
    "counter = 0",
    "while True:",
    "    with open(path + '.beat', 'w', encoding='ascii') as heartbeat:",
    "        heartbeat.write(str(counter))",
    "    counter += 1",
    "    time.sleep(0.05)",
  ].join("\n")
  writeFileSync(join(path, "verify_cancel.sh"), `#!/bin/sh\n/usr/bin/python3 -c ${shellQuote(writer)}\n`)
  writeFileSync(join(path, "qualification.txt"), "BASE\n")
  git(path, "add", "--all")
  git(path, "commit", "--quiet", "-m", `qualification fixture ${scenario}`)
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

function appendEvent(path: string, value: EventRecord): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

function readEvents(path: string): EventRecord[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as EventRecord)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    fail("qualification-event-log-corrupt")
  }
}

function makeConfig(scenario: Scenario): OtterConfig {
  return {
    ...DEFAULT_CONFIG,
    delegate: {
      ...DEFAULT_CONFIG.delegate,
      worktree: true,
      review: true,
      max_attempts: scenario === "retry" ? 2 : 1,
      task_ttl_ms: 20_000,
      review_ttl_ms: 10_000,
      queue_ttl_ms: 90_000,
      verify_timeout_ms: scenario === "crash-ambiguous" ? 15_000 : 45_000,
      verify_output_chars: 4096,
    },
  }
}

function makeRuntime(args: { repo: string; stateHome: string; eventLog: string; scenario: Scenario; pauseTaskID?: string }): ExecutionRuntime {
  process.env.OTTER_STATE_HOME = args.stateHome
  const config = makeConfig(args.scenario)
  const policy = createExecutionPolicy(config, { directory: args.repo, worktree: args.repo })
  const runs = createExecutionRunStore(args.repo)
  const verifier = createLinuxVerifierExecutor({ qualification: true })
  const host: ExecutionRuntime["host"] = {
    identity: { engine: "synthetic-qualification-host", profile: "synthetic-worker-reviewer-only" },
    async preflight() {
      return { compatible: true, controls: { "synthetic-child": "supported" }, problems: [] }
    },
    async reconcile() {
      return { outcome: "terminal", quiescent: true, evidence: "synthetic worker/reviewer process ended with its coordinator" }
    },
    async prepare(request: ExecutionRequest) {
      const reference = { executionID: request.executionID, vendorSessionID: `qualification-${randomUUID()}` }
      request.onReference?.(reference)
      policy.bindSession(reference.vendorSessionID!, request.handlers, request.policy)
      let ran = false
      return {
        reference,
        async run() {
          if (ran) throw new Error("synthetic host request replayed")
          ran = true
          const before = readEvents(args.eventLog)
          const ordinal = before.filter(event => event.event === "worker-run-returned" && event.role === request.role && event.taskID === request.taskID).length + 1
          appendEvent(args.eventLog, {
            event: "worker-run-started", role: request.role, taskID: request.taskID,
            executionID: request.executionID, attemptID: request.attemptID, at: Date.now(),
          })
          if (request.role === "worker") {
            const contents = args.scenario === "retry" && ordinal === 1 ? "FAIL\n" :
              args.scenario !== "retry" && request.taskID === "t2" ? "SECOND\n" : "PASS\n"
            writeFileSync(join(request.cwd, "qualification.txt"), contents)
            appendEvent(args.eventLog, {
              event: "worker-run-returned", role: request.role, taskID: request.taskID,
              executionID: request.executionID, attemptID: request.attemptID, at: Date.now(),
            })
            if (request.taskID === args.pauseTaskID) {
              const release = join(args.stateHome, "release-coordinator")
              const deadline = Date.now() + 20_000
              while (!existsSync(release) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
              if (!existsSync(release)) throw new Error("qualification handshake deadline")
            }
            return { status: "completed" as const, text: "Files changed: qualification.txt\nOpen issues: none" }
          }
          appendEvent(args.eventLog, {
            event: "reviewer-run-returned", role: request.role, taskID: request.taskID,
            executionID: request.executionID, attemptID: request.attemptID, at: Date.now(),
          })
          if (args.scenario === "crash-ambiguous" && request.taskID === "t1") {
            // The first terminal reference expires naturally while the existing bounded
            // second-task verifier runs; subsequent verification keeps its normal 45s cap.
            config.delegate.verify_timeout_ms = 45_000
          }
          return { status: "completed" as const, text: "ACCEPT" }
        },
        async requestCancel() {
          return { requested: true, acknowledged: true, terminal: true, quiescent: true, evidence: "synthetic coordinator-owned handle" }
        },
        async reconcile() {
          return { outcome: "terminal" as const, quiescent: true, evidence: "synthetic coordinator-owned request completed" }
        },
      }
    },
  }
  return {
    instance: "otter-linux-verifier-qualification",
    directory: args.repo,
    worktree: args.repo,
    stateRoot: stateRoot(args.repo),
    config,
    log() {},
    host,
    verificationProfile: "linux-single-use",
    verifier,
    runs,
    policy,
  }
}

function taskInputs(scenario: Scenario): TaskInput[] {
  if (scenario === "retry") return [{ title: "retry a real nonzero verifier result", detail: "Synthetic worker writes FAIL once then PASS; the queue must honor the first nonzero native result.", verify: "sh verify_e2.sh" }]
  if (scenario === "cancel") return [{ title: "cancel a detached verifier process family", detail: "A setsid double-fork writer ignores TERM; abort only through the authenticated verifier gate.", verify: "sh verify_cancel.sh" }]
  if (scenario === "crash-ambiguous") return [
    { title: "complete a checkpoint before the ambiguous verifier", detail: "This accepted task must not be dispatched again after coordinator recovery.", verify: "sh verify_e2.sh" },
    { title: "preserve an active verifier baseline on ambiguous recovery", detail: "The verifier sleeps in its owned cgroup; restart must refuse while it remains active.", verify: "sh verify_slow.sh" },
  ]
  if (scenario === "crash-checkpoint") return [
    { title: "complete task before coordinator crash", detail: "This task is durably accepted before the coordinator is killed.", verify: "sh verify_e2.sh" },
    { title: "resume an interrupted next task", detail: "The task worktree is recovered after its coordinator is killed.", verify: "sh verify_second.sh" },
  ]
  return [{ title: "accept a benign Linux verifier result", detail: "Synthetic worker writes PASS; the real queue, Git snapshot, Linux gate and signed receipt are required.", verify: "sh verify_e2.sh" }]
}

function statusSummary(run: QueueRun, ledger: ReturnType<typeof readLedger>): Report {
  return {
    taskIDs: run.taskIds,
    done: run.done,
    failed: run.failed,
    cancelled: run.cancelled,
    aborted: run.aborted,
    skipped: run.skipped,
    tasks: ledger.tasks.map(task => ({ id: task.id, status: task.status, attempts: task.attempts,
      verifyOK: task.verify_result?.ok, verifyExitCode: task.verify_result?.exitCode, review: task.review?.verdict })),
  }
}

export function verificationRecords(records: ExecutionRecord[]): Array<{ record: ExecutionRecord; reference: VerificationReference; result: VerificationResult }> {
  const found: Array<{ record: ExecutionRecord; reference: VerificationReference; result: VerificationResult }> = []
  for (const record of records) {
    if (record.kind !== "verifier" || !record.boundaryRef || !("kind" in record.boundaryRef)) continue
    const reference = record.boundaryRef as VerificationReference
    const result = record.terminal?.verification ?? record.reconciliation?.verification
    if (result) found.push({ record, reference, result })
  }
  return found
}

export function assertAuthenticatedResults(records: ExecutionRecord[]): Array<Report> {
  const proofs: Array<Report> = []
  for (const { record, reference, result } of verificationRecords(records)) {
    if (!authenticateLinuxVerification(result, reference) || !result.proof?.receipt || !result.proof.signature) {
      fail("queue-verifier-receipt-not-authenticated")
    }
    proofs.push({ executionID: record.executionId, taskID: record.taskId, parentExit: result.parentExit,
      cancelled: result.cancelled, timedOut: result.timedOut, integrity: result.integrity,
      receipt: result.proof.receipt, signature: result.proof.signature })
  }
  return proofs
}

export async function assertForgedEvidenceRefused(runtime: ExecutionRuntime, records: ExecutionRecord[]): Promise<Report> {
  const verified = verificationRecords(records).find(item => item.result.parentExit === 0 && !item.result.cancelled && !item.result.timedOut)
  if (!verified) fail("no-successful-receipt-for-forgery-check")
  const { reference, result } = verified
  const wrongReference: VerificationReference = { ...reference, invocationID: randomUUID().replaceAll("-", "") }
  if (authenticateLinuxVerification(result, wrongReference) || authenticateLinuxVerification(result, reference) !== true) {
    fail("mismatched-verifier-reference-authentication")
  }
  const original = result.proof!
  const badReceipt: VerificationResult = { ...result, proof: { ...original, receipt: `${original.receipt} ` } }
  const signature = original.signature!
  const badSignature: VerificationResult = {
    ...result,
    proof: { ...original, signature: `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}` },
  }
  const badProofReference: VerificationResult = { ...result, proof: { ...original, reference: wrongReference } }
  const badOutput: VerificationResult = { ...result, output: `${result.output}tampered` }
  if (authenticateLinuxVerification(badReceipt, reference) || authenticateLinuxVerification(badSignature, reference) ||
      authenticateLinuxVerification(badOutput, reference) ||
      authenticateLinuxVerification(badProofReference, reference)) fail("forged-verifier-receipt-authentication")
  const reconciled = await runtime.verifier.reconcile(wrongReference)
  if (reconciled.outcome === "terminal" || reconciled.result) fail("mismatched-verifier-reference-reconciled")
  return { mismatchedReferenceRefused: true, tamperedReceiptRefused: true, tamperedSignatureRefused: true,
    tamperedOutputRefused: true, mismatchedProofReferenceRefused: true, forgedReconciliationNotTerminal: true }
}

function readEventsSafe(path: string): EventRecord[] { return readEvents(path) }
function countRuns(events: EventRecord[], role: string, taskID: string): number {
  const completedEvent = role === "reviewer" ? "reviewer-run-returned" : "worker-run-returned"
  return events.filter(event => event.event === completedEvent && event.role === role && event.taskID === taskID).length
}
export function readCgroupPopulated(): boolean {
  try {
    const raw = readFileSync(UNIT_CGROUP_EVENTS, "ascii")
    return /^populated 1$/m.test(raw)
  } catch { return false }
}

export async function waitForAuthenticatedTerminal(runtime: ExecutionRuntime, reference: VerificationReference, timeoutMs: number): Promise<VerificationResult> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const observed = await runtime.verifier.reconcile(reference)
    if (observed.outcome === "terminal" && observed.result && authenticateLinuxVerification(observed.result, reference)) {
      return observed.result
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  fail("native-retirement-not-authenticated-within-bound")
}

export async function waitUntil(predicate: () => boolean, timeoutMs: number, code: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (predicate()) return
  fail(code)
}

export function taskOwnerPaths(repo: string, sessionID: string, taskID: string): { path: string; owner: string; baseline: string; ownership: string } {
  const path = join(worktreeRoot(repo), sessionID, taskID)
  const owner = join(worktreeRoot(repo), ".recovery", sessionID, taskID)
  return { path, owner, baseline: join(owner, "baseline", "baseline.json"), ownership: join(owner, "ownership.json") }
}

export function fileEvidence(path: string): { exists: boolean; sha256?: string; mode?: number; size?: number } {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("unsafe-qualification-evidence-file")
    const bytes = readFileSync(path)
    return { exists: true, sha256: hash(bytes), mode: info.mode & 0o777, size: info.size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }
    throw error
  }
}

function queueResultFile(path: string, run: QueueRun, repo: string, sessionID: string, runtime: ExecutionRuntime): void {
  const ledger = readLedger(repo, sessionID)
  const executions = runtime.runs.status().executions.map(record => ({
    executionID: record.executionId, taskID: record.taskId, role: record.role, kind: record.kind,
    verifierDispatch: record.verifierDispatch, terminal: record.terminal?.outcome,
    reconciled: record.reconciliation?.outcome, fenced: !!record.fence,
  }))
  writeNewJson(path, { run: statusSummary(run, ledger), executions })
}

function childEnvironment(stateHome: string): NodeJS.ProcessEnv {
  return { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: tmpdir(), TMPDIR: tmpdir(), LANG: "C", LC_ALL: "C",
    OTTER_STATE_HOME: stateHome, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: "" }
}

async function spawnCoordinator(values: CoordinatorArgs): Promise<{ child: ReturnType<typeof spawn>; closed: Promise<[number | null, NodeJS.Signals | null]> }> {
  const encoded = JSON.stringify(values)
  const child = spawn(process.execPath, [SCRIPT, "--internal", encoded], {
    cwd: values.repo, env: childEnvironment(values.stateHome), stdio: "ignore",
  })
  const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>
  return { child, closed }
}

async function killSpawnedCoordinator(child: ReturnType<typeof spawn>, closed: Promise<[number | null, NodeJS.Signals | null]>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) fail("coordinator-exited-before-kill-boundary")
  if (!child.kill("SIGKILL")) fail("coordinator-sigkill-failed")
  const [, signal] = await closed
  if (signal !== "SIGKILL") fail("coordinator-did-not-exit-by-sigkill")
}

async function waitForCoordinator(child: ReturnType<typeof spawn>, closed: Promise<[number | null, NodeJS.Signals | null]>,
  timeoutMs: number, code: string): Promise<[number | null, NodeJS.Signals | null]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })
  const result = await Promise.race([closed, expired])
  if (timer) clearTimeout(timer)
  if (result) return result
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  await closed
  fail(code)
}

async function runCrashCheckpoint(context: { scenario: Scenario; scratch: string; repo: string; stateHome: string; eventLog: string; sessionID: string; added: LedgerTask[]; runtime: ExecutionRuntime }): Promise<Report> {
  const resultPath = join(context.scratch, "checkpoint-coordinator-result.json")
  const taskIDs = context.added.map(task => task.id)
  const pauseTaskID = taskIDs[1]!
  const coordinatorArgs = {
    scratch: context.scratch, repo: context.repo, stateHome: context.stateHome, sessionID: context.sessionID,
    eventLog: context.eventLog, resultPath, phase: "initial" as const, taskIDs, pauseTaskID, scenario: context.scenario,
  }
  const { child, closed } = await spawnCoordinator(coordinatorArgs)
  try {
    await waitUntil(() => {
      const ledger = readLedger(context.repo, context.sessionID)
      const events = readEventsSafe(context.eventLog)
      return ledger.tasks[0]?.status === "done" && countRuns(events, "worker", pauseTaskID) === 1
    }, 50_000, "checkpoint-not-observed")
    const before = readLedger(context.repo, context.sessionID)
    if (before.tasks[0]?.status !== "done" || before.tasks[1]?.status !== "running") fail("checkpoint-ledger-boundary-invalid")
    const beforeRuns = context.runtime.runs.status().executions.filter(record => record.kind === "verifier").map(record => record.executionId)
    await killSpawnedCoordinator(child, closed)

    const resumePath = join(context.scratch, "checkpoint-resume-result.json")
    const resumed = await spawnCoordinator({ ...coordinatorArgs, resultPath: resumePath, phase: "resume", pauseTaskID: undefined })
    const [exitCode, signal] = await waitForCoordinator(resumed.child, resumed.closed, 60_000, "checkpoint-resume-deadline")
    if (signal || exitCode !== 0 || !existsSync(resumePath)) fail("checkpoint-resume-process-failed")
    const runSummary = JSON.parse(readFileSync(resumePath, "utf8")) as { run: { done: number; failed: number; aborted: boolean } }
    if (runSummary.run.done !== 1 || runSummary.run.failed !== 0 || runSummary.run.aborted) fail("checkpoint-resume-queue-failed")
    const ledger = readLedger(context.repo, context.sessionID)
    if (ledger.tasks.some(task => task.status !== "done")) fail("checkpoint-ledger-not-complete")
    if (readFileSync(join(context.repo, "qualification.txt"), "utf8") !== "SECOND\n" ||
        git(context.repo, "status", "--porcelain") !== "M qualification.txt") fail("resumed-task-not-merged-to-main")
    const events = readEventsSafe(context.eventLog)
    if (countRuns(events, "worker", taskIDs[0]!) !== 1 || countRuns(events, "worker", taskIDs[1]!) !== 2 ||
        countRuns(events, "reviewer", taskIDs[1]!) !== 1) fail("checkpoint-task-replay-or-recovery-invalid")
    const verifierRecords = context.runtime.runs.status().executions.filter(record => record.kind === "verifier")
    const firstVerifier = verifierRecords.find(record => record.taskId === taskIDs[0])
    if (!firstVerifier || beforeRuns.filter(id => id === firstVerifier.executionId).length !== 1 ||
        verifierRecords.filter(record => record.executionId === firstVerifier.executionId).length !== 1) {
      fail("completed-verifier-reran-after-checkpoint")
    }
    if (verifierRecords.length !== 2) fail("checkpoint-verifier-execution-count-invalid")
    const proofs = assertAuthenticatedResults(verifierRecords)
    return { coordinatorKilledBy: "SIGKILL", resumed: true, completedTaskWorkerRuns: 1,
      completedTaskVerifierExecutionID: firstVerifier.executionId, queue: runSummary.run,
      authenticatedReceiptCount: proofs.length, authenticatedReceipts: proofs }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await closed.catch(() => undefined)
    throw error
  }
}

async function runCrashAmbiguous(context: { scenario: Scenario; scratch: string; repo: string; stateHome: string; eventLog: string; sessionID: string; added: LedgerTask[]; runtime: ExecutionRuntime }): Promise<Report> {
  const initialResult = join(context.scratch, "ambiguous-coordinator-result.json")
  const taskIDs = context.added.map(task => task.id)
  const coordinatorArgs = {
    scratch: context.scratch, repo: context.repo, stateHome: context.stateHome, sessionID: context.sessionID,
    eventLog: context.eventLog, resultPath: initialResult, phase: "initial" as const, taskIDs, scenario: context.scenario,
  }
  const { child, closed } = await spawnCoordinator(coordinatorArgs)
  let reference: VerificationReference | undefined
  const activeRuntime = createExecutionRunStore(context.repo)
  try {
    await waitUntil(() => {
      const candidate = activeRuntime.status().executions.findLast(record => record.kind === "verifier" &&
        record.taskId === taskIDs[1] && record.verifierDispatch === "started" && !record.terminal &&
        record.boundaryRef && "kind" in record.boundaryRef)
      if (!candidate || !readCgroupPopulated()) return false
      reference = candidate.boundaryRef as VerificationReference
      return true
    }, 55_000, "active-verifier-not-observed-before-crash")
    const ledgerBefore = readFileSync(ledgerPath(context.repo, context.sessionID))
    const taskLedger = readLedger(context.repo, context.sessionID)
    if (taskLedger.tasks[0]?.status !== "done" || taskLedger.tasks[1]?.status !== "running") fail("ambiguous-ledger-boundary-invalid")
    const paths = taskOwnerPaths(context.repo, context.sessionID, taskIDs[1]!)
    const baselineBefore = fileEvidence(paths.baseline)
    const ownershipBefore = fileEvidence(paths.ownership)
    if (!baselineBefore.exists || !ownershipBefore.exists || !existsSync(paths.path)) fail("ambiguous-worktree-baseline-missing")
    const workerCountsBefore = taskIDs.map(taskID => countRuns(readEventsSafe(context.eventLog), "worker", taskID))
    const verifierExecutionIDsBefore = activeRuntime.status().executions.filter(record => record.kind === "verifier").map(record => record.executionId)
    if (workerCountsBefore[0] !== 1 || workerCountsBefore[1] !== 1 ||
        countRuns(readEventsSafe(context.eventLog), "reviewer", taskIDs[0]!) !== 1 ||
        countRuns(readEventsSafe(context.eventLog), "reviewer", taskIDs[1]!) !== 0 || verifierExecutionIDsBefore.length !== 2) {
      fail("ambiguous-crash-precondition-not-met")
    }
    await killSpawnedCoordinator(child, closed)

    const resumedPath = join(context.scratch, "ambiguous-resume-result.json")
    const resumed = await spawnCoordinator({ ...coordinatorArgs, resultPath: resumedPath, phase: "resume" })
    const [exitCode, signal] = await waitForCoordinator(resumed.child, resumed.closed, 10_000, "ambiguous-resume-deadline")
    if (signal || exitCode !== 0 || !existsSync(resumedPath)) fail("ambiguous-resume-process-failed")
    const resumeResult = JSON.parse(readFileSync(resumedPath, "utf8")) as { run: { aborted: boolean; done: number; failed: number } }
    if (!resumeResult.run.aborted || resumeResult.run.done !== 0) fail("ambiguous-resume-was-not-fenced")
    const ledgerAfter = readFileSync(ledgerPath(context.repo, context.sessionID))
    const baselineAfter = fileEvidence(paths.baseline)
    const ownershipAfter = fileEvidence(paths.ownership)
    if (!ledgerAfter.equals(ledgerBefore) || JSON.stringify(baselineAfter) !== JSON.stringify(baselineBefore) ||
        JSON.stringify(ownershipAfter) !== JSON.stringify(ownershipBefore) || !existsSync(paths.path)) {
      fail("ambiguous-recovery-mutated-ledger-or-baseline")
    }
    if (countRuns(readEventsSafe(context.eventLog), "worker", taskIDs[0]!) !== workerCountsBefore[0] ||
        countRuns(readEventsSafe(context.eventLog), "worker", taskIDs[1]!) !== workerCountsBefore[1] ||
        activeRuntime.status().executions.filter(record => record.kind === "verifier").map(record => record.executionId).join("\n") !== verifierExecutionIDsBefore.join("\n")) {
      fail("ambiguous-resume-replayed-worker-or-verifier")
    }
    if (!reference) fail("ambiguous-verifier-reference-missing")
    const stopped = await waitForAuthenticatedTerminal(context.runtime, reference, 45_000)
    if (stopped.parentExit !== 0 || stopped.cancelled || stopped.domainState !== "empty" || readCgroupPopulated()) {
      fail("ambiguous-verifier-natural-retirement-not-authenticated")
    }
    const completedVerifier = activeRuntime.status().executions.find(record => record.kind === "verifier" &&
      record.taskId === taskIDs[0] && record.terminal && record.boundaryRef && "kind" in record.boundaryRef)
    if (!completedVerifier || !completedVerifier.boundaryRef || !("kind" in completedVerifier.boundaryRef)) {
      fail("old-terminal-verifier-reference-missing")
    }
    const oldReference = completedVerifier.boundaryRef as VerificationReference
    if (oldReference.deadlineAt >= Date.now()) fail("old-terminal-reference-deadline-not-elapsed-naturally")
    const oldReconciliation = await context.runtime.verifier.reconcile(oldReference)
    if (oldReconciliation.outcome !== "terminal" || !oldReconciliation.result ||
        !authenticateLinuxVerification(oldReconciliation.result, oldReference) ||
        oldReconciliation.result.proof?.receipt !== completedVerifier.reconciliation?.verification?.proof?.receipt ||
        oldReconciliation.result.proof?.signature !== completedVerifier.reconciliation?.verification?.proof?.signature) {
      fail("expired-old-terminal-reference-reconciliation-failed")
    }
    if (!readFileSync(ledgerPath(context.repo, context.sessionID)).equals(ledgerBefore) ||
        JSON.stringify(fileEvidence(paths.baseline)) !== JSON.stringify(baselineBefore) ||
        JSON.stringify(fileEvidence(paths.ownership)) !== JSON.stringify(ownershipBefore) ||
        readFileSync(join(context.repo, "qualification.txt"), "utf8") !== "PASS\n" ||
        git(context.repo, "status", "--porcelain") !== "M qualification.txt") {
      fail("ambiguous-evidence-changed-after-native-retirement")
    }
    return {
      coordinatorKilledBy: "SIGKILL", resumedWithoutReplay: true, ambiguityFenced: true,
      completedTaskWorkerRuns: workerCountsBefore[0], activeTaskWorkerRuns: workerCountsBefore[1],
      ledgerPreserved: true, baselinePreserved: true, baselineSha256: baselineBefore.sha256,
      ownershipSha256: ownershipBefore.sha256, firstTaskStillDone: readLedger(context.repo, context.sessionID).tasks[0]?.status === "done",
      activeVerifierExecutionID: reference.executionID, verifierRetiredNaturallyAfterAmbiguousResume: true,
      expiredOldTerminalReferenceReconciled: true, oldTerminalReferenceDeadlineAt: oldReference.deadlineAt,
      oldTerminalReferenceExpiredByMs: Date.now() - oldReference.deadlineAt,
      reconciledOriginalReceipt: oldReconciliation.result.proof?.receipt,
      retirementReceipt: stopped.proof?.receipt, retirementSignature: stopped.proof?.signature,
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await closed.catch(() => undefined)
    if (reference) {
      try { await waitForAuthenticatedTerminal(context.runtime, reference, 45_000) } catch {}
    }
    throw error
  }
}

async function runCancellation(context: { scenario: Scenario; repo: string; sessionID: string; eventLog: string; runtime: ExecutionRuntime }): Promise<Report> {
  const queue = createQueue(context.runtime)
  const pending = queue.run(context.sessionID)
  const statusStore = createExecutionRunStore(context.repo)
  let reference: VerificationReference | undefined
  try {
    await waitUntil(() => {
      const record = statusStore.status().executions.findLast(item => item.kind === "verifier" && item.verifierDispatch === "started" && !item.terminal)
      if (!record || !record.boundaryRef || !("kind" in record.boundaryRef)) return false
      reference = record.boundaryRef as VerificationReference
      return readCgroupPopulated() && queue.isRunning(context.sessionID)
    }, 45_000, "queue-verifier-not-running-for-cancel")
    const ledger = readLedger(context.repo, context.sessionID)
    const taskID = ledger.tasks[0]!.id
    if (ledger.tasks[0]?.status !== "running" || ledger.tasks[0]?.review) fail("queue-accepted-before-native-retirement")
    if (readFileSync(join(context.repo, "qualification.txt"), "utf8") !== "BASE\n") fail("cancelled-task-merged-before-retirement")
    const paths = taskOwnerPaths(context.repo, context.sessionID, taskID)
    const baselineBefore = fileEvidence(paths.baseline)
    const ownershipBefore = fileEvidence(paths.ownership)
    if (!baselineBefore.exists || !ownershipBefore.exists) fail("cancelled-task-baseline-missing")

    await queue.abort(context.sessionID, "Linux verifier qualification cancellation")
    const run = await pending
    if (!run.aborted || run.done !== 0 || run.failed !== 0) fail("queue-cancellation-result-invalid")
    const fencedLedger = readLedger(context.repo, context.sessionID)
    if (fencedLedger.tasks[0]?.status !== "cancelled" || fencedLedger.tasks[0]?.review) fail("cancelled-task-was-accepted")
    if (!reference) fail("cancelled-verifier-reference-missing")
    const beforeRetirement = statusStore.status().executions.findLast(record => record.kind === "verifier" && record.taskId === taskID)
    if (!beforeRetirement) fail("queue-cancel-verifier-record-missing")
    let retiredImmediately = false
    let result: VerificationResult
    const immediate = beforeRetirement.reconciliation?.verification
    if (beforeRetirement.terminal && !beforeRetirement.fence && immediate &&
        authenticateLinuxVerification(immediate, reference) && immediate.cancelled) {
      retiredImmediately = true
      result = immediate
    } else {
      if (!beforeRetirement.fence) fail("queue-cancel-did-not-fence-unproven-retirement")
      result = await waitForAuthenticatedTerminal(context.runtime, reference, 35_000)
    }
    if (!result.cancelled || result.domainState !== "empty" || readCgroupPopulated()) fail("queue-cancel-retirement-not-authenticated")
    const resumed = await createQueue(context.runtime).run(context.sessionID, { resumed: true })
    if (resumed.aborted || resumed.done !== 0 || resumed.failed !== 0 || resumed.taskIds.length !== 0) {
      fail("cancelled-queue-resume-dispatched-additional-work")
    }
    const finalLedger = readLedger(context.repo, context.sessionID)
    const records = statusStore.status().executions
    const terminal = records.findLast(record => record.kind === "verifier" && record.taskId === taskID)
    if (finalLedger.tasks[0]?.status !== "cancelled" || finalLedger.tasks[0]?.review || !terminal?.reconciliation?.verification ||
        !authenticateLinuxVerification(terminal.reconciliation.verification, reference) || terminal.fence ||
        countRuns(readEventsSafe(context.eventLog), "worker", taskID) !== 1 || countRuns(readEventsSafe(context.eventLog), "reviewer", taskID) !== 0 ||
        records.filter(record => record.kind === "verifier").length !== 1 ||
        JSON.stringify(fileEvidence(paths.baseline)) !== JSON.stringify(baselineBefore) ||
        JSON.stringify(fileEvidence(paths.ownership)) !== JSON.stringify(ownershipBefore) ||
        readFileSync(join(context.repo, "qualification.txt"), "utf8") !== "BASE\n" || git(context.repo, "status", "--porcelain") !== "") {
      fail("cancelled-resume-mutated-work-or-replayed-execution")
    }
    return { queueAbortTerminalOutcome: retiredImmediately ? "authenticated-within-queue-abort-budget" : "fenced-then-authenticated-on-explicit-resume",
      queueAbortFencedBeforeRetirement: !retiredImmediately, rootCancellationRequestWasQueueOwned: true,
      resumedOnlyAfterAuthenticatedRetirement: true, additionalExecutionCount: 0, reviewOrMergeBeforeRetirement: false,
      taskStatus: "cancelled", baselineSha256: baselineBefore.sha256, ownershipSha256: ownershipBefore.sha256,
      cancellationReceipt: result.proof?.receipt, cancellationSignature: result.proof?.signature }
  } catch (error) {
    if (queue.isRunning(context.sessionID)) {
      try { await queue.abort(context.sessionID, "Linux verifier qualification cleanup") } catch {}
    }
    await pending.catch(() => undefined)
    if (reference) {
      try { await waitForAuthenticatedTerminal(context.runtime, reference, 35_000) } catch {}
    }
    throw error
  }
}

async function runNormal(context: { scenario: Scenario; repo: string; sessionID: string; eventLog: string; runtime: ExecutionRuntime; added: LedgerTask[] }): Promise<Report> {
  const queue = createQueue(context.runtime)
  const run = await queue.run(context.sessionID)
  const ledger = readLedger(context.repo, context.sessionID)
  if (run.aborted || run.failed !== 0 || run.done !== context.added.length || ledger.tasks.some(task => task.status !== "done")) {
    fail("real-queue-task-not-accepted")
  }
  const records = context.runtime.runs.status().executions
  const proofs = assertAuthenticatedResults(records)
  const verification = verificationRecords(records)
  if (context.scenario === "retry") {
    const targetID = context.added[0]!.id
    const target = verification.filter(record => record.record.taskId === targetID)
    if (target.length !== 2 || target[0]!.result.parentExit === 0 || target[1]!.result.parentExit !== 0 ||
        ledger.tasks[0]?.attempts !== 2 || countRuns(readEventsSafe(context.eventLog), "worker", targetID) !== 2 ||
        countRuns(readEventsSafe(context.eventLog), "reviewer", targetID) !== 1) fail("nonzero-retry-observation-invalid")
  } else {
    if (verification.length !== 1 || verification[0]!.result.parentExit !== 0 ||
        countRuns(readEventsSafe(context.eventLog), "worker", context.added[0]!.id) !== 1 ||
        countRuns(readEventsSafe(context.eventLog), "reviewer", context.added[0]!.id) !== 1) fail("benign-success-observation-invalid")
  }
  const forged = await assertForgedEvidenceRefused(context.runtime, records)
  const status = git(context.repo, "status", "--porcelain")
  if (status !== "M qualification.txt" || readFileSync(join(context.repo, "qualification.txt"), "utf8") !== "PASS\n") {
    fail("accepted-result-not-merged-cleanly")
  }
  return { queue: statusSummary(run, ledger), authenticatedReceiptCount: proofs.length,
    authenticatedReceipts: proofs, verifierExitCodes: verification.map(item => item.result.parentExit), forgedEvidence: forged,
    git: { worktreeIsolatedAndMerged: true, finalQualificationFile: "PASS", expectedMainWorktreeStatus: status } }
}

async function runSupervisor(args: Args): Promise<number> {
  const receiptPath = canonicalNewFile(args.receipt)
  const scratch = realpathSync(mkdirTemp())
  const stateHome = join(scratch, "state")
  const repo = join(scratch, "repo")
  const eventLog = join(scratch, "host-events.jsonl")
  const scenario = args.scenario
  const sessionID = `ses_linux_verifier_e2_${randomUUID().replaceAll("-", "")}`
  const writerMarker = `otter-queue-e2-${randomUUID().replaceAll("-", "")}`
  const report: Report = {
    schema: "otter.linux-verifier.queue-e2.v1",
    startedAt: nowISO(),
    scenario,
    scope: "real queue, real Git worktree/baseline, real fixed Linux verifier and authenticated native receipts; worker/reviewer are synthetic and no model ran",
    qualification: "incomplete",
    artifacts: { receipt: receiptPath, scratch },
  }
  let preserve = args.keepSuccessArtifacts || scenario === "crash-ambiguous"
  try {
    mkdirSync(stateHome, { mode: 0o700 })
    writeFileSync(eventLog, "", { flag: "wx", mode: 0o600 })
    initializeRepository(repo, scenario, writerMarker)
    process.env.OTTER_STATE_HOME = stateHome
    const runtime = makeRuntime({ repo, stateHome, eventLog, scenario })
    const queue = createQueue(runtime)
    const added = queue.add(sessionID, taskInputs(scenario))
    const context = { scenario, scratch, repo, stateHome, eventLog, sessionID, added, runtime }
    let observation: Report
    if (scenario === "cancel") observation = await runCancellation(context)
    else if (scenario === "crash-checkpoint") observation = await runCrashCheckpoint(context)
    else if (scenario === "crash-ambiguous") observation = await runCrashAmbiguous(context)
    else observation = await runNormal(context)
    report.observation = observation
    report.qualification = "pass"
  } catch (error) {
    report.qualification = "failed"
    report.failure = { code: error instanceof QualificationFailure ? error.code : `unexpected-${error instanceof Error ? error.name : "error"}` }
    preserve = true
  } finally {
    report.finishedAt = nowISO()
    if (!preserve) {
      try { rmSync(scratch, { recursive: true, force: false }) }
      catch {
        report.qualification = "failed"
        report.failure = { code: "owned-fixture-cleanup-failed" }
        preserve = true
      }
    }
    if (preserve) report.artifacts = { receipt: receiptPath, scratch, gitRoot: repo, stateHome, eventLog,
      ledger: ledgerPath(repo, sessionID), stateRoot: stateRoot(repo) }
    else report.artifacts = { receipt: receiptPath, scratchPreserved: false }
    try { writeNewJson(receiptPath, report) }
    catch {
      process.stderr.write("otter-linux-verifier-queue: could-not-write-receipt\n")
      return 1
    }
  }
  process.stdout.write(`${JSON.stringify({ qualification: report.qualification, receipt: receiptPath })}\n`)
  return report.qualification === "pass" ? 0 : 1
}

function mkdirTemp(): string {
  const path = join(tmpdir(), `otter-linux-verifier-queue-${randomUUID()}`)
  mkdirSync(path, { mode: 0o700 })
  return path
}

async function runInternal(args: Args): Promise<number> {
  if (!args.internal) fail("internal-coordinator-arguments-missing")
  const internal = args.internal
  const scenario = internal.scenario
  if (!(SCENARIOS as readonly string[]).includes(scenario)) fail("internal-scenario-invalid")
  const scratch = resolve(internal.scratch)
  const scratchInfo = lstatSync(scratch)
  if (!scratchInfo.isDirectory() || scratchInfo.isSymbolicLink() || (scratchInfo.mode & 0o777) !== 0o700 ||
      resolve(internal.repo) !== join(scratch, "repo") || resolve(internal.stateHome) !== join(scratch, "state") ||
      resolve(internal.eventLog) !== join(scratch, "host-events.jsonl") || process.cwd() !== resolve(internal.repo)) {
    fail("coordinator-fixture-path-invalid")
  }
  const repoInfo = lstatSync(internal.repo)
  const stateInfo = lstatSync(internal.stateHome)
  const resultRelative = relative(scratch, resolve(internal.resultPath))
  const eventInfo = lstatSync(internal.eventLog)
  if (!repoInfo.isDirectory() || repoInfo.isSymbolicLink() || !stateInfo.isDirectory() || stateInfo.isSymbolicLink() ||
      (stateInfo.mode & 0o777) !== 0o700 || !resultRelative || resultRelative === ".." ||
      resultRelative.startsWith(`..${sep}`) || isAbsolute(resultRelative) ||
      existsSync(resolve(internal.resultPath)) ||
      !/^ses_linux_verifier_e2_[0-9a-f]{32}$/.test(internal.sessionID) || internal.taskIDs.length === 0 ||
      !eventInfo.isFile() || eventInfo.isSymbolicLink() || eventInfo.nlink !== 1 ||
      (internal.pauseTaskID !== undefined && (scenario !== "crash-checkpoint" || internal.phase !== "initial" ||
        internal.pauseTaskID !== internal.taskIDs[1]))) fail("coordinator-fixture-arguments-invalid")
  const taskIDs = readLedger(internal.repo, internal.sessionID).tasks.map(task => task.id)
  if (taskIDs.join("\n") !== internal.taskIDs.join("\n")) fail("coordinator-task-list-mismatch")
  const runtime = makeRuntime({ repo: internal.repo, stateHome: internal.stateHome, eventLog: internal.eventLog,
    scenario, pauseTaskID: internal.pauseTaskID })
  const queue = createQueue(runtime)
  const run = await queue.run(internal.sessionID, internal.phase === "resume" ? { resumed: true } : undefined)
  queueResultFile(internal.resultPath, run, internal.repo, internal.sessionID, runtime)
  return 0
}

async function main(): Promise<void> {
  let args: Args
  try { args = parseArgs(process.argv.slice(2)) }
  catch (error) {
    process.stderr.write(`otter-linux-verifier-queue: ${error instanceof QualificationFailure ? error.code : "usage-error"}\n`)
    process.exitCode = 2
    return
  }
  if (args.internal) {
    try { process.exitCode = await runInternal(args) }
    catch { process.exitCode = 1 }
    return
  }
  try { process.exitCode = await runSupervisor(args) }
  catch (error) {
    process.stderr.write(`otter-linux-verifier-queue: ${error instanceof QualificationFailure ? error.code : "qualification-failed"}\n`)
    process.exitCode = 1
  }
}

if (import.meta.main) void main()
