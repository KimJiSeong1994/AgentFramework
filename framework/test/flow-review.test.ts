// M1: advisory plan review (flow/review.ts) — verdict aliases, caps, ttl abort, refusal while the queue runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { getQueue } from "../src/orchestration/queue.ts"
import { newWorkflow } from "../src/flow/state.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { clearReviewSession, isReviewSession, markReviewSession, parsePlanVerdict, reviewToolCapProblem, runPlanReview, type PlanReviewResult } from "../src/flow/review.ts"
import type { Plan } from "../src/flow/plan.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
})
afterEach(() => wt.cleanup())

function wf() {
  return newWorkflow(S, currentOwner(), "command", "do the thing")
}

function plan(): Plan {
  return {
    goal: "fix the bug",
    steps: [
      { title: "one", files: ["src/a.ts"], detail: "d", verify: "bun test test/a.test.ts" },
      { title: "two", files: ["src/b.ts"], detail: "d", verify: "bun test test/b.test.ts" },
      { title: "three", files: ["src/c.ts"], detail: "d", verify: "bun test test/c.test.ts" },
    ],
    risks: ["might miss an edge case"],
    revision: 1,
  }
}

describe("parsePlanVerdict aliases", () => {
  test("OKAY -> okay", () => {
    expect(parsePlanVerdict("looks fine\nVERDICT: OKAY").verdict).toBe("okay")
  })
  test("ACCEPT alias -> okay", () => {
    expect(parsePlanVerdict("VERDICT: ACCEPT").verdict).toBe("okay")
  })
  test("ACCEPTED alias -> okay", () => {
    expect(parsePlanVerdict("VERDICT: ACCEPTED").verdict).toBe("okay")
  })
  test("승인 alias -> okay", () => {
    expect(parsePlanVerdict("VERDICT: 승인").verdict).toBe("okay")
  })
  test("ITERATE -> iterate", () => {
    expect(parsePlanVerdict("- step 2 is vague\nVERDICT: ITERATE").verdict).toBe("iterate")
  })
  test("REJECT alias -> iterate", () => {
    expect(parsePlanVerdict("VERDICT: REJECT").verdict).toBe("iterate")
  })
  test("REJECTED alias -> iterate", () => {
    expect(parsePlanVerdict("VERDICT: REJECTED").verdict).toBe("iterate")
  })
  test("거부 alias -> iterate", () => {
    expect(parsePlanVerdict("VERDICT: 거부").verdict).toBe("iterate")
  })
  test("unparseable text -> none", () => {
    expect(parsePlanVerdict("this plan seems fine to me, ship it").verdict).toBe("none")
  })
  test("findings capped at 5, non-dash lines ignored", () => {
    const text = ["- a", "- b", "- c", "- d", "- e", "- f", "not a finding", "VERDICT: ITERATE"].join("\n")
    const r = parsePlanVerdict(text)
    expect(r.findings).toEqual(["a", "b", "c", "d", "e"])
    expect(r.verdict).toBe("iterate")
  })
})

describe("reviewToolCapProblem", () => {
  test("allows up to the cap, then refuses with the fixed text", () => {
    const sid = "child_x"
    markReviewSession(sid)
    expect(isReviewSession(sid)).toBe(true)
    for (let i = 0; i < 6; i++) expect(reviewToolCapProblem(sid, 6)).toBeNull()
    expect(reviewToolCapProblem(sid, 6)).toBe("give your verdict now")
    clearReviewSession(sid)
    expect(isReviewSession(sid)).toBe(false)
  })
})

describe("runPlanReview", () => {
  test("OKAY -> verdict okay, no note", async () => {
    client.replies.reviewer = { text: "- solid plan\nVERDICT: OKAY" }
    const r = await runPlanReview(makeDeps(client, wt.worktree), wf(), plan())
    expect(r.verdict).toBe("okay")
    expect(r.note).toBeUndefined()
    expect(r.findings).toEqual(["solid plan"])
  })

  test("ITERATE -> verdict iterate with findings", async () => {
    client.replies.reviewer = { text: "- step 2 needs a verify command\nVERDICT: ITERATE" }
    const r = await runPlanReview(makeDeps(client, wt.worktree), wf(), plan())
    expect(r.verdict).toBe("iterate")
    expect(r.findings).toEqual(["step 2 needs a verify command"])
  })

  test("unparseable reviewer text -> verdict none, no note", async () => {
    client.replies.reviewer = { text: "looks okay I guess" }
    const r = await runPlanReview(makeDeps(client, wt.worktree), wf(), plan())
    expect(r.verdict).toBe("none")
    expect(r.note).toBeUndefined()
  })

  test("the child sees the reviewer agent, tool deny and the rendered plan (capped) in its user message", async () => {
    let seenAgent = ""
    let seenText = ""
    client.replies.reviewer = (o: any) => {
      seenAgent = o.body.agent
      seenText = o.body.parts[0].text
      return { text: "VERDICT: OKAY" }
    }
    await runPlanReview(makeDeps(client, wt.worktree), wf(), plan())
    expect(seenAgent).toBe("reviewer")
    expect(seenText).toContain("Goal:")
    expect(seenText).toContain("VERDICT: OKAY\nor\nVERDICT: ITERATE")
    expect(client.created[0]!.parentID).toBe(S)
    expect(client.calls.find((c) => c.method === "prompt")).toBeDefined()
    const promptCall = client.calls.find((c) => c.method === "prompt")!.args as any
    expect(promptCall.body.tools).toBeDefined()
  })

  test("a ttl timeout aborts the child and returns note 'aborted' (T8)", async () => {
    client.replies.reviewer = { text: "VERDICT: OKAY", delayMs: 50 }
    const deps = makeDeps(client, wt.worktree, { delegate: { review_ttl_ms: 5 } as any })
    const r = await runPlanReview(deps, wf(), plan())
    expect(r.verdict).toBe("none")
    expect(r.note).toBe("aborted")
    expect(client.calls.some((c) => c.method === "abort")).toBe(true)
  })

  test("session.create failure -> note 'aborted', no prompt sent", async () => {
    client.createError = { name: "SomeError" }
    const r = await runPlanReview(makeDeps(client, wt.worktree), wf(), plan())
    expect(r.verdict).toBe("none")
    expect(r.note).toBe("aborted")
    expect(client.calls.some((c) => c.method === "prompt")).toBe(false)
  })

  test("refused (verdict none, no child created) while the owning session's queue is running", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false } as any })
    const q = getQueue(deps)
    let started = false
    client.replies.worker = {
      text: "ok",
      run: () => {
        started = true
        return new Promise<void>(() => {}) // never resolves: queue stays "running"
      },
    }
    q.add(S, [{ title: "a task" }])
    const runPromise = q.run(S)
    while (!started) await new Promise((r) => setTimeout(r, 5))
    expect(q.isRunning(S)).toBe(true)
    const createdBefore = client.created.length

    const r = await runPlanReview(deps, wf(), plan())
    expect(r).toEqual({ verdict: "none", findings: [] })
    expect(client.created.length).toBe(createdBefore)

    await q.abort(S, "test cleanup")
    await runPromise
  })
})
