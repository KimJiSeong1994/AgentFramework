// §5.6 legacy/idle precedence: AC0.11 (nudge/stuck/question/reset), AC0.12 (precedence — ulw cleared by start,
// notice-only during a workflow, no CONTINUE_PROMPT/offerResume in any workflow phase, settle runs even with
// loop.idle disabled), settle at delegate return (tool-after) and session.deleted -> cancelled (event hook).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createEventHook } from "../src/hooks/event.ts"
import { createToolAfterHook } from "../src/hooks/tool-after.ts"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { createIdleLoop, CONTINUE_PROMPT, EXECUTING_RESUME_PROMPT, NUDGE_PROMPT } from "../src/loop/idle.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { newWorkflow, readEvents, readWorkflow, workflowPath, type Workflow, withFlowTransaction } from "../src/flow/state.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { requestStop, startWorkflow, stopHeartbeat } from "../src/flow/runtime.ts"
import { beginStageReservation } from "../src/hosts/runtime.ts"
import { addTasks, ledgerPath, readLedger, updateTask, writeLedger } from "../src/state/ledger.ts"
import { EMPTY_MODE, readModeState, writeModeState, type ModeState } from "../src/state/store.ts"
import { hasFlowSuffix, hasModeSuffix } from "../src/modes/instructions.ts"
import { createNativeToolFixture } from "./native-tool-fixture.ts"
import { admitFixtureSession, fakeClient, makeDeps, releaseFixtureSession, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_flow"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient
let fixtureSession: ReturnType<typeof admitFixtureSession>
let nativeCallSequence = 0

function setupFixture() {
  wt = tempWorktree()
  client = fakeClient({ promptAsync: true })
  fixtureSession = admitFixtureSession(makeDeps(client, wt.worktree), S)
}

function resetFixture() {
  stopHeartbeat()
  releaseFixtureSession(wt.worktree, fixtureSession)
  wt.cleanup()
  setupFixture()
}

beforeEach(() => setupFixture())
afterEach(() => {
  stopHeartbeat()
  releaseFixtureSession(wt.worktree, fixtureSession)
  wt.cleanup()
})

function putWorkflow(patch: Record<string, unknown> = {}): Workflow {
  const wf = { ...newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "command", "do the thing", "opencode"), ...patch }
  return withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf as Workflow))
}

const idleEvent = (sessionID = S) => ({ event: { type: "session.idle", properties: { sessionID } } as any })
const prompts = () => client.calls.filter((c) => c.method === "promptAsync" || c.method === "prompt")
const promptTexts = () => prompts().map((c) => (c.args as any).body.parts[0].text)

async function nativeFixture(deps: ReturnType<typeof makeDeps>, sessionID = S) {
  const native = await createNativeToolFixture(deps, { sessionID })
  await native.acceptUserTurn()
  return native
}

function primeNativeToolCall(native: Awaited<ReturnType<typeof nativeFixture>>, tool: string, args: Record<string, unknown>) {
  return native.primeCall({ tool, args, callID: `flow_idle_fixture_${++nativeCallSequence}` })
}

async function deliverNativeUserText(deps: ReturnType<typeof makeDeps>, text: string) {
  const native = await createNativeToolFixture(deps, { sessionID: S })
  const turn = await native.deliverUserTurn({ text })
  const part = turn.parts.find((candidate) => candidate.type === "text")
  if (!part || part.type !== "text") throw new Error("native user turn did not return a text part")
  return part
}

function deletedEvent(sessionID = S) {
  return {
    event: {
      type: "session.deleted" as const,
      properties: { info: {
        id: sessionID, slug: "engine-refusal", projectID: "fixture", directory: wt.worktree,
        title: "engine refusal", version: "fixture", time: { created: 0, updated: 0 },
      } },
    },
  }
}

for (const [label, engine] of [
  ["missing", undefined],
  ["foreign", "other-engine"],
  ["malformed", { engine: "opencode" }],
] as const) {
  test(`${label} workflow engine prevents idle settlement and session deletion`, async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await nativeFixture(deps)
    const wf = putWorkflow({ engine, phase: "executing", taskIds: ["t1"] })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, { ...ledger, tasks: ledger.tasks.map(task => ({ ...task, status: "done" as const })) })
    const workflowBefore = readFileSync(workflowPath(wt.worktree))
    const ledgerBefore = readFileSync(ledgerPath(wt.worktree, S))
    await createIdleLoop(deps)(S)
    // An unprovable workflow engine voids the session's admission, so no fresh native turn is accepted and no call can
    // be minted: the only remaining authority is the turn bound before the change, which is stale.
    const turn = await native.deliverUserTurn()
    expect(turn.parts.some(part => part.type === "text" && part.text.includes("LCA session held"))).toBe(true)
    expect(() => primeNativeToolCall(native, "delegate", { resume: true })).toThrow(/accept a native user turn/)
    const call = { input: { tool: "delegate", sessionID: S, callID: "flow_idle_unminted_call" }, output: { args: { resume: true } } }
    await expect(createToolBeforeHook(deps)(call.input, call.output)).rejects.toThrow("lca: OpenCode tool call refused (stale-turn)")
    await expect(createToolAfterHook(deps)({ ...call.input, args: call.output.args }, { title: "delegate", output: "ok", metadata: {} })).rejects.toThrow(
      /^lca: OpenCode tool call refused \(/,
    )
    await createEventHook(deps)(deletedEvent())
    expect(workflowBefore.equals(readFileSync(workflowPath(wt.worktree)))).toBe(true)
    expect(ledgerBefore.equals(readFileSync(ledgerPath(wt.worktree, S)))).toBe(true)
    expect(prompts()).toEqual([])
    expect(client.created).toEqual([])
  })
}

function ulw(patch: Partial<ModeState> = {}): ModeState {
  const now = Date.now()
  return { ...EMPTY_MODE, mode: "ulw", active: true, startedAt: now, updatedAt: now, ...patch }
}

describe("AC0.11 — nudge / stuck / question / reset", () => {
  test("first idle in planning sends exactly one nudge (nudges=1, nudge event)", async () => {
    putWorkflow({ phase: "planning" })
    const idle = createIdleLoop(makeDeps(client, wt.worktree))
    const r = await idle(S)
    expect(r).toEqual({ action: "workflow", wfId: expect.any(String), event: "nudge" } as any)
    expect(promptTexts()).toEqual([NUDGE_PROMPT])
    const wf = readWorkflow(wt.worktree)!
    expect(wf.counters.nudges).toBe(1)
    expect(wf.phase).toBe("planning")
  })

  test("second idle (nudge budget used) -> stuck(no_submission) + toast, no second nudge prompt", async () => {
    putWorkflow({ phase: "planning", counters: { code_invalid: 0, review_iterations: 0, user_rejections: 0, nudges: 1 } })
    const idle = createIdleLoop(makeDeps(client, wt.worktree))
    const r = await idle(S)
    expect(r).toEqual({ action: "workflow", wfId: expect.any(String), event: "nudge_exhausted" } as any)
    expect(promptTexts()).toEqual([]) // toast, not a prompt
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("stuck")
    expect(wf.stuckCause).toBe("no_submission")
  })

  test("last assistant message ends with '?' -> no nudge and no stuck", async () => {
    putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    const native = await createNativeToolFixture(deps, { sessionID: S })
    await native.acceptUserTurn()
    await native.deliverAssistantMessage({ text: "Which directory should the plan touch?" })
    const idle = createIdleLoop(deps)
    const r = await idle(S)
    expect(r).toEqual({ action: "workflow", wfId: expect.any(String) })
    expect(promptTexts()).toEqual([])
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.counters.nudges).toBe(0)

    // also true at the exhausted boundary: a trailing question suppresses nudge_exhausted too
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, { ...wf, counters: { ...wf.counters, nudges: 1 } }))
    const r2 = await idle(S)
    expect(r2).toEqual({ action: "workflow", wfId: expect.any(String) })
    expect(readWorkflow(wt.worktree)!.phase).toBe("planning")
  })

  test("a user message resets nudges and exits stuck(no_submission) back to planning (T13, via chat.message)", async () => {
    putWorkflow({ phase: "stuck", stuckCause: "no_submission", counters: { code_invalid: 0, review_iterations: 0, user_rejections: 0, nudges: 1 } })
    const deps = makeDeps(client, wt.worktree)
    const part = await deliverNativeUserText(deps, "here is more context for the plan")
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.counters.nudges).toBe(0)
    expect(hasFlowSuffix(part.text)).toBe(true)
    expect(hasModeSuffix(part.text)).toBe(false)
  })

  test("no nudge outside planning (e.g. reviewing, pending_approval, executing, stuck(tasks_failed))", async () => {
    for (const patch of [{ phase: "reviewing" }, { phase: "pending_approval" }, { phase: "stuck", stuckCause: "tasks_failed" }]) {
      resetFixture()
      putWorkflow(patch)
      await createIdleLoop(makeDeps(client, wt.worktree))(S)
      expect(promptTexts().filter((t) => t === NUDGE_PROMPT)).toEqual([])
    }
  })

  test("only one idle handler is registered (event hook calls idle() exactly once per session.idle)", async () => {
    putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    const hook = createEventHook(deps)
    await hook(idleEvent())
    expect(promptTexts()).toEqual([NUDGE_PROMPT]) // exactly one call worth of output, not doubled
  })
})

describe("AC0.12 — precedence", () => {
  test("T1 (start) clears an active ulw mode", async () => {
    writeModeState(wt.worktree, S, ulw())
    const deps = makeDeps(client, wt.worktree)
    const r = startWorkflow(deps, S, "command", "do it", "user_command", "opencode")
    expect(r.ok).toBe(true)
    const mode = readModeState(wt.worktree, S)
    expect(mode.active).toBe(false)
    expect(mode.stopReason).toBe("workflow_started")
  })

  test("ulw keyword during planning activates no mode and appends the notice only", async () => {
    const wf = putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    const part = await deliverNativeUserText(deps, "ultrawork: fix everything")
    const mode = readModeState(wt.worktree, S)
    expect(mode.active).toBe(false)
    expect(hasModeSuffix(part.text)).toBe(false)
    expect(hasFlowSuffix(part.text)).toBe(true)
    expect(part.text).toContain(`is off while plan workflow ${wf.id} is active`)
    expect(part.text).toContain("/cancel first")
  })

  test("legacy plan keyword under an active workflow also gets only the notice (no <lca-mode>)", async () => {
    const wf = putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    const part = await deliverNativeUserText(deps, "plan mode for the refactor")
    expect(hasModeSuffix(part.text)).toBe(false)
    expect(hasFlowSuffix(part.text)).toBe(true)
    expect(part.text).toContain(`plan workflow ${wf.id} is active`)
  })

  test("legacy cancel keyword under an active workflow keeps mode-off and adds the /cancel note", async () => {
    writeModeState(wt.worktree, S, ulw())
    const wf = putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    const part = await deliverNativeUserText(deps, "stop lca")
    expect(readModeState(wt.worktree, S).active).toBe(false)
    expect(part.text).toContain(`use /cancel to end plan workflow ${wf.id}`)
    expect(hasModeSuffix(part.text)).toBe(false)
  })

  test("no CONTINUE_PROMPT / offerResume fires in any non-terminal workflow phase, even with open ledger tasks", async () => {
    for (const patch of [{ phase: "planning" }, { phase: "reviewing" }, { phase: "pending_approval" }, { phase: "executing" }, { phase: "stuck", stuckCause: "user_stop" }]) {
      resetFixture()
      const wf = putWorkflow(patch)
      writeModeState(wt.worktree, S, ulw())
      let { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }, { title: "b" }])
      writeLedger(wt.worktree, ledger)
      await createIdleLoop(makeDeps(client, wt.worktree))(S)
      const texts = promptTexts()
      expect(texts.every((t) => t !== CONTINUE_PROMPT)).toBe(true)
      expect(texts.every((t) => !String(t).includes("delegate tool with resume: true"))).toBe(true)
    }
  })

  test("loop.idle disabled: settle still runs (executing -> done), no prompt is sent", async () => {
    const wf = putWorkflow({ phase: "executing", taskIds: ["t1"] })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }], Date.now(), { id: wf.id, planSha: "s" })
    const done = { ...ledger, tasks: ledger.tasks.map((t) => ({ ...t, status: "done" as const })) }
    writeLedger(wt.worktree, done)
    const deps = makeDeps(client, wt.worktree, { disabled_hooks: ["loop.idle"] })
    const idle = createIdleLoop(deps)
    const r = await idle(S)
    expect(r).toEqual({ action: "workflow", wfId: wf.id })
    expect(promptTexts()).toEqual([])
    expect(readWorkflow(wt.worktree)!.phase).toBe("done")
  })

  test("loop.idle disabled: planning phase settle runs (no-op) but no nudge prompt is sent", async () => {
    putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree, { disabled_hooks: ["loop.idle"] })
    const idle = createIdleLoop(deps)
    const r = await idle(S)
    expect(r).toEqual({ action: "workflow", wfId: expect.any(String) })
    expect(promptTexts()).toEqual([])
    expect(readWorkflow(wt.worktree)!.phase).toBe("planning")
  })
})

describe("executing: at most one resume prompt per task-id set", () => {
  test("repeated idle calls in executing send the resume prompt only once for the same task set", async () => {
    const wf = putWorkflow({ phase: "executing", taskIds: ["t1", "t2"] })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }, { title: "b" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, ledger) // tasks still open: settle is a no-op, stays in executing
    const idle = createIdleLoop(makeDeps(client, wt.worktree))
    await idle(S)
    await idle(S)
    await idle(S)
    expect(promptTexts()).toEqual([EXECUTING_RESUME_PROMPT])
  })

  test("a new task-id set (e.g. after a repair) gets a fresh resume prompt", async () => {
    const wf = putWorkflow({ phase: "executing", taskIds: ["t1"] })
    let { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, ledger)
    const idle = createIdleLoop(makeDeps(client, wt.worktree))
    await idle(S)
    expect(promptTexts()).toEqual([EXECUTING_RESUME_PROMPT])

    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, { ...readWorkflow(wt.worktree)!, taskIds: ["t1", "t2"] }))
    ;({ ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "b" }], Date.now(), { id: wf.id, planSha: "s" }))
    writeLedger(wt.worktree, ledger)
    await idle(S)
    expect(promptTexts()).toEqual([EXECUTING_RESUME_PROMPT, EXECUTING_RESUME_PROMPT])
  })
})

describe("settle via idle", () => {
  test("all tasks done -> done", async () => {
    const wf = putWorkflow({ phase: "executing", taskIds: ["t1"] })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, { ...ledger, tasks: ledger.tasks.map((t) => ({ ...t, status: "done" as const })) })
    await createIdleLoop(makeDeps(client, wt.worktree))(S)
    expect(readWorkflow(wt.worktree)!.phase).toBe("done")
  })

  test("a failed task -> stuck(tasks_failed)", async () => {
    const wf = putWorkflow({ phase: "executing", taskIds: ["t1"] })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, { ...ledger, tasks: ledger.tasks.map((t) => ({ ...t, status: "failed" as const })) })
    await createIdleLoop(makeDeps(client, wt.worktree))(S)
    const wf2 = readWorkflow(wt.worktree)!
    expect(wf2.phase).toBe("stuck")
    expect(wf2.stuckCause).toBe("tasks_failed")
  })

  test("a task cancelled with a user_stop error -> stuck(user_stop)", async () => {
    const wf = putWorkflow({ phase: "executing", taskIds: ["t1"] })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, { ...ledger, tasks: ledger.tasks.map((t) => ({ ...t, status: "cancelled" as const, error: "user_stop" })) })
    await createIdleLoop(makeDeps(client, wt.worktree))(S)
    const wf2 = readWorkflow(wt.worktree)!
    expect(wf2.phase).toBe("stuck")
    expect(wf2.stuckCause).toBe("user_stop")
  })

  test("settle via delegate return (tool.execute.after)", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await nativeFixture(deps)
    const wf = putWorkflow({ phase: "executing", taskIds: ["t1"] })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, { ...ledger, tasks: ledger.tasks.map((t) => ({ ...t, status: "done" as const })) })
    const hook = createToolAfterHook(deps)
    const call = primeNativeToolCall(native, "delegate", { resume: true })
    await createToolBeforeHook(deps)(call.input, call.output)
    await hook(call.input, { title: "delegate", output: "ok", metadata: {} })
    const completedWorkflow = readWorkflow(wt.worktree)!
    const completedEvents = readEvents(wt.worktree, wf.id)
    const completedLedger = readLedger(wt.worktree, S)
    expect(completedWorkflow.phase).toBe("done")
    await expect(hook(call.input, { title: "delegate", output: "ok", metadata: {} })).rejects.toThrow(
      "lca: OpenCode tool call refused (completed-call)",
    )
    expect(readWorkflow(wt.worktree)).toEqual(completedWorkflow)
    expect(readEvents(wt.worktree, wf.id)).toEqual(completedEvents)
    expect(readLedger(wt.worktree, S)).toEqual(completedLedger)
  })

  test("delegate return in a non-owning session does not settle another session's workflow", async () => {
    const deps = makeDeps(client, wt.worktree)
    const otherOwner = admitFixtureSession(deps, "ses_other")
    const native = await nativeFixture(deps, "ses_other")
    const wf = putWorkflow({ phase: "executing", taskIds: ["t1"] })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, { ...ledger, tasks: ledger.tasks.map((t) => ({ ...t, status: "done" as const })) })
    try {
      const call = primeNativeToolCall(native, "delegate", { resume: true })
      await createToolBeforeHook(deps)(call.input, call.output)
      await createToolAfterHook(deps)(call.input, { title: "delegate", output: "ok", metadata: {} })
      expect(readWorkflow(wt.worktree)!.phase).toBe("executing")
    } finally {
      releaseFixtureSession(wt.worktree, otherOwner)
    }
  })
})

describe("stop observers through idle (P5b)", () => {
  const nonTransitions = (id: string) => readEvents(wt.worktree, id).filter(e => e.type === "transition").map(e => String(e.data?.event))

  test("a pending pause is settled by idle (held branch) only after the blocker is released, with no ordinary settle or prompt", async () => {
    const deps = makeDeps(client, wt.worktree)
    const runtime = getOpenCodeRuntime(deps)
    const wf = putWorkflow({ phase: "executing", stage: "unit" })
    const reservation = beginStageReservation(wt.worktree, S)
    expect(requestStop(runtime, S, "pause", "p", { workflowID: wf.id }).result.ok).toBe(true)
    const idle = createIdleLoop(deps)
    expect(await idle(S)).toMatchObject({ action: "ignored", why: "held" })
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "executing", stopIntent: { kind: "pause" } })
    reservation()
    expect(await idle(S)).toMatchObject({ action: "ignored", why: "held" })
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "paused" })
    expect(nonTransitions(wf.id)).not.toContain("settle_ok")
    expect(prompts()).toHaveLength(0)
  })

  test("a pending cancel is settled by idle once the blocker is released; held safety never runs review_aborted or settle_ok", async () => {
    const deps = makeDeps(client, wt.worktree)
    const runtime = getOpenCodeRuntime(deps)
    const wf = putWorkflow({ phase: "reviewing", stage: "review" })
    const reservation = beginStageReservation(wt.worktree, S)
    expect(requestStop(runtime, S, "cancel", "c", { workflowID: wf.id }).result.ok).toBe(true)
    await createIdleLoop(deps)(S)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "reviewing", stopIntent: { kind: "cancel" } })
    reservation()
    await createIdleLoop(deps)(S)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "cancelled", stopIntent: null })
    expect(nonTransitions(wf.id)).not.toContain("review_aborted")
  })

  test("an ordinary idle with all tasks done does not settle while a pause is pending", async () => {
    const deps = makeDeps(client, wt.worktree)
    const runtime = getOpenCodeRuntime(deps)
    const wf = putWorkflow({ phase: "executing", stage: "unit" })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }], Date.now(), { id: wf.id, planSha: "p" })
    writeLedger(wt.worktree, { ...ledger, tasks: ledger.tasks.map(t => ({ ...t, status: "done" as const })) })
    const reservation = beginStageReservation(wt.worktree, S)
    requestStop(runtime, S, "pause", "p", { workflowID: wf.id })
    reservation()
    await createIdleLoop(deps)(S)
    expect(readWorkflow(wt.worktree)!.phase).toBe("paused")
    expect(nonTransitions(wf.id)).not.toContain("settle_ok")
  })
})

describe("session.deleted -> cancelled with retained session state", () => {
  beforeEach(async () => {
    const info = deletedEvent().event.properties.info
    ;(client.session as any).get = async () => ({ data: info })
    await createEventHook(makeDeps(client, wt.worktree))({
      event: { type: "session.created", properties: { info } },
    } as any)
  })

  test("a held workflow transaction prevents session-directory cleanup", async () => {
    putWorkflow()
    writeLedger(wt.worktree, readLedger(wt.worktree, S))
    const workflowBefore = readFileSync(workflowPath(wt.worktree))
    const ledgerBefore = readFileSync(ledgerPath(wt.worktree, S))
    const hook = createEventHook(makeDeps(client, wt.worktree))
    let pending: ReturnType<typeof hook> | undefined
    withFlowTransaction(wt.worktree, () => {
      pending = hook(deletedEvent())
    })
    expect(pending).toBeDefined()
    await pending
    expect(workflowBefore.equals(readFileSync(workflowPath(wt.worktree)))).toBe(true)
    expect(ledgerBefore.equals(readFileSync(ledgerPath(wt.worktree, S)))).toBe(true)
  })

  test("session deletion preserves an unreleased execution claim and session-directory data", async () => {
    putWorkflow()
    writeLedger(wt.worktree, readLedger(wt.worktree, S))
    const ledgerBefore = readFileSync(ledgerPath(wt.worktree, S))
    const deps = makeDeps(client, wt.worktree)
    const runtime = getOpenCodeRuntime(deps)
    const claim = runtime.runs.claim(S, runtime.instance, process.pid)
    await createEventHook(deps)(deletedEvent())
    // Intended P5b change (T19 removed): an unreleased claim is a blocker, so deletion commits a cancel intent only.
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "planning", stopIntent: expect.objectContaining({ kind: "cancel" }) })
    expect(runtime.runs.status().claim).toBeDefined()
    expect(ledgerBefore.equals(readFileSync(ledgerPath(wt.worktree, S)))).toBe(true)
    expect(client.calls.filter(call => call.method === "abort")).toEqual([])
    runtime.runs.release(claim)
  })

  test("deleting the owning session cancels its non-terminal workflow", async () => {
    const wf = putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    const hook = createEventHook(deps)
    await hook({ event: { type: "session.deleted", properties: { info: { id: S } } } } as any)
    expect(readWorkflow(wt.worktree)!.phase).toBe("cancelled")
  })

  test("deleting an unrelated session does not touch the workflow", async () => {
    putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    const hook = createEventHook(deps)
    await hook({ event: { type: "session.deleted", properties: { info: { id: "ses_other" } } } } as any)
    expect(readWorkflow(wt.worktree)!.phase).toBe("planning")
  })
})
