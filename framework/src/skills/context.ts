import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import type { Terminal } from "../hosts/interactive-session.ts"
import type { CliNativeIdentity, CliTransportHandle } from "../hosts/cli-transport.ts"
import type { ExecutionDecision, ExecutionEvent, ExecutionPolicy, ExecutionPolicyHandlers, ExecutionReconciliation, ExecutionRequest } from "../hosts/types.ts"
import { EXECUTION_ROLES, EXECUTION_TOOL_NAMES } from "../hosts/types.ts"
import { getOwnedSession } from "../sessions/store.ts"
import {
  consumeSkillPermissionPermit, createSkillHoldTicket, foregroundSkillInvocationID,
  registerForegroundSkillInvocation, revokeForegroundSkillInvocation, skillArgumentDigest,
  type ForegroundSkillInvocation, type SkillPermissionPermit,
} from "./broker.ts"
import { isAuthenticSkillCapture, readCapturedSkill } from "./capture.ts"
import { claimPreparedSkillInvocation, SkillAdmissionError, type PreparedSkillInvocation } from "./session.ts"
import { FdTree, type FdStat } from "./fd-tree.ts"
import { openSkillRoot, skillDirectoryPath } from "./roots.ts"
import { readCapturedSkillResource } from "./resources.ts"
import type { SkillCapture, SkillToolName } from "./types.ts"

type Scope = Omit<ExecutionRequest, "handlers" | "skillContext">
type ToolBefore = Extract<ExecutionEvent, { type: "tool-before" }>
declare const skillContextBrand: unique symbol
export type SkillInvocationContext = Readonly<{
  supervisorSessionID: string
  attachmentEpoch: string
  canonicalSource: string
  name: string
  contentHash: string
  allowedTools: readonly SkillToolName[]
  invocationID: string
  capture: SkillCapture
  [skillContextBrand]: never
}>

declare const skillLoaderWitnessBrand: unique symbol
export type SkillLoaderWitnessObservation = Readonly<{ [skillLoaderWitnessBrand]: never }>
export type SkillLoaderCanaryBinding = Readonly<{
  fixturePackSha256: string
  fixtureId: string
  fixtureSha256: string
  taskSha256: string
  evaluatorPromptSha256: string
  evaluatorSystemSha256: string
  protocolSha256: string
  evaluatorSha256: string
}>
export type SkillLoaderWitnessReceipt = Readonly<{
  version: "native-v1"
  loaderDelivery: "observed"
  behavioralCanary: "not-evaluated"
  projectRootSha256: string
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
  instructions: Readonly<{
    utf8Sha256: string
    utf8Bytes: number
    promptSha256: string
    promptBytes: number
    span: Readonly<{
      startByte: number
      endByte: number
      sha256: string
      basis: "exact-captured-instruction-utf8-substring-v1"
    }>
    evaluatorSystem: Readonly<{
      utf8Sha256: string
      utf8Bytes: number
      startByte: number
      endByte: number
      basis: "exact-code-owned-evaluator-utf8-substring-v1"
    }>
  }>
  requestTextSha256: string
  response: Readonly<{ sha256: string; bytes: number }>
  canary: SkillLoaderCanaryBinding
  evaluatorSystemInstructions: string
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
  invocation: Readonly<{
    sessionID: string
    attachmentEpoch: string
    executionID: string
    taskID: string
    attemptID: string
    generation: number
    role: "main"
    invocationID: string
  }>
  native: Readonly<{
    engine: "codex" | "claude"
    requestedModel: string
    runtimeIdentity: CliNativeIdentity["runtimeIdentity"]
    profileIdentity: CliNativeIdentity["profileIdentity"]
    identityBefore: CliNativeIdentity
    identityAfter: CliNativeIdentity
    identityStable: true
    status: "completed"
    quiescent: true
    reconciliation: "terminal-quiescent"
  }>
}>

type Source = ReturnType<typeof claimPreparedSkillInvocation>
type CallState = {
  event: ToolBefore
  callID: string
  tool: string
  digest: string
  validate: () => boolean
  observed: boolean
  baseAllowed: boolean
  effectReady: boolean
  consumed: boolean
  snapshotRead: boolean
}
type ContextState = {
  active: boolean
  source: Source
  context: SkillInvocationContext
  scope: Readonly<Scope>
  policy: ExecutionPolicy
  foreground?: ForegroundSkillInvocation
  cancel: AbortController
  unregister: () => void
  calls: Map<string, CallState>
  seenCalls: Set<string>
  beforeTool: ExecutionPolicyHandlers["beforeTool"]
  witness?: WitnessState
}
type StableSkillIdentity = Readonly<{
  projectRootSha256: string
  fileIdentitySha256: string
  root: readonly string[]
  agents: readonly string[]
  skills: readonly string[]
  skill: readonly string[]
  file: readonly string[]
}>
type WitnessTransport = CliTransportHandle & { inspectIdentity?: () => Promise<CliNativeIdentity | undefined> }
type WitnessState = {
  contextState: ContextState
  observation: SkillLoaderWitnessObservation
  canary: SkillLoaderCanaryBinding
  evaluatorSystemInstructions: string
  phase: "registered" | "started" | "finishing" | "complete" | "consuming" | "consumed" | "refused"
  beginAttempted: boolean
  transport?: WitnessTransport
  identityBefore?: CliNativeIdentity
  stableBefore?: StableSkillIdentity
  prompt?: Readonly<{
    sha256: string; bytes: number; startByte: number; endByte: number; instructionsSha256: string; instructionsBytes: number
    evaluatorSystemSha256: string; evaluatorSystemBytes: number; evaluatorSystemStartByte: number; evaluatorSystemEndByte: number
  }>
  receipt?: SkillLoaderWitnessReceipt
  consumed: boolean
}
const contexts = new WeakMap<object, ContextState>()
const boundaries = new WeakMap<ExecutionPolicyHandlers["beforeTool"], ContextState>()
const loaderWitnesses = new WeakMap<object, WitnessState>()

const WITNESS_SKILL_IDENTITY = "project:.agents/skills/llm-wiki" as const
const WITNESS_SKILL_PATH = ".agents/skills/llm-wiki/SKILL.md" as const

function refuse(message: string): never { throw new SkillAdmissionError(message) }
function current(state: ContextState): boolean {
  return state.active && !state.cancel.signal.aborted && Date.now() < state.scope.deadlineAt &&
    state.source.session.authorizes(state.source.capture, state.source.lease, state.source.revision) &&
    state.policy.resolve(state.scope.role) === state.scope.policy
}
function scopeMatches(state: ContextState, request: Scope): boolean {
  const scope = state.scope
  return request.supervisorSessionID === scope.supervisorSessionID && request.executionID === scope.executionID &&
    request.taskID === scope.taskID && request.attemptID === scope.attemptID && request.generation === scope.generation &&
    request.cwd === scope.cwd && request.role === scope.role && request.policy === scope.policy && request.deadlineAt === scope.deadlineAt
}
function policyToolName(name: string): string { return name === "multiedit" ? "edit" : name }
function callMatches(state: ContextState, call: CallState, event = call.event): boolean {
  const tupleMatches = () => current(state) && !call.consumed && event.type === "tool-before" && event.sessionID === state.scope.executionID &&
    event.callID === call.callID && event.name === call.tool && skillArgumentDigest(event.input) === call.digest &&
    state.scope.policy.tools.allowed.includes(policyToolName(event.name)) && !state.scope.policy.tools.denied.includes(policyToolName(event.name))
  return tupleMatches() && call.validate() === true && tupleMatches()
}
function callFor(state: ContextState, event: ToolBefore): CallState {
  const call = state.calls.get(event.callID)
  if (!call || !callMatches(state, call, event)) return refuse("Skill tool call has no current exact-call proof.")
  return call
}

function hashUtf8(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key)) && keys.every(key => expected.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function boundedIdentityString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
}

function nativeIdentity(value: unknown, engine: "codex" | "claude", model: string, codexProfileSha256?: string): CliNativeIdentity {
  if (!isRecord(value) || !exactKeys(value, ["engine", "requestedModel", "runtimeIdentity", "profileIdentity"]) ||
      value.engine !== engine || value.requestedModel !== model ||
      !isRecord(value.runtimeIdentity) || !exactKeys(value.runtimeIdentity, ["version", "executableSha256"]) ||
      !boundedIdentityString(value.runtimeIdentity.version, 256) ||
      typeof value.runtimeIdentity.executableSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.runtimeIdentity.executableSha256) ||
      !isRecord(value.profileIdentity) || !exactKeys(value.profileIdentity, ["id", "sha256"]) ||
      !boundedIdentityString(value.profileIdentity.id, 128) ||
      typeof value.profileIdentity.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.profileIdentity.sha256)) {
    return refuse("native runtime identity verification failed")
  }
  const expectedProfile = engine === "codex" ? "codex-restricted-read.v1" : "claude-native-no-tools.v1"
  if (value.profileIdentity.id !== expectedProfile ||
      (engine === "codex" && (!codexProfileSha256 || value.profileIdentity.sha256 !== codexProfileSha256))) {
    return refuse("native runtime identity verification failed")
  }
  return Object.freeze({
    engine,
    requestedModel: model,
    runtimeIdentity: Object.freeze({
      version: value.runtimeIdentity.version,
      executableSha256: value.runtimeIdentity.executableSha256,
    }),
    profileIdentity: Object.freeze({ id: value.profileIdentity.id, sha256: value.profileIdentity.sha256 }),
  })
}

async function inspectNativeIdentity(
  transport: WitnessTransport,
  engine: "codex" | "claude",
  model: string,
  codexProfileSha256?: string,
): Promise<CliNativeIdentity> {
  try {
    if (typeof transport.inspectIdentity !== "function") return refuse("native runtime identity verification failed")
    return nativeIdentity(await transport.inspectIdentity(), engine, model, codexProfileSha256)
  } catch {
    return refuse("native runtime identity verification failed")
  }
}

function sameNativeIdentity(left: CliNativeIdentity, right: CliNativeIdentity): boolean {
  return left.engine === right.engine && left.requestedModel === right.requestedModel &&
    left.runtimeIdentity.version === right.runtimeIdentity.version &&
    left.runtimeIdentity.executableSha256 === right.runtimeIdentity.executableSha256 &&
    left.profileIdentity.id === right.profileIdentity.id && left.profileIdentity.sha256 === right.profileIdentity.sha256
}

function witnessTargetCapture(state: ContextState): Readonly<{ fileSha256: string; fileBytes: number }> {
  const capture = state.source.capture
  if (!isAuthenticSkillCapture(capture) || capture.source !== "project" || capture.name !== "llm-wiki" ||
      capture.descriptor.kind !== "skill" || capture.descriptor.source !== "project" ||
      capture.descriptor.identity !== WITNESS_SKILL_IDENTITY || capture.identity !== WITNESS_SKILL_IDENTITY ||
      !/^[a-f0-9]{64}$/u.test(capture.contentHash)) {
    return refuse("Fresh loader witness requires the exact project llm-wiki capture.")
  }
  const rootEntry = capture.entries.find(entry => entry.path === ".")
  const skillEntry = capture.entries.find(entry => entry.path === "SKILL.md")
  const file = capture.files.find(entry => entry.path === "SKILL.md")
  if (!file || file.size > 1024 * 1024) return refuse("Captured llm-wiki instructions exceed the witness prompt bound.")
  const bytes = readCapturedSkill(capture)
  if (!rootEntry || rootEntry.type !== "directory" || !skillEntry || skillEntry.type !== "file" ||
      !bytes || file.size !== bytes.byteLength || skillEntry.size !== bytes.byteLength ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) || file.sha256 !== hashUtf8(bytes)) {
    return refuse("Captured llm-wiki instructions are not one exact regular-file snapshot.")
  }
  return Object.freeze({ fileSha256: file.sha256, fileBytes: file.size })
}

function fdStatIdentity(stat: FdStat): readonly string[] {
  return Object.freeze([
    stat.dev.toString(), stat.ino.toString(), String(stat.mode), stat.nlink.toString(), stat.size.toString(),
    stat.mtimeNs.toString(), stat.ctimeNs.toString(),
  ])
}

function stableSkillIdentity(state: ContextState): StableSkillIdentity {
  const capture = state.source.capture
  const expected = readCapturedSkill(capture)
  const file = capture.files.find(entry => entry.path === "SKILL.md")
  if (!expected || !file) return refuse("Captured llm-wiki bytes are unavailable.")
  const roots = state.source.session.roots
  let projectRoot: string
  let requestRoot: string
  try {
    projectRoot = realpathSync.native(roots.projectRoot)
    requestRoot = realpathSync.native(state.scope.cwd)
  }
  catch { return refuse("Canonical project root is unavailable for loader witness.") }
  const expectedDirectory = resolve(projectRoot, ".agents/skills/llm-wiki")
  if (projectRoot !== roots.projectRoot || requestRoot !== projectRoot || state.context.canonicalSource !== expectedDirectory) {
    return refuse("Loader witness source is not the canonical project-root skill path.")
  }
  let tree: FdTree | undefined
  try {
    tree = openSkillRoot(roots, "project")
    if (!tree) return refuse("Pinned project root is unavailable for loader witness.")
    const agents = tree.openDirectoryRelative(".agents")
    const skills = tree.openDirectoryAt(agents, "skills")
    const skill = tree.openDirectoryAt(skills, "llm-wiki")
    const currentFile = tree.readFileAt(skill, "SKILL.md")
    const bytes = Buffer.from(expected)
    if (!currentFile.bytes.equals(bytes) || currentFile.stat.nlink !== 1n ||
        currentFile.stat.size !== BigInt(file.size) || (currentFile.stat.mode & 0o7777) !== file.mode ||
        hashUtf8(currentFile.bytes) !== file.sha256) {
      return refuse("Current llm-wiki file does not match the captured bytes and metadata.")
    }
    tree.assertStable()
    const rootSha256 = hashUtf8(projectRoot)
    const rootIdentity = fdStatIdentity(tree.root.openedStat)
    const agentsIdentity = fdStatIdentity(agents.openedStat)
    const skillsIdentity = fdStatIdentity(skills.openedStat)
    const skillIdentity = fdStatIdentity(skill.openedStat)
    const fileIdentity = fdStatIdentity(currentFile.stat)
    const identitySha256 = hashUtf8(JSON.stringify({
      version: "fd-tree-openat-fstat-and-captured-bytes-v1",
      projectRootSha256: rootSha256,
      root: rootIdentity,
      agents: agentsIdentity,
      skills: skillsIdentity,
      skill: skillIdentity,
      file: fileIdentity,
      skillFileSha256: file.sha256,
      manifestSha256: capture.contentHash,
    }))
    return Object.freeze({
      projectRootSha256: rootSha256, fileIdentitySha256: identitySha256,
      root: rootIdentity, agents: agentsIdentity, skills: skillsIdentity, skill: skillIdentity, file: fileIdentity,
    })
  } catch {
    return refuse("Stable FD-based llm-wiki source identity could not be verified.")
  } finally {
    tree?.close()
  }
}

function promptWitness(state: ContextState, prompt: string): NonNullable<WitnessState["prompt"]> {
  const promptLength = Buffer.byteLength(prompt, "utf8")
  const instructionLength = Buffer.byteLength(state.source.text, "utf8")
  if (promptLength > 64 * 1024 || instructionLength > 16 * 1024) {
    return refuse("Final prompt exceeds the native witness byte bound.")
  }
  const captured = readCapturedSkill(state.source.capture)
  const textBytes = Buffer.from(state.source.text, "utf8")
  if (!captured || !textBytes.equals(Buffer.from(captured))) {
    return refuse("Final prompt does not preserve the captured skill instructions as exact UTF-8.")
  }
  const first = prompt.indexOf(state.source.text)
  if (first < 0 || prompt.indexOf(state.source.text, first + 1) >= 0) {
    return refuse("Final prompt must contain one complete, unique skill instruction span.")
  }
  const promptBytes = Buffer.from(prompt, "utf8")
  if (promptBytes.toString("utf8") !== prompt) return refuse("Final prompt is not well-formed UTF-8 text.")
  const startByte = Buffer.byteLength(prompt.slice(0, first), "utf8")
  const endByte = startByte + textBytes.byteLength
  if (!promptBytes.subarray(startByte, endByte).equals(textBytes)) {
    return refuse("Final prompt skill span is transformed or truncated.")
  }
  const evaluatorSystemInstructions = state.witness?.evaluatorSystemInstructions
  if (!evaluatorSystemInstructions) return refuse("Code-owned canary evaluation instructions are not registered.")
  const evaluatorBytes = Buffer.from(evaluatorSystemInstructions, "utf8")
  const evaluatorFirst = prompt.indexOf(evaluatorSystemInstructions)
  if (evaluatorFirst < 0 || prompt.indexOf(evaluatorSystemInstructions, evaluatorFirst + 1) >= 0) {
    return refuse("Final prompt must contain one complete, unique canary evaluator instruction span.")
  }
  const evaluatorStartByte = Buffer.byteLength(prompt.slice(0, evaluatorFirst), "utf8")
  const evaluatorEndByte = evaluatorStartByte + evaluatorBytes.byteLength
  if (evaluatorStartByte < endByte) {
    return refuse("Final prompt canary evaluator instructions must follow the captured skill span.")
  }
  if (!promptBytes.subarray(evaluatorStartByte, evaluatorEndByte).equals(evaluatorBytes)) {
    return refuse("Final prompt canary evaluator instructions are transformed or truncated.")
  }
  return Object.freeze({
    sha256: hashUtf8(promptBytes), bytes: promptBytes.byteLength, startByte, endByte,
    instructionsSha256: hashUtf8(textBytes), instructionsBytes: textBytes.byteLength,
    evaluatorSystemSha256: hashUtf8(evaluatorBytes), evaluatorSystemBytes: evaluatorBytes.byteLength,
    evaluatorSystemStartByte: evaluatorStartByte, evaluatorSystemEndByte: evaluatorEndByte,
  })
}

function witnessAuthorityCurrent(state: ContextState): boolean {
  try {
    const session = state.source.session
    return Date.now() < state.scope.deadlineAt && getOwnedSession(session.roots.projectRoot, session.store.sessionID) === session.store &&
      session.authorizes(state.source.capture, state.source.lease, state.source.revision) &&
      state.policy.resolve(state.scope.role) === state.scope.policy
  } catch { return false }
}

/** Register one opt-in observer for an authentic normal-loader context; no permission or trust is granted. */
export function registerSkillLoaderWitness(
  context: SkillInvocationContext,
  canary: SkillLoaderCanaryBinding,
  evaluatorSystemInstructions: string,
): SkillLoaderWitnessObservation {
  const value: unknown = context
  const state = value && typeof value === "object" ? contexts.get(value) : undefined
  if (!state || !current(state) || state.witness) return refuse("Loader witness registration requires one current authentic skill context.")
  if (!state.source.freshWitnessInvocation || state.source.session.store.restored || state.scope.role !== "main" ||
      (state.scope.planSkills?.length ?? 0) > 0 || state.scope.actionGate !== undefined || state.scope.skillTool !== undefined) {
    return refuse("Loader witness requires a new owned session's first skill preparation and a tool-free main request.")
  }
  if (![state.scope.supervisorSessionID, state.source.session.store.epoch, state.scope.executionID,
    state.scope.taskID, state.scope.attemptID, state.context.invocationID].every(value => boundedIdentityString(value, 256)) ||
      !Number.isSafeInteger(state.scope.generation) || state.scope.generation < 1) {
    return refuse("Loader witness request identity is not bounded and canonical.")
  }
  if (!isRecord(canary) || !exactKeys(canary, [
    "fixturePackSha256", "fixtureId", "fixtureSha256", "taskSha256", "evaluatorPromptSha256", "evaluatorSystemSha256", "protocolSha256", "evaluatorSha256",
  ]) || !boundedIdentityString(canary.fixtureId, 128) ||
      ![canary.fixturePackSha256, canary.fixtureSha256, canary.taskSha256, canary.evaluatorPromptSha256,
        canary.evaluatorSystemSha256, canary.protocolSha256, canary.evaluatorSha256].every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) ||
      canary.taskSha256 !== hashUtf8(state.scope.text) || typeof evaluatorSystemInstructions !== "string" ||
      Buffer.byteLength(evaluatorSystemInstructions, "utf8") > 8 * 1024 ||
      hashUtf8(evaluatorSystemInstructions) !== canary.evaluatorSystemSha256 ||
      !state.scope.policy.system.join("\n\n").includes(evaluatorSystemInstructions)) {
    return refuse("Loader witness canary task binding is invalid or differs from the authentic request.")
  }
  witnessTargetCapture(state)
  const observation = Object.freeze({}) as unknown as SkillLoaderWitnessObservation
  const witness: WitnessState = {
    contextState: state, observation, canary: Object.freeze({ ...canary }), evaluatorSystemInstructions,
    phase: "registered", beginAttempted: false, consumed: false,
  }
  state.witness = witness
  loaderWitnesses.set(observation, witness)
  return observation
}

/** Internal CLI-host gate. Unregistered executions return undefined without transport inspection or behavior changes. */
export async function beginSkillLoaderWitness(
  request: ExecutionRequest,
  input: Readonly<{
    prompt: string
    engine: "local" | "codex" | "claude"
    model: string
    codexProfileSha256?: string
    transport: WitnessTransport
  }>,
): Promise<SkillLoaderWitnessObservation | undefined> {
  const state = stateFor(request)
  if (!state?.witness) return undefined
  const witness = state.witness
  if (witness.phase !== "registered" || witness.beginAttempted) {
    if (witness.phase === "registered") witness.phase = "refused"
    return refuse("Loader witness is one-use and cannot be replayed or dispatched twice.")
  }
  witness.beginAttempted = true
  try {
    if (!current(state) || state.scope.role !== "main") return refuse("Loader witness context or role is no longer current.")
    if (input.engine === "local") return refuse("Local engines are not eligible for a fresh native loader witness.")
    if (!boundedIdentityString(input.model, 256) || !input.transport || typeof input.transport.inspectIdentity !== "function") {
      return refuse("native runtime identity verification failed")
    }
    const metadata = state.source.session.store.metadata
    const sessionRoute = metadata.routes?.[state.scope.role] ?? { engine: metadata.engine, model: metadata.model }
    const policyModel = state.scope.policy.model
    const codexProfileMatches = input.engine !== "codex" ||
      state.scope.policy.nativeContext?.identity === input.codexProfileSha256
    if (!policyModel || !codexProfileMatches || policyModel.providerID !== input.engine || policyModel.modelID !== input.model ||
        sessionRoute.engine !== input.engine || sessionRoute.model !== input.model) {
      return refuse("Loader witness native route does not match the owned session profile.")
    }
    const prompt = promptWitness(state, input.prompt)
    const identity = await inspectNativeIdentity(input.transport, input.engine, input.model, input.codexProfileSha256)
    if (witness.phase !== "registered") return refuse("Loader witness was invalidated during pre-dispatch verification.")
    if (!current(state) || !witnessAuthorityCurrent(state)) return refuse("Loader witness admission or ownership changed before dispatch.")
    const recaptured = await state.source.session.recapture(
      state.source.capture, state.source.lease, state.source.revision, state.cancel.signal,
    )
    if (witness.phase !== "registered") return refuse("Loader witness was invalidated during pre-dispatch verification.")
    if (recaptured.contentHash !== state.source.capture.contentHash) {
      return refuse("Loader witness capture changed before dispatch.")
    }
    const stableBefore = stableSkillIdentity(state)
    if (!current(state) || !witnessAuthorityCurrent(state)) return refuse("Loader witness source or ownership changed before dispatch.")
    witness.transport = input.transport
    witness.identityBefore = identity
    witness.stableBefore = stableBefore
    witness.prompt = prompt
    witness.phase = "started"
    return witness.observation
  } catch (error) {
    witness.phase = "refused"
    if (error instanceof SkillAdmissionError) throw error
    return refuse("Loader witness pre-dispatch verification failed closed.")
  }
}

/** Finalize only an actual completed native result and terminal-quiescent transport observation. */
export async function finishSkillLoaderWitness(
  request: ExecutionRequest,
  observation: SkillLoaderWitnessObservation,
  input: Readonly<{
    status: string
    quiescent: boolean
    responseKind: "final" | "tool" | "invalid"
    requestText?: string
    responseText?: string
    error?: string
    reconciliation?: ExecutionReconciliation
  }>,
): Promise<void> {
  const witness = observation && typeof observation === "object" ? loaderWitnesses.get(observation) : undefined
  if (!witness || witness.phase !== "started" || witness.observation !== observation) {
    return refuse("Loader witness observation is copied, stale, or already finalized.")
  }
  witness.phase = "finishing"
  const state = witness.contextState
  try {
    const reconciliation = input.reconciliation
    if (state.witness !== witness || state.context !== request.skillContext || !stateFor(request) ||
        input.status !== "completed" || input.quiescent !== true || input.error !== undefined ||
        !reconciliation || reconciliation.outcome !== "terminal" || reconciliation.quiescent !== true ||
        typeof reconciliation.evidence !== "string" || reconciliation.evidence.includes("scratch cleanup failed") ||
        !witnessAuthorityCurrent(state)) {
      return refuse("Native result, quiescence, ownership, or skill authority is not witness-eligible.")
    }
    const transport = witness.transport
    const identityBefore = witness.identityBefore
    const stableBefore = witness.stableBefore
    const prompt = witness.prompt
    if (!transport?.inspectIdentity || !identityBefore || !stableBefore || !prompt) {
      return refuse("Loader witness pre-dispatch evidence is incomplete.")
    }
    const identityAfter = await inspectNativeIdentity(
      transport, identityBefore.engine, identityBefore.requestedModel,
      identityBefore.engine === "codex" ? identityBefore.profileIdentity.sha256 : undefined,
    )
    if (witness.phase !== "finishing") return refuse("Loader witness was invalidated during post-dispatch verification.")
    if (!sameNativeIdentity(identityBefore, identityAfter)) return refuse("native runtime identity verification failed")
    if (!witnessAuthorityCurrent(state)) return refuse("Loader witness skill authority changed during inference.")
    const recaptured = await state.source.session.recapture(
      state.source.capture, state.source.lease, state.source.revision, new AbortController().signal,
    )
    if (witness.phase !== "finishing") return refuse("Loader witness was invalidated during post-dispatch verification.")
    if (recaptured.contentHash !== state.source.capture.contentHash ||
        !witnessAuthorityCurrent(state)) {
      return refuse("Loader witness skill source or admission changed during inference.")
    }
    const stableAfter = stableSkillIdentity(state)
    if (stableBefore.projectRootSha256 !== stableAfter.projectRootSha256 ||
        stableBefore.fileIdentitySha256 !== stableAfter.fileIdentitySha256 || !witnessAuthorityCurrent(state)) {
      return refuse("Loader witness stable file identity changed during inference.")
    }
    if (input.responseKind !== "final") return refuse("Loader witness canary cannot request tools or accept a malformed response.")
    if (typeof input.requestText !== "string" || Buffer.byteLength(input.requestText, "utf8") > 64 * 1024 ||
        Buffer.from(input.requestText, "utf8").toString("utf8") !== input.requestText || input.requestText !== request.text) {
      return refuse("Native request text is absent, altered, or exceeds the loader witness byte bound.")
    }
    if (typeof input.responseText !== "string" || Buffer.byteLength(input.responseText, "utf8") > 32 * 1024 ||
        Buffer.from(input.responseText, "utf8").toString("utf8") !== input.responseText) {
      return refuse("Native final response is absent or exceeds the loader witness byte bound.")
    }
    const responseBytes = Buffer.from(input.responseText, "utf8")
    const file = witnessTargetCapture(state)
    const receipt: SkillLoaderWitnessReceipt = Object.freeze({
      version: "native-v1",
      loaderDelivery: "observed",
      behavioralCanary: "not-evaluated",
      projectRootSha256: stableAfter.projectRootSha256,
      skillPath: WITNESS_SKILL_PATH,
      capture: Object.freeze({
        source: "project", identity: WITNESS_SKILL_IDENTITY,
        classification: state.source.capture.classification,
        manifestSha256: state.source.capture.contentHash,
        contentHash: state.source.capture.contentHash,
        skillFileSha256: file.fileSha256,
        skillFileBytes: file.fileBytes,
      }),
      instructions: Object.freeze({
        utf8Sha256: prompt.instructionsSha256,
        utf8Bytes: prompt.instructionsBytes,
        promptSha256: prompt.sha256,
        promptBytes: prompt.bytes,
        span: Object.freeze({
          startByte: prompt.startByte, endByte: prompt.endByte,
          sha256: prompt.instructionsSha256,
          basis: "exact-captured-instruction-utf8-substring-v1",
        }),
        evaluatorSystem: Object.freeze({
          utf8Sha256: prompt.evaluatorSystemSha256,
          utf8Bytes: prompt.evaluatorSystemBytes,
          startByte: prompt.evaluatorSystemStartByte,
          endByte: prompt.evaluatorSystemEndByte,
          basis: "exact-code-owned-evaluator-utf8-substring-v1",
        }),
      }),
      requestTextSha256: hashUtf8(input.requestText),
      response: Object.freeze({ sha256: hashUtf8(responseBytes), bytes: responseBytes.byteLength }),
      canary: witness.canary,
      evaluatorSystemInstructions: witness.evaluatorSystemInstructions,
      fileIdentity: Object.freeze({
        beforeSha256: stableBefore.fileIdentitySha256,
        afterSha256: stableAfter.fileIdentitySha256,
        root: stableAfter.root,
        agents: stableAfter.agents,
        skills: stableAfter.skills,
        skill: stableAfter.skill,
        file: stableAfter.file,
        basis: "fd-tree-openat-fstat-and-captured-bytes-v1",
      }),
      invocation: Object.freeze({
        sessionID: state.scope.supervisorSessionID,
        attachmentEpoch: state.context.attachmentEpoch,
        executionID: state.scope.executionID,
        taskID: state.scope.taskID,
        attemptID: state.scope.attemptID,
        generation: state.scope.generation,
        role: "main",
        invocationID: state.context.invocationID,
      }),
      native: Object.freeze({
        engine: identityAfter.engine,
        requestedModel: identityAfter.requestedModel,
        runtimeIdentity: identityAfter.runtimeIdentity,
        profileIdentity: identityAfter.profileIdentity,
        identityBefore,
        identityAfter,
        identityStable: true,
        status: "completed",
        quiescent: true,
        reconciliation: "terminal-quiescent",
      }),
    })
    if (witness.phase !== "finishing") return refuse("Loader witness was invalidated before receipt finalization.")
    witness.receipt = receipt
    witness.phase = "complete"
  } catch (error) {
    witness.phase = "refused"
    if (error instanceof SkillAdmissionError) throw error
    return refuse("Loader witness post-dispatch verification failed closed.")
  }
}

/** Read-only query used by the CLI host to remove every tool from this one canary prompt. */
export function skillLoaderWitnessRegistered(request: ExecutionRequest): boolean {
  return stateFor(request)?.witness !== undefined
}

/** Exact pre-registered, code-owned canary binding read by the CLI host before constructing its completion token. */
export function skillLoaderWitnessCanaryBinding(request: ExecutionRequest): SkillLoaderCanaryBinding | undefined {
  return stateFor(request)?.witness?.canary
}

/** Read the finished receipt for host-side completion binding without consuming the one-use observation. */
export function skillLoaderWitnessCompletion(
  request: ExecutionRequest,
  observation: SkillLoaderWitnessObservation,
): SkillLoaderWitnessReceipt | undefined {
  const state = stateFor(request)
  const witness = observation && typeof observation === "object" ? loaderWitnesses.get(observation) : undefined
  if (!state || !witness || witness.observation !== observation || witness.contextState !== state ||
      state.witness !== witness || witness.phase !== "complete" || witness.consumed || !witness.receipt) return undefined
  return witness.receipt
}

/** Invalidate a completed-but-unconsumed receipt when its host execution cannot complete successfully. */
export function invalidateSkillLoaderWitness(observation: SkillLoaderWitnessObservation): void {
  const witness = observation && typeof observation === "object" ? loaderWitnesses.get(observation) : undefined
  if (!witness || witness.observation !== observation || witness.consumed) return
  witness.receipt = undefined
  witness.phase = "refused"
}

/** Consume the host-created artifact once; the observation itself is never a durable authority. */
export async function consumeSkillLoaderWitness(observation: SkillLoaderWitnessObservation): Promise<SkillLoaderWitnessReceipt> {
  const witness = observation && typeof observation === "object" ? loaderWitnesses.get(observation) : undefined
  if (!witness || witness.observation !== observation || witness.phase !== "complete" || witness.consumed || !witness.receipt) {
    return refuse("Loader witness is incomplete, copied, failed closed, or already consumed.")
  }
  witness.phase = "consuming"
  const state = witness.contextState
  try {
    if (!witnessAuthorityCurrent(state)) return refuse("Loader witness ownership or admission changed before receipt consumption.")
    const recaptured = await state.source.session.recapture(
      state.source.capture, state.source.lease, state.source.revision, new AbortController().signal,
    )
    if (witness.phase !== "consuming" || recaptured.contentHash !== state.source.capture.contentHash ||
        !witnessAuthorityCurrent(state)) return refuse("Loader witness source or admission changed before receipt consumption.")
    const identity = stableSkillIdentity(state)
    if (witness.phase !== "consuming" || identity.projectRootSha256 !== witness.receipt.projectRootSha256 ||
        identity.fileIdentitySha256 !== witness.receipt.fileIdentity.afterSha256 || !witnessAuthorityCurrent(state)) {
      return refuse("Loader witness file identity changed before receipt consumption.")
    }
    witness.consumed = true
    witness.phase = "consumed"
    return witness.receipt
  } catch (error) {
    witness.phase = "refused"
    if (error instanceof SkillAdmissionError) throw error
    return refuse("Loader witness receipt consumption failed closed.")
  }
}

/** Called only by an execution builder, never by parsing model text or persisted audit fields. */
export function bindSkillInvocation(
  prepared: PreparedSkillInvocation,
  request: Scope,
  policy: ExecutionPolicy,
  terminal?: Pick<Terminal, "stdinIsTTY" | "stderrIsTTY" | "choose" | "resume">,
): Readonly<{ context: SkillInvocationContext; handlers: ExecutionPolicyHandlers; instructions: string }> {
  if ("skillContext" in request || !(EXECUTION_ROLES as readonly string[]).includes(request.role) || policy.resolve(request.role) !== request.policy ||
      !Number.isSafeInteger(request.generation) || request.generation < 1 ||
      !Number.isSafeInteger(request.deadlineAt) || request.deadlineAt <= Date.now()) {
    return refuse("Skill execution requires one fixed code-owned request.")
  }
  const source = claimPreparedSkillInvocation(prepared)
  if (request.supervisorSessionID !== source.session.store.sessionID) return refuse("Skill invocation cannot cross supervisor sessions.")
  if (source.capture.descriptor.kind !== "skill") return refuse("Protected workflows cannot become ordinary skill execution contexts.")
  const declared = source.capture.descriptor.kind === "skill" ? source.capture.descriptor.allowedTools : undefined
  const allowedTools = EXECUTION_TOOL_NAMES.filter(tool => request.policy.tools.allowed.includes(policyToolName(tool)) &&
    !request.policy.tools.denied.includes(policyToolName(tool)) && (declared === undefined || declared.includes(tool)))
  const cancel = new AbortController()
  const unregister = source.session.registerInvocationCancellation(source.capture.name, source.revision, cancel)
  let foreground: ForegroundSkillInvocation | undefined
  try {
    foreground = terminal ? registerForegroundSkillInvocation({
      worktree: source.session.roots.projectRoot, store: source.session.store, request, policy,
      terminal: {
        stdinIsTTY: terminal.stdinIsTTY,
        stderrIsTTY: terminal.stderrIsTTY,
        ...(terminal.choose ? { choose: async (title, choices, signal) => {
          try { return await terminal.choose!(title, choices, signal) }
          finally { terminal.resume?.() }
        } } : {}),
      },
    }) : undefined
    const context = Object.freeze({
      supervisorSessionID: source.session.store.sessionID,
      attachmentEpoch: source.session.store.epoch,
      canonicalSource: skillDirectoryPath(source.session.roots, source.capture.descriptor),
      name: source.capture.name,
      contentHash: source.capture.contentHash,
      allowedTools: Object.freeze(allowedTools),
      invocationID: foregroundSkillInvocationID(foreground) ?? randomUUID(),
      capture: source.capture,
    }) as SkillInvocationContext
    const scope = Object.freeze({ ...request })
    const base = policy.handlers(scope)
    const state: ContextState = {
      active: true, source, context, scope, policy, foreground, cancel, unregister,
      calls: new Map(), seenCalls: new Set(), beforeTool,
    }
    function beforeTool(event: ToolBefore): ExecutionDecision {
      try {
        const call = callFor(state, event)
        if (call.observed) return { allow: false, reason: "Skill tool observation cannot be replayed." }
        call.observed = true
        const decision = base.beforeTool(event)
        if (!decision.allow) return { allow: false, reason: decision.reason }
        call.baseAllowed = true
        if (context.allowedTools.includes(event.name as SkillToolName)) return { allow: true }
        const ticket = foreground ? createSkillHoldTicket({
          invocation: foreground, event, skillHash: context.contentHash,
          view: { name: context.name, classification: source.capture.classification, allowedTools: context.allowedTools },
          revalidation: {
            canIssueTicket: () => call.baseAllowed && callMatches(state, call),
            beforeChoice: signal => refreshCall(state, call, signal),
            afterChoice: signal => refreshCall(state, call, signal),
            beforeConsume: () => call.effectReady && call.baseAllowed && callMatches(state, call),
          },
        }) : undefined
        return { allow: false, reason: "Tool is outside this skill's declared scope.", ...(ticket ? { holdTicket: ticket } : {}) }
      } catch { return { allow: false, reason: "Skill tool authorization failed closed." } }
    }
    const handlers: ExecutionPolicyHandlers = Object.freeze({
      beforeTool,
      toolResult(event) {
        const call = state.calls.get(event.callID)
        if (!current(state) || !call?.consumed || event.sessionID !== scope.executionID || event.name !== call.tool) {
          return refuse("Skill tool result does not belong to a consumed current call.")
        }
        state.calls.delete(event.callID)
        return base.toolResult(event)
      },
      assistantText(event) {
        if (!current(state)) return { cancel: true }
        return base.assistantText(event)
      },
    })
    contexts.set(context, state)
    boundaries.set(beforeTool, state)
    return Object.freeze({ context, handlers, instructions: source.text })
  } catch (error) {
    unregister()
    cancel.abort()
    revokeForegroundSkillInvocation(foreground)
    throw error
  }
}

function stateFor(request: ExecutionRequest): ContextState | undefined {
  if (request.skillContext === undefined) {
    if (boundaries.has(request.handlers.beforeTool)) return refuse("Skill-bound handlers require their authentic invocation context.")
    return undefined
  }
  const value: unknown = request.skillContext
  const state = value && typeof value === "object" ? contexts.get(value) : undefined
  if (!state || !current(state) || !scopeMatches(state, request) || boundaries.get(request.handlers.beforeTool) !== state) {
    return refuse("Skill execution context is missing, copied, expired, or bound to another request.")
  }
  return state
}

/** No-op only for an ordinary execution with no skill context; malformed context always refuses. */
export function assertSkillExecution(request: ExecutionRequest): void { stateFor(request) }

async function refreshCall(state: ContextState, call: CallState, signal: AbortSignal): Promise<boolean> {
  call.effectReady = false
  if (signal.aborted || !callMatches(state, call)) return false
  await state.source.session.recapture(state.source.capture, state.source.lease, state.source.revision, signal)
  return !signal.aborted && callMatches(state, call)
}

/** Async capture precedes the synchronous policy observation, and supplies no effects or reusable grant. */
export async function prepareSkillToolCall(
  request: ExecutionRequest,
  event: ToolBefore,
  signal: AbortSignal,
  validate: () => boolean,
): Promise<void> {
  const state = stateFor(request)
  if (!state) return
  if (state.seenCalls.has(event.callID) || event.sessionID !== request.executionID || typeof event.callID !== "string" || !event.callID ||
      !(EXECUTION_TOOL_NAMES as readonly string[]).includes(event.name) ||
      !request.policy.tools.allowed.includes(policyToolName(event.name)) || request.policy.tools.denied.includes(policyToolName(event.name))) {
    return refuse("Skill tool call identity or base role is not admissible.")
  }
  const digest = skillArgumentDigest(event.input)
  if (!digest || typeof validate !== "function") return refuse("Skill tool arguments cannot be bound safely.")
  const call: CallState = { event, callID: event.callID, tool: event.name, digest, validate, observed: false, baseAllowed: false, effectReady: false, consumed: false, snapshotRead: false }
  state.seenCalls.add(event.callID)
  state.calls.set(event.callID, call)
  if (!(await refreshCall(state, call, signal))) return refuse("Skill source or tool path is no longer admissible.")
  stateFor(request)
}

/** Last async boundary: recheck the actual source and path before consuming any allow-once permit. */
export async function revalidateSkillToolEffect(request: ExecutionRequest, event: ToolBefore, signal: AbortSignal): Promise<void> {
  const state = stateFor(request)
  if (!state) return
  const call = callFor(state, event)
  if (!call.observed || !call.baseAllowed || !(await refreshCall(state, call, signal))) return refuse("Skill effect has no current source proof.")
  stateFor(request)
  call.effectReady = true
}

/** Consume exactly once immediately before effects; re-observation never increments base policy counters. */
export function consumeSkillToolEffect(request: ExecutionRequest, event: ToolBefore, permit?: SkillPermissionPermit): void {
  const state = stateFor(request)
  if (!state) {
    if (permit !== undefined) return refuse("An ordinary execution cannot consume a skill permission permit.")
    return
  }
  const call = callFor(state, event)
  if (!call.observed || !call.baseAllowed || !call.effectReady) return refuse("Skill effect proof is absent or stale.")
  if (!state.context.allowedTools.includes(event.name as SkillToolName)) {
    if (!state.foreground || !consumeSkillPermissionPermit(permit, {
      invocation: state.foreground, request, event, skillHash: state.context.contentHash,
    })) return refuse("Skill allow-once permission was denied, expired, or already consumed.")
  } else if (permit !== undefined) return refuse("Skill permit does not match an out-of-scope call.")
  if (!callMatches(state, call, event)) return refuse("Skill effect context changed at final admission.")
  call.consumed = true
  call.effectReady = false
}

/** Source references use captured bytes only after the ordinary path/role/call admission. */
export function readSkillToolSnapshot(request: ExecutionRequest, event: ToolBefore): Uint8Array | undefined {
  const state = stateFor(request)
  if (!state || event.name !== "read") return undefined
  const call = state.calls.get(event.callID)
  if (!call?.consumed || call.snapshotRead || event.sessionID !== state.scope.executionID ||
      call.tool !== event.name || skillArgumentDigest(event.input) !== call.digest) {
    return refuse("Skill snapshot read has no consumed exact-call proof.")
  }
  const input = event.input as Record<string, unknown>
  if (typeof input.path !== "string") return refuse("Skill snapshot path is invalid.")
  const resource = readCapturedSkillResource(state.source.session.roots, state.source.capture, resolve(request.cwd, input.path.replaceAll("\\", "/")))
  if (!resource) return undefined
  if (resource.kind !== "file") return refuse("Skill read requires a captured regular file.")
  call.snapshotRead = true
  return resource.bytes
}

export function skillExecutionSignal(request: ExecutionRequest, signal: AbortSignal): AbortSignal {
  const state = stateFor(request)
  return state ? AbortSignal.any([signal, state.cancel.signal]) : signal
}

export function finishSkillInvocation(context: SkillInvocationContext | undefined): void {
  if (context === undefined) return
  const state = contexts.get(context)
  if (!state || !state.active) return
  if (state.witness && state.witness.phase !== "complete") state.witness.phase = "refused"
  state.active = false
  state.cancel.abort()
  state.unregister()
  state.calls.clear()
  state.seenCalls.clear()
  revokeForegroundSkillInvocation(state.foreground)
}

/** Audit data is deliberately insufficient to recreate a context or a grant. */
export function skillInvocationAudit(context: SkillInvocationContext): Readonly<Record<string, string>> {
  const state = contexts.get(context)
  if (!state || !current(state)) return refuse("Skill invocation audit requires a current authentic context.")
  return Object.freeze({
    supervisorSessionID: context.supervisorSessionID, attachmentEpoch: context.attachmentEpoch,
    source: context.canonicalSource, name: context.name, contentHash: context.contentHash, invocationID: context.invocationID,
  })
}
