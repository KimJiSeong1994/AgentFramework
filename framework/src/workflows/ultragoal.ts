// Ultragoal engine (P6b S2): pure stage transitions. The model only returns typed stage events (turn.ts); code decides
// progress. Evidence (checkpoints, receipts, the all-goal aggregate check) lives in ultragoal-evidence.ts and the turn
// loop in ultragoal-driver.ts. Nothing here can start work: a unit runs only after its own typed APPROVE-UNIT receipt,
// and the workflow is `done` only when EVERY goal of the fixed goal list has a re-verified complete checkpoint.
import { REGISTRY } from "./registry.ts"
import type { StageEvent } from "./turn.ts"
import {
  goalCheckpointKey, parseUltragoalData, UG_MAX_ATTEMPTS, UG_MAX_NO_PROGRESS, type UgCurrent, type UgPending, type UgStuck, type UltragoalData,
} from "./ultragoal-data.ts"
import { TERMINAL, type ArtifactRef, type Phase, type UltragoalWorkflow } from "./types.ts"

export type { UltragoalWorkflow }
export { UG_MAX_ATTEMPTS, UG_MAX_NO_PROGRESS }
export const ULTRAGOAL_STUCK_MARKER = "ULTRAGOAL-STUCK"

export const isUltragoal = (wf: { kind: string } | null | undefined): wf is UltragoalWorkflow => wf?.kind === "ultragoal"
export const ultragoalDataOf = (wf: UltragoalWorkflow): UltragoalData => parseUltragoalData(wf.data)

/** The exact text a human types to approve ONE unit. A ralplan EXECUTE confirmation is a different string and never matches. */
export function approveUnitConfirmation(workflowID: string, subjectSha: string): string {
  return `APPROVE-UNIT ${workflowID} ${subjectSha}`
}

// ---------------------------------------------------------------------------------------------- steps
export type UltragoalStep =
  | { kind: "turn"; stage: "decompose" | "unit_plan" | "unit_review" | "final_review" }
  | { kind: "select" }
  | { kind: "approval" }
  | { kind: "execute" }
  | { kind: "verify" }
  | { kind: "checkpoint" }
  | { kind: "blocked"; reason: string }
  | { kind: "done" }

/** The next code-owned step. Pure. Stuck, paused and stopping workflows do nothing. */
export function nextStep(wf: UltragoalWorkflow): UltragoalStep {
  if (TERMINAL.has(wf.phase)) return { kind: "done" }
  if (wf.stopIntent) return { kind: "blocked", reason: `${wf.stopIntent.kind} requested` }
  if (wf.phase === "paused") return { kind: "blocked", reason: "workflow is paused" }
  const data = ultragoalDataOf(wf)
  if (wf.phase === "stuck") return { kind: "blocked", reason: data.stuck?.reason ?? "workflow is stuck" }
  switch (wf.stage) {
    case "decompose": case "unit_plan": case "unit_review": case "final_review": return { kind: "turn", stage: wf.stage }
    case "goal_select": return { kind: "select" }
    case "unit_approval": return { kind: "approval" }
    case "unit_execute": return { kind: "execute" }
    case "verify": return { kind: "verify" }
    case "checkpoint": return { kind: "checkpoint" }
    case "terminal": return { kind: "done" }
  }
}

/** Goal ids in fixed order that have no complete checkpoint yet. */
export function openGoals(data: UltragoalData): string[] {
  return (data.goals?.ids ?? []).filter(id => data.progress[id]?.lastCheckpoint === undefined)
}

// ---------------------------------------------------------------------------------------------- typed event extraction
export type LaneParse<T> = { ok: true; value: T } | { ok: false; reason: string }

export function goalsOf(events: readonly StageEvent[]): LaneParse<Array<{ title: string; objective: string }>> {
  const only = events.length === 1 ? events[0]! : undefined
  return only?.type === "goals" ? { ok: true, value: only.goals } : { ok: false, reason: "expected exactly one goals event" }
}

export function unitPlanOf(events: readonly StageEvent[]): LaneParse<{ steps: Array<{ title: string; files: string[]; detail: string; verify: string }>; risks: string[] }> {
  const only = events.length === 1 ? events[0]! : undefined
  return only?.type === "unit_plan" ? { ok: true, value: { steps: only.steps, risks: only.risks } } : { ok: false, reason: "expected exactly one unit_plan event" }
}

export type UgVerdict = "OKAY" | "ITERATE" | "REJECT"
export function verdictOf(events: readonly StageEvent[], who: "architect" | "critic"): LaneParse<{ verdict: UgVerdict; findings: string[] }> {
  const only = events.length === 1 ? events[0]! : undefined
  if (only?.type !== "lane_verdict" || only.status !== undefined || only.decision !== undefined || !only.verdict) {
    return { ok: false, reason: `expected exactly one ${who} lane_verdict with verdict OKAY/ITERATE/REJECT` }
  }
  if (only.findings.length === 0 && only.verdict !== "OKAY") return { ok: false, reason: `${who} findings are required unless OKAY` }
  return { ok: true, value: { verdict: only.verdict, findings: only.findings } }
}

// ---------------------------------------------------------------------------------------------- pure reducer
export type UgEvent = { type: string; data?: Record<string, unknown> }
export type Transition = { wf: UltragoalWorkflow; events: UgEvent[] }
export type Hashed = ArtifactRef & { sha256: string }

export type UgAction =
  | { type: "goals_saved"; goals: Hashed; ids: string[] }
  | { type: "goal_selected"; goalId: string }
  | { type: "all_goals_complete" }
  | { type: "unit_prepared"; pending: UgPending; artifacts: Hashed[] }
  | { type: "unit_reviewed"; verdict: UgVerdict; findings: string[]; reviewRef: string; artifact: Hashed }
  | { type: "execution_approved"; current: UgCurrent }
  | { type: "unit_tasks_created"; taskIds: string[] }
  | { type: "unit_terminal" }
  | { type: "verification_recorded"; ref: string; ok: boolean; findings: string[] }
  | { type: "goal_checkpointed"; checkpoint: Hashed; complete: boolean }
  | { type: "final_rejected"; ref: string; verdict: UgVerdict; findings: string[] }
  | { type: "evidence_failed"; problems: string[] }
  | { type: "aggregate_verified"; completion: Hashed; ref: string }
  | { type: "attempt_failed"; reason: string; fatal?: boolean }
  | { type: "runner_failed"; reason: string }
  | { type: "retry" }

function arranged(existing: readonly ArtifactRef[], add: readonly ArtifactRef[]): ArtifactRef[] {
  const merged = new Map<string, ArtifactRef>()
  for (const ref of [...existing, ...add]) merged.set(ref.key, ref)
  return [...merged.values()]
}

function moved(wf: UltragoalWorkflow, stage: UltragoalWorkflow["stage"], phase: Phase, data: UltragoalData, artifacts: readonly ArtifactRef[]): UltragoalWorkflow {
  return { ...wf, stage, phase, data, artifacts: [...artifacts] } as UltragoalWorkflow
}

function assertLive(wf: UltragoalWorkflow): void {
  if (TERMINAL.has(wf.phase) || wf.phase === "paused" || wf.phase === "stuck") throw new Error(`ultragoal workflow is ${wf.phase}; no stage event applies`)
  if (wf.stopIntent) throw new Error(`ultragoal workflow ${wf.stopIntent.kind} is pending; no stage event applies`)
}

const phaseOf = (stage: UltragoalWorkflow["stage"]): Phase => REGISTRY.ultragoal.phaseOf(stage)
const clean = (data: UltragoalData): UltragoalData => { const { failure: _f, ...rest } = data; return { ...rest, attempts: 0 } }
const without = <K extends keyof UltragoalData>(data: UltragoalData, ...keys: K[]): UltragoalData => {
  const copy = { ...data }
  for (const key of keys) delete copy[key]
  return copy
}

function bump(data: UltragoalData, goalId: string): { data: UltragoalData; blocked: boolean } {
  const prior = data.progress[goalId]
  if (!prior) throw new Error(`goal ${goalId} is not in the fixed goal list`)
  const noProgress = prior.noProgress + 1
  return { data: { ...data, progress: { ...data.progress, [goalId]: { ...prior, noProgress } } }, blocked: noProgress >= UG_MAX_NO_PROGRESS }
}

function blockedStuck(goalId: string, evidence: string[]): UgStuck {
  return { kind: "goal_blocked", goalId, reason: `${ULTRAGOAL_STUCK_MARKER}: goal ${goalId} made no progress in ${UG_MAX_NO_PROGRESS} continuations; blocked, not complete`, evidence: evidence.slice(0, 16) }
}

/**
 * Pure transition. The driver validates model output, writes artifacts and receipts, then names them in the action.
 * Illegal combinations (wrong stage, a goal out of order, a changed subject, a complete checkpoint over failed
 * verification) throw and change nothing.
 */
export function reduce(wf: UltragoalWorkflow, action: UgAction): Transition {
  const data = ultragoalDataOf(wf)
  switch (action.type) {
    case "goals_saved": {
      assertLive(wf)
      if (wf.stage !== "decompose" || data.goals) throw new Error(`goals_saved is not valid in stage ${wf.stage}`)
      if (action.goals.key !== "goals.json" || action.ids.length < 1) throw new Error("goals_saved needs goals.json and at least one goal")
      const progress = Object.fromEntries(action.ids.map(id => [id, { noProgress: 0, attempt: 0 }]))
      return {
        wf: moved(wf, "goal_select", phaseOf("goal_select"), clean({ ...data, goals: { path: action.goals.path, sha256: action.goals.sha256, ids: action.ids }, progress }), arranged(wf.artifacts, [action.goals])),
        events: [{ type: "goals_saved", data: { goals: action.ids.length, sha256: action.goals.sha256 } }],
      }
    }
    case "goal_selected": {
      assertLive(wf)
      if (wf.stage !== "goal_select") throw new Error(`goal_selected is not valid in stage ${wf.stage}`)
      if (openGoals(data)[0] !== action.goalId) throw new Error(`goal ${action.goalId} is not the next open goal`)
      return { wf: moved(wf, "unit_plan", phaseOf("unit_plan"), clean({ ...data, selected: action.goalId }), wf.artifacts), events: [{ type: "goal_selected", data: { goalId: action.goalId } }] }
    }
    case "all_goals_complete": {
      assertLive(wf)
      if (wf.stage !== "goal_select" || !data.goals || openGoals(data).length > 0) throw new Error("final review needs every goal checkpointed complete")
      return { wf: moved(wf, "final_review", phaseOf("final_review"), clean(without(data, "selected")), wf.artifacts), events: [{ type: "all_goals_checkpointed", data: { goals: data.goals.ids.length } }] }
    }
    case "unit_prepared": {
      assertLive(wf)
      if (wf.stage !== "unit_plan" || !data.selected) throw new Error(`unit_prepared is not valid in stage ${wf.stage}`)
      const progress = data.progress[data.selected]!
      if (action.pending.goalId !== data.selected || action.pending.attempt !== progress.attempt + 1) throw new Error("unit does not name the selected goal and the next attempt")
      if (action.pending.artifacts.length === 0) throw new Error("a unit needs at least one bound document")
      return {
        wf: moved(wf, "unit_review", phaseOf("unit_review"), clean({ ...data, pending: action.pending, progress: { ...data.progress, [data.selected]: { ...progress, attempt: action.pending.attempt } } }), arranged(wf.artifacts, action.artifacts)),
        events: [{ type: "unit_prepared", data: { goalId: data.selected, attempt: action.pending.attempt, subject: action.pending.subject.sha256 } }],
      }
    }
    case "unit_reviewed": {
      assertLive(wf)
      if (wf.stage !== "unit_review" || !data.pending || !data.selected) throw new Error(`unit_reviewed is not valid in stage ${wf.stage}`)
      const artifacts = arranged(wf.artifacts, [action.artifact])
      const event: UgEvent = { type: "unit_reviewed", data: { goalId: data.selected, attempt: data.pending.attempt, verdict: action.verdict, subject: data.pending.subject.sha256 } }
      if (action.verdict === "OKAY") {
        return { wf: moved(wf, "unit_approval", phaseOf("unit_approval"), clean({ ...data, pending: { ...data.pending, reviewRef: action.reviewRef }, findings: [] }), artifacts), events: [event] }
      }
      // ITERATE / REJECT is a no-progress continuation of this goal (A2).
      const bumped = bump(data, data.selected)
      const next = clean(without({ ...bumped.data, findings: action.findings.slice(0, 12) }, "pending"))
      if (!bumped.blocked) return { wf: moved(wf, "unit_plan", phaseOf("unit_plan"), next, artifacts), events: [event] }
      const stuck = blockedStuck(data.selected, [action.reviewRef])
      return { wf: moved(wf, "unit_review", "stuck", { ...next, stuck }, artifacts), events: [event, { type: "goal_blocked", data: { goalId: data.selected, noProgress: UG_MAX_NO_PROGRESS } }] }
    }
    case "execution_approved": {
      assertLive(wf)
      if (wf.stage !== "unit_approval" || !data.pending) throw new Error(`execution_approved is not valid in stage ${wf.stage}`)
      const p = data.pending
      const c = action.current
      if (c.goalId !== p.goalId || c.attempt !== p.attempt || c.subject.sha256 !== p.subject.sha256 || c.subject.id !== p.subject.id || c.approval.subject.sha256 !== p.subject.sha256) throw new Error("approval names another unit")
      if (JSON.stringify(c.artifacts) !== JSON.stringify(p.artifacts) || !c.approval.receiptRef) throw new Error("approval does not bind the reviewed documents and a receipt")
      return {
        wf: moved(wf, "unit_execute", phaseOf("unit_execute"), clean(without({ ...data, current: c }, "pending")), wf.artifacts),
        events: [{ type: "execution_approved", data: { goalId: c.goalId, attempt: c.attempt, subject: c.subject.sha256, receipt: c.approval.receiptRef } }],
      }
    }
    case "unit_tasks_created": {
      assertLive(wf)
      if (wf.stage !== "unit_execute" || !data.current || data.current.taskIds.length > 0) throw new Error(`unit_tasks_created is not valid in stage ${wf.stage}`)
      if (action.taskIds.length !== data.current.input.scope.length) throw new Error("the unit's tasks do not match its steps")
      return { wf: moved(wf, wf.stage, wf.phase, { ...data, current: { ...data.current, taskIds: action.taskIds, remaining: action.taskIds } }, wf.artifacts), events: [{ type: "unit_tasks_created", data: { ids: action.taskIds } }] }
    }
    case "unit_terminal": {
      assertLive(wf)
      if (wf.stage !== "unit_execute" || !data.current || data.current.taskIds.length === 0) throw new Error(`unit_terminal is not valid in stage ${wf.stage}`)
      return { wf: moved(wf, "verify", phaseOf("verify"), { ...data, current: { ...data.current, done: data.current.taskIds, remaining: [] } }, wf.artifacts), events: [{ type: "unit_terminal", data: { goalId: data.current.goalId } }] }
    }
    case "verification_recorded": {
      assertLive(wf)
      if (wf.stage !== "verify" || !data.current || data.current.verification) throw new Error(`verification_recorded is not valid in stage ${wf.stage}`)
      return {
        wf: moved(wf, "checkpoint", phaseOf("checkpoint"), { ...data, findings: action.findings.slice(0, 12), current: { ...data.current, verification: { ref: action.ref, ok: action.ok } } }, wf.artifacts),
        events: [{ type: "verification_recorded", data: { goalId: data.current.goalId, attempt: data.current.attempt, ok: action.ok, receipt: action.ref } }],
      }
    }
    case "goal_checkpointed": {
      assertLive(wf)
      const current = data.current
      if (wf.stage !== "checkpoint" || !current?.verification) throw new Error(`goal_checkpointed is not valid in stage ${wf.stage}`)
      if (action.complete !== current.verification.ok) throw new Error("a checkpoint is complete only when its verification passed")
      if (action.checkpoint.key !== goalCheckpointKey(current.goalId, current.attempt)) throw new Error("checkpoint does not name this goal attempt")
      const prior = data.progress[current.goalId]!
      const artifacts = arranged(wf.artifacts, [action.checkpoint])
      const event: UgEvent = { type: "goal_checkpointed", data: { goalId: current.goalId, attempt: current.attempt, complete: action.complete, checkpoint: action.checkpoint.sha256 } }
      const rest = without(data, "current", "selected")
      if (action.complete) {
        const progress = { ...data.progress, [current.goalId]: { ...prior, noProgress: 0, lastCheckpoint: action.checkpoint.key, lastAttemptCheckpoint: action.checkpoint.key } }
        return { wf: moved(wf, "goal_select", phaseOf("goal_select"), clean({ ...rest, progress, findings: [] }), artifacts), events: [event] }
      }
      const bumped = bump({ ...data, progress: { ...data.progress, [current.goalId]: { ...prior, lastAttemptCheckpoint: action.checkpoint.key } } }, current.goalId)
      if (!bumped.blocked) {
        return { wf: moved(wf, "unit_plan", phaseOf("unit_plan"), clean({ ...without(bumped.data, "current"), selected: current.goalId }), artifacts), events: [event] }
      }
      const stuck = blockedStuck(current.goalId, [action.checkpoint.key, current.verification.ref])
      return {
        wf: moved(wf, "checkpoint", "stuck", { ...without(bumped.data, "current"), selected: current.goalId, stuck }, artifacts),
        events: [event, { type: "goal_blocked", data: { goalId: current.goalId, noProgress: UG_MAX_NO_PROGRESS } }],
      }
    }
    case "final_rejected": {
      assertLive(wf)
      if (wf.stage !== "final_review") throw new Error(`final_rejected is not valid in stage ${wf.stage}`)
      if (action.verdict === "OKAY") throw new Error("an OKAY final verdict is not a rejection")
      const stuck: UgStuck = { kind: "final_review", reason: `${ULTRAGOAL_STUCK_MARKER}: final review ${action.verdict}: ${action.findings[0] ?? "no findings"}`.slice(0, 1_000), evidence: [action.ref] }
      return { wf: moved(wf, "final_review", "stuck", { ...data, findings: action.findings.slice(0, 12), stuck }, wf.artifacts), events: [{ type: "final_rejected", data: { verdict: action.verdict } }, { type: "stuck", data: { stage: wf.stage, kind: "final_review" } }] }
    }
    case "evidence_failed": {
      assertLive(wf)
      if (wf.stage !== "final_review") throw new Error(`evidence_failed is not valid in stage ${wf.stage}`)
      const stuck: UgStuck = { kind: "evidence", reason: `${ULTRAGOAL_STUCK_MARKER}: goal proof does not re-verify: ${action.problems[0] ?? "unknown"}`.slice(0, 1_000), evidence: action.problems.slice(0, 16).map(item => item.slice(0, 1_000)) }
      return { wf: moved(wf, "final_review", "stuck", { ...data, stuck }, wf.artifacts), events: [{ type: "stuck", data: { stage: wf.stage, kind: "evidence" } }] }
    }
    case "aggregate_verified": {
      assertLive(wf)
      if (wf.stage !== "final_review" || !data.goals || openGoals(data).length > 0) throw new Error("aggregate completion needs every goal checkpointed complete")
      if (action.completion.key !== "completion.json") throw new Error("aggregate completion needs completion.json")
      return {
        wf: moved(wf, "terminal", "done", { ...data, final: { ref: action.ref }, completion: { path: action.completion.path, sha256: action.completion.sha256 } }, arranged(wf.artifacts, [action.completion])),
        events: [{ type: "aggregate_verified", data: { goals: data.goals.ids.length, completion: action.completion.sha256, receipt: action.ref } }],
      }
    }
    case "attempt_failed": {
      assertLive(wf)
      if (wf.stage !== "decompose" && wf.stage !== "unit_plan" && wf.stage !== "unit_review" && wf.stage !== "final_review") throw new Error(`stage ${wf.stage} has no model attempt`)
      const attempts = action.fatal ? UG_MAX_ATTEMPTS : data.attempts + 1
      const reason = action.reason.slice(0, 900) || "attempt failed"
      const failed: UgEvent = { type: "attempt_failed", data: { stage: wf.stage, attempts, reason } }
      if (attempts < UG_MAX_ATTEMPTS) return { wf: moved(wf, wf.stage, wf.phase, { ...data, attempts, failure: reason }, wf.artifacts), events: [failed] }
      const stuck: UgStuck = { kind: "attempts", reason: `${wf.stage} failed ${attempts} times: ${reason}`.slice(0, 1_000), evidence: [] }
      return { wf: moved(wf, wf.stage, "stuck", { ...data, attempts, failure: reason, stuck }, wf.artifacts), events: [failed, { type: "stuck", data: { stage: wf.stage, kind: "attempts" } }] }
    }
    case "runner_failed": {
      // The queue run of an approved unit failed for a reason that is not a stop: visible stuck at unit_execute, never silent.
      if (wf.stage !== "unit_execute" || wf.phase !== "executing") throw new Error(`runner_failed is not valid in stage ${wf.stage}`)
      const stuck: UgStuck = { kind: "runner", reason: `${ULTRAGOAL_STUCK_MARKER}: unit run failed: ${action.reason}`.slice(0, 1_000), evidence: [] }
      return { wf: moved(wf, wf.stage, "stuck", { ...data, stuck }, wf.artifacts), events: [{ type: "stuck", data: { stage: wf.stage, kind: "runner" } }] }
    }
    case "retry": {
      if (wf.phase !== "stuck" || wf.stage === "terminal" || wf.stopIntent) throw new Error("only a workflow stuck at a live stage can retry")
      if (data.stuck?.kind === "goal_blocked") throw new Error("a blocked goal cannot be retried; cancel and start over")
      const { stuck: _stuck, ...rest } = data
      return { wf: moved(wf, wf.stage, phaseOf(wf.stage), clean(rest), wf.artifacts), events: [{ type: "retry", data: { stage: wf.stage } }] }
    }
  }
}
