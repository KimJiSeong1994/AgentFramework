import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import type { UserMessage } from "@opencode-ai/sdk"
import { createConfigHook } from "../src/hooks/config.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import {
  assertOpenCodeSystemHeaders, assertOpenCodeSystemMessages, assertOpenCodeSystemMessageTurn,
  assertOpenCodeSystemParams, assertOpenCodeSystemTransformOutput, bindOpenCodeSystemTurn,
  captureOpenCodeAgentConfigSafety, createOpenCodeSystemTransformHook, hashOpenCodeSystem,
  captureOpenCodeToolTurn, isOpenCodeToolTurnCurrent, reserveOpenCodeSystemTurn,
} from "../src/hosts/opencode-system.ts"
import { attachAdmission, holdAdmission, resumeAdmission } from "../src/sessions/admission.ts"
import { fakeClient, makeDeps, tempWorktree } from "./guards-helpers.ts"

const SID = "ses_system_boundary"
let fixture: ReturnType<typeof tempWorktree>
let deps: ReturnType<typeof makeDeps>
let runtime: ReturnType<typeof getOpenCodeRuntime>
let vendor: Parameters<NonNullable<Hooks["config"]>>[0]

beforeEach(async () => {
  fixture = tempWorktree()
  deps = makeDeps(fakeClient(), fixture.worktree)
  runtime = getOpenCodeRuntime(deps)
  attachAdmission(runtime, SID, { engine: "opencode" })
  vendor = {}
  await createConfigHook(deps)(vendor)
})
afterEach(() => fixture.cleanup())

function turn(id: string, extra: Partial<UserMessage> = {}) {
  const message: UserMessage = {
    id, sessionID: SID, role: "user", time: { created: 10 }, agent: "main",
    model: { providerID: "ollama", modelID: "fixture-model" }, ...extra,
  }
  const input = { sessionID: message.sessionID, agent: message.agent, messageID: id }
  const output = {
    message,
    parts: [{ id: `part_${id}`, sessionID: message.sessionID, messageID: id, type: "text" as const, text: "Genuine user input stays unchanged." }],
  }
  return { input, output }
}

function bind(value: ReturnType<typeof turn>) {
  const lease = reserveOpenCodeSystemTurn(deps, value.input.sessionID, value.output.message.id)
  bindOpenCodeSystemTurn(deps, value.input, value.output, lease)
}

async function transformed(sessionID = SID) {
  const system = ["Unchecked vendor skill description", "Unchecked vendor body and metadata"]
  const output = { system }
  await createOpenCodeSystemTransformHook(deps)({ sessionID, model: {} as never }, output)
  expect(output.system).toBe(system)
  return output.system
}

test("native system replacement preserves the SDK array, exact frozen role bytes and user parts", async () => {
  const value = turn("msg_owned")
  const original = structuredClone(value.output)
  const policy = runtime.policy.resolve("main")
  const identity = policy.id
  bind(value)
  const system = await transformed()
  expect(system).toEqual([...policy.system])
  expect(hashOpenCodeSystem(system)).toBe(hashOpenCodeSystem(policy.system))
  expect(assertOpenCodeSystemTransformOutput(deps, SID, system, system)).toBe(hashOpenCodeSystem(policy.system))
  assertOpenCodeSystemMessageTurn(deps, SID, "main", value.output.message)
  const frame = { sessionID: SID, agent: "main", message: value.output.message, model: {} as never, provider: {} as never }
  assertOpenCodeSystemParams(deps, frame)
  assertOpenCodeSystemHeaders(deps, frame)
  assertOpenCodeSystemMessages(deps, [{ info: value.output.message, parts: value.output.parts }])
  expect(value.output).toEqual(original)
  expect(runtime.policy.resolve("main").id).toBe(identity)
})

test("unknown and missing channels cannot preserve a native system fallback", async () => {
  await expect(transformed()).rejects.toThrow("missing-turn")
  await expect(transformed("ses_unknown")).rejects.toThrow("missing-turn")
})

test("foreign or auxiliary provider roles refuse without poisoning the actual main turn", async () => {
  const value = turn("msg_auxiliary")
  bind(value)
  for (const role of ["title", "compaction", "worker", "planner", "unknown"]) {
    expect(() => assertOpenCodeSystemMessageTurn(deps, SID, role, value.output.message)).toThrow("unknown-role")
    expect(await transformed()).toEqual([...runtime.policy.resolve("main").system])
  }
  assertOpenCodeSystemMessageTurn(deps, SID, "main", value.output.message)
})

test("stop and same-epoch Resume cannot revive an old main channel", async () => {
  bind(turn("msg_before_stop"))
  holdAdmission(fixture.worktree, SID, "test-system-stop")
  resumeAdmission(runtime, SID)
  await expect(transformed()).rejects.toThrow("held-owner")
  bind(turn("msg_after_resume"))
  expect(await transformed()).toEqual([...runtime.policy.resolve("main").system])
})

test("a delayed bind, replayed reservation or stale provider frame cannot invalidate a newer turn", async () => {
  const old = turn("msg_old")
  const oldLease = reserveOpenCodeSystemTurn(deps, SID, old.output.message.id)
  const current = turn("msg_current")
  bind(current)
  expect(() => bindOpenCodeSystemTurn(deps, old.input, old.output, oldLease)).toThrow("stale-turn")
  expect(() => reserveOpenCodeSystemTurn(deps, SID, old.output.message.id)).toThrow("stale-turn")
  expect(() => assertOpenCodeSystemMessageTurn(deps, SID, "main", old.output.message)).toThrow("stale-turn")
  expect(await transformed()).toEqual([...runtime.policy.resolve("main").system])
  assertOpenCodeSystemMessageTurn(deps, SID, "main", current.output.message)
  expect(() => bindOpenCodeSystemTurn(deps, current.input, current.output)).toThrow("stale-turn")
  expect(await transformed()).toEqual([...runtime.policy.resolve("main").system])
})

test("explicit trusted system bytes are accepted, arbitrary or later-mutated system input is refused", async () => {
  const trusted = runtime.policy.resolve("main").system.join("\n\n")
  const explicit = turn("msg_explicit", { system: trusted })
  bind(explicit)
  expect(await transformed()).toEqual([...runtime.policy.resolve("main").system])
  explicit.output.message.system = "changed after binding"
  expect(() => assertOpenCodeSystemMessageTurn(deps, SID, "main", explicit.output.message)).toThrow("system-mismatch")
  await expect(transformed()).rejects.toThrow("missing-turn")
  expect(() => bind(turn("msg_custom_system", { system: "unchecked native instructions" }))).toThrow("system-mismatch")
})

test("effective custom prompts, global instructions and unbound roles never become system authority", async () => {
  expect(() => bind(turn("msg_unknown_role", { agent: "unknown" }))).toThrow("unknown-role")
  expect(() => bind(turn("msg_unbound_planner", { agent: "planner" }))).toThrow("unknown-role")
  vendor.agent!.main!.prompt = "unapproved prompt override"
  expect(() => bind(turn("msg_unsafe_config"))).toThrow("unsafe-config")
  vendor.agent!.main!.prompt = runtime.policy.resolve("main").system.join("\n\n")
  vendor.instructions = ["unapproved-extra-instructions.md"]
  expect(() => bind(turn("msg_unsafe_instructions"))).toThrow("unsafe-config")
  vendor.instructions = []
  expect(() => bind(turn("msg_restored_unsafe_instructions"))).toThrow("unsafe-config")
})

test("a preexisting user prompt override is recorded before configuration injection", () => {
  const unsafe = { agent: { main: { prompt: "user override" } } }
  captureOpenCodeAgentConfigSafety(deps, unsafe, runtime.policy)
  unsafe.agent.main.prompt = runtime.policy.resolve("main").system.join("\n\n")
  expect(() => bind(turn("msg_hidden_override"))).toThrow("unsafe-config")
})

test("a replacement array is not mistaken for effective SDK system mutation", async () => {
  bind(turn("msg_array_identity"))
  const system = await transformed()
  expect(() => assertOpenCodeSystemTransformOutput(deps, SID, system, [...system])).toThrow("transform-unavailable")
  await expect(transformed()).rejects.toThrow("missing-turn")
})

test("mixed-session message transforms refuse without cancelling either valid channel", async () => {
  const first = turn("msg_first")
  bind(first)
  const otherSID = "ses_other_system"
  attachAdmission(runtime, otherSID, { engine: "opencode" })
  const second = turn("msg_second", { sessionID: otherSID })
  bind(second)
  expect(() => assertOpenCodeSystemMessages(deps, [
    { info: first.output.message, parts: first.output.parts },
    { info: second.output.message, parts: second.output.parts },
  ])).toThrow("stale-turn")
  expect(await transformed()).toEqual([...runtime.policy.resolve("main").system])
  expect(await transformed(otherSID)).toEqual([...runtime.policy.resolve("main").system])
})

test("native tool-turn proof is opaque and fenced to one channel incarnation", () => {
  const first = turn("msg_tool_turn_first")
  bind(first)
  const capability = captureOpenCodeToolTurn(deps, SID)!
  expect(capability).toMatchObject({
    kind: "main", sessionID: SID, userMessageID: first.output.message.id,
    supervisorSessionID: SID, role: "main", policy: runtime.policy.resolve("main"),
  })
  expect(Object.isFrozen(capability)).toBe(true)
  expect(isOpenCodeToolTurnCurrent(deps, capability)).toBe(true)
  expect(isOpenCodeToolTurnCurrent(deps, { ...capability })).toBe(false)

  bind(turn("msg_tool_turn_second"))
  expect(isOpenCodeToolTurnCurrent(deps, capability)).toBe(false)
  expect(isOpenCodeToolTurnCurrent(deps, captureOpenCodeToolTurn(deps, SID))).toBe(true)
})

test("reserved or same-epoch resumed channels never yield or revive a native tool-turn proof", () => {
  const first = turn("msg_tool_turn_before_resume")
  bind(first)
  const capability = captureOpenCodeToolTurn(deps, SID)!
  holdAdmission(fixture.worktree, SID, "test-tool-turn-stop")
  resumeAdmission(runtime, SID)
  expect(isOpenCodeToolTurnCurrent(deps, capability)).toBe(false)
  expect(() => captureOpenCodeToolTurn(deps, SID)).toThrow("missing-turn")

  const reserved = turn("msg_tool_turn_reserved")
  reserveOpenCodeSystemTurn(deps, SID, reserved.output.message.id)
  expect(() => captureOpenCodeToolTurn(deps, SID)).toThrow("missing-turn")
})
