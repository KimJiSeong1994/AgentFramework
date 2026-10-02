// M1 end-to-end: /plan -> lca_flow (review) -> /approve -> delegate return -> settle, plus /reject, /cancel,
// stuck(plan_invalid) -> /reject, two-"instance" (owner field) authority scenarios, and plugin-load repair. Every
// hook is driven the way OpenCode's plugin runtime drives it: command.execute.before (createCommandHook) marks the
// turn, then chat.message does the §5.2/§5.3/§5.5 state work and rewrites the command's own text in place, the
// lca_flow tool runs the review inline, and tool.execute.after settles on delegate return.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import {
  APPROVE_COMMAND, APPROVE_TEMPLATE, CANCEL_COMMAND, CANCEL_TEMPLATE, PLAN_COMMAND, PLAN_TEMPLATE,
  REJECT_COMMAND, REJECT_TEMPLATE_PREFIX, REJECT_TEMPLATE_SUFFIX, createCommandHook,
} from "../src/hooks/command.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createToolAfterHook } from "../src/hooks/tool-after.ts"
import { createLcaFlowTool } from "../src/tools/lca-flow.ts"
import { createIdleLoop } from "../src/loop/idle.ts"
import { repairOnLoad } from "../src/flow/runtime.ts"
import { readEvents, readWorkflow, writeWorkflow, newWorkflow, planJsonPath, renderArtifact, type Workflow } from "../src/flow/state.ts"
import { currentOwner, INSTANCE_ID } from "../src/flow/owner.ts"
import { canonicalPlanSha, planMdPath, renderPlanMd, type Plan } from "../src/flow/plan.ts"
import { readLedger, tasksForWorkflow, writeLedger, addTasks } from "../src/state/ledger.ts"
import { sessionDir, writeJsonAtomic } from "../src/state/store.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
  mkdirSync(sessionDir(wt.worktree, S), { recursive: true })
})
afterEach(() => wt.cleanup())

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

function toolCtx(sessionID = S, agent = "main") {
  const ac = new AbortController()
  return { sessionID, messageID: "m1", agent, directory: wt.worktree, worktree: wt.worktree, abort: ac.signal, controller: ac, metadata: () => {}, ask: async () => {} }
}

/** Drive one flow command exactly as OpenCode would: command.execute.before marks the turn, chat.message rewrites the template. */
async function runCommand(deps: ReturnType<typeof makeDeps>, command: string, args: string, template: string, sessionID = S): Promise<string> {
  const commandHook = createCommandHook(deps, { stop: true, status: true, flow: true })
  await commandHook({ command, sessionID, arguments: args }, { parts: [] })
  const part: any = { type: "text", text: template }
  await createChatMessageHook(deps)({ sessionID, agent: "main" } as any, { message: {} as any, parts: [part] })
  return part.text as string
}

function eventTypes(worktree: string, wfId: string): string[] {
  return readEvents(worktree, wfId).map((e) => e.type)
}

describe("1) /plan -> review (ITERATE then OKAY) -> /approve -> tasks done -> delegate return settles -> done", () => {
  test("full happy path", async () => {
    const deps = makeDeps(client, wt.worktree)

    const planText = await runCommand(deps, PLAN_COMMAND, "add a widget", PLAN_TEMPLATE)
    expect(planText).toBe(`Request: add a widget\n\n${PLAN_TEMPLATE}`)
    let wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.entry).toBe("command")

    const tool = createLcaFlowTool(deps)

    // first submission: reviewer asks for changes (T4 -> reviewing -> T5 -> planning)
    client.replies.reviewer = { text: "- step 2 needs a narrower verify command\nVERDICT: ITERATE" }
    const iterateRes = (await tool.execute({ op: "plan", plan: validPlanArgs() }, toolCtx() as any)) as { output: string }
    expect(iterateRes.output).toContain("Reviewer asked for changes")
    wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.counters.review_iterations).toBe(1)

    // resubmit: reviewer okays it (T4 -> reviewing -> T7 -> pending_approval)
    client.replies.reviewer = { text: "- looks solid\nVERDICT: OKAY" }
    const okayRes = (await tool.execute({ op: "plan", plan: validPlanArgs() }, toolCtx() as any)) as { output: string }
    expect(okayRes.output).toContain("Plan saved to")
    wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("pending_approval")
    expect(wf.review?.verdict).toBe("okay")

    const approveText = await runCommand(deps, APPROVE_COMMAND, "", APPROVE_TEMPLATE)
    expect(approveText).toBe(APPROVE_TEMPLATE)
    wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("executing")
    const tagged = tasksForWorkflow(readLedger(wt.worktree, S), wf.id)
    expect(tagged.length).toBe(3)
    expect(tagged.map((t) => t.title)).toEqual(validPlanArgs().steps.map((s) => s.title))

    // mark the tagged tasks done directly in the ledger (stand-in for a completed delegate run), then let the
    // delegate return path (tool.execute.after) settle the workflow
    const ledger = readLedger(wt.worktree, S)
    writeLedger(wt.worktree, { ...ledger, tasks: ledger.tasks.map((t) => (t.wf?.id === wf.id ? { ...t, status: "done" as const } : t)) })
    const afterHook = createToolAfterHook(deps)
    await afterHook({ tool: "delegate", sessionID: S, callID: "c1", args: {} } as any, { title: "delegate", output: "ok", metadata: {} } as any)

    wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("done")

    const types = eventTypes(wt.worktree, wf.id)
    expect(types).toEqual([
      "created", "transition", // T1 -> planning
      "transition", "plan_submitted", // T4 -> reviewing (1st submission)
      "transition", // T5 -> planning (iterate)
      "transition", "plan_submitted", // T4 -> reviewing (2nd submission)
      "transition", // T7 -> pending_approval
      "transition", "approved", // T9 -> executing
      "tasks_created",
      "transition", // settle_ok -> done
    ])
  })
})

describe("2) /reject from pending_approval -> planning, counters.user_rejections", () => {
  test("reject with a reason", async () => {
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = renderArtifact(wt.worktree, mdPath, renderPlanMd("wfid", PLAN))
    const jsonSha = canonicalPlanSha(PLAN)
    const wf: Workflow = {
      ...newWorkflow(S, currentOwner(), "command", "add a widget"),
      id: "wfid",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    writeWorkflow(wt.worktree, wf)

    const deps = makeDeps(client, wt.worktree)
    const text = await runCommand(deps, REJECT_COMMAND, "needs more detail", `${REJECT_TEMPLATE_PREFIX}<reason>${REJECT_TEMPLATE_SUFFIX}`)
    expect(text).toBe(`${REJECT_TEMPLATE_PREFIX}needs more detail${REJECT_TEMPLATE_SUFFIX}`)

    const after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("planning")
    expect(after.counters.user_rejections).toBe(1)
    expect(eventTypes(wt.worktree, wf.id)).toContain("rejected")
  })
})

describe("3) /cancel in executing while the queue runs -> pendingCancel, settles to cancelled once the queue stops", () => {
  test("cancel then settle", async () => {
    const wf = { ...newWorkflow(S, currentOwner(), "command", "do the thing"), phase: "executing" as const, taskIds: ["t1"] }
    writeWorkflow(wt.worktree, wf)
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "tagged task" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, ledger)

    const deps = makeDeps(client, wt.worktree)
    const q = getQueue(deps)
    // keep the queue "running" with an unrelated blocker task until abort() unblocks it
    client.replies.worker = { text: "never", run: () => new Promise<void>(() => {}) }
    q.add(S, [{ title: "blocker" }])
    const running = q.run(S)
    while (!q.isRunning(S)) await new Promise((r) => setTimeout(r, 2))

    const cancelText = await runCommand(deps, CANCEL_COMMAND, "", CANCEL_TEMPLATE)
    expect(cancelText).toBe(CANCEL_TEMPLATE)
    let after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("executing") // T18 queueRunning=true -> pendingCancel, phase unchanged
    expect(after.pendingCancel).toBe(true)

    await running // the abort triggered by cancelWorkflow unblocks the queue run
    expect(q.isRunning(S)).toBe(false)

    await createIdleLoop(deps)(S) // settle: pendingCancel + queue stopped -> cancel_settled
    after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("cancelled")
    expect(after.pendingCancel).toBeUndefined()

    const taggedAfter = tasksForWorkflow(readLedger(wt.worktree, S), wf.id)
    expect(taggedAfter.every((t) => t.status === "cancelled")).toBe(true)
    expect(eventTypes(wt.worktree, wf.id)).toContain("transition")
  })
})

describe("4) three invalid plans -> stuck(plan_invalid) -> /reject -> planning", () => {
  test("stuck then reject", async () => {
    const deps = makeDeps(client, wt.worktree)
    await runCommand(deps, PLAN_COMMAND, "add a widget", PLAN_TEMPLATE)
    const tool = createLcaFlowTool(deps)
    const badPlan = { ...validPlanArgs(), steps: [{ title: "s1", files: ["x"], verify: "true" }] } // too few steps + trivial verify
    for (let i = 0; i < 3; i++) await tool.execute({ op: "plan", plan: badPlan }, toolCtx() as any)
    let wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("stuck")
    expect(wf.stuckCause).toBe("plan_invalid")
    expect(wf.counters.code_invalid).toBe(3)

    const text = await runCommand(deps, REJECT_COMMAND, "try again", `${REJECT_TEMPLATE_PREFIX}<reason>${REJECT_TEMPLATE_SUFFIX}`)
    expect(text).toBe(`${REJECT_TEMPLATE_PREFIX}try again${REJECT_TEMPLATE_SUFFIX}`)
    wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.counters.user_rejections).toBe(1)
    expect(wf.counters.code_invalid).toBe(0)
    expect(eventTypes(wt.worktree, wf.id)).toContain("rejected")
  })
})

describe("5) two plugin instances on one state root: a foreign LIVE session refuses /approve, no mutation", () => {
  test("live foreign owner refuses approve", async () => {
    mkdirSync(sessionDir(wt.worktree, OTHER), { recursive: true })
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = renderArtifact(wt.worktree, mdPath, renderPlanMd("wfid", PLAN))
    const jsonSha = canonicalPlanSha(PLAN)
    // a second "plugin instance" (different instance id, same live process, fresh heartbeat) owns the workflow
    const wf: Workflow = {
      ...newWorkflow(OTHER, currentOwner(Date.now(), "inst_other_B", process.pid), "command", "add a widget"),
      id: "wfid",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    writeWorkflow(wt.worktree, wf)

    const before = JSON.stringify(readWorkflow(wt.worktree))
    const deps = makeDeps(client, wt.worktree)
    const text = await runCommand(deps, APPROVE_COMMAND, "", APPROVE_TEMPLATE, S)
    expect(text).toContain(`owned by session ${OTHER}`)
    expect(JSON.stringify(readWorkflow(wt.worktree))).toBe(before)
    expect(readLedger(wt.worktree, S).tasks.length).toBe(0)
    expect(readLedger(wt.worktree, OTHER).tasks.length).toBe(0)
  })
})

describe("6) interrupted approve (tagged tasks exist, phase still pending_approval) repaired by repairOnLoad", () => {
  test("repair finishes the approve: executing + tasks_created(repair)", async () => {
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = renderArtifact(wt.worktree, mdPath, renderPlanMd("wfid", PLAN))
    const jsonSha = canonicalPlanSha(PLAN)
    const wf: Workflow = {
      ...newWorkflow(S, currentOwner(), "command", "add a widget"),
      id: "wfid",
      phase: "pending_approval", // the crash happened after the ledger write but before the phase write
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    writeWorkflow(wt.worktree, wf)
    const { ledger } = addTasks(readLedger(wt.worktree, S), validPlanArgs().steps.map((s) => ({ title: s.title })), Date.now(), { id: "wfid", planSha: jsonSha })
    writeLedger(wt.worktree, ledger)

    const deps = makeDeps(client, wt.worktree)
    const r = repairOnLoad(deps)
    expect(r?.ok).toBe(true)
    const after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("executing")
    expect(after.taskIds?.length).toBe(3)
    const repairEvent = readEvents(wt.worktree, "wfid").find((e) => e.type === "tasks_created")
    expect(repairEvent?.data?.repair).toBe(true)
  })
})

describe("7) new plugin instance, same session, dead recorded owner -> /approve succeeds after owner_takeover", () => {
  test("takeover then approve", async () => {
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = renderArtifact(wt.worktree, mdPath, renderPlanMd("wfid", PLAN))
    const jsonSha = canonicalPlanSha(PLAN)
    const wf: Workflow = {
      ...newWorkflow(S, currentOwner(), "command", "add a widget"),
      id: "wfid",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
      owner: { instance: "inst_dead_prev_run", pid: 9_999_999, heartbeatAt: 0 },
    }
    writeWorkflow(wt.worktree, wf)

    const deps = makeDeps(client, wt.worktree)
    const text = await runCommand(deps, APPROVE_COMMAND, "", APPROVE_TEMPLATE)
    expect(text).toBe(APPROVE_TEMPLATE)
    const after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("executing")
    expect(after.owner.instance).toBe(INSTANCE_ID)
    expect(after.owner.pid).toBe(process.pid)
    const types = eventTypes(wt.worktree, "wfid")
    expect(types).toContain("owner_takeover")
    expect(types).toContain("tasks_created")
  })
})

describe("prose '/approve' typed as plain user text never approves", () => {
  test("no command turn marked -> chat.message never calls approveWorkflow", async () => {
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = renderArtifact(wt.worktree, mdPath, renderPlanMd("wfid", PLAN))
    const jsonSha = canonicalPlanSha(PLAN)
    const wf: Workflow = {
      ...newWorkflow(S, currentOwner(), "command", "add a widget"),
      id: "wfid",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    writeWorkflow(wt.worktree, wf)

    const deps = makeDeps(client, wt.worktree)
    const chatHook = createChatMessageHook(deps)
    for (const text of ["/approve", "approved", "please /approve this now"]) {
      const part: any = { type: "text", text }
      await chatHook({ sessionID: S, agent: "main" } as any, { message: {} as any, parts: [part] })
    }
    expect(readWorkflow(wt.worktree)!.phase).toBe("pending_approval")
    expect(readLedger(wt.worktree, S).tasks.length).toBe(0)
  })
})
