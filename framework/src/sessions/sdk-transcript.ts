import type { AssistantMessage, Message, Part, TextPart } from "@opencode-ai/sdk"
import { admissionEpoch, holdAdmission, isAdmissionCurrent } from "./admission.ts"
import { getOwnedSession, replaySession } from "./store.ts"

export const SDK_TRANSCRIPT_MESSAGE_LIMIT = 200
const MAX_TRACKED_SESSION_LIFETIMES = 4096
const MAX_EXPIRED_USER_BINDINGS = 20_000
const MAX_EXPIRED_ASSISTANT_BINDINGS = 20_000
const MAX_LIFETIMES_PER_SESSION = 200
const SDK_SESSION_CREATION_WAIT_MS = 5_000

type Role = "user" | "assistant"
type MessageCapture = { role: Role; epoch: string; ownerSessionID: string }
type UserCapture = { epoch: string; ownerSessionID: string }
type AssistantCapture = { epoch: string; parentID: string; ownerSessionID: string }
export type SDKSessionIdentity = Readonly<{ directory: string; parentID?: string; parentEpoch?: string; createdAt: number; updatedAt?: number }>
type AppendResult =
  | { status: "written" | "duplicate" | "empty" | "incomplete" | "stale" }
  | { status: "failed"; error: unknown; holdError?: unknown }

const userCaptures = new Map<string, UserCapture>()
const assistantCaptures = new Map<string, AssistantCapture>()
// Expired captures are authority tombstones: they are never evicted or rebound to a later epoch.
const expiredUserBindings = new Map<string, UserCapture>()
const expiredAssistantBindings = new Map<string, AssistantCapture>()
let userCaptureRegistryExhausted = false
let assistantCaptureRegistryExhausted = false
const sessionLifetimes = new Map<string, Array<{ epoch: string; createdAt?: number }>>()
const sdkSessionOwners = new Map<string, Array<{ ownerSessionID: string; ownerEpoch: string; createdAt?: number }>>()
const sessionLifetimeOverflow = new Set<string>()
const sessionLifetimeConflict = new Set<string>()
const sdkSessionOwnerOverflow = new Set<string>()
const sessionIdentities = new Map<string, SDKSessionIdentity[]>()
const sessionIdentityOverflow = new Set<string>()
const sdkCreationObservations = new Map<string, Set<string>>()
const sdkCreationObservationOverflow = new Set<string>()
const pendingSDKSessionCreations = new Map<string, { count: number; waiters: Set<() => void> }>()
const toolTerminalStatuses = new Map<string, "succeeded" | "failed" | "denied">()
const toolConflicts = new Map<string, true>()

function key(worktree: string, sessionID: string, messageID: string): string {
  return JSON.stringify([worktree, sessionID, messageID])
}

/** Mark a genuine session.created handler active before its first SDK lookup await. */
export function registerPendingSDKSessionCreation(worktree: string, sessionID: string): () => void {
  if (!validID(sessionID)) return () => {}
  const id = key(worktree, sessionID, "@pending-created")
  let activity = pendingSDKSessionCreations.get(id)
  if ((!activity && pendingSDKSessionCreations.size >= MAX_TRACKED_SESSION_LIFETIMES) ||
      (activity && activity.count >= MAX_LIFETIMES_PER_SESSION)) {
    throw new Error("SDK session creation activity capacity exceeded")
  }
  if (!activity) pendingSDKSessionCreations.set(id, activity = { count: 0, waiters: new Set() })
  activity.count++
  let registered = true
  return () => {
    if (!registered) return
    registered = false
    if (pendingSDKSessionCreations.get(id) !== activity) return
    activity!.count--
    if (activity!.count === 0) pendingSDKSessionCreations.delete(id)
    for (const notify of [...activity!.waiters]) notify()
  }
}

/** Wait for current genuine creation handlers before taking the fresh-session admission snapshot. */
export async function waitForPendingSDKSessionCreation(
  worktree: string,
  sessionID: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!validID(sessionID)) return false
  const id = key(worktree, sessionID, "@pending-created")
  const deadline = Date.now() + SDK_SESSION_CREATION_WAIT_MS
  while (true) {
    if (signal?.aborted) return false
    const activity = pendingSDKSessionCreations.get(id)
    if (!activity || activity.count === 0) return true
    if (activity.waiters.size >= MAX_LIFETIMES_PER_SESSION) return false
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    const completed = await new Promise<boolean>(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const cleanup = () => {
        clearTimeout(timer)
        activity.waiters.delete(check)
        signal?.removeEventListener("abort", abort)
      }
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const check = () => {
        if (activity.count === 0) finish(true)
      }
      const abort = () => finish(false)
      timer = setTimeout(abort, remaining)
      signal?.addEventListener("abort", abort, { once: true })
      activity.waiters.add(check)
      if (signal?.aborted) abort()
      else if (activity.count === 0) check()
    })
    if (!completed) return false
  }
}

function remember<K, V>(map: Map<K, V>, id: K, value: V): void {
  map.delete(id)
  map.set(id, value)
  while (map.size > SDK_TRANSCRIPT_MESSAGE_LIMIT) {
    const first = map.keys().next().value as K
    map.delete(first)
  }
}

function captureCapacityExhausted(): boolean {
  return userCaptureRegistryExhausted || assistantCaptureRegistryExhausted
}

function holdExpiredSDKCallback(
  worktree: string,
  sessionID: string,
  messageID: string,
  capture: UserCapture | AssistantCapture,
): void {
  holdSDKTranscriptIncomplete(worktree, sessionID, messageID, capture.ownerSessionID, capture.epoch)
}

function rememberUserCapture(worktree: string, sessionID: string, messageID: string, value: UserCapture): boolean {
  const id = key(worktree, sessionID, messageID)
  if (userCaptureRegistryExhausted) return false
  if (userCaptures.has(id)) {
    remember(userCaptures, id, value)
    return true
  }
  if (userCaptures.size >= SDK_TRANSCRIPT_MESSAGE_LIMIT && expiredUserBindings.size >= MAX_EXPIRED_USER_BINDINGS) {
    userCaptureRegistryExhausted = true
    return false
  }
  if (userCaptures.size >= SDK_TRANSCRIPT_MESSAGE_LIMIT) {
    const firstID = userCaptures.keys().next().value as string
    const first = userCaptures.get(firstID)!
    userCaptures.delete(firstID)
    expiredUserBindings.set(firstID, first)
  }
  userCaptures.set(id, value)
  return true
}

function rememberAssistantCapture(worktree: string, sessionID: string, messageID: string, value: AssistantCapture): boolean {
  const id = key(worktree, sessionID, messageID)
  if (assistantCaptureRegistryExhausted) return false
  if (assistantCaptures.has(id)) {
    remember(assistantCaptures, id, value)
    return true
  }
  if (assistantCaptures.size >= SDK_TRANSCRIPT_MESSAGE_LIMIT && expiredAssistantBindings.size >= MAX_EXPIRED_ASSISTANT_BINDINGS) {
    assistantCaptureRegistryExhausted = true
    return false
  }
  if (assistantCaptures.size >= SDK_TRANSCRIPT_MESSAGE_LIMIT) {
    const firstID = assistantCaptures.keys().next().value as string
    const first = assistantCaptures.get(firstID)!
    assistantCaptures.delete(firstID)
    expiredAssistantBindings.set(firstID, first)
  }
  assistantCaptures.set(id, value)
  return true
}

export function canCaptureSDKUserMessage(worktree: string, sessionID: string, messageID: string): boolean {
  if (!validID(sessionID) || !validID(messageID)) return false
  const id = key(worktree, sessionID, messageID)
  return !captureCapacityExhausted() && !userCaptures.has(id) && !expiredUserBindings.has(id) &&
    (userCaptures.size < SDK_TRANSCRIPT_MESSAGE_LIMIT || expiredUserBindings.size < MAX_EXPIRED_USER_BINDINGS)
}

function validID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
}

function appendText(
  worktree: string,
  sessionID: string,
  messageID: string,
  role: Role,
  text: string,
  epoch: string,
): AppendResult {
  if (!isAdmissionCurrent(worktree, sessionID, epoch)) return { status: "stale" }
  const store = getOwnedSession(worktree, sessionID)
  if (!store || store.sessionID !== sessionID || store.epoch !== epoch) return { status: "stale" }
  try {
    const latest = replaySession(worktree, sessionID, { order: "desc", limit: 1 })
    if (!latest.complete || latest.totalRecords === undefined) throw new Error("cannot verify the existing SDK transcript tail")
    const record = store.append(role, { text }, `opencode:${role}:${messageID}`)
    if (record.seq <= latest.totalRecords) return { status: "duplicate" }
    if (record.seq !== latest.totalRecords + 1) throw new Error("SDK transcript sequence changed during append")
  } catch (error) {
    let holdError: unknown
    if (isAdmissionCurrent(worktree, sessionID, epoch)) {
      try {
        holdAdmission(worktree, sessionID, "sdk_transcript_append_failed")
      } catch (failure) {
        holdError = failure
      }
    }
    return { status: "failed", error, ...(holdError === undefined ? {} : { holdError }) }
  }
  if (!isAdmissionCurrent(worktree, sessionID, epoch) || getOwnedSession(worktree, sessionID)?.epoch !== epoch) {
    return { status: "stale" }
  }
  return { status: "written" }
}

function holdCapturedEpoch(worktree: string, sessionID: string, epoch: string): unknown | undefined {
  if (getOwnedSession(worktree, sessionID)?.epoch !== epoch) return undefined
  try {
    holdAdmission(worktree, sessionID, "sdk_transcript_append_failed")
    return undefined
  } catch (error) {
    return error
  }
}

function failForEpoch(worktree: string, sessionID: string, epoch: string, error: unknown): AppendResult {
  const holdError = holdCapturedEpoch(worktree, sessionID, epoch)
  return { status: "failed", error, ...(holdError === undefined ? {} : { holdError }) }
}

/** Hold only the epoch captured by a message callback and leave durable evidence without retaining message bodies. */
export function holdSDKTranscriptIncomplete(
  worktree: string,
  sdkSessionID: string,
  messageID: string,
  ownerSessionID: string,
  ownerEpoch: string,
): AppendResult {
  if (![sdkSessionID, messageID, ownerSessionID, ownerEpoch].every(validID)) return { status: "stale" }
  const store = getOwnedSession(worktree, ownerSessionID)
  if (!store || store.sessionID !== ownerSessionID || store.epoch !== ownerEpoch) return { status: "stale" }
  const eventID = `opencode:transcript-incomplete:${JSON.stringify([sdkSessionID, messageID])}`
  const text = "SDK transcript provenance was unavailable; associated message or tool history may be incomplete."
  let error: unknown
  try {
    const record = store.append("notice", { text }, eventID)
    if (record.data.text !== text) error = new Error("SDK transcript incomplete notice conflicts with existing event")
  } catch (failure) {
    error = failure
  }
  let holdError: unknown
  if (getOwnedSession(worktree, ownerSessionID)?.epoch === ownerEpoch) {
    try { holdAdmission(worktree, ownerSessionID, "sdk_transcript_provenance_lost") }
    catch (failure) { holdError = failure }
  }
  return error === undefined && holdError === undefined
    ? { status: "failed", error: new Error("SDK transcript provenance was lost; owner held") }
    : { status: "failed", error: error ?? new Error("SDK transcript provenance was lost; owner held"), ...(holdError === undefined ? {} : { holdError }) }
}

/** Bind a session.deleted event to identity captured when the SDK session itself was authenticated. */
export function captureSDKSessionLifetime(
  worktree: string,
  sessionID: string,
  epoch: string,
  createdAt?: number,
): boolean {
  if (!validID(sessionID) || !validID(epoch) || (createdAt !== undefined && (!Number.isFinite(createdAt) || createdAt < 0))) return false
  const id = key(worktree, sessionID, "@lifetime")
  if (sessionLifetimeOverflow.has(id) || sessionLifetimeConflict.has(id)) return false
  const entries = sessionLifetimes.get(id) ?? []
  const sameEpoch = entries.filter(entry => entry.epoch === epoch)
  if (sameEpoch.some(entry => entry.createdAt === createdAt)) return true
  if (createdAt === undefined && sameEpoch.some(entry => entry.createdAt !== undefined)) return true
  if (createdAt !== undefined && sameEpoch.some(entry => entry.createdAt !== undefined && entry.createdAt !== createdAt)) {
    sessionLifetimeConflict.add(id)
    return false
  }
  if (sessionLifetimes.size >= MAX_TRACKED_SESSION_LIFETIMES && !sessionLifetimes.has(id)) return false
  if (entries.length >= MAX_LIFETIMES_PER_SESSION) {
    sessionLifetimeOverflow.add(id)
    return false
  }
  entries.push({ epoch, ...(createdAt === undefined ? {} : { createdAt }) })
  sessionLifetimes.set(id, entries)
  return true
}

/** Resolve only an unambiguous lifetime; a missing timestamp is usable only for one captured epoch. */
export function capturedSDKSessionDeletionEpoch(worktree: string, sessionID: string, createdAt?: number): string | undefined {
  const id = key(worktree, sessionID, "@lifetime")
  if (sessionLifetimeConflict.has(id)) return undefined
  const entries = sessionLifetimes.get(id) ?? []
  if (createdAt !== undefined && (!Number.isFinite(createdAt) || createdAt < 0)) return undefined
  const candidates = createdAt === undefined
    ? entries
    : entries.filter(entry => entry.createdAt === createdAt || (!sessionLifetimeOverflow.has(id) && entry.createdAt === undefined))
  const epochs = new Set(candidates.map(entry => entry.epoch))
  return epochs.size === 1 ? [...epochs][0] : undefined
}

function validSessionIdentity(sessionID: string, identity: SDKSessionIdentity): boolean {
  return validID(sessionID) && typeof identity.directory === "string" && identity.directory.length > 0 && identity.directory.length <= 4096 &&
    Number.isFinite(identity.createdAt) && identity.createdAt >= 0 &&
    (identity.updatedAt === undefined || (Number.isFinite(identity.updatedAt) && identity.updatedAt >= 0)) &&
    (identity.parentID === undefined || validID(identity.parentID)) &&
    (identity.parentEpoch === undefined || (validID(identity.parentID) && validID(identity.parentEpoch)))
}

function sessionLifetimeFingerprint(identity: SDKSessionIdentity): string {
  return JSON.stringify([identity.directory, identity.parentID ?? null, identity.parentEpoch ?? null,
    identity.createdAt])
}

/** Store identity fields only after a caller authenticated the SDK response and canonical worktree. */
export function captureSDKSessionIdentity(worktree: string, sessionID: string, identity: SDKSessionIdentity): boolean {
  if (!validSessionIdentity(sessionID, identity)) return false
  const id = key(worktree, sessionID, "@identity")
  if (sessionIdentityOverflow.has(id)) return false
  const entries = sessionIdentities.get(id) ?? []
  const existingIndex = entries.findIndex(entry => entry.directory === identity.directory &&
    entry.parentID === identity.parentID && entry.parentEpoch === identity.parentEpoch && entry.createdAt === identity.createdAt)
  if (existingIndex >= 0) {
    // updatedAt is a mutable revision; retain the newest observation without letting delayed reads rewind it.
    const existing = entries[existingIndex]!
    if (identity.updatedAt !== undefined && (existing.updatedAt === undefined || identity.updatedAt > existing.updatedAt)) {
      entries[existingIndex] = { ...existing, updatedAt: identity.updatedAt }
    }
    return true
  }
  if (sessionIdentities.size >= MAX_TRACKED_SESSION_LIFETIMES && !sessionIdentities.has(id)) return false
  if (entries.length >= MAX_LIFETIMES_PER_SESSION) {
    sessionIdentityOverflow.add(id)
    return false
  }
  entries.push({ ...identity })
  sessionIdentities.set(id, entries)
  return true
}

/** Record an authenticated session.created event separately from later session.get cache population. */
export function captureSDKSessionCreationObservation(worktree: string, sessionID: string, identity: SDKSessionIdentity): boolean {
  if (!validSessionIdentity(sessionID, identity)) return false
  if (!captureSDKSessionIdentity(worktree, sessionID, identity)) return false
  const authenticated = authenticatedSDKSessionIdentity(worktree, sessionID)
  if (!authenticated || sessionLifetimeFingerprint(authenticated) !== sessionLifetimeFingerprint(identity)) return false
  const id = key(worktree, sessionID, "@created")
  if (sdkCreationObservationOverflow.has(id)) return false
  let identities = sdkCreationObservations.get(id)
  if (!identities) {
    if (sdkCreationObservations.size >= MAX_TRACKED_SESSION_LIFETIMES) return false
    sdkCreationObservations.set(id, identities = new Set())
  }
  const fingerprint = sessionLifetimeFingerprint(identity)
  if (identities.has(fingerprint)) return true
  if (identities.size >= MAX_LIFETIMES_PER_SESSION) {
    sdkCreationObservationOverflow.add(id)
    return false
  }
  identities.add(fingerprint)
  return true
}

export function hasSDKSessionCreationObservation(worktree: string, sessionID: string, identity: SDKSessionIdentity): boolean {
  if (!validSessionIdentity(sessionID, identity)) return false
  const id = key(worktree, sessionID, "@created")
  return !sdkCreationObservationOverflow.has(id) &&
    sdkCreationObservations.get(id)?.has(sessionLifetimeFingerprint(identity)) === true
}

/** Return only a single authenticated SDK lifetime; conflicting reused IDs remain unbound. */
export function authenticatedSDKSessionIdentity(worktree: string, sessionID: string): SDKSessionIdentity | undefined {
  const id = key(worktree, sessionID, "@identity")
  if (sessionIdentityOverflow.has(id)) return undefined
  const entries = sessionIdentities.get(id) ?? []
  if (entries.length !== 1) return undefined
  return { ...entries[0]! }
}

/** Register an authenticated child-session parent binding without retaining or persisting its prompt. */
export function captureSDKSessionOwner(
  worktree: string,
  sessionID: string,
  ownerSessionID: string | undefined,
  createdAt: number | undefined,
): void {
  if (!validID(sessionID) || !validID(ownerSessionID) || (createdAt !== undefined && (!Number.isFinite(createdAt) || createdAt < 0))) return
  const ownerEpoch = admissionEpoch(worktree, ownerSessionID)
  if (!ownerEpoch) return
  const id = key(worktree, sessionID, "@owner")
  const entries = sdkSessionOwners.get(id) ?? []
  if (entries.some(entry => entry.ownerSessionID === ownerSessionID && entry.ownerEpoch === ownerEpoch && entry.createdAt === createdAt)) return
  if (sdkSessionOwners.size >= MAX_TRACKED_SESSION_LIFETIMES && !sdkSessionOwners.has(id)) return
  if (entries.length >= MAX_LIFETIMES_PER_SESSION) {
    sdkSessionOwnerOverflow.add(id)
    return
  }
  entries.push({ ownerSessionID, ownerEpoch, ...(createdAt === undefined ? {} : { createdAt }) })
  sdkSessionOwners.set(id, entries)
}

export function capturedSDKSessionOwner(worktree: string, sessionID: string): { ownerSessionID: string; ownerEpoch: string } | undefined {
  const id = key(worktree, sessionID, "@owner")
  if (sdkSessionOwnerOverflow.has(id)) return undefined
  const entries = sdkSessionOwners.get(id) ?? []
  const pairs = new Map(entries.map(entry => [JSON.stringify([entry.ownerSessionID, entry.ownerEpoch]), entry]))
  if (pairs.size !== 1) return undefined
  return pairs.values().next().value as { ownerSessionID: string; ownerEpoch: string } | undefined
}

function ownerForSDKSession(worktree: string, sessionID: string): { ownerSessionID: string; ownerEpoch: string } | undefined {
  const owner = capturedSDKSessionOwner(worktree, sessionID)
  if (!owner || !isAdmissionCurrent(worktree, owner.ownerSessionID, owner.ownerEpoch)) return undefined
  return owner
}

/** Read an already captured message identity without treating it as current authority. */
export function capturedSDKMessage(worktree: string, sessionID: string, messageID: string): MessageCapture | undefined {
  const id = key(worktree, sessionID, messageID)
  const assistant = assistantCaptures.get(id)
  if (assistant) {
    if (captureCapacityExhausted()) {
      holdExpiredSDKCallback(worktree, sessionID, messageID, assistant)
      return undefined
    }
    return { role: "assistant", epoch: assistant.epoch, ownerSessionID: assistant.ownerSessionID }
  }
  const user = userCaptures.get(id)
  if (user) {
    if (captureCapacityExhausted()) {
      holdExpiredSDKCallback(worktree, sessionID, messageID, user)
      return undefined
    }
    return { role: "user", epoch: user.epoch, ownerSessionID: user.ownerSessionID }
  }
  const expiredAssistant = expiredAssistantBindings.get(id)
  if (expiredAssistant) {
    holdExpiredSDKCallback(worktree, sessionID, messageID, expiredAssistant)
    return undefined
  }
  const expiredUser = expiredUserBindings.get(id)
  if (expiredUser) holdExpiredSDKCallback(worktree, sessionID, messageID, expiredUser)
  return undefined
}

/** Persist a real main-agent user turn before chat.message is allowed to rewrite or route it. */
export function persistMainUserMessage(
  worktree: string,
  sessionID: string,
  messageID: string,
  text: string,
  epoch: string,
): AppendResult {
  if (!validID(sessionID) || !validID(messageID) || !isAdmissionCurrent(worktree, sessionID, epoch)) return { status: "stale" }
  const id = key(worktree, sessionID, messageID)
  const expired = expiredUserBindings.get(id)
  if (expired) {
    holdExpiredSDKCallback(worktree, sessionID, messageID, expired)
    return { status: "stale" }
  }
  if (captureCapacityExhausted()) {
    holdSDKTranscriptIncomplete(worktree, sessionID, messageID, sessionID, epoch)
    return { status: "failed", error: new Error("SDK message binding capacity is exhausted") }
  }
  const existing = userCaptures.get(id)
  if (existing) {
    if (existing.epoch !== epoch || existing.ownerSessionID !== sessionID || !isAdmissionCurrent(worktree, sessionID, existing.epoch)) return { status: "stale" }
    const result = appendText(worktree, sessionID, messageID, "user", text, epoch)
    if (result.status === "failed" || result.status === "stale") return result
    remember(userCaptures, id, existing)
    return result
  }
  if (userCaptureRegistryExhausted ||
      (userCaptures.size >= SDK_TRANSCRIPT_MESSAGE_LIMIT && expiredUserBindings.size >= MAX_EXPIRED_USER_BINDINGS)) {
    userCaptureRegistryExhausted = true
    holdSDKTranscriptIncomplete(worktree, sessionID, messageID, sessionID, epoch)
    return { status: "failed", error: new Error("SDK user-message binding capacity is exhausted") }
  }

  const result = appendText(worktree, sessionID, messageID, "user", text, epoch)
  if (result.status === "written") {
    if (!rememberUserCapture(worktree, sessionID, messageID, { epoch, ownerSessionID: sessionID })) {
      holdSDKTranscriptIncomplete(worktree, sessionID, messageID, sessionID, epoch)
      return { status: "failed", error: new Error("SDK user-message binding capacity is exhausted") }
    }
  }
  return result.status === "duplicate" ? { status: "stale" } : result
}

/** Return a remembered parent epoch even when it is stale; callers must not rebind that callback to today's epoch. */
export function capturedUserMessageEpoch(worktree: string, sessionID: string, messageID: string): string | undefined {
  const id = key(worktree, sessionID, messageID)
  return userCaptures.get(id)?.epoch ?? expiredUserBindings.get(id)?.epoch
}

/** Capture host messages only under a main accepted turn or an authenticated child-session parent epoch. */
export function captureSDKMessage(worktree: string, value: Message): MessageCapture | undefined {
  const info = value as Message & { id?: unknown; sessionID?: unknown; role?: unknown; parentID?: unknown }
  if (!validID(info.sessionID) || !validID(info.id)) return undefined
  const sessionID = info.sessionID
  const messageID = info.id
  const id = key(worktree, sessionID, messageID)

  if (info.role === "user") {
    const expired = expiredUserBindings.get(id)
    if (expired) {
      holdExpiredSDKCallback(worktree, sessionID, messageID, expired)
      return undefined
    }
    let captured = userCaptures.get(id)
    if (!captured) {
      const owner = ownerForSDKSession(worktree, sessionID)
      if (!owner) return undefined
      captured = { epoch: owner.ownerEpoch, ownerSessionID: owner.ownerSessionID }
      if (!rememberUserCapture(worktree, sessionID, messageID, captured)) {
        holdSDKTranscriptIncomplete(worktree, sessionID, messageID, captured.ownerSessionID, captured.epoch)
        return undefined
      }
    }
    if (captureCapacityExhausted()) {
      holdExpiredSDKCallback(worktree, sessionID, messageID, captured)
      return undefined
    }
    if (!isAdmissionCurrent(worktree, captured.ownerSessionID, captured.epoch)) {
      holdExpiredSDKCallback(worktree, sessionID, messageID, captured)
      return undefined
    }
    remember(userCaptures, id, captured)
    return { role: "user", epoch: captured.epoch, ownerSessionID: captured.ownerSessionID }
  }
  if (info.role !== "assistant" || !validID(info.parentID)) return undefined

  const existing = assistantCaptures.get(id)
  if (existing) {
    if (captureCapacityExhausted()) {
      holdExpiredSDKCallback(worktree, sessionID, messageID, existing)
      return undefined
    }
    if (existing.parentID !== info.parentID) return undefined
    if (!isAdmissionCurrent(worktree, existing.ownerSessionID, existing.epoch)) {
      holdExpiredSDKCallback(worktree, sessionID, messageID, existing)
      return undefined
    }
    remember(assistantCaptures, id, existing)
    return { role: "assistant", epoch: existing.epoch, ownerSessionID: existing.ownerSessionID }
  }

  const expiredAssistant = expiredAssistantBindings.get(id)
  if (expiredAssistant) {
    holdExpiredSDKCallback(worktree, sessionID, messageID, expiredAssistant)
    return undefined
  }

  const parentKey = key(worktree, sessionID, info.parentID)
  const parent = userCaptures.get(parentKey)
  if (!parent) {
    const expiredParent = expiredUserBindings.get(parentKey)
    if (expiredParent) holdExpiredSDKCallback(worktree, sessionID, messageID, expiredParent)
    return undefined
  }
  if (!isAdmissionCurrent(worktree, parent.ownerSessionID, parent.epoch)) {
    holdExpiredSDKCallback(worktree, sessionID, messageID, parent)
    return undefined
  }
  if (captureCapacityExhausted()) {
    holdExpiredSDKCallback(worktree, sessionID, messageID, parent)
    return undefined
  }

  remember(userCaptures, parentKey, parent)
  const assistant = { epoch: parent.epoch, parentID: info.parentID, ownerSessionID: parent.ownerSessionID }
  if (!rememberAssistantCapture(worktree, sessionID, messageID, assistant)) {
    holdSDKTranscriptIncomplete(worktree, sessionID, messageID, assistant.ownerSessionID, assistant.epoch)
    return undefined
  }
  return { role: "assistant", epoch: parent.epoch, ownerSessionID: parent.ownerSessionID }
}

/** Resolve an observed part to an already captured SDK message without treating the part as authoritative text. */
export function captureSDKTextPart(worktree: string, part: TextPart): MessageCapture | undefined {
  if (!validID(part.sessionID) || !validID(part.messageID) || !validID(part.id) || typeof part.text !== "string") return undefined
  return captureForMessage(worktree, part.sessionID, part.messageID)
}

/** Persist a canonical full SDK message only after completion and matching the captured parent epoch. */
export async function persistCompletedAssistantMessage(
  worktree: string,
  info: AssistantMessage,
  readMessage: () => Promise<{ data?: unknown; error?: unknown }>,
): Promise<AppendResult> {
  const capture = captureSDKMessage(worktree, info)
  if (!capture || capture.role !== "assistant") return { status: "stale" }
  if (capture.ownerSessionID !== info.sessionID) return { status: "empty" }
  const completedAt = info.time?.completed
  if (typeof completedAt !== "number" || !Number.isFinite(completedAt) || completedAt < 0) return { status: "incomplete" }

  if (!isAdmissionCurrent(worktree, capture.ownerSessionID, capture.epoch)) return { status: "stale" }
  let response: { data?: unknown; error?: unknown }
  try {
    response = await readMessage()
  } catch (error) {
    if (!isAdmissionCurrent(worktree, capture.ownerSessionID, capture.epoch)) return { status: "stale" }
    return failForEpoch(worktree, capture.ownerSessionID, capture.epoch, error)
  }
  if (!isAdmissionCurrent(worktree, capture.ownerSessionID, capture.epoch)) return { status: "stale" }
  if (response.error !== undefined || !response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
    return failForEpoch(worktree, capture.ownerSessionID, capture.epoch, new Error("OpenCode canonical message read returned no message"))
  }
  const canonical = response.data as { info?: unknown; parts?: unknown }
  const canonicalInfo = canonical.info as Partial<AssistantMessage> | undefined
  if (!canonicalInfo || canonicalInfo.role !== "assistant" || canonicalInfo.id !== info.id || canonicalInfo.sessionID !== info.sessionID ||
      canonicalInfo.parentID !== info.parentID || !canonicalInfo.time || typeof canonicalInfo.time.completed !== "number" ||
      !Number.isFinite(canonicalInfo.time.completed) || canonicalInfo.time.completed < 0 || canonicalInfo.time.completed !== completedAt ||
      !Array.isArray(canonical.parts)) {
    return failForEpoch(worktree, capture.ownerSessionID, capture.epoch, new Error("OpenCode canonical message identity or completion did not match"))
  }
  let text = ""
  const textIDs = new Set<string>()
  for (const candidate of canonical.parts as Part[]) {
    if (!candidate || candidate.type !== "text") continue
    const part = candidate as TextPart
    if (!validID(part.id) || part.sessionID !== info.sessionID || part.messageID !== info.id || typeof part.text !== "string" || textIDs.has(part.id)) {
      return failForEpoch(worktree, capture.ownerSessionID, capture.epoch, new Error("OpenCode canonical text part identity is invalid"))
    }
    textIDs.add(part.id)
    if (part.synthetic !== true && part.ignored !== true) text += part.text
  }
  if (!isAdmissionCurrent(worktree, capture.ownerSessionID, capture.epoch)) return { status: "stale" }
  if (text.length === 0) return { status: "empty" }

  const result = appendText(worktree, capture.ownerSessionID, info.id, "assistant", text, capture.epoch)
  return result
}

/** Return an active capture only while its captured owner epoch remains the current admission. */
export function captureForMessage(worktree: string, sessionID: string, messageID: string): MessageCapture | undefined {
  const id = key(worktree, sessionID, messageID)
  const assistant = assistantCaptures.get(id)
  if (assistant) {
    if (captureCapacityExhausted()) {
      holdExpiredSDKCallback(worktree, sessionID, messageID, assistant)
      return undefined
    }
    if (!isAdmissionCurrent(worktree, assistant.ownerSessionID, assistant.epoch)) {
      holdExpiredSDKCallback(worktree, sessionID, messageID, assistant)
      return undefined
    }
    remember(assistantCaptures, id, assistant)
    return { role: "assistant", epoch: assistant.epoch, ownerSessionID: assistant.ownerSessionID }
  }
  const user = userCaptures.get(id)
  if (user && captureCapacityExhausted()) {
    holdExpiredSDKCallback(worktree, sessionID, messageID, user)
    return undefined
  }
  if (user && !isAdmissionCurrent(worktree, user.ownerSessionID, user.epoch)) {
    holdExpiredSDKCallback(worktree, sessionID, messageID, user)
    return undefined
  }
  if (!user) {
    const expiredAssistant = expiredAssistantBindings.get(id)
    if (expiredAssistant) holdExpiredSDKCallback(worktree, sessionID, messageID, expiredAssistant)
    else {
      const expiredUser = expiredUserBindings.get(id)
      if (expiredUser) holdExpiredSDKCallback(worktree, sessionID, messageID, expiredUser)
    }
    return undefined
  }
  remember(userCaptures, id, user)
  return { role: "user", epoch: user.epoch, ownerSessionID: user.ownerSessionID }
}

export type SDKToolTranscriptFact = {
  sessionID: string
  messageID: string
  callID: string
  name: string
  outcome: "running" | "succeeded" | "failed" | "denied"
  observedOutcome?: "succeeded" | "failed" | "denied"
  ownerSessionID: string
  ownerEpoch: string
  executionID: string
  taskID: string
  role: string
}

export type SDKMainToolTranscriptFact = {
  sessionID: string
  messageID: string
  callID: string
  name: string
  outcome: "running" | "succeeded" | "failed" | "denied"
  observedOutcome?: "succeeded" | "failed" | "denied"
  ownerEpoch: string
}

function validSafeID(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9_.:-]+$/.test(value)
}

function validTerminalOutcome(value: unknown): value is "succeeded" | "failed" | "denied" {
  return value === "succeeded" || value === "failed" || value === "denied"
}

/** Persist safe native-main SDK tool facts without inventing execution/task identities or retaining bodies. */
export function persistSDKMainToolFact(worktree: string, fact: SDKMainToolTranscriptFact): AppendResult {
  if (!validSafeID(fact.sessionID) || !validSafeID(fact.messageID) ||
      !validSafeID(fact.callID) || !validSafeID(fact.name, 128) || !validSafeID(fact.ownerEpoch) ||
      !["running", "succeeded", "failed", "denied"].includes(fact.outcome) ||
      (fact.observedOutcome !== undefined && !validTerminalOutcome(fact.observedOutcome))) return { status: "stale" }
  const store = getOwnedSession(worktree, fact.sessionID)
  if (!store || store.sessionID !== fact.sessionID || store.epoch !== fact.ownerEpoch) return { status: "stale" }

  const identity = JSON.stringify([fact.sessionID, fact.messageID, fact.callID])
  const eventID = `opencode:main-tool:${identity}`
  const textFor = (outcome: string) => `main tool ${JSON.stringify([fact.sessionID, fact.messageID, fact.callID, fact.name, outcome])}`
  const appendNotice = (noticeID: string, text: string): AppendResult => {
    if (getOwnedSession(worktree, fact.sessionID)?.epoch !== fact.ownerEpoch) return { status: "stale" }
    try {
      const record = store.append("notice", { text }, noticeID)
      return record.data.text === text ? { status: "written" } : { status: "duplicate" }
    } catch (error) {
      if ((error as Error)?.message?.includes("event ID conflicts with an existing record")) return { status: "duplicate" }
      const holdError = holdCapturedEpoch(worktree, fact.sessionID, fact.ownerEpoch)
      return { status: "failed", error, ...(holdError === undefined ? {} : { holdError }) }
    }
  }

  if (fact.outcome === "running") return appendNotice(`${eventID}:start`, textFor("running"))

  const terminalID = `${eventID}:terminal`
  const attempted = appendNotice(terminalID, textFor(fact.outcome))
  if (attempted.status === "failed" || attempted.status === "stale") return attempted
  let firstOutcome = fact.outcome
  if (attempted.status === "duplicate") {
    const replay = replaySession(worktree, fact.sessionID, { query: fact.callID, kind: "notice", limit: 10_000 })
    const terminal = replay.records.find(record => record.eventID === terminalID)
    if (!replay.complete || !terminal || typeof terminal.data.text !== "string") {
      return failForEpoch(worktree, fact.sessionID, fact.ownerEpoch, new Error("cannot verify the first native-main tool terminal"))
    }
    const prefix = "main tool "
    let values: unknown
    try { values = JSON.parse(terminal.data.text.slice(prefix.length)) }
    catch { return failForEpoch(worktree, fact.sessionID, fact.ownerEpoch, new Error("native-main tool terminal is unreadable")) }
    if (!Array.isArray(values) || values.length !== 5 || values[0] !== fact.sessionID || values[1] !== fact.messageID ||
        values[2] !== fact.callID || values[3] !== fact.name || !["succeeded", "failed", "denied"].includes(values[4])) {
      return failForEpoch(worktree, fact.sessionID, fact.ownerEpoch, new Error("native-main tool terminal identity is mismatched"))
    }
    firstOutcome = values[4] as "succeeded" | "failed" | "denied"
  }

  const observedTerminal = fact.observedOutcome ?? fact.outcome
  if (observedTerminal !== firstOutcome) {
    const diagnostic = `main tool terminal conflict ${JSON.stringify([fact.sessionID, fact.messageID, fact.callID, fact.name, firstOutcome, observedTerminal])}`
    const result = appendNotice(`${eventID}:conflict`, diagnostic)
    if (result.status === "failed" || result.status === "stale") return result
  }
  return attempted
}

/** Persist only an SDK tool fact whose execution and task IDs were resolved from the durable owner record. */
export function persistSDKToolFact(worktree: string, fact: SDKToolTranscriptFact): AppendResult {
  if (![fact.sessionID, fact.messageID, fact.callID, fact.name, fact.ownerSessionID, fact.ownerEpoch,
    fact.executionID, fact.taskID, fact.role].every(value => validSafeID(value)) || !validSafeID(fact.name, 128) ||
      !["running", "succeeded", "failed", "denied"].includes(fact.outcome) ||
      (fact.observedOutcome !== undefined && !validTerminalOutcome(fact.observedOutcome))) return { status: "stale" }
  const store = getOwnedSession(worktree, fact.ownerSessionID)
  if (!store || store.epoch !== fact.ownerEpoch || store.sessionID !== fact.ownerSessionID) return { status: "stale" }

  const identity = JSON.stringify([fact.sessionID, fact.messageID, fact.callID])
  const eventID = `opencode:tool:${identity}`
  const data = {
    name: fact.name,
    role: fact.role,
    executionID: fact.executionID,
    callID: fact.callID,
    taskID: fact.taskID,
    outcome: fact.outcome,
  }

  if (fact.outcome === "running") {
    try {
      store.append("tool-start", data, `${eventID}:start`)
    } catch (error) {
      const holdError = holdCapturedEpoch(worktree, fact.ownerSessionID, fact.ownerEpoch)
      return { status: "failed", error, ...(holdError === undefined ? {} : { holdError }) }
    }
    return { status: "written" }
  }

  const terminalIdentity = JSON.stringify([worktree, fact.ownerSessionID, identity, "terminal"])
  const existingStatus = toolTerminalStatuses.get(terminalIdentity)
  if (existingStatus === fact.outcome) {
    return fact.observedOutcome && fact.observedOutcome !== fact.outcome
      ? appendToolConflict(store, worktree, fact, fact.outcome, fact.observedOutcome, eventID)
      : { status: "duplicate" }
  }
  if (existingStatus !== undefined) {
    return appendToolConflict(store, worktree, fact, existingStatus, fact.observedOutcome ?? fact.outcome, eventID)
  }

  const kind = fact.outcome === "denied" ? "tool-denied" : "tool-result"
  try {
    store.append(kind, data, eventID)
    remember(toolTerminalStatuses, terminalIdentity, fact.outcome)
    if (fact.observedOutcome && fact.observedOutcome !== fact.outcome) {
      const diagnostic = appendToolConflict(store, worktree, fact, fact.outcome, fact.observedOutcome, eventID)
      if (diagnostic.status === "failed") return diagnostic
    }
    return { status: "written" }
  } catch (error) {
    // The same message/call may have been delivered before this process-local cache filled or restarted.
    if ((error as Error)?.message?.includes("event ID conflicts with an existing record")) {
      const replay = replaySession(worktree, fact.ownerSessionID, { query: fact.callID, limit: 10_000 })
      const previous = replay.records.find(record => record.eventID === eventID)
      if (!replay.complete || !previous || !["tool-result", "tool-denied"].includes(previous.kind)) {
        const holdError = holdCapturedEpoch(worktree, fact.ownerSessionID, fact.ownerEpoch)
        return { status: "failed", error, ...(holdError === undefined ? {} : { holdError }) }
      }
      const previousOutcome = previous.data.outcome
      if (previousOutcome === fact.outcome && previous.kind === kind && JSON.stringify(previous.data) === JSON.stringify(data)) {
        remember(toolTerminalStatuses, terminalIdentity, fact.outcome)
        return fact.observedOutcome && fact.observedOutcome !== fact.outcome
          ? appendToolConflict(store, worktree, fact, fact.outcome, fact.observedOutcome, eventID)
          : { status: "duplicate" }
      }
      if (typeof previousOutcome === "string" && ["succeeded", "failed", "denied"].includes(previousOutcome)) {
        remember(toolTerminalStatuses, terminalIdentity, previousOutcome as "succeeded" | "failed" | "denied")
        return appendToolConflict(store, worktree, fact, previousOutcome as "succeeded" | "failed" | "denied",
          fact.observedOutcome ?? fact.outcome, eventID)
      }
    }
    const holdError = holdCapturedEpoch(worktree, fact.ownerSessionID, fact.ownerEpoch)
    return { status: "failed", error, ...(holdError === undefined ? {} : { holdError }) }
  }
}

function appendToolConflict(
  store: NonNullable<ReturnType<typeof getOwnedSession>>,
  worktree: string,
  fact: SDKToolTranscriptFact,
  firstOutcome: "succeeded" | "failed" | "denied",
  observedOutcome: "succeeded" | "failed" | "denied",
  eventID: string,
): AppendResult {
  if (firstOutcome === observedOutcome) return { status: "duplicate" }
  const conflictID = `${eventID}:conflict`
  const conflictCacheID = JSON.stringify([worktree, fact.ownerSessionID, conflictID])
  if (toolConflicts.has(conflictCacheID)) return { status: "duplicate" }
  try {
    store.append("notice", {
      text: `Conflicting terminal tool fact for message ${fact.messageID}, call ${fact.callID}: retained ${firstOutcome}; observed ${observedOutcome}.`,
    }, conflictID)
    remember(toolConflicts, conflictCacheID, true)
    return { status: "duplicate" }
  } catch (error) {
    const holdError = holdCapturedEpoch(worktree, fact.ownerSessionID, fact.ownerEpoch)
    return { status: "failed", error, ...(holdError === undefined ? {} : { holdError }) }
  }
}
