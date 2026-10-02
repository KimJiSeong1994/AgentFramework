#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Database } from "bun:sqlite"
import { DEFAULT_CONFIG, projectConfigPath, type LcaConfig } from "../framework/src/config.ts"
import type { HookDeps } from "../framework/src/hooks/types.ts"
import {
  observeRelatedToolPart, observeSkillAttempt, observeSkillMessage, observeSkillPart, observeSkillTurn,
} from "../framework/src/telemetry/skill-observer.ts"
import {
  activateSkillCampaign, getSkillCampaignStatus, listSkillObservations, skillObservationBindingHash,
  skillObservationDatabasePath, SKILL_OBSERVATION_LIMITS, stopSkillCampaign,
} from "../framework/src/telemetry/skills.ts"

const CAMPAIGN_ID = "ac10-synthetic-bench"
const SESSION_ID = "bench-session"
const SKILL_NAME = "bench-skill"
const SKILL_BODY = "Use this synthetic fixture for a bounded local benchmark."
const EVENT_COUNT = 1_000
const RESOURCE_SAMPLE_EVERY = 25
const JOURNAL_SAMPLE_INTERVAL_MS = 2
const WORKER_TIMEOUT_MS = 30_000

type EventKind = "skill_before" | "skill_running" | "skill_completed" |
  "tool_pending" | "tool_running" | "tool_completed" | "assistant_closure"
const EXPECTED_COUNTS: Record<EventKind, number> = {
  skill_before: 99, skill_running: 99, skill_completed: 99,
  tool_pending: 234, tool_running: 234, tool_completed: 234, assistant_closure: 1,
}
type Event = { kind: EventKind; invoke: () => void }
type Stats = { count: number; p50_ms: number; p95_ms: number; max_ms: number }
type MemoryStats = {
  rss_delta_bytes: number
  rss_highwater_delta_bytes: number
  heap_used_delta_bytes: number
  heap_used_highwater_delta_bytes: number
  sample_interval_events: number
}
type DatabaseStats = { page_size_bytes: number; page_count: number; page_bytes: number; file_bytes: number }
type Scratch = { root: string; stateHome: string }
type Scenario = {
  enabled: boolean
  root: string
  databasePath: string
  deps: HookDeps
  binding: string | null
  cleanup: () => void
}
type ScenarioCheck = {
  available: boolean
  owner_quota_within_limits: boolean | null
  one_actor: boolean | null
  skill_call_count: number | null
  related_tool_count: number | null
  terminal_nonconflicted_calls: boolean | null
  pending_zero: boolean | null
  off_database_absent: boolean | null
  campaign_stopped: boolean | null
  database: DatabaseStats | null
}

const emptyKinds = (): Record<EventKind, number[]> => ({
  skill_before: [], skill_running: [], skill_completed: [],
  tool_pending: [], tool_running: [], tool_completed: [], assistant_closure: [],
})

function allocateScratch(): Scratch {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "lca-skill-bench-project-")))
  try {
    const stateHome = realpathSync.native(mkdtempSync(join(tmpdir(), "lca-skill-bench-state-")))
    return { root, stateHome }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function cleanScratch(scratch: Scratch): void {
  rmSync(scratch.root, { recursive: true, force: true })
  rmSync(scratch.stateHome, { recursive: true, force: true })
}

function createScenario(enabled: boolean, scratch: Scratch): Scenario {
  const previousXdg = process.env.XDG_STATE_HOME
  const previousLcaState = process.env.LCA_STATE_HOME
  process.env.XDG_STATE_HOME = scratch.stateHome
  delete process.env.LCA_STATE_HOME

  let activated = false
  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    try {
      if (activated) {
        try { stopSkillCampaign(scratch.root, CAMPAIGN_ID) } catch { /* Scratch cleanup is still required. */ }
      }
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previousXdg
      if (previousLcaState === undefined) delete process.env.LCA_STATE_HOME
      else process.env.LCA_STATE_HOME = previousLcaState
    }
  }

  try {
    const skillDir = join(scratch.root, ".opencode", "skills", SKILL_NAME)
    mkdirSync(skillDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${SKILL_NAME}\ndescription: Synthetic benchmark fixture.\n---\n\n${SKILL_BODY}\n`, { mode: 0o600 })

    const binding = enabled ? skillObservationBindingHash(scratch.root) : null
    const observation = enabled
      ? { enabled: true, campaign_id: CAMPAIGN_ID, owner_binding: binding! }
      : { enabled: false }
    const config: LcaConfig = structuredClone(DEFAULT_CONFIG)
    config.skill_observation = observation
    const deps: HookDeps = {
      client: {} as HookDeps["client"], directory: scratch.root, worktree: scratch.root, config, log: () => {},
    }
    if (enabled) {
      const status = activateSkillCampaign(scratch.root, CAMPAIGN_ID)
      activated = true
      if (!status.available || status.health !== "ok" || status.status !== "open") throw new Error()
    }
    mkdirSync(join(scratch.root, ".lca"), { recursive: true, mode: 0o700 })
    writeFileSync(projectConfigPath(scratch.root), JSON.stringify({ skill_observation: observation }), { mode: 0o600 })
    return {
      enabled, root: scratch.root,
      databasePath: skillObservationDatabasePath(scratch.root), deps, binding,
      cleanup,
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

function seedKnownTurns(deps: HookDeps): void {
  const now = Date.now()
  observeSkillTurn(deps, {
    sessionID: SESSION_ID, messageID: "user-initial", role: "user", phase: "terminal",
    closureReason: "completed", startedAt: now, finishedAt: now,
  })
  observeSkillTurn(deps, {
    sessionID: SESSION_ID, messageID: "assistant-initial", parentMessageID: "user-initial",
    role: "assistant", phase: "terminal", closureReason: "completed", startedAt: now, finishedAt: now,
  })
  observeSkillTurn(deps, {
    sessionID: SESSION_ID, messageID: "user-final", role: "user", phase: "pending", startedAt: now,
  })
}

function skillPart(callID: string, status: "running" | "completed", at: number, skillDir: string) {
  return {
    type: "tool", tool: "skill", sessionID: SESSION_ID, messageID: "assistant-tools", callID,
    state: status === "running"
      ? { status, input: { name: SKILL_NAME }, time: { start: at, end: at } }
      : {
          status, input: { name: SKILL_NAME }, output:
            `<skill_content name="${SKILL_NAME}">\n# Skill: ${SKILL_NAME}\n\n${SKILL_BODY}\n\n` +
            `Base directory for this skill: ${skillDir}\n` +
            "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.\n" +
            "Note: file list is sampled.\n\n<skill_files>\n\n</skill_files>\n</skill_content>",
          metadata: { name: SKILL_NAME, dir: skillDir }, time: { start: at, end: at },
        },
  }
}

function toolPart(callID: string, status: "pending" | "running" | "completed", at: number) {
  return {
    tool: "read", sessionID: SESSION_ID, messageID: "assistant-tools", callID,
    state: { status, time: { start: at, end: at } },
  }
}

function makeEvents(scenario: Scenario): Event[] {
  seedKnownTurns(scenario.deps)
  const at = Date.now()
  const skillDir = join(scenario.root, ".opencode", "skills", SKILL_NAME)
  const events: Event[] = []
  for (let index = 0; index < 99; index++) {
    const callID = `skill-${index}`
    const attempt = { tool: "skill", sessionID: SESSION_ID, callID }
    const args = { name: SKILL_NAME }
    const running = skillPart(callID, "running", at, skillDir)
    const completed = skillPart(callID, "completed", at, skillDir)
    events.push({ kind: "skill_before", invoke: () => observeSkillAttempt(scenario.deps, attempt, args) })
    events.push({ kind: "skill_running", invoke: () => observeSkillPart(scenario.deps, running) })
    events.push({ kind: "skill_completed", invoke: () => observeSkillPart(scenario.deps, completed) })
  }
  for (let index = 0; index < 234; index++) {
    const callID = `tool-${index}`
    for (const status of ["pending", "running", "completed"] as const) {
      const kind: EventKind = status === "completed" ? "tool_completed" : status === "running" ? "tool_running" : "tool_pending"
      const part = toolPart(callID, status, at)
      events.push({ kind, invoke: () => observeRelatedToolPart(scenario.deps, part) })
    }
  }
  const finalMessage = {
    sessionID: SESSION_ID, id: "assistant-final", parentID: "user-final", role: "assistant", agent: "main", finish: "stop",
    time: { created: at, completed: at },
  }
  events.push({
    kind: "assistant_closure",
    invoke: () => observeSkillMessage(scenario.deps, finalMessage),
  })
  if (events.length !== EVENT_COUNT) throw new Error()
  return events
}

function runCallbacks(events: Event[], timings?: Record<EventKind, number[]>, memory?: MemoryStats): void {
  const baseline = memory ? process.memoryUsage() : null
  let highRss = baseline?.rss ?? 0
  let highHeap = baseline?.heapUsed ?? 0
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!
    if (timings) {
      const start = performance.now()
      event.invoke()
      timings[event.kind]!.push(performance.now() - start)
    } else {
      event.invoke()
    }
    if (memory && (index + 1) % RESOURCE_SAMPLE_EVERY === 0) {
      const sample = process.memoryUsage()
      highRss = Math.max(highRss, sample.rss)
      highHeap = Math.max(highHeap, sample.heapUsed)
    }
  }
  if (memory && baseline) {
    const final = process.memoryUsage()
    highRss = Math.max(highRss, final.rss)
    highHeap = Math.max(highHeap, final.heapUsed)
    memory.rss_delta_bytes = final.rss - baseline.rss
    memory.rss_highwater_delta_bytes = highRss - baseline.rss
    memory.heap_used_delta_bytes = final.heapUsed - baseline.heapUsed
    memory.heap_used_highwater_delta_bytes = highHeap - baseline.heapUsed
  }
}

function distribution(values: number[]): Stats {
  if (values.length === 0) throw new Error()
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    max_ms: sorted[sorted.length - 1]!,
  }
}

function summaries(timings: Record<EventKind, number[]>): Record<EventKind | "overall", Stats> {
  const all: number[] = []
  const output = {} as Record<EventKind | "overall", Stats>
  for (const [kind, values] of Object.entries(timings) as [EventKind, number[]][]) {
    output[kind] = distribution(values)
    all.push(...values)
  }
  output.overall = distribution(all)
  return output
}

function delta(enabled: Stats, disabled: Stats): Omit<Stats, "count"> {
  return {
    p50_ms: enabled.p50_ms - disabled.p50_ms,
    p95_ms: enabled.p95_ms - disabled.p95_ms,
    max_ms: enabled.max_ms - disabled.max_ms,
  }
}

function databaseStats(path: string): DatabaseStats {
  const db = new Database(path, { readonly: true })
  try {
    const value = (pragma: string): number => {
      const row = db.query(pragma).get() as Record<string, unknown> | undefined
      const field = row ? Object.values(row)[0] : undefined
      if (typeof field !== "number" || !Number.isFinite(field)) throw new Error()
      return field
    }
    const pageSize = value("PRAGMA page_size")
    const pageCount = value("PRAGMA page_count")
    return { page_size_bytes: pageSize, page_count: pageCount, page_bytes: pageSize * pageCount, file_bytes: statSync(path).size }
  } finally {
    db.close()
  }
}

function inspectScenario(scenario: Scenario): ScenarioCheck {
  if (!scenario.enabled) {
    const absent = !existsSync(scenario.databasePath)
    if (!absent) throw new Error()
    return {
      available: false, owner_quota_within_limits: null, one_actor: null, skill_call_count: null, related_tool_count: null,
      terminal_nonconflicted_calls: null, pending_zero: null, off_database_absent: true,
      campaign_stopped: null, database: null,
    }
  }

  const status = getSkillCampaignStatus(scenario.root)
  const snapshot = listSkillObservations(scenario.root, { limit: 10_000 })
  const skillCalls = snapshot.facts.filter((fact) => fact.kind === "skill_call")
  const relatedTools = snapshot.facts.filter((fact) => fact.kind === "tool_context")
  const terminal = skillCalls.length === 99 && skillCalls.every((fact) =>
    fact.phase === "terminal" && !fact.conflict && fact.payload.state === "completed" &&
    fact.payload.returnedContent === "observed" && typeof fact.payload.returnedPayloadSha256 === "string" &&
    typeof fact.payload.observedFileSha256 === "string" && typeof fact.payload.returnedBodySha256 === "string") &&
    relatedTools.length === 234 && relatedTools.every((fact) =>
      fact.phase === "terminal" && !fact.conflict && "status" in fact.payload && fact.payload.status === "completed")
  const quota = status.sessionCount <= SKILL_OBSERVATION_LIMITS.sessions && status.callCount <= SKILL_OBSERVATION_LIMITS.calls
  const oneActor = status.sessionCount === 1 && status.callCount === 99 && status.ownerBinding === scenario.binding &&
    status.campaignID === CAMPAIGN_ID && status.status === "open"
  const pendingZero = status.pendingCount === 0 && snapshot.facts.every((fact) => fact.phase !== "pending")
  if (!status.available || status.health !== "ok" || snapshot.health !== "ok" || !snapshot.available ||
      !quota || !oneActor || !terminal || !pendingZero || snapshot.facts.length !== 337 ||
      snapshot.coverage.storedFacts !== 337 || snapshot.coverage.truncated) throw new Error()

  const stopped = stopSkillCampaign(scenario.root, CAMPAIGN_ID)
  const campaignStopped = stopped.available && stopped.health === "ok" && stopped.status === "closed" && stopped.pendingCount === 0
  if (!campaignStopped) throw new Error()
  return {
    available: status.available, owner_quota_within_limits: quota, one_actor: oneActor,
    skill_call_count: skillCalls.length, related_tool_count: relatedTools.length,
    terminal_nonconflicted_calls: terminal, pending_zero: pendingZero, off_database_absent: null,
    campaign_stopped: campaignStopped, database: databaseStats(scenario.databasePath),
  }
}

function runTiming(enabled: boolean): { summary: Record<EventKind | "overall", Stats>; check: ScenarioCheck } {
  const scratch = allocateScratch()
  let scenario: Scenario | undefined
  try {
    scenario = createScenario(enabled, scratch)
    const events = makeEvents(scenario)
    if (events.length !== EVENT_COUNT) throw new Error()
    const timings = emptyKinds()
    runCallbacks(events, timings)
    const summary = summaries(timings)
    const check = inspectScenario(scenario)
    scenario.cleanup()
    return { summary, check }
  } finally {
    if (scenario) scenario.cleanup()
    cleanScratch(scratch)
  }
}

function writeWorkerMessage(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function workerScratch(): Scratch {
  const root = process.env.LCA_SKILL_BENCH_ROOT
  const stateHome = process.env.LCA_SKILL_BENCH_STATE
  if (!root || !stateHome) throw new Error()
  const scratch = { root: realpathSync.native(root), stateHome: realpathSync.native(stateHome) }
  const base = realpathSync.native(tmpdir())
  if (dirname(scratch.root) !== base || !basename(scratch.root).startsWith("lca-skill-bench-project-") ||
      dirname(scratch.stateHome) !== base || !basename(scratch.stateHome).startsWith("lca-skill-bench-state-") ||
      readdirSync(scratch.root).length || readdirSync(scratch.stateHome).length) throw new Error()
  return scratch
}

async function resourceWorker(enabled: boolean): Promise<void> {
  let scenario: Scenario | undefined
  try {
    scenario = createScenario(enabled, workerScratch())
    const events = makeEvents(scenario)
    const journalPath = enabled ? `${scenario.databasePath}-journal` : null
    writeWorkerMessage({ event: "ready", journalPath })
    const memory: MemoryStats = {
      rss_delta_bytes: 0, rss_highwater_delta_bytes: 0,
      heap_used_delta_bytes: 0, heap_used_highwater_delta_bytes: 0,
      sample_interval_events: RESOURCE_SAMPLE_EVERY,
    }
    runCallbacks(events, undefined, memory)
    writeWorkerMessage({ event: "callbacks_done" })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const check = inspectScenario(scenario)
    scenario.cleanup()
    scenario = undefined
    writeWorkerMessage({ event: "result", memory, check })
  } catch {
    writeWorkerMessage({ event: "failure", code: "benchmark_failure" })
    process.exitCode = 1
  } finally {
    scenario?.cleanup()
  }
}

type ResourceWorkerResult = { memory: MemoryStats; check: ScenarioCheck }

function workerEnvironment(scratch: Scratch): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  env.XDG_STATE_HOME = scratch.stateHome
  env.LCA_SKILL_BENCH_ROOT = scratch.root
  env.LCA_SKILL_BENCH_STATE = scratch.stateHome
  return env
}

async function runResourceWorker(enabled: boolean): Promise<{ result: ResourceWorkerResult; journal: { peak_bytes: number; samples: number } }> {
  const scratch = allocateScratch()
  let worker: ReturnType<typeof spawn>
  try {
    worker = spawn(process.execPath, [fileURLToPath(import.meta.url), enabled ? "--resource-worker-enabled" : "--resource-worker-disabled"], {
      env: workerEnvironment(scratch), stdio: ["ignore", "pipe", "ignore"],
    })
  } catch (error) {
    cleanScratch(scratch)
    throw error
  }
  let buffer = ""
  let ready = false
  let callbacksDone = false
  let journalPath: string | null = null
  let peakBytes = 0
  let samples = 0
  let sampleTimer: ReturnType<typeof setInterval> | undefined
  let hardTimeout: ReturnType<typeof setTimeout> | undefined
  let killTimeout: ReturnType<typeof setTimeout> | undefined
  let result: ResourceWorkerResult | null = null
  let failure = false

  const done = new Promise<void>((resolve, reject) => {
    const output = worker.stdout
    if (!output) { reject(new Error()); return }
    output.setEncoding("utf8")
    output.on("data", (chunk: string) => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: Record<string, unknown>
        try { message = JSON.parse(line) as Record<string, unknown> } catch { failure = true; worker.kill("SIGTERM"); continue }
        if (message.event === "ready") {
          ready = true
          journalPath = typeof message.journalPath === "string" ? message.journalPath : null
          if ((enabled && !journalPath) || (!enabled && message.journalPath !== null)) failure = true
          if (enabled && journalPath) {
            const sample = () => {
              samples++
              try { peakBytes = Math.max(peakBytes, statSync(journalPath!).size) } catch { /* The DELETE journal is normally absent between transactions. */ }
            }
            sample()
            sampleTimer = setInterval(sample, JOURNAL_SAMPLE_INTERVAL_MS)
          }
        } else if (message.event === "callbacks_done") {
          callbacksDone = true
          if (sampleTimer) clearInterval(sampleTimer)
        } else if (message.event === "result" && message.memory && message.check) {
          result = { memory: message.memory as MemoryStats, check: message.check as ScenarioCheck }
        } else if (message.event === "failure") {
          failure = true
        }
      }
    })
    worker.on("error", () => { failure = true; reject(new Error()) })
    worker.on("close", (code) => {
      if (sampleTimer) clearInterval(sampleTimer)
      if (code !== 0 || failure || !ready || !callbacksDone || !result) reject(new Error())
      else resolve()
    })
    hardTimeout = setTimeout(() => {
      failure = true
      worker.kill("SIGTERM")
      killTimeout = setTimeout(() => worker.kill("SIGKILL"), 1_000)
    }, WORKER_TIMEOUT_MS)
  })

  try {
    await done
    return { result: result!, journal: { peak_bytes: peakBytes, samples } }
  } finally {
    if (sampleTimer) clearInterval(sampleTimer)
    if (hardTimeout) clearTimeout(hardTimeout)
    if (killTimeout) clearTimeout(killTimeout)
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM")
    cleanScratch(scratch)
  }
}

function diffMetrics(enabled: Record<EventKind | "overall", Stats>, disabled: Record<EventKind | "overall", Stats>) {
  const output = {} as Record<EventKind | "overall", Omit<Stats, "count">>
  for (const kind of [...Object.keys(emptyKinds()), "overall"] as (EventKind | "overall")[]) {
    output[kind] = delta(enabled[kind], disabled[kind])
  }
  return output
}

async function receipt() {
  const enabledTiming = runTiming(true)
  const disabledTiming = runTiming(false)
  const enabledResources = await runResourceWorker(true)
  const disabledResources = await runResourceWorker(false)
  const deltas = diffMetrics(enabledTiming.summary, disabledTiming.summary)
  const callbackCount = (summary: Record<EventKind | "overall", Stats>) =>
    (Object.keys(emptyKinds()) as EventKind[]).reduce((sum, kind) => sum + summary[kind].count, 0)
  const enabledCallbacks = callbackCount(enabledTiming.summary)
  const disabledCallbacks = callbackCount(disabledTiming.summary)
  const expectedKinds = Object.keys(EXPECTED_COUNTS) as EventKind[]
  if (enabledCallbacks !== EVENT_COUNT || disabledCallbacks !== EVENT_COUNT || expectedKinds.some((kind) =>
    enabledTiming.summary[kind].count !== EXPECTED_COUNTS[kind] || disabledTiming.summary[kind].count !== EXPECTED_COUNTS[kind])) throw new Error()
  const targetMet = deltas.overall.p95_ms <= 10
  return {
    schema: "ac10-skill-bench.v1",
    workload: {
      expected_callbacks: EVENT_COUNT,
      enabled_callbacks: enabledCallbacks,
      disabled_callbacks: disabledCallbacks,
      actor_count: 1,
      skill_calls: 99,
      related_tools: 234,
      assistant_closures: 1,
      setup_turn_facts_outside_timed_window: 3,
    },
    per_callback_ms: {
      enabled: enabledTiming.summary,
      disabled: disabledTiming.summary,
      delta: deltas,
      p95_additional_target_ms: 10,
      measured_p95_additional_target_met: targetMet,
    },
    persisted: {
      enabled: enabledTiming.check,
      disabled: disabledTiming.check,
      resource_pass_enabled: enabledResources.result.check,
      resource_pass_disabled: disabledResources.result.check,
    },
    resources: {
      enabled: enabledResources.result.memory,
      disabled: disabledResources.result.memory,
      rollback_journal_peak_sampled_lower_bound_bytes: enabledResources.journal.peak_bytes,
      rollback_journal_samples: enabledResources.journal.samples,
      rollback_journal_sample_interval_ms: JOURNAL_SAMPLE_INTERVAL_MS,
    },
    limitations: [
      "local_cpu_sqlite_only", "synthetic_events", "timing_and_resource_passes_separate", "not_universal_realtime", "rss_heap_highwater_is_sampled",
      "rollback_journal_peak_is_a_sampled_lower_bound", "host_filesystem_and_process_state_affect_results",
    ],
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--resource-worker-enabled") return resourceWorker(true)
  if (args.length === 1 && args[0] === "--resource-worker-disabled") return resourceWorker(false)
  if (args.length !== 0) throw new Error()
  const result = await receipt()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

try {
  await main()
} catch {
  process.stderr.write('{"code":"benchmark_failure"}\n')
  process.exitCode = 1
}
