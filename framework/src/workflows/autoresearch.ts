// Autoresearch engine (P6b S3): pure stage transitions. The model only returns typed stage events (turn.ts); code decides
// progress. Evidence (runs, receipts, the verdict check) lives in autoresearch-evidence.ts, the turn loop in
// autoresearch-driver.ts and the verifier-backed runner in autoresearch-runner.ts. Nothing here can start a command: an
// experiment runs only after its own typed RUN receipt, metrics are parsed by code from verifier output, and a
// conclusive verdict needs at least one valid run plus a critic OKAY.
import { REGISTRY } from "./registry.ts"
import type { StageEvent } from "./turn.ts"
import {
  AR_MAX_ATTEMPTS, AR_MAX_ITERATIONS, parseAutoresearchData, slotId, slotIndex,
  type ArExperiment, type ArHashed, type ArInvalidReason, type ArMetric, type ArPending, type ArRun, type ArRunStatus, type ArStuck, type AutoresearchData,
} from "./autoresearch-data.ts"
import { sameSubject } from "./execution-unit.ts"
import { TERMINAL, type ArtifactRef, type AutoresearchWorkflow, type Phase } from "./types.ts"

export type { AutoresearchWorkflow }
export { AR_MAX_ATTEMPTS, AR_MAX_ITERATIONS }
export const AUTORESEARCH_STUCK_MARKER = "AUTORESEARCH-STUCK"
export const AR_CAP_CAVEAT = `iteration cap reached: ${AR_MAX_ITERATIONS} automatic iterations ran; no further experiment was prepared`

export const isAutoresearch = (wf: { kind: string } | null | undefined): wf is AutoresearchWorkflow => wf?.kind === "autoresearch"
export const autoresearchDataOf = (wf: AutoresearchWorkflow): AutoresearchData => parseAutoresearchData(wf.data)

/** The exact text a human types to approve ONE experiment. An APPROVE-UNIT or EXECUTE confirmation never matches. */
export function runConfirmation(workflowID: string, subjectSha: string): string {
  return `RUN ${workflowID} ${subjectSha}`
}

// ---------------------------------------------------------------------------------------------- steps
export type AutoresearchStep =
  | { kind: "turn"; stage: "intake" | "hypothesis" | "evidence" | "experiment_prepare" | "evaluate" }
  | { kind: "approval" }
  | { kind: "run" }
  | { kind: "verdict" }
  | { kind: "choice" }
  | { kind: "blocked"; reason: string }
  | { kind: "done" }

/** The next code-owned step. Pure. Stuck, paused and stopping workflows do nothing. */
export function nextStep(wf: AutoresearchWorkflow): AutoresearchStep {
  if (TERMINAL.has(wf.phase)) return { kind: "done" }
  if (wf.stopIntent) return { kind: "blocked", reason: `${wf.stopIntent.kind} requested` }
  if (wf.phase === "paused") return { kind: "blocked", reason: "workflow is paused" }
  const data = autoresearchDataOf(wf)
  if (wf.phase === "stuck") return wf.stage === "terminal" ? { kind: "done" } : { kind: "blocked", reason: data.stuck?.reason ?? "workflow is stuck" }
  switch (wf.stage) {
    case "intake": case "hypothesis": case "evidence": case "experiment_prepare": case "evaluate": return { kind: "turn", stage: wf.stage }
    case "experiment_approval": return { kind: "approval" }
    case "experiment_run": return { kind: "run" }
    case "verdict_emit": return data.verdict ? { kind: "choice" } : { kind: "verdict" }
    case "terminal": return { kind: "done" }
  }
}

// ---------------------------------------------------------------------------------------------- typed event extraction
export type LaneParse<T> = { ok: true; value: T } | { ok: false; reason: string }

function only<T extends StageEvent["type"]>(events: readonly StageEvent[], type: T): Extract<StageEvent, { type: T }> | undefined {
  const first = events.length === 1 ? events[0]! : undefined
  return first?.type === type ? first as Extract<StageEvent, { type: T }> : undefined
}

export function missionOf(events: readonly StageEvent[]): LaneParse<{ goal: string; metric: ArMetric }> {
  const event = only(events, "mission")
  return event ? { ok: true, value: { goal: event.goal, metric: { name: event.metric, direction: event.direction } } } : { ok: false, reason: "expected exactly one mission event" }
}
export function hypothesesOf(events: readonly StageEvent[]): LaneParse<string[]> {
  const event = only(events, "hypothesis")
  return event ? { ok: true, value: event.hypotheses } : { ok: false, reason: "expected exactly one hypothesis event" }
}
export function evidenceOf(events: readonly StageEvent[]): LaneParse<Array<{ path: string; note: string }>> {
  const event = only(events, "evidence")
  return event ? { ok: true, value: event.items } : { ok: false, reason: "expected exactly one evidence event" }
}
export function experimentOf(events: readonly StageEvent[]): LaneParse<{ commands: string[]; params: Record<string, string> }> {
  const event = only(events, "experiment")
  return event ? { ok: true, value: { commands: event.commands, params: event.params } } : { ok: false, reason: "expected exactly one experiment event" }
}
export type ArVerdict = "OKAY" | "ITERATE" | "REJECT"
export function evaluationOf(events: readonly StageEvent[]): LaneParse<{ verdict: ArVerdict; findings: string[]; suspect: number[] }> {
  const event = only(events, "lane_verdict")
  if (!event || event.status !== undefined || event.decision !== undefined || !event.verdict) return { ok: false, reason: "expected exactly one critic lane_verdict with verdict OKAY/ITERATE/REJECT" }
  if (event.findings.length === 0 && event.verdict !== "OKAY") return { ok: false, reason: "critic findings are required unless OKAY" }
  return { ok: true, value: { verdict: event.verdict, findings: event.findings, suspect: [...new Set(event.suspect ?? [])] } }
}

// ---------------------------------------------------------------------------------------------- run classification (code only)
/** The last `METRIC <name>=<number>` line of verifier output, or undefined. A model never supplies a metric. */
export function parseMetric(output: string, name: string): number | undefined {
  const re = new RegExp(`^METRIC\\s+${name}=([+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?)\\s*$`, "gm")
  let found: number | undefined
  for (const match of output.matchAll(re)) {
    const value = Number(match[1])
    if (Number.isFinite(value)) found = value
  }
  return found
}

export type RunFacts = { unsettled?: boolean; refused: boolean; interrupted: boolean; integrity: "changed" | "unchanged" | "unknown"; invalidated: boolean; exitCode: number | null; timedOut: boolean; cancelled: boolean; output: string }
export type Classified = { status: ArRunStatus; valid: boolean; invalid?: ArInvalidReason; metric?: number }

const better = (metric: ArMetric, candidate: number, best: number): boolean => metric.direction === "max" ? candidate > best : candidate < best

/** Best valid metric so far (suspect and other invalid runs excluded), or undefined. */
export function bestOf(runs: readonly ArRun[], metric: ArMetric): { attempt: number; value: number } | undefined {
  let best: { attempt: number; value: number } | undefined
  for (const run of runs) {
    if (!run.valid || run.metric === undefined) continue
    if (!best || better(metric, run.metric, best.value)) best = { attempt: run.attempt, value: run.metric }
  }
  return best
}

/**
 * baseline / keep / discard / crash / checks_failed (ARS:107, 115). Interrupted, integrity-changed and refused runs are
 * invalid and never enter the metric comparison. The first valid metric run is the baseline; afterwards a strictly
 * better value is `keep`, anything else `discard`.
 */
export function classifyRun(facts: RunFacts, metric: ArMetric, prior: readonly ArRun[]): Classified {
  // A command whose termination could not be proven (legacy parent-shell verifier past its deadline) is evidence of
  // what happened, never of a result: its output is recorded but it is excluded and the claim stays fenced.
  if (facts.unsettled) return { status: facts.timedOut ? "crash" : "checks_failed", valid: false, invalid: "unsettled" }
  if (facts.interrupted || facts.cancelled) return { status: "checks_failed", valid: false, invalid: "interrupted" }
  if (facts.refused) return { status: "checks_failed", valid: false, invalid: "refused" }
  if (facts.invalidated || facts.integrity === "changed") return { status: "checks_failed", valid: false, invalid: "integrity" }
  if (facts.timedOut || facts.exitCode !== 0) return { status: "crash", valid: true }
  const value = parseMetric(facts.output, metric.name)
  if (value === undefined) return { status: "checks_failed", valid: true }
  const best = bestOf(prior, metric)
  if (!best) return { status: "baseline", valid: true, metric: value }
  return { status: better(metric, value, best.value) ? "keep" : "discard", valid: true, metric: value }
}

// ---------------------------------------------------------------------------------------------- pure reducer
export type ArEvent = { type: string; data?: Record<string, unknown> }
export type Transition = { wf: AutoresearchWorkflow; events: ArEvent[] }
export type Hashed = ArHashed

export type ArAction =
  | { type: "intake_confirmed"; mission: Hashed; metric: ArMetric }
  | { type: "hypothesis_recorded"; hypotheses: string[] }
  | { type: "evidence_recorded"; evidence: Hashed; verified: number; unverified: number; caveats: string[] }
  | { type: "experiment_proposed"; pending: ArPending; artifacts: Hashed[]; reuse?: boolean }
  | { type: "experiment_approved"; experiment: ArExperiment }
  | { type: "run_recorded"; run: ArRun; artifact: Hashed }
  | { type: "experiment_finished" }
  | { type: "evaluation_recorded"; verdict: ArVerdict; findings: string[]; ref: string; suspect: number[] }
  | { type: "verdict_written"; verdict: Hashed; status: "conclusive" | "inconclusive" }
  | { type: "autoresearch_finished"; productify?: boolean }
  | { type: "attempt_failed"; reason: string; fatal?: boolean }
  | { type: "runner_failed"; reason: string }
  | { type: "retry" }

function arranged(existing: readonly ArtifactRef[], add: readonly ArtifactRef[]): ArtifactRef[] {
  const out = [...existing]
  for (const ref of add) {
    const at = out.findIndex(item => item.key === ref.key)
    if (at >= 0) { if (out[at]!.sha256 !== ref.sha256) throw new Error(`artifact ${ref.key} is already committed with other bytes`); continue }
    out.push(ref)
  }
  return out
}

function moved(wf: AutoresearchWorkflow, stage: AutoresearchWorkflow["stage"], phase: Phase, data: AutoresearchData, artifacts: readonly ArtifactRef[]): AutoresearchWorkflow {
  return { ...wf, stage, phase, data, artifacts: [...artifacts] } as AutoresearchWorkflow
}

/** Model-turn and ordinary transitions need a live, un-stopped workflow. */
function assertLive(wf: AutoresearchWorkflow): void {
  if (TERMINAL.has(wf.phase) || wf.phase === "paused" || wf.phase === "stuck") throw new Error(`autoresearch workflow is ${wf.phase}; no stage event applies`)
  if (wf.stopIntent) throw new Error(`autoresearch workflow ${wf.stopIntent.kind} is pending; no stage event applies`)
}

/** Run records are the one thing that must land while a stop is pending: the owner records what actually happened. */
function assertRecording(wf: AutoresearchWorkflow): void {
  if (wf.phase !== "executing" || wf.stage !== "experiment_run") throw new Error(`run records are not valid in stage ${wf.stage}`)
}

const phaseOf = (stage: AutoresearchWorkflow["stage"]): Phase => REGISTRY.autoresearch.phaseOf(stage)
const clean = (data: AutoresearchData): AutoresearchData => { const { failure: _f, ...rest } = data; return { ...rest, attempts: 0 } }
const without = <K extends keyof AutoresearchData>(data: AutoresearchData, ...keys: K[]): AutoresearchData => {
  const copy = { ...data }
  for (const key of keys) delete copy[key]
  return copy
}
const runnerStuck = (reason: string): ArStuck => ({ kind: "runner", reason: `${AUTORESEARCH_STUCK_MARKER}: ${reason}`.slice(0, 1_000), evidence: [] })

export function reduce(wf: AutoresearchWorkflow, action: ArAction): Transition {
  const data = autoresearchDataOf(wf)
  switch (action.type) {
    case "intake_confirmed": {
      assertLive(wf)
      if (wf.stage !== "intake" || data.mission) throw new Error(`intake_confirmed is not valid in stage ${wf.stage}`)
      if (action.mission.key !== "mission.json") throw new Error("intake_confirmed needs mission.json")
      return {
        wf: moved(wf, "hypothesis", phaseOf("hypothesis"), clean({ ...data, mission: { path: action.mission.path, sha256: action.mission.sha256, metric: action.metric } }), arranged(wf.artifacts, [action.mission])),
        events: [{ type: "intake_confirmed", data: { metric: action.metric.name, direction: action.metric.direction, sha256: action.mission.sha256 } }],
      }
    }
    case "hypothesis_recorded": {
      assertLive(wf)
      if (wf.stage !== "hypothesis" || action.hypotheses.length === 0) throw new Error(`hypothesis_recorded is not valid in stage ${wf.stage}`)
      return { wf: moved(wf, "evidence", phaseOf("evidence"), clean({ ...data, hypotheses: action.hypotheses }), wf.artifacts), events: [{ type: "hypothesis_recorded", data: { count: action.hypotheses.length } }] }
    }
    case "evidence_recorded": {
      assertLive(wf)
      if (wf.stage !== "evidence") throw new Error(`evidence_recorded is not valid in stage ${wf.stage}`)
      if (action.evidence.key !== "evidence.json") throw new Error("evidence_recorded needs evidence.json")
      const caveats = [...data.caveats, ...action.caveats].slice(0, 40)
      return {
        wf: moved(wf, "experiment_prepare", phaseOf("experiment_prepare"), clean({ ...data, caveats, evidence: { path: action.evidence.path, sha256: action.evidence.sha256, verified: action.verified, unverified: action.unverified } }), arranged(wf.artifacts, [action.evidence])),
        events: [{ type: "evidence_recorded", data: { verified: action.verified, unverified: action.unverified, sha256: action.evidence.sha256 } }],
      }
    }
    case "experiment_proposed": {
      assertLive(wf)
      if (wf.stage !== "experiment_prepare" || !data.mission) throw new Error(`experiment_proposed is not valid in stage ${wf.stage}`)
      if (data.iteration >= AR_MAX_ITERATIONS || action.pending.iteration !== data.iteration + 1) throw new Error("experiment does not name the next iteration")
      if (action.pending.artifacts.length === 0) throw new Error("an experiment needs at least one bound document")
      const artifacts = arranged(wf.artifacts, action.artifacts)
      const event: ArEvent = { type: "experiment_proposed", data: { iteration: action.pending.iteration, subject: action.pending.subject.sha256, reused: action.reuse === true } }
      if (!action.reuse) {
        return { wf: moved(wf, "experiment_approval", phaseOf("experiment_approval"), clean({ ...data, pending: action.pending, iteration: action.pending.iteration }), artifacts), events: [event] }
      }
      // An identical subject that already carries its approval receipt runs again without a new receipt (A4).
      const prior = data.experiment
      if (!prior || !sameSubject(prior.subject, action.pending.subject)) throw new Error("only an identical approved subject may re-run without a new receipt")
      const experiment: ArExperiment = { ...prior, iteration: action.pending.iteration, done: [], remaining: action.pending.spec.commands.map((_, index) => slotId(index)) }
      return {
        wf: moved(wf, "experiment_run", phaseOf("experiment_run"), clean({ ...without(data, "pending"), iteration: action.pending.iteration, experiment }), artifacts),
        events: [event, { type: "experiment_approved", data: { iteration: action.pending.iteration, subject: action.pending.subject.sha256, reused: true } }],
      }
    }
    case "experiment_approved": {
      assertLive(wf)
      const p = data.pending
      if (wf.stage !== "experiment_approval" || !p) throw new Error(`experiment_approved is not valid in stage ${wf.stage}`)
      const e = action.experiment
      if (e.subject.sha256 !== p.subject.sha256 || e.subject.id !== p.subject.id || e.approval.subject.sha256 !== p.subject.sha256) throw new Error("approval names another experiment")
      if (JSON.stringify(e.artifacts) !== JSON.stringify(p.artifacts) || !e.approval.receiptRef) throw new Error("approval does not bind the experiment documents and a receipt")
      if (e.iteration !== p.iteration || e.remaining.length !== p.spec.commands.length || e.done.length !== 0) throw new Error("approval does not start the proposed iteration")
      return {
        wf: moved(wf, "experiment_run", phaseOf("experiment_run"), clean(without({ ...data, experiment: e }, "pending")), wf.artifacts),
        events: [{ type: "experiment_approved", data: { iteration: e.iteration, subject: e.subject.sha256, receipt: e.approval.receiptRef } }],
      }
    }
    case "run_recorded": {
      assertRecording(wf)
      const e = data.experiment
      if (!e || !data.mission) throw new Error("run_recorded needs an approved experiment")
      const run = action.run
      const slot = slotId(run.slot)
      if (run.attempt !== data.runs.length + 1 || run.iteration !== e.iteration || e.remaining[0] !== slot) throw new Error("run does not name the next remaining experiment slot")
      if (action.artifact.key !== `runs/${run.attempt}.json` || action.artifact.sha256 !== run.sha256) throw new Error("run does not bind its run file")
      // An interrupted run stays in the remainder (it did not complete); every other run settles its slot.
      const interrupted = run.invalid === "interrupted"
      const experiment: ArExperiment = { ...e, done: interrupted ? e.done : [...e.done, slot], remaining: interrupted ? e.remaining : e.remaining.slice(1) }
      const runs = [...data.runs, run]
      const best = bestOf(runs, data.mission.metric)
      const next: AutoresearchData = { ...without(data, "best"), runs, experiment, ...(best ? { best } : {}) }
      return {
        wf: moved(wf, "experiment_run", wf.phase, next, arranged(wf.artifacts, [action.artifact])),
        events: [{ type: "run_recorded", data: { attempt: run.attempt, iteration: run.iteration, slot, status: run.status, valid: run.valid, ...(run.invalid ? { invalid: run.invalid } : {}), receipt: run.receiptRef } }],
      }
    }
    case "experiment_finished": {
      assertLive(wf)
      const e = data.experiment
      if (wf.stage !== "experiment_run" || !e || e.remaining.length > 0) throw new Error("experiment still has remaining runs")
      return { wf: moved(wf, "evaluate", phaseOf("evaluate"), clean(data), wf.artifacts), events: [{ type: "experiment_finished", data: { iteration: e.iteration, runs: data.runs.length } }] }
    }
    case "evaluation_recorded": {
      assertLive(wf)
      if (wf.stage !== "evaluate" || !data.mission) throw new Error(`evaluation_recorded is not valid in stage ${wf.stage}`)
      const known = new Set(data.runs.map(run => run.attempt))
      if (action.suspect.some(attempt => !known.has(attempt))) throw new Error("critic named a run that does not exist")
      // Suspect runs are excluded from the metric comparison; the cumulative list lives in the evaluation receipt.
      const runs = data.runs.map(run => action.suspect.includes(run.attempt) && run.valid ? { ...run, valid: false, invalid: "suspect" as const } : run)
      const best = bestOf(runs, data.mission.metric)
      const base: AutoresearchData = { ...without(data, "best", "pending"), runs, ...(best ? { best } : {}), evaluation: { ref: action.ref, verdict: action.verdict, suspect: action.suspect } }
      const event: ArEvent = { type: "evaluation_recorded", data: { iteration: data.iteration, verdict: action.verdict, suspect: action.suspect, receipt: action.ref } }
      if (action.verdict === "ITERATE" && data.iteration < AR_MAX_ITERATIONS) {
        return { wf: moved(wf, "experiment_prepare", phaseOf("experiment_prepare"), clean({ ...base, findings: action.findings.slice(0, 12) }), wf.artifacts), events: [event] }
      }
      const capped = action.verdict === "ITERATE"
      const caveats = capped ? [...base.caveats, AR_CAP_CAVEAT].slice(0, 40) : base.caveats
      return { wf: moved(wf, "verdict_emit", phaseOf("verdict_emit"), clean({ ...base, caveats, findings: action.findings.slice(0, 12), ...(capped ? { capped: true } : {}) }), wf.artifacts), events: [event] }
    }
    case "verdict_written": {
      assertLive(wf)
      if (wf.stage !== "verdict_emit" || data.verdict) throw new Error(`verdict_written is not valid in stage ${wf.stage}`)
      if (action.verdict.key !== "verdict.json") throw new Error("verdict_written needs verdict.json")
      return {
        wf: moved(wf, "verdict_emit", phaseOf("verdict_emit"), { ...data, verdict: { path: action.verdict.path, sha256: action.verdict.sha256, status: action.status } }, arranged(wf.artifacts, [action.verdict])),
        events: [{ type: "verdict_written", data: { status: action.status, sha256: action.verdict.sha256 } }],
      }
    }
    case "autoresearch_finished": {
      assertLive(wf)
      if (wf.stage !== "verdict_emit" || !data.verdict) throw new Error("finish needs a written verdict")
      const events: ArEvent[] = action.productify ? [{ type: "productify_selected", data: { status: data.verdict.status } }] : []
      const next: AutoresearchData = action.productify ? { ...data, productify: { chosen: true } } : data
      if (data.verdict.status === "conclusive") {
        return { wf: moved(wf, "terminal", "done", next, wf.artifacts), events: [...events, { type: "autoresearch_finished", data: { status: "conclusive" } }] }
      }
      const stuck: ArStuck = { kind: "inconclusive", reason: `${AUTORESEARCH_STUCK_MARKER}: the verdict is inconclusive (${data.capped ? "iteration cap reached" : "no supported conclusion"}); evidence retained`, evidence: [data.verdict.path] }
      return { wf: moved(wf, "terminal", "stuck", { ...next, stuck }, wf.artifacts), events: [...events, { type: "autoresearch_finished", data: { status: "inconclusive" } }, { type: "stuck", data: { stage: "terminal", kind: "inconclusive" } }] }
    }
    case "attempt_failed": {
      assertLive(wf)
      if (wf.stage !== "intake" && wf.stage !== "hypothesis" && wf.stage !== "evidence" && wf.stage !== "experiment_prepare" && wf.stage !== "evaluate") throw new Error(`stage ${wf.stage} has no model attempt`)
      const attempts = action.fatal ? AR_MAX_ATTEMPTS : data.attempts + 1
      const reason = action.reason.slice(0, 900) || "attempt failed"
      const failed: ArEvent = { type: "attempt_failed", data: { stage: wf.stage, attempts, reason } }
      if (attempts < AR_MAX_ATTEMPTS) return { wf: moved(wf, wf.stage, wf.phase, { ...data, attempts, failure: reason }, wf.artifacts), events: [failed] }
      const stuck: ArStuck = { kind: "attempts", reason: `${AUTORESEARCH_STUCK_MARKER}: ${wf.stage} failed ${attempts} times: ${reason}`.slice(0, 1_000), evidence: [] }
      return { wf: moved(wf, wf.stage, "stuck", { ...data, attempts, failure: reason, stuck }, wf.artifacts), events: [failed, { type: "stuck", data: { stage: wf.stage, kind: "attempts" } }] }
    }
    case "runner_failed": {
      if (wf.stage !== "experiment_run" || wf.phase !== "executing") throw new Error(`runner_failed is not valid in stage ${wf.stage}`)
      return { wf: moved(wf, wf.stage, "stuck", { ...data, stuck: runnerStuck(action.reason) }, wf.artifacts), events: [{ type: "stuck", data: { stage: wf.stage, kind: "runner" } }] }
    }
    case "retry": {
      if (wf.phase !== "stuck" || wf.stage === "terminal" || wf.stopIntent) throw new Error("only a workflow stuck at a live stage can retry")
      const { stuck: _stuck, ...rest } = data
      return { wf: moved(wf, wf.stage, phaseOf(wf.stage), clean(rest), wf.artifacts), events: [{ type: "retry", data: { stage: wf.stage } }] }
    }
  }
}

export const slotsOf = (count: number): string[] => Array.from({ length: count }, (_, index) => slotId(index))
export { slotIndex }
