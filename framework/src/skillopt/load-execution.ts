import { randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Terminal } from "../hosts/interactive-session.ts"
import { createCliRuntime } from "../hosts/cli-runtime.ts"
import {
  assertPreparedHostReference, ExecutionRunBusyError, ExecutionRunCorruptError, ExecutionRunUnresolvedError,
  settled, type ExecutionClaim,
} from "../hosts/run-state.ts"
import type { ExecutionOutcome, ExecutionReference, ExecutionReconciliation, ExecutionRuntime } from "../hosts/types.ts"
import { attachAdmission } from "../sessions/admission.ts"
import type { SessionStore } from "../sessions/store.ts"
import { SkillAdmissionError, SkillSession } from "../skills/session.ts"
import { resolveSkillRoots } from "../skills/roots.ts"
import { bindSkillInvocation } from "../skills/context.ts"
import { registerNativeSkillLoadWitness, prepareNativeSkillLoadCanary, completeNativeSkillLoadWitness,
  NativeLoadVerificationError } from "./load-verification.ts"
import {
  recordNativeRollbackLoadVerification,
  recordNativeLoadVerification,
  verifyNativeRollbackCanaryHandoff,
  verifyNativePromotionCanaryHandoff,
  type NativeRollbackCanaryHandoff,
  type NativePromotionCanaryHandoff,
  type PromotionCommon,
  type PromotionEvidence,
  type PromotionResult,
} from "./promotion.ts"
import { SKILLOPT_CONTROLLER_LIMITS, SkillOptControllerError, type SkillOptController, type SkillOptCurrentBinding,
  type SkillOptCanaryPreparation, type SkillOptControllerStatus, type SkillOptReservation,
  type SkillOptRollbackCanaryPreparation, type SkillOptRollbackIntent } from "./controller.ts"
import { PILOT_LIMITS, readBoundedSource, sha256 } from "./pilot.ts"

const SKILL_PATH = ".agents/skills/llm-wiki/SKILL.md"
const EXECUTION_EVIDENCE = "native SkillOpt loader canary reached terminal-quiescent state"
const NO_DISPATCH_EVIDENCE = "native SkillOpt loader canary was prepared but not dispatched"
const UNKNOWN_EVIDENCE = "native SkillOpt loader canary ownership remains unresolved"
type NativeCanaryPhase = "preflight" | "promotion-handoff" | "controller-canary-preparation" | "live-target-validation" |
  "canary-plan" | "fresh-runtime" | "fresh-policy" | "fresh-host-preflight" | "fresh-loader-admission" |
  "fresh-loader-attachment" | "fresh-loader-roots" | "skill-session-create" | "skill-invocation-prepare" |
  "native-canary-reservation" | "execution-claim" | "execution-intent" | "skill-loader-binding" |
  "canary-dispatch-consumption" | "host-prepare" | "host-run" | "execution-reconciliation" |
  "canary-witness-completion" | "promotion-commit" | "controller-canary-completion"

export type NativeSkillOptLoadCanaryInput = Readonly<{
  controller: SkillOptController
  owner: SessionStore
  runId: string
  current: SkillOptCurrentBinding
  fixtureId: string
  promotion: PromotionCommon & Readonly<{ evidence: PromotionEvidence }>
  terminal: Terminal
  signal: AbortSignal
}>

export type NativeSkillOptLoadCanaryResult = Readonly<{
  status: "COMMITTED" | "FAILED" | "CANCELLED" | "BLOCKED" | "UNRESOLVED"
  runId: string
  requestId?: string
  witnessSha256?: string
  promotion?: PromotionResult
  controllerStatus?: SkillOptControllerStatus
  reasonCode?: string
  phase?: NativeCanaryPhase
  errorCode?: string
}>

export type NativeSkillOptRollbackCanaryInput = Readonly<{
  controller: SkillOptController
  owner: SessionStore
  runId: string
  current: SkillOptCurrentBinding
  fixtureId: string
  intent: SkillOptRollbackIntent
  promotion: PromotionCommon & Readonly<{ evidence: PromotionEvidence }>
  terminal: Terminal
  signal: AbortSignal
}>

export type NativeSkillOptRollbackCanaryResult = Readonly<{
  status: "ROLLED_BACK" | "UNRESOLVED" | "BLOCKED" | "CANCELLED"
  runId: string
  requestId?: string
  witnessSha256?: string
  promotion?: PromotionResult
  controllerStatus?: SkillOptControllerStatus
  reasonCode?: string
  phase?: NativeCanaryPhase
  errorCode?: string
}>

type PreparedLoadCommon = Readonly<{
  runtime: ExecutionRuntime
  store: SessionStore
  skillSession: SkillSession
  skillInvocation: Awaited<ReturnType<SkillSession["prepare"]>>
  plan: ReturnType<typeof prepareNativeSkillLoadCanary>
}>
type PreparedLoad = PreparedLoadCommon & (
  | Readonly<{
      operation: "apply"
      canaryPreparation: SkillOptCanaryPreparation
      handoff: NativePromotionCanaryHandoff
    }>
  | Readonly<{
      operation: "rollback"
      canaryPreparation: SkillOptRollbackCanaryPreparation
      handoff: NativeRollbackCanaryHandoff
    }>
)
type UnresolvedNativeCanary = Readonly<{
  runtime: ExecutionRuntime
  store: SessionStore
  skillSession: SkillSession
  claim: ExecutionClaim
  handle?: Awaited<ReturnType<ExecutionRuntime["host"]["prepare"]>>
}>
const unresolvedNativeCanaries = new Map<string, UnresolvedNativeCanary>()

function retainUnresolved(requestId: string, prepared: PreparedLoad, claim: ExecutionClaim,
  handle?: Awaited<ReturnType<ExecutionRuntime["host"]["prepare"]>>): void {
  unresolvedNativeCanaries.set(requestId, Object.freeze({ runtime: prepared.runtime, store: prepared.store,
    skillSession: prepared.skillSession, claim, ...(handle ? { handle } : {}) }))
}

function openPromotionRunDirectory(promotion: PromotionCommon): { directory: string; fd: number } {
  const root = realpathSync.native(resolve(promotion.transactionRoot))
  if (root !== resolve(promotion.transactionRoot)) throw new Error("promotion transaction root is not canonical")
  const directory = join(root, promotion.bindings.runId)
  const stat = lstatSync(directory, { bigint: true })
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077n) !== 0n) {
    throw new Error("promotion run directory identity is unsafe")
  }
  const fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  const opened = fstatSync(fd, { bigint: true })
  if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
    closeSync(fd)
    throw new Error("promotion run directory changed")
  }
  return { directory, fd }
}

function persistWitness(promotion: PromotionCommon, bytes: Uint8Array, digest: string): Readonly<{ path: string; sha256: string }> {
  if (bytes.byteLength === 0 || !/^[a-f0-9]{64}$/u.test(digest) || sha256(bytes) !== digest) {
    throw new Error("native witness bytes are invalid")
  }
  const { directory, fd: directoryFd } = openPromotionRunDirectory(promotion)
  const path = join(directory, `native-load-canary-${randomUUID()}.json`)
  let fileFd: number | undefined
  try {
    fileFd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(fileFd, Buffer.from(bytes))
    fsyncSync(fileFd)
    const written = fstatSync(fileFd)
    if (!written.isFile() || written.size !== bytes.byteLength || (written.mode & 0o777) !== 0o600) {
      throw new Error("native witness artifact did not persist exactly")
    }
    fsyncSync(directoryFd)
  } finally {
    if (fileFd !== undefined) closeSync(fileFd)
    closeSync(directoryFd)
  }
  return Object.freeze({ path, sha256: digest })
}

type FreshSessionReleaseEvidence = typeof EXECUTION_EVIDENCE | typeof NO_DISPATCH_EVIDENCE

/** @internal Release a fresh loader session only after its dispatch boundary is established. */
export function closeFreshSession(skillSession: SkillSession | undefined, store: SessionStore | undefined,
  evidence: FreshSessionReleaseEvidence): void {
  try { skillSession?.close() } catch { /* Session authority is already invalidated by its lifecycle. */ }
  if (!store || store.isReleased) return
  try {
    store.release({ workflowQuiescent: true, evidence, workflowID: null, revision: null })
  } catch { /* Retain any attachment whose release proof cannot be established. */ }
}

function releaseRunClaim(runtime: ExecutionRuntime, claim: ExecutionClaim): boolean {
  try {
    runtime.runs.assertQuiescent(claim)
    runtime.runs.release(claim)
    return true
  } catch { return false }
}

type NativeCanaryInput = NativeSkillOptLoadCanaryInput | NativeSkillOptRollbackCanaryInput
type NativeCanaryInvocation =
  | Readonly<{ operation: "apply"; input: NativeSkillOptLoadCanaryInput }>
  | Readonly<{ operation: "rollback"; input: NativeSkillOptRollbackCanaryInput }>

function isRollbackInput(input: NativeCanaryInput): input is NativeSkillOptRollbackCanaryInput {
  return "intent" in input
}

function canaryErrorCode(error: unknown): string | undefined {
  const code = error instanceof NativeLoadVerificationError || error instanceof SkillOptControllerError
    ? error.code
    : error instanceof SkillAdmissionError ? "skill_admission_refused"
      : error instanceof ExecutionRunBusyError ? "execution_run_busy"
        : error instanceof ExecutionRunCorruptError ? "execution_run_corrupt"
          : error instanceof ExecutionRunUnresolvedError ? "execution_run_unresolved" : undefined
  return typeof code === "string" && /^[a-z0-9][a-z0-9_-]{0,95}$/iu.test(code) ? code : undefined
}

function rollbackUnresolvedResult(input: NativeSkillOptRollbackCanaryInput, reasonCode: string, requestId?: string,
  phase?: NativeCanaryPhase, errorCode?: string): NativeSkillOptRollbackCanaryResult {
  let controllerStatus: SkillOptControllerStatus | undefined
  try { controllerStatus = input.controller.markNativeRollbackUnresolved(input.owner, input.runId, reasonCode) }
  catch { /* Preserve the rollback quota hold when settlement is uncertain. */ }
  return Object.freeze({ status: "UNRESOLVED", runId: input.runId, ...(requestId ? { requestId } : {}),
    ...(controllerStatus ? { controllerStatus } : {}), reasonCode, ...(phase ? { phase } : {}), ...(errorCode ? { errorCode } : {}) })
}

function terminalResult(input: NativeCanaryInput, status: "FAILED" | "CANCELLED", requestId?: string):
  NativeSkillOptLoadCanaryResult | NativeSkillOptRollbackCanaryResult {
  if (isRollbackInput(input)) return rollbackUnresolvedResult(input,
    status === "CANCELLED" ? "rollback_canary_cancelled" : "rollback_canary_failed", requestId)
  let controllerStatus: SkillOptControllerStatus | undefined
  try { controllerStatus = input.controller.finish(input.owner, input.runId, status) } catch { /* Keep the live run held when settlement is uncertain. */ }
  return Object.freeze({ status, runId: input.runId, ...(requestId ? { requestId } : {}),
    ...(controllerStatus ? { controllerStatus } : {}), reasonCode: status === "CANCELLED" ? "canary_cancelled" : "canary_failed" })
}

function recordNoDispatch(input: {
  controller: SkillOptController
  owner: SessionStore
  runtime: ExecutionRuntime
  claim: ExecutionClaim
  reservation: SkillOptReservation
}): void {
  const records = input.runtime.runs.status().executions.filter(record => record.executionId === input.reservation.requestId)
  const record = records[0]
  if (record && !record.terminal) {
    input.runtime.runs.recordTerminal(input.claim, input.reservation.requestId, {
      outcome: "not-dispatched", terminalAt: Date.now(), quiescentAt: Date.now(),
    })
    input.runtime.runs.reconcile(input.claim, input.reservation.requestId, {
      outcome: "terminal", quiescent: true, evidence: NO_DISPATCH_EVIDENCE,
    })
  }
  input.controller.recordNativeCanaryDispatch({ owner: input.owner, runtime: input.runtime, claim: input.claim,
    receipt: input.reservation.receipt, observation: { state: "not-dispatched" } })
}

function recordAmbiguous(input: {
  controller: SkillOptController
  owner: SessionStore
  runtime: ExecutionRuntime
  claim: ExecutionClaim
  reservation: SkillOptReservation
  reference?: ExecutionReference
}): void {
  try {
    const records = input.runtime.runs.status().executions.filter(record => record.executionId === input.reservation.requestId)
    if (records.length === 1 && !records[0]?.terminal && !records[0]?.reconciliation) {
      input.runtime.runs.reconcile(input.claim, input.reservation.requestId, {
        outcome: "unknown", quiescent: false, evidence: UNKNOWN_EVIDENCE,
      })
    }
    input.runtime.runs.fence(input.claim, input.reservation.requestId, "native SkillOpt canary dispatch is unresolved")
  } catch { /* The durable claim remains fenced or unreleased. */ }
  try {
    input.controller.recordNativeCanaryDispatch({ owner: input.owner, runtime: input.runtime, claim: input.claim,
      receipt: input.reservation.receipt, observation: { state: "ambiguous", ...(input.reference ? { reference: input.reference } : {}) } })
  } catch { /* An uncertain request is never replayed or refunded. */ }
}

async function prepareLoad(input: NativeCanaryInput, setPhase: (phase: NativeCanaryPhase) => void): Promise<PreparedLoad> {
  const promotion: PromotionCommon = {
    targetPath: input.promotion.targetPath,
    transactionRoot: input.promotion.transactionRoot,
    nativeHelperPath: input.promotion.nativeHelperPath,
    nativeHelperSha256: input.promotion.nativeHelperSha256,
    bindings: input.promotion.bindings,
  }
  let handoff: NativePromotionCanaryHandoff | NativeRollbackCanaryHandoff
  let canaryPreparation: SkillOptCanaryPreparation | SkillOptRollbackCanaryPreparation
  setPhase("promotion-handoff")
  if (isRollbackInput(input)) {
    handoff = await verifyNativeRollbackCanaryHandoff({ ...promotion, evidence: input.promotion.evidence })
    setPhase("controller-canary-preparation")
    canaryPreparation = input.controller.prepareNativeRollbackCanary({ owner: input.owner, runId: input.runId,
      current: input.current, intent: input.intent, handoff, promotion })
  } else {
    handoff = await verifyNativePromotionCanaryHandoff({ ...promotion, evidence: input.promotion.evidence })
    setPhase("controller-canary-preparation")
    canaryPreparation = input.controller.prepareNativeCanary(input.owner, input.runId, input.current,
      handoff as NativePromotionCanaryHandoff)
  }
  const root = realpathSync.native(resolve(dirname(input.promotion.targetPath), "../../.."))
  setPhase("live-target-validation")
  const targetBytes = readBoundedSource(root, SKILL_PATH, PILOT_LIMITS.skillBytes)
  const expectedSkillSha256 = isRollbackInput(input)
    ? (canaryPreparation as SkillOptRollbackCanaryPreparation).originalSha256
    : (canaryPreparation as SkillOptCanaryPreparation).candidateSha256
  if (sha256(targetBytes) !== expectedSkillSha256) throw new Error("live skill bytes do not match the approved promotion operation")
  setPhase("canary-plan")
  const plan = prepareNativeSkillLoadCanary({
    fixturePack: input.current.dataset && typeof input.current.dataset === "object" && "fixturePack" in input.current.dataset
      ? input.current.dataset.fixturePack : undefined,
    fixtureId: input.fixtureId,
    approvedFixtureSha256: canaryPreparation.bindings.canaryFixtureSha256,
    targetSkillBytes: targetBytes,
    projectRoot: root,
    bindings: canaryPreparation.bindings,
    operation: isRollbackInput(input) ? "rollback" : "apply",
  })
  const loaderSystemInstructions = `${new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(targetBytes)}\n\n${plan.systemInstructions}`
  setPhase("fresh-runtime")
  const runtime = createCliRuntime({ worktree: root, engine: canaryPreparation.bindings.nativeEngine,
    model: canaryPreparation.bindings.nativeModel, skillLoaderCanaryInstructions: loaderSystemInstructions })
  setPhase("fresh-policy")
  const policy = runtime.policy.resolve("main")
  if (runtime.host.identity.engine !== canaryPreparation.bindings.nativeEngine || policy.role !== "main" || !policy.model ||
      policy.model.providerID !== canaryPreparation.bindings.nativeEngine || policy.model.modelID !== canaryPreparation.bindings.nativeModel ||
      !policy.system.includes(loaderSystemInstructions) ||
      (canaryPreparation.bindings.nativeEngine === "codex"
        ? policy.nativeContext?.identity !== canaryPreparation.bindings.nativeProfileSha256
        : policy.nativeContext !== undefined)) throw new Error("fresh native CLI policy does not match the approved load canary")
  setPhase("fresh-host-preflight")
  const preflight = await runtime.host.preflight(runtime.host.identity.profile)
  if (!preflight.compatible) throw new Error("fresh native CLI host preflight did not pass")
  setPhase("fresh-loader-admission")
  runtime.linuxAdmission?.assertBootEpoch()
  await runtime.linuxAdmission?.admitNewExecution()
  const sessionID = randomUUID()
  let store: SessionStore | undefined
  let skillSession: SkillSession | undefined
  try {
    setPhase("fresh-loader-attachment")
    store = attachAdmission(runtime, sessionID, { engine: canaryPreparation.bindings.nativeEngine, model: canaryPreparation.bindings.nativeModel })
    if (store.restored || store.metadata.engine !== canaryPreparation.bindings.nativeEngine ||
        store.metadata.model !== canaryPreparation.bindings.nativeModel) throw new Error("fresh canary attachment is not a new approved model principal")
    setPhase("fresh-loader-roots")
    const roots = await resolveSkillRoots({ projectRoot: root })
    setPhase("skill-session-create")
    skillSession = await SkillSession.create({ roots, store, terminal: input.terminal }, input.signal)
    setPhase("skill-invocation-prepare")
    const skillInvocation = await skillSession.prepare("llm-wiki", input.signal, { consent: "prompt" })
    const prepared: PreparedLoadCommon = { runtime, store, skillSession, skillInvocation, plan }
    if (isRollbackInput(input)) {
      return Object.freeze({ ...prepared, operation: "rollback" as const,
        canaryPreparation: canaryPreparation as SkillOptRollbackCanaryPreparation,
        handoff: handoff as NativeRollbackCanaryHandoff })
    }
    return Object.freeze({ ...prepared, operation: "apply" as const,
      canaryPreparation: canaryPreparation as SkillOptCanaryPreparation,
      handoff: handoff as NativePromotionCanaryHandoff })
  } catch (error) {
    closeFreshSession(skillSession, store, NO_DISPATCH_EVIDENCE)
    throw error
  }
}

/** Fresh normal-loader CLI execution; one campaign-bound canary ticket is consumed and never replayed. */
export async function runNativeSkillOptLoadCanary(input: NativeSkillOptLoadCanaryInput): Promise<NativeSkillOptLoadCanaryResult> {
  return runNativeCanary({ operation: "apply", input })
}

/** Fresh normal-loader CLI execution against exact restored bytes; failure never reverses or retries rollback. */
export async function runNativeSkillOptRollbackCanary(
  input: NativeSkillOptRollbackCanaryInput,
): Promise<NativeSkillOptRollbackCanaryResult> {
  return runNativeCanary({ operation: "rollback", input })
}

function runNativeCanary(input: Extract<NativeCanaryInvocation, { operation: "apply" }>): Promise<NativeSkillOptLoadCanaryResult>
function runNativeCanary(input: Extract<NativeCanaryInvocation, { operation: "rollback" }>): Promise<NativeSkillOptRollbackCanaryResult>
async function runNativeCanary(invocation: NativeCanaryInvocation): Promise<NativeSkillOptLoadCanaryResult | NativeSkillOptRollbackCanaryResult> {
  const input = invocation.input
  let prepared: PreparedLoad | undefined
  let reservationForCleanup: SkillOptReservation | undefined
  let claim: ExecutionClaim | undefined
  let handle: Awaited<ReturnType<ExecutionRuntime["host"]["prepare"]>> | undefined
  let witnessObservation: ReturnType<typeof registerNativeSkillLoadWitness> | undefined
  let prepareAttempted = false
  let launched = false
  let executionQuiescent = false
  let cancelPromise: Promise<void> | undefined
  let phase: NativeCanaryPhase = "preflight"
  try {
    if (input.signal.aborted) return invocation.operation === "rollback"
      ? rollbackUnresolvedResult(invocation.input, "rollback_canary_cancelled_before_start")
      : Object.freeze({ status: "CANCELLED", runId: input.runId, reasonCode: "canary_cancelled_before_start" })
    prepared = await prepareLoad(input, value => { phase = value })
    if (input.signal.aborted) {
      closeFreshSession(prepared.skillSession, prepared.store, NO_DISPATCH_EVIDENCE)
      return invocation.operation === "rollback"
        ? rollbackUnresolvedResult(invocation.input, "rollback_canary_cancelled_before_reservation")
        : Object.freeze({ status: "CANCELLED", runId: input.runId, reasonCode: "canary_cancelled_before_reservation" })
    }
    phase = "native-canary-reservation"
    const reservation = prepared.operation === "rollback"
      ? input.controller.reserveNativeRollbackCanary({ preparation: prepared.canaryPreparation,
        loaderOwner: prepared.store, loaderRuntime: prepared.runtime, current: input.current })
      : input.controller.reserveNativeCanary({ preparation: prepared.canaryPreparation,
        loaderOwner: prepared.store, loaderRuntime: prepared.runtime, current: input.current })
    reservationForCleanup = reservation
    const runtime = prepared.runtime
    const owner = prepared.store
    const policy = runtime.policy.resolve("main")
    const deadlineAt = Date.now() + SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds
    phase = "execution-claim"
    claim = runtime.runs.claim(owner.sessionID, `skillopt-load-canary-${randomUUID()}`, process.pid)
    const attemptId = randomUUID()
    phase = "execution-intent"
    runtime.runs.registerIntent(claim, {
      executionId: reservation.requestId,
      ownerSession: owner.sessionID,
      taskId: `skillopt:target:canary:${reservation.requestId}`,
      attemptId,
      generation: claim.generation,
      role: "main",
      cwd: realpathSync.native(runtime.worktree),
      policyID: policy.id,
      kind: "host",
      engine: prepared.canaryPreparation.bindings.nativeEngine,
      profile: "legacy-unowned",
      controlProfile: "estimated-input-reactive-output-v1",
      nativeExecution: true,
      nativeLoadCanary: true,
      deadlineAt,
      maxOutputChars: 32 * 1024,
    })
    const requestBase = {
      executionID: reservation.requestId,
      supervisorSessionID: owner.sessionID,
      taskID: `skillopt:target:canary:${reservation.requestId}`,
      attemptID: attemptId,
      generation: claim.generation,
      role: "main" as const,
      title: prepared.operation === "rollback" ? "Native SkillOpt post-rollback load canary" : "Native SkillOpt post-promotion load canary",
      cwd: realpathSync.native(runtime.worktree),
      text: prepared.plan.taskText,
      deadlineAt,
      policy,
    }
    phase = "skill-loader-binding"
    const bound = bindSkillInvocation(prepared.skillInvocation, requestBase, runtime.policy, input.terminal)
    witnessObservation = registerNativeSkillLoadWitness(bound.context, prepared.plan)
    const request = Object.freeze({ ...requestBase, handlers: bound.handlers, skillContext: bound.context })
    phase = "canary-dispatch-consumption"
    input.controller.consumeNativeCanaryDispatch({ owner, runtime, claim, ticket: reservation.ticket, current: input.current })
    prepareAttempted = true
    phase = "host-prepare"
    handle = await runtime.host.prepare(request)
    const reference = handle.reference
    try { assertPreparedHostReference(reference, reservation.requestId) }
    catch {
      recordAmbiguous({ controller: input.controller, owner, runtime, claim, reservation, reference })
      retainUnresolved(reservation.requestId, prepared, claim, handle)
      return Object.freeze({ status: "UNRESOLVED", runId: input.runId, requestId: reservation.requestId, reasonCode: "host_reference_invalid" })
    }
    runtime.runs.bindNativeExecutionRef(claim, reservation.requestId)
    runtime.runs.markHostDispatched(claim, reservation.requestId)
    input.controller.recordNativeCanaryDispatch({ owner, runtime, claim, receipt: reservation.receipt,
      observation: { state: "launched", reference } })
    launched = true
    const executionHandle = handle
    const activeClaim = claim
    const activeReservation = reservation
    const abort = (): void => {
      if (!executionHandle || !activeClaim || !activeReservation || cancelPromise) return
      const requestedAt = Date.now()
      try { runtime.runs.recordCancel(activeClaim, activeReservation.requestId, { requestedAt }) } catch { /* Keep dispatch unresolved. */ }
      cancelPromise = executionHandle.requestCancel("native SkillOpt load canary cancelled", Date.now() + 1000)
        .then(result => {
          if (result.acknowledged) {
            try { runtime.runs.recordCancel(activeClaim, activeReservation.requestId, { requestedAt, acknowledgedAt: Date.now() }) } catch { /* Terminal reconciliation remains authoritative. */ }
          }
        }).catch(() => {})
    }
    input.signal.addEventListener("abort", abort, { once: true })
    if (input.signal.aborted) abort()
    let outcome: ExecutionOutcome | undefined
    let runFailed = false
    phase = "host-run"
    try { outcome = await handle.run() } catch { runFailed = true }
    input.signal.removeEventListener("abort", abort)
    if (cancelPromise) await cancelPromise
    let reconciliation: ExecutionReconciliation
    phase = "execution-reconciliation"
    try { reconciliation = await handle.reconcile() }
    catch { reconciliation = { outcome: "unknown", quiescent: false, evidence: UNKNOWN_EVIDENCE } }
    const terminalAt = Date.now()
    runtime.runs.recordTerminal(claim, reservation.requestId, {
      outcome: runFailed ? "failed" : outcome?.status ?? "unresolved",
      terminalAt,
      ...(reconciliation.outcome === "terminal" && reconciliation.quiescent ? { quiescentAt: terminalAt } : {}),
    })
    runtime.runs.reconcile(claim, reservation.requestId, reconciliation)
    const runRecord = runtime.runs.status().executions.find(record => record.executionId === reservation.requestId)
    if (reconciliation.outcome !== "terminal" || !reconciliation.quiescent || !runRecord || !settled(runRecord)) {
      try { runtime.runs.fence(claim, reservation.requestId, "native SkillOpt canary has no terminal quiescence proof") } catch { /* Keep claim and session attached. */ }
      retainUnresolved(reservation.requestId, prepared, claim, handle)
      return Object.freeze({ status: "UNRESOLVED", runId: input.runId, requestId: reservation.requestId, reasonCode: "canary_quiescence_unresolved" })
    }
    executionQuiescent = true
    input.controller.settleNativeCanary({ owner, runtime, claim, runId: input.runId, requestId: reservation.requestId, reconciliation })
    if (!releaseRunClaim(runtime, claim)) {
      retainUnresolved(reservation.requestId, prepared, claim, handle)
      return Object.freeze({ status: "UNRESOLVED", runId: input.runId, requestId: reservation.requestId, reasonCode: "canary_claim_release_unresolved" })
    }
    claim = undefined
    if (runFailed || !outcome || outcome.status !== "completed") {
      const failedStatus = outcome?.status === "cancelled" ? "CANCELLED" : "FAILED"
      prepared.skillSession.close()
      const result = terminalResult(input, failedStatus, reservation.requestId)
      closeFreshSession(undefined, owner, EXECUTION_EVIDENCE)
      return result
    }
    if (!witnessObservation) throw new Error("native loader witness observation is absent")
    let completed: Awaited<ReturnType<typeof completeNativeSkillLoadWitness>>
    try {
      phase = "canary-witness-completion"
      completed = await completeNativeSkillLoadWitness({ plan: prepared.plan, observation: witnessObservation, hostCompletion: outcome })
    } catch {
      prepared.skillSession.close()
      const result = terminalResult(input, "FAILED", reservation.requestId)
      closeFreshSession(undefined, owner, EXECUTION_EVIDENCE)
      return Object.freeze({ ...result, reasonCode: "canary_qualification_failed" })
    }
    let witness: Readonly<{ path: string; sha256: string }>
    try {
      phase = "promotion-commit"
      if (prepared.operation === "rollback") {
        input.controller.recordNativeRollbackCanaryArtifact(owner, input.runId, completed.bytes.byteLength)
      } else {
        input.controller.recordNativeCanaryArtifact(owner, input.runId, completed.bytes.byteLength)
      }
      witness = persistWitness(input.promotion, completed.bytes, completed.sha256)
    } catch {
      prepared.skillSession.close()
      const result = terminalResult(input, "FAILED", reservation.requestId)
      closeFreshSession(undefined, owner, EXECUTION_EVIDENCE)
      return Object.freeze({ ...result, reasonCode: "canary_artifact_persist_failed" })
    }
    if (invocation.operation === "rollback") {
      if (prepared.operation !== "rollback") throw new Error("rollback request produced an apply preparation")
      const rollbackInput = invocation.input
      let rollback: Awaited<ReturnType<typeof recordNativeRollbackLoadVerification>>
      try {
        phase = "promotion-commit"
        rollback = await recordNativeRollbackLoadVerification({
          targetPath: rollbackInput.promotion.targetPath,
          transactionRoot: rollbackInput.promotion.transactionRoot,
          nativeHelperPath: rollbackInput.promotion.nativeHelperPath,
          nativeHelperSha256: rollbackInput.promotion.nativeHelperSha256,
          bindings: prepared.canaryPreparation.bindings,
          witness,
          proof: completed.proof,
          handoff: prepared.handoff,
        })
      } catch {
        prepared.skillSession.close()
        closeFreshSession(undefined, owner, EXECUTION_EVIDENCE)
        return rollbackUnresolvedResult(rollbackInput, "rollback_commit_unresolved", reservation.requestId)
      }
      if (rollback.state !== "ROLLED_BACK" || !rollback.nativeRollbackCommit) {
        prepared.skillSession.close()
        closeFreshSession(undefined, owner, EXECUTION_EVIDENCE)
        return rollbackUnresolvedResult(rollbackInput, "rollback_commit_not_proven", reservation.requestId)
      }
      let controllerStatus: SkillOptControllerStatus
      try {
        phase = "controller-canary-completion"
        controllerStatus = rollbackInput.controller.completeNativeRollbackCanary({ owner: rollbackInput.owner, loaderOwner: owner,
          runId: rollbackInput.runId, current: rollbackInput.current, commit: rollback.nativeRollbackCommit })
      } catch {
        prepared.skillSession.close()
        closeFreshSession(undefined, owner, EXECUTION_EVIDENCE)
        return Object.freeze({ status: "UNRESOLVED", runId: rollbackInput.runId, requestId: reservation.requestId,
          witnessSha256: witness.sha256, promotion: rollback, reasonCode: "controller_rollback_commit_unresolved" })
      }
      prepared.skillSession.close()
      closeFreshSession(undefined, owner, EXECUTION_EVIDENCE)
      return Object.freeze({ status: "ROLLED_BACK", runId: rollbackInput.runId, requestId: reservation.requestId,
        witnessSha256: witness.sha256, promotion: rollback, controllerStatus })
    }
    if (prepared.operation !== "apply") throw new Error("apply request produced a rollback preparation")
    let promotion: Awaited<ReturnType<typeof recordNativeLoadVerification>>
    try {
      phase = "promotion-commit"
      promotion = await recordNativeLoadVerification({
        targetPath: input.promotion.targetPath,
        transactionRoot: input.promotion.transactionRoot,
        nativeHelperPath: input.promotion.nativeHelperPath,
        nativeHelperSha256: input.promotion.nativeHelperSha256,
        bindings: prepared.canaryPreparation.bindings,
        witness,
        proof: completed.proof,
        handoff: prepared.handoff,
      })
    } catch {
      prepared.skillSession.close()
      closeFreshSession(undefined, owner, EXECUTION_EVIDENCE)
      return Object.freeze({ status: "UNRESOLVED", runId: input.runId, requestId: reservation.requestId,
        witnessSha256: witness.sha256, reasonCode: "promotion_commit_unresolved" })
    }
    if (promotion.state !== "COMMITTED" || !promotion.nativeCommit) {
      prepared.skillSession.close()
      const result = terminalResult(input, "FAILED", reservation.requestId)
      closeFreshSession(undefined, owner, EXECUTION_EVIDENCE)
      return Object.freeze({ ...result, promotion })
    }
    let controllerStatus: SkillOptControllerStatus
    try {
      phase = "controller-canary-completion"
      controllerStatus = input.controller.completeNativeCanary({ owner: input.owner, loaderOwner: owner,
        runId: input.runId, current: input.current, commit: promotion.nativeCommit })
    } catch {
      prepared.skillSession.close()
      closeFreshSession(undefined, owner, EXECUTION_EVIDENCE)
      return Object.freeze({ status: "UNRESOLVED", runId: input.runId, requestId: reservation.requestId,
        witnessSha256: witness.sha256, promotion, reasonCode: "controller_commit_unresolved" })
    }
    prepared.skillSession.close()
    closeFreshSession(undefined, owner, EXECUTION_EVIDENCE)
    return Object.freeze({ status: "COMMITTED", runId: input.runId, requestId: reservation.requestId,
      witnessSha256: witness.sha256, promotion, controllerStatus })
  } catch (error) {
    const errorCode = canaryErrorCode(error)
    if (reservationForCleanup && prepared && claim && !launched && !prepareAttempted) {
      try {
        recordNoDispatch({ controller: input.controller, owner: prepared.store, runtime: prepared.runtime, claim, reservation: reservationForCleanup })
        if (releaseRunClaim(prepared.runtime, claim)) {
          claim = undefined
          closeFreshSession(prepared.skillSession, prepared.store, NO_DISPATCH_EVIDENCE)
          return invocation.operation === "rollback"
            ? rollbackUnresolvedResult(invocation.input, "rollback_canary_not_dispatched", reservationForCleanup.requestId,
              phase, errorCode)
            : Object.freeze({ status: "CANCELLED", runId: input.runId, requestId: reservationForCleanup.requestId,
              reasonCode: "canary_not_dispatched", phase, ...(errorCode ? { errorCode } : {}) })
        }
      } catch { /* Preserve the unresolved claim and charged reservation. */ }
    }
    if (reservationForCleanup && prepared && claim && prepareAttempted && !launched) {
      recordAmbiguous({ controller: input.controller, owner: prepared.store, runtime: prepared.runtime, claim, reservation: reservationForCleanup,
        ...(handle ? { reference: handle.reference } : {}) })
      retainUnresolved(reservationForCleanup.requestId, prepared, claim, handle)
      return Object.freeze({ status: "UNRESOLVED", runId: input.runId, requestId: reservationForCleanup.requestId,
        reasonCode: "canary_preparation_unresolved" })
    }
    if (reservationForCleanup && prepared && claim && launched) {
      recordAmbiguous({ controller: input.controller, owner: prepared.store, runtime: prepared.runtime, claim, reservation: reservationForCleanup,
        ...(handle ? { reference: handle.reference } : {}) })
      retainUnresolved(reservationForCleanup.requestId, prepared, claim, handle)
      return Object.freeze({ status: "UNRESOLVED", runId: input.runId, requestId: reservationForCleanup.requestId,
        reasonCode: "canary_execution_unresolved" })
    }
    if (reservationForCleanup && prepared && !claim) {
      try {
        input.controller.cancelNativeCanaryBeforeClaim({ owner: input.owner, loaderOwner: prepared.store,
          reservation: reservationForCleanup, current: input.current })
        prepared.skillSession.close()
        closeFreshSession(undefined, prepared.store,
          executionQuiescent ? EXECUTION_EVIDENCE : NO_DISPATCH_EVIDENCE)
        return invocation.operation === "rollback"
          ? rollbackUnresolvedResult(invocation.input, "rollback_canary_claim_not_acquired", reservationForCleanup.requestId)
          : Object.freeze({ status: "CANCELLED", runId: input.runId, requestId: reservationForCleanup.requestId,
            reasonCode: "canary_claim_not_acquired" })
      } catch {
        return Object.freeze({ status: "UNRESOLVED", runId: input.runId, requestId: reservationForCleanup.requestId,
          reasonCode: executionQuiescent ? "canary_claim_state_unresolved" : "canary_claim_unresolved" })
      }
    }
    if (reservationForCleanup && prepared && claim && !launched && !prepareAttempted) {
      return Object.freeze({ status: "UNRESOLVED", runId: input.runId, requestId: reservationForCleanup.requestId,
        reasonCode: "canary_claim_unresolved" })
    }
    if (prepared && !reservationForCleanup) closeFreshSession(prepared.skillSession, prepared.store, NO_DISPATCH_EVIDENCE)
    if (invocation.operation === "rollback") return rollbackUnresolvedResult(invocation.input,
      error instanceof Error && error.name === "AbortError" ? "rollback_canary_cancelled" : "rollback_canary_bridge_refused",
      reservationForCleanup?.requestId, phase, errorCode)
    return Object.freeze({ status: input.signal.aborted ? "CANCELLED" : "BLOCKED", runId: input.runId,
      ...(reservationForCleanup ? { requestId: reservationForCleanup.requestId } : {}),
      reasonCode: error instanceof Error && error.name === "AbortError" ? "canary_cancelled" : "canary_bridge_refused",
      phase, ...(errorCode ? { errorCode } : {}) })
  }
}
