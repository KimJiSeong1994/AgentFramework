import { constants, statfsSync } from "node:fs"
import { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import type { BigIntStats } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import type { SessionStore } from "../sessions/store.ts"
import { nativeObservedUsageCanonicalByteBound, type CliObservedUsage } from "../hosts/cli-transport.ts"
import type { ExecutionRuntime } from "../hosts/types.ts"
import {
  getNativeSkillOptBrokerWorktree, SkillOptBrokerError, type NativeSkillOptBroker,
  type NativeSemanticReviewBinding, type NativeSkillOptCompletedTargetWitness,
} from "./broker.ts"
import {
  SkillOptControllerError,
  type SkillOptArm, type SkillOptConsent, type SkillOptController, type SkillOptControllerStatus, type SkillOptCurrentBinding,
  type SkillOptNativeCampaignTargetBinding, type SkillOptNativeCampaignTargetPlan, type SkillOptNativeCampaignTargetResponse,
  type SkillOptNativeCampaignArtifactScheduleEntry, type SkillOptNativeCampaignArtifactStageMetadata,
  type SkillOptNativeTrainerProtocolCapture,
  type SkillOptNativeTrainerProtocolEvent, type SkillOptNativeTrainerProtocolEventDescription,
  type SkillOptReasonCode,
  type SkillOptPrepared, type SkillOptReservation,
} from "./controller.ts"
import {
  NATIVE_DATASET_LIMITS, type NativeDataset, type NativeWikiFixture, type NativeWikiFixturePack,
  validateNativeDataset, validateNativeWikiOutput, trainerSafeProjection,
} from "./dataset.ts"
import {
  buildNativeEvaluationPrompt, measureNativeQualification, planNativeFixtureSerializedWrites,
  scoreNativeEvaluationTrial, serializeNativeFixtureWorkerInput, validateNativeFixtureGold,
  type NativeEvaluationTrial, type NativeQualificationMetrics,
} from "./evaluation.ts"
import {
  buildNativeAdapterManifest, buildNativeCampaignSchedule, forecastNativeCampaign,
  type NativeCampaignForecast, type NativeCampaignSchedule,
} from "./campaign-protocol.ts"
import { assembleSkill, canonicalJson, NATIVE_SKILLOPT_LIMITS, PILOT_LIMITS, readBoundedSource, sha256, SkillOptError } from "./pilot.ts"
import {
  launchOwnedWorker, prepareWorkerProfile, probeWorkerContainment,
  nativeSkillOptFixtureProbeSerializedBytes,
  nativeSkillOptFixtureResultByteBound,
  type OwnedTrainerProtocolEvent, type OwnedWorkerHandle, type OwnedWorkerResult,
  type SkillOptContainmentReceipt, type SkillOptWorkerProfile,
} from "./host.ts"
import { markNativeSkillOptTrainerClosed } from "./trainer.ts"
import { containsSecret } from "../security/secrets.ts"

const REPO_ROOT = realpathSync.native(resolve(import.meta.dir, "../../../"))
const TRAINER_RESULT_NAME = "skillopt-result.json"
const TRAINER_RESULT_BYTES = 512 * 1024
const TRAINER_SOURCE_LOCK_BYTES = 64 * 1024
const FIXTURE_RESULT_NAME = "fixture-result.json"
const SEMANTIC_REVIEW_SCHEMA = "skillopt.semantic-review.v1" as const
const PINNED_SKILLOPT_COMMIT = "fa4ca184573e42ec11472959dd57422381418096"
const HASH = /^[a-f0-9]{64}$/u

declare const nativeCampaignQualificationBrand: unique symbol
export type NativeCampaignQualification = Readonly<{ [nativeCampaignQualificationBrand]: never }>
type QualificationBinding = Readonly<{
  runId: string
  bindingSha256: string
  scheduleSha256: string
  candidateSha256: string
  resultsSha256: string
  reviewSha256: string
}>
const qualifications = new WeakMap<object, QualificationBinding>()

/** Only a completed independent campaign can issue this one-use binding; serialized results cannot. */
export function consumeNativeCampaignQualification(proof: NativeCampaignQualification): QualificationBinding {
  const binding = proof && typeof proof === "object" ? qualifications.get(proof) : undefined
  if (!binding) throw new SkillOptError("campaign_qualification_invalid_or_consumed")
  qualifications.delete(proof)
  return binding
}

type TrainerInput = Readonly<{
  profile: SkillOptWorkerProfile
  receipt: SkillOptContainmentReceipt
  /** Exact outputDirectory used to prepare `profile`; the host still revalidates its owned identity on launch. */
  outputDirectory: string
  /** Exact paths used to prepare the trainer profile; fixture profiles are checked against its runtime identity. */
  executablePath: string
  nativeRuntimeProofPath: string
}>

export type NativeCampaignConsentDisclosure = Readonly<{
  scheduleSha256: string
  targetRequests: number
  canaryReserve: number
  targetRequestsWithReserve: number
  targetRequestCap: number
  optimizerRequestLimit: number
  reviewerRequestLimit: number
  requestDeadlineMilliseconds: number
  responseByteLimit: number
  requestedCompletionTokenMaximum: 16384
  completionTokenMaximumIsMetadataOnly: true
  providerTokenMaximumEnforced: false
  usageMayBeUnknown: true
  completionGuaranteed: false
}>

export type NativeCampaignReviewerEvidence = Readonly<{
  phase: "final" | "safety"
  status: "valid" | "malformed" | "failed"
  promptSha256: string
  responseSha256: string | null
  assessment: "clear" | "concerns" | "uncertain" | null
  findings: readonly string[]
  errorCode?: string
}>

export type NativeCampaignUsageObservation = Readonly<{
  requestId: string
  role: "target" | "optimizer" | "reviewer"
  usage: CliObservedUsage | null
}>

export type NativeCampaignWarmupCorrelation = Readonly<{
  scheduleSha256: string
  wireRequestId: string
  nativeRequestId: string
  split: "train"
  caseId: string
  replicate: number
  fragmentSha256: string
}>

export type NativeCampaignStatus =
  | "DATA_REQUIRED" | "BLOCKED" | "UNRESOLVED" | "CANCELLED" | "FAILED"
  | "INCONCLUSIVE" | "NO_GAIN" | "REJECTED" | "AWAITING_CANDIDATE_APPROVAL"

export type NativeCampaignDiagnostic = Readonly<
  | { stage: "artifact-admission"; artifactStage: SkillOptNativeCampaignArtifactStageMetadata["stage"];
      code?: SkillOptReasonCode }
  | { stage: "trainer-protocol-event"; ordinal: number; code?: SkillOptReasonCode }
>

export type NativeCampaignResult = Readonly<{
  status: NativeCampaignStatus
  reasonCode?: string
  diagnostic?: NativeCampaignDiagnostic
  schedule?: NativeCampaignSchedule
  forecast?: NativeCampaignForecast
  candidate?: Readonly<{ skill: string; fragment: string; sha256: string }>
  metrics?: NativeQualificationMetrics
  reviewerEvidence?: readonly NativeCampaignReviewerEvidence[]
  usageObservations?: readonly NativeCampaignUsageObservation[]
  warmupCorrelations?: readonly NativeCampaignWarmupCorrelation[]
  /** A passed campaign still stops here: candidate-specific human approval is required before any change. */
  candidateApprovalRequired: boolean
  providerTokenMaximumEnforced: false
}>

export type NativeSkillOptCampaignInput = Readonly<{
  broker: NativeSkillOptBroker
  owner: SessionStore
  runtime: ExecutionRuntime
  getCurrent: () => SkillOptCurrentBinding
  prepared: SkillOptPrepared | Readonly<{ state: "DATA_REQUIRED"; reasonCode: "data-required" }>
  consent?: SkillOptConsent
  arm?: SkillOptArm
  originalSkill: string
  trainer?: TrainerInput
  signal?: AbortSignal
}>

class CampaignFailure extends Error {
  readonly diagnostic?: NativeCampaignDiagnostic
  constructor(readonly code: string, readonly status: NativeCampaignStatus = "FAILED",
    diagnostic?: NativeCampaignDiagnostic) {
    super(code)
    this.name = "CampaignFailure"
    if (diagnostic) this.diagnostic = Object.freeze(diagnostic)
  }
}

type CampaignRequestFailure = Readonly<{ reasonCode: string; status: NativeCampaignStatus }>

/** @internal Maps only the broker's closed error taxonomy; arbitrary messages never cross the campaign boundary. */
export function classifyNativeCampaignRequestFailure(
  error: unknown,
  unknownReasonCode: "native_campaign_request_failed" | "native_campaign_failed" = "native_campaign_request_failed",
): CampaignRequestFailure {
  if (error instanceof SkillOptBrokerError) {
    let status: NativeCampaignStatus
    switch (error.code) {
      case "invalid_request":
      case "dataset_invalid":
      case "binding_drift":
      case "owner_unavailable":
      case "owner_busy":
      case "dispatch_not_authorized":
      case "native_identity_unavailable":
      case "sensitive_input":
      case "not_active":
        status = "BLOCKED"
        break
      case "native_execution_failed":
      case "response_limit":
      case "empty_response":
      case "unsafe_response":
        status = "FAILED"
        break
      case "cancelled":
        status = "CANCELLED"
        break
      case "execution_unresolved":
      case "controller_unavailable":
        status = "UNRESOLVED"
        break
      default: {
        const unknownCode: never = error.code
        void unknownCode
        return Object.freeze({ reasonCode: unknownReasonCode, status: "FAILED" })
      }
    }
    return Object.freeze({ reasonCode: error.code, status })
  }
  return Object.freeze({ reasonCode: unknownReasonCode, status: "FAILED" })
}

function createWorkerMessageQueue<T>() {
  const queued: T[] = []
  let waiter: { resolve(value: T): void; reject(error: unknown): void } | undefined
  let failure: CampaignFailure | undefined
  let closed = false
  return Object.freeze({
    push(value: T): void {
      if (closed || failure) return
      if (waiter) {
        const current = waiter
        waiter = undefined
        current.resolve(value)
      } else if (queued.length === 0) queued.push(value)
      else {
        failure = new CampaignFailure("trainer_ipc_overflow", "FAILED")
      }
    },
    next(): Promise<T> {
      if (failure) return Promise.reject(failure)
      if (queued.length) {
        const value = queued.shift()
        if (value !== undefined) return Promise.resolve(value)
      }
      if (closed) return Promise.reject(new CampaignFailure("trainer_worker_closed", "FAILED"))
      return new Promise((resolveMessage, rejectMessage) => { waiter = { resolve: resolveMessage, reject: rejectMessage } })
    },
    fail(error: CampaignFailure): void {
      if (failure) return
      failure = error
      waiter?.reject(error)
      waiter = undefined
    },
    close(): void {
      closed = true
      waiter?.reject(failure ?? new CampaignFailure("trainer_worker_closed", "FAILED"))
      waiter = undefined
    },
    hasPending(): boolean { return queued.length > 0 },
    assertHealthy(): void { if (failure) throw failure },
  })
}

function fail(code: string, status?: NativeCampaignStatus, diagnostic?: NativeCampaignDiagnostic): never {
  throw new CampaignFailure(code, status, diagnostic)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  let keys: PropertyKey[]
  try { keys = Reflect.ownKeys(value) } catch { return null }
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) return null
  const record: Record<string, unknown> = Object.create(null)
  for (const key of fields) {
    let descriptor: PropertyDescriptor | undefined
    try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { return null }
    if (!descriptor || !("value" in descriptor)) return null
    record[key] = descriptor.value
  }
  return record
}

function scheduleBinding(value: unknown): string | null {
  if (!isRecord(value)) return null
  let descriptor: PropertyDescriptor | undefined
  try { descriptor = Object.getOwnPropertyDescriptor(value, "scheduleSha256") } catch { return null }
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" && HASH.test(descriptor.value)
    ? descriptor.value : null
}

function scheduleConsentBound(value: unknown, schedule: NativeCampaignSchedule): boolean {
  if (!isRecord(value) || scheduleBinding(value) !== schedule.scheduleSha256) return false
  let targetRequests: PropertyDescriptor | undefined
  let canaryReserve: PropertyDescriptor | undefined
  let targetRequestCap: PropertyDescriptor | undefined
  try {
    targetRequests = Object.getOwnPropertyDescriptor(value, "targetRequests")
    canaryReserve = Object.getOwnPropertyDescriptor(value, "canaryReserve")
    targetRequestCap = Object.getOwnPropertyDescriptor(value, "targetRequestCap")
  } catch { return false }
  return !!targetRequests && "value" in targetRequests && targetRequests.value === schedule.targetRequests &&
    !!canaryReserve && "value" in canaryReserve && canaryReserve.value === schedule.canaryReserve &&
    !!targetRequestCap && "value" in targetRequestCap && targetRequestCap.value === NATIVE_SKILLOPT_LIMITS.targetRequests
}

type TargetPromptBase = Readonly<{ systemSuffix: string; user: string }>

function targetPrompt(fixture: NativeWikiFixture, skill: string, promptBases: ReadonlyMap<string, TargetPromptBase>): string {
  const base = promptBases.get(fixture.id)
  if (!base) fail("campaign_prompt_fixture_missing", "BLOCKED")
  if (typeof skill !== "string" || skill.length === 0 || Buffer.byteLength(skill, "utf8") > PILOT_LIMITS.skillBytes ||
      skill.includes("\0") || Buffer.from(skill, "utf8").toString("utf8") !== skill || containsSecret(skill)) {
    throw new SkillOptError("evaluation_skill_invalid")
  }
  const prompt = canonicalJson({ system: `${skill}${base.systemSuffix}`, user: base.user })
  if (Buffer.byteLength(prompt, "utf8") > NATIVE_DATASET_LIMITS.fixtureInputBytes) fail("campaign_prompt_limit", "BLOCKED")
  return prompt
}

function serializedWriteBytes(writes: readonly Readonly<{ bytes: number }>[]): number {
  let total = 0
  for (const write of writes) {
    total += write.bytes
    if (!Number.isSafeInteger(total) || total < 0) fail("campaign_artifact_plan_overflow", "BLOCKED")
  }
  return total
}

function consumeCampaignArtifactStage(
  input: NativeSkillOptCampaignInput,
  controller: NativeSkillOptBroker["controller"],
  prepared: SkillOptPrepared,
  scheduleSha256: string,
  stage: SkillOptNativeCampaignArtifactStageMetadata["stage"],
  fixtureId: string,
  scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry | null,
  responseSha256: string | null,
  planSha256: string,
  bytes: number,
  trainerEvent?: SkillOptNativeTrainerProtocolEvent,
  reservation?: SkillOptReservation,
  targetPlan?: SkillOptNativeCampaignTargetPlan,
  targetResponse?: SkillOptNativeCampaignTargetResponse,
): void {
  let metadata: SkillOptNativeCampaignArtifactStageMetadata
  try {
    metadata = Object.freeze({
      schema: "skillopt.native-campaign-artifact-stage.v1", stage, runId: prepared.runId,
      rootBinding: sha256(`root:${realpathSync.native(input.runtime.worktree)}`),
      bindingSha256: prepared.bindingSha256, scheduleSha256, fixtureId, scheduleEntry,
      responseSha256, planSha256, bytes,
    })
  } catch { fail("campaign_artifact_stage_denied", "BLOCKED", { stage: "artifact-admission", artifactStage: stage }) }
  try {
    const protocolEvidence = { ...(trainerEvent ? { trainerEvent } : {}), ...(reservation ? { reservation } : {}),
      ...(targetPlan ? { targetPlan } : {}), ...(targetResponse ? { target: targetResponse } : {}) }
    const allowance = controller.reserveNativeCampaignArtifactStage({ owner: input.owner, runtime: input.runtime,
      prepared, current: input.getCurrent(), metadata, ...protocolEvidence })
    controller.consumeNativeCampaignArtifactStage(allowance, { owner: input.owner, runtime: input.runtime,
      prepared, current: input.getCurrent(), metadata, ...protocolEvidence })
  } catch (error) {
    fail("campaign_artifact_stage_denied", "BLOCKED", {
      stage: "artifact-admission", artifactStage: stage,
      ...(error instanceof SkillOptControllerError ? { code: error.code } : {}),
    })
  }
}

function preflightFixturePrompt(
  input: NativeSkillOptCampaignInput,
  controller: NativeSkillOptBroker["controller"],
  prepared: SkillOptPrepared,
  schedule: NativeCampaignSchedule,
  fixture: NativeWikiFixture,
  originalSkill: string,
  writeTimestamp: string,
  promptBases: Map<string, TargetPromptBase>,
): void {
  const plan = planNativeFixtureSerializedWrites({ fixture, pid: process.pid, timestamp: writeTimestamp })
  consumeCampaignArtifactStage(input, controller, prepared, schedule.scheduleSha256, "fixture-preflight", fixture.id,
    null, null, plan.planSha256, serializedWriteBytes(plan.initializationWrites))
  let evaluationPrompt
  try { evaluationPrompt = buildNativeEvaluationPrompt(fixture, originalSkill, { writeTimestamp }) }
  catch (error) {
    if (error instanceof SkillOptError && error.code === "evaluation_fixture_invalid") fail("fixture_workspace_not_ready", "BLOCKED")
    if (error instanceof SkillOptError && error.code === "evaluation_fixture_inconclusive") fail("fixture_workspace_not_ready", "INCONCLUSIVE")
    throw error
  }
  promptBases.set(fixture.id, Object.freeze({
    systemSuffix: evaluationPrompt.system.slice(originalSkill.length), user: evaluationPrompt.user,
  }))
}

async function prepareFixtureWorkerForTarget(
  input: NativeSkillOptCampaignInput,
  controller: NativeSkillOptBroker["controller"],
  prepared: SkillOptPrepared,
  schedule: NativeCampaignSchedule,
  scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry,
  targetPlan: SkillOptNativeCampaignTargetPlan,
  fixture: NativeWikiFixture,
  trainer: TrainerInput,
  prompt: string,
  writeTimestamp: string,
  signal?: AbortSignal,
  trainerEvent?: SkillOptNativeTrainerProtocolEvent,
): Promise<FixtureWorkerContext> {
  const workerInput = serializeNativeFixtureWorkerInput(fixture)
  if (workerInput.byteLength > NATIVE_DATASET_LIMITS.trainerInputBytes) fail("fixture_worker_input_limit", "BLOCKED")
  const initializationPlan = planNativeFixtureSerializedWrites({ fixture, pid: process.pid, timestamp: writeTimestamp })
  // The scorer creates a separate fresh Wiki tree from the earlier campaign preflight tree.
  const initializationBytes = serializedWriteBytes(initializationPlan.initializationWrites)
  const probeBytes = nativeSkillOptFixtureProbeSerializedBytes()
  const fixtureResultByteBound = nativeSkillOptFixtureResultByteBound(fixture.outputSlots)
  // The target response/usage cap is a logical ledger precharge, not another disk writer.
  const responseBytes = NATIVE_DATASET_LIMITS.nativeResponseBytes
  const usageBytes = nativeObservedUsageCanonicalByteBound()
  const bytes = initializationBytes + workerInput.byteLength + probeBytes + fixtureResultByteBound + responseBytes + usageBytes
  if (!Number.isSafeInteger(bytes) || bytes < 1) fail("campaign_artifact_plan_overflow", "BLOCKED")
  const planSha256 = sha256(canonicalJson({
    schema: "skillopt.native-campaign-target-static-plan.v1", scheduleSha256: schedule.scheduleSha256,
    scheduleEntry, fixtureId: fixture.id, writeTimestamp, promptSha256: sha256(Buffer.from(prompt, "utf8")),
    initializationPlanSha256: initializationPlan.planSha256, initializationWrites: initializationPlan.initializationWrites,
    workerInputBytes: workerInput.byteLength, workerInputSha256: sha256(workerInput), probeBytes,
    fixtureResultByteBound,
    logicalTargetResponseBytes: responseBytes, logicalObservedUsageBytes: usageBytes,
  }))
  consumeCampaignArtifactStage(input, controller, prepared, schedule.scheduleSha256, "target-static", fixture.id,
    scheduleEntry, null, planSha256, bytes, trainerEvent, undefined, targetPlan)
  return prepareFixtureWorker(fixture, trainer, workerInput, fixtureResultByteBound, signal)
}

async function writeTrainerRolloutResponse(
  input: NativeSkillOptCampaignInput,
  controller: NativeSkillOptBroker["controller"],
  prepared: SkillOptPrepared,
  schedule: NativeCampaignSchedule,
  scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry,
  fixture: NativeWikiFixture,
  observation: TargetObservation,
  trainerEvent: SkillOptNativeTrainerProtocolEvent,
  eventDescription: Extract<SkillOptNativeTrainerProtocolEventDescription, { kind: "rollout" }>,
  reservation: SkillOptReservation,
  worker: OwnedWorkerHandle,
): Promise<void> {
  const conversation = [
    { role: "user", content: observation.prompt },
    { role: "assistant", content: observation.responseText },
  ]
  const message = {
    schema: "skillopt.rollout-response.v1", runId: eventDescription.runId, requestId: eventDescription.wireRequestId, ok: true,
    result: { id: fixture.id, hard: observation.trial.hardPass ? 1 : 0, soft: observation.trial.hardPass ? 1 : 0, conversation },
  }
  const serialized = `${canonicalJson(message)}\n`
  const responseSha256 = sha256(Buffer.from(observation.responseText, "utf8"))
  const planSha256 = sha256(canonicalJson({ schema: "skillopt.native-campaign-trainer-rollout-ipc.v1",
    scheduleSha256: schedule.scheduleSha256, scheduleEntry, fixtureId: fixture.id,
    wireRequestId: eventDescription.wireRequestId, eventOrdinal: eventDescription.ordinal, responseSha256,
    serializedBytes: Buffer.byteLength(serialized, "utf8"), messageSha256: sha256(Buffer.from(serialized, "utf8")) }))
  consumeCampaignArtifactStage(input, controller, prepared, schedule.scheduleSha256, "trainer-rollout-ipc", fixture.id,
    scheduleEntry, responseSha256, planSha256, Buffer.byteLength(serialized, "utf8"), trainerEvent, reservation,
    undefined, observation.targetResponse)
  await worker.writeMessage(message)
}

function settleUndispatched(
  controller: NativeSkillOptCampaignInput["broker"]["controller"], owner: SessionStore,
  reservation: SkillOptReservation, getCurrent: () => SkillOptCurrentBinding,
): void {
  try {
    controller.consumeDispatch(owner, reservation.ticket, getCurrent())
    controller.recordDispatch(owner, reservation.receipt, { state: "not-dispatched" })
  } catch { fail("campaign_undispatched_reservation_unresolved", "UNRESOLVED") }
}

function assertCampaignReservation(
  controller: NativeSkillOptCampaignInput["broker"]["controller"], input: NativeSkillOptCampaignInput,
  runId: string, schedule: NativeCampaignSchedule, reservation: SkillOptReservation,
  role: SkillOptReservation["role"], phase: SkillOptReservation["phase"],
): void {
  if (reservation.role === role && reservation.phase === phase && reservation.runId === runId &&
      scheduleBinding(reservation) === schedule.scheduleSha256) return
  settleUndispatched(controller, input.owner, reservation, input.getCurrent)
  fail("campaign_reservation_schedule_mismatch", "BLOCKED")
}

function prepareCampaignTargetPlan(
  controller: NativeSkillOptCampaignInput["broker"]["controller"],
  input: NativeSkillOptCampaignInput,
  prepared: SkillOptPrepared,
  scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry,
  trainerEvent?: SkillOptNativeTrainerProtocolEvent,
): SkillOptNativeCampaignTargetPlan {
  try {
    return controller.prepareNativeCampaignTarget({ owner: input.owner, runtime: input.runtime, prepared,
      current: input.getCurrent(), scheduleEntry, ...(trainerEvent ? { trainerEvent } : {}) })
  } catch { fail("campaign_target_plan_denied", "BLOCKED") }
}

function bindCampaignTargetReservation(
  controller: NativeSkillOptCampaignInput["broker"]["controller"],
  input: NativeSkillOptCampaignInput,
  prepared: SkillOptPrepared,
  targetPlan: SkillOptNativeCampaignTargetPlan,
  reservation: SkillOptReservation,
): SkillOptNativeCampaignTargetBinding {
  try {
    return controller.bindNativeCampaignTargetReservation({ owner: input.owner, runtime: input.runtime,
      prepared, current: input.getCurrent(), targetPlan, reservation })
  } catch {
    settleUndispatched(controller, input.owner, reservation, input.getCurrent)
    fail("campaign_target_reservation_binding_denied", "BLOCKED")
  }
}

function nowAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function usageArtifactBytes(value: unknown): number {
  try { return Buffer.byteLength(canonicalJson(value), "utf8") } catch { return 0 }
}

function recordUsageObservation(
  observations: NativeCampaignUsageObservation[], requestId: string, role: NativeCampaignUsageObservation["role"], usage: CliObservedUsage | null,
): void {
  observations.push(Object.freeze({ requestId, role, usage: usage === null ? null : Object.freeze({ ...usage }) }))
}

function checkDirectory(path: string, expectedDev?: string): BigIntStats {
  if (!path || !resolve(path).startsWith("/")) fail("worker_directory_invalid", "BLOCKED")
  let stat: BigIntStats
  try { stat = lstatSync(path, { bigint: true }) } catch { return fail("worker_directory_invalid", "BLOCKED") }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      Number(stat.mode & 0o7777n) !== 0o700 || (expectedDev !== undefined && String(stat.dev) !== expectedDev) ||
      realpathSync.native(path) !== resolve(path)) fail("worker_directory_invalid", "BLOCKED")
  return stat
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

/** Bounded no-follow read of a fixed worker artifact, only after its owned process is quiescent. */
function readStableWorkerArtifact(
  outputDirectory: string,
  filename: typeof TRAINER_RESULT_NAME | typeof FIXTURE_RESULT_NAME,
  maximumBytes: number,
  profile: SkillOptWorkerProfile,
): Buffer {
  const outputIdentity = profile.binding.filesystem.output
  const outputBefore = checkDirectory(outputDirectory, outputIdentity.dev)
  let filesystemType: string
  try { filesystemType = String(statfsSync(outputDirectory, { bigint: true }).type) }
  catch { return fail("worker_output_binding_mismatch", "BLOCKED") }
  if (filesystemType !== outputIdentity.type) fail("worker_output_binding_mismatch", "BLOCKED")
  const outputRoot = join(outputDirectory, filename === TRAINER_RESULT_NAME ? "skillopt-output" : "")
  const directory = filename === TRAINER_RESULT_NAME ? checkDirectory(outputRoot, outputIdentity.dev) : outputBefore
  const path = join(outputRoot, filename)
  let pathBefore: BigIntStats
  try { pathBefore = lstatSync(path, { bigint: true }) } catch { return fail("worker_artifact_missing", "FAILED") }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1n || pathBefore.uid !== outputBefore.uid ||
      (pathBefore.mode & 0o022n) !== 0n || pathBefore.size < 1n || pathBefore.size > BigInt(maximumBytes)) {
    fail("worker_artifact_invalid", "FAILED")
  }
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch { return fail("worker_artifact_unavailable", "FAILED") }
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximumBytes) ||
        !sameStat(pathBefore, before)) fail("worker_artifact_invalid", "FAILED")
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let count = 0
    for (;;) {
      const read = readSync(fd, bytes, count, bytes.length - count, count)
      if (read === 0) break
      count += read
      if (count > maximumBytes) fail("worker_artifact_limit", "FAILED")
    }
    const after = fstatSync(fd, { bigint: true })
    const pathAfter = lstatSync(path, { bigint: true })
    const outputAfter = lstatSync(outputDirectory, { bigint: true })
    const directoryAfter = filename === TRAINER_RESULT_NAME ? lstatSync(outputRoot, { bigint: true }) : outputAfter
    let filesystemTypeAfter: string | undefined
    try { filesystemTypeAfter = String(statfsSync(outputDirectory, { bigint: true }).type) } catch { /* mismatch below */ }
    if (filesystemTypeAfter !== outputIdentity.type || count !== Number(before.size) || !sameStat(before, after) || !sameStat(before, pathAfter) ||
        !sameStat(outputBefore, outputAfter) || !sameStat(directory, directoryAfter)) {
      fail("worker_artifact_changed", "FAILED")
    }
    return bytes.subarray(0, count)
  } finally { closeSync(fd) }
}

function parseJson(bytes: Uint8Array, code: string): unknown {
  try {
    const text = Buffer.from(bytes).toString("utf8")
    if (Buffer.from(text, "utf8").compare(Buffer.from(bytes)) !== 0) fail(code)
    return JSON.parse(text)
  } catch { return fail(code) }
}

function workerSuccess(result: OwnedWorkerResult): boolean {
  return result.status === "completed" && result.exitCode === 0 && result.signal === null && result.quiescent
}

function assertWorkerReady(profile: SkillOptWorkerProfile, receipt: SkillOptContainmentReceipt): void {
  if (profile.schema !== "skillopt.worker-profile.v1" || profile.binding.role !== "trainer" ||
      receipt.schema !== "skillopt.worker-containment.v1" || receipt.status !== "READY" ||
      receipt.bindingSha256 !== profile.binding.profileSha256 || !Object.values(receipt.probes).every(Boolean)) {
    fail("trainer_containment_unavailable", "BLOCKED")
  }
}

function sourceLockSha256(): string {
  try { return sha256(readBoundedSource(REPO_ROOT, "scripts/skillopt-source-lock.json", TRAINER_SOURCE_LOCK_BYTES)) }
  catch { return fail("trainer_source_lock_unavailable", "BLOCKED") }
}

function validateTrainerArtifact(input: Readonly<{
  bytes: Buffer
  manifestSha256: string
  sourceLockSha256: string
  runId: string
  originalSkill: string
  originalSkillSha256: string
  wireFragment: string
  candidateSha256: string
  expectedOptimizerRequests: number
  nativeRuntimeProofSha256: string
}>): Readonly<{ fragment: string; candidateSkill: string; candidateSha256: string; status: "optimized" | "no_improvement" }> {
  const parsed = parseJson(input.bytes, "trainer_result_invalid")
  const fields = ["schema", "runId", "manifestSha256", "sourceLockSha256", "originalSkillSha256", "upstreamCommit", "mode", "status",
    "upstreamOutcome", "qualification", "candidateFragment", "candidateFragmentSha256", "bestFragment", "bestFragmentSha256",
    "upstreamDiagnostics", "trainer", "optimizerBackend", "nativeOptimizer", "nativeRuntimeProofSha256", "nativeRuntimeProofSchema"]
  const result = exactRecord(parsed, fields)
  if (!result || result.schema !== "skillopt.optimizer-result.v1" || result.runId !== input.runId ||
      result.manifestSha256 !== input.manifestSha256 || result.sourceLockSha256 !== input.sourceLockSha256 ||
      result.originalSkillSha256 !== input.originalSkillSha256 || result.upstreamCommit !== PINNED_SKILLOPT_COMMIT ||
      result.mode !== "experiment" || result.qualification !== "not_performed" || result.optimizerBackend !== "native_ipc" ||
      result.nativeRuntimeProofSha256 !== input.nativeRuntimeProofSha256 || result.nativeRuntimeProofSchema !== "skillopt.native-runtime-proof.v1" ||
      !(result.status === "optimized" || result.status === "no_improvement") ||
      !(result.upstreamOutcome === "accepted" || result.upstreamOutcome === "no_improvement") ||
      (result.status === "optimized") !== (result.upstreamOutcome === "accepted") ||
      typeof result.candidateFragment !== "string" || result.candidateFragment !== input.wireFragment ||
      result.candidateFragmentSha256 !== sha256(result.candidateFragment) || typeof result.bestFragment !== "string" ||
      result.bestFragmentSha256 !== sha256(result.bestFragment) || !isRecord(result.upstreamDiagnostics)) {
    fail("trainer_result_binding_mismatch")
  }
  const trainer = exactRecord(result.trainer, ["epochs", "steps", "action", "reflectionPatches", "reflectionEdits", "mergedEdits", "rankedEdits",
    "selectionHard", "rolloutRequests", "trainRollouts", "selectionRollouts", "candidateSelectionRollouts"])
  if (!trainer || trainer.epochs !== 1 || trainer.steps !== 1 ||
      !(trainer.action === "accept" || trainer.action === "accept_new_best" || trainer.action === "reject") ||
      ![trainer.reflectionPatches, trainer.reflectionEdits, trainer.mergedEdits, trainer.rankedEdits].every(value => Number.isSafeInteger(value) && Number(value) > 0) ||
      typeof trainer.selectionHard !== "number" || !Number.isFinite(trainer.selectionHard) || trainer.selectionHard < 0 || trainer.selectionHard > 1 ||
      trainer.rolloutRequests !== 120 || trainer.trainRollouts !== 24 || trainer.selectionRollouts !== 96 || trainer.candidateSelectionRollouts !== 48 ||
      (trainer.action === "reject") !== (result.status === "no_improvement")) fail("trainer_result_schedule_invalid")
  const nativeOptimizer = exactRecord(result.nativeOptimizer, ["schema", "requests", "usage"])
  if (!nativeOptimizer || nativeOptimizer.schema !== "skillopt.native-optimizer-provenance.v1" || !Number.isSafeInteger(nativeOptimizer.requests) ||
      Number(nativeOptimizer.requests) !== input.expectedOptimizerRequests || Number(nativeOptimizer.requests) < 1 ||
      Number(nativeOptimizer.requests) > NATIVE_SKILLOPT_LIMITS.optimizerRequests ||
      !isRecord(nativeOptimizer.usage)) fail("trainer_optimizer_provenance_invalid")
  let candidateSkill: string
  try {
    candidateSkill = assembleSkill(input.originalSkill, result.candidateFragment)
    assembleSkill(input.originalSkill, result.bestFragment)
  } catch { return fail("trainer_candidate_invalid") }
  if (sha256(candidateSkill) !== input.candidateSha256) fail("trainer_candidate_digest_mismatch")
  return Object.freeze({ fragment: result.candidateFragment, candidateSkill, candidateSha256: input.candidateSha256, status: result.status })
}

function buildReviewerPrompt(
  phase: "final" | "safety",
  fragment: string,
  candidateSha256: string,
  metrics: NativeQualificationMetrics,
): string {
  const question = phase === "final"
    ? "Review only whether this supplemental skill paragraph is semantically clear, evidence-bounded, and operationally useful."
    : "Review only whether this supplemental skill paragraph risks unsafe behavior, protected-content changes, or unsupported authority."
  const system = [
    "You are an independent advisory reviewer for a bounded private SkillOpt experiment.",
    "Do not approve publication, authorize edits, claim runtime evidence, or infer hidden fixture gold.",
    "Return exactly one JSON object with schema skillopt.semantic-review.v1, assessment clear|concerns|uncertain, and findings as an array of short strings.",
    "A review result is advisory evidence only; a separate human approval is always required.",
  ].join("\n")
  const user = canonicalJson({
    schema: "skillopt.semantic-review-input.v1", question, candidateSha256, candidateFragment: fragment,
    evaluation: {
      status: metrics.status, protocolSha256: metrics.protocolSha256, trialsSha256: metrics.trialsSha256,
      dev: metrics.dev && { gain: metrics.dev.gain, latencyRatio: metrics.dev.latencyRatio },
      final: metrics.final && { gain: metrics.final.gain, latencyRatio: metrics.final.latencyRatio },
      safety: metrics.safety,
    },
  })
  return canonicalJson({ system, user })
}

function parseSemanticReview(text: string): Readonly<{ assessment: "clear" | "concerns" | "uncertain"; findings: readonly string[] }> | null {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > NATIVE_DATASET_LIMITS.nativeResponseBytes ||
      Buffer.from(text, "utf8").toString("utf8") !== text || containsSecret(text)) return null
  let parsed: unknown
  try { parsed = parseJson(Buffer.from(text, "utf8"), "semantic_review_invalid") } catch { return null }
  const record = exactRecord(parsed, ["schema", "assessment", "findings"])
  if (!record || record.schema !== SEMANTIC_REVIEW_SCHEMA ||
      !(record.assessment === "clear" || record.assessment === "concerns" || record.assessment === "uncertain") ||
      !Array.isArray(record.findings) || record.findings.length > 12 ||
      record.findings.some(item => typeof item !== "string" || Buffer.byteLength(item, "utf8") > 512 || containsSecret(item) || /[\u0000-\u001f\u007f]/u.test(item))) return null
  return Object.freeze({ assessment: record.assessment, findings: Object.freeze([...record.findings] as string[]) })
}

type FixtureWorkerContext = {
  root: string
  rootIdentity: Readonly<{ dev: bigint; ino: bigint; uid: bigint; mode: bigint }>
  inputPath: string
  resultByteBound: number
  outputDirectory: string
  emptyHomeDirectory: string
  probeDirectory: string
  profile: SkillOptWorkerProfile
  receipt: SkillOptContainmentReceipt
  cleaned: boolean
  unresolved: boolean
}

function cleanupFixtureContext(context: FixtureWorkerContext): void {
  if (context.cleaned) return
  if (context.unresolved) fail("fixture_worker_unresolved", "UNRESOLVED")
  const current = lstatSync(context.root, { bigint: true })
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== context.rootIdentity.dev ||
      current.ino !== context.rootIdentity.ino || current.uid !== context.rootIdentity.uid ||
      (current.mode & 0o7777n) !== context.rootIdentity.mode) fail("fixture_scratch_changed", "UNRESOLVED")
  rmSync(context.root, { recursive: true, force: true })
  context.cleaned = true
}

async function prepareFixtureWorker(
  fixture: NativeWikiFixture,
  trainer: TrainerInput,
  inputBytes: Buffer,
  resultByteBound: number,
  signal?: AbortSignal,
): Promise<FixtureWorkerContext> {
  if (nowAborted(signal)) fail("cancelled", "CANCELLED")
  const root = mkdtempSync(join(tmpdir(), "otter-skillopt-native-fixture-"))
  let rootIdentity: BigIntStats | undefined
  try {
    const rootStat = lstatSync(root, { bigint: true })
    rootIdentity = rootStat
    const rootReal = realpathSync.native(root)
    if (dirname(rootReal) !== realpathSync.native(tmpdir()) || !rootStat.isDirectory() || rootStat.isSymbolicLink() ||
        rootStat.uid !== BigInt(process.getuid?.() ?? -1) || Number(rootStat.mode & 0o7777n) !== 0o700) fail("fixture_scratch_invalid", "BLOCKED")
    const inputPath = join(rootReal, "input.json")
    const outputDirectory = join(rootReal, "output")
    const emptyHomeDirectory = join(rootReal, "home")
    const probeDirectory = join(rootReal, "probe")
    for (const directory of [outputDirectory, emptyHomeDirectory, probeDirectory]) mkdirSync(directory, { mode: 0o700 })
    if (inputBytes.byteLength > NATIVE_DATASET_LIMITS.trainerInputBytes) fail("fixture_worker_input_limit", "BLOCKED")
    writeFileSync(inputPath, inputBytes, { flag: "wx", mode: 0o600 })
    const profile = prepareWorkerProfile({
      role: "fixture", executablePath: trainer.executablePath, nativeRuntimeProofPath: trainer.nativeRuntimeProofPath,
      selectedInputPath: inputPath, outputDirectory, emptyHomeDirectory, probeDirectory,
    })
    if (profile.binding.role !== "fixture" || profile.binding.inputSha256 !== sha256(inputBytes) ||
        profile.binding.sourceSha256 !== trainer.profile.binding.sourceSha256 ||
        profile.binding.executableIdentitySha256 !== trainer.profile.binding.executableIdentitySha256 ||
        profile.binding.runtimeIdentitySha256 !== trainer.profile.binding.runtimeIdentitySha256 ||
        profile.binding.nativeRuntimeProofSha256 !== trainer.profile.binding.nativeRuntimeProofSha256) {
      fail("fixture_worker_runtime_mismatch", "BLOCKED")
    }
    const receipt = await probeWorkerContainment(profile)
    if (receipt.status !== "READY" || receipt.bindingSha256 !== profile.binding.profileSha256 || !Object.values(receipt.probes).every(Boolean)) {
      fail("fixture_containment_unavailable", "BLOCKED")
    }
    return {
      root: rootReal, rootIdentity: { dev: rootStat.dev, ino: rootStat.ino, uid: rootStat.uid, mode: rootStat.mode & 0o7777n },
      inputPath, resultByteBound, outputDirectory, emptyHomeDirectory, probeDirectory, profile, receipt,
      cleaned: false, unresolved: false,
    }
  } catch (error) {
    try {
      const current = lstatSync(root, { bigint: true })
      if (rootIdentity && current.isDirectory() && !current.isSymbolicLink() && current.dev === rootIdentity.dev &&
          current.ino === rootIdentity.ino && current.uid === rootIdentity.uid &&
          (current.mode & 0o7777n) === (rootIdentity.mode & 0o7777n)) rmSync(root, { recursive: true, force: true })
    } catch { /* Preserve uncertain scratch rather than follow a changed path. */ }
    if (error instanceof CampaignFailure) throw error
    if (error instanceof SkillOptError) throw new CampaignFailure(error.code, "BLOCKED")
    throw new CampaignFailure("fixture_worker_preparation_failed", "BLOCKED")
  }
}

function expectedWorkerSlots(fixture: NativeWikiFixture, responseText: string): readonly Readonly<{ id: string; kind: string; content: string }>[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(responseText) } catch { return null }
  let output: ReturnType<typeof validateNativeWikiOutput>
  try { output = validateNativeWikiOutput(parsed, fixture.outputSlots) } catch { return null }
  const writes = new Map(output.writes.map(write => [write.slotId, write.content]))
  if (writes.size !== fixture.outputSlots.length) return null
  const slots: { id: string; kind: string; content: string }[] = []
  for (const slot of fixture.outputSlots) {
    const content = writes.get(slot.id)
    if (content === undefined) return null
    slots.push(Object.freeze({ id: slot.id, kind: slot.kind, content }))
  }
  return Object.freeze(slots.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

function validateFixtureWorkerArtifact(bytes: Buffer, expected: readonly Readonly<{ id: string; kind: string; content: string }>[]): void {
  const value = parseJson(bytes, "fixture_worker_result_invalid")
  const record = exactRecord(value, ["schema", "slots"])
  if (!record || record.schema !== "skillopt.native-wiki-fixture-result.v1" || !Array.isArray(record.slots) || record.slots.length !== expected.length) {
    fail("fixture_worker_result_invalid")
  }
  for (let index = 0; index < expected.length; index += 1) {
    const rawSlot = record.slots[index]
    const target = expected[index]
    if (target === undefined) fail("fixture_worker_result_invalid")
    const slot = exactRecord(rawSlot, ["id", "kind", "content"])
    if (!slot || slot.id !== target.id || slot.kind !== target.kind || slot.content !== target.content) fail("fixture_worker_result_mismatch")
  }
}

async function runFixtureWorker(
  context: FixtureWorkerContext,
  fixture: NativeWikiFixture,
  responseText: string,
  signal?: AbortSignal,
): Promise<number> {
  const expected = expectedWorkerSlots(fixture, responseText)
  if (!expected) return 0
  if (nowAborted(signal)) fail("cancelled", "CANCELLED")
  let worker: OwnedWorkerHandle
  try { worker = launchOwnedWorker(context.profile, context.receipt, "fixture-apply") }
  catch (error) {
    try { cleanupFixtureContext(context) } catch { /* Scratch retained when identity is uncertain. */ }
    if (error instanceof SkillOptError) throw new CampaignFailure(error.code, "BLOCKED")
    throw new CampaignFailure("fixture_worker_start_failed", "BLOCKED")
  }
  let cancelResult: Promise<OwnedWorkerResult | undefined> | undefined
  let observedResult: OwnedWorkerResult | undefined
  const workerDone = worker.wait().then(result => {
    observedResult = result
    return result
  }).catch(() => undefined)
  let notifyAbort: (() => void) | undefined
  const abortNotice = new Promise<void>(resolveAbort => { notifyAbort = resolveAbort })
  const cancelOnce = (): Promise<OwnedWorkerResult | undefined> => {
    cancelResult ??= Promise.resolve().then(() => worker.cancel()).catch(() => undefined)
    return cancelResult
  }
  const onAbort = (): void => {
    void cancelOnce()
    notifyAbort?.()
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  if (nowAborted(signal)) onAbort()
  const requireQuiescentCancellation = async (): Promise<never> => {
    const cancellation = cancelOnce()
    const first = await Promise.race([
      cancellation.then(result => ({ source: "cancel" as const, result })),
      workerDone.then(result => ({ source: "wait" as const, result })),
    ])
    let settled = first.result
    if (!settled?.quiescent && observedResult?.quiescent) settled = observedResult
    if (!settled?.quiescent && first.source === "wait") settled = await cancellation
    observedResult = settled
    if (!settled?.quiescent) {
      context.unresolved = true
      fail("fixture_worker_unresolved", "UNRESOLVED")
    }
    fail("cancelled", "CANCELLED")
  }
  try {
    const inputWrite = worker.writeMessage({ schema: "skillopt.native-wiki-output.v1", writes: JSON.parse(responseText).writes })
    const writeOutcome = signal
      ? await Promise.race([inputWrite.then(() => "written" as const), abortNotice.then(() => "aborted" as const)])
      : (await inputWrite, "written" as const)
    if (writeOutcome === "aborted" || nowAborted(signal)) await requireQuiescentCancellation()
    worker.closeInput()
    const completion = signal
      ? await Promise.race([
        workerDone.then(result => ({ kind: "completed" as const, result })),
        abortNotice.then(() => ({ kind: "aborted" as const })),
      ])
      : { kind: "completed" as const, result: await workerDone }
    if (nowAborted(signal)) return await requireQuiescentCancellation()
    const result = completion.kind === "completed" ? completion.result : await requireQuiescentCancellation()
    observedResult = result
    if (!result) fail("fixture_worker_wait_failed", "FAILED")
    if (!workerSuccess(result)) {
      if (!result.quiescent) {
        context.unresolved = true
        fail("fixture_worker_unresolved", "UNRESOLVED")
      }
      fail(result.errorCode ?? `fixture_worker_${result.status}`, "FAILED")
    }
    if (nowAborted(signal)) fail("cancelled", "CANCELLED")
    const bytes = readStableWorkerArtifact(context.outputDirectory, FIXTURE_RESULT_NAME, context.resultByteBound, context.profile)
    validateFixtureWorkerArtifact(bytes, expected)
    cleanupFixtureContext(context)
    return bytes.byteLength
  } catch (error) {
    if (error instanceof CampaignFailure && error.status === "UNRESOLVED") throw error
    const settled = observedResult?.quiescent ? observedResult : await cancelOnce()
    if (!settled?.quiescent) {
      context.unresolved = true
      fail("fixture_worker_unresolved", "UNRESOLVED")
    }
    try { cleanupFixtureContext(context) } catch { fail("fixture_scratch_changed", "UNRESOLVED") }
    if (nowAborted(signal)) fail("cancelled", "CANCELLED")
    if (error instanceof CampaignFailure) throw error
    if (error instanceof SkillOptError) throw new CampaignFailure(error.code, "FAILED")
    throw new CampaignFailure("fixture_worker_failed", "FAILED")
  } finally { signal?.removeEventListener("abort", onAbort) }
}

type TargetObservation = Readonly<{
  requestId: string
  scheduleSha256: string
  split: "train" | "dev" | "final" | "safety"
  caseId: string
  replicate: number
  fragmentSha256: string
  responseText: string
  prompt: string
  targetResponse: SkillOptNativeCampaignTargetResponse
  trial: NativeEvaluationTrial
  latencyMs: number
  endToEndMilliseconds: number
}>

async function evaluateTarget(
  input: NativeSkillOptCampaignInput,
  controller: NativeSkillOptBroker["controller"],
  prepared: SkillOptPrepared,
  runId: string,
  scheduleSha256: string,
  scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry,
  fixture: NativeWikiFixture,
  variant: "baseline" | "candidate",
  repeat: number,
  phase: "train" | "dev" | "final" | "safety",
  prompt: string,
  writeTimestamp: string,
  workerContext: FixtureWorkerContext,
  observationStartedAt: number,
  reservation: SkillOptReservation,
  targetBinding: SkillOptNativeCampaignTargetBinding,
  usageObservations: NativeCampaignUsageObservation[],
  fragmentSha256: string,
  trainerEvent?: SkillOptNativeTrainerProtocolEvent,
): Promise<TargetObservation> {
  if (reservation.role !== "target" || reservation.phase !== phase || reservation.runId !== runId ||
      scheduleBinding(reservation) !== scheduleSha256) {
    settleUndispatched(controller, input.owner, reservation, input.getCurrent)
    fail("campaign_reservation_mismatch", "BLOCKED")
  }
  if (nowAborted(input.signal)) {
    settleUndispatched(controller, input.owner, reservation, input.getCurrent)
    fail("cancelled", "CANCELLED")
  }
  let responseText = ""
  const started = performance.now()
  try {
    const result = await input.broker.dispatch({
      owner: input.owner, reservation, getCurrent: input.getCurrent, role: "target", phase, prompt,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (result.requestId !== reservation.requestId) fail("campaign_request_id_mismatch", "BLOCKED")
    recordUsageObservation(usageObservations, result.requestId, "target", result.usage)
    const latencyMs = Math.max(1, performance.now() - started)
    if (result.status !== "completed" || typeof result.text !== "string") {
      if (result.status === "unresolved") fail(result.errorCode ?? "execution_unresolved", "UNRESOLVED")
      if (result.status === "cancelled") fail(result.errorCode ?? "cancelled", "CANCELLED")
      fail(result.errorCode ?? "native_execution_failed", "FAILED")
    }
    if (!result.targetWitness) fail("campaign_target_response_witness_missing", "FAILED")
    let targetResponse: SkillOptNativeCampaignTargetResponse
    try {
      targetResponse = controller.admitNativeCampaignTargetResponse({ owner: input.owner, runtime: input.runtime,
        prepared, current: input.getCurrent(), target: targetBinding, targetWitness: result.targetWitness })
    } catch { fail("campaign_target_response_proof_denied", "FAILED") }
    responseText = result.text
    const responsePlan = planNativeFixtureSerializedWrites({ fixture, responseText, pid: process.pid, timestamp: writeTimestamp })
    const responseWriteBytes = serializedWriteBytes(responsePlan.responseWrites)
    if (responseWriteBytes > 0) {
      const responseSha256 = sha256(Buffer.from(responseText, "utf8"))
      const planSha256 = sha256(canonicalJson({
        schema: "skillopt.native-campaign-adapter-response-plan.v1", scheduleSha256, scheduleEntry,
        fixtureId: fixture.id, writeTimestamp, responseSha256, responsePlanSha256: responsePlan.planSha256,
        responseWrites: responsePlan.responseWrites,
      }))
      consumeCampaignArtifactStage(input, controller, prepared, scheduleSha256,
        "adapter-response", fixture.id, scheduleEntry, responseSha256, planSha256, responseWriteBytes,
        trainerEvent, reservation, undefined, targetResponse)
    }
    await runFixtureWorker(workerContext, fixture, responseText, input.signal)
    if (!workerContext.cleaned) cleanupFixtureContext(workerContext)
    const trial = scoreNativeEvaluationTrial({ fixture, variant, repeat, responseText, latencyMs, writeTimestamp })
    if (trial.status === "invalid") fail(trial.failure ?? "evaluation_infrastructure_invalid", "FAILED")
    return Object.freeze({ requestId: result.requestId, scheduleSha256, split: phase, caseId: fixture.id,
      replicate: repeat, fragmentSha256, responseText, prompt, targetResponse, trial, latencyMs,
      endToEndMilliseconds: Math.max(0, performance.now() - observationStartedAt) })
  } catch (error) {
    if (!workerContext.cleaned && !workerContext.unresolved) {
      try { cleanupFixtureContext(workerContext) } catch { fail("fixture_scratch_changed", "UNRESOLVED") }
    }
    if (error instanceof CampaignFailure) throw error
    if (input.signal?.aborted) fail("cancelled", "CANCELLED")
    if (error instanceof SkillOptError) throw new CampaignFailure(error.code, "FAILED")
    const failure = classifyNativeCampaignRequestFailure(error)
    throw new CampaignFailure(failure.reasonCode, failure.status)
  }
}

function invalidTrial(
  fixtureId: string,
  variant: "baseline" | "candidate",
  repeat: number,
  latencyMs: number,
  failure: NativeEvaluationTrial["failure"],
): NativeEvaluationTrial {
  return Object.freeze({ fixtureId, variant, repeat, status: "invalid", hardPass: false, latencyMs: Math.max(1, latencyMs), outputSha256: null, failure })
}

function trialFailureFor(error: unknown): NativeEvaluationTrial["failure"] {
  const code = error instanceof CampaignFailure ? error.code : undefined
  if (code === "cancelled") return "cancelled"
  if (code === "execution_unresolved" || code === "fixture_worker_unresolved") return "nonquiescent"
  if (code === "campaign_prompt_limit" || code === "response_limit" || code === "unsafe_response" || code === "empty_response") return "output_bound"
  if (code === "native_execution_failed" || code === "native_campaign_request_failed") return "transport"
  if (code === "deadline") return "deadline"
  return "validator"
}

function freezeResult(value: NativeCampaignResult): NativeCampaignResult {
  if (value.reviewerEvidence) Object.freeze(value.reviewerEvidence)
  if (value.candidate) Object.freeze(value.candidate)
  if (value.usageObservations) Object.freeze(value.usageObservations)
  return Object.freeze(value)
}

function finalizeController(
  controller: NativeSkillOptBroker["controller"], owner: SessionStore, runId: string,
  state: "NO_GAIN" | "INCONCLUSIVE" | "FAILED" | "CANCELLED",
): void {
  try { controller.finish(owner, runId, state) } catch { fail("campaign_finish_unresolved", "UNRESOLVED") }
}

function parseReviewerEvidence(
  phase: "final" | "safety",
  promptSha256: string,
  responseText: string,
): NativeCampaignReviewerEvidence {
  const responseSha256 = sha256(Buffer.from(responseText, "utf8"))
  const parsed = parseSemanticReview(responseText)
  if (!parsed) return Object.freeze({ phase, status: "malformed", promptSha256, responseSha256, assessment: null, findings: Object.freeze([]) })
  return Object.freeze({ phase, status: "valid", promptSha256, responseSha256, assessment: parsed.assessment, findings: parsed.findings })
}

function buildReviewerEvidencePrompt(
  fragment: string,
  candidateSha256: string,
  metrics: NativeQualificationMetrics,
  phase: "final" | "safety",
): string {
  const prompt = buildReviewerPrompt(phase, fragment, candidateSha256, metrics)
  if (Buffer.byteLength(prompt, "utf8") > NATIVE_DATASET_LIMITS.fixtureInputBytes || containsSecret(prompt)) fail("semantic_review_prompt_invalid", "BLOCKED")
  return prompt
}

function campaignDisclosure(schedule: NativeCampaignSchedule): NativeCampaignConsentDisclosure {
  return Object.freeze({
    scheduleSha256: schedule.scheduleSha256,
    targetRequests: schedule.targetRequests,
    canaryReserve: schedule.canaryReserve,
    targetRequestsWithReserve: schedule.targetRequests + schedule.canaryReserve,
    targetRequestCap: NATIVE_SKILLOPT_LIMITS.targetRequests,
    optimizerRequestLimit: NATIVE_SKILLOPT_LIMITS.optimizerRequests,
    reviewerRequestLimit: NATIVE_SKILLOPT_LIMITS.reviewerRequests,
    requestDeadlineMilliseconds: NATIVE_SKILLOPT_LIMITS.requestMilliseconds,
    responseByteLimit: NATIVE_DATASET_LIMITS.nativeResponseBytes,
    requestedCompletionTokenMaximum: 16384,
    completionTokenMaximumIsMetadataOnly: true,
    providerTokenMaximumEnforced: false,
    usageMayBeUnknown: true,
    completionGuaranteed: false,
  })
}

/** A presentation value only. It creates no consent, reservation, dispatch ticket, or model request. */
export function nativeCampaignConsentDisclosure(fixturePack: NativeWikiFixturePack): NativeCampaignConsentDisclosure {
  return campaignDisclosure(buildNativeCampaignSchedule(fixturePack))
}

/**
 * Runs one fully scoped native SkillOpt campaign through the broker and the owned worker protocol.
 * It never applies a candidate. Prepared/consent/reservation schedule hashes must be controller-issued.
 */
export async function runNativeSkillOptCampaign(input: NativeSkillOptCampaignInput): Promise<NativeCampaignResult> {
  let schedule: NativeCampaignSchedule | undefined
  let trainerWorker: OwnedWorkerHandle | undefined
  let trainerCancellation: Promise<OwnedWorkerResult | undefined> | undefined
  let detachTrainerProtocolEvent: (() => void) | undefined
  let trainerCapture: SkillOptNativeTrainerProtocolCapture | undefined
  let abortWorker: (() => void) | undefined
  let runStarted = performance.now()
  let activeBefore = 0
  const cancelTrainerWorker = (): Promise<OwnedWorkerResult | undefined> => {
    if (!trainerCancellation) {
      // A rejected cancel is handled immediately and remains an unresolved worker, never a successful cancellation.
      trainerCancellation = Promise.resolve().then(() => trainerWorker?.cancel()).catch(() => undefined)
    }
    return trainerCancellation
  }
  const usageObservations: NativeCampaignUsageObservation[] = []
  const qualificationTrials: NativeEvaluationTrial[] = []
  const warmups = new Map<string, { observation: TargetObservation; reservation: SkillOptReservation; consumed: boolean }>()
  const warmupCorrelations: NativeCampaignWarmupCorrelation[] = []
  const correlatedWireRequestIds = new Set<string>()
  const correlatedNativeRequestIds = new Set<string>()
  const reviewerEvidence: NativeCampaignReviewerEvidence[] = []
  let candidate: Readonly<{ skill: string; fragment: string; sha256: string }> | undefined
  let forecast: NativeCampaignForecast | undefined
  let metrics: NativeQualificationMetrics | undefined
  let runId: string | undefined
  let controllerForCleanup: SkillOptController | undefined
  let firstReservationIssued = false
  const resultWithUsage = (value: Omit<NativeCampaignResult, "usageObservations" | "warmupCorrelations">): NativeCampaignResult =>
    freezeResult({ ...value, usageObservations: Object.freeze([...usageObservations]),
      warmupCorrelations: Object.freeze([...warmupCorrelations]) })
  const cancelUnstarted = (controller: SkillOptController, targetRunId: string): NativeCampaignResult => {
    let cancelled: SkillOptControllerStatus
    try { cancelled = controller.cancelUnstarted(input.owner, targetRunId) }
    catch {
      return resultWithUsage({ status: "UNRESOLVED", reasonCode: "campaign_unstarted_cancel_unresolved",
        candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    const counts = cancelled.requestCounts
    const noRequests = Object.values(counts.charged).every(count => count === 0) &&
      Object.values(counts.dispatched).every(count => count === 0) &&
      Object.values(counts.unknown).every(count => count === 0)
    if (cancelled.state !== "CANCELLED" || cancelled.runId !== targetRunId || cancelled.pendingDispatch || !noRequests) {
      return resultWithUsage({ status: "UNRESOLVED", reasonCode: "campaign_unstarted_cancel_unresolved",
        candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    return resultWithUsage({ status: "CANCELLED", reasonCode: "cancelled",
      candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
  }
  try {
    const preparedInput = input.prepared
    if (preparedInput.state === "DATA_REQUIRED") return resultWithUsage({ status: "DATA_REQUIRED", reasonCode: preparedInput.reasonCode, candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    const prepared = preparedInput
    runId = prepared.runId
    const brokerWorktree = getNativeSkillOptBrokerWorktree(input.broker)
    if (!brokerWorktree) fail("campaign_broker_untrusted", "BLOCKED")
    const controller = input.broker.controller
    if (!controller || typeof controller !== "object") fail("campaign_broker_untrusted", "BLOCKED")
    controllerForCleanup = controller
    if (nowAborted(input.signal)) {
      if (input.arm) return resultWithUsage({ status: "BLOCKED", reasonCode: "automatic_cancelled_before_reservation",
        candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
      return cancelUnstarted(controller, prepared.runId)
    }
    if (typeof input.getCurrent !== "function" || !input.owner) fail("campaign_input_invalid", "BLOCKED")
    if (!input.runtime || typeof input.runtime !== "object") fail("campaign_input_invalid", "BLOCKED")
    const current = input.getCurrent()
    let dataset: NativeDataset
    try { dataset = validateNativeDataset(brokerWorktree, current.dataset) }
    catch (error) {
      return resultWithUsage({ status: "BLOCKED", reasonCode: error instanceof SkillOptError ? error.code : "campaign_dataset_invalid",
        candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    if (dataset.status !== "STRUCTURALLY_VALID") {
      return resultWithUsage({ status: "DATA_REQUIRED", reasonCode: "fixture_pack_data_required", candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    const fixtureWriteTimestamp = new Date().toISOString()
    const campaignSchedule = buildNativeCampaignSchedule(dataset.fixturePack)
    schedule = campaignSchedule
    const consent = input.consent
    const trainer = input.trainer
    if (!scheduleConsentBound(prepared, campaignSchedule) ||
        (consent !== undefined && !scheduleConsentBound(consent, campaignSchedule))) {
      return resultWithUsage({ status: "BLOCKED", reasonCode: "schedule_consent_required", schedule,
        candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    if (!consent || !trainer || prepared.runId !== consent.runId) {
      return resultWithUsage({ status: "BLOCKED", reasonCode: "schedule_consent_required", schedule,
        candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    const readyTrainer = trainer
    if (prepared.fixturePackSha256 !== campaignSchedule.fixturePackSha256 ||
        prepared.protocolSha256 !== dataset.protocolSha256 ||
        prepared.baselineSkillSha256 !== current.baselineSkillSha256 ||
        sha256(Buffer.from(input.originalSkill, "utf8")) !== prepared.baselineSkillSha256 ||
        Buffer.byteLength(input.originalSkill, "utf8") > PILOT_LIMITS.skillBytes) fail("campaign_binding_drift", "BLOCKED")
    const originalSkill = assembleSkill(input.originalSkill, "")
    const projection = trainerSafeProjection(dataset)
    const sourceHash = sourceLockSha256()
    const manifest = buildNativeAdapterManifest({
      fixturePack: dataset.fixturePack, runId: prepared.runId,
      originalSkillSha256: sha256(originalSkill), sourceLockSha256: sourceHash,
    })
    const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8")
    assertWorkerReady(trainer.profile, trainer.receipt)
    checkDirectory(trainer.outputDirectory, trainer.profile.binding.filesystem.output.dev)
    if (trainer.profile.binding.inputSha256 !== sha256(Buffer.from(canonicalJson(projection), "utf8")) ||
        trainer.profile.binding.adapterManifestSha256 !== sha256(manifestBytes) ||
        trainer.profile.binding.nativeRuntimeProofSha256.length !== 64 || !HASH.test(trainer.profile.binding.nativeRuntimeProofSha256)) {
      fail("trainer_profile_binding_mismatch", "BLOCKED")
    }
    if (!/^[a-f0-9-]{36}$/iu.test(prepared.runId)) fail("campaign_run_id_invalid", "BLOCKED")
    const promptBases = new Map<string, TargetPromptBase>()
    for (const fixture of dataset.fixturePack.fixtures) {
      if (validateNativeFixtureGold(fixture).status !== "READY") fail("fixture_gold_inconclusive", "DATA_REQUIRED")
      preflightFixturePrompt(input, controller, prepared, campaignSchedule, fixture, originalSkill, fixtureWriteTimestamp, promptBases)
    }
    if (nowAborted(input.signal)) fail("cancelled", "CANCELLED")
    const trainingFixtures = new Map(dataset.fixturePack.fixtures.filter(fixture => fixture.split === "train").map(fixture => [fixture.id, fixture]))
    const warmupItems = campaignSchedule.training.slice(0, 2)
    if (warmupItems.length !== 2) fail("campaign_warmup_schedule_invalid", "BLOCKED")
    const firstItem = warmupItems[0]
    if (!firstItem) fail("campaign_warmup_schedule_invalid", "BLOCKED")
    const firstFixture = trainingFixtures.get(firstItem.caseId)
    if (!firstFixture) fail("campaign_training_case_missing", "BLOCKED")
    runStarted = performance.now()
    const beforeStatus = controller.status()
    activeBefore = Math.max(0, NATIVE_SKILLOPT_LIMITS.activeMilliseconds - beforeStatus.remaining.activeMilliseconds)
    const firstScheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry = {
      kind: "training", caseId: firstItem.caseId, replicate: firstItem.replicate,
    }
    const firstTargetPlan = prepareCampaignTargetPlan(controller, input, prepared, firstScheduleEntry)
    const firstPrompt = targetPrompt(firstFixture, originalSkill, promptBases)
    const firstWorkerContext = await prepareFixtureWorkerForTarget(input, controller, prepared, campaignSchedule,
      firstScheduleEntry, firstTargetPlan, firstFixture, trainer, firstPrompt, fixtureWriteTimestamp, input.signal)
    let firstReservation: SkillOptReservation
    let firstTargetBinding: SkillOptNativeCampaignTargetBinding | undefined
    try {
      firstReservation = input.arm
        ? controller.reserveAutomatic({ owner: input.owner, prepared, consent, arm: input.arm, current: input.getCurrent() })
        : controller.reserveManual({ owner: input.owner, prepared, consent, current: input.getCurrent() })
      firstReservationIssued = true
      assertCampaignReservation(controller, input, prepared.runId, campaignSchedule, firstReservation, "target", "train")
      firstTargetBinding = bindCampaignTargetReservation(controller, input, prepared, firstTargetPlan, firstReservation)
    } catch (error) {
      try { cleanupFixtureContext(firstWorkerContext) } catch { fail("fixture_scratch_changed", "UNRESOLVED") }
      if (error instanceof SkillOptControllerError) {
        throw new CampaignFailure(error.code, error.code === "digest-threshold" ? "BLOCKED" : "FAILED")
      }
      throw error
    }
    if (!firstTargetBinding) fail("campaign_target_reservation_binding_denied", "BLOCKED")
    if (nowAborted(input.signal)) {
      let scratchChanged = false
      try { cleanupFixtureContext(firstWorkerContext) } catch { scratchChanged = true }
      settleUndispatched(controller, input.owner, firstReservation, input.getCurrent)
      if (scratchChanged) fail("fixture_scratch_changed", "UNRESOLVED")
      fail("cancelled", "CANCELLED")
    }
    try {
      trainerCapture = controller.openNativeTrainerProtocolCapture({ owner: input.owner, runtime: input.runtime, prepared,
        current: input.getCurrent(), trainer: { profile: trainer.profile, receipt: trainer.receipt } })
    } catch {
      try { cleanupFixtureContext(firstWorkerContext) } catch { fail("fixture_scratch_changed", "UNRESOLVED") }
      settleUndispatched(controller, input.owner, firstReservation, input.getCurrent)
      fail("trainer_protocol_capture_unavailable", "BLOCKED")
    }
    let launchedTrainerWorker: OwnedWorkerHandle
    try { launchedTrainerWorker = launchOwnedWorker(trainer.profile, trainer.receipt, "trainer-native") }
    catch (error) {
      let scratchChanged = false
      try { cleanupFixtureContext(firstWorkerContext) } catch { scratchChanged = true }
      settleUndispatched(controller, input.owner, firstReservation, input.getCurrent)
      if (scratchChanged) fail("fixture_scratch_changed", "UNRESOLVED")
      if (error instanceof SkillOptError) fail(error.code, "BLOCKED")
      fail("trainer_worker_start_failed", "BLOCKED")
    }
    trainerWorker = launchedTrainerWorker
    const workerDone = launchedTrainerWorker.wait()
    const queue = createWorkerMessageQueue<OwnedTrainerProtocolEvent>()
    detachTrainerProtocolEvent = launchedTrainerWorker.onTrainerProtocolEvent(event => queue.push(event))
    const cancelForAbort = () => {
      queue.fail(new CampaignFailure("cancelled", "CANCELLED"))
      void cancelTrainerWorker()
    }
    abortWorker = cancelForAbort
    input.signal?.addEventListener("abort", cancelForAbort, { once: true })
    if (nowAborted(input.signal)) cancelForAbort()

    for (let index = 0; index < 2; index += 1) {
      const item = warmupItems[index]
      if (!item) fail("campaign_warmup_schedule_invalid", "BLOCKED")
      const fixture = trainingFixtures.get(item.caseId)
      if (!fixture) fail("campaign_training_case_missing", "BLOCKED")
      const observationStartedAt = index === 0 ? runStarted : performance.now()
      const prompt = index === 0 ? firstPrompt : targetPrompt(fixture, originalSkill, promptBases)
      const scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry = {
        kind: "training", caseId: item.caseId, replicate: item.replicate,
      }
      const targetPlan = index === 0 ? firstTargetPlan : prepareCampaignTargetPlan(controller, input, prepared, scheduleEntry)
      const workerContext = index === 0 ? firstWorkerContext : await prepareFixtureWorkerForTarget(input, controller, prepared,
        campaignSchedule, scheduleEntry, targetPlan, fixture, trainer, prompt, fixtureWriteTimestamp, input.signal)
      try {
        const reservation = index === 0 ? firstReservation : controller.reserveRequest({
          owner: input.owner, runId: prepared.runId, current: input.getCurrent(), role: "target", phase: "train",
        })
        assertCampaignReservation(controller, input, prepared.runId, campaignSchedule, reservation, "target", "train")
        const targetBinding = index === 0 ? firstTargetBinding :
          bindCampaignTargetReservation(controller, input, prepared, targetPlan, reservation)
        if (!targetBinding) fail("campaign_target_reservation_binding_denied", "BLOCKED")
        const observation = await evaluateTarget(input, controller, prepared, prepared.runId, campaignSchedule.scheduleSha256, scheduleEntry,
          fixture, "baseline", item.replicate, "train", prompt, fixtureWriteTimestamp, workerContext, observationStartedAt, reservation,
          targetBinding, usageObservations, sha256(""))
        warmups.set(item.caseId, { observation, reservation, consumed: false })
      } catch (error) {
        if (!workerContext.cleaned) {
          try { cleanupFixtureContext(workerContext) } catch { /* Preserve uncertain or unresolved scratch. */ }
        }
        throw error
      }
    }
    if (warmups.size !== 2 || new Set(warmupItems.map(item => item.caseId)).size !== 2) fail("campaign_warmup_replay_invalid", "FAILED")
    const secondItem = warmupItems[1]
    if (!secondItem) fail("campaign_warmup_schedule_invalid", "BLOCKED")
    const firstWarmup = warmups.get(firstItem.caseId)
    const secondWarmup = warmups.get(secondItem.caseId)
    if (!firstWarmup || !secondWarmup) fail("campaign_warmup_replay_invalid", "FAILED")
    const elapsed = activeBefore + (performance.now() - runStarted)
    const statusAfterWarmup: SkillOptControllerStatus = controller.status()
    forecast = forecastNativeCampaign({
      fixturePack: dataset.fixturePack,
      trainingMilliseconds: [
        firstWarmup.observation.endToEndMilliseconds,
        secondWarmup.observation.endToEndMilliseconds,
      ],
      elapsedMilliseconds: Math.max(elapsed, NATIVE_SKILLOPT_LIMITS.activeMilliseconds - statusAfterWarmup.remaining.activeMilliseconds),
    })
    if (forecast.status !== "WITHIN_ESTIMATE") fail("campaign_budget_forecast_refused", "INCONCLUSIVE")

    let candidateStepReserved = false
    let rolloutCount = 0
    let optimizerRequestCount = 0
    let trainerEventOrdinal = 0
    async function handleTrainerProtocolEvent(hostEvent: OwnedTrainerProtocolEvent): Promise<void> {
      queue.assertHealthy()
      if (nowAborted(input.signal)) fail("cancelled", "CANCELLED")
      if (!trainerCapture) fail("trainer_protocol_capture_unavailable", "BLOCKED")
      let trainerEvent: SkillOptNativeTrainerProtocolEvent
      let description: SkillOptNativeTrainerProtocolEventDescription
      const expectedOrdinal = trainerEventOrdinal + 1
      try {
        trainerEvent = controller.consumeNativeTrainerProtocolEvent(trainerCapture, {
          owner: input.owner, runtime: input.runtime, prepared, current: input.getCurrent(), event: hostEvent,
        })
        description = controller.describeNativeTrainerProtocolEvent(trainerEvent)
        trainerEventOrdinal = description.ordinal
      } catch (error) {
        fail("trainer_protocol_event_invalid", "FAILED", {
          stage: "trainer-protocol-event", ordinal: expectedOrdinal,
          ...(error instanceof SkillOptControllerError ? { code: error.code } : {}),
        })
      }
      if (description.kind === "optimizer") {
        if (!candidateStepReserved) {
          controller.reserveCandidateStep(input.owner, prepared.runId)
          candidateStepReserved = true
        }
        optimizerRequestCount += 1
        const reservation = controller.reserveRequest({ owner: input.owner, runId: prepared.runId,
          current: input.getCurrent(), role: "optimizer", phase: "train", trainerEvent })
        assertCampaignReservation(controller, input, prepared.runId, campaignSchedule, reservation, "optimizer", "train")
        const result = await input.broker.dispatch({
          owner: input.owner, reservation, getCurrent: input.getCurrent, role: "optimizer", phase: "train", prompt: description.prompt,
          ...(input.signal ? { signal: input.signal } : {}),
        })
        if (result.status !== "completed" || typeof result.text !== "string") {
          recordUsageObservation(usageObservations, result.requestId, "optimizer", result.usage)
          if (result.usage !== null) {
            controller.recordArtifactBytes(input.owner, prepared.runId, usageArtifactBytes(result.usage))
          }
          if (result.status === "unresolved") fail(result.errorCode ?? "execution_unresolved", "UNRESOLVED")
          if (result.status === "cancelled") fail(result.errorCode ?? "cancelled", "CANCELLED")
          fail(result.errorCode ?? "native_execution_failed", "FAILED")
        }
        if (!result.optimizerWitness) fail("optimizer_response_witness_missing", "FAILED")
        let optimizerResponseAllowance: ReturnType<SkillOptController["reserveNativeTrainerOptimizerResponse"]>
        try {
          optimizerResponseAllowance = controller.reserveNativeTrainerOptimizerResponse({
            owner: input.owner, runtime: input.runtime, prepared, current: input.getCurrent(), event: trainerEvent,
            reservation, optimizerWitness: result.optimizerWitness, responseText: result.text,
          })
        } catch (error) {
          if (error instanceof SkillOptControllerError) fail(error.code, "FAILED")
          fail("optimizer_response_admission_denied", "FAILED")
        }
        let optimizerResponse: ReturnType<SkillOptController["consumeNativeTrainerOptimizerResponse"]>
        try {
          optimizerResponse = controller.consumeNativeTrainerOptimizerResponse(optimizerResponseAllowance, {
            owner: input.owner, runtime: input.runtime, prepared, current: input.getCurrent(), event: trainerEvent, reservation,
          })
        } catch (error) {
          if (error instanceof SkillOptControllerError) fail(error.code, "UNRESOLVED")
          fail("optimizer_response_consumption_failed", "UNRESOLVED")
        }
        recordUsageObservation(usageObservations, result.requestId, "optimizer", optimizerResponse.usage)
        queue.assertHealthy()
        await launchedTrainerWorker.writeMessage(optimizerResponse)
        return
      }

      rolloutCount += 1
      const fixture = dataset.fixturePack.fixtures.find(item => item.id === description.caseId)
      if (!fixture) fail("trainer_case_outside_pack", "FAILED")
      const isTraining = description.cohort === "training"
      const scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry = isTraining
        ? { kind: "training", caseId: description.caseId, replicate: description.replicate }
        : { kind: "trainerSelection", caseId: description.caseId, replicate: description.replicate }
      const warmup = isTraining && description.fragment === "" ? warmups.get(description.caseId) : undefined
      let observation: TargetObservation
      let reservation: SkillOptReservation
      if (warmup) {
        const observed = warmup.observation
        if (warmup.consumed || description.split !== "train" || observed.scheduleSha256 !== campaignSchedule.scheduleSha256 ||
            observed.split !== "train" || observed.caseId !== description.caseId || observed.replicate !== description.replicate ||
            observed.fragmentSha256 !== description.fragmentSha256 || description.fragmentSha256 !== sha256("") ||
            correlatedWireRequestIds.has(description.wireRequestId) || correlatedNativeRequestIds.has(observed.requestId)) {
          fail("campaign_warmup_replay_invalid", "FAILED")
        }
        warmup.consumed = true
        correlatedWireRequestIds.add(description.wireRequestId)
        correlatedNativeRequestIds.add(observed.requestId)
        warmupCorrelations.push(Object.freeze({
          scheduleSha256: campaignSchedule.scheduleSha256,
          wireRequestId: description.wireRequestId,
          nativeRequestId: observed.requestId,
          split: "train",
          caseId: description.caseId,
          replicate: description.replicate,
          fragmentSha256: description.fragmentSha256,
        }))
        observation = warmup.observation
        reservation = warmup.reservation
        try { controller.associateNativeTrainerWarmupTarget({ owner: input.owner, runtime: input.runtime,
          prepared, current: input.getCurrent(), event: trainerEvent, target: observation.targetResponse }) }
        catch { fail("campaign_warmup_replay_invalid", "FAILED") }
      } else {
        const targetPhase = isTraining ? "train" : "dev"
        const variant = description.cohort === "candidate-selection" ? "candidate" : "baseline"
        const observationStartedAt = performance.now()
        const skill = variant === "candidate" ? assembleSkill(originalSkill, description.fragment) : originalSkill
        const prompt = targetPrompt(fixture, skill, promptBases)
        const targetPlan = prepareCampaignTargetPlan(controller, input, prepared, scheduleEntry, trainerEvent)
        const workerContext = await prepareFixtureWorkerForTarget(input, controller, prepared, campaignSchedule,
          scheduleEntry, targetPlan, fixture, readyTrainer, prompt, fixtureWriteTimestamp, input.signal, trainerEvent)
        try {
          reservation = isTraining
            ? controller.reserveRequest({ owner: input.owner, runId: prepared.runId, current: input.getCurrent(),
              role: "target", phase: "train", trainerEvent })
            : controller.reserveNativeTrainerSelectionTarget({ owner: input.owner, runtime: input.runtime,
              prepared, current: input.getCurrent(), event: trainerEvent })
          assertCampaignReservation(controller, input, prepared.runId, campaignSchedule, reservation, "target", targetPhase)
          const targetBinding = bindCampaignTargetReservation(controller, input, prepared, targetPlan, reservation)
          observation = await evaluateTarget(input, controller, prepared, prepared.runId, campaignSchedule.scheduleSha256, scheduleEntry,
            fixture, variant, description.replicate, targetPhase, prompt, fixtureWriteTimestamp, workerContext,
            observationStartedAt, reservation, targetBinding, usageObservations, description.fragmentSha256, trainerEvent)
        } catch (error) {
          if (!workerContext.cleaned) {
            try { cleanupFixtureContext(workerContext) } catch { /* Preserve a changed directory. */ }
          }
          throw error
        }
      }
      queue.assertHealthy()
      if (observation.trial.status !== "valid") fail("trainer_evaluation_invalid", "FAILED")
      await writeTrainerRolloutResponse(input, controller, prepared, campaignSchedule, scheduleEntry,
        fixture, observation, trainerEvent, description, reservation, launchedTrainerWorker)
    }

    let trainerResult: OwnedWorkerResult | undefined
    for (;;) {
      const next = await Promise.race([
        queue.next().then(message => ({ kind: "message" as const, message })),
        workerDone.then(result => ({ kind: "done" as const, result })),
      ])
      if (next.kind === "done") {
        trainerResult = next.result
        queue.close()
        queue.assertHealthy()
        if (queue.hasPending()) fail("trainer_ipc_after_completion", "FAILED")
        break
      }
      await handleTrainerProtocolEvent(next.message)
      if (rolloutCount === 120) launchedTrainerWorker.closeInput()
    }
    queue.assertHealthy()
    if (warmupCorrelations.length !== warmups.size || correlatedWireRequestIds.size !== warmups.size ||
        correlatedNativeRequestIds.size !== warmups.size) fail("campaign_warmup_correlation_incomplete", "FAILED")
    if (abortWorker) input.signal?.removeEventListener("abort", abortWorker)
    detachTrainerProtocolEvent?.()
    detachTrainerProtocolEvent = undefined
    const completedTrainer = trainerResult
    if (!completedTrainer || !workerSuccess(completedTrainer)) {
      if (completedTrainer && !completedTrainer.quiescent) fail(completedTrainer.errorCode ?? "trainer_worker_unresolved", "UNRESOLVED")
      fail(completedTrainer?.errorCode ?? "trainer_worker_failed", "FAILED")
    }
    if (!trainerCapture) fail("trainer_protocol_capture_unavailable", "BLOCKED")
    let complete: Readonly<{ fragment: string; candidateSha256: string }>
    try {
      complete = controller.completeNativeTrainerProtocolCapture(trainerCapture, {
        owner: input.owner, runtime: input.runtime, prepared, current: input.getCurrent(), result: completedTrainer,
      })
    } catch { fail("trainer_protocol_capture_incomplete", "FAILED") }
    const resultBytes = readStableWorkerArtifact(trainer.outputDirectory, TRAINER_RESULT_NAME, TRAINER_RESULT_BYTES, trainer.profile)
    const manifestSha256 = sha256(manifestBytes)
    const validatedCandidate = validateTrainerArtifact({
      bytes: resultBytes, manifestSha256, sourceLockSha256: sourceHash, runId: prepared.runId,
      originalSkill, originalSkillSha256: sha256(originalSkill), wireFragment: complete.fragment,
      candidateSha256: complete.candidateSha256, expectedOptimizerRequests: optimizerRequestCount,
      nativeRuntimeProofSha256: trainer.profile.binding.nativeRuntimeProofSha256,
    })
    try { markNativeSkillOptTrainerClosed(trainer, completedTrainer) }
    catch { fail("trainer_worker_closure_unresolved", "UNRESOLVED") }
    // The trainer result is precharged; the assembled candidate here is memory-only.
    if (validatedCandidate.status === "no_improvement") {
      finalizeController(controller, input.owner, prepared.runId, "NO_GAIN")
      return resultWithUsage({ status: "NO_GAIN", reasonCode: "trainer_no_improvement", schedule, forecast,
        reviewerEvidence, candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    const campaignCandidate = Object.freeze({ skill: validatedCandidate.candidateSkill, fragment: validatedCandidate.fragment, sha256: validatedCandidate.candidateSha256 })
    candidate = campaignCandidate

    const fixtureMap = new Map(dataset.fixturePack.fixtures.map(item => [item.id, item]))
    for (const scheduled of campaignSchedule.qualification) {
      if (nowAborted(input.signal)) fail("cancelled", "CANCELLED")
      const fixture = fixtureMap.get(scheduled.fixtureId)
      if (!fixture) fail("campaign_qualification_case_missing", "FAILED")
      const skill = scheduled.variant === "baseline" ? originalSkill : campaignCandidate.skill
      const observationStartedAt = performance.now()
      const scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry = {
        kind: "qualification", fixtureId: scheduled.fixtureId, split: scheduled.split,
        variant: scheduled.variant, repeat: scheduled.repeat,
      }
      const prompt = targetPrompt(fixture, skill, promptBases)
      const targetPlan = prepareCampaignTargetPlan(controller, input, prepared, scheduleEntry)
      const workerContext = await prepareFixtureWorkerForTarget(input, controller, prepared, campaignSchedule,
        scheduleEntry, targetPlan, fixture, trainer, prompt, fixtureWriteTimestamp, input.signal)
      let reservation: SkillOptReservation | undefined
      try {
        reservation = controller.reserveRequest({ owner: input.owner, runId: prepared.runId,
          current: input.getCurrent(), role: "target", phase: scheduled.split })
        assertCampaignReservation(controller, input, prepared.runId, campaignSchedule, reservation, "target", scheduled.split)
        const targetBinding = bindCampaignTargetReservation(controller, input, prepared, targetPlan, reservation)
        const observation = await evaluateTarget(input, controller, prepared, prepared.runId, campaignSchedule.scheduleSha256, scheduleEntry,
          fixture, scheduled.variant, scheduled.repeat, scheduled.split, prompt, fixtureWriteTimestamp, workerContext, observationStartedAt,
          reservation, targetBinding, usageObservations,
          scheduled.variant === "candidate" ? sha256(campaignCandidate.fragment) : sha256(""))
        qualificationTrials.push(observation.trial)
      } catch (error) {
        if (!workerContext.cleaned) {
          try { cleanupFixtureContext(workerContext) } catch { /* Unresolved profile directories remain for recovery. */ }
        }
        if (reservation) {
          const latency = Math.max(1, performance.now() - runStarted)
          qualificationTrials.push(invalidTrial(fixture.id, scheduled.variant, scheduled.repeat, latency, trialFailureFor(error)))
          metrics = measureNativeQualification({ fixturePack: dataset.fixturePack, baselineSha256: sha256(originalSkill),
            candidateSha256: campaignCandidate.sha256, trials: qualificationTrials })
        }
        throw error
      }
    }
    const qualificationMetrics = measureNativeQualification({ fixturePack: dataset.fixturePack, baselineSha256: sha256(originalSkill),
      candidateSha256: campaignCandidate.sha256, trials: qualificationTrials })
    metrics = qualificationMetrics
    if (qualificationMetrics.observedTrials !== campaignSchedule.qualification.length ||
        qualificationMetrics.requiredTrials !== campaignSchedule.qualification.length) {
      fail("campaign_qualification_incomplete", "INCONCLUSIVE")
    }
    const reviewerPhases = ["final", "safety"] as const
    for (const phase of reviewerPhases) {
      if (nowAborted(input.signal)) fail("cancelled", "CANCELLED")
      const prompt = buildReviewerEvidencePrompt(campaignCandidate.fragment, campaignCandidate.sha256, qualificationMetrics, phase)
      const promptSha256 = sha256(Buffer.from(prompt, "utf8"))
      const semanticReview: NativeSemanticReviewBinding = { schema: "skillopt.native-semantic-review.v1", subjectSha256: campaignCandidate.sha256, promptSha256 }
      const reservation = controller.reserveRequest({ owner: input.owner, runId: prepared.runId, current: input.getCurrent(), role: "reviewer", phase })
      assertCampaignReservation(controller, input, prepared.runId, campaignSchedule, reservation, "reviewer", phase)
      const result = await input.broker.dispatch({ owner: input.owner, reservation, getCurrent: input.getCurrent,
        role: "reviewer", phase, prompt, semanticReview, ...(input.signal ? { signal: input.signal } : {}) })
      recordUsageObservation(usageObservations, result.requestId, "reviewer", result.usage)
      if (result.status !== "completed" || typeof result.text !== "string") {
        if (result.status === "unresolved") fail(result.errorCode ?? "execution_unresolved", "UNRESOLVED")
        if (result.status === "cancelled") fail(result.errorCode ?? "cancelled", "CANCELLED")
        reviewerEvidence.push(Object.freeze({ phase, status: "failed", promptSha256, responseSha256: null,
          assessment: null, findings: Object.freeze([]), errorCode: result.errorCode ?? result.status }))
        break
      }
      reviewerEvidence.push(parseReviewerEvidence(phase, promptSha256, result.text))
    }
    if (qualificationMetrics.status === "NO_GAIN") {
      finalizeController(controller, input.owner, prepared.runId, "NO_GAIN")
      return resultWithUsage({ status: "NO_GAIN", schedule, forecast, candidate, metrics, reviewerEvidence,
        candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    if (qualificationMetrics.status === "REJECTED") {
      finalizeController(controller, input.owner, prepared.runId, "FAILED")
      return resultWithUsage({ status: "REJECTED", schedule, forecast, candidate, metrics, reviewerEvidence,
        candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    if (qualificationMetrics.status !== "METRICS_PASSED" || reviewerEvidence.length !== 2 ||
        reviewerEvidence.some(item => item.status !== "valid" || item.assessment !== "clear" || item.findings.length !== 0)) {
      finalizeController(controller, input.owner, prepared.runId, "INCONCLUSIVE")
      return resultWithUsage({ status: "INCONCLUSIVE", reasonCode: "qualification_or_review_incomplete", schedule, forecast,
        candidate, metrics, reviewerEvidence, candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    const qualification = Object.freeze({}) as NativeCampaignQualification
    qualifications.set(qualification, Object.freeze({
      runId: prepared.runId,
      bindingSha256: prepared.bindingSha256,
      scheduleSha256: campaignSchedule.scheduleSha256,
      candidateSha256: campaignCandidate.sha256,
      resultsSha256: sha256(canonicalJson(qualificationMetrics)),
      reviewSha256: sha256(canonicalJson(reviewerEvidence)),
    }))
    let heldStatus: SkillOptControllerStatus
    try { heldStatus = controller.awaitCandidateApproval(input.owner, prepared.runId, input.getCurrent(), qualification) }
    catch {
      return resultWithUsage({ status: "UNRESOLVED", reasonCode: "candidate_approval_hold_unresolved", schedule, forecast,
        candidate, metrics, reviewerEvidence, candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    finally { qualifications.delete(qualification) }
    if (heldStatus.state !== "AWAITING_CANDIDATE_APPROVAL" || heldStatus.runId !== prepared.runId || heldStatus.pendingDispatch) {
      return resultWithUsage({ status: "UNRESOLVED", reasonCode: "candidate_approval_hold_unresolved", schedule, forecast,
        candidate, metrics, reviewerEvidence, candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    return resultWithUsage({ status: "AWAITING_CANDIDATE_APPROVAL", schedule, forecast, candidate, metrics, reviewerEvidence,
      candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
  } catch (error) {
    detachTrainerProtocolEvent?.()
    if (abortWorker) input.signal?.removeEventListener("abort", abortWorker)
    if (trainerWorker) {
      const result = await cancelTrainerWorker()
      if (!result?.quiescent) {
        return resultWithUsage({ status: "UNRESOLVED", reasonCode: "trainer_worker_unresolved", ...(schedule ? { schedule } : {}),
          ...(forecast ? { forecast } : {}), ...(candidate ? { candidate } : {}), ...(metrics ? { metrics } : {}),
          reviewerEvidence, candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
      }
    }
    let failure: CampaignFailure
    if (error instanceof CampaignFailure) failure = error
    else if (error instanceof SkillOptError) failure = new CampaignFailure(error.code, "FAILED")
    else {
      const classified = classifyNativeCampaignRequestFailure(error, "native_campaign_failed")
      failure = new CampaignFailure(classified.reasonCode, classified.status)
    }
    if (input.arm && !firstReservationIssued) {
      let currentStatus: SkillOptControllerStatus
      try { currentStatus = controllerForCleanup?.status() ?? fail("automatic_reservation_state_unavailable", "UNRESOLVED") }
      catch {
        return resultWithUsage({ status: "UNRESOLVED", reasonCode: "automatic_reservation_state_unavailable",
          ...(schedule ? { schedule } : {}), ...(forecast ? { forecast } : {}), reviewerEvidence,
          candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
      }
      const counts = currentStatus.requestCounts
      const reservationEvidence = currentStatus.runId !== runId || currentStatus.pendingDispatch ||
        currentStatus.state === "RESERVED" || currentStatus.state === "RUNNING" || currentStatus.state === "UNRESOLVED" ||
        currentStatus.state === "DISPATCH_PENDING" || Object.values(counts.charged).some(count => count > 0) ||
        Object.values(counts.dispatched).some(count => count > 0) || Object.values(counts.unknown).some(count => count > 0)
      if (reservationEvidence) {
        return resultWithUsage({ status: "UNRESOLVED", reasonCode: "automatic_reservation_state_unresolved",
          ...(schedule ? { schedule } : {}), ...(forecast ? { forecast } : {}), reviewerEvidence,
          candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
      }
      // An automatic eligibility refusal is a read-only probe outcome. Keep the genuine arm and its quota state
      // intact; only reserveAutomatic may consume it, and no campaign failure is persisted before that commit.
      const status: NativeCampaignStatus = failure.status === "FAILED" ? "BLOCKED" : failure.status
      return resultWithUsage({ status, reasonCode: failure.code, ...(schedule ? { schedule } : {}),
        ...(forecast ? { forecast } : {}), ...(candidate ? { candidate } : {}), ...(metrics ? { metrics } : {}),
        ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
        reviewerEvidence, candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    if (failure.status === "CANCELLED" && !firstReservationIssued) {
      if (runId && controllerForCleanup) return cancelUnstarted(controllerForCleanup, runId)
      return resultWithUsage({ status: "UNRESOLVED", reasonCode: "campaign_unstarted_cancel_unresolved",
        ...(schedule ? { schedule } : {}), ...(forecast ? { forecast } : {}),
        ...(candidate ? { candidate } : {}), ...(metrics ? { metrics } : {}), reviewerEvidence,
        candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    if (!firstReservationIssued && failure.code === "campaign_artifact_stage_denied") {
      return resultWithUsage({ status: "BLOCKED", reasonCode: failure.code, ...(schedule ? { schedule } : {}),
        ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
        candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    if (runId && controllerForCleanup && failure.status !== "UNRESOLVED") {
      const state = failure.status === "CANCELLED" ? "CANCELLED"
        : failure.status === "INCONCLUSIVE" || failure.status === "DATA_REQUIRED" ? "INCONCLUSIVE" : "FAILED"
      try { finalizeController(controllerForCleanup, input.owner, runId, state) } catch { /* Controller retains its durable recovery state. */ }
    }
    if (failure.status === "UNRESOLVED") {
      return resultWithUsage({ status: "UNRESOLVED", reasonCode: failure.code, ...(schedule ? { schedule } : {}),
        ...(forecast ? { forecast } : {}), ...(candidate ? { candidate } : {}), ...(metrics ? { metrics } : {}),
        ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
        reviewerEvidence, candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
    }
    return resultWithUsage({ status: failure.status, reasonCode: failure.code, ...(schedule ? { schedule } : {}),
      ...(forecast ? { forecast } : {}), ...(candidate ? { candidate } : {}), ...(metrics ? { metrics } : {}),
      ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
      reviewerEvidence, candidateApprovalRequired: true, providerTokenMaximumEnforced: false })
  } finally { if (trainerWorker && detachTrainerProtocolEvent) detachTrainerProtocolEvent() }
}
