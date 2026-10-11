import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { checkManifest } from "../../scripts/lca-soak-manifest.ts"
import {
  FAMILY_TABLE,
  acquireLock,
  appendEvent,
  classify,
  createSupervisorBinding,
  expectedSnapshotPath,
  initializeManifest,
  materializeArgv,
  releaseLock,
  remoteReceiptArgv,
  supervisorBindingSha256,
  validateFixtureManifest,
  validateGrammar,
  validateSshTarget,
  verifyTail,
} from "../../scripts/lca-soak-supervisor.ts"
import type { Family } from "../../scripts/lca-soak-supervisor.ts"

const familyNames = Object.keys(FAMILY_TABLE) as Family[]

function fixtureInput(): Record<string, unknown> {
  const lineages = familyNames.flatMap(family => [1, 2, 3].map(repetition => {
    const lineage = `${family}-r${repetition}`
    const policy = FAMILY_TABLE[family]
    const receiptPath = `/tmp/lca-soak/${lineage}.receipt.json`
    const invocations = Array.from({ length: policy.invocationCount }, (_, offset) => {
      const index = offset + 1
      const scenario = index === 1 ? policy.scenario : "resume"
      const argv = [
        "python3", "scripts/lca-soak-pty-ssh.py", "--scenario", scenario,
        "--receipt", receiptPath, "--verifier", "linux-production",
        ...(index > 1 ? ["--session", "@lca-soak-parent-session"] : []),
      ]
      return {
        scenario,
        cwd: "/tmp",
        argv,
        receiptPath,
        expectedInjection: index === 1 ? policy.expectedInjection : null,
        ...(index > 1 ? { resumeSession: { fromInvocationIndex: 1 } } : {}),
      }
    })
    return {
      lineage,
      family,
      repetition,
      fixtureID: `fixture-${lineage}`,
      fixtureTree: "a".repeat(40),
      invocations,
    }
  }))
  return {
    schema: "lca.soak-fixtures.v1",
    version: 1,
    provisioning: [{ vm: "vm-c", cwd: "/tmp", argv: ["provision", "--vm", "vm-c"] }, { vm: "vm-r", cwd: "/tmp", argv: ["provision", "--vm", "vm-r"] }],
    lineages,
  }
}

const TEST_BINDING = createSupervisorBinding("stub-host", validateFixtureManifest(fixtureInput()))
const TEST_BINDING_SHA256 = supervisorBindingSha256(TEST_BINDING)

function evidenceFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lca-soak-supervisor-")))
  const evidenceDir = join(root, "linux-eligibility-test")
  mkdirSync(evidenceDir, { mode: 0o700 })
  initializeManifest(evidenceDir, TEST_BINDING)
  return { root, evidenceDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function integrationFixture(options: {
  provisionFails?: boolean
  provisionSpawnFails?: boolean
  killFirstSuccess?: boolean
  hangDriver?: boolean
  naturalDriverExitMs?: number
  sshMode?: "overflow" | "descendant-holds-pipe"
  descendantDelayMs?: number
  naturalSshExitMs?: number
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lca-soak-supervisor-cli-")))
  const binDir = join(root, "bin")
  const evidenceRoot = join(root, "host-evidence")
  const receiptsDir = join(root, "receipts")
  const driverPath = join(root, "fake-driver.mjs")
  const transportPath = join(root, "trusted-remote-transport.mjs")
  const killPreloadPath = join(root, "signal-error-preload.mjs")
  const provisionPath = join(root, "fake-provision.mjs")
  const sshPath = join(binDir, "ssh")
  const manifestPath = join(root, "fixtures.json")
  const driverLog = join(root, "driver.log")
  const sshLog = join(root, "ssh.log")
  const provisionLog = join(root, "provision.log")
  const descendantMarker = join(root, "descendant-expired.log")
  const sshExitedMarker = join(root, "ssh-child-exited.log")
  const killAttempts = join(root, "signal-attempts.log")
  mkdirSync(binDir, { mode: 0o700 })
  mkdirSync(evidenceRoot, { mode: 0o700 })
  mkdirSync(receiptsDir, { mode: 0o700 })
  const driverSource = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const value = flag => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
const scenario = value("--scenario");
const receiptPath = value("--receipt");
const verifier = value("--verifier");
const log = value("--test-log");
if (!scenario || !receiptPath || verifier !== "linux-production" || !log) process.exit(91);
if (process.env.LCA_TEST_DRIVER_MODE === "hang" && receiptPath.includes("success-r1")) {
  appendFileSync(log, "driver-started\\n");
  process.once("SIGTERM", () => { appendFileSync(log, "driver-terminated\\n"); process.exit(143); });
  if (Number(process.env.LCA_TEST_DRIVER_NATURAL_EXIT_MS) > 0) {
    setTimeout(() => { appendFileSync(log, "driver-natural-exit\\n"); process.exit(0); }, Number(process.env.LCA_TEST_DRIVER_NATURAL_EXIT_MS));
  }
  setInterval(() => {}, 1000);
}
let receipt;
if (scenario === "resume") {
  receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (value("--session") !== receipt.nativeSessionIDs.parentSessionID) process.exit(92);
  receipt.scenario = "resume";
} else {
  receipt = {
    schemaVersion: 2, scenario, receiptPath,
    baseIdentity: { verifier },
    nativeSessionIDs: { parentSessionID: "session_01", childSessionIDs: [] },
    modelAborts: [], failures: [], runs: [],
  };
}
const family = scenario === "resume" ? receipt.runs[0].scenario : scenario;
const invocationIndex = receipt.runs.length + 1;
const run = { scenario, parentSessionID: "session_01" };
if (invocationIndex === 1 && family === "success") run.nativeAcceptance = { done: 1, reviewerVerdict: "accept", verifierExitCodes: [0] };
if (invocationIndex === 1 && family === "retry") {
  run.driver_fault_injection = { applicationCount: 1, source: "driver_fault_injection" };
  run.nativeAcceptance = { done: 1, reviewerVerdict: "accept", verifierExitCodes: [4, 0] };
}
if (invocationIndex === 1 && family === "reject") {
  run.injection = { appliedAt: "2026-10-08T00:00:00.000Z" };
  run.observedReview = { verdict: "reject" };
}
if (invocationIndex === 1 && family === "cancel") {
  run.firstWorkerBusyObservation = { observed: "busy" };
  run.queueAbort = { invoked: true, reason: "user_stop" };
  run.queueResult = { aborted: true, done: 0, failed: 0 };
}
if (invocationIndex === 1 && family === "verifier-cancel") {
  run.nativeRetirement = { authenticated: true, result: { cancelled: true, domainState: "empty" } };
  run.queueResult = { aborted: true };
  run.explicitResumedQueueResult = { aborted: false, done: 0, failed: 0, taskIds: [] };
}
if (invocationIndex === 1 && family === "interrupt") {
  run.secondTaskWorkerBusyObservation = {
    vendorSessionID: "child_2", taskID: "t2", observed: "busy", polls: 1, statusErrors: 0,
    lastStatus: "busy", startedAt: 1, finishedAt: 2,
  };
  run.interruption = { parentSessionID: "session_01", vendorChildSessionID: "child_2", targetTaskID: "t2", runningTaskID: "t2", completedTaskIDs: ["t1"] };
}
if (invocationIndex === 1 && family === "checkpoint") {
  run.interruption = {
    parentSessionID: "session_01",
    boundary: "verified_task_checkpoint_before_next_execution_intent",
    completedTaskIDs: ["t1"],
  };
}
if (invocationIndex === 1 && family === "active-verifier") {
  run.interruption = {
    parentSessionID: "session_01", boundary: "active_native_verifier_before_t2_retirement",
    verifierDispatch: "started", cgroupPopulated: true, boundaryRef: { kind: "verifier", profile: "linux-single-use" },
  };
}
if (scenario === "resume" && family !== "active-verifier") {
  run.queueResult = { aborted: false, done: 2, failed: 0 };
  run.completedTaskIDsAfter = ["t1", "t2", "t3"];
}
if (scenario === "resume" && family === "active-verifier" && invocationIndex === 2) {
  run.activeVerifierStage = "retirement-recorded";
  run.nativeRetirement = { authenticated: true, result: { cancelled: false } };
  run.queueResult = { aborted: true, done: 0, failed: 0 };
}
if (scenario === "resume" && family === "active-verifier" && invocationIndex === 3) {
  run.activeVerifierStage = "remaining-tasks-completed";
  run.remainingTaskAcceptance = { done: 2 };
  run.queueResult = { aborted: false, done: 2, failed: 0 };
  run.completedTaskIDsAfter = ["t1", "t2", "t3"];
}
receipt.runs.push(run);
writeFileSync(receiptPath, JSON.stringify(receipt));
appendFileSync(log, family + " " + invocationIndex + "\\n");
if (invocationIndex === 1 && ["interrupt", "checkpoint", "active-verifier"].includes(family)) process.kill(process.pid, "SIGKILL");
`
  const transportSource = `import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const driver = args.shift();
if (!driver) process.exit(94);
if (args.includes("--test-local-kill")) process.kill(process.pid, "SIGKILL");
const child = spawn(process.execPath, [driver, ...args], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("error", () => process.exit(94));
child.once("close", (code, signal) => process.exit(signal === "SIGKILL" ? 137 : code ?? 94));
`
  const sshSource = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
appendFileSync(process.env.LCA_TEST_SSH_LOG, "ssh\\n");
const command = process.argv.at(-1);
const match = typeof command === "string" ? command.match(/^cat -- '([^']+)'$/) : null;
if (!match) process.exit(93);
if (match[1].includes("success-r1")) process.on("exit", () => appendFileSync(process.env.LCA_TEST_SSH_EXIT_MARKER, match[1] + "\\n"));
if (match[1].includes("success-r1") && process.env.LCA_TEST_SSH_MODE === "overflow") {
  process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 65));
  const naturalExitMs = Number(process.env.LCA_TEST_SSH_NATURAL_EXIT_MS);
  if (naturalExitMs > 0) setTimeout(() => process.exit(0), naturalExitMs);
  setInterval(() => {}, 1000);
} else {
  if (match[1].includes("success-r1") && process.env.LCA_TEST_SSH_MODE === "descendant-holds-pipe") {
    const source = 'import { appendFileSync } from "node:fs"; setTimeout(() => appendFileSync(process.env.LCA_TEST_DESCENDANT_MARKER, "expired\\\\n"), Number(process.env.LCA_TEST_DESCENDANT_DELAY_MS));';
    spawn(process.execPath, ["-e", source], { stdio: ["ignore", "inherit", "ignore"] }).unref();
  }
process.stdout.write(readFileSync(match[1]));
}
`
  const killPreloadSource = `import { appendFileSync } from "node:fs";
import { ChildProcess } from "node:child_process";
const originalKill = ChildProcess.prototype.kill;
ChildProcess.prototype.kill = function(signal = "SIGTERM") {
  const mode = process.env.LCA_TEST_KILL_ERROR_MODE;
  if (mode === "timeout" || mode === "stop" || mode === "overflow") {
    appendFileSync(process.env.LCA_TEST_KILL_ATTEMPTS, String(signal) + "\\n");
    const error = Object.assign(new Error("controlled signal delivery failure"), { code: "EPERM" });
    process.nextTick(() => this.emit("error", error));
    return false;
  }
  return originalKill.call(this, signal);
};
`
  writeFileSync(driverPath, driverSource)
  writeFileSync(transportPath, transportSource)
  writeFileSync(killPreloadPath, killPreloadSource)
  writeFileSync(sshPath, sshSource, { mode: 0o700 })
  chmodSync(sshPath, 0o700)
  const provisionSource = `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(args[0], "provisioned\\n");
if (args.includes("--fail")) process.exit(23);
`
  writeFileSync(provisionPath, provisionSource)
  const input = fixtureInput()
  input.provisioning = [{
    vm: "vm-c",
    cwd: root,
    argv: options.provisionSpawnFails
      ? [join(root, "missing-provision-command")]
      : [process.execPath, provisionPath, provisionLog, ...(options.provisionFails ? ["--fail"] : [])],
  }]
  input.lineages = (input.lineages as Array<Record<string, unknown>>).map(raw => {
    const lineage = String(raw.lineage)
    const family = raw.family as Family
    const receiptPath = join(receiptsDir, `${lineage}.json`)
    raw.invocations = (raw.invocations as Array<Record<string, unknown>>).map((source, offset) => {
      const scenario = String(source.scenario)
      const argv = [
        process.execPath, transportPath, driverPath, "--scenario", scenario, "--receipt", receiptPath,
        "--verifier", "linux-production", "--test-log", driverLog,
        ...(offset > 0 ? ["--session", "@lca-soak-parent-session"] : []),
        ...(options.killFirstSuccess && lineage === "success-r1" && offset === 0 ? ["--test-local-kill"] : []),
      ]
      return { ...source, cwd: root, argv, receiptPath }
    })
    return { ...raw, fixtureID: `fixture-${lineage}`, fixtureTree: "a".repeat(40), family }
  })
  const binding = createSupervisorBinding("stub-host", validateFixtureManifest(input))
  writeFileSync(manifestPath, JSON.stringify(input), { mode: 0o600 })
  const hostEvidence = join(root, "host-evidence")
  const supervisorPath = fileURLToPath(new URL("../../scripts/lca-soak-supervisor.ts", import.meta.url))
  const checkerPath = fileURLToPath(new URL("../../scripts/lca-soak-manifest.ts", import.meta.url))
  const env = {
    ...process.env,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    LCA_TEST_SSH_LOG: sshLog,
    LCA_TEST_DRIVER_MODE: options.hangDriver ? "hang" : "",
    LCA_TEST_DRIVER_NATURAL_EXIT_MS: String(options.naturalDriverExitMs ?? 0),
    LCA_TEST_SSH_MODE: options.sshMode ?? "",
    LCA_TEST_SSH_NATURAL_EXIT_MS: String(options.naturalSshExitMs ?? 0),
    LCA_TEST_DESCENDANT_MARKER: descendantMarker,
    LCA_TEST_SSH_EXIT_MARKER: sshExitedMarker,
    LCA_TEST_DESCENDANT_DELAY_MS: String(options.descendantDelayMs ?? 5_000),
    LCA_TEST_KILL_ATTEMPTS: killAttempts,
  }
  return {
    root,
    hostEvidence,
    manifestPath,
    binding,
    killPreloadPath,
    driverLog,
    sshLog,
    descendantMarker,
    sshExitedMarker,
    killAttempts,
    provisionLog,
    env,
    supervisorPath,
    checkerPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function startCli(argv: string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, ...argv], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill("SIGTERM"), 180_000)
  const result = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([code, stdout, stderr]) => {
    clearTimeout(timeout)
    return { code, stdout, stderr }
  }, error => {
    clearTimeout(timeout)
    throw error
  })
  return { child, result }
}

async function runCli(argv: string[], cwd: string, env: Record<string, string | undefined>) {
  return startCli(argv, cwd, env).result
}

async function waitForText(path: string, text: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (readFileSync(path, "utf8").includes(text)) return } catch { /* The child has not written its marker yet. */ }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${JSON.stringify(text)} in ${path}`)
}

async function waitForLineCount(path: string, line: string, count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const lines = readFileSync(path, "utf8").trimEnd().split("\n")
      if (lines.filter(candidate => candidate === line).length >= count) return
    } catch { /* The first controlled signal has not been attempted yet. */ }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${count} ${JSON.stringify(line)} entries in ${path}`)
}

function onlyEvidenceDirectory(hostEvidence: string): string {
  const entries = readdirSync(hostEvidence).filter(entry => entry.startsWith("linux-eligibility-"))
  if (entries.length !== 1) throw new Error(`expected one evidence directory, found ${entries.length}`)
  return join(hostEvidence, entries[0]!)
}

function seededRestartEvidence(fixture: ReturnType<typeof integrationFixture>, oneLineAhead = false): string {
  const evidenceDir = join(fixture.hostEvidence, "linux-eligibility-2026-10-08T000000.000Z")
  mkdirSync(evidenceDir, { mode: 0o700 })
  const bindingHash = initializeManifest(evidenceDir, fixture.binding)
  appendEvent(evidenceDir, "supervisor-start", { budget: { maxVMs: 2, headroomGiB: 20 }, bindingSha256: bindingHash })
  if (oneLineAhead) {
    appendEvent(evidenceDir, "provision-start", { vm: "vm-c" })
    appendEvent(evidenceDir, "provision-end", { vm: "vm-c", outcome: "ok", errorKind: null })
    const anchored = readFileSync(join(evidenceDir, "soak-manifest.anchor"))
    const first = fixture.binding.fixtures.lineages[0]!
    appendEvent(evidenceDir, "lineage-start", {
      lineage: first.lineage,
      family: first.family,
      repetition: first.repetition,
      fixtureID: first.fixtureID,
      fixtureTree: first.fixtureTree,
    })
    writeFileSync(join(evidenceDir, "soak-manifest.anchor"), anchored)
  }
  return evidenceDir
}

function seededKilledInvocationEvidence(fixture: ReturnType<typeof integrationFixture>, errorNames: string[]): string {
  const evidenceDir = seededRestartEvidence(fixture)
  appendEvent(evidenceDir, "provision-start", { vm: "vm-c" })
  appendEvent(evidenceDir, "provision-end", { vm: "vm-c", outcome: "ok", errorKind: null })
  const spec = fixture.binding.fixtures.lineages[0]!
  const invocation = spec.invocations[0]!
  appendEvent(evidenceDir, "lineage-start", {
    lineage: spec.lineage,
    family: spec.family,
    repetition: spec.repetition,
    fixtureID: spec.fixtureID,
    fixtureTree: spec.fixtureTree,
  })
  const argv = materializeArgv(invocation, null)
  appendEvent(evidenceDir, "invocation-start", {
    lineage: spec.lineage,
    invocationIndex: 1,
    scenario: invocation.scenario,
    parentSessionID: null,
    argvSha256: createHash("sha256").update(JSON.stringify(argv)).digest("hex"),
  })
  appendEvent(evidenceDir, "invocation-end", {
    lineage: spec.lineage,
    invocationIndex: 1,
    exit: { code: null, signal: "SIGKILL" },
    snapshotPath: expectedSnapshotPath(spec.lineage, 1),
    snapshotSha256: null,
    outcome: "killed",
    expectedInjection: invocation.expectedInjection,
    errorNames,
    orderedTermination: false,
  })
  return evidenceDir
}

function evidenceBytes(evidenceDir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  for (const entry of readdirSync(evidenceDir).sort()) {
    if (entry === "snapshots") {
      for (const lineage of readdirSync(join(evidenceDir, entry)).sort()) {
        for (const file of readdirSync(join(evidenceDir, entry, lineage)).sort()) {
          files.set(`${entry}/${lineage}/${file}`, readFileSync(join(evidenceDir, entry, lineage, file)))
        }
      }
    } else files.set(entry, readFileSync(join(evidenceDir, entry)))
  }
  return files
}

async function restartCli(fixture: ReturnType<typeof integrationFixture>, evidenceDir: string, target = "stub-host") {
  return runCli([
    fixture.supervisorPath,
    "--restart",
    "--evidence-root", evidenceDir,
    "--vm-c", target,
    "--fixtures-manifest", fixture.manifestPath,
  ], fixture.root, fixture.env)
}

function setFirstInvocationTimeout(fixture: ReturnType<typeof integrationFixture>, timeoutMs: number): void {
  const input = JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as Record<string, unknown>
  const firstLineage = (input.lineages as Array<Record<string, unknown>>)[0]!
  const firstInvocation = (firstLineage.invocations as Array<Record<string, unknown>>)[0]!
  firstInvocation.timeoutMs = timeoutMs
  writeFileSync(fixture.manifestPath, JSON.stringify(input), { mode: 0o600 })
}

function startFreshSupervisor(fixture: ReturnType<typeof integrationFixture>) {
  return startCli([
    fixture.supervisorPath,
    "--evidence-root", fixture.hostEvidence,
    "--vm-c", "stub-host",
    "--fixtures-manifest", fixture.manifestPath,
  ], fixture.root, fixture.env)
}

function startSupervisorWithSignalFailures(
  fixture: ReturnType<typeof integrationFixture>,
  mode: "timeout" | "stop" | "overflow",
) {
  const env = { ...fixture.env, LCA_TEST_KILL_ERROR_MODE: mode }
  return startCli([
    "--preload", fixture.killPreloadPath,
    fixture.supervisorPath,
    "--evidence-root", fixture.hostEvidence,
    "--vm-c", "stub-host",
    "--fixtures-manifest", fixture.manifestPath,
  ], fixture.root, env)
}

function manifestLines(fixture: ReturnType<typeof integrationFixture>): Array<Record<string, unknown>> {
  const evidenceDir = onlyEvidenceDirectory(fixture.hostEvidence)
  return readFileSync(join(evidenceDir, "soak-manifest.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
}

function receiptBase(run: Record<string, unknown>) {
  return {
    schemaVersion: 2,
    scenario: run.scenario,
    receiptPath: "/tmp/lca-soak/fake-receipt.json",
    baseIdentity: { verifier: "linux-production" },
    nativeSessionIDs: { parentSessionID: "session_01" },
    modelAborts: [],
    failures: [],
    runs: [{ scenario: run.scenario, parentSessionID: "session_01", ...run }],
  }
}

function interruptionReceipt(family: "interrupt" | "checkpoint" | "active-verifier") {
  const interruption: Record<string, unknown> = { parentSessionID: "session_01", completedTaskIDs: ["t1"] }
  const run: Record<string, unknown> = { scenario: family, interruption }
  if (family === "interrupt") {
    Object.assign(interruption, {
      vendorChildSessionID: "child_2",
      targetTaskID: "t2",
      runningTaskID: "t2",
    })
    run.secondTaskWorkerBusyObservation = {
      vendorSessionID: "child_2", taskID: "t2", observed: "busy", polls: 1, statusErrors: 0,
      lastStatus: "busy", startedAt: 1, finishedAt: 2,
    }
  }
  if (family === "checkpoint") Object.assign(interruption, {
    boundary: "verified_task_checkpoint_before_next_execution_intent",
  })
  if (family === "active-verifier") Object.assign(interruption, {
    boundary: "active_native_verifier_before_t2_retirement",
    verifierDispatch: "started",
    cgroupPopulated: true,
    boundaryRef: { kind: "verifier", profile: "linux-single-use" },
  })
  return receiptBase(run)
}

function appendProvisionedStart(evidenceDir: string) {
  appendEvent(evidenceDir, "supervisor-start", { budget: { maxVMs: 2, headroomGiB: 20 }, bindingSha256: TEST_BINDING_SHA256 })
  appendEvent(evidenceDir, "provision-start", { vm: "vm-c" })
  appendEvent(evidenceDir, "provision-end", { vm: "vm-c", outcome: "ok", errorKind: null })
}

function appendCompleteGrammar(evidenceDir: string) {
  appendProvisionedStart(evidenceDir)
  for (const family of familyNames) {
    for (const repetition of [1, 2, 3] as const) {
      const lineage = `${family}-r${repetition}`
      appendEvent(evidenceDir, "lineage-start", {
        lineage,
        family,
        repetition,
        fixtureID: `fixture-${lineage}`,
        fixtureTree: "b".repeat(40),
      })
      for (let invocationIndex = 1; invocationIndex <= FAMILY_TABLE[family].invocationCount; invocationIndex++) {
        const scenario = invocationIndex === 1 ? FAMILY_TABLE[family].scenario : "resume"
        appendEvent(evidenceDir, "invocation-start", {
          lineage,
          invocationIndex,
          scenario,
          parentSessionID: invocationIndex === 1 ? null : "session_01",
          argvSha256: "c".repeat(64),
        })
        appendEvent(evidenceDir, "invocation-end", {
          lineage,
          invocationIndex,
          exit: { code: invocationIndex === 1 ? FAMILY_TABLE[family].expectedExitCode : 0, signal: null },
          snapshotPath: `snapshots/${lineage}/${invocationIndex}.receipt.json`,
          snapshotSha256: null,
          outcome: invocationIndex === 1 && family !== "success" || family === "active-verifier" && invocationIndex === 2
            ? "expected-fail-closed"
            : "pass",
          expectedInjection: invocationIndex === 1 ? FAMILY_TABLE[family].expectedInjection : null,
          errorNames: [],
          orderedTermination: false,
        })
      }
      appendEvent(evidenceDir, "lineage-end", { lineage, outcome: "pass" })
    }
  }
  appendEvent(evidenceDir, "supervisor-end", { lineages: 24, unexpected: 0 })
}

test("the trusted fixture schema fixes all 24 unique fresh lineages and exact argv arrays", () => {
  const input = fixtureInput()
  const parsed = validateFixtureManifest(input)
  expect(parsed.lineages).toHaveLength(24)
  expect(new Set(parsed.lineages.map(lineage => lineage.fixtureID)).size).toBe(24)
  expect(parsed.lineages.find(lineage => lineage.family === "active-verifier")?.invocations).toHaveLength(3)
  expect(parsed.lineages[0]?.invocations[0]?.argv).toEqual((input.lineages as Array<{ invocations: Array<{ argv: string[] }> }>)[0]?.invocations[0]?.argv)

  const duplicate = structuredClone(input)
  const mutableLineages = duplicate.lineages as Array<Record<string, unknown>>
  mutableLineages[1]!.fixtureID = mutableLineages[0]!.fixtureID
  expect(() => validateFixtureManifest(duplicate)).toThrow(/fixtureID .* must be unique/)

  const wrongTree = structuredClone(input)
  ;(wrongTree.lineages as Array<Record<string, unknown>>)[0]!.fixtureTree = "f".repeat(39)
  expect(() => validateFixtureManifest(wrongTree)).toThrow(/fixture tree ID/)

  const sha256Tree = structuredClone(input)
  ;(sha256Tree.lineages as Array<Record<string, unknown>>)[0]!.fixtureTree = "f".repeat(64)
  expect(validateFixtureManifest(sha256Tree).lineages[0]?.fixtureTree).toBe("f".repeat(64))

  const sharedReceipt = structuredClone(input)
  const sharedLineages = sharedReceipt.lineages as Array<Record<string, unknown>>
  const sharedFirst = (sharedLineages[0]!.invocations as Array<Record<string, unknown>>)[0]!
  ;((sharedLineages[1]!.invocations as Array<Record<string, unknown>>)[0]!).receiptPath = sharedFirst.receiptPath
  expect(() => validateFixtureManifest(sharedReceipt)).toThrow(/receipt path unique to its fresh fixture/)

  const unqualified = structuredClone(input)
  const unqualifiedArgv = (((unqualified.lineages as Array<Record<string, unknown>>)[0]!.invocations as Array<Record<string, unknown>>)[0]!.argv as string[])
  unqualifiedArgv[unqualifiedArgv.indexOf("--verifier") + 1] = "linux-qualification"
  expect(() => validateFixtureManifest(unqualified)).toThrow(/must select linux-production explicitly/)
})

test("resume session IDs are explicit argv values and never shell-expanded", () => {
  const manifest = validateFixtureManifest(fixtureInput())
  const invocation = manifest.lineages.find(lineage => lineage.family === "active-verifier")!.invocations[1]!
  expect(invocation.resumeSession).toEqual({ fromInvocationIndex: 1 })
  const compiled = materializeArgv(invocation, "session_01")
  const marker = invocation.argv.indexOf("@lca-soak-parent-session")
  expect(compiled[marker]).toBe("session_01")
  expect(compiled.filter(arg => arg === "session_01")).toHaveLength(1)
  expect(compiled.filter(arg => arg.startsWith("@lca-soak"))).toHaveLength(0)
  expect(() => materializeArgv(invocation, "bad; $(id)")).toThrow(/validated parentSessionID/)
})

test("SSH receipt reads use safe quoting and explicitly disable agent forwarding", () => {
  expect(() => validateSshTarget("vm-c;touch /tmp/pwned")).toThrow(/SSH config alias/)
  expect(() => remoteReceiptArgv("-oProxyCommand=id", "/tmp/receipt.json")).toThrow(/SSH config alias/)
  const argv = remoteReceiptArgv("lca-vm-c", "/tmp/receipt'with-quote.json")
  expect(argv).toContain("-a")
  expect(argv).toContain("ForwardAgent=no")
  expect(argv).toContain("ClearAllForwardings=yes")
  expect(argv.at(-1)).toBe(`cat -- '/tmp/receipt'"'"'with-quote.json'`)
})

test("supervisor cleanup uses directly owned child handles and never creates or signals process groups", () => {
  const supervisorPath = fileURLToPath(new URL("../../scripts/lca-soak-supervisor.ts", import.meta.url))
  const source = readFileSync(supervisorPath, "utf8")
  expect(source).toContain("const activeOwnedChildren = new Map<ReturnType<typeof spawn>, (errorName: string) => void>()")
  expect(source).toContain("child.kill(signal)")
  expect(source).toContain('child.once("exit"')
  expect(source).toContain("ReceiptCaptureIncompleteError")
  expect(source).not.toContain("detached:")
  expect(source).not.toMatch(/process\.kill\s*\(\s*-/)
  expect(source).not.toContain("activeProcessGroups")
  expect(source).not.toContain("signalProcessGroup")
})

test("JSONL appends are chained and only a single valid line ahead of the independent anchor is recoverable", () => {
  const fixture = evidenceFixture()
  try {
    const previousAnchor = readFileSync(join(fixture.evidenceDir, "soak-manifest.anchor"))
    appendEvent(fixture.evidenceDir, "supervisor-start", { budget: { maxVMs: 2, headroomGiB: 20 }, bindingSha256: TEST_BINDING_SHA256 })
    const currentAnchor = readFileSync(join(fixture.evidenceDir, "soak-manifest.anchor"))
    const aheadAnchorPath = join(fixture.evidenceDir, "soak-manifest.anchor")
    writeFileSync(aheadAnchorPath, previousAnchor)
    const recovered = verifyTail(fixture.evidenceDir, { allowOneLineAhead: true })
    expect(recovered.ok).toBe(true)
    expect(recovered.oneLineAhead).toBe(true)
    expect(recovered.seq).toBe(1)
    expect(verifyTail(fixture.evidenceDir).ok).toBe(false)

    writeFileSync(aheadAnchorPath, currentAnchor)
    appendEvent(fixture.evidenceDir, "supervisor-restart", { recoveredSeq: 1 })
    expect(verifyTail(fixture.evidenceDir).lines.at(-1)?.event).toBe("supervisor-restart")
    const manifestPath = join(fixture.evidenceDir, "soak-manifest.jsonl")
    const contents = readFileSync(manifestPath)
    const lastNewline = contents.lastIndexOf(0x0a, contents.length - 2)
    writeFileSync(manifestPath, contents.subarray(0, lastNewline + 1))
    expect(verifyTail(fixture.evidenceDir).ok).toBe(false)
  } finally { fixture.cleanup() }
})

test("invocation-end requires explicit driver termination evidence and refuses incomplete legacy schemas without migration", () => {
  for (const damage of ["missing", "malformed", "legacy"] as const) {
    const fixture = evidenceFixture()
    try {
      appendProvisionedStart(fixture.evidenceDir)
      appendEvent(fixture.evidenceDir, "lineage-start", {
        lineage: "success-r1", family: "success", repetition: 1, fixtureID: "fixture-success-r1", fixtureTree: "b".repeat(40),
      })
      appendEvent(fixture.evidenceDir, "invocation-start", {
        lineage: "success-r1", invocationIndex: 1, scenario: "success", parentSessionID: null, argvSha256: "c".repeat(64),
      })
      appendEvent(fixture.evidenceDir, "invocation-end", {
        lineage: "success-r1", invocationIndex: 1, exit: { code: null, signal: "SIGKILL" },
        snapshotPath: "snapshots/success-r1/1.receipt.json", snapshotSha256: null, outcome: "killed",
        expectedInjection: null, errorNames: [], orderedTermination: false,
      })
      const manifestPath = join(fixture.evidenceDir, "soak-manifest.jsonl")
      const parsedLines = readFileSync(manifestPath, "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>)
      const end = parsedLines.at(-1)!
      if (damage === "missing") delete end.orderedTermination
      else if (damage === "malformed") end.orderedTermination = "false"
      else {
        for (const line of parsedLines) line.schema = "lca.soak-manifest.v1"
        delete end.orderedTermination
      }
      const damagedBytes = Buffer.from(`${parsedLines.map(line => JSON.stringify(line)).join("\n")}\n`)
      writeFileSync(manifestPath, damagedBytes)
      const anchor = readFileSync(join(fixture.evidenceDir, "soak-manifest.anchor"))

      const verification = verifyTail(fixture.evidenceDir)
      expect(verification.ok, damage).toBe(false)
      expect(verification.problems[0], damage).toContain(damage === "legacy" ? "without migration" : "driver-owned orderedTermination must be explicit")
      expect(readFileSync(manifestPath), damage).toEqual(damagedBytes)
      expect(readFileSync(join(fixture.evidenceDir, "soak-manifest.anchor")), damage).toEqual(anchor)
    } finally { fixture.cleanup() }
  }
})

test("two chained lines ahead of the independent anchor are never recoverable", () => {
  const fixture = evidenceFixture()
  try {
    appendEvent(fixture.evidenceDir, "supervisor-start", { budget: { maxVMs: 2, headroomGiB: 20 }, bindingSha256: TEST_BINDING_SHA256 })
    const oldAnchor = readFileSync(join(fixture.evidenceDir, "soak-manifest.anchor"))
    appendEvent(fixture.evidenceDir, "provision-start", { vm: "vm-c" })
    appendEvent(fixture.evidenceDir, "provision-end", { vm: "vm-c", outcome: "ok", errorKind: null })
    writeFileSync(join(fixture.evidenceDir, "soak-manifest.anchor"), oldAnchor)
    const result = verifyTail(fixture.evidenceDir, { allowOneLineAhead: true })
    expect(result.ok).toBe(false)
    expect(result.oneLineAhead).toBe(false)
  } finally { fixture.cleanup() }
})

test("the checker CLI exits 2 for integrity failures", async () => {
  const fixture = evidenceFixture()
  try {
    appendEvent(fixture.evidenceDir, "supervisor-start", { budget: { maxVMs: 2, headroomGiB: 20 }, bindingSha256: TEST_BINDING_SHA256 })
    writeFileSync(join(fixture.evidenceDir, "soak-manifest.jsonl"), "")
    const checkerPath = fileURLToPath(new URL("../../scripts/lca-soak-manifest.ts", import.meta.url))
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url))
    const result = await runCli([checkerPath, "--check", fixture.evidenceDir], repoRoot, process.env)
    expect(result.code).toBe(2)
    expect(JSON.parse(result.stdout).problems.length).toBeGreaterThan(0)
  } finally { fixture.cleanup() }
})

test("the grammar accepts the fixed 24-lineage resume structure and rejects an unfinished invocation", () => {
  const fixture = evidenceFixture()
  try {
    appendCompleteGrammar(fixture.evidenceDir)
    const complete = verifyTail(fixture.evidenceDir)
    expect(complete.ok).toBe(true)
    expect(validateGrammar(complete.lines).ok).toBe(true)
    expect(validateGrammar(complete.lines).lineages).toBe(24)

    const partial = evidenceFixture()
    try {
      appendProvisionedStart(partial.evidenceDir)
      appendEvent(partial.evidenceDir, "lineage-start", {
        lineage: "success-r1", family: "success", repetition: 1, fixtureID: "fixture-success-r1", fixtureTree: "d".repeat(40),
      })
      appendEvent(partial.evidenceDir, "invocation-start", {
        lineage: "success-r1", invocationIndex: 1, scenario: "success", parentSessionID: null, argvSha256: "e".repeat(64),
      })
      const state = verifyTail(partial.evidenceDir)
      expect(validateGrammar(state.lines, { allowIncomplete: true }).ok).toBe(false)
    } finally { partial.cleanup() }
  } finally { fixture.cleanup() }
})

test("the O_EXCL lock is exclusive and a stale lock is refused without mutation", () => {
  const fixture = evidenceFixture()
  try {
    const lock = acquireLock(fixture.evidenceDir)
    expect(() => acquireLock(fixture.evidenceDir)).toThrow(/soak.lock exists/)
    releaseLock(fixture.evidenceDir, lock)

    const stalePath = join(fixture.evidenceDir, "soak.lock")
    const staleBytes = Buffer.from('{"pid":1,"startedAt":"old"}\n')
    writeFileSync(stalePath, staleBytes, { mode: 0o600 })
    expect(() => acquireLock(fixture.evidenceDir)).toThrow(/without stale-PID cleanup/)
    expect(readFileSync(stalePath)).toEqual(staleBytes)
  } finally { fixture.cleanup() }
})

test("only pinned self-interruption snapshots qualify; external SIGKILL, unplanned 137, and model aborts do not", () => {
  for (const family of ["interrupt", "checkpoint", "active-verifier"] as const) {
    const receipt = interruptionReceipt(family)
    expect(classify({
      family,
      invocationIndex: 1,
      scenario: family,
      exit: { code: 137, signal: null },
      receipt,
      expectedInjection: FAMILY_TABLE[family].expectedInjection,
    })).toBe("expected-fail-closed")
    expect(classify({
      family,
      invocationIndex: 1,
      scenario: family,
      exit: { code: null, signal: "SIGKILL" },
      receipt,
      expectedInjection: FAMILY_TABLE[family].expectedInjection,
    })).toBe("killed")

    if (family === "interrupt") {
      const mismatchedReceipt = structuredClone(receipt)
      const run = (mismatchedReceipt.runs as Array<Record<string, unknown>>)[0]!
      const busy = run.secondTaskWorkerBusyObservation as Record<string, unknown>
      busy.vendorSessionID = "different-child-session"
      expect(classify({
        family,
        invocationIndex: 1,
        scenario: family,
        exit: { code: 137, signal: null },
        receipt: mismatchedReceipt,
        expectedInjection: FAMILY_TABLE[family].expectedInjection,
      })).toBe("killed")
    }
  }

  const successReceipt = receiptBase({
    scenario: "success",
    nativeAcceptance: { done: 1, reviewerVerdict: "accept", verifierExitCodes: [0] },
  })
  expect(classify({
    family: "success", invocationIndex: 1, scenario: "success", exit: { code: null, signal: "SIGTERM" }, receipt: null,
    expectedInjection: null, errorNames: ["SupervisorTimeoutError"], orderedTermination: true,
  })).toBe("snapshot-missing")
  expect(classify({
    family: "success", invocationIndex: 1, scenario: "success", exit: { code: null, signal: "SIGTERM" }, receipt: null,
    expectedInjection: null, errorNames: ["SupervisorTimeoutError"], orderedTermination: false,
  })).toBe("killed")
  expect(classify({ family: "success", invocationIndex: 1, scenario: "success", exit: { code: 137, signal: null }, receipt: successReceipt, expectedInjection: null })).toBe("killed")
  expect(classify({ family: "success", invocationIndex: 1, scenario: "success", exit: { code: 0, signal: null }, receipt: null, expectedInjection: null })).toBe("snapshot-missing")
  expect(classify({
    family: "active-verifier",
    invocationIndex: 1,
    scenario: "active-verifier",
    exit: { code: 137, signal: null },
    receipt: { ...interruptionReceipt("active-verifier"), modelAborts: [{ errorName: "MessageAbortedError" }] },
    expectedInjection: FAMILY_TABLE["active-verifier"].expectedInjection,
  })).toBe("unexpected-failure")
  expect(classify({
    family: "active-verifier",
    invocationIndex: 1,
    scenario: "active-verifier",
    exit: { code: 137, signal: null },
    receipt: interruptionReceipt("active-verifier"),
    expectedInjection: FAMILY_TABLE["active-verifier"].expectedInjection,
    errorNames: ["MessageAbortedError"],
  })).toBe("unexpected-failure")
})

test("active-verifier's intermediate linked resume is expected fail-closed, then the final resume passes", () => {
  const manifest = validateFixtureManifest(fixtureInput())
  const first = manifest.lineages.find(lineage => lineage.family === "active-verifier")!
  const intermediateReceipt = receiptBase({
    scenario: "resume",
    activeVerifierStage: "retirement-recorded",
    nativeRetirement: { authenticated: true, result: { cancelled: false } },
    queueResult: { aborted: true, done: 0, failed: 0 },
  })
  expect(classify({
    family: "active-verifier", invocationIndex: 2, scenario: "resume", exit: { code: 0, signal: null },
    receipt: intermediateReceipt, expectedInjection: null,
  })).toBe("expected-fail-closed")
  const finalReceipt = receiptBase({
    scenario: "resume",
    activeVerifierStage: "remaining-tasks-completed",
    remainingTaskAcceptance: { done: 2 },
    queueResult: { aborted: false, done: 2, failed: 0 },
    completedTaskIDsAfter: ["t1", "t2", "t3"],
  })
  expect(classify({
    family: "active-verifier", invocationIndex: 3, scenario: "resume", exit: { code: 0, signal: null },
    receipt: finalReceipt, expectedInjection: null,
  })).toBe("pass")
  expect(first.invocations).toHaveLength(3)
})

test("the family table pins driver SIGKILLs after the production OpenCode busy observation", () => {
  const driverPath = fileURLToPath(new URL("../../scripts/lca-live-core-queue.ts", import.meta.url))
  const source = readFileSync(driverPath, "utf8")
  expect(FAMILY_TABLE.interrupt.expectedExitCode).toBe(137)
  expect(FAMILY_TABLE.checkpoint.expectedExitCode).toBe(137)
  expect(FAMILY_TABLE["active-verifier"].expectedExitCode).toBe(137)
  expect(source.match(/process\.kill\(process\.pid, "SIGKILL"\)/g)).toHaveLength(3)
  for (const scenario of ["interrupt", "checkpoint", "active-verifier"]) expect(source).toContain(`args.scenario === "${scenario}"`)
  expect(source).toContain("const status = result.data[child.vendorSessionID]?.type")
  expect(source).toContain("run.secondTaskWorkerBusyObservation = busy")
  expect(source).toContain("vendorChildSessionID: targetChild.vendorSessionID")
  expect(source).toContain("runningTaskID: currentLedger.running?.taskId")
})

test("trusted remote transport maps actual driver self-SIGKILLs to numeric 137 with matching receipt assertions", async () => {
  const fixture = integrationFixture()
  try {
    const run = await runCli([
      fixture.supervisorPath,
      "--evidence-root", fixture.hostEvidence,
      "--vm-c", "stub-host",
      "--fixtures-manifest", fixture.manifestPath,
    ], fixture.root, fixture.env)
    expect(run.code).toBe(0)
    expect(readFileSync(fixture.provisionLog, "utf8")).toContain("provisioned")
    expect(readFileSync(fixture.driverLog, "utf8").trim().split("\n")).toHaveLength(36)

    const evidenceDir = onlyEvidenceDirectory(fixture.hostEvidence)
    expect(JSON.parse(run.stderr)).toEqual({ event: "soak-evidence", path: evidenceDir })
    const lines = readFileSync(join(evidenceDir, "soak-manifest.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
    for (const lineage of ["interrupt-r1", "checkpoint-r1", "active-verifier-r1"]) {
      expect(lines.find(line => line.event === "invocation-end" && line.lineage === lineage)).toMatchObject({
        exit: { code: 137, signal: null },
        outcome: "expected-fail-closed",
        snapshotSha256: expect.any(String),
      })
    }
    const checked = await runCli([fixture.checkerPath, "--check", evidenceDir], fixture.root, fixture.env)
    expect(checked.code).toBe(0)
    expect(JSON.parse(checked.stdout)).toEqual({ ok: true, unexpected: 0, problems: [] })
    expect(readdirSync(join(evidenceDir, "snapshots"))).toHaveLength(24)
  } finally { fixture.cleanup() }
})

test("the CLI records a pre-driver provisioning failure and the checker exits 3", async () => {
  const fixture = integrationFixture({ provisionFails: true })
  try {
    const evidenceDir = join(fixture.hostEvidence, "linux-eligibility-2026-10-08T000000.000Z")
    mkdirSync(evidenceDir, { mode: 0o700 })
    const bindingHash = initializeManifest(evidenceDir, fixture.binding)
    const genesisAnchor = readFileSync(join(evidenceDir, "soak-manifest.anchor"))
    appendEvent(evidenceDir, "supervisor-start", { budget: { maxVMs: 2, headroomGiB: 20 }, bindingSha256: bindingHash })
    writeFileSync(join(evidenceDir, "soak-manifest.anchor"), genesisAnchor)
    const run = await runCli([
      fixture.supervisorPath,
      "--restart",
      "--evidence-root", evidenceDir,
      "--vm-c", "stub-host",
      "--fixtures-manifest", fixture.manifestPath,
    ], fixture.root, fixture.env)
    expect(run.code).toBe(3)
    expect(existsSync(fixture.driverLog)).toBe(false)
    const lines = readFileSync(join(evidenceDir, "soak-manifest.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
    expect(lines.map(line => line.event)).toEqual(["supervisor-start", "supervisor-restart", "provision-start", "provision-end", "supervisor-end"])
    expect(lines[1].recoveredSeq).toBe(1)
    const checked = await runCli([fixture.checkerPath, "--check", evidenceDir], fixture.root, fixture.env)
    expect(checked.code).toBe(3)
    expect(JSON.parse(checked.stdout)).toMatchObject({ ok: false, unexpected: 1, problems: [] })
  } finally { fixture.cleanup() }
})

test("restart refuses each independently changed provisioning/invocation argv, cwd, or timeout before evidence mutation", async () => {
  const mutations: Array<{ label: string; apply: (input: Record<string, unknown>) => void }> = [
    {
      label: "provision argv",
      apply(input) {
        const provisioning = input.provisioning as Array<Record<string, unknown>>
        const argv = provisioning[0]!.argv as string[]
        argv.push("changed")
      },
    },
    {
      label: "provision cwd",
      apply(input) { (input.provisioning as Array<Record<string, unknown>>)[0]!.cwd = "/tmp/changed-provision-cwd" },
    },
    {
      label: "provision timeout",
      apply(input) { (input.provisioning as Array<Record<string, unknown>>)[0]!.timeoutMs = 31 * 60_000 },
    },
    {
      label: "invocation argv",
      apply(input) {
        const first = (input.lineages as Array<Record<string, unknown>>)[0]!
        const invocation = (first.invocations as Array<Record<string, unknown>>)[0]!
        ;(invocation.argv as string[]).push("changed")
      },
    },
    {
      label: "invocation cwd",
      apply(input) {
        const first = (input.lineages as Array<Record<string, unknown>>)[0]!
        ;(first.invocations as Array<Record<string, unknown>>)[0]!.cwd = "/tmp/changed-invocation-cwd"
      },
    },
    {
      label: "invocation timeout",
      apply(input) {
        const first = (input.lineages as Array<Record<string, unknown>>)[0]!
        ;(first.invocations as Array<Record<string, unknown>>)[0]!.timeoutMs = 31 * 60_000
      },
    },
  ]
  for (const mutation of mutations) {
    const fixture = integrationFixture()
    try {
      const evidenceDir = seededRestartEvidence(fixture)
      const before = evidenceBytes(evidenceDir)
      const input = JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as Record<string, unknown>
      mutation.apply(input)
      writeFileSync(fixture.manifestPath, JSON.stringify(input), { mode: 0o600 })

      const result = await restartCli(fixture, evidenceDir)
      expect(result.code, mutation.label).toBe(2)
      expect(result.stderr).toContain("differs from the immutable run binding")
      expect(evidenceBytes(evidenceDir), mutation.label).toEqual(before)
      expect(existsSync(fixture.provisionLog), mutation.label).toBe(false)
      expect(existsSync(fixture.driverLog), mutation.label).toBe(false)
      expect(existsSync(fixture.sshLog), mutation.label).toBe(false)
    } finally { fixture.cleanup() }
  }
})

test("restart refuses a changed SSH target before creating a lock, reading receipts over SSH, or launching commands", async () => {
  const fixture = integrationFixture()
  try {
    const evidenceDir = seededRestartEvidence(fixture, true)
    const before = evidenceBytes(evidenceDir)
    const result = await restartCli(fixture, evidenceDir, "different-stub-host")
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("differs from the immutable run binding")
    expect(evidenceBytes(evidenceDir)).toEqual(before)
    expect(existsSync(fixture.provisionLog)).toBe(false)
    expect(existsSync(fixture.driverLog)).toBe(false)
    expect(existsSync(fixture.sshLog)).toBe(false)
  } finally { fixture.cleanup() }
})

test("missing or tampered immutable run binding refuses restart without changing manifest, anchor, or snapshots", async () => {
  for (const tamper of ["missing", "modified"] as const) {
    const fixture = integrationFixture()
    try {
      const evidenceDir = seededRestartEvidence(fixture)
      const bindingPath = join(evidenceDir, "soak-binding.json")
      if (tamper === "missing") rmSync(bindingPath)
      else {
        chmodSync(bindingPath, 0o600)
        const bytes = readFileSync(bindingPath, "utf8").replace("stub-host", "other-host")
        writeFileSync(bindingPath, bytes)
        chmodSync(bindingPath, 0o400)
      }
      const before = evidenceBytes(evidenceDir)
      const result = await restartCli(fixture, evidenceDir)
      expect(result.code, tamper).toBe(2)
      expect(result.stderr).toContain("run binding")
      expect(evidenceBytes(evidenceDir), tamper).toEqual(before)
      expect(existsSync(fixture.provisionLog)).toBe(false)
      expect(existsSync(fixture.driverLog)).toBe(false)
      expect(existsSync(fixture.sshLog)).toBe(false)
    } finally { fixture.cleanup() }
  }
})

test("restart refuses and preserves incomplete legacy invocation evidence instead of migrating it", async () => {
  const fixture = integrationFixture()
  try {
    const evidenceDir = seededKilledInvocationEvidence(fixture, [])
    const manifestPath = join(evidenceDir, "soak-manifest.jsonl")
    const lines = readFileSync(manifestPath, "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>)
    for (const line of lines) line.schema = "lca.soak-manifest.v1"
    delete lines.at(-1)!.orderedTermination
    writeFileSync(manifestPath, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`)
    const before = evidenceBytes(evidenceDir)

    const result = await restartCli(fixture, evidenceDir)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("without migration")
    expect(evidenceBytes(evidenceDir)).toEqual(before)
    expect(existsSync(fixture.provisionLog)).toBe(false)
    expect(existsSync(fixture.driverLog)).toBe(false)
    expect(existsSync(fixture.sshLog)).toBe(false)
  } finally { fixture.cleanup() }
})

test("unchanged restart validates the binding before one-line-ahead recovery and resumes from the original specs", async () => {
  const fixture = integrationFixture()
  try {
    const evidenceDir = seededRestartEvidence(fixture, true)
    const result = await restartCli(fixture, evidenceDir)
    expect(result.code).toBe(0)
    const lines = readFileSync(join(evidenceDir, "soak-manifest.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
    const restartIndex = lines.findIndex(line => line.event === "supervisor-restart")
    expect(restartIndex).toBeGreaterThan(0)
    expect(lines[restartIndex]).toMatchObject({ seq: 5, recoveredSeq: 4 })
    expect(lines[restartIndex - 1]).toMatchObject({ event: "lineage-start", lineage: "success-r1" })
    expect(lines[restartIndex + 1]).toMatchObject({ event: "invocation-start", lineage: "success-r1", invocationIndex: 1 })
    expect((await runCli([fixture.checkerPath, "--check", evidenceDir], fixture.root, fixture.env)).code).toBe(0)
  } finally { fixture.cleanup() }
})

test("receipt-only timeout, overflow, and termination errors never override driver termination on check or restart", async () => {
  const fixture = integrationFixture()
  try {
    const receiptErrors = ["SupervisorTimeoutError", "ReceiptTooLargeError", "SupervisorTerminationError"]
    const evidenceDir = seededKilledInvocationEvidence(fixture, receiptErrors)
    const invocationEnd = readFileSync(join(evidenceDir, "soak-manifest.jsonl"), "utf8")
      .trimEnd().split("\n").map(line => JSON.parse(line)).find(line => line.event === "invocation-end")!
    expect(invocationEnd).toMatchObject({
      exit: { code: null, signal: "SIGKILL" }, outcome: "killed", orderedTermination: false, errorNames: receiptErrors,
    })

    const checkedPrefix = checkManifest(evidenceDir)
    expect(checkedPrefix.problems.filter(problem => problem.includes("recorded outcome disagrees"))).toEqual([])

    const restarted = await restartCli(fixture, evidenceDir)
    expect(restarted.code).toBe(3)
    expect(restarted.stderr).not.toContain("existing invocation outcome does not match")
    const lines = readFileSync(join(evidenceDir, "soak-manifest.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
    expect(lines.some(line => line.event === "supervisor-restart")).toBe(true)
    expect(lines.filter(line => line.event === "invocation-start" && line.lineage === "success-r1")).toHaveLength(1)
    expect(lines.find(line => line.event === "invocation-end" && line.lineage === "success-r1")).toMatchObject({
      outcome: "killed", orderedTermination: false,
    })
    const checkedRestart = checkManifest(evidenceDir)
    expect(checkedRestart.problems.filter(problem => problem.includes("recorded outcome disagrees"))).toEqual([])
  } finally { fixture.cleanup() }
})

test("an unplanned driver SIGKILL plus receipt overflow remains killed in persisted and checker classifications", async () => {
  const fixture = integrationFixture({ killFirstSuccess: true, sshMode: "overflow" })
  try {
    const run = await runCli([
      fixture.supervisorPath,
      "--evidence-root", fixture.hostEvidence,
      "--vm-c", "stub-host",
      "--fixtures-manifest", fixture.manifestPath,
    ], fixture.root, fixture.env)
    expect(run.code).toBe(3)
    const evidenceDir = onlyEvidenceDirectory(fixture.hostEvidence)
    const lines = readFileSync(join(evidenceDir, "soak-manifest.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
    expect(lines.find(line => line.event === "invocation-end" && line.lineage === "success-r1")).toMatchObject({
      exit: { code: null, signal: "SIGKILL" }, outcome: "killed", orderedTermination: false,
    })
    expect(lines.find(line => line.event === "invocation-end" && line.lineage === "success-r1").errorNames).toContain("ReceiptTooLargeError")
    expect(readFileSync(fixture.driverLog, "utf8").split("\n").filter(line => line === "success 1")).toHaveLength(2)
    expect(lines.find(line => line.event === "lineage-end" && line.lineage === "success-r1")?.outcome).toBe("unexpected")
    const checked = await runCli([fixture.checkerPath, "--check", evidenceDir], fixture.root, fixture.env)
    expect(checked.code).toBe(3)
    expect(JSON.parse(checked.stdout)).toMatchObject({ ok: false, unexpected: 1, problems: [] })
  } finally { fixture.cleanup() }
})

test("genuine asynchronous spawn failure is recorded after close without starting later work", async () => {
  const fixture = integrationFixture({ provisionSpawnFails: true })
  try {
    const run = await startFreshSupervisor(fixture).result
    expect(run.code).toBe(3)
    const lines = manifestLines(fixture)
    expect(lines.find(line => line.event === "provision-end")).toMatchObject({
      vm: "vm-c", outcome: "failed", errorKind: "spawn-error",
    })
    expect(lines.some(line => line.event === "invocation-start")).toBe(false)
    expect(existsSync(fixture.driverLog)).toBe(false)
    expect(existsSync(fixture.sshLog)).toBe(false)
  } finally { fixture.cleanup() }
})

test("invocation timeout terminates the owned transport handle and records the timeout", async () => {
  const fixture = integrationFixture({ hangDriver: true })
  try {
    setFirstInvocationTimeout(fixture, 1_000)
    const startedAt = Date.now()
    const run = await startFreshSupervisor(fixture).result
    expect(run.code).toBe(3)
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(readFileSync(fixture.driverLog, "utf8")).toContain("driver-terminated")
    const evidenceDir = onlyEvidenceDirectory(fixture.hostEvidence)
    const lines = readFileSync(join(evidenceDir, "soak-manifest.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
    const end = lines.find(line => line.event === "invocation-end" && line.lineage === "success-r1")
    expect(end.errorNames).toContain("SupervisorTimeoutError")
    expect(end).toMatchObject({ outcome: "unexpected-failure", orderedTermination: true })
    expect(end.snapshotSha256).toMatch(/^[a-f0-9]{64}$/)
  } finally { fixture.cleanup() }
})

test("failed timeout signals retain child ownership and escalation until genuine child exit", async () => {
  const fixture = integrationFixture({ hangDriver: true, naturalDriverExitMs: 2_800 })
  try {
    setFirstInvocationTimeout(fixture, 1_000)
    const running = startSupervisorWithSignalFailures(fixture, "timeout")
    let settled = false
    running.result.then(() => { settled = true })
    await waitForText(fixture.driverLog, "driver-started", 5_000)
    await waitForText(fixture.killAttempts, "SIGTERM", 5_000)
    await waitForLineCount(fixture.killAttempts, "SIGKILL", 1, 5_000)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    expect(manifestLines(fixture).some(line => line.event === "invocation-end")).toBe(false)
    expect(readFileSync(fixture.driverLog, "utf8")).not.toContain("retry 1")

    await waitForText(fixture.driverLog, "driver-natural-exit", 5_000)
    const result = await running.result
    expect(result.code).toBe(3)
    const end = manifestLines(fixture).find(line => line.event === "invocation-end" && line.lineage === "success-r1")
    expect(end?.errorNames).toContain("ChildSignalError")
    expect(end?.errorNames).toContain("SupervisorTimeoutError")
    expect(readFileSync(fixture.killAttempts, "utf8").split("\n")).toEqual(["SIGTERM", "SIGKILL", ""])
  } finally { fixture.cleanup() }
})

test("supervisor SIGINT and SIGTERM stop only the directly owned transport child", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const fixture = integrationFixture({ hangDriver: true })
    try {
      const running = startFreshSupervisor(fixture)
      await waitForText(fixture.driverLog, "driver-started", 5_000)
      running.child.kill(signal)
      const result = await running.result
      expect(result.code).toBe(3)
      expect(readFileSync(fixture.driverLog, "utf8")).toContain("driver-terminated")
      const evidenceDir = onlyEvidenceDirectory(fixture.hostEvidence)
      const lines = readFileSync(join(evidenceDir, "soak-manifest.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
      const end = lines.find(line => line.event === "invocation-end" && line.lineage === "success-r1")
      expect(end.errorNames).toContain("SupervisorTerminationError")
    } finally { fixture.cleanup() }
  }
})

test("failed supervisor-stop signals retain ownership and escalation until actual child exit", async () => {
  const fixture = integrationFixture({ hangDriver: true, naturalDriverExitMs: 2_800 })
  try {
    const running = startSupervisorWithSignalFailures(fixture, "stop")
    let settled = false
    running.result.then(() => { settled = true })
    await waitForText(fixture.driverLog, "driver-started", 5_000)
    running.child.kill("SIGINT")
    await waitForText(fixture.killAttempts, "SIGTERM", 5_000)
    await waitForLineCount(fixture.killAttempts, "SIGKILL", 1, 5_000)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    expect(manifestLines(fixture).some(line => line.event === "invocation-end")).toBe(false)
    expect(readFileSync(fixture.driverLog, "utf8")).not.toContain("retry 1")

    await waitForText(fixture.driverLog, "driver-natural-exit", 5_000)
    const result = await running.result
    expect(result.code).toBe(3)
    const end = manifestLines(fixture).find(line => line.event === "invocation-end" && line.lineage === "success-r1")
    expect(end?.errorNames).toContain("ChildSignalError")
    expect(end?.errorNames).toContain("SupervisorTerminationError")
    expect(readFileSync(fixture.killAttempts, "utf8")).toContain("SIGKILL")
  } finally { fixture.cleanup() }
})

test("receipt overflow directly kills the SSH child and returns a bounded capture failure", async () => {
  const fixture = integrationFixture({ sshMode: "overflow" })
  try {
    const startedAt = Date.now()
    const run = await startFreshSupervisor(fixture).result
    expect(run.code).toBe(3)
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    const evidenceDir = onlyEvidenceDirectory(fixture.hostEvidence)
    const lines = readFileSync(join(evidenceDir, "soak-manifest.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
    const end = lines.find(line => line.event === "invocation-end" && line.lineage === "success-r1")
    expect(end.errorNames).toContain("ReceiptTooLargeError")
    expect(end.snapshotSha256).toBeNull()
  } finally { fixture.cleanup() }
})

test("failed receipt-overflow signals retain the SSH child until actual exit and still escalate", async () => {
  const fixture = integrationFixture({ sshMode: "overflow", naturalSshExitMs: 2_800 })
  try {
    const running = startSupervisorWithSignalFailures(fixture, "overflow")
    let settled = false
    running.result.then(() => { settled = true })
    await waitForLineCount(fixture.killAttempts, "SIGKILL", 2, 10_000)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    expect(manifestLines(fixture).some(line => line.event === "invocation-end")).toBe(false)
    expect(readFileSync(fixture.driverLog, "utf8")).not.toContain("retry 1")

    await waitForText(fixture.sshExitedMarker, "success-r1", 5_000)
    const result = await running.result
    expect(result.code).toBe(3)
    const end = manifestLines(fixture).find(line => line.event === "invocation-end" && line.lineage === "success-r1")
    expect(end?.errorNames).toContain("ChildSignalError")
    expect(end?.errorNames).toContain("ReceiptTooLargeError")
    expect(readFileSync(fixture.killAttempts, "utf8").split("\n")).toEqual(["SIGKILL", "SIGKILL", ""])
  } finally { fixture.cleanup() }
})

test("direct child exit before receipt-pipe close is bounded without signaling its naturally expiring descendant", async () => {
  const fixture = integrationFixture({ sshMode: "descendant-holds-pipe", descendantDelayMs: 5_000 })
  try {
    const running = startFreshSupervisor(fixture)
    await waitForText(fixture.sshExitedMarker, "success-r1", 8_000)
    const stopAt = Date.now()
    running.child.kill("SIGTERM")
    const run = await running.result
    expect(run.code).toBe(3)
    expect(Date.now() - stopAt).toBeLessThan(3_000)
    const evidenceDir = onlyEvidenceDirectory(fixture.hostEvidence)
    const lines = readFileSync(join(evidenceDir, "soak-manifest.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
    const end = lines.find(line => line.event === "invocation-end" && line.lineage === "success-r1")
    expect(end.errorNames).toContain("ReceiptCaptureIncompleteError")
    expect(existsSync(fixture.descendantMarker)).toBe(false)
    await waitForText(fixture.descendantMarker, "expired", 7_000)
    expect(readFileSync(fixture.descendantMarker, "utf8")).toContain("expired")
  } finally { fixture.cleanup() }
}, 20_000)
