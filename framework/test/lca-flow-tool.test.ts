// M1: the lca_flow tool — schema budget, op:"status", op:"plan" gating (T2/T3/T4) and the review it runs inline.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { createLcaFlowTool, LCA_FLOW_DESCRIPTION, lcaFlowArgs } from "../src/tools/lca-flow.ts"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { estimateToolSchemaTokens } from "../src/tokens.ts"
import {
  FlowTransactionBusyError, eventsPath, flowDir, newWorkflow, planJsonPath, readEvents, readWorkflow, sha256, workflowPath,
  writeWorkflow, withFlowTransaction,
} from "../src/flow/state.ts"
import { planMdPath } from "../src/flow/plan.ts"
import { cancelWorkflow } from "../src/flow/runtime.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { addTasks, emptyLedger, ledgerPath, updateTask, writeLedger } from "../src/state/ledger.ts"
import { executionRunDirectory, modeStatePath } from "../src/state/store.ts"
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
  const wf = { ...newWorkflow(S, currentOwner(), "command", "do the thing", "opencode"), ...patch }
  return withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf as any))
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

const SECRET_MARKERS = [
  "workflow-request-secret", "workflow-counter-secret", "task-detail-secret", "task-report-secret", "task-sql-secret",
  "task-answer-secret", "task-handoff-secret", "task-error-secret", "task-blocked-secret", "task-verify-command-secret",
  "task-verify-output-secret", "task-review-reason-secret", "task-review-session-secret",
]

function plantStatusSecrets() {
  const wf = putWorkflow({
    phase: "executing",
    request: "workflow-request-secret",
    counters: { code_invalid: 0, review_iterations: 0, user_rejections: 0, nudges: 0, private: "workflow-counter-secret" },
  })
  const created = addTasks(emptyLedger(S), [{ title: "Benign approved task", kind: "data", wf: { id: wf.id, planSha: "safe-plan-sha" } }])
  const task = created.added[0]!
  writeLedger(wt.worktree, updateTask(created.ledger, task.id, {
    status: "failed", attempts: 1, startedAt: 10, finishedAt: 20,
    detail: "task-detail-secret", report: "task-report-secret", sql: "task-sql-secret", answer: "task-answer-secret",
    handoff: "task-handoff-secret", error: "task-error-secret", blocked: "task-blocked-secret",
    verify: "task-verify-command-secret", verify_result: {
      command: "task-verify-command-secret", ok: false, exitCode: 1, timedOut: false, output: "task-verify-output-secret",
    },
    review: { verdict: "reject", reason: "task-review-reason-secret", sessionID: "task-review-session-secret", aborted: false },
    filesChanged: ["src/safe.ts"],
  }))
}

function readIfPresent(path: string) {
  try { return readFileSync(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
}

function statusInputSnapshot() {
  return [workflowPath(wt.worktree), ledgerPath(wt.worktree, S), modeStatePath(wt.worktree, S), eventsPath(wt.worktree),
    join(executionRunDirectory(wt.worktree), "state.json")].map(path => [path, readIfPresent(path)])
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

  test("valid workflow and task secrets remain absent from model-facing status output", async () => {
    plantStatusSecrets()
    const before = statusInputSnapshot()
    const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "status" }, ctx() as any)) as { output: string }
    for (const secret of SECRET_MARKERS) expect(res.output).not.toContain(secret)
    expect(res.output.split("\n").length).toBeLessThanOrEqual(25)
    expect(res.output).not.toContain('"sessions"')
    expect(res.output).not.toContain('"history"')
    expect(res.output).not.toContain('"detail"')
    expect(res.output).not.toContain('"filesChangedCount"')
    expect(statusInputSnapshot()).toEqual(before)
  })

  test("renders typed status failures without exposing state contents", async () => {
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, {
      version: 1, id: "wf_bad", kind: "plan", phase: "planning", sessionID: S, secret: "must-not-leak",
    } as any))
    const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "status" }, ctx() as any)) as { title: string; output: string }
    expect(res.title).toBe("lca_flow: status unavailable")
    expect(res.output).toContain("status unavailable: workflow invalid_state")
    expect(res.output).not.toContain("must-not-leak")
  })
})

describe('op:"plan" authority and phase gates', () => {
  for (const [label, engine] of [
    ["missing", undefined],
    ["foreign", "other-engine"],
    ["malformed", { engine: "opencode" }],
  ] as const) {
    test(`${label} workflow engine refuses plan mutation but remains observable`, async () => {
      putWorkflow({ engine })
      const before = readFileSync(workflowPath(wt.worktree))
      const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
      const result = await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx())
      expect(result).toMatchObject({ output: expect.stringContaining("engine identity") })
      expect(client.created).toEqual([])
      expect(existsSync(ledgerPath(wt.worktree, S))).toBe(false)
      expect(before.equals(readFileSync(workflowPath(wt.worktree)))).toBe(true)
      expect(await tool.execute({ op: "status" }, ctx())).toMatchObject({ output: expect.stringContaining("[lca status]") })
      expect(before.equals(readFileSync(workflowPath(wt.worktree)))).toBe(true)
    })
  }

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

describe("flow transaction consumers", () => {
  test("lca_flow refuses while the flow transaction is busy without writing artifacts or events", async () => {
    const workflow = putWorkflow({ phase: "planning" })
    const workflowBefore = readFileSync(workflowPath(wt.worktree))
    const eventsBefore = readEvents(wt.worktree, workflow.id)
    const lock = join(flowDir(wt.worktree), "workflow.lock")
    symlinkSync("held-by-another-process", lock)
    try {
      const tool = createLcaFlowTool(makeDeps(client, wt.worktree))
      await expect(tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)).rejects.toBeInstanceOf(FlowTransactionBusyError)
      expect(readFileSync(workflowPath(wt.worktree)).equals(workflowBefore)).toBe(true)
      expect(readEvents(wt.worktree, workflow.id)).toEqual(eventsBefore)
      expect(existsSync(planJsonPath(wt.worktree, workflow.id))).toBe(false)
      expect(existsSync(join(wt.worktree, planMdPath(workflow.id)))).toBe(false)
      expect(client.created).toEqual([])
    } finally {
      unlinkSync(lock)
    }
  })

  test("boundary denial stays fail-closed while busy and does not append an unauthenticated audit event", async () => {
    const workflow = putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    const hook = createToolBeforeHook(deps)
    const lock = join(flowDir(wt.worktree), "workflow.lock")
    symlinkSync("held-by-another-process", lock)
    try {
      await expect(hook(
        { tool: "write", sessionID: S, callID: "write-1" } as any,
        { args: { filePath: "new-file.ts" } } as any,
      )).rejects.toBeInstanceOf(FlowTransactionBusyError)
      expect(readEvents(wt.worktree, workflow.id).filter((event) => event.type === "boundary_denied")).toEqual([])
    } finally {
      unlinkSync(lock)
    }
  })

  test("boundary audit does not append for a foreign-engine workflow", async () => {
    const workflow = putWorkflow({ phase: "planning", engine: "foreign-engine" })
    const before = readFileSync(workflowPath(wt.worktree))
    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    const hook = createToolBeforeHook(deps)
    await expect(hook(
      { tool: "write", sessionID: S, callID: "write-foreign" } as any,
      { args: { filePath: "new-file.ts" } } as any,
    )).rejects.toThrow(/interactive mode is read-only/)
    expect(readFileSync(workflowPath(wt.worktree)).equals(before)).toBe(true)
    expect(readEvents(wt.worktree, workflow.id).filter((event) => event.type === "boundary_denied")).toEqual([])
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
  test("same-engine cancellation during review returns changed without writing stale review artifacts", async () => {
    const initial = putWorkflow({ phase: "planning" })
    let cancellationSnapshot: { workflow: Buffer; eventsSeq: number; planJson: Buffer; planMd: Buffer } | undefined
    const deps = makeDeps(client, wt.worktree)
    client.replies.reviewer = {
      text: "VERDICT: OKAY",
      run() {
        const current = readWorkflow(wt.worktree)!
        const cancelled = cancelWorkflow(getOpenCodeRuntime(deps), current, false, () => {})
        expect(cancelled.ok).toBe(true)
        const events = readEvents(wt.worktree, initial.id)
        cancellationSnapshot = {
          workflow: readFileSync(workflowPath(wt.worktree)),
          eventsSeq: Math.max(0, ...events.map((event) => event.seq)),
          planJson: readFileSync(planJsonPath(wt.worktree, initial.id)),
          planMd: readFileSync(join(wt.worktree, planMdPath(initial.id))),
        }
      },
    }
    const tool = createLcaFlowTool(deps)
    const result = await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any) as { title: string; output: string }
    expect(result.title).toBe("lca_flow: workflow changed")
    expect(cancellationSnapshot).toBeDefined()
    const snapshot = cancellationSnapshot!
    expect(readFileSync(workflowPath(wt.worktree)).equals(snapshot.workflow)).toBe(true)
    expect(readFileSync(planJsonPath(wt.worktree, initial.id)).equals(snapshot.planJson)).toBe(true)
    expect(readFileSync(join(wt.worktree, planMdPath(initial.id))).equals(snapshot.planMd)).toBe(true)
    expect(snapshot.planMd.toString("utf8")).not.toContain("verdict:")
    const laterEvents = readEvents(wt.worktree, initial.id).filter((event) => event.seq > snapshot.eventsSeq)
    expect(laterEvents).toEqual([])
  })

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
