// Host-neutral plan submission and advisory review. Operator approval is deliberately not an action here.
import {
  assertFlowTxWorktree, workflowReadError, readWorkflowForWrite,
  planJsonPath, renderArtifact, workflowEngineRefusal, withFlowTransaction, writePlanJson,
  type FlowTx, type Workflow,
} from "./state.ts"
import { readJson } from "../state/store.ts"
import { applyEventIn, flowLimits, type FlowResult } from "./runtime.ts"
import { canonicalPlanJson, canonicalPlanSha, coercePlan, planMdPath, renderPlanMd, validatePlan, type Plan, type ReviewView } from "./plan.ts"
import { runPlanReview } from "./review.ts"
import { LinuxAdmissionRefused, type ExecutionRuntime, type PlanSubmissionAdmission } from "../hosts/types.ts"
import type { FlowEvent } from "./machine.ts"
import { planArtifactRefs, verifyArtifact } from "../workflows/artifacts.ts"

export type PlanSubmission = { result: FlowResult; planSha: string; renderedPlan?: string }

function workflowRefusal(runtime: ExecutionRuntime, wf: Workflow): string | undefined {
  return workflowEngineRefusal(wf, runtime.host.identity.engine)
}

function changedResult(current: Workflow | null): FlowResult {
  return { ok: false, text: "workflow changed during plan submission", wf: current }
}

type WorkflowSnapshot = { current: Workflow } | { result: FlowResult }

function currentSnapshot(runtime: ExecutionRuntime, expected: Workflow): WorkflowSnapshot {
  return withFlowTransaction(runtime.worktree, (tx) => {
    assertFlowTxWorktree(tx, runtime.worktree)
    const checked = readWorkflowForWrite(tx)
    if (checked.corrupt) throw workflowReadError(checked)
    const inputRefusal = workflowRefusal(runtime, expected)
    if (inputRefusal) throw new Error(inputRefusal)
    const current = checked.wf
    if (!current) return { result: changedResult(null) }
    const currentRefusal = workflowRefusal(runtime, current)
    if (currentRefusal) throw new Error(currentRefusal)
    if (current.id !== expected.id || current.engine !== expected.engine || current.phase !== expected.phase || current.lastSeq !== expected.lastSeq) {
      return { result: changedResult(current) }
    }
    return { current }
  })
}

function submitPlanIn(
  tx: FlowTx,
  runtime: ExecutionRuntime,
  expected: Workflow,
  plan: Plan,
  actor: "code" | "model_tool",
  jsonSha: string,
  mdText: string,
): FlowResult {
  assertFlowTxWorktree(tx, runtime.worktree)
  const checked = readWorkflowForWrite(tx)
  if (checked.corrupt) throw workflowReadError(checked)
  const current = checked.wf
  const inputRefusal = workflowRefusal(runtime, expected)
  if (inputRefusal) throw new Error(inputRefusal)
  if (!current) return changedResult(null)
  const currentRefusal = workflowRefusal(runtime, current)
  if (currentRefusal) throw new Error(currentRefusal)
  if (current.id !== expected.id || current.engine !== expected.engine || current.phase !== expected.phase || current.lastSeq !== expected.lastSeq) {
    return changedResult(current)
  }
  if (current.phase !== "planning") return { ok: false, text: "workflow is not awaiting a plan", wf: current }

  const mdPath = planMdPath(current.id)
  writePlanJson(tx, current.id, plan)
  const mdSha = renderArtifact(tx, mdPath, mdText)
  return applyEventIn(tx, runtime, current, "submit_valid", actor, {}, (w) => ({
    ...w, planRef: { jsonSha, mdPath, mdSha, revision: plan.revision },
  }), { jsonSha })
}

function reviewPlanIn(
  tx: FlowTx,
  runtime: ExecutionRuntime,
  expected: Workflow,
  mdPath: string,
  mdText: string,
  event: FlowEvent,
  jsonSha: string,
  review: ReviewView,
  note: "aborted" | "cap" | undefined,
): FlowResult {
  assertFlowTxWorktree(tx, runtime.worktree)
  const checked = readWorkflowForWrite(tx)
  if (checked.corrupt) throw workflowReadError(checked)
  const current = checked.wf
  const inputRefusal = workflowRefusal(runtime, expected)
  if (inputRefusal) throw new Error(inputRefusal)
  if (!current) return { ok: false, text: "workflow changed during plan review", wf: null }
  const currentRefusal = workflowRefusal(runtime, current)
  if (currentRefusal) throw new Error(currentRefusal)
  if (current.id !== expected.id || current.engine !== expected.engine || current.phase !== expected.phase || current.lastSeq !== expected.lastSeq) {
    return { ok: false, text: "workflow changed during plan review", wf: current }
  }
  if (current.phase !== "reviewing") return { ok: false, text: "workflow changed during plan review", wf: current }

  const reviewedMdSha = renderArtifact(tx, mdPath, mdText)
  return applyEventIn(tx, runtime, current, event, "code", {}, (w) => ({
    ...w,
    planRef: { ...w.planRef!, mdSha: reviewedMdSha },
    review: { verdict: review.verdict, findings: review.findings, planSha: jsonSha, ...(note ? { note } : {}) },
  }), { findings: review.findings.length })
}

/** Reject noncanonical shapes rather than silently dropping a field supplied by an external file. */
export function importedPlan(value: unknown, revision: number, runtime: ExecutionRuntime): Plan {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (value as Record<string, unknown>).revision !== revision) throw new Error(`plan revision must be ${revision}`)
  const plan = coercePlan(value, revision)
  if (JSON.stringify(value) !== canonicalPlanJson(plan)) throw new Error("plan JSON must have canonical fields and values")
  const problems = validatePlan(plan, runtime.worktree, runtime.config.delegate.verify_allow)
  if (problems.length) throw new Error(`invalid plan: ${problems.join("; ")}`)
  return plan
}

export function savedPlan(runtime: ExecutionRuntime, wf: Workflow): Plan | null {
  if (!wf.planRef) return null
  try {
    const value = readJson<unknown>(planJsonPath(runtime.worktree, wf.id), null)
    const plan = importedPlan(value, wf.planRef.revision, runtime)
    // Authority is the committed hash: the rendered view must verify from disk (no-follow regular file, matching sha).
    return canonicalPlanSha(plan) === wf.planRef.jsonSha &&
      planArtifactRefs(wf).every(ref => verifyArtifact(runtime.worktree, ref).state === "verified") ? plan : null
  } catch { return null }
}

export async function submitImportedPlan(runtime: ExecutionRuntime, wf: Workflow, plan: Plan, signal?: AbortSignal): Promise<PlanSubmission> {
  const beforeAdmission = currentSnapshot(runtime, wf)
  if ("result" in beforeAdmission) return { result: beforeAdmission.result, planSha: canonicalPlanSha(plan) }
  if (wf.phase !== "planning") throw new Error("workflow is not awaiting an imported plan")
  await runtime.linuxAdmission?.admitNewExecution()
  return writeAndReviewImportedPlan(runtime, wf, plan, signal)
}

export async function submitAdmittedImportedPlan(
  runtime: ExecutionRuntime,
  wf: Workflow,
  plan: Plan,
  admission: PlanSubmissionAdmission,
  signal?: AbortSignal,
): Promise<PlanSubmission> {
  if (!runtime.linuxAdmission) throw new TypeError("lca: plan-submission admission is unavailable")
  const beforeAdmission = currentSnapshot(runtime, wf)
  if ("result" in beforeAdmission) return { result: beforeAdmission.result, planSha: canonicalPlanSha(plan) }
  if (wf.phase !== "planning") throw new Error("workflow is not awaiting an imported plan")
  runtime.linuxAdmission.consumePlanSubmission(admission, wf.sessionID)
  return writeAndReviewImportedPlan(runtime, wf, plan, signal)
}

async function writeAndReviewImportedPlan(runtime: ExecutionRuntime, wf: Workflow, plan: Plan, signal?: AbortSignal): Promise<PlanSubmission> {
  const initial = currentSnapshot(runtime, wf)
  if ("result" in initial) return { result: initial.result, planSha: canonicalPlanSha(plan) }
  if (initial.current.phase !== "planning") return { result: { ok: false, text: "workflow is not awaiting a plan", wf: initial.current }, planSha: canonicalPlanSha(plan) }
  const planSha = canonicalPlanSha(plan)
  const mdPath = planMdPath(wf.id)
  const initialMd = renderPlanMd(wf.id, plan)
  const submitted = withFlowTransaction(runtime.worktree, (tx) =>
    submitPlanIn(tx, runtime, wf, plan, "code", planSha, initialMd))
  if (!submitted.ok) return { result: submitted, planSha }
  return reviewSubmittedPlan(runtime, submitted.wf, plan, signal)
}

/**
 * The review half of a submission: one review attempt on the committed `reviewing` subject and its single result
 * commit. A Resume of a pause taken in `reviewing` calls this directly (A3: exactly one new review attempt).
 */
export async function reviewSubmittedPlan(runtime: ExecutionRuntime, submittedWf: Workflow, plan: Plan, signal?: AbortSignal): Promise<PlanSubmission> {
  const submitted = { wf: submittedWf }
  const planSha = canonicalPlanSha(plan)
  const mdPath = planMdPath(submittedWf.id)
  const wf = submittedWf
  const beforeReview = currentSnapshot(runtime, submitted.wf)
  if ("result" in beforeReview) return { result: beforeReview.result, planSha }
  if (beforeReview.current.phase !== "reviewing") {
    return { result: { ok: false, text: "workflow changed before plan review", wf: beforeReview.current }, planSha }
  }

  let admissionRefusal: LinuxAdmissionRefused | undefined
  const review = await runPlanReview(runtime, submitted.wf, plan, signal).catch((error: unknown) => {
    if (!(error instanceof LinuxAdmissionRefused) || error.phase !== "admit") throw error
    admissionRefusal = error
    return { verdict: "none" as const, findings: [], note: "aborted" as const }
  })
  const event: FlowEvent = review.note === "aborted" ? "review_aborted" :
    review.verdict === "iterate" ? "review_iterate" : review.verdict === "okay" ? "review_okay" : "review_none"
  const capped = event === "review_iterate" && submitted.wf.counters.review_iterations + 1 >= flowLimits(runtime).max_review_iterations
  const note = review.note === "aborted" ? "aborted" : capped ? "cap" : undefined
  const view: ReviewView = { verdict: review.verdict, findings: review.findings, ...(note ? { note } : {}) }
  const reviewedMd = renderPlanMd(wf.id, plan, view)
  const result = withFlowTransaction(runtime.worktree, (tx) =>
    reviewPlanIn(tx, runtime, submitted.wf, mdPath, reviewedMd, event, planSha, view, note))
  if (!result.ok) return { result, planSha }
  if (admissionRefusal) throw admissionRefusal
  return { result, planSha, ...(result.ok ? { renderedPlan: renderPlanMd(wf.id, plan, view) } : {}) }
}
