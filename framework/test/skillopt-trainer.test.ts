import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import * as nodeFs from "node:fs"
import { existsSync, mkdirSync, lstatSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ExecutionHost, ExecutionRequest, ExecutionReconciliation } from "../src/hosts/types.ts"
import { attachAdmission, detachAdmission } from "../src/sessions/admission.ts"
import { tempWorktree, type TempWorktree } from "./guards-helpers.ts"
import {
  createNativeDataset, NATIVE_FIXTURE_PACK_SCHEMA, NATIVE_PROTECTED_CHANGES, NATIVE_WIKI_CONTRACT,
  NATIVE_WIKI_SPLIT_MINIMUMS, NATIVE_WIKI_SPLITS, NATIVE_WIKI_STRATA,
  type NativeModelBindings, type NativeWikiSplit, type NativeWikiStratum,
} from "../src/skillopt/dataset.ts"
import { createNativeSkillOptBroker } from "../src/skillopt/broker.ts"
import { buildSkillOptNativeHelper } from "../src/skillopt/native-helper.ts"
import { PILOT_SKILL, sha256 } from "../src/skillopt/pilot.ts"
import {
  deleteNativeSkillOptTrainerCleanup, inspectNativeSkillOptTrainerCleanup, markNativeSkillOptTrainerClosed,
  NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES, NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES,
  nativeSkillOptTrainerMaterializationMetadata,
  planNativeSkillOptTrainerMaterialization, prepareNativeSkillOptTrainer,
  type NativeSkillOptTrainerPreparation,
} from "../src/skillopt/trainer.ts"
import { executionRunDirectory } from "../src/state/store.ts"
import { isGenuineCompletedQuiescentTrainerResult, type OwnedWorkerResult } from "../src/skillopt/host.ts"
import type { SkillOptPrepared } from "../src/skillopt/controller.ts"

const supportedNative = process.platform === "darwin" || process.platform === "linux"
const baseline = Buffer.from("---\nname: llm-wiki\ndescription: Private trainer integration fixture\n---\n\nSynthetic protected baseline.\n", "utf8")
const modelBindings: NativeModelBindings = Object.freeze({
  generator: Object.freeze({ engine: "codex", requestedModel: "gpt-5-codex",
    runtimeIdentity: Object.freeze({ version: "synthetic codex metadata", executableSha256: sha256("codex executable") }),
    profileIdentity: Object.freeze({ id: "codex-profile", sha256: sha256("codex profile") }) }),
  target: Object.freeze({ engine: "claude", requestedModel: "claude-target-test",
    runtimeIdentity: Object.freeze({ version: "synthetic claude metadata", executableSha256: sha256("claude executable") }),
    profileIdentity: Object.freeze({ id: "claude-target-profile", sha256: sha256("claude target profile") }) }),
  reviewer: Object.freeze({ engine: "claude", requestedModel: "claude-review-test",
    runtimeIdentity: Object.freeze({ version: "synthetic claude metadata", executableSha256: sha256("claude executable") }),
    profileIdentity: Object.freeze({ id: "claude-review-profile", sha256: sha256("claude review profile") }) }),
})

let nativeHelper: ReturnType<typeof buildSkillOptNativeHelper> | undefined

type TrainerFixture = {
  worktree: TempWorktree
  root: string
  runtime: ReturnType<typeof createExecutionRuntime>
  owner: ReturnType<typeof attachAdmission>
  broker: ReturnType<typeof createNativeSkillOptBroker>
  dataset: ReturnType<typeof createNativeDataset>
  prepared: SkillOptPrepared
  trainerPreparations: Array<Extract<NativeSkillOptTrainerPreparation, { state: "READY" }>>
}
const fixtures: TrainerFixture[] = []

function makeFixture(split: NativeWikiSplit, index: number, stratum: NativeWikiStratum) {
  const id = `${split}-${index}`
  const sourceId = `source-${id}`
  const slotId = `slot-${id}`
  const leftId = `fact-${id}-left`
  const rightId = `fact-${id}-right`
  const leftStatement = `Synthetic supported observation A for ${id}.`
  const rightStatement = `Synthetic supported observation B for ${id}.`
  const sourceContent = `${leftStatement}\n${rightStatement}\n`
  const sourceSha256 = sha256(sourceContent)
  return {
    id, familyId: `family-${id}`, lineage: [`lineage-${id}`], split, stratum, authorship: "agent-authored" as const,
    sources: [{ id: sourceId, provenance: "raw" as const, content: sourceContent, sha256: sourceSha256 }],
    task: `Prepare a bounded update for [[slot:${slotId}]] using its selected source.`,
    outputSlots: [{ id: slotId, kind: "page" as const,
      existingContent: stratum === "dedup-resume" || stratum === "ownership-injection" ? `Existing approved bytes for ${id}.\n` : "" }],
    assertions: {
      facts: [
        { id: leftId, slotId, statement: leftStatement, sourceIds: [sourceId] },
        { id: rightId, slotId, statement: rightStatement, sourceIds: [sourceId] },
      ],
      citations: [{ factId: leftId, sourceId }, { factId: rightId, sourceId }],
      contradictions: stratum === "correction-conflict"
        ? [{ leftFactId: leftId, rightFactId: rightId, expected: "mark-unknown" as const }] : [],
      deduplication: stratum === "dedup-resume" ? [{ slotId, expected: "reuse-existing" as const }] : [],
      ownership: stratum === "ownership-injection" ? [{ slotId, expected: "preserve-existing" as const }] : [],
    },
    forbiddenChanges: [...NATIVE_PROTECTED_CHANGES],
  }
}

function makePack() {
  const packFixtures: ReturnType<typeof makeFixture>[] = []
  for (const split of NATIVE_WIKI_SPLITS) {
    for (let index = 0; index < NATIVE_WIKI_SPLIT_MINIMUMS[split]; index += 1) {
      packFixtures.push(makeFixture(split, index, NATIVE_WIKI_STRATA[index % NATIVE_WIKI_STRATA.length]!))
    }
  }
  return { schema: NATIVE_FIXTURE_PACK_SCHEMA, contract: NATIVE_WIKI_CONTRACT, fixtures: packFixtures }
}

async function makeTrainerFixture(): Promise<TrainerFixture> {
  if (!nativeHelper) throw new Error("native SkillOpt helper was not prepared")
  const worktree = tempWorktree()
  const root = realpathSync.native(worktree.worktree)
  const host: ExecutionHost = {
    identity: { engine: "codex", profile: "legacy-unowned" },
    async preflight() { return { compatible: true, controls: {}, problems: [] } },
    async prepare(_request: ExecutionRequest) { throw new Error("trainer preparation must not dispatch through the generic host") },
    async reconcile(): Promise<ExecutionReconciliation> {
      return { outcome: "unknown", quiescent: false, evidence: "trainer fixture did not execute a model" }
    },
  }
  const runtime = createExecutionRuntime({ directory: root, worktree: root, config: structuredClone(DEFAULT_CONFIG), log() {} },
    () => host, { planningOnlyMain: true })
  const owner = attachAdmission(runtime, `session_${randomUUID().replaceAll("-", "")}`,
    { engine: modelBindings.generator.engine, model: modelBindings.generator.requestedModel })
  const baselinePath = join(root, PILOT_SKILL)
  mkdirSync(dirname(baselinePath), { recursive: true, mode: 0o700 })
  writeFileSync(baselinePath, baseline, { flag: "wx", mode: 0o600 })
  const selectedSource = Buffer.from("Private synthetic selected source for trainer tests.\n", "utf8")
  const sourcePath = `knowledge/raw/documents/${sha256(selectedSource)}.md`
  const absoluteSource = join(root, sourcePath)
  mkdirSync(dirname(absoluteSource), { recursive: true, mode: 0o700 })
  writeFileSync(absoluteSource, selectedSource, { flag: "wx", mode: 0o600 })
  const dataset = createNativeDataset({ root, selections: [{ path: sourcePath }], fixturePack: makePack(), modelBindings })
  if (dataset.status !== "STRUCTURALLY_VALID") throw new Error("private synthetic trainer dataset is incomplete")
  const broker = createNativeSkillOptBroker(runtime, nativeHelper.helper)
  broker.controller.initialize()
  const prepared = broker.controller.prepare({ owner, campaignId: `campaign_${randomUUID().replaceAll("-", "")}`,
    dataset, baselineSkillSha256: sha256(baseline) })
  if (prepared.state !== "PREPARED") throw new Error("actual controller did not prepare the trainer fixture")
  const fixture = { worktree, root, runtime, owner, broker, dataset, prepared, trainerPreparations: [] }
  fixtures.push(fixture)
  return fixture
}

function authorizeTrainerMaterialization(
  fixture: TrainerFixture,
  runtime: Readonly<{ executablePath: string; nativeRuntimeProofPath: string }>,
) {
  const current = { dataset: fixture.dataset, baselineSkillSha256: sha256(baseline) }
  const plan = planNativeSkillOptTrainerMaterialization({ worktree: fixture.root, runtime,
    dataset: fixture.dataset, prepared: fixture.prepared, baselineSkillBytes: baseline })
  const materialization = nativeSkillOptTrainerMaterializationMetadata(plan)
  const allowance = fixture.broker.controller.reserveNativeTrainerMaterialization({ owner: fixture.owner,
    runtime: fixture.runtime, prepared: fixture.prepared, current, materialization })
  return { current, plan, materialization, allowance }
}

function configuredWorkerRuntime(): Readonly<{ executablePath: string; nativeRuntimeProofPath: string }> | undefined {
  const executablePath = process.env.SKILLOPT_PYTHON
  if (executablePath === undefined) return undefined
  try {
    if (!executablePath.startsWith("/") || resolve(executablePath) !== executablePath ||
        realpathSync.native(executablePath) !== executablePath) throw new Error()
    const runtimeRoot = resolve(dirname(dirname(executablePath)))
    const nativeRuntimeProofPath = resolve(dirname(runtimeRoot), "native-runtime-proof.json")
    if (realpathSync.native(nativeRuntimeProofPath) !== nativeRuntimeProofPath || !lstatSync(executablePath).isFile() ||
        !lstatSync(nativeRuntimeProofPath).isFile()) throw new Error()
    return Object.freeze({ executablePath, nativeRuntimeProofPath })
  } catch { throw new Error("configured native worker runtime is invalid") }
}

beforeAll(() => {
  if (supportedNative) nativeHelper = buildSkillOptNativeHelper()
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    try {
      const preparations = fixture.trainerPreparations.splice(0).reverse()
      const scratchDirectories = preparations.map(preparation => preparation.scratchDirectory)
      for (const preparation of preparations) preparation.cleanup()
      const descriptor = join(executionRunDirectory(fixture.root), "skillopt-native-foreground", `${fixture.prepared.runId}.trainer.json`)
      try {
        const persisted = JSON.parse(readFileSync(descriptor, "utf8")) as { root?: { path?: unknown } }
        if (typeof persisted.root?.path === "string") scratchDirectories.push(persisted.root.path)
      } catch { /* A malformed fixture descriptor is retained until the isolated worktree is removed. */ }
      let snapshot: ReturnType<typeof inspectNativeSkillOptTrainerCleanup> = null
      try { snapshot = inspectNativeSkillOptTrainerCleanup(fixture.root, fixture.prepared.runId) }
      catch { snapshot = null }
      if (snapshot?.state === "deleted") {
        try { unlinkSync(descriptor) } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error }
      }
      for (const scratchDirectory of scratchDirectories) rmSync(`${scratchDirectory}.cleanup`, { recursive: true, force: true })
      if (!fixture.owner.isReleased) await detachAdmission(fixture.runtime, fixture.owner.sessionID, fixture.owner.epoch, "trainer_test_complete")
    } finally { fixture.worktree.cleanup() }
  }
})

afterAll(() => nativeHelper?.dispose())

const nativeTest = supportedNative ? test : test.skip

test("trainer cleanup metadata reservation covers one marker and four descriptor payloads", () => {
  expect(NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES).toBe(69_632)
})

test("trainer output reservation matches the pinned native-runner writer bound", () => {
  expect(NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES).toBe(32_484_710)
})

nativeTest("missing runtime is DATA_REQUIRED and a planned unavailable runtime is BLOCKED without dispatch", async () => {
  const fixture = await makeTrainerFixture()
  expect(inspectNativeSkillOptTrainerCleanup(fixture.root, fixture.prepared.runId)).toBeNull()
  const noRuntime = await prepareNativeSkillOptTrainer({ worktree: fixture.root, dataset: fixture.dataset,
    prepared: fixture.prepared, baselineSkillBytes: baseline })
  expect(noRuntime).toEqual({ state: "DATA_REQUIRED", reasonCode: "trainer_runtime_required" })

  const missingExecutable = join(fixture.root, "skillopt", "runtime", "fa4ca184573e42ec11472959dd57422381418096", "venv", "bin", "python")
  const missingProof = join(fixture.root, "skillopt", "runtime", "fa4ca184573e42ec11472959dd57422381418096", "native-runtime-proof.json")
  const runtime = { executablePath: missingExecutable, nativeRuntimeProofPath: missingProof }
  const before = fixture.broker.controller.status().remaining.artifactBytes
  const authorization = authorizeTrainerMaterialization(fixture, runtime)
  const materializedBytes = authorization.materialization.projectionBytes + authorization.materialization.manifestBytes * 2 +
    NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES + NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES
  expect(fixture.broker.controller.status().remaining.artifactBytes).toBe(before - materializedBytes)
  const blocked = await prepareNativeSkillOptTrainer({ worktree: fixture.root,
    runtime, dataset: fixture.dataset, prepared: fixture.prepared, baselineSkillBytes: baseline,
    owner: fixture.owner, executionRuntime: fixture.runtime, controller: fixture.broker.controller,
    current: authorization.current, plan: authorization.plan, allowance: authorization.allowance })
  expect(blocked.state).toBe("BLOCKED")
  const after = fixture.broker.controller.status()
  expect(after.remaining.artifactBytes).toBe(before - materializedBytes)
  expect(after.requestCounts).toEqual({ charged: { target: 0, optimizer: 0, reviewer: 0 },
    dispatched: { target: 0, optimizer: 0, reviewer: 0 }, unknown: { target: 0, optimizer: 0, reviewer: 0 } })
  expect(fixture.runtime.runs.status().executions).toHaveLength(0)
  expect(existsSync(missingExecutable)).toBe(false)
  expect(existsSync(missingProof)).toBe(false)
  expect(inspectNativeSkillOptTrainerCleanup(fixture.root, fixture.prepared.runId)?.state).toBe("deleted")
})

const configuredRuntime = configuredWorkerRuntime()
test.skipIf(!supportedNative || !configuredRuntime)("only an actually READY host profile exposes trainer inputs and identity-safe cleanup", async () => {
  const fixture = await makeTrainerFixture()
  if (!configuredRuntime) throw new Error("configured native worker runtime was not selected")
  const authorization = authorizeTrainerMaterialization(fixture, configuredRuntime)
  const prepared = await prepareNativeSkillOptTrainer({ worktree: fixture.root, runtime: configuredRuntime,
    dataset: fixture.dataset, prepared: fixture.prepared, baselineSkillBytes: baseline, owner: fixture.owner,
    executionRuntime: fixture.runtime, controller: fixture.broker.controller, current: authorization.current,
    plan: authorization.plan, allowance: authorization.allowance })
  if (prepared.state !== "READY") throw new Error(`host did not prove trainer containment: ${prepared.reasonCode}`)
  fixture.trainerPreparations.push(prepared)
  expect(prepared.trainer.profile.binding.role).toBe("trainer")
  expect(prepared.trainer.profile.binding.inputSha256).toMatch(/^[a-f0-9]{64}$/u)
  expect(prepared.trainer.profile.binding.adapterManifestSha256).toMatch(/^[a-f0-9]{64}$/u)
  expect(prepared.trainer.profile.binding.runtime.kind).toBe("python")
  expect(prepared.trainer.receipt.status).toBe("READY")
  expect(prepared.trainer.receipt.bindingSha256).toBe(prepared.trainer.profile.binding.profileSha256)
  expect((lstatSync(prepared.scratchDirectory).mode & 0o777)).toBe(0o700)
  for (const child of ["input", "output", "home", "probe"]) {
    expect((lstatSync(join(prepared.scratchDirectory, child)).mode & 0o777)).toBe(0o700)
  }
  const descriptorPath = join(executionRunDirectory(fixture.root), "skillopt-native-foreground", `${fixture.prepared.runId}.trainer.json`)
  const descriptorText = readFileSync(descriptorPath, "utf8")
  const descriptor = JSON.parse(descriptorText)
  expect(Object.keys(descriptor).sort()).toEqual(["deletionProgress", "deletionSnapshotSha256", "kind", "marker", "quarantine", "root", "rootBinding", "runId", "schema", "state"])
  expect(descriptor).toMatchObject({ state: "created", kind: "trainer", runId: fixture.prepared.runId,
    rootBinding: sha256(`root:${fixture.root}`), deletionProgress: "none", deletionSnapshotSha256: null, quarantine: null })
  expect(descriptor.root.path).toBe(prepared.scratchDirectory)
  expect(descriptorText).not.toContain("Private synthetic selected source")
  expect((lstatSync(join(prepared.scratchDirectory, ".skillopt-private-scratch.v1")).mode & 0o777)).toBe(0o600)
  expect(() => inspectNativeSkillOptTrainerCleanup(fixture.root, fixture.prepared.runId))
    .toThrow("trainer_scratch_worker_not_closed")
  const forgedResult = Object.freeze({ status: "completed", exitCode: 0, signal: null, quiescent: true,
    stdoutBytes: 0, stderrBytes: 0, stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64) }) as OwnedWorkerResult
  expect(isGenuineCompletedQuiescentTrainerResult(forgedResult, prepared.trainer.profile, prepared.trainer.receipt)).toBe(false)
  expect(isGenuineCompletedQuiescentTrainerResult(Object.freeze({ ...forgedResult }), prepared.trainer.profile, prepared.trainer.receipt)).toBe(false)
  expect(() => markNativeSkillOptTrainerClosed(Object.freeze({ ...prepared.trainer }), forgedResult)).toThrow()
  expect(deleteNativeSkillOptTrainerCleanup(fixture.root, fixture.prepared.runId, {} as never, {} as never)).toBe(false)
  expect(deleteNativeSkillOptTrainerCleanup(fixture.root, fixture.prepared.runId,
    JSON.parse(JSON.stringify({})) as never, JSON.parse(JSON.stringify({})) as never)).toBe(false)
  expect(existsSync(prepared.scratchDirectory)).toBe(true)

  const outputPath = join(prepared.scratchDirectory, "output")
  const parkedOutputPath = `${outputPath}.parked`
  renameSync(outputPath, parkedOutputPath)
  symlinkSync(parkedOutputPath, outputPath)
  expect(() => inspectNativeSkillOptTrainerCleanup(fixture.root, fixture.prepared.runId)).toThrow()
  expect(existsSync(parkedOutputPath)).toBe(true)
  expect(existsSync(prepared.scratchDirectory)).toBe(true)
  unlinkSync(outputPath)
  renameSync(parkedOutputPath, outputPath)

  const parkedRoot = `${prepared.scratchDirectory}.parked`
  renameSync(prepared.scratchDirectory, parkedRoot)
  symlinkSync(parkedRoot, prepared.scratchDirectory)
  expect(() => inspectNativeSkillOptTrainerCleanup(fixture.root, fixture.prepared.runId)).toThrow()
  expect(existsSync(parkedRoot)).toBe(true)
  unlinkSync(prepared.scratchDirectory)
  renameSync(parkedRoot, prepared.scratchDirectory)

  const descriptorBackup = `${descriptorPath}.parked`
  renameSync(descriptorPath, descriptorBackup)
  writeFileSync(descriptorPath, "{\"state\":\"worker-closed\"}\n", { flag: "wx", mode: 0o600 })
  expect(() => inspectNativeSkillOptTrainerCleanup(fixture.root, fixture.prepared.runId)).toThrow()
  expect(prepared.cleanup()).toBe(false)
  expect(existsSync(prepared.scratchDirectory)).toBe(true)
  unlinkSync(descriptorPath)
  renameSync(descriptorBackup, descriptorPath)

  expect(fixture.broker.controller.status().requestCounts.dispatched).toEqual({ target: 0, optimizer: 0, reviewer: 0 })
  const nestedTreePath = join(prepared.scratchDirectory, "tree")
  const nestedBranchPath = join(nestedTreePath, "branch")
  mkdirSync(nestedTreePath, { mode: 0o700 })
  mkdirSync(nestedBranchPath, { mode: 0o700 })
  writeFileSync(join(nestedBranchPath, "cleanup-proof.txt"), "nested trainer cleanup proof\n", { flag: "wx", mode: 0o600 })
  expect(sha256("tree").localeCompare(sha256("tree/branch"))).toBeGreaterThan(0)
  expect(prepared.cleanup()).toBe(true)
  expect(existsSync(prepared.scratchDirectory)).toBe(false)
  expect(existsSync(nestedTreePath)).toBe(false)
  const deletionProof = inspectNativeSkillOptTrainerCleanup(fixture.root, fixture.prepared.runId)
  expect(deletionProof?.state).toBe("deleted")
  expect(deletionProof?.deletionProgress).toBe("complete")
  expect(deletionProof?.snapshotSha256).toMatch(/^[a-f0-9]{64}$/u)
  const completedDescriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as {
    deletionProgress?: unknown; deletionSnapshotSha256?: unknown
  }
  expect(completedDescriptor.deletionProgress).toBe("complete")
  expect(completedDescriptor.deletionSnapshotSha256).toMatch(/^[a-f0-9]{64}$/u)
  const completedDescriptorBytes = readFileSync(descriptorPath)
  expect(prepared.cleanup()).toBe(true)
  expect(readFileSync(descriptorPath)).toEqual(completedDescriptorBytes)
})

test.skipIf(!supportedNative || !configuredRuntime)("started cleanup refuses a missing root or missing approved entry without capture evidence", async () => {
  const fixture = await makeTrainerFixture()
  if (!configuredRuntime) throw new Error("configured native worker runtime was not selected")
  const authorization = authorizeTrainerMaterialization(fixture, configuredRuntime)
  const prepared = await prepareNativeSkillOptTrainer({ worktree: fixture.root, runtime: configuredRuntime,
    dataset: fixture.dataset, prepared: fixture.prepared, baselineSkillBytes: baseline, owner: fixture.owner,
    executionRuntime: fixture.runtime, controller: fixture.broker.controller, current: authorization.current,
    plan: authorization.plan, allowance: authorization.allowance })
  if (prepared.state !== "READY") throw new Error(`host did not prove trainer containment: ${prepared.reasonCode}`)
  fixture.trainerPreparations.push(prepared)

  const descriptorPath = join(executionRunDirectory(fixture.root), "skillopt-native-foreground", `${fixture.prepared.runId}.trainer.json`)
  const quarantinePath = `${prepared.scratchDirectory}.cleanup`
  let startedPersisted = false
  let injected = false
  const originalRename = nodeFs.renameSync
  const originalLstat = nodeFs.lstatSync
  const rename = spyOn(nodeFs, "renameSync").mockImplementation(((source: unknown, destination: unknown) => {
    const sourcePath = String(source)
    const result = originalRename(source as never, destination as never)
    if (sourcePath.endsWith(".deletion-started.tmp")) startedPersisted = true
    return result
  }) as typeof nodeFs.renameSync)
  const lstat = spyOn(nodeFs, "lstatSync").mockImplementation(((path: unknown, options?: unknown) => {
    if (startedPersisted && String(path) === quarantinePath) {
      injected = true
      throw new Error("simulated interruption after durable started record")
    }
    return originalLstat(path as never, options as never)
  }) as typeof nodeFs.lstatSync)
  try { expect(prepared.cleanup()).toBe(false) }
  finally { lstat.mockRestore(); rename.mockRestore() }

  expect(startedPersisted).toBe(true)
  expect(injected).toBe(true)
  expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toMatchObject({ deletionProgress: "started" })
  expect(readdirSync(quarantinePath)).toEqual([])

  const parkedRoot = `${prepared.scratchDirectory}.parked-root`
  renameSync(prepared.scratchDirectory, parkedRoot)
  expect(prepared.cleanup()).toBe(false)
  expect(existsSync(parkedRoot)).toBe(true)
  expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toMatchObject({ deletionProgress: "started" })
  expect(readdirSync(quarantinePath)).toEqual([])
  renameSync(parkedRoot, prepared.scratchDirectory)

  const approvedEntry = join(prepared.scratchDirectory, "input", "trainer-input.json")
  const parkedEntry = `${prepared.scratchDirectory}.parked-entry`
  const approvedBytes = readFileSync(approvedEntry)
  renameSync(approvedEntry, parkedEntry)
  expect(prepared.cleanup()).toBe(false)
  expect(readFileSync(parkedEntry)).toEqual(approvedBytes)
  expect(existsSync(prepared.scratchDirectory)).toBe(true)
  expect(readdirSync(quarantinePath)).toEqual([])
  renameSync(parkedEntry, approvedEntry)
  expect(prepared.cleanup()).toBe(false)
  expect(readFileSync(approvedEntry)).toEqual(approvedBytes)
  rmSync(prepared.scratchDirectory, { recursive: true, force: true })
})
