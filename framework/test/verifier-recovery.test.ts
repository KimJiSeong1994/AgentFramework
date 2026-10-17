import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { expect, test } from "bun:test"
import { DEFAULT_CONFIG, type OtterConfig } from "../src/config.ts"
import { createExecutionRunStore, settled } from "../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { createQueue } from "../src/orchestration/queue.ts"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"
import { worktreeRoot } from "../src/orchestration/worktree.ts"
import { ledgerPath } from "../src/state/ledger.ts"
import { executionRunDirectory, stateRoot } from "../src/state/store.ts"
import { GIT_TEST_ENV, tempGitWorktree } from "./guards-helpers.ts"

const SESSION = `ses_verifier_recovery_${randomUUID()}`
const VERIFY_COMMAND = "sh verify_crash_recovery.sh"
const HELPER_LIFETIME_MS = 18_000
const WRITER_LIFETIME_MS = 15_000

type FixtureProcess = {
  verifierPid: number
  verifierParentPid: number
  detachedPid: number
  token: string
}

type LoggedRequest = { role: string; cwd: string; taskID: string }

function runtimeFor(worktree: string, requestLogPath: string, instance: string): ExecutionRuntime {
  const config: OtterConfig = {
    ...DEFAULT_CONFIG,
    delegate: {
      ...DEFAULT_CONFIG.delegate,
      worktree: true,
      review: true,
      max_attempts: 1,
      queue_ttl_ms: 30_000,
      verify_timeout_ms: 12_000,
    },
  }
  let childSequence = 0
  let runtime!: ExecutionRuntime
  runtime = {
    instance,
    directory: worktree,
    worktree,
    stateRoot: stateRoot(worktree),
    config,
    log: () => {},
    runs: createExecutionRunStore(worktree),
    verificationProfile: "legacy-unowned",
    verifier: createLegacyVerifierExecutor(),
    policy: createExecutionPolicy(config, { directory: worktree, worktree }),
    host: {
      identity: { engine: "verifier-crash-fixture", profile: "code" },
      async preflight() { return { compatible: true, controls: {}, problems: [] } },
      async reconcile() {
        return { outcome: "unknown", quiescent: false, evidence: "fixture host has no prior-session authority" }
      },
      async prepare(request: ExecutionRequest) {
        appendFileSync(requestLogPath, JSON.stringify({ role: request.role, cwd: request.cwd, taskID: request.taskID }) + "\n")
        const reference = { executionID: request.executionID, vendorSessionID: `${instance}-child-${++childSequence}` }
        runtime.policy.bindSession(reference.vendorSessionID, request.handlers, request.policy)
        return {
          reference,
          async run() {
            if (request.role === "worker") {
              writeFileSync(join(request.cwd, "README.md"), "UNMERGED_WORKER_EDIT\n")
              return { status: "completed" as const, text: "Files changed: README.md\nOpen issues: none" }
            }
            return { status: "completed" as const, text: request.role === "reviewer" ? "ACCEPT" : "fixture complete" }
          },
          async requestCancel() { return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
          async reconcile() { return { outcome: "terminal" as const, quiescent: true, evidence: "fixture host call returned" } },
        }
      },
    },
  }
  return runtime
}

function coordinatorScript(imports: Record<string, string>, values: { worktree: string; requestLogPath: string; instance: string; sessionID: string }): string {
  const config = JSON.stringify(imports.config)
  const runState = JSON.stringify(imports.runState)
  const policy = JSON.stringify(imports.policy)
  const verifier = JSON.stringify(imports.verifier)
  const queue = JSON.stringify(imports.queue)
  const state = JSON.stringify(imports.state)
  return `import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG } from ${config}
import { createExecutionRunStore } from ${runState}
import { createExecutionPolicy } from ${policy}
import { createLegacyVerifierExecutor } from ${verifier}
import { createQueue } from ${queue}
import { stateRoot } from ${state}

const worktree = ${JSON.stringify(values.worktree)}
const requestLogPath = ${JSON.stringify(values.requestLogPath)}
const instance = ${JSON.stringify(values.instance)}
const sessionID = ${JSON.stringify(values.sessionID)}
const config = { ...DEFAULT_CONFIG, delegate: { ...DEFAULT_CONFIG.delegate, worktree: true, review: true, max_attempts: 1, queue_ttl_ms: 30000, verify_timeout_ms: 12000 } }
let childSequence = 0
let runtime
runtime = {
  instance, directory: worktree, worktree, stateRoot: stateRoot(worktree), config, log() {},
  runs: createExecutionRunStore(worktree), verificationProfile: "legacy-unowned", verifier: createLegacyVerifierExecutor(),
  policy: createExecutionPolicy(config, { directory: worktree, worktree }),
  host: {
    identity: { engine: "verifier-crash-fixture", profile: "code" },
    async preflight() { return { compatible: true, controls: {}, problems: [] } },
    async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "fixture host has no prior-session authority" } },
    async prepare(request) {
      appendFileSync(requestLogPath, JSON.stringify({ role: request.role, cwd: request.cwd, taskID: request.taskID }) + "\\n")
      const reference = { executionID: request.executionID, vendorSessionID: instance + "-child-" + (++childSequence) }
      runtime.policy.bindSession(reference.vendorSessionID, request.handlers, request.policy)
      return {
        reference,
        async run() {
          if (request.role === "worker") {
            writeFileSync(join(request.cwd, "README.md"), "UNMERGED_WORKER_EDIT\\n")
            return { status: "completed", text: "Files changed: README.md\\nOpen issues: none" }
          }
          return { status: "completed", text: request.role === "reviewer" ? "ACCEPT" : "fixture complete" }
        },
        async requestCancel() { return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
        async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "fixture host call returned" } },
      }
    },
  },
}
void createQueue(runtime).run(sessionID).then(
  result => writeFileSync(${JSON.stringify(join(values.requestLogPath, "..", "coordinator-result.json"))}, JSON.stringify(result)),
  error => writeFileSync(${JSON.stringify(join(values.requestLogPath, "..", "coordinator-error.json"))}, String(error)),
)
`
}

function verifierHelperSource(): string {
  return `import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const [home] = process.argv.slice(2)
if (!home) process.exit(70)
const token = randomUUID()
const readyPath = join(home, "writer-ready-" + token + ".json")
const markerPath = join(home, "writer-marker-" + token + ".json")
const helperDeadline = Date.now() + ${HELPER_LIFETIME_MS}
const forcedExit = setTimeout(() => process.exit(0), ${HELPER_LIFETIME_MS})
process.on("SIGTERM", () => { clearTimeout(forcedExit); process.exit(0) })
const child = spawn(process.execPath, [join(home, "detached-writer.mjs"), home, token], {
  detached: true,
  stdio: "ignore",
  env: { ...process.env },
})
if (!child.pid) throw new Error("detached writer did not receive a PID")
child.unref()
writeFileSync(join(home, "owned-" + token + ".json"), JSON.stringify({
  verifierPid: process.pid, verifierParentPid: process.ppid, detachedPid: child.pid, token,
}))
while (!existsSync(readyPath)) {
  if (Date.now() > helperDeadline) throw new Error("detached writer readiness timed out")
  await delay(10)
}
const ready = JSON.parse(readFileSync(readyPath, "utf8"))
if (ready.pid !== child.pid || ready.token !== token) throw new Error("detached writer handshake did not match its spawned process")
writeFileSync(join(home, "handshake-" + token + ".json"), JSON.stringify({
  verifierPid: process.pid, detachedPid: child.pid, token,
}))
while (!existsSync(join(home, "release-helper-" + token))) await delay(10)
clearTimeout(forcedExit)
process.exit(0)
`
}

function detachedWriterSource(): string {
  return `import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [home, token] = process.argv.slice(2)
if (!home || !token) process.exit(70)
const readyPath = join(home, "writer-ready-" + token + ".json")
const markerPath = join(home, "writer-marker-" + token + ".json")
const forcedExit = setTimeout(() => process.exit(72), ${WRITER_LIFETIME_MS})
process.on("SIGTERM", () => { clearTimeout(forcedExit); process.exit(0) })
const poll = setInterval(() => {
  if (!existsSync(join(home, "release-writer-" + token))) return
  writeFileSync(markerPath, JSON.stringify({ pid: process.pid, token, released: true }))
  clearTimeout(forcedExit)
  clearInterval(poll)
  process.exit(0)
}, 10)
writeFileSync(readyPath, JSON.stringify({ pid: process.pid, token }))
await new Promise(() => {})
`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function readRequests(path: string): LoggedRequest[] {
  if (!existsSync(path)) return []
  const contents = readFileSync(path, "utf8").trim()
  return contents ? contents.split("\n").map((line) => JSON.parse(line) as LoggedRequest) : []
}

function ownedProcesses(home: string): FixtureProcess[] {
  return readdirSync(home).filter((name) => /^owned-[a-f0-9-]+\.json$/.test(name)).map((name) => {
    const value = JSON.parse(readFileSync(join(home, name), "utf8")) as FixtureProcess
    if (![value.verifierPid, value.verifierParentPid, value.detachedPid].every((pid) => Number.isSafeInteger(pid) && pid > 0) ||
      !/^[a-f0-9-]{36}$/.test(value.token)) throw new Error(`invalid owned fixture process record: ${name}`)
    return value
  })
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  try {
    await waitUntil(() => !pidAlive(pid), timeoutMs, `fixture process ${pid} to exit`)
    return true
  } catch { return false }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), timeoutMs)
      }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

test("legacy verifier coordinator crash preserves started ownership while a detached fixture child remains independent", async () => {
  const fixture = tempGitWorktree({ "README.md": "ORIGINAL_BASELINE\n" })
  const worktree = realpathSync(fixture.worktree)
  const runStatePath = join(executionRunDirectory(worktree), "state.json")
  const home = join(fixture.stateHome, `verifier-recovery-${randomUUID()}`)
  const requestLogPath = join(home, "host-requests.jsonl")
  const verifierHelperPath = join(home, "verifier-helper.mjs")
  const coordinatorPath = join(home, "coordinator.mjs")
  mkdirSync(home, { recursive: true })
  let coordinator: ReturnType<typeof Bun.spawn> | undefined
  let resumedQueue: ReturnType<typeof createQueue> | undefined
  let coordinatorExited = false
  let preserveFixture = false
  const preservationReasons: string[] = []
  let capturedRunState: { path: string; bytes: Buffer; claim: { ownerSession: string; instance: string; pid: number; generation: number } | undefined } | undefined
  let capturedLedger: { path: string; bytes: Buffer } | undefined
  let capturedBaseline: { path: string; bytes: Buffer } | undefined
  let capturedPrivateBaseline: { path: string; bytes: Buffer } | undefined
  const coordinatorInstance = `crashed-coordinator-${randomUUID()}`

  try {
    writeFileSync(join(home, "verifier-helper.mjs"), verifierHelperSource())
    writeFileSync(join(home, "detached-writer.mjs"), detachedWriterSource())
    writeFileSync(join(worktree, "verify_crash_recovery.sh"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(verifierHelperPath)} ${shellQuote(home)}\n`)
    execFileSync("git", ["add", "verify_crash_recovery.sh"], { cwd: worktree, env: GIT_TEST_ENV, stdio: "pipe" })
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "trusted verifier recovery fixture"], {
      cwd: worktree, env: GIT_TEST_ENV, stdio: "pipe",
    })

    const baselinePath = join(worktree, "README.md")
    const baselineBytes = readFileSync(baselinePath)
    capturedBaseline = { path: baselinePath, bytes: baselineBytes }
    expect(baselineBytes).toEqual(execFileSync("git", ["show", "HEAD:README.md"], { cwd: worktree, env: GIT_TEST_ENV }))
    const imports = {
      config: new URL("../src/config.ts", import.meta.url).href,
      runState: new URL("../src/hosts/run-state.ts", import.meta.url).href,
      policy: new URL("../src/hosts/tool-policy.ts", import.meta.url).href,
      verifier: new URL("../src/orchestration/legacy-verifier.ts", import.meta.url).href,
      queue: new URL("../src/orchestration/queue.ts", import.meta.url).href,
      state: new URL("../src/state/store.ts", import.meta.url).href,
    }
    writeFileSync(coordinatorPath, coordinatorScript(imports, {
      worktree,
      requestLogPath,
      instance: coordinatorInstance,
      sessionID: SESSION,
    }))

    const seedQueue = createQueue(runtimeFor(worktree, requestLogPath, `seed-${randomUUID()}`))
    seedQueue.add(SESSION, [{ title: "hold the unmerged worker change behind a verifier", verify: VERIFY_COMMAND }])
    const coordinatorRunState = createExecutionRunStore(worktree)
    const ledgerFile = ledgerPath(worktree, SESSION)

    coordinator = Bun.spawn([process.execPath, coordinatorPath], {
      cwd: worktree,
      env: { ...process.env },
      stdout: "ignore",
      stderr: "ignore",
    })
    const coordinatorPid = coordinator.pid
    await waitUntil(() => readdirSync(home).some((name) => /^handshake-[a-f0-9-]+\.json$/.test(name)), 7_000, "detached verifier handshake")
    const handshakeFiles = readdirSync(home).filter((name) => /^handshake-[a-f0-9-]+\.json$/.test(name))
    expect(handshakeFiles).toHaveLength(1)
    const owned = ownedProcesses(home)
    expect(owned).toHaveLength(1)
    const processFixture = owned[0]!
    expect(JSON.parse(readFileSync(join(home, handshakeFiles[0]!), "utf8"))).toMatchObject({
      verifierPid: processFixture.verifierPid,
      detachedPid: processFixture.detachedPid,
      token: processFixture.token,
    })
    expect(processFixture.verifierPid).not.toBe(coordinatorPid)
    expect(processFixture.detachedPid).not.toBe(coordinatorPid)

    const requestsAtCrash = readRequests(requestLogPath)
    expect(requestsAtCrash.map((request) => request.role)).toEqual(["worker"])
    expect(requestsAtCrash[0]?.cwd).not.toBe(worktree)
    const isolatedTaskWorktree = requestsAtCrash[0]!.cwd
    const isolatedWorkerBytesAtCrash = readFileSync(join(isolatedTaskWorktree, "README.md"))
    const privateBaselinePath = join(worktreeRoot(worktree), ".recovery", SESSION, requestsAtCrash[0]!.taskID, "baseline", "baseline.json")
    const privateBaselineAtCrash = readFileSync(privateBaselinePath)
    capturedPrivateBaseline = { path: privateBaselinePath, bytes: privateBaselineAtCrash }
    expect(isolatedWorkerBytesAtCrash.toString()).toBe("UNMERGED_WORKER_EDIT\n")
    expect(readFileSync(join(worktree, "README.md"))).toEqual(baselineBytes)

    coordinator.kill("SIGKILL")
    const coordinatorExitCode = await bounded(coordinator.exited, 4_000, "SIGKILLed coordinator exit")
    coordinatorExited = true
    expect(coordinatorExitCode).not.toBe(0)
    expect(pidAlive(coordinatorPid)).toBe(false)
    expect(pidAlive(processFixture.detachedPid)).toBe(true)
    expect(existsSync(join(home, `writer-marker-${processFixture.token}.json`))).toBe(false)

    const startedBeforeResume = coordinatorRunState.status().executions.find((record) => record.kind === "verifier")
    expect(startedBeforeResume).toBeDefined()
    expect(startedBeforeResume!.verifierDispatch).toBe("started")
    expect(startedBeforeResume!.terminal).toBeUndefined()
    expect(startedBeforeResume!.reconciliation).toBeUndefined()
    expect(settled(startedBeforeResume!)).toBe(false)
    expect(startedBeforeResume!.boundaryRef).toMatchObject({ kind: "verifier", profile: "legacy-unowned" })
    const claimAtCrash = coordinatorRunState.status().claim
    expect(claimAtCrash).toMatchObject({ ownerSession: SESSION, instance: coordinatorInstance, pid: coordinatorPid })
    const runStateBytesAtCrash = readFileSync(runStatePath)
    capturedRunState = { path: runStatePath, bytes: runStateBytesAtCrash, claim: claimAtCrash }

    const ledgerBytesAtCrash = readFileSync(ledgerFile)
    capturedLedger = { path: ledgerFile, bytes: ledgerBytesAtCrash }
    const requestBytesAtCrash = readFileSync(requestLogPath)
    resumedQueue = createQueue(runtimeFor(worktree, requestLogPath, `resumer-${randomUUID()}`))
    const resumed = await bounded(resumedQueue.run(SESSION, { resumed: true }), 5_000, "fail-closed queue recovery")
    expect(resumed).toMatchObject({ aborted: true, done: 0, failed: 0, cancelled: 0 })

    const startedAfterResume = createExecutionRunStore(worktree).status().executions.find((record) => record.kind === "verifier")
    expect(startedAfterResume).toBeDefined()
    expect(startedAfterResume!.verifierDispatch).toBe("started")
    expect(startedAfterResume!.terminal).toBeUndefined()
    expect(settled(startedAfterResume!)).toBe(false)
    expect(startedAfterResume).toEqual(startedBeforeResume)
    expect(createExecutionRunStore(worktree).status().claim).toEqual(claimAtCrash)
    expect(readFileSync(runStatePath)).toEqual(runStateBytesAtCrash)
    expect(readFileSync(ledgerFile)).toEqual(ledgerBytesAtCrash)
    expect(readFileSync(privateBaselinePath)).toEqual(privateBaselineAtCrash)
    expect(readFileSync(requestLogPath)).toEqual(requestBytesAtCrash)
    expect(readRequests(requestLogPath).map((request) => request.role)).toEqual(["worker"])
    expect(readFileSync(join(isolatedTaskWorktree, "README.md"))).toEqual(isolatedWorkerBytesAtCrash)
    expect(readFileSync(join(worktree, "README.md"))).toEqual(baselineBytes)
    expect(readFileSync(join(worktree, "README.md"))).toEqual(execFileSync("git", ["show", "HEAD:README.md"], { cwd: worktree, env: GIT_TEST_ENV }))

    writeFileSync(join(home, `release-writer-${processFixture.token}`), "")
    await waitUntil(() => existsSync(join(home, `writer-marker-${processFixture.token}.json`)), 3_000, "detached writer marker after coordinator death")
    expect(JSON.parse(readFileSync(join(home, `writer-marker-${processFixture.token}.json`), "utf8"))).toEqual({
      pid: processFixture.detachedPid, token: processFixture.token, released: true,
    })
    const startedAfterChildRelease = createExecutionRunStore(worktree).status().executions.find((record) => record.kind === "verifier")
    expect(startedAfterChildRelease?.verifierDispatch).toBe("started")
    expect(startedAfterChildRelease?.terminal).toBeUndefined()
    expect(startedAfterChildRelease).toEqual(startedBeforeResume)
    expect(createExecutionRunStore(worktree).status().claim).toEqual(claimAtCrash)
    expect(readFileSync(runStatePath)).toEqual(runStateBytesAtCrash)
    expect(settled(startedAfterChildRelease!)).toBe(false)
    expect(readFileSync(ledgerFile)).toEqual(ledgerBytesAtCrash)
    expect(readFileSync(privateBaselinePath)).toEqual(privateBaselineAtCrash)
    expect(readFileSync(join(worktree, "README.md"))).toEqual(baselineBytes)

    console.info("verifier recovery regression observed", JSON.stringify({
      coordinatorPid,
      coordinatorExitCode,
      verifierDispatch: startedAfterResume!.verifierDispatch,
      recoveryAborted: resumed.aborted,
      postCrashHostRoles: readRequests(requestLogPath).slice(requestsAtCrash.length).map((request) => request.role),
      runStateUnchanged: true,
      ownershipRetained: true,
      ledgerUnchanged: true,
      originalBaselineUnchanged: true,
      privateBaselineUnchanged: true,
      detachedChildMarkerAfterCrash: true,
      descendantTerminationClaimed: false,
    }))
  } finally {
    if (coordinator && !coordinatorExited) {
      try { coordinator.kill("SIGKILL") } catch {}
      try {
        await bounded(coordinator.exited, 4_000, "fixture coordinator cleanup")
        coordinatorExited = true
      } catch { preserveFixture = true; preservationReasons.push("coordinator exit was not observed") }
    }

    if (resumedQueue) {
      try { await bounded(resumedQueue.abort(SESSION, "verifier recovery fixture teardown"), 4_000, "resumer queue teardown") }
      catch { preserveFixture = true; preservationReasons.push("resumer teardown did not settle") }
    }

    let owned: FixtureProcess[] = []
    try { owned = ownedProcesses(home) } catch { preserveFixture = true; preservationReasons.push("owned fixture records could not be inspected") }
    for (const processFixture of owned) {
      writeFileSync(join(home, `release-writer-${processFixture.token}`), "")
      writeFileSync(join(home, `release-helper-${processFixture.token}`), "")
    }
    for (const processFixture of owned) {
      const excluded = new Set([process.pid, coordinator?.pid ?? -1])
      for (const pid of [processFixture.verifierPid, processFixture.verifierParentPid, processFixture.detachedPid]) {
        // Never signal a persisted PID: it may have been reused. Release only our token-bound fixtures.
        if (pid > 1 && !excluded.has(pid) && !(await waitForPidExit(pid, 2_000))) {
          preserveFixture = true
          preservationReasons.push(`token-bound fixture pid ${pid} did not exit after release`)
        }
      }
    }

    try {
      const status = createExecutionRunStore(worktree).status()
      if (status.claim) {
        preserveFixture = true
        preservationReasons.push(`run-store claim remains for ${status.claim.ownerSession}/${status.claim.instance} (pid ${status.claim.pid})`)
      }
      const unsettled = status.executions.filter((record) => !settled(record))
      if (unsettled.length > 0) {
        preserveFixture = true
        preservationReasons.push(`${unsettled.length} unsettled run-store execution(s) remain`)
      }
    } catch {
      preserveFixture = true
      preservationReasons.push("run-store authority could not be inspected")
    }
    if (preserveFixture) {
      fixture.executionAuthority.release({ preserve: true })
      fixture.releaseEnvironment()
      console.error(`verifier recovery fixture retained because cleanup admission was blocked (${preservationReasons.join("; ") || "fixture process state was unresolved"}); durable authority does not establish that a writer is still alive; home: ${home}; stateHome: ${fixture.stateHome}; worktree: ${fixture.worktree}; run state: ${runStatePath}; execution authority: ${fixture.executionAuthority.keyDirectory}`)
    } else fixture.cleanup()
  }
  {
    expect(preserveFixture).toBe(true)
    expect(capturedRunState).toBeDefined()
    expect(createExecutionRunStore(worktree).status().claim).toEqual(capturedRunState!.claim)
    expect(readFileSync(capturedRunState!.path).equals(capturedRunState!.bytes)).toBe(true)
    expect(capturedLedger).toBeDefined()
    expect(readFileSync(capturedLedger!.path).equals(capturedLedger!.bytes)).toBe(true)
    expect(capturedBaseline).toBeDefined()
    expect(readFileSync(capturedBaseline!.path).equals(capturedBaseline!.bytes)).toBe(true)
    expect(capturedPrivateBaseline).toBeDefined()
    expect(readFileSync(capturedPrivateBaseline!.path).equals(capturedPrivateBaseline!.bytes)).toBe(true)
  }
}, 30_000)
