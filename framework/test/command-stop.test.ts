import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  consumeContinueReceipt, CONTINUE_COMMAND, createCommandHook, STOP_COMMAND, STOP_DESCRIPTION, STOP_TEMPLATE,
} from "../src/hooks/command.ts"
import { consumeCommandTurn } from "../src/hooks/command-turns.ts"
import { createConfigHook } from "../src/hooks/config.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { createDelegateTool } from "../src/tools/delegate.ts"
import { readLedger } from "../src/state/ledger.ts"
import { abortPath, EMPTY_MODE, readModeState, writeModeState } from "../src/state/store.ts"
import { detectMode } from "../src/modes/detect.ts"
import { admissionEpoch, effectiveHold } from "../src/sessions/admission.ts"
import { admitFixtureSession, fakeClient, makeDeps, releaseFixtureSession, tempGitWorktree, type FakeClient } from "./guards-helpers.ts"
import { fakeDeps } from "./helpers.ts"
import { createBoundNativeToolChildFixture, createNativeToolFixture } from "./native-tool-fixture.ts"

const S = "ses_main"
let wt: ReturnType<typeof tempGitWorktree>
let client: FakeClient
let fixtureSession: ReturnType<typeof admitFixtureSession>
beforeEach(() => {
  wt = tempGitWorktree()
  client = fakeClient({ promptAsync: true })
  fixtureSession = admitFixtureSession(makeDeps(client, wt.worktree), S)
})
afterEach(() => {
  while (consumeCommandTurn(S)) { /* drop marks no chat turn consumed so later files start clean */ }
  releaseFixtureSession(wt.worktree, fixtureSession)
  wt.cleanup()
})

function exposeVendorSession(): void {
  ;(client.session as any).get = async (request: unknown) => {
    client.calls.push({ method: "session.get", args: request })
    return { data: { id: S, directory: wt.worktree, time: { created: 1, updated: 2 } } }
  }
  ;(client.session as any).status = async () => ({ data: {} })
  ;(client.session as any).messages = async () => ({ data: [] })
}

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
    await createConfigHook(deps)({})
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

  test("a user_stop marker survives delegate attempts and ordinary messages; only explicit Resume lifts it", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await createNativeToolFixture(deps, { sessionID: S })
    const command = createCommandHook(deps)
    await createConfigHook(deps)({})
    await command({ command: STOP_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    const stoppedEpoch = fixtureSession.epoch
    // the /stop template itself flows through chat.message as a cancel: marker stays
    await native.deliverUserTurn({ text: STOP_TEMPLATE })
    expect(existsSync(abortPath(wt.worktree, S))).toBe(true)
    // delegate refuses while the marker is a user_stop
    const tool = createDelegateTool(deps)
    await expect(tool.execute({ tasks: [{ title: "x" }] }, { sessionID: S, agent: "main", abort: new AbortController().signal, metadata() {} } as any)).rejects.toThrow(/stopped the task queue/)
    // an ordinary new user message lifts it
    await native.deliverUserTurn({ text: "ok, now please add the docs" })
    expect(existsSync(abortPath(wt.worktree, S))).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)

    exposeVendorSession()
    await command({ command: CONTINUE_COMMAND, sessionID: S, arguments: "confirm" }, { parts: [] })
    expect(consumeContinueReceipt(deps, S, "confirm")).toContain("admission resumed")
    expect(existsSync(abortPath(wt.worktree, S))).toBe(false)
    expect(admissionEpoch(wt.worktree, S)).toBe(stoppedEpoch)
  })

  test("other commands are ignored; a later mode activation cannot clear the stop", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await createNativeToolFixture(deps, { sessionID: S })
    await createCommandHook(deps)({ command: "init", sessionID: S, arguments: "" }, { parts: [] })
    expect(existsSync(abortPath(wt.worktree, S))).toBe(false)
    await createConfigHook(deps)({})
    await createCommandHook(deps)({ command: STOP_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    expect(existsSync(abortPath(wt.worktree, S))).toBe(true)
    await native.deliverUserTurn({ text: "ulw: fix the tests" })
    expect(existsSync(abortPath(wt.worktree, S))).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(readModeState(wt.worktree, S).mode).toBe("none")
  })

  test("chat.message never detects modes in worker/reviewer sessions", async () => {
    const deps = makeDeps(client, wt.worktree)
    const child = await createBoundNativeToolChildFixture(deps, { sessionID: "child_1", ownerSessionID: S, role: "worker" })
    try {
      const { parts } = await child.native.deliverUserTurn({ text: "Task 1 of 3: ulw everything, 끝까지" })
      const part = parts.find(candidate => candidate.type === "text")
      if (!part || part.type !== "text") throw new Error("native child turn did not contain a text part")
      expect(part.text).not.toContain("<otter-mode")
      expect(readModeState(wt.worktree, "child_1").mode).toBe("none")
    } finally {
      child.cleanup()
    }
  })
})
