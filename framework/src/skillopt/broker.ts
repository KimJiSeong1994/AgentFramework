import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import {
  admissionEpoch, admissionFence, effectiveHold, isAdmissionCurrent,
} from "../sessions/admission.ts"
import { getOwnedSession, readSessionMetadata, type SessionStore } from "../sessions/store.ts"
import { getQueue } from "../orchestration/queue.ts"
import { createCliTransport, type CliNativeIdentity, type CliObservedUsage, type CliTransportHandle, type CliTransportResult } from "../hosts/cli-transport.ts"
import type { ExecutionClaim } from "../hosts/run-state.ts"
import type { ExecutionHandle, ExecutionOutcome, ExecutionReference, ExecutionReconciliation, ExecutionRuntime } from "../hosts/types.ts"
import {
  createSkillOptController, skillOptBindingHashes,
  type SkillOptController, type SkillOptControllerStatus, type SkillOptCurrentBinding,
  type SkillOptDispatchGrant, type SkillOptNativeExecutionIdentity, type SkillOptNativeHost,
  type SkillOptReservation, type SkillOptRequestPhase, type SkillOptRequestRole,
} from "./controller.ts"
import {
  NATIVE_DATASET_LIMITS, validateNativeDataset, type NativeDataset, type NativeModelBinding,
} from "./dataset.ts"
import { canonicalJson, PILOT_LIMITS, readBoundedSource, sha256 } from "./pilot.ts"
import { containsSecret } from "../security/secrets.ts"
import type { PromotionNativeHelperInput } from "./promotion.ts"
import {
  runNativeSkillOptLoadCanary, runNativeSkillOptRollbackCanary,
  type NativeSkillOptLoadCanaryInput, type NativeSkillOptLoadCanaryResult,
  type NativeSkillOptRollbackCanaryInput, type NativeSkillOptRollbackCanaryResult,
} from "./load-execution.ts"

const CONTROL_PROFILE = "estimated-input-reactive-output-v1" as const
const HOST_PROFILE = "legacy-unowned" as const
const SKILL_PATH = ".agents/skills/llm-wiki/SKILL.md"
const MAX_OPTIMIZER_PROMPT_BYTES = NATIVE_DATASET_LIMITS.optimizerInputBytes
const MAX_TARGET_PROMPT_BYTES = NATIVE_DATASET_LIMITS.fixtureInputBytes
const MAX_REVIEWER_PROMPT_BYTES = NATIVE_DATASET_LIMITS.fixtureInputBytes
const MAX_RESPONSE_BYTES = NATIVE_DATASET_LIMITS.nativeResponseBytes
const MAX_REQUEST_MILLISECONDS = 120_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const HASH = /^[a-f0-9]{64}$/u
const NATIVE_ENGINES = new Set(["codex", "claude"])
const REQUEST_ROLES = new Set<SkillOptRequestRole>(["target", "optimizer", "reviewer"])
const REQUEST_PHASES = new Set<SkillOptRequestPhase>(["train", "dev", "final", "safety", "canary"])
const SAFE_RECONCILIATION_EVIDENCE = Object.freeze({
  running: "native execution is running",
  terminal: "native execution is terminal and quiescent",
  unknown: "native execution state is unresolved",
})

type BrokerErrorCode =
  | "invalid_request" | "dataset_invalid" | "binding_drift" | "owner_unavailable" | "owner_busy"
  | "dispatch_not_authorized" | "native_identity_unavailable" | "native_execution_failed"
  | "sensitive_input" | "response_limit" | "empty_response" | "unsafe_response" | "cancelled" | "not_active" | "execution_unresolved"
  | "controller_unavailable"

export class SkillOptBrokerError extends Error {
  constructor(readonly code: BrokerErrorCode) {
    super(code)
    this.name = "SkillOptBrokerError"
  }
}

export type NativeSemanticReviewBinding = Readonly<{
  schema: "skillopt.native-semantic-review.v1"
  subjectSha256: string
  promptSha256: string
}>

export type NativeSkillOptDispatchInput = Readonly<{
  owner: SessionStore
  reservation: SkillOptReservation
  getCurrent: () => SkillOptCurrentBinding
  role: SkillOptRequestRole
  phase: SkillOptRequestPhase
  prompt: string
  semanticReview?: NativeSemanticReviewBinding
  signal?: AbortSignal
}>

declare const completedTargetWitnessBrand: unique symbol
export type NativeSkillOptCompletedTargetWitness = Readonly<{ [completedTargetWitnessBrand]: true }>
declare const completedOptimizerWitnessBrand: unique symbol
export type NativeSkillOptCompletedOptimizerWitness = Readonly<{ [completedOptimizerWitnessBrand]: true }>

export type NativeSkillOptDispatchResult = Readonly<{
  requestId: string
  status: "completed" | "failed" | "cancelled" | "incomplete" | "unresolved"
  text?: string
  targetWitness?: NativeSkillOptCompletedTargetWitness
  optimizerWitness?: NativeSkillOptCompletedOptimizerWitness
  usage: CliObservedUsage | null
  errorCode?: "native_execution_failed" | "sensitive_input" | "response_limit" | "empty_response" | "unsafe_response" | "cancelled" | "execution_unresolved"
}>

export type NativeSkillOptCancelResult = Readonly<{
  requestId: string
  state: "settled" | "unresolved"
  requested: boolean
  acknowledged: boolean
}>

export type NativeSkillOptBroker = Readonly<{
  controller: SkillOptController
  dispatch(input: NativeSkillOptDispatchInput): Promise<NativeSkillOptDispatchResult>
  loadCanary(input: Omit<NativeSkillOptLoadCanaryInput, "controller">): Promise<NativeSkillOptLoadCanaryResult>
  loadRollbackCanary(input: Omit<NativeSkillOptRollbackCanaryInput, "controller">): Promise<NativeSkillOptRollbackCanaryResult>
  cancel(owner: SessionStore, requestId: string): Promise<NativeSkillOptCancelResult>
  recover(owner: SessionStore, runId: string): Promise<SkillOptControllerStatus>
}>

const brokerWorktrees = new WeakMap<object, string>()

/** Returns a worktree only for the exact frozen broker object emitted by this module's factory. */
export function getNativeSkillOptBrokerWorktree(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  return brokerWorktrees.get(value)
}

type DispatchRequest = {
  owner: SessionStore
  reservation: SkillOptReservation
  reservationIdentity: object
  getCurrent: () => SkillOptCurrentBinding
  role: SkillOptRequestRole
  phase: SkillOptRequestPhase
  prompt: string
  semanticReview?: NativeSemanticReviewBinding
  signal?: AbortSignal
  requestId: string
}

type CurrentSnapshot = Readonly<{
  dataset: NativeDataset
  baselineSkillSha256: string
  bindingSha256: string
}>

type OwnedExecution = {
  runtime: ExecutionRuntime
  controller: SkillOptController
  request: DispatchRequest
  requestId: string
  ownerFence: string
  transport?: CliTransportHandle
  handle?: ExecutionHandle
  claim?: ExecutionClaim
  identity?: SkillOptNativeExecutionIdentity
  reference: ExecutionReference
  launched: boolean
  dispatchRecorded: boolean
  intentRegistered: boolean
  consumed: boolean
  cancelRequested: boolean
  cancelPromise?: Promise<{ requested: boolean; acknowledged: boolean }>
  result?: CliTransportResult
  done: Promise<void>
  resolveDone(): void
  retain: boolean
  drift?: BrokerErrorCode
}

function brokerFail(code: BrokerErrorCode): never {
  throw new SkillOptBrokerError(code)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function idOnlyReference(value: unknown): value is ExecutionReference {
  if (!object(value)) return false
  try {
    const keys = Reflect.ownKeys(value)
    const descriptor = Object.getOwnPropertyDescriptor(value, "executionID")
    return keys.length === 1 && keys[0] === "executionID" && !!descriptor && "value" in descriptor &&
      typeof descriptor.value === "string" && UUID.test(descriptor.value)
  } catch { return false }
}

function dataRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!object(value)) brokerFail("invalid_request")
  const allowed = new Set([...required, ...optional])
  let keys: PropertyKey[]
  try { keys = Reflect.ownKeys(value) } catch { brokerFail("invalid_request") }
  if (required.some(key => !keys.includes(key)) || keys.some(key => typeof key !== "string" || !allowed.has(key))) brokerFail("invalid_request")
  const result: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== "string") brokerFail("invalid_request")
    let descriptor: PropertyDescriptor | undefined
    try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { brokerFail("invalid_request") }
    if (!descriptor || !("value" in descriptor) || !required.includes(key) && descriptor.value === undefined) brokerFail("invalid_request")
    result[key] = descriptor.value
  }
  return Object.freeze(result)
}

function checkedRequest(input: NativeSkillOptDispatchInput): DispatchRequest {
  const record = dataRecord(input, ["owner", "reservation", "getCurrent", "role", "phase", "prompt"], ["semanticReview", "signal"])
  const reservationIdentity = record.reservation
  if (!object(reservationIdentity)) brokerFail("invalid_request")
  const reservation = dataRecord(reservationIdentity, [
    "runId", "reservationId", "requestId", "bindingSha256", "scheduleSha256", "role", "phase", "charged", "ticket", "receipt",
  ]) as unknown as SkillOptReservation
  if (![reservation.runId, reservation.reservationId, reservation.requestId].every((value) => typeof value === "string" && UUID.test(value)) ||
      !HASH.test(reservation.bindingSha256) || !HASH.test(reservation.scheduleSha256) || reservation.charged !== true ||
      !object(reservation.ticket) || !object(reservation.receipt) ||
      !REQUEST_ROLES.has(reservation.role) || !REQUEST_PHASES.has(reservation.phase)) brokerFail("invalid_request")
  if (record.role !== reservation.role || record.phase !== reservation.phase || !REQUEST_ROLES.has(record.role as SkillOptRequestRole) ||
      !REQUEST_PHASES.has(record.phase as SkillOptRequestPhase)) brokerFail("invalid_request")
  if (typeof record.prompt !== "string" || !wellFormedUtf16(record.prompt)) brokerFail("invalid_request")
  const promptBytes = Buffer.byteLength(record.prompt, "utf8")
  const maxPromptBytes = record.role === "optimizer" ? MAX_OPTIMIZER_PROMPT_BYTES
    : record.role === "target" ? MAX_TARGET_PROMPT_BYTES : MAX_REVIEWER_PROMPT_BYTES
  if (promptBytes === 0 || promptBytes > maxPromptBytes) brokerFail("invalid_request")
  if (record.role === "optimizer" && record.phase !== "train") brokerFail("invalid_request")
  if (record.role === "reviewer") {
    const review = dataRecord(record.semanticReview, ["schema", "subjectSha256", "promptSha256"])
    if (review.schema !== "skillopt.native-semantic-review.v1" || !HASH.test(review.subjectSha256 as string) ||
        review.promptSha256 !== sha256(Buffer.from(record.prompt, "utf8")) || record.phase === "train" || record.phase === "canary") {
      brokerFail("invalid_request")
    }
  } else if (record.semanticReview !== undefined) brokerFail("invalid_request")
  if (record.signal !== undefined && !(record.signal instanceof AbortSignal)) brokerFail("invalid_request")
  if (typeof record.getCurrent !== "function") brokerFail("invalid_request")
  if (containsSecret(record.prompt)) brokerFail("sensitive_input")
  return {
    owner: record.owner as SessionStore,
    reservation,
    reservationIdentity,
    getCurrent: record.getCurrent as () => SkillOptCurrentBinding,
    role: record.role as SkillOptRequestRole,
    phase: record.phase as SkillOptRequestPhase,
    prompt: record.prompt,
    ...(record.semanticReview !== undefined ? { semanticReview: record.semanticReview as NativeSemanticReviewBinding } : {}),
    ...(record.signal !== undefined ? { signal: record.signal as AbortSignal } : {}),
    requestId: reservation.requestId,
  }
}

function wellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function snapshotCurrent(root: string, current: SkillOptCurrentBinding): CurrentSnapshot {
  try {
    const dataset = validateNativeDataset(root, current.dataset)
    if (dataset.status !== "STRUCTURALLY_VALID") brokerFail("dataset_invalid")
    const baselineBytes = readBoundedSource(root, SKILL_PATH, PILOT_LIMITS.skillBytes)
    if (sha256(baselineBytes) !== current.baselineSkillSha256) brokerFail("binding_drift")
    const hashes = skillOptBindingHashes(root, dataset, current.baselineSkillSha256)
    return Object.freeze({ dataset, baselineSkillSha256: current.baselineSkillSha256, bindingSha256: hashes.bindingSha256 })
  } catch (error) {
    if (error instanceof SkillOptBrokerError) throw error
    brokerFail("dataset_invalid")
  }
}

function readCurrent(getCurrent: () => SkillOptCurrentBinding, failure: "invalid_request" | "binding_drift"): SkillOptCurrentBinding {
  let raw: unknown
  try { raw = getCurrent() } catch { brokerFail(failure) }
  try {
    const current = dataRecord(raw, ["dataset", "baselineSkillSha256"]) as unknown as SkillOptCurrentBinding
    if (typeof current.baselineSkillSha256 !== "string" || !HASH.test(current.baselineSkillSha256)) brokerFail(failure)
    return current
  } catch { brokerFail(failure) }
}

function assertModelBinding(snapshot: CurrentSnapshot, role: SkillOptRequestRole): NativeModelBinding {
  const binding = role === "optimizer" ? snapshot.dataset.modelBindings.generator
    : role === "target" ? snapshot.dataset.modelBindings.target : snapshot.dataset.modelBindings.reviewer
  if (!binding || !NATIVE_ENGINES.has(binding.engine) || !binding.requestedModel ||
      !HASH.test(binding.runtimeIdentity.executableSha256) || !HASH.test(binding.profileIdentity.sha256)) brokerFail("dataset_invalid")
  return binding
}

function matchesIdentity(identity: unknown, binding: NativeModelBinding): identity is CliNativeIdentity {
  try {
    const value = dataRecord(identity, ["engine", "requestedModel", "runtimeIdentity", "profileIdentity"])
    const runtime = dataRecord(value.runtimeIdentity, ["version", "executableSha256"])
    const profile = dataRecord(value.profileIdentity, ["id", "sha256"])
    return value.engine === binding.engine && value.requestedModel === binding.requestedModel &&
      runtime.version === binding.runtimeIdentity.version && runtime.executableSha256 === binding.runtimeIdentity.executableSha256 &&
      profile.id === binding.profileIdentity.id && profile.sha256 === binding.profileIdentity.sha256
  } catch { return false }
}

function sealedInputAppears(prompt: string, dataset: NativeDataset): boolean {
  const sealed = dataset.fixturePack.fixtures.filter((fixture) => fixture.split === "final" || fixture.split === "safety")
  const permitted = new Set<string>()
  const fragments = new Set<string>()
  const visit = (value: unknown, output: Set<string>): void => {
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") >= 8) output.add(value)
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, output)
    } else if (object(value)) {
      for (const item of Object.values(value)) visit(item, output)
    }
  }
  for (const fixture of dataset.fixturePack.fixtures) {
    if (fixture.split === "train" || fixture.split === "dev") visit(fixture, permitted)
  }
  for (const fixture of sealed) visit(fixture, fragments)
  for (const fragment of permitted) fragments.delete(fragment)
  for (const fragment of fragments) if (prompt.includes(fragment)) return true
  return false
}

function nativePolicyID(identity: CliNativeIdentity): string {
  return `skillopt-native-v1:${sha256(canonicalJson(identity))}`
}

function currentDrift(root: string, entry: OwnedExecution, runtime: ExecutionRuntime, ownerFence: string): BrokerErrorCode | undefined {
  try {
    assertOwnerCurrent(root, runtime, entry.request.owner, ownerFence)
  } catch (error) {
    return error instanceof SkillOptBrokerError ? error.code : "owner_unavailable"
  }
  try {
    const current = snapshotCurrent(root, readCurrent(entry.request.getCurrent, "binding_drift"))
    if (current.bindingSha256 !== entry.request.reservation.bindingSha256) return "binding_drift"
  } catch (error) {
    return error instanceof SkillOptBrokerError ? error.code : "dataset_invalid"
  }
  return undefined
}

function assertOwnerCurrent(root: string, runtime: ExecutionRuntime, owner: SessionStore, expectedFence: string): void {
  try {
    if (!owner || typeof owner.sessionID !== "string" || getOwnedSession(root, owner.sessionID) !== owner || owner.isReleased) {
      brokerFail("owner_unavailable")
    }
    owner.assertOwner()
    if (!readSessionMetadata(root, owner.sessionID) || admissionEpoch(root, owner.sessionID) !== owner.epoch ||
        !isAdmissionCurrent(root, owner.sessionID, owner.epoch) || owner.metadata.held || effectiveHold(root, owner.sessionID) ||
        admissionFence(root, owner.sessionID) !== expectedFence) brokerFail("owner_unavailable")
    if (getQueue(runtime).isRunning(owner.sessionID)) brokerFail("owner_busy")
  } catch (error) {
    if (error instanceof SkillOptBrokerError) throw error
    brokerFail("owner_unavailable")
  }
}

function fixedControllerError(error: unknown): SkillOptBrokerError {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
  if (code === "dispatch-not-authorized") return new SkillOptBrokerError("dispatch_not_authorized")
  if (code === "owner-busy") return new SkillOptBrokerError("owner_busy")
  if (code === "owner-unavailable" || code === "admission-held") return new SkillOptBrokerError("owner_unavailable")
  if (code.startsWith("binding-") || code === "consent-binding-drift" || code === "binding-invalid") return new SkillOptBrokerError("binding_drift")
  if (code === "data-required") return new SkillOptBrokerError("dataset_invalid")
  return new SkillOptBrokerError("controller_unavailable")
}

function normalizedReconciliation(value: unknown): ExecutionReconciliation {
  if (!object(value) || !["running", "terminal", "unknown"].includes(String(value.outcome)) || typeof value.quiescent !== "boolean") {
    return { outcome: "unknown", quiescent: false, evidence: SAFE_RECONCILIATION_EVIDENCE.unknown }
  }
  if (value.outcome === "terminal" && value.quiescent === true) {
    return { outcome: "terminal", quiescent: true, evidence: SAFE_RECONCILIATION_EVIDENCE.terminal }
  }
  if (value.outcome === "running") return { outcome: "running", quiescent: false, evidence: SAFE_RECONCILIATION_EVIDENCE.running }
  return { outcome: "unknown", quiescent: false, evidence: SAFE_RECONCILIATION_EVIDENCE.unknown }
}

function toExecutionOutcome(result: CliTransportResult): ExecutionOutcome {
  switch (result.status) {
    case "completed": return { status: "completed", text: result.text }
    case "failed": return { status: "failed", error: "native CLI execution failed" }
    case "cancelled": return { status: "cancelled" }
    case "incomplete": return { status: "incomplete" }
    case "unresolved": return { status: "unresolved" }
  }
}

function safeUsage(value: CliObservedUsage | undefined): CliObservedUsage | null {
  if (!value) return null
  const output: { -readonly [K in keyof CliObservedUsage]?: CliObservedUsage[K] } = {}
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationTokens"] as const) {
    const count = value[key]
    if (count !== undefined && Number.isSafeInteger(count) && count >= 0) output[key] = count
  }
  const cost = value.reportedCostUsd
  if (cost !== undefined && Number.isFinite(cost) && cost >= 0) output.reportedCostUsd = cost
  return Object.keys(output).length ? Object.freeze(output) : null
}

function responseResult(requestId: string, result: CliTransportResult): NativeSkillOptDispatchResult {
  if (result.status === "completed") {
    if (typeof result.text !== "string" || !wellFormedUtf16(result.text)) {
      return Object.freeze({ requestId, status: "failed", usage: safeUsage(result.usage), errorCode: "unsafe_response" })
    }
    const textBytes = Buffer.byteLength(result.text, "utf8")
    if (textBytes > MAX_RESPONSE_BYTES) return Object.freeze({ requestId, status: "failed", usage: safeUsage(result.usage), errorCode: "response_limit" })
    if (textBytes === 0) return Object.freeze({ requestId, status: "failed", usage: safeUsage(result.usage), errorCode: "empty_response" })
    if (containsSecret(result.text)) return Object.freeze({ requestId, status: "failed", usage: safeUsage(result.usage), errorCode: "unsafe_response" })
    return Object.freeze({ requestId, status: "completed", text: result.text, usage: safeUsage(result.usage) })
  }
  const errorCode = result.status === "failed" ? "native_execution_failed"
    : result.status === "cancelled" ? "cancelled" : "execution_unresolved"
  return Object.freeze({ requestId, status: result.status, usage: safeUsage(result.usage), errorCode })
}

function safeNotDispatched(entry: OwnedExecution): void {
  const { request, claim } = entry
  if (claim && entry.intentRegistered) {
    const terminalAt = Date.now()
    entry.runtime.runs.recordTerminal(claim, entry.requestId, { outcome: "not-dispatched", terminalAt, quiescentAt: terminalAt })
    entry.runtime.runs.reconcile(claim, entry.requestId, {
      outcome: "terminal", quiescent: true, evidence: "native execution was not dispatched",
    })
  }
  if (entry.consumed && !entry.dispatchRecorded) {
    entry.controller.recordDispatch(request.owner, request.reservation.receipt, { state: "not-dispatched" })
    entry.dispatchRecorded = true
  }
  if (claim) {
    entry.runtime.runs.assertQuiescent(claim)
    entry.runtime.runs.release(claim)
  }
}

/** Creates the native-only broker around the caller's original runtime object; it never substitutes or clones that runtime. */
export function createNativeSkillOptBroker(
  runtime: ExecutionRuntime,
  nativeHelper: PromotionNativeHelperInput,
): NativeSkillOptBroker {
  let root: string
  try { root = realpathSync.native(runtime.worktree) } catch { brokerFail("owner_unavailable") }
  // Active and unresolved executions stay addressable; terminal ticket replay is rejected by the durable controller.
  const executions = new Map<string, OwnedExecution>()
  const completedTargets = new WeakMap<object, {
    owner: SessionStore
    reservation: object
    requestId: string
    promptSha256: string
    responseSha256: string
    responseBytes: number
  }>()
  const completedOptimizers = new WeakMap<object, {
    controller: SkillOptController
    owner: SessionStore
    reservation: object
    requestId: string
    role: "optimizer"
    phase: "train"
    promptSha256: string
    responseSha256: string
    responseBytes: number
    usage: CliObservedUsage | null
  }>()

  const nativeHost: SkillOptNativeHost = Object.freeze({
    consumeCompletedTargetWitness(witness, expected) {
      if (!object(witness)) brokerFail("dispatch_not_authorized")
      const proof = completedTargets.get(witness)
      if (!proof || expected.controller !== controller || expected.owner !== proof.owner ||
          expected.reservation !== proof.reservation || expected.reservation.requestId !== proof.requestId) {
        brokerFail("dispatch_not_authorized")
      }
      completedTargets.delete(witness)
      return Object.freeze({
        promptSha256: proof.promptSha256,
        responseSha256: proof.responseSha256,
        responseBytes: proof.responseBytes,
      })
    },
    consumeCompletedOptimizerWitness(witness, expected) {
      if (!object(witness)) brokerFail("dispatch_not_authorized")
      const proof = completedOptimizers.get(witness)
      if (!proof || proof.controller !== controller || expected.controller !== proof.controller || expected.owner !== proof.owner ||
          expected.reservation !== proof.reservation || expected.reservation.requestId !== proof.requestId ||
          proof.role !== "optimizer" || proof.phase !== "train") {
        brokerFail("dispatch_not_authorized")
      }
      completedOptimizers.delete(witness)
      return Object.freeze({
        promptSha256: proof.promptSha256,
        responseSha256: proof.responseSha256,
        responseBytes: proof.responseBytes,
        usage: proof.usage,
      })
    },
    identityFor(reference) {
      if (!idOnlyReference(reference)) return undefined
      const entry = executions.get(reference.executionID)
      if (!entry?.launched || !entry.identity || !entry.handle || !isDeepStrictEqual(entry.reference, reference)) return undefined
      return entry.identity
    },
    async reconcile(reference) {
      if (!idOnlyReference(reference)) return { outcome: "unknown", quiescent: false, evidence: SAFE_RECONCILIATION_EVIDENCE.unknown }
      const entry = reference && executions.get(reference.executionID)
      if (!entry?.launched || !entry.handle || !isDeepStrictEqual(entry.reference, reference) || !entry.claim) {
        return { outcome: "unknown", quiescent: false, evidence: SAFE_RECONCILIATION_EVIDENCE.unknown }
      }
      const beforeDrift = currentDrift(root, entry, runtime, entry.ownerFence)
      if (beforeDrift) entry.drift ??= beforeDrift
      if (entry.drift) await requestCancel(entry)
      let raw: ExecutionReconciliation
      try { raw = await entry.handle.reconcile() }
      catch { return { outcome: "unknown", quiescent: false, evidence: SAFE_RECONCILIATION_EVIDENCE.unknown } }
      const afterDrift = currentDrift(root, entry, runtime, entry.ownerFence)
      if (afterDrift) entry.drift ??= afterDrift
      const reconciliation = normalizedReconciliation(raw)
      try {
        runtime.runs.reconcile(entry.claim, entry.requestId, reconciliation)
        if (!reconciliation.quiescent) runtime.runs.fence(entry.claim, entry.requestId, "native execution requires reconciliation")
      } catch {
        return { outcome: "unknown", quiescent: false, evidence: SAFE_RECONCILIATION_EVIDENCE.unknown }
      }
      return reconciliation
    },
  })
  const controller = createSkillOptController(runtime, nativeHelper, nativeHost)

  function checkedCurrent(request: DispatchRequest, binding = readCurrent(request.getCurrent, "binding_drift")): CurrentSnapshot {
    const snapshot = snapshotCurrent(root, binding)
    if (snapshot.bindingSha256 !== request.reservation.bindingSha256) brokerFail("binding_drift")
    return snapshot
  }

  function ownerFence(owner: SessionStore): string {
    try {
      if (!owner || typeof owner.sessionID !== "string" || getOwnedSession(root, owner.sessionID) !== owner || owner.isReleased) {
        brokerFail("owner_unavailable")
      }
      owner.assertOwner()
      if (!readSessionMetadata(root, owner.sessionID) || admissionEpoch(root, owner.sessionID) !== owner.epoch ||
          !isAdmissionCurrent(root, owner.sessionID, owner.epoch) || owner.metadata.held || effectiveHold(root, owner.sessionID)) {
        brokerFail("owner_unavailable")
      }
      return admissionFence(root, owner.sessionID)
    } catch (error) {
      if (error instanceof SkillOptBrokerError) throw error
      brokerFail("owner_unavailable")
    }
  }

  async function execute(entry: OwnedExecution, expectedFence: string): Promise<NativeSkillOptDispatchResult> {
    const { request } = entry
    let claim: ExecutionClaim | undefined
    let launched = false
    let observedIdentity: CliNativeIdentity | undefined
    try {
      let snapshot = checkedCurrent(request)
      const binding = assertModelBinding(snapshot, request.role)
      if (request.role === "optimizer" && sealedInputAppears(request.prompt, snapshot.dataset)) brokerFail("invalid_request")
      assertOwnerCurrent(root, runtime, request.owner, expectedFence)
      if (request.signal?.aborted) brokerFail("cancelled")
      const deadlineAt = Date.now() + MAX_REQUEST_MILLISECONDS
      try {
        entry.transport = createCliTransport({
          engine: binding.engine, model: binding.requestedModel, prompt: request.prompt,
          deadlineAt, maxOutputBytes: MAX_RESPONSE_BYTES,
        })
      } catch { brokerFail("native_identity_unavailable") }
      if (entry.cancelRequested) {
        await requestCancel(entry)
        brokerFail("cancelled")
      }
      if (typeof entry.transport.inspectIdentity !== "function") brokerFail("native_identity_unavailable")
      let actualIdentity: CliNativeIdentity | undefined
      try { actualIdentity = await entry.transport.inspectIdentity() }
      catch { brokerFail("native_identity_unavailable") }
      const afterProbeDrift = currentDrift(root, entry, runtime, expectedFence)
      if (afterProbeDrift) brokerFail(afterProbeDrift)
      if (entry.cancelRequested || request.signal?.aborted) brokerFail("cancelled")
      if (!actualIdentity || !matchesIdentity(actualIdentity, binding)) brokerFail("native_identity_unavailable")
      observedIdentity = actualIdentity
      const currentAtGrant = readCurrent(request.getCurrent, "binding_drift")
      snapshot = checkedCurrent(request, currentAtGrant)
      assertOwnerCurrent(root, runtime, request.owner, expectedFence)
      if (request.signal?.aborted || entry.cancelRequested) brokerFail("cancelled")
      if (Date.now() >= deadlineAt) brokerFail("native_identity_unavailable")

      const grant = controller.consumeDispatch(request.owner, request.reservation.ticket, currentAtGrant)
      entry.consumed = true
      // Keep this synchronous sequence gap-free: the controller proves foreground idle before the run-store claim.
      claim = runtime.runs.claim(request.owner.sessionID, runtime.instance, process.pid)
      entry.claim = claim
      if (grant.runId !== request.reservation.runId || grant.reservationId !== request.reservation.reservationId ||
          grant.requestId !== request.requestId || grant.role !== request.role || grant.phase !== request.phase ||
          grant.bindingSha256 !== snapshot.bindingSha256 || !Number.isSafeInteger(grant.timeoutMilliseconds) ||
          grant.timeoutMilliseconds <= 0 || grant.timeoutMilliseconds > MAX_REQUEST_MILLISECONDS ||
          deadlineAt > Date.now() + grant.timeoutMilliseconds) {
        brokerFail("dispatch_not_authorized")
      }
      if (entry.cancelRequested || request.signal?.aborted) brokerFail("cancelled")
      const attemptId = randomUUID()
      const policyID = nativePolicyID(observedIdentity)
      const identity: SkillOptNativeExecutionIdentity = Object.freeze({
        engine: observedIdentity.engine,
        profile: HOST_PROFILE,
        controlProfile: CONTROL_PROFILE,
        policyID,
        role: grant.role,
        phase: grant.phase,
      })
      const taskId = `skillopt:${grant.role}:${grant.phase}:${grant.requestId}`
      runtime.runs.registerIntent(claim, {
        executionId: grant.requestId, ownerSession: request.owner.sessionID, taskId,
        attemptId, generation: claim.generation, role: grant.role, cwd: runtime.worktree, policyID,
        kind: "host", engine: observedIdentity.engine, profile: HOST_PROFILE, controlProfile: CONTROL_PROFILE,
        nativeExecution: true,
      })
      entry.intentRegistered = true
      const reference: ExecutionReference = Object.freeze({ executionID: grant.requestId })
      entry.reference = reference
      entry.identity = identity
      const handle: ExecutionHandle = {
        reference,
        async run() {
          if (!entry.transport) throw new Error("native transport unavailable")
          const result = await entry.transport.run()
          entry.result = result
          return toExecutionOutcome(result)
        },
        requestCancel(reason, cancelDeadline) {
          if (!entry.transport) return Promise.resolve({ requested: false, acknowledged: false, terminal: false, quiescent: false })
          return entry.transport.requestCancel(reason, cancelDeadline)
        },
        reconcile() {
          if (!entry.transport) return Promise.resolve({ outcome: "unknown", quiescent: false, evidence: SAFE_RECONCILIATION_EVIDENCE.unknown })
          return entry.transport.reconcile()
        },
      }
      entry.handle = handle
      const bindingDrift = currentDrift(root, entry, runtime, expectedFence)
      if (bindingDrift) {
        entry.drift = bindingDrift
        brokerFail(bindingDrift)
      }
      runtime.runs.bindNativeExecutionRef(claim, grant.requestId)
      runtime.runs.markHostDispatched(claim, grant.requestId)
      entry.launched = true
      const runPromise = handle.run()
      launched = true
      try {
        controller.recordDispatch(request.owner, request.reservation.receipt, { state: "launched", reference })
        entry.dispatchRecorded = true
      } catch {
        entry.retain = true
      }
      let outcome: ExecutionOutcome
      try {
        outcome = await runPromise
      } catch {
        entry.retain = true
        entry.drift ??= currentDrift(root, entry, runtime, expectedFence)
        await settleAfterLaunch(entry, claim, undefined)
        brokerFail("execution_unresolved")
      }
      const afterRunDrift = currentDrift(root, entry, runtime, expectedFence)
      if (afterRunDrift) entry.drift ??= afterRunDrift
      if (["completed", "failed", "cancelled"].includes(outcome.status)) {
        runtime.runs.recordTerminal(claim, grant.requestId, { outcome: outcome.status, terminalAt: Date.now() })
      }
      if (!entry.dispatchRecorded) brokerFail("execution_unresolved")
      let controllerStatus: SkillOptControllerStatus
      try { controllerStatus = await controller.recover(request.owner, grant.runId) }
      catch {
        entry.retain = true
        if (claim) {
          try { runtime.runs.fence(claim, grant.requestId, "native dispatch settlement is unresolved") }
          catch { /* The durable execution claim remains held. */ }
        }
        brokerFail("execution_unresolved")
      }
      const afterRecoveryDrift = currentDrift(root, entry, runtime, expectedFence)
      if (afterRecoveryDrift) entry.drift ??= afterRecoveryDrift
      if (controllerStatus.pendingDispatch) {
        entry.retain = true
        brokerFail("execution_unresolved")
      }
      if (!releaseClaim(claim, runtime)) {
        entry.retain = true
        brokerFail("execution_unresolved")
      }
      entry.retain = false
      if (entry.drift) brokerFail(entry.drift)
      if (!entry.result) brokerFail("execution_unresolved")
      const result = responseResult(grant.requestId, entry.result)
      if (result.status !== "completed" || typeof result.text !== "string") return result
      const proof = {
        owner: request.owner,
        reservation: request.reservationIdentity,
        requestId: grant.requestId,
        promptSha256: sha256(Buffer.from(request.prompt, "utf8")),
        responseSha256: sha256(Buffer.from(result.text, "utf8")),
        responseBytes: Buffer.byteLength(result.text, "utf8"),
      }
      if (request.role === "target") {
        const targetWitness = Object.freeze({}) as NativeSkillOptCompletedTargetWitness
        completedTargets.set(targetWitness, proof)
        return Object.freeze({ ...result, targetWitness })
      }
      if (request.role === "optimizer" && request.phase === "train") {
        const optimizerWitness = Object.freeze({}) as NativeSkillOptCompletedOptimizerWitness
        completedOptimizers.set(optimizerWitness, { ...proof, controller, role: "optimizer", phase: "train", usage: result.usage })
        return Object.freeze({ ...result, optimizerWitness })
      }
      return result
    } catch (error) {
      const mapped = error instanceof SkillOptBrokerError ? error : fixedControllerError(error)
      if (claim && !launched && !entry.launched) {
        try { safeNotDispatched(entry) }
        catch {
          entry.retain = true
          try { runtime.runs.fence(claim, request.requestId, "native dispatch state is ambiguous") } catch { /* Keep the durable claim. */ }
          if (entry.consumed && !entry.dispatchRecorded) {
            try { controller.recordDispatch(request.owner, request.reservation.receipt, { state: "ambiguous" }); entry.dispatchRecorded = true }
            catch { /* The pending reservation remains charged and unresolved. */ }
          }
        }
      } else if (claim && (launched || entry.launched)) {
        entry.retain = true
        if (entry.handle) {
          try { await settleAfterLaunch(entry, claim, undefined) } catch { /* Preserve claim and dispatch charge. */ }
        }
      } else if (entry.consumed && !entry.dispatchRecorded) {
        try { controller.recordDispatch(request.owner, request.reservation.receipt, { state: "not-dispatched" }); entry.dispatchRecorded = true }
        catch {
          try { controller.recordDispatch(request.owner, request.reservation.receipt, { state: "ambiguous" }); entry.dispatchRecorded = true }
          catch { /* The pending reservation remains charged and unresolved. */ }
        }
      }
      if (mapped.code === "cancelled" && entry.result?.status === "cancelled") {
        return Object.freeze({ requestId: request.requestId, status: "cancelled", usage: safeUsage(entry.result.usage), errorCode: "cancelled" })
      }
      throw mapped
    }
  }

  async function settleAfterLaunch(entry: OwnedExecution, claim: ExecutionClaim, _outcome: ExecutionOutcome | undefined): Promise<void> {
    if (entry.cancelRequested || entry.request.signal?.aborted || entry.drift) await requestCancel(entry)
    let raw: ExecutionReconciliation
    try { raw = await entry.handle!.reconcile() }
    catch { raw = { outcome: "unknown", quiescent: false, evidence: SAFE_RECONCILIATION_EVIDENCE.unknown } }
    const afterDrift = currentDrift(root, entry, runtime, entry.ownerFence)
    if (afterDrift) entry.drift ??= afterDrift
    const reconciliation = normalizedReconciliation(raw)
    try {
      runtime.runs.reconcile(claim, entry.requestId, reconciliation)
      if (!reconciliation.quiescent) {
        runtime.runs.fence(claim, entry.requestId, "native execution requires reconciliation")
        entry.retain = true
      }
    } catch {
      runtime.runs.fence(claim, entry.requestId, "native execution reconciliation failed")
      entry.retain = true
    }
  }

  async function requestCancel(entry: OwnedExecution): Promise<{ requested: boolean; acknowledged: boolean }> {
    if (entry.cancelPromise) return entry.cancelPromise
    if (!entry.transport) return { requested: false, acknowledged: false }
    entry.cancelPromise = (async () => {
      const requestedAt = Date.now()
      if (entry.claim && entry.intentRegistered) {
        try { runtime.runs.recordCancel(entry.claim, entry.requestId, { requestedAt }) }
        catch {
          entry.retain = true
          try { runtime.runs.fence(entry.claim, entry.requestId, "native cancellation record is unresolved") } catch { /* Keep the durable claim. */ }
        }
      }
      try {
        const result = await entry.transport!.requestCancel("native skill-optimization request cancelled", requestedAt + 2_000)
        if (result.acknowledged && entry.claim && entry.intentRegistered) {
          try { runtime.runs.recordCancel(entry.claim, entry.requestId, { requestedAt, acknowledgedAt: Date.now() }) }
          catch {
            entry.retain = true
            try { runtime.runs.fence(entry.claim, entry.requestId, "native cancellation acknowledgement is unresolved") } catch { /* Keep the durable claim. */ }
          }
        }
        const drift = currentDrift(root, entry, runtime, entry.ownerFence)
        if (drift) entry.drift ??= drift
        return { requested: result.requested, acknowledged: result.acknowledged }
      } catch {
        const drift = currentDrift(root, entry, runtime, entry.ownerFence)
        if (drift) entry.drift ??= drift
        return { requested: false, acknowledged: false }
      }
    })()
    return entry.cancelPromise
  }

  async function dispatch(input: NativeSkillOptDispatchInput): Promise<NativeSkillOptDispatchResult> {
    const request = checkedRequest(input)
    if (executions.has(request.requestId)) brokerFail("dispatch_not_authorized")
    const expectedFence = ownerFence(request.owner)
    const entry: OwnedExecution = {
      runtime,
      controller,
      request,
      requestId: request.requestId,
      reference: Object.freeze({ executionID: request.requestId }),
      launched: false,
      dispatchRecorded: false,
      intentRegistered: false,
      consumed: false,
      cancelRequested: false,
      done: Promise.resolve(),
      resolveDone() {},
      retain: false,
      ownerFence: expectedFence,
    }
    let finish!: () => void
    entry.done = new Promise<void>((resolve) => { finish = resolve })
    entry.resolveDone = finish
    executions.set(request.requestId, entry)
    const signalAbort = () => {
      entry.cancelRequested = true
      void requestCancel(entry)
    }
    request.signal?.addEventListener("abort", signalAbort, { once: true })
    try {
      return await execute(entry, expectedFence)
    } finally {
      request.signal?.removeEventListener("abort", signalAbort)
      entry.resolveDone()
      if (!entry.retain) executions.delete(request.requestId)
    }
  }

  async function cancel(owner: SessionStore, requestId: string): Promise<NativeSkillOptCancelResult> {
    if (!owner || typeof requestId !== "string" || !UUID.test(requestId)) brokerFail("invalid_request")
    const entry = executions.get(requestId)
    if (!entry || entry.request.owner !== owner) brokerFail("not_active")
    entry.cancelRequested = true
    const cancelResult = await requestCancel(entry)
    const drift = currentDrift(root, entry, runtime, entry.ownerFence)
    if (drift) entry.drift ??= drift
    await entry.done
    const settledCancelResult = entry.cancelPromise ? await entry.cancelPromise : cancelResult
    const afterDoneDrift = currentDrift(root, entry, runtime, entry.ownerFence)
    if (afterDoneDrift) entry.drift ??= afterDoneDrift
    if (entry.retain && entry.launched) {
      try {
        const status = await controller.recover(owner, entry.request.reservation.runId)
        const afterRecoveryDrift = currentDrift(root, entry, runtime, entry.ownerFence)
        if (afterRecoveryDrift) entry.drift ??= afterRecoveryDrift
        if (!status.pendingDispatch) {
          if (entry.claim && releaseClaim(entry.claim, runtime)) {
            executions.delete(requestId)
            entry.retain = false
          }
        }
      } catch { /* A missing live handle or nonquiescent process remains unresolved. */ }
    }
    return Object.freeze({
      requestId,
      state: entry.retain ? "unresolved" : "settled",
      requested: settledCancelResult.requested,
      acknowledged: settledCancelResult.acknowledged,
    })
  }

  async function recover(owner: SessionStore, runId: string): Promise<SkillOptControllerStatus> {
    if (!owner || typeof runId !== "string" || !UUID.test(runId)) brokerFail("invalid_request")
    let status: SkillOptControllerStatus
    try { status = await controller.recover(owner, runId) }
    catch (error) { throw fixedControllerError(error) }
    const entry = [...executions.values()].find((candidate) => candidate.request.owner === owner && candidate.request.reservation.runId === runId)
    if (entry) {
      const drift = currentDrift(root, entry, runtime, entry.ownerFence)
      if (drift) entry.drift ??= drift
      if (!status.pendingDispatch && entry.claim) {
        if (releaseClaim(entry.claim, runtime)) {
          entry.retain = false
          executions.delete(entry.requestId)
        }
      }
    }
    return status
  }

  const broker = Object.freeze({
    controller,
    dispatch,
    loadCanary(input: Parameters<NativeSkillOptBroker["loadCanary"]>[0]) { return runNativeSkillOptLoadCanary({ ...input, controller }) },
    loadRollbackCanary(input: Parameters<NativeSkillOptBroker["loadRollbackCanary"]>[0]) {
      return runNativeSkillOptRollbackCanary({ ...input, controller })
    },
    cancel,
    recover,
  })
  brokerWorktrees.set(broker, root)
  return broker
}

function releaseClaim(claim: ExecutionClaim, runtime: ExecutionRuntime): boolean {
  try {
    runtime.runs.assertQuiescent(claim)
    runtime.runs.release(claim)
    return true
  } catch { return false }
}
