export type ToolObservationStatus = "running" | "succeeded" | "failed" | "denied"
export type ToolObservationTerminalStatus = Exclude<ToolObservationStatus, "running">

export type ToolObservation = Readonly<{
  name: string
  callID: string
  sessionID: string
  status: ToolObservationStatus
  diagnostic?: "conflicting-terminal"
}>

export type ToolObservationEvent = Readonly<Pick<ToolObservation, "name" | "callID" | "sessionID" | "status">>

export type ToolObservationResult = Readonly<{
  disposition: "recorded" | "duplicate" | "conflict" | "ignored"
  terminalStatus: ToolObservationTerminalStatus | null
}>

type CallState = {
  terminalStatus: ToolObservationTerminalStatus | null
  conflictingTerminals: Set<ToolObservationTerminalStatus>
}

type SessionState = {
  observations: ToolObservation[]
  calls: Map<string, CallState>
}

const worktrees = new Map<string, Map<string, SessionState>>()
const callEpochs = new Map<string, string>()
const MAX_ID_LENGTH = 512
const MAX_NAME_LENGTH = 128
const IGNORED: ToolObservationResult = Object.freeze({ disposition: "ignored", terminalStatus: null })

export function captureToolEpoch(worktree: string, sessionID: string, callID: string, epoch: string): void {
  if (!epoch) throw new Error("tool admission epoch is missing")
  const key = JSON.stringify([worktree, sessionID, callID])
  const previous = callEpochs.get(key)
  if (previous !== undefined && previous !== epoch) throw new Error("tool call identity belongs to an earlier attachment epoch")
  if (!callEpochs.has(key)) callEpochs.set(key, epoch)
}

export function capturedToolEpoch(worktree: string, sessionID: string, callID: string): string | undefined {
  return callEpochs.get(JSON.stringify([worktree, sessionID, callID]))
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !!value.trim()
}

function getSession(worktree: string, sessionID: string): SessionState {
  let sessions = worktrees.get(worktree)
  if (!sessions) {
    sessions = new Map()
    worktrees.set(worktree, sessions)
  }
  let session = sessions.get(sessionID)
  if (!session) {
    session = { observations: [], calls: new Map() }
    sessions.set(sessionID, session)
  }
  return session
}

function append(session: SessionState, event: ToolObservationEvent, diagnostic?: ToolObservation["diagnostic"]): void {
  session.observations.push({
    name: event.name,
    callID: event.callID,
    sessionID: event.sessionID,
    status: event.status,
    ...(diagnostic ? { diagnostic } : {}),
  })
}

function result(disposition: ToolObservationResult["disposition"], terminalStatus: ToolObservationTerminalStatus | null): ToolObservationResult {
  return { disposition, terminalStatus }
}

/** Record a whitelist-only OpenCode tool fact in memory for the worktree and session. */
export function recordToolObservation(worktree: string, event: ToolObservationEvent): ToolObservationResult {
  if (!boundedString(worktree, Number.MAX_SAFE_INTEGER) || !event || typeof event !== "object" ||
      !boundedString(event.name, MAX_NAME_LENGTH) || !boundedString(event.callID, MAX_ID_LENGTH) ||
      !boundedString(event.sessionID, MAX_ID_LENGTH) ||
      (event.status !== "running" && event.status !== "succeeded" && event.status !== "failed" && event.status !== "denied")) {
    return IGNORED
  }

  // Copy only the explicit safe fields; caller-owned data is never retained.
  const observation: ToolObservationEvent = {
    name: event.name,
    callID: event.callID,
    sessionID: event.sessionID,
    status: event.status,
  }
  const session = getSession(worktree, observation.sessionID)
  let call = session.calls.get(observation.callID)

  if (observation.status === "running") {
    if (call) return result("duplicate", call.terminalStatus)
    call = { terminalStatus: null, conflictingTerminals: new Set() }
    session.calls.set(observation.callID, call)
    append(session, observation)
    return result("recorded", null)
  }


  const status = observation.status
  if (!call) {
    call = { terminalStatus: status, conflictingTerminals: new Set() }
    session.calls.set(observation.callID, call)
    append(session, observation)
    return result("recorded", status)
  }
  if (call.terminalStatus === null) {
    call.terminalStatus = status
    append(session, observation)
    return result("recorded", status)
  }
  if (call.terminalStatus === status) {
    return result("duplicate", call.terminalStatus)
  }

  if (call.conflictingTerminals.has(status)) return result("duplicate", call.terminalStatus)
  call.conflictingTerminals.add(status)
  append(session, observation, "conflicting-terminal")
  return result("conflict", call.terminalStatus)
}

/** Return safe observation records for one session, without exposing mutable registry entries. */
export function readToolObservations(worktree: string, sessionID: string): ToolObservation[] {
  const rows = worktrees.get(worktree)?.get(sessionID)?.observations
  return rows?.map(row => ({ ...row })) ?? []
}

/** Expire only this session's in-memory observations. No filesystem state is touched. */
export function clearToolObservations(worktree: string, sessionID: string): void {
  for (const key of callEpochs.keys()) {
    const [root, sid] = JSON.parse(key) as string[]
    if (root === worktree && sid === sessionID) callEpochs.delete(key)
  }
  const sessions = worktrees.get(worktree)
  if (!sessions) return
  sessions.delete(sessionID)
  if (sessions.size === 0) worktrees.delete(worktree)
}
