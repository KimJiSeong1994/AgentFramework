// M1: the lca_flow tool — schema budget, op:"status", op:"plan" gating (T2/T3/T4) and the review it runs inline.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { createLcaFlowTool, LCA_FLOW_DESCRIPTION, lcaFlowArgs } from "../src/tools/lca-flow.ts"
import { estimateToolSchemaTokens } from "../src/tokens.ts"
import { newWorkflow, readWorkflow, sha256, writeWorkflow } from "../src/flow/state.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { fakeClient, makeDeps, tempGitWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempGitWorktree>
let client: FakeClient

beforeEach(() => {
  wt = tempGitWorktree()
  client = fakeClient()
})
afterEach(() => wt.cleanup())

function putWorkflow(patch: Record<string, unknown> = {}) {
  const wf = { ...newWorkflow(S, currentOwner(), "command", "do the thing"), ...patch }
  return writeWorkflow(wt.worktree, wf as any)
}

function ctx(sessionID = S, agent = "main") {
  const ac = new AbortController()
  return { sessionID, messageID: "m1", agent, directory: wt.worktree, worktree: wt.worktree, abort: ac.signal, controller: ac, metadata: () => {}, ask: async () => {} }
}

function validPlanArgs() {
  return {
    goal: "fix the bug",
    steps: [
      { title: "one", files: ["src/a.ts"], detail: "d", verify: "bun test test/a.test.ts" },
      { title: "two", files: ["src/b.ts"], detail: "d", verify: "bun test test/b.test.ts" },
      { title: "three", files: ["src/c.ts"], detail: "d", verify: "bun test test/c.test.ts" },
    ],
    risks: ["might miss an edge case"],
  }
}

describe("lca_flow schema budget", () => {
  test("description + schema <= 300 est. tokens", () => {
    const schema = z.object(lcaFlowArgs)
    const json = z.toJSONSchema(schema)
    expect(estimateToolSchemaTokens(LCA_FLOW_DESCRIPTION, json)).toBeLessThanOrEqual(300)
  })

  test("schema accepts op alone and op+plan, rejects an unknown op", () => {
    const schema = z.object(lcaFlowArgs)
    expect(schema.safeParse({ op: "status" }).success).toBe(true)
    expect(schema.safeParse({ op: "plan", plan: validPlanArgs() }).success).toBe(true)
    expect(schema.safeParse({ op: "bogus" }).success).toBe(false)
  })
})

describe('op:"status"', () => {
  test("renders the status text", async () => {
    putWorkflow({ phase: "planning" })
    const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "status" }, ctx() as any)) as { output: string }
    expect(res.output).toContain("[lca status]")
    expect(res.output).toContain("workflow:")
  })
})

describe('op:"plan" authority and phase gates', () => {
  test("a non-owning session is refused (no workflow mutation, no reviewer child)", async () => {
    putWorkflow({ phase: "planning" })
    const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx(OTHER) as any)) as { output: string }
    expect(res.output).toContain("owned by another session")
    expect(client.created.length).toBe(0)
    expect(readWorkflow(wt.worktree)!.phase).toBe("planning")
  })

  test("no active workflow is refused", async () => {
    const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)) as { output: string }
    expect(res.output).toContain("no plan workflow is active")
    expect(client.created.length).toBe(0)
  })

  test("wrong phase (not planning) is refused", async () => {
    putWorkflow({ phase: "pending_approval" })
    const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)) as { output: string }
    expect(res.output).toContain("not awaiting a plan")
    expect(client.created.length).toBe(0)
  })
})

describe('op:"plan" invalid plans (T2/T3)', () => {
  test("an invalid plan is refused, listed, and never reaches the reviewer (no child session created)", async () => {
    putWorkflow({ phase: "planning" })
    const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
    const badPlan = { ...validPlanArgs(), steps: [{ title: "s1", files: ["x"], verify: "true" }] } // too few steps + trivial verify
    const res = (await tool.execute({ op: "plan", plan: badPlan }, ctx() as any)) as { output: string }
    expect(res.output).toContain("plan rejected")
    expect(res.output).toMatch(/^lca: plan rejected/)
    expect(client.created.length).toBe(0) // reviewer never invoked
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.counters.code_invalid).toBe(1)
  })

  test("3 invalid submissions -> stuck(plan_invalid)", async () => {
    putWorkflow({ phase: "planning" })
    const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
    const badPlan = { ...validPlanArgs(), steps: [{ title: "s1", files: ["x"], verify: "true" }] }
    for (let i = 0; i < 3; i++) await tool.execute({ op: "plan", plan: badPlan }, ctx() as any)
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("stuck")
    expect(wf.stuckCause).toBe("plan_invalid")
    expect(client.created.length).toBe(0)
  })
})

describe('op:"plan" valid submission (T4 -> review -> T7/pending_approval)', () => {
  test("valid plan + OKAY review: md exists, planRef shas match the files, phase pending_approval", async () => {
    putWorkflow({ phase: "planning" })
    client.replies.reviewer = { text: "- looks solid\nVERDICT: OKAY" }
    const deps = makeDeps(client, wt.worktree)
    const tool = createLcaFlowTool(deps)
    const res = (await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)) as { output: string }
    expect(res.output).toContain("Plan saved to")
    expect(res.output).toContain("/approve or /reject")

    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("pending_approval")
    expect(wf.review?.verdict).toBe("okay")
    expect(wf.planRef).toBeDefined()

    const mdAbs = join(wt.worktree, wf.planRef!.mdPath)
    const mdText = readFileSync(mdAbs, "utf8")
    expect(sha256(mdText)).toBe(wf.planRef!.mdSha)
    expect(mdText).toContain("verdict: okay")
    expect(client.created.length).toBe(1) // exactly one reviewer child
  })

  test("valid plan + ITERATE review: back to planning with findings, no md pending_approval yet", async () => {
    putWorkflow({ phase: "planning" })
    client.replies.reviewer = { text: "- step 2 needs a narrower verify command\nVERDICT: ITERATE" }
    const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)) as { output: string }
    expect(res.output).toContain("Reviewer asked for changes")
    expect(res.output).toContain("step 2 needs a narrower verify command")
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.counters.review_iterations).toBe(1)
  })

  test("ITERATE at the cap goes to pending_approval with note 'cap'", async () => {
    putWorkflow({ phase: "planning", counters: { code_invalid: 0, review_iterations: 1, user_rejections: 0, nudges: 0 } })
    client.replies.reviewer = { text: "VERDICT: ITERATE" }
    const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
    await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("pending_approval")
    expect(wf.review?.note).toBe("cap")
  })

  test("unparseable review verdict (none) also lands in pending_approval (T7)", async () => {
    putWorkflow({ phase: "planning" })
    client.replies.reviewer = { text: "hard to say, seems okay-ish" }
    const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
    await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("pending_approval")
    expect(wf.review?.verdict).toBe("none")
  })

  test("non-main agent is refused", async () => {
    putWorkflow({ phase: "planning" })
    const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
    await expect(tool.execute({ op: "status" }, ctx(S, "worker") as any)).rejects.toThrow(/only available to the main agent/)
  })

  test("flow.enabled=false refuses the tool entirely", async () => {
    putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree, { flow: { enabled: false, max_code_invalid: 3, max_review_iterations: 2, nudge_max: 1, review_max_tool_calls: 6 } })
    const tool = createLcaFlowTool(deps)
    await expect(tool.execute({ op: "status" }, ctx() as any)).rejects.toThrow(/disabled/)
  })
})
