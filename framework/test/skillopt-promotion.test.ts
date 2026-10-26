import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync, closeSync, existsSync, ftruncateSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { holdAdmission, resumeAdmission } from "../src/sessions/admission.ts"
import { NATIVE_PROTOCOL_SHA256 } from "../src/skillopt/dataset.ts"
import { NATIVE_EVALUATION_PROTOCOL_SHA256, scoreNativeFixtureResponse } from "../src/skillopt/evaluation.ts"
import { canonicalJson } from "../src/skillopt/pilot.ts"
import {
  NATIVE_SKILL_LOAD_WITNESS_SCHEMA,
  verifyNativeSkillLoadVerificationProof,
  type NativeSkillLoadVerificationProof,
} from "../src/skillopt/load-verification.ts"
import {
  applySkillOptPromotion, preflightSkillOptPromotion,
  assertNativeRollbackAuthorizationCurrent, authorizeNativePromotionApproval, previewNativePromotionApproval,
  consumeNativeRollbackCanaryCommit, consumeNativeRollbackCanaryHandoff,
  consumeNativePromotionCanaryCommit, consumeNativePromotionCanaryHandoff,
  nativePromotionMutationIsQuiescent,
  nativePromotionArtifactBudget,
  recordLoadVerification, recordNativeLoadVerification, recordNativeRollbackLoadVerification, recordRollbackLoadVerification,
  readSkillOptNativeClock, recoverSkillOptPromotion, rollbackSkillOptPromotion,
  verifyNativePromotionCanaryHandoff, verifyNativeRollbackCanaryHandoff,
  type ApplySkillOptPromotionInput, type PromotionBindings,
  type NativePromotionCanaryHandoff, type NativeRollbackCanaryHandoff,
  type PromotionEvidence, type PromotionLoadWitness, type PromotionRecordRef, type PromotionResult, PromotionError,
} from "../src/skillopt/promotion.ts"
import { makeSkillOptCanaryFixture } from "./skillopt-canary-fixtures.ts"
import {
  commitSyntheticSkillBaseline, createSyntheticNativeLoadProof, createSyntheticNativeRuntime,
  createSyntheticPromotionOwner, approveSyntheticNativePromotion, initializeSyntheticSkillProject,
  readSyntheticNativeDecision, SYNTHETIC_CANDIDATE_SKILL, SYNTHETIC_CODEX_MODEL, SYNTHETIC_ORIGINAL_SKILL, syntheticNativeProfileBindings,
  type SyntheticPromotionOwner,
} from "./skillopt-native-load-helpers.ts"

let ownedHelperRoot: string | undefined
let ownedBarrierHelperRoot: string | undefined
let nativeHelperPath = ""
let nativeHelperSha256 = ""
let barrierHelperPath = ""
let barrierHelperSha256 = ""
const supportedNative = process.platform === "darwin" || process.platform === "linux"
const nativeTest: typeof test = supportedNative ? test : test.skip
const nativePlatform = process.platform === "darwin" ? "darwin" : "linux"
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex")
const roots: string[] = []
const promotionOwners: SyntheticPromotionOwner[] = []
const ownedHeldHelpers = new Set<number>()
const ORIGINAL = Buffer.from("# original skill\n\nProtected instructions stay byte-identical.\n")
const CANDIDATE = Buffer.from("# original skill\n\nProtected instructions stay byte-identical.\n\nSupplemental reading paragraph.\n")
const THIRD = Buffer.from("# concurrent owner edit\n")
const mode = 0o640

beforeAll(() => {
  if (!supportedNative) return
  const override = process.env.SKILLOPT_NATIVE_HELPER
  if (override) {
    nativeHelperPath = resolve(override)
  } else {
    ownedHelperRoot = realpathSync(mkdtempSync(join(tmpdir(), "skillopt-native-helper-")))
    chmodSync(ownedHelperRoot, 0o700)
    nativeHelperPath = join(ownedHelperRoot, "skillopt-native")
    const sourcePath = resolve(import.meta.dir, "../src/skillopt/native.c")
    execFileSync(process.env.CC ?? "cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", sourcePath, "-o", nativeHelperPath], { stdio: "pipe" })
  }
  nativeHelperSha256 = createHash("sha256").update(readFileSync(nativeHelperPath)).digest("hex")
  ownedBarrierHelperRoot = realpathSync(mkdtempSync(join(tmpdir(), "skillopt-native-test-helper-")))
  chmodSync(ownedBarrierHelperRoot, 0o700)
  barrierHelperPath = join(ownedBarrierHelperRoot, "skillopt-native-test-faults")
  const sourcePath = resolve(import.meta.dir, "../src/skillopt/native.c")
  execFileSync(process.env.CC ?? "cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-DSKILLOPT_TEST_FAULTS=1", sourcePath, "-o", barrierHelperPath], { stdio: "pipe" })
  barrierHelperSha256 = createHash("sha256").update(readFileSync(barrierHelperPath)).digest("hex")
})

afterAll(() => {
  if (ownedHelperRoot) rmSync(ownedHelperRoot, { recursive: true, force: true })
  if (ownedBarrierHelperRoot) rmSync(ownedBarrierHelperRoot, { recursive: true, force: true })
})

afterEach(async () => {
  for (const owner of promotionOwners.splice(0)) {
    if (!(await owner.close())) throw new Error("synthetic native promotion owner could not be detached")
  }
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
  nativeOwner?: SyntheticPromotionOwner
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

function writeCanonicalRecord(path: string, value: unknown): PromotionRecordRef {
  const bytes = Buffer.from(canonicalJson(value), "utf8")
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" })
  chmodSync(path, 0o600)
  return { path: resolve(path), sha256: hash(bytes) }
}

function syntheticSemanticReview() {
  return ["final", "safety"].map((phase) => ({
    phase,
    status: "valid",
    promptSha256: hash(`${phase}:review-prompt`),
    responseSha256: hash(`${phase}:review-response`),
    assessment: "clear",
    findings: [],
  }))
}

function makeFixture(sandbox = makeSandbox(), options: {
  runId?: string; approvalId?: string; targetBytes?: Buffer; candidateBytes?: Buffer; witnessMode?: "legacy" | "native"
  bindingOverrides?: Partial<PromotionBindings>
  semanticReview?: unknown
} = {}): Fixture {
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
  const candidateBytes = Buffer.from(options.candidateBytes ?? CANDIDATE)
  const bindings: PromotionBindings = {
    witnessMode: options.witnessMode ?? "legacy",
    runId,
    rootBinding: hash(`root:${projectRoot}`),
    sourceSha256: hash("source-snapshot"),
    originalSha256: hash(original),
    candidateSha256: hash(candidateBytes),
    fixturePackSha256: hash("approved-fixture-pack"),
    canaryFixtureSha256: hash("approved-dev-canary-fixture"),
    protocolSha256: NATIVE_PROTOCOL_SHA256,
    evaluatorSha256: NATIVE_EVALUATION_PROTOCOL_SHA256,
    runtimeSha256: hash("pinned-runtime"),
    resultsSha256: hash("qualified-results"),
    witnessSha256: hash("pre-apply-witness"),
    nativeEngine: "codex",
    nativeModel: "codex-fixture",
    nativeProfileId: "codex-native-no-tools.v1",
    nativeProfileSha256: hash("native-profile"),
    nativeRuntimeVersion: "codex 1.2.3",
    nativeExecutableSha256: hash("native-executable"),
    ...options.bindingOverrides,
  }
  const qualification = writeRecord(join(evidenceDirectory, "qualification.json"), {
    schemaVersion: 1, bindings, decision: "qualified", reasons: [],
  })
  const reviewRecord = {
    schemaVersion: 1, bindings, qualificationSha256: qualification.sha256,
    reviewerId: "independent-reviewer-1", verdict: "approve",
    ...(bindings.witnessMode === "native" ? { semanticReview: options.semanticReview ?? syntheticSemanticReview() } : {}),
  }
  const review = writeRecord(join(evidenceDirectory, "review.json"), reviewRecord)
  const approval = writeRecord(join(evidenceDirectory, "approval.json"), {
    schemaVersion: 1, bindings, qualificationSha256: qualification.sha256, reviewSha256: review.sha256,
    approvalId: options.approvalId ?? `approval-${randomUUID().replaceAll("-", "")}`,
    observedAt: Date.now(), action: "approve-production-apply",
  })
  const evidence: PromotionEvidence = { qualification, review, approval }
  let currentEvidence = evidence
  const verifyEvidenceFor = async (current: PromotionEvidence) => {
    for (const ref of [current.qualification, current.review, current.approval]) {
      if (hash(readFileSync(ref.path)) !== ref.sha256) throw new Error("stored evidence changed")
    }
  }
  const verifyEvidence = () => verifyEvidenceFor(currentEvidence)
  const common = {
    targetPath,
    transactionRoot: sandbox.transactionRoot,
    nativeHelperPath,
    nativeHelperSha256,
    bindings,
  }
  const apply = (extra: Partial<ApplySkillOptPromotionInput> = {}): ApplySkillOptPromotionInput => {
    const selectedEvidence = extra.evidence ?? currentEvidence
    return {
      ...common,
      candidateBytes,
      evidence: selectedEvidence,
      verifyEvidence: extra.verifyEvidence ?? (() => verifyEvidenceFor(selectedEvidence)),
      ...extra,
    }
  }
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
    sandbox, runId, projectRoot, targetDirectory, targetPath, evidenceDirectory, bindings,
    get evidence() { return currentEvidence },
    set evidence(value) { currentEvidence = value },
    candidateBytes,
    apply, verifyEvidence, writeWitness, verifyWitness,
  }
}

function makeNativeTransactionFixture(targetIdentity: Partial<Pick<PromotionBindings,
  "nativeEngine" | "nativeModel" | "nativeProfileId" | "nativeProfileSha256" | "nativeRuntimeVersion" | "nativeExecutableSha256">> = {},
  semanticReview?: unknown): Fixture {
  const canary = makeSkillOptCanaryFixture()
  const fixture = makeFixture(makeSandbox(), {
    witnessMode: "native",
    targetBytes: Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"),
    candidateBytes: Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"),
    bindingOverrides: {
      fixturePackSha256: canary.packSha256,
      canaryFixtureSha256: canary.fixtureSha256,
      ...syntheticNativeProfileBindings(),
      ...targetIdentity,
    },
    semanticReview,
  })
  const nativeOwner = createSyntheticPromotionOwner(fixture.projectRoot)
  promotionOwners.push(nativeOwner)
  fixture.nativeOwner = nativeOwner
  return fixture
}

function nativePromotionCommon(fixture: Fixture) {
  return {
    targetPath: fixture.targetPath,
    transactionRoot: fixture.sandbox.transactionRoot,
    nativeHelperPath,
    nativeHelperSha256,
    bindings: fixture.bindings,
  }
}

async function nativeApplyAuthorization(fixture: Fixture) {
  if (!fixture.nativeOwner) throw new Error("native transaction fixture lacks a real session owner")
  return approveSyntheticNativePromotion({
    common: nativePromotionCommon(fixture),
    owner: fixture.nativeOwner.store,
    operation: "apply",
    runDeadlineAt: Date.now() + 60_000,
    candidateBytes: fixture.candidateBytes,
    evidence: { qualification: fixture.evidence.qualification, review: fixture.evidence.review },
  })
}

async function nativeApplyPreview(fixture: Fixture) {
  if (!fixture.nativeOwner) throw new Error("native transaction fixture lacks a real session owner")
  return previewNativePromotionApproval({
    ...nativePromotionCommon(fixture),
    owner: fixture.nativeOwner.store,
    operation: "apply",
    runDeadlineAt: Date.now() + 60_000,
    candidateBytes: fixture.candidateBytes,
    evidence: { qualification: fixture.evidence.qualification, review: fixture.evidence.review },
  })
}

async function applyWithNativeApproval(fixture: Fixture): Promise<PromotionResult> {
  const approval = await nativeApplyAuthorization(fixture)
  if (!approval.evidence) throw new Error("native apply approval omitted its consumed-receipt evidence")
  fixture.evidence = approval.evidence
  return applySkillOptPromotion(fixture.apply({ nativeAuthorization: approval.authorization }))
}

async function nativeRollbackAuthorization(fixture: Fixture) {
  if (!fixture.nativeOwner) throw new Error("native transaction fixture lacks a real session owner")
  return approveSyntheticNativePromotion({
    common: nativePromotionCommon(fixture),
    owner: fixture.nativeOwner.store,
    operation: "rollback",
    runDeadlineAt: Date.now() + 60_000,
  })
}

async function rollbackWithNativeApproval(fixture: Fixture): Promise<PromotionResult> {
  const approval = await nativeRollbackAuthorization(fixture)
  return rollbackSkillOptPromotion({ ...nativePromotionCommon(fixture), nativeAuthorization: approval.authorization })
}

async function beginNativeRollbackCanary(fixture: Fixture) {
  expect((await applyWithNativeApproval(fixture)).state).toBe("SWAPPED_EXPECTED")
  const approval = await nativeRollbackAuthorization(fixture)
  assertNativeRollbackAuthorizationCurrent({ ...nativePromotionCommon(fixture), owner: fixture.nativeOwner!.store,
    nativeAuthorization: approval.authorization })
  const rollback = await rollbackSkillOptPromotion({ ...nativePromotionCommon(fixture),
    nativeAuthorization: approval.authorization })
  expect(rollback).toMatchObject({ state: "ROLLBACK_SWAP_INTENT" })
  return rollback
}

async function issueNativePromotionHandoff(fixture: Fixture) {
  const handoff = await verifyNativePromotionCanaryHandoff(fixture.apply())
  const receipt = consumeNativePromotionCanaryHandoff(handoff)
  return { handoff, receipt }
}

function storeNativeProof(fixture: Fixture, label: string, proof: Awaited<ReturnType<typeof createSyntheticNativeLoadProof>>): PromotionRecordRef {
  const bytes = Buffer.from(proof.bytes)
  if (hash(bytes) !== proof.sha256 || !bytes.equals(Buffer.from(canonicalJson(proof.record), "utf8"))) {
    throw new Error("native proof output does not match its canonical artifact digest")
  }
  const path = join(fixture.evidenceDirectory, `${label}-${randomUUID()}.json`)
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" })
  chmodSync(path, 0o600)
  return { path: resolve(path), sha256: hash(bytes) }
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
  nativeTest("scratch preflight probes the supported platform exchange and durable flush", () => {
    const sandbox = makeSandbox()
    const targetDirectory = join(sandbox.root, "scratch-target")
    mkdirSync(targetDirectory, { mode: 0o700 })
    chmodSync(targetDirectory, 0o700)
    const result = preflightSkillOptPromotion({
      targetDirectory, transactionRoot: sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
    })
    expect(result).toEqual({ protocol: "skillopt-promotion.v3", platform: nativePlatform, probedDirectories: 2 })
  })

  nativeTest("reads a validated OS boot identity and suspend-inclusive clock sample", () => {
    const sample = readSkillOptNativeClock({ nativeHelperPath, nativeHelperSha256 })
    expect(Object.keys(sample).sort()).toEqual(["bootId", "continuousNanoseconds", "platform", "protocol", "wallMilliseconds"])
    expect(sample).toMatchObject({ protocol: "skillopt-promotion.v3", platform: nativePlatform })
    expect(sample.bootId).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
    expect(BigInt(sample.continuousNanoseconds)).toBeGreaterThan(0n)
    expect(Math.abs(Number(BigInt(sample.wallMilliseconds)) - Date.now())).toBeLessThan(10_000)
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
      nativeHelperProtocol: "skillopt-promotion.v3", nativeHelperPlatform: nativePlatform, nativeHelperStatus: "EXCHANGED",
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
    expect(capture?.details).toMatchObject({ nativeHelperProtocol: "skillopt-promotion.v3", nativeHelperPlatform: nativePlatform })
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
          nativeHelperProtocol: "skillopt-promotion.v3",
          nativeHelperPlatform: nativePlatform,
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
        expect(await rollbackSkillOptPromotion(rollbackInput)).toMatchObject({ state: "ROLLBACK_SWAP_INTENT" })
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

  nativeTest("native load gate rejects the legacy OpenCode schema instead of converting it", async () => {
    const fixture = makeNativeTransactionFixture()
    expect((await applyWithNativeApproval(fixture)).state).toBe("SWAPPED_EXPECTED")
    const witness = fixture.writeWitness()
    const { handoff } = await issueNativePromotionHandoff(fixture)
    await expect(recordNativeLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness, proof: {} as unknown as NativeSkillLoadVerificationProof, handoff,
    })).rejects.toMatchObject({ code: "native-witness-binding-invalid" })
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"))
    expect(readJournal(fixture).at(-1)?.state).toBe("SWAPPED_EXPECTED")
  })

  nativeTest("native canary handoff requires the consumed approval receipt, not only a callback and SWAPPED_EXPECTED journal", async () => {
    const fixture = makeNativeTransactionFixture()
    expect((await applyWithNativeApproval(fixture)).state).toBe("SWAPPED_EXPECTED")
    const approval = JSON.parse(readFileSync(fixture.evidence.approval.path, "utf8")) as { approvalId: string }
    const receiptPath = join(fixture.sandbox.transactionRoot, "consumed-approvals", `${hash(approval.approvalId)}.json`)
    rmSync(receiptPath)
    await expect(verifyNativePromotionCanaryHandoff(fixture.apply())).rejects.toBeDefined()
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"))
    expect(readJournal(fixture).at(-1)?.state).toBe("SWAPPED_EXPECTED")
  })

  nativeTest("native canary handoff refuses changed candidate bytes and inode before witness execution", async () => {
    const fixture = makeNativeTransactionFixture()
    expect((await applyWithNativeApproval(fixture)).state).toBe("SWAPPED_EXPECTED")
    const originalInode = lstatSync(fixture.targetPath).ino
    writeFileSync(fixture.targetPath, THIRD)
    expect(lstatSync(fixture.targetPath).ino).toBe(originalInode)
    await expect(verifyNativePromotionCanaryHandoff(fixture.apply())).rejects.toMatchObject({ code: "swapped-artifacts-drift" })
    expect(readFileSync(fixture.targetPath)).toEqual(THIRD)
    expect(readJournal(fixture).at(-1)?.state).toBe("SWAPPED_EXPECTED")
  })

  nativeTest("promotion mode is required and missing mode never defaults", async () => {
    const fixture = makeFixture()
    const missingMode: Record<string, unknown> = { ...fixture.bindings }
    delete missingMode.witnessMode
    await expect(applySkillOptPromotion(fixture.apply({ bindings: missingMode as unknown as PromotionBindings })))
      .rejects.toMatchObject({ code: "invalid-bindings" })
    expect(readFileSync(fixture.targetPath)).toEqual(ORIGINAL)
  })

  nativeTest("native apply rejects approval JSON without the one-use production authorization", async () => {
    const fixture = makeNativeTransactionFixture()
    await expect(applySkillOptPromotion(fixture.apply())).rejects.toMatchObject({ code: "native-authorization-required" })
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
    expect(existsSync(join(fixture.sandbox.transactionRoot, "approvals"))).toBe(false)
    expect(existsSync(join(fixture.sandbox.transactionRoot, fixture.runId))).toBe(false)
  })

  nativeTest("native apply refuses candidate-byte drift after synthetic terminal one-use approval and before exchange", async () => {
    const fixture = makeNativeTransactionFixture()
    const originalBytes = Buffer.from(readFileSync(fixture.targetPath))
    const originalInode = lstatSync(fixture.targetPath).ino
    const approval = await nativeApplyAuthorization(fixture)
    if (!approval.evidence) throw new Error("native apply approval omitted its consumed-receipt evidence")
    fixture.evidence = approval.evidence

    expect(hash(fixture.candidateBytes)).toBe(fixture.bindings.candidateSha256)
    const retainedEvidence = Object.values(fixture.evidence).map((reference) => ({
      reference,
      bytes: Buffer.from(readFileSync(reference.path)),
    }))
    fixture.candidateBytes.writeUInt8(fixture.candidateBytes.readUInt8(0) ^ 1, 0)
    expect(hash(fixture.candidateBytes)).not.toBe(fixture.bindings.candidateSha256)

    await expectPromotionError(
      () => applySkillOptPromotion(fixture.apply({ nativeAuthorization: approval.authorization })),
      "native-authorization-apply-binding-mismatch",
    )

    expectBytesEqual(readFileSync(fixture.targetPath), originalBytes)
    expect(lstatSync(fixture.targetPath).ino).toBe(originalInode)
    for (const { reference, bytes } of retainedEvidence) {
      const retained = readFileSync(reference.path)
      expectBytesEqual(retained, bytes)
      expect(hash(retained)).toBe(reference.sha256)
    }
    const runDirectory = join(fixture.sandbox.transactionRoot, fixture.runId)
    expect(existsSync(runDirectory)).toBe(false)
    expect(existsSync(join(runDirectory, "original.bin"))).toBe(false)
    expect(existsSync(join(fixture.sandbox.transactionRoot, "consumed-approvals"))).toBe(false)
    await expect(verifyNativePromotionCanaryHandoff(fixture.apply())).rejects.toBeDefined()
    expect(existsSync(runDirectory)).toBe(false)
  })

  nativeTest("native approval rejects unsuccessful or tampered semantic reviewer evidence", async () => {
    const semanticReview = syntheticSemanticReview().map((item, index) => index === 1
      ? { ...item, findings: ["unexpected reviewer finding"] }
      : item)
    const fixture = makeNativeTransactionFixture({}, semanticReview)

    await expect(nativeApplyPreview(fixture)).rejects.toMatchObject({ code: "review-semantic-evidence-invalid" })
    expect(existsSync(join(fixture.sandbox.transactionRoot, "approvals"))).toBe(false)
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
  })

  nativeTest("native approval rejects JSON-only preview copies, copied capabilities, and replay", async () => {
    const fixture = makeNativeTransactionFixture()
    const preview = await nativeApplyPreview(fixture)
    const copiedPreview = JSON.parse(JSON.stringify(preview.preview)) as typeof preview.preview
    const copiedReceipt = await readSyntheticNativeDecision(preview.decisionBinding)
    await expect(authorizeNativePromotionApproval({ preview: copiedPreview, owner: fixture.nativeOwner!.store, receipt: copiedReceipt }))
      .rejects.toMatchObject({ code: "native-approval-preview-invalid-or-consumed" })

    const realReceipt = await readSyntheticNativeDecision(preview.decisionBinding)
    const authorized = await authorizeNativePromotionApproval({ preview: preview.preview, owner: fixture.nativeOwner!.store, receipt: realReceipt })
    expect(authorized.evidence).toBeDefined()
    fixture.evidence = authorized.evidence!
    const copiedAuthorization = structuredClone(authorized.authorization) as typeof authorized.authorization
    await expect(applySkillOptPromotion(fixture.apply({ nativeAuthorization: copiedAuthorization })))
      .rejects.toMatchObject({ code: "native-authorization-required-or-consumed" })
    expect((await applySkillOptPromotion(fixture.apply({ nativeAuthorization: authorized.authorization }))).state).toBe("SWAPPED_EXPECTED")
    await expect(applySkillOptPromotion(fixture.apply({ nativeAuthorization: authorized.authorization })))
      .rejects.toMatchObject({ code: "native-authorization-required-or-consumed" })
  })

  nativeTest("native approval expiry is bounded by fifteen minutes and the approved run deadline", async () => {
    const fixture = makeNativeTransactionFixture()
    const owner = fixture.nativeOwner!.store
    const farDeadline = Date.now() + 60 * 60 * 1000
    const preview = await previewNativePromotionApproval({
      ...nativePromotionCommon(fixture), owner, operation: "apply", runDeadlineAt: farDeadline,
      candidateBytes: fixture.candidateBytes,
      evidence: { qualification: fixture.evidence.qualification, review: fixture.evidence.review },
    })
    const clock = readSkillOptNativeClock({ nativeHelperPath, nativeHelperSha256 })
    expect(BigInt(preview.expiresWallMilliseconds) - BigInt(clock.wallMilliseconds)).toBeLessThanOrEqual(900_000n)
    expect(Number(preview.expiresWallMilliseconds)).toBeLessThanOrEqual(farDeadline)
    await expect(previewNativePromotionApproval({
      ...nativePromotionCommon(fixture), owner, operation: "apply", runDeadlineAt: Date.now() - 1,
      candidateBytes: fixture.candidateBytes,
      evidence: { qualification: fixture.evidence.qualification, review: fixture.evidence.review },
    })).rejects.toMatchObject({ code: "native-approval-run-deadline-invalid" })
    expect(existsSync(join(fixture.sandbox.transactionRoot, "approvals"))).toBe(false)
  })

  nativeTest("native approval binds the real Codex owner independently from a Claude target identity", async () => {
    const fixture = makeNativeTransactionFixture({
      nativeEngine: "claude",
      nativeModel: "claude-private-target",
      nativeProfileId: "claude-restricted-read.v1",
      nativeProfileSha256: hash("claude-private-profile"),
      nativeRuntimeVersion: "claude-private-runtime",
      nativeExecutableSha256: hash("claude-private-executable"),
    })
    const owner = fixture.nativeOwner!.store
    expect(owner.metadata.engine).toBe("codex")
    expect(fixture.bindings.nativeEngine).toBe("claude")

    const initialPreview = await nativeApplyPreview(fixture)
    const principal = initialPreview.details.ownerPrincipal as {
      sessionID: string
      epoch: string
      admission: { sessionID: string; epoch: string; leaseId: string }
      metadata: { engine: string; model: string | null; routes: Record<string, { engine: string; model: string }> | null }
    }
    expect(principal).toMatchObject({
      sessionID: owner.sessionID,
      epoch: owner.epoch,
      admission: { sessionID: owner.sessionID, epoch: owner.epoch },
      metadata: { engine: "codex", model: SYNTHETIC_CODEX_MODEL, routes: null },
    })
    expect(principal.admission.leaseId).toMatch(/^[a-f0-9]{32}$/u)
    expect(initialPreview.details.ownerPrincipal).toEqual(principal)

    owner.rebindModel({
      engine: "codex",
      model: SYNTHETIC_CODEX_MODEL,
      routes: { reviewer: { engine: "claude", model: "claude-reviewer-model" } },
    })
    const preview = await nativeApplyPreview(fixture)
    expect(preview.details.ownerPrincipal).toMatchObject({
      metadata: { routes: { reviewer: { engine: "claude", model: "claude-reviewer-model" } } },
    })
    expect(preview.decisionBinding.subject.sha256).not.toBe(initialPreview.decisionBinding.subject.sha256)

    const receipt = await readSyntheticNativeDecision(preview.decisionBinding)
    const authorization = await authorizeNativePromotionApproval({ preview: preview.preview, owner, receipt })
    if (!authorization.evidence) throw new Error("native apply approval omitted its consumed-receipt evidence")
    fixture.evidence = authorization.evidence
    const result = await applySkillOptPromotion(fixture.apply({ nativeAuthorization: authorization.authorization }))
    expect(result.state).toBe("SWAPPED_EXPECTED")
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"))
  })

  nativeTest("native approval rejects supported route metadata drift after preview", async () => {
    const fixture = makeNativeTransactionFixture()
    const owner = fixture.nativeOwner!.store
    const preview = await nativeApplyPreview(fixture)
    const receipt = await readSyntheticNativeDecision(preview.decisionBinding)
    owner.rebindModel({
      engine: "codex",
      model: SYNTHETIC_CODEX_MODEL,
      routes: { reviewer: { engine: "claude", model: "claude-reviewer-model" } },
    })
    await expect(authorizeNativePromotionApproval({ preview: preview.preview, owner, receipt }))
      .rejects.toMatchObject({ code: "native-approval-owner-stale" })
    expect(existsSync(join(fixture.sandbox.transactionRoot, "approvals"))).toBe(false)
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
  })

  nativeTest("native apply rejects owner metadata drift at the irreversible exchange boundary", async () => {
    const fixture = makeNativeTransactionFixture()
    const owner = fixture.nativeOwner!.store
    const authorization = await nativeApplyAuthorization(fixture)
    if (!authorization.evidence) throw new Error("native apply approval omitted its consumed-receipt evidence")
    fixture.evidence = authorization.evidence

    await expect(applySkillOptPromotion(fixture.apply({
      nativeAuthorization: authorization.authorization,
      faultInjection: (point) => {
        if (point === "BEFORE_EXCHANGE") owner.rebindModel({
          engine: "codex",
          model: SYNTHETIC_CODEX_MODEL,
          routes: { reviewer: { engine: "claude", model: "claude-reviewer-model" } },
        })
      },
    }))).rejects.toMatchObject({ code: "native-approval-owner-stale" })
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
    expect(readJournal(fixture).some(record => record.state === "SWAPPED_EXPECTED" || record.state === "COMMITTED")).toBe(false)
  })

  nativeTest("native approval consumes a genuine receipt but refuses a different current owner", async () => {
    const fixture = makeNativeTransactionFixture()
    const preview = await nativeApplyPreview(fixture)
    const otherOwner = createSyntheticPromotionOwner(fixture.projectRoot)
    promotionOwners.push(otherOwner)
    const receipt = await readSyntheticNativeDecision(preview.decisionBinding)
    await expect(authorizeNativePromotionApproval({ preview: preview.preview, owner: otherOwner.store, receipt }))
      .rejects.toMatchObject({ code: "native-operator-decision-binding-mismatch" })
    expect(existsSync(join(fixture.sandbox.transactionRoot, "approvals"))).toBe(false)
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
  })

  nativeTest("native approval refuses an owner whose admission token was replaced after preview", async () => {
    const fixture = makeNativeTransactionFixture()
    const owner = fixture.nativeOwner!
    const preview = await nativeApplyPreview(fixture)
    const receipt = await readSyntheticNativeDecision(preview.decisionBinding)
    holdAdmission(owner.runtime.worktree, owner.store.sessionID, "native approval epoch rollover test")
    resumeAdmission(owner.runtime, owner.store.sessionID)
    await expect(authorizeNativePromotionApproval({ preview: preview.preview, owner: owner.store, receipt }))
      .rejects.toMatchObject({ code: "native-approval-owner-stale" })
    expect(existsSync(join(fixture.sandbox.transactionRoot, "approvals"))).toBe(false)
  })

  nativeTest("native approval refuses a replacement attachment epoch for the same session ID", async () => {
    const fixture = makeNativeTransactionFixture()
    const oldOwner = fixture.nativeOwner!
    const preview = await nativeApplyPreview(fixture)
    const receipt = await readSyntheticNativeDecision(preview.decisionBinding)
    const sessionID = oldOwner.store.sessionID
    expect(await oldOwner.close()).toBe(true)
    const replacement = createSyntheticPromotionOwner(fixture.projectRoot, sessionID)
    promotionOwners.push(replacement)
    expect(replacement.store.epoch).not.toBe(oldOwner.store.epoch)
    await expect(authorizeNativePromotionApproval({ preview: preview.preview, owner: oldOwner.store, receipt }))
      .rejects.toMatchObject({ code: "native-approval-owner-stale" })
    expect(existsSync(join(fixture.sandbox.transactionRoot, "approvals"))).toBe(false)
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
  })

  nativeTest("native apply revalidates authorization after the final pre-exchange hook", async () => {
    const fixture = makeNativeTransactionFixture()
    const owner = fixture.nativeOwner!
    const approval = await nativeApplyAuthorization(fixture)
    if (!approval.evidence) throw new Error("native apply approval omitted its consumed-receipt evidence")
    fixture.evidence = approval.evidence

    await expect(applySkillOptPromotion(fixture.apply({
      nativeAuthorization: approval.authorization,
      faultInjection: (point) => {
        if (point !== "BEFORE_EXCHANGE") return
        holdAdmission(owner.runtime.worktree, owner.store.sessionID, "native apply pre-exchange epoch rollover test")
        resumeAdmission(owner.runtime, owner.store.sessionID)
      },
    }))).rejects.toMatchObject({ code: "native-approval-owner-stale" })

    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
    expect(readJournal(fixture).some(record => record.state === "SWAPPED_EXPECTED" || record.state === "COMMITTED")).toBe(false)
  })

  nativeTest("native apply and rollback authorizations cannot cross operations", async () => {
    const fixture = makeNativeTransactionFixture()
    const spareApplyApproval = await nativeApplyAuthorization(fixture)
    expect((await applyWithNativeApproval(fixture)).state).toBe("SWAPPED_EXPECTED")
    await expect(rollbackSkillOptPromotion({
      ...nativePromotionCommon(fixture), nativeAuthorization: spareApplyApproval.authorization,
    })).rejects.toMatchObject({ code: "native-authorization-operation-or-binding-mismatch" })
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"))

    const rollbackApproval = await approveSyntheticNativePromotion({
      common: nativePromotionCommon(fixture), owner: fixture.nativeOwner!.store,
      operation: "rollback", runDeadlineAt: Date.now() + 60_000,
    })
    await expect(applySkillOptPromotion(fixture.apply({ nativeAuthorization: rollbackApproval.authorization })))
      .rejects.toMatchObject({ code: "native-authorization-operation-or-binding-mismatch" })
    expect(await rollbackWithNativeApproval(fixture)).toMatchObject({ state: "ROLLBACK_SWAP_INTENT" })
  })

  nativeTest("mutation quiescence accepts only a genuine same-operation result or closed-helper error", async () => {
    const fixture = makeNativeTransactionFixture()
    const approval = await nativeApplyAuthorization(fixture)
    if (!approval.evidence) throw new Error("native apply approval omitted its consumed-receipt evidence")
    fixture.evidence = approval.evidence
    const input = fixture.apply({ nativeAuthorization: approval.authorization })
    const common = nativePromotionCommon(fixture)
    const result = await applySkillOptPromotion(input)
    expect(nativePromotionMutationIsQuiescent(result, common, "apply")).toBe(true)
    expect(nativePromotionMutationIsQuiescent(structuredClone(result), common, "apply")).toBe(false)
    expect(nativePromotionMutationIsQuiescent(result, common, "rollback")).toBe(false)
    expect(nativePromotionMutationIsQuiescent(result, { ...common, transactionRoot: `${common.transactionRoot}/other` }, "apply"))
      .toBe(false)

    let caught: unknown
    try { await applySkillOptPromotion(input) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(PromotionError)
    expect(nativePromotionMutationIsQuiescent(caught, common, "apply")).toBe(true)
    expect(nativePromotionMutationIsQuiescent(JSON.parse(JSON.stringify(caught)), common, "apply")).toBe(false)

    const rollbackApproval = await nativeRollbackAuthorization(fixture)
    const rollback = await rollbackSkillOptPromotion({ ...common, nativeAuthorization: rollbackApproval.authorization })
    expect(rollback).toMatchObject({ state: "ROLLBACK_SWAP_INTENT" })
    expect(nativePromotionMutationIsQuiescent(rollback, common, "rollback")).toBe(true)
    expect(nativePromotionMutationIsQuiescent(structuredClone(rollback), common, "rollback")).toBe(false)
    expect(nativePromotionMutationIsQuiescent(rollback, common, "apply")).toBe(false)
  })

  nativeTest("mutation quiescence refuses a genuine held native exchange", async () => {
    const fixture = makeNativeTransactionFixture()
    const common = {
      ...nativePromotionCommon(fixture), nativeHelperPath: barrierHelperPath, nativeHelperSha256: barrierHelperSha256,
    }
    const approval = await approveSyntheticNativePromotion({
      common, owner: fixture.nativeOwner!.store, operation: "apply", runDeadlineAt: Date.now() + 60_000,
      candidateBytes: fixture.candidateBytes,
      evidence: { qualification: fixture.evidence.qualification, review: fixture.evidence.review },
    })
    if (!approval.evidence) throw new Error("native apply approval omitted its consumed-receipt evidence")
    fixture.evidence = approval.evidence
    const movedCandidate = `${fixture.targetPath}.held-candidate`
    const result = await runWithNativeBarrier(fixture, "post-open", () => {
      renameSync(fixture.targetPath, movedCandidate)
      writeFileSync(fixture.targetPath, THIRD)
      chmodSync(fixture.targetPath, mode)
    }, () => applySkillOptPromotion(fixture.apply({
      nativeHelperPath: barrierHelperPath,
      nativeHelperSha256: barrierHelperSha256,
      nativeAuthorization: approval.authorization,
      faultInjection: (point) => {
        if (point !== "RACE_HELD_JOURNALED") return
        const pid = readJournal(fixture).at(-1)?.details.helperPid
        if (typeof pid !== "number") throw new Error("held helper pid is missing")
        ownedHeldHelpers.add(pid)
      },
    })))
    expect(result).toMatchObject({ state: "RECOVERY_REQUIRED", raceMayHavePublishedCandidate: true })
    expect(nativePromotionMutationIsQuiescent(result, common, "apply")).toBe(false)
    expect(nativePromotionMutationIsQuiescent(structuredClone(result), common, "apply")).toBe(false)
    expect(nativePromotionMutationIsQuiescent(result, common, "rollback")).toBe(false)
    expect(readFileSync(fixture.targetPath)).toEqual(THIRD)
    expect(readFileSync(movedCandidate).equals(fixture.candidateBytes)).toBe(true)
    let retryError: unknown
    try {
      await applySkillOptPromotion(fixture.apply({
        nativeHelperPath: barrierHelperPath, nativeHelperSha256: barrierHelperSha256,
      }))
    } catch (error) { retryError = error }
    expect(retryError).toBeInstanceOf(PromotionError)
    expect(nativePromotionMutationIsQuiescent(retryError, common, "apply")).toBe(false)
  })

  nativeTest("native proof APIs refuse legacy-mode apply and rollback transactions", async () => {
    const fixture = makeFixture()
    expect((await applySkillOptPromotion(fixture.apply())).state).toBe("SWAPPED_EXPECTED")
    await expect(recordNativeLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness: fixture.writeWitness(), proof: {} as unknown as NativeSkillLoadVerificationProof,
      handoff: {} as NativePromotionCanaryHandoff,
    })).rejects.toMatchObject({ code: "native-load-mode-required" })
    expect(await rollbackSkillOptPromotion({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, verifyRollback: async () => undefined,
    })).toMatchObject({ state: "ROLLBACK_SWAP_INTENT" })
    await expect(recordNativeRollbackLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness: fixture.writeWitness(fixture.bindings.originalSha256),
      proof: {} as unknown as NativeSkillLoadVerificationProof, handoff: {} as NativeRollbackCanaryHandoff,
    })).rejects.toMatchObject({ code: "native-load-mode-required" })
    expect(readFileSync(fixture.targetPath)).toEqual(ORIGINAL)
    expect(readJournal(fixture).at(-1)?.state).toBe("ROLLBACK_SWAP_INTENT")
  })

  nativeTest("real CLI transport with a disposable synthetic Codex subprocess completes the native apply and exact-byte rollback transaction", async () => {
    const fixture = makeNativeTransactionFixture()
    initializeSyntheticSkillProject(fixture.projectRoot)
    commitSyntheticSkillBaseline(fixture.projectRoot, "original synthetic skill")
    const runtime = createSyntheticNativeRuntime(fixture.projectRoot)
    expect((await applyWithNativeApproval(fixture)).state).toBe("SWAPPED_EXPECTED")
    const applyBudget = nativePromotionArtifactBudget("apply")
    const originalEvidenceBytes = readFileSync(fixture.evidence.qualification.path).byteLength +
      readFileSync(fixture.evidence.review.path).byteLength
    expect(applyBudget.approvalBytes + applyBudget.transactionBytes + applyBudget.witnessBytes + originalEvidenceBytes)
      .toBeLessThanOrEqual(256 * 1024 * 1024)
    expect(readFileSync(fixture.evidence.approval.path).byteLength).toBeLessThanOrEqual(applyBudget.approvalBytes)
    expect(JSON.parse(readFileSync(fixture.evidence.approval.path, "utf8"))).toMatchObject({
      action: "approve-production-apply", bindings: fixture.bindings,
    })
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"))
    commitSyntheticSkillBaseline(fixture.projectRoot, "approved candidate skill")
    const { handoff, receipt: handoffReceipt } = await issueNativePromotionHandoff(fixture)
    expect(structuredClone(handoffReceipt)).toMatchObject({
      transactionId: expect.any(String), bindings: fixture.bindings, evidence: fixture.evidence,
    })
    expect(handoffReceipt.handoffId).toMatch(/^[a-f0-9]{48}$/u)
    expect(Object.isFrozen(handoffReceipt)).toBe(true)
    expect(Object.isFrozen(handoffReceipt.bindings)).toBe(true)
    expect(Object.isFrozen(handoffReceipt.evidence)).toBe(true)
    const reviewRecord = JSON.parse(readFileSync(fixture.evidence.review.path, "utf8")) as { semanticReview: unknown }
    expect(handoffReceipt.semanticReviewSha256).toBe(hash(canonicalJson(reviewRecord.semanticReview)))
    expect(handoffReceipt.semanticReviewSha256).not.toBe(fixture.evidence.review.sha256)
    expect(handoffReceipt.evidence.review.sha256).toBe(fixture.evidence.review.sha256)
    expect(() => consumeNativePromotionCanaryHandoff({ ...handoff } as NativePromotionCanaryHandoff))
      .toThrow("native-handoff-invalid-or-consumed")
    expect(() => consumeNativePromotionCanaryHandoff(handoff)).toThrow("native-handoff-invalid-or-consumed")

    const applyProof = await createSyntheticNativeLoadProof({
      projectRoot: fixture.projectRoot, bindings: fixture.bindings,
      skillBytes: Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"), operation: "apply", runtime,
    })
    expect(applyProof.bytes.byteLength).toBeLessThanOrEqual(applyBudget.witnessBytes)
    const wrongOperationProof = await createSyntheticNativeLoadProof({
      projectRoot: fixture.projectRoot, bindings: fixture.bindings,
      skillBytes: Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"), operation: "apply", runtime,
    })
    expect(() => verifyNativeSkillLoadVerificationProof({
      proof: wrongOperationProof.proof,
      bytes: wrongOperationProof.bytes,
      bindings: fixture.bindings,
      expectedFileSha256: fixture.bindings.originalSha256,
      projectRootSha256: wrongOperationProof.record.projectRootSha256,
      operation: "rollback",
    })).toThrow("native-load-proof-binding-mismatch")
    expect(applyProof.record.invocation.requestTextSha256).toBe(applyProof.record.canary.taskSha256)
    expect(applyProof.record.prompt.evaluatorSystemStartByte).toBeGreaterThanOrEqual(applyProof.record.prompt.instructionEndByte)
    const applyScore = scoreNativeFixtureResponse(applyProof.fixture, applyProof.responseText)
    expect(applyScore).toMatchObject({ status: "valid", hardPass: true, outputSha256: applyProof.record.response.sha256 })
    const applyWitness = storeNativeProof(fixture, "candidate-load", applyProof)
    const committed = await recordNativeLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness: applyWitness, proof: applyProof.proof, handoff,
    })
    expect(committed.state).toBe("COMMITTED")
    expect(committed.nativeCommit).toBeDefined()
    const runDirectory = join(fixture.sandbox.transactionRoot, fixture.runId)
    const applyReceiptPath = join(runDirectory, `native-commit-${applyWitness.sha256}.json`)
    const applyTransactionBytes = readFileSync(join(runDirectory, "original.bin")).byteLength +
      readFileSync(join(runDirectory, "manifest.json")).byteLength + readFileSync(join(runDirectory, "journal.jsonl")).byteLength +
      fixture.candidateBytes.byteLength + readFileSync(applyReceiptPath).byteLength
    expect(applyTransactionBytes).toBeLessThanOrEqual(applyBudget.transactionBytes)
    expect(readFileSync(join(runDirectory, "original.bin")).byteLength).toBeLessThanOrEqual(16_384)
    expect(readFileSync(join(runDirectory, "manifest.json")).byteLength).toBeLessThanOrEqual(64 * 1024)
    expect(readFileSync(join(runDirectory, "journal.jsonl")).byteLength).toBeLessThanOrEqual(1024 * 1024)
    expect(readFileSync(applyReceiptPath).byteLength).toBeLessThanOrEqual(64 * 1024)
    expect(existsSync(join(runDirectory, "qualification.json"))).toBe(false)
    expect(existsSync(join(runDirectory, "review.json"))).toBe(false)
    expect(() => verifyNativeSkillLoadVerificationProof({
      proof: applyProof.proof,
      bytes: applyProof.bytes,
      bindings: fixture.bindings,
      expectedFileSha256: fixture.bindings.candidateSha256,
      projectRootSha256: applyProof.record.projectRootSha256,
      operation: "apply",
    })).toThrow("native-load-proof-invalid-or-consumed")
    expect(readJournal(fixture).at(-1)).toMatchObject({
      state: "COMMITTED", details: { witnessMode: "native", witnessSchema: NATIVE_SKILL_LOAD_WITNESS_SCHEMA, witnessSha256: applyWitness.sha256 },
    })
    expect(readFileSync(join(fixture.sandbox.transactionRoot, fixture.runId, "original.bin")))
      .toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
    const nativeCommit = committed.nativeCommit!
    expect(() => consumeNativePromotionCanaryCommit({ ...nativeCommit } as typeof nativeCommit, {
      handoffId: handoffReceipt.handoffId, bindings: fixture.bindings,
    })).toThrow("native-commit-invalid-or-consumed")
    expect(() => consumeNativePromotionCanaryCommit(nativeCommit, {
      handoffId: handoffReceipt.handoffId, bindings: { ...fixture.bindings, candidateSha256: fixture.bindings.originalSha256 },
    })).toThrow("native-commit-binding-mismatch")
    consumeNativePromotionCanaryCommit(nativeCommit, {
      handoffId: handoffReceipt.handoffId, bindings: handoffReceipt.bindings,
    })
    expect(() => consumeNativePromotionCanaryCommit(nativeCommit, {
      handoffId: handoffReceipt.handoffId, bindings: handoffReceipt.bindings,
    })).toThrow("native-commit-invalid-or-consumed")

    const rollbackBudget = nativePromotionArtifactBudget("rollback")
    expect(applyBudget.approvalBytes + applyBudget.transactionBytes + applyBudget.witnessBytes +
      rollbackBudget.approvalBytes + rollbackBudget.transactionBytes + rollbackBudget.witnessBytes + originalEvidenceBytes)
      .toBeLessThanOrEqual(256 * 1024 * 1024)
    const journalBeforeRollback = readFileSync(join(runDirectory, "journal.jsonl")).byteLength
    const rollbackAuthorization = await nativeRollbackAuthorization(fixture)
    expect(readFileSync(rollbackAuthorization.approvalRecord.path).byteLength).toBeLessThanOrEqual(rollbackBudget.approvalBytes)
    assertNativeRollbackAuthorizationCurrent({ ...nativePromotionCommon(fixture), owner: fixture.nativeOwner!.store,
      nativeAuthorization: rollbackAuthorization.authorization })
    const rollback = await rollbackSkillOptPromotion({ ...nativePromotionCommon(fixture),
      nativeAuthorization: rollbackAuthorization.authorization })
    expect(rollback).toMatchObject({ state: "ROLLBACK_SWAP_INTENT" })
    expect("nativeRollbackCommit" in rollback).toBe(false)
    expect(readJournal(fixture).find(record => record.state === "ROLLBACK_PREPARED")?.details.operatorApprovalSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
    expect(() => assertNativeRollbackAuthorizationCurrent({ ...nativePromotionCommon(fixture),
      owner: fixture.nativeOwner!.store, nativeAuthorization: rollbackAuthorization.authorization }))
      .toThrow("native-rollback-authorization-invalid-or-consumed")

    const rollbackHandoff = await verifyNativeRollbackCanaryHandoff(fixture.apply())
    expect(() => consumeNativePromotionCanaryHandoff(rollbackHandoff as unknown as NativePromotionCanaryHandoff))
      .toThrow("native-handoff-invalid-or-consumed")
    expect(() => consumeNativeRollbackCanaryHandoff({ ...rollbackHandoff } as NativeRollbackCanaryHandoff,
      { bindings: fixture.bindings })).toThrow("native-rollback-handoff-invalid-or-consumed")
    const rollbackHandoffReceipt = consumeNativeRollbackCanaryHandoff(rollbackHandoff, { bindings: fixture.bindings })
    expect(Object.isFrozen(rollbackHandoffReceipt)).toBe(true)
    expect(Object.isFrozen(rollbackHandoffReceipt.bindings)).toBe(true)
    expect(Object.isFrozen(rollbackHandoffReceipt.evidence)).toBe(true)
    expect(rollbackHandoffReceipt.semanticReviewSha256).toBe(handoffReceipt.semanticReviewSha256)
    expect(rollbackHandoffReceipt.rollbackApprovalSha256)
      .toBe(readJournal(fixture).find(record => record.state === "ROLLBACK_PREPARED")?.details.operatorApprovalSha256)
    expect(() => consumeNativeRollbackCanaryHandoff(rollbackHandoff, { bindings: fixture.bindings }))
      .toThrow("native-rollback-handoff-invalid-or-consumed")
    await expect(recordNativeRollbackLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness: applyWitness, proof: applyProof.proof,
      handoff: handoff as unknown as NativeRollbackCanaryHandoff,
    })).rejects.toMatchObject({ code: "native-rollback-handoff-invalid-or-consumed" })

    commitSyntheticSkillBaseline(fixture.projectRoot, "restored original synthetic skill")
    const rollbackProof = await createSyntheticNativeLoadProof({
      projectRoot: fixture.projectRoot, bindings: fixture.bindings,
      skillBytes: Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"), operation: "rollback", runtime,
    })
    expect(rollbackProof.bytes.byteLength).toBeLessThanOrEqual(rollbackBudget.witnessBytes)
    expect(rollbackProof.record.invocation.requestTextSha256).toBe(rollbackProof.record.canary.taskSha256)
    expect(rollbackProof.record.prompt.evaluatorSystemStartByte).toBeGreaterThanOrEqual(rollbackProof.record.prompt.instructionEndByte)
    const rollbackScore = scoreNativeFixtureResponse(rollbackProof.fixture, rollbackProof.responseText)
    expect(rollbackScore).toMatchObject({ status: "valid", hardPass: true, outputSha256: rollbackProof.record.response.sha256 })
    const rollbackWitness = storeNativeProof(fixture, "original-load", rollbackProof)
    const rolledBack = await recordNativeRollbackLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness: rollbackWitness, proof: rollbackProof.proof,
      handoff: rollbackHandoff,
    })
    expect(rolledBack.state).toBe("ROLLED_BACK")
    expect(rolledBack.nativeRollbackCommit).toBeDefined()
    expect(() => consumeNativeRollbackCanaryCommit({ ...rolledBack.nativeRollbackCommit! } as NonNullable<typeof rolledBack.nativeRollbackCommit>, {
      handoffId: rollbackHandoffReceipt.handoffId, bindings: fixture.bindings,
    })).toThrow("native-rollback-commit-invalid-or-consumed")
    expect(() => consumeNativeRollbackCanaryCommit(rolledBack.nativeRollbackCommit!, {
      handoffId: rollbackHandoffReceipt.handoffId,
      bindings: { ...fixture.bindings, candidateSha256: fixture.bindings.originalSha256 },
    })).toThrow("native-rollback-commit-binding-mismatch")
    consumeNativeRollbackCanaryCommit(rolledBack.nativeRollbackCommit!, {
      handoffId: rollbackHandoffReceipt.handoffId, bindings: rollbackHandoffReceipt.bindings,
    })
    expect(() => consumeNativeRollbackCanaryCommit(rolledBack.nativeRollbackCommit!, {
      handoffId: rollbackHandoffReceipt.handoffId, bindings: rollbackHandoffReceipt.bindings,
    })).toThrow("native-rollback-commit-invalid-or-consumed")
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
    const rollbackStageName = readJournal(fixture).find(record => record.state === "ROLLBACK_SWAP_INTENT")?.details.rollbackStageName
    expect(typeof rollbackStageName).toBe("string")
    expect(readFileSync(join(fixture.targetDirectory, rollbackStageName))).toEqual(Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"))
    expect(readFileSync(join(fixture.sandbox.transactionRoot, fixture.runId, "original.bin")))
      .toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
    const rollbackJournalBytes = readFileSync(join(runDirectory, "journal.jsonl")).byteLength
    const rollbackGeneratedBytes = rollbackJournalBytes - journalBeforeRollback + readFileSync(fixture.targetPath).byteLength
    expect(rollbackGeneratedBytes).toBeLessThanOrEqual(rollbackBudget.transactionBytes)
    expect(rollbackJournalBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(readFileSync(fixture.targetPath).byteLength).toBeLessThanOrEqual(16_384)
  })

  nativeTest("native commit rejects altered bytes from a synthetic CLI-host witness after a genuine handoff", async () => {
    const fixture = makeNativeTransactionFixture()
    initializeSyntheticSkillProject(fixture.projectRoot)
    commitSyntheticSkillBaseline(fixture.projectRoot, "original synthetic skill")
    const runtime = createSyntheticNativeRuntime(fixture.projectRoot)
    expect((await applyWithNativeApproval(fixture)).state).toBe("SWAPPED_EXPECTED")
    commitSyntheticSkillBaseline(fixture.projectRoot, "approved candidate skill")
    const proof = await createSyntheticNativeLoadProof({
      projectRoot: fixture.projectRoot, bindings: fixture.bindings,
      skillBytes: Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"), operation: "apply", runtime,
    })
    const alteredRecord = {
      ...proof.record,
      response: { ...proof.record.response, bytes: proof.record.response.bytes + 1 },
    }
    const witness = writeCanonicalRecord(join(fixture.evidenceDirectory, "altered-native-witness.json"), alteredRecord)
    const { handoff } = await issueNativePromotionHandoff(fixture)
    await expect(recordNativeLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness, proof: proof.proof, handoff,
    })).rejects.toMatchObject({ code: "native-load-proof-binding-mismatch" })
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"))
    expect(readJournal(fixture).at(-1)?.state).toBe("SWAPPED_EXPECTED")
  })

  nativeTest("a synthetic CLI-host original-byte rollback proof refuses a later same-inode third version", async () => {
    const fixture = makeNativeTransactionFixture()
    initializeSyntheticSkillProject(fixture.projectRoot)
    commitSyntheticSkillBaseline(fixture.projectRoot, "original synthetic skill")
    const runtime = createSyntheticNativeRuntime(fixture.projectRoot)
    expect((await applyWithNativeApproval(fixture)).state).toBe("SWAPPED_EXPECTED")
    commitSyntheticSkillBaseline(fixture.projectRoot, "approved candidate skill")
    const candidateProof = await createSyntheticNativeLoadProof({
      projectRoot: fixture.projectRoot, bindings: fixture.bindings,
      skillBytes: Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"), operation: "apply", runtime,
    })
    const candidateWitness = storeNativeProof(fixture, "candidate-load", candidateProof)
    const { handoff, receipt: handoffReceipt } = await issueNativePromotionHandoff(fixture)
    const committed = await recordNativeLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness: candidateWitness, proof: candidateProof.proof, handoff,
    })
    expect(committed.state).toBe("COMMITTED")
    expect(committed.nativeCommit).toBeDefined()
    consumeNativePromotionCanaryCommit(committed.nativeCommit!, {
      handoffId: handoffReceipt.handoffId, bindings: handoffReceipt.bindings,
    })
    expect(await rollbackWithNativeApproval(fixture)).toMatchObject({ state: "ROLLBACK_SWAP_INTENT" })
    const rollbackHandoff = await verifyNativeRollbackCanaryHandoff(fixture.apply())
    consumeNativeRollbackCanaryHandoff(rollbackHandoff, { bindings: fixture.bindings })
    commitSyntheticSkillBaseline(fixture.projectRoot, "restored original synthetic skill")
    const originalProof = await createSyntheticNativeLoadProof({
      projectRoot: fixture.projectRoot, bindings: fixture.bindings,
      skillBytes: Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"), operation: "rollback", runtime,
    })
    expect(scoreNativeFixtureResponse(originalProof.fixture, originalProof.responseText))
      .toMatchObject({ status: "valid", hardPass: true })
    const originalWitness = storeNativeProof(fixture, "original-load", originalProof)
    const originalInode = lstatSync(fixture.targetPath).ino
    writeFileSync(fixture.targetPath, THIRD)
    expect(lstatSync(fixture.targetPath).ino).toBe(originalInode)
    await expect(recordNativeRollbackLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness: originalWitness, proof: originalProof.proof,
      handoff: rollbackHandoff,
    })).rejects.toMatchObject({ code: "native-rollback-handoff-object-binding-mismatch" })
    expect(readFileSync(fixture.targetPath)).toEqual(THIRD)
    expect(readJournal(fixture).at(-1)?.state).toBe("ROLLBACK_SWAP_INTENT")
    const rollbackStageName = readJournal(fixture).find(record => record.state === "ROLLBACK_SWAP_INTENT")?.details.rollbackStageName
    expect(typeof rollbackStageName).toBe("string")
    expect(readFileSync(join(fixture.targetDirectory, rollbackStageName))).toEqual(Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"))
    expect(readFileSync(join(fixture.sandbox.transactionRoot, fixture.runId, "original.bin")))
      .toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
  })

  nativeTest("native rollback observer refuses a changed immutable backup or displaced candidate", async () => {
    for (const changed of ["backup", "candidate"] as const) {
      const fixture = makeNativeTransactionFixture()
      await beginNativeRollbackCanary(fixture)
      const rollbackIntent = readJournal(fixture).find(record => record.state === "ROLLBACK_SWAP_INTENT")!
      const changedPath = changed === "backup"
        ? join(fixture.sandbox.transactionRoot, fixture.runId, "original.bin")
        : join(fixture.targetDirectory, String(rollbackIntent.details.rollbackStageName))
      writeFileSync(changedPath, THIRD, { mode: 0o600 })

      await expect(verifyNativeRollbackCanaryHandoff(fixture.apply())).rejects.toBeDefined()
      expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
      expect(readJournal(fixture).at(-1)?.state).toBe("ROLLBACK_SWAP_INTENT")
    }
  })

  nativeTest("legacy load evidence cannot commit a native apply transaction", async () => {
    const fixture = makeNativeTransactionFixture()
    expect((await applyWithNativeApproval(fixture)).state).toBe("SWAPPED_EXPECTED")
    expect(JSON.parse(readFileSync(fixture.evidence.approval.path, "utf8")).bindings.witnessMode).toBe("native")
    expect(readJournal(fixture)[0]?.details.witnessMode).toBe("native")
    const legacyWitness = fixture.writeWitness()
    await expect(recordLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness: legacyWitness, verifyWitness: async () => undefined,
    })).rejects.toMatchObject({ code: "native-load-proof-required" })
    await expect(recordLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: { ...fixture.bindings, witnessMode: "legacy" }, witness: legacyWitness, verifyWitness: async () => undefined,
    })).rejects.toMatchObject({ code: "journal-binding-mismatch" })
    expectBytesEqual(readFileSync(fixture.targetPath), fixture.candidateBytes)
    expect(readJournal(fixture).at(-1)?.state).toBe("SWAPPED_EXPECTED")
  })

  nativeTest("legacy load evidence cannot commit a native rollback transaction", async () => {
    const fixture = makeNativeTransactionFixture()
    expect((await applyWithNativeApproval(fixture)).state).toBe("SWAPPED_EXPECTED")
    expect(await rollbackWithNativeApproval(fixture)).toMatchObject({ state: "ROLLBACK_SWAP_INTENT" })
    expect(readJournal(fixture).find(record => record.state === "ROLLBACK_PREPARED")?.details.witnessMode).toBe("native")
    expect(readJournal(fixture).find(record => record.state === "ROLLBACK_SWAP_INTENT")?.details.witnessMode).toBe("native")
    const legacyWitness = fixture.writeWitness(fixture.bindings.originalSha256)
    await expect(recordRollbackLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness: legacyWitness, verifyWitness: async () => undefined,
    })).rejects.toMatchObject({ code: "native-load-proof-required" })
    await expect(recordRollbackLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: { ...fixture.bindings, witnessMode: "legacy" }, witness: legacyWitness, verifyWitness: async () => undefined,
    })).rejects.toMatchObject({ code: "journal-binding-mismatch" })
    expectBytesEqual(readFileSync(fixture.targetPath), Buffer.from(SYNTHETIC_ORIGINAL_SKILL, "utf8"))
    expect(readJournal(fixture).at(-1)?.state).toBe("ROLLBACK_SWAP_INTENT")
  })

  nativeTest("serialized native-shaped evidence and a copied proof object cannot commit", async () => {
    const fixture = makeNativeTransactionFixture()
    expect((await applyWithNativeApproval(fixture)).state).toBe("SWAPPED_EXPECTED")
    const { handoff } = await issueNativePromotionHandoff(fixture)
    const expected = fixture.candidateBytes
    const targetStat = (path: string): readonly string[] => {
      const stat = lstatSync(path, { bigint: true })
      return [String(stat.dev), String(stat.ino), String(stat.mode), String(stat.nlink), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]
    }
    const worktree = fixture.projectRoot
    const root = targetStat(worktree)
    const agents = targetStat(join(worktree, ".agents"))
    const skills = targetStat(join(worktree, ".agents", "skills"))
    const skill = targetStat(fixture.targetDirectory)
    const file = targetStat(fixture.targetPath)
    const projectRootSha256 = hash(worktree)
    const manifestSha256 = hash("captured-manifest")
    const fileIdentitySha256 = hash(JSON.stringify({
      version: "fd-tree-openat-fstat-and-captured-bytes-v1", projectRootSha256,
      root, agents, skills, skill, file, skillFileSha256: hash(expected), manifestSha256,
    }))
    const responseSha256 = hash("untrusted model response")
    const taskSha256 = hash("unbound canary task")
    const evaluatorSystemInstructions = "Return the fixture result as JSON."
    const evaluatorSystemSha256 = hash(evaluatorSystemInstructions)
    const identity = {
      engine: fixture.bindings.nativeEngine,
      requestedModel: fixture.bindings.nativeModel,
      runtimeIdentity: {
        version: fixture.bindings.nativeRuntimeVersion,
        executableSha256: fixture.bindings.nativeExecutableSha256,
      },
      profileIdentity: { id: fixture.bindings.nativeProfileId, sha256: fixture.bindings.nativeProfileSha256 },
    }
    const witness = {
      schema: NATIVE_SKILL_LOAD_WITNESS_SCHEMA,
      operation: "apply",
      runId: fixture.bindings.runId,
      witnessMode: "native",
      rootBinding: fixture.bindings.rootBinding,
      projectRootSha256,
      bindingsSha256: hash(canonicalJson(fixture.bindings)),
      sourceSha256: fixture.bindings.sourceSha256,
      originalSha256: fixture.bindings.originalSha256,
      candidateSha256: fixture.bindings.candidateSha256,
      expectedFileSha256: fixture.bindings.candidateSha256,
      fixturePackSha256: fixture.bindings.fixturePackSha256,
      canaryFixtureSha256: fixture.bindings.canaryFixtureSha256,
      protocolSha256: fixture.bindings.protocolSha256,
      evaluatorSha256: fixture.bindings.evaluatorSha256,
      runtimeSha256: fixture.bindings.runtimeSha256,
      resultsSha256: fixture.bindings.resultsSha256,
      witnessSha256: fixture.bindings.witnessSha256,
      skillPath: ".agents/skills/llm-wiki/SKILL.md",
      capture: {
        source: "project", identity: "project:.agents/skills/llm-wiki", classification: "custom",
        manifestSha256, contentHash: manifestSha256, skillFileSha256: hash(expected), skillFileBytes: expected.byteLength,
      },
      invocation: {
        sessionID: "session_1", attachmentEpoch: "epoch_1", executionID: "execution_1", taskID: "task_1",
        attemptID: "attempt_1", generation: 1, role: "main", invocationID: "invocation_1", requestTextSha256: taskSha256,
      },
      prompt: {
        sha256: hash("prompt"), bytes: expected.byteLength + 4 + Buffer.byteLength(evaluatorSystemInstructions),
        instructionSha256: hash(expected), instructionBytes: expected.byteLength,
        instructionStartByte: 2, instructionEndByte: expected.byteLength + 2,
        spanBasis: "exact-captured-instruction-utf8-substring-v1",
        evaluatorSystemSha256, evaluatorSystemBytes: Buffer.byteLength(evaluatorSystemInstructions),
        evaluatorSystemStartByte: expected.byteLength + 2,
        evaluatorSystemEndByte: expected.byteLength + 2 + Buffer.byteLength(evaluatorSystemInstructions),
        evaluatorSpanBasis: "exact-code-owned-evaluator-utf8-substring-v1",
      },
      native: {
        engine: fixture.bindings.nativeEngine, requestedModel: fixture.bindings.nativeModel,
        identityBefore: identity, identityAfter: identity, identitySha256: hash(canonicalJson(identity)), identityStable: true,
      },
      fileIdentity: {
        beforeSha256: fileIdentitySha256, afterSha256: fileIdentitySha256, root, agents, skills, skill, file,
        basis: "fd-tree-openat-fstat-and-captured-bytes-v1",
      },
      response: { sha256: responseSha256, bytes: Buffer.byteLength("untrusted model response") },
      canary: {
        fixturePackSha256: fixture.bindings.fixturePackSha256, fixtureId: "dev-0",
        fixtureSha256: fixture.bindings.canaryFixtureSha256, split: "dev", taskSha256,
        evaluatorPromptSha256: hash("evaluator prompt"), evaluatorSystemSha256,
        protocolSha256: fixture.bindings.protocolSha256,
        evaluatorSha256: fixture.bindings.evaluatorSha256, status: "valid", hardPass: true,
        outputSha256: responseSha256, scoreSha256: hash("fabricated score"),
      },
      quiescence: { status: "completed", quiescent: true, reconciliation: "terminal-quiescent" },
    }
    const recordPath = join(fixture.evidenceDirectory, `native-witness-${randomUUID()}.json`)
    const recordBytes = Buffer.from(canonicalJson(witness), "utf8")
    writeFileSync(recordPath, recordBytes, { mode: 0o600, flag: "wx" })
    const witnessRef = { path: resolve(recordPath), sha256: hash(recordBytes) }
    await expect(recordNativeLoadVerification({
      targetPath: fixture.targetPath, transactionRoot: fixture.sandbox.transactionRoot, nativeHelperPath, nativeHelperSha256,
      bindings: fixture.bindings, witness: witnessRef, proof: {} as unknown as NativeSkillLoadVerificationProof, handoff,
    })).rejects.toMatchObject({ code: "native-load-proof-invalid-or-consumed" })
    expect(readFileSync(fixture.targetPath)).toEqual(Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8"))
    expect(readJournal(fixture).at(-1)?.state).toBe("SWAPPED_EXPECTED")
  })
})
