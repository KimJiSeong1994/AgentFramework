// `lca_flow` tool (main only, registered when flow.enabled): the plan workflow's only model-facing entry point.
// op "status": code-rendered `/status` text. op "plan": T2-T8 — code gates the plan, and on success the advisory
// review runs INSIDE this tool call (main is blocked, so it never races the queue). Description + schema stay
// <= 300 est. tokens (asserted in test/lca-flow-tool.test.ts, doctor D12a).
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { HookDeps } from "../hooks/types.ts"
import { MAIN_AGENT } from "../hooks/tool-before.ts"
import { flowOn, renderStatus } from "../flow/status.ts"
import { getQueue } from "../orchestration/queue.ts"
import {
  activeWorkflow, assertFlowTxWorktree, CorruptWorkflowError, readWorkflowForWrite,
  renderArtifact, workflowEngineRefusal, withFlowTransaction, writePlanJson, type Workflow,
} from "../flow/state.ts"
import { applyEvent, applyEventIn, flowLimits } from "../flow/runtime.ts"
import { canonicalPlanSha, coercePlan, planMdPath, renderPlanMd, validatePlan, type Plan, type ReviewView } from "../flow/plan.ts"
import { runPlanReview, type PlanReviewResult } from "../flow/review.ts"
import type { FlowEvent } from "../flow/machine.ts"
import { getOpenCodeRuntime } from "../hosts/opencode-runtime.ts"
import { LinuxAdmissionRefused } from "../hosts/types.ts"

export const LCA_FLOW_DESCRIPTION =
  'Plan workflow control. "status": show plan/mode/ledger/queue status. "plan": submit the plan (3-10 steps: ' +
  "title, files touched, what to do, a verify command for that step alone); code checks it and an advisory review " +
  "runs before it is saved for the user's /approve."

const z = tool.schema

const step = z.object({ title: z.string(), files: z.array(z.string()), detail: z.string().optional(), verify: z.string() })

export const lcaFlowArgs = {
  op: z.enum(["status", "plan"]),
  plan: z.object({ goal: z.string(), steps: z.array(step), risks: z.array(z.string()) }).optional(),
}

async function showToast(deps: HookDeps, message: string): Promise<void> {
  const tui = (deps.client as any)?.tui
  if (!tui || typeof tui.showToast !== "function") return
  try {
    await tui.showToast({ body: { message } })
  } catch (e) {
    deps.log("lca_flow: showToast failed", { error: (e as Error).message })
  }
}

function numbered(errors: string[]): string {
  return errors.map((e, i) => `${i + 1}. ${e}`).join("\n")
}

function currentWorkflowRefusal(runtime: ReturnType<typeof getOpenCodeRuntime>, expected: Workflow): string | undefined {
  return withFlowTransaction(runtime.worktree, (tx) => {
    assertFlowTxWorktree(tx, runtime.worktree)
    const checked = readWorkflowForWrite(tx)
    if (checked.corrupt) throw new CorruptWorkflowError(checked.corrupt)
    const current = checked.wf
    if (!current) return "lca: workflow changed meanwhile; stop and check /status"
    const refusal = workflowEngineRefusal(current, runtime.host.identity.engine)
    if (refusal) return `lca: ${refusal}`
    if (current.id !== expected.id || current.lastSeq !== expected.lastSeq || current.phase !== expected.phase || current.engine !== expected.engine) {
      return "lca: workflow changed meanwhile; stop and check /status"
    }
    return undefined
  })
}

export function createLcaFlowTool(deps: HookDeps): ToolDefinition {
  const runtime = getOpenCodeRuntime(deps)
  return tool({
    description: LCA_FLOW_DESCRIPTION,
    args: lcaFlowArgs,
    async execute(args, ctx) {
      if (ctx.agent && ctx.agent !== MAIN_AGENT) {
        throw new Error(`lca: lca_flow is only available to the ${MAIN_AGENT} agent (current agent: ${ctx.agent}).`)
      }
      if (!flowOn(deps.config)) throw new Error("lca: the plan workflow feature is disabled.")

      if (args.op === "status") {
        const text = renderStatus(runtime, ctx.sessionID, getQueue(runtime).isRunning(ctx.sessionID))
        return { title: "lca_flow: status", output: text }
      }

      // op === "plan"
      runtime.linuxAdmission?.assertBootEpoch()
      const wf = activeWorkflow(deps.worktree)
      const engineRefusal = wf && workflowEngineRefusal(wf, runtime.host.identity.engine)
      if (engineRefusal) return { title: "lca_flow: refused", output: `lca: ${engineRefusal}` }
      if (!wf || wf.sessionID !== ctx.sessionID) {
        const text = wf
          ? `lca: plan workflow ${wf.id} is owned by another session.`
          : "lca: no plan workflow is active in this session."
        return { title: "lca_flow: refused", output: text }
      }
      if (wf.phase !== "planning") {
        const phase = `${wf.phase}${wf.stuckCause ? `(${wf.stuckCause})` : ""}`
        return { title: "lca_flow: refused", output: `lca: this workflow is not awaiting a plan (phase: ${phase}).` }
      }
      if (!args.plan) {
        return { title: "lca_flow: refused", output: 'lca: give a plan: goal, 3-10 steps (title, files, verify), and 1-5 risks.' }
      }

      const revision = 1 + wf.counters.code_invalid + wf.counters.review_iterations + wf.counters.user_rejections
      const plan: Plan = coercePlan(args.plan, revision)
      const errors = validatePlan(plan, deps.worktree, deps.config.delegate.verify_allow)

      try {
        await runtime.linuxAdmission?.admitNewExecution()
      } catch (e) {
        if (e instanceof LinuxAdmissionRefused) return { title: "lca_flow: refused", output: e.message }
        throw e
      }

      const postAdmissionRefusal = currentWorkflowRefusal(runtime, wf)
      if (postAdmissionRefusal) return { title: "lca_flow: refused", output: postAdmissionRefusal }

      if (errors.length > 0) {
        const r = applyEvent(deps, wf, "submit_invalid", "model_tool", {}, (w) => w, { errorCount: errors.length })
        if (!r.ok) return { title: "lca_flow: refused", output: `lca: ${r.text}` }
        if (r.toast) await showToast(deps, r.toast)
        const stuck = r.wf.phase === "stuck"
        const text = `lca: plan rejected — fix these and call lca_flow op:"plan" again:\n${numbered(errors)}${
          stuck ? "\n\nThe plan was rejected 3 times; ask the user for help, or wait for /reject <reason>." : ""
        }`
        return { title: `lca_flow: plan invalid${stuck ? " (stuck)" : ""}`, output: text }
      }

      // valid: raw plan json (coercePlan + canonicalPlanSha round-trips it on read, e.g. at /approve) + initial
      // md, submit_valid (T4 -> reviewing)
      const jsonSha = canonicalPlanSha(plan)
      const mdPath = planMdPath(wf.id)
      const initialMd = renderPlanMd(wf.id, plan)
      const submitted = withFlowTransaction(deps.worktree, (tx) => {
        assertFlowTxWorktree(tx, deps.worktree)
        const checked = readWorkflowForWrite(tx)
        if (checked.corrupt) throw new CorruptWorkflowError(checked.corrupt)
        const current = checked.wf
        const refusal = current && workflowEngineRefusal(current, runtime.host.identity.engine)
        if (refusal) return { ok: false as const, text: refusal, wf: current }
        if (!current || current.id !== wf.id || current.engine !== wf.engine || current.phase !== wf.phase || current.lastSeq !== wf.lastSeq) {
          return { ok: false as const, text: "workflow changed meanwhile; stop and check /status", wf: current }
        }
        if (current.phase !== "planning") return { ok: false as const, text: "workflow is not awaiting a plan", wf: current }
        writePlanJson(tx, current.id, plan)
        const mdSha = renderArtifact(tx, mdPath, initialMd)
        return applyEventIn(tx, runtime, current, "submit_valid", "model_tool", {}, (w) => ({
          ...w, planRef: { jsonSha, mdPath, mdSha, revision: plan.revision },
        }), { jsonSha })
      })
      if (!submitted.ok) return { title: "lca_flow: refused", output: `lca: ${submitted.text}` }

      const preReviewRefusal = currentWorkflowRefusal(runtime, submitted.wf)
      if (preReviewRefusal) return { title: "lca_flow: refused", output: preReviewRefusal }

      // review runs inside this tool call (main is blocked; no race with the queue). Esc (ctx.abort) aborts it (T8).
      let admissionRefusal: LinuxAdmissionRefused | undefined
      let result: PlanReviewResult
      try {
        result = await runPlanReview(runtime, submitted.wf, plan, ctx.abort)
      } catch (e) {
        if (!(e instanceof LinuxAdmissionRefused) || e.phase !== "admit") throw e
        admissionRefusal = e
        result = { verdict: "none", findings: [], note: "aborted" }
      }

      const limits = flowLimits(deps)
      let event: FlowEvent
      if (result.note === "aborted") event = "review_aborted"
      else if (result.verdict === "iterate") event = "review_iterate"
      else if (result.verdict === "okay") event = "review_okay"
      else event = "review_none"
      const capped = event === "review_iterate" && submitted.wf.counters.review_iterations + 1 >= limits.max_review_iterations
      const note: "aborted" | "cap" | undefined = result.note === "aborted" ? "aborted" : capped ? "cap" : undefined

      // The workflow may have changed while the review ran (/cancel, a new /plan): check before touching the md, and
      // let applyEvent's compare-and-swap refuse the write if it changes in between. One guarded write carries both
      // the review and the new md sha.
      const reviewView: ReviewView = { verdict: result.verdict, findings: result.findings, ...(note ? { note } : {}) }
      const reviewedMd = renderPlanMd(wf.id, plan, reviewView)
      const reviewed = withFlowTransaction(deps.worktree, (tx) => {
        assertFlowTxWorktree(tx, deps.worktree)
        const checked = readWorkflowForWrite(tx)
        if (checked.corrupt) throw new CorruptWorkflowError(checked.corrupt)
        const current = checked.wf
        const refusal = current && workflowEngineRefusal(current, runtime.host.identity.engine)
        if (refusal) return { ok: false as const, text: refusal, wf: current }
        if (!current || current.id !== submitted.wf.id || current.engine !== submitted.wf.engine ||
            current.lastSeq !== submitted.wf.lastSeq || current.phase !== "reviewing") {
          return { ok: false as const, text: "workflow changed during review", wf: current }
        }
        const reviewedMdSha = renderArtifact(tx, mdPath, reviewedMd)
        return applyEventIn(tx, runtime, current, event, "code", {}, (w) => ({
          ...w,
          planRef: { ...w.planRef!, mdSha: reviewedMdSha },
          review: { verdict: result.verdict, findings: result.findings, planSha: jsonSha, ...(note ? { note } : {}) },
        }), { findings: result.findings.length })
      })
      if (!reviewed.ok) {
        if (admissionRefusal) return { title: "lca_flow: refused", output: `${admissionRefusal.message}\n${reviewed.text}` }
        return { title: "lca_flow: workflow changed", output: `lca: ${reviewed.text}` }
      }
      const finalWf = reviewed.wf
      deps.log("lca_flow: plan reviewed", { wfId: wf.id, verdict: result.verdict, note, phase: finalWf.phase })

      if (admissionRefusal) return { title: "lca_flow: refused", output: admissionRefusal.message }
      if (finalWf.phase === "pending_approval") {
        return { title: "lca_flow: plan saved", output: `Plan saved to ${mdPath}. Tell the user to /approve or /reject <reason>. Stop.` }
      }
      const findingsText = result.findings.length ? result.findings.map((f) => `- ${f}`).join("\n") : "(no specific findings)"
      return {
        title: "lca_flow: plan needs revision",
        output: `Reviewer asked for changes:\n${findingsText}\nRevise and call lca_flow op:"plan" again.`,
      }
    },
  })
}
