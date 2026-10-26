import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeSync,
} from "node:fs"
import type { BigIntStats } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import type { NativeSkillOptCampaignInput } from "./campaign.ts"
import { buildNativeAdapterManifest } from "./campaign-protocol.ts"
import { validateNativeDataset, trainerSafeProjection, NATIVE_DATASET_LIMITS, type NativeDataset } from "./dataset.ts"
import {
  hasLaunchedNativeSkillOptTrainerWorker, isGenuineCompletedQuiescentTrainerResult,
  prepareWorkerProfile, probeWorkerContainment, SkillOptWorkerError,
  type OwnedWorkerResult, type SkillOptContainmentReceipt, type SkillOptWorkerProfile,
} from "./host.ts"
import {
  consumePrivateTextCleanupDeletion,
  type SkillOptController,
  type SkillOptCurrentBinding,
  type SkillOptNativeTrainerMaterializationAllowance,
  type SkillOptNativeTrainerMaterializationMetadata,
  type SkillOptNativeTrainerProtocolStageAllowance,
  type SkillOptPrepared,
  type SkillOptPrivateTextDeletion,
  SkillOptControllerError,
} from "./controller.ts"
import { canonicalJson, PILOT_LIMITS, PILOT_SKILL, readBoundedSource, sha256, SkillOptError } from "./pilot.ts"
import type { ExecutionRuntime } from "../hosts/types.ts"
import type { SessionStore } from "../sessions/store.ts"
import { ensureDurableDirectory } from "../state/durable.ts"
import { executionRunDirectory } from "../state/store.ts"
import { captureEmptyPrivateCleanupDirectory, capturePrivateCleanupFile,
  verifyCapturedPrivateCleanupFile, syncPrivateCleanupDirectory, type PrivateCleanupFileSnapshot } from "./private-cleanup.ts"

const REPO_ROOT = realpathSync.native(resolve(import.meta.dir, "../../../"))
const SOURCE_LOCK_PATH = "scripts/skillopt-source-lock.json"
const SOURCE_LOCK_BYTES = 64 * 1024
const HASH = /^[a-f0-9]{64}$/u
const RUN_ID = /^[A-Za-z0-9_-]{1,96}$/u
const SCRATCH_PREFIX = "otter-skillopt-native-trainer-"
const SCRATCH_MARKER = ".skillopt-private-scratch.v1"
const SCRATCH_DESCRIPTOR_SCHEMA = "skillopt.native-trainer-scratch.v1" as const
const SCRATCH_MARKER_SCHEMA = "skillopt.native-trainer-scratch-marker.v1" as const
const SCRATCH_DESCRIPTOR_BYTES = 16 * 1024
const SCRATCH_MARKER_BYTES = 4 * 1024
// One marker plus four capped descriptor payloads: create, worker closure, delete-start, delete-complete.
export const NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES = 69_632
// Pinned native-runner UTF-8 subtree only. It relies on the runner's UTF-8 default-text-encoding guard and output-shape validators.
// Selected projection, both manifests/protocol staging, and cleanup are charged separately and are not repeated here.
// Conversations: 120 × 264,450 = 31,734,000; analyst patches: 2 × 49,152 = 98,304.
// Merged patch: 73,728 (72 KiB); ranked edits: 106,496 (104 KiB), including retained ranking details.
// Branch-coupled candidate/skill bodies: 4 × (1,200 UTF-8 content + 3 separators) = 4,812; oversized candidates exit before successful skill saves.
// Apply reports: 4 × (44 fixed + 14 op + 7,202 target + 7,202 content + 55 status + 1 index) + 194 framing = 58,266.
// Trajectory digest: 49,152 failure + 58,012 rejected edits + 2,471 IDs + 2,560 framing = 112,195.
// Step record is source-bounded below 3,462 (reserved 4,096); one-record history adds at most 256 bytes (4,352 total).
// Three runtime-state overwrites: 3 × 49,600 = 148,800 (reserved 150,000); config: 51,693; summary: 54,000 ceiling.
// Guarded success/failure result: one pre-open, newline-inclusive 32,768-byte payload.
export const NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES =
  31_734_000 + 98_304 + 73_728 + 106_496 + 4_812 + 58_266 + 112_195 + 4_096 + 4_352 + 150_000 + 51_693 + 54_000 + 32_768
const SCRATCH_TREE_ENTRIES = 1024
const SCRATCH_FILE_BYTES = 64 * 1024 * 1024
const SCRATCH_TOTAL_BYTES = 256 * 1024 * 1024 - NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const DIRECTORY_ONLY = constants.O_DIRECTORY ?? 0

type CampaignTrainer = NonNullable<NativeSkillOptCampaignInput["trainer"]>
type RuntimeSelection = Readonly<{ executablePath: string; nativeRuntimeProofPath: string }>
type DirectoryIdentity = Readonly<{ path: string; dev: bigint; ino: bigint; uid: bigint; mode: bigint }>
type PersistedIdentity = Readonly<{ dev: string; ino: string; uid: string; mode: string }>
type ScratchMarkerIdentity = PersistedIdentity & Readonly<{ name: typeof SCRATCH_MARKER; sha256: string }>
type ScratchDescriptor = Readonly<{
  schema: typeof SCRATCH_DESCRIPTOR_SCHEMA
  kind: "trainer"
  runId: string
  rootBinding: string
  state: "created" | "worker-closed"
  deletionProgress: "none" | "started" | "complete"
  deletionSnapshotSha256: string | null
  quarantine: PersistedIdentity | null
  root: PersistedIdentity & Readonly<{ path: string }>
  marker: ScratchMarkerIdentity
}>
type ScratchFileIdentity = Readonly<{
  dev: string; ino: string; uid: string; mode: string; nlink: string; size: string; mtimeNs: string; ctimeNs: string
}>
type ScratchTreeEntry = Readonly<{
  path: string
  kind: "file" | "directory"
  identity: ScratchFileIdentity
  sha256?: string
}>
type ScratchInventory = Readonly<{ entries: readonly ScratchTreeEntry[]; sha256: string; bytes: number }>
type ScratchQuarantine = Readonly<{
  path: string
  identity: PersistedIdentity
}>
type OwnedTrainerScratch = {
  worktree: string
  runId: string
  descriptorPath: string
  descriptor: ScratchDescriptor
  profile?: SkillOptWorkerProfile
  receipt?: SkillOptContainmentReceipt
  cleanupSnapshot?: InternalScratchSnapshot
  workerClosed: boolean
  cleaned: boolean
}

export type NativeSkillOptTrainerCleanupSnapshot = Readonly<{
  schema: "skillopt.native-trainer-cleanup-snapshot.v1"
  state: "worker-closed" | "deleted"
  deletionProgress: "none" | "started" | "complete"
  runId: string
  snapshotSha256: string
  rootBinding: string
  rootPathSha256: string
  root: PersistedIdentity
  marker: ScratchMarkerIdentity
  treeSha256: string | null
  tree: readonly NativeSkillOptTrainerCleanupTreeEntry[]
  fileCount: number
  totalBytes: number
  descriptorSha256: string
  descriptorIdentity: Readonly<Record<string, string>>
}>

type NativeSkillOptTrainerCleanupTreeEntry = Readonly<{
  pathSha256: string
  kind: "file" | "directory"
  depth: number
  identity: Readonly<Record<string, string>>
  sha256?: string
}>

type InternalScratchSnapshot = Readonly<{
  schema: "skillopt.native-trainer-cleanup-snapshot.v1"
  state: "absent" | "created" | "worker-closed" | "deleted"
  deletionProgress: "none" | "started" | "complete"
  runId: string
  snapshotSha256: string | null
  rootBinding: string | null
  rootPathSha256: string | null
  root: PersistedIdentity | null
  marker: ScratchMarkerIdentity | null
  treeSha256: string | null
  tree: readonly NativeSkillOptTrainerCleanupTreeEntry[]
  fileCount: number
  totalBytes: number
  descriptorSha256: string | null
  descriptorIdentity: Readonly<Record<string, string>> | null
}>

const trainerScratch = new WeakMap<object, OwnedTrainerScratch>()
const trainerScratchByProfile = new WeakMap<object, OwnedTrainerScratch>()
const trainerScratchByReceipt = new WeakMap<object, OwnedTrainerScratch>()

type NativeSkillOptTrainerInputBase = Readonly<{
  worktree: string
  dataset: NativeDataset
  prepared: SkillOptPrepared
  baselineSkillBytes: Uint8Array
}>

declare const nativeSkillOptTrainerMaterializationPlanBrand: unique symbol
export type NativeSkillOptTrainerMaterializationPlan = Readonly<{
  [nativeSkillOptTrainerMaterializationPlanBrand]: true
}>
export type NativeSkillOptTrainerMaterializationPlanInput = NativeSkillOptTrainerInputBase & Readonly<{
  runtime: RuntimeSelection
}>
export type NativeSkillOptTrainerInput = NativeSkillOptTrainerInputBase & (
  | Readonly<{ runtime?: undefined }>
  | Readonly<{
      runtime: RuntimeSelection
      owner: SessionStore
      executionRuntime: ExecutionRuntime
      controller: SkillOptController
      current: SkillOptCurrentBinding
      plan: NativeSkillOptTrainerMaterializationPlan
      allowance: SkillOptNativeTrainerMaterializationAllowance
    }>
)

export type NativeSkillOptTrainerPreparation =
  | Readonly<{ state: "DATA_REQUIRED" | "BLOCKED"; reasonCode: string }>
  | Readonly<{
      state: "READY"
      trainer: CampaignTrainer
      scratchDirectory: string
      cleanup(): boolean
    }>

type NativeSkillOptTrainerMaterializationPlanState = {
    worktree: string
    runId: string
    prepared: SkillOptPrepared
    runtime: RuntimeSelection
    datasetSha256: string
    baselineSkillSha256: string
    sourceLockSha256: string
    projectionBytes: Buffer
    manifestBytes: Buffer
    metadata: SkillOptNativeTrainerMaterializationMetadata
    used: boolean
}
const trainerMaterializationPlans = new WeakMap<object, NativeSkillOptTrainerMaterializationPlanState>()

function failure(state: "DATA_REQUIRED" | "BLOCKED", reasonCode: string): NativeSkillOptTrainerPreparation {
  return Object.freeze({ state, reasonCode })
}

function exactDirectory(path: string): DirectoryIdentity {
  const stat = lstatSync(path, { bigint: true })
  const uid = BigInt(process.geteuid?.() ?? -1)
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777n) !== 0o700n ||
      (stat.mode & 0o022n) !== 0n) throw new SkillOptError("trainer_scratch_invalid")
  return Object.freeze({ path, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777n })
}

function writePrivateFile(path: string, bytes: Buffer): ScratchFileIdentity {
  if (bytes.byteLength < 1) throw new SkillOptError("trainer_input_file_invalid")
  const file = writeNewPrivateFile(path, bytes, bytes.byteLength)
  if (file.identity.uid !== String(process.geteuid?.() ?? -1) || file.identity.nlink !== "1" ||
      file.identity.mode !== String(0o600) || file.identity.size !== String(bytes.byteLength)) {
    throw new SkillOptError("trainer_input_file_invalid")
  }
  return file.identity
}

function sameIdentity(left: ScratchFileIdentity, right: ScratchFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function fileIdentity(stat: BigIntStats): ScratchFileIdentity {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid),
    mode: String(stat.mode & 0o7777n), nlink: String(stat.nlink), size: String(stat.size),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) })
}

function persistedIdentity(stat: BigIntStats): PersistedIdentity {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid), mode: String(stat.mode & 0o7777n) })
}

function assertKnownRoot(identity: DirectoryIdentity): BigIntStats {
  const parent = realpathSync.native(tmpdir())
  const parentStat = lstatSync(parent, { bigint: true })
  if (dirname(identity.path) !== parent || parentStat.dev !== identity.dev) throw new SkillOptError("trainer_scratch_parent_invalid")
  return checkScratchDirectory(identity.path, {
    dev: String(identity.dev), ino: String(identity.ino), uid: String(identity.uid), mode: String(identity.mode),
  }, String(parentStat.dev))
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW)
  try {
    if (!fstatSync(fd).isDirectory()) throw new SkillOptError("trainer_scratch_directory_invalid")
    fsyncSync(fd)
  } finally { closeSync(fd) }
}

function safeReadFile(path: string, maximumBytes: number, expectedMode?: number): Readonly<{
  bytes: Buffer; identity: ScratchFileIdentity; stat: BigIntStats
}> {
  const beforeName = lstatSync(path, { bigint: true })
  if (beforeName.isSymbolicLink() || !beforeName.isFile()) throw new SkillOptError("trainer_scratch_file_invalid")
  const fd = openSync(path, constants.O_RDONLY | NO_FOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd, { bigint: true })
    const uid = BigInt(process.geteuid?.() ?? -1)
    if (!before.isFile() || before.dev !== beforeName.dev || before.ino !== beforeName.ino || before.uid !== uid ||
        before.nlink !== 1n || before.size < 0n || before.size > BigInt(maximumBytes) ||
        (before.mode & 0o0022n) !== 0n || (expectedMode !== undefined && (before.mode & 0o7777n) !== BigInt(expectedMode))) {
      throw new SkillOptError("trainer_scratch_file_invalid")
    }
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let offset = 0
    for (;;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) break
      offset += count
      if (offset > maximumBytes) throw new SkillOptError("trainer_scratch_file_limit")
    }
    const after = fstatSync(fd, { bigint: true })
    const afterName = lstatSync(path, { bigint: true })
    if (offset !== Number(before.size) || after.dev !== before.dev || after.ino !== before.ino ||
        after.uid !== before.uid || after.nlink !== before.nlink || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        afterName.isSymbolicLink() || afterName.dev !== before.dev || afterName.ino !== before.ino) {
      throw new SkillOptError("trainer_scratch_file_changed")
    }
    return Object.freeze({ bytes: bytes.subarray(0, offset), identity: fileIdentity(after), stat: after })
  } finally { closeSync(fd) }
}

function checkScratchDirectory(path: string, expected: PersistedIdentity, expectedDev: string): BigIntStats {
  const stat = lstatSync(path, { bigint: true })
  const uid = BigInt(process.geteuid?.() ?? -1)
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== BigInt(expected.dev) || stat.ino !== BigInt(expected.ino) ||
      stat.uid !== uid || String(stat.uid) !== expected.uid || stat.dev !== BigInt(expectedDev) ||
      String(stat.mode & 0o7777n) !== expected.mode || (stat.mode & 0o7777n) !== 0o700n ||
      realpathSync.native(path) !== path) throw new SkillOptError("trainer_scratch_identity_changed")
  return stat
}

function assertNoMountedDescendant(rootPath: string): void {
  if (process.platform !== "linux") return
  let fd: number
  try { fd = openSync("/proc/self/mountinfo", constants.O_RDONLY | NO_FOLLOW) }
  catch { throw new SkillOptError("trainer_scratch_mount_identity_unavailable") }
  try {
    const chunks: Buffer[] = []
    const chunk = Buffer.alloc(64 * 1024)
    let total = 0
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null)
      if (count === 0) break
      total += count
      if (total > 4 * 1024 * 1024) throw new SkillOptError("trainer_scratch_mount_table_limit")
      chunks.push(Buffer.from(chunk.subarray(0, count)))
    }
    const mountInfo = Buffer.concat(chunks, total).toString("utf8")
    for (const line of mountInfo.split("\n")) {
      if (!line) continue
      const mountPoint = line.split(" ")[4]
      if (!mountPoint) throw new SkillOptError("trainer_scratch_mount_table_invalid")
      const path = mountPoint.replace(/\\(040|011|012|134)/gu, (_match, octal: string) =>
        octal === "040" ? " " : octal === "011" ? "\t" : octal === "012" ? "\n" : "\\")
      if (path === rootPath || path.startsWith(`${rootPath}${sep}`)) throw new SkillOptError("trainer_scratch_nested_mount")
    }
  } finally { closeSync(fd) }
}

function collectScratchInventory(root: DirectoryIdentity): ScratchInventory {
  const uid = BigInt(process.geteuid?.() ?? -1)
  const entries: ScratchTreeEntry[] = []
  let bytes = 0
  const add = (entry: ScratchTreeEntry) => {
    entries.push(Object.freeze(entry))
    if (entries.length > SCRATCH_TREE_ENTRIES) throw new SkillOptError("trainer_scratch_tree_limit")
  }
  const visit = (directory: string, prefix: string, depth: number): void => {
    if (depth > 16) throw new SkillOptError("trainer_scratch_tree_limit")
    const names = readdirSync(directory).sort()
    for (const name of names) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
        throw new SkillOptError("trainer_scratch_entry_invalid")
      }
      const relativePath = prefix ? `${prefix}/${name}` : name
      const path = join(directory, name)
      const stat = lstatSync(path, { bigint: true })
      if (stat.isSymbolicLink() || stat.dev !== root.dev || stat.uid !== uid) {
        throw new SkillOptError("trainer_scratch_entry_identity_changed")
      }
      if (stat.isDirectory()) {
        if ((stat.mode & 0o7777n) !== 0o700n || (stat.mode & 0o7000n) !== 0n) {
          throw new SkillOptError("trainer_scratch_directory_invalid")
        }
        add({ path: relativePath, kind: "directory", identity: fileIdentity(stat) })
        visit(path, relativePath, depth + 1)
        continue
      }
      if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o0022n) !== 0n || (stat.mode & 0o7000n) !== 0n ||
          stat.size > BigInt(SCRATCH_FILE_BYTES)) throw new SkillOptError("trainer_scratch_file_invalid")
      bytes += Number(stat.size)
      if (!Number.isSafeInteger(bytes) || bytes > SCRATCH_TOTAL_BYTES) throw new SkillOptError("trainer_scratch_tree_limit")
      const read = safeReadFile(path, SCRATCH_FILE_BYTES)
      if (!sameIdentity(fileIdentity(stat), read.identity)) throw new SkillOptError("trainer_scratch_file_changed")
      add({ path: relativePath, kind: "file", identity: read.identity, sha256: sha256(read.bytes) })
    }
  }

  const rootStat = lstatSync(root.path, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev !== root.dev || rootStat.ino !== root.ino ||
      rootStat.uid !== root.uid || (rootStat.mode & 0o7777n) !== root.mode || realpathSync.native(root.path) !== root.path) {
    throw new SkillOptError("trainer_scratch_identity_changed")
  }
  assertNoMountedDescendant(root.path)
  visit(root.path, "", 0)
  assertNoMountedDescendant(root.path)
  const afterRoot = lstatSync(root.path, { bigint: true })
  if (!afterRoot.isDirectory() || afterRoot.isSymbolicLink() || afterRoot.dev !== root.dev || afterRoot.ino !== root.ino ||
      afterRoot.uid !== root.uid || (afterRoot.mode & 0o7777n) !== root.mode) throw new SkillOptError("trainer_scratch_identity_changed")
  const digestView = entries.map(entry => ({ path: entry.path, kind: entry.kind, identity: entry.identity, sha256: entry.sha256 ?? null }))
  return Object.freeze({ entries: Object.freeze(entries), sha256: sha256(canonicalJson(digestView)), bytes })
}

function cleanFailure(scratch?: OwnedTrainerScratch): void {
  if (scratch) cleanupTrackedScratch(scratch, true)
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function safeRunId(runId: unknown): runId is string {
  return typeof runId === "string" && RUN_ID.test(runId)
}

function canonicalWorktree(worktree: string): string {
  if (typeof worktree !== "string" || worktree.length === 0 || realpathSync.native(worktree) !== worktree) {
    throw new SkillOptError("trainer_worktree_not_canonical")
  }
  return worktree
}

function descriptorDirectory(worktree: string, create: boolean): string | null {
  const root = canonicalWorktree(worktree)
  const directory = join(executionRunDirectory(root), "skillopt-native-foreground")
  if (create) ensureDurableDirectory(directory)
  let stat: BigIntStats
  try { stat = lstatSync(directory, { bigint: true }) }
  catch (error) {
    if (!create && errorCode(error) === "ENOENT") return null
    throw error
  }
  const uid = BigInt(process.geteuid?.() ?? -1)
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777n) !== 0o700n ||
      realpathSync.native(directory) !== directory) throw new SkillOptError("trainer_scratch_descriptor_directory_invalid")
  return directory
}

function descriptorPath(worktree: string, runId: string, createDirectory: boolean): string | null {
  if (!safeRunId(runId)) throw new SkillOptError("trainer_run_id_invalid")
  const directory = descriptorDirectory(worktree, createDirectory)
  return directory ? join(directory, `${runId}.trainer.json`) : null
}

function assertNoDescriptorTemporary(directory: string, runId: string): void {
  const prefixes = [`${runId}.trainer.json.`, `.${runId}.trainer.json.`]
  if (readdirSync(directory).some(name => prefixes.some(prefix => name.startsWith(prefix)) && name.endsWith(".tmp"))) {
    throw new SkillOptError("trainer_scratch_descriptor_write_incomplete")
  }
}

function hasOrphanedTrainerScratch(worktree: string, runId: string): boolean {
  const rootBinding = sha256(`root:${worktree}`)
  const prefix = `${SCRATCH_PREFIX}${runId}-${rootBinding}-`
  const parent = realpathSync.native(tmpdir())
  const names = readdirSync(parent)
  if (names.length > 100_000) throw new SkillOptError("trainer_scratch_parent_limit")
  return names.some(name => name.startsWith(prefix))
}

function trainerQuarantinePath(descriptor: ScratchDescriptor): string {
  return `${descriptor.root.path}.cleanup`
}

function createTrainerQuarantine(descriptor: ScratchDescriptor): ScratchQuarantine {
  const path = trainerQuarantinePath(descriptor)
  const parent = realpathSync.native(tmpdir())
  if (dirname(path) !== parent) throw new SkillOptError("trainer_scratch_quarantine_parent_invalid")
  try { mkdirSync(path, { mode: 0o700 }) }
  catch { throw new SkillOptError("trainer_scratch_quarantine_exists") }
  syncDirectory(parent)
  const stat = lstatSync(path, { bigint: true })
  const uid = BigInt(process.geteuid?.() ?? -1)
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== BigInt(descriptor.root.dev) || stat.uid !== uid ||
      (stat.mode & 0o7777n) !== 0o700n || realpathSync.native(path) !== path) {
    throw new SkillOptError("trainer_scratch_quarantine_invalid")
  }
  return Object.freeze({ path, identity: persistedIdentity(stat) })
}

function inspectTrainerQuarantine(descriptor: ScratchDescriptor): ScratchQuarantine {
  if (!descriptor.quarantine) throw new SkillOptError("trainer_scratch_quarantine_unbound")
  const path = trainerQuarantinePath(descriptor)
  const stat = lstatSync(path, { bigint: true })
  const uid = BigInt(process.geteuid?.() ?? -1)
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== BigInt(descriptor.root.dev) || stat.uid !== uid ||
      (stat.mode & 0o7777n) !== 0o700n || canonicalJson(persistedIdentity(stat)) !== canonicalJson(descriptor.quarantine) ||
      realpathSync.native(path) !== path) throw new SkillOptError("trainer_scratch_quarantine_invalid")
  const names = readdirSync(path)
  if (names.length > SCRATCH_TREE_ENTRIES + 1) throw new SkillOptError("trainer_scratch_quarantine_entry_limit")
  names.sort()
  for (const name of names) {
    if (name !== "root" && !/^entry-[a-f0-9]{64}$/u.test(name)) {
      throw new SkillOptError("trainer_scratch_quarantine_entry_invalid")
    }
  }
  const afterStat = lstatSync(path, { bigint: true })
  if (afterStat.isSymbolicLink() || !afterStat.isDirectory() || afterStat.dev !== stat.dev || afterStat.ino !== stat.ino ||
      afterStat.uid !== stat.uid || afterStat.mode !== stat.mode || realpathSync.native(path) !== path ||
      canonicalJson(readdirSync(path).sort()) !== canonicalJson(names)) {
    throw new SkillOptError("trainer_scratch_quarantine_changed")
  }
  return Object.freeze({ path, identity: persistedIdentity(stat) })
}

function validPersistedIdentity(value: unknown): value is PersistedIdentity {
  if (!isRecord(value) || !exactKeys(value, ["dev", "ino", "uid", "mode"])) return false
  return [value.dev, value.ino, value.uid, value.mode].every(field => typeof field === "string" && /^(0|[1-9][0-9]{0,30})$/u.test(field))
}

function parseScratchDescriptor(bytes: Buffer, worktree: string, runId: string): ScratchDescriptor {
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString("utf8")) } catch { throw new SkillOptError("trainer_scratch_descriptor_invalid") }
  if (!isRecord(parsed) || !exactKeys(parsed, ["schema", "kind", "runId", "rootBinding", "state", "deletionProgress",
    "deletionSnapshotSha256", "quarantine", "root", "marker"]) ||
      parsed.schema !== SCRATCH_DESCRIPTOR_SCHEMA || parsed.kind !== "trainer" || parsed.runId !== runId ||
      typeof parsed.rootBinding !== "string" || !HASH.test(parsed.rootBinding) || parsed.rootBinding !== sha256(`root:${worktree}`) ||
      (parsed.state !== "created" && parsed.state !== "worker-closed") ||
      (parsed.deletionProgress !== "none" && parsed.deletionProgress !== "started" && parsed.deletionProgress !== "complete") ||
      (parsed.deletionSnapshotSha256 !== null &&
        (typeof parsed.deletionSnapshotSha256 !== "string" || !HASH.test(parsed.deletionSnapshotSha256))) ||
      (parsed.deletionProgress === "none" && parsed.deletionSnapshotSha256 !== null) ||
      (parsed.deletionProgress !== "none" && parsed.deletionSnapshotSha256 === null) ||
      (parsed.quarantine !== null && !validPersistedIdentity(parsed.quarantine)) ||
      (parsed.deletionProgress === "none" && parsed.quarantine !== null) ||
      (parsed.deletionProgress !== "none" && parsed.quarantine === null) ||
      !isRecord(parsed.root) || !exactKeys(parsed.root, ["path", "dev", "ino", "uid", "mode"]) ||
      typeof parsed.root.path !== "string" || !parsed.root.path.startsWith("/") || parsed.root.path.length > 4096 ||
      !validPersistedIdentity({ dev: parsed.root.dev, ino: parsed.root.ino, uid: parsed.root.uid, mode: parsed.root.mode }) ||
      !isRecord(parsed.marker) || !exactKeys(parsed.marker, ["name", "dev", "ino", "uid", "mode", "sha256"]) ||
      parsed.marker.name !== SCRATCH_MARKER ||
      !validPersistedIdentity({ dev: parsed.marker.dev, ino: parsed.marker.ino, uid: parsed.marker.uid, mode: parsed.marker.mode }) ||
      typeof parsed.marker.sha256 !== "string" || !HASH.test(parsed.marker.sha256)) {
    throw new SkillOptError("trainer_scratch_descriptor_invalid")
  }
  const canonicalBytes = Buffer.from(`${canonicalJson(parsed)}\n`, "utf8")
  if (!bytes.equals(canonicalBytes)) throw new SkillOptError("trainer_scratch_descriptor_noncanonical")
  const tmpParent = realpathSync.native(tmpdir())
  const expectedPrefix = `${SCRATCH_PREFIX}${runId}-${parsed.rootBinding}-`
  const rootName = parsed.root.path.split(/[\\/]/u).at(-1) ?? ""
  if (dirname(parsed.root.path) !== tmpParent || !rootName.startsWith(expectedPrefix) ||
      !/^[A-Za-z0-9]{6}$/u.test(rootName.slice(expectedPrefix.length)) ||
      parsed.root.mode !== String(0o700) || parsed.marker.mode !== String(0o600)) {
    throw new SkillOptError("trainer_scratch_descriptor_identity_invalid")
  }
  return parsed as unknown as ScratchDescriptor
}

function readDescriptorFile(path: string, worktree: string, runId: string): Readonly<{
  descriptor: ScratchDescriptor; file: ReturnType<typeof safeReadFile>
}> {
  const file = safeReadFile(path, SCRATCH_DESCRIPTOR_BYTES, 0o600)
  const descriptor = parseScratchDescriptor(file.bytes, worktree, runId)
  return Object.freeze({ descriptor, file })
}

function markerContents(descriptor: Pick<ScratchDescriptor, "runId" | "rootBinding" | "root">): Buffer {
  const marker = {
    schema: SCRATCH_MARKER_SCHEMA,
    kind: "trainer",
    runId: descriptor.runId,
    rootBinding: descriptor.rootBinding,
    root: { dev: descriptor.root.dev, ino: descriptor.root.ino, uid: descriptor.root.uid, mode: descriptor.root.mode },
  }
  return Buffer.from(`${canonicalJson(marker)}\n`, "utf8")
}

function rootDirectoryIdentity(descriptor: ScratchDescriptor): DirectoryIdentity {
  const parent = realpathSync.native(tmpdir())
  const parentStat = lstatSync(parent, { bigint: true })
  if (dirname(descriptor.root.path) !== parent) throw new SkillOptError("trainer_scratch_parent_invalid")
  const stat = lstatSync(descriptor.root.path, { bigint: true })
  if (parentStat.dev !== stat.dev) throw new SkillOptError("trainer_scratch_mount_changed")
  checkScratchDirectory(descriptor.root.path, descriptor.root, String(parentStat.dev))
  return Object.freeze({ path: descriptor.root.path, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777n })
}

function validateScratchMarker(descriptor: ScratchDescriptor, root: DirectoryIdentity): Readonly<{
  file: ReturnType<typeof safeReadFile>; sha256: string
}> {
  const markerPath = join(root.path, SCRATCH_MARKER)
  const file = safeReadFile(markerPath, SCRATCH_MARKER_BYTES, 0o600)
  const digest = sha256(file.bytes)
  if (digest !== descriptor.marker.sha256 || file.identity.dev !== descriptor.marker.dev ||
      file.identity.ino !== descriptor.marker.ino || file.identity.uid !== descriptor.marker.uid ||
      file.identity.mode !== descriptor.marker.mode || !file.bytes.equals(markerContents(descriptor))) {
    throw new SkillOptError("trainer_scratch_marker_invalid")
  }
  return Object.freeze({ file, sha256: digest })
}

function snapshotIdentity(file: ReturnType<typeof safeReadFile>): Readonly<Record<string, string>> {
  const { identity } = file
  return Object.freeze({ dev: identity.dev, ino: identity.ino, uid: identity.uid, mode: identity.mode,
    nlink: identity.nlink, size: identity.size, mtimeNs: identity.mtimeNs, ctimeNs: identity.ctimeNs })
}

function snapshotTree(inventory?: ScratchInventory): readonly NativeSkillOptTrainerCleanupTreeEntry[] {
  if (!inventory) return Object.freeze([])
  return Object.freeze(inventory.entries.map(entry => Object.freeze({ pathSha256: sha256(entry.path), kind: entry.kind,
    depth: entry.path.split("/").length - 1,
    identity: entry.identity, ...(entry.sha256 ? { sha256: entry.sha256 } : {}) })))
}

type InspectedScratch = Readonly<{
  snapshot: InternalScratchSnapshot
  worktree?: string
  descriptorPath?: string
  descriptor?: ScratchDescriptor
  descriptorFile?: ReturnType<typeof safeReadFile>
  root?: DirectoryIdentity
  inventory?: ScratchInventory
}>

function createScratchSnapshot(input: Readonly<{
  state: InternalScratchSnapshot["state"]
  runId: string
  descriptor?: ScratchDescriptor
  descriptorFile?: ReturnType<typeof safeReadFile>
  inventory?: ScratchInventory
}>): InternalScratchSnapshot {
  if (!input.descriptor || !input.descriptorFile) {
    return Object.freeze({ schema: "skillopt.native-trainer-cleanup-snapshot.v1", state: input.state, deletionProgress: "none",
      runId: input.runId,
      snapshotSha256: null, rootBinding: null, rootPathSha256: null, root: null, marker: null, treeSha256: null,
      tree: Object.freeze([]), fileCount: 0, totalBytes: 0, descriptorSha256: null, descriptorIdentity: null })
  }
  const descriptor = input.descriptor
  const root = Object.freeze({ dev: descriptor.root.dev, ino: descriptor.root.ino, uid: descriptor.root.uid, mode: descriptor.root.mode })
  const fileCount = input.inventory?.entries.filter(entry => entry.kind === "file").length ?? 0
  const tree = snapshotTree(input.inventory)
  const body = Object.freeze({ schema: "skillopt.native-trainer-cleanup-snapshot.v1" as const, state: input.state,
    deletionProgress: descriptor.deletionProgress,
    runId: input.runId, rootBinding: descriptor.rootBinding, rootPathSha256: sha256(descriptor.root.path), root,
    marker: descriptor.marker, treeSha256: input.inventory?.sha256 ?? null, tree, fileCount,
    totalBytes: input.inventory?.bytes ?? 0, descriptorSha256: sha256(input.descriptorFile.bytes),
    descriptorIdentity: snapshotIdentity(input.descriptorFile) })
  return Object.freeze({ ...body, snapshotSha256: sha256(canonicalJson(body)) })
}

function absentSnapshot(runId: string): InternalScratchSnapshot {
  return createScratchSnapshot({ state: "absent", runId })
}

function validSnapshotTree(value: unknown): value is readonly NativeSkillOptTrainerCleanupTreeEntry[] {
  if (!Array.isArray(value) || value.length > SCRATCH_TREE_ENTRIES) return false
  const paths = new Set<string>()
  let fileCount = 0
  let totalBytes = 0n
  for (const entry of value) {
    if (!isRecord(entry) || (entry.kind !== "file" && entry.kind !== "directory") ||
        !exactKeys(entry, entry.kind === "file" ? ["pathSha256", "kind", "depth", "identity", "sha256"] : ["pathSha256", "kind", "depth", "identity"]) ||
        typeof entry.pathSha256 !== "string" || !HASH.test(entry.pathSha256) || paths.has(entry.pathSha256) ||
        typeof entry.depth !== "number" || !Number.isSafeInteger(entry.depth) || entry.depth < 0 || entry.depth > 16 ||
        !isRecord(entry.identity) || !exactKeys(entry.identity, ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) ||
        !Object.values(entry.identity).every(field => typeof field === "string" && /^(0|[1-9][0-9]{0,30})$/u.test(field))) return false
    paths.add(entry.pathSha256)
    if (entry.kind === "file") {
      if (typeof entry.sha256 !== "string" || !HASH.test(entry.sha256) ||
          typeof entry.identity.size !== "string" || !/^(0|[1-9][0-9]{0,30})$/u.test(entry.identity.size)) return false
      try { totalBytes += BigInt(String(entry.identity.size)) } catch { return false }
      fileCount += 1
    } else if (Object.hasOwn(entry, "sha256")) return false
  }
  return fileCount <= SCRATCH_TREE_ENTRIES && totalBytes <= BigInt(SCRATCH_TOTAL_BYTES)
}

function isCleanupSnapshot(value: unknown): value is NativeSkillOptTrainerCleanupSnapshot {
  if (!isRecord(value) || !exactKeys(value, ["schema", "state", "deletionProgress", "runId", "snapshotSha256", "rootBinding", "rootPathSha256",
    "root", "marker", "treeSha256", "tree", "fileCount", "totalBytes", "descriptorSha256", "descriptorIdentity"]) ||
      value.schema !== "skillopt.native-trainer-cleanup-snapshot.v1" ||
      (value.state !== "worker-closed" && value.state !== "deleted") || !safeRunId(value.runId) ||
      (value.deletionProgress !== "none" && value.deletionProgress !== "started" && value.deletionProgress !== "complete") ||
      typeof value.snapshotSha256 !== "string" || !HASH.test(value.snapshotSha256) ||
      typeof value.rootBinding !== "string" || !HASH.test(value.rootBinding) ||
      typeof value.rootPathSha256 !== "string" || !HASH.test(value.rootPathSha256) ||
      !validPersistedIdentity(value.root) || !isRecord(value.marker) ||
      !exactKeys(value.marker, ["name", "dev", "ino", "uid", "mode", "sha256"]) || value.marker.name !== SCRATCH_MARKER ||
      !validPersistedIdentity({ dev: value.marker.dev, ino: value.marker.ino, uid: value.marker.uid, mode: value.marker.mode }) ||
      typeof value.marker.sha256 !== "string" || !HASH.test(value.marker.sha256) ||
      (value.treeSha256 !== null && (typeof value.treeSha256 !== "string" || !HASH.test(value.treeSha256))) ||
      typeof value.fileCount !== "number" || !Number.isSafeInteger(value.fileCount) || value.fileCount < 0 ||
      typeof value.totalBytes !== "number" || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 ||
      !validSnapshotTree(value.tree) || value.fileCount !== value.tree.filter(entry => entry.kind === "file").length ||
      value.totalBytes !== value.tree.filter(entry => entry.kind === "file")
        .reduce((total, entry) => total + Number(entry.identity.size), 0) ||
      typeof value.descriptorSha256 !== "string" || !HASH.test(value.descriptorSha256) ||
      !isRecord(value.descriptorIdentity) ||
      !exactKeys(value.descriptorIdentity, ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) ||
      !Object.values(value.descriptorIdentity).every(field => typeof field === "string")) return false
  if (value.state === "deleted" && (value.deletionProgress !== "complete" ||
      value.tree.length !== 0 || value.fileCount !== 0 || value.totalBytes !== 0 || value.treeSha256 !== null)) return false
  const marker = value.marker
  const markerEntry = value.tree.find(entry => entry.pathSha256 === sha256(SCRATCH_MARKER) && entry.kind === "file" &&
    entry.sha256 === marker.sha256 && entry.identity.dev === marker.dev && entry.identity.ino === marker.ino &&
    entry.identity.uid === marker.uid && entry.identity.mode === marker.mode)
  if (value.state === "worker-closed" && (value.deletionProgress !== "none" || !value.treeSha256 || !markerEntry)) return false
  const { snapshotSha256, ...body } = value
  return sha256(canonicalJson(body)) === snapshotSha256
}

function isApprovedPartialTree(
  approved: readonly NativeSkillOptTrainerCleanupTreeEntry[],
  current: readonly NativeSkillOptTrainerCleanupTreeEntry[],
): boolean {
  const initial = new Map(approved.map(entry => [entry.pathSha256, entry]))
  for (const entry of current) {
    const previous = initial.get(entry.pathSha256)
    if (!previous || previous.kind !== entry.kind) return false
    if (entry.kind === "file") {
      if (canonicalJson(entry) !== canonicalJson(previous)) return false
    } else if (entry.depth !== previous.depth || ["dev", "ino", "uid", "mode"].some(key => entry.identity[key] !== previous.identity[key])) return false
  }
  return true
}

function publicCleanupSnapshot(snapshot: InternalScratchSnapshot): NativeSkillOptTrainerCleanupSnapshot {
  if ((snapshot.state !== "worker-closed" && snapshot.state !== "deleted") || !isCleanupSnapshot(snapshot)) {
    throw new SkillOptError("trainer_scratch_snapshot_not_cleanup_eligible")
  }
  return snapshot
}

function inspectScratch(worktreeValue: string, runId: string): InspectedScratch {
  if (!safeRunId(runId)) throw new SkillOptError("trainer_run_id_invalid")
  const worktree = canonicalWorktree(worktreeValue)
  const path = descriptorPath(worktree, runId, false)
  if (!path) {
    if (hasOrphanedTrainerScratch(worktree, runId)) throw new SkillOptError("trainer_scratch_descriptor_missing_for_root")
    return Object.freeze({ snapshot: absentSnapshot(runId) })
  }
  assertNoDescriptorTemporary(dirname(path), runId)
  let loaded: ReturnType<typeof readDescriptorFile>
  try { loaded = readDescriptorFile(path, worktree, runId) }
  catch (error) {
    if (errorCode(error) === "ENOENT") {
      if (hasOrphanedTrainerScratch(worktree, runId)) throw new SkillOptError("trainer_scratch_descriptor_missing_for_root")
      return Object.freeze({ snapshot: absentSnapshot(runId) })
    }
    throw error
  }
  const { descriptor, file: descriptorFile } = loaded
  const tmpParent = realpathSync.native(tmpdir())
  if (dirname(descriptor.root.path) !== tmpParent) throw new SkillOptError("trainer_scratch_parent_invalid")
  const rootExists = (() => {
    try { lstatSync(descriptor.root.path); return true }
    catch (error) { if (errorCode(error) === "ENOENT") return false; throw error }
  })()
  let quarantine: ScratchQuarantine | undefined
  if (descriptor.deletionProgress === "none") {
    if (descriptor.quarantine !== null) throw new SkillOptError("trainer_scratch_quarantine_unbound")
    try { lstatSync(trainerQuarantinePath(descriptor)); throw new SkillOptError("trainer_scratch_quarantine_unbound") }
    catch (error) {
      if (error instanceof SkillOptError) throw error
      if (errorCode(error) !== "ENOENT") throw error
    }
  } else {
    if (!descriptor.deletionSnapshotSha256) throw new SkillOptError("trainer_scratch_deletion_snapshot_invalid")
    quarantine = inspectTrainerQuarantine(descriptor)
  }
  if (descriptor.deletionProgress === "complete") {
    if (rootExists) throw new SkillOptError("trainer_scratch_root_recreated")
    if (!quarantine || readdirSync(quarantine.path).length !== 0) throw new SkillOptError("trainer_scratch_quarantine_not_empty")
    const snapshot = createScratchSnapshot({ state: "deleted", runId, descriptor, descriptorFile })
    return Object.freeze({ snapshot, worktree, descriptorPath: path, descriptor, descriptorFile })
  }
  if (!rootExists) {
    throw new SkillOptError("trainer_scratch_root_missing_after_recorded")
  }
  const root = rootDirectoryIdentity(descriptor)
  let markerMissing = false
  try { validateScratchMarker(descriptor, root) }
  catch (error) {
    const markerCapture = quarantine && join(quarantine.path, `entry-${sha256(SCRATCH_MARKER)}`)
    if (descriptor.deletionProgress === "started" && markerCapture && errorCode(error) === "ENOENT") {
      const captured = lstatSync(markerCapture, { bigint: true })
      if (captured.isSymbolicLink() || !captured.isFile()) throw new SkillOptError("trainer_scratch_quarantine_marker_invalid")
      markerMissing = true
    } else throw error
  }
  const inventory = collectScratchInventory(root)
  const markerEntry = inventory.entries.find(entry => entry.path === SCRATCH_MARKER && entry.kind === "file")
  if (!markerMissing && (!markerEntry || markerEntry.identity.dev !== descriptor.marker.dev || markerEntry.identity.ino !== descriptor.marker.ino ||
      markerEntry.identity.uid !== descriptor.marker.uid || markerEntry.identity.mode !== descriptor.marker.mode ||
      markerEntry.sha256 !== descriptor.marker.sha256)) throw new SkillOptError("trainer_scratch_marker_identity_changed")
  const snapshot = createScratchSnapshot({ state: descriptor.state, runId, descriptor, descriptorFile, inventory })
  return Object.freeze({ snapshot, worktree, descriptorPath: path, descriptor, descriptorFile, root, inventory })
}

function writeNewPrivateFile(
  path: string,
  bytes: Buffer,
  maximumBytes: number,
): ReturnType<typeof safeReadFile> {
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) throw new SkillOptError("trainer_scratch_metadata_limit")
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600)
    const created = fstatSync(fd, { bigint: true })
    if (!created.isFile() || created.uid !== BigInt(process.geteuid?.() ?? -1) || created.nlink !== 1n ||
        (created.mode & 0o7777n) !== 0o600n) throw new SkillOptError("trainer_scratch_metadata_file_invalid")
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset)
      if (written <= 0) throw new SkillOptError("trainer_scratch_metadata_write_failed")
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    syncDirectory(dirname(path))
    const file = safeReadFile(path, maximumBytes, 0o600)
    if (!file.bytes.equals(bytes)) throw new SkillOptError("trainer_scratch_metadata_changed")
    return file
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    throw error
  }
}

function replaceDescriptor(
  path: string,
  previous: ReturnType<typeof safeReadFile>,
  descriptor: ScratchDescriptor,
): ReturnType<typeof safeReadFile> {
  const current = safeReadFile(path, SCRATCH_DESCRIPTOR_BYTES, 0o600)
  if (!sameIdentity(current.identity, previous.identity) || !current.bytes.equals(previous.bytes)) {
    throw new SkillOptError("trainer_scratch_descriptor_changed")
  }
  const bytes = Buffer.from(`${canonicalJson(descriptor)}\n`, "utf8")
  if (bytes.byteLength > SCRATCH_DESCRIPTOR_BYTES) throw new SkillOptError("trainer_scratch_metadata_limit")
  const directory = dirname(path)
  assertNoDescriptorTemporary(directory, descriptor.runId)
  const transition = descriptor.state === "worker-closed" ? "worker-closed" :
    descriptor.deletionProgress === "started" ? "deletion-started" :
      descriptor.deletionProgress === "complete" ? "deletion-complete" : undefined
  if (!transition) throw new SkillOptError("trainer_scratch_descriptor_transition_invalid")
  const temporaryPath = `${path}.${transition}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600)
    const created = fstatSync(fd, { bigint: true })
    if (!created.isFile() || created.uid !== BigInt(process.geteuid?.() ?? -1) || created.nlink !== 1n ||
        (created.mode & 0o7777n) !== 0o600n) throw new SkillOptError("trainer_scratch_descriptor_temporary_invalid")
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset)
      if (written <= 0) throw new SkillOptError("trainer_scratch_descriptor_write_failed")
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    syncDirectory(directory)
    const staged = safeReadFile(temporaryPath, SCRATCH_DESCRIPTOR_BYTES, 0o600)
    if (!staged.bytes.equals(bytes)) throw new SkillOptError("trainer_scratch_descriptor_temporary_changed")
    const latest = safeReadFile(path, SCRATCH_DESCRIPTOR_BYTES, 0o600)
    if (!sameIdentity(latest.identity, previous.identity) || !latest.bytes.equals(previous.bytes)) {
      throw new SkillOptError("trainer_scratch_descriptor_changed")
    }
    renameSync(temporaryPath, path)
    syncDirectory(directory)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    throw error
  }
  const updated = safeReadFile(path, SCRATCH_DESCRIPTOR_BYTES, 0o600)
  if (!updated.bytes.equals(bytes)) throw new SkillOptError("trainer_scratch_descriptor_changed")
  return updated
}

function updateDescriptor(
  inspected: InspectedScratch,
  descriptor: ScratchDescriptor,
): Readonly<{ descriptor: ScratchDescriptor; file: ReturnType<typeof safeReadFile> }> {
  if (!inspected.worktree || !inspected.descriptorPath || !inspected.descriptorFile) {
    throw new SkillOptError("trainer_scratch_descriptor_missing")
  }
  const file = replaceDescriptor(inspected.descriptorPath, inspected.descriptorFile, descriptor)
  const parsed = parseScratchDescriptor(file.bytes, inspected.worktree, descriptor.runId)
  return Object.freeze({ descriptor: parsed, file })
}

function createScratchDescriptor(root: DirectoryIdentity, runId: string, rootBinding: string): ScratchDescriptor {
  const rootStat = assertKnownRoot(root)
  const rootView = Object.freeze({ path: root.path, ...persistedIdentity(rootStat) })
  const markerData = { schema: SCRATCH_MARKER_SCHEMA, kind: "trainer", runId, rootBinding,
    root: { dev: rootView.dev, ino: rootView.ino, uid: rootView.uid, mode: rootView.mode } }
  const markerBytes = Buffer.from(`${canonicalJson(markerData)}\n`, "utf8")
  if (markerBytes.byteLength > SCRATCH_MARKER_BYTES) throw new SkillOptError("trainer_scratch_metadata_limit")
  const markerFile = writePrivateFile(join(root.path, SCRATCH_MARKER), markerBytes)
  syncDirectory(root.path)
  assertKnownRoot(root)
  const marker: ScratchMarkerIdentity = Object.freeze({ name: SCRATCH_MARKER, dev: markerFile.dev, ino: markerFile.ino,
    uid: markerFile.uid, mode: markerFile.mode, sha256: sha256(markerBytes) })
  return Object.freeze({ schema: SCRATCH_DESCRIPTOR_SCHEMA, kind: "trainer", runId, rootBinding, state: "created",
    deletionProgress: "none", deletionSnapshotSha256: null, quarantine: null, root: rootView, marker })
}

function createDescriptorFile(worktree: string, runId: string, descriptor: ScratchDescriptor): Readonly<{
  path: string; file: ReturnType<typeof safeReadFile>
}> {
  const path = descriptorPath(worktree, runId, true)
  if (!path) throw new SkillOptError("trainer_scratch_descriptor_directory_invalid")
  assertNoDescriptorTemporary(dirname(path), runId)
  try { lstatSync(path); throw new SkillOptError("trainer_scratch_descriptor_exists") }
  catch (error) { if (error instanceof SkillOptError) throw error; if (errorCode(error) !== "ENOENT") throw error }
  const bytes = Buffer.from(`${canonicalJson(descriptor)}\n`, "utf8")
  const file = writeNewPrivateFile(path, bytes, SCRATCH_DESCRIPTOR_BYTES)
  return Object.freeze({ path, file })
}

function recordMatches(record: OwnedTrainerScratch, descriptor: ScratchDescriptor): boolean {
  return record.runId === descriptor.runId && record.descriptor.rootBinding === descriptor.rootBinding &&
    record.descriptor.root.path === descriptor.root.path && record.descriptor.root.dev === descriptor.root.dev &&
    record.descriptor.root.ino === descriptor.root.ino && record.descriptor.root.uid === descriptor.root.uid &&
    record.descriptor.root.mode === descriptor.root.mode && record.descriptor.marker.sha256 === descriptor.marker.sha256 &&
    record.descriptor.marker.dev === descriptor.marker.dev && record.descriptor.marker.ino === descriptor.marker.ino &&
    record.descriptor.marker.uid === descriptor.marker.uid && record.descriptor.marker.mode === descriptor.marker.mode
}

function capturedEntryPath(quarantine: ScratchQuarantine, pathSha256: string): string {
  return join(quarantine.path, `entry-${pathSha256}`)
}

function hasPath(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) { if (errorCode(error) === "ENOENT") return false; throw error }
}

function expectedFileSnapshot(entry: NativeSkillOptTrainerCleanupTreeEntry): PrivateCleanupFileSnapshot {
  if (entry.kind !== "file" || !entry.sha256 || !exactKeys(entry.identity as Record<string, unknown>,
    ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"])) {
    throw new SkillOptError("trainer_scratch_snapshot_file_invalid")
  }
  return Object.freeze({ identity: entry.identity as unknown as ScratchFileIdentity, sha256: entry.sha256 })
}

function inspectCapturedDirectory(path: string, expected: Readonly<Record<string, string>>): void {
  const stat = lstatSync(path, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isDirectory() || String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino ||
      String(stat.uid) !== expected.uid || String(stat.mode & 0o7777n) !== expected.mode || readdirSync(path).length !== 0) {
    throw new SkillOptError("trainer_scratch_quarantine_capture_changed")
  }
}

function validateTrainerQuarantineCaptures(
  quarantine: ScratchQuarantine,
  descriptor: ScratchDescriptor,
  tree: readonly NativeSkillOptTrainerCleanupTreeEntry[],
): Set<string> {
  const byHash = new Map(tree.map(entry => [entry.pathSha256, entry]))
  const captured = new Set<string>()
  for (const name of readdirSync(quarantine.path)) {
    if (name === "root") {
      inspectCapturedDirectory(join(quarantine.path, name), descriptor.root)
      captured.add("root")
      continue
    }
    const pathSha256 = name.slice("entry-".length)
    const expected = byHash.get(pathSha256)
    if (!expected) throw new SkillOptError("trainer_scratch_quarantine_capture_unapproved")
    const path = join(quarantine.path, name)
    if (expected.kind === "file") {
      verifyCapturedPrivateCleanupFile(path, expectedFileSnapshot(expected), SCRATCH_FILE_BYTES)
    } else inspectCapturedDirectory(path, expected.identity)
    captured.add(pathSha256)
  }
  return captured
}

function removeByInspectedSnapshot(
  inspectedValue: InspectedScratch,
  approvedSnapshotSha256: string,
  approvedTree: readonly NativeSkillOptTrainerCleanupTreeEntry[],
): InspectedScratch {
  let inspected = inspectedValue
  const descriptor = inspected.descriptor
  if (!descriptor || !inspected.descriptorFile || !HASH.test(approvedSnapshotSha256)) {
    throw new SkillOptError("trainer_scratch_snapshot_incomplete")
  }

  if (descriptor.deletionProgress === "none") {
    if (!inspected.inventory || !inspected.root || inspected.snapshot.snapshotSha256 !== approvedSnapshotSha256 ||
        descriptor.deletionSnapshotSha256 !== null || !isApprovedPartialTree(approvedTree, snapshotTree(inspected.inventory)) ||
        approvedTree.length !== inspected.inventory.entries.length) {
      throw new SkillOptError("trainer_scratch_snapshot_changed")
    }
    const quarantine = createTrainerQuarantine(descriptor)
    const updated = updateDescriptor(inspected, Object.freeze({ ...descriptor, deletionProgress: "started" as const,
      deletionSnapshotSha256: approvedSnapshotSha256, quarantine: quarantine.identity }))
    inspected = Object.freeze({ ...inspected, descriptor: updated.descriptor, descriptorFile: updated.file })
  } else if (descriptor.deletionProgress !== "started" || descriptor.deletionSnapshotSha256 !== approvedSnapshotSha256) {
    throw new SkillOptError("trainer_scratch_deletion_snapshot_mismatch")
  }

  const activeDescriptor = inspected.descriptor!
  const quarantine = inspectTrainerQuarantine(activeDescriptor)
  const captures = validateTrainerQuarantineCaptures(quarantine, activeDescriptor, approvedTree)
  let currentInventory = inspected.inventory
  if (inspected.root) {
    if (!currentInventory) currentInventory = collectScratchInventory(inspected.root)
    const currentTree = snapshotTree(currentInventory)
    if (descriptor.deletionProgress === "started"
      ? canonicalJson(approvedTree) !== canonicalJson(currentTree) || captures.size !== 0
      : !isApprovedPartialTree(approvedTree, currentTree)) {
      throw new SkillOptError("trainer_scratch_tree_changed")
    }
  } else {
    throw new SkillOptError("trainer_scratch_root_missing_after_recorded")
  }
  const currentByHash = new Map((currentInventory?.entries ?? []).map(entry => [sha256(entry.path), entry]))
  assertNoMountedDescendant(activeDescriptor.root.path)
  const removedEntries = new Set<string>()

  const orderedFiles = approvedTree.filter(entry => entry.kind === "file")
    .sort((left, right) => Number(left.pathSha256 === sha256(SCRATCH_MARKER)) - Number(right.pathSha256 === sha256(SCRATCH_MARKER)))
  for (const entry of orderedFiles) {
    const pathSha256 = entry.pathSha256
    const source = currentByHash.get(pathSha256)
    const captureExists = captures.has(pathSha256)
    if (source && captureExists) throw new SkillOptError("trainer_scratch_quarantine_capture_ambiguous")
    const capturePath = capturedEntryPath(quarantine, pathSha256)
    let capturedSnapshot = expectedFileSnapshot(entry)
    if (source) {
      if (source.kind !== "file") throw new SkillOptError("trainer_scratch_tree_changed")
      const sourcePath = join(activeDescriptor.root.path, ...source.path.split("/"))
      capturedSnapshot = capturePrivateCleanupFile(sourcePath, capturePath, capturedSnapshot, SCRATCH_FILE_BYTES)
      captures.add(pathSha256)
    }
    if (captures.has(pathSha256)) {
      verifyCapturedPrivateCleanupFile(capturePath, capturedSnapshot, SCRATCH_FILE_BYTES)
      unlinkSync(capturePath)
      syncPrivateCleanupDirectory(quarantine.path)
      captures.delete(pathSha256)
      removedEntries.add(pathSha256)
    }
  }

  const orderedDirectories = approvedTree.filter(entry => entry.kind === "directory")
    .sort((left, right) => right.depth - left.depth || right.pathSha256.localeCompare(left.pathSha256))
  for (const entry of orderedDirectories) {
    const pathSha256 = entry.pathSha256
    const source = currentByHash.get(pathSha256)
    const captureExists = captures.has(pathSha256)
    if (source && captureExists) throw new SkillOptError("trainer_scratch_quarantine_capture_ambiguous")
    const capturePath = capturedEntryPath(quarantine, pathSha256)
    if (source) {
      if (source.kind !== "directory") throw new SkillOptError("trainer_scratch_tree_changed")
      const sourcePath = join(activeDescriptor.root.path, ...source.path.split("/"))
      captureEmptyPrivateCleanupDirectory(sourcePath, capturePath, {
        dev: entry.identity.dev!, ino: entry.identity.ino!, uid: entry.identity.uid!, mode: entry.identity.mode!,
      })
      captures.add(pathSha256)
    }
    if (captures.has(pathSha256)) {
      inspectCapturedDirectory(capturePath, entry.identity)
      rmdirSync(capturePath)
      syncPrivateCleanupDirectory(quarantine.path)
      captures.delete(pathSha256)
      removedEntries.add(pathSha256)
    }
  }

  let rootRemoved = false
  if (hasPath(activeDescriptor.root.path)) {
    const rootIdentity = activeDescriptor.root
    const rootPath = activeDescriptor.root.path
    const rootCapture = join(quarantine.path, "root")
    if (hasPath(rootCapture)) throw new SkillOptError("trainer_scratch_quarantine_root_ambiguous")
    const finalInventory = collectScratchInventory(Object.freeze({ path: rootPath, dev: BigInt(rootIdentity.dev),
      ino: BigInt(rootIdentity.ino), uid: BigInt(rootIdentity.uid), mode: BigInt(rootIdentity.mode) }))
    if (finalInventory.entries.length !== 0) throw new SkillOptError("trainer_scratch_tree_changed")
    captureEmptyPrivateCleanupDirectory(rootPath, rootCapture, rootIdentity)
    rmdirSync(rootCapture)
    syncPrivateCleanupDirectory(quarantine.path)
    rootRemoved = true
  } else if (hasPath(join(quarantine.path, "root"))) {
    inspectCapturedDirectory(join(quarantine.path, "root"), activeDescriptor.root)
    rmdirSync(join(quarantine.path, "root"))
    syncPrivateCleanupDirectory(quarantine.path)
    rootRemoved = true
  }
  if (removedEntries.size !== approvedTree.length || !rootRemoved || captures.size !== 0 ||
      readdirSync(quarantine.path).length !== 0) {
    throw new SkillOptError("trainer_scratch_quarantine_not_empty")
  }
  const latest = readDescriptorFile(inspected.descriptorPath!, inspected.worktree!, descriptor.runId)
  if (!inspected.descriptorFile || latest.descriptor.deletionProgress !== "started" ||
      latest.descriptor.deletionSnapshotSha256 !== approvedSnapshotSha256 ||
      canonicalJson(latest.descriptor.quarantine) !== canonicalJson(activeDescriptor.quarantine) ||
      !sameIdentity(latest.file.identity, inspected.descriptorFile.identity) ||
      !latest.file.bytes.equals(inspected.descriptorFile.bytes) || hasPath(latest.descriptor.root.path)) {
    throw new SkillOptError("trainer_scratch_deletion_unverified")
  }
  const completed = Object.freeze({ ...latest.descriptor, deletionProgress: "complete" as const })
  updateDescriptor(inspected, completed)
  const result = inspectScratch(inspected.worktree!, descriptor.runId)
  if (result.snapshot.state !== "deleted") throw new SkillOptError("trainer_scratch_deletion_unverified")
  return result
}

function cleanupTrackedScratch(record: OwnedTrainerScratch, preparationFailure = false): boolean {
  if (record.cleaned) {
    try { return inspectScratch(record.worktree, record.runId).snapshot.state === "deleted" }
    catch { return false }
  }
  if (!preparationFailure) {
    const launched = !!record.profile && !!record.receipt && hasLaunchedNativeSkillOptTrainerWorker(record.profile, record.receipt)
    if (launched && !record.workerClosed) return false
    if (record.workerClosed && !launched) return false
  }
  try {
    const inspected = inspectScratch(record.worktree, record.runId)
    const descriptor = inspected.descriptor
    if (inspected.snapshot.state === "deleted") { record.cleaned = true; return true }
    if (!descriptor || !recordMatches(record, descriptor)) return false
    if (descriptor.state === "created" && record.workerClosed) return false
    if (descriptor.state === "worker-closed" && !record.workerClosed) return false
    if (!preparationFailure && descriptor.state === "created" && record.profile && record.receipt &&
        hasLaunchedNativeSkillOptTrainerWorker(record.profile, record.receipt)) return false
    if (!record.cleanupSnapshot) {
      if (descriptor.deletionProgress !== "none" || !inspected.inventory || !inspected.root) return false
      record.cleanupSnapshot = inspected.snapshot
    }
    if (descriptor.deletionProgress === "started" &&
        descriptor.deletionSnapshotSha256 !== record.cleanupSnapshot.snapshotSha256) return false
    const result = removeByInspectedSnapshot(inspected, record.cleanupSnapshot.snapshotSha256!, record.cleanupSnapshot.tree)
    if (result.snapshot.state !== "deleted") return false
    record.descriptor = result.descriptor ?? record.descriptor
    record.cleaned = true
    return true
  } catch { return false }
}

/** Mark only the exact trainer returned by preparation, after its genuine worker result and artifact validation. */
export function markNativeSkillOptTrainerClosed(trainer: CampaignTrainer, result: OwnedWorkerResult): void {
  if (!trainer || typeof trainer !== "object") return
  let record = trainerScratch.get(trainer)
  if (!record) {
    const profile = trainer.profile && typeof trainer.profile === "object" ? trainer.profile : undefined
    const receipt = trainer.receipt && typeof trainer.receipt === "object" ? trainer.receipt : undefined
    record = (profile ? trainerScratchByProfile.get(profile) : undefined) ??
      (receipt ? trainerScratchByReceipt.get(receipt) : undefined)
    if (!record) return
    throw new SkillOptError("trainer_scratch_trainer_identity_mismatch")
  }
  try {
    if (record.profile !== trainer.profile || record.receipt !== trainer.receipt || record.workerClosed ||
        !hasLaunchedNativeSkillOptTrainerWorker(trainer.profile, trainer.receipt) ||
        !isGenuineCompletedQuiescentTrainerResult(result, trainer.profile, trainer.receipt)) {
      throw new SkillOptError("trainer_scratch_worker_completion_unowned")
    }
    const inspected = inspectScratch(record.worktree, record.runId)
    if (!inspected.descriptor || !recordMatches(record, inspected.descriptor) || inspected.snapshot.state !== "created" ||
        inspected.descriptor.deletionProgress !== "none" || !inspected.inventory) {
      throw new SkillOptError("trainer_scratch_created_record_invalid")
    }
    const closed = Object.freeze({ ...inspected.descriptor, state: "worker-closed" as const })
    const persisted = updateDescriptor(inspected, closed)
    record.descriptor = persisted.descriptor
    record.workerClosed = true
  } catch (error) {
    if (error instanceof SkillOptError) throw error
    throw new SkillOptError("trainer_scratch_worker_closure_failed")
  }
}

/** Inspects only this fixed trainer run; absent metadata is null, while all unsafe and unclosed records throw. */
export function inspectNativeSkillOptTrainerCleanup(
  worktree: string,
  runId: string,
): NativeSkillOptTrainerCleanupSnapshot | null {
  if (!safeRunId(runId)) throw new SkillOptError("trainer_run_id_invalid")
  const inspected = inspectScratch(worktree, runId)
  if (inspected.snapshot.state === "absent") return null
  if (inspected.snapshot.state === "created") throw new SkillOptError("trainer_scratch_worker_not_closed")
  if (inspected.snapshot.deletionProgress === "started") throw new SkillOptError("trainer_scratch_cleanup_incomplete")
  return publicCleanupSnapshot(inspected.snapshot)
}

/** Removes only the approved snapshot; the immutable initial snapshot also authorizes explicit partial retries. */
export function deleteNativeSkillOptTrainerCleanup(
  worktree: string,
  runId: string,
  snapshot: NativeSkillOptTrainerCleanupSnapshot,
  token: SkillOptPrivateTextDeletion,
): boolean {
  try {
    if (!safeRunId(runId)) return false
    snapshot = JSON.parse(canonicalJson(snapshot)) as NativeSkillOptTrainerCleanupSnapshot
    if (!isCleanupSnapshot(snapshot) || snapshot.runId !== runId) return false
  } catch { return false }
  try {
    const inspected = inspectScratch(worktree, runId)
    const descriptor = inspected.descriptor
    if (!descriptor || inspected.snapshot.state === "absent" || inspected.snapshot.state === "created" ||
        descriptor.rootBinding !== snapshot.rootBinding) return false
    if (snapshot.state === "deleted") {
      if (inspected.snapshot.state !== "deleted" || inspected.snapshot.snapshotSha256 !== snapshot.snapshotSha256 ||
          descriptor.deletionProgress !== "complete") return false
      consumePrivateTextCleanupDeletion(token, { worktree, runId, kind: "trainer", snapshotSha256: snapshot.snapshotSha256 })
      return true
    }
    if (snapshot.state !== "worker-closed") return false
    if (inspected.snapshot.state === "deleted") {
      if (descriptor.deletionSnapshotSha256 !== snapshot.snapshotSha256 || descriptor.deletionProgress !== "complete") return false
      consumePrivateTextCleanupDeletion(token, { worktree, runId, kind: "trainer", snapshotSha256: snapshot.snapshotSha256 })
      return true
    }
    if (inspected.snapshot.state !== "worker-closed") return false
    if (descriptor.deletionProgress === "none") {
      const current = publicCleanupSnapshot(inspected.snapshot)
      if (canonicalJson(current) !== canonicalJson(snapshot)) return false
    } else {
      if (descriptor.deletionProgress !== "started" || descriptor.deletionSnapshotSha256 !== snapshot.snapshotSha256 ||
          !inspected.root || !inspected.inventory || canonicalJson(snapshot.tree) !== canonicalJson(inspected.snapshot.tree)) return false
      const quarantine = inspectTrainerQuarantine(descriptor)
      if (validateTrainerQuarantineCaptures(quarantine, descriptor, snapshot.tree).size !== 0) return false
    }
    consumePrivateTextCleanupDeletion(token, { worktree, runId, kind: "trainer", snapshotSha256: snapshot.snapshotSha256 })
    return removeByInspectedSnapshot(inspected, snapshot.snapshotSha256, snapshot.tree).snapshot.state === "deleted"
  } catch { return false }
}

function workerErrorCode(error: unknown): string {
  if (error instanceof SkillOptWorkerError || error instanceof SkillOptError || error instanceof SkillOptControllerError) return error.code
  return "trainer_preparation_failed"
}

function modelAndDatasetMatch(dataset: NativeDataset, prepared: SkillOptPrepared, baselineSkillBytes: Uint8Array): boolean {
  return baselineSkillBytes.byteLength > 0 && baselineSkillBytes.byteLength <= PILOT_LIMITS.skillBytes &&
    prepared.state === "PREPARED" && HASH.test(prepared.baselineSkillSha256) &&
    sha256(baselineSkillBytes) === prepared.baselineSkillSha256 &&
    prepared.sourceExportSha256 === dataset.sourceExportSha256 &&
    prepared.fixturePackSha256 === dataset.fixturePackSha256 &&
    prepared.datasetSha256 === dataset.datasetSha256 && prepared.protocolSha256 === dataset.protocolSha256 &&
    prepared.modelBindingsSha256 === sha256(canonicalJson(dataset.modelBindings))
}

/** Serializes the exact trainer payloads without writing them; the opaque plan keeps their bytes private. */
export function planNativeSkillOptTrainerMaterialization(
  input: NativeSkillOptTrainerMaterializationPlanInput,
): NativeSkillOptTrainerMaterializationPlan {
  const worktree = canonicalWorktree(input.worktree)
  const runId = input.prepared.runId
  if (!safeRunId(runId)) throw new SkillOptError("trainer_run_id_invalid")
  const dataset = validateNativeDataset(worktree, input.dataset)
  if (dataset.status !== "STRUCTURALLY_VALID") throw new SkillOptError(dataset.requirements[0] ?? "fixture_pack_data_required")
  if (!modelAndDatasetMatch(dataset, input.prepared, input.baselineSkillBytes)) {
    throw new SkillOptError("trainer_campaign_binding_mismatch")
  }
  const baselineSkillBytes = Buffer.from(input.baselineSkillBytes)
  if (baselineSkillBytes.byteLength > PILOT_LIMITS.skillBytes ||
      !readBoundedSource(worktree, PILOT_SKILL, PILOT_LIMITS.skillBytes).equals(baselineSkillBytes)) {
    throw new SkillOptError("trainer_baseline_changed")
  }
  const originalSkillSha256 = sha256(baselineSkillBytes)
  const sourceLockBytes = readBoundedSource(REPO_ROOT, SOURCE_LOCK_PATH, SOURCE_LOCK_BYTES)
  const sourceLockSha256 = sha256(sourceLockBytes)
  if (!sourceLockBytes.equals(readBoundedSource(REPO_ROOT, SOURCE_LOCK_PATH, SOURCE_LOCK_BYTES))) {
    throw new SkillOptError("trainer_source_lock_changed")
  }
  const projectionBytes = Buffer.from(canonicalJson(trainerSafeProjection(dataset)), "utf8")
  if (projectionBytes.byteLength > NATIVE_DATASET_LIMITS.trainerInputBytes) throw new SkillOptError("trainer_input_limit")
  const manifest = buildNativeAdapterManifest({ fixturePack: dataset.fixturePack, runId,
    originalSkillSha256, sourceLockSha256 })
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8")
  if (manifest.originalSkillSha256 !== input.prepared.baselineSkillSha256 || manifest.sourceLockSha256 !== sourceLockSha256 ||
      manifest.runId !== runId) throw new SkillOptError("trainer_manifest_binding_mismatch")
  const metadata: SkillOptNativeTrainerMaterializationMetadata = Object.freeze({
    runId, rootBinding: sha256(`root:${worktree}`), bindingSha256: input.prepared.bindingSha256,
    projectionSha256: sha256(projectionBytes), projectionBytes: projectionBytes.byteLength,
    manifestSha256: sha256(manifestBytes), manifestBytes: manifestBytes.byteLength,
  })
  const plan = Object.freeze({}) as NativeSkillOptTrainerMaterializationPlan
  trainerMaterializationPlans.set(plan as object, {
    worktree, runId, prepared: input.prepared, runtime: Object.freeze({ ...input.runtime }),
    datasetSha256: dataset.datasetSha256, baselineSkillSha256: originalSkillSha256, sourceLockSha256,
    projectionBytes, manifestBytes, metadata, used: false,
  })
  return plan
}

/** Public planning metadata contains only stable hashes and byte counts, never serialized payloads. */
export function nativeSkillOptTrainerMaterializationMetadata(
  plan: NativeSkillOptTrainerMaterializationPlan,
): SkillOptNativeTrainerMaterializationMetadata {
  const state = plan && typeof plan === "object" ? trainerMaterializationPlans.get(plan as object) : undefined
  if (!state) throw new SkillOptError("trainer_materialization_plan_invalid")
  return Object.freeze({ ...state.metadata })
}

/** Builds a real, private trainer profile and accepts it only after the host's genuine containment probes pass. */
export async function prepareNativeSkillOptTrainer(input: NativeSkillOptTrainerInput): Promise<NativeSkillOptTrainerPreparation> {
  if (!input.runtime) return failure("DATA_REQUIRED", "trainer_runtime_required")
  let rootIdentity: DirectoryIdentity | undefined
  let scratch: OwnedTrainerScratch | undefined
  try {
    const worktree = canonicalWorktree(input.worktree)
    const runId = input.prepared.runId
    const plan = input.plan && typeof input.plan === "object" ? trainerMaterializationPlans.get(input.plan as object) : undefined
    if (!safeRunId(runId) || !plan || plan.used || input.prepared !== plan.prepared || worktree !== plan.worktree ||
        runId !== plan.runId || input.runtime.executablePath !== plan.runtime.executablePath ||
        input.runtime.nativeRuntimeProofPath !== plan.runtime.nativeRuntimeProofPath || !input.owner || !input.executionRuntime ||
        !input.controller || !input.current || !input.allowance ||
        plan.projectionBytes.byteLength !== plan.metadata.projectionBytes ||
        sha256(plan.projectionBytes) !== plan.metadata.projectionSha256 ||
        plan.manifestBytes.byteLength !== plan.metadata.manifestBytes ||
        sha256(plan.manifestBytes) !== plan.metadata.manifestSha256) {
      throw new SkillOptError("trainer_materialization_plan_invalid")
    }
    const dataset = validateNativeDataset(worktree, input.dataset)
    if (dataset.status !== "STRUCTURALLY_VALID") return failure("DATA_REQUIRED", dataset.requirements[0] ?? "fixture_pack_data_required")
    if (dataset.datasetSha256 !== plan.datasetSha256 || !modelAndDatasetMatch(dataset, input.prepared, input.baselineSkillBytes)) {
      throw new SkillOptError("trainer_campaign_binding_mismatch")
    }
    const baselineSkillBytes = Buffer.from(input.baselineSkillBytes)
    if (baselineSkillBytes.byteLength > PILOT_LIMITS.skillBytes || sha256(baselineSkillBytes) !== plan.baselineSkillSha256 ||
        !readBoundedSource(worktree, PILOT_SKILL, PILOT_LIMITS.skillBytes).equals(baselineSkillBytes)) {
      throw new SkillOptError("trainer_baseline_changed")
    }
    const originalSkillSha256 = sha256(baselineSkillBytes)
    const sourceLockBytes = readBoundedSource(REPO_ROOT, SOURCE_LOCK_PATH, SOURCE_LOCK_BYTES)
    const sourceLockSha256 = sha256(sourceLockBytes)
    const sourceLockAfter = readBoundedSource(REPO_ROOT, SOURCE_LOCK_PATH, SOURCE_LOCK_BYTES)
    if (!sourceLockBytes.equals(sourceLockAfter) || sourceLockSha256 !== plan.sourceLockSha256) {
      throw new SkillOptError("trainer_source_lock_changed")
    }
    const currentProjectionBytes = Buffer.from(canonicalJson(trainerSafeProjection(dataset)), "utf8")
    const manifest = buildNativeAdapterManifest({ fixturePack: dataset.fixturePack, runId: input.prepared.runId,
      originalSkillSha256, sourceLockSha256 })
    const currentManifestBytes = Buffer.from(canonicalJson(manifest), "utf8")
    if (manifest.originalSkillSha256 !== input.prepared.baselineSkillSha256 || manifest.sourceLockSha256 !== sourceLockSha256 ||
        manifest.runId !== input.prepared.runId || !currentProjectionBytes.equals(plan.projectionBytes) ||
        !currentManifestBytes.equals(plan.manifestBytes)) {
      throw new SkillOptError("trainer_materialization_changed")
    }
    const protocolStageAllowance: SkillOptNativeTrainerProtocolStageAllowance =
      input.controller.consumeNativeTrainerMaterializationAllowance(input.allowance, {
        owner: input.owner, runtime: input.executionRuntime, prepared: input.prepared, current: input.current,
        materialization: plan.metadata,
      })
    plan.used = true
    const projectionBytes = plan.projectionBytes
    const manifestBytes = plan.manifestBytes
    const manifestSha256 = plan.metadata.manifestSha256

    const rootBinding = plan.metadata.rootBinding
    const targetDescriptor = descriptorPath(worktree, runId, true)
    if (!targetDescriptor) throw new SkillOptError("trainer_scratch_descriptor_directory_invalid")
    assertNoDescriptorTemporary(dirname(targetDescriptor), runId)
    try { lstatSync(targetDescriptor); throw new SkillOptError("trainer_scratch_descriptor_exists") }
    catch (error) { if (error instanceof SkillOptError) throw error; if (errorCode(error) !== "ENOENT") throw error }
    const parent = realpathSync.native(tmpdir())
    const created = mkdtempSync(join(parent, `${SCRATCH_PREFIX}${runId}-${rootBinding}-`))
    const root = realpathSync.native(created)
    if (root !== created || dirname(root) !== parent) throw new SkillOptError("trainer_scratch_path_invalid")
    rootIdentity = exactDirectory(root)
    const descriptor = createScratchDescriptor(rootIdentity, runId, rootBinding)
    const persistedDescriptor = createDescriptorFile(worktree, runId, descriptor)
    scratch = { worktree, runId, descriptorPath: persistedDescriptor.path, descriptor,
      workerClosed: false, cleaned: false }

    const inputDirectory = join(root, "input")
    const outputDirectory = join(root, "output")
    const emptyHomeDirectory = join(root, "home")
    const probeDirectory = join(root, "probe")
    for (const directory of [inputDirectory, outputDirectory, emptyHomeDirectory, probeDirectory]) {
      mkdirSync(directory, { mode: 0o700 })
      exactDirectory(directory)
    }
    const selectedInputPath = join(inputDirectory, "trainer-input.json")
    const adapterManifestPath = join(inputDirectory, "protocol.json")
    writePrivateFile(selectedInputPath, projectionBytes)
    writePrivateFile(adapterManifestPath, manifestBytes)
    if (rootIdentity) assertKnownRoot(rootIdentity)

    const profile: SkillOptWorkerProfile = prepareWorkerProfile({
      role: "trainer", executablePath: input.runtime.executablePath,
      nativeRuntimeProofPath: input.runtime.nativeRuntimeProofPath, selectedInputPath,
      outputDirectory, emptyHomeDirectory, probeDirectory, adapterManifestPath,
      protocolStageAllowance,
    })
    if (rootIdentity) assertKnownRoot(rootIdentity)
    if (profile.schema !== "skillopt.worker-profile.v1" || profile.binding.role !== "trainer" ||
        profile.binding.inputSha256 !== sha256(projectionBytes) || profile.binding.adapterManifestSha256 !== manifestSha256 ||
        profile.binding.runtime.kind !== "python" || profile.binding.runtime.sourceLockSha256 !== sourceLockSha256) {
      throw new SkillOptError("trainer_profile_binding_mismatch")
    }
    const receipt: SkillOptContainmentReceipt = await probeWorkerContainment(profile)
    if (rootIdentity) assertKnownRoot(rootIdentity)
    if (scratch) { scratch.profile = profile; scratch.receipt = receipt }
    if (receipt.schema !== "skillopt.worker-containment.v1" || receipt.status !== "READY" ||
        receipt.bindingSha256 !== profile.binding.profileSha256 || !Object.values(receipt.probes).every(Boolean)) {
      cleanFailure(scratch)
      return failure("BLOCKED", receipt.code || "trainer_containment_unavailable")
    }
    const trainer: CampaignTrainer = Object.freeze({ profile, receipt, outputDirectory,
      executablePath: input.runtime.executablePath, nativeRuntimeProofPath: input.runtime.nativeRuntimeProofPath })
    if (!scratch) throw new SkillOptError("trainer_scratch_descriptor_missing")
    scratch.profile = profile
    scratch.receipt = receipt
    trainerScratch.set(trainer, scratch)
    trainerScratchByProfile.set(profile, scratch)
    trainerScratchByReceipt.set(receipt, scratch)
    const cleanup = (): boolean => cleanupTrackedScratch(scratch!)
    return Object.freeze({ state: "READY", trainer, scratchDirectory: root, cleanup })
  } catch (error) {
    cleanFailure(scratch)
    return failure("BLOCKED", workerErrorCode(error))
  }
}
