import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createEventHook } from "../src/hooks/event.ts"
import { createIdleLoop, resumeMessage } from "../src/loop/idle.ts"
import { createCompactingHook, buildCheckpoint } from "../src/hooks/compacting.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { addTasks, emptyLedger, readLedger, updateTask, writeLedger } from "../src/state/ledger.ts"
import { abortPath, EMPTY_MODE, readModeState, sessionInfoPath, writeJsonAtomic, writeModeState, type ModeState } from "../src/state/store.ts"
import { fakeClient, makeDeps, tempGitWorktree, todo, waitFor, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
let wt: ReturnType<typeof tempGitWorktree>
let client: FakeClient
beforeEach(() => {
  wt = tempGitWorktree()
  client = fakeClient({ promptAsync: true })
})
afterEach(() => wt.cleanup())

function ulw(patch: Partial<ModeState> = {}): ModeState {
  const now = Date.now()
  return { ...EMPTY_MODE, mode: "ulw", active: true, startedAt: now, updatedAt: now, ...patch }
}
const mainPrompts = () => client.calls.filter((c) => c.method === "promptAsync" && (c.args as any).path.id === S)
const idleEvent = { event: { type: "session.idle", properties: { sessionID: S } } } as any

describe("idle loop with a ledger", () => {
  test("open tasks (any mode) -> main is told ONCE to call delegate resume:true; the queue is never run from idle", async () => {
    const deps = makeDeps(client, wt.worktree)
    let { ledger } = addTasks(emptyLedger(S), [{ title: "a" }, { title: "b" }, { title: "c" }])
    ledger = updateTask(ledger, "t1", { status: "done" })
    writeLedger(wt.worktree, ledger)
    // mode none: a plain rule-3 delegate call was interrupted
    const idle = createIdleLoop(deps)
    expect(await idle(S)).toEqual({ action: "resume_offered", open: 2 })
    expect(client.created.length).toBe(0)
    const p = mainPrompts()
    expect(p.length).toBe(1)
    const part = (p[0]!.args as any).body.parts[0]
    expect(part.synthetic).toBe(true) // never gets a mode suffix / detection
    expect(part.text).toBe(resumeMessage(2, ["b", "c"]))
    expect(part.text).toContain("delegate tool with resume: true")
    // second idle: already notified -> falls through to the todo path (mode none here -> inactive), no second offer
    expect(await idle(S)).toEqual({ action: "ignored", why: "inactive" })
    expect(mainPrompts().length).toBe(1)
    // with ulw active the todo continuation still runs even though open tasks remain (never stuck)
    writeModeState(wt.worktree, S, ulw())
    client.todos = [todo("1", "pending")]
    expect((await idle(S, Date.now() + 5000)).action).toBe("continued")
    // new open tasks after the notice -> notified again
    writeLedger(wt.worktree, addTasks(readLedger(wt.worktree, S), [{ title: "d" }]).ledger)
    expect((await idle(S)).action).toBe("resume_offered")
  })

  test("the resume message is synthetic: chat.message adds no mode suffix and detects nothing", async () => {
    const deps = makeDeps(client, wt.worktree)
    writeModeState(wt.worktree, S, ulw())
    const part: any = { type: "text", text: resumeMessage(1, ["ulw everything"]), synthetic: true }
    await createChatMessageHook(deps)({ sessionID: S, agent: "main" }, { message: {} as any, parts: [part] })
    expect(part.text).not.toContain("<lca-mode")
  })

  test("settled ledger -> falls through to the stage-1 todo path (through the event hook)", async () => {
    const deps = makeDeps(client, wt.worktree)
    let { ledger } = addTasks(emptyLedger(S), [{ title: "a" }, { title: "b" }])
    ledger = updateTask(updateTask(ledger, "t1", { status: "done" }), "t2", { status: "failed" })
    writeLedger(wt.worktree, ledger)
    writeModeState(wt.worktree, S, ulw())
    client.todos = [todo("1", "pending")]
    await createEventHook(deps)(idleEvent)
    expect(mainPrompts().length).toBe(1) // continuation, not a resume offer
    expect((mainPrompts()[0]!.args as any).body.parts[0].text).toContain("Continue with the next incomplete task")
    client.calls.length = 0
    client.todos = []
    await createEventHook(deps)({ ...idleEvent })
    const st = readModeState(wt.worktree, S)
    expect(st.stopReason === "todos_done" || st.stopReason === undefined).toBe(true)
  })

  test("idle while the queue is running is ignored (no double run, no resume offer)", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false } as any })
    const q = getQueue(getOpenCodeRuntime(deps))
    let started = false
    let release: (() => void) | undefined
    client.replies.worker = { text: "x", run: () => ((started = true), new Promise<void>((r) => (release = r))) }
    q.add(S, [{ title: "a" }])
    writeModeState(wt.worktree, S, ulw())
    const running = q.run(S)
    await waitFor(() => started)
    expect(await createIdleLoop(deps)(S)).toEqual({ action: "ignored", why: "queue_running" })
    release!()
    await running
    expect(client.created.length).toBe(1)
    expect(mainPrompts().length).toBe(0)
  })

  test("no ledger -> stage-1 todo continuation still works", async () => {
    const deps = makeDeps(client, wt.worktree)
    client.todos = [todo("1", "pending")]
    writeModeState(wt.worktree, S, ulw())
    const out = await createIdleLoop(deps)(S)
    expect(out.action).toBe("continued")
    expect(mainPrompts().length).toBe(1)
  })

  test("todo path: a user cancel written while todos were being fetched is not overwritten", async () => {
    const deps = makeDeps(client, wt.worktree)
    writeModeState(wt.worktree, S, ulw())
    client.todos = [todo("1", "pending")]
    const slowTodo = client.session.todo!
    client.session.todo = async (o) => {
      await new Promise((r) => setTimeout(r, 30))
      return slowTodo(o)
    }
    const idle = createIdleLoop(deps)
    const p = idle(S)
    await new Promise((r) => setTimeout(r, 5))
    // user says stop while the loop waits for todos
    const part: any = { type: "text", text: "stop lca" }
    await createChatMessageHook(deps)({ sessionID: S, agent: "main" }, { message: {} as any, parts: [part] })
    const out = await p
    expect(out).toEqual({ action: "ignored", why: "state_changed" })
    expect(readModeState(wt.worktree, S).active).toBe(false)
    expect(mainPrompts().length).toBe(0)
  })

  test("todo path: two idle events inside the debounce window send one continuation", async () => {
    const deps = makeDeps(client, wt.worktree)
    writeModeState(wt.worktree, S, ulw())
    client.todos = [todo("1", "pending")]
    const slowTodo = client.session.todo!
    client.session.todo = async (o) => {
      await new Promise((r) => setTimeout(r, 20))
      return slowTodo(o)
    }
    const idle = createIdleLoop(deps)
    const now = Date.now()
    const [a, b] = await Promise.all([idle(S, now), idle(S, now + 1)])
    expect([a.action, b.action].sort()).toEqual(["continued", "ignored"])
    expect(mainPrompts().length).toBe(1)
  })

  test("no resume offer when the delegate tool is disabled", async () => {
    const deps = makeDeps(client, wt.worktree, { disabled_hooks: ["tool.delegate"] })
    writeLedger(wt.worktree, addTasks(emptyLedger(S), [{ title: "a" }]).ledger)
    expect((await createIdleLoop(deps)(S)).action).toBe("ignored")
    expect(mainPrompts().length).toBe(0)
  })

  test("breakers still run first on the todo path; an abort marker also suppresses the resume offer", async () => {
    const deps = makeDeps(client, wt.worktree)
    const { ledger } = addTasks(emptyLedger(S), [{ title: "a" }])
    writeLedger(wt.worktree, ledger)
    writeJsonAtomic(abortPath(wt.worktree, S), { reason: "user_stop", at: Date.now() })
    writeModeState(wt.worktree, S, ulw({ iterations: 20 }))
    expect(await createIdleLoop(deps)(S)).toEqual({ action: "stopped", reason: "aborted" })
    expect(mainPrompts().length).toBe(0)
    expect(client.created.length).toBe(0)
  })
})

describe("checkpoint with ledger", () => {
  test("mentions task progress and the current task, stays <= 600 chars; child sessions get no checkpoint", async () => {
    const deps = makeDeps(client, wt.worktree)
    let { ledger } = addTasks(emptyLedger(S), [{ title: "first task title" }, { title: "second one" }, { title: "third" }])
    ledger = updateTask(updateTask(ledger, "t1", { status: "done" }), "t2", { status: "running" })
    writeLedger(wt.worktree, ledger)
    writeModeState(wt.worktree, S, ulw({ iterations: 2 }))
    const text = buildCheckpoint(readModeState(wt.worktree, S), [], readLedger(wt.worktree, S))
    expect(text).toContain("tasks=1/3 done; current: 2. second one")
    expect(text).toContain("resume:true continues them")
    expect(text.length).toBeLessThanOrEqual(600)
    const output = { context: [] as string[] }
    await createCompactingHook(deps)({ sessionID: S } as any, output as any)
    expect(output.context[0]).toContain("tasks=1/3 done")

    writeJsonAtomic(sessionInfoPath(wt.worktree, "child_9"), { agent: "worker", createdAt: 1 })
    const childOut = { context: [] as string[] }
    await createCompactingHook(deps)({ sessionID: "child_9" } as any, childOut as any)
    expect(childOut.context).toEqual([])
  })
})
