// Kind registry (P5a/P6). Every workflow kind is registered here so `Record<WorkflowKind, ...>` and `switch (kind)`
// stay exhaustive. Kinds whose engines are wired expose their code-owned stages; any future unwired kind would keep an
// explicit fail-closed startRefusal instead of a fake engine.
import type { Counters } from "../flow/machine.ts"
import type { ExecutionRole } from "../hosts/types.ts"
import { parseAutoresearchData } from "./autoresearch-data.ts"
import { parseDeepInterviewData } from "./deep-interview-data.ts"
import { parseRalplanData } from "./ralplan-data.ts"
import { parseUltragoalData, ultragoalDoneKeys } from "./ultragoal-data.ts"
import {
  assertNever, AUTORESEARCH_STAGES, ID_RE, DEEP_INTERVIEW_STAGES, PHASES, PLAN_STAGES, RALPLAN_STAGES, STOP_KINDS, SUBJECT_KINDS, ULTRAGOAL_STAGES, WORKFLOW_KINDS,
  type Phase, type PlanWorkflow, type StageOf, type StopIntent, type WorkflowEnvelope, type WorkflowKind,
} from "./types.ts"

export type KindDescriptor<K extends WorkflowKind> = {
  readonly kind: K
  readonly stages: readonly StageOf<K>[]
  /** Execution roles this kind may schedule (S7.2). Required: a descriptor without roles does not compile. */
  readonly roles: readonly ExecutionRole[]
  readonly startRefusal?: string
  /** The phase a stage carries while it is active (many stages map to one phase). */
  phaseOf(stage: StageOf<K>): Phase
  /** Every phase a committed envelope may carry at this stage; `paused` always keeps its live stage. */
  allowedPhases(stage: StageOf<K>): readonly Phase[]
  /** Validate kind-specific fields on an object that already passed the common envelope checks. */
  parseKind(value: Record<string, unknown>): void
}

/** The plan kind also derives a stage from a phase (its stages are one-to-one with phases). */
export type PlanDescriptor = KindDescriptor<"plan"> & { stageOf(phase: Phase, previous?: string): StageOf<"plan"> }

type Tables<K extends WorkflowKind> = Pick<KindDescriptor<K>, "phaseOf" | "allowedPhases">

/**
 * Stage<->phase tables. `active` is the canonical phase of every stage; `terminal` lists the phases the single
 * `terminal` stage may carry. Every non-terminal stage may additionally be `paused`, and (when `stuckKeepsStage`)
 * `stuck` at the live stage so Retry resumes the same stage; terminal-only stuck kinds list `stuck` under `terminal`.
 */
function tablesFor<K extends WorkflowKind>(active: Readonly<Record<StageOf<K>, Phase>>, terminal: readonly Phase[], stuckKeepsStage: boolean): Tables<K> {
  return {
    phaseOf: stage => active[stage],
    allowedPhases: stage => (stage as string) === "terminal"
      ? terminal
      : [active[stage], ...(stuckKeepsStage ? ["stuck" as const] : []), "paused" as const],
  }
}

const isObject = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === "object" && !Array.isArray(input)
const nonnegativeInteger = (input: unknown): boolean => Number.isSafeInteger(input) && (input as number) >= 0
const timestamp = (input: unknown): boolean => typeof input === "number" && Number.isFinite(input) && input >= 0

function validSubject(value: unknown): boolean {
  return isObject(value) && (SUBJECT_KINDS as readonly string[]).includes(value.kind as string) &&
    typeof value.id === "string" && value.id.length > 0 && typeof value.sha256 === "string" && value.sha256.length > 0
}

function invalid(): never {
  throw new Error("invalid workflow state")
}

function parsePlanKind(w: Record<string, unknown>): void {
  const counters = w.counters
  const planRef = w.planRef
  const review = w.review
  const approval = w.approval
  const counterKeys: ReadonlyArray<keyof Counters> = ["code_invalid", "review_iterations", "user_rejections", "nudges"]
  if (!["command", "keyword"].includes(w.entry as string) || typeof w.request !== "string" ||
    (w.stuckCause !== undefined && !["plan_invalid", "no_submission", "tasks_failed", "user_stop"].includes(w.stuckCause as string)) ||
    !isObject(counters) || !counterKeys.every(key => nonnegativeInteger(counters[key])) ||
    (w.planRef !== undefined && (!isObject(planRef) || typeof planRef.mdPath !== "string" || typeof planRef.jsonSha !== "string" || typeof planRef.mdSha !== "string" || !nonnegativeInteger(planRef.revision))) ||
    (w.review !== undefined && (!isObject(review) || !["okay", "iterate", "none"].includes(review.verdict as string) || !Array.isArray(review.findings) || !review.findings.every(x => typeof x === "string") || typeof review.planSha !== "string" ||
      (review.note !== undefined && !["aborted", "cap"].includes(review.note as string)))) ||
    (w.approval !== undefined && (!isObject(approval) || approval.by !== "user_command" || !validSubject(approval.subject) || !nonnegativeInteger(approval.receiptRevision) || !timestamp(approval.at))) ||
    (w.taskIds !== undefined && (!Array.isArray(w.taskIds) || !w.taskIds.every(x => typeof x === "string")))) invalid()
}

/** The phase must be one the stage allows (a DI is never `pending_approval` or `executing`). */
function checkStagePhase(kind: WorkflowKind, w: Record<string, unknown>): void {
  const descriptor = REGISTRY[kind] as KindDescriptor<WorkflowKind>
  if (!(descriptor.allowedPhases(w.stage as never) as readonly string[]).includes(w.phase as string)) invalid()
  const from = w.pausedFrom
  if (kind !== "plan" && isObject(from)) {
    // A pause settles in place: it can only resume the stage it came from, at that stage's active phase.
    if (!(descriptor.stages as readonly string[]).includes(from.stage as string) || descriptor.phaseOf(from.stage as never) !== from.phase) invalid()
  }
}

/** Non-plan kinds: typed `data` object (engine schemas tighten it) plus the stage/phase table. */
function parseStagedKind(kind: Exclude<WorkflowKind, "plan">) {
  return (w: Record<string, unknown>): void => {
    if (!isObject(w.data)) invalid()
    checkStagePhase(kind, w)
  }
}

const PLAN_ACTIVE = { draft: "planning", review: "reviewing", decision: "pending_approval", unit: "executing", terminal: "done" } as const satisfies Record<StageOf<"plan">, Phase>
const PLAN: PlanDescriptor = {
  kind: "plan",
  roles: Object.freeze(["main", "reviewer", "worker"]),
  stages: PLAN_STAGES,
  // Plan stuck/done/cancelled all collapse to the single terminal stage; paused keeps the live stage.
  ...tablesFor<"plan">(PLAN_ACTIVE, ["done", "stuck", "cancelled"], false),
  stageOf: (phase, previous) => {
    if (phase === "paused") return (PLAN_STAGES.find(stage => stage === previous) ?? PLAN_STAGES[0]!) as StageOf<"plan">
    return ({ planning: "draft", reviewing: "review", pending_approval: "decision", executing: "unit", stuck: "terminal", done: "terminal", cancelled: "terminal" } as const)[phase]
  },
  parseKind: parsePlanKind,
}

// PA S7.2: intake/topology/question/answer/scoring -> planning; panel/closure -> reviewing; restate (a planning
// choice) and crystallize -> planning; a verified spec -> done. Stuck and paused keep the live stage for Retry/Resume.
const DEEP_INTERVIEW: KindDescriptor<"deep-interview"> = {
  kind: "deep-interview",
  roles: Object.freeze(["interviewer", "researcher", "contrarian", "simplifier", "architect"]),
  stages: DEEP_INTERVIEW_STAGES,
  ...tablesFor<"deep-interview">({
    intake: "planning", topology: "planning", question: "planning", answer: "planning", scoring: "planning",
    panel: "reviewing", closure: "reviewing", restate: "planning", crystallize: "planning", terminal: "done",
  }, ["done", "cancelled"], true),
  parseKind: (w) => {
    parseStagedKind("deep-interview")(w)
    try { parseDeepInterviewData(w.data) } catch { invalid() }
  },
}

// planner/revision/consensus_emit -> planning; architect/critic -> reviewing; pending_execution -> pending_approval.
// The cap (PLANNING-STUCK) is terminal: stuck at the terminal stage with a verified best plan.
const RALPLAN: KindDescriptor<"ralplan"> = {
  kind: "ralplan",
  roles: Object.freeze(["planner", "architect", "critic"]),
  stages: RALPLAN_STAGES,
  ...tablesFor<"ralplan">({
    planner: "planning", revision: "planning", architect: "reviewing", critic: "reviewing",
    consensus_emit: "planning", pending_execution: "pending_approval", terminal: "done",
  }, ["done", "stuck", "cancelled"], true),
  parseKind: (w) => {
    parseStagedKind("ralplan")(w)
    parseRalplanData(w.data)
  },
}

const ULTRAGOAL: KindDescriptor<"ultragoal"> = {
  kind: "ultragoal",
  roles: Object.freeze(["planner", "architect", "worker", "reviewer", "critic"]),
  stages: ULTRAGOAL_STAGES,
  // A name starts decomposition only; units still need typed APPROVE-UNIT receipts before execution.
  ...tablesFor<"ultragoal">({
    decompose: "planning", goal_select: "planning", unit_plan: "planning", unit_review: "reviewing", final_review: "reviewing",
    unit_approval: "pending_approval", unit_execute: "executing", verify: "executing", checkpoint: "planning", terminal: "done",
  }, ["done", "stuck", "cancelled"], true),
  parseKind: (w) => {
    parseStagedKind("ultragoal")(w)
    parseUltragoalData(w.data)
  },
}

const AUTORESEARCH: KindDescriptor<"autoresearch"> = {
  kind: "autoresearch",
  roles: Object.freeze(["researcher", "data-analyst", "critic"]),
  stages: AUTORESEARCH_STAGES,
  // A name starts the research mission only; experiments still need typed RUN receipts before any command runs.
  ...tablesFor<"autoresearch">({
    intake: "planning", hypothesis: "planning", evidence: "planning", experiment_prepare: "planning", experiment_approval: "pending_approval",
    experiment_run: "executing", evaluate: "reviewing", verdict_emit: "planning", terminal: "done",
  }, ["done", "stuck", "cancelled"], true),
  parseKind: (w) => {
    parseStagedKind("autoresearch")(w)
    try { parseAutoresearchData(w.data) } catch { invalid() }
  },
}

export const REGISTRY: { readonly [K in WorkflowKind]: K extends "plan" ? PlanDescriptor : KindDescriptor<K> } = {
  plan: PLAN,
  "deep-interview": DEEP_INTERVIEW,
  ralplan: RALPLAN,
  ultragoal: ULTRAGOAL,
  autoresearch: AUTORESEARCH,
}

/**
 * Artifact keys that must be present, hashed and verified from disk in the commit transaction before a revision with
 * this stage/phase may be published. A model can write the files, but the state never advances past them unverified.
 */
export function requiredArtifactKeys(wf: Pick<WorkflowEnvelope, "kind" | "stage" | "phase"> & { data?: unknown }): readonly string[] {
  switch (wf.kind) {
    case "plan": return []
    case "deep-interview": return wf.phase === "done" ? ["spec.md"] : []
    case "ralplan":
      if (wf.phase === "cancelled") return []
      if (wf.phase === "done" || wf.stage === "pending_execution") return ["pending-approval.md", "consensus.json"]
      return wf.phase === "stuck" && wf.stage === "terminal" ? ["best-plan.md"] : []
    // A finished ultragoal rests on goals.json, completion.json and the latest checkpoint of every goal; a finished
    // autoresearch (always a conclusive verdict) on mission.json, verdict.json and at least one recorded run. An
    // envelope without a `data` key (a bare triple) gates nothing, but a done record whose data is not an object, or
    // whose proof list is empty, is unsatisfiable: model-influenced data can never shrink the evidence set.
    case "ultragoal": {
      if (wf.phase !== "done" || !("data" in wf) || wf.data === undefined) return []
      return ultragoalDoneKeys(wf.data)
    }
    case "autoresearch": {
      const inconclusive = wf.phase === "stuck" && wf.stage === "terminal"
      if ((wf.phase !== "done" && !inconclusive) || !("data" in wf) || wf.data === undefined) return []
      if (!isObject(wf.data) || !Array.isArray(wf.data.runs)) throw new Error("a finished autoresearch needs recorded runs; refusing")
      const keys = wf.data.runs.flatMap(run => isObject(run) && typeof run.attempt === "number" ? [`runs/${run.attempt}.json`] : [])
      if (keys.length !== wf.data.runs.length || (!inconclusive && keys.length === 0)) throw new Error("a conclusive autoresearch needs at least one recorded run; refusing")
      return ["mission.json", "verdict.json", ...keys]
    }
    default: return assertNever(wf.kind, "workflow kind")
  }
}

/** Role guard shared by the turn runner and controller unit dispatch: a kind schedules only its registered roles. */
export function kindAllowsRole(kind: WorkflowKind, role: string): boolean {
  return (REGISTRY[kind].roles as readonly string[]).includes(role)
}

export function isWorkflowKind(value: unknown): value is WorkflowKind {
  return typeof value === "string" && (WORKFLOW_KINDS as readonly string[]).includes(value)
}

/** Fail-closed start gate: a kind without a wired engine refuses with its explicit reason. */
export function startRefusal(kind: WorkflowKind): string | undefined {
  switch (kind) {
    case "plan": return undefined
    case "deep-interview": return REGISTRY["deep-interview"].startRefusal
    case "ralplan": return REGISTRY.ralplan.startRefusal
    case "ultragoal": return REGISTRY.ultragoal.startRefusal
    case "autoresearch": return REGISTRY.autoresearch.startRefusal
    default: return assertNever(kind, "workflow kind")
  }
}

function parseStopIntent(value: unknown): StopIntent | null {
  if (value === null) return null
  if (!isObject(value) || !(STOP_KINDS as readonly string[]).includes(value.kind as string) || typeof value.token !== "string" || !value.token ||
    !isObject(value.requestedFrom) || !(PHASES as readonly string[]).includes(value.requestedFrom.phase as string) || typeof value.requestedFrom.stage !== "string" ||
    !(value.checkpoint === null || typeof value.checkpoint === "string") || typeof value.reason !== "string") invalid()
  return value as StopIntent
}

/** Strict pure parser for the v2 envelope; it never mutates state and rejects unknown kinds, stages and intents. */
export function parseEnvelope(value: unknown): WorkflowEnvelope {
  if (!isObject(value)) invalid()
  const w = value
  if (w.version !== 2 || typeof w.id !== "string" || !ID_RE.test(w.id) || !isWorkflowKind(w.kind) ||
    typeof w.sessionID !== "string" || !ID_RE.test(w.sessionID) || !(PHASES as readonly string[]).includes(w.phase as string) ||
    !nonnegativeInteger(w.lastSeq) || !timestamp(w.createdAt) || !timestamp(w.updatedAt)) invalid()
  const owner = w.owner
  if (!isObject(owner) || typeof owner.instance !== "string" || !owner.instance || !Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) invalid()
  const stages: readonly string[] = REGISTRY[w.kind].stages
  if (typeof w.stage !== "string" || !stages.includes(w.stage)) invalid()
  parseStopIntent(w.stopIntent === undefined ? invalid() : w.stopIntent)
  if (w.pausedFrom !== undefined) {
    const from = w.pausedFrom
    if (!isObject(from) || !(PHASES as readonly string[]).includes(from.phase as string) || typeof from.stage !== "string") invalid()
  }
  if (w.lineage !== undefined) {
    const l = w.lineage
    const p = isObject(l) && isObject(l.predecessor) ? l.predecessor : undefined
    if (!p || typeof p.id !== "string" || !ID_RE.test(p.id) || !isWorkflowKind(p.kind) || !nonnegativeInteger(p.revision) || !isObject(p.artifact) ||
      typeof p.artifact.path !== "string" || !p.artifact.path || typeof p.artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.artifact.sha256) ||
      Object.keys(l as object).length !== 1) invalid()
  }
  if (!Array.isArray(w.artifacts) || !w.artifacts.every(item => isObject(item) && typeof item.key === "string" && typeof item.path === "string" &&
    (item.sha256 === undefined || typeof item.sha256 === "string"))) invalid()
  if (w.orphanedEvents !== undefined && (!Array.isArray(w.orphanedEvents) || !w.orphanedEvents.every(range => Array.isArray(range) && range.length === 2 &&
    nonnegativeInteger(range[0]) && nonnegativeInteger(range[1]) && range[0] <= range[1]))) invalid()
  REGISTRY[w.kind].parseKind(w)
  return value as WorkflowEnvelope
}

/** Throwing narrow for plan APIs; arbitrary envelopes are never cast. */
export function narrowPlan(wf: WorkflowEnvelope | null | undefined): PlanWorkflow {
  if (!wf || wf.kind !== "plan") throw new TypeError(`plan workflow required${wf ? `, got ${wf.kind}` : ""}`)
  try { parseEnvelope(wf) } catch { throw new TypeError("ill-formed plan workflow") }
  return wf
}

export function isPlanWorkflow(wf: WorkflowEnvelope): wf is PlanWorkflow {
  return wf.kind === "plan"
}
