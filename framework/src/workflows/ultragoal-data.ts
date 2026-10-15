// Ultragoal persisted data (P6b S2). A leaf module (types + strict parser, no registry or engine imports) so the
// registry can validate a committed ultragoal envelope without an import cycle. `data` is never authority on its own:
// the goal set is fixed once at `goals_saved` (and re-read from the verified goals.json bytes), every checkpoint names a
// verified file and every approval a verified receipt, all re-read from disk before anything is claimed or completed.
import type { ArtifactRef, Subject } from "./types.ts"

export const UG_MAX_GOALS = 10
/** Pinned nudge budget: continuations without progress per goal before the goal is blocked (A2). */
export const UG_MAX_NO_PROGRESS = 10
export const UG_MAX_ATTEMPTS = 2
export const UG_STUCK_KINDS = ["attempts", "goal_blocked", "final_review", "evidence", "runner"] as const
export type UgStuckKind = (typeof UG_STUCK_KINDS)[number]

export type UgSeed = { workflowID: string; planPath: string; planSha: string; consensusRef: string; executeChoiceRef: string }
export type UgGoalsRef = { path: string; sha256: string; ids: string[] }
export type UgProgress = { noProgress: number; attempt: number; lastCheckpoint?: string; lastAttemptCheckpoint?: string }
export type UgInput = {
  id: string; scope: string[]; commands: string[]; inputs: string[]; allowedPaths: string[]; verification: string[]; sourceHashes: string[]; artifactHashes: string[]
}
export type UgPending = { goalId: string; attempt: number; subject: Subject; input: UgInput; artifacts: Array<ArtifactRef & { sha256: string }>; reviewRef?: string }
/** The approved unit (execution_approved onward). Extra keys beyond the S1 unit record carry the goal binding. */
export type UgCurrent = {
  goalId: string; attempt: number; subject: Subject; input: UgInput; approval: { subject: Subject; receiptRef: string }
  artifacts: Array<ArtifactRef & { sha256: string }>; taskIds: string[]; done: string[]; remaining: string[]; verification?: { ref: string; ok: boolean }
}
export type UgStuck = { kind: UgStuckKind; reason: string; goalId?: string; evidence: string[] }
export type UltragoalData = {
  v: 1
  request: string
  seed?: UgSeed
  goals?: UgGoalsRef
  progress: Record<string, UgProgress>
  selected?: string
  pending?: UgPending
  current?: UgCurrent
  /** Findings (reviewer, verification) handed to the next unit plan; display/context only, never authority. */
  findings: string[]
  attempts: number
  failure?: string
  stuck?: UgStuck
  final?: { ref: string }
  completion?: { path: string; sha256: string }
}

const SHA = /^[a-f0-9]{64}$/
const GOAL_ID = /^g([1-9]|10)$/
const REQUEST_MAX = 4_000
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const count = (value: unknown, max: number, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max
const strings = (value: unknown, max: number, each = 1_024): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => text(item, each))
const sha = (value: unknown): value is string => typeof value === "string" && SHA.test(value)

function invalid(): never {
  throw new Error("invalid workflow state")
}

export const initialUltragoalData = (request = ""): UltragoalData => ({ v: 1, request, progress: {}, findings: [], attempts: 0 })
export const goalCheckpointKey = (goalId: string, attempt: number): string => `checkpoints/${goalId}-${attempt}.json`
export const goalIds = (count: number): string[] => Array.from({ length: count }, (_, index) => `g${index + 1}`)

function parseSubject(value: unknown): Subject {
  if (!isObject(value) || value.kind !== "implementation-unit" || !text(value.id, 256) || !sha(value.sha256) || Object.keys(value).length !== 3) invalid()
  return { kind: "implementation-unit", id: value.id as string, sha256: value.sha256 }
}

export function parseInput(value: unknown): UgInput {
  if (!isObject(value) || !text(value.id, 256)) invalid()
  const keys = ["scope", "commands", "inputs", "allowedPaths", "verification", "sourceHashes", "artifactHashes"] as const
  for (const key of keys) if (!strings(value[key], 256, 1_024)) invalid()
  if (Object.keys(value).length !== keys.length + 1) invalid()
  return {
    id: value.id as string, scope: value.scope as string[], commands: value.commands as string[], inputs: value.inputs as string[],
    allowedPaths: value.allowedPaths as string[], verification: value.verification as string[], sourceHashes: value.sourceHashes as string[], artifactHashes: value.artifactHashes as string[],
  }
}

export function parseArtifacts(value: unknown): Array<ArtifactRef & { sha256: string }> {
  if (!Array.isArray(value) || value.length > 8) invalid()
  return value.map(item => {
    if (!isObject(item) || !text(item.key, 128) || !text(item.path, 1_024) || !sha(item.sha256) || Object.keys(item).length !== 3) invalid()
    return { key: item.key as string, path: item.path as string, sha256: item.sha256 }
  })
}

function parseCurrent(value: unknown): UgCurrent {
  if (!isObject(value) || !text(value.goalId, 8) || !count(value.attempt, 1_000, 1) || !isObject(value.approval) || !text(value.approval.receiptRef, 1_024)) invalid()
  const allowed = new Set(["goalId", "attempt", "subject", "input", "approval", "artifacts", "taskIds", "done", "remaining", "verification"])
  if (Object.keys(value).some(key => !allowed.has(key)) || Object.keys(value.approval).length !== 2) invalid()
  const subject = parseSubject(value.subject)
  const approvalSubject = parseSubject(value.approval.subject)
  if (!strings(value.taskIds, 64, 128) || !strings(value.done, 64, 128) || !strings(value.remaining, 64, 128)) invalid()
  const current: UgCurrent = {
    goalId: value.goalId as string, attempt: value.attempt, subject, input: parseInput(value.input), approval: { subject: approvalSubject, receiptRef: value.approval.receiptRef as string },
    artifacts: parseArtifacts(value.artifacts), taskIds: value.taskIds, done: value.done, remaining: value.remaining,
  }
  if (value.verification !== undefined) {
    const v = value.verification
    if (!isObject(v) || !text(v.ref, 1_024) || typeof v.ok !== "boolean" || Object.keys(v).length !== 2) invalid()
    current.verification = { ref: v.ref as string, ok: v.ok }
  }
  return current
}

/**
 * Strict parser. An empty object is the not-yet-started state; anything else must be a complete v1 record. Unknown keys
 * are rejected. Progress may only name goals of the fixed goal list, and at most UG_MAX_GOALS exist.
 */
export function parseUltragoalData(value: unknown): UltragoalData {
  if (!isObject(value)) invalid()
  if (Object.keys(value).length === 0) return initialUltragoalData()
  const allowed = new Set(["v", "request", "seed", "goals", "progress", "selected", "pending", "current", "findings", "attempts", "failure", "stuck", "final", "completion"])
  if (value.v !== 1 || Object.keys(value).some(key => !allowed.has(key)) || typeof value.request !== "string" || value.request.length > REQUEST_MAX ||
    !isObject(value.progress) || !strings(value.findings, 12, 900) || !count(value.attempts, UG_MAX_ATTEMPTS) || (value.failure !== undefined && !text(value.failure, 1_000))) invalid()
  const data: UltragoalData = { v: 1, request: value.request, progress: {}, findings: value.findings, attempts: value.attempts }
  if (value.failure !== undefined) data.failure = value.failure as string
  if (value.seed !== undefined) {
    const s = value.seed
    if (!isObject(s) || !text(s.workflowID, 128) || !text(s.planPath, 1_024) || !sha(s.planSha) || !text(s.consensusRef, 1_024) || !text(s.executeChoiceRef, 1_024) || Object.keys(s).length !== 5) invalid()
    data.seed = { workflowID: s.workflowID as string, planPath: s.planPath as string, planSha: s.planSha, consensusRef: s.consensusRef as string, executeChoiceRef: s.executeChoiceRef as string }
  }
  let ids: string[] | undefined
  if (value.goals !== undefined) {
    const g = value.goals
    if (!isObject(g) || !text(g.path, 1_024) || !sha(g.sha256) || !Array.isArray(g.ids) || g.ids.length < 1 || g.ids.length > UG_MAX_GOALS || Object.keys(g).length !== 3) invalid()
    const expected = goalIds(g.ids.length)
    if (!g.ids.every((id, index) => id === expected[index])) invalid()
    ids = g.ids as string[]
    data.goals = { path: g.path as string, sha256: g.sha256, ids }
  }
  for (const [id, raw] of Object.entries(value.progress)) {
    if (!ids || !ids.includes(id) || !GOAL_ID.test(id) || !isObject(raw)) invalid()
    const allowedProgress = new Set(["noProgress", "attempt", "lastCheckpoint", "lastAttemptCheckpoint"])
    if (Object.keys(raw).some(key => !allowedProgress.has(key)) || !count(raw.noProgress, 10) || !count(raw.attempt, 1_000) ||
      (raw.lastCheckpoint !== undefined && !text(raw.lastCheckpoint, 128)) || (raw.lastAttemptCheckpoint !== undefined && !text(raw.lastAttemptCheckpoint, 128))) invalid()
    data.progress[id] = {
      noProgress: raw.noProgress, attempt: raw.attempt,
      ...(raw.lastCheckpoint === undefined ? {} : { lastCheckpoint: raw.lastCheckpoint as string }),
      ...(raw.lastAttemptCheckpoint === undefined ? {} : { lastAttemptCheckpoint: raw.lastAttemptCheckpoint as string }),
    }
  }
  if (ids && !ids.every(id => data.progress[id])) invalid()
  if (value.selected !== undefined) {
    if (typeof value.selected !== "string" || (ids && !ids.includes(value.selected))) invalid()
    data.selected = value.selected
  }
  if (value.pending !== undefined) {
    const p = value.pending
    if (!isObject(p) || !text(p.goalId, 8) || !count(p.attempt, 1_000, 1) || (p.reviewRef !== undefined && !text(p.reviewRef, 1_024)) ||
      Object.keys(p).some(key => !["goalId", "attempt", "subject", "input", "artifacts", "reviewRef"].includes(key))) invalid()
    data.pending = {
      goalId: p.goalId as string, attempt: p.attempt, subject: parseSubject(p.subject), input: parseInput(p.input), artifacts: parseArtifacts(p.artifacts),
      ...(p.reviewRef === undefined ? {} : { reviewRef: p.reviewRef as string }),
    }
  }
  if (value.current !== undefined) data.current = parseCurrent(value.current)
  if (value.stuck !== undefined) {
    const s = value.stuck
    if (!isObject(s) || !(UG_STUCK_KINDS as readonly string[]).includes(s.kind as string) || !text(s.reason, 1_000) || !strings(s.evidence, 16, 1_024) ||
      (s.goalId !== undefined && !text(s.goalId, 8)) || Object.keys(s).some(key => !["kind", "reason", "goalId", "evidence"].includes(key))) invalid()
    data.stuck = { kind: s.kind as UgStuckKind, reason: s.reason as string, evidence: s.evidence, ...(s.goalId === undefined ? {} : { goalId: s.goalId as string }) }
  }
  if (value.final !== undefined) {
    if (!isObject(value.final) || !text(value.final.ref, 1_024) || Object.keys(value.final).length !== 1) invalid()
    data.final = { ref: value.final.ref as string }
  }
  if (value.completion !== undefined) {
    const c = value.completion
    if (!isObject(c) || !text(c.path, 1_024) || !sha(c.sha256) || Object.keys(c).length !== 2) invalid()
    data.completion = { path: c.path as string, sha256: c.sha256 }
  }
  return data
}

/**
 * The artifact keys a finished ultragoal rests on. The goal set comes ONLY from the fixed goal list recorded at
 * goals_saved, and every goal must name its latest complete checkpoint; nothing a model can write shrinks this list.
 */
export function ultragoalDoneKeys(data: unknown): string[] {
  const parsed = parseUltragoalData(data)
  const ids = parsed.goals?.ids
  if (!ids || ids.length === 0) throw new Error("a finished ultragoal needs its fixed goal list; refusing")
  const keys = ids.map(id => parsed.progress[id]?.lastCheckpoint)
  if (keys.some(key => key === undefined)) throw new Error("every goal of a finished ultragoal needs a verified checkpoint; refusing")
  return ["goals.json", "completion.json", ...(keys as string[])]
}
