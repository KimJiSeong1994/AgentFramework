// M1 end-to-end: /plan -> lca_flow (review) -> /approve -> delegate return -> settle, plus /reject, /cancel,
// stuck(plan_invalid) -> /reject, foreign-session authority, and held restore/repair scenarios. Every
// hook is driven the way OpenCode's plugin runtime drives it: command.execute.before (createCommandHook) marks the
// turn, then chat.message does the §5.2/§5.3/§5.5 state work and rewrites the command's own text in place, the
// lca_flow tool runs the review inline, and tool.execute.after settles on delegate return.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  APPROVE_COMMAND, APPROVE_TEMPLATE, CANCEL_COMMAND, CANCEL_TEMPLATE, PLAN_COMMAND, PLAN_TEMPLATE,
  REJECT_COMMAND, REJECT_TEMPLATE_PREFIX, REJECT_TEMPLATE_SUFFIX, createCommandHook,
} from "../src/hooks/command.ts"
import { consumeCommandTurn } from "../src/hooks/command-turns.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createConfigHook } from "../src/hooks/config.ts"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { LcaPlugin } from "../src/index.ts"
import { createToolAfterHook } from "../src/hooks/tool-after.ts"
import { createLcaFlowTool } from "../src/tools/lca-flow.ts"
import { createIdleLoop } from "../src/loop/idle.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { repairOnLoad } from "../src/flow/runtime.ts"
import { createDelegateTool } from "../src/tools/delegate.ts"
import { readEvents, readWorkflow, newWorkflow, planJsonPath, renderArtifact, workflowPath, type Workflow, withFlowTransaction } from "../src/flow/state.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { canonicalPlanSha, planMdPath, renderPlanMd, type Plan } from "../src/flow/plan.ts"
import { ledgerPath, readLedger, tasksForWorkflow, writeLedger, addTasks } from "../src/state/ledger.ts"
import { attachAdmission, effectiveHold, resumeAdmission } from "../src/sessions/admission.ts"
import { writeJsonAtomic } from "../src/state/store.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { createTaskWorktree, taskWorktreeOwner } from "../src/orchestration/worktree.ts"
import { createBoundNativeToolChildFixture, createNativeToolFixture, type NativeToolFixture } from "./native-tool-fixture.ts"
import { admitFixtureSession, fakeClient, makeDeps, releaseFixtureSession, tempGitWorktree, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient
let messageSequence = 0
let fixtureSession: ReturnType<typeof admitFixtureSession>
let additionalFixtureSessions: Array<ReturnType<typeof admitFixtureSession>>

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
  fixtureSession = admitFixtureSession(makeDeps(client, wt.worktree), S)
  additionalFixtureSessions = []
})
afterEach(() => {
  for (const store of additionalFixtureSessions) releaseFixtureSession(wt.worktree, store)
  releaseFixtureSession(wt.worktree, fixtureSession)
  wt.cleanup()
})

function validPlanArgs() {
  return {
    goal: "fix the bug",
    steps: [
      { title: "one", files: ["src/a.ts"], detail: "d", verify: "sh verify-a.test.sh" },
      { title: "two", files: ["src/b.ts"], detail: "d", verify: "sh verify-b.test.sh" },
      { title: "three", files: ["src/c.ts"], detail: "d", verify: "sh verify-c.test.sh" },
    ],
    risks: ["might miss an edge case"],
  }
}

function toolCtx(sessionID = S, agent = "main") {
  const ac = new AbortController()
  return { sessionID, messageID: "m1", agent, directory: wt.worktree, worktree: wt.worktree, abort: ac.signal, controller: ac, metadata: () => {}, ask: async () => {} }
}

/** Drive one flow command exactly as OpenCode would: command.execute.before marks the turn, chat.message rewrites the template. */
async function runCommandTurn(deps: ReturnType<typeof makeDeps>, command: string, args: string, template: string, sessionID = S): Promise<{ text: string; native: NativeToolFixture }> {
  const hostConfig: any = {}
  await createConfigHook(deps)(hostConfig)
  if (!hostConfig.command?.[command]) throw new Error(`/${command} was not injected by createConfigHook`)
  const commandHook = createCommandHook(deps, { stop: true, status: true, flow: true })
  await commandHook({ command, sessionID, arguments: args }, { parts: [] })
  const messageID = `message_${++messageSequence}_${command}_${sessionID}`
  const native = await createNativeToolFixture(deps, { sessionID })
  const turn = await native.deliverUserTurn({ messageID, text: template })
  const part = turn.parts.find((candidate) => candidate.type === "text")
  if (!part || part.type !== "text") throw new Error("native command turn did not return a text part")
  return { text: part.text, native }
}

async function runCommand(deps: ReturnType<typeof makeDeps>, command: string, args: string, template: string, sessionID = S): Promise<string> {
  return (await runCommandTurn(deps, command, args, template, sessionID)).text
}

async function runUserTurn(
  deps: ReturnType<typeof makeDeps>,
  text: string,
  options: { id?: string; sessionID?: string } = {},
): Promise<{ part: { text: string }; native: NativeToolFixture }> {
  const id = options.id ?? `interactive_${++messageSequence}`
  const sessionID = options.sessionID ?? S
  const native = await createNativeToolFixture(deps, { sessionID })
  const turn = await native.deliverUserTurn({ messageID: id, text })
  const part = turn.parts.find((candidate) => candidate.type === "text")
  if (!part || part.type !== "text") throw new Error("native user turn did not return a text part")
  return { part, native }
}

let nativeCallSequence = 0

function primeCall(native: NativeToolFixture, tool: string, args: Record<string, unknown>) {
  return native.primeCall({ tool, args, callID: `flow_integration_fixture_${++nativeCallSequence}` })
}

function eventTypes(worktree: string, wfId: string): string[] {
  return readEvents(worktree, wfId).map((e) => e.type)
}

for (const [label, engine] of [
  ["missing", undefined],
  ["foreign", "other-engine"],
  ["malformed", { engine: "opencode" }],
] as const) {
  test(`${label} workflow engine prevents plugin repair and typed command mutations`, async () => {
    const wf = withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, {
      ...newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "command", "preserve workflow", "opencode"),
      engine, phase: "reviewing",
    }))
    const before = readFileSync(workflowPath(wt.worktree))
    const deps = makeDeps(client, wt.worktree)
    await LcaPlugin({
      client: deps.client, directory: wt.worktree, worktree: wt.worktree,
      project: { id: "fixture", worktree: wt.worktree, time: { created: 0 } },
      serverUrl: new URL("http://127.0.0.1:1"),
      experimental_workspace: { register() { throw new Error("unexpected workspace registration") } },
      $,
    })
    expect(before.equals(readFileSync(workflowPath(wt.worktree)))).toBe(true)
    for (const [command, args, template] of [
      [PLAN_COMMAND, "new plan", PLAN_TEMPLATE],
      [APPROVE_COMMAND, "", APPROVE_TEMPLATE],
      [REJECT_COMMAND, "change it", `${REJECT_TEMPLATE_PREFIX}change it${REJECT_TEMPLATE_SUFFIX}`],
      [CANCEL_COMMAND, "", CANCEL_TEMPLATE],
    ] as const) {
      expect(await runCommand(deps, command, args, template)).toContain("LCA session held")
      expect(before.equals(readFileSync(workflowPath(wt.worktree)))).toBe(true)
    }
    expect(eventTypes(wt.worktree, wf.id)).toEqual([])
    expect(existsSync(ledgerPath(wt.worktree, S))).toBe(false)
    expect(client.created).toEqual([])
  })
}

describe("1) /plan -> review (ITERATE then OKAY) -> /approve -> tasks done -> delegate return settles -> done", () => {
  test("full happy path", async () => {
    releaseFixtureSession(wt.worktree, fixtureSession)
    wt.cleanup()
    wt = tempGitWorktree({
      "verify-a.test.sh": "test -s src/a.ts",
      "verify-b.test.sh": "test -s src/b.ts",
      "verify-c.test.sh": "test -s src/c.ts",
    })
    client = fakeClient()
    fixtureSession = admitFixtureSession(makeDeps(client, wt.worktree), S)
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

    const approveTurn = await runCommandTurn(deps, APPROVE_COMMAND, "", APPROVE_TEMPLATE)
    expect(approveTurn.text).toBe(APPROVE_TEMPLATE)
    wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("executing")
    const tagged = tasksForWorkflow(readLedger(wt.worktree, S), wf.id)
    expect(tagged.length).toBe(3)
    expect(tagged.map((t) => t.title)).toEqual(validPlanArgs().steps.map((s) => s.title))

    client.replies.worker = (_request, nth) => ({
      text: "Implemented the requested change.",
      run: async () => {
        const file = ["src/a.ts", "src/b.ts", "src/c.ts"][nth - 1]!
        mkdirSync(join(wt.worktree, file.slice(0, file.lastIndexOf("/"))), { recursive: true })
        writeFileSync(join(wt.worktree, file), `export const ${String.fromCharCode(96 + nth)} = ${nth};\n`)
      },
    })
    client.replies.reviewer = { text: "The diff and verification are acceptable.\nACCEPT" }
    const delegateCall = primeCall(approveTurn.native, "delegate", { resume: true })
    await createToolBeforeHook(deps)(delegateCall.input, delegateCall.output)
    const delegated = await createDelegateTool(deps).execute({ resume: true }, toolCtx() as any) as { title: string }
    expect(delegated.title).toBe("delegate: 3/3 done")

    // Settle through the real delegate return hook, not a synthetic ledger mutation.
    const afterHook = createToolAfterHook(deps)
    await afterHook(delegateCall.input, { title: "delegate", output: "ok", metadata: {} })

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
  }, 10_000) // Includes real Git snapshots and three shell verifications; not a latency benchmark.
})

describe("2) /reject from pending_approval -> planning, counters.user_rejections", () => {
  test("reject with a reason", async () => {
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = withFlowTransaction(wt.worktree, flowTx => renderArtifact(flowTx, mdPath, renderPlanMd("wfid", PLAN)))
    const jsonSha = canonicalPlanSha(PLAN)
    const wf: Workflow = {
      ...newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "command", "add a widget", "opencode"),
      id: "wfid",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf))

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
    releaseFixtureSession(wt.worktree, fixtureSession)
    wt.cleanup()
    wt = tempGitWorktree()
    client = fakeClient({ promptAsync: true })
    fixtureSession = admitFixtureSession(makeDeps(client, wt.worktree), S)
    const wf = { ...newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "command", "do the thing", "opencode"), phase: "executing" as const, taskIds: ["t1"] }
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf))
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "tagged task" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, ledger)

    const deps = makeDeps(client, wt.worktree)
    const q = getQueue(getOpenCodeRuntime(deps))
    // keep the queue "running" with an unrelated blocker task until abort() unblocks it
    client.replies.worker = { text: "never", run: () => new Promise<void>(() => {}) }
    q.add(S, [{ title: "blocker" }])
    const running = q.run(S)
    while (!q.isRunning(S)) await new Promise((r) => setTimeout(r, 2))
    // cancel only after the worker prompt is truly in flight so abort reaches a dispatched child
    while (client.inflight.size === 0) await new Promise((r) => setTimeout(r, 2))

    // /cancel with a running queue makes the admission non-current (pendingCancel). Drive the real command and chat hooks
    // directly: the fixture's post-turn capture probe would otherwise hold the (correctly cancelling) session.
    const nativeMain = await createNativeToolFixture(deps, { sessionID: S })
    await createCommandHook(deps, { stop: true, status: true, flow: true })({ command: CANCEL_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    const cancelMessageID = `message_${++messageSequence}_cancel_${S}`
    const cancelMessage = { id: cancelMessageID, sessionID: S, role: "user", time: { created: Date.now() }, agent: "main", model: { providerID: "fixture", modelID: "native-tool-fixture" } }
    const cancelPart = { id: `part_${cancelMessageID}`, sessionID: S, messageID: cancelMessageID, type: "text", text: CANCEL_TEMPLATE }
    await createChatMessageHook(deps)({ sessionID: S, agent: "main", model: { providerID: "fixture", modelID: "native-tool-fixture" } } as never, { message: cancelMessage, parts: [cancelPart] } as never)
    expect(nativeMain.sessionID).toBe(S)
    expect(cancelPart.text).toBe(CANCEL_TEMPLATE)
    let after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("executing") // T18 queueRunning=true -> pendingCancel, phase unchanged
    expect(after.stopIntent?.kind).toBe("cancel")

    await running // the abort triggered by cancelWorkflow unblocks the queue run
    expect(q.isRunning(S)).toBe(false)

    await createIdleLoop(deps)(S) // settle: pendingCancel + queue stopped -> cancel_settled
    after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("cancelled")
    expect(after.stopIntent).toBeNull()

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

describe("5) a foreign LIVE session refuses /approve without mutation", () => {
  test("live foreign owner refuses approve", async () => {
    const deps = makeDeps(client, wt.worktree)
    const otherSession = admitFixtureSession(deps, OTHER)
    additionalFixtureSessions.push(otherSession)
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = withFlowTransaction(wt.worktree, flowTx => renderArtifact(flowTx, mdPath, renderPlanMd("wfid", PLAN)))
    const jsonSha = canonicalPlanSha(PLAN)
    // a separate fresh OpenCode session owns the workflow under its attachment epoch
    const wf: Workflow = {
      ...newWorkflow(OTHER, currentOwner(Date.now(), otherSession.epoch), "command", "add a widget", "opencode"),
      id: "wfid",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf))

    const before = JSON.stringify(readWorkflow(wt.worktree))
    const eventsBefore = readEvents(wt.worktree, wf.id)
    const text = await runCommand(deps, APPROVE_COMMAND, "", APPROVE_TEMPLATE, S)
    expect(text).toContain(`already active in session ${OTHER}`)
    expect(JSON.stringify(readWorkflow(wt.worktree))).toBe(before)
    expect(readEvents(wt.worktree, wf.id)).toEqual(eventsBefore)
    expect(readLedger(wt.worktree, S).tasks.length).toBe(0)
    expect(readLedger(wt.worktree, OTHER).tasks.length).toBe(0)
  })
})

describe("6) restored interrupted approve stays held (tagged tasks exist, phase still pending_approval)", () => {
  test("repairOnLoad leaves the interrupted approval and ledger unchanged while held", async () => {
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = withFlowTransaction(wt.worktree, flowTx => renderArtifact(flowTx, mdPath, renderPlanMd("wfid", PLAN)))
    const jsonSha = canonicalPlanSha(PLAN)
    const wf: Workflow = {
      ...newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "command", "add a widget", "opencode"),
      id: "wfid",
      phase: "pending_approval", // the crash happened after the ledger write but before the phase write
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf))
    const { ledger } = addTasks(readLedger(wt.worktree, S), validPlanArgs().steps.map((s) => ({ title: s.title })), Date.now(), { id: "wfid", planSha: jsonSha })
    writeLedger(wt.worktree, ledger)

    const deps = makeDeps(client, wt.worktree)
    releaseFixtureSession(wt.worktree, fixtureSession)
    fixtureSession = attachAdmission(getOpenCodeRuntime(deps), S, { engine: "opencode" })
    expect(fixtureSession.restored).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)

    const beforeRepair = readWorkflow(wt.worktree)!
    const eventsBeforeRepair = readEvents(wt.worktree, "wfid")
    const ledgerBeforeRepair = readLedger(wt.worktree, S)
    const r = repairOnLoad(getOpenCodeRuntime(deps), "opencode")
    expect(r).toBeNull()
    const after = readWorkflow(wt.worktree)!
    expect(after).toEqual(beforeRepair)
    expect(after.phase).toBe("pending_approval")
    expect(readEvents(wt.worktree, "wfid")).toEqual(eventsBeforeRepair)
    expect(readLedger(wt.worktree, S)).toEqual(ledgerBeforeRepair)
    expect(tasksForWorkflow(ledgerBeforeRepair, "wfid")).toHaveLength(3)
  })
})

describe("7) same-session restored owner remains held until explicit Resume", () => {
  test("held /approve is inert, then explicit Resume permits approval", async () => {
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = withFlowTransaction(wt.worktree, flowTx => renderArtifact(flowTx, mdPath, renderPlanMd("wfid", PLAN)))
    const jsonSha = canonicalPlanSha(PLAN)
    const wf: Workflow = {
      ...newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "command", "add a widget", "opencode"),
      id: "wfid",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf))

    const deps = makeDeps(client, wt.worktree)
    releaseFixtureSession(wt.worktree, fixtureSession)
    fixtureSession = attachAdmission(getOpenCodeRuntime(deps), S, { engine: "opencode" })
    expect(fixtureSession.restored).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    const rebound = readWorkflow(wt.worktree)!
    expect(rebound.owner.instance).toBe(fixtureSession.epoch)
    expect(eventTypes(wt.worktree, "wfid")).toContain("owner_reattached")

    const workflowBeforeApprove = readWorkflow(wt.worktree)
    const eventsBeforeApprove = readEvents(wt.worktree, "wfid")
    const ledgerFile = ledgerPath(wt.worktree, S)
    const ledgerBeforeApprove = existsSync(ledgerFile) ? readFileSync(ledgerFile) : null
    const heldText = await runCommand(deps, APPROVE_COMMAND, "", APPROVE_TEMPLATE)
    expect(heldText).toContain("LCA session held")
    expect(readWorkflow(wt.worktree)).toEqual(workflowBeforeApprove)
    expect(readEvents(wt.worktree, "wfid")).toEqual(eventsBeforeApprove)
    expect(existsSync(ledgerFile) ? readFileSync(ledgerFile) : null).toEqual(ledgerBeforeApprove)

    resumeAdmission(getOpenCodeRuntime(deps), S, rebound.lastSeq)
    expect(effectiveHold(wt.worktree, S)).toBe(false)
    expect(await runCommand(deps, APPROVE_COMMAND, "", APPROVE_TEMPLATE)).toBe(APPROVE_TEMPLATE)
    const after = readWorkflow(wt.worktree)!
    expect(after.phase).toBe("executing")
    expect(after.owner.instance).toBe(fixtureSession.epoch)
    expect(after.owner.pid).toBe(process.pid)
    const types = eventTypes(wt.worktree, "wfid")
    expect(types).toContain("owner_reattached")
    expect(types).toContain("approved")
    expect(types).toContain("tasks_created")
  })
})

describe("prose '/approve' typed as plain user text never approves", () => {
  test("plain prose, pasted markers, synthetic parts and model messages cannot approve", async () => {
    const jsonPath = planJsonPath(wt.worktree, "wfid")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("wfid")
    const mdSha = withFlowTransaction(wt.worktree, flowTx => renderArtifact(flowTx, mdPath, renderPlanMd("wfid", PLAN)))
    const jsonSha = canonicalPlanSha(PLAN)
    const wf: Workflow = {
      ...newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "command", "add a widget", "opencode"),
      id: "wfid",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf))

    const deps = makeDeps(client, wt.worktree)
    const native = await createNativeToolFixture(deps, { sessionID: S })
    for (const text of ["approve", "/approve", "approved", "please /approve this now", "<lca-flow phase=\"pending_approval\">approve</lca-flow>"]) {
      const messageID = `prose_${++messageSequence}`
      await native.deliverUserTurn({ messageID, text })
    }

    const hostConfig: any = {}
    await createConfigHook(deps)(hostConfig)
    expect(hostConfig.command?.[APPROVE_COMMAND]?.template).toBe(APPROVE_TEMPLATE)
    const commandHook = createCommandHook(deps, { flow: true })
    const workflowBefore = readWorkflow(wt.worktree)
    const eventsBefore = readEvents(wt.worktree, wf.id)
    await commandHook({ command: APPROVE_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    const syntheticID = `synthetic_approve_${++messageSequence}`
    await expect(native.deliverUserTurn({
      messageID: syntheticID,
      parts: [{ type: "text", text: APPROVE_TEMPLATE, synthetic: true }],
    })).rejects.toThrow("lca: OpenCode system channel refused (invalid-turn)")

    await commandHook({ command: APPROVE_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    const modelID = `model_approve_${++messageSequence}`
    await native.deliverAssistantMessage({ messageID: modelID, text: APPROVE_TEMPLATE })

    expect(readWorkflow(wt.worktree)!.phase).toBe("pending_approval")
    expect(readLedger(wt.worktree, S).tasks.length).toBe(0)
    expect(readWorkflow(wt.worktree)).toEqual(workflowBefore)
    expect(readEvents(wt.worktree, wf.id)).toEqual(eventsBefore)
  })
})

describe("interactive conversation mode", () => {
  test("an unbound managed task cannot invent tool authority; unrelated roots are also refused", async () => {
    const previousInteractive = process.env.LCA_INTERACTIVE_WORKTREE
    const previousStateHome = process.env.LCA_STATE_HOME
    const main = tempGitWorktree()
    try {
      process.env.LCA_INTERACTIVE_WORKTREE = main.worktree
      const task = await createTaskWorktree(main.worktree, S, "interactive-worker", [])
      expect(task).not.toBeNull()
      expect(taskWorktreeOwner(task!.path)?.mainWorktree).toBe(realpathSync.native(main.worktree))

      const input: any = {
        client,
        directory: task!.path,
        worktree: task!.path,
        project: {},
        experimental_workspace: { register() {} },
        serverUrl: new URL("http://127.0.0.1:0"),
      }
      await LcaPlugin(input)
      const taskDeps = makeDeps(client, task!.path)
      const unboundOwner = admitFixtureSession(taskDeps, "unbound-task-session")
      try {
        const native = await createNativeToolFixture(taskDeps, { sessionID: "unbound-task-session" })
        const createdBefore = [...client.created]
        const turn = await native.deliverUserTurn()
        expect(turn.parts.map((p: any) => p.text)).toEqual(["A real native fixture user request."])
        // The unauthorized user turn was not accepted, so the fixture can mint no call; the raw call has no native proof.
        expect(() => native.primeCall({ tool: "read", args: { filePath: "README.md" }, callID: "unbound-task-read" })).toThrow(/accept a native user turn/)
        const rawArgs = { filePath: "README.md" }
        await expect(createToolBeforeHook(taskDeps)({ tool: "read", sessionID: "unbound-task-session", callID: "unbound-task-read" }, { args: rawArgs })).rejects.toThrow("lca: OpenCode tool call refused (stale-turn)")
        expect(rawArgs).toEqual({ filePath: "README.md" })
        expect(client.created).toEqual(createdBefore)
      } finally {
        releaseFixtureSession(task!.path, unboundOwner)
      }

      const unrelated = join(main.stateHome, "unrelated-worktree")
      mkdirSync(unrelated)
      await expect(LcaPlugin({ ...input, directory: unrelated, worktree: unrelated })).rejects.toThrow(/does not match this plugin worktree/)
    } finally {
      if (previousInteractive === undefined) delete process.env.LCA_INTERACTIVE_WORKTREE
      else process.env.LCA_INTERACTIVE_WORKTREE = previousInteractive
      await main.cleanup()
      if (previousStateHome === undefined) delete process.env.LCA_STATE_HOME
      else process.env.LCA_STATE_HOME = previousStateHome
    }
  })

  test("interactive command mark without user role cannot approve", async () => {
    const jsonPath = planJsonPath(wt.worktree, "interactive_pending")
    const PLAN: Plan = { goal: "add a widget", steps: validPlanArgs().steps, risks: ["x"], revision: 1 }
    mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
    writeJsonAtomic(jsonPath, PLAN)
    const mdPath = planMdPath("interactive_pending")
    const mdSha = withFlowTransaction(wt.worktree, flowTx => renderArtifact(flowTx, mdPath, renderPlanMd("interactive_pending", PLAN)))
    const jsonSha = canonicalPlanSha(PLAN)
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, {
      ...newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "command", "add a widget", "opencode"),
      id: "interactive_pending",
      phase: "pending_approval",
      planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    }))

    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    const hostConfig: any = {}
    await createConfigHook(deps)(hostConfig)
    expect(hostConfig.command?.[APPROVE_COMMAND]?.template).toBe(APPROVE_TEMPLATE)
    await createCommandHook(deps, { flow: true })({ command: APPROVE_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    const messageID = `interactive_missing_role_${++messageSequence}`
    const part: any = { id: `${messageID}_part`, sessionID: S, messageID, type: "text", text: APPROVE_TEMPLATE, synthetic: false }
    const workflowBefore = readWorkflow(wt.worktree)
    const eventsBefore = readEvents(wt.worktree, "interactive_pending")
    const ledgerBefore = readLedger(wt.worktree, S)
    // This deliberately malformed SDK callback lacks role and cannot borrow the pending typed command mark.
    await expect(createChatMessageHook(deps)({ sessionID: S, agent: "main" } as any, {
      message: { id: messageID, sessionID: S, agent: "main", time: { created: Date.now() }, model: { providerID: "ollama", modelID: "g" } } as any,
      parts: [part],
    })).rejects.toThrow("lca: OpenCode system channel refused (invalid-turn)")
    // The refusal happens before chat.message consumes the mark; drain it so it cannot leak into a later turn.
    expect(consumeCommandTurn(S)?.name).toBe(APPROVE_COMMAND)
    expect(consumeCommandTurn(S)).toBeNull()

    expect(readWorkflow(wt.worktree)?.phase).toBe("pending_approval")
    expect(readLedger(wt.worktree, S).tasks).toHaveLength(0)
    expect(readWorkflow(wt.worktree)).toEqual(workflowBefore)
    expect(readEvents(wt.worktree, "interactive_pending")).toEqual(eventsBefore)
    expect(readLedger(wt.worktree, S).tasks).toEqual(ledgerBefore.tasks) // an absent ledger materializes with a fresh createdAt on every read
    expect(existsSync(ledgerPath(wt.worktree, S))).toBe(false)
  })

  test("validates the canonical worktree, required hooks and approval command without replacing user config", async () => {
    const previousInteractive = process.env.LCA_INTERACTIVE_WORKTREE
    const previousXdg = process.env.XDG_CONFIG_HOME
    try {
      process.env.XDG_CONFIG_HOME = join(wt.stateHome, "xdg")
      const input: any = {
        client,
        directory: wt.worktree,
        worktree: wt.worktree,
        project: {},
        experimental_workspace: { register() {} },
        serverUrl: new URL("http://127.0.0.1:0"),
      }

      process.env.LCA_INTERACTIVE_WORKTREE = wt.stateHome
      await expect(LcaPlugin(input)).rejects.toThrow(/does not match this plugin worktree/)

      process.env.LCA_INTERACTIVE_WORKTREE = wt.worktree
      const projectConfig = join(wt.worktree, ".lca", "lca.jsonc")
      mkdirSync(join(wt.worktree, ".lca"), { recursive: true })
      writeFileSync(projectConfig, JSON.stringify({ disabled_hooks: ["guard.plan_boundary"] }))
      await expect(LcaPlugin(input)).rejects.toThrow(/guard.plan_boundary/)

      writeFileSync(projectConfig, "{}")
      const hooks = await LcaPlugin(input)
      const hostConfig: any = { command: { approve: { template: "user-defined approval" } } }
      await expect(hooks.config!(hostConfig)).rejects.toThrow(/conflicts with the typed approval command/)
      expect(hostConfig.command.approve.template).toBe("user-defined approval")
    } finally {
      if (previousInteractive === undefined) delete process.env.LCA_INTERACTIVE_WORKTREE
      else process.env.LCA_INTERACTIVE_WORKTREE = previousInteractive
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg
    }
  })

  test("ordinary main-agent language starts planning before tools and preserves the active workflow", async () => {
    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    const firstRequest = "Add an export option and cover it with a test."
    const firstTurn = await runUserTurn(deps, firstRequest, { id: "interactive_first" })
    const first = readWorkflow(wt.worktree)!
    expect(first).toMatchObject({ phase: "planning", entry: "keyword", request: firstRequest })
    expect(readEvents(wt.worktree, first.id).find((event) => event.type === "created")?.actor).toBe("user_keyword")

    const toolBefore = createToolBeforeHook(deps)
    const delegate = primeCall(firstTurn.native, "delegate", { tasks: [] })
    await expect(toolBefore(delegate.input, delegate.output)).rejects.toThrow(
      'lca: planning phase — read-only. Submit the plan with lca_flow op:"plan", or /cancel.',
    )
    const write = primeCall(firstTurn.native, "write", { filePath: "new.ts", content: "unsafe" })
    await expect(toolBefore(write.input, write.output)).rejects.toThrow(
      'lca: planning phase — read-only. Submit the plan with lca_flow op:"plan", or /cancel.',
    )

    await runUserTurn(deps, "Also update the related docs.", { id: "interactive_second" })
    const second = readWorkflow(wt.worktree)!
    expect(second.id).toBe(first.id)
    expect(second.request).toBe(firstRequest)
  })

  test("a restored workflow stays held until explicit Resume, then rejects foreign-session writes", async () => {
    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    const previous = withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, {
      ...newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "keyword", "resume planning", "opencode"),
    }))

    releaseFixtureSession(wt.worktree, fixtureSession)
    fixtureSession = attachAdmission(getOpenCodeRuntime(deps), S, { engine: "opencode" })
    expect(fixtureSession.restored).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    const rebound = readWorkflow(wt.worktree)!
    expect(rebound.id).toBe(previous.id)
    expect(rebound.owner.instance).toBe(fixtureSession.epoch)
    expect(eventTypes(wt.worktree, previous.id)).toContain("owner_reattached")

    const beforeTurn = readWorkflow(wt.worktree)
    const eventsBeforeTurn = readEvents(wt.worktree, previous.id)
    const heldTurn = await runUserTurn(deps, "Continue with the requested investigation.", { id: "interactive_restart_owner" })
    expect(heldTurn.part.text).toContain("LCA session held")
    expect(readWorkflow(wt.worktree)).toEqual(beforeTurn)
    expect(readEvents(wt.worktree, previous.id)).toEqual(eventsBeforeTurn)
    expect(eventTypes(wt.worktree, previous.id)).not.toContain("owner_takeover")

    resumeAdmission(getOpenCodeRuntime(deps), S, rebound.lastSeq)
    expect(effectiveHold(wt.worktree, S)).toBe(false)

    const otherSession = admitFixtureSession(deps, OTHER)
    additionalFixtureSessions.push(otherSession)
    const foreignTurn = await runUserTurn(deps, "Start an unrelated request.", { id: "interactive_foreign_after_takeover", sessionID: OTHER })
    expect(foreignTurn.part.text).toContain(`already active in session ${S}`)
    const afterForeignTurn = readWorkflow(wt.worktree)!
    expect(afterForeignTurn.id).toBe(previous.id)
    expect(afterForeignTurn.owner.instance).toBe(fixtureSession.epoch)
    expect(readEvents(wt.worktree, previous.id)).toEqual(eventsBeforeTurn)
  })

  test("child and synthetic turns do not start workflows", async () => {
    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "interactive_child", ownerSessionID: S, role: "worker",
    })
    try {
      await child.native.deliverUserTurn({ text: "Do child work" })
    } finally {
      child.cleanup()
    }

    const native = await createNativeToolFixture(deps, { sessionID: S })
    await expect(native.deliverUserTurn({
      parts: [{ type: "text", text: "Synthetic follow-up", synthetic: true }],
    })).rejects.toThrow("lca: OpenCode system channel refused (invalid-turn)")
    expect(readWorkflow(wt.worktree)).toBeNull()
    // A blank main turn is accepted but is not a plan request; assistant text never starts a workflow either.
    await native.deliverUserTurn({ text: "   " })
    await native.deliverAssistantMessage({ text: "Assistant-originated text" })
    expect(readWorkflow(wt.worktree)).toBeNull()
  })

  test("missing, foreign, stuck, cancelled and explicitly cancelled workflows never unlock writes", async () => {
    const deps = makeDeps(client, wt.worktree)
    deps.interactive = true
    const toolBefore = createToolBeforeHook(deps)
    let native = await createNativeToolFixture(deps, { sessionID: S })
    // A blank accepted main turn authorizes calls without being a plan request that would start a workflow.
    await native.deliverUserTurn({ text: "   " })
    const invoke = (tool: string, args: Record<string, unknown>) => {
      const call = primeCall(native, tool, args)
      return toolBefore(call.input, call.output)
    }
    const unavailable = "lca: interactive mode is read-only without an owned active plan workflow; /cancel does not enable direct edits."

    await expect(invoke("delegate", { tasks: [] })).rejects.toThrow(unavailable)
    await expect(invoke("write", { filePath: "new.ts", content: "unsafe" })).rejects.toThrow(unavailable)
    await invoke("read", { filePath: "README.md" })
    await invoke("bash", { command: "git diff" })
    await expect(invoke("bash", { command: "rm -rf src" })).rejects.toThrow(unavailable)

    const otherSession = admitFixtureSession(deps, OTHER)
    additionalFixtureSessions.push(otherSession)
    const foreign = withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, newWorkflow(OTHER, currentOwner(Date.now(), otherSession.epoch), "keyword", "foreign request", "opencode")))
    native = (await runUserTurn(deps, "Try to start another request", { id: "interactive_foreign" })).native
    expect(readWorkflow(wt.worktree)?.id).toBe(foreign.id)
    await expect(invoke("delegate", { tasks: [] })).rejects.toThrow(unavailable)

    const stuck = withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, {
      ...newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "keyword", "stuck request", "opencode"),
      phase: "stuck",
      stuckCause: "tasks_failed",
    }))
    await expect(invoke("delegate", { tasks: [] })).rejects.toThrow(unavailable)
    expect(readWorkflow(wt.worktree)?.id).toBe(stuck.id)

    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, { ...stuck, phase: "cancelled" }))
    await expect(invoke("delegate", { tasks: [] })).rejects.toThrow(unavailable)

    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "keyword", "cancel request", "opencode")))
    const cancelTurn = await runCommandTurn(deps, CANCEL_COMMAND, "", CANCEL_TEMPLATE)
    expect(readWorkflow(wt.worktree)?.phase).toBe("cancelled")
    native = cancelTurn.native
    await expect(invoke("delegate", { tasks: [] })).rejects.toThrow(unavailable)
  })

  test("interactive mode off retains ordinary main-tool behavior", async () => {
    const deps = makeDeps(client, wt.worktree)
    const turn = await runUserTurn(deps, "Please explain this code.", { id: "interactive_off" })
    expect(readWorkflow(wt.worktree)).toBeNull()
    const call = primeCall(turn.native, "read", { filePath: "README.md" })
    await createToolBeforeHook(deps)(call.input, call.output)
  })
})
