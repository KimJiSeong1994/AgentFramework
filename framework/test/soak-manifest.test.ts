import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FAMILY_TABLE,
  appendEvent,
  createSupervisorBinding,
  expectedSnapshotPath,
  initializeManifest,
  materializeArgv,
  supervisorBindingSha256,
  validateFixtureManifest,
} from "../../scripts/otter-soak-supervisor.ts"
import type { Family } from "../../scripts/otter-soak-supervisor.ts"
import { checkManifest } from "../../scripts/otter-soak-manifest.ts"

const families = Object.keys(FAMILY_TABLE) as Family[]
const sessionID = "session_01"

function fixtureInput(): Record<string, unknown> {
  return {
    schema: "otter.soak-fixtures.v1",
    version: 1,
    provisioning: [{ vm: "vm-c", cwd: "/tmp", argv: ["provision", "--vm", "vm-c"] }],
    lineages: families.flatMap(family => [1, 2, 3].map(repetition => {
      const lineage = `${family}-r${repetition}`
      const policy = FAMILY_TABLE[family]
      const receiptPath = `/tmp/otter-soak/${lineage}.receipt.json`
      return {
        lineage,
        family,
        repetition,
        fixtureID: `fixture-${lineage}`,
        fixtureTree: "a".repeat(40),
        invocations: Array.from({ length: policy.invocationCount }, (_, offset) => {
          const index = offset + 1
          const scenario = index === 1 ? policy.scenario : "resume"
          return {
            scenario,
            cwd: "/tmp",
            argv: ["python3", "scripts/otter-soak-pty-ssh.py", "--scenario", scenario, "--receipt", receiptPath,
              "--verifier", "linux-production", ...(index > 1 ? ["--session", "@otter-soak-parent-session"] : [])],
            receiptPath,
            expectedInjection: index === 1 ? policy.expectedInjection : null,
            ...(index > 1 ? { resumeSession: { fromInvocationIndex: 1 } } : {}),
          }
        }),
      }
    })),
  }
}

const TEST_BINDING = createSupervisorBinding("stub-host", validateFixtureManifest(fixtureInput()))
const TEST_BINDING_SHA256 = supervisorBindingSha256(TEST_BINDING)

function evidenceFixture() {
  const root = mkdtempSync(join(tmpdir(), "otter-soak-manifest-"))
  const evidenceDir = join(root, "linux-eligibility-test")
  mkdirSync(evidenceDir, { mode: 0o700 })
  initializeManifest(evidenceDir, TEST_BINDING)
  return { root, evidenceDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function baseReceipt(run: Record<string, unknown>) {
  return {
    schemaVersion: 2,
    scenario: run.scenario,
    receiptPath: "/tmp/otter-soak/fake-receipt.json",
    baseIdentity: { verifier: "linux-production" },
    nativeSessionIDs: { parentSessionID: sessionID },
    modelAborts: [],
    failures: [],
    runs: [{ scenario: run.scenario, parentSessionID: sessionID, ...run }],
  }
}

function linkedReceipt(family: Family, invocationIndex: number, run: Record<string, unknown>) {
  const result: Record<string, unknown> = baseReceipt(run)
  const priorRuns = invocationIndex === 2
    ? (receiptFor(family, 1).runs as Record<string, unknown>[])
    : (receiptFor(family, 2).runs as Record<string, unknown>[])
  result.runs = [...priorRuns, ...(result.runs as Record<string, unknown>[])]
  return result
}

function receiptFor(family: Family, invocationIndex: number, injectAbort = false): Record<string, unknown> {
  if (invocationIndex === 1) {
    if (family === "success") return baseReceipt({
      scenario: "success",
      nativeAcceptance: { done: 1, reviewerVerdict: "accept", verifierExitCodes: [0] },
    })
    if (family === "retry") return baseReceipt({
      scenario: "retry",
      driver_fault_injection: { applicationCount: 1, source: "driver_fault_injection" },
      nativeAcceptance: { done: 1, reviewerVerdict: "accept", verifierExitCodes: [4, 0] },
    })
    if (family === "reject") return baseReceipt({
      scenario: "reject",
      injection: { appliedAt: "2026-10-08T00:00:00.000Z" },
      observedReview: { verdict: "reject" },
    })
    if (family === "cancel") return baseReceipt({
      scenario: "cancel",
      firstWorkerBusyObservation: { observed: "busy" },
      queueAbort: { invoked: true, reason: "user_stop" },
      queueResult: { aborted: true, done: 0, failed: 0 },
    })
    if (family === "verifier-cancel") return baseReceipt({
      scenario: "verifier-cancel",
      nativeRetirement: { authenticated: true, result: { cancelled: true, domainState: "empty" } },
      queueResult: { aborted: true },
      explicitResumedQueueResult: { aborted: false, done: 0, failed: 0, taskIds: [] },
    })
    const interruption: Record<string, unknown> = { parentSessionID: sessionID, completedTaskIDs: ["t1"] }
    if (family === "interrupt") Object.assign(interruption, {
      vendorChildSessionID: "child_2", targetTaskID: "t2", runningTaskID: "t2",
    })
    if (family === "checkpoint") interruption.boundary = "verified_task_checkpoint_before_next_execution_intent"
    if (family === "active-verifier") Object.assign(interruption, {
      boundary: "active_native_verifier_before_t2_retirement",
      verifierDispatch: "started",
      cgroupPopulated: true,
      boundaryRef: { kind: "verifier", profile: "linux-single-use" },
    })
    return {
      ...baseReceipt({
        scenario: family,
        interruption,
        ...(family === "interrupt" ? {
          secondTaskWorkerBusyObservation: {
            vendorSessionID: "child_2", taskID: "t2", observed: "busy", polls: 1, statusErrors: 0,
            lastStatus: "busy", startedAt: 1, finishedAt: 2,
          },
        } : {}),
      }),
      ...(injectAbort ? { modelAborts: [{ errorName: "MessageAbortedError" }] } : {}),
    }
  }
  if (family === "active-verifier" && invocationIndex === 2) return linkedReceipt(family, invocationIndex, {
    scenario: "resume",
    activeVerifierStage: "retirement-recorded",
    nativeRetirement: { authenticated: true, result: { cancelled: false } },
    queueResult: { aborted: true, done: 0, failed: 0 },
  })
  if (family === "active-verifier") return linkedReceipt(family, invocationIndex, {
    scenario: "resume",
    activeVerifierStage: "remaining-tasks-completed",
    remainingTaskAcceptance: { done: 2 },
    queueResult: { aborted: false, done: 2, failed: 0 },
    completedTaskIDsAfter: ["t1", "t2", "t3"],
  })
  return linkedReceipt(family, invocationIndex, {
    scenario: "resume",
    queueResult: { aborted: false, done: 2, failed: 0 },
    completedTaskIDsAfter: ["t1", "t2", "t3"],
  })
}

function writeSnapshot(evidenceDir: string, lineage: string, index: number, receipt: Record<string, unknown>): { path: string; sha256: string } {
  const path = expectedSnapshotPath(lineage, index)
  const full = join(evidenceDir, ...path.split("/"))
  mkdirSync(join(evidenceDir, "snapshots", lineage), { mode: 0o700, recursive: true })
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`)
  writeFileSync(full, bytes, { flag: "wx", mode: 0o400 })
  chmodSync(full, 0o400)
  return { path, sha256: hash(bytes) }
}

function buildManifest(evidenceDir: string, options: { failedProvision?: boolean; unexpectedFamily?: Family; missingSnapshot?: boolean } = {}): void {
  appendEvent(evidenceDir, "supervisor-start", { budget: { maxVMs: 2, headroomGiB: 20 }, bindingSha256: TEST_BINDING_SHA256 })
  appendEvent(evidenceDir, "provision-start", { vm: "vm-c" })
  if (options.failedProvision) {
    appendEvent(evidenceDir, "provision-end", { vm: "vm-c", outcome: "failed", errorKind: "exit-nonzero" })
    appendEvent(evidenceDir, "supervisor-end", { lineages: 0, unexpected: 1 })
    return
  }
  appendEvent(evidenceDir, "provision-end", { vm: "vm-c", outcome: "ok", errorKind: null })

  let unexpected = 0
  for (const family of families) {
    for (const repetition of [1, 2, 3] as const) {
      const lineage = `${family}-r${repetition}`
      appendEvent(evidenceDir, "lineage-start", {
        lineage,
        family,
        repetition,
        fixtureID: `fixture-${lineage}`,
        fixtureTree: "a".repeat(40),
      })
      let lineageUnexpected = false
      for (let invocationIndex = 1; invocationIndex <= FAMILY_TABLE[family].invocationCount; invocationIndex++) {
        const scenario = invocationIndex === 1 ? FAMILY_TABLE[family].scenario : "resume"
        appendEvent(evidenceDir, "invocation-start", {
          lineage,
          invocationIndex,
          scenario,
          parentSessionID: invocationIndex === 1 ? null : sessionID,
          argvSha256: hash(Buffer.from(JSON.stringify(materializeArgv(
            TEST_BINDING.fixtures.lineages.find(spec => spec.lineage === lineage)!.invocations[invocationIndex - 1]!,
            invocationIndex === 1 ? null : sessionID,
          )))),
        })
        const receipt = receiptFor(family, invocationIndex, family === options.unexpectedFamily && repetition === 1)
        receipt.receiptPath = TEST_BINDING.fixtures.lineages.find(spec => spec.lineage === lineage)!.invocations[invocationIndex - 1]!.receiptPath
        const missingSnapshot = options.missingSnapshot === true && family === "success" && repetition === 1 && invocationIndex === 1
        const snapshot = missingSnapshot
          ? { path: expectedSnapshotPath(lineage, invocationIndex), sha256: null }
          : writeSnapshot(evidenceDir, lineage, invocationIndex, receipt)
        const expectedInjection = invocationIndex === 1 ? FAMILY_TABLE[family].expectedInjection : null
        const exit = { code: invocationIndex === 1 ? FAMILY_TABLE[family].expectedExitCode : 0, signal: null }
        const errorNames: string[] = []
        let outcome: string
        if (missingSnapshot) {
          outcome = "snapshot-missing"
          lineageUnexpected = true
          unexpected++
        } else if (family === options.unexpectedFamily && repetition === 1 && invocationIndex === 1) {
          outcome = "unexpected-failure"
          lineageUnexpected = true
          unexpected++
        } else if (invocationIndex === 1 && family !== "success" || family === "active-verifier" && invocationIndex === 2) {
          outcome = "expected-fail-closed"
        } else {
          outcome = "pass"
        }
        appendEvent(evidenceDir, "invocation-end", {
          lineage,
          invocationIndex,
          exit,
          snapshotPath: snapshot.path,
          snapshotSha256: snapshot.sha256,
          outcome,
          expectedInjection,
          errorNames,
          orderedTermination: false,
        })
        if (lineageUnexpected) break
      }
      appendEvent(evidenceDir, "lineage-end", { lineage, outcome: lineageUnexpected ? "unexpected" : "pass" })
    }
  }
  appendEvent(evidenceDir, "supervisor-end", { lineages: 24, unexpected })
}

test("checkManifest verifies the full chain, independent anchor, grammar, snapshots, and linked resumes", () => {
  const fixture = evidenceFixture()
  try {
    buildManifest(fixture.evidenceDir)
    const result = checkManifest(fixture.evidenceDir)
    expect(result).toEqual({ ok: true, unexpected: 0, problems: [] })
  } finally { fixture.cleanup() }
})

test("the offline checker verifies the chained binding hash and recomputes effective invocation argv", () => {
  const fixture = evidenceFixture()
  try {
    appendEvent(fixture.evidenceDir, "supervisor-start", { budget: { maxVMs: 2, headroomGiB: 20 }, bindingSha256: "0".repeat(64) })
    appendEvent(fixture.evidenceDir, "provision-start", { vm: "vm-c" })
    appendEvent(fixture.evidenceDir, "provision-end", { vm: "vm-c", outcome: "ok", errorKind: null })
    appendEvent(fixture.evidenceDir, "lineage-start", {
      lineage: "success-r1", family: "success", repetition: 1, fixtureID: "fixture-success-r1", fixtureTree: "a".repeat(40),
    })
    appendEvent(fixture.evidenceDir, "invocation-start", {
      lineage: "success-r1", invocationIndex: 1, scenario: "success", parentSessionID: null, argvSha256: "b".repeat(64),
    })
    const result = checkManifest(fixture.evidenceDir)
    expect(result.problems).toContain("supervisor-start does not authenticate the immutable run binding")
    expect(result.problems).toContain("invocation argv hash differs from immutable run binding: success-r1 invocation 1")
  } finally { fixture.cleanup() }
})

test("a hash-matched but malformed/model-abort receipt is unexpected, not an expected injection", () => {
  const fixture = evidenceFixture()
  try {
    buildManifest(fixture.evidenceDir, { unexpectedFamily: "active-verifier" })
    const result = checkManifest(fixture.evidenceDir)
    expect(result.ok).toBe(false)
    expect(result.unexpected).toBe(1)
    expect(result.problems).toEqual([])
  } finally { fixture.cleanup() }
})

test("provision failure is a complete unexpected outcome and cannot be followed by workload events", () => {
  const fixture = evidenceFixture()
  try {
    buildManifest(fixture.evidenceDir, { failedProvision: true })
    const result = checkManifest(fixture.evidenceDir)
    expect(result.ok).toBe(false)
    expect(result.unexpected).toBe(1)
    expect(result.problems).toEqual([])

    const invalid = evidenceFixture()
    try {
      appendEvent(invalid.evidenceDir, "supervisor-start", { budget: { maxVMs: 2, headroomGiB: 20 }, bindingSha256: TEST_BINDING_SHA256 })
      appendEvent(invalid.evidenceDir, "provision-start", { vm: "vm-c" })
      appendEvent(invalid.evidenceDir, "provision-end", { vm: "vm-c", outcome: "failed", errorKind: "exit-nonzero" })
      appendEvent(invalid.evidenceDir, "lineage-start", {
        lineage: "success-r1", family: "success", repetition: 1, fixtureID: "fixture-success-r1", fixtureTree: "a".repeat(40),
      })
      const invalidResult = checkManifest(invalid.evidenceDir)
      expect(invalidResult.problems).toContain("failed provisioning must be followed only by supervisor-end")
    } finally { invalid.cleanup() }
  } finally { fixture.cleanup() }
})

test("a declared missing receipt snapshot is an unexpected outcome rather than an integrity repair", () => {
  const fixture = evidenceFixture()
  try {
    buildManifest(fixture.evidenceDir, { missingSnapshot: true })
    const result = checkManifest(fixture.evidenceDir)
    expect(result.ok).toBe(false)
    expect(result.unexpected).toBe(1)
    expect(result.problems).toEqual([])
  } finally { fixture.cleanup() }
})

test("tail deletion of lineage-start, failed provision-end, or invocation-end is detected", () => {
  const cases = ["lineage-start", "provision-end failed", "invocation-end"] as const
  for (const removed of cases) {
    const fixture = evidenceFixture()
    try {
      appendEvent(fixture.evidenceDir, "supervisor-start", { budget: { maxVMs: 2, headroomGiB: 20 }, bindingSha256: TEST_BINDING_SHA256 })
      appendEvent(fixture.evidenceDir, "provision-start", { vm: "vm-c" })
      if (removed === "provision-end failed") {
        appendEvent(fixture.evidenceDir, "provision-end", { vm: "vm-c", outcome: "failed", errorKind: "exit-nonzero" })
        appendEvent(fixture.evidenceDir, "supervisor-end", { lineages: 0, unexpected: 1 })
      } else {
        appendEvent(fixture.evidenceDir, "provision-end", { vm: "vm-c", outcome: "ok", errorKind: null })
        appendEvent(fixture.evidenceDir, "lineage-start", {
          lineage: "success-r1", family: "success", repetition: 1, fixtureID: "fixture-success-r1", fixtureTree: "a".repeat(40),
        })
        if (removed === "invocation-end") {
          appendEvent(fixture.evidenceDir, "invocation-start", {
            lineage: "success-r1", invocationIndex: 1, scenario: "success", parentSessionID: null, argvSha256: "b".repeat(64),
          })
          appendEvent(fixture.evidenceDir, "invocation-end", {
            lineage: "success-r1", invocationIndex: 1, exit: { code: 0, signal: null },
            snapshotPath: "snapshots/success-r1/1.receipt.json", snapshotSha256: null,
            outcome: "snapshot-missing", expectedInjection: null, errorNames: [], orderedTermination: false,
          })
        }
      }
      const manifestPath = join(fixture.evidenceDir, "soak-manifest.jsonl")
      const lines = readFileSync(manifestPath).toString("utf8").trimEnd().split("\n")
      const keep = removed === "provision-end failed" ? 2 : lines.length - 1
      writeFileSync(manifestPath, `${lines.slice(0, keep).join("\n")}\n`)
      const result = checkManifest(fixture.evidenceDir)
      expect(result.ok).toBe(false)
      expect(result.problems.length).toBeGreaterThan(0)
    } finally { fixture.cleanup() }
  }
})

test("tail deletion is an integrity failure, and a mutable or digest-mismatched snapshot is rejected", () => {
  const deleted = evidenceFixture()
  try {
    buildManifest(deleted.evidenceDir)
    const manifestPath = join(deleted.evidenceDir, "soak-manifest.jsonl")
    const bytes = readFileSync(manifestPath)
    const previousNewline = bytes.lastIndexOf(0x0a, bytes.length - 2)
    writeFileSync(manifestPath, bytes.subarray(0, previousNewline + 1))
    const result = checkManifest(deleted.evidenceDir)
    expect(result.ok).toBe(false)
    expect(result.problems.length).toBeGreaterThan(0)
  } finally { deleted.cleanup() }

  const modified = evidenceFixture()
  try {
    buildManifest(modified.evidenceDir)
    const snapshot = join(modified.evidenceDir, "snapshots", "success-r1", "1.receipt.json")
    chmodSync(snapshot, 0o600)
    const result = checkManifest(modified.evidenceDir)
    expect(result.ok).toBe(false)
    expect(result.problems.some(problem => problem.includes("immutable"))).toBe(true)
  } finally { modified.cleanup() }

  const tampered = evidenceFixture()
  try {
    buildManifest(tampered.evidenceDir)
    const snapshot = join(tampered.evidenceDir, "snapshots", "success-r1", "1.receipt.json")
    chmodSync(snapshot, 0o600)
    const contents = readFileSync(snapshot, "utf8").replace('"done":1', '"done":9')
    writeFileSync(snapshot, contents)
    chmodSync(snapshot, 0o400)
    const result = checkManifest(tampered.evidenceDir)
    expect(result.ok).toBe(false)
    expect(result.problems.some(problem => problem.includes("digest mismatch"))).toBe(true)
  } finally { tampered.cleanup() }
})

test("deleting a referenced snapshot is an integrity failure and a declared missing snapshot is unexpected", () => {
  const fixture = evidenceFixture()
  try {
    buildManifest(fixture.evidenceDir)
    const snapshot = join(fixture.evidenceDir, "snapshots", "success-r1", "1.receipt.json")
    rmSync(snapshot)
    const result = checkManifest(fixture.evidenceDir)
    expect(result.ok).toBe(false)
    expect(result.problems.some(problem => problem.includes("snapshot"))).toBe(true)
  } finally { fixture.cleanup() }
})
