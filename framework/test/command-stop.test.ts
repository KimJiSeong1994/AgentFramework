import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCommandHook, STOP_COMMAND, STOP_DESCRIPTION, STOP_TEMPLATE } from "../src/hooks/command.ts"
import { createConfigHook } from "../src/hooks/config.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { createDelegateTool } from "../src/tools/delegate.ts"
import { readLedger } from "../src/state/ledger.ts"
import { abortPath, EMPTY_MODE, readModeState, writeModeState } from "../src/state/store.ts"
import { detectMode } from "../src/modes/detect.ts"
import { fakeClient, makeDeps, tempGitWorktree, type FakeClient } from "./guards-helpers.ts"
import { fakeDeps } from "./helpers.ts"

const S = "ses_main"
let wt: ReturnType<typeof tempGitWorktree>
let client: FakeClient
beforeEach(() => {
  wt = tempGitWorktree()
  client = fakeClient({ promptAsync: true })
})
afterEach(() => wt.cleanup())

describe("/stop", () => {
  test("config hook registers the stop command; a user-defined one wins", async () => {
    const cfg: any = {}
    await createConfigHook(fakeDeps(wt.worktree))(cfg)
    expect(cfg.command[STOP_COMMAND]).toEqual({ template: STOP_TEMPLATE, description: STOP_DESCRIPTION })
    const own: any = { command: { stop: { template: "mine" } } }
    await createConfigHook(fakeDeps(wt.worktree))(own)
    expect(own.command.stop.template).toBe("mine")
    const off: any = {}
    await createConfigHook(fakeDeps(wt.worktree, { disabled_hooks: ["command.stop"] }))(off)
    expect(off.command?.stop).toBeUndefined()
  })

  test("the template text is itself a cancel keyword for chat.message", () => {
    expect(detectMode(STOP_TEMPLATE)).toEqual({ mode: "none", cancel: true })
  })

  test("writes the abort marker, deactivates the mode, aborts the running child and cancels the rest", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false } as any })
    const hook = createCommandHook(deps)
    const q = getQueue(getOpenCodeRuntime(deps))
    writeModeState(wt.worktree, S, { ...EMPTY_MODE, mode: "ulw", active: true, startedAt: Date.now(), updatedAt: Date.now() })
    let release: (() => void) | undefined
    client.replies.worker = (o, nth) =>
      nth === 1 ? { text: "one", run: () => new Promise<void>((r) => (release = r)) } : { text: "never" }
    q.add(S, [{ title: "a" }, { title: "b" }])
    const running = q.run(S)
    while (!release) await new Promise((r) => setTimeout(r, 5))

    await hook({ command: STOP_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    expect(existsSync(abortPath(wt.worktree, S))).toBe(true)
    const st = readModeState(wt.worktree, S)
    expect(st.active).toBe(false)
    expect(st.stopReason).toBe("user_stop")
    expect(client.calls.some((c) => c.method === "abort" && (c.args as any).path.id === "child_1")).toBe(true)
    release!()
    const run = await running
    expect(run.aborted).toBe(true)
    expect(readLedger(wt.worktree, S).tasks.map((t) => t.status)).toEqual(["cancelled", "cancelled"])
  })

  test("a user_stop marker survives a delegate attempt and is lifted only by a new user message", async () => {
    const deps = makeDeps(client, wt.worktree)
    await createCommandHook(deps)({ command: STOP_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    // the /stop template itself flows through chat.message as a cancel: marker stays
    const stopPart: any = { type: "text", text: STOP_TEMPLATE }
    await createChatMessageHook(deps)({ sessionID: S, agent: "main" }, { message: {} as any, parts: [stopPart] })
    expect(existsSync(abortPath(wt.worktree, S))).toBe(true)
    // delegate refuses while the marker is a user_stop
    const tool = createDelegateTool(deps)
    await expect(tool.execute({ tasks: [{ title: "x" }] }, { sessionID: S, agent: "main", abort: new AbortController().signal, metadata() {} } as any)).rejects.toThrow(/stopped the task queue/)
    // an ordinary new user message lifts it
    const part: any = { type: "text", text: "ok, now please add the docs" }
    await createChatMessageHook(deps)({ sessionID: S, agent: "main" }, { message: {} as any, parts: [part] })
    expect(existsSync(abortPath(wt.worktree, S))).toBe(false)
  })

  test("other commands are ignored; a later mode activation clears the marker", async () => {
    const deps = makeDeps(client, wt.worktree)
    await createCommandHook(deps)({ command: "init", sessionID: S, arguments: "" }, { parts: [] })
    expect(existsSync(abortPath(wt.worktree, S))).toBe(false)
    await createCommandHook(deps)({ command: STOP_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    expect(existsSync(abortPath(wt.worktree, S))).toBe(true)
    const part: any = { type: "text", text: "ulw: fix the tests" }
    await createChatMessageHook(deps)({ sessionID: S, agent: "main" }, { message: {} as any, parts: [part] })
    expect(existsSync(abortPath(wt.worktree, S))).toBe(false)
    expect(readModeState(wt.worktree, S).mode).toBe("ulw")
  })

  test("chat.message never detects modes in worker/reviewer sessions", async () => {
    const deps = makeDeps(client, wt.worktree)
    const part: any = { type: "text", text: "Task 1 of 3: ulw everything, 끝까지" }
    await createChatMessageHook(deps)({ sessionID: "child_1", agent: "worker" }, { message: {} as any, parts: [part] })
    expect(part.text).not.toContain("<lca-mode")
    expect(readModeState(wt.worktree, "child_1").mode).toBe("none")
    writeFileSync(join(wt.worktree, "unused.txt"), "")
  })
})
