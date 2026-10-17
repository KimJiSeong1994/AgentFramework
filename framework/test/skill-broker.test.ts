import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import type { ExecutionEvent, ExecutionPolicy, ExecutionPolicySnapshot, ExecutionRequest } from "../src/hosts/types.ts"
import { attachAdmission, holdAdmission, resumeAdmission } from "../src/sessions/admission.ts"
import type { SessionStore } from "../src/sessions/store.ts"
import { cancelSkillPermissionActivities, pendingSkillPermissionActivityCount } from "../src/skills/activity.ts"
import {
  awaitSkillPermission,
  consumeSkillPermissionPermit,
  createSkillHoldTicket,
  foregroundSkillInvocationID,
  registerForegroundSkillInvocation,
  revokeForegroundSkillInvocation,
  type ForegroundSkillInvocation,
  type SkillCallRevalidation,
  type SkillHoldTicket,
} from "../src/skills/broker.ts"
import { fakeClient, makeDeps, tempWorktree } from "./guards-helpers.ts"

const SESSION = "skill_broker_session"
const SKILL_HASH = "a".repeat(64)

let wt: ReturnType<typeof tempWorktree>
let host: ReturnType<typeof getOpenCodeRuntime>
let store: SessionStore
let policy: ExecutionPolicy
let snapshot: ExecutionPolicySnapshot
let invocations: ForegroundSkillInvocation[]

function makeSnapshot(id = "fixed-main", allowed: readonly string[] = ["read", "grep"], denied: readonly string[] = ["write"]): ExecutionPolicySnapshot {
  return Object.freeze({
    id,
    role: "main" as const,
    model: Object.freeze({ providerID: "local", modelID: "fixture/model" }),
    maxOutputTokens: 4096,
    tools: Object.freeze({ allowed: Object.freeze([...allowed]), denied: Object.freeze([...denied]) }),
    system: Object.freeze([]),
    thinking: "inherit" as const,
  })
}

function makePolicy(fixed: ExecutionPolicySnapshot): ExecutionPolicy {
  return {
    resolve(role: string) {
      if (role !== "main") throw new Error("unknown role")
      return fixed
    },
  } as unknown as ExecutionPolicy
}

function cliAdmissionRuntime(client: ReturnType<typeof fakeClient>, worktree: string): ReturnType<typeof getOpenCodeRuntime> {
  const base = getOpenCodeRuntime(makeDeps(client, worktree))
  return {
    ...base,
    host: { ...base.host, identity: { ...base.host.identity, engine: "local" } },
  } as ReturnType<typeof getOpenCodeRuntime>
}

function requestFor(sessionID = SESSION, overrides: Partial<ExecutionRequest> = {}, fixed = snapshot): ExecutionRequest {
  return {
    executionID: "execution-1",
    supervisorSessionID: sessionID,
    taskID: "task-1",
    attemptID: "attempt-1",
    generation: 3,
    role: "main",
    title: "fixture invocation",
    cwd: wt.worktree,
    text: "inspect files",
    deadlineAt: Date.now() + 60_000,
    policy: fixed,
    handlers: {} as ExecutionRequest["handlers"],
    ...overrides,
  }
}

function terminal(choose: (title: string, choices: readonly string[], signal: AbortSignal) => Promise<number | undefined> = async () => 0) {
  return { stdinIsTTY: true, stderrIsTTY: true, choose }
}

function register(
  currentStore = store,
  request = requestFor(currentStore.sessionID),
  currentPolicy = policy,
  term = terminal(),
): ForegroundSkillInvocation | undefined {
  const value = registerForegroundSkillInvocation({ worktree: wt.worktree, store: currentStore, request, policy: currentPolicy, terminal: term })
  if (value) invocations.push(value)
  return value
}

function toolEvent(
  request: ExecutionRequest,
  name = "grep",
  input: unknown = { pattern: "needle", path: "src" },
  callID = "call-1",
): Extract<ExecutionEvent, { type: "tool-before" }> {
  return { type: "tool-before", sessionID: request.executionID, callID, toolID: `otter:${name}`, name, input }
}

function revalidation(patch: Partial<SkillCallRevalidation> = {}): SkillCallRevalidation {
  return {
    canIssueTicket: () => true,
    beforeChoice: async () => true,
    afterChoice: async () => true,
    beforeConsume: () => true,
    ...patch,
  }
}

function issue(
  invocation: ForegroundSkillInvocation,
  request: ExecutionRequest,
  event = toolEvent(request),
  checks = revalidation(),
): SkillHoldTicket | undefined {
  return createSkillHoldTicket({
    invocation,
    event,
    skillHash: SKILL_HASH,
    view: { name: "read-worktree", classification: "custom", allowedTools: ["read"] },
    revalidation: checks,
  })
}

async function permitFixture(options: {
  request?: ExecutionRequest
  event?: Extract<ExecutionEvent, { type: "tool-before" }>
  term?: ReturnType<typeof terminal>
  checks?: SkillCallRevalidation
} = {}) {
  const request = options.request ?? requestFor()
  const invocation = register(store, request, policy, options.term ?? terminal())!
  expect(invocation).toBeDefined()
  const event = options.event ?? toolEvent(request)
  const ticket = issue(invocation, request, event, options.checks)
  expect(ticket).toBeDefined()
  const permit = await awaitSkillPermission(ticket)
  return { invocation, request, event, ticket: ticket!, permit }
}

beforeEach(() => {
  wt = tempWorktree()
  wt.worktree = realpathSync.native(wt.worktree)
  invocations = []
  const client = fakeClient()
  ;(client.session as any).get = async ({ path }: { path: { id: string } }) => ({
    data: { id: path.id, directory: wt.worktree, time: { created: 1, updated: 2 } },
  })
  host = cliAdmissionRuntime(client, wt.worktree)
  store = attachAdmission(host, SESSION, { engine: "local", model: "fixture/model" })
  snapshot = makeSnapshot()
  policy = makePolicy(snapshot)
})

afterEach(() => {
  for (const invocation of invocations) revokeForegroundSkillInvocation(invocation)
  wt.cleanup()
})

describe("private foreground skill broker", () => {
  test("mints a generated invocation only for the genuine owned interactive main request", () => {
    const request = requestFor()
    const invocation = register(store, request)
    expect(invocation).toBeDefined()
    expect(foregroundSkillInvocationID(invocation)).toMatch(/^[0-9a-f-]{36}$/u)
    expect(foregroundSkillInvocationID({})).toBeUndefined()

    expect(register(store, requestFor(SESSION, { role: "worker" as never }))).toBeUndefined()
    expect(register(store, requestFor(SESSION, { role: "unknown-role" as never }))).toBeUndefined()
    expect(register(store, request, policy, { ...terminal(), stdinIsTTY: false })).toBeUndefined()
    expect(register(store, request, policy, { ...terminal(), stderrIsTTY: false })).toBeUndefined()

    const nativeClient = fakeClient()
    ;(nativeClient.session as any).get = async ({ path }: { path: { id: string } }) => ({
      data: { id: path.id, directory: wt.worktree, time: { created: 1, updated: 2 } },
    })
    const nativeRuntime = getOpenCodeRuntime(makeDeps(nativeClient, wt.worktree))
    const nativeStore = attachAdmission(nativeRuntime, `${SESSION}_native`, { engine: "opencode" })
    expect(register(nativeStore, requestFor(nativeStore.sessionID))).toBeUndefined()

    const unowned = attachAdmission(host, `${SESSION}_unowned`, { engine: "local", model: "fixture/model" }, { startHeld: true })
    expect(register(unowned, requestFor(unowned.sessionID))).toBeUndefined()
  })

  test("requires the exact fixed policy and a base tool that is allowed and not denied", () => {
    const nonFixed = makeSnapshot()
    const wrongPolicy = makePolicy(nonFixed)
    expect(register(store, requestFor(), wrongPolicy)).toBeUndefined()

    let uiChoices = 0
    const request = requestFor()
    const invocation = register(store, request, policy, terminal(async () => { uiChoices++; return 0 }))!
    expect(issue(invocation, request, toolEvent(request, "write"))).toBeUndefined()
    expect(issue(invocation, request, toolEvent(request, "task"))).toBeUndefined()
    expect(uiChoices).toBe(0)

    const contradictory = makeSnapshot("contradictory", ["grep", "write"], ["write"])
    const contradictoryPolicy = makePolicy(contradictory)
    const contradictoryRequest = requestFor(SESSION, { policy: contradictory }, contradictory)
    const otherInvocation = register(store, contradictoryRequest, contradictoryPolicy)!
    expect(issue(otherInvocation, contradictoryRequest, toolEvent(contradictoryRequest, "write"))).toBeUndefined()
  })

  test("headless, native, copied, and unknown invocation handles cannot issue or wait on tickets", async () => {
    const request = requestFor()
    expect(register(store, request, policy, { ...terminal(), stdinIsTTY: false })).toBeUndefined()
    const invocation = register()!
    const event = toolEvent(request)
    expect(issue({} as ForegroundSkillInvocation, request, event)).toBeUndefined()
    const ticket = issue(invocation, request, event)!
    expect(Object.isFrozen(ticket)).toBe(true)
    expect(JSON.stringify(ticket)).toBe("{}")
    expect(await awaitSkillPermission({ ...ticket })).toBeUndefined()
  })

  test("displays the exact skill scope and only offers inline allow-once or deny", async () => {
    let displayed = ""
    let offered: readonly string[] = []
    const term = terminal(async (title, choices) => {
      displayed = title
      offered = choices
      return 0
    })
    const { invocation, request, event, permit } = await permitFixture({ term })
    expect(displayed).toContain("read-worktree (custom)")
    expect(displayed).toContain(SKILL_HASH)
    expect(displayed).toContain("Tool: grep")
    expect(displayed).toContain("declared tools: read")
    expect(offered).toEqual(["Allow once", "Deny"])
    expect(permit).toBeDefined()
    expect(consumeSkillPermissionPermit(permit, { invocation, request, event, skillHash: SKILL_HASH })).toBe(true)
    expect(consumeSkillPermissionPermit(permit, { invocation, request, event, skillHash: SKILL_HASH })).toBe(false)
  })

  test("a permit cannot cross session or canonical worktree owners", async () => {
    const sameWorktree = await permitFixture()
    const otherSessionID = `${SESSION}_other`
    const otherSessionStore = attachAdmission(host, otherSessionID, { engine: "local", model: "fixture/model" })
    const otherSessionRequest = requestFor(otherSessionID, { executionID: "other-session-execution" })
    const otherSessionInvocation = register(otherSessionStore, otherSessionRequest)!
    expect(otherSessionInvocation).toBeDefined()
    expect(consumeSkillPermissionPermit(sameWorktree.permit, {
      invocation: otherSessionInvocation,
      request: otherSessionRequest,
      event: toolEvent(otherSessionRequest),
      skillHash: SKILL_HASH,
    })).toBe(false)

    const differentPermit = await permitFixture()
    const other = tempWorktree()
    other.worktree = realpathSync.native(other.worktree)
    try {
      const client = fakeClient()
      ;(client.session as any).get = async ({ path }: { path: { id: string } }) => ({
        data: { id: path.id, directory: other.worktree, time: { created: 1, updated: 2 } },
      })
      const otherHost = cliAdmissionRuntime(client, other.worktree)
      const otherStore = attachAdmission(otherHost, SESSION, { engine: "local", model: "fixture/model" })
      const otherRequest = requestFor(SESSION, { executionID: "other-worktree-execution", cwd: other.worktree })
      const otherInvocation = registerForegroundSkillInvocation({
        worktree: other.worktree, store: otherStore, request: otherRequest, policy, terminal: terminal(),
      })!
      expect(otherInvocation).toBeDefined()
      invocations.push(otherInvocation)
      expect(consumeSkillPermissionPermit(differentPermit.permit, {
        invocation: otherInvocation,
        request: otherRequest,
        event: toolEvent(otherRequest),
        skillHash: SKILL_HASH,
      })).toBe(false)
    } finally {
      other.cleanup()
    }
  })

  test("permit is one-use, opaque, and bound to the whole call tuple", async () => {
    const valid = await permitFixture()
    expect(Object.isFrozen(valid.permit)).toBe(true)
    expect(JSON.stringify(valid.permit)).toBe("{}")
    expect(consumeSkillPermissionPermit({ ...valid.permit! }, {
      invocation: valid.invocation, request: valid.request, event: valid.event, skillHash: SKILL_HASH,
    })).toBe(false)

    const wrongCases: Array<(fixture: Awaited<ReturnType<typeof permitFixture>>) => Parameters<typeof consumeSkillPermissionPermit>[1]> = [
      fixture => ({ invocation: fixture.invocation, request: { ...fixture.request, supervisorSessionID: "other-session" }, event: fixture.event, skillHash: SKILL_HASH }),
      fixture => ({ invocation: fixture.invocation, request: { ...fixture.request, cwd: "/other/worktree" }, event: fixture.event, skillHash: SKILL_HASH }),
      fixture => ({ invocation: fixture.invocation, request: { ...fixture.request, taskID: "other-task" }, event: fixture.event, skillHash: SKILL_HASH }),
      fixture => ({ invocation: fixture.invocation, request: { ...fixture.request, role: "worker" as never }, event: fixture.event, skillHash: SKILL_HASH }),
      fixture => ({ invocation: fixture.invocation, request: { ...fixture.request, executionID: "other-execution" }, event: fixture.event, skillHash: SKILL_HASH }),
      fixture => ({ invocation: fixture.invocation, request: { ...fixture.request, attemptID: "other-attempt" }, event: fixture.event, skillHash: SKILL_HASH }),
      fixture => ({ invocation: fixture.invocation, request: { ...fixture.request, generation: fixture.request.generation + 1 }, event: fixture.event, skillHash: SKILL_HASH }),
      fixture => ({ invocation: fixture.invocation, request: { ...fixture.request, deadlineAt: fixture.request.deadlineAt + 1 }, event: fixture.event, skillHash: SKILL_HASH }),
      fixture => ({ invocation: fixture.invocation, request: fixture.request, event: { ...fixture.event, callID: "other-call" }, skillHash: SKILL_HASH }),
      fixture => ({ invocation: fixture.invocation, request: fixture.request, event: { ...fixture.event, name: "read" }, skillHash: SKILL_HASH }),
      fixture => ({ invocation: fixture.invocation, request: fixture.request, event: { ...fixture.event, input: { path: "elsewhere", pattern: "needle" } }, skillHash: SKILL_HASH }),
      fixture => ({ invocation: fixture.invocation, request: fixture.request, event: fixture.event, skillHash: "b".repeat(64) }),
    ]
    for (const wrongInput of wrongCases) {
      const fixture = await permitFixture()
      expect(consumeSkillPermissionPermit(fixture.permit, wrongInput(fixture))).toBe(false)
    }
    const policyMismatch = await permitFixture()
    expect(consumeSkillPermissionPermit(policyMismatch.permit, {
      invocation: policyMismatch.invocation,
      request: { ...policyMismatch.request, policy: makeSnapshot("changed-policy") },
      event: policyMismatch.event,
      skillHash: SKILL_HASH,
    })).toBe(false)

    const invocationMismatch = await permitFixture()
    const copiedInvocation = register(store, invocationMismatch.request)!
    expect(consumeSkillPermissionPermit(invocationMismatch.permit, {
      invocation: copiedInvocation, request: invocationMismatch.request, event: invocationMismatch.event, skillHash: SKILL_HASH,
    })).toBe(false)

    const replay = await permitFixture()
    expect(consumeSkillPermissionPermit(replay.permit, {
      invocation: replay.invocation, request: replay.request, event: replay.event, skillHash: SKILL_HASH,
    })).toBe(true)
    expect(consumeSkillPermissionPermit(replay.permit, {
      invocation: replay.invocation, request: replay.request, event: replay.event, skillHash: SKILL_HASH,
    })).toBe(false)
  })

  test("same-epoch Resume invalidates an old invocation and its ticket", async () => {
    const request = requestFor()
    let choices = 0
    const invocation = register(store, request, policy, terminal(async () => { choices++; return 0 }))!
    const ticket = issue(invocation, request)!
    const epoch = store.epoch
    holdAdmission(wt.worktree, SESSION, "broker-revocation-test")
    expect(resumeAdmission(host, SESSION).epoch).toBe(epoch)
    expect(foregroundSkillInvocationID(invocation)).toBeUndefined()
    expect(await awaitSkillPermission(ticket)).toBeUndefined()
    expect(choices).toBe(0)
  })

  test("revalidation runs before UI, after choice, and synchronously before permit consumption", async () => {
    let choices = 0
    const request = requestFor()
    const invocation = register(store, request, policy, terminal(async () => { choices++; return 0 }))!
    expect(issue(invocation, request, toolEvent(request, "grep", { pattern: "blocked" }, "call-blocked"),
      revalidation({ canIssueTicket: () => false }))).toBeUndefined()
    const blockedPath = issue(invocation, request, toolEvent(request), revalidation({ beforeChoice: async () => false }))
    expect(await awaitSkillPermission(blockedPath)).toBeUndefined()
    expect(choices).toBe(0)

    const changedCapture = issue(invocation, request, toolEvent(request, "grep", { pattern: "second call" }, "call-2"), revalidation({ afterChoice: async () => false }))
    expect(await awaitSkillPermission(changedCapture)).toBeUndefined()
    expect(choices).toBe(1)

    const current = await permitFixture({ checks: revalidation({ beforeConsume: () => false }) })
    expect(current.permit).toBeDefined()
    expect(consumeSkillPermissionPermit(current.permit, {
      invocation: current.invocation, request: current.request, event: current.event, skillHash: SKILL_HASH,
    })).toBe(false)
  })

  test("final synchronous validation cannot change the approved request or arguments", async () => {
    for (const dimension of ["arguments", "generation", "call", "tool"]) {
      const request = requestFor()
      const input = { pattern: "needle", path: "src" }
      const event = toolEvent(request, "grep", input)
      const current = await permitFixture({
        request,
        event,
        checks: revalidation({
          beforeConsume: () => {
            if (dimension === "arguments") input.path = "different"
            if (dimension === "generation") Object.assign(request, { generation: request.generation + 1 })
            if (dimension === "call") Object.assign(event, { callID: "different-call" })
            if (dimension === "tool") Object.assign(event, { name: "read" })
            return true
          },
        }),
      })
      expect(current.permit).toBeDefined()
      const consumption = { invocation: current.invocation, request, event, skillHash: SKILL_HASH }
      expect(consumeSkillPermissionPermit(current.permit, consumption)).toBe(false)
      expect(consumeSkillPermissionPermit(current.permit, consumption)).toBe(false)
    }
  })

  test("deny, cancellation, revocation, detach, timeout, and late answers never authorize", async () => {
    const denied = await permitFixture({ term: terminal(async () => 1) })
    expect(denied.permit).toBeUndefined()

    let resolveChoice!: (value: number | undefined) => void
    let started!: () => void
    let chooserSignal: AbortSignal | undefined
    const choiceStarted = new Promise<void>(resolve => { started = resolve })
    const pendingChoose = () => new Promise<number | undefined>(resolve => { resolveChoice = resolve })
    const term = terminal((_title, _choices, signal) => {
      chooserSignal = signal
      started()
      return pendingChoose()
    })
    const request = requestFor(SESSION, { deadlineAt: Date.now() + 60_000 })
    const invocation = register(store, request, policy, term)!
    const ticket = issue(invocation, request)!
    const abort = new AbortController()
    const waiting = awaitSkillPermission(ticket, { signal: abort.signal })
    await choiceStarted
    abort.abort(new Error("cancel"))
    expect(await waiting).toBeUndefined()
    expect(chooserSignal?.aborted).toBe(true)
    resolveChoice(0)

    let revokeStarted!: () => void
    const revokingStarted = new Promise<void>(resolve => { revokeStarted = resolve })
    const revokeTerm = terminal((_title, _choices, signal) => {
      chooserSignal = signal
      revokeStarted()
      return new Promise<number | undefined>(resolve => { resolveChoice = resolve })
    })
    const revokeRequest = requestFor(SESSION, { executionID: "execution-revoke" })
    const revokedInvocation = register(store, revokeRequest, policy, revokeTerm)!
    const revokeTicket = issue(revokedInvocation, revokeRequest)!
    const revokeWait = awaitSkillPermission(revokeTicket)
    await revokingStarted
    expect(revokeForegroundSkillInvocation(revokedInvocation)).toBe(true)
    expect(await revokeWait).toBeUndefined()
    expect(chooserSignal?.aborted).toBe(true)
    resolveChoice(0)

    let detachStarted!: () => void
    const detachedStarted = new Promise<void>(resolve => { detachStarted = resolve })
    const detachTerm = terminal((_title, _choices, signal) => {
      chooserSignal = signal
      detachStarted()
      return new Promise<number | undefined>(resolve => { resolveChoice = resolve })
    })
    const detachRequest = requestFor(SESSION, { executionID: "execution-detach" })
    const detachInvocation = register(store, detachRequest, policy, detachTerm)!
    const detachTicket = issue(detachInvocation, detachRequest)!
    const detachWait = awaitSkillPermission(detachTicket)
    await detachedStarted
    const epoch = store.epoch
    expect(pendingSkillPermissionActivityCount(wt.worktree, SESSION, epoch)).toBe(1)
    expect(cancelSkillPermissionActivities(wt.worktree, SESSION, epoch)).toBe(1)
    expect(pendingSkillPermissionActivityCount(wt.worktree, SESSION, epoch)).toBe(1)
    expect(await detachWait).toBeUndefined()
    expect(chooserSignal?.aborted).toBe(true)
    expect(pendingSkillPermissionActivityCount(wt.worktree, SESSION, epoch)).toBe(0)
    resolveChoice(0)

    let timeoutSignal: AbortSignal | undefined
    const shortDeadlineRequest = requestFor(SESSION, { executionID: "execution-timeout", deadlineAt: Date.now() + 2_600 })
    const timeoutInvocation = register(store, shortDeadlineRequest, policy, terminal((_title, _choices, signal) => {
      timeoutSignal = signal
      return new Promise<number | undefined>(resolve => { resolveChoice = resolve })
    }))!
    const timeoutTicket = issue(timeoutInvocation, shortDeadlineRequest)!
    expect(await awaitSkillPermission(timeoutTicket)).toBeUndefined()
    expect(timeoutSignal?.aborted).toBe(true)
    resolveChoice(0)
    expect(await awaitSkillPermission(timeoutTicket)).toBeUndefined()
  })
})
