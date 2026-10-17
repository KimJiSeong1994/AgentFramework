import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Part, TextPart, UserMessage } from "@opencode-ai/sdk"
import { DEFAULT_CONFIG } from "../src/config.ts"
import type { HookDeps } from "../src/hooks/types.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createConfigHook } from "../src/hooks/config.ts"
import { EMPTY_MODE, readJson, readModeState, sessionInfoPath, writeModeState } from "../src/state/store.ts"
import type { SessionInfo } from "../src/state/store.ts"
import { MODE_INSTRUCTIONS, modeSuffix, stripModeSuffix } from "../src/modes/instructions.ts"
import { admitFixtureSession, fakeClient, releaseFixtureSession, tempWorktree, type TempWorktree } from "./guards-helpers.ts"

const SESSION = "ses_test"
let messageNumber = 0
let partNumber = 0

function textPart(text: string, synthetic = false): TextPart {
  return { id: `prt_${++partNumber}`, sessionID: SESSION, messageID: "msg_unbound", type: "text", text, synthetic }
}

function message(): UserMessage {
  return {
    id: "msg_1",
    sessionID: SESSION,
    role: "user",
    time: { created: Date.now() },
    agent: "main",
    model: { providerID: "ollama", modelID: "gemma4:26b" },
  }
}

let fixture: TempWorktree
let worktree: string
let logs: Array<{ msg: string; extra?: Record<string, unknown> }>
let deps: HookDeps
let fixtureSession: ReturnType<typeof admitFixtureSession>

beforeEach(() => {
  fixture = tempWorktree()
  worktree = fixture.worktree
  logs = []
  const client = fakeClient()
  ;(client.session as any).get = async () => ({
    data: { id: SESSION, directory: worktree, time: { created: 1, updated: 2 } },
  })
  deps = {
    client: client as unknown as HookDeps["client"],
    directory: worktree,
    worktree,
    config: DEFAULT_CONFIG,
    log: (msg, extra) => logs.push({ msg, extra }),
  }
  fixtureSession = admitFixtureSession(deps, SESSION)
})

afterEach(() => {
  releaseFixtureSession(worktree, fixtureSession)
  fixture.cleanup()
})

async function run(parts: Part[], agent = "main", messageID = `msg_${++messageNumber}`) {
  await createConfigHook(deps)({})
  const hook = createChatMessageHook(deps)
  for (const part of parts) part.messageID = messageID
  await hook({ sessionID: SESSION, agent, model: { providerID: "ollama", modelID: "gemma4:26b" } }, {
    message: { ...message(), id: messageID, agent }, parts,
  })
}

describe("chat.message hook", () => {
  test("appends the ulw suffix once and writes mode.json", async () => {
    const part = textPart("ultrawork: make the tests pass")
    await run([part])
    expect(part.text.endsWith(modeSuffix("ulw"))).toBe(true)
    expect(part.text.split("<otter-mode").length - 1).toBe(1)
    expect(stripModeSuffix(part.text)).toBe("ultrawork: make the tests pass")
    const state = readModeState(worktree, SESSION)
    expect(state.mode).toBe("ulw")
    expect(state.active).toBe(true)
    expect(state.iterations).toBe(0)
    expect(state.startedAt).toBeGreaterThan(0)
    // A replay cannot dispatch again or double-append the retained part.
    await expect(run([part], "main", part.messageID)).rejects.toThrow("stale-turn")
    expect(part.text.split("<otter-mode").length - 1).toBe(1)
  })

  test("uses the last non-synthetic text part", async () => {
    // flow off: legacy plan suffix mode (with flow on, D3 maps the plan keyword to the /plan workflow instead)
    deps = { ...deps, config: { ...DEFAULT_CONFIG, flow: { ...DEFAULT_CONFIG.flow, enabled: false } } }
    const real = textPart("plan mode for auth")
    const synthetic = textPart("ultrawork", true)
    await run([real, synthetic])
    expect(real.text).toContain(MODE_INSTRUCTIONS.plan)
    expect(synthetic.text).toBe("ultrawork")
    expect(readModeState(worktree, SESSION).mode).toBe("plan")
  })

  test("records session info once", async () => {
    await run([textPart("hello")])
    const info = readJson<SessionInfo | null>(sessionInfoPath(worktree, SESSION), null)
    expect(info?.agent).toBe("main")
    expect(info?.model).toBe("ollama/gemma4:26b")
    expect(info?.createdAt).toBeGreaterThan(0)
    await run([textPart("again")], "main")
    expect(readJson<SessionInfo | null>(sessionInfoPath(worktree, SESSION), null)).toEqual(info)
  })

  test("an unbound worker cannot create session metadata or start a mode", async () => {
    await expect(run([textPart("ultrawork")], "worker")).rejects.toThrow("unknown-role")
    expect(readJson<SessionInfo | null>(sessionInfoPath(worktree, SESSION), null)).toBeNull()
    expect(readModeState(worktree, SESSION)).toEqual(EMPTY_MODE)
  })

  test("plain message with no active mode leaves the text untouched", async () => {
    const part = textPart("rename the function")
    await run([part])
    expect(part.text).toBe("rename the function")
    expect(readModeState(worktree, SESSION)).toEqual(EMPTY_MODE)
  })

  test("re-appends the suffix while the mode is active", async () => {
    writeModeState(worktree, SESSION, { ...EMPTY_MODE, mode: "ulw", active: true, startedAt: Date.now(), iterations: 3 })
    const part = textPart("continue")
    await run([part])
    expect(part.text).toBe("continue" + modeSuffix("ulw"))
    expect(readModeState(worktree, SESSION).iterations).toBe(3)
  })

  test("expired mode is not re-appended and is deactivated", async () => {
    const startedAt = Date.now() - DEFAULT_CONFIG.loop.ttl_ms - 1000
    writeModeState(worktree, SESSION, { ...EMPTY_MODE, mode: "ulw", active: true, startedAt })
    const part = textPart("continue")
    await run([part])
    expect(part.text).toBe("continue")
    const state = readModeState(worktree, SESSION)
    expect(state.active).toBe(false)
    expect(state.stopReason).toBe("ttl_expired")
  })

  test("cancel clears the state and appends the cancel marker when a mode was active", async () => {
    writeModeState(worktree, SESSION, { ...EMPTY_MODE, mode: "ulw", active: true, startedAt: Date.now() })
    const part = textPart("/stop")
    await run([part])
    expect(part.text).toBe("/stop" + modeSuffix("cancel"))
    const state = readModeState(worktree, SESSION)
    expect(state.active).toBe(false)
    expect(state.mode).toBe("none")
    expect(state.stopReason).toBe("user_cancel")
  })

  test("cancel with no active mode only records the state", async () => {
    const part = textPart("그만해")
    await run([part])
    expect(part.text).toBe("그만해")
    expect(readModeState(worktree, SESSION).stopReason).toBe("user_cancel")
  })

  test("a message with no genuine text cannot authorize inference or change mode", async () => {
    await expect(run([])).rejects.toThrow("invalid-turn")
    expect(readModeState(worktree, SESSION)).toEqual(EMPTY_MODE)
  })
})
