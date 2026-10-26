import { randomUUID } from "node:crypto"
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { isDeepStrictEqual } from "node:util"
import {
  admissionEpoch, admissionFence, captureAdmissionLease, effectiveHold, isAdmissionCurrent, isAdmissionLeaseCurrent,
  type AdmissionLease,
} from "../sessions/admission.ts"
import { getOwnedSession, inspectSessionAttachment, readSessionMetadata, type SessionAttachmentInspection, type SessionStore } from "../sessions/store.ts"
import { readSessionDigests, type SessionDigest } from "../sessions/digest.ts"
import { getQueue } from "../orchestration/queue.ts"
import { ExecutionRunUnresolvedError, settled, type ExecutionClaim, type ExecutionRecord } from "../hosts/run-state.ts"
import type { ExecutionReference, ExecutionRuntime, ExecutionReconciliation } from "../hosts/types.ts"
import { nativeObservedUsageCanonicalByteBound, type CliObservedUsage } from "../hosts/cli-transport.ts"
import { consumeOperatorDecision, type DecisionBinding, type OperatorDecision } from "../hosts/operator.ts"
import { ensureDurableDirectory } from "../state/durable.ts"
import { executionRunDirectory } from "../state/store.ts"
import {
  NATIVE_DATASET_LIMITS, NATIVE_SKILLOPT_LIMITS, NATIVE_WIKI_CONTRACT, NATIVE_PROTOCOL_SHA256, validateNativeDataset, type NativeDataset,
} from "./dataset.ts"
import {
  buildNativeCampaignSchedule, createNativeTrainerWireForSchedule,
  type NativeCampaignSchedule, type NativeTrainerWireRequest,
} from "./campaign-protocol.ts"
import { renderNativeEvaluationPrompt } from "./evaluation.ts"
import {
  consumeOwnedTrainerProtocolEvent,
  isGenuineCompletedQuiescentTrainerResult,
  type OwnedTrainerProtocolEvent,
  type OwnedWorkerResult,
  type OwnedTrainerProtocolLine,
  type SkillOptContainmentReceipt,
  type SkillOptWorkerProfile,
} from "./host.ts"
import {
  NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES,
  NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES,
} from "./trainer.ts"
import { assembleSkill, canonicalJson, readBoundedSource, sha256, PILOT_LIMITS } from "./pilot.ts"
import type { NativeSkillOptCompletedOptimizerWitness, NativeSkillOptCompletedTargetWitness } from "./broker.ts"
import {
  assertNativeRollbackAuthorizationCurrent, consumeNativeRollbackCanaryCommit, consumeNativeRollbackCanaryHandoff,
  readSkillOptNativeClock,
  type NativePromotionAuthorization, type NativeRollbackCanaryCommit, type NativeRollbackCanaryHandoff,
  type NativeRollbackCanaryHandoffReceipt, type PromotionCommon, type PromotionNativeHelperInput,
  type SkillOptNativeClockSample,
} from "./promotion.ts"
import { consumeNativeCampaignQualification, type NativeCampaignQualification } from "./campaign.ts"
import {
  consumeNativePromotionCanaryCommit,
  consumeNativePromotionCanaryHandoff,
  type NativePromotionCanaryCommit,
  type NativePromotionCanaryHandoff,
  type NativePromotionCanaryHandoffReceipt,
  type PromotionBindings,
} from "./promotion.ts"
export { NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES }

const SCHEMA_VERSION = 8
const APPLICATION_ID = 0x534b4f31
const DB_MODE = 0o600
const DIRECTORY_MODE = 0o700
const BUSY_TIMEOUT_MS = 250
const MAX_DB_BYTES = 8 * 1024 * 1024
const MAX_SNAPSHOT_DIGESTS = 500
const MIN_NEW_DIGESTS = 5
// The runner's NATIVE_REQUEST_MAX_BYTES and owned host's MAX_WORKER_MESSAGE_BYTES are both 512 KiB.
// Keep this defensive controller bound aligned with that frame contract; parsed protocol fields have
// their own smaller limits in createNativeTrainerWireForSchedule.
const MAX_NATIVE_TRAINER_PROTOCOL_FRAME_BYTES = 512 * 1024
const CONSENT_TTL_MS = 24n * 60n * 60n * 1000n
const APPLY_TTL_MS = 15n * 60n * 1000n
const RUN_TTL_MS = 7n * 24n * 60n * 60n * 1000n
const DAILY_COOLDOWN_NS = 24n * 60n * 60n * 1_000_000_000n
const WALL_CLOCK_TOLERANCE_MS = 5n * 60n * 1000n
const FINAL_SAFETY_RESERVE = 216
const CANARY_RESERVE = 16
const TARGET_RESERVE = FINAL_SAFETY_RESERVE + CANARY_RESERVE
// Reviewer final/safety capture is retained in memory; reserve its response and observed-usage ceiling before minting dispatch.
// The closed writer bounds are 32,768 response bytes + 191 canonical usage bytes = 32,959 bytes.
const NATIVE_REVIEWER_CAPTURE_RESERVATION_BYTES =
  NATIVE_DATASET_LIMITS.nativeResponseBytes + nativeObservedUsageCanonicalByteBound()
const CAMPAIGN_TARGET_REQUESTS = 432
const TARGET_REQUEST_CAP = 512
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/u
const HASH = /^[a-f0-9]{64}$/u
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u
const DIGEST_SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/u
const CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const REQUEST_ID = /^[0-9a-f-]{36}$/iu
const MAX_U64 = (1n << 64n) - 1n
const PILOT_SKILL = ".agents/skills/llm-wiki/SKILL.md"

export type SkillOptClockSample = SkillOptNativeClockSample
export type SkillOptRunState =
  | "DATA_REQUIRED" | "PREPARED" | "CONSENTED" | "ARMED" | "RESERVED" | "DISPATCH_PENDING"
  | "RUNNING" | "AWAITING_CANDIDATE_APPROVAL" | "AWAITING_ROLLBACK_CANARY" | "UNRESOLVED"
  | "COMPLETED" | "ROLLED_BACK" | "NO_GAIN" | "INCONCLUSIVE" | "FAILED"
  | "CANCELLED" | "EXPIRED" | "STALE" | "BLOCKED" | "RECOVERY_REQUIRED"
export type SkillOptRequestRole = "target" | "optimizer" | "reviewer"
export type SkillOptRequestPhase = "train" | "dev" | "final" | "safety" | "canary"
export type SkillOptReasonCode =
  | "data-required" | "storage-not-initialized" | "storage-missing" | "storage-corrupt" | "storage-permission"
  | "binding-invalid" | "binding-data-drift" | "binding-model-drift" | "binding-protocol-drift"
  | "binding-baseline-drift" | "owner-unavailable" | "admission-held" | "owner-busy" | "consent-required"
  | "consent-expired" | "consent-binding-drift" | "operator-rejected" | "arm-required" | "arm-expired"
  | "arm-consumed" | "digest-threshold" | "daily-limit" | "active-run" | "dispatch-pending"
  | "clock-invalid" | "clock-uncertain" | "budget-exhausted" | "run-expired" | "run-stale"
  | "qualification-required" | "canary-handoff-invalid" | "canary-runtime-mismatch"
  | "rollback-intent-invalid" | "rollback-approval-binding-mismatch" | "rollback-canary-handoff-invalid"
  | "dispatch-not-authorized" | "dispatch-ambiguous" | "dispatch-cancelled" | "recovery-unavailable" | "recovery-unresolved"
  | "revision-conflict" | "transaction-failed" | "private-text-cleanup-ineligible" | "private-text-cleanup-not-expired"

export type SkillOptRequestCounts = Readonly<{
  charged: Readonly<Record<SkillOptRequestRole, number>>
  dispatched: Readonly<Record<SkillOptRequestRole, number>>
  unknown: Readonly<Record<SkillOptRequestRole, number>>
}>
export type SkillOptTargetPhaseCounts = Readonly<Record<
  "trainingAndDevelopment" | "finalSafety" | "canary",
  Readonly<{ charged: number; dispatched: number; unknown: number }>
>>

export type SkillOptControllerStatus = Readonly<{
  state: SkillOptRunState
  reasonCode?: SkillOptReasonCode
  runId?: string
  revision: number
  pendingDispatch: boolean
  quotaKeySha256: string
  requestCounts: SkillOptRequestCounts
  targetPhaseCounts: SkillOptTargetPhaseCounts
  remaining: Readonly<{ target: number; optimizer: number; reviewer: number; activeMilliseconds: number; artifactBytes: number; candidateSteps: number }>
  dailyCooldownRemainingMilliseconds: number
}>

declare const skillOptReentryBrand: unique symbol
export type SkillOptReentryChallenge = Readonly<{
  runId: string
  persistedState: "PREPARED" | "CONSENTED" | "ARMED"
  expectedRevision: number
  scheduleSha256: string
  targetRequests: typeof CAMPAIGN_TARGET_REQUESTS
  canaryReserve: typeof CANARY_RESERVE
  targetRequestCap: typeof TARGET_REQUEST_CAP
  decisionBinding: DecisionBinding
  [skillOptReentryBrand]: true
}>
declare const privateTextCleanupChallengeBrand: unique symbol
export type SkillOptPrivateTextCleanupChallenge = Readonly<{ [privateTextCleanupChallengeBrand]: true }>
declare const privateTextCleanupDeletionBrand: unique symbol
export type SkillOptPrivateTextDeletion = Readonly<{ [privateTextCleanupDeletionBrand]: true }>
export type SkillOptPrivateTextCleanupMetadata = Readonly<{
  runId: string
  state: SkillOptRunState
  revision: number
  artifactsSha256: string
  artifactBytes: number
  expiresBoot: string
  expiresContinuousNanoseconds: string
  operation: "delete-private-experiment-text-only"
}>
export type SkillOptPrivateTextCleanupPreparation = Readonly<{
  challenge: SkillOptPrivateTextCleanupChallenge
  decisionBinding: DecisionBinding
  metadata: SkillOptPrivateTextCleanupMetadata
}>
export type SkillOptPrivateTextCleanupRetirement = Readonly<{
  retirementId: string
  runId: string
  state: SkillOptRunState
  revision: number
  artifactsSha256: string
  artifactBytes: number
  resumed: boolean
  retiredBoot: string
  retiredContinuousNanoseconds: string
  inputDeletion: SkillOptPrivateTextDeletion
  trainerDeletion?: SkillOptPrivateTextDeletion
}>

export function consumePrivateTextCleanupDeletion(
  token: SkillOptPrivateTextDeletion,
  expected: Readonly<{ worktree: string; runId: string; kind: "input" | "trainer"; snapshotSha256: string }>,
): void {
  const key = token && typeof token === "object" ? token as object : undefined
  const state = key ? privateTextCleanupDeletionTokens.get(key) : undefined
  if (!state || state.used) fail("consent-required")
  state.used = true
  privateTextCleanupDeletionTokens.delete(key!)
  if (!expected || typeof expected !== "object" || typeof expected.worktree !== "string" || !UUID.test(expected.runId) ||
      !(expected.kind === "input" || expected.kind === "trainer") || !asHash(expected.snapshotSha256)) fail("binding-invalid")
  const expectedRoot = canonicalRoot(expected.worktree)
  if (expectedRoot !== state.worktree || expected.runId !== state.runId || expected.kind !== state.kind ||
      expected.snapshotSha256 !== state.snapshotSha256) fail("consent-binding-drift")
  const proof = ownerProof(state.runtime, state.worktree, state.owner)
  assertMutationClaim(state.runtime, state.owner, state.mutationClaim)
  if (!isDeepStrictEqual(proof, state.ownerProof)) fail("owner-unavailable")
  state.ledger.assertPrivateTextCleanupDeletion({
    runId: state.runId, kind: state.kind, snapshotSha256: state.snapshotSha256,
    retirementId: state.retirementId, revision: state.revision, runState: state.runState,
    decisionSubjectHash: state.decisionSubjectHash, cleanupOwnerProof: state.ownerProof,
  })
  const currentProof = ownerProof(state.runtime, state.worktree, state.owner)
  assertMutationClaim(state.runtime, state.owner, state.mutationClaim)
  if (!isDeepStrictEqual(currentProof, state.ownerProof)) fail("owner-unavailable")
}
export type SkillOptRestoredStart =
  | Readonly<{ state: "CONSENTED"; revision: number; prepared: SkillOptPrepared; consent: SkillOptConsent }>
  | Readonly<{ state: "ARMED"; revision: number; prepared: SkillOptPrepared; consent: SkillOptConsent; arm: SkillOptArm }>

export type SkillOptPrepared = Readonly<{
  state: "PREPARED"
  runId: string
  campaignId: string
  scheduleSha256: string
  targetRequests: typeof CAMPAIGN_TARGET_REQUESTS
  canaryReserve: typeof CANARY_RESERVE
  targetRequestCap: typeof TARGET_REQUEST_CAP
  bindingSha256: string
  sourceExportSha256: string
  fixturePackSha256: string
  datasetSha256: string
  modelBindingsSha256: string
  modelBindings: NativeDataset["modelBindings"]
  protocolSha256: string
  baselineSkillSha256: string
  consentBindingSha256: string
  decisionBinding: DecisionBinding
}>

declare const nativeTrainerMaterializationAllowanceBrand: unique symbol
declare const nativeTrainerProtocolStageAllowanceBrand: unique symbol
export type SkillOptNativeTrainerMaterializationAllowance = Readonly<{
  [nativeTrainerMaterializationAllowanceBrand]: true
}>
export type SkillOptNativeTrainerProtocolStageAllowance = Readonly<{
  [nativeTrainerProtocolStageAllowanceBrand]: true
}>
export type SkillOptNativeTrainerMaterializationMetadata = Readonly<{
  runId: string
  rootBinding: string
  bindingSha256: string
  projectionSha256: string
  projectionBytes: number
  manifestSha256: string
  manifestBytes: number
}>

export type SkillOptNativeCampaignArtifactStage =
  | "fixture-preflight" | "target-static" | "adapter-response" | "trainer-rollout-ipc"
export type SkillOptNativeCampaignArtifactScheduleEntry =
  | Readonly<{ kind: "training" | "trainerSelection"; caseId: string; replicate: number }>
  | Readonly<{ kind: "qualification"; fixtureId: string; split: "dev" | "final" | "safety"; variant: "baseline" | "candidate"; repeat: number }>
export type SkillOptNativeCampaignArtifactStageMetadata = Readonly<{
  schema: "skillopt.native-campaign-artifact-stage.v1"
  stage: SkillOptNativeCampaignArtifactStage
  runId: string
  rootBinding: string
  bindingSha256: string
  scheduleSha256: string
  fixtureId: string
  scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry | null
  responseSha256: string | null
  planSha256: string
  bytes: number
}>
declare const nativeCampaignArtifactStageAllowanceBrand: unique symbol
export type SkillOptNativeCampaignArtifactStageAllowance = Readonly<{
  [nativeCampaignArtifactStageAllowanceBrand]: true
}>
declare const nativeCampaignTargetPlanBrand: unique symbol
declare const nativeCampaignTargetBindingBrand: unique symbol
declare const nativeCampaignTargetResponseBrand: unique symbol
declare const nativeTrainerOptimizerResponseAllowanceBrand: unique symbol
export type SkillOptNativeCampaignTargetPlan = Readonly<{ [nativeCampaignTargetPlanBrand]: true }>
export type SkillOptNativeCampaignTargetBinding = Readonly<{ [nativeCampaignTargetBindingBrand]: true }>
export type SkillOptNativeCampaignTargetResponse = Readonly<{ [nativeCampaignTargetResponseBrand]: true }>
export type SkillOptNativeTrainerOptimizerResponseAllowance = Readonly<{
  [nativeTrainerOptimizerResponseAllowanceBrand]: true
}>
export type SkillOptNativeTrainerOptimizerResponseMessage = Readonly<{
  schema: "skillopt.native-optimizer-response.v1"
  runId: string
  requestId: string
  role: "optimizer"
  phase: "train"
  ok: true
  text: string
  usage: CliObservedUsage | null
}>

declare const nativeTrainerProtocolCaptureBrand: unique symbol
declare const nativeTrainerProtocolEventBrand: unique symbol
export type SkillOptNativeTrainerProtocolCapture = Readonly<{ [nativeTrainerProtocolCaptureBrand]: true }>
export type SkillOptNativeTrainerProtocolEvent = Readonly<{ [nativeTrainerProtocolEventBrand]: true }>
export type SkillOptNativeTrainerProtocolEventDescription =
  | Readonly<{
      kind: "rollout"; runId: string; wireRequestId: string; ordinal: number
      cohort: "baseline-selection" | "training" | "candidate-selection"; split: "train" | "selection"
      caseId: string; replicate: number; fragment: string; fragmentSha256: string
    }>
  | Readonly<{
      kind: "optimizer"; runId: string; wireRequestId: string; ordinal: number
      stage: "analyst" | "merge" | "ranking"; prompt: string; promptSha256: string; requestedMaxCompletionTokens: number
    }>
export type SkillOptNativeTrainerProtocolCompletion = Readonly<{ fragment: string; candidateSha256: string }>

export type SkillOptConsent = Readonly<{
  state: "CONSENTED"
  runId: string
  consentId: string
  scheduleSha256: string
  targetRequests: typeof CAMPAIGN_TARGET_REQUESTS
  canaryReserve: typeof CANARY_RESERVE
  targetRequestCap: typeof TARGET_REQUEST_CAP
  subjectSha256: string
  expiresAtMilliseconds: string
}>

export type SkillOptArm = Readonly<{
  state: "ARMED"
  runId: string
  armId: string
  digestWatermarkSha256: string
  expiresAtMilliseconds: string
}>

declare const dispatchTicketBrand: unique symbol
declare const dispatchReceiptBrand: unique symbol
export type SkillOptDispatchTicket = Readonly<{ [dispatchTicketBrand]: true }>
export type SkillOptDispatchReceipt = Readonly<{ [dispatchReceiptBrand]: true }>
export type SkillOptDispatchGrant = Readonly<{
  runId: string
  reservationId: string
  requestId: string
  role: SkillOptRequestRole
  phase: SkillOptRequestPhase
  bindingSha256: string
  timeoutMilliseconds: number
}>
export type SkillOptReservation = Readonly<{
  runId: string
  reservationId: string
  requestId: string
  bindingSha256: string
  scheduleSha256: string
  role: SkillOptRequestRole
  phase: SkillOptRequestPhase
  charged: true
  ticket: SkillOptDispatchTicket
  receipt: SkillOptDispatchReceipt
}>
export type SkillOptAutomaticReadiness = Readonly<{
  state: "READY" | "BLOCKED"
  reasonCode?: SkillOptReasonCode
  newDigestCount: number
  requiredNewDigests: number
  dailyCooldownRemainingMilliseconds: number
  /** Permit the real reserveAutomatic transaction to establish the missing current-boot fence and refuse. */
  finalReservationRequired?: true
}>
declare const canaryPreparationBrand: unique symbol
export type SkillOptCanaryPreparation = Readonly<{
  runId: string
  handoffId: string
  candidateSha256: string
  bindings: PromotionBindings
  [canaryPreparationBrand]: true
}>
declare const rollbackIntentBrand: unique symbol
export type SkillOptRollbackIntent = Readonly<{ [rollbackIntentBrand]: true }>
declare const rollbackCanaryPreparationBrand: unique symbol
export type SkillOptRollbackCanaryPreparation = Readonly<{
  runId: string
  handoffId: string
  originalSha256: string
  bindings: PromotionBindings
  [rollbackCanaryPreparationBrand]: true
}>

type NativeCampaignQualificationBinding = Readonly<{
  runId: string
  bindingSha256: string
  scheduleSha256: string
  candidateSha256: string
  resultsSha256: string
  reviewSha256: string
}>
type NativePromotionCanaryHandoffBinding = NativePromotionCanaryHandoffReceipt
type NativeCanaryPreparationState = Readonly<{
  runId: string
  owner: SessionStore
  ownerProof: OwnerProof
  bindingHash: string
  scheduleSha256: string
  qualification: NativeCampaignQualificationBinding
  promotion: NativePromotionCanaryHandoffBinding
  consent: ConsentState
  used: { value: boolean }
  loader: { owner?: SessionStore; runtime?: ExecutionRuntime; proof?: OwnerProof; dispatchRecorded?: boolean; requestId?: string }
}>
type NativeRollbackIntentState = Readonly<{
  runId: string
  owner: SessionStore
  ownerProof: OwnerProof
  runtime: ExecutionRuntime
  bindingHash: string
  bindingHashes: ReturnType<typeof skillOptBindingHashes>
  scheduleSha256: string
  qualification: NativeCampaignQualificationBinding
  consent: ConsentState
  promotionSha256: string
  promotionBindings: PromotionBindings
  nativeAuthorization: NativePromotionAuthorization
  approvalRecordSha256: string
  sourceState: "COMPLETED" | "AWAITING_CANDIDATE_APPROVAL"
  used: { value: boolean }
}>
type NativeRollbackCanaryPreparationState = Readonly<{
  runId: string
  owner: SessionStore
  ownerProof: OwnerProof
  runtime: ExecutionRuntime
  bindingHash: string
  bindingHashes: ReturnType<typeof skillOptBindingHashes>
  scheduleSha256: string
  qualification: NativeCampaignQualificationBinding
  rollback: NativeRollbackCanaryHandoffReceipt
  consent: ConsentState
  intent: NativeRollbackIntentState
  used: { value: boolean }
  loader: { owner?: SessionStore; runtime?: ExecutionRuntime; proof?: OwnerProof; dispatchRecorded?: boolean; requestId?: string }
}>
function nativeLoadCanaryIntentMatches(input: Readonly<{
  record: ExecutionRecord
  requestId: string
  ownerSession: string
  generation: number
  root: string
  engine: string
  policyID: string
  hostDispatch: "started" | "not-started" | "either"
}>): boolean {
  const { record } = input
  return record.executionId === input.requestId && record.ownerSession === input.ownerSession &&
    record.generation === input.generation && record.role === "main" && record.taskId === `skillopt:target:canary:${input.requestId}` &&
    record.kind === "host" && record.nativeExecution === true && record.nativeLoadCanary === true &&
    (input.hostDispatch === "either" || (input.hostDispatch === "started" ? record.hostDispatch === "started" : record.hostDispatch === undefined)) &&
    record.cwd === input.root && record.engine === input.engine && record.profile === "legacy-unowned" &&
    record.controlProfile === "estimated-input-reactive-output-v1" && record.policyID === input.policyID &&
    typeof record.deadlineAt === "number" && Number.isSafeInteger(record.deadlineAt) && record.deadlineAt > 0 &&
    record.maxOutputChars === 32 * 1024
}
function nativeLoadCanaryPolicyID(
  runtime: ExecutionRuntime,
  preparation: NativeCanaryPreparationState | NativeRollbackCanaryPreparationState,
): string | undefined {
  const bindings = "rollback" in preparation ? preparation.rollback.bindings : preparation.promotion.bindings
  const policy = runtime.policy.resolve("main")
  if (policy.role !== "main" || !policy.model || policy.model.providerID !== bindings.nativeEngine ||
      policy.model.modelID !== bindings.nativeModel ||
      (bindings.nativeEngine === "codex"
        ? policy.nativeContext?.identity !== bindings.nativeProfileSha256
        : policy.nativeContext !== undefined)) return undefined
  return typeof policy.id === "string" && policy.id.length > 0 && policy.id.length <= 512 ? policy.id : undefined
}
type SkillOptDispatchObservation =
  | Readonly<{ state: "not-dispatched" }>
  | Readonly<{ state: "launched"; reference: ExecutionReference }>
  | Readonly<{ state: "ambiguous"; reference?: ExecutionReference }>

export type SkillOptPrepareInput = Readonly<{
  owner: SessionStore
  campaignId: string
  dataset?: unknown
  baselineSkillSha256?: string
}>
export type SkillOptCurrentBinding = Readonly<{ dataset: unknown; baselineSkillSha256: string }>

export type SkillOptQualifiedPublicationBinding = Readonly<{
  runId: string
  bindingSha256: string
  scheduleSha256: string
  baselineSkillSha256: string
  candidateSha256: string
  resultsSha256: string
  reviewSha256: string
  ownerSessionHash: string
  ownerEpochHash: string
  admissionHash: string
  expiresBoot: string
  expiresContinuousNanoseconds: string
  expiresWallMilliseconds: string
  remainingCanaryRequests: number
}>

/** Code-owned identity of one live native request; absent identity means recovery is unresolved. */
export type SkillOptNativeExecutionIdentity = Readonly<{
  engine: "codex" | "claude"
  profile: "legacy-unowned"
  controlProfile: "estimated-input-reactive-output-v1"
  policyID: string
  role: SkillOptRequestRole
  phase: SkillOptRequestPhase
}>
export type SkillOptNativeHost = Readonly<{
  identityFor(reference: ExecutionReference): SkillOptNativeExecutionIdentity | undefined
  reconcile(reference: ExecutionReference): Promise<ExecutionReconciliation>
  consumeCompletedTargetWitness(
    witness: NativeSkillOptCompletedTargetWitness,
    expected: Readonly<{ controller: SkillOptController; owner: SessionStore; reservation: SkillOptReservation }>,
  ): Readonly<{ promptSha256: string; responseSha256: string; responseBytes: number }>
  consumeCompletedOptimizerWitness(
    witness: NativeSkillOptCompletedOptimizerWitness,
    expected: Readonly<{ controller: SkillOptController; owner: SessionStore; reservation: SkillOptReservation }>,
  ): Readonly<{ promptSha256: string; responseSha256: string; responseBytes: number; usage: CliObservedUsage | null }>
}>

export type SkillOptController = Readonly<{
  initialize(): void
  status(): SkillOptControllerStatus
  prepare(input: SkillOptPrepareInput): SkillOptPrepared | Readonly<{ state: "DATA_REQUIRED"; reasonCode: "data-required" }>
  preparePrivateTextCleanup(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; mutationClaim: ExecutionClaim; runId: string
    artifactsSha256: string; artifactBytes: number; trainerSnapshotSha256: string | null
  }>): SkillOptPrivateTextCleanupPreparation
  retirePrivateTextCleanup(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; mutationClaim: ExecutionClaim
    challenge: SkillOptPrivateTextCleanupChallenge; decision: OperatorDecision
  }>): SkillOptPrivateTextCleanupRetirement
  reserveNativePreparationArtifacts(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; runId: string; current: SkillOptCurrentBinding; bytes: number
  }>): SkillOptControllerStatus
  reserveNativeTrainerMaterialization(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
    materialization: SkillOptNativeTrainerMaterializationMetadata
  }>): SkillOptNativeTrainerMaterializationAllowance
  consumeNativeTrainerMaterializationAllowance(
    allowance: SkillOptNativeTrainerMaterializationAllowance,
    input: Readonly<{
      owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
      materialization: SkillOptNativeTrainerMaterializationMetadata
    }>,
  ): SkillOptNativeTrainerProtocolStageAllowance
  reserveNativeCampaignArtifactStage(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
    metadata: SkillOptNativeCampaignArtifactStageMetadata
    trainerEvent?: SkillOptNativeTrainerProtocolEvent
    reservation?: SkillOptReservation
    targetPlan?: SkillOptNativeCampaignTargetPlan
    target?: SkillOptNativeCampaignTargetResponse
  }>): SkillOptNativeCampaignArtifactStageAllowance
  consumeNativeCampaignArtifactStage(
    allowance: SkillOptNativeCampaignArtifactStageAllowance,
    input: Readonly<{
      owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
      metadata: SkillOptNativeCampaignArtifactStageMetadata
      trainerEvent?: SkillOptNativeTrainerProtocolEvent
      reservation?: SkillOptReservation
      targetPlan?: SkillOptNativeCampaignTargetPlan
      target?: SkillOptNativeCampaignTargetResponse
    }>,
  ): void
  prepareNativeCampaignTarget(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
    scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry
    trainerEvent?: SkillOptNativeTrainerProtocolEvent
  }>): SkillOptNativeCampaignTargetPlan
  bindNativeCampaignTargetReservation(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
    targetPlan: SkillOptNativeCampaignTargetPlan; reservation: SkillOptReservation
  }>): SkillOptNativeCampaignTargetBinding
  admitNativeCampaignTargetResponse(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
    target: SkillOptNativeCampaignTargetBinding; targetWitness: NativeSkillOptCompletedTargetWitness
  }>): SkillOptNativeCampaignTargetResponse
  associateNativeTrainerWarmupTarget(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
    event: SkillOptNativeTrainerProtocolEvent; target: SkillOptNativeCampaignTargetResponse
  }>): void
  reserveNativeTrainerOptimizerResponse(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
    event: SkillOptNativeTrainerProtocolEvent; reservation: SkillOptReservation
    optimizerWitness: NativeSkillOptCompletedOptimizerWitness; responseText: string
  }>): SkillOptNativeTrainerOptimizerResponseAllowance
  consumeNativeTrainerOptimizerResponse(
    allowance: SkillOptNativeTrainerOptimizerResponseAllowance,
    input: Readonly<{
      owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
      event: SkillOptNativeTrainerProtocolEvent; reservation: SkillOptReservation
    }>,
  ): SkillOptNativeTrainerOptimizerResponseMessage
  openNativeTrainerProtocolCapture(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
    trainer: Readonly<{ profile: SkillOptWorkerProfile; receipt: SkillOptContainmentReceipt }>
  }>): SkillOptNativeTrainerProtocolCapture
  consumeNativeTrainerProtocolEvent(
    capture: SkillOptNativeTrainerProtocolCapture,
    input: Readonly<{
      owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
      event: OwnedTrainerProtocolEvent
    }>,
  ): SkillOptNativeTrainerProtocolEvent
  describeNativeTrainerProtocolEvent(event: SkillOptNativeTrainerProtocolEvent): SkillOptNativeTrainerProtocolEventDescription
  completeNativeTrainerProtocolCapture(
    capture: SkillOptNativeTrainerProtocolCapture,
    input: Readonly<{ owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding;
      result: OwnedWorkerResult }>,
  ): SkillOptNativeTrainerProtocolCompletion
  reserveNativeTrainerSelectionTarget(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
    event: SkillOptNativeTrainerProtocolEvent
  }>): SkillOptReservation
  prepareReentry(input: Readonly<{ owner: SessionStore; runId: string; current: SkillOptCurrentBinding }>): SkillOptReentryChallenge
  acceptReentry(challenge: SkillOptReentryChallenge, receipt: OperatorDecision, current: SkillOptCurrentBinding): SkillOptRestoredStart
  consent(prepared: SkillOptPrepared, receipt: OperatorDecision, current: SkillOptCurrentBinding): SkillOptConsent
  arm(prepared: SkillOptPrepared, consent: SkillOptConsent, current: SkillOptCurrentBinding): SkillOptArm
  automaticReadiness(input: Readonly<{
    owner: SessionStore; prepared: SkillOptPrepared; consent: SkillOptConsent; arm: SkillOptArm; current: SkillOptCurrentBinding
  }>): SkillOptAutomaticReadiness
  disarm(owner: SessionStore, runId: string): SkillOptControllerStatus
  cancelUnstarted(owner: SessionStore, runId: string): SkillOptControllerStatus
  reserveAutomatic(input: Readonly<{
    owner: SessionStore; prepared: SkillOptPrepared; consent: SkillOptConsent; arm: SkillOptArm; current: SkillOptCurrentBinding
  }>): SkillOptReservation
  reserveManual(input: Readonly<{
    owner: SessionStore; prepared: SkillOptPrepared; consent: SkillOptConsent; current: SkillOptCurrentBinding
  }>): SkillOptReservation
  reserveRequest(input: Readonly<{
    owner: SessionStore; runId: string; current: SkillOptCurrentBinding; role: SkillOptRequestRole; phase: SkillOptRequestPhase
    trainerEvent?: SkillOptNativeTrainerProtocolEvent
  }>): SkillOptReservation
  consumeDispatch(owner: SessionStore, ticket: SkillOptDispatchTicket, current: SkillOptCurrentBinding): SkillOptDispatchGrant
  recordDispatch(owner: SessionStore, receipt: SkillOptDispatchReceipt, observation: SkillOptDispatchObservation): SkillOptControllerStatus
  recover(owner: SessionStore, runId: string): Promise<SkillOptControllerStatus>
  awaitCandidateApproval(owner: SessionStore, runId: string, current: SkillOptCurrentBinding, qualification: NativeCampaignQualification): SkillOptControllerStatus
  assertQualifiedPublication(input: Readonly<{
    owner: SessionStore
    runId: string
    current: SkillOptCurrentBinding
    candidateSha256: string
    resultsSha256: string
    reviewSha256: string
    mutationClaim?: ExecutionClaim
  }>): SkillOptQualifiedPublicationBinding
  reserveNativePublicationArtifacts(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; runId: string; current: SkillOptCurrentBinding
    operation: "apply" | "rollback"; mutationClaim?: ExecutionClaim; bytes: number; headroomBytes: number
  }>): SkillOptControllerStatus
  nativeRollbackEligibility(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; runId: string; current: SkillOptCurrentBinding
    mutationClaim?: ExecutionClaim
  }>): Readonly<{ state: "ELIGIBLE" | "BLOCKED"; reasonCode?: SkillOptReasonCode }>
  prepareNativeCanary(owner: SessionStore, runId: string, current: SkillOptCurrentBinding, handoff: NativePromotionCanaryHandoff): SkillOptCanaryPreparation
  reserveNativeCanary(input: Readonly<{
    preparation: SkillOptCanaryPreparation; loaderOwner: SessionStore; loaderRuntime: ExecutionRuntime; current: SkillOptCurrentBinding
  }>): SkillOptReservation
  consumeNativeCanaryDispatch(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; claim: ExecutionClaim; ticket: SkillOptDispatchTicket; current: SkillOptCurrentBinding
  }>): SkillOptDispatchGrant
  cancelNativeCanaryBeforeClaim(input: Readonly<{
    owner: SessionStore; loaderOwner: SessionStore; reservation: SkillOptReservation; current: SkillOptCurrentBinding
  }>): SkillOptControllerStatus
  recordNativeCanaryDispatch(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; claim: ExecutionClaim; receipt: SkillOptDispatchReceipt; observation: SkillOptDispatchObservation
  }>): SkillOptControllerStatus
  settleNativeCanary(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; claim: ExecutionClaim; runId: string; requestId: string
    reconciliation: ExecutionReconciliation
  }>): SkillOptControllerStatus
  recordNativeCanaryArtifact(owner: SessionStore, runId: string, bytes: number): SkillOptControllerStatus
  completeNativeCanary(input: Readonly<{
    owner: SessionStore; loaderOwner: SessionStore; runId: string; current: SkillOptCurrentBinding
    commit: NativePromotionCanaryCommit
  }>): SkillOptControllerStatus
  beginNativeRollback(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; mutationClaim: ExecutionClaim; runId: string
    current: SkillOptCurrentBinding; promotion: PromotionCommon
    nativeAuthorization: NativePromotionAuthorization
  }>): SkillOptRollbackIntent
  prepareNativeRollbackCanary(input: Readonly<{
    owner: SessionStore; runId: string; current: SkillOptCurrentBinding; intent: SkillOptRollbackIntent
    handoff: NativeRollbackCanaryHandoff; promotion: PromotionCommon
  }>): SkillOptRollbackCanaryPreparation
  reserveNativeRollbackCanary(input: Readonly<{
    preparation: SkillOptRollbackCanaryPreparation; loaderOwner: SessionStore; loaderRuntime: ExecutionRuntime
    current: SkillOptCurrentBinding
  }>): SkillOptReservation
  markNativeRollbackUnresolved(owner: SessionStore, runId: string, reasonCode: string): SkillOptControllerStatus
  recordNativeRollbackCanaryArtifact(owner: SessionStore, runId: string, bytes: number): SkillOptControllerStatus
  completeNativeRollbackCanary(input: Readonly<{
    owner: SessionStore; loaderOwner: SessionStore; runId: string; current: SkillOptCurrentBinding
    commit: NativeRollbackCanaryCommit
  }>): SkillOptControllerStatus
  finish(owner: SessionStore, runId: string, state: "NO_GAIN" | "INCONCLUSIVE" | "FAILED" | "CANCELLED"): SkillOptControllerStatus
  recordArtifactBytes(owner: SessionStore, runId: string, bytes: number): SkillOptControllerStatus
  reserveCandidateStep(owner: SessionStore, runId: string): SkillOptControllerStatus
}>

export type EligibleDigest = Readonly<{ sessionID: string; endedAt: number; sessionIDHash: string }>
export type EligibleDigestSnapshot = Readonly<{ digests: readonly EligibleDigest[]; watermarkSha256: string }>
export type SkillOptTestArmedSeed = Readonly<{
  runId: string; bindingHash: string; consentId: string; armId: string; expectedRevision?: number
  seenDigestHashes?: readonly string[]; clock?: SkillOptClockSample
  initialUsage?: Readonly<{ targetRequests?: number; optimizerRequests?: number; reviewerRequests?: number; finalSafetyRequests?: number; canaryRequests?: number }>
}>
export type SkillOptTestReservationInput = Readonly<{
  runId: string; consentId: string; armId: string; bindingHash: string; newDigestHashes: readonly string[]
  expectedRevision: number; ownerSessionHash?: string; ownerEpochHash?: string; admissionHash?: string
  fault?: (point: SkillOptTestFaultPoint) => void
}>
export type SkillOptTestFaultPoint = "after-arm-consume" | "after-attempt-insert" | "after-counter-charge" | "before-commit" | "after-commit"

export class SkillOptControllerError extends Error {
  constructor(readonly code: SkillOptReasonCode) {
    super(code)
    this.name = "SkillOptControllerError"
  }
}

function fail(code: SkillOptReasonCode): never {
  throw new SkillOptControllerError(code)
}

function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined
}

function canonicalRoot(path: string): string {
  try { return realpathSync.native(path) } catch { fail("owner-unavailable") }
}

function fixedAuthorityPath(worktree: string): { databasePath: string; rootBinding: string; quotaKey: string } {
  const root = canonicalRoot(worktree)
  const key = sha256(canonicalJson({ schema: "skillopt.automation-quota-key.v1", root, target: PILOT_SKILL }))
  const databasePath = join(dirname(executionRunDirectory(root)), "skillopt", "automation", "ledger.sqlite")
  return { databasePath, rootBinding: sha256(root), quotaKey: key }
}

function asHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function validNativeTrainerMaterializationMetadata(value: unknown): value is SkillOptNativeTrainerMaterializationMetadata {
  return isRecord(value) && hasExactKeys(value, ["runId", "rootBinding", "bindingSha256", "projectionSha256", "projectionBytes",
    "manifestSha256", "manifestBytes"]) && typeof value.runId === "string" && UUID.test(value.runId) && asHash(value.rootBinding) &&
    asHash(value.bindingSha256) && asHash(value.projectionSha256) && Number.isSafeInteger(value.projectionBytes) &&
    Number(value.projectionBytes) > 0 && Number(value.projectionBytes) <= NATIVE_DATASET_LIMITS.trainerInputBytes &&
    asHash(value.manifestSha256) && Number.isSafeInteger(value.manifestBytes) && Number(value.manifestBytes) > 0 &&
    Number(value.manifestBytes) <= 64 * 1024
}

function copyExactDataProperties(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  try {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== expectedKeys.length || ownKeys.some(key => typeof key !== "string" || !expectedKeys.includes(key))) {
      return undefined
    }
    const copy: Record<string, unknown> = Object.create(null)
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) return undefined
      copy[key] = descriptor.value
    }
    return copy
  } catch { return undefined }
}

function copyNativeOptimizerUsage(value: unknown): CliObservedUsage | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const allowed = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationTokens", "reportedCostUsd"] as const
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined
    const keys = Reflect.ownKeys(value)
    if (keys.length < 1 || keys.some(key => typeof key !== "string" || !allowed.includes(key as typeof allowed[number]))) {
      return undefined
    }
    const copy: { -readonly [K in keyof CliObservedUsage]?: CliObservedUsage[K] } = {}
    for (const key of keys as (typeof allowed[number])[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) return undefined
      const field = descriptor.value
      if (key === "reportedCostUsd") {
        if (typeof field !== "number" || !Number.isFinite(field) || field < 0) return undefined
        copy.reportedCostUsd = field
      } else if (!isNonNegativeSafeInteger(field)) return undefined
      else if (key === "inputTokens") copy.inputTokens = field
      else if (key === "outputTokens") copy.outputTokens = field
      else if (key === "cachedInputTokens") copy.cachedInputTokens = field
      else copy.cacheCreationTokens = field
    }
    return Object.freeze(copy)
  } catch { return undefined }
}

function normalizeNativeCampaignArtifactScheduleEntry(value: unknown): SkillOptNativeCampaignArtifactScheduleEntry | null | undefined {
  if (value === null) return null
  const header = copyExactDataProperties(value, ["kind", "caseId", "replicate"])
  if (header && (header.kind === "training" || header.kind === "trainerSelection") &&
      typeof header.caseId === "string" && header.caseId.length > 0 && header.caseId.length <= 128 &&
      !/[\u0000-\u001f\u007f]/u.test(header.caseId) && Number.isSafeInteger(header.replicate) &&
      Number(header.replicate) >= 0) {
    return Object.freeze({ kind: header.kind, caseId: header.caseId, replicate: Number(header.replicate) })
  }
  const qualification = copyExactDataProperties(value, ["kind", "fixtureId", "split", "variant", "repeat"])
  if (qualification?.kind === "qualification" && typeof qualification.fixtureId === "string" &&
      qualification.fixtureId.length > 0 && qualification.fixtureId.length <= 128 &&
      !/[\u0000-\u001f\u007f]/u.test(qualification.fixtureId) &&
      (qualification.split === "dev" || qualification.split === "final" || qualification.split === "safety") &&
      (qualification.variant === "baseline" || qualification.variant === "candidate") &&
      Number.isSafeInteger(qualification.repeat) && Number(qualification.repeat) >= 0) {
    return Object.freeze({ kind: "qualification", fixtureId: qualification.fixtureId, split: qualification.split,
      variant: qualification.variant, repeat: Number(qualification.repeat) })
  }
  return undefined
}

function normalizeNativeCampaignArtifactStageMetadata(value: unknown): SkillOptNativeCampaignArtifactStageMetadata | undefined {
  const metadata = copyExactDataProperties(value, ["schema", "stage", "runId", "rootBinding", "bindingSha256", "scheduleSha256",
    "fixtureId", "scheduleEntry", "responseSha256", "planSha256", "bytes"])
  if (!metadata || metadata.schema !== "skillopt.native-campaign-artifact-stage.v1" ||
      !(metadata.stage === "fixture-preflight" || metadata.stage === "target-static" ||
        metadata.stage === "adapter-response" || metadata.stage === "trainer-rollout-ipc") ||
      typeof metadata.runId !== "string" || !UUID.test(metadata.runId) || !asHash(metadata.rootBinding) ||
      !asHash(metadata.bindingSha256) || !asHash(metadata.scheduleSha256) || typeof metadata.fixtureId !== "string" ||
      metadata.fixtureId.length === 0 || metadata.fixtureId.length > 128 || /[\u0000-\u001f\u007f]/u.test(metadata.fixtureId) ||
      !asHash(metadata.planSha256) || !Number.isSafeInteger(metadata.bytes) || Number(metadata.bytes) < 1 ||
      Number(metadata.bytes) > NATIVE_SKILLOPT_LIMITS.artifactBytes) return undefined
  const scheduleEntry = normalizeNativeCampaignArtifactScheduleEntry(metadata.scheduleEntry)
  if (scheduleEntry === undefined) return undefined
  const responseRequired = metadata.stage === "adapter-response" || metadata.stage === "trainer-rollout-ipc"
  if (metadata.stage === "fixture-preflight" ? scheduleEntry !== null : scheduleEntry === null) return undefined
  if (responseRequired ? !asHash(metadata.responseSha256) : metadata.responseSha256 !== null) return undefined
  return Object.freeze({
    schema: "skillopt.native-campaign-artifact-stage.v1", stage: metadata.stage, runId: metadata.runId,
    rootBinding: metadata.rootBinding, bindingSha256: metadata.bindingSha256, scheduleSha256: metadata.scheduleSha256,
    fixtureId: metadata.fixtureId, scheduleEntry, responseSha256: metadata.responseSha256 as string | null,
    planSha256: metadata.planSha256, bytes: Number(metadata.bytes),
  })
}

const TRAINER_PROTOCOL_EVENT_ROW_KEYS = ["run_id", "wire_request_id", "worker_profile_sha256", "receipt_binding_sha256", "ordinal", "raw_line_sha256",
  "kind", "cohort", "case_id", "replicate", "fragment_sha256", "optimizer_stage", "prompt_sha256"] as const
function isStoredTrainerProtocolEventRow(value: unknown): value is NativeTrainerProtocolEventRow {
  if (!isRecord(value) || !hasExactKeys(value, TRAINER_PROTOCOL_EVENT_ROW_KEYS) || typeof value.run_id !== "string" ||
      !UUID.test(value.run_id) || typeof value.wire_request_id !== "string" || value.wire_request_id.length > 192 ||
      /[\u0000-\u001f\u007f]/u.test(value.wire_request_id) || !asHash(value.worker_profile_sha256) ||
      !asHash(value.receipt_binding_sha256) ||
      !isNonNegativeSafeInteger(value.ordinal) || value.ordinal < 1 || !asHash(value.raw_line_sha256)) return false
  if (value.kind === "rollout") {
    return (value.cohort === "baseline-selection" || value.cohort === "training" || value.cohort === "candidate-selection") &&
      typeof value.case_id === "string" && value.case_id.length > 0 && value.case_id.length <= 128 &&
      !/[\u0000-\u001f\u007f]/u.test(value.case_id) && isNonNegativeSafeInteger(value.replicate) &&
      asHash(value.fragment_sha256) && value.optimizer_stage === null && value.prompt_sha256 === null
  }
  return value.kind === "optimizer" && value.cohort === null && value.case_id === null && value.replicate === null &&
    value.fragment_sha256 === null && (value.optimizer_stage === "analyst" || value.optimizer_stage === "merge" ||
      value.optimizer_stage === "ranking") && asHash(value.prompt_sha256)
}

function trainerProtocolEventRowMatches(row: NativeTrainerProtocolEventRow, expected: NativeTrainerProtocolEventBinding): boolean {
  return row.run_id === expected.runId && row.wire_request_id === expected.wireRequestId &&
    row.worker_profile_sha256 === expected.workerProfileSha256 && row.receipt_binding_sha256 === expected.receiptBindingSha256 &&
    row.ordinal === expected.ordinal &&
    row.raw_line_sha256 === expected.rawLineSha256 && row.kind === expected.kind && row.cohort === expected.cohort &&
    row.case_id === expected.caseId && row.replicate === expected.replicate && row.fragment_sha256 === expected.fragmentSha256 &&
    row.optimizer_stage === expected.optimizerStage && row.prompt_sha256 === expected.promptSha256
}

function assertTrainerProtocolArtifactEvidence(
  db: Database,
  input: Readonly<{
    runId: string
    event?: NativeTrainerProtocolEventBinding
    reservation?: Readonly<{ requestId: string; reservationId: string; role: SkillOptRequestRole; phase: SkillOptRequestPhase }>
    requireAssociation?: boolean
    requireUnassociated?: boolean
  }>,
): void {
  if (input.event) {
    const rowValue = db.query("SELECT * FROM trainer_protocol_events WHERE run_id=? AND wire_request_id=?")
      .get(input.runId, input.event.wireRequestId) as unknown
    if (!isStoredTrainerProtocolEventRow(rowValue) || !trainerProtocolEventRowMatches(rowValue, input.event)) fail("dispatch-not-authorized")
  }
  const association = input.event
    ? db.query("SELECT native_request_id FROM trainer_protocol_dispatches WHERE run_id=? AND wire_request_id=?")
      .get(input.runId, input.event.wireRequestId) as { native_request_id: string } | undefined
    : undefined
  if (input.requireUnassociated && association) fail("dispatch-not-authorized")
  if (input.requireAssociation && (!input.event || !association)) fail("dispatch-not-authorized")
  if (input.requireAssociation && association && input.reservation?.requestId !== association.native_request_id) {
    fail("dispatch-not-authorized")
  }
  if (input.reservation) {
    const request = db.query(`SELECT request_id,run_id,reservation_id,role,phase,dispatch_state,actual_dispatch
      FROM requests WHERE request_id=? AND run_id=?`).get(input.reservation.requestId, input.runId) as Record<string, unknown> | undefined
    if (!request || request.request_id !== input.reservation.requestId || request.reservation_id !== input.reservation.reservationId ||
        request.role !== input.reservation.role || request.phase !== input.reservation.phase ||
        request.dispatch_state !== "settled" || request.actual_dispatch !== 1) fail("dispatch-not-authorized")
    if (input.event) {
      if (input.event.kind === "optimizer") {
        if (input.reservation.role !== "optimizer" || input.reservation.phase !== "train") fail("dispatch-not-authorized")
      } else {
        const phase = input.event.cohort === "training" ? "train" : "dev"
        if (input.reservation.role !== "target" || input.reservation.phase !== phase) fail("dispatch-not-authorized")
      }
    }
  }
}

function nativeTrainerProtocolEventBinding(
  request: NativeTrainerWireRequest,
  line: OwnedTrainerProtocolLine,
): NativeTrainerProtocolEventBinding {
  if (request.kind === "rollout") {
    return Object.freeze({ runId: request.runId, wireRequestId: request.requestId, workerProfileSha256: line.profileSha256,
      receiptBindingSha256: line.receiptBindingSha256, ordinal: request.ordinal, rawLineSha256: line.rawLineSha256,
      kind: "rollout", cohort: request.cohort,
      caseId: request.caseId, replicate: request.replicate, fragmentSha256: request.fragmentSha256,
      optimizerStage: null, promptSha256: null })
  }
  return Object.freeze({ runId: request.runId, wireRequestId: request.requestId, workerProfileSha256: line.profileSha256,
    receiptBindingSha256: line.receiptBindingSha256, ordinal: request.ordinal, rawLineSha256: line.rawLineSha256,
    kind: "optimizer", cohort: null,
    caseId: null, replicate: null, fragmentSha256: null, optimizerStage: request.stage,
    promptSha256: sha256(Buffer.from(request.prompt, "utf8")) })
}

function nativeTrainerProtocolDescription(request: NativeTrainerWireRequest): SkillOptNativeTrainerProtocolEventDescription {
  if (request.kind === "rollout") return Object.freeze({ kind: "rollout", runId: request.runId,
    wireRequestId: request.requestId, ordinal: request.ordinal, cohort: request.cohort, split: request.split,
    caseId: request.caseId, replicate: request.replicate, fragment: request.fragment, fragmentSha256: request.fragmentSha256 })
  return Object.freeze({ kind: "optimizer", runId: request.runId, wireRequestId: request.requestId,
    ordinal: request.ordinal, stage: request.stage, prompt: request.prompt,
    promptSha256: sha256(Buffer.from(request.prompt, "utf8")), requestedMaxCompletionTokens: request.requestedMaxCompletionTokens })
}

function scheduleEntryBindsFixture(
  entry: SkillOptNativeCampaignArtifactScheduleEntry,
  fixtureId: string,
  schedule: NativeCampaignSchedule,
): boolean {
  if (entry.kind === "qualification") {
    return entry.fixtureId === fixtureId && schedule.qualification.some(item => item.fixtureId === entry.fixtureId &&
      item.split === entry.split && item.variant === entry.variant && item.repeat === entry.repeat)
  }
  const entries = entry.kind === "training" ? schedule.training : schedule.trainerSelection
  return entry.caseId === fixtureId && entries.some(item => item.caseId === entry.caseId && item.replicate === entry.replicate)
}

type CampaignDisclosure = Readonly<{
  scheduleSha256: string
  targetRequests: typeof CAMPAIGN_TARGET_REQUESTS
  canaryReserve: typeof CANARY_RESERVE
  targetRequestCap: typeof TARGET_REQUEST_CAP
}>

function campaignDisclosure(dataset: NativeDataset): CampaignDisclosure {
  let schedule: ReturnType<typeof buildNativeCampaignSchedule>
  try { schedule = buildNativeCampaignSchedule(dataset.fixturePack) } catch { fail("data-required") }
  if (schedule.targetRequests !== CAMPAIGN_TARGET_REQUESTS || schedule.canaryReserve !== CANARY_RESERVE ||
      NATIVE_SKILLOPT_LIMITS.targetRequests !== TARGET_REQUEST_CAP) fail("binding-protocol-drift")
  return campaignDisclosureForHash(schedule.scheduleSha256)
}

function campaignDisclosureForHash(scheduleSha256: string): CampaignDisclosure {
  if (!asHash(scheduleSha256)) fail("storage-corrupt")
  return Object.freeze({
    scheduleSha256,
    targetRequests: CAMPAIGN_TARGET_REQUESTS,
    canaryReserve: CANARY_RESERVE,
    targetRequestCap: TARGET_REQUEST_CAP,
  })
}

function boundedClockDecimal(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !DECIMAL.test(value)) return undefined
  try {
    const result = BigInt(value)
    return result <= MAX_U64 ? result : undefined
  } catch { return undefined }
}

function validatedClock(value: unknown): SkillOptClockSample {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("clock-invalid")
  const sample = value as Record<string, unknown>
  if (Object.keys(sample).length !== 5 || sample.protocol !== "skillopt-promotion.v3" ||
      (sample.platform !== "darwin" && sample.platform !== "linux") ||
      typeof sample.bootId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sample.bootId) ||
      boundedClockDecimal(sample.continuousNanoseconds) === undefined || boundedClockDecimal(sample.wallMilliseconds) === undefined) {
    fail("clock-invalid")
  }
  return sample as SkillOptClockSample
}

function digestPathIsRelevant(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.includes("\0") || path.startsWith("/")) return false
  if (path === PILOT_SKILL) return true
  if (!path.startsWith("knowledge/")) return false
  const pieces = path.split("/")
  return pieces.every((piece) => piece.length > 0 && piece !== "." && piece !== "..")
}

/** Metadata-only selection. It never reads or replays a transcript and returns no digest fields other than ID/time. */
export function eligibleSkillOptDigests(values: readonly SessionDigest[]): EligibleDigestSnapshot {
  if (!Array.isArray(values)) return { digests: [], watermarkSha256: sha256("[]") }
  const eligible = new Map<string, EligibleDigest>()
  for (const value of values) {
    if (!value || typeof value !== "object" || value.complete !== true || value.outcome !== "completed" ||
        typeof value.sessionID !== "string" || !DIGEST_SESSION_ID.test(value.sessionID) ||
        !Number.isSafeInteger(value.endedAt) || value.endedAt < 0 ||
        !Array.isArray(value.files) || !value.files.some(digestPathIsRelevant)) continue
    const item = { sessionID: value.sessionID, endedAt: value.endedAt, sessionIDHash: sha256(value.sessionID) }
    const old = eligible.get(value.sessionID)
    if (!old || item.endedAt > old.endedAt) eligible.set(value.sessionID, item)
  }
  const digests = [...eligible.values()].sort((a, b) => a.endedAt - b.endedAt || a.sessionID.localeCompare(b.sessionID)).slice(-MAX_SNAPSHOT_DIGESTS)
  return { digests, watermarkSha256: sha256(canonicalJson(digests.map(({ sessionIDHash, endedAt }) => [sessionIDHash, endedAt]))) }
}

function newDigestsSinceArm(snapshot: EligibleDigestSnapshot, seenHashes: ReadonlySet<string>, armedAtWall: bigint): EligibleDigest[] {
  return snapshot.digests.filter((digest) => !seenHashes.has(digest.sessionIDHash) && BigInt(digest.endedAt) > armedAtWall)
}

export function skillOptBindingHashes(worktree: string, datasetInput: unknown, baselineSkillSha256: string): Readonly<{
  bindingSha256: string; datasetSha256: string; dataSha256: string; modelBindingsSha256: string; protocolSha256: string; baselineSkillSha256: string
}> {
  if (!asHash(baselineSkillSha256)) fail("binding-invalid")
  let dataset: NativeDataset
  try { dataset = validateNativeDataset(worktree, datasetInput) } catch { fail("binding-invalid") }
  if (dataset.contract !== NATIVE_WIKI_CONTRACT || dataset.status !== "STRUCTURALLY_VALID" ||
      dataset.protocolSha256 !== NATIVE_PROTOCOL_SHA256 || !asHash(dataset.datasetSha256) ||
      !asHash(dataset.sourceExportSha256) || !asHash(dataset.fixturePackSha256)) fail("data-required")
  const modelBindingsSha256 = sha256(canonicalJson(dataset.modelBindings))
  const dataSha256 = sha256(canonicalJson({ sourceExportSha256: dataset.sourceExportSha256, fixturePackSha256: dataset.fixturePackSha256 }))
  const bindingSha256 = sha256(canonicalJson({
    contract: NATIVE_WIKI_CONTRACT,
    datasetSha256: dataset.datasetSha256,
    dataSha256,
    modelBindingsSha256,
    protocolSha256: dataset.protocolSha256,
    baselineSkillSha256,
  }))
  return { bindingSha256, datasetSha256: dataset.datasetSha256, dataSha256, modelBindingsSha256, protocolSha256: dataset.protocolSha256, baselineSkillSha256 }
}

type ClockValues = { boot: string; continuous: bigint; wall: bigint; platform: "darwin" | "linux" }
function clockValues(sample: SkillOptClockSample): ClockValues {
  const valid = validatedClock(sample)
  return { boot: valid.bootId, continuous: BigInt(valid.continuousNanoseconds), wall: BigInt(valid.wallMilliseconds), platform: valid.platform }
}

function failSqlite(error: unknown): never {
  const c = codeOf(error)
  if (c === "ENOENT") fail("storage-missing")
  if (c === "EACCES" || c === "EPERM" || c === "EROFS") fail("storage-permission")
  if (c === "SQLITE_BUSY" || c === "SQLITE_LOCKED") fail("transaction-failed")
  fail("storage-corrupt")
}

function privateDirectory(path: string): void {
  let st: ReturnType<typeof lstatSync>
  try { st = lstatSync(path) } catch (error) {
    if (codeOf(error) === "ENOENT") fail("storage-not-initialized")
    fail("storage-permission")
  }
  const uid = process.geteuid?.()
  if (st.isSymbolicLink() || !st.isDirectory() || uid === undefined || st.uid !== uid || (st.mode & 0o777) !== DIRECTORY_MODE) fail("storage-permission")
}

function securePathComponents(path: string): void {
  const absolute = resolve(path)
  const root = absolute.startsWith("/") ? "/" : ""
  let current = root
  for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part)
    try {
      const st = lstatSync(current)
      if (st.isSymbolicLink()) fail("storage-permission")
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error
      break
    }
  }
}

const PRIVATE_TEXT_CLEANUP_TABLE_SQL = `
  CREATE TABLE private_cleanup_retirements (
    retirement_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
    previous_retirement_id TEXT REFERENCES private_cleanup_retirements(retirement_id),
    artifacts_sha256 TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation='delete-private-experiment-text-only'),
    root_binding TEXT NOT NULL, quota_key TEXT NOT NULL, run_state_before TEXT NOT NULL,
    run_revision_before INTEGER NOT NULL CHECK(run_revision_before>=1), run_state_after TEXT NOT NULL,
    run_revision_after INTEGER NOT NULL CHECK(run_revision_after>=1), run_expiry_boot TEXT NOT NULL,
    run_expiry_cont TEXT NOT NULL, old_owner_session_hash TEXT NOT NULL, old_owner_epoch_hash TEXT NOT NULL,
    old_admission_hash TEXT NOT NULL, cleanup_owner_session_hash TEXT NOT NULL,
    cleanup_owner_epoch_hash TEXT NOT NULL, cleanup_admission_hash TEXT NOT NULL,
    decision_subject_hash TEXT NOT NULL, artifact_bytes_charged INTEGER NOT NULL CHECK(artifact_bytes_charged>=0),
    retired_boot TEXT NOT NULL, retired_cont TEXT NOT NULL, retired_wall TEXT NOT NULL,
    UNIQUE(run_id,run_revision_after)
  );
`

const SCHEMA_SQL = `
  CREATE TABLE meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE quota (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), quota_key TEXT NOT NULL, root_binding TEXT NOT NULL,
    target TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), active_run_id TEXT,
    active_owner_session_hash TEXT, active_owner_epoch_hash TEXT, pending_request_id TEXT,
    last_attempt_id TEXT, last_attempt_boot TEXT, last_attempt_cont TEXT,
    fence_boot TEXT, fence_cont TEXT, clock_boot TEXT, clock_cont TEXT, clock_wall TEXT,
    clock_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(clock_uncertain IN (0,1))
  );
  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY, campaign_hash TEXT NOT NULL, campaign_id TEXT, owner_session_hash TEXT NOT NULL,
    owner_epoch_hash TEXT NOT NULL, owner_session_id TEXT, owner_epoch TEXT, admission_hash TEXT NOT NULL, binding_hash TEXT NOT NULL,
    dataset_hash TEXT NOT NULL, data_hash TEXT NOT NULL, model_hash TEXT NOT NULL,
    protocol_hash TEXT NOT NULL, baseline_hash TEXT NOT NULL, created_boot TEXT NOT NULL,
    created_cont TEXT NOT NULL, created_wall TEXT NOT NULL, expires_boot TEXT NOT NULL,
    expires_cont TEXT NOT NULL, expires_wall TEXT NOT NULL, state TEXT NOT NULL,
    reason_code TEXT, revision INTEGER NOT NULL CHECK(revision>=1), active_ms INTEGER NOT NULL DEFAULT 0,
    candidate_steps INTEGER NOT NULL DEFAULT 0, artifact_bytes INTEGER NOT NULL DEFAULT 0,
    fixture_bytes INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE consents (
    consent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
    subject_hash TEXT NOT NULL, schedule_hash TEXT NOT NULL, binding_hash TEXT NOT NULL, owner_session_hash TEXT NOT NULL,
    owner_epoch_hash TEXT NOT NULL, admission_hash TEXT NOT NULL, created_boot TEXT NOT NULL,
    created_cont TEXT NOT NULL, created_wall TEXT NOT NULL, expires_boot TEXT NOT NULL,
    expires_cont TEXT NOT NULL, expires_wall TEXT NOT NULL, state TEXT NOT NULL
  );
  CREATE TABLE consent_provenance (
    history_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), consent_id TEXT NOT NULL,
    subject_hash TEXT NOT NULL, schedule_hash TEXT NOT NULL, binding_hash TEXT NOT NULL, owner_session_hash TEXT NOT NULL,
    owner_epoch_hash TEXT NOT NULL, admission_hash TEXT NOT NULL, created_boot TEXT NOT NULL,
    created_cont TEXT NOT NULL, created_wall TEXT NOT NULL, expires_boot TEXT NOT NULL,
    expires_cont TEXT NOT NULL, expires_wall TEXT NOT NULL, state TEXT NOT NULL,
    superseded_boot TEXT NOT NULL, superseded_cont TEXT NOT NULL, superseded_wall TEXT NOT NULL,
    reentry_subject_hash TEXT NOT NULL
  );
  CREATE TABLE arms (
    arm_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id), consent_id TEXT NOT NULL,
    watermark_hash TEXT NOT NULL, seen_digest_hashes TEXT NOT NULL, armed_boot TEXT NOT NULL,
    armed_cont TEXT NOT NULL, armed_wall TEXT NOT NULL, expires_boot TEXT NOT NULL,
    expires_cont TEXT NOT NULL, expires_wall TEXT NOT NULL, state TEXT NOT NULL,
    reservation_id TEXT UNIQUE
  );
  CREATE TABLE attempts (
    reservation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
    arm_id TEXT UNIQUE REFERENCES arms(arm_id), trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('automatic','manual')),
    request_id TEXT NOT NULL UNIQUE,
    owner_session_hash TEXT NOT NULL, owner_epoch_hash TEXT NOT NULL, charged INTEGER NOT NULL CHECK(charged=1),
    actual_dispatch INTEGER CHECK(actual_dispatch IN (0,1) OR actual_dispatch IS NULL),
    dispatch_state TEXT NOT NULL, created_boot TEXT NOT NULL, created_cont TEXT NOT NULL, created_wall TEXT NOT NULL
  );
  CREATE TABLE usage (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id), target_requests INTEGER NOT NULL DEFAULT 0,
    optimizer_requests INTEGER NOT NULL DEFAULT 0, reviewer_requests INTEGER NOT NULL DEFAULT 0,
    final_safety_requests INTEGER NOT NULL DEFAULT 0, canary_requests INTEGER NOT NULL DEFAULT 0,
    active_ms INTEGER NOT NULL DEFAULT 0, active_reserved_ms INTEGER NOT NULL DEFAULT 0,
    artifact_bytes INTEGER NOT NULL DEFAULT 0,
    candidate_steps INTEGER NOT NULL DEFAULT 0, fixture_bytes INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE requests (
    request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), reservation_id TEXT NOT NULL,
    role TEXT NOT NULL, phase TEXT NOT NULL, binding_hash TEXT NOT NULL, owner_epoch_hash TEXT NOT NULL,
    charged INTEGER NOT NULL CHECK(charged=1), actual_dispatch INTEGER CHECK(actual_dispatch IN (0,1) OR actual_dispatch IS NULL),
    dispatch_state TEXT NOT NULL, reference_json TEXT, created_boot TEXT NOT NULL, created_cont TEXT NOT NULL,
    created_wall TEXT NOT NULL, finished_boot TEXT, finished_cont TEXT, terminal_class TEXT,
    active_reserved_ms INTEGER NOT NULL DEFAULT 120000
  );
  CREATE TABLE trainer_protocol_events (
    run_id TEXT NOT NULL REFERENCES runs(run_id), wire_request_id TEXT NOT NULL,
    worker_profile_sha256 TEXT NOT NULL CHECK(length(worker_profile_sha256)=64 AND worker_profile_sha256 NOT GLOB '*[^0-9a-f]*'),
    receipt_binding_sha256 TEXT NOT NULL CHECK(length(receipt_binding_sha256)=64 AND receipt_binding_sha256 NOT GLOB '*[^0-9a-f]*'),
    ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal>=1),
    raw_line_sha256 TEXT NOT NULL CHECK(length(raw_line_sha256)=64 AND raw_line_sha256 NOT GLOB '*[^0-9a-f]*'),
    kind TEXT NOT NULL CHECK(kind IN ('rollout','optimizer')), cohort TEXT, case_id TEXT, replicate INTEGER,
    fragment_sha256 TEXT, optimizer_stage TEXT, prompt_sha256 TEXT,
    PRIMARY KEY(run_id,wire_request_id), UNIQUE(run_id,worker_profile_sha256,ordinal),
    CHECK(
      (kind='rollout' AND cohort IS NOT NULL AND cohort IN ('baseline-selection','training','candidate-selection') AND
       case_id IS NOT NULL AND typeof(replicate)='integer' AND replicate>=0 AND
       fragment_sha256 IS NOT NULL AND length(fragment_sha256)=64 AND fragment_sha256 NOT GLOB '*[^0-9a-f]*' AND
       optimizer_stage IS NULL AND prompt_sha256 IS NULL) OR
      (kind='optimizer' AND cohort IS NULL AND case_id IS NULL AND replicate IS NULL AND fragment_sha256 IS NULL AND
       optimizer_stage IS NOT NULL AND optimizer_stage IN ('analyst','merge','ranking') AND prompt_sha256 IS NOT NULL AND
       length(prompt_sha256)=64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*')
    )
  );
  CREATE TABLE trainer_protocol_dispatches (
    run_id TEXT NOT NULL, wire_request_id TEXT NOT NULL, native_request_id TEXT NOT NULL UNIQUE REFERENCES requests(request_id),
    PRIMARY KEY(run_id,wire_request_id),
    FOREIGN KEY(run_id,wire_request_id) REFERENCES trainer_protocol_events(run_id,wire_request_id)
  );
  CREATE TABLE campaign_qualifications (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id), binding_hash TEXT NOT NULL, schedule_hash TEXT NOT NULL,
    candidate_hash TEXT NOT NULL, results_hash TEXT NOT NULL, review_hash TEXT NOT NULL
  );
  CREATE TABLE canary_handoffs (
    run_id TEXT NOT NULL REFERENCES runs(run_id), operation TEXT NOT NULL CHECK(operation IN ('apply','rollback')),
    handoff_id TEXT NOT NULL UNIQUE, transaction_id TEXT NOT NULL,
    promotion_binding_hash TEXT NOT NULL, candidate_hash TEXT NOT NULL, results_hash TEXT NOT NULL,
    review_hash TEXT NOT NULL, schedule_hash TEXT NOT NULL, loader_session_hash TEXT NOT NULL,
    loader_epoch_hash TEXT NOT NULL, loader_admission_hash TEXT NOT NULL, request_id TEXT UNIQUE,
    state TEXT NOT NULL, artifact_bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run_id,operation)
  );
  ${PRIVATE_TEXT_CLEANUP_TABLE_SQL}
  CREATE INDEX requests_by_run ON requests(run_id, created_wall);
`

function transaction<T>(db: Database, action: () => T): T {
  try { return db.transaction(action).immediate() } catch (error) {
    if (error instanceof SkillOptControllerError) throw error
    failSqlite(error)
  }
}

type LedgerOptions = { path: string; rootBinding: string; quotaKey: string }
type FaultPoint = SkillOptTestFaultPoint
type FaultHook = (point: FaultPoint) => void

type RunSeed = {
  runId: string; campaignHash: string; campaignId: string; ownerSessionHash: string; ownerEpochHash: string
  ownerSessionId: string; ownerEpoch: string; admissionHash: string
  bindingHash: string; datasetHash: string; dataHash: string; modelHash: string; protocolHash: string; baselineHash: string
  clock: ClockValues; expiresWall: bigint; expiresCont: bigint; fixtureBytes: number
}
type ReserveSeed = {
  runId: string; consentId: string; armId: string; ownerSessionHash: string; ownerEpochHash: string; admissionHash: string
  bindingHash: string; newDigestHashes: readonly string[]; expectedRevision: number; clock: ClockValues
  role: SkillOptRequestRole; phase: SkillOptRequestPhase; fault?: FaultHook
}
type ReserveManualSeed = Omit<ReserveSeed, "armId" | "newDigestHashes" | "fault">
type QuotaRow = {
  quota_key: string; root_binding: string; target: string; revision: number; active_run_id: string | null
  active_owner_session_hash: string | null; active_owner_epoch_hash: string | null; pending_request_id: string | null
  last_attempt_id: string | null; last_attempt_boot: string | null; last_attempt_cont: string | null
  fence_boot: string | null; fence_cont: string | null; clock_boot: string | null; clock_cont: string | null
  clock_wall: string | null; clock_uncertain: number
}
type StoredRunRow = {
  run_id: string; campaign_hash: string; campaign_id: string | null; owner_session_hash: string; owner_epoch_hash: string
  owner_session_id: string | null; owner_epoch: string | null; admission_hash: string; binding_hash: string
  dataset_hash: string; data_hash: string; model_hash: string; protocol_hash: string; baseline_hash: string
  created_boot: string; created_cont: string; created_wall: string; expires_boot: string; expires_cont: string
  expires_wall: string; state: string; reason_code: string | null; revision: number; active_ms: number
  candidate_steps: number; artifact_bytes: number; fixture_bytes: number
}
type StoredConsentRow = {
  consent_id: string; run_id: string; subject_hash: string; schedule_hash: string; binding_hash: string
  owner_session_hash: string; owner_epoch_hash: string; admission_hash: string; created_boot: string
  created_cont: string; created_wall: string; expires_boot: string; expires_cont: string; expires_wall: string; state: string
}
type StoredArmRow = {
  arm_id: string; run_id: string; consent_id: string; watermark_hash: string; seen_digest_hashes: string
  armed_boot: string; armed_cont: string; armed_wall: string; expires_boot: string; expires_cont: string
  expires_wall: string; state: string; reservation_id: string | null
}
type NativeTrainerProtocolEventRow = {
  run_id: string; wire_request_id: string; worker_profile_sha256: string; receipt_binding_sha256: string
  ordinal: number; raw_line_sha256: string
  kind: "rollout" | "optimizer"; cohort: "baseline-selection" | "training" | "candidate-selection" | null
  case_id: string | null; replicate: number | null; fragment_sha256: string | null
  optimizer_stage: "analyst" | "merge" | "ranking" | null; prompt_sha256: string | null
}
type NativeTrainerProtocolEventBinding = Readonly<{
  runId: string; wireRequestId: string; workerProfileSha256: string; receiptBindingSha256: string
  ordinal: number; rawLineSha256: string
  kind: "rollout" | "optimizer"; cohort: "baseline-selection" | "training" | "candidate-selection" | null
  caseId: string | null; replicate: number | null; fragmentSha256: string | null
  optimizerStage: "analyst" | "merge" | "ranking" | null; promptSha256: string | null
}>
type PrivateTextCleanupRetirementRow = {
  retirement_id: string; run_id: string; previous_retirement_id: string | null; artifacts_sha256: string; operation: string
  root_binding: string; quota_key: string; run_state_before: string; run_revision_before: number; run_state_after: string
  run_revision_after: number; run_expiry_boot: string; run_expiry_cont: string; old_owner_session_hash: string
  old_owner_epoch_hash: string; old_admission_hash: string; cleanup_owner_session_hash: string
  cleanup_owner_epoch_hash: string; cleanup_admission_hash: string; decision_subject_hash: string
  artifact_bytes_charged: number; retired_boot: string; retired_cont: string; retired_wall: string
}
type AwaitingRunRow = {
  state: string; revision: number; binding_hash: string; owner_session_hash: string; owner_epoch_hash: string
  admission_hash: string; expires_boot: string; expires_cont: string; expires_wall: string
}
type AwaitingConsentRow = {
  state: string; schedule_hash: string; binding_hash: string; owner_session_hash: string; owner_epoch_hash: string
  admission_hash: string; expires_boot: string; expires_cont: string; expires_wall: string
}
const RUN_ROW_KEYS = [
  "run_id", "campaign_hash", "campaign_id", "owner_session_hash", "owner_epoch_hash", "owner_session_id", "owner_epoch",
  "admission_hash", "binding_hash", "dataset_hash", "data_hash", "model_hash", "protocol_hash", "baseline_hash",
  "created_boot", "created_cont", "created_wall", "expires_boot", "expires_cont", "expires_wall", "state", "reason_code",
  "revision", "active_ms", "candidate_steps", "artifact_bytes", "fixture_bytes",
] as const
const CONSENT_ROW_KEYS = [
  "consent_id", "run_id", "subject_hash", "schedule_hash", "binding_hash", "owner_session_hash", "owner_epoch_hash",
  "admission_hash", "created_boot", "created_cont", "created_wall", "expires_boot", "expires_cont", "expires_wall", "state",
] as const
const ARM_ROW_KEYS = [
  "arm_id", "run_id", "consent_id", "watermark_hash", "seen_digest_hashes", "armed_boot", "armed_cont", "armed_wall",
  "expires_boot", "expires_cont", "expires_wall", "state", "reservation_id",
] as const
const PRIVATE_TEXT_CLEANUP_RETIREMENT_ROW_KEYS = [
  "retirement_id", "run_id", "previous_retirement_id", "artifacts_sha256", "operation", "root_binding", "quota_key",
  "run_state_before", "run_revision_before", "run_state_after", "run_revision_after", "run_expiry_boot", "run_expiry_cont",
  "old_owner_session_hash", "old_owner_epoch_hash", "old_admission_hash", "cleanup_owner_session_hash",
  "cleanup_owner_epoch_hash", "cleanup_admission_hash", "decision_subject_hash", "artifact_bytes_charged",
  "retired_boot", "retired_cont", "retired_wall",
] as const
const AWAITING_RUN_ROW_KEYS = [
  "state", "revision", "binding_hash", "owner_session_hash", "owner_epoch_hash", "admission_hash",
  "expires_boot", "expires_cont", "expires_wall",
] as const
const AWAITING_CONSENT_ROW_KEYS = [
  "state", "schedule_hash", "binding_hash", "owner_session_hash", "owner_epoch_hash", "admission_hash",
  "expires_boot", "expires_cont", "expires_wall",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function isStoredRunRow(value: unknown): value is StoredRunRow {
  if (!isRecord(value) || !hasExactKeys(value, RUN_ROW_KEYS)) return false
  const stringKeys = RUN_ROW_KEYS.filter((key) => !["campaign_id", "owner_session_id", "owner_epoch", "reason_code", "revision", "active_ms", "candidate_steps", "artifact_bytes", "fixture_bytes"].includes(key))
  const numberKeys = ["revision", "active_ms", "candidate_steps", "artifact_bytes", "fixture_bytes"] as const
  return stringKeys.every((key) => typeof value[key] === "string") &&
    ["campaign_id", "owner_session_id", "owner_epoch", "reason_code"].every((key) => isNullableString(value[key])) &&
    numberKeys.every((key) => {
      const field = value[key]
      return typeof field === "number" && Number.isSafeInteger(field) && field >= 0
    })
}

function isStoredConsentRow(value: unknown): value is StoredConsentRow {
  return isRecord(value) && hasExactKeys(value, CONSENT_ROW_KEYS) && CONSENT_ROW_KEYS.every((key) => typeof value[key] === "string")
}

function isStoredArmRow(value: unknown): value is StoredArmRow {
  if (!isRecord(value) || !hasExactKeys(value, ARM_ROW_KEYS)) return false
  return ARM_ROW_KEYS.filter((key) => key !== "reservation_id").every((key) => typeof value[key] === "string") &&
    isNullableString(value.reservation_id)
}

function isPrivateTextCleanupRetirementRow(value: unknown): value is PrivateTextCleanupRetirementRow {
  if (!isRecord(value) || !hasExactKeys(value, PRIVATE_TEXT_CLEANUP_RETIREMENT_ROW_KEYS)) return false
  const nullableKeys = ["previous_retirement_id"] as const
  const revisionKeys = ["run_revision_before", "run_revision_after"] as const
  return PRIVATE_TEXT_CLEANUP_RETIREMENT_ROW_KEYS.filter((key) => !nullableKeys.includes(key as typeof nullableKeys[number]) &&
      !revisionKeys.includes(key as typeof revisionKeys[number]) && key !== "artifact_bytes_charged").every((key) => typeof value[key] === "string") &&
    nullableKeys.every((key) => isNullableString(value[key])) && revisionKeys.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 1) &&
    Number.isSafeInteger(value.artifact_bytes_charged) && Number(value.artifact_bytes_charged) >= 0
}

function isAwaitingRunRow(value: unknown): value is AwaitingRunRow {
  return isRecord(value) && hasExactKeys(value, AWAITING_RUN_ROW_KEYS) && typeof value.state === "string" &&
    typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 1 &&
    AWAITING_RUN_ROW_KEYS.filter((key) => key !== "state" && key !== "revision").every((key) => typeof value[key] === "string")
}

function isAwaitingConsentRow(value: unknown): value is AwaitingConsentRow {
  return isRecord(value) && hasExactKeys(value, AWAITING_CONSENT_ROW_KEYS) && AWAITING_CONSENT_ROW_KEYS.every((key) => typeof value[key] === "string")
}

function parseSeenDigestHashes(value: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { fail("storage-corrupt") }
  if (!Array.isArray(parsed) || parsed.length > MAX_SNAPSHOT_DIGESTS) fail("storage-corrupt")
  const hashes: string[] = []
  for (const entry of parsed) {
    if (!asHash(entry)) fail("storage-corrupt")
    hashes.push(entry)
  }
  if (new Set(hashes).size !== hashes.length) fail("storage-corrupt")
  return hashes
}

type StoredReentrySnapshot = {
  run: StoredRunRow
  consent?: StoredConsentRow
  arm?: StoredArmRow
  usage: Record<string, unknown>
  quota: QuotaRow
  attemptCount: number
  requestCount: number
}
type PrivateTextCleanupRequestRow = {
  request_id: string; run_id: string; reservation_id: string; role: string; phase: string
  charged: number; dispatch_state: string; actual_dispatch: number | null; active_reserved_ms: number
  finished_boot: string | null; finished_cont: string | null; terminal_class: string | null
}
type PrivateTextCleanupAttemptRow = {
  request_id: string; run_id: string; dispatch_state: string; actual_dispatch: number | null
}
type PrivateTextCleanupHandoffRow = { operation: string; request_id: string | null; state: string }
type PrivateTextCleanupSnapshot = {
  run: StoredRunRow
  consent?: StoredConsentRow
  arm?: StoredArmRow
  usage: Record<string, unknown>
  quota: QuotaRow
  attempts: readonly PrivateTextCleanupAttemptRow[]
  requests: readonly PrivateTextCleanupRequestRow[]
  unresolvedRequestCount: number
  handoffs: readonly PrivateTextCleanupHandoffRow[]
  retirementHistory: readonly PrivateTextCleanupRetirementRow[]
  previousRetirement?: PrivateTextCleanupRetirementRow
}
type PrivateTextCleanupEligibility = Readonly<{
  resumed: boolean
  previousRetirementId?: string
  runState: SkillOptRunState
  runRevision: number
  artifactBytes: number
}>

const PRIVATE_TEXT_CLEANUP_ZERO_ATTEMPT_STATES: ReadonlySet<SkillOptRunState> = new Set(["PREPARED", "CONSENTED", "ARMED"])
const PRIVATE_TEXT_CLEANUP_RESOLVED_STATES: ReadonlySet<SkillOptRunState> = new Set(["CANCELLED", "NO_GAIN", "INCONCLUSIVE", "FAILED"])
const PRIVATE_TEXT_CLEANUP_TERMINAL_STATES: ReadonlySet<SkillOptRunState> = new Set(["COMPLETED", "ROLLED_BACK"])
const PRIVATE_TEXT_CLEANUP_INITIAL_STATES: ReadonlySet<SkillOptRunState> = new Set([
  ...PRIVATE_TEXT_CLEANUP_ZERO_ATTEMPT_STATES, ...PRIVATE_TEXT_CLEANUP_RESOLVED_STATES, ...PRIVATE_TEXT_CLEANUP_TERMINAL_STATES,
])
const PRIVATE_TEXT_CLEANUP_OPERATION = "delete-private-experiment-text-only" as const
const USAGE_ROW_KEYS = [
  "run_id", "target_requests", "optimizer_requests", "reviewer_requests", "final_safety_requests", "canary_requests",
  "active_ms", "active_reserved_ms", "artifact_bytes", "candidate_steps", "fixture_bytes",
] as const

function validatePrivateTextCleanupHistory(
  history: readonly PrivateTextCleanupRetirementRow[],
  run: StoredRunRow,
  rootBinding: string,
  quotaKey: string,
): PrivateTextCleanupRetirementRow | undefined {
  let previous: PrivateTextCleanupRetirementRow | undefined
  for (const row of history) {
    if (!isPrivateTextCleanupRetirementRow(row) || row.run_id !== run.run_id || row.operation !== PRIVATE_TEXT_CLEANUP_OPERATION ||
        row.root_binding !== rootBinding || row.quota_key !== quotaKey || !asHash(row.artifacts_sha256) ||
        !asHash(row.root_binding) || !asHash(row.quota_key) || !asHash(row.old_owner_session_hash) ||
        !asHash(row.old_owner_epoch_hash) || !asHash(row.old_admission_hash) || !asHash(row.cleanup_owner_session_hash) ||
        !asHash(row.cleanup_owner_epoch_hash) || !asHash(row.cleanup_admission_hash) || !asHash(row.decision_subject_hash) ||
        !UUID.test(row.retirement_id) || !UUID.test(row.retired_boot) ||
        (row.previous_retirement_id !== null && !UUID.test(row.previous_retirement_id)) ||
        boundedClockDecimal(row.run_expiry_cont) === undefined || boundedClockDecimal(row.retired_cont) === undefined ||
        boundedClockDecimal(row.retired_wall) === undefined || row.run_revision_after !== row.run_revision_before + 1) fail("storage-corrupt")
    const stateBefore = row.run_state_before as SkillOptRunState
    if ((!PRIVATE_TEXT_CLEANUP_INITIAL_STATES.has(stateBefore) && stateBefore !== "EXPIRED") ||
        row.run_state_after !== (PRIVATE_TEXT_CLEANUP_ZERO_ATTEMPT_STATES.has(stateBefore) ? "EXPIRED" : stateBefore)) fail("storage-corrupt")
    if (!previous) {
      if (row.previous_retirement_id !== null || stateBefore === "EXPIRED") fail("storage-corrupt")
    } else if (row.previous_retirement_id !== previous.retirement_id || row.run_revision_before !== previous.run_revision_after ||
        row.run_state_before !== previous.run_state_after || row.artifacts_sha256 !== previous.artifacts_sha256 ||
        row.run_expiry_boot !== previous.run_expiry_boot || row.run_expiry_cont !== previous.run_expiry_cont ||
        row.old_owner_session_hash !== previous.old_owner_session_hash || row.old_owner_epoch_hash !== previous.old_owner_epoch_hash ||
        row.old_admission_hash !== previous.old_admission_hash) fail("storage-corrupt")
    previous = row
  }
  if (previous && (previous.run_state_after !== run.state || previous.run_revision_after !== run.revision ||
      previous.run_expiry_boot !== run.expires_boot || previous.run_expiry_cont !== run.expires_cont ||
      previous.old_owner_session_hash !== run.owner_session_hash || previous.old_owner_epoch_hash !== run.owner_epoch_hash ||
      previous.old_admission_hash !== run.admission_hash)) fail("storage-corrupt")
  return previous
}

function samePrivateTextCleanupQuotaBinding(left: QuotaRow, right: QuotaRow): boolean {
  return left.quota_key === right.quota_key && left.root_binding === right.root_binding && left.target === right.target &&
    left.revision === right.revision && left.active_run_id === right.active_run_id &&
    left.active_owner_session_hash === right.active_owner_session_hash && left.active_owner_epoch_hash === right.active_owner_epoch_hash &&
    left.pending_request_id === right.pending_request_id && left.last_attempt_id === right.last_attempt_id &&
    left.last_attempt_boot === right.last_attempt_boot && left.last_attempt_cont === right.last_attempt_cont &&
    left.fence_boot === right.fence_boot && left.fence_cont === right.fence_cont && left.clock_uncertain === right.clock_uncertain
}

function validatePrivateTextCleanupSnapshot(
  snapshot: PrivateTextCleanupSnapshot,
  now: ClockValues,
  artifactsSha256: string,
  artifactBytes: number,
  rootBinding: string,
  quotaKey: string,
): PrivateTextCleanupEligibility {
  const { run, quota, usage } = snapshot
  if (!asHash(artifactsSha256) || !Number.isSafeInteger(artifactBytes) || artifactBytes < 0) fail("binding-invalid")
  if (!asHash(run.owner_session_hash) || !asHash(run.owner_epoch_hash) || !asHash(run.admission_hash) ||
      typeof run.owner_session_id !== "string" || !SESSION_ID.test(run.owner_session_id) ||
      typeof run.owner_epoch !== "string" || !UUID.test(run.owner_epoch) ||
      run.owner_session_hash !== sha256(run.owner_session_id) || run.owner_epoch_hash !== sha256(run.owner_epoch) ||
      !UUID.test(run.expires_boot) || boundedClockDecimal(run.expires_cont) === undefined ||
      boundedClockDecimal(run.expires_wall) === undefined || !Number.isSafeInteger(run.revision) || run.revision < 1 ||
      !isRecord(usage) || !hasExactKeys(usage, USAGE_ROW_KEYS) || usage.run_id !== run.run_id ||
      USAGE_ROW_KEYS.filter((key) => key !== "run_id").some((key) => !Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0) ||
      usage.fixture_bytes !== run.fixture_bytes || usage.active_ms !== run.active_ms ||
      usage.candidate_steps !== run.candidate_steps || usage.artifact_bytes !== run.artifact_bytes || quota.clock_uncertain !== 0) fail("storage-corrupt")
  const chargedArtifactBytes = Number(usage.artifact_bytes) + artifactBytes
  if (!Number.isSafeInteger(chargedArtifactBytes) || chargedArtifactBytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) fail("budget-exhausted")
  const previousRetirement = validatePrivateTextCleanupHistory(snapshot.retirementHistory, run, rootBinding, quotaKey)
  if (!isDeepStrictEqual(previousRetirement, snapshot.previousRetirement)) fail("storage-corrupt")
  if (quota.pending_request_id !== null) fail("dispatch-pending")
  if (quota.active_run_id !== null) fail("active-run")
  if (quota.active_owner_session_hash !== null || quota.active_owner_epoch_hash !== null) fail("storage-corrupt")
  if (usage.active_reserved_ms !== 0) fail("active-run")
  if (!Number.isSafeInteger(snapshot.unresolvedRequestCount) || snapshot.unresolvedRequestCount !== 0) fail("dispatch-ambiguous")

  if (run.state === "PREPARED") {
    if (snapshot.consent || snapshot.arm) fail("storage-corrupt")
  } else if (run.state === "CONSENTED" || run.state === "ARMED") {
    const consent = snapshot.consent
    if (!consent || consent.run_id !== run.run_id || !UUID.test(consent.consent_id) || consent.state !== "valid" ||
        !asHash(consent.subject_hash) || !asHash(consent.schedule_hash) || consent.binding_hash !== run.binding_hash ||
        consent.owner_session_hash !== run.owner_session_hash || consent.owner_epoch_hash !== run.owner_epoch_hash ||
        consent.admission_hash !== run.admission_hash || boundedClockDecimal(consent.expires_cont) === undefined ||
        boundedClockDecimal(consent.expires_wall) === undefined || !UUID.test(consent.expires_boot)) fail("storage-corrupt")
    if (run.state === "CONSENTED" && snapshot.arm) fail("storage-corrupt")
    if (run.state === "ARMED") {
      const arm = snapshot.arm
      if (!arm || arm.run_id !== run.run_id || arm.consent_id !== consent.consent_id || arm.state !== "armed" ||
          arm.reservation_id !== null || !UUID.test(arm.arm_id) || !asHash(arm.watermark_hash) ||
          boundedClockDecimal(arm.expires_cont) === undefined || boundedClockDecimal(arm.expires_wall) === undefined ||
          !UUID.test(arm.expires_boot)) fail("storage-corrupt")
    }
  } else if (run.state === "EXPIRED" && ((snapshot.consent && snapshot.consent.state === "valid") ||
      (snapshot.arm && snapshot.arm.state === "armed"))) {
    fail("storage-corrupt")
  }

  const requests = new Map<string, PrivateTextCleanupRequestRow>()
  const chargedCounts: Record<SkillOptRequestRole, number> = { target: 0, optimizer: 0, reviewer: 0 }
  let finalSafetyRequests = 0
  let canaryRequests = 0
  for (const request of snapshot.requests) {
    if (!UUID.test(request.request_id) || request.run_id !== run.run_id || !UUID.test(request.reservation_id) ||
        !(request.role === "target" || request.role === "optimizer" || request.role === "reviewer") ||
        !(request.phase === "train" || request.phase === "dev" || request.phase === "final" || request.phase === "safety" || request.phase === "canary") ||
        (request.role === "optimizer" && request.phase !== "train") ||
        (request.role === "reviewer" && (request.phase === "train" || request.phase === "canary")) ||
        request.charged !== 1 || !Number.isSafeInteger(request.active_reserved_ms) || request.active_reserved_ms < 0 ||
        requests.has(request.request_id)) fail("storage-corrupt")
    chargedCounts[request.role] += 1
    if (request.role === "target" && (request.phase === "final" || request.phase === "safety")) finalSafetyRequests += 1
    if (request.role === "target" && request.phase === "canary") canaryRequests += 1
    if (request.dispatch_state === "unknown" || request.actual_dispatch === null) fail("dispatch-ambiguous")
    if (request.dispatch_state === "settled") {
      if (request.actual_dispatch !== 1 || request.active_reserved_ms !== 0 || !request.finished_boot || !UUID.test(request.finished_boot) ||
          !request.finished_cont || boundedClockDecimal(request.finished_cont) === undefined ||
          typeof request.terminal_class !== "string" || request.terminal_class.length === 0 || request.terminal_class.length > 64) fail("recovery-unresolved")
    } else if (request.dispatch_state === "not_dispatched") {
      if (request.actual_dispatch !== 0 || request.active_reserved_ms !== 0 ||
          (request.finished_boot !== null && (!UUID.test(request.finished_boot) || !request.finished_cont || boundedClockDecimal(request.finished_cont) === undefined)) ||
          (request.finished_boot === null && request.finished_cont !== null)) fail("recovery-unresolved")
    } else fail("dispatch-pending")
    requests.set(request.request_id, request)
  }
  if (usage.target_requests !== chargedCounts.target || usage.optimizer_requests !== chargedCounts.optimizer ||
      usage.reviewer_requests !== chargedCounts.reviewer || usage.final_safety_requests !== finalSafetyRequests ||
      usage.canary_requests !== canaryRequests) fail("storage-corrupt")
  if (snapshot.attempts.length !== snapshot.requests.length) fail("dispatch-ambiguous")
  const handoffs = new Map<string, PrivateTextCleanupHandoffRow>()
  for (const attempt of snapshot.attempts) {
    const request = requests.get(attempt.request_id)
    if (!request || attempt.run_id !== run.run_id ||
        !((attempt.dispatch_state === "settled" && attempt.actual_dispatch === 1) ||
          (attempt.dispatch_state === "not_dispatched" && attempt.actual_dispatch === 0)) ||
        request.dispatch_state !== attempt.dispatch_state || request.actual_dispatch !== attempt.actual_dispatch) fail("dispatch-ambiguous")
  }
  for (const handoff of snapshot.handoffs) {
    if (!(handoff.operation === "apply" || handoff.operation === "rollback") ||
        !(handoff.state === "committed" || handoff.state === "not_dispatched") || !handoff.request_id ||
        !UUID.test(handoff.request_id) || handoffs.has(handoff.operation)) fail("recovery-unresolved")
    const request = requests.get(handoff.request_id)
    if (!request || request.role !== "target" || request.phase !== "canary" ||
        request.dispatch_state !== (handoff.state === "committed" ? "settled" : "not_dispatched")) {
      fail("recovery-unresolved")
    }
    handoffs.set(handoff.operation, handoff)
  }
  if (PRIVATE_TEXT_CLEANUP_ZERO_ATTEMPT_STATES.has(run.state as SkillOptRunState) &&
      (snapshot.attempts.length !== 0 || snapshot.requests.length !== 0)) fail("run-stale")

  const runState = run.state as SkillOptRunState
  if (PRIVATE_TEXT_CLEANUP_TERMINAL_STATES.has(runState)) {
    const expectedHandoffs = runState === "COMPLETED" ? ["apply"] : ["apply", "rollback"]
    const expectedRequestIds = expectedHandoffs.map((operation) => handoffs.get(operation)?.request_id)
    const terminalCanaryRequests = snapshot.requests.filter((request) => request.role === "target" && request.phase === "canary")
    if (handoffs.size !== expectedHandoffs.length || expectedHandoffs.some((operation) => handoffs.get(operation)?.state !== "committed") ||
        expectedRequestIds.some((requestId) => !requestId) || terminalCanaryRequests.length !== expectedHandoffs.length ||
        terminalCanaryRequests.some((request) => !expectedRequestIds.includes(request.request_id))) {
      fail("private-text-cleanup-ineligible")
    }
  } else if (runState === "AWAITING_CANDIDATE_APPROVAL") {
    fail("private-text-cleanup-ineligible")
  }
  if (!PRIVATE_TEXT_CLEANUP_INITIAL_STATES.has(runState) && runState !== "EXPIRED") fail("private-text-cleanup-ineligible")

  if (previousRetirement) {
    const prior = previousRetirement
    if (prior.artifacts_sha256 !== artifactsSha256) fail("consent-binding-drift")
    const priorStartedState = prior.run_state_before as SkillOptRunState
    const expectedPriorState = PRIVATE_TEXT_CLEANUP_ZERO_ATTEMPT_STATES.has(priorStartedState) ? "EXPIRED" : priorStartedState
    if (!isPrivateTextCleanupRetirementRow(prior) || prior.run_id !== run.run_id || prior.root_binding !== rootBinding ||
        prior.quota_key !== quotaKey || prior.artifacts_sha256 !== artifactsSha256 || prior.operation !== PRIVATE_TEXT_CLEANUP_OPERATION ||
        prior.run_state_after !== run.state || prior.run_revision_after !== run.revision ||
        prior.run_expiry_boot !== run.expires_boot || prior.run_expiry_cont !== run.expires_cont ||
        prior.old_owner_session_hash !== run.owner_session_hash || prior.old_owner_epoch_hash !== run.owner_epoch_hash ||
        prior.old_admission_hash !== run.admission_hash || !asHash(prior.decision_subject_hash) ||
        !asHash(prior.root_binding) || !asHash(prior.quota_key) || !asHash(prior.old_owner_session_hash) ||
        !asHash(prior.old_owner_epoch_hash) || !asHash(prior.old_admission_hash) ||
        prior.run_revision_after !== prior.run_revision_before + 1 || prior.run_state_after !== expectedPriorState ||
        (prior.previous_retirement_id === null && prior.run_state_before === "EXPIRED") ||
        !UUID.test(prior.retirement_id) || (prior.previous_retirement_id !== null && !UUID.test(prior.previous_retirement_id)) ||
        boundedClockDecimal(prior.retired_cont) === undefined || boundedClockDecimal(prior.retired_wall) === undefined ||
        !UUID.test(prior.retired_boot) || !asHash(prior.cleanup_owner_session_hash) || !asHash(prior.cleanup_owner_epoch_hash) ||
        !asHash(prior.cleanup_admission_hash) || (!PRIVATE_TEXT_CLEANUP_INITIAL_STATES.has(priorStartedState) && prior.run_state_before !== "EXPIRED")) fail("storage-corrupt")
    if (!asHash(prior.artifacts_sha256)) fail("storage-corrupt")
    return { resumed: true, previousRetirementId: prior.retirement_id, runState, runRevision: run.revision, artifactBytes }
  }
  if (runState === "EXPIRED") fail("private-text-cleanup-ineligible")
  if (!PRIVATE_TEXT_CLEANUP_INITIAL_STATES.has(runState)) fail("private-text-cleanup-ineligible")
  if (run.expires_boot !== now.boot) fail("private-text-cleanup-ineligible")
  if (now.continuous < BigInt(run.expires_cont)) fail("private-text-cleanup-not-expired")
  return { resumed: false, runState, runRevision: run.revision, artifactBytes }
}

class SkillOptAutomationLedger {
  readonly path: string
  readonly rootBinding: string
  readonly quotaKey: string

  constructor(options: LedgerOptions) {
    this.path = resolve(options.path)
    this.rootBinding = options.rootBinding
    this.quotaKey = options.quotaKey
  }

  #assertFile(): void {
    securePathComponents(this.path)
    const dir = dirname(this.path)
    privateDirectory(dir)
    let st: ReturnType<typeof lstatSync>
    try { st = lstatSync(this.path) } catch { fail("storage-missing") }
    const uid = process.geteuid?.()
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || uid === undefined || st.uid !== uid || st.size > MAX_DB_BYTES || (st.mode & 0o777) !== DB_MODE) fail("storage-corrupt")
  }

  #open(readonly = false): Database {
    this.#assertFile()
    let before: ReturnType<typeof lstatSync>
    try { before = lstatSync(this.path) } catch { fail("storage-missing") }
    let db: Database
    try { db = new Database(this.path, { readonly, readwrite: !readonly, create: false }) } catch (error) { failSqlite(error) }
    try {
      const fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const after = fstatSync(fd)
        if (after.dev !== before.dev || after.ino !== before.ino || !after.isFile()) fail("storage-corrupt")
      } finally { closeSync(fd) }
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
      db.exec("PRAGMA foreign_keys = ON")
      if (readonly) db.exec("PRAGMA query_only = ON")
      else {
        db.exec("PRAGMA synchronous = FULL")
        db.exec("PRAGMA secure_delete = ON")
      }
      this.#validate(db)
      return db
    } catch (error) {
      db.close()
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    }
  }

  #validate(db: Database): void {
    try {
      const version = db.query("PRAGMA user_version").get() as Record<string, unknown> | undefined
      const application = db.query("PRAGMA application_id").get() as Record<string, unknown> | undefined
      const integrity = db.query("PRAGMA integrity_check").get() as Record<string, unknown> | undefined
      const values = (row: Record<string, unknown> | undefined) => row ? Object.values(row)[0] : undefined
      const schemaVersion = values(version)
      if (schemaVersion !== SCHEMA_VERSION || values(application) !== APPLICATION_ID || values(integrity) !== "ok") fail("storage-corrupt")
      const journal = db.query("PRAGMA journal_mode").get() as Record<string, unknown> | undefined
      const pageCount = db.query("PRAGMA page_count").get() as Record<string, unknown> | undefined
      const pageSize = db.query("PRAGMA page_size").get() as Record<string, unknown> | undefined
      if (String(values(journal)).toLowerCase() !== "delete" || typeof values(pageCount) !== "number" ||
          typeof values(pageSize) !== "number" || Number(values(pageCount)) * Number(values(pageSize)) > MAX_DB_BYTES) fail("storage-corrupt")
      const schemaObjects = db.query("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
      const actualObjects = schemaObjects.map((row) => row.name).sort()
      const expectedObjects = ["arms", "attempts", "campaign_qualifications", "canary_handoffs", "consent_provenance", "consents", "meta",
        "private_cleanup_retirements", "quota", "requests", "requests_by_run", "runs", "trainer_protocol_dispatches",
        "trainer_protocol_events", "usage"].sort()
      const cleanupColumns = db.query("PRAGMA table_info(private_cleanup_retirements)").all() as Array<{ name: string }>
      const trainerEventColumns = db.query("PRAGMA table_info(trainer_protocol_events)").all() as Array<{ name: string }>
      const trainerDispatchColumns = db.query("PRAGMA table_info(trainer_protocol_dispatches)").all() as Array<{ name: string }>
      const uniqueColumns = (table: string): string[][] => {
        const indexes = db.query(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>
        return indexes.filter(index => index.unique === 1).map(index => {
          const info = db.query(`PRAGMA index_info(${index.name})`).all() as Array<{ seqno: number; name: string }>
          return info.sort((left, right) => left.seqno - right.seqno).map(column => column.name)
        }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
      }
      const foreignKeys = (table: string): string[][] => {
        const rows = db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; from: string; to: string }>
        return rows.map(row => [row.table, row.from, row.to]).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
      }
      const expectedCleanupColumns = ["retirement_id", "run_id", "previous_retirement_id", "artifacts_sha256", "operation",
        "root_binding", "quota_key", "run_state_before", "run_revision_before", "run_state_after", "run_revision_after",
        "run_expiry_boot", "run_expiry_cont", "old_owner_session_hash", "old_owner_epoch_hash", "old_admission_hash",
        "cleanup_owner_session_hash", "cleanup_owner_epoch_hash", "cleanup_admission_hash", "decision_subject_hash",
        "artifact_bytes_charged", "retired_boot", "retired_cont", "retired_wall"]
      if (canonicalJson(actualObjects) !== canonicalJson(expectedObjects) ||
          canonicalJson(cleanupColumns.map(({ name }) => name)) !== canonicalJson(expectedCleanupColumns) ||
          canonicalJson(trainerEventColumns.map(({ name }) => name)) !== canonicalJson(["run_id", "wire_request_id", "worker_profile_sha256",
            "receipt_binding_sha256", "ordinal", "raw_line_sha256", "kind", "cohort", "case_id", "replicate", "fragment_sha256",
            "optimizer_stage", "prompt_sha256"]) ||
          canonicalJson(trainerDispatchColumns.map(({ name }) => name)) !== canonicalJson(["run_id", "wire_request_id", "native_request_id"]) ||
          canonicalJson(uniqueColumns("trainer_protocol_events")) !== canonicalJson([
            ["run_id", "wire_request_id"], ["run_id", "worker_profile_sha256", "ordinal"],
          ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))) ||
          canonicalJson(uniqueColumns("trainer_protocol_dispatches")) !== canonicalJson([
            ["run_id", "wire_request_id"], ["native_request_id"],
          ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))) ||
          canonicalJson(foreignKeys("trainer_protocol_events")) !== canonicalJson([["runs", "run_id", "run_id"]]) ||
          canonicalJson(foreignKeys("trainer_protocol_dispatches")) !== canonicalJson([
            ["requests", "native_request_id", "request_id"], ["trainer_protocol_events", "run_id", "run_id"],
            ["trainer_protocol_events", "wire_request_id", "wire_request_id"],
          ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))) ||
          (db.query("PRAGMA foreign_key_check").all() as unknown[]).length !== 0) fail("storage-corrupt")
      const meta = db.query("SELECT name,value FROM meta").all() as Array<{ name: string; value: string }>
      const header = new Map(meta.map((row) => [row.name, row.value]))
      const quota = db.query("SELECT quota_key,root_binding,target FROM quota WHERE singleton=1").get() as { quota_key: string; root_binding: string; target: string } | undefined
      if (header.size !== 4 || header.get("schema") !== `skillopt.automation-ledger.v${SCHEMA_VERSION}` || header.get("quota_key") !== this.quotaKey ||
          header.get("root_binding") !== this.rootBinding || header.get("target") !== PILOT_SKILL ||
          !quota || quota.quota_key !== this.quotaKey || quota.root_binding !== this.rootBinding || quota.target !== PILOT_SKILL) fail("storage-corrupt")
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      fail("storage-corrupt")
    }
  }

  initialize(explicitDirectoryCreation: boolean): void {
    const directory = dirname(this.path)
    if (existsSync(directory)) {
      privateDirectory(directory)
      if (!existsSync(this.path)) fail("storage-missing")
      const db = this.#open(false)
      db.close()
      return
    }
    if (!explicitDirectoryCreation) fail("storage-not-initialized")
    const skilloptDir = dirname(directory)
    try {
      ensureDurableDirectory(skilloptDir)
      privateDirectory(skilloptDir)
      mkdirSync(directory, { mode: DIRECTORY_MODE })
    } catch (error) {
      if (codeOf(error) !== "EEXIST") fail("storage-permission")
      privateDirectory(directory)
      if (!existsSync(this.path)) fail("storage-missing")
      const existing = this.#open(false)
      existing.close()
      return
    }
    privateDirectory(directory)
    const parentFd = openSync(skilloptDir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
    try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
    let fd: number | undefined
    try {
      fd = openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), DB_MODE)
      fchmodSync(fd, DB_MODE)
      fsyncSync(fd)
    } catch (error) {
      failSqlite(error)
    } finally {
      // `fd` exists only after exclusive creation; initialize failures deliberately leave it in place.
      try { if (fd !== undefined) closeSync(fd) } catch { /* initialization remains fail-closed */ }
    }
    const db = new Database(this.path, { create: false, readwrite: true })
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
      db.exec("PRAGMA journal_mode = DELETE")
      db.exec("PRAGMA synchronous = FULL")
      db.exec("PRAGMA secure_delete = ON")
      db.exec("PRAGMA foreign_keys = ON")
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`)
      transaction(db, () => {
        db.exec(SCHEMA_SQL)
        const insert = db.query("INSERT INTO meta(name,value) VALUES(?,?)")
        insert.run("schema", `skillopt.automation-ledger.v${SCHEMA_VERSION}`)
        insert.run("quota_key", this.quotaKey)
        insert.run("root_binding", this.rootBinding)
        insert.run("target", PILOT_SKILL)
        db.query("INSERT INTO quota(singleton,quota_key,root_binding,target,revision) VALUES(1,?,?,?,0)")
          .run(this.quotaKey, this.rootBinding, PILOT_SKILL)
      })
      const dbFd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try { fsyncSync(dbFd) } finally { closeSync(dbFd) }
      const dirFd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
      try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      this.#validate(db)
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  #connect(): Database { return this.#open(false) }
  #read(): Database { return this.#open(true) }

  putPrepared(seed: RunSeed): number {
    const db = this.#connect()
    let clockUncertain = false
    try {
      const revision = transaction(db, () => {
        this.#observeClock(db, seed.clock)
        let quota = this.#quota(db)
        if (quota.clock_uncertain === 1) {
          const fenceCont = quota.fence_cont === null ? undefined : BigInt(quota.fence_cont)
          const currentCont = seed.clock.continuous.toString()
          const currentWall = seed.clock.wall.toString()
          if (quota.pending_request_id || quota.active_run_id || quota.fence_boot !== seed.clock.boot || fenceCont === undefined ||
              seed.clock.continuous < fenceCont || seed.clock.continuous - fenceCont < DAILY_COOLDOWN_NS ||
              quota.clock_boot !== seed.clock.boot || quota.clock_cont !== currentCont || quota.clock_wall !== currentWall) {
            clockUncertain = true
            return undefined
          }
          const cleared = db.query(`UPDATE quota SET clock_uncertain=0,revision=revision+1
            WHERE singleton=1 AND clock_uncertain=1 AND fence_boot=? AND fence_cont=? AND clock_boot=? AND clock_cont=? AND clock_wall=?
              AND active_run_id IS NULL AND pending_request_id IS NULL`)
            .run(seed.clock.boot, fenceCont.toString(), seed.clock.boot, currentCont, currentWall)
          if (cleared.changes !== 1) { clockUncertain = true; return undefined }
          quota = this.#quota(db)
        }
        if (quota.pending_request_id) fail("dispatch-pending")
        if (quota.active_run_id) fail("active-run")
        db.query(`INSERT INTO runs(run_id,campaign_hash,campaign_id,owner_session_hash,owner_epoch_hash,owner_session_id,owner_epoch,admission_hash,binding_hash,
          dataset_hash,data_hash,model_hash,protocol_hash,baseline_hash,created_boot,created_cont,created_wall,
          expires_boot,expires_cont,expires_wall,state,revision,fixture_bytes)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PREPARED',1,?)`)
          .run(seed.runId, seed.campaignHash, seed.campaignId, seed.ownerSessionHash, seed.ownerEpochHash, seed.ownerSessionId,
            seed.ownerEpoch, seed.admissionHash, seed.bindingHash,
            seed.datasetHash, seed.dataHash, seed.modelHash, seed.protocolHash, seed.baselineHash,
            seed.clock.boot, seed.clock.continuous.toString(), seed.clock.wall.toString(), seed.clock.boot,
            seed.expiresCont.toString(), seed.expiresWall.toString(), seed.fixtureBytes)
        db.query("INSERT INTO usage(run_id,fixture_bytes) VALUES(?,?)").run(seed.runId, seed.fixtureBytes)
        const saved = db.query("SELECT revision FROM runs WHERE run_id=?").get(seed.runId) as { revision: number } | undefined
        if (!saved) fail("storage-corrupt")
        return saved.revision
      })
      if (clockUncertain) fail("clock-uncertain")
      if (revision === undefined) fail("transaction-failed")
      return revision
    } finally { db.close() }
  }

  putConsent(input: { runId: string; expectedRevision: number; consentId: string; subjectHash: string; scheduleSha256: string; bindingHash: string; ownerSessionHash: string; ownerEpochHash: string; admissionHash: string; clock: ClockValues; expiresCont: bigint; expiresWall: bigint }): number {
    const db = this.#connect()
    let clockUncertain = false
    try {
      const revision = transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return undefined }
        const run = db.query("SELECT state,revision,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash FROM runs WHERE run_id=?")
          .get(input.runId) as Record<string, unknown> | undefined
        if (!run || run.state !== "PREPARED" || run.revision !== input.expectedRevision || run.binding_hash !== input.bindingHash ||
            run.owner_session_hash !== input.ownerSessionHash || run.owner_epoch_hash !== input.ownerEpochHash || run.admission_hash !== input.admissionHash) fail("revision-conflict")
        if (!asHash(input.scheduleSha256)) fail("binding-invalid")
        db.query(`INSERT INTO consents(consent_id,run_id,subject_hash,schedule_hash,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          created_boot,created_cont,created_wall,expires_boot,expires_cont,expires_wall,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'valid')`)
          .run(input.consentId, input.runId, input.subjectHash, input.scheduleSha256, input.bindingHash, input.ownerSessionHash, input.ownerEpochHash,
            input.admissionHash, input.clock.boot, input.clock.continuous.toString(), input.clock.wall.toString(), input.clock.boot,
            input.expiresCont.toString(), input.expiresWall.toString())
        const updated = db.query(`UPDATE runs SET state='CONSENTED',reason_code=NULL,revision=revision+1
          WHERE run_id=? AND state='PREPARED' AND revision=? AND binding_hash=? AND owner_session_hash=? AND owner_epoch_hash=? AND admission_hash=?`)
          .run(input.runId, input.expectedRevision, input.bindingHash, input.ownerSessionHash, input.ownerEpochHash, input.admissionHash)
        if (updated.changes !== 1) fail("revision-conflict")
        const saved = db.query("SELECT revision FROM runs WHERE run_id=?").get(input.runId) as { revision: number } | undefined
        if (!saved) fail("storage-corrupt")
        return saved.revision
      })
      if (clockUncertain) fail("clock-uncertain")
      if (revision === undefined) fail("transaction-failed")
      return revision
    } finally { db.close() }
  }

  putArm(input: { runId: string; consentId: string; armId: string; watermarkHash: string; seenDigestHashes: readonly string[]; clock: ClockValues; expiresCont: bigint; expiresWall: bigint }): number {
    const db = this.#connect()
    let clockUncertain = false
    try {
      const revision = transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return undefined }
        const row = db.query(`SELECT c.state AS consent_state,c.expires_boot,c.expires_cont,c.expires_wall,c.binding_hash,
          r.state AS run_state,r.run_id FROM consents c JOIN runs r ON r.run_id=c.run_id WHERE c.consent_id=? AND c.run_id=?`)
          .get(input.consentId, input.runId) as Record<string, unknown> | undefined
        if (!row || row.consent_state !== "valid" || row.run_state !== "CONSENTED" || row.expires_boot !== input.clock.boot ||
            BigInt(String(row.expires_cont)) < input.clock.continuous || BigInt(String(row.expires_wall)) < input.clock.wall) fail("consent-expired")
        const existing = db.query("SELECT arm_id FROM arms WHERE run_id=?").get(input.runId)
        if (existing) fail("arm-consumed")
        db.query(`INSERT INTO arms(arm_id,run_id,consent_id,watermark_hash,seen_digest_hashes,armed_boot,armed_cont,armed_wall,
          expires_boot,expires_cont,expires_wall,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,'armed')`)
          .run(input.armId, input.runId, input.consentId, input.watermarkHash, JSON.stringify(input.seenDigestHashes),
            input.clock.boot, input.clock.continuous.toString(), input.clock.wall.toString(), input.clock.boot,
            input.expiresCont.toString(), input.expiresWall.toString())
        db.query("UPDATE runs SET state='ARMED',revision=revision+1 WHERE run_id=?").run(input.runId)
        const saved = db.query("SELECT revision FROM runs WHERE run_id=?").get(input.runId) as { revision: number } | undefined
        if (!saved) fail("storage-corrupt")
        return saved.revision
      })
      if (clockUncertain) fail("clock-uncertain")
      if (revision === undefined) fail("transaction-failed")
      return revision
    } finally { db.close() }
  }

  revokeArm(input: {
    runId: string; expectedRevision: number; ownerSessionHash: string; ownerEpochHash: string; admissionHash: string
    verifyOwner(): void
  }): void {
    const db = this.#connect()
    try {
      transaction(db, () => {
        const quota = this.#quota(db)
        if (quota.pending_request_id) fail("dispatch-pending")
        if (quota.active_run_id) fail("active-run")
        const runValue = db.query(`SELECT state,revision,owner_session_hash,owner_epoch_hash,admission_hash
          FROM runs WHERE run_id=?`).get(input.runId) as unknown
        if (!isRecord(runValue) || !hasExactKeys(runValue, ["state", "revision", "owner_session_hash", "owner_epoch_hash", "admission_hash"]) ||
            typeof runValue.state !== "string" || typeof runValue.revision !== "number" || !Number.isSafeInteger(runValue.revision) ||
            typeof runValue.owner_session_hash !== "string" || typeof runValue.owner_epoch_hash !== "string" ||
            typeof runValue.admission_hash !== "string") fail("storage-corrupt")
        if (runValue.owner_session_hash !== input.ownerSessionHash || runValue.owner_epoch_hash !== input.ownerEpochHash ||
            runValue.admission_hash !== input.admissionHash) fail("owner-unavailable")
        if (runValue.revision !== input.expectedRevision) fail("revision-conflict")
        if (runValue.state !== "ARMED") fail("run-stale")
        const attempts = db.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(input.runId) as { count: number }
        const requests = db.query("SELECT count(*) AS count FROM requests WHERE run_id=?").get(input.runId) as { count: number }
        if (!Number.isSafeInteger(attempts.count) || attempts.count !== 0 ||
            !Number.isSafeInteger(requests.count) || requests.count !== 0) fail("dispatch-pending")
        const arm = db.query("SELECT state FROM arms WHERE run_id=?").get(input.runId) as { state: string } | undefined
        if (!arm || arm.state !== "armed") fail("arm-consumed")
        input.verifyOwner()
        const revoked = db.query("UPDATE arms SET state='revoked' WHERE run_id=? AND state='armed'").run(input.runId)
        if (revoked.changes !== 1) fail("revision-conflict")
        db.query("UPDATE consents SET state='revoked' WHERE run_id=? AND state='valid'").run(input.runId)
        const updated = db.query(`UPDATE runs SET state='CANCELLED',reason_code='arm-consumed',revision=revision+1
          WHERE run_id=? AND state='ARMED' AND revision=? AND owner_session_hash=? AND owner_epoch_hash=? AND admission_hash=?`)
          .run(input.runId, input.expectedRevision, input.ownerSessionHash, input.ownerEpochHash, input.admissionHash)
        if (updated.changes !== 1) fail("revision-conflict")
      })
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  reserveAutomatic(input: ReserveSeed): { reservationId: string; requestId: string; revision: number } {
    if (input.newDigestHashes.length < MIN_NEW_DIGESTS) fail("digest-threshold")
    const reservationId = randomUUID()
    const requestId = randomUUID()
    const db = this.#connect()
    let clockUncertain = false
    let blocked: SkillOptReasonCode | undefined
    try {
      const result = transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return undefined }
        const quota = this.#quota(db)
        if (quota.clock_uncertain === 1) fail("clock-uncertain")
        if (quota.pending_request_id) { blocked = "dispatch-pending"; return undefined }
        if (quota.active_run_id) { blocked = "active-run"; return undefined }
        const run = db.query(`SELECT state,revision,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        const consent = db.query(`SELECT state,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM consents WHERE consent_id=? AND run_id=?`)
          .get(input.consentId, input.runId) as Record<string, unknown> | undefined
        const arm = db.query(`SELECT state,consent_id,watermark_hash,seen_digest_hashes,expires_boot,expires_cont,expires_wall
          FROM arms WHERE arm_id=? AND run_id=?`).get(input.armId, input.runId) as Record<string, unknown> | undefined
        if (!run || !consent || !arm) fail("arm-required")
        if (run.revision !== input.expectedRevision || run.state !== "ARMED") fail("revision-conflict")
        if (run.binding_hash !== input.bindingHash || consent.binding_hash !== input.bindingHash) fail("consent-binding-drift")
        if (run.owner_session_hash !== input.ownerSessionHash || run.owner_epoch_hash !== input.ownerEpochHash || run.admission_hash !== input.admissionHash ||
            consent.owner_session_hash !== input.ownerSessionHash || consent.owner_epoch_hash !== input.ownerEpochHash || consent.admission_hash !== input.admissionHash) fail("owner-unavailable")
        if (consent.state !== "valid" || consent.expires_boot !== input.clock.boot ||
            BigInt(String(consent.expires_cont)) < input.clock.continuous || BigInt(String(consent.expires_wall)) < input.clock.wall) fail("consent-expired")
        if (arm.state !== "armed" || arm.consent_id !== input.consentId) fail("arm-consumed")
        if (arm.expires_boot !== input.clock.boot || BigInt(String(arm.expires_cont)) < input.clock.continuous || BigInt(String(arm.expires_wall)) < input.clock.wall) fail("arm-expired")
        if (BigInt(String(run.expires_wall)) < input.clock.wall || run.expires_boot !== input.clock.boot) fail("run-expired")
        const existingSeen = new Set(JSON.parse(String(arm.seen_digest_hashes)) as string[])
        if (input.newDigestHashes.some((hash) => !HASH.test(hash) || existingSeen.has(hash)) || new Set(input.newDigestHashes).size !== input.newDigestHashes.length) fail("digest-threshold")
        if (!this.#enforceCooldown(db, input.clock)) { blocked = "daily-limit"; return undefined }
        this.#chargeRequest(db, input.runId, input.role, input.phase, input.clock)
        input.fault?.("after-counter-charge")
        db.query(`UPDATE arms SET state='consumed',reservation_id=? WHERE arm_id=? AND state='armed'`)
          .run(reservationId, input.armId)
        input.fault?.("after-arm-consume")
        db.query(`INSERT INTO attempts(reservation_id,run_id,arm_id,trigger_kind,request_id,owner_session_hash,owner_epoch_hash,
          charged,actual_dispatch,dispatch_state,created_boot,created_cont,created_wall)
          VALUES(?,?,?,'automatic',?,?,?,1,NULL,'possible',?,?,?)`)
          .run(reservationId, input.runId, input.armId, requestId, input.ownerSessionHash, input.ownerEpochHash,
            input.clock.boot, input.clock.continuous.toString(), input.clock.wall.toString())
        input.fault?.("after-attempt-insert")
        db.query(`INSERT INTO requests(request_id,run_id,reservation_id,role,phase,binding_hash,owner_epoch_hash,
          charged,actual_dispatch,dispatch_state,created_boot,created_cont,created_wall)
          VALUES(?,?,?,?,?,?,?,1,NULL,'possible',?,?,?)`)
          .run(requestId, input.runId, reservationId, input.role, input.phase, input.bindingHash, input.ownerEpochHash,
            input.clock.boot, input.clock.continuous.toString(), input.clock.wall.toString())
        const nextRevision = Number(run.revision) + 1
        db.query(`UPDATE runs SET state='RESERVED',revision=?,reason_code=NULL WHERE run_id=?`).run(nextRevision, input.runId)
        db.query(`UPDATE quota SET revision=revision+1,active_run_id=?,active_owner_session_hash=?,active_owner_epoch_hash=?,
          pending_request_id=?,last_attempt_id=?,last_attempt_boot=?,last_attempt_cont=? WHERE singleton=1`)
          .run(input.runId, input.ownerSessionHash, input.ownerEpochHash, requestId, reservationId, input.clock.boot, input.clock.continuous.toString())
        input.fault?.("before-commit")
        return { reservationId, requestId, revision: nextRevision }
      })
      if (clockUncertain) fail("clock-uncertain")
      if (blocked) fail(blocked)
      if (!result) fail("transaction-failed")
      input.fault?.("after-commit")
      return result
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally {
      db.close()
    }
  }

  reserveManual(input: ReserveManualSeed): { reservationId: string; requestId: string; revision: number } {
    const reservationId = randomUUID()
    const requestId = randomUUID()
    const db = this.#connect()
    let clockUncertain = false
    let blocked: SkillOptReasonCode | undefined
    try {
      const result = transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return undefined }
        const quota = this.#quota(db)
        if (quota.clock_uncertain === 1) fail("clock-uncertain")
        if (quota.pending_request_id) { blocked = "dispatch-pending"; return undefined }
        if (quota.active_run_id) { blocked = "active-run"; return undefined }
        const run = db.query(`SELECT state,revision,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        const consent = db.query(`SELECT state,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM consents WHERE consent_id=? AND run_id=?`)
          .get(input.consentId, input.runId) as Record<string, unknown> | undefined
        if (!run || !consent) fail("consent-required")
        if (run.revision !== input.expectedRevision || run.state !== "CONSENTED") fail("revision-conflict")
        if (run.binding_hash !== input.bindingHash || consent.binding_hash !== input.bindingHash) fail("consent-binding-drift")
        if (run.owner_session_hash !== input.ownerSessionHash || run.owner_epoch_hash !== input.ownerEpochHash || run.admission_hash !== input.admissionHash ||
            consent.owner_session_hash !== input.ownerSessionHash || consent.owner_epoch_hash !== input.ownerEpochHash || consent.admission_hash !== input.admissionHash) fail("owner-unavailable")
        if (consent.state !== "valid" || consent.expires_boot !== input.clock.boot ||
            BigInt(String(consent.expires_cont)) < input.clock.continuous || BigInt(String(consent.expires_wall)) < input.clock.wall) fail("consent-expired")
        if (run.expires_boot !== input.clock.boot || BigInt(String(run.expires_cont)) < input.clock.continuous ||
            BigInt(String(run.expires_wall)) < input.clock.wall) fail("run-expired")
        if (db.query("SELECT 1 FROM attempts WHERE run_id=?").get(input.runId)) fail("daily-limit")
        if (!this.#enforceCooldown(db, input.clock)) { blocked = "daily-limit"; return undefined }
        this.#chargeRequest(db, input.runId, input.role, input.phase, input.clock)
        db.query(`INSERT INTO attempts(reservation_id,run_id,arm_id,trigger_kind,request_id,owner_session_hash,owner_epoch_hash,
          charged,actual_dispatch,dispatch_state,created_boot,created_cont,created_wall)
          VALUES(?,?,NULL,'manual',?,?,?,1,NULL,'possible',?,?,?)`)
          .run(reservationId, input.runId, requestId, input.ownerSessionHash, input.ownerEpochHash,
            input.clock.boot, input.clock.continuous.toString(), input.clock.wall.toString())
        db.query(`INSERT INTO requests(request_id,run_id,reservation_id,role,phase,binding_hash,owner_epoch_hash,
          charged,actual_dispatch,dispatch_state,created_boot,created_cont,created_wall)
          VALUES(?,?,?,?,?,?,?,1,NULL,'possible',?,?,?)`)
          .run(requestId, input.runId, reservationId, input.role, input.phase, input.bindingHash, input.ownerEpochHash,
            input.clock.boot, input.clock.continuous.toString(), input.clock.wall.toString())
        const nextRevision = Number(run.revision) + 1
        db.query("UPDATE runs SET state='RESERVED',revision=?,reason_code=NULL WHERE run_id=?").run(nextRevision, input.runId)
        db.query(`UPDATE quota SET revision=revision+1,active_run_id=?,active_owner_session_hash=?,active_owner_epoch_hash=?,
          pending_request_id=?,last_attempt_id=?,last_attempt_boot=?,last_attempt_cont=? WHERE singleton=1`)
          .run(input.runId, input.ownerSessionHash, input.ownerEpochHash, requestId, reservationId, input.clock.boot, input.clock.continuous.toString())
        return { reservationId, requestId, revision: nextRevision }
      })
      if (clockUncertain) fail("clock-uncertain")
      if (blocked) fail(blocked)
      if (!result) fail("transaction-failed")
      return result
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  nativeTrainerProtocolEventCount(runId: string): number {
    if (!UUID.test(runId)) fail("binding-invalid")
    const db = this.#read()
    try {
      const row = db.query("SELECT count(*) AS count FROM trainer_protocol_events WHERE run_id=?").get(runId) as { count: number }
      if (!Number.isSafeInteger(row.count) || row.count < 0) fail("storage-corrupt")
      return row.count
    } finally { db.close() }
  }

  isInitialTrainerWarmupPending(input: { runId: string; owner: OwnerProof; ownerSessionID: string; ownerEpoch: string }): boolean {
    const db = this.#read()
    try {
      const row = db.query(`SELECT r.state,r.owner_session_id,r.owner_epoch,r.owner_session_hash,r.owner_epoch_hash,r.admission_hash,
        q.active_run_id,q.active_owner_session_hash,q.active_owner_epoch_hash,q.pending_request_id,
        req.request_id,req.role,req.phase,req.actual_dispatch,req.dispatch_state,
        a.trigger_kind,a.request_id AS attempt_request_id,a.actual_dispatch AS attempt_actual_dispatch,
        a.dispatch_state AS attempt_dispatch_state,
        (SELECT count(*) FROM requests WHERE run_id=r.run_id) AS request_count,
        (SELECT count(*) FROM attempts WHERE run_id=r.run_id) AS attempt_count
        FROM quota q JOIN runs r ON r.run_id=q.active_run_id JOIN requests req
          ON req.run_id=r.run_id AND req.request_id=q.pending_request_id
        LEFT JOIN attempts a ON a.run_id=r.run_id WHERE q.singleton=1 AND r.run_id=?`)
        .get(input.runId) as Record<string, unknown> | undefined
      return !!row && row.state === "RESERVED" && row.owner_session_id === input.ownerSessionID &&
        row.owner_epoch === input.ownerEpoch && row.owner_session_hash === input.owner.sessionHash &&
        row.owner_epoch_hash === input.owner.epochHash && row.admission_hash === input.owner.admissionHash &&
        row.active_run_id === input.runId && row.active_owner_session_hash === input.owner.sessionHash &&
        row.active_owner_epoch_hash === input.owner.epochHash && typeof row.pending_request_id === "string" &&
        row.request_id === row.pending_request_id && row.role === "target" && row.phase === "train" &&
        row.actual_dispatch === null && row.dispatch_state === "possible" &&
        (row.trigger_kind === "manual" || row.trigger_kind === "automatic") && row.attempt_request_id === row.request_id &&
        row.attempt_actual_dispatch === null && row.attempt_dispatch_state === "possible" &&
        row.request_count === 1 && row.attempt_count === 1
    } finally { db.close() }
  }

  persistNativeTrainerProtocolEvent(input: {
    event: NativeTrainerProtocolEventBinding
    owner: OwnerProof
    ownerSessionID: string
    ownerEpoch: string
    hashes: ReturnType<typeof skillOptBindingHashes>
    scheduleSha256: string
    clock: ClockValues
    verifyCurrent(): { owner: OwnerProof; hashes: ReturnType<typeof skillOptBindingHashes>; clock: ClockValues }
  }): void {
    const event = input.event
    if (!UUID.test(event.runId) || !/^[0-9a-f-]{36}:(?:optimizer:)?[1-9][0-9]{0,5}$/iu.test(event.wireRequestId) ||
        !asHash(event.workerProfileSha256) || !Number.isSafeInteger(event.ordinal) || event.ordinal < 1 ||
        !asHash(event.rawLineSha256) || !asHash(input.scheduleSha256)) fail("binding-invalid")
    const storedShape: NativeTrainerProtocolEventRow = {
      run_id: event.runId, wire_request_id: event.wireRequestId, worker_profile_sha256: event.workerProfileSha256,
      receipt_binding_sha256: event.receiptBindingSha256,
      ordinal: event.ordinal, raw_line_sha256: event.rawLineSha256, kind: event.kind, cohort: event.cohort,
      case_id: event.caseId, replicate: event.replicate, fragment_sha256: event.fragmentSha256,
      optimizer_stage: event.optimizerStage, prompt_sha256: event.promptSha256,
    }
    if (!isStoredTrainerProtocolEventRow(storedShape)) fail("binding-invalid")
    const db = this.#connect()
    let clockUncertain = false
    try {
      transaction(db, () => {
        const current = input.verifyCurrent()
        if (!isDeepStrictEqual(current.owner, input.owner) || !isDeepStrictEqual(current.hashes, input.hashes) ||
            current.clock.boot !== input.clock.boot || current.clock.continuous < input.clock.continuous || current.clock.wall < input.clock.wall) {
          fail("consent-binding-drift")
        }
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return }
        const quota = this.#quota(db)
        const runValue = db.query("SELECT * FROM runs WHERE run_id=?").get(event.runId) as unknown
        if (!isStoredRunRow(runValue)) fail("storage-corrupt")
        const run = runValue
        const countRow = db.query("SELECT count(*) AS count FROM trainer_protocol_events WHERE run_id=?").get(event.runId) as { count: number }
        if (!Number.isSafeInteger(countRow.count) || countRow.count < 0) fail("storage-corrupt")
        if (countRow.count !== event.ordinal - 1) fail("recovery-unresolved")
        if (run.state !== "RUNNING" || run.run_id !== event.runId || run.owner_session_id !== input.ownerSessionID ||
            run.owner_epoch !== input.ownerEpoch || run.owner_session_hash !== input.owner.sessionHash ||
            run.owner_epoch_hash !== input.owner.epochHash || run.admission_hash !== input.owner.admissionHash) fail("owner-unavailable")
        if (run.binding_hash !== input.hashes.bindingSha256 || run.dataset_hash !== input.hashes.datasetSha256 ||
            run.data_hash !== input.hashes.dataSha256 || run.model_hash !== input.hashes.modelBindingsSha256 ||
            run.protocol_hash !== input.hashes.protocolSha256 || run.baseline_hash !== input.hashes.baselineSkillSha256) {
          fail("consent-binding-drift")
        }
        if (run.expires_boot !== input.clock.boot || boundedClockDecimal(run.expires_cont) === undefined ||
            boundedClockDecimal(run.expires_wall) === undefined || BigInt(run.expires_cont) < input.clock.continuous ||
            BigInt(run.expires_wall) < input.clock.wall) fail("run-expired")
        if (quota.clock_uncertain !== 0) fail("clock-uncertain")
        if (quota.pending_request_id !== null) fail("dispatch-pending")
        if (quota.active_run_id !== event.runId || quota.active_owner_session_hash !== input.owner.sessionHash ||
            quota.active_owner_epoch_hash !== input.owner.epochHash) fail("active-run")
        const consent = db.query(`SELECT state,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,expires_boot,expires_cont,expires_wall,schedule_hash
          FROM consents WHERE run_id=?`).get(event.runId) as Record<string, unknown> | undefined
        if (!consent || consent.state !== "valid" || consent.binding_hash !== input.hashes.bindingSha256 ||
            consent.owner_session_hash !== input.owner.sessionHash || consent.owner_epoch_hash !== input.owner.epochHash ||
            consent.admission_hash !== input.owner.admissionHash || consent.schedule_hash !== input.scheduleSha256 ||
            consent.expires_boot !== input.clock.boot || boundedClockDecimal(consent.expires_cont) === undefined ||
            boundedClockDecimal(consent.expires_wall) === undefined || BigInt(String(consent.expires_cont)) < input.clock.continuous ||
            BigInt(String(consent.expires_wall)) < input.clock.wall) fail("consent-expired")
        const finalCurrent = input.verifyCurrent()
        if (!isDeepStrictEqual(finalCurrent.owner, input.owner)) fail("owner-unavailable")
        if (!isDeepStrictEqual(finalCurrent.hashes, input.hashes)) fail("consent-binding-drift")
        if (finalCurrent.clock.boot !== input.clock.boot || finalCurrent.clock.continuous < input.clock.continuous ||
            finalCurrent.clock.wall < input.clock.wall) fail("clock-uncertain")
        if (!this.#observeClock(db, finalCurrent.clock)) { clockUncertain = true; return }
        db.query(`INSERT INTO trainer_protocol_events(run_id,wire_request_id,worker_profile_sha256,receipt_binding_sha256,ordinal,
          raw_line_sha256,kind,cohort,case_id,replicate,fragment_sha256,optimizer_stage,prompt_sha256)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(event.runId, event.wireRequestId, event.workerProfileSha256, event.receiptBindingSha256,
            event.ordinal, event.rawLineSha256, event.kind,
            event.cohort, event.caseId, event.replicate, event.fragmentSha256, event.optimizerStage, event.promptSha256)
      })
      if (clockUncertain) fail("clock-uncertain")
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  markTrainerProtocolRecoveryUnresolved(input: { runId: string; owner: OwnerProof; requirePersistedEvents?: boolean }): void {
    const db = this.#connect()
    try {
      transaction(db, () => {
        const quota = this.#quota(db)
        const run = db.query("SELECT state,revision,owner_session_hash,owner_epoch_hash,admission_hash FROM runs WHERE run_id=?")
          .get(input.runId) as Record<string, unknown> | undefined
        const count = db.query("SELECT count(*) AS count FROM trainer_protocol_events WHERE run_id=?")
          .get(input.runId) as { count: number }
        if (!run || typeof run.revision !== "number" || !Number.isSafeInteger(run.revision) ||
            !Number.isSafeInteger(count.count) || count.count < 0 ||
            (input.requirePersistedEvents && count.count < 1) ||
            run.owner_session_hash !== input.owner.sessionHash || run.owner_epoch_hash !== input.owner.epochHash ||
            run.admission_hash !== input.owner.admissionHash || quota.active_run_id !== input.runId || quota.pending_request_id !== null ||
            quota.active_owner_session_hash !== input.owner.sessionHash || quota.active_owner_epoch_hash !== input.owner.epochHash) {
          fail("recovery-unresolved")
        }
        const reason = db.query("SELECT reason_code FROM runs WHERE run_id=?").get(input.runId) as { reason_code: string | null } | undefined
        if (run.state === "UNRESOLVED" && reason?.reason_code === "recovery-unresolved") return
        if (run.state !== "RUNNING") fail("recovery-unresolved")
        const updated = db.query(`UPDATE runs SET state='UNRESOLVED',reason_code='recovery-unresolved',revision=revision+1
          WHERE run_id=? AND state='RUNNING' AND revision=? AND owner_session_hash=? AND owner_epoch_hash=? AND admission_hash=?`)
          .run(input.runId, run.revision, input.owner.sessionHash, input.owner.epochHash, input.owner.admissionHash)
        if (updated.changes !== 1) fail("revision-conflict")
      })
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  reserveRequest(input: { runId: string; consentId: string; ownerSessionHash: string; ownerEpochHash: string; admissionHash: string;
    bindingHash: string; role: SkillOptRequestRole; phase: SkillOptRequestPhase; clock: ClockValues;
    protocolEvent?: NativeTrainerProtocolEventBinding }): { reservationId: string; requestId: string } {
    const requestId = randomUUID()
    const reservationId = randomUUID()
    const db = this.#connect()
    let clockUncertain = false
    try {
      transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return }
        const quota = this.#quota(db)
        if (quota.clock_uncertain === 1) fail("clock-uncertain")
        if (quota.active_run_id !== input.runId || quota.pending_request_id) fail(quota.pending_request_id ? "dispatch-pending" : "active-run")
        const run = db.query(`SELECT state,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,expires_boot,expires_wall,artifact_bytes
          FROM runs WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        if (!run || run.binding_hash !== input.bindingHash || run.owner_session_hash !== input.ownerSessionHash ||
            run.owner_epoch_hash !== input.ownerEpochHash || run.admission_hash !== input.admissionHash) fail("binding-data-drift")
        const consent = db.query(`SELECT state,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,expires_boot,expires_cont,expires_wall
          FROM consents WHERE consent_id=? AND run_id=?`).get(input.consentId, input.runId) as Record<string, unknown> | undefined
        if (!consent || consent.state !== "valid" || consent.binding_hash !== input.bindingHash ||
            consent.owner_session_hash !== input.ownerSessionHash || consent.owner_epoch_hash !== input.ownerEpochHash ||
            consent.admission_hash !== input.admissionHash || consent.expires_boot !== input.clock.boot ||
            BigInt(String(consent.expires_cont)) < input.clock.continuous || BigInt(String(consent.expires_wall)) < input.clock.wall) fail("consent-expired")
        if (run.state !== "RUNNING" && run.state !== "DISPATCH_PENDING") fail("run-stale")
        if (run.expires_boot !== input.clock.boot || BigInt(String(run.expires_wall)) < input.clock.wall) fail("run-expired")
        if (input.protocolEvent) {
          const expectedRole = input.protocolEvent.kind === "optimizer" ? "optimizer" : "target"
          const expectedPhase = input.protocolEvent.kind === "optimizer" || input.protocolEvent.cohort === "training" ? "train" : "dev"
          const eventValue = db.query("SELECT * FROM trainer_protocol_events WHERE run_id=? AND wire_request_id=?")
            .get(input.protocolEvent.runId, input.protocolEvent.wireRequestId) as unknown
          if (input.protocolEvent.runId !== input.runId || input.role !== expectedRole || input.phase !== expectedPhase ||
              !isStoredTrainerProtocolEventRow(eventValue) || !trainerProtocolEventRowMatches(eventValue, input.protocolEvent) ||
              db.query("SELECT 1 FROM trainer_protocol_dispatches WHERE run_id=? AND wire_request_id=?")
                .get(input.runId, input.protocolEvent.wireRequestId)) fail("dispatch-not-authorized")
        }
        this.#chargeRequest(db, input.runId, input.role, input.phase, input.clock)
        const reviewerCaptureBytes = input.role === "reviewer" && (input.phase === "final" || input.phase === "safety")
          ? NATIVE_REVIEWER_CAPTURE_RESERVATION_BYTES : 0
        if (reviewerCaptureBytes > 0) {
          // This debit, its opaque request/reservation row, and the pending dispatch slot commit or roll back together.
          const usage = db.query("SELECT artifact_bytes FROM usage WHERE run_id=?").get(input.runId) as
            { artifact_bytes: number } | undefined
          if (!usage || !Number.isSafeInteger(usage.artifact_bytes) || usage.artifact_bytes < 0 ||
              !Number.isSafeInteger(run.artifact_bytes) || Number(run.artifact_bytes) < 0 ||
              usage.artifact_bytes !== run.artifact_bytes) fail("storage-corrupt")
          if (usage.artifact_bytes + reviewerCaptureBytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) fail("budget-exhausted")
          const updatedUsage = db.query(`UPDATE usage SET artifact_bytes=artifact_bytes+?
            WHERE run_id=? AND artifact_bytes=?`).run(reviewerCaptureBytes, input.runId, usage.artifact_bytes)
          if (updatedUsage.changes !== 1) fail("revision-conflict")
        }
        db.query(`INSERT INTO requests(request_id,run_id,reservation_id,role,phase,binding_hash,owner_epoch_hash,
          charged,actual_dispatch,dispatch_state,created_boot,created_cont,created_wall)
          VALUES(?,?,?,?,?,?,?,1,NULL,'possible',?,?,?)`)
          .run(requestId, input.runId, reservationId, input.role, input.phase, input.bindingHash, input.ownerEpochHash,
            input.clock.boot, input.clock.continuous.toString(), input.clock.wall.toString())
        if (input.protocolEvent) {
          db.query("INSERT INTO trainer_protocol_dispatches(run_id,wire_request_id,native_request_id) VALUES(?,?,?)")
            .run(input.runId, input.protocolEvent.wireRequestId, requestId)
        }
        const updatedRun = reviewerCaptureBytes > 0
          ? db.query(`UPDATE runs SET state='RESERVED',revision=revision+1,artifact_bytes=artifact_bytes+?
              WHERE run_id=? AND artifact_bytes=?`).run(reviewerCaptureBytes, input.runId, Number(run.artifact_bytes))
          : db.query("UPDATE runs SET state='RESERVED',revision=revision+1 WHERE run_id=?").run(input.runId)
        if (updatedRun.changes !== 1) fail("revision-conflict")
        db.query("UPDATE quota SET pending_request_id=?,revision=revision+1 WHERE singleton=1").run(requestId)
      })
      if (clockUncertain) fail("clock-uncertain")
      return { reservationId, requestId }
    } finally { db.close() }
  }

  recordDispatch(input: { requestId: string; reservationId: string; runId: string; ownerSessionHash: string; ownerEpochHash: string;
    ownerAdmissionHash: string; observation: SkillOptDispatchObservation; clock: ClockValues; canaryOperation?: "apply" | "rollback" }): void {
    const db = this.#connect()
    try {
      transaction(db, () => {
        this.#observeClock(db, input.clock)
        const row = db.query(`SELECT dispatch_state,actual_dispatch,reference_json,owner_epoch_hash,role,phase FROM requests
          WHERE request_id=? AND reservation_id=? AND run_id=?`).get(input.requestId, input.reservationId, input.runId) as Record<string, unknown> | undefined
        const runOwner = db.query("SELECT owner_session_hash,owner_epoch_hash,admission_hash FROM runs WHERE run_id=?")
          .get(input.runId) as Record<string, unknown> | undefined
        const canaryRequest = row?.role === "target" && row.phase === "canary"
        const handoff = canaryRequest
          ? input.canaryOperation === "apply"
            ? db.query(`SELECT loader_session_hash,loader_epoch_hash,loader_admission_hash,request_id,state FROM canary_handoffs
              WHERE run_id=? AND operation='apply'`).get(input.runId) as Record<string, unknown> | undefined
            : input.canaryOperation === "rollback"
              ? db.query(`SELECT loader_session_hash,loader_epoch_hash,loader_admission_hash,request_id,state FROM canary_handoffs
                WHERE run_id=? AND operation='rollback'`).get(input.runId) as Record<string, unknown> | undefined
              : undefined
          : undefined
        const canaryOwnerMatches = !!handoff && handoff.request_id === input.requestId && handoff.state === "reserved" &&
          handoff.loader_session_hash === input.ownerSessionHash && handoff.loader_epoch_hash === input.ownerEpochHash &&
          handoff.loader_admission_hash === input.ownerAdmissionHash
        const campaignOwnerMatches = !!runOwner && runOwner.owner_session_hash === input.ownerSessionHash &&
          runOwner.owner_epoch_hash === input.ownerEpochHash && runOwner.admission_hash === input.ownerAdmissionHash
        if (!row || !runOwner || row.owner_epoch_hash !== input.ownerEpochHash ||
            !(canaryRequest ? canaryOwnerMatches : campaignOwnerMatches) ||
            row.dispatch_state !== "possible") fail("dispatch-not-authorized")
        let state: string
        let actual: number | null
        let referenceJson: string | null = null
        if (input.observation.state === "not-dispatched") {
          state = "not_dispatched"
          actual = 0
        } else if (input.observation.state === "launched") {
          this.#validateReference(input.observation.reference, input.requestId)
          state = "launched"
          actual = 1
          referenceJson = JSON.stringify(input.observation.reference)
        } else {
          if (input.observation.reference) {
            this.#validateReference(input.observation.reference, input.requestId)
            referenceJson = JSON.stringify(input.observation.reference)
          }
          state = "unknown"
          actual = null
        }
        const requestUpdated = db.query(`UPDATE requests SET dispatch_state=?,actual_dispatch=?,reference_json=? WHERE request_id=?`)
          .run(state, actual, referenceJson, input.requestId)
        db.query(`UPDATE attempts SET dispatch_state=?,actual_dispatch=? WHERE request_id=?`)
          .run(state, actual, input.requestId)
        if (requestUpdated.changes !== 1) fail("revision-conflict")
        if (handoff) {
          const handoffState = state === "not_dispatched" ? "not_dispatched" : state === "launched" ? "launched" : "unresolved"
          const handoffUpdated = input.canaryOperation === "apply"
            ? db.query("UPDATE canary_handoffs SET state=? WHERE run_id=? AND operation='apply' AND request_id=? AND state='reserved'")
              .run(handoffState, input.runId, input.requestId)
            : db.query("UPDATE canary_handoffs SET state=? WHERE run_id=? AND operation='rollback' AND request_id=? AND state='reserved'")
              .run(handoffState, input.runId, input.requestId)
          if (handoffUpdated.changes !== 1) fail("dispatch-ambiguous")
        }
        if (state === "not_dispatched") {
          const usage = db.query("SELECT active_reserved_ms FROM usage WHERE run_id=?").get(input.runId) as { active_reserved_ms: number } | undefined
          const reserved = db.query("SELECT active_reserved_ms FROM requests WHERE request_id=?").get(input.requestId) as { active_reserved_ms: number } | undefined
          if (!usage || !reserved || usage.active_reserved_ms < reserved.active_reserved_ms) fail("storage-corrupt")
          db.query("UPDATE usage SET active_reserved_ms=active_reserved_ms-? WHERE run_id=?").run(reserved.active_reserved_ms, input.runId)
          db.query("UPDATE requests SET active_reserved_ms=0 WHERE request_id=?").run(input.requestId)
          if (input.canaryOperation === "rollback") {
            const quotaUpdated = db.query("UPDATE quota SET pending_request_id=NULL,revision=revision+1 WHERE singleton=1 AND active_run_id=? AND pending_request_id=?")
              .run(input.runId, input.requestId)
            const runUpdated = db.query("UPDATE runs SET state='UNRESOLVED',reason_code='rollback-canary-not-dispatched',revision=revision+1 WHERE run_id=? AND state='RESERVED'")
              .run(input.runId)
            if (quotaUpdated.changes !== 1 || runUpdated.changes !== 1) fail("revision-conflict")
          } else {
            const quotaUpdated = db.query(`UPDATE quota SET pending_request_id=NULL,active_run_id=NULL,active_owner_session_hash=NULL,
              active_owner_epoch_hash=NULL,revision=revision+1 WHERE singleton=1 AND active_run_id=? AND pending_request_id=?`)
              .run(input.runId, input.requestId)
            const runUpdated = db.query("UPDATE runs SET state='CANCELLED',reason_code='dispatch-cancelled',revision=revision+1 WHERE run_id=?")
              .run(input.runId)
            if (quotaUpdated.changes !== 1 || runUpdated.changes !== 1) fail("revision-conflict")
          }
        } else {
          const runUpdated = db.query("UPDATE runs SET state=?,revision=revision+1 WHERE run_id=?")
            .run(state === "launched" ? "DISPATCH_PENDING" : "UNRESOLVED", input.runId)
          const quotaUpdated = db.query("UPDATE quota SET revision=revision+1 WHERE singleton=1 AND active_run_id=? AND pending_request_id=?")
            .run(input.runId, input.requestId)
          if (runUpdated.changes !== 1 || quotaUpdated.changes !== 1) fail("revision-conflict")
          if (state === "launched" && db.query("SELECT 1 FROM attempts WHERE request_id=?").get(input.requestId)) {
            db.query("UPDATE quota SET last_attempt_boot=?,last_attempt_cont=? WHERE singleton=1")
              .run(input.clock.boot, input.clock.continuous.toString())
          }
        }
      })
    } finally { db.close() }
  }

  attachRecoveryReference(runId: string, requestId: string, reference: ExecutionReference): void {
    this.#validateReference(reference, requestId)
    const db = this.#connect()
    try {
      transaction(db, () => {
        const quota = this.#quota(db)
        const row = db.query("SELECT dispatch_state FROM requests WHERE request_id=? AND run_id=?")
          .get(requestId, runId) as { dispatch_state: string } | undefined
        if (!row || quota.pending_request_id !== requestId || row.dispatch_state !== "possible") fail("recovery-unresolved")
        const referenceJson = JSON.stringify(reference)
        db.query("UPDATE requests SET dispatch_state='unknown',reference_json=? WHERE request_id=?").run(referenceJson, requestId)
        db.query("UPDATE attempts SET dispatch_state='unknown' WHERE request_id=?").run(requestId)
        db.query("UPDATE runs SET state='UNRESOLVED',reason_code='recovery-unresolved',revision=revision+1 WHERE run_id=?").run(runId)
        db.query("UPDATE quota SET revision=revision+1 WHERE singleton=1").run()
      })
    } finally { db.close() }
  }

  settleRecovered(input: { runId: string; requestId: string; clock: ClockValues; trainerProtocolCaptureLive: boolean }): void {
    const db = this.#connect()
    try {
      transaction(db, () => {
        // The dispatch was already made; recovery records reconciliation even if the clock is uncertain.
        this.#observeClock(db, input.clock)
        const row = db.query(`SELECT dispatch_state,actual_dispatch,created_boot,created_cont,active_reserved_ms FROM requests WHERE request_id=? AND run_id=?`)
          .get(input.requestId, input.runId) as Record<string, unknown> | undefined
        const quota = this.#quota(db)
        if (!row || quota.pending_request_id !== input.requestId || !["launched", "unknown"].includes(String(row.dispatch_state))) fail("recovery-unresolved")
        const usage = db.query("SELECT active_reserved_ms FROM usage WHERE run_id=?").get(input.runId) as { active_reserved_ms: number } | undefined
        const trainerEventCount = db.query("SELECT count(*) AS count FROM trainer_protocol_events WHERE run_id=?")
          .get(input.runId) as { count: number }
        if (!Number.isSafeInteger(trainerEventCount.count) || trainerEventCount.count < 0) fail("storage-corrupt")
        const reservedMs = Number(row.active_reserved_ms)
        if (!usage || reservedMs < 0 || usage.active_reserved_ms < reservedMs) fail("storage-corrupt")
        let elapsedMilliseconds: number = NATIVE_SKILLOPT_LIMITS.requestMilliseconds
        if (row.created_boot === input.clock.boot) {
          const elapsed = input.clock.continuous - BigInt(String(row.created_cont))
          if (elapsed < 0n) this.#latchClockUncertain(db, input.clock)
          else elapsedMilliseconds = Number((elapsed + 999_999n) / 1_000_000n)
        } else elapsedMilliseconds = NATIVE_SKILLOPT_LIMITS.activeMilliseconds
        db.query(`UPDATE requests SET dispatch_state='settled',actual_dispatch=1,finished_boot=?,finished_cont=?,terminal_class='reconciled',active_reserved_ms=0
          WHERE request_id=?`).run(input.clock.boot, input.clock.continuous.toString(), input.requestId)
        db.query("UPDATE attempts SET dispatch_state='settled',actual_dispatch=1 WHERE request_id=?").run(input.requestId)
        db.query("UPDATE usage SET active_ms=active_ms+?,active_reserved_ms=active_reserved_ms-? WHERE run_id=?")
          .run(elapsedMilliseconds, reservedMs, input.runId)
        db.query("UPDATE runs SET active_ms=active_ms+? WHERE run_id=?").run(elapsedMilliseconds, input.runId)
        db.query("UPDATE quota SET pending_request_id=NULL,active_run_id=?,revision=revision+1 WHERE singleton=1").run(input.runId)
        if (trainerEventCount.count > 0 && !input.trainerProtocolCaptureLive) {
          db.query(`UPDATE runs SET state='UNRESOLVED',reason_code='recovery-unresolved',revision=revision+1
            WHERE run_id=?`).run(input.runId)
        } else {
          db.query("UPDATE runs SET state='RUNNING',reason_code=NULL,revision=revision+1 WHERE run_id=?").run(input.runId)
        }
        // If the first launch acknowledgement was lost, start its conservative cooldown at recovery.
        if (db.query("SELECT 1 FROM attempts WHERE request_id=?").get(input.requestId)) {
          db.query("UPDATE quota SET last_attempt_boot=?,last_attempt_cont=? WHERE singleton=1")
            .run(input.clock.boot, input.clock.continuous.toString())
        }
      })
    } finally { db.close() }
  }

  finish(runId: string, ownerSessionHash: string, ownerEpochHash: string, state: "NO_GAIN" | "INCONCLUSIVE" | "FAILED" | "CANCELLED"): void {
    const db = this.#connect()
    try {
      transaction(db, () => {
        const quota = this.#quota(db)
        const run = db.query("SELECT state,owner_session_hash,owner_epoch_hash FROM runs WHERE run_id=?").get(runId) as Record<string, unknown> | undefined
        if (!run || run.owner_session_hash !== ownerSessionHash || run.owner_epoch_hash !== ownerEpochHash || quota.active_run_id !== runId || quota.pending_request_id) fail("run-stale")
        if ((state as string) === "COMPLETED") fail("run-stale")
        if (run.state === "AWAITING_CANDIDATE_APPROVAL") {
          if (state !== "FAILED" && state !== "CANCELLED") fail("run-stale")
        } else if (run.state !== "RUNNING" && run.state !== "CANCELLED") fail("run-stale")
        const usage = db.query("SELECT active_ms,active_reserved_ms FROM usage WHERE run_id=?").get(runId) as { active_ms: number; active_reserved_ms: number } | undefined
        if (state !== "FAILED" && state !== "CANCELLED" && (!usage || usage.active_ms + usage.active_reserved_ms > NATIVE_SKILLOPT_LIMITS.activeMilliseconds)) fail("budget-exhausted")
        db.query("UPDATE runs SET state=?,reason_code=NULL,revision=revision+1 WHERE run_id=?").run(state, runId)
        db.query("UPDATE quota SET active_run_id=NULL,active_owner_session_hash=NULL,active_owner_epoch_hash=NULL,revision=revision+1 WHERE singleton=1").run()
      })
    } finally { db.close() }
  }

  cancelUnstarted(input: {
    runId: string; expectedRevision: number; ownerSessionHash: string; ownerEpochHash: string; admissionHash: string
    verifyOwner(): void
  }): void {
    const db = this.#connect()
    try {
      transaction(db, () => {
        const quota = this.#quota(db)
        if (quota.pending_request_id) fail("dispatch-pending")
        if (quota.active_run_id) fail("active-run")
        const runValue = db.query(`SELECT state,revision,owner_session_hash,owner_epoch_hash,admission_hash
          FROM runs WHERE run_id=?`).get(input.runId) as unknown
        if (!isRecord(runValue) || !hasExactKeys(runValue, ["state", "revision", "owner_session_hash", "owner_epoch_hash", "admission_hash"]) ||
            typeof runValue.state !== "string" || typeof runValue.revision !== "number" || !Number.isSafeInteger(runValue.revision) ||
            typeof runValue.owner_session_hash !== "string" || typeof runValue.owner_epoch_hash !== "string" ||
            typeof runValue.admission_hash !== "string") fail("storage-corrupt")
        if (runValue.owner_session_hash !== input.ownerSessionHash || runValue.owner_epoch_hash !== input.ownerEpochHash ||
            runValue.admission_hash !== input.admissionHash) fail("owner-unavailable")
        if (runValue.revision !== input.expectedRevision) fail("revision-conflict")
        if (runValue.state !== "PREPARED" && runValue.state !== "CONSENTED") fail("run-stale")
        const attempts = db.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(input.runId) as { count: number }
        const requests = db.query("SELECT count(*) AS count FROM requests WHERE run_id=?").get(input.runId) as { count: number }
        if (!Number.isSafeInteger(attempts.count) || attempts.count !== 0 ||
            !Number.isSafeInteger(requests.count) || requests.count !== 0) fail("dispatch-pending")
        input.verifyOwner()
        const updated = db.query(`UPDATE runs SET state='CANCELLED',reason_code=NULL,revision=revision+1
          WHERE run_id=? AND state=? AND revision=? AND owner_session_hash=? AND owner_epoch_hash=? AND admission_hash=?`)
          .run(input.runId, runValue.state, input.expectedRevision, input.ownerSessionHash, input.ownerEpochHash, input.admissionHash)
        if (updated.changes !== 1) fail("revision-conflict")
        db.query("UPDATE consents SET state='revoked' WHERE run_id=? AND state='valid'").run(input.runId)
      })
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  awaitCandidateApproval(input: {
    runId: string; expectedRevision: number; bindingHash: string; scheduleSha256: string
    qualification: NativeCampaignQualificationBinding
    ownerSessionHash: string; ownerEpochHash: string; admissionHash: string; clock: ClockValues; verifyOwner(): void
  }): void {
    const db = this.#connect()
    let clockUncertain = false
    try {
      transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return }
        const quota = this.#quota(db)
        if (quota.clock_uncertain === 1) fail("clock-uncertain")
        if (quota.active_run_id !== input.runId || quota.active_owner_session_hash !== input.ownerSessionHash ||
            quota.active_owner_epoch_hash !== input.ownerEpochHash) fail("active-run")
        if (quota.pending_request_id) fail("dispatch-pending")
        const runValue = db.query(`SELECT state,revision,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?`).get(input.runId) as unknown
        if (!isAwaitingRunRow(runValue)) fail("storage-corrupt")
        const run = runValue
        if (run.revision !== input.expectedRevision) fail("revision-conflict")
        if (run.state !== "RUNNING") fail("run-stale")
        if (run.binding_hash !== input.bindingHash) fail("consent-binding-drift")
        if (run.owner_session_hash !== input.ownerSessionHash || run.owner_epoch_hash !== input.ownerEpochHash ||
            run.admission_hash !== input.admissionHash) fail("owner-unavailable")
        if (run.expires_boot !== input.clock.boot || BigInt(run.expires_cont) < input.clock.continuous ||
            BigInt(run.expires_wall) < input.clock.wall) fail("run-expired")
        const consentValue = db.query(`SELECT state,schedule_hash,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM consents WHERE run_id=?`).get(input.runId) as unknown
        if (!isAwaitingConsentRow(consentValue)) fail("consent-required")
        const consent = consentValue
        if (consent.state !== "valid" || consent.schedule_hash !== input.scheduleSha256 || consent.binding_hash !== input.bindingHash ||
            consent.owner_session_hash !== input.ownerSessionHash || consent.owner_epoch_hash !== input.ownerEpochHash ||
            consent.admission_hash !== input.admissionHash) fail("consent-binding-drift")
        if (consent.expires_boot !== input.clock.boot || BigInt(consent.expires_cont) < input.clock.continuous ||
            BigInt(consent.expires_wall) < input.clock.wall) fail("consent-expired")
        const usageValue = db.query("SELECT active_ms,active_reserved_ms FROM usage WHERE run_id=?").get(input.runId) as unknown
        if (!isRecord(usageValue) || !hasExactKeys(usageValue, ["active_ms", "active_reserved_ms"]) ||
            typeof usageValue.active_ms !== "number" || !Number.isSafeInteger(usageValue.active_ms) || usageValue.active_ms < 0 ||
            typeof usageValue.active_reserved_ms !== "number" || !Number.isSafeInteger(usageValue.active_reserved_ms) || usageValue.active_reserved_ms < 0) fail("storage-corrupt")
        if (usageValue.active_ms > NATIVE_SKILLOPT_LIMITS.activeMilliseconds) fail("budget-exhausted")
        if (usageValue.active_reserved_ms !== 0) fail("dispatch-pending")
        const unsettledValue = db.query(`SELECT count(*) AS count FROM requests WHERE run_id=? AND
          (actual_dispatch IS NULL OR dispatch_state NOT IN ('settled','not_dispatched'))`).get(input.runId) as unknown
        if (!isRecord(unsettledValue) || typeof unsettledValue.count !== "number" || !Number.isSafeInteger(unsettledValue.count) || unsettledValue.count !== 0) {
          fail("dispatch-pending")
        }
        input.verifyOwner()
        const updated = db.query(`UPDATE runs SET state='AWAITING_CANDIDATE_APPROVAL',reason_code=NULL,revision=revision+1
          WHERE run_id=? AND state='RUNNING' AND revision=? AND binding_hash=? AND owner_session_hash=? AND owner_epoch_hash=? AND admission_hash=?`)
          .run(input.runId, input.expectedRevision, input.bindingHash, input.ownerSessionHash, input.ownerEpochHash, input.admissionHash)
        if (updated.changes !== 1) fail("revision-conflict")
        const qualification = input.qualification
        if (qualification.runId !== input.runId || qualification.bindingSha256 !== input.bindingHash ||
            qualification.scheduleSha256 !== input.scheduleSha256 ||
            ![qualification.candidateSha256, qualification.resultsSha256, qualification.reviewSha256].every(asHash)) fail("binding-invalid")
        db.query(`INSERT INTO campaign_qualifications(run_id,binding_hash,schedule_hash,candidate_hash,results_hash,review_hash)
          VALUES(?,?,?,?,?,?)`).run(qualification.runId, qualification.bindingSha256, qualification.scheduleSha256,
          qualification.candidateSha256, qualification.resultsSha256, qualification.reviewSha256)
      })
      if (clockUncertain) fail("clock-uncertain")
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  beginNativeRollback(input: {
    runId: string; ownerSessionHash: string; ownerEpochHash: string; admissionHash: string
    binding: ReturnType<typeof skillOptBindingHashes>; scheduleSha256: string
    sourceSha256: string; fixturePackSha256: string; protocolSha256: string
    qualification: NativeCampaignQualificationBinding; promotionBindings: PromotionBindings
    approvalRecordSha256: string; expectedRevision: number; clock: ClockValues; verifyOwner(): void
  }): "COMPLETED" | "AWAITING_CANDIDATE_APPROVAL" {
    const db = this.#connect()
    let clockUncertain = false
    let sourceState: "COMPLETED" | "AWAITING_CANDIDATE_APPROVAL" | undefined
    try {
      transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return }
        const quota = this.#quota(db)
        if (quota.clock_uncertain === 1) fail("clock-uncertain")
        if (quota.pending_request_id) fail("dispatch-pending")
        if (quota.active_run_id && quota.active_run_id !== input.runId) fail("active-run")
        const run = db.query(`SELECT state,revision,binding_hash,dataset_hash,data_hash,model_hash,protocol_hash,baseline_hash,
          owner_session_hash,owner_epoch_hash,admission_hash,expires_boot,expires_cont,expires_wall
          FROM runs WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        if (!run || (run.state !== "COMPLETED" && run.state !== "AWAITING_CANDIDATE_APPROVAL") ||
            run.revision !== input.expectedRevision) fail("run-stale")
        sourceState = run.state
        if (run.binding_hash !== input.binding.bindingSha256 || run.dataset_hash !== input.binding.datasetSha256 ||
            run.data_hash !== input.binding.dataSha256 || run.model_hash !== input.binding.modelBindingsSha256 ||
            run.protocol_hash !== input.binding.protocolSha256 || run.baseline_hash !== input.binding.baselineSkillSha256 ||
            run.owner_session_hash !== input.ownerSessionHash || run.owner_epoch_hash !== input.ownerEpochHash ||
            run.admission_hash !== input.admissionHash) fail("consent-binding-drift")
        if (run.expires_boot !== input.clock.boot || BigInt(String(run.expires_cont)) < input.clock.continuous ||
            BigInt(String(run.expires_wall)) < input.clock.wall) fail("run-expired")
        if (sourceState === "COMPLETED") {
          if (quota.active_run_id !== null || quota.active_owner_session_hash !== null || quota.active_owner_epoch_hash !== null) fail("active-run")
        } else if (quota.active_run_id !== input.runId || quota.active_owner_session_hash !== input.ownerSessionHash ||
            quota.active_owner_epoch_hash !== input.ownerEpochHash) fail("active-run")
        const consent = db.query(`SELECT state,schedule_hash,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM consents WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        if (!consent || consent.state !== "valid" || consent.schedule_hash !== input.scheduleSha256 ||
            consent.binding_hash !== input.binding.bindingSha256 || consent.owner_session_hash !== input.ownerSessionHash ||
            consent.owner_epoch_hash !== input.ownerEpochHash || consent.admission_hash !== input.admissionHash ||
            consent.expires_boot !== input.clock.boot || BigInt(String(consent.expires_cont)) < input.clock.continuous ||
            BigInt(String(consent.expires_wall)) < input.clock.wall) fail("consent-expired")
        const qualification = db.query(`SELECT binding_hash,schedule_hash,candidate_hash,results_hash,review_hash
          FROM campaign_qualifications WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        const q = input.qualification
        const p = input.promotionBindings
        if (!qualification || qualification.binding_hash !== q.bindingSha256 || qualification.schedule_hash !== q.scheduleSha256 ||
            qualification.candidate_hash !== q.candidateSha256 || qualification.results_hash !== q.resultsSha256 ||
            qualification.review_hash !== q.reviewSha256 || q.runId !== input.runId || q.bindingSha256 !== input.binding.bindingSha256 ||
            q.scheduleSha256 !== input.scheduleSha256 || p.witnessMode !== "native" || p.runId !== input.runId ||
            p.originalSha256 !== input.binding.baselineSkillSha256 || p.candidateSha256 !== q.candidateSha256 ||
            p.resultsSha256 !== q.resultsSha256 || p.sourceSha256 !== input.sourceSha256 ||
            p.fixturePackSha256 !== input.fixturePackSha256 || p.protocolSha256 !== input.protocolSha256 ||
            !asHash(p.sourceSha256) || !asHash(input.approvalRecordSha256)) {
          fail("rollback-approval-binding-mismatch")
        }
        const usage = db.query(`SELECT target_requests,canary_requests,active_ms,active_reserved_ms
          FROM usage WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        if (!usage || ![usage.target_requests, usage.canary_requests, usage.active_ms, usage.active_reserved_ms]
          .every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) fail("storage-corrupt")
        if ((usage.target_requests as number) >= NATIVE_SKILLOPT_LIMITS.targetRequests ||
            (usage.canary_requests as number) >= CANARY_RESERVE ||
            (usage.active_ms as number) + (usage.active_reserved_ms as number) + NATIVE_SKILLOPT_LIMITS.requestMilliseconds >
              NATIVE_SKILLOPT_LIMITS.activeMilliseconds) fail("budget-exhausted")
        const unsettled = db.query(`SELECT count(*) AS count FROM requests WHERE run_id=? AND
          (actual_dispatch IS NULL OR dispatch_state NOT IN ('settled','not_dispatched'))`).get(input.runId) as { count: number }
        if (!Number.isSafeInteger(unsettled.count) || unsettled.count !== 0 || (usage.active_reserved_ms as number) !== 0) {
          fail("dispatch-pending")
        }
        if (db.query("SELECT 1 FROM canary_handoffs WHERE run_id=? AND operation='rollback'").get(input.runId)) fail("run-stale")
        input.verifyOwner()
        const runUpdated = db.query(`UPDATE runs SET state='AWAITING_ROLLBACK_CANARY',reason_code=NULL,revision=revision+1
          WHERE run_id=? AND state=? AND revision=? AND binding_hash=? AND owner_session_hash=? AND owner_epoch_hash=? AND admission_hash=?`)
          .run(input.runId, sourceState, input.expectedRevision, input.binding.bindingSha256,
            input.ownerSessionHash, input.ownerEpochHash, input.admissionHash)
        const quotaUpdated = db.query(`UPDATE quota SET active_run_id=?,active_owner_session_hash=?,active_owner_epoch_hash=?,revision=revision+1
          WHERE singleton=1 AND pending_request_id IS NULL AND
          ((active_run_id IS NULL AND active_owner_session_hash IS NULL AND active_owner_epoch_hash IS NULL) OR
           (active_run_id=? AND active_owner_session_hash=? AND active_owner_epoch_hash=?))`)
          .run(input.runId, input.ownerSessionHash, input.ownerEpochHash, input.runId, input.ownerSessionHash, input.ownerEpochHash)
        if (runUpdated.changes !== 1 || quotaUpdated.changes !== 1) fail("revision-conflict")
      })
      if (clockUncertain) fail("clock-uncertain")
      if (!sourceState) fail("transaction-failed")
      return sourceState
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  reserveNativeCanary(input: {
    runId: string; consentId: string; ownerSessionHash: string; ownerEpochHash: string; admissionHash: string
    loaderSessionHash: string; loaderEpochHash: string; loaderAdmissionHash: string
    qualification: NativeCampaignQualificationBinding; promotion: NativePromotionCanaryHandoffBinding
    bindingHash: string; clock: ClockValues
  }): { reservationId: string; requestId: string } {
    const requestId = randomUUID()
    const reservationId = randomUUID()
    const db = this.#connect()
    let clockUncertain = false
    try {
      transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return }
        const quota = this.#quota(db)
        if (quota.clock_uncertain === 1) fail("clock-uncertain")
        if (quota.active_run_id !== input.runId || quota.pending_request_id) fail(quota.pending_request_id ? "dispatch-pending" : "active-run")
        const run = db.query(`SELECT state,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,expires_boot,expires_cont,expires_wall
          FROM runs WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        if (!run || run.state !== "AWAITING_CANDIDATE_APPROVAL" || run.binding_hash !== input.bindingHash ||
            run.owner_session_hash !== input.ownerSessionHash || run.owner_epoch_hash !== input.ownerEpochHash ||
            run.admission_hash !== input.admissionHash) fail("binding-data-drift")
        if (run.expires_boot !== input.clock.boot || BigInt(String(run.expires_cont)) < input.clock.continuous ||
            BigInt(String(run.expires_wall)) < input.clock.wall) fail("run-expired")
        const consent = db.query(`SELECT state,schedule_hash,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM consents WHERE consent_id=? AND run_id=?`)
          .get(input.consentId, input.runId) as Record<string, unknown> | undefined
        if (!consent || consent.state !== "valid" || consent.binding_hash !== input.bindingHash ||
            consent.owner_session_hash !== input.ownerSessionHash || consent.owner_epoch_hash !== input.ownerEpochHash ||
            consent.admission_hash !== input.admissionHash || consent.expires_boot !== input.clock.boot ||
            BigInt(String(consent.expires_cont)) < input.clock.continuous || BigInt(String(consent.expires_wall)) < input.clock.wall) {
          fail("consent-expired")
        }
        const persisted = db.query(`SELECT binding_hash,schedule_hash,candidate_hash,results_hash,review_hash
          FROM campaign_qualifications WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        const q = input.qualification
        const p = input.promotion
        const b = p.bindings
        if (!persisted || persisted.binding_hash !== q.bindingSha256 || persisted.schedule_hash !== q.scheduleSha256 ||
            persisted.candidate_hash !== q.candidateSha256 || persisted.results_hash !== q.resultsSha256 ||
            persisted.review_hash !== q.reviewSha256 || q.runId !== input.runId || q.bindingSha256 !== input.bindingHash ||
            consent.schedule_hash !== q.scheduleSha256 || p.semanticReviewSha256 !== q.reviewSha256 ||
            b.witnessMode !== "native" || b.runId !== input.runId || b.candidateSha256 !== q.candidateSha256 ||
            b.resultsSha256 !== q.resultsSha256 || p.handoffId.length < 1 || p.handoffId.length > 512 ||
            p.transactionId.length < 1 || p.transactionId.length > 512) fail("consent-binding-drift")
        if (db.query("SELECT 1 FROM canary_handoffs WHERE run_id=? AND operation='apply'").get(input.runId)) fail("run-stale")
        this.#chargeRequest(db, input.runId, "target", "canary", input.clock)
        db.query(`INSERT INTO requests(request_id,run_id,reservation_id,role,phase,binding_hash,owner_epoch_hash,
          charged,actual_dispatch,dispatch_state,created_boot,created_cont,created_wall)
          VALUES(?,?,?,'target','canary',?,?,1,NULL,'possible',?,?,?)`)
          .run(requestId, input.runId, reservationId, input.bindingHash, input.loaderEpochHash,
            input.clock.boot, input.clock.continuous.toString(), input.clock.wall.toString())
        db.query(`INSERT INTO canary_handoffs(run_id,operation,handoff_id,transaction_id,promotion_binding_hash,candidate_hash,
          results_hash,review_hash,schedule_hash,loader_session_hash,loader_epoch_hash,loader_admission_hash,request_id,state)
          VALUES(?,'apply',?,?,?,?,?,?,?,?,?,?,?, 'reserved')`)
          .run(input.runId, p.handoffId, p.transactionId, sha256(canonicalJson(b)), q.candidateSha256, q.resultsSha256,
            q.reviewSha256, q.scheduleSha256, input.loaderSessionHash, input.loaderEpochHash, input.loaderAdmissionHash, requestId)
        const runUpdated = db.query("UPDATE runs SET state='RESERVED',revision=revision+1 WHERE run_id=? AND state='AWAITING_CANDIDATE_APPROVAL'")
          .run(input.runId)
        const quotaUpdated = db.query(`UPDATE quota SET pending_request_id=?,revision=revision+1
          WHERE singleton=1 AND active_run_id=? AND pending_request_id IS NULL`).run(requestId, input.runId)
        if (runUpdated.changes !== 1 || quotaUpdated.changes !== 1) fail("revision-conflict")
      })
      if (clockUncertain) fail("clock-uncertain")
      return { reservationId, requestId }
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  reserveNativeRollbackCanary(input: {
    runId: string; consentId: string; ownerSessionHash: string; ownerEpochHash: string; admissionHash: string
    loaderSessionHash: string; loaderEpochHash: string; loaderAdmissionHash: string
    qualification: NativeCampaignQualificationBinding; rollback: NativeRollbackCanaryHandoffReceipt
    bindingHash: string; clock: ClockValues
  }): { reservationId: string; requestId: string } {
    const requestId = randomUUID()
    const reservationId = randomUUID()
    const db = this.#connect()
    let clockUncertain = false
    try {
      transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return }
        const quota = this.#quota(db)
        if (quota.clock_uncertain === 1) fail("clock-uncertain")
        if (quota.active_run_id !== input.runId || quota.active_owner_session_hash !== input.ownerSessionHash ||
            quota.active_owner_epoch_hash !== input.ownerEpochHash || quota.pending_request_id) {
          fail(quota.pending_request_id ? "dispatch-pending" : "active-run")
        }
        const run = db.query(`SELECT state,binding_hash,baseline_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        if (!run || run.state !== "AWAITING_ROLLBACK_CANARY" || run.binding_hash !== input.bindingHash ||
            run.owner_session_hash !== input.ownerSessionHash || run.owner_epoch_hash !== input.ownerEpochHash ||
            run.admission_hash !== input.admissionHash) fail("binding-data-drift")
        if (run.expires_boot !== input.clock.boot || BigInt(String(run.expires_cont)) < input.clock.continuous ||
            BigInt(String(run.expires_wall)) < input.clock.wall) fail("run-expired")
        const consent = db.query(`SELECT state,schedule_hash,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM consents WHERE consent_id=? AND run_id=?`)
          .get(input.consentId, input.runId) as Record<string, unknown> | undefined
        if (!consent || consent.state !== "valid" || consent.binding_hash !== input.bindingHash ||
            consent.owner_session_hash !== input.ownerSessionHash || consent.owner_epoch_hash !== input.ownerEpochHash ||
            consent.admission_hash !== input.admissionHash || consent.expires_boot !== input.clock.boot ||
            BigInt(String(consent.expires_cont)) < input.clock.continuous || BigInt(String(consent.expires_wall)) < input.clock.wall) {
          fail("consent-expired")
        }
        const persisted = db.query(`SELECT binding_hash,schedule_hash,candidate_hash,results_hash,review_hash
          FROM campaign_qualifications WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        const q = input.qualification
        const rollback = input.rollback
        const bindings = rollback.bindings
        if (!persisted || persisted.binding_hash !== q.bindingSha256 || persisted.schedule_hash !== q.scheduleSha256 ||
            persisted.candidate_hash !== q.candidateSha256 || persisted.results_hash !== q.resultsSha256 ||
            persisted.review_hash !== q.reviewSha256 || q.runId !== input.runId || q.bindingSha256 !== input.bindingHash ||
            consent.schedule_hash !== q.scheduleSha256 || rollback.semanticReviewSha256 !== q.reviewSha256 ||
            rollback.rollbackApprovalSha256.length !== 64 || !HASH.test(rollback.rollbackApprovalSha256) ||
            bindings.witnessMode !== "native" || bindings.runId !== input.runId ||
            bindings.originalSha256 !== run.baseline_hash || bindings.candidateSha256 !== q.candidateSha256 ||
            bindings.resultsSha256 !== q.resultsSha256 || rollback.handoffId.length < 1 || rollback.handoffId.length > 512 ||
            rollback.transactionId.length < 1 || rollback.transactionId.length > 512) fail("rollback-canary-handoff-invalid")
        if (db.query("SELECT 1 FROM canary_handoffs WHERE run_id=? AND operation='rollback'").get(input.runId)) fail("run-stale")
        this.#chargeRequest(db, input.runId, "target", "canary", input.clock)
        db.query(`INSERT INTO requests(request_id,run_id,reservation_id,role,phase,binding_hash,owner_epoch_hash,
          charged,actual_dispatch,dispatch_state,created_boot,created_cont,created_wall)
          VALUES(?,?,?,'target','canary',?,?,1,NULL,'possible',?,?,?)`)
          .run(requestId, input.runId, reservationId, input.bindingHash, input.loaderEpochHash,
            input.clock.boot, input.clock.continuous.toString(), input.clock.wall.toString())
        db.query(`INSERT INTO canary_handoffs(run_id,operation,handoff_id,transaction_id,promotion_binding_hash,candidate_hash,
          results_hash,review_hash,schedule_hash,loader_session_hash,loader_epoch_hash,loader_admission_hash,request_id,state)
          VALUES(?,'rollback',?,?,?,?,?,?,?,?,?,?,?, 'reserved')`)
          .run(input.runId, rollback.handoffId, rollback.transactionId, sha256(canonicalJson(bindings)), q.candidateSha256,
            q.resultsSha256, q.reviewSha256, q.scheduleSha256, input.loaderSessionHash, input.loaderEpochHash,
            input.loaderAdmissionHash, requestId)
        const runUpdated = db.query("UPDATE runs SET state='RESERVED',revision=revision+1 WHERE run_id=? AND state='AWAITING_ROLLBACK_CANARY'")
          .run(input.runId)
        const quotaUpdated = db.query(`UPDATE quota SET pending_request_id=?,revision=revision+1
          WHERE singleton=1 AND active_run_id=? AND active_owner_session_hash=? AND active_owner_epoch_hash=? AND pending_request_id IS NULL`)
          .run(requestId, input.runId, input.ownerSessionHash, input.ownerEpochHash)
        if (runUpdated.changes !== 1 || quotaUpdated.changes !== 1) fail("revision-conflict")
      })
      if (clockUncertain) fail("clock-uncertain")
      return { reservationId, requestId }
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  settleNativeCanary(input: {
    runId: string; requestId: string; loaderSessionHash: string; loaderEpochHash: string
    loaderAdmissionHash: string; operation: "apply" | "rollback"; reconciliation: ExecutionReconciliation; clock: ClockValues
  }): void {
    if (!input.reconciliation || input.reconciliation.outcome !== "terminal" || input.reconciliation.quiescent !== true ||
        typeof input.reconciliation.evidence !== "string" || input.reconciliation.evidence.length === 0 ||
        input.reconciliation.evidence.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.reconciliation.evidence)) {
      fail("recovery-unresolved")
    }
    const db = this.#connect()
    let clockUncertain = false
    try {
      transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return }
        const quota = this.#quota(db)
        if (quota.clock_uncertain === 1) fail("clock-uncertain")
        const handoff = input.operation === "apply"
          ? db.query(`SELECT loader_session_hash,loader_epoch_hash,loader_admission_hash,request_id,state
            FROM canary_handoffs WHERE run_id=? AND operation='apply'`).get(input.runId) as Record<string, unknown> | undefined
          : db.query(`SELECT loader_session_hash,loader_epoch_hash,loader_admission_hash,request_id,state
            FROM canary_handoffs WHERE run_id=? AND operation='rollback'`).get(input.runId) as Record<string, unknown> | undefined
        const request = db.query(`SELECT dispatch_state,actual_dispatch,created_boot,created_cont,active_reserved_ms
          FROM requests WHERE run_id=? AND request_id=? AND role='target' AND phase='canary'`)
          .get(input.runId, input.requestId) as Record<string, unknown> | undefined
        const run = db.query("SELECT state FROM runs WHERE run_id=?").get(input.runId) as Record<string, unknown> | undefined
        const usage = db.query("SELECT active_ms,active_reserved_ms FROM usage WHERE run_id=?").get(input.runId) as
          { active_ms: number; active_reserved_ms: number } | undefined
        if (!handoff || handoff.request_id !== input.requestId || handoff.state !== "launched" ||
            handoff.loader_session_hash !== input.loaderSessionHash || handoff.loader_epoch_hash !== input.loaderEpochHash ||
            handoff.loader_admission_hash !== input.loaderAdmissionHash || !request || request.dispatch_state !== "launched" ||
            request.actual_dispatch !== 1 || !run || run.state !== "DISPATCH_PENDING" || quota.active_run_id !== input.runId ||
            quota.pending_request_id !== input.requestId || !usage) fail("recovery-unresolved")
        const reservedMs = Number(request.active_reserved_ms)
        if (!Number.isSafeInteger(reservedMs) || reservedMs <= 0 || usage.active_reserved_ms < reservedMs) fail("storage-corrupt")
        let elapsedMilliseconds: number = NATIVE_SKILLOPT_LIMITS.requestMilliseconds
        if (request.created_boot === input.clock.boot) {
          const elapsed = input.clock.continuous - BigInt(String(request.created_cont))
          if (elapsed < 0n) {
            this.#latchClockUncertain(db, input.clock)
            clockUncertain = true
            return
          }
          elapsedMilliseconds = Number((elapsed + 999_999n) / 1_000_000n)
        } else elapsedMilliseconds = NATIVE_SKILLOPT_LIMITS.activeMilliseconds
        if (elapsedMilliseconds > reservedMs || usage.active_ms + usage.active_reserved_ms > NATIVE_SKILLOPT_LIMITS.activeMilliseconds) {
          fail("budget-exhausted")
        }
        const requestUpdated = db.query(`UPDATE requests SET dispatch_state='settled',finished_boot=?,finished_cont=?,terminal_class='canary-terminal',
          active_reserved_ms=0 WHERE request_id=? AND dispatch_state='launched' AND actual_dispatch=1`)
          .run(input.clock.boot, input.clock.continuous.toString(), input.requestId)
        const handoffUpdated = input.operation === "apply"
          ? db.query("UPDATE canary_handoffs SET state='settled' WHERE run_id=? AND operation='apply' AND request_id=? AND state='launched'")
            .run(input.runId, input.requestId)
          : db.query("UPDATE canary_handoffs SET state='settled' WHERE run_id=? AND operation='rollback' AND request_id=? AND state='launched'")
            .run(input.runId, input.requestId)
        const usageUpdated = db.query("UPDATE usage SET active_ms=active_ms+?,active_reserved_ms=active_reserved_ms-? WHERE run_id=?")
          .run(elapsedMilliseconds, reservedMs, input.runId)
        const settledRunState = input.operation === "apply" ? "AWAITING_CANDIDATE_APPROVAL" : "AWAITING_ROLLBACK_CANARY"
        const runUpdated = db.query(`UPDATE runs SET active_ms=active_ms+?,state=?,reason_code=NULL,revision=revision+1
          WHERE run_id=? AND state='DISPATCH_PENDING'`).run(elapsedMilliseconds, settledRunState, input.runId)
        const quotaUpdated = db.query(`UPDATE quota SET pending_request_id=NULL,revision=revision+1
          WHERE singleton=1 AND active_run_id=? AND pending_request_id=?`).run(input.runId, input.requestId)
        if (requestUpdated.changes !== 1 || handoffUpdated.changes !== 1 || usageUpdated.changes !== 1 ||
            runUpdated.changes !== 1 || quotaUpdated.changes !== 1) fail("revision-conflict")
      })
      if (clockUncertain) fail("clock-uncertain")
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  recordNativeCanaryArtifact(input: { runId: string; loaderSessionHash: string; loaderEpochHash: string; loaderAdmissionHash: string;
    operation: "apply" | "rollback"; bytes: number }): void {
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 1) fail("budget-exhausted")
    const db = this.#connect()
    try {
      transaction(db, () => {
        const quota = this.#quota(db)
        const handoff = input.operation === "apply"
          ? db.query(`SELECT loader_session_hash,loader_epoch_hash,loader_admission_hash,state,artifact_bytes FROM canary_handoffs
            WHERE run_id=? AND operation='apply'`).get(input.runId) as Record<string, unknown> | undefined
          : db.query(`SELECT loader_session_hash,loader_epoch_hash,loader_admission_hash,state,artifact_bytes FROM canary_handoffs
            WHERE run_id=? AND operation='rollback'`).get(input.runId) as Record<string, unknown> | undefined
        const run = db.query("SELECT state,owner_epoch_hash FROM runs WHERE run_id=?").get(input.runId) as Record<string, unknown> | undefined
        const usage = db.query("SELECT artifact_bytes FROM usage WHERE run_id=?").get(input.runId) as { artifact_bytes: number } | undefined
        if (!handoff || handoff.state !== "settled" || handoff.loader_session_hash !== input.loaderSessionHash ||
            handoff.loader_epoch_hash !== input.loaderEpochHash || handoff.loader_admission_hash !== input.loaderAdmissionHash ||
            handoff.artifact_bytes !== 0 || !run ||
            run.state !== (input.operation === "apply" ? "AWAITING_CANDIDATE_APPROVAL" : "AWAITING_ROLLBACK_CANARY") || !usage ||
            quota.active_run_id !== input.runId || quota.pending_request_id) fail("run-stale")
        if (usage.artifact_bytes + input.bytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) fail("budget-exhausted")
        const handoffUpdated = input.operation === "apply"
          ? db.query("UPDATE canary_handoffs SET artifact_bytes=? WHERE run_id=? AND operation='apply' AND state='settled' AND artifact_bytes=0")
            .run(input.bytes, input.runId)
          : db.query("UPDATE canary_handoffs SET artifact_bytes=? WHERE run_id=? AND operation='rollback' AND state='settled' AND artifact_bytes=0")
            .run(input.bytes, input.runId)
        const usageUpdated = db.query("UPDATE usage SET artifact_bytes=artifact_bytes+? WHERE run_id=?").run(input.bytes, input.runId)
        const runUpdated = input.operation === "apply"
          ? db.query("UPDATE runs SET artifact_bytes=artifact_bytes+?,revision=revision+1 WHERE run_id=? AND state='AWAITING_CANDIDATE_APPROVAL'")
            .run(input.bytes, input.runId)
          : db.query("UPDATE runs SET artifact_bytes=artifact_bytes+?,revision=revision+1 WHERE run_id=? AND state='AWAITING_ROLLBACK_CANARY'")
            .run(input.bytes, input.runId)
        if (handoffUpdated.changes !== 1 || usageUpdated.changes !== 1 || runUpdated.changes !== 1) fail("revision-conflict")
      })
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  completeNativeCanary(input: {
    runId: string; ownerSessionHash: string; ownerEpochHash: string; admissionHash: string
    loaderSessionHash: string; loaderEpochHash: string; loaderAdmissionHash: string
    qualification: NativeCampaignQualificationBinding; promotion: NativePromotionCanaryHandoffBinding
    bindingHash: string; scheduleSha256: string; clock: ClockValues; consumeCommit(): void
  }): void {
    const db = this.#connect()
    let clockUncertain = false
    try {
      transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return }
        const quota = this.#quota(db)
        if (quota.clock_uncertain === 1) fail("clock-uncertain")
        const run = db.query(`SELECT state,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,expires_boot,expires_cont,expires_wall
          FROM runs WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        const consent = db.query(`SELECT state,schedule_hash,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM consents WHERE run_id=?`)
          .get(input.runId) as Record<string, unknown> | undefined
        const qualification = db.query(`SELECT binding_hash,schedule_hash,candidate_hash,results_hash,review_hash
          FROM campaign_qualifications WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        const handoff = db.query(`SELECT handoff_id,transaction_id,promotion_binding_hash,candidate_hash,results_hash,review_hash,
          schedule_hash,loader_session_hash,loader_epoch_hash,loader_admission_hash,request_id,state,artifact_bytes
          FROM canary_handoffs WHERE run_id=? AND operation='apply'`).get(input.runId) as Record<string, unknown> | undefined
        const handoffRequestId = typeof handoff?.request_id === "string" ? handoff.request_id : undefined
        const request = handoffRequestId
          ? db.query(`SELECT dispatch_state,actual_dispatch FROM requests WHERE run_id=? AND request_id=? AND role='target' AND phase='canary'`)
            .get(input.runId, handoffRequestId) as Record<string, unknown> | undefined
          : undefined
        if (!run || run.state !== "AWAITING_CANDIDATE_APPROVAL" || run.binding_hash !== input.bindingHash ||
            run.owner_session_hash !== input.ownerSessionHash || run.owner_epoch_hash !== input.ownerEpochHash ||
            run.admission_hash !== input.admissionHash || quota.active_run_id !== input.runId || quota.pending_request_id ||
            run.expires_boot !== input.clock.boot || BigInt(String(run.expires_cont)) < input.clock.continuous ||
            BigInt(String(run.expires_wall)) < input.clock.wall || !consent || consent.state !== "valid" ||
            consent.schedule_hash !== input.scheduleSha256 || consent.expires_boot !== input.clock.boot ||
            BigInt(String(consent.expires_cont)) < input.clock.continuous || BigInt(String(consent.expires_wall)) < input.clock.wall ||
            !qualification || qualification.binding_hash !== input.qualification.bindingSha256 ||
            qualification.schedule_hash !== input.qualification.scheduleSha256 ||
            qualification.candidate_hash !== input.qualification.candidateSha256 ||
            qualification.results_hash !== input.qualification.resultsSha256 || qualification.review_hash !== input.qualification.reviewSha256 ||
            !handoff || handoff.state !== "settled" || handoff.handoff_id !== input.promotion.handoffId ||
            handoff.transaction_id !== input.promotion.transactionId || handoff.promotion_binding_hash !== sha256(canonicalJson(input.promotion.bindings)) ||
            handoff.candidate_hash !== input.qualification.candidateSha256 || handoff.results_hash !== input.qualification.resultsSha256 ||
            handoff.review_hash !== input.qualification.reviewSha256 || handoff.schedule_hash !== input.qualification.scheduleSha256 ||
            handoff.loader_session_hash !== input.loaderSessionHash || handoff.loader_epoch_hash !== input.loaderEpochHash ||
            handoff.loader_admission_hash !== input.loaderAdmissionHash || typeof handoff.artifact_bytes !== "number" || handoff.artifact_bytes < 1 ||
            !request || request.dispatch_state !== "settled" ||
            request.actual_dispatch !== 1 || input.promotion.bindings.runId !== input.runId ||
            input.promotion.bindings.candidateSha256 !== input.qualification.candidateSha256 ||
            input.promotion.bindings.resultsSha256 !== input.qualification.resultsSha256 ||
            input.promotion.semanticReviewSha256 !== input.qualification.reviewSha256) fail("consent-binding-drift")
        input.consumeCommit()
        const handoffUpdated = db.query("UPDATE canary_handoffs SET state='committed' WHERE run_id=? AND operation='apply' AND handoff_id=? AND state='settled'")
          .run(input.runId, input.promotion.handoffId)
        const runUpdated = db.query("UPDATE runs SET state='COMPLETED',reason_code=NULL,revision=revision+1 WHERE run_id=? AND state='AWAITING_CANDIDATE_APPROVAL'")
          .run(input.runId)
        const quotaUpdated = db.query(`UPDATE quota SET active_run_id=NULL,active_owner_session_hash=NULL,active_owner_epoch_hash=NULL,
          revision=revision+1 WHERE singleton=1 AND active_run_id=? AND pending_request_id IS NULL`)
          .run(input.runId)
        if (handoffUpdated.changes !== 1 || runUpdated.changes !== 1 || quotaUpdated.changes !== 1) fail("revision-conflict")
      })
      if (clockUncertain) fail("clock-uncertain")
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  markNativeRollbackUnresolved(input: {
    runId: string; ownerSessionHash: string; ownerEpochHash: string; reasonCode: string
  }): void {
    if (!/^[a-z0-9][a-z0-9_-]{0,95}$/u.test(input.reasonCode)) fail("binding-invalid")
    const db = this.#connect()
    try {
      transaction(db, () => {
        const quota = this.#quota(db)
        const run = db.query("SELECT state,owner_session_hash,owner_epoch_hash FROM runs WHERE run_id=?")
          .get(input.runId) as Record<string, unknown> | undefined
        if (!run || run.owner_session_hash !== input.ownerSessionHash || run.owner_epoch_hash !== input.ownerEpochHash ||
            quota.active_run_id !== input.runId || quota.active_owner_session_hash !== input.ownerSessionHash ||
            quota.active_owner_epoch_hash !== input.ownerEpochHash || quota.pending_request_id) fail("run-stale")
        if (run.state === "UNRESOLVED") return
        if (run.state !== "AWAITING_ROLLBACK_CANARY") fail("run-stale")
        const updated = db.query(`UPDATE runs SET state='UNRESOLVED',reason_code=?,revision=revision+1
          WHERE run_id=? AND state='AWAITING_ROLLBACK_CANARY' AND owner_session_hash=? AND owner_epoch_hash=?`)
          .run(input.reasonCode, input.runId, input.ownerSessionHash, input.ownerEpochHash)
        if (updated.changes !== 1) fail("revision-conflict")
      })
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  completeNativeRollbackCanary(input: {
    runId: string; ownerSessionHash: string; ownerEpochHash: string; admissionHash: string
    loaderSessionHash: string; loaderEpochHash: string; loaderAdmissionHash: string
    qualification: NativeCampaignQualificationBinding; rollback: NativeRollbackCanaryHandoffReceipt
    bindingHash: string; approvalRecordSha256: string; clock: ClockValues; consumeCommit(): void
  }): void {
    const db = this.#connect()
    let clockUncertain = false
    try {
      transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return }
        const quota = this.#quota(db)
        if (quota.clock_uncertain === 1) fail("clock-uncertain")
        const run = db.query(`SELECT state,binding_hash,baseline_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        const consent = db.query(`SELECT state,schedule_hash,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          expires_boot,expires_cont,expires_wall FROM consents WHERE run_id=?`)
          .get(input.runId) as Record<string, unknown> | undefined
        const qualification = db.query(`SELECT binding_hash,schedule_hash,candidate_hash,results_hash,review_hash
          FROM campaign_qualifications WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        const handoff = db.query(`SELECT handoff_id,transaction_id,promotion_binding_hash,candidate_hash,results_hash,review_hash,
          schedule_hash,loader_session_hash,loader_epoch_hash,loader_admission_hash,request_id,state,artifact_bytes
          FROM canary_handoffs WHERE run_id=? AND operation='rollback'`).get(input.runId) as Record<string, unknown> | undefined
        const handoffRequestId = typeof handoff?.request_id === "string" ? handoff.request_id : undefined
        const request = handoffRequestId
          ? db.query(`SELECT dispatch_state,actual_dispatch FROM requests WHERE run_id=? AND request_id=? AND role='target' AND phase='canary'`)
            .get(input.runId, handoffRequestId) as Record<string, unknown> | undefined
          : undefined
        const q = input.qualification
        const rollback = input.rollback
        if (!run || run.state !== "AWAITING_ROLLBACK_CANARY" || run.binding_hash !== input.bindingHash ||
            run.owner_session_hash !== input.ownerSessionHash || run.owner_epoch_hash !== input.ownerEpochHash ||
            run.admission_hash !== input.admissionHash || quota.active_run_id !== input.runId ||
            quota.active_owner_session_hash !== input.ownerSessionHash || quota.active_owner_epoch_hash !== input.ownerEpochHash ||
            quota.pending_request_id || run.expires_boot !== input.clock.boot ||
            BigInt(String(run.expires_cont)) < input.clock.continuous || BigInt(String(run.expires_wall)) < input.clock.wall ||
            !consent || consent.state !== "valid" || consent.schedule_hash !== q.scheduleSha256 ||
            consent.binding_hash !== input.bindingHash || consent.owner_session_hash !== input.ownerSessionHash ||
            consent.owner_epoch_hash !== input.ownerEpochHash || consent.admission_hash !== input.admissionHash ||
            consent.expires_boot !== input.clock.boot || BigInt(String(consent.expires_cont)) < input.clock.continuous ||
            BigInt(String(consent.expires_wall)) < input.clock.wall || !qualification ||
            qualification.binding_hash !== q.bindingSha256 || qualification.schedule_hash !== q.scheduleSha256 ||
            qualification.candidate_hash !== q.candidateSha256 || qualification.results_hash !== q.resultsSha256 ||
            qualification.review_hash !== q.reviewSha256 || q.runId !== input.runId || q.bindingSha256 !== input.bindingHash ||
            !handoff || handoff.state !== "settled" || handoff.handoff_id !== rollback.handoffId ||
            handoff.transaction_id !== rollback.transactionId || handoff.promotion_binding_hash !== sha256(canonicalJson(rollback.bindings)) ||
            handoff.candidate_hash !== q.candidateSha256 || handoff.results_hash !== q.resultsSha256 ||
            handoff.review_hash !== q.reviewSha256 || handoff.schedule_hash !== q.scheduleSha256 ||
            handoff.loader_session_hash !== input.loaderSessionHash || handoff.loader_epoch_hash !== input.loaderEpochHash ||
            handoff.loader_admission_hash !== input.loaderAdmissionHash || typeof handoff.artifact_bytes !== "number" || handoff.artifact_bytes < 1 ||
            !request || request.dispatch_state !== "settled" || request.actual_dispatch !== 1 ||
            rollback.bindings.runId !== input.runId || rollback.bindings.originalSha256 !== run.baseline_hash ||
            rollback.bindings.candidateSha256 !== q.candidateSha256 || rollback.bindings.resultsSha256 !== q.resultsSha256 ||
            rollback.semanticReviewSha256 !== q.reviewSha256 || rollback.rollbackApprovalSha256 !== input.approvalRecordSha256) {
          fail("rollback-canary-handoff-invalid")
        }
        input.consumeCommit()
        const handoffUpdated = db.query("UPDATE canary_handoffs SET state='committed' WHERE run_id=? AND operation='rollback' AND handoff_id=? AND state='settled'")
          .run(input.runId, rollback.handoffId)
        const runUpdated = db.query("UPDATE runs SET state='ROLLED_BACK',reason_code=NULL,revision=revision+1 WHERE run_id=? AND state='AWAITING_ROLLBACK_CANARY'")
          .run(input.runId)
        const quotaUpdated = db.query(`UPDATE quota SET active_run_id=NULL,active_owner_session_hash=NULL,active_owner_epoch_hash=NULL,
          revision=revision+1 WHERE singleton=1 AND active_run_id=? AND active_owner_session_hash=? AND active_owner_epoch_hash=? AND pending_request_id IS NULL`)
          .run(input.runId, input.ownerSessionHash, input.ownerEpochHash)
        if (handoffUpdated.changes !== 1 || runUpdated.changes !== 1 || quotaUpdated.changes !== 1) fail("revision-conflict")
      })
      if (clockUncertain) fail("clock-uncertain")
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  chargeNativePublicationArtifacts(input: {
    runId: string; expectedRevision: number; expectedState: "COMPLETED" | "AWAITING_CANDIDATE_APPROVAL"
    ownerSessionHash: string; ownerEpochHash: string; admissionHash: string; operation: "apply" | "rollback"
    qualification: NativeCampaignQualificationBinding; consent: StoredConsentRow; bytes: number; headroomBytes: number
    verifyCurrent(): ClockValues
  }): void {
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 0 || !Number.isSafeInteger(input.headroomBytes) ||
        input.headroomBytes < 0 || input.bytes + input.headroomBytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) {
      fail("budget-exhausted")
    }
    const db = this.#connect()
    let clockUncertain = false
    try {
      transaction(db, () => {
        const rawRun = db.query("SELECT * FROM runs WHERE run_id=?").get(input.runId) as unknown
        if (rawRun === undefined || rawRun === null) fail("run-stale")
        if (!isStoredRunRow(rawRun)) fail("storage-corrupt")
        const run = rawRun
        if (run.revision !== input.expectedRevision || run.state !== input.expectedState) fail("revision-conflict")
        const allowedState = input.operation === "apply"
          ? run.state === "AWAITING_CANDIDATE_APPROVAL"
          : run.state === "COMPLETED" || run.state === "AWAITING_CANDIDATE_APPROVAL"
        if (!allowedState) fail("run-stale")
        if (run.owner_session_hash !== input.ownerSessionHash || run.owner_epoch_hash !== input.ownerEpochHash ||
            run.admission_hash !== input.admissionHash) fail("owner-unavailable")
        const quota = this.#quota(db)
        if (quota.clock_uncertain === 1) fail("clock-uncertain")
        if (quota.pending_request_id) fail("dispatch-pending")
        if (run.state === "AWAITING_CANDIDATE_APPROVAL") {
          if (quota.active_run_id !== input.runId || quota.active_owner_session_hash !== input.ownerSessionHash ||
              quota.active_owner_epoch_hash !== input.ownerEpochHash) fail("active-run")
        } else if (quota.active_run_id !== null || quota.active_owner_session_hash !== null || quota.active_owner_epoch_hash !== null) {
          fail("active-run")
        }
        const rawConsent = db.query(`SELECT * FROM consents WHERE run_id=?`).get(input.runId) as unknown
        if (rawConsent === undefined || rawConsent === null) fail("consent-expired")
        if (!isStoredConsentRow(rawConsent)) fail("storage-corrupt")
        const consent = rawConsent
        if (consent.run_id !== input.runId || consent.state !== "valid" || consent.consent_id !== input.consent.consent_id ||
            consent.subject_hash !== input.consent.subject_hash || consent.schedule_hash !== input.consent.schedule_hash ||
            consent.binding_hash !== input.consent.binding_hash || consent.owner_session_hash !== input.consent.owner_session_hash ||
            consent.owner_epoch_hash !== input.consent.owner_epoch_hash || consent.admission_hash !== input.consent.admission_hash ||
            consent.expires_boot !== input.consent.expires_boot || consent.expires_cont !== input.consent.expires_cont ||
            consent.expires_wall !== input.consent.expires_wall) fail("consent-binding-drift")
        const qualification = db.query(`SELECT run_id,binding_hash,schedule_hash,candidate_hash,results_hash,review_hash
          FROM campaign_qualifications WHERE run_id=?`).get(input.runId) as Record<string, unknown> | undefined
        if (!qualification || qualification.run_id !== input.qualification.runId ||
            qualification.binding_hash !== input.qualification.bindingSha256 ||
            qualification.schedule_hash !== input.qualification.scheduleSha256 ||
            qualification.candidate_hash !== input.qualification.candidateSha256 ||
            qualification.results_hash !== input.qualification.resultsSha256 ||
            qualification.review_hash !== input.qualification.reviewSha256 ||
            ![qualification.binding_hash, qualification.schedule_hash, qualification.candidate_hash,
              qualification.results_hash, qualification.review_hash].every(asHash)) fail("qualification-required")
        const now = input.verifyCurrent()
        if (!this.#observeClock(db, now)) { clockUncertain = true; return }
        const latestQuota = this.#quota(db)
        if (latestQuota.clock_uncertain === 1) fail("clock-uncertain")
        if (run.expires_boot !== now.boot || BigInt(run.expires_cont) < now.continuous || BigInt(run.expires_wall) < now.wall ||
            consent.expires_boot !== now.boot || BigInt(consent.expires_cont) < now.continuous ||
            BigInt(consent.expires_wall) < now.wall) fail("run-expired")
        const usage = db.query(`SELECT active_ms,active_reserved_ms,artifact_bytes FROM usage WHERE run_id=?`)
          .get(input.runId) as { active_ms: number; active_reserved_ms: number; artifact_bytes: number } | undefined
        if (!usage || ![usage.active_ms, usage.active_reserved_ms, usage.artifact_bytes, run.artifact_bytes]
          .every(value => Number.isSafeInteger(value) && value >= 0) || usage.artifact_bytes !== run.artifact_bytes) {
          fail("storage-corrupt")
        }
        if (usage.active_ms + usage.active_reserved_ms > NATIVE_SKILLOPT_LIMITS.activeMilliseconds ||
            usage.artifact_bytes + input.bytes + input.headroomBytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) {
          fail("budget-exhausted")
        }
        if (input.bytes === 0) return
        const usageUpdated = db.query(`UPDATE usage SET artifact_bytes=artifact_bytes+?
          WHERE run_id=? AND artifact_bytes=?`).run(input.bytes, input.runId, usage.artifact_bytes)
        const runUpdated = db.query(`UPDATE runs SET artifact_bytes=artifact_bytes+?,revision=revision+1
          WHERE run_id=? AND revision=? AND state=? AND artifact_bytes=?`)
          .run(input.bytes, input.runId, input.expectedRevision, input.expectedState, run.artifact_bytes)
        if (usageUpdated.changes !== 1 || runUpdated.changes !== 1) fail("revision-conflict")
      })
      if (clockUncertain) fail("clock-uncertain")
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  chargeArtifactBytes(runId: string, ownerEpochHash: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) fail("budget-exhausted")
    const db = this.#connect()
    try {
      transaction(db, () => {
        const run = db.query("SELECT state,owner_epoch_hash FROM runs WHERE run_id=?").get(runId) as Record<string, unknown> | undefined
        const usage = db.query("SELECT artifact_bytes FROM usage WHERE run_id=?").get(runId) as { artifact_bytes: number } | undefined
        if (!run || !usage || run.owner_epoch_hash !== ownerEpochHash || run.state !== "RUNNING") fail("run-stale")
        const active = db.query("SELECT active_ms,active_reserved_ms FROM usage WHERE run_id=?").get(runId) as { active_ms: number; active_reserved_ms: number }
        if (active.active_ms + active.active_reserved_ms > NATIVE_SKILLOPT_LIMITS.activeMilliseconds) fail("budget-exhausted")
        if (usage.artifact_bytes + bytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) fail("budget-exhausted")
        db.query("UPDATE usage SET artifact_bytes=artifact_bytes+? WHERE run_id=?").run(bytes, runId)
        db.query("UPDATE runs SET artifact_bytes=artifact_bytes+? WHERE run_id=?").run(bytes, runId)
      })
    } finally { db.close() }
  }

  reserveNativePreparationArtifacts(input: {
    expected: StoredReentrySnapshot
    expectedRevision: number
    expectedState: "PREPARED" | "CONSENTED" | "ARMED"
    owner: OwnerProof
    ownerSessionID: string
    ownerEpoch: string
    hashes: ReturnType<typeof skillOptBindingHashes>
    bytes: number
    verifyCurrent(): { owner: OwnerProof; hashes: ReturnType<typeof skillOptBindingHashes>; clock: ClockValues }
  }): void {
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) fail("budget-exhausted")
    const db = this.#connect()
    let clockUncertain = false
    try {
      transaction(db, () => {
        const current = input.verifyCurrent()
        if (!isDeepStrictEqual(current.owner, input.owner) || !isDeepStrictEqual(current.hashes, input.hashes)) fail("owner-unavailable")
        if (!this.#observeClock(db, current.clock)) { clockUncertain = true; return }
        const runValue = db.query("SELECT * FROM runs WHERE run_id=?").get(input.expected.run.run_id) as unknown
        if (!isStoredRunRow(runValue)) fail("storage-corrupt")
        const run = runValue
        const consentValue = db.query("SELECT * FROM consents WHERE run_id=?").get(run.run_id) as unknown
        const armValue = db.query("SELECT * FROM arms WHERE run_id=?").get(run.run_id) as unknown
        const consent = consentValue === undefined || consentValue === null ? undefined
          : isStoredConsentRow(consentValue) ? consentValue : fail("storage-corrupt")
        const arm = armValue === undefined || armValue === null ? undefined
          : isStoredArmRow(armValue) ? armValue : fail("storage-corrupt")
        const usage = db.query("SELECT * FROM usage WHERE run_id=?").get(run.run_id) as unknown
        if (!isRecord(usage)) fail("storage-corrupt")
        const quota = this.#quota(db)
        const attemptCount = Number((db.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(run.run_id) as { count: number }).count)
        const requestCount = Number((db.query("SELECT count(*) AS count FROM requests WHERE run_id=?").get(run.run_id) as { count: number }).count)
        const unresolvedRequestCount = Number((db.query(`SELECT count(*) AS count FROM requests
          WHERE actual_dispatch IS NULL OR dispatch_state NOT IN ('settled','not_dispatched')`).get() as { count: number }).count)
        if (!Number.isSafeInteger(attemptCount) || !Number.isSafeInteger(requestCount) ||
            !Number.isSafeInteger(unresolvedRequestCount)) fail("storage-corrupt")
        if (run.revision !== input.expectedRevision || run.state !== input.expectedState ||
            !isDeepStrictEqual(run, input.expected.run) || !isDeepStrictEqual(consent, input.expected.consent) ||
            !isDeepStrictEqual(arm, input.expected.arm) || !isDeepStrictEqual(usage, input.expected.usage) ||
            attemptCount !== 0 || requestCount !== 0 || input.expected.attemptCount !== 0 || input.expected.requestCount !== 0) {
          fail("revision-conflict")
        }
        if (run.owner_session_id !== input.ownerSessionID || run.owner_epoch !== input.ownerEpoch ||
            run.owner_session_hash !== input.owner.sessionHash || run.owner_epoch_hash !== input.owner.epochHash ||
            run.admission_hash !== input.owner.admissionHash) fail("owner-unavailable")
        if (run.binding_hash !== input.hashes.bindingSha256 || run.dataset_hash !== input.hashes.datasetSha256 ||
            run.data_hash !== input.hashes.dataSha256 || run.model_hash !== input.hashes.modelBindingsSha256 ||
            run.protocol_hash !== input.hashes.protocolSha256 || run.baseline_hash !== input.hashes.baselineSkillSha256) {
          fail("consent-binding-drift")
        }
        if (quota.clock_uncertain !== 0) fail("clock-uncertain")
        if (quota.pending_request_id !== null) fail("dispatch-pending")
        if (quota.active_run_id !== null || quota.active_owner_session_hash !== null || quota.active_owner_epoch_hash !== null) fail("active-run")
        if (unresolvedRequestCount !== 0) fail("dispatch-ambiguous")
        if (run.expires_boot !== current.clock.boot || BigInt(run.expires_cont) < current.clock.continuous ||
            BigInt(run.expires_wall) < current.clock.wall) fail("run-expired")
        if (input.expectedState === "PREPARED") {
          if (consent || arm) fail("revision-conflict")
        } else {
          if (!consent || consent.state !== "valid" || consent.binding_hash !== run.binding_hash ||
              consent.owner_session_hash !== input.owner.sessionHash || consent.owner_epoch_hash !== input.owner.epochHash ||
              consent.admission_hash !== input.owner.admissionHash || consent.expires_boot !== current.clock.boot ||
              BigInt(consent.expires_cont) < current.clock.continuous || BigInt(consent.expires_wall) < current.clock.wall) {
            fail("consent-expired")
          }
          if (input.expectedState === "CONSENTED") {
            if (arm) fail("revision-conflict")
          } else if (!arm || arm.state !== "armed" || arm.consent_id !== consent.consent_id ||
              arm.expires_boot !== current.clock.boot || BigInt(arm.expires_cont) < current.clock.continuous ||
              BigInt(arm.expires_wall) < current.clock.wall) fail("arm-expired")
        }
        const artifactBytes = Number(usage.artifact_bytes)
        if (!Number.isSafeInteger(artifactBytes) || artifactBytes < 0 || run.artifact_bytes !== artifactBytes) fail("storage-corrupt")
        if (artifactBytes + input.bytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) fail("budget-exhausted")
        const finalCurrent = input.verifyCurrent()
        if (!isDeepStrictEqual(finalCurrent.owner, input.owner)) fail("owner-unavailable")
        if (!isDeepStrictEqual(finalCurrent.hashes, input.hashes)) fail("consent-binding-drift")
        if (finalCurrent.clock.boot !== current.clock.boot || finalCurrent.clock.continuous < current.clock.continuous ||
            finalCurrent.clock.wall < current.clock.wall) fail("clock-uncertain")
        if (!this.#observeClock(db, finalCurrent.clock)) { clockUncertain = true; return }
        if (run.expires_boot !== finalCurrent.clock.boot || BigInt(run.expires_cont) < finalCurrent.clock.continuous ||
            BigInt(run.expires_wall) < finalCurrent.clock.wall) fail("run-expired")
        if (consent && (consent.expires_boot !== finalCurrent.clock.boot ||
            BigInt(consent.expires_cont) < finalCurrent.clock.continuous || BigInt(consent.expires_wall) < finalCurrent.clock.wall)) {
          fail("consent-expired")
        }
        if (input.expectedState === "ARMED" && (!arm || arm.expires_boot !== finalCurrent.clock.boot ||
            BigInt(arm.expires_cont) < finalCurrent.clock.continuous || BigInt(arm.expires_wall) < finalCurrent.clock.wall)) {
          fail("arm-expired")
        }
        if (input.bytes === 0) return
        const usageUpdated = db.query(`UPDATE usage SET artifact_bytes=artifact_bytes+?
          WHERE run_id=? AND artifact_bytes=? AND artifact_bytes+?<=?`)
          .run(input.bytes, run.run_id, artifactBytes, input.bytes, NATIVE_SKILLOPT_LIMITS.artifactBytes)
        const runUpdated = db.query(`UPDATE runs SET artifact_bytes=artifact_bytes+?,revision=revision+1
          WHERE run_id=? AND revision=? AND state=? AND artifact_bytes=? AND artifact_bytes+?<=?`)
          .run(input.bytes, run.run_id, input.expectedRevision, input.expectedState, artifactBytes,
            input.bytes, NATIVE_SKILLOPT_LIMITS.artifactBytes)
        if (usageUpdated.changes !== 1 || runUpdated.changes !== 1) fail("revision-conflict")
        const latestQuota = this.#quota(db)
        const quotaUpdated = db.query("UPDATE quota SET revision=revision+1 WHERE singleton=1 AND revision=?").run(latestQuota.revision)
        if (quotaUpdated.changes !== 1) fail("revision-conflict")
      })
      if (clockUncertain) fail("clock-uncertain")
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  reserveRunningNativeCampaignArtifacts(input: {
    runId: string
    expectedRevision: number
    owner: OwnerProof
    ownerSessionID: string
    ownerEpoch: string
    hashes: ReturnType<typeof skillOptBindingHashes>
    bytes: number
    protocolEvidence?: Readonly<{
      event?: NativeTrainerProtocolEventBinding
      reservation?: Readonly<{ requestId: string; reservationId: string; role: SkillOptRequestRole; phase: SkillOptRequestPhase }>
      requireAssociation?: boolean
      requireUnassociated?: boolean
    }>
    verifyCurrent(): { owner: OwnerProof; hashes: ReturnType<typeof skillOptBindingHashes>; clock: ClockValues }
  }): void {
    if (!UUID.test(input.runId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
        !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) {
      fail("budget-exhausted")
    }
    const db = this.#connect()
    let clockUncertain = false
    try {
      transaction(db, () => {
        const current = input.verifyCurrent()
        if (!isDeepStrictEqual(current.owner, input.owner) || !isDeepStrictEqual(current.hashes, input.hashes)) fail("owner-unavailable")
        if (!this.#observeClock(db, current.clock)) { clockUncertain = true; return }
        const runValue = db.query("SELECT * FROM runs WHERE run_id=?").get(input.runId) as unknown
        if (!isStoredRunRow(runValue)) fail("storage-corrupt")
        const run = runValue
        const usageValue = db.query("SELECT * FROM usage WHERE run_id=?").get(input.runId) as unknown
        if (!isRecord(usageValue)) fail("storage-corrupt")
        const quota = this.#quota(db)
        const dispatchedCount = Number((db.query(`SELECT count(*) AS count FROM requests WHERE run_id=? AND charged=1
          AND actual_dispatch=1 AND dispatch_state='settled'`).get(input.runId) as { count: number }).count)
        const unresolvedRequestCount = Number((db.query(`SELECT count(*) AS count FROM requests
          WHERE actual_dispatch IS NULL OR dispatch_state NOT IN ('settled','not_dispatched')`).get() as { count: number }).count)
        if (!Number.isSafeInteger(dispatchedCount) || !Number.isSafeInteger(unresolvedRequestCount)) fail("storage-corrupt")
        if (run.state !== "RUNNING" || run.revision !== input.expectedRevision) fail("revision-conflict")
        if (run.owner_session_id !== input.ownerSessionID || run.owner_epoch !== input.ownerEpoch ||
            run.owner_session_hash !== input.owner.sessionHash || run.owner_epoch_hash !== input.owner.epochHash ||
            run.admission_hash !== input.owner.admissionHash) fail("owner-unavailable")
        if (run.binding_hash !== input.hashes.bindingSha256 || run.dataset_hash !== input.hashes.datasetSha256 ||
            run.data_hash !== input.hashes.dataSha256 || run.model_hash !== input.hashes.modelBindingsSha256 ||
            run.protocol_hash !== input.hashes.protocolSha256 || run.baseline_hash !== input.hashes.baselineSkillSha256) {
          fail("consent-binding-drift")
        }
        if (quota.clock_uncertain !== 0) fail("clock-uncertain")
        if (quota.pending_request_id !== null) fail("dispatch-pending")
        if (quota.active_run_id !== input.runId || quota.active_owner_session_hash !== input.owner.sessionHash ||
            quota.active_owner_epoch_hash !== input.owner.epochHash) fail("active-run")
        if (dispatchedCount < 1) fail("run-stale")
        if (unresolvedRequestCount !== 0) fail("dispatch-ambiguous")
        if (input.protocolEvidence) assertTrainerProtocolArtifactEvidence(db, { runId: input.runId, ...input.protocolEvidence })
        if (run.expires_boot !== current.clock.boot || boundedClockDecimal(run.expires_cont) === undefined ||
            boundedClockDecimal(run.expires_wall) === undefined || BigInt(run.expires_cont) < current.clock.continuous ||
            BigInt(run.expires_wall) < current.clock.wall) fail("run-expired")
        const activeMs = usageValue.active_ms
        const activeReservedMs = usageValue.active_reserved_ms
        const artifactBytes = usageValue.artifact_bytes
        if (!isNonNegativeSafeInteger(activeMs) || !isNonNegativeSafeInteger(activeReservedMs) ||
            !isNonNegativeSafeInteger(artifactBytes) || !isNonNegativeSafeInteger(run.active_ms) ||
            !isNonNegativeSafeInteger(run.artifact_bytes) || activeMs !== run.active_ms || artifactBytes !== run.artifact_bytes) {
          fail("storage-corrupt")
        }
        if (activeMs + activeReservedMs > NATIVE_SKILLOPT_LIMITS.activeMilliseconds ||
            artifactBytes + input.bytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) fail("budget-exhausted")
        const finalCurrent = input.verifyCurrent()
        if (!isDeepStrictEqual(finalCurrent.owner, input.owner)) fail("owner-unavailable")
        if (!isDeepStrictEqual(finalCurrent.hashes, input.hashes)) fail("consent-binding-drift")
        if (finalCurrent.clock.boot !== current.clock.boot || finalCurrent.clock.continuous < current.clock.continuous ||
            finalCurrent.clock.wall < current.clock.wall) fail("clock-uncertain")
        if (!this.#observeClock(db, finalCurrent.clock)) { clockUncertain = true; return }
        if (run.expires_boot !== finalCurrent.clock.boot || BigInt(run.expires_cont) < finalCurrent.clock.continuous ||
            BigInt(run.expires_wall) < finalCurrent.clock.wall) fail("run-expired")
        const latestQuota = this.#quota(db)
        if (latestQuota.pending_request_id !== null) fail("dispatch-pending")
        if (latestQuota.active_run_id !== input.runId || latestQuota.active_owner_session_hash !== input.owner.sessionHash ||
            latestQuota.active_owner_epoch_hash !== input.owner.epochHash) fail("active-run")
        const usageUpdated = db.query(`UPDATE usage SET artifact_bytes=artifact_bytes+?
          WHERE run_id=? AND artifact_bytes=? AND artifact_bytes+?<=?`)
          .run(input.bytes, input.runId, artifactBytes, input.bytes, NATIVE_SKILLOPT_LIMITS.artifactBytes)
        const runUpdated = db.query(`UPDATE runs SET artifact_bytes=artifact_bytes+?
          WHERE run_id=? AND state='RUNNING' AND revision=? AND owner_session_hash=? AND owner_epoch_hash=? AND admission_hash=?
            AND artifact_bytes=? AND artifact_bytes+?<=?`)
          .run(input.bytes, input.runId, input.expectedRevision, input.owner.sessionHash, input.owner.epochHash,
            input.owner.admissionHash, artifactBytes, input.bytes, NATIVE_SKILLOPT_LIMITS.artifactBytes)
        if (usageUpdated.changes !== 1 || runUpdated.changes !== 1) fail("revision-conflict")
      })
      if (clockUncertain) fail("clock-uncertain")
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  assertNativeTrainerProtocolArtifactEvidence(input: Readonly<{
    runId: string
    event?: NativeTrainerProtocolEventBinding
    reservation?: Readonly<{ requestId: string; reservationId: string; role: SkillOptRequestRole; phase: SkillOptRequestPhase }>
    requireAssociation?: boolean
    requireUnassociated?: boolean
  }>): void {
    const db = this.#read()
    try { assertTrainerProtocolArtifactEvidence(db, input) }
    finally { db.close() }
  }

  associateNativeTrainerWarmupEvent(input: {
    runId: string
    event: NativeTrainerProtocolEventBinding
    reservation: Readonly<{ requestId: string; reservationId: string; role: SkillOptRequestRole; phase: SkillOptRequestPhase }>
    owner: OwnerProof
    ownerSessionID: string
    ownerEpoch: string
    hashes: ReturnType<typeof skillOptBindingHashes>
    clock: ClockValues
    verifyCurrent(): { owner: OwnerProof; hashes: ReturnType<typeof skillOptBindingHashes>; clock: ClockValues }
  }): void {
    const { event, reservation } = input
    if (event.runId !== input.runId || event.kind !== "rollout" || event.cohort !== "training" ||
        reservation.role !== "target" || reservation.phase !== "train" || !asHash(input.hashes.bindingSha256)) fail("dispatch-not-authorized")
    const db = this.#connect()
    let clockUncertain = false
    try {
      transaction(db, () => {
        const current = input.verifyCurrent()
        if (!isDeepStrictEqual(current.owner, input.owner) || !isDeepStrictEqual(current.hashes, input.hashes) ||
            current.clock.boot !== input.clock.boot || current.clock.continuous < input.clock.continuous ||
            current.clock.wall < input.clock.wall) fail("consent-binding-drift")
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return }
        const quota = this.#quota(db)
        const runValue = db.query("SELECT * FROM runs WHERE run_id=?").get(input.runId) as unknown
        if (!isStoredRunRow(runValue)) fail("storage-corrupt")
        const run = runValue
        if (run.run_id !== input.runId || run.state !== "RUNNING" || run.owner_session_id !== input.ownerSessionID ||
            run.owner_epoch !== input.ownerEpoch || run.owner_session_hash !== input.owner.sessionHash ||
            run.owner_epoch_hash !== input.owner.epochHash || run.admission_hash !== input.owner.admissionHash ||
            run.binding_hash !== input.hashes.bindingSha256 || run.dataset_hash !== input.hashes.datasetSha256 ||
            run.data_hash !== input.hashes.dataSha256 || run.model_hash !== input.hashes.modelBindingsSha256 ||
            run.protocol_hash !== input.hashes.protocolSha256 || run.baseline_hash !== input.hashes.baselineSkillSha256) {
          fail("consent-binding-drift")
        }
        if (run.expires_boot !== input.clock.boot || boundedClockDecimal(run.expires_cont) === undefined ||
            boundedClockDecimal(run.expires_wall) === undefined || BigInt(run.expires_cont) < input.clock.continuous ||
            BigInt(run.expires_wall) < input.clock.wall) fail("run-expired")
        if (quota.clock_uncertain !== 0) fail("clock-uncertain")
        if (quota.pending_request_id !== null) fail("dispatch-pending")
        if (quota.active_run_id !== input.runId || quota.active_owner_session_hash !== input.owner.sessionHash ||
            quota.active_owner_epoch_hash !== input.owner.epochHash) fail("active-run")
        const eventValue = db.query("SELECT * FROM trainer_protocol_events WHERE run_id=? AND wire_request_id=?")
          .get(input.runId, event.wireRequestId) as unknown
        if (!isStoredTrainerProtocolEventRow(eventValue) || !trainerProtocolEventRowMatches(eventValue, event)) {
          fail("dispatch-not-authorized")
        }
        const requestValue = db.query(`SELECT request_id,run_id,reservation_id,role,phase,charged,dispatch_state,actual_dispatch,
          active_reserved_ms,finished_boot,finished_cont,terminal_class FROM requests WHERE request_id=? AND run_id=?`)
          .get(reservation.requestId, input.runId) as unknown
        if (!isRecord(requestValue) || !hasExactKeys(requestValue, ["request_id", "run_id", "reservation_id", "role", "phase", "charged",
          "dispatch_state", "actual_dispatch", "active_reserved_ms", "finished_boot", "finished_cont", "terminal_class"]) ||
            requestValue.request_id !== reservation.requestId || requestValue.run_id !== input.runId ||
            requestValue.reservation_id !== reservation.reservationId || requestValue.role !== "target" || requestValue.phase !== "train" ||
            requestValue.charged !== 1 || requestValue.dispatch_state !== "settled" || requestValue.actual_dispatch !== 1 ||
            requestValue.active_reserved_ms !== 0 || !UUID.test(String(requestValue.finished_boot)) ||
            typeof requestValue.finished_cont !== "string" || boundedClockDecimal(requestValue.finished_cont) === undefined ||
            typeof requestValue.terminal_class !== "string" || requestValue.terminal_class.length < 1 ||
            requestValue.terminal_class.length > 64) fail("dispatch-not-authorized")
        if (db.query("SELECT 1 FROM trainer_protocol_dispatches WHERE run_id=? AND wire_request_id=?")
          .get(input.runId, event.wireRequestId)) fail("dispatch-not-authorized")
        const finalCurrent = input.verifyCurrent()
        if (!isDeepStrictEqual(finalCurrent.owner, input.owner)) fail("owner-unavailable")
        if (!isDeepStrictEqual(finalCurrent.hashes, input.hashes)) fail("consent-binding-drift")
        if (finalCurrent.clock.boot !== input.clock.boot || finalCurrent.clock.continuous < input.clock.continuous ||
            finalCurrent.clock.wall < input.clock.wall) fail("clock-uncertain")
        if (!this.#observeClock(db, finalCurrent.clock)) { clockUncertain = true; return }
        db.query("INSERT INTO trainer_protocol_dispatches(run_id,wire_request_id,native_request_id) VALUES(?,?,?)")
          .run(input.runId, event.wireRequestId, reservation.requestId)
      })
      if (clockUncertain) fail("clock-uncertain")
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  markClockUncertain(): void {
    const db = this.#connect()
    try {
      transaction(db, () => this.#latchClockUncertain(db))
    } finally { db.close() }
  }

  chargeCandidateStep(runId: string, ownerEpochHash: string): void {
    const db = this.#connect()
    try {
      transaction(db, () => {
        const run = db.query("SELECT state,owner_epoch_hash,candidate_steps FROM runs WHERE run_id=?").get(runId) as Record<string, unknown> | undefined
        if (!run || run.owner_epoch_hash !== ownerEpochHash || run.state !== "RUNNING") fail("run-stale")
        const usage = db.query("SELECT active_ms,active_reserved_ms FROM usage WHERE run_id=?").get(runId) as { active_ms: number; active_reserved_ms: number } | undefined
        if (!usage || usage.active_ms + usage.active_reserved_ms > NATIVE_SKILLOPT_LIMITS.activeMilliseconds) fail("budget-exhausted")
        if (Number(run.candidate_steps) >= NATIVE_SKILLOPT_LIMITS.candidateSteps) fail("budget-exhausted")
        db.query("UPDATE runs SET candidate_steps=candidate_steps+1,revision=revision+1 WHERE run_id=?").run(runId)
        db.query("UPDATE usage SET candidate_steps=candidate_steps+1 WHERE run_id=?").run(runId)
      })
    } finally { db.close() }
  }

  readRunForReentry(runId: string): StoredReentrySnapshot | undefined {
    if (!UUID.test(runId)) fail("run-stale")
    const db = this.#read()
    try {
      db.exec("BEGIN DEFERRED")
      try {
        const run = db.query("SELECT * FROM runs WHERE run_id=?").get(runId) as unknown
        if (run === undefined || run === null) return undefined
        if (!isStoredRunRow(run)) fail("storage-corrupt")
        const consentValue = db.query("SELECT * FROM consents WHERE run_id=?").get(runId) as unknown
        const armValue = db.query("SELECT * FROM arms WHERE run_id=?").get(runId) as unknown
        const consent = consentValue === undefined || consentValue === null ? undefined
          : isStoredConsentRow(consentValue) ? consentValue : fail("storage-corrupt")
        const arm = armValue === undefined || armValue === null ? undefined
          : isStoredArmRow(armValue) ? armValue : fail("storage-corrupt")
        const usage = db.query("SELECT * FROM usage WHERE run_id=?").get(runId) as Record<string, unknown> | undefined
        const quota = this.#quota(db)
        const attemptCount = Number((db.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(runId) as { count: number }).count)
        const requestCount = Number((db.query("SELECT count(*) AS count FROM requests WHERE run_id=?").get(runId) as { count: number }).count)
        if (!usage || !Number.isSafeInteger(attemptCount) || !Number.isSafeInteger(requestCount)) fail("storage-corrupt")
        return { run, ...(consent ? { consent } : {}), ...(arm ? { arm } : {}), usage, quota, attemptCount, requestCount }
      } finally { db.exec("ROLLBACK") }
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  #readPrivateTextCleanupSnapshot(db: Database, runId: string): PrivateTextCleanupSnapshot | undefined {
    const runValue = db.query("SELECT * FROM runs WHERE run_id=?").get(runId) as unknown
    if (runValue === undefined || runValue === null) return undefined
    if (!isStoredRunRow(runValue)) fail("storage-corrupt")
    const consentValue = db.query("SELECT * FROM consents WHERE run_id=?").get(runId) as unknown
    const armValue = db.query("SELECT * FROM arms WHERE run_id=?").get(runId) as unknown
    const consent = consentValue === undefined || consentValue === null ? undefined
      : isStoredConsentRow(consentValue) ? consentValue : fail("storage-corrupt")
    const arm = armValue === undefined || armValue === null ? undefined
      : isStoredArmRow(armValue) ? armValue : fail("storage-corrupt")
    const usage = db.query("SELECT * FROM usage WHERE run_id=?").get(runId) as unknown
    if (!isRecord(usage)) fail("storage-corrupt")
    const attemptValues = db.query("SELECT request_id,run_id,dispatch_state,actual_dispatch FROM attempts WHERE run_id=?")
      .all(runId) as unknown[]
    const attempts = attemptValues.map((value) => {
      if (!isRecord(value) || !hasExactKeys(value, ["request_id", "run_id", "dispatch_state", "actual_dispatch"])) fail("storage-corrupt")
      return value as unknown as PrivateTextCleanupAttemptRow
    })
    const requestValues = db.query(`SELECT request_id,run_id,reservation_id,role,phase,charged,dispatch_state,actual_dispatch,
      active_reserved_ms,finished_boot,finished_cont,terminal_class FROM requests WHERE run_id=?`).all(runId) as unknown[]
    const requests = requestValues.map((value) => {
      if (!isRecord(value) || !hasExactKeys(value, ["request_id", "run_id", "reservation_id", "role", "phase", "charged", "dispatch_state",
        "actual_dispatch", "active_reserved_ms", "finished_boot", "finished_cont", "terminal_class"])) fail("storage-corrupt")
      return value as unknown as PrivateTextCleanupRequestRow
    })
    const handoffValues = db.query("SELECT operation,request_id,state FROM canary_handoffs WHERE run_id=?").all(runId) as unknown[]
    const handoffs = handoffValues.map((value) => {
      if (!isRecord(value) || !hasExactKeys(value, ["operation", "request_id", "state"])) fail("storage-corrupt")
      return value as unknown as PrivateTextCleanupHandoffRow
    })
    const retirementValues = db.query("SELECT * FROM private_cleanup_retirements WHERE run_id=? ORDER BY run_revision_after")
      .all(runId) as unknown[]
    const retirementHistory = retirementValues.map((value) => isPrivateTextCleanupRetirementRow(value)
      ? value : fail("storage-corrupt"))
    const previousRetirement = retirementHistory[retirementHistory.length - 1]
    const unresolvedRequestCount = Number((db.query(`SELECT count(*) AS count FROM requests
      WHERE actual_dispatch IS NULL OR dispatch_state NOT IN ('settled','not_dispatched')`).get() as { count: number }).count)
    if (!Number.isSafeInteger(unresolvedRequestCount) || unresolvedRequestCount < 0) fail("storage-corrupt")
    return { run: runValue, ...(consent ? { consent } : {}), ...(arm ? { arm } : {}), usage, quota: this.#quota(db),
      attempts, requests, unresolvedRequestCount, handoffs, retirementHistory, ...(previousRetirement ? { previousRetirement } : {}) }
  }

  inspectPrivateTextCleanup(input: {
    runId: string; artifactsSha256: string; artifactBytes: number; clock: ClockValues; verifyCurrent(): void
  }): { snapshot: PrivateTextCleanupSnapshot; eligibility: PrivateTextCleanupEligibility } {
    if (!UUID.test(input.runId) || !asHash(input.artifactsSha256) || !Number.isSafeInteger(input.artifactBytes) || input.artifactBytes < 0) {
      fail("binding-invalid")
    }
    const db = this.#connect()
    let clockUncertain = false
    try {
      const inspected = transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return undefined }
        input.verifyCurrent()
        const snapshot = this.#readPrivateTextCleanupSnapshot(db, input.runId)
        if (!snapshot) fail("run-stale")
        const eligibility = validatePrivateTextCleanupSnapshot(snapshot, input.clock, input.artifactsSha256,
          input.artifactBytes, this.rootBinding, this.quotaKey)
        input.verifyCurrent()
        return { snapshot, eligibility }
      })
      if (clockUncertain) fail("clock-uncertain")
      if (!inspected) fail("transaction-failed")
      return inspected
    } finally { db.close() }
  }

  commitPrivateTextCleanup(input: {
    expected: PrivateTextCleanupSnapshot
    expectedEligibility: PrivateTextCleanupEligibility
    artifactsSha256: string
    artifactBytes: number
    cleanupOwnerProof: OwnerProof
    retirementId: string
    decisionSubjectHash: string
    clock: ClockValues
    verifyCurrent(): OwnerProof
  }): Omit<SkillOptPrivateTextCleanupRetirement, "inputDeletion" | "trainerDeletion"> {
    if (!asHash(input.artifactsSha256) || !Number.isSafeInteger(input.artifactBytes) || input.artifactBytes < 0 ||
        !asHash(input.decisionSubjectHash) || !UUID.test(input.retirementId)) fail("binding-invalid")
    const db = this.#connect()
    let clockUncertain = false
    let retired: Omit<SkillOptPrivateTextCleanupRetirement, "inputDeletion" | "trainerDeletion"> | undefined
    try {
      transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return }
        const currentProof = input.verifyCurrent()
        if (!isDeepStrictEqual(currentProof, input.cleanupOwnerProof)) fail("owner-unavailable")
        const snapshot = this.#readPrivateTextCleanupSnapshot(db, input.expected.run.run_id)
        if (!snapshot) fail("revision-conflict")
        const eligibility = validatePrivateTextCleanupSnapshot(snapshot, input.clock, input.artifactsSha256,
          input.artifactBytes, this.rootBinding, this.quotaKey)
        if (!isDeepStrictEqual(snapshot.run, input.expected.run) || !isDeepStrictEqual(snapshot.consent, input.expected.consent) ||
            !isDeepStrictEqual(snapshot.arm, input.expected.arm) || !isDeepStrictEqual(snapshot.usage, input.expected.usage) ||
            !samePrivateTextCleanupQuotaBinding(snapshot.quota, input.expected.quota) ||
            !isDeepStrictEqual(snapshot.attempts, input.expected.attempts) || !isDeepStrictEqual(snapshot.requests, input.expected.requests) ||
            snapshot.unresolvedRequestCount !== input.expected.unresolvedRequestCount ||
            !isDeepStrictEqual(snapshot.handoffs, input.expected.handoffs) ||
            !isDeepStrictEqual(snapshot.retirementHistory, input.expected.retirementHistory) ||
            !isDeepStrictEqual(snapshot.previousRetirement, input.expected.previousRetirement) ||
            eligibility.resumed !== input.expectedEligibility.resumed ||
            eligibility.previousRetirementId !== input.expectedEligibility.previousRetirementId ||
            eligibility.runState !== input.expectedEligibility.runState || eligibility.runRevision !== input.expectedEligibility.runRevision ||
            eligibility.artifactBytes !== input.expectedEligibility.artifactBytes) {
          fail("revision-conflict")
        }
        const run = snapshot.run
        const stateBefore = run.state as SkillOptRunState
        const stateAfter = PRIVATE_TEXT_CLEANUP_ZERO_ATTEMPT_STATES.has(stateBefore) ? "EXPIRED" : stateBefore
        const revisionAfter = run.revision + 1
        if (!Number.isSafeInteger(revisionAfter)) fail("storage-corrupt")
        if (PRIVATE_TEXT_CLEANUP_ZERO_ATTEMPT_STATES.has(stateBefore)) {
          const consentUpdate = db.query("UPDATE consents SET state='revoked' WHERE run_id=? AND state='valid'").run(run.run_id)
          const armUpdate = db.query("UPDATE arms SET state='revoked' WHERE run_id=? AND state='armed'").run(run.run_id)
          if (consentUpdate.changes !== (stateBefore === "PREPARED" ? 0 : 1) ||
              armUpdate.changes !== (stateBefore === "ARMED" ? 1 : 0)) fail("revision-conflict")
        }
        const reasonCode = stateAfter === "EXPIRED" ? "run-expired" : run.reason_code
        const updated = db.query(`UPDATE runs SET state=?,reason_code=?,artifact_bytes=artifact_bytes+?,revision=? WHERE run_id=? AND state=? AND revision=?
          AND owner_session_hash=? AND owner_epoch_hash=? AND admission_hash=? AND artifact_bytes=? AND artifact_bytes+?<=?`)
          .run(stateAfter, reasonCode, input.artifactBytes, revisionAfter, run.run_id, run.state, run.revision,
            run.owner_session_hash, run.owner_epoch_hash, run.admission_hash, run.artifact_bytes, input.artifactBytes,
            NATIVE_SKILLOPT_LIMITS.artifactBytes)
        if (updated.changes !== 1) fail("revision-conflict")
        const usageUpdated = db.query(`UPDATE usage SET artifact_bytes=artifact_bytes+?
          WHERE run_id=? AND artifact_bytes=? AND artifact_bytes+?<=?`)
          .run(input.artifactBytes, run.run_id, Number(snapshot.usage.artifact_bytes), input.artifactBytes, NATIVE_SKILLOPT_LIMITS.artifactBytes)
        if (usageUpdated.changes !== 1) fail("revision-conflict")
        const quotaUpdated = db.query("UPDATE quota SET revision=revision+1 WHERE singleton=1 AND revision=?")
          .run(snapshot.quota.revision)
        if (quotaUpdated.changes !== 1) fail("revision-conflict")
        const row = db.query(`INSERT INTO private_cleanup_retirements(retirement_id,run_id,previous_retirement_id,
          artifacts_sha256,operation,root_binding,quota_key,run_state_before,run_revision_before,run_state_after,run_revision_after,
          run_expiry_boot,run_expiry_cont,old_owner_session_hash,old_owner_epoch_hash,old_admission_hash,
          cleanup_owner_session_hash,cleanup_owner_epoch_hash,cleanup_admission_hash,decision_subject_hash,artifact_bytes_charged,
          retired_boot,retired_cont,retired_wall)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(input.retirementId, run.run_id, eligibility.previousRetirementId ?? null, input.artifactsSha256,
            PRIVATE_TEXT_CLEANUP_OPERATION, this.rootBinding, this.quotaKey, stateBefore, run.revision, stateAfter, revisionAfter,
            run.expires_boot, run.expires_cont, run.owner_session_hash, run.owner_epoch_hash, run.admission_hash,
            input.cleanupOwnerProof.sessionHash, input.cleanupOwnerProof.epochHash, input.cleanupOwnerProof.admissionHash,
            input.decisionSubjectHash, input.artifactBytes, input.clock.boot, input.clock.continuous.toString(), input.clock.wall.toString())
        if (row.changes !== 1) fail("transaction-failed")
        const finalProof = input.verifyCurrent()
        if (!isDeepStrictEqual(finalProof, input.cleanupOwnerProof)) fail("owner-unavailable")
        retired = Object.freeze({ retirementId: input.retirementId, runId: run.run_id, state: stateAfter,
          revision: revisionAfter, artifactsSha256: input.artifactsSha256, artifactBytes: input.artifactBytes,
          resumed: eligibility.resumed,
          retiredBoot: input.clock.boot, retiredContinuousNanoseconds: input.clock.continuous.toString() })
      })
      if (clockUncertain) fail("clock-uncertain")
      if (!retired) fail("transaction-failed")
      return retired
    } finally { db.close() }
  }

  assertPrivateTextCleanupDeletion(input: {
    runId: string; kind: "input" | "trainer"; snapshotSha256: string; retirementId: string; revision: number
    runState: SkillOptRunState; decisionSubjectHash: string; cleanupOwnerProof: OwnerProof
  }): void {
    if (!UUID.test(input.runId) || !(input.kind === "input" || input.kind === "trainer") || !asHash(input.snapshotSha256) ||
        !UUID.test(input.retirementId) || !Number.isSafeInteger(input.revision) || input.revision < 1 ||
        !asHash(input.decisionSubjectHash)) fail("binding-invalid")
    const db = this.#read()
    try {
      db.exec("BEGIN DEFERRED")
      try {
        const snapshot = this.#readPrivateTextCleanupSnapshot(db, input.runId)
        if (!snapshot) fail("run-stale")
        if (snapshot.quota.clock_uncertain !== 0) fail("clock-uncertain")
        if (snapshot.quota.pending_request_id !== null) fail("dispatch-pending")
        if (snapshot.quota.active_run_id !== null || snapshot.quota.active_owner_session_hash !== null ||
            snapshot.quota.active_owner_epoch_hash !== null) fail("active-run")
        if (snapshot.unresolvedRequestCount !== 0) fail("dispatch-ambiguous")
        if (!Number.isSafeInteger(snapshot.usage.active_reserved_ms) || snapshot.usage.active_reserved_ms !== 0) fail("active-run")
        const latest = validatePrivateTextCleanupHistory(snapshot.retirementHistory, snapshot.run, this.rootBinding, this.quotaKey)
        if (!latest || latest.retirement_id !== input.retirementId || latest.run_revision_after !== input.revision ||
            latest.run_state_after !== input.runState || snapshot.run.revision !== input.revision || snapshot.run.state !== input.runState ||
            latest.decision_subject_hash !== input.decisionSubjectHash || latest.cleanup_owner_session_hash !== input.cleanupOwnerProof.sessionHash ||
            latest.cleanup_owner_epoch_hash !== input.cleanupOwnerProof.epochHash || latest.cleanup_admission_hash !== input.cleanupOwnerProof.admissionHash ||
            (input.kind === "input" && latest.artifacts_sha256 !== input.snapshotSha256)) fail("revision-conflict")
      } finally { db.exec("ROLLBACK") }
    } catch (error) {
      if (error instanceof SkillOptControllerError) throw error
      failSqlite(error)
    } finally { db.close() }
  }

  commitReentry(input: {
    expected: StoredReentrySnapshot
    expectedRevision: number
    expectedState: "PREPARED" | "CONSENTED" | "ARMED"
    expectedOwner: OwnerProof & { sessionID: string; epoch: string; campaignId: string }
    expectedConsentId?: string
    expectedArm?: Readonly<{ armId: string; consentId: string; watermarkHash: string; seenDigestHashes: string; armedBoot: string; armedCont: string; armedWall: string; expiresBoot: string; expiresCont: string; expiresWall: string }>
    consentId: string
    subjectHash: string
    scheduleSha256: string
    newOwner: OwnerProof & { sessionID: string; epoch: string }
    clock: ClockValues
    expiresBoot: string
    expiresCont: bigint
    expiresWall: bigint
    verifyOwner: () => void
  }): number {
    const db = this.#connect()
    let clockUncertain = false
    try {
      if (!asHash(input.scheduleSha256)) fail("binding-invalid")
      const revision = transaction(db, () => {
        if (!this.#observeClock(db, input.clock)) { clockUncertain = true; return undefined }
        const quota = this.#quota(db)
        if (quota.clock_uncertain === 1) fail("clock-uncertain")
        if (quota.pending_request_id) fail("dispatch-pending")
        if (quota.active_run_id) fail("active-run")
        const runValue = db.query("SELECT * FROM runs WHERE run_id=?").get(input.expected.run.run_id) as unknown
        if (runValue === undefined || runValue === null) fail("revision-conflict")
        if (!isStoredRunRow(runValue)) fail("storage-corrupt")
        const run = runValue
        const trainerProtocolEventCount = db.query("SELECT count(*) AS count FROM trainer_protocol_events WHERE run_id=?")
          .get(input.expected.run.run_id) as { count: number }
        if (!Number.isSafeInteger(trainerProtocolEventCount.count) || trainerProtocolEventCount.count !== 0) fail("recovery-unresolved")
        const consentValue = db.query("SELECT * FROM consents WHERE run_id=?").get(input.expected.run.run_id) as unknown
        const armValue = db.query("SELECT * FROM arms WHERE run_id=?").get(input.expected.run.run_id) as unknown
        const consent = consentValue === undefined || consentValue === null ? undefined
          : isStoredConsentRow(consentValue) ? consentValue : fail("storage-corrupt")
        const arm = armValue === undefined || armValue === null ? undefined
          : isStoredArmRow(armValue) ? armValue : fail("storage-corrupt")
        const usage = db.query("SELECT * FROM usage WHERE run_id=?").get(input.expected.run.run_id) as Record<string, unknown> | undefined
        const attemptCount = Number((db.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(input.expected.run.run_id) as { count: number }).count)
        const requestCount = Number((db.query("SELECT count(*) AS count FROM requests WHERE run_id=?").get(input.expected.run.run_id) as { count: number }).count)
        if (!Number.isSafeInteger(run.revision) || run.revision !== input.expectedRevision || run.state !== input.expectedState ||
            !usage || !isDeepStrictEqual(run, input.expected.run) || !isDeepStrictEqual(usage, input.expected.usage) ||
            attemptCount !== 0 || requestCount !== 0 || input.expected.attemptCount !== 0 || input.expected.requestCount !== 0 ||
            quota.revision !== input.expected.quota.revision || quota.last_attempt_id !== input.expected.quota.last_attempt_id ||
            quota.last_attempt_boot !== input.expected.quota.last_attempt_boot || quota.last_attempt_cont !== input.expected.quota.last_attempt_cont ||
            quota.fence_boot !== input.expected.quota.fence_boot || quota.fence_cont !== input.expected.quota.fence_cont) fail("revision-conflict")
        if (run.campaign_id !== input.expectedOwner.campaignId || run.campaign_hash !== sha256(input.expectedOwner.campaignId) ||
            run.owner_session_id !== input.expectedOwner.sessionID || run.owner_epoch !== input.expectedOwner.epoch ||
            run.owner_session_hash !== input.expectedOwner.sessionHash || run.owner_epoch_hash !== input.expectedOwner.epochHash ||
            run.admission_hash !== input.expectedOwner.admissionHash || run.binding_hash !== input.expected.run.binding_hash) fail("revision-conflict")
        if (input.expectedState === "PREPARED") {
          if (consent || arm || input.expected.consent || input.expected.arm || input.expectedConsentId || input.expectedArm) fail("revision-conflict")
        } else {
          if (!consent || !input.expected.consent || !isDeepStrictEqual(consent, input.expected.consent) ||
              consent.schedule_hash !== input.scheduleSha256 || consent.consent_id !== input.expectedConsentId ||
              consent.consent_id !== input.expected.consent.consent_id || consent.state !== "valid" ||
              consent.subject_hash !== input.expected.consent.subject_hash || consent.binding_hash !== input.expected.consent.binding_hash ||
              consent.owner_session_hash !== input.expected.consent.owner_session_hash || consent.owner_epoch_hash !== input.expected.consent.owner_epoch_hash ||
              consent.admission_hash !== input.expected.consent.admission_hash || consent.expires_boot !== input.expected.consent.expires_boot ||
              consent.expires_cont !== input.expected.consent.expires_cont || consent.expires_wall !== input.expected.consent.expires_wall) fail("revision-conflict")
          if (input.expectedState === "CONSENTED") {
            if (arm || input.expected.arm || input.expectedArm) fail("revision-conflict")
          } else if (!arm || !input.expected.arm || !isDeepStrictEqual(arm, input.expected.arm) || !input.expectedArm || arm.arm_id !== input.expectedArm.armId ||
              arm.consent_id !== input.expectedArm.consentId || arm.watermark_hash !== input.expectedArm.watermarkHash ||
              arm.seen_digest_hashes !== input.expectedArm.seenDigestHashes || arm.armed_boot !== input.expectedArm.armedBoot ||
              arm.armed_cont !== input.expectedArm.armedCont || arm.armed_wall !== input.expectedArm.armedWall ||
              arm.expires_boot !== input.expectedArm.expiresBoot || arm.expires_cont !== input.expectedArm.expiresCont ||
              arm.expires_wall !== input.expectedArm.expiresWall || arm.state !== "armed") fail("revision-conflict")
        }
        if (run.expires_boot !== input.clock.boot || BigInt(run.expires_cont) < input.clock.continuous ||
            BigInt(run.expires_wall) < input.clock.wall) fail("run-expired")
        if (input.expiresBoot !== input.clock.boot || input.expiresCont < input.clock.continuous || input.expiresWall < input.clock.wall ||
            input.expiresCont > BigInt(run.expires_cont) || input.expiresWall > BigInt(run.expires_wall)) fail("consent-expired")
        input.verifyOwner()
        if (consent) {
          db.query(`INSERT INTO consent_provenance(history_id,run_id,consent_id,subject_hash,schedule_hash,binding_hash,owner_session_hash,
            owner_epoch_hash,admission_hash,created_boot,created_cont,created_wall,expires_boot,expires_cont,expires_wall,state,
            superseded_boot,superseded_cont,superseded_wall,reentry_subject_hash)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(randomUUID(), input.expected.run.run_id, consent.consent_id, consent.subject_hash, consent.schedule_hash, consent.binding_hash,
              consent.owner_session_hash, consent.owner_epoch_hash, consent.admission_hash, consent.created_boot, consent.created_cont,
              consent.created_wall, consent.expires_boot, consent.expires_cont, consent.expires_wall, consent.state,
              input.clock.boot, input.clock.continuous.toString(), input.clock.wall.toString(), input.subjectHash)
          const changed = db.query(`UPDATE consents SET consent_id=?,subject_hash=?,schedule_hash=?,owner_session_hash=?,owner_epoch_hash=?,admission_hash=?,
            created_boot=?,created_cont=?,created_wall=?,state='valid' WHERE run_id=? AND consent_id=? AND state='valid'`)
            .run(input.consentId, input.subjectHash, input.scheduleSha256, input.newOwner.sessionHash, input.newOwner.epochHash, input.newOwner.admissionHash,
              input.clock.boot, input.clock.continuous.toString(), input.clock.wall.toString(), input.expected.run.run_id, consent.consent_id)
          if (changed.changes !== 1) fail("revision-conflict")
        } else {
          db.query(`INSERT INTO consents(consent_id,run_id,subject_hash,schedule_hash,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
            created_boot,created_cont,created_wall,expires_boot,expires_cont,expires_wall,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'valid')`)
            .run(input.consentId, input.expected.run.run_id, input.subjectHash, input.scheduleSha256, run.binding_hash, input.newOwner.sessionHash,
              input.newOwner.epochHash, input.newOwner.admissionHash, input.clock.boot, input.clock.continuous.toString(),
              input.clock.wall.toString(), input.expiresBoot, input.expiresCont.toString(), input.expiresWall.toString())
        }
        if (arm) {
          const changed = db.query("UPDATE arms SET consent_id=? WHERE run_id=? AND arm_id=? AND state='armed'")
            .run(input.consentId, input.expected.run.run_id, arm.arm_id)
          if (changed.changes !== 1) fail("revision-conflict")
        }
        const nextState = input.expectedState === "PREPARED" ? "CONSENTED" : input.expectedState
        const updated = db.query(`UPDATE runs SET owner_session_hash=?,owner_epoch_hash=?,owner_session_id=?,owner_epoch=?,admission_hash=?,
          state=?,reason_code=NULL,revision=revision+1 WHERE run_id=? AND revision=? AND state=? AND owner_session_hash=? AND owner_epoch_hash=? AND admission_hash=?`)
          .run(input.newOwner.sessionHash, input.newOwner.epochHash, input.newOwner.sessionID, input.newOwner.epoch,
            input.newOwner.admissionHash, nextState, input.expected.run.run_id, input.expectedRevision, input.expectedState,
            input.expectedOwner.sessionHash, input.expectedOwner.epochHash, input.expectedOwner.admissionHash)
        if (updated.changes !== 1) fail("revision-conflict")
        const saved = db.query("SELECT revision FROM runs WHERE run_id=?").get(input.expected.run.run_id) as { revision: number } | undefined
        if (!saved) fail("storage-corrupt")
        return saved.revision
      })
      if (clockUncertain) fail("clock-uncertain")
      if (revision === undefined) fail("transaction-failed")
      return revision
    } finally { db.close() }
  }

  readStatus(now?: ClockValues): { status: SkillOptControllerStatus; run?: Record<string, unknown>; pending?: Record<string, unknown>; activeRunId?: string; cooldownFenceRequired: boolean } {
    const db = this.#read()
    try {
      const quota = this.#quota(db)
      const run = quota.active_run_id
        ? db.query("SELECT * FROM runs WHERE run_id=?").get(quota.active_run_id) as Record<string, unknown> | undefined
        : db.query("SELECT * FROM runs ORDER BY created_wall DESC,run_id DESC LIMIT 1").get() as Record<string, unknown> | undefined
      const requestCounts = { charged: { target: 0, optimizer: 0, reviewer: 0 }, dispatched: { target: 0, optimizer: 0, reviewer: 0 }, unknown: { target: 0, optimizer: 0, reviewer: 0 } }
      const phaseCounts = {
        trainingAndDevelopment: { charged: 0, dispatched: 0, unknown: 0 },
        finalSafety: { charged: 0, dispatched: 0, unknown: 0 },
        canary: { charged: 0, dispatched: 0, unknown: 0 },
      }
      let remaining: SkillOptControllerStatus["remaining"] = {
        target: NATIVE_SKILLOPT_LIMITS.targetRequests, optimizer: NATIVE_SKILLOPT_LIMITS.optimizerRequests,
        reviewer: NATIVE_SKILLOPT_LIMITS.reviewerRequests, activeMilliseconds: NATIVE_SKILLOPT_LIMITS.activeMilliseconds,
        artifactBytes: NATIVE_SKILLOPT_LIMITS.artifactBytes, candidateSteps: NATIVE_SKILLOPT_LIMITS.candidateSteps,
      }
      let pending: Record<string, unknown> | undefined
      let cooldownRemaining = 0
      let reasonCode: SkillOptReasonCode | undefined
      let state: SkillOptRunState = "DATA_REQUIRED"
      if (run) {
        state = (String(run.state) as SkillOptRunState) ?? "BLOCKED"
        if (run.reason_code) reasonCode = String(run.reason_code) as SkillOptReasonCode
        const usage = db.query("SELECT * FROM usage WHERE run_id=?").get(String(run.run_id)) as Record<string, number> | undefined
        if (usage) {
          requestCounts.charged = this.#countRoleRequests(db, String(run.run_id), "charged")
          requestCounts.dispatched = this.#countRoleRequests(db, String(run.run_id), "dispatched")
          requestCounts.unknown = this.#countRoleRequests(db, String(run.run_id), "unknown")
          const targetRequests = db.query("SELECT phase,charged,actual_dispatch FROM requests WHERE run_id=? AND role='target'")
            .all(String(run.run_id)) as Array<{ phase: SkillOptRequestPhase; charged: number; actual_dispatch: number | null }>
          for (const request of targetRequests) {
            const bucket = request.phase === "train" || request.phase === "dev" ? phaseCounts.trainingAndDevelopment
              : request.phase === "canary" ? phaseCounts.canary : phaseCounts.finalSafety
            if (request.charged === 1) bucket.charged++
            if (request.actual_dispatch === 1) bucket.dispatched++
            else if (request.actual_dispatch === null) bucket.unknown++
          }
          remaining = {
            target: NATIVE_SKILLOPT_LIMITS.targetRequests - usage.target_requests,
            optimizer: NATIVE_SKILLOPT_LIMITS.optimizerRequests - usage.optimizer_requests,
            reviewer: NATIVE_SKILLOPT_LIMITS.reviewerRequests - usage.reviewer_requests,
            activeMilliseconds: Math.max(0, NATIVE_SKILLOPT_LIMITS.activeMilliseconds - usage.active_ms - usage.active_reserved_ms),
            artifactBytes: NATIVE_SKILLOPT_LIMITS.artifactBytes - usage.artifact_bytes,
            candidateSteps: NATIVE_SKILLOPT_LIMITS.candidateSteps - usage.candidate_steps,
          }
        }
      }
      if (quota.pending_request_id) {
        pending = db.query("SELECT * FROM requests WHERE request_id=?").get(quota.pending_request_id) as Record<string, unknown> | undefined
        state = pending?.dispatch_state === "unknown" || pending?.dispatch_state === "possible" ? "UNRESOLVED" : "DISPATCH_PENDING"
        reasonCode = "dispatch-pending"
      }
      const sampleBoot = now?.boot ?? quota.clock_boot
      const sampleCont = now?.continuous.toString() ?? quota.clock_cont
      const cooldownFenceRequired = Boolean(now && quota.last_attempt_id && quota.last_attempt_boot &&
        quota.last_attempt_boot !== now.boot && (quota.fence_boot !== now.boot || !quota.fence_cont))
      if (now && !quota.pending_request_id && quota.clock_boot && quota.clock_cont && quota.clock_wall) {
        const previousMono = BigInt(quota.clock_cont)
        const elapsed = now.continuous - previousMono
        const wallDelta = now.wall - BigInt(quota.clock_wall)
        const monoMilliseconds = elapsed / 1_000_000n
        const discrepancy = wallDelta > monoMilliseconds ? wallDelta - monoMilliseconds : monoMilliseconds - wallDelta
        if (quota.clock_boot === now.boot && (elapsed < 0n || wallDelta < 0n || discrepancy > WALL_CLOCK_TOLERANCE_MS)) {
          state = "BLOCKED"
          reasonCode = "clock-uncertain"
        }
      }
      if (quota.clock_uncertain === 1 && !quota.pending_request_id) { state = "BLOCKED"; reasonCode = "clock-uncertain" }
      if (quota.last_attempt_id && quota.last_attempt_boot && quota.last_attempt_cont && sampleBoot && sampleCont) {
        if (quota.last_attempt_boot === sampleBoot) {
          const elapsed = BigInt(sampleCont) - BigInt(quota.last_attempt_cont)
          cooldownRemaining = Number(elapsed >= DAILY_COOLDOWN_NS ? 0n : (DAILY_COOLDOWN_NS - elapsed) / 1_000_000n)
        } else {
          const fence = quota.fence_boot === sampleBoot && quota.fence_cont ? BigInt(quota.fence_cont) : undefined
          cooldownRemaining = fence === undefined ? 24 * 60 * 60 * 1000 : Number((DAILY_COOLDOWN_NS - (BigInt(sampleCont) - fence)) / 1_000_000n)
          cooldownRemaining = Math.max(0, cooldownRemaining)
        }
      }
      return {
        status: Object.freeze({ state, ...(reasonCode ? { reasonCode } : {}), ...(run ? { runId: String(run.run_id) } : {}),
          revision: Number(run?.revision ?? quota.revision), pendingDispatch: !!quota.pending_request_id,
          quotaKeySha256: this.quotaKey, requestCounts, targetPhaseCounts: phaseCounts, remaining,
          dailyCooldownRemainingMilliseconds: cooldownRemaining }),
        run, pending, activeRunId: quota.active_run_id ?? undefined, cooldownFenceRequired,
      }
    } finally { db.close() }
  }

  readConsent(runId: string): Readonly<{
    consentId: string; subjectHash: string; scheduleSha256: string; bindingHash: string; ownerSessionHash: string; ownerEpochHash: string
    admissionHash: string; expiresBoot: string; expiresCont: string; expiresWall: string; state: string
  }> | undefined {
    const db = this.#read()
    try {
      const row = db.query(`SELECT consent_id,subject_hash,schedule_hash,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
        expires_boot,expires_cont,expires_wall,state FROM consents WHERE run_id=?`).get(runId) as Record<string, unknown> | undefined
      if (!row) return undefined
      if (typeof row.consent_id !== "string" || !UUID.test(row.consent_id) ||
          ![row.subject_hash, row.schedule_hash, row.binding_hash, row.owner_session_hash, row.owner_epoch_hash, row.admission_hash]
          .every((value) => typeof value === "string" && HASH.test(value)) || typeof row.expires_boot !== "string" ||
          boundedClockDecimal(row.expires_cont) === undefined || boundedClockDecimal(row.expires_wall) === undefined ||
          (row.state !== "valid" && row.state !== "revoked" && row.state !== "invalidated")) fail("storage-corrupt")
      return Object.freeze({ consentId: String(row.consent_id), subjectHash: String(row.subject_hash), scheduleSha256: String(row.schedule_hash), bindingHash: String(row.binding_hash),
        ownerSessionHash: String(row.owner_session_hash), ownerEpochHash: String(row.owner_epoch_hash), admissionHash: String(row.admission_hash),
        expiresBoot: row.expires_boot, expiresCont: String(row.expires_cont), expiresWall: String(row.expires_wall), state: row.state })
    } finally { db.close() }
  }

  readCampaignQualification(runId: string): NativeCampaignQualificationBinding | undefined {
    const db = this.#read()
    try {
      const row = db.query(`SELECT run_id,binding_hash,schedule_hash,candidate_hash,results_hash,review_hash
        FROM campaign_qualifications WHERE run_id=?`).get(runId) as Record<string, unknown> | undefined
      if (!row) return undefined
      if (row.run_id !== runId ||
          ![row.binding_hash, row.schedule_hash, row.candidate_hash, row.results_hash, row.review_hash].every(asHash)) fail("storage-corrupt")
      return Object.freeze({ runId, bindingSha256: String(row.binding_hash), scheduleSha256: String(row.schedule_hash),
        candidateSha256: String(row.candidate_hash), resultsSha256: String(row.results_hash), reviewSha256: String(row.review_hash) })
    } finally { db.close() }
  }

  seedForTests(input: {
    runId: string; bindingHash: string; datasetHash?: string; dataHash?: string; modelHash?: string; protocolHash?: string; baselineHash?: string
    ownerSessionHash?: string; ownerEpochHash?: string; admissionHash?: string; consentId: string; armId: string
    clock: ClockValues; expiresMilliseconds?: bigint; seenDigestHashes?: readonly string[]; expectedRevision?: number
    initialUsage?: SkillOptTestArmedSeed["initialUsage"]
  }): void {
    const h = (v: string | undefined) => v ?? "a".repeat(64)
    const expiryMs = input.expiresMilliseconds ?? RUN_TTL_MS
    const db = this.#connect()
    try {
      transaction(db, () => {
        this.#observeClock(db, input.clock)
        const nowWall = input.clock.wall
        const expiryWall = nowWall + expiryMs
        const expiryCont = input.clock.continuous + expiryMs * 1_000_000n
        db.query(`INSERT INTO runs(run_id,campaign_hash,owner_session_hash,owner_epoch_hash,admission_hash,binding_hash,dataset_hash,data_hash,
          model_hash,protocol_hash,baseline_hash,created_boot,created_cont,created_wall,expires_boot,expires_cont,expires_wall,state,revision)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ARMED',?)`)
          .run(input.runId, h(undefined), h(input.ownerSessionHash), h(input.ownerEpochHash), h(input.admissionHash), input.bindingHash,
            h(input.datasetHash), h(input.dataHash), h(input.modelHash), h(input.protocolHash), h(input.baselineHash), input.clock.boot,
            input.clock.continuous.toString(), nowWall.toString(), input.clock.boot, expiryCont.toString(), expiryWall.toString(), input.expectedRevision ?? 2)
        db.query("INSERT INTO usage(run_id) VALUES(?)").run(input.runId)
        const usage = input.initialUsage ?? {}
        const initialCounts = [usage.targetRequests ?? 0, usage.optimizerRequests ?? 0, usage.reviewerRequests ?? 0,
          usage.finalSafetyRequests ?? 0, usage.canaryRequests ?? 0]
        if (initialCounts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
            initialCounts[0]! > NATIVE_SKILLOPT_LIMITS.targetRequests || initialCounts[1]! > NATIVE_SKILLOPT_LIMITS.optimizerRequests ||
            initialCounts[2]! > NATIVE_SKILLOPT_LIMITS.reviewerRequests || initialCounts[3]! > FINAL_SAFETY_RESERVE ||
            initialCounts[4]! > CANARY_RESERVE || initialCounts[0]! < initialCounts[3]! + initialCounts[4]!) fail("binding-invalid")
        db.query(`UPDATE usage SET target_requests=?,optimizer_requests=?,reviewer_requests=?,final_safety_requests=?,canary_requests=?
          WHERE run_id=?`).run(...initialCounts, input.runId)
        const expiresWall = nowWall + CONSENT_TTL_MS
        const expiresCont = input.clock.continuous + CONSENT_TTL_MS * 1_000_000n
        db.query(`INSERT INTO consents(consent_id,run_id,subject_hash,schedule_hash,binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,
          created_boot,created_cont,created_wall,expires_boot,expires_cont,expires_wall,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'valid')`)
          .run(input.consentId, input.runId, h(undefined), h(undefined), input.bindingHash, h(input.ownerSessionHash), h(input.ownerEpochHash), h(input.admissionHash),
            input.clock.boot, input.clock.continuous.toString(), nowWall.toString(), input.clock.boot, expiresCont.toString(), expiresWall.toString())
        const seen = [...(input.seenDigestHashes ?? [])]
        db.query(`INSERT INTO arms(arm_id,run_id,consent_id,watermark_hash,seen_digest_hashes,armed_boot,armed_cont,armed_wall,
          expires_boot,expires_cont,expires_wall,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,'armed')`)
          .run(input.armId, input.runId, input.consentId, sha256(canonicalJson(seen)), JSON.stringify(seen), input.clock.boot,
            input.clock.continuous.toString(), nowWall.toString(), input.clock.boot, expiresCont.toString(), expiresWall.toString())
      })
    } finally { db.close() }
  }

  settleForTests(runId: string, requestId: string, clock: ClockValues): void {
    const db = this.#connect()
    try {
      transaction(db, () => {
        const request = db.query("SELECT active_reserved_ms FROM requests WHERE request_id=? AND run_id=?").get(requestId, runId) as { active_reserved_ms: number } | undefined
        const usage = db.query("SELECT active_reserved_ms FROM usage WHERE run_id=?").get(runId) as { active_reserved_ms: number } | undefined
        if (request && usage && usage.active_reserved_ms >= request.active_reserved_ms) {
          db.query("UPDATE usage SET active_reserved_ms=active_reserved_ms-? WHERE run_id=?").run(request.active_reserved_ms, runId)
          db.query("UPDATE requests SET active_reserved_ms=0,dispatch_state='not_dispatched',actual_dispatch=0 WHERE request_id=? AND run_id=?").run(requestId, runId)
        }
        db.query("UPDATE attempts SET dispatch_state='not_dispatched',actual_dispatch=0 WHERE request_id=? AND run_id=?").run(requestId, runId)
        db.query(`UPDATE quota SET pending_request_id=NULL,active_run_id=NULL,active_owner_session_hash=NULL,active_owner_epoch_hash=NULL,
          last_attempt_boot=?,last_attempt_cont=?,revision=revision+1 WHERE singleton=1`).run(clock.boot, clock.continuous.toString())
        db.query("UPDATE runs SET state='CANCELLED',revision=revision+1 WHERE run_id=?").run(runId)
      })
    } finally { db.close() }
  }

  chargeRequestForTests(runId: string, role: SkillOptRequestRole, phase: SkillOptRequestPhase, clock: ClockValues): string {
    const requestId = randomUUID()
    const reservationId = randomUUID()
    const db = this.#connect()
    try {
      transaction(db, () => {
        const run = db.query("SELECT binding_hash,owner_epoch_hash FROM runs WHERE run_id=?").get(runId) as Record<string, unknown> | undefined
        if (!run) fail("run-stale")
        this.#chargeRequest(db, runId, role, phase, clock)
        db.query("UPDATE usage SET active_reserved_ms=active_reserved_ms-? WHERE run_id=?")
          .run(NATIVE_SKILLOPT_LIMITS.requestMilliseconds, runId)
        db.query(`INSERT INTO requests(request_id,run_id,reservation_id,role,phase,binding_hash,owner_epoch_hash,charged,
          actual_dispatch,dispatch_state,created_boot,created_cont,created_wall,active_reserved_ms)
          VALUES(?,?,?,?,?,?,?,1,0,'not_dispatched',?,?,?,0)`)
          .run(requestId, runId, reservationId, role, phase, String(run.binding_hash), String(run.owner_epoch_hash),
            clock.boot, clock.continuous.toString(), clock.wall.toString())
      })
      return requestId
    } finally { db.close() }
  }

  #latchClockUncertain(db: Database, clock?: ClockValues): void {
    this.#quota(db)
    if (clock) {
      db.query(`UPDATE quota SET clock_uncertain=1,revision=revision+1,fence_boot=?,fence_cont=?,
        clock_boot=?,clock_cont=?,clock_wall=? WHERE singleton=1`)
        .run(clock.boot, clock.continuous.toString(), clock.boot, clock.continuous.toString(), clock.wall.toString())
    } else {
      db.query(`UPDATE quota SET clock_uncertain=1,revision=revision+1,fence_boot=NULL,fence_cont=NULL WHERE singleton=1`).run()
    }
    db.query("UPDATE consents SET state='invalidated' WHERE state='valid'").run()
    db.query("UPDATE arms SET state='revoked' WHERE state='armed'").run()
    db.query("UPDATE runs SET revision=revision+1 WHERE state='PREPARED'").run()
  }

  #observeClock(db: Database, clock: ClockValues): boolean {
    const row = this.#quota(db)
    const hasLatest = row.clock_boot !== null && row.clock_cont !== null && row.clock_wall !== null
    if (row.clock_uncertain === 1) {
      let reanchor = !hasLatest || row.clock_boot !== clock.boot || row.fence_boot !== clock.boot || row.fence_cont === null
      if (!reanchor) {
        const monoDelta = clock.continuous - BigInt(row.clock_cont!)
        const wallDelta = clock.wall - BigInt(row.clock_wall!)
        const monoMs = monoDelta / 1_000_000n
        const discrepancy = wallDelta > monoMs ? wallDelta - monoMs : monoMs - wallDelta
        if (monoDelta < 0n || wallDelta < 0n || discrepancy > WALL_CLOCK_TOLERANCE_MS ||
            clock.continuous < BigInt(row.fence_cont!)) reanchor = true
      }
      if (reanchor) this.#latchClockUncertain(db, clock)
      else db.query("UPDATE quota SET clock_boot=?,clock_cont=?,clock_wall=? WHERE singleton=1")
        .run(clock.boot, clock.continuous.toString(), clock.wall.toString())
      return false
    }
    if (hasLatest) {
      if (row.clock_boot === clock.boot) {
        const monoDelta = clock.continuous - BigInt(row.clock_cont!)
        const wallDelta = clock.wall - BigInt(row.clock_wall!)
        const monoMs = monoDelta / 1_000_000n
        const discrepancy = wallDelta > monoMs ? wallDelta - monoMs : monoMs - wallDelta
        if (monoDelta < 0n || wallDelta < 0n || discrepancy > WALL_CLOCK_TOLERANCE_MS) {
          this.#latchClockUncertain(db, clock)
          return false
        }
      } else if (row.last_attempt_id && (row.fence_boot !== clock.boot || row.fence_cont === null)) {
        db.query("UPDATE quota SET fence_boot=?,fence_cont=?,revision=revision+1 WHERE singleton=1")
          .run(clock.boot, clock.continuous.toString())
      }
    }
    db.query("UPDATE quota SET clock_boot=?,clock_cont=?,clock_wall=? WHERE singleton=1")
      .run(clock.boot, clock.continuous.toString(), clock.wall.toString())
    return true
  }

  #enforceCooldown(db: Database, clock: ClockValues): boolean {
    const row = this.#quota(db)
    if (row.clock_uncertain === 1) fail("clock-uncertain")
    if (!row.last_attempt_id || !row.last_attempt_boot || !row.last_attempt_cont) return true
    let elapsed: bigint
    if (row.last_attempt_boot === clock.boot) {
      elapsed = clock.continuous - BigInt(row.last_attempt_cont)
      if (elapsed < 0n) fail("clock-uncertain")
    } else {
      let fenceBoot = row.fence_boot
      let fenceCont = row.fence_cont
      if (fenceBoot !== clock.boot || !fenceCont) {
        fenceBoot = clock.boot
        fenceCont = clock.continuous.toString()
        db.query("UPDATE quota SET fence_boot=?,fence_cont=?,revision=revision+1 WHERE singleton=1").run(fenceBoot, fenceCont)
      }
      elapsed = clock.continuous - BigInt(fenceCont)
      if (elapsed < 0n) fail("clock-uncertain")
    }
    return elapsed >= DAILY_COOLDOWN_NS
  }

  #chargeRequest(db: Database, runId: string, role: SkillOptRequestRole, phase: SkillOptRequestPhase, _clock: ClockValues): void {
    if (!(role === "target" || role === "optimizer" || role === "reviewer") || !["train", "dev", "final", "safety", "canary"].includes(phase)) fail("binding-invalid")
    if (role === "optimizer" && phase !== "train" || role === "reviewer" && (phase === "train" || phase === "canary")) fail("binding-invalid")
    const usage = db.query("SELECT * FROM usage WHERE run_id=?").get(runId) as Record<string, number> | undefined
    if (!usage) fail("run-stale")
    const activeMs = Number(usage.active_ms ?? 0) + Number(usage.active_reserved_ms ?? 0)
    if (activeMs + NATIVE_SKILLOPT_LIMITS.requestMilliseconds > NATIVE_SKILLOPT_LIMITS.activeMilliseconds) fail("budget-exhausted")
    if (role === "target") {
      if (usage.target_requests >= NATIVE_SKILLOPT_LIMITS.targetRequests) fail("budget-exhausted")
      const trainingRequests = usage.target_requests - usage.final_safety_requests - usage.canary_requests
      if ((phase === "train" || phase === "dev") && trainingRequests >= NATIVE_SKILLOPT_LIMITS.targetRequests - TARGET_RESERVE) fail("budget-exhausted")
      if ((phase === "final" || phase === "safety") && usage.final_safety_requests >= FINAL_SAFETY_RESERVE) fail("budget-exhausted")
      if (phase === "canary" && usage.canary_requests >= CANARY_RESERVE) fail("budget-exhausted")
      db.query("UPDATE usage SET target_requests=target_requests+1 WHERE run_id=?").run(runId)
      if (phase === "final" || phase === "safety") db.query("UPDATE usage SET final_safety_requests=final_safety_requests+1 WHERE run_id=?").run(runId)
      if (phase === "canary") db.query("UPDATE usage SET canary_requests=canary_requests+1 WHERE run_id=?").run(runId)
    } else if (role === "optimizer") {
      if (usage.optimizer_requests >= NATIVE_SKILLOPT_LIMITS.optimizerRequests) fail("budget-exhausted")
      db.query("UPDATE usage SET optimizer_requests=optimizer_requests+1 WHERE run_id=?").run(runId)
    } else {
      if (usage.reviewer_requests >= NATIVE_SKILLOPT_LIMITS.reviewerRequests) fail("budget-exhausted")
      db.query("UPDATE usage SET reviewer_requests=reviewer_requests+1 WHERE run_id=?").run(runId)
    }
    db.query("UPDATE usage SET active_reserved_ms=active_reserved_ms+? WHERE run_id=?")
      .run(NATIVE_SKILLOPT_LIMITS.requestMilliseconds, runId)
  }

  #validateReference(reference: ExecutionReference, expectedID: string): void {
    if (!reference || typeof reference !== "object" || Array.isArray(reference) || reference.executionID !== expectedID ||
        !REQUEST_ID.test(reference.executionID) || Object.keys(reference).some((key) => !["executionID", "vendorSessionID", "vendorThreadID", "vendorTurnID"].includes(key)) ||
        Object.values(reference).some((value) => value !== undefined && (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)))) fail("dispatch-not-authorized")
  }

  #quota(db: Database): QuotaRow {
    const row = db.query("SELECT * FROM quota WHERE singleton=1").get() as QuotaRow | undefined
    if (!row || row.quota_key !== this.quotaKey || row.root_binding !== this.rootBinding || row.target !== PILOT_SKILL) fail("storage-corrupt")
    return row
  }

  #countRoleRequests(db: Database, runId: string, kind: "charged" | "dispatched" | "unknown"): Record<SkillOptRequestRole, number> {
    const output: Record<SkillOptRequestRole, number> = { target: 0, optimizer: 0, reviewer: 0 }
    const rows = db.query("SELECT role,charged,actual_dispatch FROM requests WHERE run_id=?").all(runId) as Array<{ role: SkillOptRequestRole; charged: number; actual_dispatch: number | null }>
    for (const row of rows) {
      if (kind === "charged" && row.charged === 1) output[row.role]++
      else if (kind === "dispatched" && row.actual_dispatch === 1) output[row.role]++
      else if (kind === "unknown" && row.actual_dispatch === null) output[row.role]++
    }
    return output
  }
}

function createStorage(options: LedgerOptions): SkillOptAutomationLedger {
  if (!asHash(options.rootBinding) || !asHash(options.quotaKey)) fail("binding-invalid")
  return new SkillOptAutomationLedger(options)
}

/**
 * Temporary-storage-only transaction seam. It can seed synthetic rows and exercise durable clock/accounting
 * transactions, but it cannot construct OperatorDecision, controller consent/arm tokens, or a dispatch ticket.
 */
export function createSkillOptStorageForTests(input: Readonly<{
  databasePath: string
  worktreeRoot: string
  clock: () => SkillOptClockSample
}>): Readonly<{
  initialize(): void
  snapshot(): SkillOptControllerStatus
  prepareForTests(): { runId: string; revision: number }
  seedArmedRun(seed: SkillOptTestArmedSeed): void
  reserveAutomatic(input: SkillOptTestReservationInput): { reservationId: string; requestId: string; revision: number }
  reserveWithFault(input: SkillOptTestReservationInput): { reservationId: string; requestId: string; revision: number }
  chargeRequest(runId: string, role: SkillOptRequestRole, phase: SkillOptRequestPhase): string
  settle(runId: string, requestId: string): void
}> {
  const testRoot = canonicalRoot(input.worktreeRoot)
  const temporaryRoot = canonicalRoot(tmpdir())
  const tempRelative = relative(temporaryRoot, testRoot)
  const suppliedRoot = resolve(input.worktreeRoot)
  const suppliedDatabasePath = resolve(input.databasePath)
  const databaseRelative = relative(suppliedRoot, suppliedDatabasePath)
  if (!tempRelative || tempRelative === "." || tempRelative.startsWith("..") || isAbsolute(tempRelative) ||
      !databaseRelative || databaseRelative === "." || databaseRelative.startsWith("..") || isAbsolute(databaseRelative)) fail("storage-permission")
  privateDirectory(testRoot)
  const databasePath = join(testRoot, databaseRelative)
  const rootBinding = sha256(testRoot)
  const quotaKey = sha256(canonicalJson({ schema: "skillopt.automation-quota-key.v1", rootBinding, target: PILOT_SKILL }))
  const ledger = createStorage({ path: databasePath, rootBinding, quotaKey })
  const currentClock = (): ClockValues => clockValues(input.clock())
  const reserveSeed = (seed: SkillOptTestReservationInput): ReserveSeed => ({
    ...seed,
    ownerSessionHash: seed.ownerSessionHash ?? "a".repeat(64),
    ownerEpochHash: seed.ownerEpochHash ?? "a".repeat(64),
    admissionHash: seed.admissionHash ?? "a".repeat(64),
    clock: currentClock(), role: "target", phase: "train",
  })
  return Object.freeze({
    initialize() { ledger.initialize(true) },
    snapshot() { return ledger.readStatus(currentClock()).status },
    prepareForTests() {
      const clock = currentClock()
      const runId = randomUUID()
      const campaignId = `test_clock_recovery_${runId.replaceAll("-", "")}`
      const revision = ledger.putPrepared({
        runId, campaignHash: sha256(campaignId), campaignId, ownerSessionHash: "a".repeat(64), ownerEpochHash: "b".repeat(64),
        ownerSessionId: "test-session", ownerEpoch: "test-epoch", admissionHash: "c".repeat(64),
        bindingHash: "d".repeat(64), datasetHash: "e".repeat(64), dataHash: "f".repeat(64), modelHash: "1".repeat(64),
        protocolHash: "2".repeat(64), baselineHash: "3".repeat(64), clock,
        expiresWall: clock.wall + RUN_TTL_MS, expiresCont: clock.continuous + RUN_TTL_MS * 1_000_000n, fixtureBytes: 0,
      })
      return { runId, revision }
    },
    seedArmedRun(seed) { ledger.seedForTests({ ...seed, clock: clockValues(seed.clock ?? input.clock()) }) },
    reserveAutomatic(seed) { return ledger.reserveAutomatic(reserveSeed(seed)) },
    reserveWithFault(seed) { return ledger.reserveAutomatic(reserveSeed(seed)) },
    chargeRequest(runId, role, phase) { return ledger.chargeRequestForTests(runId, role, phase, currentClock()) },
    settle(runId, requestId) { ledger.settleForTests(runId, requestId, currentClock()) },
  })
}

function ownerProof(runtime: ExecutionRuntime, worktree: string, owner: SessionStore, allowAdmissionHeld = false): { sessionHash: string; epochHash: string; admissionHash: string } {
  if (!owner || typeof owner.sessionID !== "string" || !SESSION_ID.test(owner.sessionID)) fail("owner-unavailable")
  try {
    if (getOwnedSession(worktree, owner.sessionID) !== owner || owner.isReleased) fail("owner-unavailable")
    owner.assertOwner()
    if (realpathSync.native(runtime.worktree) !== worktree || !readSessionMetadata(worktree, owner.sessionID)) fail("owner-unavailable")
    if (admissionEpoch(worktree, owner.sessionID) !== owner.epoch || !isAdmissionCurrent(worktree, owner.sessionID, owner.epoch)) fail("admission-held")
    if (!allowAdmissionHeld && (owner.metadata.held || effectiveHold(worktree, owner.sessionID))) fail("admission-held")
    const fence = admissionFence(worktree, owner.sessionID)
    return { sessionHash: sha256(owner.sessionID), epochHash: sha256(owner.epoch), admissionHash: sha256(fence) }
  } catch (error) {
    if (error instanceof SkillOptControllerError) throw error
    fail("owner-unavailable")
  }
}

function assertRuntimeIdle(runtime: ExecutionRuntime, owner: SessionStore, claim?: ExecutionClaim): void {
  try {
    const queue = getQueue(runtime)
    const runState = runtime.runs.status()
    const activeClaim = runState.claim
    const ownsClaim = !!claim && !!activeClaim && activeClaim.ownerSession === claim.ownerSession && activeClaim.instance === claim.instance &&
      activeClaim.pid === claim.pid && activeClaim.generation === claim.generation
    if (queue.isRunning(owner.sessionID) || (runState.claim && !ownsClaim) || runState.executions.some((execution) => !settled(execution))) fail("owner-busy")
  } catch (error) {
    if (error instanceof SkillOptControllerError) throw error
    fail("owner-busy")
  }
}

function assertMutationClaim(runtime: ExecutionRuntime, owner: SessionStore, claim: ExecutionClaim): void {
  try {
    if (!claim || typeof claim !== "object" || !owner || claim.ownerSession !== owner.sessionID) fail("owner-unavailable")
    runtime.runs.assertQuiescent(claim)
  } catch (error) {
    if (error instanceof SkillOptControllerError) throw error
    fail("owner-busy")
  }
  assertRuntimeIdle(runtime, owner, claim)
}

function assertOwnerIdle(runtime: ExecutionRuntime, owner: SessionStore): void {
  try {
    const queue = getQueue(runtime)
    const executions = runtime.runs.status().executions
    if (queue.isRunning(owner.sessionID) || executions.some(execution => execution.ownerSession === owner.sessionID && !settled(execution))) {
      fail("owner-busy")
    }
  } catch (error) {
    if (error instanceof SkillOptControllerError) throw error
    fail("owner-busy")
  }
}

function fixedStateForError(error: unknown): { state: SkillOptRunState; reasonCode: SkillOptReasonCode } {
  if (error instanceof SkillOptControllerError) {
    if (error.code.startsWith("storage-")) return { state: "BLOCKED", reasonCode: error.code }
    if (error.code === "data-required") return { state: "DATA_REQUIRED", reasonCode: error.code }
    if (error.code === "consent-expired" || error.code === "arm-expired" || error.code === "run-expired") return { state: "EXPIRED", reasonCode: error.code }
    if (error.code === "dispatch-pending" || error.code === "dispatch-ambiguous") return { state: "UNRESOLVED", reasonCode: error.code }
    return { state: "BLOCKED", reasonCode: error.code }
  }
  return { state: "BLOCKED", reasonCode: "storage-corrupt" }
}

function makeController(runtime: ExecutionRuntime, nativeHelper: PromotionNativeHelperInput, nativeHost: SkillOptNativeHost): SkillOptController {
  const root = canonicalRoot(runtime.worktree)
  const authority = fixedAuthorityPath(root)
  const helperConfig = Object.freeze({
    nativeHelperPath: nativeHelper.nativeHelperPath,
    nativeHelperSha256: nativeHelper.nativeHelperSha256,
  })
  const ledger = createStorage({ path: authority.databasePath, rootBinding: authority.rootBinding, quotaKey: authority.quotaKey })
  const controllerIdentity = Object.freeze({})
  const nativeCampaignArtifactStageIssuances = new Set<string>()
  const nativeCampaignTargetPlanIssuances = new Set<string>()
  const nativeCampaignTargetPlans = new WeakMap<object, NativeCampaignTargetPlanState>()
  const nativeCampaignTargetBindings = new WeakMap<object, NativeCampaignTargetBindingState>()
  const nativeCampaignTargetResponses = new WeakMap<object, NativeCampaignTargetResponseState>()
  const nativeTrainerOptimizerResponseAllowances = new WeakMap<object, NativeTrainerOptimizerResponseAllowanceState>()
  const nativeTrainerProtocolCapturesByRun = new Map<string, NativeTrainerProtocolCaptureState>()
  const preparedStates = new WeakMap<object, PreparedState>()
  const preparedStatesByRun = new Map<string, PreparedState>()
  const consentStates = new WeakMap<object, ConsentState>()
  const consentByRun = new Map<string, ConsentState>()
  const armStates = new WeakMap<object, ArmState>()
  const armStatesByRun = new Map<string, ArmState>()
  const reentryStates = new WeakMap<object, ReentryState>()
  const privateTextCleanupChallenges = new WeakMap<object, PrivateTextCleanupChallengeState>()
  const privateTextCleanupChallengesByRun = new Map<string, Set<PrivateTextCleanupChallengeState>>()
  const ticketStates = new WeakMap<object, TicketState>()
  const receiptStates = new WeakMap<object, ReceiptState>()
  const canaryPreparations = new WeakMap<object, NativeCanaryPreparationState>()
  const canaryPreparationsByRun = new Map<string, NativeCanaryPreparationState>()
  const rollbackIntents = new WeakMap<object, NativeRollbackIntentState>()
  const rollbackIntentsByRun = new Map<string, NativeRollbackIntentState>()
  const rollbackCanaryPreparations = new WeakMap<object, NativeRollbackCanaryPreparationState>()
  const rollbackCanaryPreparationsByRun = new Map<string, NativeRollbackCanaryPreparationState>()
  const clock = (): ClockValues => {
    try { return clockValues(readSkillOptNativeClock(helperConfig)) } catch {
      ledger.markClockUncertain()
      fail("clock-uncertain")
    }
  }

  function verifyPrivateTextCleanupOwner(owner: SessionStore, runtimeInput: ExecutionRuntime, mutationClaim: ExecutionClaim): OwnerProof {
    if (runtimeInput !== runtime) fail("owner-unavailable")
    const proof = ownerProof(runtime, root, owner)
    assertMutationClaim(runtime, owner, mutationClaim)
    return proof
  }

  function removePrivateTextCleanupChallenge(runId: string, state: PrivateTextCleanupChallengeState): void {
    const states = privateTextCleanupChallengesByRun.get(runId)
    states?.delete(state)
    if (states?.size === 0) privateTextCleanupChallengesByRun.delete(runId)
  }

  function invalidatePrivateTextCleanupChallenges(runId: string): void {
    for (const challenge of privateTextCleanupChallengesByRun.get(runId) ?? []) challenge.used = true
    privateTextCleanupChallengesByRun.delete(runId)
  }

  function revokePrivateTextCleanupCapabilities(runId: string): void {
    invalidatePrivateTextCleanupChallenges(runId)
    const prepared = preparedStatesByRun.get(runId)
    if (prepared) {
      prepared.used = true
      prepared.initialStartConsumed = true
      preparedStatesByRun.delete(runId)
    }
    const consent = consentByRun.get(runId)
    if (consent) consent.used = true
    consentByRun.delete(runId)
    const arm = armStatesByRun.get(runId)
    if (arm) arm.used = true
    armStatesByRun.delete(runId)
    const canary = canaryPreparationsByRun.get(runId)
    if (canary) canary.used.value = true
    canaryPreparationsByRun.delete(runId)
    const rollbackIntent = rollbackIntentsByRun.get(runId)
    if (rollbackIntent) rollbackIntent.used.value = true
    rollbackIntentsByRun.delete(runId)
    const rollbackCanary = rollbackCanaryPreparationsByRun.get(runId)
    if (rollbackCanary) rollbackCanary.used.value = true
    rollbackCanaryPreparationsByRun.delete(runId)
  }

  function currentBindings(value: SkillOptCurrentBinding): {
    dataset: NativeDataset; hashes: ReturnType<typeof skillOptBindingHashes>; campaign: CampaignDisclosure
  } {
    if (!value || typeof value !== "object" || typeof value.baselineSkillSha256 !== "string") fail("binding-invalid")
    if (!asHash(value.baselineSkillSha256)) fail("binding-invalid")
    let liveBaseline: string
    try { liveBaseline = sha256(readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes)) } catch { fail("binding-baseline-drift") }
    if (liveBaseline !== value.baselineSkillSha256) fail("binding-baseline-drift")
    let dataset: NativeDataset
    try { dataset = validateNativeDataset(root, value.dataset) } catch { fail("binding-invalid") }
    if (dataset.status !== "STRUCTURALLY_VALID") fail("data-required")
    if (dataset.protocolSha256 !== NATIVE_PROTOCOL_SHA256) fail("binding-protocol-drift")
    let hashes: ReturnType<typeof skillOptBindingHashes>
    try { hashes = skillOptBindingHashes(root, dataset, value.baselineSkillSha256) } catch { fail("binding-invalid") }
    if (Buffer.byteLength(canonicalJson(dataset.fixturePack), "utf8") > NATIVE_SKILLOPT_LIMITS.fixtureBytes) fail("data-required")
    const campaign = campaignDisclosure(dataset)
    return { dataset, hashes, campaign }
  }

  function requireFreshBinding(expected: PreparedState, current: SkillOptCurrentBinding): {
    dataset: NativeDataset; hashes: ReturnType<typeof skillOptBindingHashes>; campaign: CampaignDisclosure
  } {
    const now = currentBindings(current)
    if (now.hashes.baselineSkillSha256 !== expected.hashes.baselineSkillSha256) fail("binding-baseline-drift")
    if (now.hashes.protocolSha256 !== expected.hashes.protocolSha256) fail("binding-protocol-drift")
    if (now.hashes.modelBindingsSha256 !== expected.hashes.modelBindingsSha256) fail("binding-model-drift")
    if (now.hashes.dataSha256 !== expected.hashes.dataSha256 || now.hashes.datasetSha256 !== expected.hashes.datasetSha256) fail("binding-data-drift")
    if (now.hashes.bindingSha256 !== expected.hashes.bindingSha256) fail("consent-binding-drift")
    if (!isDeepStrictEqual(now.campaign, expected.campaign)) fail("consent-binding-drift")
    return now
  }

  function campaignArtifactStageContext(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
  }>, metadata: SkillOptNativeCampaignArtifactStageMetadata, preparedState: PreparedState) {
    if (input.runtime !== runtime) fail("owner-unavailable")
    if (preparedStates.get(input.prepared as object) !== preparedState || preparedState.owner !== input.owner ||
        preparedState.runId !== metadata.runId || input.prepared.runId !== metadata.runId ||
        input.prepared.bindingSha256 !== metadata.bindingSha256 || preparedState.hashes.bindingSha256 !== metadata.bindingSha256 ||
        metadata.rootBinding !== sha256(`root:${root}`)) fail("consent-binding-drift")
    const proof = ownerProof(runtime, root, input.owner)
    if (proof.sessionHash !== preparedState.ownerSessionHash || proof.epochHash !== preparedState.ownerEpochHash ||
        proof.admissionHash !== preparedState.admissionHash) fail("owner-unavailable")
    assertRuntimeIdle(runtime, input.owner)
    const binding = requireFreshBinding(preparedState, input.current)
    if (!isDeepStrictEqual(binding.hashes, preparedState.hashes)) fail("consent-binding-drift")
    let schedule: NativeCampaignSchedule
    try { schedule = buildNativeCampaignSchedule(binding.dataset.fixturePack) } catch { fail("binding-invalid") }
    if (metadata.scheduleSha256 !== schedule.scheduleSha256 || input.prepared.scheduleSha256 !== schedule.scheduleSha256 ||
        preparedState.campaign.scheduleSha256 !== schedule.scheduleSha256) fail("consent-binding-drift")
    const fixture = binding.dataset.fixturePack.fixtures.find(item => item.id === metadata.fixtureId)
    if (!fixture) fail("binding-invalid")
    if (metadata.scheduleEntry !== null && !scheduleEntryBindsFixture(metadata.scheduleEntry, fixture.id, schedule)) fail("binding-invalid")
    return { proof, binding, schedule }
  }

  function validateRunningCampaignArtifactStage(
    snapshot: StoredReentrySnapshot,
    runId: string,
    revision: number,
    proof: OwnerProof,
    hashes: ReturnType<typeof skillOptBindingHashes>,
    now: ClockValues,
  ): void {
    const run = snapshot.run
    if (run.state !== "RUNNING" || run.revision !== revision) fail("revision-conflict")
    if (run.owner_session_hash !== proof.sessionHash || run.owner_epoch_hash !== proof.epochHash ||
        run.admission_hash !== proof.admissionHash) fail("owner-unavailable")
    if (run.binding_hash !== hashes.bindingSha256 || run.dataset_hash !== hashes.datasetSha256 ||
        run.data_hash !== hashes.dataSha256 || run.model_hash !== hashes.modelBindingsSha256 ||
        run.protocol_hash !== hashes.protocolSha256 || run.baseline_hash !== hashes.baselineSkillSha256) fail("consent-binding-drift")
    if (snapshot.quota.clock_uncertain !== 0) fail("clock-uncertain")
    if (snapshot.quota.pending_request_id !== null) fail("dispatch-pending")
    if (snapshot.quota.active_run_id !== runId || snapshot.quota.active_owner_session_hash !== proof.sessionHash ||
        snapshot.quota.active_owner_epoch_hash !== proof.epochHash) fail("active-run")
    if (run.expires_boot !== now.boot || boundedClockDecimal(run.expires_cont) === undefined ||
        boundedClockDecimal(run.expires_wall) === undefined || BigInt(run.expires_cont) < now.continuous ||
        BigInt(run.expires_wall) < now.wall) fail("run-expired")
    const usage = snapshot.usage
    const activeMs = usage.active_ms
    const activeReservedMs = usage.active_reserved_ms
    const artifactBytes = usage.artifact_bytes
    if (!isNonNegativeSafeInteger(activeMs) || !isNonNegativeSafeInteger(activeReservedMs) ||
        !isNonNegativeSafeInteger(artifactBytes) || !isNonNegativeSafeInteger(run.active_ms) ||
        !isNonNegativeSafeInteger(run.artifact_bytes) || activeMs !== run.active_ms || artifactBytes !== run.artifact_bytes) {
      fail("storage-corrupt")
    }
    if (activeMs + activeReservedMs > NATIVE_SKILLOPT_LIMITS.activeMilliseconds ||
        artifactBytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) fail("budget-exhausted")
    if (snapshot.attemptCount < 1 || snapshot.requestCount < 1) fail("run-stale")
  }

  function assertCampaignArtifactRunLive(run: StoredRunRow, now: ClockValues): void {
    if (!UUID.test(run.expires_boot) || boundedClockDecimal(run.expires_cont) === undefined ||
        boundedClockDecimal(run.expires_wall) === undefined) fail("storage-corrupt")
    if (run.expires_boot !== now.boot || BigInt(run.expires_cont) < now.continuous ||
        BigInt(run.expires_wall) < now.wall) fail("run-expired")
  }

  function nativeTrainerProtocolCaptureContext(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
  }>, state: NativeTrainerProtocolCaptureState): { proof: OwnerProof; binding: ReturnType<typeof currentBindings> } {
    if (input.runtime !== runtime || input.owner !== state.owner || input.prepared !== state.prepared ||
        state.controllerIdentity !== controllerIdentity || state.runtime !== runtime || state.stopped) fail("owner-unavailable")
    const preparedState = preparedStates.get(input.prepared as object)
    if (preparedState !== state.preparedState || preparedState.runId !== state.prepared.runId ||
        !preparedState.initialStartConsumed || preparedState.owner !== input.owner) fail("run-stale")
    const proof = ownerProof(runtime, root, input.owner)
    if (!isDeepStrictEqual(proof, state.ownerProof)) fail("owner-unavailable")
    assertRuntimeIdle(runtime, input.owner)
    const binding = requireFreshBinding(preparedState, input.current)
    if (!isDeepStrictEqual(binding.hashes, state.bindingHashes) ||
        binding.campaign.scheduleSha256 !== state.schedule.scheduleSha256) fail("consent-binding-drift")
    const now = clock()
    const persisted = ledger.readStatus(now)
    const run = persisted.run
    if (!run) fail("run-stale")
    if (!isStoredRunRow(run)) fail("storage-corrupt")
    if (run.run_id !== preparedState.runId || run.state !== "RUNNING" ||
        persisted.activeRunId !== preparedState.runId) fail("run-stale")
    assertCampaignArtifactRunLive(run, now)
    if (persisted.status.pendingDispatch || persisted.pending) fail("dispatch-pending")
    if (run.owner_session_hash !== proof.sessionHash || run.owner_epoch_hash !== proof.epochHash ||
        run.admission_hash !== proof.admissionHash || run.binding_hash !== binding.hashes.bindingSha256 ||
        run.dataset_hash !== binding.hashes.datasetSha256 || run.data_hash !== binding.hashes.dataSha256 ||
        run.model_hash !== binding.hashes.modelBindingsSha256 || run.protocol_hash !== binding.hashes.protocolSha256 ||
        run.baseline_hash !== binding.hashes.baselineSkillSha256) fail("consent-binding-drift")
    if (persisted.status.reasonCode === "clock-uncertain") fail("clock-uncertain")
    const consent = consentByRun.get(preparedState.runId)
    if (!consent || consent.owner !== input.owner || consent.campaign.scheduleSha256 !== state.schedule.scheduleSha256) {
      fail("consent-required")
    }
    assertConsentLive(consent, now)
    return { proof, binding }
  }

  function nativeTrainerProtocolCaptureState(capture: SkillOptNativeTrainerProtocolCapture): NativeTrainerProtocolCaptureState {
    const state = capture && typeof capture === "object" ? nativeTrainerProtocolCaptures.get(capture as object) : undefined
    if (!state || state.controllerIdentity !== controllerIdentity || nativeTrainerProtocolCapturesByRun.get(state.preparedState.runId) !== state ||
        state.stopped) fail("binding-invalid")
    return state
  }

  function nativeTrainerProtocolEventState(event: SkillOptNativeTrainerProtocolEvent): NativeTrainerProtocolEventState {
    const state = event && typeof event === "object" ? nativeTrainerProtocolEvents.get(event as object) : undefined
    if (!state || state.controllerIdentity !== controllerIdentity || state.capture.stopped || state.capture.completed ||
        nativeTrainerProtocolCapturesByRun.get(state.capture.preparedState.runId) !== state.capture ||
        state.capture.events.get(state.event.wireRequestId) !== state) fail("binding-invalid")
    return state
  }

  function quarantineConsumedTrainerProtocolEvent(
    state: NativeTrainerProtocolCaptureState,
  ): never {
    state.stopped = true
    try {
      ledger.markTrainerProtocolRecoveryUnresolved({ runId: state.preparedState.runId,
        owner: state.ownerProof, requirePersistedEvents: false })
    } catch { fail("recovery-unresolved") }
    fail("binding-invalid")
  }

  function verifyTrainerEventForScheduleEntry(
    event: NativeTrainerProtocolEventState,
    metadata: SkillOptNativeCampaignArtifactStageMetadata,
  ): void {
    if (event.event.runId !== metadata.runId || event.request.kind !== "rollout" ||
        event.request.caseId !== metadata.fixtureId || !metadata.scheduleEntry) fail("binding-invalid")
    const entry = metadata.scheduleEntry
    if (entry.kind === "training") {
      if (event.request.cohort !== "training" || entry.caseId !== event.request.caseId || entry.replicate !== event.request.replicate ||
          !event.capture.schedule.training.some(item => item.caseId === entry.caseId && item.replicate === entry.replicate)) fail("binding-invalid")
    } else if (entry.kind === "trainerSelection") {
      if ((event.request.cohort !== "baseline-selection" && event.request.cohort !== "candidate-selection") ||
          entry.caseId !== event.request.caseId || entry.replicate !== event.request.replicate ||
          !event.capture.schedule.trainerSelection.some(item => item.caseId === entry.caseId && item.replicate === entry.replicate)) {
        fail("binding-invalid")
      }
    } else fail("binding-invalid")
  }

  function nativeCampaignTargetContext(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding
  }>, preparedState: PreparedState) {
    if (input.runtime !== runtime || preparedStates.get(input.prepared as object) !== preparedState ||
        preparedState.owner !== input.owner || input.prepared.runId !== preparedState.runId ||
        input.prepared.bindingSha256 !== preparedState.hashes.bindingSha256) fail("owner-unavailable")
    const proof = ownerProof(runtime, root, input.owner)
    if (proof.sessionHash !== preparedState.ownerSessionHash || proof.epochHash !== preparedState.ownerEpochHash ||
        proof.admissionHash !== preparedState.admissionHash) fail("owner-unavailable")
    assertRuntimeIdle(runtime, input.owner)
    const binding = requireFreshBinding(preparedState, input.current)
    if (!isDeepStrictEqual(binding.hashes, preparedState.hashes)) fail("consent-binding-drift")
    let schedule: NativeCampaignSchedule
    try { schedule = buildNativeCampaignSchedule(binding.dataset.fixturePack) } catch { fail("binding-invalid") }
    if (schedule.scheduleSha256 !== preparedState.campaign.scheduleSha256 ||
        input.prepared.scheduleSha256 !== schedule.scheduleSha256) fail("consent-binding-drift")
    const snapshot = ledger.readRunForReentry(preparedState.runId)
    if (!snapshot) fail("run-stale")
    assertCampaignArtifactRunLive(snapshot.run, clock())
    if (snapshot.run.run_id !== preparedState.runId || snapshot.run.owner_session_id !== input.owner.sessionID ||
        snapshot.run.owner_epoch !== input.owner.epoch || snapshot.run.owner_session_hash !== proof.sessionHash ||
        snapshot.run.owner_epoch_hash !== proof.epochHash || snapshot.run.admission_hash !== proof.admissionHash) fail("owner-unavailable")
    if (snapshot.run.binding_hash !== binding.hashes.bindingSha256 || snapshot.run.dataset_hash !== binding.hashes.datasetSha256 ||
        snapshot.run.data_hash !== binding.hashes.dataSha256 || snapshot.run.model_hash !== binding.hashes.modelBindingsSha256 ||
        snapshot.run.protocol_hash !== binding.hashes.protocolSha256 || snapshot.run.baseline_hash !== binding.hashes.baselineSkillSha256) {
      fail("consent-binding-drift")
    }
    return { proof, binding, schedule, snapshot }
  }

  function nativeCampaignTargetPlanState(targetPlan: SkillOptNativeCampaignTargetPlan): NativeCampaignTargetPlanState {
    const state = targetPlan && typeof targetPlan === "object" ? nativeCampaignTargetPlans.get(targetPlan as object) : undefined
    if (!state || state.controllerIdentity !== controllerIdentity) fail("binding-invalid")
    return state
  }

  function nativeCampaignTargetBindingState(target: SkillOptNativeCampaignTargetBinding): NativeCampaignTargetBindingState {
    const state = target && typeof target === "object" ? nativeCampaignTargetBindings.get(target as object) : undefined
    if (!state || state.controllerIdentity !== controllerIdentity) fail("binding-invalid")
    return state
  }

  function nativeCampaignTargetResponseState(target: SkillOptNativeCampaignTargetResponse): NativeCampaignTargetResponseState {
    const state = target && typeof target === "object" ? nativeCampaignTargetResponses.get(target as object) : undefined
    if (!state || state.controllerIdentity !== controllerIdentity) fail("binding-invalid")
    return state
  }

  function assertNativeCampaignTargetConsent(runId: string, owner: SessionStore): void {
    const consent = consentByRun.get(runId)
    if (!consent || consent.owner !== owner) fail("consent-required")
    assertConsentLive(consent, clock())
  }

  function targetPlanMatchesMetadata(
    plan: NativeCampaignTargetPlanState,
    metadata: SkillOptNativeCampaignArtifactStageMetadata,
  ): boolean {
    return metadata.runId === plan.preparedState.runId && metadata.scheduleSha256 === plan.schedule.scheduleSha256 &&
      metadata.fixtureId === plan.fixtureId && metadata.scheduleEntry !== null &&
      canonicalJson(metadata.scheduleEntry) === canonicalJson(plan.scheduleEntry)
  }

  function verifyTrainerProtocolReservation(
    reservation: SkillOptReservation | undefined,
    runId: string,
    event?: NativeTrainerProtocolEventState,
  ): NativeTrainerProtocolReservationState {
    const state = reservation && typeof reservation === "object"
      ? nativeTrainerProtocolReservations.get(reservation as object) : undefined
    if (!reservation || !state || state.controllerIdentity !== controllerIdentity || state.runId !== runId ||
        reservation.runId !== runId || reservation.requestId !== state.requestId || reservation.role !== state.role ||
        reservation.phase !== state.phase || !reservation.charged ||
        (event && (state.event !== event || event.reservationRequestId !== reservation.requestId))) fail("dispatch-not-authorized")
    const ticket = ticketStates.get(reservation.ticket as object)
    const receipt = receiptStates.get(reservation.receipt as object)
    if (!ticket || !receipt || receipt.ticketState !== ticket || ticket.requestId !== state.requestId ||
        ticket.runId !== runId || ticket.role !== "target" || receipt.requestId !== state.requestId) fail("dispatch-not-authorized")
    return state
  }

  function verifyNativeTrainerOptimizerReservation(
    reservation: SkillOptReservation,
    event: NativeTrainerProtocolEventState,
  ): NativeTrainerProtocolReservationState {
    const state = reservation && typeof reservation === "object"
      ? nativeTrainerProtocolReservations.get(reservation as object) : undefined
    if (!state || state.controllerIdentity !== controllerIdentity || state.event !== event || state.runId !== event.capture.preparedState.runId ||
        reservation.runId !== state.runId || reservation.requestId !== state.requestId ||
        reservation.reservationId !== state.reservationId || reservation.role !== "optimizer" || reservation.phase !== "train" ||
        reservation.bindingSha256 !== event.capture.bindingHashes.bindingSha256 ||
        reservation.scheduleSha256 !== event.capture.schedule.scheduleSha256 ||
        state.role !== "optimizer" || state.phase !== "train" || !reservation.charged ||
        event.request.kind !== "optimizer" || !event.reservationAttempted || event.reservationRequestId !== state.requestId) {
      fail("dispatch-not-authorized")
    }
    const ticket = ticketStates.get(reservation.ticket as object)
    const receipt = receiptStates.get(reservation.receipt as object)
    if (!ticket || !receipt || receipt.ticketState !== ticket || ticket.owner !== event.capture.owner ||
        receipt.owner !== event.capture.owner || ticket.runId !== state.runId || ticket.reservationId !== state.reservationId ||
        ticket.requestId !== state.requestId || ticket.role !== "optimizer" || ticket.phase !== "train" ||
        ticket.bindingSha256 !== event.capture.bindingHashes.bindingSha256 ||
        ticket.scheduleSha256 !== event.capture.schedule.scheduleSha256 || !ticket.consumed || !ticket.grantIssued ||
        !ticket.recorded || !receipt.ticketConsumed || !receipt.recorded || receipt.runId !== state.runId ||
        receipt.reservationId !== state.reservationId || receipt.requestId !== state.requestId ||
        !isDeepStrictEqual(ticket.ownerProof, event.capture.ownerProof) ||
        !isDeepStrictEqual(receipt.ownerProof, event.capture.ownerProof)) fail("dispatch-not-authorized")
    return state
  }

  function campaignArtifactProtocolEvidence(
    input: Readonly<{
      trainerEvent?: SkillOptNativeTrainerProtocolEvent
      reservation?: SkillOptReservation
      targetPlan?: SkillOptNativeCampaignTargetPlan
      target?: SkillOptNativeCampaignTargetResponse
    }>,
    metadata: SkillOptNativeCampaignArtifactStageMetadata,
  ): {
    event?: NativeTrainerProtocolEventState
    reservation?: NativeTrainerProtocolReservationState
    targetPlan?: NativeCampaignTargetPlanState
    target?: NativeCampaignTargetResponseState
    protocolEvidence?: {
      event?: NativeTrainerProtocolEventBinding
      reservation?: Readonly<{ requestId: string; reservationId: string; role: SkillOptRequestRole; phase: SkillOptRequestPhase }>
      requireAssociation?: boolean
      requireUnassociated?: boolean
    }
  } {
    const event = input.trainerEvent ? nativeTrainerProtocolEventState(input.trainerEvent) : undefined
    let reservation: NativeTrainerProtocolReservationState | undefined
    if (input.reservation) reservation = verifyTrainerProtocolReservation(input.reservation, metadata.runId)
    const targetPlan = input.targetPlan ? nativeCampaignTargetPlanState(input.targetPlan) : undefined
    const target = input.target ? nativeCampaignTargetResponseState(input.target) : undefined
    if (metadata.stage === "fixture-preflight" && (event || reservation || targetPlan || target)) fail("binding-invalid")
    if (metadata.scheduleEntry?.kind === "trainerSelection" && !event) fail("binding-invalid")
    if (event) verifyTrainerEventForScheduleEntry(event, metadata)
    if (metadata.stage === "target-static") {
      if (reservation || target || !targetPlan || !targetPlanMatchesMetadata(targetPlan, metadata) ||
          targetPlan.event !== event || (targetPlan.event && targetPlan.event.targetPlan !== targetPlan)) fail("binding-invalid")
      return { targetPlan, ...(event ? { event, protocolEvidence: { event: event.event, requireUnassociated: true } } : {}) }
    }
    if (metadata.stage === "adapter-response" || metadata.stage === "trainer-rollout-ipc") {
      if (!reservation || !target || targetPlan) fail("dispatch-not-authorized")
      const plan = target.binding.plan
      if (!targetPlanMatchesMetadata(plan, metadata) || target.binding.reservation !== input.reservation ||
          target.binding.reservationState !== reservation || target.responseSha256 !== metadata.responseSha256 ||
          target.binding.plan.event !== event && target.associatedEvent !== event) fail("dispatch-not-authorized")
      if (plan.event && event !== plan.event) fail("dispatch-not-authorized")
      if (target.associatedEvent && event !== target.associatedEvent && metadata.stage === "trainer-rollout-ipc") {
        fail("dispatch-not-authorized")
      }
      if (event && ((reservation.event !== event && event.associatedWarmupReservation !== reservation) ||
          event.reservationRequestId !== reservation.requestId)) fail("dispatch-not-authorized")
      if (metadata.stage === "trainer-rollout-ipc" && (!event || event.request.kind !== "rollout" ||
          (reservation.event !== event && event.associatedWarmupReservation !== reservation))) fail("binding-invalid")
      const expectedPhase = metadata.scheduleEntry?.kind === "qualification"
        ? metadata.scheduleEntry.split
        : metadata.scheduleEntry?.kind === "training" ? "train" : metadata.scheduleEntry?.kind === "trainerSelection" ? "dev" : undefined
      if (reservation.role !== "target" || (expectedPhase && reservation.phase !== expectedPhase)) fail("dispatch-not-authorized")
      const associated = !!event && (reservation.event === event || event.associatedWarmupReservation === reservation)
      return {
        ...(event ? { event } : {}), reservation, target,
        protocolEvidence: { ...(event ? { event: event.event,
          ...(associated ? { requireAssociation: true } : { requireUnassociated: true }) } : {}),
          reservation: { requestId: reservation.requestId, reservationId: reservation.reservationId,
            role: reservation.role, phase: reservation.phase } },
      }
    }
    if (event || reservation || targetPlan || target) fail("binding-invalid")
    return {}
  }

  function reserveTrainerProtocolRequest(
    input: Readonly<{ owner: SessionStore; runtime: ExecutionRuntime; prepared: SkillOptPrepared; current: SkillOptCurrentBinding }>,
    eventState: NativeTrainerProtocolEventState,
    selectionOnly: boolean,
  ): SkillOptReservation {
    const capture = eventState.capture
    if (eventState.controllerIdentity !== controllerIdentity || eventState.reservationAttempted || capture.completed ||
        capture.stopped || eventState.request.runId !== capture.preparedState.runId) {
      fail("dispatch-not-authorized")
    }
    const selection = eventState.request.kind === "rollout" &&
      (eventState.request.cohort === "baseline-selection" || eventState.request.cohort === "candidate-selection")
    if (selectionOnly !== selection || (eventState.request.kind === "rollout" && !selection && eventState.request.cohort !== "training") ||
        (eventState.request.kind === "optimizer" && selectionOnly)) fail("dispatch-not-authorized")
    eventState.reservationAttempted = true
    try {
      const context = nativeTrainerProtocolCaptureContext(input, capture)
      let role: SkillOptRequestRole
      let phase: SkillOptRequestPhase
      if (eventState.request.kind === "optimizer") {
        role = "optimizer"
        phase = "train"
      } else {
        const request = eventState.request
        if (!scheduleEntryBindsFixture({ kind: selection ? "trainerSelection" : "training",
          caseId: request.caseId, replicate: request.replicate }, request.caseId, capture.schedule)) fail("binding-invalid")
        role = "target"
        phase = selection ? "dev" : "train"
      }
      const consent = consentByRun.get(capture.preparedState.runId)
      if (!consent || consent.owner !== input.owner ||
          consent.campaign.scheduleSha256 !== capture.schedule.scheduleSha256) fail("consent-required")
      assertConsentLive(consent, clock())
      const beforeCommitOwner = ownerProof(runtime, root, input.owner)
      if (!isDeepStrictEqual(beforeCommitOwner, context.proof)) fail("owner-unavailable")
      assertRuntimeIdle(runtime, input.owner)
      const commitBinding = currentBindings(input.current)
      if (!isDeepStrictEqual(commitBinding.hashes, context.binding.hashes) ||
          commitBinding.campaign.scheduleSha256 !== capture.schedule.scheduleSha256) fail("consent-binding-drift")
      const commitClock = clock()
      assertConsentLive(consent, commitClock)
      const stored = ledger.reserveRequest({ runId: capture.preparedState.runId, consentId: consent.consentId,
        ownerSessionHash: context.proof.sessionHash, ownerEpochHash: context.proof.epochHash,
        admissionHash: context.proof.admissionHash, bindingHash: commitBinding.hashes.bindingSha256,
        role, phase, clock: commitClock, protocolEvent: eventState.event })
      const pair = mintDispatch(stored.reservationId, stored.requestId, capture.preparedState.runId, role, phase,
        commitBinding.hashes.bindingSha256, context.proof, ticketStates, receiptStates, input.owner, consent, commitClock)
      eventState.reservationRequestId = stored.requestId
      const reservation = Object.freeze({ runId: capture.preparedState.runId, reservationId: stored.reservationId,
        requestId: stored.requestId, bindingSha256: commitBinding.hashes.bindingSha256,
        scheduleSha256: capture.schedule.scheduleSha256, role, phase, charged: true as const,
        ticket: pair.ticket, receipt: pair.receipt })
      nativeTrainerProtocolReservations.set(reservation as object, { controllerIdentity, event: eventState,
        runId: capture.preparedState.runId, requestId: stored.requestId, reservationId: stored.reservationId, role, phase })
      return reservation
    } catch {
      capture.stopped = true
      try { ledger.markTrainerProtocolRecoveryUnresolved({ runId: capture.preparedState.runId,
        owner: capture.ownerProof, requirePersistedEvents: true }) } catch { /* retain the primary fail-closed outcome */ }
      fail("recovery-unresolved")
    }
  }

  function bindingsAfterPromotion(current: SkillOptCurrentBinding, run: Record<string, unknown>): {
    dataset: NativeDataset; hashes: ReturnType<typeof skillOptBindingHashes>; campaign: CampaignDisclosure
  } {
    if (!current || typeof current !== "object" || current.baselineSkillSha256 !== run.baseline_hash || !asHash(current.baselineSkillSha256)) {
      fail("binding-baseline-drift")
    }
    let dataset: NativeDataset
    try { dataset = validateNativeDataset(root, current.dataset) } catch { fail("binding-invalid") }
    if (dataset.status !== "STRUCTURALLY_VALID" || dataset.protocolSha256 !== NATIVE_PROTOCOL_SHA256) fail("binding-data-drift")
    let hashes: ReturnType<typeof skillOptBindingHashes>
    try { hashes = skillOptBindingHashes(root, dataset, current.baselineSkillSha256) } catch { fail("binding-invalid") }
    if (hashes.bindingSha256 !== run.binding_hash || hashes.datasetSha256 !== run.dataset_hash ||
        hashes.dataSha256 !== run.data_hash || hashes.modelBindingsSha256 !== run.model_hash ||
        hashes.protocolSha256 !== run.protocol_hash || hashes.baselineSkillSha256 !== run.baseline_hash) fail("consent-binding-drift")
    if (Buffer.byteLength(canonicalJson(dataset.fixturePack), "utf8") > NATIVE_SKILLOPT_LIMITS.fixtureBytes) fail("data-required")
    return { dataset, hashes, campaign: campaignDisclosure(dataset) }
  }

  function ownerCurrent(state: { owner: SessionStore; ownerSessionHash: string; ownerEpochHash: string; admissionHash: string }, allowHeld = false) {
    const proof = ownerProof(runtime, root, state.owner, allowHeld)
    if (proof.sessionHash !== state.ownerSessionHash || proof.epochHash !== state.ownerEpochHash || proof.admissionHash !== state.admissionHash) fail("owner-unavailable")
    return proof
  }

  function checkedNativeRollbackEligibility(input: Readonly<{
    owner: SessionStore; runtime: ExecutionRuntime; runId: string; current: SkillOptCurrentBinding
    mutationClaim?: ExecutionClaim
  }>): Readonly<{
    ownerStatus: OwnerProof
    now: ClockValues
    run: StoredRunRow
    binding: ReturnType<typeof bindingsAfterPromotion>
    qualification: NativeCampaignQualificationBinding
    consent: NonNullable<ReturnType<typeof ledger.readConsent>>
    consentState: ConsentState
  }> {
    if (input.runtime !== runtime) fail("canary-runtime-mismatch")
    if (!UUID.test(input.runId)) fail("run-stale")
    if (input.mutationClaim !== undefined) assertMutationClaim(runtime, input.owner, input.mutationClaim)
    else assertRuntimeIdle(runtime, input.owner)
    const ownerStatus = ownerProof(runtime, root, input.owner)
    if (rollbackIntentsByRun.has(input.runId) || rollbackCanaryPreparationsByRun.has(input.runId)) {
      fail("rollback-intent-invalid")
    }
    const now = clock()
    const persisted = ledger.readStatus(now)
    if (persisted.status.reasonCode === "clock-uncertain") fail("clock-uncertain")
    if (persisted.activeRunId && persisted.activeRunId !== input.runId) fail("active-run")
    if (persisted.status.pendingDispatch) fail("dispatch-pending")
    const snapshot = ledger.readRunForReentry(input.runId)
    const statusRun = persisted.run
    if (!snapshot || !statusRun || statusRun.run_id !== input.runId || snapshot.run.run_id !== input.runId) fail("run-stale")
    if (snapshot.run.revision !== statusRun.revision || snapshot.run.state !== statusRun.state ||
        snapshot.run.binding_hash !== statusRun.binding_hash || snapshot.run.owner_session_hash !== statusRun.owner_session_hash ||
        snapshot.run.owner_epoch_hash !== statusRun.owner_epoch_hash || snapshot.run.admission_hash !== statusRun.admission_hash) {
      fail("revision-conflict")
    }
    const run = snapshot.run
    if (typeof run.revision !== "number" || !Number.isSafeInteger(run.revision) ||
        typeof run.binding_hash !== "string" || !asHash(run.binding_hash) ||
        typeof run.dataset_hash !== "string" || !asHash(run.dataset_hash) ||
        typeof run.data_hash !== "string" || !asHash(run.data_hash) ||
        typeof run.model_hash !== "string" || !asHash(run.model_hash) ||
        typeof run.protocol_hash !== "string" || !asHash(run.protocol_hash) ||
        typeof run.baseline_hash !== "string" || !asHash(run.baseline_hash) ||
        typeof run.owner_session_hash !== "string" || !asHash(run.owner_session_hash) ||
        typeof run.owner_epoch_hash !== "string" || !asHash(run.owner_epoch_hash) ||
        typeof run.admission_hash !== "string" || !asHash(run.admission_hash) ||
        typeof run.expires_boot !== "string" || typeof run.expires_cont !== "string" || !DECIMAL.test(run.expires_cont) ||
        typeof run.expires_wall !== "string" || !DECIMAL.test(run.expires_wall)) fail("storage-corrupt")
    if (ownerStatus.sessionHash !== run.owner_session_hash || ownerStatus.epochHash !== run.owner_epoch_hash ||
        ownerStatus.admissionHash !== run.admission_hash) fail("owner-unavailable")
    if (run.expires_boot !== now.boot || BigInt(run.expires_cont) < now.continuous || BigInt(run.expires_wall) < now.wall) {
      fail("run-expired")
    }
    if (run.state !== "COMPLETED" && run.state !== "AWAITING_CANDIDATE_APPROVAL") {
      if (run.state === "RESERVED" || run.state === "DISPATCH_PENDING" || run.state === "UNRESOLVED" || persisted.status.pendingDispatch) {
        fail("dispatch-pending")
      }
      if (run.state === "AWAITING_ROLLBACK_CANARY" || run.state === "ROLLED_BACK") fail("rollback-intent-invalid")
      fail("run-stale")
    }
    if (snapshot.quota.pending_request_id !== null) fail("dispatch-pending")
    if (snapshot.quota.clock_uncertain === 1) fail("clock-uncertain")
    if (run.state === "COMPLETED") {
      if (snapshot.quota.active_run_id !== null || snapshot.quota.active_owner_session_hash !== null ||
          snapshot.quota.active_owner_epoch_hash !== null) fail("active-run")
    } else if (snapshot.quota.active_run_id !== input.runId ||
        snapshot.quota.active_owner_session_hash !== ownerStatus.sessionHash ||
        snapshot.quota.active_owner_epoch_hash !== ownerStatus.epochHash) fail("active-run")
    if (input.mutationClaim !== undefined) assertMutationClaim(runtime, input.owner, input.mutationClaim)
    else assertRuntimeIdle(runtime, input.owner)
    const binding = bindingsAfterPromotion(input.current, run)
    const qualification = ledger.readCampaignQualification(input.runId)
    if (!qualification || qualification.runId !== input.runId ||
        qualification.bindingSha256 !== binding.hashes.bindingSha256 ||
        qualification.scheduleSha256 !== binding.campaign.scheduleSha256 ||
        ![qualification.bindingSha256, qualification.scheduleSha256, qualification.candidateSha256,
          qualification.resultsSha256, qualification.reviewSha256].every(asHash)) fail("qualification-required")
    let liveCandidate: Buffer
    try { liveCandidate = readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes) }
    catch { fail("binding-baseline-drift") }
    if (sha256(liveCandidate) !== qualification.candidateSha256) fail("consent-binding-drift")
    const consent = ledger.readConsent(input.runId)
    const consentState = consentByRun.get(input.runId)
    if (!consent || consent.state !== "valid" || !consentState || consentState.owner !== input.owner ||
        consentState.runId !== input.runId || consent.consentId !== consentState.consentId ||
        consent.subjectHash !== consentState.subjectHash || consent.scheduleSha256 !== qualification.scheduleSha256 ||
        consent.bindingHash !== qualification.bindingSha256 || consent.ownerSessionHash !== ownerStatus.sessionHash ||
        consent.ownerEpochHash !== ownerStatus.epochHash || consent.admissionHash !== ownerStatus.admissionHash ||
        consent.expiresBoot !== now.boot || consent.expiresBoot !== consentState.expiresBoot ||
        consent.expiresCont !== consentState.expiresCont.toString() || consent.expiresWall !== consentState.expiresWall.toString()) {
      fail("consent-binding-drift")
    }
    assertConsentLive(consentState, now)
    if (input.mutationClaim !== undefined) assertMutationClaim(runtime, input.owner, input.mutationClaim)
    else assertRuntimeIdle(runtime, input.owner)
    const usage = snapshot.usage
    if (![usage.target_requests, usage.canary_requests, usage.active_ms, usage.active_reserved_ms]
      .every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) fail("storage-corrupt")
    const remainingCanaries = consentState.campaign.canaryReserve - (usage.canary_requests as number)
    if ((usage.target_requests as number) >= TARGET_REQUEST_CAP ||
        (usage.canary_requests as number) >= CANARY_RESERVE || !Number.isSafeInteger(remainingCanaries) || remainingCanaries < 1 ||
        (usage.active_ms as number) + (usage.active_reserved_ms as number) + NATIVE_SKILLOPT_LIMITS.requestMilliseconds >
          NATIVE_SKILLOPT_LIMITS.activeMilliseconds) {
      fail("budget-exhausted")
    }
    if (input.mutationClaim !== undefined) assertMutationClaim(runtime, input.owner, input.mutationClaim)
    else assertRuntimeIdle(runtime, input.owner)
    if (rollbackIntentsByRun.has(input.runId) || rollbackCanaryPreparationsByRun.has(input.runId)) fail("rollback-intent-invalid")
    const ownerAfter = ownerProof(runtime, root, input.owner)
    if (ownerAfter.sessionHash !== ownerStatus.sessionHash || ownerAfter.epochHash !== ownerStatus.epochHash ||
        ownerAfter.admissionHash !== ownerStatus.admissionHash) fail("owner-unavailable")
    if (input.mutationClaim !== undefined) assertMutationClaim(runtime, input.owner, input.mutationClaim)
    else assertRuntimeIdle(runtime, input.owner)
    return Object.freeze({ ownerStatus, now, run, binding, qualification, consent, consentState })
  }

  function checkedQualifiedPublication(input: Readonly<{
    owner: SessionStore; runId: string; current: SkillOptCurrentBinding; candidateSha256: string
    resultsSha256: string; reviewSha256: string; mutationClaim?: ExecutionClaim
  }>) {
    if (!input || !UUID.test(input.runId) || !asHash(input.candidateSha256) ||
        !asHash(input.resultsSha256) || !asHash(input.reviewSha256)) fail("qualification-required")
    const assertIdle = (): void => input.mutationClaim !== undefined
      ? assertMutationClaim(runtime, input.owner, input.mutationClaim)
      : assertRuntimeIdle(runtime, input.owner)
    const ownerStatus = ownerProof(runtime, root, input.owner)
    assertIdle()
    const now = clock()
    const persisted = ledger.readStatus(now)
    const snapshot = ledger.readRunForReentry(input.runId)
    if (!snapshot) fail("run-stale")
    const run = snapshot.run
    if (!run || !persisted.run || persisted.activeRunId !== input.runId || run.run_id !== input.runId ||
        persisted.run.run_id !== input.runId || run.revision !== persisted.run.revision || run.state !== persisted.run.state ||
        run.state !== "AWAITING_CANDIDATE_APPROVAL" || persisted.status.pendingDispatch) fail("qualification-required")
    if (snapshot.quota.clock_uncertain === 1) fail("clock-uncertain")
    if (snapshot.quota.pending_request_id !== null || snapshot.quota.active_run_id !== input.runId ||
        snapshot.quota.active_owner_session_hash !== ownerStatus.sessionHash ||
        snapshot.quota.active_owner_epoch_hash !== ownerStatus.epochHash) fail("active-run")
    if (!asHash(run.binding_hash) || !asHash(run.owner_session_hash) || !asHash(run.owner_epoch_hash) ||
        !asHash(run.admission_hash) || !asHash(run.baseline_hash) || typeof run.expires_boot !== "string" ||
        !DECIMAL.test(run.expires_cont) || !DECIMAL.test(run.expires_wall)) fail("storage-corrupt")
    if (run.owner_session_hash !== ownerStatus.sessionHash || run.owner_epoch_hash !== ownerStatus.epochHash ||
        run.admission_hash !== ownerStatus.admissionHash) fail("owner-unavailable")
    if (run.expires_boot !== now.boot || BigInt(run.expires_cont) < now.continuous || BigInt(run.expires_wall) < now.wall) {
      fail("run-expired")
    }
    const binding = bindingsAfterPromotion(input.current, run)
    const qualification = ledger.readCampaignQualification(input.runId)
    if (!qualification || qualification.runId !== input.runId || qualification.bindingSha256 !== binding.hashes.bindingSha256 ||
        qualification.scheduleSha256 !== binding.campaign.scheduleSha256 || qualification.candidateSha256 !== input.candidateSha256 ||
        qualification.resultsSha256 !== input.resultsSha256 || qualification.reviewSha256 !== input.reviewSha256 ||
        input.current.baselineSkillSha256 !== run.baseline_hash ||
        ![qualification.bindingSha256, qualification.scheduleSha256, qualification.candidateSha256,
          qualification.resultsSha256, qualification.reviewSha256, run.baseline_hash].every(asHash)) fail("qualification-required")
    assertIdle()
    const consentRow = snapshot.consent
    const consent = ledger.readConsent(input.runId)
    const consentState = consentByRun.get(input.runId)
    if (!consentRow || !consent || consent.state !== "valid" || !consentState || consentState.owner !== input.owner ||
        consentState.runId !== input.runId || consent.consentId !== consentState.consentId ||
        consent.subjectHash !== consentState.subjectHash || consent.scheduleSha256 !== qualification.scheduleSha256 ||
        consent.bindingHash !== qualification.bindingSha256 || consent.ownerSessionHash !== ownerStatus.sessionHash ||
        consent.ownerEpochHash !== ownerStatus.epochHash || consent.admissionHash !== ownerStatus.admissionHash ||
        consent.expiresBoot !== now.boot || consent.expiresBoot !== consentState.expiresBoot ||
        consent.expiresCont !== consentState.expiresCont.toString() || consent.expiresWall !== consentState.expiresWall.toString() ||
        consentRow.run_id !== input.runId || consentRow.consent_id !== consent.consentId ||
        consentRow.subject_hash !== consent.subjectHash || consentRow.schedule_hash !== consent.scheduleSha256 ||
        consentRow.binding_hash !== consent.bindingHash || consentRow.owner_session_hash !== consent.ownerSessionHash ||
        consentRow.owner_epoch_hash !== consent.ownerEpochHash || consentRow.admission_hash !== consent.admissionHash ||
        consentRow.expires_boot !== consent.expiresBoot || consentRow.expires_cont !== consent.expiresCont ||
        consentRow.expires_wall !== consent.expiresWall || consentState.expiresBoot !== now.boot ||
        now.continuous > consentState.expiresCont || now.wall > consentState.expiresWall) fail("consent-expired")
    assertConsentLive(consentState, now)
    assertIdle()
    const usage = snapshot.usage
    if (![usage.target_requests, usage.canary_requests, usage.active_ms, usage.active_reserved_ms]
      .every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) fail("storage-corrupt")
    const chargedCanaryRequests = persisted.status.targetPhaseCounts.canary.charged
    const remainingCanaryRequests = consentState.campaign.canaryReserve - chargedCanaryRequests
    if (!Number.isSafeInteger(chargedCanaryRequests) || chargedCanaryRequests < 0 ||
        !Number.isSafeInteger(remainingCanaryRequests) || remainingCanaryRequests < 1 ||
        persisted.status.remaining.target < 1 || (usage.target_requests as number) >= TARGET_REQUEST_CAP ||
        (usage.canary_requests as number) >= CANARY_RESERVE ||
        (usage.active_ms as number) + (usage.active_reserved_ms as number) + NATIVE_SKILLOPT_LIMITS.requestMilliseconds >
          NATIVE_SKILLOPT_LIMITS.activeMilliseconds) fail("budget-exhausted")
    const expiresWallMilliseconds = String(run.expires_wall)
    const runDeadlineAt = Number(expiresWallMilliseconds)
    if (!Number.isSafeInteger(runDeadlineAt) || runDeadlineAt <= Number(now.wall)) fail("run-expired")
    const ownerAfter = ownerProof(runtime, root, input.owner)
    if (ownerAfter.sessionHash !== ownerStatus.sessionHash || ownerAfter.epochHash !== ownerStatus.epochHash ||
        ownerAfter.admissionHash !== ownerStatus.admissionHash) fail("owner-unavailable")
    assertIdle()
    const latestBinding = bindingsAfterPromotion(input.current, run)
    if (!isDeepStrictEqual(latestBinding.hashes, binding.hashes) || !isDeepStrictEqual(latestBinding.campaign, binding.campaign)) {
      fail("consent-binding-drift")
    }
    return Object.freeze({ ownerStatus, now, run, binding, qualification, consentState,
      publication: Object.freeze({
        runId: input.runId, bindingSha256: qualification.bindingSha256, scheduleSha256: qualification.scheduleSha256,
        baselineSkillSha256: run.baseline_hash, candidateSha256: qualification.candidateSha256,
        resultsSha256: qualification.resultsSha256, reviewSha256: qualification.reviewSha256,
        ownerSessionHash: ownerStatus.sessionHash, ownerEpochHash: ownerStatus.epochHash,
        admissionHash: ownerStatus.admissionHash, expiresBoot: now.boot,
        expiresContinuousNanoseconds: consent.expiresCont, expiresWallMilliseconds, remainingCanaryRequests,
      }), consent: consentRow })
  }

  function verifyReentryOwner(state: ReentryState, claim?: ExecutionClaim): OwnerProof {
    const proof = ownerProof(runtime, root, state.owner)
    if (proof.sessionHash !== state.ownerProof.sessionHash || proof.epochHash !== state.ownerProof.epochHash ||
        proof.admissionHash !== state.ownerProof.admissionHash ||
        !isAdmissionLeaseCurrent(root, state.owner.sessionID, state.lease) ||
        sha256(admissionFence(root, state.owner.sessionID)) !== state.admissionFenceHash) fail("owner-unavailable")
    assertRuntimeIdle(runtime, state.owner, claim)
    return proof
  }

  function inspectPreviousOwner(snapshot: StoredReentrySnapshot, owner: SessionStore): SessionAttachmentInspection {
    const run = snapshot.run
    const sessionID = run.owner_session_id
    const epoch = run.owner_epoch
    if (typeof sessionID !== "string" || !SESSION_ID.test(sessionID) || typeof epoch !== "string" ||
        !UUID.test(epoch)) fail("owner-unavailable")
    const inspection = inspectSessionAttachment(root, sessionID, epoch)
    if (!inspection || inspection.sessionID !== sessionID || inspection.epoch !== epoch || inspection.worktree !== root) fail("owner-unavailable")
    if (inspection.state === "released") return inspection
    if (inspection.identity === "dead") return inspection
    const isSameLiveOwner = inspection.identity === "live" && owner.sessionID === sessionID && owner.epoch === epoch &&
      getOwnedSession(root, sessionID) === owner
    if (!isSameLiveOwner) fail("owner-unavailable")
    return inspection
  }

  function validateReentrySnapshot(snapshot: StoredReentrySnapshot, now: ClockValues): {
    state: "PREPARED" | "CONSENTED" | "ARMED"; campaignId: string; sessionID: string; epoch: string
    consent?: StoredConsentRow; arm?: StoredArmRow
  } {
    const run = snapshot.run
    const state = run.state
    if (state !== "PREPARED" && state !== "CONSENTED" && state !== "ARMED") fail("revision-conflict")
    if (snapshot.attemptCount !== 0 || snapshot.requestCount !== 0) fail("run-stale")
    if (snapshot.quota.pending_request_id) fail("dispatch-pending")
    if (snapshot.quota.active_run_id) fail("active-run")
    if (snapshot.quota.clock_uncertain === 1) fail("clock-uncertain")
    if (!Number.isSafeInteger(snapshot.quota.revision) || snapshot.quota.revision < 0 || snapshot.quota.clock_uncertain !== 0 ||
        snapshot.quota.clock_boot !== now.boot || boundedClockDecimal(snapshot.quota.clock_cont) === undefined ||
        boundedClockDecimal(snapshot.quota.clock_wall) === undefined) fail("storage-corrupt")
    if (snapshot.quota.last_attempt_id === null) {
      if (snapshot.quota.last_attempt_boot !== null || snapshot.quota.last_attempt_cont !== null) fail("storage-corrupt")
    } else if (!UUID.test(snapshot.quota.last_attempt_id) || typeof snapshot.quota.last_attempt_boot !== "string" ||
        !UUID.test(snapshot.quota.last_attempt_boot) || boundedClockDecimal(snapshot.quota.last_attempt_cont) === undefined) fail("storage-corrupt")
    if (snapshot.quota.fence_boot === null) {
      if (snapshot.quota.fence_cont !== null) fail("storage-corrupt")
    } else if (typeof snapshot.quota.fence_boot !== "string" || !UUID.test(snapshot.quota.fence_boot) ||
        boundedClockDecimal(snapshot.quota.fence_cont) === undefined) fail("storage-corrupt")
    const sessionID = run.owner_session_id
    const epoch = run.owner_epoch
    const campaignId = run.campaign_id
    if (typeof sessionID !== "string" || !SESSION_ID.test(sessionID) || typeof epoch !== "string" ||
        !UUID.test(epoch) ||
        typeof campaignId !== "string" || !CAMPAIGN_ID.test(campaignId) ||
        run.campaign_hash !== sha256(campaignId) || run.owner_session_hash !== sha256(sessionID) || run.owner_epoch_hash !== sha256(epoch) ||
        !asHash(run.admission_hash) || !asHash(run.binding_hash) || run.reason_code !== null || !Number.isSafeInteger(run.revision) ||
        !Number.isSafeInteger(run.fixture_bytes) || run.fixture_bytes < 0 || run.fixture_bytes > NATIVE_SKILLOPT_LIMITS.fixtureBytes ||
        !Number.isSafeInteger(run.active_ms) || run.active_ms !== 0 || !Number.isSafeInteger(run.candidate_steps) || run.candidate_steps !== 0 ||
        !Number.isSafeInteger(run.artifact_bytes) || run.artifact_bytes < 0 || run.artifact_bytes > NATIVE_SKILLOPT_LIMITS.artifactBytes ||
        boundedClockDecimal(run.expires_cont) === undefined || boundedClockDecimal(run.expires_wall) === undefined ||
        boundedClockDecimal(run.created_cont) === undefined || boundedClockDecimal(run.created_wall) === undefined ||
        run.created_boot !== now.boot || run.expires_boot !== now.boot || BigInt(run.created_cont) > now.continuous ||
        BigInt(run.created_wall) > now.wall || BigInt(run.expires_cont) < now.continuous ||
        BigInt(run.expires_wall) < now.wall || !Number.isSafeInteger(snapshot.usage.target_requests) || snapshot.usage.target_requests !== 0 ||
        !Number.isSafeInteger(snapshot.usage.optimizer_requests) || snapshot.usage.optimizer_requests !== 0 ||
        !Number.isSafeInteger(snapshot.usage.reviewer_requests) || snapshot.usage.reviewer_requests !== 0 ||
        !Number.isSafeInteger(snapshot.usage.final_safety_requests) || snapshot.usage.final_safety_requests !== 0 ||
        !Number.isSafeInteger(snapshot.usage.canary_requests) || snapshot.usage.canary_requests !== 0 ||
        !Number.isSafeInteger(snapshot.usage.active_ms) || snapshot.usage.active_ms !== 0 ||
        !Number.isSafeInteger(snapshot.usage.active_reserved_ms) || snapshot.usage.active_reserved_ms !== 0 ||
        !Number.isSafeInteger(snapshot.usage.artifact_bytes) || snapshot.usage.artifact_bytes !== run.artifact_bytes ||
        snapshot.usage.artifact_bytes > NATIVE_SKILLOPT_LIMITS.artifactBytes ||
        !Number.isSafeInteger(snapshot.usage.candidate_steps) || snapshot.usage.candidate_steps !== 0 ||
        snapshot.usage.fixture_bytes !== run.fixture_bytes) {
      fail("owner-unavailable")
    }
    const consent = snapshot.consent
    const arm = snapshot.arm
    if (state === "PREPARED") {
      if (consent || arm) fail("revision-conflict")
    } else {
      if (!consent || consent.state !== "valid" || typeof consent.consent_id !== "string" || !UUID.test(consent.consent_id) ||
          !asHash(consent.subject_hash) || !asHash(consent.schedule_hash) || consent.binding_hash !== run.binding_hash ||
          consent.owner_session_hash !== run.owner_session_hash || consent.owner_epoch_hash !== run.owner_epoch_hash ||
          consent.admission_hash !== run.admission_hash || consent.created_boot !== now.boot || consent.expires_boot !== now.boot ||
          boundedClockDecimal(consent.created_cont) === undefined || boundedClockDecimal(consent.created_wall) === undefined ||
          BigInt(consent.created_cont) > now.continuous || BigInt(consent.created_wall) > now.wall ||
          boundedClockDecimal(consent.expires_cont) === undefined || boundedClockDecimal(consent.expires_wall) === undefined ||
          BigInt(consent.expires_cont) < now.continuous || BigInt(consent.expires_wall) < now.wall ||
          BigInt(consent.expires_cont) > BigInt(run.expires_cont) ||
          BigInt(consent.expires_wall) > BigInt(run.expires_wall)) fail("consent-expired")
      if (state === "CONSENTED") {
        if (arm) fail("revision-conflict")
      } else {
        if (!arm || arm.state !== "armed" || arm.consent_id !== consent.consent_id ||
            arm.reservation_id !== null ||
            typeof arm.arm_id !== "string" || !UUID.test(arm.arm_id) || !asHash(arm.watermark_hash) ||
            typeof arm.seen_digest_hashes !== "string" || arm.armed_boot !== now.boot ||
            boundedClockDecimal(arm.armed_cont) === undefined || boundedClockDecimal(arm.armed_wall) === undefined ||
            BigInt(arm.armed_cont) > now.continuous || BigInt(arm.armed_wall) > now.wall ||
            arm.expires_boot !== consent.expires_boot || arm.expires_cont !== consent.expires_cont || arm.expires_wall !== consent.expires_wall ||
            arm.expires_boot !== now.boot || BigInt(arm.expires_cont) < now.continuous || BigInt(arm.expires_wall) < now.wall) fail("arm-expired")
        parseSeenDigestHashes(arm.seen_digest_hashes)
      }
    }
    return { state, campaignId, sessionID, epoch, ...(consent ? { consent } : {}), ...(arm ? { arm } : {}) }
  }

  function assertConsentLive(state: ConsentState, now: ClockValues): void {
    if (state.expiresBoot !== now.boot || now.continuous > state.expiresCont || now.wall > state.expiresWall) fail("consent-expired")
  }

  function automaticEligibility(input: Readonly<{
    owner: SessionStore; prepared: SkillOptPrepared; consent: SkillOptConsent; arm: SkillOptArm; current: SkillOptCurrentBinding
  }>): SkillOptAutomaticReadiness {
    let newDigestCount = 0
    let dailyCooldownRemainingMilliseconds = 0
    let finalReservationRequired = false
    try {
    const preparedState = input.prepared && typeof input.prepared === "object" ? preparedStates.get(input.prepared as object) : undefined
    const consentState = input.consent && typeof input.consent === "object" ? consentStates.get(input.consent as object) : undefined
    const armState = input.arm && typeof input.arm === "object" ? armStates.get(input.arm as object) : undefined
    if (!preparedState || !consentState || !armState || preparedState.runId !== consentState.runId ||
        preparedState.runId !== armState.runId || input.prepared.runId !== input.consent.runId ||
        input.prepared.runId !== input.arm.runId || armState.used || preparedState.initialStartConsumed ||
        armState.owner !== input.owner || consentState.owner !== input.owner || preparedState.owner !== input.owner ||
        armState.consentId !== consentState.consentId || armState.bindingHash !== consentState.bindingHash ||
        !isDeepStrictEqual(preparedState.campaign, consentState.campaign) ||
        !campaignPreviewMatches(input.prepared, preparedState.campaign) || !campaignPreviewMatches(input.consent, consentState.campaign)) {
      fail("arm-required")
    }
    const owner = ownerCurrent(armState)
    if (owner.sessionHash !== armState.ownerSessionHash || owner.epochHash !== armState.ownerEpochHash ||
        owner.admissionHash !== armState.admissionHash || owner.sessionHash !== consentState.ownerSessionHash ||
        owner.epochHash !== consentState.ownerEpochHash || owner.admissionHash !== consentState.admissionHash) fail("owner-unavailable")
    assertRuntimeIdle(runtime, input.owner)
    requireFreshBinding(preparedState, input.current)
    const now = clock()
    assertConsentLive(consentState, now)
    if (now.boot !== armState.expiresBoot || now.continuous > armState.expiresCont || now.wall > armState.expiresWall) fail("arm-expired")
    const persisted = ledger.readStatus(now)
    if (persisted.status.reasonCode === "clock-uncertain") fail("clock-uncertain")
    if (persisted.status.runId !== armState.runId || persisted.status.state !== "ARMED") fail("arm-required")
    const latest = eligibleSkillOptDigests(readSessionDigests(root))
    const fresh = newDigestsSinceArm(latest, armState.seenDigestHashes, armState.armedAtWall)
    newDigestCount = fresh.length
    dailyCooldownRemainingMilliseconds = persisted.status.dailyCooldownRemainingMilliseconds
    if (fresh.length < MIN_NEW_DIGESTS) fail("digest-threshold")
    const beforeCommitOwner = ownerCurrent(armState)
    if (beforeCommitOwner.sessionHash !== owner.sessionHash || beforeCommitOwner.epochHash !== owner.epochHash ||
        beforeCommitOwner.admissionHash !== owner.admissionHash) fail("owner-unavailable")
    assertRuntimeIdle(runtime, input.owner)
    requireFreshBinding(preparedState, input.current)
    const commitClock = clock()
    assertConsentLive(consentState, commitClock)
    if (commitClock.boot !== armState.expiresBoot || commitClock.continuous > armState.expiresCont ||
        commitClock.wall > armState.expiresWall) fail("arm-expired")
    if (dailyCooldownRemainingMilliseconds > 0) {
      if (!persisted.cooldownFenceRequired || commitClock.boot !== now.boot) fail("daily-limit")
      finalReservationRequired = true
    }
    return Object.freeze({ state: "READY", newDigestCount, requiredNewDigests: MIN_NEW_DIGESTS,
      dailyCooldownRemainingMilliseconds, ...(finalReservationRequired ? { finalReservationRequired: true as const } : {}) })
    } catch (error) {
      const reasonCode = error instanceof SkillOptControllerError ? error.code : "owner-unavailable"
      return Object.freeze({ state: "BLOCKED", reasonCode, newDigestCount, requiredNewDigests: MIN_NEW_DIGESTS,
        dailyCooldownRemainingMilliseconds })
    }
  }

  function nativeTrainerProtocolCaptureLive(runId: string): boolean {
    const capture = nativeTrainerProtocolCapturesByRun.get(runId)
    return !!capture && capture.controllerIdentity === controllerIdentity && !capture.stopped
  }

  function restoreConsentForRun(run: Record<string, unknown>, owner: SessionStore, proof: ReturnType<typeof ownerProof>): void {
    if (ledger.nativeTrainerProtocolEventCount(String(run.run_id)) > 0 &&
        !nativeTrainerProtocolCaptureLive(String(run.run_id))) fail("recovery-unresolved")
    const saved = ledger.readConsent(String(run.run_id))
    if (!saved || saved.state !== "valid") fail("consent-required")
    if (saved.bindingHash !== run.binding_hash) fail("consent-binding-drift")
    if (saved.ownerSessionHash !== proof.sessionHash || saved.ownerEpochHash !== proof.epochHash || saved.admissionHash !== proof.admissionHash ||
        saved.ownerSessionHash !== run.owner_session_hash || saved.ownerEpochHash !== run.owner_epoch_hash || saved.admissionHash !== run.admission_hash) {
      fail("owner-unavailable")
    }
    const now = clock()
    if (saved.expiresBoot !== now.boot || BigInt(saved.expiresCont) < now.continuous || BigInt(saved.expiresWall) < now.wall) fail("consent-expired")
    consentByRun.set(String(run.run_id), {
      runId: String(run.run_id), consentId: saved.consentId, subjectHash: saved.subjectHash, bindingHash: saved.bindingHash,
      campaign: campaignDisclosureForHash(saved.scheduleSha256),
      owner, ownerSessionHash: saved.ownerSessionHash, ownerEpochHash: saved.ownerEpochHash, admissionHash: saved.admissionHash,
      expiresBoot: saved.expiresBoot, expiresCont: BigInt(saved.expiresCont), expiresWall: BigInt(saved.expiresWall), used: true,
    })
  }

  const controller: SkillOptController = Object.freeze({
    initialize() {
      ledger.initialize(true)
    },
    status() {
      try {
        const saved = ledger.readStatus().status
        try { return ledger.readStatus(clock()).status } catch (error) {
          if (!(error instanceof SkillOptControllerError) || !error.code.startsWith("clock-")) throw error
          return Object.freeze({ ...saved, state: saved.pendingDispatch ? "UNRESOLVED" : "BLOCKED",
            reasonCode: saved.pendingDispatch ? "dispatch-pending" : error.code })
        }
      } catch (error) {
        const failure = fixedStateForError(error)
        return Object.freeze({ state: failure.state, reasonCode: failure.reasonCode, revision: 0, pendingDispatch: false,
          quotaKeySha256: authority.quotaKey,
          requestCounts: { charged: { target: 0, optimizer: 0, reviewer: 0 }, dispatched: { target: 0, optimizer: 0, reviewer: 0 }, unknown: { target: 0, optimizer: 0, reviewer: 0 } },
          targetPhaseCounts: { trainingAndDevelopment: { charged: 0, dispatched: 0, unknown: 0 },
            finalSafety: { charged: 0, dispatched: 0, unknown: 0 }, canary: { charged: 0, dispatched: 0, unknown: 0 } },
          remaining: { target: NATIVE_SKILLOPT_LIMITS.targetRequests, optimizer: NATIVE_SKILLOPT_LIMITS.optimizerRequests,
            reviewer: NATIVE_SKILLOPT_LIMITS.reviewerRequests, activeMilliseconds: NATIVE_SKILLOPT_LIMITS.activeMilliseconds,
            artifactBytes: NATIVE_SKILLOPT_LIMITS.artifactBytes,
            candidateSteps: NATIVE_SKILLOPT_LIMITS.candidateSteps }, dailyCooldownRemainingMilliseconds: 0 })
      }
    },
    reserveNativePreparationArtifacts(input) {
      if (!input || typeof input !== "object" || !input.owner || !UUID.test(input.runId) ||
          !Number.isSafeInteger(input.bytes) || input.bytes < 0) fail("budget-exhausted")
      if (input.runtime !== runtime) fail("owner-unavailable")
      if (input.bytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) fail("budget-exhausted")
      const owner = ownerProof(runtime, root, input.owner)
      assertRuntimeIdle(runtime, input.owner)
      const now = clock()
      const snapshot = ledger.readRunForReentry(input.runId)
      if (!snapshot) fail("run-stale")
      if (!UUID.test(snapshot.run.expires_boot) || boundedClockDecimal(snapshot.run.expires_cont) === undefined ||
          boundedClockDecimal(snapshot.run.expires_wall) === undefined) fail("storage-corrupt")
      if (snapshot.run.expires_boot !== now.boot || BigInt(snapshot.run.expires_cont) < now.continuous ||
          BigInt(snapshot.run.expires_wall) < now.wall) fail("run-expired")
      const validated = validateReentrySnapshot(snapshot, now)
      if (snapshot.run.owner_session_id !== input.owner.sessionID || snapshot.run.owner_epoch !== input.owner.epoch ||
          snapshot.run.owner_session_hash !== owner.sessionHash || snapshot.run.owner_epoch_hash !== owner.epochHash ||
          snapshot.run.admission_hash !== owner.admissionHash) fail("owner-unavailable")
      const binding = currentBindings(input.current)
      if (binding.hashes.bindingSha256 !== snapshot.run.binding_hash || binding.hashes.datasetSha256 !== snapshot.run.dataset_hash ||
          binding.hashes.dataSha256 !== snapshot.run.data_hash || binding.hashes.modelBindingsSha256 !== snapshot.run.model_hash ||
          binding.hashes.protocolSha256 !== snapshot.run.protocol_hash || binding.hashes.baselineSkillSha256 !== snapshot.run.baseline_hash) {
        fail("consent-binding-drift")
      }
      const preparedState = preparedStatesByRun.get(input.runId) ?? armStatesByRun.get(input.runId)?.preparedState
      if (preparedState && preparedState.revision !== snapshot.run.revision) fail("revision-conflict")
      const verifyCurrent = () => {
        if (input.runtime !== runtime) fail("owner-unavailable")
        const proof = ownerProof(runtime, root, input.owner)
        if (!isDeepStrictEqual(proof, owner)) fail("owner-unavailable")
        assertRuntimeIdle(runtime, input.owner)
        const hashes = currentBindings(input.current).hashes
        if (!isDeepStrictEqual(hashes, binding.hashes)) fail("consent-binding-drift")
        return { owner: proof, hashes, clock: clock() }
      }
      ledger.reserveNativePreparationArtifacts({ expected: snapshot, expectedRevision: snapshot.run.revision,
        expectedState: validated.state, owner, ownerSessionID: input.owner.sessionID, ownerEpoch: input.owner.epoch,
        hashes: binding.hashes, bytes: input.bytes, verifyCurrent })
      if (input.bytes > 0 && preparedState) preparedState.revision = snapshot.run.revision + 1
      return this.status()
    },
    reserveNativeTrainerMaterialization(input) {
      if (!input || typeof input !== "object" || !input.owner || input.runtime !== runtime ||
          !validNativeTrainerMaterializationMetadata(input.materialization)) fail("binding-invalid")
      const metadata = Object.freeze({ ...input.materialization })
      const preparedObject = input.prepared && typeof input.prepared === "object" ? input.prepared as object : undefined
      const preparedState = preparedObject
        ? preparedStates.get(preparedObject) ?? armStates.get(preparedObject)?.preparedState
        : undefined
      if (!preparedState || preparedState.runId !== metadata.runId || input.prepared.runId !== metadata.runId ||
          preparedState.owner !== input.owner ||
          input.prepared.bindingSha256 !== metadata.bindingSha256 || preparedState.hashes.bindingSha256 !== metadata.bindingSha256 ||
          metadata.rootBinding !== sha256(`root:${root}`)) fail("consent-binding-drift")
      const binding = currentBindings(input.current)
      if (!isDeepStrictEqual(binding.hashes, preparedState.hashes)) fail("consent-binding-drift")
      const cleanupMetadataBytes = NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES
      const totalBytes = metadata.projectionBytes + metadata.manifestBytes * 2 + cleanupMetadataBytes +
        NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES
      if (!Number.isSafeInteger(totalBytes) || totalBytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) fail("budget-exhausted")
      const priorRevision = preparedState.revision
      const priorSnapshot = ledger.readRunForReentry(metadata.runId)
      if (!priorSnapshot || priorSnapshot.run.revision !== priorRevision) fail("revision-conflict")
      const reservationState = validateReentrySnapshot(priorSnapshot, clock()).state
      const status = this.reserveNativePreparationArtifacts({ owner: input.owner, runtime, runId: metadata.runId,
        current: input.current, bytes: totalBytes })
      if (preparedState.revision !== priorRevision + 1 || status.revision !== preparedState.revision ||
          status.runId !== metadata.runId || status.pendingDispatch) {
        fail("revision-conflict")
      }
      const owner = ownerProof(runtime, root, input.owner)
      const protocolStageAllowance = Object.freeze({}) as SkillOptNativeTrainerProtocolStageAllowance
      nativeTrainerProtocolStageAllowances.set(protocolStageAllowance as object, {
        metadata, used: false,
      })
      const allowance = Object.freeze({}) as SkillOptNativeTrainerMaterializationAllowance
      nativeTrainerMaterializationAllowances.set(allowance as object, {
        controllerIdentity, owner: input.owner, runtime, ownerProof: owner, prepared: input.prepared,
        preparedState, bindingHashes: binding.hashes, metadata, runState: reservationState,
        revision: preparedState.revision, reservedBytes: totalBytes, cleanupMetadataBytes, protocolStageAllowance, used: false,
      })
      return allowance
    },
    consumeNativeTrainerMaterializationAllowance(allowance, input) {
      const allowanceObject = allowance && typeof allowance === "object" ? allowance as object : undefined
      const state = allowanceObject ? nativeTrainerMaterializationAllowances.get(allowanceObject) : undefined
      if (!state || state.controllerIdentity !== controllerIdentity || state.used || !input || typeof input !== "object" ||
          !validNativeTrainerMaterializationMetadata(input.materialization) ||
          canonicalJson(input.materialization) !== canonicalJson(state.metadata) ||
          state.cleanupMetadataBytes !== NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES ||
          state.reservedBytes !== state.metadata.projectionBytes + state.metadata.manifestBytes * 2 + state.cleanupMetadataBytes +
            NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES) {
        fail("binding-invalid")
      }
      if (input.runtime !== runtime || input.owner !== state.owner || input.prepared !== state.prepared) fail("owner-unavailable")
      const preparedObject = input.prepared && typeof input.prepared === "object" ? input.prepared as object : undefined
      const preparedState = preparedObject
        ? preparedStates.get(preparedObject) ?? armStates.get(preparedObject)?.preparedState
        : undefined
      if (!preparedState || preparedState !== state.preparedState || preparedState.revision !== state.revision ||
          input.prepared.runId !== state.metadata.runId || input.prepared.bindingSha256 !== state.metadata.bindingSha256) {
        fail("revision-conflict")
      }
      if (state.metadata.rootBinding !== sha256(`root:${root}`)) fail("consent-binding-drift")
      const proof = ownerProof(runtime, root, input.owner)
      if (!isDeepStrictEqual(proof, state.ownerProof)) fail("owner-unavailable")
      assertRuntimeIdle(runtime, input.owner)
      const binding = currentBindings(input.current)
      if (!isDeepStrictEqual(binding.hashes, state.bindingHashes)) fail("consent-binding-drift")
      const now = clock()
      const snapshot = ledger.readRunForReentry(state.metadata.runId)
      if (!snapshot) fail("run-stale")
      const validated = validateReentrySnapshot(snapshot, now)
      if (validated.state !== state.runState || snapshot.run.revision !== state.revision ||
          snapshot.run.owner_session_id !== input.owner.sessionID || snapshot.run.owner_epoch !== input.owner.epoch ||
          snapshot.run.owner_session_hash !== proof.sessionHash || snapshot.run.owner_epoch_hash !== proof.epochHash ||
          snapshot.run.admission_hash !== proof.admissionHash || snapshot.run.binding_hash !== state.metadata.bindingSha256 ||
          snapshot.run.dataset_hash !== state.bindingHashes.datasetSha256 || snapshot.run.data_hash !== state.bindingHashes.dataSha256 ||
          snapshot.run.model_hash !== state.bindingHashes.modelBindingsSha256 || snapshot.run.protocol_hash !== state.bindingHashes.protocolSha256 ||
          snapshot.run.baseline_hash !== state.bindingHashes.baselineSkillSha256) fail("revision-conflict")
      const finalProof = ownerProof(runtime, root, input.owner)
      if (!isDeepStrictEqual(finalProof, state.ownerProof) ||
          !isDeepStrictEqual(currentBindings(input.current).hashes, state.bindingHashes)) fail("consent-binding-drift")
      assertRuntimeIdle(runtime, input.owner)
      state.used = true
      return state.protocolStageAllowance
    },
    openNativeTrainerProtocolCapture(input) {
      if (!input || typeof input !== "object" || !input.owner || !input.prepared || typeof input.prepared !== "object") {
        fail("binding-invalid")
      }
      const preparedState = preparedStates.get(input.prepared as object)
      if (!preparedState || preparedState.owner !== input.owner || !preparedState.initialStartConsumed) fail("run-stale")
      const existingCapture = nativeTrainerProtocolCapturesByRun.get(preparedState.runId)
      if (existingCapture || ledger.nativeTrainerProtocolEventCount(preparedState.runId) > 0) fail("recovery-unresolved")
      const trainer = copyExactDataProperties(input.trainer, ["profile", "receipt"])
      if (!trainer || !isRecord(trainer.profile) || !isRecord(trainer.receipt)) fail("binding-invalid")
      const profile = trainer.profile as unknown as SkillOptWorkerProfile
      const receipt = trainer.receipt as unknown as SkillOptContainmentReceipt
      if (!isRecord(profile.binding) || profile.binding.role !== "trainer" || !asHash(profile.binding.profileSha256) ||
          receipt.status !== "READY" || receipt.bindingSha256 !== profile.binding.profileSha256) fail("binding-invalid")
      if (input.runtime !== runtime) fail("owner-unavailable")
      const proof = ownerProof(runtime, root, input.owner)
      if (!isDeepStrictEqual(proof, { sessionHash: preparedState.ownerSessionHash,
        epochHash: preparedState.ownerEpochHash, admissionHash: preparedState.admissionHash })) fail("owner-unavailable")
      assertRuntimeIdle(runtime, input.owner)
      const binding = requireFreshBinding(preparedState, input.current)
      if (!isDeepStrictEqual(binding.hashes, preparedState.hashes)) fail("consent-binding-drift")
      const schedule = buildNativeCampaignSchedule(binding.dataset.fixturePack)
      if (schedule.scheduleSha256 !== preparedState.campaign.scheduleSha256) fail("consent-binding-drift")
      const openClock = clock()
      const persisted = ledger.readStatus(openClock)
      const run = persisted.run
      if (!run) fail("run-stale")
      if (!isStoredRunRow(run)) fail("storage-corrupt")
      if (run.run_id !== preparedState.runId || persisted.activeRunId !== preparedState.runId) fail("run-stale")
      const initialWarmupPending = preparedState.initialStartConsumed && run.state === "RESERVED" &&
        ledger.isInitialTrainerWarmupPending({ runId: preparedState.runId, owner: proof,
          ownerSessionID: input.owner.sessionID, ownerEpoch: input.owner.epoch })
      const runningAndIdle = run.state === "RUNNING" && !persisted.status.pendingDispatch && !persisted.pending
      if (!initialWarmupPending && !runningAndIdle) fail("run-stale")
      assertCampaignArtifactRunLive(run, openClock)
      if (run.owner_session_hash !== proof.sessionHash || run.owner_epoch_hash !== proof.epochHash ||
          run.admission_hash !== proof.admissionHash || run.binding_hash !== binding.hashes.bindingSha256) {
        fail("owner-unavailable")
      }
      const consent = consentByRun.get(preparedState.runId)
      if (!consent || consent.owner !== input.owner || consent.campaign.scheduleSha256 !== schedule.scheduleSha256) {
        fail("consent-required")
      }
      assertConsentLive(consent, openClock)
      let baseline: Buffer
      try { baseline = readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes) } catch { fail("binding-baseline-drift") }
      if (sha256(baseline) !== binding.hashes.baselineSkillSha256) fail("binding-baseline-drift")
      const originalSkill = baseline.toString("utf8")
      if (!Buffer.from(originalSkill, "utf8").equals(baseline)) fail("binding-baseline-drift")
      let wire: ReturnType<typeof createNativeTrainerWireForSchedule>
      try { wire = createNativeTrainerWireForSchedule({ schedule, runId: preparedState.runId, originalSkill }) }
      catch { fail("binding-invalid") }
      const state: NativeTrainerProtocolCaptureState = {
        controllerIdentity, owner: input.owner, runtime, ownerProof: proof, prepared: input.prepared, preparedState,
        bindingHashes: binding.hashes, schedule, profile, receipt, profileSha256: profile.binding.profileSha256,
        receiptBindingSha256: receipt.bindingSha256, wire, originalSkill, lastOrdinal: 0, events: new Map(), stopped: false, completed: false,
      }
      const capture = Object.freeze({}) as SkillOptNativeTrainerProtocolCapture
      nativeTrainerProtocolCaptures.set(capture as object, state)
      nativeTrainerProtocolCapturesByRun.set(preparedState.runId, state)
      return capture
    },
    consumeNativeTrainerProtocolEvent(capture, input) {
      const state = nativeTrainerProtocolCaptureState(capture)
      if (!input || typeof input !== "object" || state.completed) fail("binding-invalid")
      const context = nativeTrainerProtocolCaptureContext(input, state)
      let line: OwnedTrainerProtocolLine
      try {
        line = consumeOwnedTrainerProtocolEvent(input.event, { profile: state.profile, receipt: state.receipt })
      } catch {
        state.stopped = true
        fail("binding-invalid")
      }
      const copied = copyExactDataProperties(line, ["profileSha256", "receiptBindingSha256", "ordinal", "rawLineSha256", "rawLine"])
      if (!copied || copied.profileSha256 !== state.profileSha256 || copied.receiptBindingSha256 !== state.receiptBindingSha256 ||
          !isNonNegativeSafeInteger(copied.ordinal) || copied.ordinal !== state.lastOrdinal + 1 ||
          !asHash(copied.rawLineSha256) || !Buffer.isBuffer(copied.rawLine) || copied.rawLine.byteLength < 1 ||
          copied.rawLine.byteLength > MAX_NATIVE_TRAINER_PROTOCOL_FRAME_BYTES || copied.rawLine[copied.rawLine.byteLength - 1] === 0x0a ||
          copied.rawLine[copied.rawLine.byteLength - 1] === 0x0d ||
          sha256(copied.rawLine) !== copied.rawLineSha256) quarantineConsumedTrainerProtocolEvent(state)
      const rawLine = Buffer.from(copied.rawLine)
      const source = rawLine.toString("utf8")
      if (!Buffer.from(source, "utf8").equals(rawLine)) quarantineConsumedTrainerProtocolEvent(state)
      let parsed: unknown
      try { parsed = JSON.parse(source) } catch { quarantineConsumedTrainerProtocolEvent(state) }
      let request: NativeTrainerWireRequest
      try { request = state.wire.accept(parsed) }
      catch { quarantineConsumedTrainerProtocolEvent(state) }
      if (request.runId !== state.preparedState.runId || request.ordinal !== copied.ordinal ||
          state.events.has(request.requestId)) quarantineConsumedTrainerProtocolEvent(state)
      const event = nativeTrainerProtocolEventBinding(request, { ...line, rawLine })
      const verifyCurrent = () => {
        const now = clock()
        const confirmed = nativeTrainerProtocolCaptureContext(input, state)
        return { owner: confirmed.proof, hashes: confirmed.binding.hashes, clock: now }
      }
      try {
        ledger.persistNativeTrainerProtocolEvent({ event, owner: context.proof, ownerSessionID: input.owner.sessionID,
          ownerEpoch: input.owner.epoch, hashes: context.binding.hashes, scheduleSha256: state.schedule.scheduleSha256,
          clock: clock(), verifyCurrent })
      } catch (error) {
        if (error instanceof SkillOptControllerError) {
          state.stopped = true
          try { ledger.markTrainerProtocolRecoveryUnresolved({ runId: state.preparedState.runId,
            owner: state.ownerProof, requirePersistedEvents: false }) } catch { fail("recovery-unresolved") }
          throw error
        }
        quarantineConsumedTrainerProtocolEvent(state)
      }
      const eventState: NativeTrainerProtocolEventState = {
        controllerIdentity, capture: state, event, request, description: nativeTrainerProtocolDescription(request),
        reservationAttempted: false,
      }
      const opaque = Object.freeze({}) as SkillOptNativeTrainerProtocolEvent
      nativeTrainerProtocolEvents.set(opaque as object, eventState)
      state.events.set(request.requestId, eventState)
      state.lastOrdinal = copied.ordinal
      return opaque
    },
    describeNativeTrainerProtocolEvent(event) {
      return nativeTrainerProtocolEventState(event).description
    },
    completeNativeTrainerProtocolCapture(capture, input) {
      const state = nativeTrainerProtocolCaptureState(capture)
      if (state.completed) fail("binding-invalid")
      if (!isGenuineCompletedQuiescentTrainerResult(input.result, state.profile, state.receipt)) {
        quarantineConsumedTrainerProtocolEvent(state)
      }
      nativeTrainerProtocolCaptureContext(input, state)
      if (ledger.nativeTrainerProtocolEventCount(state.preparedState.runId) !== state.lastOrdinal) {
        state.stopped = true
        fail("recovery-unresolved")
      }
      if ([...state.events.values()].some(event => !event.reservationAttempted || !event.reservationRequestId ||
          (event.request.kind === "optimizer" && !event.optimizerResponseConsumed))) {
        quarantineConsumedTrainerProtocolEvent(state)
      }
      try {
        const result = state.wire.assertComplete()
        const candidateSkill = assembleSkill(state.originalSkill, result.fragment)
        if (sha256(candidateSkill) !== result.candidateSha256) fail("binding-invalid")
        state.candidateSkill = candidateSkill
        state.completed = true
        return Object.freeze({ fragment: result.fragment, candidateSha256: result.candidateSha256 })
      } catch {
        state.stopped = true
        fail("binding-invalid")
      }
    },
    reserveNativeTrainerSelectionTarget(input) {
      const event = nativeTrainerProtocolEventState(input?.event)
      if (!input || !input.owner || !input.prepared || event.request.kind !== "rollout" ||
          (event.request.cohort !== "baseline-selection" && event.request.cohort !== "candidate-selection")) {
        fail("dispatch-not-authorized")
      }
      if (input.runtime !== runtime || input.prepared !== event.capture.prepared || input.owner !== event.capture.owner ||
          input.prepared.runId !== event.capture.preparedState.runId) fail("owner-unavailable")
      return reserveTrainerProtocolRequest(input, event, true)
    },
    prepareNativeCampaignTarget(input) {
      if (!input || typeof input !== "object" || !input.owner || !input.prepared || typeof input.prepared !== "object") {
        fail("binding-invalid")
      }
      const preparedState = preparedStates.get(input.prepared as object)
      if (!preparedState) fail("binding-invalid")
      const context = nativeCampaignTargetContext(input, preparedState)
      const runState = context.snapshot.run.state
      if (preparedState.initialStartConsumed
        ? runState !== "RUNNING" || context.snapshot.quota.pending_request_id !== null
        : !(runState === "PREPARED" || runState === "CONSENTED" || runState === "ARMED")) fail("run-stale")
      const scheduleEntry = normalizeNativeCampaignArtifactScheduleEntry(input.scheduleEntry)
      if (!scheduleEntry) fail("binding-invalid")
      const fixtureId = scheduleEntry.kind === "qualification" ? scheduleEntry.fixtureId : scheduleEntry.caseId
      if (!scheduleEntryBindsFixture(scheduleEntry, fixtureId, context.schedule)) fail("binding-invalid")
      const fixture = context.binding.dataset.fixturePack.fixtures.find(item => item.id === fixtureId)
      if (!fixture) fail("binding-invalid")
      let event: NativeTrainerProtocolEventState | undefined
      if (input.trainerEvent) {
        if (!preparedState.initialStartConsumed || runState !== "RUNNING") fail("dispatch-not-authorized")
        event = nativeTrainerProtocolEventState(input.trainerEvent)
        const request = event.request
        if (request.kind !== "rollout" || request.runId !== preparedState.runId ||
            event.capture.preparedState !== preparedState || event.capture.schedule.scheduleSha256 !== context.schedule.scheduleSha256 ||
            request.caseId !== fixtureId || event.targetPlan || event.reservationAttempted) fail("dispatch-not-authorized")
        if (scheduleEntry.kind === "training") {
          if (request.cohort !== "training" || request.split !== "train" || request.fragment !== "" ||
              request.caseId !== scheduleEntry.caseId || request.replicate !== scheduleEntry.replicate ||
              !context.schedule.training.some(item => item.caseId === request.caseId && item.replicate === request.replicate)) {
            fail("dispatch-not-authorized")
          }
        } else if (scheduleEntry.kind === "trainerSelection") {
          if ((request.cohort !== "baseline-selection" && request.cohort !== "candidate-selection") ||
              request.split !== "selection" || (request.cohort === "baseline-selection" && request.fragment !== "") ||
              (request.cohort === "candidate-selection" && request.fragment.length === 0) ||
              request.caseId !== scheduleEntry.caseId || request.replicate !== scheduleEntry.replicate ||
              !context.schedule.trainerSelection.some(item => item.caseId === request.caseId && item.replicate === request.replicate)) {
            fail("dispatch-not-authorized")
          }
        } else fail("dispatch-not-authorized")
      }
      if (scheduleEntry.kind === "trainerSelection" && !event) fail("dispatch-not-authorized")
      if (scheduleEntry.kind === "training" && !event) {
        const warmupIndex = preparedState.initialStartConsumed ? 1 : 0
        const warmupEntry = context.schedule.training[warmupIndex]
        if (!warmupEntry || warmupEntry.caseId !== scheduleEntry.caseId || warmupEntry.replicate !== scheduleEntry.replicate) {
          fail("dispatch-not-authorized")
        }
      }
      let originalBytes: Buffer
      try { originalBytes = readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes) } catch { fail("binding-baseline-drift") }
      if (sha256(originalBytes) !== context.binding.hashes.baselineSkillSha256) fail("binding-baseline-drift")
      const originalSkill = originalBytes.toString("utf8")
      if (!Buffer.from(originalSkill, "utf8").equals(originalBytes)) fail("binding-baseline-drift")
      let targetSkill = originalSkill
      if (event?.request.kind === "rollout" && event.request.cohort === "candidate-selection") {
        try { targetSkill = assembleSkill(originalSkill, event.request.fragment) } catch { fail("binding-invalid") }
      } else if (scheduleEntry.kind === "qualification" && scheduleEntry.variant === "candidate") {
        const capture = nativeTrainerProtocolCapturesByRun.get(preparedState.runId)
        if (!capture || capture.controllerIdentity !== controllerIdentity || capture.preparedState !== preparedState ||
            capture.stopped || !capture.completed || typeof capture.candidateSkill !== "string") fail("recovery-unresolved")
        targetSkill = capture.candidateSkill
      }
      let promptSha256: string
      try {
        const rendered = renderNativeEvaluationPrompt(fixture, targetSkill)
        const prompt = canonicalJson({ system: rendered.system, user: rendered.user })
        promptSha256 = sha256(Buffer.from(prompt, "utf8"))
        if (rendered.promptSha256 !== promptSha256) fail("binding-invalid")
      } catch { fail("binding-invalid") }
      const targetSkillSha256 = sha256(Buffer.from(targetSkill, "utf8"))
      const eventIdentity = event ? { wireRequestId: event.event.wireRequestId, cohort: event.request.kind === "rollout" ? event.request.cohort : null } : null
      const issuanceKey = canonicalJson({ runId: preparedState.runId, scheduleEntry, eventIdentity })
      if (nativeCampaignTargetPlanIssuances.has(issuanceKey)) fail("binding-invalid")
      const state: NativeCampaignTargetPlanState = {
        controllerIdentity, owner: input.owner, runtime, ownerProof: context.proof, prepared: input.prepared,
        preparedState, bindingHashes: context.binding.hashes, schedule: context.schedule, scheduleEntry,
        fixtureId, targetSkillSha256, promptSha256, ...(event ? { event } : {}),
      }
      const opaque = Object.freeze({}) as SkillOptNativeCampaignTargetPlan
      nativeCampaignTargetPlans.set(opaque as object, state)
      if (event) event.targetPlan = state
      nativeCampaignTargetPlanIssuances.add(issuanceKey)
      return opaque
    },
    bindNativeCampaignTargetReservation(input) {
      if (!input || typeof input !== "object" || !input.owner || !input.prepared || typeof input.prepared !== "object") {
        fail("binding-invalid")
      }
      const plan = nativeCampaignTargetPlanState(input.targetPlan)
      if (plan.boundReservation || plan.controllerIdentity !== controllerIdentity || plan.owner !== input.owner ||
          plan.runtime !== input.runtime || plan.prepared !== input.prepared) fail("dispatch-not-authorized")
      const context = nativeCampaignTargetContext(input, plan.preparedState)
      assertNativeCampaignTargetConsent(plan.preparedState.runId, input.owner)
      if (!isDeepStrictEqual(context.proof, plan.ownerProof) || !isDeepStrictEqual(context.binding.hashes, plan.bindingHashes) ||
          context.schedule.scheduleSha256 !== plan.schedule.scheduleSha256) fail("consent-binding-drift")
      const reservationState = verifyTrainerProtocolReservation(input.reservation, plan.preparedState.runId, plan.event)
      const expectedPhase = plan.scheduleEntry.kind === "qualification" ? plan.scheduleEntry.split
        : plan.scheduleEntry.kind === "training" ? "train" : "dev"
      if (input.reservation.role !== "target" || input.reservation.phase !== expectedPhase ||
          input.reservation.bindingSha256 !== plan.bindingHashes.bindingSha256 ||
          input.reservation.scheduleSha256 !== plan.schedule.scheduleSha256 ||
          reservationState.requestId !== input.reservation.requestId || reservationState.reservationId !== input.reservation.reservationId ||
          reservationState.role !== "target" ||
          reservationState.phase !== expectedPhase) fail("dispatch-not-authorized")
      const ticket = ticketStates.get(input.reservation.ticket as object)
      const receipt = receiptStates.get(input.reservation.receipt as object)
      if (!ticket || !receipt || ticket.owner !== input.owner || receipt.owner !== input.owner ||
          ticket.consumed || ticket.grantIssued || ticket.recorded || receipt.ticketConsumed || receipt.recorded ||
          ticket.runId !== plan.preparedState.runId || ticket.requestId !== input.reservation.requestId ||
          ticket.reservationId !== input.reservation.reservationId || ticket.role !== "target" || ticket.phase !== expectedPhase ||
          ticket.bindingSha256 !== plan.bindingHashes.bindingSha256 ||
          !isDeepStrictEqual(ticket.ownerProof, context.proof) || !isDeepStrictEqual(receipt.ownerProof, context.proof) ||
          receipt.requestId !== input.reservation.requestId || receipt.reservationId !== input.reservation.reservationId) {
        fail("dispatch-not-authorized")
      }
      if (context.snapshot.run.state !== "RESERVED" || context.snapshot.quota.pending_request_id !== input.reservation.requestId) {
        fail("dispatch-pending")
      }
      plan.boundReservation = input.reservation
      const state: NativeCampaignTargetBindingState = {
        controllerIdentity, plan, reservation: input.reservation, reservationState, responseAttempted: false,
      }
      const opaque = Object.freeze({}) as SkillOptNativeCampaignTargetBinding
      nativeCampaignTargetBindings.set(opaque as object, state)
      return opaque
    },
    admitNativeCampaignTargetResponse(input) {
      if (!input || typeof input !== "object" || !input.owner || !input.prepared || typeof input.prepared !== "object" ||
          !input.targetWitness || typeof input.targetWitness !== "object") fail("dispatch-not-authorized")
      const bindingState = nativeCampaignTargetBindingState(input.target)
      const plan = bindingState.plan
      if (bindingState.responseAttempted || bindingState.response || bindingState.controllerIdentity !== controllerIdentity ||
          plan.boundReservation !== bindingState.reservation || plan.owner !== input.owner || plan.runtime !== input.runtime ||
          plan.prepared !== input.prepared) fail("dispatch-not-authorized")
      bindingState.responseAttempted = true
      const context = nativeCampaignTargetContext(input, plan.preparedState)
      assertNativeCampaignTargetConsent(plan.preparedState.runId, input.owner)
      if (!isDeepStrictEqual(context.proof, plan.ownerProof) || !isDeepStrictEqual(context.binding.hashes, plan.bindingHashes) ||
          context.snapshot.run.state !== "RUNNING" || context.snapshot.quota.pending_request_id !== null) fail("dispatch-not-authorized")
      validateRunningCampaignArtifactStage(context.snapshot, plan.preparedState.runId, context.snapshot.run.revision,
        context.proof, context.binding.hashes, clock())
      const reservationState = verifyTrainerProtocolReservation(bindingState.reservation, plan.preparedState.runId, plan.event)
      if (reservationState !== bindingState.reservationState || !reservationState ||
          !ticketStates.get(bindingState.reservation.ticket as object)?.recorded ||
          !ticketStates.get(bindingState.reservation.ticket as object)?.grantIssued ||
          !receiptStates.get(bindingState.reservation.receipt as object)?.recorded) fail("dispatch-not-authorized")
      ledger.assertNativeTrainerProtocolArtifactEvidence({ runId: plan.preparedState.runId,
        reservation: { requestId: bindingState.reservation.requestId, reservationId: bindingState.reservation.reservationId,
          role: bindingState.reservation.role, phase: bindingState.reservation.phase },
        ...(plan.event ? { event: plan.event.event, requireAssociation: true } : {}) })
      let witnessResult: unknown
      try {
        witnessResult = nativeHost.consumeCompletedTargetWitness(input.targetWitness,
          { controller, owner: input.owner, reservation: bindingState.reservation })
      } catch { fail("dispatch-not-authorized") }
      const witness = copyExactDataProperties(witnessResult, ["promptSha256", "responseSha256", "responseBytes"])
      if (!witness || !asHash(witness.promptSha256) || witness.promptSha256 !== plan.promptSha256 ||
          !asHash(witness.responseSha256) || !isNonNegativeSafeInteger(witness.responseBytes) ||
          witness.responseBytes < 1 || witness.responseBytes > NATIVE_DATASET_LIMITS.nativeResponseBytes) {
        fail("dispatch-not-authorized")
      }
      const state: NativeCampaignTargetResponseState = {
        controllerIdentity, binding: bindingState, promptSha256: witness.promptSha256,
        responseSha256: witness.responseSha256, responseBytes: witness.responseBytes,
      }
      const opaque = Object.freeze({}) as SkillOptNativeCampaignTargetResponse
      nativeCampaignTargetResponses.set(opaque as object, state)
      bindingState.response = state
      return opaque
    },
    associateNativeTrainerWarmupTarget(input) {
      if (!input || typeof input !== "object" || !input.owner || !input.prepared || typeof input.prepared !== "object") {
        fail("binding-invalid")
      }
      const target = nativeCampaignTargetResponseState(input.target)
      const event = nativeTrainerProtocolEventState(input.event)
      const binding = target.binding
      const plan = binding.plan
      const request = event.request
      if (target.associatedEvent || binding.response !== target || plan.scheduleEntry.kind !== "training" ||
          plan.event || binding.reservation.role !== "target" || binding.reservation.phase !== "train" ||
          event.associationAttempted || event.associatedWarmupReservation || event.reservationAttempted ||
          request.kind !== "rollout" || request.cohort !== "training" || request.runId !== plan.preparedState.runId ||
          request.caseId !== plan.scheduleEntry.caseId || request.replicate !== plan.scheduleEntry.replicate ||
          !plan.schedule.training.some(item => item.caseId === request.caseId && item.replicate === request.replicate) ||
          plan.owner !== input.owner || plan.runtime !== input.runtime || plan.prepared !== input.prepared) {
        fail("dispatch-not-authorized")
      }
      const context = nativeCampaignTargetContext(input, plan.preparedState)
      assertNativeCampaignTargetConsent(plan.preparedState.runId, input.owner)
      if (!isDeepStrictEqual(context.proof, plan.ownerProof) || !isDeepStrictEqual(context.binding.hashes, plan.bindingHashes) ||
          context.snapshot.run.state !== "RUNNING" || context.snapshot.quota.pending_request_id !== null) fail("dispatch-not-authorized")
      validateRunningCampaignArtifactStage(context.snapshot, plan.preparedState.runId, context.snapshot.run.revision,
        context.proof, context.binding.hashes, clock())
      const reservationState = verifyTrainerProtocolReservation(binding.reservation, plan.preparedState.runId)
      if (reservationState !== binding.reservationState || !ticketStates.get(binding.reservation.ticket as object)?.recorded ||
          !receiptStates.get(binding.reservation.receipt as object)?.recorded) fail("dispatch-not-authorized")
      event.associationAttempted = true
      event.reservationAttempted = true
      try {
        const now = clock()
        const verifyCurrent = () => {
          const proof = ownerProof(runtime, root, input.owner)
          if (!isDeepStrictEqual(proof, context.proof)) fail("owner-unavailable")
          assertRuntimeIdle(runtime, input.owner)
          const latest = requireFreshBinding(plan.preparedState, input.current)
          return { owner: proof, hashes: latest.hashes, clock: clock() }
        }
        ledger.associateNativeTrainerWarmupEvent({ runId: plan.preparedState.runId, event: event.event,
          reservation: { requestId: binding.reservation.requestId, reservationId: binding.reservation.reservationId,
            role: binding.reservation.role, phase: binding.reservation.phase }, owner: context.proof,
          ownerSessionID: input.owner.sessionID, ownerEpoch: input.owner.epoch, hashes: context.binding.hashes,
          clock: now, verifyCurrent })
      } catch {
        event.capture.stopped = true
        try { ledger.markTrainerProtocolRecoveryUnresolved({ runId: plan.preparedState.runId,
          owner: plan.ownerProof, requirePersistedEvents: true }) } catch { fail("recovery-unresolved") }
        fail("recovery-unresolved")
      }
      event.reservationRequestId = binding.reservation.requestId
      event.associatedWarmupReservation = binding.reservationState
      target.associatedEvent = event
    },
    reserveNativeTrainerOptimizerResponse(input) {
      if (!input || typeof input !== "object" || !input.owner || !input.prepared || typeof input.prepared !== "object" ||
          !input.reservation || !input.optimizerWitness || typeof input.optimizerWitness !== "object" ||
          typeof input.responseText !== "string") fail("dispatch-not-authorized")
      const event = nativeTrainerProtocolEventState(input.event)
      if (event.request.kind !== "optimizer" || event.description.kind !== "optimizer" || event.optimizerResponseAttempted ||
          event.capture.completed || event.capture.stopped || event.request.runId !== input.prepared.runId ||
          event.request.requestId !== event.description.wireRequestId || event.request.prompt !== event.description.prompt ||
          event.description.promptSha256 !== sha256(Buffer.from(event.request.prompt, "utf8")) ||
          event.event.kind !== "optimizer" || event.event.promptSha256 !== event.description.promptSha256 ||
          input.runtime !== runtime || input.owner !== event.capture.owner || input.prepared !== event.capture.prepared) {
        fail("dispatch-not-authorized")
      }
      const reservationState = verifyNativeTrainerOptimizerReservation(input.reservation, event)
      const context = nativeTrainerProtocolCaptureContext(input, event.capture)
      if (!isDeepStrictEqual(context.proof, event.capture.ownerProof) ||
          !isDeepStrictEqual(context.binding.hashes, event.capture.bindingHashes)) fail("consent-binding-drift")
      ledger.assertNativeTrainerProtocolArtifactEvidence({ runId: event.capture.preparedState.runId, event: event.event,
        reservation: { requestId: input.reservation.requestId, reservationId: input.reservation.reservationId,
          role: "optimizer", phase: "train" }, requireAssociation: true })
      const responseBytes = Buffer.byteLength(input.responseText, "utf8")
      if (Buffer.from(input.responseText, "utf8").toString("utf8") !== input.responseText || responseBytes < 1 ||
          responseBytes > NATIVE_DATASET_LIMITS.nativeResponseBytes) fail("dispatch-not-authorized")
      event.optimizerResponseAttempted = true
      let witnessResult: unknown
      try {
        witnessResult = nativeHost.consumeCompletedOptimizerWitness(input.optimizerWitness,
          { controller, owner: input.owner, reservation: input.reservation })
      } catch {
        event.capture.stopped = true
        fail("dispatch-not-authorized")
      }
      const witness = copyExactDataProperties(witnessResult, ["promptSha256", "responseSha256", "responseBytes", "usage"])
      const usage = witness ? copyNativeOptimizerUsage(witness.usage) : undefined
      const responseSha256 = sha256(Buffer.from(input.responseText, "utf8"))
      if (!witness || !asHash(witness.promptSha256) || witness.promptSha256 !== event.description.promptSha256 ||
          !asHash(witness.responseSha256) || witness.responseSha256 !== responseSha256 ||
          !isNonNegativeSafeInteger(witness.responseBytes) || witness.responseBytes !== responseBytes ||
          usage === undefined) {
        event.capture.stopped = true
        fail("dispatch-not-authorized")
      }
      const message: SkillOptNativeTrainerOptimizerResponseMessage = Object.freeze({
        schema: "skillopt.native-optimizer-response.v1", runId: event.request.runId,
        requestId: event.request.requestId, role: "optimizer", phase: "train", ok: true,
        text: input.responseText, usage,
      })
      const messageBytes = Buffer.byteLength(`${JSON.stringify(message)}\n`, "utf8")
      if (!Number.isSafeInteger(messageBytes) || messageBytes < 1 || messageBytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) {
        event.capture.stopped = true
        fail("budget-exhausted")
      }
      let snapshot: StoredReentrySnapshot
      try {
        const now = clock()
        const loaded = ledger.readRunForReentry(event.capture.preparedState.runId)
        if (!loaded || loaded.run.state !== "RUNNING") fail("run-stale")
        snapshot = loaded
        assertCampaignArtifactRunLive(snapshot.run, now)
      } catch (error) {
        event.capture.stopped = true
        throw error
      }
      const verifyCurrent = () => {
        const proof = ownerProof(runtime, root, input.owner)
        if (!isDeepStrictEqual(proof, context.proof)) fail("owner-unavailable")
        assertRuntimeIdle(runtime, input.owner)
        const binding = requireFreshBinding(event.capture.preparedState, input.current)
        if (!isDeepStrictEqual(binding.hashes, event.capture.bindingHashes)) fail("consent-binding-drift")
        return { owner: proof, hashes: binding.hashes, clock: clock() }
      }
      try {
        ledger.reserveRunningNativeCampaignArtifacts({ runId: event.capture.preparedState.runId,
          expectedRevision: snapshot.run.revision, owner: context.proof, ownerSessionID: input.owner.sessionID,
          ownerEpoch: input.owner.epoch, hashes: context.binding.hashes, bytes: messageBytes,
          protocolEvidence: { event: event.event, reservation: { requestId: input.reservation.requestId,
            reservationId: input.reservation.reservationId, role: "optimizer", phase: "train" }, requireAssociation: true },
          verifyCurrent })
      } catch (error) {
        event.capture.stopped = true
        throw error
      }
      const allowance = Object.freeze({}) as SkillOptNativeTrainerOptimizerResponseAllowance
      nativeTrainerOptimizerResponseAllowances.set(allowance as object, {
        controllerIdentity, owner: input.owner, runtime, prepared: input.prepared,
        preparedState: event.capture.preparedState, ownerProof: context.proof, bindingHashes: context.binding.hashes,
        event, reservation: input.reservation, reservationState, message, used: false,
      })
      return allowance
    },
    consumeNativeTrainerOptimizerResponse(allowance, input) {
      if (!input || typeof input !== "object" || !input.owner || !input.prepared || typeof input.prepared !== "object") {
        fail("binding-invalid")
      }
      const key = allowance && typeof allowance === "object" ? allowance as object : undefined
      const state = key ? nativeTrainerOptimizerResponseAllowances.get(key) : undefined
      if (!state || state.used || state.controllerIdentity !== controllerIdentity || input.owner !== state.owner ||
          input.runtime !== state.runtime || input.runtime !== runtime || input.prepared !== state.prepared ||
          nativeTrainerProtocolEvents.get(input.event as object) !== state.event ||
          input.reservation !== state.reservation) fail("binding-invalid")
      state.used = true
      nativeTrainerOptimizerResponseAllowances.delete(key!)
      try {
        const event = nativeTrainerProtocolEventState(input.event)
        if (event !== state.event || !event.optimizerResponseAttempted) fail("dispatch-not-authorized")
        const context = nativeTrainerProtocolCaptureContext(input, event.capture)
        if (!isDeepStrictEqual(context.proof, state.ownerProof) || !isDeepStrictEqual(context.binding.hashes, state.bindingHashes)) {
          fail("consent-binding-drift")
        }
        const reservationState = verifyNativeTrainerOptimizerReservation(input.reservation, event)
        if (reservationState !== state.reservationState) fail("dispatch-not-authorized")
        ledger.assertNativeTrainerProtocolArtifactEvidence({ runId: event.capture.preparedState.runId, event: event.event,
          reservation: { requestId: input.reservation.requestId, reservationId: input.reservation.reservationId,
            role: "optimizer", phase: "train" }, requireAssociation: true })
        event.optimizerResponseConsumed = true
        return state.message
      } catch (error) {
        state.event.capture.stopped = true
        throw error
      }
    },
    reserveNativeCampaignArtifactStage(input) {
      if (!input || typeof input !== "object" || !input.owner || !input.prepared || typeof input.prepared !== "object") {
        fail("binding-invalid")
      }
      const metadata = normalizeNativeCampaignArtifactStageMetadata(input.metadata)
      if (!metadata) fail("binding-invalid")
      const preparedState = preparedStates.get(input.prepared as object)
      if (!preparedState) fail("binding-invalid")
      const protocol = campaignArtifactProtocolEvidence(input, metadata)
      if ((protocol.targetPlan && (protocol.targetPlan.owner !== input.owner || protocol.targetPlan.runtime !== runtime ||
          protocol.targetPlan.prepared !== input.prepared || protocol.targetPlan.preparedState !== preparedState)) ||
          (protocol.target && (protocol.target.binding.plan.owner !== input.owner || protocol.target.binding.plan.runtime !== runtime ||
            protocol.target.binding.plan.prepared !== input.prepared || protocol.target.binding.plan.preparedState !== preparedState))) {
        fail("owner-unavailable")
      }
      const issuanceKey = protocol.event
        ? canonicalJson({ runId: metadata.runId, stage: metadata.stage, wireRequestId: protocol.event.event.wireRequestId })
        : canonicalJson({ runId: metadata.runId, stage: metadata.stage, fixtureId: metadata.fixtureId,
          scheduleEntry: metadata.scheduleEntry })
      if (nativeCampaignArtifactStageIssuances.has(issuanceKey)) fail("binding-invalid")
      const context = campaignArtifactStageContext(input, metadata, preparedState)
      const snapshot = ledger.readRunForReentry(metadata.runId)
      if (!snapshot) fail("run-stale")
      const ownerMatches = snapshot.run.owner_session_id === input.owner.sessionID && snapshot.run.owner_epoch === input.owner.epoch &&
        snapshot.run.owner_session_hash === context.proof.sessionHash && snapshot.run.owner_epoch_hash === context.proof.epochHash &&
        snapshot.run.admission_hash === context.proof.admissionHash
      if (!ownerMatches) fail("owner-unavailable")
      const bindingMatches = snapshot.run.binding_hash === context.binding.hashes.bindingSha256 &&
        snapshot.run.dataset_hash === context.binding.hashes.datasetSha256 && snapshot.run.data_hash === context.binding.hashes.dataSha256 &&
        snapshot.run.model_hash === context.binding.hashes.modelBindingsSha256 &&
        snapshot.run.protocol_hash === context.binding.hashes.protocolSha256 &&
        snapshot.run.baseline_hash === context.binding.hashes.baselineSkillSha256
      if (!bindingMatches) fail("consent-binding-drift")
      const now = clock()
      assertCampaignArtifactRunLive(snapshot.run, now)
      if (!preparedState.initialStartConsumed &&
          (snapshot.run.state === "PREPARED" || snapshot.run.state === "CONSENTED" || snapshot.run.state === "ARMED")) {
        if (protocol.event || protocol.reservation) fail("binding-invalid")
        const validated = validateReentrySnapshot(snapshot, now)
        if (validated.state !== snapshot.run.state || preparedState.revision !== snapshot.run.revision) fail("revision-conflict")
        const priorRevision = preparedState.revision
        const verifyCurrent = () => {
          if (input.runtime !== runtime) fail("owner-unavailable")
          const proof = ownerProof(runtime, root, input.owner)
          if (!isDeepStrictEqual(proof, context.proof)) fail("owner-unavailable")
          assertRuntimeIdle(runtime, input.owner)
          const hashes = currentBindings(input.current).hashes
          if (!isDeepStrictEqual(hashes, context.binding.hashes)) fail("consent-binding-drift")
          return { owner: proof, hashes, clock: clock() }
        }
        ledger.reserveNativePreparationArtifacts({ expected: snapshot, expectedRevision: snapshot.run.revision,
          expectedState: validated.state, owner: context.proof, ownerSessionID: input.owner.sessionID,
          ownerEpoch: input.owner.epoch, hashes: context.binding.hashes, bytes: metadata.bytes, verifyCurrent })
        preparedState.revision = priorRevision + 1
        if (!Number.isSafeInteger(preparedState.revision)) fail("revision-conflict")
        const allowance = Object.freeze({}) as SkillOptNativeCampaignArtifactStageAllowance
        nativeCampaignArtifactStageAllowances.set(allowance as object, {
          controllerIdentity, owner: input.owner, runtime, ownerProof: context.proof, prepared: input.prepared,
          preparedState, bindingHashes: context.binding.hashes, metadata, metadataCanonical: canonicalJson(metadata),
          ...(protocol.targetPlan ? { targetPlan: protocol.targetPlan } : {}),
          mode: "prestart", runState: validated.state, revision: preparedState.revision, used: false,
        })
        nativeCampaignArtifactStageIssuances.add(issuanceKey)
        return allowance
      }
      if (!preparedState.initialStartConsumed || snapshot.run.state !== "RUNNING") {
        if (snapshot.run.state === "RESERVED" || snapshot.run.state === "DISPATCH_PENDING" || snapshot.run.state === "UNRESOLVED") {
          fail("dispatch-pending")
        }
        fail("run-stale")
      }
      validateRunningCampaignArtifactStage(snapshot, metadata.runId, snapshot.run.revision, context.proof,
        context.binding.hashes, now)
      const verifyCurrent = () => {
        if (input.runtime !== runtime) fail("owner-unavailable")
        const proof = ownerProof(runtime, root, input.owner)
        if (!isDeepStrictEqual(proof, context.proof)) fail("owner-unavailable")
        assertRuntimeIdle(runtime, input.owner)
        const hashes = currentBindings(input.current).hashes
        if (!isDeepStrictEqual(hashes, context.binding.hashes)) fail("consent-binding-drift")
        return { owner: proof, hashes, clock: clock() }
      }
      ledger.reserveRunningNativeCampaignArtifacts({ runId: metadata.runId, expectedRevision: snapshot.run.revision,
        owner: context.proof, ownerSessionID: input.owner.sessionID, ownerEpoch: input.owner.epoch,
        hashes: context.binding.hashes, bytes: metadata.bytes,
        ...(protocol.protocolEvidence ? { protocolEvidence: protocol.protocolEvidence } : {}), verifyCurrent })
      const allowance = Object.freeze({}) as SkillOptNativeCampaignArtifactStageAllowance
      nativeCampaignArtifactStageAllowances.set(allowance as object, {
        controllerIdentity, owner: input.owner, runtime, ownerProof: context.proof, prepared: input.prepared,
        preparedState, bindingHashes: context.binding.hashes, metadata, metadataCanonical: canonicalJson(metadata),
        ...(protocol.event ? { trainerEvent: protocol.event } : {}),
        ...(protocol.reservation ? { reservation: protocol.reservation } : {}),
        ...(protocol.targetPlan ? { targetPlan: protocol.targetPlan } : {}),
        ...(protocol.target ? { target: protocol.target } : {}),
        mode: "running", runState: "RUNNING", revision: snapshot.run.revision, used: false,
      })
      nativeCampaignArtifactStageIssuances.add(issuanceKey)
      return allowance
    },
    consumeNativeCampaignArtifactStage(allowance, input) {
      const allowanceObject = allowance && typeof allowance === "object" ? allowance as object : undefined
      const state = allowanceObject ? nativeCampaignArtifactStageAllowances.get(allowanceObject) : undefined
      if (!state || state.controllerIdentity !== controllerIdentity || state.used || !input || typeof input !== "object" ||
          !input.prepared || typeof input.prepared !== "object") fail("binding-invalid")
      const metadata = normalizeNativeCampaignArtifactStageMetadata(input.metadata)
      if (!metadata || canonicalJson(metadata) !== state.metadataCanonical) fail("binding-invalid")
      const protocol = campaignArtifactProtocolEvidence(input, metadata)
      if (protocol.event !== state.trainerEvent || protocol.reservation !== state.reservation ||
          protocol.targetPlan !== state.targetPlan || protocol.target !== state.target) fail("binding-invalid")
      if (input.runtime !== runtime || input.owner !== state.owner) fail("owner-unavailable")
      if (input.prepared !== state.prepared) fail("owner-unavailable")
      const preparedState = preparedStates.get(input.prepared as object)
      if (!preparedState || preparedState !== state.preparedState) fail("revision-conflict")
      const context = campaignArtifactStageContext(input, metadata, preparedState)
      if (!isDeepStrictEqual(context.proof, state.ownerProof)) fail("owner-unavailable")
      if (!isDeepStrictEqual(context.binding.hashes, state.bindingHashes)) {
        fail("consent-binding-drift")
      }
      const now = clock()
      const snapshot = ledger.readRunForReentry(metadata.runId)
      if (!snapshot) fail("run-stale")
      assertCampaignArtifactRunLive(snapshot.run, now)
      if (state.mode === "prestart") {
        const validated = validateReentrySnapshot(snapshot, now)
        if (validated.state !== state.runState || snapshot.run.revision !== state.revision ||
            preparedState.revision !== state.revision || preparedState.initialStartConsumed) fail("revision-conflict")
        if (snapshot.run.owner_session_id !== input.owner.sessionID || snapshot.run.owner_epoch !== input.owner.epoch ||
            snapshot.run.owner_session_hash !== state.ownerProof.sessionHash || snapshot.run.owner_epoch_hash !== state.ownerProof.epochHash ||
            snapshot.run.admission_hash !== state.ownerProof.admissionHash) fail("owner-unavailable")
        if (snapshot.run.binding_hash !== state.bindingHashes.bindingSha256 || snapshot.run.dataset_hash !== state.bindingHashes.datasetSha256 ||
            snapshot.run.data_hash !== state.bindingHashes.dataSha256 || snapshot.run.model_hash !== state.bindingHashes.modelBindingsSha256 ||
            snapshot.run.protocol_hash !== state.bindingHashes.protocolSha256 || snapshot.run.baseline_hash !== state.bindingHashes.baselineSkillSha256) {
          fail("consent-binding-drift")
        }
      } else {
        if (!preparedState.initialStartConsumed) fail("run-stale")
        validateRunningCampaignArtifactStage(snapshot, metadata.runId, state.revision, state.ownerProof,
          state.bindingHashes, now)
        const status = ledger.readStatus(now).status
        if (status.reasonCode === "clock-uncertain") fail("clock-uncertain")
      }
      const finalProof = ownerProof(runtime, root, input.owner)
      if (!isDeepStrictEqual(finalProof, state.ownerProof)) fail("owner-unavailable")
      assertRuntimeIdle(runtime, input.owner)
      const finalBinding = currentBindings(input.current)
      if (!isDeepStrictEqual(finalBinding.hashes, state.bindingHashes) ||
          finalBinding.campaign.scheduleSha256 !== metadata.scheduleSha256) fail("consent-binding-drift")
      const finalClock = clock()
      const finalSnapshot = ledger.readRunForReentry(metadata.runId)
      if (!finalSnapshot) fail("run-stale")
      assertCampaignArtifactRunLive(finalSnapshot.run, finalClock)
      if (state.mode === "prestart") {
        const finalValidated = validateReentrySnapshot(finalSnapshot, finalClock)
        if (finalValidated.state !== state.runState || finalSnapshot.run.revision !== state.revision ||
            preparedState.revision !== state.revision || preparedState.initialStartConsumed) fail("revision-conflict")
      } else {
        validateRunningCampaignArtifactStage(finalSnapshot, metadata.runId, state.revision, state.ownerProof,
          state.bindingHashes, finalClock)
        if (protocol.protocolEvidence) ledger.assertNativeTrainerProtocolArtifactEvidence({
          runId: metadata.runId, ...protocol.protocolEvidence,
        })
      }
      state.used = true
    },
    preparePrivateTextCleanup(input) {
      if (!input || typeof input !== "object" || !input.owner || !UUID.test(input.runId) || !asHash(input.artifactsSha256) ||
          !Number.isSafeInteger(input.artifactBytes) || input.artifactBytes < 0 ||
          !(input.trainerSnapshotSha256 === null || asHash(input.trainerSnapshotSha256))) {
        fail("binding-invalid")
      }
      const owner = verifyPrivateTextCleanupOwner(input.owner, input.runtime, input.mutationClaim)
      const now = clock()
      const verifyCurrent = () => { verifyPrivateTextCleanupOwner(input.owner, input.runtime, input.mutationClaim) }
      const inspected = ledger.inspectPrivateTextCleanup({ runId: input.runId, artifactsSha256: input.artifactsSha256,
        artifactBytes: input.artifactBytes, clock: now, verifyCurrent })
      const { run } = inspected.snapshot
      const nonce = randomUUID()
      const controllerEvidenceSha256 = sha256(canonicalJson({
        quota: {
          revision: inspected.snapshot.quota.revision, activeRunId: inspected.snapshot.quota.active_run_id,
          activeOwnerSessionHash: inspected.snapshot.quota.active_owner_session_hash,
          activeOwnerEpochHash: inspected.snapshot.quota.active_owner_epoch_hash,
          pendingRequestId: inspected.snapshot.quota.pending_request_id,
          lastAttemptId: inspected.snapshot.quota.last_attempt_id,
          lastAttemptBoot: inspected.snapshot.quota.last_attempt_boot,
          lastAttemptContinuousNanoseconds: inspected.snapshot.quota.last_attempt_cont,
          fenceBoot: inspected.snapshot.quota.fence_boot, fenceContinuousNanoseconds: inspected.snapshot.quota.fence_cont,
          clockUncertain: inspected.snapshot.quota.clock_uncertain,
        },
        usage: inspected.snapshot.usage, attempts: inspected.snapshot.attempts, requests: inspected.snapshot.requests,
        unresolvedRequestCount: inspected.snapshot.unresolvedRequestCount, handoffs: inspected.snapshot.handoffs,
        consent: inspected.snapshot.consent ?? null, arm: inspected.snapshot.arm ?? null,
        previousRetirementId: inspected.eligibility.previousRetirementId ?? null,
      }))
      const subjectSha256 = sha256(canonicalJson({
        schema: "skillopt.private-text-cleanup.v1", action: PRIVATE_TEXT_CLEANUP_OPERATION, nonce,
        rootBinding: authority.rootBinding, quotaKey: authority.quotaKey,
        run: {
          runId: run.run_id, state: run.state, revision: run.revision,
          oldOwner: { sessionHash: run.owner_session_hash, epochHash: run.owner_epoch_hash, admissionHash: run.admission_hash },
          expiry: { boot: run.expires_boot, continuousNanoseconds: run.expires_cont },
        },
        cleanupOwner: { sessionID: input.owner.sessionID, epoch: input.owner.epoch, ...owner },
        artifactsSha256: input.artifactsSha256,
        artifactBytes: input.artifactBytes,
        trainerSnapshotSha256: input.trainerSnapshotSha256,
        controllerEvidenceSha256,
        expiryProof: inspected.eligibility.resumed
          ? { priorRetirementId: inspected.eligibility.previousRetirementId }
          : { observedBoot: now.boot, observedContinuousNanoseconds: now.continuous.toString() },
      }))
      const decisionBinding: DecisionBinding = Object.freeze({
        sessionID: input.owner.sessionID, workflowID: run.run_id, expectedRevision: run.revision,
        subject: Object.freeze({ kind: "experiment-unit", id: run.run_id, sha256: subjectSha256 }),
      })
      const metadata: SkillOptPrivateTextCleanupMetadata = Object.freeze({
        runId: run.run_id, state: run.state as SkillOptRunState, revision: run.revision,
        artifactsSha256: input.artifactsSha256, artifactBytes: input.artifactBytes, expiresBoot: run.expires_boot,
        expiresContinuousNanoseconds: run.expires_cont, operation: PRIVATE_TEXT_CLEANUP_OPERATION,
      })
      invalidatePrivateTextCleanupChallenges(run.run_id)
      const challenge = Object.freeze({}) as SkillOptPrivateTextCleanupChallenge
      const challengeState: PrivateTextCleanupChallengeState = {
        snapshot: inspected.snapshot, eligibility: inspected.eligibility, owner: input.owner, runtime: input.runtime,
        mutationClaim: input.mutationClaim, ownerProof: owner, decisionBinding, metadata,
        artifactBytes: input.artifactBytes, trainerSnapshotSha256: input.trainerSnapshotSha256, used: false,
      }
      privateTextCleanupChallenges.set(challenge as object, challengeState)
      let challenges = privateTextCleanupChallengesByRun.get(run.run_id)
      if (!challenges) { challenges = new Set(); privateTextCleanupChallengesByRun.set(run.run_id, challenges) }
      challenges.add(challengeState)
      return Object.freeze({ challenge, decisionBinding, metadata })
    },
    retirePrivateTextCleanup(input) {
      const decision = consumeOperatorDecision(input.decision)
      const challenge = input.challenge && typeof input.challenge === "object" ? input.challenge as object : undefined
      const state = challenge ? privateTextCleanupChallenges.get(challenge) : undefined
      if (!state || state.used) fail("consent-required")
      state.used = true
      privateTextCleanupChallenges.delete(challenge!)
      removePrivateTextCleanupChallenge(state.metadata.runId, state)
      if (decision.action !== "approve") fail("operator-rejected")
      if (decision.sessionID !== state.decisionBinding.sessionID || decision.workflowID !== state.decisionBinding.workflowID ||
          decision.expectedRevision !== state.decisionBinding.expectedRevision ||
          !isDeepStrictEqual(decision.subject, state.decisionBinding.subject)) fail("consent-binding-drift")
      if (input.runtime !== state.runtime || input.owner !== state.owner || input.mutationClaim !== state.mutationClaim ||
          input.runtime !== runtime) fail("owner-unavailable")
      const verifyCurrent = (): OwnerProof => {
        if (input.runtime !== state.runtime || input.owner !== state.owner || input.mutationClaim !== state.mutationClaim) {
          fail("owner-unavailable")
        }
        const proof = verifyPrivateTextCleanupOwner(input.owner, input.runtime, input.mutationClaim)
        if (!isDeepStrictEqual(proof, state.ownerProof)) fail("owner-unavailable")
        return proof
      }
      verifyCurrent()
      const now = clock()
      const retirement = ledger.commitPrivateTextCleanup({
        expected: state.snapshot, expectedEligibility: state.eligibility,
        artifactsSha256: state.metadata.artifactsSha256, artifactBytes: state.artifactBytes, cleanupOwnerProof: state.ownerProof,
        retirementId: randomUUID(), decisionSubjectHash: state.decisionBinding.subject.sha256,
        clock: now, verifyCurrent,
      })
      revokePrivateTextCleanupCapabilities(retirement.runId)
      const deletionState = {
        worktree: root, runId: retirement.runId, runtime: state.runtime, owner: state.owner,
        mutationClaim: state.mutationClaim, ownerProof: state.ownerProof, ledger,
        retirementId: retirement.retirementId, revision: retirement.revision, runState: retirement.state,
        decisionSubjectHash: state.decisionBinding.subject.sha256,
      }
      const inputDeletion = mintPrivateTextCleanupDeletion({ ...deletionState, kind: "input",
        snapshotSha256: state.metadata.artifactsSha256 })
      const trainerDeletion = state.trainerSnapshotSha256 === null ? undefined
        : mintPrivateTextCleanupDeletion({ ...deletionState, kind: "trainer", snapshotSha256: state.trainerSnapshotSha256 })
      const retirementWithTokens = Object.defineProperties({ ...retirement }, {
        inputDeletion: { enumerable: false, value: inputDeletion },
        ...(trainerDeletion ? { trainerDeletion: { enumerable: false, value: trainerDeletion } } : {}),
      }) as SkillOptPrivateTextCleanupRetirement
      return Object.freeze(retirementWithTokens)
    },
    prepare(input) {
      if (!input || typeof input !== "object" || !CAMPAIGN_ID.test(input.campaignId)) fail("binding-invalid")
      const owner = ownerProof(runtime, root, input.owner)
      if (!input.dataset || !input.baselineSkillSha256) return Object.freeze({ state: "DATA_REQUIRED", reasonCode: "data-required" as const })
      const binding = currentBindings({ dataset: input.dataset, baselineSkillSha256: input.baselineSkillSha256 })
      const now = clock()
      const runId = randomUUID()
      const consentBindingSha256 = sha256(canonicalJson({
        runId, campaignHash: sha256(input.campaignId), binding: binding.hashes.bindingSha256,
        owner: owner.sessionHash, ownerEpoch: owner.epochHash, admission: owner.admissionHash,
        campaign: binding.campaign,
        purpose: NATIVE_WIKI_CONTRACT, limits: NATIVE_SKILLOPT_LIMITS,
      }))
      const runState: PreparedState = {
        runId, campaignId: input.campaignId, hashes: binding.hashes, consentBindingSha256, campaign: binding.campaign, owner: input.owner,
        ownerSessionHash: owner.sessionHash, ownerEpochHash: owner.epochHash, admissionHash: owner.admissionHash,
        createdBoot: now.boot, createdCont: now.continuous, createdWall: now.wall, revision: 1, decisionRevision: 1,
        dataset: binding.dataset, used: false, initialStartConsumed: false,
      }
      const subject: Subject = Object.freeze({ kind: "experiment-unit", id: runId, sha256: consentBindingSha256 })
      const decisionBinding: DecisionBinding = Object.freeze({ sessionID: input.owner.sessionID, workflowID: runId, expectedRevision: 1, subject })
      const prepared: SkillOptPrepared = Object.freeze({
        state: "PREPARED", runId, campaignId: input.campaignId, ...binding.campaign, bindingSha256: binding.hashes.bindingSha256,
        sourceExportSha256: binding.dataset.sourceExportSha256, fixturePackSha256: binding.dataset.fixturePackSha256,
        datasetSha256: binding.dataset.datasetSha256, modelBindingsSha256: binding.hashes.modelBindingsSha256,
        modelBindings: binding.dataset.modelBindings, protocolSha256: binding.dataset.protocolSha256,
        baselineSkillSha256: binding.hashes.baselineSkillSha256,
        consentBindingSha256, decisionBinding,
      })
      const fixtureBytes = Buffer.byteLength(canonicalJson(binding.dataset.fixturePack), "utf8")
      try {
        runState.revision = ledger.putPrepared({
          runId, campaignHash: sha256(input.campaignId), campaignId: input.campaignId,
          ownerSessionHash: owner.sessionHash, ownerEpochHash: owner.epochHash, ownerSessionId: input.owner.sessionID,
          ownerEpoch: input.owner.epoch,
          admissionHash: owner.admissionHash, bindingHash: binding.hashes.bindingSha256, datasetHash: binding.hashes.datasetSha256,
          dataHash: binding.hashes.dataSha256, modelHash: binding.hashes.modelBindingsSha256, protocolHash: binding.hashes.protocolSha256,
          baselineHash: binding.hashes.baselineSkillSha256, clock: now, expiresWall: now.wall + RUN_TTL_MS,
          expiresCont: now.continuous + RUN_TTL_MS * 1_000_000n, fixtureBytes,
        })
      } catch (error) {
        if (error instanceof SkillOptControllerError) throw error
        failSqlite(error)
      }
      preparedStates.set(prepared as object, runState)
      preparedStatesByRun.set(runId, runState)
      return prepared
    },
    prepareReentry(input) {
      if (!input || typeof input !== "object" || !UUID.test(input.runId) || !input.owner) fail("binding-invalid")
      const owner = ownerProof(runtime, root, input.owner)
      const lease = captureAdmissionLease(root, input.owner.sessionID)
      if (!lease || !isAdmissionLeaseCurrent(root, input.owner.sessionID, lease)) fail("admission-held")
      assertRuntimeIdle(runtime, input.owner)
      const now = clock()
      if (ledger.readStatus(now).status.reasonCode === "clock-uncertain") fail("clock-uncertain")
      const snapshot = ledger.readRunForReentry(input.runId)
      if (!snapshot) fail("run-stale")
      if (ledger.nativeTrainerProtocolEventCount(input.runId) > 0) fail("recovery-unresolved")
      const validated = validateReentrySnapshot(snapshot, now)
      const run = snapshot.run
      const sessionID = validated.sessionID
      const epoch = validated.epoch
      const campaignId = validated.campaignId
      const previous = inspectPreviousOwner(snapshot, input.owner)
      const previousHash = sha256(canonicalJson(previous))
      const binding = currentBindings(input.current)
      if (binding.hashes.bindingSha256 !== run.binding_hash || binding.hashes.datasetSha256 !== run.dataset_hash ||
          binding.hashes.dataSha256 !== run.data_hash || binding.hashes.modelBindingsSha256 !== run.model_hash ||
          binding.hashes.protocolSha256 !== run.protocol_hash || binding.hashes.baselineSkillSha256 !== run.baseline_hash) fail("binding-data-drift")
      if (validated.consent && validated.consent.schedule_hash !== binding.campaign.scheduleSha256) fail("consent-binding-drift")
      const fenceHash = sha256(admissionFence(root, input.owner.sessionID))
      if (fenceHash !== owner.admissionHash || !isAdmissionLeaseCurrent(root, input.owner.sessionID, lease)) fail("admission-held")
      const consentRow = validated.consent
      const armRow = validated.arm
      const expiresBoot = consentRow ? consentRow.expires_boot : now.boot
      const expiresCont = consentRow
        ? BigInt(consentRow.expires_cont)
        : [now.continuous + CONSENT_TTL_MS * 1_000_000n, BigInt(run.expires_cont)].reduce((a, b) => a < b ? a : b)
      const expiresWall = consentRow
        ? BigInt(consentRow.expires_wall)
        : [now.wall + CONSENT_TTL_MS, BigInt(run.expires_wall)].reduce((a, b) => a < b ? a : b)
      const priorArm = armRow ? {
        armId: armRow.arm_id, consentId: armRow.consent_id, watermarkHash: armRow.watermark_hash,
        seenDigestHashes: armRow.seen_digest_hashes, armedBoot: armRow.armed_boot,
        armedCont: armRow.armed_cont, armedWall: armRow.armed_wall, expiresBoot: armRow.expires_boot,
        expiresCont: armRow.expires_cont, expiresWall: armRow.expires_wall,
      } : undefined
      const oldConsent = consentRow ? {
        consentId: consentRow.consent_id, subjectHash: consentRow.subject_hash,
        scheduleSha256: consentRow.schedule_hash,
        expiresBoot: consentRow.expires_boot, expiresCont: consentRow.expires_cont, expiresWall: consentRow.expires_wall,
      } : undefined
      const challengeNonce = randomUUID()
      const consentBindingSha256 = sha256(canonicalJson({
        schema: "skillopt.reentry.v1", action: "skillopt-reenter", challengeNonce, rootBinding: authority.rootBinding,
        quotaKey: authority.quotaKey, target: PILOT_SKILL, runId: input.runId, campaignId,
        campaignHash: run.campaign_hash, persistedState: validated.state, expectedRevision: run.revision,
        oldOwner: { sessionID, epoch, sessionHash: run.owner_session_hash, epochHash: run.owner_epoch_hash, admissionHash: run.admission_hash },
        oldAttachmentSha256: previousHash,
        oldConsent: oldConsent ?? null, oldArm: priorArm ? { ...priorArm, seenDigestHashesSha256: sha256(priorArm.seenDigestHashes) } : null,
        newOwner: { sessionID: input.owner.sessionID, epoch: input.owner.epoch, ...owner },
        admissionFenceSha256: fenceHash, binding: binding.hashes, campaign: binding.campaign, modelBindings: binding.dataset.modelBindings,
        budget: NATIVE_SKILLOPT_LIMITS, runExpiry: { boot: run.expires_boot, continuous: run.expires_cont, wall: run.expires_wall },
        consentExpiry: { boot: expiresBoot, continuous: expiresCont.toString(), wall: expiresWall.toString() },
        bootFence: { lastAttemptId: snapshot.quota.last_attempt_id, lastAttemptBoot: snapshot.quota.last_attempt_boot,
          lastAttemptContinuous: snapshot.quota.last_attempt_cont, fenceBoot: snapshot.quota.fence_boot,
          fenceContinuous: snapshot.quota.fence_cont, quotaRevision: snapshot.quota.revision },
      }))
      const subject: Subject = Object.freeze({ kind: "experiment-unit", id: input.runId, sha256: consentBindingSha256 })
      const decisionBinding: DecisionBinding = Object.freeze({ sessionID: input.owner.sessionID, workflowID: input.runId,
        expectedRevision: run.revision, subject })
      const challenge = Object.freeze({ runId: input.runId, persistedState: validated.state,
        expectedRevision: run.revision, ...binding.campaign, decisionBinding }) as SkillOptReentryChallenge
      const reentryState: ReentryState = {
        snapshot, owner: input.owner, ownerProof: owner, lease, admissionFenceHash: fenceHash, binding,
        priorAttachment: previous, priorAttachmentHash: previousHash, state: validated.state,
        revision: run.revision, campaignId, expiresBoot, expiresCont, expiresWall,
        ...(oldConsent ? { expectedConsentId: oldConsent.consentId } : {}), ...(priorArm ? { expectedArm: priorArm } : {}),
        decisionBinding, used: false,
      }
      reentryStates.set(challenge as object, reentryState)
      return challenge
    },
    acceptReentry(challenge, receipt, current) {
      // A genuine terminal receipt and the process-local challenge are both one-use, even on drift failures.
      const decision = consumeOperatorDecision(receipt)
      const state = challenge && typeof challenge === "object" ? reentryStates.get(challenge as object) : undefined
      if (!state || state.used) fail("consent-required")
      state.used = true
      reentryStates.delete(challenge as object)
      if (decision.action !== "approve") fail("operator-rejected")
      if (decision.sessionID !== state.decisionBinding.sessionID || decision.workflowID !== state.decisionBinding.workflowID ||
          decision.expectedRevision !== state.decisionBinding.expectedRevision || decision.subject.kind !== state.decisionBinding.subject.kind ||
          decision.subject.id !== state.decisionBinding.subject.id || decision.subject.sha256 !== state.decisionBinding.subject.sha256 ||
          !isDeepStrictEqual(challenge.decisionBinding, state.decisionBinding) || challenge.runId !== state.decisionBinding.workflowID ||
          challenge.persistedState !== state.state || challenge.expectedRevision !== state.revision ||
          challenge.scheduleSha256 !== state.binding.campaign.scheduleSha256 || challenge.targetRequests !== state.binding.campaign.targetRequests ||
          challenge.canaryReserve !== state.binding.campaign.canaryReserve || challenge.targetRequestCap !== state.binding.campaign.targetRequestCap) {
        fail("consent-binding-drift")
      }
      const freshBinding = currentBindings(current)
      if (!isDeepStrictEqual(freshBinding.hashes, state.binding.hashes) ||
          !isDeepStrictEqual(freshBinding.dataset.modelBindings, state.binding.dataset.modelBindings) ||
          !isDeepStrictEqual(freshBinding.campaign, state.binding.campaign)) fail("consent-binding-drift")
      let reentryClaim: ExecutionClaim | undefined
      const verifyOwner = (): void => {
        verifyReentryOwner(state, reentryClaim)
        const observed = inspectPreviousOwner(state.snapshot, state.owner)
        if (!isDeepStrictEqual(observed, state.priorAttachment) || sha256(canonicalJson(observed)) !== state.priorAttachmentHash) fail("owner-unavailable")
        const bindingNow = currentBindings(current)
        if (!isDeepStrictEqual(bindingNow.hashes, state.binding.hashes) ||
            !isDeepStrictEqual(bindingNow.dataset.modelBindings, state.binding.dataset.modelBindings) ||
            !isDeepStrictEqual(bindingNow.campaign, state.binding.campaign)) fail("consent-binding-drift")
        if (!isAdmissionLeaseCurrent(root, state.owner.sessionID, state.lease) ||
            sha256(admissionFence(root, state.owner.sessionID)) !== state.admissionFenceHash) fail("admission-held")
      }
      verifyOwner()
      const commitClock = clock()
      if (commitClock.boot !== state.expiresBoot || commitClock.continuous > state.expiresCont || commitClock.wall > state.expiresWall) fail("consent-expired")
      const consentId = randomUUID()
      let committedRevision: number
      let resumed: StoredReentrySnapshot
      try {
        try { reentryClaim = runtime.runs.claim(state.owner.sessionID, `skillopt-reentry-${randomUUID()}`, process.pid) }
        catch (error) {
          if (error instanceof ExecutionRunUnresolvedError) fail("owner-busy")
          throw error
        }
        verifyOwner()
        committedRevision = ledger.commitReentry({
          expected: state.snapshot, expectedRevision: state.revision, expectedState: state.state,
          expectedOwner: {
            sessionHash: String(state.snapshot.run.owner_session_hash), epochHash: String(state.snapshot.run.owner_epoch_hash),
            admissionHash: String(state.snapshot.run.admission_hash), sessionID: String(state.snapshot.run.owner_session_id),
            epoch: String(state.snapshot.run.owner_epoch), campaignId: state.campaignId,
          },
          ...(state.expectedConsentId ? { expectedConsentId: state.expectedConsentId } : {}),
          ...(state.expectedArm ? { expectedArm: state.expectedArm } : {}),
          consentId, subjectHash: state.decisionBinding.subject.sha256,
          scheduleSha256: state.binding.campaign.scheduleSha256,
          newOwner: { ...state.ownerProof, sessionID: state.owner.sessionID, epoch: state.owner.epoch },
          clock: commitClock, expiresBoot: state.expiresBoot, expiresCont: state.expiresCont, expiresWall: state.expiresWall,
          verifyOwner,
        })
        verifyOwner()
        const saved = ledger.readRunForReentry(state.snapshot.run.run_id)
        if (!saved || saved.run.revision !== committedRevision || saved.run.state !== (state.state === "PREPARED" ? "CONSENTED" : state.state) ||
            saved.run.owner_session_hash !== state.ownerProof.sessionHash || saved.run.owner_epoch_hash !== state.ownerProof.epochHash ||
            !saved.consent || saved.consent.subject_hash !== state.decisionBinding.subject.sha256 ||
            saved.consent.schedule_hash !== state.binding.campaign.scheduleSha256 ||
            saved.attemptCount !== 0 || saved.requestCount !== 0 || saved.quota.pending_request_id || saved.quota.active_run_id) fail("revision-conflict")
        resumed = saved
      } finally {
        if (reentryClaim) runtime.runs.release(reentryClaim)
      }
      const run = resumed.run
      const binding = currentBindings(current)
      if (!isDeepStrictEqual(binding.campaign, state.binding.campaign)) fail("consent-binding-drift")
      const preparedState: PreparedState = {
        runId: run.run_id, campaignId: state.campaignId, hashes: binding.hashes,
        campaign: binding.campaign,
        consentBindingSha256: state.decisionBinding.subject.sha256, owner: state.owner,
        ownerSessionHash: state.ownerProof.sessionHash, ownerEpochHash: state.ownerProof.epochHash,
        admissionHash: state.ownerProof.admissionHash, createdBoot: run.created_boot,
        createdCont: BigInt(run.created_cont), createdWall: BigInt(run.created_wall),
        revision: committedRevision, decisionRevision: state.decisionBinding.expectedRevision,
        dataset: binding.dataset, used: true, initialStartConsumed: false,
      }
      const prepared = Object.freeze({
        state: "PREPARED" as const, runId: preparedState.runId, campaignId: preparedState.campaignId, ...preparedState.campaign,
        bindingSha256: binding.hashes.bindingSha256, sourceExportSha256: binding.dataset.sourceExportSha256,
        fixturePackSha256: binding.dataset.fixturePackSha256, datasetSha256: binding.dataset.datasetSha256,
        modelBindingsSha256: binding.hashes.modelBindingsSha256, modelBindings: binding.dataset.modelBindings,
        protocolSha256: binding.dataset.protocolSha256, baselineSkillSha256: binding.hashes.baselineSkillSha256,
        consentBindingSha256: preparedState.consentBindingSha256, decisionBinding: state.decisionBinding,
      })
      preparedStates.set(prepared as object, preparedState)
      if (state.state !== "ARMED") preparedStatesByRun.set(preparedState.runId, preparedState)
      const consentState: ConsentState = {
        runId: preparedState.runId, consentId, subjectHash: preparedState.consentBindingSha256,
        campaign: preparedState.campaign,
        bindingHash: preparedState.hashes.bindingSha256, owner: state.owner, ownerSessionHash: state.ownerProof.sessionHash,
        ownerEpochHash: state.ownerProof.epochHash, admissionHash: state.ownerProof.admissionHash,
        expiresBoot: state.expiresBoot, expiresCont: state.expiresCont, expiresWall: state.expiresWall,
        used: state.state === "ARMED",
      }
      const consent = Object.freeze({ state: "CONSENTED" as const, runId: consentState.runId, consentId,
        ...consentState.campaign, subjectSha256: consentState.subjectHash, expiresAtMilliseconds: consentState.expiresWall.toString() })
      consentStates.set(consent as object, consentState)
      consentByRun.set(consentState.runId, consentState)
      if (state.state !== "ARMED") return Object.freeze({ state: "CONSENTED" as const, revision: committedRevision, prepared, consent })
      const armRow = resumed.arm
      if (!armRow || armRow.state !== "armed" || armRow.arm_id !== state.expectedArm?.armId ||
          armRow.watermark_hash !== state.expectedArm?.watermarkHash) fail("revision-conflict")
      const seen = parseSeenDigestHashes(armRow.seen_digest_hashes)
      const armState: ArmState = {
        runId: preparedState.runId, armId: armRow.arm_id, consentId, bindingHash: preparedState.hashes.bindingSha256,
        preparedState,
        owner: state.owner, ownerSessionHash: state.ownerProof.sessionHash, ownerEpochHash: state.ownerProof.epochHash,
        admissionHash: state.ownerProof.admissionHash, expiresBoot: armRow.expires_boot,
        expiresCont: BigInt(armRow.expires_cont), expiresWall: BigInt(armRow.expires_wall),
        seenDigestHashes: new Set(seen), armedAtWall: BigInt(armRow.armed_wall), used: false,
      }
      const arm = Object.freeze({ state: "ARMED" as const, runId: preparedState.runId, armId: armState.armId,
        digestWatermarkSha256: armRow.watermark_hash, expiresAtMilliseconds: armState.expiresWall.toString() })
      armStates.set(arm as object, armState)
      armStatesByRun.set(preparedState.runId, armState)
      return Object.freeze({ state: "ARMED" as const, revision: committedRevision, prepared, consent, arm })
    },
    consent(prepared, receipt, current) {
      // Consume before checking any other binding so a rejected real receipt can never be replayed.
      const decision = consumeOperatorDecision(receipt)
      const state = prepared && typeof prepared === "object" ? preparedStates.get(prepared as object) : undefined
      if (!state || state.used) fail("consent-required")
      state.used = true
      const owner = ownerCurrent(state)
      requireFreshBinding(state, current)
      assertConsentDecision(decision, state, prepared)
      const now = clock()
      if (now.boot !== state.createdBoot || now.wall > state.createdWall + RUN_TTL_MS) fail("run-expired")
      const expiresCont = now.continuous + CONSENT_TTL_MS * 1_000_000n
      const expiresWall = now.wall + CONSENT_TTL_MS
      const consentId = randomUUID()
      const consentState: ConsentState = { runId: state.runId, consentId, subjectHash: prepared.consentBindingSha256,
        campaign: state.campaign,
        bindingHash: state.hashes.bindingSha256, owner: state.owner, ownerSessionHash: owner.sessionHash,
        ownerEpochHash: owner.epochHash, admissionHash: owner.admissionHash, expiresBoot: now.boot,
        expiresCont, expiresWall, used: false }
      if (decision.action !== "approve") {
        fail("operator-rejected")
      }
      state.revision = ledger.putConsent({ runId: state.runId, consentId, subjectHash: prepared.consentBindingSha256,
        expectedRevision: state.revision,
        scheduleSha256: state.campaign.scheduleSha256, bindingHash: state.hashes.bindingSha256,
        ownerSessionHash: owner.sessionHash, ownerEpochHash: owner.epochHash,
        admissionHash: owner.admissionHash, clock: now, expiresCont, expiresWall })
      const consent: SkillOptConsent = Object.freeze({ state: "CONSENTED", runId: state.runId, consentId,
        ...state.campaign, subjectSha256: prepared.consentBindingSha256, expiresAtMilliseconds: expiresWall.toString() })
      consentStates.set(consent as object, consentState)
      consentByRun.set(state.runId, consentState)
      return consent
    },
    arm(prepared, consent, current) {
      const preparedState = prepared && typeof prepared === "object" ? preparedStates.get(prepared as object) : undefined
      const consentState = consent && typeof consent === "object" ? consentStates.get(consent as object) : undefined
      if (!preparedState || !consentState || consentState.used || preparedState.initialStartConsumed ||
          preparedState.runId !== consentState.runId || prepared.runId !== consent.runId ||
          !isDeepStrictEqual(preparedState.campaign, consentState.campaign) ||
          !campaignPreviewMatches(prepared, preparedState.campaign) || !campaignPreviewMatches(consent, consentState.campaign)) fail("consent-required")
      const owner = ownerCurrent(consentState)
      requireFreshBinding(preparedState, current)
      const now = clock()
      assertConsentLive(consentState, now)
      const snapshot = eligibleSkillOptDigests(readSessionDigests(root))
      const seenDigestHashes = snapshot.digests.map((digest) => digest.sessionIDHash)
      const armId = randomUUID()
      preparedState.revision = ledger.putArm({ runId: preparedState.runId, consentId: consentState.consentId, armId,
        watermarkHash: snapshot.watermarkSha256, seenDigestHashes, clock: now,
        expiresCont: consentState.expiresCont, expiresWall: consentState.expiresWall })
      consentState.used = true
      preparedStatesByRun.delete(preparedState.runId)
      const armState: ArmState = { runId: preparedState.runId, armId, consentId: consentState.consentId,
        preparedState,
        bindingHash: preparedState.hashes.bindingSha256, owner: consentState.owner, ownerSessionHash: owner.sessionHash,
        ownerEpochHash: owner.epochHash, admissionHash: owner.admissionHash, expiresBoot: consentState.expiresBoot,
        expiresCont: consentState.expiresCont, expiresWall: consentState.expiresWall, seenDigestHashes: new Set(seenDigestHashes),
        armedAtWall: now.wall, used: false }
      const arm: SkillOptArm = Object.freeze({ state: "ARMED", runId: preparedState.runId, armId,
        digestWatermarkSha256: snapshot.watermarkSha256, expiresAtMilliseconds: consentState.expiresWall.toString() })
      armStates.set(arm as object, armState)
      armStatesByRun.set(preparedState.runId, armState)
      return arm
    },
    disarm(owner, runId) {
      const initial = ownerProof(runtime, root, owner)
      let claim: ExecutionClaim | undefined
      try {
        try { claim = runtime.runs.claim(owner.sessionID, `skillopt-disarm-${randomUUID()}`, process.pid) }
        catch (error) {
          if (error instanceof ExecutionRunUnresolvedError) fail("owner-busy")
          throw error
        }
        const verifyOwner = (): void => {
          const current = ownerProof(runtime, root, owner)
          if (current.sessionHash !== initial.sessionHash || current.epochHash !== initial.epochHash ||
              current.admissionHash !== initial.admissionHash) fail("owner-unavailable")
          assertRuntimeIdle(runtime, owner, claim)
        }
        verifyOwner()
        const persisted = ledger.readStatus()
        const run = persisted.run
        if (!run || run.run_id !== runId || typeof run.revision !== "number" || !Number.isSafeInteger(run.revision)) fail("run-stale")
        ledger.revokeArm({ runId, expectedRevision: run.revision,
          ownerSessionHash: initial.sessionHash, ownerEpochHash: initial.epochHash,
          admissionHash: initial.admissionHash, verifyOwner })
        const armState = armStatesByRun.get(runId)
        if (armState) {
          armState.used = true
          armStatesByRun.delete(runId)
        }
        const consentState = consentByRun.get(runId)
        if (consentState) consentState.used = true
        consentByRun.delete(runId)
        canaryPreparationsByRun.delete(runId)
        return this.status()
      } finally {
        if (claim) {
          try { runtime.runs.release(claim) } catch { fail("owner-busy") }
        }
      }
    },
    cancelUnstarted(owner, runId) {
      const initial = ownerProof(runtime, root, owner)
      let claim: ExecutionClaim | undefined
      try {
        try { claim = runtime.runs.claim(owner.sessionID, `skillopt-cancel-${randomUUID()}`, process.pid) }
        catch (error) {
          if (error instanceof ExecutionRunUnresolvedError) fail("owner-busy")
          throw error
        }
        const verifyOwner = (): void => {
          const current = ownerProof(runtime, root, owner)
          if (current.sessionHash !== initial.sessionHash || current.epochHash !== initial.epochHash ||
              current.admissionHash !== initial.admissionHash) fail("owner-unavailable")
          assertRuntimeIdle(runtime, owner, claim)
        }
        verifyOwner()
        const status = ledger.readStatus()
        const run = status.run
        if (!run || run.run_id !== runId || typeof run.revision !== "number" || !Number.isSafeInteger(run.revision)) fail("run-stale")
        ledger.cancelUnstarted({ runId, expectedRevision: run.revision,
          ownerSessionHash: initial.sessionHash, ownerEpochHash: initial.epochHash,
          admissionHash: initial.admissionHash, verifyOwner })
        const preparedState = preparedStatesByRun.get(runId)
        if (preparedState) {
          preparedState.used = true
          preparedState.initialStartConsumed = true
          preparedStatesByRun.delete(runId)
        }
        const consentState = consentByRun.get(runId)
        if (consentState) consentState.used = true
        consentByRun.delete(runId)
        canaryPreparationsByRun.delete(runId)
        return this.status()
      } finally {
        if (claim) {
          try { runtime.runs.release(claim) } catch { fail("owner-busy") }
        }
      }
    },
    automaticReadiness(input) {
      return automaticEligibility(input)
    },
    reserveAutomatic(input) {
      const readiness = automaticEligibility(input)
      if (readiness.state !== "READY") fail(readiness.reasonCode ?? "arm-required")
      const preparedState = input.prepared && typeof input.prepared === "object" ? preparedStates.get(input.prepared as object) : undefined
      const consentState = input.consent && typeof input.consent === "object" ? consentStates.get(input.consent as object) : undefined
      const armState = input.arm && typeof input.arm === "object" ? armStates.get(input.arm as object) : undefined
      if (!preparedState || !consentState || !armState || preparedState.runId !== consentState.runId ||
          preparedState.runId !== armState.runId || input.prepared.runId !== input.consent.runId || input.prepared.runId !== input.arm.runId ||
          armState.used || preparedState.initialStartConsumed || !isDeepStrictEqual(preparedState.campaign, consentState.campaign) ||
          !campaignPreviewMatches(input.prepared, preparedState.campaign) || !campaignPreviewMatches(input.consent, consentState.campaign)) fail("arm-required")
      const owner = ownerCurrent({ ...armState, owner: input.owner })
      if (owner.sessionHash !== armState.ownerSessionHash || owner.epochHash !== armState.ownerEpochHash || owner.admissionHash !== armState.admissionHash) fail("owner-unavailable")
      assertRuntimeIdle(runtime, input.owner)
      requireFreshBinding(preparedState, input.current)
      const now = clock()
      assertConsentLive(consentState, now)
      if (now.boot !== armState.expiresBoot || now.continuous > armState.expiresCont || now.wall > armState.expiresWall) fail("arm-expired")
      const latest = eligibleSkillOptDigests(readSessionDigests(root))
      const fresh = newDigestsSinceArm(latest, armState.seenDigestHashes, armState.armedAtWall)
      if (fresh.length < MIN_NEW_DIGESTS) fail("digest-threshold")
      const beforeCommitOwner = ownerCurrent({ ...armState, owner: input.owner })
      if (beforeCommitOwner.admissionHash !== owner.admissionHash || beforeCommitOwner.epochHash !== owner.epochHash) fail("owner-unavailable")
      assertRuntimeIdle(runtime, input.owner)
      requireFreshBinding(preparedState, input.current)
      const commitClock = clock()
      assertConsentLive(consentState, commitClock)
      const stored = ledger.reserveAutomatic({ runId: armState.runId, consentId: consentState.consentId, armId: armState.armId,
        ownerSessionHash: owner.sessionHash, ownerEpochHash: owner.epochHash, admissionHash: owner.admissionHash,
        bindingHash: armState.bindingHash, newDigestHashes: fresh.map((digest) => digest.sessionIDHash),
        expectedRevision: preparedState.revision, clock: commitClock, role: "target", phase: "train" })
      // The actual capability is minted only after the all-or-nothing transaction returned from COMMIT.
      const pair = mintDispatch(stored.reservationId, stored.requestId, armState.runId, "target", "train", armState.bindingHash,
        owner, ticketStates, receiptStates, input.owner, consentState, commitClock)
      armState.used = true
      consentState.used = true
      preparedState.initialStartConsumed = true
      preparedStatesByRun.delete(preparedState.runId)
      armStatesByRun.delete(preparedState.runId)
      const reservation = Object.freeze({ runId: armState.runId, reservationId: stored.reservationId, requestId: stored.requestId,
        bindingSha256: armState.bindingHash, scheduleSha256: consentState.campaign.scheduleSha256,
        role: "target" as const, phase: "train" as const, charged: true as const,
        ticket: pair.ticket, receipt: pair.receipt })
      nativeTrainerProtocolReservations.set(reservation as object, { controllerIdentity, requestId: stored.requestId,
        reservationId: stored.reservationId, runId: armState.runId, role: "target", phase: "train" })
      return reservation
    },
    reserveManual(input) {
      const preparedState = input.prepared && typeof input.prepared === "object" ? preparedStates.get(input.prepared as object) : undefined
      const consentState = input.consent && typeof input.consent === "object" ? consentStates.get(input.consent as object) : undefined
      if (!preparedState || !consentState || consentState.used || preparedState.initialStartConsumed ||
          preparedState.runId !== consentState.runId || input.prepared.runId !== input.consent.runId || consentState.owner !== input.owner ||
          !isDeepStrictEqual(preparedState.campaign, consentState.campaign) ||
          !campaignPreviewMatches(input.prepared, preparedState.campaign) || !campaignPreviewMatches(input.consent, consentState.campaign)) {
        fail("consent-required")
      }
      const owner = ownerCurrent(consentState)
      if (owner.sessionHash !== consentState.ownerSessionHash || owner.epochHash !== consentState.ownerEpochHash ||
          owner.admissionHash !== consentState.admissionHash) fail("owner-unavailable")
      assertRuntimeIdle(runtime, input.owner)
      requireFreshBinding(preparedState, input.current)
      const now = clock()
      assertConsentLive(consentState, now)
      const beforeCommitOwner = ownerCurrent(consentState)
      if (beforeCommitOwner.sessionHash !== owner.sessionHash || beforeCommitOwner.epochHash !== owner.epochHash ||
          beforeCommitOwner.admissionHash !== owner.admissionHash) fail("owner-unavailable")
      assertRuntimeIdle(runtime, input.owner)
      requireFreshBinding(preparedState, input.current)
      const commitBinding = currentBindings(input.current)
      if (commitBinding.hashes.bindingSha256 !== preparedState.hashes.bindingSha256 ||
          commitBinding.campaign.scheduleSha256 !== consentState.campaign.scheduleSha256) fail("consent-binding-drift")
      const commitClock = clock()
      assertConsentLive(consentState, commitClock)
      // Burn the scoped start permission before the atomic write; an uncertain failure cannot be retried.
      preparedState.initialStartConsumed = true
      consentState.used = true
      preparedStatesByRun.delete(preparedState.runId)
      const stored = ledger.reserveManual({ runId: preparedState.runId, consentId: consentState.consentId,
        ownerSessionHash: owner.sessionHash, ownerEpochHash: owner.epochHash, admissionHash: owner.admissionHash,
        bindingHash: commitBinding.hashes.bindingSha256, expectedRevision: preparedState.revision,
        clock: commitClock, role: "target", phase: "train" })
      const pair = mintDispatch(stored.reservationId, stored.requestId, preparedState.runId, "target", "train",
        preparedState.hashes.bindingSha256, owner, ticketStates, receiptStates, input.owner, consentState, commitClock)
      const reservation = Object.freeze({ runId: preparedState.runId, reservationId: stored.reservationId, requestId: stored.requestId,
        bindingSha256: preparedState.hashes.bindingSha256, scheduleSha256: consentState.campaign.scheduleSha256,
        role: "target" as const, phase: "train" as const,
        charged: true as const, ticket: pair.ticket, receipt: pair.receipt })
      nativeTrainerProtocolReservations.set(reservation as object, { controllerIdentity, requestId: stored.requestId,
        reservationId: stored.reservationId, runId: preparedState.runId, role: "target", phase: "train" })
      return reservation
    },
    reserveRequest(input) {
      if (input.phase === "canary") fail("dispatch-not-authorized")
      if (input.trainerEvent) {
        const eventState = nativeTrainerProtocolEventState(input.trainerEvent)
        const expectedRole = eventState.request.kind === "optimizer" ? "optimizer" : "target"
        const expectedPhase = eventState.request.kind === "optimizer" || eventState.request.cohort === "training" ? "train" : "dev"
        if (eventState.request.kind === "rollout" && eventState.request.cohort !== "training" ||
            input.role !== expectedRole || input.phase !== expectedPhase || eventState.request.runId !== input.runId) {
          fail("dispatch-not-authorized")
        }
        return reserveTrainerProtocolRequest({ owner: input.owner, runtime, prepared: eventState.capture.prepared,
          current: input.current }, eventState, false)
      }
      const run = ledger.readStatus().run
      if (!run || run.run_id !== input.runId) fail("run-stale")
      const owner = ownerProof(runtime, root, input.owner)
      if (owner.sessionHash !== run.owner_session_hash || owner.epochHash !== run.owner_epoch_hash || owner.admissionHash !== run.admission_hash) fail("owner-unavailable")
      assertRuntimeIdle(runtime, input.owner)
      const binding = currentBindings(input.current)
      if (binding.hashes.bindingSha256 !== run.binding_hash) fail("consent-binding-drift")
      const now = clock()
      const consent = consentByRun.get(input.runId)
      if (!consent) fail("consent-required")
      if (binding.campaign.scheduleSha256 !== consent.campaign.scheduleSha256) fail("consent-binding-drift")
      assertConsentLive(consent, now)
      const beforeCommitOwner = ownerProof(runtime, root, input.owner)
      if (beforeCommitOwner.sessionHash !== owner.sessionHash || beforeCommitOwner.epochHash !== owner.epochHash ||
          beforeCommitOwner.admissionHash !== owner.admissionHash) fail("owner-unavailable")
      const commitBinding = currentBindings(input.current)
      if (commitBinding.hashes.bindingSha256 !== binding.hashes.bindingSha256 ||
          commitBinding.campaign.scheduleSha256 !== consent.campaign.scheduleSha256) fail("consent-binding-drift")
      const commitClock = clock()
      assertConsentLive(consent, commitClock)
      const stored = ledger.reserveRequest({ runId: input.runId, consentId: consent.consentId, ownerSessionHash: owner.sessionHash,
        ownerEpochHash: owner.epochHash, admissionHash: owner.admissionHash, bindingHash: commitBinding.hashes.bindingSha256,
        role: input.role, phase: input.phase, clock: commitClock })
      const pair = mintDispatch(stored.reservationId, stored.requestId, input.runId, input.role, input.phase,
        commitBinding.hashes.bindingSha256, owner, ticketStates, receiptStates, input.owner, consent, commitClock)
      const reservation = Object.freeze({ runId: input.runId, reservationId: stored.reservationId, requestId: stored.requestId,
        bindingSha256: commitBinding.hashes.bindingSha256, scheduleSha256: consent.campaign.scheduleSha256,
        role: input.role, phase: input.phase,
        charged: true as const, ticket: pair.ticket, receipt: pair.receipt })
      nativeTrainerProtocolReservations.set(reservation as object, { controllerIdentity, requestId: stored.requestId,
        reservationId: stored.reservationId, runId: input.runId, role: input.role, phase: input.phase })
      return reservation
    },
    consumeDispatch(owner, ticket, current) {
      const state = ticket && typeof ticket === "object" ? ticketStates.get(ticket as object) : undefined
      if (!state || state.consumed || state.owner !== owner) fail("dispatch-not-authorized")
      // Once consumed, the ticket can never be retried, including after a drift check fails.
      state.consumed = true
      state.receiptState.ticketConsumed = true
      ownerCurrent({
        owner,
        ownerSessionHash: state.ownerProof.sessionHash,
        ownerEpochHash: state.ownerProof.epochHash,
        admissionHash: state.ownerProof.admissionHash,
      })
      assertRuntimeIdle(runtime, owner)
      const binding = currentBindings(current)
      if (binding.hashes.bindingSha256 !== state.bindingSha256 || binding.campaign.scheduleSha256 !== state.scheduleSha256) fail("consent-binding-drift")
      if (state.consent) assertConsentLive(state.consent, clock())
      // Consumption is process-local and irrevocable. The DB slot was charged at reserve time;
      // a crash after this point is therefore conservatively reconciled, never retried.
      state.receiptState.owner = owner
      state.grantIssued = true
      return Object.freeze({ runId: state.runId, reservationId: state.reservationId, requestId: state.requestId,
        role: state.role, phase: state.phase, bindingSha256: state.bindingSha256,
        timeoutMilliseconds: NATIVE_SKILLOPT_LIMITS.requestMilliseconds })
    },
    recordDispatch(owner, receipt, observation) {
      const state = receipt && typeof receipt === "object" ? receiptStates.get(receipt as object) : undefined
      if (!state || state.recorded || state.owner !== owner) fail("dispatch-not-authorized")
      const ticketState = state.ticketState
      if (!state.ticketConsumed || ticketState.receiptState !== state) fail("dispatch-not-authorized")
      if (observation.state === "not-dispatched" && ticketState.grantIssued) {
        assertNoPersistedHostDispatch(runtime, owner, state.requestId)
      }
      if ((observation.state === "launched" || observation.state === "ambiguous") && !ticketState.grantIssued) fail("dispatch-not-authorized")
      const ownerStatus = ownerProof(runtime, root, owner, true)
      if (ownerStatus.sessionHash !== state.ownerProof.sessionHash || ownerStatus.epochHash !== state.ownerProof.epochHash) fail("owner-unavailable")
      if (observation.state !== "not-dispatched" && observation.reference) {
        assertPersistedExecutionReference(runtime, nativeHost, owner, observation.reference, "dispatch-ambiguous")
      }
      const now = clock()
      ledger.recordDispatch({ requestId: state.requestId, reservationId: state.reservationId, runId: state.runId,
        ownerSessionHash: state.ownerProof.sessionHash, ownerEpochHash: state.ownerProof.epochHash,
        ownerAdmissionHash: state.ownerProof.admissionHash, observation, clock: now })
      state.recorded = true
      ticketState.recorded = true
      return this.status()
    },
    async recover(owner, runId) {
      const ownerNow = ownerProof(runtime, root, owner, true)
      let persisted = ledger.readStatus()
      const run = persisted.run
      let pending = persisted.pending
      if (!run || run.run_id !== runId || run.owner_session_hash !== ownerNow.sessionHash ||
          run.owner_epoch_hash !== ownerNow.epochHash || run.admission_hash !== ownerNow.admissionHash) fail("owner-unavailable")
      if (!pending) {
        if (persisted.activeRunId !== runId) fail("recovery-unresolved")
        if (run.state === "AWAITING_CANDIDATE_APPROVAL") return this.status()
        if (run.state !== "RUNNING") fail("recovery-unresolved")
        if (ledger.nativeTrainerProtocolEventCount(runId) > 0 && !nativeTrainerProtocolCaptureLive(runId)) {
          ledger.markTrainerProtocolRecoveryUnresolved({ runId, owner: ownerNow, requirePersistedEvents: true })
          const consent = consentByRun.get(runId)
          if (consent) consent.used = true
          consentByRun.delete(runId)
          return this.status()
        }
        restoreConsentForRun(run, owner, ownerNow)
        return this.status()
      }
      if (run.state === "AWAITING_CANDIDATE_APPROVAL") fail("recovery-unresolved")
      if (pending.run_id !== runId) fail("recovery-unresolved")
      if (pending.dispatch_state === "possible") {
        let ownedReference: ExecutionReference | undefined
        try {
          const active = runtime.runs.status().executions.find((record) => record.executionId === pending!.request_id &&
            record.ownerSession === owner.sessionID && record.kind === "host" && record.nativeExecution === true &&
            record.hostDispatch === "started")
          const reference = active?.boundaryRef
          if (reference && "executionID" in reference && reference.executionID === pending.request_id) {
            validateExecutionReference(reference as ExecutionReference, String(pending.request_id))
          assertPersistedExecutionReference(runtime, nativeHost, owner, reference as ExecutionReference, "recovery-unresolved")
            ownedReference = reference as ExecutionReference
          }
        } catch { fail("recovery-unresolved") }
        if (!ownedReference) fail("recovery-unresolved")
        ledger.attachRecoveryReference(runId, String(pending.request_id), ownedReference)
        persisted = ledger.readStatus()
        pending = persisted.pending
      }
      if (!pending || pending.run_id !== runId || pending.dispatch_state !== "launched" && pending.dispatch_state !== "unknown") {
        fail("recovery-unresolved")
      }
      let reference: ExecutionReference
      try {
        const parsed: unknown = JSON.parse(String(pending.reference_json ?? ""))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("recovery-unresolved")
        reference = parsed as ExecutionReference
        validateExecutionReference(reference, String(pending.request_id))
      } catch { fail("recovery-unresolved") }
      assertPersistedExecutionReference(runtime, nativeHost, owner, reference, "recovery-unresolved")
      let reconciliation: ExecutionReconciliation
      try { reconciliation = await nativeHost.reconcile(reference) } catch { fail("recovery-unresolved") }
      const ownerAfterReconcile = ownerProof(runtime, root, owner, true)
      if (ownerAfterReconcile.sessionHash !== ownerNow.sessionHash || ownerAfterReconcile.epochHash !== ownerNow.epochHash ||
          ownerAfterReconcile.admissionHash !== ownerNow.admissionHash) fail("owner-unavailable")
      assertPersistedExecutionReference(runtime, nativeHost, owner, reference, "recovery-unresolved")
      if (!validReconciliation(reconciliation) || reconciliation.outcome !== "terminal" || !reconciliation.quiescent) fail("recovery-unresolved")
      // The storage method rechecks the pending request identity and only clears the slot; it never re-dispatches.
      ledger.settleRecovered({ runId, requestId: String(pending.request_id), clock: clock(),
        trainerProtocolCaptureLive: nativeTrainerProtocolCaptureLive(runId) })
      const resumed = ledger.readStatus()
      if (resumed.activeRunId !== runId || !resumed.run) fail("recovery-unresolved")
      if (resumed.run.state === "UNRESOLVED") return this.status()
      if (resumed.run.state !== "RUNNING") fail("recovery-unresolved")
      restoreConsentForRun(resumed.run, owner, ownerNow)
      return this.status()
    },
    awaitCandidateApproval(owner, runId, current, qualificationProof) {
      const initialOwner = ownerProof(runtime, root, owner)
      let claim: ExecutionClaim | undefined
      try {
        try { claim = runtime.runs.claim(owner.sessionID, `skillopt-candidate-approval-${randomUUID()}`, process.pid) }
        catch (error) {
          if (error instanceof ExecutionRunUnresolvedError) fail("owner-busy")
          throw error
        }
        assertRuntimeIdle(runtime, owner, claim)
        const now = clock()
        const persisted = ledger.readStatus(now)
        if (persisted.status.reasonCode === "clock-uncertain") fail("clock-uncertain")
        const run = persisted.run
        if (!run || persisted.activeRunId !== runId || run.run_id !== runId) fail("active-run")
        if (run.state !== "RUNNING") fail("run-stale")
        if (typeof run.revision !== "number" || !Number.isSafeInteger(run.revision) || typeof run.binding_hash !== "string" ||
            typeof run.owner_session_hash !== "string" || typeof run.owner_epoch_hash !== "string" ||
            typeof run.admission_hash !== "string") fail("storage-corrupt")
        if (run.owner_session_hash !== initialOwner.sessionHash || run.owner_epoch_hash !== initialOwner.epochHash ||
            run.admission_hash !== initialOwner.admissionHash) fail("owner-unavailable")
        const binding = currentBindings(current)
        if (binding.hashes.bindingSha256 !== run.binding_hash || binding.hashes.datasetSha256 !== run.dataset_hash ||
            binding.hashes.dataSha256 !== run.data_hash || binding.hashes.modelBindingsSha256 !== run.model_hash ||
            binding.hashes.protocolSha256 !== run.protocol_hash || binding.hashes.baselineSkillSha256 !== run.baseline_hash) {
          fail("consent-binding-drift")
        }
        const consent = ledger.readConsent(runId)
        if (!consent || consent.state !== "valid" || consent.scheduleSha256 !== binding.campaign.scheduleSha256 ||
            consent.bindingHash !== binding.hashes.bindingSha256 || consent.ownerSessionHash !== initialOwner.sessionHash ||
            consent.ownerEpochHash !== initialOwner.epochHash || consent.admissionHash !== initialOwner.admissionHash) {
          fail("consent-binding-drift")
        }
        if (consent.expiresBoot !== now.boot || BigInt(consent.expiresCont) < now.continuous || BigInt(consent.expiresWall) < now.wall) {
          fail("consent-expired")
        }
        let qualification: NativeCampaignQualificationBinding
        try {
          if (!qualificationProof) fail("qualification-required")
          qualification = consumeNativeCampaignQualification(qualificationProof)
        } catch (error) {
          if (error instanceof SkillOptControllerError) throw error
          fail("qualification-required")
        }
        if (qualification.runId !== runId || qualification.bindingSha256 !== binding.hashes.bindingSha256 ||
            qualification.scheduleSha256 !== binding.campaign.scheduleSha256 ||
            ![qualification.candidateSha256, qualification.resultsSha256, qualification.reviewSha256].every(asHash)) {
          fail("qualification-required")
        }
        const verifyOwner = (): void => {
          const confirmedOwner = ownerProof(runtime, root, owner)
          if (confirmedOwner.sessionHash !== initialOwner.sessionHash || confirmedOwner.epochHash !== initialOwner.epochHash ||
              confirmedOwner.admissionHash !== initialOwner.admissionHash) fail("owner-unavailable")
          assertRuntimeIdle(runtime, owner, claim)
          const confirmedBinding = currentBindings(current)
          if (!isDeepStrictEqual(confirmedBinding.hashes, binding.hashes) ||
              !isDeepStrictEqual(confirmedBinding.campaign, binding.campaign)) fail("consent-binding-drift")
        }
        ledger.awaitCandidateApproval({
          runId, expectedRevision: run.revision, bindingHash: binding.hashes.bindingSha256,
          scheduleSha256: binding.campaign.scheduleSha256, qualification, ownerSessionHash: initialOwner.sessionHash,
          ownerEpochHash: initialOwner.epochHash, admissionHash: initialOwner.admissionHash, clock: now, verifyOwner,
        })
        const status = this.status()
        if (status.state !== "AWAITING_CANDIDATE_APPROVAL" || status.runId !== runId || status.pendingDispatch) fail("revision-conflict")
        return status
      } finally {
        if (claim) {
          try { runtime.runs.release(claim) } catch { fail("owner-busy") }
        }
      }
    },
    assertQualifiedPublication(input) {
      return checkedQualifiedPublication(input).publication
    },
    reserveNativePublicationArtifacts(input) {
      if (!input || (input.operation !== "apply" && input.operation !== "rollback") || !UUID.test(input.runId)) {
        fail("run-stale")
      }
      if (!Number.isSafeInteger(input.bytes) || input.bytes < 0 || !Number.isSafeInteger(input.headroomBytes) ||
          input.headroomBytes < 0 || input.bytes + input.headroomBytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) {
        fail("budget-exhausted")
      }
      if (input.runtime !== runtime) fail("canary-runtime-mismatch")
      if (input.mutationClaim !== undefined) assertMutationClaim(runtime, input.owner, input.mutationClaim)
      else assertRuntimeIdle(runtime, input.owner)
      const preliminary = ledger.readRunForReentry(input.runId)
      if (!preliminary) fail("run-stale")
      const preliminaryUsage = preliminary.usage
      if (typeof preliminaryUsage.active_ms !== "number" || !Number.isSafeInteger(preliminaryUsage.active_ms) ||
          preliminaryUsage.active_ms < 0 || typeof preliminaryUsage.active_reserved_ms !== "number" ||
          !Number.isSafeInteger(preliminaryUsage.active_reserved_ms) || preliminaryUsage.active_reserved_ms < 0 ||
          typeof preliminaryUsage.artifact_bytes !== "number" || !Number.isSafeInteger(preliminaryUsage.artifact_bytes) ||
          preliminaryUsage.artifact_bytes < 0) fail("storage-corrupt")
      if (preliminaryUsage.active_ms + preliminaryUsage.active_reserved_ms > NATIVE_SKILLOPT_LIMITS.activeMilliseconds ||
          preliminaryUsage.artifact_bytes + input.bytes + input.headroomBytes > NATIVE_SKILLOPT_LIMITS.artifactBytes) {
        fail("budget-exhausted")
      }
      const checked = input.operation === "apply"
        ? (() => {
            const qualification = ledger.readCampaignQualification(input.runId)
            if (!qualification) fail("qualification-required")
            return checkedQualifiedPublication({ owner: input.owner, runId: input.runId, current: input.current,
              candidateSha256: qualification.candidateSha256, resultsSha256: qualification.resultsSha256,
              reviewSha256: qualification.reviewSha256, mutationClaim: input.mutationClaim })
          })()
        : checkedNativeRollbackEligibility(input)
      const expectedState = checked.run.state
      if (expectedState !== "COMPLETED" && expectedState !== "AWAITING_CANDIDATE_APPROVAL") fail("run-stale")
      if (input.operation === "apply" && expectedState !== "AWAITING_CANDIDATE_APPROVAL") fail("run-stale")
      const snapshot = ledger.readRunForReentry(input.runId)
      if (!snapshot || !snapshot.consent) fail("consent-expired")
      const expectedRevision = checked.run.revision
      const qualification = checked.qualification
      const ownerStatus = checked.ownerStatus
      const verifyCurrent = (): ClockValues => {
        const current = input.operation === "apply"
          ? checkedQualifiedPublication({ owner: input.owner, runId: input.runId, current: input.current,
              candidateSha256: qualification.candidateSha256, resultsSha256: qualification.resultsSha256,
              reviewSha256: qualification.reviewSha256, mutationClaim: input.mutationClaim })
          : checkedNativeRollbackEligibility(input)
        if (current.run.revision !== expectedRevision || current.run.state !== expectedState ||
            current.ownerStatus.sessionHash !== ownerStatus.sessionHash || current.ownerStatus.epochHash !== ownerStatus.epochHash ||
            current.ownerStatus.admissionHash !== ownerStatus.admissionHash ||
            !isDeepStrictEqual(current.qualification, qualification)) fail("revision-conflict")
        return current.now
      }
      ledger.chargeNativePublicationArtifacts({ runId: input.runId, expectedRevision, expectedState,
        ownerSessionHash: ownerStatus.sessionHash, ownerEpochHash: ownerStatus.epochHash,
        admissionHash: ownerStatus.admissionHash, operation: input.operation,
        qualification, consent: snapshot.consent, bytes: input.bytes, headroomBytes: input.headroomBytes, verifyCurrent })
      return ledger.readStatus(clock()).status
    },
    nativeRollbackEligibility(input) {
      try {
        checkedNativeRollbackEligibility(input)
        return Object.freeze({ state: "ELIGIBLE" as const })
      } catch (error) {
        const reasonCode = error instanceof SkillOptControllerError ? error.code : "storage-corrupt"
        return Object.freeze({ state: "BLOCKED" as const, reasonCode })
      }
    },
    prepareNativeCanary(owner, runId, current, handoff) {
      const ownerStatus = ownerProof(runtime, root, owner)
      assertRuntimeIdle(runtime, owner)
      const now = clock()
      const persisted = ledger.readStatus(now)
      const run = persisted.run
      if (!run || persisted.activeRunId !== runId || run.run_id !== runId || run.state !== "AWAITING_CANDIDATE_APPROVAL") {
        fail("run-stale")
      }
      if (typeof run.binding_hash !== "string" || typeof run.owner_session_hash !== "string" ||
          typeof run.owner_epoch_hash !== "string" || typeof run.admission_hash !== "string") fail("storage-corrupt")
      if (run.owner_session_hash !== ownerStatus.sessionHash || run.owner_epoch_hash !== ownerStatus.epochHash ||
          run.admission_hash !== ownerStatus.admissionHash) fail("owner-unavailable")
      const binding = bindingsAfterPromotion(current, run)
      const qualification = ledger.readCampaignQualification(runId)
      if (!qualification || qualification.runId !== runId || qualification.bindingSha256 !== binding.hashes.bindingSha256 ||
          qualification.scheduleSha256 !== binding.campaign.scheduleSha256) fail("qualification-required")
      const persistedConsent = ledger.readConsent(runId)
      const consentState = consentByRun.get(runId)
      if (!persistedConsent || persistedConsent.state !== "valid" || !consentState ||
          persistedConsent.scheduleSha256 !== qualification.scheduleSha256 || persistedConsent.bindingHash !== binding.hashes.bindingSha256 ||
          persistedConsent.ownerSessionHash !== ownerStatus.sessionHash || persistedConsent.ownerEpochHash !== ownerStatus.epochHash ||
          persistedConsent.admissionHash !== ownerStatus.admissionHash || persistedConsent.expiresBoot !== now.boot ||
          BigInt(persistedConsent.expiresCont) < now.continuous || BigInt(persistedConsent.expiresWall) < now.wall) fail("consent-binding-drift")
      let promotion: NativePromotionCanaryHandoffBinding
      try { promotion = consumeNativePromotionCanaryHandoff(handoff) }
      catch { fail("canary-handoff-invalid") }
      const approved = promotion.bindings
      const target = binding.dataset.modelBindings.target
      if (approved.witnessMode !== "native" || approved.runId !== runId || approved.rootBinding !== sha256(`root:${root}`) ||
          approved.sourceSha256 !== binding.dataset.sourceExportSha256 || approved.originalSha256 !== run.baseline_hash ||
          approved.candidateSha256 !== qualification.candidateSha256 || approved.resultsSha256 !== qualification.resultsSha256 ||
          approved.fixturePackSha256 !== binding.dataset.fixturePackSha256 || approved.protocolSha256 !== binding.dataset.protocolSha256 ||
          approved.nativeEngine !== target.engine || approved.nativeModel !== target.requestedModel ||
          approved.nativeRuntimeVersion !== target.runtimeIdentity.version || approved.nativeExecutableSha256 !== target.runtimeIdentity.executableSha256 ||
          approved.nativeProfileId !== target.profileIdentity.id || approved.nativeProfileSha256 !== target.profileIdentity.sha256 ||
          !asHash(promotion.semanticReviewSha256) || promotion.semanticReviewSha256 !== qualification.reviewSha256 ||
          ![promotion.evidence.qualification.sha256, promotion.evidence.review.sha256, promotion.evidence.approval.sha256].every(asHash) ||
          !promotion.handoffId || promotion.handoffId.length > 512 || !promotion.transactionId || promotion.transactionId.length > 512) {
        fail("canary-handoff-invalid")
      }
      let liveCandidate: Buffer
      try { liveCandidate = readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes) } catch { fail("binding-baseline-drift") }
      if (sha256(liveCandidate) !== approved.candidateSha256) fail("canary-handoff-invalid")
      const ownerAfter = ownerProof(runtime, root, owner)
      if (ownerAfter.sessionHash !== ownerStatus.sessionHash || ownerAfter.epochHash !== ownerStatus.epochHash ||
          ownerAfter.admissionHash !== ownerStatus.admissionHash) fail("owner-unavailable")
      const latest = bindingsAfterPromotion(current, run)
      if (!isDeepStrictEqual(latest.hashes, binding.hashes) || !isDeepStrictEqual(latest.campaign, binding.campaign)) {
        fail("consent-binding-drift")
      }
      const state: NativeCanaryPreparationState = Object.freeze({ runId, owner, ownerProof: ownerStatus,
        bindingHash: binding.hashes.bindingSha256, scheduleSha256: binding.campaign.scheduleSha256,
        qualification, promotion, consent: consentState, used: { value: false }, loader: {} })
      const preparation = Object.freeze({ runId, handoffId: promotion.handoffId,
        candidateSha256: approved.candidateSha256, bindings: Object.freeze({ ...approved }) }) as SkillOptCanaryPreparation
      canaryPreparations.set(preparation as object, state)
      canaryPreparationsByRun.set(runId, state)
      return preparation
    },
    reserveNativeCanary(input) {
      const state = input.preparation && typeof input.preparation === "object"
        ? canaryPreparations.get(input.preparation as object) : undefined
      if (!state || state.used.value || input.preparation.runId !== state.runId ||
          input.preparation.handoffId !== state.promotion.handoffId ||
          input.preparation.candidateSha256 !== state.qualification.candidateSha256 ||
          state.promotion.semanticReviewSha256 !== state.qualification.reviewSha256 ||
          !isDeepStrictEqual(input.preparation.bindings, state.promotion.bindings)) fail("canary-handoff-invalid")
      state.used.value = true
      const ownerNow = ownerProof(runtime, root, state.owner)
      if (ownerNow.sessionHash !== state.ownerProof.sessionHash || ownerNow.epochHash !== state.ownerProof.epochHash ||
          ownerNow.admissionHash !== state.ownerProof.admissionHash) fail("owner-unavailable")
      assertRuntimeIdle(runtime, state.owner)
      const loaderOwner = input.loaderOwner
      const loaderRuntime = input.loaderRuntime
      if (!loaderRuntime || loaderRuntime.verificationProfile !== "legacy-unowned" || realpathSync.native(loaderRuntime.worktree) !== root ||
          !loaderOwner || loaderOwner.restored ||
          loaderOwner.sessionID === state.owner.sessionID || loaderOwner.metadata.engine !== state.promotion.bindings.nativeEngine ||
          loaderOwner.metadata.model !== state.promotion.bindings.nativeModel || loaderRuntime.host.identity.engine !== state.promotion.bindings.nativeEngine) {
        fail("canary-runtime-mismatch")
      }
      const policy = loaderRuntime.policy.resolve("main")
      if (policy.role !== "main" || !policy.model || policy.model.providerID !== state.promotion.bindings.nativeEngine ||
          policy.model.modelID !== state.promotion.bindings.nativeModel ||
          (state.promotion.bindings.nativeEngine === "codex"
            ? policy.nativeContext?.identity !== state.promotion.bindings.nativeProfileSha256
            : policy.nativeContext !== undefined)) fail("canary-runtime-mismatch")
      const loaderProof = ownerProof(loaderRuntime, root, loaderOwner)
      assertRuntimeIdle(loaderRuntime, loaderOwner)
      const current = bindingsAfterPromotion(input.current, ledger.readStatus().run ?? {})
      if (current.hashes.bindingSha256 !== state.bindingHash || current.campaign.scheduleSha256 !== state.scheduleSha256 ||
          !isDeepStrictEqual(current.dataset.modelBindings.target, {
            engine: state.promotion.bindings.nativeEngine,
            requestedModel: state.promotion.bindings.nativeModel,
            runtimeIdentity: { version: state.promotion.bindings.nativeRuntimeVersion, executableSha256: state.promotion.bindings.nativeExecutableSha256 },
            profileIdentity: { id: state.promotion.bindings.nativeProfileId, sha256: state.promotion.bindings.nativeProfileSha256 },
          })) fail("canary-runtime-mismatch")
      const now = clock()
      assertConsentLive(state.consent, now)
      const currentOwner = ownerProof(runtime, root, state.owner)
      if (currentOwner.sessionHash !== ownerNow.sessionHash || currentOwner.epochHash !== ownerNow.epochHash ||
          currentOwner.admissionHash !== ownerNow.admissionHash) fail("owner-unavailable")
      const stored = ledger.reserveNativeCanary({ runId: state.runId, consentId: state.consent.consentId,
        ownerSessionHash: ownerNow.sessionHash, ownerEpochHash: ownerNow.epochHash, admissionHash: ownerNow.admissionHash,
        loaderSessionHash: loaderProof.sessionHash, loaderEpochHash: loaderProof.epochHash, loaderAdmissionHash: loaderProof.admissionHash,
        qualification: state.qualification, promotion: state.promotion, bindingHash: state.bindingHash, clock: now })
      state.loader.owner = loaderOwner
      state.loader.runtime = loaderRuntime
      state.loader.proof = loaderProof
      const pair = mintDispatch(stored.reservationId, stored.requestId, state.runId, "target", "canary", state.bindingHash,
        loaderProof, ticketStates, receiptStates, loaderOwner, state.consent, now)
      const ticketState = ticketStates.get(pair.ticket as object)
      if (!ticketState) fail("dispatch-not-authorized")
      ticketState.nativeCanary = Object.freeze({ owner: state.owner, ownerProof: state.ownerProof, runtime, operation: "apply" })
      return Object.freeze({ runId: state.runId, reservationId: stored.reservationId, requestId: stored.requestId,
        bindingSha256: state.bindingHash, scheduleSha256: state.scheduleSha256, role: "target" as const, phase: "canary" as const,
        charged: true as const, ticket: pair.ticket, receipt: pair.receipt })
    },
    consumeNativeCanaryDispatch(input) {
      const state = input.ticket && typeof input.ticket === "object" ? ticketStates.get(input.ticket as object) : undefined
      if (!state || state.phase !== "canary" || state.role !== "target" || state.consumed || state.owner !== input.owner) {
        fail("dispatch-not-authorized")
      }
      if (!state.consent) fail("consent-required")
      state.consumed = true
      state.receiptState.ticketConsumed = true
      const ownerNow = ownerProof(input.runtime, root, input.owner)
      if (ownerNow.sessionHash !== state.ownerProof.sessionHash || ownerNow.epochHash !== state.ownerProof.epochHash ||
          ownerNow.admissionHash !== state.ownerProof.admissionHash ||
          input.runtime.worktree !== runtime.worktree) fail("owner-unavailable")
      const canary = state.nativeCanary
      if (!canary || canary.runtime !== runtime) fail("dispatch-not-authorized")
      const preparation = canary.operation === "rollback"
        ? rollbackCanaryPreparationsByRun.get(state.runId)
        : canaryPreparationsByRun.get(state.runId)
      if (!preparation || preparation.owner !== canary.owner || !preparation.used.value ||
          preparation.loader.owner !== input.owner || preparation.loader.runtime !== input.runtime) fail("dispatch-not-authorized")
      const campaignOwnerNow = ownerProof(runtime, root, canary.owner, true)
      if (campaignOwnerNow.sessionHash !== canary.ownerProof.sessionHash ||
          campaignOwnerNow.epochHash !== canary.ownerProof.epochHash ||
          campaignOwnerNow.admissionHash !== canary.ownerProof.admissionHash) fail("owner-unavailable")
      assertOwnerIdle(runtime, canary.owner)
      const runState = input.runtime.runs.status()
      const intents = runState.executions.filter((record) => record.executionId === state.requestId)
      const intent = intents[0]
      const policyID = nativeLoadCanaryPolicyID(input.runtime, preparation)
      if (!runState.claim || runState.claim.ownerSession !== input.owner.sessionID || runState.claim.generation !== input.claim.generation ||
          !policyID || intents.length !== 1 || !intent || !nativeLoadCanaryIntentMatches({ record: intent, requestId: state.requestId,
            ownerSession: input.owner.sessionID, generation: input.claim.generation, root,
            engine: state.owner.metadata.engine, policyID, hostDispatch: "not-started" }) || intent.deadlineAt! <= Date.now()) {
        fail("dispatch-not-authorized")
      }
      const dispatchNow = clock()
      const persisted = ledger.readStatus(dispatchNow)
      const run = persisted.run
      if (!run || persisted.activeRunId !== state.runId || run.run_id !== state.runId || run.state !== "RESERVED" ||
          run.expires_boot !== dispatchNow.boot || typeof run.expires_cont !== "string" || !DECIMAL.test(run.expires_cont) ||
          typeof run.expires_wall !== "string" || !DECIMAL.test(run.expires_wall) ||
          BigInt(run.expires_cont) < dispatchNow.continuous || BigInt(run.expires_wall) < dispatchNow.wall) fail("run-expired")
      const binding = bindingsAfterPromotion(input.current, run)
      if (binding.hashes.bindingSha256 !== state.bindingSha256 || binding.campaign.scheduleSha256 !== state.scheduleSha256) fail("consent-binding-drift")
      assertConsentLive(state.consent, dispatchNow)
      state.receiptState.owner = input.owner
      state.grantIssued = true
      return Object.freeze({ runId: state.runId, reservationId: state.reservationId, requestId: state.requestId,
        role: state.role, phase: state.phase, bindingSha256: state.bindingSha256,
        timeoutMilliseconds: NATIVE_SKILLOPT_LIMITS.requestMilliseconds })
    },
    cancelNativeCanaryBeforeClaim(input) {
      const receiptState = input.reservation.receipt && typeof input.reservation.receipt === "object"
        ? receiptStates.get(input.reservation.receipt as object) : undefined
      const state = receiptState?.ticketState
      if (!state || state.phase !== "canary" || state.role !== "target" || state.recorded || state.consumed ||
          state.grantIssued || receiptState.ticketConsumed || receiptState.owner !== input.loaderOwner ||
          state.owner !== input.loaderOwner || state.requestId !== input.reservation.requestId ||
          state.runId !== input.reservation.runId) fail("dispatch-not-authorized")
      const campaignOwner = ownerProof(runtime, root, input.owner, true)
      const loaderOwner = ownerProof(runtime, root, input.loaderOwner, true)
      const canary = state.nativeCanary
      if (!canary || canary.owner !== input.owner || canary.runtime !== runtime ||
          campaignOwner.sessionHash !== canary.ownerProof.sessionHash || campaignOwner.epochHash !== canary.ownerProof.epochHash ||
          campaignOwner.admissionHash !== canary.ownerProof.admissionHash ||
          loaderOwner.sessionHash !== state.ownerProof.sessionHash || loaderOwner.epochHash !== state.ownerProof.epochHash ||
          loaderOwner.admissionHash !== state.ownerProof.admissionHash) fail("owner-unavailable")
      const execution = runtime.runs.status().executions.find(record => record.executionId === state.requestId)
      if (execution) fail("dispatch-ambiguous")
      const current = bindingsAfterPromotion(input.current, ledger.readStatus().run ?? {})
      if (current.hashes.bindingSha256 !== state.bindingSha256 || current.campaign.scheduleSha256 !== state.scheduleSha256) {
        fail("consent-binding-drift")
      }
      ledger.recordDispatch({ requestId: state.requestId, reservationId: state.reservationId, runId: state.runId,
        ownerSessionHash: state.ownerProof.sessionHash, ownerEpochHash: state.ownerProof.epochHash,
        ownerAdmissionHash: state.ownerProof.admissionHash,
        observation: { state: "not-dispatched" }, clock: clock(), canaryOperation: state.nativeCanary?.operation })
      state.consumed = true
      state.recorded = true
      receiptState.recorded = true
      return this.status()
    },
    recordNativeCanaryDispatch(input) {
      const receiptState = input.receipt && typeof input.receipt === "object"
        ? receiptStates.get(input.receipt as object) : undefined
      const state = receiptState?.ticketState
      const notDispatched = input.observation.state === "not-dispatched"
      if (!receiptState || !state || state.phase !== "canary" || state.role !== "target" || receiptState.recorded ||
          (!notDispatched && (!receiptState.ticketConsumed || !state.grantIssued)) || receiptState.owner !== input.owner ||
          state.owner !== input.owner || !state.receiptState || state.receiptState !== receiptState) fail("dispatch-not-authorized")
      const ownerNow = ownerProof(input.runtime, root, input.owner, true)
      if (ownerNow.sessionHash !== state.ownerProof.sessionHash || ownerNow.epochHash !== state.ownerProof.epochHash ||
          ownerNow.admissionHash !== state.ownerProof.admissionHash || input.runtime.worktree !== runtime.worktree) fail("owner-unavailable")
      const runState = input.runtime.runs.status()
      if (!runState.claim || runState.claim.ownerSession !== input.owner.sessionID ||
          runState.claim.generation !== input.claim.generation) fail("dispatch-not-authorized")
      const canary = state.nativeCanary
      if (!canary || canary.runtime !== runtime) fail("dispatch-not-authorized")
      const preparation = canary.operation === "rollback"
        ? rollbackCanaryPreparationsByRun.get(state.runId)
        : canaryPreparationsByRun.get(state.runId)
      if (!preparation || preparation.owner !== canary.owner || !preparation.used.value || preparation.loader.dispatchRecorded ||
          preparation.loader.owner !== input.owner || preparation.loader.runtime !== input.runtime) {
        fail("dispatch-not-authorized")
      }
      const policyID = nativeLoadCanaryPolicyID(input.runtime, preparation)
      if (!policyID) fail("dispatch-not-authorized")
      if (input.observation.state === "launched") {
        validateExecutionReference(input.observation.reference, state.requestId)
        const matches = runState.executions.filter(record => record.executionId === state.requestId)
        const record = matches[0]
        if (matches.length !== 1 || !record) fail("dispatch-not-authorized")
        if (!nativeLoadCanaryIntentMatches({ record, requestId: state.requestId, ownerSession: input.owner.sessionID,
            generation: input.claim.generation, root, engine: state.owner.metadata.engine, policyID, hostDispatch: "started" }) ||
            !record.boundaryRef || !isDeepStrictEqual(record.boundaryRef, input.observation.reference)) fail("dispatch-not-authorized")
      } else if (notDispatched) {
        const matches = runState.executions.filter(record => record.executionId === state.requestId)
        const record = matches[0]
        if (matches.length > 1 || (record && (!nativeLoadCanaryIntentMatches({ record, requestId: state.requestId,
            ownerSession: input.owner.sessionID, generation: input.claim.generation, root,
            engine: state.owner.metadata.engine, policyID, hostDispatch: "not-started" }) || record.boundaryRef !== undefined))) {
          fail("dispatch-ambiguous")
        }
      } else {
        const matches = runState.executions.filter(record => record.executionId === state.requestId)
        const record = matches[0]
        if (matches.length > 1 || (record && !nativeLoadCanaryIntentMatches({ record, requestId: state.requestId,
            ownerSession: input.owner.sessionID, generation: input.claim.generation, root,
            engine: state.owner.metadata.engine, policyID, hostDispatch: "either" }))) fail("dispatch-ambiguous")
        if (input.observation.reference) validateExecutionReference(input.observation.reference, state.requestId)
      }
      const now = clock()
      ledger.recordDispatch({ requestId: state.requestId, reservationId: state.reservationId, runId: state.runId,
        ownerSessionHash: state.ownerProof.sessionHash, ownerEpochHash: state.ownerProof.epochHash,
        ownerAdmissionHash: state.ownerProof.admissionHash,
        observation: input.observation, clock: now, canaryOperation: state.nativeCanary?.operation })
      receiptState.recorded = true
      state.recorded = true
      preparation.loader.dispatchRecorded = true
      preparation.loader.requestId = state.requestId
      if (notDispatched) state.consumed = true
      return this.status()
    },
    settleNativeCanary(input) {
      const ownerNow = ownerProof(input.runtime, root, input.owner, true)
      const rollbackPreparation = rollbackCanaryPreparationsByRun.get(input.runId)
      const applyPreparation = canaryPreparationsByRun.get(input.runId)
      const preparation = rollbackPreparation?.loader.requestId === input.requestId ? rollbackPreparation
        : applyPreparation?.loader.requestId === input.requestId ? applyPreparation : undefined
      const status = input.runtime.runs.status()
      const matches = status.executions.filter(record => record.executionId === input.requestId)
      const record = matches[0]
      const policyID = preparation ? nativeLoadCanaryPolicyID(input.runtime, preparation) : undefined
      if (!status.claim || status.claim.ownerSession !== input.owner.sessionID || status.claim.generation !== input.claim.generation ||
          !preparation || !preparation.used.value || preparation.loader.owner !== input.owner || preparation.loader.runtime !== input.runtime ||
          preparation.loader.dispatchRecorded !== true || preparation.loader.requestId !== input.requestId ||
          !policyID ||
          matches.length !== 1 || !record || !nativeLoadCanaryIntentMatches({ record, requestId: input.requestId,
            ownerSession: input.owner.sessionID, generation: input.claim.generation, root,
            engine: input.owner.metadata.engine, policyID, hostDispatch: "started" }) ||
          !record.terminal || record.terminal.outcome === "not-dispatched" ||
          typeof record.terminal.terminalAt !== "number" || !Number.isSafeInteger(record.terminal.terminalAt) ||
          typeof record.terminal.quiescentAt !== "number" || !Number.isSafeInteger(record.terminal.quiescentAt) ||
          !settled(record) || input.reconciliation.outcome !== "terminal" ||
          !input.reconciliation.quiescent || record.reconciliation?.outcome !== "terminal" ||
          record.reconciliation.quiescent !== true || record.reconciliation.evidence !== input.reconciliation.evidence) fail("recovery-unresolved")
      const operation = rollbackCanaryPreparationsByRun.has(input.runId) ? "rollback" : "apply"
      ledger.settleNativeCanary({ runId: input.runId, requestId: input.requestId, operation,
        loaderSessionHash: ownerNow.sessionHash, loaderEpochHash: ownerNow.epochHash, loaderAdmissionHash: ownerNow.admissionHash,
        reconciliation: input.reconciliation, clock: clock() })
      return this.status()
    },
    recordNativeCanaryArtifact(owner, runId, bytes) {
      const proof = ownerProof(runtime, root, owner, true)
      const operation = rollbackCanaryPreparationsByRun.has(runId) ? "rollback" : "apply"
      ledger.recordNativeCanaryArtifact({ runId, loaderSessionHash: proof.sessionHash, loaderEpochHash: proof.epochHash,
        loaderAdmissionHash: proof.admissionHash, operation, bytes })
      return this.status()
    },
    completeNativeCanary(input) {
      const state = canaryPreparationsByRun.get(input.runId)
      if (!state || state.owner !== input.owner || !state.used.value || state.loader.owner !== input.loaderOwner) fail("canary-handoff-invalid")
      const ownerNow = ownerProof(runtime, root, input.owner, true)
      const loaderNow = ownerProof(runtime, root, input.loaderOwner, true)
      const expectedLoader = state.loader.proof
      if (ownerNow.sessionHash !== state.ownerProof.sessionHash || ownerNow.epochHash !== state.ownerProof.epochHash ||
          ownerNow.admissionHash !== state.ownerProof.admissionHash ||
          !expectedLoader || loaderNow.sessionHash !== expectedLoader.sessionHash || loaderNow.epochHash !== expectedLoader.epochHash ||
          loaderNow.admissionHash !== expectedLoader.admissionHash) fail("owner-unavailable")
      const persisted = ledger.readStatus(clock())
      const run = persisted.run
      if (!run || run.run_id !== input.runId || run.state !== "AWAITING_CANDIDATE_APPROVAL" ||
          ownerNow.sessionHash !== run.owner_session_hash || ownerNow.epochHash !== run.owner_epoch_hash ||
          ownerNow.admissionHash !== run.admission_hash) fail("owner-unavailable")
      const current = bindingsAfterPromotion(input.current, run)
      const qualification = ledger.readCampaignQualification(input.runId)
      const consent = ledger.readConsent(input.runId)
      if (!qualification || !consent || consent.state !== "valid" || current.campaign.scheduleSha256 !== qualification.scheduleSha256 ||
          current.hashes.bindingSha256 !== qualification.bindingSha256 ||
          qualification.candidateSha256 !== state.qualification.candidateSha256 ||
          qualification.resultsSha256 !== state.qualification.resultsSha256 || qualification.reviewSha256 !== state.qualification.reviewSha256 ||
          state.promotion.semanticReviewSha256 !== qualification.reviewSha256 ||
          consent.scheduleSha256 !== state.scheduleSha256 || consent.bindingHash !== state.bindingHash) fail("consent-binding-drift")
      let liveCandidate: Buffer
      try { liveCandidate = readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes) } catch { fail("binding-baseline-drift") }
      if (sha256(liveCandidate) !== state.qualification.candidateSha256) fail("canary-handoff-invalid")
      ledger.completeNativeCanary({ runId: input.runId, ownerSessionHash: ownerNow.sessionHash, ownerEpochHash: ownerNow.epochHash,
        admissionHash: ownerNow.admissionHash, loaderSessionHash: loaderNow.sessionHash, loaderEpochHash: loaderNow.epochHash,
        loaderAdmissionHash: loaderNow.admissionHash, qualification, promotion: state.promotion,
        bindingHash: state.bindingHash, scheduleSha256: state.scheduleSha256, clock: clock(),
        consumeCommit() {
          consumeNativePromotionCanaryCommit(input.commit, { handoffId: state.promotion.handoffId, bindings: state.promotion.bindings })
        } })
      canaryPreparationsByRun.delete(input.runId)
      return this.status()
    },
    beginNativeRollback(input) {
      if (input.runtime !== runtime) fail("canary-runtime-mismatch")
      assertMutationClaim(runtime, input.owner, input.mutationClaim)
      const checked = checkedNativeRollbackEligibility(input)
      const { ownerStatus, now, run, binding, qualification, consent, consentState } = checked
      let authorization: Readonly<{ approvalRecordSha256: string }>
      try {
        authorization = assertNativeRollbackAuthorizationCurrent({
          ...input.promotion, owner: input.owner, nativeAuthorization: input.nativeAuthorization,
        })
      } catch { fail("rollback-approval-binding-mismatch") }
      if (!authorization || !asHash(authorization.approvalRecordSha256)) fail("rollback-approval-binding-mismatch")
      const approved = input.promotion.bindings
      const target = binding.dataset.modelBindings.target
      if (approved.witnessMode !== "native" || approved.runId !== input.runId || approved.rootBinding !== sha256(`root:${root}`) ||
          approved.sourceSha256 !== binding.dataset.sourceExportSha256 || approved.originalSha256 !== run.baseline_hash ||
          approved.candidateSha256 !== qualification.candidateSha256 || approved.resultsSha256 !== qualification.resultsSha256 ||
          approved.fixturePackSha256 !== binding.dataset.fixturePackSha256 || approved.protocolSha256 !== binding.dataset.protocolSha256 ||
          approved.nativeEngine !== target.engine || approved.nativeModel !== target.requestedModel ||
          approved.nativeRuntimeVersion !== target.runtimeIdentity.version || approved.nativeExecutableSha256 !== target.runtimeIdentity.executableSha256 ||
          approved.nativeProfileId !== target.profileIdentity.id || approved.nativeProfileSha256 !== target.profileIdentity.sha256) {
        fail("rollback-approval-binding-mismatch")
      }
      const ownerAfter = ownerProof(runtime, root, input.owner)
      if (ownerAfter.sessionHash !== ownerStatus.sessionHash || ownerAfter.epochHash !== ownerStatus.epochHash ||
          ownerAfter.admissionHash !== ownerStatus.admissionHash) fail("owner-unavailable")
      assertMutationClaim(runtime, input.owner, input.mutationClaim)
      const latest = bindingsAfterPromotion(input.current, run)
      if (!isDeepStrictEqual(latest.hashes, binding.hashes) || !isDeepStrictEqual(latest.campaign, binding.campaign)) {
        fail("consent-binding-drift")
      }
      const sourceState = ledger.beginNativeRollback({
        runId: input.runId, ownerSessionHash: ownerStatus.sessionHash, ownerEpochHash: ownerStatus.epochHash,
        admissionHash: ownerStatus.admissionHash, binding: binding.hashes, scheduleSha256: binding.campaign.scheduleSha256,
        sourceSha256: binding.dataset.sourceExportSha256, fixturePackSha256: binding.dataset.fixturePackSha256,
        protocolSha256: binding.dataset.protocolSha256, qualification, promotionBindings: approved,
        approvalRecordSha256: authorization.approvalRecordSha256, expectedRevision: run.revision, clock: now,
        verifyOwner() {
          const confirmed = ownerProof(runtime, root, input.owner)
          if (confirmed.sessionHash !== ownerStatus.sessionHash || confirmed.epochHash !== ownerStatus.epochHash ||
              confirmed.admissionHash !== ownerStatus.admissionHash) fail("owner-unavailable")
          assertMutationClaim(runtime, input.owner, input.mutationClaim)
          const latestBinding = bindingsAfterPromotion(input.current, run)
          if (!isDeepStrictEqual(latestBinding.hashes, binding.hashes) || !isDeepStrictEqual(latestBinding.campaign, binding.campaign)) {
            fail("consent-binding-drift")
          }
          const liveConsent = ledger.readConsent(input.runId)
          const verifyNow = clock()
          if (!liveConsent || liveConsent.state !== "valid" || liveConsent.consentId !== consent.consentId ||
              liveConsent.subjectHash !== consent.subjectHash || liveConsent.scheduleSha256 !== consent.scheduleSha256 ||
              liveConsent.bindingHash !== consent.bindingHash || liveConsent.ownerSessionHash !== ownerStatus.sessionHash ||
              liveConsent.ownerEpochHash !== ownerStatus.epochHash || liveConsent.admissionHash !== ownerStatus.admissionHash ||
              liveConsent.expiresBoot !== consent.expiresBoot || liveConsent.expiresCont !== consent.expiresCont ||
              liveConsent.expiresWall !== consent.expiresWall) fail("consent-binding-drift")
          assertConsentLive(consentState, verifyNow)
          const revalidated = assertNativeRollbackAuthorizationCurrent({
            ...input.promotion, owner: input.owner, nativeAuthorization: input.nativeAuthorization,
          })
          if (!revalidated || revalidated.approvalRecordSha256 !== authorization.approvalRecordSha256) {
            fail("rollback-approval-binding-mismatch")
          }
        },
      })
      if (sourceState !== run.state) fail("revision-conflict")
      const intent = Object.freeze({}) as SkillOptRollbackIntent
      const state: NativeRollbackIntentState = Object.freeze({
        runId: input.runId, owner: input.owner, ownerProof: ownerStatus, runtime,
        bindingHash: binding.hashes.bindingSha256, bindingHashes: Object.freeze({ ...binding.hashes }),
        scheduleSha256: binding.campaign.scheduleSha256, qualification, consent: consentState,
        promotionSha256: sha256(canonicalJson(input.promotion)), promotionBindings: Object.freeze({ ...approved }),
        nativeAuthorization: input.nativeAuthorization, approvalRecordSha256: authorization.approvalRecordSha256,
        sourceState, used: { value: false },
      })
      rollbackIntents.set(intent as object, state)
      rollbackIntentsByRun.set(input.runId, state)
      return intent
    },
    prepareNativeRollbackCanary(input) {
      const state = input.intent && typeof input.intent === "object"
        ? rollbackIntents.get(input.intent as object) : undefined
      if (!state || state.used.value || rollbackIntentsByRun.get(input.runId) !== state || state.owner !== input.owner ||
          state.runId !== input.runId || sha256(canonicalJson(input.promotion)) !== state.promotionSha256 ||
          !isDeepStrictEqual(input.promotion.bindings, state.promotionBindings)) fail("rollback-intent-invalid")
      state.used.value = true
      const ownerStatus = ownerProof(runtime, root, input.owner)
      if (ownerStatus.sessionHash !== state.ownerProof.sessionHash || ownerStatus.epochHash !== state.ownerProof.epochHash ||
          ownerStatus.admissionHash !== state.ownerProof.admissionHash) fail("owner-unavailable")
      assertRuntimeIdle(runtime, input.owner)
      const now = clock()
      const persisted = ledger.readStatus(now)
      const run = persisted.run
      if (!run || run.run_id !== input.runId || run.state !== "AWAITING_ROLLBACK_CANARY" ||
          persisted.activeRunId !== input.runId || persisted.status.pendingDispatch) fail("run-stale")
      const binding = bindingsAfterPromotion(input.current, run)
      const qualification = ledger.readCampaignQualification(input.runId)
      const consent = ledger.readConsent(input.runId)
      if (!qualification || !consent || consent.state !== "valid" || qualification.runId !== input.runId ||
          !isDeepStrictEqual(qualification, state.qualification) || !isDeepStrictEqual(binding.hashes, state.bindingHashes) ||
          binding.campaign.scheduleSha256 !== state.scheduleSha256 ||
          consent.scheduleSha256 !== state.scheduleSha256 || consent.bindingHash !== state.bindingHash ||
          consent.ownerSessionHash !== ownerStatus.sessionHash || consent.ownerEpochHash !== ownerStatus.epochHash ||
          consent.admissionHash !== ownerStatus.admissionHash || consent.consentId !== state.consent.consentId ||
          consent.subjectHash !== state.consent.subjectHash || consent.expiresBoot !== now.boot ||
          consent.expiresBoot !== state.consent.expiresBoot || consent.expiresCont !== state.consent.expiresCont.toString() ||
          consent.expiresWall !== state.consent.expiresWall.toString() ||
          BigInt(consent.expiresCont) < now.continuous || BigInt(consent.expiresWall) < now.wall) fail("consent-binding-drift")
      assertConsentLive(state.consent, now)
      let rollback: NativeRollbackCanaryHandoffReceipt
      try { rollback = consumeNativeRollbackCanaryHandoff(input.handoff, { bindings: state.promotionBindings }) }
      catch { fail("rollback-canary-handoff-invalid") }
      const approved = rollback.bindings
      const target = binding.dataset.modelBindings.target
      if (rollback.rollbackApprovalSha256 !== state.approvalRecordSha256 || rollback.semanticReviewSha256 !== qualification.reviewSha256 ||
          approved.witnessMode !== "native" || approved.runId !== input.runId || approved.rootBinding !== sha256(`root:${root}`) ||
          approved.sourceSha256 !== binding.dataset.sourceExportSha256 || approved.originalSha256 !== run.baseline_hash ||
          approved.candidateSha256 !== qualification.candidateSha256 || approved.resultsSha256 !== qualification.resultsSha256 ||
          approved.fixturePackSha256 !== binding.dataset.fixturePackSha256 || approved.protocolSha256 !== binding.dataset.protocolSha256 ||
          approved.nativeEngine !== target.engine || approved.nativeModel !== target.requestedModel ||
          approved.nativeRuntimeVersion !== target.runtimeIdentity.version || approved.nativeExecutableSha256 !== target.runtimeIdentity.executableSha256 ||
          approved.nativeProfileId !== target.profileIdentity.id || approved.nativeProfileSha256 !== target.profileIdentity.sha256 ||
          ![rollback.evidence.qualification.sha256, rollback.evidence.review.sha256, rollback.evidence.approval.sha256].every(asHash) ||
          !rollback.handoffId || rollback.handoffId.length > 512 || !rollback.transactionId || rollback.transactionId.length > 512) {
        fail("rollback-canary-handoff-invalid")
      }
      let liveOriginal: Buffer
      try { liveOriginal = readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes) } catch { fail("binding-baseline-drift") }
      if (sha256(liveOriginal) !== approved.originalSha256) fail("rollback-canary-handoff-invalid")
      const ownerAfter = ownerProof(runtime, root, input.owner)
      if (ownerAfter.sessionHash !== ownerStatus.sessionHash || ownerAfter.epochHash !== ownerStatus.epochHash ||
          ownerAfter.admissionHash !== ownerStatus.admissionHash) fail("owner-unavailable")
      const latest = bindingsAfterPromotion(input.current, run)
      if (!isDeepStrictEqual(latest.hashes, binding.hashes) || !isDeepStrictEqual(latest.campaign, binding.campaign)) fail("consent-binding-drift")
      const preparationState: NativeRollbackCanaryPreparationState = Object.freeze({
        runId: input.runId, owner: input.owner, ownerProof: ownerStatus, runtime,
        bindingHash: binding.hashes.bindingSha256, bindingHashes: Object.freeze({ ...binding.hashes }),
        scheduleSha256: binding.campaign.scheduleSha256, qualification, rollback, consent: state.consent,
        intent: state, used: { value: false }, loader: {},
      })
      const preparation = Object.freeze({ runId: input.runId, handoffId: rollback.handoffId,
        originalSha256: approved.originalSha256, bindings: Object.freeze({ ...approved }) }) as SkillOptRollbackCanaryPreparation
      rollbackCanaryPreparations.set(preparation as object, preparationState)
      rollbackCanaryPreparationsByRun.set(input.runId, preparationState)
      return preparation
    },
    reserveNativeRollbackCanary(input) {
      const state = input.preparation && typeof input.preparation === "object"
        ? rollbackCanaryPreparations.get(input.preparation as object) : undefined
      if (!state || state.used.value || input.preparation.runId !== state.runId ||
          input.preparation.handoffId !== state.rollback.handoffId ||
          input.preparation.originalSha256 !== state.rollback.bindings.originalSha256 ||
          !isDeepStrictEqual(input.preparation.bindings, state.rollback.bindings)) fail("rollback-canary-handoff-invalid")
      state.used.value = true
      const ownerNow = ownerProof(runtime, root, state.owner)
      if (ownerNow.sessionHash !== state.ownerProof.sessionHash || ownerNow.epochHash !== state.ownerProof.epochHash ||
          ownerNow.admissionHash !== state.ownerProof.admissionHash) fail("owner-unavailable")
      assertRuntimeIdle(runtime, state.owner)
      const loaderOwner = input.loaderOwner
      const loaderRuntime = input.loaderRuntime
      const bindings = state.rollback.bindings
      if (!loaderRuntime || loaderRuntime.verificationProfile !== "legacy-unowned" || realpathSync.native(loaderRuntime.worktree) !== root ||
          !loaderOwner || loaderOwner.restored || loaderOwner.sessionID === state.owner.sessionID ||
          loaderOwner.metadata.engine !== bindings.nativeEngine || loaderOwner.metadata.model !== bindings.nativeModel ||
          loaderRuntime.host.identity.engine !== bindings.nativeEngine) fail("canary-runtime-mismatch")
      const policy = loaderRuntime.policy.resolve("main")
      if (policy.role !== "main" || !policy.model || policy.model.providerID !== bindings.nativeEngine ||
          policy.model.modelID !== bindings.nativeModel ||
          (bindings.nativeEngine === "codex" ? policy.nativeContext?.identity !== bindings.nativeProfileSha256 : policy.nativeContext !== undefined)) {
        fail("canary-runtime-mismatch")
      }
      const loaderProof = ownerProof(loaderRuntime, root, loaderOwner)
      assertRuntimeIdle(loaderRuntime, loaderOwner)
      const now = clock()
      const persisted = ledger.readStatus(now)
      const run = persisted.run
      if (!run || run.run_id !== state.runId || run.state !== "AWAITING_ROLLBACK_CANARY" ||
          persisted.activeRunId !== state.runId || persisted.status.pendingDispatch) fail("run-stale")
      const current = bindingsAfterPromotion(input.current, run)
      if (!isDeepStrictEqual(current.hashes, state.bindingHashes) || current.campaign.scheduleSha256 !== state.scheduleSha256 ||
          !isDeepStrictEqual(current.dataset.modelBindings.target, {
            engine: bindings.nativeEngine, requestedModel: bindings.nativeModel,
            runtimeIdentity: { version: bindings.nativeRuntimeVersion, executableSha256: bindings.nativeExecutableSha256 },
            profileIdentity: { id: bindings.nativeProfileId, sha256: bindings.nativeProfileSha256 },
          })) fail("canary-runtime-mismatch")
      let liveOriginal: Buffer
      try { liveOriginal = readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes) } catch { fail("binding-baseline-drift") }
      if (sha256(liveOriginal) !== bindings.originalSha256) fail("rollback-canary-handoff-invalid")
      assertConsentLive(state.consent, now)
      const ownerConfirmed = ownerProof(runtime, root, state.owner)
      if (ownerConfirmed.sessionHash !== ownerNow.sessionHash || ownerConfirmed.epochHash !== ownerNow.epochHash ||
          ownerConfirmed.admissionHash !== ownerNow.admissionHash) fail("owner-unavailable")
      const stored = ledger.reserveNativeRollbackCanary({
        runId: state.runId, consentId: state.consent.consentId, ownerSessionHash: ownerNow.sessionHash,
        ownerEpochHash: ownerNow.epochHash, admissionHash: ownerNow.admissionHash,
        loaderSessionHash: loaderProof.sessionHash, loaderEpochHash: loaderProof.epochHash,
        loaderAdmissionHash: loaderProof.admissionHash, qualification: state.qualification,
        rollback: state.rollback, bindingHash: state.bindingHash, clock: now,
      })
      state.loader.owner = loaderOwner
      state.loader.runtime = loaderRuntime
      state.loader.proof = loaderProof
      const pair = mintDispatch(stored.reservationId, stored.requestId, state.runId, "target", "canary", state.bindingHash,
        loaderProof, ticketStates, receiptStates, loaderOwner, state.consent, now)
      const ticketState = ticketStates.get(pair.ticket as object)
      if (!ticketState) fail("dispatch-not-authorized")
      ticketState.nativeCanary = Object.freeze({ owner: state.owner, ownerProof: state.ownerProof, runtime, operation: "rollback" })
      return Object.freeze({ runId: state.runId, reservationId: stored.reservationId, requestId: stored.requestId,
        bindingSha256: state.bindingHash, scheduleSha256: state.scheduleSha256, role: "target" as const, phase: "canary" as const,
        charged: true as const, ticket: pair.ticket, receipt: pair.receipt })
    },
    markNativeRollbackUnresolved(owner, runId, reasonCode) {
      const state = rollbackIntentsByRun.get(runId)
      if (!state || state.owner !== owner) fail("rollback-intent-invalid")
      const proof = ownerProof(runtime, root, owner, true)
      if (proof.sessionHash !== state.ownerProof.sessionHash || proof.epochHash !== state.ownerProof.epochHash ||
          proof.admissionHash !== state.ownerProof.admissionHash) fail("owner-unavailable")
      ledger.markNativeRollbackUnresolved({ runId, ownerSessionHash: proof.sessionHash,
        ownerEpochHash: proof.epochHash, reasonCode })
      return this.status()
    },
    recordNativeRollbackCanaryArtifact(owner, runId, bytes) {
      const state = rollbackCanaryPreparationsByRun.get(runId)
      if (!state || state.loader.owner !== owner || !state.used.value || !state.loader.runtime) fail("rollback-canary-handoff-invalid")
      const proof = ownerProof(state.loader.runtime, root, owner, true)
      const expected = state.loader.proof
      if (!expected || proof.sessionHash !== expected.sessionHash || proof.epochHash !== expected.epochHash ||
          proof.admissionHash !== expected.admissionHash) fail("owner-unavailable")
      ledger.recordNativeCanaryArtifact({ runId, loaderSessionHash: state.loader.proof?.sessionHash ?? "",
        loaderEpochHash: state.loader.proof?.epochHash ?? "", loaderAdmissionHash: state.loader.proof?.admissionHash ?? "",
        operation: "rollback", bytes })
      return this.status()
    },
    completeNativeRollbackCanary(input) {
      const state = rollbackCanaryPreparationsByRun.get(input.runId)
      if (!state || state.owner !== input.owner || !state.used.value || state.loader.owner !== input.loaderOwner) {
        fail("rollback-canary-handoff-invalid")
      }
      const ownerNow = ownerProof(runtime, root, input.owner, true)
      const loaderNow = ownerProof(state.loader.runtime!, root, input.loaderOwner, true)
      const expectedLoader = state.loader.proof
      if (ownerNow.sessionHash !== state.ownerProof.sessionHash || ownerNow.epochHash !== state.ownerProof.epochHash ||
          ownerNow.admissionHash !== state.ownerProof.admissionHash || !expectedLoader ||
          loaderNow.sessionHash !== expectedLoader.sessionHash || loaderNow.epochHash !== expectedLoader.epochHash ||
          loaderNow.admissionHash !== expectedLoader.admissionHash) fail("owner-unavailable")
      const persisted = ledger.readStatus(clock())
      const run = persisted.run
      if (!run || run.run_id !== input.runId || run.state !== "AWAITING_ROLLBACK_CANARY" || persisted.activeRunId !== input.runId ||
          persisted.status.pendingDispatch || ownerNow.sessionHash !== run.owner_session_hash || ownerNow.epochHash !== run.owner_epoch_hash ||
          ownerNow.admissionHash !== run.admission_hash) fail("owner-unavailable")
      const current = bindingsAfterPromotion(input.current, run)
      const qualification = ledger.readCampaignQualification(input.runId)
      const consent = ledger.readConsent(input.runId)
      if (!qualification || !consent || consent.state !== "valid" ||
          !isDeepStrictEqual(qualification, state.qualification) || !isDeepStrictEqual(current.hashes, state.bindingHashes) ||
          current.campaign.scheduleSha256 !== state.scheduleSha256 || consent.scheduleSha256 !== state.scheduleSha256 ||
          consent.bindingHash !== state.bindingHash || consent.ownerSessionHash !== ownerNow.sessionHash ||
          consent.ownerEpochHash !== ownerNow.epochHash || consent.admissionHash !== ownerNow.admissionHash ||
          consent.consentId !== state.consent.consentId || consent.subjectHash !== state.consent.subjectHash ||
          consent.expiresBoot !== state.consent.expiresBoot || consent.expiresCont !== state.consent.expiresCont.toString() ||
          consent.expiresWall !== state.consent.expiresWall.toString() ||
          state.rollback.semanticReviewSha256 !== qualification.reviewSha256 ||
          state.rollback.rollbackApprovalSha256 !== state.intent.approvalRecordSha256) fail("consent-binding-drift")
      let liveOriginal: Buffer
      try { liveOriginal = readBoundedSource(root, PILOT_SKILL, PILOT_LIMITS.skillBytes) } catch { fail("binding-baseline-drift") }
      if (sha256(liveOriginal) !== state.rollback.bindings.originalSha256) fail("rollback-canary-handoff-invalid")
      ledger.completeNativeRollbackCanary({ runId: input.runId, ownerSessionHash: ownerNow.sessionHash,
        ownerEpochHash: ownerNow.epochHash, admissionHash: ownerNow.admissionHash,
        loaderSessionHash: loaderNow.sessionHash, loaderEpochHash: loaderNow.epochHash,
        loaderAdmissionHash: loaderNow.admissionHash, qualification, rollback: state.rollback,
        bindingHash: state.bindingHash, approvalRecordSha256: state.intent.approvalRecordSha256, clock: clock(),
        consumeCommit() {
          consumeNativeRollbackCanaryCommit(input.commit, { handoffId: state.rollback.handoffId, bindings: state.rollback.bindings })
        },
      })
      rollbackIntentsByRun.delete(input.runId)
      rollbackCanaryPreparationsByRun.delete(input.runId)
      return this.status()
    },
    finish(owner, runId, state) {
      const proof = ownerProof(runtime, root, owner, true)
      ledger.finish(runId, proof.sessionHash, proof.epochHash, state)
      if (state === "FAILED" || state === "CANCELLED" || state === "INCONCLUSIVE" || state === "NO_GAIN") {
        canaryPreparationsByRun.delete(runId)
      }
      return this.status()
    },
    recordArtifactBytes(owner, runId, bytes) {
      const proof = ownerProof(runtime, root, owner, true)
      ledger.chargeArtifactBytes(runId, proof.epochHash, bytes)
      return this.status()
    },
    reserveCandidateStep(owner, runId) {
      const proof = ownerProof(runtime, root, owner)
      ledger.chargeCandidateStep(runId, proof.epochHash)
      return this.status()
    },
  })
  return controller
}

type PreparedState = {
  runId: string; campaignId: string; hashes: ReturnType<typeof skillOptBindingHashes>; consentBindingSha256: string
  campaign: CampaignDisclosure
  owner: SessionStore; ownerSessionHash: string; ownerEpochHash: string; admissionHash: string
  createdBoot: string; createdCont: bigint; createdWall: bigint; revision: number
  decisionRevision: number // Reservation-only revision changes do not rewrite an already-issued consent decision.
  dataset: NativeDataset; used: boolean
  initialStartConsumed: boolean
}
type NativeTrainerProtocolStageAllowanceState = Readonly<{
  metadata: SkillOptNativeTrainerMaterializationMetadata
  used: boolean
}>
type NativeTrainerMaterializationAllowanceState = {
  controllerIdentity: object
  owner: SessionStore
  runtime: ExecutionRuntime
  ownerProof: OwnerProof
  prepared: SkillOptPrepared
  preparedState: PreparedState
  bindingHashes: ReturnType<typeof skillOptBindingHashes>
  metadata: SkillOptNativeTrainerMaterializationMetadata
  runState: "PREPARED" | "CONSENTED" | "ARMED"
  revision: number
  reservedBytes: number
  cleanupMetadataBytes: number
  protocolStageAllowance: SkillOptNativeTrainerProtocolStageAllowance
  used: boolean
}
const nativeTrainerMaterializationAllowances = new WeakMap<object, NativeTrainerMaterializationAllowanceState>()
const nativeTrainerProtocolStageAllowances = new WeakMap<object, NativeTrainerProtocolStageAllowanceState>()
type NativeCampaignArtifactStageAllowanceState = {
  controllerIdentity: object
  owner: SessionStore
  runtime: ExecutionRuntime
  ownerProof: OwnerProof
  prepared: SkillOptPrepared
  preparedState: PreparedState
  bindingHashes: ReturnType<typeof skillOptBindingHashes>
  metadata: SkillOptNativeCampaignArtifactStageMetadata
  metadataCanonical: string
  trainerEvent?: NativeTrainerProtocolEventState
  reservation?: NativeTrainerProtocolReservationState
  targetPlan?: NativeCampaignTargetPlanState
  target?: NativeCampaignTargetResponseState
  mode: "prestart" | "running"
  runState: "PREPARED" | "CONSENTED" | "ARMED" | "RUNNING"
  revision: number
  used: boolean
}
const nativeCampaignArtifactStageAllowances = new WeakMap<object, NativeCampaignArtifactStageAllowanceState>()
type NativeTrainerProtocolCaptureState = {
  controllerIdentity: object
  owner: SessionStore
  runtime: ExecutionRuntime
  ownerProof: OwnerProof
  prepared: SkillOptPrepared
  preparedState: PreparedState
  bindingHashes: ReturnType<typeof skillOptBindingHashes>
  schedule: NativeCampaignSchedule
  profile: SkillOptWorkerProfile
  receipt: SkillOptContainmentReceipt
  profileSha256: string
  receiptBindingSha256: string
  wire: ReturnType<typeof createNativeTrainerWireForSchedule>
  originalSkill: string
  lastOrdinal: number
  events: Map<string, NativeTrainerProtocolEventState>
  candidateSkill?: string
  stopped: boolean
  completed: boolean
}
type NativeTrainerProtocolEventState = {
  controllerIdentity: object
  capture: NativeTrainerProtocolCaptureState
  event: NativeTrainerProtocolEventBinding
  request: NativeTrainerWireRequest
  description: SkillOptNativeTrainerProtocolEventDescription
  reservationAttempted: boolean
  reservationRequestId?: string
  targetPlan?: NativeCampaignTargetPlanState
  associationAttempted?: boolean
  associatedWarmupReservation?: NativeTrainerProtocolReservationState
  optimizerResponseAttempted?: boolean
  optimizerResponseConsumed?: boolean
}
type NativeTrainerProtocolReservationState = {
  controllerIdentity: object
  event?: NativeTrainerProtocolEventState
  requestId: string
  reservationId: string
  runId: string
  role: SkillOptRequestRole
  phase: SkillOptRequestPhase
}
type NativeTrainerOptimizerResponseAllowanceState = {
  controllerIdentity: object
  owner: SessionStore
  runtime: ExecutionRuntime
  prepared: SkillOptPrepared
  preparedState: PreparedState
  ownerProof: OwnerProof
  bindingHashes: ReturnType<typeof skillOptBindingHashes>
  event: NativeTrainerProtocolEventState
  reservation: SkillOptReservation
  reservationState: NativeTrainerProtocolReservationState
  message: SkillOptNativeTrainerOptimizerResponseMessage
  used: boolean
}
type NativeCampaignTargetPlanState = {
  controllerIdentity: object
  owner: SessionStore
  runtime: ExecutionRuntime
  ownerProof: OwnerProof
  prepared: SkillOptPrepared
  preparedState: PreparedState
  bindingHashes: ReturnType<typeof skillOptBindingHashes>
  schedule: NativeCampaignSchedule
  scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry
  fixtureId: string
  targetSkillSha256: string
  promptSha256: string
  event?: NativeTrainerProtocolEventState
  boundReservation?: SkillOptReservation
}
type NativeCampaignTargetBindingState = {
  controllerIdentity: object
  plan: NativeCampaignTargetPlanState
  reservation: SkillOptReservation
  reservationState: NativeTrainerProtocolReservationState
  responseAttempted: boolean
  response?: NativeCampaignTargetResponseState
}
type NativeCampaignTargetResponseState = {
  controllerIdentity: object
  binding: NativeCampaignTargetBindingState
  promptSha256: string
  responseSha256: string
  responseBytes: number
  associatedEvent?: NativeTrainerProtocolEventState
}
const nativeTrainerProtocolCaptures = new WeakMap<object, NativeTrainerProtocolCaptureState>()
const nativeTrainerProtocolEvents = new WeakMap<object, NativeTrainerProtocolEventState>()
const nativeTrainerProtocolReservations = new WeakMap<object, NativeTrainerProtocolReservationState>()

/** Consumes the private, manifest-sized staging authority before the host creates output/protocol.json. */
export function consumeNativeTrainerProtocolStageAllowance(
  allowance: SkillOptNativeTrainerProtocolStageAllowance,
  expected: SkillOptNativeTrainerMaterializationMetadata,
): void {
  const key = allowance && typeof allowance === "object" ? allowance as object : undefined
  const state = key ? nativeTrainerProtocolStageAllowances.get(key) : undefined
  if (!state || state.used || !validNativeTrainerMaterializationMetadata(expected) ||
      canonicalJson(expected) !== canonicalJson(state.metadata)) {
    fail("binding-invalid")
  }
  nativeTrainerProtocolStageAllowances.set(key!, Object.freeze({ ...state, used: true }))
}

/** Returns only digest/count metadata for private host binding; it does not expose or spend the allowance. */
export function nativeTrainerProtocolStageAllowanceMetadata(
  allowance: SkillOptNativeTrainerProtocolStageAllowance,
): SkillOptNativeTrainerMaterializationMetadata {
  const key = allowance && typeof allowance === "object" ? allowance as object : undefined
  const state = key ? nativeTrainerProtocolStageAllowances.get(key) : undefined
  if (!state) fail("binding-invalid")
  return Object.freeze({ ...state.metadata })
}

type ConsentState = {
  runId: string; consentId: string; subjectHash: string; bindingHash: string; owner: SessionStore; ownerSessionHash: string
  campaign: CampaignDisclosure
  ownerEpochHash: string; admissionHash: string; expiresBoot: string; expiresCont: bigint; expiresWall: bigint; used: boolean
}
type ArmState = {
  runId: string; armId: string; consentId: string; bindingHash: string; owner: SessionStore; ownerSessionHash: string
  preparedState: PreparedState
  ownerEpochHash: string; admissionHash: string; expiresBoot: string; expiresCont: bigint; expiresWall: bigint
  seenDigestHashes: Set<string>; armedAtWall: bigint; used: boolean
}
type OwnerProof = { sessionHash: string; epochHash: string; admissionHash: string }
type ReentryState = {
  snapshot: StoredReentrySnapshot
  owner: SessionStore
  ownerProof: OwnerProof
  lease: AdmissionLease
  admissionFenceHash: string
  binding: { dataset: NativeDataset; hashes: ReturnType<typeof skillOptBindingHashes>; campaign: CampaignDisclosure }
  priorAttachment: SessionAttachmentInspection
  priorAttachmentHash: string
  state: "PREPARED" | "CONSENTED" | "ARMED"
  revision: number
  campaignId: string
  expiresBoot: string
  expiresCont: bigint
  expiresWall: bigint
  expectedConsentId?: string
  expectedArm?: Readonly<{ armId: string; consentId: string; watermarkHash: string; seenDigestHashes: string; armedBoot: string; armedCont: string; armedWall: string; expiresBoot: string; expiresCont: string; expiresWall: string }>
  decisionBinding: DecisionBinding
  used: boolean
}
type TicketState = {
  runId: string; reservationId: string; requestId: string; role: SkillOptRequestRole; phase: SkillOptRequestPhase
  bindingSha256: string; scheduleSha256: string; owner: SessionStore; ownerProof: OwnerProof; clock: ClockValues; consent?: ConsentState
  consumed: boolean; grantIssued: boolean; recorded: boolean; receiptState: ReceiptState
  nativeCanary?: Readonly<{ owner: SessionStore; ownerProof: OwnerProof; runtime: ExecutionRuntime; operation: "apply" | "rollback" }>
}
type ReceiptState = { runId: string; reservationId: string; requestId: string; owner: SessionStore; ownerProof: OwnerProof; clock: ClockValues; ticketConsumed: boolean; recorded: boolean; ticketState: TicketState }
type PrivateTextCleanupChallengeState = {
  snapshot: PrivateTextCleanupSnapshot
  eligibility: PrivateTextCleanupEligibility
  owner: SessionStore
  runtime: ExecutionRuntime
  mutationClaim: ExecutionClaim
  ownerProof: OwnerProof
  decisionBinding: DecisionBinding
  metadata: SkillOptPrivateTextCleanupMetadata
  artifactBytes: number
  trainerSnapshotSha256: string | null
  used: boolean
}
type PrivateTextCleanupDeletionState = {
  worktree: string
  runId: string
  kind: "input" | "trainer"
  snapshotSha256: string
  runtime: ExecutionRuntime
  owner: SessionStore
  mutationClaim: ExecutionClaim
  ownerProof: OwnerProof
  ledger: SkillOptAutomationLedger
  retirementId: string
  revision: number
  runState: SkillOptRunState
  decisionSubjectHash: string
  used: boolean
}
const privateTextCleanupDeletionTokens = new WeakMap<object, PrivateTextCleanupDeletionState>()

function mintPrivateTextCleanupDeletion(state: Omit<PrivateTextCleanupDeletionState, "used">): SkillOptPrivateTextDeletion {
  const token = Object.freeze({}) as SkillOptPrivateTextDeletion
  privateTextCleanupDeletionTokens.set(token as object, { ...state, used: false })
  return token
}

type Subject = DecisionBinding["subject"]
function campaignPreviewMatches(value: unknown, campaign: CampaignDisclosure): boolean {
  if (!value || typeof value !== "object") return false
  const preview = value as Record<string, unknown>
  return preview.scheduleSha256 === campaign.scheduleSha256 && preview.targetRequests === campaign.targetRequests &&
    preview.canaryReserve === campaign.canaryReserve && preview.targetRequestCap === campaign.targetRequestCap
}

function assertConsentDecision(decision: OperatorDecision, state: PreparedState, prepared: SkillOptPrepared): void {
  if (decision.sessionID !== state.owner.sessionID || decision.workflowID !== prepared.runId || decision.expectedRevision !== state.decisionRevision ||
      decision.subject.kind !== "experiment-unit" || decision.subject.id !== prepared.runId || decision.subject.sha256 !== prepared.consentBindingSha256 ||
      !campaignPreviewMatches(prepared, state.campaign)) {
    fail("consent-binding-drift")
  }
}

function mintDispatch(
  reservationId: string, requestId: string, runId: string, role: SkillOptRequestRole, phase: SkillOptRequestPhase,
  bindingSha256: string, proof: OwnerProof, ticketStates: WeakMap<object, TicketState>, receiptStates: WeakMap<object, ReceiptState>,
  owner: SessionStore, consent: ConsentState, clock: ClockValues,
): { ticket: SkillOptDispatchTicket; receipt: SkillOptDispatchReceipt } {
  const ticket = Object.freeze({}) as SkillOptDispatchTicket
  const receipt = Object.freeze({}) as SkillOptDispatchReceipt
  const ticketState: TicketState = { runId, reservationId, requestId, role, phase, bindingSha256,
    scheduleSha256: consent.campaign.scheduleSha256, owner,
    ownerProof: proof, clock, consumed: false, grantIssued: false, recorded: false,
    receiptState: undefined as unknown as ReceiptState, ...(consent ? { consent } : {}) }
  const receiptState: ReceiptState = { runId, reservationId, requestId, owner, ownerProof: proof,
    clock: ticketState.clock, ticketConsumed: false, recorded: false, ticketState }
  ticketState.receiptState = receiptState
  ticketStates.set(ticket as object, ticketState)
  receiptStates.set(receipt as object, receiptState)
  return { ticket, receipt }
}

function validateExecutionReference(reference: ExecutionReference, requestId: string): void {
  if (!reference || typeof reference !== "object" || Array.isArray(reference) || reference.executionID !== requestId ||
      Object.keys(reference).some((key) => !["executionID", "vendorSessionID", "vendorThreadID", "vendorTurnID"].includes(key)) ||
      Object.values(reference).some((value) => value !== undefined && (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)))) fail("recovery-unresolved")
}

function assertPersistedExecutionReference(
  runtime: ExecutionRuntime, nativeHost: SkillOptNativeHost, owner: SessionStore, reference: ExecutionReference,
  failure: "dispatch-ambiguous" | "recovery-unresolved",
): void {
  try {
    validateExecutionReference(reference, reference.executionID)
    const identity = nativeHost.identityFor(reference)
    if (!identity || (identity.engine !== "codex" && identity.engine !== "claude") || identity.profile !== "legacy-unowned" ||
        identity.controlProfile !== "estimated-input-reactive-output-v1" || typeof identity.policyID !== "string" ||
        identity.policyID.length === 0 || identity.policyID.length > 512 ||
        !(identity.role === "target" || identity.role === "optimizer" || identity.role === "reviewer") ||
        !(identity.phase === "train" || identity.phase === "dev" || identity.phase === "final" || identity.phase === "safety" || identity.phase === "canary")) fail(failure)
    const matches = runtime.runs.status().executions.filter((record) => record.executionId === reference.executionID)
    if (matches.length !== 1) fail(failure)
    const record = matches[0]!
    if (record.ownerSession !== owner.sessionID || record.nativeExecution !== true || record.engine !== identity.engine ||
        record.profile !== identity.profile || record.controlProfile !== identity.controlProfile || record.policyID !== identity.policyID ||
        record.role !== identity.role || record.taskId !== `skillopt:${identity.role}:${identity.phase}:${reference.executionID}` ||
        record.kind !== "host" || record.hostDispatch !== "started" || !record.boundaryRef ||
        !isDeepStrictEqual(record.boundaryRef, reference)) fail(failure)
  } catch { fail(failure) }
}

function assertNoPersistedHostDispatch(runtime: ExecutionRuntime, owner: SessionStore, requestId: string): void {
  try {
    const matches = runtime.runs.status().executions.filter((record) => record.executionId === requestId)
    if (matches.some((record) => {
      const hasVendorReference = Object.entries(record.boundaryRef ?? {})
        .some(([key, value]) => ["vendorSessionID", "vendorThreadID", "vendorTurnID"].includes(key) && typeof value === "string")
      const terminalIsQuiescentNotDispatched = record.terminal?.outcome === "not-dispatched" && typeof record.terminal.quiescentAt === "number"
      return record.ownerSession !== owner.sessionID || record.kind === "verifier" || record.hostDispatch === "started" ||
        record.vendorRef !== undefined || (record.terminal !== undefined && !terminalIsQuiescentNotDispatched) || hasVendorReference
    })) fail("dispatch-ambiguous")
  } catch { fail("dispatch-ambiguous") }
}

function validReconciliation(value: unknown): value is ExecutionReconciliation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return Object.keys(result).length === 3 && (result.outcome === "running" || result.outcome === "terminal" || result.outcome === "unknown") &&
    typeof result.quiescent === "boolean" && typeof result.evidence === "string" && result.evidence.length > 0 &&
    result.evidence.length <= 4096 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result.evidence)
}

/** Fixed-account production controller. No caller-provided database path, HOME, clock sample, or approval factory. */
export function createSkillOptController(
  runtime: ExecutionRuntime,
  nativeHelper: PromotionNativeHelperInput,
  nativeHost: SkillOptNativeHost,
): SkillOptController {
  return makeController(runtime, nativeHelper, nativeHost)
}

/** Pure clock and binding helpers used for deterministic contract tests; neither creates consent nor dispatch authority. */
export const SKILLOPT_CONTROLLER_LIMITS = Object.freeze({
  consentMilliseconds: Number(CONSENT_TTL_MS), applyMilliseconds: Number(APPLY_TTL_MS), runMilliseconds: Number(RUN_TTL_MS),
  dailyCooldownMilliseconds: Number(DAILY_COOLDOWN_NS / 1_000_000n), minimumNewDigests: MIN_NEW_DIGESTS,
  targetReservedRequests: TARGET_RESERVE,
  targetRequests: NATIVE_SKILLOPT_LIMITS.targetRequests, optimizerRequests: NATIVE_SKILLOPT_LIMITS.optimizerRequests,
  reviewerRequests: NATIVE_SKILLOPT_LIMITS.reviewerRequests, activeMilliseconds: NATIVE_SKILLOPT_LIMITS.activeMilliseconds,
  requestMilliseconds: NATIVE_SKILLOPT_LIMITS.requestMilliseconds, artifactBytes: NATIVE_SKILLOPT_LIMITS.artifactBytes,
  candidateSteps: NATIVE_SKILLOPT_LIMITS.candidateSteps,
})

export function validateSkillOptClockSample(value: unknown): SkillOptClockSample {
  return validatedClock(value)
}
