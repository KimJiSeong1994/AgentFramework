// M1: the otter_flow tool — schema budget, op:"status", op:"plan" gating (T2/T3/T4) and the review it runs inline.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { createOtterFlowTool, OTTER_FLOW_DESCRIPTION, otterFlowArgs } from "../src/tools/otter-flow.ts"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { estimateToolSchemaTokens } from "../src/tokens.ts"
import { FlowTransactionBusyError, eventsPath, flowDir, newWorkflow, planJsonPath, readEvents, readWorkflow, sha256, workflowPath, withFlowTransaction } from "../src/flow/state.ts"
import { writeRawSnapshot, writeWorkflow } from "./commit-fixture.ts"
import { planMdPath } from "../src/flow/plan.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { addTasks, emptyLedger, ledgerPath, updateTask, writeLedger } from "../src/state/ledger.ts"
import { executionRunDirectory, modeStatePath } from "../src/state/store.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { holdAdmission } from "../src/sessions/admission.ts"
import { createNativeToolFixture } from "./native-tool-fixture.ts"
import { admitFixtureSession, requestCancel, fakeClient, makeDeps, releaseFixtureSession, tempGitWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempGitWorktree>
let client: FakeClient
let owner: ReturnType<typeof admitFixtureSession>
let nativeCallSequence = 0

beforeEach(() => {
  wt = tempGitWorktree()
  client = fakeClient()
  owner = admitFixtureSession(makeDeps(client, wt.worktree), S)
})
afterEach(() => {
  releaseFixtureSession(wt.worktree, owner)
  wt.cleanup()
})

function putWorkflow(patch: Record<string, unknown> = {}) {
  const wf = { ...newWorkflow(S, currentOwner(Date.now(), owner.epoch), "command", "do the thing", "opencode"), ...patch }
  return withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf as any), S)
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

function primeNativeToolCall(native: Awaited<ReturnType<typeof createNativeToolFixture>>, tool: string, args: Record<string, unknown>) {
  return native.primeCall({ tool, args, callID: `otter_flow_fixture_${++nativeCallSequence}` })
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
  return [workflowPath(wt.worktree, S), ledgerPath(wt.worktree, S), modeStatePath(wt.worktree, S), eventsPath(wt.worktree, S),
    join(executionRunDirectory(wt.worktree), "state.json")].map(path => [path, readIfPresent(path)])
}

describe("otter_flow schema budget", () => {
  test("description + schema <= 300 est. tokens", () => {
    const schema = z.object(otterFlowArgs)
    const json = z.toJSONSchema(schema)
    expect(estimateToolSchemaTokens(OTTER_FLOW_DESCRIPTION, json)).toBeLessThanOrEqual(300)
  })

  test("schema accepts op alone and op+plan, rejects an unknown op", () => {
    const schema = z.object(otterFlowArgs)
    expect(schema.safeParse({ op: "status" }).success).toBe(true)
    expect(schema.safeParse({ op: "plan", plan: validPlanArgs() }).success).toBe(true)
    expect(schema.safeParse({ op: "bogus" }).success).toBe(false)
  })
})

describe('op:"status"', () => {
  test("renders the status text", async () => {
    putWorkflow({ phase: "planning" })
    const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "status" }, ctx() as any)) as { output: string }
    expect(res.output).toContain("[otter status]")
    expect(res.output).toContain("workflow:")
  })

  test("valid workflow and task secrets remain absent from model-facing status output", async () => {
    plantStatusSecrets()
    const before = statusInputSnapshot()
    const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
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
    // Index-bound snapshot whose bytes hash correctly but fail strict parsing: status reports invalid_state only.
    writeRawSnapshot(wt.worktree, { version: 2, id: "wf_bad", kind: "plan", phase: "planning", sessionID: S, secret: "must-not-leak" }, { id: "wf_bad", sessionID: S })
    const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "status" }, ctx() as any)) as { title: string; output: string }
    expect(res.title).toBe("otter_flow: status unavailable")
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
      const before = readFileSync(workflowPath(wt.worktree, S))
      const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
      const result = await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx())
      expect(result).toMatchObject({ output: expect.stringContaining("engine identity") })
      expect(client.created).toEqual([])
      expect(existsSync(ledgerPath(wt.worktree, S))).toBe(false)
      expect(before.equals(readFileSync(workflowPath(wt.worktree, S)))).toBe(true)
      expect(await tool.execute({ op: "status" }, ctx())).toMatchObject({ output: expect.stringContaining("[otter status]") })
      expect(before.equals(readFileSync(workflowPath(wt.worktree, S)))).toBe(true)
    })
  }

  test("a non-owning session is refused (no workflow mutation, no reviewer child)", async () => {
    putWorkflow({ phase: "planning" })
    const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx(OTHER) as any)) as { output: string }
    expect(res.output).toContain("no plan workflow is active in this session")
    expect(client.created.length).toBe(0)
    expect(readWorkflow(wt.worktree, S)!.phase).toBe("planning")
  })

  test("no active workflow is refused", async () => {
    const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)) as { output: string }
    expect(res.output).toContain("no plan workflow is active")
    expect(client.created.length).toBe(0)
  })

  test("wrong phase (not planning) is refused", async () => {
    putWorkflow({ phase: "pending_approval" })
    const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)) as { output: string }
    expect(res.output).toContain("not awaiting a plan")
    expect(client.created.length).toBe(0)
  })
})

describe("flow transaction consumers", () => {
  test("a held owner cannot submit a plan or create review artifacts", async () => {
    const workflow = putWorkflow({ phase: "planning" })
    holdAdmission(wt.worktree, S, "test-held")
    const before = readFileSync(workflowPath(wt.worktree, S))
    const events = readEvents(wt.worktree, workflow.id, S)
    const result = await createOtterFlowTool(makeDeps(client, wt.worktree)).execute(
      { op: "plan", plan: validPlanArgs() }, ctx() as any,
    ) as { output: string }
    expect(result.output).toContain("held")
    expect(readFileSync(workflowPath(wt.worktree, S))).toEqual(before)
    expect(readEvents(wt.worktree, workflow.id, S)).toEqual(events)
    expect(existsSync(planJsonPath(wt.worktree, workflow.id, S))).toBe(false)
    expect(existsSync(join(wt.worktree, planMdPath(workflow.id)))).toBe(false)
    expect(client.created).toEqual([])
  })

  test("otter_flow refuses while the flow transaction is busy without writing artifacts or events", async () => {
    const workflow = putWorkflow({ phase: "planning" })
    const workflowBefore = readFileSync(workflowPath(wt.worktree, S))
    const eventsBefore = readEvents(wt.worktree, workflow.id, S)
    const lock = join(flowDir(wt.worktree, S), "workflow.lock")
    symlinkSync("held-by-another-process", lock)
    try {
      const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
      await expect(tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)).rejects.toBeInstanceOf(FlowTransactionBusyError)
      expect(readFileSync(workflowPath(wt.worktree, S)).equals(workflowBefore)).toBe(true)
      expect(readEvents(wt.worktree, workflow.id, S)).toEqual(eventsBefore)
      expect(existsSync(planJsonPath(wt.worktree, workflow.id, S))).toBe(false)
      expect(existsSync(join(wt.worktree, planMdPath(workflow.id)))).toBe(false)
      expect(client.created).toEqual([])
    } finally {
      unlinkSync(lock)
    }
  })

  test("boundary denial stays fail-closed while busy and does not append an unauthenticated audit event", async () => {
    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    const native = await createNativeToolFixture(deps, { sessionID: S })
    await native.acceptUserTurn()
    const workflow = putWorkflow({ phase: "planning" })
    const hook = createToolBeforeHook(deps)
    const lock = join(flowDir(wt.worktree, S), "workflow.lock")
    symlinkSync("held-by-another-process", lock)
    try {
      const call = primeNativeToolCall(native, "delegate", { tasks: [] })
      await expect(hook(call.input, call.output)).rejects.toBeInstanceOf(FlowTransactionBusyError)
      expect(readEvents(wt.worktree, workflow.id, S).filter((event) => event.type === "boundary_denied")).toEqual([])
    } finally {
      unlinkSync(lock)
    }
  })

  test("boundary audit does not append for a foreign-engine workflow", async () => {
    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    const native = await createNativeToolFixture(deps, { sessionID: S })
    const workflow = putWorkflow({ phase: "planning", engine: "foreign-engine" })
    const before = readFileSync(workflowPath(wt.worktree, S))
    // A foreign engine voids admission: no fresh native turn is accepted, so no call can be minted.
    await native.deliverUserTurn()
    expect(() => primeNativeToolCall(native, "delegate", { tasks: [] })).toThrow(/accept a native user turn/)
    const hook = createToolBeforeHook(deps)
    await expect(hook({ tool: "delegate", sessionID: S, callID: "foreign_engine_unminted" }, { args: { tasks: [] } })).rejects.toThrow(
      "otter: OpenCode tool call refused (stale-turn)",
    )
    expect(readFileSync(workflowPath(wt.worktree, S)).equals(before)).toBe(true)
    expect(readEvents(wt.worktree, workflow.id, S).filter((event) => event.type === "boundary_denied")).toEqual([])
  })
})

describe('op:"plan" invalid plans (T2/T3)', () => {
  test("an invalid plan is refused, listed, and never reaches the reviewer (no child session created)", async () => {
    putWorkflow({ phase: "planning" })
    const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
    const badPlan = { ...validPlanArgs(), steps: [{ title: "s1", files: ["x"], verify: "true" }] } // too few steps + trivial verify
    const res = (await tool.execute({ op: "plan", plan: badPlan }, ctx() as any)) as { output: string }
    expect(res.output).toContain("plan rejected")
    expect(res.output).toMatch(/^otter: plan rejected/)
    expect(client.created.length).toBe(0) // reviewer never invoked
    const wf = readWorkflow(wt.worktree, S)!
    expect(wf.phase).toBe("planning")
    expect(wf.counters.code_invalid).toBe(1)
  })

  test("3 invalid submissions -> stuck(plan_invalid)", async () => {
    putWorkflow({ phase: "planning" })
    const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
    const badPlan = { ...validPlanArgs(), steps: [{ title: "s1", files: ["x"], verify: "true" }] }
    for (let i = 0; i < 3; i++) await tool.execute({ op: "plan", plan: badPlan }, ctx() as any)
    const wf = readWorkflow(wt.worktree, S)!
    expect(wf.phase).toBe("stuck")
    expect(wf.stuckCause).toBe("plan_invalid")
    expect(client.created.length).toBe(0)
  })
})

describe('op:"plan" valid submission (T4 -> review -> T7/pending_approval)', () => {
  test("review completion cannot change workflow or plan bytes after the owner is held", async () => {
    const initial = putWorkflow({ phase: "planning" })
    let snapshot: { workflow: Buffer; markdown: Buffer; events: ReturnType<typeof readEvents> } | undefined
    client.replies.reviewer = {
      text: "VERDICT: OKAY",
      run() {
        holdAdmission(wt.worktree, S, "review-owner-held")
        snapshot = {
          workflow: readFileSync(workflowPath(wt.worktree, S)),
          markdown: readFileSync(join(wt.worktree, planMdPath(initial.id))),
          events: readEvents(wt.worktree, initial.id, S),
        }
      },
    }
    const result = await createOtterFlowTool(makeDeps(client, wt.worktree)).execute(
      { op: "plan", plan: validPlanArgs() }, ctx() as any,
    ) as { output: string }
    expect(snapshot).toBeDefined()
    expect(result.output).toContain("held")
    expect(readFileSync(workflowPath(wt.worktree, S)).equals(snapshot!.workflow)).toBe(true)
    expect(readFileSync(join(wt.worktree, planMdPath(initial.id))).equals(snapshot!.markdown)).toBe(true)
    expect(readEvents(wt.worktree, initial.id, S)).toEqual(snapshot!.events)
    expect(readWorkflow(wt.worktree, S)?.phase).toBe("reviewing")
  })

  test("same-engine cancellation during review returns changed without writing stale review artifacts", async () => {
    const initial = putWorkflow({ phase: "planning" })
    let cancellationSnapshot: { workflow: Buffer; eventsSeq: number; planJson: Buffer; planMd: Buffer } | undefined
    const deps = makeDeps(client, wt.worktree)
    client.replies.reviewer = {
      text: "VERDICT: OKAY",
      run() {
        const current = readWorkflow(wt.worktree, S)!
        const cancelled = requestCancel(deps, current).result
        expect(cancelled.ok).toBe(true)
        const events = readEvents(wt.worktree, initial.id, S)
        cancellationSnapshot = {
          workflow: readFileSync(workflowPath(wt.worktree, S)),
          eventsSeq: Math.max(0, ...events.map((event) => event.seq)),
          planJson: readFileSync(planJsonPath(wt.worktree, initial.id, S)),
          planMd: readFileSync(join(wt.worktree, planMdPath(initial.id))),
        }
      },
    }
    const tool = createOtterFlowTool(deps)
    const result = await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any) as { title: string; output: string }
    expect(result.title).toBe("otter_flow: workflow changed")
    expect(cancellationSnapshot).toBeDefined()
    const snapshot = cancellationSnapshot!
    // The cancel was pending while the review ran; the otter_flow finally-observer then commits only cancel_settled.
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "cancelled", stopIntent: null })
    expect(readFileSync(planJsonPath(wt.worktree, initial.id, S)).equals(snapshot.planJson)).toBe(true)
    expect(readFileSync(join(wt.worktree, planMdPath(initial.id))).equals(snapshot.planMd)).toBe(true)
    expect(snapshot.planMd.toString("utf8")).not.toContain("verdict:")
    const laterEvents = readEvents(wt.worktree, initial.id, S).filter((event) => event.seq > snapshot.eventsSeq)
    expect(laterEvents.length).toBeGreaterThan(0)
    for (const event of laterEvents) expect(["transition", "cancel_settled"]).toContain(event.type)
    expect(laterEvents.some(event => event.type === "transition" && ["review_okay", "review_none", "review_iterate", "review_aborted"].includes(String(event.data?.event)))).toBe(false)
  })

  test("valid plan + OKAY review: md exists, planRef shas match the files, phase pending_approval", async () => {
    putWorkflow({ phase: "planning" })
    client.replies.reviewer = { text: "- looks solid\nVERDICT: OKAY" }
    const deps = makeDeps(client, wt.worktree)
    const tool = createOtterFlowTool(deps)
    const res = (await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)) as { output: string }
    expect(res.output).toContain("Plan saved to")
    expect(res.output).toContain("/approve or /reject")

    const wf = readWorkflow(wt.worktree, S)!
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
    const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
    const res = (await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)) as { output: string }
    expect(res.output).toContain("Reviewer asked for changes")
    expect(res.output).toContain("step 2 needs a narrower verify command")
    const wf = readWorkflow(wt.worktree, S)!
    expect(wf.phase).toBe("planning")
    expect(wf.counters.review_iterations).toBe(1)
  })

  test("ITERATE at the cap goes to pending_approval with note 'cap'", async () => {
    putWorkflow({ phase: "planning", counters: { code_invalid: 0, review_iterations: 1, user_rejections: 0, nudges: 0 } })
    client.replies.reviewer = { text: "VERDICT: ITERATE" }
    const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
    await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)
    const wf = readWorkflow(wt.worktree, S)!
    expect(wf.phase).toBe("pending_approval")
    expect(wf.review?.note).toBe("cap")
  })

  test("unparseable review verdict (none) also lands in pending_approval (T7)", async () => {
    putWorkflow({ phase: "planning" })
    client.replies.reviewer = { text: "hard to say, seems okay-ish" }
    const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
    await tool.execute({ op: "plan", plan: validPlanArgs() }, ctx() as any)
    const wf = readWorkflow(wt.worktree, S)!
    expect(wf.phase).toBe("pending_approval")
    expect(wf.review?.verdict).toBe("none")
  })

  test("non-main agent is refused", async () => {
    putWorkflow({ phase: "planning" })
    const tool = createOtterFlowTool(makeDeps(client, wt.worktree))
    await expect(tool.execute({ op: "status" }, ctx(S, "worker") as any)).rejects.toThrow(/only available to the main agent/)
  })

  test("flow.enabled=false refuses the tool entirely", async () => {
    putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree, { flow: { enabled: false, max_code_invalid: 3, max_review_iterations: 2, nudge_max: 1, review_max_tool_calls: 6 } })
    const tool = createOtterFlowTool(deps)
    await expect(tool.execute({ op: "status" }, ctx() as any)).rejects.toThrow(/disabled/)
  })
})
