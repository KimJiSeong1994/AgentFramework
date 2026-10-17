import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import type { Hooks } from "@opencode-ai/plugin"
import type { Message, UserMessage } from "@opencode-ai/sdk"
import {
  admissionEpoch, admissionFence, captureAdmissionLease, effectiveHold, isAdmissionCurrent, isAdmissionLeaseCurrent,
  type AdmissionLease,
} from "../sessions/admission.ts"
import { getOwnedSession } from "../sessions/store.ts"
import type { HookDeps } from "../hooks/types.ts"
import { getOpenCodeRuntime, policyBindingForOpenCodeSession, type OpenCodeSessionPolicyBinding } from "./opencode-runtime.ts"
import type { ExecutionPolicy, ExecutionPolicySnapshot, ExecutionRole } from "./types.ts"
import { EXECUTION_ROLES } from "./types.ts"

const MAX_SYSTEM_CHANNELS = 4096
const MAX_TURN_TOMBSTONES = 65_536
const channels = new Map<string, SystemChannel>()
type SystemTurn = { messageID: string; phase: "reserved" | "binding" | "bound"; admissionLease?: AdmissionLease }
const currentTurns = new Map<string, SystemTurn>()
const turnTombstones = new Set<string>()
const knownScopes = new Set<string>()
const configStates = new WeakMap<HookDeps, ConfigState>()
const openCodeToolTurnProofs = new WeakMap<object, { channel: SystemChannel; turn: SystemTurn }>()

export type OpenCodeToolTurn = Readonly<{
  kind: "main" | "child"
  sessionID: string
  userMessageID: string
  supervisorSessionID: string
  attachmentEpoch: string
  role: ExecutionRole
  policy: ExecutionPolicySnapshot
}>

export type UnsafeOpenCodeSystemReason =
  | "invalid-turn"
  | "missing-turn"
  | "stale-turn"
  | "unbound-session"
  | "held-owner"
  | "unknown-role"
  | "unsafe-config"
  | "system-mismatch"
  | "policy-changed"
  | "transform-unavailable"
  | "capacity-exhausted"

/** Typed fail-closed refusal for an OpenCode request that has no exact Otter-owned system channel. */
export class UnsafeOpenCodeSystemChannel extends Error {
  readonly code = "OTTER_UNSAFE_OPENCODE_SYSTEM_CHANNEL"
  readonly reason: UnsafeOpenCodeSystemReason

  constructor(reason: UnsafeOpenCodeSystemReason) {
    super(`otter: OpenCode system channel refused (${reason})`)
    this.name = "UnsafeOpenCodeSystemChannel"
    this.reason = reason
  }
}

type ConfigShape = {
  agent?: Record<string, Record<string, unknown> | undefined>
  instructions?: unknown
}

type ConfigState = {
  config: ConfigShape
  unsafeRoles: Set<string>
  expectedSystem: Map<string, string>
  expectedPolicyID: Map<string, string>
  unsafeInstructions: boolean
}

type SystemChannel = Readonly<{
  key: string
  scope: string
  sessionID: string
  ownerWorktree: string
  ownerSessionID: string
  ownerEpoch: string
  admissionLease?: AdmissionLease
  supervisorFence?: string
  executionID?: string
  taskID?: string
  attemptID?: string
  generation?: number
  role: ExecutionRole
  policy: ExecutionPolicySnapshot
  policyID: string
  system: readonly string[]
  systemHash: string
  messageID: string
  agent: string
  systemWasExplicit: boolean
}>

type ChatMessageInput = Parameters<NonNullable<Hooks["chat.message"]>>[0]
type ChatMessageOutput = Parameters<NonNullable<Hooks["chat.message"]>>[1]

function refuse(reason: UnsafeOpenCodeSystemReason): never {
  throw new UnsafeOpenCodeSystemChannel(reason)
}

function validID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_.:-]+$/.test(value)
}

function canonicalWorktree(worktree: string): string {
  try { return realpathSync.native(worktree) }
  catch { return refuse("unbound-session") }
}

function scopeKey(deps: HookDeps, sessionID: string): string {
  return JSON.stringify([canonicalWorktree(deps.worktree), sessionID])
}

function turnKey(scope: string, messageID: string): string {
  return JSON.stringify([scope, messageID])
}

function systemHash(system: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(system)).digest("hex")
}

/** Hash the actual string array passed through the pinned SDK system transform. */
export function hashOpenCodeSystem(system: readonly string[]): string {
  return systemHash(system)
}

function systemBytes(policy: ExecutionPolicySnapshot): { system: readonly string[]; hash: string } {
  if (!policy || !Object.isFrozen(policy) || typeof policy.id !== "string" || policy.id.length === 0 ||
      !EXECUTION_ROLES.includes(policy.role) || !Array.isArray(policy.system) || !Object.isFrozen(policy.system) ||
      policy.system.length === 0 || policy.system.some(value => typeof value !== "string" || value.length === 0)) {
    return refuse("policy-changed")
  }
  const system = Object.freeze([...policy.system])
  return { system, hash: systemHash(system) }
}

function configHasUnsafeInstructions(config: ConfigShape): boolean {
  if (!Object.prototype.hasOwnProperty.call(config, "instructions") || config.instructions === undefined) return false
  return !Array.isArray(config.instructions) || config.instructions.length !== 0
}

/** Snapshot prompt-safety facts before config.agent is merged or mutated by the config hook. */
export function captureOpenCodeAgentConfigSafety(
  deps: HookDeps,
  source: unknown,
  policy: ExecutionPolicy,
): void {
  const config = source && typeof source === "object" && !Array.isArray(source)
    ? source as ConfigShape
    : {}
  const state = configStates.get(deps) ?? {
    config,
    unsafeRoles: new Set<string>(),
    expectedSystem: new Map<string, string>(),
    expectedPolicyID: new Map<string, string>(),
    unsafeInstructions: false,
  }
  state.config = config
  if (config !== source) for (const role of EXECUTION_ROLES) state.unsafeRoles.add(role)
  state.unsafeInstructions ||= configHasUnsafeInstructions(config)
  for (const role of EXECUTION_ROLES) {
    let expected: string
    let expectedPolicyID: string
    try {
      const snapshot = policy.resolve(role)
      if (snapshot.role !== role) {
        state.unsafeRoles.add(role)
        continue
      }
      expected = systemBytes(snapshot).system.join("\n\n")
      expectedPolicyID = snapshot.id
    } catch {
      state.unsafeRoles.add(role)
      continue
    }
    const userAgent = config.agent?.[role]
    if (userAgent) {
      const prompt = userAgent.prompt
      if ((prompt !== undefined && prompt !== expected) || userAgent.system !== undefined ||
          Object.prototype.hasOwnProperty.call(userAgent, "system")) {
        state.unsafeRoles.add(role)
      }
    }
    state.expectedSystem.set(role, expected)
    state.expectedPolicyID.set(role, expectedPolicyID)
  }
  configStates.set(deps, state)
}

function assertConfigRoleSafe(deps: HookDeps, role: ExecutionRole, policyID: string, system: readonly string[]): void {
  const state = configStates.get(deps)
  const expected = system.join("\n\n")
  const agent = state?.config.agent?.[role]
  if (state) state.unsafeInstructions ||= configHasUnsafeInstructions(state.config)
  if (!state || state.unsafeInstructions || state.unsafeRoles.has(role) || state.expectedPolicyID.get(role) !== policyID ||
      state.expectedSystem.get(role) !== expected ||
      !agent || agent.prompt !== expected || agent.system !== undefined || Object.prototype.hasOwnProperty.call(agent, "system")) {
    refuse("unsafe-config")
  }
}

function reserveTurn(deps: HookDeps, sessionID: string, messageID: string): string {
  if (!validID(sessionID) || !validID(messageID)) return refuse("invalid-turn")
  const scope = scopeKey(deps, sessionID)
  const hadTurn = currentTurns.has(scope)
  const admissionLease = captureAdmissionLease(deps.worktree, sessionID)
  const tombstone = turnKey(scope, messageID)
  if (turnTombstones.has(tombstone)) return refuse("stale-turn")
  if (turnTombstones.size >= MAX_TURN_TOMBSTONES || (!hadTurn && currentTurns.size >= MAX_SYSTEM_CHANNELS)) {
    return refuse("capacity-exhausted")
  }
  channels.delete(scope)
  currentTurns.delete(scope)
  turnTombstones.add(tombstone)
  knownScopes.add(scope)
  currentTurns.set(scope, { messageID, phase: "reserved", ...(admissionLease ? { admissionLease } : {}) })
  return scope
}

/** Call synchronously at chat.message entry, before any await, to retire the previous turn. */
export function reserveOpenCodeSystemTurn(deps: HookDeps, sessionID: string, messageID: string): AdmissionLease | undefined {
  const scope = reserveTurn(deps, sessionID, messageID)
  return currentTurns.get(scope)?.admissionLease
}

/** Retire the active turn when a chat hook exits through a path that does not authorize inference. */
function invalidateOpenCodeSystemTurn(deps: HookDeps, sessionID: string, messageID: string): void {
  if (!validID(sessionID) || !validID(messageID)) return
  try {
    const scope = scopeKey(deps, sessionID)
    if (currentTurns.get(scope)?.messageID !== messageID) return
    channels.delete(scope)
    currentTurns.delete(scope)
  } catch {
    // A missing canonical worktree already makes all later channel checks fail closed.
  }
}

function policyForMain(deps: HookDeps, sessionID: string, admissionLease: AdmissionLease | undefined): Omit<SystemChannel, "key" | "scope" | "executionID" | "messageID" | "agent" | "systemWasExplicit" | "system" | "systemHash" | "policyID"> & {
  policy: ExecutionPolicySnapshot
} {
  const ownerWorktree = canonicalWorktree(deps.worktree)
  const store = getOwnedSession(ownerWorktree, sessionID)
  const epoch = admissionEpoch(ownerWorktree, sessionID)
  if (!store || store.sessionID !== sessionID || store.metadata.engine !== "opencode" || !epoch || store.epoch !== epoch || !admissionLease ||
      !isAdmissionLeaseCurrent(ownerWorktree, sessionID, admissionLease) || effectiveHold(ownerWorktree, sessionID) ||
      !isAdmissionCurrent(ownerWorktree, sessionID, epoch)) return refuse("held-owner")
  let policy: ExecutionPolicySnapshot
  try { policy = getOpenCodeRuntime(deps).policy.resolve("main") }
  catch { return refuse("policy-changed") }
  if (policy.role !== "main") return refuse("unknown-role")
  return {
    sessionID,
    ownerWorktree,
    ownerSessionID: sessionID,
    ownerEpoch: epoch,
    admissionLease,
    role: "main",
    policy,
  }
}

function childPolicy(deps: HookDeps, sessionID: string): OpenCodeSessionPolicyBinding | undefined {
  try { return policyBindingForOpenCodeSession(deps, sessionID) }
  catch { return refuse("unbound-session") }
}

function claimTurn(
  deps: HookDeps,
  sessionID: string,
  messageID: string,
  requestedAdmissionLease?: AdmissionLease,
): { scope: string; turn: SystemTurn } {
  if (!validID(sessionID) || !validID(messageID)) return refuse("invalid-turn")
  const scope = scopeKey(deps, sessionID)
  const current = currentTurns.get(scope)
  if (!current || current.messageID !== messageID || current.phase !== "reserved" ||
      !turnTombstones.has(turnKey(scope, messageID))) return refuse("stale-turn")
  const turn: SystemTurn = { ...current, phase: "binding" }
  if (requestedAdmissionLease) {
    if (turn.admissionLease && turn.admissionLease !== requestedAdmissionLease) return refuse("stale-turn")
    turn.admissionLease = requestedAdmissionLease
  }
  currentTurns.set(scope, turn)
  return { scope, turn }
}

function installChannel(
  deps: HookDeps,
  input: ChatMessageInput,
  output: ChatMessageOutput,
  scope: string,
): SystemChannel {
  const message = output.message
  const messageID = message?.id
  if (!validID(input.sessionID) || !validID(messageID) || message.sessionID !== input.sessionID || message.role !== "user" ||
      (input.messageID !== undefined && input.messageID !== messageID) ||
      !output.parts.some(part => part.type === "text" && !part.synthetic && !part.ignored && part.text.length > 0)) {
    return refuse("invalid-turn")
  }
  const turn = currentTurns.get(scope)
  if (!turn || turn.messageID !== messageID || turn.phase !== "binding") return refuse("stale-turn")
  if (channels.has(scope)) return refuse("stale-turn")

  const child = childPolicy(deps, input.sessionID)
  let ownerWorktree: string
  let ownerSessionID: string
  let ownerEpoch: string
  let admissionLease: AdmissionLease | undefined
  let supervisorFence: string | undefined
  let executionID: string | undefined
  let taskID: string | undefined
  let attemptID: string | undefined
  let generation: number | undefined
  let role: ExecutionRole
  let policy: ExecutionPolicySnapshot
  if (child) {
    role = child.role
    policy = child.policy
    ownerWorktree = child.ownerWorktree
    ownerSessionID = child.ownerSessionID
    ownerEpoch = child.ownerEpoch
    supervisorFence = admissionFence(ownerWorktree, ownerSessionID)
    executionID = child.executionID
    taskID = child.taskID
    attemptID = child.attemptID
    generation = child.generation
    const rechecked = childPolicy(deps, input.sessionID)
    if (!rechecked || rechecked.sessionID !== child.sessionID || rechecked.executionID !== child.executionID ||
        rechecked.ownerWorktree !== ownerWorktree || rechecked.ownerSessionID !== ownerSessionID ||
        rechecked.ownerEpoch !== ownerEpoch || rechecked.taskID !== taskID || rechecked.attemptID !== attemptID ||
        rechecked.generation !== generation || rechecked.role !== role || rechecked.policy !== policy) return refuse("policy-changed")
    if (input.agent !== role || message.agent !== role) return refuse("unknown-role")
    const expected = systemBytes(policy).system.join("\n\n")
    if (typeof message.system !== "string" || message.system !== expected) return refuse("system-mismatch")
  } else {
    if ((input.agent !== undefined && input.agent !== "main") || message.agent !== "main") return refuse("unknown-role")
    const currentTurn = currentTurns.get(scope)
    const main = policyForMain(deps, input.sessionID, currentTurn?.admissionLease)
    role = main.role
    policy = main.policy
    ownerWorktree = main.ownerWorktree
    ownerSessionID = main.ownerSessionID
    ownerEpoch = main.ownerEpoch
    admissionLease = main.admissionLease
    const expected = systemBytes(policy).system.join("\n\n")
    if (message.system !== undefined && typeof message.system !== "string") return refuse("system-mismatch")
    if (typeof message.system === "string" && message.system !== expected) return refuse("system-mismatch")
  }
  if (!executionID && !admissionLease) return refuse("held-owner")
  if (policy.role !== role) return refuse("policy-changed")
  const system = systemBytes(policy)
  assertConfigRoleSafe(deps, role, policy.id, system.system)
  const channel: SystemChannel = Object.freeze({
    key: turnKey(scope, messageID),
    scope,
    sessionID: input.sessionID,
    ownerWorktree,
    ownerSessionID,
    ownerEpoch,
    ...(admissionLease ? { admissionLease } : {}),
    ...(supervisorFence ? { supervisorFence } : {}),
    ...(executionID ? { executionID } : {}),
    ...(taskID ? { taskID } : {}),
    ...(attemptID ? { attemptID } : {}),
    ...(generation === undefined ? {} : { generation }),
    role,
    policy,
    policyID: policy.id,
    system: system.system,
    systemHash: system.hash,
    messageID,
    agent: role,
    systemWasExplicit: message.system !== undefined,
  })
  if (channels.size >= MAX_SYSTEM_CHANNELS && !channels.has(scope)) return refuse("capacity-exhausted")
  channels.set(scope, channel)
  currentTurns.set(scope, { ...turn, phase: "bound" })
  try { assertChannelCurrent(deps, channel, messageID, role, message.system) }
  catch (error) {
    invalidateOpenCodeSystemTurn(deps, input.sessionID, messageID)
    if (error instanceof UnsafeOpenCodeSystemChannel) throw error
    return refuse("policy-changed")
  }
  return channel
}

function assertChannelCurrent(
  deps: HookDeps,
  channel: SystemChannel,
  messageID: string,
  agent: string,
  suppliedSystem: string | undefined,
): void {
  const turn = currentTurns.get(channel.scope)
  const expectedSuppliedSystem = channel.systemWasExplicit ? channel.system.join("\n\n") : undefined
  if (suppliedSystem !== expectedSuppliedSystem) return refuse("system-mismatch")
  if (!turn || turn.phase !== "bound" || channels.get(channel.scope) !== channel || turn.messageID !== channel.messageID ||
      messageID !== channel.messageID || agent !== channel.agent || channel.key !== turnKey(channel.scope, channel.messageID)) {
    return refuse("stale-turn")
  }
  if (systemHash(channel.system) !== channel.systemHash || channel.policy.id !== channel.policyID ||
      channel.policy.role !== channel.role) return refuse("policy-changed")
  assertConfigRoleSafe(deps, channel.role, channel.policyID, channel.system)
  if (channel.executionID) {
    if (!channel.supervisorFence || admissionFence(channel.ownerWorktree, channel.ownerSessionID) !== channel.supervisorFence) {
      return refuse("held-owner")
    }
    const binding = childPolicy(deps, channel.sessionID)
    if (!binding || binding.sessionID !== channel.sessionID || binding.executionID !== channel.executionID ||
        binding.ownerWorktree !== channel.ownerWorktree || binding.ownerSessionID !== channel.ownerSessionID ||
        binding.ownerEpoch !== channel.ownerEpoch || binding.taskID !== channel.taskID ||
        binding.attemptID !== channel.attemptID || binding.generation !== channel.generation ||
        binding.role !== channel.role || binding.policy !== channel.policy ||
        binding.policy.id !== channel.policyID || systemHash(binding.policy.system) !== channel.systemHash) {
      return refuse("policy-changed")
    }
  } else {
    if (turn.admissionLease !== channel.admissionLease) return refuse("stale-turn")
    const ownerWorktree = canonicalWorktree(deps.worktree)
    const store = getOwnedSession(ownerWorktree, channel.ownerSessionID)
    if (ownerWorktree !== channel.ownerWorktree || !store || store.sessionID !== channel.ownerSessionID ||
        store.epoch !== channel.ownerEpoch || admissionEpoch(ownerWorktree, channel.ownerSessionID) !== channel.ownerEpoch ||
        !channel.admissionLease || !isAdmissionLeaseCurrent(ownerWorktree, channel.ownerSessionID, channel.admissionLease) ||
        effectiveHold(ownerWorktree, channel.ownerSessionID) || !isAdmissionCurrent(ownerWorktree, channel.ownerSessionID, channel.ownerEpoch)) {
      return refuse("held-owner")
    }
    const policy = getOpenCodeRuntime(deps).policy.resolve(channel.role)
    if (policy !== channel.policy || policy.id !== channel.policyID || systemHash(policy.system) !== channel.systemHash) {
      return refuse("policy-changed")
    }
  }
}

/** Bind an authenticated, admitted main turn or a validated live child execution to its frozen policy system. */
export function bindOpenCodeSystemTurn(
  deps: HookDeps,
  input: ChatMessageInput,
  output: ChatMessageOutput,
  admissionLease?: AdmissionLease,
): void {
  let claimed: ReturnType<typeof claimTurn> | undefined
  try {
    claimed = claimTurn(deps, input.sessionID, output.message.id, admissionLease)
    installChannel(deps, input, output, claimed.scope)
  } catch (error) {
    if (claimed) invalidateOpenCodeSystemTurn(deps, input.sessionID, output.message.id)
    if (error instanceof UnsafeOpenCodeSystemChannel) throw error
    return refuse("policy-changed")
  }
}

function currentChannel(deps: HookDeps, sessionID: string): SystemChannel {
  if (!validID(sessionID)) return refuse("invalid-turn")
  let scope: string
  try { scope = scopeKey(deps, sessionID) }
  catch { return refuse("unbound-session") }
  const channel = channels.get(scope)
  const turn = currentTurns.get(scope)
  if (!channel || !turn || turn.phase !== "bound") return refuse("missing-turn")
  const messageID = turn.messageID
  try { assertChannelCurrent(deps, channel, messageID, channel.agent,
    channel.systemWasExplicit ? channel.system.join("\n\n") : undefined) }
  catch (error) {
    invalidateOpenCodeSystemTurn(deps, sessionID, channel.messageID)
    if (error instanceof UnsafeOpenCodeSystemChannel) throw error
    return refuse("policy-changed")
  }
  return channel
}

/** Mint an opaque tool turn only from a currently authenticated, policy-bound system channel. */
export function captureOpenCodeToolTurn(deps: HookDeps, sessionID: string): OpenCodeToolTurn | undefined {
  if (!validID(sessionID)) return refuse("invalid-turn")
  let scope: string
  try { scope = scopeKey(deps, sessionID) }
  catch { return refuse("unbound-session") }
  let known = knownScopes.has(scope) || currentTurns.has(scope) || channels.has(scope)
  try { known ||= !!getOwnedSession(canonicalWorktree(deps.worktree), sessionID) }
  catch { return refuse("unbound-session") }
  known ||= !!childPolicy(deps, sessionID)
  const channel = channels.get(scope)
  if (!channel) {
    if (known) return refuse("missing-turn")
    return undefined
  }
  const current = currentChannel(deps, sessionID)
  const turn = currentTurns.get(scope)
  if (current !== channel || !turn || turn.phase !== "bound") return refuse("missing-turn")
  if (channel.executionID ? !channel.taskID || !channel.attemptID || channel.generation === undefined : !channel.admissionLease) {
    return refuse("held-owner")
  }
  const capability: OpenCodeToolTurn = Object.freeze({
    kind: channel.executionID ? "child" : "main",
    sessionID: channel.sessionID,
    userMessageID: channel.messageID,
    supervisorSessionID: channel.ownerSessionID,
    attachmentEpoch: channel.ownerEpoch,
    role: channel.role,
    policy: channel.policy,
  })
  openCodeToolTurnProofs.set(capability, { channel, turn })
  return capability
}

/** Validate the exact capability object and channel incarnation; public copies are never authority. */
export function isOpenCodeToolTurnCurrent(deps: HookDeps, value: unknown): value is OpenCodeToolTurn {
  if (!value || typeof value !== "object") return false
  const proof = openCodeToolTurnProofs.get(value)
  if (!proof) return false
  const { channel, turn } = proof
  let scope: string
  try { scope = scopeKey(deps, channel.sessionID) }
  catch { return false }
  if (channels.get(scope) !== channel || currentTurns.get(scope) !== turn || turn.phase !== "bound") return false
  const candidate = value as OpenCodeToolTurn
  if (candidate.kind !== (channel.executionID ? "child" : "main") || candidate.sessionID !== channel.sessionID ||
      candidate.userMessageID !== channel.messageID || candidate.supervisorSessionID !== channel.ownerSessionID ||
      candidate.attachmentEpoch !== channel.ownerEpoch || candidate.role !== channel.role || candidate.policy !== channel.policy) return false
  try {
    assertChannelCurrent(deps, channel, channel.messageID, channel.role,
      channel.systemWasExplicit ? channel.system.join("\n\n") : undefined)
    return true
  } catch {
    invalidateOpenCodeSystemTurn(deps, channel.sessionID, channel.messageID)
    return false
  }
}

/** Wholesale trusted replacement; mutate the pinned SDK's shared array in place. */
export function createOpenCodeSystemTransformHook(
  deps: HookDeps,
): NonNullable<Hooks["experimental.chat.system.transform"]> {
  return async (input, output) => {
    const channel = currentChannel(deps, input.sessionID ?? "")
    const target = output.system
    try {
      if (!Array.isArray(target)) return refuse("transform-unavailable")
      target.splice(0, target.length, ...channel.system)
      if (output.system !== target || target.length !== channel.system.length ||
          target.some((value, index) => value !== channel.system[index]) || systemHash(target) !== channel.systemHash) {
        return refuse("transform-unavailable")
      }
      assertChannelCurrent(deps, channel, channel.messageID, channel.agent,
        channel.systemWasExplicit ? channel.system.join("\n\n") : undefined)
    } catch (error) {
      invalidateOpenCodeSystemTurn(deps, input.sessionID ?? "", channel.messageID)
      if (error instanceof UnsafeOpenCodeSystemChannel) throw error
      return refuse("transform-unavailable")
    }
  }
}

export function assertOpenCodeSystemMessageTurn(
  deps: HookDeps,
  sessionID: string,
  agent: string,
  message: UserMessage,
): void {
  if (!message || message.role !== "user" || message.sessionID !== sessionID || !validID(message.id)) return refuse("stale-turn")
  const channel = currentChannel(deps, sessionID)
  if (agent !== channel.agent || message.agent !== channel.agent) return refuse("unknown-role")
  try {
    assertChannelCurrent(deps, channel, message.id, agent, message.system)
  } catch (error) {
    if (error instanceof UnsafeOpenCodeSystemChannel) {
      invalidateOpenCodeSystemTurn(deps, sessionID, message.id)
      throw error
    }
    invalidateOpenCodeSystemTurn(deps, sessionID, message?.id)
    return refuse("policy-changed")
  }
}

/** Final pre-provider guard for the original user message delivered to chat.params. */
export function assertOpenCodeSystemParams(
  deps: HookDeps,
  input: Parameters<NonNullable<Hooks["chat.params"]>>[0],
): void {
  assertOpenCodeSystemMessageTurn(deps, input.sessionID, input.agent, input.message)
}

/** Final pre-provider guard for the original user message delivered to chat.headers. */
export function assertOpenCodeSystemHeaders(
  deps: HookDeps,
  input: Parameters<NonNullable<Hooks["chat.headers"]>>[0],
): void {
  assertOpenCodeSystemMessageTurn(deps, input.sessionID, input.agent, input.message)
}

/** Final message-transform guard: the exact expected user turn must occur once in the outgoing conversation. */
export function assertOpenCodeSystemMessages(
  deps: HookDeps,
  messages: Array<{ info: Message; parts: unknown[] }>,
): void {
  const worktree = canonicalWorktree(deps.worktree)
  const candidates = [...channels.values()].filter(channel =>
    channel.scope === JSON.stringify([worktree, channel.sessionID]) &&
    messages.some(message => message.info.id === channel.messageID && message.info.sessionID === channel.sessionID))
  if (candidates.length !== 1) {
    return refuse("stale-turn")
  }
  const channel = candidates[0]!
  try {
    if (messages.some(message => message.info.sessionID !== channel.sessionID)) return refuse("stale-turn")
    const matching = messages.filter(message => message.info.id === channel.messageID)
    const userMessages = messages.filter(message => message.info.role === "user")
    const latestUser = userMessages.length ? userMessages[userMessages.length - 1]!.info : undefined
    if (matching.length !== 1 || matching[0]!.info.role !== "user" || !latestUser || latestUser.role !== "user" ||
        latestUser.id !== channel.messageID || latestUser.sessionID !== channel.sessionID) return refuse("stale-turn")
    assertOpenCodeSystemMessageTurn(deps, channel.sessionID, channel.agent, matching[0]!.info as UserMessage)
  } catch (error) {
    invalidateOpenCodeSystemTurn(deps, channel.sessionID, channel.messageID)
    if (error instanceof UnsafeOpenCodeSystemChannel) throw error
    return refuse("stale-turn")
  }
}

/** Verify in-place replacement and exact bytes; native outbound receipts must still hash the actual request. */
export function assertOpenCodeSystemTransformOutput(
  deps: HookDeps,
  sessionID: string,
  originalSystem: string[],
  transformedSystem: string[],
): string {
  const channel = currentChannel(deps, sessionID)
  if (originalSystem !== transformedSystem || transformedSystem.length !== channel.system.length ||
      transformedSystem.some((value, index) => value !== channel.system[index]) ||
      systemHash(transformedSystem) !== channel.systemHash) {
    invalidateOpenCodeSystemTurn(deps, sessionID, channel.messageID)
    return refuse("transform-unavailable")
  }
  try { assertChannelCurrent(deps, channel, channel.messageID, channel.agent,
    channel.systemWasExplicit ? channel.system.join("\n\n") : undefined) }
  catch (error) {
    invalidateOpenCodeSystemTurn(deps, sessionID, channel.messageID)
    if (error instanceof UnsafeOpenCodeSystemChannel) throw error
    return refuse("policy-changed")
  }
  return channel.systemHash
}
