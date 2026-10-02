import { createHash } from "node:crypto"
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { containsSecret } from "../security/secrets.ts"
import type { HashReason } from "./skills.ts"

export const SKILL_FINGERPRINT_LIMITS = Object.freeze({
  returnedPayloadBytes: 1024 * 1024,
  projectSkillFileBytes: 128 * 1024,
})

export const SUPPORTED_SKILL_RENDERER = "opencode-1.18.33-skill-tool" as const
export const RETURNED_BODY_BASIS = "opencode-1.18.33.trimmed-content.v1" as const
export const RETURNED_PAYLOAD_BASIS = "terminal-output-utf8.v1" as const
export const OBSERVED_FILE_BASIS = "current-project-skill-file-at-observation.v1" as const

export type SkillFingerprintInput = {
  requestedName?: unknown
  returnedName?: unknown
  output?: unknown
  metadata?: unknown
  renderer?: unknown
  truncated?: boolean
  compacted?: boolean
  modified?: boolean
  payloadModified?: boolean
  projectRoot?: string
  observedAt?: number
}

export type SkillFingerprint = {
  requestedName: string | null
  requestedNameReason: HashReason | null
  returnedName: string | null
  returnedNameReason: HashReason | null
  nameConflict: boolean
  returnedContent: "observed" | "not_returned" | "unknown"
  returnedPayloadSha256: string | null
  returnedPayloadBasis: typeof RETURNED_PAYLOAD_BASIS | null
  payloadHashReason: HashReason | null
  returnedBodySha256: string | null
  returnedBodyBasis: typeof RETURNED_BODY_BASIS | null
  bodyHashReason: HashReason | null
  observedFileSha256: string | null
  observedFileReason: HashReason | null
  observedFileSize: number | null
  observedFileAt: number | null
  observedFileBasis: typeof OBSERVED_FILE_BASIS | null
  sourceHashReason: HashReason | null
  loadedOriginalFileSha256: null
  loadedOriginalFileAvailable: false
}

const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/
const MAX_SUMMARY_FACTS = 10_000
const MAX_SUMMARY_RELATIONS = 50_000
const MAX_OBSERVED_DURATION_MS = 30 * 24 * 60 * 60 * 1000
const HASH_REASONS: readonly HashReason[] = [
  "invalid_payload", "too_large", "secret_detected", "unsupported_renderer", "invalid_name", "name_conflict",
  "missing_metadata", "truncated", "compacted", "modified", "ambiguous_boundary", "unsupported_shape",
  "source_unavailable", "source_ambiguous", "source_unsafe", "source_too_large", "source_changed", "source_secret",
  "source_name_conflict",
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validName(value: unknown): value is string {
  return typeof value === "string" && SKILL_NAME.test(value) && value !== "none" && !containsSecret(value)
}

function validID(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value) && !containsSecret(value)
}

function optionalID(value: unknown): boolean {
  return value === undefined || value === null || validID(value)
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

type RenderedBody = { body: string; reason: null } | { body: null; reason: HashReason }

function renderedBody(output: string, name: string, metadataDir: unknown): RenderedBody {
  if (typeof metadataDir !== "string" || metadataDir.length === 0 || metadataDir.length > 4096 || containsSecret(metadataDir)) {
    return { body: null, reason: "missing_metadata" }
  }
  const prefix = `<skill_content name="${name}">\n# Skill: ${name}\n\n`
  if (!output.startsWith(prefix)) return { body: null, reason: "unsupported_shape" }
  const delimiter = "\n\nBase directory for this skill: "
  const bodyStart = prefix.length
  const delimiterAt = output.indexOf(delimiter, bodyStart)
  if (delimiterAt < bodyStart || output.indexOf(delimiter, delimiterAt + delimiter.length) !== -1) {
    return { body: null, reason: "ambiguous_boundary" }
  }
  const body = output.slice(bodyStart, delimiterAt)
  const baseStart = delimiterAt + delimiter.length
  const baseEnd = output.indexOf("\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.", baseStart)
  if (baseEnd < baseStart) return { body: null, reason: "unsupported_shape" }
  const base = output.slice(baseStart, baseEnd)
  if (!base || base !== metadataDir) return { body: null, reason: "missing_metadata" }
  const suffix = "\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.\n" +
    "Note: file list is sampled.\n\n<skill_files>\n"
  if (!output.startsWith(suffix, baseEnd)) return { body: null, reason: "unsupported_shape" }
  const close = "\n</skill_files>\n</skill_content>"
  const closeAt = output.indexOf(close, baseEnd + suffix.length)
  if (closeAt < 0 || output.indexOf(close, closeAt + close.length) !== -1 || closeAt + close.length !== output.length) {
    return { body: null, reason: "ambiguous_boundary" }
  }
  return { body, reason: null }
}

function noFingerprint(input: SkillFingerprintInput, reason: HashReason, returnedContent: SkillFingerprint["returnedContent"]): SkillFingerprint {
  const requestedName = validName(input.requestedName) ? input.requestedName : null
  const metadata = isRecord(input.metadata) ? input.metadata : null
  const metadataName = metadata?.name
  const returnedName = validName(input.returnedName) ? input.returnedName : validName(metadataName) ? metadataName : null
  return {
    requestedName,
    requestedNameReason: input.requestedName === undefined || input.requestedName === null || requestedName ? null : "invalid_name",
    returnedName,
    returnedNameReason: input.returnedName !== undefined && input.returnedName !== null
      ? validName(input.returnedName) ? null : "invalid_name"
      : metadataName === undefined || metadataName === null || validName(metadataName) ? null : "invalid_name",
    nameConflict: !!requestedName && !!returnedName && requestedName !== returnedName,
    returnedContent,
    returnedPayloadSha256: null,
    returnedPayloadBasis: null,
    payloadHashReason: reason,
    returnedBodySha256: null,
    returnedBodyBasis: null,
    bodyHashReason: reason,
    observedFileSha256: null,
    observedFileReason: input.projectRoot ? "source_unavailable" : null,
    observedFileSize: null,
    observedFileAt: null,
    observedFileBasis: null,
    sourceHashReason: input.projectRoot ? "source_unavailable" : null,
    loadedOriginalFileSha256: null,
    loadedOriginalFileAvailable: false,
  }
}

/** Pure hash adapter for exact terminal output bytes and the supported host skill renderer. */
export function fingerprintSkillPayload(input: SkillFingerprintInput): SkillFingerprint {
  const returnedContent: SkillFingerprint["returnedContent"] = typeof input.output === "string" ? "observed" : "unknown"
  if (typeof input.output !== "string") return noFingerprint(input, "invalid_payload", returnedContent)
  const output = input.output
  if (output.length > SKILL_FINGERPRINT_LIMITS.returnedPayloadBytes) return noFingerprint(input, "too_large", returnedContent)
  const outputBytes = Buffer.byteLength(output, "utf8")
  if (outputBytes > SKILL_FINGERPRINT_LIMITS.returnedPayloadBytes) return noFingerprint(input, "too_large", returnedContent)
  if (input.payloadModified || input.modified || containsSecret(output) ||
      (isRecord(input.metadata) && typeof input.metadata.dir === "string" && containsSecret(input.metadata.dir))) {
    const reason: HashReason = input.payloadModified || input.modified ? "modified" : "secret_detected"
    return noFingerprint(input, reason, returnedContent)
  }

  const requestedName = validName(input.requestedName) ? input.requestedName : null
  const metadata = isRecord(input.metadata) ? input.metadata : null
  const metadataName = metadata?.name
  const returnedName = validName(input.returnedName) ? input.returnedName : validName(metadataName) ? metadataName : null
  const requestedNameReason = input.requestedName === undefined || input.requestedName === null || requestedName ? null : "invalid_name"
  const returnedNameReason = input.returnedName !== undefined && input.returnedName !== null
    ? returnedName ? null : "invalid_name"
    : metadataName === undefined || metadataName === null || returnedName ? null : "invalid_name"
  const nameConflict = !!requestedName && !!returnedName && requestedName !== returnedName
  const payloadHash = sha256(output)
  let bodyHash: string | null = null
  let bodyReason: HashReason | null = null
  let bodyBasis: typeof RETURNED_BODY_BASIS | null = null

  if (input.truncated) bodyReason = "truncated"
  else if (input.compacted) bodyReason = "compacted"
  else if (input.modified) bodyReason = "modified"
  else if (input.renderer !== SUPPORTED_SKILL_RENDERER) bodyReason = "unsupported_renderer"
  else if (!returnedName) bodyReason = "invalid_name"
  else if (metadataName !== returnedName || nameConflict && !validName(metadataName)) bodyReason = "name_conflict"
  else {
    const parsed = renderedBody(output, returnedName, metadata?.dir)
    bodyReason = parsed.reason
    if (parsed.body !== null) {
      bodyHash = sha256(parsed.body)
      bodyBasis = RETURNED_BODY_BASIS
      bodyReason = null
    }
  }

  return {
    requestedName,
    requestedNameReason,
    returnedName,
    returnedNameReason,
    nameConflict,
    returnedContent,
    returnedPayloadSha256: payloadHash,
    returnedPayloadBasis: RETURNED_PAYLOAD_BASIS,
    payloadHashReason: null,
    returnedBodySha256: bodyHash,
    returnedBodyBasis: bodyBasis,
    bodyHashReason: bodyReason,
    observedFileSha256: null,
    observedFileReason: null,
    observedFileSize: null,
    observedFileAt: null,
    observedFileBasis: null,
    sourceHashReason: input.projectRoot ? "source_unavailable" : null,
    loadedOriginalFileSha256: null,
    loadedOriginalFileAvailable: false,
  }
}

type SourceFingerprint = {
  hash: string | null
  size: number | null
  observedAt: number | null
  basis: typeof OBSERVED_FILE_BASIS | null
  reason: HashReason | null
}

function sameFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function inspectProjectFile(rootInput: string, skillName: string, metadataDir: unknown, observedAt: number): SourceFingerprint {
  let root: string
  try {
    root = realpathSync.native(resolve(rootInput))
    if (!lstatSync(root).isDirectory()) return { hash: null, size: null, observedAt: null, basis: null, reason: "source_unsafe" }
  } catch {
    return { hash: null, size: null, observedAt: null, basis: null, reason: "source_unavailable" }
  }
  if (typeof metadataDir !== "string" || metadataDir.length > 4096 || containsSecret(metadataDir)) {
    return { hash: null, size: null, observedAt: null, basis: null, reason: "source_unsafe" }
  }
  const roots = [".opencode", ".agents"] as const
  const candidates: Array<{ directory: string; file: string }> = []
  let unsafe = false
  for (const base of roots) {
    const directory = join(root, base, "skills", skillName)
    const file = join(directory, "SKILL.md")
    try {
      const info = lstatSync(file)
      if (info.isSymbolicLink() || !info.isFile()) {
        unsafe = true
        continue
      }
      let current = root
      for (const part of [base, "skills", skillName]) {
        current = join(current, part)
        const component = lstatSync(current)
        if (component.isSymbolicLink() || !component.isDirectory()) unsafe = true
      }
      if (!unsafe) candidates.push({ directory, file })
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) unsafe = true
    }
  }
  if (unsafe) return { hash: null, size: null, observedAt: null, basis: null, reason: "source_unsafe" }
  if (candidates.length > 1) return { hash: null, size: null, observedAt: null, basis: null, reason: "source_ambiguous" }
  if (!candidates.length) return { hash: null, size: null, observedAt: null, basis: null, reason: "source_unavailable" }
  const candidate = candidates[0]!
  let returnedDirectory: string
  try {
    returnedDirectory = realpathSync.native(resolve(metadataDir))
  } catch {
    return { hash: null, size: null, observedAt: null, basis: null, reason: "source_unavailable" }
  }
  if (returnedDirectory !== candidate.directory) return { hash: null, size: null, observedAt: null, basis: null, reason: "source_unavailable" }

  let fd: number | null = null
  try {
    const pathStat = lstatSync(candidate.file)
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) return { hash: null, size: null, observedAt: null, basis: null, reason: "source_unsafe" }
    if (pathStat.size > SKILL_FINGERPRINT_LIMITS.projectSkillFileBytes) return { hash: null, size: null, observedAt: null, basis: null, reason: "source_too_large" }
    fd = openSync(candidate.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > SKILL_FINGERPRINT_LIMITS.projectSkillFileBytes) {
      return { hash: null, size: null, observedAt: null, basis: null, reason: "source_too_large" }
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    const pathAfter = lstatSync(candidate.file)
    if (pathAfter.isSymbolicLink() || !sameFile(before, after) || before.dev !== pathAfter.dev || before.ino !== pathAfter.ino ||
        bytes.byteLength !== before.size) {
      return { hash: null, size: null, observedAt: null, basis: null, reason: "source_changed" }
    }
    const text = bytes.toString("utf8")
    if (!Buffer.from(text, "utf8").equals(bytes)) return { hash: null, size: null, observedAt: null, basis: null, reason: "source_unsafe" }
    if (containsSecret(text)) return { hash: null, size: null, observedAt: null, basis: null, reason: "source_secret" }
    return {
      hash: sha256(bytes), size: bytes.byteLength, observedAt, basis: OBSERVED_FILE_BASIS, reason: null,
    }
  } catch {
    return { hash: null, size: null, observedAt: null, basis: null, reason: "source_unsafe" }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* A close fault cannot expose the raw file or change the hash basis. */ }
    }
  }
}

/** Fingerprints returned bytes and, only for a single safe project SKILL.md, its current on-disk bytes. */
export function fingerprintSkillObservation(input: SkillFingerprintInput): SkillFingerprint {
  const base = fingerprintSkillPayload(input)
  if (!input.projectRoot || !base.returnedName || base.nameConflict) {
    const reason = input.projectRoot && base.nameConflict ? "source_name_conflict" : base.sourceHashReason
    return {
      ...base,
      sourceHashReason: reason,
      observedFileReason: reason ?? base.observedFileReason,
    }
  }
  const metadata = isRecord(input.metadata) ? input.metadata : null
  const at = Number.isSafeInteger(input.observedAt) && (input.observedAt as number) >= 0
    ? input.observedAt as number
    : Date.now()
  const source = inspectProjectFile(input.projectRoot, base.returnedName, metadata?.dir, at)
  if (source.reason) return { ...base, observedFileReason: source.reason, sourceHashReason: source.reason }
  return {
    ...base,
    observedFileSha256: source.hash,
    observedFileReason: null,
    observedFileSize: source.size,
    observedFileAt: source.observedAt,
    observedFileBasis: source.basis,
    sourceHashReason: null,
  }
}

type RatioBase = {
  numerator: number
  denominator: number
  display: string
  unknown: number
  excluded: number
  censored: number
}

export type Ratio = RatioBase & {
  campaignID: string | null
  period: { startAt: number | null; endAt: number | null; basis: string }
  coverage: {
    storedFacts: number | null
    unscannedStoredFacts: number | null
    expiredFacts: number | null
    truncated: boolean
    unscannedTotal: "known" | "unknown"
    notCollectedAfterStop: boolean | null
  }
}

type RatioDetails = { unknown?: number; excluded?: number; censored?: number }

function ratio(numerator: number, denominator: number, details: RatioDetails = {}): RatioBase {
  return {
    numerator,
    denominator,
    display: denominator === 0 ? "N/A" : `${numerator}/${denominator}`,
    unknown: details.unknown ?? 0,
    excluded: details.excluded ?? 0,
    censored: details.censored ?? 0,
  }
}

type EvaluationKind = "skill_call" | "turn_context" | "task_context" | "verification_observation" | "tool_context"
type EvaluationFact = {
  kind: EvaluationKind
  sessionID: string
  factKey: string
  phase: "pending" | "terminal" | "conflict"
  conflict: boolean
  recordedAt: number
  payload: Record<string, unknown>
}

const EVALUATION_KINDS: readonly EvaluationKind[] = [
  "skill_call", "turn_context", "task_context", "verification_observation", "tool_context",
]
const TURN_CLOSURES = ["completed", "compacted", "deleted", "unknown"] as const
const TASK_ROLES = ["main", "worker", "reviewer", "data-analyst", "data-verifier", "unknown"] as const
const TASK_ROLE_BASES = ["sdk_agent_field", "host_metadata", "code_owned", "unknown"] as const
const MAX_IDENTIFIER_TEXT = 128

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function validDimension(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_IDENTIFIER_TEXT &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+@_-]{0,127}$/.test(value) &&
    !value.includes("..") && !value.includes("//") && !/[A-Za-z]:\//.test(value) && !containsSecret(value)
}

function optionalDimension(value: unknown): boolean {
  return value === undefined || value === null || validDimension(value)
}

function optionalEnum(value: unknown, values: readonly string[]): boolean {
  return value === undefined || value === null || typeof value === "string" && values.includes(value)
}

function validDigestOrNull(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function validFingerprintPair(payload: Record<string, unknown>, hashKey: string, basisKey: string): boolean {
  const hash = payload[hashKey]
  const basis = payload[basisKey]
  if (hash === undefined || hash === null) return basis === undefined || basis === null
  return typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) && validDimension(basis)
}

function optionalTime(value: unknown): boolean {
  return value === undefined || value === null || validTime(value)
}

function optionalDuration(value: unknown): boolean {
  return value === undefined || value === null || Number.isSafeInteger(value) &&
    (value as number) >= 0 && (value as number) <= MAX_OBSERVED_DURATION_MS
}

function validStoredFact(value: unknown): value is EvaluationFact {
  if (!isRecord(value) || typeof value.kind !== "string" || !EVALUATION_KINDS.includes(value.kind as EvaluationKind) ||
      !validID(value.sessionID) || !validID(value.factKey) ||
      !["pending", "terminal", "conflict"].includes(String(value.phase)) || typeof value.conflict !== "boolean" ||
      !validTime(value.recordedAt) || !isRecord(value.payload) || value.payload.sessionID !== value.sessionID) return false

  const kind = value.kind as EvaluationKind
  const payload = value.payload
  if (kind === "skill_call") {
    return validID(payload.callID) && payload.callID === value.factKey &&
      ["pending", "completed", "error", "aborted", "unknown"].includes(String(payload.state)) &&
      !(value.phase === "pending" && payload.state !== "pending") && !(value.phase === "terminal" && payload.state === "pending") &&
      ["observed", "not_returned", "unknown"].includes(String(payload.returnedContent)) &&
      (payload.requestedName === undefined || payload.requestedName === null || validName(payload.requestedName)) &&
      (payload.returnedName === undefined || payload.returnedName === null || validName(payload.returnedName)) &&
      (payload.nameConflict === undefined || typeof payload.nameConflict === "boolean") &&
      optionalID(payload.messageID) && optionalID(payload.taskID) && optionalID(payload.attemptID) && optionalID(payload.routeDecisionID) &&
      validFingerprintPair(payload, "returnedPayloadSha256", "returnedPayloadBasis") &&
      validFingerprintPair(payload, "returnedBodySha256", "returnedBodyBasis") &&
      validFingerprintPair(payload, "observedFileSha256", "observedFileBasis") &&
      (payload.observedFileSize === undefined || payload.observedFileSize === null || validTime(payload.observedFileSize)) &&
      (payload.observedFileAt === undefined || payload.observedFileAt === null || validTime(payload.observedFileAt)) &&
      (payload.observedFileSha256 == null || validTime(payload.observedFileSize) && validTime(payload.observedFileAt)) &&
      optionalTime(payload.startedAt) && optionalTime(payload.finishedAt) && optionalDuration(payload.durationMs)
  }

  if (kind === "turn_context") {
    return validID(payload.messageID) && payload.messageID === value.factKey &&
      ["user", "assistant", "unknown"].includes(String(payload.role)) && optionalID(payload.parentMessageID) &&
      optionalID(payload.routeDecisionID) &&
      (payload.routeSkillName === undefined || payload.routeSkillName === null || validName(payload.routeSkillName)) &&
      optionalDimension(payload.actualAgent) && optionalDimension(payload.actualModel) &&
      optionalEnum(payload.agentBasis, ["sdk_agent_field", "host_metadata", "unknown"]) &&
      optionalEnum(payload.modelBasis, ["sdk_model_field", "host_metadata", "unknown"]) &&
      optionalEnum(payload.routerEligibility, ["eligible", "ineligible", "unknown"]) &&
      optionalEnum(payload.routerExposure, ["suggest", "shadow", "bypass", "none", "unknown"]) &&
      optionalEnum(payload.bypassReason, ["disabled", "shadow", "permission", "invalid", "none", "unknown"]) &&
      (payload.adviceInserted === undefined || payload.adviceInserted === null || typeof payload.adviceInserted === "boolean") &&
      optionalEnum(payload.requestEvidence, ["skill_command", "unknown", "none"]) &&
      validDigestOrNull(payload.configGeneration) && optionalEnum(payload.closureReason, TURN_CLOSURES) &&
      optionalTime(payload.startedAt) && optionalTime(payload.finishedAt) &&
      !(validTime(payload.startedAt) && validTime(payload.finishedAt) &&
        (payload.finishedAt as number) < (payload.startedAt as number))
  }

  if (kind === "task_context") {
    return validID(payload.taskID) && validID(payload.attemptID) &&
      ["started", "done", "failed", "cancelled", "unknown"].includes(String(payload.status)) &&
      !(value.phase === "pending" && payload.status !== "started") && !(value.phase === "terminal" && payload.status === "started") &&
      optionalID(payload.ownerSessionID) && optionalID(payload.childSessionID) && optionalID(payload.childMessageID) && optionalID(payload.messageID) &&
      optionalID(payload.originTaskID) && optionalID(payload.resumeOfAttemptID) && optionalID(payload.workflowID) &&
      validDigestOrNull(payload.planSha256) && optionalEnum(payload.taskKind, ["code", "data", "unknown"]) &&
      optionalEnum(payload.actualRole, TASK_ROLES) && optionalEnum(payload.roleBasis, TASK_ROLE_BASES) &&
      (payload.resumeRequested === undefined || payload.resumeRequested === null || typeof payload.resumeRequested === "boolean") &&
      optionalEnum(payload.taskStatus, ["done", "failed", "cancelled", "open", "unknown"])
  }

  if (kind === "verification_observation") {
    return validID(payload.verificationID) && payload.verificationID === value.factKey &&
      validID(payload.taskID) && validID(payload.attemptID) && typeof payload.codeOwned === "boolean" &&
      ["started", "pass", "fail", "refused", "invalidated", "timed_out", "aborted", "not_run", "unknown"]
        .includes(String(payload.status)) && !(value.phase === "pending" && payload.status !== "started") &&
      !(value.phase === "terminal" && payload.status === "started") && optionalTime(payload.startedAt) &&
      optionalTime(payload.finishedAt) && optionalDuration(payload.durationMs) &&
      (payload.exitCode === undefined || payload.exitCode === null || Number.isSafeInteger(payload.exitCode) &&
        (payload.exitCode as number) >= -255 && (payload.exitCode as number) <= 255) &&
      optionalEnum(payload.taskStatus, ["done", "failed", "cancelled", "open", "unknown"]) &&
      optionalEnum(payload.reviewVerdict, ["accept", "revise", "reject", "skipped", "error", "unknown"])
  }

  return validID(payload.callID) && payload.callID === value.factKey && optionalID(payload.messageID) &&
    validDimension(payload.tool) && payload.tool !== "skill" &&
    ["pending", "completed", "error", "unknown"].includes(String(payload.status)) &&
    !(value.phase === "pending" && payload.status !== "pending") && !(value.phase === "terminal" && payload.status === "pending") &&
    optionalTime(payload.startedAt) && optionalTime(payload.finishedAt) && optionalDuration(payload.durationMs)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}

function semanticFact(fact: EvaluationFact): Record<string, unknown> {
  const payload = fact.payload
  const fields = fact.kind === "skill_call"
    ? ["state", "returnedContent", "requestedName", "requestedNameReason", "returnedName", "returnedNameReason", "nameConflict",
      "messageID", "taskID", "attemptID", "taskRelation", "routeDecisionID", "returnedPayloadSha256", "returnedPayloadBasis",
      "payloadHashReason", "returnedBodySha256", "returnedBodyBasis", "bodyHashReason", "observedFileSha256",
      "observedFileReason", "observedFileSize", "observedFileAt", "observedFileBasis", "startedAt", "finishedAt", "durationMs"]
    : fact.kind === "turn_context"
      ? ["role", "parentMessageID", "actualAgent", "agentBasis", "actualModel", "modelBasis", "configGeneration", "closureReason",
        "routerEligibility", "routerExposure", "bypassReason", "routeDecisionID", "routeSkillName", "adviceInserted", "requestEvidence",
        "startedAt", "finishedAt"]
      : fact.kind === "task_context"
        ? ["taskID", "attemptID", "status", "ownerSessionID", "childSessionID", "childMessageID", "actualRole", "roleBasis", "taskKind", "messageID",
          "originTaskID", "resumeOfAttemptID", "resumeRequested", "taskStatus", "workflowID", "planSha256"]
        : fact.kind === "verification_observation"
          ? ["verificationID", "taskID", "attemptID", "status", "codeOwned", "exitCode", "startedAt", "finishedAt", "durationMs",
            "taskStatus", "reviewVerdict"]
          : ["callID", "messageID", "tool", "status", "startedAt", "finishedAt", "durationMs"]
  return Object.fromEntries(fields.map((key) => [key, payload[key] ?? null]))
}

function factIdentity(fact: EvaluationFact): string {
  return JSON.stringify([fact.kind, fact.sessionID, fact.factKey])
}

function factConflict(fact: EvaluationFact, duplicateConflicts: ReadonlySet<string>): boolean {
  if (fact.conflict || fact.phase === "conflict" || duplicateConflicts.has(factIdentity(fact))) return true
  if (fact.kind !== "skill_call") return false
  const requested = fact.payload.requestedName
  const returned = fact.payload.returnedName
  return fact.payload.nameConflict === true || typeof requested === "string" && typeof returned === "string" && requested !== returned
}

function emptyReasonCounts() {
  return Object.fromEntries(HASH_REASONS.map((reason) => [reason, 0])) as Record<HashReason, number>
}

function addReason(target: { byReason: Record<HashReason, number>; conflicts: number; unknown: number }, reason: unknown): void {
  if (typeof reason === "string" && HASH_REASONS.includes(reason as HashReason)) target.byReason[reason as HashReason]++
  else target.unknown++
}

function emptyDuration() {
  return { samples: 0, missing: 0, invalid: 0, totalMs: 0, meanMs: null as number | null }
}

function addDurationSample(target: ReturnType<typeof emptyDuration>, payload: Record<string, unknown>): void {
  const duration = payload.durationMs
  const startedAt = payload.startedAt
  const finishedAt = payload.finishedAt
  const hasStart = startedAt !== undefined && startedAt !== null
  const hasFinish = finishedAt !== undefined && finishedAt !== null
  if (hasStart && hasFinish &&
      (!validTime(startedAt) || !validTime(finishedAt) || (finishedAt as number) < (startedAt as number) ||
        duration !== undefined && duration !== null && (finishedAt as number) - (startedAt as number) !== duration)) {
    target.invalid++
    return
  }
  if (duration === undefined || duration === null) {
    target.missing++
    return
  }
  if (!Number.isSafeInteger(duration) || (duration as number) < 0 || (duration as number) > MAX_OBSERVED_DURATION_MS) {
    target.invalid++
    return
  }
  target.samples++
  target.totalMs += duration as number
  target.meanMs = target.totalMs / target.samples
}

function hasOrderedInterval(payload: Record<string, unknown>): boolean {
  if (!validTime(payload.startedAt) || !validTime(payload.finishedAt) ||
      (payload.finishedAt as number) < (payload.startedAt as number)) return false
  return payload.durationMs === undefined || payload.durationMs === null ||
    validTime(payload.durationMs) && (payload.finishedAt as number) - (payload.startedAt as number) === payload.durationMs
}

function hasInvalidObservedInterval(payload: Record<string, unknown>): boolean {
  const hasStart = payload.startedAt !== undefined && payload.startedAt !== null
  const hasFinish = payload.finishedAt !== undefined && payload.finishedAt !== null
  if (!hasStart || !hasFinish) return false
  return !validTime(payload.startedAt) || !validTime(payload.finishedAt) ||
    (payload.finishedAt as number) < (payload.startedAt as number) ||
    payload.durationMs !== undefined && payload.durationMs !== null &&
      (!validTime(payload.durationMs) || (payload.finishedAt as number) - (payload.startedAt as number) !== payload.durationMs)
}

function turnKey(sessionID: string, messageID: string): string {
  return JSON.stringify([sessionID, messageID])
}

type TurnRelation = { assistant: EvaluationFact; user: EvaluationFact; userKey: string } | null

function assistantMessage(
  sessionID: string,
  messageID: unknown,
  turnsByID: ReadonlyMap<string, EvaluationFact>,
  duplicateConflicts: ReadonlySet<string>,
): EvaluationFact | null {
  if (!validID(messageID)) return null
  const assistant = turnsByID.get(turnKey(sessionID, messageID))
  return assistant?.payload.role === "assistant" && !factConflict(assistant, duplicateConflicts) ? assistant : null
}

function relatedUserTurn(
  sessionID: string,
  messageID: unknown,
  turnsByID: ReadonlyMap<string, EvaluationFact>,
  duplicateConflicts: ReadonlySet<string>,
): TurnRelation {
  const assistant = assistantMessage(sessionID, messageID, turnsByID, duplicateConflicts)
  if (!assistant || !validID(assistant.payload.parentMessageID)) return null
  const parentID = assistant.payload.parentMessageID
  const user = turnsByID.get(turnKey(sessionID, parentID))
  if (!user || user.payload.role !== "user" || factConflict(user, duplicateConflicts)) return null
  return { assistant, user, userKey: turnKey(sessionID, parentID) }
}

function possibleParentUserKey(sessionID: string, messageID: unknown, turnsByID: ReadonlyMap<string, EvaluationFact>): string | null {
  if (!validID(messageID)) return null
  const assistant = turnsByID.get(turnKey(sessionID, messageID))
  return assistant?.payload.role === "assistant" && validID(assistant.payload.parentMessageID)
    ? turnKey(sessionID, assistant.payload.parentMessageID)
    : null
}

function hasConflictingTurnHistory(
  sessionID: string,
  messageID: unknown,
  turnsByID: ReadonlyMap<string, EvaluationFact>,
  duplicateConflicts: ReadonlySet<string>,
): boolean {
  if (!validID(messageID)) return false
  const assistant = turnsByID.get(turnKey(sessionID, messageID))
  if (!assistant) return false
  if (factConflict(assistant, duplicateConflicts)) return true
  if (!validID(assistant.payload.parentMessageID)) return false
  const user = turnsByID.get(turnKey(sessionID, assistant.payload.parentMessageID))
  return user !== undefined && factConflict(user, duplicateConflicts)
}

function safeCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
}

function namedCount<T extends string>(names: readonly T[]) {
  return Object.fromEntries(names.map((name) => [name, 0])) as Record<T, number>
}

const TASK_STATUSES = ["done", "failed", "cancelled", "open", "unknown", "conflict", "censored"] as const
const LEDGER_TASK_STATUSES = ["done", "failed", "cancelled", "open", "unknown", "conflict"] as const
const VERIFY_STATUSES = [
  "pass", "fail", "refused", "invalidated", "timed_out", "aborted", "not_run", "open", "unknown", "conflict", "excluded", "censored",
] as const

type TaskAttempt = {
  ownerSessionID: string
  taskID: string
  attemptID: string
  records: EvaluationFact[]
  conflict: boolean
  status: (typeof TASK_STATUSES)[number]
  ownerRecords: EvaluationFact[]
  childPromptIDs: Map<string, Set<string>>
  messageIDs: Set<string>
  taskKind: "code" | "data" | "unknown"
  resumeRequested: boolean | null
  taskStatus: "done" | "failed" | "cancelled" | "open" | "unknown" | "conflict"
  codeOwned: boolean
}

function taskAttemptStatus(ownerRecords: readonly EvaluationFact[], conflict: boolean): TaskAttempt["status"] {
  if (conflict) return "conflict"
  if (ownerRecords.length === 0) return "unknown"
  const statuses = new Set(ownerRecords.map((fact) => fact.payload.status as string))
  if (statuses.size !== 1) return "conflict"
  const status = [...statuses][0]
  if (status === "started") return "open"
  if (status === "done" || status === "failed" || status === "cancelled") return status
  return "unknown"
}

function finalOwnerTaskStatus(attempts: readonly TaskAttempt[]): TaskAttempt["status"] {
  if (attempts.some((attempt) => attempt.conflict || attempt.status === "conflict")) return "conflict"
  const statuses = new Set(attempts.map((attempt) => attempt.status))
  if (statuses.size !== 1) return statuses.has("unknown") ? "unknown" : "conflict"
  return [...statuses][0] ?? "unknown"
}

function finalOwnerLedgerTaskStatus(attempts: readonly TaskAttempt[]): TaskAttempt["taskStatus"] {
  const statuses = new Set(attempts.map((attempt) => attempt.taskStatus))
  if (statuses.size !== 1) return statuses.has("unknown") ? "unknown" : "conflict"
  return [...statuses][0] ?? "unknown"
}

type CallDimensions = {
  skillName: string | null
  returnedBodySha256: string | null
  returnedBodyBasis: string | null
  actualRole: string | null
  roleBasis: string | null
  actualModel: string | null
  modelBasis: string | null
  configGeneration: string | null
}

function skillCallName(payload: Record<string, unknown>): string | null {
  if (payload.nameConflict === true) return null
  const requested = validName(payload.requestedName) ? payload.requestedName : null
  const returned = validName(payload.returnedName) ? payload.returnedName : null
  return requested && returned ? requested === returned ? requested : null : returned ?? requested
}

function makeCallDimensions(
  fact: EvaluationFact,
  relation: TurnRelation | null,
  assistantFact: EvaluationFact | null,
  conflict: boolean,
): CallDimensions {
  if (conflict) return {
    skillName: null, returnedBodySha256: null, returnedBodyBasis: null,
    actualRole: null, roleBasis: null, actualModel: null, modelBasis: null, configGeneration: null,
  }
  const payload = fact.payload
  const assistant = assistantFact?.payload
  const assistantGeneration = assistant && typeof assistant.configGeneration === "string" && validDigestOrNull(assistant.configGeneration)
    ? assistant.configGeneration
    : null
  const userGeneration = relation?.user.payload.configGeneration
  const validUserGeneration = typeof userGeneration === "string" && validDigestOrNull(userGeneration) ? userGeneration : null
  const configGeneration = assistantGeneration && validUserGeneration && assistantGeneration !== validUserGeneration
    ? null
    : assistantGeneration ?? validUserGeneration
  return {
    skillName: skillCallName(payload),
    returnedBodySha256: typeof payload.returnedBodySha256 === "string" ? payload.returnedBodySha256 : null,
    returnedBodyBasis: typeof payload.returnedBodyBasis === "string" ? payload.returnedBodyBasis : null,
    actualRole: assistant && validDimension(assistant.actualAgent) ? assistant.actualAgent : null,
    roleBasis: assistant && validDimension(assistant.agentBasis) ? assistant.agentBasis : null,
    actualModel: assistant && validDimension(assistant.actualModel) ? assistant.actualModel : null,
    modelBasis: assistant && validDimension(assistant.modelBasis) ? assistant.modelBasis : null,
    configGeneration,
  }
}

function stratumKey(dimensions: CallDimensions): string {
  return JSON.stringify([
    dimensions.skillName, dimensions.returnedBodySha256, dimensions.returnedBodyBasis,
    dimensions.actualRole, dimensions.roleBasis, dimensions.actualModel, dimensions.modelBasis, dimensions.configGeneration,
  ])
}

type EvaluationOptions = {
  campaignID?: string | null
  durableQuotaCalls?: number | null
  period?: { startAt?: number | null; endAt?: number | null; basis?: string } | null
  notCollectedAfterStop?: boolean
  storedFacts?: number
  unscannedStoredFacts?: number
  expiredFacts?: number
  truncated?: boolean
  unscannedTotal?: "known" | "unknown"
}

/**
 * Deterministic bounded evidence counts. Call, advice, returned text, task, and verification facts
 * remain separate; this function never produces adherence, autonomy, efficacy, or causal scores.
 */
export function summarizeSkillEvaluation(inputFacts: readonly unknown[], coverage: EvaluationOptions = {}) {
  const campaignID = validID(coverage.campaignID) ? coverage.campaignID : null
  const periodStart = coverage.period && validTime(coverage.period.startAt) ? coverage.period.startAt : null
  const suppliedPeriodEnd = coverage.period && validTime(coverage.period.endAt) ? coverage.period.endAt : null
  const periodValid = periodStart === null || suppliedPeriodEnd === null || suppliedPeriodEnd >= periodStart
  const suppliedPeriodBasis = coverage.period?.basis
  const period = {
    startAt: periodStart,
    endAt: periodValid ? suppliedPeriodEnd : null,
    basis: validDimension(suppliedPeriodBasis) ? suppliedPeriodBasis : "not_provided",
  }
  const rateCoverage = {
    storedFacts: safeCount(coverage.storedFacts),
    unscannedStoredFacts: safeCount(coverage.unscannedStoredFacts),
    expiredFacts: safeCount(coverage.expiredFacts),
    truncated: coverage.truncated === true || inputFacts.length > MAX_SUMMARY_FACTS,
    unscannedTotal: coverage.unscannedTotal === "known" ? "known" as const : "unknown" as const,
    notCollectedAfterStop: typeof coverage.notCollectedAfterStop === "boolean" ? coverage.notCollectedAfterStop : null,
  }
  const scopedRatio = (numerator: number, denominator: number, details: RatioDetails = {}): Ratio => ({
    ...ratio(numerator, denominator, details), campaignID, period, coverage: rateCoverage,
  })
  const scannedInput = inputFacts.slice(0, MAX_SUMMARY_FACTS)
  const invalidRows = scannedInput.filter((fact) => !validStoredFact(fact)).length
  const facts = scannedInput.filter(validStoredFact)
  const unique = new Map<string, EvaluationFact>()
  const duplicateConflicts = new Set<string>()
  let duplicateFacts = 0
  for (const fact of facts) {
    const key = factIdentity(fact)
    const prior = unique.get(key)
    if (!prior) unique.set(key, fact)
    else {
      duplicateFacts++
      if (stable(semanticFact(prior)) !== stable(semanticFact(fact)) || prior.phase !== fact.phase || prior.conflict !== fact.conflict) {
        duplicateConflicts.add(key)
      }
    }
  }

  const allUnique = [...unique.values()]
  const turns = allUnique.filter((fact) => fact.kind === "turn_context")
  const turnsByID = new Map(turns.map((fact) => [turnKey(fact.sessionID, fact.factKey), fact]))
  const userTurns = turns.filter((fact) => fact.payload.role === "user")
  const calls = allUnique.filter((fact) => fact.kind === "skill_call")
  const tasks = allUnique.filter((fact) => fact.kind === "task_context")
  const verificationFacts = allUnique.filter((fact) => fact.kind === "verification_observation")
  const toolFacts = allUnique.filter((fact) => fact.kind === "tool_context")
  const notCollectedAfterStop = coverage.notCollectedAfterStop === true

  const requestEvidenceCounts = { skillCommand: 0, none: 0, unknown: 0 }
  const routingExposureCounts = { suggest: 0, shadow: 0, bypass: 0, none: 0, unknown: 0 }
  const triggerCounts = { explicitSkillRequest: 0, adviceInserted: 0, noObservedTrigger: 0, unknown: 0 }
  let completeUserTurns = 0
  let censoredUserTurns = 0
  let conflictingAdviceUserTurns = 0
  const adviceExposures = new Map<string, { skill: string; routeDecisionID: string; routeKey: string; complete: boolean }>()
  const routeDecisionOwners = new Map<string, string>()
  const conflictingAdviceRoutes = new Set<string>()
  let unknownAdviceExposures = 0
  let conflictingAdviceExposures = 0
  for (const fact of userTurns) {
    const conflicting = factConflict(fact, duplicateConflicts)
    if (conflicting) {
      if (fact.payload.routerExposure === "suggest" && fact.payload.adviceInserted === true) conflictingAdviceUserTurns++
      continue
    }
    const payload = fact.payload
    if (payload.requestEvidence === "skill_command") requestEvidenceCounts.skillCommand++
    else if (payload.requestEvidence === "none") requestEvidenceCounts.none++
    else requestEvidenceCounts.unknown++
    const exposure = payload.routerExposure
    if (exposure === "suggest" || exposure === "shadow" || exposure === "bypass" || exposure === "none") routingExposureCounts[exposure]++
    else routingExposureCounts.unknown++

    const isComplete = fact.phase === "terminal" && payload.closureReason === "completed"
    if (isComplete) completeUserTurns++
    else censoredUserTurns++
    const hasAdvice = payload.routerExposure === "suggest" && payload.adviceInserted === true
    if (payload.requestEvidence === "skill_command") triggerCounts.explicitSkillRequest++
    if (hasAdvice) triggerCounts.adviceInserted++
    if (payload.requestEvidence === "none" && payload.adviceInserted !== true) triggerCounts.noObservedTrigger++
    if (payload.requestEvidence === "unknown" || payload.adviceInserted === true && !validID(payload.routeDecisionID)) triggerCounts.unknown++

    if (!hasAdvice) continue
    if (!validID(payload.routeDecisionID) || !validName(payload.routeSkillName)) {
      unknownAdviceExposures++
      continue
    }
    const key = turnKey(fact.sessionID, fact.factKey)
    const routeKey = JSON.stringify([fact.sessionID, payload.routeDecisionID])
    const priorOwner = routeDecisionOwners.get(routeKey)
    if (priorOwner && priorOwner !== key) conflictingAdviceRoutes.add(routeKey)
    else routeDecisionOwners.set(routeKey, key)
    adviceExposures.set(key, { skill: payload.routeSkillName, routeDecisionID: payload.routeDecisionID, routeKey, complete: isComplete })
  }
  for (const [key, exposure] of adviceExposures) {
    if (!conflictingAdviceRoutes.has(exposure.routeKey)) continue
    adviceExposures.delete(key)
    conflictingAdviceExposures++
  }

  let completedCalls = 0
  let errorCalls = 0
  let unresolvedCalls = 0
  let conflictCalls = 0
  let censoredCalls = 0
  let observedContent = 0
  let notReturnedContent = 0
  let unknownContent = 0
  let invalidCallTimestamps = 0
  let payloadCovered = 0
  let bodyCovered = 0
  let fileCovered = 0
  const payloadReasons = { byReason: emptyReasonCounts(), conflicts: 0, unknown: 0 }
  const bodyReasons = { byReason: emptyReasonCounts(), conflicts: 0, unknown: 0 }
  const fileReasons = { byReason: emptyReasonCounts(), conflicts: 0, unknown: 0 }
  const callDurations = emptyDuration()
  const callRelations = new Map<string, TurnRelation | null>()
  const callConflicts = new Map<string, boolean>()
  const callTriggerCounts = { explicitSkillRequest: 0, adviceInserted: 0, noObservedTrigger: 0, unknown: 0 }
  let sameTurnSkillCalls = 0
  let callsWithAdvice = 0
  let unknownCallAncestry = 0
  let conflictingCallAncestry = 0
  const callStrata = new Map<string, {
    key: string
    dimensions: CallDimensions
    includedUniqueCalls: number
    completedToolCalls: number
    errorOrAbortedToolCalls: number
    unresolvedCalls: number
    conflicts: number
    censoredCalls: number
    unknownBodyFingerprintReasons: number
  }>()

  for (const fact of calls) {
    const identity = factIdentity(fact)
    const payload = fact.payload
    const conflict = factConflict(fact, duplicateConflicts)
    callConflicts.set(identity, conflict)
    const assistant = conflict ? null : assistantMessage(fact.sessionID, payload.messageID, turnsByID, duplicateConflicts)
    const relation = conflict ? null : relatedUserTurn(fact.sessionID, payload.messageID, turnsByID, duplicateConflicts)
    callRelations.set(identity, relation)
    if (conflict) conflictCalls++
    else if (payload.state === "completed") completedCalls++
    else if (payload.state === "error" || payload.state === "aborted") errorCalls++
    else unresolvedCalls++
    if (!conflict && hasInvalidObservedInterval(payload)) invalidCallTimestamps++
    if (!conflict && (payload.state === "pending" || fact.phase === "pending") && notCollectedAfterStop) censoredCalls++

    if (conflict) unknownContent++
    else if (payload.returnedContent === "observed") observedContent++
    else if (payload.returnedContent === "not_returned") notReturnedContent++
    else unknownContent++

    if (!conflict && payload.state === "completed") {
      if (typeof payload.returnedPayloadSha256 === "string" && typeof payload.returnedPayloadBasis === "string") payloadCovered++
      else addReason(payloadReasons, payload.payloadHashReason)
      if (typeof payload.returnedBodySha256 === "string" && typeof payload.returnedBodyBasis === "string") bodyCovered++
      else addReason(bodyReasons, payload.bodyHashReason)
      if (typeof payload.observedFileSha256 === "string" && payload.observedFileBasis === OBSERVED_FILE_BASIS) fileCovered++
      else addReason(fileReasons, payload.observedFileReason)
      addDurationSample(callDurations, payload)
    } else if (conflict) {
      payloadReasons.conflicts++
      bodyReasons.conflicts++
      fileReasons.conflicts++
    } else if (payload.state !== "pending") {
      addDurationSample(callDurations, payload)
    }

    if (conflict) {
      conflictingCallAncestry++
      callTriggerCounts.unknown++
    } else if (!relation) {
      if (hasConflictingTurnHistory(fact.sessionID, payload.messageID, turnsByID, duplicateConflicts)) conflictingCallAncestry++
      else unknownCallAncestry++
      callTriggerCounts.unknown++
    }
    else {
      sameTurnSkillCalls++
      const advice = adviceExposures.get(relation.userKey)
      if (advice && advice.skill === skillCallName(payload)) {
        callsWithAdvice++
        callTriggerCounts.adviceInserted++
      }
      if (relation.user.payload.requestEvidence === "skill_command") callTriggerCounts.explicitSkillRequest++
      if (relation.user.payload.requestEvidence === "none" && relation.user.payload.adviceInserted !== true) {
        callTriggerCounts.noObservedTrigger++
      }
      if (relation.user.payload.requestEvidence === "unknown" ||
          relation.user.payload.adviceInserted === true && !validID(relation.user.payload.routeDecisionID)) callTriggerCounts.unknown++
    }

    const dimensions = makeCallDimensions(fact, relation, assistant, conflict)
    const key = stratumKey(dimensions)
    let stratum = callStrata.get(key)
    if (!stratum) {
      stratum = {
        key, dimensions, includedUniqueCalls: 0, completedToolCalls: 0, errorOrAbortedToolCalls: 0,
        unresolvedCalls: 0, conflicts: 0, censoredCalls: 0, unknownBodyFingerprintReasons: 0,
      }
      callStrata.set(key, stratum)
    }
    stratum.includedUniqueCalls++
    if (conflict) stratum.conflicts++
    else if (payload.state === "completed") stratum.completedToolCalls++
    else if (payload.state === "error" || payload.state === "aborted") stratum.errorOrAbortedToolCalls++
    else stratum.unresolvedCalls++
    if (!conflict && payload.state === "completed" && typeof payload.returnedBodySha256 !== "string" &&
        !(typeof payload.bodyHashReason === "string" && HASH_REASONS.includes(payload.bodyHashReason as HashReason))) {
      stratum.unknownBodyFingerprintReasons++
    }
    if (!conflict && (payload.state === "pending" || fact.phase === "pending") && notCollectedAfterStop) stratum.censoredCalls++
  }

  const callConflictsExcludedFromDenominator = conflictCalls + errorCalls + unresolvedCalls
  const fingerprintRatio = (covered: number, reasonCounts: { byReason: Record<HashReason, number>; unknown: number }) =>
    scopedRatio(covered, completedCalls, {
      unknown: reasonCounts.unknown,
      excluded: callConflictsExcludedFromDenominator,
      censored: censoredCalls,
    })

  const taskAttemptsByID = new Map<string, EvaluationFact[]>()
  for (const fact of tasks) {
    const ownerSessionID = validID(fact.payload.ownerSessionID) ? fact.payload.ownerSessionID : fact.sessionID
    const key = JSON.stringify([ownerSessionID, fact.payload.taskID, fact.payload.attemptID])
    const records = taskAttemptsByID.get(key) ?? []
    records.push(fact)
    taskAttemptsByID.set(key, records)
  }
  const attempts: TaskAttempt[] = []
  for (const records of taskAttemptsByID.values()) {
    const payload = records[0].payload
    const ownerSessionID = validID(payload.ownerSessionID) ? payload.ownerSessionID : records[0].sessionID
    const ownerRecords = records.filter((fact) => fact.sessionID === ownerSessionID)
    let conflict = ownerRecords.some((fact) => factConflict(fact, duplicateConflicts))
    const ownerStatuses = new Set(ownerRecords.map((fact) => fact.payload.status))
    const ownerMessageIDs = new Set(ownerRecords.flatMap((fact) => validID(fact.payload.messageID) ? [fact.payload.messageID] : []))
    const ownerTaskKinds = new Set(ownerRecords.flatMap((fact) =>
      fact.payload.taskKind === "code" || fact.payload.taskKind === "data" ? [fact.payload.taskKind] : []))
    const ownerLedgerTaskStatuses = new Set(ownerRecords.map((fact) =>
      fact.payload.taskStatus === "done" || fact.payload.taskStatus === "failed" || fact.payload.taskStatus === "cancelled" ||
          fact.payload.taskStatus === "open"
        ? fact.payload.taskStatus
        : "unknown"))
    const ownerResumeValues = new Set(ownerRecords.flatMap((fact) =>
      typeof fact.payload.resumeRequested === "boolean" ? [fact.payload.resumeRequested] : []))
    if (ownerStatuses.size > 1 || ownerMessageIDs.size > 1 || ownerTaskKinds.size > 1 || ownerResumeValues.size > 1) conflict = true
    const childPromptIDs = new Map<string, Set<string>>()
    for (const fact of records) {
      if (factConflict(fact, duplicateConflicts)) continue
      const childSessionID = fact.payload.childSessionID
      const childMessageID = fact.payload.childMessageID
      if (!validID(childSessionID) || fact.sessionID !== childSessionID || !validID(childMessageID) ||
          fact.payload.ownerSessionID !== ownerSessionID) continue
      const prompts = childPromptIDs.get(childSessionID) ?? new Set<string>()
      prompts.add(childMessageID)
      childPromptIDs.set(childSessionID, prompts)
    }
    const messageIDs = new Set(ownerRecords.flatMap((fact) => validID(fact.payload.messageID) ? [fact.payload.messageID] : []))
    const taskKindSource = ownerRecords.length > 0 ? ownerRecords : records
    const taskKinds = new Set(taskKindSource.flatMap((fact) =>
      fact.payload.taskKind === "code" || fact.payload.taskKind === "data" ? [fact.payload.taskKind] : []))
    const taskKind = taskKinds.size === 1 ? [...taskKinds][0] as "code" | "data" : "unknown"
    attempts.push({
      ownerSessionID,
      taskID: payload.taskID as string,
      attemptID: payload.attemptID as string,
      records,
      conflict,
      status: taskAttemptStatus(ownerRecords, conflict),
      ownerRecords,
      childPromptIDs,
      messageIDs,
      taskKind,
      resumeRequested: ownerResumeValues.size === 1 ? [...ownerResumeValues][0] ?? null : null,
      taskStatus: ownerRecords.length === 0 ? "unknown" : ownerLedgerTaskStatuses.size === 1
        ? [...ownerLedgerTaskStatuses][0] ?? "unknown"
        : ownerLedgerTaskStatuses.has("unknown") ? "unknown" : "conflict",
      codeOwned: ownerRecords.length > 0 && !conflict && taskKind === "code",
    })
  }
  const taskAttemptStatuses = namedCount(TASK_STATUSES)
  const taskKindCounts = { code: 0, data: 0, unknown: 0 }
  const resumeRequestedCounts = { yes: 0, no: 0, unknown: 0 }
  const attemptLedgerTaskStatuses = namedCount(LEDGER_TASK_STATUSES)
  const taskRoleCounts = { main: 0, worker: 0, reviewer: 0, "data-analyst": 0, "data-verifier": 0, unknown: 0 }
  const childActorFactCount = tasks.filter((fact) => validID(fact.payload.ownerSessionID) &&
    fact.sessionID !== fact.payload.ownerSessionID).length
  for (const attempt of attempts) {
    taskAttemptStatuses[attempt.status]++
    taskKindCounts[attempt.taskKind]++
    attemptLedgerTaskStatuses[attempt.taskStatus]++
    if (attempt.resumeRequested === true) resumeRequestedCounts.yes++
    else if (attempt.resumeRequested === false) resumeRequestedCounts.no++
    else resumeRequestedCounts.unknown++
    if (attempt.status === "open" && notCollectedAfterStop) taskAttemptStatuses.censored++
  }
  for (const fact of tasks) {
    const role = TASK_ROLES.includes(fact.payload.actualRole as (typeof TASK_ROLES)[number]) && fact.payload.actualRole !== "unknown"
      ? fact.payload.actualRole as keyof typeof taskRoleCounts
      : "unknown"
    taskRoleCounts[role]++
  }
  const ownerTaskAttempts = new Map<string, TaskAttempt[]>()
  let taskAttemptsWithoutOwnerFact = 0
  for (const attempt of attempts) {
    if (attempt.ownerRecords.length === 0) {
      taskAttemptsWithoutOwnerFact++
      continue
    }
    const ownerTaskKey = JSON.stringify([attempt.ownerSessionID, attempt.taskID])
    const taskAttempts = ownerTaskAttempts.get(ownerTaskKey) ?? []
    taskAttempts.push(attempt)
    ownerTaskAttempts.set(ownerTaskKey, taskAttempts)
  }
  const ownerTaskStatuses = namedCount(TASK_STATUSES)
  const ownerLedgerTaskStatuses = namedCount(LEDGER_TASK_STATUSES)
  for (const ownerAttempts of ownerTaskAttempts.values()) {
    const status = finalOwnerTaskStatus(ownerAttempts)
    ownerTaskStatuses[status]++
    ownerLedgerTaskStatuses[finalOwnerLedgerTaskStatus(ownerAttempts)]++
    if (status === "open" && notCollectedAfterStop) ownerTaskStatuses.censored++
  }

  let exactWorkerTaskAttemptLinks = 0
  let callsWithWorkerTaskLink = 0
  let orchestratorContextLinks = 0
  let workerTaskCandidates = 0
  let workerTaskUnknown = 0
  let unknownWorkerRoleCalls = 0
  const codeOwnedAttemptsByChildPrompt = new Map<string, TaskAttempt[]>()
  const codeOwnedAttemptsByOwnerTurn = new Map<string, TaskAttempt[]>()
  for (const attempt of attempts) {
    if (attempt.conflict || !attempt.codeOwned) continue
    for (const [childSessionID, childMessageIDs] of attempt.childPromptIDs) {
      if (childMessageIDs.size !== 1) continue
      const childMessageID = [...childMessageIDs][0]
      const key = turnKey(childSessionID, childMessageID)
      const matches = codeOwnedAttemptsByChildPrompt.get(key) ?? []
      matches.push(attempt)
      codeOwnedAttemptsByChildPrompt.set(key, matches)
    }
    for (const messageID of attempt.messageIDs) {
      const relation = relatedUserTurn(attempt.ownerSessionID, messageID, turnsByID, duplicateConflicts)
      if (!relation) continue
      const matches = codeOwnedAttemptsByOwnerTurn.get(relation.userKey) ?? []
      if (!matches.includes(attempt)) matches.push(attempt)
      codeOwnedAttemptsByOwnerTurn.set(relation.userKey, matches)
    }
  }
  for (const fact of calls) {
    if (callConflicts.get(factIdentity(fact))) continue
    const relation = callRelations.get(factIdentity(fact)) ?? null
    const assistant = assistantMessage(fact.sessionID, fact.payload.messageID, turnsByID, duplicateConflicts)
    const role = assistant && validDimension(assistant.payload.actualAgent) ? assistant.payload.actualAgent : null
    const isWorker = role === "worker" || role === "reviewer" || role === "data-analyst" || role === "data-verifier"
    if (!isWorker && (role === null || role === "unknown")) unknownWorkerRoleCalls++
    if (isWorker) {
      workerTaskCandidates++
      const promptID = assistant?.payload.parentMessageID
      const matching = validID(promptID) ? codeOwnedAttemptsByChildPrompt.get(turnKey(fact.sessionID, promptID)) ?? [] : []
      if (matching.length === 1) {
        callsWithWorkerTaskLink++
        exactWorkerTaskAttemptLinks++
      } else workerTaskUnknown++
    }
    if (!relation || role !== "main") continue
    const matchingOwnerTasks = codeOwnedAttemptsByOwnerTurn.get(relation.userKey) ?? []
    orchestratorContextLinks += matchingOwnerTasks.length
  }

  const verificationStatuses = namedCount(VERIFY_STATUSES)
  const verificationDurations = emptyDuration()
  let verifiedExitZero = 0
  let verifiedExitDenominator = 0
  let verificationUnknownExit = 0
  let verificationInvalidTimestamps = 0
  const verificationReviewVerdicts = { accept: 0, revise: 0, reject: 0, skipped: 0, error: 0, unknown: 0 }
  const verificationTaskStatuses = { done: 0, failed: 0, cancelled: 0, open: 0, unknown: 0 }
  for (const fact of verificationFacts) {
    const payload = fact.payload
    if (factConflict(fact, duplicateConflicts)) {
      verificationStatuses.conflict++
      continue
    }
    const status = payload.status
    const durationBefore = verificationDurations.invalid
    addDurationSample(verificationDurations, payload)
    const timestampConflict = hasInvalidObservedInterval(payload)
    if (timestampConflict) {
      verificationStatuses.conflict++
      verificationInvalidTimestamps++
      continue
    }
    if (verificationDurations.invalid > durationBefore) verificationInvalidTimestamps++
    const review = payload.reviewVerdict
    if (review === "accept" || review === "revise" || review === "reject" || review === "skipped" || review === "error") {
      verificationReviewVerdicts[review]++
    }
    else verificationReviewVerdicts.unknown++
    const taskStatus = payload.taskStatus
    if (taskStatus === "done" || taskStatus === "failed" || taskStatus === "cancelled" || taskStatus === "open") {
      verificationTaskStatuses[taskStatus]++
    } else verificationTaskStatuses.unknown++
    if (status === "started" || fact.phase === "pending") {
      verificationStatuses.open++
      if (notCollectedAfterStop) verificationStatuses.censored++
      continue
    }
    if (status === "pass" || status === "fail") {
      if (payload.codeOwned !== true || !Number.isSafeInteger(payload.exitCode)) {
        verificationStatuses.excluded++
        verificationUnknownExit++
        continue
      }
      const exitCode = payload.exitCode as number
      if (status === "pass" && exitCode !== 0 || status === "fail" && exitCode === 0) {
        verificationStatuses.conflict++
        continue
      }
      verificationStatuses[status]++
      verifiedExitDenominator++
      if (status === "pass" && exitCode === 0) verifiedExitZero++
    } else if (status === "refused" || status === "invalidated" || status === "timed_out" ||
        status === "aborted" || status === "not_run") verificationStatuses[status]++
    else verificationStatuses.unknown++
  }

  const adviceCallCounts = new Map<string, number>()
  const conflictingCallAdviceTurns = new Set<string>()
  for (const fact of calls) {
    const conflict = callConflicts.get(factIdentity(fact)) === true
    const relation = callRelations.get(factIdentity(fact))
    if (conflict || !relation && hasConflictingTurnHistory(fact.sessionID, fact.payload.messageID, turnsByID, duplicateConflicts)) {
      const userKey = relation?.userKey ?? possibleParentUserKey(fact.sessionID, fact.payload.messageID, turnsByID)
      const advice = userKey ? adviceExposures.get(userKey) : undefined
      const names = [fact.payload.requestedName, fact.payload.returnedName]
      if (userKey && advice && names.some((name) => validName(name) && name === advice.skill)) conflictingCallAdviceTurns.add(userKey)
      continue
    }
    if (!relation) continue
    const advice = adviceExposures.get(relation.userKey)
    if (advice && advice.skill === skillCallName(fact.payload)) {
      adviceCallCounts.set(relation.userKey, (adviceCallCounts.get(relation.userKey) ?? 0) + 1)
    }
  }
  for (const key of conflictingCallAdviceTurns) {
    if ((adviceCallCounts.get(key) ?? 0) > 0 || !adviceExposures.delete(key)) continue
    conflictingAdviceExposures++
  }
  let completeAdviceExposures = 0
  let adviceFollowThrough = 0
  let censoredAdviceExposures = 0
  for (const [key, advice] of adviceExposures) {
    if (advice.complete) {
      completeAdviceExposures++
      if ((adviceCallCounts.get(key) ?? 0) > 0) adviceFollowThrough++
    } else censoredAdviceExposures++
  }

  const toolStatusCounts = { completed: 0, error: 0, pending: 0, unknown: 0, conflict: 0, censored: 0 }
  const toolDurations = emptyDuration()
  const sameTurnRelations = new Set<string>()
  const afterLoadSameTurnRelations = new Set<string>()
  const sameTurnToolIDs = new Set<string>()
  const afterLoadToolIDs = new Set<string>()
  const toolCounts = new Map<string, { sameTurnRelations: number; afterLoadSameTurnRelations: number; durations: ReturnType<typeof emptyDuration> }>()
  const callsByUserTurn = new Map<string, EvaluationFact[]>()
  const toolsByUserTurn = new Map<string, EvaluationFact[]>()
  let unknownToolAncestry = 0
  let conflictingToolAncestry = 0
  let invalidToolTimestamps = 0
  for (const tool of toolFacts) {
    const identity = factIdentity(tool)
    const conflicting = factConflict(tool, duplicateConflicts)
    if (conflicting) toolStatusCounts.conflict++
    else if (tool.payload.status === "completed") toolStatusCounts.completed++
    else if (tool.payload.status === "error") toolStatusCounts.error++
    else if (tool.payload.status === "pending") {
      toolStatusCounts.pending++
      if (notCollectedAfterStop) toolStatusCounts.censored++
    } else toolStatusCounts.unknown++
    if (conflicting) continue
    if (hasInvalidObservedInterval(tool.payload)) invalidToolTimestamps++
    addDurationSample(toolDurations, tool.payload)
    const toolName = tool.payload.tool as string
    let perTool = toolCounts.get(toolName)
    if (!perTool) {
      perTool = { sameTurnRelations: 0, afterLoadSameTurnRelations: 0, durations: emptyDuration() }
      toolCounts.set(toolName, perTool)
    }
    addDurationSample(perTool.durations, tool.payload)
    const toolTurn = relatedUserTurn(tool.sessionID, tool.payload.messageID, turnsByID, duplicateConflicts)
    if (!toolTurn) {
      if (hasConflictingTurnHistory(tool.sessionID, tool.payload.messageID, turnsByID, duplicateConflicts)) conflictingToolAncestry++
      else unknownToolAncestry++
      continue
    }
    const relatedTools = toolsByUserTurn.get(toolTurn.userKey) ?? []
    relatedTools.push(tool)
    toolsByUserTurn.set(toolTurn.userKey, relatedTools)
  }
  for (const call of calls) {
    if (callConflicts.get(factIdentity(call))) continue
    const callTurn = callRelations.get(factIdentity(call))
    if (!callTurn) continue
    const relatedCalls = callsByUserTurn.get(callTurn.userKey) ?? []
    relatedCalls.push(call)
    callsByUserTurn.set(callTurn.userKey, relatedCalls)
  }
  let possibleSameTurnRelations = 0
  for (const [userKey, relatedTools] of toolsByUserTurn) {
    possibleSameTurnRelations += relatedTools.length * (callsByUserTurn.get(userKey)?.length ?? 0)
  }
  let scannedSameTurnRelations = 0
  const sortedToolTurns = [...toolsByUserTurn.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  relationScan: for (const [userKey, relatedTools] of sortedToolTurns) {
    const relatedCalls = callsByUserTurn.get(userKey) ?? []
    relatedTools.sort((left, right) => factIdentity(left) < factIdentity(right) ? -1 : factIdentity(left) > factIdentity(right) ? 1 : 0)
    relatedCalls.sort((left, right) => factIdentity(left) < factIdentity(right) ? -1 : factIdentity(left) > factIdentity(right) ? 1 : 0)
    for (const tool of relatedTools) {
      for (const call of relatedCalls) {
        if (scannedSameTurnRelations >= MAX_SUMMARY_RELATIONS) break relationScan
        scannedSameTurnRelations++
        const identity = factIdentity(tool)
        const toolName = tool.payload.tool as string
        const perTool = toolCounts.get(toolName)!
        const relationID = JSON.stringify([factIdentity(call), identity])
        sameTurnRelations.add(relationID)
        sameTurnToolIDs.add(identity)
        perTool.sameTurnRelations++
        const callPayload = call.payload
        if (callPayload.state !== "completed" || !hasOrderedInterval(callPayload) || !hasOrderedInterval(tool.payload) ||
            (tool.payload.startedAt as number) <= (callPayload.finishedAt as number)) continue
        afterLoadSameTurnRelations.add(relationID)
        afterLoadToolIDs.add(identity)
        perTool.afterLoadSameTurnRelations++
      }
    }
  }
  const unscannedSameTurnRelations = Math.max(0, possibleSameTurnRelations - scannedSameTurnRelations)

  const strata = [...callStrata.values()].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0).map((stratum) => {
    const denominator = stratum.completedToolCalls
    const hasBodyHash = stratum.dimensions.returnedBodySha256 !== null && stratum.dimensions.returnedBodyBasis !== null
    return {
      skillName: stratum.dimensions.skillName,
      returnedBodySha256: stratum.dimensions.returnedBodySha256,
      returnedBodyBasis: stratum.dimensions.returnedBodyBasis,
      actualRole: stratum.dimensions.actualRole,
      roleBasis: stratum.dimensions.roleBasis,
      actualModel: stratum.dimensions.actualModel,
      modelBasis: stratum.dimensions.modelBasis,
      configGeneration: stratum.dimensions.configGeneration,
      includedUniqueCalls: stratum.includedUniqueCalls,
      completedToolCalls: stratum.completedToolCalls,
      errorOrAbortedToolCalls: stratum.errorOrAbortedToolCalls,
      unresolvedCalls: stratum.unresolvedCalls,
      conflicts: stratum.conflicts,
      censoredCalls: stratum.censoredCalls,
      returnedBodyFingerprint: scopedRatio(hasBodyHash ? denominator : 0, denominator, {
        unknown: stratum.unknownBodyFingerprintReasons,
        excluded: stratum.includedUniqueCalls - denominator - stratum.conflicts,
        censored: stratum.censoredCalls,
      }),
    }
  })

  const workerLinkRatio = scopedRatio(callsWithWorkerTaskLink, workerTaskCandidates, {
    unknown: workerTaskUnknown + unknownWorkerRoleCalls,
    excluded: calls.length - conflictCalls - workerTaskCandidates - unknownWorkerRoleCalls,
    censored: notCollectedAfterStop ? calls.filter((fact) => !callConflicts.get(factIdentity(fact)) &&
      (fact.payload.state === "pending" || fact.phase === "pending")).length : 0,
  })
  const verifiedExitRatio = scopedRatio(verifiedExitZero, verifiedExitDenominator, {
    unknown: verificationUnknownExit + verificationStatuses.unknown,
    excluded: verificationStatuses.excluded + verificationStatuses.invalidated + verificationStatuses.refused +
      verificationStatuses.not_run + verificationStatuses.timed_out + verificationStatuses.aborted + verificationStatuses.conflict,
    censored: verificationStatuses.censored,
  })

  const durableQuotaCalls = safeCount(coverage.durableQuotaCalls)
  const unrepresentedDurableQuotaCalls = durableQuotaCalls !== null && durableQuotaCalls >= calls.length
    ? durableQuotaCalls - calls.length
    : null

  return {
    scope: {
      campaignID,
      period,
    },
    calls: {
      includedUniqueCalls: calls.length,
      durableQuotaCalls,
      unrepresentedDurableQuotaCalls,
      durableQuotaCountConflict: durableQuotaCalls === null ? null : calls.length > durableQuotaCalls,
      completedToolCalls: completedCalls,
      errorOrAbortedToolCalls: errorCalls,
      unresolvedCalls,
      conflicts: conflictCalls,
      invalidTimestampCount: invalidCallTimestamps,
      censoredUnresolvedCalls: censoredCalls,
      returnedContent: { observed: observedContent, notReturned: notReturnedContent, unknown: unknownContent },
      duration: callDurations,
      stateCoverage: scopedRatio(completedCalls + errorCalls, calls.length, {
        unknown: unresolvedCalls,
        excluded: conflictCalls,
        censored: censoredCalls,
      }),
    },
    fingerprints: {
      terminalPayload: {
        ...fingerprintRatio(payloadCovered, payloadReasons), basisSeparated: true, reasons: payloadReasons,
      },
      returnedBody: {
        ...fingerprintRatio(bodyCovered, bodyReasons), basisSeparated: true, reasons: bodyReasons,
      },
      currentProjectFile: {
        ...fingerprintRatio(fileCovered, fileReasons), basisSeparated: true, reasons: fileReasons,
      },
      loadedOriginalFileAvailable: false,
    },
    unsupportedMetrics: [
      "confirmed_autonomy: absence of observed request/advice evidence is not proof of autonomy",
      "procedure_adherence: returned skill text does not prove reading or following it",
      "causal_effectiveness: observational associations do not estimate causal impact",
      "loaded_original_file_sha256: the host provides no authoritative original-loaded-bytes receipt",
    ],
    strata,
    advice: {
      exactExposures: adviceExposures.size,
      exposuresWithSameTurnSkillCall: adviceFollowThrough,
      followThrough: scopedRatio(adviceFollowThrough, completeAdviceExposures, {
        unknown: unknownAdviceExposures,
        excluded: conflictingAdviceUserTurns + conflictingAdviceExposures,
        censored: censoredAdviceExposures,
      }),
      censoredExposures: censoredAdviceExposures,
      unknownExposures: unknownAdviceExposures,
      conflictingExposures: conflictingAdviceExposures,
      callsJoinedToAdvice: callsWithAdvice,
      sameTurnSkillCalls,
      callAncestry: { unknown: unknownCallAncestry, conflicts: conflictingCallAncestry },
      callTriggerCounts,
      requestEvidenceCounts,
      routingExposureCounts,
      turnTriggerCounts: triggerCounts,
      completeUserTurns,
      censoredUserTurns,
      confirmedAutonomyRate: null,
      causalClaim: false,
      adherenceClaim: false,
    },
    taskAttribution: {
      exactWorkerTaskAttemptLinks,
      callsWithExactWorkerTaskLinks: callsWithWorkerTaskLink,
      workerTaskAttemptLinkRate: workerLinkRatio,
      orchestratorContextLinks,
      attempts: {
        total: attempts.length,
        statuses: taskAttemptStatuses,
        taskKinds: taskKindCounts,
        resumeRequested: resumeRequestedCounts,
        ledgerTaskStatuses: attemptLedgerTaskStatuses,
        actualRolesByFact: taskRoleCounts,
      },
      finalOwnerTasks: {
        total: ownerTaskAttempts.size,
        statuses: ownerTaskStatuses,
        ledgerTaskStatuses: ownerLedgerTaskStatuses,
        childActorFactsExcludedFromTaskTotal: childActorFactCount,
        excludedTaskAttemptsWithoutOwnerFact: taskAttemptsWithoutOwnerFact,
      },
    },
    verification: {
      statuses: verificationStatuses,
      exitZero: verifiedExitRatio,
      durations: verificationDurations,
      invalidTimestampCount: verificationInvalidTimestamps,
      reviewVerdicts: verificationReviewVerdicts,
      taskStatuses: verificationTaskStatuses,
    },
    relatedTools: {
      includedUniqueCalls: toolFacts.length,
      statuses: toolStatusCounts,
      sameTurn: {
        uniqueToolCalls: sameTurnToolIDs.size, relations: sameTurnRelations.size,
        unscannedRelations: unscannedSameTurnRelations,
        truncated: unscannedSameTurnRelations > 0,
      },
      afterLoadSameTurn: {
        uniqueToolCalls: afterLoadToolIDs.size, relations: afterLoadSameTurnRelations.size,
        unscannedRelations: unscannedSameTurnRelations,
        truncated: unscannedSameTurnRelations > 0,
      },
      unknownTurnAncestry: unknownToolAncestry,
      conflictingTurnAncestry: conflictingToolAncestry,
      invalidTimestampCount: invalidToolTimestamps,
      durations: toolDurations,
      byTool: Object.fromEntries([...toolCounts.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([name, value]) => [name, value])),
    },
    coverage: {
      returnedFacts: inputFacts.length,
      acceptedFacts: unique.size,
      invalidRows,
      duplicateFacts,
      duplicateConflictIdentities: duplicateConflicts.size,
      storedFacts: safeCount(coverage.storedFacts),
      unscannedStoredFacts: safeCount(coverage.unscannedStoredFacts),
      evaluatorUnscannedFacts: Math.max(0, inputFacts.length - scannedInput.length),
      unscannedSameTurnRelations,
      relationsTruncated: unscannedSameTurnRelations > 0,
      expiredFacts: safeCount(coverage.expiredFacts),
      truncated: coverage.truncated === true || inputFacts.length > scannedInput.length,
      unscannedTotal: coverage.unscannedTotal === "known" ? "known" : "unknown",
      notCollectedAfterStop: typeof coverage.notCollectedAfterStop === "boolean" ? coverage.notCollectedAfterStop : null,
      durableQuotaCalls,
      populationComplete: false,
      unobservedPopulation: "unknown" as const,
    },
  }
}
