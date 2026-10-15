import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { AssistantMessage, TextPart, UserMessage } from "@opencode-ai/sdk"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createConfigHook } from "../src/hooks/config.ts"
import { createEventHook } from "../src/hooks/event.ts"
import { admissionEpoch, attachAdmission, holdAdmission, resumeAdmission } from "../src/sessions/admission.ts"
import { getOwnedSession, replaySession, readSessionMetadata } from "../src/sessions/store.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { readModeState, writeModeState, EMPTY_MODE, sessionDir } from "../src/state/store.ts"
import {
  authenticatedSDKSessionIdentity, captureSDKSessionLifetime, capturedSDKSessionDeletionEpoch,
  hasSDKSessionCreationObservation, registerPendingSDKSessionCreation, SDK_TRANSCRIPT_MESSAGE_LIMIT,
  waitForPendingSDKSessionCreation,
} from "../src/sessions/sdk-transcript.ts"
import { admitFixtureSession, fakeClient, makeDeps, releaseFixtureSession, tempWorktree, type FakeClient, type TempWorktree } from "./guards-helpers.ts"

const SESSION = "ses_sdk_transcript"

let fixture: TempWorktree
let client: FakeClient
let deps: ReturnType<typeof makeDeps>
let fixtureSession: ReturnType<typeof admitFixtureSession>

beforeEach(async () => {
  fixture = tempWorktree()
  client = fakeClient()
  deps = makeDeps(client, fixture.worktree)
  await createConfigHook(deps)({})
  fixtureSession = admitFixtureSession(deps, SESSION)
  authenticateSDKSession({
    id: SESSION,
    projectID: "fixture-project",
    directory: fixture.worktree,
    title: "SDK session",
    version: "fixture",
    time: { created: 100, updated: 101 },
  })
})

afterEach(() => {
  releaseFixtureSession(fixture.worktree, fixtureSession)
  fixture.cleanup()
})

function userMessage(id: string): UserMessage {
  return {
    id,
    sessionID: SESSION,
    role: "user",
    time: { created: 10 },
    agent: "main",
    model: { providerID: "ollama", modelID: "fixture-model" },
  }
}

function assistantMessage(id: string, parentID: string, completed = true): AssistantMessage {
  return {
    id,
    sessionID: SESSION,
    role: "assistant",
    time: { created: 20, ...(completed ? { completed: 30 } : {}) },
    parentID,
    modelID: "fixture-model",
    providerID: "ollama",
    mode: "build",
    path: { cwd: fixture.worktree, root: fixture.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(completed ? { finish: "stop" } : {}),
  }
}

function textPart(messageID: string, id: string, text: string, flags: Partial<Pick<TextPart, "synthetic" | "ignored">> = {}): TextPart {
  return { id, sessionID: SESSION, messageID, type: "text", text, ...flags }
}

async function sendUser(id: string, text: string, hook = createChatMessageHook(deps)) {
  const part = textPart(id, `part_${id}`, text)
  await hook(
    { sessionID: SESSION, agent: "main", model: { providerID: "ollama", modelID: "fixture-model" } },
    { message: userMessage(id), parts: [part] },
  )
  return part
}

async function emit(hook: ReturnType<typeof createEventHook>, event: unknown): Promise<void> {
  await hook({ event } as any)
}

function records() {
  return replaySession(fixture.worktree, SESSION, { limit: 1000 }).records
}

function canonical(info: AssistantMessage, parts: TextPart[]) {
  ;(client.session as any).message = async (options: { path: { id: string; messageID: string } }) => {
    expect(options.path).toEqual({ id: info.sessionID, messageID: info.id })
    return { data: { info, parts } }
  }
}

function authenticateSDKSession(info: {
  id: string
  projectID: string
  directory: string
  parentID?: string
  title: string
  version: string
  time: { created: number; updated: number }
}): void {
  ;(client.session as any).get = async (options: { path: { id: string } }) => {
    client.calls.push({ method: "get", args: options })
    if (options.path.id !== info.id) return { error: new Error("unknown SDK session") }
    return { data: info }
  }
}

describe("SDK transcript retention", () => {
  test("pending native creation capacity is bounded and reclaimed only on settlement", () => {
    const settled: Array<() => void> = []
    try {
      for (let index = 0; index < 4096; index++) {
        settled.push(registerPendingSDKSessionCreation(fixture.worktree, `ses_creation_capacity_${index}`))
      }
      expect(() => registerPendingSDKSessionCreation(fixture.worktree, "ses_creation_overflow"))
        .toThrow("SDK session creation activity capacity exceeded")
      expect(authenticatedSDKSessionIdentity(fixture.worktree, "ses_creation_capacity_0")).toBeUndefined()
      settled[0]!()
      settled.push(registerPendingSDKSessionCreation(fixture.worktree, "ses_creation_overflow"))
    } finally {
      for (const settle of settled) settle()
    }
  })

  test("duplicate native creation activity remains pending until every accepted handler settles", async () => {
    const sessionID = "ses_duplicate_creation_capacity"
    const settled: Array<() => void> = []
    const controller = new AbortController()
    try {
      for (let index = 0; index < 200; index++) {
        settled.push(registerPendingSDKSessionCreation(fixture.worktree, sessionID))
      }
      expect(() => registerPendingSDKSessionCreation(fixture.worktree, sessionID))
        .toThrow("SDK session creation activity capacity exceeded")
      settled[0]!()
      settled[0]!()
      settled.push(registerPendingSDKSessionCreation(fixture.worktree, sessionID))
      const waiting = waitForPendingSDKSessionCreation(fixture.worktree, sessionID, controller.signal)
      controller.abort()
      expect(await waiting).toBe(false)
    } finally {
      controller.abort()
      for (const settle of settled) settle()
    }
    expect(await waitForPendingSDKSessionCreation(fixture.worktree, sessionID)).toBe(true)
  })

  test("native creation waiters fail closed at capacity without losing existing waiters", async () => {
    const sessionID = "ses_creation_waiter_capacity"
    const settle = registerPendingSDKSessionCreation(fixture.worktree, sessionID)
    const waiting: Array<Promise<boolean>> = []
    try {
      for (let index = 0; index < 200; index++) waiting.push(waitForPendingSDKSessionCreation(fixture.worktree, sessionID))
      expect(await waitForPendingSDKSessionCreation(fixture.worktree, sessionID)).toBe(false)
    } finally {
      settle()
    }
    expect(await Promise.all(waiting)).toEqual(Array.from({ length: 200 }, () => true))
    expect(authenticatedSDKSessionIdentity(fixture.worktree, sessionID)).toBeUndefined()
  })

  test("a pending session.created wait can be cancelled", async () => {
    const sessionID = "ses_cancel_pending_creation"
    const settle = registerPendingSDKSessionCreation(fixture.worktree, sessionID)
    const controller = new AbortController()
    const waiting = waitForPendingSDKSessionCreation(fixture.worktree, sessionID, controller.signal)
      .then(value => ({ value }), error => ({ error }))
    controller.abort()
    expect(await waiting).toEqual({ value: false })
    settle()
  })

  test("concurrent same-born SDK updates preserve fresh authenticated main admission", async () => {
    releaseFixtureSession(fixture.worktree, fixtureSession)
    rmSync(sessionDir(fixture.worktree, SESSION), { recursive: true, force: true })
    expect(getOwnedSession(fixture.worktree, SESSION)).toBeUndefined()
    const eventHook = createEventHook(deps)
    const sdkSession = {
      id: SESSION,
      projectID: "fixture-project",
      directory: fixture.worktree,
      title: "SDK session",
      version: "fixture",
      time: { created: 100, updated: 101 },
    }
    let releaseCreationLookup!: (value: { data: typeof sdkSession }) => void
    let signalCreationLookup!: () => void
    const creationLookupStarted = new Promise<void>(resolve => { signalCreationLookup = resolve })
    const creationLookup = new Promise<{ data: typeof sdkSession }>(resolve => { releaseCreationLookup = resolve })
    let reads = 0
    ;(client.session as any).get = async (options: { path: { id: string } }) => {
      client.calls.push({ method: "get", args: options })
      if (options.path.id !== SESSION) return { error: new Error("unknown SDK session") }
      if (++reads === 1) {
        signalCreationLookup()
        return await creationLookup
      }
      // A concurrent authenticated message callback observes the same birth after a later SDK user touch.
      return { data: { ...sdkSession, time: { created: 100, updated: 103 } } }
    }
    const creationPending = emit(eventHook, { type: "session.created", properties: { info: sdkSession } })
      .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    await creationLookupStarted
    const identityObservation = emit(eventHook, { type: "message.updated", properties: { info: userMessage("msg_before_fresh_admission") } })
      .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    expect(await identityObservation).toEqual({ ok: true })
    const chatPending = sendUser("msg_fresh_authenticated_main", "fresh main request")
      .then(part => ({ part }), error => ({ error }))
    try {
      expect(getOwnedSession(fixture.worktree, SESSION)).toBeUndefined()
      expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    } finally {
      // The pending creation lookup also returns a later update than the creation event itself.
      releaseCreationLookup({ data: { ...sdkSession, time: { created: 100, updated: 102 } } })
    }
    expect(await creationPending).toEqual({ ok: true })
    const chatOutcome = await chatPending
    if ("error" in chatOutcome) throw chatOutcome.error

    const identity = authenticatedSDKSessionIdentity(fixture.worktree, SESSION)
    expect(identity?.updatedAt).toBe(103)
    expect(identity && hasSDKSessionCreationObservation(fixture.worktree, SESSION, identity)).toBe(true)
    expect(chatOutcome.part.text).not.toContain("explicit owner Resume")

    fixtureSession = getOwnedSession(fixture.worktree, SESSION)!
    expect(fixtureSession).toBeDefined()
    expect(admissionEpoch(fixture.worktree, SESSION)).toBe(fixtureSession.epoch)
    expect(fixtureSession.metadata.held).toBe(false)
    expect(records().filter(record => record.kind === "user").map(record => record.data.text)).toEqual(["fresh main request"])
    expect(client.calls.some(call => call.method === "get" && (call.args as any).path.id === SESSION)).toBe(true)
    expect(client.calls.some(call => call.method === "messages" && (call.args as any).path.id === SESSION)).toBe(true)
  })

  test("chat waits for a failed session.created lookup then refuses and holds", async () => {
    releaseFixtureSession(fixture.worktree, fixtureSession)
    rmSync(sessionDir(fixture.worktree, SESSION), { recursive: true, force: true })
    const eventHook = createEventHook(deps)
    const sdkSession = {
      id: SESSION,
      projectID: "fixture-project",
      directory: fixture.worktree,
      title: "Failed creation lookup",
      version: "fixture",
      time: { created: 100, updated: 101 },
    }
    let releaseLookup!: (value: { data?: unknown; error?: unknown }) => void
    let signalLookup!: () => void
    const lookupStarted = new Promise<void>(resolve => { signalLookup = resolve })
    const lookup = new Promise<{ data?: unknown; error?: unknown }>(resolve => { releaseLookup = resolve })
    ;(client.session as any).get = async () => {
      signalLookup()
      return await lookup
    }
    const creationPending = emit(eventHook, { type: "session.created", properties: { info: sdkSession } })
      .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    await lookupStarted
    const chatPending = sendUser("msg_failed_creation_lookup", "must remain held")
      .then(part => ({ part }), error => ({ error }))
    try {
      expect(getOwnedSession(fixture.worktree, SESSION)).toBeUndefined()
    } finally {
      releaseLookup({ error: new Error("SDK lookup failed") })
    }
    expect(await creationPending).toEqual({ ok: true })
    const chatOutcome = await chatPending
    if ("error" in chatOutcome) throw chatOutcome.error
    fixtureSession = getOwnedSession(fixture.worktree, SESSION)!
    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(chatOutcome.part.text).toContain("explicit owner Resume is required")
    expect(records().filter(record => record.kind === "user")).toEqual([])
  })

  test("chat waits for a mismatched session.created identity then refuses and holds", async () => {
    releaseFixtureSession(fixture.worktree, fixtureSession)
    rmSync(sessionDir(fixture.worktree, SESSION), { recursive: true, force: true })
    const eventHook = createEventHook(deps)
    const sdkSession = {
      id: SESSION,
      projectID: "fixture-project",
      directory: fixture.worktree,
      title: "Mismatched creation identity",
      version: "fixture",
      time: { created: 100, updated: 101 },
    }
    let releaseLookup!: (value: { data: typeof sdkSession }) => void
    let signalLookup!: () => void
    const lookupStarted = new Promise<void>(resolve => { signalLookup = resolve })
    const lookup = new Promise<{ data: typeof sdkSession }>(resolve => { releaseLookup = resolve })
    ;(client.session as any).get = async () => {
      signalLookup()
      return await lookup
    }
    const creationPending = emit(eventHook, { type: "session.created", properties: { info: sdkSession } })
      .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    await lookupStarted
    const chatPending = sendUser("msg_mismatched_creation_identity", "must remain held")
      .then(part => ({ part }), error => ({ error }))
    try {
      expect(getOwnedSession(fixture.worktree, SESSION)).toBeUndefined()
    } finally {
      releaseLookup({ data: { ...sdkSession, time: { created: 99, updated: 101 } } })
    }
    expect(await creationPending).toEqual({ ok: true })
    const chatOutcome = await chatPending
    if ("error" in chatOutcome) throw chatOutcome.error
    fixtureSession = getOwnedSession(fixture.worktree, SESSION)!
    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(chatOutcome.part.text).toContain("explicit owner Resume is required")
    expect(records().filter(record => record.kind === "user")).toEqual([])
  })

  test("a fresh authenticated SDK session in a project subdirectory is admitted", async () => {
    releaseFixtureSession(fixture.worktree, fixtureSession)
    rmSync(sessionDir(fixture.worktree, SESSION), { recursive: true, force: true })
    const projectDirectory = join(fixture.worktree, "project")
    mkdirSync(projectDirectory)
    deps = { ...deps, directory: projectDirectory }
    await createConfigHook(deps)({})
    const sdkSession = {
      id: SESSION,
      projectID: "fixture-project",
      directory: projectDirectory,
      title: "Project subdirectory session",
      version: "fixture",
      time: { created: 100, updated: 101 },
    }
    authenticateSDKSession(sdkSession)
    await emit(createEventHook(deps), { type: "session.created", properties: { info: sdkSession } })
    authenticateSDKSession({ ...sdkSession, time: { created: 100, updated: 102 } })

    await sendUser("msg_project_subdirectory", "fresh project request")

    fixtureSession = getOwnedSession(fixture.worktree, SESSION)!
    expect(fixtureSession).toBeDefined()
    expect(fixtureSession.metadata.held).toBe(false)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBe(fixtureSession.epoch)
    expect(records().filter(record => record.kind === "user").map(record => record.data.text)).toEqual(["fresh project request"])
    expect(client.calls.some(call => call.method === "messages" && (call.args as any).path.id === SESSION)).toBe(true)
  })

  test("an authenticated SDK session directory outside the canonical worktree is refused", async () => {
    releaseFixtureSession(fixture.worktree, fixtureSession)
    rmSync(sessionDir(fixture.worktree, SESSION), { recursive: true, force: true })
    const outsideDirectory = join(fixture.worktree, "..")
    deps = { ...deps, directory: outsideDirectory }
    await createConfigHook(deps)({})
    const sdkSession = {
      id: SESSION,
      projectID: "fixture-project",
      directory: outsideDirectory,
      title: "Outside session",
      version: "fixture",
      time: { created: 100, updated: 101 },
    }
    authenticateSDKSession(sdkSession)
    await emit(createEventHook(deps), { type: "session.created", properties: { info: sdkSession } })

    const part = await sendUser("msg_outside_worktree", "must remain held")

    fixtureSession = getOwnedSession(fixture.worktree, SESSION)!
    expect(fixtureSession).toBeDefined()
    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(part.text).toContain("explicit owner Resume is required")
    expect(records().filter(record => record.kind === "user")).toEqual([])
    expect(client.calls.some(call => call.method === "messages" && (call.args as any).path.id === SESSION)).toBe(false)
  })

  test("an authenticated session.created with canonical vendor history stays held without local LCA state", async () => {
    releaseFixtureSession(fixture.worktree, fixtureSession)
    rmSync(sessionDir(fixture.worktree, SESSION), { recursive: true, force: true })
    const sdkSession = {
      id: SESSION,
      projectID: "fixture-project",
      directory: fixture.worktree,
      title: "Restored SDK session",
      version: "fixture",
      time: { created: 100, updated: 105 },
    }
    authenticateSDKSession(sdkSession)
    const eventHook = createEventHook(deps)
    await emit(eventHook, { type: "session.created", properties: { info: sdkSession } })
    client.messages = [{
      info: userMessage("msg_prior_vendor_history"),
      parts: [textPart("msg_prior_vendor_history", "part_prior_vendor_history", "prior plain OpenCode history")],
    }]

    const part = await sendUser("msg_current_after_vendor_history", "must not resume or execute")

    fixtureSession = getOwnedSession(fixture.worktree, SESSION)!
    expect(fixtureSession).toBeDefined()
    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(part.text).toContain("explicit owner Resume is required")
    expect(records().filter(record => record.kind === "user")).toEqual([])
    expect(client.calls.some(call => call.method === "messages" && (call.args as any).path.id === SESSION)).toBe(true)
  })

  test("a vendor revision change during fresh history inspection keeps admission held", async () => {
    releaseFixtureSession(fixture.worktree, fixtureSession)
    rmSync(sessionDir(fixture.worktree, SESSION), { recursive: true, force: true })
    const info = {
      id: SESSION, projectID: "fixture-project", directory: fixture.worktree,
      title: "fresh revision race", version: "fixture", time: { created: 100, updated: 101 },
    }
    await emit(createEventHook(deps), { type: "session.created", properties: { info } })
    let reads = 0
    ;(client.session as any).get = async () => ({
      data: { ...info, time: { created: 100, updated: ++reads === 1 ? 102 : 103 } },
    })
    const part = await sendUser("msg_fresh_revision_race", "must remain held")
    fixtureSession = getOwnedSession(fixture.worktree, SESSION)!
    expect(reads).toBe(2)
    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(part.text).toContain("explicit owner Resume")
    expect(records().filter(record => record.kind === "user")).toEqual([])
  })

  test("a cached session.get identity without this plugin's session.created observation cannot grant fresh admission", async () => {
    releaseFixtureSession(fixture.worktree, fixtureSession)
    rmSync(sessionDir(fixture.worktree, SESSION), { recursive: true, force: true })
    const eventHook = createEventHook(deps)
    await emit(eventHook, { type: "message.updated", properties: { info: userMessage("msg_identity_without_creation") } })

    const part = await sendUser("msg_no_creation_observation", "must remain held")

    fixtureSession = getOwnedSession(fixture.worktree, SESSION)!
    expect(fixtureSession).toBeDefined()
    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(part.text).toContain("explicit owner Resume is required")
    expect(client.calls.some(call => call.method === "messages" && (call.args as any).path.id === SESSION)).toBe(false)
  })

  test("ordinary input attaches preexisting state held without resuming or recording the request", async () => {
    releaseFixtureSession(fixture.worktree, fixtureSession)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()

    const part = await sendUser("msg_preexisting_state", "do not resume this session")

    fixtureSession = getOwnedSession(fixture.worktree, SESSION)!
    expect(fixtureSession).toBeDefined()
    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(part.text).toContain("explicit owner Resume is required")
    expect(records().filter(record => record.kind === "user")).toEqual([])
  })

  test("lifetime registry capacity refuses routing and preserves deletion fail-closed behavior", async () => {
    for (let index = 0; index < 200; index++) {
      expect(captureSDKSessionLifetime(fixture.worktree, SESSION, `old_epoch_${index}`, index + 1)).toBe(true)
    }
    expect(capturedSDKSessionDeletionEpoch(fixture.worktree, SESSION, 1)).toBe("old_epoch_0")

    const part = await sendUser("msg_lifetime_capacity", "ultrawork: must not dispatch")

    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(part.text).toContain("SDK session lifetime could not be retained")
    expect(readModeState(fixture.worktree, SESSION)).toEqual(EMPTY_MODE)
    expect(capturedSDKSessionDeletionEpoch(fixture.worktree, SESSION, 1)).toBe("old_epoch_0")
    expect(capturedSDKSessionDeletionEpoch(fixture.worktree, SESSION, 201)).toBeUndefined()
  })

  test("global lifetime-key capacity refuses a new owner without evicting captured identities", async () => {
    if (process.env.LCA_SDK_LIFETIME_CAPACITY_CHILD !== "1") {
      const child = Bun.spawnSync([
        process.execPath, "test", import.meta.path, "--test-name-pattern",
        "global lifetime-key capacity refuses a new owner without evicting captured identities",
      ], {
        env: { ...process.env, LCA_SDK_LIFETIME_CAPACITY_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      })
      expect(child.exitCode, `${child.stdout.toString()}\n${child.stderr.toString()}`).toBe(0)
      return
    }
    let retainedID: string | undefined
    let reachedCapacity = false
    for (let index = 0; index <= 4096; index++) {
      const sessionID = `ses_lifetime_key_${index}`
      const captured = captureSDKSessionLifetime(fixture.worktree, sessionID, `epoch_${index}`, index + 1)
      if (!captured) {
        reachedCapacity = true
        break
      }
      retainedID ??= sessionID
    }
    expect(reachedCapacity).toBe(true)
    if (retainedID) expect(capturedSDKSessionDeletionEpoch(fixture.worktree, retainedID, 1)).toBe("epoch_0")

    const part = await sendUser("msg_lifetime_key_capacity", "ultrawork: must not dispatch")

    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(part.text).toContain("SDK session lifetime could not be retained")
    expect(readModeState(fixture.worktree, SESSION)).toEqual(EMPTY_MODE)
    if (retainedID) expect(capturedSDKSessionDeletionEpoch(fixture.worktree, retainedID, 1)).toBe("epoch_0")
    expect(capturedSDKSessionDeletionEpoch(fixture.worktree, SESSION, 100)).toBeUndefined()
  })

  test("session.created is read-only and leaves a second-process SDK CLI writer able to open", async () => {
    releaseFixtureSession(fixture.worktree, fixtureSession)
    rmSync(sessionDir(fixture.worktree, SESSION), { recursive: true, force: true })
    const sdkSession = {
      id: SESSION,
      projectID: "fixture-project",
      directory: fixture.worktree,
      title: "SDK session",
      version: "fixture",
      time: { created: 111, updated: 112 },
    }
    authenticateSDKSession(sdkSession)
    const hook = createEventHook(deps)

    await emit(hook, { type: "session.created", properties: { info: sdkSession } })

    expect(getOwnedSession(fixture.worktree, SESSION)).toBeUndefined()
    expect(existsSync(sessionDir(fixture.worktree, SESSION))).toBe(false)
    const script = `const { openSession } = await import(process.env.LCA_STORE_MODULE); const store = openSession(process.env.LCA_WORKTREE, process.env.LCA_SESSION, { engine: "opencode" }); store.release({ workflowQuiescent: true, evidence: "separate SDK CLI writer proof", workflowID: null, revision: null });`
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LCA_STORE_MODULE: new URL("../src/sessions/store.ts", import.meta.url).href,
        LCA_WORKTREE: fixture.worktree,
        LCA_SESSION: SESSION,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(child.exitCode).toBe(0)
    expect(getOwnedSession(fixture.worktree, SESSION)).toBeUndefined()
    expect(existsSync(join(sessionDir(fixture.worktree, SESSION), "attach.lock"))).toBe(false)
  })

  test("persists the original user text and one complete assistant assembled from all real text parts", async () => {
    const original = "ultrawork: preserve this request\nincluding its exact line break"
    const userPart = await sendUser("msg_user_complete", original)
    expect(userPart.text).not.toBe(original)
    await expect(sendUser("msg_user_complete", original)).rejects.toThrow("stale-turn")

    const hook = createEventHook(deps)
    await emit(hook, { type: "message.updated", properties: { info: userMessage("msg_user_complete") } })
    await emit(hook, { type: "message.part.updated", properties: { part: textPart("msg_assistant_complete", "part_a", "first line\nsecond line") } })
    await emit(hook, { type: "message.part.updated", properties: { part: textPart("msg_assistant_complete", "part_hidden", "synthetic", { synthetic: true }) } })
    await emit(hook, { type: "message.part.updated", properties: { part: textPart("msg_assistant_complete", "part_b", "\nthird line", { ignored: true }) } })
    await emit(hook, { type: "message.part.updated", properties: { part: textPart("msg_assistant_complete", "part_c", "\nfinal part") } })
    await emit(hook, { type: "message.updated", properties: { info: assistantMessage("msg_assistant_complete", "msg_user_complete", false) } })
    expect(records().filter(record => record.kind === "assistant")).toEqual([])

    const complete = assistantMessage("msg_assistant_complete", "msg_user_complete")
    canonical(complete, [
      textPart(complete.id, "part_a", "first line\nsecond line"),
      textPart(complete.id, "part_hidden", "synthetic", { synthetic: true }),
      textPart(complete.id, "part_b", "\nthird line", { ignored: true }),
      textPart(complete.id, "part_c", "\nfinal part"),
    ])
    await emit(hook, { type: "message.updated", properties: { info: complete } })
    await emit(hook, { type: "message.updated", properties: { info: complete } })

    expect(records().filter(record => record.kind === "user").map(record => record.data.text)).toEqual([original])
    expect(records().filter(record => record.kind === "assistant").map(record => record.data.text)).toEqual(["first line\nsecond line\nfinal part"])
  })

  test("completion arriving before part callbacks reads the canonical complete snapshot", async () => {
    await sendUser("msg_out_of_order_user", "out of order request")
    const hook = createEventHook(deps)
    await emit(hook, { type: "message.updated", properties: { info: userMessage("msg_out_of_order_user") } })
    const complete = assistantMessage("msg_out_of_order_assistant", "msg_out_of_order_user")
    canonical(complete, [
      textPart(complete.id, "part_late_2", "B\n"),
      textPart(complete.id, "part_late_1", "A"),
    ])

    await emit(hook, { type: "message.updated", properties: { info: complete } })
    await emit(hook, { type: "message.part.updated", properties: { part: textPart(complete.id, "part_late_1", "A") } })
    await emit(hook, { type: "message.part.updated", properties: { part: textPart(complete.id, "part_late_2", "B\n") } })

    expect(records().filter(record => record.kind === "assistant").map(record => record.data.text)).toEqual(["B\nA"])
  })

  test("an assistant callback after parent-user capture eviction holds the exact owner with a durable incomplete notice", async () => {
    const quietDeps: typeof deps = {
      ...deps,
      config: { ...DEFAULT_CONFIG, disabled_hooks: [...DEFAULT_CONFIG.disabled_hooks, "mode.detect"] },
    }
    await createConfigHook(quietDeps)({})
    const hook = createChatMessageHook(quietDeps)
    for (let index = 0; index <= SDK_TRANSCRIPT_MESSAGE_LIMIT; index++) {
      await sendUser(`msg_cap_${index}`, `accepted-${index}`, hook)
    }

    const users = records().filter(record => record.kind === "user")
    expect(users).toHaveLength(SDK_TRANSCRIPT_MESSAGE_LIMIT + 1)
    expect(users[0]?.data.text).toBe("accepted-0")
    expect(users.at(-1)?.data.text).toBe(`accepted-${SDK_TRANSCRIPT_MESSAGE_LIMIT}`)

    const eventHook = createEventHook(deps)
    const oldAssistant = assistantMessage("msg_cap_old_assistant", "msg_cap_0")
    await emit(eventHook, { type: "message.updated", properties: { info: oldAssistant } })
    expect(records().filter(record => record.kind === "user")).toHaveLength(SDK_TRANSCRIPT_MESSAGE_LIMIT + 1)
    expect(records().filter(record => record.kind === "assistant")).toEqual([])
    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(records().filter(record => record.kind === "notice").map(record => record.data.text)).toEqual([
      "SDK transcript provenance was unavailable; associated message or tool history may be incomplete.",
    ])
  })

  test("a late tool callback after assistant-capture eviction holds its original epoch", async () => {
    const hook = createEventHook(deps)
    await sendUser("msg_assistant_eviction_parent", "many replies")
    const parent = userMessage("msg_assistant_eviction_parent")
    await emit(hook, { type: "message.updated", properties: { info: parent } })
    const assistants = Array.from({ length: SDK_TRANSCRIPT_MESSAGE_LIMIT + 1 }, (_, index) =>
      assistantMessage(`msg_assistant_capture_${index}`, parent.id, false))
    for (const info of assistants) await emit(hook, { type: "message.updated", properties: { info } })

    await emit(hook, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_evicted_assistant_tool",
          sessionID: SESSION,
          messageID: assistants[0]!.id,
          type: "tool",
          callID: "call_evicted_assistant_tool",
          tool: "read",
          state: { status: "running", input: { path: "private" }, time: { start: 1 } },
        },
      },
    })

    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    const transcript = records()
    expect(transcript.filter(record => record.kind.startsWith("tool-") || record.kind === "notice").map(record => record.data.text ?? record.data)).toEqual([
      "SDK transcript provenance was unavailable; associated message or tool history may be incomplete.",
    ])
    expect(JSON.stringify(transcript)).not.toContain("private")

    const evictedEpoch = fixtureSession.epoch
    releaseFixtureSession(fixture.worktree, fixtureSession)
    fixtureSession = attachAdmission(getOpenCodeRuntime(deps), SESSION, { engine: "opencode" })
    resumeAdmission(getOpenCodeRuntime(deps), SESSION)
    const replacementEpoch = admissionEpoch(fixture.worktree, SESSION)
    expect(replacementEpoch).not.toBe(evictedEpoch)
    const replacementTranscript = records()

    await emit(hook, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_evicted_assistant_tool",
          sessionID: SESSION,
          messageID: assistants[0]!.id,
          type: "tool",
          callID: "call_evicted_assistant_tool",
          tool: "read",
          state: { status: "running", input: { path: "must-not-append" }, time: { start: 2 } },
        },
      },
    })

    expect(records()).toEqual(replacementTranscript)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBe(replacementEpoch)
    expect(fixtureSession.metadata.held).toBe(false)
  })

  test("a late assistant response remains bound to its old parent epoch after explicit Resume", async () => {
    await sendUser("msg_old_parent", "old request")
    const oldEpoch = fixtureSession.epoch
    releaseFixtureSession(fixture.worktree, fixtureSession)
    fixtureSession = attachAdmission(getOpenCodeRuntime(deps), SESSION, { engine: "opencode" })
    expect(fixtureSession.epoch).not.toBe(oldEpoch)
    resumeAdmission(getOpenCodeRuntime(deps), SESSION)
    const newEpoch = admissionEpoch(fixture.worktree, SESSION)
    expect(newEpoch).toBe(fixtureSession.epoch)
    writeModeState(fixture.worktree, SESSION, {
      ...EMPTY_MODE,
      mode: "ulw",
      active: true,
      startedAt: Date.now(),
      failures: 4,
    })
    await expect(sendUser("msg_old_parent", "ultrawork: stale retry must not dispatch")).rejects.toThrow("stale-turn")

    const hook = createEventHook(deps)
    await emit(hook, { type: "message.part.updated", properties: { part: textPart("msg_late_assistant", "part_late", "stale response") } })
    await emit(hook, { type: "message.updated", properties: { info: assistantMessage("msg_late_assistant", "msg_old_parent") } })
    const repeated = "I will now proceed and repeat this sentence many times. ".repeat(8)
    await emit(hook, {
      type: "message.part.updated",
      properties: { part: textPart("msg_late_assistant", "part_late", repeated), delta: " repeated" },
    })
    await emit(hook, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_late_tool",
          sessionID: SESSION,
          messageID: "msg_late_assistant",
          type: "tool",
          callID: "call_late_tool",
          tool: "write",
          state: { status: "error", error: "stale failure", input: {}, time: { start: 1, end: 2 } },
        },
      },
    })

    expect(getOwnedSession(fixture.worktree, SESSION)?.epoch).toBe(newEpoch)
    expect(records().filter(record => record.kind === "user").map(record => record.data.text)).toEqual(["old request"])
    expect(records().filter(record => record.kind === "assistant")).toEqual([])
    expect(readModeState(fixture.worktree, SESSION).failures).toBe(4)
    expect(readModeState(fixture.worktree, SESSION).mode).toBe("ulw")
    expect(client.calls.filter(call => call.method === "abort")).toEqual([])
  })

  test("unbound worker prompts are refused and not retained as main-session user history", async () => {
    const hook = createChatMessageHook(deps)
    const child: UserMessage = { ...userMessage("msg_child_prompt"), agent: "worker" }
    const part = textPart(child.id, "part_child_prompt", "private child prompt")
    await expect(hook({ sessionID: SESSION, agent: "worker" }, { message: child, parts: [part] })).rejects.toThrow("unknown-role")
    expect(records()).toEqual([])
  })

  test("native-main calls without an execution binding persist only their actual SDK identity", async () => {
    await sendUser("msg_unbound_tool_user", "inspect the result")
    const hook = createEventHook(deps)
    await emit(hook, { type: "message.updated", properties: { info: userMessage("msg_unbound_tool_user") } })
    const assistant = assistantMessage("msg_unbound_tool_assistant", "msg_unbound_tool_user", false)
    await emit(hook, { type: "message.updated", properties: { info: assistant } })
    await emit(hook, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_unbound_tool",
          sessionID: SESSION,
          messageID: assistant.id,
          type: "tool",
          callID: "call_unbound_tool",
          tool: "read",
          state: { status: "running", input: {}, time: { start: 1 } },
        },
      },
    })

    const transcript = records()
    const notices = transcript.filter(record => record.kind === "notice")
    expect(transcript.filter(record => record.kind.startsWith("tool-"))).toEqual([])
    expect(notices).toHaveLength(1)
    expect(String(notices[0]?.data.text)).toContain(JSON.stringify([SESSION, assistant.id, "call_unbound_tool", "read", "running"]))
    expect(JSON.stringify(transcript)).not.toContain("taskID")
    expect(JSON.stringify(transcript)).not.toContain("executionID")
  })

  test("native-main tools persist deduplicated safe facts and one first-terminal conflict notice", async () => {
    await sendUser("msg_native_tool_user", "inspect the tool")
    const hook = createEventHook(deps)
    await emit(hook, { type: "message.updated", properties: { info: userMessage("msg_native_tool_user") } })
    const assistant = assistantMessage("msg_native_tool_assistant", "msg_native_tool_user", false)
    await emit(hook, { type: "message.updated", properties: { info: assistant } })
    const part = (status: "running" | "completed" | "error") => ({
      id: "part_native_tool",
      sessionID: SESSION,
      messageID: assistant.id,
      type: "tool",
      callID: "call_native_tool",
      tool: "read",
      state: status === "running"
        ? { status, input: { filePath: "private-input-path" }, time: { start: 1 } }
        : status === "completed"
          ? { status, input: { filePath: "private-input-path" }, output: "private-output-body", title: "read", metadata: {}, time: { start: 1, end: 2 } }
          : { status, input: { filePath: "private-input-path" }, error: "private-error-body", metadata: {}, time: { start: 1, end: 2 } },
    })
    const emitTool = (status: "running" | "completed" | "error") => emit(hook, {
      type: "message.part.updated",
      properties: { part: part(status) },
    })

    await emitTool("running")
    await emitTool("running")
    await emitTool("completed")
    await emitTool("completed")
    await emitTool("error")
    await emitTool("error")

    const transcript = records()
    const toolNotices = transcript.filter(record => record.kind === "notice" && String(record.data.text).startsWith("main tool"))
    expect(toolNotices).toHaveLength(3)
    expect(String(toolNotices[0]?.data.text)).toContain(JSON.stringify([SESSION, assistant.id, "call_native_tool", "read", "running"]))
    expect(String(toolNotices[1]?.data.text)).toContain(JSON.stringify([SESSION, assistant.id, "call_native_tool", "read", "succeeded"]))
    expect(String(toolNotices[2]?.data.text)).toContain(JSON.stringify([SESSION, assistant.id, "call_native_tool", "read", "succeeded", "failed"]))
    expect(transcript.filter(record => record.kind.startsWith("tool-"))).toEqual([])
    const serialized = JSON.stringify(transcript)
    expect(serialized).not.toContain("private-input-path")
    expect(serialized).not.toContain("private-output-body")
    expect(serialized).not.toContain("private-error-body")
    expect(serialized).not.toContain("startedAt")
  })

  test("a stale native-main tool callback cannot append to the replacement session epoch", async () => {
    await sendUser("msg_stale_tool_user", "current request")
    const hook = createEventHook(deps)
    await emit(hook, { type: "message.updated", properties: { info: userMessage("msg_stale_tool_user") } })
    const assistant = assistantMessage("msg_stale_tool_assistant", "msg_stale_tool_user", false)
    await emit(hook, { type: "message.updated", properties: { info: assistant } })
    const oldStore = fixtureSession
    holdAdmission(fixture.worktree, SESSION, "replace-before-tool-event")
    releaseFixtureSession(fixture.worktree, oldStore)
    fixtureSession = attachAdmission(getOpenCodeRuntime(deps), SESSION, { engine: "opencode" })
    const before = records()

    await emit(hook, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_stale_native_tool",
          sessionID: SESSION,
          messageID: assistant.id,
          type: "tool",
          callID: "call_stale_native_tool",
          tool: "read",
          state: { status: "running", input: { filePath: "must-not-store" }, time: { start: 1 } },
        },
      },
    })

    expect(records()).toEqual(before)
    expect(fixtureSession.metadata.held).toBe(true)
  })

  test("bound tool facts persist only safe IDs and retain one first terminal with one conflict diagnostic", async () => {
    const runtime = getOpenCodeRuntime(deps)
    const childID = "ses_tool_fact_child"
    const executionID = "exec_sdk_tool_fact"
    const taskID = "task_sdk_tool_fact"
    const claim = runtime.runs.claim(SESSION, runtime.instance, process.pid)
    runtime.runs.registerIntent(claim, {
      executionId: executionID,
      ownerSession: SESSION,
      taskId: taskID,
      attemptId: "attempt_sdk_tool_fact",
      generation: claim.generation,
      role: "worker",
      cwd: fixture.worktree,
      policyID: runtime.policy.resolve("worker").id,
      kind: "host",
      engine: "opencode",
      profile: "legacy-unowned",
    })

    const hook = createEventHook(deps)
    const childSession = {
      id: childID,
      projectID: "fixture-project",
      directory: fixture.worktree,
      parentID: SESSION,
      title: "worker",
      version: "fixture",
      time: { created: 222, updated: 223 },
    }
    authenticateSDKSession(childSession)
    await emit(hook, { type: "session.created", properties: { info: childSession } })
    expect(getOwnedSession(fixture.worktree, childID)).toBeUndefined()
    expect(existsSync(sessionDir(fixture.worktree, childID))).toBe(false)
    runtime.runs.bindVendorRef(claim, executionID, JSON.stringify({ executionID, vendorSessionID: childID }))
    runtime.runs.markHostDispatched(claim, executionID)
    const prompt: UserMessage = { ...userMessage("msg_child_tool_prompt"), sessionID: childID, agent: "worker" }
    await emit(hook, { type: "message.updated", properties: { info: prompt } })
    const assistant: AssistantMessage = { ...assistantMessage("msg_child_tool_assistant", prompt.id, false), sessionID: childID }
    await emit(hook, { type: "message.updated", properties: { info: assistant } })
    const tool = (status: "running" | "completed" | "error") => ({
      id: "part_actual_tool_fact",
      sessionID: childID,
      messageID: assistant.id,
      type: "tool",
      callID: "call_actual_tool_fact",
      tool: "read",
      state: status === "running"
        ? { status, input: { filePath: "/private/path" }, time: { start: 1 } }
        : status === "completed"
          ? { status, input: { filePath: "/private/path" }, output: "private tool output", title: "read", metadata: {}, time: { start: 1, end: 2 } }
          : { status, input: { filePath: "/private/path" }, error: "private tool error", metadata: {}, time: { start: 1, end: 2 } },
    })
    await emit(hook, { type: "message.part.updated", properties: { part: tool("running") } })
    await emit(hook, { type: "message.part.updated", properties: { part: tool("completed") } })
    await emit(hook, { type: "message.part.updated", properties: { part: tool("error") } })

    const transcript = records()
    expect(transcript.filter(record => record.kind === "tool-start").map(record => record.data)).toEqual([{
      name: "read",
      role: "worker",
      executionID,
      callID: "call_actual_tool_fact",
      taskID,
      outcome: "running",
    }])
    expect(transcript.filter(record => record.kind === "tool-result").map(record => record.data)).toEqual([{
      name: "read",
      role: "worker",
      executionID,
      callID: "call_actual_tool_fact",
      taskID,
      outcome: "succeeded",
    }])
    const diagnostics = transcript.filter(record => record.kind === "notice" && String(record.data.text).includes("Conflicting terminal tool fact"))
    expect(diagnostics).toHaveLength(1)
    expect(JSON.stringify(transcript)).not.toContain("private tool output")
    expect(JSON.stringify(transcript)).not.toContain("private tool error")
    expect(JSON.stringify(transcript)).not.toContain("/private/path")
    expect(JSON.stringify(transcript)).not.toContain("startedAt")
  })

  test("session.deleted retains collected history and metadata without replaying the SDK session", async () => {
    await sendUser("msg_retained", "retain this text")
    const hook = createEventHook(deps)
    await emit(hook, { type: "message.updated", properties: { info: userMessage("msg_retained") } })
    await emit(hook, { type: "message.part.updated", properties: { part: textPart("msg_retained_assistant", "part_retained", "retained answer") } })
    const answer = assistantMessage("msg_retained_assistant", "msg_retained")
    canonical(answer, [textPart(answer.id, "part_retained", "retained answer")])
    await emit(hook, { type: "message.updated", properties: { info: answer } })
    const before = records()

    await emit(hook, { type: "session.deleted", properties: { info: { id: SESSION } } })

    expect(getOwnedSession(fixture.worktree, SESSION)).toBeUndefined()
    expect(readSessionMetadata(fixture.worktree, SESSION)).toMatchObject({ engine: "opencode", held: true })
    expect(records()).toEqual(before)
    expect(client.calls.filter(call => call.method === "messages" || call.method === "prompt" || call.method === "promptAsync")).toEqual([])
  })

  test("a delayed old session.deleted cannot release or rewrite a new held same-SID attachment", async () => {
    const hook = createEventHook(deps)
    const sdkSession = {
      id: SESSION,
      projectID: "fixture-project",
      directory: fixture.worktree,
      title: "SDK session",
      version: "fixture",
      time: { created: 111, updated: 112 },
    }
    authenticateSDKSession(sdkSession)
    await emit(hook, { type: "session.created", properties: { info: sdkSession } })
    const oldEpoch = fixtureSession.epoch
    holdAdmission(fixture.worktree, SESSION, "test-same-sid-reattach")
    const oldStore = fixtureSession
    releaseFixtureSession(fixture.worktree, oldStore)
    fixtureSession = attachAdmission(getOpenCodeRuntime(deps), SESSION, { engine: "opencode" })
    expect(fixtureSession.epoch).not.toBe(oldEpoch)
    expect(fixtureSession.metadata.held).toBe(true)
    await emit(hook, { type: "session.created", properties: { info: sdkSession } })

    const lockBefore = readFileSync(join(sessionDir(fixture.worktree, SESSION), "attach.lock"))
    const metadataBefore = readFileSync(join(sessionDir(fixture.worktree, SESSION), "metadata.json"))
    await emit(hook, { type: "session.deleted", properties: { info: sdkSession } })

    expect(getOwnedSession(fixture.worktree, SESSION)?.epoch).toBe(fixtureSession.epoch)
    expect(readFileSync(join(sessionDir(fixture.worktree, SESSION), "attach.lock"))).toEqual(lockBefore)
    expect(readFileSync(join(sessionDir(fixture.worktree, SESSION), "metadata.json"))).toEqual(metadataBefore)
  })

  test("a transcript append failure holds the captured epoch, refuses the turn, and aborts the known SDK session", async () => {
    ;(fixtureSession as any).append = () => { throw new Error("injected fsync failure") }
    const hook = createChatMessageHook(deps)
    const part = await sendUser("msg_append_failure", "ultrawork: do not run", hook)

    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(part.text).toContain("could not be durably recorded")
    expect(readModeState(fixture.worktree, SESSION)).toEqual(EMPTY_MODE)
    expect(client.calls.filter(call => call.method === "abort")).toHaveLength(1)
    delete (fixtureSession as any).append
  })

  test("a mismatched canonical assistant identity visibly holds and aborts the current owner", async () => {
    await sendUser("msg_canonical_mismatch_user", "request")
    const hook = createEventHook(deps)
    await emit(hook, { type: "message.updated", properties: { info: userMessage("msg_canonical_mismatch_user") } })
    const answer = assistantMessage("msg_canonical_mismatch_answer", "msg_canonical_mismatch_user")
    const mismatched = { ...answer, parentID: "msg_other_parent" }
    ;(client.session as any).message = async () => ({ data: { info: mismatched, parts: [textPart(answer.id, "part_mismatch", "must not persist")] } })

    await emit(hook, { type: "message.updated", properties: { info: answer } })

    expect(fixtureSession.metadata.held).toBe(true)
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(records().filter(record => record.kind === "assistant")).toEqual([])
    expect(client.calls.filter(call => call.method === "abort")).toHaveLength(1)
  })

  test("an awaited failure abort cannot mutate a replacement attachment", async () => {
    const userID = "msg_abort_parent"
    await sendUser(userID, "request with captured parent")
    const hook = createEventHook(deps)
    await emit(hook, { type: "message.updated", properties: { info: userMessage(userID) } })
    await emit(hook, { type: "message.part.updated", properties: { part: textPart("msg_abort_assistant", "part_abort", "answer") } })

    ;(fixtureSession as any).append = () => { throw new Error("injected assistant append failure") }
    let beginAbort!: () => void
    let finishAbort!: (value: { data: boolean }) => void
    const abortStarted = new Promise<void>(resolve => { beginAbort = resolve })
    client.session.abort = async args => {
      client.calls.push({ method: "abort", args })
      beginAbort()
      return await new Promise(resolve => { finishAbort = resolve })
    }
    const oldStore = fixtureSession
    canonical(assistantMessage("msg_abort_assistant", userID), [textPart("msg_abort_assistant", "part_abort", "answer")])
    const pending = emit(hook, {
      type: "message.updated",
      properties: { info: assistantMessage("msg_abort_assistant", userID) },
    })
    await abortStarted

    delete (oldStore as any).append
    releaseFixtureSession(fixture.worktree, oldStore)
    fixtureSession = attachAdmission(getOpenCodeRuntime(deps), SESSION, { engine: "opencode" })
    resumeAdmission(getOpenCodeRuntime(deps), SESSION)
    const replacementEpoch = admissionEpoch(fixture.worktree, SESSION)
    expect(replacementEpoch).toBe(fixtureSession.epoch)

    finishAbort({ data: true })
    await pending
    expect(admissionEpoch(fixture.worktree, SESSION)).toBe(replacementEpoch)
    expect(fixtureSession.metadata.held).toBe(false)
  })

  test("a canonical assistant read completing after reattachment has no effect on the replacement", async () => {
    const userID = "msg_stale_fetch_parent"
    await sendUser(userID, "request before reattachment")
    const hook = createEventHook(deps)
    await emit(hook, { type: "message.updated", properties: { info: userMessage(userID) } })
    let beginRead!: () => void
    let finishRead!: (value: { data: { info: AssistantMessage; parts: TextPart[] } }) => void
    const readStarted = new Promise<void>(resolve => { beginRead = resolve })
    ;(client.session as any).message = async () => {
      beginRead()
      return await new Promise(resolve => { finishRead = resolve })
    }
    const answer = assistantMessage("msg_stale_fetch_answer", userID)
    const pending = emit(hook, { type: "message.updated", properties: { info: answer } })
    await readStarted

    const oldStore = fixtureSession
    holdAdmission(fixture.worktree, SESSION, "test-hold-during-sdk-read")
    releaseFixtureSession(fixture.worktree, oldStore)
    fixtureSession = attachAdmission(getOpenCodeRuntime(deps), SESSION, { engine: "opencode" })
    const lockBefore = readFileSync(join(sessionDir(fixture.worktree, SESSION), "attach.lock"))
    const metadataBefore = readFileSync(join(sessionDir(fixture.worktree, SESSION), "metadata.json"))

    finishRead({ data: { info: answer, parts: [textPart(answer.id, "part_stale_fetch", "late answer")] } })
    await pending

    expect(records().filter(record => record.kind === "assistant")).toEqual([])
    expect(admissionEpoch(fixture.worktree, SESSION)).toBeUndefined()
    expect(fixtureSession.metadata.held).toBe(true)
    expect(readFileSync(join(sessionDir(fixture.worktree, SESSION), "attach.lock"))).toEqual(lockBefore)
    expect(readFileSync(join(sessionDir(fixture.worktree, SESSION), "metadata.json"))).toEqual(metadataBefore)
    expect(client.calls.filter(call => call.method === "abort")).toEqual([])
  })
})
