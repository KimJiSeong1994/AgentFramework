// Autoresearch experiment runner (P6b S3). Each approved command runs through the shared `runVerifierExecution` (the same
// durable-intent -> prepare -> dispatch -> terminal -> reconcile -> settlement -> integrity sequence the queue uses), under
// an `experiment` registry activity and an owned run claim, with the shared `abortVerifierExecution` for stops. There is
// no queue, no worker, no dummy task and no shell of its own: the only way a command reaches a process is the verifier.
// A run is recorded (run file + verification receipt + one commit) before the claim and activity are released, so a
// pause or cancel settles only after the evidence of what actually happened is on disk.
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { verifyCommandProblem } from "../config.ts"
import { adoptForeignStop, observeStopSettlement } from "../flow/runtime.ts"
import { beginExecutionActivity } from "../hosts/runtime.ts"
import type { ExecutionRuntime } from "../hosts/types.ts"
import { abortVerifierExecution, runVerifierExecution, type VerifierRunEntry, type VerifierRunOutcome } from "../orchestration/verifier-run.ts"
import { createSnapshotStore, type SnapshotStore } from "../orchestration/snapshot.ts"
import { getOwnedSession } from "../sessions/store.ts"
import { sessionDir } from "../state/store.ts"
import { sha256 } from "./artifacts.ts"
import { isAutoresearch, classifyRun, reduce, autoresearchDataOf, type AutoresearchWorkflow, type Hashed, type RunFacts } from "./autoresearch.ts"
import { commitAutoresearch, committedAutoresearch } from "./autoresearch-commit.ts"
import { runKey, slotIndex, type ArRun } from "./autoresearch-data.ts"
import type { ArRunDoc } from "./autoresearch-evidence.ts"
import { unitRecord, unitRecordProblem } from "./execution-unit.ts"
import { writeReceipt } from "./receipts.ts"
import { writeDoc } from "./autoresearch-docs.ts"

export type RunStageResult =
  /** every slot ran and the experiment was finished (committed); the driver continues to evaluate */
  | { status: "finished"; wf: AutoresearchWorkflow }
  /** a stop, a conflicting activity or an unproven run ended the stage; nothing further was started */
  | { status: "blocked"; wf: AutoresearchWorkflow | null; reason: string }
  | { status: "stale"; wf: AutoresearchWorkflow | null; reason: string }

type Stage = { runtime: ExecutionRuntime; sessionID: string; workflowID: string; signal?: AbortSignal; onRun?: (run: ArRun) => void }

const STOP_REASON = (wf: AutoresearchWorkflow): string => (wf.stopIntent ? `${wf.stopIntent.kind} requested` : `workflow is at ${wf.stage}/${wf.phase}`)

function settleStop(runtime: ExecutionRuntime, wf: AutoresearchWorkflow): void {
  if (!wf.stopIntent) return
  try { observeStopSettlement(runtime, wf.sessionID, wf.owner.instance, "experiment") } catch { /* the observer never throws; a failure leaves the stop pending */ }
}

/**
 * Run the remaining slots of the approved experiment, one at a time. Every iteration re-reads the committed workflow and
 * re-verifies the approved unit (subject recomputed, documents hashed, approval receipt read back), so a changed
 * experiment, a recorded stop or a foreign write turns the next slot into `blocked`/`stale` without starting anything.
 */
export async function runExperimentStage(stage: Stage): Promise<RunStageResult> {
  const { runtime, sessionID, workflowID } = stage
  const worktree = runtime.worktree
  const config = runtime.config.delegate
  let store: SnapshotStore | null = null
  for (;;) {
    let held = false
    const wf = committedAutoresearch(runtime, sessionID, workflowID)
    if (typeof wf === "string") return { status: "stale", wf: null, reason: wf }
    if (wf.stage !== "experiment_run" || wf.phase !== "executing" || wf.stopIntent) {
      settleStop(runtime, wf)
      return { status: "blocked", wf, reason: STOP_REASON(wf) }
    }
    const data = autoresearchDataOf(wf)
    const record = unitRecord(wf)
    const experiment = data.experiment
    if (!record || !experiment || !data.mission) return { status: "blocked", wf, reason: "approved experiment is missing" }
    const problem = unitRecordProblem(wf, record, worktree)
    if (problem) return { status: "blocked", wf, reason: problem }
    if (experiment.remaining.length === 0) {
      const finished = commitAutoresearch(worktree, wf, fresh => reduce(fresh, { type: "experiment_finished" }))
      return finished.ok ? { status: "finished", wf: finished.wf } : { status: "stale", wf, reason: finished.text }
    }
    const slot = experiment.remaining[0]!
    const command = experiment.input.commands[slotIndex(slot)]
    if (command === undefined) return { status: "blocked", wf, reason: `experiment slot ${slot} has no approved command` }
    const attempt = data.runs.length + 1

    const finish = (outcome: VerifierRunOutcome | { kind: "denied"; output: string }, interrupted: boolean): { ok: true; wf: AutoresearchWorkflow } | { ok: false; text: string } => {
      const ran = outcome.kind === "ran" || outcome.kind === "unresolved" ? outcome : undefined
      const facts: RunFacts = {
        unsettled: outcome.kind === "unresolved",
        refused: outcome.kind === "refused" || outcome.kind === "denied", interrupted, integrity: ran && "integrity" in ran ? ran.integrity : "unknown", invalidated: ran && "invalidated" in ran ? ran.invalidated : false,
        exitCode: ran?.r.parentExit ?? null, timedOut: ran?.r.timedOut ?? false, cancelled: ran?.r.cancelled ?? false,
        output: ran ? ran.r.output : ("output" in outcome ? outcome.output : ""),
      }
      // Re-read: a stop request committed while the command ran moved the revision; the owner records what happened.
      const latest = committedAutoresearch(runtime, sessionID, workflowID)
      if (typeof latest === "string") return { ok: false, text: latest }
      return recordRun(runtime, latest, attempt, experiment.iteration, slotIndex(slot), command, facts, stage.onRun)
    }

    let recorded: { ok: true; wf: AutoresearchWorkflow } | { ok: false; text: string } | undefined
    const refusal = verifyCommandProblem(command, config.verify_allow)
    if (refusal) recorded = finish({ kind: "denied", output: `command refused: ${refusal}` }, false)
    else {
      // ---- one verifier execution under the experiment activity and an owned claim; recorded BEFORE they are released
      const entry: VerifierRunEntry = { aborted: false }
      let abortWork: Promise<void> | undefined
      const stop = (cause: string): void => {
        if (entry.aborted) return
        entry.aborted = true
        entry.reason = cause
        // The shared policy lives in abortVerifierExecution: a running legacy command is left to exit or hit its deadline
        // (recorded as interrupted); anything not yet dispatched and every provable (owned) verifier is cancelled now.
        abortWork = abortVerifierExecution(runtime, entry, cause).catch(error => runtime.log("experiment abort failed", { error: String(error) }))
      }
      const release = beginExecutionActivity(runtime, sessionID, "experiment", { workflowID, abort: stop })
      if (!release) return { status: "blocked", wf, reason: "another execution is active" }
      let timer: ReturnType<typeof setInterval> | undefined
      const onSignal = (): void => stop("experiment cancelled")
      let failure: Error | undefined
      let cancelledBeforeDispatch = false
      let unsettledReason: string | undefined
      try {
        entry.claim = runtime.runs.claim(sessionID, runtime.instance, process.pid)
        held = true
        store ??= await createSnapshotStore(worktree, join(sessionDir(worktree, sessionID), "snapshots", `exp-${workflowID}`))
        if (!store) throw new Error("experiment snapshot store unavailable (not a git worktree)")
        timer = setInterval(() => {
          const now = committedAutoresearch(runtime, sessionID, workflowID)
          if (typeof now !== "string" && now.stopIntent) {
            adoptForeignStop(runtime, { sessionID })
            stop(`workflow_${now.stopIntent.kind}:${now.stopIntent.token}`)
          }
        }, 50)
        stage.signal?.addEventListener("abort", onSignal, { once: true })
        if (stage.signal?.aborted) stop("experiment cancelled")
        const outcome = await runVerifierExecution(runtime, entry, {
          sessionID, taskID: `${workflowID}:r${attempt}`, attemptID: randomUUID(), attemptNumber: attempt, command, root: worktree, store,
          config: { diff_exclude: config.diff_exclude, diff_max_chars: config.diff_max_chars, verify_timeout_ms: config.verify_timeout_ms, verify_output_chars: config.verify_output_chars },
        })
        if (outcome.kind === "cancelled") cancelledBeforeDispatch = true
        else {
          // Record what happened FIRST (run file + receipt); an unsettled command is then a visible fenced stuck.
          recorded = finish(outcome, entry.aborted)
          if (outcome.kind === "unresolved") unsettledReason = `${outcome.reason}: the command ${outcome.r.timedOut ? "timed out" : "was terminated"} and its descendants cannot be proven stopped; execution fenced (see README: operator recovery)`
        }
      } catch (error) {
        failure = error as Error
      } finally {
        if (timer) clearInterval(timer)
        stage.signal?.removeEventListener("abort", onSignal)
        try { if (abortWork) await abortWork } catch { /* recorded by the abort path */ }
        if (held && !entry.unresolved) {
          try { runtime.runs.release(entry.claim!) } catch (error) { runtime.log("experiment claim retained", { error: String(error) }) }
        }
        release()
      }
      if (failure || entry.unresolved) {
        const latest = committedAutoresearch(runtime, sessionID, workflowID)
        const current = typeof latest === "string" ? null : latest
        if (current) settleStop(runtime, current)
        const reason = failure?.message ?? unsettledReason ?? "experiment execution could not be settled; fence retained"
        // Never fabricate a result: a stop in flight keeps its own lifecycle; otherwise the runner records a visible stuck.
        const fresh = current ? committedAutoresearch(runtime, sessionID, workflowID) : null
        if (fresh && typeof fresh !== "string" && !fresh.stopIntent && fresh.stage === "experiment_run" && fresh.phase === "executing") {
          const stuck = commitAutoresearch(worktree, fresh, f => reduce(f, { type: "runner_failed", reason }), Date.now(), "code", { recording: true })
          if (stuck.ok) return { status: "blocked", wf: stuck.wf, reason }
        }
        return { status: "blocked", wf: current, reason }
      }
      if (cancelledBeforeDispatch) {
        const latest = committedAutoresearch(runtime, sessionID, workflowID)
        if (typeof latest !== "string") settleStop(runtime, latest)
        return { status: "blocked", wf: typeof latest === "string" ? null : latest, reason: "experiment cancelled before dispatch; nothing ran" }
      }
    }

    const latest = committedAutoresearch(runtime, sessionID, workflowID)
    if (!recorded?.ok) {
      if (typeof latest !== "string") settleStop(runtime, latest)
      return { status: "stale", wf: typeof latest === "string" ? null : latest, reason: recorded?.text ?? "run was not recorded" }
    }
    settleStop(runtime, recorded.wf)
    if (recorded.wf.stopIntent) return { status: "blocked", wf: recorded.wf, reason: STOP_REASON(recorded.wf) }
  }
}

/** Classify by code, write runs/<attempt>.json and its verification receipt, then commit run_recorded (owner recording). */
function recordRun(
  runtime: ExecutionRuntime, wf: AutoresearchWorkflow, attempt: number, iteration: number, slot: number, command: string, facts: RunFacts, onRun?: (run: ArRun) => void,
): { ok: true; wf: AutoresearchWorkflow } | { ok: false; text: string } {
  const worktree = runtime.worktree
  return commitAutoresearch(worktree, wf, fresh => {
    const data = autoresearchDataOf(fresh)
    const experiment = data.experiment!
    const mission = data.mission!
    const classified = classifyRun(facts, mission.metric, data.runs.filter(run => run.valid))
    const outputSha = sha256(facts.output)
    const approvalRef = experiment.approval.receiptRef
    const body = {
      attempt, status: classified.status, command, exitCode: facts.exitCode, timedOut: facts.timedOut, integrity: facts.integrity, outputSha, valid: classified.valid,
      ...(classified.metric === undefined ? {} : { metric: classified.metric }),
    }
    const receiptRef = writeReceipt(worktree, {
      kind: "verification", wid: fresh.id, sid: fresh.sessionID, revision: fresh.lastSeq, action: `verification-run-${attempt}`, inputSha: experiment.subject.sha256, body,
    })
    const doc: ArRunDoc = {
      v: 1, wid: fresh.id, sid: fresh.sessionID, attempt, iteration, slot, command, subjectSha: experiment.subject.sha256, approvalRef, verificationRef: receiptRef,
      status: classified.status, valid: classified.valid, ...(classified.invalid ? { invalid: classified.invalid } : {}), ...(classified.metric === undefined ? {} : { metric: classified.metric }),
      exitCode: facts.exitCode, timedOut: facts.timedOut, integrity: facts.integrity, outputSha, output: facts.output,
    }
    const artifact: Hashed = writeDoc(worktree, fresh, runKey(attempt), `${JSON.stringify(doc, null, 2)}\n`)
    const run: ArRun = {
      attempt, iteration, slot, path: artifact.path, sha256: artifact.sha256, receiptRef, status: classified.status, valid: classified.valid,
      ...(classified.invalid ? { invalid: classified.invalid } : {}), ...(classified.metric === undefined ? {} : { metric: classified.metric }),
    }
    onRun?.(run)
    return { ...reduce(fresh, { type: "run_recorded", run, artifact }), receipts: [receiptRef] }
  }, Date.now(), "code", { recording: true })
}

export { isAutoresearch }
