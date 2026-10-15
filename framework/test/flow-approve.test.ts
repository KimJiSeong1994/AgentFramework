// AC1.4/AC1.5: /approve through the real dispatch path (command.ts marks the turn -> chat.message does the state
// work per §5.2/§5.3/§5.5). Wrong phase no-op; other session refused; queue running refused; edited md refused;
// double approve creates tasks once; task titles == steps; prose "/approve"/"approved" never approves — only the
// injected `approve` command turn does; restored sessions stay held until explicit Resume.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { Part, TextPart } from "@opencode-ai/sdk"
import { createCommandHook, APPROVE_COMMAND, APPROVE_TEMPLATE } from "../src/hooks/command.ts"
import { createConfigHook } from "../src/hooks/config.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { newWorkflow, planJsonPath, readEvents, readWorkflow, renderArtifact, type Workflow, withFlowTransaction } from "../src/flow/state.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { canonicalPlanSha, planMdPath, renderPlanMd, type Plan } from "../src/flow/plan.ts"
import { attachAdmission, effectiveHold, resumeAdmission } from "../src/sessions/admission.ts"
import { ledgerPath, readLedger, tasksForWorkflow } from "../src/state/ledger.ts"
import { createNativeToolFixture } from "./native-tool-fixture.ts"
import { admitFixtureSession, fakeClient, makeDeps, releaseFixtureSession, tempGitWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempGitWorktree>
let client: FakeClient
let fixtureSession: ReturnType<typeof admitFixtureSession>
let otherFixtureSession: ReturnType<typeof admitFixtureSession> | undefined

const PLAN: Plan = {
  goal: "add a widget",
  steps: [
    { title: "step one", files: ["a.py"], detail: "do a", verify: "python3 -m pytest -q test_a.py" },
    { title: "step two", files: ["b.py"], detail: "do b", verify: "python3 -m pytest -q test_b.py" },
    { title: "step three", files: ["c.py"], detail: "do c", verify: "python3 -m pytest -q test_c.py" },
  ],
  risks: ["might break x"],
  revision: 1,
}

beforeEach(() => {
  wt = tempGitWorktree()
  client = fakeClient()
  fixtureSession = admitFixtureSession(makeDeps(client, wt.worktree), S)
  otherFixtureSession = undefined
})
afterEach(() => {
  if (otherFixtureSession) releaseFixtureSession(wt.worktree, otherFixtureSession)
  releaseFixtureSession(wt.worktree, fixtureSession)
  wt.cleanup()
})

/** Write a valid, saved plan + workflow in pending_approval so /approve can run against it. */
function putApprovablePlan(patch: Record<string, unknown> = {}): Workflow {
  const jsonPath = planJsonPath(wt.worktree, "wfid")
  mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
  writeFileSync(jsonPath, JSON.stringify(PLAN))
  const mdPath = planMdPath("wfid")
  const mdSha = withFlowTransaction(wt.worktree, tx => renderArtifact(tx, mdPath, renderPlanMd("wfid", PLAN)))
  const jsonSha = canonicalPlanSha(PLAN)
  const wf: Workflow = {
    ...newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "command", "add a widget", "opencode"),
    id: "wfid",
    phase: "pending_approval",
    planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    ...patch,
  } as Workflow
  return withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf))
}

/** Drive /approve exactly as OpenCode would: command.execute.before marks the turn, chat.message does the work. */
async function runApprove(deps = makeDeps(client, wt.worktree), sessionID = S): Promise<string> {
  const native = await createNativeToolFixture(deps, { sessionID })
  const hostConfig: any = {}
  await createConfigHook(deps)(hostConfig)
  if (hostConfig.command?.[APPROVE_COMMAND]?.template !== APPROVE_TEMPLATE) {
    throw new Error("/approve was not injected by createConfigHook")
  }
  const commandHook = createCommandHook(deps, { stop: true, status: true, flow: true })
  await commandHook({ command: APPROVE_COMMAND, sessionID, arguments: "" }, { parts: [] })
  const turn = await native.deliverUserTurn({ text: APPROVE_TEMPLATE })
  return textOutput(turn.parts)
}

function textOutput(parts: Part[]): string {
  const output = parts.find((part): part is TextPart => part.type === "text")
  if (!output) throw new Error("native user turn did not return a text part")
  return output.text
}

describe("/approve — dispatch path", () => {
  test("a satisfied precondition set approves once: phase -> executing, 3 tasks tagged, titles == plan steps", async () => {
    putApprovablePlan()
    const text = await runApprove()
    expect(text).toBe(APPROVE_TEMPLATE)
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("executing")
    const tasks = tasksForWorkflow(readLedger(wt.worktree, S), "wfid")
    expect(tasks.length).toBe(3)
    expect(tasks.map((t) => t.title)).toEqual(PLAN.steps.map((s) => s.title))
  })

  test("wrong phase (planning) is a no-op refusal, no ledger write", async () => {
    putApprovablePlan({ phase: "planning" })
    const text = await runApprove()
    expect(text).toBe("no plan awaiting approval")
    expect(readLedger(wt.worktree, S).tasks.length).toBe(0)
    expect(readWorkflow(wt.worktree)!.phase).toBe("planning")
  })

  test("other admitted session is refused (workflow owned by S), no mutation", async () => {
    const wf = putApprovablePlan()
    const deps = makeDeps(client, wt.worktree)
    otherFixtureSession = admitFixtureSession(deps, OTHER)
    const text = await runApprove(deps, OTHER)
    expect(text).toContain(`already active in session ${S}`)
    expect(readWorkflow(wt.worktree)!.phase).toBe(wf.phase)
    expect(readLedger(wt.worktree, S).tasks.length).toBe(0)
  })

  test("queue running is refused", async () => {
    putApprovablePlan()
    const deps = makeDeps(client, wt.worktree)
    const q = getQueue(getOpenCodeRuntime(deps))
    // simulate a running queue: run() marks `active` internally, but for the test we only need isRunning() true.
    // The queue module keys "active" by sessionID once run() starts; instead we add a pending task and start run()
    // without awaiting so isRunning() is true during the assertion window.
    let finishBlocker: (() => void) | undefined
    let workerStarted!: () => void
    const started = new Promise<void>(resolve => { workerStarted = resolve })
    client.replies.worker = { text: "never", run: () => new Promise<void>((resolve) => { finishBlocker = resolve; workerStarted() }) }
    q.add(S, [{ title: "blocker" }])
    const running = q.run(S)
    await Promise.race([started, running.then(result => { throw new Error(`queue ended before the blocking worker started: ${JSON.stringify(result)}`) })])
    const text = await runApprove(deps)
    expect(text).toBe("a task queue is running; wait or /stop")
    finishBlocker!()
    await running
    expect(q.isRunning(S)).toBe(false)
  })

  test("md edited after submission is refused (D2)", async () => {
    const wf = putApprovablePlan()
    writeFileSync(require("node:path").join(wt.worktree, wf.planRef!.mdPath), "tampered\n")
    const text = await runApprove()
    expect(text).toBe("plan file edited; /plan again or revert")
    expect(readWorkflow(wt.worktree)!.phase).toBe("pending_approval")
  })

  test("plan json sha mismatch (canonical sha does not match planRef) is refused", async () => {
    const wf = putApprovablePlan()
    writeFileSync(planJsonPath(wt.worktree, wf.id), JSON.stringify({ ...PLAN, goal: "tampered goal" }))
    const text = await runApprove()
    expect(text).toBe("the saved plan does not match; /plan again")
  })

  test("double /approve creates tasks only once (idempotent by planSha)", async () => {
    putApprovablePlan()
    await runApprove()
    const afterFirst = readLedger(wt.worktree, S).tasks.length
    expect(afterFirst).toBe(3)
    // a second /approve on an already-executing workflow is refused by the phase check, and must not add tasks again
    const text2 = await runApprove()
    expect(text2).toBe("no plan awaiting approval")
    expect(readLedger(wt.worktree, S).tasks.length).toBe(3)
  })

  test("approval stores the plan subject and tags tasks with the parent workflow id plus subject hash only", async () => {
    const wf = putApprovablePlan()
    expect(await runApprove()).toBe(APPROVE_TEMPLATE)
    const approved = readWorkflow(wt.worktree)!
    expect(approved.approval).toMatchObject({ by: "user_command", receiptRevision: wf.lastSeq, subject: { kind: "plan", id: wf.id, sha256: wf.planRef!.jsonSha } })
    const tasks = readLedger(wt.worktree, S).tasks
    expect(tasks).toHaveLength(3)
    for (const task of tasks) expect(task.wf).toEqual({ id: wf.id, planSha: wf.planRef!.jsonSha })
  })

  test("prose \"/approve\" or \"approved\" in a user message never approves", async () => {
    putApprovablePlan()
    const deps = makeDeps(client, wt.worktree)
    const native = await createNativeToolFixture(deps, { sessionID: S })
    for (const text of ["/approve", "approved", "I think this plan is approved, /approve it now"]) {
      // no command.execute.before ran first, so no command turn is marked: this is plain prose
      await native.deliverUserTurn({ text })
    }
    expect(readWorkflow(wt.worktree)!.phase).toBe("pending_approval")
    expect(readLedger(wt.worktree, S).tasks.length).toBe(0)
  })

  test("a model output containing '/approve' text is never read as approval (only the tool's own args matter, not text)", async () => {
    putApprovablePlan()
    const deps = makeDeps(client, wt.worktree)
    const native = await createNativeToolFixture(deps, { sessionID: S })
    await native.deliverUserTurn({ text: "check the plan" })
    // The assistant message arrives through the actual SDK message.updated event callback, not chat.message.
    const { message } = await native.deliverAssistantMessage({ text: "assistant said /approve but this is not a command turn" })
    expect(client.calls).toContainEqual({ method: "message", args: { path: { id: S, messageID: message.id } } })
    expect(readWorkflow(wt.worktree)!.phase).toBe("pending_approval")
    expect(readLedger(wt.worktree, S).tasks).toHaveLength(0)
  })

  test("a restored owner remains held until explicit Resume, then /approve succeeds", async () => {
    const deps = makeDeps(client, wt.worktree)
    const originalEpoch = fixtureSession.epoch
    putApprovablePlan({ owner: currentOwner(Date.now(), originalEpoch) })

    releaseFixtureSession(wt.worktree, fixtureSession)
    fixtureSession = attachAdmission(getOpenCodeRuntime(deps), S, { engine: "opencode" })
    expect(fixtureSession.restored).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    const rebound = readWorkflow(wt.worktree)!
    expect(rebound.owner.instance).toBe(fixtureSession.epoch)
    expect(readEvents(wt.worktree, rebound.id).map(event => event.type)).toContain("owner_reattached")

    const workflowBeforeApprove = readWorkflow(wt.worktree)
    const eventsBeforeApprove = readEvents(wt.worktree, rebound.id)
    const ledgerFile = ledgerPath(wt.worktree, S)
    const ledgerBeforeApprove = existsSync(ledgerFile) ? readFileSync(ledgerFile) : null
    const heldText = await runApprove(deps)
    expect(heldText).toContain("LCA session held")
    expect(readWorkflow(wt.worktree)).toEqual(workflowBeforeApprove)
    expect(readEvents(wt.worktree, rebound.id)).toEqual(eventsBeforeApprove)
    expect(existsSync(ledgerFile) ? readFileSync(ledgerFile) : null).toEqual(ledgerBeforeApprove)

    resumeAdmission(getOpenCodeRuntime(deps), S, rebound.lastSeq)
    expect(effectiveHold(wt.worktree, S)).toBe(false)
    const text = await runApprove(deps)
    expect(text).toBe(APPROVE_TEMPLATE)
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("executing")
    expect(wf.owner.instance).toBe(fixtureSession.epoch)
    expect(tasksForWorkflow(readLedger(wt.worktree, S), wf.id)).toHaveLength(3)
  })

  test("an unverifiable dead owner stays held and /approve leaves workflow and tasks unchanged", async () => {
    putApprovablePlan({ owner: { instance: "inst_dead_prev_run", pid: 9_999_999, heartbeatAt: 0 } })
    const deps = makeDeps(client, wt.worktree)

    releaseFixtureSession(wt.worktree, fixtureSession)
    fixtureSession = attachAdmission(getOpenCodeRuntime(deps), S, { engine: "opencode" })
    expect(fixtureSession.restored).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)

    const workflowBefore = readWorkflow(wt.worktree)
    const eventsBefore = readEvents(wt.worktree, "wfid")
    const ledgerBefore = readLedger(wt.worktree, S)
    const path = ledgerPath(wt.worktree, S)
    const ledgerBytes = existsSync(path) ? readFileSync(path) : null
    const text = await runApprove(deps)
    expect(text).toContain("LCA session held")
    expect(readWorkflow(wt.worktree)).toEqual(workflowBefore)
    expect(readEvents(wt.worktree, "wfid")).toEqual(eventsBefore)
    expect(existsSync(path) ? readFileSync(path) : null).toEqual(ledgerBytes)
    expect(tasksForWorkflow(ledgerBefore, "wfid")).toHaveLength(0)
  })
})
