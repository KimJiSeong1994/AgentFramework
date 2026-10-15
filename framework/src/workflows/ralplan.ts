// Ralplan engine (P6a S3): pure stage transitions. The model only returns typed stage events (turn.ts); code decides
// progress. Evidence (artifacts, receipts, consensus verification) lives in ralplan-evidence.ts and the turn loop in
// ralplan-driver.ts. Nothing here can start, approve or execute work: the furthest the workflow goes is
// `pending_execution` (phase pending_approval, "execution pending"); an execute choice is only recorded.
import { REGISTRY } from "./registry.ts"
import {
  ARCHITECT_DECISIONS, ARCHITECT_STATUSES, CRITIC_VERDICTS, parseRalplanData, RALPLAN_MAX_ATTEMPTS, RALPLAN_MAX_OPENERS,
  type ArchitectResult, type ArchitectStatus, type CriticResult, type RalplanChoice, type RalplanData, type RalplanIteration,
} from "./ralplan-data.ts"
import type { StageEvent } from "./turn.ts"
import { TERMINAL, type ArtifactRef, type Phase, type WorkflowEnvelope } from "./types.ts"

export type RalplanWorkflow = Extract<WorkflowEnvelope, { kind: "ralplan" }>
export type { RalplanData, RalplanIteration } from "./ralplan-data.ts"
export { RALPLAN_MAX_ATTEMPTS, RALPLAN_MAX_OPENERS } from "./ralplan-data.ts"

export const PLANNING_COMPLETE_TEXT = "planning complete; not executed"
export const PLANNING_STUCK_MARKER = "PLANNING-STUCK"
const FRONT_ARTIFACTS = ["pending-approval.md", "consensus.json", "best-plan.md"] as const

export const isRalplan = (wf: WorkflowEnvelope | null | undefined): wf is RalplanWorkflow => wf?.kind === "ralplan"
export const ralplanDataOf = (wf: RalplanWorkflow): RalplanData => parseRalplanData(wf.data)

// ---------------------------------------------------------------------------------------------- join and best plan
/**
 * The review join gate. Consensus needs Architect CLEAR + APPROVE and Critic OKAY, all judging the SAME plan hash as the
 * iteration. Anything else (including a missing lane or another hash) routes back to revision.
 */
export function joinReview(iteration: RalplanIteration): { consensus: boolean; reasons: string[] } {
  const reasons: string[] = []
  const a = iteration.architect
  const c = iteration.critic
  if (!a) reasons.push("architect result missing")
  else {
    if (a.planSha !== iteration.planSha) reasons.push("architect judged another plan hash")
    if (a.status !== "CLEAR") reasons.push(`architect status ${a.status}`)
    if (a.decision !== "APPROVE") reasons.push(`architect decision ${a.decision}`)
  }
  if (!c) reasons.push("critic result missing")
  else {
    if (c.planSha !== iteration.planSha) reasons.push("critic judged another plan hash")
    if (c.verdict !== "OKAY") reasons.push(`critic verdict ${c.verdict}`)
  }
  if (a && c && a.planSha !== c.planSha) reasons.push("architect and critic judged different plan hashes")
  return { consensus: reasons.length === 0, reasons }
}

const ARCHITECT_RANK: Record<ArchitectStatus, number> = { CLEAR: 2, WATCH: 1, BLOCK: 0 }
const DECISION_RANK = { APPROVE: 2, COMMENT: 1, REQUEST_CHANGES: 0 } as const
const CRITIC_RANK = { OKAY: 2, ITERATE: 1, REJECT: 0 } as const

/** The best reviewed opener: highest combined verdict rank, the later one on a tie. */
export function bestOpener(data: RalplanData): number {
  let best = data.iterations.length
  let bestScore = -1
  for (const it of data.iterations) {
    const score = (it.architect ? ARCHITECT_RANK[it.architect.status] + DECISION_RANK[it.architect.decision] : 0) + (it.critic ? CRITIC_RANK[it.critic.verdict] * 2 : 0)
    if (score >= bestScore) { best = it.n; bestScore = score }
  }
  return best
}

export type CriticOutcome = "consensus" | "revision" | "cap"
/** What recording this critic result does: consensus, another revision pass, or the five-opener cap. */
export function criticOutcome(data: RalplanData, critic: CriticResult): CriticOutcome {
  const it = data.iterations[data.iterations.length - 1]
  if (!it) throw new Error("no opener to judge")
  if (joinReview({ ...it, critic }).consensus) return "consensus"
  return data.openers >= RALPLAN_MAX_OPENERS ? "cap" : "revision"
}

// ---------------------------------------------------------------------------------------------- steps
export type RalplanStep =
  | { kind: "turn"; stage: "planner" | "revision" | "architect" | "critic"; opener: number }
  | { kind: "emit" }
  | { kind: "choice" }
  | { kind: "blocked"; reason: string }
  | { kind: "done" }

/** The next code-owned step of a committed ralplan workflow. Pure. Stuck, paused and stopping workflows do nothing. */
export function nextStep(wf: RalplanWorkflow): RalplanStep {
  if (TERMINAL.has(wf.phase)) return { kind: "done" }
  if (wf.stopIntent) return { kind: "blocked", reason: `${wf.stopIntent.kind} requested` }
  if (wf.phase === "paused") return { kind: "blocked", reason: "workflow is paused" }
  const data = ralplanDataOf(wf)
  if (wf.phase === "stuck") return { kind: "blocked", reason: data.stuck?.reason ?? "workflow is stuck" }
  switch (wf.stage) {
    case "planner": case "revision":
      if (data.openers >= RALPLAN_MAX_OPENERS) return { kind: "blocked", reason: `${PLANNING_STUCK_MARKER}: opener cap reached` }
      return { kind: "turn", stage: wf.stage, opener: data.openers + 1 }
    case "architect": case "critic": return { kind: "turn", stage: wf.stage, opener: data.openers }
    case "consensus_emit": return { kind: "emit" }
    case "pending_execution": return { kind: "choice" }
    case "terminal": return { kind: "done" }
  }
}

// ---------------------------------------------------------------------------------------------- rendering
export function renderPlanMarkdown(opener: number, sections: ReadonlyArray<{ title: string; body: string }>): string {
  return `# Plan · opener ${opener}\n\n${sections.map(section => `## ${section.title}\n\n${section.body}`).join("\n\n")}\n`
}

const bullets = (items: readonly string[]) => items.length ? items.map(item => `- ${item}`).join("\n") : "- none"

export function renderArchitectMarkdown(opener: number, result: { status: string; decision: string; planSha: string }, findings: readonly string[]): string {
  return `# Architect review · opener ${opener}\n\nplan sha256: ${result.planSha}\nstatus: ${result.status}\ndecision: ${result.decision}\n\n## Findings\n\n${bullets(findings)}\n`
}

export function renderCriticMarkdown(opener: number, result: { verdict: string; planSha: string }, findings: readonly string[]): string {
  return `# Critic review · opener ${opener}\n\nplan sha256: ${result.planSha}\nverdict: ${result.verdict}\n\n## Findings\n\n${bullets(findings)}\n`
}

export function renderPendingApproval(planText: string, it: RalplanIteration, consensusRef: string): string {
  const a = it.architect!
  const c = it.critic!
  return `# Pending approval · planning complete, NOT executed\n\nArchitect ${a.status}/${a.decision} + Critic ${c.verdict} on plan sha256 ${it.planSha} (opener ${it.n}).\nExecution pending: running this plan needs a separate explicit execution receipt. Consensus is not approval.\nconsensus receipt: ${consensusRef}\n\n---\n\n${planText}`
}

export function renderBestPlan(data: RalplanData, best: number, planText: string, caveats: readonly string[]): string {
  return `# Best plan (${PLANNING_STUCK_MARKER}) · opener ${best} of ${data.openers}\n\nNo consensus after ${data.openers} openers. Kept for reference only; NOT approved or executed.\n\n## Residual caveats\n\n${bullets(caveats)}\n\n---\n\n${planText}`
}

// ---------------------------------------------------------------------------------------------- typed event extraction
export type LaneParse<T> = { ok: true; value: T } | { ok: false; reason: string }

export function planDocOf(events: readonly StageEvent[]): LaneParse<Array<{ title: string; body: string }>> {
  const only = events.length === 1 ? events[0]! : undefined
  return only?.type === "plan_doc" ? { ok: true, value: only.sections } : { ok: false, reason: "expected exactly one plan_doc event" }
}

/** Architect lane_verdict: status CLEAR/WATCH/BLOCK + decision APPROVE/COMMENT/REQUEST_CHANGES, no critic verdict. */
export function architectVerdictOf(events: readonly StageEvent[]): LaneParse<{ status: ArchitectStatus; decision: ArchitectResult["decision"]; findings: string[] }> {
  const only = events.length === 1 ? events[0]! : undefined
  if (only?.type !== "lane_verdict" || only.verdict !== undefined || !only.status || !only.decision ||
    !(ARCHITECT_STATUSES as readonly string[]).includes(only.status) || !(ARCHITECT_DECISIONS as readonly string[]).includes(only.decision)) {
    return { ok: false, reason: "expected exactly one architect lane_verdict with status CLEAR/WATCH/BLOCK and decision APPROVE/COMMENT/REQUEST_CHANGES" }
  }
  if (only.findings.length === 0 && !(only.status === "CLEAR" && only.decision === "APPROVE")) return { ok: false, reason: "architect findings are required unless CLEAR + APPROVE" }
  return { ok: true, value: { status: only.status, decision: only.decision, findings: only.findings } }
}

export function criticVerdictOf(events: readonly StageEvent[]): LaneParse<{ verdict: CriticResult["verdict"]; findings: string[] }> {
  const only = events.length === 1 ? events[0]! : undefined
  if (only?.type !== "lane_verdict" || only.status !== undefined || only.decision !== undefined || !only.verdict ||
    !(CRITIC_VERDICTS as readonly string[]).includes(only.verdict)) {
    return { ok: false, reason: "expected exactly one critic lane_verdict with verdict OKAY/ITERATE/REJECT" }
  }
  if (only.findings.length === 0 && only.verdict !== "OKAY") return { ok: false, reason: "critic findings are required unless OKAY" }
  return { ok: true, value: { verdict: only.verdict, findings: only.findings } }
}

// ---------------------------------------------------------------------------------------------- pure reducer
export type RalplanEvent = { type: string; data?: Record<string, unknown> }
export type Transition = { wf: RalplanWorkflow; events: RalplanEvent[] }
export type Hashed = ArtifactRef & { sha256: string }

export type RalplanAction =
  | { type: "plan_saved"; plan: Hashed }
  | { type: "architect"; result: ArchitectResult; artifact: Hashed }
  | { type: "critic"; result: CriticResult; artifact: Hashed; bestPlan?: Hashed }
  | { type: "consensus"; consensus: { opener: number; planSha: string; ref: string }; artifacts: Hashed[] }
  | { type: "stop_here"; choice: RalplanChoice }
  | { type: "execute_confirmed"; choice: RalplanChoice }
  | { type: "attempt_failed"; reason: string; /** The input cannot be made to fit: retrying the same input is pointless, so go straight to stuck. */ fatal?: boolean }
  | { type: "retry" }

function arranged(existing: readonly ArtifactRef[], add: readonly ArtifactRef[]): ArtifactRef[] {
  const merged = new Map<string, ArtifactRef>()
  for (const ref of [...existing, ...add]) merged.set(ref.key, ref)
  const rank = (key: string) => { const i = (FRONT_ARTIFACTS as readonly string[]).indexOf(key); return i < 0 ? FRONT_ARTIFACTS.length : i }
  return [...merged.values()].map((ref, index) => ({ ref, index })).sort((x, y) => rank(x.ref.key) - rank(y.ref.key) || x.index - y.index).map(item => item.ref)
}

function moved(wf: RalplanWorkflow, stage: RalplanWorkflow["stage"], phase: Phase, data: RalplanData, artifacts: readonly ArtifactRef[]): RalplanWorkflow {
  return { ...wf, stage, phase, data, artifacts: [...artifacts] } as RalplanWorkflow
}

function assertLive(wf: RalplanWorkflow): void {
  if (TERMINAL.has(wf.phase) || wf.phase === "paused" || wf.phase === "stuck") throw new Error(`ralplan workflow is ${wf.phase}; no stage event applies`)
  if (wf.stopIntent) throw new Error(`ralplan workflow ${wf.stopIntent.kind} is pending; no stage event applies`)
}

const phaseOf = (stage: RalplanWorkflow["stage"]): Phase => REGISTRY.ralplan.phaseOf(stage)
const clean = (data: RalplanData): RalplanData => { const { failure: _f, ...rest } = data; return { ...rest, attempts: 0 } }

/**
 * Pure transition. The driver validates model output, writes artifacts and receipts, then names them in the action.
 * Illegal combinations (wrong stage, stale hash, a second lane result for the same opener, a sixth opener) throw and
 * change nothing.
 */
export function reduce(wf: RalplanWorkflow, action: RalplanAction): Transition {
  const data = ralplanDataOf(wf)
  switch (action.type) {
    case "plan_saved": {
      assertLive(wf)
      if (wf.stage !== "planner" && wf.stage !== "revision") throw new Error(`plan_saved is not valid in stage ${wf.stage}`)
      if (data.openers >= RALPLAN_MAX_OPENERS) throw new Error(`${PLANNING_STUCK_MARKER}: a sixth opener is refused`)
      const n = data.openers + 1
      if (action.plan.key !== `iteration-${n}/plan.md`) throw new Error("plan artifact does not name this opener")
      const iteration: RalplanIteration = { n, planKey: action.plan.key, planPath: action.plan.path, planSha: action.plan.sha256 }
      return {
        wf: moved(wf, "architect", phaseOf("architect"), clean({ ...data, openers: n, iterations: [...data.iterations, iteration] }), arranged(wf.artifacts, [action.plan])),
        events: [{ type: wf.stage === "planner" ? "planner_saved" : "revision_saved", data: { opener: n, planSha: iteration.planSha } }],
      }
    }
    case "architect": {
      assertLive(wf)
      if (wf.stage !== "architect") throw new Error(`architect_verdict is not valid in stage ${wf.stage}`)
      const it = data.iterations[data.iterations.length - 1]
      if (!it) throw new Error("no opener to judge")
      if (it.architect) throw new Error(`architect result for opener ${it.n} is already recorded`)
      if (action.result.planSha !== it.planSha) throw new Error("stale architect verdict: it judged another plan hash")
      const iterations = data.iterations.map(item => item === it ? { ...it, architect: action.result } : item)
      return {
        wf: moved(wf, "critic", phaseOf("critic"), clean({ ...data, iterations }), arranged(wf.artifacts, [action.artifact])),
        events: [{ type: "architect_verdict", data: { opener: it.n, planSha: it.planSha, status: action.result.status, decision: action.result.decision } }],
      }
    }
    case "critic": {
      assertLive(wf)
      if (wf.stage !== "critic") throw new Error(`critic_verdict is not valid in stage ${wf.stage}`)
      const it = data.iterations[data.iterations.length - 1]
      if (!it) throw new Error("no opener to judge")
      if (!it.architect) throw new Error("the architect result for this opener is missing")
      if (it.critic) throw new Error(`critic result for opener ${it.n} is already recorded`)
      if (action.result.planSha !== it.planSha) throw new Error("stale critic verdict: it judged another plan hash")
      const base = clean({ ...data, iterations: data.iterations.map(item => item === it ? { ...it, critic: action.result } : item) })
      const verdictEvent: RalplanEvent = { type: "critic_verdict", data: { opener: it.n, planSha: it.planSha, verdict: action.result.verdict } }
      const outcome = criticOutcome(data, action.result)
      const artifacts = arranged(wf.artifacts, [action.artifact])
      if (outcome === "consensus") return { wf: moved(wf, "consensus_emit", phaseOf("consensus_emit"), base, artifacts), events: [verdictEvent] }
      if (outcome === "revision") return { wf: moved(wf, "revision", phaseOf("revision"), base, artifacts), events: [verdictEvent] }
      if (!action.bestPlan) throw new Error("the opener cap needs a best-plan artifact")
      const best = bestOpener(base)
      const stuck = { kind: "cap" as const, reason: `${PLANNING_STUCK_MARKER}: no consensus after ${RALPLAN_MAX_OPENERS} openers; best plan kept, nothing executed`, bestOpener: best }
      return {
        wf: moved(wf, "terminal", "stuck", { ...base, stuck }, arranged(artifacts, [action.bestPlan])),
        events: [verdictEvent, { type: "cap_reached", data: { openers: data.openers, bestOpener: best, marker: PLANNING_STUCK_MARKER } }],
      }
    }
    case "consensus": {
      assertLive(wf)
      if (wf.stage !== "consensus_emit") throw new Error(`consensus_verified is not valid in stage ${wf.stage}`)
      const it = data.iterations[data.iterations.length - 1]
      if (!it || it.n !== action.consensus.opener || it.planSha !== action.consensus.planSha || !joinReview(it).consensus) throw new Error("consensus does not match a clean join on this plan hash")
      return {
        wf: moved(wf, "pending_execution", phaseOf("pending_execution"), { ...data, consensus: action.consensus }, arranged(wf.artifacts, action.artifacts)),
        events: [{ type: "consensus_verified", data: { opener: it.n, planSha: it.planSha, receipt: action.consensus.ref } }],
      }
    }
    case "stop_here": case "execute_confirmed": {
      assertLive(wf)
      if (wf.stage !== "pending_execution" || !data.consensus) throw new Error(`${action.type} needs a verified consensus at pending_execution`)
      if (action.choice.planSha !== data.consensus.planSha) throw new Error("choice names another plan hash")
      const event = { type: action.type, data: { planSha: action.choice.planSha, executed: false } }
      if (action.type === "stop_here") return { wf: moved(wf, "terminal", "done", { ...data, choice: action.choice }, wf.artifacts), events: [event] }
      // The typed execute confirmation ends planning: ralplan is done (terminal form) and the same commit hands off to
      // ultragoal. It authorizes only that handoff; every execution unit still needs its own APPROVE-UNIT receipt.
      return { wf: moved(wf, "terminal", "done", { ...data, choice: action.choice }, wf.artifacts), events: [event] }
    }
    case "attempt_failed": {
      assertLive(wf)
      if (wf.stage === "consensus_emit" || wf.stage === "pending_execution" || wf.stage === "terminal") throw new Error(`stage ${wf.stage} has no model attempt`)
      const attempts = action.fatal ? RALPLAN_MAX_ATTEMPTS : data.attempts + 1
      const reason = action.reason.slice(0, 900) || "attempt failed"
      const failed: RalplanEvent = { type: "attempt_failed", data: { stage: wf.stage, attempts, reason } }
      if (attempts < RALPLAN_MAX_ATTEMPTS) return { wf: moved(wf, wf.stage, wf.phase, { ...data, attempts, failure: reason }, wf.artifacts), events: [failed] }
      const stuck = { kind: "attempts" as const, reason: `${wf.stage} failed ${attempts} times: ${reason}`.slice(0, 1_000) }
      return { wf: moved(wf, wf.stage, "stuck", { ...data, attempts, failure: reason, stuck }, wf.artifacts), events: [failed, { type: "stuck", data: { stage: wf.stage, kind: "attempts" } }] }
    }
    case "retry": {
      if (wf.phase !== "stuck" || wf.stage === "terminal" || wf.stopIntent) throw new Error("only a workflow stuck at a live stage can retry")
      const { stuck: _stuck, ...rest } = data
      return { wf: moved(wf, wf.stage, phaseOf(wf.stage), clean(rest), wf.artifacts), events: [{ type: "retry", data: { stage: wf.stage } }] }
    }
  }
}
