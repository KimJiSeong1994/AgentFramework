import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { parseJsonc, projectConfigPath } from "../config.ts"
import { stateRoot, worktreeKey } from "../state/store.ts"
import { containsSecret } from "../security/secrets.ts"

export const SKILL_OBSERVATION_LIMITS = Object.freeze({
  sessions: 10,
  calls: 100,
  facts: 50_000,
  databaseBytes: 64 * 1024 * 1024,
  busyTimeoutMs: 25,
  drainMs: 5 * 60 * 1000,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  maxIdentifierLength: 200,
  maxListRows: 10_000,
  maxListBytes: 16 * 1024 * 1024,
  cleanupRows: 5_000,
  rejectionCount: 1_000_000_000,
  maxConfigBytes: 1024 * 1024,
  maxPendingRelations: 1_024,
})

// Saturating rejection fields count only identifiable malformed admissions. Busy, unavailable, and post-stop
// drops remain unknown; these hard storage/processing limits are not completeness guarantees.

const SCHEMA_VERSION = 2
const APPLICATION_ID = 0x4c534f31
const PAGE_SIZE = 4096
const MAX_PAGES = SKILL_OBSERVATION_LIMITS.databaseBytes / PAGE_SIZE
const DEFAULT_LIST_ROWS = 10_000

export type CampaignPhase = "open" | "draining" | "closed"
export type CampaignStopReason =
  | "session_limit" | "call_limit" | "both_limits" | "manual_stop" | "expired"
  | "clock_uncertain" | "resource_cap"
export type CampaignClosureReason =
  | "quota_reached" | "pending_drained" | "quota_deadline" | "manual_stop"
  | "expired" | "clock_uncertain" | "resource_cap"
export type SkillHealthCode =
  | "ok" | "database_missing" | "database_corrupt" | "binding_mismatch"
  | "campaign_missing" | "campaign_exists" | "campaign_mismatch" | "invalid_campaign_id"
  | "invalid_identifier" | "invalid_fact" | "closed" | "draining" | "quota_limit"
  | "preactivation" | "resource_cap" | "busy" | "storage_error" | "invalid_clock"

export type SkillRejectionCounts = {
  invalid_identifier: number
  invalid_fact: number
  preactivation: number
}

export class SkillObservationError extends Error {
  readonly code: SkillHealthCode

  constructor(code: SkillHealthCode) {
    super(code)
    this.name = "SkillObservationError"
    this.code = code
  }
}

export type SkillCampaignStatus = {
  available: boolean
  health: SkillHealthCode
  campaignID: string | null
  status: CampaignPhase | null
  sessionCount: number
  callCount: number
  activatedAt: number | null
  cutoffSeq: number | null
  cutoffReason: CampaignStopReason | null
  stopReason: CampaignStopReason | null
  closureReason: CampaignClosureReason | null
  drainDeadline: number | null
  closedAt: number | null
  pendingCount: number
  /** Unresolved stored facts captured at closure; retained when raw rows later expire. */
  censoredCount: number
  ownerBinding: string | null
  /** Saturating lower bounds for known malformed admissions only; storage/busy/unavailable losses stay unknown. */
  rejections: SkillRejectionCounts
  storedFactCount: number
  expiredFactCount: number
  notCollectedAfterStop: boolean
  populationComplete: false
}

export type SkillCallStage = "before" | "pending" | "running" | "terminal"
export type SkillCallState = "pending" | "completed" | "error" | "aborted" | "unknown"
export type ReturnedContentState = "observed" | "not_returned" | "unknown"
export type HashReason =
  | "invalid_payload" | "too_large" | "secret_detected" | "unsupported_renderer"
  | "invalid_name" | "name_conflict" | "missing_metadata" | "truncated"
  | "compacted" | "modified" | "ambiguous_boundary" | "unsupported_shape"
  | "source_unavailable" | "source_ambiguous" | "source_unsafe" | "source_too_large"
  | "source_changed" | "source_secret" | "source_name_conflict"

export type SkillCallToken = {
  campaignID: string
  sessionID: string
  callID: string
  admissionKey: string
}

export type SkillCallObservation = {
  state: SkillCallState
  returnedContent: ReturnedContentState
  requestedName?: string | null
  requestedNameReason?: HashReason | null
  returnedName?: string | null
  returnedNameReason?: HashReason | null
  nameConflict?: boolean
  messageID?: string | null
  taskID?: string | null
  attemptID?: string | null
  taskRelation?: "exact" | "orchestrator_context" | "unknown"
  routeDecisionID?: string | null
  startedAt?: number | null
  finishedAt?: number | null
  durationMs?: number | null
  returnedPayloadSha256?: string | null
  returnedPayloadBasis?: string | null
  payloadHashReason?: HashReason | null
  returnedBodySha256?: string | null
  returnedBodyBasis?: string | null
  bodyHashReason?: HashReason | null
  observedFileSha256?: string | null
  observedFileReason?: HashReason | null
  observedFileSize?: number | null
  observedFileAt?: number | null
  observedFileBasis?: string | null
}

export type SkillCallFact = Required<SkillCallObservation> & {
  kind: "skill_call"
  sessionID: string
  callID: string
  phase: "pending" | "terminal" | "conflict"
  beforeSeen: boolean
  terminalSeen: boolean
  conflict: boolean
  conflictCount: number
  loadedOriginalFileSha256: null
  recordedAt: number
  updatedAt: number
}

export type SkillTurnFactInput = {
  sessionID: string
  messageID: string
  phase: "pending" | "terminal"
  role: "user" | "assistant" | "unknown"
  startedAt?: number | null
  finishedAt?: number | null
  parentMessageID?: string | null
  actualAgent?: string | null
  agentBasis?: "sdk_agent_field" | "host_metadata" | "unknown"
  actualModel?: string | null
  modelBasis?: "sdk_model_field" | "host_metadata" | "unknown"
  routerEligibility?: "eligible" | "ineligible" | "unknown"
  routerExposure?: "suggest" | "shadow" | "bypass" | "none" | "unknown"
  bypassReason?: "disabled" | "shadow" | "permission" | "invalid" | "none" | "unknown"
  routeDecisionID?: string | null
  routeSkillName?: string | null
  adviceInserted?: boolean | null
  requestEvidence?: "skill_command" | "unknown" | "none"
  configGeneration?: string | null
  closureReason?: "completed" | "compacted" | "deleted" | "unknown"
}

export type SkillTaskFactInput = {
  sessionID: string
  taskID: string
  attemptID: string
  phase: "pending" | "terminal"
  status: "started" | "done" | "failed" | "cancelled" | "unknown"
  taskStatus?: "done" | "failed" | "cancelled" | "open" | "unknown"
  childMessageID?: string | null
  resumeRequested?: boolean | null
  ownerSessionID?: string | null
  childSessionID?: string | null
  actualRole?: "main" | "worker" | "reviewer" | "data-analyst" | "data-verifier" | "unknown"
  roleBasis?: "sdk_agent_field" | "host_metadata" | "code_owned" | "unknown"
  taskKind?: "code" | "data" | "unknown"
  messageID?: string | null
  originTaskID?: string | null
  resumeOfAttemptID?: string | null
  workflowID?: string | null
  planSha256?: string | null
}

export type SkillVerificationFactInput = {
  sessionID: string
  verificationID: string
  taskID: string
  attemptID: string
  phase: "pending" | "terminal"
  status: "started" | "pass" | "fail" | "refused" | "invalidated" | "timed_out" | "aborted" | "not_run" | "unknown"
  codeOwned: boolean
  startedAt?: number | null
  finishedAt?: number | null
  durationMs?: number | null
  exitCode?: number | null
  taskStatus?: "done" | "failed" | "cancelled" | "open" | "unknown"
  reviewVerdict?: "accept" | "revise" | "reject" | "skipped" | "error" | "unknown"
}

export type StoredSkillFact = {
  kind: "skill_call" | "turn_context" | "task_context" | "verification_observation" | "tool_context"
  sessionID: string
  factKey: string
  phase: "pending" | "terminal" | "conflict"
  conflict: boolean
  recordedAt: number
  payload: SkillCallFact | Record<string, unknown>
}

export type RelatedToolFactInput = {
  sessionID: string
  callID: string
  messageID?: string | null
  tool: string
  phase: "pending" | "terminal"
  status: "pending" | "completed" | "error" | "unknown"
  startedAt?: number | null
  finishedAt?: number | null
  durationMs?: number | null
}

export type SkillObservationList = {
  available: boolean
  health: SkillHealthCode
  campaign: SkillCampaignStatus
  facts: StoredSkillFact[]
  coverage: {
    storedFacts: number
    returnedFacts: number
    unscannedStoredFacts: number
    expiredFacts: number
    truncated: boolean
    unscannedTotal: "known" | "unknown"
    notCollectedAfterStop: boolean
    populationComplete: false
  }
}

export type RecordResult = { recorded: boolean; code: SkillHealthCode | "recorded" | "replay" | "conflict" }
export type AdmissionResult =
  | { admitted: true; code: "admitted" | "replay" | "closure"; token: SkillCallToken }
  | { admitted: false; code: SkillHealthCode }

type CampaignRow = {
  campaign_id: string
  owner_binding: string
  salt: string
  activated_at: number
  status: CampaignPhase
  session_count: number
  call_count: number
  cutoff_seq: number | null
  cutoff_reason: CampaignStopReason | null
  stop_reason: CampaignStopReason | null
  closure_reason: CampaignClosureReason | null
  drain_deadline: number | null
  closed_at: number | null
  last_observed_clock: number
  next_sequence: number
  expired_fact_count: number
  censored_count: number
  rejected_invalid_identifier: number
  rejected_invalid_fact: number
  rejected_preactivation: number
}

type FactRow = {
  id: number
  kind: StoredSkillFact["kind"]
  session_id: string
  fact_key: string
  phase: "pending" | "terminal" | "conflict"
  conflict: number
  payload_json: string
  semantic_hash: string
  recorded_at: number
  updated_at: number
  sequence: number
}

type FactProjection = {
  kind: Exclude<StoredSkillFact["kind"], "skill_call">
  sessionID: string
  factKey: string
  phase: "pending" | "terminal"
  payload: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fixedCode(error: unknown): SkillHealthCode {
  if (error instanceof SkillObservationError) return error.code
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  if (message.includes("busy") || message.includes("locked")) return "busy"
  if (message.includes("full") || message.includes("disk is full")) return "resource_cap"
  if (message.includes("malformed") || message.includes("not a database") || message.includes("corrupt") || message.includes("no such table")) return "database_corrupt"
  return "storage_error"
}

function fail(code: SkillHealthCode): never {
  throw new SkillObservationError(code)
}

function finiteClock(now: unknown): number {
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) fail("invalid_clock")
  return now
}

function decisionClock(observedAt?: number): number {
  return finiteClock(observedAt === undefined ? Date.now() : observedAt)
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= SKILL_OBSERVATION_LIMITS.maxIdentifierLength &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value) && !containsSecret(value)
}

export function validSkillCampaignID(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value) &&
    !containsSecret(value)
}

function validName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) && value !== "none" && !containsSecret(value)
}

function canonicalRoot(root: string): string {
  try {
    // realpath is required: the owner binding follows a canonical project worktree.
    return requireRealpath(resolve(root))
  } catch {
    fail("binding_mismatch")
  }
}

function requireRealpath(path: string): string {
  // Kept local to avoid accepting a not-yet-existing root via stateRoot's ancestor resolution.
  const real = realpathSync.native(path)
  const info = lstatSync(real)
  if (!info.isDirectory()) fail("binding_mismatch")
  return real
}

function observationPath(root: string): string {
  return join(stateRoot(root), "skill-observations.sqlite")
}

export function skillObservationDatabasePath(root: string): string {
  return observationPath(canonicalRoot(root))
}

function ownerBinding(root: string): string {
  return createHash("sha256").update(`skill-observation-v1\0${root}\0${stateRoot(root)}`).digest("hex")
}

/** Stable digest of the canonical project and selected state location; raw paths are never returned. */
export function skillObservationBindingHash(rootInput: string): string {
  return ownerBinding(canonicalRoot(rootInput))
}

function configuredCampaign(root: string): { campaignID: string; ownerBinding: string } | null {
  const path = projectConfigPath(root)
  let directory: ReturnType<typeof lstatSync>
  try {
    directory = lstatSync(dirname(path))
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null
    fail("binding_mismatch")
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail("binding_mismatch")
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null
    fail("binding_mismatch")
  }
  let text: string
  try {
    const before = fstatSync(fd)
    const pathBefore = lstatSync(path)
    if (!before.isFile() || pathBefore.isSymbolicLink() || before.nlink !== 1 ||
        before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size > SKILL_OBSERVATION_LIMITS.maxConfigBytes) {
      fail("binding_mismatch")
    }
    const chunks: Buffer[] = []
    let bytes = 0
    while (bytes <= SKILL_OBSERVATION_LIMITS.maxConfigBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, SKILL_OBSERVATION_LIMITS.maxConfigBytes + 1 - bytes))
      const count = readSync(fd, buffer, 0, buffer.length, null)
      if (count === 0) break
      chunks.push(buffer.subarray(0, count))
      bytes += count
    }
    if (bytes > SKILL_OBSERVATION_LIMITS.maxConfigBytes) fail("binding_mismatch")
    const after = fstatSync(fd)
    const pathAfter = lstatSync(path)
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink() || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino ||
        before.size !== after.size || bytes !== after.size || after.size !== pathAfter.size || after.mtimeMs !== pathAfter.mtimeMs) fail("binding_mismatch")
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))
  } catch {
    fail("binding_mismatch")
  } finally {
    closeSync(fd)
  }
  let parsed: unknown
  try { parsed = parseJsonc(text) } catch { fail("binding_mismatch") }
  if (!isRecord(parsed)) fail("binding_mismatch")
  const observation = parsed.skill_observation
  if (observation === undefined) return null
  if (!isRecord(observation)) fail("binding_mismatch")
  const configuredID = observation.campaign_id
  const configuredBinding = observation.owner_binding
  if (configuredID === undefined && configuredBinding === undefined && observation.enabled !== true) return null
  if (!validSkillCampaignID(configuredID) || typeof configuredBinding !== "string" || !/^[a-f0-9]{64}$/.test(configuredBinding)) {
    fail("binding_mismatch")
  }
  return { campaignID: configuredID, ownerBinding: configuredBinding }
}

function alternateStoreExists(root: string, selectedPath: string): boolean {
  const key = worktreeKey(root)
  const bases = new Set<string>([
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "otter"),
    join(homedir(), ".local", "state", "otter"),
  ])
  if (process.env.OTTER_STATE_HOME) bases.add(resolve(process.env.OTTER_STATE_HOME))
  for (const base of bases) {
    const candidate = join(base, key, "skill-observations.sqlite")
    if (candidate === selectedPath) continue
    try {
      const info = lstatSync(candidate)
      if (info.isFile() || info.isSymbolicLink()) return true
    } catch {
      // A missing alternate is not evidence of an initialized ledger.
    }
  }
  return false
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail("binding_mismatch")
  chmodSync(path, 0o700)
}

function secureExistingDatabaseFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const descriptor = fstatSync(fd)
    const entry = lstatSync(path)
    if (!descriptor.isFile() || descriptor.nlink !== 1 || entry.isSymbolicLink() ||
        descriptor.dev !== entry.dev || descriptor.ino !== entry.ino) fail("database_corrupt")
    fchmodSync(fd, 0o600)
  } finally {
    closeSync(fd)
  }
}

function createPrivateDatabaseFile(path: string): boolean {
  ensurePrivateDirectory(dirname(path))
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    closeSync(fd)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("database_corrupt")
      secureExistingDatabaseFile(path)
      return false
    }
    throw error
  }
}

function openDatabase(path: string, readonly: boolean): Database {
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(path)
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") fail("database_missing")
    throw error
  }
  let parent: ReturnType<typeof lstatSync>
  try { parent = lstatSync(dirname(path)) } catch { fail("database_corrupt") }
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 ||
      !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0) fail("database_corrupt")
  if (info.size > SKILL_OBSERVATION_LIMITS.databaseBytes) fail("resource_cap")
  if (!readonly) secureExistingDatabaseFile(path)
  const db = new Database(path, { readonly, create: !readonly })
  try {
    db.exec(`PRAGMA busy_timeout = ${SKILL_OBSERVATION_LIMITS.busyTimeoutMs}`)
    db.exec("PRAGMA foreign_keys = ON")
    if (!readonly) {
      db.exec("PRAGMA journal_mode = DELETE")
      db.exec("PRAGMA secure_delete = ON")
      db.exec(`PRAGMA max_page_count = ${MAX_PAGES}`)
    }
    validateDatabase(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function validateDatabase(db: Database): void {
  const version = db.query("PRAGMA user_version").get() as Record<string, unknown> | undefined
  const pageSize = db.query("PRAGMA page_size").get() as Record<string, unknown> | undefined
  const applicationID = db.query("PRAGMA application_id").get() as Record<string, unknown> | undefined
  const versionValue = version ? Object.values(version)[0] : undefined
  const pageSizeValue = pageSize ? Object.values(pageSize)[0] : undefined
  const applicationValue = applicationID ? Object.values(applicationID)[0] : undefined
  if (versionValue !== SCHEMA_VERSION || pageSizeValue !== PAGE_SIZE || applicationValue !== APPLICATION_ID) fail("database_corrupt")
  const pageCount = db.query("PRAGMA page_count").get() as Record<string, unknown> | undefined
  const pageCountValue = pageCount ? Object.values(pageCount)[0] : undefined
  if (typeof pageCountValue !== "number" || pageCountValue > MAX_PAGES) fail("resource_cap")
  const row = db.query("SELECT campaign_id FROM campaigns WHERE singleton = 1").get()
  if (!row) fail("database_corrupt")
}

function initializeDatabase(db: Database, root: string, campaignID: string, observedAt?: number): number {
  db.exec(`PRAGMA page_size = ${PAGE_SIZE}`)
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
  db.exec(`PRAGMA max_page_count = ${MAX_PAGES}`)
  db.exec(`
    CREATE TABLE campaigns (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = ${SCHEMA_VERSION}),
      campaign_id TEXT NOT NULL,
      owner_binding TEXT NOT NULL,
      salt TEXT NOT NULL,
      activated_at INTEGER NOT NULL CHECK (activated_at >= 0),
      status TEXT NOT NULL CHECK (status IN ('open', 'draining', 'closed')),
      session_count INTEGER NOT NULL CHECK (session_count BETWEEN 0 AND ${SKILL_OBSERVATION_LIMITS.sessions}),
      call_count INTEGER NOT NULL CHECK (call_count BETWEEN 0 AND ${SKILL_OBSERVATION_LIMITS.calls}),
      cutoff_seq INTEGER,
      cutoff_reason TEXT,
      stop_reason TEXT,
      closure_reason TEXT,
      drain_deadline INTEGER,
      closed_at INTEGER,
      last_observed_clock INTEGER NOT NULL CHECK (last_observed_clock >= 0),
      next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0),
      expired_fact_count INTEGER NOT NULL DEFAULT 0 CHECK (expired_fact_count >= 0),
      censored_count INTEGER NOT NULL DEFAULT 0 CHECK (censored_count BETWEEN 0 AND ${SKILL_OBSERVATION_LIMITS.facts}),
      rejected_invalid_identifier INTEGER NOT NULL DEFAULT 0 CHECK (rejected_invalid_identifier BETWEEN 0 AND ${SKILL_OBSERVATION_LIMITS.rejectionCount}),
      rejected_invalid_fact INTEGER NOT NULL DEFAULT 0 CHECK (rejected_invalid_fact BETWEEN 0 AND ${SKILL_OBSERVATION_LIMITS.rejectionCount}),
      rejected_preactivation INTEGER NOT NULL DEFAULT 0 CHECK (rejected_preactivation BETWEEN 0 AND ${SKILL_OBSERVATION_LIMITS.rejectionCount}),
      CHECK (cutoff_seq IS NULL OR cutoff_seq >= 1),
      CHECK (drain_deadline IS NULL OR drain_deadline >= 0),
      CHECK (closed_at IS NULL OR closed_at >= 0)
    ) STRICT;
    CREATE TABLE session_keys (
      key_hash TEXT PRIMARY KEY,
      admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0)
    ) STRICT;
    CREATE TABLE call_keys (
      key_hash TEXT PRIMARY KEY,
      session_key_hash TEXT NOT NULL,
      admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0)
    ) STRICT;
    CREATE TABLE facts (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('skill_call', 'turn_context', 'task_context', 'verification_observation', 'tool_context')),
      session_id TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('pending', 'terminal', 'conflict')),
      conflict INTEGER NOT NULL CHECK (conflict IN (0, 1)),
      payload_json TEXT NOT NULL,
      semantic_hash TEXT NOT NULL,
      recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      UNIQUE (kind, session_id, fact_key)
    ) STRICT;
    CREATE INDEX facts_recorded_idx ON facts(recorded_at, sequence);
    CREATE INDEX facts_phase_idx ON facts(phase, sequence);
    CREATE INDEX facts_session_phase_sequence_idx ON facts(kind, session_id, phase, sequence);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `)
  const salt = randomBytes(32).toString("hex")
  const insert = db.query(`
    INSERT INTO campaigns (
      singleton, schema_version, campaign_id, owner_binding, salt, activated_at, status,
      session_count, call_count, cutoff_seq, cutoff_reason, stop_reason, closure_reason,
      drain_deadline, closed_at, last_observed_clock, next_sequence, expired_fact_count,
      censored_count, rejected_invalid_identifier, rejected_invalid_fact, rejected_preactivation
    ) VALUES (1, ?, ?, ?, ?, ?, 'open', 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, 0, 0, 0, 0, 0, 0)
  `)
  const tx = db.transaction(() => {
    const now = decisionClock(observedAt)
    insert.run(SCHEMA_VERSION, campaignID, ownerBinding(root), salt, now, now)
    return now
  })
  return tx.immediate()
}

function campaignRow(db: Database): CampaignRow {
  const row = db.query("SELECT * FROM campaigns WHERE singleton = 1").get() as CampaignRow | undefined
  if (!row || typeof row.campaign_id !== "string" || row.campaign_id.length > 100 || !validSkillCampaignID(row.campaign_id) ||
      !/^[a-f0-9]{64}$/.test(row.owner_binding) || !/^[a-f0-9]{64}$/.test(row.salt) ||
      !Number.isSafeInteger(row.session_count) || row.session_count < 0 || row.session_count > SKILL_OBSERVATION_LIMITS.sessions ||
      !Number.isSafeInteger(row.call_count) || row.call_count < 0 || row.call_count > SKILL_OBSERVATION_LIMITS.calls ||
      !Number.isSafeInteger(row.activated_at) || row.activated_at < 0 || !Number.isSafeInteger(row.last_observed_clock) ||
      row.last_observed_clock < row.activated_at || !Number.isSafeInteger(row.next_sequence) || row.next_sequence < 0 ||
      !Number.isSafeInteger(row.expired_fact_count) || row.expired_fact_count < 0 ||
      !Number.isSafeInteger(row.censored_count) || row.censored_count < 0 || row.censored_count > SKILL_OBSERVATION_LIMITS.facts ||
      !Number.isSafeInteger(row.rejected_invalid_identifier) || row.rejected_invalid_identifier < 0 || row.rejected_invalid_identifier > SKILL_OBSERVATION_LIMITS.rejectionCount ||
      !Number.isSafeInteger(row.rejected_invalid_fact) || row.rejected_invalid_fact < 0 || row.rejected_invalid_fact > SKILL_OBSERVATION_LIMITS.rejectionCount ||
      !Number.isSafeInteger(row.rejected_preactivation) || row.rejected_preactivation < 0 || row.rejected_preactivation > SKILL_OBSERVATION_LIMITS.rejectionCount ||
      (row.cutoff_seq !== null && (!Number.isSafeInteger(row.cutoff_seq) || row.cutoff_seq < 1 || row.cutoff_seq > row.next_sequence)) ||
      (row.drain_deadline !== null && (!Number.isSafeInteger(row.drain_deadline) || row.drain_deadline < row.activated_at)) ||
      (row.closed_at !== null && (!Number.isSafeInteger(row.closed_at) || row.closed_at < 0)) ||
      (row.status !== "open" && row.status !== "draining" && row.status !== "closed") ||
      (row.cutoff_reason !== null && !["session_limit", "call_limit", "both_limits"].includes(row.cutoff_reason)) ||
      (row.stop_reason !== null && !["session_limit", "call_limit", "both_limits", "manual_stop", "expired", "clock_uncertain", "resource_cap"].includes(row.stop_reason)) ||
      (row.closure_reason !== null && !["quota_reached", "pending_drained", "quota_deadline", "manual_stop", "expired", "clock_uncertain", "resource_cap"].includes(row.closure_reason)) ||
      (row.status === "draining" && (row.cutoff_seq === null || row.drain_deadline === null || row.stop_reason === null)) ||
      (row.status === "closed" && (row.closed_at === null || row.stop_reason === null || row.closure_reason === null)) ||
      (row.status === "open" && (row.cutoff_seq !== null || row.cutoff_reason !== null || row.stop_reason !== null ||
        row.closure_reason !== null || row.drain_deadline !== null || row.closed_at !== null)) ||
      (row.status === "draining" && (row.cutoff_reason === null || row.closure_reason !== null || row.closed_at !== null)) ||
      (row.cutoff_seq === null) !== (row.cutoff_reason === null) ||
      (row.status !== "closed" && row.censored_count !== 0) ||
      (row.status === "open" && (row.session_count >= SKILL_OBSERVATION_LIMITS.sessions || row.call_count >= SKILL_OBSERVATION_LIMITS.calls))) fail("database_corrupt")
  const sessionKeyCount = (db.query("SELECT COUNT(*) AS count FROM session_keys").get() as { count: number }).count
  const callKeyCount = (db.query("SELECT COUNT(*) AS count FROM call_keys").get() as { count: number }).count
  if (sessionKeyCount !== row.session_count || callKeyCount !== row.call_count) fail("database_corrupt")
  return row
}

function hashKey(salt: string, kind: "session" | "call", sessionID: string, callID?: string): string {
  return createHash("sha256").update(`${salt}\0${kind}\0${sessionID}${callID === undefined ? "" : `\0${callID}`}`).digest("hex")
}

function pendingCount(db: Database, row: CampaignRow): number {
  const result = row.cutoff_seq === null
    ? db.query("SELECT COUNT(*) AS count FROM facts WHERE phase = 'pending'").get() as { count: number }
    : db.query("SELECT COUNT(*) AS count FROM facts WHERE phase = 'pending' AND sequence <= ?").get(row.cutoff_seq) as { count: number }
  if (!Number.isSafeInteger(result.count) || result.count < 0 || result.count > SKILL_OBSERVATION_LIMITS.facts) fail("database_corrupt")
  return result.count
}

function updateCampaign(db: Database, fields: Record<string, string | number | null>): void {
  const entries = Object.entries(fields)
  if (!entries.length) return
  const assignments = entries.map(([field]) => `${field} = ?`).join(", ")
  db.query(`UPDATE campaigns SET ${assignments} WHERE singleton = 1`).run(...entries.map(([, value]) => value))
}

function closeIfDrained(db: Database, now: number): void {
  const row = campaignRow(db)
  if (row.status !== "draining" || pendingCount(db, row) !== 0) return
  updateCampaign(db, { status: "closed", closure_reason: "pending_drained", closed_at: now, censored_count: 0, last_observed_clock: now })
}

function closeCampaign(db: Database, now: number, stopReason: CampaignStopReason, closureReason: CampaignClosureReason): void {
  const row = campaignRow(db)
  if (row.status === "closed") return
  updateCampaign(db, {
    status: "closed", stop_reason: stopReason, closure_reason: closureReason, closed_at: now,
    censored_count: pendingCount(db, row), last_observed_clock: Math.max(now, row.last_observed_clock),
  })
}

function enforceClockAndExpiry(db: Database, now: number, cleanupClosed = false): CampaignRow {
  let row = campaignRow(db)
  if (row.status === "closed") {
    if (cleanupClosed) cleanupExpired(db, now)
    return row
  }
  if (now < row.last_observed_clock) {
    closeCampaign(db, row.last_observed_clock, "clock_uncertain", "clock_uncertain")
    row = campaignRow(db)
  } else if (now - row.activated_at >= SKILL_OBSERVATION_LIMITS.retentionMs) {
    closeCampaign(db, now, "expired", "expired")
    row = campaignRow(db)
  } else if (row.status === "draining" && row.drain_deadline !== null && now >= row.drain_deadline) {
    closeCampaign(db, now, row.stop_reason!, "quota_deadline")
    row = campaignRow(db)
  } else if (now > row.last_observed_clock) {
    updateCampaign(db, { last_observed_clock: now })
    row = campaignRow(db)
  }
  // Capture unresolved state before TTL deletion can remove the raw facts that prove it.
  cleanupExpired(db, now)
  return row
}

function effectiveCampaign(row: CampaignRow, now: number): {
  status: CampaignPhase
  stopReason: CampaignStopReason | null
  closureReason: CampaignClosureReason | null
  closedAt: number | null
} {
  if (row.status === "closed") return {
    status: row.status,
    stopReason: row.stop_reason,
    closureReason: row.closure_reason,
    closedAt: row.closed_at,
  }
  if (now < row.last_observed_clock) return {
    status: "closed", stopReason: "clock_uncertain", closureReason: "clock_uncertain", closedAt: row.last_observed_clock,
  }
  if (now - row.activated_at >= SKILL_OBSERVATION_LIMITS.retentionMs) return {
    status: "closed", stopReason: "expired", closureReason: "expired", closedAt: now,
  }
  if (row.status === "draining" && row.drain_deadline !== null && now >= row.drain_deadline) return {
    status: "closed", stopReason: row.stop_reason, closureReason: "quota_deadline", closedAt: now,
  }
  return { status: row.status, stopReason: row.stop_reason, closureReason: row.closure_reason, closedAt: row.closed_at }
}

function statusFromDatabase(db: Database, root: string, now: number, row = campaignRow(db)): SkillCampaignStatus {
  if (row.owner_binding !== ownerBinding(root)) fail("binding_mismatch")
  const effective = effectiveCampaign(row, now)
  const facts = db.query("SELECT COUNT(*) AS count FROM facts WHERE recorded_at >= ?").get(now - SKILL_OBSERVATION_LIMITS.retentionMs) as { count: number }
  const expired = db.query("SELECT COUNT(*) AS count FROM facts WHERE recorded_at < ?").get(now - SKILL_OBSERVATION_LIMITS.retentionMs) as { count: number }
  const expiredFactCount = row.expired_fact_count + Math.max(0, Number(expired.count) || 0)
  const unresolved = effective.status === "closed" && row.status !== "closed" ? pendingCount(db, row) : 0
  return {
    available: true,
    health: "ok",
    campaignID: row.campaign_id,
    ownerBinding: row.owner_binding,
    status: effective.status,
    sessionCount: row.session_count,
    callCount: row.call_count,
    activatedAt: row.activated_at,
    cutoffSeq: row.cutoff_seq,
    cutoffReason: row.cutoff_reason,
    stopReason: effective.stopReason,
    closureReason: effective.closureReason,
    drainDeadline: row.drain_deadline,
    closedAt: effective.closedAt,
    pendingCount: effective.status === "closed" ? 0 : pendingCount(db, row),
    censoredCount: row.status === "closed" ? row.censored_count : unresolved,
    rejections: {
      invalid_identifier: row.rejected_invalid_identifier,
      invalid_fact: row.rejected_invalid_fact,
      preactivation: row.rejected_preactivation,
    },
    storedFactCount: Math.max(0, Number(facts.count) || 0),
    expiredFactCount,
    notCollectedAfterStop: effective.status !== "open",
    populationComplete: false,
  }
}

function unavailableStatus(health: SkillHealthCode): SkillCampaignStatus {
  return {
    available: false, health, campaignID: null, status: null, sessionCount: 0, callCount: 0,
    ownerBinding: null,
    activatedAt: null, cutoffSeq: null, cutoffReason: null, stopReason: null, closureReason: null,
    drainDeadline: null, closedAt: null, pendingCount: 0, censoredCount: 0,
    rejections: { invalid_identifier: 0, invalid_fact: 0, preactivation: 0 }, storedFactCount: 0, expiredFactCount: 0,
    notCollectedAfterStop: true, populationComplete: false,
  }
}

function immediate<T>(db: Database, action: () => T): T {
  const transaction = db.transaction(action)
  return transaction.immediate()
}

function campaignStatusWithDatabase(db: Database, root: string, observedAt?: number): SkillCampaignStatus {
  const transaction = db.transaction(() => {
    // The first query pins the read snapshot; sample its live clock only after that snapshot exists.
    const row = campaignRow(db)
    if (row.owner_binding !== ownerBinding(root)) fail("binding_mismatch")
    const now = decisionClock(observedAt)
    return statusFromDatabase(db, root, now, row)
  })
  return transaction.deferred()
}

function normalizeOpenError(error: unknown): never {
  if (error instanceof SkillObservationError) throw error
  fail(fixedCode(error))
}

/** Explicit one-time initialization. Repeating the same id returns existing state and never resets quota. */
export function activateSkillCampaign(rootInput: string, campaignID: string, observedAt?: number): SkillCampaignStatus {
  if (!validSkillCampaignID(campaignID)) fail("invalid_campaign_id")
  const root = canonicalRoot(rootInput)
  const configured = configuredCampaign(root)
  if (configured) {
    if (configured.ownerBinding !== ownerBinding(root)) fail("binding_mismatch")
    if (configured.campaignID !== campaignID) fail("campaign_exists")
  }
  const path = observationPath(root)
  let alreadyPresent = false
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("database_corrupt")
    alreadyPresent = true
  } catch (error) {
    if (!(isRecord(error) && error.code === "ENOENT")) throw error
  }
  if (!alreadyPresent && configured) fail("database_missing")
  if (!alreadyPresent && alternateStoreExists(root, path)) fail("binding_mismatch")
  let created = false
  try {
    created = createPrivateDatabaseFile(path)
    if (!created) {
      const db = openDatabase(path, false)
      try {
        return immediate(db, () => {
          const now = decisionClock(observedAt)
          const row = campaignRow(db)
          if (row.owner_binding !== ownerBinding(root)) fail("binding_mismatch")
          if (row.campaign_id !== campaignID) fail("campaign_exists")
          enforceClockAndExpiry(db, now, true)
          return statusFromDatabase(db, root, now)
        })
      } finally {
        db.close()
      }
    }
    const db = new Database(path)
    try {
      db.exec(`PRAGMA busy_timeout = ${SKILL_OBSERVATION_LIMITS.busyTimeoutMs}`)
      db.exec("PRAGMA journal_mode = DELETE")
      initializeDatabase(db, root, campaignID, observedAt)
      secureExistingDatabaseFile(path)
      return campaignStatusWithDatabase(db, root, observedAt)
    } finally {
      db.close()
    }
  } catch (error) {
    normalizeOpenError(error)
  }
}

/** Read-only status. A missing database is reported and is never initialized. */
export function getSkillCampaignStatus(rootInput: string, observedAt?: number): SkillCampaignStatus {
  let db: Database | undefined
  try {
    const root = canonicalRoot(rootInput)
    db = openDatabase(observationPath(root), true)
    return campaignStatusWithDatabase(db, root, observedAt)
  } catch (error) {
    return unavailableStatus(fixedCode(error))
  } finally {
    db?.close()
  }
}

/** Observer-only hard stop; does not affect any host tool, task, or permission state. */
export function stopSkillCampaign(rootInput: string, campaignID?: string, observedAt?: number): SkillCampaignStatus {
  if (campaignID !== undefined && !validSkillCampaignID(campaignID)) fail("invalid_campaign_id")
  const root = canonicalRoot(rootInput)
  const db = openDatabase(observationPath(root), false)
  try {
    return immediate(db, () => {
      const now = decisionClock(observedAt)
      const initial = campaignRow(db)
      if (initial.owner_binding !== ownerBinding(root)) fail("binding_mismatch")
      if (campaignID !== undefined && initial.campaign_id !== campaignID) fail("campaign_mismatch")
      const row = enforceClockAndExpiry(db, now, true)
      if (row.status !== "closed") {
        closeCampaign(db, now, "manual_stop", "manual_stop")
      }
      return statusFromDatabase(db, root, now)
    })
  } finally {
    db.close()
  }
}

/** Bounded startup/timer maintenance. Never initializes a missing store or enrolls an actor. */
export function maintainSkillCampaign(rootInput: string, campaignID: string, observedAt?: number): SkillCampaignStatus {
  let db: Database | undefined
  try {
    const root = canonicalRoot(rootInput)
    db = openDatabase(observationPath(root), false)
    return immediate(db, () => {
      const now = decisionClock(observedAt)
      const row = campaignRow(db!)
      if (!validSkillCampaignID(campaignID) || row.campaign_id !== campaignID) fail("campaign_mismatch")
      if (row.owner_binding !== ownerBinding(root)) fail("binding_mismatch")
      enforceClockAndExpiry(db!, now, true)
      return statusFromDatabase(db!, root, now)
    })
  } catch (error) {
    return unavailableStatus(fixedCode(error))
  } finally {
    db?.close()
  }
}

/** Preserve exact admitted turn identity but censor interrupted/deleted turn coverage. */
export function markSkillSessionBoundary(rootInput: string, campaignID: string, sessionID: string, reason: "compacted" | "deleted", observedAt?: number): RecordResult {
  let db: Database | undefined
  try {
    if (!validIdentifier(sessionID) || !validSkillCampaignID(campaignID)) return { recorded: false, code: "invalid_identifier" }
    const root = canonicalRoot(rootInput)
    db = openDatabase(observationPath(root), false)
    return immediate(db, () => {
      const now = decisionClock(observedAt)
      const prior = campaignRow(db!)
      if (prior.owner_binding !== ownerBinding(root)) return { recorded: false, code: "binding_mismatch" }
      if (prior.campaign_id !== campaignID) return { recorded: false, code: "campaign_mismatch" }
      const campaign = enforceClockAndExpiry(db!, now)
      if (campaign.status === "closed") return { recorded: false, code: "closed" }
      const rows = db!.query(`
        SELECT * FROM facts WHERE kind = 'turn_context' AND session_id = ? AND phase = 'pending'
        ORDER BY sequence LIMIT ${SKILL_OBSERVATION_LIMITS.maxPendingRelations}
      `).all(sessionID) as FactRow[]
      for (const row of rows) {
        if (campaign.cutoff_seq !== null && row.sequence > campaign.cutoff_seq) continue
        if (createHash("sha256").update(row.payload_json).digest("hex") !== row.semantic_hash) fail("database_corrupt")
        const payload = projectTurn({ ...jsonObject(row.payload_json), phase: "terminal", closureReason: reason }).payload
        const json = JSON.stringify(payload)
        db!.query("UPDATE facts SET phase = 'terminal', payload_json = ?, semantic_hash = ?, updated_at = ? WHERE id = ?")
          .run(json, createHash("sha256").update(json).digest("hex"), now, row.id)
      }
      closeIfDrained(db!, now)
      return { recorded: rows.length > 0, code: rows.length ? "recorded" : "replay" }
    })
  } catch (error) {
    return { recorded: false, code: fixedCode(error) }
  } finally {
    db?.close()
  }
}

function nextSequence(db: Database): number {
  const row = campaignRow(db)
  const sequence = row.next_sequence + 1
  updateCampaign(db, { next_sequence: sequence })
  return sequence
}

function rawFactCount(db: Database): number {
  const result = db.query(`
    SELECT
      (SELECT COUNT(*) FROM facts) +
      (SELECT COUNT(*) FROM session_keys) +
      (SELECT COUNT(*) FROM call_keys) +
      (SELECT COUNT(*) FROM campaigns) AS count
  `).get() as { count: number }
  return Number.isSafeInteger(result.count) ? result.count : SKILL_OBSERVATION_LIMITS.facts
}

function closeForResourceCap(db: Database, now: number): void {
  closeCampaign(db, now, "resource_cap", "resource_cap")
}

function setQuotaCutoff(db: Database, now: number, sequence: number, reason: CampaignStopReason): void {
  updateCampaign(db, {
    status: "draining", cutoff_seq: sequence, cutoff_reason: reason, stop_reason: reason,
    closure_reason: null, drain_deadline: now + SKILL_OBSERVATION_LIMITS.drainMs,
    last_observed_clock: now,
  })
  const row = campaignRow(db)
  if (pendingCount(db, row) === 0) {
    updateCampaign(db, { status: "closed", closure_reason: "quota_reached", closed_at: now, censored_count: 0 })
  }
}

function initialCallFact(
  sessionID: string,
  callID: string,
  beforeSeen: boolean,
  now: number,
  startedAt: number | null,
  finishedAt: number | null,
  requestedName: string | null,
  requestedNameReason: HashReason | null,
  routeDecisionID: string | null,
): SkillCallFact {
  return {
    kind: "skill_call", sessionID, callID, phase: "pending", state: "pending", returnedContent: "unknown",
    beforeSeen, terminalSeen: false, conflict: false, conflictCount: 0,
    requestedName, requestedNameReason, returnedName: null, returnedNameReason: null,
    nameConflict: false, messageID: null, taskID: null, attemptID: null, routeDecisionID,
    startedAt, finishedAt, durationMs: null,
    taskRelation: "unknown", returnedPayloadSha256: null, payloadHashReason: null,
    returnedPayloadBasis: null,
    returnedBodySha256: null, returnedBodyBasis: null, bodyHashReason: null,
    observedFileSha256: null, observedFileReason: null, observedFileSize: null, observedFileAt: null, observedFileBasis: null,
    loadedOriginalFileSha256: null, recordedAt: now, updatedAt: now,
  }
}

function countAdmissionRejection(db: Database, reason: "invalid_identifier" | "invalid_fact" | "preactivation"): void {
  const row = campaignRow(db)
  if (row.status !== "open") return
  const column = reason === "invalid_identifier" ? "rejected_invalid_identifier"
    : reason === "invalid_fact" ? "rejected_invalid_fact" : "rejected_preactivation"
  const count = row[column]
  if (count < SKILL_OBSERVATION_LIMITS.rejectionCount) updateCampaign(db, { [column]: count + 1 })
}

function writeFactRow(
  db: Database,
  kind: StoredSkillFact["kind"],
  sessionID: string,
  factKey: string,
  phase: FactRow["phase"],
  conflict: boolean,
  payload: Record<string, unknown>,
  now: number,
  sequence: number,
): void {
  const json = JSON.stringify(payload)
  const semanticHash = createHash("sha256").update(json).digest("hex")
  db.query(`
    INSERT INTO facts (kind, session_id, fact_key, phase, conflict, payload_json, semantic_hash, recorded_at, updated_at, sequence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(kind, sessionID, factKey, phase, conflict ? 1 : 0, json, semanticHash, now, now, sequence)
}

/** Reserve the session and unique skill-call slots before inspecting returned content. */
export function admitSkillCall(
  rootInput: string,
  campaignID: string,
  input: { sessionID: unknown; callID: unknown; stage: SkillCallStage; startedAt?: unknown; finishedAt?: unknown; requestedName?: unknown; routeDecisionID?: unknown },
  observedAt?: number,
): AdmissionResult {
  let db: Database | undefined
  try {
    if (!validSkillCampaignID(campaignID)) return { admitted: false, code: "invalid_campaign_id" }
    const root = canonicalRoot(rootInput)
    db = openDatabase(observationPath(root), false)
    const outcome = immediate(db, (): AdmissionResult => {
      const now = decisionClock(observedAt)
      const initial = campaignRow(db!)
      if (initial.owner_binding !== ownerBinding(root)) return { admitted: false, code: "binding_mismatch" }
      if (initial.campaign_id !== campaignID) return { admitted: false, code: "campaign_mismatch" }
      const row = enforceClockAndExpiry(db!, now)
      if (row.status === "closed") return { admitted: false, code: row.stop_reason === "resource_cap" ? "resource_cap" : "closed" }
      if (!isRecord(input)) {
        countAdmissionRejection(db!, "invalid_fact")
        return { admitted: false, code: "invalid_fact" }
      }
      if (!validIdentifier(input.sessionID) || !validIdentifier(input.callID)) {
        countAdmissionRejection(db!, "invalid_identifier")
        return { admitted: false, code: "invalid_identifier" }
      }
      if (!(input.stage === "before" || input.stage === "pending" || input.stage === "running" || input.stage === "terminal")) {
        countAdmissionRejection(db!, "invalid_fact")
        return { admitted: false, code: "invalid_fact" }
      }
      const startedProvided = input.startedAt !== undefined && input.startedAt !== null
      const finishedProvided = input.finishedAt !== undefined && input.finishedAt !== null
      const startedAt = startedProvided && typeof input.startedAt === "number" && Number.isSafeInteger(input.startedAt) && input.startedAt >= 0 && input.startedAt <= now
        ? input.startedAt : null
      const finishedAt = finishedProvided && typeof input.finishedAt === "number" && Number.isSafeInteger(input.finishedAt) && input.finishedAt >= 0 && input.finishedAt <= now
        ? input.finishedAt : null
      if ((startedProvided && startedAt === null) || (finishedProvided && finishedAt === null) ||
          (startedAt !== null && finishedAt !== null && finishedAt < startedAt)) {
        countAdmissionRejection(db!, "invalid_fact")
        return { admitted: false, code: "invalid_fact" }
      }
      const sessionHash = hashKey(row.salt, "session", input.sessionID)
      const callHash = hashKey(row.salt, "call", input.sessionID, input.callID)
      const existingCall = db!.query("SELECT key_hash FROM call_keys WHERE key_hash = ?").get(callHash)
      if (row.status === "draining") {
        if (input.stage !== "terminal") return { admitted: false, code: "draining" }
        const pending = db!.query(`
          SELECT sequence FROM facts WHERE kind = 'skill_call' AND session_id = ? AND fact_key = ? AND phase = 'pending'
        `).get(input.sessionID, input.callID) as { sequence: number } | undefined
        if (!existingCall || !pending || row.cutoff_seq === null || pending.sequence > row.cutoff_seq) {
          return { admitted: false, code: "draining" }
        }
        return {
          admitted: true, code: "closure",
          token: { campaignID: row.campaign_id, sessionID: input.sessionID, callID: input.callID, admissionKey: callHash },
        }
      }
      if (existingCall) {
        const fact = db!.query("SELECT * FROM facts WHERE kind = 'skill_call' AND session_id = ? AND fact_key = ?").get(input.sessionID, input.callID) as FactRow | undefined
        if (!fact) {
          closeForResourceCap(db!, now)
          return { admitted: false, code: "resource_cap" }
        }
        if (input.stage === "before") {
          if (createHash("sha256").update(fact.payload_json).digest("hex") !== fact.semantic_hash) fail("database_corrupt")
          const prior = storedCall(fact.payload_json)
          if (!prior.beforeSeen) {
            prior.beforeSeen = true
            prior.updatedAt = now
            const json = JSON.stringify(prior)
            db!.query("UPDATE facts SET payload_json = ?, semantic_hash = ?, updated_at = ? WHERE id = ?")
              .run(json, createHash("sha256").update(json).digest("hex"), now, fact.id)
          }
        }
        return {
          admitted: true, code: "replay",
          token: { campaignID: row.campaign_id, sessionID: input.sessionID, callID: input.callID, admissionKey: callHash },
        }
      }
      if (input.stage === "terminal" && finishedAt !== null && finishedAt < row.activated_at) {
        countAdmissionRejection(db!, "preactivation")
        return { admitted: false, code: "preactivation" }
      }
      const requestedName = validName(input.requestedName) ? input.requestedName : null
      const requestedNameReason = input.requestedName === undefined || input.requestedName === null || requestedName
        ? null
        : "invalid_name"
      const routeDecisionID = validIdentifier(input.routeDecisionID) ? input.routeDecisionID : null
      const knownSession = !!db!.query("SELECT 1 FROM session_keys WHERE key_hash = ?").get(sessionHash)
      if ((!knownSession && row.session_count >= SKILL_OBSERVATION_LIMITS.sessions) || row.call_count >= SKILL_OBSERVATION_LIMITS.calls) {
        const cutoff = row.session_count >= SKILL_OBSERVATION_LIMITS.sessions ? "session_limit" : "call_limit"
        closeCampaign(db!, now, cutoff, "quota_reached")
        if (row.next_sequence > 0) updateCampaign(db!, { cutoff_seq: row.next_sequence, cutoff_reason: cutoff })
        return { admitted: false, code: "quota_limit" }
      }
      const addSession = knownSession ? 0 : 1
      const projectedRows = rawFactCount(db!) + addSession + 2
      if (projectedRows > SKILL_OBSERVATION_LIMITS.facts || statSync(observationPath(root)).size >= SKILL_OBSERVATION_LIMITS.databaseBytes) {
        closeForResourceCap(db!, now)
        return { admitted: false, code: "resource_cap" }
      }
      const sequence = nextSequence(db!)
      if (!knownSession) {
        db!.query("INSERT INTO session_keys (key_hash, admitted_at) VALUES (?, ?)").run(sessionHash, now)
      }
      db!.query("INSERT INTO call_keys (key_hash, session_key_hash, admitted_at) VALUES (?, ?, ?)").run(callHash, sessionHash, now)
      const fact = initialCallFact(
        input.sessionID, input.callID, input.stage === "before", now, startedAt, finishedAt,
        requestedName, requestedNameReason, routeDecisionID,
      )
      writeFactRow(db!, "skill_call", input.sessionID, input.callID, "pending", false, fact, now, sequence)
      const nextSessions = row.session_count + addSession
      const nextCalls = row.call_count + 1
      updateCampaign(db!, { session_count: nextSessions, call_count: nextCalls, last_observed_clock: now })
      if (nextSessions === SKILL_OBSERVATION_LIMITS.sessions || nextCalls === SKILL_OBSERVATION_LIMITS.calls) {
        const reason: CampaignStopReason = nextSessions === SKILL_OBSERVATION_LIMITS.sessions && nextCalls === SKILL_OBSERVATION_LIMITS.calls
          ? "both_limits"
          : nextSessions === SKILL_OBSERVATION_LIMITS.sessions ? "session_limit" : "call_limit"
        setQuotaCutoff(db!, now, sequence, reason)
      }
      return {
        admitted: true, code: "admitted",
        token: { campaignID: row.campaign_id, sessionID: input.sessionID, callID: input.callID, admissionKey: callHash },
      }
    })
    return outcome
  } catch (error) {
    return { admitted: false, code: fixedCode(error) }
  } finally {
    db?.close()
  }
}

function optionalID(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (!validIdentifier(value)) fail("invalid_fact")
  return value
}

function optionalSkillName(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (!validName(value)) fail("invalid_fact")
  return value
}

function optionalModel(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || value.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(value) ||
      value.includes("..") || value.includes("//") || value.includes(":/") || /[A-Za-z]:\//.test(value) || containsSecret(value)) fail("invalid_fact")
  return value
}

function digest(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("invalid_fact")
  return value
}

function optionalTimestamp(value: unknown, now: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= now ? value : null
}

function optionalDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= SKILL_OBSERVATION_LIMITS.retentionMs
    ? value
    : null
}

const HASH_REASONS = new Set<HashReason>([
  "invalid_payload", "too_large", "secret_detected", "unsupported_renderer", "invalid_name", "name_conflict",
  "missing_metadata", "truncated", "compacted", "modified", "ambiguous_boundary", "unsupported_shape",
  "source_unavailable", "source_ambiguous", "source_unsafe", "source_too_large", "source_changed",
  "source_secret", "source_name_conflict",
])

function optionalHashReason(value: unknown): HashReason | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !HASH_REASONS.has(value as HashReason)) fail("invalid_fact")
  return value as HashReason
}

type HashGroup = { sha256: string | null; basis: string | null; reason: HashReason | null }

function projectHashGroup(
  input: Record<string, unknown>,
  prior: HashGroup,
  keys: { sha256: string; basis: string; reason: string },
  allowedBasis: string,
): HashGroup {
  const sha256 = digest(input[keys.sha256])
  const reason = optionalHashReason(input[keys.reason])
  const basisValue = input[keys.basis]
  if (basisValue !== undefined && basisValue !== null && basisValue !== allowedBasis) fail("invalid_fact")
  const basis = basisValue === undefined || basisValue === null ? null : basisValue
  if (sha256 !== null) {
    if (reason !== null) fail("invalid_fact")
    const selectedBasis = basis ?? (prior.sha256 === sha256 ? prior.basis : null)
    if (selectedBasis !== allowedBasis) fail("invalid_fact")
    return { sha256, basis: selectedBasis, reason: null }
  }
  if (basis !== null) fail("invalid_fact")
  if (reason !== null) return { sha256: null, basis: null, reason }
  return prior
}

function projectCallObservation(input: unknown, prior: SkillCallFact, now: number): SkillCallFact {
  if (!isRecord(input)) fail("invalid_fact")
  const state = input.state
  const returnedContent = input.returnedContent
  if (!(state === "pending" || state === "completed" || state === "error" || state === "aborted" || state === "unknown") ||
      !(returnedContent === "observed" || returnedContent === "not_returned" || returnedContent === "unknown")) fail("invalid_fact")
  const projectedState = state === "pending" && prior.state !== "pending" ? prior.state : state
  const projectedReturnedContent = returnedContent === "unknown" ? prior.returnedContent : returnedContent
  const requestedName = input.requestedName === undefined || input.requestedName === null
    ? null
    : validName(input.requestedName) ? input.requestedName : null
  const requestedNameReason = input.requestedNameReason === undefined || input.requestedNameReason === null
    ? input.requestedName !== undefined && input.requestedName !== null && requestedName === null ? "invalid_name" : null
    : input.requestedNameReason === "invalid_name" ? "invalid_name" : fail("invalid_fact")
  const returnedName = input.returnedName === undefined || input.returnedName === null
    ? null
    : validName(input.returnedName) ? input.returnedName : null
  const returnedNameReason = input.returnedNameReason === undefined || input.returnedNameReason === null
    ? input.returnedName !== undefined && input.returnedName !== null && returnedName === null ? "invalid_name" : null
    : input.returnedNameReason === "invalid_name" ? "invalid_name" : fail("invalid_fact")
  const messageID = optionalID(input.messageID)
  const taskID = optionalID(input.taskID)
  const attemptID = optionalID(input.attemptID)
  const routeDecisionID = optionalID(input.routeDecisionID)
  const startedAt = optionalTimestamp(input.startedAt, now) ?? prior.startedAt ?? null
  let finishedAt = optionalTimestamp(input.finishedAt, now) ?? prior.finishedAt ?? null
  let durationMs = optionalDuration(input.durationMs) ?? prior.durationMs ?? null
  if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) {
    finishedAt = null
    durationMs = null
  }
  const taskRelation = input.taskRelation === undefined || input.taskRelation === "unknown"
    ? prior.taskRelation : input.taskRelation
  if (!(taskRelation === "exact" || taskRelation === "orchestrator_context" || taskRelation === "unknown")) fail("invalid_fact")
  const payloadReason = optionalHashReason(input.payloadHashReason)
  const bodyReason = optionalHashReason(input.bodyHashReason)
  const fileReason = optionalHashReason(input.observedFileReason)
  const suppressionReason: HashReason | null = [payloadReason, bodyReason, fileReason].includes("secret_detected")
    ? "secret_detected"
    : [payloadReason, bodyReason, fileReason].includes("too_large") ? "too_large" : null
  const priorPayload: HashGroup = {
    sha256: prior.returnedPayloadSha256, basis: prior.returnedPayloadBasis, reason: prior.payloadHashReason,
  }
  const priorBody: HashGroup = { sha256: prior.returnedBodySha256, basis: prior.returnedBodyBasis, reason: prior.bodyHashReason }
  const priorFile: HashGroup = { sha256: prior.observedFileSha256, basis: prior.observedFileBasis, reason: prior.observedFileReason }
  const payloadGroup: HashGroup = suppressionReason ? { sha256: null, basis: null, reason: suppressionReason } : projectHashGroup(
    input, priorPayload,
    { sha256: "returnedPayloadSha256", basis: "returnedPayloadBasis", reason: "payloadHashReason" },
    "terminal-output-utf8.v1",
  )
  const bodyGroup: HashGroup = suppressionReason ? { sha256: null, basis: null, reason: suppressionReason } : projectHashGroup(
    input, priorBody,
    { sha256: "returnedBodySha256", basis: "returnedBodyBasis", reason: "bodyHashReason" },
    "opencode-1.18.33.trimmed-content.v1",
  )
  const fileGroup: HashGroup = suppressionReason ? { sha256: null, basis: null, reason: suppressionReason } : projectHashGroup(
    input, priorFile,
    { sha256: "observedFileSha256", basis: "observedFileBasis", reason: "observedFileReason" },
    "current-project-skill-file-at-observation.v1",
  )
  let observedFileSize = suppressionReason ? null : input.observedFileSize === undefined || input.observedFileSize === null
    ? prior.observedFileSha256 === null ? null : prior.observedFileSize
    : input.observedFileSize
  let observedFileAt = suppressionReason ? null : input.observedFileAt === undefined || input.observedFileAt === null
    ? prior.observedFileSha256 === null ? null : prior.observedFileAt
    : input.observedFileAt
  if (observedFileSize !== null && (typeof observedFileSize !== "number" || !Number.isSafeInteger(observedFileSize) || observedFileSize < 0 || observedFileSize > 128 * 1024)) fail("invalid_fact")
  if (observedFileAt !== null && (typeof observedFileAt !== "number" || !Number.isSafeInteger(observedFileAt) || observedFileAt < 0 || observedFileAt > now)) fail("invalid_fact")
  if (fileGroup.sha256 !== null && (observedFileSize === null || observedFileAt === null)) fail("invalid_fact")
  if (fileGroup.sha256 === null) { observedFileSize = null; observedFileAt = null }
  const returnedPayloadSha256 = payloadGroup.sha256
  const returnedPayloadBasis = payloadGroup.basis
  const payloadHashReason = payloadGroup.reason
  const returnedBodySha256 = bodyGroup.sha256
  const returnedBodyBasis = bodyGroup.basis
  const bodyHashReason = bodyGroup.reason
  const observedFileSha256 = fileGroup.sha256
  const observedFileBasis = fileGroup.basis
  const observedFileReason = fileGroup.reason
  const invalidRequestConflict = requestedNameReason === "invalid_name" && !!prior.requestedName
  const invalidReturnConflict = returnedNameReason === "invalid_name" && !!prior.returnedName
  const nameConflict = input.nameConflict === true || invalidRequestConflict || invalidReturnConflict ||
    (!!requestedName && !!returnedName && requestedName !== returnedName)
  return {
    ...prior,
    state: projectedState,
    returnedContent: projectedReturnedContent,
    requestedName: requestedName ?? prior.requestedName,
    requestedNameReason: requestedNameReason ?? prior.requestedNameReason,
    returnedName: returnedName ?? prior.returnedName,
    returnedNameReason: returnedNameReason ?? prior.returnedNameReason,
    nameConflict: nameConflict || prior.nameConflict,
    messageID: messageID ?? prior.messageID,
    taskID: taskID ?? prior.taskID,
    attemptID: attemptID ?? prior.attemptID,
    taskRelation,
    routeDecisionID: routeDecisionID ?? prior.routeDecisionID,
    startedAt,
    finishedAt,
    durationMs,
    returnedPayloadSha256,
    returnedPayloadBasis,
    payloadHashReason,
    returnedBodySha256,
    returnedBodyBasis,
    bodyHashReason,
    observedFileSha256,
    observedFileReason,
    observedFileSize,
    observedFileAt,
    observedFileBasis,
    beforeSeen: prior.beforeSeen || input.beforeSeen === true,
    terminalSeen: state !== "pending" || prior.terminalSeen,
    phase: prior.conflict ? "conflict" : state === "pending" ? "pending" : "terminal",
    loadedOriginalFileSha256: null,
    updatedAt: now,
  }
}

function storedCall(payload: string): SkillCallFact {
  let value: unknown
  try { value = JSON.parse(payload) } catch { fail("database_corrupt") }
  if (!isRecord(value) || value.kind !== "skill_call" || !validIdentifier(value.sessionID) || !validIdentifier(value.callID) ||
      !(value.phase === "pending" || value.phase === "terminal" || value.phase === "conflict") ||
      typeof value.beforeSeen !== "boolean" || typeof value.terminalSeen !== "boolean" || typeof value.conflict !== "boolean" ||
      typeof value.conflictCount !== "number" || !Number.isSafeInteger(value.conflictCount) || value.conflictCount < 0 ||
      value.loadedOriginalFileSha256 !== null || !Number.isSafeInteger(value.recordedAt) ||
      !Number.isSafeInteger(value.updatedAt) ||
      (value.phase === "pending" && value.state !== "pending") ||
      (value.phase === "terminal" && value.state === "pending")) {
    fail("database_corrupt")
  }
  const safe = projectCallObservation(value, value as unknown as SkillCallFact, value.updatedAt as number)
  safe.conflict = value.conflict
  safe.conflictCount = value.conflictCount as number
  safe.phase = value.phase
  safe.beforeSeen = value.beforeSeen
  safe.terminalSeen = value.terminalSeen
  safe.recordedAt = value.recordedAt as number
  safe.updatedAt = value.updatedAt as number
  safe.loadedOriginalFileSha256 = null
  return safe
}

function sameCallObservation(left: SkillCallFact, right: SkillCallFact): boolean {
  const copy = (fact: SkillCallFact) => {
    const { phase: _phase, conflict: _conflict, conflictCount: _count, recordedAt: _recordedAt, updatedAt: _updatedAt, ...semantic } = fact
    return JSON.stringify(semantic)
  }
  return copy(left) === copy(right)
}

function retainFirstObservedFile(prior: SkillCallFact, next: SkillCallFact): void {
  const hadObservation = prior.observedFileSha256 !== null || prior.observedFileReason !== null ||
    prior.observedFileAt !== null || prior.observedFileBasis !== null || prior.observedFileSize !== null
  if (!hadObservation) return
  next.observedFileSha256 = prior.observedFileSha256
  next.observedFileReason = prior.observedFileReason
  next.observedFileAt = prior.observedFileAt
  next.observedFileBasis = prior.observedFileBasis
  next.observedFileSize = prior.observedFileSize
}

function terminalCallConflict(prior: SkillCallFact, next: SkillCallFact): boolean {
  const contradicts = <T>(before: T | null, after: T | null) => before !== null && after !== null && before !== after
  return contradicts(prior.state === "pending" || prior.state === "unknown" ? null : prior.state,
    next.state === "pending" || next.state === "unknown" ? null : next.state) ||
    contradicts(prior.returnedContent === "unknown" ? null : prior.returnedContent, next.returnedContent === "unknown" ? null : next.returnedContent) ||
    contradicts(prior.requestedName, next.requestedName) || contradicts(prior.returnedName, next.returnedName) ||
    contradicts(prior.returnedPayloadSha256, next.returnedPayloadSha256) ||
    contradicts(prior.returnedBodySha256, next.returnedBodySha256) ||
    contradicts(prior.messageID, next.messageID) || contradicts(prior.taskID, next.taskID) ||
    contradicts(prior.attemptID, next.attemptID) || contradicts(prior.routeDecisionID, next.routeDecisionID) ||
    contradicts(prior.startedAt, next.startedAt) || contradicts(prior.finishedAt, next.finishedAt) ||
    contradicts(prior.durationMs, next.durationMs) || prior.nameConflict || next.nameConflict
}

/** Persist only the strict, path-free fingerprint projection for a previously admitted skill key. */
export function recordSkillCall(
  rootInput: string,
  token: SkillCallToken,
  observation: unknown,
  observedAt?: number,
): RecordResult {
  let db: Database | undefined
  try {
    if (!token || !validSkillCampaignID(token.campaignID) || !validIdentifier(token.sessionID) || !validIdentifier(token.callID) ||
        typeof token.admissionKey !== "string" || !/^[a-f0-9]{64}$/.test(token.admissionKey)) return { recorded: false, code: "invalid_identifier" }
    const root = canonicalRoot(rootInput)
    db = openDatabase(observationPath(root), false)
    return immediate(db, () => {
      const now = decisionClock(observedAt)
      const initial = campaignRow(db!)
      if (initial.owner_binding !== ownerBinding(root)) return { recorded: false, code: "binding_mismatch" }
      if (initial.campaign_id !== token.campaignID) return { recorded: false, code: "campaign_mismatch" }
      const campaign = enforceClockAndExpiry(db!, now)
      if (campaign.status === "closed") return { recorded: false, code: "closed" }
      const expectedKey = hashKey(campaign.salt, "call", token.sessionID, token.callID)
      if (expectedKey !== token.admissionKey || !db!.query("SELECT 1 FROM call_keys WHERE key_hash = ?").get(expectedKey)) {
        return { recorded: false, code: "invalid_identifier" }
      }
      const row = db!.query(`
        SELECT * FROM facts WHERE kind = 'skill_call' AND session_id = ? AND fact_key = ?
      `).get(token.sessionID, token.callID) as FactRow | undefined
      if (!row) return { recorded: false, code: "database_corrupt" }
      if (createHash("sha256").update(row.payload_json).digest("hex") !== row.semantic_hash) fail("database_corrupt")
      const prior = storedCall(row.payload_json)
      if (prior.conflict) return { recorded: false, code: "conflict" }
      if (campaign.status === "draining" && (row.phase !== "pending" || campaign.cutoff_seq === null ||
          row.sequence > campaign.cutoff_seq || !isRecord(observation) || observation.state === "pending")) {
        return { recorded: false, code: "draining" }
      }
      const projected = projectCallObservation(observation, prior, now)
      retainFirstObservedFile(prior, projected)
      const incomingTerminal = projected.state !== "pending"
      if (campaign.status === "draining" && !incomingTerminal) return { recorded: false, code: "draining" }
      if (row.phase !== "pending") {
        if (sameCallObservation(prior, projected)) return { recorded: false, code: "replay" }
        if (!terminalCallConflict(prior, projected)) return { recorded: false, code: "replay" }
        projected.conflict = true
        projected.conflictCount = prior.conflictCount + 1
        projected.phase = "conflict"
        const json = JSON.stringify(projected)
        db!.query(`UPDATE facts SET phase = 'conflict', conflict = 1, payload_json = ?, semantic_hash = ?, updated_at = ? WHERE id = ?`)
          .run(json, createHash("sha256").update(json).digest("hex"), now, row.id)
        return { recorded: true, code: "conflict" }
      }
      const hasConflict = terminalCallConflict(prior, projected)
      if (hasConflict) {
        projected.conflict = true
        projected.conflictCount = prior.conflictCount + 1
      }
      if (projected.state === "pending" && prior.state === "pending") projected.phase = "pending"
      else projected.phase = projected.conflict ? "conflict" : "terminal"
      const json = JSON.stringify(projected)
      const hash = createHash("sha256").update(json).digest("hex")
      db!.query(`UPDATE facts SET phase = ?, conflict = ?, payload_json = ?, semantic_hash = ?, updated_at = ? WHERE id = ?`)
        .run(projected.phase, projected.conflict ? 1 : 0, json, hash, now, row.id)
      if (campaign.status === "draining") closeIfDrained(db!, now)
      return { recorded: true, code: projected.conflict ? "conflict" : "recorded" }
    })
  } catch (error) {
    return { recorded: false, code: fixedCode(error) }
  } finally {
    db?.close()
  }
}

function safeEnum<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback
}

function projectTurn(input: unknown, now = Number.MAX_SAFE_INTEGER): FactProjection {
  if (!isRecord(input) || !validIdentifier(input.sessionID) || !validIdentifier(input.messageID) ||
      !(input.phase === "pending" || input.phase === "terminal")) fail("invalid_fact")
  const startedAt = optionalTimestamp(input.startedAt, now)
  const finishedAt = optionalTimestamp(input.finishedAt, now)
  if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) fail("invalid_fact")
  const role = safeEnum(input.role, ["user", "assistant", "unknown"] as const, "unknown")
  const parentMessageID = optionalID(input.parentMessageID)
  const actualAgent = optionalID(input.actualAgent)
  const agentBasis = safeEnum(input.agentBasis, ["sdk_agent_field", "host_metadata", "unknown"] as const, "unknown")
  const actualModel = optionalModel(input.actualModel)
  const modelBasis = safeEnum(input.modelBasis, ["sdk_model_field", "host_metadata", "unknown"] as const, "unknown")
  const routerEligibility = safeEnum(input.routerEligibility, ["eligible", "ineligible", "unknown"] as const, "unknown")
  const routerExposure = safeEnum(input.routerExposure, ["suggest", "shadow", "bypass", "none", "unknown"] as const, "unknown")
  const bypassReason = safeEnum(input.bypassReason, ["disabled", "shadow", "permission", "invalid", "none", "unknown"] as const, "unknown")
  const routeDecisionID = optionalID(input.routeDecisionID)
  const routeSkillName = optionalSkillName(input.routeSkillName)
  const adviceInserted = input.adviceInserted === true ? true : input.adviceInserted === false ? false : null
  const requestEvidence = safeEnum(input.requestEvidence, ["skill_command", "unknown", "none"] as const, "unknown")
  const configGeneration = digest(input.configGeneration)
  const closureReason = safeEnum(input.closureReason, ["completed", "compacted", "deleted", "unknown"] as const, "unknown")
  return {
    kind: "turn_context", sessionID: input.sessionID, factKey: input.messageID, phase: input.phase,
    payload: { schemaVersion: 1, sessionID: input.sessionID, messageID: input.messageID, phase: input.phase,
      startedAt, finishedAt, role,
      parentMessageID, actualAgent, agentBasis, actualModel, modelBasis, routerEligibility, routerExposure, bypassReason,
      routeDecisionID, routeSkillName, adviceInserted, requestEvidence, configGeneration, closureReason },
  }
}

function projectTask(input: unknown): FactProjection {
  if (!isRecord(input) || !validIdentifier(input.sessionID) || !validIdentifier(input.taskID) || !validIdentifier(input.attemptID) ||
      !(input.phase === "pending" || input.phase === "terminal")) fail("invalid_fact")
  const status = safeEnum(input.status, ["started", "done", "failed", "cancelled", "unknown"] as const, "unknown")
  if ((input.phase === "pending") !== (status === "started")) fail("invalid_fact")
  const taskStatus = safeEnum(input.taskStatus, ["done", "failed", "cancelled", "open", "unknown"] as const, "unknown")
  const ownerSessionID = optionalID(input.ownerSessionID)
  const childSessionID = optionalID(input.childSessionID)
  const childMessageID = optionalID(input.childMessageID)
  const resumeRequested = input.resumeRequested === undefined || input.resumeRequested === null
    ? null
    : typeof input.resumeRequested === "boolean" ? input.resumeRequested : fail("invalid_fact")
  const actualRole = safeEnum(input.actualRole, ["main", "worker", "reviewer", "data-analyst", "data-verifier", "unknown"] as const, "unknown")
  const roleBasis = safeEnum(input.roleBasis, ["sdk_agent_field", "host_metadata", "code_owned", "unknown"] as const, "unknown")
  const taskKind = safeEnum(input.taskKind, ["code", "data", "unknown"] as const, "unknown")
  const messageID = optionalID(input.messageID)
  const originTaskID = optionalID(input.originTaskID)
  const resumeOfAttemptID = optionalID(input.resumeOfAttemptID)
  const workflowID = optionalID(input.workflowID)
  const planSha256 = digest(input.planSha256)
  const factKey = createHash("sha256").update(`${input.taskID}\0${input.attemptID}`).digest("hex")
  return {
    kind: "task_context", sessionID: input.sessionID, factKey, phase: input.phase,
    payload: { schemaVersion: 1, sessionID: input.sessionID, taskID: input.taskID, attemptID: input.attemptID,
      phase: input.phase, status, taskStatus, ownerSessionID, childSessionID, childMessageID, resumeRequested, actualRole, roleBasis, messageID,
      originTaskID, resumeOfAttemptID, workflowID, planSha256, taskKind },
  }
}

function projectVerification(input: unknown, now = Number.MAX_SAFE_INTEGER): FactProjection {
  if (!isRecord(input) || !validIdentifier(input.sessionID) || !validIdentifier(input.verificationID) ||
      !validIdentifier(input.taskID) || !validIdentifier(input.attemptID) ||
      !(input.phase === "pending" || input.phase === "terminal") || typeof input.codeOwned !== "boolean") fail("invalid_fact")
  const status = safeEnum(input.status,
    ["started", "pass", "fail", "refused", "invalidated", "timed_out", "aborted", "not_run", "unknown"] as const,
    "unknown")
  if ((input.phase === "pending") !== (status === "started")) fail("invalid_fact")
  const exitCode = input.exitCode === undefined || input.exitCode === null ? null : input.exitCode
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) || exitCode < -255 || exitCode > 255)) fail("invalid_fact")
  const startedAt = optionalTimestamp(input.startedAt, now)
  const finishedAt = optionalTimestamp(input.finishedAt, now)
  const durationMs = optionalDuration(input.durationMs)
  if (startedAt !== null && finishedAt !== null && (finishedAt < startedAt ||
      (durationMs !== null && durationMs !== finishedAt - startedAt))) fail("invalid_fact")
  const taskStatus = safeEnum(input.taskStatus, ["done", "failed", "cancelled", "open", "unknown"] as const, "unknown")
  const reviewVerdict = safeEnum(input.reviewVerdict, ["accept", "revise", "reject", "skipped", "error", "unknown"] as const, "unknown")
  return {
    kind: "verification_observation", sessionID: input.sessionID, factKey: input.verificationID, phase: input.phase,
    payload: { schemaVersion: 1, sessionID: input.sessionID, verificationID: input.verificationID,
      taskID: input.taskID, attemptID: input.attemptID, phase: input.phase, status, codeOwned: input.codeOwned,
      exitCode, taskStatus, reviewVerdict, startedAt, finishedAt, durationMs },
  }
}

function storedFactProjection(kind: FactProjection["kind"], input: unknown, now = Number.MAX_SAFE_INTEGER): FactProjection {
  if (kind === "turn_context") return projectTurn(input, now)
  if (kind === "task_context") return projectTask(input)
  if (kind === "tool_context") return projectRelatedTool(input, now)
  return projectVerification(input, now)
}

function projectRelatedTool(input: unknown, now = Number.MAX_SAFE_INTEGER): FactProjection {
  if (!isRecord(input) || !validIdentifier(input.sessionID) || !validIdentifier(input.callID) ||
      !validIdentifier(input.tool) || input.tool === "skill" ||
      !(input.phase === "pending" || input.phase === "terminal")) fail("invalid_fact")
  const status = safeEnum(input.status, ["pending", "completed", "error", "unknown"] as const, "unknown")
  if (input.phase === "pending" && status !== "pending") fail("invalid_fact")
  const messageID = optionalID(input.messageID)
  const startedAt = optionalTimestamp(input.startedAt, now)
  const finishedAt = optionalTimestamp(input.finishedAt, now)
  const durationMs = optionalDuration(input.durationMs)
  if (startedAt !== null && finishedAt !== null && (finishedAt < startedAt ||
      (durationMs !== null && durationMs !== finishedAt - startedAt))) fail("invalid_fact")
  return {
    kind: "tool_context", sessionID: input.sessionID, factKey: input.callID, phase: input.phase,
    payload: { schemaVersion: 1, sessionID: input.sessionID, callID: input.callID, messageID, tool: input.tool,
      phase: input.phase, status, startedAt, finishedAt, durationMs },
  }
}

function jsonObject(raw: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(raw) } catch { fail("database_corrupt") }
  if (!isRecord(value)) fail("database_corrupt")
  return value
}

function recordGenericFact(
  rootInput: string,
  campaignID: string,
  kind: FactProjection["kind"],
  input: unknown,
  observedAt?: number,
): RecordResult {
  let db: Database | undefined
  try {
    if (!validSkillCampaignID(campaignID)) return { recorded: false, code: "invalid_campaign_id" }
    const root = canonicalRoot(rootInput)
    db = openDatabase(observationPath(root), false)
    return immediate(db, () => {
      const now = decisionClock(observedAt)
      const initial = campaignRow(db!)
      if (initial.owner_binding !== ownerBinding(root)) return { recorded: false, code: "binding_mismatch" }
      if (initial.campaign_id !== campaignID) return { recorded: false, code: "campaign_mismatch" }
      const campaign = enforceClockAndExpiry(db!, now)
      if (campaign.status === "closed") return { recorded: false, code: campaign.stop_reason === "resource_cap" ? "resource_cap" : "closed" }
      // Identity is the only input inspected before the draining allowlist check.
      if (!isRecord(input) || !validIdentifier(input.sessionID)) return { recorded: false, code: "invalid_identifier" }
      let lookupKey: string | null = null
      if (kind === "turn_context" && validIdentifier(input.messageID)) lookupKey = input.messageID
      if (kind === "task_context" && validIdentifier(input.taskID) && validIdentifier(input.attemptID)) {
        lookupKey = createHash("sha256").update(`${input.taskID}\0${input.attemptID}`).digest("hex")
      }
      if (kind === "verification_observation" && validIdentifier(input.verificationID)) lookupKey = input.verificationID
      if (kind === "tool_context" && validIdentifier(input.callID)) lookupKey = input.callID
      if (!lookupKey) return { recorded: false, code: "invalid_identifier" }
      const old = db!.query("SELECT * FROM facts WHERE kind = ? AND session_id = ? AND fact_key = ?")
        .get(kind, input.sessionID, lookupKey) as FactRow | undefined
      if (campaign.status === "draining" && (!old || old.phase !== "pending" || input.phase !== "terminal" ||
          campaign.cutoff_seq === null || old.sequence > campaign.cutoff_seq)) {
        return { recorded: false, code: "draining" }
      }
      let projection = storedFactProjection(kind, input, now)
      const terminalFinishedAt = input.phase === "terminal" && isRecord(projection.payload)
        ? projection.payload.finishedAt : null
      if (!old && typeof terminalFinishedAt === "number" && terminalFinishedAt < campaign.activated_at) {
        countAdmissionRejection(db!, "preactivation")
        return { recorded: false, code: "preactivation" }
      }
      const sessionHash = hashKey(campaign.salt, "session", projection.sessionID)
      if (!old) {
        if (campaign.status !== "open") return { recorded: false, code: "draining" }
        const knownSession = !!db!.query("SELECT 1 FROM session_keys WHERE key_hash = ?").get(sessionHash)
        if (!knownSession && campaign.session_count >= SKILL_OBSERVATION_LIMITS.sessions) {
          closeCampaign(db!, now, "session_limit", "quota_reached")
          if (campaign.next_sequence > 0) updateCampaign(db!, { cutoff_seq: campaign.next_sequence, cutoff_reason: "session_limit" })
          return { recorded: false, code: "quota_limit" }
        }
        if (campaign.status !== "open") return { recorded: false, code: "closed" }
        if (rawFactCount(db!) + (knownSession ? 1 : 2) > SKILL_OBSERVATION_LIMITS.facts || statSync(observationPath(root)).size >= SKILL_OBSERVATION_LIMITS.databaseBytes) {
          closeForResourceCap(db!, now)
          return { recorded: false, code: "resource_cap" }
        }
        const sequence = nextSequence(db!)
        if (!knownSession) db!.query("INSERT INTO session_keys (key_hash, admitted_at) VALUES (?, ?)").run(sessionHash, now)
        const nextSessions = campaign.session_count + (knownSession ? 0 : 1)
        writeFactRow(db!, projection.kind, projection.sessionID, projection.factKey, projection.phase, false, projection.payload, now, sequence)
        updateCampaign(db!, { session_count: nextSessions, last_observed_clock: now })
        if (nextSessions === SKILL_OBSERVATION_LIMITS.sessions) setQuotaCutoff(db!, now, sequence, "session_limit")
        return { recorded: true, code: "recorded" }
      }
      const prior = jsonObject(old.payload_json)
      if (createHash("sha256").update(old.payload_json).digest("hex") !== old.semantic_hash) fail("database_corrupt")
      if (old.conflict) return { recorded: false, code: "conflict" }
      // Partial host updates may add proven identity; absent/unknown fields never erase prior evidence.
      const merged = { ...prior }
      for (const key of Object.keys(projection.payload)) {
        const value = input[key]
        if (value !== undefined && value !== null && value !== "unknown") merged[key] = value
      }
      if (old.phase === "terminal" && input.phase === "pending") {
        merged.phase = "terminal"
        if ("status" in prior) merged.status = prior.status
      }
      projection = storedFactProjection(kind, merged, now)
      const nextJson = JSON.stringify(projection.payload)
      const nextHash = createHash("sha256").update(nextJson).digest("hex")
      if (old.semantic_hash === nextHash) return { recorded: false, code: "replay" }
      const taskStatusCanRefine = kind === "task_context" &&
        (prior.taskStatus === "open" || prior.taskStatus === "unknown") &&
        ["done", "failed", "cancelled", "open"].includes(String(projection.payload.taskStatus))
      const progressFields = new Set(["phase", "agentBasis", "modelBasis", "roleBasis",
        ...(old.phase === "pending" ? ["status", "exitCode", "taskStatus", "reviewVerdict"] : []),
        ...(taskStatusCanRefine ? ["taskStatus"] : [])])
      const mismatch = Object.entries(prior).some(([key, value]) =>
        !progressFields.has(key) && value !== null && value !== undefined && value !== "unknown" &&
        projection.payload[key] !== value)
      if (mismatch) {
        db!.query("UPDATE facts SET phase = 'conflict', conflict = 1, updated_at = ? WHERE id = ?").run(now, old.id)
        if (campaign.status === "draining") closeIfDrained(db!, now)
        return { recorded: true, code: "conflict" }
      }
      const phase: FactRow["phase"] = projection.phase
      db!.query("UPDATE facts SET phase = ?, payload_json = ?, semantic_hash = ?, updated_at = ? WHERE id = ?")
        .run(phase, nextJson, nextHash, now, old.id)
      if (campaign.status === "draining") closeIfDrained(db!, now)
      return { recorded: true, code: "recorded" }
    })
  } catch (error) {
    return { recorded: false, code: fixedCode(error) }
  } finally {
    db?.close()
  }
}

/** Record exact message/parent and routing exposure facts; no inferred text or ancestry is accepted. */
export function recordSkillTurn(root: string, campaignID: string, input: SkillTurnFactInput, observedAt?: number): RecordResult {
  return recordGenericFact(root, campaignID, "turn_context", input, observedAt)
}

/** Record code-owned task/attempt identity and terminal state, never title/detail/report text. */
export function recordSkillTask(root: string, campaignID: string, input: SkillTaskFactInput, observedAt?: number): RecordResult {
  return recordGenericFact(root, campaignID, "task_context", input, observedAt)
}

/** Verification evidence remains separate from tool-call and task completion facts. */
export function recordSkillVerification(root: string, campaignID: string, input: SkillVerificationFactInput, observedAt?: number): RecordResult {
  return recordGenericFact(root, campaignID, "verification_observation", input, observedAt)
}

export function recordRelatedTool(root: string, campaignID: string, input: RelatedToolFactInput, observedAt?: number): RecordResult {
  return recordGenericFact(root, campaignID, "tool_context", input, observedAt)
}

function cleanupExpired(db: Database, now: number): void {
  const cutoff = now - SKILL_OBSERVATION_LIMITS.retentionMs
  const old = db.query("SELECT COUNT(*) AS count FROM facts WHERE recorded_at < ?").get(cutoff) as { count: number }
  const count = Math.min(SKILL_OBSERVATION_LIMITS.cleanupRows, Math.max(0, Number(old.count) || 0))
  if (count === 0) return
  const deleted = db.query(`
    DELETE FROM facts WHERE id IN (
      SELECT id FROM facts WHERE recorded_at < ? ORDER BY recorded_at, id LIMIT ?
    )
  `).run(cutoff, count).changes
  const row = campaignRow(db)
  updateCampaign(db, { expired_fact_count: row.expired_fact_count + deleted })
}

function safeStoredPayload(kind: StoredSkillFact["kind"], input: unknown): { payload: Record<string, unknown>; factKey: string } {
  if (kind === "skill_call") {
    const call = storedCall(JSON.stringify(input))
    return { payload: call as unknown as Record<string, unknown>, factKey: call.callID }
  }
  const projection = storedFactProjection(kind, input)
  return { payload: projection.payload, factKey: projection.factKey }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function stableSnapshotJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSnapshotJson).join(",")}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSnapshotJson(value[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

const HEALTH_CODES: readonly SkillHealthCode[] = [
  "ok", "database_missing", "database_corrupt", "binding_mismatch", "campaign_missing", "campaign_exists",
  "campaign_mismatch", "invalid_campaign_id", "invalid_identifier", "invalid_fact", "closed", "draining",
  "quota_limit", "preactivation", "resource_cap", "busy", "storage_error", "invalid_clock",
]

function validRejectionCounts(value: unknown): value is SkillRejectionCounts {
  return isRecord(value) && exactKeys(value, ["invalid_identifier", "invalid_fact", "preactivation"]) &&
    nonNegativeInteger(value.invalid_identifier) && value.invalid_identifier <= SKILL_OBSERVATION_LIMITS.rejectionCount &&
    nonNegativeInteger(value.invalid_fact) && value.invalid_fact <= SKILL_OBSERVATION_LIMITS.rejectionCount &&
    nonNegativeInteger(value.preactivation) && value.preactivation <= SKILL_OBSERVATION_LIMITS.rejectionCount
}

function validCampaignSnapshot(value: unknown, available: boolean, health: SkillHealthCode): value is SkillCampaignStatus {
  if (!isRecord(value) || !exactKeys(value, [
    "available", "health", "campaignID", "ownerBinding", "status", "sessionCount", "callCount", "activatedAt", "cutoffSeq",
    "cutoffReason", "stopReason", "closureReason", "drainDeadline", "closedAt", "pendingCount", "censoredCount",
    "rejections", "storedFactCount", "expiredFactCount", "notCollectedAfterStop", "populationComplete",
  ]) || value.available !== available || value.health !== health || typeof value.notCollectedAfterStop !== "boolean" ||
      value.populationComplete !== false || !nonNegativeInteger(value.sessionCount) || value.sessionCount > SKILL_OBSERVATION_LIMITS.sessions ||
      !nonNegativeInteger(value.callCount) || value.callCount > SKILL_OBSERVATION_LIMITS.calls ||
      !nonNegativeInteger(value.pendingCount) || value.pendingCount > SKILL_OBSERVATION_LIMITS.facts ||
      !nonNegativeInteger(value.censoredCount) || value.censoredCount > SKILL_OBSERVATION_LIMITS.facts ||
      !validRejectionCounts(value.rejections) ||
      !nonNegativeInteger(value.storedFactCount) || value.storedFactCount > SKILL_OBSERVATION_LIMITS.facts ||
      !nonNegativeInteger(value.expiredFactCount) ||
      !(value.ownerBinding === null || typeof value.ownerBinding === "string" && /^[a-f0-9]{64}$/.test(value.ownerBinding)) ||
      !(value.activatedAt === null || nonNegativeInteger(value.activatedAt)) ||
      !(value.cutoffSeq === null || nonNegativeInteger(value.cutoffSeq) && value.cutoffSeq > 0) ||
      !(value.drainDeadline === null || nonNegativeInteger(value.drainDeadline)) ||
      !(value.closedAt === null || nonNegativeInteger(value.closedAt)) ||
      !(value.cutoffReason === null || typeof value.cutoffReason === "string" && ["session_limit", "call_limit", "both_limits"].includes(value.cutoffReason)) ||
      !(value.stopReason === null || typeof value.stopReason === "string" &&
        ["session_limit", "call_limit", "both_limits", "manual_stop", "expired", "clock_uncertain", "resource_cap"].includes(value.stopReason)) ||
      !(value.closureReason === null || typeof value.closureReason === "string" &&
        ["quota_reached", "pending_drained", "quota_deadline", "manual_stop", "expired", "clock_uncertain", "resource_cap"].includes(value.closureReason))) {
    return false
  }
  if (!available) {
    return value.campaignID === null && value.ownerBinding === null && value.status === null && value.sessionCount === 0 && value.callCount === 0 &&
      value.activatedAt === null && value.cutoffSeq === null && value.cutoffReason === null && value.stopReason === null &&
      value.closureReason === null && value.drainDeadline === null && value.closedAt === null && value.pendingCount === 0 &&
      value.censoredCount === 0 && value.rejections.invalid_identifier === 0 && value.rejections.invalid_fact === 0 &&
      value.rejections.preactivation === 0 && value.storedFactCount === 0 && value.expiredFactCount === 0 && value.notCollectedAfterStop
  }
  if (health !== "ok" || !validSkillCampaignID(value.campaignID) || typeof value.ownerBinding !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.ownerBinding) ||
      !(value.status === "open" || value.status === "draining" || value.status === "closed") ||
      value.notCollectedAfterStop !== (value.status !== "open") ||
      (value.status === "closed" ? value.pendingCount !== 0 : value.censoredCount !== 0)) return false
  if (value.status === "open") return value.cutoffSeq === null && value.cutoffReason === null && value.stopReason === null &&
    value.closureReason === null && value.drainDeadline === null && value.closedAt === null
  if (value.status === "draining") return value.cutoffSeq !== null && value.cutoffReason !== null && value.stopReason !== null &&
    value.closureReason === null && value.drainDeadline !== null && value.closedAt === null
  return value.stopReason !== null && value.closureReason !== null && value.closedAt !== null
}

/** Strict, standalone validation for sanitized observation snapshots before durable export. */
export function validateSkillObservationSnapshot(value: unknown): value is SkillObservationList {
  try {
    if (!isRecord(value) || !exactKeys(value, ["available", "health", "campaign", "facts", "coverage"]) ||
        typeof value.available !== "boolean" || typeof value.health !== "string" || !HEALTH_CODES.includes(value.health as SkillHealthCode) ||
        !validCampaignSnapshot(value.campaign, value.available, value.health as SkillHealthCode) ||
        !Array.isArray(value.facts) || value.facts.length > SKILL_OBSERVATION_LIMITS.maxListRows || !isRecord(value.coverage) ||
        !exactKeys(value.coverage, ["storedFacts", "returnedFacts", "unscannedStoredFacts", "expiredFacts", "truncated", "unscannedTotal", "notCollectedAfterStop", "populationComplete"])) {
      return false
    }
    const campaign = value.campaign as SkillCampaignStatus
    const coverage = value.coverage
    if (!nonNegativeInteger(coverage.storedFacts) || !nonNegativeInteger(coverage.returnedFacts) ||
        !nonNegativeInteger(coverage.unscannedStoredFacts) || !nonNegativeInteger(coverage.expiredFacts) ||
        coverage.returnedFacts !== value.facts.length || coverage.returnedFacts > coverage.storedFacts ||
        coverage.unscannedStoredFacts > coverage.storedFacts || typeof coverage.truncated !== "boolean" ||
        !(coverage.unscannedTotal === "known" || coverage.unscannedTotal === "unknown") ||
        coverage.unscannedTotal !== (coverage.truncated ? "unknown" : "known") ||
        typeof coverage.notCollectedAfterStop !== "boolean" || coverage.notCollectedAfterStop !== campaign.notCollectedAfterStop ||
        coverage.populationComplete !== false || coverage.storedFacts !== campaign.storedFactCount ||
        coverage.expiredFacts !== campaign.expiredFactCount || (!coverage.truncated && coverage.unscannedStoredFacts !== 0)) return false

    const seen = new Set<string>()
    for (const candidate of value.facts) {
      if (!isRecord(candidate) || !exactKeys(candidate, ["kind", "sessionID", "factKey", "phase", "conflict", "recordedAt", "payload"]) ||
          !(candidate.kind === "skill_call" || candidate.kind === "turn_context" || candidate.kind === "task_context" ||
            candidate.kind === "verification_observation" || candidate.kind === "tool_context") || !validIdentifier(candidate.sessionID) || !validIdentifier(candidate.factKey) ||
          !(candidate.phase === "pending" || candidate.phase === "terminal" || candidate.phase === "conflict") ||
          typeof candidate.conflict !== "boolean" || (candidate.phase === "conflict") !== candidate.conflict ||
          !nonNegativeInteger(candidate.recordedAt) || !isRecord(candidate.payload)) return false
      const identity = `${candidate.kind}\0${candidate.sessionID}\0${candidate.factKey}`
      if (seen.has(identity)) return false
      seen.add(identity)
      const projected = safeStoredPayload(candidate.kind, candidate.payload)
      if (projected.factKey !== candidate.factKey || stableSnapshotJson(projected.payload) !== stableSnapshotJson(candidate.payload)) return false
      if (candidate.kind === "skill_call" && (candidate.payload.phase !== candidate.phase || candidate.payload.conflict !== candidate.conflict)) return false
    }
    const serialized = JSON.stringify(value)
    return typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") <= SKILL_OBSERVATION_LIMITS.maxListBytes
  } catch {
    return false
  }
}

/** Bounded sanitized snapshot; stored/unscanned totals remain explicit and population completeness is never asserted. */
export function listSkillObservations(rootInput: string, options: { limit?: number; observedAt?: number } = {}): SkillObservationList {
  let db: Database | undefined
  try {
    const root = canonicalRoot(rootInput)
    db = openDatabase(observationPath(root), false)
    return immediate(db, () => {
      const now = decisionClock(options.observedAt)
      if (campaignRow(db!).owner_binding !== ownerBinding(root)) fail("binding_mismatch")
      enforceClockAndExpiry(db!, now, true)
      const campaign = statusFromDatabase(db!, root, now)
      const requestedLimit = options.limit
      const limit = typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
        ? Math.min(SKILL_OBSERVATION_LIMITS.maxListRows, Math.max(0, Math.floor(requestedLimit)))
        : DEFAULT_LIST_ROWS
      const cutoff = now - SKILL_OBSERVATION_LIMITS.retentionMs
      const count = db!.query("SELECT COUNT(*) AS count FROM facts WHERE recorded_at >= ?").get(cutoff) as { count: number }
      const total = Math.max(0, Number(count.count) || 0)
      const rows = db!.query(`
        SELECT id, kind, session_id, fact_key, phase, conflict, payload_json, semantic_hash, recorded_at, updated_at, sequence
        FROM facts WHERE recorded_at >= ? ORDER BY sequence, id LIMIT ?
      `).all(cutoff, limit) as FactRow[]
      const facts: StoredSkillFact[] = []
      let invalidRows = 0
      let scannedRows = 0
      let outputBytes = 0
      let sizeTruncated = false
      for (const row of rows) {
      if (Buffer.byteLength(row.payload_json, "utf8") > SKILL_OBSERVATION_LIMITS.maxListBytes) {
        invalidRows++
        scannedRows++
        continue
      }
      try {
        if (createHash("sha256").update(row.payload_json).digest("hex") !== row.semantic_hash) {
          invalidRows++
          scannedRows++
          continue
        }
        if (!(["skill_call", "turn_context", "task_context", "verification_observation", "tool_context"] as string[]).includes(row.kind) ||
            !(row.phase === "pending" || row.phase === "terminal" || row.phase === "conflict") ||
            (row.conflict !== 0 && row.conflict !== 1) || !Number.isSafeInteger(row.recorded_at)) {
          invalidRows++
          scannedRows++
          continue
        }
        const projected = safeStoredPayload(row.kind, JSON.parse(row.payload_json))
        const payload = projected.payload
        if (!validIdentifier(row.session_id) || !validIdentifier(row.fact_key) || payload.sessionID !== row.session_id ||
            projected.factKey !== row.fact_key) {
          invalidRows++
          scannedRows++
          continue
        }
        const fact: StoredSkillFact = {
          kind: row.kind, sessionID: row.session_id, factKey: row.fact_key, phase: row.phase,
          conflict: row.conflict === 1, recordedAt: row.recorded_at, payload,
        }
        const factBytes = Buffer.byteLength(JSON.stringify(fact), "utf8")
        if (outputBytes + factBytes > SKILL_OBSERVATION_LIMITS.maxListBytes) {
          sizeTruncated = true
          break
        }
        facts.push(fact)
        outputBytes += factBytes
        scannedRows++
      } catch {
        invalidRows++
        scannedRows++
      }
    }
      const truncated = total > scannedRows || invalidRows > 0 || sizeTruncated
      return {
        available: true,
        health: invalidRows ? "database_corrupt" : "ok",
        campaign,
        facts,
        coverage: {
          storedFacts: total,
          returnedFacts: facts.length,
          unscannedStoredFacts: Math.max(0, total - scannedRows),
          expiredFacts: campaign.expiredFactCount,
          truncated,
          unscannedTotal: truncated ? "unknown" : "known",
          notCollectedAfterStop: campaign.notCollectedAfterStop,
          populationComplete: false,
        },
      }
    })
  } catch (error) {
    const health = fixedCode(error)
    const campaign = unavailableStatus(health)
    return {
      available: false, health, campaign, facts: [],
      coverage: {
        storedFacts: 0, returnedFacts: 0, unscannedStoredFacts: 0, expiredFacts: 0,
        truncated: true, unscannedTotal: "unknown", notCollectedAfterStop: true, populationComplete: false,
      },
    }
  } finally {
    db?.close()
  }
}

/** Call from observer hooks to guarantee storage/validation faults never escape into business operations. */
export function bestEffortSkillObservation<T>(action: () => T): { ok: true; value: T } | { ok: false; health: SkillHealthCode } {
  try {
    return { ok: true, value: action() }
  } catch (error) {
    return { ok: false, health: fixedCode(error) }
  }
}
