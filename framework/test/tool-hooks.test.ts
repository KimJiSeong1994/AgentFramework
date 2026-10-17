import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { createToolAfterHook } from "../src/hooks/tool-after.ts"
import { createChatParamsHook } from "../src/hooks/chat-params.ts"
import { createConfigHook } from "../src/hooks/config.ts"
import { isErrorOutput, relativizePaths } from "../src/hosts/tool-policy.ts"
import { createEventHook } from "../src/hooks/event.ts"
import { writeModeState, readModeState, executionRunDirectory, EMPTY_MODE } from "../src/state/store.ts"
import { createTaskWorktree } from "../src/orchestration/worktree.ts"
import { addTasks, readLedger, writeLedger } from "../src/state/ledger.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { newWorkflow, readWorkflow, withFlowTransaction } from "../src/flow/state.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { admissionEpoch, detachAdmission, effectiveHold, resumeAdmission } from "../src/sessions/admission.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { fakeClient, makeDeps, tempGitWorktree, tempWorktree, admitFixtureSession, releaseFixtureSession, type FakeClient } from "./guards-helpers.ts"
import { createBoundNativeToolChildFixture, createNativeToolFixture, type BoundNativeToolChildFixture, type NativeToolFixture, type PrimedNativeToolCall } from "./native-tool-fixture.ts"
import { clearToolObservations, readToolObservations } from "../src/hosts/tool-observation.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { ExecutionRunUnresolvedError } from "../src/hosts/run-state.ts"
import type { ExecutionRole } from "../src/hosts/types.ts"

const S = "ses_t"
const LINKED_OWNER = "linked-owner"
const LINKED_TASK = "linked-task"
const LINKED_SESSION = "linked-child"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient
let fixtureStores: ReturnType<typeof admitFixtureSession>[]
let observationSessions: Set<string>
let nativeFixtures: WeakMap<object, Map<string, { fixture: Promise<NativeToolFixture>; role: ExecutionRole; ownerSessionID?: string }>>
let childFixtures: BoundNativeToolChildFixture[]
beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
  fixtureStores = []
  observationSessions = new Set()
  nativeFixtures = new WeakMap()
  childFixtures = []
  admitSession(makeDeps(client, wt.worktree), S)
})
afterEach(() => {
  stopHeartbeat()
  for (const child of childFixtures) child.cleanup()
  for (const store of fixtureStores) releaseFixtureSession(wt.worktree, store)
  for (const sessionID of observationSessions) clearToolObservations(wt.worktree, sessionID)
  wt.cleanup()
})

function admitSession(deps: ReturnType<typeof makeDeps>, sessionID: string) {
  observationSessions.add(sessionID)
  const store = admitFixtureSession(deps, sessionID)
  fixtureStores.push(store)
  return store
}

const before = (tool: string, args: any, callID: string, sessionID = S) => ({ input: { tool, sessionID, callID }, output: { args } })
const after = (tool: string, args: any, callID: string, output: string, metadata: any = {}, sessionID = S) => ({
  input: { tool, sessionID, callID, args },
  output: { title: tool, output, metadata },
})

async function nativeFixtureFor(
  deps: ReturnType<typeof makeDeps>,
  sessionID = S,
  role: ExecutionRole = "main",
  ownerSessionID?: string,
): Promise<NativeToolFixture> {
  let sessions = nativeFixtures.get(deps)
  if (!sessions) nativeFixtures.set(deps, sessions = new Map())
  const existing = sessions.get(sessionID)
  if (existing) {
    if (existing.role !== role || existing.ownerSessionID !== ownerSessionID) {
      throw new Error(`native fixture role changed for ${sessionID}`)
    }
    return existing.fixture
  }
  const fixture = createNativeToolFixture(deps, { sessionID, role, ...(ownerSessionID ? { ownerSessionID } : {}) })
    .then(async value => {
      await value.acceptUserTurn()
      return value
    })
  sessions.set(sessionID, { fixture, role, ...(ownerSessionID ? { ownerSessionID } : {}) })
  return fixture
}

async function primeNativeCall(
  deps: ReturnType<typeof makeDeps>,
  call: ReturnType<typeof before>,
  child?: { role: ExecutionRole; ownerSessionID: string },
) {
  const fixture = await nativeFixtureFor(deps, call.input.sessionID, child?.role ?? "main", child?.ownerSessionID)
  return fixture.primeCall({ tool: call.input.tool, args: call.output.args, callID: call.input.callID })
}

async function runBeforeHook(
  deps: ReturnType<typeof makeDeps>,
  hook: ReturnType<typeof createToolBeforeHook>,
  call: ReturnType<typeof before>,
  child?: { role: ExecutionRole; ownerSessionID: string },
) {
  const primed = await primeNativeCall(deps, call, child)
  return hook(primed.input as any, primed.output as any)
}

async function runAfterHook(
  deps: ReturnType<typeof makeDeps>,
  call: ReturnType<typeof after>,
  child?: { role: ExecutionRole; ownerSessionID: string },
) {
  const primed = await primeNativeCall(deps, before(call.input.tool, call.input.args, call.input.callID, call.input.sessionID), child)
  await createToolBeforeHook(deps)(primed.input as any, primed.output as any)
  await createToolAfterHook(deps)(primed.input as any, call.output as any)
}

async function runBeforeWithFixture(
  fixture: NativeToolFixture,
  hook: ReturnType<typeof createToolBeforeHook>,
  call: ReturnType<typeof before>,
) {
  const primed = fixture.primeCall({ tool: call.input.tool, args: call.output.args, callID: call.input.callID })
  return hook(primed.input as any, primed.output as any)
}

const toolErrorEvent = (call: PrimedNativeToolCall, error: string) => {
  const part = {
    ...call.part,
    state: { status: "error" as const, error, input: call.output.args, time: { start: 0, end: 1 } },
  }
  call.part.state = part.state
  return { event: { type: "message.part.updated", properties: { part } } as any }
}

type LinkedFixtureOptions = { role?: ExecutionRole }
type LinkedExecutionInvalidation = {
  claimOwnerSession?: string
  taskId?: string
  cwd?: string
  policyID?: string
  profile?: "legacy-unowned" | "linux-single-use"
  bind?: boolean
  cancelled?: boolean
  fenced?: boolean
  terminal?: boolean
  staleGeneration?: boolean
  extraVendorReferenceField?: boolean
  duplicateVendorReference?: boolean
}

async function createLinkedFixture(options: LinkedFixtureOptions = {}) {
  const main = tempGitWorktree()
  const linked = await createTaskWorktree(main.worktree, LINKED_OWNER, LINKED_TASK, [])
  if (!linked) throw new Error("test fixture did not create a linked Git worktree")
  const ownerDeps = makeDeps(fakeClient(), main.worktree)
  const ownerSession = LINKED_OWNER
  const ownerStore = admitFixtureSession(ownerDeps, ownerSession)
  const ownerRuntime = getOpenCodeRuntime(ownerDeps)
  const runs = ownerRuntime.runs
  const claim = runs.claim(ownerSession, "linked-hook-fixture", process.pid)
  const role = options.role ?? "worker"
  const executionID = "linked-execution"
  runs.registerIntent(claim, {
    executionId: executionID, ownerSession, taskId: LINKED_TASK,
    attemptId: "linked-attempt", generation: claim.generation, role,
    cwd: linked.path,
    policyID: ownerRuntime.policy.resolve(role).id,
    kind: "host", engine: ownerRuntime.host.identity.engine, profile: "legacy-unowned",
  })
  runs.bindVendorRef(claim, executionID, JSON.stringify({ executionID, vendorSessionID: LINKED_SESSION }))
  const serverDeps = makeDeps(fakeClient(), linked.path)
  return {
    main, linked, ownerRuntime, runs, claim, serverDeps,
    async cleanup() {
      clearToolObservations(linked.path, LINKED_SESSION)
      releaseFixtureSession(main.worktree, ownerStore)
      await linked.remove()
      main.cleanup()
      process.env.OTTER_STATE_HOME = wt.stateHome
    },
  }
}

async function withLinkedFixture<T>(options: LinkedFixtureOptions, run: (fixture: Awaited<ReturnType<typeof createLinkedFixture>>) => Promise<T>): Promise<T> {
  const fixture = await createLinkedFixture(options)
  try { return await run(fixture) }
  finally { await fixture.cleanup() }
}

function mutateLinkedExecution(
  mainWorktree: string,
  executionID: string,
  mutate: (record: Record<string, unknown>) => void,
): void {
  const statePath = join(executionRunDirectory(mainWorktree), "state.json")
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { executions: Array<Record<string, unknown>> }
  const record = state.executions.find(value => value.executionId === executionID)
  if (!record) throw new Error(`missing linked execution ${executionID}`)
  mutate(record)
  writeFileSync(statePath, JSON.stringify(state))
}

function invalidateLinkedExecution(
  fixture: Awaited<ReturnType<typeof createLinkedFixture>>,
  options: LinkedExecutionInvalidation,
): void {
  let claim = fixture.claim
  if (!claim) throw new Error("invalid linked execution test requires its owner claim")
  const executionID = "linked-execution"
  if (options.cancelled) fixture.runs.recordCancel(claim, executionID, { requestedAt: Date.now() })
  if (options.terminal || options.staleGeneration || options.duplicateVendorReference) {
    const terminalAt = Date.now()
    fixture.runs.recordTerminal(claim, executionID, { outcome: "completed", terminalAt, quiescentAt: terminalAt + 1 })
    if (options.staleGeneration || options.duplicateVendorReference) {
      fixture.runs.release(claim)
      claim = fixture.runs.claim(LINKED_OWNER, "linked-hook-fixture", process.pid)
      fixture.claim = claim
    }
  }
  if (options.fenced) fixture.runs.fence(claim, executionID, "fixture fence")

  if (options.bind === false || options.cwd || options.taskId || options.claimOwnerSession || options.policyID ||
      options.profile || options.extraVendorReferenceField) {
    mutateLinkedExecution(fixture.main.worktree, executionID, record => {
      if (options.bind === false) {
        delete record.vendorRef
        delete record.boundaryRef
      }
      if (options.cwd) record.cwd = options.cwd
      if (options.taskId) record.taskId = options.taskId
      if (options.claimOwnerSession) record.ownerSession = options.claimOwnerSession
      if (options.policyID) record.policyID = options.policyID
      if (options.profile) record.profile = options.profile
      if (options.extraVendorReferenceField) {
        record.vendorRef = JSON.stringify({ executionID, vendorSessionID: LINKED_SESSION, unexpected: true })
      }
    })
  }

  if (options.duplicateVendorReference) {
    const duplicateID = "linked-execution-duplicate"
    fixture.runs.registerIntent(claim, {
      executionId: duplicateID,
      ownerSession: LINKED_OWNER,
      taskId: LINKED_TASK,
      attemptId: "linked-attempt-duplicate",
      generation: claim.generation,
      role: "worker",
      cwd: fixture.linked.path,
      policyID: fixture.ownerRuntime.policy.resolve("worker").id,
      kind: "host",
      engine: fixture.ownerRuntime.host.identity.engine,
      profile: "legacy-unowned",
    })
    const duplicateReference = { executionID: duplicateID, vendorSessionID: LINKED_SESSION }
    const statePath = join(executionRunDirectory(fixture.main.worktree), "state.json")
    const beforeBinding = readFileSync(statePath)
    expect(() => fixture.runs.bindVendorRef(claim, duplicateID, JSON.stringify(duplicateReference)))
      .toThrow(ExecutionRunUnresolvedError)
    expect(readFileSync(statePath)).toEqual(beforeBinding)
    mutateLinkedExecution(fixture.main.worktree, duplicateID, record => {
      record.vendorRef = JSON.stringify(duplicateReference)
      record.boundaryRef = duplicateReference
    })
  }
}

describe("tool.execute.before", () => {
  test("a restored held main session cannot dispatch tools", async () => {
    const sessionID = "restored_tool_session"
    const deps = makeDeps(client, wt.worktree)
    const original = admitSession(deps, sessionID)
    const native = await createNativeToolFixture(deps, { sessionID })
    await native.acceptUserTurn()
    const call = native.primeCall({ tool: "read", args: { filePath: "x" }, callID: "held-read" })
    releaseFixtureSession(wt.worktree, original)
    const restored = admitSession(deps, sessionID)

    expect(restored.restored).toBe(true)
    expect(effectiveHold(wt.worktree, sessionID)).toBe(true)
    expect(admissionEpoch(wt.worktree, sessionID)).toBeUndefined()
    const observationsBefore = readToolObservations(wt.worktree, sessionID)
    await expect(createToolBeforeHook(deps)(call.input as any, call.output as any))
      .rejects.toThrow(/stale-turn|session held|live tool admission epoch is missing/)
    expect(readToolObservations(wt.worktree, sessionID)).toEqual(observationsBefore)
  })

  test("plugin recovers a reviewer policy from the durable execution reference", async () => {
    const owner = makeDeps(client, wt.worktree)
    const ownerRuntime = getOpenCodeRuntime(owner)
    const runs = ownerRuntime.runs
    const claim = runs.claim(S, "external-controller", process.pid)
    runs.registerIntent(claim, { executionId: "external-review", ownerSession: S, taskId: "plan", attemptId: "attempt", generation: claim.generation, role: "reviewer", cwd: wt.worktree, policyID: ownerRuntime.policy.resolve("reviewer").id, kind: "host", engine: ownerRuntime.host.identity.engine, profile: "legacy-unowned" })
    runs.bindVendorRef(claim, "external-review", JSON.stringify({ executionID: "external-review", vendorSessionID: "review-native" }))
    const server = makeDeps(fakeClient(), wt.worktree)
    observationSessions.add("review-native")
    const native = await nativeFixtureFor(server, "review-native", "reviewer", S)
    const hook = createToolBeforeHook(server)
    const protectedFile = join(wt.worktree, "reviewer-protected.txt")
    const originalContent = "reviewer-owned content\n"
    writeFileSync(protectedFile, originalContent)
    const call = native.primeCall({ tool: "write", args: { filePath: protectedFile, content: "must not be written" }, callID: "write-1" })
    const observationsBefore = readToolObservations(wt.worktree, "review-native")
    await expect(hook(call.input as any, call.output as any)).rejects.toThrow(/disallowed-tool|reviewer tool write/)
    expect(readToolObservations(wt.worktree, "review-native")).toEqual(observationsBefore)
    expect(readFileSync(protectedFile, "utf8")).toBe(originalContent)
    expect(getOpenCodeRuntime(server).policy.snapshotForSession("review-native")?.role).toBe("reviewer")
    runs.recordTerminal(claim, "external-review", { outcome: "completed", terminalAt: Date.now(), quiescentAt: Date.now() })
    runs.release(claim)
  })

  test("remote plugin refuses a child when its fixed guard configuration differs from the controller", async () => {
    const owner = makeDeps(client, wt.worktree)
    const ownerRuntime = getOpenCodeRuntime(owner)
    const runs = ownerRuntime.runs
    const claim = runs.claim(S, "external-controller", process.pid)
    runs.registerIntent(claim, { executionId: "drift", ownerSession: S, taskId: "task", attemptId: "attempt",
      generation: claim.generation, role: "worker", cwd: wt.worktree, policyID: ownerRuntime.policy.resolve("worker").id, kind: "host", engine: ownerRuntime.host.identity.engine, profile: "legacy-unowned" })
    runs.bindVendorRef(claim, "drift", JSON.stringify({ executionID: "drift", vendorSessionID: "drift-child" }))
    const serverClient = fakeClient()
    const setup = makeDeps(serverClient, wt.worktree)
    const server = makeDeps(serverClient, wt.worktree, { guards: { ...owner.config.guards, repeat_limit: owner.config.guards.repeat_limit + 1 } })
    observationSessions.add("drift-child")
    const native = await nativeFixtureFor(setup, "drift-child", "worker", S)
    const call = native.primeCall({ tool: "read", args: { filePath: "x" }, callID: "read-1" })
    await createConfigHook(server)({})
    const observationsBefore = readToolObservations(wt.worktree, "drift-child")
    await expect(createToolBeforeHook(server)(call.input as any, call.output as any)).rejects.toThrow()
    expect(readToolObservations(wt.worktree, "drift-child")).toEqual(observationsBefore)
    expect(getOpenCodeRuntime(server).policy.snapshotForSession("drift-child")).toBeUndefined()
  })

  test("linked reviewer keeps the fixed owner snapshot in chat.params and refuses writes", async () => {
    await withLinkedFixture({ role: "reviewer" }, async ({ serverDeps, ownerRuntime }) => {
      const localRuntime = getOpenCodeRuntime(serverDeps)
      const chatParams = createChatParamsHook(serverDeps)
      const output: any = { maxOutputTokens: 16_384, options: {} }
      await chatParams({
        sessionID: LINKED_SESSION,
        agent: "reviewer",
        model: { id: "fixture", providerID: "fixture", capabilities: { reasoning: false } },
        provider: { info: { id: "fixture" } },
      } as any, output)
      expect(localRuntime.policy.snapshotForSession(LINKED_SESSION)?.id)
        .toBe(ownerRuntime.policy.resolve("reviewer").id)

      const native = await nativeFixtureFor(serverDeps, LINKED_SESSION, "reviewer", LINKED_OWNER)
      const hook = createToolBeforeHook(serverDeps)
      const protectedFile = join(wt.worktree, "linked-reviewer-protected.txt")
      const originalContent = "linked reviewer-owned content\n"
      writeFileSync(protectedFile, originalContent)
      const call = native.primeCall({ tool: "write", args: { filePath: protectedFile, content: "must not be written" }, callID: "linked-write" })
      const observationsBefore = readToolObservations(serverDeps.worktree, LINKED_SESSION)
      await expect(hook(call.input as any, call.output as any)).rejects.toThrow(/disallowed-tool|reviewer tool write/)
      expect(readToolObservations(serverDeps.worktree, LINKED_SESSION)).toEqual(observationsBefore)
      expect(readFileSync(protectedFile, "utf8")).toBe(originalContent)
    })
  })

  test("linked worker Bash risk is persisted to owner state before admission", async () => {
    await withLinkedFixture({}, async ({ serverDeps, runs }) => {
      const native = await nativeFixtureFor(serverDeps, LINKED_SESSION, "worker", LINKED_OWNER)
      const hook = createToolBeforeHook(serverDeps)
      const call = native.primeCall({ tool: "bash", args: { command: "true" }, callID: "linked-bash" })
      await hook(call.input as any, call.output as any)

      expect(runs.status().executions[0]?.processRisk).toMatchObject({ tool: "bash" })
      expect(getOpenCodeRuntime(serverDeps).runs.status().executions).toEqual([])
    })
  })

  test.each([
    ["cancelled execution", { cancelled: true }],
    ["terminal execution", { terminal: true }],
    ["stale generation", { staleGeneration: true }],
    ["missing owner binding", { bind: false }],
    ["wrong cwd", { cwd: "/" }],
    ["wrong task", { taskId: "another-task" }],
    ["wrong owner", { claimOwnerSession: "another-owner" }],
    ["wrong fixed policy", { policyID: "otter:worker:wrong" }],
    ["wrong execution profile", { profile: "linux-single-use" }],
    ["fenced execution", { fenced: true }],
    ["non-exact vendor reference", { extraVendorReferenceField: true }],
    ["ambiguous vendor references", { duplicateVendorReference: true }],
  ] as const)("linked session rejects %s", async (_name, options) => {
    await withLinkedFixture({}, async fixture => {
      const { serverDeps } = fixture
      const native = await nativeFixtureFor(serverDeps, LINKED_SESSION, "worker", LINKED_OWNER)
      const hook = createToolBeforeHook(serverDeps)
      const protectedFile = join(wt.worktree, "invalid-child-protected.txt")
      const originalContent = "invalid child must not mutate this\n"
      writeFileSync(protectedFile, originalContent)
      const call = native.primeCall({
        tool: "write", args: { filePath: protectedFile, content: "must not be written" }, callID: "linked-write",
      })
      invalidateLinkedExecution(fixture, options)
      const observationsBefore = readToolObservations(serverDeps.worktree, LINKED_SESSION)
      const runsBefore = fixture.runs.status()
      await expect(hook(call.input as any, call.output as any)).rejects.toThrow()
      expect(readToolObservations(serverDeps.worktree, LINKED_SESSION)).toEqual(observationsBefore)
      expect(fixture.runs.status()).toEqual(runsBefore)
      expect(readFileSync(protectedFile, "utf8")).toBe(originalContent)
      expect(getOpenCodeRuntime(serverDeps).policy.snapshotForSession(LINKED_SESSION)).toBeUndefined()
    })
  })

  test.each(["cancelled", "fenced"] as const)("cached linked policy is revalidated after %s", async (change) => {
    await withLinkedFixture({}, async ({ serverDeps, runs, claim }) => {
      const native = await nativeFixtureFor(serverDeps, LINKED_SESSION, "worker", LINKED_OWNER)
      const hook = createToolBeforeHook(serverDeps)
      const first = native.primeCall({ tool: "read", args: { filePath: "x" }, callID: "linked-read-1" })
      await hook(first.input as any, first.output as any)
      expect(getOpenCodeRuntime(serverDeps).policy.snapshotForSession(LINKED_SESSION)?.role).toBe("worker")

      if (change === "cancelled") runs.recordCancel(claim!, "linked-execution", { requestedAt: Date.now() })
      else runs.fence(claim!, "linked-execution", "fixture fence")
      const second = native.primeCall({ tool: "read", args: { filePath: "x" }, callID: "linked-read-2" })
      const observationsBefore = readToolObservations(serverDeps.worktree, LINKED_SESSION)
      const runsBefore = runs.status()
      await expect(hook(second.input as any, second.output as any)).rejects.toThrow()
      expect(readToolObservations(serverDeps.worktree, LINKED_SESSION)).toEqual(observationsBefore)
      expect(runs.status()).toEqual(runsBefore)
      expect(getOpenCodeRuntime(serverDeps).policy.snapshotForSession(LINKED_SESSION)).toBeUndefined()
    })
  })

  test("blocks the (limit+1)th identical failing call with a model-facing message", async () => {
    const deps = makeDeps(client, wt.worktree)
    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "repeat-guard-worker", ownerSessionID: S, role: "worker",
    })
    childFixtures.push(child)
    observationSessions.add(child.native.sessionID)
    const hookBefore = createToolBeforeHook(deps)
    const hookEvent = createEventHook(deps)
    const args = { filePath: "/x/a.ts", content: "hello" }
    const c1 = child.native.primeCall({ tool: "write", args, callID: "c1" })
    await hookEvent({ event: { type: "message.updated", properties: { info: child.native.messages[0]!.info } } } as any)
    await hookEvent({ event: { type: "message.updated", properties: { info: c1.assistantMessage } } } as any)
    await hookBefore(c1.input as any, c1.output as any)
    await hookEvent(toolErrorEvent(c1, "Error: File already exists: /x/a.ts"))
    const c2 = child.native.primeCall({ tool: "write", args: { content: "hello", filePath: "/x/a.ts" }, callID: "c2" })
    await hookBefore(c2.input as any, c2.output as any)
    await hookEvent(toolErrorEvent(c2, "Error: File already exists: /x/a.ts"))
    const c3 = child.native.primeCall({ tool: "write", args, callID: "c3" })
    await expect(hookBefore(c3.input as any, c3.output as any)).rejects.toThrow(
      /^otter: blocked repeated call to write with identical arguments \(3x\)\. The previous attempts failed with: Error: File already exists: \/x\/a\.ts Change the approach/,
    )
    expect(readToolObservations(wt.worktree, child.native.sessionID).filter(item => item.callID === "c3")).toEqual([
      { name: "write", callID: "c3", sessionID: child.native.sessionID, status: "denied" },
    ])
  })

  test("a successful identical call (tool.execute.after) resets the counter", async () => {
    const deps = makeDeps(client, wt.worktree)
    const hookBefore = createToolBeforeHook(deps)
    const hookAfter = createToolAfterHook(deps)
    for (const id of ["c1", "c2", "c3", "c4"]) {
      const c = before("read", { filePath: "/x/a.ts" }, id)
      const primed = await primeNativeCall(deps, c)
      await hookBefore(primed.input as any, primed.output as any)
      const a = after("read", { filePath: "/x/a.ts" }, id, "00001| ok")
      await hookAfter(primed.input as any, a.output as any)
    }
  })

  test("guard.repeat can be disabled", async () => {
    const deps = makeDeps(client, wt.worktree, { disabled_hooks: ["guard.repeat"] })
    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "repeat-disabled-worker", ownerSessionID: S, role: "worker",
    })
    childFixtures.push(child)
    observationSessions.add(child.native.sessionID)
    const hook = createToolBeforeHook(deps)
    for (const id of ["1", "2", "3", "4"]) {
      const call = child.native.primeCall({ tool: "write", args: { a: 1 }, callID: id })
      await hook(call.input as any, call.output as any)
    }
  })

  test("fixed role policies deny the task tool to both main and worker sessions", async () => {
    const deps = makeDeps(client, wt.worktree)
    const hook = createToolBeforeHook(deps)
    const mainTask = before("task", { description: "x", prompt: "y", subagent_type: "worker" }, "main-task")
    const mainObservationsBefore = readToolObservations(wt.worktree, S)
    await expect(runBeforeHook(deps, hook, mainTask)).rejects.toThrow(/disallowed-tool/)
    expect(readToolObservations(wt.worktree, S)).toEqual(mainObservationsBefore)

    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "task-policy-worker", ownerSessionID: S, role: "worker",
    })
    childFixtures.push(child)
    observationSessions.add(child.native.sessionID)
    const workerTask = child.native.primeCall({ tool: "task", args: {}, callID: "worker-task" })
    const observationsBefore = readToolObservations(wt.worktree, child.native.sessionID)
    await expect(hook(workerTask.input as any, workerTask.output as any)).rejects.toThrow(/disallowed-tool/)
    expect(readToolObservations(wt.worktree, child.native.sessionID)).toEqual(observationsBefore)
  })

  test("blocks edit/write into knowledge/raw/ by absolute path, relative path, and traversal", async () => {
    const deps = makeDeps(client, wt.worktree)
    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "raw-wiki-worker", ownerSessionID: S, role: "worker",
    })
    childFixtures.push(child)
    observationSessions.add(child.native.sessionID)
    const hook = createToolBeforeHook(deps)
    const abs = join(wt.worktree, "knowledge", "raw", "documents", "x.md")
    await expect(runBeforeWithFixture(child.native, hook, before("write", { filePath: abs, content: "x" }, "c1", child.native.sessionID)))
      .rejects.toThrow(/otter: raw wiki sources are immutable; use `bun scripts\/otter-wiki\.ts register`\./)
    await expect(runBeforeWithFixture(child.native, hook, before("edit", { filePath: "knowledge/raw/x.md", oldString: "a", newString: "b" }, "c2", child.native.sessionID)))
      .rejects.toThrow(/raw wiki sources are immutable/)
    await expect(runBeforeWithFixture(child.native, hook, before("write", { filePath: "knowledge/wiki/../raw/x.md", content: "x" }, "c3", child.native.sessionID)))
      .rejects.toThrow(/raw wiki sources are immutable/)
  })

  test("allows edit/write elsewhere under knowledge/, including knowledge/wiki/*.md", async () => {
    const deps = makeDeps(client, wt.worktree)
    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "knowledge-wiki-worker", ownerSessionID: S, role: "worker",
    })
    childFixtures.push(child)
    observationSessions.add(child.native.sessionID)
    const hook = createToolBeforeHook(deps)
    const wiki = join(wt.worktree, "knowledge", "wiki", "log.md")
    await runBeforeWithFixture(child.native, hook, before("write", { filePath: wiki, content: "x" }, "c1", child.native.sessionID))
    await runBeforeWithFixture(child.native, hook, before("edit", { filePath: "knowledge/wiki/index.md", oldString: "a", newString: "b" }, "c2", child.native.sessionID))
  })

  test("blocks case variants and symlink aliases of knowledge/raw (case-insensitive volumes)", async () => {
    const deps = makeDeps(client, wt.worktree)
    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "raw-alias-worker", ownerSessionID: S, role: "worker",
    })
    childFixtures.push(child)
    observationSessions.add(child.native.sessionID)
    const hook = createToolBeforeHook(deps)
    for (const [id, filePath] of [["c1", "knowledge/RAW/documents/x.md"], ["c2", "Knowledge/Raw/x.md"]] as const) {
      await expect(runBeforeWithFixture(child.native, hook, before("write", { filePath, content: "x" }, id, child.native.sessionID)))
        .rejects.toThrow(/raw wiki sources are immutable/)
    }
    mkdirSync(join(wt.worktree, "knowledge", "raw"), { recursive: true })
    const alias = join(wt.worktree, "raw-alias")
    symlinkSync(join(wt.worktree, "knowledge", "raw"), alias)
    await expect(runBeforeWithFixture(child.native, hook, before("write", { filePath: join(alias, "x.md"), content: "x" }, "c3", child.native.sessionID)))
      .rejects.toThrow(/raw wiki sources are immutable/)
  })

  test("blocks apply_patch/patch whose Add, Update, Delete or Move target is under knowledge/raw", async () => {
    const deps = makeDeps(client, wt.worktree)
    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "raw-patch-worker", ownerSessionID: S, role: "worker",
    })
    childFixtures.push(child)
    observationSessions.add(child.native.sessionID)
    const hook = createToolBeforeHook(deps)
    const patches = [
      "*** Begin Patch\n*** Add File: knowledge/raw/documents/new.md\n+x\n*** End Patch",
      "*** Begin Patch\n*** Update File: knowledge/raw/documents/a.md\n@@\n-a\n+b\n*** End Patch",
      "*** Begin Patch\n*** Delete File: knowledge/raw/documents/a.md\n*** End Patch",
      "*** Begin Patch\n*** Update File: notes.md\n*** Move to: knowledge/raw/documents/moved.md\n*** End Patch",
    ]
    for (const [i, patchText] of patches.entries()) {
      for (const tool of ["apply_patch", "patch"]) {
        const c = before(tool, { patchText }, `p${tool}${i}`, child.native.sessionID)
        await expect(runBeforeWithFixture(child.native, hook, c)).rejects.toThrow(/raw wiki sources are immutable/)
      }
    }
    const evasive = [
      "*** Begin Patch\n   *** Add File: knowledge/raw/documents/y.md\n+x\n*** End Patch",
      "*** Begin Patch\r\n\t*** Update File: knowledge/raw/a.md\r\n*** End Patch",
      "*** Begin Patch\n***  add file :  knowledge/raw/b.md  \n*** End Patch",
      "*** Begin Patch\n*** Add File: \"knowledge/raw/c.md\"\n*** End Patch",
    ]
    for (const [i, patchText] of evasive.entries()) {
      const c = before("apply_patch", { patchText }, `ev${i}`, child.native.sessionID)
      await expect(runBeforeWithFixture(child.native, hook, c)).rejects.toThrow(/raw wiki sources are immutable/)
    }
    const ok = before("apply_patch", { patchText: "*** Begin Patch\n*** Update File: knowledge/wiki/index.md\n@@\n-a\n+b\n*** End Patch" }, "pok", child.native.sessionID)
    await runBeforeWithFixture(child.native, hook, ok)
  })

  test("guard.wiki_raw can be disabled", async () => {
    const deps = makeDeps(client, wt.worktree, { disabled_hooks: ["guard.wiki_raw"] })
    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "wiki-raw-disabled-worker", ownerSessionID: S, role: "worker",
    })
    childFixtures.push(child)
    observationSessions.add(child.native.sessionID)
    const hook = createToolBeforeHook(deps)
    const abs = join(wt.worktree, "knowledge", "raw", "documents", "x.md")
    await runBeforeWithFixture(child.native, hook, before("write", { filePath: abs, content: "x" }, "c1", child.native.sessionID))
  })
})

describe("tool.execute.after", () => {
  test("bound reviewer policy denies writes before execution and shapes read results", async () => {
    const base = makeDeps(client, wt.worktree)
    const deps = makeDeps(client, wt.worktree, {
      guards: { ...base.config.guards, read_max_lines: 2 },
      flow: { ...base.config.flow, review_max_tool_calls: 2 },
    })
    admitSession(deps, "main")
    const runtime = getOpenCodeRuntime(deps)
    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "reviewer-after-child", ownerSessionID: "main", role: "reviewer",
    })
    childFixtures.push(child)
    observationSessions.add(child.native.sessionID)
    const hookBefore = createToolBeforeHook(deps)
    const hookAfter = createToolAfterHook(deps)
    const denied = child.native.primeCall({ tool: "write", args: { filePath: "x" }, callID: "blocked" })
    const observationsBefore = readToolObservations(wt.worktree, child.native.sessionID)
    await expect(hookBefore(denied.input as any, denied.output as any)).rejects.toThrow(/disallowed-tool/)
    expect(readToolObservations(wt.worktree, child.native.sessionID)).toEqual(observationsBefore)

    const read = child.native.primeCall({ tool: "read", args: { filePath: "x" }, callID: "read-1" })
    await hookBefore(read.input as any, read.output as any)
    const result = after("read", read.output.args, "read-1", "a\nb\nc\nd", {}, child.native.sessionID)
    await hookAfter(read.input as any, result.output as any)
    expect(result.output.output).toContain("[otter: trimmed")
    expect(result.output.metadata.otter.trimmed).toBe(true)
    const observationsAfterRead = readToolObservations(wt.worktree, child.native.sessionID)
    read.part.state = {
      status: "completed", input: read.output.args, output: result.output.output, title: "read",
      metadata: result.output.metadata, time: { start: 0, end: 1 },
    }
    await expect(hookBefore(read.input as any, read.output as any)).rejects.toThrow(/duplicate-call/)
    expect(readToolObservations(wt.worktree, child.native.sessionID)).toEqual(observationsAfterRead)

    const secondRead = child.native.primeCall({ tool: "read", args: { filePath: "x" }, callID: "read-2" })
    await hookBefore(secondRead.input as any, secondRead.output as any)
    await hookAfter(secondRead.input as any, { title: "read", output: "ok", metadata: {} } as any)
    const thirdRead = child.native.primeCall({ tool: "read", args: { filePath: "x" }, callID: "read-3" })
    await expect(hookBefore(thirdRead.input as any, thirdRead.output as any)).rejects.toThrow(/reviewer tool-call cap reached/)
    expect(runtime.policy.snapshotForSession(child.native.sessionID)?.role).toBe("reviewer")
  })

  test("a stale after-hook cannot record success, reset, settle, or dispatch", async () => {
    const sessionID = "stale_tool_callback"
    const deps = makeDeps(client, wt.worktree)
    const original = admitSession(deps, sessionID)
    const runtime = getOpenCodeRuntime(deps)
    const callID = "stale-delegate"
    const native = await createNativeToolFixture(deps, { sessionID })
    await native.acceptUserTurn()
    const toolCall = native.primeCall({ tool: "delegate", args: { resume: true }, callID })
    const workflow = newWorkflow(sessionID, currentOwner(Date.now(), original.epoch), "command", "stale callback", "opencode")
    const added = addTasks(readLedger(wt.worktree, sessionID), [{ title: "already complete" }], Date.now(), { id: workflow.id, planSha: "fixture-plan" })
    const executing = { ...workflow, phase: "executing" as const, taskIds: added.added.map(task => task.id) }
    withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, executing))
    writeLedger(wt.worktree, { ...added.ledger, tasks: added.ledger.tasks.map(task => ({ ...task, status: "done" as const })) })
    writeModeState(wt.worktree, sessionID, { ...EMPTY_MODE, active: true, failures: 3 })

    const beforeHook = createToolBeforeHook(deps)
    const afterHook = createToolAfterHook(deps)
    await beforeHook(toolCall.input as any, toolCall.output as any)
    expect(await detachAdmission(runtime, sessionID, original.epoch, "fixture detach")).toBe(true)

    const restored = admitSession(deps, sessionID)
    expect(restored.restored).toBe(true)
    expect(effectiveHold(wt.worktree, sessionID)).toBe(true)
    const rebound = readWorkflow(wt.worktree)
    if (!rebound) throw new Error("fixture workflow was lost while reopening the session")
    resumeAdmission(runtime, sessionID, rebound.lastSeq)
    expect(effectiveHold(wt.worktree, sessionID)).toBe(false)
    expect(admissionEpoch(wt.worktree, sessionID)).not.toBe(original.epoch)

    const workflowBeforeCallback = readWorkflow(wt.worktree)
    const ledgerBeforeCallback = readLedger(wt.worktree, sessionID)
    const runsBeforeCallback = runtime.runs.status()
    const result = { title: "delegate", output: "completed", metadata: {} }
    await expect(afterHook(toolCall.input as any, result as any)).rejects.toThrow("otter: OpenCode tool call refused (stale-turn)")

    expect(readToolObservations(wt.worktree, sessionID)).toEqual([
      { name: "delegate", callID, sessionID, status: "running" },
    ])
    expect(result).toEqual({ title: "delegate", output: "completed", metadata: {} })
    expect(readModeState(wt.worktree, sessionID).failures).toBe(3)
    expect(readWorkflow(wt.worktree)).toEqual(workflowBeforeCallback)
    expect(readWorkflow(wt.worktree)?.phase).toBe("executing")
    expect(readLedger(wt.worktree, sessionID)).toEqual(ledgerBeforeCallback)
    expect(runtime.runs.status()).toEqual(runsBeforeCallback)
  })

  test("isErrorOutput markers", () => {
    expect(isErrorOutput("Error: nope")).toBe(true)
    expect(isErrorOutput("error: nope")).toBe(true)
    expect(isErrorOutput("✗ failed")).toBe(true)
    expect(isErrorOutput("Failed to run")).toBe(true)
    expect(isErrorOutput("Errors were logged: 0")).toBe(false)
    expect(isErrorOutput("all good")).toBe(false)
  })

  test("trims read output and sets metadata.otter", async () => {
    const deps = makeDeps(client, wt.worktree, { guards: { ...makeDeps(client, wt.worktree).config.guards, read_max_lines: 5 } })
    const a = after("read", { filePath: "f" }, "c1", Array.from({ length: 50 }, (_, i) => `${i}`).join("\n"), { preview: "x" })
    await runAfterHook(deps, a)
    expect(a.output.output.split("\n").length).toBe(6)
    expect(a.output.output).toContain("[otter: trimmed 45 lines")
    expect(a.output.metadata).toEqual({ preview: "x", otter: { trimmed: true, hinted: false } })
  })

  test("appends the recovery hint after trimming so it is never cut", async () => {
    const deps = makeDeps(client, wt.worktree, { guards: { ...makeDeps(client, wt.worktree).config.guards, read_max_lines: 3 } })
    const body = "zsh: command not found: foo\n" + Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n")
    const a = after("bash", { command: "foo" }, "c1", body)
    await runAfterHook(deps, a)
    expect(a.output.output.endsWith("\n\n[otter hint] Check the tool exists with `which`; do not retry the same command.")).toBe(true)
    expect(a.output.output).toContain("[otter: trimmed")
    expect(a.output.metadata.otter).toEqual({ trimmed: true, hinted: true })
  })

  test("edit/write outputs are hinted but never trimmed", async () => {
    const deps = makeDeps(client, wt.worktree)
    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "write-output-worker", ownerSessionID: S, role: "worker",
    })
    childFixtures.push(child)
    observationSessions.add(child.native.sessionID)
    const a = after("write", { filePath: "f" }, "c1", "Error: File already exists: f", {}, child.native.sessionID)
    const primed = child.native.primeCall({ tool: "write", args: a.input.args, callID: a.input.callID })
    await createToolBeforeHook(deps)(primed.input as any, primed.output as any)
    await createToolAfterHook(deps)(primed.input as any, a.output as any)
    expect(a.output.output).toBe("Error: File already exists: f\n\n[otter hint] Use the edit tool with oldString/newString, or read the file first.")
    expect(a.output.metadata.otter).toEqual({ trimmed: false, hinted: true })
  })

  test("error-looking output counts as a failure for the repeat guard", async () => {
    const deps = makeDeps(client, wt.worktree)
    const hookBefore = createToolBeforeHook(deps)
    const hookAfter = createToolAfterHook(deps)
    for (const id of ["c1", "c2"]) {
      const c = before("bash", { command: "foo" }, id)
      const primed = await primeNativeCall(deps, c)
      await hookBefore(primed.input as any, primed.output as any)
      const a = after("bash", { command: "foo" }, id, "Error: command not found: foo")
      await hookAfter(primed.input as any, a.output as any)
    }
    const c3 = before("bash", { command: "foo" }, "c3")
    await expect(runBeforeHook(deps, hookBefore, c3)).rejects.toThrow(/failed with: Error: command not found: foo/)
  })

  test("a successful call resets loop failures when active", async () => {
    writeModeState(wt.worktree, S, { ...EMPTY_MODE, mode: "ulw", active: true, startedAt: Date.now(), failures: 3 })
    const deps = makeDeps(client, wt.worktree)
    const a = after("read", {}, "c1", "ok")
    await runAfterHook(deps, a)
    expect(readModeState(wt.worktree, S).failures).toBe(0)
  })

  test("guard.trim and guard.recover can be disabled independently", async () => {
    const deps = makeDeps(client, wt.worktree, { disabled_hooks: ["guard.trim", "guard.recover"], guards: { ...makeDeps(client, wt.worktree).config.guards, read_max_lines: 2 } })
    const child = await createBoundNativeToolChildFixture(deps, {
      sessionID: "disabled-write-worker", ownerSessionID: S, role: "worker",
    })
    childFixtures.push(child)
    observationSessions.add(child.native.sessionID)
    const body = "Error: File already exists\na\nb\nc\nd"
    const a = after("write", {}, "c1", body, {}, child.native.sessionID)
    const primed = child.native.primeCall({ tool: "write", args: a.input.args, callID: a.input.callID })
    await createToolBeforeHook(deps)(primed.input as any, primed.output as any)
    await createToolAfterHook(deps)(primed.input as any, a.output as any)
    expect(a.output.output).toBe(body)
    expect(a.output.metadata.otter).toEqual({ trimmed: false, hinted: false })
  })

  test("relativizePaths strips worktree and directory prefixes, longest first", async () => {
    const out = relativizePaths("/w/sub/a.ts\n/w/b.ts\n/other/c.ts", ["/w", "/w/sub"])
    expect(out).toBe("a.ts\nb.ts\n/other/c.ts")
  })
})
