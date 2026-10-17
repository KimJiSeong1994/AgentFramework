import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendModelAbort,
  assertReceiptSchemaForResume,
  assertResumeVerifierIdentity,
  assertScenarioVerifierMode,
  mainGitState,
  modelAbortPreservation,
  parseVerifierMode,
  preserveVerifierCancellationFailure,
  queueLifecycleWaitMs,
  selectVerifierRuntime,
  verificationProfileForMode,
  type Receipt,
} from "../../scripts/otter-live-core-queue.ts"
import { DEFAULT_CONFIG, type OtterConfig } from "../src/config.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import type { VerificationReference, VerificationReconciliation } from "../src/orchestration/verifier.ts"

test("live driver maps legacy, qualification, and production profiles", () => {
  expect(parseVerifierMode(undefined)).toBe("legacy")
  expect(parseVerifierMode("legacy")).toBe("legacy")
  expect(parseVerifierMode("linux-qualification")).toBe("linux-qualification")
  expect(parseVerifierMode("linux-production")).toBe("linux-production")
  expect(verificationProfileForMode("legacy")).toBe("legacy-unowned")
  expect(verificationProfileForMode("linux-qualification")).toBe("linux-single-use")
  expect(verificationProfileForMode("linux-production")).toBe("linux-single-use")
  expect(() => parseVerifierMode("unknown")).toThrow(/--verifier must be legacy, linux-qualification, or linux-production/)
})

test("new live native scenarios cannot fall back to the legacy verifier", () => {
  for (const scenario of ["success", "verifier-cancel", "active-verifier"] as const) {
    expect(() => assertScenarioVerifierMode(scenario, "legacy")).toThrow(/requires --verifier linux-qualification or linux-production/)
    expect(() => assertScenarioVerifierMode(scenario, "linux-qualification")).not.toThrow()
    expect(() => assertScenarioVerifierMode(scenario, "linux-production")).not.toThrow()
  }
  expect(() => assertScenarioVerifierMode("retry", "legacy")).not.toThrow()
})

function withVerifierRuntime(selector: OtterConfig["delegate"]["verifier"], check: (config: OtterConfig, runtime: ReturnType<typeof getOpenCodeRuntime>) => void): void {
  const stateHome = mkdtempSync(join(tmpdir(), "otter-live-driver-runtime-state-"))
  const worktree = mkdtempSync(join(tmpdir(), "otter-live-driver-runtime-worktree-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  const previousOtterStateHome = process.env.OTTER_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  delete process.env.OTTER_STATE_HOME
  try {
    const config: OtterConfig = {
      ...DEFAULT_CONFIG,
      delegate: { ...DEFAULT_CONFIG.delegate, verifier: selector },
    }
    const deps = { client: {} as any, directory: worktree, worktree, config, log() {} }
    check(config, getOpenCodeRuntime(deps))
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    if (previousOtterStateHome === undefined) delete process.env.OTTER_STATE_HOME
    else process.env.OTTER_STATE_HOME = previousOtterStateHome
    rmSync(stateHome, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  }
}

test("linux-production keeps the ordinary linux runtime and refuses a legacy-selected fallback", () => {
  withVerifierRuntime("linux-single-use", (config, ordinaryRuntime) => {
    expect(ordinaryRuntime.verificationProfile).toBe("linux-single-use")
    expect(ordinaryRuntime.linuxAdmission).toBeDefined()
    expect(selectVerifierRuntime(config, ordinaryRuntime, "linux-production")).toBe(ordinaryRuntime)
  })
  withVerifierRuntime("legacy-unowned", (config, ordinaryRuntime) => {
    expect(() => selectVerifierRuntime(config, ordinaryRuntime, "linux-production"))
      .toThrow(/requires fixture config delegate\.verifier=linux-single-use/)
    expect(ordinaryRuntime.verificationProfile).toBe("legacy-unowned")
  })
})

test("linux-qualification lab runtime retains its qualification admission guard", () => {
  withVerifierRuntime("legacy-unowned", (config, ordinaryRuntime) => {
    const labRuntime = selectVerifierRuntime(config, ordinaryRuntime, "linux-qualification")
    expect(labRuntime).not.toBe(ordinaryRuntime)
    expect(labRuntime.verificationProfile).toBe("linux-single-use")
    expect(labRuntime.linuxAdmission).toBeDefined()
  })
})

test("resume requires an exact verifier identity and refuses missing or mismatched receipts", () => {
  expect(() => assertResumeVerifierIdentity("linux-qualification", "linux-qualification")).not.toThrow()
  expect(() => assertResumeVerifierIdentity("linux-production", "linux-production")).not.toThrow()
  expect(() => assertResumeVerifierIdentity("legacy", "linux-qualification")).toThrow(/missing or has a mismatched verifier identity/)
  expect(() => assertResumeVerifierIdentity(undefined, "legacy")).toThrow(/missing or has a mismatched verifier identity/)
})

test("resume refuses schema-1 receipts rather than inventing an empty abort history", () => {
  expect(() => assertReceiptSchemaForResume(1, undefined)).toThrow(/schema-1 receipts are not upgraded/)
  expect(() => assertReceiptSchemaForResume(2, undefined)).toThrow(/schema-2 resume receipt is missing modelAborts/)
  expect(() => assertReceiptSchemaForResume(2, [])).not.toThrow()
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
  const worktree = mkdtempSync(join(tmpdir(), "otter-live-core-git-evidence-"))
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
  const worktree = mkdtempSync(join(tmpdir(), "otter-live-core-untracked-evidence-"))
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
  const worktree = mkdtempSync(join(tmpdir(), "otter-live-core-untracked-symlink-"))
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

test("model abort capture is exact, bounded, retains failed-attempt lineage, and protects the main worktree", () => {
  const worktree = mkdtempSync(join(tmpdir(), "otter-live-model-abort-"))
  const receipt = cancellationReceipt()
  const earlierFailure = { at: new Date(0).toISOString(), phase: "attempt 1", name: "Error", message: "verification failed" }
  receipt.failures.push(earlierFailure)
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: worktree })
    execFileSync("git", ["config", "user.name", "Live model abort test"], { cwd: worktree })
    execFileSync("git", ["config", "user.email", "live-model-abort@localhost"], { cwd: worktree })
    writeFileSync(join(worktree, "tracked.py"), "value = 0\n")
    execFileSync("git", ["add", "tracked.py"], { cwd: worktree })
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture"], { cwd: worktree })

    const protectedMain = mainGitState(worktree)
    const ledgerBefore = { sha256: "a".repeat(64), size: 20 }
    const preservation = modelAbortPreservation(
      { mainGitState: protectedMain, ledger: ledgerBefore },
      { mainGitState: mainGitState(worktree), ledger: { ...ledgerBefore } },
    )
    expect(preservation).toEqual({ merged: false, ledgerPreserved: true })

    const observation = {
      scenario: "resume" as const,
      lineage: [
        { executionID: "worker-attempt-1", attemptID: "attempt-1", kind: "host", role: "worker", outcome: "failed" },
        { executionID: "worker-attempt-2", attemptID: "attempt-2", kind: "host", role: "worker" },
      ],
      taskID: "t2",
      attempt: 2,
      phase: "resume existing queue ledger",
      ...preservation,
    }
    const textOnlyMatch = { errorName: "APIError", error: "MessageAbortedError" }
    expect(appendModelAbort(receipt, textOnlyMatch.errorName, { ...observation, merged: true, ledgerPreserved: false })).toBe(false)
    expect(appendModelAbort(receipt, "MessageAbortedError", observation)).toBe(true)
    expect(receipt.modelAborts).toEqual([{ errorName: "MessageAbortedError", ...observation }])
    expect(receipt.modelAborts[0]?.lineage[0]).toMatchObject({ executionID: "worker-attempt-1", outcome: "failed" })
    expect(receipt.modelAborts[0]).toMatchObject({ attempt: 2, merged: false, ledgerPreserved: true })
    expect(receipt.failures).toEqual([earlierFailure])
    expect(JSON.stringify(receipt.modelAborts)).not.toContain("cause")
    expect(JSON.stringify(receipt.modelAborts)).not.toContain("verification failed")

    writeFileSync(join(worktree, "tracked.py"), "value = 1\n")
    expect(modelAbortPreservation(
      { mainGitState: protectedMain, ledger: ledgerBefore },
      { mainGitState: mainGitState(worktree), ledger: { ...ledgerBefore, size: 21 } },
    )).toEqual({ merged: true, ledgerPreserved: false })
  } finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})

function cancellationReceipt(): Receipt {
  return {
    schemaVersion: 2,
    receiptPath: "/tmp/cancel-cleanup-receipt.json",
    scenario: "verifier-cancel",
    baseIdentity: {
      worktree: "/tmp/worktree",
      gitRoot: "/tmp/worktree",
      serverOrigin: "http://127.0.0.1:1234",
      script: "otter-live-core-queue.ts",
      processID: 123,
      platform: "linux",
      architecture: "x64",
      startedAt: new Date(0).toISOString(),
      verifier: "linux-qualification",
    },
    nativeSessionIDs: { parentSessionID: "session-1", childSessionIDs: [] },
    runs: [],
    modelAborts: [],
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
  unit: "otter-verifier.service",
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
