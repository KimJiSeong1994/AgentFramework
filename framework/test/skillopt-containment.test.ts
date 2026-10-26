import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { homedir, tmpdir } from "node:os"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ExecutionHost, ExecutionRequest, ExecutionReconciliation } from "../src/hosts/types.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import { consumeNativeTrainerProtocolStageAllowance, NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES } from "../src/skillopt/controller.ts"
import {
  consumeOwnedTrainerProtocolEvent, launchOwnedWorker,
  nativeSkillOptFixtureProbeSerializedBytes, nativeSkillOptFixtureResultByteBound,
  prepareWorkerProfile, probeWorkerContainment,
  SkillOptWorkerError, type OwnedTrainerProtocolEvent, type SkillOptContainmentReceipt,
  type SkillOptWorkerProfile, type WorkerProfileInput,
} from "../src/skillopt/host.ts"
import { createNativeSkillOptBroker } from "../src/skillopt/broker.ts"
import { buildNativeAdapterManifest } from "../src/skillopt/campaign-protocol.ts"
import {
  createNativeDataset, NATIVE_FIXTURE_PACK_SCHEMA, NATIVE_PROTECTED_CHANGES, NATIVE_WIKI_CONTRACT,
  NATIVE_DATASET_LIMITS, NATIVE_WIKI_OUTPUT_KINDS, NATIVE_WIKI_SPLIT_MINIMUMS, NATIVE_WIKI_SPLITS,
  NATIVE_WIKI_STRATA, trainerSafeProjection,
  type NativeModelBindings, type NativeWikiSplit, type NativeWikiStratum,
} from "../src/skillopt/dataset.ts"
import { buildSkillOptNativeHelper } from "../src/skillopt/native-helper.ts"
import { canonicalJson, PILOT_SKILL, sha256 } from "../src/skillopt/pilot.ts"
import {
  NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES,
  nativeSkillOptTrainerMaterializationMetadata, planNativeSkillOptTrainerMaterialization,
} from "../src/skillopt/trainer.ts"

const roots: string[] = []
const runtimeRoots: string[] = []
const trainerControllerFixtures: Array<{
  root: string
  owner: ReturnType<typeof attachAdmission>
  runtime: ReturnType<typeof createExecutionRuntime>
}> = []
let sharedPrivateRuntime: Readonly<{ executablePath: string; nativeRuntimeProofPath: string }> | undefined
let nativeHelper: ReturnType<typeof buildSkillOptNativeHelper> | undefined
const pythonRuntime = process.env.SKILLOPT_PYTHON ?? ""
const sourceLockSha256 = sha256(readFileSync(resolve(import.meta.dir, "../../scripts/skillopt-source-lock.json")))
const cachedBwrap = join(realpathSync.native(homedir()), ".cache/otter-skillopt-build-tools/root/usr/bin/bwrap")
const hasContainmentPrimitive = process.platform === "darwin"
  ? existsSync("/usr/bin/sandbox-exec")
  : process.platform === "linux" && (Boolean(Bun.which("bwrap")) || existsSync(cachedBwrap))
const hasConfiguredPythonRuntime = Boolean(pythonRuntime)
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
const baselineSkill = Buffer.from("---\nname: llm-wiki\ndescription: Private containment trainer fixture\n---\n\nSynthetic protected baseline.\n", "utf8")

beforeAll(() => {
  if (hasContainmentPrimitive && hasConfiguredPythonRuntime) nativeHelper = buildSkillOptNativeHelper()
})

afterEach(() => {
  for (const fixture of trainerControllerFixtures.splice(0).reverse()) {
    if (!fixture.owner.isReleased && !fixture.runtime.runs.status().claim) {
      fixture.owner.release({ workflowQuiescent: true, evidence: "trainer profile fixture completed without dispatch", workflowID: null, revision: null })
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  nativeHelper?.dispose()
  for (const root of runtimeRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureInput(outputSlots = [{ id: "page-main", kind: "page", existingContent: "" }]) {
  const content = "A selected source excerpt."
  return {
    task: "Write the selected page slot from this source.",
    sources: [{ id: "source-1", provenance: "contract", content, sha256: sha256(content) }],
    outputSlots,
  }
}

function profileInput(
  attestRuntime = true,
  isolateRuntime = false,
  value: ReturnType<typeof fixtureInput> = fixtureInput(),
): WorkerProfileInput {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "skillopt-containment-test-"))
  chmodSync(root, 0o700)
  roots.push(root)
  const inputDirectory = join(root, "input")
  const outputDirectory = join(root, "output")
  const emptyHomeDirectory = join(root, "home")
  const probeDirectory = join(root, "probe")
  for (const path of [inputDirectory, outputDirectory, emptyHomeDirectory, probeDirectory]) mkdirSync(path, { mode: 0o700 })
  const selectedInputPath = join(inputDirectory, "selected.json")
  writeFileSync(selectedInputPath, `${canonicalJson(value)}\n`, { mode: 0o600 })
  const configuredProofPath = pythonRuntime
    ? resolve(dirname(dirname(dirname(resolve(pythonRuntime)))), "native-runtime-proof.json")
    : ""
  const base = {
    executablePath: pythonRuntime,
    nativeRuntimeProofPath: configuredProofPath,
    selectedInputPath,
    outputDirectory,
    emptyHomeDirectory,
    probeDirectory,
  }
  const input = { ...base, role: "fixture" } as const
  return attestRuntime ? copyAttestedPrivateRuntime(input, isolateRuntime) : input
}

function expectContainmentReady(receipt: Awaited<ReturnType<typeof probeWorkerContainment>>): void {
  expect(receipt.code).toBe("ok")
  expect(receipt.status).toBe("READY")
  expect(receipt.probes).toEqual({
    selectedInputReadable: true,
    privateOutputWritable: true,
    homeSentinelDenied: true,
    worktreeSentinelDenied: true,
    productionSentinelDenied: true,
    networkDenied: true,
    subprocessDenied: true,
    threadCreationWorks: true,
    fileSizeLimitEnforced: true,
    openFilesLimitEnforced: true,
    addressSpaceLimitEnforced: true,
    cpuLimitEnforced: true,
    resourceCapsEnforced: true,
  })
}

test.skipIf(process.platform !== "linux" || !hasContainmentPrimitive || !hasConfiguredPythonRuntime)(
  "worker bootstrap keeps marker files private under a permissive parent umask and restores it",
  async () => {
    const profile = prepareWorkerProfile(profileInput())
    const previousUmask = process.umask(0o002)
    let umaskBeforeRestore: number | undefined
    let receipt: Awaited<ReturnType<typeof probeWorkerContainment>> | undefined
    try {
      receipt = await probeWorkerContainment(profile)
    } finally {
      umaskBeforeRestore = process.umask(previousUmask)
    }
    expect(umaskBeforeRestore).toBe(0o002)
    expect(receipt).toBeDefined()
    expectContainmentReady(receipt!)
    expect(receipt!.probes.privateOutputWritable).toBe(true)
  },
)

function expectDarwinAddressSpaceBlocked(receipt: Awaited<ReturnType<typeof probeWorkerContainment>>): void {
  expect(process.platform).toBe("darwin")
  expect(receipt.status).toBe("BLOCKED")
  expect(receipt.code).toBe("resource_limit_unenforced")
  expect(receipt.probes).toEqual({
    selectedInputReadable: false,
    privateOutputWritable: false,
    homeSentinelDenied: false,
    worktreeSentinelDenied: false,
    productionSentinelDenied: false,
    networkDenied: false,
    subprocessDenied: false,
    threadCreationWorks: false,
    fileSizeLimitEnforced: false,
    openFilesLimitEnforced: false,
    addressSpaceLimitEnforced: false,
    cpuLimitEnforced: false,
    resourceCapsEnforced: false,
  })
}

function copyAttestedPrivateRuntime(input: WorkerProfileInput, isolateRuntime: boolean): WorkerProfileInput {
  if (!hasConfiguredPythonRuntime) throw new Error("SKILLOPT_PYTHON is required")
  if (!isolateRuntime && sharedPrivateRuntime) {
    return { ...input, executablePath: sharedPrivateRuntime.executablePath,
      nativeRuntimeProofPath: sharedPrivateRuntime.nativeRuntimeProofPath }
  }
  if (!pythonRuntime || !pythonRuntime.startsWith(sep)) throw new Error("configured Python runtime path required")
  const sourceExecutablePath = resolve(pythonRuntime)
  const sourceRuntimeRoot = resolve(dirname(dirname(sourceExecutablePath)))
  if (sourceExecutablePath !== join(sourceRuntimeRoot, "bin", "python") ||
      realpathSync.native(sourceRuntimeRoot) !== sourceRuntimeRoot) {
    throw new Error("configured Python runtime path is not a canonical venv executable")
  }
  const sourcePyvenvConfigPath = join(sourceRuntimeRoot, "pyvenv.cfg")
  const sourceExecutableRealpath = realpathSync.native(sourceExecutablePath)
  if (!statSync(sourcePyvenvConfigPath).isFile() || !statSync(sourceExecutableRealpath).isFile()) {
    throw new Error("configured Python runtime files are unavailable")
  }
  const sourceLib = join(sourceRuntimeRoot, "lib")
  const sourceSitePackages = readdirSync(sourceLib, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^python\d+\.\d+$/u.test(entry.name))
    .map((entry) => join(sourceLib, entry.name, "site-packages"))
    .filter((path) => existsSync(path))
  if (sourceSitePackages.length !== 1) throw new Error("configured Python runtime site-packages is ambiguous")
  const sourceVirtualenvPth = join(sourceSitePackages[0]!, "_virtualenv.pth")
  const sourceVirtualenvModule = join(sourceSitePackages[0]!, "_virtualenv.py")
  if (!statSync(sourceVirtualenvPth).isFile() || !statSync(sourceVirtualenvModule).isFile()) {
    throw new Error("configured Python runtime virtualenv bootstrap files are unavailable")
  }
  const sourceVirtualenvPthBytes = readFileSync(sourceVirtualenvPth)
  if (sourceVirtualenvPthBytes.toString("utf8").trim() !== "import _virtualenv") {
    throw new Error("configured Python runtime virtualenv bootstrap differs from expected content")
  }
  const sourceVirtualenvModuleBytes = readFileSync(sourceVirtualenvModule)
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "skillopt-runtime-proof-test-"))
  chmodSync(root, 0o700)
  runtimeRoots.push(root)
  const runtimeRoot = join(root, "skillopt", "runtime", "fa4ca184573e42ec11472959dd57422381418096", "venv")
  mkdirSync(dirname(runtimeRoot), { recursive: true, mode: 0o700 })
  cpSync(sourceRuntimeRoot, runtimeRoot, { recursive: true, dereference: true })
  chmodSync(runtimeRoot, 0o700)
  const bin = join(runtimeRoot, "bin")
  chmodSync(bin, 0o700)
  const executablePath = join(bin, "python")
  rmSync(executablePath, { force: true })
  copyFileSync(sourceExecutableRealpath, executablePath)
  chmodSync(executablePath, 0o700)
  const copiedPyvenvConfigPath = join(runtimeRoot, "pyvenv.cfg")
  if (!readFileSync(copiedPyvenvConfigPath).equals(readFileSync(sourcePyvenvConfigPath))) {
    throw new Error("private runtime venv configuration differs from configured source")
  }
  const copiedVirtualenvPth = join(runtimeRoot, relative(sourceRuntimeRoot, sourceVirtualenvPth))
  const copiedVirtualenvModule = join(runtimeRoot, relative(sourceRuntimeRoot, sourceVirtualenvModule))
  if (!readFileSync(copiedVirtualenvPth).equals(sourceVirtualenvPthBytes) ||
      readFileSync(copiedVirtualenvPth, "utf8").trim() !== "import _virtualenv" ||
      !readFileSync(copiedVirtualenvModule).equals(sourceVirtualenvModuleBytes)) {
    throw new Error("private runtime virtualenv bootstrap differs from configured source")
  }
  rmSync(copiedVirtualenvPth)
  rmSync(copiedVirtualenvModule)
  if (existsSync(copiedVirtualenvPth) || existsSync(copiedVirtualenvModule) ||
      !readFileSync(sourceVirtualenvPth).equals(sourceVirtualenvPthBytes) ||
      !readFileSync(sourceVirtualenvModule).equals(sourceVirtualenvModuleBytes)) {
    throw new Error("virtualenv bootstrap removal escaped the synthetic private copy")
  }
  const expectedNativeRuntimeProofPath = resolve(dirname(runtimeRoot), "native-runtime-proof.json")
  const sourceLockPath = resolve(import.meta.dir, "../../scripts/skillopt-source-lock.json")
  const runnerPath = resolve(import.meta.dir, "../../scripts/skillopt_runner.py")
  const attestation = spawnSync(executablePath, ["-I", "-S", "-B", runnerPath, "attest-native-runtime", "--source-lock", sourceLockPath], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 512 * 1024, shell: false,
    env: { SKILLOPT_PYTHON: executablePath, HOME: input.emptyHomeDirectory },
  })
  if (attestation.error || attestation.status !== 0 || attestation.signal || attestation.stderr !== "" ||
      !attestation.stdout.endsWith("\n") || attestation.stdout.indexOf("\n") !== attestation.stdout.length - 1) {
    throw new Error("private copied runtime attestation failed")
  }
  const proofBytes = Buffer.from(attestation.stdout, "utf8")
  const proofSha256 = sha256(proofBytes)
  writeFileSync(expectedNativeRuntimeProofPath, proofBytes, { flag: "wx", mode: 0o600 })
  const proofStat = statSync(expectedNativeRuntimeProofPath)
  if ((proofStat.mode & 0o777) !== 0o600) throw new Error("private copied runtime proof is not private")
  const persistedProofBytes = readFileSync(expectedNativeRuntimeProofPath)
  if (!persistedProofBytes.equals(proofBytes) || sha256(persistedProofBytes) !== proofSha256 ||
      expectedNativeRuntimeProofPath !== resolve(dirname(runtimeRoot), "native-runtime-proof.json")) {
    throw new Error("private copied runtime proof bytes or path changed")
  }
  const copiedProof = JSON.parse(attestation.stdout) as Record<string, unknown>
  const copiedInterpreter = copiedProof.interpreter as Record<string, unknown>
  if (copiedInterpreter.realpath !== executablePath || copiedInterpreter.venvRoot !== runtimeRoot ||
      copiedInterpreter.sha256 !== sha256(readFileSync(executablePath)) ||
      copiedInterpreter.configuredPath !== executablePath ||
      copiedInterpreter.pyvenvConfigSha256 !== sha256(readFileSync(copiedPyvenvConfigPath))) {
    throw new Error("private copied runtime proof identity mismatch")
  }
  if ((statSync(runtimeRoot).mode & 0o777) !== 0o700 || (statSync(bin).mode & 0o777) !== 0o700 ||
      (statSync(executablePath).mode & 0o777) !== 0o700) {
    throw new Error("private copied runtime executable permissions are unsafe")
  }
  const runtime = { executablePath, nativeRuntimeProofPath: expectedNativeRuntimeProofPath }
  if (!isolateRuntime) sharedPrivateRuntime = runtime
  return { ...input, executablePath, nativeRuntimeProofPath: expectedNativeRuntimeProofPath }
}

function makeNativeFixture(split: NativeWikiSplit, index: number, stratum: NativeWikiStratum) {
  const id = `${split}-${index}`
  const sourceId = `source-${id}`
  const slotId = `slot-${id}`
  const leftId = `fact-${id}-left`
  const rightId = `fact-${id}-right`
  const leftStatement = `Synthetic supported observation A for ${id}.`
  const rightStatement = `Synthetic supported observation B for ${id}.`
  const sourceContent = `${leftStatement}\n${rightStatement}\n`
  return {
    id, familyId: `family-${id}`, lineage: [`lineage-${id}`], split, stratum, authorship: "agent-authored" as const,
    sources: [{ id: sourceId, provenance: "raw" as const, content: sourceContent, sha256: sha256(sourceContent) }],
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

function makeNativePack() {
  return {
    schema: NATIVE_FIXTURE_PACK_SCHEMA,
    contract: NATIVE_WIKI_CONTRACT,
    fixtures: NATIVE_WIKI_SPLITS.flatMap(split =>
      Array.from({ length: NATIVE_WIKI_SPLIT_MINIMUMS[split] }, (_, index) =>
        makeNativeFixture(split, index, NATIVE_WIKI_STRATA[index % NATIVE_WIKI_STRATA.length]!))),
  }
}

function makeTrainerControllerFixture() {
  if (!nativeHelper) throw new Error("native SkillOpt helper was not prepared")
  const createdRoot = mkdtempSync(join(realpathSync.native(tmpdir()), "skillopt-containment-controller-test-"))
  const root = realpathSync.native(createdRoot)
  chmodSync(root, 0o700)
  roots.push(root)
  const baselinePath = join(root, PILOT_SKILL)
  mkdirSync(dirname(baselinePath), { recursive: true, mode: 0o700 })
  writeFileSync(baselinePath, baselineSkill, { flag: "wx", mode: 0o600 })
  const source = Buffer.from("Private synthetic selected source for containment profile tests.\n", "utf8")
  const sourcePath = `knowledge/raw/documents/${sha256(source)}.md`
  const absoluteSource = join(root, sourcePath)
  mkdirSync(dirname(absoluteSource), { recursive: true, mode: 0o700 })
  writeFileSync(absoluteSource, source, { flag: "wx", mode: 0o600 })
  const dataset = createNativeDataset({ root, selections: [{ path: sourcePath }], fixturePack: makeNativePack(), modelBindings })
  if (dataset.status !== "STRUCTURALLY_VALID") throw new Error("private synthetic containment dataset is incomplete")
  const host: ExecutionHost = {
    identity: { engine: "codex", profile: "legacy-unowned" },
    async preflight() { return { compatible: true, controls: {}, problems: [] } },
    async prepare(_request: ExecutionRequest) { throw new Error("trainer profile setup must not dispatch a model") },
    async reconcile(): Promise<ExecutionReconciliation> {
      return { outcome: "unknown", quiescent: false, evidence: "containment profile fixture did not dispatch" }
    },
  }
  const runtime = createExecutionRuntime({ directory: root, worktree: root, config: structuredClone(DEFAULT_CONFIG), log() {} },
    () => host, { planningOnlyMain: true })
  const owner = attachAdmission(runtime, `session_${randomUUID().replaceAll("-", "")}`,
    { engine: modelBindings.generator.engine, model: modelBindings.generator.requestedModel })
  trainerControllerFixtures.push({ root, owner, runtime })
  const broker = createNativeSkillOptBroker(runtime, nativeHelper.helper)
  broker.controller.initialize()
  const current = { dataset, baselineSkillSha256: sha256(baselineSkill) }
  const prepared = broker.controller.prepare({ owner, campaignId: `campaign_${randomUUID().replaceAll("-", "")}`, ...current })
  if (prepared.state !== "PREPARED") throw new Error("actual controller did not prepare the containment trainer fixture")
  return { root, runtime, owner, broker, current, dataset, prepared }
}

type TrainerWorkerProfileInput = Extract<WorkerProfileInput, { role: "trainer" }>

async function genuineTrainerProfileInput(): Promise<{
  input: TrainerWorkerProfileInput
  materialization: ReturnType<typeof nativeSkillOptTrainerMaterializationMetadata>
  controllerFixture: ReturnType<typeof makeTrainerControllerFixture>
}> {
  const controllerFixture = makeTrainerControllerFixture()
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "skillopt-containment-trainer-profile-test-"))
  chmodSync(root, 0o700)
  roots.push(root)
  const inputDirectory = join(root, "input")
  const outputDirectory = join(root, "output")
  const emptyHomeDirectory = join(root, "home")
  const probeDirectory = join(root, "probe")
  for (const path of [inputDirectory, outputDirectory, emptyHomeDirectory, probeDirectory]) mkdirSync(path, { mode: 0o700 })
  const selectedInputPath = join(inputDirectory, "trainer-input.json")
  const adapterManifestPath = join(inputDirectory, "protocol.json")
  const runtimeInput: WorkerProfileInput = {
    role: "fixture", executablePath: pythonRuntime,
    nativeRuntimeProofPath: resolve(dirname(dirname(dirname(resolve(pythonRuntime)))), "native-runtime-proof.json"),
    selectedInputPath: join(inputDirectory, "unused-input.json"), outputDirectory, emptyHomeDirectory, probeDirectory,
  }
  const runtime = copyAttestedPrivateRuntime(runtimeInput, false)
  const plan = planNativeSkillOptTrainerMaterialization({ worktree: controllerFixture.root,
    runtime, dataset: controllerFixture.dataset, prepared: controllerFixture.prepared, baselineSkillBytes: baselineSkill })
  const materialization = nativeSkillOptTrainerMaterializationMetadata(plan)
  const remainingBefore = controllerFixture.broker.controller.status().remaining.artifactBytes
  const allowance = controllerFixture.broker.controller.reserveNativeTrainerMaterialization({ owner: controllerFixture.owner,
    runtime: controllerFixture.runtime, prepared: controllerFixture.prepared, current: controllerFixture.current, materialization })
  expect(controllerFixture.broker.controller.status().remaining.artifactBytes).toBe(remainingBefore -
    (materialization.projectionBytes + materialization.manifestBytes * 2 + NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES +
      NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES))
  const protocolStageAllowance = controllerFixture.broker.controller.consumeNativeTrainerMaterializationAllowance(allowance, {
    owner: controllerFixture.owner, runtime: controllerFixture.runtime, prepared: controllerFixture.prepared,
    current: controllerFixture.current, materialization,
  })
  expect(existsSync(selectedInputPath)).toBe(false)
  expect(existsSync(adapterManifestPath)).toBe(false)

  const projectionBytes = Buffer.from(canonicalJson(trainerSafeProjection(controllerFixture.dataset)), "utf8")
  const manifest = buildNativeAdapterManifest({ fixturePack: controllerFixture.dataset.fixturePack,
    runId: controllerFixture.prepared.runId, originalSkillSha256: sha256(baselineSkill), sourceLockSha256 })
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8")
  expect(sha256(projectionBytes)).toBe(materialization.projectionSha256)
  expect(projectionBytes.byteLength).toBe(materialization.projectionBytes)
  expect(sha256(manifestBytes)).toBe(materialization.manifestSha256)
  expect(manifestBytes.byteLength).toBe(materialization.manifestBytes)
  writeFileSync(selectedInputPath, projectionBytes, { flag: "wx", mode: 0o600 })
  writeFileSync(adapterManifestPath, manifestBytes, { flag: "wx", mode: 0o600 })
  const input: TrainerWorkerProfileInput = {
    role: "trainer", executablePath: runtime.executablePath, nativeRuntimeProofPath: runtime.nativeRuntimeProofPath,
    selectedInputPath, outputDirectory, emptyHomeDirectory, probeDirectory, adapterManifestPath, protocolStageAllowance,
  }
  return { input, materialization, controllerFixture }
}

function maxBoundSlots() {
  return Array.from({ length: 32 }, (_, index) => ({
    id: `s${String(index).padStart(2, "0")}${"x".repeat(61)}`,
    kind: "annotation",
    existingContent: "",
  }))
}

test("trainer protocol witness consumption rejects forged objects without a READY receipt", () => {
  const profile = Object.freeze({}) as SkillOptWorkerProfile
  const receipt = Object.freeze({}) as SkillOptContainmentReceipt
  const event = Object.freeze({}) as OwnedTrainerProtocolEvent
  const copiedEvent = Object.freeze({ ...event }) as OwnedTrainerProtocolEvent
  const serializedEvent = JSON.parse(JSON.stringify(event)) as OwnedTrainerProtocolEvent

  for (const candidate of [event, copiedEvent, serializedEvent]) {
    expect(() => consumeOwnedTrainerProtocolEvent(candidate, { profile, receipt })).toThrow("trainer_protocol_event_unowned")
  }
  expect(() => consumeOwnedTrainerProtocolEvent(event, {
    profile: Object.freeze({}) as SkillOptWorkerProfile, receipt,
  })).toThrow("trainer_protocol_event_unowned")
  expect(() => consumeOwnedTrainerProtocolEvent(event, {
    profile, receipt: Object.freeze({}) as SkillOptContainmentReceipt,
  })).toThrow("trainer_protocol_event_unowned")
})

test.skipIf(process.platform !== "linux" || !hasContainmentPrimitive || !hasConfiguredPythonRuntime)(
  "trainer protocol witnesses preserve owned raw-line evidence through cancellation",
  async () => {
    const { input } = await genuineTrainerProfileInput()
    const profile = prepareWorkerProfile(input)
    const receipt = await probeWorkerContainment(profile)
    expectContainmentReady(receipt)
    const handle = launchOwnedWorker(profile, receipt, "trainer-native")
    const rawMessages: Record<string, unknown>[] = []
    let resolveEvent!: (event: OwnedTrainerProtocolEvent) => void
    const eventPromise = new Promise<OwnedTrainerProtocolEvent>((resolveEventPromise) => { resolveEvent = resolveEventPromise })
    const detachEvent = handle.onTrainerProtocolEvent(resolveEvent)
    handle.onMessage((message) => rawMessages.push(message))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const event = await Promise.race([
        eventPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("trainer_protocol_event_timeout")), 120_000)
        }),
      ])
      const result = await handle.cancel()
      expect(result.status).toBe("cancelled")
      expect(result.quiescent).toBe(true)
      expect(rawMessages).toEqual([])

      expect(() => consumeOwnedTrainerProtocolEvent(Object.freeze({ ...event }) as OwnedTrainerProtocolEvent,
        { profile, receipt })).toThrow("trainer_protocol_event_unowned")
      expect(() => consumeOwnedTrainerProtocolEvent(JSON.parse(JSON.stringify(event)) as OwnedTrainerProtocolEvent,
        { profile, receipt })).toThrow("trainer_protocol_event_unowned")
      expect(() => consumeOwnedTrainerProtocolEvent(event, {
        profile: Object.freeze({ ...profile }) as SkillOptWorkerProfile, receipt,
      })).toThrow("trainer_protocol_event_binding_invalid")
      expect(() => consumeOwnedTrainerProtocolEvent(event, {
        profile, receipt: Object.freeze({ ...receipt }) as SkillOptContainmentReceipt,
      })).toThrow("trainer_protocol_event_binding_invalid")

      const line = consumeOwnedTrainerProtocolEvent(event, { profile, receipt })
      expect(Object.isFrozen(line)).toBe(true)
      expect(line.profileSha256).toBe(profile.binding.profileSha256)
      expect(line.receiptBindingSha256).toBe(receipt.bindingSha256)
      expect(line.ordinal).toBe(1)
      expect(line.rawLineSha256).toBe(sha256(line.rawLine))
      expect(JSON.parse(line.rawLine.toString("utf8"))).toMatchObject({ schema: "skillopt.rollout-request.v1" })
      expect(() => consumeOwnedTrainerProtocolEvent(event, { profile, receipt })).toThrow("trainer_protocol_event_replayed")
    } finally {
      if (timer) clearTimeout(timer)
      detachEvent()
      await handle.cancel()
    }
  },
)

test("fixture probe byte bound matches its three random sentinels and exact private output marker", () => {
  const marker = Buffer.from("skillopt-output-probe", "ascii")
  expect(marker.byteLength).toBe(21)
  expect(nativeSkillOptFixtureProbeSerializedBytes()).toBe(3 * 24 + marker.byteLength)
})

test("fixture result bound covers the validated maximum slot metadata and response expansion", () => {
  const slots = maxBoundSlots()
  expect(slots.every(slot => slot.id.length === 64)).toBe(true)
  expect(Math.max(...slots.map(slot => Buffer.byteLength(slot.kind, "utf8")))).toBe("annotation".length)
  expect(nativeSkillOptFixtureResultByteBound(slots)).toBe(200_094)
  expect(nativeSkillOptFixtureResultByteBound([{ id: "page-main", kind: "page" }])).toBe(
    62 + 33 + Buffer.byteLength("page-main") + Buffer.byteLength("page") + 6 * NATIVE_DATASET_LIMITS.nativeResponseBytes,
  )
  for (const kind of NATIVE_WIKI_OUTPUT_KINDS) {
    expect(nativeSkillOptFixtureResultByteBound([{ id: "slot", kind }])).toBe(
      62 + 33 + Buffer.byteLength("slot") + Buffer.byteLength(kind) + 6 * NATIVE_DATASET_LIMITS.nativeResponseBytes,
    )
  }
  expect(() => nativeSkillOptFixtureResultByteBound([])).toThrow("fixture_output_slots_invalid")
  expect(() => nativeSkillOptFixtureResultByteBound(Array.from({ length: 33 }, (_, index) => ({
    id: `slot-${index}`, kind: "page",
  })))).toThrow("fixture_output_slots_invalid")
  expect(() => nativeSkillOptFixtureResultByteBound([{ id: "has space", kind: "page" }])).toThrow("fixture_output_slots_invalid")
  expect(() => nativeSkillOptFixtureResultByteBound([{ id: "slot", kind: "unknown" }])).toThrow("fixture_output_slots_invalid")
})

test("native worker profiles reject the legacy runtime-proof.json without fallback", () => {
  const input = profileInput(false)
  const fakePython = join(tmpdir(), "skillopt", "runtime", "fa4ca184573e42ec11472959dd57422381418096", "venv", "bin", "python")
  const legacyProofPath = resolve(dirname(dirname(dirname(fakePython))), "runtime-proof.json")
  let observed: unknown
  try { prepareWorkerProfile({ ...input, executablePath: fakePython, nativeRuntimeProofPath: legacyProofPath }) }
  catch (error) { observed = error }
  expect(observed).toBeInstanceOf(SkillOptWorkerError)
  expect((observed as SkillOptWorkerError).code).toBe("native_runtime_proof_path_invalid")
})

test.skipIf(!hasContainmentPrimitive || !hasConfiguredPythonRuntime)("native runtime proof drift blocks a copied and freshly attested private worker profile", async () => {
  const input = profileInput(true, true)
  const profile = prepareWorkerProfile(input)
  const proof = JSON.parse(readFileSync(input.nativeRuntimeProofPath, "utf8")) as Record<string, unknown>
  writeFileSync(input.nativeRuntimeProofPath, `${JSON.stringify({ ...proof, claim: "tampered" })}\n`, { mode: 0o600 })
  const receipt = await probeWorkerContainment(profile)
  expect(receipt.status).toBe("BLOCKED")
  expect(receipt.code).toBe("worker_profile_drift")
})

test.skipIf(!hasContainmentPrimitive || !hasConfiguredPythonRuntime)("native worker profiles reject the legacy runtime-proof schema", () => {
  const input = profileInput(true, true)
  const proof = JSON.parse(readFileSync(input.nativeRuntimeProofPath, "utf8")) as Record<string, unknown>
  writeFileSync(input.nativeRuntimeProofPath, `${JSON.stringify({ ...proof, schema: "skillopt.runtime-proof.v1" })}\n`, { mode: 0o600 })
  let observed: unknown
  try { prepareWorkerProfile(input) } catch (error) { observed = error }
  expect(observed).toBeInstanceOf(SkillOptWorkerError)
  expect((observed as SkillOptWorkerError).code).toBe("native_runtime_proof_invalid")
})

test.skipIf(!hasContainmentPrimitive || !hasConfiguredPythonRuntime)("native runtime proof requires exact isolated Python flag fields and values", () => {
  const input = profileInput(true, true)
  const originalProof = JSON.parse(readFileSync(input.nativeRuntimeProofPath, "utf8")) as Record<string, unknown>
  const interpreter = originalProof.interpreter as Record<string, unknown>
  const fields = [
    ["noUserSite", false],
    ["ignoreEnvironment", false],
    ["dontWriteBytecodeFlag", 0],
  ] as const
  for (const [field, invalidValue] of fields) {
    const tamperedProof = { ...originalProof, interpreter: { ...interpreter, [field]: invalidValue } }
    writeFileSync(input.nativeRuntimeProofPath, `${JSON.stringify(tamperedProof)}\n`, { mode: 0o600 })
    let observed: unknown
    try { prepareWorkerProfile(input) } catch (error) { observed = error }
    expect(observed).toBeInstanceOf(SkillOptWorkerError)
    expect((observed as SkillOptWorkerError).code).toBe("native_runtime_proof_invalid")
  }
  for (const field of ["noUserSite", "ignoreEnvironment", "dontWriteBytecodeFlag"] as const) {
    const incompleteInterpreter = { ...interpreter }
    delete incompleteInterpreter[field]
    const incompleteProof = { ...originalProof, interpreter: incompleteInterpreter }
    writeFileSync(input.nativeRuntimeProofPath, `${JSON.stringify(incompleteProof)}\n`, { mode: 0o600 })
    let observed: unknown
    try { prepareWorkerProfile(input) } catch (error) { observed = error }
    expect(observed).toBeInstanceOf(SkillOptWorkerError)
    expect((observed as SkillOptWorkerError).code).toBe("native_runtime_proof_invalid")
  }
  const extraProof = { ...originalProof, interpreter: { ...interpreter, unexpectedStartupFlag: true } }
  writeFileSync(input.nativeRuntimeProofPath, `${JSON.stringify(extraProof)}\n`, { mode: 0o600 })
  let observed: unknown
  try { prepareWorkerProfile(input) } catch (error) { observed = error }
  expect(observed).toBeInstanceOf(SkillOptWorkerError)
  expect((observed as SkillOptWorkerError).code).toBe("native_runtime_proof_invalid")
})

test.skipIf(!hasContainmentPrimitive || !hasConfiguredPythonRuntime)("native worker rejects an interpreter symlink escaping its private runtime", () => {
  const input = profileInput(true, true)
  unlinkSync(input.executablePath)
  symlinkSync(realpathSync.native(pythonRuntime), input.executablePath)
  let observed: unknown
  try { prepareWorkerProfile(input) } catch (error) { observed = error }
  expect(observed).toBeInstanceOf(SkillOptWorkerError)
  expect(["python_runtime_base_unsafe", "worker_file_unsafe"].includes((observed as SkillOptWorkerError).code)).toBe(true)
})

test.skipIf(!hasContainmentPrimitive || !hasConfiguredPythonRuntime)("trainer native-v1 profile binds the train/dev projection separately from its adapter manifest", async () => {
  const { input, materialization, controllerFixture } = await genuineTrainerProfileInput()
  expect(JSON.stringify(materialization)).not.toContain("Private synthetic selected source")
  const profile = prepareWorkerProfile(input)
  expect(profile.binding.role).toBe("trainer")
  expect(profile.binding.profileSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(profile.binding.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
  const fixtureProfile = prepareWorkerProfile(profileInput())
  expect(fixtureProfile.binding.role).toBe("fixture")
  expect(fixtureProfile.binding.sourceSha256).toBe(profile.binding.sourceSha256)
  expect(fixtureProfile.binding.runtimeIdentitySha256).toBe(profile.binding.runtimeIdentitySha256)
  expect(fixtureProfile.binding.profileSha256).not.toBe(profile.binding.profileSha256)
  expect(profile.binding.executable.contentSha256).toMatch(/^[a-f0-9]{64}$/)
  expect((profile.binding.runtime.kind === "python" ? profile.binding.runtime.nativeRuntimeProofSha256 : ""))
    .toBe(sha256(readFileSync(input.nativeRuntimeProofPath)))
  expect(realpathSync.native(input.executablePath)).toBe(input.executablePath)
  const runtimeRoot = resolve(dirname(dirname(input.executablePath)))
  const executableRelative = relative(runtimeRoot, input.executablePath)
  expect(executableRelative.startsWith(`..${sep}`)).toBe(false)
  expect(profile.binding.executable.uid).toBe(String(process.getuid?.() ?? -1))
  expect(profile.binding.runtime.kind).toBe("python")
  if (profile.binding.runtime.kind === "python") {
    expect(profile.binding.runtime.nativeRuntimeProofSha256).toBe(sha256(readFileSync(input.nativeRuntimeProofPath)))
    expect(profile.binding.runtime.wheelOriginStatus).toBe("unobserved")
  }
  expect(profile.binding.inputSha256).toBe(materialization.projectionSha256)
  expect(profile.binding.adapterManifestSha256).toBe(materialization.manifestSha256)
  expect(profile.binding.adapterManifestSha256).toBe(sha256(readFileSync(input.adapterManifestPath)))
  expect(profile.binding.filesystem.adapterManifest?.type).not.toBe("")
  expect(profile.binding.filesystem.nativeRuntimeProof?.type).not.toBe("")
  expect(profile.binding.resourceCaps.wallMilliseconds).toBeGreaterThan(0)
  expect(profile.binding.resourceCaps.addressSpaceBytes).toBe(2 * 1024 ** 3)
  expect(profile.binding.resourceCaps.stdoutBytes).toBeGreaterThan(0)
  expect(profile.binding.filesystem.input.type).not.toBe("")
  expect(profile.binding.filesystem.output.type).not.toBe("")
  const receipt = await probeWorkerContainment(profile)
  expect(receipt.bindingSha256).toBe(profile.binding.profileSha256)
  expect(receipt.resourceCaps).toEqual(profile.binding.resourceCaps)
  if (process.platform === "darwin") {
    expectDarwinAddressSpaceBlocked(receipt)
  } else {
    expectContainmentReady(receipt)
  }
  expect(() => consumeNativeTrainerProtocolStageAllowance(input.protocolStageAllowance,
    { ...materialization, manifestBytes: materialization.manifestBytes + 1 })).toThrow("binding-invalid")
  consumeNativeTrainerProtocolStageAllowance(input.protocolStageAllowance, materialization)
  expect(() => consumeNativeTrainerProtocolStageAllowance(input.protocolStageAllowance, materialization)).toThrow("binding-invalid")
  expect(existsSync(join(input.outputDirectory, "protocol.json"))).toBe(false)
  expect(controllerFixture.broker.controller.status().requestCounts.dispatched).toEqual({ target: 0, optimizer: 0, reviewer: 0 })
  expect(controllerFixture.runtime.runs.status().executions).toHaveLength(0)
})

test.skipIf(!hasContainmentPrimitive || !hasConfiguredPythonRuntime)("trainer rejects adapter manifests with unsupported split authority", async () => {
  const { input, controllerFixture } = await genuineTrainerProfileInput()
  const invalid = { ...JSON.parse(readFileSync(input.adapterManifestPath, "utf8")),
    final: [{ caseId: "final-case-1", replicate: 0 }] }
  writeFileSync(input.adapterManifestPath, canonicalJson(invalid), { mode: 0o600 })
  let observed: unknown
  try { prepareWorkerProfile(input) } catch (error) { observed = error }
  expect(observed).toBeInstanceOf(SkillOptWorkerError)
  expect((observed as SkillOptWorkerError).code).toBe("adapter_manifest_invalid")
  expect(existsSync(join(input.outputDirectory, "protocol.json"))).toBe(false)
  expect(controllerFixture.broker.controller.status().requestCounts.dispatched).toEqual({ target: 0, optimizer: 0, reviewer: 0 })
})

test.skipIf(!hasContainmentPrimitive || !hasConfiguredPythonRuntime)("fixture native-v1 full payload completes only after worker group quiescence", async () => {
  const slots = maxBoundSlots().map((slot, index) => ({
    ...slot, kind: NATIVE_WIKI_OUTPUT_KINDS[index % NATIVE_WIKI_OUTPUT_KINDS.length]!,
  }))
  const input = profileInput(true, false, fixtureInput(slots))
  const profile = prepareWorkerProfile(input)
  expect(profile.binding.runtime.kind).toBe("python")
  const receipt = await probeWorkerContainment(profile)
  if (process.platform === "darwin") {
    expectDarwinAddressSpaceBlocked(receipt)
    expect(() => launchOwnedWorker(profile, receipt, "fixture-apply")).toThrow()
    return
  }
  expectContainmentReady(receipt)
  const replayedProfile = JSON.parse(JSON.stringify(profile)) as SkillOptWorkerProfile
  expect(() => launchOwnedWorker(replayedProfile, receipt, "fixture-apply")).toThrow()
  const handle = launchOwnedWorker(profile, receipt, "fixture-apply")
  const messages: Record<string, unknown>[] = []
  handle.onMessage((message) => messages.push(message))
  const unicodeSamples = [
    'quotes:" and \\',
    Array.from({ length: 31 }, (_, index) => String.fromCharCode(index + 1)).join(""),
    "control-DEL:\u007f; C1:\u0085",
    "U+0080:\u0080 U+2028:\u2028 U+2029:\u2029",
    "BMP: 漢字 café",
    "astral: 🦦 𐐷",
  ]
  const contentById = new Map(slots.map((slot, index) => {
    const sample = unicodeSamples[index % unicodeSamples.length]!
    const paddingBytes = 1024 - Buffer.byteLength(sample, "utf8")
    expect(paddingBytes).toBeGreaterThanOrEqual(0)
    const content = `${sample}${"x".repeat(paddingBytes)}`
    expect(Buffer.byteLength(content, "utf8")).toBe(1024)
    return [slot.id, content] as const
  }))
  const writes = slots.map(slot => ({ slotId: slot.id, content: contentById.get(slot.id)! }))
  expect(writes.reduce((sum, write) => sum + Buffer.byteLength(write.content, "utf8"), 0))
    .toBe(NATIVE_DATASET_LIMITS.nativeResponseBytes)
  await handle.writeMessage({ schema: "skillopt.native-wiki-output.v1", writes })
  handle.closeInput()
  const result = await handle.wait()
  expect(result.status, JSON.stringify(result)).toBe("completed")
  expect(result.errorCode).toBeUndefined()
  expect(result.quiescent).toBe(true)
  expect(messages).toHaveLength(1)
  const outputBytes = readFileSync(join(input.outputDirectory, "fixture-result.json"))
  expect(outputBytes.byteLength).toBeLessThanOrEqual(nativeSkillOptFixtureResultByteBound(slots))
  const output = JSON.parse(outputBytes.toString("utf8"))
  expect(output.schema).toBe("skillopt.native-wiki-fixture-result.v1")
  expect(output.slots).toEqual(slots.map(slot => ({ id: slot.id, kind: slot.kind, content: contentById.get(slot.id) })))
  expect((await handle.reconcile()).outcome).toBe("terminal")

  const overflowInput = profileInput(true, false, fixtureInput(slots))
  const overflowProfile = prepareWorkerProfile(overflowInput)
  const overflowReceipt = await probeWorkerContainment(overflowProfile)
  expectContainmentReady(overflowReceipt)
  const overflowOutputPath = join(overflowInput.outputDirectory, "fixture-result.json")
  expect(existsSync(overflowOutputPath)).toBe(false)
  const overflowWorker = launchOwnedWorker(overflowProfile, overflowReceipt, "fixture-apply")
  const overflowWrites = slots.map((slot, index) => ({ slotId: slot.id,
    content: "x".repeat(index === slots.length - 1 ? 1025 : 1024) }))
  expect(overflowWrites.reduce((sum, write) => sum + Buffer.byteLength(write.content, "utf8"), 0))
    .toBe(NATIVE_DATASET_LIMITS.nativeResponseBytes + 1)
  expect(Math.max(...overflowWrites.map(write => Buffer.byteLength(write.content, "utf8"))))
    .toBeLessThanOrEqual(NATIVE_DATASET_LIMITS.nativeResponseBytes)
  await overflowWorker.writeMessage({ schema: "skillopt.native-wiki-output.v1", writes: overflowWrites })
  overflowWorker.closeInput()
  const overflowResult = await overflowWorker.wait()
  expect(overflowResult.quiescent).toBe(true)
  expect(overflowResult.status).not.toBe("completed")
  expect(existsSync(overflowOutputPath)).toBe(false)
})

test.skipIf(!hasContainmentPrimitive || !hasConfiguredPythonRuntime)("fixture worker cancellation owns and quiesces its process group", async () => {
  const input = profileInput()
  const profile = prepareWorkerProfile(input)
  const receipt = await probeWorkerContainment(profile)
  if (process.platform === "darwin") {
    expectDarwinAddressSpaceBlocked(receipt)
    expect(() => launchOwnedWorker(profile, receipt, "fixture-apply")).toThrow()
    return
  }
  expectContainmentReady(receipt)
  const handle = launchOwnedWorker(profile, receipt, "fixture-apply")
  const result = await handle.cancel()
  expect(result.status).toBe("cancelled")
  expect(result.quiescent).toBe(true)
  expect((await handle.reconcile()).outcome).toBe("terminal")
})
