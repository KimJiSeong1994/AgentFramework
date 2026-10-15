import { statSync } from "node:fs"
import { join } from "node:path"
import type { FlowRuntime } from "./types.ts"
import { StatusReadError, STATUS_LIMITS, refreshStatusLiveness, statusBytesRead, statusJson, type StatusJson, type StatusLiveness } from "../flow/status.ts"
import { eventsPath, flowDir, heartbeatPath, workflowPath } from "../flow/state.ts"
import { ledgerPath } from "../state/ledger.ts"
import { executionRunDirectory, modeStatePath, readDirectoryBounded, sessionDir, stateRoot } from "../state/store.ts"

export type StatusFrame = {
  type: "snapshot" | "error"
  seq: number
  reason: "initial" | "changed" | "liveness" | "forced"
  status: StatusJson | null
  error: { source: string; code: string } | null
  meta: { tick: number; readMs: number; bytesRead: number; statCalls: number }
}

type StatValue = { ino: number; size: number; mtimeMs: number }
type WatchErrorSource = ConstructorParameters<typeof StatusReadError>[0]

class WatchStatError extends StatusReadError {
  constructor(source: WatchErrorSource, readonly statCalls: number, readonly stats: Map<string, StatValue | null>) {
    super(source, "unreadable")
  }
}
class WatchPathError extends StatusReadError {
  constructor(source: WatchErrorSource) { super(source, "unreadable") }
}
export type StatusWatchState = {
  sessionID?: string
  detail: boolean
  tick: number
  seq: number
  paths?: string[]
  stats?: Map<string, StatValue | null>
  status?: StatusJson
  projection?: string
  errors: Set<string>
}

export function createStatusWatchState(options: { sessionID?: string; detail?: boolean } = {}): StatusWatchState {
  return { ...options, detail: options.detail ?? false, tick: 0, seq: 0, errors: new Set() }
}

function signature(value: StatValue | null): string {
  return value ? `${value.ino}:${value.size}:${value.mtimeMs}` : "missing"
}

function projection(status: StatusJson): string {
  const value = JSON.parse(JSON.stringify(status)) as StatusJson
  value.generatedAt = 0
  delete value.freshness.workflowUpdatedAt
  delete value.freshness.ledgerUpdatedAt
  if (value.freshness.ownerHeartbeatAgeMs !== undefined) value.freshness.ownerHeartbeatAgeMs = 0
  if (value.session.queue.ageMs !== undefined) value.session.queue.ageMs = 0
  return JSON.stringify(value)
}

function nativeFsError(error: unknown): error is NodeJS.ErrnoException & Error {
  if (!(error instanceof Error)) return false
  const fsError = error as NodeJS.ErrnoException
  return typeof fsError.errno === "number" && typeof fsError.syscall === "string" && typeof fsError.code === "string"
}

function missingFsError(error: unknown): boolean {
  return nativeFsError(error) && error.code === "ENOENT"
}

function sourceForPath(path: string): WatchErrorSource {
  const parts = path.split(/[\\/]/)
  const name = parts.at(-1)
  if (name === "events.jsonl") return "events"
  if (name === "mode.json") return "mode"
  if (name === "ledger.json" || parts.includes("sessions")) return "ledger"
  if (parts.includes("execution-runs")) return "execution"
  return "workflow"
}

function watchEntries(path: string, maxEntries: number, source: WatchErrorSource) {
  try { return readDirectoryBounded(path, maxEntries) }
  catch (error) {
    if (!nativeFsError(error)) throw error
    if (missingFsError(error)) return { entries: [], truncated: false }
    throw new WatchPathError(source)
  }
}

function basePathsFor(runtime: FlowRuntime, state: StatusWatchState, status?: StatusJson): string[] {
  const root = runtime.worktree
  const paths = [workflowPath(root), heartbeatPath(root), eventsPath(root), join(executionRunDirectory(root), "state.json")]
  const sessionID = state.sessionID ?? status?.session.id
  if (sessionID && sessionID !== "no-session") {
    paths.push(sessionDir(root, sessionID), ledgerPath(root, sessionID), modeStatePath(root, sessionID))
  }
  const ownerSession = status?.workflow?.sessionID
  if (ownerSession && ownerSession !== sessionID) paths.push(sessionDir(root, ownerSession), ledgerPath(root, ownerSession))
  if (state.detail) {
    paths.push(join(stateRoot(root), "sessions"), join(flowDir(root), "archive"))
  }
  return [...new Set(paths)]
}

/** Expand detail directories only on initial/read ticks, never on an unchanged liveness tick. */
function pathsFor(runtime: FlowRuntime, state: StatusWatchState, status?: StatusJson): string[] {
  const paths = basePathsFor(runtime, state, status)
  if (!state.detail) return paths
  const root = runtime.worktree
  const sessionID = state.sessionID ?? status?.session.id
  const ownerSession = status?.workflow?.sessionID
  const sessionRoot = join(stateRoot(root), "sessions")
  const archiveDir = join(flowDir(root), "archive")
  const sessions = watchEntries(sessionRoot, STATUS_LIMITS.sessionsEntries, "ledger")
  const sessionIDs = sessions.entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  paths.push(...sessionIDs.filter(id => id !== sessionID && id !== ownerSession).map(id => ledgerPath(root, id)))
  const archiveListing = watchEntries(archiveDir, STATUS_LIMITS.archiveEntries, "workflow")
  const archives = archiveListing.entries.map(entry => entry.name).filter(name => name.endsWith(".json")).sort()
  paths.push(...archives.slice(-STATUS_LIMITS.historyCount).map(name => join(archiveDir, name)))
  return [...new Set(paths)]
}

function collectStats(paths: string[]): { stats: Map<string, StatValue | null>; statCalls: number } {
  const stats = new Map<string, StatValue | null>()
  let statCalls = 0
  for (const path of paths) {
    statCalls++
    try {
      const stat = statSync(path)
      stats.set(path, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch (error) {
      if (!nativeFsError(error)) throw error
      if (missingFsError(error)) stats.set(path, null)
      else throw new WatchStatError(sourceForPath(path), statCalls, stats)
    }
  }
  return { stats, statCalls }
}

function statusError(error: unknown): StatusReadError {
  if (error instanceof StatusReadError) return error
  throw error
}

function changed(previous: Map<string, StatValue | null> | undefined, current: Map<string, StatValue | null>): boolean {
  if (!previous) return true
  if (previous.size !== current.size) return true
  for (const [path, value] of current) {
    if (!previous.has(path) || signature(previous.get(path) ?? null) !== signature(value)) return true
  }
  return false
}

function frame(state: StatusWatchState, type: StatusFrame["type"], reason: StatusFrame["reason"], status: StatusJson | null,
  error: StatusFrame["error"], meta: StatusFrame["meta"]): StatusFrame {
  const snapshot = status ? JSON.parse(JSON.stringify(status)) as StatusJson : null
  return { type, seq: ++state.seq, reason, status: snapshot, error, meta }
}

/** One stat-first watch tick; unchanged ticks re-evaluate liveness without reading state files. */
export function watchTick(state: StatusWatchState, runtime: FlowRuntime, now = Date.now(), liveness?: StatusLiveness): { frame?: StatusFrame; bytesRead: number; statCalls: number } {
  const started = performance.now()
  state.tick++
  const forced = state.tick % 10 === 0
  let firstStats: ReturnType<typeof collectStats> | undefined
  let parsedStatus: StatusJson | undefined
  let parsedProjection: string | undefined
  let nextPathSet: Set<string> | undefined
  let statusBytes = 0
  let statusRead = false
  if (!state.paths) state.paths = basePathsFor(runtime, state, state.status)
  try { firstStats = collectStats(state.paths) }
  catch (error) {
    const failure = statusError(error)
    const statCalls = error instanceof WatchStatError ? error.statCalls : 0
    if (error instanceof WatchStatError) state.stats = error.stats
    const key = `${failure.source}:${failure.code}`
    const shouldEmit = !state.errors.has(key)
    state.errors.add(key)
    if (!shouldEmit) return { bytesRead: failure.bytesRead, statCalls }
    const meta = { tick: state.tick, readMs: performance.now() - started, bytesRead: failure.bytesRead, statCalls }
    return { frame: frame(state, "error", state.status ? "changed" : "initial", null, { source: failure.source, code: failure.code }, meta), bytesRead: meta.bytesRead, statCalls }
  }

  const isChanged = changed(state.stats, firstStats.stats)
  const read = (!state.status && state.errors.size === 0) || isChanged || forced
  if (!read && state.status) {
    if (state.errors.size > 0) return { bytesRead: 0, statCalls: firstStats.statCalls }
    const before = state.projection
    refreshStatusLiveness(state.status, now, liveness)
    const after = projection(state.status)
    state.projection = after
    if (before !== after) {
      const readMs = performance.now() - started
      return { frame: frame(state, "snapshot", "liveness", state.status, null, { tick: state.tick, readMs, bytesRead: 0, statCalls: firstStats.statCalls }), bytesRead: 0, statCalls: firstStats.statCalls }
    }
    return { bytesRead: 0, statCalls: firstStats.statCalls }
  }
  if (!read) return { bytesRead: 0, statCalls: firstStats.statCalls }

  const readStarted = performance.now()
  let status: StatusJson
  try {
    status = statusJson(runtime, state.sessionID, { detail: state.detail, now, liveness })
    parsedStatus = status
    statusBytes = statusBytesRead(status)
    statusRead = true
    const nextPaths = pathsFor(runtime, state, status)
    const nextSet = new Set(nextPaths)
    nextPathSet = nextSet
    state.paths = nextPaths
    const nextProjection = projection(status)
    parsedProjection = nextProjection
    const newPaths = nextPaths.filter(path => !firstStats.stats.has(path))
    const additionalStats = collectStats(newPaths)
    const stats = new Map([...firstStats.stats].filter(([path]) => nextSet.has(path)))
    for (const [path, value] of additionalStats.stats) stats.set(path, value)
    const hadErrors = state.errors.size > 0
    const reason: StatusFrame["reason"] = hadErrors ? "changed" : !state.status ? "initial" : forced ? "forced" : "changed"
    const shouldEmit = !state.status || hadErrors || nextProjection !== state.projection
    state.status = status
    state.projection = nextProjection
    state.errors.clear()
    state.stats = stats
    const bytesRead = statusBytes
    const statCalls = firstStats.statCalls + additionalStats.statCalls
    const readMs = performance.now() - readStarted
    if (!shouldEmit) return { bytesRead, statCalls }
    const emitted = frame(state, "snapshot", reason, status, null, { tick: state.tick, readMs, bytesRead, statCalls })
    return { frame: emitted, bytesRead, statCalls }
  } catch (error) {
    const failure = statusError(error)
    if (!statusRead && failure === error) statusBytes = failure.bytesRead
    if (firstStats) {
      const trackedPaths = nextPathSet
      const stats = new Map([...firstStats.stats].filter(([path]) => trackedPaths?.has(path) ?? true))
      if (trackedPaths && error instanceof WatchStatError) {
        for (const [path, value] of error.stats) if (trackedPaths.has(path)) stats.set(path, value)
      }
      state.stats = stats
    }
    if (statusRead && parsedStatus && parsedProjection) {
      state.status = parsedStatus
      state.projection = parsedProjection
    }
    const statCalls = firstStats.statCalls + (error instanceof WatchStatError ? error.statCalls : 0)
    const key = `${failure.source}:${failure.code}`
    const shouldEmit = !state.errors.has(key)
    state.errors.add(key)
    if (!shouldEmit) return { bytesRead: statusRead ? statusBytes : failure.bytesRead, statCalls }
    const bytesRead = statusRead ? statusBytes : failure.bytesRead
    const meta = { tick: state.tick, readMs: performance.now() - readStarted, bytesRead, statCalls }
    return { frame: frame(state, "error", state.status ? "changed" : "initial", null, { source: failure.source, code: failure.code }, meta), bytesRead, statCalls }
  }
}
