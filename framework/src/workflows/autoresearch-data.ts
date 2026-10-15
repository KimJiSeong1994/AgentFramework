// Autoresearch persisted data (P6b S3). A leaf module (types + strict parser, no registry or engine imports) so the
// registry can validate a committed autoresearch envelope without an import cycle. `data` is never authority on its own:
// every run names a hash-recorded runs/<attempt>.json and a verification receipt, the approved experiment names a typed
// RUN receipt, and all of it is re-read from disk before a verdict is written or a terminal state is committed.
import type { ArtifactRef, Subject } from "./types.ts"
import { parseArtifacts, parseInput, type UgInput } from "./ultragoal-data.ts"

/** Automatic iterations (experiment_prepare -> evaluate cycles) before the cap caveat and no further prepare (ARS:107). */
export const AR_MAX_ITERATIONS = 10
export const AR_MAX_ATTEMPTS = 2
export const AR_MAX_COMMANDS = 8
export const AR_RUN_STATUSES = ["baseline", "keep", "discard", "crash", "checks_failed"] as const
export type ArRunStatus = (typeof AR_RUN_STATUSES)[number]
export const AR_INVALID_REASONS = ["interrupted", "integrity", "suspect", "refused", "truncated", "unsettled"] as const
export type ArInvalidReason = (typeof AR_INVALID_REASONS)[number]
export const AR_STUCK_KINDS = ["attempts", "runner", "inconclusive"] as const
export type ArStuckKind = (typeof AR_STUCK_KINDS)[number]
export const AR_DIRECTIONS = ["max", "min"] as const
export type ArDirection = (typeof AR_DIRECTIONS)[number]

export type ArMetric = { name: string; direction: ArDirection }
export type ArMission = { path: string; sha256: string; metric: ArMetric }
export type ArEvidenceRef = { path: string; sha256: string; verified: number; unverified: number }
export type ArRun = {
  attempt: number; iteration: number; slot: number; path: string; sha256: string; receiptRef: string
  status: ArRunStatus; valid: boolean; invalid?: ArInvalidReason; metric?: number
}
export type ArHashed = ArtifactRef & { sha256: string }
export type ArSpec = { commands: string[]; params: Record<string, string> }
export type ArPending = { iteration: number; subject: Subject; input: UgInput; artifacts: ArHashed[]; spec: ArSpec }
/** The approved experiment (S1 unit record shape plus the iteration it was last run in). `done`/`remaining` are slot ids `c<i>`. */
export type ArExperiment = {
  subject: Subject; input: UgInput; approval: { subject: Subject; receiptRef: string }
  artifacts: ArHashed[]; taskIds: string[]; done: string[]; remaining: string[]; iteration: number
}
export type ArStuck = { kind: ArStuckKind; reason: string; evidence: string[] }
export type AutoresearchData = {
  v: 1
  request: string
  mission?: ArMission
  hypotheses: string[]
  evidence?: ArEvidenceRef
  iteration: number
  attempts: number
  failure?: string
  findings: string[]
  caveats: string[]
  pending?: ArPending
  experiment?: ArExperiment
  runs: ArRun[]
  best?: { attempt: number; value: number }
  evaluation?: { ref: string; verdict: "OKAY" | "ITERATE" | "REJECT"; suspect: number[] }
  capped?: boolean
  verdict?: { path: string; sha256: string; status: "conclusive" | "inconclusive" }
  stuck?: ArStuck
  productify?: { chosen: true }
}

const SHA = /^[a-f0-9]{64}$/
const REQUEST_MAX = 4_000
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const count = (value: unknown, max: number, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max
const strings = (value: unknown, max: number, each = 1_024): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => text(item, each))
const sha = (value: unknown): value is string => typeof value === "string" && SHA.test(value)
const oneOf = <T extends string>(allowed: readonly T[], value: unknown): value is T => typeof value === "string" && (allowed as readonly string[]).includes(value)

function invalid(): never {
  throw new Error("invalid workflow state")
}

export const initialAutoresearchData = (request = ""): AutoresearchData => ({ v: 1, request, hypotheses: [], iteration: 0, attempts: 0, findings: [], caveats: [], runs: [] })
export const runKey = (attempt: number): string => `runs/${attempt}.json`
export const slotId = (index: number): string => `c${index}`
export const slotIndex = (slot: string): number => Number(/^c(\d+)$/.exec(slot)?.[1] ?? NaN)

function parseSubject(value: unknown): Subject {
  if (!isObject(value) || value.kind !== "experiment-unit" || !text(value.id, 256) || !sha(value.sha256) || Object.keys(value).length !== 3) invalid()
  return { kind: "experiment-unit", id: value.id as string, sha256: value.sha256 }
}

function parseSpec(value: unknown): ArSpec {
  if (!isObject(value) || Object.keys(value).length !== 2 || !strings(value.commands, AR_MAX_COMMANDS, 300) || value.commands.length === 0 || !isObject(value.params)) invalid()
  const params: Record<string, string> = {}
  for (const [key, item] of Object.entries(value.params)) {
    if (!text(key, 64) || !text(item, 300)) invalid()
    params[key] = item as string
  }
  if (Object.keys(params).length > 8) invalid()
  return { commands: value.commands, params }
}

function parseRun(value: unknown): ArRun {
  const allowed = ["attempt", "iteration", "slot", "path", "sha256", "receiptRef", "status", "valid", "invalid", "metric"]
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key)) || !count(value.attempt, 10_000, 1) || !count(value.iteration, AR_MAX_ITERATIONS, 1) ||
    !count(value.slot, AR_MAX_COMMANDS - 1) || !text(value.path, 1_024) || !sha(value.sha256) || !text(value.receiptRef, 1_024) || !oneOf(AR_RUN_STATUSES, value.status) ||
    typeof value.valid !== "boolean" || (value.invalid !== undefined && !oneOf(AR_INVALID_REASONS, value.invalid)) || (value.valid && value.invalid !== undefined) || (!value.valid && value.invalid === undefined) ||
    (value.metric !== undefined && (typeof value.metric !== "number" || !Number.isFinite(value.metric)))) invalid()
  return {
    attempt: value.attempt, iteration: value.iteration, slot: value.slot, path: value.path as string, sha256: value.sha256, receiptRef: value.receiptRef as string,
    status: value.status, valid: value.valid, ...(value.invalid === undefined ? {} : { invalid: value.invalid as ArInvalidReason }), ...(value.metric === undefined ? {} : { metric: value.metric as number }),
  }
}

function parseExperiment(value: unknown): ArExperiment {
  if (!isObject(value) || Object.keys(value).some(key => !["subject", "input", "approval", "artifacts", "taskIds", "done", "remaining", "iteration"].includes(key)) ||
    !isObject(value.approval) || Object.keys(value.approval).length !== 2 || !text(value.approval.receiptRef, 1_024) || !count(value.iteration, AR_MAX_ITERATIONS, 1) ||
    !strings(value.taskIds, 0, 128) || !strings(value.done, AR_MAX_COMMANDS, 16) || !strings(value.remaining, AR_MAX_COMMANDS, 16)) invalid()
  const slots = [...value.done, ...value.remaining]
  if (slots.some(slot => !Number.isInteger(slotIndex(slot))) || new Set(slots).size !== slots.length) invalid()
  return {
    subject: parseSubject(value.subject), input: parseInput(value.input), approval: { subject: parseSubject(value.approval.subject), receiptRef: value.approval.receiptRef as string },
    artifacts: parseArtifacts(value.artifacts), taskIds: [], done: value.done, remaining: value.remaining, iteration: value.iteration,
  }
}

/**
 * Strict parser. An empty object is the not-yet-started state; anything else must be a complete v1 record. Unknown keys
 * are rejected, runs are numbered 1..n without gaps and at most AR_MAX_ITERATIONS iterations exist.
 */
export function parseAutoresearchData(value: unknown): AutoresearchData {
  if (!isObject(value)) invalid()
  if (Object.keys(value).length === 0) return initialAutoresearchData()
  const allowed = new Set(["v", "request", "mission", "hypotheses", "evidence", "iteration", "attempts", "failure", "findings", "caveats", "pending", "experiment", "runs", "best", "evaluation", "capped", "verdict", "stuck", "productify"])
  if (value.v !== 1 || Object.keys(value).some(key => !allowed.has(key)) || typeof value.request !== "string" || value.request.length > REQUEST_MAX ||
    !strings(value.hypotheses, 5, 300) || !count(value.iteration, AR_MAX_ITERATIONS) || !count(value.attempts, AR_MAX_ATTEMPTS) || !strings(value.findings, 12, 900) ||
    !strings(value.caveats, 40, 600) || !Array.isArray(value.runs) || value.runs.length > AR_MAX_ITERATIONS * AR_MAX_COMMANDS + 20 ||
    (value.failure !== undefined && !text(value.failure, 1_000)) || (value.capped !== undefined && typeof value.capped !== "boolean")) invalid()
  const data: AutoresearchData = {
    v: 1, request: value.request, hypotheses: value.hypotheses, iteration: value.iteration, attempts: value.attempts, findings: value.findings, caveats: value.caveats,
    runs: value.runs.map(parseRun),
  }
  data.runs.forEach((run, index) => { if (run.attempt !== index + 1) invalid() })
  if (value.failure !== undefined) data.failure = value.failure as string
  if (value.capped !== undefined) data.capped = value.capped
  if (value.mission !== undefined) {
    const m = value.mission
    if (!isObject(m) || Object.keys(m).length !== 3 || !text(m.path, 1_024) || !sha(m.sha256) || !isObject(m.metric) || Object.keys(m.metric).length !== 2 ||
      !text(m.metric.name, 64) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.metric.name) || !oneOf(AR_DIRECTIONS, m.metric.direction)) invalid()
    data.mission = { path: m.path as string, sha256: m.sha256, metric: { name: (m.metric as { name: string }).name, direction: (m.metric as { direction: ArDirection }).direction } }
  }
  if (value.evidence !== undefined) {
    const e = value.evidence
    if (!isObject(e) || Object.keys(e).length !== 4 || !text(e.path, 1_024) || !sha(e.sha256) || !count(e.verified, 10) || !count(e.unverified, 10)) invalid()
    data.evidence = { path: e.path as string, sha256: e.sha256, verified: e.verified, unverified: e.unverified }
  }
  if (value.pending !== undefined) {
    const p = value.pending
    if (!isObject(p) || Object.keys(p).length !== 5 || !count(p.iteration, AR_MAX_ITERATIONS, 1)) invalid()
    data.pending = { iteration: p.iteration, subject: parseSubject(p.subject), input: parseInput(p.input), artifacts: parseArtifacts(p.artifacts), spec: parseSpec(p.spec) }
  }
  if (value.experiment !== undefined) data.experiment = parseExperiment(value.experiment)
  if (value.best !== undefined) {
    const b = value.best
    if (!isObject(b) || Object.keys(b).length !== 2 || !count(b.attempt, 10_000, 1) || typeof b.value !== "number" || !Number.isFinite(b.value)) invalid()
    data.best = { attempt: b.attempt, value: b.value }
  }
  if (value.evaluation !== undefined) {
    const e = value.evaluation
    if (!isObject(e) || Object.keys(e).length !== 3 || !text(e.ref, 1_024) || !oneOf(["OKAY", "ITERATE", "REJECT"] as const, e.verdict) || !Array.isArray(e.suspect) || e.suspect.length > 50 ||
      !e.suspect.every(item => count(item, 10_000, 1))) invalid()
    data.evaluation = { ref: e.ref as string, verdict: e.verdict, suspect: e.suspect as number[] }
  }
  if (value.verdict !== undefined) {
    const v = value.verdict
    if (!isObject(v) || Object.keys(v).length !== 3 || !text(v.path, 1_024) || !sha(v.sha256) || !oneOf(["conclusive", "inconclusive"] as const, v.status)) invalid()
    data.verdict = { path: v.path as string, sha256: v.sha256, status: v.status }
  }
  if (value.stuck !== undefined) {
    const s = value.stuck
    if (!isObject(s) || Object.keys(s).length !== 3 || !oneOf(AR_STUCK_KINDS, s.kind) || !text(s.reason, 1_000) || !strings(s.evidence, 16, 1_024)) invalid()
    data.stuck = { kind: s.kind, reason: s.reason as string, evidence: s.evidence }
  }
  if (value.productify !== undefined) {
    if (!isObject(value.productify) || value.productify.chosen !== true || Object.keys(value.productify).length !== 1) invalid()
    data.productify = { chosen: true }
  }
  return data
}

/** Run attempts whose file a finished autoresearch rests on. Nothing a model writes can shrink this list. */
export function autoresearchRunKeys(data: unknown): string[] {
  return parseAutoresearchData(data).runs.map(run => runKey(run.attempt))
}
