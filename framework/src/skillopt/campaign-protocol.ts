import {
  NATIVE_WIKI_SPLIT_MINIMUMS,
  NATIVE_DATASET_LIMITS,
  validateNativeFixturePack,
  type NativeWikiFixturePack,
} from "./dataset.ts"
import { NATIVE_EVALUATION_PROTOCOL, NATIVE_EVALUATION_PROTOCOL_SHA256, type NativeEvaluationVariant } from "./evaluation.ts"
import { assembleSkill, canonicalJson, NATIVE_SKILLOPT_LIMITS, sha256, SkillOptError } from "./pilot.ts"
import { containsSecret } from "../security/secrets.ts"

const SCHEMA = "skillopt.native-campaign-schedule.v1" as const
const SEED = 0x20261003
const QUALIFICATION_SPLITS = ["dev", "final", "safety"] as const
const RUN_ID = /^[A-Za-z0-9_-]{1,96}$/u
const HASH = /^[a-f0-9]{64}$/u
const nativeCampaignSchedules = new WeakMap<object, NativeCampaignSchedule>()

export type NativeCampaignCase = Readonly<{ caseId: string; replicate: number }>
export type NativeCampaignTrial = Readonly<{
  fixtureId: string
  split: (typeof QUALIFICATION_SPLITS)[number]
  variant: NativeEvaluationVariant
  repeat: number
}>
export type NativeCampaignSchedule = Readonly<{
  schema: typeof SCHEMA
  fixturePackSha256: string
  evaluationProtocolSha256: string
  seed: number
  training: readonly NativeCampaignCase[]
  trainerSelection: readonly NativeCampaignCase[]
  qualification: readonly NativeCampaignTrial[]
  targetRequests: number
  trainerSelectionRequests: number
  canaryReserve: number
  scheduleSha256: string
}>

function refuse(code: string): never { throw new SkillOptError(code) }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

/** Data only: this schedule grants neither consent nor a dispatch ticket. */
export function buildNativeCampaignSchedule(input: NativeWikiFixturePack): NativeCampaignSchedule {
  const validation = validateNativeFixturePack(input)
  if (validation.status !== "STRUCTURALLY_VALID") refuse("campaign_data_required")
  for (const split of ["train", ...QUALIFICATION_SPLITS] as const) {
    if (validation.coverage[split].count !== NATIVE_WIKI_SPLIT_MINIMUMS[split]) refuse("campaign_fixture_count")
  }
  const fixtures = [...validation.pack.fixtures].sort((left, right) => compare(left.id, right.id))
  const training = Object.freeze(fixtures.filter(fixture => fixture.split === "train")
    .map(fixture => Object.freeze({ caseId: fixture.id, replicate: 0 })))
  const trainerSelection = Object.freeze(fixtures.filter(fixture => fixture.split === "dev")
    .flatMap(fixture => Array.from({ length: NATIVE_EVALUATION_PROTOCOL.repeats }, (_, replicate) =>
      Object.freeze({ caseId: fixture.id, replicate }))))
  let randomState = SEED
  const random = (): number => {
    randomState ^= randomState << 13
    randomState ^= randomState >>> 17
    randomState ^= randomState << 5
    return (randomState >>> 0) / 0x1_0000_0000
  }
  const qualification: NativeCampaignTrial[] = []
  for (const split of QUALIFICATION_SPLITS) {
    const pairs = fixtures.filter(fixture => fixture.split === split)
      .flatMap(fixture => Array.from({ length: NATIVE_EVALUATION_PROTOCOL.repeats }, (_, repeat) => ({ fixtureId: fixture.id, repeat })))
    for (let index = pairs.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1))
      ;[pairs[index], pairs[other]] = [pairs[other]!, pairs[index]!]
    }
    // Each split has equal AB and BA counts; each adjacent pair uses the same case and replicate.
    const offset = random() < 0.5 ? 0 : 1
    for (const [index, pair] of pairs.entries()) {
      const variants: readonly NativeEvaluationVariant[] = (index + offset) % 2 === 0
        ? ["baseline", "candidate"] : ["candidate", "baseline"]
      for (const variant of variants) qualification.push(Object.freeze({ ...pair, split, variant }))
    }
  }
  // Pinned ReflACT requires its own baseline/candidate selection calls before fresh paired qualification.
  // These 96 calls remain charged, but are never reused as counterbalanced qualification observations.
  const trainerSelectionRequests = trainerSelection.length * 2
  const targetRequests = training.length + trainerSelectionRequests + qualification.length
  const canaryReserve = 16
  if (targetRequests + canaryReserve > NATIVE_SKILLOPT_LIMITS.targetRequests) refuse("campaign_budget_exhausted")
  const basis = {
    schema: SCHEMA,
    fixturePackSha256: validation.packSha256,
    evaluationProtocolSha256: NATIVE_EVALUATION_PROTOCOL_SHA256,
    seed: SEED,
    training,
    trainerSelection,
    qualification: Object.freeze(qualification),
    targetRequests,
    trainerSelectionRequests,
    canaryReserve,
  }
  const schedule: NativeCampaignSchedule = Object.freeze({ ...basis, scheduleSha256: sha256(canonicalJson(basis)) })
  nativeCampaignSchedules.set(schedule, schedule)
  return schedule
}

type NativeAdapterManifestBinding = Readonly<{
  runId: string
  originalSkillSha256: string
  sourceLockSha256: string
}>

function nativeAdapterManifestBinding(input: NativeAdapterManifestBinding): NativeAdapterManifestBinding {
  if (!RUN_ID.test(input.runId) || !HASH.test(input.originalSkillSha256) || !HASH.test(input.sourceLockSha256)) {
    refuse("campaign_manifest_invalid")
  }
  return input
}

function adapterManifestForSchedule(schedule: NativeCampaignSchedule, binding: NativeAdapterManifestBinding) {
  return Object.freeze({
    schema: "skillopt.adapter-manifest.v1" as const,
    runId: binding.runId,
    mode: "experiment" as const,
    originalSkillSha256: binding.originalSkillSha256,
    sourceLockSha256: binding.sourceLockSha256,
    train: schedule.training,
    selection: schedule.trainerSelection,
  })
}

/** The trainer receives only approved train/dev identifiers, never final/safety identifiers or gold. */
export function buildNativeAdapterManifest(input: Readonly<{
  fixturePack: NativeWikiFixturePack
  runId: string
  originalSkillSha256: string
  sourceLockSha256: string
}>) {
  const binding = nativeAdapterManifestBinding(input)
  const schedule = buildNativeCampaignSchedule(input.fixturePack)
  return adapterManifestForSchedule(schedule, binding)
}

export type NativeCampaignForecast = Readonly<{
  status: "WITHIN_ESTIMATE" | "BUDGET_FORECAST_REFUSED"
  scheduleSha256: string
  observedTrainingRequests: 2
  targetRequests: number
  conservativeTargetMilliseconds: number
  remainingEstimateMilliseconds: number
  remainingActiveMilliseconds: number
  /** Service latency can change. This is not a completion guarantee, a power analysis, or billing evidence. */
  completionGuaranteed: false
}>

/** Uses actual end-to-end timings of the first two baseline training observations, without shrinking the schedule. */
export function forecastNativeCampaign(input: Readonly<{
  fixturePack: NativeWikiFixturePack
  trainingMilliseconds: readonly [number, number]
  elapsedMilliseconds: number
}>): NativeCampaignForecast {
  const schedule = buildNativeCampaignSchedule(input.fixturePack)
  const samples = input.trainingMilliseconds
  if (!Array.isArray(samples) || samples.length !== 2 ||
      samples.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > NATIVE_SKILLOPT_LIMITS.activeMilliseconds) ||
      !Number.isFinite(input.elapsedMilliseconds) || input.elapsedMilliseconds < 0) refuse("campaign_forecast_invalid")
  const conservativeTargetMilliseconds = Math.ceil(Math.max(...samples))
  const remainingActiveMilliseconds = Math.max(0, NATIVE_SKILLOPT_LIMITS.activeMilliseconds - Math.ceil(input.elapsedMilliseconds))
  const remainingEstimateMilliseconds = (schedule.targetRequests - 2) * conservativeTargetMilliseconds +
    (NATIVE_SKILLOPT_LIMITS.optimizerRequests + NATIVE_SKILLOPT_LIMITS.reviewerRequests + schedule.canaryReserve) *
    NATIVE_SKILLOPT_LIMITS.requestMilliseconds
  return Object.freeze({
    status: remainingEstimateMilliseconds <= remainingActiveMilliseconds ? "WITHIN_ESTIMATE" : "BUDGET_FORECAST_REFUSED",
    scheduleSha256: schedule.scheduleSha256,
    observedTrainingRequests: 2,
    targetRequests: schedule.targetRequests,
    conservativeTargetMilliseconds,
    remainingEstimateMilliseconds,
    remainingActiveMilliseconds,
    completionGuaranteed: false,
  })
}

export type NativeTrainerWireRequest =
  | Readonly<{
      kind: "rollout"; runId: string; requestId: string; ordinal: number
      cohort: "baseline-selection" | "training" | "candidate-selection"
      split: "train" | "selection"; caseId: string; replicate: number; fragment: string; fragmentSha256: string
    }>
  | Readonly<{
      kind: "optimizer"; runId: string; requestId: string; ordinal: number; stage: "analyst" | "merge" | "ranking";
      prompt: string; requestedMaxCompletionTokens: number
    }>

function dataObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("trainer_protocol_invalid")
  const keys = Reflect.ownKeys(value)
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) refuse("trainer_protocol_invalid")
  const result: Record<string, unknown> = Object.create(null)
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) refuse("trainer_protocol_invalid")
    result[key] = descriptor.value
  }
  return result
}

function wireText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum ||
      Buffer.from(value, "utf8").toString("utf8") !== value ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || containsSecret(value)) refuse("trainer_protocol_invalid")
  return value
}

/**
 * Strict parent-side IPC grammar for the pinned trainer's single update. It only validates data:
 * native dispatch still requires the controller's current scoped consent and one-use ticket.
 */
export function createNativeTrainerWire(input: Readonly<{
  fixturePack: NativeWikiFixturePack; runId: string; originalSkill: string; sourceLockSha256: string
}>) {
  const originalSkill = assembleSkill(input.originalSkill, "")
  const binding = nativeAdapterManifestBinding({
    runId: input.runId, originalSkillSha256: sha256(originalSkill), sourceLockSha256: input.sourceLockSha256,
  })
  const schedule = buildNativeCampaignSchedule(input.fixturePack)
  // Keep the existing manifest binding in this wrapper, outside the schedule-only grammar core.
  void adapterManifestForSchedule(schedule, binding)
  return createNativeTrainerWireForSchedule({ schedule, runId: input.runId, originalSkill })
}

/**
 * Schedule-only grammar core. The schedule must be the exact immutable value emitted by
 * buildNativeCampaignSchedule; cohort labels describe grammar position only, not authority.
 */
export function createNativeTrainerWireForSchedule(input: Readonly<{
  schedule: NativeCampaignSchedule
  runId: string
  originalSkill: string
}>) {
  let coreInput: Record<string, unknown>
  try { coreInput = dataObject(input, ["schedule", "runId", "originalSkill"]) }
  catch { return refuse("trainer_schedule_invalid") }
  const scheduleValue = coreInput.schedule
  const runIdValue = coreInput.runId
  const originalSkillValue = coreInput.originalSkill
  if (!scheduleValue || typeof scheduleValue !== "object") {
    refuse("trainer_schedule_invalid")
  }
  const schedule = nativeCampaignSchedules.get(scheduleValue)
  if (!schedule) refuse("trainer_schedule_invalid")
  if (typeof runIdValue !== "string") refuse("trainer_schedule_invalid")
  const runId = runIdValue
  if (!RUN_ID.test(runId)) refuse("trainer_schedule_invalid")
  if (typeof originalSkillValue !== "string") refuse("trainer_protocol_invalid")
  const originalSkill = assembleSkill(originalSkillValue, "")
  const training = new Set(schedule.training.map(item => `${item.caseId}:${item.replicate}`))
  const selection = new Set(schedule.trainerSelection.map(item => `${item.caseId}:${item.replicate}`))
  const seen = new Set<string>()
  let rollouts = 0
  let optimizerRequests = 0
  let acceptedEvents = 0
  let candidateFragment: string | undefined
  let stopped = false

  function accept(value: unknown): NativeTrainerWireRequest {
    if (stopped) refuse("trainer_protocol_stopped")
    try {
      const schema = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "schema") : undefined
      if (!schema || !("value" in schema)) refuse("trainer_protocol_invalid")
      if (schema.value === "skillopt.rollout-request.v1") {
        const record = dataObject(value, ["schema", "runId", "requestId", "split", "caseId", "replicate", "fragment"])
        const requestRunId = record.runId
        const requestId = record.requestId
        const caseId = record.caseId
        const replicateValue = record.replicate
        if (typeof requestRunId !== "string" || typeof requestId !== "string" || typeof caseId !== "string" ||
            typeof replicateValue !== "number" || !Number.isSafeInteger(replicateValue)) {
          refuse("trainer_protocol_invalid")
        }
        if (requestRunId !== runId || requestId !== `${runId}:${rollouts + 1}`) refuse("trainer_protocol_invalid")
        const replicate = replicateValue
        const fragment = wireText(record.fragment, 1200)
        const key = `${caseId}:${replicate}`
        const baselineSelection = rollouts < selection.size
        const trainingPhase = rollouts >= selection.size && rollouts < selection.size + training.size
        const cohort = baselineSelection ? "baseline-selection" : trainingPhase ? "training" : "candidate-selection"
        const expectedSplit = trainingPhase ? "train" : "selection"
        if (record.split !== expectedSplit || !(trainingPhase ? training : selection).has(key) ||
            rollouts >= selection.size * 2 + training.size) refuse("trainer_schedule_invalid")
        const observedKey = `${baselineSelection ? "baseline-selection" : expectedSplit}:${key}`
        if (seen.has(observedKey)) refuse("trainer_schedule_invalid")
        if (baselineSelection || trainingPhase) {
          if (fragment !== "") refuse("trainer_schedule_invalid")
        } else {
          if (!fragment || optimizerRequests === 0 || (candidateFragment !== undefined && fragment !== candidateFragment)) refuse("trainer_schedule_invalid")
          assembleSkill(originalSkill, fragment)
          candidateFragment = fragment
        }
        seen.add(observedKey)
        rollouts++
        const ordinal = ++acceptedEvents
        return Object.freeze({
          kind: "rollout", runId, requestId, ordinal, cohort,
          split: expectedSplit, caseId, replicate, fragment, fragmentSha256: sha256(fragment),
        })
      }
      if (schema.value !== "skillopt.native-optimizer-request.v1") refuse("trainer_protocol_invalid")
      const record = dataObject(value, ["schema", "runId", "requestId", "role", "phase", "stage", "maxCompletionTokens", "messages"])
      const requestRunId = record.runId
      const requestId = record.requestId
      const stage = record.stage
      if (typeof requestRunId !== "string" || typeof requestId !== "string") refuse("trainer_protocol_invalid")
      if (stage !== "analyst" && stage !== "merge" && stage !== "ranking") refuse("trainer_protocol_invalid")
      if (requestRunId !== runId || requestId !== `${runId}:optimizer:${optimizerRequests + 1}` ||
          record.role !== "optimizer" || record.phase !== "train" ||
          rollouts !== selection.size + training.size || optimizerRequests >= NATIVE_SKILLOPT_LIMITS.optimizerRequests ||
          !Number.isSafeInteger(record.maxCompletionTokens) || Number(record.maxCompletionTokens) < 1 ||
          Number(record.maxCompletionTokens) > 16384 || !Array.isArray(record.messages) || record.messages.length !== 2) refuse("trainer_protocol_invalid")
      const messageArray = record.messages
      if (Reflect.ownKeys(messageArray).length !== 3) refuse("trainer_protocol_invalid")
      const messages = [0, 1].map(index => {
        const descriptor = Object.getOwnPropertyDescriptor(messageArray, String(index))
        if (!descriptor || !("value" in descriptor)) refuse("trainer_protocol_invalid")
        const parsed = dataObject(descriptor.value, ["role", "content"])
        if (parsed.role !== (index === 0 ? "system" : "user")) refuse("trainer_protocol_invalid")
        return Object.freeze({ role: parsed.role, content: wireText(parsed.content, NATIVE_DATASET_LIMITS.optimizerInputBytes) })
      })
      // No generic chat-host preamble, application history, tools, or provider configuration enters this prompt.
      const prompt = `Apply the system instruction to the user input in this message array:\n${canonicalJson(messages)}`
      if (Buffer.byteLength(prompt, "utf8") > NATIVE_DATASET_LIMITS.optimizerInputBytes) refuse("trainer_prompt_limit")
      optimizerRequests++
      const ordinal = ++acceptedEvents
      return Object.freeze({
        kind: "optimizer", runId, requestId, ordinal,
        stage, prompt, requestedMaxCompletionTokens: Number(record.maxCompletionTokens),
      })
    } catch (error) {
      stopped = true
      if (error instanceof SkillOptError) throw error
      return refuse("trainer_protocol_invalid")
    }
  }
  return Object.freeze({
    accept,
    snapshot: () => Object.freeze({ rollouts, optimizerRequests, candidateFragment, stopped }),
    assertComplete() {
      if (stopped || rollouts !== selection.size * 2 + training.size || !candidateFragment || optimizerRequests === 0) {
        refuse("trainer_schedule_incomplete")
      }
      return Object.freeze({ fragment: candidateFragment, candidateSha256: sha256(assembleSkill(originalSkill, candidateFragment)) })
    },
  })
}
