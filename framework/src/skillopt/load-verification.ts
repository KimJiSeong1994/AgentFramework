import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { consumeCliSkillLoaderCompletion } from "../hosts/cli-host.ts"
import type { CliNativeIdentity } from "../hosts/cli-transport.ts"
import type { ExecutionOutcome } from "../hosts/types.ts"
import {
  consumeSkillLoaderWitness, registerSkillLoaderWitness,
  type SkillInvocationContext, type SkillLoaderCanaryBinding, type SkillLoaderWitnessObservation,
  type SkillLoaderWitnessReceipt,
} from "../skills/context.ts"
import {
  NATIVE_PROTOCOL_SHA256, NATIVE_DATASET_LIMITS, validateNativeFixturePack,
  type NativeWikiFixture,
} from "./dataset.ts"
import { buildNativeEvaluationPrompt, NATIVE_EVALUATION_PROTOCOL_SHA256, scoreNativeFixtureResponse } from "./evaluation.ts"
import { canonicalJson } from "./pilot.ts"
import type { PromotionBindings } from "./promotion.ts"

export const NATIVE_SKILL_LOAD_WITNESS_SCHEMA = "skillopt.native-load-witness.v1" as const
const MAX_CANARY_TASK_BYTES = 48 * 1024
const HASH = /^[a-f0-9]{64}$/u

export class NativeLoadVerificationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "NativeLoadVerificationError"
  }
}

function fail(code: string): never { throw new NativeLoadVerificationError(code) }
function sha256(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex") }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key)) &&
    keys.every(key => typeof key === "string" && expected.includes(key))
}
function sameNativeIdentity(left: CliNativeIdentity, right: CliNativeIdentity): boolean {
  return left.engine === right.engine && left.requestedModel === right.requestedModel &&
    left.runtimeIdentity.version === right.runtimeIdentity.version &&
    left.runtimeIdentity.executableSha256 === right.runtimeIdentity.executableSha256 &&
    left.profileIdentity.id === right.profileIdentity.id && left.profileIdentity.sha256 === right.profileIdentity.sha256
}
function validNativeIdentity(value: unknown): value is CliNativeIdentity {
  if (!isRecord(value) || !sameKeys(value, ["engine", "requestedModel", "runtimeIdentity", "profileIdentity"]) ||
      (value.engine !== "codex" && value.engine !== "claude") || typeof value.requestedModel !== "string" || !value.requestedModel ||
      Buffer.byteLength(value.requestedModel, "utf8") > 256 || !isRecord(value.runtimeIdentity) ||
      !sameKeys(value.runtimeIdentity, ["version", "executableSha256"]) || typeof value.runtimeIdentity.version !== "string" ||
      !value.runtimeIdentity.version || Buffer.byteLength(value.runtimeIdentity.version, "utf8") > 256 ||
      typeof value.runtimeIdentity.executableSha256 !== "string" || !HASH.test(value.runtimeIdentity.executableSha256) ||
      !isRecord(value.profileIdentity) || !sameKeys(value.profileIdentity, ["id", "sha256"]) ||
      typeof value.profileIdentity.id !== "string" || !value.profileIdentity.id || Buffer.byteLength(value.profileIdentity.id, "utf8") > 128 ||
      typeof value.profileIdentity.sha256 !== "string" || !HASH.test(value.profileIdentity.sha256)) return false
  return true
}
function validCanaryBinding(value: unknown): value is SkillLoaderCanaryBinding {
  return isRecord(value) && sameKeys(value, [
    "fixturePackSha256", "fixtureId", "fixtureSha256", "taskSha256", "evaluatorPromptSha256", "evaluatorSystemSha256", "protocolSha256", "evaluatorSha256",
  ]) && typeof value.fixtureId === "string" && value.fixtureId.length > 0 && Buffer.byteLength(value.fixtureId, "utf8") <= 128 &&
    [value.fixturePackSha256, value.fixtureSha256, value.taskSha256, value.evaluatorPromptSha256, value.evaluatorSystemSha256,
      value.protocolSha256, value.evaluatorSha256].every(item => typeof item === "string" && HASH.test(item))
}
function nativeIdentityMatchesBindings(identity: CliNativeIdentity, bindings: PromotionBindings): boolean {
  return identity.engine === bindings.nativeEngine && identity.requestedModel === bindings.nativeModel &&
    identity.runtimeIdentity.version === bindings.nativeRuntimeVersion &&
    identity.runtimeIdentity.executableSha256 === bindings.nativeExecutableSha256 &&
    identity.profileIdentity.id === bindings.nativeProfileId && identity.profileIdentity.sha256 === bindings.nativeProfileSha256
}
function nativeIdentityHash(identity: CliNativeIdentity): string {
  return sha256(canonicalJson(identity))
}
function exactBindings(left: PromotionBindings, right: PromotionBindings): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

export type NativeSkillLoadWitnessRecord = Readonly<{
  schema: typeof NATIVE_SKILL_LOAD_WITNESS_SCHEMA
  operation: "apply" | "rollback"
  runId: string
  witnessMode: "native"
  rootBinding: string
  projectRootSha256: string
  bindingsSha256: string
  sourceSha256: string
  originalSha256: string
  candidateSha256: string
  expectedFileSha256: string
  fixturePackSha256: string
  canaryFixtureSha256: string
  protocolSha256: string
  evaluatorSha256: string
  runtimeSha256: string
  resultsSha256: string
  witnessSha256: string
  skillPath: ".agents/skills/llm-wiki/SKILL.md"
  capture: Readonly<{
    source: "project"
    identity: "project:.agents/skills/llm-wiki"
    classification: "common" | "custom"
    manifestSha256: string
    contentHash: string
    skillFileSha256: string
    skillFileBytes: number
  }>
  invocation: Readonly<{
    sessionID: string
    attachmentEpoch: string
    executionID: string
    taskID: string
    attemptID: string
    generation: number
    role: "main"
    invocationID: string
    requestTextSha256: string
  }>
  prompt: Readonly<{
    sha256: string
    bytes: number
    instructionSha256: string
    instructionBytes: number
    instructionStartByte: number
    instructionEndByte: number
    spanBasis: "exact-captured-instruction-utf8-substring-v1"
    evaluatorSystemSha256: string
    evaluatorSystemBytes: number
    evaluatorSystemStartByte: number
    evaluatorSystemEndByte: number
    evaluatorSpanBasis: "exact-code-owned-evaluator-utf8-substring-v1"
  }>
  native: Readonly<{
    engine: "codex" | "claude"
    requestedModel: string
    identityBefore: CliNativeIdentity
    identityAfter: CliNativeIdentity
    identitySha256: string
    identityStable: true
  }>
  fileIdentity: Readonly<{
    beforeSha256: string
    afterSha256: string
    root: readonly string[]
    agents: readonly string[]
    skills: readonly string[]
    skill: readonly string[]
    file: readonly string[]
    basis: "fd-tree-openat-fstat-and-captured-bytes-v1"
  }>
  response: Readonly<{ sha256: string; bytes: number }>
  canary: Readonly<{
    fixturePackSha256: string
    fixtureId: string
    fixtureSha256: string
    split: "dev"
    taskSha256: string
    evaluatorPromptSha256: string
    evaluatorSystemSha256: string
    protocolSha256: string
    evaluatorSha256: string
    status: "valid"
    hardPass: true
    outputSha256: string
    scoreSha256: string
  }>
  quiescence: Readonly<{
    status: "completed"
    quiescent: true
    reconciliation: "terminal-quiescent"
  }>
}>

declare const nativeCanaryPlanBrand: unique symbol
export type NativeSkillLoadCanaryPlan = Readonly<{
  taskText: string
  systemInstructions: string
  fixturePackSha256: string
  fixtureId: string
  fixtureSha256: string
  taskSha256: string
  evaluatorPromptSha256: string
  evaluatorSystemSha256: string
  protocolSha256: string
  evaluatorSha256: string
  [nativeCanaryPlanBrand]: never
}>

declare const nativeLoadProofBrand: unique symbol
export type NativeSkillLoadVerificationProof = Readonly<{ [nativeLoadProofBrand]: never }>

type PlanState = Readonly<{
  operation: "apply" | "rollback"
  bindings: PromotionBindings
  bindingsSha256: string
  projectRootSha256: string
  expectedFileSha256: string
  fixture: NativeWikiFixture
  systemInstructions: string
  taskText: string
  canary: SkillLoaderCanaryBinding
  registration: { used: boolean }
}>
type Completion = Readonly<{
  status: "completed"
  quiescent: true
  reconciliation: Readonly<{ outcome: "terminal"; quiescent: true; evidence: string }>
  executionID: string
  sessionID: string
  attachmentEpoch: string
  taskID: string
  attemptID: string
  generation: number
  role: "main"
  invocationID: string
  taskSha256: string
  canary: SkillLoaderCanaryBinding
  requestTextSha256: string
  promptSha256: string
  promptBytes: number
  responseText: string
  responseSha256: string
  responseBytes: number
  engine: "codex" | "claude"
  requestedModel: string
  identityBefore: CliNativeIdentity
  identityAfter: CliNativeIdentity
}>
type ProofState = Readonly<{
  operation: "apply" | "rollback"
  bindings: PromotionBindings
  projectRootSha256: string
  expectedFileSha256: string
  record: NativeSkillLoadWitnessRecord
  bytes: Buffer
  digest: string
  consumed: { value: boolean }
}>

const plans = new WeakMap<object, PlanState>()
const observations = new WeakMap<object, PlanState>()
const proofs = new WeakMap<object, ProofState>()

/** Build a one-use plan from the exact run bindings, admitted dev fixture and expected original/candidate bytes. */
export function prepareNativeSkillLoadCanary(input: Readonly<{
  fixturePack: unknown
  fixtureId: string
  approvedFixtureSha256: string
  targetSkillBytes: Uint8Array
  projectRoot: string
  bindings: PromotionBindings
  operation: "apply" | "rollback"
}>): NativeSkillLoadCanaryPlan {
  try {
    if (input.bindings.witnessMode !== "native") fail("native-load-mode-required")
    if (!HASH.test(input.approvedFixtureSha256) || !HASH.test(input.bindings.canaryFixtureSha256) ||
        input.approvedFixtureSha256 !== input.bindings.canaryFixtureSha256) fail("canary-approval-fixture-mismatch")
    const projectRoot = realpathSync.native(resolve(input.projectRoot))
    if (projectRoot !== resolve(input.projectRoot) || sha256(`root:${projectRoot}`) !== input.bindings.rootBinding) {
      fail("canary-project-root-binding-mismatch")
    }
    const validation = validateNativeFixturePack(input.fixturePack)
    if (validation.status !== "STRUCTURALLY_VALID" || validation.packSha256 !== input.bindings.fixturePackSha256 ||
        validation.pack.contract !== "native-wiki-v1") fail("canary-fixture-pack-invalid")
    const fixture = validation.pack.fixtures.find(item => item.id === input.fixtureId)
    if (!fixture || fixture.split !== "dev") fail("canary-fixture-not-approved-dev-split")
    const fixtureSha256 = sha256(canonicalJson(fixture))
    if (fixtureSha256 !== input.approvedFixtureSha256) fail("canary-approval-fixture-mismatch")
    if (input.bindings.protocolSha256 !== NATIVE_PROTOCOL_SHA256 ||
        input.bindings.evaluatorSha256 !== NATIVE_EVALUATION_PROTOCOL_SHA256) fail("canary-protocol-binding-mismatch")
    const expectedFileSha256 = input.operation === "apply" ? input.bindings.candidateSha256 : input.bindings.originalSha256
    const bytes = Buffer.from(input.targetSkillBytes)
    if (bytes.length === 0 || sha256(bytes) !== expectedFileSha256) fail("canary-skill-bytes-binding-mismatch")
    const targetSkill = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    const prompt = buildNativeEvaluationPrompt(fixture, targetSkill)
    const systemPrefix = `${targetSkill}\n\n`
    if (!prompt.system.startsWith(systemPrefix)) fail("canary-evaluator-prompt-invalid")
    const systemInstructions = prompt.system.slice(systemPrefix.length)
    const taskText = prompt.user
    const taskBytes = Buffer.from(taskText, "utf8")
    if (taskBytes.toString("utf8") !== taskText || taskBytes.length > MAX_CANARY_TASK_BYTES) fail("canary-task-size-invalid")
    if (!systemInstructions || Buffer.byteLength(systemInstructions, "utf8") > 8 * 1024) fail("canary-instructions-size-invalid")
    const taskSha256 = sha256(taskBytes)
    const canary: SkillLoaderCanaryBinding = Object.freeze({
      fixturePackSha256: validation.packSha256,
      fixtureId: fixture.id,
      fixtureSha256,
      taskSha256,
      evaluatorPromptSha256: prompt.promptSha256,
      evaluatorSystemSha256: sha256(systemInstructions),
      protocolSha256: NATIVE_PROTOCOL_SHA256,
      evaluatorSha256: NATIVE_EVALUATION_PROTOCOL_SHA256,
    })
    const state: PlanState = Object.freeze({
      operation: input.operation,
      bindings: Object.freeze({ ...input.bindings }),
      bindingsSha256: sha256(canonicalJson(input.bindings)),
      projectRootSha256: sha256(projectRoot),
      expectedFileSha256,
      fixture,
      systemInstructions,
      taskText,
      canary,
      registration: { used: false },
    })
    const plan = Object.freeze({
      taskText,
      systemInstructions,
      fixturePackSha256: canary.fixturePackSha256,
      fixtureId: canary.fixtureId,
      fixtureSha256: canary.fixtureSha256,
      taskSha256: canary.taskSha256,
      evaluatorPromptSha256: canary.evaluatorPromptSha256,
      evaluatorSystemSha256: canary.evaluatorSystemSha256,
      protocolSha256: canary.protocolSha256,
      evaluatorSha256: canary.evaluatorSha256,
    }) as NativeSkillLoadCanaryPlan
    plans.set(plan, state)
    return plan
  } catch (error) {
    if (error instanceof NativeLoadVerificationError) throw error
    return fail("canary-plan-failed-closed")
  }
}

/** Adds the canary binding to a genuine normal-loader context; copied plans cannot register a usable adapter proof. */
export function registerNativeSkillLoadWitness(
  context: SkillInvocationContext,
  plan: NativeSkillLoadCanaryPlan,
): SkillLoaderWitnessObservation {
  const state = plan && typeof plan === "object" ? plans.get(plan) : undefined
  if (!state || plan.taskText !== state.taskText || state.registration.used) return fail("canary-plan-is-copied-or-stale")
  state.registration.used = true
  const observation = registerSkillLoaderWitness(context, state.canary, state.systemInstructions)
  observations.set(observation, state)
  return observation
}

function completion(value: unknown): Completion {
  if (!isRecord(value) || value.status !== "completed" || value.quiescent !== true ||
      !isRecord(value.reconciliation) || value.reconciliation.outcome !== "terminal" || value.reconciliation.quiescent !== true ||
      typeof value.reconciliation.evidence !== "string" || value.reconciliation.evidence.length === 0 ||
      value.role !== "main" || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1 ||
      ![value.executionID, value.sessionID, value.attachmentEpoch, value.taskID, value.attemptID, value.invocationID, value.taskSha256, value.requestTextSha256,
        value.promptSha256, value.responseSha256].every(item => typeof item === "string" && item.length > 0) ||
      typeof value.promptBytes !== "number" || !Number.isSafeInteger(value.promptBytes) || value.promptBytes < 1 || value.promptBytes > 64 * 1024 ||
      typeof value.responseText !== "string" || typeof value.responseBytes !== "number" ||
      !Number.isSafeInteger(value.responseBytes) || value.responseBytes < 1 || value.responseBytes > NATIVE_DATASET_LIMITS.nativeResponseBytes ||
      (value.engine !== "codex" && value.engine !== "claude") || typeof value.requestedModel !== "string" ||
      !validCanaryBinding(value.canary) || value.taskSha256 !== value.canary.taskSha256 ||
      !validNativeIdentity(value.identityBefore) || !validNativeIdentity(value.identityAfter)) fail("host-completion-invalid")
  const bytes = Buffer.from(value.responseText, "utf8")
  if (bytes.toString("utf8") !== value.responseText || bytes.length !== value.responseBytes || sha256(bytes) !== value.responseSha256 ||
      !HASH.test(value.promptSha256 as string) || !HASH.test(value.requestTextSha256 as string) || !HASH.test(value.responseSha256 as string)) {
    fail("host-completion-binding-invalid")
  }
  return value as unknown as Completion
}

function recordFor(plan: PlanState, loader: SkillLoaderWitnessReceipt, host: Completion, score: ReturnType<typeof scoreNativeFixtureResponse>): NativeSkillLoadWitnessRecord {
  const identity = host.identityAfter
  const scoreSha256 = sha256(canonicalJson(score))
  return Object.freeze({
    schema: NATIVE_SKILL_LOAD_WITNESS_SCHEMA,
    operation: plan.operation,
    runId: plan.bindings.runId,
    witnessMode: "native",
    rootBinding: plan.bindings.rootBinding,
    projectRootSha256: plan.projectRootSha256,
    bindingsSha256: plan.bindingsSha256,
    sourceSha256: plan.bindings.sourceSha256,
    originalSha256: plan.bindings.originalSha256,
    candidateSha256: plan.bindings.candidateSha256,
    expectedFileSha256: plan.expectedFileSha256,
    fixturePackSha256: plan.bindings.fixturePackSha256,
    canaryFixtureSha256: plan.bindings.canaryFixtureSha256,
    protocolSha256: plan.bindings.protocolSha256,
    evaluatorSha256: plan.bindings.evaluatorSha256,
    runtimeSha256: plan.bindings.runtimeSha256,
    resultsSha256: plan.bindings.resultsSha256,
    witnessSha256: plan.bindings.witnessSha256,
    skillPath: ".agents/skills/llm-wiki/SKILL.md",
    capture: Object.freeze({ ...loader.capture }),
    invocation: Object.freeze({ ...loader.invocation, requestTextSha256: loader.requestTextSha256 }),
    prompt: Object.freeze({
      sha256: loader.instructions.promptSha256,
      bytes: loader.instructions.promptBytes,
      instructionSha256: loader.instructions.utf8Sha256,
      instructionBytes: loader.instructions.utf8Bytes,
      instructionStartByte: loader.instructions.span.startByte,
      instructionEndByte: loader.instructions.span.endByte,
      spanBasis: loader.instructions.span.basis,
      evaluatorSystemSha256: loader.instructions.evaluatorSystem.utf8Sha256,
      evaluatorSystemBytes: loader.instructions.evaluatorSystem.utf8Bytes,
      evaluatorSystemStartByte: loader.instructions.evaluatorSystem.startByte,
      evaluatorSystemEndByte: loader.instructions.evaluatorSystem.endByte,
      evaluatorSpanBasis: loader.instructions.evaluatorSystem.basis,
    }),
    native: Object.freeze({
      engine: identity.engine,
      requestedModel: identity.requestedModel,
      identityBefore: loader.native.identityBefore,
      identityAfter: loader.native.identityAfter,
      identitySha256: nativeIdentityHash(identity),
      identityStable: true,
    }),
    fileIdentity: Object.freeze({ ...loader.fileIdentity }),
    response: Object.freeze({ ...loader.response }),
    canary: Object.freeze({
      ...plan.canary,
      split: "dev",
      status: "valid",
      hardPass: true,
      outputSha256: score.outputSha256!,
      scoreSha256,
    }),
    quiescence: Object.freeze({ status: "completed", quiescent: true, reconciliation: "terminal-quiescent" }),
  }) as NativeSkillLoadWitnessRecord
}

/** Consumes both opaque host completion and normal-loader observation, then independently scores the exact response. */
export async function completeNativeSkillLoadWitness(input: Readonly<{
  plan: NativeSkillLoadCanaryPlan
  observation: SkillLoaderWitnessObservation
  hostCompletion: ExecutionOutcome
}>): Promise<Readonly<{
  record: NativeSkillLoadWitnessRecord
  bytes: Uint8Array
  sha256: string
  proof: NativeSkillLoadVerificationProof
}>> {
  const planState = input.plan && typeof input.plan === "object" ? plans.get(input.plan) : undefined
  const observedPlan = input.observation && typeof input.observation === "object" ? observations.get(input.observation) : undefined
  if (!planState || observedPlan !== planState) return fail("native-load-observation-does-not-match-plan")
  plans.delete(input.plan)
  observations.delete(input.observation)
  const [loaderResult, completionResult] = await Promise.allSettled([
    consumeSkillLoaderWitness(input.observation),
    Promise.resolve().then(() => consumeCliSkillLoaderCompletion(input.hostCompletion)),
  ])
  if (completionResult.status === "rejected") throw completionResult.reason
  if (loaderResult.status === "rejected") throw loaderResult.reason
  const loader = loaderResult.value
  const host = completion(completionResult.value)
  if (host.executionID !== loader.invocation.executionID || host.sessionID !== loader.invocation.sessionID ||
      host.attachmentEpoch !== loader.invocation.attachmentEpoch || host.invocationID !== loader.invocation.invocationID ||
      host.taskID !== loader.invocation.taskID || host.attemptID !== loader.invocation.attemptID ||
      host.generation !== loader.invocation.generation || host.role !== loader.invocation.role ||
      host.requestTextSha256 !== loader.requestTextSha256 || host.promptSha256 !== loader.instructions.promptSha256 ||
      host.promptBytes !== loader.instructions.promptBytes || host.responseSha256 !== loader.response.sha256 ||
      host.responseBytes !== loader.response.bytes || sha256(host.responseText) !== loader.response.sha256 ||
      host.taskSha256 !== planState.canary.taskSha256 || host.canary.fixturePackSha256 !== planState.canary.fixturePackSha256 ||
      host.canary.fixtureId !== planState.canary.fixtureId || host.canary.fixtureSha256 !== planState.canary.fixtureSha256 ||
      host.canary.taskSha256 !== planState.canary.taskSha256 || host.canary.evaluatorPromptSha256 !== planState.canary.evaluatorPromptSha256 ||
      host.canary.evaluatorSystemSha256 !== planState.canary.evaluatorSystemSha256 ||
      host.canary.protocolSha256 !== planState.canary.protocolSha256 || host.canary.evaluatorSha256 !== planState.canary.evaluatorSha256 ||
      host.engine !== loader.native.engine || host.requestedModel !== loader.native.requestedModel ||
      !sameNativeIdentity(host.identityBefore, host.identityAfter) ||
      !sameNativeIdentity(host.identityBefore, loader.native.identityBefore) ||
      !sameNativeIdentity(host.identityAfter, loader.native.identityAfter) ||
      !nativeIdentityMatchesBindings(host.identityAfter, planState.bindings) ||
      loader.projectRootSha256 !== planState.projectRootSha256 || loader.capture.skillFileSha256 !== planState.expectedFileSha256 ||
      loader.capture.manifestSha256 !== loader.capture.contentHash || loader.canary.fixturePackSha256 !== planState.canary.fixturePackSha256 ||
      loader.canary.fixtureId !== planState.canary.fixtureId || loader.canary.fixtureSha256 !== planState.canary.fixtureSha256 ||
      loader.canary.taskSha256 !== planState.canary.taskSha256 ||
      loader.canary.evaluatorPromptSha256 !== planState.canary.evaluatorPromptSha256 ||
      loader.canary.evaluatorSystemSha256 !== planState.canary.evaluatorSystemSha256 ||
      loader.instructions.evaluatorSystem.utf8Sha256 !== planState.canary.evaluatorSystemSha256 ||
      loader.canary.protocolSha256 !== planState.canary.protocolSha256 || loader.canary.evaluatorSha256 !== planState.canary.evaluatorSha256 ||
      loader.fileIdentity.beforeSha256 !== loader.fileIdentity.afterSha256 || !loader.native.identityStable ||
      loader.native.status !== "completed" || !loader.native.quiescent || loader.native.reconciliation !== "terminal-quiescent") {
    return fail("native-load-witness-binding-mismatch")
  }
  const score = scoreNativeFixtureResponse(planState.fixture, host.responseText)
  if (score.status !== "valid" || score.hardPass !== true || score.outputSha256 !== loader.response.sha256) {
    return fail("native-load-canary-not-passed")
  }
  const record = recordFor(planState, loader, host, score)
  const bytes = Buffer.from(canonicalJson(record), "utf8")
  const proof = Object.freeze({}) as unknown as NativeSkillLoadVerificationProof
  const state: ProofState = Object.freeze({
    operation: planState.operation,
    bindings: planState.bindings,
    projectRootSha256: planState.projectRootSha256,
    expectedFileSha256: planState.expectedFileSha256,
    record,
    bytes: Buffer.from(bytes),
    digest: sha256(bytes),
    consumed: { value: false },
  })
  proofs.set(proof, state)
  return Object.freeze({ record, bytes: Uint8Array.from(bytes), sha256: state.digest, proof })
}

/** Fixed promotion verifier. The opaque proof, not a serialized object or callback, carries native execution authority. */
export function verifyNativeSkillLoadVerificationProof(input: Readonly<{
  proof: NativeSkillLoadVerificationProof
  bytes: Uint8Array
  bindings: PromotionBindings
  expectedFileSha256: string
  projectRootSha256: string
  operation: "apply" | "rollback"
}>): NativeSkillLoadWitnessRecord {
  if (input.bindings.witnessMode !== "native") fail("native-load-mode-required")
  const state = input.proof && typeof input.proof === "object" ? proofs.get(input.proof) : undefined
  if (!state || state.consumed.value) return fail("native-load-proof-invalid-or-consumed")
  state.consumed.value = true
  const bytes = Buffer.from(input.bytes)
  if (!exactBindings(state.bindings, input.bindings) || sha256(bytes) !== state.digest ||
      !bytes.equals(state.bytes) || input.expectedFileSha256 !== state.expectedFileSha256 ||
      input.expectedFileSha256 !== (input.operation === "apply" ? input.bindings.candidateSha256 : input.bindings.originalSha256) ||
      input.projectRootSha256 !== state.projectRootSha256 || input.operation !== state.operation ||
      state.record.expectedFileSha256 !== input.expectedFileSha256 || state.record.runId !== input.bindings.runId || state.record.witnessMode !== "native" ||
      state.record.rootBinding !== input.bindings.rootBinding || state.record.bindingsSha256 !== sha256(canonicalJson(input.bindings)) ||
      state.record.canary.hardPass !== true || state.record.canary.status !== "valid" ||
      state.record.native.identitySha256 !== nativeIdentityHash(state.record.native.identityAfter)) {
    return fail("native-load-proof-binding-mismatch")
  }
  return state.record
}

