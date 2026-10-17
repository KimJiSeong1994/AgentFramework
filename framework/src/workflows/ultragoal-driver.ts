// Ultragoal driver (P6b S2). Runs the engine step by step: every model call is a bound, read-only `runWorkflowTurn`; its
// text is parsed as typed stage events; the code writes artifacts and receipts and commits one transition per step with
// compare-and-swap on the committed revision. Work reaches the queue only through `controller.runApprovedUnit` on a
// unit whose typed APPROVE-UNIT receipt names the current subject; `startWorkflow` is never called. The workflow is done
// only when every goal's checkpoint proof re-verifies in the commit transaction.
import { join, resolve } from "node:path"
import { currentOwner } from "../flow/owner.ts"
import { canonicalPlanJson, coercePlan, planToTasks, UNIT_LIMITS, validatePlan, type Plan } from "../flow/plan.ts"
import { insertApprovedUnitTasks } from "../flow/runtime.ts"
import { assertFlowTxWorktree, newWorkflowId, readAnyWorkflowForWrite, rotate, withFlowTransaction, workflowReadError } from "../flow/state.ts"
import type { ExecutionRuntime } from "../hosts/types.ts"
import { getOwnedSession } from "../sessions/store.ts"
import { readLedger } from "../state/ledger.ts"
import { durableWriteBytes } from "../state/durable.ts"
import { readArtifactBytes, sha256, verifyArtifact, workflowArtifactDirectory } from "./artifacts.ts"
import { commitHandoff, commitRevision, readCommitted } from "./commit.ts"
import { worktreeDigest } from "./checkpoint.ts"
import { implementationUnitSubject, subjectSha256 } from "./execution-unit.ts"
import {
  ULTRAGOAL_DECOMPOSE_PROMPT, ULTRAGOAL_FINAL_REVIEW_PROMPT, ULTRAGOAL_UNIT_PLAN_PROMPT, ULTRAGOAL_UNIT_REVIEW_PROMPT, type StagePrompt,
} from "./prompts/index.ts"
import { verifyReceiptRef, writeReceipt } from "./receipts.ts"
import { compose, listed, section, unfenced } from "./stage-context.ts"
import { liveAdmission } from "./session-guard.ts"
import { parseStageEventsFor, runWorkflowTurn, type TurnBinding } from "./turn.ts"
import { TERMINAL, type WorkflowEnvelope } from "./types.ts"
import {
  approveUnitConfirmation, goalsOf, isUltragoal, nextStep, openGoals, reduce, ultragoalDataOf, unitPlanOf, verdictOf, type Hashed, type UltragoalWorkflow,
} from "./ultragoal.ts"
import { commitUltragoal, type CommitOutcome } from "./ultragoal-commit.ts"
import {
  goalCheckpointKey, goalIds, initialUltragoalData, type UgCurrent, type UgInput, type UgPending, type UgSeed, type UltragoalData,
} from "./ultragoal-data.ts"
import { readRecordedText, renderCompletion, ultragoalEvidence, verifiedGoals, type CheckpointDoc, type GoalsDoc, type VerificationBody } from "./ultragoal-evidence.ts"

/** Same bounded conversation budget as the other read-only workflow stages. */
export const ULTRAGOAL_TURN_BUDGET = Object.freeze({ maxChars: 24_000, reserveChars: 8_000 })
const REQUEST_MAX = 4_000
const UNIT_DOC_MAX = 16 * 1024

export type StartResult = { ok: true; wf: UltragoalWorkflow } | { ok: false; text: string }
export type ChoiceResult = { ok: true; wf: UltragoalWorkflow } | { ok: false; text: string }
/** The slice of the foreground controller the driver needs: the queue run of an approved unit, never a plan start. */
export type UnitController = { runApprovedUnit(sessionID: string, signal?: AbortSignal, resumed?: boolean): Promise<unknown> }

// ---------------------------------------------------------------------------------------------- start
export function newUltragoal(sessionID: string, owner: { instance: string; pid: number }, engine: string, request: string, seed?: UgSeed, now = Date.now()): UltragoalWorkflow {
  return {
    version: 2, id: newWorkflowId(now), kind: "ultragoal", stage: "decompose", engine, phase: "planning", sessionID,
    owner: { instance: owner.instance, pid: owner.pid }, stopIntent: null, artifacts: [],
    data: { ...initialUltragoalData(request.slice(0, REQUEST_MAX)), ...(seed ? { seed } : {}) },
    lastSeq: 0, createdAt: now, updatedAt: now,
  } as UltragoalWorkflow
}

/** Direct interactive start. A name starts only decomposition; every execution unit still needs APPROVE-UNIT. */
export function startUltragoal(runtime: Pick<ExecutionRuntime, "worktree" | "host">, sessionID: string, request: string, options: { now?: number } = {}): StartResult {
  if (!request.trim()) return { ok: false, text: "an ultragoal needs an execution objective" }
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
    const created = newUltragoal(sessionID, currentOwner(now, admitted.epoch), String(runtime.host.identity.engine), request, undefined, now)
    rotate(tx)
    const wf = commitRevision(tx, created, [
      { wf: created.id, type: "created", actor: "code", data: { kind: "ultragoal", chars: request.length } },
      { wf: created.id, type: "transition", to: "planning", actor: "code", data: { event: "start" } },
    ], now)
    return { ok: true, wf: wf as UltragoalWorkflow }
  })
}

/** The seed's three pieces re-verified from disk: the approved plan file, the consensus receipt and the typed execute receipt. */
export function verifySeed(worktree: string, sessionID: string, seed: UgSeed): string | undefined {
  const plan = verifyArtifact(worktree, { key: "pending-approval.md", path: seed.planPath, sha256: seed.planSha })
  if (plan.state !== "verified") return `approved plan is ${plan.state}: ${plan.reason}`
  const bind = { sessionID, workflowID: seed.workflowID }
  const consensus = verifyReceiptRef(worktree, seed.consensusRef, { ...bind, kind: "consensus" })
  if (!consensus.ok || consensus.receipt.body.role !== "consensus") return `consensus receipt: ${consensus.ok ? "is not a consensus record" : consensus.reason}`
  const choice = verifyReceiptRef(worktree, seed.executeChoiceRef, { ...bind, kind: "choice" })
  if (!choice.ok || choice.receipt.body.choice !== "execute_confirmed") return `execute confirmation: ${choice.ok ? "is not an execute confirmation" : choice.reason}`
  if (choice.receipt.body.planSha !== consensus.receipt.body.planSha) return "execute confirmation names another plan than the consensus"
  return undefined
}

/**
 * ralplan -> ultragoal: ONE `commitHandoff`. The predecessor arrives in its done terminal form (the typed execute
 * confirmation already recorded); the seed is verified here and the lineage is stamped by the commit. The handoff
 * authorizes nothing but the decomposition: every execution unit later needs its own APPROVE-UNIT receipt.
 */
export function handoffToUltragoal(
  runtime: Pick<ExecutionRuntime, "worktree" | "host">, sessionID: string, predecessorDone: WorkflowEnvelope, request: string, seed: UgSeed,
  predecessorEvents: Parameters<typeof commitHandoff>[1]["predecessorEvents"], options: { now?: number } = {},
): StartResult {
  const now = options.now ?? Date.now()
  return withFlowTransaction(runtime.worktree, (tx): StartResult => {
    const admitted = liveAdmission(runtime, sessionID)
    if (typeof admitted === "string") return { ok: false, text: admitted }
    if (predecessorDone.sessionID !== sessionID || predecessorDone.owner.instance !== admitted.epoch) return { ok: false, text: "handoff refused: the predecessor is not owned by this live session epoch" }
    const problem = verifySeed(runtime.worktree, sessionID, seed)
    if (problem) return { ok: false, text: `handoff refused: ${problem}` }
    const successor = newUltragoal(sessionID, predecessorDone.owner, String(runtime.host.identity.engine), request, seed, now)
    try {
      const result = commitHandoff(tx, {
        predecessor: predecessorDone, artifactKey: "pending-approval.md", successor, predecessorEvents,
        successorEvents: [
          { wf: successor.id, type: "created", actor: "code", data: { kind: "ultragoal", chars: request.length, from: predecessorDone.id } },
          { wf: successor.id, type: "transition", to: "planning", actor: "code", data: { event: "start" } },
        ],
      }, now)
      return { ok: true, wf: result.successor as UltragoalWorkflow }
    } catch (error) { return { ok: false, text: (error as Error).message } }
  })
}

// ---------------------------------------------------------------------------------------------- artifacts
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

/** `<worktree>/.otter/workflows/<sid>/<wid>/<key>` as a hash-recorded, worktree-relative artifact reference. */
function writeReadable(worktree: string, wf: Pick<UltragoalWorkflow, "sessionID" | "id" | "artifacts">, key: string, text: string): Hashed {
  if (!KEY_RE.test(key) || key.includes("..")) throw new TypeError("invalid artifact key")
  if (wf.artifacts.some(ref => ref.key === key)) throw new Error(`artifact ${key} is already committed; refusing overwrite`)
  const bytes = Buffer.from(text, "utf8")
  durableWriteBytes(join(workflowArtifactDirectory(worktree, wf.sessionID, wf.id), key), bytes)
  return { key, path: join(".otter", "workflows", wf.sessionID, wf.id, key), sha256: sha256(bytes) }
}

const unitKey = (goalId: string, attempt: number, ext: "json" | "md") => `units/${goalId}-${attempt}.${ext}`

function renderUnit(goalId: string, attempt: number, goal: { title: string; objective: string }, plan: Plan): string {
  const steps = plan.steps.map((step, index) => `${index + 1}. **${step.title}**\n   - files: ${step.files.map(file => `\`${file}\``).join(", ")}\n   - verify: \`${step.verify}\`\n   - detail: ${step.detail.replace(/\n+/g, " ")}`)
  return `# Unit ${goalId} · attempt ${attempt}\n\nGoal: ${goal.title}\n\n${goal.objective}\n\n## Steps\n\n${steps.join("\n")}\n\n## Risks\n\n${plan.risks.map(risk => `- ${risk}`).join("\n")}\n`
}

function unitInputFor(wid: string, goalId: string, attempt: number, plan: Plan, goalsSha: string, planSha: string, artifactHashes: string[]): UgInput {
  const files = plan.steps.flatMap(step => step.files)
  return {
    id: `${wid}:${goalId}:${attempt}`, scope: plan.steps.map(step => step.title), commands: plan.steps.map(step => step.verify), inputs: files,
    allowedPaths: [...new Set(files)], verification: plan.steps.map(step => step.verify), sourceHashes: [goalsSha, planSha], artifactHashes,
  }
}

// ---------------------------------------------------------------------------------------------- context
type TurnPlan = { stage: "decompose" | "unit_plan" | "unit_review" | "final_review"; prompt: StagePrompt; role: "planner" | "architect" | "critic"; context: ReturnType<typeof compose> }

function sourceSections(worktree: string, data: UltragoalData): Array<readonly [string, string]> {
  const seed = data.seed
  if (!seed) return [["DIRECT OBJECTIVE", data.request]]
  const read = readArtifactBytes(resolve(worktree, seed.planPath))
  if (!read.ok || sha256(read.bytes) !== seed.planSha) throw new Error("the approved plan is missing or changed since the handoff")
  return [[`APPROVED PLAN ${seed.planPath} sha256 ${seed.planSha}`, read.bytes.toString("utf8")]]
}

const sourceSha = (data: UltragoalData): string => data.seed?.planSha ?? sha256(data.request)

function goalOf(worktree: string, wf: UltragoalWorkflow, goalId: string): { id: string; title: string; objective: string } {
  const goals = verifiedGoals(worktree, wf)
  if (!goals.ok) throw new Error(goals.reason)
  const goal = goals.doc.goals.find(item => item.id === goalId)
  if (!goal) throw new Error(`goal ${goalId} is not in the fixed goal list`)
  return goal
}

/** What the model is shown for this step. Every file read is hash-verified; a changed file fails the stage visibly. */
export function buildTurn(runtime: Pick<ExecutionRuntime, "worktree">, wf: UltragoalWorkflow): TurnPlan {
  const worktree = runtime.worktree
  const data = ultragoalDataOf(wf)
  const step = nextStep(wf)
  if (step.kind !== "turn") throw new Error(`stage ${wf.stage} has no model turn`)
  const header: Array<readonly [string, string]> = [["Request:", data.request]]
  switch (step.stage) {
    case "decompose":
      return { stage: "decompose", prompt: ULTRAGOAL_DECOMPOSE_PROMPT, role: "planner", context: compose(ULTRAGOAL_DECOMPOSE_PROMPT, [...header, ...sourceSections(worktree, data)]) }
    case "unit_plan": {
      if (!data.selected) throw new Error("no goal is selected")
      const goal = goalOf(worktree, wf, data.selected)
      const done = (data.goals?.ids ?? []).filter(id => data.progress[id]?.lastCheckpoint).map(id => goalOf(worktree, wf, id).title)
      const sections: Array<readonly [string, string]> = [...header, ...sourceSections(worktree, data), [`CURRENT GOAL ${goal.id}`, `${goal.title}\n${goal.objective}`], ["GOALS ALREADY COMPLETE", listed(done)]]
      if (data.findings.length > 0) sections.push([`FINDINGS FROM THE PREVIOUS ATTEMPT (attempt ${(data.progress[data.selected]?.attempt ?? 0)})`, listed(data.findings)])
      return { stage: "unit_plan", prompt: ULTRAGOAL_UNIT_PLAN_PROMPT, role: "planner", context: compose(ULTRAGOAL_UNIT_PLAN_PROMPT, sections) }
    }
    case "unit_review": {
      const pending = data.pending
      if (!pending) throw new Error("no unit is pending review")
      const goal = goalOf(worktree, wf, pending.goalId)
      const md = readRecordedText(worktree, wf, unitKey(pending.goalId, pending.attempt, "md"))
      return { stage: "unit_review", prompt: ULTRAGOAL_UNIT_REVIEW_PROMPT, role: "architect", context: compose(ULTRAGOAL_UNIT_REVIEW_PROMPT, [...header, [`GOAL ${goal.id}`, `${goal.title}\n${goal.objective}`], [`UNIT TO REVIEW (subject sha256 ${pending.subject.sha256})`, md]]) }
    }
    case "final_review": {
      const goals = verifiedGoals(worktree, wf)
      if (!goals.ok) throw new Error(goals.reason)
      const rows = goals.doc.goals.map(goal => {
        const checkpoint = data.progress[goal.id]?.lastCheckpoint
        const doc = checkpoint ? JSON.parse(readRecordedText(worktree, wf, checkpoint)) as CheckpointDoc : undefined
        return `${goal.id} ${goal.title}: ${doc ? `checkpoint ${checkpoint} ${doc.status}, attempt ${doc.attempt}, unit ${doc.subject.id}` : "NO CHECKPOINT"}`
      })
      return { stage: "final_review", prompt: ULTRAGOAL_FINAL_REVIEW_PROMPT, role: "critic", context: compose(ULTRAGOAL_FINAL_REVIEW_PROMPT, [...header, ...sourceSections(worktree, data), ["GOALS AND VERIFIED CHECKPOINTS", rows.join("\n")]]) }
    }
  }
}

// ---------------------------------------------------------------------------------------------- run
export type UltragoalRunStatus = "approval" | "done" | "stuck" | "blocked" | "stale"
export type UltragoalRunResult = { status: UltragoalRunStatus; wf: UltragoalWorkflow | null; reason?: string }
export type UltragoalRunOptions = {
  signal?: AbortSignal
  onStep?(wf: UltragoalWorkflow): void
  /** Return `blocked` instead of running the step at this stage (lets a caller or test pause between stages). */
  stopBefore?: UltragoalWorkflow["stage"]
}


function committedUltragoal(runtime: Pick<ExecutionRuntime, "worktree">, sessionID: string, workflowID: string): UltragoalWorkflow | string {
  let read: ReturnType<typeof readCommitted>
  try { read = readCommitted(runtime.worktree) } catch { return "workflow state is unreadable" }
  if (read.state !== "ok") return "workflow state is unavailable"
  const { wf } = read
  if (wf.id !== workflowID || wf.sessionID !== sessionID) return "workflow identity changed"
  if (!isUltragoal(wf)) return `workflow is a ${wf.kind} workflow`
  return wf
}

function failureCommit(runtime: Pick<ExecutionRuntime, "worktree">, wf: UltragoalWorkflow, reason: string, fatal = false): CommitOutcome {
  return commitUltragoal(runtime.worktree, wf, fresh => reduce(fresh, { type: "attempt_failed", reason, fatal }))
}

type Applied = CommitOutcome | { ok: false; text: string; attempt: true }

/** Apply one successfully parsed model result: write artifacts and receipts, then commit the transition. */
function applyOutput(runtime: Pick<ExecutionRuntime, "worktree" | "config">, wf: UltragoalWorkflow, turn: TurnPlan, output: string): Applied {
  const worktree = runtime.worktree
  const parsed = parseStageEventsFor(unfenced(output), "ultragoal", turn.stage)
  if (!parsed.ok) return { ok: false, text: parsed.reason, attempt: true }
  switch (turn.stage) {
    case "decompose": {
      const goals = goalsOf(parsed.events)
      if (!goals.ok) return { ok: false, text: goals.reason, attempt: true }
      return commitUltragoal(worktree, wf, fresh => {
        const data = ultragoalDataOf(fresh)
        const ids = goalIds(goals.value.length)
        const doc: GoalsDoc = { v: 1, wid: fresh.id, planSha: sourceSha(data), goals: goals.value.map((goal, index) => ({ id: ids[index]!, title: goal.title, objective: goal.objective })) }
        const ref = writeReadable(worktree, fresh, "goals.json", `${JSON.stringify(doc, null, 2)}\n`)
        return reduce(fresh, { type: "goals_saved", goals: ref, ids })
      })
    }
    case "unit_plan": {
      const planned = unitPlanOf(parsed.events)
      if (!planned.ok) return { ok: false, text: planned.reason, attempt: true }
      const data = ultragoalDataOf(wf)
      if (!data.selected || !data.goals) return { ok: false, text: "no goal is selected", attempt: true }
      const goal = (() => { try { return goalOf(worktree, wf, data.selected!) } catch { return undefined } })()
      if (!goal) return { ok: false, text: "goals.json is missing or changed", attempt: true }
      const attempt = (data.progress[data.selected]?.attempt ?? 0) + 1
      const plan = coercePlan({ goal: goal.title.slice(0, 300), steps: planned.value.steps, risks: planned.value.risks }, attempt)
      const problems = validatePlan(plan, worktree, runtime.config.delegate.verify_allow, UNIT_LIMITS)
      if (problems.length > 0) return { ok: false, text: `unit plan refused: ${problems.slice(0, 6).join("; ")}`, attempt: true }
      const json = `${canonicalPlanJson(plan)}\n`
      const md = renderUnit(goal.id, attempt, goal, plan)
      if (Buffer.byteLength(json) > UNIT_DOC_MAX || Buffer.byteLength(md) > UNIT_DOC_MAX) return { ok: false, text: `unit documents exceed ${UNIT_DOC_MAX} bytes`, attempt: true }
      return commitUltragoal(worktree, wf, fresh => {
        const current = ultragoalDataOf(fresh)
        const jsonRef = writeReadable(worktree, fresh, unitKey(goal.id, attempt, "json"), json)
        const mdRef = writeReadable(worktree, fresh, unitKey(goal.id, attempt, "md"), md)
        const input = unitInputFor(fresh.id, goal.id, attempt, plan, current.goals!.sha256, sourceSha(current), [jsonRef.sha256, mdRef.sha256])
        const { id: _id, ...rest } = input
        const subject = implementationUnitSubject({ id: input.id, ...rest })
        const pending: UgPending = { goalId: goal.id, attempt, subject, input, artifacts: [jsonRef, mdRef] }
        return reduce(fresh, { type: "unit_prepared", pending, artifacts: [jsonRef, mdRef] })
      })
    }
    case "unit_review": {
      const verdict = verdictOf(parsed.events, "architect")
      if (!verdict.ok) return { ok: false, text: verdict.reason, attempt: true }
      return commitUltragoal(worktree, wf, fresh => {
        const data = ultragoalDataOf(fresh)
        const pending = data.pending!
        const reviewRef = writeReceipt(worktree, {
          kind: "consensus", wid: fresh.id, sid: fresh.sessionID, revision: fresh.lastSeq, action: `unit-review-${pending.goalId}-${pending.attempt}-${sha256(output).slice(0, 8)}`, inputSha: pending.subject.sha256,
          body: { role: "architect", goalId: pending.goalId, attempt: pending.attempt, verdict: verdict.value.verdict, findings: [...verdict.value.findings], promptSha: turn.prompt.sha256 },
        })
        const md = `# Unit review ${pending.goalId} · attempt ${pending.attempt}\n\nsubject sha256: ${pending.subject.sha256}\nverdict: ${verdict.value.verdict}\n\n## Findings\n\n${listed(verdict.value.findings)}\n`
        const artifact = writeReadable(worktree, fresh, `reviews/${pending.goalId}-${pending.attempt}.md`, md)
        return { ...reduce(fresh, { type: "unit_reviewed", verdict: verdict.value.verdict, findings: verdict.value.findings, reviewRef, artifact }), receipts: [reviewRef] }
      })
    }
    case "final_review": {
      const verdict = verdictOf(parsed.events, "critic")
      if (!verdict.ok) return { ok: false, text: verdict.reason, attempt: true }
      const before = ultragoalEvidence(worktree, wf)
      return commitUltragoal(worktree, wf, fresh => {
        const evidence = ultragoalEvidence(worktree, fresh)
        const goals = verifiedGoals(worktree, fresh)
        // The fixed goal list itself no longer verifies: record the evidence failure (stuck) instead of any completion.
        if (!goals.ok) return reduce(fresh, { type: "evidence_failed", problems: [goals.reason] })
        const finalRef = writeReceipt(worktree, {
          kind: "consensus", wid: fresh.id, sid: fresh.sessionID, revision: fresh.lastSeq, action: `final-review-${sha256(output).slice(0, 8)}`, inputSha: goals.sha,
          body: { role: "critic", verdict: verdict.value.verdict, findings: [...verdict.value.findings], promptSha: turn.prompt.sha256 },
        })
        if (evidence.problems.length > 0 || before.problems.length > 0) return { ...reduce(fresh, { type: "evidence_failed", problems: [...new Set([...before.problems, ...evidence.problems])] }), receipts: [finalRef] }
        if (verdict.value.verdict !== "OKAY") return { ...reduce(fresh, { type: "final_rejected", ref: finalRef, verdict: verdict.value.verdict, findings: verdict.value.findings }), receipts: [finalRef] }
        // The critic OKAY is additional, never sufficient: completion.json is built from the re-verified checkpoints, and
        // commitRevision re-runs the full all-goal check on the done record in this same transaction.
        const completion = writeReadable(worktree, fresh, "completion.json", renderCompletion(fresh, goals.sha, evidence.entries!, finalRef))
        return { ...reduce(fresh, { type: "aggregate_verified", completion, ref: finalRef }), receipts: [finalRef] }
      })
    }
  }
}

function blocked(wf: UltragoalWorkflow, reason: string): UltragoalRunResult {
  return { status: wf.phase === "stuck" ? "stuck" : "blocked", wf, reason }
}

const STOP_TEXT = /pause|cancel|stop/i

/**
 * Run the workflow until it needs a human (unit approval), finishes or gets stuck. Every iteration re-reads the committed
 * state, so a pause, cancel, revision change or foreign write turns the next step into `stale`/`blocked` without
 * applying anything. The unit_execute step is the only one that reaches the queue, through the approved unit.
 */
export async function runUltragoal(
  runtime: ExecutionRuntime, controller: UnitController, sessionID: string, workflowID: string, options: UltragoalRunOptions = {},
): Promise<UltragoalRunResult> {
  const worktree = runtime.worktree
  for (;;) {
    const current = committedUltragoal(runtime, sessionID, workflowID)
    if (typeof current === "string") return { status: "stale", wf: null, reason: current }
    options.onStep?.(current)
    const step = nextStep(current)
    if (options.stopBefore === current.stage && step.kind !== "done") return { status: "blocked", wf: current, reason: `stopped before ${current.stage}` }
    if (step.kind === "done") return { status: "done", wf: current }
    if (step.kind === "blocked") return blocked(current, step.reason)
    if (step.kind === "approval") return { status: "approval", wf: current }

    if (step.kind === "select") {
      const data = ultragoalDataOf(current)
      const next = openGoals(data)[0]
      const outcome = commitUltragoal(worktree, current, fresh => reduce(fresh, next ? { type: "goal_selected", goalId: next } : { type: "all_goals_complete" }))
      if (!outcome.ok) return { status: "stale", wf: current, reason: outcome.text }
      continue
    }

    if (step.kind === "execute") {
      const executed = await executeUnit(runtime, controller, current, options)
      if (executed) return executed
      continue
    }

    if (step.kind === "verify") {
      const outcome = commitUltragoal(worktree, current, fresh => {
        const found = ultragoalDataOf(fresh).current!
        const ledger = readLedger(worktree, fresh.sessionID)
        const tasks = found.taskIds.map(id => ledger.tasks.find(task => task.id === id))
        const rows: VerificationBody["tasks"] = []
        const findings: string[] = []
        let ok = tasks.length > 0 && found.taskIds.length === found.input.scope.length
        tasks.forEach((task, index) => {
          const result = task?.verify_result
          const passed = !!task && task.status === "done" && !!result && result.ok === true && result.exitCode === 0 && !result.timedOut && result.command === found.input.verification[index] && task.wf?.planSha === found.subject.sha256
          if (!passed) {
            ok = false
            findings.push(`${task?.title ?? `step ${index + 1}`}: ${task ? `status ${task.status}${result ? `, verify exit ${result.exitCode ?? "none"}${result.timedOut ? " (timed out)" : ""}: ${result.output.slice(-300)}` : ", no verification result"}` : "task missing"}`)
          }
          rows.push({ id: task?.id ?? `missing-${index}`, attempts: task?.attempts ?? 0, childSessions: task?.childSessions ?? [], command: result?.command ?? found.input.verification[index] ?? "", exitCode: result?.exitCode ?? null, timedOut: result?.timedOut ?? false, ok: passed, outputSha: sha256(result?.output ?? "") })
        })
        const body: VerificationBody = { goalId: found.goalId, attempt: found.attempt, subjectSha: found.subject.sha256, ok, tasks: rows }
        const ref = writeReceipt(worktree, { kind: "verification", wid: fresh.id, sid: fresh.sessionID, revision: fresh.lastSeq, action: `verification-${found.goalId}-${found.attempt}`, inputSha: found.subject.sha256, body: body as unknown as Record<string, unknown> })
        return { ...reduce(fresh, { type: "verification_recorded", ref, ok, findings }), receipts: [ref] }
      })
      if (!outcome.ok) return { status: "stale", wf: current, reason: outcome.text }
      continue
    }

    if (step.kind === "checkpoint") {
      const outcome = commitUltragoal(worktree, current, fresh => {
        const data = ultragoalDataOf(fresh)
        const found = data.current!
        const verification = found.verification!
        const read = verifyReceiptRef(worktree, verification.ref, { sessionID: fresh.sessionID, workflowID: fresh.id, kind: "verification", inputSha: found.subject.sha256 })
        if (!read.ok) throw new Error(`verification receipt: ${read.reason}`)
        if (read.receipt.body.ok !== verification.ok) throw new Error("verification receipt disagrees with the recorded result")
        const doc: CheckpointDoc = {
          v: 1, wid: fresh.id, sid: fresh.sessionID, goalId: found.goalId, attempt: found.attempt, status: verification.ok ? "complete" : "incomplete",
          subject: found.subject, approvalRef: found.approval.receiptRef, verificationRef: verification.ref, goalsSha: data.goals!.sha256,
          unit: found.artifacts.map(ref => ({ key: ref.key, sha256: ref.sha256 })), worktree: worktreeDigest(worktree),
        }
        const checkpoint = writeReadable(worktree, fresh, goalCheckpointKey(found.goalId, found.attempt), `${JSON.stringify(doc, null, 2)}\n`)
        return { ...reduce(fresh, { type: "goal_checkpointed", checkpoint, complete: verification.ok }), receipts: [verification.ref] }
      })
      if (!outcome.ok) return { status: "stale", wf: current, reason: outcome.text }
      continue
    }

    // model turn
    let turn: TurnPlan
    try { turn = buildTurn(runtime, current) }
    catch (error) {
      const failed = failureCommit(runtime, current, `context unavailable: ${(error as Error).message}`, true)
      if (!failed.ok) return { status: "stale", wf: current, reason: failed.text }
      continue
    }
    const store = (() => { try { return getOwnedSession(worktree, sessionID) } catch { return undefined } })()
    const binding: TurnBinding = {
      workflowID: current.id, revision: current.lastSeq, kind: "ultragoal", stage: current.stage, role: turn.role, prompt: turn.prompt,
      supervisorSessionID: sessionID, epoch: store?.epoch ?? null, ownerInstance: current.owner.instance,
    }
    let result: Awaited<ReturnType<typeof runWorkflowTurn>>
    try {
      result = await runWorkflowTurn(runtime, binding, {
        title: `ultragoal ${turn.stage}`, text: turn.context.text, budget: ULTRAGOAL_TURN_BUDGET, label: "ultragoal",
        cancelCause: `ultragoal ${turn.stage} cancelled`, compact: { source: turn.context.source, rebuild: turn.context.rebuild },
      }, options.signal)
    } catch (error) {
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

/** unit_execute: insert the approved unit's tasks (from its verified document), run them through the queue, then verify. */
async function executeUnit(runtime: ExecutionRuntime, controller: UnitController, start: UltragoalWorkflow, options: UltragoalRunOptions): Promise<UltragoalRunResult | undefined> {
  const worktree = runtime.worktree
  let current = start
  const existing = ultragoalDataOf(current).current!
  const resumed = existing.taskIds.length > 0
  if (!resumed) {
    const inserted = insertApprovedUnitTasks(runtime, current)
    if (!inserted.ok) return blocked(current, inserted.text)
    const committed = commitUltragoal(worktree, current, fresh => reduce(fresh, { type: "unit_tasks_created", taskIds: inserted.taskIds }))
    if (!committed.ok) return { status: "stale", wf: current, reason: committed.text }
    current = committed.wf
  }
  try { await controller.runApprovedUnit(current.sessionID, options.signal, resumed) }
  catch (error) {
    const message = (error as Error).message ?? String(error)
    const after = committedUltragoal(runtime, current.sessionID, current.id)
    if (!STOP_TEXT.test(message)) {
      // Not a stop: record a visible stuck at unit_execute (recording mode is not needed; no stop is pending).
      if (typeof after !== "string" && after.stage === "unit_execute" && after.phase === "executing" && !after.stopIntent) {
        const stuck = commitUltragoal(worktree, after, fresh => reduce(fresh, { type: "runner_failed", reason: message }))
        if (stuck.ok) return { status: "stuck", wf: stuck.wf, reason: message }
      }
      throw error
    }
    return typeof after === "string" ? { status: "stale", wf: null, reason: after } : blocked(after, message)
  }
  const after = committedUltragoal(runtime, current.sessionID, current.id)
  if (typeof after === "string") return { status: "stale", wf: null, reason: after }
  if (after.stage !== "unit_execute" || after.phase !== "executing" || after.stopIntent) return blocked(after, after.stopIntent ? `${after.stopIntent.kind} requested` : `workflow is at ${after.stage}/${after.phase}`)
  const ids = new Set(ultragoalDataOf(after).current!.taskIds)
  const open = readLedger(worktree, after.sessionID).tasks.filter(task => ids.has(task.id) && (task.status === "pending" || task.status === "running"))
  if (open.length > 0) return blocked(after, `unit has ${open.length} unfinished task(s); resume to finish them`)
  const terminal = commitUltragoal(worktree, after, fresh => reduce(fresh, { type: "unit_terminal" }))
  if (!terminal.ok) return { status: "stale", wf: after, reason: terminal.text }
  return undefined
}

// ---------------------------------------------------------------------------------------------- approval and retry
/**
 * Approve ONE reviewed unit. Needs the exact typed text for this workflow and this unit's subject hash, the live pending
 * review, intact unit documents and an unchanged seed. A ralplan EXECUTE confirmation is a different string and never
 * matches, and nothing here starts work: the next driver step inserts the tasks.
 */
export function approveUnit(runtime: Pick<ExecutionRuntime, "worktree">, sessionID: string, workflowID: string, expectedRevision: number, typed: string): ChoiceResult {
  const current = committedUltragoal(runtime, sessionID, workflowID)
  if (typeof current === "string") return { ok: false, text: current }
  if (current.lastSeq !== expectedRevision) return { ok: false, text: "workflow revision changed; the approval is stale" }
  if (current.stage !== "unit_approval" || current.phase !== "pending_approval") return { ok: false, text: `workflow is at ${current.stage}/${current.phase}, not awaiting a unit approval` }
  const data = ultragoalDataOf(current)
  const pending = data.pending
  if (!pending) return { ok: false, text: "no reviewed unit is pending" }
  const expected = approveUnitConfirmation(current.id, pending.subject.sha256)
  if (typed.trim() !== expected) return { ok: false, text: `typed confirmation must be exactly: ${expected}` }
  const outcome = commitUltragoal(runtime.worktree, current, fresh => {
    const found = ultragoalDataOf(fresh)
    const p = found.pending
    if (!p || p.subject.sha256 !== pending.subject.sha256) throw new Error("the pending unit changed; the approval is stale")
    if (found.seed) {
      const seedProblem = verifySeed(runtime.worktree, fresh.sessionID, found.seed)
      if (seedProblem) throw new Error(`approval refused: ${seedProblem}`)
    }
    for (const ref of p.artifacts) {
      if (verifyArtifact(runtime.worktree, ref).state !== "verified") throw new Error(`approval refused: unit document ${ref.key} changed`)
    }
    const recomputed = subjectSha256({ kind: "implementation-unit", ...p.input })
    const sortedDocs = p.artifacts.map(ref => ref.sha256).sort()
    if (recomputed !== p.subject.sha256 || JSON.stringify([...p.input.artifactHashes].sort()) !== JSON.stringify(sortedDocs)) throw new Error("approval refused: the unit does not match its subject")
    if (!p.reviewRef) throw new Error("approval refused: the unit has no review")
    const review = verifyReceiptRef(runtime.worktree, p.reviewRef, { sessionID: fresh.sessionID, workflowID: fresh.id, kind: "consensus", inputSha: p.subject.sha256 })
    if (!review.ok || review.receipt.body.verdict !== "OKAY") throw new Error(`approval refused: unit review ${review.ok ? "is not OKAY" : review.reason}`)
    const receiptRef = writeReceipt(runtime.worktree, {
      kind: "choice", wid: fresh.id, sid: fresh.sessionID, revision: fresh.lastSeq, action: `choice-approve-unit-${p.subject.sha256.slice(0, 12)}`, inputSha: p.subject.sha256,
      body: { choice: "approve-unit", goalId: p.goalId, attempt: p.attempt, subjectId: p.subject.id, subjectSha: p.subject.sha256, executed: false },
    })
    const unit: UgCurrent = {
      goalId: p.goalId, attempt: p.attempt, subject: p.subject, input: p.input, approval: { subject: p.subject, receiptRef },
      artifacts: p.artifacts, taskIds: [], done: [], remaining: [],
    }
    return { ...reduce(fresh, { type: "execution_approved", current: unit }), receipts: [receiptRef] }
  }, Date.now(), "user_command")
  return outcome.ok ? { ok: true, wf: outcome.wf } : { ok: false, text: outcome.text }
}

/** Retry after an attempt-failure stuck (or a rejected final review): resumes the same stage. A blocked goal cannot retry. */
export function retryUltragoal(runtime: Pick<ExecutionRuntime, "worktree">, sessionID: string, workflowID: string, expectedRevision: number): ChoiceResult {
  const current = committedUltragoal(runtime, sessionID, workflowID)
  if (typeof current === "string") return { ok: false, text: current }
  if (current.lastSeq !== expectedRevision) return { ok: false, text: "workflow revision changed; the retry is stale" }
  const outcome = commitUltragoal(runtime.worktree, current, fresh => reduce(fresh, { type: "retry" }))
  return outcome.ok ? { ok: true, wf: outcome.wf } : { ok: false, text: outcome.text }
}

/** One-line truth-first view: stage, goal progress and the stuck reason. Recomputed from the committed data only. */
export function ultragoalView(wf: UltragoalWorkflow): string {
  let data: UltragoalData
  try { data = ultragoalDataOf(wf) } catch { return "ultragoal state unreadable" }
  const total = data.goals?.ids.length ?? 0
  const complete = total - openGoals(data).length
  const goal = data.selected ?? data.current?.goalId
  return `ultragoal · ${wf.stage} · ${total === 0 ? "no goals yet" : `goal ${goal ? goal.slice(1) : Math.min(complete + 1, total)}/${total} (${complete} complete)`}${data.stuck ? ` · stuck: ${data.stuck.reason}` : ""}`
}
