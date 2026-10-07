import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertResumeVerifierIdentity,
  assertScenarioVerifierMode,
  mainGitState,
  parseVerifierMode,
  preserveVerifierCancellationFailure,
  queueLifecycleWaitMs,
  verificationProfileForMode,
  type Receipt,
} from "../../scripts/lca-live-core-queue.ts"
import type { VerificationReference, VerificationReconciliation } from "../src/orchestration/verifier.ts"

test("live driver defaults to the legacy verifier and maps explicit profiles", () => {
  expect(parseVerifierMode(undefined)).toBe("legacy")
  expect(parseVerifierMode("legacy")).toBe("legacy")
  expect(parseVerifierMode("linux-qualification")).toBe("linux-qualification")
  expect(verificationProfileForMode("legacy")).toBe("legacy-unowned")
  expect(verificationProfileForMode("linux-qualification")).toBe("linux-single-use")
  expect(() => parseVerifierMode("unknown")).toThrow(/--verifier must be legacy or linux-qualification/)
})

test("new live native scenarios cannot fall back to the legacy verifier", () => {
  for (const scenario of ["success", "verifier-cancel", "active-verifier"] as const) {
    expect(() => assertScenarioVerifierMode(scenario, "legacy")).toThrow(/requires --verifier linux-qualification/)
    expect(() => assertScenarioVerifierMode(scenario, "linux-qualification")).not.toThrow()
  }
  expect(() => assertScenarioVerifierMode("retry", "legacy")).not.toThrow()
})

test("resume requires an exact verifier identity and refuses missing or mismatched receipts", () => {
  expect(() => assertResumeVerifierIdentity("linux-qualification", "linux-qualification")).not.toThrow()
  expect(() => assertResumeVerifierIdentity("legacy", "linux-qualification")).toThrow(/missing or has a mismatched verifier identity/)
  expect(() => assertResumeVerifierIdentity(undefined, "legacy")).toThrow(/missing or has a mismatched verifier identity/)
})

test("live qualification waits cover configured queue and task lifecycles beyond two minutes", () => {
  expect(queueLifecycleWaitMs({
    queue_ttl_ms: 600_000,
    task_ttl_ms: 180_000,
    review_ttl_ms: 120_000,
    verify_timeout_ms: 45_000,
  })).toBe(955_000)
  expect(() => queueLifecycleWaitMs({
    queue_ttl_ms: Number.POSITIVE_INFINITY,
    task_ttl_ms: 180_000,
    review_ttl_ms: 120_000,
    verify_timeout_ms: 45_000,
  })).toThrow(/finite positive/)
})

test("main worktree evidence changes when tracked bytes change under the same modified status", () => {
  const worktree = mkdtempSync(join(tmpdir(), "lca-live-core-git-evidence-"))
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: worktree })
    execFileSync("git", ["config", "user.name", "Live core evidence test"], { cwd: worktree })
    execFileSync("git", ["config", "user.email", "live-core-evidence@localhost"], { cwd: worktree })
    writeFileSync(join(worktree, "tracked.py"), "value = 0\n")
    execFileSync("git", ["add", "tracked.py"], { cwd: worktree })
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture"], { cwd: worktree })
    writeFileSync(join(worktree, "tracked.py"), "value = 1\n")
    const first = mainGitState(worktree)
    writeFileSync(join(worktree, "tracked.py"), "value = 2\n")
    const second = mainGitState(worktree)
    expect(first.head).toBe(second.head)
    expect(first.status).toBe(second.status)
    expect(first.statusBytes).toEqual(second.statusBytes)
    expect(first.trackedDiff.sha256).not.toBe(second.trackedDiff.sha256)
    expect(first.trackedDiff.size).toBe(second.trackedDiff.size)
  } finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})

test("main worktree evidence hashes raw untracked names, bytes, and modes", () => {
  const worktree = mkdtempSync(join(tmpdir(), "lca-live-core-untracked-evidence-"))
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: worktree })
    execFileSync("git", ["config", "user.name", "Live core evidence test"], { cwd: worktree })
    execFileSync("git", ["config", "user.email", "live-core-evidence@localhost"], { cwd: worktree })
    writeFileSync(join(worktree, "tracked.py"), "value = 0\n")
    execFileSync("git", ["add", "tracked.py"], { cwd: worktree })
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture"], { cwd: worktree })

    const newlinePath = join(worktree, "untracked\nname.bin")
    writeFileSync(newlinePath, "AAAA")
    chmodSync(newlinePath, 0o600)
    // APFS refuses non-UTF8 names with EILSEQ; the Linux run exercises that byte-level case.
    const rawName = process.platform === "darwin" ? Buffer.from("é.bin") : Buffer.from([0x80, 0x2e, 0x62, 0x69, 0x6e])
    const rawNamePath = Buffer.concat([Buffer.from(worktree + "/"), rawName])
    writeFileSync(rawNamePath, "RAW!")
    const first = mainGitState(worktree)
    writeFileSync(newlinePath, "BBBB")
    const second = mainGitState(worktree)
    expect(second.status).toEqual(first.status)
    expect(second.statusBytes).toEqual(first.statusBytes)
    expect(second.untracked.count).toBe(2)
    expect(second.untracked.sha256).not.toBe(first.untracked.sha256)

    chmodSync(newlinePath, 0o644)
    const third = mainGitState(worktree)
    expect(third.status).toEqual(second.status)
    expect(third.statusBytes).toEqual(second.statusBytes)
    expect(third.untracked.sha256).not.toBe(second.untracked.sha256)

    chmodSync(newlinePath, 0o1644)
    const specialMode = mainGitState(worktree)
    expect(specialMode.statusBytes).toEqual(third.statusBytes)
    expect(specialMode.untracked.sha256).not.toBe(third.untracked.sha256)

    unlinkSync(rawNamePath)
    writeFileSync(join(worktree, "�.bin"), "RAW!")
    const replacementCharacterName = mainGitState(worktree)
    expect(replacementCharacterName.untracked.sha256).not.toBe(specialMode.untracked.sha256)
  } finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})

test("main worktree evidence refuses untracked symlinks instead of following them", () => {
  const worktree = mkdtempSync(join(tmpdir(), "lca-live-core-untracked-symlink-"))
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: worktree })
    execFileSync("git", ["config", "user.name", "Live core evidence test"], { cwd: worktree })
    execFileSync("git", ["config", "user.email", "live-core-evidence@localhost"], { cwd: worktree })
    writeFileSync(join(worktree, "tracked.py"), "value = 0\n")
    execFileSync("git", ["add", "tracked.py"], { cwd: worktree })
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture"], { cwd: worktree })
    symlinkSync("tracked.py", join(worktree, "untracked-link"))
    expect(() => mainGitState(worktree)).toThrow(/unsupported untracked entry/)
  } finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})

function cancellationReceipt(): Receipt {
  return {
    schemaVersion: 1,
    receiptPath: "/tmp/cancel-cleanup-receipt.json",
    scenario: "verifier-cancel",
    baseIdentity: {
      worktree: "/tmp/worktree",
      gitRoot: "/tmp/worktree",
      serverOrigin: "http://127.0.0.1:1234",
      script: "lca-live-core-queue.ts",
      processID: 123,
      platform: "linux",
      architecture: "x64",
      startedAt: new Date(0).toISOString(),
      verifier: "linux-qualification",
    },
    nativeSessionIDs: { parentSessionID: "session-1", childSessionIDs: [] },
    runs: [],
    failures: [],
  }
}

const verifierReference: VerificationReference = {
  kind: "verifier",
  executionID: "execution-cancel-1",
  profile: "linux-single-use",
  invocationID: "a".repeat(32),
  inputSnapshotID: "b".repeat(40),
  inputDigest: "c".repeat(64),
  deadlineAt: Date.now() + 60_000,
  maxOutputChars: 1024,
  unit: "lca-verifier.service",
  bootID: "11111111-1111-4111-8111-111111111111",
}

async function runCancellationCleanupFailure(options: {
  originalError: unknown
  abortQueue?: () => Promise<unknown>
  queuePromise?: Promise<unknown>
  reconcile?: () => Promise<VerificationReconciliation>
  timeoutMs?: number
  onPersist?: () => void
}) {
  const receipt = cancellationReceipt()
  const run: Record<string, unknown> = {}
  const events: string[] = []
  const persisted: unknown[] = []
  const persistedCleanup: unknown[] = []
  const promise = preserveVerifierCancellationFailure({
    receipt,
    run,
    originalError: options.originalError,
    reference: verifierReference,
    deadlineAt: Date.now() + (options.timeoutMs ?? 100),
    abortQueue: options.abortQueue ?? (async () => { events.push("abort"); return undefined }),
    queuePromise: options.queuePromise ?? Promise.resolve(undefined),
    reconcile: options.reconcile ?? (async () => ({ outcome: "unknown", isolationEstablished: false, domainState: "unknown", integrity: "unknown" })),
    persist() {
      events.push("persist")
      options.onPersist?.()
      persisted.push(JSON.parse(JSON.stringify(run.verifierCancelBoundary)))
      persistedCleanup.push(JSON.parse(JSON.stringify(run.verifierCancellationCleanup)))
    },
  })
  try {
    await promise
    throw new Error("cleanup handler unexpectedly resolved")
  } catch (error) {
    expect(error).toBe(options.originalError)
  }
  return { receipt, run, events, persisted, persistedCleanup }
}

test("verifier cancellation persists its exact reference before cleanup and preserves the original error", async () => {
  const originalError = new Error("original verifier-cancel failure")
  const abortError = new Error("queue abort failed")
  let receiptPersisted = false
  const observed = await runCancellationCleanupFailure({
    originalError,
    abortQueue: async () => {
      expect(receiptPersisted).toBe(true)
      throw abortError
    },
    reconcile: async () => ({ outcome: "unknown", isolationEstablished: false, domainState: "unknown", integrity: "unknown" }),
    onPersist: () => { receiptPersisted = true },
  })
  expect(observed.events[0]).toBe("persist")
  expect(observed.persisted[0]).toMatchObject({ boundaryRef: verifierReference })
  expect(observed.persisted[0]).toMatchObject({ nativeRetirement: { status: "unresolved" } })
  expect(observed.persistedCleanup[0]).toMatchObject({
    originalException: { message: originalError.message },
    nativeRetirement: { status: "unresolved" },
    steps: { initialReceiptPersistence: { status: "persisted" } },
  })
  const cleanup = observed.run.verifierCancellationCleanup as Record<string, any>
  expect(cleanup.originalException).toEqual({ name: "Error", message: originalError.message })
  expect(cleanup.steps.queueAbort).toMatchObject({ status: "rejected", error: { message: abortError.message } })
  expect(cleanup.nativeRetirement.status).toBe("unresolved")
  expect(cleanup.steps.finalReceiptPersistence.status).toBe("persisted")
  expect(observed.persistedCleanup.at(-1)).toMatchObject({
    steps: { queueAbort: { status: "rejected" }, finalReceiptPersistence: { status: "persisted" } },
  })
})

test("verifier cancellation records a rejected queue and refuses unsigned terminal evidence", async () => {
  const queueError = new Error("queue promise rejected")
  const unsignedTerminal: VerificationReconciliation = {
    outcome: "terminal",
    isolationEstablished: true,
    domainState: "empty",
    integrity: "unchanged",
    result: {
      profile: "linux-single-use",
      parentExit: 0,
      timedOut: false,
      cancelled: true,
      isolationEstablished: true,
      domainState: "empty",
      integrity: "unchanged",
      output: "not authenticated",
    },
  }
  const observed = await runCancellationCleanupFailure({
    originalError: new Error("cancellation path failed"),
    queuePromise: Promise.reject(queueError),
    reconcile: async () => unsignedTerminal,
  })
  const cleanup = observed.run.verifierCancellationCleanup as Record<string, any>
  expect(cleanup.steps.queueSettlement).toMatchObject({ status: "rejected", error: { message: queueError.message } })
  expect(cleanup.nativeRetirement).toMatchObject({ status: "unresolved", lastOutcome: "terminal-without-authenticated-result" })
})

test("verifier cancellation returns within its deadline when abort, queue settlement, and native inspection hang", async () => {
  const never = new Promise<never>(() => {})
  const startedAt = Date.now()
  const observed = await runCancellationCleanupFailure({
    originalError: new Error("stuck cancellation"),
    abortQueue: () => never,
    queuePromise: never,
    reconcile: () => never,
    timeoutMs: 35,
  })
  expect(Date.now() - startedAt).toBeLessThan(500)
  const cleanup = observed.run.verifierCancellationCleanup as Record<string, any>
  expect(cleanup.steps.initialReceiptPersistence.status).toBe("persisted")
  expect(cleanup.steps.queueAbort.status).toBe("timed_out")
  expect(cleanup.steps.queueSettlement.status).toBe("not_started")
  expect(cleanup.nativeRetirement.status).toBe("unresolved")
  expect(cleanup.steps.finalReceiptPersistence.status).toBe("persisted")
})

test("verifier cancellation bounds a native reconciliation call that never settles", async () => {
  let inspectionCalls = 0
  const startedAt = Date.now()
  const observed = await runCancellationCleanupFailure({
    originalError: new Error("native retirement remains unknown"),
    reconcile: () => {
      inspectionCalls++
      return new Promise<VerificationReconciliation>(() => {})
    },
    timeoutMs: 35,
  })
  expect(inspectionCalls).toBe(1)
  expect(Date.now() - startedAt).toBeLessThan(500)
  const cleanup = observed.run.verifierCancellationCleanup as Record<string, any>
  expect(cleanup.nativeRetirement.status).toBe("unresolved")
  expect(cleanup.steps.finalReceiptPersistence.status).toBe("persisted")
})

test("verifier cancellation records failed native inspection without claiming retirement", async () => {
  const inspectionError = new Error("native inspection unavailable")
  const observed = await runCancellationCleanupFailure({
    originalError: new Error("cancel failed"),
    reconcile: async () => { throw inspectionError },
  })
  const cleanup = observed.run.verifierCancellationCleanup as Record<string, any>
  expect(cleanup.nativeRetirement).toMatchObject({
    status: "unresolved",
    error: { name: "Error", message: inspectionError.message },
  })
})
