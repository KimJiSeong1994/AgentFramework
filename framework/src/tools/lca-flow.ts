// `lca_flow` tool (main only, registered when flow.enabled): the plan workflow's only model-facing entry point.
// op "status": code-rendered `/status` text. op "plan": T2-T8 — code gates the plan, and on success the advisory
// review runs INSIDE this tool call (main is blocked, so it never races the queue). Description + schema stay
// <= 300 est. tokens (asserted in test/lca-flow-tool.test.ts, doctor D12a).
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { HookDeps } from "../hooks/types.ts"
import { MAIN_AGENT } from "../hooks/tool-before.ts"
import { flowOn, renderStatus } from "../flow/status.ts"
import { getQueue } from "../orchestration/queue.ts"
import { writeJsonAtomic } from "../state/store.ts"
import { activeWorkflow, planJsonPath, readWorkflow, renderArtifact } from "../flow/state.ts"
import { applyEvent, flowLimits } from "../flow/runtime.ts"
import { canonicalPlanSha, coercePlan, planMdPath, renderPlanMd, validatePlan, type Plan, type ReviewView } from "../flow/plan.ts"
import { runPlanReview } from "../flow/review.ts"
import type { FlowEvent } from "../flow/machine.ts"

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

export function createLcaFlowTool(deps: HookDeps): ToolDefinition {
  return tool({
    description: LCA_FLOW_DESCRIPTION,
    args: lcaFlowArgs,
    async execute(args, ctx) {
      if (ctx.agent && ctx.agent !== MAIN_AGENT) {
        throw new Error(`lca: lca_flow is only available to the ${MAIN_AGENT} agent (current agent: ${ctx.agent}).`)
      }
      if (!flowOn(deps.config)) throw new Error("lca: the plan workflow feature is disabled.")

      if (args.op === "status") {
        const text = renderStatus(deps, ctx.sessionID, getQueue(deps).isRunning(ctx.sessionID))
        return { title: "lca_flow: status", output: text }
      }

      // op === "plan"
      const wf = activeWorkflow(deps.worktree)
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
      const jsonPath = planJsonPath(deps.worktree, wf.id)
      writeJsonAtomic(jsonPath, plan)
      const mdPath = planMdPath(wf.id)
      let mdSha = renderArtifact(deps.worktree, mdPath, renderPlanMd(wf.id, plan))
      const planRef = { jsonSha, mdPath, mdSha, revision: plan.revision }

      const submitted = applyEvent(deps, wf, "submit_valid", "model_tool", {}, (w) => ({ ...w, planRef }), { jsonSha })
      if (!submitted.ok) return { title: "lca_flow: refused", output: `lca: ${submitted.text}` }

      // review runs inside this tool call (main is blocked; no race with the queue). Esc (ctx.abort) aborts it (T8).
      const result = await runPlanReview(deps, submitted.wf, plan, ctx.abort)

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
      const current = readWorkflow(deps.worktree)
      if (!current || current.id !== wf.id || current.lastSeq !== submitted.wf.lastSeq || current.phase !== "reviewing") {
        deps.log("lca_flow: workflow changed during review; result dropped", { wfId: wf.id })
        return { title: "lca_flow: workflow changed", output: "lca: the workflow changed during review (cancelled or replaced); stop and check /status." }
      }
      const reviewView: ReviewView = { verdict: result.verdict, findings: result.findings, ...(note ? { note } : {}) }
      mdSha = renderArtifact(deps.worktree, mdPath, renderPlanMd(wf.id, plan, reviewView))
      const reviewed = applyEvent(
        deps,
        submitted.wf,
        event,
        "code",
        {},
        (w) => ({
          ...w,
          planRef: { ...w.planRef!, mdSha },
          review: { verdict: result.verdict, findings: result.findings, planSha: jsonSha, ...(note ? { note } : {}) },
        }),
        { findings: result.findings.length },
      )
      if (!reviewed.ok) return { title: "lca_flow: workflow changed", output: `lca: ${reviewed.text}` }
      const finalWf = reviewed.wf
      deps.log("lca_flow: plan reviewed", { wfId: wf.id, verdict: result.verdict, note, phase: finalWf.phase })

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
