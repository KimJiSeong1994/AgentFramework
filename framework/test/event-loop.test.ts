import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createEventHook } from "../src/hooks/event.ts"
import { createCompactingHook, checkpointPath } from "../src/hooks/compacting.ts"
import { createIdleLoop, CONTINUE_PROMPT, abortPath } from "../src/loop/idle.ts"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { readModeState, writeModeState, writeJsonAtomic, sessionDir, modeStatePath, EMPTY_MODE, type ModeState } from "../src/state/store.ts"
import { todoFingerprint, type Todo } from "../src/guards/todos.ts"
import { fetchOpenCodeTodos } from "../src/hosts/opencode-todos.ts"
import { admitFixtureSession, fakeClient, makeDeps, releaseFixtureSession, tempWorktree, todo, type FakeClient } from "./guards-helpers.ts"
import { createNativeToolFixture } from "./native-tool-fixture.ts"

const S = "ses_1"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient

let fixtureSession: ReturnType<typeof admitFixtureSession>
beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient({ promptAsync: true })
  fixtureSession = admitFixtureSession(makeDeps(client, wt.worktree), S)
})
afterEach(() => {
  releaseFixtureSession(wt.worktree, fixtureSession)
  wt.cleanup()
})

function ulw(patch: Partial<ModeState> = {}): ModeState {
  const now = Date.now()
  return { ...EMPTY_MODE, mode: "ulw", active: true, startedAt: now, updatedAt: now, ...patch }
}
const idleEvent = (sessionID = S) => ({ event: { type: "session.idle", properties: { sessionID } } as any })
const prompts = () => client.calls.filter((c) => c.method === "promptAsync" || c.method === "prompt")

const messageUpdated = (info: unknown) => ({
  event: { type: "message.updated", properties: { info } } as any,
})

async function createNativeEventFixture(deps: ReturnType<typeof makeDeps>) {
  const native = await createNativeToolFixture(deps, { sessionID: S })
  const event = createEventHook(deps)
  const userMessage = await native.acceptUserTurn()
  await event(messageUpdated(userMessage))
  return {
    event,
    native,
    async primeCall(options: Parameters<typeof native.primeCall>[0]) {
      const call = native.primeCall(options)
      await event(messageUpdated(call.assistantMessage))
      return call
    },
  }
}

function textPart(part: { id: string; sessionID: string; messageID: string; text: string }, text: string, delta?: string) {
  return {
    event: {
      type: "message.part.updated",
      properties: { part: { ...part, text }, ...(delta === undefined ? {} : { delta }) },
    } as any,
  }
}

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
    expect(st.lastFingerprint).toBe(todoFingerprint(client.todos as Todo[]))
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

  test("an abort marker holds admission without dispatching or rewriting mode evidence", async () => {
    client.todos = [todo("1", "pending")]
    writeModeState(wt.worktree, S, ulw())
    writeJsonAtomic(abortPath(wt.worktree, S), { reason: "repetition" })
    const deps = makeDeps(client, wt.worktree)
    const modeBefore = readModeState(wt.worktree, S)
    const modeBytesBefore = readFileSync(modeStatePath(wt.worktree, S))
    const abortBefore = readFileSync(abortPath(wt.worktree, S))
    expect(await createIdleLoop(deps)(S)).toEqual({ action: "ignored", why: "held" })
    await createEventHook(deps)(idleEvent())
    expect(prompts().length).toBe(0)
    expect(client.created).toEqual([])
    expect(readModeState(wt.worktree, S)).toEqual(modeBefore)
    expect(readFileSync(modeStatePath(wt.worktree, S))).toEqual(modeBytesBefore)
    expect(readFileSync(abortPath(wt.worktree, S))).toEqual(abortBefore)
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

describe("fetchOpenCodeTodos", () => {
  test("uses client.session.todo when present", async () => {
    client.todos = [todo("1", "pending")]
    const t = await fetchOpenCodeTodos(client, S)
    expect(t.map((x) => x.id)).toEqual(["1"])
    expect(client.calls.map((c) => c.method)).toEqual(["todo"])
  })
  test("falls back to the last completed todowrite part in messages()", async () => {
    client = fakeClient({ todoEndpoint: false })
    client.messages = [
      { info: { id: "m1" }, parts: [{ type: "tool", tool: "todowrite", state: { status: "completed", input: { todos: [todo("old", "pending")] }, metadata: {} } }] },
      { info: { id: "m2" }, parts: [{ type: "tool", tool: "todowrite", state: { status: "completed", input: {}, metadata: { todos: [todo("new", "in_progress")] } } }] },
    ]
    const t = await fetchOpenCodeTodos(client, S)
    expect(t.map((x) => x.id)).toEqual(["new"])
    expect(client.calls.map((c) => c.method)).toEqual(["messages"])
  })
  test("an empty endpoint array is authoritative and does not fetch messages", async () => {
    client.todos = []
    client.messages = [{ parts: [{ type: "tool", tool: "todowrite", state: { status: "completed", input: { todos: [todo("fallback", "pending")] } } }] }]
    expect(await fetchOpenCodeTodos(client, S)).toEqual([])
    expect(client.calls.map((c) => c.method)).toEqual(["todo"])
  })
  test("accepts an enveloped endpoint response without losing the session receiver", async () => {
    const expected = [todo("enveloped", "in_progress")]
    const session = {
      async todo(options: { path: { id: string } }) {
        expect(this).toBe(session)
        expect(options.path.id).toBe(S)
        return { data: expected }
      },
      async messages() { throw new Error("authoritative endpoint must prevent fallback") },
    }
    expect(await fetchOpenCodeTodos({ session }, S)).toEqual(expected)
  })
  test.each([null, undefined])("nullish metadata %s falls back to input in enveloped messages", async (todos) => {
    const expected = [todo("input", "pending")]
    const session = {
      async messages(options: { path: { id: string } }) {
        expect(this).toBe(session)
        expect(options.path.id).toBe(S)
        return { data: [{ parts: [{ type: "tool", tool: "todowrite", state: {
          status: "completed", metadata: { todos }, input: { todos: expected },
        } }] }] }
      },
    }
    expect(await fetchOpenCodeTodos({ session }, S)).toEqual(expected)
  })
  test("falls back when the todo endpoint response is malformed", async () => {
    client.session.todo = async (options) => {
      client.calls.push({ method: "todo", args: options })
      return { data: { malformed: true } }
    }
    client.messages = [{ parts: [{ type: "tool", tool: "todowrite", state: { status: "completed", input: { todos: [todo("fallback", "pending")] } } }] }]
    expect(await fetchOpenCodeTodos(client, S)).toEqual([todo("fallback", "pending")])
    expect(client.calls.map((c) => c.method)).toEqual(["todo", "messages"])
  })
  test("selects the newest completed todowrite while skipping incomplete and unrelated tools", async () => {
    client = fakeClient({ todoEndpoint: false })
    client.messages = [
      { parts: [{ type: "tool", tool: "todowrite", state: { status: "completed", input: { todos: [todo("selected", "pending")] } } }] },
      { parts: [
        { type: "tool", tool: "todowrite", state: { status: "running", input: { todos: [todo("running", "pending")] } } },
        { type: "tool", tool: "other", state: { status: "completed", input: { todos: [todo("wrong", "pending")] } } },
      ] },
    ]
    expect(await fetchOpenCodeTodos(client, S)).toEqual([todo("selected", "pending")])
  })
  test("prefers metadata todos and applies normalization defaults", async () => {
    client = fakeClient({ todoEndpoint: false })
    client.messages = [{ parts: [{ type: "tool", tool: "todowrite", state: {
      status: "completed",
      input: { todos: [{ id: "input", content: "not selected" }] },
      metadata: { todos: [{ content: 7 }] },
    } }] }]
    expect(await fetchOpenCodeTodos(client, S)).toEqual([{ id: "0", content: "7", status: "pending", priority: "medium" }])
  })
  test("logs a fixed category for non-Error endpoint rejection and falls back", async () => {
    const logs: Array<{ message: string; extra?: Record<string, unknown> }> = []
    client.session.todo = async () => { throw "private response detail" }
    client.messages = []
    expect(await fetchOpenCodeTodos(client, S, (message, extra) => logs.push({ message, extra }))).toEqual([])
    expect(logs).toEqual([{ message: "todo endpoint threw, falling back to messages()", extra: { error: "non-Error rejection" } }])
    expect(logs[0]?.extra).not.toHaveProperty("private response detail")
    expect(client.calls.map((c) => c.method)).toEqual(["messages"])
  })
  test("falls back when the todo endpoint errors", async () => {
    client.todos = undefined
    client.messages = []
    expect(await fetchOpenCodeTodos(client, S)).toEqual([])
    expect(client.calls.map((c) => c.method)).toEqual(["todo", "messages"])
  })
})

describe("repetition abort (event hook)", () => {
  const phrase = "I will now proceed to read the file and then apply the same change again"
  const loopText = Array.from({ length: 4 }, () => phrase).join(" ")

  test("aborts once and writes abort.json for a repeating assistant part", async () => {
    const deps = makeDeps(client, wt.worktree)
    const { native, event: hook } = await createNativeEventFixture(deps)
    const assistant = await native.deliverAssistantMessage({ text: "short" })
    await hook(messageUpdated(assistant.message))
    const part = assistant.parts.find(candidate => candidate.type === "text")
    if (!part || part.type !== "text") throw new Error("native assistant message did not contain a text part")
    await hook(textPart(part, "short", "short"))
    await hook(textPart(part, loopText, " again"))
    await hook(textPart(part, loopText + " more", " more"))
    expect(client.calls.filter((c) => c.method === "abort").length).toBe(1)
    const note = JSON.parse(readFileSync(abortPath(wt.worktree, S), "utf8"))
    expect(note.reason).toBe("repetition")
    expect(note.partID).toBe(part.id)
  })

  test("never aborts on user parts (role from message.updated, or no delta)", async () => {
    const deps = makeDeps(client, wt.worktree)
    const { native, event: hook } = await createNativeEventFixture(deps)
    const user = await native.deliverUserTurn({ text: loopText })
    await hook(messageUpdated(user.message))
    const part = user.parts.find(candidate => candidate.type === "text")
    if (!part || part.type !== "text") throw new Error("native user message did not contain a text part")
    await hook(textPart(part, loopText))
    await hook(textPart(part, loopText, "x"))
    await hook(textPart({ ...part, id: "unmatched-part", messageID: "unmatched-message" }, loopText))
    expect(client.calls.filter((c) => c.method === "abort").length).toBe(0)
    expect(existsSync(abortPath(wt.worktree, S))).toBe(false)
  })

  test("abort_on_repetition=false only logs", async () => {
    const deps = makeDeps(client, wt.worktree, { guards: { ...makeDeps(client, wt.worktree).config.guards, abort_on_repetition: false } })
    const { native, event: hook } = await createNativeEventFixture(deps)
    const assistant = await native.deliverAssistantMessage({ text: "short" })
    await hook(messageUpdated(assistant.message))
    const part = assistant.parts.find(candidate => candidate.type === "text")
    if (!part || part.type !== "text") throw new Error("native assistant message did not contain a text part")
    await hook(textPart(part, loopText, "x"))
    expect(client.calls.filter((c) => c.method === "abort").length).toBe(0)
    expect(deps.logs).toContain("repetition detected")
  })

  test("tool error parts increment loop failures while active", async () => {
    writeModeState(wt.worktree, S, ulw())
    const deps = makeDeps(client, wt.worktree)
    const native = await createNativeEventFixture(deps)
    const hook = native.event
    const before = createToolBeforeHook(deps)
    const err = (call: { part: unknown; input: { args: Record<string, unknown> } }) => ({
      event: { type: "message.part.updated", properties: { part: {
        ...(call.part as object),
        state: {
          status: "error",
          error: "Error: File already exists",
          input: call.input.args,
          time: { start: (call.part as any).state.time.start, end: Date.now() },
        },
      } } } as any,
    })
    const call1 = await native.primeCall({ tool: "write", args: { filePath: "a.ts" }, callID: "c1" })
    await before(call1.input as any, call1.output as any)
    await hook(err(call1))
    await hook(err(call1)) // duplicate update of the same call is ignored
    const call2 = await native.primeCall({ tool: "write", args: { filePath: "b.ts" }, callID: "c2" })
    await before(call2.input as any, call2.output as any)
    await hook(err(call2))
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
