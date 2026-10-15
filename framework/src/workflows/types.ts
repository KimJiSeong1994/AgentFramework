// Generic workflow envelope (P5a/P6). One versioned, kind-discriminated record; per-kind stage unions are typed
// discriminants, never unchecked strings. Wired kinds expose code-owned engines; any future unwired kind remains an
// explicit registry entry with a fail-closed startRefusal instead of a fake engine.
import type { Counters, StuckCause } from "../flow/machine.ts"

export const PHASES = ["planning", "reviewing", "pending_approval", "executing", "stuck", "paused", "done", "cancelled"] as const
export type Phase = (typeof PHASES)[number]
export const ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/
export const TERMINAL: ReadonlySet<Phase> = new Set<Phase>(["done", "cancelled"])

export const WORKFLOW_KINDS = ["plan", "deep-interview", "ralplan", "ultragoal", "autoresearch"] as const
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number]

export const PLAN_STAGES = ["draft", "review", "decision", "unit", "terminal"] as const
export const DEEP_INTERVIEW_STAGES = ["intake", "topology", "question", "answer", "scoring", "panel", "closure", "restate", "crystallize", "terminal"] as const
export const RALPLAN_STAGES = ["planner", "revision", "architect", "critic", "consensus_emit", "pending_execution", "terminal"] as const
export const ULTRAGOAL_STAGES = ["decompose", "goal_select", "unit_plan", "unit_review", "final_review", "unit_approval", "unit_execute", "verify", "checkpoint", "terminal"] as const
export const AUTORESEARCH_STAGES = ["intake", "hypothesis", "evidence", "experiment_prepare", "experiment_approval", "experiment_run", "evaluate", "verdict_emit", "terminal"] as const

export type PlanStage = (typeof PLAN_STAGES)[number]
export type DeepInterviewStage = (typeof DEEP_INTERVIEW_STAGES)[number]
export type RalplanStage = (typeof RALPLAN_STAGES)[number]
export type UltragoalStage = (typeof ULTRAGOAL_STAGES)[number]
export type AutoresearchStage = (typeof AUTORESEARCH_STAGES)[number]

export type StageByKind = {
  plan: PlanStage
  "deep-interview": DeepInterviewStage
  ralplan: RalplanStage
  ultragoal: UltragoalStage
  autoresearch: AutoresearchStage
}
export type StageOf<K extends WorkflowKind> = StageByKind[K]

export type Owner = { instance: string; pid: number }

/** Planning-only kinds: read-only roles, no execution units, no ledger tasks. */
export const PLANNING_KINDS = ["deep-interview", "ralplan"] as const
export type PlanningKind = (typeof PLANNING_KINDS)[number]
export function isPlanningKind(kind: WorkflowKind): kind is PlanningKind {
  return (PLANNING_KINDS as readonly string[]).includes(kind)
}

/** DI -> ralplan handoff provenance: the terminal predecessor revision and the artifact (spec) the successor was seeded from. */
export type Lineage = { predecessor: { id: string; kind: WorkflowKind; revision: number; artifact: { path: string; sha256: string } } }

export const STOP_KINDS = ["pause", "cancel"] as const
export type StopKind = (typeof STOP_KINDS)[number]
export type StopIntent = {
  kind: StopKind
  token: string
  requestedFrom: { phase: Phase; stage: string }
  checkpoint: string | null
  reason: string
}

export const SUBJECT_KINDS = ["plan", "implementation-unit", "experiment-unit"] as const
export type SubjectKind = (typeof SUBJECT_KINDS)[number]
export type Subject = { kind: SubjectKind; id: string; sha256: string }

export type ArtifactRef = { key: string; path: string; sha256?: string }

export type EnvelopeBase<K extends WorkflowKind> = {
  version: 2
  id: string
  kind: K
  stage: StageOf<K>
  /** Observed host identity; legacy or malformed values remain readable but confer no execution authority. */
  engine?: unknown
  /** authority key */
  sessionID: string
  owner: Owner
  phase: Phase
  stopIntent: StopIntent | null
  pausedFrom?: { phase: Phase; stage: string }
  artifacts: ArtifactRef[]
  /** Set once by `commitHandoff` on a successor; never changed afterwards. */
  lineage?: Lineage
  /** Inclusive [first,last] global seq ranges of commit events from commits that never reached the index; never committed work. */
  orphanedEvents?: Array<[number, number]>
  lastSeq: number
  createdAt: number
  updatedAt: number
}

export type PlanWorkflow = EnvelopeBase<"plan"> & {
  stuckCause?: StuckCause
  entry: "command" | "keyword"
  request: string
  planRef?: { jsonSha: string; mdPath: string; mdSha: string; revision: number }
  review?: { verdict: "okay" | "iterate" | "none"; findings: string[]; planSha: string; note?: "aborted" | "cap" }
  approval?: { by: "user_command"; subject: Subject; receiptRevision: number; at: number }
  taskIds?: string[]
  counters: Counters
}

/** Registry entry whose per-kind `data` schema belongs to its engine; never authority by itself. */
export type EngineWorkflow<K extends Exclude<WorkflowKind, "plan">> = EnvelopeBase<K> & { data: Readonly<Record<string, unknown>> }

export type DeepInterviewWorkflow = EngineWorkflow<"deep-interview">
export type RalplanWorkflow = EngineWorkflow<"ralplan">
export type UltragoalWorkflow = EngineWorkflow<"ultragoal">
export type AutoresearchWorkflow = EngineWorkflow<"autoresearch">

/** The persisted discriminated union. Plan APIs accept `PlanWorkflow` only; narrow with `narrowPlan`. */
export type WorkflowEnvelope = PlanWorkflow | DeepInterviewWorkflow | RalplanWorkflow | UltragoalWorkflow | AutoresearchWorkflow

/** Committed index (`workflow/workflow.json`): the single durable commit pointer. */
export type WorkflowIndex = {
  version: 2
  id: string
  sessionID: string
  kind: WorkflowKind
  revision: number
  path: string
  sha256: string
}

export function assertNever(value: never, what = "value"): never {
  throw new Error(`unhandled ${what}: ${String(value)}`)
}

/** Cancel is pending while a cancel stop intent is recorded and the phase has not settled. */
export function isCancelPending(wf: { stopIntent: StopIntent | null }): boolean {
  return wf.stopIntent?.kind === "cancel"
}

/** A pause intent is recorded and termination/quiescence has not been proven (the phase is not yet `paused`). */
export function isPausePending(wf: { stopIntent: StopIntent | null; phase: Phase }): boolean {
  return wf.stopIntent?.kind === "pause" && wf.phase !== "paused"
}

/** The pause settled: phase `paused` with the pause intent retained as the settled marker. */
export function isPauseSettled(wf: { stopIntent: StopIntent | null; phase: Phase }): boolean {
  return wf.stopIntent?.kind === "pause" && wf.phase === "paused"
}

/** Any recorded stop intent that has not yet reached its terminal/settled state. */
export function isStopPending(wf: { stopIntent: StopIntent | null; phase: Phase }): boolean {
  return isCancelPending(wf) || isPausePending(wf)
}

export const STOP_DISPLAYS = ["none", "pausing", "paused", "cancelling"] as const
export type StopDisplay = (typeof STOP_DISPLAYS)[number]

/** Truth-first presentation: `paused` only once the pause settled; pending stops stay unconfirmed. */
export function stopDisplay(wf: { stopIntent: StopIntent | null; phase: Phase }): StopDisplay {
  if (isCancelPending(wf)) return "cancelling"
  if (isPauseSettled(wf)) return "paused"
  if (isPausePending(wf)) return "pausing"
  return "none"
}
