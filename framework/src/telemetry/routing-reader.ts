import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { containsSecret } from "../security/secrets.ts"
import { stateRoot } from "../state/store.ts"

const MAX_FILES = 256
const MAX_EVENTS = 10000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 4096
const MAX_LINE_BYTES = 65536
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/

const identifier = z.string().min(1).max(200).regex(ID_PATTERN).refine((value) => !containsSecret(value))
const skillName = identifier.refine((value) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) && value !== "none")
const probability = z.number().finite().min(0).max(1)
const reason = z.enum([
  "off", "duplicate", "input_bound", "sensitive_input", "busy", "invalid_endpoint", "no_candidates",
  "sensitive_metadata", "unavailable", "invalid_response", "invalid_distribution", "invalid_winner",
  "abstained", "candidate_changed", "aborted", "recommended", "invalid_config",
])

const scoresSchema = z.object({
  choice: z.union([skillName, z.literal("none")]),
  probabilities: z.record(identifier, probability),
  confidence: probability,
  margin: z.number().finite().min(-1).max(1),
}).strip()

const thresholdsSchema = z.object({
  minProbability: z.number().finite().min(0.5).max(1),
  minMargin: z.number().finite().min(0).max(1),
  timeoutMs: z.number().int().min(50).max(3000),
}).strip()

const baseSchema = {
  schemaVersion: z.literal(1),
  eventID: identifier,
  recordedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}

const decisionSchema = z.object({
  ...baseSchema,
  event: z.literal("decision"),
  decisionID: identifier,
  sessionID: identifier,
  messageID: identifier,
  model: z.literal("jev-latest"),
  mode: z.enum(["off", "shadow", "suggest", "invalid"]),
  skill: skillName.nullable(),
  reason,
  elapsedMs: z.number().int().min(0).max(60000),
  requestSent: z.boolean(),
  candidates: z.array(skillName).max(16),
  thresholds: thresholdsSchema.nullable(),
  scores: scoresSchema.nullable(),
}).strip().superRefine((row, ctx) => {
  const candidates = new Set(row.candidates)
  if (candidates.size !== row.candidates.length || candidates.has("none")) {
    ctx.addIssue({ code: "custom", message: "candidate set is not unique or contains reserved none", path: ["candidates"] })
  }
  if (row.skill !== null && (!candidates.has(row.skill) || row.reason !== "recommended")) {
    ctx.addIssue({ code: "custom", message: "skill must be a recommended candidate", path: ["skill"] })
  }
  if (row.reason === "recommended" && (row.skill === null || !["shadow", "suggest"].includes(row.mode) || !row.requestSent || !row.scores)) {
    ctx.addIssue({ code: "custom", message: "recommendation is inconsistent with mode or skill", path: ["reason"] })
  }
  if (row.mode === "invalid" && row.reason !== "invalid_config") {
    ctx.addIssue({ code: "custom", message: "invalid mode must report invalid_config", path: ["mode"] })
  }
  if (!row.scores) return
  if (row.candidates.length === 0) {
    ctx.addIssue({ code: "custom", message: "scored decisions require candidates", path: ["candidates"] })
    return
  }
  const probabilities = row.scores.probabilities
  const expectedKeys = [...row.candidates, "none"].sort()
  const actualKeys = Object.keys(probabilities).sort()
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, i) => key !== actualKeys[i])) {
    ctx.addIssue({ code: "custom", message: "probability keys do not match candidates", path: ["scores", "probabilities"] })
    return
  }
  if (!Object.hasOwn(probabilities, row.scores.choice)) {
    ctx.addIssue({ code: "custom", message: "choice is not a probability key", path: ["scores", "choice"] })
  }
  const sum = Object.values(probabilities).reduce((total, value) => total + value, 0)
  if (Math.abs(sum - 1) > 0.001) {
    ctx.addIssue({ code: "custom", message: "probabilities do not sum to one", path: ["scores", "probabilities"] })
  }
  const runnerUp = Math.max(...actualKeys.filter((key) => key !== row.scores!.choice).map((key) => probabilities[key]!))
  if (Math.abs(row.scores.margin - (probabilities[row.scores.choice]! - runnerUp)) > 0.001) {
    ctx.addIssue({ code: "custom", message: "margin does not match probabilities", path: ["scores", "margin"] })
  }
  if (row.reason === "recommended" && (row.scores.choice !== row.skill || !row.thresholds
    || probabilities[row.scores.choice]! <= runnerUp
    || probabilities[row.scores.choice]! < row.thresholds.minProbability
    || probabilities[row.scores.choice]! - runnerUp < row.thresholds.minMargin)) {
    ctx.addIssue({ code: "custom", message: "recommendation does not satisfy its choice and thresholds", path: ["skill"] })
  }
})

const appliedSchema = z.object({
  ...baseSchema,
  event: z.literal("advice_applied"),
  decisionID: identifier,
  sessionID: identifier,
  messageID: identifier,
  skill: skillName,
}).strip()

const eventSchema = z.union([decisionSchema, appliedSchema])
export type RoutingEvent = z.infer<typeof eventSchema>

const rejectionReasons = z.enum([
  "invalid_filename", "line_too_large", "malformed_json", "invalid_utf8", "invalid_schema", "session_mismatch", "torn_line", "truncated_line",
])
const truncationReasons = z.enum(["directory_limit", "file_limit", "event_limit", "file_bytes", "total_bytes"])
type TruncationReason = z.infer<typeof truncationReasons>
const rejectionSchema = z.object({ sessionID: identifier.nullable(), line: z.number().int().min(0), reason: rejectionReasons }).strict()

const coverageSchema = z.object({
  filesScanned: z.number().int().min(0).max(MAX_FILES),
  scanned: z.number().int().min(0).max(MAX_EVENTS),
  valid: z.number().int().min(0).max(MAX_EVENTS),
  invalid: z.number().int().min(0).max(MAX_EVENTS),
  duplicates: z.number().int().min(0).max(MAX_EVENTS),
  invalidFiles: z.number().int().min(0).max(MAX_FILES),
  truncated: z.boolean(),
  truncationReasons: z.array(truncationReasons).max(5),
  scope: z.enum(["complete", "bounded"]),
}).strict().superRefine((coverage, ctx) => {
  if (coverage.scanned !== coverage.valid + coverage.invalid + coverage.duplicates) {
    ctx.addIssue({ code: "custom", message: "scanned event count is inconsistent", path: ["scanned"] })
  }
  if (coverage.truncated !== (coverage.truncationReasons.length > 0) || coverage.truncated !== (coverage.scope === "bounded")) {
    ctx.addIssue({ code: "custom", message: "coverage scope is inconsistent", path: ["scope"] })
  }
  if (new Set(coverage.truncationReasons).size !== coverage.truncationReasons.length) {
    ctx.addIssue({ code: "custom", message: "duplicate truncation reasons", path: ["truncationReasons"] })
  }
})

export const routingSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("jev-routing-snapshot"),
  coverage: coverageSchema,
  events: z.array(eventSchema).max(MAX_EVENTS),
  rejected: z.array(rejectionSchema).max(MAX_EVENTS + MAX_FILES),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.coverage.valid !== snapshot.events.length) {
    ctx.addIssue({ code: "custom", message: "valid event count does not match events", path: ["coverage", "valid"] })
  }
  if (snapshot.coverage.invalid + snapshot.coverage.invalidFiles !== snapshot.rejected.length) {
    ctx.addIssue({ code: "custom", message: "rejection count does not match coverage", path: ["rejected"] })
  }
  const rejectedFiles = snapshot.rejected.filter((row) => row.reason === "invalid_filename").length
  if (snapshot.coverage.invalidFiles !== rejectedFiles || snapshot.coverage.invalid !== snapshot.rejected.length - rejectedFiles) {
    ctx.addIssue({ code: "custom", message: "rejection kinds do not match coverage", path: ["rejected"] })
  }
  for (let i = 0; i < snapshot.rejected.length; i++) {
    const row = snapshot.rejected[i]!
    if ((row.reason === "invalid_filename" && (row.sessionID !== null || row.line !== 0))
      || (row.reason !== "invalid_filename" && (row.sessionID === null || row.line === 0))) {
      ctx.addIssue({ code: "custom", message: "rejection location is inconsistent with reason", path: ["rejected", i] })
    }
  }
  const identifiers = new Set<string>()
  for (let i = 0; i < snapshot.events.length; i++) {
    const event = snapshot.events[i]!
    if (identifiers.has(event.eventID)) ctx.addIssue({ code: "custom", message: "duplicate eventID", path: ["events", i, "eventID"] })
    identifiers.add(event.eventID)
  }
})
export type RoutingSnapshot = z.infer<typeof routingSnapshotSchema>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!isObject(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** Stored snapshots are stricter than input lines: no unprojected metadata may be present. */
export function isRoutingSnapshot(value: unknown): value is RoutingSnapshot {
  const parsed = routingSnapshotSchema.safeParse(value)
  if (!parsed.success || !isObject(value) || !hasExactKeys(value, ["schemaVersion", "kind", "coverage", "events", "rejected"])) return false
  if (!isObject(value.coverage) || !hasExactKeys(value.coverage, ["filesScanned", "scanned", "valid", "invalid", "duplicates", "invalidFiles", "truncated", "truncationReasons", "scope"])) return false
  if (!Array.isArray(value.events) || !Array.isArray(value.rejected)) return false
  if (value.rejected.some((item) => !hasExactKeys(item, ["sessionID", "line", "reason"]))) return false
  for (const event of value.events) {
    if (!isObject(event)) return false
    if (event.event === "decision") {
      if (!hasExactKeys(event, ["schemaVersion", "eventID", "recordedAt", "event", "decisionID", "sessionID", "messageID", "model", "mode", "skill", "reason", "elapsedMs", "requestSent", "candidates", "thresholds", "scores"])) return false
      if (event.thresholds !== null && (!isObject(event.thresholds) || !hasExactKeys(event.thresholds, ["minProbability", "minMargin", "timeoutMs"]))) return false
      if (event.scores !== null) {
        if (!isObject(event.scores) || !hasExactKeys(event.scores, ["choice", "probabilities", "confidence", "margin"])) return false
        if (!isObject(event.scores.probabilities)) return false
      }
    } else if (event.event === "advice_applied") {
      if (!hasExactKeys(event, ["schemaVersion", "eventID", "recordedAt", "event", "decisionID", "sessionID", "messageID", "skill"])) return false
    } else return false
  }
  return true
}

type RoutingLimits = { files: number; events: number; fileBytes: number; totalBytes: number }
const DEFAULT_LIMITS: RoutingLimits = { files: MAX_FILES, events: MAX_EVENTS, fileBytes: MAX_FILE_BYTES, totalBytes: MAX_TOTAL_BYTES }
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

function sameFile(a: ReturnType<typeof fstatSync>, b: NonNullable<ReturnType<typeof lstatSync>>): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function openDirectory(path: string): number | null {
  let before: ReturnType<typeof lstatSync>
  try { before = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new Error("Routing state directory must be a real directory")
  }
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("Routing state directory must be a real directory")
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw new Error("Routing state directory must be a real directory")
  }
  const opened = fstatSync(fd)
  if (!opened.isDirectory() || !sameFile(opened, before)) {
    closeSync(fd)
    throw new Error("Routing state directory must be a real directory")
  }
  return fd
}

function readBounded(fd: number, limit: number): { bytes: Buffer; truncated: boolean } {
  const chunks: Buffer[] = []
  let length = 0
  while (length < limit) {
    const chunk = Buffer.allocUnsafe(Math.min(65536, limit - length))
    const count = readSync(fd, chunk, 0, chunk.length, null)
    if (count === 0) break
    chunks.push(chunk.subarray(0, count))
    length += count
  }
  const bytes = Buffer.concat(chunks, length)
  return { bytes, truncated: fstatSync(fd).size > length }
}

function enumerateDirectory(path: string, fd: number): { names: string[]; bounded: boolean } {
  const initial = fstatSync(fd)
  let before: ReturnType<typeof lstatSync>
  try { before = lstatSync(path) } catch { throw new Error("Routing state directory changed during read") }
  if (before.isSymbolicLink() || !before.isDirectory() || !sameFile(initial, before)) {
    throw new Error("Routing state directory changed during read")
  }
  let directory: ReturnType<typeof opendirSync>
  try { directory = opendirSync(path) } catch { throw new Error("Routing state directory must be a real directory") }
  const names: string[] = []
  let bounded = false
  try {
    for (let i = 0; i <= MAX_DIRECTORY_ENTRIES; i++) {
      const entry = directory.readSync()
      if (entry === null) break
      if (i === MAX_DIRECTORY_ENTRIES) { bounded = true; break }
      names.push(entry.name)
    }
  } finally { directory.closeSync() }
  let current: ReturnType<typeof lstatSync>
  try { current = lstatSync(path) } catch { throw new Error("Routing state directory changed during read") }
  if (current.isSymbolicLink() || !current.isDirectory() || !sameFile(initial, current)) {
    throw new Error("Routing state directory changed during read")
  }
  return { names, bounded }
}

function projectEvent(data: unknown): RoutingEvent | null {
  const parsed = eventSchema.safeParse(data)
  if (!parsed.success) return null
  const row = parsed.data
  if (row.event === "decision") {
    const probabilities = Object.fromEntries(Object.entries(row.scores?.probabilities ?? {}).sort(([a], [b]) => compareText(a, b)))
    return {
      schemaVersion: 1, eventID: row.eventID, recordedAt: row.recordedAt, event: "decision", decisionID: row.decisionID,
      sessionID: row.sessionID, messageID: row.messageID, model: "jev-latest", mode: row.mode, skill: row.skill,
      reason: row.reason, elapsedMs: row.elapsedMs, requestSent: row.requestSent,
      candidates: [...row.candidates].sort(), thresholds: row.thresholds && { ...row.thresholds },
      scores: row.scores && { choice: row.scores.choice, probabilities, confidence: row.scores.confidence, margin: row.scores.margin },
    }
  }
  return {
    schemaVersion: 1, eventID: row.eventID, recordedAt: row.recordedAt, event: "advice_applied", decisionID: row.decisionID,
    sessionID: row.sessionID, messageID: row.messageID, skill: row.skill,
  }
}

/** Reads only projected, bounded routing observations; untrusted source bytes and unknown metadata are never returned. */
export function readRoutingLogs(worktree: string): RoutingSnapshot {
  return readRoutingLogsWithLimits(worktree, DEFAULT_LIMITS)
}

function readRoutingLogsWithLimits(worktree: string, limits: RoutingLimits): RoutingSnapshot {
  const root = stateRoot(worktree)
  const stateFD = openDirectory(root)
  if (stateFD === null) return emptySnapshot()
  let routingFD: number | null = null
  try {
    const routingDir = join(root, "routing")
    routingFD = openDirectory(routingDir)
    if (routingFD === null) return emptySnapshot()
    const enumerated = enumerateDirectory(routingDir, routingFD)
    if (enumerated.bounded) {
      return routingSnapshotSchema.parse({
        schemaVersion: 1, kind: "jev-routing-snapshot",
        coverage: {
          filesScanned: 0, scanned: 0, valid: 0, invalid: 0, duplicates: 0, invalidFiles: 0,
          truncated: true, truncationReasons: ["directory_limit"], scope: "bounded",
        },
        events: [], rejected: [],
      })
    }
    const names = enumerated.names.filter((name) => name.endsWith(".jsonl")).sort()
    const selected = names.slice(0, limits.files)
    const events = new Map<string, RoutingEvent>()
    const rejected: Array<z.infer<typeof rejectionSchema>> = []
    const truncationReasons = new Set<TruncationReason>()
    let filesScanned = 0
    let scanned = 0
    let invalid = 0
    let duplicates = 0
    let invalidFiles = 0
    let totalBytes = 0
    let eventLimitReached = false

    for (let fileIndex = 0; fileIndex < selected.length; fileIndex++) {
      if (scanned >= limits.events) {
        eventLimitReached = true
        break
      }
      const name = selected[fileIndex]!
      const path = join(routingDir, name)
      let openedFD: number | undefined
      try {
        const before = lstatSync(path)
        if (before.isSymbolicLink() || !before.isFile()) throw new Error("not regular")
        openedFD = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const opened = fstatSync(openedFD)
        if (!opened.isFile() || !sameFile(opened, before)) throw new Error("not regular")
      } catch {
        if (openedFD !== undefined) closeSync(openedFD)
        throw new Error("Routing log must be a regular, non-symlink file")
      }
      const fd = openedFD
      if (fd === undefined) throw new Error("Routing log could not be opened")
      filesScanned++
      try {
        const sessionID = name.slice(0, -".jsonl".length)
        if (!ID_PATTERN.test(sessionID) || containsSecret(sessionID)) {
          invalidFiles++
          rejected.push({ sessionID: null, line: 0, reason: "invalid_filename" })
          continue
        }
        const remaining = limits.totalBytes - totalBytes
        if (remaining <= 0) {
          truncationReasons.add("total_bytes")
          break
        }
        const fileLimit = Math.min(limits.fileBytes, remaining)
        const { bytes, truncated } = readBounded(fd, fileLimit)
        totalBytes += bytes.length
        if (truncated) truncationReasons.add(remaining < limits.fileBytes ? "total_bytes" : "file_bytes")
        const lines = bytes.toString("binary").split("\n")
        const hasUnterminated = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a
        lines.pop()
        const completeLines = lines
        for (let lineIndex = 0; lineIndex < completeLines.length; lineIndex++) {
          if (scanned >= limits.events) {
            eventLimitReached = true
            break
          }
          let lineBytes = Buffer.from(completeLines[lineIndex]!, "binary")
          if (lineBytes.length && lineBytes[lineBytes.length - 1] === 0x0d) lineBytes = lineBytes.subarray(0, lineBytes.length - 1)
          scanned++
          if (lineBytes.length > MAX_LINE_BYTES) {
            invalid++
            rejected.push({ sessionID, line: lineIndex + 1, reason: "line_too_large" })
            continue
          }
          let line: string
          try { line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes) } catch {
            invalid++
            rejected.push({ sessionID, line: lineIndex + 1, reason: "invalid_utf8" })
            continue
          }
          let input: unknown
          try { input = JSON.parse(line) } catch {
            invalid++
            rejected.push({ sessionID, line: lineIndex + 1, reason: "malformed_json" })
            continue
          }
          const candidate = projectEvent(input)
          if (!candidate) {
            invalid++
            rejected.push({ sessionID, line: lineIndex + 1, reason: "invalid_schema" })
            continue
          }
          if (candidate.sessionID !== sessionID) {
            invalid++
            rejected.push({ sessionID, line: lineIndex + 1, reason: "session_mismatch" })
            continue
          }
          const previous = events.get(candidate.eventID)
          if (previous) {
            if (JSON.stringify(previous) !== JSON.stringify(candidate)) throw new Error("Conflicting routing eventID; refusing capture")
            duplicates++
            continue
          }
          events.set(candidate.eventID, candidate)
        }
        if (eventLimitReached) break
        if (hasUnterminated) {
          if (scanned < limits.events) {
            scanned++
            invalid++
            rejected.push({ sessionID, line: completeLines.length + 1, reason: truncated ? "truncated_line" : "torn_line" })
          } else eventLimitReached = true
        }
        if (truncated && totalBytes >= limits.totalBytes) break
      } finally { closeSync(fd) }
    }
    if (names.length > limits.files) truncationReasons.add("file_limit")
    if (eventLimitReached || (scanned >= limits.events && selected.length > filesScanned)) truncationReasons.add("event_limit")
    const uniqueTruncationReasons = [...truncationReasons].sort()
    const uniqueEvents = [...events.values()].sort((a, b) => compareText(a.sessionID, b.sessionID) || compareText(a.eventID, b.eventID))
    rejected.sort((a, b) => compareText(a.sessionID ?? "", b.sessionID ?? "") || a.line - b.line || compareText(a.reason, b.reason))
    return routingSnapshotSchema.parse({
      schemaVersion: 1, kind: "jev-routing-snapshot",
      coverage: {
        filesScanned, scanned, valid: uniqueEvents.length, invalid, duplicates, invalidFiles,
        truncated: uniqueTruncationReasons.length > 0, truncationReasons: uniqueTruncationReasons,
        scope: uniqueTruncationReasons.length > 0 ? "bounded" : "complete",
      },
      events: uniqueEvents, rejected,
    })
  } finally {
    if (routingFD !== null) closeSync(routingFD)
    closeSync(stateFD)
  }
}

function emptySnapshot(): RoutingSnapshot {
  return {
    schemaVersion: 1, kind: "jev-routing-snapshot",
    coverage: { filesScanned: 0, scanned: 0, valid: 0, invalid: 0, duplicates: 0, invalidFiles: 0, truncated: false, truncationReasons: [], scope: "complete" },
    events: [], rejected: [],
  }
}
