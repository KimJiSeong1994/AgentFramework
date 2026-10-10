import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { loadConfig, projectConfigPath } from "../src/config.ts"
import type { CoreDeps } from "../src/deps.ts"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { createEventHook } from "../src/hooks/event.ts"
import { observationConfigGeneration, observeRelatedToolPart, observeSkillBoundary, observeSkillMessage, observeSkillPart, observeSkillTurn, skillObservationBinding } from "../src/telemetry/skill-observer.ts"
import { activateSkillCampaign, getSkillCampaignStatus, listSkillObservations, skillObservationDatabasePath, skillObservationBindingHash, stopSkillCampaign } from "../src/telemetry/skills.ts"
import { fakeClient, makeDeps, tempWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempWorktree>
let configuration: { skill_observation: { enabled: boolean; campaign_id: string; owner_binding: string } }
beforeEach(() => {
  wt = tempWorktree()
  configuration = { skill_observation: { enabled: true, campaign_id: campaign, owner_binding: skillObservationBindingHash(wt.worktree) } }
})
afterEach(() => wt.cleanup())
const campaign = "observer-fixture"
const skill = (callID: string, status = "error") => ({
  type: "tool", tool: "skill", sessionID: "session-one", messageID: "assistant-one", callID,
  state: { status, input: { name: "fixture-skill", extra: "PRIVATE_ARGUMENT_SENTINEL" }, error: "PRIVATE_ERROR_SENTINEL", time: { start: Date.now(), end: Date.now() } },
})

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
  for (const patch of [{}, { ...configuration, disabled_hooks: ["tool.history"] }, configuration]) {
    const deps = makeDeps(fakeClient(), wt.worktree, patch)
    await createToolBeforeHook(deps)({ tool: "skill", sessionID: "session-one", callID: "call-one" }, { args: { name: "fixture-skill" } })
    observeSkillPart(deps, skill("call-one"))
    expect(existsSync(skillObservationDatabasePath(wt.worktree))).toBe(false)
  }
})

test("wrong campaign identity neither consumes quota nor reads output", () => {
  activateSkillCampaign(wt.worktree, campaign)
  const deps = makeDeps(fakeClient(), wt.worktree, { skill_observation: { ...configuration.skill_observation, campaign_id: "another-campaign" } })
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
    mkdirSync(join(root, ".lca"), { recursive: true })
    writeFileSync(projectConfigPath(root), JSON.stringify(copied))
  }
  const deps = makeDeps(fakeClient(), foreign, loadConfig(foreign))
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
  const deps = makeDeps(fakeClient(), alias, {
    skill_observation: { ...configuration.skill_observation, owner_root: wt.worktree },
  })
  expect(skillObservationBinding(deps)).toEqual({ root: realpathSync.native(wt.worktree), campaignID: campaign })
  observeSkillPart(deps, skill("alias-call"))
  expect(getSkillCampaignStatus(wt.worktree)).toMatchObject({ sessionCount: 1, callCount: 1 })
})

test.each(["observer.fixture", "observer:fixture"])("CLI activation and observer share campaign grammar: %s", (campaignID) => {
  const cli = resolve(import.meta.dir, "../../scripts/lca-skill-observation.ts")
  const activation = spawnSync(process.execPath, [cli, "activate", "--root", wt.worktree, "--campaign-id", campaignID], {
    env: { ...process.env, LCA_STATE_HOME: wt.stateHome }, encoding: "utf8",
  })
  expect(activation.status).toBe(0)
  const receipt = JSON.parse(activation.stdout)
  mkdirSync(join(wt.worktree, ".lca"), { recursive: true })
  writeFileSync(projectConfigPath(wt.worktree), JSON.stringify({
    skill_observation: { enabled: true, campaign_id: campaignID, owner_root: wt.worktree, owner_binding: receipt.ownerBinding },
  }))
  const deps = makeDeps(fakeClient(), wt.worktree, loadConfig(wt.worktree))
  observeSkillPart(deps, skill("punctuation-call"))
  expect(getSkillCampaignStatus(wt.worktree)).toMatchObject({ campaignID, sessionCount: 1, callCount: 1 })
  expect(listSkillObservations(wt.worktree).facts[0]).toMatchObject({ phase: "terminal", payload: { state: "error" } })
})

test("actual before/error stream deduplicates and preserves existing repeat refusal", async () => {
  activateSkillCampaign(wt.worktree, campaign)
  const deps = makeDeps(fakeClient(), wt.worktree, configuration)
  const before = createToolBeforeHook(deps)
  const event = createEventHook(deps)
  for (const callID of ["call-one", "call-two"]) {
    await before({ tool: "skill", sessionID: "session-one", callID }, { args: { name: "fixture-skill" } })
    const toolEvent = { event: { type: "message.part.updated", properties: { part: skill(callID) } } } as never
    await event(toolEvent)
    await event(toolEvent)
  }
  await expect(before({ tool: "skill", sessionID: "session-one", callID: "call-three" }, { args: { name: "fixture-skill" } })).rejects.toThrow("blocked repeated call")
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
  const deps = makeDeps(fakeClient(), wt.worktree, configuration)
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
  const deps = makeDeps(fakeClient(), wt.worktree, configuration)
  const part = {
    type: "tool", tool: "skill", sessionID: "session-one", messageID: "assistant-one", callID: "successful-call",
    state: { status: "pending", input: { name: "fixture-skill" } },
  }
  observeSkillPart(deps, part)
  await createToolBeforeHook(deps)({ tool: "skill", sessionID: part.sessionID, callID: part.callID }, { args: part.state.input })
  const start = Date.now()
  observeSkillPart(deps, { ...part, state: { ...part.state, status: "running", time: { start } } })
  const completed = {
    ...part,
    state: { ...part.state, status: "completed", output: "Synthetic returned fixture content",
      metadata: { name: "fixture-skill" }, time: { start, end: Date.now() } },
  }
  observeSkillPart(deps, completed)
  observeSkillPart(deps, completed)
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
  const deps = makeDeps(fakeClient(), wt.worktree, configuration)
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
  const deps = makeDeps(fakeClient(), wt.worktree, configuration)
  const part = skill("old-call", "completed")
  part.state.time = { start: activated.activatedAt! - 20, end: activated.activatedAt! - 10 }
  Object.defineProperty(part.state, "output", { get() { throw new Error("old output must remain unread") } })
  observeSkillPart(deps, part)
  const status = getSkillCampaignStatus(wt.worktree)
  expect(status.callCount).toBe(0)
  expect(status.sessionCount).toBe(0)
  expect(status.rejections.preactivation).toBe(1)
})

test("related non-skill tools keep exact metadata but never inspect content or spend skill quota", () => {
  activateSkillCampaign(wt.worktree, campaign)
  const deps = makeDeps(fakeClient(), wt.worktree, configuration)
  const at = Date.now()
  const part = {
    tool: "bash", sessionID: "session-one", callID: "shell-one", messageID: "assistant-one",
    state: { status: "completed", time: { start: at, end: at } },
  }
  for (const key of ["input", "output", "error"]) Object.defineProperty(part.state, key, {
    get() { throw new Error("PRIVATE_TOOL_CONTENT_MUST_REMAIN_UNREAD") },
  })
  observeRelatedToolPart(deps, part)
  observeRelatedToolPart(deps, part)
  const snapshot = listSkillObservations(wt.worktree)
  expect(snapshot.campaign).toMatchObject({ callCount: 0, sessionCount: 1 })
  expect(snapshot.facts).toHaveLength(1)
  expect(snapshot.facts[0]).toMatchObject({ kind: "tool_context", phase: "terminal", conflict: false })
  expect(snapshot.facts[0]!.payload).toMatchObject({ messageID: "assistant-one", tool: "bash", status: "completed", durationMs: 0 })
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_TOOL_CONTENT")
})

test("completed tool-call assistant messages do not leave pending keys or close the user turn early", () => {
  activateSkillCampaign(wt.worktree, campaign)
  const deps = makeDeps(fakeClient(), wt.worktree, configuration)
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
  const deps = makeDeps(fakeClient(), wt.worktree, configuration)
  for (const sessionID of ["compacted-session", "deleted-session", "untouched-session"]) {
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
  const deps = makeDeps(fakeClient(), wt.worktree, configuration)
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
  const deps = makeDeps(fakeClient(), wt.worktree, { ...configuration, skills: { allow: firstSixteen } })
  expect(observationConfigGeneration(deps)).toMatch(/^[a-f0-9]{64}$/)
  deps.config.skills = { allow: [...firstSixteen, "seventeenth-a"] }
  expect(observationConfigGeneration(deps)).toBeNull()
  deps.config.skills = { allow: [...firstSixteen, "seventeenth-b"] }
  expect(observationConfigGeneration(deps)).toBeNull()
  deps.config.skills = { allow: ["valid-skill", "../invalid"] }
  expect(observationConfigGeneration(deps)).toBeNull()
})
