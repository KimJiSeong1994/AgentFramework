import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test"
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import * as nodeFs from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { execFileSync, spawnSync } from "node:child_process"
import { Database } from "bun:sqlite"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import { humanDecision } from "../src/hosts/operator.ts"
import { admissionEpoch, admissionFence, attachAdmission, effectiveHold } from "../src/sessions/admission.ts"
import { getOwnedSession } from "../src/sessions/store.ts"
import { digestDirectory } from "../src/sessions/digest.ts"
import type { ExecutionHost, ExecutionRequest, ExecutionReconciliation } from "../src/hosts/types.ts"
import type { CliNativeIdentity, CliTransportOptions, CliTransportResult } from "../src/hosts/cli-transport.ts"
import { executionRunDirectory } from "../src/state/store.ts"
import { tempWorktree, type TempWorktree } from "./guards-helpers.ts"
import { withTerminalLine } from "./operator-helpers.ts"
import {
  createNativeDataset,
  NATIVE_FIXTURE_PACK_SCHEMA, NATIVE_PROTECTED_CHANGES, NATIVE_WIKI_CONTRACT,
  NATIVE_DATASET_LIMITS, NATIVE_WIKI_OUTPUT_SCHEMA, NATIVE_WIKI_SPLIT_MINIMUMS, NATIVE_WIKI_SPLITS, NATIVE_WIKI_STRATA,
  trainerSafeProjection, type NativeModelBindings, type NativeWikiFixture, type NativeWikiFixturePack,
} from "../src/skillopt/dataset.ts"
import type { NativeEvaluationTrial } from "../src/skillopt/evaluation.ts"
import type { NativeSkillOptBroker } from "../src/skillopt/broker.ts"
import type { SkillOptConsent, SkillOptCurrentBinding, SkillOptPrepared } from "../src/skillopt/controller.ts"
import type { OwnedTrainerProtocolEvent, OwnedWorkerHandle, OwnedWorkerResult, SkillOptContainmentReceipt, SkillOptWorkerProfile, TrustedWorkerOperation, WorkerProfileInput } from "../src/skillopt/host.ts"
import { COMPILE_ANCHOR, NATIVE_SKILLOPT_LIMITS, assembleSkill, canonicalJson, sha256 } from "../src/skillopt/pilot.ts"

const hostModule = fileURLToPath(new URL("../src/skillopt/host.ts", import.meta.url))
let realHost!: Readonly<typeof import("../src/skillopt/host.ts")>
const originalWriteFileSync = nodeFs.writeFileSync
let measureNativeQualification!: typeof import("../src/skillopt/evaluation.ts")["measureNativeQualification"]
let renderNativeEvaluationPrompt!: typeof import("../src/skillopt/evaluation.ts")["renderNativeEvaluationPrompt"]
let NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA!: typeof import("../src/skillopt/evaluation.ts")["NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA"]
let planNativeFixtureSerializedWrites!: typeof import("../src/skillopt/evaluation.ts")["planNativeFixtureSerializedWrites"]
let serializeNativeFixtureWorkerInput!: typeof import("../src/skillopt/evaluation.ts")["serializeNativeFixtureWorkerInput"]
let NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES!: typeof import("../src/skillopt/trainer.ts")["NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES"]
let NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES!: typeof import("../src/skillopt/trainer.ts")["NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES"]
let nativeSkillOptTrainerMaterializationMetadata!: typeof import("../src/skillopt/trainer.ts")["nativeSkillOptTrainerMaterializationMetadata"]
let planNativeSkillOptTrainerMaterialization!: typeof import("../src/skillopt/trainer.ts")["planNativeSkillOptTrainerMaterialization"]
let buildNativeAdapterManifest!: typeof import("../src/skillopt/campaign-protocol.ts")["buildNativeAdapterManifest"]
let buildNativeCampaignSchedule!: typeof import("../src/skillopt/campaign-protocol.ts")["buildNativeCampaignSchedule"]
let createNativeTrainerWire!: typeof import("../src/skillopt/campaign-protocol.ts")["createNativeTrainerWire"]
const transportModule = fileURLToPath(new URL("../src/hosts/cli-transport.ts", import.meta.url))
const realTransport = Object.freeze({ ...await import("../src/hosts/cli-transport.ts") })
const workerScratchRoots: string[] = []
const runtimeScratchRoots: string[] = []
const campaignWorktrees: Array<{ worktree: TempWorktree; runtime: ReturnType<typeof createExecutionRuntime>; owner: ReturnType<typeof attachAdmission> }> = []
const configuredPythonRuntime = process.env.SKILLOPT_PYTHON ?? ""
const cachedBwrap = join(realpathSync.native(homedir()), ".cache/otter-skillopt-build-tools/root/usr/bin/bwrap")
const canRunContainedWorkers = process.platform === "linux" && Boolean(configuredPythonRuntime) &&
  (Boolean(Bun.which("bwrap")) || existsSync(cachedBwrap))
let privateRuntime: Readonly<{ executablePath: string; nativeRuntimeProofPath: string }> | undefined
type WorkerHarnessState = {
  controller: NativeSkillOptBroker["controller"]
  targetResponseBudgets: number[]
  fixtureResultBudgets: Array<{ beforeResponse: number; beforeWrite: number; serializedBytes: number }>
  trainerRolloutBudgets: Array<{ beforeResponse: number; beforeWrite: number; serializedBytes: number }>
  trainerOptimizerResponses: unknown[]
  trainerOptimizerResponseBudgets: Array<{ beforeResponse: number; beforeWrite: number; serializedBytes: number }>
  optimizerResponseBudgetSnapshots: number[]
  abortOnFixtureWrite?: AbortController
  fixtureCancellationQuiescent?: boolean
  fixtureExitOnAbort?: boolean
  trainerCancellationThrows?: boolean
  fixtureRoots: string[]
  fixtureInputBytes: Buffer[]
  fixtureCancelCount: number
  trainerCancelCount: number
  useRealTrainerProtocol?: boolean
  candidateSelectionImproves?: boolean
}
let workerHarness: WorkerHarnessState | undefined
type CampaignFsWrite = Readonly<{
  root: string; kind: "fixture-preflight" | "worker-input" | "fixture-probe" | "fixture-result" | "fixture-adapter"
  remainingBefore: number; bytes: number
}>
let activeCampaignArtifactController: NativeSkillOptBroker["controller"] | undefined
const campaignFsWrites: CampaignFsWrite[] = []
const campaignSerializedWrites: Array<Readonly<{ root: string; kind: CampaignFsWrite["kind"]; bytes: number; sha256: string }>> = []
const campaignFsWriteKeys = new Set<string>()
const campaignWriteTimestamps: string[] = []
let nativeHelperRoot: string | undefined
let nativeHelperPath = ""
let nativeHelperSha256 = ""
let activeCampaignResponse: (prompt: string, engine: CliTransportOptions["engine"], model: string) => string = () => "synthetic response"
const nativeTransportRuns: string[] = []
const nativePlatformSupported = process.platform === "darwin" || process.platform === "linux"
const fixtureProfilePaths = new WeakMap<object, string>()
const fixtureProfileInputs = new WeakMap<object, string>()
type BrokerApi = typeof import("../src/skillopt/broker.ts")
type CampaignApi = typeof import("../src/skillopt/campaign.ts")
let SkillOptBrokerError!: BrokerApi["SkillOptBrokerError"]
let createNativeSkillOptBroker!: BrokerApi["createNativeSkillOptBroker"]
let getNativeSkillOptBrokerWorktree!: BrokerApi["getNativeSkillOptBrokerWorktree"]
let classifyNativeCampaignRequestFailure!: CampaignApi["classifyNativeCampaignRequestFailure"]
let nativeCampaignConsentDisclosure!: CampaignApi["nativeCampaignConsentDisclosure"]
let runNativeSkillOptCampaign!: CampaignApi["runNativeSkillOptCampaign"]
let consumeNativeCampaignQualification!: CampaignApi["consumeNativeCampaignQualification"]

function observeCampaignWrite(args: Parameters<typeof writeFileSync>): void {
  const [target, data] = args
  let path: string
  if (typeof target === "string") path = target
  else if (target instanceof URL) path = fileURLToPath(target)
  else if (Buffer.isBuffer(target)) path = target.toString("utf8")
  else return
  const bytesBuffer = typeof data === "string"
    ? Buffer.from(data, "utf8")
    : Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  const nativeRoot = /(?:^|\/)(otter-skillopt-native-fixture-[^/]+)/u.exec(path)?.[1]
  const fixtureRoot = /(?:^|\/)(otter-skillopt-fixture-[^/]+)/u.exec(path)?.[1]
  if (activeCampaignArtifactController && (nativeRoot || fixtureRoot)) {
    if (path.endsWith("/knowledge/wiki/log.md")) {
      const contents = bytesBuffer.toString("utf8")
      for (const match of contents.matchAll(/^## \[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] register \|/gmu)) {
        if (match[1]) campaignWriteTimestamps.push(match[1])
      }
    }
    let kind: CampaignFsWrite["kind"] | undefined
    if (nativeRoot && path.endsWith("/input.json")) kind = "worker-input"
    else if (nativeRoot && path.includes("/probe/")) kind = "fixture-probe"
    else if (nativeRoot && path.endsWith("/fixture-result.json")) kind = "fixture-result"
    else if (fixtureRoot) kind = workerHarness?.fixtureInputBytes.length ? "fixture-adapter" : "fixture-preflight"
    if (kind) {
      const root = nativeRoot ?? fixtureRoot!
      campaignSerializedWrites.push(Object.freeze({ root, kind, bytes: bytesBuffer.byteLength, sha256: sha256(bytesBuffer) }))
      const key = `${nativeRoot ?? fixtureRoot}:${kind}`
      if (!campaignFsWriteKeys.has(key)) {
        campaignFsWriteKeys.add(key)
        campaignFsWrites.push(Object.freeze({ root, kind, remainingBefore: activeCampaignArtifactController.status().remaining.artifactBytes,
          bytes: bytesBuffer.byteLength }))
      }
    }
  }
}

async function withCampaignArtifactWriteSpy<T>(
  controller: NativeSkillOptBroker["controller"],
  operation: () => Promise<T>,
): Promise<T> {
  const writeFileSpy = spyOn(nodeFs, "writeFileSync").mockImplementation((...args) => {
    observeCampaignWrite(args)
    return Reflect.apply(originalWriteFileSync, nodeFs, args)
  })
  activeCampaignArtifactController = controller
  try { return await operation() }
  finally {
    activeCampaignArtifactController = undefined
    writeFileSpy.mockRestore()
  }
}

function privateRuntimeFor(emptyHomeDirectory: string): Readonly<{ executablePath: string; nativeRuntimeProofPath: string }> {
  if (privateRuntime) return privateRuntime
  if (!configuredPythonRuntime || !configuredPythonRuntime.startsWith("/")) throw new Error("SKILLOPT_PYTHON is required for contained campaign tests")
  const sourceExecutable = resolve(configuredPythonRuntime)
  const sourceRuntimeRoot = resolve(dirname(dirname(sourceExecutable)))
  if (sourceExecutable !== join(sourceRuntimeRoot, "bin", "python") || realpathSync.native(sourceRuntimeRoot) !== sourceRuntimeRoot) {
    throw new Error("SKILLOPT_PYTHON must name a canonical private venv interpreter")
  }
  const sourcePyvenvConfig = join(sourceRuntimeRoot, "pyvenv.cfg")
  const sourceRealExecutable = realpathSync.native(sourceExecutable)
  if (!statSync(sourcePyvenvConfig).isFile() || !statSync(sourceRealExecutable).isFile()) throw new Error("configured Python runtime is unavailable")
  const sourceLib = join(sourceRuntimeRoot, "lib")
  const sitePackages = readdirSync(sourceLib, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^python\d+\.\d+$/u.test(entry.name))
    .map(entry => join(sourceLib, entry.name, "site-packages"))
    .filter(path => existsSync(path))
  if (sitePackages.length !== 1) throw new Error("configured Python site-packages is ambiguous")
  const virtualenvPth = join(sitePackages[0] ?? "", "_virtualenv.pth")
  const virtualenvModule = join(sitePackages[0] ?? "", "_virtualenv.py")
  if (!statSync(virtualenvPth).isFile() || !statSync(virtualenvModule).isFile() ||
      readFileSync(virtualenvPth, "utf8").trim() !== "import _virtualenv") throw new Error("configured Python bootstrap differs")
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "skillopt-campaign-runtime-test-"))
  chmodSync(root, 0o700)
  runtimeScratchRoots.push(root)
  const runtimeRoot = join(root, "skillopt", "runtime", "fa4ca184573e42ec11472959dd57422381418096", "venv")
  mkdirSync(dirname(runtimeRoot), { recursive: true, mode: 0o700 })
  cpSync(sourceRuntimeRoot, runtimeRoot, { recursive: true, dereference: true })
  chmodSync(runtimeRoot, 0o700)
  const bin = join(runtimeRoot, "bin")
  chmodSync(bin, 0o700)
  const executablePath = join(bin, "python")
  rmSync(executablePath, { force: true })
  copyFileSync(sourceRealExecutable, executablePath)
  chmodSync(executablePath, 0o700)
  const copiedConfig = join(runtimeRoot, "pyvenv.cfg")
  if (!readFileSync(copiedConfig).equals(readFileSync(sourcePyvenvConfig))) throw new Error("private venv configuration changed")
  const pthCopy = join(runtimeRoot, relative(sourceRuntimeRoot, virtualenvPth))
  const moduleCopy = join(runtimeRoot, relative(sourceRuntimeRoot, virtualenvModule))
  rmSync(pthCopy)
  rmSync(moduleCopy)
  if (existsSync(pthCopy) || existsSync(moduleCopy)) throw new Error("private venv bootstrap files remain")
  const proofPath = resolve(dirname(runtimeRoot), "native-runtime-proof.json")
  const sourceLockPath = resolve(import.meta.dir, "../../scripts/skillopt-source-lock.json")
  const runnerPath = resolve(import.meta.dir, "../../scripts/skillopt_runner.py")
  const attestation = spawnSync(executablePath, ["-I", "-S", "-B", runnerPath, "attest-native-runtime", "--source-lock", sourceLockPath], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 512 * 1024, shell: false,
    env: { SKILLOPT_PYTHON: executablePath, HOME: emptyHomeDirectory },
  })
  if (attestation.error || attestation.status !== 0 || attestation.signal || attestation.stderr !== "" ||
      !attestation.stdout.endsWith("\n") || attestation.stdout.indexOf("\n") !== attestation.stdout.length - 1) {
    throw new Error("private copied native runtime attestation failed")
  }
  writeFileSync(proofPath, attestation.stdout, { flag: "wx", mode: 0o600 })
  const proof = JSON.parse(attestation.stdout) as Record<string, unknown>
  const interpreter = proof.interpreter as Record<string, unknown>
  if (interpreter.realpath !== executablePath || interpreter.venvRoot !== runtimeRoot ||
      interpreter.sha256 !== sha256(readFileSync(executablePath)) || interpreter.configuredPath !== executablePath ||
      interpreter.pyvenvConfigSha256 !== sha256(readFileSync(copiedConfig)) ||
      (statSync(runtimeRoot).mode & 0o777) !== 0o700 || (statSync(bin).mode & 0o777) !== 0o700 ||
      (statSync(executablePath).mode & 0o777) !== 0o700 || !existsSync(emptyHomeDirectory)) {
    throw new Error("private copied runtime proof identity or permissions mismatch")
  }
  privateRuntime = Object.freeze({ executablePath, nativeRuntimeProofPath: proofPath })
  return privateRuntime
}

function recordTrainerRolloutWrite(state: WorkerHarnessState, value: unknown): void {
  if ((value as { schema?: unknown })?.schema !== "skillopt.rollout-response.v1") return
  const beforeResponse = state.targetResponseBudgets.at(-1)
  if (beforeResponse === undefined) throw new Error("synthetic target response budget was not observed")
  const serializedBytes = Buffer.byteLength(`${canonicalJson(value)}\n`, "utf8")
  state.trainerRolloutBudgets.push({ beforeResponse, beforeWrite: state.controller.status().remaining.artifactBytes, serializedBytes })
}

function recordTrainerOptimizerResponse(state: WorkerHarnessState, value: unknown): void {
  if ((value as { schema?: unknown })?.schema === "skillopt.native-optimizer-response.v1") {
    const beforeResponse = state.optimizerResponseBudgetSnapshots[state.trainerOptimizerResponses.length]
    if (beforeResponse === undefined) throw new Error("optimizer response pre-debit budget was not observed")
    const serializedBytes = Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8")
    state.trainerOptimizerResponseBudgets.push({ beforeResponse,
      beforeWrite: state.controller.status().remaining.artifactBytes, serializedBytes })
    state.trainerOptimizerResponses.push(value)
  }
}

function mockOwnedWorker(profile: SkillOptWorkerProfile, operation: TrustedWorkerOperation): OwnedWorkerHandle {
  const state = workerHarness
  if (!state) throw new Error("campaign worker harness is not active")
  let resolveWait: ((result: OwnedWorkerResult) => void) | undefined
  const done = new Promise<OwnedWorkerResult>(resolveDone => { resolveWait = resolveDone })
  const terminalResult = (status: OwnedWorkerResult["status"], quiescent: boolean): OwnedWorkerResult => ({
    status, exitCode: quiescent ? 0 : null, signal: null, quiescent, stdoutBytes: 0, stderrBytes: 0,
    stdoutSha256: "0".repeat(64), stderrSha256: "0".repeat(64),
  })
  return {
    binding: profile.binding,
    async writeMessage(value: unknown) {
      if (operation === "fixture-apply") {
        const inputPath = fixtureProfileInputs.get(profile)
        if (!inputPath) throw new Error("synthetic fixture profile input path is missing")
        const input = JSON.parse(readFileSync(inputPath, "utf8")) as { outputSlots: { id: string; kind: string }[] }
        const request = value as { writes: { slotId: string; content: string }[] }
        const outputDirectory = fixtureProfilePaths.get(profile)
        if (!outputDirectory) throw new Error("synthetic fixture output slot is missing")
        const artifact = canonicalJson({
          schema: "skillopt.native-wiki-fixture-result.v1",
          slots: request.writes.map(write => {
            const slot = input.outputSlots.find(item => item.id === write.slotId)
            if (!slot) throw new Error("synthetic fixture output slot is missing")
            return { id: slot.id, kind: slot.kind, content: write.content }
          }).sort((left, right) => left.id.localeCompare(right.id)),
        })
        const beforeResponse = state.targetResponseBudgets.at(-1)
        if (beforeResponse === undefined) throw new Error("synthetic target response budget was not observed")
        state.fixtureResultBudgets.push({ beforeResponse, beforeWrite: state.controller.status().remaining.artifactBytes,
          serializedBytes: Buffer.byteLength(artifact, "utf8") })
        nodeFs.writeFileSync(join(outputDirectory, "fixture-result.json"), artifact, { flag: "wx", mode: 0o600 })
        state.abortOnFixtureWrite?.abort()
        if (state.fixtureExitOnAbort) resolveWait?.(terminalResult("cancelled", true))
        return
      }
      throw new Error("synthetic trainer workers cannot provide host-authenticated protocol events")
    },
    closeInput() {
      if (operation === "trainer-native") throw new Error("synthetic trainer workers cannot complete protocol captures")
      resolveWait?.(terminalResult("completed", true))
    },
    onMessage(_callback) { return () => {} },
    onTrainerProtocolEvent(_callback) { return () => {} },
    wait() { return done },
    async cancel() {
      if (operation === "fixture-apply") state.fixtureCancelCount += 1
      else state.trainerCancelCount += 1
      if (operation === "trainer-native" && state.trainerCancellationThrows) throw new Error("synthetic lost trainer cancellation")
      const quiescent = operation === "fixture-apply" ? state.fixtureCancellationQuiescent !== false : true
      const result = terminalResult("cancelled", quiescent)
      if (quiescent) resolveWait?.(result)
      return result
    },
    async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "synthetic test worker is settled" } },
  }
}

// Script only the owned process boundary; profiles, runtime proof, and READY containment receipts remain real.
function campaignHostModule() {
  return {
    ...realHost,
    prepareWorkerProfile(input: WorkerProfileInput) {
      const profile = realHost.prepareWorkerProfile(input)
      if (input.role === "fixture") {
        const state = workerHarness
        if (!state) throw new Error("campaign worker harness is not active")
        fixtureProfilePaths.set(profile, input.outputDirectory)
        fixtureProfileInputs.set(profile, input.selectedInputPath)
        state.fixtureRoots.push(dirname(input.outputDirectory))
        state.fixtureInputBytes.push(readFileSync(input.selectedInputPath))
      }
      return profile
    },
    async probeWorkerContainment(profile: SkillOptWorkerProfile) { return realHost.probeWorkerContainment(profile) },
    launchOwnedWorker(profile: SkillOptWorkerProfile, receipt: SkillOptContainmentReceipt, operation: TrustedWorkerOperation) {
      if (operation === "trainer-native" && workerHarness?.useRealTrainerProtocol) {
        const handle = realHost.launchOwnedWorker(profile, receipt, operation)
        return Object.freeze({ ...handle, async writeMessage(value: unknown) {
          if (workerHarness) recordTrainerRolloutWrite(workerHarness, value)
          if (workerHarness) recordTrainerOptimizerResponse(workerHarness, value)
          return handle.writeMessage(value)
        } })
      }
      return mockOwnedWorker(profile, operation)
    },
  }
}

function campaignNativeIdentity(engine: CliTransportOptions["engine"], model: string): CliNativeIdentity | undefined {
  if (engine === "local") return undefined
  const binding = [modelBindings.generator, modelBindings.target, modelBindings.reviewer]
    .find(candidate => candidate.engine === engine && candidate.requestedModel === model)
  return binding ? structuredClone({ engine: binding.engine, requestedModel: binding.requestedModel,
    runtimeIdentity: binding.runtimeIdentity, profileIdentity: binding.profileIdentity }) : undefined
}

function campaignTransportModule() {
  return {
    ...realTransport,
    createCliTransport(options: CliTransportOptions) {
      return {
        async inspectIdentity() { return campaignNativeIdentity(options.engine, options.model) },
        async run(): Promise<CliTransportResult> {
          nativeTransportRuns.push(options.prompt)
          if (options.model === modelBindings.target.requestedModel && workerHarness) {
            workerHarness.targetResponseBudgets.push(workerHarness.controller.status().remaining.artifactBytes)
          }
          if (options.model === modelBindings.generator.requestedModel && workerHarness) {
            workerHarness.optimizerResponseBudgetSnapshots.push(workerHarness.controller.status().remaining.artifactBytes)
          }
          return { status: "completed", text: activeCampaignResponse(options.prompt, options.engine, options.model),
            quiescent: true }
        },
        async requestCancel() { return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
        async reconcile(): Promise<ExecutionReconciliation> {
          return { outcome: "terminal", quiescent: true, evidence: "scripted CLI transport returned terminal output" }
        },
      }
    },
  }
}

beforeAll(async () => {
  realHost = Object.freeze({ ...await import("../src/skillopt/host.ts") })
  const evaluation = await import("../src/skillopt/evaluation.ts")
  measureNativeQualification = evaluation.measureNativeQualification
  renderNativeEvaluationPrompt = evaluation.renderNativeEvaluationPrompt
  NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA = evaluation.NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA
  planNativeFixtureSerializedWrites = evaluation.planNativeFixtureSerializedWrites
  serializeNativeFixtureWorkerInput = evaluation.serializeNativeFixtureWorkerInput
  const campaignProtocol = await import("../src/skillopt/campaign-protocol.ts")
  buildNativeAdapterManifest = campaignProtocol.buildNativeAdapterManifest
  buildNativeCampaignSchedule = campaignProtocol.buildNativeCampaignSchedule
  createNativeTrainerWire = campaignProtocol.createNativeTrainerWire
  const trainerApi = await import("../src/skillopt/trainer.ts")
  NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES = trainerApi.NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES
  NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES = trainerApi.NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES
  nativeSkillOptTrainerMaterializationMetadata = trainerApi.nativeSkillOptTrainerMaterializationMetadata
  planNativeSkillOptTrainerMaterialization = trainerApi.planNativeSkillOptTrainerMaterialization
  mock.module(hostModule, campaignHostModule)
  mock.module(transportModule, campaignTransportModule)
  const brokerApi = await import("../src/skillopt/broker.ts")
  SkillOptBrokerError = brokerApi.SkillOptBrokerError
  createNativeSkillOptBroker = brokerApi.createNativeSkillOptBroker
  getNativeSkillOptBrokerWorktree = brokerApi.getNativeSkillOptBrokerWorktree
  const campaignApi = await import("../src/skillopt/campaign.ts")
  classifyNativeCampaignRequestFailure = campaignApi.classifyNativeCampaignRequestFailure
  nativeCampaignConsentDisclosure = campaignApi.nativeCampaignConsentDisclosure
  runNativeSkillOptCampaign = campaignApi.runNativeSkillOptCampaign
  consumeNativeCampaignQualification = campaignApi.consumeNativeCampaignQualification
  if (!nativePlatformSupported) return
  nativeHelperRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "skillopt-campaign-native-helper-")))
  chmodSync(nativeHelperRoot, 0o700)
  nativeHelperPath = join(nativeHelperRoot, "skillopt-native")
  const sourcePath = resolve(import.meta.dir, "../src/skillopt/native.c")
  execFileSync(process.env.CC ?? "cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", sourcePath, "-o", nativeHelperPath], { stdio: "pipe" })
  chmodSync(nativeHelperPath, 0o700)
  nativeHelperSha256 = sha256(readFileSync(nativeHelperPath))
})

afterEach(() => {
  activeCampaignArtifactController = undefined
  campaignFsWrites.splice(0)
  campaignSerializedWrites.splice(0)
  campaignFsWriteKeys.clear()
  campaignWriteTimestamps.splice(0)
  for (const root of workerScratchRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const root of workerHarness?.fixtureRoots ?? []) rmSync(root, { recursive: true, force: true })
  nativeTransportRuns.splice(0)
  activeCampaignResponse = () => "synthetic response"
  for (const fixture of campaignWorktrees.splice(0).reverse()) {
    if (!fixture.owner.isReleased && !fixture.runtime.runs.status().claim) {
      try { fixture.owner.release({ workflowQuiescent: true, evidence: "synthetic campaign boundary settled", workflowID: null, revision: null }) }
      catch { /* Fixture cleanup remains confined to its private worktree. */ }
    }
    fixture.worktree.cleanup()
  }
  workerHarness = undefined
})

afterAll(() => {
  mock.module(hostModule, () => realHost)
  mock.module(transportModule, () => realTransport)
  if (nativeHelperRoot) rmSync(nativeHelperRoot, { recursive: true, force: true })
  for (const root of runtimeScratchRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("serialized qualification claims cannot mint campaign authority", () => {
  const forged = Object.freeze({
    runId: "forged", bindingSha256: "a".repeat(64), scheduleSha256: "b".repeat(64),
    candidateSha256: "c".repeat(64), resultsSha256: "d".repeat(64), reviewSha256: "e".repeat(64),
  }) as unknown as Parameters<typeof consumeNativeCampaignQualification>[0]
  expect(() => consumeNativeCampaignQualification(forged)).toThrow("campaign_qualification_invalid_or_consumed")
  expect(() => consumeNativeCampaignQualification(JSON.parse(JSON.stringify(forged))))
    .toThrow("campaign_qualification_invalid_or_consumed")
})

test("campaign request failures map the closed broker taxonomy without exposing unknown errors", () => {
  // These direct classifier assertions create no workers and do not exercise dispatch or qualification.
  const brokerFailures = [
    ["invalid_request", "BLOCKED"],
    ["dataset_invalid", "BLOCKED"],
    ["binding_drift", "BLOCKED"],
    ["owner_unavailable", "BLOCKED"],
    ["owner_busy", "BLOCKED"],
    ["dispatch_not_authorized", "BLOCKED"],
    ["native_identity_unavailable", "BLOCKED"],
    ["native_execution_failed", "FAILED"],
    ["sensitive_input", "BLOCKED"],
    ["response_limit", "FAILED"],
    ["empty_response", "FAILED"],
    ["unsafe_response", "FAILED"],
    ["cancelled", "CANCELLED"],
    ["not_active", "BLOCKED"],
    ["execution_unresolved", "UNRESOLVED"],
    ["controller_unavailable", "UNRESOLVED"],
  ] as const
  for (const [code, status] of brokerFailures) {
    expect(classifyNativeCampaignRequestFailure(new SkillOptBrokerError(code))).toEqual({ reasonCode: code, status })
  }

  const privateMessage = "private dispatch payload must not escape"
  const unknownError = new Error(privateMessage)
  expect(classifyNativeCampaignRequestFailure(unknownError)).toEqual({
    reasonCode: "native_campaign_request_failed", status: "FAILED",
  })
  expect(classifyNativeCampaignRequestFailure(unknownError, "native_campaign_failed")).toEqual({
    reasonCode: "native_campaign_failed", status: "FAILED",
  })
  expect(JSON.stringify(classifyNativeCampaignRequestFailure(unknownError))).not.toContain(privateMessage)

  const malformedBrokerError = new SkillOptBrokerError("private broker code" as never)
  expect(classifyNativeCampaignRequestFailure(malformedBrokerError)).toEqual({
    reasonCode: "native_campaign_request_failed", status: "FAILED",
  })
  expect(classifyNativeCampaignRequestFailure(malformedBrokerError, "native_campaign_failed")).toEqual({
    reasonCode: "native_campaign_failed", status: "FAILED",
  })
  expect(JSON.stringify(classifyNativeCampaignRequestFailure(malformedBrokerError))).not.toContain("private broker code")
})

type CampaignTrainer = NonNullable<Parameters<typeof runNativeSkillOptCampaign>[0]["trainer"]>

async function prepareCampaignTrainer(fixture: CampaignFixture, prepared: SkillOptPrepared = fixture.prepared): Promise<CampaignTrainer> {
  const sourceLockPath = resolve(import.meta.dir, "../../scripts/skillopt-source-lock.json")
  const sourceLockSha256 = sha256(readFileSync(sourceLockPath))
  const originalSkill = assembleSkill(baselineSkill, "")
  const manifest = buildNativeAdapterManifest({
    fixturePack: fixture.dataset.fixturePack, runId: prepared.runId,
    originalSkillSha256: sha256(originalSkill), sourceLockSha256,
  })
  const root = mkdtempSync(join(tmpdir(), "skillopt-campaign-profile-test-"))
  chmodSync(root, 0o700)
  workerScratchRoots.push(root)
  const inputDirectory = join(root, "input")
  const outputDirectory = join(root, "output")
  const emptyHomeDirectory = join(root, "home")
  const probeDirectory = join(root, "probe")
  for (const directory of [inputDirectory, outputDirectory, emptyHomeDirectory, probeDirectory]) mkdirSync(directory, { mode: 0o700 })
  const selectedInputPath = join(inputDirectory, "trainer-input.json")
  const adapterManifestPath = join(inputDirectory, "protocol.json")
  const runtime = privateRuntimeFor(emptyHomeDirectory)
  const plan = planNativeSkillOptTrainerMaterialization({ worktree: fixture.root, runtime,
    dataset: fixture.dataset, prepared, baselineSkillBytes: Buffer.from(baselineSkill) })
  const materialization = nativeSkillOptTrainerMaterializationMetadata(plan)
  const remainingBefore = fixture.broker.controller.status().remaining.artifactBytes
  const allowance = fixture.broker.controller.reserveNativeTrainerMaterialization({ owner: fixture.owner,
    runtime: fixture.runtime, prepared, current: fixture.current, materialization })
  expect(fixture.broker.controller.status().remaining.artifactBytes).toBe(remainingBefore -
    (materialization.projectionBytes + materialization.manifestBytes * 2 + NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES +
      NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES))
  const protocolStageAllowance = fixture.broker.controller.consumeNativeTrainerMaterializationAllowance(allowance, {
    owner: fixture.owner, runtime: fixture.runtime, prepared, current: fixture.current, materialization,
  })
  const projectionBytes = Buffer.from(canonicalJson(trainerSafeProjection(fixture.dataset)), "utf8")
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8")
  expect(sha256(projectionBytes)).toBe(materialization.projectionSha256)
  expect(projectionBytes.byteLength).toBe(materialization.projectionBytes)
  expect(sha256(manifestBytes)).toBe(materialization.manifestSha256)
  expect(manifestBytes.byteLength).toBe(materialization.manifestBytes)
  writeFileSync(selectedInputPath, projectionBytes, { flag: "wx", mode: 0o600 })
  writeFileSync(adapterManifestPath, manifestBytes, { flag: "wx", mode: 0o600 })
  const workerInput: WorkerProfileInput = {
    role: "trainer", executablePath: runtime.executablePath, nativeRuntimeProofPath: runtime.nativeRuntimeProofPath,
    selectedInputPath, outputDirectory, emptyHomeDirectory, probeDirectory, adapterManifestPath, protocolStageAllowance,
  }
  const profile = realHost.prepareWorkerProfile(workerInput)
  const receipt = await realHost.probeWorkerContainment(profile)
  expect(receipt.status).toBe("READY")
  expect(receipt.bindingSha256).toBe(profile.binding.profileSha256)
  expect(profile.binding.inputSha256).toBe(sha256(projectionBytes))
  expect(profile.binding.adapterManifestSha256).toBe(sha256(canonicalJson(manifest)))
  const state: WorkerHarnessState = {
    controller: fixture.broker.controller,
    targetResponseBudgets: [], fixtureResultBudgets: [], trainerRolloutBudgets: [],
    trainerOptimizerResponses: [], trainerOptimizerResponseBudgets: [], optimizerResponseBudgetSnapshots: [],
    fixtureRoots: [], fixtureInputBytes: [], fixtureCancelCount: 0,
    trainerCancelCount: 0,
  }
  workerHarness = state
  const trainer = {
    profile,
    receipt,
    outputDirectory,
    executablePath: runtime.executablePath,
    nativeRuntimeProofPath: runtime.nativeRuntimeProofPath,
  }
  return trainer
}

const modelBindings: NativeModelBindings = {
  generator: { engine: "codex", requestedModel: "gpt-5-codex", runtimeIdentity: { version: "codex test", executableSha256: "a".repeat(64) }, profileIdentity: { id: "codex-test", sha256: "b".repeat(64) } },
  target: { engine: "claude", requestedModel: "claude-test", runtimeIdentity: { version: "claude test", executableSha256: "c".repeat(64) }, profileIdentity: { id: "claude-test", sha256: "d".repeat(64) } },
  reviewer: { engine: "claude", requestedModel: "claude-review-test", runtimeIdentity: { version: "claude test", executableSha256: "c".repeat(64) }, profileIdentity: { id: "claude-review-test", sha256: "e".repeat(64) } },
}

const baselineSkill = `---\nname: llm-wiki\ndescription: Synthetic campaign fixture\n---\n\n${COMPILE_ANCHOR}3. Preserve supported Wiki facts.\n`

function dataset(root: string): ReturnType<typeof createNativeDataset> {
  const source = Buffer.from("Private selected source fixture for campaign integration tests.\n", "utf8")
  const sourcePath = `knowledge/raw/documents/${sha256(source)}.md`
  const absoluteSource = join(root, sourcePath)
  mkdirSync(dirname(absoluteSource), { recursive: true, mode: 0o700 })
  writeFileSync(absoluteSource, source, { flag: "wx", mode: 0o600 })
  return createNativeDataset({
    root,
    selections: [{ path: sourcePath }],
    fixturePack: pack(),
    modelBindings,
  })
}

type CampaignFixture = Awaited<ReturnType<typeof makeCampaignFixture>>

async function makeCampaignFixture(): Promise<{
  worktree: TempWorktree
  root: string
  runtime: ReturnType<typeof createExecutionRuntime>
  owner: ReturnType<typeof attachAdmission>
  broker: NativeSkillOptBroker
  current: SkillOptCurrentBinding
  dataset: ReturnType<typeof createNativeDataset>
  prepared: SkillOptPrepared
  consent: SkillOptConsent
}> {
  if (!nativePlatformSupported || !nativeHelperPath || !nativeHelperSha256) throw new Error("native campaign broker fixture is unavailable")
  const worktree = tempWorktree()
  const root = realpathSync.native(worktree.worktree)
  const skillPath = join(root, ".agents", "skills", "llm-wiki", "SKILL.md")
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baselineSkill, { flag: "wx", mode: 0o600 })
  const currentDataset = dataset(root)
  if (currentDataset.status !== "STRUCTURALLY_VALID") throw new Error("private selected-source campaign dataset is invalid")
  const host: ExecutionHost = {
    identity: { engine: "codex", profile: "legacy-unowned" },
    async preflight() { return { compatible: true, controls: {}, problems: [] } },
    async prepare(_request: ExecutionRequest) { throw new Error("campaign requests must use the native broker transport") },
    async reconcile(): Promise<ExecutionReconciliation> {
      return { outcome: "unknown", quiescent: false, evidence: "generic campaign host was not used" }
    },
  }
  const runtime = createExecutionRuntime({ directory: root, worktree: root, config: structuredClone(DEFAULT_CONFIG), log() {} },
    () => host, { planningOnlyMain: true })
  const owner = attachAdmission(runtime, `session_${randomUUID().replaceAll("-", "")}`,
    { engine: modelBindings.generator.engine, model: modelBindings.generator.requestedModel })
  campaignWorktrees.push({ worktree, runtime, owner })
  const broker = createNativeSkillOptBroker(runtime, { nativeHelperPath, nativeHelperSha256 })
  broker.controller.initialize()
  const current = { dataset: currentDataset, baselineSkillSha256: sha256(baselineSkill) }
  const prepared = broker.controller.prepare({ owner, campaignId: `campaign_${randomUUID().replaceAll("-", "")}`,
    dataset: currentDataset, baselineSkillSha256: current.baselineSkillSha256 })
  if (prepared.state !== "PREPARED") throw new Error("campaign fixture did not reach prepared state")
  const receipt = await withTerminalLine(`APPROVE ${prepared.runId} ${prepared.consentBindingSha256}`,
    () => humanDecision("approve", prepared.decisionBinding))
  const consent = broker.controller.consent(prepared, receipt, current)
  return { worktree, root, runtime, owner, broker, current, dataset: currentDataset, prepared, consent }
}

function addAutomaticCampaignDigests(root: string, count: number): void {
  const directory = digestDirectory(root)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (let index = 0; index < count; index += 1) {
    const sessionID = `automatic_campaign_${index}_${randomUUID().replaceAll("-", "")}`
    const endedAt = Date.now() + 60_000 + index
    writeFileSync(join(directory, `${sessionID}.json`), JSON.stringify({
      schemaVersion: 1, kind: "session-digest", sessionID, engine: "codex", model: modelBindings.generator.requestedModel,
      startedAt: endedAt - 1000, endedAt, turns: 1, tools: {}, decisions: {}, files: ["knowledge/raw/synthetic-private.md"],
      commands: [], workflows: [], outcome: "completed", complete: true,
    }), { flag: "wx", mode: 0o600 })
  }
}

// Synthetic fixtures exercise disclosure and pre-dispatch refusal paths without a model host.
function fixture(split: NativeWikiFixture["split"], index: number): NativeWikiFixture {
  const id = `${split}-${index}`
  const stratum = NATIVE_WIKI_STRATA[index % NATIVE_WIKI_STRATA.length]
  if (!stratum) throw new Error("synthetic fixture stratum is missing")
  const sourceId = "source"
  const slotId = "page"
  const original = `The original observation for ${id}.`
  const correction = `The correction for ${id}.`
  const content = `${original}\n${correction}\n`
  const facts = [
    { id: "original", slotId, statement: original, sourceIds: [sourceId] },
    { id: "correction", slotId, statement: correction, sourceIds: [sourceId] },
  ]
  const originalFact = facts[0]
  const correctionFact = facts[1]
  if (!originalFact || !correctionFact) throw new Error("synthetic fixture facts are incomplete")
  const escape = (value: string) => value.replace(/[\\`*_[\]{}()<>#+.!|~-]/g, "\\$&").replace(/[\r\n]/g, " ")
  const line = (statement: string) => `- ${escape(statement)} ([${escape(sourceId)}](../sources/documents-${sha256(content)}.md))`
  const orderedStatements = [original, correction].sort()
  const firstStatement = orderedStatements[0]
  const secondStatement = orderedStatements[1]
  if (!firstStatement || !secondStatement) throw new Error("synthetic contradiction is incomplete")
  const conflictLine = `- ${escape(firstStatement)} ↔ ${escape(secondStatement)} — retain-both.`
  const existingContent = stratum === "dedup-resume"
    ? `${line(original)}\n`
    : stratum === "ownership-injection"
      ? `${line(original)}\n${line(correction)}\n${conflictLine}\n`
      : "Previous observation.\n"
  return {
    id, familyId: `family-${id}`, lineage: [`lineage-${id}`], split, stratum, authorship: "agent-authored",
    sources: [{ id: sourceId, provenance: "raw", content, sha256: sha256(content) }],
    task: `Integrate the observations for ${id} in [[slot:${slotId}]] and preserve the previous report.`,
    outputSlots: [{ id: slotId, kind: "page", existingContent }],
    assertions: {
      facts,
      citations: facts.map(fact => ({ factId: fact.id, sourceId })),
      contradictions: [{ leftFactId: originalFact.id, rightFactId: correctionFact.id, expected: "retain-both" }],
      deduplication: [{ slotId, expected: "reuse-existing" }],
      ownership: [{ slotId, expected: stratum === "ownership-injection" ? "preserve-existing" : "append-only" }],
    },
    forbiddenChanges: NATIVE_PROTECTED_CHANGES,
  }
}

function pack(): NativeWikiFixturePack {
  return {
    schema: NATIVE_FIXTURE_PACK_SCHEMA,
    contract: NATIVE_WIKI_CONTRACT,
    fixtures: NATIVE_WIKI_SPLITS.flatMap(split =>
      Array.from({ length: NATIVE_WIKI_SPLIT_MINIMUMS[split] }, (_, index) => fixture(split, index))),
  }
}

test("campaign disclosure exposes exact request limits and provider-token uncertainty without authorizing work", () => {
  const disclosure = nativeCampaignConsentDisclosure(pack())
  expect(disclosure.targetRequests).toBe(432)
  expect(disclosure.canaryReserve).toBe(16)
  expect(disclosure.targetRequestsWithReserve).toBe(448)
  expect(disclosure.targetRequestCap).toBe(512)
  expect(disclosure.requestedCompletionTokenMaximum).toBe(16_384)
  expect(disclosure.completionTokenMaximumIsMetadataOnly).toBe(true)
  expect(disclosure.providerTokenMaximumEnforced).toBe(false)
  expect(disclosure.usageMayBeUnknown).toBe(true)
  expect(disclosure.completionGuaranteed).toBe(false)
  expect(Object.isFrozen(disclosure)).toBe(true)
})

test.skipIf(!nativePlatformSupported)("revalidates selected sources against the private broker worktree and rejects copied brokers", async () => {
  const fixture = await makeCampaignFixture()
  expect(getNativeSkillOptBrokerWorktree(fixture.broker)).toBe(realpathSync.native(fixture.root))
  const selected = fixture.dataset.sourceManifest.entries[0]
  if (!selected) throw new Error("private campaign source selection is missing")
  expect(realpathSync.native(fixture.root)).not.toBe(realpathSync.native(resolve(import.meta.dir, "../..")))
  expect(existsSync(join(fixture.root, selected.path))).toBe(true)
  expect(await runNativeSkillOptCampaign({ broker: fixture.broker, owner: fixture.owner, runtime: fixture.runtime,
    getCurrent: () => fixture.current, prepared: fixture.prepared, originalSkill: baselineSkill }))
    .toMatchObject({ status: "BLOCKED", reasonCode: "schedule_consent_required" })
  expect(fixture.broker.controller.status().requestCounts.dispatched).toEqual({ target: 0, optimizer: 0, reviewer: 0 })

  let forgedDispatches = 0
  let forgedFinishes = 0
  const forgedBroker = {
    ...fixture.broker,
    controller: { finish() { forgedFinishes += 1 } },
    async dispatch() { forgedDispatches += 1; throw new Error("forged broker dispatched") },
  } as unknown as NativeSkillOptBroker
  const copiedBroker = Object.freeze({ ...fixture.broker }) as NativeSkillOptBroker
  const serializedBroker = JSON.parse(JSON.stringify(fixture.broker)) as NativeSkillOptBroker
  expect(getNativeSkillOptBrokerWorktree(forgedBroker)).toBeUndefined()
  expect(getNativeSkillOptBrokerWorktree(copiedBroker)).toBeUndefined()
  expect(getNativeSkillOptBrokerWorktree(serializedBroker)).toBeUndefined()
  const variants = [forgedBroker, copiedBroker, serializedBroker]
  for (const broker of variants) {
    const result = await runNativeSkillOptCampaign({ broker, owner: fixture.owner, runtime: fixture.runtime, getCurrent: () => fixture.current,
      prepared: fixture.prepared, consent: fixture.consent, originalSkill: baselineSkill })
    expect(result).toMatchObject({ status: "BLOCKED", reasonCode: "campaign_broker_untrusted" })
  }
  expect(forgedDispatches).toBe(0)
  expect(forgedFinishes).toBe(0)
  expect(Reflect.set(fixture.broker, "dispatch", async () => undefined)).toBe(false)
  expect(fixture.broker.controller.status().requestCounts.dispatched).toEqual({ target: 0, optimizer: 0, reviewer: 0 })
})

test.skipIf(!nativePlatformSupported)("DATA_REQUIRED, forged consent, and schedule mismatch stop before dispatch", async () => {
  const fixture = await makeCampaignFixture()
  const untrustedRequired = await runNativeSkillOptCampaign({
    broker: {} as NativeSkillOptBroker,
    owner: fixture.owner,
    runtime: fixture.runtime,
    getCurrent: () => { throw new Error("DATA_REQUIRED must not read current bindings") },
    prepared: { state: "DATA_REQUIRED", reasonCode: "data-required" },
    originalSkill: baselineSkill,
  })
  expect(untrustedRequired.status).toBe("DATA_REQUIRED")

  let currentReads = 0
  const getCurrent = () => { currentReads += 1; return fixture.current }
  const forgedConsent = Object.freeze({ ...fixture.consent, scheduleSha256: "f".repeat(64) })
  const forged = await runNativeSkillOptCampaign({ broker: fixture.broker, owner: fixture.owner, runtime: fixture.runtime, getCurrent,
    prepared: fixture.prepared, consent: forgedConsent, originalSkill: baselineSkill })
  expect(forged).toMatchObject({ status: "BLOCKED", reasonCode: "schedule_consent_required" })
  expect(forged.schedule?.scheduleSha256).toBe(fixture.prepared.scheduleSha256)
  const mismatchedHash = fixture.prepared.scheduleSha256.startsWith("0")
    ? `1${fixture.prepared.scheduleSha256.slice(1)}` : `0${fixture.prepared.scheduleSha256.slice(1)}`
  const mismatchedPrepared = Object.freeze({ ...fixture.prepared, scheduleSha256: mismatchedHash })
  const mismatchedConsent = Object.freeze({ ...fixture.consent, scheduleSha256: mismatchedHash })
  const mismatched = await runNativeSkillOptCampaign({ broker: fixture.broker, owner: fixture.owner, runtime: fixture.runtime, getCurrent,
    prepared: mismatchedPrepared, consent: mismatchedConsent, originalSkill: baselineSkill })
  expect(mismatched).toMatchObject({ status: "BLOCKED", reasonCode: "schedule_consent_required" })
  expect(currentReads).toBe(2)
  expect(fixture.broker.controller.status().requestCounts.dispatched).toEqual({ target: 0, optimizer: 0, reviewer: 0 })
})

test.skipIf(!nativePlatformSupported)("pre-aborted campaigns cancel unstarted through the actual controller without reading current bindings", async () => {
  const fixture = await makeCampaignFixture()
  const abort = new AbortController()
  abort.abort()
  let currentReads = 0
  const foreign = attachAdmission(fixture.runtime, `session_${randomUUID().replaceAll("-", "")}`,
    { engine: modelBindings.generator.engine, model: modelBindings.generator.requestedModel })
  try {
    const refused = await runNativeSkillOptCampaign({ broker: fixture.broker, owner: foreign, runtime: fixture.runtime,
      getCurrent: () => { currentReads += 1; return fixture.current }, prepared: fixture.prepared,
      consent: fixture.consent, originalSkill: baselineSkill, signal: abort.signal })
    expect(refused).toMatchObject({ status: "UNRESOLVED", reasonCode: "campaign_unstarted_cancel_unresolved" })
    expect(fixture.broker.controller.status()).toMatchObject({ state: "CONSENTED", pendingDispatch: false,
      requestCounts: { charged: { target: 0, optimizer: 0, reviewer: 0 },
        dispatched: { target: 0, optimizer: 0, reviewer: 0 }, unknown: { target: 0, optimizer: 0, reviewer: 0 } } })
  } finally {
    if (!foreign.isReleased) foreign.release({ workflowQuiescent: true,
      evidence: "foreign campaign cancellation guard fixture settled", workflowID: null, revision: null })
  }

  const result = await runNativeSkillOptCampaign({ broker: fixture.broker, owner: fixture.owner, runtime: fixture.runtime,
    getCurrent: () => { currentReads += 1; return fixture.current }, prepared: fixture.prepared,
    consent: fixture.consent, originalSkill: baselineSkill, signal: abort.signal })
  expect(result).toMatchObject({ status: "CANCELLED", reasonCode: "cancelled" })
  expect(currentReads).toBe(0)
  expect(nativeTransportRuns).toHaveLength(0)
  expect(fixture.broker.controller.status()).toMatchObject({ state: "CANCELLED", pendingDispatch: false,
    requestCounts: { charged: { target: 0, optimizer: 0, reviewer: 0 },
      dispatched: { target: 0, optimizer: 0, reviewer: 0 }, unknown: { target: 0, optimizer: 0, reviewer: 0 } } })
})

test.skipIf(!canRunContainedWorkers || !nativePlatformSupported)("automatic pre-reservation refusal keeps the actual arm and dispatches nothing", async () => {
  const fixture = await makeCampaignFixture()
  const schedule = buildNativeCampaignSchedule(fixture.dataset.fixturePack)
  const arm = fixture.broker.controller.arm(fixture.prepared, fixture.consent, fixture.current)
  addAutomaticCampaignDigests(fixture.root, 4)
  const trainer = await prepareCampaignTrainer(fixture)
  const databasePath = join(dirname(executionRunDirectory(fixture.root)), "skillopt", "automation", "ledger.sqlite")
  const beforeDatabase = new Database(databasePath, { readonly: true, readwrite: false, create: false })
  const before = Object.freeze({
    quota: beforeDatabase.query("SELECT last_attempt_id,last_attempt_boot,last_attempt_cont FROM quota WHERE singleton=1").get(),
    run: beforeDatabase.query("SELECT run_id,state,expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?")
      .get(fixture.prepared.runId),
    arm: beforeDatabase.query("SELECT * FROM arms WHERE run_id=?").get(fixture.prepared.runId),
    usage: beforeDatabase.query("SELECT * FROM usage WHERE run_id=?").get(fixture.prepared.runId),
    attempts: beforeDatabase.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(fixture.prepared.runId),
    requests: beforeDatabase.query("SELECT count(*) AS count FROM requests WHERE run_id=?").get(fixture.prepared.runId),
  })
  beforeDatabase.close()

  const result = await withCampaignArtifactWriteSpy(fixture.broker.controller, () =>
    runNativeSkillOptCampaign({ broker: fixture.broker, owner: fixture.owner, runtime: fixture.runtime,
      getCurrent: () => fixture.current, prepared: fixture.prepared, consent: fixture.consent, arm,
      originalSkill: baselineSkill, trainer }))
  expect({ status: result.status, reasonCode: result.reasonCode, diagnostic: result.diagnostic,
    candidateApprovalRequired: result.candidateApprovalRequired })
    .toEqual({ status: "BLOCKED", reasonCode: "digest-threshold", diagnostic: undefined, candidateApprovalRequired: true })
  expect(result).not.toHaveProperty("candidate")
  expect(nativeTransportRuns).toHaveLength(0)
  expect(workerHarness?.trainerCancelCount).toBe(0)
  expect(workerHarness?.fixtureInputBytes).toHaveLength(1)
  expect(campaignFsWrites.some(write => write.kind === "fixture-preflight")).toBe(true)
  expect(campaignFsWrites.some(write => write.kind === "worker-input")).toBe(true)
  expect(campaignFsWrites.some(write => write.kind === "fixture-probe")).toBe(true)
  expect(fixture.broker.controller.status()).toMatchObject({ state: "ARMED", runId: fixture.prepared.runId,
    pendingDispatch: false, requestCounts: { charged: { target: 0, optimizer: 0, reviewer: 0 },
      dispatched: { target: 0, optimizer: 0, reviewer: 0 }, unknown: { target: 0, optimizer: 0, reviewer: 0 } } })
  const afterDatabase = new Database(databasePath, { readonly: true, readwrite: false, create: false })
  try {
    const after = {
      quota: afterDatabase.query("SELECT last_attempt_id,last_attempt_boot,last_attempt_cont FROM quota WHERE singleton=1").get(),
      run: afterDatabase.query("SELECT run_id,state,expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?")
        .get(fixture.prepared.runId),
      arm: afterDatabase.query("SELECT * FROM arms WHERE run_id=?").get(fixture.prepared.runId),
      usage: afterDatabase.query("SELECT * FROM usage WHERE run_id=?").get(fixture.prepared.runId),
      attempts: afterDatabase.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(fixture.prepared.runId),
      requests: afterDatabase.query("SELECT count(*) AS count FROM requests WHERE run_id=?").get(fixture.prepared.runId),
    }
    expect(after.quota).toEqual(before.quota)
    expect(after.run).toEqual(before.run)
    expect(after.arm).toEqual(before.arm)
    expect(after.attempts).toEqual({ count: 0 })
    expect(after.requests).toEqual({ count: 0 })
    const fixtureTimestamp = campaignWriteTimestamps[0]
    if (!fixtureTimestamp || campaignWriteTimestamps.some(timestamp => timestamp !== fixtureTimestamp)) {
      throw new Error("automatic-refusal fixture writes did not share one captured timestamp")
    }
    const preflightBytes = fixture.dataset.fixturePack.fixtures.reduce((total, item) => {
      const plan = planNativeFixtureSerializedWrites({ fixture: item, pid: process.pid, timestamp: fixtureTimestamp })
      return total + plan.initializationWrites.reduce((sum, write) => sum + write.bytes, 0)
    }, 0)
    const firstTraining = schedule.training[0]
    const firstTrainingFixture = firstTraining
      ? fixture.dataset.fixturePack.fixtures.find(item => item.id === firstTraining.caseId) : undefined
    const firstWorkerInput = workerHarness?.fixtureInputBytes[0]
    if (!firstTrainingFixture || !firstWorkerInput) throw new Error("automatic-refusal first target static plan is unavailable")
    const firstInitialization = planNativeFixtureSerializedWrites({ fixture: firstTrainingFixture,
      pid: process.pid, timestamp: fixtureTimestamp }).initializationWrites.reduce((sum, write) => sum + write.bytes, 0)
    const targetStaticBytes = firstInitialization + firstWorkerInput.byteLength + realHost.nativeSkillOptFixtureProbeSerializedBytes() +
      realHost.nativeSkillOptFixtureResultByteBound(firstTrainingFixture.outputSlots) + NATIVE_DATASET_LIMITS.nativeResponseBytes +
      realTransport.nativeObservedUsageCanonicalByteBound()
    const actualArtifactCharge = (after.usage as { artifact_bytes: number }).artifact_bytes -
      (before.usage as { artifact_bytes: number }).artifact_bytes
    expect(actualArtifactCharge).toBe(preflightBytes + targetStaticBytes)
    expect(actualArtifactCharge).toBeGreaterThan(0)
    const withoutArtifactBytes = (value: unknown) => Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "artifact_bytes"))
    expect(withoutArtifactBytes(after.usage)).toEqual(withoutArtifactBytes(before.usage))
  } finally { afterDatabase.close() }

  const budgetFixture = await makeCampaignFixture()
  const budgetTrainer = await prepareCampaignTrainer(budgetFixture)
  const budgetController = budgetFixture.broker.controller
  const firstFixture = budgetFixture.dataset.fixturePack.fixtures[0]
  if (!firstFixture) throw new Error("artifact-budget fixture pack is empty")
  const firstPlan = planNativeFixtureSerializedWrites({ fixture: firstFixture, pid: process.pid, timestamp: new Date().toISOString() })
  const firstStageBytes = firstPlan.initializationWrites.reduce((total, write) => total + write.bytes, 0)
  const beforeStageBudget = budgetController.status().remaining.artifactBytes
  const prechargeBytes = beforeStageBudget - firstStageBytes + 1
  if (prechargeBytes < 1) throw new Error("artifact-budget fixture lacks one stage of headroom")
  budgetController.reserveNativePreparationArtifacts({ owner: budgetFixture.owner, runtime: budgetFixture.runtime,
    runId: budgetFixture.prepared.runId, current: budgetFixture.current, bytes: prechargeBytes })
  const remainingBeforeDeniedStage = budgetController.status().remaining.artifactBytes
  expect(remainingBeforeDeniedStage).toBe(firstStageBytes - 1)
  const budgetArm = budgetController.arm(budgetFixture.prepared, budgetFixture.consent, budgetFixture.current)
  campaignFsWrites.splice(0)
  campaignSerializedWrites.splice(0)
  campaignFsWriteKeys.clear()
  const denied = await withCampaignArtifactWriteSpy(budgetController, () =>
    runNativeSkillOptCampaign({ broker: budgetFixture.broker, owner: budgetFixture.owner, runtime: budgetFixture.runtime,
      getCurrent: () => budgetFixture.current, prepared: budgetFixture.prepared, consent: budgetFixture.consent, arm: budgetArm,
      originalSkill: baselineSkill, trainer: budgetTrainer }))
  expect(denied).toMatchObject({ status: "BLOCKED", reasonCode: "campaign_artifact_stage_denied" })
  expect(budgetController.status()).toMatchObject({ state: "ARMED", pendingDispatch: false,
    requestCounts: { charged: { target: 0, optimizer: 0, reviewer: 0 },
      dispatched: { target: 0, optimizer: 0, reviewer: 0 }, unknown: { target: 0, optimizer: 0, reviewer: 0 } } })
  expect(budgetController.status().remaining.artifactBytes).toBe(remainingBeforeDeniedStage)
  expect(workerHarness?.fixtureInputBytes).toHaveLength(0)
  expect(campaignFsWrites).toHaveLength(0)
})

function emptyFixtureResponse(fixture: NativeWikiFixture): string {
  return canonicalJson({ schema: NATIVE_WIKI_OUTPUT_SCHEMA, writes: fixture.outputSlots.map(slot => ({
    slotId: slot.id, content: canonicalJson({ schema: NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA, action: "append", facts: [], contradictions: [] }),
  })) })
}

function idealFixtureResponse(fixture: NativeWikiFixture): string {
  const escape = (value: string) => value.replace(/[\\`*_[\]{}()<>#+.!|~-]/g, "\\$&").replace(/[\r\n]/g, " ")
  const slotPath = (slot: NativeWikiFixture["outputSlots"][number]): string => {
    switch (slot.kind) {
      case "page": return `knowledge/wiki/concepts/${slot.id}.md`
      case "annotation": return `knowledge/wiki/sources/annotations/${slot.id}.md`
      case "index": return "knowledge/wiki/index.md"
      case "ingest": return `knowledge/wiki/reports/fixture-ingest-${slot.id}.md`
      case "report": return `knowledge/wiki/reports/fixture-report-${slot.id}.md`
    }
  }
  const sourceLine = (slot: NativeWikiFixture["outputSlots"][number], fact: NativeWikiFixture["assertions"]["facts"][number]) => {
    const citations = fact.sourceIds.map(sourceId => {
      const source = fixture.sources.find(item => item.id === sourceId)
      if (!source) throw new Error("synthetic fixture fact source is missing")
      const sourcePage = source.provenance === "raw"
        ? `knowledge/wiki/sources/documents-${source.sha256}.md`
        : `knowledge/wiki/concepts/fixture-evidence/${source.id}.md`
      return `[${escape(sourceId)}](${relative(dirname(slotPath(slot)), sourcePage)})`
    })
    return `- ${escape(fact.statement)} (${citations.join(", ")})`
  }
  const factsById = new Map(fixture.assertions.facts.map(item => [item.id, item]))
  return canonicalJson({ schema: NATIVE_WIKI_OUTPUT_SCHEMA, writes: fixture.outputSlots.map(slot => {
    const ownership = fixture.assertions.ownership.find(item => item.slotId === slot.id)
    const action = ownership?.expected === "preserve-existing" ? "preserve"
      : ownership?.expected === "reject-unowned" ? "reject" : "append"
    const facts = action === "append" ? fixture.assertions.facts.filter(fact => fact.slotId === slot.id &&
      !slot.existingContent?.split(/\r?\n/u).includes(sourceLine(slot, fact))).map(fact => ({
      statement: fact.statement, citations: [...fact.sourceIds].sort(),
    })).sort((left, right) => left.statement < right.statement ? -1 : left.statement > right.statement ? 1 : 0) : []
    const contradictions = action === "append" ? fixture.assertions.contradictions.filter(item => {
      const left = factsById.get(item.leftFactId)
      return left?.slotId === slot.id
    }).filter(item => {
      const left = factsById.get(item.leftFactId)
      const right = factsById.get(item.rightFactId)
      if (!left || !right) throw new Error("synthetic fixture contradiction fact is missing")
      const [leftStatement, rightStatement] = [left.statement, right.statement].sort()
      const line = `- ${escape(leftStatement)} ↔ ${escape(rightStatement)} — ${item.expected}.`
      return !slot.existingContent?.split(/\r?\n/u).includes(line)
    }).map(item => {
      const left = factsById.get(item.leftFactId)!
      const right = factsById.get(item.rightFactId)!
      const [leftStatement, rightStatement] = [left.statement, right.statement].sort()
      return { leftStatement, rightStatement, resolution: item.expected }
    }) : []
    return { slotId: slot.id, content: canonicalJson({ schema: NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA, action, facts, contradictions }) }
  }) })
}

function scriptNoGainTransport(fixture: CampaignFixture, exhaustOptimizerResponseBudget = false): void {
  activeCampaignResponse = (prompt, _engine, model) => {
    if (model === modelBindings.generator.requestedModel) {
      if (exhaustOptimizerResponseBudget) {
        const databasePath = join(dirname(executionRunDirectory(fixture.root)), "skillopt", "automation", "ledger.sqlite")
        const database = new Database(databasePath)
        try {
          database.transaction(() => {
            const usage = database.query("UPDATE usage SET artifact_bytes=? WHERE run_id=?")
              .run(NATIVE_SKILLOPT_LIMITS.artifactBytes, fixture.prepared.runId)
            const run = database.query("UPDATE runs SET artifact_bytes=? WHERE run_id=?")
              .run(NATIVE_SKILLOPT_LIMITS.artifactBytes, fixture.prepared.runId)
            if (usage.changes !== 1 || run.changes !== 1) throw new Error("optimizer quota fixture could not saturate the active run")
          })()
        } finally { database.close() }
      }
      return canonicalJson({
        patch: { reasoning: "Add a bounded citation instruction.", edits: [{ op: "append", content: "\nPreserve supported observations with precise citations." }] },
        edits: [{ op: "append", content: "\nPreserve supported observations with precise citations." }], selected_indices: [0],
      })
    }
    if (model === modelBindings.reviewer.requestedModel) {
      return canonicalJson({ schema: "skillopt.semantic-review.v1", assessment: "clear", findings: [] })
    }
    const targetFixture = fixture.dataset.fixturePack.fixtures.find(item => prompt.includes(item.task))
    if (!targetFixture) throw new Error("scripted target prompt did not bind a private fixture")
    if (workerHarness?.candidateSelectionImproves && targetFixture.split === "dev" &&
        prompt.includes("Preserve supported observations with precise citations.")) return idealFixtureResponse(targetFixture)
    return emptyFixtureResponse(targetFixture)
  }
}

type ControllerTrainerEvent = Parameters<NativeSkillOptBroker["controller"]["describeNativeTrainerProtocolEvent"]>[0]
type ControllerTargetResponse = ReturnType<NativeSkillOptBroker["controller"]["admitNativeCampaignTargetResponse"]>
type ControllerReservation = ReturnType<NativeSkillOptBroker["controller"]["reserveRequest"]>
type OptimizerProtocolDescription = Extract<ReturnType<NativeSkillOptBroker["controller"]["describeNativeTrainerProtocolEvent"]>, { kind: "optimizer" }>
type DirectOptimizerProtocolFixture = Readonly<{
  schedule: ReturnType<typeof buildNativeCampaignSchedule>
  worker: OwnedWorkerHandle
  capture: ReturnType<NativeSkillOptBroker["controller"]["openNativeTrainerProtocolCapture"]>
  optimizerEvent: ControllerTrainerEvent
  optimizerDescription: OptimizerProtocolDescription
  reservation: ControllerReservation
  dispatchResult: Awaited<ReturnType<NativeSkillOptBroker["dispatch"]>>
  priorRolloutEvent: ControllerTrainerEvent
  sentMessages: unknown[]
}>

function directTargetPrompt(fixture: NativeWikiFixture, skill: string): string {
  const rendered = renderNativeEvaluationPrompt(fixture, skill)
  return canonicalJson({ system: rendered.system, user: rendered.user })
}

async function awaitTrainerProtocolEvent(worker: OwnedWorkerHandle): Promise<{
  next(): Promise<OwnedTrainerProtocolEvent>
  dispose(): void
}> {
  const queued: OwnedTrainerProtocolEvent[] = []
  let waiter: { resolve(event: OwnedTrainerProtocolEvent): void; reject(error: unknown): void } | undefined
  const detach = worker.onTrainerProtocolEvent(event => {
    if (waiter) {
      const current = waiter
      waiter = undefined
      current.resolve(event)
    } else queued.push(event)
  })
  const done = worker.wait()
  return {
    async next() {
      const event = queued.shift()
      if (event) return event
      return Promise.race([
        new Promise<OwnedTrainerProtocolEvent>((resolveEvent, rejectEvent) => { waiter = { resolve: resolveEvent, reject: rejectEvent } }),
        done.then(result => { throw new Error(`trainer stopped before the next protocol event: ${result.status}`) }),
      ])
    },
    dispose() { detach() },
  }
}

async function dispatchDirectCampaignTarget(input: Readonly<{
  fixture: CampaignFixture
  scheduleEntry: Readonly<{ kind: "training" | "trainerSelection"; caseId: string; replicate: number }>
  prompt: string
  trainerEvent?: ControllerTrainerEvent
  initial?: boolean
}>): Promise<Readonly<{
  reservation: ControllerReservation
  targetResponse: ControllerTargetResponse
  responseText: string
  prompt: string
}>> {
  const { fixture, scheduleEntry, prompt, trainerEvent } = input
  const controller = fixture.broker.controller
  const targetPlan = controller.prepareNativeCampaignTarget({ owner: fixture.owner, runtime: fixture.runtime,
    prepared: fixture.prepared, current: fixture.current, scheduleEntry,
    ...(trainerEvent ? { trainerEvent } : {}) })
  const reservation = input.initial
    ? controller.reserveManual({ owner: fixture.owner, prepared: fixture.prepared, consent: fixture.consent, current: fixture.current })
    : trainerEvent && scheduleEntry.kind === "trainerSelection"
      ? controller.reserveNativeTrainerSelectionTarget({ owner: fixture.owner, runtime: fixture.runtime,
        prepared: fixture.prepared, current: fixture.current, event: trainerEvent })
      : controller.reserveRequest({ owner: fixture.owner, runId: fixture.prepared.runId, current: fixture.current,
        role: "target", phase: scheduleEntry.kind === "trainerSelection" ? "dev" : "train",
        ...(trainerEvent ? { trainerEvent } : {}) })
  const targetBinding = controller.bindNativeCampaignTargetReservation({ owner: fixture.owner, runtime: fixture.runtime,
    prepared: fixture.prepared, current: fixture.current, targetPlan, reservation })
  const result = await fixture.broker.dispatch({ owner: fixture.owner, reservation, getCurrent: () => fixture.current,
    role: "target", phase: scheduleEntry.kind === "trainerSelection" ? "dev" : "train", prompt })
  if (result.status !== "completed" || typeof result.text !== "string" || !result.targetWitness) {
    throw new Error(`direct target dispatch did not complete with a genuine target witness: ${result.status}`)
  }
  const targetResponse = controller.admitNativeCampaignTargetResponse({ owner: fixture.owner, runtime: fixture.runtime,
    prepared: fixture.prepared, current: fixture.current, target: targetBinding, targetWitness: result.targetWitness })
  return Object.freeze({ reservation, targetResponse, responseText: result.text, prompt })
}

async function writeDirectTrainerRollout(input: Readonly<{
  fixture: CampaignFixture
  schedule: ReturnType<typeof buildNativeCampaignSchedule>
  worker: OwnedWorkerHandle
  event: ControllerTrainerEvent
  description: Extract<ReturnType<NativeSkillOptBroker["controller"]["describeNativeTrainerProtocolEvent"]>, { kind: "rollout" }>
  scheduleEntry: Readonly<{ kind: "training" | "trainerSelection"; caseId: string; replicate: number }>
  reservation: ControllerReservation
  targetResponse: ControllerTargetResponse
  sentMessages: unknown[]
  responseText: string
  prompt: string
}>): Promise<void> {
  const { fixture, schedule, worker, event, description, scheduleEntry, reservation, targetResponse,
    responseText, prompt } = input
  const controller = fixture.broker.controller
  const fixtureData = fixture.dataset.fixturePack.fixtures.find(item => item.id === description.caseId)
  if (!fixtureData) throw new Error("direct trainer event refers to a missing fixture")
  const message = {
    schema: "skillopt.rollout-response.v1", runId: description.runId, requestId: description.wireRequestId,
    ok: true, result: { id: fixtureData.id, hard: 0, soft: 0,
      conversation: [{ role: "user", content: prompt }, { role: "assistant", content: responseText }] },
  }
  const serialized = `${canonicalJson(message)}\n`
  const responseSha256 = sha256(Buffer.from(responseText, "utf8"))
  const planSha256 = sha256(canonicalJson({ schema: "skillopt.native-campaign-trainer-rollout-ipc.v1",
    scheduleSha256: schedule.scheduleSha256, scheduleEntry, fixtureId: fixtureData.id,
    wireRequestId: description.wireRequestId, eventOrdinal: description.ordinal, responseSha256,
    serializedBytes: Buffer.byteLength(serialized, "utf8"), messageSha256: sha256(Buffer.from(serialized, "utf8")) }))
  const metadata = Object.freeze({ schema: "skillopt.native-campaign-artifact-stage.v1" as const,
    stage: "trainer-rollout-ipc" as const, runId: fixture.prepared.runId,
    rootBinding: sha256(`root:${realpathSync.native(fixture.runtime.worktree)}`),
    bindingSha256: fixture.prepared.bindingSha256, scheduleSha256: schedule.scheduleSha256,
    fixtureId: fixtureData.id, scheduleEntry, responseSha256, planSha256,
    bytes: Buffer.byteLength(serialized, "utf8") })
  const allowance = controller.reserveNativeCampaignArtifactStage({ owner: fixture.owner, runtime: fixture.runtime,
    prepared: fixture.prepared, current: fixture.current, metadata, trainerEvent: event, reservation, target: targetResponse })
  controller.consumeNativeCampaignArtifactStage(allowance, { owner: fixture.owner, runtime: fixture.runtime,
    prepared: fixture.prepared, current: fixture.current, metadata, trainerEvent: event, reservation, target: targetResponse })
  await worker.writeMessage(message)
  input.sentMessages.push(message)
}

function directCampaignLedgerSnapshot(fixture: CampaignFixture): Readonly<Record<string, unknown>> {
  const databasePath = join(dirname(executionRunDirectory(fixture.root)), "skillopt", "automation", "ledger.sqlite")
  const database = new Database(databasePath, { readonly: true, readwrite: false, create: false })
  try {
    return Object.freeze({
      run: database.query("SELECT state,revision,artifact_bytes FROM runs WHERE run_id=?").get(fixture.prepared.runId),
      usage: database.query("SELECT artifact_bytes FROM usage WHERE run_id=?").get(fixture.prepared.runId),
      clock: database.query("SELECT clock_uncertain FROM quota WHERE singleton=1").get(),
      requests: database.query(`SELECT request_id,reservation_id,role,phase,dispatch_state,actual_dispatch
        FROM requests WHERE run_id=? ORDER BY request_id`).all(fixture.prepared.runId),
      events: database.query("SELECT count(*) AS count FROM trainer_protocol_events WHERE run_id=?").get(fixture.prepared.runId),
      dispatches: database.query("SELECT count(*) AS count FROM trainer_protocol_dispatches WHERE run_id=?").get(fixture.prepared.runId),
    })
  } finally { database.close() }
}

async function reachFirstDirectOptimizerEvent(
  fixture: CampaignFixture,
  trainer: CampaignTrainer,
): Promise<DirectOptimizerProtocolFixture> {
  scriptNoGainTransport(fixture)
  const schedule = buildNativeCampaignSchedule(fixture.dataset.fixturePack)
  const warmup = schedule.training.slice(0, 2)
  const firstWarmup = warmup[0]
  const secondWarmup = warmup[1]
  if (!firstWarmup || !secondWarmup) throw new Error("direct optimizer fixture lacks its two initial warmups")
  const firstEntry = { kind: "training" as const, ...firstWarmup }
  const secondEntry = { kind: "training" as const, ...secondWarmup }
  const firstFixture = fixture.dataset.fixturePack.fixtures.find(item => item.id === firstWarmup.caseId)
  const secondFixture = fixture.dataset.fixturePack.fixtures.find(item => item.id === secondWarmup.caseId)
  if (!firstFixture || !secondFixture) throw new Error("direct optimizer warmup fixture is missing")
  const firstTarget = await dispatchDirectCampaignTarget({ fixture, scheduleEntry: firstEntry,
    prompt: directTargetPrompt(firstFixture, baselineSkill), initial: true })
  const secondTarget = await dispatchDirectCampaignTarget({ fixture, scheduleEntry: secondEntry,
    prompt: directTargetPrompt(secondFixture, baselineSkill) })
  const capture = fixture.broker.controller.openNativeTrainerProtocolCapture({ owner: fixture.owner,
    runtime: fixture.runtime, prepared: fixture.prepared, current: fixture.current,
    trainer: { profile: trainer.profile, receipt: trainer.receipt } })
  const worker = realHost.launchOwnedWorker(trainer.profile, trainer.receipt, "trainer-native")
  const eventQueue = await awaitTrainerProtocolEvent(worker)
  const sentMessages: unknown[] = []
  let priorRolloutEvent: ControllerTrainerEvent | undefined
  const associatedWarmups = new Set<string>()
  let lastObservedEvent: Readonly<{ kind: "rollout" | "optimizer"; ordinal: number }> | undefined
  try {
    for (;;) {
      const rawEvent = await eventQueue.next()
      const event = fixture.broker.controller.consumeNativeTrainerProtocolEvent(capture, { owner: fixture.owner,
        runtime: fixture.runtime, prepared: fixture.prepared, current: fixture.current, event: rawEvent })
      const description = fixture.broker.controller.describeNativeTrainerProtocolEvent(event)
      lastObservedEvent = { kind: description.kind, ordinal: description.ordinal }
      if (description.kind === "optimizer") {
        expect(associatedWarmups).toEqual(new Set([firstWarmup.caseId, secondWarmup.caseId]))
        fixture.broker.controller.reserveCandidateStep(fixture.owner, fixture.prepared.runId)
        const reservation = fixture.broker.controller.reserveRequest({ owner: fixture.owner, runId: fixture.prepared.runId,
          current: fixture.current, role: "optimizer", phase: "train", trainerEvent: event })
        const dispatchResult = await fixture.broker.dispatch({ owner: fixture.owner, reservation, getCurrent: () => fixture.current,
          role: "optimizer", phase: "train", prompt: description.prompt })
        if (dispatchResult.status !== "completed" || typeof dispatchResult.text !== "string" || !dispatchResult.optimizerWitness) {
          throw new Error(`direct optimizer dispatch did not complete with a genuine optimizer witness: ${dispatchResult.status}`)
        }
        if (!priorRolloutEvent) throw new Error("the direct optimizer event had no prior real rollout event")
        eventQueue.dispose()
        return Object.freeze({ schedule, worker, capture, optimizerEvent: event, optimizerDescription: description,
          reservation, dispatchResult, priorRolloutEvent, sentMessages })
      }
      priorRolloutEvent ??= event
      const warmupTarget = description.kind === "rollout" && description.cohort === "training" && description.fragment === ""
        ? description.caseId === firstWarmup.caseId && description.replicate === firstWarmup.replicate
          ? firstTarget
          : description.caseId === secondWarmup.caseId && description.replicate === secondWarmup.replicate ? secondTarget : undefined
        : undefined
      if (warmupTarget) {
        const entry = { kind: "training" as const, caseId: description.caseId, replicate: description.replicate }
        fixture.broker.controller.associateNativeTrainerWarmupTarget({ owner: fixture.owner, runtime: fixture.runtime,
          prepared: fixture.prepared, current: fixture.current, event, target: warmupTarget.targetResponse })
        associatedWarmups.add(description.caseId)
        await writeDirectTrainerRollout({ fixture, schedule, worker, event, description, scheduleEntry: entry,
          reservation: warmupTarget.reservation, targetResponse: warmupTarget.targetResponse,
          responseText: warmupTarget.responseText, prompt: warmupTarget.prompt, sentMessages })
        continue
      }
      const isSelection = description.cohort === "baseline-selection" || description.cohort === "candidate-selection"
      const selectedFixture = fixture.dataset.fixturePack.fixtures.find(item => item.id === description.caseId)
      if (!selectedFixture) throw new Error("direct selection event refers to a missing fixture")
      const entry = { kind: isSelection ? "trainerSelection" as const : "training" as const,
        caseId: description.caseId, replicate: description.replicate }
      const targetSkill = description.cohort === "candidate-selection"
        ? assembleSkill(baselineSkill, description.fragment) : baselineSkill
      const target = await dispatchDirectCampaignTarget({ fixture, scheduleEntry: entry,
        prompt: directTargetPrompt(selectedFixture, targetSkill), trainerEvent: event })
      await writeDirectTrainerRollout({ fixture, schedule, worker, event, description, scheduleEntry: entry,
        reservation: target.reservation, targetResponse: target.targetResponse,
        responseText: target.responseText, prompt: target.prompt, sentMessages })
    }
  } catch (error) {
    eventQueue.dispose()
    const stopped = await worker.cancel()
    if (!stopped.quiescent) throw new Error("direct trainer fixture failed without quiescent cancellation", { cause: error })
    if (fixture.broker.controller.status().state === "RUNNING") {
      fixture.broker.controller.finish(fixture.owner, fixture.prepared.runId, "FAILED")
    }
    const diagnostic = directCampaignLedgerSnapshot(fixture)
    const clock = diagnostic.clock as { clock_uncertain?: unknown } | undefined
    const eventLabel = lastObservedEvent
      ? `${lastObservedEvent.kind} ordinal ${lastObservedEvent.ordinal}` : "no consumed event"
    const expectedOrdinal = (lastObservedEvent?.ordinal ?? 0) + 1
    const clockLabel = clock && Number.isInteger(clock.clock_uncertain) ? String(clock.clock_uncertain) : "unavailable"
    throw new Error(`direct trainer fixture failed after ${eventLabel}; next expected ordinal=${expectedOrdinal}; persisted clock_uncertain=${clockLabel}`, { cause: error })
  }
}

async function stopDirectOptimizerFixture(fixture: CampaignFixture, scenario: DirectOptimizerProtocolFixture): Promise<void> {
  const stopped = await scenario.worker.cancel()
  if (!stopped.quiescent) throw new Error("direct trainer fixture did not cancel quiescently")
  if (fixture.broker.controller.status().state === "RUNNING") {
    fixture.broker.controller.finish(fixture.owner, fixture.prepared.runId, "FAILED")
  }
}

test.skipIf(!canRunContainedWorkers || !nativePlatformSupported)("owned NO_GAIN artifact and actual broker preserve the first two warmup correlations", async () => {
  const otherRuntime = await makeCampaignFixture()
  const fixture = await makeCampaignFixture()
  expect(fixture.dataset.status).toBe("STRUCTURALLY_VALID")
  const schedule = buildNativeCampaignSchedule(fixture.dataset.fixturePack)
  fixture.owner.assertOwner()
  const trainer = await prepareCampaignTrainer(fixture)
  fixture.owner.assertOwner()
  if (!workerHarness) throw new Error("campaign worker harness is missing")
  workerHarness.useRealTrainerProtocol = true
  scriptNoGainTransport(fixture)
  fixture.owner.assertOwner()

  const controller = fixture.broker.controller
  const beforeWrongRuntime = controller.status()
  const fixtureRoot = realpathSync.native(fixture.root)
  const beforeWrongRuntimeOwnerEpoch = admissionEpoch(fixtureRoot, fixture.owner.sessionID)
  const beforeWrongRuntimeAdmissionFence = admissionFence(fixtureRoot, fixture.owner.sessionID)
  expect(getOwnedSession(fixtureRoot, fixture.owner.sessionID)).toBe(fixture.owner)
  expect(beforeWrongRuntimeOwnerEpoch).toBe(fixture.owner.epoch)
  expect(effectiveHold(fixtureRoot, fixture.owner.sessionID)).toBe(false)
  expect(realpathSync.native(fixture.runtime.worktree)).toBe(fixtureRoot)
  expect(getNativeSkillOptBrokerWorktree(fixture.broker)).toBe(fixtureRoot)
  const wrongRuntime = await withCampaignArtifactWriteSpy(controller, () =>
    runNativeSkillOptCampaign({ broker: fixture.broker, owner: fixture.owner, runtime: otherRuntime.runtime,
    getCurrent: () => fixture.current, prepared: fixture.prepared, consent: fixture.consent,
    originalSkill: baselineSkill, trainer }))
  expect(wrongRuntime).toMatchObject({ status: "BLOCKED", reasonCode: "campaign_artifact_stage_denied",
    diagnostic: { stage: "artifact-admission", artifactStage: "fixture-preflight", code: "owner-unavailable" } })
  expect(controller.status().remaining.artifactBytes).toBe(beforeWrongRuntime.remaining.artifactBytes)
  expect(controller.status().requestCounts).toEqual(beforeWrongRuntime.requestCounts)
  expect(controller.status().state).toBe(beforeWrongRuntime.state)
  expect(controller.status().revision).toBe(beforeWrongRuntime.revision)
  fixture.owner.assertOwner()
  expect(getOwnedSession(fixtureRoot, fixture.owner.sessionID)).toBe(fixture.owner)
  expect(admissionEpoch(fixtureRoot, fixture.owner.sessionID)).toBe(beforeWrongRuntimeOwnerEpoch)
  expect(admissionFence(fixtureRoot, fixture.owner.sessionID)).toBe(beforeWrongRuntimeAdmissionFence)
  expect(effectiveHold(fixtureRoot, fixture.owner.sessionID)).toBe(false)
  expect(workerHarness?.fixtureInputBytes).toHaveLength(0)
  expect(campaignFsWrites).toHaveLength(0)

  campaignFsWrites.splice(0)
  campaignSerializedWrites.splice(0)
  campaignFsWriteKeys.clear()
  campaignWriteTimestamps.splice(0)
  const result = await withCampaignArtifactWriteSpy(controller, () =>
    runNativeSkillOptCampaign({ broker: fixture.broker, owner: fixture.owner, runtime: fixture.runtime,
      getCurrent: () => fixture.current, prepared: fixture.prepared, consent: fixture.consent,
      originalSkill: baselineSkill, trainer }))
  fixture.owner.assertOwner()
  expect({ status: result.status, reasonCode: result.reasonCode, diagnostic: result.diagnostic,
    candidateApprovalRequired: result.candidateApprovalRequired })
    .toEqual({ status: "NO_GAIN", reasonCode: "trainer_no_improvement", diagnostic: undefined, candidateApprovalRequired: true })
  expect(result).not.toHaveProperty("candidate")
  expect(result).not.toHaveProperty("metrics")
  expect(result.reviewerEvidence).toEqual([])
  expect(fixture.broker.controller.status().requestCounts.dispatched).toEqual({ target: 120, optimizer: 1, reviewer: 0 })
  expect(fixture.broker.controller.status().state).toBe("NO_GAIN")
  expect(fixture.broker.controller.status().remaining.artifactBytes).toBeLessThan(NATIVE_SKILLOPT_LIMITS.artifactBytes)
  expect(nativeTransportRuns).toHaveLength(121)
  expect(workerHarness!.trainerOptimizerResponses).toHaveLength(1)
  expect(workerHarness!.trainerOptimizerResponses[0]).toMatchObject({ schema: "skillopt.native-optimizer-response.v1",
    runId: fixture.prepared.runId, requestId: `${fixture.prepared.runId}:optimizer:1`, role: "optimizer", phase: "train",
    ok: true, usage: null })
  expect(typeof (workerHarness!.trainerOptimizerResponses[0] as Record<string, unknown>).text).toBe("string")
  expect(Object.keys(workerHarness!.trainerOptimizerResponses[0] as Record<string, unknown>).sort()).toEqual(
    ["ok", "phase", "requestId", "role", "runId", "schema", "text", "usage"].sort())
  expect(workerHarness!.trainerOptimizerResponseBudgets).toHaveLength(1)
  expect(workerHarness!.trainerOptimizerResponseBudgets[0]!.beforeResponse -
    workerHarness!.trainerOptimizerResponseBudgets[0]!.beforeWrite).toBe(workerHarness!.trainerOptimizerResponseBudgets[0]!.serializedBytes)
  const artifactPath = join(trainer.outputDirectory, "skillopt-output", "skillopt-result.json")
  expect(lstatSync(artifactPath).isFile()).toBe(true)

  const firstTraining = schedule.training[0]
  const secondTraining = schedule.training[1]
  if (!firstTraining || !secondTraining) throw new Error("synthetic training schedule is incomplete")
  const firstTrainingFixture = fixture.dataset.fixturePack.fixtures.find(item => item.id === firstTraining.caseId)
  const firstSerializedInput = workerHarness!.fixtureInputBytes[0]
  if (!firstTrainingFixture || !firstSerializedInput) throw new Error("campaign fixture worker input was not captured")
  expect(firstSerializedInput).toEqual(serializeNativeFixtureWorkerInput(firstTrainingFixture))
  const writeTimestamps = [...new Set(campaignWriteTimestamps)]
  expect(writeTimestamps).toHaveLength(1)
  const writeTimestamp = writeTimestamps[0]
  if (!writeTimestamp) throw new Error("campaign fixture write timestamp was not observed")
  const initializationPlan = planNativeFixtureSerializedWrites({ fixture: firstTrainingFixture, pid: process.pid, timestamp: writeTimestamp })
  const initializationBytes = initializationPlan.initializationWrites.reduce((total, write) => total + write.bytes, 0)
  const firstPreflightFixture = fixture.dataset.fixturePack.fixtures[0]
  if (!firstPreflightFixture) throw new Error("campaign fixture pack is empty")
  const preflightPlan = planNativeFixtureSerializedWrites({ fixture: firstPreflightFixture, pid: process.pid, timestamp: writeTimestamp })
  const firstPreflightPayload = campaignSerializedWrites.find(write => write.kind === "fixture-preflight")
  if (!firstPreflightPayload) throw new Error("campaign preflight payload was not intercepted")
  expect(campaignSerializedWrites.filter(write => write.kind === "fixture-preflight" && write.root === firstPreflightPayload.root)
    .map(({ bytes, sha256 }) => ({ bytes, sha256 }))).toEqual(preflightPlan.initializationWrites.map(({ bytes, sha256 }) => ({ bytes, sha256 })))
  const firstAdapterPayload = campaignSerializedWrites.find(write => write.kind === "fixture-adapter")
  if (!firstAdapterPayload) throw new Error("campaign scorer initialization payload was not intercepted")
  expect(campaignSerializedWrites.filter(write => write.kind === "fixture-adapter" && write.root === firstAdapterPayload.root)
    .map(({ bytes, sha256 }) => ({ bytes, sha256 }))).toEqual(initializationPlan.initializationWrites.map(({ bytes, sha256 }) => ({ bytes, sha256 })))
  const expectedTargetStaticBytes = initializationBytes + firstSerializedInput.byteLength +
    realHost.nativeSkillOptFixtureProbeSerializedBytes() + realHost.nativeSkillOptFixtureResultByteBound(firstTrainingFixture.outputSlots) +
    NATIVE_DATASET_LIMITS.nativeResponseBytes + realTransport.nativeObservedUsageCanonicalByteBound()
  const finalPreflightWrite = campaignFsWrites.filter(write => write.kind === "fixture-preflight").at(-1)
  const firstWorkerInputWrite = campaignFsWrites.find(write => write.kind === "worker-input")
  if (!finalPreflightWrite || !firstWorkerInputWrite || !workerHarness) throw new Error("campaign staged fixture writes were not observed")
  expect(finalPreflightWrite.remainingBefore - firstWorkerInputWrite.remainingBefore).toBe(expectedTargetStaticBytes)
  expect(firstWorkerInputWrite.remainingBefore).toBe(workerHarness.targetResponseBudgets[0])
  expect(campaignFsWrites.some(write => write.kind === "fixture-probe")).toBe(true)
  expect(campaignFsWrites.some(write => write.kind === "fixture-adapter")).toBe(true)
  expect(workerHarness.fixtureResultBudgets).toHaveLength(120)
  const maximumFixtureResultBytes = Math.max(...fixture.dataset.fixturePack.fixtures.map(item =>
    realHost.nativeSkillOptFixtureResultByteBound(item.outputSlots)))
  for (const write of workerHarness.fixtureResultBudgets) {
    expect(write.beforeWrite).toBe(write.beforeResponse)
    expect(write.serializedBytes).toBeLessThanOrEqual(maximumFixtureResultBytes)
  }
  expect(workerHarness.trainerRolloutBudgets).toHaveLength(120)
  for (const write of workerHarness.trainerRolloutBudgets) {
    expect(write.beforeResponse - write.beforeWrite).toBeGreaterThanOrEqual(write.serializedBytes)
  }
  expect(result.warmupCorrelations).toHaveLength(2)
  expect(result.warmupCorrelations).toMatchObject([
    { scheduleSha256: schedule.scheduleSha256, wireRequestId: `${fixture.prepared.runId}:49`,
      split: "train", caseId: firstTraining.caseId, replicate: firstTraining.replicate, fragmentSha256: sha256("") },
    { scheduleSha256: schedule.scheduleSha256, wireRequestId: `${fixture.prepared.runId}:50`,
      split: "train", caseId: secondTraining.caseId, replicate: secondTraining.replicate, fragmentSha256: sha256("") },
  ])
  const correlatedNativeIds = result.warmupCorrelations?.map(item => item.nativeRequestId) ?? []
  expect(new Set(correlatedNativeIds).size).toBe(2)
  for (const requestId of correlatedNativeIds) {
    expect(result.usageObservations?.some(item => item.role === "target" && item.requestId === requestId)).toBe(true)
  }

  const nextPrepared = controller.prepare({ owner: fixture.owner, campaignId: `campaign_${randomUUID().replaceAll("-", "")}`,
    dataset: fixture.dataset, baselineSkillSha256: fixture.current.baselineSkillSha256 })
  if (nextPrepared.state !== "PREPARED") throw new Error("daily cooldown fixture was not prepared")
  const nextReceipt = await withTerminalLine(`APPROVE ${nextPrepared.runId} ${nextPrepared.consentBindingSha256}`,
    () => humanDecision("approve", nextPrepared.decisionBinding))
  const nextConsent = controller.consent(nextPrepared, nextReceipt, fixture.current)
  const databasePath = join(dirname(executionRunDirectory(fixture.root)), "skillopt", "automation", "ledger.sqlite")
  const beforeArmDatabase = new Database(databasePath)
  try {
    const priorQuota = beforeArmDatabase.query(`SELECT last_attempt_id,last_attempt_boot,last_attempt_cont,clock_boot,fence_boot,fence_cont
      FROM quota WHERE singleton=1`).get() as {
        last_attempt_id: string | null; last_attempt_boot: string | null; last_attempt_cont: string | null
        clock_boot: string | null; fence_boot: string | null; fence_cont: string | null
      } | undefined
    if (!priorQuota?.last_attempt_id || !priorQuota.last_attempt_boot || !priorQuota.last_attempt_cont || !priorQuota.clock_boot) {
      throw new Error("real prior campaign attempt is missing from the quota ledger")
    }
    if (!beforeArmDatabase.query("SELECT 1 FROM attempts WHERE reservation_id=?").get(priorQuota.last_attempt_id)) {
      throw new Error("prior quota attempt does not resolve to an actual reservation")
    }
    if (priorQuota.fence_boot === priorQuota.clock_boot || priorQuota.fence_cont !== null) {
      throw new Error("cross-boot fixture unexpectedly already has a current-boot cooldown fence")
    }
    // Simulate that actual prior reservation as belonging to a previous boot; the current arm is minted afterwards.
    const oldBoot = randomUUID()
    beforeArmDatabase.query("UPDATE quota SET last_attempt_boot=? WHERE singleton=1").run(oldBoot)
  } finally { beforeArmDatabase.close() }
  const nextArm = controller.arm(nextPrepared, nextConsent, fixture.current)
  addAutomaticCampaignDigests(fixture.root, 5)
  const foreignOwner = attachAdmission(fixture.runtime, `session_${randomUUID().replaceAll("-", "")}`,
    { engine: modelBindings.generator.engine, model: modelBindings.generator.requestedModel })
  try {
    expect(controller.automaticReadiness({ owner: foreignOwner, prepared: nextPrepared, consent: nextConsent,
      arm: nextArm, current: fixture.current })).toMatchObject({ state: "BLOCKED", reasonCode: "arm-required" })
  } finally {
    if (!foreignOwner.isReleased) foreignOwner.release({ workflowQuiescent: true,
      evidence: "automatic readiness foreign-owner fixture settled", workflowID: null, revision: null })
  }
  const readinessSnapshot = () => {
    const database = new Database(databasePath, { readonly: true, readwrite: false, create: false })
    try {
      return Object.freeze({
        quota: database.query(`SELECT revision,last_attempt_id,last_attempt_boot,last_attempt_cont,clock_boot,fence_boot,fence_cont
          FROM quota WHERE singleton=1`).get(),
        run: database.query(`SELECT run_id,state,revision,artifact_bytes,expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?`)
          .get(nextPrepared.runId),
        arm: database.query("SELECT * FROM arms WHERE run_id=?").get(nextPrepared.runId),
        usage: database.query("SELECT * FROM usage WHERE run_id=?").get(nextPrepared.runId),
        attempts: database.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(nextPrepared.runId),
        requests: database.query("SELECT count(*) AS count FROM requests WHERE run_id=?").get(nextPrepared.runId),
        qualification: database.query("SELECT 1 FROM campaign_qualifications WHERE run_id=?").get(nextPrepared.runId),
      })
    } finally { database.close() }
  }
  const nextTrainer = await prepareCampaignTrainer(fixture, nextPrepared)
  const beforeReadiness = readinessSnapshot()
  expect((beforeReadiness.arm as { armed_boot: string }).armed_boot).toBe((beforeReadiness.quota as { clock_boot: string }).clock_boot)
  const readiness = controller.automaticReadiness({ owner: fixture.owner, prepared: nextPrepared, consent: nextConsent,
    arm: nextArm, current: fixture.current })
  expect(readiness).toMatchObject({ state: "READY", newDigestCount: 5, requiredNewDigests: 5,
    finalReservationRequired: true })
  expect(typeof readiness.dailyCooldownRemainingMilliseconds).toBe("number")
  expect(readiness.dailyCooldownRemainingMilliseconds).toBeGreaterThan(0)
  expect(readinessSnapshot()).toEqual(beforeReadiness)
  const transportCountBeforeFinalCheck = nativeTransportRuns.length
  campaignFsWrites.splice(0)
  campaignSerializedWrites.splice(0)
  campaignFsWriteKeys.clear()
  campaignWriteTimestamps.splice(0)
  const finalCheck = await withCampaignArtifactWriteSpy(controller, () =>
    runNativeSkillOptCampaign({ broker: fixture.broker, owner: fixture.owner, runtime: fixture.runtime,
      getCurrent: () => fixture.current, prepared: nextPrepared, consent: nextConsent, arm: nextArm,
      originalSkill: baselineSkill, trainer: nextTrainer }))
  expect(finalCheck).toMatchObject({ status: "BLOCKED", reasonCode: "daily-limit", candidateApprovalRequired: true })
  expect(nativeTransportRuns).toHaveLength(transportCountBeforeFinalCheck)
  expect(workerHarness?.trainerCancelCount).toBe(0)

  const fixtureTimestamp = campaignWriteTimestamps[0]
  if (!fixtureTimestamp || campaignWriteTimestamps.some(timestamp => timestamp !== fixtureTimestamp)) {
    throw new Error("cooldown-refusal fixture writes did not share one captured timestamp")
  }
  const preflightPlans = fixture.dataset.fixturePack.fixtures.map(item =>
    planNativeFixtureSerializedWrites({ fixture: item, pid: process.pid, timestamp: fixtureTimestamp }))
  const expectedPreflightBytes = preflightPlans.reduce((total, plan) =>
    total + plan.initializationWrites.reduce((sum, write) => sum + write.bytes, 0), 0)
  const cooldownFirstTraining = schedule.training[0]
  const cooldownFirstTrainingFixture = cooldownFirstTraining
    ? fixture.dataset.fixturePack.fixtures.find(item => item.id === cooldownFirstTraining.caseId) : undefined
  const firstWorkerInput = workerHarness?.fixtureInputBytes[0]
  if (!cooldownFirstTrainingFixture || !firstWorkerInput) throw new Error("cooldown-refusal target static plan was not observed")
  expect(firstWorkerInput).toEqual(serializeNativeFixtureWorkerInput(cooldownFirstTrainingFixture))
  const targetInitializationBytes = planNativeFixtureSerializedWrites({ fixture: cooldownFirstTrainingFixture,
    pid: process.pid, timestamp: fixtureTimestamp }).initializationWrites.reduce((sum, write) => sum + write.bytes, 0)
  const expectedCooldownTargetStaticBytes = targetInitializationBytes + firstWorkerInput.byteLength +
    realHost.nativeSkillOptFixtureProbeSerializedBytes() + realHost.nativeSkillOptFixtureResultByteBound(cooldownFirstTrainingFixture.outputSlots) +
    NATIVE_DATASET_LIMITS.nativeResponseBytes + realTransport.nativeObservedUsageCanonicalByteBound()
  const expectedArtifactCharge = expectedPreflightBytes + expectedCooldownTargetStaticBytes
  const expectedStageCount = preflightPlans.length + 1
  const afterFence = readinessSnapshot()
  const beforeRun = beforeReadiness.run as { revision: number; artifact_bytes: number; state: string;
    expires_boot: string; expires_cont: string; expires_wall: string }
  const afterRun = afterFence.run as typeof beforeRun
  expect(afterRun).toEqual({ ...beforeRun, revision: beforeRun.revision + expectedStageCount,
    artifact_bytes: beforeRun.artifact_bytes + expectedArtifactCharge })
  expect((afterFence.usage as { artifact_bytes: number }).artifact_bytes -
    (beforeReadiness.usage as { artifact_bytes: number }).artifact_bytes).toBe(expectedArtifactCharge)
  const withoutArtifactBytes = (value: unknown) => Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "artifact_bytes"))
  expect(withoutArtifactBytes(afterFence.usage)).toEqual(withoutArtifactBytes(beforeReadiness.usage))
  const beforeQuota = beforeReadiness.quota as { revision: number; last_attempt_id: string; last_attempt_boot: string;
    last_attempt_cont: string; clock_boot: string; fence_boot: string; fence_cont: string }
  const afterQuota = afterFence.quota as typeof beforeQuota
  expect(afterQuota.revision).toBe(beforeQuota.revision + expectedStageCount + 1)
  expect(afterQuota.last_attempt_id).toBe(beforeQuota.last_attempt_id)
  expect(afterQuota.last_attempt_boot).toBe(beforeQuota.last_attempt_boot)
  expect(afterQuota.last_attempt_cont).toBe(beforeQuota.last_attempt_cont)
  expect(afterQuota.clock_boot).toBe(beforeQuota.clock_boot)
  expect(afterFence.quota).toMatchObject({ fence_boot: (beforeReadiness.quota as { clock_boot: string }).clock_boot })
  expect((afterFence.quota as { fence_cont: string }).fence_cont).toMatch(/^\d+$/u)
  expect(afterFence.arm).toEqual(beforeReadiness.arm)
  expect(afterFence.attempts).toEqual({ count: 0 })
  expect(afterFence.requests).toEqual({ count: 0 })
  expect(afterFence.qualification).toBeNull()
  const afterFenceReadiness = controller.automaticReadiness({ owner: fixture.owner, prepared: nextPrepared,
    consent: nextConsent, arm: nextArm, current: fixture.current })
  expect(afterFenceReadiness).toMatchObject({ state: "BLOCKED", reasonCode: "daily-limit", newDigestCount: 5,
    requiredNewDigests: 5 })
  expect(afterFenceReadiness).not.toHaveProperty("finalReservationRequired")
  expect(typeof afterFenceReadiness.dailyCooldownRemainingMilliseconds).toBe("number")
  expect(afterFenceReadiness.dailyCooldownRemainingMilliseconds).toBeGreaterThan(0)
  expect(readinessSnapshot()).toEqual(afterFence)
  const finalStatus = controller.status()
  expect(finalStatus).toMatchObject({ state: "ARMED", runId: nextPrepared.runId,
    requestCounts: { charged: { target: 0, optimizer: 0, reviewer: 0 },
      dispatched: { target: 0, optimizer: 0, reviewer: 0 }, unknown: { target: 0, optimizer: 0, reviewer: 0 } } })
  expect(typeof finalStatus.dailyCooldownRemainingMilliseconds).toBe("number")
})

test.skipIf(!canRunContainedWorkers || !nativePlatformSupported)("optimizer response IPC is withheld when its exact debit exceeds the remaining artifact quota", async () => {
  const fixture = await makeCampaignFixture()
  const schedule = buildNativeCampaignSchedule(fixture.dataset.fixturePack)
  const trainer = await prepareCampaignTrainer(fixture)
  if (!workerHarness) throw new Error("campaign worker harness is missing")
  workerHarness.useRealTrainerProtocol = true
  scriptNoGainTransport(fixture, true)
  const result = await runNativeSkillOptCampaign({ broker: fixture.broker, owner: fixture.owner, runtime: fixture.runtime,
    getCurrent: () => fixture.current, prepared: fixture.prepared, consent: fixture.consent,
    originalSkill: baselineSkill, trainer })
  expect(result).toMatchObject({ status: "FAILED", reasonCode: "budget-exhausted" })
  // Two initial warmups plus 48 baseline-selection and 24 training events; the two training warmups reuse their dispatched targets.
  const targetDispatchesBeforeFirstOptimizer = 2 + schedule.trainerSelection.length + schedule.training.length - 2
  expect(workerHarness.trainerRolloutBudgets).toHaveLength(schedule.trainerSelection.length + schedule.training.length)
  expect(fixture.broker.controller.status()).toMatchObject({ state: "FAILED", pendingDispatch: false,
    requestCounts: { dispatched: { target: targetDispatchesBeforeFirstOptimizer, optimizer: 1, reviewer: 0 } }, remaining: { artifactBytes: 0 } })
  expect(workerHarness.trainerOptimizerResponses).toHaveLength(0)
  expect(workerHarness.trainerOptimizerResponseBudgets).toHaveLength(0)
  expect(workerHarness.optimizerResponseBudgetSnapshots).toHaveLength(1)
})

test.skipIf(!canRunContainedWorkers || !nativePlatformSupported)("direct real protocol optimizer allowances bind owner, event, reservation, and one-use consumption", async () => {
  const fixture = await makeCampaignFixture()
  const trainer = await prepareCampaignTrainer(fixture)
  const scenario = await reachFirstDirectOptimizerEvent(fixture, trainer)
  let foreignOwner: ReturnType<typeof attachAdmission> | undefined
  try {
    const witness = scenario.dispatchResult.optimizerWitness
    if (!witness || scenario.dispatchResult.status !== "completed" || typeof scenario.dispatchResult.text !== "string") {
      throw new Error("direct optimizer fixture lost its genuine completion witness")
    }
    const controller = fixture.broker.controller
    const responseText = scenario.dispatchResult.text
    const validInput = { owner: fixture.owner, runtime: fixture.runtime, prepared: fixture.prepared,
      current: fixture.current, event: scenario.optimizerEvent, reservation: scenario.reservation,
      optimizerWitness: witness, responseText }
    const testOwner = attachAdmission(fixture.runtime, `session_${randomUUID().replaceAll("-", "")}`,
      { engine: modelBindings.generator.engine, model: modelBindings.generator.requestedModel })
    foreignOwner = testOwner
    const unchanged = (attempt: () => unknown, code: string) => {
      const before = directCampaignLedgerSnapshot(fixture)
      expect(attempt).toThrow(code)
      expect(directCampaignLedgerSnapshot(fixture)).toEqual(before)
    }
    unchanged(() => controller.reserveNativeTrainerOptimizerResponse({ ...validInput, owner: testOwner }),
      "dispatch-not-authorized")
    unchanged(() => controller.reserveNativeTrainerOptimizerResponse({ ...validInput,
      event: scenario.priorRolloutEvent }), "dispatch-not-authorized")
    unchanged(() => controller.reserveNativeTrainerOptimizerResponse({ ...validInput,
      reservation: Object.freeze({ ...scenario.reservation }) as typeof scenario.reservation }), "dispatch-not-authorized")
    expect(scenario.sentMessages.filter(value => (value as { schema?: unknown }).schema ===
      "skillopt.native-optimizer-response.v1")).toHaveLength(0)

    const bytesBefore = controller.status().remaining.artifactBytes
    const allowance = controller.reserveNativeTrainerOptimizerResponse(validInput)
    const message = controller.consumeNativeTrainerOptimizerResponse(allowance, {
      owner: fixture.owner, runtime: fixture.runtime, prepared: fixture.prepared, current: fixture.current,
      event: scenario.optimizerEvent, reservation: scenario.reservation,
    })
    expect(Object.isFrozen(message)).toBe(true)
    const serializedBytes = Buffer.byteLength(`${JSON.stringify(message)}\n`, "utf8")
    expect(bytesBefore - controller.status().remaining.artifactBytes).toBe(serializedBytes)
    const afterConsumption = directCampaignLedgerSnapshot(fixture)
    expect(() => controller.reserveNativeTrainerOptimizerResponse(validInput)).toThrow("dispatch-not-authorized")
    expect(directCampaignLedgerSnapshot(fixture)).toEqual(afterConsumption)
    expect(() => controller.consumeNativeTrainerOptimizerResponse(allowance, {
      owner: fixture.owner, runtime: fixture.runtime, prepared: fixture.prepared, current: fixture.current,
      event: scenario.optimizerEvent, reservation: scenario.reservation,
    })).toThrow("binding-invalid")
    expect(directCampaignLedgerSnapshot(fixture)).toEqual(afterConsumption)
    await scenario.worker.writeMessage(message)
    scenario.sentMessages.push(message)
    expect(scenario.sentMessages.filter(value => (value as { schema?: unknown }).schema ===
      "skillopt.native-optimizer-response.v1")).toHaveLength(1)
    expect(scenario.sentMessages).toHaveLength(73)
    expect(controller.status().requestCounts.dispatched).toEqual({ target: 72, optimizer: 1, reviewer: 0 })
  } finally {
    if (foreignOwner && !foreignOwner.isReleased) foreignOwner.release({ workflowQuiescent: true,
      evidence: "direct optimizer wrong-owner probe settled", workflowID: null, revision: null })
    await stopDirectOptimizerFixture(fixture, scenario)
  }
})

test.skipIf(!canRunContainedWorkers || !nativePlatformSupported)("direct real protocol response mismatch consumes no artifact debit and writes no optimizer IPC", async () => {
  const fixture = await makeCampaignFixture()
  const trainer = await prepareCampaignTrainer(fixture)
  const scenario = await reachFirstDirectOptimizerEvent(fixture, trainer)
  try {
    const witness = scenario.dispatchResult.optimizerWitness
    if (!witness || scenario.dispatchResult.status !== "completed" || typeof scenario.dispatchResult.text !== "string") {
      throw new Error("direct optimizer fixture lost its genuine completion witness")
    }
    const controller = fixture.broker.controller
    const before = directCampaignLedgerSnapshot(fixture)
    expect(() => controller.reserveNativeTrainerOptimizerResponse({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, event: scenario.optimizerEvent,
      reservation: scenario.reservation, optimizerWitness: witness,
      responseText: `${scenario.dispatchResult.text} mismatched` })).toThrow("dispatch-not-authorized")
    expect(directCampaignLedgerSnapshot(fixture)).toEqual(before)
    expect(scenario.sentMessages.filter(value => (value as { schema?: unknown }).schema ===
      "skillopt.native-optimizer-response.v1")).toHaveLength(0)
    expect(fixture.broker.controller.status().requestCounts.dispatched).toEqual({ target: 72, optimizer: 1, reviewer: 0 })
  } finally { await stopDirectOptimizerFixture(fixture, scenario) }
})

test.skipIf(!canRunContainedWorkers || !nativePlatformSupported)("direct real target witness cannot authorize optimizer response IPC", async () => {
  const fixture = await makeCampaignFixture()
  const trainer = await prepareCampaignTrainer(fixture)
  const scenario = await reachFirstDirectOptimizerEvent(fixture, trainer)
  try {
    const optimizerWitness = scenario.dispatchResult.optimizerWitness
    if (!optimizerWitness || scenario.dispatchResult.status !== "completed" || typeof scenario.dispatchResult.text !== "string") {
      throw new Error("direct optimizer fixture lost its genuine completion witness")
    }
    const targetFixture = fixture.dataset.fixturePack.fixtures[0]
    if (!targetFixture) throw new Error("cross-role target fixture is missing")
    const targetReservation = fixture.broker.controller.reserveRequest({ owner: fixture.owner,
      runId: fixture.prepared.runId, current: fixture.current, role: "target", phase: "train" })
    const targetResult = await fixture.broker.dispatch({ owner: fixture.owner, reservation: targetReservation,
      getCurrent: () => fixture.current, role: "target", phase: "train", prompt: directTargetPrompt(targetFixture, baselineSkill) })
    if (targetResult.status !== "completed" || !targetResult.targetWitness) {
      throw new Error("cross-role fixture did not mint a genuine target witness")
    }
    const before = directCampaignLedgerSnapshot(fixture)
    const reserveOptimizerResponse = fixture.broker.controller.reserveNativeTrainerOptimizerResponse
    expect(() => Reflect.apply(reserveOptimizerResponse, fixture.broker.controller, [{ owner: fixture.owner,
      runtime: fixture.runtime, prepared: fixture.prepared, current: fixture.current,
      event: scenario.optimizerEvent, reservation: scenario.reservation,
      optimizerWitness: targetResult.targetWitness, responseText: scenario.dispatchResult.text }]))
      .toThrow("dispatch-not-authorized")
    expect(directCampaignLedgerSnapshot(fixture)).toEqual(before)
    expect(scenario.sentMessages.filter(value => (value as { schema?: unknown }).schema ===
      "skillopt.native-optimizer-response.v1")).toHaveLength(0)
    expect(fixture.broker.controller.status().requestCounts.dispatched).toEqual({ target: 73, optimizer: 1, reviewer: 0 })
  } finally { await stopDirectOptimizerFixture(fixture, scenario) }
})

test.skipIf(!canRunContainedWorkers || !nativePlatformSupported)("scripted candidate safety failures never create campaign qualification authority", async () => {
  const fixture = await makeCampaignFixture()
  const trainer = await prepareCampaignTrainer(fixture)
  const harness = workerHarness
  if (!harness) throw new Error("synthetic campaign worker harness is missing")
  harness.candidateSelectionImproves = true
  harness.useRealTrainerProtocol = true
  scriptNoGainTransport(fixture)
  const result = await runNativeSkillOptCampaign({ broker: fixture.broker, owner: fixture.owner, runtime: fixture.runtime,
    getCurrent: () => fixture.current, prepared: fixture.prepared, consent: fixture.consent,
    originalSkill: baselineSkill, trainer })
  expect({ status: result.status, reasonCode: result.reasonCode, diagnostic: result.diagnostic,
    candidateApprovalRequired: result.candidateApprovalRequired, metricsStatus: result.metrics?.status })
    .toEqual({ status: "REJECTED", reasonCode: undefined, diagnostic: undefined, candidateApprovalRequired: true, metricsStatus: "REJECTED" })
  expect(result.reviewerEvidence?.map(({ phase, status, assessment, findings }) => ({ phase, status, assessment, findings })))
    .toEqual([
      { phase: "final", status: "valid", assessment: "clear", findings: [] },
      { phase: "safety", status: "valid", assessment: "clear", findings: [] },
    ])
  expect(fixture.broker.controller.status().requestCounts.dispatched).toEqual({ target: 432, optimizer: 1, reviewer: 2 })
  expect(nativeTransportRuns).toHaveLength(435)
  const ledgerPath = join(dirname(executionRunDirectory(fixture.root)), "skillopt", "automation", "ledger.sqlite")
  const database = new Database(ledgerPath, { readonly: true, readwrite: false, create: false })
  try {
    expect(database.query("SELECT 1 FROM campaign_qualifications WHERE run_id=?").get(fixture.prepared.runId)).toBeNull()
  } finally { database.close() }
  expect(result.status).not.toBe("AWAITING_CANDIDATE_APPROVAL")
})

test.skipIf(!canRunContainedWorkers || !nativePlatformSupported)("fixture worker abort races require quiescence with the actual broker and controller", async () => {
  for (const { quiescent, trainerCancellationThrows } of [
    { quiescent: true, trainerCancellationThrows: false },
    { quiescent: false, trainerCancellationThrows: false },
    { quiescent: true, trainerCancellationThrows: true },
  ]) {
    const fixture = await makeCampaignFixture()
    const trainer = await prepareCampaignTrainer(fixture)
    scriptNoGainTransport(fixture)
    const abort = new AbortController()
    const state = workerHarness
    if (!state) throw new Error("synthetic worker harness was not initialized")
    state.abortOnFixtureWrite = abort
    state.fixtureCancellationQuiescent = quiescent
    state.fixtureExitOnAbort = quiescent
    state.trainerCancellationThrows = trainerCancellationThrows
    const transportCountBeforeIteration = nativeTransportRuns.length
    const result = await runNativeSkillOptCampaign({ broker: fixture.broker, owner: fixture.owner, runtime: fixture.runtime,
      getCurrent: () => fixture.current, prepared: fixture.prepared, consent: fixture.consent,
      originalSkill: baselineSkill, trainer, signal: abort.signal })
    const scratchRoot = state.fixtureRoots[0]
    if (!scratchRoot) throw new Error("synthetic fixture worker scratch root was not recorded")
    expect(state.fixtureCancelCount).toBe(1)
    expect(state.trainerCancelCount).toBe(1)
    if (trainerCancellationThrows) {
      expect(result).toMatchObject({ status: "UNRESOLVED", reasonCode: "trainer_worker_unresolved" })
      expect(fixture.broker.controller.status().state).not.toBe("CANCELLED")
    } else if (quiescent) {
      expect(result).toMatchObject({ status: "CANCELLED", reasonCode: "cancelled" })
      expect(existsSync(scratchRoot)).toBe(false)
      expect(fixture.broker.controller.status().state).toBe("CANCELLED")
    } else {
      expect(result).toMatchObject({ status: "UNRESOLVED", reasonCode: "fixture_worker_unresolved" })
      expect(existsSync(scratchRoot)).toBe(true)
      expect(fixture.broker.controller.status().state).not.toBe("CANCELLED")
    }
    expect(fixture.broker.controller.status().requestCounts.dispatched).toEqual({ target: 1, optimizer: 0, reviewer: 0 })
    expect(nativeTransportRuns.length - transportCountBeforeIteration).toBe(1)
  }
})

test("trainer IPC rejects malformed frames, and qualification reports NO_GAIN without approval", () => {
  const fixturePack = pack()
  const wire = createNativeTrainerWire({
    fixturePack, runId: randomUUID(), originalSkill: baselineSkill, sourceLockSha256: "a".repeat(64),
  })
  expect(() => wire.accept({ schema: "skillopt.rollout-request.v1" })).toThrow("trainer_protocol_invalid")
  expect(wire.snapshot().stopped).toBe(true)

  const trials: NativeEvaluationTrial[] = fixturePack.fixtures
    .filter(fixture => fixture.split !== "train")
    .flatMap(fixture => (["baseline", "candidate"] as const).flatMap(variant => [0, 1, 2].map(repeat => ({
      fixtureId: fixture.id,
      variant,
      repeat,
      status: "valid" as const,
      hardPass: variant === "candidate" && fixture.split === "safety",
      latencyMs: 100,
      outputSha256: sha256(`${fixture.id}:${variant}:${repeat}`),
    }))))
  const metrics = measureNativeQualification({
    fixturePack,
    baselineSha256: "b".repeat(64),
    candidateSha256: "c".repeat(64),
    trials,
  })
  expect(metrics).toMatchObject({ status: "NO_GAIN", reasons: ["minimum_gain_not_met"] })
})
