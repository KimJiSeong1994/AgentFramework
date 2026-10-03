import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync, closeSync, existsSync, ftruncateSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  applySkillOptPromotion, preflightSkillOptPromotion, recordLoadVerification, recordRollbackLoadVerification,
  recoverSkillOptPromotion, rollbackSkillOptPromotion, type ApplySkillOptPromotionInput, type PromotionBindings,
  type PromotionEvidence, type PromotionLoadWitness, type PromotionRecordRef, PromotionError,
} from "../src/skillopt/promotion.ts"

let ownedHelperRoot: string | undefined
let ownedBarrierHelperRoot: string | undefined
let nativeHelperPath = ""
let nativeHelperSha256 = ""
let barrierHelperPath = ""
let barrierHelperSha256 = ""
const nativeTest: typeof test = process.platform === "darwin" ? test : test.skip
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex")
const roots: string[] = []
const ownedHeldHelpers = new Set<number>()
const ORIGINAL = Buffer.from("# original skill\n\nProtected instructions stay byte-identical.\n")
const CANDIDATE = Buffer.from("# original skill\n\nProtected instructions stay byte-identical.\n\nSupplemental reading paragraph.\n")
const THIRD = Buffer.from("# concurrent owner edit\n")
const mode = 0o640

beforeAll(() => {
  if (process.platform !== "darwin") return
  const override = process.env.SKILLOPT_DARWIN_HELPER
  if (override) {
    nativeHelperPath = resolve(override)
  } else {
    ownedHelperRoot = realpathSync(mkdtempSync(join(tmpdir(), "skillopt-darwin-helper-")))
    chmodSync(ownedHelperRoot, 0o700)
    nativeHelperPath = join(ownedHelperRoot, "skillopt-darwin")
    const sourcePath = resolve(import.meta.dir, "../../scripts/skillopt-darwin.c")
    execFileSync("clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", sourcePath, "-o", nativeHelperPath], { stdio: "pipe" })
  }
  nativeHelperSha256 = createHash("sha256").update(readFileSync(nativeHelperPath)).digest("hex")
  ownedBarrierHelperRoot = realpathSync(mkdtempSync(join(tmpdir(), "skillopt-darwin-test-helper-")))
  chmodSync(ownedBarrierHelperRoot, 0o700)
  barrierHelperPath = join(ownedBarrierHelperRoot, "skillopt-darwin-test-faults")
  const sourcePath = resolve(import.meta.dir, "../../scripts/skillopt-darwin.c")
  execFileSync("clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-DSKILLOPT_TEST_FAULTS=1", sourcePath, "-o", barrierHelperPath], { stdio: "pipe" })
  barrierHelperSha256 = createHash("sha256").update(readFileSync(barrierHelperPath)).digest("hex")
})

afterAll(() => {
  if (ownedHelperRoot) rmSync(ownedHelperRoot, { recursive: true, force: true })
  if (ownedBarrierHelperRoot) rmSync(ownedBarrierHelperRoot, { recursive: true, force: true })
})

afterEach(async () => {
  for (const pid of ownedHeldHelpers) {
    try { process.kill(pid, "SIGTERM") } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  ownedHeldHelpers.clear()
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Sandbox = { root: string; transactionRoot: string }
type Fixture = {
  sandbox: Sandbox
  runId: string
  projectRoot: string
  targetDirectory: string
  targetPath: string
  evidenceDirectory: string
  bindings: PromotionBindings
  evidence: PromotionEvidence
  candidateBytes: Buffer
  apply: (extra?: Partial<ApplySkillOptPromotionInput>) => ApplySkillOptPromotionInput
  verifyEvidence: () => Promise<void>
  writeWitness: (expectedFileSha256?: string) => PromotionRecordRef
  verifyWitness: (bytes: Uint8Array, bindings: PromotionBindings, expectedFileSha256: string) => Promise<void>
}

function makeSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillopt-promotion-")))
  roots.push(root)
  const transactionRoot = join(root, "transactions")
  mkdirSync(transactionRoot, { mode: 0o700 })
  chmodSync(transactionRoot, 0o700)
  return { root, transactionRoot }
}

function writeRecord(path: string, value: unknown): PromotionRecordRef {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error("test record is not JSON serializable")
  const bytes = Buffer.from(serialized, "utf8")
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" })
  chmodSync(path, 0o600)
  return { path: resolve(path), sha256: hash(bytes) }
}

function makeFixture(sandbox = makeSandbox(), options: { runId?: string; approvalId?: string; targetBytes?: Buffer } = {}): Fixture {
  const runId = options.runId ?? `run-${randomUUID().replaceAll("-", "")}`
  const projectRoot = join(sandbox.root, `project-${runId}`)
  const targetDirectory = join(projectRoot, ".agents", "skills", "llm-wiki")
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 })
  for (const directory of [projectRoot, join(projectRoot, ".agents"), join(projectRoot, ".agents", "skills"), targetDirectory]) {
    chmodSync(directory, 0o700)
  }
  const targetPath = join(targetDirectory, "SKILL.md")
  const original = options.targetBytes ?? ORIGINAL
  writeFileSync(targetPath, original)
  chmodSync(targetPath, mode)

  const evidenceDirectory = join(sandbox.root, `records-${runId}`)
  mkdirSync(evidenceDirectory, { mode: 0o700 })
  chmodSync(evidenceDirectory, 0o700)
  const candidateBytes = Buffer.from(CANDIDATE)
  const bindings: PromotionBindings = {
    runId,
    rootBinding: hash(`root:${sandbox.root}`),
    sourceSha256: hash("source-snapshot"),
    originalSha256: hash(original),
    candidateSha256: hash(candidateBytes),
    protocolSha256: hash("protocol"),
    evaluatorSha256: hash("independent-evaluator"),
    runtimeSha256: hash("pinned-runtime"),
    resultsSha256: hash("qualified-results"),
    witnessSha256: hash("pre-apply-witness"),
  }
  const qualification = writeRecord(join(evidenceDirectory, "qualification.json"), {
    schemaVersion: 1, bindings, decision: "qualified", reasons: [],
  })
  const review = writeRecord(join(evidenceDirectory, "review.json"), {
    schemaVersion: 1, bindings, qualificationSha256: qualification.sha256,
    reviewerId: "independent-reviewer-1", verdict: "approve",
  })
  const approval = writeRecord(join(evidenceDirectory, "approval.json"), {
    schemaVersion: 1, bindings, qualificationSha256: qualification.sha256, reviewSha256: review.sha256,
    approvalId: options.approvalId ?? `approval-${randomUUID().replaceAll("-", "")}`,
    observedAt: Date.now(), action: "approve-production-apply",
  })
  const evidence: PromotionEvidence = { qualification, review, approval }
  const verifyEvidence = async () => {
    for (const ref of [qualification, review, approval]) {
      if (hash(readFileSync(ref.path)) !== ref.sha256) throw new Error("stored evidence changed")
    }
  }
  const common = {
    targetPath,
    transactionRoot: sandbox.transactionRoot,
    nativeHelperPath,
    nativeHelperSha256,
    bindings,
  }
  const apply = (extra: Partial<ApplySkillOptPromotionInput> = {}): ApplySkillOptPromotionInput => ({
    ...common,
    candidateBytes,
    evidence,
    verifyEvidence,
    ...extra,
  })
  const writeWitness = (expectedFileSha256 = bindings.candidateSha256): PromotionRecordRef => {
    const witness: PromotionLoadWitness = {
      schema: "skillopt.live-skill-witness.v1",
      experimentId: bindings.runId,
      rootBinding: bindings.rootBinding,
      runtimeSha256: bindings.runtimeSha256,
      observedAt: Date.now(),
      hostVersion: "1.18.33",
      executableSha256: hash("opencode-executable"),
      pluginSha256: hash("plugin-tree"),
      sdkSha256: hash("sdk-tree"),
      configSha256: hash("isolated-config"),
      sessionId: "session_1",
      messageId: "message_1",
      parentMessageId: "user_1",
      callId: "call_1",
      skillName: "llm-wiki",
      targetRelativePath: ".agents/skills/llm-wiki/SKILL.md",
      stagedFileSha256Before: expectedFileSha256,
      stagedFileSha256After: expectedFileSha256,
      expectedBodySha256: hash(`body:${expectedFileSha256}`),
      returnedBodySha256: hash(`body:${expectedFileSha256}`),
      returnedPayloadSha256: hash("returned-payload"),
      parserVersion: "opencode-1.18.33.skill-output.v1",
      hashBases: {
        stagedFile: "staged-file-utf8.v1",
        expectedBody: "expected-host-body-1.18.33.v1",
        returnedBody: "observed-returned-body-1.18.33.v1",
        returnedPayload: "returned-payload-utf8.v1",
      },
      loadedOriginalFileSha256: null,
      originalLoadedByteAttestation: false,
    }
    return writeRecord(join(evidenceDirectory, `witness-${randomUUID()}.json`), witness)
  }
  const verifyWitness = async (bytes: Uint8Array, expectedBindings: PromotionBindings, expectedFileSha256: string) => {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as PromotionLoadWitness
    if (value.experimentId !== expectedBindings.runId || value.rootBinding !== expectedBindings.rootBinding ||
        value.runtimeSha256 !== expectedBindings.runtimeSha256 || value.stagedFileSha256Before !== expectedFileSha256 ||
        value.stagedFileSha256After !== expectedFileSha256 || value.expectedBodySha256 !== value.returnedBodySha256 ||
        value.loadedOriginalFileSha256 !== null || value.originalLoadedByteAttestation !== false) {
      throw new Error("test host witness binding mismatch")
    }
  }
  return {
    sandbox, runId, projectRoot, targetDirectory, targetPath, evidenceDirectory, bindings, evidence, candidateBytes,
    apply, verifyEvidence, writeWitness, verifyWitness,
  }
}

function readJournal(fixture: Fixture): Array<Record<string, any>> {
  const path = join(fixture.sandbox.transactionRoot, fixture.runId, "journal.jsonl")
  return readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))
}

function getJournalStage(fixture: Fixture, state: string): string {
  const record = readJournal(fixture).findLast((item) => item.state === state)
  if (typeof record?.details.stageName !== "string") throw new Error(`missing ${state} stage name`)
  return record.details.stageName
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength)
  expect(Array.from(actual)).toEqual(Array.from(expected))
}

async function runWithNativeBarrier<T>(fixture: Fixture, boundary: string, mutateAtBarrier: () => void,
  start: () => Promise<T>): Promise<T> {
  const barrierDirectory = join(fixture.sandbox.root, `native-barrier-${boundary}`)
  mkdirSync(barrierDirectory, { mode: 0o700 })
  chmodSync(barrierDirectory, 0o700)
  const readyPath = join(barrierDirectory, `${boundary}.ready`)
  const releasePath = join(barrierDirectory, `${boundary}.release`)
  for (const other of ["before-swap", "post-open"]) {
    if (other !== boundary) writeFileSync(join(barrierDirectory, `${other}.release`), "release\n", { mode: 0o600, flag: "wx" })
  }
  const previous = process.env.SKILLOPT_TEST_BARRIERS
  process.env.SKILLOPT_TEST_BARRIERS = barrierDirectory
  const operation = start()
  void operation.catch(() => undefined)
  try {
    const deadline = Date.now() + 3_000
    while (!existsSync(readyPath) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
    if (!existsSync(readyPath)) throw new Error(`native helper did not reach ${boundary}`)
    mutateAtBarrier()
    writeFileSync(releasePath, "release\n", { mode: 0o600, flag: "wx" })
    return await operation
  } finally {
    if (existsSync(barrierDirectory) && !existsSync(releasePath)) writeFileSync(releasePath, "release\n", { mode: 0o600, flag: "wx" })
    if (previous === undefined) delete process.env.SKILLOPT_TEST_BARRIERS
    else process.env.SKILLOPT_TEST_BARRIERS = previous
  }
}

async function promoteAndCommit(fixture: Fixture): Promise<PromotionRecordRef> {
  const applied = await applySkillOptPromotion(fixture.apply())
  expect(applied.state).toBe("SWAPPED_EXPECTED")
  const witness = fixture.writeWitness()
  const committed = await recordLoadVerification({
    targetPath: fixture.targetPath,
    transactionRoot: fixture.sandbox.transactionRoot,
    nativeHelperPath,
    nativeHelperSha256,
    bindings: fixture.bindings,
    witness,
    verifyWitness: fixture.verifyWitness,
  })
  expect(committed.state).toBe("COMMITTED")
  return witness
}

function crashAt(point: string) {
  return (observed: string) => { if (observed === point) throw new Error(`injected crash: ${point}`) }
}

async function expectPromotionError(action: () => Promise<unknown>, code?: string): Promise<void> {
  let caught: unknown
  try { await action() } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(PromotionError)
  if (code) expect((caught as PromotionError).code).toBe(code)
}

async function expectInjectedCrash(action: () => Promise<unknown>, point: string): Promise<void> {
  let caught: unknown
  try { await action() } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toBe(`injected crash: ${point}`)
}

describe("SkillOpt one-file promotion transaction", () => {
  nativeTest("scratch preflight probes Darwin exchange, directory fsync, and F_FULLFSYNC", () => {
    const sandbox = makeSandbox()
    const targetDirectory = join(sandbox.root, "scratch-target")
    mkdirSync(targetDirectory, { mode: 0o700 })
    chmodSync(targetDirectory, 0o700)
    const result = preflightSkillOptPromotion({
      targetDirectory, transactionRoot: sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
    })
    expect(result).toEqual({ protocol: "skillopt-darwin.v2", probedDirectories: 2 })
  })

  nativeTest("durably exchanges exact bytes/mode, retains backup and displaced inode, and commits only after fresh witness", async () => {
    const fixture = makeFixture()
    const applied = await applySkillOptPromotion(fixture.apply())
    expect(applied).toEqual({ state: "SWAPPED_EXPECTED", idempotent: false, raceMayHavePublishedCandidate: true })
    expectBytesEqual(readFileSync(fixture.targetPath), fixture.candidateBytes)
    expect(lstatSync(fixture.targetPath).mode & 0o777).toBe(mode)
    const stageName = getJournalStage(fixture, "SWAP_INTENT")
    expect(readFileSync(join(fixture.targetDirectory, stageName))).toEqual(ORIGINAL)
    const backupPath = join(fixture.sandbox.transactionRoot, fixture.runId, "original.bin")
    expect(readFileSync(backupPath)).toEqual(ORIGINAL)
    expect(lstatSync(backupPath).mode & 0o777).toBe(mode)
    const witness = fixture.writeWitness()
    const result = await recordLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness, verifyWitness: fixture.verifyWitness,
    })
    expect(result.state).toBe("COMMITTED")
    expect(readJournal(fixture).map((record) => record.state)).toEqual(["PREPARED", "STAGED", "SWAP_INTENT", "SWAPPED_EXPECTED", "LOAD_VERIFIED", "COMMITTED"])
    expect(readJournal(fixture).find((record) => record.state === "SWAPPED_EXPECTED")?.details).toMatchObject({
      nativeHelperProtocol: "skillopt-darwin.v2", nativeHelperStatus: "EXCHANGED",
    })
  })

  nativeTest("journals the helper-retained raced inode and its verified digest before RACE_PRESERVED", async () => {
    const fixture = makeFixture()
    const ownerVersionPath = `${fixture.targetPath}.owner-version`
    const result = await runWithNativeBarrier(fixture, "before-swap", () => {
      renameSync(fixture.targetPath, ownerVersionPath)
      writeFileSync(fixture.targetPath, THIRD)
      chmodSync(fixture.targetPath, mode)
    }, () => applySkillOptPromotion(fixture.apply({
      nativeHelperPath: barrierHelperPath,
      nativeHelperSha256: barrierHelperSha256,
    })))
    expect(result).toMatchObject({ state: "RACE_PRESERVED", raceMayHavePublishedCandidate: true })
    expectBytesEqual(readFileSync(fixture.targetPath), fixture.candidateBytes)
    expectBytesEqual(readFileSync(ownerVersionPath), ORIGINAL)
    const journal = readJournal(fixture)
    const capture = journal.find((record) => record.state === "RACE_CAPTURED")
    const preserved = journal.find((record) => record.state === "RACE_PRESERVED")
    expect(capture?.details.nativeHelperProtocol).toBe("skillopt-darwin.v2")
    expect(capture?.details.retainedArtifact).toMatchObject({ sha256: hash(THIRD), size: THIRD.length })
    expect(preserved?.seq).toBe((capture?.seq ?? 0) + 1)
    expect(preserved?.details.captureRecordChecksum).toBe(capture?.checksum)
    const artifact = capture?.details.retainedArtifact
    expect(typeof artifact?.name).toBe("string")
    expectBytesEqual(readFileSync(join(fixture.sandbox.transactionRoot, fixture.runId, "retained", artifact!.name)), THIRD)
  })

  nativeTest("recovery and repeated apply retain a held helper without authorizing release", async () => {
    const fixture = makeFixture()
    const movedCandidate = `${fixture.targetPath}.held-candidate`
    let sawDurableRecovery = false
    const result = await runWithNativeBarrier(fixture, "post-open", () => {
      renameSync(fixture.targetPath, movedCandidate)
      writeFileSync(fixture.targetPath, THIRD)
      chmodSync(fixture.targetPath, mode)
    }, () => applySkillOptPromotion(fixture.apply({
      nativeHelperPath: barrierHelperPath,
      nativeHelperSha256: barrierHelperSha256,
      faultInjection: (point) => {
        if (point !== "RACE_HELD_JOURNALED") return
        const latest = readJournal(fixture).at(-1)
        expect(latest?.state).toBe("RECOVERY_REQUIRED")
        expect(latest?.details).toMatchObject({
          nativeHelperProtocol: "skillopt-darwin.v2",
          nativeHelperStatus: "RACE_HELD",
          exchangeKind: "apply",
        })
        const pid = latest?.details.helperPid
        expect(typeof pid).toBe("number")
        ownedHeldHelpers.add(pid as number)
        expect(() => process.kill(pid as number, 0)).not.toThrow()
        sawDurableRecovery = true
      },
    })))
    expect(sawDurableRecovery).toBe(true)
    expect(result).toMatchObject({ state: "RECOVERY_REQUIRED", raceMayHavePublishedCandidate: true })
    expectBytesEqual(readFileSync(fixture.targetPath), THIRD)
    expectBytesEqual(readFileSync(movedCandidate), fixture.candidateBytes)
    const journal = readJournal(fixture)
    expect(journal.at(-1)?.state).toBe("RECOVERY_REQUIRED")
    expect(journal.find((record) => record.state === "SWAP_INTENT")?.details.stageName).toBeDefined()
    expect((await recoverSkillOptPromotion(fixture.apply())).state).toBe("RECOVERY_REQUIRED")
    expect((await applySkillOptPromotion(fixture.apply())).state).toBe("RECOVERY_REQUIRED")
    for (const pid of ownedHeldHelpers) expect(() => process.kill(pid, 0)).not.toThrow()
  })

  nativeTest("oversized third versions stay held after an interrupted recovery journal callback", async () => {
    const fixture = makeFixture()
    const oversized = Buffer.alloc(16_385, 120)
    await expectInjectedCrash(() => runWithNativeBarrier(fixture, "before-swap", () => {
      renameSync(fixture.targetPath, `${fixture.targetPath}.owner-version`)
      writeFileSync(fixture.targetPath, oversized)
      chmodSync(fixture.targetPath, mode)
    }, () => applySkillOptPromotion(fixture.apply({
      nativeHelperPath: barrierHelperPath,
      nativeHelperSha256: barrierHelperSha256,
      faultInjection: (point) => {
        if (point !== "RACE_HELD_JOURNALED") return
        const details = readJournal(fixture).at(-1)!.details
        expect(details.stageObservation).toMatchObject({ size: oversized.length })
        expect(details.retainedArtifact).toBeNull()
        ownedHeldHelpers.add(details.helperPid as number)
        throw new Error("injected crash: RACE_HELD_JOURNALED")
      },
    }))), "RACE_HELD_JOURNALED")
    expect((await recoverSkillOptPromotion(fixture.apply())).state).toBe("RECOVERY_REQUIRED")
    for (const pid of ownedHeldHelpers) expect(() => process.kill(pid, 0)).not.toThrow()
    const stageName = readJournal(fixture).find((record) => record.state === "SWAP_INTENT")!.details.stageName
    expectBytesEqual(readFileSync(join(fixture.targetDirectory, stageName)), oversized)
  })

  nativeTest("apply and commit retries are idempotent and never exchange twice", async () => {
    const fixture = makeFixture()
    expect((await applySkillOptPromotion(fixture.apply())).state).toBe("SWAPPED_EXPECTED")
    const candidateInode = lstatSync(fixture.targetPath).ino
    const repeated = await applySkillOptPromotion(fixture.apply())
    expect(repeated).toMatchObject({ state: "SWAPPED_EXPECTED", idempotent: true })
    expect(lstatSync(fixture.targetPath).ino).toBe(candidateInode)
    const witness = fixture.writeWitness()
    const input = {
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness, verifyWitness: fixture.verifyWitness,
    }
    expect((await recordLoadVerification(input)).state).toBe("COMMITTED")
    expect(await recordLoadVerification(input)).toMatchObject({ state: "COMMITTED", idempotent: true })
    expect(readJournal(fixture).filter((record) => record.state === "SWAP_INTENT")).toHaveLength(1)
  })

  nativeTest("rejects a wrong candidate hash before creating a transaction or changing the target", async () => {
    const fixture = makeFixture()
    await expectPromotionError(() => applySkillOptPromotion(fixture.apply({ candidateBytes: Buffer.from("wrong approved bytes") })), "candidate-binding-invalid")
    expect(readFileSync(fixture.targetPath)).toEqual(ORIGINAL)
    expect(existsSync(join(fixture.sandbox.transactionRoot, fixture.runId))).toBe(false)

    const rebound = makeFixture()
    const wrongBindings = { ...rebound.bindings, candidateSha256: hash("unapproved candidate") }
    await expectPromotionError(() => applySkillOptPromotion(rebound.apply({ bindings: wrongBindings })), "qualification-record-invalid")
    expect(readFileSync(rebound.targetPath)).toEqual(ORIGINAL)
    expect(existsSync(join(rebound.sandbox.transactionRoot, rebound.runId))).toBe(false)
  })

  nativeTest("rejects stale approval bytes, nonqualified records, and arbitrary approved:true JSON", async () => {
    const stale = makeFixture()
    writeFileSync(stale.evidence.approval.path, JSON.stringify({ approved: true }))
    chmodSync(stale.evidence.approval.path, 0o600)
    await expectPromotionError(() => applySkillOptPromotion(stale.apply()), "record-digest-mismatch")
    expect(readFileSync(stale.targetPath)).toEqual(ORIGINAL)

    const forged = makeFixture()
    writeFileSync(forged.evidence.qualification.path, JSON.stringify({ approved: true }))
    chmodSync(forged.evidence.qualification.path, 0o600)
    const ref = { ...forged.evidence.qualification, sha256: hash(readFileSync(forged.evidence.qualification.path)) }
    const evidence = { ...forged.evidence, qualification: ref }
    await expectPromotionError(() => applySkillOptPromotion(forged.apply({ evidence })), "qualification-record-invalid")
    expect(readFileSync(forged.targetPath)).toEqual(ORIGINAL)
  })

  nativeTest("rejects target symlinks and hardlinks without following or changing their referents", async () => {
    const symlinked = makeFixture()
    const originalPath = `${symlinked.targetPath}.original`
    renameSync(symlinked.targetPath, originalPath)
    const { symlinkSync } = await import("node:fs")
    symlinkSync(originalPath, symlinked.targetPath)
    await expectPromotionError(() => applySkillOptPromotion(symlinked.apply()))
    expect(lstatSync(symlinked.targetPath).isSymbolicLink()).toBe(true)
    expect(readFileSync(originalPath)).toEqual(ORIGINAL)

    const hardlinked = makeFixture()
    const alias = join(hardlinked.projectRoot, "hardlink-alias")
    linkSync(hardlinked.targetPath, alias)
    await expectPromotionError(() => applySkillOptPromotion(hardlinked.apply()))
    expect(lstatSync(hardlinked.targetPath).nlink).toBe(2)
    expect(readFileSync(alias)).toEqual(ORIGINAL)
  })

  nativeTest("preserves a parent-directory replacement race without publishing into the replacement", async () => {
    const fixture = makeFixture()
    const moved = `${fixture.targetDirectory}.displaced`
    let changed = false
    const input = fixture.apply({ faultInjection: (point) => {
      if (point !== "PREPARED" || changed) return
      changed = true
      renameSync(fixture.targetDirectory, moved)
      mkdirSync(fixture.targetDirectory, { mode: 0o700 })
      chmodSync(fixture.targetDirectory, 0o700)
      writeFileSync(fixture.targetPath, THIRD)
      chmodSync(fixture.targetPath, mode)
    } })
    await expectPromotionError(() => applySkillOptPromotion(input))
    expect(readFileSync(fixture.targetPath)).toEqual(THIRD)
    expect(readFileSync(join(moved, "SKILL.md"))).toEqual(ORIGINAL)
  })

  nativeTest("preserves an in-place edit that races after final precheck even if the candidate was briefly published", async () => {
    const fixture = makeFixture()
    const result = await applySkillOptPromotion(fixture.apply({ faultInjection: (point) => {
      if (point !== "BEFORE_EXCHANGE") return
      const fd = openSync(fixture.targetPath, "r+")
      try { ftruncateSync(fd, 0); writeSync(fd, THIRD, 0, THIRD.length, 0) } finally { closeSync(fd) }
    } }))
    expect(result).toMatchObject({ state: "RACE_PRESERVED", raceMayHavePublishedCandidate: true })
    expectBytesEqual(readFileSync(fixture.targetPath), fixture.candidateBytes)
    const stageName = getJournalStage(fixture, "RACE_PRESERVED")
    expect(readFileSync(join(fixture.targetDirectory, stageName))).toEqual(THIRD)
    expect(readFileSync(join(fixture.sandbox.transactionRoot, fixture.runId, "original.bin"))).toEqual(ORIGINAL)
  })

  nativeTest("does not treat the native identity precondition as filesystem compare-and-swap", async () => {
    const fixture = makeFixture()
    const movedOriginal = `${fixture.targetPath}.owner-version`
    const result = await applySkillOptPromotion(fixture.apply({ faultInjection: (point) => {
      if (point !== "BEFORE_EXCHANGE") return
      renameSync(fixture.targetPath, movedOriginal)
      writeFileSync(fixture.targetPath, THIRD)
      chmodSync(fixture.targetPath, mode)
    } }))
    expect(result).toMatchObject({ state: "RACE_PRESERVED", raceMayHavePublishedCandidate: true })
    expect(readFileSync(fixture.targetPath)).toEqual(THIRD)
    expect(readFileSync(movedOriginal)).toEqual(ORIGINAL)
    const stageName = getJournalStage(fixture, "RACE_PRESERVED")
    expectBytesEqual(readFileSync(join(fixture.targetDirectory, stageName)), fixture.candidateBytes)
  })

  nativeTest("preserves a same-inode edit made to the live candidate after exchange", async () => {
    const fixture = makeFixture()
    const result = await applySkillOptPromotion(fixture.apply({ faultInjection: (point) => {
      if (point !== "EXCHANGE_COMPLETED") return
      const fd = openSync(fixture.targetPath, "r+")
      try { ftruncateSync(fd, 0); writeSync(fd, THIRD, 0, THIRD.length, 0) } finally { closeSync(fd) }
    } }))
    expect(result).toMatchObject({ state: "RACE_PRESERVED", raceMayHavePublishedCandidate: true })
    expect(readFileSync(fixture.targetPath)).toEqual(THIRD)
    expect(readJournal(fixture).at(-1)?.state).toBe("RACE_PRESERVED")
  })

  nativeTest("detects an editor writing the retained old descriptor during the host witness", async () => {
    const fixture = makeFixture()
    expect((await applySkillOptPromotion(fixture.apply())).state).toBe("SWAPPED_EXPECTED")
    const stageName = getJournalStage(fixture, "SWAP_INTENT")
    const witness = fixture.writeWitness()
    const result = await recordLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness, verifyWitness: async (bytes, bindings, expected) => {
        const fd = openSync(join(fixture.targetDirectory, stageName), "r+")
        try { ftruncateSync(fd, 0); writeSync(fd, THIRD, 0, THIRD.length, 0) } finally { closeSync(fd) }
        await fixture.verifyWitness(bytes, bindings, expected)
      },
    })
    expect(result).toMatchObject({ state: "RACE_PRESERVED", raceMayHavePublishedCandidate: true })
    expectBytesEqual(readFileSync(fixture.targetPath), fixture.candidateBytes)
    expect(readFileSync(join(fixture.targetDirectory, stageName))).toEqual(THIRD)
    expect(readFileSync(join(fixture.sandbox.transactionRoot, fixture.runId, "original.bin"))).toEqual(ORIGINAL)
  })

  nativeTest("does not replay a consumed approvalId in another transaction", async () => {
    const sandbox = makeSandbox()
    const first = makeFixture(sandbox, { approvalId: "same-owner-approval" })
    expect((await applySkillOptPromotion(first.apply())).state).toBe("SWAPPED_EXPECTED")
    const second = makeFixture(sandbox, { approvalId: "same-owner-approval" })
    await expectPromotionError(() => applySkillOptPromotion(second.apply()))
    expect(readFileSync(second.targetPath)).toEqual(ORIGINAL)
    expect(readJournal(second).at(-1)?.state).toBe("STAGED")
    expectBytesEqual(readFileSync(first.targetPath), first.candidateBytes)
  })

  nativeTest("classifies every durable apply crash boundary without repeating or reversing exchange", async () => {
    const beforeSwap = [
      "RUN_DIRECTORY_CREATED", "ORIGINAL_BACKUP_DURABLE", "MANIFEST_DURABLE", "PREPARED", "STAGE_DURABLE", "STAGED",
      "APPROVAL_CONSUMED", "SWAP_INTENT",
    ]
    for (const point of beforeSwap) {
      const fixture = makeFixture()
      await expectInjectedCrash(() => applySkillOptPromotion(fixture.apply({ faultInjection: crashAt(point) })), point)
      expect(readFileSync(fixture.targetPath)).toEqual(ORIGINAL)
      const recovered = await recoverSkillOptPromotion({
        targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
        bindings: fixture.bindings, evidence: fixture.evidence, verifyEvidence: fixture.verifyEvidence,
      })
      expect(recovered.state).toBe("RECOVERY_REQUIRED")
      expect(readFileSync(fixture.targetPath)).toEqual(ORIGINAL)
    }

    for (const point of ["EXCHANGE_COMPLETED", "SWAPPED_EXPECTED"]) {
      const fixture = makeFixture()
      await expectInjectedCrash(() => applySkillOptPromotion(fixture.apply({ faultInjection: crashAt(point) })), point)
      const recovered = await recoverSkillOptPromotion({
        targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
        bindings: fixture.bindings, evidence: fixture.evidence, verifyEvidence: fixture.verifyEvidence,
      })
      expect(recovered.state).toBe("SWAPPED_EXPECTED")
      expectBytesEqual(readFileSync(fixture.targetPath), fixture.candidateBytes)
      const stageName = getJournalStage(fixture, "SWAP_INTENT")
      expect(readFileSync(join(fixture.targetDirectory, stageName))).toEqual(ORIGINAL)
    }
  })

  nativeTest("a torn checksummed journal requires recovery and leaves all artifacts intact", async () => {
    const fixture = makeFixture()
    await expectInjectedCrash(() => applySkillOptPromotion(fixture.apply({ faultInjection: crashAt("STAGED") })), "STAGED")
    const journalPath = join(fixture.sandbox.transactionRoot, fixture.runId, "journal.jsonl")
    writeFileSync(journalPath, "{\"torn\":", { flag: "a" })
    const recovered = await recoverSkillOptPromotion({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, evidence: fixture.evidence, verifyEvidence: fixture.verifyEvidence,
    })
    expect(recovered).toMatchObject({ state: "RECOVERY_REQUIRED", reason: "journal-invalid-or-torn" })
    expect(readFileSync(fixture.targetPath)).toEqual(ORIGINAL)
    expect(readFileSync(join(fixture.sandbox.transactionRoot, fixture.runId, "original.bin"))).toEqual(ORIGINAL)
  })

  nativeTest("finishes a crash after durable LOAD_VERIFIED, receipt, or COMMITTED idempotently", async () => {
    for (const point of ["LOAD_VERIFIED", "COMMIT_RECEIPT_DURABLE", "COMMITTED"]) {
      const fixture = makeFixture()
      expect((await applySkillOptPromotion(fixture.apply())).state).toBe("SWAPPED_EXPECTED")
      const witness = fixture.writeWitness()
      const input = {
        targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
        bindings: fixture.bindings, witness, verifyWitness: fixture.verifyWitness, faultInjection: crashAt(point),
      }
      await expectInjectedCrash(() => recordLoadVerification(input), point)
      expect((await recordLoadVerification({ ...input, faultInjection: undefined })).state).toBe("COMMITTED")
      expect(readJournal(fixture).at(-1)?.state).toBe("COMMITTED")
    }
  })

  nativeTest("safe rollback restores only the exact backup and keeps the displaced candidate inode", async () => {
    const fixture = makeFixture()
    await promoteAndCommit(fixture)
    let policyChecks = 0
    const result = await rollbackSkillOptPromotion({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings,
      verifyRollback: async () => {
        policyChecks++
        const current = readFileSync(fixture.targetPath)
        if (hash(current) !== fixture.bindings.candidateSha256) throw new Error("rollback target is not the reviewed candidate")
      },
    })
    expect(result.state).toBe("ROLLBACK_SWAP_INTENT")
    expect(policyChecks).toBe(2)
    const rollbackIntent = readJournal(fixture).findLast((record) => record.state === "ROLLBACK_SWAP_INTENT")!
    const witness = fixture.writeWitness(fixture.bindings.originalSha256)
    const rolledBack = await recordRollbackLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness, verifyWitness: fixture.verifyWitness,
    })
    expect(rolledBack.state).toBe("ROLLED_BACK")
    expect(readFileSync(fixture.targetPath)).toEqual(ORIGINAL)
    expect(lstatSync(fixture.targetPath).mode & 0o777).toBe(mode)
    expect(readFileSync(join(fixture.targetDirectory, rollbackIntent.details.rollbackStageName))).toEqual(CANDIDATE)
    expect(readFileSync(join(fixture.sandbox.transactionRoot, fixture.runId, "original.bin"))).toEqual(ORIGINAL)
  })

  nativeTest("refuses rollback on candidate drift and preserves the live third version", async () => {
    const fixture = makeFixture()
    await promoteAndCommit(fixture)
    writeFileSync(fixture.targetPath, THIRD)
    const result = await rollbackSkillOptPromotion({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, verifyRollback: async () => undefined,
    })
    expect(result).toMatchObject({ state: "RECOVERY_REQUIRED", reason: "rollback-live-target-drift" })
    expect(readFileSync(fixture.targetPath)).toEqual(THIRD)
  })

  nativeTest("rollback exchange race preserves a same-inode third version instead of reverse-swapping", async () => {
    const fixture = makeFixture()
    await promoteAndCommit(fixture)
    const result = await rollbackSkillOptPromotion({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings,
      verifyRollback: async () => undefined,
      faultInjection: (point) => {
        if (point !== "BEFORE_ROLLBACK_EXCHANGE") return
        const fd = openSync(fixture.targetPath, "r+")
        try { ftruncateSync(fd, 0); writeSync(fd, THIRD, 0, THIRD.length, 0) } finally { closeSync(fd) }
      },
    })
    expect(result).toMatchObject({ state: "ROLLBACK_RACE_PRESERVED", raceMayHavePublishedCandidate: false })
    expect(readFileSync(fixture.targetPath)).toEqual(ORIGINAL)
    const rollbackName = readJournal(fixture).at(-1)?.details.rollbackStageName
    expect(typeof rollbackName).toBe("string")
    expect(readFileSync(join(fixture.targetDirectory, rollbackName))).toEqual(THIRD)
  })

  nativeTest("rollback crash boundaries never clean or reverse-swap the candidate", async () => {
    for (const point of ["ROLLBACK_PREPARED", "ROLLBACK_STAGE_DURABLE", "ROLLBACK_SWAP_INTENT"]) {
      const fixture = makeFixture()
      await promoteAndCommit(fixture)
      await expectInjectedCrash(() => rollbackSkillOptPromotion({
        targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
        bindings: fixture.bindings, verifyRollback: async () => undefined, faultInjection: crashAt(point),
      }), point)
      expect(readFileSync(fixture.targetPath)).toEqual(CANDIDATE)
      const recovered = await recoverSkillOptPromotion({
        targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
        bindings: fixture.bindings, evidence: fixture.evidence, verifyEvidence: fixture.verifyEvidence,
      })
      expect(recovered.state).toBe("RECOVERY_REQUIRED")
      expect(readFileSync(fixture.targetPath)).toEqual(CANDIDATE)
    }
    for (const point of ["ROLLBACK_EXCHANGE_COMPLETED", "ROLLBACK_LOAD_VERIFIED", "ROLLED_BACK"]) {
      const fixture = makeFixture()
      await promoteAndCommit(fixture)
      const rollbackInput = {
        targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
        bindings: fixture.bindings, verifyRollback: async () => undefined,
      }
      if (point === "ROLLBACK_EXCHANGE_COMPLETED") {
        await expectInjectedCrash(() => rollbackSkillOptPromotion({ ...rollbackInput, faultInjection: crashAt(point) }), point)
      } else {
        expect((await rollbackSkillOptPromotion(rollbackInput)).state).toBe("ROLLBACK_SWAP_INTENT")
      }
      const intent = readJournal(fixture).findLast((record) => record.state === "ROLLBACK_SWAP_INTENT")!
      const witness = fixture.writeWitness(fixture.bindings.originalSha256)
      if (point === "ROLLBACK_EXCHANGE_COMPLETED") {
        const recovered = await recoverSkillOptPromotion({
          targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
          bindings: fixture.bindings, evidence: fixture.evidence, verifyEvidence: fixture.verifyEvidence,
        })
        expect(recovered.state).toBe("ROLLBACK_SWAP_INTENT")
      } else {
        const witnessInput = {
          targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
          bindings: fixture.bindings, witness, verifyWitness: fixture.verifyWitness, faultInjection: crashAt(point),
        }
        await expectInjectedCrash(() => recordRollbackLoadVerification(witnessInput), point)
      }
      expect((await recordRollbackLoadVerification({
        targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
        bindings: fixture.bindings, witness, verifyWitness: fixture.verifyWitness,
      })).state).toBe("ROLLED_BACK")
      expect(readFileSync(fixture.targetPath)).toEqual(ORIGINAL)
      expect(readFileSync(join(fixture.targetDirectory, intent.details.rollbackStageName))).toEqual(CANDIDATE)
    }
  })
})
