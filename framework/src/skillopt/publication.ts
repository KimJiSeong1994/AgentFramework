import { randomUUID } from "node:crypto"
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, writeSync,
} from "node:fs"
import { join } from "node:path"
import type { Terminal } from "../hosts/interactive-session.ts"
import { terminalSafeText } from "../hosts/terminal-text.ts"
import { consumeOperatorDecision, humanDecision, type OperatorDecision } from "../hosts/operator.ts"
import type { ExecutionClaim } from "../hosts/run-state.ts"
import { ensureDurableDirectory } from "../state/durable.ts"
import { executionRunDirectory } from "../state/store.ts"
import { NATIVE_EVALUATION_PROTOCOL_SHA256 } from "./evaluation.ts"
import type { NativeQualificationMetrics } from "./evaluation.ts"
import { NATIVE_PROTOCOL_SHA256, type NativeDataset } from "./dataset.ts"
import type { NativeCampaignReviewerEvidence } from "./campaign.ts"
import { SkillOptBrokerError } from "./broker.ts"
import {
  applySkillOptPromotion, authorizeNativePromotionApproval, nativePromotionMutationIsQuiescent,
  nativePromotionArtifactBudget, previewNativePromotionApproval, PromotionError, rollbackSkillOptPromotion,
  type PromotionBindings, type PromotionCommon, type PromotionEvidence,
} from "./promotion.ts"
import type {
  SkillOptController, SkillOptControllerStatus, SkillOptCurrentBinding, SkillOptQualifiedPublicationBinding,
  SkillOptRollbackIntent,
} from "./controller.ts"
import { SkillOptControllerError } from "./controller.ts"
import { NativeLoadVerificationError } from "./load-verification.ts"
import {
  assembleSkill, canonicalJson, COMPILE_ANCHOR, extractFragment, NATIVE_SKILLOPT_LIMITS, PILOT_LIMITS, PILOT_SKILL, sha256,
} from "./pilot.ts"
import type { NativeSkillOptForegroundCampaignData } from "./foreground.ts"
import type { BuiltSkillOptNativeHelper } from "./native-helper.ts"

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MAX_REVIEW_BYTES = 1024 * 1024
const HASH = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const CANARY_STATES = new Set(["COMMITTED", "ROLLED_BACK", "FAILED", "CANCELLED", "BLOCKED", "UNRESOLVED"])
const CANARY_PROMOTION_STATES = new Set([
  "SWAPPED_EXPECTED", "RACE_PRESERVED", "RECOVERY_REQUIRED", "LOAD_VERIFIED", "COMMITTED",
  "ROLLBACK_SWAP_INTENT", "ROLLBACK_RACE_PRESERVED", "ROLLED_BACK",
])
const CANARY_PHASES = new Set([
  "preflight", "promotion-handoff", "controller-canary-preparation", "live-target-validation", "canary-plan",
  "fresh-runtime", "fresh-policy", "fresh-host-preflight", "fresh-loader-admission", "fresh-loader-attachment",
  "fresh-loader-roots", "skill-session-create", "skill-invocation-prepare", "native-canary-reservation",
  "execution-claim", "execution-intent", "skill-loader-binding", "canary-dispatch-consumption", "host-prepare",
  "host-run", "execution-reconciliation", "canary-witness-completion", "promotion-commit", "controller-canary-completion",
])

type PublicationInput = Readonly<{
  data: NativeSkillOptForegroundCampaignData
  controller: SkillOptController
  nativeHelper: BuiltSkillOptNativeHelper
  terminal: Terminal
  signal?: AbortSignal
}>

type PublicationEvidence = Readonly<{
  qualification: Readonly<{ path: string; sha256: string }>
  review: Readonly<{ path: string; sha256: string }>
}>

type ApplyPublicationStage = "approved" | "mutating" | "swapped" | "canary-failed" | "committed" | "unresolved"
type RollbackPublicationStage = "approved" | "mutating" | "restored-awaiting-canary" | "canary-failed" | "rolled-back" | "unresolved"

type PrivatePublicationContext = {
  data: NativeSkillOptForegroundCampaignData
  owner: NativeSkillOptForegroundCampaignData["owner"]
  runtime: NativeSkillOptForegroundCampaignData["runtime"]
  broker: NativeSkillOptForegroundCampaignData["broker"]
  controller: SkillOptController
  nativeHelper: BuiltSkillOptNativeHelper
  common: PromotionCommon
  publicationEvidence: PublicationEvidence
  evidence?: PromotionEvidence
  qualification: SkillOptQualifiedPublicationBinding
  fixtureId: string
  applyState?: string
  applyQuiescent: boolean
  applyStage: ApplyPublicationStage
  mutationClaim?: ExecutionClaim
  rollbackAttempted: boolean
  rollbackIntent?: SkillOptRollbackIntent
  rollbackStage?: RollbackPublicationStage
}

type NativeSkillOptReviewView = Readonly<{
  operation: "apply" | "rollback"
  runId: string
  decisionSubjectSha256: string
  details: Readonly<Record<string, unknown>>
  bindingSha256: string
  qualification: SkillOptQualifiedPublicationBinding
  reviewSha256: string
  bindings: PromotionBindings
  candidateByteLength: number
  dataset: NativeDataset
  metrics: NativeQualificationMetrics
  providerTokenMaximumEnforced: false
  artifactBudget: ReturnType<typeof nativePromotionArtifactBudget>
  status: SkillOptControllerStatus
  canaryReserve: number
  diff: Readonly<{
    fragment: string
    insertedBytes: Buffer
    protectedPrefixBytes: number
    protectedPrefixSha256: string
    protectedSuffixBytes: number
    protectedSuffixSha256: string
    prefixUnchanged: boolean
    suffixUnchanged: boolean
    exactReassembly: boolean
  }>
  applyApprovalSha256?: string
}>

const publishedContexts = new WeakMap<object, PrivatePublicationContext>()
const PUBLIC_STATES = new Set(["COMMITTED", "ROLLED_BACK", "REJECTED", "CANCELLED", "BLOCKED", "UNRESOLVED"])
// Exact source-owned codes only; arbitrary errors, messages, and out-of-list codes stay generic.
const SAFE_CONTROLLER_FAILURE_CODES = new Set([
  "data-required", "storage-not-initialized", "storage-missing", "storage-corrupt", "storage-permission",
  "binding-invalid", "binding-data-drift", "binding-model-drift", "binding-protocol-drift", "binding-baseline-drift",
  "owner-unavailable", "admission-held", "owner-busy", "consent-required", "consent-expired", "consent-binding-drift",
  "operator-rejected", "arm-required", "arm-expired", "arm-consumed", "digest-threshold", "daily-limit", "active-run",
  "dispatch-pending", "clock-invalid", "clock-uncertain", "budget-exhausted", "run-expired", "run-stale",
  "qualification-required", "canary-handoff-invalid", "canary-runtime-mismatch", "dispatch-not-authorized", "dispatch-ambiguous",
  "dispatch-cancelled", "recovery-unavailable", "recovery-unresolved", "revision-conflict", "transaction-failed",
  "private-text-cleanup-ineligible", "private-text-cleanup-not-expired",
])
const SAFE_ROLLBACK_CONTROLLER_FAILURE_CODES = new Set([
  "rollback-intent-invalid", "rollback-approval-binding-mismatch", "rollback-canary-handoff-invalid",
])
const SAFE_BROKER_FAILURE_CODES = new Set([
  "invalid_request", "dataset_invalid", "binding_drift", "owner_unavailable", "owner_busy", "dispatch_not_authorized",
  "native_identity_unavailable", "native_execution_failed", "sensitive_input", "response_limit", "empty_response",
  "unsafe_response", "cancelled", "not_active", "execution_unresolved", "controller_unavailable",
])
const SAFE_PROMOTION_FAILURE_CODES = new Set([
  "native-approval-preview-invalid", "native-approval-admission-unavailable", "native-approval-clock-uncertain",
  "native-approval-run-deadline-invalid", "native-approval-expired-or-clock-reset", "native-helper-protocol-mismatch",
  "native-helper-failed", "native-helper-digest-mismatch", "native-exchange-invalid-json", "native-exchange-invalid-report",
  "native-exchange-output-too-large", "native-exchange-extra-output", "native-exchange-exit-invalid", "native-exchange-start-failed",
  "native-exchange-response-missing", "native-exchange-failed", "native-lock-protocol-invalid", "native-lock-start-failed",
  "native-lock-failed", "promotion-busy", "native-load-mode-required", "native-authorization-required",
  "native-authorization-required-or-consumed", "native-load-proof-required",
])
const SAFE_ROLLBACK_PROMOTION_FAILURE_CODES = new Set([
  "native-rollback-approval-input-invalid", "native-rollback-handoff-not-awaiting-canary",
  "native-rollback-handoff-semantic-review-missing", "native-rollback-handoff-unavailable-or-issued",
  "native-rollback-handoff-observation-drift", "native-rollback-handoff-invalid-or-consumed",
  "native-rollback-handoff-binding-mismatch", "native-rollback-handoff-evidence-invalid",
  "native-rollback-handoff-transaction-invalid", "native-rollback-not-awaiting-load-witness",
  "native-rollback-approval-binding-mismatch", "native-rollback-handoff-intent-missing",
])
const SAFE_APPLY_PROMOTION_FAILURE_CODES = new Set([
  "native-apply-approval-input-invalid", "native-apply-approval-candidate-invalid", "native-apply-approval-evidence-required",
  "native-handoff-not-awaiting-canary", "native-handoff-manifest-mismatch", "native-handoff-object-binding-mismatch",
  "native-handoff-evidence-drift", "native-handoff-transaction-changed", "native-handoff-already-issued",
  "native-handoff-invalid-or-consumed", "native-handoff-semantic-review-missing", "native-promotion-not-awaiting-load-witness",
  "native-handoff-swap-record-missing",
])
const SAFE_LOAD_VERIFICATION_FAILURE_CODES = new Set([
  "native-load-mode-required", "canary-approval-fixture-mismatch", "canary-project-root-binding-mismatch",
  "canary-fixture-pack-invalid", "canary-fixture-not-approved-dev-split", "canary-protocol-binding-mismatch",
  "canary-skill-bytes-binding-mismatch", "canary-evaluator-prompt-invalid", "canary-task-size-invalid",
  "canary-instructions-size-invalid", "canary-plan-failed-closed", "canary-plan-is-copied-or-stale",
  "host-completion-invalid", "host-completion-binding-invalid", "native-load-observation-does-not-match-plan",
  "native-load-witness-binding-mismatch", "native-load-canary-not-passed", "native-load-proof-invalid-or-consumed",
  "native-load-proof-binding-mismatch",
])

function fail(code: string): never {
  throw Object.assign(new Error(code), { code })
}

function guardFor(
  data: NativeSkillOptForegroundCampaignData,
  controller: SkillOptController,
  expected: Readonly<{ candidateSha256: string; resultsSha256: string; reviewSha256: string }>,
  mutationClaim?: ExecutionClaim,
): SkillOptQualifiedPublicationBinding {
  return controller.assertQualifiedPublication({
    owner: data.owner,
    runId: data.runId,
    current: data.current,
    ...(mutationClaim ? { mutationClaim } : {}),
    ...expected,
  })
}

function sameGuard(left: SkillOptQualifiedPublicationBinding, right: SkillOptQualifiedPublicationBinding): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function isPrivateDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return !stat.isSymbolicLink() && stat.isDirectory() && stat.uid === process.getuid?.() &&
      (stat.mode & 0o777) === PRIVATE_DIRECTORY_MODE
  } catch { return false }
}

function serializePrivateRecord(value: unknown): Buffer {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8")
  if (bytes.length === 0 || bytes.length > MAX_REVIEW_BYTES) fail("publication_evidence_size_invalid")
  return bytes
}

function writePrivateRecord(directory: string, name: string, bytes: Uint8Array): Readonly<{ path: string; sha256: string }> {
  const content = Buffer.from(bytes)
  if (content.length === 0 || content.length > MAX_REVIEW_BYTES) fail("publication_evidence_size_invalid")
  const path = join(directory, name)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), PRIVATE_FILE_MODE)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== PRIVATE_FILE_MODE) {
      fail("publication_evidence_identity_invalid")
    }
    let offset = 0
    while (offset < content.length) {
      const written = writeSync(fd, content, offset, content.length - offset)
      if (written <= 0) fail("publication_evidence_write_failed")
      offset += written
    }
    fsyncSync(fd)
    const after = fstatSync(fd)
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== content.length ||
        after.nlink !== 1 || after.uid !== process.getuid?.() || (after.mode & 0o777) !== PRIVATE_FILE_MODE) {
      fail("publication_evidence_identity_changed")
    }
  } finally { closeSync(fd) }
  const directoryFd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  return Object.freeze({ path, sha256: sha256(content) })
}

function assertPublicationArtifactReservation(
  status: SkillOptControllerStatus,
  runId: string,
  operation: "apply" | "rollback",
): void {
  const eligible = operation === "apply"
    ? status.state === "AWAITING_CANDIDATE_APPROVAL"
    : status.state === "COMPLETED" || status.state === "AWAITING_CANDIDATE_APPROVAL"
  if (status.runId !== runId || !eligible || status.pendingDispatch) fail("publication_artifact_budget_unavailable")
}

function assertArtifactBudget(budget: ReturnType<typeof nativePromotionArtifactBudget>): void {
  if (!budget || !Number.isSafeInteger(budget.approvalBytes) || budget.approvalBytes <= 0 ||
      !Number.isSafeInteger(budget.transactionBytes) || budget.transactionBytes <= 0 ||
      !Number.isSafeInteger(budget.witnessBytes) || budget.witnessBytes <= 0 ||
      !Number.isSafeInteger(budget.approvalBytes + budget.transactionBytes + budget.witnessBytes)) {
    fail("publication_artifact_budget_invalid")
  }
}

function reservePublicationArtifactBytes(input: {
  publication: PublicationInput
  operation: "apply" | "rollback"
  bytes: number
  headroomBytes: number
  mutationClaim?: ExecutionClaim
}): SkillOptControllerStatus {
  const { publication, operation, bytes, headroomBytes, mutationClaim } = input
  const status = publication.controller.reserveNativePublicationArtifacts({
    owner: publication.data.owner,
    runtime: publication.data.runtime,
    runId: publication.data.runId,
    current: publication.data.current,
    operation,
    ...(mutationClaim ? { mutationClaim } : {}),
    bytes,
    headroomBytes,
  })
  assertPublicationArtifactReservation(status, publication.data.runId, operation)
  return status
}

function prepareEvidence(
  input: PublicationInput,
  bindings: PromotionBindings,
  semanticReview: readonly NativeCampaignReviewerEvidence[],
): PublicationEvidence {
  const root = realpathSync.native(input.data.runtime.worktree)
  const executionRoot = executionRunDirectory(root)
  const directory = join(executionRoot, "skillopt-native-publication-evidence", input.data.runId, randomUUID())
  ensureDurableDirectory(directory)
  if (!isPrivateDirectory(directory)) fail("publication_evidence_directory_invalid")
  const qualificationBytes = serializePrivateRecord({
    schemaVersion: 1,
    bindings,
    decision: "qualified",
    reasons: [],
  })
  reservePublicationArtifactBytes({ publication: input, operation: "apply", bytes: qualificationBytes.byteLength, headroomBytes: 0 })
  const qualification = writePrivateRecord(directory, "qualification.json", qualificationBytes)
  const reviewBytes = serializePrivateRecord({
    schemaVersion: 1,
    bindings,
    qualificationSha256: qualification.sha256,
    reviewerId: "native-campaign-reviewer",
    verdict: "approve",
    semanticReview,
  })
  reservePublicationArtifactBytes({ publication: input, operation: "apply", bytes: reviewBytes.byteLength, headroomBytes: 0 })
  const review = writePrivateRecord(directory, "review.json", reviewBytes)
  return Object.freeze({ qualification, review })
}

function promotionBindings(data: NativeSkillOptForegroundCampaignData, root: string): Readonly<{
  bindings: PromotionBindings
  candidateBytes: Buffer
  semanticReview: readonly NativeCampaignReviewerEvidence[]
  candidateSha256: string
  resultsSha256: string
  reviewSha256: string
  fixtureId: string
}> {
  const campaign = data.campaignResult
  const candidate = campaign.candidate
  const metrics = campaign.metrics
  const reviewers = campaign.reviewerEvidence
  if (campaign.status !== "AWAITING_CANDIDATE_APPROVAL" || !candidate || !metrics || metrics.status !== "METRICS_PASSED" ||
      !reviewers || reviewers.length !== 2 || reviewers[0]?.phase !== "final" || reviewers[1]?.phase !== "safety" ||
      reviewers.some(item => item.status !== "valid" || item.assessment !== "clear" || item.findings.length !== 0)) {
    fail("qualified_campaign_data_invalid")
  }
  const dataset = data.current.dataset as NativeDataset
  const fixture = dataset.fixturePack.fixtures.find(item => item.split === "dev")
  const target = dataset.modelBindings.target
  if (!fixture || !candidate.skill || typeof candidate.skill !== "string") fail("qualified_campaign_data_invalid")
  const candidateBytes = Buffer.from(candidate.skill, "utf8")
  const candidateSha256 = sha256(candidateBytes)
  const resultsSha256 = sha256(canonicalJson(metrics))
  const reviewSha256 = sha256(canonicalJson(reviewers))
  if (!HASH.test(candidateSha256) || candidateSha256 !== candidate.sha256 || !HASH.test(resultsSha256) ||
      !HASH.test(reviewSha256) || !Buffer.from(candidateBytes.toString("utf8"), "utf8").equals(candidateBytes)) {
    fail("qualified_campaign_digest_mismatch")
  }
  const canaryFixtureSha256 = sha256(canonicalJson(fixture))
  const bindings: PromotionBindings = Object.freeze({
    witnessMode: "native",
    runId: data.runId,
    rootBinding: sha256(`root:${root}`),
    sourceSha256: dataset.sourceExportSha256,
    originalSha256: data.prepared.baselineSkillSha256,
    candidateSha256,
    fixturePackSha256: dataset.fixturePackSha256,
    canaryFixtureSha256,
    protocolSha256: NATIVE_PROTOCOL_SHA256,
    evaluatorSha256: NATIVE_EVALUATION_PROTOCOL_SHA256,
    runtimeSha256: sha256(canonicalJson(target.runtimeIdentity)),
    resultsSha256,
    witnessSha256: sha256(canonicalJson({
      schema: "skillopt.native-qualified-candidate.v1",
      runId: data.runId,
      bindingSha256: data.bindingSha256,
      candidateSha256,
      resultsSha256,
      reviewSha256,
    })),
    nativeEngine: target.engine,
    nativeModel: target.requestedModel,
    nativeProfileId: target.profileIdentity.id,
    nativeProfileSha256: target.profileIdentity.sha256,
    nativeRuntimeVersion: target.runtimeIdentity.version,
    nativeExecutableSha256: target.runtimeIdentity.executableSha256,
  })
  return Object.freeze({ bindings, candidateBytes, semanticReview: reviewers, candidateSha256, resultsSha256, reviewSha256,
    fixtureId: fixture.id })
}

function terminalApprovalMatches(receipt: OperatorDecision, binding: { sessionID: string; workflowID: string; expectedRevision: number; subject: { kind: string; id: string; sha256: string } }): boolean {
  return receipt.sessionID === binding.sessionID && receipt.workflowID === binding.workflowID &&
    receipt.expectedRevision === binding.expectedRevision && receipt.subject.kind === binding.subject.kind &&
    receipt.subject.id === binding.subject.id && receipt.subject.sha256 === binding.subject.sha256
}

function publicResult(input: {
  operation?: "publish" | "rollback"
  state: "COMMITTED" | "ROLLED_BACK" | "REJECTED" | "CANCELLED" | "BLOCKED" | "UNRESOLVED"
  runId: string
  candidateQualified?: boolean
  reasonCode?: string
  controllerState?: string
  revision?: number
  publicationAuthorized?: boolean
  postApplyHandoffAuthorized?: boolean
  rollbackAuthorized?: boolean
  postRollbackHandoffAuthorized?: boolean
  canaryStatus?: "COMMITTED" | "ROLLED_BACK" | "FAILED" | "CANCELLED" | "BLOCKED" | "UNRESOLVED"
  canaryReasonCode?: string
  canaryPhase?: string
  canaryErrorCode?: string
  canaryPromotionState?: "SWAPPED_EXPECTED" | "RACE_PRESERVED" | "RECOVERY_REQUIRED" | "LOAD_VERIFIED" | "COMMITTED" |
    "ROLLBACK_SWAP_INTENT" | "ROLLBACK_RACE_PRESERVED" | "ROLLED_BACK"
  canaryControllerState?: string
}): Readonly<Record<string, unknown>> {
  const safeRunId = UUID.test(input.runId) ? input.runId : "unknown"
  const reasonCode = input.reasonCode && /^[a-z0-9][a-z0-9_:-]{0,95}$/iu.test(input.reasonCode)
    ? input.reasonCode : input.reasonCode ? "publication_unresolved" : undefined
  const controllerState = input.controllerState && /^[A-Z][A-Z0-9_]{0,47}$/u.test(input.controllerState)
    ? input.controllerState : undefined
  const canaryReasonCode = input.canaryReasonCode && /^[a-z0-9][a-z0-9_:-]{0,95}$/iu.test(input.canaryReasonCode)
    ? input.canaryReasonCode : undefined
  const canaryPhase = input.canaryPhase && CANARY_PHASES.has(input.canaryPhase) ? input.canaryPhase : undefined
  const canaryErrorCode = input.canaryErrorCode && /^[a-z0-9][a-z0-9_-]{0,95}$/iu.test(input.canaryErrorCode)
    ? input.canaryErrorCode : undefined
  const canaryControllerState = input.canaryControllerState && /^[A-Z][A-Z0-9_]{0,47}$/u.test(input.canaryControllerState)
    ? input.canaryControllerState : undefined
  return Object.freeze({
    operation: input.operation ?? "publish",
    state: PUBLIC_STATES.has(input.state) ? input.state : "UNRESOLVED",
    runId: safeRunId,
    ...(reasonCode ? { reasonCode } : {}),
    ...(controllerState ? { controllerState } : {}),
    ...(Number.isSafeInteger(input.revision) && input.revision! >= 0 ? { revision: input.revision } : {}),
    ...(input.canaryStatus && CANARY_STATES.has(input.canaryStatus) ? { canaryStatus: input.canaryStatus } : {}),
    ...(canaryReasonCode ? { canaryReasonCode } : {}),
    ...(canaryPhase ? { canaryPhase } : {}),
    ...(canaryErrorCode ? { canaryErrorCode } : {}),
    ...(input.canaryPromotionState && CANARY_PROMOTION_STATES.has(input.canaryPromotionState)
      ? { canaryPromotionState: input.canaryPromotionState } : {}),
    ...(canaryControllerState ? { canaryControllerState } : {}),
    candidateQualified: input.candidateQualified ?? true,
    publicationAuthorized: input.publicationAuthorized ?? false,
    postApplyHandoffAuthorized: input.postApplyHandoffAuthorized ?? false,
    ...(input.operation === "rollback" ? {
      rollbackAuthorized: input.rollbackAuthorized ?? false,
      postRollbackHandoffAuthorized: input.postRollbackHandoffAuthorized ?? false,
    } : {}),
  })
}

/** @internal Pure classification only: this consumes no authority and retains no error payload. */
export function classifyNativeSkillOptPublicationFailure(operation: "apply" | "rollback", error: unknown): string {
  if (operation !== "apply" && operation !== "rollback") return "publication_unresolved"
  try {
    if (error instanceof SkillOptControllerError) {
      const code = error.code
      if (SAFE_CONTROLLER_FAILURE_CODES.has(code) ||
          (operation === "rollback" && SAFE_ROLLBACK_CONTROLLER_FAILURE_CODES.has(code))) return code
    }
    if (error instanceof SkillOptBrokerError) {
      const code = error.code
      if (SAFE_BROKER_FAILURE_CODES.has(code)) return code
    }
    if (error instanceof PromotionError) {
      const code = error.code
      if (SAFE_PROMOTION_FAILURE_CODES.has(code) ||
          (operation === "apply" && SAFE_APPLY_PROMOTION_FAILURE_CODES.has(code)) ||
          (operation === "rollback" && SAFE_ROLLBACK_PROMOTION_FAILURE_CODES.has(code))) return code
    }
    if (error instanceof NativeLoadVerificationError) {
      const code = error.code
      if (SAFE_LOAD_VERIFICATION_FAILURE_CODES.has(code)) return code
    }
  } catch { /* Thrown values and their properties are untrusted. */ }
  return "publication_unresolved"
}

function releaseMutationClaim(runtime: NativeSkillOptForegroundCampaignData["runtime"], claim: ExecutionClaim): boolean {
  try {
    runtime.runs.assertQuiescent(claim)
    runtime.runs.release(claim)
    return true
  } catch { return false }
}

function controllerMetadata(controller: SkillOptController): Pick<ReturnType<SkillOptController["status"]>, "state" | "revision"> | undefined {
  try {
    const status = controller.status()
    return { state: status.state, revision: status.revision }
  } catch { return undefined }
}

function samePublicationIdentity(context: PrivatePublicationContext, input: PublicationInput): boolean {
  const data = input.data
  return context.data === data && context.owner === data.owner && context.runtime === data.runtime &&
    context.broker === data.broker && context.controller === input.controller && context.nativeHelper === input.nativeHelper &&
    context.data.runId === data.runId && context.data.current === data.current
}

function finiteNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "missing"
}

function countValue(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "missing"
}

function pairedMetricsLine(label: string, metrics: NativeQualificationMetrics["dev"]): string {
  if (!metrics) return `${label}: missing (campaign metrics field)`
  return `${label} 평가: family 수=${countValue(metrics.families)}, paired trial 수=${countValue(metrics.trials)}, ` +
    `baseline 평균=${finiteNumber(metrics.baselineMean)}, candidate 평균=${finiteNumber(metrics.candidateMean)}, ` +
    `gain=${finiteNumber(metrics.gain)}, baseline 지연(ms)=${finiteNumber(metrics.baselineLatencyMs)}, ` +
    `candidate 지연(ms)=${finiteNumber(metrics.candidateLatencyMs)}, 지연 비율=${finiteNumber(metrics.latencyRatio)}`
}

/** @internal Pure presentation only; output carries no qualification, approval, or mutation authority. */
export function formatNativeSkillOptApprovalReviewForDisplay(input: NativeSkillOptReviewView): string {
  assertApprovalReviewScope(input)
  const { dataset, metrics, status, bindings, diff } = input
  const snapshot = recordValue(input.details.snapshot)!
  const targetSnapshot = recordValue(snapshot.target)!
  const backupSnapshot = recordValue(snapshot.backup)!
  const qualification = input.qualification
  const modelLines = (["generator", "target", "reviewer"] as const).map(role => {
    const model = dataset.modelBindings[role]
    return `${role} model=${model.engine}/${model.requestedModel}; runtime=${model.runtimeIdentity.version}; ` +
      `executableSha256=${model.runtimeIdentity.executableSha256}; profile=${model.profileIdentity.id}; profileSha256=${model.profileIdentity.sha256}`
  })
  const modelBindingsSha256 = sha256(canonicalJson(dataset.modelBindings))
  const dataSha256 = sha256(canonicalJson({
    sourceExportSha256: dataset.sourceExportSha256,
    fixturePackSha256: dataset.fixturePackSha256,
  }))
  const canaryCharged = status.targetPhaseCounts.canary.charged
  const canaryRemaining = typeof canaryCharged === "number" && Number.isSafeInteger(canaryCharged) && canaryCharged >= 0 &&
    Number.isSafeInteger(input.canaryReserve) && input.canaryReserve >= canaryCharged
    ? String(input.canaryReserve - canaryCharged) : "inconsistent"
  const trialMissing = Number.isSafeInteger(metrics.requiredTrials) && Number.isSafeInteger(metrics.observedTrials) &&
    metrics.requiredTrials >= metrics.observedTrials && metrics.observedTrials >= 0
    ? String(metrics.requiredTrials - metrics.observedTrials) : "not derivable from metric counts"
  const safetyFailed = Number.isSafeInteger(metrics.safety.requiredCandidateTrials) &&
    Number.isSafeInteger(metrics.safety.passedCandidateTrials) &&
    metrics.safety.requiredCandidateTrials >= metrics.safety.passedCandidateTrials && metrics.safety.passedCandidateTrials >= 0
    ? String(metrics.safety.requiredCandidateTrials - metrics.safety.passedCandidateTrials) : "inconsistent"
  const plannedMutationBytes = input.artifactBudget.approvalBytes + input.artifactBudget.transactionBytes
  const projectedArtifactRemaining = Number.isSafeInteger(status.remaining.artifactBytes) &&
    status.remaining.artifactBytes >= plannedMutationBytes
    ? String(status.remaining.artifactBytes - plannedMutationBytes) : "insufficient"
  const insertedHex = diff.insertedBytes.toString("hex") || "(empty)"
  const stratumLines = Object.keys(metrics.strata).sort().map(stratum =>
    pairedMetricsLine(`stratum ${stratum}`, metrics.strata[stratum] ?? null))
  const lines = [
    `Native SkillOpt ${input.operation} 사람 승인 검토`,
    `실행 ID=${input.runId}`,
    `승인 대상 SHA-256=${input.decisionSubjectSha256}`,
    `qualification hashes: binding=${qualification.bindingSha256}; schedule=${qualification.scheduleSha256}; ` +
      `baseline=${qualification.baselineSkillSha256}; candidate=${qualification.candidateSha256}; ` +
      `results=${qualification.resultsSha256}; review=${qualification.reviewSha256}`,
    `실제 owner scope hashes: session=${qualification.ownerSessionHash}; epoch=${qualification.ownerEpochHash}; ` +
      `admission=${qualification.admissionHash}`,
    `qualification 만료: boot=${qualification.expiresBoot}; continuousNs=${qualification.expiresContinuousNanoseconds}; ` +
      `wallMs=${qualification.expiresWallMilliseconds}; canary remaining=${countValue(qualification.remainingCanaryRequests)}`,
    `qualification 상태=${metrics.status}; 관측 trial=${countValue(metrics.observedTrials)}/${countValue(metrics.requiredTrials)}; ` +
      `미관측 trial=${trialMissing}; invalid trial=${countValue(metrics.invalidTrials)}`,
    `metric 사유=${metrics.reasons.length ? metrics.reasons.join(",") : "none"}`,
    pairedMetricsLine("dev", metrics.dev),
    pairedMetricsLine("final", metrics.final),
    `전체 confidence interval=${metrics.confidenceInterval
      ? `[${finiteNumber(metrics.confidenceInterval.lower)}, ${finiteNumber(metrics.confidenceInterval.upper)}]` : "missing (campaign metrics field)"}`,
    `safety candidate 통과 trial=${countValue(metrics.safety.passedCandidateTrials)}/${countValue(metrics.safety.requiredCandidateTrials)}; ` +
      `실패 trial=${safetyFailed}`,
    ...modelLines,
    `provider token maximum enforced=${input.providerTokenMaximumEnforced}`,
    `artifact reservation upper bound (not disk-byte measurement): approval=${countValue(input.artifactBudget.approvalBytes)} + ` +
      `transaction=${countValue(input.artifactBudget.transactionBytes)} = ${countValue(plannedMutationBytes)}; ` +
      `current reserved-cap remainder=${countValue(status.remaining.artifactBytes)}; ` +
      `projected after precharge=${projectedArtifactRemaining}; ` +
      `witness headroom required=${countValue(input.artifactBudget.witnessBytes)}; precharges are monotonic, no refund/retry`,
    `controller 상태=${status.state}; revision=${countValue(status.revision)}; quotaKeySha256=${status.quotaKeySha256}`,
    `전송 범위 바인딩 hash: run binding=${input.bindingSha256}; root=${bindings.rootBinding}; data=${dataSha256}; ` +
      `dataset=${dataset.datasetSha256}; runtime=${bindings.runtimeSha256}; witness=${bindings.witnessSha256}; ` +
      `sourceManifest=${dataset.sourceManifest.manifestSha256}; trainerProjection=${dataset.trainerProjectionSha256 ?? "none"}; ` +
      `sourceExport=${dataset.sourceExportSha256}; fixturePack=${dataset.fixturePackSha256}; ` +
      `canaryFixture=${input.bindings.canaryFixtureSha256}; modelBindings=${modelBindingsSha256}; protocol=${dataset.protocolSha256}; ` +
      `metricsTrials=${metrics.trialsSha256}; candidate=${bindings.candidateSha256}; original=${bindings.originalSha256}; ` +
      `results=${bindings.resultsSha256}`,
    ...stratumLines,
    `controller 미확정 요청 수: target=${countValue(status.requestCounts.unknown.target)}, ` +
      `optimizer=${countValue(status.requestCounts.unknown.optimizer)}, reviewer=${countValue(status.requestCounts.unknown.reviewer)}; ` +
      `phase unknown: training/development=${countValue(status.targetPhaseCounts.trainingAndDevelopment.unknown)}, ` +
      `final/safety=${countValue(status.targetPhaseCounts.finalSafety.unknown)}, canary=${countValue(status.targetPhaseCounts.canary.unknown)}; ` +
      `pendingDispatch=${status.pendingDispatch}`,
    `남은 예산: target=${countValue(status.remaining.target)}/${NATIVE_SKILLOPT_LIMITS.targetRequests}, ` +
      `optimizer=${countValue(status.remaining.optimizer)}/${NATIVE_SKILLOPT_LIMITS.optimizerRequests}, ` +
      `reviewer=${countValue(status.remaining.reviewer)}/${NATIVE_SKILLOPT_LIMITS.reviewerRequests}, ` +
      `activeMs=${countValue(status.remaining.activeMilliseconds)}/${NATIVE_SKILLOPT_LIMITS.activeMilliseconds}, ` +
      `artifact 예약 잔여=${countValue(status.remaining.artifactBytes)}/${NATIVE_SKILLOPT_LIMITS.artifactBytes}, ` +
      `candidateSteps=${countValue(status.remaining.candidateSteps)}/${NATIVE_SKILLOPT_LIMITS.candidateSteps}, ` +
      `canary=${canaryRemaining}/${input.canaryReserve}`,
    `정확한 삽입 anchor=${JSON.stringify(COMPILE_ANCHOR)}`,
    `보호된 prefix bytes=${countValue(diff.protectedPrefixBytes)}; SHA-256=${diff.protectedPrefixSha256}; unchanged=${diff.prefixUnchanged}; ` +
      `protected suffix bytes=${countValue(diff.protectedSuffixBytes)}; SHA-256=${diff.protectedSuffixSha256}; unchanged=${diff.suffixUnchanged}; ` +
      `정확한 재조립=${diff.exactReassembly}`,
    `삽입 UTF-8 bytes=${diff.insertedBytes.byteLength}; SHA-256=${sha256(diff.insertedBytes)}; hex=${insertedHex}`,
    `fragment bytes=${Buffer.byteLength(diff.fragment, "utf8")}/${PILOT_LIMITS.fragmentBytes}; 단일행 삽입은 native assembler로 검증됨`,
    input.operation === "apply"
      ? `candidate diff: ${diff.fragment ? `+ ${JSON.stringify(diff.fragment)}` : "(empty insertion)"}`
      : `rollback diff: ${diff.fragment ? `- ${JSON.stringify(diff.fragment)}` : "(제거할 candidate 삽입 없음)"}; ` +
        `복원할 original=${bindings.originalSha256}; live target에서 교체할 candidate=${bindings.candidateSha256} (displaced object 보존); ` +
        `원 apply 승인 증거=${input.applyApprovalSha256 ?? "missing"}; ` +
        `기존 apply journal=${String(recordValue(input.details.snapshot)?.applyJournalSha256 ?? "missing")}; ` +
        `기존 apply 승인 snapshot=${String(recordValue(input.details.snapshot)?.applyApprovalSha256 ?? "missing")}; ` +
        `새 rollback 승인 subject=${input.decisionSubjectSha256}`,
    `native snapshot hashes: target=${String(targetSnapshot.sha256 ?? "missing")}; backup=${String(backupSnapshot.sha256 ?? "missing")}; ` +
      `candidate=${String(snapshot.candidateSha256 ?? "missing")}; bindings=${String(snapshot.bindingsSha256 ?? "missing")}`,
    ...(input.operation === "rollback" ? [`old apply journal hash=${String(snapshot.applyJournalSha256)}; ` +
      `old manifest hash=${String(snapshot.manifestSha256)}; old apply approval hash=${String(snapshot.applyApprovalSha256)}; ` +
      `last apply journal checksum=${String(snapshot.latestJournalChecksum)}`] : []),
    `승인 후 모델 전송 범위: ${input.operation === "apply" ? "candidate 적용" : "original 복원"} 후 pinned target model로 fresh normal-loader canary 1회. ` +
      `hash-bound dev fixture의 task, 선택 source, 초기 slot만 사용합니다. fixture 내용·gold assertion·raw reviewer/model 응답은 표시하지 않으며 ` +
      `gold와 reviewer 응답 본문은 이 canary로 전송하지 않습니다. 승인 대기 중 추가 모델 요청은 없습니다.`,
  ]
  return lines.join("\n") + "\n"
}

function candidateReviewDiff(originalBytes: Uint8Array, candidateBytes: Uint8Array): NativeSkillOptReviewView["diff"] {
  let original: string
  let candidate: string
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    original = decoder.decode(originalBytes)
    candidate = decoder.decode(candidateBytes)
  } catch { fail("publication_candidate_encoding_invalid") }
  if (!Buffer.from(original, "utf8").equals(Buffer.from(originalBytes)) ||
      !Buffer.from(candidate, "utf8").equals(Buffer.from(candidateBytes))) fail("publication_candidate_encoding_invalid")
  const fragment = extractFragment(original, candidate)
  if (assembleSkill(original, fragment) !== candidate) fail("publication_candidate_reassembly_mismatch")
  const anchorOffset = original.indexOf(COMPILE_ANCHOR) + COMPILE_ANCHOR.length
  if (anchorOffset < COMPILE_ANCHOR.length) fail("publication_candidate_anchor_mismatch")
  const prefix = Buffer.from(original.slice(0, anchorOffset), "utf8")
  const suffix = Buffer.from(original.slice(anchorOffset), "utf8")
  const candidateBuffer = Buffer.from(candidateBytes)
  const prefixUnchanged = candidateBuffer.subarray(0, prefix.length).equals(prefix)
  const suffixStart = candidateBuffer.length - suffix.length
  const suffixUnchanged = suffixStart >= prefix.length && candidateBuffer.subarray(suffixStart).equals(suffix)
  const insertedBytes = candidateBuffer.subarray(prefix.length, suffixStart)
  const expectedInsertion = fragment ? Buffer.from(`\n${fragment}\n\n`, "utf8") : Buffer.alloc(0)
  if (!prefixUnchanged || !suffixUnchanged || !insertedBytes.equals(expectedInsertion)) fail("publication_protected_diff_invalid")
  return Object.freeze({ fragment, insertedBytes: Buffer.from(insertedBytes),
    protectedPrefixBytes: prefix.length, protectedPrefixSha256: sha256(prefix),
    protectedSuffixBytes: suffix.length, protectedSuffixSha256: sha256(suffix), prefixUnchanged, suffixUnchanged,
    exactReassembly: true })
}

function privateApprovalTerminalAvailable(terminal: Terminal): boolean {
  return terminal.stdinIsTTY === true && terminal.stderrIsTTY === true &&
    process.stdin.isTTY === true && process.stderr.isTTY === true
}

function writePrivateApprovalReview(terminal: Terminal, review: string): void {
  if (!privateApprovalTerminalAvailable(terminal)) fail("interactive_terminal_required")
  process.stderr.write(review.split("\n").map(terminalSafeText).join("\n"))
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown> : undefined
}

function assertApprovalReviewScope(view: NativeSkillOptReviewView): void {
  const details = recordValue(view.details)
  const snapshot = details && recordValue(details.snapshot)
  const target = snapshot && recordValue(snapshot.target)
  const backup = snapshot && recordValue(snapshot.backup)
  const targetModel = view.dataset.modelBindings.target
  const expectedTargetSha256 = view.operation === "apply" ? view.bindings.originalSha256 : view.bindings.candidateSha256
  const expectedInsertion = view.diff.fragment ? Buffer.from(`\n${view.diff.fragment}\n\n`, "utf8") : Buffer.alloc(0)
  const expectedAction = view.operation === "apply" ? "approve-production-apply" : "approve-production-rollback"
  if (!details || !snapshot || !target || !backup || details.schema !== "skillopt.native-operator-subject.v1" ||
      details.operation !== view.operation || details.action !== expectedAction ||
      snapshot.operation !== view.operation || snapshot.runId !== view.runId ||
      snapshot.bindingsSha256 !== sha256(canonicalJson(view.bindings)) ||
      canonicalJson(snapshot.bindings) !== canonicalJson(view.bindings) || snapshot.rootBinding !== view.bindings.rootBinding ||
      snapshot.candidateSha256 !== view.bindings.candidateSha256 || target.sha256 !== expectedTargetSha256 ||
      backup.sha256 !== view.bindings.originalSha256 || view.metrics.status !== "METRICS_PASSED" ||
      view.metrics.baselineSha256 !== view.bindings.originalSha256 || view.metrics.candidateSha256 !== view.bindings.candidateSha256 ||
      view.metrics.protocolSha256 !== view.bindings.evaluatorSha256 ||
      view.bindings.runId !== view.runId || !HASH.test(view.bindingSha256) ||
      view.dataset.sourceExportSha256 !== view.bindings.sourceSha256 ||
      view.dataset.fixturePackSha256 !== view.bindings.fixturePackSha256 ||
      view.dataset.protocolSha256 !== view.bindings.protocolSha256 ||
      view.qualification.runId !== view.runId || ![view.qualification.bindingSha256, view.qualification.scheduleSha256,
        view.qualification.baselineSkillSha256, view.qualification.candidateSha256, view.qualification.resultsSha256,
        view.qualification.reviewSha256].every(hash => HASH.test(hash)) ||
      view.qualification.bindingSha256 !== view.bindingSha256 || view.qualification.baselineSkillSha256 !== view.bindings.originalSha256 ||
      view.qualification.ownerSessionHash !== sha256(String(details.ownerSessionID)) ||
      view.qualification.ownerEpochHash !== sha256(String(details.ownerEpoch)) ||
      view.qualification.candidateSha256 !== view.bindings.candidateSha256 || view.qualification.resultsSha256 !== view.bindings.resultsSha256 ||
      sha256(canonicalJson(view.metrics)) !== view.qualification.resultsSha256 ||
      view.qualification.reviewSha256 !== view.reviewSha256 ||
      targetModel.engine !== view.bindings.nativeEngine || targetModel.requestedModel !== view.bindings.nativeModel ||
      targetModel.runtimeIdentity.version !== view.bindings.nativeRuntimeVersion ||
      targetModel.runtimeIdentity.executableSha256 !== view.bindings.nativeExecutableSha256 ||
      targetModel.profileIdentity.id !== view.bindings.nativeProfileId ||
      targetModel.profileIdentity.sha256 !== view.bindings.nativeProfileSha256 ||
      view.providerTokenMaximumEnforced !== false || view.status.runId !== view.runId || view.status.pendingDispatch ||
      (view.operation === "apply" && view.status.state !== "AWAITING_CANDIDATE_APPROVAL") ||
      (view.operation === "rollback" && view.status.state !== "COMPLETED" && view.status.state !== "AWAITING_CANDIDATE_APPROVAL") ||
      !HASH.test(view.decisionSubjectSha256) || sha256(canonicalJson(view.details)) !== view.decisionSubjectSha256 ||
      !view.diff.prefixUnchanged || !view.diff.suffixUnchanged || !view.diff.exactReassembly) {
    fail("publication_review_scope_mismatch")
  }
  if (!Number.isSafeInteger(view.diff.protectedPrefixBytes) || view.diff.protectedPrefixBytes < 0 ||
      !HASH.test(view.diff.protectedPrefixSha256) || !Number.isSafeInteger(view.diff.protectedSuffixBytes) ||
      view.diff.protectedSuffixBytes < 0 || !HASH.test(view.diff.protectedSuffixSha256) ||
      Buffer.byteLength(view.diff.fragment, "utf8") > PILOT_LIMITS.fragmentBytes ||
      !view.diff.insertedBytes.equals(expectedInsertion)) fail("publication_review_scope_mismatch")
  assertArtifactBudget(view.artifactBudget)
  if (canonicalJson(view.artifactBudget) !== canonicalJson(nativePromotionArtifactBudget(view.operation))) {
    fail("publication_review_scope_mismatch")
  }
  const requiredArtifactCapacity = view.artifactBudget.approvalBytes + view.artifactBudget.transactionBytes + view.artifactBudget.witnessBytes
  if (!Number.isSafeInteger(requiredArtifactCapacity) ||
      !Number.isSafeInteger(view.status.remaining.artifactBytes) ||
      view.status.remaining.artifactBytes < requiredArtifactCapacity) fail("publication_artifact_budget_unavailable")
  if (snapshot.candidateBytes !== view.candidateByteLength) fail("publication_review_scope_mismatch")
  if (view.operation === "apply") return
  if (!HASH.test(String(snapshot.applyJournalSha256 ?? "")) || !HASH.test(String(snapshot.manifestSha256 ?? "")) ||
      !HASH.test(String(snapshot.applyApprovalSha256 ?? "")) || !HASH.test(String(snapshot.latestJournalChecksum ?? "")) ||
      !["SWAPPED_EXPECTED", "LOAD_VERIFIED", "COMMITTED"].includes(String(snapshot.latestState)) ||
      !view.applyApprovalSha256 || !HASH.test(view.applyApprovalSha256) ||
      snapshot.applyApprovalSha256 !== view.applyApprovalSha256) fail("publication_review_scope_mismatch")
}

function makeApprovalReviewView(input: {
  operation: "apply" | "rollback"
  data: NativeSkillOptForegroundCampaignData
  details: Readonly<Record<string, unknown>>
  decisionSubjectSha256: string
  qualification: SkillOptQualifiedPublicationBinding
  bindings: PromotionBindings
  status: SkillOptControllerStatus
  diff: NativeSkillOptReviewView["diff"]
  applyApprovalSha256?: string
}): NativeSkillOptReviewView {
  const metrics = input.data.campaignResult.metrics
  const canaryReserve = input.data.campaignResult.schedule?.canaryReserve
  if (!metrics || typeof canaryReserve !== "number" || !Number.isSafeInteger(canaryReserve) || canaryReserve < 0) {
    fail("publication_review_data_unavailable")
  }
  return Object.freeze({
    operation: input.operation,
    runId: input.data.runId,
    decisionSubjectSha256: input.decisionSubjectSha256,
    details: input.details,
    bindingSha256: input.data.bindingSha256,
    qualification: input.qualification,
    reviewSha256: sha256(canonicalJson(input.data.campaignResult.reviewerEvidence)),
    bindings: input.bindings,
    candidateByteLength: Buffer.byteLength(input.data.campaignResult.candidate?.skill ?? "", "utf8"),
    dataset: input.data.current.dataset as NativeDataset,
    metrics,
    providerTokenMaximumEnforced: input.data.campaignResult.providerTokenMaximumEnforced,
    artifactBudget: nativePromotionArtifactBudget(input.operation),
    status: input.status,
    canaryReserve,
    diff: input.diff,
    ...(input.applyApprovalSha256 ? { applyApprovalSha256: input.applyApprovalSha256 } : {}),
  })
}

/** Publish only the exact private result of a live qualified foreground run; it never returns candidate/model payloads. */
export async function publishQualifiedNativeSkillOptRun(input: PublicationInput): Promise<Readonly<Record<string, unknown>>> {
  const { data, controller, terminal, signal } = input
  const runId = data.runId
  let mutationClaim: ExecutionClaim | undefined
  let context: PrivatePublicationContext | undefined
  let nativeMutationStarted = false
  let publicationAuthorized = false
  let candidateQualified = false
  try {
    if (signal?.aborted) return publicResult({ state: "CANCELLED", runId, candidateQualified: false, reasonCode: "publication_cancelled" })
    if (!privateApprovalTerminalAvailable(terminal)) return publicResult({ state: "BLOCKED", runId,
      candidateQualified: false, reasonCode: "interactive_terminal_required" })
    data.owner.assertOwner()
    const root = realpathSync.native(data.runtime.worktree)
    const originalSha256 = sha256(data.baselineSkillBytes)
    if (originalSha256 !== data.prepared.baselineSkillSha256 || originalSha256 !== data.current.baselineSkillSha256) {
      fail("publication_baseline_binding_mismatch")
    }
    const result = promotionBindings(data, root)
    const expected = {
      candidateSha256: result.candidateSha256,
      resultsSha256: result.resultsSha256,
      reviewSha256: result.reviewSha256,
    }
    const initialGuard = guardFor(data, controller, expected)
    if (initialGuard.baselineSkillSha256 !== originalSha256 || initialGuard.bindingSha256 !== data.bindingSha256) {
      fail("publication_qualification_binding_mismatch")
    }
    candidateQualified = true
    const transactionRoot = join(executionRunDirectory(root), "skillopt-native-promotion")
    ensureDurableDirectory(transactionRoot)
    if (!isPrivateDirectory(transactionRoot)) fail("publication_transaction_root_invalid")
    const evidence = prepareEvidence(input, result.bindings, result.semanticReview)
    const common: PromotionCommon = Object.freeze({
      targetPath: join(root, PILOT_SKILL),
      transactionRoot,
      nativeHelperPath: input.nativeHelper.helper.nativeHelperPath,
      nativeHelperSha256: input.nativeHelper.helper.nativeHelperSha256,
      bindings: result.bindings,
    })
    if (!sameGuard(initialGuard, guardFor(data, controller, expected))) fail("publication_scope_drift")
    const preview = await previewNativePromotionApproval({
      ...common,
      owner: data.owner,
      operation: "apply",
      runDeadlineAt: Number(initialGuard.expiresWallMilliseconds),
      candidateBytes: result.candidateBytes,
      evidence,
    })
    if (signal?.aborted) return publicResult({ state: "CANCELLED", runId, reasonCode: "publication_cancelled" })
    if (!sameGuard(initialGuard, guardFor(data, controller, expected))) {
      return publicResult({ state: "BLOCKED", runId, reasonCode: "publication_scope_drift" })
    }
    const reviewStatus = controller.status()
    if (reviewStatus.runId !== runId || reviewStatus.state !== "AWAITING_CANDIDATE_APPROVAL" || reviewStatus.pendingDispatch) {
      fail("publication_review_controller_state_invalid")
    }
    const diff = candidateReviewDiff(data.baselineSkillBytes, result.candidateBytes)
    const review = makeApprovalReviewView({
      operation: "apply",
      data,
      details: preview.details,
      decisionSubjectSha256: preview.decisionBinding.subject.sha256,
      qualification: initialGuard,
      bindings: common.bindings,
      status: reviewStatus,
      diff,
    })
    writePrivateApprovalReview(terminal, formatNativeSkillOptApprovalReviewForDisplay(review))
    let decision: OperatorDecision
    try { decision = await humanDecision("choose", preview.decisionBinding, signal) }
    catch {
      return publicResult({ state: signal?.aborted ? "CANCELLED" : "BLOCKED", runId,
        reasonCode: signal?.aborted ? "publication_cancelled" : "operator_decision_unavailable" })
    }
    if (!terminalApprovalMatches(decision, preview.decisionBinding)) {
      try { consumeOperatorDecision(decision) } catch { /* Invalid receipts cannot authorize. */ }
      return publicResult({ state: "BLOCKED", runId, reasonCode: "operator_decision_binding_mismatch" })
    }
    if (decision.action === "reject") {
      try {
        const rejected = consumeOperatorDecision(decision)
        if (rejected.action !== "reject") fail("operator_rejection_invalid")
      } catch { return publicResult({ state: "BLOCKED", runId, reasonCode: "operator_decision_binding_mismatch" }) }
      return publicResult({ state: "REJECTED", runId, reasonCode: "operator_rejected" })
    }
    if (decision.action !== "approve") {
      try { consumeOperatorDecision(decision) } catch { /* Invalid receipts cannot authorize. */ }
      return publicResult({ state: "BLOCKED", runId, reasonCode: "operator_decision_binding_mismatch" })
    }
    if (signal?.aborted) return publicResult({ state: "CANCELLED", runId, reasonCode: "publication_cancelled" })
    mutationClaim = data.runtime.runs.claim(data.owner.sessionID, `skillopt-native-publication-${randomUUID()}`, process.pid)
    context = {
      data,
      owner: data.owner,
      runtime: data.runtime,
      broker: data.broker,
      controller,
      nativeHelper: input.nativeHelper,
      common,
      publicationEvidence: evidence,
      qualification: initialGuard,
      fixtureId: result.fixtureId,
      applyQuiescent: false,
      applyStage: "approved",
      mutationClaim,
      rollbackAttempted: false,
    }
    publishedContexts.set(data, context)
    const verifyCurrentScope = async (): Promise<void> => {
      if (signal?.aborted) fail("publication_cancelled")
      if (!sameGuard(initialGuard, guardFor(data, controller, expected, mutationClaim))) fail("publication_scope_drift")
    }
    await verifyCurrentScope()
    const artifactBudget = nativePromotionArtifactBudget("apply")
    assertArtifactBudget(artifactBudget)
    const applyMutationReservation = artifactBudget.approvalBytes + artifactBudget.transactionBytes
    if (!Number.isSafeInteger(applyMutationReservation)) fail("publication_artifact_budget_invalid")
    reservePublicationArtifactBytes({
      publication: input,
      operation: "apply",
      mutationClaim,
      bytes: applyMutationReservation,
      headroomBytes: artifactBudget.witnessBytes,
    })
    const authorization = await authorizeNativePromotionApproval({ preview: preview.preview, owner: data.owner, receipt: decision })
    publicationAuthorized = true
    if (!authorization.evidence) fail("native_approval_evidence_missing")
    const evidenceWithApproval: PromotionEvidence = authorization.evidence
    context.evidence = evidenceWithApproval
    await verifyCurrentScope()
    context.applyStage = "mutating"
    nativeMutationStarted = true
    let applied: Awaited<ReturnType<typeof applySkillOptPromotion>> | undefined
    let outcome: unknown
    try {
      applied = await applySkillOptPromotion({
        ...common,
        candidateBytes: result.candidateBytes,
        evidence: evidenceWithApproval,
        nativeAuthorization: authorization.authorization,
        async verifyEvidence() {
          await verifyCurrentScope()
        },
      })
      outcome = applied
    } catch (error) {
      outcome = error
    }
    context.applyState = applied?.state
    context.applyQuiescent = nativePromotionMutationIsQuiescent(outcome, common, "apply")
    if (!context.applyQuiescent || !mutationClaim || !releaseMutationClaim(data.runtime, mutationClaim)) {
      context.applyStage = "unresolved"
      const metadata = controllerMetadata(controller)
      return publicResult({ state: "UNRESOLVED", runId, reasonCode: "native_publication_mutation_unresolved",
        controllerState: metadata?.state, revision: metadata?.revision,
        publicationAuthorized: true, postApplyHandoffAuthorized: false })
    }
    context.mutationClaim = undefined
    mutationClaim = undefined
    if (!applied || applied.state !== "SWAPPED_EXPECTED") {
      context.applyStage = "unresolved"
      const metadata = controllerMetadata(controller)
      return publicResult({ state: "UNRESOLVED", runId, reasonCode: "native_publication_swap_not_verified",
        controllerState: metadata?.state, revision: metadata?.revision,
        publicationAuthorized: true, postApplyHandoffAuthorized: false })
    }
    context.applyStage = "swapped"
    let canary: Awaited<ReturnType<typeof data.broker.loadCanary>>
    try {
      canary = await data.broker.loadCanary({
        owner: data.owner,
        runId,
        current: data.current,
        fixtureId: result.fixtureId,
        promotion: { ...common, evidence: evidenceWithApproval },
        terminal,
        signal: signal ?? new AbortController().signal,
      })
    } catch (error) {
      context.applyStage = "canary-failed"
      const reasonCode = classifyNativeSkillOptPublicationFailure("apply", error)
      const metadata = controllerMetadata(controller)
      return publicResult({ state: "UNRESOLVED", runId, reasonCode,
        controllerState: metadata?.state, revision: metadata?.revision,
        publicationAuthorized: true, postApplyHandoffAuthorized: false })
    }
    const controllerStatus = canary.controllerStatus
    if (canary.status !== "COMMITTED" || controllerStatus?.state !== "COMPLETED" || controllerStatus.runId !== runId) {
      context.applyStage = "canary-failed"
      return publicResult({ state: "UNRESOLVED", runId, reasonCode: "native_load_canary_not_committed",
        controllerState: controllerStatus?.state ?? controller.status().state, revision: controllerStatus?.revision,
        canaryStatus: canary.status, canaryReasonCode: canary.reasonCode,
        canaryPhase: canary.phase, canaryErrorCode: canary.errorCode,
        canaryPromotionState: canary.promotion?.state, canaryControllerState: controllerStatus?.state,
        publicationAuthorized: true, postApplyHandoffAuthorized: false })
    }
    context.applyStage = "committed"
    if (!data.trainer.cleanup()) {
      return publicResult({ state: "UNRESOLVED", runId, reasonCode: "trainer_scratch_cleanup_unresolved",
        controllerState: controllerStatus.state, revision: controllerStatus.revision,
        publicationAuthorized: true, postApplyHandoffAuthorized: true })
    }
    return publicResult({ state: "COMMITTED", runId, controllerState: controllerStatus.state,
      revision: controllerStatus.revision, publicationAuthorized: true, postApplyHandoffAuthorized: true })
  } catch (error) {
    let claimUnresolved = false
    if (mutationClaim && !nativeMutationStarted) {
      if (releaseMutationClaim(data.runtime, mutationClaim)) {
        if (context) publishedContexts.delete(data)
        context = undefined
        mutationClaim = undefined
      } else {
        claimUnresolved = true
        if (context) {
          context.applyStage = "unresolved"
          context.mutationClaim = mutationClaim
        }
      }
    }
    const metadata = controllerMetadata(controller)
    return publicResult({ state: nativeMutationStarted || claimUnresolved ? "UNRESOLVED" : signal?.aborted ? "CANCELLED" : "BLOCKED",
      runId, reasonCode: classifyNativeSkillOptPublicationFailure("apply", error),
      controllerState: metadata?.state, revision: metadata?.revision,
      candidateQualified, publicationAuthorized, postApplyHandoffAuthorized: context?.applyStage === "swapped" || context?.applyStage === "canary-failed" ||
        context?.applyStage === "committed" })
  }
}

/** Roll back only a swap observed by this process from the exact original live campaign object. */
export async function rollbackPublishedNativeSkillOptRun(input: PublicationInput): Promise<Readonly<Record<string, unknown>>> {
  const candidate = input as PublicationInput | null | undefined
  const data = candidate?.data
  const runId = data && typeof data.runId === "string" ? data.runId : "unknown"
  const context = data && typeof data === "object" ? publishedContexts.get(data as object) : undefined
  if (!context || !samePublicationIdentity(context, candidate as PublicationInput)) {
    return publicResult({ operation: "rollback", state: "BLOCKED", runId, candidateQualified: false,
      reasonCode: "published_context_unavailable" })
  }
  if (context.rollbackAttempted) {
    return publicResult({ operation: "rollback", state: "BLOCKED", runId, reasonCode: "rollback_already_attempted",
      publicationAuthorized: true })
  }
  if (context.applyQuiescent !== true || context.applyState !== "SWAPPED_EXPECTED" || context.mutationClaim ||
      !["swapped", "canary-failed", "committed"].includes(context.applyStage)) {
    return publicResult({ operation: "rollback", state: "BLOCKED", runId, reasonCode: "published_swap_not_eligible",
      publicationAuthorized: true })
  }
  const { terminal, signal } = candidate as PublicationInput
  const { data: liveData, controller } = candidate as PublicationInput
  if (signal?.aborted) return publicResult({ operation: "rollback", state: "CANCELLED", runId,
    publicationAuthorized: true, reasonCode: "rollback_cancelled" })
  if (!privateApprovalTerminalAvailable(terminal)) return publicResult({ operation: "rollback", state: "BLOCKED", runId,
    publicationAuthorized: true, reasonCode: "interactive_terminal_required" })

  let mutationClaim: ExecutionClaim | undefined
  let nativeMutationStarted = false
  let rollbackAuthorized = false
  try {
    liveData.owner.assertOwner()
    const eligibility = controller.nativeRollbackEligibility({
      owner: liveData.owner,
      runtime: liveData.runtime,
      runId,
      current: liveData.current,
    })
    if (eligibility.state !== "ELIGIBLE") {
      return publicResult({ operation: "rollback", state: "BLOCKED", runId,
        reasonCode: "rollback_not_eligible", publicationAuthorized: true })
    }
    const runDeadlineAt = Number(context.qualification.expiresWallMilliseconds)
    if (!Number.isSafeInteger(runDeadlineAt)) fail("rollback_deadline_invalid")
    const preview = await previewNativePromotionApproval({
      ...context.common,
      owner: liveData.owner,
      operation: "rollback",
      runDeadlineAt,
    })
    if (signal?.aborted) return publicResult({ operation: "rollback", state: "CANCELLED", runId,
      publicationAuthorized: true, reasonCode: "rollback_cancelled" })
    const reviewStatus = controller.status()
    if (reviewStatus.runId !== runId || reviewStatus.pendingDispatch ||
        (reviewStatus.state !== "COMPLETED" && reviewStatus.state !== "AWAITING_CANDIDATE_APPROVAL")) {
      fail("rollback_review_controller_state_invalid")
    }
    const applyApprovalSha256 = context.evidence?.approval.sha256
    if (!applyApprovalSha256 || !HASH.test(applyApprovalSha256)) fail("published_apply_evidence_unavailable")
    const diff = candidateReviewDiff(liveData.baselineSkillBytes, Buffer.from(liveData.campaignResult.candidate?.skill ?? "", "utf8"))
    const review = makeApprovalReviewView({
      operation: "rollback",
      data: liveData,
      details: preview.details,
      decisionSubjectSha256: preview.decisionBinding.subject.sha256,
      qualification: context.qualification,
      bindings: context.common.bindings,
      status: reviewStatus,
      diff,
      applyApprovalSha256,
    })
    writePrivateApprovalReview(terminal, formatNativeSkillOptApprovalReviewForDisplay(review))
    let decision: OperatorDecision
    try { decision = await humanDecision("choose", preview.decisionBinding, signal) }
    catch {
      return publicResult({ operation: "rollback", state: signal?.aborted ? "CANCELLED" : "BLOCKED", runId,
        reasonCode: signal?.aborted ? "rollback_cancelled" : "operator_decision_unavailable", publicationAuthorized: true })
    }
    if (!terminalApprovalMatches(decision, preview.decisionBinding)) {
      try { consumeOperatorDecision(decision) } catch { /* Invalid receipts cannot authorize. */ }
      return publicResult({ operation: "rollback", state: "BLOCKED", runId,
        reasonCode: "operator_decision_binding_mismatch", publicationAuthorized: true })
    }
    if (decision.action === "reject") {
      try {
        const rejected = consumeOperatorDecision(decision)
        if (rejected.action !== "reject") fail("operator_rejection_invalid")
      } catch {
        return publicResult({ operation: "rollback", state: "BLOCKED", runId,
          reasonCode: "operator_decision_binding_mismatch", publicationAuthorized: true })
      }
      return publicResult({ operation: "rollback", state: "REJECTED", runId,
        reasonCode: "operator_rejected", publicationAuthorized: true })
    }
    if (decision.action !== "approve") {
      try { consumeOperatorDecision(decision) } catch { /* Invalid receipts cannot authorize. */ }
      return publicResult({ operation: "rollback", state: "BLOCKED", runId,
        reasonCode: "operator_decision_binding_mismatch", publicationAuthorized: true })
    }
    if (signal?.aborted) return publicResult({ operation: "rollback", state: "CANCELLED", runId,
      publicationAuthorized: true, reasonCode: "rollback_cancelled" })

    mutationClaim = liveData.runtime.runs.claim(liveData.owner.sessionID, `skillopt-native-rollback-${randomUUID()}`, process.pid)
    context.mutationClaim = mutationClaim
    const currentEligibility = controller.nativeRollbackEligibility({
      owner: liveData.owner,
      runtime: liveData.runtime,
      mutationClaim,
      runId,
      current: liveData.current,
    })
    if (currentEligibility.state !== "ELIGIBLE") fail("rollback_not_eligible")
    const rollbackArtifactBudget = nativePromotionArtifactBudget("rollback")
    assertArtifactBudget(rollbackArtifactBudget)
    const rollbackMutationReservation = rollbackArtifactBudget.approvalBytes + rollbackArtifactBudget.transactionBytes
    if (!Number.isSafeInteger(rollbackMutationReservation)) fail("publication_artifact_budget_invalid")
    reservePublicationArtifactBytes({
      publication: candidate as PublicationInput,
      operation: "rollback",
      mutationClaim,
      bytes: rollbackMutationReservation,
      headroomBytes: rollbackArtifactBudget.witnessBytes,
    })
    const authorization = await authorizeNativePromotionApproval({ preview: preview.preview, owner: liveData.owner, receipt: decision })
    rollbackAuthorized = true
    context.rollbackStage = "approved"
    const rollbackEvidence = context.evidence
    if (!rollbackEvidence) fail("published_apply_evidence_unavailable")
    context.rollbackAttempted = true
    const intent = controller.beginNativeRollback({
      owner: liveData.owner,
      runtime: liveData.runtime,
      mutationClaim,
      runId,
      current: liveData.current,
      promotion: context.common,
      nativeAuthorization: authorization.authorization,
    })
    context.rollbackIntent = intent
    context.rollbackStage = "mutating"
    nativeMutationStarted = true
    let rollbackResult: Awaited<ReturnType<typeof rollbackSkillOptPromotion>> | undefined
    let outcome: unknown
    try {
      rollbackResult = await rollbackSkillOptPromotion({
        ...context.common,
        nativeAuthorization: authorization.authorization,
      })
      outcome = rollbackResult
    } catch (error) {
      outcome = error
    }
    const rollbackQuiescent = nativePromotionMutationIsQuiescent(outcome, context.common, "rollback")
    if (!rollbackQuiescent || !mutationClaim || !releaseMutationClaim(liveData.runtime, mutationClaim)) {
      context.rollbackStage = "unresolved"
      const metadata = controllerMetadata(controller)
      return publicResult({ operation: "rollback", state: "UNRESOLVED", runId,
        reasonCode: "native_rollback_mutation_unresolved", controllerState: metadata?.state, revision: metadata?.revision,
        publicationAuthorized: true, rollbackAuthorized: true, postRollbackHandoffAuthorized: false })
    }
    context.mutationClaim = undefined
    mutationClaim = undefined
    if (!rollbackResult || rollbackResult.state !== "ROLLBACK_SWAP_INTENT") {
      context.rollbackStage = "unresolved"
      try { controller.markNativeRollbackUnresolved(liveData.owner, runId, "native_rollback_exchange_not_verified") } catch { /* Keep the quota hold. */ }
      const metadata = controllerMetadata(controller)
      return publicResult({ operation: "rollback", state: "UNRESOLVED", runId,
        reasonCode: "native_rollback_exchange_not_verified", controllerState: metadata?.state, revision: metadata?.revision,
        publicationAuthorized: true, rollbackAuthorized: true, postRollbackHandoffAuthorized: false })
    }
    context.rollbackStage = "restored-awaiting-canary"
    let canary: Awaited<ReturnType<typeof liveData.broker.loadRollbackCanary>>
    try {
      canary = await liveData.broker.loadRollbackCanary({
        owner: liveData.owner,
        runId,
        current: liveData.current,
        fixtureId: context.fixtureId,
        intent,
        promotion: { ...context.common, evidence: rollbackEvidence },
        terminal,
        signal: signal ?? new AbortController().signal,
      })
    } catch (error) {
      context.rollbackStage = "canary-failed"
      const reasonCode = classifyNativeSkillOptPublicationFailure("rollback", error)
      const metadata = controllerMetadata(controller)
      return publicResult({ operation: "rollback", state: "UNRESOLVED", runId, reasonCode,
        controllerState: metadata?.state, revision: metadata?.revision,
        publicationAuthorized: true, rollbackAuthorized: true, postRollbackHandoffAuthorized: false })
    }
    const controllerStatus = canary.controllerStatus
    if (canary.status !== "ROLLED_BACK" || controllerStatus?.state !== "ROLLED_BACK" || controllerStatus.runId !== runId) {
      context.rollbackStage = "canary-failed"
      return publicResult({ operation: "rollback", state: "UNRESOLVED", runId,
        reasonCode: "native_rollback_canary_not_committed",
        controllerState: controllerStatus?.state, revision: controllerStatus?.revision,
        canaryStatus: canary.status, canaryReasonCode: canary.reasonCode,
        canaryPhase: canary.phase, canaryErrorCode: canary.errorCode,
        canaryPromotionState: canary.promotion?.state, canaryControllerState: controllerStatus?.state,
        publicationAuthorized: true, rollbackAuthorized: true, postRollbackHandoffAuthorized: false })
    }
    context.rollbackStage = "rolled-back"
    return publicResult({ operation: "rollback", state: "ROLLED_BACK", runId,
      controllerState: controllerStatus.state, revision: controllerStatus.revision,
      publicationAuthorized: true, rollbackAuthorized: true, postRollbackHandoffAuthorized: true })
  } catch (error) {
    let claimUnresolved = false
    if (mutationClaim && !nativeMutationStarted) {
      if (releaseMutationClaim(liveData.runtime, mutationClaim)) {
        if (context.mutationClaim === mutationClaim) context.mutationClaim = undefined
        mutationClaim = undefined
      } else {
        claimUnresolved = true
        context.mutationClaim = mutationClaim
        context.rollbackStage = "unresolved"
      }
    }
    if (nativeMutationStarted && context.rollbackStage === "mutating") context.rollbackStage = "unresolved"
    const metadata = controllerMetadata(controller)
    return publicResult({ operation: "rollback",
      state: nativeMutationStarted || claimUnresolved ? "UNRESOLVED" : signal?.aborted ? "CANCELLED" : "BLOCKED",
      runId, reasonCode: classifyNativeSkillOptPublicationFailure("rollback", error), controllerState: metadata?.state, revision: metadata?.revision,
      publicationAuthorized: true, rollbackAuthorized,
      postRollbackHandoffAuthorized: context.rollbackStage === "rolled-back" })
  }
}
