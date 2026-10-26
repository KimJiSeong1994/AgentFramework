import { randomUUID } from "node:crypto"
import {
  closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, unlinkSync, writeSync,
  type BigIntStats,
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { humanDecision, type OperatorDecision } from "../hosts/operator.ts"
import type { Terminal } from "../hosts/interactive-session.ts"
import { createCliTransport, type CliNativeIdentity } from "../hosts/cli-transport.ts"
import { NATIVE_MODEL_ID_RE, type ExecutionRuntime } from "../hosts/types.ts"
import type { SessionStore } from "../sessions/store.ts"
import { effectiveHold } from "../sessions/admission.ts"
import { durableWriteBytes, ensureDurableDirectory } from "../state/durable.ts"
import { executionRunDirectory } from "../state/store.ts"
import { createNativeDataset, NATIVE_DATASET_LIMITS, validateNativeDataset, validateNativeFixturePack,
  type NativeDataset, type NativeModelBinding, type NativeSourceSelection,
} from "./dataset.ts"
import {
  SkillOptControllerError, skillOptBindingHashes,
  type SkillOptArm, type SkillOptConsent, type SkillOptController, type SkillOptControllerStatus, type SkillOptCurrentBinding,
  consumePrivateTextCleanupDeletion, type SkillOptPrivateTextDeletion, type SkillOptPrepared, type SkillOptRestoredStart,
} from "./controller.ts"
import { createNativeSkillOptBroker, type NativeSkillOptBroker } from "./broker.ts"
import { buildSkillOptNativeHelper } from "./native-helper.ts"
import { NATIVE_SKILLOPT_LIMITS, PILOT_LIMITS, PILOT_SKILL, canonicalJson, readBoundedSource, sha256, SkillOptError } from "./pilot.ts"
import { runNativeSkillOptCampaign, type NativeCampaignResult } from "./campaign.ts"
import {
  prepareNativeSkillOptTrainer, planNativeSkillOptTrainerMaterialization, nativeSkillOptTrainerMaterializationMetadata,
  inspectNativeSkillOptTrainerCleanup, deleteNativeSkillOptTrainerCleanup,
  type NativeSkillOptTrainerPreparation, type NativeSkillOptTrainerCleanupSnapshot,
} from "./trainer.ts"
import { capturePrivateCleanupFile, verifyCapturedPrivateCleanupFile,
  syncPrivateCleanupDirectory, type PrivateCleanupFileSnapshot } from "./private-cleanup.ts"
import { publishQualifiedNativeSkillOptRun, rollbackPublishedNativeSkillOptRun } from "./publication.ts"

export const SKILLOPT_FOREGROUND_INPUT_SCHEMA = "skillopt.native-foreground-input.v1" as const
export const SKILLOPT_FOREGROUND_ARTIFACT_SCHEMA = "skillopt.native-foreground-artifact.v1" as const

export type NativeSkillOptForegroundCampaignData = Readonly<{
  runId: string
  bindingSha256: string
  owner: SessionStore
  runtime: ExecutionRuntime
  broker: NativeSkillOptBroker
  prepared: SkillOptPrepared
  consent: SkillOptConsent
  arm?: SkillOptArm
  current: SkillOptCurrentBinding
  baselineSkillBytes: Buffer
  campaignResult: NativeCampaignResult
  trainer: Extract<NativeSkillOptTrainerPreparation, { state: "READY" }>
}>

type QualifiedRunReceiptState = NativeSkillOptForegroundCampaignData & Readonly<{
  root: string
  isLive(): boolean
}>

const qualifiedRunReceipts = new WeakMap<object, QualifiedRunReceiptState>()

const MAX_INPUT_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_BYTES = MAX_INPUT_BYTES + 4096
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const HASH = /^[a-f0-9]{64}$/u
const OUTPUT_MODEL_METADATA_BYTES = 0

export type SkillOptForegroundInput = Readonly<{
  schema: typeof SKILLOPT_FOREGROUND_INPUT_SCHEMA
  models: Readonly<{
    generator: Readonly<{ engine: "codex" | "claude"; requestedModel: string }>
    target: Readonly<{ engine: "codex" | "claude"; requestedModel: string }>
    reviewer: Readonly<{ engine: "codex" | "claude"; requestedModel: string }>
  }>
  selections?: readonly NativeSourceSelection[]
  fixturePack: unknown
  runtime?: Readonly<{ executablePath: string; nativeRuntimeProofPath: string }>
}>

export class SkillOptForegroundError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "SkillOptForegroundError"
  }
}

function fail(code: string): never {
  throw new SkillOptForegroundError(code)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail("operator_decision_aborted")
}

function isOwnerMismatch(error: unknown): boolean {
  return error instanceof SkillOptControllerError && error.code === "owner-unavailable"
}

function dataRequiredResult(reasonCode: string, requirements: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.freeze({ state: "DATA_REQUIRED", reasonCode, requirements: Object.freeze([...requirements]),
    message: "필수 자료가 필요합니다. 자료 준비 전에는 모델 메타데이터를 조회하지 않습니다.",
    optimizationSucceeded: false, dispatchStarted: false, postApplyHandoffAuthorized: false })
}

/** Consumes one exact in-memory run receipt; its JSON projection cannot recover qualification data. */
export function consumeNativeSkillOptForegroundRunResult(
  receipt: unknown,
  owner: SessionStore,
  runtime: ExecutionRuntime,
): NativeSkillOptForegroundCampaignData {
  const state = receipt && typeof receipt === "object" ? qualifiedRunReceipts.get(receipt) : undefined
  if (!state || state.owner !== owner || state.runtime !== runtime || !state.isLive()) fail("foreground_run_receipt_invalid")
  try { owner.assertOwner() } catch { fail("foreground_run_owner_unavailable") }
  if (realpathSync.native(runtime.worktree) !== state.root) fail("foreground_run_worktree_changed")
  qualifiedRunReceipts.delete(receipt as object)
  return Object.freeze({ runId: state.runId, bindingSha256: state.bindingSha256, owner: state.owner,
    runtime: state.runtime, broker: state.broker, prepared: state.prepared, consent: state.consent,
    ...(state.arm ? { arm: state.arm } : {}), current: state.current,
    baselineSkillBytes: Buffer.from(state.baselineSkillBytes), campaignResult: state.campaignResult, trainer: state.trainer })
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code)
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (required.some((key) => !Object.hasOwn(record, key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) fail(code)
  return record
}

function inputModel(value: unknown): SkillOptForegroundInput["models"]["generator"] {
  const record = exactRecord(value, ["engine", "requestedModel"], [], "input_model_invalid")
  if ((record.engine !== "codex" && record.engine !== "claude") || typeof record.requestedModel !== "string" ||
      !NATIVE_MODEL_ID_RE.test(record.requestedModel) || record.requestedModel.startsWith("-")) fail("input_model_invalid")
  return Object.freeze({ engine: record.engine, requestedModel: record.requestedModel })
}

function selections(value: unknown): readonly NativeSourceSelection[] {
  if (!Array.isArray(value) || value.length > NATIVE_DATASET_LIMITS.sourceFiles) fail("input_selections_invalid")
  return Object.freeze(value.map((item) => {
    const record = exactRecord(item, ["path"], ["excerpt"], "input_selection_invalid")
    if (typeof record.path !== "string") fail("input_selection_invalid")
    if (!Object.hasOwn(record, "excerpt")) return Object.freeze({ path: record.path })
    const excerpt = exactRecord(record.excerpt, ["startByte", "endByte"], [], "input_excerpt_invalid")
    if (!Number.isSafeInteger(excerpt.startByte) || !Number.isSafeInteger(excerpt.endByte)) fail("input_excerpt_invalid")
    return Object.freeze({ path: record.path, excerpt: Object.freeze({ startByte: excerpt.startByte as number, endByte: excerpt.endByte as number }) })
  }))
}

/** Exact code-owned input contract. Unknown keys and caller-supplied model identity are refused. */
export function parseSkillOptForegroundInput(value: unknown): SkillOptForegroundInput {
  let copied: unknown
  try { copied = JSON.parse(canonicalJson(value)) } catch { fail("input_invalid") }
  const record = exactRecord(copied, ["schema", "models", "fixturePack"], ["selections", "runtime"], "input_invalid")
  if (record.schema !== SKILLOPT_FOREGROUND_INPUT_SCHEMA) fail("input_schema_invalid")
  const modelRecord = exactRecord(record.models, ["generator", "target", "reviewer"], [], "input_models_invalid")
  const models = Object.freeze({
    generator: inputModel(modelRecord.generator),
    target: inputModel(modelRecord.target),
    reviewer: inputModel(modelRecord.reviewer),
  })
  if (models.generator.engine === models.reviewer.engine) fail("reviewer_not_independent")
  const selected = Object.hasOwn(record, "selections") ? selections(record.selections) : undefined
  let runtime: SkillOptForegroundInput["runtime"]
  if (Object.hasOwn(record, "runtime")) {
    const runtimeRecord = exactRecord(record.runtime, ["executablePath", "nativeRuntimeProofPath"], [], "input_runtime_invalid")
    if (typeof runtimeRecord.executablePath !== "string" || !isAbsolute(runtimeRecord.executablePath) ||
        typeof runtimeRecord.nativeRuntimeProofPath !== "string" || !isAbsolute(runtimeRecord.nativeRuntimeProofPath) ||
        runtimeRecord.executablePath.length > 4096 || runtimeRecord.nativeRuntimeProofPath.length > 4096) fail("input_runtime_invalid")
    runtime = Object.freeze({ executablePath: runtimeRecord.executablePath, nativeRuntimeProofPath: runtimeRecord.nativeRuntimeProofPath })
  }
  return Object.freeze({ schema: SKILLOPT_FOREGROUND_INPUT_SCHEMA, models,
    ...(selected === undefined ? {} : { selections: selected }), fixturePack: record.fixturePack,
    ...(runtime === undefined ? {} : { runtime }) })
}

export function foregroundFixtureReadiness(inputValue: unknown): Readonly<{
  state: "READY" | "DATA_REQUIRED"; reasonCode?: string; requirements: readonly string[]
}> {
  const input = parseSkillOptForegroundInput(inputValue)
  try {
    const validation = validateNativeFixturePack(input.fixturePack)
    return validation.status === "STRUCTURALLY_VALID"
      ? Object.freeze({ state: "READY", requirements: Object.freeze([]) })
      : Object.freeze({ state: "DATA_REQUIRED", reasonCode: "fixture_pack_data_required", requirements: validation.requirements })
  } catch (error) {
    if (error instanceof SkillOptError) fail(error.code)
    fail("fixture_pack_invalid")
  }
}

function artifactDirectory(root: string): string {
  return join(executionRunDirectory(root), "skillopt-native-foreground")
}

export function foregroundArtifactPath(root: string, runId: string): string {
  if (!UUID.test(runId)) fail("run_id_invalid")
  return join(artifactDirectory(root), `${runId}.json`)
}

function ensurePrivateArtifactDirectory(root: string): string {
  const directory = artifactDirectory(root)
  ensureDurableDirectory(directory)
  const stat = lstatSync(directory)
  const uid = process.geteuid?.()
  if (stat.isSymbolicLink() || !stat.isDirectory() || uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
    fail("artifact_directory_invalid")
  }
  return directory
}

function readOwnedFile(path: string, maxBytes: number, requiredMode?: number): Buffer {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") fail("input_unavailable")
    return fail("input_file_invalid")
  }
  try {
    const before = fstatSync(fd)
    const namedBefore = lstatSync(path)
    const uid = process.geteuid?.()
    if (!before.isFile() || namedBefore.isSymbolicLink() || before.uid !== uid || before.nlink !== 1 ||
        before.size < 1 || before.size > maxBytes || (requiredMode !== undefined && (before.mode & 0o777) !== requiredMode) ||
        namedBefore.dev !== before.dev || namedBefore.ino !== before.ino) fail("input_file_invalid")
    const bytes = Buffer.alloc(before.size + 1)
    let count = 0
    for (;;) {
      const read = readSync(fd, bytes, count, bytes.length - count, count)
      if (read === 0) break
      count += read
      if (count > maxBytes) fail("input_too_large")
    }
    const after = fstatSync(fd)
    const namedAfter = lstatSync(path)
    if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid || after.nlink !== 1 ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        namedAfter.isSymbolicLink() || namedAfter.dev !== after.dev || namedAfter.ino !== after.ino) fail("input_changed")
    return Buffer.from(bytes.subarray(0, count))
  } finally { closeSync(fd) }
}

function decodeJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown }
  catch { return fail("input_json_invalid") }
}

const CLEANUP_SCHEMA = "skillopt.private-text-cleanup.v1"
const MAX_CLEANUP_BYTES = 2 * 1024 * 1024
const CLEANUP_QUARANTINE_SCHEMA = "skillopt.private-cleanup-quarantine.v1"
const CLEANUP_QUARANTINE_MARKER_BYTES = 4 * 1024
// Per retirement: bounded input identity and completion markers, charged again on every retry.
const CLEANUP_QUARANTINE_METADATA_BYTES = 8 * 1024
const FILE_IDENTITY_KEYS = ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const
type CleanupFileIdentity = Readonly<Record<(typeof FILE_IDENTITY_KEYS)[number], string> & { sha256: string }>
type CleanupSnapshot = Readonly<{
  schema: typeof CLEANUP_SCHEMA
  runId: string
  rootBinding: string
  directory: Readonly<{ dev: string; ino: string; uid: string; mode: string }>
  input: CleanupFileIdentity | null
  trainer: NativeSkillOptTrainerCleanupSnapshot | null
}>

function cleanupDirectoryIdentity(root: string): CleanupSnapshot["directory"] {
  const path = artifactDirectory(root)
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.geteuid?.() ?? -1) ||
      (stat.mode & 0o7777n) !== 0o700n || realpathSync.native(path) !== path) fail("cleanup_directory_invalid")
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid), mode: String(stat.mode) })
}

function cleanupInputIdentity(root: string, runId: string): CleanupFileIdentity | null {
  const path = foregroundArtifactPath(root, runId)
  let before: BigIntStats
  try { before = lstatSync(path, { bigint: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null
    throw error
  }
  const bytes = readOwnedFile(path, MAX_ARTIFACT_BYTES, 0o600)
  const after = lstatSync(path, { bigint: true })
  if (before.isSymbolicLink() || !before.isFile() ||
      FILE_IDENTITY_KEYS.some(key => before[key] !== after[key])) fail("cleanup_input_changed")
  return Object.freeze({
    dev: String(after.dev), ino: String(after.ino), uid: String(after.uid), mode: String(after.mode),
    nlink: String(after.nlink), size: String(after.size), mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs),
    sha256: sha256(bytes),
  })
}

function inputQuarantinePath(root: string, runId: string): string {
  return join(artifactDirectory(root), `.${runId}.cleanup-input.v1`)
}

function inspectInputQuarantine(
  root: string,
  runId: string,
  snapshotSha256: string,
  create: boolean,
): Readonly<{ directory: string; capturedPath: string; completed: boolean }> | undefined {
  const directory = inputQuarantinePath(root, runId)
  let directoryStat: BigIntStats
  let createdDirectory = false
  try { directoryStat = lstatSync(directory, { bigint: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") fail("cleanup_input_quarantine_invalid")
    if (!create) return undefined
    try { mkdirSync(directory, { mode: 0o700 }) }
    catch { fail("cleanup_input_quarantine_exists") }
    createdDirectory = true
    const parent = openSync(artifactDirectory(root), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
    try { fsyncSync(parent) } finally { closeSync(parent) }
    directoryStat = lstatSync(directory, { bigint: true })
  }
  const uid = BigInt(process.geteuid?.() ?? -1)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== uid ||
      (directoryStat.mode & 0o7777n) !== 0o700n || realpathSync.native(directory) !== directory) {
    fail("cleanup_input_quarantine_invalid")
  }
  const markerPath = join(directory, "marker.json")
  let markerBytes: Buffer
  try { markerBytes = readOwnedFile(markerPath, CLEANUP_QUARANTINE_MARKER_BYTES, 0o600) }
  catch (error) {
    if (!createdDirectory || !(error instanceof SkillOptForegroundError) || error.code !== "input_unavailable") {
      fail("cleanup_input_quarantine_marker_invalid")
    }
    const marker = Object.freeze({ schema: CLEANUP_QUARANTINE_SCHEMA, kind: "input", runId,
      snapshotSha256, rootBinding: sha256(`root:${root}`), directory: Object.freeze({ dev: String(directoryStat.dev),
        ino: String(directoryStat.ino), uid: String(directoryStat.uid), mode: String(directoryStat.mode & 0o7777n) }) })
    markerBytes = Buffer.from(canonicalJson(marker), "utf8")
    if (markerBytes.byteLength > CLEANUP_QUARANTINE_MARKER_BYTES) fail("cleanup_input_quarantine_metadata_limit")
    let fd: number
    try { fd = openSync(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch { fail("cleanup_input_quarantine_marker_exists") }
    try {
      let offset = 0
      while (offset < markerBytes.byteLength) {
        const written = writeSync(fd, markerBytes, offset, markerBytes.byteLength - offset)
        if (written <= 0) fail("cleanup_input_quarantine_marker_write_failed")
        offset += written
      }
      fsyncSync(fd)
    } finally { closeSync(fd) }
    syncPrivateCleanupDirectory(directory)
  }
  let parsed: unknown
  try { parsed = JSON.parse(markerBytes.toString("utf8")) } catch { fail("cleanup_input_quarantine_marker_invalid") }
  const record = exactRecord(parsed, ["schema", "kind", "runId", "snapshotSha256", "rootBinding", "directory"], [],
    "cleanup_input_quarantine_marker_invalid")
  const expectedDirectory = { dev: String(directoryStat.dev), ino: String(directoryStat.ino), uid: String(directoryStat.uid),
    mode: String(directoryStat.mode & 0o7777n) }
  const expected = Object.freeze({ schema: CLEANUP_QUARANTINE_SCHEMA, kind: "input", runId, snapshotSha256,
    rootBinding: sha256(`root:${root}`), directory: expectedDirectory })
  const names = readdirSync(directory)
  if (!markerBytes.equals(Buffer.from(canonicalJson(expected), "utf8")) ||
      canonicalJson(record) !== canonicalJson(expected) || names.length > 2 ||
      names.some(name => name !== "marker.json" && name !== "captured" && name !== "deleted.json")) {
    fail("cleanup_input_quarantine_marker_mismatch")
  }
  const completed = names.includes("deleted.json")
  if (completed) {
    const expectedCompletion = Buffer.from(canonicalJson({
      schema: "skillopt.private-input-deleted.v1", markerSha256: sha256(markerBytes),
    }), "utf8")
    if (names.includes("captured") ||
        !readOwnedFile(join(directory, "deleted.json"), CLEANUP_QUARANTINE_MARKER_BYTES, 0o600).equals(expectedCompletion)) {
      fail("cleanup_input_completion_invalid")
    }
  }
  const afterDirectory = lstatSync(directory, { bigint: true })
  if (afterDirectory.isSymbolicLink() || !afterDirectory.isDirectory() || afterDirectory.dev !== directoryStat.dev ||
      afterDirectory.ino !== directoryStat.ino || afterDirectory.uid !== directoryStat.uid || afterDirectory.mode !== directoryStat.mode ||
      realpathSync.native(directory) !== directory || canonicalJson(readdirSync(directory).sort()) !== canonicalJson(names.sort())) {
    fail("cleanup_input_quarantine_changed")
  }
  return Object.freeze({ directory, capturedPath: join(directory, "captured"), completed })
}

function persistInputCleanupCompletion(directory: string): void {
  const marker = readOwnedFile(join(directory, "marker.json"), CLEANUP_QUARANTINE_MARKER_BYTES, 0o600)
  const bytes = Buffer.from(canonicalJson({
    schema: "skillopt.private-input-deleted.v1", markerSha256: sha256(marker),
  }), "utf8")
  if (bytes.byteLength > CLEANUP_QUARANTINE_MARKER_BYTES) fail("cleanup_input_quarantine_metadata_limit")
  const fd = openSync(join(directory, "deleted.json"),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset)
      if (written <= 0) fail("cleanup_input_completion_write_failed")
      offset += written
    }
    fsyncSync(fd)
  } finally { closeSync(fd) }
  syncPrivateCleanupDirectory(directory)
}

function inputSnapshotFile(snapshot: CleanupSnapshot): PrivateCleanupFileSnapshot | null {
  if (!snapshot.input) return null
  return Object.freeze({ identity: Object.freeze({ dev: snapshot.input.dev, ino: snapshot.input.ino,
    uid: snapshot.input.uid, mode: String(BigInt(snapshot.input.mode) & 0o7777n), nlink: snapshot.input.nlink,
    size: snapshot.input.size, mtimeNs: snapshot.input.mtimeNs, ctimeNs: snapshot.input.ctimeNs }),
  sha256: snapshot.input.sha256 })
}

function inputQuarantineCaptured(
  quarantine: Readonly<{ directory: string; capturedPath: string }>,
): boolean {
  try { lstatSync(quarantine.capturedPath); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false
    fail("cleanup_input_quarantine_capture_invalid")
  }
}

function cleanupSnapshot(root: string, runId: string): { snapshot: CleanupSnapshot; persisted: boolean } {
  const directory = cleanupDirectoryIdentity(root)
  const path = join(artifactDirectory(root), `${runId}.cleanup.json`)
  let bytes: Buffer | undefined
  try { bytes = readOwnedFile(path, MAX_CLEANUP_BYTES, 0o600) }
  catch (error) {
    if (!(error instanceof SkillOptForegroundError) || error.code !== "input_unavailable") throw error
  }
  if (!bytes) {
    try { lstatSync(inputQuarantinePath(root, runId)); fail("cleanup_input_quarantine_unbound") }
    catch (error) {
      if (error instanceof SkillOptForegroundError) throw error
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") fail("cleanup_input_quarantine_invalid")
    }
    return { snapshot: Object.freeze({ schema: CLEANUP_SCHEMA, runId, rootBinding: sha256(`root:${root}`),
      directory, input: cleanupInputIdentity(root, runId), trainer: inspectNativeSkillOptTrainerCleanup(root, runId) }),
      persisted: false }
  }
  const value = exactRecord(decodeJson(bytes), ["schema", "runId", "rootBinding", "directory", "input", "trainer"], [], "cleanup_snapshot_invalid")
  if (value.schema !== CLEANUP_SCHEMA || value.runId !== runId || value.rootBinding !== sha256(`root:${root}`) ||
      canonicalJson(value.directory) !== canonicalJson(directory)) fail("cleanup_snapshot_invalid")
  if (value.input !== null) {
    const input = exactRecord(value.input, [...FILE_IDENTITY_KEYS, "sha256"], [], "cleanup_snapshot_invalid")
    if (FILE_IDENTITY_KEYS.some(key => typeof input[key] !== "string" || !/^[0-9]{1,30}$/u.test(input[key] as string)) ||
        typeof input.sha256 !== "string" || !HASH.test(input.sha256) || input.nlink !== "1" ||
        input.uid !== directory.uid || !Number.isSafeInteger(Number(input.size)) ||
        Number(input.size) < 1 || Number(input.size) > MAX_ARTIFACT_BYTES) fail("cleanup_snapshot_invalid")
  }
  if (value.trainer !== null && (!value.trainer || typeof value.trainer !== "object" || Array.isArray(value.trainer))) {
    fail("cleanup_snapshot_invalid")
  }
  return { snapshot: value as CleanupSnapshot, persisted: true }
}

function persistCleanupSnapshot(root: string, snapshot: CleanupSnapshot): void {
  const bytes = Buffer.from(canonicalJson(snapshot), "utf8")
  if (bytes.byteLength > MAX_CLEANUP_BYTES) fail("cleanup_snapshot_too_large")
  const path = join(artifactDirectory(root), `${snapshot.runId}.cleanup.json`)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset)
      if (written <= 0) fail("cleanup_snapshot_write_failed")
      offset += written
    }
    fsyncSync(fd)
  } finally { closeSync(fd) }
  const directory = openSync(artifactDirectory(root), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

function deleteCleanupInput(
  root: string,
  snapshot: CleanupSnapshot,
  token: SkillOptPrivateTextDeletion,
  artifactsSha256: string,
): void {
  if (canonicalJson(cleanupDirectoryIdentity(root)) !== canonicalJson(snapshot.directory)) fail("cleanup_directory_changed")
  const current = cleanupInputIdentity(root, snapshot.runId)
  let expected = inputSnapshotFile(snapshot)
  const sourcePath = foregroundArtifactPath(root, snapshot.runId)
  const sourceExists = current !== null
  if (expected === null ? sourceExists : sourceExists && canonicalJson(current) !== canonicalJson(snapshot.input)) {
    fail("cleanup_input_changed")
  }
  let quarantine = inspectInputQuarantine(root, snapshot.runId, artifactsSha256, false)
  const capturedExists = quarantine ? inputQuarantineCaptured(quarantine) : false
  if (snapshot.input === null) {
    if (quarantine || sourceExists) fail("cleanup_input_changed")
  } else if (quarantine) {
    if (sourceExists && (capturedExists || quarantine.completed)) fail("cleanup_input_ambiguous")
    if (capturedExists) verifyCapturedPrivateCleanupFile(quarantine.capturedPath, expected!, MAX_ARTIFACT_BYTES)
    if (!sourceExists && !capturedExists && !quarantine.completed) fail("cleanup_input_missing_unproven")
  } else if (!sourceExists) {
    fail("cleanup_input_missing_unproven")
  }

  consumePrivateTextCleanupDeletion(token, { worktree: root, runId: snapshot.runId, kind: "input", snapshotSha256: artifactsSha256 })
  if (snapshot.input === null) {
    if (cleanupInputIdentity(root, snapshot.runId) !== null ||
        inspectInputQuarantine(root, snapshot.runId, artifactsSha256, false)) fail("cleanup_input_changed")
    return
  }
  quarantine ??= inspectInputQuarantine(root, snapshot.runId, artifactsSha256, true)
  if (!quarantine) fail("cleanup_input_quarantine_unavailable")
  let deletedNow = false
  if (sourceExists) {
    if (inputQuarantineCaptured(quarantine)) fail("cleanup_input_ambiguous")
    try { expected = capturePrivateCleanupFile(sourcePath, quarantine.capturedPath, expected!, MAX_ARTIFACT_BYTES) }
    catch { fail("cleanup_input_capture_changed") }
  }
  if (inputQuarantineCaptured(quarantine)) {
    try { verifyCapturedPrivateCleanupFile(quarantine.capturedPath, expected!, MAX_ARTIFACT_BYTES) }
    catch { fail("cleanup_input_capture_changed") }
    unlinkSync(quarantine.capturedPath)
    syncPrivateCleanupDirectory(quarantine.directory)
    deletedNow = true
  }
  try { lstatSync(sourcePath); fail("cleanup_input_recreated") }
  catch (error) {
    if (error instanceof SkillOptForegroundError) throw error
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") fail("cleanup_input_recreated")
  }
  const verifiedQuarantine = inspectInputQuarantine(root, snapshot.runId, artifactsSha256, false)
  if (!verifiedQuarantine || inputQuarantineCaptured(verifiedQuarantine)) fail("cleanup_input_quarantine_incomplete")
  if (!verifiedQuarantine.completed) {
    if (!deletedNow) fail("cleanup_input_missing_unproven")
    persistInputCleanupCompletion(verifiedQuarantine.directory)
  }
  if (!inspectInputQuarantine(root, snapshot.runId, artifactsSha256, false)?.completed) fail("cleanup_input_completion_invalid")
  syncPrivateCleanupDirectory(artifactDirectory(root))
}

export function readSkillOptForegroundInput(path: string): SkillOptForegroundInput {
  if (typeof path !== "string" || path.length === 0) fail("input_path_invalid")
  return parseSkillOptForegroundInput(decodeJson(readOwnedFile(resolve(path), MAX_INPUT_BYTES)))
}

export type SkillOptForegroundArtifact = Readonly<{
  input: SkillOptForegroundInput
  bindingSha256: string
  inputSha256: string
}>

export function readSkillOptForegroundArtifact(root: string, runId: string): SkillOptForegroundArtifact {
  const directory = artifactDirectory(root)
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") fail("artifact_unavailable")
    fail("artifact_directory_invalid")
  }
  const uid = process.geteuid?.()
  if (stat.isSymbolicLink() || !stat.isDirectory() || uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
    fail("artifact_directory_invalid")
  }
  let bytes: Buffer
  try { bytes = readOwnedFile(foregroundArtifactPath(root, runId), MAX_ARTIFACT_BYTES, 0o600) }
  catch (error) {
    if (error instanceof SkillOptForegroundError && error.code === "input_unavailable") fail("artifact_unavailable")
    throw error
  }
  const parsed = exactRecord(decodeJson(bytes),
    ["schema", "runId", "bindingSha256", "inputSha256", "input"], [], "artifact_invalid")
  if (parsed.schema !== SKILLOPT_FOREGROUND_ARTIFACT_SCHEMA || parsed.runId !== runId ||
      typeof parsed.bindingSha256 !== "string" || !HASH.test(parsed.bindingSha256) ||
      typeof parsed.inputSha256 !== "string" || !HASH.test(parsed.inputSha256)) fail("artifact_invalid")
  const input = parseSkillOptForegroundInput(parsed.input)
  const inputSha256 = sha256(canonicalJson(input))
  if (inputSha256 !== parsed.inputSha256) fail("artifact_digest_mismatch")
  return Object.freeze({ input, bindingSha256: parsed.bindingSha256, inputSha256 })
}

function identityFor(model: SkillOptForegroundInput["models"]["generator"]): Promise<CliNativeIdentity> {
  const transport = createCliTransport({ engine: model.engine, model: model.requestedModel, prompt: "",
    deadlineAt: Date.now() + 10_000, maxOutputBytes: OUTPUT_MODEL_METADATA_BYTES })
  if (!transport.inspectIdentity) return Promise.reject(new SkillOptForegroundError("native_model_metadata_unavailable"))
  return transport.inspectIdentity().then((identity) => {
    if (!identity || identity.engine !== model.engine || identity.requestedModel !== model.requestedModel) {
      fail("native_model_identity_mismatch")
    }
    return identity
  }).catch((error) => {
    if (error instanceof SkillOptForegroundError) throw error
    fail("native_model_metadata_unavailable")
  })
}

type FileOwnerIdentity = Readonly<{ path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }>

function selectedSourceOwnerIdentity(root: string, paths: readonly Readonly<{ path: string; maximum: number }>[]): readonly FileOwnerIdentity[] {
  const canonicalRoot = realpathSync.native(root)
  const uid = process.geteuid?.()
  if (uid === undefined) fail("source_owner_unavailable")
  let totalBytes = 0
  return Object.freeze(paths.map(({ path, maximum }) => {
    if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") ||
        path.split("/").some((part) => !part || part === "." || part === "..")) fail("source_path_invalid")
    let cursor = canonicalRoot
    for (const part of path.split("/")) {
      cursor = join(cursor, part)
      const component = lstatSync(cursor)
      if (component.isSymbolicLink()) fail("source_alias")
    }
    const stat = lstatSync(cursor)
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) fail("source_owner_or_size_invalid")
    totalBytes += stat.size
    if (totalBytes > NATIVE_DATASET_LIMITS.sourceBytes) fail("source_total_size_invalid")
    return Object.freeze({ path, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs })
  }))
}

function sameSourceOwnerIdentity(left: readonly FileOwnerIdentity[], right: readonly FileOwnerIdentity[]): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function inputWithIdentities(input: SkillOptForegroundInput, identities: readonly CliNativeIdentity[]) {
  const byKey = new Map(identities.map((identity) => [`${identity.engine}/${identity.requestedModel}`, identity]))
  const bind = (selected: SkillOptForegroundInput["models"]["generator"]): NativeModelBinding => {
    const identity = byKey.get(`${selected.engine}/${selected.requestedModel}`)
    if (!identity) fail("native_model_identity_mismatch")
    return Object.freeze({ engine: selected.engine, requestedModel: selected.requestedModel,
      runtimeIdentity: identity.runtimeIdentity, profileIdentity: identity.profileIdentity })
  }
  return Object.freeze({ generator: bind(input.models.generator), target: bind(input.models.target), reviewer: bind(input.models.reviewer) })
}

function ownerMatchesRuntime(runtime: ExecutionRuntime, owner: SessionStore, input: SkillOptForegroundInput): void {
  if (runtime.host.identity.engine !== input.models.generator.engine || owner.metadata.engine !== input.models.generator.engine ||
      owner.metadata.model !== input.models.generator.requestedModel) fail("owner_model_mismatch")
  owner.assertOwner()
}

function artifactBytes(input: SkillOptForegroundInput, runId: string, bindingSha256: string): Buffer {
  const inputText = canonicalJson(input)
  if (Buffer.byteLength(inputText, "utf8") > MAX_INPUT_BYTES) fail("input_too_large")
  return Buffer.from(canonicalJson({ schema: SKILLOPT_FOREGROUND_ARTIFACT_SCHEMA, runId, bindingSha256,
    inputSha256: sha256(inputText), input }), "utf8")
}

function consentPreview(runId: string,
  challenge: { persistedState: string; scheduleSha256: string; targetRequests: number; canaryReserve: number; targetRequestCap: number },
  binding: { dataset: NativeDataset; hashes: ReturnType<typeof skillOptBindingHashes> },
  operation: "consent" | "arm" | "disarm" | "cancel" | "resume" | "run") {
  const message = operation === "consent" ? "이 run의 고정된 데이터·모델·예산 결합에만 동의합니다. 모델 실행이나 적용은 시작하지 않습니다."
    : operation === "arm" ? "이 run의 기존 consent를 arm하여 안전한 idle 시 동일 소유자에서 자동 시작할 수 있게 합니다. 지금 모델 실행이나 적용은 시작하지 않습니다."
      : operation === "disarm" ? "이 run의 기존 arm만 해제합니다. 모델 실행이나 적용은 시작하지 않습니다."
        : operation === "cancel" ? "이 미시도 run만 취소합니다. 예약·불확실 실행은 UNRESOLVED로 보존합니다."
          : operation === "run" ? "기존 승인·예산에 따라 고정된 native campaign 모델 실행을 시작합니다. 후보 승인은 별도이며 적용·게시하지 않습니다."
            : "기존 run의 reentry만 승인하며 quota·hold를 유지합니다. 새 run이나 실행은 만들지 않습니다."
  process.stdout.write(`${JSON.stringify({
    status: "CONSENT_REQUIRED", operation, runId, persistedState: challenge.persistedState, scheduleSha256: challenge.scheduleSha256,
    targetRequests: challenge.targetRequests, canaryReserve: challenge.canaryReserve, targetRequestCap: challenge.targetRequestCap,
    bindingSha256: binding.hashes.bindingSha256, datasetSha256: binding.dataset.datasetSha256,
    sourceExportSha256: binding.dataset.sourceExportSha256, fixturePackSha256: binding.dataset.fixturePackSha256,
    selectedSourceCount: binding.dataset.sourceManifest.entries.length, fixtureCount: binding.dataset.fixturePack.fixtures.length,
    modelBindings: Object.fromEntries(Object.entries(binding.dataset.modelBindings).map(([role, model]) => [role, {
      engine: model.engine, requestedModel: model.requestedModel,
      runtimeIdentitySha256: sha256(canonicalJson(model.runtimeIdentity)), profileSha256: model.profileIdentity.sha256,
    }])),
    resourceLimits: NATIVE_SKILLOPT_LIMITS,
    modelExecutionStarted: false, optimizationSucceeded: false, postApplyHandoffAuthorized: false,
    message: `화면의 데이터·모델 식별자와 전체 예산을 확인하세요. ${message} 현재 terminal reader의 승인 입력 안내는 영어이며 정확한 APPROVE/REJECT 형식을 사용합니다.`,
  })}\n`)
}

export type SkillOptForegroundService = Readonly<{
  status(): SkillOptControllerStatus
  prepare(input: unknown, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  /** Call only at the host's safe idle checkpoint; never prompts or publishes and returns undefined without a live in-process arm. */
  pollAutomatic(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>> | undefined>
  /** Read-only process-local capability presence hint; this does not check eligibility or authorize a dispatch. */
  hasAutomaticArm(): boolean
  run(runId: string, input: unknown, expectedBindingSha256?: string, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  publish(runId: string, terminal: Terminal, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  rollback(runId: string, terminal: Terminal, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  cleanup(runId: string, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  consent(runId: string, input: unknown, expectedBindingSha256?: string, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  arm(runId: string, input: unknown, expectedBindingSha256?: string, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  disarm(runId: string, input: unknown, expectedBindingSha256?: string, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  cancel(runId: string, input: unknown, expectedBindingSha256?: string, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  resume(runId: string, input: unknown, expectedBindingSha256?: string, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  dispose(): void
}>

/** Shared foreground lifecycle; only this builder's helper is ever given to the native broker. */
export function createNativeSkillOptForeground(runtime: ExecutionRuntime, owner: SessionStore): SkillOptForegroundService {
  let nativeHelper: ReturnType<typeof buildSkillOptNativeHelper> | undefined
  let broker: ReturnType<typeof createNativeSkillOptBroker> | undefined
  let disposed = false
  const root = realpathSync.native(runtime.worktree)
  const qualifiedPublicationRuns = new Map<string, {
    receipt: object
    owner: SessionStore
    runtime: ExecutionRuntime
    data?: NativeSkillOptForegroundCampaignData
    phase: "qualified" | "publishing" | "unresolved" | "committed" | "rolling-back" | "rollback-unresolved" | "rolled-back"
    result?: Readonly<Record<string, unknown>>
    rollbackResult?: Readonly<Record<string, unknown>>
  }>()

  function controller() {
    if (disposed) fail("service_disposed")
    if (!broker) {
      nativeHelper = buildSkillOptNativeHelper()
      broker = createNativeSkillOptBroker(runtime, nativeHelper.helper)
    }
    return broker.controller
  }

  async function buildCurrent(inputValue: unknown, expectedBindingSha256?: string) {
    const input = parseSkillOptForegroundInput(inputValue)
    ownerMatchesRuntime(runtime, owner, input)
    const readiness = foregroundFixtureReadiness(input)
    if (readiness.state === "DATA_REQUIRED") {
      return { input, current: undefined, dataRequired: dataRequiredResult(readiness.reasonCode!, readiness.requirements) }
    }
    if (!input.selections?.length) {
      return { input, current: undefined, dataRequired: dataRequiredResult("source_selection_required", ["source_selection_required"]) }
    }
    const sourceBefore = selectedSourceOwnerIdentity(root, input.selections!.map((selection) => ({ path: selection.path, maximum: NATIVE_DATASET_LIMITS.sourceFileBytes })))
    const skillBefore = selectedSourceOwnerIdentity(root, [{ path: PILOT_SKILL, maximum: PILOT_LIMITS.skillBytes }])
    const identities = await Promise.all([input.models.generator, input.models.target, input.models.reviewer].map(identityFor))
    const sourceAfterMetadata = selectedSourceOwnerIdentity(root, input.selections!.map((selection) => ({ path: selection.path, maximum: NATIVE_DATASET_LIMITS.sourceFileBytes })))
    const skillAfterMetadata = selectedSourceOwnerIdentity(root, [{ path: PILOT_SKILL, maximum: PILOT_LIMITS.skillBytes }])
    if (!sameSourceOwnerIdentity(sourceBefore, sourceAfterMetadata) || !sameSourceOwnerIdentity(skillBefore, skillAfterMetadata)) fail("source_changed")
    const modelBindings = inputWithIdentities(input, identities)
    let dataset: NativeDataset
    try {
      dataset = createNativeDataset({ root, selections: input.selections, fixturePack: input.fixturePack, modelBindings })
      dataset = validateNativeDataset(root, dataset)
    } catch (error) {
      if (error instanceof SkillOptError) fail(error.code)
      fail("dataset_invalid")
    }
    const sourceAfterDataset = selectedSourceOwnerIdentity(root, input.selections!.map((selection) => ({ path: selection.path, maximum: NATIVE_DATASET_LIMITS.sourceFileBytes })))
    const skillAfterDataset = selectedSourceOwnerIdentity(root, [{ path: PILOT_SKILL, maximum: PILOT_LIMITS.skillBytes }])
    if (!sameSourceOwnerIdentity(sourceBefore, sourceAfterDataset) || !sameSourceOwnerIdentity(skillBefore, skillAfterDataset)) fail("source_changed")
    if (dataset.status !== "STRUCTURALLY_VALID") {
      return { input, dataset, current: undefined,
        dataRequired: dataRequiredResult(dataset.requirements[0] ?? "data-required", dataset.requirements) }
    }
    const baselineSkillBytes = readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes)
    const skillAfterBaseline = selectedSourceOwnerIdentity(root, [{ path: PILOT_SKILL, maximum: PILOT_LIMITS.skillBytes }])
    if (!sameSourceOwnerIdentity(skillBefore, skillAfterBaseline)) fail("source_changed")
    const baselineSkillSha256 = sha256(baselineSkillBytes)
    const current = Object.freeze({ dataset, baselineSkillSha256 })
    const hashes = skillOptBindingHashes(root, dataset, baselineSkillSha256)
    if (expectedBindingSha256 !== undefined && hashes.bindingSha256 !== expectedBindingSha256) fail("consent-binding-drift")
    return { input, dataset, current, hashes }
  }

  async function reenter(runId: string, inputValue: unknown, expectedBindingSha256: string | undefined,
    operation: "consent" | "arm" | "disarm" | "cancel" | "resume" | "run", signal?: AbortSignal, requireArmed = false) {
    throwIfAborted(signal)
    if (!UUID.test(runId)) fail("run_id_invalid")
    const binding = await buildCurrent(inputValue, expectedBindingSha256)
    throwIfAborted(signal)
    if (!binding.current) return { binding, result: binding.dataRequired }
    const activeController = controller()
    const challenge = activeController.prepareReentry({ owner, runId, current: binding.current })
    if (requireArmed && challenge.persistedState !== "ARMED") fail("arm-required")
    consentPreview(runId, challenge, { dataset: binding.dataset!, hashes: binding.hashes! }, operation)
    let receipt: OperatorDecision
    try { receipt = await humanDecision("choose", challenge.decisionBinding, signal) }
    catch {
      if (signal?.aborted) fail("operator_decision_aborted")
      fail("operator_decision_unavailable")
    }
    throwIfAborted(signal)
    const restored = activeController.acceptReentry(challenge, receipt, binding.current)
    return { binding, activeController, restored }
  }

  function stateResult(status: SkillOptControllerStatus, operation: string): Readonly<Record<string, unknown>> {
    return Object.freeze({ operation, state: status.state, runId: status.runId, reasonCode: status.reasonCode,
      revision: status.revision, pendingDispatch: status.pendingDispatch, requestCounts: status.requestCounts,
      targetPhaseCounts: status.targetPhaseCounts, remaining: status.remaining,
      dailyCooldownRemainingMilliseconds: status.dailyCooldownRemainingMilliseconds,
      message: operation === "disarm" ? "기존 arm을 해제했으며 실행·quota는 시작하거나 초기화하지 않았습니다."
        : "기존 run의 취소 결과이며 카운터·quota·만료 정보는 초기화하지 않았습니다.",
      optimizationSucceeded: false, dispatchStarted: false, postApplyHandoffAuthorized: false })
  }

  function retainedUnresolved(status: SkillOptControllerStatus, reasonCode = status.reasonCode ?? "dispatch-pending"): Readonly<Record<string, unknown>> {
    return Object.freeze({ ...stateResult({ ...status, state: "UNRESOLVED", reasonCode }, "cancel"),
      retainedUnresolvedExecution: true,
      message: "실행 종료를 증명할 수 없어 UNRESOLVED로 유지하고 권한과 기록을 보존했습니다." })
  }

  function restoredResult(operation: string, restored: SkillOptRestoredStart): Readonly<Record<string, unknown>> {
    return Object.freeze({ operation, state: restored.state, runId: restored.prepared.runId, revision: restored.revision,
      scheduleSha256: restored.prepared.scheduleSha256, targetRequests: restored.prepared.targetRequests,
      canaryReserve: restored.prepared.canaryReserve, targetRequestCap: restored.prepared.targetRequestCap,
      consentExpiresAtMilliseconds: restored.consent.expiresAtMilliseconds,
      ...(restored.state === "ARMED" ? { digestWatermarkSha256: restored.arm.digestWatermarkSha256,
        armExpiresAtMilliseconds: restored.arm.expiresAtMilliseconds } : {}),
      message: "기존 run과 누적 예산은 유지되며 새 run이나 예산 초기화는 생성되지 않았습니다.",
      optimizationSucceeded: false, dispatchStarted: false, postApplyHandoffAuthorized: false })
  }

  type AutomaticArm = Readonly<{
    runId: string
    owner: SessionStore
    ownerSessionID: string
    ownerEpoch: string
    runtime: ExecutionRuntime
    input: SkillOptForegroundInput
    inputSha256: string
    bindingSha256: string
    prepared: SkillOptPrepared
    consent: SkillOptConsent
    arm: SkillOptArm
  }>
  type AutomaticLaunch = Readonly<{
    armed: AutomaticArm
    binding: Awaited<ReturnType<typeof buildCurrent>>
    activeController: SkillOptController
    accepted: SkillOptRestoredStart
  }>
  const automaticArms = new Map<string, AutomaticArm>()
  let automaticLaunch: AutomaticLaunch | undefined
  let automaticPollInFlight = false
  function invalidateAutomaticWhenReadOnly(): boolean {
    const changedBinding = [...automaticArms.values()].some(armed => armed.owner !== owner || armed.runtime !== runtime ||
      armed.ownerSessionID !== owner.sessionID || armed.ownerEpoch !== owner.epoch ||
      runtime.host.identity.engine !== armed.input.models.generator.engine ||
      owner.metadata.engine !== armed.input.models.generator.engine || owner.metadata.model !== armed.input.models.generator.requestedModel)
    if (changedBinding || owner.isReleased || owner.metadata.held || effectiveHold(root, owner.sessionID)) {
      automaticArms.clear()
      automaticLaunch = undefined
      return true
    }
    return false
  }

  const service: SkillOptForegroundService = Object.freeze({
    hasAutomaticArm() { return !disposed && automaticArms.size > 0 },
    status() {
      invalidateAutomaticWhenReadOnly()
      return controller().status()
    },
    async pollAutomatic(signal) {
      if (disposed) return undefined
      // Do not let a second poll clear or rebuild the arm while its first poll owns binding/materialization work.
      if (automaticPollInFlight) {
        const armed = [...automaticArms.values()].find(value => value.owner === owner && value.runtime === runtime)
        return Object.freeze({ operation: "automatic", state: "BLOCKED", reasonCode: "automatic_poll_in_progress",
          ...(armed ? { runId: armed.runId } : {}), modelExecutionStarted: false, dispatchStarted: false,
          candidateQualified: false, publicationAuthorized: false, postApplyHandoffAuthorized: false })
      }
      if (signal?.aborted) {
        automaticArms.clear()
        automaticLaunch = undefined
        return undefined
      }
      if (invalidateAutomaticWhenReadOnly()) return undefined
      const armed = [...automaticArms.values()].find(value => value.owner === owner && value.runtime === runtime)
      if (!armed) return undefined
      // Claim synchronously, before buildCurrent's first await can permit another invocation into the same run.
      automaticPollInFlight = true
      try {
        const forget = () => { automaticArms.delete(armed.runId) }
        if (armed.inputSha256 !== sha256(canonicalJson(armed.input)) || !UUID.test(armed.runId) || owner.isReleased) {
          forget()
          return Object.freeze({ operation: "automatic", state: "BLOCKED", reasonCode: "automatic_capability_invalid",
            runId: armed.runId, modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
            publicationAuthorized: false, postApplyHandoffAuthorized: false })
        }

        let activeController: SkillOptController
        let current: Awaited<ReturnType<typeof buildCurrent>>
        try {
          owner.assertOwner()
          activeController = controller()
          current = await buildCurrent(armed.input, armed.bindingSha256)
          if (signal?.aborted) { forget(); return undefined }
          if (disposed) return undefined
        } catch (error) {
          const reasonCode = foregroundReasonCode(error)
          forget()
          return Object.freeze({ operation: "automatic", state: "BLOCKED", reasonCode, runId: armed.runId,
            modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
            publicationAuthorized: false, postApplyHandoffAuthorized: false })
        }
        if (!current.current || !current.hashes || current.dataRequired ||
            sha256(canonicalJson(current.input)) !== armed.inputSha256 || current.hashes.bindingSha256 !== armed.bindingSha256) {
          forget()
          return Object.freeze({ operation: "automatic", state: "DATA_REQUIRED", reasonCode: current.dataRequired?.reasonCode ?? "binding-data-drift",
            ...(current.dataRequired ? { requirements: current.dataRequired.requirements } : {}), runId: armed.runId,
            modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
            publicationAuthorized: false, postApplyHandoffAuthorized: false })
        }
        const readiness = activeController.automaticReadiness({ owner, prepared: armed.prepared, consent: armed.consent,
          arm: armed.arm, current: current.current })
        if (readiness.state !== "READY") {
          const retryableReadiness = readiness.reasonCode === "digest-threshold" || readiness.reasonCode === "daily-limit" ||
            readiness.reasonCode === "owner-busy"
          if (!retryableReadiness) forget()
          return Object.freeze({ operation: "automatic", state: "ARMED", readiness: "BLOCKED", reasonCode: readiness.reasonCode,
            runId: armed.runId, newDigestCount: readiness.newDigestCount, requiredNewDigests: readiness.requiredNewDigests,
            dailyCooldownRemainingMilliseconds: readiness.dailyCooldownRemainingMilliseconds,
            modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
            publicationAuthorized: false, postApplyHandoffAuthorized: false })
        }
        const finalCooldownCheck = readiness.finalReservationRequired === true
        if (signal?.aborted) { forget(); return undefined }
        if (disposed) return undefined
        const persisted = activeController.status()
        if (persisted.runId !== armed.runId || persisted.state !== "ARMED") {
          forget()
          return Object.freeze({ operation: "automatic", state: "BLOCKED", reasonCode: persisted.reasonCode ?? "arm-required",
            runId: armed.runId, modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
            publicationAuthorized: false, postApplyHandoffAuthorized: false })
        }
        const accepted: SkillOptRestoredStart = Object.freeze({ state: "ARMED", revision: persisted.revision,
          prepared: armed.prepared, consent: armed.consent, arm: armed.arm })
        automaticLaunch = { armed, binding: current, activeController, accepted }
        try {
          const result = await service.run(armed.runId, armed.input, armed.bindingSha256, signal)
          if (result.state === "UNRESOLVED" || signal?.aborted ||
              (finalCooldownCheck && result.reasonCode === "daily-limit")) forget()
          return result
        } catch (error) {
          forget()
          return Object.freeze({ operation: "automatic", state: "BLOCKED", reasonCode: foregroundReasonCode(error),
            runId: armed.runId, modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
            publicationAuthorized: false, postApplyHandoffAuthorized: false })
        } finally {
          automaticLaunch = undefined
          if (signal?.aborted) forget()
          try {
            const after = activeController.status()
            if (after.runId !== armed.runId || after.state !== "ARMED" || after.pendingDispatch) forget()
          } catch { forget() }
        }
      } finally {
        automaticPollInFlight = false
      }
    },
    async prepare(inputValue, signal) {
      throwIfAborted(signal)
      const input = parseSkillOptForegroundInput(inputValue)
      ownerMatchesRuntime(runtime, owner, input)
      const readiness = foregroundFixtureReadiness(input)
      if (readiness.state === "DATA_REQUIRED") return dataRequiredResult(readiness.reasonCode!, readiness.requirements)
      const built = await buildCurrent(input)
      throwIfAborted(signal)
      if (built.dataRequired) return built.dataRequired
      const activeController = controller()
      throwIfAborted(signal)
      activeController.initialize()
      const prepared = activeController.prepare({ owner, campaignId: `campaign_${randomUUID().replaceAll("-", "")}`, ...built.current! })
      if (prepared.state !== "PREPARED") return Object.freeze({ state: prepared.state, reasonCode: prepared.reasonCode })
      automaticArms.clear()
      automaticLaunch = undefined
      const directory = ensurePrivateArtifactDirectory(root)
      const path = join(directory, `${prepared.runId}.json`)
      try {
        lstatSync(path)
        fail("artifact_collision")
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
      }
      const bytes = artifactBytes(built.input, prepared.runId, prepared.bindingSha256)
      activeController.reserveNativePreparationArtifacts({ owner, runtime, runId: prepared.runId,
        current: built.current!, bytes: bytes.byteLength })
      durableWriteBytes(path, bytes, undefined, { createParents: false })
      return Object.freeze({ state: prepared.state, runId: prepared.runId, campaignId: prepared.campaignId,
        scheduleSha256: prepared.scheduleSha256, targetRequests: prepared.targetRequests,
        canaryReserve: prepared.canaryReserve, targetRequestCap: prepared.targetRequestCap,
        bindingSha256: prepared.bindingSha256, sourceExportSha256: prepared.sourceExportSha256,
        fixturePackSha256: prepared.fixturePackSha256, datasetSha256: prepared.datasetSha256,
        modelBindingsSha256: prepared.modelBindingsSha256, protocolSha256: prepared.protocolSha256,
        baselineSkillSha256: prepared.baselineSkillSha256, inputArtifactSha256: sha256(bytes),
        message: "자료와 결합을 준비했습니다. 이 결과는 최적화 성공이나 모델 실행을 뜻하지 않습니다.",
        optimizationSucceeded: false, dispatchStarted: false, postApplyHandoffAuthorized: false })
    },
    async run(runId, inputValue, expectedBindingSha256, signal) {
      const pendingAutomatic = automaticLaunch
      automaticLaunch = undefined
      let suppliedInputSha256: string | undefined
      try { suppliedInputSha256 = sha256(canonicalJson(inputValue)) } catch { /* The ordinary reentry path validates malformed input. */ }
      const automatic = pendingAutomatic && pendingAutomatic.armed.runId === runId &&
        pendingAutomatic.armed.owner === owner && pendingAutomatic.armed.runtime === runtime &&
        pendingAutomatic.armed.bindingSha256 === expectedBindingSha256 && pendingAutomatic.armed.inputSha256 === suppliedInputSha256
        ? pendingAutomatic : undefined
      const reentered = automatic
        ? { binding: automatic.binding, activeController: automatic.activeController, restored: automatic.accepted, result: undefined }
        : await reenter(runId, inputValue, expectedBindingSha256, "run", signal)
      if (!reentered.restored) return Object.freeze({ operation: "run", runId, ...reentered.result! })
      const accepted = reentered.restored
      const activeController = reentered.activeController!
      const abortBeforeDispatch = (): Readonly<Record<string, unknown>> => {
        const before = activeController.status()
        if (automatic && before.runId === runId && before.state === "ARMED" && !before.pendingDispatch) {
          return Object.freeze({ operation: "run", state: "BLOCKED", reasonCode: "automatic_cancelled_before_reservation",
            runId, controllerState: before.state, revision: before.revision, requestCounts: before.requestCounts,
            remaining: before.remaining, modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
            publicationAuthorized: false, postApplyHandoffAuthorized: false })
        }
        const counts = before.requestCounts
        const noRequests = Object.values(counts.charged).every(count => count === 0) &&
          Object.values(counts.dispatched).every(count => count === 0) && Object.values(counts.unknown).every(count => count === 0)
        if (before.runId !== runId || before.pendingDispatch || !noRequests ||
            (before.state !== "CONSENTED" && before.state !== "ARMED")) {
          return Object.freeze({ operation: "run", state: "UNRESOLVED", reasonCode: "run_abort_state_unresolved",
            runId, controllerState: before.state, requestCounts: counts, pendingDispatch: before.pendingDispatch,
            modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
            publicationAuthorized: false, postApplyHandoffAuthorized: false })
        }
        let cancelled: SkillOptControllerStatus
        try {
          cancelled = before.state === "ARMED" ? activeController.disarm(owner, runId) : activeController.cancelUnstarted(owner, runId)
        } catch {
          return Object.freeze({ operation: "run", state: "UNRESOLVED", reasonCode: "run_abort_cancel_unresolved",
            runId, controllerState: activeController.status().state, requestCounts: counts,
            modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
            publicationAuthorized: false, postApplyHandoffAuthorized: false })
        }
        const cancelledCounts = cancelled.requestCounts
        const cancelledWithoutRequests = Object.values(cancelledCounts.charged).every(count => count === 0) &&
          Object.values(cancelledCounts.dispatched).every(count => count === 0) &&
          Object.values(cancelledCounts.unknown).every(count => count === 0)
        return Object.freeze({ operation: "run", state: cancelled.state === "CANCELLED" && cancelled.runId === runId &&
          !cancelled.pendingDispatch && cancelledWithoutRequests ? "CANCELLED" : "UNRESOLVED",
          ...(cancelled.state === "CANCELLED" ? {} : { reasonCode: "run_abort_cancel_unresolved" }),
          runId, controllerState: cancelled.state, revision: cancelled.revision,
          requestCounts: cancelled.requestCounts, remaining: cancelled.remaining,
          modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
          publicationAuthorized: false, postApplyHandoffAuthorized: false })
      }
      if (signal?.aborted) return abortBeforeDispatch()
      const freshBinding = automatic ? automatic.binding : await buildCurrent(inputValue, expectedBindingSha256)
      if (signal?.aborted) return abortBeforeDispatch()
      if (!freshBinding.current || !freshBinding.dataset || !freshBinding.hashes) {
        return Object.freeze({ operation: "run", runId, ...(freshBinding.dataRequired ?? dataRequiredResult("current_binding_required", ["current_binding_required"])) })
      }
      if (accepted.prepared.runId !== runId || accepted.prepared.bindingSha256 !== freshBinding.hashes.bindingSha256 ||
          reentered.binding.hashes?.bindingSha256 !== freshBinding.hashes.bindingSha256) fail("consent-binding-drift")

      let baselineSkillBytes: Buffer
      let originalSkill: string
      try {
        baselineSkillBytes = readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes)
        originalSkill = new TextDecoder("utf-8", { fatal: true }).decode(baselineSkillBytes)
      } catch { fail("campaign_baseline_unavailable") }
      if (!Buffer.from(originalSkill, "utf8").equals(baselineSkillBytes) ||
          sha256(baselineSkillBytes) !== accepted.prepared.baselineSkillSha256 ||
          sha256(baselineSkillBytes) !== freshBinding.current.baselineSkillSha256) fail("campaign_baseline_drift")

      let trainerPreparation: NativeSkillOptTrainerPreparation
      if (freshBinding.input.runtime) {
        const plan = planNativeSkillOptTrainerMaterialization({ worktree: root, runtime: freshBinding.input.runtime,
          dataset: freshBinding.dataset, prepared: accepted.prepared, baselineSkillBytes })
        const materialization = nativeSkillOptTrainerMaterializationMetadata(plan)
        const allowance = activeController.reserveNativeTrainerMaterialization({ owner, runtime, prepared: accepted.prepared,
          current: freshBinding.current, materialization })
        trainerPreparation = await prepareNativeSkillOptTrainer({ worktree: root, runtime: freshBinding.input.runtime,
          dataset: freshBinding.dataset, prepared: accepted.prepared, baselineSkillBytes, owner, executionRuntime: runtime,
          controller: activeController, current: freshBinding.current, plan, allowance })
      } else {
        trainerPreparation = await prepareNativeSkillOptTrainer({ worktree: root, dataset: freshBinding.dataset,
          prepared: accepted.prepared, baselineSkillBytes })
      }
      if (trainerPreparation.state !== "READY") {
        const currentStatus = activeController.status()
        return Object.freeze({ operation: "run", state: trainerPreparation.state, reasonCode: trainerPreparation.reasonCode,
          runId, controllerState: currentStatus.state, revision: currentStatus.revision,
          requestCounts: currentStatus.requestCounts, remaining: currentStatus.remaining,
          modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
          publicationAuthorized: false, postApplyHandoffAuthorized: false })
      }
      const activeBroker = broker
      if (!activeBroker) {
        trainerPreparation.cleanup()
        fail("native_broker_unavailable")
      }
      let current = freshBinding.current
      let campaignDataset = freshBinding.dataset
      let campaignBaselineBytes = baselineSkillBytes
      let campaignOriginalSkill = originalSkill
      let campaignSourceOwners: readonly FileOwnerIdentity[] = []
      let campaignBaselineOwners: readonly FileOwnerIdentity[] = []
      try {
        if (signal?.aborted) {
          if (!trainerPreparation.cleanup()) return Object.freeze({ operation: "run", state: "UNRESOLVED",
            reasonCode: "trainer_scratch_cleanup_unresolved", runId, controllerState: activeController.status().state,
            modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
            publicationAuthorized: false, postApplyHandoffAuthorized: false })
          return abortBeforeDispatch()
        }
        const finalBinding = await buildCurrent(inputValue, expectedBindingSha256)
        if (signal?.aborted) {
          if (!trainerPreparation.cleanup()) return Object.freeze({ operation: "run", state: "UNRESOLVED",
            reasonCode: "trainer_scratch_cleanup_unresolved", runId, controllerState: activeController.status().state,
            modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false,
            publicationAuthorized: false, postApplyHandoffAuthorized: false })
          return abortBeforeDispatch()
        }
        if (!finalBinding.current || !finalBinding.dataset || !finalBinding.hashes) {
          trainerPreparation.cleanup()
          return Object.freeze({ operation: "run", runId,
            ...(finalBinding.dataRequired ?? dataRequiredResult("current_binding_required", ["current_binding_required"])) })
        }
        if (finalBinding.hashes.bindingSha256 !== freshBinding.hashes.bindingSha256 ||
            accepted.prepared.bindingSha256 !== finalBinding.hashes.bindingSha256) {
          fail("consent-binding-drift")
        }
        campaignBaselineBytes = readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes)
        if (!campaignBaselineBytes.equals(baselineSkillBytes) ||
            sha256(campaignBaselineBytes) !== accepted.prepared.baselineSkillSha256) fail("campaign_baseline_drift")
        campaignOriginalSkill = new TextDecoder("utf-8", { fatal: true }).decode(campaignBaselineBytes)
        if (!Buffer.from(campaignOriginalSkill, "utf8").equals(campaignBaselineBytes)) fail("campaign_baseline_encoding_invalid")
        current = finalBinding.current
        campaignDataset = finalBinding.dataset
        const sourcePaths = finalBinding.input.selections!.map(selection => ({
          path: selection.path, maximum: NATIVE_DATASET_LIMITS.sourceFileBytes,
        }))
        campaignSourceOwners = selectedSourceOwnerIdentity(root, sourcePaths)
        campaignBaselineOwners = selectedSourceOwnerIdentity(root, [{ path: PILOT_SKILL, maximum: PILOT_LIMITS.skillBytes }])
      } catch (error) {
        trainerPreparation.cleanup()
        throw error
      }
      const campaignResult = await runNativeSkillOptCampaign({ broker: activeBroker, owner, getCurrent: () => {
        const sourcePaths = freshBinding.input.selections!.map(selection => ({
          path: selection.path, maximum: NATIVE_DATASET_LIMITS.sourceFileBytes,
        }))
        const sourcesBefore = selectedSourceOwnerIdentity(root, sourcePaths)
        const baselineBefore = selectedSourceOwnerIdentity(root, [{ path: PILOT_SKILL, maximum: PILOT_LIMITS.skillBytes }])
        const datasetNow = validateNativeDataset(root, campaignDataset)
        if (datasetNow.status !== "STRUCTURALLY_VALID" || datasetNow.datasetSha256 !== campaignDataset.datasetSha256) {
          fail("campaign_binding_drift")
        }
        const baselineNow = readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes)
        const sourcesAfter = selectedSourceOwnerIdentity(root, sourcePaths)
        const baselineAfter = selectedSourceOwnerIdentity(root, [{ path: PILOT_SKILL, maximum: PILOT_LIMITS.skillBytes }])
        if (!sameSourceOwnerIdentity(campaignSourceOwners, sourcesBefore) ||
            !sameSourceOwnerIdentity(sourcesBefore, sourcesAfter) ||
            !sameSourceOwnerIdentity(campaignBaselineOwners, baselineBefore) ||
            !sameSourceOwnerIdentity(baselineBefore, baselineAfter) ||
            sha256(baselineNow) !== current.baselineSkillSha256) fail("campaign_binding_drift")
        return current
      },
        runtime,
        prepared: accepted.prepared, consent: accepted.consent,
        ...(accepted.state === "ARMED" ? { arm: accepted.arm } : {}),
        originalSkill: campaignOriginalSkill, trainer: trainerPreparation.trainer, ...(signal ? { signal } : {}) })
      const currentStatus = activeController.status()
      if (currentStatus.runId !== runId || currentStatus.state !== "ARMED" || currentStatus.pendingDispatch) automaticArms.delete(runId)
      const controllerQualified = currentStatus.state === "AWAITING_CANDIDATE_APPROVAL" &&
        currentStatus.runId === runId && !currentStatus.pendingDispatch
      const campaignQualified = campaignResult.status === "AWAITING_CANDIDATE_APPROVAL"
      const candidateQualified = controllerQualified && campaignQualified
      const reportedState = controllerQualified !== campaignQualified ? "UNRESOLVED" : campaignResult.status
      const dispatchStarted = Object.values(currentStatus.requestCounts.dispatched).some(count => count > 0)
      const summary = Object.freeze({ operation: "run", state: reportedState,
        ...(campaignResult.reasonCode ? { reasonCode: campaignResult.reasonCode } : {}), runId,
        bindingSha256: freshBinding.hashes.bindingSha256,
        scheduleSha256: campaignResult.schedule?.scheduleSha256 ?? accepted.prepared.scheduleSha256,
        ...(campaignResult.candidate ? { candidateSha256: campaignResult.candidate.sha256 } : {}),
        ...(campaignResult.metrics ? { metricsStatus: campaignResult.metrics.status } : {}),
        reviewerCount: campaignResult.reviewerEvidence?.length ?? 0, candidateQualified,
        controllerState: currentStatus.state, revision: currentStatus.revision, pendingDispatch: currentStatus.pendingDispatch,
        requestCounts: currentStatus.requestCounts, targetPhaseCounts: currentStatus.targetPhaseCounts,
        remaining: currentStatus.remaining, dispatchStarted, modelExecutionStarted: dispatchStarted,
        publicationAuthorized: false, postApplyHandoffAuthorized: false,
        message: candidateQualified
          ? "평가와 독립 검토가 후보 승인 대기에 도달했습니다. 게시·적용·롤백 권한은 부여되지 않았습니다."
          : "campaign 결과는 실행·평가 상태만 요약하며 후보 게시나 적용을 승인하지 않습니다." })
      if (candidateQualified) {
        const receiptState = Object.freeze({
          runId, bindingSha256: freshBinding.hashes.bindingSha256, owner, runtime, broker: activeBroker,
          prepared: accepted.prepared, consent: accepted.consent,
          ...(accepted.state === "ARMED" ? { arm: accepted.arm } : {}), current,
          baselineSkillBytes: Buffer.from(campaignBaselineBytes), campaignResult, trainer: trainerPreparation,
          root, isLive: () => !disposed && !owner.isReleased,
        })
        qualifiedRunReceipts.set(summary, receiptState)
        qualifiedPublicationRuns.set(runId, { receipt: summary, owner, runtime, phase: "qualified" })
      } else if (reportedState !== "UNRESOLVED") {
        trainerPreparation.cleanup()
      }
      return summary
    },
    async publish(runId, terminal, signal) {
      const blocked = (reasonCode: string): Readonly<Record<string, unknown>> => Object.freeze({
        operation: "publish", state: "BLOCKED", runId, reasonCode, candidateQualified: false,
        publicationAuthorized: false, postApplyHandoffAuthorized: false,
      })
      if (disposed) return blocked("service_disposed")
      if (!UUID.test(runId)) return blocked("run_id_invalid")
      const publication = qualifiedPublicationRuns.get(runId)
      if (!publication || publication.owner !== owner || publication.runtime !== runtime) return blocked("qualified_run_receipt_unavailable")
      if (publication.phase === "publishing") return blocked("publication_already_in_progress")
      if (publication.phase === "rolling-back") return blocked("publication_operation_in_progress")
      if (publication.phase === "committed" || publication.phase === "unresolved") return publication.result ?? blocked("publication_already_settled")
      if (publication.phase !== "qualified") return blocked("publication_already_settled")
      publication.phase = "publishing"
      try {
        if (!publication.data) {
          publication.data = consumeNativeSkillOptForegroundRunResult(publication.receipt, owner, runtime)
        }
        const data = publication.data
        const activeController = controller()
        if (!data || !nativeHelper || data.broker !== broker || data.owner !== owner ||
            data.runtime !== runtime || data.runId !== runId) {
          publication.phase = "qualified"
          return blocked("foreground_run_receipt_invalid")
        }
        const result = await publishQualifiedNativeSkillOptRun({ data, controller: activeController,
          nativeHelper, terminal, ...(signal ? { signal } : {}) })
        publication.result = result
        if (result.state === "COMMITTED") {
          publication.phase = "committed"
        } else if (result.state === "UNRESOLVED") {
          publication.phase = "unresolved"
        } else {
          publication.phase = "qualified"
        }
        return result
      } catch (error) {
        publication.phase = "qualified"
        return blocked(foregroundReasonCode(error))
      }
    },
    async rollback(runId, terminal, signal) {
      const safeRunId = UUID.test(runId) ? runId : "unknown"
      const blocked = (reasonCode: string): Readonly<Record<string, unknown>> => Object.freeze({
        operation: "rollback", state: "BLOCKED", runId: safeRunId, reasonCode, candidateQualified: false,
        publicationAuthorized: false, rollbackAuthorized: false, postRollbackHandoffAuthorized: false,
      })
      if (disposed) return blocked("service_disposed")
      if (!UUID.test(runId)) return blocked("run_id_invalid")
      const publication = qualifiedPublicationRuns.get(runId)
      if (!publication || publication.owner !== owner || publication.runtime !== runtime) return blocked("published_context_unavailable")
      if (publication.phase === "publishing" || publication.phase === "rolling-back") return blocked("publication_operation_in_progress")
      if (publication.phase === "rolled-back") return blocked("rollback_already_settled")
      if (publication.phase === "rollback-unresolved") return publication.rollbackResult ?? blocked("rollback_outcome_uncertain")
      if (publication.phase !== "committed" && publication.phase !== "unresolved") return blocked("published_context_unavailable")

      const originalPhase = publication.phase
      const data = publication.data
      const activeController = broker?.controller
      if (!data || !nativeHelper || !activeController || !broker || data.owner !== owner || data.runtime !== runtime ||
          data.broker !== broker || data.runId !== runId) return blocked("published_context_unavailable")

      let observedControllerState: string | undefined
      try { observedControllerState = activeController.status().state }
      catch { /* The rollback publication helper remains the authority for eligibility and settlement. */ }
      if (observedControllerState === "ROLLED_BACK") {
        return Object.freeze({ operation: "rollback", state: "BLOCKED", runId,
          reasonCode: "rollback_already_settled", controllerState: observedControllerState,
          candidateQualified: true, publicationAuthorized: true, rollbackAuthorized: false,
          postRollbackHandoffAuthorized: false })
      }

      publication.phase = "rolling-back"
      try {
        const result = await rollbackPublishedNativeSkillOptRun({ data, controller: activeController,
          nativeHelper, terminal, ...(signal ? { signal } : {}) })
        const directResult = result.operation === "rollback" && result.runId === runId ? result : undefined
        if (!directResult) {
          publication.phase = "rollback-unresolved"
          const uncertain = Object.freeze({ operation: "rollback", state: "UNRESOLVED", runId,
            reasonCode: "rollback_result_unrecognized", candidateQualified: true,
            publicationAuthorized: true, rollbackAuthorized: true, postRollbackHandoffAuthorized: false })
          publication.rollbackResult = uncertain
          return uncertain
        }
        if (directResult.state === "ROLLED_BACK" && directResult.rollbackAuthorized === true &&
            directResult.postRollbackHandoffAuthorized === true && directResult.controllerState === "ROLLED_BACK") {
          publication.phase = "rolled-back"
          publication.rollbackResult = directResult
          return directResult
        }
        if (directResult.state === "UNRESOLVED" || directResult.rollbackAuthorized === true) {
          publication.phase = "rollback-unresolved"
          const uncertain = directResult.state === "UNRESOLVED" ? directResult : Object.freeze({
            operation: "rollback", state: "UNRESOLVED", runId,
            reasonCode: typeof directResult.reasonCode === "string" ? directResult.reasonCode : "rollback_outcome_uncertain",
            controllerState: typeof directResult.controllerState === "string" ? directResult.controllerState : undefined,
            revision: Number.isSafeInteger(directResult.revision) ? directResult.revision : undefined,
            candidateQualified: true, publicationAuthorized: true, rollbackAuthorized: true,
            postRollbackHandoffAuthorized: false,
          })
          publication.rollbackResult = uncertain
          return uncertain
        }
        if (directResult.state !== "REJECTED" && directResult.state !== "CANCELLED" && directResult.state !== "BLOCKED") {
          publication.phase = "rollback-unresolved"
          const uncertain = Object.freeze({ operation: "rollback", state: "UNRESOLVED", runId,
            reasonCode: "rollback_result_unrecognized", candidateQualified: true,
            publicationAuthorized: true, rollbackAuthorized: true, postRollbackHandoffAuthorized: false })
          publication.rollbackResult = uncertain
          return uncertain
        }
        // A direct REJECTED/CANCELLED/BLOCKED result without authorization did not begin mutation; preserve
        // the committed or post-swap unresolved apply context so a later explicit approval remains possible.
        publication.phase = originalPhase
        return directResult
      } catch {
        publication.phase = "rollback-unresolved"
        const uncertain = Object.freeze({ operation: "rollback", state: "UNRESOLVED", runId,
          reasonCode: "rollback_outcome_uncertain", candidateQualified: true,
          publicationAuthorized: true, rollbackAuthorized: true, postRollbackHandoffAuthorized: false })
        publication.rollbackResult = uncertain
        return uncertain
      }
    },
    async consent(runId, inputValue, expectedBindingSha256, signal) {
      const restored = await reenter(runId, inputValue, expectedBindingSha256, "consent", signal)
      throwIfAborted(signal)
      if (!restored.restored) return restored.result!
      return restoredResult("consent", restored.restored)
    },
    async arm(runId, inputValue, expectedBindingSha256, signal) {
      const restored = await reenter(runId, inputValue, expectedBindingSha256, "arm", signal)
      throwIfAborted(signal)
      if (!restored.restored) return restored.result!
      const activeController = restored.activeController!
      let accepted: SkillOptRestoredStart
      let arm: SkillOptArm
      if (restored.restored.state === "ARMED") {
        accepted = restored.restored
        arm = restored.restored.arm
      } else {
        arm = activeController.arm(restored.restored.prepared, restored.restored.consent, restored.binding.current!)
        accepted = Object.freeze({ state: "ARMED", revision: activeController.status().revision,
          prepared: restored.restored.prepared, consent: restored.restored.consent, arm })
      }
      const input = restored.binding.input
      automaticArms.clear()
      automaticArms.set(runId, Object.freeze({ runId, owner, ownerSessionID: owner.sessionID, ownerEpoch: owner.epoch,
        runtime, input, inputSha256: sha256(canonicalJson(input)),
        bindingSha256: accepted.prepared.bindingSha256, prepared: accepted.prepared, consent: accepted.consent, arm }))
      automaticLaunch = undefined
      return Object.freeze({ operation: "arm", state: arm.state, runId: arm.runId,
        digestWatermarkSha256: arm.digestWatermarkSha256, armExpiresAtMilliseconds: arm.expiresAtMilliseconds,
        message: "기존 controller의 실제 digest 조건에 arm 했습니다. 안전한 idle 시 동일 owner/runtime에서 자동 실행만 확인하며 적용·게시하지 않습니다.",
        optimizationSucceeded: false, dispatchStarted: false, postApplyHandoffAuthorized: false })
    },
    async disarm(runId, inputValue, expectedBindingSha256, signal) {
      throwIfAborted(signal)
      if (!UUID.test(runId)) fail("run_id_invalid")
      const activeController = controller()
      try {
        const result = stateResult(activeController.disarm(owner, runId), "disarm")
        automaticArms.delete(runId)
        return result
      }
      catch (error) {
        if (!isOwnerMismatch(error)) throw error
      }
      if (inputValue === undefined) return dataRequiredResult("input_required", ["input_required"])
      const restored = await reenter(runId, inputValue, expectedBindingSha256, "disarm", signal, true)
      throwIfAborted(signal)
      if (!restored.restored) return restored.result!
      if (restored.restored.state !== "ARMED") fail("arm-required")
      const result = stateResult(restored.activeController!.disarm(owner, runId), "disarm")
      automaticArms.delete(runId)
      return result
    },
    async cancel(runId, inputValue, expectedBindingSha256, signal) {
      throwIfAborted(signal)
      if (!UUID.test(runId)) fail("run_id_invalid")
      const activeController = controller()
      const before = activeController.status()
      if (before.runId === runId && (before.pendingDispatch || before.state === "UNRESOLVED")) {
        return retainedUnresolved(before)
      }
      if (before.runId === runId && before.state === "RUNNING") {
        return Object.freeze({ ...stateResult(before, "cancel"), cancelled: false,
          message: "실행 중인 run은 취소하지 않았으며 소유자와 누적 quota를 유지했습니다." })
      }
      if (before.runId === runId && before.state === "AWAITING_CANDIDATE_APPROVAL") {
        return Object.freeze({ ...stateResult(before, "cancel"), cancelled: false,
          message: "후보 승인 대기 상태를 유지했습니다. 취소는 최종 안전 판정 이후 controller가 허용하는 상태에서만 수행됩니다." })
      }
      if (before.runId === runId && (before.state === "PREPARED" || before.state === "CONSENTED" || before.state === "ARMED")) {
        try {
          const result = before.state === "ARMED" ? stateResult(activeController.disarm(owner, runId), "cancel")
            : stateResult(activeController.cancelUnstarted(owner, runId), "cancel")
          automaticArms.delete(runId)
          return result
        } catch (error) {
          if (!isOwnerMismatch(error)) throw error
        }
      }
      if (inputValue === undefined) {
        return dataRequiredResult("input_required", ["input_required"])
      }
      const restored = await reenter(runId, inputValue, expectedBindingSha256, "cancel", signal)
      throwIfAborted(signal)
      if (!restored.restored) return restored.result!
      if (restored.restored.state === "ARMED") {
        const result = stateResult(restored.activeController!.disarm(owner, runId), "cancel")
        automaticArms.delete(runId)
        return result
      }
      const status = restored.activeController!.cancelUnstarted(owner, runId)
      automaticArms.delete(runId)
      return stateResult(status, "cancel")
    },
    async cleanup(runId, signal) {
      throwIfAborted(signal)
      if (!UUID.test(runId)) fail("run_id_invalid")
      const publication = qualifiedPublicationRuns.get(runId)
      if (publication && publication.phase !== "committed" && publication.phase !== "rolled-back") {
        fail("cleanup_publication_retained")
      }
      const activeController = controller()
      owner.assertOwner()
      const claim = runtime.runs.claim(owner.sessionID, `skillopt-private-cleanup-${randomUUID()}`, process.pid)
      try {
        runtime.runs.assertQuiescent(claim)
        const { snapshot, persisted } = cleanupSnapshot(root, runId)
        const snapshotBytes = Buffer.from(canonicalJson(snapshot), "utf8")
        if (snapshotBytes.byteLength > MAX_CLEANUP_BYTES) fail("cleanup_snapshot_too_large")
        const artifactsSha256 = sha256(snapshotBytes)
        const reservedCleanupBytes = (persisted ? 0 : snapshotBytes.byteLength) + CLEANUP_QUARANTINE_METADATA_BYTES
        const prepared = activeController.preparePrivateTextCleanup({ owner, runtime, mutationClaim: claim, runId, artifactsSha256,
          artifactBytes: reservedCleanupBytes, trainerSnapshotSha256: snapshot.trainer?.snapshotSha256 ?? null })
        process.stdout.write(`${JSON.stringify({ operation: "cleanup", state: "CONSENT_REQUIRED", runId,
          revision: prepared.metadata.revision, artifactsSha256,
          privateInputBytes: Number(snapshot.input?.size ?? "0"), trainerScratchPresent: snapshot.trainer !== null,
          cleanupMetadataBytes: reservedCleanupBytes,
          message: "만료된 이 run의 비공개 실험 입력과 종료가 입증된 scratch만 삭제합니다. 원본·backup·journal·복구·감사 기록은 보존하며 실행 권한을 복원하지 않습니다." })}\n`)
        let decision: OperatorDecision
        try { decision = await humanDecision("approve", prepared.decisionBinding, signal) }
        catch {
          if (signal?.aborted) fail("operator_decision_aborted")
          fail("operator_decision_unavailable")
        }
        throwIfAborted(signal)
        const retirement = activeController.retirePrivateTextCleanup({
          owner, runtime, mutationClaim: claim, challenge: prepared.challenge, decision,
        })
        automaticArms.delete(runId)
        if (automaticLaunch?.armed.runId === runId) automaticLaunch = undefined
        runtime.runs.assertQuiescent(claim)
        if (canonicalJson(cleanupDirectoryIdentity(root)) !== canonicalJson(snapshot.directory)) fail("cleanup_directory_changed")
        if (!persisted) persistCleanupSnapshot(root, snapshot)
        let complete = false
        try {
          if (snapshot.trainer === null && inspectNativeSkillOptTrainerCleanup(root, runId) !== null) {
            fail("cleanup_trainer_changed")
          }
          if (snapshot.trainer !== null) {
            if (!retirement.trainerDeletion ||
                !deleteNativeSkillOptTrainerCleanup(root, runId, snapshot.trainer, retirement.trainerDeletion)) {
              fail("cleanup_trainer_retained")
            }
          }
          deleteCleanupInput(root, snapshot, retirement.inputDeletion, artifactsSha256)
          if (snapshot.trainer === null) {
            if (inspectNativeSkillOptTrainerCleanup(root, runId) !== null) fail("cleanup_trainer_changed")
          } else if (inspectNativeSkillOptTrainerCleanup(root, runId)?.state !== "deleted") fail("cleanup_trainer_retained")
          complete = true
        } catch { /* Partial deletion remains retired. A new explicit decision is required to retry. */ }
        return Object.freeze({ operation: "cleanup", state: complete ? "CLEANED" : "CLEANUP_INCOMPLETE",
          runId, revision: retirement.revision, reasonCode: complete ? "private_text_deleted" : "private_text_retained",
          dispatchStarted: false, modelExecutionStarted: false, optimizationSucceeded: false,
          postApplyHandoffAuthorized: false })
      } finally {
        runtime.runs.assertQuiescent(claim)
        runtime.runs.release(claim)
      }
    },
    async resume(runId, inputValue, expectedBindingSha256, signal) {
      const restored = await reenter(runId, inputValue, expectedBindingSha256, "resume", signal)
      throwIfAborted(signal)
      if (!restored.restored) return restored.result!
      return restoredResult("resume", restored.restored)
    },
    dispose() {
      if (disposed) return
      disposed = true
      automaticArms.clear()
      automaticLaunch = undefined
      const keepHelper = [...qualifiedPublicationRuns.values()].some(item =>
        item.phase === "publishing" || item.phase === "rolling-back" || item.phase === "unresolved" ||
        item.phase === "committed" || item.phase === "rollback-unresolved")
      if (!keepHelper) nativeHelper?.dispose()
    },
  })
  return service
}

export function foregroundReasonCode(error: unknown): string {
  if (error instanceof SkillOptControllerError || error instanceof SkillOptForegroundError || error instanceof SkillOptError) return error.code
  return "foreground_blocked"
}
