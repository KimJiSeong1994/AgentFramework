import { randomUUID } from "node:crypto"
import { isAttachmentEpoch } from "../flow/owner.ts"
import * as childProcess from "node:child_process"
import * as fs from "node:fs"
import { Database } from "bun:sqlite"
import { basename, dirname, join, parse, resolve, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { durableWriteJson, ensureDurableDirectory } from "../state/durable.ts"
import { sessionDir, stateRoot } from "../state/store.ts"
import { pendingSkillPermissionActivityCount, pendingSkillPermissionActivityCountForSession } from "../skills/activity.ts"
import { consumeValidatedResumeProof } from "./admission.ts"
import { validateComboRoutes } from "../hosts/default-model.ts"
import type { ComboRoutes } from "../hosts/types.ts"
import { validPlanningTiming } from "../telemetry/planning.ts"

export type TranscriptKind = "user" | "assistant" | "canonical-plan" | "tool-start" | "tool-result" | "tool-denied" | "task-state" | "task-evidence" | "workflow-stage" | "workflow-choice" | "notice" | "carried-context" | "context-window" | "model-rebind" | "shell" | "verify" | "action" | "timing"
export type TranscriptRecord = { seq: number; kind: TranscriptKind; eventID: string; data: Record<string, unknown> }
export type SessionMetadata = {
  version: 1
  engine: string
  model?: string
  /** Immutable per-role combo routes pinned at creation; absent equals empty. */
  routes?: ComboRoutes
  held: boolean
  holdReason?: string
  createdAt?: number
  updatedAt?: number
}
export type SessionReleaseProof = {
  workflowQuiescent: true
  evidence: string
  workflowID: string | null
  revision: number | null
}
export type SessionClearHoldProof = { authorized: true; reason: string }
export type SessionOpenMetadata = { engine: string; model?: string; routes?: ComboRoutes }
export type ReplayOptions = { offset?: number; limit?: number; query?: string; order?: "asc" | "desc"; kind?: TranscriptKind; excludeKinds?: readonly TranscriptKind[] }
export type ReplayResult = { records: TranscriptRecord[]; relatedRecords?: TranscriptRecord[]; complete: boolean; recoveryNotice?: string; nextOffset?: number; totalRecords?: number }
export type InspectedSession = { sessionID: string; engine: string; model?: string; routes?: ComboRoutes; held: boolean; lastActivityAt?: number; summary?: string; corrupt?: string }
export type SessionAttachmentInspection =
  | { state: "attached"; epoch: string; sessionID: string; worktree: string; bootID: string; pid: number; processStart: string; identity: "live" | "dead" | "ambiguous" }
  | { state: "released"; epoch: string; sessionID: string; worktree: string; workflowID: string | null; revision: number | null; releaseEvidence: string }

export interface SessionStore {
  readonly sessionID: string
  readonly epoch: string
  readonly isReleased: boolean
  readonly metadata: SessionMetadata
  readonly restored: boolean
  append(kind: TranscriptKind, data: Record<string, unknown>, eventID?: string): TranscriptRecord
  hold(reason: string): void
  clearHold(proof: SessionClearHoldProof): void
  /**
   * Durably replace this attachment's model and routes in place. The engine and session identity never change;
   * callers (sessions/admission.ts rebindAdmissionModel) prove epoch, quiescence and workflow binding first.
   */
  rebindModel(next: SessionOpenMetadata): { from: SessionOpenMetadata; to: SessionOpenMetadata }
  assertOwner(): void
  release(proof: SessionReleaseProof): void
}

type SessionLock = {
  version: 1
  token: string
  epoch: string
  worktree: string
  sessionID: string
  bootID: string
  processStart: string
  pid: number
}
type Attachment = Omit<SessionLock, "token"> & {
  state: "attached" | "released"
  attachedAt: number
  releasedAt?: number
  releaseEvidence?: string
  workflowID?: string | null
  revision?: number | null
}
type SegmentManifest = { name: string; firstSeq: number; lastSeq: number; bytes: number; sealed: boolean }
type Manifest = { version: 1; lastSeq: number; segments: SegmentManifest[] }
type FileRead = { text: string; stat: fs.Stats }
type ScannedSegment = SegmentManifest & { number: number; fullBytes: number; manifestBoundaryBytes?: number; path: string }
type ScanResult = { lastActivityAt?: number; expected: Manifest; lastSeq: number; totalRecords: number; problem?: string; trailing?: { name: string; path: string; validBytes: number; bytes: Buffer }; manifestPresent: boolean; manifestNeedsUpdate: boolean }

const MAX_SEGMENT_BYTES = 1024 * 1024
const MAX_EVENT_ID_BYTES = 16 * 1024
const MAX_TOOL_TEXT_BYTES = 4096
const noFollow = fs.constants.O_NOFOLLOW ?? 0
const directoryOnly = fs.constants.O_DIRECTORY ?? 0
const transcriptKinds = new Set<TranscriptKind>(["user", "assistant", "canonical-plan", "tool-start", "tool-result", "tool-denied", "task-state", "task-evidence", "workflow-stage", "workflow-choice", "notice", "carried-context", "context-window", "model-rebind", "shell", "verify", "action", "timing"])
/** Bounds for a persisted operator shell run (see hosts/operator-shell.ts). */
export const MAX_SHELL_LINES = 200
export const MAX_SHELL_OUTPUT_BYTES = 64 * 1024
export const MAX_SHELL_COMMAND_BYTES = 8 * 1024
/** Upper bound on carried user/assistant messages (the conversation window uses at most 24 turns). */
export const MAX_CARRIED_MESSAGES = 48
const toolKinds = new Set<TranscriptKind>(["tool-start", "tool-result", "tool-denied"])
const toolFields = new Set(["name", "role", "executionID", "callID", "taskID", "outcome"])
const activeStores = new Map<string, SessionStoreImpl>()

function code(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined
}

function validateSessionID(sessionID: string): void {
  if (typeof sessionID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionID)) throw new TypeError("invalid session ID")
}

function canonicalWorktree(worktree: string): string {
  if (typeof worktree !== "string" || worktree.length === 0) throw new TypeError("worktree path must be non-empty")
  const canonical = fs.realpathSync.native(resolve(worktree))
  if (!fs.statSync(canonical).isDirectory()) throw new Error("worktree is not a directory")
  return canonical
}

function storeKey(worktree: string, sessionID: string): string {
  return `${worktree}\0${sessionID}`
}

function sessionPath(worktree: string, sessionID: string): string {
  validateSessionID(sessionID)
  return sessionDir(worktree, sessionID)
}

function assertDirectory(path: string, privateOwned = false): void {
  const stat = fs.lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`refusing symlink path: ${path}`)
  if (!stat.isDirectory()) throw new Error(`session path is not a directory: ${path}`)
  if (privateOwned && typeof process.getuid === "function") {
    if (stat.uid !== process.getuid()) throw new Error(`session directory is not owned by the current user: ${path}`)
    if ((stat.mode & 0o077) !== 0) throw new Error(`session directory permissions are not private: ${path}`)
  }
}

function assertExistingDirectoryPath(path: string): boolean {
  const absolute = resolve(path)
  const rootPath = parse(absolute).root
  if (!rootPath) throw new Error("absolute session path required")
  let current = rootPath
  assertDirectory(current)
  for (const part of absolute.slice(rootPath.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      assertDirectory(current)
    } catch (error) {
      if (code(error) === "ENOENT") return false
      throw error
    }
  }
  return true
}

function fsyncDirectory(path: string): void {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | directoryOnly | noFollow)
  try {
    if (!fs.fstatSync(fd).isDirectory()) throw new Error(`not a directory: ${path}`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset)
    if (written <= 0) throw new Error("short write while persisting session state")
    offset += written
  }
}

function assertRegularTarget(path: string): void {
  try {
    const stat = fs.lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink file: ${path}`)
    if (!stat.isFile()) throw new Error(`session file is not regular: ${path}`)
  } catch (error) {
    if (code(error) !== "ENOENT") throw error
  }
}

function durableWriteBytes(path: string, bytes: Buffer): void {
  const parent = dirname(path)
  ensureDurableDirectory(parent)
  assertRegularTarget(path)
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`)
  let exists = false
  try {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600)
    exists = true
    try {
      writeAll(fd, bytes)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    assertRegularTarget(path)
    fs.renameSync(temporary, path)
    exists = false
    fsyncDirectory(parent)
  } finally {
    if (exists) fs.unlinkSync(temporary)
  }
}

function readRegularFile(path: string, maxBytes?: number): FileRead {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error(`session file is not regular: ${path}`)
    if (maxBytes !== undefined && stat.size > maxBytes) throw new Error(`session file exceeds ${maxBytes} bytes: ${path}`)
    return { text: fs.readFileSync(fd, "utf8"), stat }
  } finally {
    fs.closeSync(fd)
  }
}

function readRegularBytes(path: string): { bytes: Buffer; stat: fs.Stats } {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error(`session file is not regular: ${path}`)
    return { bytes: fs.readFileSync(fd), stat }
  } finally {
    fs.closeSync(fd)
  }
}

function readOptionalRegularFile(path: string, maxBytes?: number): FileRead | undefined {
  try {
    return readRegularFile(path, maxBytes)
  } catch (error) {
    if (code(error) === "ENOENT") return undefined
    throw error
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u001f\u007f]/.test(value)
}

const MAX_SESSION_ROUTES = 13

/** Canonical (sorted-key) routes; undefined when empty so absent == empty everywhere. */
export function canonicalRoutes(routes: ComboRoutes | undefined): ComboRoutes | undefined {
  if (!routes) return undefined
  const keys = Object.keys(routes).sort()
  if (keys.length === 0) return undefined
  const out: Record<string, { engine: string; model: string }> = {}
  for (const key of keys) {
    const route = (routes as Record<string, { engine: string; model: string }>)[key]!
    out[key] = { engine: route.engine, model: route.model }
  }
  return out as ComboRoutes
}

export function routesKey(routes: ComboRoutes | undefined): string {
  return JSON.stringify(canonicalRoutes(routes) ?? {})
}

function validatedRoutes(value: unknown): ComboRoutes | string {
  if (plainObject(value) && Object.keys(value).length > MAX_SESSION_ROUTES) return "too many routes"
  return validateComboRoutes(value)
}

function validateEngineModel(value: unknown): SessionOpenMetadata {
  if (!plainObject(value) || !boundedText(value.engine, 128) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.engine)) throw new TypeError("invalid session engine metadata")
  if (value.engine === "opencode") {
    if (value.model !== undefined && !boundedText(value.model, 256)) throw new TypeError("invalid OpenCode model metadata")
  } else if (!boundedText(value.model, 256)) {
    throw new TypeError("a model is required for this session engine")
  }
  if (Object.keys(value).some(key => key !== "engine" && key !== "model" && key !== "routes")) throw new TypeError("unexpected session creation metadata")
  let routes: ComboRoutes | undefined
  if (value.routes !== undefined) {
    const checked = validatedRoutes(value.routes)
    if (typeof checked === "string") throw new TypeError(`invalid session routes metadata: ${checked}`)
    routes = canonicalRoutes(checked)
  }
  return { engine: value.engine, ...(value.model === undefined ? {} : { model: value.model }), ...(routes ? { routes } : {}) }
}

function validateSessionMetadata(value: unknown): SessionMetadata {
  if (!plainObject(value) || value.version !== 1 || !boundedText(value.engine, 128) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.engine) || typeof value.held !== "boolean") {
    throw new Error("session metadata is corrupt")
  }
  if (value.engine === "opencode") {
    if (value.model !== undefined && !boundedText(value.model, 256)) throw new Error("session metadata is corrupt")
  } else if (!boundedText(value.model, 256)) {
    throw new Error("session metadata is corrupt")
  }
  if (value.holdReason !== undefined && !boundedText(value.holdReason, 512)) throw new Error("session metadata is corrupt")
  if (value.createdAt !== undefined && (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt < 0)) throw new Error("session metadata is corrupt")
  if (value.updatedAt !== undefined && (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) || value.updatedAt < 0)) throw new Error("session metadata is corrupt")
  if (value.routes !== undefined) {
    const checked = validatedRoutes(value.routes)
    if (typeof checked === "string") throw new Error("session metadata is corrupt")
  }
  const allowed = new Set(["version", "engine", "model", "routes", "held", "holdReason", "createdAt", "updatedAt"])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("session metadata is corrupt")
  return value as SessionMetadata
}

function metadataPath(dir: string): string { return join(dir, "metadata.json") }
function manifestPath(dir: string): string { return join(dir, "manifest.json") }
function lockPath(dir: string): string { return join(dir, "attach.lock") }
function attachmentsPath(dir: string): string { return join(dir, "attachments") }
function segmentName(number: number): string { return `segments${String(number).padStart(6, "0")}.jsonl` }

function bootIdentity(): string {
  if (process.platform === "linux") {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("cannot establish trusted boot identity")
    return `linux:${value}`
  }
  if (process.platform === "darwin") {
    const output = childProcess.execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C" } })
    const match = /\bsec\s*=\s*(\d+)\b/.exec(output)
    if (!match) throw new Error("cannot establish trusted boot identity")
    return `darwin:${match[1]}`
  }
  throw new Error("cannot establish trusted boot identity on this platform")
}

function processStartIdentity(pid: number): string {
  if (process.platform === "linux") {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const end = stat.lastIndexOf(")")
    if (end < 0) throw new Error("cannot establish process start identity")
    const fields = stat.slice(end + 1).trim().split(/\s+/)
    const startTicks = fields[19]
    if (!startTicks || !/^\d+$/.test(startTicks)) throw new Error("cannot establish process start identity")
    return `linux:${startTicks}`
  }
  if (process.platform === "darwin") {
    const output = childProcess.execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C" } }).trim()
    if (!output || output.includes("\n") || output.includes("\r")) throw new Error("cannot establish process start identity")
    return `darwin:${output}`
  }
  throw new Error("cannot establish process start identity on this platform")
}

function validateLock(value: unknown): SessionLock {
  if (!plainObject(value) || value.version !== 1 || !boundedText(value.token, 128) || !boundedText(value.epoch, 128) || !isAttachmentEpoch(value.epoch) || !boundedText(value.worktree, 4096) || !boundedText(value.sessionID, 128) || !boundedText(value.bootID, 256) || !boundedText(value.processStart, 256) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
    throw new Error("session attach lock is corrupt or ambiguous")
  }
  return value as SessionLock
}

function sameLock(a: SessionLock, b: SessionLock): boolean {
  return a.token === b.token && a.epoch === b.epoch && a.worktree === b.worktree && a.sessionID === b.sessionID && a.bootID === b.bootID && a.processStart === b.processStart && a.pid === b.pid
}

function lockAndStat(path: string): { lock: SessionLock; stat: fs.Stats } {
  const file = readRegularFile(path, 64 * 1024)
  let value: unknown
  try { value = JSON.parse(file.text) }
  catch { throw new Error("session attach lock is corrupt or ambiguous") }
  return { lock: validateLock(value), stat: file.stat }
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function attachmentShape(value: unknown, worktree: string, sessionID: string, epoch: string): Attachment | undefined {
  if (!plainObject(value) || value.version !== 1 || value.epoch !== epoch || value.sessionID !== sessionID || value.worktree !== worktree ||
    !boundedText(value.bootID, 256) || !boundedText(value.processStart, 256) || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 ||
    !timestamp(value.attachedAt)) return undefined
  const common = ["version", "epoch", "worktree", "sessionID", "bootID", "processStart", "pid", "state", "attachedAt"]
  if (value.state === "attached") {
    if (!exactKeys(value, common)) return undefined
    return value as Attachment
  }
  const releasedKeys = [...common, "releasedAt", "releaseEvidence", "workflowID", "revision"]
  if (value.state !== "released" || !exactKeys(value, releasedKeys) || !timestamp(value.releasedAt) ||
    !boundedText(value.releaseEvidence, 1024) ||
    !((value.workflowID === null && value.revision === null) ||
      (boundedText(value.workflowID, 512) && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0))) return undefined
  return value as Attachment
}

function sameAttachmentLock(attachment: Attachment, lock: SessionLock): boolean {
  return attachment.epoch === lock.epoch && attachment.worktree === lock.worktree && attachment.sessionID === lock.sessionID &&
    attachment.bootID === lock.bootID && attachment.processStart === lock.processStart && attachment.pid === lock.pid
}

function processIdentity(lock: SessionLock, currentBootID: string): "live" | "dead" | "ambiguous" {
  if (lock.bootID !== currentBootID) return "dead"
  try {
    process.kill(lock.pid, 0)
  } catch (error) {
    if (code(error) === "ESRCH") return "dead"
    return "ambiguous"
  }
  let observedStart: string
  try {
    observedStart = processStartIdentity(lock.pid)
  } catch {
    return "ambiguous"
  }
  return observedStart === lock.processStart ? "live" : "dead"
}

function processIsProvenDead(lock: SessionLock, currentBootID: string): boolean {
  const identity = processIdentity(lock, currentBootID)
  if (identity === "dead") return true
  if (identity === "live") throw new Error("session is already attached by a live process")
  throw new Error("session attach lock owner identity is ambiguous; admission refused")
}

function openReclaimGuard(path: string): Database {
  try {
    const stat = fs.lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("session reclaim guard is not a regular file")
    if (typeof process.getuid === "function" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) {
      throw new Error("session reclaim guard is not privately owned")
    }
  } catch (error) {
    if (code(error) !== "ENOENT") throw error
    let fd: number | undefined
    try {
      fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600)
      fs.fsyncSync(fd)
      const ownedFD = fd
      fd = undefined
      fs.closeSync(ownedFD)
      fsyncDirectory(dirname(path))
    } catch (createError) {
      if (fd !== undefined) {
        const ownedFD = fd
        fd = undefined
        fs.closeSync(ownedFD)
      }
      if (code(createError) !== "EEXIST") throw createError
    }
  }

  const stat = fs.lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("session reclaim guard is not a regular file")
  if (typeof process.getuid === "function" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) {
    throw new Error("session reclaim guard is not privately owned")
  }
  const database = new Database(path, { create: false, readwrite: true })
  try {
    database.exec("PRAGMA busy_timeout = 10000")
    database.exec("PRAGMA synchronous = FULL")
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

function reclaimStaleLock(path: string, expectedWorktree: string, sessionID: string): void {
  if (pendingSkillPermissionActivityCountForSession(expectedWorktree, sessionID) > 0) {
    throw new Error("pending skill permission activity prevents stale session reclaim")
  }
  const database = openReclaimGuard(`${path}.reclaim.sqlite`)
  let transaction = false
  try {
    database.exec("BEGIN IMMEDIATE")
    transaction = true
    const first = lockAndStat(path)
    if (first.lock.worktree !== expectedWorktree || first.lock.sessionID !== sessionID) throw new Error("session attach lock identity mismatch; admission refused")
    const bootID = bootIdentity()
    if (!processIsProvenDead(first.lock, bootID)) throw new Error("session attach lock owner may still be live; admission refused")
    const second = lockAndStat(path)
    if (!sameLock(first.lock, second.lock) || first.stat.dev !== second.stat.dev || first.stat.ino !== second.stat.ino) {
      throw new Error("session attach lock changed during stale-owner inspection; admission refused")
    }
    if (pendingSkillPermissionActivityCountForSession(expectedWorktree, sessionID) > 0) {
      throw new Error("pending skill permission activity prevents stale session reclaim")
    }
    fs.unlinkSync(path)
    fsyncDirectory(dirname(path))
    database.exec("COMMIT")
    transaction = false
  } catch (error) {
    if (transaction) database.exec("ROLLBACK")
    throw error
  } finally {
    database.close()
  }
}

function createLock(path: string, identity: SessionLock): void {
  const bytes = Buffer.from(`${JSON.stringify(identity)}\n`, "utf8")
  let fd: number | undefined
  let created: fs.Stats | undefined
  let complete = false
  try {
    fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600)
    created = fs.fstatSync(fd)
    writeAll(fd, bytes)
    fs.fsyncSync(fd)
    const ownedFD = fd
    fd = undefined
    fs.closeSync(ownedFD)
    fsyncDirectory(dirname(path))
    complete = true
  } finally {
    if (fd !== undefined) {
      const ownedFD = fd
      fd = undefined
      fs.closeSync(ownedFD)
    }
    if (created && !complete) {
      const current = fs.lstatSync(path)
      if (current.dev !== created.dev || current.ino !== created.ino || !current.isFile()) throw new Error("session attach lock changed during failed acquisition")
      fs.unlinkSync(path)
      fsyncDirectory(dirname(path))
    }
  }
}

function readManifest(dir: string): { manifest?: Manifest; present: boolean } {
  const file = readOptionalRegularFile(manifestPath(dir))
  if (!file) return { present: false }
  let value: unknown
  try { value = JSON.parse(file.text) }
  catch { throw new Error("session transcript manifest is corrupt") }
  if (!plainObject(value) || value.version !== 1 || !Number.isSafeInteger(value.lastSeq) || (value.lastSeq as number) < 0 || !Array.isArray(value.segments)) throw new Error("session transcript manifest is corrupt")
  const segments: SegmentManifest[] = []
  let lastSeq = 0
  for (let index = 0; index < value.segments.length; index++) {
    const item = value.segments[index]
    if (!plainObject(item) || item.name !== segmentName(index + 1) || !Number.isSafeInteger(item.firstSeq) || !Number.isSafeInteger(item.lastSeq) || !Number.isSafeInteger(item.bytes) || typeof item.sealed !== "boolean" || (item.firstSeq as number) !== lastSeq + 1 || (item.lastSeq as number) < (item.firstSeq as number) || (item.bytes as number) < 1 || (item.bytes as number) > MAX_SEGMENT_BYTES || (index < value.segments.length - 1 && item.sealed !== true)) throw new Error("session transcript manifest is corrupt")
    lastSeq = item.lastSeq as number
    segments.push({ name: item.name as string, firstSeq: item.firstSeq as number, lastSeq, bytes: item.bytes as number, sealed: item.sealed })
  }
  if (value.lastSeq !== lastSeq || Object.keys(value).some(key => key !== "version" && key !== "lastSeq" && key !== "segments")) throw new Error("session transcript manifest is corrupt")
  return { manifest: { version: 1, lastSeq, segments }, present: true }
}

function validEventID(value: unknown): value is string {
  return boundedText(value, MAX_EVENT_ID_BYTES)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function boundedString(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && Buffer.byteLength(value, "utf8") <= maxBytes
}

function validateToolData(data: Record<string, unknown>): void {
  if (!exactKeys(data, ["name", "role", "executionID", "callID", "taskID", "outcome"]) || Object.keys(data).some(key => !toolFields.has(key))) throw new TypeError("tool transcript must use the canonical summary shape")
  for (const key of ["name", "role", "executionID", "callID", "taskID"]) if (!boundedText(data[key], MAX_TOOL_TEXT_BYTES)) throw new TypeError(`invalid tool transcript ${key}`)
  if (typeof data.outcome !== "string" || !["running", "succeeded", "failed", "denied"].includes(data.outcome)) throw new TypeError("invalid tool transcript outcome")
}

function validateEvidenceValue(value: unknown, depth = 0): void {
  if (depth > 16) throw new TypeError("task evidence nesting is too deep")
  if (value === null || typeof value === "boolean") return
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 16 * 1024) throw new TypeError("task evidence string is too large")
    return
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("task evidence contains a non-finite number")
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) validateEvidenceValue(item, depth + 1)
    return
  }
  if (!plainObject(value)) throw new TypeError("task evidence must contain only plain JSON values")
  const forbidden = new Set(["at", "time", "timestamp", "date", "input", "output", "stdout", "stderr", "args", "arguments", "body", "__proto__", "prototype", "constructor"])
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[-_]/g, "").toLowerCase()
    const authorityOrBody = ["token", "secret", "grant", "authorization", "credential", "executable", "toolinput", "tooloutput"]
      .some(fragment => normalized.includes(fragment))
    const timestampField = ["requestedat", "acknowledgedat", "terminalat", "quiescentat", "createdat", "updatedat", "startedat", "finishedat"]
      .includes(normalized) || /(?:timestamp|datetime|time|date)$/.test(normalized)
    if (forbidden.has(normalized) || authorityOrBody || timestampField) throw new TypeError(`task evidence field is not permitted: ${key}`)
    validateEvidenceValue(child, depth + 1)
  }
}

function validateWorkflowAnnotation(value: Record<string, unknown>): void {
  validateEvidenceValue(value)
}

function validateKindData(kind: TranscriptKind, data: Record<string, unknown>): void {
  if (kind === "timing") {
    if (!validPlanningTiming(data)) throw new TypeError("timing transcript data must contain only validated enums and counters")
    return
  }
  if (toolKinds.has(kind)) {
    validateToolData(data)
    return
  }
  if (kind === "user" || kind === "assistant" || kind === "canonical-plan") {
    if (!exactKeys(data, ["text"]) || !boundedString(data.text, MAX_SEGMENT_BYTES, true)) throw new TypeError(`${kind} transcript data must be {text:string}`)
    return
  }
  if (kind === "notice") {
    if (exactKeys(data, ["text"]) && boundedString(data.text, MAX_SEGMENT_BYTES, true)) return
    if (exactKeys(data, ["text", "provenance"]) && data.provenance === "error" && boundedString(data.text, MAX_SEGMENT_BYTES, true)) return
    if (exactKeys(data, ["draft", "queued"]) && boundedString(data.draft, MAX_SEGMENT_BYTES, true) && Array.isArray(data.queued) && data.queued.every(item => boundedString(item, MAX_SEGMENT_BYTES, true))) return
    throw new TypeError("notice transcript data must contain text or an unsent draft and queue")
  }
  if (kind === "shell") {
    // Operator `!command` run: shown and recorded, never part of the model conversation.
    const lines = data.lines
    const bytes = Array.isArray(lines) ? lines.reduce((total: number, line) => total + (typeof line === "string" ? Buffer.byteLength(line, "utf8") + 1 : Infinity), 0) : Infinity
    if (!exactKeys(data, ["command", "status", "exitCode", "signal", "durationMs", "lines", "totalLines"]) ||
        !boundedString(data.command, MAX_SHELL_COMMAND_BYTES) || !["complete", "error", "cancelled", "timeout"].includes(data.status as string) ||
        !(data.exitCode === null || Number.isSafeInteger(data.exitCode)) || !(data.signal === null || boundedText(data.signal, 64)) ||
        !Number.isSafeInteger(data.durationMs) || (data.durationMs as number) < 0 || !Array.isArray(lines) ||
        lines.length > MAX_SHELL_LINES || bytes > MAX_SHELL_OUTPUT_BYTES || !Number.isSafeInteger(data.totalLines) ||
        (data.totalLines as number) < lines.length) {
      throw new TypeError("shell transcript data must be {command,status,exitCode,signal,durationMs,lines,totalLines}")
    }
    return
  }
  if (kind === "action") {
    // A chat action's decision (write/edit/multiedit/bash/model_api): which tool, how it was decided, the worktree-relative paths it
    // writes and a command's rule prefix. Never file contents, edit text or a full command line (the session-digest
    // allow-list in knowledge/AGENTS.md).
    const paths = data.paths
    if (!(exactKeys(data, ["tool", "decision", "paths"]) || exactKeys(data, ["tool", "decision", "paths", "rule"])) || !["write", "edit", "multiedit", "bash", "model_api"].includes(data.tool as string) ||
        !["asked", "rule", "read-only", "auto-edit", "grant", "denied", "refused"].includes(data.decision as string) ||
        !Array.isArray(paths) || paths.length > 64 || !paths.every(path => boundedString(path, 1024)) ||
        (data.rule !== undefined && !boundedString(data.rule, 256))) {
      throw new TypeError("action transcript data must be {tool,decision,paths[,rule]}")
    }
    return
  }
  if (kind === "verify") {
    // A task's verify command as the queue ran it: command, bounded output tail, exit and timing (display only;
    // the ledger stays the authority for task outcome).
    const lines = data.lines
    const bytes = Array.isArray(lines) ? lines.reduce((total: number, line) => total + (typeof line === "string" ? Buffer.byteLength(line, "utf8") + 1 : Infinity), 0) : Infinity
    if (!exactKeys(data, ["taskID", "attempt", "command", "status", "exitCode", "durationMs", "timeoutMs", "lines", "totalLines"]) ||
        !boundedText(data.taskID, 256) || !Number.isSafeInteger(data.attempt) || (data.attempt as number) < 0 ||
        !boundedString(data.command, MAX_SHELL_COMMAND_BYTES) || !["complete", "error", "cancelled", "timeout"].includes(data.status as string) ||
        !(data.exitCode === null || Number.isSafeInteger(data.exitCode)) ||
        !Number.isSafeInteger(data.durationMs) || (data.durationMs as number) < 0 || !Number.isSafeInteger(data.timeoutMs) || (data.timeoutMs as number) < 0 ||
        !Array.isArray(lines) || lines.length > MAX_SHELL_LINES || bytes > MAX_SHELL_OUTPUT_BYTES ||
        !Number.isSafeInteger(data.totalLines) || (data.totalLines as number) < lines.length) {
      throw new TypeError("verify transcript data must be {taskID,attempt,command,status,exitCode,durationMs,timeoutMs,lines,totalLines}")
    }
    return
  }
  if (kind === "carried-context") {
    // Conversation copied from the previous engine/model session on an explicit model switch; it keeps the
    // source identity so provenance is never attributed to the new model, and it grants no approval.
    const messages = data.messages
    if (!exactKeys(data, ["sourceSessionID", "engine", "model", "messages"]) || !boundedText(data.sourceSessionID, 256) ||
        !boundedText(data.engine, 64) || !boundedText(data.model, 256) || !Array.isArray(messages) ||
        messages.length === 0 || messages.length % 2 !== 0 || messages.length > MAX_CARRIED_MESSAGES ||
        !messages.every((message, index) => plainObject(message) && exactKeys(message, ["role", "text"]) &&
          message.role === (index % 2 === 0 ? "user" : "assistant") && boundedString(message.text, MAX_SEGMENT_BYTES, false) &&
          (message.text as string).trim().length > 0)) {
      throw new TypeError("carried-context transcript data must be {sourceSessionID,engine,model,messages:[user,assistant,...]}")
    }
    return
  }
  if (kind === "context-window") {
    // Historical inference context only; restoring this checkpoint grants no approval.
    const messages = data.messages
    if (!exactKeys(data, ["version", "messages", "pinnedNote"]) || data.version !== 1 ||
        typeof data.pinnedNote !== "string" || data.pinnedNote.length > 2000 || !Array.isArray(messages) ||
        messages.length % 2 !== 0 || messages.length > MAX_CARRIED_MESSAGES ||
        !messages.every((message, index) => plainObject(message) && exactKeys(message, ["role", "text"]) &&
          message.role === (index % 2 === 0 ? "user" : "assistant") && boundedString(message.text, MAX_SEGMENT_BYTES, false) &&
          (message.text as string).trim().length > 0) || JSON.stringify(messages).length > 196608) {
      throw new TypeError("context-window transcript data must be {version:1,messages:[user,assistant,...],pinnedNote:string}")
    }
    return
  }
  if (kind === "model-rebind") {
    // In-place model change of this session (same session ID and history); it grants no approval.
    const side = (value: unknown): boolean => {
      if (!plainObject(value) || !boundedText(value.engine, 64) || !boundedText(value.model, 256)) return false
      if (!Object.keys(value).every(key => key === "engine" || key === "model" || key === "routes")) return false
      return value.routes === undefined || typeof validatedRoutes(value.routes) !== "string"
    }
    if (!(exactKeys(data, ["from", "to"]) || (exactKeys(data, ["from", "to", "workflowID"]) && boundedText(data.workflowID, 512))) ||
        !side(data.from) || !side(data.to)) {
      throw new TypeError("model-rebind transcript data must be {from:{engine,model,routes?},to:{engine,model,routes?},workflowID?}")
    }
    return
  }
  if (kind === "task-state") {
    if (!exactKeys(data, ["taskID", "status"]) || !boundedText(data.taskID, 256) || !boundedText(data.status, 256)) throw new TypeError("task-state transcript data must be {taskID,status}")
    return
  }
  if (kind === "task-evidence") {
    if (!exactKeys(data, ["executionID", "taskID", "terminal", "cancel", "reconciliation", "quiescent", "claim", "fence"]) || !boundedText(data.executionID, 256) || !boundedText(data.taskID, 256)) throw new TypeError("task-evidence transcript data has an invalid shape")
    for (const key of ["terminal", "cancel", "reconciliation", "quiescent", "claim", "fence"]) validateEvidenceValue(data[key])
    return
  }
  if (kind === "workflow-stage" || kind === "workflow-choice") validateWorkflowAnnotation(data)
}

function normalizeData(kind: TranscriptKind, data: Record<string, unknown>): Record<string, unknown> {
  if (!transcriptKinds.has(kind)) throw new TypeError("invalid transcript kind")
  if (!plainObject(data)) throw new TypeError("transcript data must be a plain object")
  validateKindData(kind, data)
  const json = JSON.stringify(data)
  if (json === undefined) throw new TypeError("transcript data is not JSON serializable")
  const normalized: unknown = JSON.parse(json)
  if (!plainObject(normalized)) throw new TypeError("transcript data must be a JSON object")
  validateKindData(kind, normalized)
  return normalized
}

function validateTranscriptRecord(value: unknown, expectedSeq: number): TranscriptRecord {
  if (!plainObject(value) || !Number.isSafeInteger(value.seq) || value.seq !== expectedSeq || !transcriptKinds.has(value.kind as TranscriptKind) || !validEventID(value.eventID) || !plainObject(value.data)) throw new Error("transcript record is corrupt")
  if (Object.keys(value).some(key => key !== "seq" && key !== "kind" && key !== "eventID" && key !== "data")) throw new Error("transcript record is corrupt")
  const normalized = normalizeData(value.kind as TranscriptKind, value.data)
  return { seq: value.seq as number, kind: value.kind as TranscriptKind, eventID: value.eventID, data: normalized }
}

function readSegmentFiles(dir: string): Array<{ number: number; name: string; path: string }> {
  const files: Array<{ number: number; name: string; path: string }> = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.startsWith("segments") || !entry.name.endsWith(".jsonl")) continue
    const match = /^segments(\d{6,})\.jsonl$/.exec(entry.name)
    if (!match) throw new Error(`unrecognized transcript segment name: ${entry.name}`)
    const number = Number(match[1])
    if (!Number.isSafeInteger(number) || number < 1 || entry.isSymbolicLink() || !entry.isFile()) throw new Error(`transcript segment is not a regular file: ${entry.name}`)
    files.push({ number, name: entry.name, path: join(dir, entry.name) })
  }
  files.sort((a, b) => a.number - b.number)
  for (let index = 0; index < files.length; index++) {
    if (files[index]!.number !== index + 1 || files[index]!.name !== segmentName(index + 1)) throw new Error("transcript segment sequence has a gap")
  }
  return files
}

function scanTranscript(dir: string, onRecord?: (record: TranscriptRecord) => void): ScanResult {
  let parsedManifest: { manifest?: Manifest; present: boolean }
  let files: Array<{ number: number; name: string; path: string }>
  try {
    parsedManifest = readManifest(dir)
    files = readSegmentFiles(dir)
  } catch (error) {
    return { expected: { version: 1, lastSeq: 0, segments: [] }, lastSeq: 0, totalRecords: 0, problem: error instanceof Error ? error.message : String(error), manifestPresent: false, manifestNeedsUpdate: false }
  }

  const manifest = parsedManifest.manifest
  const scanned: ScannedSegment[] = []
  let expectedSeq = 1
  let totalRecords = 0
  let lastActivityAt: number | undefined
  let trailing: ScanResult["trailing"]
  let problem: string | undefined

  for (let index = 0; index < files.length; index++) {
    const file = files[index]!
    let bytes: Buffer
    try {
      const read = readRegularBytes(file.path)
      bytes = read.bytes
      lastActivityAt = Math.max(lastActivityAt ?? 0, read.stat.mtimeMs)
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
      break
    }
    if (bytes.length > MAX_SEGMENT_BYTES) { problem = `transcript segment exceeds ${MAX_SEGMENT_BYTES} bytes`; break }
    const prior = manifest?.segments[index]
    const mayHaveTail = index === files.length - 1 && (!prior || prior.sealed === false)
    let cursor = 0
    let firstSeq = 0
    let lastSeq = 0
    let manifestBoundaryBytes: number | undefined
    while (cursor < bytes.length) {
      const newline = bytes.indexOf(0x0a, cursor)
      if (newline < 0) {
        if (!mayHaveTail) { problem = "incomplete row in a sealed or interior transcript segment"; break }
        trailing = { name: file.name, path: file.path, validBytes: cursor, bytes: bytes.subarray(cursor) }
        break
      }
      if (newline === cursor) { problem = "empty transcript row"; break }
      let value: unknown
      try { value = JSON.parse(bytes.subarray(cursor, newline).toString("utf8")) }
      catch { problem = "corrupt transcript row"; break }
      let record: TranscriptRecord
      try { record = validateTranscriptRecord(value, expectedSeq) }
      catch (error) { problem = error instanceof Error ? error.message : String(error); break }
      if (firstSeq === 0) firstSeq = record.seq
      lastSeq = record.seq
      cursor = newline + 1
      if (prior?.lastSeq === lastSeq) manifestBoundaryBytes = cursor
      expectedSeq++
      totalRecords++
      onRecord?.(record)
    }
    if (problem) break
    if (firstSeq === 0 && !trailing) { problem = `empty transcript segment: ${file.name}`; break }
    if (firstSeq !== 0) {
      const sealed = index < files.length - 1 ? true : (prior?.sealed ?? false)
      scanned.push({ number: file.number, name: file.name, firstSeq, lastSeq, bytes: cursor, sealed, fullBytes: bytes.length, ...(manifestBoundaryBytes === undefined ? {} : { manifestBoundaryBytes }), path: file.path })
    }
  }

  const expectedSegments: SegmentManifest[] = scanned.map((segment, index) => ({ name: segment.name, firstSeq: segment.firstSeq, lastSeq: segment.lastSeq, bytes: segment.bytes, sealed: index < scanned.length - 1 ? true : segment.sealed }))
  if (!problem && manifest) {
    if (manifest.segments.length > files.length) problem = "manifest references a missing transcript segment"
    for (let index = 0; !problem && index < manifest.segments.length; index++) {
      const expected = manifest.segments[index]!
      const actual = scanned[index]
      if (!actual || actual.name !== expected.name || actual.firstSeq !== expected.firstSeq) { problem = "transcript manifest segment range does not match disk"; break }
      if (actual.manifestBoundaryBytes !== expected.bytes) { problem = "transcript manifest segment range does not match disk"; break }
      const extra = actual.lastSeq > expected.lastSeq || actual.fullBytes > expected.bytes
      if (extra && expected.sealed) { problem = "sealed transcript segment has unmanifested data"; break }
      if (index < manifest.segments.length - 1 && actual.lastSeq !== expected.lastSeq) { problem = "interior transcript segment has unmanifested data"; break }
    }
  }

  const lastSeq = expectedSeq - 1
  const expectedManifest: Manifest = { version: 1, lastSeq, segments: expectedSegments }
  if (manifest && manifest.segments.length === 0 && manifest.lastSeq !== 0) problem ??= "transcript manifest sequence is corrupt"
  const manifestNeedsUpdate = !parsedManifest.present || !manifest || !isDeepStrictEqual(manifest, expectedManifest)
  return { expected: expectedManifest, lastSeq, totalRecords, ...(lastActivityAt === undefined ? {} : { lastActivityAt }), ...(problem ? { problem } : {}), ...(trailing && !problem ? { trailing } : {}), manifestPresent: parsedManifest.present, manifestNeedsUpdate }
}

function recoverTranscript(dir: string): ScanResult {
  for (let attempt = 0; attempt < 3; attempt++) {
    const scan = scanTranscript(dir)
    if (scan.problem) throw new Error(`session transcript is corrupt: ${scan.problem}`)
    if (scan.trailing) {
      const original = fs.readFileSync(scan.trailing.path)
      const recoveryFile = join(dir, `recovery-${randomUUID()}.json`)
      durableWriteJson(recoveryFile, { version: 1, segment: scan.trailing.name, raw: original.toString("base64"), validBytes: scan.trailing.validBytes, reason: "incomplete trailing transcript row" })
      if (scan.trailing.validBytes === 0) {
        fs.unlinkSync(scan.trailing.path)
        fsyncDirectory(dir)
      } else {
        durableWriteBytes(scan.trailing.path, original.subarray(0, scan.trailing.validBytes))
      }
      continue
    }
    if (scan.manifestNeedsUpdate) {
      durableWriteJson(manifestPath(dir), scan.expected)
      continue
    }
    return scan
  }
  throw new Error("session transcript recovery did not converge")
}

function readSessionMetadataAt(dir: string): SessionMetadata | null {
  const path = metadataPath(dir)
  try {
    const file = readOptionalRegularFile(path, 1024 * 1024)
    if (!file) return null
    let value: unknown
    try { value = JSON.parse(file.text) }
    catch { throw new Error("session metadata is corrupt") }
    return validateSessionMetadata(value)
  } catch (error) {
    if (code(error) === "ENOENT") return null
    throw error
  }
}

function hasSessionArtifacts(dir: string): boolean {
  for (const name of ["attachments", "attach.lock", "segments000001.jsonl"]) {
    try {
      fs.lstatSync(join(dir, name))
      return true
    } catch (error) {
      if (code(error) !== "ENOENT") throw error
    }
  }
  const manifest = readOptionalRegularFile(manifestPath(dir))
  if (!manifest) return false
  try {
    const value = JSON.parse(manifest.text) as unknown
    return !plainObject(value) || !Array.isArray(value.segments) || value.segments.length > 0
  } catch {
    return true
  }
}

function safeLockFile(path: string): boolean {
  try { fs.lstatSync(path); return true }
  catch (error) { if (code(error) === "ENOENT") return false; throw error }
}

class SessionStoreImpl implements SessionStore {
  readonly sessionID: string
  readonly epoch: string
  readonly restored: boolean
  private currentMetadata: SessionMetadata
  private readonly directory: string
  private readonly worktree: string
  private readonly lock: SessionLock
  private released = false
  private initialClearAvailable: boolean

  constructor(worktree: string, sessionID: string, directory: string, lock: SessionLock, metadata: SessionMetadata, restored: boolean) {
    this.worktree = worktree
    this.sessionID = sessionID
    this.directory = directory
    this.lock = lock
    this.epoch = lock.epoch
    this.currentMetadata = metadata
    this.restored = restored
    this.initialClearAvailable = !restored
  }

  get metadata(): SessionMetadata { return { ...this.currentMetadata } }
  get isReleased(): boolean { return this.released }

  assertOwner(): void {
    if (this.released) throw new Error("session store attachment has been released")
    let current: { lock: SessionLock; stat: fs.Stats }
    try { current = lockAndStat(lockPath(this.directory)) }
    catch { throw new Error("session store attachment ownership was lost") }
    if (!sameLock(current.lock, this.lock) || current.lock.pid !== process.pid || current.lock.worktree !== this.worktree || current.lock.sessionID !== this.sessionID) {
      throw new Error("session store attachment ownership was lost")
    }
  }

  append(kind: TranscriptKind, data: Record<string, unknown>, eventID = randomUUID()): TranscriptRecord {
    this.assertOwner()
    if (!validEventID(eventID)) throw new TypeError("invalid transcript event ID")
    const normalized = normalizeData(kind, data)
    const scan = recoverTranscript(this.directory)
    if (scan.problem || scan.trailing || scan.manifestNeedsUpdate) throw new Error("session transcript could not be recovered safely")
    let duplicate: TranscriptRecord | undefined
    const verified = scanTranscript(this.directory, record => {
      if (record.eventID === eventID) duplicate = record
    })
    if (verified.problem || verified.trailing || verified.manifestNeedsUpdate) throw new Error("session transcript is corrupt or unrecovered")
    if (duplicate) {
      if (duplicate.kind !== kind || !isDeepStrictEqual(duplicate.data, normalized)) throw new Error("transcript event ID conflicts with an existing record")
      return duplicate
    }

    const record: TranscriptRecord = { seq: scan.lastSeq + 1, kind, eventID, data: normalized }
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8")
    if (bytes.length > MAX_SEGMENT_BYTES) throw new RangeError("transcript record exceeds 1 MiB")
    const current = scan.expected.segments.at(-1)
    const newSegment = !current || current.sealed || current.bytes + bytes.length > MAX_SEGMENT_BYTES
    let segments = scan.expected.segments.map(segment => ({ ...segment }))
    if (newSegment && current && !current.sealed) {
      segments[segments.length - 1] = { ...current, sealed: true }
      durableWriteJson(manifestPath(this.directory), { version: 1, lastSeq: scan.lastSeq, segments })
    }
    const number = newSegment ? segments.length + 1 : segments.length
    const name = segmentName(number)
    const path = join(this.directory, name)
    const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow | (newSegment ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0), 0o600)
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error("transcript segment is not a regular file")
      writeAll(fd, bytes)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (newSegment) fsyncDirectory(this.directory)

    const entry: SegmentManifest = newSegment
      ? { name, firstSeq: record.seq, lastSeq: record.seq, bytes: bytes.length, sealed: false }
      : { ...current!, lastSeq: record.seq, bytes: current!.bytes + bytes.length }
    if (newSegment) segments.push(entry)
    else segments[segments.length - 1] = entry
    const nextManifest: Manifest = { version: 1, lastSeq: record.seq, segments }
    durableWriteJson(manifestPath(this.directory), nextManifest)
    this.assertOwner()
    return record
  }

  hold(reason: string): void {
    this.assertOwner()
    if (!boundedText(reason, 512)) throw new TypeError("invalid session hold reason")
    this.currentMetadata = { ...this.currentMetadata, held: true, holdReason: reason, updatedAt: Date.now() }
    durableWriteJson(metadataPath(this.directory), this.currentMetadata)
    this.assertOwner()
  }

  rebindModel(next: SessionOpenMetadata): { from: SessionOpenMetadata; to: SessionOpenMetadata } {
    this.assertOwner()
    const requested = validateEngineModel(next)
    const current = this.currentMetadata
    if (requested.engine !== current.engine) throw new Error("session engine is immutable; model rebind refused")
    if (requested.model === undefined) throw new TypeError("a model is required to rebind a session")
    const from: SessionOpenMetadata = { engine: current.engine, ...(current.model === undefined ? {} : { model: current.model }), ...(current.routes ? { routes: current.routes } : {}) }
    const { routes: _routes, model: _model, ...rest } = current
    this.currentMetadata = { ...rest, model: requested.model, ...(requested.routes ? { routes: requested.routes } : {}), updatedAt: Date.now() }
    durableWriteJson(metadataPath(this.directory), this.currentMetadata)
    this.assertOwner()
    return { from, to: requested }
  }

  clearHold(proof: SessionClearHoldProof): void {
    this.assertOwner()
    if (!plainObject(proof) || proof.authorized !== true || !boundedText(proof.reason, 512)) throw new TypeError("explicit admission authorization is required to clear session hold")
    const initializing = this.initialClearAvailable && proof.reason === "new-session"
    if (!initializing && !consumeValidatedResumeProof(this, proof)) throw new Error("validated explicit Resume proof is required to clear session hold")
    this.initialClearAvailable = false
    const { holdReason: _holdReason, ...metadata } = this.currentMetadata
    this.currentMetadata = { ...metadata, held: false, updatedAt: Date.now() }
    durableWriteJson(metadataPath(this.directory), this.currentMetadata)
    this.assertOwner()
  }

  release(proof: SessionReleaseProof): void {
    this.assertOwner()
    if (pendingSkillPermissionActivityCount(this.worktree, this.sessionID, this.epoch) > 0) {
      throw new Error("pending skill permission activity prevents session release")
    }
    if (!plainObject(proof) || !exactKeys(proof, ["workflowQuiescent", "evidence", "workflowID", "revision"]) ||
      proof.workflowQuiescent !== true || !boundedText(proof.evidence, 1024) ||
      !((proof.workflowID === null && proof.revision === null) ||
        (boundedText(proof.workflowID, 512) && Number.isSafeInteger(proof.revision) && (proof.revision as number) >= 0))) {
      throw new TypeError("caller-proven workflow quiescence and workflow binding are required to release a session attachment")
    }
    const lockBefore = lockAndStat(lockPath(this.directory))
    if (!sameLock(lockBefore.lock, this.lock)) throw new Error("session attachment lock changed before release")
    const path = join(attachmentsPath(this.directory), `${this.epoch}.json`)
    const current = readRegularFile(path, 64 * 1024)
    let rawAttachment: unknown
    try { rawAttachment = JSON.parse(current.text) }
    catch { throw new Error("session attachment lifecycle file is corrupt") }
    const attachment = attachmentShape(rawAttachment, this.worktree, this.sessionID, this.epoch)
    if (!attachment || attachment.state !== "attached" || !sameAttachmentLock(attachment, this.lock)) throw new Error("session attachment lifecycle identity changed")
    if (pendingSkillPermissionActivityCount(this.worktree, this.sessionID, this.epoch) > 0) {
      throw new Error("pending skill permission activity prevents session release")
    }
    durableWriteJson(path, {
      ...attachment,
      state: "released",
      releasedAt: Date.now(),
      releaseEvidence: proof.evidence,
      workflowID: proof.workflowID,
      revision: proof.revision,
    })
    this.assertOwner()
    const now = lockAndStat(lockPath(this.directory))
    if (!sameLock(now.lock, this.lock) || now.stat.dev !== lockBefore.stat.dev || now.stat.ino !== lockBefore.stat.ino) throw new Error("session attachment lock changed before release")
    fs.unlinkSync(lockPath(this.directory))
    this.released = true
    activeStores.delete(storeKey(this.worktree, this.sessionID))
    fsyncDirectory(this.directory)
  }
}

export function openSession(worktree: string, sid: string, metadata?: SessionOpenMetadata): SessionStore {
  validateSessionID(sid)
  const canonical = canonicalWorktree(worktree)
  const key = storeKey(canonical, sid)
  if (pendingSkillPermissionActivityCountForSession(canonical, sid) > 0) {
    throw new Error("pending skill permission activity prevents session attachment")
  }
  if (activeStores.has(key)) {
    activeStores.get(key)!.assertOwner()
    throw new Error("session is already attached in this process")
  }
  const directory = sessionPath(canonical, sid)
  ensureDurableDirectory(directory)
  const sessionsRoot = dirname(directory)
  assertDirectory(sessionsRoot, true)
  assertDirectory(directory, true)
  // Determine whether this directory predates this acquisition. In particular,
  // an attach.lock created below must never make a fresh session look restored.
  const hadArtifacts = hasSessionArtifacts(directory)
  const lockFile = lockPath(directory)
  const token = randomUUID()
  const epoch = randomUUID()
  const lock: SessionLock = {
    version: 1,
    token,
    epoch,
    worktree: canonical,
    sessionID: sid,
    bootID: bootIdentity(),
    processStart: processStartIdentity(process.pid),
    pid: process.pid,
  }

  try {
    createLock(lockFile, lock)
  } catch (error) {
    if (code(error) !== "EEXIST") throw error
    reclaimStaleLock(lockFile, canonical, sid)
    try { createLock(lockFile, lock) }
    catch (retryError) {
      if (code(retryError) === "EEXIST") throw new Error("session is already attached by another process")
      throw retryError
    }
  }

  let lockOwned = true
  try {
    const oldMetadata = readSessionMetadataAt(directory)
    const restored = oldMetadata !== null || hadArtifacts
    if (!oldMetadata && restored) throw new Error("existing session has no valid metadata; admission refused")
    const requested = metadata === undefined ? undefined : validateEngineModel(metadata)
    if (!oldMetadata && !requested) throw new TypeError("session engine/model metadata is required when creating a session")
    if (oldMetadata && requested && (oldMetadata.engine !== requested.engine || oldMetadata.model !== requested.model || routesKey(oldMetadata.routes) !== routesKey(requested.routes))) throw new Error("session engine/model metadata is immutable")
    const chosenRoutes = canonicalRoutes((oldMetadata ?? requested)!.routes)
    const chosen = oldMetadata ? { engine: oldMetadata.engine, ...(oldMetadata.model === undefined ? {} : { model: oldMetadata.model }) } : requested!
    const recovery = recoverTranscript(directory)
    if (recovery.problem) throw new Error(`session transcript is corrupt: ${recovery.problem}`)
    if (recovery.trailing) throw new Error("session transcript recovery left an incomplete trailing row")
    if (recovery.manifestNeedsUpdate) throw new Error("session transcript recovery left an unpublished manifest")
    ensureDurableDirectory(attachmentsPath(directory))
    const now = Date.now()
    const currentMetadata: SessionMetadata = {
      version: 1,
      engine: chosen.engine,
      ...(chosen.model === undefined ? {} : { model: chosen.model }),
      ...(chosenRoutes ? { routes: chosenRoutes } : {}),
      held: true,
      ...(oldMetadata?.createdAt === undefined ? { createdAt: now } : { createdAt: oldMetadata.createdAt }),
      updatedAt: now,
    }
    durableWriteJson(metadataPath(directory), currentMetadata)
    const { token: _token, ...attachmentIdentity } = lock
    const attachment: Attachment = { ...attachmentIdentity, state: "attached", attachedAt: now }
    const attachmentPath = join(attachmentsPath(directory), `${epoch}.json`)
    durableWriteJson(attachmentPath, attachment)
    const store = new SessionStoreImpl(canonical, sid, directory, lock, currentMetadata, restored)
    activeStores.set(key, store)
    lockOwned = false
    store.assertOwner()
    return store
  } finally {
    if (lockOwned) {
      const current = lockAndStat(lockFile)
      if (!sameLock(current.lock, lock)) throw new Error("session attach lock ownership changed during open")
      fs.unlinkSync(lockFile)
      fsyncDirectory(directory)
    }
  }
}

export function getOwnedSession(worktree: string, sid: string): SessionStore | undefined {
  validateSessionID(sid)
  const canonical = canonicalWorktree(worktree)
  const store = activeStores.get(storeKey(canonical, sid))
  if (!store) return undefined
  store.assertOwner()
  return store
}

/** Read-only supervisor identity for policy enforcement in a separate SDK process. */
export function inspectCurrentSessionAttachment(worktree: string, sid: string): ReturnType<typeof inspectSessionAttachment> {
  try {
    validateSessionID(sid)
    const canonical = canonicalWorktree(worktree)
    const current = lockAndStat(lockPath(sessionPath(canonical, sid))).lock
    if (current.worktree !== canonical || current.sessionID !== sid) return null
    const inspection = inspectSessionAttachment(canonical, sid, current.epoch)
    if (inspection?.state !== "attached" || inspection.pid !== current.pid || inspection.bootID !== current.bootID || inspection.processStart !== current.processStart) return null
    return inspection
  } catch {
    return null
  }
}

/** True when this session's model was ever changed in place; its settled executions then legitimately carry older policy IDs. */
export function sessionWasRebound(worktree: string, sid: string): boolean {
  try { return replaySession(worktree, sid, { kind: "model-rebind", limit: 1 }).records.length > 0 }
  catch { return false }
}

export function readSessionMetadata(worktree: string, sid: string): SessionMetadata | null {
  validateSessionID(sid)
  const canonical = canonicalWorktree(worktree)
  const directory = sessionPath(canonical, sid)
  if (!assertExistingDirectoryPath(directory)) return null
  assertDirectory(directory, true)
  return readSessionMetadataAt(directory)
}

/** Inspect one durable epoch receipt without mutating it or reclaiming its lock. */
export function inspectSessionAttachment(worktree: string, sid: string, epoch: string): SessionAttachmentInspection | null {
  validateSessionID(sid)
  if (typeof epoch !== "string" || !isAttachmentEpoch(epoch)) throw new TypeError("invalid session attachment epoch")
  const canonical = canonicalWorktree(worktree)
  const directory = sessionPath(canonical, sid)
  if (!assertExistingDirectoryPath(directory)) return null
  assertDirectory(directory, true)
  const attachmentDirectory = attachmentsPath(directory)
  if (!assertExistingDirectoryPath(attachmentDirectory)) return null
  assertDirectory(attachmentDirectory, true)
  const file = readOptionalRegularFile(join(attachmentDirectory, `${epoch}.json`), 64 * 1024)
  if (!file) return null
  let value: unknown
  try { value = JSON.parse(file.text) }
  catch { return null }
  const attachment = attachmentShape(value, canonical, sid, epoch)
  if (!attachment) return null
  if (attachment.state === "released") {
    return {
      state: "released",
      epoch,
      sessionID: sid,
      worktree: canonical,
      workflowID: attachment.workflowID!,
      revision: attachment.revision!,
      releaseEvidence: attachment.releaseEvidence!,
    }
  }

  let identity: "live" | "dead" | "ambiguous"
  try {
    identity = processIdentity({ ...attachment, token: "inspection" }, bootIdentity())
  } catch {
    identity = "ambiguous"
  }
  if (identity === "live") {
    try {
      const current = lockAndStat(lockPath(directory))
      if (!sameAttachmentLock(attachment, current.lock)) identity = "ambiguous"
    } catch {
      identity = "ambiguous"
    }
  }
  return {
    state: "attached",
    epoch,
    sessionID: sid,
    worktree: canonical,
    bootID: attachment.bootID,
    pid: attachment.pid,
    processStart: attachment.processStart,
    identity,
  }
}

export function inspectSessions(worktree: string): InspectedSession[] {
  const canonical = canonicalWorktree(worktree)
  const root = join(stateRoot(canonical), "sessions")
  if (!assertExistingDirectoryPath(root)) return []
  assertDirectory(root, true)
  const result: InspectedSession[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.isSymbolicLink()) throw new Error(`refusing symlink session directory: ${entry.name}`)
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) continue
    const directory = join(root, entry.name)
    assertDirectory(directory, true)
    let metadata: SessionMetadata | null = null
    let corrupt: string | undefined
    let transcriptActivityAt: number | undefined
    let summary: string | undefined
    try { metadata = readSessionMetadataAt(directory) }
    catch (error) { corrupt = error instanceof Error ? error.message : String(error) }
    if (!metadata && !corrupt) corrupt = "session metadata is missing"
    try {
      const scan = scanTranscript(directory, record => {
        if (summary !== undefined || record.kind !== "user") return
        const text = (record.data.text as string).replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim()
        if (!text) return
        const characters = Array.from(text)
        summary = characters.length > 120 ? `${characters.slice(0, 119).join("")}…` : text
      })
      transcriptActivityAt = scan.lastActivityAt
      if (scan.problem) corrupt ??= scan.problem
      else if (scan.trailing) corrupt ??= "incomplete trailing transcript row"
      else if (scan.manifestNeedsUpdate) corrupt ??= "transcript manifest requires recovery"
    } catch (error) { corrupt ??= error instanceof Error ? error.message : String(error) }
    try {
      if (safeLockFile(lockPath(directory))) lockAndStat(lockPath(directory))
    } catch (error) { corrupt ??= error instanceof Error ? error.message : String(error) }
    const activity = [metadata?.createdAt, metadata?.updatedAt, ...(corrupt ? [] : [transcriptActivityAt])]
      .filter((value): value is number => value !== undefined)
    result.push({
      sessionID: entry.name,
      engine: metadata?.engine ?? "",
      ...(metadata?.model === undefined ? {} : { model: metadata.model }),
      ...(metadata?.routes ? { routes: metadata.routes } : {}),
      held: metadata?.held ?? true,
      ...(activity.length ? { lastActivityAt: Math.max(...activity) } : {}),
      ...(!corrupt && summary ? { summary } : {}),
      ...(corrupt ? { corrupt } : {}),
    })
  }
  return result.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.sessionID.localeCompare(b.sessionID))
}

export function replaySession(worktree: string, sid: string, options: ReplayOptions = {}): ReplayResult {
  validateSessionID(sid)
  const canonical = canonicalWorktree(worktree)
  const directory = sessionPath(canonical, sid)
  if (!assertExistingDirectoryPath(directory)) return { records: [], complete: false, recoveryNotice: "session does not exist" }
  assertDirectory(directory, true)
  const offset = options.offset ?? 0
  const limit = options.limit ?? 100
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new TypeError("invalid transcript page")
  if (options.query !== undefined && (typeof options.query !== "string" || Buffer.byteLength(options.query, "utf8") > 1024)) throw new TypeError("invalid transcript query")
  const order = options.order ?? "asc"
  if (order !== "asc" && order !== "desc") throw new TypeError("invalid transcript order")
  if (options.kind !== undefined && !transcriptKinds.has(options.kind)) throw new TypeError("invalid transcript kind filter")
  if (options.excludeKinds !== undefined && (!Array.isArray(options.excludeKinds) || options.excludeKinds.some(kind => !transcriptKinds.has(kind)))) throw new TypeError("invalid transcript kind filter")
  const excludedKinds = new Set(options.excludeKinds)
  const queryTokens = options.query?.toLowerCase().trim().split(/\s+/).filter(Boolean) ?? []
  const taskStatuses = new Map<string, string>()
  const executionEvidence = new Map<string, string>()
  let querySnapshot: ScanResult | undefined
  if (queryTokens.length && options.kind === undefined) {
    querySnapshot = scanTranscript(directory, record => {
      if (record.kind === "task-state") taskStatuses.set(String(record.data.taskID), String(record.data.status))
      if (record.kind === "task-evidence") executionEvidence.set(String(record.data.executionID),
        Object.values(record.data).filter(value => typeof value === "string").join(" ").toLowerCase())
    })
    if (querySnapshot.problem || querySnapshot.trailing || querySnapshot.manifestNeedsUpdate) {
      return { records: [], complete: false, recoveryNotice: querySnapshot.problem ?? "transcript is incomplete or requires recovery" }
    }
  }
  const matches = (record: TranscriptRecord): boolean => {
    // Filter before counting pages; hidden telemetry still participates in integrity validation.
    if (excludedKinds.has(record.kind)) return false
    if (options.kind !== undefined && record.kind !== options.kind) return false
    if (queryTokens.length === 0) return true
    const searchableValues = Object.values(record.data)
      .filter((value): value is string => typeof value === "string")
      .map(value => value.toLowerCase())
    if (record.kind === "tool-start" || record.kind === "tool-result" || record.kind === "tool-denied") {
      searchableValues.push(taskStatuses.get(String(record.data.taskID)) ?? "", executionEvidence.get(String(record.data.executionID)) ?? "")
    }
    return queryTokens.every(token => searchableValues.some(value => value.includes(token)))
  }
  let records: TranscriptRecord[] = []
  let hasMore = false
  let scan: ScanResult
  let complete: boolean
  if (order === "asc") {
    let matched = 0
    scan = scanTranscript(directory, record => {
      if (!matches(record)) return
      const index = matched++
      if (index >= offset && records.length < limit) records.push(record)
    })
    complete = !scan.problem && !scan.trailing && !scan.manifestNeedsUpdate
    hasMore = complete && matched > offset + records.length
  } else {
    let matched = 0
    scan = scanTranscript(directory, record => { if (matches(record)) matched++ })
    complete = !scan.problem && !scan.trailing && !scan.manifestNeedsUpdate
    if (complete) {
      const end = Math.max(0, matched - offset)
      const start = Math.max(0, end - limit)
      let index = 0
      const second = scanTranscript(directory, record => {
        if (!matches(record)) return
        if (index >= start && index < end) records.push(record)
        index++
      })
      const stable = !second.problem && !second.trailing && !second.manifestNeedsUpdate &&
        second.totalRecords === scan.totalRecords && second.lastSeq === scan.lastSeq && isDeepStrictEqual(second.expected, scan.expected)
      if (stable) {
        scan = second
        records.reverse()
        hasMore = offset + records.length < matched
      } else {
        records = []
        scan = { ...second, problem: "transcript changed during descending replay" }
        complete = false
      }
    }
  }
  const sameSnapshot = (other: ScanResult): boolean => !other.problem && !other.trailing && !other.manifestNeedsUpdate &&
    other.totalRecords === scan.totalRecords && other.lastSeq === scan.lastSeq && isDeepStrictEqual(other.expected, scan.expected)
  if (querySnapshot && !sameSnapshot(querySnapshot)) {
    records = []
    complete = false
    hasMore = false
    scan = { ...scan, problem: "transcript changed during correlated search" }
  }
  const relatedRecords: TranscriptRecord[] = []
  const calls = new Set<string>()
  const tasks = new Set<string>()
  const executions = new Set<string>()
  for (const record of records) {
    if (record.kind !== "tool-start" && record.kind !== "tool-result" && record.kind !== "tool-denied") continue
    calls.add(JSON.stringify([record.data.executionID, record.data.callID]))
    tasks.add(String(record.data.taskID))
    executions.add(String(record.data.executionID))
  }
  if (complete && calls.size) {
    const terminals = new Map<string, TranscriptRecord>()
    const statuses = new Map<string, TranscriptRecord>()
    const evidence = new Map<string, TranscriptRecord>()
    const correlated = scanTranscript(directory, record => {
      if (record.kind === "tool-result" || record.kind === "tool-denied") {
        const key = JSON.stringify([record.data.executionID, record.data.callID])
        if (calls.has(key) && !terminals.has(key)) terminals.set(key, record)
      } else if (record.kind === "task-state" && tasks.has(String(record.data.taskID))) {
        statuses.set(String(record.data.taskID), record)
      } else if (record.kind === "task-evidence" && executions.has(String(record.data.executionID))) {
        evidence.set(String(record.data.executionID), record)
      }
    })
    if (!sameSnapshot(correlated)) {
      records = []
      complete = false
      hasMore = false
      scan = { ...correlated, problem: correlated.problem ?? "transcript changed during correlated replay" }
    } else {
      relatedRecords.push(...terminals.values(), ...statuses.values(), ...evidence.values())
    }
  }
  const notice = scan.problem ?? (scan.trailing ? "incomplete trailing transcript row" : scan.manifestNeedsUpdate ? "transcript manifest requires recovery" : undefined)
  return {
    records,
    ...(relatedRecords.length ? { relatedRecords } : {}),
    complete: complete && notice === undefined,
    ...(notice ? { recoveryNotice: notice } : {}),
    ...(complete ? { totalRecords: scan.totalRecords } : {}),
    ...(hasMore ? { nextOffset: offset + records.length } : {}),
  }
}
