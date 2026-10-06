// Host-neutral plan submission and advisory review. Operator approval is deliberately not an action here.
import { readWorkflow, planJsonPath, renderArtifact, fileSha, type Workflow } from "./state.ts"
import { writeJsonAtomic, readJson } from "../state/store.ts"
import { applyEvent, flowLimits, type FlowResult } from "./runtime.ts"
import { canonicalPlanJson, canonicalPlanSha, coercePlan, planMdPath, renderPlanMd, validatePlan, type Plan, type ReviewView } from "./plan.ts"
import { runPlanReview } from "./review.ts"
import type { ExecutionRuntime } from "../hosts/types.ts"
import type { FlowEvent } from "./machine.ts"

export type PlanSubmission = { result: FlowResult; planSha: string; renderedPlan?: string }

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
    return canonicalPlanSha(plan) === wf.planRef.jsonSha &&
      fileSha(runtime.worktree, wf.planRef.mdPath) === wf.planRef.mdSha ? plan : null
  } catch { return null }
}

export async function submitImportedPlan(runtime: ExecutionRuntime, wf: Workflow, plan: Plan, signal?: AbortSignal): Promise<PlanSubmission> {
  if (wf.phase !== "planning") throw new Error("workflow is not awaiting an imported plan")
  const planSha = canonicalPlanSha(plan)
  const mdPath = planMdPath(wf.id)
  writeJsonAtomic(planJsonPath(runtime.worktree, wf.id), plan)
  const mdSha = renderArtifact(runtime.worktree, mdPath, renderPlanMd(wf.id, plan))
  const submitted = applyEvent(runtime, wf, "submit_valid", "code", {}, w => ({
    ...w, planRef: { jsonSha: planSha, mdPath, mdSha, revision: plan.revision },
  }), { jsonSha: planSha })
  if (!submitted.ok) return { result: submitted, planSha }

  const review = await runPlanReview(runtime, submitted.wf, plan, signal)
  const event: FlowEvent = review.note === "aborted" ? "review_aborted" :
    review.verdict === "iterate" ? "review_iterate" : review.verdict === "okay" ? "review_okay" : "review_none"
  const capped = event === "review_iterate" && submitted.wf.counters.review_iterations + 1 >= flowLimits(runtime).max_review_iterations
  const note = review.note === "aborted" ? "aborted" : capped ? "cap" : undefined
  const current = readWorkflow(runtime.worktree)
  if (!current || current.id !== wf.id || current.phase !== "reviewing" || current.lastSeq !== submitted.wf.lastSeq) {
    return { result: { ok: false, text: "workflow changed during plan review", wf: current }, planSha }
  }
  const view: ReviewView = { verdict: review.verdict, findings: review.findings, ...(note ? { note } : {}) }
  const reviewedMdSha = renderArtifact(runtime.worktree, mdPath, renderPlanMd(wf.id, plan, view))
  const result = applyEvent(runtime, submitted.wf, event, "code", {}, w => ({
    ...w, planRef: { ...w.planRef!, mdSha: reviewedMdSha },
    review: { verdict: review.verdict, findings: review.findings, planSha, ...(note ? { note } : {}) },
  }), { findings: review.findings.length })
  return { result, planSha, ...(result.ok ? { renderedPlan: renderPlanMd(wf.id, plan, view) } : {}) }
}
