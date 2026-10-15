import { afterEach, beforeEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk"
import { createConfigHook } from "../src/hooks/config.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createEventHook } from "../src/hooks/event.ts"
import { createToolAfterHook } from "../src/hooks/tool-after.ts"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { admitOpenCodeToolCall, currentOpenCodeToolCall, isOpenCodeToolCallCurrent, UnsafeOpenCodeToolCall } from "../src/hosts/opencode-tool-call.ts"
import { getOpenCodeRuntime, policyBindingForOpenCodeSession } from "../src/hosts/opencode-runtime.ts"
import { bindOpenCodeSystemTurn, captureOpenCodeToolTurn, reserveOpenCodeSystemTurn } from "../src/hosts/opencode-system.ts"
import { createTaskWorktree } from "../src/orchestration/worktree.ts"
import { createSkillTool } from "../src/tools/skill.ts"
import { attachAdmission, holdAdmission, resumeAdmission } from "../src/sessions/admission.ts"
import { authenticatedSDKSessionIdentity, captureSDKSessionCreationObservation, captureSDKSessionIdentity, type SDKSessionIdentity } from "../src/sessions/sdk-transcript.ts"
import { pendingSkillPermissionActivityCount } from "../src/skills/activity.ts"
import { OpenCodeSkillRefused, initializeOpenCodeSkillSession } from "../src/skills/opencode.ts"
import { getOwnedSession, replaySession, type SessionStore } from "../src/sessions/store.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const SESSION_ID = "ses_native_skill_main"
const USER_MESSAGE_ID = "msg_native_skill_user"
const REMOTE_OWNER_ID = "ses_native_skill_remote_owner"
const REMOTE_CHILD_ID = "ses_native_skill_remote_child"
const REMOTE_TASK_ID = "native_skill_remote_task"
const REFERENCE_BYTES = "Captured reference line one.\r\nCaptured line two.\n"
const EXPECTED_REFERENCE_OUTPUT = "Captured reference line one.\nCaptured line two.\n"

type TurnFixture = {
  input: { sessionID: string; agent: string; messageID: string }
  output: { message: UserMessage; parts: unknown[] }
}
type ToolFixture = { callID: string; assistantMessageID: string; tool: string; args: Record<string, unknown> }
type PermissionRule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }
type AgentRow = { name: string; permission: PermissionRule[]; tools?: { skill?: boolean } }
type AgentRequest = { query: { directory: string }; signal: AbortSignal }
type SkillToolOutput = { title: string; output: string; metadata: Record<string, unknown> }
type SDKGet = (options: { path: { id: string }; query: { directory: string } }) => Promise<{ data?: unknown; error?: unknown }>
type Agents = (options: AgentRequest) => Promise<{ data?: unknown; error?: unknown }>
type ChildLineReader = { reader: ReadableStreamDefaultReader<Uint8Array>; decoder: TextDecoder; buffer: string }
type RemoteOwner = {
  child: ReturnType<typeof Bun.spawn>
  ready: Record<string, unknown>
  next(): Promise<Record<string, unknown>>
  command(type: "hold" | "resume" | "finish"): Promise<Record<string, unknown>>
  releaseOutput(): void
}

let fixture: ReturnType<typeof tempWorktree>
let client: FakeClient
let deps: ReturnType<typeof makeDeps>
let runtime: ReturnType<typeof getOpenCodeRuntime>
let sessionStore: SessionStore
let sessionIdentities: Map<string, SDKSessionIdentity>
let agentRows: AgentRow[]
let agentRequests: Array<AgentRequest & { abortedAtRequest: boolean }>
let app: { agents: Agents }
let beforeToolHook: ReturnType<typeof createToolBeforeHook>
let afterToolHook: ReturnType<typeof createToolAfterHook>
let skillTool: ReturnType<typeof createSkillTool>

function git(...args: string[]): void {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd: fixture.worktree,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenCode Skill Test",
      GIT_AUTHOR_EMAIL: "opencode-skill@example.test",
      GIT_COMMITTER_NAME: "OpenCode Skill Test",
      GIT_COMMITTER_EMAIL: "opencode-skill@example.test",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TEMPLATE_DIR: "",
    },
    stdio: "pipe",
  })
}

function writeSkill(name: string, body = "Inspect the captured project safely.\r\n", allowedTools = ["read", "webfetch"]): string {
  const directory = join(fixture.worktree, ".agents", "skills", name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "SKILL.md"), [
    "---",
    `name: ${name}`,
    "description: Inspect this project",
    `allowed-tools: [${allowedTools.join(", ")}]`,
    "---",
    body,
  ].join("\n"))
  return directory
}

function commitFixture(): void {
  git("add", "-A")
  git("commit", "--quiet", "-m", "tracked skill fixture")
}

function userTurn(messageID = USER_MESSAGE_ID): TurnFixture {
  const message: UserMessage = {
    id: messageID,
    sessionID: SESSION_ID,
    role: "user",
    time: { created: 10 },
    agent: "main",
    model: { providerID: "fixture", modelID: "opencode-skill-test" },
  }
  return {
    input: { sessionID: SESSION_ID, agent: "main", messageID },
    output: {
      message,
      parts: [{ id: `part_${messageID}`, sessionID: SESSION_ID, messageID, type: "text", text: "Inspect the project safely." }],
    },
  }
}

function bindMainTurn(value = userTurn()): void {
  const lease = reserveOpenCodeSystemTurn(deps, SESSION_ID, value.output.message.id)
  bindOpenCodeSystemTurn(deps, value.input, value.output as never, lease)
}

async function bindAndInitializeSkillSession(): Promise<void> {
  bindMainTurn()
  const turn = captureOpenCodeToolTurn(deps, SESSION_ID)
  expect(turn).toBeDefined()
  await initializeOpenCodeSkillSession(deps, turn!)
}

function sdkMessages(call: ToolFixture, userMessageID = USER_MESSAGE_ID): unknown[] {
  const user: UserMessage = {
    id: userMessageID,
    sessionID: SESSION_ID,
    role: "user",
    time: { created: 10 },
    agent: "main",
    model: { providerID: "fixture", modelID: "opencode-skill-test" },
  }
  const assistant = {
    id: call.assistantMessageID,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: 11 },
    parentID: userMessageID,
    modelID: "fixture-model",
    providerID: "fixture",
    mode: "main",
    path: { cwd: fixture.worktree, root: fixture.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } satisfies AssistantMessage
  return [
    { info: user, parts: [] },
    {
      info: assistant,
      parts: [{
        id: `tool_part_${call.callID}`,
        sessionID: SESSION_ID,
        messageID: call.assistantMessageID,
        type: "tool",
        callID: call.callID,
        tool: call.tool,
        state: { status: "running", input: call.args, time: { start: 1 } },
      }],
    },
  ]
}

function setHistory(call: ToolFixture, userMessageID = USER_MESSAGE_ID): void {
  client.messages.splice(0, client.messages.length, ...sdkMessages(call, userMessageID))
}

function adapterContext(
  callID: string,
  messageID: string,
  abort = new AbortController().signal,
  identity: Partial<{ sessionID: string; agent: string; directory: string; worktree: string }> = {},
): Parameters<typeof skillTool.execute>[1] {
  const context = {
    sessionID: identity.sessionID ?? SESSION_ID, messageID, callID, agent: identity.agent ?? "main",
    directory: identity.directory ?? deps.directory, worktree: identity.worktree ?? deps.worktree, abort,
    metadata() { throw new Error("The native skill adapter must return its metadata, not publish unvalidated metadata.") },
    async ask() { throw new Error("Headless native source admission must never request UI permission.") },
  }
  return context
}

function skillOutput(value: unknown): SkillToolOutput {
  expect(value).not.toBeNull()
  expect(typeof value).toBe("object")
  return value as SkillToolOutput
}

async function beforeTool(call: ToolFixture, userMessageID = USER_MESSAGE_ID): Promise<void> {
  setHistory(call, userMessageID)
  await beforeToolHook({ tool: call.tool, sessionID: SESSION_ID, callID: call.callID }, { args: call.args })
}

async function afterTool(call: ToolFixture, output: SkillToolOutput): Promise<void> {
  await afterToolHook({ tool: call.tool, sessionID: SESSION_ID, callID: call.callID, args: call.args }, output)
}

async function admit(call: ToolFixture) {
  setHistory(call)
  const proof = await admitOpenCodeToolCall(deps, {
    sessionID: SESSION_ID,
    callID: call.callID,
    tool: call.tool,
  }, call.args)
  expect(proof).toBeDefined()
  return proof!
}

function assertNativePermissionRequests(): void {
  expect(agentRequests.length).toBeGreaterThan(0)
  for (const request of agentRequests) {
    expect(request.query).toEqual({ directory: deps.directory })
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(request.abortedAtRequest).toBe(false)
    expect(request.signal.aborted).toBe(true)
  }
}

async function expectUnsafeCall(promise: Promise<unknown>, reason: string): Promise<void> {
  const error = await promise.then(() => { throw new Error("expected unsafe native tool-call refusal") }, value => value)
  expect(error).toBeInstanceOf(UnsafeOpenCodeToolCall)
  expect(error).toMatchObject({ code: "LCA_UNSAFE_OPENCODE_TOOL_CALL", reason })
}

function childLineReader(stream: ReadableStream<Uint8Array>): ChildLineReader {
  return { reader: stream.getReader(), decoder: new TextDecoder(), buffer: "" }
}

async function readChildLine(source: ChildLineReader): Promise<Record<string, unknown>> {
  for (;;) {
    const newline = source.buffer.indexOf("\n")
    if (newline >= 0) {
      const line = source.buffer.slice(0, newline)
      source.buffer = source.buffer.slice(newline + 1)
      return JSON.parse(line) as Record<string, unknown>
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const chunk = await Promise.race([
      source.reader.read(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("remote owner control response timed out")), 15_000) }),
    ]).finally(() => { if (timer) clearTimeout(timer) })
    if (chunk.done) throw new Error("remote owner exited before sending its next control message")
    source.buffer += source.decoder.decode(chunk.value, { stream: true })
  }
}

async function startRemoteOwner(root: string, childWorktree: string, childSessionID: string): Promise<RemoteOwner> {
  const script = [
    `const { fakeClient, makeDeps } = await import(${JSON.stringify(new URL("./guards-helpers.ts", import.meta.url).href)})`,
    `const { getOpenCodeRuntime } = await import(${JSON.stringify(new URL("../src/hosts/opencode-runtime.ts", import.meta.url).href)})`,
    `const { attachAdmission, holdOwnedAdmission, resumeAdmission } = await import(${JSON.stringify(new URL("../src/sessions/admission.ts", import.meta.url).href)})`,
    `const { readWorkflow } = await import(${JSON.stringify(new URL("../src/flow/state.ts", import.meta.url).href)})`,
    `const root = ${JSON.stringify(root)}`,
    `const childWorktree = ${JSON.stringify(childWorktree)}`,
    `const ownerSessionID = ${JSON.stringify(REMOTE_OWNER_ID)}`,
    `const childSessionID = ${JSON.stringify(childSessionID)}`,
    `const executionID = "exec_native_skill_remote"`,
    `const taskID = ${JSON.stringify(REMOTE_TASK_ID)}`,
    `const send = value => process.stdout.write(JSON.stringify(value) + "\\n")`,
    `let runtime`,
    `let store`,
    `let claim`,
    `try {`,
    `  const deps = makeDeps(fakeClient(), root)`,
    `  runtime = getOpenCodeRuntime(deps)`,
    `  store = attachAdmission(runtime, ownerSessionID, { engine: "opencode" })`,
    `  claim = runtime.runs.claim(ownerSessionID, runtime.instance, process.pid)`,
    `  const policy = runtime.policy.resolve("main")`,
    `  runtime.runs.registerIntent(claim, { executionId: executionID, ownerSession: ownerSessionID, taskId: taskID, attemptId: "native_skill_remote_attempt", generation: claim.generation, role: "main", cwd: childWorktree, policyID: policy.id, kind: "host", engine: runtime.host.identity.engine, profile: "legacy-unowned" })`,
    `  runtime.runs.markHostDispatched(claim, executionID)`,
    `  runtime.runs.bindVendorRef(claim, executionID, JSON.stringify({ executionID, vendorSessionID: childSessionID }))`,
    `  send({ type: "ready", pid: process.pid, epoch: store.epoch, executionID, taskID })`,
    `  const { createInterface } = await import("node:readline")`,
    `  for await (const line of createInterface({ input: process.stdin })) {`,
    `    const command = JSON.parse(line)`,
    `    if (command.type === "hold") { holdOwnedAdmission(root, ownerSessionID, "native-remote-child-stop"); send({ type: "held" }); continue }`,
    `    if (command.type === "resume") { try { resumeAdmission(runtime, ownerSessionID); send({ type: "resumed" }) } catch (error) { send({ type: "resume-refused", message: String(error && error.message || error) }) } continue }`,
    `    if (command.type === "finish") {`,
    `      const active = runtime.runs.status().executions.find(item => item.executionId === executionID)`,
    `      if (active && !active.terminal) { const terminalAt = Date.now(); runtime.runs.recordTerminal(claim, executionID, { outcome: "completed", terminalAt, quiescentAt: terminalAt }) }`,
    `      runtime.runs.release(claim)`,
    `      const workflow = readWorkflow(root)`,
    `      const ownedWorkflow = workflow && workflow.sessionID === ownerSessionID ? workflow : null`,
    `      store.release({ workflowQuiescent: true, evidence: "remote native skill fixture completed and retired its linked execution", workflowID: ownedWorkflow ? ownedWorkflow.id : null, revision: ownedWorkflow ? ownedWorkflow.lastSeq : null })`,
    `      send({ type: "finished" }); break`,
    `    }`,
    `    send({ type: "unknown-command" })`,
    `  }`,
    `} catch (error) {`,
    `  try { if (runtime && claim) { const active = runtime.runs.status().executions.find(item => item.executionId === executionID); if (active && !active.terminal) { const terminalAt = Date.now(); runtime.runs.recordTerminal(claim, executionID, { outcome: "completed", terminalAt, quiescentAt: terminalAt }) }; runtime.runs.release(claim) } } catch {}`,
    `  try { if (store) { const workflow = readWorkflow(root); const ownedWorkflow = workflow && workflow.sessionID === ownerSessionID ? workflow : null; store.release({ workflowQuiescent: true, evidence: "remote native skill fixture setup failed and cleaned its owner", workflowID: ownedWorkflow ? ownedWorkflow.id : null, revision: ownedWorkflow ? ownedWorkflow.lastSeq : null }) } } catch {}`,
    `  send({ type: "error", message: String(error && error.stack || error) }); process.exitCode = 1`,
    `}`,
  ].join("\n")
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: root,
    env: { ...process.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  const output = childLineReader(child.stdout)
  const owner: Omit<RemoteOwner, "ready"> = {
    child,
    next: () => readChildLine(output),
    async command(type) {
      const stdin = child.stdin
      if (!stdin || typeof stdin === "number") throw new Error("remote owner control pipe is unavailable")
      stdin.write(`${JSON.stringify({ type })}\n`)
      if (type === "finish") await stdin.end()
      else await stdin.flush()
      return readChildLine(output)
    },
    releaseOutput() { output.reader.releaseLock() },
  }
  let ready: Record<string, unknown>
  try { ready = await owner.next() }
  catch (error) {
    child.kill("SIGKILL")
    await child.exited
    output.reader.releaseLock()
    throw error
  }
  if (ready.type !== "ready") {
    child.kill("SIGKILL")
    await child.exited
    output.reader.releaseLock()
    throw new Error(`remote owner setup failed: ${String(ready.message ?? ready.type)}`)
  }
  return { ...owner, ready }
}

beforeEach(async () => {
  fixture = tempWorktree()
  fixture.worktree = realpathSync.native(fixture.worktree)
  git("init", "--quiet")
  git("config", "user.name", "OpenCode Skill Test")
  git("config", "user.email", "opencode-skill@example.test")

  client = fakeClient()
  deps = makeDeps(client, fixture.worktree)
  runtime = getOpenCodeRuntime(deps)
  sessionStore = attachAdmission(runtime, SESSION_ID, { engine: "opencode" })
  await createConfigHook(deps)({})

  sessionIdentities = new Map()
  agentRows = [{
    name: "main",
    permission: [{ permission: "skill", pattern: "*", action: "allow" }],
  }]
  agentRequests = []
  const identity: SDKSessionIdentity = {
    directory: realpathSync.native(deps.directory),
    createdAt: 100,
    updatedAt: 105,
  }
  expect(captureSDKSessionCreationObservation(deps.worktree, SESSION_ID, identity)).toBe(true)
  expect(captureSDKSessionIdentity(deps.worktree, SESSION_ID, identity)).toBe(true)
  sessionIdentities.set(SESSION_ID, identity)

  const host = client as unknown as {
    session: FakeClient["session"] & { get: SDKGet }
    app: { agents: Agents }
  }
  host.session.get = async ({ path, query }) => {
    const captured = sessionIdentities.get(path.id)
    if (!captured) return { error: new Error(`missing authenticated SDK session ${path.id}`) }
    return {
      data: {
        id: path.id,
        directory: query.directory,
        time: { created: captured.createdAt, updated: captured.createdAt + 100 },
      },
    }
  }
  app = {
    agents: async request => {
      agentRequests.push({ ...request, abortedAtRequest: request.signal.aborted })
      return { data: agentRows }
    },
  }
  host.app = app

  beforeToolHook = createToolBeforeHook(deps)
  afterToolHook = createToolAfterHook(deps)
  skillTool = createSkillTool(deps)
})

afterEach(() => fixture.cleanup())

test("native adapter uses main app.agents rules, loads exact tracked bytes, and finalizes captured references", async () => {
  const skillBody = "Inspect the captured project safely.\r\n"
  const skillDirectory = writeSkill("common", skillBody, ["read", "webfetch"])
  mkdirSync(join(skillDirectory, "references"), { recursive: true })
  writeFileSync(join(skillDirectory, "references", "guide.txt"), REFERENCE_BYTES)
  commitFixture()

  const mainRules: PermissionRule[] = [
    { permission: "skill", pattern: "*", action: "deny" },
    { permission: "skill", pattern: "common", action: "allow" },
  ]
  agentRows = [
    { name: "worker", permission: [{ permission: "skill", pattern: "*", action: "deny" }] },
    { name: "main", permission: mainRules },
  ]
  await bindAndInitializeSkillSession()

  const skillCall: ToolFixture = {
    tool: "skill", callID: "call_common_skill", assistantMessageID: "msg_assistant_common_skill", args: { name: "common" },
  }
  await beforeTool(skillCall)
  expect(currentOpenCodeToolCall(deps, {
    sessionID: SESSION_ID, callID: skillCall.callID, tool: skillCall.tool,
    assistantMessageID: skillCall.assistantMessageID,
  })).toMatchObject({
    kind: "main", userMessageID: USER_MESSAGE_ID,
    assistantMessageID: skillCall.assistantMessageID, role: "main", tool: "skill",
  })

  await expect(skillTool.execute({ name: "common" }, adapterContext(skillCall.callID, "msg_forged_assistant")))
    .rejects.toBeInstanceOf(OpenCodeSkillRefused)
  expect(agentRequests).toHaveLength(0)

  const skillAbort = new AbortController()
  const loaded = skillOutput(await skillTool.execute({ name: "common" }, adapterContext(skillCall.callID, skillCall.assistantMessageID, skillAbort.signal)))
  const expectedSkillBytes = [
    "---",
    "name: common",
    "description: Inspect this project",
    "allowed-tools: [read, webfetch]",
    "---",
    skillBody,
  ].join("\n")
  expect(loaded).toMatchObject({
    title: "LCA skill loaded",
    output: expectedSkillBytes,
    metadata: {
      sdkSessionID: SESSION_ID,
      userMessageID: USER_MESSAGE_ID,
      assistantMessageID: skillCall.assistantMessageID,
      callID: skillCall.callID,
      attachmentEpoch: sessionStore.epoch,
      name: "common",
      source: "project",
    },
  })
  expect(loaded.metadata?.invocationID).toEqual(expect.any(String))
  expect(loaded.metadata?.contentHash).toMatch(/^[a-f0-9]{64}$/u)

  const finalizedSkill: SkillToolOutput = { ...loaded }
  await afterTool(skillCall, finalizedSkill)
  // OpenCode 1.18.35 aborts each tool's own context signal once it finishes; continuation reads must survive it.
  skillAbort.abort()
  expect(finalizedSkill).toMatchObject({ title: "LCA skill loaded", output: expectedSkillBytes })
  expect(finalizedSkill.metadata).toMatchObject({
    invocationID: loaded.metadata?.invocationID,
    name: "common",
    source: "project",
    contentHash: loaded.metadata?.contentHash,
  })
  await expect(Promise.resolve().then(() => currentOpenCodeToolCall(deps, {
    sessionID: SESSION_ID, callID: skillCall.callID, tool: skillCall.tool,
    assistantMessageID: skillCall.assistantMessageID,
  }))).rejects.toMatchObject({ reason: "completed-call" })

  const fixedPolicy = runtime.policy.resolve("main")
  expect(fixedPolicy.tools.allowed).toContain("bash")
  expect(fixedPolicy.tools.denied).toContain("webfetch")
  const narrowedBySkill: ToolFixture = {
    tool: "bash", callID: "call_common_bash", assistantMessageID: "msg_assistant_common_bash",
    args: { command: "printf blocked" },
  }
  await expect(beforeTool(narrowedBySkill)).rejects.toBeInstanceOf(OpenCodeSkillRefused)

  const declaredButFixedDenied: ToolFixture = {
    tool: "webfetch", callID: "call_common_webfetch", assistantMessageID: "msg_assistant_common_webfetch",
    args: { url: "https://example.test/" },
  }
  await expectUnsafeCall(beforeTool(declaredButFixedDenied), "disallowed-tool")

  const referenceCall: ToolFixture = {
    tool: "read", callID: "call_common_reference", assistantMessageID: "msg_assistant_common_reference",
    args: { filePath: ".agents/skills/common/references/guide.txt" },
  }
  await beforeTool(referenceCall)
  const referenceOutput: SkillToolOutput = { title: "read", output: "untrusted SDK output", metadata: { vendor: true } }
  await afterTool(referenceCall, referenceOutput)
  expect(referenceOutput).toMatchObject({ title: "LCA captured source", output: EXPECTED_REFERENCE_OUTPUT })
  expect(referenceOutput.metadata).toMatchObject({
    invocationID: loaded.metadata?.invocationID,
    name: "common",
    source: "project",
    contentHash: loaded.metadata?.contentHash,
  })
  const secondLineCall: ToolFixture = {
    tool: "read", callID: "call_reference_line_two", assistantMessageID: "msg_reference_line_two",
    args: { filePath: ".agents/skills/common/references/guide.txt", offset: 2, limit: 1 },
  }
  await beforeTool(secondLineCall)
  const secondLineOutput: SkillToolOutput = { title: "read", output: "unchecked vendor text", metadata: {} }
  await afterTool(secondLineCall, secondLineOutput)
  expect(secondLineOutput.output).toBe("Captured line two.")

  writeSkill("common", "Changed after the baseline and skill load.\r\n", ["read", "webfetch"])
  const changedBoundaryCall: ToolFixture = {
    tool: "read", callID: "call_common_changed_boundary", assistantMessageID: "msg_assistant_common_changed_boundary",
    args: { filePath: ".agents/skills/common/references/guide.txt" },
  }
  const changedBoundary = await beforeTool(changedBoundaryCall).then(
    () => new Error("unexpected dispatch after the captured skill changed"), error => error as Error,
  )
  expect(changedBoundary).toBeInstanceOf(OpenCodeSkillRefused)
  expect(changedBoundary.message).toBe("lca: native skill source or scope is not currently authorized")
  assertNativePermissionRequests()
})

test("a remote child loads and finalizes a common skill without a local supervisor writer, then owner stop fences it", async () => {
  const skillBody = "Remote child may inspect this tracked common source.\r\n"
  writeSkill("common", skillBody, ["read"])
  commitFixture()
  const linked = await createTaskWorktree(fixture.worktree, REMOTE_OWNER_ID, REMOTE_TASK_ID, [])
  expect(linked).not.toBeNull()
  const taskWorktree = linked!
  let remoteOwner: RemoteOwner | undefined
  try {
    remoteOwner = await startRemoteOwner(fixture.worktree, taskWorktree.path, REMOTE_CHILD_ID)
    expect(remoteOwner.ready).toMatchObject({
      type: "ready", executionID: "exec_native_skill_remote", taskID: REMOTE_TASK_ID,
    })
    expect(typeof remoteOwner.ready.pid).toBe("number")
    expect(remoteOwner.ready.pid).not.toBe(process.pid)
    expect(typeof remoteOwner.ready.epoch).toBe("string")
    expect(getOwnedSession(fixture.worktree, REMOTE_OWNER_ID)).toBeUndefined()

    const childClient = fakeClient()
    const childDeps = makeDeps(childClient, taskWorktree.path)
    await createConfigHook(childDeps)({})
    const childPath = realpathSync.native(taskWorktree.path)
    const childIdentity: SDKSessionIdentity = {
      directory: childPath,
      parentID: REMOTE_OWNER_ID,
      createdAt: 1000,
      updatedAt: 1000,
    }
    const childHost = childClient as unknown as {
      session: FakeClient["session"] & { get: SDKGet }
      app: { agents: Agents }
    }
    childHost.session.get = async ({ path, query }) => {
      childClient.calls.push({ method: "get", args: { path, query } })
      if (path.id !== REMOTE_CHILD_ID || query.directory !== childPath) {
        return { error: new Error(`unexpected remote SDK session lookup ${path.id}`) }
      }
      return { data: {
        id: path.id,
        directory: childIdentity.directory,
        parentID: REMOTE_OWNER_ID,
        time: { created: childIdentity.createdAt, updated: childIdentity.updatedAt },
      } }
    }
    const childAgentRequests: AgentRequest[] = []
    childHost.app = {
      agents: async request => {
        childAgentRequests.push(request)
        return { data: [{ name: "main", permission: [{ permission: "skill", pattern: "*", action: "allow" }] }] }
      },
    }

    const sdkSessionCreated = {
      id: REMOTE_CHILD_ID,
      directory: childPath,
      parentID: REMOTE_OWNER_ID,
      time: { created: childIdentity.createdAt, updated: childIdentity.updatedAt },
    }
    expect(sdkSessionCreated).not.toHaveProperty("parentEpoch")
    await createEventHook(childDeps)({
      event: { type: "session.created", properties: { info: sdkSessionCreated } } as never,
    })
    expect(authenticatedSDKSessionIdentity(taskWorktree.path, REMOTE_CHILD_ID)).toEqual(childIdentity)
    expect(authenticatedSDKSessionIdentity(taskWorktree.path, REMOTE_CHILD_ID)).not.toHaveProperty("parentEpoch")

    const childRuntime = getOpenCodeRuntime(childDeps)
    const childPolicy = childRuntime.policy.resolve("main")
    const childUser: UserMessage = {
      id: "msg_native_remote_child_user",
      sessionID: REMOTE_CHILD_ID,
      role: "user",
      time: { created: 1001 },
      agent: "main",
      model: { providerID: "fixture", modelID: "remote-child-skill-test" },
      system: childPolicy.system.join("\n\n"),
    }
    const childParts: Part[] = [{
      id: "part_native_remote_child_user",
      sessionID: REMOTE_CHILD_ID,
      messageID: childUser.id,
      type: "text",
      text: "Load the common skill and read only its captured source.",
    }]
    await createChatMessageHook(childDeps)(
      { sessionID: REMOTE_CHILD_ID, agent: "main", model: childUser.model } as never,
      { message: childUser, parts: childParts } as never,
    )
    const childTurn = captureOpenCodeToolTurn(childDeps, REMOTE_CHILD_ID)
    expect(childTurn).toMatchObject({
      kind: "child",
      sessionID: REMOTE_CHILD_ID,
      userMessageID: childUser.id,
      supervisorSessionID: REMOTE_OWNER_ID,
      attachmentEpoch: remoteOwner.ready.epoch,
      role: "main",
      policy: childPolicy,
    })
    expect(policyBindingForOpenCodeSession(childDeps, REMOTE_CHILD_ID)).toMatchObject({
      executionID: remoteOwner.ready.executionID,
      taskID: remoteOwner.ready.taskID,
      attemptID: "native_skill_remote_attempt",
      ownerSessionID: REMOTE_OWNER_ID,
      ownerEpoch: remoteOwner.ready.epoch,
    })
    expect(getOwnedSession(fixture.worktree, REMOTE_OWNER_ID)).toBeUndefined()

    const childAssistant: AssistantMessage = {
      id: "msg_native_remote_child_skill",
      sessionID: REMOTE_CHILD_ID,
      role: "assistant",
      time: { created: 1002 },
      parentID: childUser.id,
      modelID: "remote-child-fixture-model",
      providerID: "fixture",
      mode: "main",
      path: { cwd: childPath, root: childPath },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const skillCall: ToolFixture = {
      tool: "skill",
      callID: "call_native_remote_child_skill",
      assistantMessageID: childAssistant.id,
      args: { name: "common" },
    }
    const primeChildCall = (call: ToolFixture, assistant: AssistantMessage) => {
      childClient.messages.splice(0, childClient.messages.length,
        { info: childUser, parts: childParts },
        { info: assistant, parts: [{
          id: `part_${call.callID}`,
          sessionID: REMOTE_CHILD_ID,
          messageID: assistant.id,
          type: "tool",
          callID: call.callID,
          tool: call.tool,
          state: { status: "running", input: call.args, time: { start: 1003 } },
        }] },
      )
    }
    primeChildCall(skillCall, childAssistant)
    const childBeforeHook = createToolBeforeHook(childDeps)
    const childAfterHook = createToolAfterHook(childDeps)
    const childSkillTool = createSkillTool(childDeps)
    await childBeforeHook(
      { tool: skillCall.tool, sessionID: REMOTE_CHILD_ID, callID: skillCall.callID },
      { args: skillCall.args },
    )
    const skillProof = currentOpenCodeToolCall(childDeps, {
      sessionID: REMOTE_CHILD_ID,
      callID: skillCall.callID,
      tool: skillCall.tool,
      assistantMessageID: skillCall.assistantMessageID,
    })
    expect(skillProof).toBeDefined()
    expect(isOpenCodeToolCallCurrent(childDeps, skillProof)).toBe(true)

    const adapterIdentity = {
      sessionID: REMOTE_CHILD_ID,
      agent: "main",
      directory: childPath,
      worktree: childPath,
    }
    const loaded = skillOutput(await childSkillTool.execute(
      { name: "common" },
      adapterContext(skillCall.callID, skillCall.assistantMessageID, new AbortController().signal, adapterIdentity),
    ))
    const expectedSkillBytes = [
      "---", "name: common", "description: Inspect this project", "allowed-tools: [read]", "---", skillBody,
    ].join("\n")
    expect(loaded).toMatchObject({ title: "LCA skill loaded", output: expectedSkillBytes })
    expect(loaded.metadata).toMatchObject({
      invocationID: expect.any(String),
      sdkSessionID: REMOTE_CHILD_ID,
      userMessageID: childUser.id,
      assistantMessageID: skillCall.assistantMessageID,
      callID: skillCall.callID,
      attachmentEpoch: remoteOwner.ready.epoch,
      name: "common",
      source: "project",
    })
    expect(loaded.metadata.contentHash).toMatch(/^[a-f0-9]{64}$/u)
    const finalized: SkillToolOutput = { ...loaded }
    await childAfterHook({
      tool: skillCall.tool,
      sessionID: REMOTE_CHILD_ID,
      callID: skillCall.callID,
      args: skillCall.args,
    }, finalized)
    expect(finalized.output).toBe(expectedSkillBytes)
    expect(finalized.metadata).toEqual(loaded.metadata)
    expect(childAgentRequests.length).toBeGreaterThan(0)
    expect(childAgentRequests.every(request => request.query.directory === childPath)).toBe(true)
    const historyCalls = childClient.calls.filter(call => call.method === "messages")
    expect(historyCalls.length).toBeGreaterThan(0)
    expect(historyCalls.every(call => (call.args as { query: { directory: string } }).query.directory === childPath)).toBe(true)
    expect(childClient.calls.filter(call => call.method === "get").every(call =>
      (call.args as { query: { directory: string } }).query.directory === childPath,
    )).toBe(true)
    expect(getOwnedSession(fixture.worktree, REMOTE_OWNER_ID)).toBeUndefined()
    expect(isOpenCodeToolCallCurrent(childDeps, skillProof)).toBe(false)
    expect(replaySession(fixture.worktree, REMOTE_OWNER_ID).records.some(record =>
      record.kind === "notice" && String(record.data.text).includes("Skill invocation audit"),
    )).toBe(false)

    const nextUser: UserMessage = {
      ...childUser,
      id: "msg_native_remote_child_next_user",
      time: { created: 1004 },
    }
    const nextParts: Part[] = [{
      id: "part_native_remote_child_next_user",
      sessionID: REMOTE_CHILD_ID,
      messageID: nextUser.id,
      type: "text",
      text: "Load the common skill again so owner stop can fence an active child call.",
    }]
    await createChatMessageHook(childDeps)(
      { sessionID: REMOTE_CHILD_ID, agent: "main", model: nextUser.model } as never,
      { message: nextUser, parts: nextParts } as never,
    )
    expect(captureOpenCodeToolTurn(childDeps, REMOTE_CHILD_ID)).toMatchObject({
      kind: "child", userMessageID: nextUser.id, supervisorSessionID: REMOTE_OWNER_ID,
    })
    const nextAssistant: AssistantMessage = { ...childAssistant, id: "msg_native_remote_child_next_skill", time: { created: 1005 }, parentID: nextUser.id }
    const nextSkillCall: ToolFixture = {
      tool: "skill",
      callID: "call_native_remote_child_next_skill",
      assistantMessageID: nextAssistant.id,
      args: { name: "common" },
    }
    childClient.messages.splice(0, childClient.messages.length,
      { info: nextUser, parts: nextParts },
      { info: nextAssistant, parts: [{
        id: `part_${nextSkillCall.callID}`,
        sessionID: REMOTE_CHILD_ID,
        messageID: nextAssistant.id,
        type: "tool",
        callID: nextSkillCall.callID,
        tool: nextSkillCall.tool,
        state: { status: "running", input: nextSkillCall.args, time: { start: 1006 } },
      }] },
    )
    await childBeforeHook(
      { tool: nextSkillCall.tool, sessionID: REMOTE_CHILD_ID, callID: nextSkillCall.callID },
      { args: nextSkillCall.args },
    )
    const nextProof = currentOpenCodeToolCall(childDeps, {
      sessionID: REMOTE_CHILD_ID,
      callID: nextSkillCall.callID,
      tool: nextSkillCall.tool,
      assistantMessageID: nextSkillCall.assistantMessageID,
    })
    expect(isOpenCodeToolCallCurrent(childDeps, nextProof)).toBe(true)
    const pendingOutput = skillOutput(await childSkillTool.execute(
      { name: "common" },
      adapterContext(nextSkillCall.callID, nextSkillCall.assistantMessageID, new AbortController().signal, adapterIdentity),
    ))

    expect(await remoteOwner.command("hold")).toMatchObject({ type: "held" })
    expect(getOwnedSession(fixture.worktree, REMOTE_OWNER_ID)).toBeUndefined()
    expect(isOpenCodeToolCallCurrent(childDeps, nextProof)).toBe(false)
    await expect(childSkillTool.execute(
      { name: "common" },
      adapterContext(nextSkillCall.callID, nextSkillCall.assistantMessageID, new AbortController().signal, adapterIdentity),
    )).rejects.toBeInstanceOf(OpenCodeSkillRefused)
    await expectUnsafeCall(childAfterHook({
      tool: nextSkillCall.tool,
      sessionID: REMOTE_CHILD_ID,
      callID: nextSkillCall.callID,
      args: nextSkillCall.args,
    }, pendingOutput), "stale-turn")
    await expectUnsafeCall(Promise.resolve().then(() => currentOpenCodeToolCall(childDeps, {
      sessionID: REMOTE_CHILD_ID,
      callID: nextSkillCall.callID,
      tool: nextSkillCall.tool,
      assistantMessageID: nextSkillCall.assistantMessageID,
    })), "stale-turn")
    const resume = await remoteOwner.command("resume")
    expect(resume).toMatchObject({ type: "resume-refused" })
    expect(resume.message).toMatch(/execution claim or intent is unsettled/u)
  } finally {
    if (remoteOwner) {
      if (remoteOwner.child.exitCode === null) {
        try {
          expect(await remoteOwner.command("finish")).toMatchObject({ type: "finished" })
        } catch {
          remoteOwner.child.kill("SIGKILL")
        }
      }
      await remoteOwner.child.exited
      remoteOwner.releaseOutput()
    }
    await taskWorktree.remove()
  }
}, { timeout: 30_000 })

test("retired local attachment baselines do not exhaust lifetime capacity", async () => {
  writeSkill("common")
  commitFixture()

  let retiredAttachments = 0
  for (let index = 0; index < 300; index++) {
    const messageID = `msg_native_baseline_lifecycle_${index}`
    bindMainTurn(userTurn(messageID))
    const turn = captureOpenCodeToolTurn(deps, SESSION_ID)
    expect(turn).toBeDefined()
    await initializeOpenCodeSkillSession(deps, turn!)

    if (index === 299) break
    const retired = sessionStore
    holdAdmission(fixture.worktree, SESSION_ID, "native-baseline-capacity-retire")
    retired.release({
      workflowQuiescent: true,
      evidence: "The integration fixture completed this attachment before releasing it.",
      workflowID: null,
      revision: null,
    })
    expect(retired.isReleased).toBe(true)
    expect(getOwnedSession(fixture.worktree, SESSION_ID)).toBeUndefined()
    retiredAttachments++

    const replacement = attachAdmission(runtime, SESSION_ID, { engine: "opencode" })
    expect(replacement.epoch).not.toBe(retired.epoch)
    expect(resumeAdmission(runtime, SESSION_ID)).toBe(replacement)
    sessionStore = replacement
  }

  expect(retiredAttachments).toBe(299)
  holdAdmission(fixture.worktree, SESSION_ID, "native-baseline-capacity-retire")
  sessionStore.release({
    workflowQuiescent: true,
    evidence: "The integration fixture completed this attachment before releasing it.",
    workflowID: null,
    revision: null,
  })
  expect(sessionStore.isReleased).toBe(true)
}, { timeout: 120_000 })

test("changed skill bytes remain refused on a later turn and after hold/Resume of the same attachment", async () => {
  const commonDirectory = writeSkill("common")
  commitFixture()
  await bindAndInitializeSkillSession()
  const attachmentEpoch = sessionStore.epoch

  writeFileSync(join(commonDirectory, "SKILL.md"), [
    "---", "name: common", "description: Inspect this project", "allowed-tools: [read, webfetch]", "---",
    "Changed after the attachment baseline.\n",
  ].join("\n"))

  const laterMessageID = "msg_native_skill_later_user_turn"
  bindMainTurn(userTurn(laterMessageID))
  const laterTurn = captureOpenCodeToolTurn(deps, SESSION_ID)
  expect(laterTurn).toBeDefined()
  await initializeOpenCodeSkillSession(deps, laterTurn!)
  const laterCall: ToolFixture = {
    tool: "skill", callID: "call_changed_later_turn", assistantMessageID: "msg_changed_later_turn", args: { name: "common" },
  }
  await beforeTool(laterCall, laterMessageID)
  await expect(skillTool.execute({ name: "common" }, adapterContext(laterCall.callID, laterCall.assistantMessageID)))
    .rejects.toBeInstanceOf(OpenCodeSkillRefused)

  holdAdmission(fixture.worktree, SESSION_ID, "native-skill-baseline-hold-resume")
  expect(resumeAdmission(runtime, SESSION_ID)).toBe(sessionStore)
  expect(sessionStore.epoch).toBe(attachmentEpoch)
  expect(sessionStore.isReleased).toBe(false)

  const resumedMessageID = "msg_native_skill_after_resume"
  bindMainTurn(userTurn(resumedMessageID))
  const resumedTurn = captureOpenCodeToolTurn(deps, SESSION_ID)
  expect(resumedTurn).toBeDefined()
  await initializeOpenCodeSkillSession(deps, resumedTurn!)
  const resumedCall: ToolFixture = {
    tool: "skill", callID: "call_changed_after_resume", assistantMessageID: "msg_changed_after_resume", args: { name: "common" },
  }
  await beforeTool(resumedCall, resumedMessageID)
  await expect(skillTool.execute({ name: "common" }, adapterContext(resumedCall.callID, resumedCall.assistantMessageID)))
    .rejects.toBeInstanceOf(OpenCodeSkillRefused)
})

test("changes since the Git baseline and new custom skills refuse headlessly without a chooser", async () => {
  const commonDirectory = writeSkill("common")
  commitFixture()
  await bindAndInitializeSkillSession()

  writeFileSync(join(commonDirectory, "SKILL.md"), [
    "---", "name: common", "description: Inspect this project", "allowed-tools: [read, webfetch]", "---",
    "Changed after baseline.\r\n",
  ].join("\n"))
  const changedCall: ToolFixture = {
    tool: "skill", callID: "call_changed_since_baseline", assistantMessageID: "msg_changed_since_baseline",
    args: { name: "common" },
  }
  await beforeTool(changedCall)
  await expect(skillTool.execute({ name: "common" }, adapterContext(changedCall.callID, changedCall.assistantMessageID)))
    .rejects.toBeInstanceOf(OpenCodeSkillRefused)

  writeSkill("custom", "Untracked custom instructions.\n", ["read"])
  const customCall: ToolFixture = {
    tool: "skill", callID: "call_headless_custom", assistantMessageID: "msg_headless_custom", args: { name: "custom" },
  }
  await beforeTool(customCall)
  await expect(skillTool.execute({ name: "custom" }, adapterContext(customCall.callID, customCall.assistantMessageID)))
    .rejects.toBeInstanceOf(OpenCodeSkillRefused)
  expect(client.calls.some(call => call.method === "prompt")).toBe(false)
  expect(agentRequests.length).toBeGreaterThan(0)
  assertNativePermissionRequests()
})

test("last matching native permission rule denies and does not fall back to another role", async () => {
  writeSkill("common")
  commitFixture()
  await bindAndInitializeSkillSession()
  agentRows = [
    { name: "worker", permission: [{ permission: "skill", pattern: "*", action: "allow" }] },
    {
      name: "main",
      permission: [
        { permission: "skill", pattern: "common", action: "allow" },
        { permission: "skill", pattern: "common", action: "deny" },
      ],
    },
  ]

  const call: ToolFixture = {
    tool: "skill", callID: "call_ordered_permission_deny", assistantMessageID: "msg_ordered_permission_deny",
    args: { name: "common" },
  }
  await beforeTool(call)
  await expect(skillTool.execute({ name: "common" }, adapterContext(call.callID, call.assistantMessageID)))
    .rejects.toBeInstanceOf(OpenCodeSkillRefused)
  expect(agentRequests).toHaveLength(1)
  assertNativePermissionRequests()
})

test("missing initialization and missing canonical call admission both refuse the adapter", async () => {
  writeSkill("common")
  commitFixture()
  bindMainTurn()

  const unadmitted: ToolFixture = {
    tool: "skill", callID: "call_history_without_admission", assistantMessageID: "msg_history_without_admission",
    args: { name: "common" },
  }
  setHistory(unadmitted)
  await expect(skillTool.execute({ name: "common" }, adapterContext(unadmitted.callID, unadmitted.assistantMessageID)))
    .rejects.toBeInstanceOf(OpenCodeSkillRefused)
  expect(agentRequests).toHaveLength(0)

  const noBaseline: ToolFixture = {
    tool: "skill", callID: "call_missing_baseline", assistantMessageID: "msg_missing_baseline", args: { name: "common" },
  }
  const proof = await admit(noBaseline)
  expect(isOpenCodeToolCallCurrent(deps, proof)).toBe(true)
  await expect(skillTool.execute({ name: "common" }, adapterContext(noBaseline.callID, noBaseline.assistantMessageID)))
    .rejects.toBeInstanceOf(OpenCodeSkillRefused)
  expect(agentRequests).toHaveLength(1)
  assertNativePermissionRequests()
})

test("a real admitted skill call becomes stale across stop and Resume", async () => {
  writeSkill("common")
  commitFixture()
  await bindAndInitializeSkillSession()

  const call: ToolFixture = {
    tool: "skill", callID: "call_skill_before_resume", assistantMessageID: "msg_skill_before_resume",
    args: { name: "common" },
  }
  const proof = await admit(call)
  expect(isOpenCodeToolCallCurrent(deps, proof)).toBe(true)

  holdAdmission(fixture.worktree, SESSION_ID, "native-skill-stop")
  expect(resumeAdmission(runtime, SESSION_ID)).toBeDefined()
  expect(isOpenCodeToolCallCurrent(deps, proof)).toBe(false)
  await expect(skillTool.execute({ name: "common" }, adapterContext(call.callID, call.assistantMessageID)))
    .rejects.toBeInstanceOf(OpenCodeSkillRefused)
  expect(agentRequests).toHaveLength(0)
})

test("an already cancelled native adapter refuses without a permission request or source result", async () => {
  writeSkill("common")
  commitFixture()
  await bindAndInitializeSkillSession()
  const call: ToolFixture = {
    tool: "skill", callID: "call_cancelled_skill", assistantMessageID: "msg_cancelled_skill", args: { name: "common" },
  }
  await admit(call)
  const controller = new AbortController()
  controller.abort()
  await expect(skillTool.execute({ name: "common" }, adapterContext(call.callID, call.assistantMessageID, controller.signal)))
    .rejects.toBeInstanceOf(OpenCodeSkillRefused)
  expect(agentRequests).toHaveLength(0)
})

test("native cancellation after loading prevents captured instructions reaching result finalization", async () => {
  writeSkill("common")
  commitFixture()
  await bindAndInitializeSkillSession()
  const call: ToolFixture = {
    tool: "skill", callID: "call_cancel_loaded", assistantMessageID: "msg_cancel_loaded", args: { name: "common" },
  }
  await beforeTool(call)
  const controller = new AbortController()
  const loaded = skillOutput(await skillTool.execute({ name: "common" }, adapterContext(call.callID, call.assistantMessageID, controller.signal)))
  controller.abort()
  await expect(afterTool(call, loaded)).rejects.toBeInstanceOf(OpenCodeSkillRefused)
})

test("stopped native app.agents permission I/O blocks Resume until the late response settles", async () => {
  writeSkill("common")
  commitFixture()
  await bindAndInitializeSkillSession()
  const call: ToolFixture = {
    tool: "skill", callID: "call_permission_wait", assistantMessageID: "msg_permission_wait", args: { name: "common" },
  }
  await beforeTool(call)

  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  let resolveAgents!: (result: { data?: unknown; error?: unknown }) => void
  const pendingAgents = new Promise<{ data?: unknown; error?: unknown }>(resolve => { resolveAgents = resolve })
  app.agents = async request => {
    agentRequests.push({ ...request, abortedAtRequest: request.signal.aborted })
    markStarted()
    return pendingAgents
  }

  const result = skillTool.execute({ name: "common" }, adapterContext(call.callID, call.assistantMessageID))
    .then(value => value, error => error)
  try {
    await started
    const request = agentRequests.at(-1)!
    expect(request.signal.aborted).toBe(false)
    expect(pendingSkillPermissionActivityCount(fixture.worktree, SESSION_ID, sessionStore.epoch)).toBe(1)

    holdAdmission(fixture.worktree, SESSION_ID, "native-permission-stop")
    expect(request.signal.aborted).toBe(true)
    expect(pendingSkillPermissionActivityCount(fixture.worktree, SESSION_ID, sessionStore.epoch)).toBe(1)
    expect(() => sessionStore.release({
      workflowQuiescent: true, evidence: "The native permission request is still settling.", workflowID: null, revision: null,
    })).toThrow("pending skill permission activity prevents session release")
    expect(() => resumeAdmission(runtime, SESSION_ID)).toThrow(/skill permission activity/u)

    resolveAgents({ data: [{ name: "main", permission: [{ permission: "skill", pattern: "*", action: "allow" }] }] })
    expect(await result).toBeInstanceOf(OpenCodeSkillRefused)
    expect(pendingSkillPermissionActivityCount(fixture.worktree, SESSION_ID, sessionStore.epoch)).toBe(0)
    expect(resumeAdmission(runtime, SESSION_ID)).toBe(sessionStore)
    await expect(skillTool.execute({ name: "common" }, adapterContext(call.callID, call.assistantMessageID)))
      .rejects.toBeInstanceOf(OpenCodeSkillRefused)
    expect(agentRequests).toHaveLength(1)
  } finally {
    resolveAgents({ data: [{ name: "main", permission: [{ permission: "skill", pattern: "*", action: "allow" }] }] })
    await result
  }
})

test("protected workflow names cannot be loaded as ordinary native skills", async () => {
  writeSkill("deep-interview", "Unchecked project shadow.\n", ["read"])
  commitFixture()
  await bindAndInitializeSkillSession()

  const call: ToolFixture = {
    tool: "skill", callID: "call_protected_workflow", assistantMessageID: "msg_protected_workflow",
    args: { name: "deep-interview" },
  }
  await beforeTool(call)
  await expect(skillTool.execute({ name: "deep-interview" }, adapterContext(call.callID, call.assistantMessageID)))
    .rejects.toBeInstanceOf(OpenCodeSkillRefused)
  expect(agentRequests).toHaveLength(1)
  expect(client.calls.some(entry => entry.method === "prompt")).toBe(false)
  assertNativePermissionRequests()
})
