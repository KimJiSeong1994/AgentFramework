import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Part, TextPart, UserMessage } from "@opencode-ai/sdk"
import { DEFAULT_CONFIG } from "../src/config.ts"
import type { HookDeps } from "../src/hooks/types.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { EMPTY_MODE, readJson, readModeState, sessionInfoPath, writeModeState } from "../src/state/store.ts"
import type { SessionInfo } from "../src/state/store.ts"
import { MODE_INSTRUCTIONS, modeSuffix, stripModeSuffix } from "../src/modes/instructions.ts"

const SESSION = "ses_test"

function textPart(text: string, synthetic = false): TextPart {
  return { id: "prt_1", sessionID: SESSION, messageID: "msg_1", type: "text", text, synthetic }
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

let worktree: string
let logs: Array<{ msg: string; extra?: Record<string, unknown> }>
let deps: HookDeps

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "lca-chat-"))
  logs = []
  deps = {
    client: {} as HookDeps["client"],
    directory: worktree,
    worktree,
    config: DEFAULT_CONFIG,
    log: (msg, extra) => logs.push({ msg, extra }),
  }
})

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true })
})

async function run(parts: Part[], agent = "main") {
  const hook = createChatMessageHook(deps)
  await hook({ sessionID: SESSION, agent, model: { providerID: "ollama", modelID: "gemma4:26b" } }, { message: message(), parts })
}

describe("chat.message hook", () => {
  test("appends the ulw suffix once and writes mode.json", async () => {
    const part = textPart("ultrawork: make the tests pass")
    await run([part])
    expect(part.text.endsWith(modeSuffix("ulw"))).toBe(true)
    expect(part.text.split("<lca-mode").length - 1).toBe(1)
    expect(stripModeSuffix(part.text)).toBe("ultrawork: make the tests pass")
    const state = readModeState(worktree, SESSION)
    expect(state.mode).toBe("ulw")
    expect(state.active).toBe(true)
    expect(state.iterations).toBe(0)
    expect(state.startedAt).toBeGreaterThan(0)
    // running the hook again on the same (already-suffixed) part does not double-append
    await run([part])
    expect(part.text.split("<lca-mode").length - 1).toBe(1)
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
    await run([textPart("hello")], "worker")
    const info = readJson<SessionInfo | null>(sessionInfoPath(worktree, SESSION), null)
    expect(info?.agent).toBe("worker")
    expect(info?.model).toBe("ollama/gemma4:26b")
    expect(info?.createdAt).toBeGreaterThan(0)
    await run([textPart("again")], "main")
    expect(readJson<SessionInfo | null>(sessionInfoPath(worktree, SESSION), null)?.agent).toBe("worker")
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

  test("a message with no text part is a no-op", async () => {
    await run([])
    expect(readModeState(worktree, SESSION)).toEqual(EMPTY_MODE)
  })
})
