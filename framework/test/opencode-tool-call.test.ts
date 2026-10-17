import { afterEach, beforeEach, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk"
import { createConfigHook } from "../src/hooks/config.ts"
import { admitOpenCodeToolCall, completeOpenCodeToolCall, currentOpenCodeToolCall, isOpenCodeToolCallCurrent, openCodeToolCallArgumentsMatch, UnsafeOpenCodeToolCall } from "../src/hosts/opencode-tool-call.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { bindOpenCodeSystemTurn, reserveOpenCodeSystemTurn } from "../src/hosts/opencode-system.ts"
import { admissionEpoch, attachAdmission, holdAdmission, resumeAdmission } from "../src/sessions/admission.ts"
import {
  authenticatedSDKSessionIdentity, captureSDKSessionCreationObservation, captureSDKSessionIdentity, captureSDKSessionOwner,
  type SDKSessionIdentity,
} from "../src/sessions/sdk-transcript.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const OWNER_SID = "ses_tool_owner"
const CHILD_SID = "ses_tool_child"
type TurnFixture = { input: { sessionID: string; agent: string; messageID: string }; output: { message: UserMessage; parts: unknown[] } }

let fixture: ReturnType<typeof tempWorktree>
let client: FakeClient
let deps: ReturnType<typeof makeDeps>
let runtime: ReturnType<typeof getOpenCodeRuntime>
let sdkGet: (options: { path: { id: string }; query: { directory: string } }) => Promise<{ data?: unknown; error?: unknown }>
let sessionIdentities: Map<string, SDKSessionIdentity>
let sessionRevisions: Map<string, { createdAt: number; updatedAt: number }>

function seedAuthenticatedSession(sessionID: string, parentID?: string): SDKSessionIdentity {
  const createdAt = sessionID === OWNER_SID ? 100 : 200
  const ownerEpoch = parentID ? admissionEpoch(deps.worktree, parentID) : undefined
  if (parentID && !ownerEpoch) throw new Error(`missing live owner epoch for ${sessionID}`)
  const identity: SDKSessionIdentity = {
    directory: realpathSync.native(deps.directory),
    ...(parentID ? { parentID, parentEpoch: ownerEpoch! } : {}),
    createdAt,
    updatedAt: createdAt + 5,
  }
  expect(captureSDKSessionCreationObservation(deps.worktree, sessionID, identity)).toBe(true)
  if (parentID) captureSDKSessionOwner(deps.worktree, sessionID, parentID, createdAt)
  sessionIdentities.set(sessionID, identity)
  sessionRevisions.set(sessionID, { createdAt, updatedAt: createdAt + 100 })
  return identity
}

function sdkSessionSnapshot(sessionID: string, directory: string): Record<string, unknown> {
  const identity = sessionIdentities.get(sessionID)
  const revision = sessionRevisions.get(sessionID)
  if (!identity || !revision) throw new Error(`missing authenticated SDK fixture for ${sessionID}`)
  return {
    id: sessionID,
    directory,
    ...(identity.parentID ? { parentID: identity.parentID } : {}),
    time: { created: revision.createdAt, updated: revision.updatedAt },
  }
}

beforeEach(async () => {
  fixture = tempWorktree()
  client = fakeClient()
  deps = makeDeps(client, fixture.worktree)
  runtime = getOpenCodeRuntime(deps)
  attachAdmission(runtime, OWNER_SID, { engine: "opencode" })
  await createConfigHook(deps)({})
  sessionIdentities = new Map()
  sessionRevisions = new Map()
  seedAuthenticatedSession(OWNER_SID)
  sdkGet = async ({ path, query }) => {
    client.calls.push({ method: "get", args: { path, query } })
    return { data: sdkSessionSnapshot(path.id, query.directory) }
  }
  ;(client.session as unknown as { get: typeof sdkGet }).get = sdkGet
})

afterEach(() => fixture.cleanup())

function userTurn(messageID: string, sessionID = OWNER_SID, role = "main", system?: string): TurnFixture {
  const message: UserMessage = {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: 10 },
    agent: role,
    model: { providerID: "fixture", modelID: "tool-call-test" },
    ...(system === undefined ? {} : { system }),
  }
  return {
    input: { sessionID, agent: role, messageID },
    output: {
      message,
      parts: [{ id: `part_${messageID}`, sessionID, messageID, type: "text", text: "Unmodified user request." }],
    },
  }
}

function bindTurn(value: TurnFixture): void {
  const lease = reserveOpenCodeSystemTurn(deps, value.input.sessionID, value.output.message.id)
  bindOpenCodeSystemTurn(deps, value.input, value.output as never, lease)
}

function sdkMessages(options: {
  sessionID?: string
  userMessageID: string
  userAgent?: string
  assistantMessageID: string
  assistantParentID?: string
  callID: string
  tool?: string
  args: Record<string, unknown>
  status?: "pending" | "running" | "completed"
}): unknown[] {
  const sessionID = options.sessionID ?? OWNER_SID
  const user = userTurn(options.userMessageID, sessionID, options.userAgent ?? "main").output.message
  const assistant = {
    id: options.assistantMessageID,
    sessionID,
    role: "assistant",
    time: { created: 11 },
    parentID: options.assistantParentID ?? options.userMessageID,
    modelID: "fixture-model",
    providerID: "fixture",
    mode: options.userAgent ?? "main",
    path: { cwd: fixture.worktree, root: fixture.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } satisfies AssistantMessage
  const state = options.status === "pending"
    ? { status: "pending" as const, input: options.args, raw: "" }
    : options.status === "completed"
      ? { status: "completed" as const, input: options.args, output: "result must not be consumed", title: "read", metadata: {}, time: { start: 1, end: 2 } }
      : { status: "running" as const, input: options.args, time: { start: 1 } }
  return [
    { info: user, parts: [] },
    { info: assistant, parts: [{
      id: `tool_part_${options.callID}`,
      sessionID,
      messageID: options.assistantMessageID,
      type: "tool",
      callID: options.callID,
      tool: options.tool ?? "read",
      state,
    }] },
  ]
}

function setHistory(rows: unknown[]): void {
  client.messages.splice(0, client.messages.length, ...rows)
}

function registerLiveChild(childSessionID: string): { claim: ReturnType<typeof runtime.runs.claim>; executionID: string } {
  const policy = runtime.policy.resolve("worker")
  const claim = runtime.runs.claim(OWNER_SID, runtime.instance, process.pid)
  const executionID = "tool-call-child-execution"
  runtime.runs.registerIntent(claim, {
    executionId: executionID,
    ownerSession: OWNER_SID,
    taskId: "tool-call-child-task",
    attemptId: "tool-call-child-attempt",
    generation: claim.generation,
    role: "worker",
    cwd: fixture.worktree,
    policyID: policy.id,
    kind: "host",
    engine: runtime.host.identity.engine,
    profile: "legacy-unowned",
  })
  runtime.runs.markHostDispatched(claim, executionID)
  runtime.runs.bindVendorRef(claim, executionID, JSON.stringify({ executionID, vendorSessionID: childSessionID }))
  seedAuthenticatedSession(childSessionID, OWNER_SID)
  return { claim, executionID }
}

async function expectRefusal(promise: Promise<unknown>, reason?: string): Promise<void> {
  const error = await promise.then(() => { throw new Error("expected unsafe tool-call refusal") }, value => value)
  expect(error).toBeInstanceOf(UnsafeOpenCodeToolCall)
  if (reason) expect(error).toMatchObject({ code: "OTTER_UNSAFE_OPENCODE_TOOL_CALL", reason })
}

test("main tool admission proves full SDK call parent and exact args, then completes once", async () => {
  const userMessageID = "msg_tool_main"
  bindTurn(userTurn(userMessageID))
  const args = { filePath: "src/index.ts", limit: 10 }
  const assistantMessageID = "msg_assistant_main"
  setHistory(sdkMessages({ userMessageID, assistantMessageID, callID: "call_main", args }))

  const call = await admitOpenCodeToolCall(deps, { sessionID: OWNER_SID, callID: "call_main", tool: "read" }, args)
  expect(call).toMatchObject({
    kind: "main", sessionID: OWNER_SID, userMessageID, assistantMessageID, tool: "read", role: "main",
  })
  expect(call!.argsDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(isOpenCodeToolCallCurrent(deps, call)).toBe(true)
  expect(isOpenCodeToolCallCurrent(deps, { ...call! })).toBe(false)
  expect(openCodeToolCallArgumentsMatch(deps, call, args)).toBe(true)
  expect(openCodeToolCallArgumentsMatch(deps, call, { ...args, limit: 11 })).toBe(false)
  expect(isOpenCodeToolCallCurrent(deps, call)).toBe(true)
  expect(currentOpenCodeToolCall(deps, {
    sessionID: OWNER_SID, callID: "call_main", tool: "read", assistantMessageID,
  })).toBe(call)
  await expectRefusal(Promise.resolve().then(() => currentOpenCodeToolCall(deps, {
    sessionID: OWNER_SID, callID: "call_main", tool: "read", assistantMessageID: "forged-assistant",
  })), "stale-turn")

  const historyRequest = client.calls.find(entry => entry.method === "messages")!.args as { query?: Record<string, unknown> }
  expect(historyRequest.query).toEqual({ directory: realpathSync.native(deps.directory) })
  expect(historyRequest.query).not.toHaveProperty("limit")
  expect(completeOpenCodeToolCall(deps, call)).toBe(true)
  expect(completeOpenCodeToolCall(deps, call)).toBe(false)
  expect(isOpenCodeToolCallCurrent(deps, call)).toBe(false)
  await expectRefusal(Promise.resolve().then(() => currentOpenCodeToolCall(deps, {
    sessionID: OWNER_SID, callID: "call_main", tool: "read",
  })), "completed-call")
})

test("stale parents, ambiguous/replayed calls and changed arguments fail without poisoning another call", async () => {
  const userMessageID = "msg_tool_current"
  bindTurn(userTurn(userMessageID))
  const args = { filePath: "src/current.ts" }
  setHistory(sdkMessages({
    userMessageID, assistantMessageID: "msg_stale_parent", assistantParentID: "msg_old", callID: "call_stale", args,
  }))
  await expectRefusal(admitOpenCodeToolCall(deps,
    { sessionID: OWNER_SID, callID: "call_stale", tool: "read" }, args), "missing-parent")

  setHistory(sdkMessages({ userMessageID, assistantMessageID: "msg_changed_args", callID: "call_changed_args", args: { filePath: "src/other.ts" } }))
  await expectRefusal(admitOpenCodeToolCall(deps,
    { sessionID: OWNER_SID, callID: "call_changed_args", tool: "read" }, args), "changed-arguments")

  setHistory(sdkMessages({ userMessageID, assistantMessageID: "msg_good", callID: "call_good", args, status: "pending" }))
  const good = await admitOpenCodeToolCall(deps, { sessionID: OWNER_SID, callID: "call_good", tool: "read" }, args)
  expect(isOpenCodeToolCallCurrent(deps, good)).toBe(true)
  await expectRefusal(admitOpenCodeToolCall(deps, { sessionID: OWNER_SID, callID: "call_good", tool: "read" }, args), "duplicate-call")

  const firstAmbiguous = sdkMessages({ userMessageID, assistantMessageID: "msg_first_ambiguous", callID: "call_ambiguous", args }) as Array<{
    info: AssistantMessage | UserMessage
    parts: Array<Record<string, unknown>>
  }>
  const secondAmbiguous = sdkMessages({ userMessageID, assistantMessageID: "msg_second_ambiguous", callID: "call_ambiguous", args }) as Array<{
    info: AssistantMessage | UserMessage
    parts: Array<Record<string, unknown>>
  }>
  secondAmbiguous[1]!.parts[0]!.id = "tool_part_call_ambiguous_second"
  setHistory([firstAmbiguous[0]!, firstAmbiguous[1]!, secondAmbiguous[1]!])
  await expectRefusal(admitOpenCodeToolCall(deps,
    { sessionID: OWNER_SID, callID: "call_ambiguous", tool: "read" }, args), "ambiguous-call")
  expect(isOpenCodeToolCallCurrent(deps, good)).toBe(true)
})

test("foreign sessions bypass this registry while reserved owned scopes refuse", async () => {
  const callsBefore = client.calls.length
  expect(await admitOpenCodeToolCall(deps, { sessionID: "ses_foreign", callID: "call_foreign", tool: "read" }, {})).toBeUndefined()
  expect(client.calls).toHaveLength(callsBefore)

  const value = userTurn("msg_reserved")
  reserveOpenCodeSystemTurn(deps, OWNER_SID, value.output.message.id)
  await expectRefusal(admitOpenCodeToolCall(deps,
    { sessionID: OWNER_SID, callID: "call_reserved", tool: "read" }, {}), "stale-turn")
})

test("fixed tool denies, noncanonical SDK identity and terminal parts cannot be admitted", async () => {
  const userMessageID = "msg_tool_identity"
  bindTurn(userTurn(userMessageID))
  const args = { filePath: "src/identity.ts" }
  const before = client.calls.length
  await expectRefusal(admitOpenCodeToolCall(deps,
    { sessionID: OWNER_SID, callID: "call_denied_tool", tool: "not-in-fixed-policy" }, args), "disallowed-tool")
  expect(client.calls).toHaveLength(before)

  sdkGet = async ({ path, query }) => ({ data: { id: path.id, directory: `${query.directory}/not-canonical` } })
  ;(client.session as unknown as { get: typeof sdkGet }).get = sdkGet
  setHistory(sdkMessages({ userMessageID, assistantMessageID: "msg_bad_directory", callID: "call_bad_directory", args }))
  await expectRefusal(admitOpenCodeToolCall(deps,
    { sessionID: OWNER_SID, callID: "call_bad_directory", tool: "read" }, args), "session-identity")

  ;(client.session as unknown as { get: typeof sdkGet }).get = async ({ path, query }) => ({
    data: sdkSessionSnapshot(path.id, query.directory),
  })
  setHistory(sdkMessages({ userMessageID, assistantMessageID: "msg_terminal_part", callID: "call_terminal_part", args, status: "completed" }))
  await expectRefusal(admitOpenCodeToolCall(deps,
    { sessionID: OWNER_SID, callID: "call_terminal_part", tool: "read" }, args), "missing-parent")
})

test("session birth must match the authenticated lifetime and current revision must stay stable across history", async () => {
  const userMessageID = "msg_tool_stable_revision"
  bindTurn(userTurn(userMessageID))
  const args = { filePath: "src/revision.ts" }
  for (const field of ["createdAt", "updatedAt"] as const) {
    const base = sessionRevisions.get(OWNER_SID)!
    let lookups = 0
    sdkGet = async ({ path, query }) => {
      lookups++
      const snapshot = sdkSessionSnapshot(path.id, query.directory)
      if (lookups === 2) {
        const time = (snapshot as { time: { created: number; updated: number } }).time
        if (field === "createdAt") time.created++
        else time.updated++
      }
      return { data: snapshot }
    }
    ;(client.session as unknown as { get: typeof sdkGet }).get = sdkGet
    setHistory(sdkMessages({
      userMessageID, assistantMessageID: `msg_revision_${field}`, callID: `call_revision_${field}`, args,
    }))
    await expectRefusal(admitOpenCodeToolCall(deps,
      { sessionID: OWNER_SID, callID: `call_revision_${field}`, tool: "read" }, args), "session-identity")
    expect(lookups).toBe(2)
    sessionRevisions.set(OWNER_SID, base)
  }
})

test("canonical tool-part IDs are mandatory and globally unique in SDK history", async () => {
  const userMessageID = "msg_tool_part_id"
  bindTurn(userTurn(userMessageID))
  const args = { filePath: "src/part-id.ts" }
  const missingID = sdkMessages({ userMessageID, assistantMessageID: "msg_missing_part_id", callID: "call_missing_part_id", args }) as Array<{ parts?: Array<Record<string, unknown>> }>
  missingID[1]!.parts![0]!.id = undefined
  setHistory(missingID)
  await expectRefusal(admitOpenCodeToolCall(deps,
    { sessionID: OWNER_SID, callID: "call_missing_part_id", tool: "read" }, args), "lookup-failed")

  const duplicateID = sdkMessages({ userMessageID, assistantMessageID: "msg_duplicate_part_id", callID: "call_duplicate_part_id", args }) as Array<{ info: AssistantMessage | UserMessage; parts: Array<Record<string, unknown>> }>
  const duplicatedPart = { ...duplicateID[1]!.parts[0]!, callID: "call_other_part", messageID: "msg_second_assistant" }
  duplicateID.push({
    info: { ...(duplicateID[1]!.info as AssistantMessage), id: "msg_second_assistant" },
    parts: [duplicatedPart],
  })
  setHistory(duplicateID)
  await expectRefusal(admitOpenCodeToolCall(deps,
    { sessionID: OWNER_SID, callID: "call_duplicate_part_id", tool: "read" }, args), "lookup-failed")
})

test("a later authenticated lifetime conflict invalidates current call and argument matching", async () => {
  const userMessageID = "msg_tool_lifetime_conflict"
  bindTurn(userTurn(userMessageID))
  const args = { filePath: "src/lifetime.ts" }
  setHistory(sdkMessages({ userMessageID, assistantMessageID: "msg_lifetime_conflict", callID: "call_lifetime_conflict", args }))
  const call = await admitOpenCodeToolCall(deps,
    { sessionID: OWNER_SID, callID: "call_lifetime_conflict", tool: "read" }, args)
  expect(isOpenCodeToolCallCurrent(deps, call)).toBe(true)

  const original = authenticatedSDKSessionIdentity(deps.worktree, OWNER_SID)!
  expect(captureSDKSessionIdentity(deps.worktree, OWNER_SID, { ...original, createdAt: original.createdAt + 1 })).toBe(true)
  expect(authenticatedSDKSessionIdentity(deps.worktree, OWNER_SID)).toBeUndefined()
  expect(isOpenCodeToolCallCurrent(deps, call)).toBe(false)
  expect(openCodeToolCallArgumentsMatch(deps, call, args)).toBe(false)
  expect(completeOpenCodeToolCall(deps, call)).toBe(false)
})

test("same-epoch Resume and replacement turns fence old calls without consuming newer calls", async () => {
  const firstUser = "msg_call_before_stop"
  bindTurn(userTurn(firstUser))
  const args = { filePath: "src/main.ts" }
  setHistory(sdkMessages({ userMessageID: firstUser, assistantMessageID: "msg_assistant_before_stop", callID: "call_before_stop", args }))
  const oldCall = await admitOpenCodeToolCall(deps,
    { sessionID: OWNER_SID, callID: "call_before_stop", tool: "read" }, args)
  holdAdmission(fixture.worktree, OWNER_SID, "test-tool-call-stop")
  resumeAdmission(runtime, OWNER_SID)
  expect(isOpenCodeToolCallCurrent(deps, oldCall)).toBe(false)

  const nextUser = "msg_call_after_resume"
  bindTurn(userTurn(nextUser))
  const nextArgs = { filePath: "src/after.ts" }
  setHistory(sdkMessages({ userMessageID: nextUser, assistantMessageID: "msg_assistant_after_resume", callID: "call_after_resume", args: nextArgs }))
  const nextCall = await admitOpenCodeToolCall(deps,
    { sessionID: OWNER_SID, callID: "call_after_resume", tool: "read" }, nextArgs)
  expect(isOpenCodeToolCallCurrent(deps, nextCall)).toBe(true)
  expect(completeOpenCodeToolCall(deps, oldCall)).toBe(false)
  expect(isOpenCodeToolCallCurrent(deps, nextCall)).toBe(true)
})

test("child calls use the real child policy binding and expire at terminal execution state", async () => {
  const { claim, executionID } = registerLiveChild(CHILD_SID)
  const policy = runtime.policy.resolve("worker")
  const userMessageID = "msg_tool_child"
  bindTurn(userTurn(userMessageID, CHILD_SID, "worker", policy.system.join("\n\n")))
  const args = { filePath: "src/worker.ts" }
  setHistory(sdkMessages({ sessionID: CHILD_SID, userMessageID, userAgent: "worker",
    assistantMessageID: "msg_assistant_child", callID: "call_child", args }))
  const call = await admitOpenCodeToolCall(deps, { sessionID: CHILD_SID, callID: "call_child", tool: "read" }, args)
  expect(call).toMatchObject({ kind: "child", sessionID: CHILD_SID, userMessageID, role: "worker", policy })
  expect(isOpenCodeToolCallCurrent(deps, call)).toBe(true)

  runtime.runs.recordTerminal(claim, executionID, { outcome: "completed", terminalAt: 12, quiescentAt: 13 })
  expect(isOpenCodeToolCallCurrent(deps, call)).toBe(false)
  expect(completeOpenCodeToolCall(deps, call)).toBe(false)
})

test("child calls expire on supervisor stop and unsettled children prevent Resume", async () => {
  registerLiveChild(CHILD_SID)
  const userMessageID = "msg_tool_child_owner_resume"
  const policy = runtime.policy.resolve("worker")
  bindTurn(userTurn(userMessageID, CHILD_SID, "worker", policy.system.join("\n\n")))
  const args = { filePath: "src/worker-owner-resume.ts" }
  setHistory(sdkMessages({ sessionID: CHILD_SID, userMessageID, userAgent: "worker",
    assistantMessageID: "msg_assistant_child_owner_resume", callID: "call_child_owner_resume", args }))
  const call = await admitOpenCodeToolCall(deps,
    { sessionID: CHILD_SID, callID: "call_child_owner_resume", tool: "read" }, args)
  expect(isOpenCodeToolCallCurrent(deps, call)).toBe(true)

  holdAdmission(fixture.worktree, OWNER_SID, "test-child-supervisor-stop")
  expect(() => resumeAdmission(runtime, OWNER_SID)).toThrow("execution claim or intent is unsettled")

  expect(isOpenCodeToolCallCurrent(deps, call)).toBe(false)
  expect(completeOpenCodeToolCall(deps, call)).toBe(false)
})
