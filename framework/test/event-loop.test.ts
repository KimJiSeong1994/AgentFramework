import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createEventHook } from "../src/hooks/event.ts"
import { createCompactingHook, checkpointPath } from "../src/hooks/compacting.ts"
import { createIdleLoop, CONTINUE_PROMPT, abortPath } from "../src/loop/idle.ts"
import { readModeState, writeModeState, writeJsonAtomic, sessionDir, EMPTY_MODE, type ModeState } from "../src/state/store.ts"
import { fetchTodos, todoFingerprint } from "../src/guards/todos.ts"
import { fakeClient, makeDeps, tempWorktree, todo, type FakeClient } from "./guards-helpers.ts"

const S = "ses_1"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient({ promptAsync: true })
})
afterEach(() => wt.cleanup())

function ulw(patch: Partial<ModeState> = {}): ModeState {
  const now = Date.now()
  return { ...EMPTY_MODE, mode: "ulw", active: true, startedAt: now, updatedAt: now, ...patch }
}
const idleEvent = (sessionID = S) => ({ event: { type: "session.idle", properties: { sessionID } } as any })
const prompts = () => client.calls.filter((c) => c.method === "promptAsync" || c.method === "prompt")

describe("loop.idle", () => {
  test("re-prompts with the continuation text when ulw is active and todos remain", async () => {
    client.todos = [todo("1", "completed"), todo("2", "pending")]
    writeModeState(wt.worktree, S, ulw())
    const hook = createEventHook(makeDeps(client, wt.worktree))
    await hook(idleEvent())
    const p = prompts()
    expect(p.length).toBe(1)
    expect(p[0]!.method).toBe("promptAsync")
    expect((p[0]!.args as any).path.id).toBe(S)
    expect((p[0]!.args as any).body.parts[0].text).toBe(CONTINUE_PROMPT)
    const st = readModeState(wt.worktree, S)
    expect(st.iterations).toBe(1)
    expect(st.stagnation).toBe(0)
    expect(st.active).toBe(true)
    expect(st.lastFingerprint).toBe(todoFingerprint(client.todos as any))
  })

  test("falls back to session.prompt when promptAsync is unavailable", async () => {
    client = fakeClient({ promptAsync: false })
    client.todos = [todo("1", "in_progress")]
    writeModeState(wt.worktree, S, ulw())
    await createEventHook(makeDeps(client, wt.worktree))(idleEvent())
    expect(prompts().map((c) => c.method)).toEqual(["prompt"])
  })

  test("never prompts when mode is none or plan, or when inactive", async () => {
    client.todos = [todo("1", "pending")]
    const deps = makeDeps(client, wt.worktree)
    const hook = createEventHook(deps)
    await hook(idleEvent())
    writeModeState(wt.worktree, S, { ...ulw(), mode: "plan" })
    await hook(idleEvent())
    writeModeState(wt.worktree, S, ulw({ active: false }))
    await hook(idleEvent())
    expect(prompts().length).toBe(0)
    expect(client.calls.filter((c) => c.method === "todo").length).toBe(0)
  })

  test("todos_done: stops when nothing is incomplete", async () => {
    client.todos = [todo("1", "completed"), todo("2", "cancelled")]
    writeModeState(wt.worktree, S, ulw())
    await createEventHook(makeDeps(client, wt.worktree))(idleEvent())
    expect(prompts().length).toBe(0)
    const st = readModeState(wt.worktree, S)
    expect(st.active).toBe(false)
    expect(st.stopReason).toBe("todos_done")
  })

  test("max_iterations breaker", async () => {
    client.todos = [todo("1", "pending")]
    writeModeState(wt.worktree, S, ulw({ iterations: 20 }))
    await createEventHook(makeDeps(client, wt.worktree))(idleEvent())
    expect(prompts().length).toBe(0)
    expect(readModeState(wt.worktree, S).stopReason).toBe("max_iterations")
    expect(readModeState(wt.worktree, S).active).toBe(false)
  })

  test("ttl breaker", async () => {
    client.todos = [todo("1", "pending")]
    writeModeState(wt.worktree, S, ulw({ startedAt: Date.now() - 3 * 60 * 60 * 1000 }))
    await createEventHook(makeDeps(client, wt.worktree))(idleEvent())
    expect(prompts().length).toBe(0)
    expect(readModeState(wt.worktree, S).stopReason).toBe("ttl")
  })

  test("stagnation breaker: same todo fingerprint N times", async () => {
    client.todos = [todo("1", "pending")]
    writeModeState(wt.worktree, S, ulw())
    const deps = makeDeps(client, wt.worktree, { loop: { ...makeDeps(client, wt.worktree).config.loop, stagnation: 3 } })
    const idle = createIdleLoop(deps)
    let t = Date.now()
    expect((await idle(S, t)).action).toBe("continued") // stagnation 0 (first fingerprint)
    expect((await idle(S, (t += 5000))).action).toBe("continued") // 1
    expect((await idle(S, (t += 5000))).action).toBe("continued") // 2
    const r = await idle(S, (t += 5000))
    expect(r).toEqual({ action: "stopped", reason: "stagnation" })
    expect(prompts().length).toBe(3)
    expect(readModeState(wt.worktree, S).active).toBe(false)
    // progress resets stagnation
  })

  test("progress on the todo list resets stagnation", async () => {
    client.todos = [todo("1", "pending"), todo("2", "pending")]
    writeModeState(wt.worktree, S, ulw({ stagnation: 2, lastFingerprint: "stale" }))
    const idle = createIdleLoop(makeDeps(client, wt.worktree))
    const r = await idle(S)
    expect(r.action).toBe("continued")
    expect(readModeState(wt.worktree, S).stagnation).toBe(0)
  })

  test("failures breaker", async () => {
    client.todos = [todo("1", "pending")]
    writeModeState(wt.worktree, S, ulw({ failures: 5 }))
    await createEventHook(makeDeps(client, wt.worktree))(idleEvent())
    expect(prompts().length).toBe(0)
    expect(readModeState(wt.worktree, S).stopReason).toBe("failures")
  })

  test("compaction guard: idle within compaction_guard_ms of session.compacted skips this tick but keeps the mode active", async () => {
    client.todos = [todo("1", "pending")]
    writeModeState(wt.worktree, S, ulw())
    const hook = createEventHook(makeDeps(client, wt.worktree))
    await hook({ event: { type: "session.compacted", properties: { sessionID: S } } as any })
    expect(readModeState(wt.worktree, S).lastCompactedAt).toBeGreaterThan(0)
    await hook(idleEvent())
    expect(prompts().length).toBe(0)
    expect(readModeState(wt.worktree, S).active).toBe(true)
    expect(readModeState(wt.worktree, S).stopReason).toBeUndefined()
  })

  test("old compaction does not trip the guard", async () => {
    client.todos = [todo("1", "pending")]
    writeModeState(wt.worktree, S, ulw({ lastCompactedAt: Date.now() - 120_000 }))
    await createEventHook(makeDeps(client, wt.worktree))(idleEvent())
    expect(prompts().length).toBe(1)
  })

  test("abort.json breaker", async () => {
    client.todos = [todo("1", "pending")]
    writeModeState(wt.worktree, S, ulw())
    writeJsonAtomic(abortPath(wt.worktree, S), { reason: "repetition" })
    await createEventHook(makeDeps(client, wt.worktree))(idleEvent())
    expect(prompts().length).toBe(0)
    expect(readModeState(wt.worktree, S).stopReason).toBe("aborted")
  })

  test("debounce: idle within 3s of our continuation is ignored", async () => {
    client.todos = [todo("1", "pending")]
    writeModeState(wt.worktree, S, ulw())
    const idle = createIdleLoop(makeDeps(client, wt.worktree))
    const t = Date.now()
    expect((await idle(S, t)).action).toBe("continued")
    expect(await idle(S, t + 1000)).toEqual({ action: "ignored", why: "debounced" })
    expect(await idle(S, t + 2999)).toEqual({ action: "ignored", why: "debounced" })
    expect((await idle(S, t + 3001)).action).toBe("continued")
    expect(prompts().length).toBe(2)
    expect(readModeState(wt.worktree, S).iterations).toBe(2)
  })

  test("loop.idle can be disabled via disabled_hooks", async () => {
    client.todos = [todo("1", "pending")]
    writeModeState(wt.worktree, S, ulw())
    await createEventHook(makeDeps(client, wt.worktree, { disabled_hooks: ["loop.idle"] }))(idleEvent())
    expect(prompts().length).toBe(0)
  })

  test("sessions are isolated: idle for another session does not touch ours", async () => {
    client.todos = [todo("1", "pending")]
    writeModeState(wt.worktree, S, ulw())
    await createEventHook(makeDeps(client, wt.worktree))(idleEvent("ses_other"))
    expect(prompts().length).toBe(0)
    expect(readModeState(wt.worktree, S).iterations).toBe(0)
  })
})

describe("fetchTodos", () => {
  test("uses client.session.todo when present", async () => {
    client.todos = [todo("1", "pending")]
    const t = await fetchTodos(client as any, S)
    expect(t.map((x) => x.id)).toEqual(["1"])
    expect(client.calls.map((c) => c.method)).toEqual(["todo"])
  })
  test("falls back to the last completed todowrite part in messages()", async () => {
    client = fakeClient({ todoEndpoint: false })
    client.messages = [
      { info: { id: "m1" }, parts: [{ type: "tool", tool: "todowrite", state: { status: "completed", input: { todos: [todo("old", "pending")] }, metadata: {} } }] },
      { info: { id: "m2" }, parts: [{ type: "tool", tool: "todowrite", state: { status: "completed", input: {}, metadata: { todos: [todo("new", "in_progress")] } } }] },
    ]
    const t = await fetchTodos(client as any, S)
    expect(t.map((x) => x.id)).toEqual(["new"])
    expect(client.calls.map((c) => c.method)).toEqual(["messages"])
  })
  test("falls back when the todo endpoint errors", async () => {
    client.todos = undefined
    client.messages = []
    expect(await fetchTodos(client as any, S)).toEqual([])
    expect(client.calls.map((c) => c.method)).toEqual(["todo", "messages"])
  })
})

describe("repetition abort (event hook)", () => {
  const phrase = "I will now proceed to read the file and then apply the same change again"
  const loopText = Array.from({ length: 4 }, () => phrase).join(" ")
  const textPart = (text: string, delta?: string) => ({
    event: {
      type: "message.part.updated",
      properties: { part: { id: "prt_1", sessionID: S, messageID: "msg_a", type: "text", text }, delta },
    } as any,
  })
  const msgUpdated = (role: "user" | "assistant", id = "msg_a") => ({
    event: { type: "message.updated", properties: { info: { id, sessionID: S, role } } } as any,
  })

  test("aborts once and writes abort.json for a repeating assistant part", async () => {
    const hook = createEventHook(makeDeps(client, wt.worktree))
    await hook(msgUpdated("assistant"))
    await hook(textPart("short", "short"))
    await hook(textPart(loopText, " again"))
    await hook(textPart(loopText + " more", " more"))
    expect(client.calls.filter((c) => c.method === "abort").length).toBe(1)
    const note = JSON.parse(readFileSync(abortPath(wt.worktree, S), "utf8"))
    expect(note.reason).toBe("repetition")
    expect(note.partID).toBe("prt_1")
  })

  test("never aborts on user parts (role from message.updated, or no delta)", async () => {
    const hook = createEventHook(makeDeps(client, wt.worktree))
    await hook(msgUpdated("user"))
    await hook(textPart(loopText, undefined))
    await hook(textPart(loopText, "x"))
    await hook({ event: { type: "message.part.updated", properties: { part: { id: "prt_2", sessionID: S, messageID: "unknown", type: "text", text: loopText } } } } as any)
    expect(client.calls.filter((c) => c.method === "abort").length).toBe(0)
    expect(existsSync(abortPath(wt.worktree, S))).toBe(false)
  })

  test("abort_on_repetition=false only logs", async () => {
    const deps = makeDeps(client, wt.worktree, { guards: { ...makeDeps(client, wt.worktree).config.guards, abort_on_repetition: false } })
    const hook = createEventHook(deps)
    await hook(msgUpdated("assistant"))
    await hook(textPart(loopText, "x"))
    expect(client.calls.filter((c) => c.method === "abort").length).toBe(0)
    expect(deps.logs).toContain("repetition detected")
  })

  test("tool error parts increment loop failures while active", async () => {
    writeModeState(wt.worktree, S, ulw())
    const hook = createEventHook(makeDeps(client, wt.worktree))
    const err = (callID: string) => ({
      event: { type: "message.part.updated", properties: { part: { id: "p", sessionID: S, messageID: "m", type: "tool", callID, tool: "write", state: { status: "error", error: "Error: File already exists", input: {}, time: { start: 0, end: 1 } } } } } as any,
    })
    await hook(err("c1"))
    await hook(err("c1")) // duplicate update of the same call is ignored
    await hook(err("c2"))
    expect(readModeState(wt.worktree, S).failures).toBe(2)
  })

  test("event hook never throws on malformed events", async () => {
    const hook = createEventHook(makeDeps(client, wt.worktree))
    await expect(hook({ event: { type: "message.part.updated", properties: {} } } as any)).resolves.toBeUndefined()
    await expect(hook({ event: { type: "session.idle", properties: {} } } as any)).resolves.toBeUndefined()
  })
})

describe("compaction checkpoint", () => {
  test("pushes a ≤600-char checkpoint with mode, iterations, incomplete todos and writes checkpoint.json", async () => {
    client.todos = [todo("1", "completed", "done thing"), todo("2", "pending", "Implement the parser"), todo("3", "in_progress", "Write tests")]
    writeModeState(wt.worktree, S, ulw({ iterations: 4 }))
    const output = { context: [] as string[] }
    await createCompactingHook(makeDeps(client, wt.worktree))({ sessionID: S }, output)
    expect(output.context.length).toBe(1)
    const text = output.context[0]!
    expect(text.length).toBeLessThanOrEqual(600)
    expect(text).toContain("mode=ulw (active) iterations=4")
    expect(text).toContain("Implement the parser")
    expect(text).toContain("Write tests")
    expect(text).not.toContain("done thing")
    expect(text).toContain("Preserve: files edited so far, the current task, and unresolved errors.")
    const cp = JSON.parse(readFileSync(checkpointPath(wt.worktree, S), "utf8"))
    expect(cp.incomplete.map((t: any) => t.id)).toEqual(["2", "3"])
    expect(cp.text).toBe(text)
    expect(checkpointPath(wt.worktree, S)).toBe(join(sessionDir(wt.worktree, S), "checkpoint.json"))
  })

  test("stays within 600 chars with many long todos", async () => {
    client.todos = Array.from({ length: 40 }, (_, i) => todo(String(i), "pending", `A fairly long todo title number ${i} ` + "x".repeat(60)))
    const output = { context: [] as string[] }
    await createCompactingHook(makeDeps(client, wt.worktree))({ sessionID: S }, output)
    expect(output.context[0]!.length).toBeLessThanOrEqual(600)
    expect(output.context[0]).toContain("more")
    expect(output.context[0]).toContain("Preserve:")
  })
})
