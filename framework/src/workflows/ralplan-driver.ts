// Ralplan driver (P6a S3). Runs the engine step by step: every model call is a bound, read-only `runWorkflowTurn`; its
// text is parsed as typed stage events; the code writes artifacts and receipts and commits one transition per step with
// compare-and-swap on the committed revision. A diagnostic result (stale binding) applies nothing. No step here can start
// an implementation, approve a plan or reach the ledger: the end of the road is `pending_execution`.
import type { ExecutionRuntime } from "../hosts/types.ts"
import { currentOwner } from "../flow/owner.ts"
import {
  assertFlowTxWorktree, newWorkflowId, readAnyWorkflowForWrite, rotate, withFlowTransaction, workflowReadError, type FlowTx,
} from "../flow/state.ts"
import { getOwnedSession } from "../sessions/store.ts"
import { liveAdmission } from "./session-guard.ts"
import { readArtifactBytes, sha256, verifyArtifact } from "./artifacts.ts"
import { commitHandoff, commitRevision, readCommitted } from "./commit.ts"
import { handoffToUltragoal } from "./ultragoal-driver.ts"
import type { UgSeed } from "./ultragoal-data.ts"
import {
  architectVerdictOf, bestOpener, criticOutcome, criticVerdictOf, isRalplan, nextStep, PLANNING_STUCK_MARKER, planDocOf,
  ralplanDataOf, reduce, renderArchitectMarkdown, renderBestPlan, renderCriticMarkdown, renderPendingApproval, renderPlanMarkdown,
  type RalplanWorkflow,
} from "./ralplan.ts"
import { commitRalplan, seedFromSpec, type CommitOutcome } from "./ralplan-commit.ts"
import { initialRalplanData, type RalplanChoice, type RalplanData, type RalplanIteration, type RalplanSeed } from "./ralplan-data.ts"
import {
  consensusLine, readRecorded, retainPlan, writeArchitectReceipt, writeConsensusReceipt, writeCriticReceipt, writeReadable, verifyConsensusEvidence,
} from "./ralplan-evidence.ts"
import { verifyReceiptRef, writeReceipt } from "./receipts.ts"
import {
  RALPLAN_ARCHITECT_PROMPT, RALPLAN_CRITIC_PROMPT, RALPLAN_PLANNER_PROMPT, RALPLAN_REVISION_PROMPT, RALPLAN_SUMMARIZE_PROMPT, type StagePrompt,
} from "./prompts/index.ts"
import { ModelRequestError, parseStageEventsFor, runWorkflowTurn, type TurnBinding, type TurnResult } from "./turn.ts"
import { TERMINAL, type WorkflowEnvelope } from "./types.ts"

/** Same bounded conversation budget as the plan conversation: 24k chars of request, 8k reserved for the reply. */
export const RALPLAN_TURN_BUDGET = Object.freeze({ maxChars: 24_000, reserveChars: 8_000 })
const REQUEST_MAX = 4_000

// ---------------------------------------------------------------------------------------------- start
export type StartResult = { ok: true; wf: RalplanWorkflow } | { ok: false; text: string }

export function newRalplan(sessionID: string, owner: { instance: string; pid: number }, engine: string, request: string, seed?: RalplanSeed, now = Date.now()): RalplanWorkflow {
  return {
    version: 2, id: newWorkflowId(now), kind: "ralplan", stage: "planner", engine, phase: "planning", sessionID,
    owner: { instance: owner.instance, pid: owner.pid }, stopIntent: null, artifacts: [],
    data: { ...initialRalplanData(request.slice(0, REQUEST_MAX)), ...(seed ? { seed } : {}) },
    lastSeq: 0, createdAt: now, updatedAt: now,
  } as RalplanWorkflow
}

/**
 * Start a ralplan in the free (or terminal) slot. Refuses while any workflow is active, without a live unheld session,
 * or when a supplied seed does not verify against the spec on disk. The model never reaches this path.
 */
export function startRalplan(runtime: Pick<ExecutionRuntime, "worktree" | "host">, sessionID: string, request: string, options: { seed?: RalplanSeed; now?: number } = {}): StartResult {
  if (!request.trim()) return { ok: false, text: "a ralplan needs a request" }
  const now = options.now ?? Date.now()
  return withFlowTransaction(runtime.worktree, (tx): StartResult => {
    assertFlowTxWorktree(tx, runtime.worktree)
    const occupant = readAnyWorkflowForWrite(tx)
    if (occupant.corrupt) throw workflowReadError(occupant)
    if (occupant.wf && !TERMINAL.has(occupant.wf.phase)) {
      return { ok: false, text: `${occupant.wf.kind} workflow ${occupant.wf.id} is active${occupant.wf.sessionID === sessionID ? "; use /status or /cancel" : ` in session ${occupant.wf.sessionID}`}` }
    }
    const admitted = liveAdmission(runtime, sessionID)
    if (typeof admitted === "string") return { ok: false, text: admitted }
    if (options.seed) {
      const spec = verifyArtifact(runtime.worktree, { key: "spec.md", path: options.seed.specPath, sha256: options.seed.specSha })
      if (spec.state !== "verified") return { ok: false, text: `seed specification is ${spec.state}: ${spec.reason}` }
    }
    const created = newRalplan(sessionID, currentOwner(now, admitted.epoch), String(runtime.host.identity.engine), request, options.seed, now)
    rotate(tx)
    const wf = commitRevision(tx, created, [
      { wf: created.id, type: "created", actor: "code", data: { kind: "ralplan", chars: request.length, seeded: options.seed !== undefined } },
      { wf: created.id, type: "transition", to: "planning", actor: "code", data: { event: "start" } },
    ], now)
    return { ok: true, wf: wf as RalplanWorkflow }
  })
}

/**
 * DI -> ralplan: one `commitHandoff`. The predecessor arrives in its done terminal form with a recorded spec.md; the
 * seed is verified here (path and hash from disk) and the lineage is stamped by the commit. Held, paused, foreign or
 * pending-stop sessions are refused by the live-admission check and by the commit.
 */
export function handoffToRalplan(
  runtime: Pick<ExecutionRuntime, "worktree" | "host">, sessionID: string, predecessorDone: WorkflowEnvelope, request: string,
  predecessorEvents: Parameters<typeof commitHandoff>[1]["predecessorEvents"], options: { now?: number } = {},
): StartResult {
  const now = options.now ?? Date.now()
  return withFlowTransaction(runtime.worktree, (tx): StartResult => {
    const admitted = liveAdmission(runtime, sessionID)
    if (typeof admitted === "string") return { ok: false, text: admitted }
    if (predecessorDone.sessionID !== sessionID || predecessorDone.owner.instance !== admitted.epoch) return { ok: false, text: "handoff refused: the predecessor is not owned by this live session epoch" }
    let seed: RalplanSeed
    try { seed = seedFromSpec(runtime.worktree, predecessorDone) }
    catch (error) { return { ok: false, text: (error as Error).message } }
    const successor = newRalplan(sessionID, predecessorDone.owner, String(runtime.host.identity.engine), request, seed, now)
    try {
      const result = commitHandoff(tx, {
        predecessor: predecessorDone, artifactKey: "spec.md", successor, predecessorEvents,
        successorEvents: [
          { wf: successor.id, type: "created", actor: "code", data: { kind: "ralplan", chars: request.length, seeded: true, from: predecessorDone.id } },
          { wf: successor.id, type: "transition", to: "planning", actor: "code", data: { event: "start" } },
        ],
      }, now)
      return { ok: true, wf: result.successor as RalplanWorkflow }
    } catch (error) { return { ok: false, text: (error as Error).message } }
  })
}

// ---------------------------------------------------------------------------------------------- context
const MARK = "=== "

function section(label: string, text: string): string {
  return `${MARK}${label} ===\n${text.trim()}\n`
}

function compose(prompt: StagePrompt, sections: ReadonlyArray<readonly [string, string]>): { text: string; source: string; rebuild(summary: string): string } {
  const source = sections.map(([label, text]) => section(label, text)).join("\n")
  return { text: `${prompt.text}${source}`, source, rebuild: summary => `${prompt.text}${section("SUMMARIZED CONTEXT", summary)}` }
}

function findingsOf(runtime: Pick<ExecutionRuntime, "worktree">, wf: RalplanWorkflow, ref: string, planSha: string): string[] {
  const read = verifyReceiptRef(runtime.worktree, ref, { sessionID: wf.sessionID, workflowID: wf.id, kind: "consensus", inputSha: planSha })
  if (!read.ok) throw new Error(`lane receipt unreadable: ${read.reason}`)
  const findings = read.receipt.body.findings
  return Array.isArray(findings) ? findings.filter((item): item is string => typeof item === "string") : []
}

const listed = (items: readonly string[]) => items.length ? items.map(item => `- ${item}`).join("\n") : "- none"

type SeedSummary = { specSha: string; text: string }

function verifiedSeed(runtime: Pick<ExecutionRuntime, "worktree">, wf: RalplanWorkflow): { seed: RalplanSeed; text: string } | undefined {
  const seed = ralplanDataOf(wf).seed
  if (!seed) return undefined
  const read = readArtifactBytes(runtime.worktree.length ? `${runtime.worktree}/${seed.specPath}` : seed.specPath)
  if (!read.ok || sha256(read.bytes) !== seed.specSha) throw new Error("seed specification is missing or changed since the handoff")
  return { seed, text: read.bytes.toString("utf8") }
}

/** Bounded comparison aid, not a replacement for the complete current plan. */
function changedPlanSpan(previous: string, current: string): string {
  // The renderer's opener heading changes on every pass; compare only the plan body.
  const before = previous.split("\n").slice(1)
  const after = current.split("\n").slice(1)
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let suffix = 0
  while (suffix < before.length - start && suffix < after.length - start && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  if (start === before.length && start === after.length) return "No plan body changes; opener heading only."
  const excerpt = (lines: string[]) => {
    const text = lines.join("\n")
    return text.length > 900 ? `${text.slice(0, 900)}\n[changed span truncated; inspect the complete current plan]` : text || "(empty)"
  }
  return `Opener headings omitted. Shared prefix ${start} lines; shared suffix ${suffix} lines.\nPrevious changed span:\n${excerpt(before.slice(start, before.length - suffix))}\nCurrent changed span:\n${excerpt(after.slice(start, after.length - suffix))}`
}

function planTextOf(runtime: Pick<ExecutionRuntime, "worktree">, wf: RalplanWorkflow, it: RalplanIteration): string {
  const text = readRecorded(runtime.worktree, wf, it.planKey)
  if (sha256(Buffer.from(text, "utf8")) !== it.planSha) throw new Error("plan artifact does not hash to the recorded plan sha")
  return text
}

type TurnPlan = { stage: "planner" | "revision" | "architect" | "critic"; prompt: StagePrompt; role: "planner" | "architect" | "critic"; context: ReturnType<typeof compose> }

/** What the model is shown for this step. Pass 1: the critic sees the plan only. Later: the critic sees this pass's architect findings. */
export function buildTurn(runtime: Pick<ExecutionRuntime, "worktree">, wf: RalplanWorkflow, summary?: SeedSummary): TurnPlan {
  const data = ralplanDataOf(wf)
  const step = nextStep(wf)
  if (step.kind !== "turn") throw new Error(`stage ${wf.stage} has no model turn`)
  const header = [`Request:`, data.request] as const
  const seed = (): Array<readonly [string, string]> => {
    const verified = verifiedSeed(runtime, wf)
    if (!verified) return []
    if (summary?.specSha === verified.seed.specSha) return [[`MODEL SUMMARY OF VERIFIED SPECIFICATION ${verified.seed.specPath} sha256 ${verified.seed.specSha}`, `Derived context, not approval or independent evidence. Preserve uncertainty where details are omitted.\n${summary.text}`]]
    return [[`VERIFIED SPECIFICATION ${verified.seed.specPath} sha256 ${verified.seed.specSha}`, verified.text]]
  }
  const retry: Array<readonly [string, string]> = data.attempts > 0 && data.failure
    ? [["PREVIOUS ATTEMPT DIAGNOSTIC (quoted data; correct the output format)", JSON.stringify(data.failure.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 400))]] : []
  const it = data.iterations[data.iterations.length - 1]
  const previous = data.iterations.length >= 2 ? data.iterations[data.iterations.length - 2] : undefined
  const earlier = (): Array<readonly [string, string]> => {
    if (!previous?.architect || !previous.critic) return []
    return [
      [`EARLIER PASS ${previous.n} FINDINGS`, `Architect ${previous.architect.status}/${previous.architect.decision}:\n${listed(findingsOf(runtime, wf, previous.architect.ref, previous.planSha))}\nCritic ${previous.critic.verdict}:\n${listed(findingsOf(runtime, wf, previous.critic.ref, previous.planSha))}`],
      [`PLAN CHANGES SINCE OPENER ${previous.n}`, `Previous sha256 ${previous.planSha}; current sha256 ${it!.planSha}.\n${changedPlanSpan(planTextOf(runtime, wf, previous), planTextOf(runtime, wf, it!))}`],
    ]
  }
  switch (step.stage) {
    case "planner":
      return { stage: "planner", prompt: RALPLAN_PLANNER_PROMPT, role: "planner", context: compose(RALPLAN_PLANNER_PROMPT, [[header[0], header[1]], ...seed(), ...retry]) }
    case "revision": {
      if (!it?.architect || !it.critic) throw new Error("revision needs the previous reviewed opener")
      return {
        stage: "revision", prompt: RALPLAN_REVISION_PROMPT, role: "planner",
        context: compose(RALPLAN_REVISION_PROMPT, [
          [header[0], header[1]], ...seed(),
          [`PLAN UNDER REVISION (opener ${it.n})`, planTextOf(runtime, wf, it)],
          [`ARCHITECT ${it.architect.status}/${it.architect.decision}`, listed(findingsOf(runtime, wf, it.architect.ref, it.planSha))],
          [`CRITIC ${it.critic.verdict}`, listed(findingsOf(runtime, wf, it.critic.ref, it.planSha))],
          ...retry,
        ]),
      }
    }
    case "architect": {
      if (!it) throw new Error("architect needs an opener")
      return { stage: "architect", prompt: RALPLAN_ARCHITECT_PROMPT, role: "architect", context: compose(RALPLAN_ARCHITECT_PROMPT, [[header[0], header[1]], ...seed(), [`PLAN TO REVIEW (opener ${it.n}, sha256 ${it.planSha})`, planTextOf(runtime, wf, it)], ...earlier(), ...retry]) }
    }
    case "critic": {
      if (!it?.architect) throw new Error("critic needs the architect result of this opener")
      const sections: Array<readonly [string, string]> = [[header[0], header[1]], ...seed(), [`PLAN TO REVIEW (opener ${it.n}, sha256 ${it.planSha})`, planTextOf(runtime, wf, it)], ...earlier(), ...retry]
      // Pass 1 is independent: the critic judges the plan alone. Later passes are sequential and see this pass's architect findings.
      if (it.n >= 2) sections.push([`THIS PASS ARCHITECT ${it.architect.status}/${it.architect.decision}`, listed(findingsOf(runtime, wf, it.architect.ref, it.planSha))])
      return { stage: "critic", prompt: RALPLAN_CRITIC_PROMPT, role: "critic", context: compose(RALPLAN_CRITIC_PROMPT, sections) }
    }
  }
}

// ---------------------------------------------------------------------------------------------- run
export type RalplanRunStatus = "pending_execution" | "stuck" | "blocked" | "stale" | "done"
export type RalplanRunResult = { status: RalplanRunStatus; wf: RalplanWorkflow | null; reason?: string }
export type RalplanRunOptions = {
  signal?: AbortSignal
  onStep?(wf: RalplanWorkflow): void
  /** Return `blocked` instead of running the step at this stage (lets a caller or test pause between stages). */
  stopBefore?: RalplanWorkflow["stage"]
}

const fitsTurn = (text: string) => text.length + RALPLAN_TURN_BUDGET.reserveChars <= RALPLAN_TURN_BUDGET.maxChars

async function summarizeSeed(runtime: ExecutionRuntime, binding: TurnBinding, seed: NonNullable<ReturnType<typeof verifiedSeed>>, signal?: AbortSignal): Promise<TurnResult> {
  let result: TurnResult
  try {
    result = await runWorkflowTurn(runtime, { ...binding, role: "planner", prompt: RALPLAN_SUMMARIZE_PROMPT }, {
      title: "ralplan seed summary", label: "ralplan", cancelCause: "ralplan seed summary cancelled", budget: RALPLAN_TURN_BUDGET,
      text: `${RALPLAN_SUMMARIZE_PROMPT.text}${section(`VERIFIED SPECIFICATION ${seed.seed.specPath} sha256 ${seed.seed.specSha}`, seed.text)}`,
    }, signal)
  } catch (error) {
    if (error instanceof ModelRequestError && (error.category === "empty_response" || error.category === "response_budget")) {
      return { status: "stuck", cause: "input_budget", reason: "ralplan seed summary is empty or exceeds the response budget" }
    }
    throw error
  }
  if (result.status === "completed" && (!result.text.trim() || result.text.length >= seed.text.length)) {
    return { status: "stuck", cause: "input_budget", reason: "ralplan seed summary did not shrink the specification" }
  }
  return result
}

const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/

/** One fenced JSON object is accepted, exactly as the host envelope allows; anything else must be bare JSON. */
function unfenced(output: string): string {
  const match = FENCE.exec(output.trim())
  return match ? match[1]! : output
}

function committedRalplan(runtime: Pick<ExecutionRuntime, "worktree">, sessionID: string, workflowID: string): RalplanWorkflow | string {
  let read: ReturnType<typeof readCommitted>
  try { read = readCommitted(runtime.worktree) } catch { return "workflow state is unreadable" }
  if (read.state !== "ok") return "workflow state is unavailable"
  const { wf } = read
  if (wf.id !== workflowID || wf.sessionID !== sessionID) return "workflow identity changed"
  if (!isRalplan(wf)) return `workflow is a ${wf.kind} workflow`
  return wf
}

function failureCommit(runtime: Pick<ExecutionRuntime, "worktree">, wf: RalplanWorkflow, reason: string, fatal = false): CommitOutcome {
  return commitRalplan(runtime.worktree, wf, fresh => reduce(fresh, { type: "attempt_failed", reason, fatal }))
}

/** Apply one successfully parsed lane/plan event: write artifacts and receipts, then commit the transition. */
function applyOutput(runtime: Pick<ExecutionRuntime, "worktree">, wf: RalplanWorkflow, turn: TurnPlan, output: string): CommitOutcome | { ok: false; text: string; attempt: true } {
  const parsed = parseStageEventsFor(unfenced(output), "ralplan", turn.stage)
  if (!parsed.ok) return { ok: false, text: parsed.reason, attempt: true }
  const worktree = runtime.worktree
  switch (turn.stage) {
    case "planner": case "revision": {
      const doc = planDocOf(parsed.events)
      if (!doc.ok) return { ok: false, text: doc.reason, attempt: true }
      return commitRalplan(worktree, wf, fresh => {
        const n = ralplanDataOf(fresh).openers + 1
        const text = renderPlanMarkdown(n, doc.value)
        const plan = writeReadable(worktree, fresh, `iteration-${n}/plan.md`, text)
        retainPlan(worktree, fresh, text)
        return reduce(fresh, { type: "plan_saved", plan })
      })
    }
    case "architect": {
      const verdict = architectVerdictOf(parsed.events)
      if (!verdict.ok) return { ok: false, text: verdict.reason, attempt: true }
      return commitRalplan(worktree, wf, fresh => {
        const it = ralplanDataOf(fresh).iterations.at(-1)!
        const ref = writeArchitectReceipt(worktree, fresh, it.n, it.planSha, verdict.value, turn.prompt.sha256, output)
        const artifact = writeReadable(worktree, fresh, `iteration-${it.n}/architect.md`, renderArchitectMarkdown(it.n, { ...verdict.value, planSha: it.planSha }, verdict.value.findings))
        const result = { status: verdict.value.status, decision: verdict.value.decision, planSha: it.planSha, ref, findings: verdict.value.findings.length }
        return { ...reduce(fresh, { type: "architect", result, artifact }), receipts: [ref] }
      })
    }
    case "critic": {
      const verdict = criticVerdictOf(parsed.events)
      if (!verdict.ok) return { ok: false, text: verdict.reason, attempt: true }
      return commitRalplan(worktree, wf, fresh => {
        const data = ralplanDataOf(fresh)
        const it = data.iterations.at(-1)!
        const ref = writeCriticReceipt(worktree, fresh, it.n, it.planSha, verdict.value, turn.prompt.sha256, output)
        const artifact = writeReadable(worktree, fresh, `iteration-${it.n}/critic.md`, renderCriticMarkdown(it.n, { ...verdict.value, planSha: it.planSha }, verdict.value.findings))
        const result = { verdict: verdict.value.verdict, planSha: it.planSha, ref, findings: verdict.value.findings.length }
        if (criticOutcome(data, result) !== "cap") return { ...reduce(fresh, { type: "critic", result, artifact }), receipts: [ref] }
        // Five openers without consensus: keep the best reviewed plan with residual caveats; never hand off.
        const judged: RalplanData = { ...data, iterations: data.iterations.map(item => item === it ? { ...it, critic: result } : item) }
        const best = judged.iterations[bestOpener(judged) - 1]!
        const caveats: string[] = []
        for (const lane of [best.architect, best.critic]) if (lane) caveats.push(...findingsOf(runtime, fresh, lane.ref, best.planSha))
        const bestPlanText = best === it ? readPlan(worktree, fresh, it) : planTextOf(runtime, fresh, best)
        const bestPlan = writeReadable(worktree, fresh, "best-plan.md", renderBestPlan(judged, best.n, bestPlanText, caveats))
        return { ...reduce(fresh, { type: "critic", result, artifact, bestPlan }), receipts: [ref] }
      })
    }
  }
}

function readPlan(worktree: string, wf: RalplanWorkflow, it: RalplanIteration): string {
  return planTextOf({ worktree }, wf, it)
}

/** consensus_emit: re-derive the join from disk, write the consensus receipt, consensus.json and pending-approval.md, publish. */
export function emitConsensus(runtime: Pick<ExecutionRuntime, "worktree">, wf: RalplanWorkflow): CommitOutcome {
  const worktree = runtime.worktree
  return commitRalplan(worktree, wf, fresh => {
    if (fresh.stage !== "consensus_emit") throw new Error(`consensus is not emitted from stage ${fresh.stage}`)
    const data = ralplanDataOf(fresh)
    const it = data.iterations.at(-1)
    if (!it) throw new Error("no opener to emit")
    const evidence = verifyConsensusEvidence(worktree, fresh, it.n)
    if (!evidence.ok) throw new Error(`consensus refused: ${evidence.reason}`)
    const ref = writeConsensusReceipt(worktree, fresh, it)
    const consensusJson = writeReadable(worktree, fresh, "consensus.json", `${JSON.stringify({
      wid: fresh.id, opener: it.n, planSha: it.planSha, architect: { status: it.architect!.status, decision: it.architect!.decision, ref: it.architect!.ref },
      critic: { verdict: it.critic!.verdict, ref: it.critic!.ref }, receipt: ref, executed: false,
    }, null, 2)}\n`)
    const pending = writeReadable(worktree, fresh, "pending-approval.md", renderPendingApproval(planTextOf(runtime, fresh, it), it, ref))
    return { ...reduce(fresh, { type: "consensus", consensus: { opener: it.n, planSha: it.planSha, ref }, artifacts: [pending, consensusJson] }), receipts: [ref] }
  })
}

/**
 * Run the workflow until it needs a human, finishes or gets stuck. Every iteration re-reads the committed state, so a
 * pause, cancel, revision change or a foreign write turns the next step into `stale`/`blocked` without applying anything.
 */
export async function runRalplan(runtime: ExecutionRuntime, sessionID: string, workflowID: string, options: RalplanRunOptions = {}): Promise<RalplanRunResult> {
  // Derived text only, never a verdict or durable authority. Reattachment/new runs
  // rebuild it; live model routes are fixed by this host, not a shared global cache.
  let seedCache: { key: string; host: ExecutionRuntime["host"]; summary: SeedSummary } | undefined
  for (;;) {
    const current = committedRalplan(runtime, sessionID, workflowID)
    if (typeof current === "string") return { status: "stale", wf: null, reason: current }
    options.onStep?.(current)
    const step = nextStep(current)
    if (options.stopBefore === current.stage && step.kind !== "done") return { status: "blocked", wf: current, reason: `stopped before ${current.stage}` }
    if (step.kind === "done") return { status: "done", wf: current }
    if (step.kind === "blocked") return { status: current.phase === "stuck" ? "stuck" : "blocked", wf: current, reason: step.reason }
    if (step.kind === "choice") return { status: "pending_execution", wf: current }
    if (step.kind === "emit") {
      const emitted = emitConsensus(runtime, current)
      if (!emitted.ok) return { status: "blocked", wf: current, reason: emitted.text }
      continue
    }

    const seed = ralplanDataOf(current).seed
    const cacheHost = runtime.host
    const cacheKey = JSON.stringify([workflowID, seed, RALPLAN_SUMMARIZE_PROMPT.sha256, RALPLAN_TURN_BUDGET, runtime.host.identity, runtime.config.chat])
    if (seedCache && (seedCache.key !== cacheKey || seedCache.host !== runtime.host)) seedCache = undefined
    let turn: TurnPlan
    let seedInput: ReturnType<typeof verifiedSeed>
    try {
      turn = buildTurn(runtime, current, seedCache?.summary)
      if (!seedCache && seed && !fitsTurn(turn.context.text)) seedInput = verifiedSeed(runtime, current)
    }
    catch (error) {
      const failed = failureCommit(runtime, current, `context unavailable: ${(error as Error).message}`, true)
      if (!failed.ok) return { status: "stale", wf: current, reason: failed.text }
      continue
    }
    const store = (() => { try { return getOwnedSession(runtime.worktree, sessionID) } catch { return undefined } })()
    const binding: TurnBinding = {
      workflowID: current.id, revision: current.lastSeq, kind: "ralplan", stage: current.stage, role: turn.role, prompt: turn.prompt,
      supervisorSessionID: sessionID, epoch: store?.epoch ?? null, ownerInstance: current.owner.instance,
    }
    let result: TurnResult | undefined
    try {
      if (seedInput) {
        const summarized = await summarizeSeed(runtime, binding, seedInput, options.signal)
        if (summarized.status !== "completed") result = summarized
        else {
          const summary = { specSha: seedInput.seed.specSha, text: summarized.text }
          // Re-read and hash-check the source after the await before retaining or
          // using the derived text. The following bound turn checks live ownership.
          try { turn = buildTurn(runtime, current, summary) }
          catch (error) {
            const failed = failureCommit(runtime, current, `context unavailable: ${(error as Error).message}`, true)
            if (!failed.ok) return { status: "stale", wf: current, reason: failed.text }
            continue
          }
          seedCache = { key: cacheKey, host: cacheHost, summary }
        }
      }
      result ??= await runWorkflowTurn(runtime, binding, {
        title: `ralplan ${turn.stage} (opener ${step.opener})`, text: turn.context.text, budget: RALPLAN_TURN_BUDGET, label: "ralplan",
        cancelCause: `ralplan ${turn.stage} cancelled`, compact: { source: turn.context.source, rebuild: turn.context.rebuild },
      }, options.signal)
    } catch (error) {
      // A model that cannot produce a bounded response is a counted attempt failure (two make the workflow visibly
      // stuck with Retry); lifecycle, cancellation and fence errors stay fatal to the caller.
      const message = (error as Error).message ?? String(error)
      if (!/did not complete a response|exceeds the reserved conversation response budget/.test(message)) throw error
      const failed = failureCommit(runtime, current, message)
      if (!failed.ok) return { status: "stale", wf: current, reason: failed.text }
      continue
    }
    if (result.status === "diagnostic") return { status: "stale", wf: current, reason: result.reason }
    if (result.status === "stuck") {
      const failed = failureCommit(runtime, current, result.reason, true)
      if (!failed.ok) return { status: "stale", wf: current, reason: failed.text }
      continue
    }
    const applied = applyOutput(runtime, current, turn, result.text)
    if (applied.ok) continue
    if ("attempt" in applied) {
      const failed = failureCommit(runtime, current, applied.text)
      if (!failed.ok) return { status: "stale", wf: current, reason: failed.text }
      continue
    }
    return { status: "stale", wf: current, reason: applied.text }
  }
}

// ---------------------------------------------------------------------------------------------- choices
export type ChoiceResult = { ok: true; wf: RalplanWorkflow } | { ok: false; text: string }

function atPending(runtime: Pick<ExecutionRuntime, "worktree">, sessionID: string, workflowID: string, expectedRevision: number): RalplanWorkflow | string {
  const current = committedRalplan(runtime, sessionID, workflowID)
  if (typeof current === "string") return current
  if (current.lastSeq !== expectedRevision) return "workflow revision changed; the choice is stale"
  if (current.stage !== "pending_execution" || current.phase !== "pending_approval") return `workflow is at ${current.stage}/${current.phase}, not awaiting a choice`
  return current
}

function choiceFor(kind: RalplanChoice["kind"], wf: RalplanWorkflow): RalplanChoice | string {
  const data = ralplanDataOf(wf)
  if (!data.consensus) return "no verified consensus"
  return { kind, planSha: data.consensus.planSha, executed: false }
}

function recordChoice(runtime: Pick<ExecutionRuntime, "worktree">, current: RalplanWorkflow, kind: RalplanChoice["kind"]): ChoiceResult {
  const choice = choiceFor(kind, current)
  if (typeof choice === "string") return { ok: false, text: choice }
  const outcome = commitRalplan(runtime.worktree, current, fresh => {
    const evidence = verifyConsensusEvidence(runtime.worktree, fresh)
    if (!evidence.ok) throw new Error(`choice refused: ${evidence.reason}`)
    const pending = fresh.artifacts.find(ref => ref.key === "pending-approval.md")
    if (!pending?.sha256) throw new Error("pending-approval.md is not recorded")
    const receipt = writeReceipt(runtime.worktree, {
      kind: "choice", wid: fresh.id, sid: fresh.sessionID, revision: fresh.lastSeq, action: `choice-${kind.replace("_", "-")}`, inputSha: choice.planSha,
      body: { choice: kind, planSha: choice.planSha, executed: false },
    })
    return { ...reduce(fresh, { type: kind, choice }), receipts: [receipt] }
  })
  return outcome.ok ? { ok: true, wf: outcome.wf } : { ok: false, text: outcome.text }
}

/** "Stop here": planning is complete and NOT executed. Needs the pending approval, nothing else. */
export function stopHere(runtime: Pick<ExecutionRuntime, "worktree">, sessionID: string, workflowID: string, expectedRevision: number): ChoiceResult {
  const current = atPending(runtime, sessionID, workflowID, expectedRevision)
  if (typeof current === "string") return { ok: false, text: current }
  return recordChoice(runtime, current, "stop_here")
}

/** The exact text a human types to confirm "Execute via ultragoal". */
export function executeConfirmation(workflowID: string, planSha: string): string {
  return `EXECUTE ${workflowID} ${planSha}`
}

/**
 * "Execute via ultragoal". Typed confirmation of the exact workflow and plan hash is required. It authorizes ONLY the
 * handoff: one `commitHandoff` finishes this ralplan (done, with the execute choice receipt) and creates the ultragoal at
 * decompose with lineage to this ralplan's id, revision and pending-approval.md path and hash. No unit runs and no task
 * exists until each unit gets its own APPROVE-UNIT receipt. Refused with zero state change on any mismatch.
 */
export function confirmExecute(runtime: Pick<ExecutionRuntime, "worktree" | "host">, sessionID: string, workflowID: string, expectedRevision: number, typed: string): ChoiceResult {
  const current = atPending(runtime, sessionID, workflowID, expectedRevision)
  if (typeof current === "string") return { ok: false, text: current }
  const data = ralplanDataOf(current)
  if (!data.consensus) return { ok: false, text: "no verified consensus" }
  if (typed.trim() !== executeConfirmation(current.id, data.consensus.planSha)) return { ok: false, text: `typed confirmation must be exactly: ${executeConfirmation(current.id, data.consensus.planSha)}` }
  const choice = choiceFor("execute_confirmed", current)
  if (typeof choice === "string") return { ok: false, text: choice }
  const evidence = verifyConsensusEvidence(runtime.worktree, current)
  if (!evidence.ok) return { ok: false, text: `choice refused: ${evidence.reason}` }
  const pending = current.artifacts.find(ref => ref.key === "pending-approval.md")
  if (!pending?.sha256) return { ok: false, text: "pending-approval.md is not recorded" }
  let receipt: string
  let transition: ReturnType<typeof reduce>
  try {
    receipt = writeReceipt(runtime.worktree, {
      kind: "choice", wid: current.id, sid: current.sessionID, revision: current.lastSeq, action: "choice-execute-confirmed", inputSha: choice.planSha,
      body: { choice: "execute_confirmed", planSha: choice.planSha, executed: false },
    })
    transition = reduce(current, { type: "execute_confirmed", choice })
  } catch (error) { return { ok: false, text: (error as Error).message } }
  const seed: UgSeed = { workflowID: current.id, planPath: pending.path, planSha: pending.sha256, consensusRef: data.consensus.ref, executeChoiceRef: receipt }
  const handed = handoffToUltragoal(
    runtime, sessionID, { ...transition.wf, lastSeq: current.lastSeq } as WorkflowEnvelope, data.request, seed,
    transition.events.map(event => ({ wf: current.id, type: event.type, actor: "user_command" as const, ...(event.data ? { data: event.data } : {}) })),
  )
  return handed.ok ? { ok: true, wf: transition.wf } : { ok: false, text: handed.text }
}

/** Retry after an attempt-failure stuck: resumes the same stage. The cap stuck (terminal) cannot retry. */
export function retryRalplan(runtime: Pick<ExecutionRuntime, "worktree">, sessionID: string, workflowID: string, expectedRevision: number): ChoiceResult {
  const current = committedRalplan(runtime, sessionID, workflowID)
  if (typeof current === "string") return { ok: false, text: current }
  if (current.lastSeq !== expectedRevision) return { ok: false, text: "workflow revision changed; the retry is stale" }
  const outcome = commitRalplan(runtime.worktree, current, fresh => reduce(fresh, { type: "retry" }))
  return outcome.ok ? { ok: true, wf: outcome.wf } : { ok: false, text: outcome.text }
}

export { consensusLine, PLANNING_STUCK_MARKER }
export type { FlowTx }
