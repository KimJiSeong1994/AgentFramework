import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { newWorkflow, writeWorkflow } from "../src/flow/state.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { clearReviewSession, isReviewSession, markReviewSession, parsePlanVerdict, reviewToolCapProblem, runPlanReview } from "../src/flow/review.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import type { Plan } from "../src/flow/plan.ts"
import { tempWorktree, waitFor } from "./guards-helpers.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"
import { readLedger } from "../src/state/ledger.ts"

const S = "ses_main"
let wt: ReturnType<typeof tempWorktree>
beforeEach(() => { wt = tempWorktree() })
afterEach(() => wt.cleanup())

function wf() { return newWorkflow(S, currentOwner(), "command", "do the thing") }
function plan(): Plan {
  return {
    goal: "fix the bug",
    steps: [{ title: "one", files: ["src/a.ts"], detail: "d", verify: "bun test test/a.test.ts" }],
    risks: ["might miss an edge case"], revision: 1,
  }
}

function fixture(options: {
  text?: string
  run?: () => Promise<ExecutionOutcome>
  quiescent?: boolean
  acknowledged?: boolean
  prepareError?: boolean
  prepareWait?: () => Promise<void>
  ttl?: number
  model?: string
} = {}) {
  const config = { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models, ...(options.model ? { reviewer: options.model } : {}) }, delegate: { ...DEFAULT_CONFIG.delegate, review_ttl_ms: options.ttl ?? 200 } }
  const runs = createExecutionRunStore(wt.worktree)
  const policy = createExecutionPolicy(config, { directory: wt.worktree, worktree: wt.worktree })
  const calls: string[] = []
  let request: ExecutionRequest | undefined
  const runtime: ExecutionRuntime = {
    instance: "review-fixture", directory: wt.worktree, worktree: wt.worktree, stateRoot: wt.stateHome,
    config, log: () => {}, runs, policy, verificationProfile: "legacy-unowned", verifier: createLegacyVerifierExecutor(),
    host: {
      identity: { engine: "fixture", profile: "review" },
      preflight: async () => ({ compatible: true, controls: {}, problems: [] }),
      reconcile: async () => ({ outcome: "unknown", quiescent: false, evidence: "restart cannot prove terminal state" }),
      async prepare(value) {
        calls.push("prepare")
        request = value
        expect(runs.status().executions.at(-1)?.executionId).toBe(value.executionID)
        if (options.prepareWait) await options.prepareWait()
        if (options.prepareError) throw new Error("prepare failed")
        const reference = { executionID: value.executionID, vendorSessionID: "review-child" }
        policy.bindSession(reference.vendorSessionID, value.handlers, value.policy)
        return {
          reference,
          async run() {
            calls.push("run")
            expect(runs.status().executions.at(-1)?.vendorRef).toBe(JSON.stringify(reference))
            expect(isReviewSession("review-child")).toBe(true)
            expect(policy.handlersForSession("review-child")).toBe(value.handlers)
            return options.run ? options.run() : { status: "completed" as const, text: options.text ?? "VERDICT: OKAY" }
          },
          async requestCancel() {
            calls.push("cancel")
            return { requested: true, acknowledged: options.acknowledged ?? true, terminal: false, quiescent: false }
          },
          async reconcile() {
            calls.push("reconcile")
            return { outcome: options.quiescent === false ? "running" as const : "terminal" as const,
              quiescent: options.quiescent !== false, evidence: "fixture terminal state" }
          },
        }
      },
    },
  }
  return { runtime, runs, policy, calls, get request() { return request } }
}

describe("parsePlanVerdict", () => {
  test("advisory aliases and bounded findings, never implicit approval", () => {
    expect(parsePlanVerdict("- a\n- b\n- c\n- d\n- e\n- f\nVERDICT: 승인"))
      .toEqual({ verdict: "okay", findings: ["a", "b", "c", "d", "e"] })
    expect(parsePlanVerdict("- revise\nVERDICT: REJECTED").verdict).toBe("iterate")
    expect(parsePlanVerdict("sounds good").verdict).toBe("none")
  })
})

describe("reviewToolCapProblem", () => {
  test("legacy hook interceptor retains the code-owned reviewer call cap", () => {
    markReviewSession("child_x")
    for (let i = 0; i < 6; i++) expect(reviewToolCapProblem("child_x", 6)).toBeNull()
    expect(reviewToolCapProblem("child_x", 6)).toBe("give your verdict now")
    clearReviewSession("child_x")
    expect(isReviewSession("child_x")).toBe(false)
  })
})

describe("runPlanReview with neutral runtime", () => {
  test("durably records intent and ref before run, enforces immutable reviewer policy, then releases", async () => {
    const f = fixture({ text: "- concrete\nVERDICT: ITERATE" })
    expect(await runPlanReview(f.runtime, wf(), plan())).toEqual({ verdict: "iterate", findings: ["concrete"] })
    expect(f.calls).toEqual(["prepare", "run", "reconcile"])
    expect(f.request?.role).toBe("reviewer")
    expect(f.request?.text).toContain("Goal:")
    expect(f.request?.policy.tools.denied).toContain("bash")
    expect(f.request?.policy.model).toBeUndefined()
    expect(f.runs.status().executions[0]).toMatchObject({ vendorRef: JSON.stringify({ executionID: f.request!.executionID, vendorSessionID: "review-child" }), terminal: { outcome: "completed" } })
    expect(f.runs.status().claim).toBeUndefined()
    expect(f.policy.handlersForSession("review-child")).toBeUndefined()
    expect(isReviewSession("review-child")).toBe(false)
  })

  test("review policy carries slash-containing provider model ID and capped plan text", async () => {
    const f = fixture({ model: "openai-compatible/org/reviewer-v2" })
    const long = plan()
    long.risks = ["large".repeat(3000)]
    expect((await runPlanReview(f.runtime, wf(), long)).verdict).toBe("okay")
    expect(f.request?.policy.model).toEqual({ providerID: "openai-compatible", modelID: "org/reviewer-v2" })
    expect(f.request!.text.length).toBeLessThan(12000)
  })

  test("preparation failure without a reference retains an unresolved fence", async () => {
    const f = fixture({ prepareError: true })
    expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
    expect(f.calls).toEqual(["prepare"])
    expect(f.runs.status().executions[0]?.fence).toBeDefined()
    expect(f.runs.status().claim).toBeDefined()
  })

  test("operator abort during hung preparation is bounded and retains intent fence", async () => {
    const controller = new AbortController()
    const f = fixture({ prepareWait: () => new Promise<void>(() => {}) })
    const review = runPlanReview(f.runtime, wf(), plan(), controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    expect(await review).toMatchObject({ verdict: "none", note: "aborted" })
    expect(f.calls).toEqual(["prepare"])
    expect(f.runs.status().executions[0]?.fence).toBeDefined()
    expect(f.runs.status().claim).toBeDefined()
  })

  test("review-first execution refuses concurrent queue without cancelling pending tasks", async () => {
    const controller = new AbortController()
    const f = fixture({ prepareWait: () => new Promise<void>(() => {}) })
    const queue = getQueue(f.runtime)
    queue.add(S, [{ title: "pending task" }])
    const review = runPlanReview(f.runtime, wf(), plan(), controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await queue.run(S)).toMatchObject({ skipped: "execution_busy", aborted: false })
    expect(readLedger(wt.worktree, S).tasks[0]?.status).toBe("pending")
    controller.abort()
    await review
  })

  test("ACK without quiescence fences and retains claim and policy; next review cannot launch", async () => {
    const f = fixture({ ttl: 5, quiescent: false, run: () => new Promise(() => {}) })
    expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
    expect(f.calls).toEqual(["prepare", "run", "cancel", "reconcile"])
    expect(f.runs.status().executions[0]).toMatchObject({ cancel: { acknowledgedAt: expect.any(Number) }, fence: { reason: expect.any(String) } })
    expect(f.runs.status().executions[0]?.terminal).toBeUndefined()
    expect(f.policy.handlersForSession("review-child")).toBeDefined()
    expect(isReviewSession("review-child")).toBe(true)
    expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
    expect(f.calls.filter((call) => call === "prepare")).toHaveLength(1)
    expect(f.runs.status().claim).toBeDefined()
    clearReviewSession("review-child")
  })

  test("late completed text without quiescence cannot become a verdict or release ownership", async () => {
    const f = fixture({ quiescent: false, text: "VERDICT: OKAY" })
    expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
    expect(f.runs.status().executions[0]?.fence).toBeDefined()
    expect(f.runs.status().claim).toBeDefined()
    clearReviewSession("review-child")
  })

  test("matching persisted cancelled workflow aborts a live plan review and retains its unproven fence", async () => {
    const workflow = wf()
    writeWorkflow(wt.worktree, workflow)
    const f = fixture({ quiescent: false, run: () => new Promise<ExecutionOutcome>(() => {}) })
    const review = runPlanReview(f.runtime, workflow, plan())
    await waitFor(() => f.calls.includes("run"))
    writeWorkflow(wt.worktree, { ...workflow, phase: "cancelled" })
    expect(await review).toMatchObject({ verdict: "none", note: "aborted" })
    expect(f.calls).toEqual(["prepare", "run", "cancel", "reconcile"])
    expect(f.runs.status().executions[0]).toMatchObject({ fence: { reason: expect.any(String) }, cancel: { acknowledgedAt: expect.any(Number) } })
    expect(f.runs.status().executions[0]?.terminal).toBeUndefined()
    expect(f.runs.status().claim).toBeDefined()
    clearReviewSession("review-child")
  })

  for (const mismatch of ["workflow", "session"] as const) {
    test(`persisted cancellation for a different ${mismatch} does not abort a live plan review`, async () => {
      const workflow = wf()
      writeWorkflow(wt.worktree, workflow)
      let finishReview!: (outcome: ExecutionOutcome) => void
      const f = fixture({ ttl: 1000, run: () => new Promise<ExecutionOutcome>(resolve => { finishReview = resolve }) })
      const review = runPlanReview(f.runtime, workflow, plan())
      await waitFor(() => f.calls.includes("run"))
      writeWorkflow(wt.worktree, {
        ...workflow,
        ...(mismatch === "workflow" ? { id: `${workflow.id}_other` } : { sessionID: "ses_other" }),
        phase: "cancelled",
        pendingCancel: true,
      })
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(f.calls).toEqual(["prepare", "run"])
      finishReview({ status: "completed", text: "VERDICT: OKAY" })
      expect(await review).toEqual({ verdict: "okay", findings: [] })
      expect(f.calls).toEqual(["prepare", "run", "reconcile"])
      expect(f.runs.status().claim).toBeUndefined()
    })
  }
})
