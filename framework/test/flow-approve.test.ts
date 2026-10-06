// AC1.4/AC1.5: /approve through the real dispatch path (command.ts marks the turn -> chat.message does the state
// work per §5.2/§5.3/§5.5). Wrong phase no-op; other session refused; queue running refused; edited md refused;
// double approve creates tasks once; task titles == steps; prose "/approve"/"approved" never approves — only the
// injected `approve` command turn does; owning-session dead owner takes over first, then approves.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { createCommandHook, APPROVE_COMMAND, APPROVE_TEMPLATE } from "../src/hooks/command.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { newWorkflow, planJsonPath, readWorkflow, writeWorkflow, type Workflow } from "../src/flow/state.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { canonicalPlanSha, planMdPath, renderPlanMd, type Plan } from "../src/flow/plan.ts"
import { readLedger, tasksForWorkflow } from "../src/state/ledger.ts"
import { sessionDir } from "../src/state/store.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient

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
  wt = tempWorktree()
  client = fakeClient()
  mkdirSync(sessionDir(wt.worktree, S), { recursive: true })
})
afterEach(() => wt.cleanup())

/** Write a valid, saved plan + workflow in pending_approval so /approve can run against it. */
function putApprovablePlan(patch: Record<string, unknown> = {}): Workflow {
  const jsonPath = planJsonPath(wt.worktree, "wfid")
  mkdirSync(jsonPath.replace(/\/[^/]+$/, ""), { recursive: true })
  writeFileSync(jsonPath, JSON.stringify(PLAN))
  const mdPath = planMdPath("wfid")
  const mdSha = require("../src/flow/state.ts").renderArtifact(wt.worktree, mdPath, renderPlanMd("wfid", PLAN))
  const jsonSha = canonicalPlanSha(PLAN)
  const wf: Workflow = {
    ...newWorkflow(S, currentOwner(), "command", "add a widget"),
    id: "wfid",
    phase: "pending_approval",
    planRef: { jsonSha, mdPath, mdSha, revision: 1 },
    ...patch,
  } as Workflow
  return writeWorkflow(wt.worktree, wf)
}

/** Drive /approve exactly as OpenCode would: command.execute.before marks the turn, chat.message does the work. */
async function runApprove(deps = makeDeps(client, wt.worktree), sessionID = S): Promise<string> {
  const commandHook = createCommandHook(deps, { stop: true, status: true, flow: true })
  await commandHook({ command: APPROVE_COMMAND, sessionID, arguments: "" }, { parts: [] })
  const part: any = { type: "text", text: APPROVE_TEMPLATE }
  await createChatMessageHook(deps)({ sessionID, agent: "main" } as any, { message: {} as any, parts: [part] })
  return part.text as string
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

  test("other session is refused (owned by), no mutation", async () => {
    const wf = putApprovablePlan()
    const text = await runApprove(makeDeps(client, wt.worktree), OTHER)
    expect(text).toContain(`owned by session ${S}`)
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
    client.replies.worker = { text: "never", run: () => new Promise<void>(() => {}) } // never resolves: keeps the queue "running"
    q.add(S, [{ title: "blocker" }])
    const running = q.run(S)
    while (!q.isRunning(S)) await new Promise((r) => setTimeout(r, 2))
    const text = await runApprove(deps)
    expect(text).toBe("a task queue is running; wait or /stop")
    void running
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

  test("prose \"/approve\" or \"approved\" in a user message never approves", async () => {
    putApprovablePlan()
    const deps = makeDeps(client, wt.worktree)
    const chatHook = createChatMessageHook(deps)
    for (const text of ["/approve", "approved", "I think this plan is approved, /approve it now"]) {
      const part: any = { type: "text", text }
      // no command.execute.before ran first, so no command turn is marked: this is plain prose
      await chatHook({ sessionID: S, agent: "main" } as any, { message: {} as any, parts: [part] })
    }
    expect(readWorkflow(wt.worktree)!.phase).toBe("pending_approval")
    expect(readLedger(wt.worktree, S).tasks.length).toBe(0)
  })

  test("a model output containing '/approve' text is never read as approval (only the tool's own args matter, not text)", async () => {
    putApprovablePlan()
    const deps = makeDeps(client, wt.worktree)
    // Simulate main's own assistant text mentioning /approve — chat.message only ever inspects the user text part
    // it receives; there is no code path here that reads assistant output at all.
    const part: any = { type: "text", text: "assistant said /approve but this is not a command turn" }
    await createChatMessageHook(deps)({ sessionID: S, agent: "main" } as any, { message: {} as any, parts: [part] })
    expect(readWorkflow(wt.worktree)!.phase).toBe("pending_approval")
  })

  test("owning-session dead owner: takeover happens before the §5.5 preconditions, then approves", async () => {
    putApprovablePlan({ owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 } })
    const text = await runApprove()
    expect(text).toBe(APPROVE_TEMPLATE)
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("executing")
    expect(wf.owner.pid).toBe(process.pid)
  })
})
