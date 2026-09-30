import { createHash } from "node:crypto"
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs"
import { dirname, join } from "node:path"
import { Database } from "bun:sqlite"
import { stateRoot } from "../state/store.ts"

export type ToolOutcome = {
  schemaVersion: 1
  id: string
  sessionID: string
  callID: string
  tool: string
  status: "success" | "failure" | "unknown"
  basis: "tool_error" | "exit_code" | "completed" | "conflicting_exit" | "invalid_exit"
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  recordedAt: number
}

const DEFAULT_LIMIT = 10_000
const MAX_LIMIT = 10_000
const MAX_ID_LENGTH = 512
const MAX_TOOL_LENGTH = 128

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !value.trim()) return null
  return value
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function exitCode(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null
}

export function toolOutcomePath(worktree: string): string {
  return join(stateRoot(worktree), "tool-outcomes.sqlite")
}

function ensurePrivateDatabaseFile(path: string): void {
  const root = dirname(path)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)

  try {
    const fd = openSync(path, "wx", 0o600)
    closeSync(fd)
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error
    if (!lstatSync(path).isFile()) throw new Error("Tool outcome database path is not a regular file")
    chmodSync(path, 0o600)
  }
}

function initialize(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_outcomes (
      id TEXT NOT NULL PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      session_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'unknown')),
      basis TEXT NOT NULL CHECK (basis IN ('tool_error', 'exit_code', 'completed', 'conflicting_exit', 'invalid_exit')),
      started_at REAL CHECK (started_at IS NULL OR started_at >= 0),
      finished_at REAL CHECK (finished_at IS NULL OR finished_at >= 0),
      duration_ms REAL CHECK (duration_ms IS NULL OR duration_ms >= 0),
      recorded_at REAL NOT NULL CHECK (recorded_at >= 0),
      CHECK (
        (status = 'failure' AND basis IN ('tool_error', 'exit_code')) OR
        (status = 'success' AND basis IN ('exit_code', 'completed')) OR
        (status = 'unknown' AND basis IN ('conflicting_exit', 'invalid_exit'))
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS tool_outcomes_recorded_at_idx
      ON tool_outcomes(recorded_at DESC, id DESC);
  `)
}

function validStoredTimestamp(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0)
}

function fromRow(value: unknown): ToolOutcome {
  if (!isRecord(value) || value.schema_version !== 1 ||
      typeof value.id !== "string" || typeof value.session_id !== "string" ||
      typeof value.call_id !== "string" || typeof value.tool !== "string" ||
      (value.status !== "success" && value.status !== "failure" && value.status !== "unknown") ||
      (value.basis !== "tool_error" && value.basis !== "exit_code" && value.basis !== "completed" && value.basis !== "conflicting_exit" && value.basis !== "invalid_exit") ||
      !validStoredTimestamp(value.started_at) || !validStoredTimestamp(value.finished_at) ||
      !validStoredTimestamp(value.duration_ms) || typeof value.recorded_at !== "number" ||
      !Number.isFinite(value.recorded_at) || value.recorded_at < 0) {
    throw new Error("Invalid tool outcome row")
  }
  return {
    schemaVersion: 1,
    id: value.id,
    sessionID: value.session_id,
    callID: value.call_id,
    tool: value.tool,
    status: value.status,
    basis: value.basis,
    startedAt: value.started_at,
    finishedAt: value.finished_at,
    durationMs: value.duration_ms,
    recordedAt: value.recorded_at,
  }
}

/** Append one safe terminal observation; repeated delivery of the same observation is ignored. */
export function recordToolOutcome(worktree: string, part: unknown): boolean {
  if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state)) return false
  const state = part.state
  if (state.status !== "error" && state.status !== "completed") return false

  const partID = boundedString(part.id, MAX_ID_LENGTH)
  const sessionID = boundedString(part.sessionID, MAX_ID_LENGTH)
  const callID = boundedString(part.callID, MAX_ID_LENGTH)
  const tool = boundedString(part.tool, MAX_TOOL_LENGTH)
  if (!partID || !sessionID || !callID || !tool) return false

  const time = isRecord(state.time) ? state.time : undefined
  const startedAt = timestamp(time?.start)
  const finishedAt = timestamp(time?.end)
  const durationMs = startedAt !== null && finishedAt !== null && finishedAt >= startedAt
    ? finishedAt - startedAt
    : null

  let status: ToolOutcome["status"]
  let basis: ToolOutcome["basis"]
  let observedExit: number | null = null
  let observedExitCode: number | null = null
  if (state.status === "error") {
    status = "failure"
    basis = "tool_error"
  } else {
    const metadata = isRecord(state.metadata) ? state.metadata : undefined
    const exit = exitCode(metadata?.exit)
    const exitCodeValue = exitCode(metadata?.exitCode)
    observedExit = exit
    observedExitCode = exitCodeValue
    if (metadata && ((Object.hasOwn(metadata, "exit") && exit === null) || (Object.hasOwn(metadata, "exitCode") && exitCodeValue === null))) {
      status = "unknown"
      basis = "invalid_exit"
    } else if (exit !== null && exitCodeValue !== null && exit !== exitCodeValue) {
      status = "unknown"
      basis = "conflicting_exit"
    } else {
      const code = exit ?? exitCodeValue
      status = code !== null && code !== 0 ? "failure" : "success"
      basis = code === null ? "completed" : "exit_code"
    }
  }

  // Identity is the observation, not its envelope: the same call re-delivered under a new part id is one row.
  const identity = JSON.stringify([
    1, sessionID, callID, tool, status, basis, startedAt, finishedAt, durationMs,
    observedExit, observedExitCode,
  ])
  const id = createHash("sha256").update(identity).digest("hex")
  const recordedAt = Date.now()
  if (!Number.isFinite(recordedAt) || recordedAt < 0) throw new Error("Invalid recording time")

  const path = toolOutcomePath(worktree)
  ensurePrivateDatabaseFile(path)
  const db = new Database(path)
  try {
    chmodSync(path, 0o600)
    db.exec("PRAGMA busy_timeout = 250")
    initialize(db)
    const insert = db.query(`
      INSERT OR IGNORE INTO tool_outcomes (
        id, schema_version, session_id, call_id, tool, status, basis,
        started_at, finished_at, duration_ms, recorded_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const append = db.transaction(() => insert.run(
      id,
      sessionID,
      callID,
      tool,
      status,
      basis,
      startedAt,
      finishedAt,
      durationMs,
      recordedAt,
    ).changes === 1)
    return append()
  } finally {
    db.close()
  }
}

/** Read a bounded newest-first view without creating or modifying the database. */
export function listToolOutcomes(worktree: string, limit = DEFAULT_LIMIT): { rows: ToolOutcome[]; totalCount: number } {
  const path = toolOutcomePath(worktree)
  try {
    if (!lstatSync(path).isFile()) throw new Error("Tool outcome database path is not a regular file")
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { rows: [], totalCount: 0 }
    throw error
  }

  const boundedLimit = Number.isFinite(limit) ? Math.min(MAX_LIMIT, Math.max(0, Math.floor(limit))) : DEFAULT_LIMIT
  const db = new Database(path, { readonly: true })
  try {
    db.exec("PRAGMA busy_timeout = 250")
    return db.transaction(() => {
      const count = db.query("SELECT COUNT(*) AS total_count FROM tool_outcomes").get() as { total_count: number }
      if (!Number.isSafeInteger(count?.total_count) || count.total_count < 0) throw new Error("Invalid tool outcome count")
      const result = db.query(`
        SELECT id, schema_version, session_id, call_id, tool, status, basis,
               started_at, finished_at, duration_ms, recorded_at
        FROM tool_outcomes
        ORDER BY recorded_at DESC, id DESC
        LIMIT ?
      `).all(boundedLimit)
      return { rows: result.map(fromRow), totalCount: count.total_count }
    })()
  } finally {
    db.close()
  }
}
