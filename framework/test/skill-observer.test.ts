import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { loadConfig, projectConfigPath, type OtterConfig } from "../src/config.ts"
import type { CoreDeps } from "../src/deps.ts"
import type { HookDeps } from "../src/hooks/types.ts"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { createEventHook } from "../src/hooks/event.ts"
import { clearToolObservations } from "../src/hosts/tool-observation.ts"
import { observationConfigGeneration, observeSkillBoundary, observeSkillMessage, observeSkillPart, observeSkillTurn, skillObservationBinding } from "../src/telemetry/skill-observer.ts"
import { activateSkillCampaign, getSkillCampaignStatus, listSkillObservations, skillObservationDatabasePath, skillObservationBindingHash, stopSkillCampaign } from "../src/telemetry/skills.ts"
import { admitFixtureSession, fakeClient, makeDeps, releaseFixtureSession, tempWorktree } from "./guards-helpers.ts"
import { createNativeToolFixture } from "./native-tool-fixture.ts"

let wt: ReturnType<typeof tempWorktree>
let configuration: { skill_observation: { enabled: boolean; campaign_id: string; owner_binding: string } }
let fixtureSessions: Array<{ worktree: string; store: ReturnType<typeof admitFixtureSession> }>
let observationSessions: Set<string>

function fixtureClient(directory = wt.worktree) {
  const client = fakeClient()
  ;(client.session as unknown as { get: (input: { path: { id: string } }) => Promise<unknown> }).get = async ({ path }) => ({
    data: { id: path.id, directory: realpathSync.native(directory), time: { created: 1 } },
  })
  return client
}

function fixtureDeps(directory = wt.worktree, patch: Partial<OtterConfig> = configuration): HookDeps {
  return makeDeps(fixtureClient(directory), directory, patch)
}

function admitSession(deps: HookDeps, sessionID: string) {
  observationSessions.add(sessionID)
  const store = admitFixtureSession(deps, sessionID)
  if (!fixtureSessions.some((session) => session.store === store)) fixtureSessions.push({ worktree: deps.worktree, store })
  return store
}

async function createNativeEventFixture(deps: HookDeps, sessionID: string) {
  observationSessions.add(sessionID)
  const native = await createNativeToolFixture(deps, { role: "main", sessionID })
  const event = createEventHook(deps)
  const userMessage = await native.acceptUserTurn()
  await event({ event: { type: "message.updated", properties: { info: userMessage } } } as never)
  return {
    event,
    async primeCall(options: Parameters<typeof native.primeCall>[0]) {
      const call = native.primeCall(options)
      await event({ event: { type: "message.updated", properties: { info: call.assistantMessage } } } as never)
      return call
    },
  }
}

beforeEach(() => {
  wt = tempWorktree()
  wt.worktree = realpathSync.native(wt.worktree)
  fixtureSessions = []
  observationSessions = new Set()
  configuration = { skill_observation: { enabled: true, campaign_id: campaign, owner_binding: skillObservationBindingHash(wt.worktree) } }
  admitSession(fixtureDeps(), "session-one")
})
afterEach(() => {
  for (const session of fixtureSessions) releaseFixtureSession(session.worktree, session.store)
  for (const sessionID of observationSessions) clearToolObservations(wt.worktree, sessionID)
  wt.cleanup()
})
const campaign = "observer-fixture"
const skill = (callID: string, status = "error") => ({
  type: "tool", tool: "skill", sessionID: "session-one", messageID: "assistant-one", callID,
  state: { status, input: { name: "fixture-skill", extra: "PRIVATE_ARGUMENT_SENTINEL" }, error: "PRIVATE_ERROR_SENTINEL", time: { start: Date.now(), end: Date.now() } },
})
const partEvent = (part: unknown) => ({ event: { type: "message.part.updated", properties: { part } } } as never)

test("host-neutral dependencies retain observation and history refusal", () => {
  activateSkillCampaign(wt.worktree, campaign)
  const config = structuredClone(loadConfig(wt.worktree))
  config.skill_observation = { ...config.skill_observation, ...configuration.skill_observation }
  const deps: CoreDeps = { directory: wt.worktree, worktree: wt.worktree, config, log() {} }
  const generation = observationConfigGeneration(deps)
  expect(skillObservationBinding(deps)?.campaignID).toBe(campaign)
  observeSkillPart(deps, skill("neutral-call"))
  expect(getSkillCampaignStatus(wt.worktree).callCount).toBe(1)

  config.disabled_hooks.push("tool.history")
  expect(skillObservationBinding(deps)).toBeNull()
  expect(observationConfigGeneration(deps)).not.toBe(generation)
  observeSkillPart(deps, skill("refused-neutral-call"))
  expect(getSkillCampaignStatus(wt.worktree).callCount).toBe(1)
})

test("off, history-disabled and config-only hooks cannot create a campaign", async () => {
  const patches = [{}, { ...configuration, disabled_hooks: ["tool.history"] }, configuration]
  for (const [index, patch] of patches.entries()) {
    const sessionID = `unconfigured_session_${index}`
    const deps = fixtureDeps(wt.worktree, patch)
    admitSession(deps, sessionID)
    const native = await createNativeEventFixture(deps, sessionID)
    const call = await native.primeCall({ tool: "skill", args: { name: "fixture-skill" } })
    await createToolBeforeHook(deps)(call.input as any, call.output as any)
    await native.event(partEvent({
      ...call.part,
      state: { status: "error", input: call.output.args, error: "unconfigured fixture failure", time: { start: 1, end: 2 } },
    }))
    expect(existsSync(skillObservationDatabasePath(wt.worktree))).toBe(false)
  }
})

test("wrong campaign identity neither consumes quota nor reads output", () => {
  activateSkillCampaign(wt.worktree, campaign)
  const deps = fixtureDeps(wt.worktree, { skill_observation: { ...configuration.skill_observation, campaign_id: "another-campaign" } })
  const part = skill("call-one", "completed")
  Object.defineProperty(part.state, "output", { get() { throw new Error("output must remain unread") } })
  observeSkillPart(deps, part)
  expect(getSkillCampaignStatus(wt.worktree).callCount).toBe(0)
})

test("copied enabled configuration cannot collect a foreign worktree into its owner", () => {
  activateSkillCampaign(wt.worktree, campaign)
  const foreign = join(wt.worktree, "foreign-project")
  const copied = { skill_observation: { ...configuration.skill_observation, owner_root: wt.worktree } }
  for (const root of [wt.worktree, foreign]) {
    mkdirSync(join(root, ".otter"), { recursive: true })
    writeFileSync(projectConfigPath(root), JSON.stringify(copied))
  }
  const deps = fixtureDeps(foreign, loadConfig(foreign))
  admitSession(deps, "foreign-session")
  expect(skillObservationBinding(deps)).toBeNull()
  let outputRead = false
  const part = skill("foreign-call", "completed")
  Object.defineProperty(part.state, "output", { get() { outputRead = true; return "foreign body" } })
  observeSkillPart(deps, part)
  observeSkillTurn(deps, { sessionID: "foreign-session", messageID: "foreign-turn", role: "user", phase: "pending" })
  expect(outputRead).toBe(false)
  expect(getSkillCampaignStatus(wt.worktree)).toMatchObject({ sessionCount: 0, callCount: 0, storedFactCount: 0 })
  expect(existsSync(skillObservationDatabasePath(foreign))).toBe(false)
})

test("canonical aliases of the same worktree retain their bound campaign", () => {
  activateSkillCampaign(wt.worktree, campaign)
  const alias = join(wt.worktree, "self-alias")
  symlinkSync(wt.worktree, alias, "dir")
  const deps = fixtureDeps(alias, {
    skill_observation: { ...configuration.skill_observation, owner_root: wt.worktree },
  })
  expect(skillObservationBinding(deps)).toEqual({ root: realpathSync.native(wt.worktree), campaignID: campaign })
  observeSkillPart(deps, skill("alias-call"))
  expect(getSkillCampaignStatus(wt.worktree)).toMatchObject({ sessionCount: 1, callCount: 1 })
})

test.each(["observer.fixture", "observer:fixture"])("CLI activation and observer share campaign grammar: %s", (campaignID) => {
  const cli = resolve(import.meta.dir, "../../scripts/otter-skill-observation.ts")
  const activation = spawnSync(process.execPath, [cli, "activate", "--root", wt.worktree, "--campaign-id", campaignID], {
    env: { ...process.env, OTTER_STATE_HOME: wt.stateHome }, encoding: "utf8",
  })
  expect(activation.status).toBe(0)
  const receipt = JSON.parse(activation.stdout)
  mkdirSync(join(wt.worktree, ".otter"), { recursive: true })
  writeFileSync(projectConfigPath(wt.worktree), JSON.stringify({
    skill_observation: { enabled: true, campaign_id: campaignID, owner_root: wt.worktree, owner_binding: receipt.ownerBinding },
  }))
  const deps = fixtureDeps(wt.worktree, loadConfig(wt.worktree))
  observeSkillPart(deps, skill("punctuation-call"))
  expect(getSkillCampaignStatus(wt.worktree)).toMatchObject({ campaignID, sessionCount: 1, callCount: 1 })
  expect(listSkillObservations(wt.worktree).facts[0]).toMatchObject({ phase: "terminal", payload: { state: "error" } })
})

test("actual before/error stream deduplicates and preserves existing repeat refusal", async () => {
  activateSkillCampaign(wt.worktree, campaign)
  const deps = fixtureDeps()
  admitSession(deps, "session-one")
  const before = createToolBeforeHook(deps)
  const native = await createNativeEventFixture(deps, "session-one")
  for (const callID of ["call-one", "call-two"]) {
    const args = { name: "fixture-skill", extra: "PRIVATE_ARGUMENT_SENTINEL" }
    const call = await native.primeCall({ tool: "skill", args, callID })
    await before(call.input as any, call.output as any)
    const toolEvent = partEvent({
      ...call.part,
      state: { status: "error", input: call.output.args, error: "PRIVATE_ERROR_SENTINEL", time: { start: Date.now(), end: Date.now() } },
    })
    await native.event(toolEvent)
    await native.event(toolEvent)
  }
  const denied = await native.primeCall({
    tool: "skill", args: { name: "fixture-skill", extra: "PRIVATE_ARGUMENT_SENTINEL" }, callID: "call-three",
  })
  await expect(before(denied.input as any, denied.output as any)).rejects.toThrow("blocked repeated call")
  const snapshot = listSkillObservations(wt.worktree)
  expect(snapshot.campaign.callCount).toBe(3)
  const calls = snapshot.facts.filter((fact) => fact.kind === "skill_call")
  expect(calls).toHaveLength(3)
  expect(calls.filter((fact) => fact.payload.state === "error")).toHaveLength(2)
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_ARGUMENT_SENTINEL")
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_ERROR_SENTINEL")
})

test("closed observer ignores a new output body without affecting its host object", () => {
  activateSkillCampaign(wt.worktree, campaign)
  stopSkillCampaign(wt.worktree, campaign)
  const deps = fixtureDeps()
  const part = skill("call-closed", "completed")
  let read = false
  Object.defineProperty(part.state, "output", { get() { read = true; return "PRIVATE_OUTPUT_SENTINEL" } })
  observeSkillPart(deps, part)
  expect(read).toBe(false)
  expect(part.state.status).toBe("completed")
  expect(getSkillCampaignStatus(wt.worktree).callCount).toBe(0)
})

test("pending-before-running-completed host ordering is one nonconflicted successful call", async () => {
  activateSkillCampaign(wt.worktree, campaign)
  const deps = fixtureDeps()
  admitSession(deps, "session-one")
  const native = await createNativeEventFixture(deps, "session-one")
  const call = await native.primeCall({ tool: "skill", args: { name: "fixture-skill" }, callID: "successful-call" })
  await native.event(partEvent({ ...call.part, state: { status: "pending", input: call.output.args } }))
  await createToolBeforeHook(deps)(call.input as any, call.output as any)
  const start = Date.now()
  await native.event(partEvent({ ...call.part, state: { status: "running", input: call.output.args, time: { start } } }))
  const completed = {
    ...call.part,
    state: { status: "completed", input: call.output.args, output: "Synthetic returned fixture content",
      metadata: { name: "fixture-skill" }, time: { start, end: Date.now() } },
  }
  await native.event(partEvent(completed))
  await native.event(partEvent(completed))
  const snapshot = listSkillObservations(wt.worktree)
  expect(snapshot.campaign.callCount).toBe(1)
  const calls = snapshot.facts.filter((fact) => fact.kind === "skill_call")
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    phase: "terminal", conflict: false,
    payload: { state: "completed", beforeSeen: true, terminalSeen: true, returnedContent: "observed", conflictCount: 0 },
  })
})

test("host terminal message closes its exact user turn without erasing prior advice", () => {
  activateSkillCampaign(wt.worktree, campaign)
  const deps = fixtureDeps()
  observeSkillTurn(deps, { sessionID: "session-one", messageID: "user-one", role: "user", phase: "pending", routerExposure: "suggest", routeDecisionID: "decision-one", routeSkillName: "fixture-skill", adviceInserted: true })
  observeSkillMessage(deps, { sessionID: "session-one", id: "assistant-one", role: "assistant", parentID: "user-one", agent: "main", finish: "stop", time: { completed: Date.now() } })
  const turns = listSkillObservations(wt.worktree).facts.filter((fact) => fact.kind === "turn_context")
  const user = turns.find((fact) => fact.factKey === "user-one")!
  expect(user.phase).toBe("terminal")
  expect(user.conflict).toBe(false)
  expect(user.payload).toMatchObject({ routeDecisionID: "decision-one", routeSkillName: "fixture-skill", adviceInserted: true })
  const assistant = turns.find((fact) => fact.factKey === "assistant-one")!
  expect(assistant.payload).toMatchObject({ parentMessageID: "user-one", actualAgent: "main" })
})

test("known preactivation terminal is rejected before output inspection or quota admission", () => {
  const activated = activateSkillCampaign(wt.worktree, campaign)
  const deps = fixtureDeps()
  const part = skill("old-call", "completed")
  part.state.time = { start: activated.activatedAt! - 20, end: activated.activatedAt! - 10 }
  Object.defineProperty(part.state, "output", { get() { throw new Error("old output must remain unread") } })
  observeSkillPart(deps, part)
  const status = getSkillCampaignStatus(wt.worktree)
  expect(status.callCount).toBe(0)
  expect(status.sessionCount).toBe(0)
  expect(status.rejections.preactivation).toBe(1)
})

test("related non-skill tools keep exact metadata but never inspect content or spend skill quota", async () => {
  activateSkillCampaign(wt.worktree, campaign)
  const deps = fixtureDeps()
  const native = await createNativeEventFixture(deps, "session-one")
  const call = await native.primeCall({ tool: "bash", args: { command: "printf safe" }, callID: "shell-one" })
  await createToolBeforeHook(deps)(call.input as any, call.output as any)
  const at = Date.now()
  const state: Record<string, unknown> = {
    status: "completed", input: call.output.args, time: { start: at, end: at },
  }
  let bodyReads = 0
  for (const key of ["output", "error", "title"]) Object.defineProperty(state, key, {
    get() { bodyReads++; return "PRIVATE_TOOL_CONTENT_SENTINEL" },
  })
  const outputDescriptor = Object.getOwnPropertyDescriptor(state, "output")
  const originalKeys = Reflect.ownKeys(state)
  const part = { ...call.part, state }
  await native.event(partEvent(part))
  await native.event(partEvent(part))
  const snapshot = listSkillObservations(wt.worktree)
  expect(snapshot.campaign).toMatchObject({ callCount: 0, sessionCount: 1 })
  const toolFacts = snapshot.facts.filter((fact) => fact.kind === "tool_context")
  expect(toolFacts).toHaveLength(1)
  expect(toolFacts[0]).toMatchObject({ kind: "tool_context", phase: "terminal", conflict: false })
  expect(toolFacts[0]!.payload).toMatchObject({ messageID: call.assistantMessageID, tool: "bash", status: "completed", durationMs: 0 })
  expect(bodyReads).toBe(0)
  expect(Reflect.ownKeys(state)).toEqual(originalKeys)
  expect(Object.getOwnPropertyDescriptor(state, "output")).toEqual(outputDescriptor)
  expect(state.input).toBe(call.output.args)
  expect(call.part.state.status).toBe("running")
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_TOOL_CONTENT_SENTINEL")
})

test("completed tool-call assistant messages do not leave pending keys or close the user turn early", () => {
  activateSkillCampaign(wt.worktree, campaign)
  const deps = fixtureDeps()
  observeSkillTurn(deps, { sessionID: "session-one", messageID: "user-one", role: "user", phase: "pending" })
  observeSkillMessage(deps, {
    sessionID: "session-one", id: "assistant-tool", parentID: "user-one", role: "assistant", agent: "worker",
    providerID: "local", modelID: "observed-model", finish: "tool-calls", time: { completed: Date.now() },
  })
  let snapshot = listSkillObservations(wt.worktree)
  expect(snapshot.campaign.pendingCount).toBe(1)
  expect(snapshot.facts.find((fact) => fact.factKey === "assistant-tool")).toMatchObject({
    phase: "terminal", payload: { actualAgent: "worker", agentBasis: "sdk_agent_field", actualModel: "local/observed-model" },
  })
  expect(snapshot.facts.find((fact) => fact.factKey === "user-one")!.phase).toBe("pending")
  observeSkillMessage(deps, {
    sessionID: "session-one", id: "assistant-final", parentID: "user-one", role: "assistant",
    agent: "main", finish: "stop", time: { completed: Date.now() },
  })
  snapshot = listSkillObservations(wt.worktree)
  expect(snapshot.campaign.pendingCount).toBe(0)
  expect(snapshot.facts.find((fact) => fact.factKey === "user-one")).toMatchObject({
    phase: "terminal", conflict: false, payload: { closureReason: "completed" },
  })
})

test("compaction and deletion censor only already-admitted exact session turns", () => {
  activateSkillCampaign(wt.worktree, campaign)
  const deps = fixtureDeps()
  for (const sessionID of ["compacted-session", "deleted-session", "untouched-session"]) {
    admitSession(deps, sessionID)
    observeSkillTurn(deps, { sessionID, messageID: "user-one", role: "user", phase: "pending" })
  }
  observeSkillBoundary(deps, "compacted-session", "compacted")
  observeSkillBoundary(deps, "deleted-session", "deleted")
  observeSkillBoundary(deps, "unobserved-session", "deleted")
  const snapshot = listSkillObservations(wt.worktree)
  expect(snapshot.campaign.sessionCount).toBe(3)
  expect(snapshot.facts.find((fact) => fact.sessionID === "compacted-session")).toMatchObject({ phase: "terminal", payload: { closureReason: "compacted" } })
  expect(snapshot.facts.find((fact) => fact.sessionID === "deleted-session")).toMatchObject({ phase: "terminal", payload: { closureReason: "deleted" } })
  expect(snapshot.facts.find((fact) => fact.sessionID === "untouched-session")!.phase).toBe("pending")
})

test("configuration strata react to routing thresholds without hashing endpoints or credentials", () => {
  const deps = fixtureDeps()
  deps.config.skill_router = { ...deps.config.skill_router }
  const original = observationConfigGeneration(deps)
  deps.config.skill_router.endpoint = "http://PRIVATE_ENDPOINT_SENTINEL:secret@127.0.0.1"
  expect(observationConfigGeneration(deps)).toBe(original)
  deps.config.skill_router.min_probability = 0.123
  expect(observationConfigGeneration(deps)).not.toBe(original)
  expect(observationConfigGeneration(deps)).toMatch(/^[a-f0-9]{64}$/)
})

test("incomplete or unsafe allowlists are unknown configuration strata", () => {
  const firstSixteen = Array.from({ length: 16 }, (_, index) => `skill-${index}`)
  const deps = fixtureDeps(wt.worktree, { ...configuration, skills: { allow: firstSixteen } })
  expect(observationConfigGeneration(deps)).toMatch(/^[a-f0-9]{64}$/)
  deps.config.skills = { allow: [...firstSixteen, "seventeenth-a"] }
  expect(observationConfigGeneration(deps)).toBeNull()
  deps.config.skills = { allow: [...firstSixteen, "seventeenth-b"] }
  expect(observationConfigGeneration(deps)).toBeNull()
  deps.config.skills = { allow: ["valid-skill", "../invalid"] }
  expect(observationConfigGeneration(deps)).toBeNull()
})
