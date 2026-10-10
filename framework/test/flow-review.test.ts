import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { newWorkflow, writeWorkflow, withFlowTransaction } from "../src/flow/state.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { clearReviewSession, isReviewSession, markReviewSession, parsePlanVerdict, reviewToolCapProblem, runPlanReview } from "../src/flow/review.ts"
import { createExecutionRunStore, settled } from "../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionOutcome, ExecutionReference, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import type { Plan } from "../src/flow/plan.ts"
import { tempWorktree, waitFor } from "./guards-helpers.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"
import { readLedger } from "../src/state/ledger.ts"

const S = "ses_main"
let wt: ReturnType<typeof tempWorktree>
beforeEach(() => { wt = tempWorktree() })
afterEach(() => wt.cleanup())

function wf() { return newWorkflow(S, currentOwner(), "command", "do the thing", "fixture") }
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
  reconciliation?: "terminal" | "running" | "unknown" | "throws" | "hangs"
  acknowledged?: boolean
  cancelProof?: boolean
  noVendorID?: boolean
  lateVendorID?: boolean
  preparedReference?: (executionID: string) => unknown
  prepareError?: boolean
  prepareWait?: () => Promise<void>
  ttl?: number
  model?: string
  verificationProfile?: "legacy-unowned" | "linux-single-use"
} = {}) {
  const config = { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models, ...(options.model ? { reviewer: options.model } : {}) }, delegate: { ...DEFAULT_CONFIG.delegate, review_ttl_ms: options.ttl ?? 200 } }
  const runs = createExecutionRunStore(wt.worktree)
  const policy = createExecutionPolicy(config, { directory: wt.worktree, worktree: wt.worktree })
  const calls: string[] = []
  let request: ExecutionRequest | undefined
  const runtime: ExecutionRuntime = {
    instance: "review-fixture", directory: wt.worktree, worktree: wt.worktree, stateRoot: wt.stateHome,
    config, log: () => {}, runs, policy, verificationProfile: options.verificationProfile ?? "legacy-unowned", verifier: createLegacyVerifierExecutor(),
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
        const reference: ExecutionReference = options.preparedReference
          ? options.preparedReference(value.executionID) as ExecutionReference
          : options.noVendorID ? { executionID: value.executionID }
            : { executionID: value.executionID, vendorSessionID: "review-child" }
        if (reference.vendorSessionID) policy.bindSession(reference.vendorSessionID, value.handlers, value.policy)
        return {
          reference,
          async run() {
            calls.push("run")
            const execution = runs.status().executions.find(record => record.executionId === value.executionID)
            expect(execution).toMatchObject({
              executionId: value.executionID, ownerSession: value.supervisorSessionID,
              taskId: value.taskID, attemptId: value.attemptID, generation: value.generation,
              role: value.role, cwd: value.cwd, policyID: value.policy.id, engine: "fixture",
              kind: "host", profile: "legacy-unowned", hostDispatch: "started",
              ...(reference.vendorSessionID ? { vendorRef: JSON.stringify(reference) } : {}),
            })
            expect(isReviewSession(reference.vendorSessionID ?? "review-child")).toBe(!!reference.vendorSessionID)
            if (reference.vendorSessionID) expect(policy.handlersForSession(reference.vendorSessionID)).toBe(value.handlers)
            if (options.lateVendorID) {
              const lateReference = { executionID: value.executionID, vendorSessionID: "late-review-child" }
              expect(value.onReference?.(lateReference)).toBeUndefined()
              expect(runs.status().executions.find(record => record.executionId === value.executionID)).toMatchObject({
                hostDispatch: "started", vendorRef: JSON.stringify(lateReference), boundaryRef: lateReference,
              })
              policy.bindSession(lateReference.vendorSessionID, value.handlers, value.policy)
              expect(isReviewSession(lateReference.vendorSessionID)).toBe(true)
            }
            return options.run ? options.run() : { status: "completed" as const, text: options.text ?? "VERDICT: OKAY" }
          },
          async requestCancel() {
            calls.push("cancel")
            expect(runs.status().executions.find(record => record.executionId === value.executionID)?.cancel?.requestedAt).toEqual(expect.any(Number))
            return { requested: true, acknowledged: options.acknowledged ?? true,
              terminal: options.cancelProof ?? false, quiescent: options.cancelProof ?? false,
              ...(options.cancelProof ? { evidence: "fixture observed cancellation terminal and quiescent" } : {}) }
          },
          async reconcile() {
            calls.push("reconcile")
            if (options.reconciliation === "throws") throw new Error("fixture reconciliation failed")
            if (options.reconciliation === "hangs") return await new Promise<never>(() => {})
            let outcome: "terminal" | "running" | "unknown" = "terminal"
            if (options.reconciliation === "unknown") outcome = "unknown"
            else if (options.reconciliation === "running" || (options.reconciliation === undefined && options.quiescent === false)) outcome = "running"
            return { outcome, quiescent: options.quiescent ?? (outcome === "terminal"), evidence: "fixture terminal state" }
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
  for (const verificationProfile of ["legacy-unowned", "linux-single-use"] as const) {
    test(`plan review remains a legacy-unowned host execution under ${verificationProfile} verification profile`, async () => {
      const f = fixture({ verificationProfile })
      const verdict = await runPlanReview(f.runtime, wf(), plan())
      const status = f.runs.status()
      const execution = status.executions[0]!
      expect(execution).toMatchObject({
        kind: "host",
        engine: "fixture",
        profile: "legacy-unowned",
        terminal: { outcome: "completed" },
        reconciliation: { outcome: "terminal", quiescent: true },
      })
      expect(settled(execution)).toBe(true)
      expect(status.claim).toBeUndefined()
      expect(f.calls).toEqual(["prepare", "run", "reconcile"])
      expect(verdict).toEqual({ verdict: "okay", findings: [] })
    })
  }

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

  test("execution-only learned reference is refused rather than silently ignored", async () => {
    const f = fixture()
    const prepare = f.runtime.host.prepare
    let callbackReturned = false
    let preparations = 0
    f.runtime.host.prepare = async request => {
      preparations++
      request.onReference?.({ executionID: request.executionID })
      callbackReturned = true
      return prepare(request)
    }
    expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
    expect(callbackReturned).toBe(false)
    expect(f.calls).toEqual([])
    const state = f.runs.status()
    expect(state.claim).toBeDefined()
    expect(state.executions[0]?.vendorRef).toBeUndefined()
    expect(state.executions[0]?.hostDispatch).toBeUndefined()
    expect(state.executions[0]?.terminal).toBeUndefined()
    expect(state.executions[0]?.fence).toBeDefined()
    expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
    expect(preparations).toBe(1)
  })

  test("late vendor ID is bound after durable dispatch and before the review outcome", async () => {
    const f = fixture({ noVendorID: true, lateVendorID: true })
    expect(await runPlanReview(f.runtime, wf(), plan())).toEqual({ verdict: "okay", findings: [] })
    const execution = f.runs.status().executions[0]!
    expect(f.calls).toEqual(["prepare", "run", "reconcile"])
    expect(execution).toMatchObject({
      hostDispatch: "started",
      vendorRef: JSON.stringify({ executionID: execution.executionId, vendorSessionID: "late-review-child" }),
      boundaryRef: { executionID: execution.executionId, vendorSessionID: "late-review-child" },
      terminal: { outcome: "completed" },
      reconciliation: { outcome: "terminal", quiescent: true },
    })
    expect(f.runs.status().claim).toBeUndefined()
    expect(f.policy.handlersForSession("late-review-child")).toBeUndefined()
    expect(isReviewSession("late-review-child")).toBe(false)
  })

  test("exact executionID-only prepared reference can complete with owned quiescence", async () => {
    const f = fixture({ noVendorID: true })
    expect(await runPlanReview(f.runtime, wf(), plan())).toEqual({ verdict: "okay", findings: [] })
    const execution = f.runs.status().executions[0]!
    expect(f.calls).toEqual(["prepare", "run", "reconcile"])
    expect(execution).toMatchObject({
      hostDispatch: "started", terminal: { outcome: "completed" },
      reconciliation: { outcome: "terminal", quiescent: true },
    })
    expect(execution.vendorRef).toBeUndefined()
    expect(execution.boundaryRef).toBeUndefined()
    expect(f.runs.status().claim).toBeUndefined()
    expect(f.policy.handlersForSession("review-child")).toBeUndefined()
    expect(isReviewSession("review-child")).toBe(false)
  })

  const malformed: Array<(executionID: string) => unknown> = [
    () => ({ executionID: "foreign-execution", vendorThreadID: "thread" }),
    executionID => ({ executionID, unexpected: "metadata" }),
    executionID => Object.defineProperty({ executionID }, Symbol("extra"), { value: "metadata" }),
    executionID => Object.defineProperty({ executionID }, "vendorThreadID", { value: "thread", enumerable: false }),
  ]
  for (const [index, preparedReference] of malformed.entries()) {
    test(`malformed prepared reference ${index} is fenced before run`, async () => {
      const f = fixture({ preparedReference })
      expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
      const state = f.runs.status()
      expect(f.calls).toEqual(["prepare"])
      expect(state.executions[0]).toMatchObject({ fence: { reason: "review preparation or execution failed without quiescence proof" } })
      expect(state.executions[0]?.hostDispatch).toBeUndefined()
      expect(state.executions[0]?.terminal).toBeUndefined()
      expect(state.claim).toBeDefined()
      expect(f.policy.handlersForSession("review-child")).toBeUndefined()
      expect(isReviewSession("review-child")).toBe(false)
    })
  }

  test("host dispatch marker failure fences the prepared review without invoking run", async () => {
    const f = fixture()
    f.runs.markHostDispatched = (_claim, executionID) => {
      expect(f.runs.status().executions.find(record => record.executionId === executionID)).toMatchObject({
        kind: "host", vendorRef: JSON.stringify({ executionID, vendorSessionID: "review-child" }),
      })
      throw new Error("injected host dispatch marker failure")
    }

    expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
    const state = f.runs.status()
    const execution = state.executions[0]!
    expect(f.calls).toEqual(["prepare"])
    expect(execution).toMatchObject({ kind: "host", fence: { reason: expect.any(String) } })
    expect(execution.hostDispatch).toBeUndefined()
    expect(execution.terminal).toBeUndefined()
    expect(execution.reconciliation).toBeUndefined()
    expect(state.claim).toBeDefined()
    clearReviewSession("review-child")
  })

  test("prepared abort accepts ACK-only cancellation only after terminal reconciliation", async () => {
    const f = fixture()
    const controller = new AbortController()
    const bindVendorRef = f.runs.bindVendorRef.bind(f.runs)
    f.runs.bindVendorRef = (claim, executionID, reference) => {
      bindVendorRef(claim, executionID, reference)
      controller.abort()
    }

    expect(await runPlanReview(f.runtime, wf(), plan(), controller.signal)).toMatchObject({ verdict: "none", note: "aborted" })
    const state = f.runs.status()
    expect(f.calls).toEqual(["prepare", "cancel", "reconcile"])
    expect(state.executions[0]).toMatchObject({
      vendorRef: JSON.stringify({ executionID: f.request!.executionID, vendorSessionID: "review-child" }),
      cancel: { requestedAt: expect.any(Number), acknowledgedAt: expect.any(Number) },
      reconciliation: { outcome: "terminal", quiescent: true },
    })
    expect(state.executions[0]?.terminal).toBeUndefined()
    expect(state.executions[0]?.hostDispatch).toBeUndefined()
    expect(state.claim).toBeUndefined()
    expect(f.policy.handlersForSession("review-child")).toBeUndefined()
    expect(isReviewSession("review-child")).toBe(false)
  })

  test("prepared abort accepts observed terminal and quiescent cancellation without dispatch", async () => {
    const f = fixture({ cancelProof: true })
    const controller = new AbortController()
    const bindVendorRef = f.runs.bindVendorRef.bind(f.runs)
    f.runs.bindVendorRef = (claim, executionID, reference) => {
      bindVendorRef(claim, executionID, reference)
      controller.abort()
    }

    expect(await runPlanReview(f.runtime, wf(), plan(), controller.signal)).toMatchObject({ verdict: "none", note: "aborted" })
    const state = f.runs.status()
    expect(f.calls).toEqual(["prepare", "cancel"])
    expect(state.executions[0]).toMatchObject({
      cancel: { acknowledgedAt: expect.any(Number) },
      terminal: { outcome: "cancelled", terminalAt: expect.any(Number), quiescentAt: expect.any(Number) },
    })
    expect(state.executions[0]?.hostDispatch).toBeUndefined()
    expect(state.claim).toBeUndefined()
    expect(f.policy.handlersForSession("review-child")).toBeUndefined()
    expect(isReviewSession("review-child")).toBe(false)
  })

  for (const reconciliation of ["unknown", "throws", "hangs"] as const) {
    test(`prepared abort retains review ownership when reconciliation ${reconciliation}`, async () => {
      const f = fixture({ reconciliation, quiescent: false })
      const controller = new AbortController()
      const bindVendorRef = f.runs.bindVendorRef.bind(f.runs)
      f.runs.bindVendorRef = (claim, executionID, reference) => {
        bindVendorRef(claim, executionID, reference)
        controller.abort()
      }

      expect(await runPlanReview(f.runtime, wf(), plan(), controller.signal)).toMatchObject({ verdict: "none", note: "aborted" })
      const state = f.runs.status()
      expect(f.calls).toEqual(["prepare", "cancel", "reconcile"])
      expect(state.executions[0]).toMatchObject({
        vendorRef: JSON.stringify({ executionID: f.request!.executionID, vendorSessionID: "review-child" }),
        cancel: { acknowledgedAt: expect.any(Number) },
        fence: { reason: "review cancellation ended without terminal quiescence" },
      })
      expect(state.executions[0]?.hostDispatch).toBeUndefined()
      expect(state.executions[0]?.terminal).toBeUndefined()
      expect(state.claim).toBeDefined()
      expect(f.policy.handlersForSession("review-child")).toBeDefined()
      expect(isReviewSession("review-child")).toBe(true)
      if (reconciliation === "unknown") {
        expect(state.executions[0]?.reconciliation).toMatchObject({ outcome: "unknown", quiescent: false })
      } else {
        expect(state.executions[0]?.reconciliation).toBeUndefined()
      }

      expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
      expect(f.calls).toEqual(["prepare", "cancel", "reconcile"])
      expect(f.runs.status().claim).toBeDefined()
      clearReviewSession("review-child")
      f.policy.unbindSession("review-child")
    })
  }

  test("restart with a started review and unknown reconciliation remains blocked", async () => {
    const f = fixture()
    const workflow = wf()
    const executionID = "review-restart-started"
    const old = f.runs.claim(S, "dead-owner", 99999999)
    f.runs.registerIntent(old, {
      executionId: executionID, ownerSession: S, taskId: workflow.id, attemptId: "old-attempt",
      generation: old.generation, role: "reviewer", cwd: wt.worktree, policyID: "reviewer-policy",
      kind: "host", engine: "fixture", profile: "legacy-unowned",
    })
    f.runs.bindVendorRef(old, executionID, JSON.stringify({ executionID, vendorSessionID: "old-review-child" }))
    f.runs.markHostDispatched(old, executionID)
    f.runs.fence(old, executionID, "prior review owner ended without proof")
    f.runs.reconcile(old, executionID, { outcome: "unknown", quiescent: false, evidence: "restart remains unknown" })

    expect(await runPlanReview(f.runtime, workflow, plan())).toMatchObject({ verdict: "none", note: "aborted" })
    const state = f.runs.status()
    expect(f.calls).toEqual([])
    expect(state.executions).toHaveLength(1)
    expect(state.executions[0]).toMatchObject({
      hostDispatch: "started", fence: { reason: expect.any(String) }, reconciliation: { outcome: "unknown", quiescent: false },
    })
    expect(state.executions[0]?.terminal).toBeUndefined()
    expect(state.claim).toBeDefined()
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

  test("no-ID ACK with unknown cancellation retains claim and cannot replay", async () => {
    const f = fixture({
      noVendorID: true, ttl: 5, reconciliation: "unknown",
      run: () => new Promise<ExecutionOutcome>(() => {}),
    })
    expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
    const execution = f.runs.status().executions[0]!
    expect(f.calls).toEqual(["prepare", "run", "cancel", "reconcile"])
    expect(execution).toMatchObject({
      hostDispatch: "started", cancel: { requestedAt: expect.any(Number), acknowledgedAt: expect.any(Number) },
      reconciliation: { outcome: "unknown", quiescent: false }, fence: { reason: expect.any(String) },
    })
    expect(execution.vendorRef).toBeUndefined()
    expect(execution.boundaryRef).toBeUndefined()
    expect(execution.terminal).toBeUndefined()
    expect(f.runs.status().claim).toBeDefined()
    expect(f.policy.handlersForSession("review-child")).toBeUndefined()
    expect(isReviewSession("review-child")).toBe(false)

    expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
    expect(f.calls).toEqual(["prepare", "run", "cancel", "reconcile"])
    expect(f.runs.status().claim).toBeDefined()
  })

  test("late completed text without quiescence cannot become a verdict or release ownership", async () => {
    const f = fixture({ quiescent: false, text: "VERDICT: OKAY" })
    expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
    expect(f.runs.status().executions[0]?.fence).toBeDefined()
    expect(f.runs.status().claim).toBeDefined()
    clearReviewSession("review-child")
  })

  test("quiescent flag on a running reconciliation cannot approve or release ownership", async () => {
    const f = fixture({ reconciliation: "running", quiescent: true, text: "VERDICT: OKAY" })
    expect(await runPlanReview(f.runtime, wf(), plan())).toMatchObject({ verdict: "none", note: "aborted" })
    expect(f.calls).toEqual(["prepare", "run", "reconcile"])
    expect(f.runs.status().executions[0]).toMatchObject({
      fence: { reason: "review preparation or execution failed without quiescence proof" },
    })
    expect(f.runs.status().executions[0]?.reconciliation).toBeUndefined()
    expect(f.runs.status().executions[0]?.terminal?.quiescentAt).toBeUndefined()
    expect(f.runs.status().claim).toBeDefined()
    expect(f.policy.handlersForSession("review-child")).toBeDefined()
    expect(isReviewSession("review-child")).toBe(true)
    clearReviewSession("review-child")
    f.policy.unbindSession("review-child")
  })

  test("matching persisted cancelled workflow aborts a live plan review and retains its unproven fence", async () => {
    const workflow = wf()
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, workflow))
    const f = fixture({ quiescent: false, run: () => new Promise<ExecutionOutcome>(() => {}) })
    const review = runPlanReview(f.runtime, workflow, plan())
    await waitFor(() => f.calls.includes("run"))
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, { ...workflow, phase: "cancelled" }))
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
      withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, workflow))
      let finishReview!: (outcome: ExecutionOutcome) => void
      const f = fixture({ ttl: 1000, run: () => new Promise<ExecutionOutcome>(resolve => { finishReview = resolve }) })
      const review = runPlanReview(f.runtime, workflow, plan())
      await waitFor(() => f.calls.includes("run"))
      withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, {
        ...workflow,
        ...(mismatch === "workflow" ? { id: `${workflow.id}_other` } : { sessionID: "ses_other" }),
        phase: "cancelled",
        pendingCancel: true,
      }))
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(f.calls).toEqual(["prepare", "run"])
      finishReview({ status: "completed", text: "VERDICT: OKAY" })
      expect(await review).toEqual({ verdict: "okay", findings: [] })
      expect(f.calls).toEqual(["prepare", "run", "reconcile"])
      expect(f.runs.status().claim).toBeUndefined()
    })
  }
})
