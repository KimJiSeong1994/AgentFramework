import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { isAbsolute, relative, sep } from "node:path"
import type { Message, Part, Session, ToolPart } from "@opencode-ai/sdk"
import type { HookDeps } from "../hooks/types.ts"
import { authenticatedSDKSessionIdentity, type SDKSessionIdentity } from "../sessions/sdk-transcript.ts"
import { captureOpenCodeToolTurn, isOpenCodeToolTurnCurrent, type OpenCodeToolTurn } from "./opencode-system.ts"

const MAX_RETAINED_CALL_IDS = 65_536
const MAX_ARGUMENT_BYTES = 1_048_576
const MAX_ARGUMENT_DEPTH = 64
const MAX_ARGUMENT_NODES = 50_000

const consumedCallIDs = new Set<string>()
const inFlightClaims = new Map<string, object>()
const admittedCalls = new Map<string, CallRecord>()
const callProofs = new WeakMap<object, CallRecord>()

export type UnsafeOpenCodeToolCallReason =
  | "invalid-call"
  | "foreign-session"
  | "stale-turn"
  | "disallowed-tool"
  | "ambiguous-call"
  | "missing-parent"
  | "changed-arguments"
  | "duplicate-call"
  | "capacity-exhausted"
  | "session-identity"
  | "lookup-failed"
  | "completed-call"

/** Typed refusal when an OpenCode tool callback cannot be bound to one exact admitted call. */
export class UnsafeOpenCodeToolCall extends Error {
  readonly code = "OTTER_UNSAFE_OPENCODE_TOOL_CALL"
  readonly reason: UnsafeOpenCodeToolCallReason

  constructor(reason: UnsafeOpenCodeToolCallReason) {
    super(`otter: OpenCode tool call refused (${reason})`)
    this.name = "UnsafeOpenCodeToolCall"
    this.reason = reason
  }
}

export type OpenCodeToolCallInput = Readonly<{
  sessionID: string
  callID: string
  tool: string
}>

export type OpenCodeToolCall = Readonly<{
  kind: "main" | "child"
  sessionID: string
  callID: string
  tool: string
  assistantMessageID: string
  userMessageID: string
  supervisorSessionID: string
  attachmentEpoch: string
  role: OpenCodeToolTurn["role"]
  policy: OpenCodeToolTurn["policy"]
  argsDigest: string
}>

type CallRecord = {
  readonly key: string
  readonly idKey: string
  readonly turn: OpenCodeToolTurn
  readonly value: OpenCodeToolCall
  readonly identity: SDKSessionIdentity
  completed: boolean
}

type SessionIdentity = Pick<Session, "id" | "directory" | "parentID" | "time">
type SessionMessage = { info: Message; parts: Part[] }

function refuse(reason: UnsafeOpenCodeToolCallReason): never {
  throw new UnsafeOpenCodeToolCall(reason)
}

function validID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_.:-]+$/.test(value)
}

function canonical(path: string): string {
  try { return realpathSync.native(path) }
  catch { return refuse("session-identity") }
}

function within(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path)
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
}

function stableJSON(value: unknown): string {
  let nodes = 0
  const ancestors = new Set<object>()
  const visit = (current: unknown, depth: number): string => {
    nodes++
    if (nodes > MAX_ARGUMENT_NODES || depth > MAX_ARGUMENT_DEPTH) return refuse("changed-arguments")
    if (current === null) return "null"
    if (typeof current === "string") return JSON.stringify(current)
    if (typeof current === "boolean") return current ? "true" : "false"
    if (typeof current === "number") return Number.isFinite(current) ? JSON.stringify(current) : refuse("changed-arguments")
    if (typeof current !== "object") return refuse("changed-arguments")
    if (ancestors.has(current)) return refuse("changed-arguments")
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        const descriptors = Object.getOwnPropertyDescriptors(current)
        const keys = Reflect.ownKeys(descriptors)
        if (keys.some(key => typeof key === "symbol" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) {
          return refuse("changed-arguments")
        }
        const values: string[] = []
        let byteLength = 2
        for (let index = 0; index < current.length; index++) {
          const descriptor = descriptors[String(index)]
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return refuse("changed-arguments")
          const encoded = visit(descriptor.value, depth + 1)
          values.push(encoded)
          byteLength += Buffer.byteLength(encoded, "utf8") + (index === 0 ? 0 : 1)
          if (byteLength > MAX_ARGUMENT_BYTES) return refuse("changed-arguments")
        }
        return `[${values.join(",")}]`
      }
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) return refuse("changed-arguments")
      const descriptors = Object.getOwnPropertyDescriptors(current)
      const keys = Reflect.ownKeys(descriptors)
      if (keys.some(key => typeof key !== "string")) return refuse("changed-arguments")
      const entries: string[] = []
      let byteLength = 2
      for (const key of (keys as string[]).sort()) {
        const descriptor = descriptors[key]!
        if (!("value" in descriptor) || !descriptor.enumerable) return refuse("changed-arguments")
        const encoded = `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`
        entries.push(encoded)
        byteLength += Buffer.byteLength(encoded, "utf8") + (entries.length === 1 ? 0 : 1)
        if (byteLength > MAX_ARGUMENT_BYTES) return refuse("changed-arguments")
      }
      return `{${entries.join(",")}}`
    } finally {
      ancestors.delete(current)
    }
  }
  const serialized = visit(value, 0)
  if (Buffer.byteLength(serialized, "utf8") > MAX_ARGUMENT_BYTES) return refuse("changed-arguments")
  return serialized
}

function argsDigest(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse("changed-arguments")
  return createHash("sha256").update(stableJSON(value)).digest("hex")
}

/** Check actual callback arguments against the exact retained call proof without a second serializer. */
export function openCodeToolCallArgumentsMatch(deps: HookDeps, value: unknown, args: unknown): boolean {
  if (!isOpenCodeToolCallCurrent(deps, value) || !value || typeof value !== "object") return false
  const record = callProofs.get(value)
  if (!record) return false
  try { return argsDigest(args) === record.value.argsDigest }
  catch { return false }
}

function validInput(value: OpenCodeToolCallInput): boolean {
  return !!value && typeof value === "object" && validID(value.sessionID) && validID(value.callID) && validID(value.tool)
}

function toolAllowed(turn: OpenCodeToolTurn, tool: string): boolean {
  return turn.policy.tools.allowed.includes(tool) && !turn.policy.tools.denied.includes(tool)
}

function ensureTurnCurrent(deps: HookDeps, turn: OpenCodeToolTurn): void {
  if (!isOpenCodeToolTurnCurrent(deps, turn)) return refuse("stale-turn")
}

function tupleKey(worktree: string, input: OpenCodeToolCallInput): string {
  return JSON.stringify([worktree, input.sessionID, input.callID, input.tool])
}

function idKey(worktree: string, input: OpenCodeToolCallInput): string {
  return JSON.stringify([worktree, input.sessionID, input.callID])
}

function authenticatedLifetimeMatches(
  worktree: string,
  sessionID: string,
  turn: OpenCodeToolTurn,
  identity: SDKSessionIdentity,
): boolean {
  const current = authenticatedSDKSessionIdentity(worktree, sessionID)
  if (!current || current.directory !== identity.directory || current.parentID !== identity.parentID ||
      current.parentEpoch !== identity.parentEpoch || current.createdAt !== identity.createdAt ||
      current.updatedAt !== identity.updatedAt) return false
  const expectedParentID = turn.kind === "child" ? turn.supervisorSessionID : undefined
  if (current.parentID !== expectedParentID) return false
  if (turn.kind === "child") {
    // Child authority is the exact durable execution binding and supervisor fence in the genuine turn.
    // parentEpoch is local transcript annotation, not a field furnished by the remote SDK.
    if (current.parentEpoch !== undefined && current.parentEpoch !== turn.attachmentEpoch) return false
  } else if (current.parentEpoch !== undefined) return false
  return true
}

function authenticatedIdentity(
  worktree: string,
  sessionID: string,
  directory: string,
  turn: OpenCodeToolTurn,
): SDKSessionIdentity | undefined {
  const identity = authenticatedSDKSessionIdentity(worktree, sessionID)
  if (!identity || canonical(identity.directory) !== directory ||
      identity.parentID !== (turn.kind === "child" ? turn.supervisorSessionID : undefined)) return undefined
  if (turn.kind === "child") {
    if (identity.parentEpoch !== undefined && identity.parentEpoch !== turn.attachmentEpoch) return undefined
  } else if (identity.parentEpoch !== undefined) return undefined
  return identity
}

function identityMatches(
  worktree: string,
  value: unknown,
  sessionID: string,
  directory: string,
  turn: OpenCodeToolTurn,
  identity: SDKSessionIdentity,
): { createdAt: number; updatedAt: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const candidate = value as Partial<SessionIdentity>
  if (candidate.id !== sessionID || typeof candidate.directory !== "string" || !candidate.time ||
      typeof candidate.time.created !== "number" || !Number.isFinite(candidate.time.created) || candidate.time.created < 0 ||
      typeof candidate.time.updated !== "number" || !Number.isFinite(candidate.time.updated) ||
      candidate.time.updated < candidate.time.created || candidate.time.created !== identity.createdAt ||
      candidate.parentID !== (turn.kind === "child" ? turn.supervisorSessionID : undefined) ||
      !authenticatedLifetimeMatches(worktree, sessionID, turn, identity)) return undefined
  try {
    if (canonical(candidate.directory) !== directory) return undefined
    return { createdAt: candidate.time.created, updatedAt: candidate.time.updated }
  } catch { return undefined }
}

function parseSessionMessages(value: unknown, sessionID: string): SessionMessage[] | undefined {
  if (!Array.isArray(value)) return undefined
  const messageIDs = new Set<string>()
  const partIDs = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
    const entry = item as Partial<SessionMessage>
    if (!entry.info || typeof entry.info !== "object" || !Array.isArray(entry.parts) ||
        entry.info.sessionID !== sessionID || !validID(entry.info.id) || messageIDs.has(entry.info.id) ||
        (entry.info.role !== "user" && entry.info.role !== "assistant") ||
        (entry.info.role === "assistant" && !validID(entry.info.parentID))) return undefined
    messageIDs.add(entry.info.id)
    for (const part of entry.parts) {
      if (!part || typeof part !== "object" || !validID(part.id) || partIDs.has(part.id) ||
          part.sessionID !== sessionID || part.messageID !== entry.info.id) return undefined
      if (part.type === "tool" && (!validID(part.callID) || !validID(part.tool) ||
          !part.state || typeof part.state !== "object" || !("input" in part.state))) return undefined
      partIDs.add(part.id)
    }
  }
  return value as SessionMessage[]
}

function canonicalCallParent(
  messages: SessionMessage[],
  sessionID: string,
  userMessageID: string,
  role: OpenCodeToolTurn["role"],
  assistantMessageID: string,
  callID: string,
  tool: string,
  expectedArgsDigest: string,
): "valid" | "missing-parent" | "changed-arguments" {
  if (messages.some(entry => entry.info.sessionID !== sessionID)) return "missing-parent"
  const users = messages.filter(entry => entry.info.id === userMessageID)
  if (users.length !== 1 || users[0]!.info.role !== "user" || users[0]!.info.agent !== role) return "missing-parent"
  const userMessages = messages.filter(entry => entry.info.role === "user")
  const latestUser = userMessages.length ? userMessages[userMessages.length - 1]!.info : undefined
  if (!latestUser || latestUser.id !== userMessageID) return "missing-parent"
  const user = users[0]!.info
  if (user.role !== "user" || user.id !== userMessageID) return "missing-parent"

  const matches: Array<{ entry: SessionMessage; part: ToolPart }> = []
  for (const entry of messages) {
    for (const part of entry.parts) {
      if (part.type === "tool" && part.callID === callID) matches.push({ entry, part })
    }
  }
  if (matches.length !== 1) return "missing-parent"
  const [{ entry, part }] = matches
  const assistantMessages = messages.filter(candidate => candidate.info.id === assistantMessageID)
  if (assistantMessages.length !== 1 || entry.info.role !== "assistant" || entry.info.id !== assistantMessageID ||
      entry.info.parentID !== userMessageID ||
      part.sessionID !== sessionID || part.messageID !== assistantMessageID || part.tool !== tool ||
      (part.state.status !== "pending" && part.state.status !== "running")) return "missing-parent"
  return argsDigest(part.state.input) === expectedArgsDigest ? "valid" : "changed-arguments"
}

/**
 * Admit only the exact pending/running SDK tool part whose assistant parent names this current user turn.
 * The SDK call is fetched in full; result content is never inspected or retained.
 */
export async function admitOpenCodeToolCall(
  deps: HookDeps,
  input: OpenCodeToolCallInput,
  args: unknown,
): Promise<OpenCodeToolCall | undefined> {
  if (!validInput(input)) return refuse("invalid-call")
  let turn: OpenCodeToolTurn | undefined
  try { turn = captureOpenCodeToolTurn(deps, input.sessionID) }
  catch { return refuse("stale-turn") }
  if (!turn) return undefined
  if (!toolAllowed(turn, input.tool)) return refuse("disallowed-tool")
  ensureTurnCurrent(deps, turn)
  const worktree = canonical(deps.worktree)
  const directory = canonical(deps.directory)
  if (!within(worktree, directory)) return refuse("session-identity")
  const identity = authenticatedIdentity(deps.worktree, input.sessionID, directory, turn)
  if (!identity) return refuse("session-identity")
  const beforeArgsDigest = argsDigest(args)
  const key = tupleKey(worktree, input)
  const consumedKey = idKey(worktree, input)
  if (consumedCallIDs.has(consumedKey)) return refuse("duplicate-call")
  if (consumedCallIDs.size >= MAX_RETAINED_CALL_IDS) return refuse("capacity-exhausted")
  const claim = Object.freeze({})
  consumedCallIDs.add(consumedKey)
  inFlightClaims.set(consumedKey, claim)

  try {
    ensureTurnCurrent(deps, turn)
    const sessionResult = await deps.client.session.get({ path: { id: input.sessionID }, query: { directory } })
    ensureTurnCurrent(deps, turn)
    if (inFlightClaims.get(consumedKey) !== claim) return refuse("duplicate-call")
    const initialRevision = sessionResult.error ? undefined :
      identityMatches(deps.worktree, sessionResult.data, input.sessionID, directory, turn, identity)
    if (!initialRevision) return refuse("session-identity")

    ensureTurnCurrent(deps, turn)
    const messagesResult = await deps.client.session.messages({ path: { id: input.sessionID }, query: { directory } })
    ensureTurnCurrent(deps, turn)
    if (inFlightClaims.get(consumedKey) !== claim) return refuse("duplicate-call")
    const messages = messagesResult.error ? undefined : parseSessionMessages(messagesResult.data, input.sessionID)
    if (!messages) return refuse("lookup-failed")
    if (!authenticatedLifetimeMatches(deps.worktree, input.sessionID, turn, identity)) return refuse("session-identity")
    ensureTurnCurrent(deps, turn)
    const confirmedSession = await deps.client.session.get({ path: { id: input.sessionID }, query: { directory } })
    ensureTurnCurrent(deps, turn)
    if (inFlightClaims.get(consumedKey) !== claim) return refuse("duplicate-call")
    if (confirmedSession.error) return refuse("session-identity")
    const finalRevision = identityMatches(deps.worktree, confirmedSession.data, input.sessionID, directory, turn, identity)
    if (!finalRevision || finalRevision.createdAt !== initialRevision.createdAt || finalRevision.updatedAt !== initialRevision.updatedAt) {
      return refuse("session-identity")
    }
    const toolParents = messages.flatMap(entry => entry.parts
      .filter((part): part is ToolPart => part.type === "tool" && part.callID === input.callID)
      .map(part => part.messageID))
    if (toolParents.length !== 1) return refuse("ambiguous-call")
    const assistantMessageID = toolParents[0]!
    if (!validID(assistantMessageID)) return refuse("missing-parent")
    const parentMatch = canonicalCallParent(messages, input.sessionID, turn.userMessageID, turn.role,
      assistantMessageID, input.callID, input.tool, beforeArgsDigest)
    if (parentMatch !== "valid") return refuse(parentMatch)
    if (argsDigest(args) !== beforeArgsDigest) return refuse("changed-arguments")
    ensureTurnCurrent(deps, turn)

    const value: OpenCodeToolCall = Object.freeze({
      kind: turn.kind,
      sessionID: input.sessionID,
      callID: input.callID,
      tool: input.tool,
      assistantMessageID,
      userMessageID: turn.userMessageID,
      supervisorSessionID: turn.supervisorSessionID,
      attachmentEpoch: turn.attachmentEpoch,
      role: turn.role,
      policy: turn.policy,
      argsDigest: beforeArgsDigest,
    })
    const record: CallRecord = {
      key, idKey: consumedKey, turn, value, identity, completed: false,
    }
    if (inFlightClaims.get(consumedKey) !== claim || admittedCalls.has(key)) return refuse("duplicate-call")
    admittedCalls.set(key, record)
    callProofs.set(value, record)
    inFlightClaims.delete(consumedKey)
    return value
  } catch (error) {
    if (inFlightClaims.get(consumedKey) === claim) inFlightClaims.delete(consumedKey)
    if (error instanceof UnsafeOpenCodeToolCall) throw error
    return refuse("lookup-failed")
  }
}

/** Look up the exact live call for a loader/after hook; an optional assistant ID must match SDK history proof. */
export function currentOpenCodeToolCall(
  deps: HookDeps,
  input: OpenCodeToolCallInput & { assistantMessageID?: string },
): OpenCodeToolCall | undefined {
  if (!validInput(input)) return refuse("invalid-call")
  let turn: OpenCodeToolTurn | undefined
  try { turn = captureOpenCodeToolTurn(deps, input.sessionID) }
  catch { return refuse("stale-turn") }
  if (!turn) return undefined
  if (!toolAllowed(turn, input.tool)) return refuse("disallowed-tool")
  const key = tupleKey(canonical(deps.worktree), input)
  const record = admittedCalls.get(key)
  if (!record) return refuse(consumedCallIDs.has(idKey(canonical(deps.worktree), input)) ? "completed-call" : "missing-parent")
  if (record.value.assistantMessageID !== input.assistantMessageID && input.assistantMessageID !== undefined) {
    return refuse("stale-turn")
  }
  if (record.turn.kind !== turn.kind || record.turn.sessionID !== turn.sessionID ||
      record.turn.userMessageID !== turn.userMessageID || record.turn.supervisorSessionID !== turn.supervisorSessionID ||
      record.turn.attachmentEpoch !== turn.attachmentEpoch || record.turn.role !== turn.role || record.turn.policy !== turn.policy ||
      !isOpenCodeToolCallCurrent(deps, record.value)) return refuse("stale-turn")
  return record.value
}

/** Check both the opaque call object and its exact still-current system turn. */
export function isOpenCodeToolCallCurrent(deps: HookDeps, value: unknown): value is OpenCodeToolCall {
  if (!value || typeof value !== "object") return false
  const record = callProofs.get(value)
  if (!record || record.completed || admittedCalls.get(record.key) !== record) return false
  const candidate = value as OpenCodeToolCall
  if (candidate.kind !== record.value.kind || candidate.sessionID !== record.value.sessionID || candidate.callID !== record.value.callID ||
      candidate.tool !== record.value.tool || candidate.assistantMessageID !== record.value.assistantMessageID ||
      candidate.userMessageID !== record.value.userMessageID || candidate.supervisorSessionID !== record.value.supervisorSessionID ||
      candidate.attachmentEpoch !== record.value.attachmentEpoch || candidate.role !== record.value.role ||
      candidate.policy !== record.value.policy || candidate.argsDigest !== record.value.argsDigest) return false
  return authenticatedLifetimeMatches(deps.worktree, candidate.sessionID, record.turn, record.identity) &&
    isOpenCodeToolTurnCurrent(deps, record.turn)
}

/** Consume a current call's terminal observation exactly once; stale completions cannot touch replacement calls. */
export function completeOpenCodeToolCall(deps: HookDeps, value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const record = callProofs.get(value)
  if (!record || record.completed || admittedCalls.get(record.key) !== record) return false
  const current = isOpenCodeToolCallCurrent(deps, value)
  record.completed = true
  admittedCalls.delete(record.key)
  return current
}
