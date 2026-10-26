// Deep-interview engine (P6a S2). A pure state machine over the generic workflow envelope: `reduce` applies one typed
// code-owned event to a committed `deep-interview` workflow and returns the next envelope, its commit events and the
// receipts the commit must verify. The model never reaches this module: the driver (deep-interview-driver.ts) parses
// typed stage output, writes artifacts and receipts, and hands `reduce` facts. Ambiguity, bands, panel requirements,
// attempt counting and routing are all computed here from typed fields; nothing a model says can set them. The only
// I/O is read-only verification of receipts and of the spec file.
import { createHash } from "node:crypto"
import { verifyArtifact } from "./artifacts.ts"
import type { CommitEvent } from "./commit.ts"
import { verifyReceiptRef } from "./receipts.ts"
import { REGISTRY } from "./registry.ts"
import {
  BANDS, BASE_PERSONAS, DI_EARLY_EXIT_ROUND, DI_MAX_ATTEMPTS, DI_MAX_ANSWER_CHARS, DI_MAX_ROUNDS, DI_ONTOLOGY_ROUND, DI_STALL_SPREAD, DI_THRESHOLD, dataOf,
  agendaProgress, nextAgenda, questionBudgetReached, questionLimit,
  type Band, type Component, type DeepInterviewData, type Dimensions, type PendingPanel, type Persona, type ProjectType, type RoundRecord,
} from "./deep-interview-data.ts"
import type { DeepInterviewStage, DeepInterviewWorkflow, Phase } from "./types.ts"

export * from "./deep-interview-data.ts"

const isClarity = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
const round6 = (value: number) => Math.round(value * 1e6) / 1e6

/**
 * Brownfield: 1 - (goal*.35 + constraints*.25 + criteria*.25 + context*.15). Greenfield normalizes the first three to
 * .40/.30/.30. A non-finite or out-of-range input throws; the caller records an attempt failure and no score.
 */
export function ambiguityOf(type: ProjectType, dims: Dimensions): number {
  if (!isClarity(dims.goal) || !isClarity(dims.constraints) || !isClarity(dims.criteria)) throw new RangeError("clarity scores must be finite numbers within [0,1]")
  if (type === "brownfield") {
    if (!isClarity(dims.context)) throw new RangeError("brownfield scoring requires a context clarity within [0,1]")
    return round6(1 - (dims.goal * 0.35 + dims.constraints * 0.25 + dims.criteria * 0.25 + dims.context * 0.15))
  }
  return round6(1 - (dims.goal * 0.4 + dims.constraints * 0.3 + dims.criteria * 0.3))
}

/** initial > .60; progress .30 < a <= .60; refined threshold < a <= .30; ready <= threshold. */
export function bandOf(ambiguity: number, threshold: number = DI_THRESHOLD): Band {
  if (ambiguity > 0.6) return "initial"
  if (ambiguity > 0.3) return "progress"
  if (ambiguity > threshold) return "refined"
  return "ready"
}

/** Spread of the last three scored ambiguities is at most .05 (still above threshold), or round >= 8 with ambiguity still > .30. */
export function stalled(history: readonly number[], round: number, threshold: number = DI_THRESHOLD): boolean {
  const last = history.at(-1)
  if (last === undefined) return false
  if (round >= DI_ONTOLOGY_ROUND && last > 0.3) return true
  if (history.length < 3 || last <= threshold) return false
  const window = history.slice(-3)
  return Math.max(...window) - Math.min(...window) <= DI_STALL_SPREAD + 1e-9
}

export type PanelRequirement = { personas: readonly Persona[]; ontology: boolean; triggers: readonly string[] }

/**
 * Which independent personas a scored round requires, or null. A band change in either direction, a synthesized
 * (agent-supplied) answer or a system-shape change convenes researcher/contrarian/simplifier; shape change and stall
 * add the architect; a stall (or > .30 after round 8) adds ontology escalation.
 */
export function panelRequirement(input: {
  prevBand: Band | undefined
  band: Band
  history: readonly number[]
  round: number
  threshold?: number
  shapeChange: boolean
  synthesized: boolean
}): PanelRequirement | null {
  const triggers: string[] = []
  if (input.prevBand !== undefined && input.prevBand !== input.band) triggers.push(`band:${input.prevBand}->${input.band}`)
  if (input.synthesized) triggers.push("synthesized-answer")
  if (input.shapeChange) triggers.push("shape-change")
  const stall = stalled(input.history, input.round, input.threshold ?? DI_THRESHOLD)
  if (stall) triggers.push("stall")
  if (triggers.length === 0) return null
  const architect = input.shapeChange || stall
  return { personas: architect ? [...BASE_PERSONAS, "architect"] : BASE_PERSONAS, ontology: stall, triggers }
}

export const sha256Text = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

export const roundFileRelative = (sessionID: string, workflowID: string, n: number, part: "question" | "answer"): string =>
  `.otter/workflows/${sessionID}/${workflowID}/rounds/${n}-${part}.md`
export const specRelative = (sessionID: string, workflowID: string): string => `.otter/workflows/${sessionID}/${workflowID}/spec.md`

const lastScored = (d: DeepInterviewData): RoundRecord | undefined => [...d.rounds].reverse().find(r => r.ambiguity !== undefined)

// ------------------------------------------------------------------------------------------------ steps
export type DiStep =
  | { kind: "topology" }
  | { kind: "question"; round: number }
  | { kind: "await_answer"; round: number }
  | { kind: "scoring"; round: number }
  | { kind: "panel"; persona: Persona; pending: PendingPanel }
  | { kind: "cap_choice"; round: number; ambiguity: number }
  | { kind: "closure"; round: number }
  | { kind: "restate" }
  | { kind: "crystallize" }
  | { kind: "stuck"; item: string; reason: string }
  | { kind: "done"; spec: { path: string; sha256: string } | undefined }
  | { kind: "blocked"; reason: string }

/** A persona's receipt counts only when it reads back bound to this workflow, panel kind, input hash, round and persona. */
export function panelReceiptValid(worktree: string, wf: Pick<DeepInterviewWorkflow, "id" | "sessionID">, pending: PendingPanel, persona: Persona): boolean {
  const ref = pending.results[persona]
  if (ref === undefined) return false
  const read = verifyReceiptRef(worktree, ref, { sessionID: wf.sessionID, workflowID: wf.id, kind: "panel", inputSha: pending.inputSha })
  return read.ok && read.receipt.body.round === pending.round && read.receipt.body.persona === persona
}

/** Personas with a recorded result whose receipt no longer verifies (deleted, tampered, wrong round/input). */
export function panelInvalid(worktree: string, wf: Pick<DeepInterviewWorkflow, "id" | "sessionID">, pending: PendingPanel): Persona[] {
  return pending.personas.filter(persona => pending.results[persona] !== undefined && !panelReceiptValid(worktree, wf, pending, persona))
}

/** The one thing the driver must do next. Pure over committed state plus read-only receipt verification. */
export function nextStep(wf: DeepInterviewWorkflow, worktree: string): DiStep {
  const d = dataOf(wf)
  if (wf.phase === "done") return { kind: "done", spec: d.specRef }
  if (wf.phase === "cancelled") return { kind: "blocked", reason: "workflow is cancelled" }
  if (wf.stopIntent) return { kind: "blocked", reason: `workflow ${wf.stopIntent.kind} is ${wf.phase === "paused" ? "settled" : "pending"}` }
  if (wf.phase === "paused") return { kind: "blocked", reason: "workflow is paused" }
  if (wf.phase === "stuck") return { kind: "stuck", item: d.stuck?.item ?? wf.stage, reason: d.stuck?.reason ?? "stuck" }
  const pending = d.pendingPanel
  if (pending && (wf.stage === "panel" || wf.stage === "question" || wf.stage === "closure")) {
    const invalid = panelInvalid(worktree, wf, pending)
    if (invalid.length > 0) return { kind: "blocked", reason: `panel receipt for ${invalid.join(", ")} no longer verifies` }
  }
  switch (wf.stage) {
    case "intake": case "topology": return { kind: "topology" }
    case "question":
      if (d.cap && !d.cap.decided) return { kind: "cap_choice", round: d.cap.round, ambiguity: d.cap.ambiguity }
      if (questionBudgetReached(d)) return { kind: "blocked", reason: "the question budget is reached; no further question is asked" }
      return { kind: "question", round: d.round + 1 }
    case "answer": return { kind: "await_answer", round: d.round }
    case "scoring": return { kind: "scoring", round: d.round }
    case "panel": {
      if (!pending) return { kind: "blocked", reason: "panel stage without a pending panel" }
      const next = pending.personas.find(persona => pending.results[persona] === undefined)
      return next ? { kind: "panel", persona: next, pending } : { kind: "blocked", reason: "panel is complete but not routed" }
    }
    case "closure": return { kind: "closure", round: d.round }
    case "restate": return { kind: "restate" }
    case "crystallize": return { kind: "crystallize" }
    case "terminal": return { kind: "blocked", reason: "workflow is terminal" }
    default: return { kind: "blocked", reason: `unknown stage ${String(wf.stage)}` }
  }
}

// ------------------------------------------------------------------------------------------------ transitions
export type DiEvent =
  | { type: "topology_confirmed"; projectType: ProjectType; components: Component[]; receiptRef: string }
  | { type: "question_asked"; round: number; questionSha: string; questionKey?: string }
  | { type: "answer_recorded"; round: number; answerSha: string; chars: number; source: "user" | "agent" }
  | { type: "scores_recorded"; round: number; scores: Dimensions; weakest: string; shapeChange: boolean; evidence: string[]; synthesized?: boolean }
  | { type: "panel_result"; persona: Persona; receiptRef: string }
  | { type: "cap_decided"; choice: "crystallize" | "exit"; receiptRef: string }
  | { type: "early_exit_confirmed"; receiptRef: string }
  | { type: "closure_result"; pass: boolean; gaps: string[]; agendaIDs?: string[]; receiptRef: string }
  | { type: "restatement_confirmed"; goal: string; receiptRef: string }
  | { type: "restatement_missing_scope"; receiptRef: string }
  | { type: "spec_written"; path: string; sha256: string }
  | { type: "stuck"; item: string; reason: string; evidence: string[] }
  | { type: "retry" }
  /** One failed attempt of `item`; the second consecutive failure (or a fatal one) makes the workflow stuck. */
  | { type: "attempt_failed"; item: string; reason: string; fatal?: boolean }

export type ReduceContext = { worktree: string; now?: number }
export type ReduceResult =
  | { ok: true; wf: DeepInterviewWorkflow; events: CommitEvent[]; receipts: string[] }
  | { ok: false; text: string }

const refuse = (text: string): ReduceResult => ({ ok: false, text })
const ACTIVE_STAGES: readonly DeepInterviewStage[] = ["topology", "question", "answer", "scoring", "panel", "closure", "restate", "crystallize"]

/** Hash a panel's shared input: every persona of a round receives and binds exactly this. */
export function panelInputSha(wf: Pick<DeepInterviewWorkflow, "id">, d: DeepInterviewData, round: RoundRecord, requirement: PanelRequirement): string {
  return sha256Text(JSON.stringify({
    wid: wf.id, round: round.n, ambiguity: round.ambiguity, band: round.band, triggers: requirement.triggers, personas: requirement.personas,
    ontology: requirement.ontology, q: round.questionSha, a: round.answerSha, components: d.topology.components,
    ...(d.questionPolicy ? { agendaID: round.agendaID, evidence: round.evidence, agendas: agendaProgress(d) } : {}),
  }))
}

/** Closure audits the locked request and the confirmed components; the receipt binds this hash. */
export function closureInputSha(wf: Pick<DeepInterviewWorkflow, "id">, d: DeepInterviewData): string {
  const last = lastScored(d)
  return sha256Text(JSON.stringify({ wid: wf.id, round: d.round, request: d.request, type: d.type, components: d.topology.components, ambiguity: last?.ambiguity, a: last?.answerSha, gaps: d.gaps,
    ...(d.questionPolicy ? { policy: d.questionPolicy, agendas: agendaProgress(d), reopenAgendaIDs: d.reopenAgendaIDs, evidence: d.rounds.map(r => r.evidence ?? []) } : {}) }))
}

export const restatementInputSha = (goal: string): string => sha256Text(goal)
export const topologyInputSha = (projectType: ProjectType, components: readonly Component[]): string => sha256Text(JSON.stringify({ projectType, components }))
export const choiceInputSha = (wf: Pick<DeepInterviewWorkflow, "id">, subject: string, round: number): string => sha256Text(JSON.stringify({ wid: wf.id, subject, round }))

/** Final ambiguity of the last scored round, or undefined before any scoring. */
export function finalAmbiguity(d: DeepInterviewData): number | undefined {
  if (d.questionPolicy && d.rounds.some(round => round.ambiguity !== undefined)) return Math.max(...agendaProgress(d).map(item => item.ambiguity ?? 1))
  return lastScored(d)?.ambiguity
}

/** `/finish` eligibility: from round 3, above threshold, only at a point where no panel or scoring is in flight. */
export function earlyExitRefusal(wf: DeepInterviewWorkflow): string | undefined {
  const d = dataOf(wf)
  if (wf.phase !== "planning" && wf.phase !== "reviewing") return `cannot finish while the interview is ${wf.phase}`
  if (wf.stopIntent) return `workflow ${wf.stopIntent.kind} is pending`
  if (d.earlyExit) return "early exit is already recorded; closure and restatement still run"
  const earliest = d.questionPolicy ? 1 : DI_EARLY_EXIT_ROUND
  if (d.round < earliest) return `early exit is available from round ${earliest}; answer the current question`
  if (wf.stage !== "answer" && wf.stage !== "question") return "panels, scoring and closure cannot be bypassed; wait for the current step to complete"
  const ambiguity = finalAmbiguity(d)
  if (ambiguity === undefined) return "no scored round yet"
  if (ambiguity <= d.threshold) return "ambiguity is already at or below the threshold; closure follows"
  return undefined
}

function withData(wf: DeepInterviewWorkflow, stage: DeepInterviewStage | "terminal", phase: Phase | undefined, data: DeepInterviewData, patch: Partial<DeepInterviewWorkflow> = {}): DeepInterviewWorkflow {
  const target = phase ?? REGISTRY["deep-interview"].phaseOf(stage)
  const { pausedFrom: _pf, ...rest } = wf
  return { ...rest, ...patch, stage, phase: target, data: data as unknown as DeepInterviewWorkflow["data"] } as DeepInterviewWorkflow
}

const ev = (wf: DeepInterviewWorkflow, type: string, actor: CommitEvent["actor"], from: string, to: string, data?: Record<string, unknown>): CommitEvent =>
  ({ wf: wf.id, type, actor, from, to, ...(data ? { data } : {}) })

/** A receipt must read back bound to this workflow, kind, input hash and revision; `action` is an exact name or a `prefix*`. */
function receiptOk(worktree: string, wf: DeepInterviewWorkflow, ref: string, expect: { kind: "panel" | "choice"; inputSha: string; action: string }): { error: string } | { body: Readonly<Record<string, unknown>> } {
  const prefix = expect.action.endsWith("*")
  const read = verifyReceiptRef(worktree, ref, {
    sessionID: wf.sessionID, workflowID: wf.id, kind: expect.kind, inputSha: expect.inputSha, revision: wf.lastSeq, ...(prefix ? {} : { action: expect.action }),
  })
  if (!read.ok) return { error: `receipt ${expect.action} refused: ${read.reason}` }
  if (prefix && !read.receipt.action.startsWith(expect.action.slice(0, -1))) return { error: `receipt ${expect.action} refused: receipt action mismatch` }
  return { body: read.receipt.body }
}

function panelsComplete(worktree: string, wf: DeepInterviewWorkflow, d: DeepInterviewData): string | undefined {
  if (!d.pendingPanel) return undefined
  const missing = d.pendingPanel.personas.filter(persona => !panelReceiptValid(worktree, wf, d.pendingPanel!, persona))
  return missing.length === 0 ? undefined : `required panel record missing or invalid for ${missing.join(", ")}`
}

/** Next stage after a scored round (and its panel, if one was required). */
function routeScored(wf: DeepInterviewWorkflow, d: DeepInterviewData, ambiguity: number): { stage: DeepInterviewStage; data: DeepInterviewData } {
  const overall = finalAmbiguity(d) ?? ambiguity
  if (overall <= d.threshold) return { stage: "closure", data: d }
  if (questionBudgetReached(d)) return { stage: "question", data: { ...d, cap: { round: d.round, ambiguity: overall, decided: false } } }
  return { stage: "question", data: d }
}

/** Closure can reopen a decision, but cannot grant another question budget. */
function reopen(d: DeepInterviewData): DeepInterviewData {
  return questionBudgetReached(d) ? { ...d, cap: { round: d.round, ambiguity: finalAmbiguity(d) ?? 1, decided: false } } : d
}

/**
 * Apply one code-owned event to a committed workflow. Pure apart from read-only receipt/file verification. A refusal
 * changes nothing; every success returns the whole next envelope, its commit events and the receipts to verify.
 */
export function reduce(wf: DeepInterviewWorkflow, event: DiEvent, ctx: ReduceContext): ReduceResult {
  const result = reduceInner(wf, event, ctx)
  if (!result.ok || event.type === "attempt_failed") return result
  // Any other transition clears the attempt counter.
  const { attempt: _a, ...rest } = dataOf(result.wf)
  return { ...result, wf: { ...result.wf, data: rest as unknown as DeepInterviewWorkflow["data"] } }
}

function reduceInner(wf: DeepInterviewWorkflow, event: DiEvent, ctx: ReduceContext): ReduceResult {
  let d: DeepInterviewData
  try { d = dataOf(wf) } catch (error) { return refuse((error as Error).message) }
  if (wf.phase === "done" || wf.phase === "cancelled") return refuse(`workflow is ${wf.phase}`)
  if (wf.stopIntent) return refuse(`workflow ${wf.stopIntent.kind} is pending`)
  if (wf.phase === "paused") return refuse("workflow is paused")
  const stage = wf.stage
  const from = wf.phase
  if (event.type === "retry") {
    if (wf.phase !== "stuck") return refuse("workflow is not stuck")
    const { stuck: _s, ...rest } = d
    return { ok: true, wf: withData(wf, stage, undefined, rest), events: [ev(wf, "retry", "user_command", from, REGISTRY["deep-interview"].phaseOf(stage), { item: d.stuck?.item })], receipts: [] }
  }
  if (wf.phase === "stuck") return refuse("workflow is stuck; retry first")
  if (event.type === "attempt_failed") {
    if (!ACTIVE_STAGES.includes(stage as DeepInterviewStage)) return refuse(`cannot fail an attempt at stage ${stage}`)
    const prior = d.attempt?.item === event.item ? d.attempt : undefined
    const count = event.fatal ? DI_MAX_ATTEMPTS : (prior?.count ?? 0) + 1
    const reasons = [...(prior?.reasons ?? []), event.reason.slice(0, 300)].slice(-8)
    if (count < DI_MAX_ATTEMPTS) {
      return { ok: true, wf: withData(wf, stage, from, { ...d, attempt: { item: event.item, count, reasons } }), events: [ev(wf, "attempt_failed", "code", from, from, { item: event.item, count, reason: event.reason.slice(0, 300) })], receipts: [] }
    }
    return reduceInner(wf, { type: "stuck", item: event.item, reason: `${event.item} failed ${count} time(s): ${event.reason}`, evidence: reasons }, ctx)
  }
  if (event.type === "stuck") {
    if (!ACTIVE_STAGES.includes(stage as DeepInterviewStage)) return refuse(`cannot get stuck at stage ${stage}`)
    const next: DeepInterviewData = {
      ...d, stuck: { item: event.item, reason: event.reason.slice(0, 500), evidence: event.evidence.slice(0, 8).map(item => item.slice(0, 500)) },
      panelFailures: d.panelFailures + (stage === "panel" ? 1 : 0),
    }
    return { ok: true, wf: withData(wf, stage, "stuck", next), events: [ev(wf, "stuck", "code", from, "stuck", { item: event.item, reason: event.reason, evidence: next.stuck!.evidence })], receipts: [] }
  }

  switch (event.type) {
    case "topology_confirmed": {
      if (stage !== "topology" && stage !== "intake") return refuse(`topology_confirmed is not valid at stage ${stage}`)
      if (d.topology.confirmed) return refuse("topology is confirmed exactly once")
      if (event.components.length === 0 || event.components.length > 16) return refuse("topology needs 1-16 components")
      if (new Set(event.components.map(component => component.id)).size !== event.components.length) return refuse("task agenda ids must be unique")
      const bad = receiptOk(ctx.worktree, wf, event.receiptRef, { kind: "choice", inputSha: topologyInputSha(event.projectType, event.components), action: "choice-topology" })
      if ("error" in bad) return refuse(bad.error)
      const next: DeepInterviewData = { ...d, type: event.projectType, topology: { confirmed: true, components: event.components, receiptRef: event.receiptRef } }
      return {
        ok: true, wf: withData(wf, "question", undefined, next),
        events: [ev(wf, "topology_confirmed", "user_command", from, "planning", { type: event.projectType, components: event.components.map(c => c.id) })], receipts: [event.receiptRef],
      }
    }
    case "question_asked": {
      if (stage !== "question") return refuse(`question_asked is not valid at stage ${stage}`)
      if (!d.topology.confirmed) return refuse("topology must be confirmed before any question")
      if (d.cap && !d.cap.decided) return refuse("the round cap needs a Crystallize/Exit decision before anything else")
      if (questionBudgetReached(d) || event.round !== d.round + 1) return refuse(`question round ${event.round} is not the next round or exceeds its agenda budget`)
      if (event.questionKey !== undefined && (event.questionKey.length > 2000 || !event.questionKey.trim())) return refuse("invalid question key")
      const agenda = nextAgenda(d)
      if (d.questionPolicy && event.questionKey && d.rounds.some(round => round.agendaID === agenda?.id && round.questionKey === event.questionKey)) return refuse("this agenda question was already asked; use the recorded answer")
      const incomplete = panelsComplete(ctx.worktree, wf, d)
      if (incomplete) return refuse(incomplete)
      const { pendingPanel: _p, ...rest } = d
      const next: DeepInterviewData = { ...rest, round: event.round, rounds: [...d.rounds, { n: event.round, questionSha: event.questionSha,
        ...(agenda ? { agendaID: agenda.id } : {}), ...(event.questionKey ? { questionKey: event.questionKey } : {}) }] }
      return { ok: true, wf: withData(wf, "answer", undefined, next), events: [ev(wf, "question_asked", "code", from, "planning", { round: event.round, questionSha: event.questionSha })], receipts: [] }
    }
    case "answer_recorded": {
      if (stage !== "answer") return refuse(`answer_recorded is not valid at stage ${stage}`)
      if (event.source !== "user") return refuse("only a user answer can be recorded; agent-supplied answers are not accepted")
      if (event.round !== d.round || event.chars <= 0 || event.chars > DI_MAX_ANSWER_CHARS) return refuse("answer does not match the open round or exceeds the size limit")
      const rounds = d.rounds.map(r => r.n === event.round ? { ...r, answerSha: event.answerSha } : r)
      return { ok: true, wf: withData(wf, "scoring", undefined, { ...d, rounds }), events: [ev(wf, "answer_recorded", "user_message", from, "planning", { round: event.round, answerSha: event.answerSha, chars: event.chars })], receipts: [] }
    }
    case "scores_recorded": {
      if (stage !== "scoring") return refuse(`scores_recorded is not valid at stage ${stage}`)
      if (!d.type || event.round !== d.round) return refuse("scores do not match the open round")
      let ambiguity: number
      try { ambiguity = ambiguityOf(d.type, event.scores) } catch (error) { return refuse((error as Error).message) }
      const band = bandOf(ambiguity, d.threshold)
      const active = d.rounds.find(r => r.n === event.round)
      const scored = d.rounds.filter(r => r.ambiguity !== undefined && (!d.questionPolicy || r.agendaID === active?.agendaID))
      const prev = scored.at(-1)
      const scores: Dimensions = d.type === "brownfield" ? event.scores : { goal: event.scores.goal, constraints: event.scores.constraints, criteria: event.scores.criteria }
      const rounds = d.rounds.map(r => r.n === event.round ? { ...r, scores, weakest: event.weakest, ambiguity, band, shapeChange: event.shapeChange,
        evidence: event.evidence.slice(0, 8).map(item => item.slice(0, 500)) } : r)
      const record = rounds.find(r => r.n === event.round)!
      const requirement = panelRequirement({
        prevBand: prev?.band, band, history: [...scored.map(r => r.ambiguity!), ambiguity], round: d.questionPolicy ? scored.length + 1 : event.round, threshold: d.threshold,
        shapeChange: event.shapeChange, synthesized: event.synthesized === true,
      })
      const base: DeepInterviewData = { ...d, rounds }
      const events = [ev(wf, "scores_recorded", "code", from, "planning", { round: event.round, ambiguity, band, threshold: d.threshold, weakest: event.weakest })]
      if (requirement) {
        const pending: PendingPanel = {
          round: event.round, inputSha: panelInputSha(wf, base, record, requirement), triggers: [...requirement.triggers],
          personas: [...requirement.personas], ontology: requirement.ontology, results: {},
        }
        events.push(ev(wf, "panel_required", "code", "planning", "reviewing", { round: event.round, personas: pending.personas, triggers: pending.triggers, ontology: pending.ontology, inputSha: pending.inputSha }))
        return { ok: true, wf: withData(wf, "panel", undefined, { ...base, pendingPanel: pending }), events, receipts: [] }
      }
      const routed = routeScored(wf, base, ambiguity)
      return { ok: true, wf: withData(wf, routed.stage, undefined, routed.data), events, receipts: [] }
    }
    case "panel_result": {
      const pending = d.pendingPanel
      if (stage !== "panel" || !pending) return refuse(`panel_result is not valid at stage ${stage}`)
      if (!pending.personas.includes(event.persona)) return refuse(`${event.persona} is not a required persona of this panel`)
      if (pending.results[event.persona] !== undefined) return refuse(`${event.persona} already has a record for this panel`)
      const updated: PendingPanel = { ...pending, results: { ...pending.results, [event.persona]: event.receiptRef } }
      if (!panelReceiptValid(ctx.worktree, wf, updated, event.persona)) return refuse(`panel record for ${event.persona} is not bound to round ${pending.round} and this input`)
      const events = [ev(wf, "panel_result", "code", from, "reviewing", { round: pending.round, persona: event.persona, receiptRef: event.receiptRef })]
      const done = pending.personas.every(persona => updated.results[persona] !== undefined)
      if (!done) return { ok: true, wf: withData(wf, "panel", undefined, { ...d, pendingPanel: updated }), events, receipts: [event.receiptRef] }
      const incomplete = panelsComplete(ctx.worktree, wf, { ...d, pendingPanel: updated })
      if (incomplete) return refuse(incomplete)
      const ambiguity = finalAmbiguity(d)!
      const history = { round: updated.round, inputSha: updated.inputSha, personas: [...updated.personas], results: { ...updated.results } }
      const routed = routeScored(wf, { ...d, pendingPanel: updated, panels: [...d.panels.filter(item => item.round !== updated.round), history], lateralReviews: d.lateralReviews + 1 }, ambiguity)
      events.push(ev(wf, "panel_complete", "code", "reviewing", routed.stage, { round: pending.round, next: routed.stage }))
      return { ok: true, wf: withData(wf, routed.stage, undefined, routed.data), events, receipts: [event.receiptRef] }
    }
    case "cap_decided": {
      if (stage !== "question" || !d.cap || d.cap.decided) return refuse("no round-cap decision is pending")
      const bad = receiptOk(ctx.worktree, wf, event.receiptRef, { kind: "choice", inputSha: choiceInputSha(wf, "cap", d.cap.round), action: "choice-cap" })
      if ("error" in bad) return refuse(bad.error)
      if (bad.body.choice !== event.choice) return refuse("cap decision does not match its receipt")
      if (event.choice === "exit") {
        return {
          ok: true, wf: withData(wf, "terminal", "cancelled", { ...d, cap: { ...d.cap, decided: true } }),
          events: [ev(wf, "cap_exit", "user_command", from, "cancelled", { round: d.cap.round, ambiguity: d.cap.ambiguity })], receipts: [event.receiptRef],
        }
      }
      const next: DeepInterviewData = { ...d, cap: { ...d.cap, decided: true }, earlyExit: { round: d.cap.round, ambiguity: d.cap.ambiguity, reason: "cap", receiptRef: event.receiptRef } }
      return { ok: true, wf: withData(wf, "closure", undefined, next), events: [ev(wf, "cap_crystallize", "user_command", from, "reviewing", { round: d.cap.round })], receipts: [event.receiptRef] }
    }
    case "early_exit_confirmed": {
      const refusal = earlyExitRefusal(wf)
      if (refusal) return refuse(refusal)
      const incomplete = panelsComplete(ctx.worktree, wf, d)
      if (incomplete) return refuse(incomplete)
      const ambiguity = finalAmbiguity(d)!
      const bad = receiptOk(ctx.worktree, wf, event.receiptRef, { kind: "choice", inputSha: choiceInputSha(wf, "early-exit", d.round), action: "choice-early-exit" })
      if ("error" in bad) return refuse(bad.error)
      const next: DeepInterviewData = { ...d, earlyExit: { round: d.round, ambiguity, reason: "finish", receiptRef: event.receiptRef } }
      return {
        ok: true, wf: withData(wf, "closure", undefined, next),
        events: [ev(wf, "early_exit_confirmed", "user_command", from, "reviewing", { round: d.round, ambiguity, threshold: d.threshold, warning: "ambiguity above threshold" })], receipts: [event.receiptRef],
      }
    }
    case "closure_result": {
      if (stage !== "closure") return refuse(`closure_result is not valid at stage ${stage}`)
      const incomplete = panelsComplete(ctx.worktree, wf, d)
      if (incomplete) return refuse(incomplete)
      const bad = receiptOk(ctx.worktree, wf, event.receiptRef, { kind: "panel", inputSha: closureInputSha(wf, d), action: `closure-r${d.round}-*` })
      if ("error" in bad) return refuse(bad.error)
      if (bad.body.pass !== event.pass || JSON.stringify(bad.body.gaps) !== JSON.stringify(event.gaps) || bad.body.round !== d.round) return refuse("closure result does not match its receipt")
      if (JSON.stringify(bad.body.agendaIDs) !== JSON.stringify(event.agendaIDs)) return refuse("closure agenda targets do not match their receipt")
      if (event.agendaIDs && (new Set(event.agendaIDs).size !== event.agendaIDs.length || event.agendaIDs.some(id => !d.topology.components.some(component => component.id === id)))) return refuse("closure agenda targets must name confirmed task agendas")
      if (event.pass && event.agendaIDs?.length) return refuse("a passed closure cannot reopen agendas")
      if (d.questionPolicy && !event.pass && !event.agendaIDs?.length) return refuse("failed closure must name the task agendas needing clarification")
      const { pendingPanel: _p, ...rest } = d
      const closed: DeepInterviewData = { ...rest, closure: { round: d.round, pass: event.pass, receiptRef: event.receiptRef } }
      const events = [ev(wf, "closure_result", "code", from, "reviewing", { round: d.round, pass: event.pass, gaps: event.gaps })]
      if (event.pass) {
        const { reopenAgendaIDs: _targets, ...ready } = closed
        return { ok: true, wf: withData(wf, "restate", undefined, { ...ready, gaps: [] }), events, receipts: [event.receiptRef] }
      }
      const gaps = event.gaps.length > 0 ? event.gaps : ["closure audit failed without naming a gap"]
      const { reopenAgendaIDs: _targets, ...unresolved } = closed
      const overridden: DeepInterviewData = { ...unresolved, closureOverrides: [...d.closureOverrides, { round: d.round, gaps }], gaps,
        ...(event.agendaIDs?.length ? { reopenAgendaIDs: event.agendaIDs } : {}) }
      // After an operator-chosen early exit or the round cap no further question exists: the gaps are recorded in the spec.
      if (d.earlyExit) return { ok: true, wf: withData(wf, "restate", undefined, overridden), events, receipts: [event.receiptRef] }
      return { ok: true, wf: withData(wf, "question", undefined, reopen(overridden)), events, receipts: [event.receiptRef] }
    }
    case "restatement_confirmed": {
      if (stage !== "restate") return refuse(`restatement_confirmed is not valid at stage ${stage}`)
      if (!d.closure || d.closure.round !== d.round) return refuse("closure must run before the restatement")
      if (!d.closure.pass && !d.earlyExit) return refuse("closure has open gaps; the interview continues")
      const bad = receiptOk(ctx.worktree, wf, event.receiptRef, { kind: "choice", inputSha: restatementInputSha(event.goal), action: "choice-restate" })
      if ("error" in bad) return refuse(bad.error)
      const next: DeepInterviewData = { ...d, restatement: { goal: event.goal, receiptRef: event.receiptRef } }
      return { ok: true, wf: withData(wf, "crystallize", undefined, next), events: [ev(wf, "restatement_confirmed", "user_command", from, "planning", { goal: event.goal })], receipts: [event.receiptRef] }
    }
    case "restatement_missing_scope": {
      if (stage !== "restate") return refuse(`restatement_missing_scope is not valid at stage ${stage}`)
      if (d.earlyExit || d.round >= questionLimit(d)) return refuse("no further question is available after an early exit or the round cap")
      const bad = receiptOk(ctx.worktree, wf, event.receiptRef, { kind: "choice", inputSha: choiceInputSha(wf, "missing-scope", d.round), action: "choice-missing-scope" })
      if ("error" in bad) return refuse(bad.error)
      const { closure: _c, ...rest } = d
      return {
        ok: true, wf: withData(wf, "question", undefined, reopen({ ...rest, gaps: [...d.gaps, "the operator reports missing scope; ask what is missing"] })),
        events: [ev(wf, "restatement_missing_scope", "user_command", from, "planning", { round: d.round })], receipts: [event.receiptRef],
      }
    }
    case "spec_written": {
      if (stage !== "crystallize") return refuse(`spec_written is not valid at stage ${stage}`)
      if (!d.restatement) return refuse("the restatement must be confirmed before the specification")
      if (event.path !== specRelative(wf.sessionID, wf.id)) return refuse("specification path is not the workflow's own spec.md")
      const ref = { key: "spec.md", path: event.path, sha256: event.sha256 }
      const check = verifyArtifact(ctx.worktree, ref)
      if (check.state !== "verified") return refuse(`spec.md is ${check.state}: ${check.reason}`)
      const artifacts = [...wf.artifacts.filter(item => item.key !== "spec.md"), ref]
      return {
        ok: true, wf: withData(wf, "terminal", "done", { ...d, specRef: { path: event.path, sha256: event.sha256 } }, { artifacts }),
        events: [ev(wf, "spec_written", "code", from, "done", { path: event.path, sha256: event.sha256, ambiguity: finalAmbiguity(d), threshold: d.threshold, earlyExit: d.earlyExit?.reason ?? null })], receipts: [],
      }
    }
    default: {
      const never: never = event
      return refuse(`unknown event ${(never as { type: string }).type}`)
    }
  }
}

// ------------------------------------------------------------------------------------------------ spec
export type SpecStatus = "PASSED" | "BELOW_THRESHOLD_EARLY_EXIT" | "ROUND_CAP_EXIT"

export function specStatus(d: DeepInterviewData): SpecStatus {
  const ambiguity = finalAmbiguity(d)
  if (d.earlyExit && (d.questionPolicy || ambiguity === undefined || ambiguity > d.threshold)) return d.earlyExit.reason === "cap" ? "ROUND_CAP_EXIT" : "BELOW_THRESHOLD_EARLY_EXIT"
  return "PASSED"
}

/** The specification text: code-owned metadata plus the model's narrative body. */
export function renderSpec(wf: DeepInterviewWorkflow, d: DeepInterviewData, body: string, generatedAt: number): string {
  const ambiguity = finalAmbiguity(d)
  const last = lastScored(d)
  const pct = (value: number | undefined) => value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`
  const lines = [
    `# Deep Interview Spec`,
    ``,
    `## Metadata`,
    `- Workflow: ${wf.id}`,
    `- Spec path: ${specRelative(wf.sessionID, wf.id)}`,
    `- Rounds: ${d.round}`,
    `- Final Ambiguity Score: ${pct(ambiguity)}`,
    `- Threshold: ${d.threshold} (${d.thresholdSource})`,
    `- Type: ${d.type ?? "unknown"}`,
    `- Generated: ${new Date(generatedAt).toISOString()}`,
    `- Status: ${specStatus(d)}`,
    `- Closure: ${d.closure ? `${d.closure.pass ? "passed" : "FAILED (gaps recorded below)"} audit at round ${d.closure.round}` : "not run"}${d.closureOverrides.length > 0 ? `; ${d.closureOverrides.length} override(s)` : ""}`,
    `- Early Exit: ${d.earlyExit ? `${d.earlyExit.reason} at round ${d.earlyExit.round}, ambiguity ${pct(d.earlyExit.ambiguity)}${d.earlyExit.ambiguity > d.threshold ? " above threshold" : "; remaining gaps require review"}` : "none"}`,
    `- Lateral Reviews: ${d.lateralReviews}`,
    `- Lateral Panel Failures: ${d.panelFailures}`,
    `- Restated Goal: ${d.restatement?.goal ?? ""}`,
    ``,
    d.questionPolicy ? `## Latest Agenda Clarity` : `## Clarity Breakdown`,
    `| Dimension | Score |`,
    `|---|---|`,
    `| Goal | ${last?.scores?.goal ?? "n/a"} |`,
    `| Constraints | ${last?.scores?.constraints ?? "n/a"} |`,
    `| Criteria | ${last?.scores?.criteria ?? "n/a"} |`,
    ...(d.type === "brownfield" ? [`| Context | ${last?.scores?.context ?? "n/a"} |`] : []),
    ``,
    `## Topology`,
    ...d.topology.components.map(c => `- ${c.id}: ${c.description}`),
    ``,
    ...(d.questionPolicy ? [
      `## Task Agendas`,
      `Question budget: ${d.round}/${questionLimit(d)} overall; ${d.questionPolicy.maxPerAgenda} per agenda. Ready means sufficient clarity, not approval to execute.`,
      ...agendaProgress(d).flatMap(item => [
        `### ${item.id}: ${item.description}`,
        `- Status: ${item.status}; questions: ${item.asked}/${d.questionPolicy!.maxPerAgenda}; ambiguity: ${pct(item.ambiguity)}`,
        ...d.rounds.filter(round => round.agendaID === item.id).map(round => `- Round ${round.n}: question ${round.questionSha}; answer ${round.answerSha ?? "unanswered"}`),
      ]),
      ``,
    ] : []),
    ...(d.gaps.length > 0 ? [`## Open Gaps`, ...d.gaps.map(gap => `- ${gap}`), ``] : []),
    body.trim(),
    ``,
  ]
  return lines.join("\n")
}
