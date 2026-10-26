import { createHash, randomBytes } from "node:crypto"
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync,
  readlinkSync, realpathSync, rmSync, statfsSync, writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { createServer } from "node:net"
import { once } from "node:events"
import { constants as osConstants, homedir, tmpdir } from "node:os"
import {
  consumeNativeTrainerProtocolStageAllowance, nativeTrainerProtocolStageAllowanceMetadata,
  type SkillOptNativeTrainerMaterializationMetadata, type SkillOptNativeTrainerProtocolStageAllowance,
} from "./controller.ts"
import {
  NATIVE_DATASET_LIMITS, NATIVE_TRAINER_PROJECTION_SCHEMA, NATIVE_WIKI_OUTPUT_KINDS,
} from "./dataset.ts"
import { canonicalJson, sha256, SkillOptError } from "./pilot.ts"

export const SUPPORTED_HOST_VERSION = "1.18.33"
export const OBSERVED_OLLAMA_VERSION = "0.34.3"
export const RUNNER_ROUTE_EVIDENCE = Object.freeze([
  "https://github.com/ollama/ollama/blob/v0.34.3/llm/llama_server.go#L360-L505",
  "https://github.com/ollama/ollama/blob/v0.34.3/server/sched.go",
  "https://github.com/ollama/ollama/blob/v0.34.3/envconfig/config.go",
])

export type ExecutableIdentity = {
  launcherSha256: string
  observedVersion: string
  basis: "resolved-launcher-file-and-version-command"
}

export type CapabilityReceipt = {
  schema: "skillopt.capability.v1"
  status: "blocked"
  code: "isolation_unavailable" | "runtime_version_mismatch" | "sandbox_unavailable"
  host: ExecutableIdentity
  modelService: ExecutableIdentity
  sandboxPrimitive: "passed" | "failed"
  actualRoleContainment: "unverified"
  liveSkillWitness: "unverified"
  originalLoadedByteAttestation: false
  backendRequests: 0
  experimentAdmitted: false
  productionApplied: false
  reason: string
  evidence: readonly string[]
}

/** Hash the executable/launcher we actually invoke, without claiming its transitive binary identity. */
function executableDigest(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size < 1 || before.size > 512 * 1024 * 1024) throw new SkillOptError("invalid_executable")
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(65536)
    let position = 0
    for (;;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size + 1 - position), position)
      if (!count) break
      position += count
      if (position > before.size) throw new SkillOptError("executable_changed")
      hash.update(buffer.subarray(0, count))
    }
    const after = fstatSync(fd)
    if (position !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new SkillOptError("executable_changed")
    return hash.digest("hex")
  } finally {
    closeSync(fd)
  }
}

function inspectExecutable(name: "opencode" | "ollama"): ExecutableIdentity {
  const located = Bun.which(name)
  if (!located) throw new SkillOptError("runtime_missing")
  const path = realpathSync.native(located)
  const before = executableDigest(path)
  const home = mkdtempSync(join(tmpdir(), "skillopt-version-"))
  try {
    const result = spawnSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 8192,
      env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), PATH: `${dirname(path)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`, OLLAMA_HOST: "127.0.0.1:11434", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (result.error || result.status !== 0 || result.signal || result.stderr.trim()) throw new SkillOptError("runtime_version_unverified")
    const text = result.stdout.trim()
    const match = name === "opencode" ? /^(\d+\.\d+\.\d+)$/.exec(text) : /^ollama version is (\d+\.\d+\.\d+)$/.exec(text)
    if (!match || executableDigest(path) !== before) throw new SkillOptError("runtime_version_unverified")
    return { launcherSha256: before, observedVersion: match[1]!, basis: "resolved-launcher-file-and-version-command" }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** A launcher smoke test only; this deliberately does not certify the real role profiles. */
function sandboxPrimitive(): boolean {
  if (process.platform !== "darwin" || process.arch !== "arm64") return false
  const result = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(deny default)(allow process-exec)(allow file-read*)", "/usr/bin/true"], {
    timeout: 5000,
    maxBuffer: 8192,
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  return !result.error && result.status === 0 && !result.signal
}

export function classifyCapability(host: ExecutableIdentity, modelService: ExecutableIdentity, primitivePassed: boolean): CapabilityReceipt {
  const common = {
    schema: "skillopt.capability.v1" as const,
    status: "blocked" as const,
    host,
    modelService,
    sandboxPrimitive: primitivePassed ? "passed" as const : "failed" as const,
    actualRoleContainment: "unverified" as const,
    liveSkillWitness: "unverified" as const,
    originalLoadedByteAttestation: false as const,
    backendRequests: 0 as const,
    experimentAdmitted: false as const,
    productionApplied: false as const,
  }
  if (!primitivePassed) return { ...common, code: "sandbox_unavailable", reason: "The required launcher primitive is unavailable; no alternative launcher is admitted.", evidence: [] }
  if (host.observedVersion !== SUPPORTED_HOST_VERSION || modelService.observedVersion !== OBSERVED_OLLAMA_VERSION) {
    return { ...common, code: "runtime_version_mismatch", reason: "The installed runtime differs from the reviewed version; no upgrade or inferred compatibility is admitted.", evidence: [] }
  }
  return {
    ...common,
    code: "isolation_unavailable",
    reason: "Ollama 0.34.3 selects and releases an ephemeral internal runner port before spawning its child. No supported fixed/reserved runner route was verified. A fixed outer OLLAMA_HOST does not satisfy the approved internal-route boundary; broad loopback, a host patch and a different renderer are not admitted alternatives.",
    evidence: RUNNER_ROUTE_EVIDENCE,
  }
}

/** No model invocation, service start, shared-service takeover, source change or admission occurs here. */
export function inspectPilotCapability(): CapabilityReceipt {
  return classifyCapability(inspectExecutable("opencode"), inspectExecutable("ollama"), sandboxPrimitive())
}

const WORKER_SCHEMA = "skillopt.worker-profile.v1" as const
const WORKER_BINDING_SCHEMA = "skillopt.worker-binding.v1" as const
const WORKER_RECEIPT_SCHEMA = "skillopt.worker-containment.v1" as const
const PINNED_SKILLOPT_COMMIT = "fa4ca184573e42ec11472959dd57422381418096"
const MAX_WORKER_INPUT_BYTES = 8 * 1024 * 1024
const MAX_ADAPTER_MANIFEST_BYTES = 64 * 1024
const MAX_NATIVE_RUNTIME_PROOF_BYTES = 256 * 1024
const MAX_WORKER_MESSAGE_BYTES = 512 * 1024
const MAX_WORKER_STDOUT_BYTES = 32 * 1024 * 1024
const MAX_WORKER_STDERR_BYTES = 32 * 1024
const WORKER_PROBE_SENTINEL_TARGETS = ["home", "worktree", "production"] as const
const WORKER_PROBE_SENTINEL_COUNT = WORKER_PROBE_SENTINEL_TARGETS.length
const WORKER_PROBE_SENTINEL_BYTES = 24
const WORKER_PROBE_OUTPUT_MARKER = "skillopt-output-probe"
const WORKER_PROBE_OUTPUT_MARKER_BYTES = Buffer.byteLength(WORKER_PROBE_OUTPUT_MARKER, "ascii")
// Shared with the embedded Python fixture writer and campaign's stable-reader bound.
const FIXTURE_RESULT_POLICY = Object.freeze({
  responseBytes: NATIVE_DATASET_LIMITS.nativeResponseBytes,
  maxSlots: 32,
  envelopeBytes: 62,
  slotOverheadBytes: 33,
  contentEscapeExpansion: 6,
  outputKinds: NATIVE_WIKI_OUTPUT_KINDS,
})
const WORKER_TIMEOUT_MS = 6 * 60 * 60 * 1000
const WORKER_TERM_GRACE_MS = 1_000
const WORKER_KILL_GRACE_MS = 2_000
const WORKER_EXIT_GROUP_SETTLE_MS = 250
const WORKER_PROBE_TIMEOUT_MS = 10_000
const WORKER_CPU_PROBE_TIMEOUT_MS = 5_000
const WORKER_PROBE_OUTPUT_BYTES = 32 * 1024
const WORKER_LIMITS = Object.freeze({
  wallMilliseconds: WORKER_TIMEOUT_MS, cpuSeconds: 21_600, addressSpaceBytes: 2 * 1024 ** 3,
  fileBytes: 256 * 1024 ** 2, openFiles: 64, stdoutBytes: MAX_WORKER_STDOUT_BYTES,
  stderrBytes: MAX_WORKER_STDERR_BYTES, messageBytes: MAX_WORKER_MESSAGE_BYTES,
})
const WORKER_FIXED_ENVIRONMENT = Object.freeze({
  PYTHONDONTWRITEBYTECODE: "1", OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1",
  MKL_NUM_THREADS: "1", NUMEXPR_NUM_THREADS: "1", VECLIB_MAXIMUM_THREADS: "1", BLIS_NUM_THREADS: "1",
})
const HASH = /^[a-f0-9]{64}$/
const OUTPUT_KINDS = new Set<string>(NATIVE_WIKI_OUTPUT_KINDS)
const O_CLOEXEC = process.platform === "darwin" ? 0x01000000 : 0x00080000
const REPO_ROOT = realpathSync.native(resolve(import.meta.dir, "../../../"))
const WORKER_SOURCE_PATHS = Object.freeze([
  "scripts/skillopt_runner.py",
  "scripts/skillopt-source-lock.json",
  "scripts/skillopt-requirements.lock",
  "framework/src/skillopt/dataset.ts",
])
const LINUX_SYSCALLS = Object.freeze({
  x64: Object.freeze([41, 42, 43, 44, 45, 46, 47, 49, 50, 53, 57, 58, 59, 101, 155, 165, 166, 175, 176, 197, 246, 248, 249, 250, 272, 282, 288, 298, 303, 304, 308, 310, 311, 313, 321, 322, 323, 424, 425, 426, 427, 428, 429, 430, 431, 432, 433, 434, 435, 438, 440, 442]),
  arm64: Object.freeze([39, 40, 41, 51, 97, 105, 117, 129, 175, 176, 198, 199, 200, 201, 202, 203, 206, 207, 211, 212, 217, 218, 219, 221, 241, 242, 264, 265, 268, 270, 271, 273, 277, 280, 281, 282, 424, 425, 426, 427, 428, 429, 430, 431, 432, 433, 434, 435, 438, 440, 442]),
})

export type SkillOptWorkerRole = "trainer" | "fixture"
export type SkillOptWorkerPlatform = "darwin" | "linux"
export type WorkerExecutableIdentity = Readonly<{
  pathSha256: string
  contentSha256: string
  dev: string
  ino: string
  uid: string
  size: string
  mode: number
  mtimeNs: string
  ctimeNs: string
}>
export type WorkerFilesystemIdentity = Readonly<{ dev: string; type: string }>
export type WorkerRuntimeIdentity = Readonly<
  | {
      kind: "python"; version: string; executableSha256: string; nativeRuntimeProofSha256: string; sourceLockSha256: string;
      dependencyLockSha256: string; importManifestSha256: string; upstreamCommit: string; upstreamVersion: string;
      licenseSha256: string; installedDependencyFingerprintSha256: string; platform: SkillOptWorkerPlatform
      wheelOriginStatus: "unobserved"
    }
>
export type WorkerResourceCaps = typeof WORKER_LIMITS
export type SkillOptWorkerProfileBinding = Readonly<{
  schema: typeof WORKER_BINDING_SCHEMA
  role: SkillOptWorkerRole
  platform: SkillOptWorkerPlatform
  profileSha256: string
  sourceSha256: string
  inputSha256: string
  executable: WorkerExecutableIdentity
  executableIdentitySha256: string
  adapterManifestSha256: string | null
  nativeRuntimeProofSha256: string
  runtime: WorkerRuntimeIdentity
  runtimeIdentitySha256: string
  resourceCaps: WorkerResourceCaps
  filesystem: Readonly<{
    input: WorkerFilesystemIdentity; output: WorkerFilesystemIdentity; adapterManifest: WorkerFilesystemIdentity | null;
    nativeRuntimeProof: WorkerFilesystemIdentity
  }>
}>
export type SkillOptWorkerProfile = Readonly<{
  schema: typeof WORKER_SCHEMA
  binding: SkillOptWorkerProfileBinding
}>
export type SkillOptContainmentReceipt = Readonly<{
  schema: typeof WORKER_RECEIPT_SCHEMA
  status: "READY" | "BLOCKED"
  code: string
  bindingSha256: string
  resourceCaps: WorkerResourceCaps
  probes: Readonly<{
    selectedInputReadable: boolean
    privateOutputWritable: boolean
    homeSentinelDenied: boolean
    worktreeSentinelDenied: boolean
    productionSentinelDenied: boolean
    networkDenied: boolean
    subprocessDenied: boolean
    threadCreationWorks: boolean
    fileSizeLimitEnforced: boolean
    openFilesLimitEnforced: boolean
    addressSpaceLimitEnforced: boolean
    cpuLimitEnforced: boolean
    resourceCapsEnforced: boolean
  }>
}>
type WorkerProbeOutput = Omit<SkillOptContainmentReceipt["probes"], "cpuLimitEnforced" | "resourceCapsEnforced">
type WorkerProfileInputBase = Readonly<{
  /** The exact configured path to the same private SkillOpt Python venv for both roles. */
  executablePath: string
  /** Required private attestation for the actual installed Python runtime used by either role. */
  nativeRuntimeProofPath: string
  /** A parent-owned, exact JSON train/dev projection or gold-free selected fixture. */
  selectedInputPath: string
  /** Existing empty directories, each owner-only; only outputDirectory is writable to a worker. */
  outputDirectory: string
  emptyHomeDirectory: string
  probeDirectory: string
}>
export type WorkerProfileInput = WorkerProfileInputBase & Readonly<
  | {
      role: "trainer"
      /** Exact parent-owned SkillOpt adapter protocol.json. */ adapterManifestPath: string
      /** Opaque, one-use controller debit for its separately staged output copy. */
      protocolStageAllowance: SkillOptNativeTrainerProtocolStageAllowance
    }
  | { role: "fixture"; adapterManifestPath?: never }
>
export type TrustedWorkerOperation = "trainer-native" | "fixture-apply"
export type OwnedWorkerResult = Readonly<{
  status: "completed" | "failed" | "cancelled" | "timed_out" | "output_limit" | "protocol_invalid" | "unresolved"
  exitCode: number | null
  signal: NodeJS.Signals | null
  quiescent: boolean
  stdoutBytes: number
  stderrBytes: number
  stdoutSha256: string
  stderrSha256: string
  errorCode?: string
}>
declare const ownedTrainerProtocolEventBrand: unique symbol
/** Opaque evidence that one bounded JSON object line was delivered by an owned trainer worker. */
export type OwnedTrainerProtocolEvent = Readonly<{ [ownedTrainerProtocolEventBrand]: true }>
export type OwnedTrainerProtocolLine = Readonly<{
  profileSha256: string
  receiptBindingSha256: string
  ordinal: number
  rawLineSha256: string
  rawLine: Buffer
}>
export type OwnedWorkerHandle = Readonly<{
  binding: SkillOptWorkerProfileBinding
  writeMessage(value: unknown): Promise<void>
  closeInput(): void
  onMessage(listener: (value: Record<string, unknown>) => void): () => void
  onTrainerProtocolEvent(listener: (event: OwnedTrainerProtocolEvent) => void): () => void
  wait(): Promise<OwnedWorkerResult>
  cancel(): Promise<OwnedWorkerResult>
  reconcile(): Promise<Readonly<{ outcome: "running" | "terminal" | "unknown"; quiescent: boolean; evidence: string }>>
}>

type NativeFileIdentity = WorkerExecutableIdentity & Readonly<{ bytes: Buffer }>
type DirectoryIdentity = Readonly<{ path: string; dev: string; ino: string; uid: string; mode: number }>
type ExecutableInvocationIdentity = Readonly<{
  path: string; targetPath: string; dev: string; ino: string; uid: string; size: string; mode: number;
  mtimeNs: string; ctimeNs: string; linkTarget: string | null
}>
type InternalWorkerProfile = {
  role: SkillOptWorkerRole
  platform: SkillOptWorkerPlatform
  executablePath: string
  executableRealpath: string
  executableIdentity: NativeFileIdentity
  executableInvocationIdentity: ExecutableInvocationIdentity
  inputPath: string
  inputIdentity: NativeFileIdentity
  fixtureResultByteBound?: number
  adapterManifestPath?: string
  adapterManifestIdentity?: NativeFileIdentity
  adapterManifestStageAllowance?: SkillOptNativeTrainerProtocolStageAllowance
  adapterManifestStageMetadata?: SkillOptNativeTrainerMaterializationMetadata
  adapterManifestFs?: WorkerFilesystemIdentity
  adapterManifestParent?: DirectoryIdentity
  output: DirectoryIdentity
  emptyHome: DirectoryIdentity
  probeRoot: DirectoryIdentity
  runtimeRoot?: DirectoryIdentity
  runtimeBinRoot?: DirectoryIdentity
  runtimeBaseRoot?: DirectoryIdentity
  nativeRuntimeProofPath?: string
  nativeRuntimeProofIdentity?: NativeFileIdentity
  nativeRuntimeProofParent?: DirectoryIdentity
  runtimeBinding: WorkerRuntimeIdentity
  adapterManifestStage?: NativeFileIdentity
  adapterManifestStagePath?: string
  sandboxPath: string
  sandboxIdentity: NativeFileIdentity
  sourceFiles: readonly Readonly<{ path: string; identity: NativeFileIdentity }>[]
  sourceSha256: string
  inputFs: WorkerFilesystemIdentity
  outputFs: WorkerFilesystemIdentity
  binding: SkillOptWorkerProfileBinding
  profile: SkillOptWorkerProfile
  sandboxProfile?: string
  launched: boolean
  receipt?: SkillOptContainmentReceipt
}

const workerProfiles = new WeakMap<SkillOptWorkerProfile, InternalWorkerProfile>()
const workerReceipts = new WeakMap<SkillOptContainmentReceipt, InternalWorkerProfile>()
const workerResultProvenance = new WeakMap<object, Readonly<{
  profile: SkillOptWorkerProfile
  receipt: SkillOptContainmentReceipt
  operation: TrustedWorkerOperation
}>>()
type OwnedTrainerProtocolEventRecord = {
  profile: SkillOptWorkerProfile
  receipt: SkillOptContainmentReceipt
  operation: TrustedWorkerOperation
  profileSha256: string
  receiptBindingSha256: string
  ordinal: number
  rawLineSha256: string
  rawLine: Buffer
  used: boolean
}
const ownedTrainerProtocolEvents = new WeakMap<object, OwnedTrainerProtocolEventRecord>()

/** Consume the exact host-minted trainer line once; this proves provenance, not protocol approval. */
export function consumeOwnedTrainerProtocolEvent(
  event: OwnedTrainerProtocolEvent,
  expected: Readonly<{ profile: SkillOptWorkerProfile; receipt: SkillOptContainmentReceipt }>,
): OwnedTrainerProtocolLine {
  if (!event || typeof event !== "object") workerFail("trainer_protocol_event_unowned")
  if (!isWorkerObject(expected) || !exactWorkerKeys(expected, ["profile", "receipt"])) {
    workerFail("trainer_protocol_event_binding_invalid")
  }
  const profileField = Object.getOwnPropertyDescriptor(expected, "profile")
  const receiptField = Object.getOwnPropertyDescriptor(expected, "receipt")
  if (!profileField || !("value" in profileField) || !receiptField || !("value" in receiptField)) {
    workerFail("trainer_protocol_event_binding_invalid")
  }
  const profile = profileField.value as SkillOptWorkerProfile
  const receipt = receiptField.value as SkillOptContainmentReceipt
  const provenance = ownedTrainerProtocolEvents.get(event)
  if (!provenance) workerFail("trainer_protocol_event_unowned")
  if (provenance.used) workerFail("trainer_protocol_event_replayed")
  const internal = workerProfiles.get(profile)
  if (!internal || internal.profile !== profile || internal.role !== "trainer" || !internal.launched ||
      workerReceipts.get(receipt) !== internal || internal.receipt !== receipt || provenance.profile !== profile ||
      provenance.receipt !== receipt || provenance.operation !== "trainer-native" || receipt.status !== "READY" ||
      receipt.bindingSha256 !== internal.binding.profileSha256 || provenance.profileSha256 !== internal.binding.profileSha256 ||
      provenance.receiptBindingSha256 !== receipt.bindingSha256) {
    workerFail("trainer_protocol_event_binding_invalid")
  }
  const rawLine = Buffer.from(provenance.rawLine)
  provenance.used = true
  provenance.rawLine = Buffer.alloc(0)
  return Object.freeze({
    profileSha256: provenance.profileSha256,
    receiptBindingSha256: provenance.receiptBindingSha256,
    ordinal: provenance.ordinal,
    rawLineSha256: provenance.rawLineSha256,
    rawLine,
  })
}

/** True only for the exact result object emitted by a successful trainer worker finish. */
export function isGenuineCompletedQuiescentTrainerResult(
  result: OwnedWorkerResult,
  profile: SkillOptWorkerProfile,
  receipt: SkillOptContainmentReceipt,
): boolean {
  if (!result || typeof result !== "object") return false
  const provenance = workerResultProvenance.get(result)
  if (!provenance || provenance.profile !== profile || provenance.receipt !== receipt || provenance.operation !== "trainer-native") return false
  const internal = workerProfiles.get(profile)
  return !!internal && internal.role === "trainer" && internal.profile === profile && internal.receipt === receipt &&
    workerReceipts.get(receipt) === internal && result.status === "completed" && result.exitCode === 0 &&
    result.signal === null && result.quiescent
}

/** Read-only launch observation used to prevent immediate scratch removal while its worker may still use it. */
export function hasLaunchedNativeSkillOptTrainerWorker(
  profile: SkillOptWorkerProfile,
  receipt: SkillOptContainmentReceipt,
): boolean {
  if (!profile || typeof profile !== "object" || !receipt || typeof receipt !== "object") return false
  const internal = workerProfiles.get(profile)
  return !!internal && internal.role === "trainer" && internal.profile === profile && internal.receipt === receipt &&
    workerReceipts.get(receipt) === internal && internal.launched
}

export class SkillOptWorkerError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "SkillOptWorkerError"
  }
}

function workerFail(code: string): never { throw new SkillOptWorkerError(code) }
function isWorkerObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Exact private file payload written by the existing filesystem-containment probe. */
export function nativeSkillOptFixtureProbeSerializedBytes(): number {
  return WORKER_PROBE_SENTINEL_COUNT * WORKER_PROBE_SENTINEL_BYTES + WORKER_PROBE_OUTPUT_MARKER_BYTES
}

/** Conservative serialized result bound for one validated fixture's controlled slot writer. */
export function nativeSkillOptFixtureResultByteBound(
  slots: readonly Readonly<{ id: string; kind: string }>[],
): number {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > FIXTURE_RESULT_POLICY.maxSlots) {
    workerFail("fixture_output_slots_invalid")
  }
  const ids = new Set<string>()
  let metadataBytes = 0
  for (const slot of slots) {
    if (!isWorkerObject(slot) || typeof slot.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(slot.id) || ids.has(slot.id) ||
        typeof slot.kind !== "string" || !OUTPUT_KINDS.has(slot.kind)) {
      workerFail("fixture_output_slots_invalid")
    }
    ids.add(slot.id)
    metadataBytes += Buffer.byteLength(slot.id, "utf8") + Buffer.byteLength(slot.kind, "utf8")
  }
  // The envelope is 62 + 33 bytes per slot plus ASCII identifiers/kinds; each UTF-8 content byte expands at most 6x.
  return FIXTURE_RESULT_POLICY.envelopeBytes + FIXTURE_RESULT_POLICY.slotOverheadBytes * slots.length + metadataBytes +
    FIXTURE_RESULT_POLICY.contentEscapeExpansion * FIXTURE_RESULT_POLICY.responseBytes
}
function exactWorkerKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function canonicalOwnedDirectory(path: string, label: string, empty: boolean): DirectoryIdentity {
  if (!isAbsolute(path) || path !== resolve(path) || realpathSync.native(path) !== path) workerFail(`${label}_path_invalid`)
  const st = lstatSync(path, { bigint: true })
  const uid = BigInt(process.getuid?.() ?? -1)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o7777n) !== 0o700n || (st.mode & 0o022n) !== 0n) {
    workerFail(`${label}_directory_unsafe`)
  }
  if (empty && readdirSync(path).length !== 0) workerFail(`${label}_directory_not_empty`)
  return { path, dev: String(st.dev), ino: String(st.ino), uid: String(st.uid), mode: Number(st.mode & 0o7777n) }
}

function stableWorkerFile(path: string, maximumBytes: number, allowRootOwner = false): NativeFileIdentity {
  if (!isAbsolute(path) || path !== resolve(path) || realpathSync.native(path) !== path) workerFail("worker_file_path_invalid")
  const before = lstatSync(path, { bigint: true })
  const uid = BigInt(process.getuid?.() ?? -1)
  const ownerAllowed = before.uid === uid || (allowRootOwner && before.uid === 0n)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximumBytes) ||
      !ownerAllowed || ((before.mode & 0o6000n) !== 0n &&
        !(allowRootOwner && before.uid === 0n && (before.mode & 0o6000n) === 0o4000n)) || (before.mode & 0o022n) !== 0n ||
      (before.mode & 0o111n) === 0n && (before.mode & 0o444n) === 0n) workerFail("worker_file_unsafe")
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== before.uid || opened.mode !== before.mode ||
        opened.size !== before.size || opened.nlink !== before.nlink || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) {
      workerFail("worker_file_changed")
    }
    const chunks: Buffer[] = []
    const block = Buffer.alloc(64 * 1024)
    const hash = createHash("sha256")
    let total = 0
    while (total < Number(opened.size)) {
      const count = readSync(fd, block, 0, Math.min(block.length, Number(opened.size) - total), total)
      if (count <= 0) workerFail("worker_file_short_read")
      const chunk = Buffer.from(block.subarray(0, count))
      chunks.push(chunk)
      hash.update(chunk)
      total += count
    }
    const after = fstatSync(fd, { bigint: true })
    const named = lstatSync(path, { bigint: true })
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mode !== opened.mode ||
        after.uid !== opened.uid || after.nlink !== 1n || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
        named.dev !== after.dev || named.ino !== after.ino || named.size !== after.size || named.ctimeNs !== after.ctimeNs) workerFail("worker_file_changed")
    return {
      pathSha256: sha256(path), contentSha256: hash.digest("hex"), dev: String(after.dev), ino: String(after.ino), uid: String(after.uid),
      size: String(after.size), mode: Number(after.mode & 0o7777n), mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs),
      bytes: Buffer.concat(chunks, total),
    }
  } finally {
    closeSync(fd)
  }
}

function executableInvocationIdentity(path: string, targetPath: string): ExecutableInvocationIdentity {
  if (!isAbsolute(path) || path !== resolve(path) || realpathSync.native(path) !== targetPath) workerFail("worker_executable_invocation_invalid")
  const before = lstatSync(path, { bigint: true })
  const uid = BigInt(process.getuid?.() ?? -1)
  const ownerAllowed = before.uid === uid || (path === targetPath && before.uid === 0n)
  if (!ownerAllowed || before.nlink !== 1n || (!before.isSymbolicLink() && (!before.isFile() || path !== targetPath))) {
    workerFail("worker_executable_invocation_unsafe")
  }
  const linkTarget = before.isSymbolicLink() ? readlinkSync(path) : null
  const resolvedBefore = realpathSync.native(path)
  const after = lstatSync(path, { bigint: true })
  const afterLinkTarget = after.isSymbolicLink() ? readlinkSync(path) : null
  if (resolvedBefore !== targetPath || after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid ||
      after.mode !== before.mode || after.size !== before.size || after.nlink !== before.nlink ||
      after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || afterLinkTarget !== linkTarget) {
    workerFail("worker_executable_invocation_changed")
  }
  return Object.freeze({ path, targetPath, dev: String(after.dev), ino: String(after.ino), uid: String(after.uid),
    size: String(after.size), mode: Number(after.mode & 0o7777n), mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs), linkTarget })
}

function identityView(identity: NativeFileIdentity): WorkerExecutableIdentity {
  const { bytes: _bytes, ...view } = identity
  return Object.freeze(view)
}

function privateInputFile(path: string, role: SkillOptWorkerRole): NativeFileIdentity {
  const input = stableWorkerFile(path, MAX_WORKER_INPUT_BYTES)
  const parent = canonicalOwnedDirectory(dirname(path), "worker_input_parent", false)
  if ((parent.mode & 0o022) !== 0 || Number(BigInt(input.uid)) !== process.getuid?.()) workerFail("worker_input_parent_unsafe")
  let parsed: unknown
  try { parsed = JSON.parse(input.bytes.toString("utf8")) } catch { return workerFail("worker_input_invalid_json") }
  if (role === "trainer") validateTrainerProjection(parsed)
  else validateGoldFreeFixture(parsed)
  return input
}

function validateFixtureInput(value: unknown, hasAssertions = false): value is Record<string, unknown> {
  const keys = hasAssertions ? ["task", "sources", "outputSlots", "assertions"] : ["task", "sources", "outputSlots"]
  if (!isWorkerObject(value) || !exactWorkerKeys(value, keys) ||
      typeof value.task !== "string" || Buffer.byteLength(value.task) > 64 * 1024 || !Array.isArray(value.sources) ||
      !Array.isArray(value.outputSlots) || value.outputSlots.length < 1 ||
      value.outputSlots.length > FIXTURE_RESULT_POLICY.maxSlots) return false
  for (const source of value.sources) {
    if (!isWorkerObject(source) || !exactWorkerKeys(source, ["id", "provenance", "content", "sha256"]) ||
        typeof source.id !== "string" || typeof source.provenance !== "string" || typeof source.content !== "string" ||
        typeof source.sha256 !== "string" || !HASH.test(source.sha256) || sha256(source.content) !== source.sha256 ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(source.id) || !["raw", "annotation", "synthesis", "contract"].includes(source.provenance)) return false
  }
  const slots = new Set<string>()
  for (const slot of value.outputSlots) {
    if (!isWorkerObject(slot) || !exactWorkerKeys(slot, ["id", "kind", "existingContent"]) ||
        typeof slot.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(slot.id) || slots.has(slot.id) ||
        typeof slot.kind !== "string" || !OUTPUT_KINDS.has(slot.kind) || typeof slot.existingContent !== "string" ||
        Buffer.byteLength(slot.existingContent) > 256 * 1024) return false
    slots.add(slot.id)
  }
  return true
}

function validateGoldFreeFixture(value: unknown): void {
  if (!validateFixtureInput(value)) workerFail("fixture_input_invalid")
}

function validateTrainerProjection(value: unknown): void {
  if (!isWorkerObject(value) || !exactWorkerKeys(value, ["schema", "protocolSha256", "train", "dev", "projectionSha256"]) ||
      value.schema !== NATIVE_TRAINER_PROJECTION_SCHEMA || typeof value.protocolSha256 !== "string" || !HASH.test(value.protocolSha256) ||
      typeof value.projectionSha256 !== "string" || !HASH.test(value.projectionSha256) || !Array.isArray(value.train) || !Array.isArray(value.dev)) {
    workerFail("trainer_projection_invalid")
  }
  const { projectionSha256, ...core } = value
  if (sha256(canonicalJson(core)) !== projectionSha256) workerFail("trainer_projection_digest_mismatch")
  for (const row of value.train) {
    if (!validateFixtureInput(row, true) || !isWorkerObject(row.assertions) ||
        !exactWorkerKeys(row.assertions, ["facts", "citations", "contradictions", "deduplication", "ownership"]) ||
        !Object.values(row.assertions).every(Array.isArray)) workerFail("trainer_projection_invalid")
    const assertions = row.assertions
    const sourceIds = new Set((row.sources as Record<string, unknown>[]).map((source) => source.id))
    const slotIds = new Set((row.outputSlots as Record<string, unknown>[]).map((slot) => slot.id))
    for (const item of assertions.facts as unknown[]) if (!isWorkerObject(item) || !exactWorkerKeys(item, ["id", "slotId", "statement", "sourceIds"]) ||
        typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.id) ||
        typeof item.slotId !== "string" || !slotIds.has(item.slotId) || typeof item.statement !== "string" ||
        !Array.isArray(item.sourceIds) || item.sourceIds.length === 0 || item.sourceIds.some((id) => !sourceIds.has(id))) {
      workerFail("trainer_projection_invalid")
    }
    for (const item of assertions.citations as unknown[]) if (!isWorkerObject(item) || !exactWorkerKeys(item, ["factId", "sourceId"])) workerFail("trainer_projection_invalid")
    for (const item of assertions.contradictions as unknown[]) if (!isWorkerObject(item) || !exactWorkerKeys(item, ["leftFactId", "rightFactId", "expected"])) workerFail("trainer_projection_invalid")
    for (const item of assertions.deduplication as unknown[]) if (!isWorkerObject(item) || !exactWorkerKeys(item, ["slotId", "expected"])) workerFail("trainer_projection_invalid")
    for (const item of assertions.ownership as unknown[]) if (!isWorkerObject(item) || !exactWorkerKeys(item, ["slotId", "expected"])) workerFail("trainer_projection_invalid")
  }
  for (const row of value.dev) if (!validateFixtureInput(row)) workerFail("trainer_projection_invalid")
}

type AdapterManifestCase = Readonly<{ caseId: string; replicate: number }>

function adapterManifestCases(value: unknown, count: number): AdapterManifestCase[] | null {
  if (!Array.isArray(value) || value.length !== count) return null
  const rows: AdapterManifestCase[] = []
  for (const row of value) {
    if (!isWorkerObject(row) || !exactWorkerKeys(row, ["caseId", "replicate"]) ||
        typeof row.caseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(row.caseId) ||
        typeof row.replicate !== "number" || !Number.isInteger(row.replicate) || row.replicate < 0 || row.replicate > 2) return null
    rows.push({ caseId: row.caseId, replicate: row.replicate })
  }
  return rows
}

function validateAdapterManifest(value: unknown, sourceLockSha256: string): void {
  if (!isWorkerObject(value) || !exactWorkerKeys(value, ["schema", "runId", "mode", "originalSkillSha256", "sourceLockSha256", "train", "selection"]) ||
      value.schema !== "skillopt.adapter-manifest.v1" || typeof value.runId !== "string" ||
      !/^[A-Za-z0-9_-]{1,96}$/.test(value.runId) ||
      (value.mode !== "development" && value.mode !== "experiment") || typeof value.originalSkillSha256 !== "string" || !HASH.test(value.originalSkillSha256) ||
      value.sourceLockSha256 !== sourceLockSha256) workerFail("adapter_manifest_invalid")

  const development = value.mode === "development"
  const train = adapterManifestCases(value.train, development ? 1 : 24)
  const selection = adapterManifestCases(value.selection, development ? 1 : 48)
  if (!train || !selection) workerFail("adapter_manifest_invalid")
  const trainIds = train.map((row) => row.caseId)
  const selectionIds = new Set(selection.map((row) => row.caseId))
  const expectedSelectionIds = development ? 1 : 16
  if (new Set(trainIds).size !== trainIds.length || selectionIds.size !== expectedSelectionIds ||
      trainIds.some((caseId) => selectionIds.has(caseId)) || train.some((row) => row.replicate !== 0)) {
    workerFail("adapter_manifest_invalid")
  }
  const selectionReplicates = new Map<string, Set<number>>()
  for (const row of selection) {
    const replicates = selectionReplicates.get(row.caseId) ?? new Set<number>()
    if (replicates.has(row.replicate)) workerFail("adapter_manifest_invalid")
    replicates.add(row.replicate)
    selectionReplicates.set(row.caseId, replicates)
  }
  const expectedReplicates = development ? [0] : [0, 1, 2]
  if ([...selectionReplicates.values()].some((replicates) =>
    replicates.size !== expectedReplicates.length || expectedReplicates.some((replicate) => !replicates.has(replicate)))) {
    workerFail("adapter_manifest_invalid")
  }
}

function privateAdapterManifestFile(path: string, sourceLockSha256: string): {
  identity: NativeFileIdentity; parent: DirectoryIdentity
} {
  if (basename(path) !== "protocol.json") workerFail("adapter_manifest_path_invalid")
  const parent = canonicalOwnedDirectory(dirname(path), "worker_adapter_manifest_parent", false)
  const manifest = stableWorkerFile(path, MAX_ADAPTER_MANIFEST_BYTES)
  const parentAfter = canonicalOwnedDirectory(dirname(path), "worker_adapter_manifest_parent", false)
  if (canonicalJson(parent) !== canonicalJson(parentAfter)) workerFail("worker_adapter_manifest_parent_changed")
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes)) }
  catch { return workerFail("adapter_manifest_invalid") }
  validateAdapterManifest(parsed, sourceLockSha256)
  return { identity: manifest, parent }
}

function nativeRuntimeAttestation(
  path: string,
  expectedPath: string,
  runtimeRoot: DirectoryIdentity,
  runtimeBaseRoot: DirectoryIdentity,
  executablePath: string,
  executableRealpath: string,
  executable: NativeFileIdentity,
  platform: SkillOptWorkerPlatform,
  sourceFiles: readonly Readonly<{ path: string; identity: NativeFileIdentity }>[],
): Readonly<{ identity: NativeFileIdentity; parent: DirectoryIdentity; runtime: WorkerRuntimeIdentity }> {
  if (path !== expectedPath || path !== resolve(path) || basename(path) !== "native-runtime-proof.json") {
    workerFail("native_runtime_proof_path_invalid")
  }
  const parent = canonicalOwnedDirectory(dirname(path), "native_runtime_proof_parent", false)
  const proofFile = stableWorkerFile(path, MAX_NATIVE_RUNTIME_PROOF_BYTES)
  if (![0o400, 0o600].includes(proofFile.mode & 0o7777)) workerFail("native_runtime_proof_not_private")
  const parentAfter = canonicalOwnedDirectory(dirname(path), "native_runtime_proof_parent", false)
  if (canonicalJson(parent) !== canonicalJson(parentAfter)) workerFail("native_runtime_proof_parent_changed")
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(proofFile.bytes)) }
  catch { return workerFail("native_runtime_proof_invalid") }
  const fields = ["schema", "claim", "sourceLockSha256", "dependencyLockSha256", "upstreamCommit", "upstreamVersion",
    "importManifestSha256", "importManifestFiles", "importManifestBytes", "licenseSha256", "interpreter", "lockedDependencies",
    "installedDistributions", "installedDependencyFingerprintSha256", "sitePackages", "startupSecurity", "wheelOriginStatus"]
  if (!isWorkerObject(parsed) || !exactWorkerKeys(parsed, fields) || parsed.schema !== "skillopt.native-runtime-proof.v1" ||
      parsed.claim !== "observed_local_runtime_pin" ||
      parsed.sourceLockSha256 !== sourceFiles[1]?.identity.contentSha256 ||
      parsed.dependencyLockSha256 !== sourceFiles[2]?.identity.contentSha256 || parsed.upstreamCommit !== PINNED_SKILLOPT_COMMIT ||
      parsed.upstreamVersion !== "0.2.0" || parsed.importManifestSha256 !== "342138966970886a70fa9092b93018cfad8d7b33708f81897d6ec32fc14b2441" ||
      parsed.importManifestFiles !== 141 || parsed.importManifestBytes !== 963171 ||
      parsed.licenseSha256 !== "9515a04280cf50ce154eb3ab8fa375c7cc5e6b45ea5cb23b7ff3830737020c15" ||
      typeof parsed.installedDependencyFingerprintSha256 !== "string" || !HASH.test(parsed.installedDependencyFingerprintSha256) ||
      !isWorkerObject(parsed.interpreter) || !Array.isArray(parsed.lockedDependencies) || parsed.lockedDependencies.length === 0 ||
      !Array.isArray(parsed.installedDistributions) || parsed.installedDistributions.length === 0 ||
      !isWorkerObject(parsed.sitePackages) || !exactWorkerKeys(parsed.sitePackages, ["roots", "bytecode"]) ||
      !Array.isArray(parsed.sitePackages.roots) || parsed.sitePackages.roots.length !== 1 ||
      !isWorkerObject(parsed.sitePackages.bytecode) || !exactWorkerKeys(parsed.sitePackages.bytecode, ["root", "files", "bytes", "contentSha256"]) ||
      !isWorkerObject(parsed.startupSecurity) || !exactWorkerKeys(parsed.startupSecurity,
        ["isolated", "noSite", "dontWriteBytecode", "sitePackageSearchPathAdded", "pthProcessed", "sitecustomizeLoaded"]) ||
      parsed.startupSecurity.isolated !== true || parsed.startupSecurity.noSite !== true ||
      parsed.startupSecurity.dontWriteBytecode !== true || parsed.startupSecurity.sitePackageSearchPathAdded !== false ||
      parsed.startupSecurity.pthProcessed !== false || parsed.startupSecurity.sitecustomizeLoaded !== false ||
      parsed.wheelOriginStatus !== "unobserved") {
    workerFail("native_runtime_proof_invalid")
  }
  const interpreter = parsed.interpreter as Record<string, unknown>
  const interpreterFields = ["configuredPath", "realpath", "sha256", "version", "venvRoot", "venvHome", "venvConfiguration",
    "basePrefix", "startupPrefix", "startupBasePrefix", "startupPrefixIsVenv", "venvOwnerUid", "venvMode", "interpreterOwnerUid",
    "interpreterMode", "configuredEntryKind", "binMode", "pyvenvConfigSha256", "uid", "platform", "osName", "machine",
    "implementation", "cacheTag", "sysconfigPlatform", "isolated", "noUserSite", "ignoreEnvironment", "noSite",
    "userSiteEnabled", "siteEnableUserSite", "dontWriteBytecodeFlag", "dontWriteBytecode", "pythonPathAbsent",
    "pythonHomeAbsent", "sysPath"]
  if (!exactWorkerKeys(interpreter, interpreterFields)) workerFail("native_runtime_proof_invalid")
  const version = interpreter.version
  const executableHash = interpreter.sha256
  const venvConfig = stableWorkerFile(join(runtimeRoot.path, "pyvenv.cfg"), 16 * 1024)
  const configEntries: Record<string, string> = {}
  for (const line of venvConfig.bytes.toString("utf8").split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const separator = trimmed.indexOf("=")
    if (separator < 1) workerFail("native_runtime_proof_invalid")
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(key) || !value || Object.hasOwn(configEntries, key)) {
      workerFail("native_runtime_proof_invalid")
    }
    configEntries[key] = value
  }
  const resolvedVenvConfig = { ...configEntries, home: realpathSync.native(configEntries.home ?? "") }
  const proofVenvConfig = interpreter.venvConfiguration
  const sitePackages = parsed.sitePackages as Record<string, unknown>
  const sitePackagePath = (sitePackages.roots as unknown[])[0]
  const sitePackageBytecode = sitePackages.bytecode as Record<string, unknown>
  const sysPath = interpreter.sysPath
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || executableHash !== executable.contentSha256 ||
      executable.uid !== String(process.getuid?.() ?? -1) ||
      interpreter.configuredPath !== executablePath || interpreter.realpath !== executableRealpath ||
      !contained(runtimeRoot.path, executableRealpath) || interpreter.venvRoot !== runtimeRoot.path ||
      interpreter.venvHome !== resolvedVenvConfig.home || !isWorkerObject(proofVenvConfig) ||
      canonicalJson(proofVenvConfig) !== canonicalJson(resolvedVenvConfig) ||
      interpreter.basePrefix !== runtimeBaseRoot.path || interpreter.startupBasePrefix !== runtimeBaseRoot.path ||
      ![runtimeRoot.path, runtimeBaseRoot.path].includes(interpreter.startupPrefix as string) ||
      interpreter.startupPrefixIsVenv !== (interpreter.startupPrefix === runtimeRoot.path) ||
      interpreter.venvOwnerUid !== Number(runtimeRoot.uid) || interpreter.venvMode !== runtimeRoot.mode ||
      interpreter.interpreterOwnerUid !== Number(executable.uid) || interpreter.interpreterMode !== executable.mode ||
      interpreter.configuredEntryKind !== (executablePath === executableRealpath ? "regular" : "symlink") ||
      interpreter.binMode !== Number(BigInt(lstatSync(dirname(executablePath), { bigint: true }).mode) & 0o7777n) ||
      interpreter.uid !== (process.getuid?.() ?? -1) || interpreter.platform !== platform ||
      interpreter.pyvenvConfigSha256 !== venvConfig.contentSha256 || interpreter.isolated !== true || interpreter.noSite !== true ||
      interpreter.noUserSite !== true || interpreter.ignoreEnvironment !== true || interpreter.dontWriteBytecodeFlag !== 1 ||
      interpreter.userSiteEnabled !== false || interpreter.dontWriteBytecode !== true ||
      interpreter.pythonPathAbsent !== true || interpreter.pythonHomeAbsent !== true ||
      configEntries["include-system-site-packages"]?.toLowerCase() !== "false" || configEntries.version_info !== version ||
      configEntries.implementation !== interpreter.implementation ||
      !Array.isArray(sysPath) || sysPath.length === 0 ||
      !sysPath.every((entry: unknown) => isWorkerObject(entry) &&
        (exactWorkerKeys(entry, ["path", "state"]) || exactWorkerKeys(entry, ["path", "state", "sha256", "bytes"])) &&
        typeof entry.path === "string" && isAbsolute(entry.path) && entry.path === resolve(entry.path) &&
        ["missing", "directory", "file"].includes(String(entry.state)) &&
        (entry.state !== "file" || (typeof entry.sha256 === "string" && HASH.test(entry.sha256) &&
          Number.isSafeInteger(entry.bytes) && Number(entry.bytes) >= 0))) ||
      typeof sitePackagePath !== "string" || !isAbsolute(sitePackagePath) || sitePackagePath !== resolve(sitePackagePath) ||
      !contained(runtimeRoot.path, sitePackagePath) ||
      !Number.isSafeInteger(sitePackageBytecode.files) || Number(sitePackageBytecode.files) < 0 ||
      !Number.isSafeInteger(sitePackageBytecode.bytes) || Number(sitePackageBytecode.bytes) < 0 ||
      typeof sitePackageBytecode.root !== "string" || typeof sitePackageBytecode.contentSha256 !== "string" ||
      !HASH.test(sitePackageBytecode.contentSha256)) workerFail("native_runtime_proof_invalid")
  const sitePackageStat = lstatSync(sitePackagePath, { bigint: true })
  if (!sitePackageStat.isDirectory() || sitePackageStat.isSymbolicLink() ||
      sitePackageStat.uid !== BigInt(process.getuid?.() ?? -1) || (sitePackageStat.mode & 0o022n) !== 0n) {
    workerFail("native_runtime_proof_invalid")
  }
  const runtime: WorkerRuntimeIdentity = Object.freeze({
    kind: "python", version, executableSha256: executable.contentSha256, nativeRuntimeProofSha256: proofFile.contentSha256,
    sourceLockSha256: parsed.sourceLockSha256 as string, dependencyLockSha256: parsed.dependencyLockSha256 as string,
    importManifestSha256: parsed.importManifestSha256 as string, upstreamCommit: parsed.upstreamCommit as string,
    upstreamVersion: parsed.upstreamVersion as string, licenseSha256: parsed.licenseSha256 as string,
    installedDependencyFingerprintSha256: parsed.installedDependencyFingerprintSha256 as string,
    platform, wheelOriginStatus: "unobserved",
  })
  return { identity: proofFile, parent, runtime }
}

function filesystemIdentity(path: string): WorkerFilesystemIdentity {
  const st = lstatSync(path, { bigint: true })
  const fs = statfsSync(path, { bigint: true })
  return Object.freeze({ dev: String(st.dev), type: String(fs.type) })
}

function contained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function digestDirectory(identity: DirectoryIdentity): void {
  const current = lstatSync(identity.path, { bigint: true })
  if (!current.isDirectory() || current.isSymbolicLink() || String(current.dev) !== identity.dev || String(current.ino) !== identity.ino ||
      String(current.uid) !== identity.uid || Number(current.mode & 0o7777n) !== identity.mode) workerFail("worker_directory_changed")
}

const PYTHON_WORKER_BOOTSTRAP = String.raw`
import ctypes, errno, hashlib, json, mmap, os, resource, runpy, signal, socket, stat, struct, sys

os.umask(0o077)

LIMITS = json.loads(os.environ["SKILLOPT_WORKER_LIMITS"])
FIXTURE_RESULT_POLICY = ${JSON.stringify(FIXTURE_RESULT_POLICY)}
PROBE_OUTPUT_MARKER = ${JSON.stringify(WORKER_PROBE_OUTPUT_MARKER)}
def current_virtual_bytes():
    if sys.platform != "linux":
        return None
    try:
        with open("/proc/self/statm", "rt", encoding="ascii") as stream:
            pages = int(stream.read(128).split()[0])
        return pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        return None

INITIAL_VIRTUAL_BYTES = current_virtual_bytes()
def impose_limits():
    limits = [(resource.RLIMIT_CPU, LIMITS["cpuSeconds"]), (resource.RLIMIT_AS, LIMITS["addressSpaceBytes"]),
              (resource.RLIMIT_FSIZE, LIMITS["fileBytes"]), (resource.RLIMIT_NOFILE, LIMITS["openFiles"]),
              (resource.RLIMIT_CORE, 0)]
    for resource_id, cap in limits:
        old_soft, old_hard = resource.getrlimit(resource_id)
        hard = cap if old_hard == resource.RLIM_INFINITY else min(old_hard, cap)
        soft = cap if old_soft == resource.RLIM_INFINITY else min(old_soft, cap)
        soft = min(soft, hard)
        resource.setrlimit(resource_id, (soft, hard))
        actual_soft, actual_hard = resource.getrlimit(resource_id)
        if actual_soft > cap or actual_hard > cap:
            raise OSError(errno.EPERM, "resource limit unavailable")

def impose_linux_filter():
    if sys.platform != "linux":
        return
    machine = os.uname().machine
    if machine == "x86_64":
        audit_arch, syscall_nr, clone_nr = 0xC000003E, 317, 56
    elif machine == "aarch64":
        audit_arch, syscall_nr, clone_nr = 0xC00000B7, 277, 220
    else:
        raise OSError(errno.ENOTSUP, "unsupported seccomp architecture")
    denied = json.loads(os.environ["SKILLOPT_BLOCKED_SYSCALLS"])["x64" if machine == "x86_64" else "arm64"]
    clone3_nr = 435
    if clone_nr in denied or clone3_nr not in denied:
        raise OSError(errno.EINVAL, "clone syscall policy mismatch")
    pthread_required_flags = 0x00000100 | 0x00000800 | 0x00010000
    pthread_allowed_flags = (pthread_required_flags | 0x00000200 | 0x00000400 | 0x00040000 | 0x00080000 |
                             0x00100000 | 0x00200000 | 0x01000000)
    clone_checks = [(0x20, 0, 0, 20), (0x15, 1, 0, 0), (0x06, 0, 0, 0x00050000 | errno.EPERM), (0x20, 0, 0, 16)]
    for flag in (0x00000100, 0x00000800, 0x00010000):
        clone_checks.extend([(0x45, 1, 0, flag), (0x06, 0, 0, 0x00050000 | errno.EPERM)])
    forbidden_flags = 0xFFFFFFFF ^ pthread_allowed_flags
    clone_checks.extend([(0x45, 0, 1, forbidden_flags), (0x06, 0, 0, 0x00050000 | errno.EPERM),
                         (0x06, 0, 0, 0x7FFF0000)])
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, audit_arch), (0x06, 0, 0, 0x80000000),
                    (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, 0x80000000),
                    (0x15, 0, 1, clone3_nr), (0x06, 0, 0, 0x00050000 | errno.ENOSYS),
                    (0x15, 0, len(clone_checks), clone_nr)]
    instructions.extend(clone_checks)
    for number in denied:
        if int(number) != clone3_nr:
            instructions.extend([(0x15, 0, 1, int(number)), (0x06, 0, 0, 0x00050000 | errno.EPERM)])
    instructions.append((0x06, 0, 0, 0x7FFF0000))
    class SockFilter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]
    class SockFprog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]
    filters = (SockFilter * len(instructions))(*(SockFilter(*row) for row in instructions))
    program = SockFprog(len(instructions), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "no-new-privileges unavailable")
    result = libc.syscall(syscall_nr, 1, 1, ctypes.byref(program))
    if result != 0:
        raise OSError(ctypes.get_errno(), "synchronized seccomp unavailable")

def denied_read(path):
    try:
        with open(path, "rb") as stream:
            stream.read(1)
        return False
    except OSError:
        return True

def denied_write(path):
    try:
        with open(path + ".write", "xb") as stream:
            stream.write(b"probe")
        return False
    except OSError:
        return True

def resource_behavior_probe(output_path):
    signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
    size_path = output_path + ".size-limit"
    size_fd = os.open(size_path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    try:
        try:
            os.ftruncate(size_fd, LIMITS["fileBytes"] + 1)
            file_size_limit_enforced = False
        except OSError as error:
            file_size_limit_enforced = error.errno == errno.EFBIG
    finally:
        os.close(size_fd)
        os.unlink(size_path)

    opened_fds = []
    open_files_limit_enforced = False
    try:
        while True:
            try:
                opened_fds.append(os.open("/dev/null", os.O_RDONLY))
            except OSError as error:
                open_files_limit_enforced = error.errno == errno.EMFILE
                break
    finally:
        for fd in opened_fds:
            os.close(fd)

    current_bytes = current_virtual_bytes()
    address_space_limit_enforced = (INITIAL_VIRTUAL_BYTES is not None and current_bytes is not None and
        INITIAL_VIRTUAL_BYTES <= LIMITS["addressSpaceBytes"] and current_bytes <= LIMITS["addressSpaceBytes"])
    try:
        mapping = mmap.mmap(-1, LIMITS["addressSpaceBytes"] + 1)
    except OSError as error:
        address_space_limit_enforced = address_space_limit_enforced and error.errno == errno.ENOMEM
    else:
        address_space_limit_enforced = False
        mapping.close()
    return {"fileSizeLimitEnforced": file_size_limit_enforced,
        "openFilesLimitEnforced": open_files_limit_enforced, "addressSpaceLimitEnforced": address_space_limit_enforced}

def cpu_probe():
    signal.signal(signal.SIGXCPU, signal.SIG_DFL)
    resource.setrlimit(resource.RLIMIT_CPU, (1, 2))
    while True:
        pass

def exact_keys(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)

def apply_fixture():
    with open(os.environ["SKILLOPT_INPUT_PATH"], "rb") as stream:
        fixture = json.loads(stream.read(8 * 1024 * 1024 + 1))
    if not exact_keys(fixture, ("task", "sources", "outputSlots")) or not isinstance(fixture["outputSlots"], list):
        raise ValueError("fixture protocol invalid")
    if not 1 <= len(fixture["outputSlots"]) <= FIXTURE_RESULT_POLICY["maxSlots"]:
        raise ValueError("fixture slots invalid")
    raw = sys.stdin.buffer.readline(LIMITS["messageBytes"] + 1)
    if len(raw) > LIMITS["messageBytes"] or not raw.endswith(b"\n") or sys.stdin.buffer.read(1):
        raise ValueError("fixture IPC invalid")
    message = json.loads(raw)
    if not exact_keys(message, ("schema", "writes")) or message["schema"] != "skillopt.native-wiki-output.v1" or not isinstance(message["writes"], list):
        raise ValueError("fixture output protocol invalid")
    slots = {}
    for slot in fixture["outputSlots"]:
        if not exact_keys(slot, ("id", "kind", "existingContent")) or not isinstance(slot["id"], str) or slot["id"] in slots:
            raise ValueError("fixture slots invalid")
        slot_id = slot["id"]
        if (not slot_id.isascii() or not 1 <= len(slot_id) <= 64 or not slot_id[0].isalnum() or
            any(not (character.isalnum() or character in "_-") for character in slot_id) or
            not isinstance(slot["kind"], str) or slot["kind"] not in FIXTURE_RESULT_POLICY["outputKinds"] or
            not isinstance(slot["existingContent"], str)):
            raise ValueError("fixture slots invalid")
        slots[slot_id] = {"id": slot_id, "kind": slot["kind"], "content": slot["existingContent"]}
    seen = set()
    response_content_bytes = 0
    for write in message["writes"]:
        if not exact_keys(write, ("slotId", "content")) or not isinstance(write["slotId"], str) or write["slotId"] not in slots or write["slotId"] in seen:
            raise ValueError("fixture writes invalid")
        if not isinstance(write["content"], str):
            raise ValueError("fixture writes invalid")
        content_bytes = len(write["content"].encode("utf-8"))
        response_content_bytes += content_bytes
        if response_content_bytes > FIXTURE_RESULT_POLICY["responseBytes"]:
            raise ValueError("fixture response content limit")
        seen.add(write["slotId"])
        slots[write["slotId"]]["content"] = write["content"]
    if not slots or seen != set(slots):
        raise ValueError("fixture write set invalid")
    result = {"schema": "skillopt.native-wiki-fixture-result.v1", "slots": [slots[key] for key in sorted(slots)]}
    encoded = (json.dumps(result, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
    result_bound = (FIXTURE_RESULT_POLICY["envelopeBytes"] +
        FIXTURE_RESULT_POLICY["slotOverheadBytes"] * len(slots) +
        sum(len(slot_id.encode("ascii")) + len(slots[slot_id]["kind"].encode("ascii")) for slot_id in slots) +
        FIXTURE_RESULT_POLICY["contentEscapeExpansion"] * FIXTURE_RESULT_POLICY["responseBytes"])
    if result_bound != int(os.environ["SKILLOPT_FIXTURE_RESULT_BYTES"]) or len(encoded) > result_bound:
        raise ValueError("fixture result byte bound")
    fd = os.open(os.environ["SKILLOPT_OUTPUT_PATH"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        view = memoryview(encoded)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError(errno.EIO, "short fixture output write")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)
    print(json.dumps({"ok": True, "sha256": hashlib.sha256(encoded).hexdigest()}, separators=(",", ":")))

def probe(args):
    _, home_path, worktree_path, production_path, output_path, address, port = args
    input_path = os.environ["SKILLOPT_INPUT_PATH"]
    with open(input_path, "rb") as stream:
        input_ok = bool(stream.read(1))
    output_marker = output_path
    with open(output_marker, "xb") as stream:
        stream.write(PROBE_OUTPUT_MARKER.encode("ascii"))
        stream.flush()
        os.fsync(stream.fileno())
    private_output_writable = stat.S_IMODE(os.stat(output_marker, follow_symlinks=False).st_mode) == 0o600
    home_denied = denied_read(home_path) and denied_write(home_path)
    worktree_denied = denied_read(worktree_path) and denied_write(worktree_path)
    production_denied = denied_read(production_path)
    write_denied = denied_write(production_path)
    network_denied = False
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
            connection.settimeout(0.5)
            connection.connect((address, int(port)))
    except OSError:
        network_denied = True
    subprocess_denied = False
    try:
        child = os.fork()
        if child == 0:
            os._exit(0)
        os.waitpid(child, 0)
    except OSError as error:
        subprocess_denied = error.errno in (errno.EPERM, errno.EACCES, errno.ENOSYS)
    thread_creation_works = False
    try:
        import threading
        completed = []
        thread = threading.Thread(target=lambda: completed.append(True))
        thread.start()
        thread.join(timeout=2)
        thread_creation_works = not thread.is_alive() and completed == [True]
    except (OSError, RuntimeError, ValueError):
        thread_creation_works = False
    resource_probes = resource_behavior_probe(output_marker)
    print(json.dumps({"selectedInputReadable": input_ok, "privateOutputWritable": private_output_writable,
        "homeSentinelDenied": home_denied, "worktreeSentinelDenied": worktree_denied,
        "productionSentinelDenied": production_denied and write_denied, "networkDenied": network_denied,
        "subprocessDenied": subprocess_denied, "threadCreationWorks": thread_creation_works,
        **resource_probes}, separators=(",", ":")))

try:
    impose_limits()
except (AttributeError, OSError, OverflowError, ValueError):
    raise SystemExit(91)
try:
    impose_linux_filter()
except (AttributeError, OSError, OverflowError, ValueError):
    raise SystemExit(92)
arguments = sys.argv[1:]
if not arguments:
    raise SystemExit(90)
mode = arguments[0]
if mode == "probe":
    probe(arguments)
elif mode == "trainer":
    if len(arguments) != 6:
        raise SystemExit(90)
    runner, source_lock, manifest, native_proof, native_proof_sha256 = arguments[1:]
    sys.argv = [runner, "optimize-native", "--source-lock", source_lock, "--manifest", manifest,
        "--runtime-proof", native_proof, "--runtime-proof-sha256", native_proof_sha256]
    runpy.run_path(runner, run_name="__main__")
elif mode == "verify-native-runtime":
    if len(arguments) != 5:
        raise SystemExit(90)
    runner, source_lock, native_proof, native_proof_sha256 = arguments[1:]
    sys.argv = [runner, "verify-native-runtime", "--source-lock", source_lock,
        "--runtime-proof", native_proof, "--runtime-proof-sha256", native_proof_sha256]
    runpy.run_path(runner, run_name="__main__")
elif mode == "cpu-probe":
    cpu_probe()
elif mode == "fixture-apply":
    apply_fixture()
else:
    raise SystemExit(90)
`

function workerPlatform(): SkillOptWorkerPlatform {
  if (process.platform === "darwin" || process.platform === "linux") return process.platform
  workerFail("containment_unavailable")
}

function sandboxExecutable(): Readonly<{ path: string; identity: NativeFileIdentity }> {
  const platform = workerPlatform()
  if (platform === "darwin") return { path: "/usr/bin/sandbox-exec", identity: stableWorkerFile("/usr/bin/sandbox-exec", 16 * 1024 * 1024, true) }
  const found = Bun.which("bwrap")
  const candidate = found ?? join(realpathSync.native(homedir()), ".cache/otter-skillopt-build-tools/root/usr/bin/bwrap")
  let path: string
  try { path = realpathSync.native(candidate) } catch { return workerFail("bwrap_unavailable") }
  if (!found && path !== candidate) workerFail("bwrap_path_noncanonical")
  return { path, identity: stableWorkerFile(path, 16 * 1024 * 1024, true) }
}

function buildDarwinProfile(profile: Pick<InternalWorkerProfile,
  "role" | "executablePath" | "executableRealpath" | "inputPath" | "output" | "emptyHome" |
  "runtimeRoot" | "runtimeBaseRoot" | "nativeRuntimeProofPath" | "sourceFiles">): string {
  const quote = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  const rules = [
    "(version 1)", "(deny default)", `(allow process-exec (literal ${quote(profile.executablePath)}))`,
    ...(profile.executableRealpath !== profile.executablePath ? [`(allow process-exec (literal ${quote(profile.executableRealpath)}))`] : []),
    "(deny process-fork)", "(allow sysctl-read)", "(allow file-read-metadata (subpath \"/\"))",
    "(allow file-read-data (literal \"/\"))",
    "(allow file-read* (subpath \"/System/Library\"))", "(allow file-map-executable (subpath \"/System/Library\"))",
    "(allow file-read* (subpath \"/usr/lib\"))", "(allow file-map-executable (subpath \"/usr/lib\"))",
    `(allow file-read* (literal ${quote(profile.executablePath)}))`,
    `(allow file-read* (literal ${quote(profile.executableRealpath)}))`,
    `(allow file-map-executable (literal ${quote(profile.executableRealpath)}))`,
    `(allow file-read* (literal ${quote(profile.inputPath)}))`,
    `(allow file-write* (subpath ${quote(profile.output.path)}))`,
    `(allow file-read* (subpath ${quote(profile.output.path)}))`,
    `(allow file-read* (subpath ${quote(profile.emptyHome.path)}))`,
  ]
  if (profile.role === "trainer") rules.push(`(deny file-write* (literal ${quote(join(profile.output.path, "protocol.json"))}))`)
  if (profile.runtimeRoot) {
    rules.push(`(allow file-read* (subpath ${quote(profile.runtimeRoot.path)}))`)
    rules.push(`(allow file-map-executable (subpath ${quote(profile.runtimeRoot.path)}))`)
  }
  if (profile.runtimeBaseRoot) {
    rules.push(`(allow file-read* (subpath ${quote(profile.runtimeBaseRoot.path)}))`)
    rules.push(`(allow file-map-executable (subpath ${quote(profile.runtimeBaseRoot.path)}))`)
  }
  if (profile.nativeRuntimeProofPath) rules.push(`(allow file-read* (literal ${quote(profile.nativeRuntimeProofPath)}))`)
  for (const source of profile.sourceFiles) rules.push(`(allow file-read* (literal ${quote(source.path)}))`)
  return rules.join("\n")
}

function validateProfileInput(input: WorkerProfileInput): InternalWorkerProfile {
  if (!isWorkerObject(input) || (input.role !== "trainer" && input.role !== "fixture")) workerFail("worker_profile_input_invalid")
  const inputKeys = ["role", "executablePath", "selectedInputPath", "outputDirectory", "emptyHomeDirectory", "probeDirectory",
    "nativeRuntimeProofPath", ...(input.role === "trainer" ? ["adapterManifestPath", "protocolStageAllowance"] : [])]
  if (!exactWorkerKeys(input, inputKeys) ||
      ![input.executablePath, input.nativeRuntimeProofPath, input.selectedInputPath, input.outputDirectory,
        input.emptyHomeDirectory, input.probeDirectory].every((path) => typeof path === "string")) {
    workerFail("worker_profile_input_invalid")
  }
  if (input.role === "trainer" && (typeof input.adapterManifestPath !== "string" ||
      !input.protocolStageAllowance || typeof input.protocolStageAllowance !== "object")) {
    workerFail("worker_profile_input_invalid")
  }
  const platform = workerPlatform()
  const executablePath = input.executablePath
  if (!isAbsolute(executablePath) || executablePath !== resolve(executablePath)) workerFail("worker_executable_path_invalid")
  const runtimePath = resolve(dirname(dirname(executablePath)))
  const expectedProofPath = resolve(dirname(runtimePath), "native-runtime-proof.json")
  if (input.nativeRuntimeProofPath !== expectedProofPath || input.nativeRuntimeProofPath !== resolve(input.nativeRuntimeProofPath)) {
    workerFail("native_runtime_proof_path_invalid")
  }
  const executableRealpath = realpathSync.native(executablePath)
  const executableInvocation = executableInvocationIdentity(executablePath, executableRealpath)
  const sourceFiles: { path: string; identity: NativeFileIdentity }[] = WORKER_SOURCE_PATHS.map((relativePath) => {
    const path = resolve(REPO_ROOT, relativePath)
    return { path, identity: stableWorkerFile(path, relativePath.endsWith("dataset.ts") ? 2 * 1024 * 1024 : 8 * 1024 * 1024) }
  })
  const adapterManifestPath = input.role === "trainer" ? input.adapterManifestPath : undefined
  const adapterManifest = adapterManifestPath
    ? privateAdapterManifestFile(adapterManifestPath, sourceFiles[1]!.identity.contentSha256)
    : undefined
  const adapterManifestIdentity = adapterManifest?.identity
  const adapterManifestStageMetadata = input.role === "trainer"
    ? nativeTrainerProtocolStageAllowanceMetadata(input.protocolStageAllowance)
    : undefined
  if (input.role === "trainer") {
    let manifestValue: unknown
    try { manifestValue = JSON.parse(adapterManifestIdentity!.bytes.toString("utf8")) }
    catch { workerFail("adapter_manifest_invalid") }
    if (!isWorkerObject(manifestValue) || !adapterManifestIdentity || !adapterManifestStageMetadata ||
        manifestValue.runId !== adapterManifestStageMetadata.runId ||
        adapterManifestIdentity.contentSha256 !== adapterManifestStageMetadata.manifestSha256 ||
        adapterManifestIdentity.bytes.byteLength !== adapterManifestStageMetadata.manifestBytes) {
      workerFail("worker_adapter_manifest_stage_unreserved")
    }
  }
  const executable = stableWorkerFile(executableRealpath, 512 * 1024 * 1024)
  if ((executable.mode & 0o111) === 0) workerFail("worker_executable_not_executable")
  let runtimeRoot: DirectoryIdentity | undefined
  let runtimeBinRoot: DirectoryIdentity | undefined
  let runtimeBaseRoot: DirectoryIdentity | undefined
  let nativeRuntimeProofPath: string | undefined
  let nativeRuntimeProofIdentity: NativeFileIdentity | undefined
  let nativeRuntimeProofParent: DirectoryIdentity | undefined
  let runtimeBinding: WorkerRuntimeIdentity
  {
    const suffix = ["skillopt", "runtime", PINNED_SKILLOPT_COMMIT, "venv", "bin", "python"]
    if (executablePath.split(sep).slice(-suffix.length).join(sep) !== suffix.join(sep)) workerFail("python_runtime_not_pinned")
    const runtimeBinPath = dirname(executablePath)
    if (realpathSync.native(runtimeBinPath) !== runtimeBinPath) workerFail("python_runtime_unsafe")
    const runtimeBinStat = lstatSync(runtimeBinPath, { bigint: true })
    if (!runtimeBinStat.isDirectory() || runtimeBinStat.isSymbolicLink() || runtimeBinStat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (runtimeBinStat.mode & 0o022n) !== 0n) workerFail("python_runtime_unsafe")
    runtimeBinRoot = { path: runtimeBinPath, dev: String(runtimeBinStat.dev), ino: String(runtimeBinStat.ino), uid: String(runtimeBinStat.uid), mode: Number(runtimeBinStat.mode & 0o7777n) }
    if (realpathSync.native(runtimePath) !== runtimePath) workerFail("python_runtime_unsafe")
    const runtimeStat = lstatSync(runtimePath, { bigint: true })
    if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || runtimeStat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (runtimeStat.mode & 0o022n) !== 0n) workerFail("python_runtime_unsafe")
    runtimeRoot = { path: runtimePath, dev: String(runtimeStat.dev), ino: String(runtimeStat.ino), uid: String(runtimeStat.uid), mode: Number(runtimeStat.mode & 0o7777n) }
    const config = stableWorkerFile(join(runtimePath, "pyvenv.cfg"), 16 * 1024)
    const homeMatch = /^home\s*=\s*([^\r\n]+)$/mu.exec(config.bytes.toString("utf8"))
    if (!homeMatch) workerFail("python_runtime_base_unverified")
    const baseBin = realpathSync.native(homeMatch[1]!)
    const homeStat = lstatSync(baseBin, { bigint: true })
    const basePath = resolve(dirname(baseBin))
    const baseStat = lstatSync(basePath, { bigint: true })
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || !baseStat.isDirectory() || baseStat.isSymbolicLink() || (baseStat.mode & 0o022n) !== 0n ||
        !contained(runtimeRoot.path, executableRealpath) || contained(homedir(), basePath) || contained(basePath, homedir()) ||
        contained(REPO_ROOT, basePath) ||
        contained(basePath, REPO_ROOT) || contained(basePath, runtimeRoot.path) || contained(runtimeRoot.path, basePath)) {
      workerFail("python_runtime_base_unsafe")
    }
    runtimeBaseRoot = { path: basePath, dev: String(baseStat.dev), ino: String(baseStat.ino), uid: String(baseStat.uid), mode: Number(baseStat.mode & 0o7777n) }
    if (!runtimeBaseRoot) workerFail("python_runtime_base_unverified")
    const runtimeAttestation = nativeRuntimeAttestation(input.nativeRuntimeProofPath, expectedProofPath, runtimeRoot,
      runtimeBaseRoot, executablePath, executableRealpath, executable, platform, sourceFiles)
    nativeRuntimeProofPath = input.nativeRuntimeProofPath
    nativeRuntimeProofIdentity = runtimeAttestation.identity
    nativeRuntimeProofParent = runtimeAttestation.parent
    runtimeBinding = runtimeAttestation.runtime
  }

  const selectedFile = privateInputFile(input.selectedInputPath, input.role)
  let fixtureResultByteBound: number | undefined
  if (input.role === "fixture") {
    let fixtureInput: unknown
    try { fixtureInput = JSON.parse(selectedFile.bytes.toString("utf8")) }
    catch { workerFail("worker_input_invalid_json") }
    if (!isWorkerObject(fixtureInput) || !Array.isArray(fixtureInput.outputSlots)) workerFail("fixture_input_invalid")
    fixtureResultByteBound = nativeSkillOptFixtureResultByteBound(fixtureInput.outputSlots as { id: string; kind: string }[])
  }
  if (input.role === "trainer" && (!adapterManifestStageMetadata ||
      adapterManifestStageMetadata.projectionSha256 !== selectedFile.contentSha256 ||
      adapterManifestStageMetadata.projectionBytes !== selectedFile.bytes.byteLength)) {
    workerFail("worker_trainer_projection_unreserved")
  }
  const output = canonicalOwnedDirectory(input.outputDirectory, "worker_output", true)
  const emptyHome = canonicalOwnedDirectory(input.emptyHomeDirectory, "worker_home", true)
  const probeRoot = canonicalOwnedDirectory(input.probeDirectory, "worker_probe", true)
  const privateDirs = [output.path, emptyHome.path, probeRoot.path]
  if (new Set(privateDirs).size !== privateDirs.length || privateDirs.some((path, index) =>
      privateDirs.some((other, otherIndex) => index !== otherIndex && (contained(path, other) || contained(other, path))))) {
    workerFail("worker_private_directories_overlap")
  }
  if (contained(REPO_ROOT, input.selectedInputPath) || contained(REPO_ROOT, output.path) || contained(REPO_ROOT, emptyHome.path) || contained(REPO_ROOT, probeRoot.path)) {
    workerFail("worker_private_data_in_worktree")
  }
  if (!runtimeRoot || !runtimeBinRoot || !nativeRuntimeProofPath || !nativeRuntimeProofIdentity ||
      !nativeRuntimeProofParent || !runtimeBaseRoot) {
    workerFail("worker_runtime_missing")
  }
  if (contained(REPO_ROOT, runtimeRoot.path) || contained(runtimeRoot.path, REPO_ROOT)) {
    workerFail("worker_runtime_overlaps_worktree")
  }
  const privateRuntimePaths = [input.selectedInputPath, output.path, emptyHome.path, probeRoot.path,
    ...(adapterManifestPath ? [adapterManifestPath] : [])]
  if (privateRuntimePaths.some((path) => contained(runtimeRoot.path, path) || contained(path, runtimeRoot.path) ||
      contained(nativeRuntimeProofPath, path) || contained(path, nativeRuntimeProofPath) ||
      contained(runtimeBaseRoot.path, path) || contained(path, runtimeBaseRoot.path))) {
    workerFail("worker_runtime_overlaps_private_data")
  }
  if (contained(output.path, input.selectedInputPath) || contained(emptyHome.path, input.selectedInputPath) || contained(probeRoot.path, input.selectedInputPath)) {
    workerFail("worker_input_overlap")
  }
  if (adapterManifestPath && (adapterManifestPath === input.selectedInputPath || contained(REPO_ROOT, adapterManifestPath) ||
      [output.path, emptyHome.path, probeRoot.path].some((directory) =>
        contained(directory, adapterManifestPath) || contained(adapterManifestPath, directory)))) {
    workerFail("worker_adapter_manifest_overlap")
  }

  const { path: sandboxPath, identity: sandbox } = sandboxExecutable()
  const inputFs = filesystemIdentity(input.selectedInputPath)
  const outputFs = filesystemIdentity(output.path)
  const adapterManifestFs = adapterManifestPath ? filesystemIdentity(adapterManifestPath) : undefined
  const sourceBasis: { path: string; sha256: string; size: string }[] = sourceFiles.map(({ path, identity }) => ({
    path: relative(REPO_ROOT, path), sha256: identity.contentSha256, size: identity.size,
  }))
  sourceBasis.push({ path: "worker-bootstrap", sha256: sha256(PYTHON_WORKER_BOOTSTRAP), size: String(Buffer.byteLength(PYTHON_WORKER_BOOTSTRAP)) })
  const sourceSha256 = sha256(canonicalJson(sourceBasis))
  const policySha256 = platform === "darwin"
    ? sha256(buildDarwinProfile({ role: input.role, executablePath, executableRealpath, inputPath: input.selectedInputPath,
      output, emptyHome, runtimeRoot, runtimeBaseRoot, nativeRuntimeProofPath, sourceFiles }))
    : sha256(canonicalJson({ bwrap: identityView(sandbox), bootstrapSha256: sha256(PYTHON_WORKER_BOOTSTRAP),
      syscalls: LINUX_SYSCALLS, limits: WORKER_LIMITS, fixtureResultPolicy: FIXTURE_RESULT_POLICY,
      fixedEnvironment: WORKER_FIXED_ENVIRONMENT }))
  const profileData = {
    schema: WORKER_SCHEMA, role: input.role, platform, sourceSha256, inputSha256: selectedFile.contentSha256,
    inputPathSha256: sha256(input.selectedInputPath), outputPathSha256: sha256(output.path),
    homePathSha256: sha256(emptyHome.path), probePathSha256: sha256(probeRoot.path),
    adapterManifestPathSha256: adapterManifestPath ? sha256(adapterManifestPath) : null,
    adapterManifestSha256: adapterManifestIdentity?.contentSha256 ?? null,
    adapterManifestIdentity: adapterManifestIdentity ? identityView(adapterManifestIdentity) : null,
    adapterManifestFs: adapterManifestFs ?? null,
    adapterManifestParent: adapterManifest ? {
      dev: adapterManifest.parent.dev, ino: adapterManifest.parent.ino, uid: adapterManifest.parent.uid, mode: adapterManifest.parent.mode,
    } : null,
    executableInvocationPathSha256: sha256(executablePath),
    executableInvocationIdentitySha256: sha256(canonicalJson(executableInvocation)),
    fixedEnvironment: WORKER_FIXED_ENVIRONMENT,
    fixtureResultPolicy: input.role === "fixture" ? {
      ...FIXTURE_RESULT_POLICY, byteBound: fixtureResultByteBound!,
    } : null,
    executable: identityView(executable), sandbox: identityView(sandbox), inputFs, outputFs,
    output: { dev: output.dev, ino: output.ino }, emptyHome: { dev: emptyHome.dev, ino: emptyHome.ino },
    probeRoot: { dev: probeRoot.dev, ino: probeRoot.ino },
    runtime: runtimeBinding, runtimeIdentitySha256: sha256(canonicalJson(runtimeBinding)),
    runtimeRoot: { dev: runtimeRoot.dev, ino: runtimeRoot.ino, uid: runtimeRoot.uid, mode: runtimeRoot.mode },
    runtimeBin: { dev: runtimeBinRoot.dev, ino: runtimeBinRoot.ino, uid: runtimeBinRoot.uid, mode: runtimeBinRoot.mode },
    limits: WORKER_LIMITS, policySha256,
    runtimeBase: { dev: runtimeBaseRoot.dev, ino: runtimeBaseRoot.ino, uid: runtimeBaseRoot.uid, mode: runtimeBaseRoot.mode },
    runtimeBasePathSha256: sha256(runtimeBaseRoot.path),
    nativeRuntimeProofPathSha256: sha256(nativeRuntimeProofPath),
    nativeRuntimeProofSha256: nativeRuntimeProofIdentity.contentSha256,
    nativeRuntimeProofIdentity: identityView(nativeRuntimeProofIdentity),
    nativeRuntimeProofFs: filesystemIdentity(nativeRuntimeProofPath),
    nativeRuntimeProofParent: {
      dev: nativeRuntimeProofParent.dev, ino: nativeRuntimeProofParent.ino, uid: nativeRuntimeProofParent.uid, mode: nativeRuntimeProofParent.mode,
    },
  }
  const bindingWithoutProfile = {
    schema: WORKER_BINDING_SCHEMA, role: input.role, platform,
    profileSha256: "", sourceSha256, inputSha256: selectedFile.contentSha256,
    executable: identityView(executable), executableIdentitySha256: sha256(canonicalJson(identityView(executable))),
    adapterManifestSha256: adapterManifestIdentity?.contentSha256 ?? null,
    nativeRuntimeProofSha256: nativeRuntimeProofIdentity.contentSha256,
    runtime: runtimeBinding, runtimeIdentitySha256: sha256(canonicalJson(runtimeBinding)),
    resourceCaps: WORKER_LIMITS,
    filesystem: Object.freeze({ input: inputFs, output: outputFs, adapterManifest: adapterManifestFs ?? null,
      nativeRuntimeProof: filesystemIdentity(input.nativeRuntimeProofPath) }),
  } as const
  const profileSha256 = sha256(canonicalJson(profileData))
  const binding: SkillOptWorkerProfileBinding = Object.freeze({ ...bindingWithoutProfile, profileSha256 })
  const profile: SkillOptWorkerProfile = Object.freeze({ schema: WORKER_SCHEMA, binding })
  const internal: InternalWorkerProfile = {
    role: input.role, platform, executablePath, executableRealpath, executableIdentity: executable,
    executableInvocationIdentity: executableInvocation,
    inputPath: input.selectedInputPath, inputIdentity: selectedFile,
    ...(fixtureResultByteBound === undefined ? {} : { fixtureResultByteBound }),
    adapterManifestPath, adapterManifestIdentity, adapterManifestFs, adapterManifestParent: adapterManifest?.parent,
    ...(input.role === "trainer" ? { adapterManifestStageAllowance: input.protocolStageAllowance } : {}),
    ...(adapterManifestStageMetadata ? { adapterManifestStageMetadata } : {}),
    output, emptyHome, probeRoot,
    runtimeRoot, runtimeBinRoot, runtimeBaseRoot,
    nativeRuntimeProofPath, nativeRuntimeProofIdentity, nativeRuntimeProofParent, runtimeBinding,
    sandboxPath, sandboxIdentity: sandbox, sourceFiles, sourceSha256,
    inputFs, outputFs, binding, profile, launched: false,
  }
  if (platform === "darwin") internal.sandboxProfile = buildDarwinProfile(internal)
  workerProfiles.set(profile, internal)
  return internal
}

/** Prepares an unforgeable, one-use sandbox profile; it never launches a model or worker. */
export function prepareWorkerProfile(input: WorkerProfileInput): SkillOptWorkerProfile {
  try { return validateProfileInput(input).profile }
  catch (error) {
    if (error instanceof SkillOptWorkerError) throw error
    workerFail("worker_profile_unavailable")
  }
}

function readCurrentIdentity(path: string, maximumBytes: number): NativeFileIdentity {
  return stableWorkerFile(path, maximumBytes, true)
}

function revalidateProfile(internal: InternalWorkerProfile): void {
  if (internal.launched) workerFail("worker_profile_already_consumed")
  const executable = readCurrentIdentity(internal.executableRealpath, 512 * 1024 * 1024)
  const invocation = executableInvocationIdentity(internal.executablePath, internal.executableRealpath)
  const sandbox = readCurrentIdentity(internal.sandboxPath, 16 * 1024 * 1024)
  const input = stableWorkerFile(internal.inputPath, MAX_WORKER_INPUT_BYTES)
  const adapterManifest = internal.adapterManifestPath && internal.adapterManifestIdentity
    ? stableWorkerFile(internal.adapterManifestPath, MAX_ADAPTER_MANIFEST_BYTES)
    : undefined
  if (canonicalJson(identityView(executable)) !== canonicalJson(identityView(internal.executableIdentity)) ||
      canonicalJson(invocation) !== canonicalJson(internal.executableInvocationIdentity) ||
      canonicalJson(identityView(sandbox)) !== canonicalJson(identityView(internal.sandboxIdentity)) ||
      canonicalJson(identityView(input)) !== canonicalJson(identityView(internal.inputIdentity)) ||
      (adapterManifest !== undefined && canonicalJson(identityView(adapterManifest)) !== canonicalJson(identityView(internal.adapterManifestIdentity!))) ||
      input.contentSha256 !== internal.binding.inputSha256) workerFail("worker_profile_identity_drift")
  for (const source of internal.sourceFiles) {
    const current = stableWorkerFile(source.path, 8 * 1024 * 1024)
    if (canonicalJson(identityView(current)) !== canonicalJson(identityView(source.identity))) workerFail("worker_source_identity_drift")
  }
  if (!internal.nativeRuntimeProofPath || !internal.nativeRuntimeProofIdentity || !internal.nativeRuntimeProofParent) {
    workerFail("worker_runtime_proof_missing")
  }
  const nativeProof = stableWorkerFile(internal.nativeRuntimeProofPath, MAX_NATIVE_RUNTIME_PROOF_BYTES)
  if (canonicalJson(identityView(nativeProof)) !== canonicalJson(identityView(internal.nativeRuntimeProofIdentity)) ||
      ![0o400, 0o600].includes(nativeProof.mode & 0o7777)) workerFail("worker_runtime_proof_changed")
  for (const directory of [internal.output, internal.emptyHome, internal.probeRoot]) digestDirectory(directory)
  if (internal.adapterManifestParent) digestDirectory(internal.adapterManifestParent)
  digestDirectory(internal.nativeRuntimeProofParent)
  if (internal.runtimeRoot) {
    const current = lstatSync(internal.runtimeRoot.path, { bigint: true })
    if (!current.isDirectory() || current.isSymbolicLink() || String(current.dev) !== internal.runtimeRoot.dev ||
        String(current.ino) !== internal.runtimeRoot.ino || String(current.uid) !== internal.runtimeRoot.uid ||
        Number(current.mode & 0o7777n) !== internal.runtimeRoot.mode) workerFail("worker_runtime_changed")
  }
  if (internal.runtimeBinRoot) {
    const current = lstatSync(internal.runtimeBinRoot.path, { bigint: true })
    if (!current.isDirectory() || current.isSymbolicLink() || String(current.dev) !== internal.runtimeBinRoot.dev ||
        String(current.ino) !== internal.runtimeBinRoot.ino || String(current.uid) !== internal.runtimeBinRoot.uid ||
        Number(current.mode & 0o7777n) !== internal.runtimeBinRoot.mode) workerFail("worker_runtime_changed")
  }
  if (internal.runtimeBaseRoot) {
    const current = lstatSync(internal.runtimeBaseRoot.path, { bigint: true })
    if (!current.isDirectory() || current.isSymbolicLink() || String(current.dev) !== internal.runtimeBaseRoot.dev ||
        String(current.ino) !== internal.runtimeBaseRoot.ino || String(current.uid) !== internal.runtimeBaseRoot.uid ||
        Number(current.mode & 0o7777n) !== internal.runtimeBaseRoot.mode) workerFail("worker_runtime_changed")
  }
  if (canonicalJson(filesystemIdentity(internal.inputPath)) !== canonicalJson(internal.inputFs) ||
      canonicalJson(filesystemIdentity(internal.output.path)) !== canonicalJson(internal.outputFs) ||
      (internal.adapterManifestPath && canonicalJson(filesystemIdentity(internal.adapterManifestPath)) !== canonicalJson(internal.adapterManifestFs)) ||
      canonicalJson(filesystemIdentity(internal.nativeRuntimeProofPath)) !== canonicalJson(internal.binding.filesystem.nativeRuntimeProof)) {
    workerFail("worker_filesystem_changed")
  }
  if (readdirSync(internal.output.path).length || readdirSync(internal.emptyHome.path).length || readdirSync(internal.probeRoot.path).length) {
    workerFail("worker_private_directory_changed")
  }
}

function ensureMountDirectory(args: string[], destination: string, created: Set<string>, finalMode = "0555"): void {
  const components = destination.split(sep).filter(Boolean)
  let current = ""
  for (const component of components) {
    current = `${current}/${component}`
    if (!created.has(current)) {
      args.push("--perms", current === destination ? finalMode : "0555", "--dir", current)
      created.add(current)
    }
  }
}

function linuxRuntimeGuestRoot(profile: InternalWorkerProfile): string {
  return profile.runtimeRoot!.path
}

function linuxExecutableGuestPath(profile: InternalWorkerProfile): string {
  return profile.executablePath
}

function linuxWorkerPrefix(profile: InternalWorkerProfile, readonlyManifest = false): string[] {
  const args = [
    "--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
    "--cap-drop", "ALL", "--clearenv", "--setenv", "PATH", "", "--setenv", "HOME", "/worker/home",
    "--setenv", "TMPDIR", "/worker/output", "--setenv", "XDG_CONFIG_HOME", "/worker/home",
    "--setenv", "XDG_CACHE_HOME", "/worker/home", "--setenv", "XDG_DATA_HOME", "/worker/home",
    "--setenv", "XDG_STATE_HOME", "/worker/home", "--setenv", "SKILLOPT_INPUT_PATH", "/worker/input.json",
    "--setenv", "SKILLOPT_OUTPUT_PATH", "/worker/output/fixture-result.json",
    "--setenv", "SKILLOPT_WORKER_LIMITS", JSON.stringify(WORKER_LIMITS),
    "--setenv", "SKILLOPT_BLOCKED_SYSCALLS", JSON.stringify(LINUX_SYSCALLS),
    "--chdir", "/worker", "--proc", "/proc", "--dev", "/dev",
    "--perms", "0555", "--dir", "/worker",
  ]
  if (profile.fixtureResultByteBound !== undefined) {
    args.push("--setenv", "SKILLOPT_FIXTURE_RESULT_BYTES", String(profile.fixtureResultByteBound))
  }
  const created = new Set(["/", "/worker"])
  ensureMountDirectory(args, "/worker/home", created)
  ensureMountDirectory(args, "/worker/output", created)
  args.push("--ro-bind", profile.emptyHome.path, "/worker/home", "--bind", profile.output.path, "/worker/output",
    "--ro-bind", profile.inputPath, "/worker/input.json")
  if (readonlyManifest && profile.role === "trainer") {
    if (!profile.adapterManifestStagePath) workerFail("worker_adapter_manifest_stage_missing")
    args.push("--ro-bind", profile.adapterManifestStagePath, "/worker/output/protocol.json")
  }
  if (!profile.runtimeRoot || !profile.nativeRuntimeProofPath || !profile.runtimeBaseRoot) workerFail("worker_runtime_missing")
  const guestRuntime = linuxRuntimeGuestRoot(profile)
  ensureMountDirectory(args, dirname(profile.nativeRuntimeProofPath), created, "0500")
  ensureMountDirectory(args, dirname(guestRuntime), created)
  ensureMountDirectory(args, guestRuntime, created)
  args.push("--ro-bind", profile.runtimeRoot.path, guestRuntime)
  args.push("--ro-bind", profile.nativeRuntimeProofPath, profile.nativeRuntimeProofPath)
  args.push("--setenv", "SKILLOPT_PYTHON", linuxExecutableGuestPath(profile))
  ensureMountDirectory(args, dirname(profile.runtimeBaseRoot.path), created)
  ensureMountDirectory(args, profile.runtimeBaseRoot.path, created)
  args.push("--ro-bind", profile.runtimeBaseRoot.path, profile.runtimeBaseRoot.path)
  const codeRoot = "/worker/code"
  ensureMountDirectory(args, join(codeRoot, "scripts"), created)
  for (const source of profile.sourceFiles) {
    const relativePath = relative(REPO_ROOT, source.path)
    const destination = join(codeRoot, relativePath)
    ensureMountDirectory(args, dirname(destination), created)
    args.push("--ro-bind", source.path, destination)
  }
  for (const sourcePath of ["/usr/lib", "/usr/lib64", "/lib", "/lib64"] as const) {
    if (profile.runtimeBaseRoot && contained(profile.runtimeBaseRoot.path, sourcePath)) continue
    try {
      const stat = lstatSync(sourcePath)
      if (!stat.isDirectory() && !stat.isSymbolicLink()) continue
      const source = realpathSync.native(sourcePath)
      const destination = sourcePath
      ensureMountDirectory(args, dirname(destination), created)
      ensureMountDirectory(args, destination, created)
      args.push("--ro-bind", source, destination)
    } catch { /* An absent alias is not required when another runtime library root is mounted. */ }
  }
  for (const [name, value] of Object.entries(WORKER_FIXED_ENVIRONMENT)) args.push("--setenv", name, value)
  return args
}

function workerEnvironment(profile: InternalWorkerProfile): NodeJS.ProcessEnv {
  const home = profile.platform === "linux" ? "/worker/home" : profile.emptyHome.path
  const inputPath = profile.platform === "linux" ? "/worker/input.json" : profile.inputPath
  const outputPath = profile.platform === "linux" ? "/worker/output/fixture-result.json" : join(profile.output.path, "fixture-result.json")
  const environment: NodeJS.ProcessEnv = {
    PATH: "", HOME: home, TMPDIR: profile.platform === "linux" ? "/worker/output" : profile.output.path,
    ...WORKER_FIXED_ENVIRONMENT,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
    SKILLOPT_INPUT_PATH: inputPath, SKILLOPT_OUTPUT_PATH: outputPath,
    SKILLOPT_WORKER_LIMITS: JSON.stringify(WORKER_LIMITS),
  }
  if (profile.fixtureResultByteBound !== undefined) {
    environment.SKILLOPT_FIXTURE_RESULT_BYTES = String(profile.fixtureResultByteBound)
  }
  environment.SKILLOPT_PYTHON = profile.platform === "linux" ? linuxExecutableGuestPath(profile) : profile.executablePath
  return environment
}

function pythonWorkerCommand(profile: InternalWorkerProfile,
  mode: "trainer" | "fixture-apply" | "probe" | "verify-native-runtime" | "cpu-probe",
  probeArgs: readonly string[] = []): {
  executable: string; args: string[]
} {
  if ((mode === "trainer" && profile.role !== "trainer") || (mode === "fixture-apply" && profile.role !== "fixture")) {
    workerFail("worker_role_operation_mismatch")
  }
  const runnerHost = profile.sourceFiles[0]?.path
  const sourceLockHost = profile.sourceFiles[1]?.path
  if (!runnerHost || !sourceLockHost) workerFail("worker_source_missing")
  const guestExecutable = profile.platform === "linux" ? linuxExecutableGuestPath(profile) : profile.executablePath
  const runner = profile.platform === "linux" ? "/worker/code/scripts/skillopt_runner.py" : runnerHost
  const sourceLock = profile.platform === "linux" ? "/worker/code/scripts/skillopt-source-lock.json" : sourceLockHost
  const manifest = profile.platform === "linux" ? "/worker/output/protocol.json" : join(profile.output.path, "protocol.json")
  if (!profile.nativeRuntimeProofPath || !profile.nativeRuntimeProofIdentity) workerFail("worker_runtime_proof_missing")
  const nativeProofPath = profile.nativeRuntimeProofPath
  const nativeProofSha256 = profile.nativeRuntimeProofIdentity.contentSha256
  const tail = mode === "trainer" ? ["trainer", runner, sourceLock, manifest, nativeProofPath, nativeProofSha256]
    : mode === "verify-native-runtime" ? ["verify-native-runtime", runner, sourceLock, nativeProofPath, nativeProofSha256]
      : mode === "cpu-probe" ? ["cpu-probe"]
        : mode === "fixture-apply" ? ["fixture-apply"]
          : ["probe", ...probeArgs]
  const command = [guestExecutable, "-I", "-S", "-B", "-c", PYTHON_WORKER_BOOTSTRAP, ...tail]
  if (profile.platform === "darwin") return { executable: profile.sandboxPath, args: ["-p", profile.sandboxProfile!, ...command] }
  return { executable: profile.sandboxPath, args: [...linuxWorkerPrefix(profile, mode === "trainer"), "--", ...command] }
}

function parseProbeOutput(output: string): WorkerProbeOutput | null {
  if (!output.endsWith("\n") || output.indexOf("\n") !== output.length - 1) return null
  let value: unknown
  try { value = JSON.parse(output.slice(0, -1)) } catch { return null }
  const keys = ["selectedInputReadable", "privateOutputWritable", "homeSentinelDenied", "worktreeSentinelDenied",
    "productionSentinelDenied", "networkDenied", "subprocessDenied", "threadCreationWorks", "fileSizeLimitEnforced",
    "openFilesLimitEnforced", "addressSpaceLimitEnforced"]
  if (!isWorkerObject(value) || !exactWorkerKeys(value, keys) || !keys.every((key) => typeof value[key] === "boolean")) return null
  return value as WorkerProbeOutput
}

function privateProbeWorkspace(root: DirectoryIdentity, outputDirectory: DirectoryIdentity): {
  path: string; identity: DirectoryIdentity; homeSentinel: string; worktreeSentinel: string; productionSentinel: string; outputMarker: string
} {
  digestDirectory(root)
  const path = mkdtempSync(join(root.path, ".skillopt-containment-"))
  mkdirSync(join(path, "home"), { mode: 0o700 })
  mkdirSync(join(path, "worktree", ".agents", "skills", "llm-wiki"), { recursive: true, mode: 0o700 })
  const homeSentinel = join(path, "home", "credential-sentinel")
  const worktreeSentinel = join(path, "worktree", "worktree-sentinel")
  const productionSentinel = join(path, "worktree", ".agents", "skills", "llm-wiki", "SKILL.md")
  const sentinelPaths = { home: homeSentinel, worktree: worktreeSentinel, production: productionSentinel }
  for (const target of WORKER_PROBE_SENTINEL_TARGETS) {
    writeFileSync(sentinelPaths[target], randomBytes(WORKER_PROBE_SENTINEL_BYTES), { flag: "wx", mode: 0o600 })
  }
  const identity = canonicalOwnedDirectory(path, "worker_probe_workspace", false)
  return {
    path, identity, homeSentinel, worktreeSentinel, productionSentinel,
    outputMarker: join(outputDirectory.path, `.skillopt-probe-marker-${randomBytes(8).toString("hex")}`),
  }
}

async function openLoopbackProbe(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((socket) => socket.destroy())
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") workerFail("containment_probe_listener_failed")
  return { server, port: address.port }
}

function spawnContainmentProbe(profile: InternalWorkerProfile, workspace: ReturnType<typeof privateProbeWorkspace>, port: number): {
  stdout: string; stderr: string; status: number | null; error?: NodeJS.ErrnoException
} {
  const workerOutputMarker = profile.platform === "linux"
    ? join("/worker/output", workspace.outputMarker.slice(workspace.outputMarker.lastIndexOf(sep) + 1))
    : workspace.outputMarker
  const probeArgs = [workspace.homeSentinel, workspace.worktreeSentinel, workspace.productionSentinel,
    workerOutputMarker, "127.0.0.1", String(port)]
  const command = pythonWorkerCommand(profile, "probe", probeArgs)
  const result = spawnSync(command.executable, command.args, {
    encoding: "utf8", timeout: WORKER_PROBE_TIMEOUT_MS, maxBuffer: WORKER_PROBE_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
    env: profile.platform === "linux" ? { PATH: "" } : workerEnvironment(profile),
  })
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status, ...(result.error ? { error: result.error } : {}) }
}

function spawnCpuLimitProbe(profile: InternalWorkerProfile): boolean {
  const command = pythonWorkerCommand(profile, "cpu-probe")
  const environment = workerEnvironment(profile)
  const result = spawnSync(command.executable, command.args, {
    encoding: "utf8", timeout: WORKER_CPU_PROBE_TIMEOUT_MS, maxBuffer: WORKER_PROBE_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
    env: profile.platform === "linux" ? { PATH: "" } : environment,
  })
  if (result.error || result.stdout !== "" || result.stderr !== "") return false
  if (result.signal === "SIGXCPU") return result.status === null
  return profile.platform === "linux" && result.status === 128 + osConstants.signals.SIGXCPU && result.signal === null
}

function spawnRuntimeVerification(profile: InternalWorkerProfile): boolean {
  const command = pythonWorkerCommand(profile, "verify-native-runtime")
  const result = spawnSync(command.executable, command.args, {
    encoding: "utf8", timeout: WORKER_PROBE_TIMEOUT_MS, maxBuffer: WORKER_PROBE_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
    env: profile.platform === "linux" ? { PATH: "" } : workerEnvironment(profile),
  })
  if (result.error || result.status !== 0 || result.signal || result.stderr !== "") return false
  if (!result.stdout.endsWith("\n") || result.stdout.indexOf("\n") !== result.stdout.length - 1) return false
  try {
    const output = JSON.parse(result.stdout.slice(0, -1)) as Record<string, unknown>
    const runtime = profile.runtimeBinding
    const keys = ["schema", "ok", "claim", "nativeRuntimeProofSha256", "sourceLockSha256", "dependencyLockSha256", "upstreamCommit",
      "upstreamVersion", "importManifestSha256", "licenseSha256", "installedDependencyFingerprintSha256", "pythonVersion",
      "pythonSha256", "platform", "wheelOriginStatus"]
    return runtime.kind === "python" && exactWorkerKeys(output, keys) &&
      output.schema === "skillopt.native-runtime-verification.v1" && output.ok === true &&
      output.claim === "verified_against_observed_local_runtime_pin" &&
      output.nativeRuntimeProofSha256 === runtime.nativeRuntimeProofSha256 &&
      output.sourceLockSha256 === runtime.sourceLockSha256 && output.dependencyLockSha256 === runtime.dependencyLockSha256 &&
      output.upstreamCommit === runtime.upstreamCommit && output.upstreamVersion === runtime.upstreamVersion &&
      output.importManifestSha256 === runtime.importManifestSha256 && output.licenseSha256 === runtime.licenseSha256 &&
      output.installedDependencyFingerprintSha256 === runtime.installedDependencyFingerprintSha256 &&
      output.pythonSha256 === runtime.executableSha256 && output.pythonVersion === runtime.version &&
      output.platform === (profile.platform === "darwin" ? "darwin" : "linux") && output.wheelOriginStatus === "unobserved"
  } catch { return false }
}

function cleanProbeArtifacts(profile: InternalWorkerProfile, workspace: ReturnType<typeof privateProbeWorkspace>): void {
  try {
    const marker = stableWorkerFile(workspace.outputMarker, WORKER_PROBE_OUTPUT_MARKER_BYTES)
    if (marker.bytes.byteLength === WORKER_PROBE_OUTPUT_MARKER_BYTES &&
        marker.bytes.toString("ascii") === WORKER_PROBE_OUTPUT_MARKER) rmSync(workspace.outputMarker)
    else workerFail("containment_probe_output_invalid")
  } catch { /* Nothing was created. */ }
  try {
    const status = lstatSync(workspace.path, { bigint: true })
    if (status.isDirectory() && status.nlink >= 1n && String(status.dev) === workspace.identity.dev && String(status.ino) === workspace.identity.ino &&
        status.uid === BigInt(process.getuid?.() ?? -1)) rmSync(workspace.path, { recursive: true })
  } catch { /* Probe cleanup failure leaves only owned scratch; probe is still blocked. */ }
  if (readdirSync(profile.output.path).length !== 0) workerFail("containment_probe_cleanup_failed")
}

/** Runs actual role-specific filesystem, network, subprocess, and resource-limit probes. */
export async function probeWorkerContainment(profile: SkillOptWorkerProfile): Promise<SkillOptContainmentReceipt> {
  const internal = workerProfiles.get(profile)
  if (!internal || internal.profile !== profile) workerFail("worker_profile_unowned")
  if (internal.receipt) workerFail("worker_profile_already_probed")
  try { revalidateProfile(internal) } catch {
    const receipt = Object.freeze({ schema: WORKER_RECEIPT_SCHEMA, status: "BLOCKED" as const,
      code: "worker_profile_drift", bindingSha256: internal.binding.profileSha256, resourceCaps: WORKER_LIMITS,
      probes: { selectedInputReadable: false, privateOutputWritable: false,
        homeSentinelDenied: false, worktreeSentinelDenied: false,
        productionSentinelDenied: false, networkDenied: false, subprocessDenied: false, threadCreationWorks: false, fileSizeLimitEnforced: false,
        openFilesLimitEnforced: false, addressSpaceLimitEnforced: false, cpuLimitEnforced: false, resourceCapsEnforced: false } })
    internal.receipt = receipt
    workerReceipts.set(receipt, internal)
    return receipt
  }
  let workspace: ReturnType<typeof privateProbeWorkspace> | undefined
  let server: Awaited<ReturnType<typeof openLoopbackProbe>> | undefined
  let probes: SkillOptContainmentReceipt["probes"] | null = null
  let code = "containment_probe_failed"
  try {
    workspace = privateProbeWorkspace(internal.probeRoot, internal.output)
    server = await openLoopbackProbe()
    const result = spawnContainmentProbe(internal, workspace, server.port)
    if (!result.error && result.status === 91) code = "resource_limit_unenforced"
    const output = !result.error && result.status === 0 && result.stderr === "" ? parseProbeOutput(result.stdout) : null
    if (output) {
      const cpuLimitEnforced = spawnCpuLimitProbe(internal)
      const resourceCapsEnforced = output.fileSizeLimitEnforced && output.openFilesLimitEnforced &&
        output.addressSpaceLimitEnforced && cpuLimitEnforced
      probes = { ...output, cpuLimitEnforced, resourceCapsEnforced }
    }
    if (probes && !probes.resourceCapsEnforced) code = "resource_limit_unenforced"
    else if (probes && !Object.values(probes).every((value) => value)) code = "containment_probe_failed"
    else if (probes && !spawnRuntimeVerification(internal)) {
      probes = null
      code = "native_runtime_unverified"
    } else if (probes) code = "ok"
  } catch {
    code = "containment_probe_failed"
  } finally {
    if (server) {
      server.server.close()
      await once(server.server, "close").catch(() => undefined)
    }
    if (workspace) {
      try { cleanProbeArtifacts(internal, workspace) } catch { probes = null; code = "containment_probe_cleanup_failed" }
    }
  }
  const ready = probes !== null && Object.values(probes).every((value) => value === true)
  const receipt: SkillOptContainmentReceipt = Object.freeze({
    schema: WORKER_RECEIPT_SCHEMA, status: ready ? "READY" : "BLOCKED", code,
    bindingSha256: internal.binding.profileSha256, resourceCaps: WORKER_LIMITS,
    probes: probes ?? { selectedInputReadable: false, privateOutputWritable: false,
      homeSentinelDenied: false,
      worktreeSentinelDenied: false, productionSentinelDenied: false, networkDenied: false, subprocessDenied: false,
      threadCreationWorks: false, fileSizeLimitEnforced: false, openFilesLimitEnforced: false, addressSpaceLimitEnforced: false, cpuLimitEnforced: false,
      resourceCapsEnforced: false },
  })
  internal.receipt = receipt
  workerReceipts.set(receipt, internal)
  return receipt
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    return code === "EPERM"
  }
}

function signalWorkerGroup(pid: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-pid, signal); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    return false
  }
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)) }

function createReadOnlyAdapterManifestStage(profile: InternalWorkerProfile): NativeFileIdentity {
  if (profile.role !== "trainer" || !profile.adapterManifestIdentity) workerFail("worker_role_operation_mismatch")
  const path = join(profile.output.path, "protocol.json")
  writeFileSync(path, profile.adapterManifestIdentity.bytes, { flag: "wx", mode: 0o400 })
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC)
  try { fsyncSync(fd) } finally { closeSync(fd) }
  const staged = stableWorkerFile(path, MAX_ADAPTER_MANIFEST_BYTES)
  if (staged.contentSha256 !== profile.adapterManifestIdentity.contentSha256 || (staged.mode & 0o222) !== 0) {
    workerFail("worker_adapter_manifest_stage_invalid")
  }
  return staged
}

function removeReadOnlyAdapterManifestStage(profile: InternalWorkerProfile): boolean {
  const staged = profile.adapterManifestStage
  if (!staged) return true
  const path = profile.adapterManifestStagePath
  if (!path) return false
  try {
    const current = stableWorkerFile(path, MAX_ADAPTER_MANIFEST_BYTES)
    if (current.contentSha256 !== staged.contentSha256 || current.dev !== staged.dev || current.ino !== staged.ino ||
        current.uid !== staged.uid || current.mode !== staged.mode) return false
    rmSync(path)
    profile.adapterManifestStage = undefined
    profile.adapterManifestStagePath = undefined
    return true
  } catch { return false }
}

function groupGoneWithin(pid: number, duration: number): Promise<boolean> {
  return (async () => {
    const deadline = Date.now() + duration
    while (groupExists(pid) && Date.now() < deadline) await delay(25)
    return !groupExists(pid)
  })()
}

function spawnWorkerProcess(profile: InternalWorkerProfile, operation: TrustedWorkerOperation): {
  child: ChildProcessWithoutNullStreams; timeoutMs: number
} {
  let command: { executable: string; args: string[] }
  let environment: NodeJS.ProcessEnv
  if (operation === "trainer-native" && profile.role === "trainer") {
    command = pythonWorkerCommand(profile, "trainer")
    environment = workerEnvironment(profile)
  } else if (operation === "fixture-apply" && profile.role === "fixture") {
    command = pythonWorkerCommand(profile, "fixture-apply")
    environment = workerEnvironment(profile)
  } else workerFail("worker_role_operation_mismatch")
  if (profile.platform === "linux") environment = { PATH: "" }
  const child = spawn(command.executable, command.args, {
    cwd: profile.platform === "linux" ? "/" : profile.emptyHome.path,
    env: environment,
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  return { child, timeoutMs: WORKER_TIMEOUT_MS }
}

/** Starts only a fixed role operation after rechecking the in-memory receipt, files, and owned directories. */
export function launchOwnedWorker(
  profile: SkillOptWorkerProfile,
  receipt: SkillOptContainmentReceipt,
  operation: TrustedWorkerOperation,
): OwnedWorkerHandle {
  const internal = workerProfiles.get(profile)
  if (!internal || internal.profile !== profile || workerReceipts.get(receipt) !== internal || internal.receipt !== receipt) {
    workerFail("worker_authority_unowned")
  }
  if (receipt.status !== "READY" || receipt.bindingSha256 !== internal.binding.profileSha256 || !Object.values(receipt.probes).every(Boolean)) {
    workerFail("containment_unavailable")
  }
  if ((operation === "trainer-native") !== (internal.role === "trainer") || (operation === "fixture-apply") !== (internal.role === "fixture")) {
    workerFail("worker_role_operation_mismatch")
  }
  revalidateProfile(internal)
  if (!spawnRuntimeVerification(internal)) workerFail("worker_runtime_identity_drift")
  if (internal.role === "trainer") {
    const stageAllowance = internal.adapterManifestStageAllowance
    const stageMetadata = internal.adapterManifestStageMetadata
    const manifest = internal.adapterManifestIdentity
    if (!stageAllowance || !stageMetadata || !manifest || Number(manifest.size) !== manifest.bytes.byteLength ||
        !HASH.test(manifest.contentSha256) || sha256(manifest.bytes) !== manifest.contentSha256 ||
        stageMetadata.manifestSha256 !== manifest.contentSha256 || stageMetadata.manifestBytes !== manifest.bytes.byteLength) {
      workerFail("worker_adapter_manifest_stage_unreserved")
    }
    try {
      consumeNativeTrainerProtocolStageAllowance(stageAllowance, stageMetadata)
    } catch { workerFail("worker_adapter_manifest_stage_unreserved") }
    internal.adapterManifestStageAllowance = undefined
  }
  internal.launched = true
  if (internal.role === "trainer") {
    internal.adapterManifestStagePath = join(internal.output.path, "protocol.json")
    internal.adapterManifestStage = createReadOnlyAdapterManifestStage(internal)
  }
  let child: ChildProcessWithoutNullStreams
  try { ({ child } = spawnWorkerProcess(internal, operation)) }
  catch {
    removeReadOnlyAdapterManifestStage(internal)
    workerFail("worker_start_failed")
  }
  const pid = child.pid
  const listeners = new Set<(value: Record<string, unknown>) => void>()
  const trainerProtocolListeners = new Set<(event: OwnedTrainerProtocolEvent) => void>()
  const stdoutHash = createHash("sha256")
  const stderrHash = createHash("sha256")
  let stdoutBytes = 0
  let stderrBytes = 0
  let pending = Buffer.alloc(0)
  let exitCode: number | null = null
  let exitSignal: NodeJS.Signals | null = null
  let leaderClosed = false
  let requestedStatus: OwnedWorkerResult["status"] | undefined
  let requestedErrorCode: string | undefined
  let stopTask: Promise<void> | undefined
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let outgoingBytes = 0
  let protocolError = false
  let trainerProtocolOrdinal = 0
  let resolveResult!: (result: OwnedWorkerResult) => void
  const resultPromise = new Promise<OwnedWorkerResult>((resolveResultPromise) => { resolveResult = resolveResultPromise })

  const finish = (status: OwnedWorkerResult["status"], quiescent: boolean, errorCode?: string) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    const stageClean = !quiescent || removeReadOnlyAdapterManifestStage(internal)
    const result: OwnedWorkerResult = Object.freeze({
      status: stageClean ? status : "failed", exitCode, signal: exitSignal, quiescent, stdoutBytes, stderrBytes,
      stdoutSha256: stdoutHash.digest("hex"), stderrSha256: stderrHash.digest("hex"),
      ...(stageClean ? (errorCode ? { errorCode } : {}) : { errorCode: "worker_manifest_cleanup_unverified" }),
    })
    workerResultProvenance.set(result, Object.freeze({ profile: internal.profile, receipt, operation }))
    resolveResult(result)
  }

  const stop = (status: OwnedWorkerResult["status"], errorCode: string): Promise<void> => {
    if (!requestedStatus) { requestedStatus = status; requestedErrorCode = errorCode }
    if (stopTask) return stopTask
    stopTask = (async () => {
      if (pid === undefined) {
        if (leaderClosed) finish(requestedStatus!, false, requestedErrorCode)
        return
      }
      signalWorkerGroup(pid, "SIGTERM")
      let gone = await groupGoneWithin(pid, WORKER_TERM_GRACE_MS)
      if (!gone) {
        signalWorkerGroup(pid, "SIGKILL")
        gone = await groupGoneWithin(pid, WORKER_KILL_GRACE_MS)
      }
      if (!gone) {
        finish("unresolved", false, "worker_quiescence_unverified")
        return
      }
      if (leaderClosed) finish(requestedStatus!, true, requestedErrorCode)
    })()
    return stopTask
  }

  const badProtocol = () => {
    if (protocolError || settled) return
    protocolError = true
    void stop("protocol_invalid", "worker_protocol_invalid")
  }

  const deliverLine = (line: Buffer) => {
    if (line.length === 0 || line.length > MAX_WORKER_MESSAGE_BYTES) { badProtocol(); return }
    let value: unknown
    try { value = JSON.parse(line.toString("utf8")) } catch { badProtocol(); return }
    if (!isWorkerObject(value)) { badProtocol(); return }
    if (operation === "trainer-native") {
      if (internal.role !== "trainer" || !internal.launched || internal.profile !== profile || internal.receipt !== receipt ||
          workerProfiles.get(profile) !== internal || workerReceipts.get(receipt) !== internal || receipt.status !== "READY" ||
          receipt.bindingSha256 !== internal.binding.profileSha256 || !Object.values(receipt.probes).every(Boolean)) {
        badProtocol()
        return
      }
      const rawLine = Buffer.from(line)
      const event = Object.freeze({}) as OwnedTrainerProtocolEvent
      const ordinal = ++trainerProtocolOrdinal
      ownedTrainerProtocolEvents.set(event, {
        profile, receipt, operation, profileSha256: internal.binding.profileSha256,
        receiptBindingSha256: receipt.bindingSha256, ordinal, rawLineSha256: sha256(rawLine), rawLine, used: false,
      })
      for (const listener of trainerProtocolListeners) {
        try { listener(event) } catch { badProtocol(); return }
      }
      return
    }
    for (const listener of listeners) {
      try { listener(value) } catch { badProtocol(); return }
    }
  }

  child.stdout.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    stdoutBytes += bytes.length
    stdoutHash.update(bytes)
    if (stdoutBytes > MAX_WORKER_STDOUT_BYTES) { void stop("output_limit", "worker_stdout_limit"); return }
    pending = Buffer.concat([pending, bytes])
    if (pending.length > MAX_WORKER_MESSAGE_BYTES && pending.indexOf(0x0a) < 0) { badProtocol(); return }
    for (;;) {
      const end = pending.indexOf(0x0a)
      if (end < 0) break
      deliverLine(pending.subarray(0, end))
      pending = pending.subarray(end + 1)
      if (settled) break
    }
  })

  child.stderr.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    stderrBytes += bytes.length
    stderrHash.update(bytes)
    if (stderrBytes > MAX_WORKER_STDERR_BYTES) void stop("output_limit", "worker_stderr_limit")
  })

  child.once("error", () => {
    requestedStatus ??= "failed"
    requestedErrorCode ??= "worker_start_failed"
  })

  child.once("close", (code, signal) => {
    leaderClosed = true
    exitCode = code
    exitSignal = signal
    if (timer) clearTimeout(timer)
    if (pending.length > 0 && !protocolError && !requestedStatus) badProtocol()
    void (async () => {
      const groupQuiescent = pid === undefined || await groupGoneWithin(pid, WORKER_EXIT_GROUP_SETTLE_MS)
      if (!groupQuiescent) {
        void stop(requestedStatus ?? "failed", requestedErrorCode ?? "worker_descendant_detected")
        return
      }
      finish(requestedStatus ?? (code === 0 ? "completed" : "failed"), true,
        requestedErrorCode ?? (code === 0 ? undefined : "worker_exit_nonzero"))
    })()
  })

  timer = setTimeout(() => { void stop("timed_out", "worker_deadline_exceeded") }, WORKER_TIMEOUT_MS)
  timer.unref?.()

  const handle: OwnedWorkerHandle = {
    binding: internal.binding,
    async writeMessage(value: unknown): Promise<void> {
      if (settled || child.stdin.destroyed || child.stdin.writableEnded) workerFail("worker_ipc_closed")
      if (!isWorkerObject(value)) workerFail("worker_ipc_message_invalid")
      let line: string
      try { line = `${canonicalJson(value)}\n` } catch { return workerFail("worker_ipc_message_invalid") }
      const bytes = Buffer.byteLength(line)
      if (bytes > MAX_WORKER_MESSAGE_BYTES || outgoingBytes + bytes > MAX_WORKER_STDOUT_BYTES) workerFail("worker_ipc_message_limit")
      outgoingBytes += bytes
      await new Promise<void>((resolveWrite, rejectWrite) => {
        child.stdin.write(line, (error?: Error | null) => error ? rejectWrite(error) : resolveWrite())
      }).catch(() => workerFail("worker_ipc_write_failed"))
    },
    closeInput(): void { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end() },
    onMessage(listener: (value: Record<string, unknown>) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onTrainerProtocolEvent(listener: (event: OwnedTrainerProtocolEvent) => void): () => void {
      trainerProtocolListeners.add(listener)
      return () => trainerProtocolListeners.delete(listener)
    },
    wait(): Promise<OwnedWorkerResult> { return resultPromise },
    async cancel(): Promise<OwnedWorkerResult> {
      await stop("cancelled", "worker_cancelled")
      return resultPromise
    },
    async reconcile(): Promise<Readonly<{ outcome: "running" | "terminal" | "unknown"; quiescent: boolean; evidence: string }>> {
      if (settled) {
        const result = await resultPromise
        return { outcome: result.quiescent ? "terminal" : "unknown", quiescent: result.quiescent,
          evidence: result.quiescent ? "owned-worker-process-group-absent" : "owned-worker-quiescence-unverified" }
      }
      if (pid === undefined) return { outcome: "unknown", quiescent: false, evidence: "owned-worker-pid-unavailable" }
      const alive = groupExists(pid)
      return alive ? { outcome: "running", quiescent: false, evidence: "owned-worker-process-group-present" }
        : { outcome: "unknown", quiescent: false, evidence: "worker-leader-unsettled" }
    },
  }
  return Object.freeze(handle)
}
