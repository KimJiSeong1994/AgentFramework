// §5.6 legacy/idle precedence: AC0.11 (nudge/stuck/question/reset), AC0.12 (precedence — ulw cleared by start,
// notice-only during a workflow, no CONTINUE_PROMPT/offerResume in any workflow phase, settle runs even with
// loop.idle disabled), settle at delegate return (tool-after) and session.deleted -> cancelled (event hook).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createEventHook } from "../src/hooks/event.ts"
import { createToolAfterHook } from "../src/hooks/tool-after.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createIdleLoop, CONTINUE_PROMPT, EXECUTING_RESUME_PROMPT, NUDGE_PROMPT } from "../src/loop/idle.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { newWorkflow, readWorkflow, writeWorkflow, type Workflow } from "../src/flow/state.ts"
import { startWorkflow } from "../src/flow/runtime.ts"
import { addTasks, readLedger, updateTask, writeLedger } from "../src/state/ledger.ts"
import { EMPTY_MODE, readModeState, writeModeState, type ModeState } from "../src/state/store.ts"
import { hasFlowSuffix, hasModeSuffix } from "../src/modes/instructions.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_flow"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient({ promptAsync: true })
})
afterEach(() => wt.cleanup())

function putWorkflow(patch: Record<string, unknown> = {}): Workflow {
  const wf = { ...newWorkflow(S, currentOwner(), "command", "do the thing"), ...patch }
  return writeWorkflow(wt.worktree, wf as Workflow)
}

const idleEvent = (sessionID = S) => ({ event: { type: "session.idle", properties: { sessionID } } as any })
const prompts = () => client.calls.filter((c) => c.method === "promptAsync" || c.method === "prompt")
const promptTexts = () => prompts().map((c) => (c.args as any).body.parts[0].text)

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
    client.messages = [{ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "Which directory should the plan touch?" }] }]
    const idle = createIdleLoop(makeDeps(client, wt.worktree))
    const r = await idle(S)
    expect(r).toEqual({ action: "workflow", wfId: expect.any(String) })
    expect(promptTexts()).toEqual([])
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.counters.nudges).toBe(0)

    // also true at the exhausted boundary: a trailing question suppresses nudge_exhausted too
    writeWorkflow(wt.worktree, { ...wf, counters: { ...wf.counters, nudges: 1 } })
    const r2 = await idle(S)
    expect(r2).toEqual({ action: "workflow", wfId: expect.any(String) })
    expect(readWorkflow(wt.worktree)!.phase).toBe("planning")
  })

  test("a user message resets nudges and exits stuck(no_submission) back to planning (T13, via chat.message)", async () => {
    putWorkflow({ phase: "stuck", stuckCause: "no_submission", counters: { code_invalid: 0, review_iterations: 0, user_rejections: 0, nudges: 1 } })
    const deps = makeDeps(client, wt.worktree)
    const hook = createChatMessageHook(deps)
    const part: any = { type: "text", text: "here is more context for the plan" }
    await hook({ sessionID: S, agent: "main" } as any, { message: { id: "m1" } as any, parts: [part] })
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.counters.nudges).toBe(0)
    expect(hasFlowSuffix(part.text)).toBe(true)
    expect(hasModeSuffix(part.text)).toBe(false)
  })

  test("no nudge outside planning (e.g. reviewing, pending_approval, executing, stuck(tasks_failed))", async () => {
    for (const patch of [{ phase: "reviewing" }, { phase: "pending_approval" }, { phase: "stuck", stuckCause: "tasks_failed" }]) {
      wt.cleanup()
      wt = tempWorktree()
      client = fakeClient({ promptAsync: true })
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
    const r = startWorkflow(deps, S, "command", "do it", "user_command")
    expect(r.ok).toBe(true)
    const mode = readModeState(wt.worktree, S)
    expect(mode.active).toBe(false)
    expect(mode.stopReason).toBe("workflow_started")
  })

  test("ulw keyword during planning activates no mode and appends the notice only", async () => {
    const wf = putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    const hook = createChatMessageHook(deps)
    const part: any = { type: "text", text: "ultrawork: fix everything" }
    await hook({ sessionID: S, agent: "main" } as any, { message: { id: "m1" } as any, parts: [part] })
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
    const hook = createChatMessageHook(deps)
    const part: any = { type: "text", text: "plan mode for the refactor" }
    await hook({ sessionID: S, agent: "main" } as any, { message: { id: "m1" } as any, parts: [part] })
    expect(hasModeSuffix(part.text)).toBe(false)
    expect(hasFlowSuffix(part.text)).toBe(true)
    expect(part.text).toContain(`plan workflow ${wf.id} is active`)
  })

  test("legacy cancel keyword under an active workflow keeps mode-off and adds the /cancel note", async () => {
    writeModeState(wt.worktree, S, ulw())
    const wf = putWorkflow({ phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    const hook = createChatMessageHook(deps)
    const part: any = { type: "text", text: "stop lca" }
    await hook({ sessionID: S, agent: "main" } as any, { message: { id: "m1" } as any, parts: [part] })
    expect(readModeState(wt.worktree, S).active).toBe(false)
    expect(part.text).toContain(`use /cancel to end plan workflow ${wf.id}`)
    expect(hasModeSuffix(part.text)).toBe(false)
  })

  test("no CONTINUE_PROMPT / offerResume fires in any non-terminal workflow phase, even with open ledger tasks", async () => {
    for (const patch of [{ phase: "planning" }, { phase: "reviewing" }, { phase: "pending_approval" }, { phase: "executing" }, { phase: "stuck", stuckCause: "user_stop" }]) {
      wt.cleanup()
      wt = tempWorktree()
      client = fakeClient({ promptAsync: true })
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

    writeWorkflow(wt.worktree, { ...readWorkflow(wt.worktree)!, taskIds: ["t1", "t2"] })
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
    const wf = putWorkflow({ phase: "executing", taskIds: ["t1"] })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, { ...ledger, tasks: ledger.tasks.map((t) => ({ ...t, status: "done" as const })) })
    const deps = makeDeps(client, wt.worktree)
    const hook = createToolAfterHook(deps)
    await hook({ tool: "delegate", sessionID: S, callID: "c1", args: {} } as any, { title: "delegate", output: "ok", metadata: {} } as any)
    expect(readWorkflow(wt.worktree)!.phase).toBe("done")
  })

  test("delegate return in a non-owning session does not settle another session's workflow", async () => {
    const wf = putWorkflow({ phase: "executing", taskIds: ["t1"] })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "a" }], Date.now(), { id: wf.id, planSha: "s" })
    writeLedger(wt.worktree, { ...ledger, tasks: ledger.tasks.map((t) => ({ ...t, status: "done" as const })) })
    const deps = makeDeps(client, wt.worktree)
    const hook = createToolAfterHook(deps)
    await hook({ tool: "delegate", sessionID: "ses_other", callID: "c1", args: {} } as any, { title: "delegate", output: "ok", metadata: {} } as any)
    expect(readWorkflow(wt.worktree)!.phase).toBe("executing")
  })
})

describe("session.deleted -> cancelled (before removeSessionDir)", () => {
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
