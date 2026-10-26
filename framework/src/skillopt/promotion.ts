import { createHash, randomBytes } from "node:crypto"
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, writeSync, type Stats,
} from "node:fs"
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { AsyncLocalStorage } from "node:async_hooks"
import { basename, dirname, join, resolve } from "node:path"
import { once } from "node:events"
import { consumeOperatorDecision, type DecisionBinding, type OperatorDecision } from "../hosts/operator.ts"
import type { ComboRoutes } from "../hosts/types.ts"
import { admissionEpoch, captureAdmissionLease, isAdmissionLeaseCurrent } from "../sessions/admission.ts"
import { canonicalRoutes, getOwnedSession, type SessionStore } from "../sessions/store.ts"
import {
  NativeLoadVerificationError,
  NATIVE_SKILL_LOAD_WITNESS_SCHEMA,
  verifyNativeSkillLoadVerificationProof,
  type NativeSkillLoadVerificationProof,
  type NativeSkillLoadWitnessRecord,
} from "./load-verification.ts"

const JOURNAL_SCHEMA = "skillopt.promotion-journal.v1" as const
const WITNESS_SCHEMA = "skillopt.live-skill-witness.v1" as const
const TARGET_RELATIVE_PATH = ".agents/skills/llm-wiki/SKILL.md" as const
const MAX_SKILL_BYTES = 16_384
const MAX_RECORD_BYTES = 64 * 1024
const MAX_JOURNAL_BYTES = 1024 * 1024
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/
const NATIVE_HELPER_PROTOCOL = "skillopt-promotion.v3"
const NATIVE_APPROVAL_TTL_MS = 15 * 60 * 1000
const NATIVE_CLOCK_WALL_TOLERANCE_MS = 2_000n
const UINT64_MAX = (1n << 64n) - 1n
const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n
const NATIVE_BOOT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\s\S])/

export type SkillOptNativePlatform = "darwin" | "linux"
export type SkillOptNativeClockSample = {
  protocol: typeof NATIVE_HELPER_PROTOCOL
  platform: SkillOptNativePlatform
  bootId: string
  continuousNanoseconds: string
  wallMilliseconds: string
}

/** Values are pinned by the independent run and rechecked by the required code-owned verifier. */
export type PromotionBindings = {
  /** Explicitly selects the terminal loader-evidence API and is bound into approval, manifest, and journal. */
  witnessMode: "legacy" | "native"
  runId: string
  rootBinding: string
  sourceSha256: string
  originalSha256: string
  candidateSha256: string
  fixturePackSha256: string
  canaryFixtureSha256: string
  protocolSha256: string
  evaluatorSha256: string
  runtimeSha256: string
  resultsSha256: string
  witnessSha256: string
  nativeEngine: "codex" | "claude"
  nativeModel: string
  nativeProfileId: string
  nativeProfileSha256: string
  nativeRuntimeVersion: string
  nativeExecutableSha256: string
}

export type PromotionRecordRef = { path: string; sha256: string }
export type PromotionEvidence = {
  qualification: PromotionRecordRef
  review: PromotionRecordRef
  approval: PromotionRecordRef
}

export type PromotionFaultPoint =
  | "RUN_DIRECTORY_CREATED"
  | "ORIGINAL_BACKUP_DURABLE"
  | "MANIFEST_DURABLE"
  | "PREPARED"
  | "STAGE_DURABLE"
  | "STAGED"
  | "APPROVAL_CONSUMED"
  | "SWAP_INTENT"
  | "BEFORE_EXCHANGE"
  | "EXCHANGE_COMPLETED"
  | "RACE_HELD_JOURNALED"
  | "SWAPPED_EXPECTED"
  | "LOAD_VERIFIED"
  | "COMMIT_RECEIPT_DURABLE"
  | "COMMITTED"
  | "ROLLBACK_STAGE_DURABLE"
  | "ROLLBACK_PREPARED"
  | "ROLLBACK_SWAP_INTENT"
  | "BEFORE_ROLLBACK_EXCHANGE"
  | "ROLLBACK_EXCHANGE_COMPLETED"
  | "ROLLBACK_RACE_HELD_JOURNALED"
  | "ROLLBACK_LOAD_VERIFIED"
  | "ROLLED_BACK"

export type PromotionCommon = {
  targetPath: string
  transactionRoot: string
  nativeHelperPath: string
  nativeHelperSha256: string
  bindings: PromotionBindings
}

/** Conservative persisted-byte reservation derived from the native approval, run, and witness writers. */
export function nativePromotionArtifactBudget(operation: "apply" | "rollback"): Readonly<{
  approvalBytes: number
  transactionBytes: number
  witnessBytes: number
}> {
  if (operation !== "apply" && operation !== "rollback") fail("native-artifact-budget-operation-invalid")
  const transactionBytes = MAX_JOURNAL_BYTES +
    (operation === "apply" ? 2 * MAX_RECORD_BYTES + 3 * MAX_SKILL_BYTES : 2 * MAX_SKILL_BYTES)
  return Object.freeze({
    // One native approval file; apply and rollback approvals are separate human-authorized operations.
    approvalBytes: MAX_RECORD_BYTES,
    // apply: manifest + native commit receipt, backup + candidate stage + possible helper capture.
    // rollback: rollback stage + possible helper capture. In both cases the whole journal file is capped.
    transactionBytes,
    // Native witness artifact is external to the transaction directory and read under MAX_RECORD_BYTES.
    witnessBytes: MAX_RECORD_BYTES,
  })
}

export type PromotionPrimitiveProbeInput = {
  targetDirectory: string
  transactionRoot: string
  nativeHelperPath: string
  nativeHelperSha256: string
}

export type PromotionNativeHelperInput = Pick<PromotionCommon, "nativeHelperPath" | "nativeHelperSha256">

export type ApplySkillOptPromotionInput = PromotionCommon & {
  candidateBytes: Uint8Array
  evidence: PromotionEvidence
  /** Mandatory code-owned source/runtime/qualification verifier. No boolean or JSON-only bypass. */
  verifyEvidence: () => Promise<void>
  /** Required for native-mode apply; issued only after the exact native terminal approval is consumed. */
  nativeAuthorization?: NativePromotionAuthorization
  /** Test-only crash injection; it can stop at a durable boundary but cannot skip checks. */
  faultInjection?: (point: PromotionFaultPoint) => void
}

export type PromotionStatus =
  | "SWAPPED_EXPECTED"
  | "RACE_PRESERVED"
  | "RECOVERY_REQUIRED"
  | "LOAD_VERIFIED"
  | "COMMITTED"
  | "ROLLBACK_SWAP_INTENT"
  | "ROLLBACK_RACE_PRESERVED"
  | "ROLLED_BACK"

export type PromotionResult = {
  state: PromotionStatus
  idempotent: boolean
  raceMayHavePublishedCandidate: boolean
  reason?: string
}

declare const nativePromotionCanaryHandoffBrand: unique symbol
export type NativePromotionCanaryHandoff = Readonly<{ [nativePromotionCanaryHandoffBrand]: never }>

export type NativePromotionCanaryHandoffReceipt = Readonly<{
  handoffId: string
  transactionId: string
  bindings: PromotionBindings
  evidence: Readonly<{
    qualification: Readonly<PromotionRecordRef>
    review: Readonly<PromotionRecordRef>
    approval: Readonly<PromotionRecordRef>
  }>
  semanticReviewSha256: string
}>

declare const nativePromotionCanaryCommitBrand: unique symbol
export type NativePromotionCanaryCommit = Readonly<{ [nativePromotionCanaryCommitBrand]: never }>

declare const nativeRollbackCanaryHandoffBrand: unique symbol
export type NativeRollbackCanaryHandoff = Readonly<{ [nativeRollbackCanaryHandoffBrand]: never }>

export type NativeRollbackCanaryHandoffReceipt = Readonly<{
  handoffId: string
  transactionId: string
  bindings: PromotionBindings
  evidence: Readonly<{
    qualification: Readonly<PromotionRecordRef>
    review: Readonly<PromotionRecordRef>
    approval: Readonly<PromotionRecordRef>
  }>
  semanticReviewSha256: string
  rollbackApprovalSha256: string
}>

declare const nativeRollbackCanaryCommitBrand: unique symbol
export type NativeRollbackCanaryCommit = Readonly<{ [nativeRollbackCanaryCommitBrand]: never }>

declare const nativePromotionAuthorizationBrand: unique symbol
export type NativePromotionAuthorization = Readonly<{ [nativePromotionAuthorizationBrand]: never }>

declare const nativePromotionApprovalPreviewBrand: unique symbol
export type NativePromotionApprovalPreview = Readonly<{ [nativePromotionApprovalPreviewBrand]: never }>

export type NativePromotionApprovalOperation = "apply" | "rollback"

export type NativePromotionApprovalPreviewInput = PromotionCommon & Readonly<{
  owner: SessionStore
  operation: NativePromotionApprovalOperation
  runDeadlineAt: number
  candidateBytes?: Uint8Array
  evidence?: Pick<PromotionEvidence, "qualification" | "review">
}>

export type NativePromotionAuthorizationResult = Readonly<{
  authorization: NativePromotionAuthorization
  evidence?: PromotionEvidence
  approvalRecord: PromotionRecordRef
  expiresWallMilliseconds: string
}>

export type AuthorizeNativePromotionApprovalInput = Readonly<{
  preview: NativePromotionApprovalPreview
  owner: SessionStore
  receipt: OperatorDecision
}>

export type NativePromotionCanaryCommitResult = PromotionResult & {
  nativeCommit?: NativePromotionCanaryCommit
}

export type PromotionLoadWitness = {
  schema: typeof WITNESS_SCHEMA
  experimentId: string
  rootBinding: string
  runtimeSha256: string
  observedAt: number
  hostVersion: "1.18.33"
  executableSha256: string
  pluginSha256: string
  sdkSha256: string
  configSha256: string
  sessionId: string
  messageId: string
  parentMessageId: string
  callId: string
  skillName: "llm-wiki"
  targetRelativePath: typeof TARGET_RELATIVE_PATH
  stagedFileSha256Before: string
  stagedFileSha256After: string
  expectedBodySha256: string
  returnedBodySha256: string
  returnedPayloadSha256: string
  parserVersion: "opencode-1.18.33.skill-output.v1"
  hashBases: {
    stagedFile: "staged-file-utf8.v1"
    expectedBody: "expected-host-body-1.18.33.v1"
    returnedBody: "observed-returned-body-1.18.33.v1"
    returnedPayload: "returned-payload-utf8.v1"
  }
  loadedOriginalFileSha256: null
  originalLoadedByteAttestation: false
}

export type RecordLoadVerificationInput = Omit<PromotionCommon, "targetPath"> & {
  targetPath: string
  witness: PromotionRecordRef
  /** Must revalidate the actual host API/tool-part receipt, not infer success from this JSON alone. */
  verifyWitness: (bytes: Uint8Array, bindings: PromotionBindings, expectedFileSha256: string) => Promise<void>
  faultInjection?: (point: PromotionFaultPoint) => void
}

export type RecordNativeLoadVerificationInput = Omit<PromotionCommon, "targetPath"> & {
  targetPath: string
  witness: PromotionRecordRef
  proof: NativeSkillLoadVerificationProof
  handoff: NativePromotionCanaryHandoff
  faultInjection?: (point: PromotionFaultPoint) => void
}

export type NativeRollbackLoadVerificationInput = Omit<RecordNativeLoadVerificationInput, "handoff"> & {
  handoff: NativeRollbackCanaryHandoff
}

export type RecordNativeRollbackLoadVerificationInput = NativeRollbackLoadVerificationInput

export type NativeRollbackCanaryCommitResult = PromotionResult & {
  nativeRollbackCommit?: NativeRollbackCanaryCommit
}

export type RecoverSkillOptPromotionInput = PromotionCommon & {
  evidence: PromotionEvidence
  verifyEvidence: () => Promise<void>
}

export type RollbackSkillOptPromotionInput = PromotionCommon & {
  /** Legacy-mode owner policy bound to this exact apply receipt; native mode forbids callbacks. */
  verifyRollback?: () => Promise<void>
  /** Required for native-mode rollback; operation-bound and distinct from an apply authorization. */
  nativeAuthorization?: NativePromotionAuthorization
  faultInjection?: (point: PromotionFaultPoint) => void
}

export class PromotionError extends Error {
  constructor(readonly code: string, message = code) {
    super(message)
    this.name = "PromotionError"
  }
}

type JournalState =
  | "PREPARED" | "STAGED" | "SWAP_INTENT" | "SWAPPED_EXPECTED" | "RACE_CAPTURED" | "RACE_PRESERVED"
  | "RECOVERY_REQUIRED" | "LOAD_VERIFIED" | "COMMITTED" | "ROLLBACK_PREPARED"
  | "ROLLBACK_SWAP_INTENT" | "ROLLBACK_CAPTURED" | "ROLLBACK_RACE_PRESERVED" | "ROLLED_BACK"

type JournalCore = {
  schema: typeof JOURNAL_SCHEMA
  seq: number
  state: JournalState
  previous: string | null
  details: Record<string, unknown>
}
type JournalRecord = JournalCore & { checksum: string }
type FileSnapshot = {
  dev: string
  ino: string
  uid: number
  mode: number
  nlink: number
  size: number
  mtimeNs: string
  ctimeNs: string
  bytes: Buffer
  sha256: string
}
type DirectoryContext = { path: string; dev: string; ino: string; mode: number }
type PreparedContext = {
  common: PromotionCommon
  target: DirectoryContext
  transactionRoot: DirectoryContext
  runDir: DirectoryContext
  retention: DirectoryContext | undefined
  runDirPath: string
  bindings: PromotionBindings
  bindingsSha256: string
  targetPath: string
  runId: string
  helperPath: string
  helperSha256: string
}
type VerifiedEvidence = {
  qualificationSha256: string
  /** Digest of review artifact bytes, retained for evidence/approval/journal binding. */
  reviewSha256: string
  /** Canonical digest of actual final+safety reviewer evidence; distinct from review artifact bytes. */
  semanticReviewSha256?: string
  approvalSha256: string
  approvalId: string
}

type Manifest = {
  schema: "skillopt.promotion-manifest.v1"
  runId: string
  witnessMode: PromotionBindings["witnessMode"]
  targetRelativePath: typeof TARGET_RELATIVE_PATH
  targetDirectoryDev: string
  targetDirectoryIno: string
  bindings: PromotionBindings
  bindingsSha256: string
  qualificationSha256: string
  reviewSha256: string
  approvalSha256: string
  approvalId: string
  originalSha256: string
  candidateSha256: string
  originalMode: number
  backupName: "original.bin"
  stageName: string
  retentionDirectoryDev: string
  retentionDirectoryIno: string
}

type ActiveDescriptor = { fd: number; dev: string; ino: string }
const retainedOriginalDescriptors = new Map<string, ActiveDescriptor>()
const retainedRollbackDescriptors = new Map<string, ActiveDescriptor>()

type NativeExchangeSnapshot = Omit<FileSnapshot, "bytes" | "sha256">
type NativeExchangeReport = {
  protocol: typeof NATIVE_HELPER_PROTOCOL
  platform: SkillOptNativePlatform
  status: "EXCHANGED" | "RACE_CAPTURED" | "RACE_HELD"
  exchangeOccurred: true
  reason: string | null
  target: NativeExchangeSnapshot | null
  stage: NativeExchangeSnapshot | null
  capture: { name: string; dev: string; ino: string; size: number } | null
}
type PendingHeldExchange = {
  child: ChildProcessWithoutNullStreams
  report: NativeExchangeReport
  operation: "apply" | "rollback"
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  transactionKey: string | null
}
const pendingHeldExchanges = new Map<string, PendingHeldExchange>()

function nativeMutationCommonKey(common: PromotionCommon): string | null {
  try {
    return stable({
      targetPath: common.targetPath,
      transactionRoot: common.transactionRoot,
      nativeHelperPath: common.nativeHelperPath,
      nativeHelperSha256: common.nativeHelperSha256,
      bindings: common.bindings,
    })
  } catch { return null }
}

function nativeMutationTransactionKey(common: PromotionCommon): string | null {
  try {
    return stable({ targetPath: common.targetPath, transactionRoot: common.transactionRoot, bindings: common.bindings })
  } catch { return null }
}

function trackNativeMutationChild(child: ChildProcessWithoutNullStreams): void {
  const trackers: NativePromotionMutationTracker[] = []
  for (let tracker = nativePromotionMutationScope.getStore(); tracker; tracker = tracker.parent) {
    tracker.children.add(child)
    if (tracker.completed) tracker.uncertain = true
    trackers.push(tracker)
  }
  if (!trackers.length) return
  child.once("close", () => {
    for (const tracker of trackers) tracker.children.delete(child)
  })
}

function markNativeMutationUncertain(): void {
  for (let tracker = nativePromotionMutationScope.getStore(); tracker; tracker = tracker.parent) tracker.uncertain = true
}

async function observeNativePromotionMutation<T>(
  common: PromotionCommon,
  operation: "apply" | "rollback",
  invoke: () => Promise<T>,
): Promise<T> {
  const tracker: NativePromotionMutationTracker = {
    operation,
    commonKey: nativeMutationCommonKey(common),
    transactionKey: nativeMutationTransactionKey(common),
    parent: nativePromotionMutationScope.getStore(),
    children: new Set(),
    uncertain: false,
    completed: false,
  }
  return nativePromotionMutationScope.run(tracker, async () => {
    try {
      const outcome = await invoke()
      tracker.completed = true
      recordNativePromotionMutationOutcome(outcome, tracker)
      return outcome
    } catch (error) {
      tracker.completed = true
      recordNativePromotionMutationOutcome(error, tracker)
      throw error
    }
  })
}

/** Reports terminality only for the exact object returned or thrown by a tracked native mutation invocation. */
export function nativePromotionMutationIsQuiescent(
  outcome: unknown,
  common: PromotionCommon,
  operation: "apply" | "rollback",
): boolean {
  try {
    if (common.bindings.witnessMode !== "native" || !outcome ||
        (typeof outcome !== "object" && typeof outcome !== "function")) return false
    const tracker = nativePromotionMutationOutcomes.get(outcome as object)
    const commonKey = nativeMutationCommonKey(common)
    const transactionKey = nativeMutationTransactionKey(common)
    return Boolean(tracker && tracker.completed && !tracker.uncertain && tracker.children.size === 0 &&
      tracker.operation === operation && commonKey !== null && tracker.commonKey === commonKey && transactionKey !== null &&
      tracker.transactionKey === transactionKey &&
      ![...pendingHeldExchanges.values()].some(pending => pending.transactionKey === transactionKey))
  } catch { return false }
}

type NativePromotionHandoffState = {
  readonly handle: NativePromotionCanaryHandoff
  readonly operation: "apply"
  readonly handoffId: string
  readonly transactionId: string
  readonly bindings: Readonly<PromotionBindings>
  readonly bindingsSha256: string
  readonly evidence: Readonly<PromotionEvidence>
  readonly verifiedEvidence: VerifiedEvidence
  consumed: boolean
  proofAttempted: boolean
  commitIssued: boolean
  committed: boolean
}
type NativePromotionCommitState = {
  readonly handoff: NativePromotionHandoffState
  consumed: boolean
}
type NativeRollbackOperationState = {
  readonly authorizationState: NativePromotionAuthorizationState
  readonly transactionId: string
  readonly rollbackIntentSeq: number
  readonly rollbackIntentChecksum: string
  readonly rollbackApprovalSha256: string
  readonly approvalClock: SkillOptNativeClockSample
  readonly backupIdentity: NativeApprovalFileIdentity
  readonly originalIdentity: NativeApprovalFileIdentity
  readonly candidateIdentity: NativeApprovalFileIdentity
  readonly candidateDescriptorIdentity: NativeApprovalFileIdentity
}
type NativeRollbackHandoffState = {
  readonly handle: NativeRollbackCanaryHandoff
  readonly operation: NativeRollbackOperationState
  readonly handoffId: string
  readonly bindings: Readonly<PromotionBindings>
  readonly bindingsSha256: string
  readonly evidence: Readonly<PromotionEvidence>
  readonly verifiedEvidence: VerifiedEvidence
  readonly semanticReviewSha256: string
  consumed: boolean
  proofAttempted: boolean
  commitIssued: boolean
  committed: boolean
}
type NativeRollbackCommitState = {
  readonly handoff: NativeRollbackHandoffState
  consumed: boolean
}
type NativeApprovalFileIdentity = Readonly<{
  dev: string
  ino: string
  uid: number
  mode: number
  nlink: number
  size: number
  mtimeNs: string
  ctimeNs: string
  sha256: string
}>
type NativePromotionOwnerPrincipal = Readonly<{
  sessionID: string
  epoch: string
  admission: Readonly<{ sessionID: string; epoch: string; leaseId: string }>
  metadata: Readonly<{
    engine: string
    model: string | null
    routes: ComboRoutes | null
  }>
}>
type NativePromotionApprovalPreviewState = {
  readonly preview: NativePromotionApprovalPreview
  readonly operation: NativePromotionApprovalOperation
  readonly common: Readonly<PromotionCommon>
  readonly owner: SessionStore
  readonly ownerSessionID: string
  readonly ownerEpoch: string
  readonly ownerPrincipal: NativePromotionOwnerPrincipal
  readonly admissionLease: NonNullable<ReturnType<typeof captureAdmissionLease>>
  readonly runDeadlineAt: number
  readonly clock: SkillOptNativeClockSample
  readonly expiresContinuousNanoseconds: bigint
  readonly expiresWallMilliseconds: bigint
  readonly decisionBinding: Readonly<DecisionBinding>
  readonly evidenceRefs?: Readonly<{ qualification: Readonly<PromotionRecordRef>; review: Readonly<PromotionRecordRef> }>
  readonly candidateSha256: string
  readonly candidateBytes: number
  readonly snapshot: Readonly<Record<string, unknown>>
  readonly snapshotSha256: string
  consumed: boolean
}
type NativePromotionAuthorizationState = NativePromotionApprovalPreviewState & {
  readonly authorization: NativePromotionAuthorization
  readonly approvalRecord: Readonly<PromotionRecordRef>
  readonly approvalRecordSha256: string
  readonly approvalRecordValue: Readonly<Record<string, unknown>>
  readonly evidence?: Readonly<PromotionEvidence>
  inProgress: boolean
  consumed: boolean
}
const nativePromotionHandoffStates = new WeakMap<object, NativePromotionHandoffState>()
const nativePromotionCommitStates = new WeakMap<object, NativePromotionCommitState>()
const nativeRollbackHandoffStates = new WeakMap<object, NativeRollbackHandoffState>()
const nativeRollbackCommitStates = new WeakMap<object, NativeRollbackCommitState>()
const nativePromotionApprovalPreviewStates = new WeakMap<object, NativePromotionApprovalPreviewState>()
const nativePromotionAuthorizationStates = new WeakMap<object, NativePromotionAuthorizationState>()
const nativePromotionHandoffTransactions = new Set<string>()
const nativeRollbackOperations = new Map<string, NativeRollbackOperationState>()
const nativeRollbackHandoffTransactions = new Set<string>()

type NativePromotionMutationTracker = {
  readonly operation: "apply" | "rollback"
  readonly commonKey: string | null
  readonly transactionKey: string | null
  readonly parent: NativePromotionMutationTracker | undefined
  readonly children: Set<ChildProcessWithoutNullStreams>
  uncertain: boolean
  completed: boolean
}
const nativePromotionMutationScope = new AsyncLocalStorage<NativePromotionMutationTracker>()
const nativePromotionMutationOutcomes = new WeakMap<object, NativePromotionMutationTracker>()
// Uncertain native outcomes remain strongly reachable; this is observation retention, never mutation authority.
const nativePromotionMutationUncertainOutcomes = new Map<object, NativePromotionMutationTracker>()

function recordNativePromotionMutationOutcome(outcome: unknown, tracker: NativePromotionMutationTracker): void {
  if ((!outcome || (typeof outcome !== "object" && typeof outcome !== "function"))) return
  const value = outcome as object
  const previous = nativePromotionMutationOutcomes.get(value)
  if (previous && previous !== tracker) {
    previous.uncertain = true
    tracker.uncertain = true
    nativePromotionMutationUncertainOutcomes.set(value, previous)
    return
  }
  nativePromotionMutationOutcomes.set(value, tracker)
  if (tracker.uncertain) nativePromotionMutationUncertainOutcomes.set(value, tracker)
}

const descriptorKey = (ctx: PreparedContext): string =>
  `${ctx.transactionRoot.dev}:${ctx.transactionRoot.ino}:${ctx.target.dev}:${ctx.target.ino}:${ctx.runId}:${ctx.bindingsSha256}`
function closeRetainedExchangeDescriptor(ctx: PreparedContext, operation: "apply" | "rollback"): void {
  const key = descriptorKey(ctx)
  const descriptors = operation === "apply" ? retainedOriginalDescriptors : retainedRollbackDescriptors
  const retained = descriptors.get(key)
  if (!retained) return
  try { closeSync(retained.fd) } finally { descriptors.delete(key) }
}
function fail(code: string): never { throw new PromotionError(code) }
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex")
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) fail("invalid-json-value")
  return encoded
}
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const isInt64Decimal = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]{0,18})(?![\s\S])/.test(value)) return false
  const parsed = BigInt(value)
  return parsed >= INT64_MIN && parsed <= INT64_MAX
}
const sameIdentity = (left: FileSnapshot, right: FileSnapshot): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink &&
  left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.sha256 === right.sha256
const sameRecordedSnapshot = (file: FileSnapshot, details: Record<string, unknown>, prefix: string): boolean =>
  file.dev === String(details[`${prefix}Dev`]) && file.ino === String(details[`${prefix}Ino`]) &&
  file.sha256 === details[`${prefix}Sha256`] && file.size === details[`${prefix}Size`] &&
  file.mode === details[`${prefix}Mode`] && file.mtimeNs === details[`${prefix}MtimeNs`] && file.ctimeNs === details[`${prefix}CtimeNs`]
const randomName = (runId: string, suffix: string): string =>
  `.skillopt-${runId.slice(0, 32)}-${randomBytes(12).toString("hex")}.${suffix}`
const validTransactionName = (runId: string, value: unknown, suffix: "stage" | "rollback"): value is string => {
  if (typeof value !== "string") return false
  const prefix = `.skillopt-${runId.slice(0, 32)}-`
  return value.startsWith(prefix) && basename(value) === value && /^[a-f0-9]{24}\.(?:stage|rollback)$/.test(value.slice(prefix.length)) &&
    value.endsWith(`.${suffix}`)
}

function validBindings(value: PromotionBindings): void {
  if (!isObject(value) || !sameKeys(value, [
    "witnessMode", "runId", "rootBinding", "sourceSha256", "originalSha256", "candidateSha256", "fixturePackSha256",
    "canaryFixtureSha256", "protocolSha256", "evaluatorSha256", "runtimeSha256", "resultsSha256", "witnessSha256",
    "nativeEngine", "nativeModel", "nativeProfileId", "nativeProfileSha256", "nativeRuntimeVersion", "nativeExecutableSha256",
  ])) fail("invalid-bindings")
  if (value.witnessMode !== "legacy" && value.witnessMode !== "native") fail("invalid-binding-witnessMode")
  if (!ID.test(value.runId)) fail("invalid-run-id")
  for (const key of ["rootBinding", "sourceSha256", "originalSha256", "candidateSha256", "fixturePackSha256", "canaryFixtureSha256",
    "protocolSha256", "evaluatorSha256", "runtimeSha256", "resultsSha256", "witnessSha256", "nativeProfileSha256", "nativeExecutableSha256"] as const) {
    if (typeof value[key] !== "string" || !HASH.test(value[key])) fail(`invalid-binding-${key}`)
  }
  if (value.nativeEngine !== "codex" && value.nativeEngine !== "claude") fail("invalid-binding-nativeEngine")
  if (typeof value.nativeModel !== "string" || !value.nativeModel || Buffer.byteLength(value.nativeModel, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(value.nativeModel) ||
      typeof value.nativeProfileId !== "string" || !value.nativeProfileId || Buffer.byteLength(value.nativeProfileId, "utf8") > 128 || /[\u0000-\u001f\u007f]/u.test(value.nativeProfileId) ||
      typeof value.nativeRuntimeVersion !== "string" || !value.nativeRuntimeVersion || Buffer.byteLength(value.nativeRuntimeVersion, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(value.nativeRuntimeVersion)) {
    fail("invalid-binding-native-identity")
  }
}

function requireWitnessMode(value: PromotionBindings, expected: PromotionBindings["witnessMode"]): void {
  if (!value || value.witnessMode !== expected) fail(expected === "native" ? "native-load-mode-required" : "native-load-proof-required")
}

function directoryContext(path: string, mode: number): DirectoryContext {
  if (!path || !resolve(path) || !path.startsWith("/")) fail("directory-path-not-absolute")
  const canonical = realpathSync.native(path)
  if (canonical !== resolve(path)) fail("directory-path-not-canonical")
  const st = lstatSync(canonical)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o7777) !== mode || (st.mode & 0o022)) {
    fail("unsafe-directory")
  }
  return { path: canonical, dev: String(st.dev), ino: String(st.ino), mode: st.mode & 0o7777 }
}

function preparePaths(input: PromotionCommon): PreparedContext {
  requireNativePlatform()
  validBindings(input.bindings)
  if (input.targetPath !== resolve(input.targetPath) || !input.targetPath.startsWith("/")) fail("target-path-not-canonical")
  if (basename(input.targetPath) !== "SKILL.md") fail("wrong-target-name")
  const targetPath = resolve(input.targetPath)
  const targetDir = dirname(targetPath)
  if (basename(targetDir) !== "llm-wiki" || basename(dirname(targetDir)) !== "skills" || basename(dirname(dirname(targetDir))) !== ".agents") {
    fail("wrong-target-location")
  }
  const target = directoryContext(targetDir, (lstatSync(targetDir).mode & 0o7777))
  const worktree = resolve(targetDir, "../../..")
  const canonicalWorktree = realpathSync.native(worktree)
  if (canonicalWorktree !== worktree) fail("worktree-path-not-canonical")
  for (const directory of [worktree, join(worktree, ".agents"), join(worktree, ".agents", "skills"), targetDir]) {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)) fail("unsafe-target-parent-directory")
  }
  const transactionRoot = directoryContext(input.transactionRoot, DIRECTORY_MODE)
  if (input.transactionRoot !== resolve(input.transactionRoot)) fail("transaction-root-not-canonical")
  if (!HASH.test(input.nativeHelperSha256)) fail("invalid-helper-digest")
  const helperResolved = realpathSync.native(input.nativeHelperPath)
  if (helperResolved !== resolve(input.nativeHelperPath)) fail("helper-path-not-canonical")
  const helperStat = lstatSync(helperResolved)
  if (!helperStat.isFile() || helperStat.isSymbolicLink() || helperStat.nlink !== 1 || helperStat.uid !== process.getuid?.() ||
      !(helperStat.mode & 0o111) || (helperStat.mode & 0o7000)) {
    fail("unsafe-native-helper")
  }
  const runDirPath = join(transactionRoot.path, input.bindings.runId)
  return {
    common: input,
    target,
    transactionRoot,
    runDir: { path: "", dev: "", ino: "", mode: DIRECTORY_MODE },
    retention: undefined,
    runDirPath,
    bindings: input.bindings,
    bindingsSha256: sha256(stable(input.bindings)),
    targetPath,
    runId: input.bindings.runId,
    helperPath: helperResolved,
    helperSha256: input.nativeHelperSha256,
  }
}

/** Capability probe for parent-owned scratch paths only; it never targets the production skill file. */
export function preflightSkillOptPromotion(input: PromotionPrimitiveProbeInput): {
  protocol: typeof NATIVE_HELPER_PROTOCOL
  platform: SkillOptNativePlatform
  probedDirectories: 2
} {
  const platform = requireNativePlatform()
  if (!HASH.test(input.nativeHelperSha256) || input.nativeHelperPath !== resolve(input.nativeHelperPath)) fail("invalid-helper-path-or-digest")
  const helperPath = realpathSync.native(input.nativeHelperPath)
  if (helperPath !== input.nativeHelperPath) fail("helper-path-not-canonical")
  const helperStat = lstatSync(helperPath)
  if (!helperStat.isFile() || helperStat.isSymbolicLink() || helperStat.nlink !== 1 || helperStat.uid !== process.getuid?.() ||
      !(helperStat.mode & 0o111) || (helperStat.mode & 0o7000)) fail("unsafe-native-helper")
  const target = directoryContext(input.targetDirectory, lstatSync(input.targetDirectory).mode & 0o7777)
  if (basename(target.path) === "llm-wiki" && basename(dirname(target.path)) === "skills" &&
      basename(dirname(dirname(target.path))) === ".agents") fail("production-directory-probe-forbidden")
  const transaction = directoryContext(input.transactionRoot, DIRECTORY_MODE)
  verifyNativeProtocol(helperPath, input.nativeHelperSha256, platform)
  runNative(helperPath, input.nativeHelperSha256, ["probe", target.path, target.dev, target.ino])
  runNative(helperPath, input.nativeHelperSha256, ["probe", transaction.path, transaction.dev, transaction.ino])
  return { protocol: NATIVE_HELPER_PROTOCOL, platform, probedDirectories: 2 }
}

export function readSkillOptNativeClock(input: PromotionNativeHelperInput): SkillOptNativeClockSample {
  const platform = requireNativePlatform()
  if (!HASH.test(input.nativeHelperSha256) || input.nativeHelperPath !== resolve(input.nativeHelperPath)) fail("invalid-helper-path-or-digest")
  const helperPath = realpathSync.native(input.nativeHelperPath)
  if (helperPath !== input.nativeHelperPath) fail("helper-path-not-canonical")
  const helperStat = lstatSync(helperPath)
  if (!helperStat.isFile() || helperStat.isSymbolicLink() || helperStat.nlink !== 1 || helperStat.uid !== process.getuid?.() ||
      !(helperStat.mode & 0o111) || (helperStat.mode & 0o7000)) fail("unsafe-native-helper")
  verifyNativeProtocol(helperPath, input.nativeHelperSha256, platform)
  const output = runNative(helperPath, input.nativeHelperSha256, ["clock"])
  const parsed = parseNativeJsonLine(output, "native-clock-invalid-json")
  if (!isObject(parsed) || !sameKeys(parsed, ["protocol", "platform", "bootId", "continuousNanoseconds", "wallMilliseconds"]) ||
      parsed.protocol !== NATIVE_HELPER_PROTOCOL || parsed.platform !== platform ||
      typeof parsed.bootId !== "string" || parsed.bootId.length !== 36 || !NATIVE_BOOT_ID.test(parsed.bootId) ||
      typeof parsed.continuousNanoseconds !== "string" || !/^(?:0|[1-9][0-9]{0,19})(?![\s\S])/.test(parsed.continuousNanoseconds) ||
      typeof parsed.wallMilliseconds !== "string" || !/^(?:0|[1-9][0-9]{0,19})(?![\s\S])/.test(parsed.wallMilliseconds)) {
    fail("native-clock-invalid-sample")
  }
  const continuousNanoseconds = BigInt(parsed.continuousNanoseconds)
  const wallMilliseconds = BigInt(parsed.wallMilliseconds)
  if (continuousNanoseconds === 0n || wallMilliseconds === 0n || continuousNanoseconds > UINT64_MAX || wallMilliseconds > UINT64_MAX) {
    fail("native-clock-invalid-sample")
  }
  return parsed as SkillOptNativeClockSample
}

function trustedNativeApprovalClock(input: PromotionNativeHelperInput): SkillOptNativeClockSample {
  const sample = readSkillOptNativeClock(input)
  const wall = BigInt(sample.wallMilliseconds)
  const processWall = BigInt(Date.now())
  const skew = wall > processWall ? wall - processWall : processWall - wall
  if (skew > NATIVE_CLOCK_WALL_TOLERANCE_MS) fail("native-approval-clock-uncertain")
  return sample
}

function nativeApprovalExpiry(sample: SkillOptNativeClockSample, runDeadlineAt: number): {
  expiresContinuousNanoseconds: bigint
  expiresWallMilliseconds: bigint
} {
  const nativeWall = BigInt(sample.wallMilliseconds)
  if (nativeWall > BigInt(Number.MAX_SAFE_INTEGER)) fail("native-approval-clock-uncertain")
  if (!Number.isSafeInteger(runDeadlineAt) || runDeadlineAt <= Number(nativeWall)) fail("native-approval-run-deadline-invalid")
  const allowedMilliseconds = Math.min(NATIVE_APPROVAL_TTL_MS, runDeadlineAt - Number(nativeWall))
  if (!Number.isSafeInteger(allowedMilliseconds) || allowedMilliseconds <= 0) fail("native-approval-run-deadline-invalid")
  const expiresContinuousNanoseconds = BigInt(sample.continuousNanoseconds) + BigInt(allowedMilliseconds) * 1_000_000n
  const expiresWallMilliseconds = nativeWall + BigInt(allowedMilliseconds)
  if (expiresContinuousNanoseconds > UINT64_MAX || expiresWallMilliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("native-approval-clock-uncertain")
  }
  return {
    expiresContinuousNanoseconds,
    expiresWallMilliseconds,
  }
}

function validNativeApprovalWindow(approvedAt: unknown, expiresAt: unknown): boolean {
  if (typeof approvedAt !== "string" || typeof expiresAt !== "string" ||
      !/^(?:0|[1-9][0-9]{0,19})$/u.test(approvedAt) || !/^(?:0|[1-9][0-9]{0,19})$/u.test(expiresAt)) return false
  const approved = BigInt(approvedAt)
  const expires = BigInt(expiresAt)
  return approved <= UINT64_MAX && expires <= UINT64_MAX && expires > approved &&
    expires - approved <= BigInt(NATIVE_APPROVAL_TTL_MS) * 1_000_000n
}

function assertNativeApprovalClockCurrent(state: NativePromotionApprovalPreviewState): SkillOptNativeClockSample {
  const current = trustedNativeApprovalClock(state.common)
  const currentContinuous = BigInt(current.continuousNanoseconds)
  const startContinuous = BigInt(state.clock.continuousNanoseconds)
  const currentWall = BigInt(current.wallMilliseconds)
  const startWall = BigInt(state.clock.wallMilliseconds)
  if (current.bootId !== state.clock.bootId || currentContinuous < startContinuous ||
      currentContinuous >= state.expiresContinuousNanoseconds || currentWall < startWall ||
      currentWall >= state.expiresWallMilliseconds || currentWall >= BigInt(state.runDeadlineAt)) {
    fail("native-approval-expired-or-clock-reset")
  }
  const elapsedMonotonicMilliseconds = (currentContinuous - startContinuous) / 1_000_000n
  const elapsedWallMilliseconds = currentWall - startWall
  const elapsedSkew = elapsedMonotonicMilliseconds > elapsedWallMilliseconds
    ? elapsedMonotonicMilliseconds - elapsedWallMilliseconds : elapsedWallMilliseconds - elapsedMonotonicMilliseconds
  if (elapsedSkew > NATIVE_CLOCK_WALL_TOLERANCE_MS) fail("native-approval-clock-uncertain")
  return current
}

function requireNativePlatform(): SkillOptNativePlatform {
  if (process.platform === "darwin" || process.platform === "linux") return process.platform
  fail("unsupported-native-platform")
}

function parseNativeJsonLine(output: string, errorCode: string): unknown {
  if (!output.endsWith("\n") || output.indexOf("\n") !== output.length - 1) fail(errorCode)
  try { return JSON.parse(output.slice(0, -1)) } catch { return fail(errorCode) }
}

function verifyNativeProtocol(helperPath: string, helperSha256: string, platform: SkillOptNativePlatform): void {
  const parsed = parseNativeJsonLine(runNative(helperPath, helperSha256, ["protocol"]), "native-helper-protocol-invalid-json")
  if (!isObject(parsed) || !sameKeys(parsed, ["protocol", "platform"]) ||
      parsed.protocol !== NATIVE_HELPER_PROTOCOL || parsed.platform !== platform) fail("native-helper-protocol-mismatch")
}

function nativeCloseOnExecFlag(): number {
  if (process.platform === "darwin") return 0x01000000
  if (process.platform === "linux") return 0x00080000
  fail("unsupported-native-platform")
}

function runNative(helperPath: string, expectedHelperSha256: string, args: readonly string[], maxBuffer = 256 * 1024): string {
  verifyNativeHelper(helperPath, expectedHelperSha256)
  const result = spawnSync(helperPath, args, { encoding: "utf8", maxBuffer, windowsHide: true, shell: false })
  if (result.error || result.status !== 0) fail("native-helper-failed")
  return result.stdout
}

function verifyNativeHelper(helperPath: string, expectedHelperSha256: string): void {
  const st = lstatSync(helperPath)
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || !(st.mode & 0o111)) fail("unsafe-native-helper")
  const bytes = readStablePath(helperPath, 8 * 1024 * 1024, null, true)
  if (sha256(bytes) !== expectedHelperSha256) fail("native-helper-digest-mismatch")
}

function parseNativeExchangeReport(line: string): NativeExchangeReport {
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return fail("native-exchange-invalid-json") }
  const platform = requireNativePlatform()
  if (!isObject(parsed) || !sameKeys(parsed, ["protocol", "platform", "status", "exchangeOccurred", "reason", "target", "stage", "capture"]) ||
      parsed.protocol !== NATIVE_HELPER_PROTOCOL || parsed.platform !== platform ||
      !["EXCHANGED", "RACE_CAPTURED", "RACE_HELD"].includes(String(parsed.status)) || parsed.exchangeOccurred !== true ||
      !(parsed.reason === null || typeof parsed.reason === "string")) fail("native-exchange-invalid-report")
  const parseSnapshot = (value: unknown): NativeExchangeSnapshot | null => {
    if (value === null) return null
    if (!isObject(value) || !sameKeys(value, ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) ||
        typeof value.dev !== "string" || !/^\d+$/.test(value.dev) || typeof value.ino !== "string" || !/^\d+$/.test(value.ino) ||
        typeof value.uid !== "number" || !Number.isSafeInteger(value.uid) || value.uid !== process.getuid?.() ||
        typeof value.mode !== "number" || !Number.isSafeInteger(value.mode) ||
        typeof value.nlink !== "number" || !Number.isSafeInteger(value.nlink) || value.nlink < 0 ||
        typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 ||
        !isInt64Decimal(value.mtimeNs) || !isInt64Decimal(value.ctimeNs)) fail("native-exchange-invalid-snapshot")
    return value as unknown as NativeExchangeSnapshot
  }
  let capture: NativeExchangeReport["capture"] = null
  if (parsed.capture !== null) {
    if (!isObject(parsed.capture) || !sameKeys(parsed.capture, ["name", "dev", "ino", "size"]) ||
        typeof parsed.capture.name !== "string" || basename(parsed.capture.name) !== parsed.capture.name ||
        !/^[A-Za-z0-9._-]{1,200}$/.test(parsed.capture.name) || typeof parsed.capture.dev !== "string" || !/^\d+$/.test(parsed.capture.dev) ||
        typeof parsed.capture.ino !== "string" || !/^\d+$/.test(parsed.capture.ino) ||
        typeof parsed.capture.size !== "number" || !Number.isSafeInteger(parsed.capture.size) ||
        parsed.capture.size < 0 || parsed.capture.size > MAX_SKILL_BYTES) fail("native-exchange-invalid-capture")
    capture = parsed.capture as NativeExchangeReport["capture"]
  }
  const target = parseSnapshot(parsed.target)
  const stage = parseSnapshot(parsed.stage)
  if (parsed.status === "EXCHANGED" && (parsed.reason !== null || !target || !stage || target.nlink !== 1 || stage.nlink !== 1 || capture)) {
    fail("native-exchange-exchanged-report-invalid")
  }
  if (parsed.status === "RACE_CAPTURED" && (parsed.reason !== "unexpected-displaced-inode" || !target || !capture)) {
    fail("native-exchange-capture-report-invalid")
  }
  if (parsed.status === "RACE_HELD" && typeof parsed.reason !== "string") fail("native-exchange-held-report-invalid")
  return {
    protocol: NATIVE_HELPER_PROTOCOL,
    platform,
    status: parsed.status as NativeExchangeReport["status"],
    exchangeOccurred: true,
    reason: parsed.reason as string | null,
    target,
    stage,
    capture,
  }
}

function makePendingHeldExchange(child: ChildProcessWithoutNullStreams, report: NativeExchangeReport, operation: PendingHeldExchange["operation"],
  closed: PendingHeldExchange["closed"], transactionKey: string | null): PendingHeldExchange {
  return { child, report, operation, closed, transactionKey }
}

async function runNativeExchange(
  ctx: PreparedContext,
  args: readonly string[],
  operation: PendingHeldExchange["operation"],
  onHeld: (report: NativeExchangeReport) => Promise<void>,
): Promise<NativeExchangeReport> {
  verifyNativeHelper(ctx.helperPath, ctx.helperSha256)
  const child: ChildProcessWithoutNullStreams = spawn(ctx.helperPath, args, {
    stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
  })
  trackNativeMutationChild(child)
  let closeObserved = false
  const closed: PendingHeldExchange["closed"] = new Promise((resolveClose) => {
    child.once("close", (code, signal) => { closeObserved = true; resolveClose({ code, signal }) })
  })
  let stdout = ""
  let stderr = ""
  let lineSettled = false
  let protocolError: Error | undefined
  let resolveLine!: (line: string) => void
  let rejectLine!: (error: Error) => void
  const lineReady = new Promise<string>((resolveLineReady, rejectLineReady) => {
    resolveLine = resolveLineReady
    rejectLine = rejectLineReady
  })
  const onData = (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
    if (Buffer.byteLength(stdout) > MAX_RECORD_BYTES) {
      protocolError = new PromotionError("native-exchange-output-too-large")
      const firstNewline = stdout.indexOf("\n")
      if (!lineSettled && firstNewline >= 0) { lineSettled = true; resolveLine(stdout.slice(0, firstNewline)) }
      else if (!lineSettled) { lineSettled = true; rejectLine(protocolError) }
      return
    }
    const newline = stdout.indexOf("\n")
    if (newline >= 0) {
      if (newline !== stdout.length - 1) {
        protocolError = new PromotionError("native-exchange-extra-output")
        if (!lineSettled) { lineSettled = true; resolveLine(stdout.slice(0, newline)) }
        return
      }
      if (!lineSettled) { lineSettled = true; resolveLine(stdout.slice(0, newline)) }
    }
  }
  child.stdout.on("data", onData)
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
    if (Buffer.byteLength(stderr) > MAX_RECORD_BYTES) stderr = "native helper diagnostic exceeded limit"
  })
  child.once("error", () => {
    if (!lineSettled) { lineSettled = true; rejectLine(new PromotionError("native-exchange-start-failed")) }
  })
  child.once("close", (code) => {
    if (!lineSettled) {
      lineSettled = true
      rejectLine(new PromotionError(code === 0 ? "native-exchange-response-missing" : "native-exchange-failed"))
    }
  })
  let line: string
  try { line = await lineReady }
  catch (error) {
    if (protocolError && !closeObserved) markNativeMutationUncertain()
    throw error
  }
  let report: NativeExchangeReport
  try { report = parseNativeExchangeReport(line) }
  catch (error) {
    if (!closeObserved) markNativeMutationUncertain()
    throw error
  }
  if (report.status === "RACE_HELD") {
    markNativeMutationUncertain()
    const key = descriptorKey(ctx)
    const pending = makePendingHeldExchange(child, report, operation, closed,
      nativePromotionMutationScope.getStore()?.transactionKey ?? null)
    pendingHeldExchanges.set(key, pending)
    await onHeld(report)
    if (protocolError) throw protocolError
    // Recovery metadata is not authority to discard an uncaptured user inode.
    return report
  }
  const result = await closed
  if (protocolError || result.code !== 0 || result.signal !== null) {
    fail(protocolError ? "native-exchange-extra-output" : stderr ? "native-exchange-failed" : "native-exchange-exit-invalid")
  }
  return report
}

function retentionDirectory(ctx: PreparedContext): DirectoryContext {
  if (!ctx.retention) fail("retention-directory-unbound")
  return ctx.retention
}

function nativeSnapshotMatches(file: FileSnapshot, observed: NativeExchangeSnapshot): boolean {
  return file.dev === observed.dev && file.ino === observed.ino && file.uid === observed.uid && file.mode === observed.mode &&
    file.nlink === observed.nlink && file.size === observed.size && file.mtimeNs === observed.mtimeNs && file.ctimeNs === observed.ctimeNs
}

type RetainedArtifact = {
  directoryDev: string
  directoryIno: string
  name: string
  dev: string
  ino: string
  size: number
  sha256: string
}

function inspectReportedCapture(ctx: PreparedContext, report: NativeExchangeReport, expectedName: string): RetainedArtifact {
  const capture = report.capture
  if (!capture || capture.name !== expectedName) fail("native-capture-name-mismatch")
  const dir = retentionDirectory(ctx)
  const file = helperInspect(ctx, dir, capture.name)
  if (file.dev !== capture.dev || file.ino !== capture.ino || file.size !== capture.size || file.nlink !== 1 ||
      (file.mode & 0o7777) !== FILE_MODE || file.uid !== process.getuid?.()) fail("native-capture-inspection-mismatch")
  return {
    directoryDev: dir.dev, directoryIno: dir.ino, name: capture.name,
    dev: file.dev, ino: file.ino, size: file.size, sha256: file.sha256,
  }
}

function verifyRetainedArtifact(ctx: PreparedContext, value: unknown): { details: RetainedArtifact; file: FileSnapshot } {
  if (!isObject(value) || !sameKeys(value, ["directoryDev", "directoryIno", "name", "dev", "ino", "size", "sha256"]) ||
      typeof value.directoryDev !== "string" || typeof value.directoryIno !== "string" ||
      typeof value.name !== "string" || basename(value.name) !== value.name || !/^[A-Za-z0-9._-]{1,200}$/.test(value.name) ||
      typeof value.dev !== "string" || !/^\d+$/.test(value.dev) || typeof value.ino !== "string" || !/^\d+$/.test(value.ino) ||
      typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_SKILL_BYTES ||
      typeof value.sha256 !== "string" || !HASH.test(value.sha256)) fail("retained-artifact-record-invalid")
  const dir = retentionDirectory(ctx)
  if (value.directoryDev !== dir.dev || value.directoryIno !== dir.ino) fail("retained-artifact-directory-mismatch")
  const file = helperInspect(ctx, dir, value.name)
  if (file.dev !== value.dev || file.ino !== value.ino || file.size !== value.size || file.sha256 !== value.sha256 ||
      file.nlink !== 1 || (file.mode & 0o7777) !== FILE_MODE || file.uid !== process.getuid?.()) fail("retained-artifact-drift")
  return { details: value as unknown as RetainedArtifact, file }
}

function capturedRaceResult(ctx: PreparedContext, records: JournalRecord[], report: NativeExchangeReport, operation: "apply" | "rollback",
  stageName: string, captureName: string): PromotionResult {
  const retainedArtifact = inspectReportedCapture(ctx, report, captureName)
  const state = operation === "apply" ? "RACE_CAPTURED" : "ROLLBACK_CAPTURED"
  appendJournal(ctx, records, state, {
    nativeHelperProtocol: report.protocol,
    nativeHelperPlatform: report.platform,
    nativeHelperStatus: report.status,
    reason: report.reason,
    targetObservation: report.target,
    stageObservation: report.stage,
    retainedArtifact,
    stageName,
  })
  const captured = records.at(-1)!
  const terminalState = operation === "apply" ? "RACE_PRESERVED" : "ROLLBACK_RACE_PRESERVED"
  appendJournal(ctx, records, terminalState, {
    reason: "native-helper-captured-displaced-raced-inode",
    ...(operation === "apply" ? { stageName } : { rollbackStageName: stageName }),
    retainedArtifact,
    captureRecordSeq: captured.seq,
    captureRecordChecksum: captured.checksum,
    targetName: "SKILL.md",
  })
  closeRetainedExchangeDescriptor(ctx, operation)
  return {
    state: terminalState,
    idempotent: false,
    raceMayHavePublishedCandidate: operation === "apply",
    reason: "native-helper-captured-displaced-raced-inode",
  }
}

function finishCapturedRace(ctx: PreparedContext, records: JournalRecord[], operation: "apply" | "rollback"): PromotionResult {
  const state = operation === "apply" ? "RACE_CAPTURED" : "ROLLBACK_CAPTURED"
  const capture = recordsByName(records, state)
  if (!capture) fail("retained-artifact-journal-record-missing")
  verifyRetainedArtifact(ctx, capture.details.retainedArtifact)
  const terminalState = operation === "apply" ? "RACE_PRESERVED" : "ROLLBACK_RACE_PRESERVED"
  appendJournal(ctx, records, terminalState, {
    reason: "recovered-native-helper-capture",
    ...(operation === "apply" ? { stageName: capture.details.stageName } : { rollbackStageName: capture.details.stageName }),
    retainedArtifact: capture.details.retainedArtifact,
    captureRecordSeq: capture.seq,
    captureRecordChecksum: capture.checksum,
    targetName: "SKILL.md",
  })
  closeRetainedExchangeDescriptor(ctx, operation)
  return {
    state: terminalState,
    idempotent: false,
    raceMayHavePublishedCandidate: operation === "apply",
    reason: "recovered-native-helper-capture",
  }
}

function heldRecoveryDetails(ctx: PreparedContext, report: NativeExchangeReport, operation: "apply" | "rollback",
  captureName: string): Record<string, unknown> {
  let retainedArtifact: RetainedArtifact | null = null
  let captureVerificationError: string | null = null
  if (report.capture) {
    try { retainedArtifact = inspectReportedCapture(ctx, report, captureName) }
    catch (error) { captureVerificationError = error instanceof PromotionError ? error.code : "capture-inspection-failed" }
  }
  return {
    reason: "native-helper-held-open-inodes-for-recovery",
    nativeHelperProtocol: report.protocol,
    nativeHelperPlatform: report.platform,
    nativeHelperStatus: report.status,
    helperPid: pendingHeldExchanges.get(descriptorKey(ctx))?.child.pid ?? null,
    exchangeKind: operation,
    exchangeOccurred: report.exchangeOccurred,
    helperReason: report.reason,
    captureName,
    retentionDirectoryDev: retentionDirectory(ctx).dev,
    retentionDirectoryIno: retentionDirectory(ctx).ino,
    targetObservation: report.target,
    stageObservation: report.stage,
    captureObservation: report.capture,
    retainedArtifact,
    captureVerificationError,
  }
}

function nativeExchangeArgs(ctx: PreparedContext, targetName: string, target: FileSnapshot, stageName: string,
  stage: FileSnapshot, captureName: string): string[] {
  const retention = retentionDirectory(ctx)
  return [
    "exchange", ctx.target.path, ctx.target.dev, ctx.target.ino,
    targetName, target.dev, target.ino, stageName, stage.dev, stage.ino,
    retention.path, retention.dev, retention.ino, captureName,
  ]
}

function nativeVersion(ctx: PreparedContext): void {
  verifyNativeProtocol(ctx.helperPath, ctx.helperSha256, requireNativePlatform())
}

function helperDirectoryPath(ctx: PreparedContext, dir: DirectoryContext, command: string, ...tail: string[]): string {
  return runNative(ctx.helperPath, ctx.helperSha256, [command, dir.path, dir.dev, dir.ino, ...tail])
}

function syncDirectory(ctx: PreparedContext, dir: DirectoryContext): void {
  helperDirectoryPath(ctx, dir, "sync-dir")
}

function flushFile(ctx: PreparedContext, dir: DirectoryContext, name: string, snapshot: Pick<FileSnapshot, "dev" | "ino">): void {
  helperDirectoryPath(ctx, dir, "flush-file", name, snapshot.dev, snapshot.ino)
}

function helperInspect(ctx: PreparedContext, dir: DirectoryContext, name: string): FileSnapshot {
  const output = helperDirectoryPath(ctx, dir, "inspect", name)
  let value: unknown
  try { value = JSON.parse(output) } catch { return fail("native-inspect-invalid-json") }
  if (!isObject(value) || !sameKeys(value, ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs", "base64"])) fail("native-inspect-invalid-record")
  if (typeof value.dev !== "string" || typeof value.ino !== "string" || typeof value.uid !== "number" || !Number.isSafeInteger(value.uid) ||
      value.uid !== process.getuid?.() || typeof value.mode !== "number" || !Number.isSafeInteger(value.mode) ||
      typeof value.nlink !== "number" || !Number.isSafeInteger(value.nlink) || typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) || !isInt64Decimal(value.mtimeNs) || !isInt64Decimal(value.ctimeNs) ||
      typeof value.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) {
    fail("native-inspect-invalid-fields")
  }
  const bytes = Buffer.from(value.base64, "base64")
  if (bytes.toString("base64") !== value.base64 || bytes.length !== value.size || bytes.length > MAX_SKILL_BYTES || value.nlink !== 1 ||
      (value.mode & 0o170000) !== 0o100000 || (value.mode & 0o7000) !== 0) fail("unsafe-regular-file")
  return {
    dev: value.dev, ino: value.ino, uid: value.uid as number, mode: value.mode, nlink: value.nlink, size: value.size,
    mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs, bytes, sha256: sha256(bytes),
  }
}

function readFdStable(fd: number, expectedBytes: number): Buffer {
  const before = fstatSync(fd, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(expectedBytes) || expectedBytes > MAX_SKILL_BYTES) fail("unsafe-open-file")
  const bytes: Buffer = Buffer.alloc(expectedBytes)
  let offset = 0
  while (offset < expectedBytes) {
    const count = readSync(fd, bytes, offset, expectedBytes - offset, offset)
    if (count <= 0) fail("short-file-read")
    offset += count
  }
  const after = fstatSync(fd, { bigint: true })
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mode !== after.mode || before.nlink !== after.nlink || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    fail("file-changed-during-read")
  }
  return bytes
}

function statMatchesSnapshot(st: Stats, expected: FileSnapshot): boolean {
  return st.isFile() && String(st.dev) === expected.dev && String(st.ino) === expected.ino &&
    st.nlink === 1 && st.size === expected.size && (st.mode & 0o7777) === (expected.mode & 0o7777)
}

function openTargetDescriptor(ctx: PreparedContext, expected: FileSnapshot): number {
  const fd = openSync(ctx.targetPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | nativeCloseOnExecFlag())
  try {
    const st = fstatSync(fd)
    if (!statMatchesSnapshot(st, expected)) fail("target-descriptor-drift")
    const bytes = readFdStable(fd, expected.size)
    if (sha256(bytes) !== expected.sha256) fail("target-descriptor-content-drift")
    const again = helperInspect(ctx, ctx.target, "SKILL.md")
    if (!sameIdentity(again, expected)) fail("target-changed-during-open")
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function readStablePath(path: string, maximum: number, mode: number | null, requireOwner: boolean): Buffer {
  if (!path.startsWith("/") || path !== resolve(path) || realpathSync.native(path) !== path) fail("unsafe-file-path")
  const before = lstatSync(path, { bigint: true })
  const ownerUid = process.getuid?.()
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum) ||
      (mode !== null && (before.mode & 0o7777n) !== BigInt(mode)) ||
      (requireOwner && (ownerUid === undefined || before.uid !== BigInt(ownerUid)))) fail("unsafe-file")
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | nativeCloseOnExecFlag())
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
        opened.mode !== before.mode || opened.uid !== before.uid || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs ||
        (mode !== null && (opened.mode & 0o7777n) !== BigInt(mode)) ||
        (requireOwner && (ownerUid === undefined || opened.uid !== BigInt(ownerUid)))) fail("file-replaced-during-open")
    const bytes: Buffer = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) fail("short-file-read")
      offset += count
    }
    const after = fstatSync(fd, { bigint: true })
    const pathAfter = lstatSync(path, { bigint: true })
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mode !== opened.mode ||
        after.uid !== opened.uid || after.nlink !== opened.nlink || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
        pathAfter.dev !== after.dev || pathAfter.ino !== after.ino || pathAfter.size !== after.size || pathAfter.mode !== after.mode ||
        pathAfter.uid !== after.uid || pathAfter.nlink !== after.nlink || pathAfter.mtimeNs !== after.mtimeNs || pathAfter.ctimeNs !== after.ctimeNs) {
      fail("file-changed-during-read")
    }
    return bytes
  } finally {
    closeSync(fd)
  }
}

function readSecureRecord(reference: PromotionRecordRef): { bytes: Buffer; value: Record<string, unknown> } {
  if (!isObject(reference) || !sameKeys(reference, ["path", "sha256"]) || typeof reference.path !== "string" ||
      !HASH.test(reference.sha256) || !reference.path.startsWith("/")) fail("invalid-record-reference")
  const bytes = readStablePath(reference.path, MAX_RECORD_BYTES, FILE_MODE, true)
  if (sha256(bytes) !== reference.sha256) fail("record-digest-mismatch")
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("record-invalid-utf8")
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return fail("record-invalid-json") }
  if (!isObject(parsed)) fail("record-not-object")
  return { bytes, value: parsed }
}

function exactBindings(candidate: unknown, expected: PromotionBindings): boolean {
  return isObject(candidate) && stable(candidate) === stable(expected)
}

function validateNativeSemanticReview(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 2) fail("review-semantic-evidence-invalid")
  const phases = ["final", "safety"] as const
  for (const [index, phase] of phases.entries()) {
    const item = value[index]
    if (!isObject(item) || !sameKeys(item, ["phase", "status", "promptSha256", "responseSha256", "assessment", "findings"]) ||
        item.phase !== phase || item.status !== "valid" || typeof item.promptSha256 !== "string" || !HASH.test(item.promptSha256) ||
        typeof item.responseSha256 !== "string" || !HASH.test(item.responseSha256) || item.assessment !== "clear" ||
        !Array.isArray(item.findings) || item.findings.length !== 0) fail("review-semantic-evidence-invalid")
  }
  // This JSON-only fixed shape hashes identically to campaign.ts's canonicalJson(reviewerEvidence).
  return sha256(stable(value))
}

function validateQualificationAndReview(
  evidence: Pick<PromotionEvidence, "qualification" | "review">,
  bindings: PromotionBindings,
): Pick<VerifiedEvidence, "qualificationSha256" | "reviewSha256" | "semanticReviewSha256"> {
  if (!isObject(evidence) || !sameKeys(evidence, ["qualification", "review"])) fail("invalid-qualification-review-evidence")
  const qualification = readSecureRecord(evidence.qualification as PromotionRecordRef)
  const review = readSecureRecord(evidence.review as PromotionRecordRef)
  const q = qualification.value
  const r = review.value
  if (!sameKeys(q, ["schemaVersion", "bindings", "decision", "reasons"]) || q.schemaVersion !== 1 ||
      q.decision !== "qualified" || !Array.isArray(q.reasons) || q.reasons.length !== 0 || !exactBindings(q.bindings, bindings)) {
    fail("qualification-record-invalid")
  }
  const qualificationSha256 = sha256(qualification.bytes)
  const reviewKeys = bindings.witnessMode === "native"
    ? ["schemaVersion", "bindings", "qualificationSha256", "reviewerId", "verdict", "semanticReview"]
    : ["schemaVersion", "bindings", "qualificationSha256", "reviewerId", "verdict"]
  if (!sameKeys(r, reviewKeys) || r.schemaVersion !== 1 ||
      r.verdict !== "approve" || typeof r.reviewerId !== "string" || !ID.test(r.reviewerId) ||
      r.qualificationSha256 !== qualificationSha256 || !exactBindings(r.bindings, bindings)) {
    fail("review-record-invalid")
  }
  const semanticReviewSha256 = bindings.witnessMode === "native" ? validateNativeSemanticReview(r.semanticReview) : undefined
  return {
    qualificationSha256,
    reviewSha256: sha256(review.bytes),
    ...(semanticReviewSha256 ? { semanticReviewSha256 } : {}),
  }
}

function validateEvidence(evidence: PromotionEvidence, bindings: PromotionBindings): VerifiedEvidence {
  if (!isObject(evidence) || !sameKeys(evidence, ["qualification", "review", "approval"])) fail("invalid-evidence")
  const hashes = validateQualificationAndReview({ qualification: evidence.qualification, review: evidence.review }, bindings)
  const approval = readSecureRecord(evidence.approval as PromotionRecordRef)
  const a = approval.value
  const qualificationSha256 = hashes.qualificationSha256
  const reviewSha256 = hashes.reviewSha256
  const approvalKeys = bindings.witnessMode === "native"
    ? ["schemaVersion", "bindings", "qualificationSha256", "reviewSha256", "approvalId", "observedAt", "action", "nativeApproval"]
    : ["schemaVersion", "bindings", "qualificationSha256", "reviewSha256", "approvalId", "observedAt", "action"]
  if (!sameKeys(a, approvalKeys) ||
      a.schemaVersion !== 1 || a.action !== "approve-production-apply" || typeof a.approvalId !== "string" || !ID.test(a.approvalId) ||
      typeof a.observedAt !== "number" || !Number.isSafeInteger(a.observedAt) || a.observedAt <= 0 || a.qualificationSha256 !== qualificationSha256 ||
      a.reviewSha256 !== reviewSha256 || !exactBindings(a.bindings, bindings)) fail("approval-record-invalid")
  if (bindings.witnessMode === "native") {
    const nativeApproval = a.nativeApproval
    if (!isObject(nativeApproval) || !sameKeys(nativeApproval, [
      "schema", "operation", "ownerSessionID", "ownerEpoch", "subjectSha256", "nativeBootId",
      "approvedAtContinuousNanoseconds", "expiresContinuousNanoseconds", "runDeadlineAt",
    ]) || nativeApproval.schema !== "skillopt.native-operator-approval.v1" || nativeApproval.operation !== "apply" ||
        typeof nativeApproval.ownerSessionID !== "string" || !nativeApproval.ownerSessionID ||
        typeof nativeApproval.ownerEpoch !== "string" || !nativeApproval.ownerEpoch ||
        typeof nativeApproval.subjectSha256 !== "string" || !HASH.test(nativeApproval.subjectSha256) ||
        typeof nativeApproval.nativeBootId !== "string" || !NATIVE_BOOT_ID.test(nativeApproval.nativeBootId) ||
        typeof nativeApproval.approvedAtContinuousNanoseconds !== "string" ||
        !/^(?:0|[1-9][0-9]{0,19})$/u.test(nativeApproval.approvedAtContinuousNanoseconds) ||
        typeof nativeApproval.expiresContinuousNanoseconds !== "string" ||
        !/^(?:0|[1-9][0-9]{0,19})$/u.test(nativeApproval.expiresContinuousNanoseconds) ||
        !validNativeApprovalWindow(nativeApproval.approvedAtContinuousNanoseconds, nativeApproval.expiresContinuousNanoseconds) ||
        typeof nativeApproval.runDeadlineAt !== "number" || !Number.isSafeInteger(nativeApproval.runDeadlineAt)) {
      fail("native-approval-record-invalid")
    }
  }
  return {
    qualificationSha256,
    reviewSha256,
    ...(hashes.semanticReviewSha256 ? { semanticReviewSha256: hashes.semanticReviewSha256 } : {}),
    approvalSha256: sha256(approval.bytes),
    approvalId: a.approvalId as string,
  }
}

function assertNativeOwnerCurrent(
  ctx: PreparedContext,
  owner: SessionStore,
  expected: NativePromotionOwnerPrincipal,
  admissionLease: NonNullable<ReturnType<typeof captureAdmissionLease>>,
): void {
  const worktree = resolve(ctx.target.path, "../../..")
  try {
    owner.assertOwner()
    if (!expected.sessionID || owner.sessionID !== expected.sessionID || owner.epoch !== expected.epoch ||
        expected.admission.sessionID !== expected.sessionID || expected.admission.epoch !== expected.epoch ||
        getOwnedSession(worktree, owner.sessionID) !== owner || admissionEpoch(worktree, owner.sessionID) !== expected.epoch ||
        !isAdmissionLeaseCurrent(worktree, owner.sessionID, admissionLease)) {
      fail("native-approval-owner-stale")
    }
    const current = nativePromotionOwnerPrincipal(owner, expected.admission)
    if (stable(current) !== stable(expected)) fail("native-approval-owner-stale")
  } catch (error) {
    if (error instanceof PromotionError) throw error
    fail("native-approval-owner-stale")
  }
}

function nativePromotionOwnerPrincipal(
  owner: SessionStore,
  admission: NativePromotionOwnerPrincipal["admission"],
): NativePromotionOwnerPrincipal {
  const metadata = owner.metadata
  return Object.freeze({
    sessionID: owner.sessionID,
    epoch: owner.epoch,
    admission,
    metadata: Object.freeze({
      engine: metadata.engine,
      model: metadata.model ?? null,
      routes: canonicalRoutes(metadata.routes) ?? null,
    }),
  })
}

function nativeApprovalFileIdentity(file: FileSnapshot): NativeApprovalFileIdentity {
  return Object.freeze({
    dev: file.dev, ino: file.ino, uid: file.uid, mode: file.mode, nlink: file.nlink,
    size: file.size, mtimeNs: file.mtimeNs, ctimeNs: file.ctimeNs, sha256: file.sha256,
  })
}

function sameNativeApprovalFileIdentityExceptCtime(
  actual: NativeApprovalFileIdentity,
  approved: NativeApprovalFileIdentity,
): boolean {
  // The approved inode is checked before exchange; exchange may update inode ctime, so bind its
  // post-exchange identity from the live path and retained FD instead of treating that as drift.
  return actual.dev === approved.dev && actual.ino === approved.ino && actual.uid === approved.uid &&
    actual.mode === approved.mode && actual.nlink === approved.nlink && actual.size === approved.size &&
    actual.mtimeNs === approved.mtimeNs && actual.sha256 === approved.sha256
}

function collectNativeApprovalSnapshot(input: Readonly<{
  ctx: PreparedContext
  operation: NativePromotionApprovalOperation
  evidenceRefs?: NativePromotionApprovalPreviewState["evidenceRefs"]
  candidateSha256: string
  candidateBytes: number
}>): Readonly<Record<string, unknown>> {
  const { ctx, operation } = input
  const worktree = resolve(ctx.target.path, "../../..")
  if (realpathSync.native(worktree) !== worktree || ctx.bindings.rootBinding !== sha256(`root:${worktree}`)) {
    fail("native-approval-root-binding-invalid")
  }
  const target = helperInspect(ctx, ctx.target, "SKILL.md")
  const common = {
    operation,
    runId: ctx.runId,
    targetPath: ctx.targetPath,
    targetRelativePath: TARGET_RELATIVE_PATH,
    rootBinding: ctx.bindings.rootBinding,
    worktree: { path: worktree, stat: stablePathStatTuple(worktree, true) },
    targetParent: { path: ctx.target.path, dev: ctx.target.dev, ino: ctx.target.ino, mode: ctx.target.mode },
    agentsDirectory: stablePathStatTuple(join(worktree, ".agents"), true),
    skillsDirectory: stablePathStatTuple(join(worktree, ".agents", "skills"), true),
    transactionRoot: { path: ctx.transactionRoot.path, dev: ctx.transactionRoot.dev, ino: ctx.transactionRoot.ino, mode: ctx.transactionRoot.mode },
    bindings: ctx.bindings,
    bindingsSha256: ctx.bindingsSha256,
    target: nativeApprovalFileIdentity(target),
    candidateSha256: input.candidateSha256,
    candidateBytes: input.candidateBytes,
  }
  if (operation === "apply") {
    if (target.sha256 !== ctx.bindings.originalSha256 || input.candidateSha256 !== ctx.bindings.candidateSha256 ||
        input.candidateSha256 === ctx.bindings.originalSha256 || input.candidateBytes <= 0 ||
        input.candidateBytes > MAX_SKILL_BYTES) fail("native-apply-approval-target-binding-mismatch")
    try {
      lstatSync(ctx.runDirPath)
      fail("native-apply-approval-run-already-exists")
    } catch (error) {
      if (error instanceof PromotionError) throw error
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (!input.evidenceRefs) fail("native-apply-approval-evidence-required")
    const hashes = validateQualificationAndReview(input.evidenceRefs as Pick<PromotionEvidence, "qualification" | "review">, ctx.bindings)
    return Object.freeze({
      ...common,
      backup: { state: "planned-copy-of-original", sha256: target.sha256, mode: target.mode & 0o7777, sourceIdentity: nativeApprovalFileIdentity(target) },
      qualificationSha256: hashes.qualificationSha256,
      reviewSha256: hashes.reviewSha256,
      ...(hashes.semanticReviewSha256 ? { semanticReviewSha256: hashes.semanticReviewSha256 } : {}),
      qualificationPath: input.evidenceRefs.qualification.path,
      reviewPath: input.evidenceRefs.review.path,
    })
  }

  if (input.evidenceRefs || input.candidateSha256 !== ctx.bindings.candidateSha256 || input.candidateBytes !== target.size ||
      target.sha256 !== ctx.bindings.candidateSha256) fail("native-rollback-approval-target-binding-mismatch")
  setRunDirectory(ctx)
  const records = readJournal(ctx)
  const manifest = verifyRunJournal(ctx, records)
  const latest = records.at(-1)
  if (!latest || !["SWAPPED_EXPECTED", "LOAD_VERIFIED", "COMMITTED"].includes(latest.state)) {
    fail("native-rollback-approval-apply-journal-invalid")
  }
  const artifacts = verifyArtifactsAtExpectedSwap(ctx, records, manifest)
  if (!sameIdentity(artifacts.live, target) || artifacts.live.sha256 !== ctx.bindings.candidateSha256 ||
      artifacts.displaced.sha256 !== ctx.bindings.originalSha256) fail("native-rollback-approval-candidate-drift")
  const backup = helperInspect(ctx, ctx.runDir, manifest.backupName)
  if (backup.sha256 !== ctx.bindings.originalSha256 || (backup.mode & 0o7777) !== manifest.originalMode) {
    fail("native-rollback-approval-backup-invalid")
  }
  const journalBytes = readStablePath(join(ctx.runDirPath, "journal.jsonl"), MAX_JOURNAL_BYTES, FILE_MODE, true)
  const manifestBytes = readStablePath(join(ctx.runDirPath, "manifest.json"), MAX_RECORD_BYTES, FILE_MODE, true)
  return Object.freeze({
    ...common,
    latestState: latest.state,
    latestJournalSeq: latest.seq,
    latestJournalChecksum: latest.checksum,
    applyJournalSha256: sha256(journalBytes),
    manifestSha256: sha256(manifestBytes),
    applyApprovalSha256: manifest.approvalSha256,
    backup: nativeApprovalFileIdentity(backup),
    displacedOriginal: nativeApprovalFileIdentity(artifacts.displaced),
  })
}

function assertNativePromotionApprovalSnapshot(state: NativePromotionApprovalPreviewState, ctx: PreparedContext): void {
  assertNativeOwnerCurrent(ctx, state.owner, state.ownerPrincipal, state.admissionLease)
  assertNativeApprovalClockCurrent(state)
  const snapshot = collectNativeApprovalSnapshot({
    ctx,
    operation: state.operation,
    evidenceRefs: state.evidenceRefs,
    candidateSha256: state.candidateSha256,
    candidateBytes: state.candidateBytes,
  })
  if (sha256(stable(snapshot)) !== state.snapshotSha256 || stable(snapshot) !== stable(state.snapshot)) {
    fail("native-approval-preview-stale")
  }
}

function nativeApprovalDirectory(ctx: PreparedContext): DirectoryContext {
  const path = join(ctx.transactionRoot.path, "approvals")
  try { return directoryContext(path, DIRECTORY_MODE) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    mkdirSync(path, { mode: DIRECTORY_MODE })
    const created = directoryContext(path, DIRECTORY_MODE)
    syncDirectory(ctx, ctx.transactionRoot)
    return created
  }
}

function writeNativeApprovalRecord(ctx: PreparedContext, operation: NativePromotionApprovalOperation, record: unknown): PromotionRecordRef {
  const directory = nativeApprovalDirectory(ctx)
  const name = `native-${operation}-${ctx.runId.slice(0, 32)}-${randomBytes(12).toString("hex")}.json`
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8")
  const file = writeExclusive(ctx, directory, name, bytes, FILE_MODE)
  return Object.freeze({ path: join(directory.path, name), sha256: file.sha256 })
}

function deepFreezeApprovalMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeApprovalMetadata(item)
    return Object.freeze(value)
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) deepFreezeApprovalMetadata(item)
    return Object.freeze(value)
  }
  return value
}

/** Preview exact operation authority. This performs stable reads only and never creates approval files or transaction state. */
export async function previewNativePromotionApproval(
  input: NativePromotionApprovalPreviewInput,
): Promise<Readonly<{
  preview: NativePromotionApprovalPreview
  decisionBinding: DecisionBinding
  details: Readonly<Record<string, unknown>>
  expiresWallMilliseconds: string
}>> {
  requireWitnessMode(input.bindings, "native")
  if (!input.owner || (input.operation !== "apply" && input.operation !== "rollback") ||
      !Number.isSafeInteger(input.runDeadlineAt)) fail("native-approval-preview-invalid")
  const ctx = preparePaths(input)
  const ownerSessionID = input.owner.sessionID
  const ownerEpoch = input.owner.epoch
  input.owner.assertOwner()
  const admissionLease = captureAdmissionLease(resolve(ctx.target.path, "../../.."), ownerSessionID)
  if (!admissionLease || admissionEpoch(resolve(ctx.target.path, "../../.."), ownerSessionID) !== ownerEpoch) {
    fail("native-approval-admission-unavailable")
  }
  const ownerPrincipal = nativePromotionOwnerPrincipal(input.owner, Object.freeze({
    sessionID: ownerSessionID,
    epoch: ownerEpoch,
    leaseId: randomBytes(16).toString("hex"),
  }))
  assertNativeOwnerCurrent(ctx, input.owner, ownerPrincipal, admissionLease)
  let candidateBytes: Buffer
  let evidenceRefs: NativePromotionApprovalPreviewState["evidenceRefs"]
  if (input.operation === "apply") {
    if (!(input.candidateBytes instanceof Uint8Array) || !input.evidence ||
        !sameKeys(input.evidence as unknown as Record<string, unknown>, ["qualification", "review"])) {
      fail("native-apply-approval-input-invalid")
    }
    candidateBytes = Buffer.from(input.candidateBytes)
    if (candidateBytes.length <= 0 || candidateBytes.length > MAX_SKILL_BYTES || sha256(candidateBytes) !== ctx.bindings.candidateSha256) {
      fail("native-apply-approval-candidate-invalid")
    }
    evidenceRefs = Object.freeze({
      qualification: Object.freeze({ ...input.evidence.qualification }),
      review: Object.freeze({ ...input.evidence.review }),
    })
  } else {
    if (input.candidateBytes !== undefined || input.evidence !== undefined) fail("native-rollback-approval-input-invalid")
    candidateBytes = Buffer.alloc(0)
  }
  const clock = trustedNativeApprovalClock(ctx.common)
  const expiry = nativeApprovalExpiry(clock, input.runDeadlineAt)
  const candidateSha256 = input.operation === "apply" ? sha256(candidateBytes) : ctx.bindings.candidateSha256
  const target = helperInspect(ctx, ctx.target, "SKILL.md")
  const approvalSnapshot = collectNativeApprovalSnapshot({
    ctx,
    operation: input.operation,
    evidenceRefs,
    candidateSha256,
    candidateBytes: input.operation === "apply" ? candidateBytes.length : target.size,
  })
  const subjectFields = Object.freeze({
    schema: "skillopt.native-operator-subject.v1",
    operation: input.operation,
    action: input.operation === "apply" ? "approve-production-apply" : "approve-production-rollback",
    snapshot: approvalSnapshot,
    ownerPrincipal,
    ownerSessionID,
    ownerEpoch,
    nativeBootId: clock.bootId,
    createdContinuousNanoseconds: clock.continuousNanoseconds,
    expiresContinuousNanoseconds: expiry.expiresContinuousNanoseconds.toString(),
    expiresWallMilliseconds: expiry.expiresWallMilliseconds.toString(),
    runDeadlineAt: input.runDeadlineAt,
  })
  const subjectSha256 = sha256(stable(subjectFields))
  const details = deepFreezeApprovalMetadata(JSON.parse(JSON.stringify(subjectFields))) as Readonly<Record<string, unknown>>
  const decisionBinding: Readonly<DecisionBinding> = Object.freeze({
    sessionID: ownerSessionID,
    workflowID: `${input.operation}-${ctx.runId}`.slice(0, 128),
    expectedRevision: input.operation === "apply" ? 1 : Number((approvalSnapshot.latestJournalSeq as number) ?? 1),
    subject: Object.freeze({ kind: "implementation-unit" as const, id: ctx.runId, sha256: subjectSha256 }),
  })
  const preview = Object.freeze({}) as NativePromotionApprovalPreview
  const state: NativePromotionApprovalPreviewState = {
    preview,
    operation: input.operation,
    common: Object.freeze({
      targetPath: ctx.targetPath,
      transactionRoot: ctx.transactionRoot.path,
      nativeHelperPath: ctx.helperPath,
      nativeHelperSha256: ctx.helperSha256,
      bindings: Object.freeze({ ...ctx.bindings }),
    }),
    owner: input.owner,
    ownerSessionID,
    ownerEpoch,
    ownerPrincipal,
    admissionLease,
    runDeadlineAt: input.runDeadlineAt,
    clock,
    expiresContinuousNanoseconds: expiry.expiresContinuousNanoseconds,
    expiresWallMilliseconds: expiry.expiresWallMilliseconds,
    decisionBinding,
    ...(evidenceRefs ? { evidenceRefs } : {}),
    candidateSha256,
    candidateBytes: input.operation === "apply" ? candidateBytes.length : target.size,
    snapshot: approvalSnapshot,
    snapshotSha256: sha256(stable(approvalSnapshot)),
    consumed: false,
  }
  nativePromotionApprovalPreviewStates.set(preview, state)
  return Object.freeze({
    preview,
    decisionBinding,
    details,
    expiresWallMilliseconds: expiry.expiresWallMilliseconds.toString(),
  })
}

/** Consume the real one-use terminal decision, revalidate its live owner/snapshot/clock, then persist one approval record. */
export async function authorizeNativePromotionApproval(
  input: AuthorizeNativePromotionApprovalInput,
): Promise<NativePromotionAuthorizationResult> {
  const decision = consumeOperatorDecision(input.receipt)
  const state = input.preview && typeof input.preview === "object" ? nativePromotionApprovalPreviewStates.get(input.preview) : undefined
  if (!state || state.preview !== input.preview || state.consumed) fail("native-approval-preview-invalid-or-consumed")
  state.consumed = true
  if (decision.action !== "approve" || decision.sessionID !== state.decisionBinding.sessionID ||
      decision.workflowID !== state.decisionBinding.workflowID || decision.expectedRevision !== state.decisionBinding.expectedRevision ||
      decision.subject.kind !== state.decisionBinding.subject.kind || decision.subject.id !== state.decisionBinding.subject.id ||
      decision.subject.sha256 !== state.decisionBinding.subject.sha256 || input.owner !== state.owner) fail("native-operator-decision-binding-mismatch")
  const ctx = preparePaths(state.common)
  const release = await lockNative(ctx)
  try {
    assertNativePromotionApprovalSnapshot(state, ctx)
    const clock = trustedNativeApprovalClock(ctx.common)
    if (clock.bootId !== state.clock.bootId || BigInt(clock.continuousNanoseconds) >= state.expiresContinuousNanoseconds ||
        BigInt(clock.wallMilliseconds) >= state.expiresWallMilliseconds) fail("native-approval-expired-or-clock-reset")
    const approvalId = `approval-${randomBytes(16).toString("hex")}`
    const nativeApproval = {
      schema: "skillopt.native-operator-approval.v1",
      operation: state.operation,
      ownerSessionID: state.ownerSessionID,
      ownerEpoch: state.ownerEpoch,
      subjectSha256: state.decisionBinding.subject.sha256,
      nativeBootId: state.clock.bootId,
      approvedAtContinuousNanoseconds: clock.continuousNanoseconds,
      expiresContinuousNanoseconds: state.expiresContinuousNanoseconds.toString(),
      runDeadlineAt: state.runDeadlineAt,
    }
    const record = state.operation === "apply"
      ? {
        schemaVersion: 1,
        bindings: ctx.bindings,
        qualificationSha256: (state.snapshot.qualificationSha256 as string),
        reviewSha256: (state.snapshot.reviewSha256 as string),
        approvalId,
        observedAt: Number(clock.wallMilliseconds),
        action: "approve-production-apply",
        nativeApproval,
      }
      : {
        schema: "skillopt.native-rollback-approval.v1",
        operation: "rollback",
        runId: ctx.runId,
        bindings: ctx.bindings,
        bindingsSha256: ctx.bindingsSha256,
        subjectSha256: state.decisionBinding.subject.sha256,
        ownerSessionID: state.ownerSessionID,
        ownerEpoch: state.ownerEpoch,
        applyJournalSha256: state.snapshot.applyJournalSha256,
        manifestSha256: state.snapshot.manifestSha256,
        applyApprovalSha256: state.snapshot.applyApprovalSha256,
        candidateSha256: state.snapshot.candidateSha256,
        candidateIdentity: state.snapshot.target,
        backupSha256: (state.snapshot.backup as NativeApprovalFileIdentity).sha256,
        backupInode: (state.snapshot.backup as NativeApprovalFileIdentity).ino,
        backupIdentity: state.snapshot.backup,
        nativeBootId: state.clock.bootId,
        approvedAtContinuousNanoseconds: clock.continuousNanoseconds,
        expiresContinuousNanoseconds: state.expiresContinuousNanoseconds.toString(),
        runDeadlineAt: state.runDeadlineAt,
        approvalId,
      }
    const approvalRecord = writeNativeApprovalRecord(ctx, state.operation, record)
    const authorization = Object.freeze({}) as NativePromotionAuthorization
    const evidence: PromotionEvidence | undefined = state.operation === "apply" && state.evidenceRefs
      ? Object.freeze({ ...state.evidenceRefs, approval: approvalRecord })
      : undefined
    const authState: NativePromotionAuthorizationState = {
      ...state,
      authorization,
      approvalRecord,
      approvalRecordSha256: approvalRecord.sha256,
      approvalRecordValue: Object.freeze(JSON.parse(JSON.stringify(record)) as Record<string, unknown>),
      ...(evidence ? { evidence: Object.freeze(evidence) } : {}),
      inProgress: false,
      consumed: false,
    }
    nativePromotionAuthorizationStates.set(authorization, authState)
    return Object.freeze({
      authorization,
      ...(evidence ? { evidence } : {}),
      approvalRecord,
      expiresWallMilliseconds: state.expiresWallMilliseconds.toString(),
    })
  } finally {
    await release()
  }
}

function verifyNativeApprovalRecord(ctx: PreparedContext, state: NativePromotionAuthorizationState): void {
  if (state.approvalRecord.sha256 !== state.approvalRecordSha256 ||
      dirname(state.approvalRecord.path) !== join(ctx.transactionRoot.path, "approvals")) {
    fail("native-approval-record-reference-invalid")
  }
  const record = readSecureRecord(state.approvalRecord)
  if (stable(record.value) !== stable(state.approvalRecordValue)) fail("native-approval-record-changed")
}

function assertNativePromotionAuthorizationActive(ctx: PreparedContext, state: NativePromotionAuthorizationState): void {
  const recordOperation = state.operation === "apply"
    ? isObject(state.approvalRecordValue.nativeApproval) ? state.approvalRecordValue.nativeApproval.operation : undefined
    : state.approvalRecordValue.operation
  if (nativePromotionAuthorizationStates.get(state.authorization) !== state || !state.consumed || !state.inProgress ||
      recordOperation !== state.operation ||
      stable(state.common.bindings) !== stable(ctx.bindings) || sha256(stable(ctx.bindings)) !== state.snapshot.bindingsSha256) {
    fail("native-authorization-invalid-or-consumed")
  }
  assertNativeOwnerCurrent(ctx, state.owner, state.ownerPrincipal, state.admissionLease)
  assertNativeApprovalClockCurrent(state)
  verifyNativeApprovalRecord(ctx, state)
}

function consumeNativePromotionAuthorization(input: Readonly<{
  value: NativePromotionAuthorization | undefined
  ctx: PreparedContext
  operation: NativePromotionApprovalOperation
  candidateBytes?: Uint8Array
  evidence?: PromotionEvidence
}>): NativePromotionAuthorizationState {
  const state = input.value && typeof input.value === "object" ? nativePromotionAuthorizationStates.get(input.value) : undefined
  if (!state || state.authorization !== input.value || state.consumed || state.inProgress) fail("native-authorization-required-or-consumed")
  state.consumed = true
  state.inProgress = true
  if (state.operation !== input.operation || !exactBindings(state.common.bindings, input.ctx.bindings)) {
    fail("native-authorization-operation-or-binding-mismatch")
  }
  assertNativePromotionApprovalSnapshot(state, input.ctx)
  verifyNativeApprovalRecord(input.ctx, state)
  if (input.operation === "apply") {
    if (!input.evidence || !state.evidence || stable(input.evidence) !== stable(state.evidence) ||
        !(input.candidateBytes instanceof Uint8Array) || sha256(input.candidateBytes) !== state.candidateSha256 ||
        Buffer.byteLength(input.candidateBytes) !== state.candidateBytes) fail("native-authorization-apply-binding-mismatch")
    const evidence = validateEvidence(input.evidence, input.ctx.bindings)
    if (evidence.approvalSha256 !== state.approvalRecordSha256 ||
        stable(readSecureRecord(input.evidence.approval).value) !== stable(state.approvalRecordValue)) {
      fail("native-authorization-approval-evidence-mismatch")
    }
  } else {
    if (input.evidence !== undefined || input.candidateBytes !== undefined) fail("native-authorization-rollback-input-mismatch")
    const approval = state.approvalRecordValue
    if (approval.operation !== "rollback" || approval.schema !== "skillopt.native-rollback-approval.v1" ||
        approval.applyJournalSha256 !== state.snapshot.applyJournalSha256 ||
        approval.candidateSha256 !== state.snapshot.candidateSha256 ||
        approval.backupSha256 !== (state.snapshot.backup as NativeApprovalFileIdentity).sha256) {
      fail("native-authorization-rollback-binding-mismatch")
    }
  }
  assertNativePromotionAuthorizationActive(input.ctx, state)
  return state
}

/** Revalidates a live, unused native rollback authorization without consuming its filesystem mutation authority. */
export function assertNativeRollbackAuthorizationCurrent(
  input: PromotionCommon & Readonly<{ owner: SessionStore; nativeAuthorization: NativePromotionAuthorization }>,
): Readonly<{ approvalRecordSha256: string }> {
  const ctx = preparePaths(input)
  const state = input.nativeAuthorization && typeof input.nativeAuthorization === "object"
    ? nativePromotionAuthorizationStates.get(input.nativeAuthorization) : undefined
  if (!state || state.authorization !== input.nativeAuthorization || state.operation !== "rollback" || state.consumed ||
      state.inProgress || state.owner !== input.owner ||
      stable(state.common) !== stable({ targetPath: input.targetPath, transactionRoot: input.transactionRoot,
        nativeHelperPath: input.nativeHelperPath, nativeHelperSha256: input.nativeHelperSha256, bindings: input.bindings })) {
    fail("native-rollback-authorization-invalid-or-consumed")
  }
  assertNativePromotionApprovalSnapshot(state, ctx)
  verifyNativeApprovalRecord(ctx, state)
  if (state.approvalRecordValue.operation !== "rollback" ||
      state.approvalRecordValue.schema !== "skillopt.native-rollback-approval.v1" ||
      state.approvalRecordSha256 !== state.approvalRecord.sha256) fail("native-rollback-authorization-invalid-or-consumed")
  return Object.freeze({ approvalRecordSha256: state.approvalRecordSha256 })
}

function ensureRunDirectory(ctx: PreparedContext): void {
  const rootStat = lstatSync(ctx.transactionRoot.path)
  if (String(rootStat.dev) !== ctx.transactionRoot.dev || String(rootStat.ino) !== ctx.transactionRoot.ino) fail("transaction-root-replaced")
  mkdirSync(ctx.runDirPath, { mode: DIRECTORY_MODE })
  const dir = directoryContext(ctx.runDirPath, DIRECTORY_MODE)
  ctx.runDir = dir
  syncDirectory(ctx, ctx.transactionRoot)
}

function createRetentionDirectory(ctx: PreparedContext): DirectoryContext {
  const path = join(ctx.runDir.path, "retained")
  mkdirSync(path, { mode: DIRECTORY_MODE })
  const retention = directoryContext(path, DIRECTORY_MODE)
  syncDirectory(ctx, ctx.runDir)
  ctx.retention = retention
  return retention
}

function setRunDirectory(ctx: PreparedContext): void {
  ctx.runDir = directoryContext(ctx.runDirPath, DIRECTORY_MODE)
}

function setRetentionDirectory(ctx: PreparedContext, manifest: Manifest): DirectoryContext {
  const retention = directoryContext(join(ctx.runDirPath, "retained"), DIRECTORY_MODE)
  if (retention.dev !== manifest.retentionDirectoryDev || retention.ino !== manifest.retentionDirectoryIno) {
    fail("retention-directory-binding-mismatch")
  }
  ctx.retention = retention
  return retention
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset)
    if (count <= 0) fail("short-file-write")
    offset += count
  }
}

function writeExclusive(
  ctx: PreparedContext,
  dir: DirectoryContext,
  name: string,
  bytes: Uint8Array,
  mode: number,
  maxBytes = MAX_RECORD_BYTES,
): FileSnapshot {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || bytes.byteLength > maxBytes) fail("artifact-write-size-limit-exceeded")
  if (basename(name) !== name || name === "." || name === ".." || name.includes("/")) fail("unsafe-artifact-name")
  const path = join(dir.path, name)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | nativeCloseOnExecFlag(), mode)
  try {
    writeAll(fd, bytes)
    fchmodSync(fd, mode)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const snapshot = helperInspect(ctx, dir, name)
  if (!snapshot.bytes.equals(Buffer.from(bytes)) || (snapshot.mode & 0o7777) !== mode) fail("artifact-write-verification-failed")
  flushFile(ctx, dir, name, snapshot)
  const flushed = helperInspect(ctx, dir, name)
  if (!sameIdentity(snapshot, flushed) || !flushed.bytes.equals(Buffer.from(bytes))) fail("artifact-changed-during-fullsync")
  syncDirectory(ctx, dir)
  return flushed
}

function readJournal(ctx: PreparedContext): JournalRecord[] {
  const journalPath = join(ctx.runDirPath, "journal.jsonl")
  let bytes: Buffer
  try {
    bytes = readStablePath(journalPath, MAX_JOURNAL_BYTES, FILE_MODE, true)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) fail("journal-torn-record")
  const lines = bytes.toString("utf8").slice(0, -1).split("\n")
  if (!lines.length || lines.some((line) => !line)) fail("journal-empty-record")
  const records: JournalRecord[] = []
  let previous: string | null = null
  for (let index = 0; index < lines.length; index++) {
    let parsed: unknown
    try { parsed = JSON.parse(lines[index]!) } catch { return fail("journal-invalid-json") }
    if (!isObject(parsed) || !sameKeys(parsed, ["schema", "seq", "state", "previous", "details", "checksum"]) ||
        parsed.schema !== JOURNAL_SCHEMA || parsed.seq !== index + 1 || typeof parsed.state !== "string" ||
        !isObject(parsed.details) || parsed.previous !== previous || typeof parsed.checksum !== "string" || !HASH.test(parsed.checksum)) {
      fail("journal-invalid-record")
    }
    const core: JournalCore = {
      schema: JOURNAL_SCHEMA,
      seq: parsed.seq as number,
      state: parsed.state as JournalState,
      previous: parsed.previous as string | null,
      details: parsed.details,
    }
    if (!journalTransitionAllowed(records.at(-1)?.state ?? null, core.state) || sha256(stable(core)) !== parsed.checksum) fail("journal-checksum-or-state-invalid")
    const record = { ...core, checksum: parsed.checksum }
    records.push(record)
    previous = record.checksum
  }
  return records
}

function journalTransitionAllowed(previous: JournalState | null, next: JournalState): boolean {
  if (previous === null) return next === "PREPARED"
  const allowed: Record<JournalState, readonly JournalState[]> = {
    PREPARED: ["STAGED", "RECOVERY_REQUIRED"],
    STAGED: ["SWAP_INTENT", "RECOVERY_REQUIRED"],
    SWAP_INTENT: ["SWAPPED_EXPECTED", "RACE_CAPTURED", "RACE_PRESERVED", "RECOVERY_REQUIRED"],
    RACE_CAPTURED: ["RACE_PRESERVED", "RECOVERY_REQUIRED"],
    SWAPPED_EXPECTED: ["LOAD_VERIFIED", "RACE_PRESERVED", "RECOVERY_REQUIRED", "ROLLBACK_PREPARED"],
    RACE_PRESERVED: [],
    RECOVERY_REQUIRED: ["RECOVERY_REQUIRED"],
    LOAD_VERIFIED: ["LOAD_VERIFIED", "COMMITTED", "RACE_PRESERVED", "RECOVERY_REQUIRED", "ROLLBACK_PREPARED"],
    COMMITTED: ["RECOVERY_REQUIRED", "ROLLBACK_PREPARED"],
    ROLLBACK_PREPARED: ["ROLLBACK_SWAP_INTENT", "RECOVERY_REQUIRED"],
    ROLLBACK_SWAP_INTENT: ["ROLLED_BACK", "ROLLBACK_CAPTURED", "ROLLBACK_RACE_PRESERVED", "RECOVERY_REQUIRED"],
    ROLLBACK_CAPTURED: ["ROLLBACK_RACE_PRESERVED", "RECOVERY_REQUIRED"],
    ROLLBACK_RACE_PRESERVED: [],
    ROLLED_BACK: ["RECOVERY_REQUIRED"],
  }
  return allowed[previous]?.includes(next) === true
}

function appendJournal(ctx: PreparedContext, records: JournalRecord[], state: JournalState, details: Record<string, unknown>): JournalRecord {
  if (!journalTransitionAllowed(records.at(-1)?.state ?? null, state)) fail("invalid-journal-transition")
  const core: JournalCore = {
    schema: JOURNAL_SCHEMA,
    seq: records.length + 1,
    state,
    previous: records.at(-1)?.checksum ?? null,
    details,
  }
  const record: JournalRecord = { ...core, checksum: sha256(stable(core)) }
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8")
  const path = join(ctx.runDirPath, "journal.jsonl")
  const created = records.length === 0
  let existingBytes = 0
  if (!created) existingBytes = readStablePath(path, MAX_JOURNAL_BYTES, FILE_MODE, true).byteLength
  if (existingBytes + bytes.byteLength > MAX_JOURNAL_BYTES) fail("journal-size-limit-exceeded")
  let fd: number
  if (created) fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW | nativeCloseOnExecFlag(), FILE_MODE)
  else fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | nativeCloseOnExecFlag())
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o7777) !== FILE_MODE) fail("unsafe-journal")
    if (st.size !== existingBytes || st.size + bytes.byteLength > MAX_JOURNAL_BYTES) fail("journal-size-limit-exceeded")
    writeAll(fd, bytes)
    fsyncSync(fd)
    flushFile(ctx, ctx.runDir, "journal.jsonl", { dev: String(st.dev), ino: String(st.ino) })
  } finally {
    closeSync(fd)
  }
  if (created) syncDirectory(ctx, ctx.runDir)
  const persisted = readJournal(ctx)
  if (persisted.length !== records.length + 1 || persisted.at(-1)?.checksum !== record.checksum) fail("journal-write-verification-failed")
  records.push(record)
  return record
}

function readManifest(ctx: PreparedContext): Manifest {
  const bytes = readStablePath(join(ctx.runDirPath, "manifest.json"), MAX_RECORD_BYTES, FILE_MODE, true)
  const text = bytes.toString("utf8")
  if (!Buffer.from(text).equals(bytes)) fail("manifest-invalid-utf8")
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail("manifest-invalid-json") }
  if (!isObject(value) || value.schema !== "skillopt.promotion-manifest.v1" || value.runId !== ctx.runId ||
      value.witnessMode !== ctx.bindings.witnessMode ||
      value.targetRelativePath !== TARGET_RELATIVE_PATH || !exactBindings(value.bindings, ctx.bindings) ||
      value.bindingsSha256 !== ctx.bindingsSha256 || value.targetDirectoryDev !== ctx.target.dev || value.targetDirectoryIno !== ctx.target.ino ||
      value.backupName !== "original.bin" || value.originalSha256 !== ctx.bindings.originalSha256 || value.candidateSha256 !== ctx.bindings.candidateSha256 ||
      !validTransactionName(ctx.runId, value.stageName, "stage") ||
      typeof value.retentionDirectoryDev !== "string" || !/^\d+$/.test(value.retentionDirectoryDev) ||
      typeof value.retentionDirectoryIno !== "string" || !/^\d+$/.test(value.retentionDirectoryIno) ||
      typeof value.originalMode !== "number" || !Number.isSafeInteger(value.originalMode) || value.originalMode < 0 || value.originalMode > 0o777 ||
      typeof value.qualificationSha256 !== "string" || !HASH.test(value.qualificationSha256) ||
      typeof value.reviewSha256 !== "string" || !HASH.test(value.reviewSha256) ||
      typeof value.approvalSha256 !== "string" || !HASH.test(value.approvalSha256) ||
      typeof value.approvalId !== "string" || !ID.test(value.approvalId)) fail("manifest-binding-mismatch")
  return value as unknown as Manifest
}

function descriptorSnapshot(fd: number, expectedBytes: number): { bytes: Buffer; sha256: string; stable: boolean } {
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_SKILL_BYTES) || before.size !== BigInt(expectedBytes)) {
      return { bytes: Buffer.alloc(0), sha256: "", stable: false }
    }
    const bytes = readFdStable(fd, expectedBytes)
    const after = fstatSync(fd, { bigint: true })
    return {
      bytes,
      sha256: sha256(bytes),
      stable: before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
        before.mode === after.mode && before.nlink === after.nlink && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs,
    }
  } catch {
    return { bytes: Buffer.alloc(0), sha256: "", stable: false }
  }
}

function captureEvidence(ctx: PreparedContext, evidence: PromotionEvidence): VerifiedEvidence {
  const verified = validateEvidence(evidence, ctx.bindings)
  const manifestPath = join(ctx.runDirPath, "manifest.json")
  try {
    const existing = readStablePath(manifestPath, MAX_RECORD_BYTES, FILE_MODE, true)
    const value = JSON.parse(existing.toString("utf8")) as Manifest
    if (value.qualificationSha256 !== verified.qualificationSha256 || value.reviewSha256 !== verified.reviewSha256 ||
        value.approvalSha256 !== verified.approvalSha256 || value.approvalId !== verified.approvalId) fail("evidence-manifest-drift")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return verified
}

function ensureConsumedApproval(ctx: PreparedContext, evidence: VerifiedEvidence): void {
  const directoryPath = join(ctx.transactionRoot.path, "consumed-approvals")
  let dir: DirectoryContext
  try {
    dir = directoryContext(directoryPath, DIRECTORY_MODE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    mkdirSync(directoryPath, { mode: DIRECTORY_MODE })
    dir = directoryContext(directoryPath, DIRECTORY_MODE)
    syncDirectory(ctx, ctx.transactionRoot)
  }
  const name = `${sha256(evidence.approvalId)}.json`
  const path = join(dir.path, name)
  try {
    lstatSync(path)
    fail("approval-already-consumed")
  } catch (error) {
    if (error instanceof PromotionError) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const receipt = Buffer.from(`${JSON.stringify({
    schema: "skillopt.consumed-approval.v1",
    approvalId: evidence.approvalId,
    approvalSha256: evidence.approvalSha256,
    runId: ctx.runId,
    witnessMode: ctx.bindings.witnessMode,
    bindingsSha256: ctx.bindingsSha256,
    targetRelativePath: TARGET_RELATIVE_PATH,
    candidateSha256: ctx.bindings.candidateSha256,
  })}\n`)
  let snapshot: FileSnapshot
  try { snapshot = writeExclusive(ctx, dir, name, receipt, FILE_MODE) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("approval-already-consumed")
    throw error
  }
  if (snapshot.sha256 !== sha256(receipt)) fail("approval-consumption-write-failed")
}

function lockNative(ctx: PreparedContext): Promise<() => Promise<void>> {
  nativeVersion(ctx)
  return new Promise((resolveLock, rejectLock) => {
    const child: ChildProcessWithoutNullStreams = spawn(ctx.helperPath, ["lock", ctx.transactionRoot.path, ctx.transactionRoot.dev, ctx.transactionRoot.ino], {
      stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
    })
    trackNativeMutationChild(child)
    const closed = once(child, "close")
    let stdout = ""
    let stderr = ""
    let settled = false
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
      if (stdout.includes("\n") && !settled) {
        settled = true
        if (stdout !== "LOCKED\n") {
          child.stdin.end()
          rejectLock(new PromotionError("native-lock-protocol-invalid"))
          return
        }
        resolveLock(async () => {
          child.stdin.end()
          await closed
        })
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8") })
    child.once("error", () => {
      if (!settled) { settled = true; rejectLock(new PromotionError("native-lock-start-failed")) }
    })
    child.once("close", (code) => {
      if (!settled) { settled = true; rejectLock(new PromotionError(code === 73 ? "promotion-busy" : "native-lock-failed")) }
      else if (code !== 0 && stderr.length) { /* lock is already gone; do not surface paths or helper diagnostics */ }
    })
  })
}

function fault(input: { faultInjection?: (point: PromotionFaultPoint) => void }, point: PromotionFaultPoint): void {
  input.faultInjection?.(point)
}

function openRetainedInode(ctx: PreparedContext, name: string, expected: FileSnapshot): number {
  const key = descriptorKey(ctx)
  const existing = retainedOriginalDescriptors.get(key)
  if (existing && existing.dev === expected.dev && existing.ino === expected.ino) return existing.fd
  const fd = openSync(join(ctx.target.path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | nativeCloseOnExecFlag())
  if (!statMatchesSnapshot(fstatSync(fd), expected)) {
    closeSync(fd)
    fail("displaced-descriptor-drift")
  }
  retainedOriginalDescriptors.set(key, { fd, dev: expected.dev, ino: expected.ino })
  return fd
}

function classifySwap(ctx: PreparedContext, records: JournalRecord[], manifest: Manifest, originalFd: number | undefined,
  allowAppend: boolean, exchangeAttempted: boolean, allowRaceAppend = allowAppend, nativeReport?: NativeExchangeReport): PromotionResult {
  let live: FileSnapshot
  let displaced: FileSnapshot
  let stageName: string
  try {
    live = helperInspect(ctx, ctx.target, "SKILL.md")
    const intent = records.findLast((record) => record.state === "SWAP_INTENT")
    stageName = typeof intent?.details.stageName === "string" ? intent.details.stageName : ""
    if (!stageName) fail("missing-stage-name")
    displaced = helperInspect(ctx, ctx.target, stageName)
  } catch {
    return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: exchangeAttempted, reason: "objects-uninspectable" }
  }
  const prepared = records.find((record) => record.state === "PREPARED")
  const staged = records.findLast((record) => record.state === "STAGED")
  const originalDev = String(prepared?.details.originalDev)
  const originalIno = String(prepared?.details.originalIno)
  const candidateDev = String(staged?.details.stageDev)
  const candidateIno = String(staged?.details.stageIno)
  const targetStillOriginal = live.sha256 === ctx.bindings.originalSha256 && live.dev === originalDev && live.ino === originalIno &&
    displaced.sha256 === ctx.bindings.candidateSha256 && displaced.dev === candidateDev && displaced.ino === candidateIno &&
    (live.mode & 0o7777) === manifest.originalMode && (displaced.mode & 0o7777) === manifest.originalMode
  if (targetStillOriginal) {
    if (allowAppend && records.at(-1)?.state === "SWAP_INTENT") {
      try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "swap-intent-without-observed-exchange" }) }
      catch { /* The unexchanged target and stage stay untouched. */ }
    }
    return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "exchange-not-observed" }
  }

  const targetIsCandidate = live.sha256 === ctx.bindings.candidateSha256 && live.dev === candidateDev && live.ino === candidateIno &&
    displaced.sha256 === ctx.bindings.originalSha256 && displaced.dev === originalDev && displaced.ino === originalIno &&
    (live.mode & 0o7777) === manifest.originalMode && (displaced.mode & 0o7777) === manifest.originalMode
  let original: { bytes: Buffer; sha256: string; stable: boolean } = { bytes: Buffer.alloc(0), sha256: "", stable: false }
  if (targetIsCandidate) {
    try {
      const fd = originalFd ?? openRetainedInode(ctx, stageName, displaced)
      original = descriptorSnapshot(fd, manifestBytesLength(ctx))
    } catch { /* A closed/replaced old inode is not evidence for expected publication. */ }
  }
  const reportStable = !nativeReport || (nativeReport.status === "EXCHANGED" && nativeReport.target !== null && nativeReport.stage !== null &&
    nativeSnapshotMatches(live, nativeReport.target) && nativeSnapshotMatches(displaced, nativeReport.stage))
  const expected = targetIsCandidate && reportStable && original.sha256 === ctx.bindings.originalSha256 && original.stable
  if (!expected) {
    if (allowRaceAppend && records.at(-1)?.state === "SWAP_INTENT") {
      try {
        appendJournal(ctx, records, "RACE_PRESERVED", {
          reason: "objects-differ-from-approved-inodes-or-bytes",
          targetName: "SKILL.md",
          stageName,
          liveSha256: live.sha256,
          liveDev: live.dev,
          liveIno: live.ino,
          displacedSha256: displaced.sha256,
          displacedDev: displaced.dev,
          displacedIno: displaced.ino,
          displacedStable: original.stable,
        })
      } catch {
        return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: exchangeAttempted,
          reason: "race-preserved-but-journal-not-durable" }
      }
    }
    return { state: allowRaceAppend ? "RACE_PRESERVED" : "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: exchangeAttempted,
      reason: "live-or-displaced-object-drift" }
  }
  if (allowAppend && records.at(-1)?.state === "SWAP_INTENT") {
    appendJournal(ctx, records, "SWAPPED_EXPECTED", {
      targetName: "SKILL.md",
      stageName: records.findLast((record) => record.state === "SWAP_INTENT")!.details.stageName,
      candidateSha256: live.sha256,
      candidateDev: live.dev,
      candidateIno: live.ino,
      candidateMode: live.mode,
      candidateSize: live.size,
      candidateMtimeNs: live.mtimeNs,
      candidateCtimeNs: live.ctimeNs,
      originalSha256: displaced.sha256,
      originalDev: displaced.dev,
      originalIno: displaced.ino,
      originalMode: displaced.mode,
      originalSize: displaced.size,
      originalMtimeNs: displaced.mtimeNs,
      originalCtimeNs: displaced.ctimeNs,
      originalStable: original.stable,
      nativeHelperProtocol: nativeReport?.protocol ?? NATIVE_HELPER_PROTOCOL,
      nativeHelperPlatform: nativeReport?.platform ?? requireNativePlatform(),
      nativeHelperStatus: nativeReport?.status ?? "RECOVERY_CLASSIFICATION",
      ...(nativeReport ? { nativeTargetObservation: nativeReport.target, nativeStageObservation: nativeReport.stage } : {}),
    })
  }
  return { state: "SWAPPED_EXPECTED", idempotent: !allowAppend, raceMayHavePublishedCandidate: true }
}

function manifestBytesLength(ctx: PreparedContext): number {
  const backup = helperInspect(ctx, ctx.runDir, "original.bin")
  if (backup.sha256 !== ctx.bindings.originalSha256) fail("backup-digest-mismatch")
  return backup.size
}

function readBindingsFromRecords(records: readonly JournalRecord[]): Record<string, unknown> | null {
  const first = records[0]
  return first && isObject(first.details) ? first.details : null
}

function verifyRunJournal(ctx: PreparedContext, records: JournalRecord[]): Manifest {
  if (!records.length) fail("journal-missing")
  const first = readBindingsFromRecords(records)
  if (!first || first.runId !== ctx.runId || first.witnessMode !== ctx.bindings.witnessMode || first.bindingsSha256 !== ctx.bindingsSha256 ||
      first.targetDirectoryDev !== ctx.target.dev || first.targetDirectoryIno !== ctx.target.ino) fail("journal-binding-mismatch")
  const manifest = readManifest(ctx)
  setRetentionDirectory(ctx, manifest)
  const prepared = records[0]!
  if (prepared.details.witnessMode !== ctx.bindings.witnessMode || prepared.details.originalSha256 !== manifest.originalSha256 ||
      prepared.details.candidateSha256 !== manifest.candidateSha256 ||
      prepared.details.backupName !== manifest.backupName || prepared.details.stageName !== manifest.stageName ||
      prepared.details.retentionDirectoryDev !== manifest.retentionDirectoryDev ||
      prepared.details.retentionDirectoryIno !== manifest.retentionDirectoryIno) fail("journal-manifest-mismatch")
  const rollbackPrepared = recordsByName(records, "ROLLBACK_PREPARED")
  const rollbackIntent = recordsByName(records, "ROLLBACK_SWAP_INTENT")
  if ((rollbackPrepared && rollbackPrepared.details.witnessMode !== ctx.bindings.witnessMode) ||
      (rollbackIntent && rollbackIntent.details.witnessMode !== ctx.bindings.witnessMode)) fail("journal-witness-mode-mismatch")
  for (const state of ["LOAD_VERIFIED", "COMMITTED", "ROLLED_BACK"] as const) {
    const record = recordsByName(records, state)
    if (record && (record.details.witnessMode !== ctx.bindings.witnessMode ||
        (ctx.bindings.witnessMode === "native" && record.details.witnessSchema !== NATIVE_SKILL_LOAD_WITNESS_SCHEMA) ||
        (ctx.bindings.witnessMode === "legacy" && record.details.witnessSchema !== undefined))) {
      fail("journal-witness-mode-mismatch")
    }
  }
  if (ctx.bindings.witnessMode === "native" && rollbackPrepared) {
    verifyNativeRollbackApprovalJournalBinding(ctx, rollbackPrepared, records, manifest)
    if (rollbackIntent && (rollbackIntent.details.operatorApprovalName !== rollbackPrepared.details.operatorApprovalName ||
        rollbackIntent.details.operatorApprovalSha256 !== rollbackPrepared.details.operatorApprovalSha256)) {
      fail("native-rollback-approval-journal-mismatch")
    }
  }
  const staged = recordsByName(records, "STAGED")
  const swapIntent = recordsByName(records, "SWAP_INTENT")
  const swapped = recordsByName(records, "SWAPPED_EXPECTED")
  if (staged && (staged.details.stageName !== manifest.stageName || staged.details.candidateSha256 !== ctx.bindings.candidateSha256 ||
      staged.details.originalDev !== prepared.details.originalDev || staged.details.originalIno !== prepared.details.originalIno)) fail("staged-record-mismatch")
  if (swapIntent && (!validTransactionName(ctx.runId, swapIntent.details.stageName, "stage") ||
      swapIntent.details.stageName !== manifest.stageName || swapIntent.details.targetName !== "SKILL.md" ||
      swapIntent.details.stageDev !== staged?.details.stageDev || swapIntent.details.stageIno !== staged?.details.stageIno ||
      swapIntent.details.targetDev !== prepared.details.originalDev || swapIntent.details.targetIno !== prepared.details.originalIno ||
      swapIntent.details.approvalSha256 !== manifest.approvalSha256)) fail("swap-intent-mismatch")
  if (swapped && (!swapIntent || swapped.details.stageName !== manifest.stageName ||
      swapped.details.nativeHelperProtocol !== NATIVE_HELPER_PROTOCOL || swapped.details.nativeHelperPlatform !== requireNativePlatform() ||
      swapped.details.candidateSha256 !== ctx.bindings.candidateSha256 || swapped.details.originalSha256 !== ctx.bindings.originalSha256 ||
      swapped.details.candidateDev !== swapIntent.details.stageDev || swapped.details.candidateIno !== swapIntent.details.stageIno ||
      swapped.details.originalDev !== swapIntent.details.targetDev || swapped.details.originalIno !== swapIntent.details.targetIno ||
      swapped.details.originalStable !== true)) fail("swap-observation-mismatch")
  const captured = recordsByName(records, "RACE_CAPTURED")
  const rollbackCaptured = recordsByName(records, "ROLLBACK_CAPTURED")
  if (rollbackPrepared && (!validTransactionName(ctx.runId, rollbackPrepared.details.rollbackStageName, "rollback") ||
      rollbackPrepared.details.stagePending !== true || rollbackPrepared.details.originalSha256 !== ctx.bindings.originalSha256 ||
      rollbackPrepared.details.candidateSha256 !== ctx.bindings.candidateSha256 || rollbackPrepared.details.approvalSha256 !== manifest.approvalSha256 ||
      rollbackPrepared.details.targetDev !== swapped?.details.candidateDev || rollbackPrepared.details.targetIno !== swapped?.details.candidateIno)) {
    fail("rollback-prepared-mismatch")
  }
  if (rollbackIntent && (!rollbackPrepared || !validTransactionName(ctx.runId, rollbackIntent.details.rollbackStageName, "rollback") ||
      rollbackIntent.details.rollbackStageName !== rollbackPrepared.details.rollbackStageName || rollbackIntent.details.targetName !== "SKILL.md" ||
      typeof rollbackIntent.details.captureName !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(rollbackIntent.details.captureName) ||
      rollbackIntent.details.retentionDirectoryDev !== manifest.retentionDirectoryDev ||
      rollbackIntent.details.retentionDirectoryIno !== manifest.retentionDirectoryIno ||
      rollbackIntent.details.originalSha256 !== ctx.bindings.originalSha256 || rollbackIntent.details.candidateSha256 !== ctx.bindings.candidateSha256 ||
      rollbackIntent.details.targetDev !== swapped?.details.candidateDev || rollbackIntent.details.targetIno !== swapped?.details.candidateIno ||
      rollbackIntent.details.rollbackStageDev === rollbackIntent.details.targetDev && rollbackIntent.details.rollbackStageIno === rollbackIntent.details.targetIno)) {
    fail("rollback-intent-mismatch")
  }
  if (captured && (!swapIntent || !validTransactionName(ctx.runId, captured.details.stageName, "stage") ||
      captured.details.stageName !== manifest.stageName || captured.details.nativeHelperProtocol !== NATIVE_HELPER_PROTOCOL ||
      captured.details.nativeHelperPlatform !== requireNativePlatform() ||
      captured.details.nativeHelperStatus !== "RACE_CAPTURED")) fail("race-capture-record-mismatch")
  if (rollbackCaptured && (!rollbackIntent || !validTransactionName(ctx.runId, rollbackCaptured.details.stageName, "rollback") ||
      rollbackCaptured.details.stageName !== rollbackIntent.details.rollbackStageName ||
      rollbackCaptured.details.nativeHelperProtocol !== NATIVE_HELPER_PROTOCOL ||
      rollbackCaptured.details.nativeHelperPlatform !== requireNativePlatform() ||
      rollbackCaptured.details.nativeHelperStatus !== "RACE_CAPTURED")) fail("rollback-capture-record-mismatch")
  for (const record of records) {
    if (record.state === "SWAP_INTENT" && (typeof record.details.captureName !== "string" ||
        !/^[A-Za-z0-9._-]{1,200}$/.test(record.details.captureName) ||
        record.details.retentionDirectoryDev !== manifest.retentionDirectoryDev ||
        record.details.retentionDirectoryIno !== manifest.retentionDirectoryIno)) fail("swap-intent-retention-binding-mismatch")
    if (record.state === "RACE_CAPTURED" && record.details.retainedArtifact !== undefined) {
      verifyRetainedArtifact(ctx, record.details.retainedArtifact)
    }
    if (record.state === "ROLLBACK_CAPTURED" && record.details.retainedArtifact !== undefined) {
      verifyRetainedArtifact(ctx, record.details.retainedArtifact)
    }
    if (record.state === "RACE_PRESERVED" && record.details.stageName !== undefined &&
        !validTransactionName(ctx.runId, record.details.stageName, "stage")) fail("race-stage-name-invalid")
    if (record.state === "RACE_CAPTURED" && record.details.stageName !== undefined &&
        !validTransactionName(ctx.runId, record.details.stageName, "stage")) fail("race-capture-stage-name-invalid")
    if (record.state === "ROLLBACK_RACE_PRESERVED" && record.details.rollbackStageName !== undefined &&
        !validTransactionName(ctx.runId, record.details.rollbackStageName, "rollback")) fail("rollback-race-stage-name-invalid")
    if (record.state === "ROLLBACK_CAPTURED" && record.details.stageName !== undefined &&
        !validTransactionName(ctx.runId, record.details.stageName, "rollback")) fail("rollback-capture-stage-name-invalid")
  }
  for (const state of ["RACE_PRESERVED", "ROLLBACK_RACE_PRESERVED"] as const) {
    const terminal = recordsByName(records, state)
    if (terminal?.details.captureRecordChecksum !== undefined) {
      const captureState = state === "RACE_PRESERVED" ? "RACE_CAPTURED" : "ROLLBACK_CAPTURED"
      const captureRecord = recordsByName(records, captureState)
      if (!captureRecord || terminal.details.captureRecordSeq !== captureRecord.seq ||
          terminal.details.captureRecordChecksum !== captureRecord.checksum ||
          stable(terminal.details.retainedArtifact) !== stable(captureRecord.details.retainedArtifact)) fail("retained-artifact-terminal-link-mismatch")
    }
  }
  return manifest
}

function verifyNativeRollbackApprovalJournalBinding(
  ctx: PreparedContext,
  rollbackPrepared: JournalRecord,
  records: readonly JournalRecord[],
  manifest: Manifest,
): void {
  const name = rollbackPrepared.details.operatorApprovalName
  const digest = rollbackPrepared.details.operatorApprovalSha256
  if (typeof name !== "string" || basename(name) !== name || !/^native-rollback-[A-Za-z0-9_-]{1,32}-[a-f0-9]{24}\.json$/u.test(name) ||
      typeof digest !== "string" || !HASH.test(digest)) fail("native-rollback-approval-journal-invalid")
  const bytes = readStablePath(join(ctx.transactionRoot.path, "approvals", name), MAX_RECORD_BYTES, FILE_MODE, true)
  if (sha256(bytes) !== digest) fail("native-rollback-approval-journal-digest-mismatch")
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("native-rollback-approval-journal-invalid-utf8")
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail("native-rollback-approval-journal-invalid-json") }
  const expectedKeys = [
    "schema", "operation", "runId", "bindings", "bindingsSha256", "subjectSha256", "ownerSessionID", "ownerEpoch",
    "applyJournalSha256", "manifestSha256", "applyApprovalSha256", "candidateSha256", "candidateIdentity", "backupSha256",
    "backupInode", "backupIdentity", "nativeBootId", "approvedAtContinuousNanoseconds", "expiresContinuousNanoseconds",
    "runDeadlineAt", "approvalId",
  ]
  if (!isObject(value) || !sameKeys(value, expectedKeys) || value.schema !== "skillopt.native-rollback-approval.v1" || value.operation !== "rollback" ||
      value.runId !== ctx.runId || !exactBindings(value.bindings, ctx.bindings) || value.bindingsSha256 !== ctx.bindingsSha256 ||
      typeof value.subjectSha256 !== "string" || !HASH.test(value.subjectSha256) ||
      typeof value.ownerSessionID !== "string" || !value.ownerSessionID || typeof value.ownerEpoch !== "string" || !value.ownerEpoch ||
      typeof value.applyJournalSha256 !== "string" || !HASH.test(value.applyJournalSha256) ||
      typeof value.manifestSha256 !== "string" || !HASH.test(value.manifestSha256) ||
      value.applyApprovalSha256 !== manifest.approvalSha256 || value.candidateSha256 !== ctx.bindings.candidateSha256 ||
      typeof value.backupSha256 !== "string" || value.backupSha256 !== ctx.bindings.originalSha256 ||
      typeof value.backupInode !== "string" || !/^\d+$/u.test(value.backupInode) ||
      typeof value.nativeBootId !== "string" || !NATIVE_BOOT_ID.test(value.nativeBootId) ||
      typeof value.approvedAtContinuousNanoseconds !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value.approvedAtContinuousNanoseconds) ||
      typeof value.expiresContinuousNanoseconds !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value.expiresContinuousNanoseconds) ||
      !validNativeApprovalWindow(value.approvedAtContinuousNanoseconds, value.expiresContinuousNanoseconds) ||
      typeof value.runDeadlineAt !== "number" || !Number.isSafeInteger(value.runDeadlineAt) ||
      typeof value.approvalId !== "string" || !ID.test(value.approvalId) ||
      rollbackPrepared.details.targetDev !== (isObject(value.candidateIdentity) ? value.candidateIdentity.dev : undefined) ||
      rollbackPrepared.details.targetIno !== (isObject(value.candidateIdentity) ? value.candidateIdentity.ino : undefined)) {
    fail("native-rollback-approval-journal-binding-mismatch")
  }
  const candidateIdentity = value.candidateIdentity
  const backupIdentity = value.backupIdentity
  const swapped = recordsByName(records, "SWAPPED_EXPECTED")
  if (!isObject(candidateIdentity) || !sameKeys(candidateIdentity, ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs", "sha256"]) ||
      candidateIdentity.sha256 !== ctx.bindings.candidateSha256 || candidateIdentity.dev !== String(swapped?.details.candidateDev) ||
      candidateIdentity.ino !== String(swapped?.details.candidateIno) || candidateIdentity.uid !== process.getuid?.() ||
      candidateIdentity.nlink !== 1 || candidateIdentity.size !== swapped?.details.candidateSize ||
      candidateIdentity.mode !== swapped?.details.candidateMode || candidateIdentity.mtimeNs !== swapped?.details.candidateMtimeNs ||
      candidateIdentity.ctimeNs !== swapped?.details.candidateCtimeNs ||
      !isObject(backupIdentity) || !sameKeys(backupIdentity, ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs", "sha256"]) ||
      backupIdentity.sha256 !== value.backupSha256 || backupIdentity.ino !== value.backupInode ||
      backupIdentity.uid !== process.getuid?.() || backupIdentity.nlink !== 1) {
    fail("native-rollback-approval-file-identity-mismatch")
  }
  const preparedIndex = rollbackPrepared.seq - 1
  const journalBytes = readStablePath(join(ctx.runDirPath, "journal.jsonl"), MAX_JOURNAL_BYTES, FILE_MODE, true)
  const journalLines = journalBytes.toString("utf8").slice(0, -1).split("\n")
  if (preparedIndex < 1 || preparedIndex > journalLines.length) fail("native-rollback-approval-journal-prefix-invalid")
  const applyJournalPrefix = Buffer.from(`${journalLines.slice(0, preparedIndex).join("\n")}\n`, "utf8")
  if (sha256(applyJournalPrefix) !== value.applyJournalSha256) fail("native-rollback-approval-apply-journal-mismatch")
  const manifestBytes = readStablePath(join(ctx.runDirPath, "manifest.json"), MAX_RECORD_BYTES, FILE_MODE, true)
  if (sha256(manifestBytes) !== value.manifestSha256) fail("native-rollback-approval-manifest-mismatch")
  const runDirectory = directoryContext(ctx.runDirPath, DIRECTORY_MODE)
  const backup = helperInspect(ctx, runDirectory, manifest.backupName)
  if (backup.sha256 !== value.backupSha256 || backup.ino !== value.backupInode ||
      stable(nativeApprovalFileIdentity(backup)) !== stable(backupIdentity)) fail("native-rollback-approval-backup-drift")
}

async function verifyEvidenceNow(input: { evidence: PromotionEvidence; verifyEvidence: () => Promise<void> }, ctx: PreparedContext): Promise<VerifiedEvidence> {
  const first = captureEvidence(ctx, input.evidence)
  await input.verifyEvidence()
  const second = captureEvidence(ctx, input.evidence)
  if (stable(first) !== stable(second)) fail("evidence-changed-during-verification")
  return second
}

function freezeEvidence(evidence: PromotionEvidence): Readonly<PromotionEvidence> {
  return Object.freeze({
    qualification: Object.freeze({ ...evidence.qualification }),
    review: Object.freeze({ ...evidence.review }),
    approval: Object.freeze({ ...evidence.approval }),
  })
}

function nativePromotionTransactionId(ctx: PreparedContext, records: JournalRecord[]): string {
  const swap = recordsByName(records, "SWAPPED_EXPECTED")
  if (!swap) fail("native-handoff-swap-record-missing")
  return sha256(stable({
    protocol: "skillopt.native-promotion-canary-handoff.v1",
    transactionRoot: { dev: ctx.transactionRoot.dev, ino: ctx.transactionRoot.ino },
    runDirectory: { dev: ctx.runDir.dev, ino: ctx.runDir.ino },
    targetDirectory: { dev: ctx.target.dev, ino: ctx.target.ino },
    targetPath: ctx.targetPath,
    runId: ctx.runId,
    bindingsSha256: ctx.bindingsSha256,
    nativeHelperSha256: ctx.helperSha256,
    swappedRecord: { seq: swap.seq, checksum: swap.checksum, details: swap.details },
  }))
}

function nativeRollbackTransactionId(ctx: PreparedContext, records: JournalRecord[], rollbackApprovalSha256: string): string {
  const intent = recordsByName(records, "ROLLBACK_SWAP_INTENT")
  if (!intent || !HASH.test(rollbackApprovalSha256)) fail("native-rollback-handoff-intent-missing")
  return sha256(stable({
    protocol: "skillopt.native-promotion-rollback-canary-handoff.v1",
    applyTransactionId: nativePromotionTransactionId(ctx, records),
    rollbackApprovalSha256,
    rollbackIntent: { seq: intent.seq, checksum: intent.checksum, details: intent.details },
  }))
}

function descriptorFileIdentity(fd: number, expectedBytes: number): NativeApprovalFileIdentity {
  const before = fstatSync(fd, { bigint: true })
  const snapshot = descriptorSnapshot(fd, expectedBytes)
  const after = fstatSync(fd, { bigint: true })
  if (!snapshot.stable || !before.isFile() || !after.isFile() || before.nlink !== 1n || after.nlink !== 1n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) || after.uid !== before.uid || before.dev !== after.dev ||
      before.ino !== after.ino || before.mode !== after.mode || before.nlink !== after.nlink || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== BigInt(expectedBytes) ||
      !HASH.test(snapshot.sha256)) fail("native-rollback-candidate-descriptor-invalid")
  return Object.freeze({
    dev: String(after.dev), ino: String(after.ino), uid: Number(after.uid), mode: Number(after.mode),
    nlink: Number(after.nlink), size: Number(after.size), mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs),
    sha256: snapshot.sha256,
  })
}

function assertNativeRollbackOperationCurrent(
  ctx: PreparedContext,
  records: JournalRecord[],
  manifest: Manifest,
  operation: NativeRollbackOperationState,
  allowCommitted: boolean,
): Readonly<{ original: FileSnapshot; candidate: FileSnapshot; backup: FileSnapshot; latest: JournalRecord }> {
  const latest = records.at(-1)
  const intent = recordsByName(records, "ROLLBACK_SWAP_INTENT")
  const rollbackPrepared = recordsByName(records, "ROLLBACK_PREPARED")
  const expectedState = allowCommitted ? "ROLLED_BACK" : "ROLLBACK_SWAP_INTENT"
  if (!latest || latest.state !== expectedState || !intent || !rollbackPrepared ||
      nativeRollbackTransactionId(ctx, records, operation.rollbackApprovalSha256) !== operation.transactionId ||
      intent.seq !== operation.rollbackIntentSeq || intent.checksum !== operation.rollbackIntentChecksum ||
      operation.authorizationState.operation !== "rollback" || !operation.authorizationState.consumed ||
      !operation.authorizationState.inProgress || operation.authorizationState.approvalRecordSha256 !== operation.rollbackApprovalSha256 ||
      nativePromotionAuthorizationStates.get(operation.authorizationState.authorization) !== operation.authorizationState) {
    fail("native-rollback-handoff-transaction-invalid")
  }
  assertNativePromotionAuthorizationActive(ctx, operation.authorizationState)
  const clock = trustedNativeApprovalClock(ctx.common)
  const elapsedContinuous = BigInt(clock.continuousNanoseconds) - BigInt(operation.approvalClock.continuousNanoseconds)
  const elapsedWall = BigInt(clock.wallMilliseconds) - BigInt(operation.approvalClock.wallMilliseconds)
  const elapsedContinuousMilliseconds = elapsedContinuous / 1_000_000n
  const elapsedClockSkew = elapsedContinuousMilliseconds > elapsedWall
    ? elapsedContinuousMilliseconds - elapsedWall : elapsedWall - elapsedContinuousMilliseconds
  if (clock.bootId !== operation.approvalClock.bootId || elapsedContinuous < 0n || elapsedWall < 0n ||
      elapsedClockSkew > NATIVE_CLOCK_WALL_TOLERANCE_MS) fail("native-rollback-handoff-clock-scope-invalid")
  verifyNativeRollbackApprovalJournalBinding(ctx, rollbackPrepared, records, manifest)
  if (rollbackPrepared.details.operatorApprovalName !== basename(operation.authorizationState.approvalRecord.path) ||
      rollbackPrepared.details.operatorApprovalSha256 !== operation.rollbackApprovalSha256 ||
      intent.details.operatorApprovalName !== basename(operation.authorizationState.approvalRecord.path) ||
      intent.details.operatorApprovalSha256 !== operation.rollbackApprovalSha256) fail("native-rollback-approval-journal-mismatch")
  const rollbackStageName = String(intent.details.rollbackStageName)
  const original = helperInspect(ctx, ctx.target, "SKILL.md")
  const candidate = helperInspect(ctx, ctx.target, rollbackStageName)
  const backup = helperInspect(ctx, ctx.runDir, manifest.backupName)
  const originalIdentity = nativeApprovalFileIdentity(original)
  const candidateIdentity = nativeApprovalFileIdentity(candidate)
  const backupIdentity = nativeApprovalFileIdentity(backup)
  const descriptor = retainedRollbackDescriptors.get(descriptorKey(ctx))
  if (!descriptor || descriptor.dev !== candidate.dev || descriptor.ino !== candidate.ino ||
      stable(originalIdentity) !== stable(operation.originalIdentity) ||
      stable(candidateIdentity) !== stable(operation.candidateIdentity) ||
      stable(backupIdentity) !== stable(operation.backupIdentity) ||
      stable(descriptorFileIdentity(descriptor.fd, candidate.size)) !== stable(operation.candidateDescriptorIdentity) ||
      stable(operation.candidateDescriptorIdentity) !== stable(candidateIdentity) ||
      original.sha256 !== ctx.bindings.originalSha256 || candidate.sha256 !== ctx.bindings.candidateSha256 ||
      backup.sha256 !== ctx.bindings.originalSha256 || (original.mode & 0o7777) !== manifest.originalMode ||
      (candidate.mode & 0o7777) !== manifest.originalMode || (backup.mode & 0o7777) !== manifest.originalMode ||
      backup.ino !== String((operation.authorizationState.snapshot.backup as NativeApprovalFileIdentity).ino) ||
      candidate.dev !== String(intent.details.targetDev) || candidate.ino !== String(intent.details.targetIno) ||
      candidate.mode !== intent.details.targetMode || candidate.size !== intent.details.targetSize ||
      candidate.mtimeNs !== intent.details.targetMtimeNs) {
    fail("native-rollback-handoff-object-binding-mismatch")
  }
  if (!allowCommitted) {
    const classification = classifyRollback(ctx, records, manifest, false)
    if (classification.state !== "ROLLBACK_SWAP_INTENT") fail("native-rollback-handoff-objects-not-swapped")
  } else {
    const classification = classifyCommitted(ctx, records, manifest, true)
    if (classification.state !== "ROLLED_BACK" ||
        !sameRecordedSnapshot(original, latest.details, "original") ||
        !sameRecordedSnapshot(candidate, latest.details, "candidate") ||
        latest.details.witnessMode !== "native" || latest.details.witnessSchema !== NATIVE_SKILL_LOAD_WITNESS_SCHEMA) {
      fail("native-rollback-commit-journal-invalid")
    }
  }
  return Object.freeze({ original, candidate, backup, latest })
}

function registerNativeRollbackOperation(
  ctx: PreparedContext,
  records: JournalRecord[],
  manifest: Manifest,
  authorization: NativePromotionAuthorizationState,
): NativeRollbackOperationState {
  if (authorization.operation !== "rollback" || !authorization.consumed || !authorization.inProgress) {
    fail("native-rollback-authorization-invalid-or-consumed")
  }
  const rollbackIntent = recordsByName(records, "ROLLBACK_SWAP_INTENT")
  const rollbackPrepared = recordsByName(records, "ROLLBACK_PREPARED")
  if (!rollbackIntent || !rollbackPrepared) fail("native-rollback-handoff-intent-missing")
  const transactionId = nativeRollbackTransactionId(ctx, records, authorization.approvalRecordSha256)
  if (nativeRollbackOperations.has(transactionId)) fail("native-rollback-handoff-already-issued")
  assertNativePromotionAuthorizationActive(ctx, authorization)
  verifyNativeRollbackApprovalJournalBinding(ctx, rollbackPrepared, records, manifest)
  const original = helperInspect(ctx, ctx.target, "SKILL.md")
  const candidate = helperInspect(ctx, ctx.target, String(rollbackIntent.details.rollbackStageName))
  const backup = helperInspect(ctx, ctx.runDir, manifest.backupName)
  const retainedCandidate = retainedRollbackDescriptors.get(descriptorKey(ctx))
  if (!retainedCandidate || original.sha256 !== ctx.bindings.originalSha256 ||
      original.dev !== String(rollbackIntent.details.rollbackStageDev) || original.ino !== String(rollbackIntent.details.rollbackStageIno) ||
      candidate.sha256 !== ctx.bindings.candidateSha256 || candidate.dev !== String(rollbackIntent.details.targetDev) ||
      candidate.ino !== String(rollbackIntent.details.targetIno) || backup.sha256 !== ctx.bindings.originalSha256) {
    fail("native-rollback-handoff-object-binding-mismatch")
  }
  const authorizationBackup = authorization.snapshot.backup as NativeApprovalFileIdentity
  const authorizationCandidate = authorization.snapshot.target as NativeApprovalFileIdentity
  const backupIdentity = nativeApprovalFileIdentity(backup)
  const originalIdentity = nativeApprovalFileIdentity(original)
  const candidateIdentity = nativeApprovalFileIdentity(candidate)
  const candidateDescriptorIdentity = descriptorFileIdentity(retainedCandidate.fd, candidate.size)
  if (stable(backupIdentity) !== stable(authorizationBackup) ||
      !sameNativeApprovalFileIdentityExceptCtime(candidateIdentity, authorizationCandidate) ||
      stable(candidateDescriptorIdentity) !== stable(candidateIdentity) ||
      (original.mode & 0o7777) !== manifest.originalMode || (candidate.mode & 0o7777) !== manifest.originalMode ||
      (backup.mode & 0o7777) !== manifest.originalMode) fail("native-rollback-handoff-object-binding-mismatch")
  const operation: NativeRollbackOperationState = Object.freeze({
    authorizationState: authorization,
    transactionId,
    rollbackIntentSeq: rollbackIntent.seq,
    rollbackIntentChecksum: rollbackIntent.checksum,
    rollbackApprovalSha256: authorization.approvalRecordSha256,
    approvalClock: trustedNativeApprovalClock(ctx.common),
    backupIdentity,
    originalIdentity,
    candidateIdentity,
    candidateDescriptorIdentity,
  })
  assertNativeRollbackOperationCurrent(ctx, records, manifest, operation, false)
  nativeRollbackOperations.set(transactionId, operation)
  return operation
}

function assertConsumedApproval(ctx: PreparedContext, evidence: VerifiedEvidence): void {
  const path = join(ctx.transactionRoot.path, "consumed-approvals")
  const directory = directoryContext(path, DIRECTORY_MODE)
  const expected = Buffer.from(`${JSON.stringify({
    schema: "skillopt.consumed-approval.v1",
    approvalId: evidence.approvalId,
    approvalSha256: evidence.approvalSha256,
    runId: ctx.runId,
    witnessMode: ctx.bindings.witnessMode,
    bindingsSha256: ctx.bindingsSha256,
    targetRelativePath: TARGET_RELATIVE_PATH,
    candidateSha256: ctx.bindings.candidateSha256,
  })}\n`)
  const receipt = readStablePath(join(directory.path, `${sha256(evidence.approvalId)}.json`), MAX_RECORD_BYTES, FILE_MODE, true)
  if (!receipt.equals(expected)) fail("native-handoff-approval-receipt-invalid")
}

function assertNativePromotionHandoffCurrent(
  ctx: PreparedContext,
  records: JournalRecord[],
  manifest: Manifest,
  state: NativePromotionHandoffState,
  evidence: VerifiedEvidence,
): ReturnType<typeof verifyArtifactsAtExpectedSwap> {
  if (ctx.bindings.witnessMode !== "native" || state.bindingsSha256 !== ctx.bindingsSha256 ||
      state.transactionId !== nativePromotionTransactionId(ctx, records) || stable(evidence) !== stable(state.verifiedEvidence) ||
      nativePromotionHandoffStates.get(state.handle) !== state || pendingHeldExchanges.has(descriptorKey(ctx)) ||
      records.at(-1)?.state !== "SWAPPED_EXPECTED") fail("native-handoff-transaction-invalid")
  if (manifest.bindingsSha256 !== ctx.bindingsSha256 || manifest.runId !== ctx.runId ||
      manifest.witnessMode !== "native" || manifest.approvalSha256 !== evidence.approvalSha256) {
    fail("native-handoff-manifest-mismatch")
  }
  assertConsumedApproval(ctx, evidence)
  const artifacts = verifyArtifactsAtExpectedSwap(ctx, records, manifest)
  if (artifacts.live.sha256 !== ctx.bindings.candidateSha256 || artifacts.displaced.sha256 !== ctx.bindings.originalSha256) {
    fail("native-handoff-object-binding-mismatch")
  }
  const backup = helperInspect(ctx, ctx.runDir, manifest.backupName)
  if (backup.sha256 !== ctx.bindings.originalSha256 || (backup.mode & 0o7777) !== manifest.originalMode) {
    fail("native-handoff-backup-binding-mismatch")
  }
  return artifacts
}

/** Observe an approved native transaction; campaign qualification remains a separate controller authority. */
export async function verifyNativePromotionCanaryHandoff(
  input: PromotionCommon & { evidence: PromotionEvidence },
): Promise<NativePromotionCanaryHandoff> {
  requireWitnessMode(input.bindings, "native")
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  try {
    setRunDirectory(ctx)
    const records = readJournal(ctx)
    const manifest = verifyRunJournal(ctx, records)
    if (records.at(-1)?.state !== "SWAPPED_EXPECTED") fail("native-handoff-not-awaiting-canary")
    const evidence = captureEvidence(ctx, input.evidence)
    assertConsumedApproval(ctx, evidence)
    if (manifest.bindingsSha256 !== ctx.bindingsSha256 || manifest.runId !== ctx.runId ||
        manifest.witnessMode !== "native" || manifest.approvalSha256 !== evidence.approvalSha256) {
      fail("native-handoff-manifest-mismatch")
    }
    const before = verifyArtifactsAtExpectedSwap(ctx, records, manifest)
    const backup = helperInspect(ctx, ctx.runDir, manifest.backupName)
    if (before.live.sha256 !== ctx.bindings.candidateSha256 || before.displaced.sha256 !== ctx.bindings.originalSha256 ||
        backup.sha256 !== ctx.bindings.originalSha256 || (backup.mode & 0o7777) !== manifest.originalMode) {
      fail("native-handoff-object-binding-mismatch")
    }
    const freshEvidence = captureEvidence(ctx, input.evidence)
    if (stable(freshEvidence) !== stable(evidence)) fail("native-handoff-evidence-drift")
    const rereadRecords = readJournal(ctx)
    const rereadManifest = verifyRunJournal(ctx, rereadRecords)
    const after = verifyArtifactsAtExpectedSwap(ctx, rereadRecords, rereadManifest)
    if (rereadRecords.at(-1)?.state !== "SWAPPED_EXPECTED" || !sameIdentity(before.live, after.live) ||
        !sameIdentity(before.displaced, after.displaced) || rereadManifest.approvalSha256 !== evidence.approvalSha256) {
      fail("native-handoff-transaction-changed")
    }
    assertConsumedApproval(ctx, freshEvidence)
    const transactionId = nativePromotionTransactionId(ctx, rereadRecords)
    if (nativePromotionHandoffTransactions.has(transactionId)) fail("native-handoff-already-issued")
    const handle = Object.freeze({}) as NativePromotionCanaryHandoff
    const state: NativePromotionHandoffState = {
      handle,
      operation: "apply",
      handoffId: randomBytes(24).toString("hex"),
      transactionId,
      bindings: Object.freeze({ ...ctx.bindings }),
      bindingsSha256: ctx.bindingsSha256,
      evidence: freezeEvidence(input.evidence),
      verifiedEvidence: freshEvidence,
      consumed: false,
      proofAttempted: false,
      commitIssued: false,
      committed: false,
    }
    nativePromotionHandoffStates.set(handle, state)
    nativePromotionHandoffTransactions.add(transactionId)
    return handle
  } finally {
    await release()
  }
}

/** Consume the handoff once for controller binding; the opaque handle then authorizes only its proof phase. */
export function consumeNativePromotionCanaryHandoff(
  value: NativePromotionCanaryHandoff,
): NativePromotionCanaryHandoffReceipt {
  const state = value && typeof value === "object" ? nativePromotionHandoffStates.get(value) : undefined
  if (!state || state.handle !== value || state.consumed || state.proofAttempted || state.commitIssued) {
    fail("native-handoff-invalid-or-consumed")
  }
  const semanticReviewSha256 = state.verifiedEvidence.semanticReviewSha256
  if (!semanticReviewSha256 || !HASH.test(semanticReviewSha256)) fail("native-handoff-semantic-review-missing")
  state.consumed = true
  return Object.freeze({
    handoffId: state.handoffId,
    transactionId: state.transactionId,
    bindings: state.bindings,
    evidence: state.evidence,
    semanticReviewSha256,
  })
}

/** Consume only a commit receipt minted after this exact handoff's COMMITTED journal and target were revalidated. */
export function consumeNativePromotionCanaryCommit(
  value: NativePromotionCanaryCommit,
  expected: Readonly<{ handoffId: string; bindings: PromotionBindings }>,
): void {
  const state = value && typeof value === "object" ? nativePromotionCommitStates.get(value) : undefined
  if (!state || state.consumed || !state.handoff.committed || !state.handoff.commitIssued ||
      !isObject(expected) || !sameKeys(expected, ["handoffId", "bindings"]) ||
      expected.handoffId !== state.handoff.handoffId) fail("native-commit-invalid-or-consumed")
  validBindings(expected.bindings)
  if (stable(expected.bindings) !== stable(state.handoff.bindings) ||
      sha256(stable(expected.bindings)) !== state.handoff.bindingsSha256) fail("native-commit-binding-mismatch")
  state.consumed = true
  nativePromotionCommitStates.delete(value)
  nativePromotionHandoffTransactions.delete(state.handoff.transactionId)
}

/** Observe only a rollback initiated by this process using its genuine, consumed native rollback authorization. */
export async function verifyNativeRollbackCanaryHandoff(
  input: PromotionCommon & Readonly<{ evidence: PromotionEvidence }>,
): Promise<NativeRollbackCanaryHandoff> {
  requireWitnessMode(input.bindings, "native")
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  try {
    setRunDirectory(ctx)
    const records = readJournal(ctx)
    const manifest = verifyRunJournal(ctx, records)
    const intent = recordsByName(records, "ROLLBACK_SWAP_INTENT")
    if (records.at(-1)?.state !== "ROLLBACK_SWAP_INTENT" || !intent) fail("native-rollback-handoff-not-awaiting-canary")
    const evidence = captureEvidence(ctx, input.evidence)
    const semanticReviewSha256 = evidence.semanticReviewSha256
    if (!semanticReviewSha256 || !HASH.test(semanticReviewSha256)) fail("native-rollback-handoff-semantic-review-missing")
    assertConsumedApproval(ctx, evidence)
    const rollbackApprovalSha256 = String(intent.details.operatorApprovalSha256 ?? "")
    const transactionId = nativeRollbackTransactionId(ctx, records, rollbackApprovalSha256)
    const operation = nativeRollbackOperations.get(transactionId)
    if (!operation || nativeRollbackHandoffTransactions.has(transactionId)) fail("native-rollback-handoff-unavailable-or-issued")
    const before = assertNativeRollbackOperationCurrent(ctx, records, manifest, operation, false)
    const freshEvidence = captureEvidence(ctx, input.evidence)
    const rereadRecords = readJournal(ctx)
    const rereadManifest = verifyRunJournal(ctx, rereadRecords)
    const after = assertNativeRollbackOperationCurrent(ctx, rereadRecords, rereadManifest, operation, false)
    if (stable(freshEvidence) !== stable(evidence) || freshEvidence.semanticReviewSha256 !== semanticReviewSha256 ||
        !sameIdentity(before.original, after.original) || !sameIdentity(before.candidate, after.candidate) ||
        !sameIdentity(before.backup, after.backup) || after.latest.seq !== intent.seq || after.latest.checksum !== intent.checksum ||
        operation.rollbackApprovalSha256 !== rollbackApprovalSha256) fail("native-rollback-handoff-observation-drift")
    assertConsumedApproval(ctx, freshEvidence)
    const handle = Object.freeze({}) as NativeRollbackCanaryHandoff
    const state: NativeRollbackHandoffState = {
      handle,
      operation,
      handoffId: randomBytes(24).toString("hex"),
      bindings: Object.freeze({ ...ctx.bindings }),
      bindingsSha256: ctx.bindingsSha256,
      evidence: freezeEvidence(input.evidence),
      verifiedEvidence: freshEvidence,
      semanticReviewSha256,
      consumed: false,
      proofAttempted: false,
      commitIssued: false,
      committed: false,
    }
    nativeRollbackHandoffStates.set(handle, state)
    nativeRollbackHandoffTransactions.add(transactionId)
    return handle
  } finally {
    await release()
  }
}

/** Consume the rollback handoff once for controller binding; serialized receipts do not restore the proof handle. */
export function consumeNativeRollbackCanaryHandoff(
  value: NativeRollbackCanaryHandoff,
  expected: Readonly<{ bindings: PromotionBindings }>,
): NativeRollbackCanaryHandoffReceipt {
  const state = value && typeof value === "object" ? nativeRollbackHandoffStates.get(value) : undefined
  if (!state || state.handle !== value || state.consumed || state.proofAttempted || state.commitIssued ||
      !isObject(expected) || !sameKeys(expected, ["bindings"])) fail("native-rollback-handoff-invalid-or-consumed")
  validBindings(expected.bindings)
  if (!exactBindings(expected.bindings, state.bindings) || sha256(stable(expected.bindings)) !== state.bindingsSha256) {
    fail("native-rollback-handoff-binding-mismatch")
  }
  const semanticReviewSha256 = state.verifiedEvidence.semanticReviewSha256
  if (!semanticReviewSha256 || semanticReviewSha256 !== state.semanticReviewSha256 ||
      !HASH.test(state.operation.rollbackApprovalSha256)) fail("native-rollback-handoff-evidence-invalid")
  state.consumed = true
  return Object.freeze({
    handoffId: state.handoffId,
    transactionId: state.operation.transactionId,
    bindings: state.bindings,
    evidence: state.evidence,
    semanticReviewSha256,
    rollbackApprovalSha256: state.operation.rollbackApprovalSha256,
  })
}

/** Consume only the rollback commit minted after a genuine original-byte proof and ROLLED_BACK revalidation. */
export function consumeNativeRollbackCanaryCommit(
  value: NativeRollbackCanaryCommit,
  expected: Readonly<{ handoffId: string; bindings: PromotionBindings }>,
): void {
  const state = value && typeof value === "object" ? nativeRollbackCommitStates.get(value) : undefined
  if (!state || state.consumed || !state.handoff.committed || !state.handoff.commitIssued ||
      !isObject(expected) || !sameKeys(expected, ["handoffId", "bindings"]) ||
      expected.handoffId !== state.handoff.handoffId) fail("native-rollback-commit-invalid-or-consumed")
  validBindings(expected.bindings)
  if (!exactBindings(expected.bindings, state.handoff.bindings) ||
      sha256(stable(expected.bindings)) !== state.handoff.bindingsSha256) fail("native-rollback-commit-binding-mismatch")
  state.consumed = true
  nativeRollbackCommitStates.delete(value)
  nativeRollbackHandoffTransactions.delete(state.handoff.operation.transactionId)
  nativeRollbackOperations.delete(state.handoff.operation.transactionId)
}

function issueNativePromotionCanaryCommit(handoff: NativePromotionHandoffState): NativePromotionCanaryCommit {
  if (handoff.operation !== "apply" || !handoff.proofAttempted || handoff.commitIssued || handoff.committed) {
    fail("native-commit-handoff-invalid")
  }
  const value = Object.freeze({}) as NativePromotionCanaryCommit
  handoff.commitIssued = true
  handoff.committed = true
  nativePromotionCommitStates.set(value, { handoff, consumed: false })
  return value
}

async function claimNativePromotionCanaryHandoff(
  value: NativePromotionCanaryHandoff,
  ctx: PreparedContext,
  records: JournalRecord[],
  manifest: Manifest,
): Promise<NativePromotionHandoffState> {
  const state = value && typeof value === "object" ? nativePromotionHandoffStates.get(value) : undefined
  if (!state || state.handle !== value || !state.consumed || state.proofAttempted || state.commitIssued || state.committed ||
      stable(state.bindings) !== stable(ctx.bindings) || state.bindingsSha256 !== ctx.bindingsSha256 ||
      state.transactionId !== nativePromotionTransactionId(ctx, records)) fail("native-handoff-invalid-or-consumed")
  state.proofAttempted = true
  const evidence = captureEvidence(ctx, state.evidence as PromotionEvidence)
  assertNativePromotionHandoffCurrent(ctx, records, manifest, state, evidence)
  return state
}

function claimNativeRollbackCanaryHandoff(
  value: NativeRollbackCanaryHandoff,
  ctx: PreparedContext,
  records: JournalRecord[],
  manifest: Manifest,
): NativeRollbackHandoffState {
  const state = value && typeof value === "object" ? nativeRollbackHandoffStates.get(value) : undefined
  if (!state || state.handle !== value || !state.consumed || state.proofAttempted || state.commitIssued || state.committed ||
      !exactBindings(state.bindings, ctx.bindings) || state.bindingsSha256 !== ctx.bindingsSha256 ||
      nativeRollbackOperations.get(state.operation.transactionId) !== state.operation ||
      nativeRollbackTransactionId(ctx, records, state.operation.rollbackApprovalSha256) !== state.operation.transactionId) {
    fail("native-rollback-handoff-invalid-or-consumed")
  }
  state.proofAttempted = true
  const evidence = captureEvidence(ctx, state.evidence as PromotionEvidence)
  if (stable(evidence) !== stable(state.verifiedEvidence) || evidence.semanticReviewSha256 !== state.semanticReviewSha256) {
    fail("native-rollback-handoff-evidence-drift")
  }
  assertConsumedApproval(ctx, evidence)
  assertNativeRollbackOperationCurrent(ctx, records, manifest, state.operation, false)
  return state
}

function issueNativeRollbackCanaryCommit(handoff: NativeRollbackHandoffState): NativeRollbackCanaryCommit {
  if (!handoff.consumed || !handoff.proofAttempted || handoff.commitIssued || handoff.committed) {
    fail("native-rollback-commit-handoff-invalid")
  }
  const value = Object.freeze({}) as NativeRollbackCanaryCommit
  handoff.commitIssued = true
  handoff.committed = true
  nativeRollbackCommitStates.set(value, { handoff, consumed: false })
  return value
}

function journalStateResult(state: JournalState, idempotent: boolean, raceMayHavePublishedCandidate = false): PromotionResult {
  if (state === "COMMITTED" || state === "LOAD_VERIFIED" || state === "SWAPPED_EXPECTED" || state === "RACE_PRESERVED" ||
      state === "RECOVERY_REQUIRED" || state === "ROLLBACK_SWAP_INTENT" || state === "ROLLBACK_RACE_PRESERVED" || state === "ROLLED_BACK") {
    return { state, idempotent, raceMayHavePublishedCandidate }
  }
  return { state: "RECOVERY_REQUIRED", idempotent, raceMayHavePublishedCandidate, reason: "publication-not-complete" }
}

function classifyCommitted(ctx: PreparedContext, records: JournalRecord[], manifest: Manifest, rollback: boolean): PromotionResult {
  const latest = records.at(-1)
  const committedReceiptValid = latest !== undefined && latest.details.witnessMode === ctx.bindings.witnessMode &&
    (ctx.bindings.witnessMode === "native"
      ? latest.details.witnessSchema === NATIVE_SKILL_LOAD_WITNESS_SCHEMA && hasNativeCommitReceipt(ctx, manifest, String(latest.details.witnessSha256))
      : latest.details.witnessSchema === undefined && typeof latest.details.witnessSha256 === "string" &&
        hasCommitReceipt(ctx, manifest, latest.details.witnessSha256))
  if (latest && (latest.state === "COMMITTED" || latest.state === "ROLLED_BACK") && latest.details.witnessMode !== ctx.bindings.witnessMode) {
    return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: !rollback, reason: "commit-witness-mode-mismatch" }
  }
  if (!rollback && latest?.state === "COMMITTED" &&
      (typeof latest.details.witnessSha256 !== "string" || !HASH.test(latest.details.witnessSha256) ||
       !committedReceiptValid)) {
    return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: true, reason: "commit-receipt-drift" }
  }
  try {
    const target = helperInspect(ctx, ctx.target, "SKILL.md")
    if (rollback) {
      if (latest?.state === "ROLLED_BACK" && sameRecordedSnapshot(target, latest.details, "original") &&
          (target.mode & 0o7777) === manifest.originalMode) return journalStateResult(latest.state, true)
    } else {
      const committedSnapshot = recordsByName(records, "SWAPPED_EXPECTED")?.details
      if (committedSnapshot && sameRecordedSnapshot(target, committedSnapshot, "candidate") &&
          (target.mode & 0o7777) === manifest.originalMode) return journalStateResult(latest!.state, true)
    }
  } catch { /* unsafe or missing target is drift */ }
  return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "terminal-target-drift" }
}

/** Performs only the durable exchange. It never reports application success; the fresh host witness is separate. */
export function applySkillOptPromotion(input: ApplySkillOptPromotionInput): Promise<PromotionResult> {
  return observeNativePromotionMutation(input, "apply", () => applySkillOptPromotionWithinMutation(input))
}

async function applySkillOptPromotionWithinMutation(input: ApplySkillOptPromotionInput): Promise<PromotionResult> {
  if (typeof input.verifyEvidence !== "function") fail("verify-evidence-callback-required")
  if (input.bindings.witnessMode === "native" && !input.nativeAuthorization) fail("native-authorization-required")
  if (input.bindings.witnessMode === "legacy" && input.nativeAuthorization !== undefined) fail("native-authorization-mode-mismatch")
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  let targetFd: number | undefined
  let keepTargetFd = false
  try {
    nativeVersion(ctx)
    const nativeAuthorization = ctx.bindings.witnessMode === "native"
      ? consumeNativePromotionAuthorization({
        value: input.nativeAuthorization, ctx, operation: "apply", candidateBytes: input.candidateBytes, evidence: input.evidence,
      })
      : undefined
    let existing = false
    try { setRunDirectory(ctx); existing = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (existing) {
      const records = readJournal(ctx)
      if (!records.length) return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "existing-run-without-journal" }
      const manifest = verifyRunJournal(ctx, records)
      const latest = records.at(-1)!
      const key = descriptorKey(ctx)
      const pending = pendingHeldExchanges.get(key)
      if (latest.state === "RECOVERY_REQUIRED" && pending?.operation === "apply" && pending.report.status === "RACE_HELD" &&
          latest.details.nativeHelperStatus === "RACE_HELD") {
        if (latest.details.retainedArtifact) verifyRetainedArtifact(ctx, latest.details.retainedArtifact)
        return journalStateResult(latest.state, true, true)
      }
      if (latest.state === "RACE_CAPTURED") return finishCapturedRace(ctx, records, "apply")
      if (["SWAPPED_EXPECTED", "LOAD_VERIFIED", "COMMITTED"].includes(latest.state)) {
        return classifyCommitted(ctx, records, manifest, false)
      }
      if (latest.state === "SWAP_INTENT") {
        if (pending?.operation === "apply" && pending.report.status === "RACE_HELD") {
          await verifyEvidenceNow(input, ctx)
          appendJournal(ctx, records, "RECOVERY_REQUIRED", {
            ...heldRecoveryDetails(ctx, pending.report, "apply", String(latest.details.captureName)),
            stageName: latest.details.stageName,
          })
          return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: true,
            reason: "native-helper-held-open-inodes-for-recovery" }
        }
        await verifyEvidenceNow(input, ctx)
        return classifySwap(ctx, records, manifest, retainedOriginalDescriptors.get(key)?.fd,
          true, true)
      }
      if (latest.state === "RACE_PRESERVED" && latest.details.retainedArtifact) verifyRetainedArtifact(ctx, latest.details.retainedArtifact)
      return journalStateResult(latest.state, true, latest.state === "RACE_PRESERVED")
    }

    const evidence = await verifyEvidenceNow(input, ctx)
    if (nativeAuthorization) assertNativePromotionAuthorizationActive(ctx, nativeAuthorization)
    const candidate = Buffer.from(input.candidateBytes)
    if (candidate.length === 0 || candidate.length > MAX_SKILL_BYTES || sha256(candidate) !== ctx.bindings.candidateSha256 ||
        ctx.bindings.candidateSha256 === ctx.bindings.originalSha256) fail("candidate-binding-invalid")
    const original = helperInspect(ctx, ctx.target, "SKILL.md")
    if (original.sha256 !== ctx.bindings.originalSha256 || original.mode & 0o7000) fail("original-binding-or-mode-invalid")
    targetFd = openTargetDescriptor(ctx, original)
    try {
      const stableOriginal = readFdStable(targetFd, original.size)
      if (!stableOriginal.equals(original.bytes) || sha256(stableOriginal) !== ctx.bindings.originalSha256) fail("original-unstable")
    } catch (error) { throw error }

    ensureRunDirectory(ctx)
    fault(input, "RUN_DIRECTORY_CREATED")
    const retention = createRetentionDirectory(ctx)
    const backup = writeExclusive(ctx, ctx.runDir, "original.bin", original.bytes, original.mode & 0o777, MAX_SKILL_BYTES)
    if (backup.sha256 !== ctx.bindings.originalSha256 || (backup.mode & 0o777) !== (original.mode & 0o777)) fail("backup-verification-failed")
    fault(input, "ORIGINAL_BACKUP_DURABLE")
    const stageName = randomName(ctx.runId, "stage")
    const manifest: Manifest = {
      schema: "skillopt.promotion-manifest.v1",
      runId: ctx.runId,
      witnessMode: ctx.bindings.witnessMode,
      targetRelativePath: TARGET_RELATIVE_PATH,
      targetDirectoryDev: ctx.target.dev,
      targetDirectoryIno: ctx.target.ino,
      bindings: ctx.bindings,
      bindingsSha256: ctx.bindingsSha256,
      qualificationSha256: evidence.qualificationSha256,
      reviewSha256: evidence.reviewSha256,
      approvalSha256: evidence.approvalSha256,
      approvalId: evidence.approvalId,
      originalSha256: original.sha256,
      candidateSha256: ctx.bindings.candidateSha256,
      originalMode: original.mode & 0o7777,
      backupName: "original.bin",
      stageName,
      retentionDirectoryDev: retention.dev,
      retentionDirectoryIno: retention.ino,
    }
    writeExclusive(ctx, ctx.runDir, "manifest.json", Buffer.from(`${JSON.stringify(manifest)}\n`), FILE_MODE)
    fault(input, "MANIFEST_DURABLE")
    const records: JournalRecord[] = []
    appendJournal(ctx, records, "PREPARED", {
      runId: ctx.runId,
      witnessMode: ctx.bindings.witnessMode,
      bindingsSha256: ctx.bindingsSha256,
      targetDirectoryDev: ctx.target.dev,
      targetDirectoryIno: ctx.target.ino,
      targetRelativePath: TARGET_RELATIVE_PATH,
      originalSha256: original.sha256,
      candidateSha256: ctx.bindings.candidateSha256,
      originalDev: original.dev,
      originalIno: original.ino,
      originalMode: manifest.originalMode,
      backupName: "original.bin",
      stageName,
      retentionDirectoryDev: retention.dev,
      retentionDirectoryIno: retention.ino,
      approvalSha256: evidence.approvalSha256,
    })
    fault(input, "PREPARED")

    const staged = writeExclusive(ctx, ctx.target, stageName, candidate, original.mode & 0o777, MAX_SKILL_BYTES)
    fault(input, "STAGE_DURABLE")
    if (staged.sha256 !== ctx.bindings.candidateSha256 || (staged.mode & 0o777) !== (original.mode & 0o777)) fail("stage-verification-failed")
    appendJournal(ctx, records, "STAGED", {
      targetName: "SKILL.md", stageName, stageDev: staged.dev, stageIno: staged.ino,
      candidateSha256: staged.sha256, originalDev: original.dev, originalIno: original.ino,
    })
    fault(input, "STAGED")

    const freshEvidence = await verifyEvidenceNow(input, ctx)
    if (stable(freshEvidence) !== stable(evidence)) fail("evidence-drift-before-exchange")
    if (nativeAuthorization) assertNativePromotionAuthorizationActive(ctx, nativeAuthorization)
    const current = helperInspect(ctx, ctx.target, "SKILL.md")
    if (!sameIdentity(current, original)) {
      appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "target-drift-before-exchange", currentSha256: current.sha256 })
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "target-drift-before-exchange" }
    }
    ensureConsumedApproval(ctx, evidence)
    fault(input, "APPROVAL_CONSUMED")
    const stageRecheck = helperInspect(ctx, ctx.target, stageName)
    if (!sameIdentity(stageRecheck, staged)) fail("stage-drift-before-exchange")
    const captureName = randomName(ctx.runId, "capture")
    appendJournal(ctx, records, "SWAP_INTENT", {
      targetName: "SKILL.md", targetDev: original.dev, targetIno: original.ino,
      stageName, stageDev: staged.dev, stageIno: staged.ino,
      captureName, retentionDirectoryDev: retention.dev, retentionDirectoryIno: retention.ino,
      originalSha256: original.sha256, candidateSha256: staged.sha256,
      approvalSha256: evidence.approvalSha256,
    })
    fault(input, "SWAP_INTENT")

    const immediatelyFreshEvidence = await verifyEvidenceNow(input, ctx)
    if (stable(immediatelyFreshEvidence) !== stable(evidence)) fail("evidence-drift-before-exchange")
    if (nativeAuthorization) assertNativePromotionAuthorizationActive(ctx, nativeAuthorization)
    const finalTarget = helperInspect(ctx, ctx.target, "SKILL.md")
    if (!sameIdentity(finalTarget, original)) {
      appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "target-drift-at-exchange-boundary", currentSha256: finalTarget.sha256 })
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "target-drift-at-exchange-boundary" }
    }

    fault(input, "BEFORE_EXCHANGE")
    if (nativeAuthorization) assertNativePromotionAuthorizationActive(ctx, nativeAuthorization)
    retainedOriginalDescriptors.set(descriptorKey(ctx), { fd: targetFd, dev: original.dev, ino: original.ino })
    keepTargetFd = true
    let exchangeError: unknown
    let exchangeReport: NativeExchangeReport | undefined
    try {
      exchangeReport = await runNativeExchange(ctx, nativeExchangeArgs(ctx, "SKILL.md", original, stageName, staged, captureName), "apply", async (report) => {
        appendJournal(ctx, records, "RECOVERY_REQUIRED", {
          ...heldRecoveryDetails(ctx, report, "apply", captureName), stageName,
        })
        fault(input, "RACE_HELD_JOURNALED")
      })
    } catch (error) {
      if (pendingHeldExchanges.has(descriptorKey(ctx))) throw error
      exchangeError = error
    }
    if (exchangeReport?.status === "RACE_HELD") {
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "native-helper-held-open-inodes-for-recovery" }
    }
    if (exchangeReport?.status === "RACE_CAPTURED") {
      let capturedResult: PromotionResult
      try {
        capturedResult = capturedRaceResult(ctx, records, exchangeReport, "apply", stageName, captureName)
      }
      catch (error) {
        if (records.at(-1)?.state === "SWAP_INTENT" || records.at(-1)?.state === "RACE_CAPTURED") {
          try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "native-capture-record-incomplete" }) } catch { /* Keep the last durable record. */ }
        }
        return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true,
          reason: error instanceof PromotionError ? error.code : "native-capture-record-incomplete" }
      }
      fault(input, "EXCHANGE_COMPLETED")
      return capturedResult
    }
    if (exchangeReport) fault(input, "EXCHANGE_COMPLETED")
    let result: PromotionResult
    try {
      result = classifySwap(ctx, records, manifest, targetFd, !exchangeError, true, true, exchangeReport)
    } catch {
      result = { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "exchange-classification-failed" }
    }
    if (exchangeError && result.state === "SWAPPED_EXPECTED") {
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "exchange-flush-ambiguous" }
    }
    if (result.state === "SWAPPED_EXPECTED") fault(input, "SWAPPED_EXPECTED")
    return result
  } finally {
    if (targetFd !== undefined && !keepTargetFd) closeSync(targetFd)
    await release()
  }
}

function parseWitness(bytes: Uint8Array, bindings: PromotionBindings, expectedFileSha256: string): PromotionLoadWitness {
  requireWitnessMode(bindings, "legacy")
  const buffer = Buffer.from(bytes)
  if (buffer.length === 0 || buffer.length > MAX_RECORD_BYTES) fail("witness-size-invalid")
  const text = buffer.toString("utf8")
  if (!Buffer.from(text).equals(buffer)) fail("witness-invalid-utf8")
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return fail("witness-invalid-json") }
  if (!isObject(parsed) || !sameKeys(parsed, [
    "schema", "experimentId", "rootBinding", "runtimeSha256", "observedAt", "hostVersion", "executableSha256", "pluginSha256",
    "sdkSha256", "configSha256", "sessionId", "messageId", "parentMessageId", "callId", "skillName", "targetRelativePath",
    "stagedFileSha256Before", "stagedFileSha256After", "expectedBodySha256", "returnedBodySha256", "returnedPayloadSha256",
    "parserVersion", "hashBases", "loadedOriginalFileSha256", "originalLoadedByteAttestation",
  ]) || parsed.schema !== WITNESS_SCHEMA || parsed.experimentId !== bindings.runId || parsed.rootBinding !== bindings.rootBinding ||
      parsed.runtimeSha256 !== bindings.runtimeSha256 || parsed.hostVersion !== "1.18.33" || parsed.skillName !== "llm-wiki" ||
      parsed.targetRelativePath !== TARGET_RELATIVE_PATH || parsed.parserVersion !== "opencode-1.18.33.skill-output.v1" ||
      parsed.stagedFileSha256Before !== expectedFileSha256 || parsed.stagedFileSha256After !== expectedFileSha256 ||
      typeof parsed.expectedBodySha256 !== "string" || !HASH.test(parsed.expectedBodySha256) || parsed.expectedBodySha256 !== parsed.returnedBodySha256 ||
      typeof parsed.returnedPayloadSha256 !== "string" || !HASH.test(parsed.returnedPayloadSha256) ||
      typeof parsed.observedAt !== "number" || !Number.isSafeInteger(parsed.observedAt) || parsed.observedAt <= 0 || parsed.loadedOriginalFileSha256 !== null ||
      parsed.originalLoadedByteAttestation !== false || !ID.test(String(parsed.sessionId)) || !ID.test(String(parsed.messageId)) ||
      !ID.test(String(parsed.parentMessageId)) || !ID.test(String(parsed.callId))) fail("witness-binding-invalid")
  for (const key of ["executableSha256", "pluginSha256", "sdkSha256", "configSha256"] as const) {
    if (typeof parsed[key] !== "string" || !HASH.test(parsed[key] as string)) fail("witness-runtime-digest-invalid")
  }
  const bases = parsed.hashBases
  if (!isObject(bases) || !sameKeys(bases, ["stagedFile", "expectedBody", "returnedBody", "returnedPayload"]) ||
      bases.stagedFile !== "staged-file-utf8.v1" || bases.expectedBody !== "expected-host-body-1.18.33.v1" ||
      bases.returnedBody !== "observed-returned-body-1.18.33.v1" || bases.returnedPayload !== "returned-payload-utf8.v1") fail("witness-hash-bases-invalid")
  return parsed as unknown as PromotionLoadWitness
}

function nativeFileStatTuple(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length !== 7 || value.some(item => typeof item !== "string")) return undefined
  const tuple = value as string[]
  if (!/^\d+$/u.test(tuple[0]!) || !/^\d+$/u.test(tuple[1]!) || !/^\d+$/u.test(tuple[2]!) ||
      !/^\d+$/u.test(tuple[3]!) || !/^\d+$/u.test(tuple[4]!) || !/^-?\d+$/u.test(tuple[5]!) || !/^-?\d+$/u.test(tuple[6]!)) return undefined
  return tuple
}

function stablePathStatTuple(path: string, directory: boolean): readonly string[] {
  if (realpathSync.native(path) !== path) fail("native-witness-path-not-canonical")
  const stat = lstatSync(path, { bigint: true })
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail("native-witness-path-type-invalid")
  return Object.freeze([
    String(stat.dev), String(stat.ino), String(stat.mode), String(stat.nlink), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs),
  ])
}

function nativeWitnessIdentityMatchesFile(witness: NativeSkillLoadWitnessRecord, ctx: PreparedContext, file: FileSnapshot): boolean {
  try {
    const worktree = resolve(ctx.target.path, "../../..")
    const expectedDirectories = [
      stablePathStatTuple(worktree, true),
      stablePathStatTuple(join(worktree, ".agents"), true),
      stablePathStatTuple(join(worktree, ".agents", "skills"), true),
      stablePathStatTuple(ctx.target.path, true),
    ]
    const recordedDirectories = [witness.fileIdentity.root, witness.fileIdentity.agents, witness.fileIdentity.skills, witness.fileIdentity.skill]
    const targetTuple = [file.dev, file.ino, String(file.mode), String(file.nlink), String(file.size), file.mtimeNs, file.ctimeNs]
    return witness.projectRootSha256 === sha256(worktree) && witness.rootBinding === sha256(`root:${worktree}`) &&
      recordedDirectories.every((tuple, index) => tuple.every((value, field) => value === expectedDirectories[index]![field])) &&
      witness.fileIdentity.file.every((value, index) => value === targetTuple[index]) &&
      witness.capture.skillFileSha256 === file.sha256 && witness.capture.skillFileBytes === file.size
  } catch { return false }
}

function parseNativeWitness(
  bytes: Uint8Array,
  ctx: PreparedContext,
  expectedFileSha256: string,
  operation: "apply" | "rollback",
): NativeSkillLoadWitnessRecord {
  const worktree = resolve(ctx.target.path, "../../..")
  const canonicalWorktree = realpathSync.native(worktree)
  if (canonicalWorktree !== worktree || ctx.bindings.rootBinding !== sha256(`root:${worktree}`)) {
    fail("native-witness-root-binding-invalid")
  }
  const buffer = Buffer.from(bytes)
  if (buffer.length === 0 || buffer.length > MAX_RECORD_BYTES) fail("native-witness-size-invalid")
  const text = buffer.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(buffer)) fail("native-witness-invalid-utf8")
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail("native-witness-invalid-json") }
  if (!isObject(value) || stable(value) !== text || !sameKeys(value, [
    "schema", "operation", "runId", "witnessMode", "rootBinding", "projectRootSha256", "bindingsSha256", "sourceSha256", "originalSha256",
    "candidateSha256", "expectedFileSha256", "fixturePackSha256", "canaryFixtureSha256", "protocolSha256", "evaluatorSha256",
    "runtimeSha256", "resultsSha256", "witnessSha256", "skillPath", "capture", "invocation", "prompt", "native",
    "fileIdentity", "response", "canary", "quiescence",
  ]) || ctx.bindings.witnessMode !== "native" || value.schema !== NATIVE_SKILL_LOAD_WITNESS_SCHEMA || value.operation !== operation ||
      value.runId !== ctx.bindings.runId || value.witnessMode !== "native" ||
      value.rootBinding !== ctx.bindings.rootBinding || value.projectRootSha256 !== sha256(worktree) ||
      value.bindingsSha256 !== ctx.bindingsSha256 || value.sourceSha256 !== ctx.bindings.sourceSha256 ||
      value.originalSha256 !== ctx.bindings.originalSha256 || value.candidateSha256 !== ctx.bindings.candidateSha256 ||
      value.expectedFileSha256 !== expectedFileSha256 || expectedFileSha256 !== (operation === "apply" ? ctx.bindings.candidateSha256 : ctx.bindings.originalSha256) ||
      value.fixturePackSha256 !== ctx.bindings.fixturePackSha256 || value.canaryFixtureSha256 !== ctx.bindings.canaryFixtureSha256 ||
      value.protocolSha256 !== ctx.bindings.protocolSha256 || value.evaluatorSha256 !== ctx.bindings.evaluatorSha256 ||
      value.runtimeSha256 !== ctx.bindings.runtimeSha256 || value.resultsSha256 !== ctx.bindings.resultsSha256 ||
      value.witnessSha256 !== ctx.bindings.witnessSha256 || value.skillPath !== TARGET_RELATIVE_PATH) fail("native-witness-binding-invalid")
  for (const key of ["rootBinding", "projectRootSha256", "bindingsSha256", "sourceSha256", "originalSha256", "candidateSha256",
    "expectedFileSha256", "fixturePackSha256", "canaryFixtureSha256", "protocolSha256", "evaluatorSha256", "runtimeSha256",
    "resultsSha256", "witnessSha256"] as const) {
    if (typeof value[key] !== "string" || !HASH.test(value[key] as string)) fail("native-witness-hash-invalid")
  }
  const capture = value.capture
  if (!isObject(capture) || !sameKeys(capture, ["source", "identity", "classification", "manifestSha256", "contentHash", "skillFileSha256", "skillFileBytes"]) ||
      capture.source !== "project" || capture.identity !== "project:.agents/skills/llm-wiki" ||
      (capture.classification !== "common" && capture.classification !== "custom") ||
      capture.manifestSha256 !== capture.contentHash || typeof capture.manifestSha256 !== "string" || !HASH.test(capture.manifestSha256) ||
      capture.skillFileSha256 !== expectedFileSha256 || typeof capture.skillFileBytes !== "number" ||
      !Number.isSafeInteger(capture.skillFileBytes) || capture.skillFileBytes < 1 || capture.skillFileBytes > MAX_SKILL_BYTES) {
    fail("native-witness-capture-invalid")
  }
  const invocation = value.invocation
  if (!isObject(invocation) || !sameKeys(invocation, ["sessionID", "attachmentEpoch", "executionID", "taskID", "attemptID", "generation", "role", "invocationID", "requestTextSha256"]) ||
      ![invocation.sessionID, invocation.attachmentEpoch, invocation.executionID, invocation.taskID, invocation.attemptID, invocation.invocationID].every(item =>
        typeof item === "string" && item.length > 0 && Buffer.byteLength(item, "utf8") <= 256 && !/[\u0000-\u001f\u007f]/u.test(item)) ||
      !Number.isSafeInteger(invocation.generation) || (invocation.generation as number) < 1 || invocation.role !== "main" ||
      typeof invocation.requestTextSha256 !== "string" || !HASH.test(invocation.requestTextSha256)) fail("native-witness-invocation-invalid")
  const prompt = value.prompt
  if (!isObject(prompt) || !sameKeys(prompt, ["sha256", "bytes", "instructionSha256", "instructionBytes", "instructionStartByte", "instructionEndByte", "spanBasis",
    "evaluatorSystemSha256", "evaluatorSystemBytes", "evaluatorSystemStartByte", "evaluatorSystemEndByte", "evaluatorSpanBasis"]) ||
      typeof prompt.sha256 !== "string" || !HASH.test(prompt.sha256) || typeof prompt.bytes !== "number" || !Number.isSafeInteger(prompt.bytes) ||
      prompt.bytes < 1 || prompt.bytes > 64 * 1024 || typeof prompt.instructionSha256 !== "string" || !HASH.test(prompt.instructionSha256) ||
      prompt.instructionSha256 !== capture.skillFileSha256 || typeof prompt.instructionBytes !== "number" ||
      !Number.isSafeInteger(prompt.instructionBytes) || prompt.instructionBytes !== capture.skillFileBytes ||
      typeof prompt.instructionStartByte !== "number" || !Number.isSafeInteger(prompt.instructionStartByte) || prompt.instructionStartByte < 0 ||
      typeof prompt.instructionEndByte !== "number" || !Number.isSafeInteger(prompt.instructionEndByte) ||
      prompt.instructionEndByte - prompt.instructionStartByte !== prompt.instructionBytes || prompt.instructionEndByte > prompt.bytes ||
      prompt.spanBasis !== "exact-captured-instruction-utf8-substring-v1" ||
      typeof prompt.evaluatorSystemSha256 !== "string" || !HASH.test(prompt.evaluatorSystemSha256) ||
      typeof prompt.evaluatorSystemBytes !== "number" || !Number.isSafeInteger(prompt.evaluatorSystemBytes) ||
      prompt.evaluatorSystemBytes < 1 || prompt.evaluatorSystemBytes > 8 * 1024 ||
      typeof prompt.evaluatorSystemStartByte !== "number" || !Number.isSafeInteger(prompt.evaluatorSystemStartByte) ||
      prompt.evaluatorSystemStartByte < prompt.instructionEndByte ||
      typeof prompt.evaluatorSystemEndByte !== "number" || !Number.isSafeInteger(prompt.evaluatorSystemEndByte) ||
      prompt.evaluatorSystemEndByte - prompt.evaluatorSystemStartByte !== prompt.evaluatorSystemBytes ||
      prompt.evaluatorSystemEndByte > prompt.bytes || prompt.evaluatorSpanBasis !== "exact-code-owned-evaluator-utf8-substring-v1") {
    fail("native-witness-prompt-invalid")
  }
  const native = value.native
  if (!isObject(native) || !sameKeys(native, ["engine", "requestedModel", "identityBefore", "identityAfter", "identitySha256", "identityStable"]) ||
      native.engine !== ctx.bindings.nativeEngine || native.requestedModel !== ctx.bindings.nativeModel ||
      typeof native.identitySha256 !== "string" || !HASH.test(native.identitySha256) || native.identityStable !== true ||
      !isObject(native.identityBefore) || !isObject(native.identityAfter) || stable(native.identityBefore) !== stable(native.identityAfter)) {
    fail("native-witness-runtime-invalid")
  }
  const beforeIdentity = native.identityBefore
  const afterIdentity = native.identityAfter
  const validateIdentity = (identity: Record<string, unknown>) => sameKeys(identity, ["engine", "requestedModel", "runtimeIdentity", "profileIdentity"]) &&
    identity.engine === ctx.bindings.nativeEngine && identity.requestedModel === ctx.bindings.nativeModel &&
    isObject(identity.runtimeIdentity) && sameKeys(identity.runtimeIdentity, ["version", "executableSha256"]) &&
    identity.runtimeIdentity.version === ctx.bindings.nativeRuntimeVersion && identity.runtimeIdentity.executableSha256 === ctx.bindings.nativeExecutableSha256 &&
    isObject(identity.profileIdentity) && sameKeys(identity.profileIdentity, ["id", "sha256"]) &&
    identity.profileIdentity.id === ctx.bindings.nativeProfileId && identity.profileIdentity.sha256 === ctx.bindings.nativeProfileSha256
  if (!validateIdentity(beforeIdentity) || !validateIdentity(afterIdentity)) fail("native-witness-runtime-binding-mismatch")
  const fileIdentity = value.fileIdentity
  if (!isObject(fileIdentity) || !sameKeys(fileIdentity, ["beforeSha256", "afterSha256", "root", "agents", "skills", "skill", "file", "basis"]) ||
      fileIdentity.beforeSha256 !== fileIdentity.afterSha256 || typeof fileIdentity.beforeSha256 !== "string" || !HASH.test(fileIdentity.beforeSha256) ||
      fileIdentity.basis !== "fd-tree-openat-fstat-and-captured-bytes-v1" ||
      !nativeFileStatTuple(fileIdentity.root) || !nativeFileStatTuple(fileIdentity.agents) || !nativeFileStatTuple(fileIdentity.skills) ||
      !nativeFileStatTuple(fileIdentity.skill) || !nativeFileStatTuple(fileIdentity.file)) fail("native-witness-file-identity-invalid")
  const fileIdentitySha256 = sha256(JSON.stringify({
    version: "fd-tree-openat-fstat-and-captured-bytes-v1",
    projectRootSha256: value.projectRootSha256,
    root: fileIdentity.root,
    agents: fileIdentity.agents,
    skills: fileIdentity.skills,
    skill: fileIdentity.skill,
    file: fileIdentity.file,
    skillFileSha256: capture.skillFileSha256,
    manifestSha256: capture.manifestSha256,
  }))
  if (fileIdentity.beforeSha256 !== fileIdentitySha256 || fileIdentity.afterSha256 !== fileIdentitySha256) {
    fail("native-witness-file-identity-hash-mismatch")
  }
  const response = value.response
  if (!isObject(response) || !sameKeys(response, ["sha256", "bytes"]) || typeof response.sha256 !== "string" || !HASH.test(response.sha256) ||
      typeof response.bytes !== "number" || !Number.isSafeInteger(response.bytes) || response.bytes < 1 || response.bytes > 32 * 1024) {
    fail("native-witness-response-invalid")
  }
  const canary = value.canary
  if (!isObject(canary) || !sameKeys(canary, ["fixturePackSha256", "fixtureId", "fixtureSha256", "split", "taskSha256", "evaluatorPromptSha256", "evaluatorSystemSha256", "protocolSha256", "evaluatorSha256", "status", "hardPass", "outputSha256", "scoreSha256"]) ||
      canary.fixturePackSha256 !== ctx.bindings.fixturePackSha256 || canary.fixtureSha256 !== ctx.bindings.canaryFixtureSha256 ||
      canary.split !== "dev" || typeof canary.fixtureId !== "string" || !ID.test(canary.fixtureId) ||
      typeof canary.taskSha256 !== "string" || !HASH.test(canary.taskSha256) ||
      typeof canary.evaluatorPromptSha256 !== "string" || !HASH.test(canary.evaluatorPromptSha256) ||
      typeof canary.evaluatorSystemSha256 !== "string" || !HASH.test(canary.evaluatorSystemSha256) ||
      canary.protocolSha256 !== ctx.bindings.protocolSha256 || canary.evaluatorSha256 !== ctx.bindings.evaluatorSha256 ||
      canary.taskSha256 !== invocation.requestTextSha256 || canary.evaluatorSystemSha256 !== prompt.evaluatorSystemSha256 ||
      canary.outputSha256 !== response.sha256 ||
      canary.status !== "valid" || canary.hardPass !== true || typeof canary.outputSha256 !== "string" || !HASH.test(canary.outputSha256) ||
      typeof canary.scoreSha256 !== "string" || !HASH.test(canary.scoreSha256)) fail("native-witness-canary-invalid")
  const quiescence = value.quiescence
  if (!isObject(quiescence) || !sameKeys(quiescence, ["status", "quiescent", "reconciliation"]) ||
      quiescence.status !== "completed" || quiescence.quiescent !== true || quiescence.reconciliation !== "terminal-quiescent") {
    fail("native-witness-quiescence-invalid")
  }
  if (native.identitySha256 !== sha256(stable(native.identityAfter)) || response.sha256 !== canary.outputSha256) {
    fail("native-witness-derived-binding-invalid")
  }
  return value as unknown as NativeSkillLoadWitnessRecord
}

function verifyArtifactsAtExpectedSwap(ctx: PreparedContext, records: JournalRecord[], manifest: Manifest): {
  live: FileSnapshot; displaced: FileSnapshot; stageName: string; candidate: FileSnapshot; original: FileSnapshot
} {
  const intent = records.findLast((record) => record.state === "SWAP_INTENT")
  const observed = recordsByName(records, "SWAPPED_EXPECTED")?.details
  const stageName = intent?.details.stageName
  if (typeof stageName !== "string" || !observed) fail("missing-swap-observation")
  const live = helperInspect(ctx, ctx.target, "SKILL.md")
  const displaced = helperInspect(ctx, ctx.target, stageName)
  if (!sameRecordedSnapshot(live, observed, "candidate") || !sameRecordedSnapshot(displaced, observed, "original") ||
      (live.mode & 0o7777) !== manifest.originalMode || (displaced.mode & 0o7777) !== manifest.originalMode ||
      displaced.dev !== String(intent?.details.targetDev) || displaced.ino !== String(intent?.details.targetIno)) fail("swapped-artifacts-drift")
  return { live, displaced, stageName, candidate: live, original: displaced }
}

function preserveSwapRace(ctx: PreparedContext, records: JournalRecord[], reason: string): PromotionResult {
  const intent = recordsByName(records, "SWAP_INTENT")
  const stageName = intent?.details.stageName
  if (typeof stageName !== "string") return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason }
  let liveSha256: string | null = null
  let displacedSha256: string | null = null
  try {
    const live = helperInspect(ctx, ctx.target, "SKILL.md")
    const displaced = helperInspect(ctx, ctx.target, stageName)
    liveSha256 = live.sha256
    displacedSha256 = displaced.sha256
  } catch { /* Keep both names untouched when safe descriptor inspection fails. */ }
  if (records.at(-1)?.state === "SWAPPED_EXPECTED" || records.at(-1)?.state === "LOAD_VERIFIED") {
    try {
      appendJournal(ctx, records, "RACE_PRESERVED", {
        reason, targetName: "SKILL.md", stageName, liveSha256, displacedSha256,
      })
    } catch {
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "race-state-not-durable" }
    }
  }
  return { state: "RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: true, reason }
}

function getRetainedOriginal(ctx: PreparedContext, name: string, expected: FileSnapshot): number {
  const key = descriptorKey(ctx)
  const current = retainedOriginalDescriptors.get(key)
  if (current && current.dev === expected.dev && current.ino === expected.ino) return current.fd
  const fd = openSync(join(ctx.target.path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | nativeCloseOnExecFlag())
  const st = fstatSync(fd)
  if (!statMatchesSnapshot(st, expected)) { closeSync(fd); fail("displaced-descriptor-drift") }
  retainedOriginalDescriptors.set(key, { fd, dev: expected.dev, ino: expected.ino })
  return fd
}

function validateWitnessReference(reference: PromotionRecordRef): Buffer {
  const result = readSecureRecord(reference)
  return result.bytes
}

function commitReceiptPayload(ctx: PreparedContext, manifest: Manifest, witnessSha256: string): Buffer {
  return Buffer.from(`${JSON.stringify({
    schema: "skillopt.promotion-commit.v1",
    runId: ctx.runId,
    witnessMode: "legacy",
    rootBinding: ctx.bindings.rootBinding,
    bindingsSha256: ctx.bindingsSha256,
    qualificationSha256: manifest.qualificationSha256,
    reviewSha256: manifest.reviewSha256,
    approvalSha256: manifest.approvalSha256,
    originalSha256: ctx.bindings.originalSha256,
    candidateSha256: ctx.bindings.candidateSha256,
    witnessSha256,
  })}\n`)
}

function hasCommitReceipt(ctx: PreparedContext, manifest: Manifest, witnessSha256: string): boolean {
  try { return readStablePath(join(ctx.runDirPath, "commit.json"), MAX_RECORD_BYTES, FILE_MODE, true).equals(commitReceiptPayload(ctx, manifest, witnessSha256)) }
  catch { return false }
}

function createCommitReceipt(ctx: PreparedContext, manifest: Manifest, witnessSha256: string): void {
  const payload = commitReceiptPayload(ctx, manifest, witnessSha256)
  const path = join(ctx.runDirPath, "commit.json")
  try {
    const prior = readStablePath(path, MAX_RECORD_BYTES, FILE_MODE, true)
    if (!prior.equals(payload)) fail("commit-receipt-conflict")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    writeExclusive(ctx, ctx.runDir, "commit.json", payload, FILE_MODE)
  }
}

function nativeCommitReceiptPayload(ctx: PreparedContext, manifest: Manifest, witnessSha256: string): Buffer {
  return Buffer.from(`${JSON.stringify({
    schema: "skillopt.native-promotion-commit.v1",
    runId: ctx.runId,
    witnessMode: "native",
    rootBinding: ctx.bindings.rootBinding,
    bindingsSha256: ctx.bindingsSha256,
    qualificationSha256: manifest.qualificationSha256,
    reviewSha256: manifest.reviewSha256,
    approvalSha256: manifest.approvalSha256,
    originalSha256: ctx.bindings.originalSha256,
    candidateSha256: ctx.bindings.candidateSha256,
    witnessSchema: NATIVE_SKILL_LOAD_WITNESS_SCHEMA,
    witnessSha256,
  })}\n`)
}

function hasNativeCommitReceipt(ctx: PreparedContext, manifest: Manifest, witnessSha256: string): boolean {
  if (!HASH.test(witnessSha256)) return false
  try {
    return readStablePath(join(ctx.runDirPath, `native-commit-${witnessSha256}.json`), MAX_RECORD_BYTES, FILE_MODE, true)
      .equals(nativeCommitReceiptPayload(ctx, manifest, witnessSha256))
  } catch { return false }
}

function createNativeCommitReceipt(ctx: PreparedContext, manifest: Manifest, witnessSha256: string): void {
  if (!HASH.test(witnessSha256)) fail("invalid-native-witness-digest")
  const payload = nativeCommitReceiptPayload(ctx, manifest, witnessSha256)
  const name = `native-commit-${witnessSha256}.json`
  const path = join(ctx.runDir.path, name)
  try {
    const prior = readStablePath(path, MAX_RECORD_BYTES, FILE_MODE, true)
    if (!prior.equals(payload)) fail("native-commit-receipt-conflict")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    writeExclusive(ctx, ctx.runDir, name, payload, FILE_MODE)
  }
}

/** Adds the independently observed, hash-bound production load witness and commits only after rechecking both inodes. */
export async function recordLoadVerification(input: RecordLoadVerificationInput): Promise<PromotionResult> {
  requireWitnessMode(input.bindings, "legacy")
  if (typeof input.verifyWitness !== "function") fail("verify-witness-callback-required")
  validBindings(input.bindings)
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  try {
    setRunDirectory(ctx)
    const records = readJournal(ctx)
    const manifest = verifyRunJournal(ctx, records)
    const latest = records.at(-1)!
    const bytes = validateWitnessReference(input.witness)
    const witness = parseWitness(bytes, ctx.bindings, ctx.bindings.candidateSha256)
    if (latest.state === "COMMITTED") {
      if (latest.details.witnessSha256 !== input.witness.sha256) fail("committed-witness-mismatch")
      return classifyCommitted(ctx, records, manifest, false)
    }
    if (latest.state !== "SWAPPED_EXPECTED" && latest.state !== "LOAD_VERIFIED") fail("not-awaiting-load-witness")
    if (latest.state === "LOAD_VERIFIED" && latest.details.witnessSha256 !== input.witness.sha256) fail("load-witness-replay-mismatch")
    if (witness.runtimeSha256 !== ctx.bindings.runtimeSha256) fail("witness-runtime-binding-mismatch")
    let before: ReturnType<typeof verifyArtifactsAtExpectedSwap>
    try { before = verifyArtifactsAtExpectedSwap(ctx, records, manifest) }
    catch { return preserveSwapRace(ctx, records, "objects-drifted-before-live-witness") }
    const originalFd = getRetainedOriginal(ctx, before.stageName, before.displaced)
    const old = descriptorSnapshot(originalFd, before.displaced.size)
    if (!old.stable || old.sha256 !== ctx.bindings.originalSha256) {
      if (latest.state === "SWAPPED_EXPECTED") appendJournal(ctx, records, "RACE_PRESERVED", {
        reason: "displaced-original-changed-through-retained-descriptor", stageName: before.stageName,
        displacedStable: old.stable, displacedSha256: old.sha256,
      })
      return { state: "RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "displaced-original-changed" }
    }
    await input.verifyWitness(bytes, ctx.bindings, ctx.bindings.candidateSha256)
    const reread = validateWitnessReference(input.witness)
    if (sha256(reread) !== sha256(bytes)) fail("witness-changed-during-verification")
    let after: ReturnType<typeof verifyArtifactsAtExpectedSwap>
    try { after = verifyArtifactsAtExpectedSwap(ctx, records, manifest) }
    catch { return preserveSwapRace(ctx, records, "objects-drifted-during-live-witness") }
    const oldAfter = descriptorSnapshot(originalFd, after.displaced.size)
    if (!sameIdentity(before.live, after.live) || !sameIdentity(before.displaced, after.displaced) || !oldAfter.stable ||
        oldAfter.sha256 !== ctx.bindings.originalSha256) {
      if (latest.state === "SWAPPED_EXPECTED") appendJournal(ctx, records, "RACE_PRESERVED", {
        reason: "objects-changed-during-live-witness", stageName: before.stageName, displacedStable: oldAfter.stable,
        targetSha256: after.live.sha256, displacedSha256: oldAfter.sha256,
      })
      return { state: "RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "objects-changed-during-live-witness" }
    }
    if (latest.state === "SWAPPED_EXPECTED") {
      appendJournal(ctx, records, "LOAD_VERIFIED", {
        witnessSha256: input.witness.sha256,
        witnessMode: "legacy",
        targetSha256: after.live.sha256,
        returnedBodySha256: witness.returnedBodySha256,
        expectedBodySha256: witness.expectedBodySha256,
      })
      input.faultInjection?.("LOAD_VERIFIED")
    }
    createCommitReceipt(ctx, manifest, input.witness.sha256)
    input.faultInjection?.("COMMIT_RECEIPT_DURABLE")
    if (records.at(-1)?.state === "LOAD_VERIFIED") appendJournal(ctx, records, "COMMITTED", {
      witnessSha256: input.witness.sha256, witnessMode: "legacy", candidateSha256: ctx.bindings.candidateSha256,
    })
    const final = helperInspect(ctx, ctx.target, "SKILL.md")
    if (final.sha256 !== ctx.bindings.candidateSha256 || final.dev !== after.live.dev || final.ino !== after.live.ino) {
      appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "target-drift-after-commit-marker", targetSha256: final.sha256 })
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "target-drift-after-commit-marker" }
    }
    input.faultInjection?.("COMMITTED")
    const key = descriptorKey(ctx)
    const retained = retainedOriginalDescriptors.get(key)
    if (retained) { closeSync(retained.fd); retainedOriginalDescriptors.delete(key) }
    return { state: "COMMITTED", idempotent: latest.state === "LOAD_VERIFIED", raceMayHavePublishedCandidate: true }
  } finally {
    await release()
  }
}

/** Native-only commit gate. The same one-use promotion handoff and opaque host+loader+canary proof are required. */
export async function recordNativeLoadVerification(
  input: RecordNativeLoadVerificationInput,
): Promise<NativePromotionCanaryCommitResult> {
  requireWitnessMode(input.bindings, "native")
  if (!input.proof || typeof input.proof !== "object") fail("native-load-proof-required")
  validBindings(input.bindings)
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  try {
    setRunDirectory(ctx)
    const records = readJournal(ctx)
    const manifest = verifyRunJournal(ctx, records)
    const latest = records.at(-1)!
    const handoff = await claimNativePromotionCanaryHandoff(input.handoff, ctx, records, manifest)
    const bytes = validateWitnessReference(input.witness)
    const witness = parseNativeWitness(bytes, ctx, ctx.bindings.candidateSha256, "apply")
    if (latest.state !== "SWAPPED_EXPECTED") fail("native-promotion-not-awaiting-load-witness")
    let before: ReturnType<typeof verifyArtifactsAtExpectedSwap>
    try { before = verifyArtifactsAtExpectedSwap(ctx, records, manifest) }
    catch { return preserveSwapRace(ctx, records, "objects-drifted-before-native-live-witness") }
    if (!nativeWitnessIdentityMatchesFile(witness, ctx, before.live)) {
      return preserveSwapRace(ctx, records, "native-loader-fd-identity-drift-before-commit")
    }
    const originalFd = getRetainedOriginal(ctx, before.stageName, before.displaced)
    const old = descriptorSnapshot(originalFd, before.displaced.size)
    if (!old.stable || old.sha256 !== ctx.bindings.originalSha256) {
      appendJournal(ctx, records, "RACE_PRESERVED", {
        reason: "displaced-original-changed-through-retained-descriptor", stageName: before.stageName,
        displacedStable: old.stable, displacedSha256: old.sha256,
      })
      return { state: "RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "displaced-original-changed" }
    }
    let verified: NativeSkillLoadWitnessRecord
    try {
      verified = verifyNativeSkillLoadVerificationProof({
        proof: input.proof, bytes, bindings: ctx.bindings, expectedFileSha256: ctx.bindings.candidateSha256,
        projectRootSha256: witness.projectRootSha256, operation: "apply",
      })
    } catch (error) {
      if (error instanceof NativeLoadVerificationError) fail(error.code)
      throw error
    }
    if (stable(verified) !== stable(witness)) fail("native-witness-proof-record-mismatch")
    const reread = validateWitnessReference(input.witness)
    if (sha256(reread) !== sha256(bytes) || !reread.equals(bytes)) fail("native-witness-changed-during-verification")
    let after: ReturnType<typeof verifyArtifactsAtExpectedSwap>
    try { after = verifyArtifactsAtExpectedSwap(ctx, records, manifest) }
    catch { return preserveSwapRace(ctx, records, "objects-drifted-during-native-live-witness") }
    const oldAfter = descriptorSnapshot(originalFd, after.displaced.size)
    if (!sameIdentity(before.live, after.live) || !sameIdentity(before.displaced, after.displaced) || !oldAfter.stable ||
        oldAfter.sha256 !== ctx.bindings.originalSha256 || !nativeWitnessIdentityMatchesFile(witness, ctx, after.live)) {
      appendJournal(ctx, records, "RACE_PRESERVED", {
        reason: "objects-changed-during-native-live-witness", stageName: before.stageName,
        displacedStable: oldAfter.stable, targetSha256: after.live.sha256, displacedSha256: oldAfter.sha256,
      })
      return { state: "RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "objects-changed-during-native-live-witness" }
    }
    appendJournal(ctx, records, "LOAD_VERIFIED", {
      witnessSha256: input.witness.sha256,
      witnessMode: "native",
      witnessSchema: NATIVE_SKILL_LOAD_WITNESS_SCHEMA,
      targetSha256: after.live.sha256,
      responseSha256: witness.response.sha256,
      canaryScoreSha256: witness.canary.scoreSha256,
    })
    input.faultInjection?.("LOAD_VERIFIED")
    createNativeCommitReceipt(ctx, manifest, input.witness.sha256)
    input.faultInjection?.("COMMIT_RECEIPT_DURABLE")
    appendJournal(ctx, records, "COMMITTED", {
      witnessSha256: input.witness.sha256,
      witnessMode: "native",
      witnessSchema: NATIVE_SKILL_LOAD_WITNESS_SCHEMA,
      candidateSha256: ctx.bindings.candidateSha256,
    })
    const final = helperInspect(ctx, ctx.target, "SKILL.md")
    if (final.sha256 !== ctx.bindings.candidateSha256 || final.dev !== after.live.dev || final.ino !== after.live.ino) {
      appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "target-drift-after-native-commit-marker", targetSha256: final.sha256 })
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: true, reason: "target-drift-after-native-commit-marker" }
    }
    const finalRecords = readJournal(ctx)
    const finalManifest = verifyRunJournal(ctx, finalRecords)
    const finalJournal = finalRecords.at(-1)
    if (finalJournal?.state !== "COMMITTED" || finalJournal.details.witnessMode !== "native" ||
        finalJournal.details.witnessSchema !== NATIVE_SKILL_LOAD_WITNESS_SCHEMA ||
        finalJournal.details.witnessSha256 !== input.witness.sha256 || finalManifest.bindingsSha256 !== ctx.bindingsSha256) {
      fail("native-commit-journal-final-verification-failed")
    }
    const committed = classifyCommitted(ctx, finalRecords, finalManifest, false)
    if (committed.state !== "COMMITTED" || !sameIdentity(final, after.live)) {
      fail("native-commit-final-verification-failed")
    }
    input.faultInjection?.("COMMITTED")
    const nativeCommit = issueNativePromotionCanaryCommit(handoff)
    const key = descriptorKey(ctx)
    const retained = retainedOriginalDescriptors.get(key)
    if (retained) { closeSync(retained.fd); retainedOriginalDescriptors.delete(key) }
    return { ...committed, idempotent: false, raceMayHavePublishedCandidate: true, nativeCommit }
  } finally {
    await release()
  }
}

function recordsByName(records: readonly JournalRecord[], state: JournalState): JournalRecord | undefined {
  return [...records].reverse().find((record) => record.state === state)
}

function classifyRollback(ctx: PreparedContext, records: JournalRecord[], manifest: Manifest, allowAppend: boolean): PromotionResult {
  const intent = recordsByName(records, "ROLLBACK_SWAP_INTENT")
  if (!intent || typeof intent.details.rollbackStageName !== "string") return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-intent-missing" }
  if (intent.details.witnessMode !== ctx.bindings.witnessMode) return { state: "RECOVERY_REQUIRED", idempotent: false,
      raceMayHavePublishedCandidate: false, reason: "rollback-witness-mode-mismatch" }
  try {
    const live = helperInspect(ctx, ctx.target, "SKILL.md")
    const displaced = helperInspect(ctx, ctx.target, intent.details.rollbackStageName)
    const approvedCandidate = recordsByName(records, "SWAPPED_EXPECTED")?.details
    const notExchanged = approvedCandidate !== undefined && sameRecordedSnapshot(live, approvedCandidate, "candidate") &&
      live.dev === String(intent.details.targetDev) && live.ino === String(intent.details.targetIno) && displaced.sha256 === ctx.bindings.originalSha256 &&
      displaced.dev === String(intent.details.rollbackStageDev) && displaced.ino === String(intent.details.rollbackStageIno)
    if (notExchanged) {
      if (allowAppend && records.at(-1)?.state === "ROLLBACK_SWAP_INTENT") {
        try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "rollback-intent-without-observed-exchange" }) }
        catch { /* The candidate and original stage remain untouched. */ }
      }
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-exchange-not-observed" }
    }
    const ok = live.sha256 === ctx.bindings.originalSha256 && live.dev === String(intent.details.rollbackStageDev) &&
      live.ino === String(intent.details.rollbackStageIno) && displaced.sha256 === ctx.bindings.candidateSha256 &&
      displaced.dev === String(intent.details.targetDev) && displaced.ino === String(intent.details.targetIno) &&
      (live.mode & 0o7777) === manifest.originalMode && (displaced.mode & 0o7777) === manifest.originalMode
    if (!ok) {
      if (allowAppend && records.at(-1)?.state === "ROLLBACK_SWAP_INTENT") appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
        reason: "rollback-live-or-displaced-object-drift", rollbackStageName: intent.details.rollbackStageName,
        liveSha256: live.sha256, displacedSha256: displaced.sha256,
        liveDev: live.dev, liveIno: live.ino, displacedDev: displaced.dev, displacedIno: displaced.ino,
      })
      return { state: allowAppend ? "ROLLBACK_RACE_PRESERVED" : "RECOVERY_REQUIRED", idempotent: false,
        raceMayHavePublishedCandidate: false, reason: "rollback-object-drift" }
    }
    return { state: "ROLLBACK_SWAP_INTENT", idempotent: true, raceMayHavePublishedCandidate: false }
  } catch {
    return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-objects-uninspectable" }
  }
}

/** Classifies durable recovery evidence; it never repeats an exchange or deletes an artifact. */
export async function recoverSkillOptPromotion(input: RecoverSkillOptPromotionInput): Promise<PromotionResult> {
  if (typeof input.verifyEvidence !== "function") fail("verify-evidence-callback-required")
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  try {
    setRunDirectory(ctx)
    let records: JournalRecord[]
    try { records = readJournal(ctx) } catch {
      return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "journal-invalid-or-torn" }
    }
    if (!records.length) return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "journal-missing" }
    let manifest: Manifest
    try { manifest = verifyRunJournal(ctx, records) } catch {
      return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "journal-binding-mismatch" }
    }
    const latest = records.at(-1)!
    const pending = pendingHeldExchanges.get(descriptorKey(ctx))
    try {
      const backup = helperInspect(ctx, ctx.runDir, manifest.backupName)
      if (backup.sha256 !== manifest.originalSha256 || (backup.mode & 0o7777) !== manifest.originalMode) {
        return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "backup-drift" }
      }
    } catch {
      return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "backup-unavailable" }
    }
    if (pending?.report.status === "RACE_HELD" && latest.state === "RECOVERY_REQUIRED" &&
        latest.details.nativeHelperStatus === "RACE_HELD" && latest.details.exchangeKind === pending.operation) {
      if (latest.details.retainedArtifact) verifyRetainedArtifact(ctx, latest.details.retainedArtifact)
      return journalStateResult(latest.state, true, true)
    }
    if (pending?.report.status === "RACE_HELD" &&
        ((latest.state === "SWAP_INTENT" && pending.operation === "apply") ||
         (latest.state === "ROLLBACK_SWAP_INTENT" && pending.operation === "rollback"))) {
      await verifyEvidenceNow(input, ctx)
      const intent = latest.details
      const stageName = pending.operation === "apply" ? intent.stageName : intent.rollbackStageName
      const captureName = intent.captureName
      appendJournal(ctx, records, "RECOVERY_REQUIRED", {
        ...heldRecoveryDetails(ctx, pending.report, pending.operation, String(captureName)),
        ...(pending.operation === "apply" ? { stageName } : { rollbackStageName: stageName }),
      })
      return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: pending.operation === "apply",
        reason: "native-helper-held-open-inodes-for-recovery" }
    }
    if (latest.state === "RECOVERY_REQUIRED" && latest.details.nativeHelperStatus === "RACE_HELD" && latest.details.retainedArtifact) {
      try { verifyRetainedArtifact(ctx, latest.details.retainedArtifact) }
      catch { return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: true, reason: "held-capture-artifact-unavailable" } }
    }
    if (latest.state === "SWAP_INTENT") {
      await verifyEvidenceNow(input, ctx)
      const status = classifySwap(ctx, records, manifest, retainedOriginalDescriptors.get(descriptorKey(ctx))?.fd, true, true)
      if (status.state !== "SWAPPED_EXPECTED") return status
      return status
    }
    if (latest.state === "RACE_CAPTURED") return finishCapturedRace(ctx, records, "apply")
    if (latest.state === "ROLLBACK_CAPTURED") return finishCapturedRace(ctx, records, "rollback")
    if (latest.state === "ROLLBACK_SWAP_INTENT") return classifyRollback(ctx, records, manifest, true)
    if (latest.state === "COMMITTED" || latest.state === "ROLLED_BACK") {
      const terminal = classifyCommitted(ctx, records, manifest, latest.state === "ROLLED_BACK")
      if (terminal.state === "RECOVERY_REQUIRED") {
        try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "terminal-target-drift" }) } catch { /* Keep contradictory history intact. */ }
        return terminal
      }
      const displacedName = latest.state === "ROLLED_BACK"
        ? recordsByName(records, "ROLLBACK_SWAP_INTENT")?.details.rollbackStageName
        : recordsByName(records, "SWAP_INTENT")?.details.stageName
      try {
        if (typeof displacedName !== "string") fail("terminal-displaced-name-missing")
        const displaced = helperInspect(ctx, ctx.target, displacedName)
        const expected = recordsByName(records, "SWAP_INTENT")?.details
        const expectedSha = latest.state === "ROLLED_BACK" ? ctx.bindings.candidateSha256 : ctx.bindings.originalSha256
        const expectedDev = latest.state === "ROLLED_BACK" ? expected?.stageDev : expected?.targetDev
        const expectedIno = latest.state === "ROLLED_BACK" ? expected?.stageIno : expected?.targetIno
        const originalSnapshot = recordsByName(records, "SWAPPED_EXPECTED")?.details
        const snapshotMatches = latest.state === "COMMITTED"
          ? originalSnapshot !== undefined && sameRecordedSnapshot(displaced, originalSnapshot, "original")
          : sameRecordedSnapshot(displaced, latest.details, "candidate")
        if (displaced.sha256 !== expectedSha || displaced.dev !== String(expectedDev) || displaced.ino !== String(expectedIno) || !snapshotMatches) {
          appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "terminal-displaced-object-drift", displacedSha256: displaced.sha256 })
          return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "terminal-displaced-object-drift" }
        }
      } catch {
        if (records.at(-1)?.state === "COMMITTED" || records.at(-1)?.state === "ROLLED_BACK") {
          try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "terminal-displaced-object-unavailable" }) } catch { /* Preserve terminal history. */ }
        }
        return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "terminal-displaced-object-unavailable" }
      }
      return terminal
    }
    if (latest.state === "SWAPPED_EXPECTED" || latest.state === "LOAD_VERIFIED") {
      await verifyEvidenceNow(input, ctx)
      try { verifyArtifactsAtExpectedSwap(ctx, records, manifest) } catch {
        try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "post-exchange-object-drift" }) } catch { /* Prior records remain evidence. */ }
        return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: true, reason: "post-exchange-object-drift" }
      }
      const status = classifyCommitted(ctx, records, manifest, false)
      if (status.state !== "RECOVERY_REQUIRED") return status
      try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "post-exchange-live-target-drift" }) } catch { /* Preserve state if durability fails. */ }
      return status
    }
    if (latest.state === "RACE_PRESERVED") {
      if (latest.details.retainedArtifact) {
        try { verifyRetainedArtifact(ctx, latest.details.retainedArtifact); return journalStateResult(latest.state, true, true) }
        catch { return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: true, reason: "retained-race-artifact-unavailable" } }
      }
      const stageName = latest.details.stageName
      try {
        helperInspect(ctx, ctx.target, "SKILL.md")
        if (typeof stageName === "string") helperInspect(ctx, ctx.target, stageName)
        return journalStateResult(latest.state, true, true)
      } catch { return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: true, reason: "preserved-object-unavailable" } }
    }
    if (latest.state === "ROLLBACK_RACE_PRESERVED") {
      if (latest.details.retainedArtifact) {
        try { verifyRetainedArtifact(ctx, latest.details.retainedArtifact); return journalStateResult(latest.state, true, false) }
        catch { return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "retained-rollback-artifact-unavailable" } }
      }
      const stageName = latest.details.rollbackStageName
      try {
        helperInspect(ctx, ctx.target, "SKILL.md")
        if (typeof stageName === "string") helperInspect(ctx, ctx.target, stageName)
        return journalStateResult(latest.state, true, false)
      } catch { return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "preserved-rollback-object-unavailable" } }
    }
    if (latest.state === "PREPARED" || latest.state === "STAGED" || latest.state === "RECOVERY_REQUIRED") {
      if (latest.state === "PREPARED" || latest.state === "STAGED") {
        try {
          const prepared = records.find((record) => record.state === "PREPARED")!
          const live = helperInspect(ctx, ctx.target, "SKILL.md")
          if (live.sha256 !== ctx.bindings.originalSha256 || live.dev !== String(prepared.details.originalDev) ||
              live.ino !== String(prepared.details.originalIno)) {
            return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "pre-swap-target-drift" }
          }
          const stageName = manifest.stageName
          try {
            const staged = helperInspect(ctx, ctx.target, stageName)
            if (latest.state === "STAGED" && (staged.sha256 !== ctx.bindings.candidateSha256 ||
                staged.dev !== String(latest.details.stageDev) || staged.ino !== String(latest.details.stageIno))) {
              return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "staged-object-drift" }
            }
          } catch {
            if (latest.state === "STAGED") return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "staged-object-unavailable" }
          }
        } catch {
          return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false, reason: "pre-swap-objects-uninspectable" }
        }
      }
      return journalStateResult(latest.state, true)
    }
    return journalStateResult(latest.state, true)
  } finally {
    await release()
  }
}

/** Restores only the immutable backup after rechecking the live approved candidate; displaced objects remain named. */
export function rollbackSkillOptPromotion(input: RollbackSkillOptPromotionInput): Promise<PromotionResult> {
  return observeNativePromotionMutation(input, "rollback", () => rollbackSkillOptPromotionWithinMutation(input))
}

async function rollbackSkillOptPromotionWithinMutation(input: RollbackSkillOptPromotionInput): Promise<PromotionResult> {
  if (input.bindings.witnessMode === "native" && !input.nativeAuthorization) fail("native-authorization-required")
  if (input.bindings.witnessMode === "native" && input.verifyRollback !== undefined) fail("native-rollback-callback-forbidden")
  if (input.bindings.witnessMode === "legacy" && typeof input.verifyRollback !== "function") fail("verify-rollback-callback-required")
  if (input.bindings.witnessMode === "legacy" && input.nativeAuthorization !== undefined) fail("native-authorization-mode-mismatch")
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  try {
    setRunDirectory(ctx)
    const records = readJournal(ctx)
    const manifest = verifyRunJournal(ctx, records)
    const latest = records.at(-1)!
    const nativeAuthorization = ctx.bindings.witnessMode === "native"
      ? consumeNativePromotionAuthorization({ value: input.nativeAuthorization, ctx, operation: "rollback" })
      : undefined
    if (latest.state === "ROLLED_BACK") return classifyCommitted(ctx, records, manifest, true)
    if (latest.state === "ROLLBACK_CAPTURED") return finishCapturedRace(ctx, records, "rollback")
    if (latest.state === "ROLLBACK_RACE_PRESERVED" && latest.details.retainedArtifact) {
      verifyRetainedArtifact(ctx, latest.details.retainedArtifact)
      return journalStateResult(latest.state, true)
    }
    if (latest.state === "ROLLBACK_SWAP_INTENT" && pendingHeldExchanges.has(descriptorKey(ctx))) {
      return { state: "RECOVERY_REQUIRED", idempotent: true, raceMayHavePublishedCandidate: false,
        reason: "native-helper-held-open-inodes-for-recovery" }
    }
    if (latest.state === "ROLLBACK_SWAP_INTENT") return classifyRollback(ctx, records, manifest, true)
    if (!["SWAPPED_EXPECTED", "LOAD_VERIFIED", "COMMITTED"].includes(latest.state)) fail("rollback-not-authorized-for-state")
    if (!nativeAuthorization) await input.verifyRollback!()
    if (nativeAuthorization) assertNativePromotionAuthorizationActive(ctx, nativeAuthorization)
    const target = helperInspect(ctx, ctx.target, "SKILL.md")
    const expectedCandidate = recordsByName(records, "SWAPPED_EXPECTED")
    if (!expectedCandidate || !sameRecordedSnapshot(target, expectedCandidate.details, "candidate") ||
        (target.mode & 0o7777) !== manifest.originalMode) {
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-live-target-drift" }
    }
    const backup = helperInspect(ctx, ctx.runDir, manifest.backupName)
    if (backup.sha256 !== ctx.bindings.originalSha256 || (backup.mode & 0o7777) !== manifest.originalMode) fail("rollback-backup-invalid")
    const rollbackStageName = randomName(ctx.runId, "rollback")
    appendJournal(ctx, records, "ROLLBACK_PREPARED", {
      witnessMode: ctx.bindings.witnessMode,
      originalSha256: ctx.bindings.originalSha256, candidateSha256: ctx.bindings.candidateSha256,
      rollbackStageName, stagePending: true,
      targetDev: target.dev, targetIno: target.ino, approvalSha256: manifest.approvalSha256,
      ...(nativeAuthorization ? {
        operatorApprovalName: basename(nativeAuthorization.approvalRecord.path),
        operatorApprovalSha256: nativeAuthorization.approvalRecordSha256,
      } : {}),
    })
    input.faultInjection?.("ROLLBACK_PREPARED")
    const stage = writeExclusive(ctx, ctx.target, rollbackStageName, backup.bytes, manifest.originalMode & 0o777, MAX_SKILL_BYTES)
    input.faultInjection?.("ROLLBACK_STAGE_DURABLE")
    if (stage.sha256 !== ctx.bindings.originalSha256 || (stage.mode & 0o7777) !== manifest.originalMode) fail("rollback-stage-invalid")
    if (nativeAuthorization) assertNativePromotionAuthorizationActive(ctx, nativeAuthorization)
    else await input.verifyRollback!()
    const targetAgain = helperInspect(ctx, ctx.target, "SKILL.md")
    if (!sameIdentity(target, targetAgain)) return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-target-changed-before-exchange" }
    const targetFd = openTargetDescriptor(ctx, targetAgain)
    retainedRollbackDescriptors.set(descriptorKey(ctx), { fd: targetFd, dev: target.dev, ino: target.ino })
    const captureName = randomName(ctx.runId, "capture")
    appendJournal(ctx, records, "ROLLBACK_SWAP_INTENT", {
      witnessMode: ctx.bindings.witnessMode,
      targetName: "SKILL.md", targetDev: target.dev, targetIno: target.ino, targetMode: target.mode,
      targetSize: target.size, targetMtimeNs: target.mtimeNs, targetCtimeNs: target.ctimeNs,
      rollbackStageName, rollbackStageDev: stage.dev, rollbackStageIno: stage.ino,
      captureName, retentionDirectoryDev: retentionDirectory(ctx).dev, retentionDirectoryIno: retentionDirectory(ctx).ino,
      originalSha256: backup.sha256, candidateSha256: target.sha256,
      ...(nativeAuthorization ? {
        operatorApprovalName: basename(nativeAuthorization.approvalRecord.path),
        operatorApprovalSha256: nativeAuthorization.approvalRecordSha256,
      } : {}),
    })
    input.faultInjection?.("ROLLBACK_SWAP_INTENT")
    input.faultInjection?.("BEFORE_ROLLBACK_EXCHANGE")
    if (nativeAuthorization) assertNativePromotionAuthorizationActive(ctx, nativeAuthorization)
    let exchangeError: unknown
    let exchangeReport: NativeExchangeReport | undefined
    try {
      exchangeReport = await runNativeExchange(ctx, nativeExchangeArgs(ctx, "SKILL.md", target, rollbackStageName, stage, captureName), "rollback", async (report) => {
        appendJournal(ctx, records, "RECOVERY_REQUIRED", {
          ...heldRecoveryDetails(ctx, report, "rollback", captureName), rollbackStageName,
        })
        input.faultInjection?.("ROLLBACK_RACE_HELD_JOURNALED")
      })
    } catch (error) {
      if (pendingHeldExchanges.has(descriptorKey(ctx))) throw error
      exchangeError = error
    }
    if (exchangeReport?.status === "RACE_HELD") {
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false,
        reason: "native-helper-held-open-inodes-for-recovery" }
    }
    if (exchangeReport?.status === "RACE_CAPTURED") {
      let capturedResult: PromotionResult
      try {
        capturedResult = capturedRaceResult(ctx, records, exchangeReport, "rollback", rollbackStageName, captureName)
      }
      catch (error) {
        if (records.at(-1)?.state === "ROLLBACK_SWAP_INTENT" || records.at(-1)?.state === "ROLLBACK_CAPTURED") {
          try { appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "native-capture-record-incomplete" }) } catch { /* Keep the last durable record. */ }
        }
        return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false,
          reason: error instanceof PromotionError ? error.code : "native-capture-record-incomplete" }
      }
      input.faultInjection?.("ROLLBACK_EXCHANGE_COMPLETED")
      return capturedResult
    }
    if (exchangeReport) input.faultInjection?.("ROLLBACK_EXCHANGE_COMPLETED")
    const result = classifyRollback(ctx, records, manifest, true)
    if (exchangeError && result.state === "ROLLBACK_SWAP_INTENT") return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-flush-ambiguous" }
    if (result.state === "ROLLBACK_SWAP_INTENT" && nativeAuthorization) {
      try { registerNativeRollbackOperation(ctx, records, manifest, nativeAuthorization) }
      catch (error) {
        return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false,
          reason: error instanceof PromotionError ? error.code : "native-rollback-handoff-observation-failed" }
      }
    }
    return result
  } finally {
    await release()
  }
}

/** Completes rollback only after the actual fresh original-byte load witness and the displaced candidate both recheck. */
export async function recordRollbackLoadVerification(input: RecordLoadVerificationInput): Promise<PromotionResult> {
  requireWitnessMode(input.bindings, "legacy")
  if (typeof input.verifyWitness !== "function") fail("verify-witness-callback-required")
  validBindings(input.bindings)
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  try {
    setRunDirectory(ctx)
    const records = readJournal(ctx)
    const manifest = verifyRunJournal(ctx, records)
    const latest = records.at(-1)!
    const witnessBytes = validateWitnessReference(input.witness)
    parseWitness(witnessBytes, ctx.bindings, ctx.bindings.originalSha256)
    if (latest.state === "ROLLED_BACK") {
      if (latest.details.witnessSha256 !== input.witness.sha256) fail("committed-rollback-witness-mismatch")
      return classifyCommitted(ctx, records, manifest, true)
    }
    if (latest.state !== "ROLLBACK_SWAP_INTENT") fail("not-awaiting-rollback-witness")
    const intent = recordsByName(records, "ROLLBACK_SWAP_INTENT")!
    if (latest.details.witnessSha256 !== undefined && latest.details.witnessSha256 !== input.witness.sha256) fail("rollback-witness-replay-mismatch")
    const live = helperInspect(ctx, ctx.target, "SKILL.md")
    const displaced = helperInspect(ctx, ctx.target, String(intent.details.rollbackStageName))
    const approvedCandidate = recordsByName(records, "SWAPPED_EXPECTED")?.details
    const notExchanged = approvedCandidate !== undefined && sameRecordedSnapshot(live, approvedCandidate, "candidate") &&
      live.dev === String(intent.details.targetDev) && live.ino === String(intent.details.targetIno) && displaced.sha256 === ctx.bindings.originalSha256 &&
      displaced.dev === String(intent.details.rollbackStageDev) && displaced.ino === String(intent.details.rollbackStageIno)
    if (notExchanged) {
      appendJournal(ctx, records, "RECOVERY_REQUIRED", { reason: "rollback-intent-without-observed-exchange" })
      return { state: "RECOVERY_REQUIRED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-exchange-not-observed" }
    }
    if (live.sha256 !== ctx.bindings.originalSha256 || live.dev !== String(intent.details.rollbackStageDev) ||
        live.ino !== String(intent.details.rollbackStageIno) || displaced.sha256 !== ctx.bindings.candidateSha256 ||
        displaced.dev !== String(intent.details.targetDev) || displaced.ino !== String(intent.details.targetIno)) {
      appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
        reason: "rollback-objects-drifted-before-witness", rollbackStageName: intent.details.rollbackStageName,
        liveSha256: live.sha256, displacedSha256: displaced.sha256,
      })
      return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-objects-drifted" }
    }
    const retainedKey = descriptorKey(ctx)
    const heldCandidate = retainedRollbackDescriptors.get(retainedKey)
    if (heldCandidate) {
      const descriptor = descriptorSnapshot(heldCandidate.fd, displaced.size)
      if (!descriptor.stable || descriptor.sha256 !== ctx.bindings.candidateSha256) {
        appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
          reason: "displaced-candidate-changed-through-retained-descriptor", displacedStable: descriptor.stable,
          rollbackStageName: intent.details.rollbackStageName, displacedSha256: descriptor.sha256,
        })
        return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "displaced-candidate-changed" }
      }
    }
    await input.verifyWitness(witnessBytes, ctx.bindings, ctx.bindings.originalSha256)
    const afterTarget = helperInspect(ctx, ctx.target, "SKILL.md")
    const afterDisplaced = helperInspect(ctx, ctx.target, String(intent.details.rollbackStageName))
    if (!sameIdentity(live, afterTarget) || !sameIdentity(displaced, afterDisplaced)) {
      appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
        reason: "rollback-objects-drifted-during-witness", rollbackStageName: intent.details.rollbackStageName,
        liveSha256: afterTarget.sha256, displacedSha256: afterDisplaced.sha256,
      })
      return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-objects-drifted-during-witness" }
    }
    if (heldCandidate) {
      const descriptor = descriptorSnapshot(heldCandidate.fd, afterDisplaced.size)
      if (!descriptor.stable || descriptor.sha256 !== ctx.bindings.candidateSha256) {
        appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
          reason: "displaced-candidate-changed-during-witness", displacedStable: descriptor.stable,
          rollbackStageName: intent.details.rollbackStageName, displacedSha256: descriptor.sha256,
        })
        return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "displaced-candidate-changed-during-witness" }
      }
    }
    input.faultInjection?.("ROLLBACK_LOAD_VERIFIED")
    appendJournal(ctx, records, "ROLLED_BACK", {
      witnessSha256: input.witness.sha256, witnessMode: "legacy", originalSha256: ctx.bindings.originalSha256,
      originalDev: afterTarget.dev, originalIno: afterTarget.ino, originalMode: afterTarget.mode,
      originalSize: afterTarget.size, originalMtimeNs: afterTarget.mtimeNs, originalCtimeNs: afterTarget.ctimeNs,
      candidateSha256: afterDisplaced.sha256, candidateDev: afterDisplaced.dev, candidateIno: afterDisplaced.ino,
      candidateMode: afterDisplaced.mode, candidateSize: afterDisplaced.size,
      candidateMtimeNs: afterDisplaced.mtimeNs, candidateCtimeNs: afterDisplaced.ctimeNs,
    })
    input.faultInjection?.("ROLLED_BACK")
    if (heldCandidate) { closeSync(heldCandidate.fd); retainedRollbackDescriptors.delete(retainedKey) }
    return { state: "ROLLED_BACK", idempotent: false, raceMayHavePublishedCandidate: false }
  } finally {
    await release()
  }
}

/** Native-only rollback completion: the exact immutable original needs a new authentic loader+canary proof. */
export async function recordNativeRollbackLoadVerification(input: RecordNativeRollbackLoadVerificationInput): Promise<NativeRollbackCanaryCommitResult> {
  requireWitnessMode(input.bindings, "native")
  if (!input.proof || typeof input.proof !== "object") fail("native-load-proof-required")
  validBindings(input.bindings)
  const ctx = preparePaths(input)
  const release = await lockNative(ctx)
  try {
    setRunDirectory(ctx)
    const records = readJournal(ctx)
    const manifest = verifyRunJournal(ctx, records)
    const latest = records.at(-1)!
    const handoff = claimNativeRollbackCanaryHandoff(input.handoff, ctx, records, manifest)
    const bytes = validateWitnessReference(input.witness)
    const witness = parseNativeWitness(bytes, ctx, ctx.bindings.originalSha256, "rollback")
    if (latest.state !== "ROLLBACK_SWAP_INTENT") fail("native-rollback-not-awaiting-load-witness")
    const intent = recordsByName(records, "ROLLBACK_SWAP_INTENT")!
    const rollbackPrepared = recordsByName(records, "ROLLBACK_PREPARED")
    if (!rollbackPrepared || rollbackPrepared.details.approvalSha256 !== manifest.approvalSha256) {
      fail("native-rollback-approval-binding-mismatch")
    }
    const rollbackStageName = String(intent.details.rollbackStageName)
    const live = helperInspect(ctx, ctx.target, "SKILL.md")
    const displaced = helperInspect(ctx, ctx.target, rollbackStageName)
    if (live.sha256 !== ctx.bindings.originalSha256 || live.dev !== String(intent.details.rollbackStageDev) ||
        live.ino !== String(intent.details.rollbackStageIno) || displaced.sha256 !== ctx.bindings.candidateSha256 ||
        displaced.dev !== String(intent.details.targetDev) || displaced.ino !== String(intent.details.targetIno)) {
      appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
        reason: "rollback-objects-drifted-before-native-witness", rollbackStageName,
        liveSha256: live.sha256, displacedSha256: displaced.sha256,
      })
      return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-objects-drifted" }
    }
    if (!nativeWitnessIdentityMatchesFile(witness, ctx, live)) {
      appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
        reason: "native-loader-fd-identity-drift-before-rollback-commit", rollbackStageName,
        liveSha256: live.sha256, displacedSha256: displaced.sha256,
      })
      return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "native-loader-fd-identity-drift" }
    }
    const retainedKey = descriptorKey(ctx)
    const heldCandidate = retainedRollbackDescriptors.get(retainedKey)
    if (heldCandidate) {
      const beforeCandidate = descriptorSnapshot(heldCandidate.fd, displaced.size)
      if (!beforeCandidate.stable || beforeCandidate.sha256 !== ctx.bindings.candidateSha256) {
        appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
          reason: "displaced-candidate-changed-through-retained-descriptor", displacedStable: beforeCandidate.stable,
          rollbackStageName, displacedSha256: beforeCandidate.sha256,
        })
        return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "displaced-candidate-changed" }
      }
    }
    assertNativeRollbackOperationCurrent(ctx, records, manifest, handoff.operation, false)
    let verified: NativeSkillLoadWitnessRecord
    try {
      verified = verifyNativeSkillLoadVerificationProof({
        proof: input.proof, bytes, bindings: ctx.bindings, expectedFileSha256: ctx.bindings.originalSha256,
        projectRootSha256: witness.projectRootSha256, operation: "rollback",
      })
    } catch (error) {
      if (error instanceof NativeLoadVerificationError) fail(error.code)
      throw error
    }
    if (stable(verified) !== stable(witness)) fail("native-rollback-witness-proof-record-mismatch")
    const reread = validateWitnessReference(input.witness)
    if (sha256(reread) !== sha256(bytes) || !reread.equals(bytes)) fail("native-rollback-witness-changed-during-verification")
    const afterTarget = helperInspect(ctx, ctx.target, "SKILL.md")
    const afterDisplaced = helperInspect(ctx, ctx.target, rollbackStageName)
    if (!sameIdentity(live, afterTarget) || !sameIdentity(displaced, afterDisplaced) ||
        !nativeWitnessIdentityMatchesFile(witness, ctx, afterTarget)) {
      appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
        reason: "rollback-objects-drifted-during-native-witness", rollbackStageName,
        liveSha256: afterTarget.sha256, displacedSha256: afterDisplaced.sha256,
      })
      return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "rollback-objects-drifted-during-witness" }
    }
    if (heldCandidate) {
      const afterCandidate = descriptorSnapshot(heldCandidate.fd, afterDisplaced.size)
      if (!afterCandidate.stable || afterCandidate.sha256 !== ctx.bindings.candidateSha256) {
        appendJournal(ctx, records, "ROLLBACK_RACE_PRESERVED", {
          reason: "displaced-candidate-changed-during-native-witness", displacedStable: afterCandidate.stable,
          rollbackStageName, displacedSha256: afterCandidate.sha256,
        })
        return { state: "ROLLBACK_RACE_PRESERVED", idempotent: false, raceMayHavePublishedCandidate: false, reason: "displaced-candidate-changed-during-witness" }
      }
    }
    assertNativeRollbackOperationCurrent(ctx, records, manifest, handoff.operation, false)
    input.faultInjection?.("ROLLBACK_LOAD_VERIFIED")
    appendJournal(ctx, records, "ROLLED_BACK", {
      witnessSha256: input.witness.sha256,
      witnessMode: "native",
      witnessSchema: NATIVE_SKILL_LOAD_WITNESS_SCHEMA,
      responseSha256: witness.response.sha256,
      canaryScoreSha256: witness.canary.scoreSha256,
      originalSha256: ctx.bindings.originalSha256,
      originalDev: afterTarget.dev, originalIno: afterTarget.ino, originalMode: afterTarget.mode,
      originalSize: afterTarget.size, originalMtimeNs: afterTarget.mtimeNs, originalCtimeNs: afterTarget.ctimeNs,
      candidateSha256: afterDisplaced.sha256, candidateDev: afterDisplaced.dev, candidateIno: afterDisplaced.ino,
      candidateMode: afterDisplaced.mode, candidateSize: afterDisplaced.size,
      candidateMtimeNs: afterDisplaced.mtimeNs, candidateCtimeNs: afterDisplaced.ctimeNs,
    })
    input.faultInjection?.("ROLLED_BACK")
    const committedRecords = readJournal(ctx)
    const committedManifest = verifyRunJournal(ctx, committedRecords)
    const committed = assertNativeRollbackOperationCurrent(ctx, committedRecords, committedManifest, handoff.operation, true)
    const committedWitnessBytes = validateWitnessReference(input.witness)
    const committedWitness = parseNativeWitness(committedWitnessBytes, ctx, ctx.bindings.originalSha256, "rollback")
    if (committed.latest.details.witnessSha256 !== input.witness.sha256 ||
        committed.latest.details.responseSha256 !== verified.response.sha256 ||
        committed.latest.details.canaryScoreSha256 !== verified.canary.scoreSha256 ||
        !committedWitnessBytes.equals(bytes) || stable(committedWitness) !== stable(verified) ||
        !nativeWitnessIdentityMatchesFile(committedWitness, ctx, committed.original)) fail("native-rollback-commit-proof-binding-mismatch")
    const verifiedEvidence = captureEvidence(ctx, handoff.evidence as PromotionEvidence)
    if (stable(verifiedEvidence) !== stable(handoff.verifiedEvidence) ||
        verifiedEvidence.semanticReviewSha256 !== handoff.semanticReviewSha256) fail("native-rollback-commit-evidence-drift")
    assertConsumedApproval(ctx, verifiedEvidence)
    const nativeRollbackCommit = issueNativeRollbackCanaryCommit(handoff)
    if (heldCandidate) { closeSync(heldCandidate.fd); retainedRollbackDescriptors.delete(retainedKey) }
    return { state: "ROLLED_BACK", idempotent: false, raceMayHavePublishedCandidate: false, nativeRollbackCommit }
  } finally {
    await release()
  }
}
