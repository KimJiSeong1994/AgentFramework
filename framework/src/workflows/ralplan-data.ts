// Ralplan persisted data (P6a S3). A leaf module (types + strict parser, no registry import) so the registry can
// validate a committed ralplan envelope without an import cycle. `data` is never authority on its own: every lane
// result names a receipt that is re-read and verified from disk before any consensus or display claims it.

export const RALPLAN_MAX_OPENERS = 5
export const RALPLAN_MAX_ATTEMPTS = 2
export const ARCHITECT_STATUSES = ["CLEAR", "WATCH", "BLOCK"] as const
export const ARCHITECT_DECISIONS = ["APPROVE", "COMMENT", "REQUEST_CHANGES"] as const
export const CRITIC_VERDICTS = ["OKAY", "ITERATE", "REJECT"] as const
export type ArchitectStatus = (typeof ARCHITECT_STATUSES)[number]
export type ArchitectDecision = (typeof ARCHITECT_DECISIONS)[number]
export type CriticVerdict = (typeof CRITIC_VERDICTS)[number]

export type ArchitectResult = { status: ArchitectStatus; decision: ArchitectDecision; planSha: string; ref: string; findings: number }
export type CriticResult = { verdict: CriticVerdict; planSha: string; ref: string; findings: number }
/** One opener (planner or revision pass). `planSha` is the sha256 of the rendered plan markdown the lanes judged. */
export type RalplanIteration = {
  n: number
  planKey: string
  planPath: string
  planSha: string
  architect?: ArchitectResult
  critic?: CriticResult
}
export type RalplanSeed = { workflowID: string; specPath: string; specSha: string }
export type RalplanChoice = { kind: "stop_here" | "execute_confirmed"; planSha: string; executed: false }
export type RalplanData = {
  v: 1
  request: string
  seed?: RalplanSeed
  /** Planner/revision passes opened so far (at most RALPLAN_MAX_OPENERS). */
  openers: number
  iterations: RalplanIteration[]
  /** Failed attempts of the current item (malformed or unusable lane output). */
  attempts: number
  failure?: string
  consensus?: { opener: number; planSha: string; ref: string }
  choice?: RalplanChoice
  stuck?: { kind: "cap" | "attempts"; reason: string; bestOpener?: number }
}

const SHA = /^[a-f0-9]{64}$/
const REQUEST_MAX = 4_000
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const count = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max
const oneOf = <T extends string>(allowed: readonly T[], value: unknown): value is T => typeof value === "string" && (allowed as readonly string[]).includes(value)

function invalid(): never {
  throw new Error("invalid workflow state")
}

export const initialRalplanData = (request = ""): RalplanData => ({ v: 1, request, openers: 0, iterations: [], attempts: 0 })

function parseIteration(value: unknown, index: number): RalplanIteration {
  if (!isObject(value) || value.n !== index + 1 || value.planKey !== `iteration-${index + 1}/plan.md` || !text(value.planPath, 1024) || typeof value.planSha !== "string" || !SHA.test(value.planSha)) invalid()
  const out: RalplanIteration = { n: value.n, planKey: value.planKey, planPath: value.planPath, planSha: value.planSha }
  const a = value.architect
  if (a !== undefined) {
    if (!isObject(a) || !oneOf(ARCHITECT_STATUSES, a.status) || !oneOf(ARCHITECT_DECISIONS, a.decision) || typeof a.planSha !== "string" || !SHA.test(a.planSha) ||
      !text(a.ref, 1024) || !count(a.findings, 64)) invalid()
    out.architect = { status: a.status, decision: a.decision, planSha: a.planSha, ref: a.ref, findings: a.findings }
  }
  const c = value.critic
  if (c !== undefined) {
    if (!isObject(c) || !oneOf(CRITIC_VERDICTS, c.verdict) || typeof c.planSha !== "string" || !SHA.test(c.planSha) || !text(c.ref, 1024) || !count(c.findings, 64)) invalid()
    out.critic = { verdict: c.verdict, planSha: c.planSha, ref: c.ref, findings: c.findings }
  }
  return out
}

/**
 * Strict parser. An empty object is the not-yet-started state (the generic S1 substrate commits planning kinds with
 * `data: {}`); anything else must be a complete v1 record. Unknown keys are rejected.
 */
export function parseRalplanData(value: unknown): RalplanData {
  if (!isObject(value)) invalid()
  if (Object.keys(value).length === 0) return initialRalplanData()
  const allowed = new Set(["v", "request", "seed", "openers", "iterations", "attempts", "failure", "consensus", "choice", "stuck"])
  if (value.v !== 1 || Object.keys(value).some(key => !allowed.has(key)) || typeof value.request !== "string" || value.request.length > REQUEST_MAX ||
    !count(value.openers, RALPLAN_MAX_OPENERS) || !Array.isArray(value.iterations) || value.iterations.length !== value.openers ||
    !count(value.attempts, RALPLAN_MAX_ATTEMPTS) || (value.failure !== undefined && !text(value.failure, 1_000))) invalid()
  const data: RalplanData = {
    v: 1, request: value.request, openers: value.openers,
    iterations: value.iterations.map((item, index) => parseIteration(item, index)), attempts: value.attempts,
  }
  if (value.failure !== undefined) data.failure = value.failure as string
  if (value.seed !== undefined) {
    const s = value.seed
    if (!isObject(s) || !text(s.workflowID, 128) || !text(s.specPath, 1024) || typeof s.specSha !== "string" || !SHA.test(s.specSha) || Object.keys(s).length !== 3) invalid()
    data.seed = { workflowID: s.workflowID as string, specPath: s.specPath as string, specSha: s.specSha }
  }
  if (value.consensus !== undefined) {
    const c = value.consensus
    if (!isObject(c) || !count(c.opener, RALPLAN_MAX_OPENERS) || typeof c.planSha !== "string" || !SHA.test(c.planSha) || !text(c.ref, 1024) || Object.keys(c).length !== 3) invalid()
    data.consensus = { opener: c.opener, planSha: c.planSha, ref: c.ref as string }
  }
  if (value.choice !== undefined) {
    const c = value.choice
    if (!isObject(c) || !oneOf(["stop_here", "execute_confirmed"] as const, c.kind) || typeof c.planSha !== "string" || !SHA.test(c.planSha) || c.executed !== false || Object.keys(c).length !== 3) invalid()
    data.choice = { kind: c.kind, planSha: c.planSha, executed: false }
  }
  if (value.stuck !== undefined) {
    const s = value.stuck
    if (!isObject(s) || !oneOf(["cap", "attempts"] as const, s.kind) || !text(s.reason, 1_000) || (s.bestOpener !== undefined && !count(s.bestOpener, RALPLAN_MAX_OPENERS))) invalid()
    data.stuck = { kind: s.kind, reason: s.reason as string, ...(s.bestOpener === undefined ? {} : { bestOpener: s.bestOpener as number }) }
  }
  return data
}
