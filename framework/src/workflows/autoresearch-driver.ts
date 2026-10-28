// Autoresearch driver (P6b S3). Runs the engine step by step: every model call is a bound, read-only `runWorkflowTurn`;
// its text is parsed as typed stage events; the code writes artifacts and receipts and commits one transition per step
// with compare-and-swap on the committed revision. Commands reach a process only through the experiment runner (the
// verifier), on an experiment whose typed `RUN <workflow> <sha>` receipt names the current subject; no queue, worker
// or plan start is ever involved. The workflow is done only when the verdict re-verifies against the run files.
import { resolve } from "node:path"
import { verifyCommandProblem } from "../config.ts"
import { currentOwner } from "../flow/owner.ts"
import { assertFlowTxWorktree, newWorkflowId, readAnyWorkflowForWrite, rotate, withFlowTransaction, workflowReadError } from "../flow/state.ts"
import type { ExecutionRuntime } from "../hosts/types.ts"
import { settled } from "../hosts/run-state.ts"
import { getOwnedSession } from "../sessions/store.ts"
import { readArtifactBytes, sha256, verifyArtifact } from "./artifacts.ts"
import { commitHandoff, commitRevision, type CommitEvent } from "./commit.ts"
import { worktreeDigest } from "./checkpoint.ts"
import {
  AR_CAP_CAVEAT, autoresearchDataOf, evaluationOf, evidenceOf, experimentOf, hypothesesOf, isAutoresearch, missionOf, nextStep, reduce, runConfirmation,
  type AutoresearchWorkflow, type Hashed,
} from "./autoresearch.ts"
import { commitAutoresearch, committedAutoresearch, type CommitOutcome } from "./autoresearch-commit.ts"
import { AR_MAX_ITERATIONS, initialAutoresearchData, type ArExperiment, type ArPending, type ArSpec, type AutoresearchData } from "./autoresearch-data.ts"
import { writeDoc } from "./autoresearch-docs.ts"
import { autoresearchEvidence, readRecordedText, type ArRunDoc, type ArVerdictDoc, type ArVerdictEvidence } from "./autoresearch-evidence.ts"
import { runExperimentStage } from "./autoresearch-runner.ts"
import { newDeepInterview } from "./deep-interview-driver.ts"
import { experimentUnitSubject, sameSubject, subjectSha256 } from "./execution-unit.ts"
import {
  AUTORESEARCH_DATA_EVIDENCE_PROMPT, AUTORESEARCH_EVALUATE_PROMPT, AUTORESEARCH_EVIDENCE_PROMPT, AUTORESEARCH_EXPERIMENT_PROMPT, AUTORESEARCH_HYPOTHESIS_PROMPT,
  AUTORESEARCH_INTAKE_PROMPT, type StagePrompt,
} from "./prompts/index.ts"
import { verifyReceiptRef, writeReceipt } from "./receipts.ts"
import { liveAdmission } from "./session-guard.ts"
import { parseStageEventsFor, runWorkflowTurn, type TurnBinding } from "./turn.ts"
import { TERMINAL, type WorkflowEnvelope } from "./types.ts"
import { compose, listed, unfenced } from "./stage-context.ts"

export const AUTORESEARCH_TURN_BUDGET = Object.freeze({ maxChars: 24_000, reserveChars: 8_000 })
const REQUEST_MAX = 4_000
const DOC_MAX = 16 * 1024

export type StartResult = { ok: true; wf: AutoresearchWorkflow } | { ok: false; text: string }
export type ChoiceResult = { ok: true; wf: AutoresearchWorkflow } | { ok: false; text: string }
export type ProductifyResult = { ok: true; predecessor: AutoresearchWorkflow; successor: WorkflowEnvelope } | { ok: false; text: string }

// ---------------------------------------------------------------------------------------------- start
export function newAutoresearch(sessionID: string, owner: { instance: string; pid: number }, engine: string, request: string, now = Date.now()): AutoresearchWorkflow {
  return {
    version: 2, id: newWorkflowId(now), kind: "autoresearch", stage: "intake", engine, phase: "planning", sessionID,
    owner: { instance: owner.instance, pid: owner.pid }, stopIntent: null, artifacts: [],
    data: initialAutoresearchData(request.slice(0, REQUEST_MAX)), lastSeq: 0, createdAt: now, updatedAt: now,
  } as AutoresearchWorkflow
}

/** Start in the free (or terminal) slot. Refuses while any workflow is active or without a live unheld session. */
export function startAutoresearch(runtime: Pick<ExecutionRuntime, "worktree" | "host">, sessionID: string, request: string, options: { now?: number } = {}): StartResult {
  if (!request.trim()) return { ok: false, text: "an autoresearch needs a research request" }
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
    const created = newAutoresearch(sessionID, currentOwner(now, admitted.epoch), String(runtime.host.identity.engine), request, now)
    rotate(tx)
    const wf = commitRevision(tx, created, [
      { wf: created.id, type: "created", actor: "code", data: { kind: "autoresearch", chars: request.length } },
      { wf: created.id, type: "transition", to: "planning", actor: "code", data: { event: "start" } },
    ], now)
    return { ok: true, wf: wf as AutoresearchWorkflow }
  }, sessionID)
}

// ---------------------------------------------------------------------------------------------- context
type TurnPlan = { stage: "intake" | "hypothesis" | "evidence" | "experiment_prepare" | "evaluate"; prompt: StagePrompt; role: "researcher" | "data-analyst" | "critic"; context: ReturnType<typeof compose> }

const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(text.length - max)}` : text)

function runRows(worktree: string, wf: AutoresearchWorkflow, data: AutoresearchData): string {
  if (data.runs.length === 0) return "- no runs yet"
  return data.runs.slice(-30).map(run => {
    let doc: ArRunDoc | undefined
    try { doc = JSON.parse(readRecordedText(worktree, wf, `runs/${run.attempt}.json`)) as ArRunDoc } catch { /* shown as unreadable */ }
    return `- run ${run.attempt} (iteration ${run.iteration}) status ${run.status}${run.valid ? "" : ` INVALID(${run.invalid})`}${run.metric === undefined ? "" : ` metric ${run.metric}`}: ${doc ? `\`${doc.command}\` exit ${doc.exitCode ?? "none"}, output tail: ${tail(doc.output.replace(/\s+/g, " "), 240)}` : "run file unreadable"}`
  }).join("\n")
}

export function buildTurn(runtime: Pick<ExecutionRuntime, "worktree" | "dataChecks">, wf: AutoresearchWorkflow): TurnPlan {
  const worktree = runtime.worktree
  const data = autoresearchDataOf(wf)
  const step = nextStep(wf)
  if (step.kind !== "turn") throw new Error(`stage ${wf.stage} has no model turn`)
  const header: Array<readonly [string, string]> = [["Request:", data.request]]
  const mission = (): Array<readonly [string, string]> => data.mission ? [[`MISSION ${data.mission.path} sha256 ${data.mission.sha256}`, readRecordedText(worktree, wf, "mission.json")]] : []
  const hypotheses = (): Array<readonly [string, string]> => [["HYPOTHESES", listed(data.hypotheses)]]
  switch (step.stage) {
    case "intake":
      return { stage: "intake", prompt: AUTORESEARCH_INTAKE_PROMPT, role: "researcher", context: compose(AUTORESEARCH_INTAKE_PROMPT, header) }
    case "hypothesis":
      return { stage: "hypothesis", prompt: AUTORESEARCH_HYPOTHESIS_PROMPT, role: "researcher", context: compose(AUTORESEARCH_HYPOTHESIS_PROMPT, [...header, ...mission()]) }
    case "evidence": {
      const analyst = runtime.dataChecks !== undefined
      const prompt = analyst ? AUTORESEARCH_DATA_EVIDENCE_PROMPT : AUTORESEARCH_EVIDENCE_PROMPT
      return { stage: "evidence", prompt, role: analyst ? "data-analyst" : "researcher", context: compose(prompt, [...header, ...mission(), ...hypotheses()]) }
    }
    case "experiment_prepare": {
      const sections: Array<readonly [string, string]> = [...header, ...mission(), ...hypotheses()]
      if (data.evidence) sections.push([`EVIDENCE ${data.evidence.path}`, readRecordedText(worktree, wf, "evidence.json")])
      sections.push([`RUNS SO FAR (iteration ${data.iteration}/${AR_MAX_ITERATIONS})`, runRows(worktree, wf, data)])
      if (data.findings.length > 0) sections.push(["FINDINGS FROM THE PREVIOUS ITERATION", listed(data.findings)])
      return { stage: "experiment_prepare", prompt: AUTORESEARCH_EXPERIMENT_PROMPT, role: "researcher", context: compose(AUTORESEARCH_EXPERIMENT_PROMPT, sections) }
    }
    case "evaluate": {
      const sections: Array<readonly [string, string]> = [...header, ...mission(), ...hypotheses(), [`RUNS (iteration ${data.iteration}/${AR_MAX_ITERATIONS})`, runRows(worktree, wf, data)]]
      if (data.best) sections.push(["BEST VALID METRIC", `run ${data.best.attempt}: ${data.best.value}`])
      return { stage: "evaluate", prompt: AUTORESEARCH_EVALUATE_PROMPT, role: "critic", context: compose(AUTORESEARCH_EVALUATE_PROMPT, sections) }
    }
  }
}

// ---------------------------------------------------------------------------------------------- experiment subject
/** Everything the human approves: commands, params, metric spec, mission, HEAD and the experiment document. */
function experimentInput(wid: string, data: AutoresearchData, spec: ArSpec, docSha: string, head: string | null) {
  const mission = data.mission!
  const params = Object.entries(spec.params).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`)
  return {
    id: `${wid}:experiment`, scope: [...spec.commands.map((_, index) => `run c${index}`), ...params],
    commands: spec.commands, inputs: [`metric:${mission.metric.name}:${mission.metric.direction}`], allowedPaths: [] as string[], verification: spec.commands,
    sourceHashes: [mission.sha256, sha256(head ?? "no-head")], artifactHashes: [docSha],
  }
}

function experimentDoc(wid: string, data: AutoresearchData, spec: ArSpec, head: string | null): string {
  return `${JSON.stringify({ v: 1, wid, commands: spec.commands, params: Object.fromEntries(Object.entries(spec.params).sort(([a], [b]) => a.localeCompare(b))), metric: data.mission!.metric, missionSha: data.mission!.sha256, head }, null, 2)}\n`
}

// ---------------------------------------------------------------------------------------------- model output
type Applied = CommitOutcome | { ok: false; text: string; attempt: true }

function relativeRepoPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\0")
}

function applyOutput(runtime: Pick<ExecutionRuntime, "worktree" | "config">, wf: AutoresearchWorkflow, turn: TurnPlan, output: string): Applied {
  const worktree = runtime.worktree
  const parsed = parseStageEventsFor(unfenced(output), "autoresearch", turn.stage)
  if (!parsed.ok) return { ok: false, text: parsed.reason, attempt: true }
  switch (turn.stage) {
    case "intake": {
      const mission = missionOf(parsed.events)
      if (!mission.ok) return { ok: false, text: mission.reason, attempt: true }
      return commitAutoresearch(worktree, wf, fresh => {
        const data = autoresearchDataOf(fresh)
        const doc = { v: 1, wid: fresh.id, request: data.request, goal: mission.value.goal, metric: mission.value.metric.name, direction: mission.value.metric.direction }
        const ref = writeDoc(worktree, fresh, "mission.json", `${JSON.stringify(doc, null, 2)}\n`)
        return reduce(fresh, { type: "intake_confirmed", mission: ref, metric: mission.value.metric })
      })
    }
    case "hypothesis": {
      const hypotheses = hypothesesOf(parsed.events)
      if (!hypotheses.ok) return { ok: false, text: hypotheses.reason, attempt: true }
      return commitAutoresearch(worktree, wf, fresh => reduce(fresh, { type: "hypothesis_recorded", hypotheses: hypotheses.value }))
    }
    case "evidence": {
      const items = evidenceOf(parsed.events)
      if (!items.ok) return { ok: false, text: items.reason, attempt: true }
      // Repo/data evidence only: each cited path is hashed from disk; an unverifiable one is a caveat, never evidence.
      const rows: Array<{ path: string; note: string; verified: boolean; sha256?: string }> = []
      const caveats: string[] = []
      for (const item of items.value) {
        let hash: string | undefined
        if (relativeRepoPath(item.path) && verifyArtifact(worktree, { key: "e", path: item.path }).state === "present-unhashed") {
          const read = readArtifactBytes(resolve(worktree, item.path))
          if (read.ok) hash = sha256(read.bytes)
        }
        rows.push({ path: item.path, note: item.note, verified: hash !== undefined, ...(hash ? { sha256: hash } : {}) })
        if (!hash) caveats.push(`evidence ${item.path.slice(0, 200)} could not be verified in the repository and is not counted`)
      }
      const verified = rows.filter(row => row.verified).length
      return commitAutoresearch(worktree, wf, fresh => {
        const ref = writeDoc(worktree, fresh, "evidence.json", `${JSON.stringify({ v: 1, wid: fresh.id, items: rows }, null, 2)}\n`)
        return reduce(fresh, { type: "evidence_recorded", evidence: ref, verified, unverified: rows.length - verified, caveats })
      })
    }
    case "experiment_prepare": {
      const proposed = experimentOf(parsed.events)
      if (!proposed.ok) return { ok: false, text: proposed.reason, attempt: true }
      // Commands run only through the verifier: the verifier allow-list refuses shell metacharacters, network and
      // anything that is not a recognised test/check runner, so a refused command costs an attempt and 0 prepares.
      const problems = proposed.value.commands.flatMap((command, index) => {
        const problem = verifyCommandProblem(command, runtime.config.delegate.verify_allow)
        return problem ? [`command ${index + 1} refused: ${problem}`] : []
      })
      if (problems.length > 0) return { ok: false, text: `experiment refused: ${problems.slice(0, 6).join("; ")}`, attempt: true }
      const spec: ArSpec = { commands: proposed.value.commands, params: proposed.value.params }
      const data = autoresearchDataOf(wf)
      if (!data.mission) return { ok: false, text: "mission is missing", attempt: true }
      const head = worktreeDigest(worktree).head
      const text = experimentDoc(wf.id, data, spec, head)
      if (Buffer.byteLength(text) > DOC_MAX) return { ok: false, text: `experiment document exceeds ${DOC_MAX} bytes`, attempt: true }
      return commitAutoresearch(worktree, wf, fresh => {
        const current = autoresearchDataOf(fresh)
        const docSha = sha256(text)
        const ref = writeDoc(worktree, fresh, `experiments/${docSha.slice(0, 16)}.json`, text)
        const input = experimentInput(fresh.id, current, spec, ref.sha256, head)
        const subject = experimentUnitSubject(input)
        const pending: ArPending = { iteration: current.iteration + 1, subject, input, artifacts: [ref], spec }
        // An identical subject that already carries its approval re-runs without a new receipt (A4).
        const reuse = !!current.experiment && sameSubject(current.experiment.subject, subject)
        return reduce(fresh, { type: "experiment_proposed", pending, artifacts: [ref], reuse })
      })
    }
    case "evaluate": {
      const verdict = evaluationOf(parsed.events)
      if (!verdict.ok) return { ok: false, text: verdict.reason, attempt: true }
      return commitAutoresearch(worktree, wf, fresh => {
        const data = autoresearchDataOf(fresh)
        const digest = sha256(JSON.stringify(data.runs.map(run => [run.attempt, run.sha256])))
        const ref = writeReceipt(worktree, {
          kind: "consensus", wid: fresh.id, sid: fresh.sessionID, revision: fresh.lastSeq, action: `evaluate-${data.iteration}-${sha256(output).slice(0, 8)}`, inputSha: digest,
          body: { role: "critic", iteration: data.iteration, verdict: verdict.value.verdict, findings: [...verdict.value.findings], suspect: verdict.value.suspect, promptSha: turn.prompt.sha256 },
        })
        return { ...reduce(fresh, { type: "evaluation_recorded", verdict: verdict.value.verdict, findings: verdict.value.findings, ref, suspect: verdict.value.suspect }), receipts: [ref] }
      })
    }
  }
}

// ---------------------------------------------------------------------------------------------- verdict (code-assembled)
function assembleVerdict(runtime: Pick<ExecutionRuntime, "worktree">, wf: AutoresearchWorkflow): { doc: ArVerdictDoc; status: "conclusive" | "inconclusive" } {
  const data = autoresearchDataOf(wf)
  const evaluation = data.evaluation
  if (!evaluation) throw new Error("no evaluation is recorded")
  const check = autoresearchEvidence(runtime.worktree, wf)
  if (check.problems.length > 0) throw new Error(`run evidence does not verify: ${check.problems[0]}`)
  const valid = data.runs.filter(run => run.valid)
  const evidence: ArVerdictEvidence[] = valid.flatMap(run => [{ kind: "run" as const, key: `runs/${run.attempt}.json`, sha256: run.sha256 }, { kind: "receipt" as const, ref: run.receiptRef }])
  const caveats = [...data.caveats]
  for (const run of data.runs.filter(item => !item.valid)) caveats.push(`run ${run.attempt} is excluded as invalid (${run.invalid})`)
  const measured = valid.some(run => run.metric !== undefined)
  const conclusive = evaluation.verdict === "OKAY" && measured
  if (evaluation.verdict === "OKAY" && !measured) caveats.push("no valid run produced a metric; the verdict cannot be conclusive")
  if (evaluation.verdict === "REJECT") caveats.push("the critic rejected the approach")
  if (evaluation.verdict === "ITERATE" && !caveats.includes(AR_CAP_CAVEAT)) caveats.push(AR_CAP_CAVEAT)
  const receipt = verifyReceiptRef(runtime.worktree, evaluation.ref, { sessionID: wf.sessionID, workflowID: wf.id, kind: "consensus" })
  if (!receipt.ok) throw new Error(`evaluator receipt: ${receipt.reason}`)
  const status = conclusive ? "conclusive" : "inconclusive"
  return {
    status,
    doc: {
      v: 1, wid: wf.id, status, evidence, caveats: caveats.slice(0, 40).map(item => item.slice(0, 600)),
      evaluator: { promptSha: String(receipt.receipt.body.promptSha), receiptRef: evaluation.ref, verdict: evaluation.verdict },
    },
  }
}

// ---------------------------------------------------------------------------------------------- run
export type AutoresearchRunStatus = "approval" | "choice" | "done" | "stuck" | "blocked" | "stale"
export type AutoresearchRunResult = { status: AutoresearchRunStatus; wf: AutoresearchWorkflow | null; reason?: string }
export type AutoresearchRunOptions = { signal?: AbortSignal; onStep?(wf: AutoresearchWorkflow): void; stopBefore?: AutoresearchWorkflow["stage"] }

function blocked(wf: AutoresearchWorkflow, reason: string): AutoresearchRunResult {
  return { status: wf.phase === "stuck" ? "stuck" : "blocked", wf, reason }
}

function failureCommit(runtime: Pick<ExecutionRuntime, "worktree">, wf: AutoresearchWorkflow, reason: string, fatal = false): CommitOutcome {
  return commitAutoresearch(runtime.worktree, wf, fresh => reduce(fresh, { type: "attempt_failed", reason, fatal }))
}

/**
 * Run until the workflow needs a human (experiment approval, finish/productify choice), finishes or gets stuck. Every
 * iteration re-reads the committed state, so a pause, cancel, revision change or foreign write turns the next step into
 * `stale`/`blocked` without applying anything. experiment_run is the only step that reaches a command, via the runner.
 */
export async function runAutoresearch(runtime: ExecutionRuntime, sessionID: string, workflowID: string, options: AutoresearchRunOptions = {}): Promise<AutoresearchRunResult> {
  const worktree = runtime.worktree
  for (;;) {
    const current = committedAutoresearch(runtime, sessionID, workflowID)
    if (typeof current === "string") return { status: "stale", wf: null, reason: current }
    options.onStep?.(current)
    const step = nextStep(current)
    if (options.stopBefore === current.stage && step.kind !== "done") return { status: "blocked", wf: current, reason: `stopped before ${current.stage}` }
    if (step.kind === "done") return { status: current.phase === "stuck" ? "stuck" : "done", wf: current }
    if (step.kind === "blocked") return blocked(current, step.reason)
    if (step.kind === "approval") return { status: "approval", wf: current }
    if (step.kind === "choice") return { status: "choice", wf: current }

    if (step.kind === "run") {
      const ran = await runExperimentStage({ runtime, sessionID, workflowID, ...(options.signal ? { signal: options.signal } : {}) })
      if (ran.status === "finished") continue
      return { status: ran.status === "stale" ? "stale" : ran.wf?.phase === "stuck" ? "stuck" : "blocked", wf: ran.wf, reason: ran.reason }
    }

    if (step.kind === "verdict") {
      let assembled: ReturnType<typeof assembleVerdict>
      try { assembled = assembleVerdict(runtime, current) }
      catch (error) { return { status: "stale", wf: current, reason: (error as Error).message } }
      const outcome = commitAutoresearch(worktree, current, fresh => {
        const ref: Hashed = writeDoc(worktree, fresh, "verdict.json", `${JSON.stringify(assembled.doc, null, 2)}\n`)
        return reduce(fresh, { type: "verdict_written", verdict: ref, status: assembled.status })
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
      workflowID: current.id, revision: current.lastSeq, kind: "autoresearch", stage: current.stage, role: turn.role, prompt: turn.prompt,
      supervisorSessionID: sessionID, epoch: store?.epoch ?? null, ownerInstance: current.owner.instance,
    }
    let result: Awaited<ReturnType<typeof runWorkflowTurn>>
    try {
      result = await runWorkflowTurn(runtime, binding, {
        title: `autoresearch ${turn.stage}`, text: turn.context.text, budget: AUTORESEARCH_TURN_BUDGET, label: "autoresearch",
        cancelCause: `autoresearch ${turn.stage} cancelled`, compact: { source: turn.context.source, rebuild: turn.context.rebuild },
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

// ---------------------------------------------------------------------------------------------- approval, finish, retry
/**
 * Approve ONE proposed experiment. Needs the exact typed text for this workflow and this experiment's subject hash, the
 * live pending proposal, intact experiment documents and a subject recomputed from its inputs (H1). An APPROVE-UNIT or
 * EXECUTE confirmation is a different string and never matches; nothing here runs a command.
 */
export function approveExperiment(runtime: Pick<ExecutionRuntime, "worktree" | "config">, sessionID: string, workflowID: string, expectedRevision: number, typed: string): ChoiceResult {
  const current = committedAutoresearch(runtime, sessionID, workflowID)
  if (typeof current === "string") return { ok: false, text: current }
  if (current.lastSeq !== expectedRevision) return { ok: false, text: "workflow revision changed; the approval is stale" }
  if (current.stage !== "experiment_approval" || current.phase !== "pending_approval") return { ok: false, text: `workflow is at ${current.stage}/${current.phase}, not awaiting an experiment approval` }
  const pending = autoresearchDataOf(current).pending
  if (!pending) return { ok: false, text: "no experiment is pending" }
  const expected = runConfirmation(current.id, pending.subject.sha256)
  if (typed.trim() !== expected) return { ok: false, text: `typed confirmation must be exactly: ${expected}` }
  const outcome = commitAutoresearch(runtime.worktree, current, fresh => {
    const p = autoresearchDataOf(fresh).pending
    if (!p || p.subject.sha256 !== pending.subject.sha256) throw new Error("the pending experiment changed; the approval is stale")
    for (const ref of p.artifacts) {
      if (verifyArtifact(runtime.worktree, ref).state !== "verified") throw new Error(`approval refused: experiment document ${ref.key} changed`)
    }
    const recomputed = subjectSha256({ kind: "experiment-unit", ...p.input })
    if (recomputed !== p.subject.sha256 || JSON.stringify([...p.input.artifactHashes].sort()) !== JSON.stringify(p.artifacts.map(ref => ref.sha256).sort())) throw new Error("approval refused: the experiment does not match its subject")
    for (const command of p.input.commands) {
      const problem = verifyCommandProblem(command, runtime.config.delegate.verify_allow)
      if (problem) throw new Error(`approval refused: command refused: ${problem}`)
    }
    const receiptRef = writeReceipt(runtime.worktree, {
      kind: "choice", wid: fresh.id, sid: fresh.sessionID, revision: fresh.lastSeq, action: `choice-run-experiment-${p.subject.sha256.slice(0, 12)}`, inputSha: p.subject.sha256,
      body: { choice: "run-experiment", iteration: p.iteration, subjectId: p.subject.id, subjectSha: p.subject.sha256, executed: false },
    })
    const experiment: ArExperiment = {
      subject: p.subject, input: p.input, approval: { subject: p.subject, receiptRef }, artifacts: p.artifacts, taskIds: [],
      done: [], remaining: p.spec.commands.map((_, index) => `c${index}`), iteration: p.iteration,
    }
    return { ...reduce(fresh, { type: "experiment_approved", experiment }), receipts: [receiptRef] }
  }, Date.now(), "user_command")
  return outcome.ok ? { ok: true, wf: outcome.wf } : { ok: false, text: outcome.text }
}

/**
 * Finish at the verdict: conclusive -> done, inconclusive -> stuck@terminal (follow-up). `productify` records the
 * productify_selected choice; the seeded interview itself is a later slice, and the choice authorizes nothing.
 */
export function finishAutoresearch(runtime: Pick<ExecutionRuntime, "worktree">, sessionID: string, workflowID: string, expectedRevision: number, options: { productify?: boolean } = {}): ChoiceResult {
  const current = committedAutoresearch(runtime, sessionID, workflowID)
  if (typeof current === "string") return { ok: false, text: current }
  if (current.lastSeq !== expectedRevision) return { ok: false, text: "workflow revision changed; the choice is stale" }
  const outcome = commitAutoresearch(runtime.worktree, current, fresh => reduce(fresh, { type: "autoresearch_finished", ...(options.productify ? { productify: true } : {}) }), Date.now(), "user_command")
  return outcome.ok ? { ok: true, wf: outcome.wf } : { ok: false, text: outcome.text }
}

/**
 * Autoresearch -> deep-interview productification. The predecessor's verdict is re-read from disk and embedded as the
 * new interview seed; no execution consent is inherited and no fifth workflow kind is created.
 */
export function productifyAutoresearch(
  runtime: Pick<ExecutionRuntime, "worktree" | "host">,
  sessionID: string,
  workflowID: string,
  expectedRevision: number,
  options: { now?: number } = {},
): ProductifyResult {
  const current = committedAutoresearch(runtime, sessionID, workflowID)
  if (typeof current === "string") return { ok: false, text: current }
  if (current.lastSeq !== expectedRevision) return { ok: false, text: "workflow revision changed; the productify choice is stale" }
  if (current.sessionID !== sessionID) return { ok: false, text: "workflow belongs to another session" }
  if (current.stopIntent || current.phase === "paused") return { ok: false, text: "productify refused: workflow is held, paused or stopping" }
  const data = autoresearchDataOf(current)
  if (!data.verdict) return { ok: false, text: "productify refused: no verified verdict exists" }
  const verdictRef = current.artifacts.find(ref => ref.key === "verdict.json")
  if (!verdictRef?.sha256) return { ok: false, text: "productify refused: verdict.json is not recorded" }
  const verdictRead = readArtifactBytes(resolve(runtime.worktree, verdictRef.path))
  if (!verdictRead.ok || sha256(verdictRead.bytes) !== verdictRef.sha256) return { ok: false, text: `productify refused: verdict.json is ${verdictRead.ok ? "hash-mismatched" : verdictRead.reason}` }
  let verdict: ArVerdictDoc
  try { verdict = JSON.parse(verdictRead.bytes.toString("utf8")) as ArVerdictDoc }
  catch { return { ok: false, text: "productify refused: verdict.json is not valid JSON" } }
  if (verdict.status !== data.verdict.status || !Array.isArray(verdict.evidence) || !Array.isArray(verdict.caveats)) return { ok: false, text: "productify refused: verdict.json does not match the committed verdict" }
  const evidence = autoresearchEvidence(runtime.worktree, current, { final: true })
  if (evidence.problems.length > 0) return { ok: false, text: `productify refused: ${evidence.problems.slice(0, 3).join("; ")}` }
  const admitted = liveAdmission(runtime, sessionID)
  if (typeof admitted === "string") return { ok: false, text: admitted }
  const now = options.now ?? Date.now()
  const raw = verdictRead.bytes.toString("utf8")
  const request = `Clarify product requirements from autoresearch verdict ${verdictRef.path} (${verdict.status}).`
  const successor = newDeepInterview(sessionID, current.owner, String(runtime.host.identity.engine), request, now, {
    source: "autoresearch",
    verdictPath: verdictRef.path,
    verdictSha: verdictRef.sha256,
    status: verdict.status,
    evidence: verdict.evidence,
    caveats: verdict.caveats,
    raw,
  })
  return withFlowTransaction(runtime.worktree, (tx): ProductifyResult => {
    assertFlowTxWorktree(tx, runtime.worktree)
    const checked = readAnyWorkflowForWrite(tx)
    if (checked.corrupt) throw workflowReadError(checked)
    if (!checked.wf || checked.wf.id !== current.id || checked.wf.sessionID !== current.sessionID || checked.wf.lastSeq !== current.lastSeq) {
      return { ok: false, text: "workflow changed meanwhile; refusing productify" }
    }
    if (checked.wf.stopIntent || checked.wf.phase === "paused") return { ok: false, text: "productify refused: workflow is held, paused or stopping" }
    let predecessor: AutoresearchWorkflow = current
    let predecessorEvents: CommitEvent[]
    if (!TERMINAL.has(current.phase)) {
      let reduced: ReturnType<typeof reduce>
      try { reduced = reduce(current, { type: "autoresearch_finished", productify: true }) }
      catch (error) { return { ok: false, text: (error as Error).message } }
      predecessor = reduced.wf
      predecessorEvents = reduced.events.map(event => ({ wf: current.id, type: event.type, actor: "user_command", ...(event.data ? { data: event.data } : {}) }))
    } else {
      predecessor = { ...current, data: { ...data, productify: { chosen: true } } } as AutoresearchWorkflow
      predecessorEvents = [{ wf: current.id, type: "productify_selected", actor: "user_command", data: { status: data.verdict!.status } }]
    }
    try {
      const result = commitHandoff(tx, {
        predecessor,
        artifactKey: "verdict.json",
        successor,
        predecessorEvents,
        successorEvents: [
          { wf: successor.id, type: "created", actor: "code", data: { kind: "deep-interview", chars: request.length, seededFrom: "autoresearch" } },
          { wf: successor.id, type: "transition", to: "planning", actor: "code", data: { event: "start", seed: "autoresearch-verdict" } },
        ],
        allowStuckPredecessor: true,
        allowTerminalPredecessor: true,
      }, now)
      return { ok: true, predecessor: result.predecessor as AutoresearchWorkflow, successor: result.successor }
    } catch (error) {
      return { ok: false, text: (error as Error).message }
    }
  }, sessionID)
}

/** Retry after an attempt-failure or runner stuck: resumes the same stage. A finished (terminal) workflow cannot retry. */
export function retryAutoresearch(runtime: Pick<ExecutionRuntime, "worktree"> & Partial<Pick<ExecutionRuntime, "runs">>, sessionID: string, workflowID: string, expectedRevision: number): ChoiceResult {
  const current = committedAutoresearch(runtime, sessionID, workflowID)
  if (typeof current === "string") return { ok: false, text: current }
  // A fenced (unsettled) command is not retryable: re-running would replace an execution nobody has proven stopped.
  const fenced = (runtime.runs?.status().executions ?? []).find(execution => execution.ownerSession === sessionID && !settled(execution))
  if (fenced) return { ok: false, text: `retry refused: execution ${fenced.executionId} is fenced${fenced.fence ? ` (${fenced.fence.reason})` : ""}; ${autoresearchDataOf(current).stuck?.reason ?? "recover the fence first"}` }
  if (current.lastSeq !== expectedRevision) return { ok: false, text: "workflow revision changed; the retry is stale" }
  const outcome = commitAutoresearch(runtime.worktree, current, fresh => reduce(fresh, { type: "retry" }))
  return outcome.ok ? { ok: true, wf: outcome.wf } : { ok: false, text: outcome.text }
}

/** One-line truth-first view recomputed from committed data only: `autoresearch · experiment_run · iter 3/10`. */
export function autoresearchView(wf: AutoresearchWorkflow): string {
  let data: AutoresearchData
  try { data = autoresearchDataOf(wf) } catch { return "autoresearch state unreadable" }
  const valid = data.runs.filter(run => run.valid).length
  return `autoresearch · ${wf.stage} · iter ${data.iteration}/${AR_MAX_ITERATIONS} · ${data.runs.length} runs (${valid} valid)${data.best ? ` · best ${data.best.value}` : ""}${data.verdict ? ` · verdict ${data.verdict.status}` : ""}${data.stuck ? ` · stuck: ${data.stuck.reason}` : ""}`
}

export { isAutoresearch }
