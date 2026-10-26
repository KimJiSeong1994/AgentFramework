import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as nodeFs from "node:fs"
import { mkdirSync, writeFileSync, lstatSync, realpathSync, readFileSync, existsSync, readdirSync, renameSync, symlinkSync } from "node:fs"
import { Database } from "bun:sqlite"
import { dirname, join, resolve } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import * as readline from "node:readline/promises"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { Terminal } from "../src/hosts/interactive-session.ts"
import type { ExecutionHost, ExecutionRequest, ExecutionReconciliation } from "../src/hosts/types.ts"
import type { CliTransportOptions, CliTransportResult } from "../src/hosts/cli-transport.ts"
import { attachAdmission, detachAdmission } from "../src/sessions/admission.ts"
import { digestDirectory } from "../src/sessions/digest.ts"
import type { SessionStore } from "../src/sessions/store.ts"
import { executionRunDirectory } from "../src/state/store.ts"
import {
  NATIVE_FIXTURE_PACK_SCHEMA, NATIVE_PROTECTED_CHANGES, NATIVE_WIKI_CONTRACT,
  NATIVE_WIKI_SPLIT_MINIMUMS, NATIVE_WIKI_SPLITS, NATIVE_WIKI_STRATA, type NativeWikiFixture, type NativeWikiFixturePack,
} from "../src/skillopt/dataset.ts"
import { validateNativeFixtureGold } from "../src/skillopt/evaluation.ts"
import { COMPILE_ANCHOR, PILOT_SKILL, canonicalJson, sha256 } from "../src/skillopt/pilot.ts"
import { tempWorktree, type TempWorktree } from "./guards-helpers.ts"
import { automaticCandidateInstruction, automaticFixtureResponse, makeAutomaticPack } from "./skillopt-foreground-fixtures.ts"

const transportModule = fileURLToPath(new URL("../src/hosts/cli-transport.ts", import.meta.url))
const originalTransportModule = { ...await import("../src/hosts/cli-transport.ts") }
let inspectCalls = 0
let inferenceRuns = 0
type ScriptedTransportCall = Pick<CliTransportOptions, "engine" | "model" | "prompt">
let scriptedTransportResult: CliTransportResult | ((call: ScriptedTransportCall) => CliTransportResult) | undefined
let scriptedIdentityBarrier: {
  expected: number; arrivals: number; arrived: Promise<void>; releaseGate: Promise<void>;
  notifyArrived(): void; release(): void
} | undefined
const transportCalls: Array<Pick<ScriptedTransportCall, "engine" | "model">> = []
beforeAll(() => mock.module(transportModule, () => ({
  ...originalTransportModule,
  createCliTransport(options: { engine: "codex" | "claude" | "local"; model: string; prompt?: string }) {
    let completedScriptedRun = false
    return {
      async inspectIdentity() {
        inspectCalls += 1
        const barrier = scriptedIdentityBarrier
        if (barrier) {
          barrier.arrivals += 1
          if (barrier.arrivals === barrier.expected) barrier.notifyArrived()
          await barrier.releaseGate
        }
        if (options.engine === "local") return undefined
        return Object.freeze({ engine: options.engine, requestedModel: options.model,
          runtimeIdentity: Object.freeze({ version: `${options.engine} synthetic metadata`, executableSha256: sha256(`${options.engine}-executable`) }),
          profileIdentity: Object.freeze({ id: `${options.engine}-synthetic-profile`, sha256: sha256(`${options.engine}-${options.model}-profile`) }) })
      },
      async run() {
        completedScriptedRun = false
        inferenceRuns += 1
        if (!scriptedTransportResult) throw new Error("inference run forbidden in foreground tests")
        const call = Object.freeze({ engine: options.engine, model: options.model, prompt: options.prompt ?? "" })
        transportCalls.push(Object.freeze({ engine: call.engine, model: call.model }))
        const result = typeof scriptedTransportResult === "function" ? scriptedTransportResult(call) : scriptedTransportResult
        completedScriptedRun = result.status === "completed" && result.quiescent === true
        return result
      },
      async requestCancel() { return { requested: false, acknowledged: false, terminal: false, quiescent: false } },
      async reconcile(): Promise<ExecutionReconciliation> {
        return completedScriptedRun
          ? { outcome: "terminal", quiescent: true, evidence: "scripted foreground fixture completed its model response" }
          : { outcome: "unknown", quiescent: false, evidence: "synthetic metadata-only transport" }
      },
    }
  },
})))
afterAll(() => mock.module(transportModule, () => originalTransportModule))

const {
  createNativeSkillOptForeground, consumeNativeSkillOptForegroundRunResult, foregroundArtifactPath, foregroundFixtureReadiness,
  parseSkillOptForegroundInput, readSkillOptForegroundArtifact, SKILLOPT_FOREGROUND_INPUT_SCHEMA,
} = await import("../src/skillopt/foreground.ts")

const supportedNative = process.platform === "darwin" || process.platform === "linux"
const automaticCampaignDeadlineMs = 50 * 60 * 1000
const automaticCampaignOuterDeadlineMs = 55 * 60 * 1000
const cleanupPtyHelper = fileURLToPath(new URL("./skillopt-cleanup-pty.py", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))
function configuredWorkerRuntime(): Readonly<{ executablePath: string; nativeRuntimeProofPath: string }> | undefined {
  const executablePath = process.env.SKILLOPT_PYTHON
  if (!executablePath || !executablePath.startsWith("/")) return undefined
  try {
    if (resolve(executablePath) !== executablePath || realpathSync.native(executablePath) !== executablePath) return undefined
    const runtimeRoot = resolve(dirname(dirname(executablePath)))
    const nativeRuntimeProofPath = resolve(dirname(runtimeRoot), "native-runtime-proof.json")
    if (realpathSync.native(nativeRuntimeProofPath) !== nativeRuntimeProofPath) return undefined
    const executable = lstatSync(executablePath)
    const proof = lstatSync(nativeRuntimeProofPath)
    if (!executable.isFile() || executable.isSymbolicLink() || !proof.isFile() || proof.isSymbolicLink()) return undefined
    return Object.freeze({ executablePath, nativeRuntimeProofPath })
  } catch { return undefined }
}
const workerRuntimeSelection = configuredWorkerRuntime()
const baseline = Buffer.from("# llm-wiki\n\nSynthetic protected foreground baseline.\n", "utf8")
const models = Object.freeze({
  generator: Object.freeze({ engine: "codex" as const, requestedModel: "gpt-5-codex" }),
  target: Object.freeze({ engine: "claude" as const, requestedModel: "claude-target-test" }),
  reviewer: Object.freeze({ engine: "claude" as const, requestedModel: "claude-review-test" }),
})
const fixtures: Array<{ worktree: TempWorktree; owner?: SessionStore; service?: ReturnType<typeof createNativeSkillOptForeground>; runtime?: ReturnType<typeof createExecutionRuntime> }> = []

function makeFixture(split: (typeof NATIVE_WIKI_SPLITS)[number], index: number, stratum: (typeof NATIVE_WIKI_STRATA)[number]) {
  const id = `${split}-${index}`
  const sourceId = `source-${id}`
  const slotId = `slot-${id}`
  const leftId = `fact-${id}-left`
  const rightId = `fact-${id}-right`
  const leftStatement = `Supported foreground fact A for ${id}.`
  const rightStatement = `Supported foreground fact B for ${id}.`
  const sourceContent = `${leftStatement}\n${rightStatement}\n`
  const sourceHash = sha256(sourceContent)
  const existingContent = stratum === "dedup-resume" || stratum === "ownership-injection" ? `Existing approved bytes for ${id}.\n` : ""
  return {
    id, familyId: `family-${id}`, lineage: [`lineage-${id}`], split, stratum, authorship: "agent-authored" as const,
    sources: [{ id: sourceId, provenance: "raw" as const, content: sourceContent, sha256: sourceHash }],
    task: `Prepare a bounded wiki update for [[slot:${slotId}]] using only its cited evidence.`,
    outputSlots: [{ id: slotId, kind: "page" as const, existingContent }],
    assertions: {
      facts: [
        { id: leftId, slotId, statement: leftStatement, sourceIds: [sourceId] },
        { id: rightId, slotId, statement: rightStatement, sourceIds: [sourceId] },
      ],
      citations: [{ factId: leftId, sourceId }, { factId: rightId, sourceId }],
      contradictions: stratum === "correction-conflict" ? [{ leftFactId: leftId, rightFactId: rightId, expected: "mark-unknown" as const }] : [],
      deduplication: stratum === "dedup-resume" ? [{ slotId, expected: "reuse-existing" as const }] : [],
      ownership: stratum === "ownership-injection" ? [{ slotId, expected: "preserve-existing" as const }] : [],
    },
    forbiddenChanges: [...NATIVE_PROTECTED_CHANGES],
  }
}

function makePack(incomplete = false) {
  const packFixtures: ReturnType<typeof makeFixture>[] = []
  if (!incomplete) {
    for (const split of NATIVE_WIKI_SPLITS) {
      for (let index = 0; index < NATIVE_WIKI_SPLIT_MINIMUMS[split]; index += 1) {
        packFixtures.push(makeFixture(split, index, NATIVE_WIKI_STRATA[index % NATIVE_WIKI_STRATA.length]!))
      }
    }
  }
  return { schema: NATIVE_FIXTURE_PACK_SCHEMA, contract: NATIVE_WIKI_CONTRACT, fixtures: packFixtures }
}

function makeInput(root: string, fixturePack: NativeWikiFixturePack = makePack()) {
  const source = Buffer.from("Synthetic selected private source for foreground tests.\n", "utf8")
  const sourcePath = `knowledge/raw/documents/${sha256(source)}.md`
  const absoluteSource = join(root, sourcePath)
  mkdirSync(dirname(absoluteSource), { recursive: true, mode: 0o700 })
  writeFileSync(absoluteSource, source, { mode: 0o600 })
  return {
    schema: SKILLOPT_FOREGROUND_INPUT_SCHEMA,
    models,
    selections: [{ path: sourcePath }],
    fixturePack,
  }
}

function addAutomaticDigests(root: string, counts: { fresh?: number; old?: number; incomplete?: number }): void {
  const directory = digestDirectory(root)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let index = 0
  const write = (fields: { endedAt: number; complete?: boolean; outcome?: string; files?: string[] }) => {
    const sessionID = `automatic_${index++}_${randomUUID().replaceAll("-", "")}`
    writeFileSync(join(directory, `${sessionID}.json`), JSON.stringify({
      schemaVersion: 1, kind: "session-digest", sessionID, engine: "codex", model: models.generator.requestedModel,
      startedAt: fields.endedAt - 1000, endedAt: fields.endedAt, turns: 1, tools: {}, decisions: {},
      files: fields.files ?? ["knowledge/raw/synthetic-private.md"], commands: [], workflows: [],
      outcome: fields.outcome ?? "completed", complete: fields.complete ?? true,
    }), { flag: "wx", mode: 0o600 })
  }
  for (let i = 0; i < (counts.old ?? 0); i += 1) write({ endedAt: Date.now() - 60_000 - i })
  for (let i = 0; i < (counts.incomplete ?? 0); i += 1) write({ endedAt: Date.now() + 30_000 + i, complete: false })
  for (let i = 0; i < (counts.fresh ?? 0); i += 1) write({ endedAt: Date.now() + 60_000 + i })
}

function createIdentityBarrier(expected: number) {
  let notifyArrived!: () => void
  let release!: () => void
  const arrived = new Promise<void>(resolve => { notifyArrived = resolve })
  const releaseGate = new Promise<void>(resolve => { release = resolve })
  return { expected, arrivals: 0, arrived, releaseGate, notifyArrived, release }
}

function runtimeFor(root: string) {
  const host: ExecutionHost = {
    identity: { engine: "codex", profile: "legacy-unowned" },
    async preflight() { return { compatible: true, controls: {}, problems: [] } },
    async prepare(_request: ExecutionRequest) { throw new Error("foreground tests must not invoke the generic host") },
    async reconcile(): Promise<ExecutionReconciliation> { return { outcome: "unknown", quiescent: false, evidence: "no model execution was created" } },
  }
  return createExecutionRuntime({ directory: root, worktree: root, config: structuredClone(DEFAULT_CONFIG), log() {} }, () => host, {
    planningOnlyMain: true,
  })
}

function attachFixtureOwner(runtime: ReturnType<typeof createExecutionRuntime>, metadata?: { engine: "codex" | "claude"; model: string }) {
  const owner = attachAdmission(runtime, `session_${randomUUID().replaceAll("-", "")}`, {
    engine: metadata?.engine ?? models.generator.engine,
    model: metadata?.model ?? models.generator.requestedModel,
  })
  return owner
}

async function releaseFixture(fixture: (typeof fixtures)[number]): Promise<void> {
  fixture.service?.dispose()
  if (fixture.owner && fixture.runtime && !fixture.owner.isReleased) {
    await detachAdmission(fixture.runtime, fixture.owner.sessionID, fixture.owner.epoch, "foreground_test_complete")
  }
  fixture.worktree.cleanup()
}

async function withApprovalFromPrompt<T>(action: () => Promise<T>, beforeApproval?: () => void): Promise<T> {
  const input = new PassThrough()
  const output = new PassThrough()
  const originalCreate = readline.createInterface
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")
  if (process.stdin.isTTY !== true) Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
  if (process.stderr.isTTY !== true) Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true })
  const intercepted = spyOn(readline, "createInterface").mockImplementation(() => originalCreate({ input, output, terminal: false }))
  let prompt = ""
  let responded = false
  output.on("data", (chunk: Buffer) => {
    prompt += chunk.toString("utf8")
    const match = /APPROVE ([A-Za-z0-9_-]+) ([a-f0-9]{64})/u.exec(prompt)
    if (match && !responded) {
      responded = true
      queueMicrotask(() => {
        beforeApproval?.()
        input.write(`APPROVE ${match[1]} ${match[2]}\n`)
      })
    }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const pending = action()
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("scripted terminal prompt did not complete")), 1500)
    })])
  } finally {
    if (timer) clearTimeout(timer)
    intercepted.mockRestore()
    input.destroy()
    output.destroy()
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY)
    else Reflect.deleteProperty(process.stdin, "isTTY")
    if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY)
    else Reflect.deleteProperty(process.stderr, "isTTY")
  }
}

async function abortAtPrompt(action: (signal: AbortSignal) => Promise<unknown>): Promise<never> {
  const input = new PassThrough()
  const output = new PassThrough()
  const originalCreate = readline.createInterface
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")
  if (process.stdin.isTTY !== true) Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
  if (process.stderr.isTTY !== true) Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true })
  const intercepted = spyOn(readline, "createInterface").mockImplementation(() => originalCreate({ input, output, terminal: false }))
  let resolvePrompt!: () => void
  const promptWritten = new Promise<void>((resolve) => { resolvePrompt = resolve })
  output.on("data", (chunk: Buffer) => {
    if (chunk.toString("utf8").includes("Type 'APPROVE ")) resolvePrompt()
  })
  const abortController = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const pending = action(abortController.signal)
    await Promise.race([promptWritten, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("scripted terminal prompt did not appear")), 1500)
    })])
    abortController.abort()
    await pending
    throw new Error("aborted terminal decision unexpectedly resolved")
  } finally {
    if (timer) clearTimeout(timer)
    intercepted.mockRestore()
    input.destroy()
    output.destroy()
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY)
    else Reflect.deleteProperty(process.stdin, "isTTY")
    if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY)
    else Reflect.deleteProperty(process.stderr, "isTTY")
  }
}

afterEach(async () => {
  inspectCalls = 0
  inferenceRuns = 0
  scriptedTransportResult = undefined
  scriptedIdentityBarrier = undefined
  transportCalls.splice(0)
  for (const fixture of fixtures.splice(0).reverse()) await releaseFixture(fixture)
})

test("the exact input contract rejects caller authority and reports insufficient fixture data before metadata", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root, makePack(true))
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture = { worktree, runtime, owner, service }
  fixtures.push(fixture)
  expect(() => parseSkillOptForegroundInput({ ...input, consent: true })).toThrow("input_invalid")
  expect(foregroundFixtureReadiness(input)).toMatchObject({ state: "DATA_REQUIRED", reasonCode: "fixture_pack_data_required" })
  await expect(service.prepare(input)).resolves.toMatchObject({ state: "DATA_REQUIRED", reasonCode: "fixture_pack_data_required" })
  expect(inspectCalls).toBe(0)
  expect(inferenceRuns).toBe(0)
  expect(runtime.runs.status().executions).toHaveLength(0)
})

test("an owner whose model metadata disagrees with the foreground generator is refused before model metadata", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const originalInput = makeInput(root, makePack(true))
  const input = { ...originalInput, models: { ...originalInput.models,
    generator: { ...originalInput.models.generator, requestedModel: "different-generator-model" } } }
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner, service }
  fixtures.push(fixture)

  await expect(service.prepare(input)).rejects.toThrow("owner_model_mismatch")
  expect(inspectCalls).toBe(0)
  expect(inferenceRuns).toBe(0)
  expect(owner.metadata).toMatchObject({ engine: originalInput.models.generator.engine,
    model: originalInput.models.generator.requestedModel })
  expect(owner.isReleased).toBe(false)
  owner.assertOwner()
  expect(runtime.runs.status().executions).toHaveLength(0)
})

const nativeTest = supportedNative ? test : test.skip

nativeTest("prepare stores a private, hash-bound artifact using actual identities and performs zero inference runs", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner, service }
  fixtures.push(fixture)

  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string" || typeof prepared.bindingSha256 !== "string") {
    throw new Error("synthetic foreground run was not prepared")
  }
  expect(prepared).toMatchObject({ state: "PREPARED", targetRequests: 432, canaryReserve: 16, targetRequestCap: 512,
    optimizationSucceeded: false, dispatchStarted: false, postApplyHandoffAuthorized: false })
  expect(inspectCalls).toBe(3)
  expect(inferenceRuns).toBe(0)
  expect(runtime.runs.status().executions).toHaveLength(0)
  const runId = prepared.runId
  const artifactPath = foregroundArtifactPath(root, runId)
  expect(readSkillOptForegroundArtifact(root, runId).bindingSha256).toBe(prepared.bindingSha256)
  expect(lstatSync(dirname(artifactPath)).mode & 0o777).toBe(0o700)
  expect(lstatSync(artifactPath).mode & 0o777).toBe(0o600)
  expect(artifactPath.startsWith(join(executionRunDirectory(root), "skillopt-native-foreground"))).toBe(true)
  const ledger = join(dirname(executionRunDirectory(root)), "skillopt", "automation", "ledger.sqlite")
  const database = new Database(ledger, { readonly: true, readwrite: false, create: false })
  try {
    expect(database.query("SELECT state,revision FROM runs WHERE run_id=?").get(runId)).toEqual({ state: "PREPARED", revision: 2 })
    expect(database.query("SELECT artifact_bytes FROM usage WHERE run_id=?").get(runId))
      .toEqual({ artifact_bytes: readFileSync(artifactPath).byteLength })
    expect(database.query("SELECT target_requests,optimizer_requests,reviewer_requests FROM usage WHERE run_id=?").get(runId))
      .toEqual({ target_requests: 0, optimizer_requests: 0, reviewer_requests: 0 })
  } finally { database.close() }
})

nativeTest("reentry uses a real terminal receipt, keeps the same run, and unstarted cancellation preserves quota", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const firstOwner = attachFixtureOwner(runtime)
  const firstService = createNativeSkillOptForeground(runtime, firstOwner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner: firstOwner, service: firstService }
  fixtures.push(fixture)
  const prepared = await firstService.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string") throw new Error("synthetic foreground run was not prepared")
  const runId = prepared.runId
  firstService.dispose()
  fixture.service = undefined
  expect(await detachAdmission(runtime, firstOwner.sessionID, firstOwner.epoch, "foreground_reentry_test")).toBe(true)

  const secondOwner = attachFixtureOwner(runtime)
  fixture.owner = secondOwner
  const secondService = createNativeSkillOptForeground(runtime, secondOwner)
  fixture.service = secondService
  const before = secondService.status()
  const consented = await withApprovalFromPrompt(() => secondService.consent(runId, input, prepared.bindingSha256 as string))
  expect(consented).toMatchObject({ operation: "consent", state: "CONSENTED", runId, optimizationSucceeded: false, dispatchStarted: false })
  expect(secondService.status().runId).toBe(runId)
  expect(secondService.status().requestCounts).toEqual(before.requestCounts)
  expect(inferenceRuns).toBe(0)
  secondService.dispose()
  fixture.service = undefined
  expect(await detachAdmission(runtime, secondOwner.sessionID, secondOwner.epoch, "foreground_second_reentry")).toBe(true)

  const thirdOwner = attachFixtureOwner(runtime)
  fixture.owner = thirdOwner
  const thirdService = createNativeSkillOptForeground(runtime, thirdOwner)
  fixture.service = thirdService
  const cancelled = await withApprovalFromPrompt(() => thirdService.cancel(runId, input, prepared.bindingSha256 as string))
  expect(cancelled).toMatchObject({ operation: "cancel", state: "CANCELLED", runId, pendingDispatch: false })
  expect(thirdService.status().requestCounts).toEqual(before.requestCounts)
  expect(thirdService.status().dailyCooldownRemainingMilliseconds).toBe(0)
  expect(inferenceRuns).toBe(0)
})

nativeTest("reentry refuses current source drift instead of trusting the private input artifact", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const firstOwner = attachFixtureOwner(runtime)
  const firstService = createNativeSkillOptForeground(runtime, firstOwner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner: firstOwner, service: firstService }
  fixtures.push(fixture)
  const prepared = await firstService.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string") throw new Error("synthetic foreground run was not prepared")
  const runId = prepared.runId
  firstService.dispose()
  fixture.service = undefined
  expect(await detachAdmission(runtime, firstOwner.sessionID, firstOwner.epoch, "foreground_source_drift_test")).toBe(true)
  writeFileSync(join(root, input.selections![0]!.path), "Changed source bytes cannot inherit old binding.\n", { mode: 0o600 })

  const owner = attachFixtureOwner(runtime)
  fixture.owner = owner
  const service = createNativeSkillOptForeground(runtime, owner)
  fixture.service = service
  await expect(service.consent(runId, readSkillOptForegroundArtifact(root, runId).input, prepared.bindingSha256 as string))
    .rejects.toThrow("source_digest_mismatch")
  expect(service.status()).toMatchObject({ state: "PREPARED", runId, pendingDispatch: false })
  expect(service.status().requestCounts.charged.target).toBe(0)
  expect(inferenceRuns).toBe(0)
})

nativeTest("aborting the real terminal decision preserves the prepared row, counters, and owner", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const firstOwner = attachFixtureOwner(runtime)
  const firstService = createNativeSkillOptForeground(runtime, firstOwner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner: firstOwner, service: firstService }
  fixtures.push(fixture)
  const prepared = await firstService.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string" || typeof prepared.bindingSha256 !== "string") {
    throw new Error("synthetic foreground run was not prepared")
  }
  const runId = prepared.runId
  const bindingSha256 = prepared.bindingSha256
  firstService.dispose()
  fixture.service = undefined
  expect(await detachAdmission(runtime, firstOwner.sessionID, firstOwner.epoch, "foreground_abort_test")).toBe(true)

  const owner = attachFixtureOwner(runtime)
  fixture.owner = owner
  const service = createNativeSkillOptForeground(runtime, owner)
  fixture.service = service
  const before = service.status()
  await expect(abortAtPrompt((signal) => service.consent(runId, input, bindingSha256, signal)))
    .rejects.toThrow("operator_decision_aborted")
  const after = service.status()
  expect(after).toMatchObject({ state: "PREPARED", runId, revision: before.revision, pendingDispatch: false })
  expect(after.requestCounts).toEqual(before.requestCounts)
  expect(after.remaining).toEqual(before.remaining)
  expect(owner.isReleased).toBe(false)
  owner.assertOwner()
  expect(runtime.runs.status().claim).toBeUndefined()
  expect(runtime.runs.status().executions).toHaveLength(0)
  expect(inferenceRuns).toBe(0)

  const ledger = join(dirname(executionRunDirectory(root)), "skillopt", "automation", "ledger.sqlite")
  const database = new Database(ledger, { readonly: true, readwrite: false, create: false })
  try {
    expect(database.query("SELECT state,revision FROM runs WHERE run_id=?").get(runId))
      .toEqual({ state: "PREPARED", revision: before.revision })
    expect(database.query("SELECT count(*) AS count FROM consents WHERE run_id=?").get(runId)).toEqual({ count: 0 })
    expect(database.query("SELECT target_requests,optimizer_requests,reviewer_requests FROM usage WHERE run_id=?").get(runId))
      .toEqual({ target_requests: 0, optimizer_requests: 0, reviewer_requests: 0 })
  } finally { database.close() }
})

nativeTest("cancel preserves candidate-approval hold, owner binding, quota, and usage", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner, service }
  fixtures.push(fixture)
  expect(service.hasAutomaticArm()).toBe(false)
  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string") throw new Error("synthetic foreground run was not prepared")
  const runId = prepared.runId
  const ledger = join(dirname(executionRunDirectory(root)), "skillopt", "automation", "ledger.sqlite")
  const database = new Database(ledger)
  try {
    const runOwner = database.query("SELECT owner_session_hash,owner_epoch_hash FROM runs WHERE run_id=?").get(runId) as
      { owner_session_hash: string; owner_epoch_hash: string } | undefined
    if (!runOwner) throw new Error("candidate approval fixture run is missing")
    database.query("UPDATE runs SET state='AWAITING_CANDIDATE_APPROVAL',revision=revision+1 WHERE run_id=?").run(runId)
    database.query(`UPDATE quota SET active_run_id=?,active_owner_session_hash=?,active_owner_epoch_hash=? WHERE singleton=1`)
      .run(runId, runOwner.owner_session_hash, runOwner.owner_epoch_hash)
  } finally { database.close() }
  const before = new Database(ledger, { readonly: true, readwrite: false, create: false })
  const beforeRun = before.query("SELECT * FROM runs WHERE run_id=?").get(runId)
  const beforeQuota = before.query("SELECT * FROM quota WHERE singleton=1").get()
  const beforeUsage = before.query("SELECT * FROM usage WHERE run_id=?").get(runId)
  before.close()

  const result = await service.cancel(runId, undefined)
  expect(result).toMatchObject({ operation: "cancel", state: "AWAITING_CANDIDATE_APPROVAL", cancelled: false })
  expect(owner.isReleased).toBe(false)
  owner.assertOwner()
  expect(runtime.runs.status().claim).toBeUndefined()
  const after = new Database(ledger, { readonly: true, readwrite: false, create: false })
  try {
    expect(after.query("SELECT * FROM runs WHERE run_id=?").get(runId)).toEqual(beforeRun)
    expect(after.query("SELECT * FROM quota WHERE singleton=1").get()).toEqual(beforeQuota)
    expect(after.query("SELECT * FROM usage WHERE run_id=?").get(runId)).toEqual(beforeUsage)
  } finally { after.close() }
})

nativeTest("current owner cancels an unstarted run after source drift without input or another metadata probe", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner, service }
  fixtures.push(fixture)
  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string") throw new Error("synthetic foreground run was not prepared")
  const runId = prepared.runId
  const metadataCalls = inspectCalls
  writeFileSync(join(root, input.selections![0]!.path), "Changed after prepare; stop must not revalidate it.\n", { mode: 0o600 })

  const cancelled = await service.cancel(runId, undefined)
  expect(cancelled).toMatchObject({ operation: "cancel", state: "CANCELLED", runId, pendingDispatch: false })
  expect(inspectCalls).toBe(metadataCalls)
  expect(inferenceRuns).toBe(0)
  expect(owner.isReleased).toBe(false)
  expect(owner.assertOwner()).toBeUndefined()
  expect(runtime.runs.status().claim).toBeUndefined()
  expect(runtime.runs.status().executions).toHaveLength(0)
})

nativeTest("current owner disarms an armed run after source drift without new approval or metadata", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner, service }
  fixtures.push(fixture)
  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string" || typeof prepared.bindingSha256 !== "string") {
    throw new Error("synthetic foreground run was not prepared")
  }
  const runId = prepared.runId
  const bindingSha256 = prepared.bindingSha256
  expect(service.hasAutomaticArm()).toBe(false)
  const armed = await withApprovalFromPrompt(() => service.arm(runId, input, bindingSha256))
  expect(armed).toMatchObject({ operation: "arm", state: "ARMED", runId })
  expect(service.hasAutomaticArm()).toBe(true)
  const metadataCalls = inspectCalls
  writeFileSync(join(root, input.selections![0]!.path), "Changed after arm; disarm must not revalidate it.\n", { mode: 0o600 })

  const disarmed = await service.disarm(runId, undefined)
  expect(disarmed).toMatchObject({ operation: "disarm", state: "CANCELLED", runId, pendingDispatch: false })
  expect(service.hasAutomaticArm()).toBe(false)
  expect(inspectCalls).toBe(metadataCalls)
  expect(inferenceRuns).toBe(0)
  expect(owner.isReleased).toBe(false)
  expect(owner.assertOwner()).toBeUndefined()
  expect(runtime.runs.status().claim).toBeUndefined()
  expect(runtime.runs.status().executions).toHaveLength(0)
})

nativeTest("automatic readiness is read-only, counts only fresh eligible digests, and reuses the live arm without consent", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner, service }
  fixtures.push(fixture)
  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string" || typeof prepared.bindingSha256 !== "string") {
    throw new Error("automatic readiness fixture was not prepared")
  }
  const runId = prepared.runId
  const armResult = await withApprovalFromPrompt(() => service.arm(runId, input, prepared.bindingSha256 as string))
  expect(armResult).toMatchObject({ operation: "arm", state: "ARMED", runId })
  expect(service.hasAutomaticArm()).toBe(true)
  expect(armResult.message).toContain("자동 실행")
  expect(armResult.message).not.toContain("연결하지 않았습니다")
  const foreignOwner = attachFixtureOwner(runtime)
  const foreignService = createNativeSkillOptForeground(runtime, foreignOwner)
  try {
    expect(foreignService.hasAutomaticArm()).toBe(false)
    expect(await foreignService.pollAutomatic()).toBeUndefined()
  }
  finally {
    foreignService.dispose()
    if (!foreignOwner.isReleased) await detachAdmission(runtime, foreignOwner.sessionID, foreignOwner.epoch, "automatic_foreign_owner_test_complete")
  }

  addAutomaticDigests(root, { old: 1, incomplete: 1, fresh: 4 })
  const before = service.status()
  const blocked = await service.pollAutomatic()
  expect(blocked).toMatchObject({ operation: "automatic", state: "ARMED", readiness: "BLOCKED",
    reasonCode: "digest-threshold", newDigestCount: 4, requiredNewDigests: 5,
    modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false })
  expect(JSON.stringify(blocked)).not.toContain(input.selections![0]!.path)
  expect(service.hasAutomaticArm()).toBe(true)
  expect(service.status()).toMatchObject({ state: "ARMED", runId,
    requestCounts: before.requestCounts, remaining: before.remaining,
    dailyCooldownRemainingMilliseconds: before.dailyCooldownRemainingMilliseconds })
  expect(inferenceRuns).toBe(0)

  addAutomaticDigests(root, { fresh: 1 })
  const prompt = spyOn(readline, "createInterface")
  try {
    const noRuntime = await service.pollAutomatic()
    expect(noRuntime).toMatchObject({ operation: "run", state: "DATA_REQUIRED", reasonCode: "trainer_runtime_required",
      runId, controllerState: "ARMED", modelExecutionStarted: false, dispatchStarted: false })
    expect(service.hasAutomaticArm()).toBe(true)
    expect(prompt).not.toHaveBeenCalled()
  } finally { prompt.mockRestore() }
  expect(service.status()).toMatchObject({ state: "ARMED", runId,
    requestCounts: { charged: { target: 0, optimizer: 0, reviewer: 0 },
      dispatched: { target: 0, optimizer: 0, reviewer: 0 }, unknown: { target: 0, optimizer: 0, reviewer: 0 } } })
  expect(inferenceRuns).toBe(0)
  expect(runtime.runs.status().claim).toBeUndefined()
  expect(runtime.runs.status().executions).toHaveLength(0)
  expect(owner.isReleased).toBe(false)
})

nativeTest("overlapping automatic polls are refused before a second binding read", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner, service }
  fixtures.push(fixture)
  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string" || typeof prepared.bindingSha256 !== "string") {
    throw new Error("overlapping-poll fixture was not prepared")
  }
  const runId = prepared.runId
  await withApprovalFromPrompt(() => service.arm(runId, input, prepared.bindingSha256 as string))
  addAutomaticDigests(root, { fresh: 5 })

  const identityBarrier = createIdentityBarrier(3)
  const inspectCallsBeforePoll = inspectCalls
  scriptedIdentityBarrier = identityBarrier
  let firstPoll: Promise<Readonly<Record<string, unknown>> | undefined> | undefined
  let firstResult: Readonly<Record<string, unknown>> | undefined
  let barrierTimer: ReturnType<typeof setTimeout> | undefined
  try {
    firstPoll = service.pollAutomatic()
    await Promise.race([identityBarrier.arrived, new Promise<never>((_resolve, reject) => {
      barrierTimer = setTimeout(() => reject(new Error("automatic poll did not reach the bounded identity barrier")), 5000)
    })])
    expect(identityBarrier.arrivals).toBe(3)
    expect(inspectCalls).toBe(inspectCallsBeforePoll + 3)

    const overlapping = await service.pollAutomatic()
    expect(overlapping).toMatchObject({ operation: "automatic", state: "BLOCKED",
      reasonCode: "automatic_poll_in_progress", runId, modelExecutionStarted: false,
      dispatchStarted: false, candidateQualified: false })
    expect(inspectCalls).toBe(inspectCallsBeforePoll + 3)
    expect(inferenceRuns).toBe(0)
  } finally {
    if (barrierTimer) clearTimeout(barrierTimer)
    scriptedIdentityBarrier = undefined
    identityBarrier.release()
    if (firstPoll) firstResult = await firstPoll
  }

  expect(firstResult).toMatchObject({ operation: "run", state: "DATA_REQUIRED",
    reasonCode: "trainer_runtime_required", runId, controllerState: "ARMED",
    modelExecutionStarted: false, dispatchStarted: false })
  expect(service.hasAutomaticArm()).toBe(true)
  expect(service.status().state).toBe("ARMED")
  expect(inferenceRuns).toBe(0)
  expect(runtime.runs.status().claim).toBeUndefined()
})

test.skipIf(process.env.SKILLOPT_PYTHON === undefined)("fresh automatic first campaign admits one reservation across duplicate polls and stops at candidate approval", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  const automaticBaseline = Buffer.from(`---\nname: llm-wiki\ndescription: Synthetic automatic campaign fixture\n---\n\n${COMPILE_ANCHOR}3. Preserve supported Wiki facts.\n`)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, automaticBaseline, { mode: 0o600 })
  if (!workerRuntimeSelection) throw new Error("configured contained trainer runtime was not selected")
  const positivePack = makeAutomaticPack()
  const expectedFamilyCount = NATIVE_WIKI_SPLITS.reduce((total, split) => total + NATIVE_WIKI_SPLIT_MINIMUMS[split], 0)
  expect(expectedFamilyCount).toBe(76)
  expect(positivePack.fixtures).toHaveLength(expectedFamilyCount)
  expect(new Set(positivePack.fixtures.map(item => item.familyId)).size).toBe(expectedFamilyCount)
  for (const item of positivePack.fixtures) {
    expect(validateNativeFixtureGold(item)).toEqual({ status: "READY", reasons: [] })
  }
  const input = { ...makeInput(root, positivePack), runtime: workerRuntimeSelection }
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture = { worktree, runtime, owner, service }
  fixtures.push(fixture)

  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string" || typeof prepared.bindingSha256 !== "string") {
    throw new Error("fresh automatic campaign was not prepared")
  }
  const runId = prepared.runId
  const ledgerPath = join(dirname(executionRunDirectory(root)), "skillopt", "automation", "ledger.sqlite")
  const ledgerSnapshot = () => {
    const database = new Database(ledgerPath, { readonly: true, readwrite: false, create: false })
    try {
      return Object.freeze({
        quota: database.query(`SELECT revision,last_attempt_id,last_attempt_boot,last_attempt_cont,pending_request_id,
          active_run_id,clock_boot,fence_boot,fence_cont FROM quota WHERE singleton=1`).get(),
        run: database.query("SELECT state,revision,artifact_bytes FROM runs WHERE run_id=?").get(runId),
        arm: database.query("SELECT state,reservation_id,armed_boot FROM arms WHERE run_id=?").get(runId),
        attempts: database.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(runId),
        requests: database.query("SELECT count(*) AS count FROM requests WHERE run_id=?").get(runId),
      })
    } finally { database.close() }
  }
  const beforeArm = ledgerSnapshot()
  expect((beforeArm.run as { state: string }).state).toBe("PREPARED")
  expect((beforeArm.quota as { last_attempt_id: string | null }).last_attempt_id).toBeNull()
  expect(beforeArm.attempts).toEqual({ count: 0 })
  expect(beforeArm.requests).toEqual({ count: 0 })
  expect(service.status().requestCounts).toEqual({
    charged: { target: 0, optimizer: 0, reviewer: 0 },
    dispatched: { target: 0, optimizer: 0, reviewer: 0 },
    unknown: { target: 0, optimizer: 0, reviewer: 0 },
  })

  const armed = await withApprovalFromPrompt(() => service.arm(runId, input, prepared.bindingSha256 as string))
  expect(armed.operation).toBe("arm")
  expect(armed.state).toBe("ARMED")
  expect(armed.runId).toBe(runId)
  expect(service.hasAutomaticArm()).toBe(true)
  addAutomaticDigests(root, { fresh: 5 })
  expect(readdirSync(digestDirectory(root))).toHaveLength(5)
  const afterArm = ledgerSnapshot()
  expect((afterArm.quota as { last_attempt_id: string | null }).last_attempt_id).toBeNull()
  expect(afterArm.arm).toMatchObject({ state: "armed", reservation_id: null })
  expect(afterArm.attempts).toEqual({ count: 0 })
  expect(afterArm.requests).toEqual({ count: 0 })

  const pendingClaim = runtime.runs.claim(owner.sessionID, `foreground-automatic-pending-${randomUUID()}`, process.pid)
  try {
    const pending = await service.pollAutomatic()
    expect(pending?.operation).toBe("automatic")
    expect(pending?.state).toBe("ARMED")
    expect(pending?.readiness).toBe("BLOCKED")
    expect(pending?.reasonCode).toBe("owner-busy")
    expect(service.hasAutomaticArm()).toBe(true)
    expect(service.status().state).toBe("ARMED")
    expect(ledgerSnapshot().attempts).toEqual({ count: 0 })
    expect(ledgerSnapshot().requests).toEqual({ count: 0 })
  } finally { runtime.runs.release(pendingClaim) }
  expect(runtime.runs.status().claim).toBeUndefined()
  expect(transportCalls).toHaveLength(0)

  const inputFixtures = input.fixturePack.fixtures
  scriptedTransportResult = ({ model, prompt }) => {
    if (model === models.generator.requestedModel) {
      const edit = { op: "append", content: automaticCandidateInstruction }
      return { status: "completed", quiescent: true,
        text: canonicalJson({ patch: { reasoning: "Preserve fixture-supported observations.", edits: [edit] },
          edits: [edit], selected_indices: [0] }) }
    }
    if (model === models.reviewer.requestedModel) {
      return { status: "completed", quiescent: true,
        text: canonicalJson({ schema: "skillopt.semantic-review.v1", assessment: "clear", findings: [] }) }
    }
    const targetFixture = inputFixtures.find(item => prompt.includes(item.task))
    if (!targetFixture) throw new Error("synthetic target request did not bind one fixture task")
    return { status: "completed", quiescent: true,
      text: automaticFixtureResponse(targetFixture, prompt.includes(automaticCandidateInstruction)) }
  }

  const campaignModule = await import("../src/skillopt/campaign.ts")
  const runCampaign = campaignModule.runNativeSkillOptCampaign
  const campaignDiagnostics: unknown[] = []
  const campaignSpy = spyOn(campaignModule, "runNativeSkillOptCampaign").mockImplementation(async options => {
    const result = await runCampaign(options)
    campaignDiagnostics.push({ status: result.status, reasonCode: result.reasonCode, diagnostic: result.diagnostic })
    return result
  })
  const identityBarrier = createIdentityBarrier(3)
  scriptedIdentityBarrier = identityBarrier
  const pollingAbort = new AbortController()
  const concurrentPolls = Promise.allSettled([service.pollAutomatic(pollingAbort.signal), service.pollAutomatic(pollingAbort.signal)])
  let phase = "identity barrier"
  let campaignDeadlineTimer: ReturnType<typeof setTimeout> | undefined
  let progressTimer: ReturnType<typeof setInterval> | undefined
  let barrierTimer: ReturnType<typeof setTimeout> | undefined
  let barrierFailure: unknown
  let campaignDeadlineElapsed = false
  let pollSettlementObserved = false
  let settledPolls: Awaited<typeof concurrentPolls> | undefined
  const settledPollsPromise = concurrentPolls.then(result => {
    pollSettlementObserved = true
    return result
  })
  const pollDeadline = new Promise<void>(resolveDeadline => {
    campaignDeadlineTimer = setTimeout(() => {
      campaignDeadlineElapsed = true
      pollingAbort.abort()
      resolveDeadline()
    }, automaticCampaignDeadlineMs)
  })
  progressTimer = setInterval(() => {
    process.stderr.write(`[skillopt-automatic] phase=${phase} identity=${identityBarrier.arrivals}/${identityBarrier.expected} ` +
      `transport=${transportCalls.length} completions=${inferenceRuns} campaigns=${campaignDiagnostics.length}\n`)
  }, 60_000)
  try {
    await Promise.race([identityBarrier.arrived, new Promise<never>((_resolve, reject) => {
      barrierTimer = setTimeout(() => reject(new Error("automatic poll did not reach its shared identity boundary")), 5000)
    })])
    expect(identityBarrier.arrivals).toBe(3)
  } catch (error) {
    barrierFailure = error
    pollingAbort.abort()
  } finally {
    if (barrierTimer) clearTimeout(barrierTimer)
    scriptedIdentityBarrier = undefined
    identityBarrier.release()
  }
  try {
    if (barrierFailure === undefined) {
      phase = "qualified campaign"
      const outcome = await Promise.race([
        settledPollsPromise.then(result => Object.freeze({ state: "settled" as const, result })),
        pollDeadline.then(() => Object.freeze({ state: "deadline" as const })),
      ])
      settledPolls = outcome.state === "settled" ? outcome.result : await settledPollsPromise
    }
  } finally {
    if (!pollSettlementObserved) {
      pollingAbort.abort()
      scriptedIdentityBarrier = undefined
      identityBarrier.release()
      settledPolls = await settledPollsPromise
    }
    if (campaignDeadlineTimer) clearTimeout(campaignDeadlineTimer)
    if (progressTimer) clearInterval(progressTimer)
    campaignSpy.mockRestore()
    scriptedIdentityBarrier = undefined
  }
  if (barrierFailure !== undefined) throw barrierFailure
  if (campaignDeadlineElapsed) {
    throw new Error(`automatic campaign exceeded its internal deadline; cancellation settled and joined; phase=${phase} ` +
      `identity=${identityBarrier.arrivals}/${identityBarrier.expected} transport=${transportCalls.length} ` +
      `completions=${inferenceRuns} campaigns=${campaignDiagnostics.length}`)
  }
  if (!settledPolls) throw new Error("automatic campaign poll promises settled without retained results")
  const pollResults = settledPolls.map(result => {
    if (result.status === "rejected") throw result.reason
    return result.value
  })
  const qualified = pollResults.filter(result => result?.state === "AWAITING_CANDIDATE_APPROVAL" && result.candidateQualified === true)
  if (qualified.length !== 1) {
    throw new Error(`automatic poll outcomes: ${JSON.stringify(pollResults.map(result => ({
      state: result?.state, reasonCode: result?.reasonCode, controllerState: result?.controllerState,
    })))}; campaign diagnostics: ${JSON.stringify(campaignDiagnostics)}`)
  }
  expect(qualified).toHaveLength(1)
  expect(pollResults).toHaveLength(2)
  const refusedDuplicate = pollResults.find(result => result !== qualified[0])
  expect(refusedDuplicate).toMatchObject({ operation: "automatic", state: "BLOCKED",
    reasonCode: "automatic_poll_in_progress", runId, modelExecutionStarted: false,
    dispatchStarted: false, candidateQualified: false })
  const result = qualified[0]!
  expect(result.operation).toBe("run")
  expect(result.runId).toBe(runId)
  expect(result.controllerState).toBe("AWAITING_CANDIDATE_APPROVAL")
  expect(result.candidateQualified).toBe(true)
  expect(result.metricsStatus).toBe("METRICS_PASSED")
  expect(result.reviewerCount).toBe(2)
  expect(result.pendingDispatch).toBe(false)
  expect(result.modelExecutionStarted).toBe(true)
  expect(result.dispatchStarted).toBe(true)
  expect(result.publicationAuthorized).toBe(false)
  expect(result.postApplyHandoffAuthorized).toBe(false)
  expect(result.candidateSha256).toMatch(/^[a-f0-9]{64}$/u)
  expect(JSON.stringify(result)).not.toContain("candidateSkill")
  expect(JSON.stringify(result)).not.toContain("reviewerEvidence")
  expect(JSON.stringify(result)).not.toContain(automaticCandidateInstruction)
  expect(service.hasAutomaticArm()).toBe(false)
  expect(service.status().state).toBe("AWAITING_CANDIDATE_APPROVAL")
  const status = service.status()
  expect(status.requestCounts).toEqual({
    charged: { target: 432, optimizer: 3, reviewer: 2 },
    dispatched: { target: 432, optimizer: 3, reviewer: 2 },
    unknown: { target: 0, optimizer: 0, reviewer: 0 },
  })
  expect(status.pendingDispatch).toBe(false)
  expect(typeof status.dailyCooldownRemainingMilliseconds).toBe("number")
  expect(status.dailyCooldownRemainingMilliseconds).toBeGreaterThan(0)
  expect(runtime.runs.status().claim).toBeUndefined()
  expect(owner.isReleased).toBe(false)
  owner.assertOwner()
  expect(readFileSync(skillPath)).toEqual(automaticBaseline)
  expect(inferenceRuns).toBe(437)
  expect(transportCalls).toHaveLength(437)

  const database = new Database(ledgerPath, { readonly: true, readwrite: false, create: false })
  try {
    const quota = database.query(`SELECT last_attempt_id,last_attempt_boot,pending_request_id,active_run_id
      FROM quota WHERE singleton=1`).get() as {
        last_attempt_id: string | null; last_attempt_boot: string | null; pending_request_id: string | null; active_run_id: string | null
      }
    const attemptValue = database.query(`SELECT reservation_id,trigger_kind,request_id,actual_dispatch,dispatch_state
      FROM attempts WHERE run_id=?`).get(runId)
    expect(attemptValue).not.toBeNull()
    const attempt = attemptValue as {
        reservation_id: string; trigger_kind: string; request_id: string; actual_dispatch: number | null; dispatch_state: string
      }
    const initialRequest = database.query(`SELECT role,phase,dispatch_state,actual_dispatch FROM requests
      WHERE request_id=? AND run_id=?`).get(attempt.request_id, runId)
    expect(quota.last_attempt_id).toBe(attempt.reservation_id)
    expect(typeof quota.last_attempt_boot).toBe("string")
    expect(quota.pending_request_id).toBeNull()
    expect(quota.active_run_id).toBe(runId)
    expect(attempt.trigger_kind).toBe("automatic")
    expect(attempt.actual_dispatch).toBe(1)
    expect(attempt.dispatch_state).toBe("settled")
    expect(initialRequest).toEqual({ role: "target", phase: "train", dispatch_state: "settled", actual_dispatch: 1 })
    expect(database.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(runId)).toEqual({ count: 1 })
    expect(database.query(`SELECT role,count(*) AS count FROM requests WHERE run_id=? GROUP BY role ORDER BY role`)
      .all(runId)).toEqual([
        { role: "optimizer", count: 3 }, { role: "reviewer", count: 2 }, { role: "target", count: 432 },
      ])
    expect(database.query(`SELECT count(*) AS count FROM requests WHERE run_id=? AND actual_dispatch=1 AND dispatch_state='settled'`)
      .get(runId)).toEqual({ count: 437 })
    expect(database.query(`SELECT count(*) AS count FROM requests WHERE run_id=? AND
      (actual_dispatch IS NULL OR actual_dispatch<>1 OR dispatch_state<>'settled')`).get(runId)).toEqual({ count: 0 })
    expect(database.query("SELECT state FROM runs WHERE run_id=?").get(runId)).toEqual({ state: "AWAITING_CANDIDATE_APPROVAL" })
    expect(database.query("SELECT count(*) AS count FROM campaign_qualifications WHERE run_id=?").get(runId))
      .toEqual({ count: 1 })
    expect(database.query("SELECT count(*) AS count FROM canary_handoffs WHERE run_id=?").get(runId)).toEqual({ count: 0 })
    expect(database.query("SELECT count(*) AS count FROM requests WHERE run_id=? AND phase='canary'").get(runId))
      .toEqual({ count: 0 })
    const eventRows = database.query(`SELECT ordinal,kind,optimizer_stage AS optimizerStage FROM trainer_protocol_events WHERE run_id=? ORDER BY ordinal`)
      .all(runId) as Array<{ ordinal: number; kind: string; optimizerStage: string | null }>
    expect(eventRows).toHaveLength(123)
    eventRows.forEach((event, index) => expect(event.ordinal).toBe(index + 1))
    expect(eventRows[0]).toEqual({ ordinal: 1, kind: "rollout", optimizerStage: null })
    const optimizerDispatches = database.query(`SELECT e.ordinal,e.optimizer_stage AS optimizerStage,d.native_request_id AS nativeRequestId,
      r.role,r.actual_dispatch AS actualDispatch,r.dispatch_state AS dispatchState FROM trainer_protocol_events e
      JOIN trainer_protocol_dispatches d ON d.run_id=e.run_id AND d.wire_request_id=e.wire_request_id
      JOIN requests r ON r.request_id=d.native_request_id WHERE e.run_id=? AND e.kind='optimizer' ORDER BY e.ordinal`)
      .all(runId) as Array<{ ordinal: number; optimizerStage: string; nativeRequestId: string; role: string;
        actualDispatch: number; dispatchState: string }>
    const optimizerStages = optimizerDispatches.map(event => event.optimizerStage)
    const stageOrder = { analyst: 0, merge: 1, ranking: 2 } as const
    expect(optimizerDispatches).toHaveLength(3)
    expect(optimizerStages.every(stage => Object.hasOwn(stageOrder, stage))).toBe(true)
    const stageRanks = optimizerStages.map(stage => stageOrder[stage as keyof typeof stageOrder])
    expect(stageRanks).toEqual([...stageRanks].sort((left, right) => left - right))
    expect(new Set(optimizerDispatches.map(event => event.nativeRequestId)).size).toBe(3)
    for (const dispatch of optimizerDispatches) {
      expect(dispatch.role).toBe("optimizer")
      expect(dispatch.actualDispatch).toBe(1)
      expect(dispatch.dispatchState).toBe("settled")
    }
    expect(eventRows.filter(event => event.kind === "rollout")).toHaveLength(120)
    expect(eventRows.filter(event => event.kind === "optimizer")).toHaveLength(3)
    expect(database.query(`SELECT count(*) AS count FROM trainer_protocol_dispatches WHERE run_id=?`).get(runId))
      .toEqual({ count: 123 })
    expect(database.query(`SELECT count(DISTINCT native_request_id) AS count FROM trainer_protocol_dispatches WHERE run_id=?`)
      .get(runId)).toEqual({ count: 123 })
    expect(database.query(`SELECT count(*) AS count FROM trainer_protocol_events e
      JOIN trainer_protocol_dispatches d ON d.run_id=e.run_id AND d.wire_request_id=e.wire_request_id
      JOIN requests r ON r.request_id=d.native_request_id WHERE e.run_id=? AND r.actual_dispatch=1 AND r.dispatch_state='settled'`)
      .get(runId)).toEqual({ count: 123 })
    expect(database.query(`SELECT r.role,count(*) AS count FROM trainer_protocol_dispatches d
      JOIN requests r ON r.request_id=d.native_request_id WHERE d.run_id=? GROUP BY r.role ORDER BY r.role`).all(runId))
      .toEqual([{ role: "optimizer", count: 3 }, { role: "target", count: 120 }])
  } finally { database.close() }

  expect(await service.pollAutomatic()).toBeUndefined()
  expect(service.status().state).toBe("AWAITING_CANDIDATE_APPROVAL")
  expect(service.status().requestCounts).toEqual(status.requestCounts)
  expect(inferenceRuns).toBe(437)
  expect(ledgerSnapshot().attempts).toEqual({ count: 1 })
}, automaticCampaignOuterDeadlineMs)

nativeTest("automatic polling invalidates its private arm capability when the selected binding drifts", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner, service }
  fixtures.push(fixture)
  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string" || typeof prepared.bindingSha256 !== "string") {
    throw new Error("automatic drift fixture was not prepared")
  }
  const runId = prepared.runId
  await withApprovalFromPrompt(() => service.arm(runId, input, prepared.bindingSha256 as string))
  expect(service.hasAutomaticArm()).toBe(true)
  addAutomaticDigests(root, { fresh: 5 })
  writeFileSync(join(root, input.selections![0]!.path), "Changed after arm; polling must refuse the bound capability.\n", { mode: 0o600 })

  const blocked = await service.pollAutomatic()
  expect(blocked).toMatchObject({ operation: "automatic", state: "BLOCKED", runId })
  expect(service.hasAutomaticArm()).toBe(false)
  expect(await service.pollAutomatic()).toBeUndefined()
  expect(service.status()).toMatchObject({ state: "ARMED", runId,
    requestCounts: { charged: { target: 0, optimizer: 0, reviewer: 0 },
      dispatched: { target: 0, optimizer: 0, reviewer: 0 } } })
  expect(inferenceRuns).toBe(0)
  expect(runtime.runs.status().executions).toHaveLength(0)
})

nativeTest("cancelling an automatic poll leaves the persisted arm untouched and cannot retry it", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner, service }
  fixtures.push(fixture)
  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string" || typeof prepared.bindingSha256 !== "string") {
    throw new Error("automatic cancellation fixture was not prepared")
  }
  const runId = prepared.runId
  await withApprovalFromPrompt(() => service.arm(runId, input, prepared.bindingSha256 as string))
  expect(service.hasAutomaticArm()).toBe(true)
  const abort = new AbortController()
  abort.abort()

  expect(await service.pollAutomatic(abort.signal)).toBeUndefined()
  expect(service.hasAutomaticArm()).toBe(false)
  expect(await service.pollAutomatic()).toBeUndefined()
  expect(service.status()).toMatchObject({ state: "ARMED", runId,
    requestCounts: { charged: { target: 0, optimizer: 0, reviewer: 0 },
      dispatched: { target: 0, optimizer: 0, reviewer: 0 }, unknown: { target: 0, optimizer: 0, reviewer: 0 } } })
  expect(inferenceRuns).toBe(0)
  expect(runtime.runs.status().claim).toBeUndefined()
})

nativeTest("explicit cancel and service disposal clear only the genuine process-local arm hint", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture: (typeof fixtures)[number] = { worktree, runtime, owner, service }
  fixtures.push(fixture)

  const first = await service.prepare(input)
  if (first.state !== "PREPARED" || typeof first.runId !== "string" || typeof first.bindingSha256 !== "string") {
    throw new Error("automatic cancel fixture was not prepared")
  }
  await withApprovalFromPrompt(() => service.arm(first.runId as string, input, first.bindingSha256 as string))
  expect(service.hasAutomaticArm()).toBe(true)
  const cancelled = await service.cancel(first.runId, undefined)
  expect(cancelled).toMatchObject({ operation: "cancel", state: "CANCELLED", runId: first.runId })
  expect(service.hasAutomaticArm()).toBe(false)

  const second = await service.prepare(input)
  if (second.state !== "PREPARED" || typeof second.runId !== "string" || typeof second.bindingSha256 !== "string") {
    throw new Error("automatic disposal fixture was not prepared")
  }
  await withApprovalFromPrompt(() => service.arm(second.runId as string, input, second.bindingSha256 as string))
  expect(service.hasAutomaticArm()).toBe(true)
  const metadataCalls = inspectCalls
  expect(service.hasAutomaticArm()).toBe(true)
  expect(inspectCalls).toBe(metadataCalls)
  service.dispose()
  expect(service.hasAutomaticArm()).toBe(false)
  expect(inferenceRuns).toBe(0)
})

nativeTest("run requires a real terminal reentry and leaves runtime-missing work unstarted", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture = { worktree, runtime, owner, service }
  fixtures.push(fixture)

  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string" || typeof prepared.bindingSha256 !== "string") {
    throw new Error("synthetic foreground run was not prepared")
  }
  const result = await withApprovalFromPrompt(() => service.run(prepared.runId as string, input, prepared.bindingSha256 as string))
  expect(result).toMatchObject({ operation: "run", state: "DATA_REQUIRED", reasonCode: "trainer_runtime_required",
    runId: prepared.runId, controllerState: "CONSENTED", modelExecutionStarted: false, dispatchStarted: false,
    candidateQualified: false, publicationAuthorized: false, postApplyHandoffAuthorized: false })
  expect(service.status().requestCounts).toMatchObject({ charged: { target: 0, optimizer: 0, reviewer: 0 },
    dispatched: { target: 0, optimizer: 0, reviewer: 0 }, unknown: { target: 0, optimizer: 0, reviewer: 0 } })
  expect(inferenceRuns).toBe(0)
  expect(runtime.runs.status().claim).toBeUndefined()
  expect(runtime.runs.status().executions).toHaveLength(0)
  expect(owner.isReleased).toBe(false)
  owner.assertOwner()
  const publicJson = JSON.stringify(result)
  expect(publicJson).not.toContain("candidateSkill")
  expect(publicJson).not.toContain("reviewerEvidence")
  expect(() => consumeNativeSkillOptForegroundRunResult(JSON.parse(publicJson), owner, runtime))
    .toThrow("foreground_run_receipt_invalid")
  const terminal: Terminal = { stdinIsTTY: true, stderrIsTTY: true, readLine: async () => undefined, write() {}, close() {} }
  expect(await service.publish(prepared.runId, terminal)).toMatchObject({ operation: "publish", state: "BLOCKED",
    reasonCode: "qualified_run_receipt_unavailable", candidateQualified: false, publicationAuthorized: false })
  const beforeRollbackStatus = service.status()
  const beforeRollbackSkill = sha256(readFileSync(skillPath))
  const noContextRollback = await service.rollback(prepared.runId, terminal)
  expect(noContextRollback).toMatchObject({ operation: "rollback", state: "BLOCKED",
    reasonCode: "published_context_unavailable", candidateQualified: false, publicationAuthorized: false,
    rollbackAuthorized: false, postRollbackHandoffAuthorized: false })
  expect(JSON.stringify(noContextRollback)).not.toContain("candidateSkill")
  expect(JSON.stringify(noContextRollback)).not.toContain("reviewerEvidence")
  expect(service.status()).toEqual(beforeRollbackStatus)
  expect(sha256(readFileSync(skillPath))).toBe(beforeRollbackSkill)

  const copiedContextService = createNativeSkillOptForeground(runtime, owner)
  try {
    expect(await copiedContextService.rollback(prepared.runId, terminal)).toMatchObject({
      operation: "rollback", state: "BLOCKED", reasonCode: "published_context_unavailable",
      publicationAuthorized: false, rollbackAuthorized: false,
    })
  } finally { copiedContextService.dispose() }
  expect(readFileSync(skillPath)).toEqual(baseline)
})

nativeTest("aborting the run reentry receipt preserves the prepared run and zero dispatch", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture = { worktree, runtime, owner, service }
  fixtures.push(fixture)

  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string" || typeof prepared.bindingSha256 !== "string") {
    throw new Error("synthetic foreground run was not prepared")
  }
  const before = service.status()
  await expect(abortAtPrompt(signal => service.run(prepared.runId as string, input, prepared.bindingSha256 as string, signal)))
    .rejects.toThrow("operator_decision_aborted")
  expect(service.status()).toMatchObject({ state: "PREPARED", runId: prepared.runId,
    revision: before.revision, pendingDispatch: false, requestCounts: before.requestCounts })
  expect(inferenceRuns).toBe(0)
  expect(runtime.runs.status().claim).toBeUndefined()
  expect(runtime.runs.status().executions).toHaveLength(0)
  expect(owner.isReleased).toBe(false)
  owner.assertOwner()
})

test.skipIf(!supportedNative || !workerRuntimeSelection)("run invokes the real campaign only after contained trainer readiness", async () => {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  if (!workerRuntimeSelection) throw new Error("configured contained trainer runtime was not selected")
  const input = { ...makeInput(root), runtime: workerRuntimeSelection }
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture = { worktree, runtime, owner, service }
  fixtures.push(fixture)
  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string" || typeof prepared.bindingSha256 !== "string") {
    throw new Error("synthetic foreground run was not prepared")
  }
  scriptedTransportResult = { status: "failed", text: "", quiescent: true, error: "scripted terminal transport failure" }
  const result = await withApprovalFromPrompt(() => service.run(prepared.runId as string, input, prepared.bindingSha256 as string))
  if (typeof result.state !== "string") throw new Error("foreground campaign omitted its metadata state")
  const status = service.status()
  if (status.requestCounts.dispatched.target === 0) {
    expect(["BLOCKED", "DATA_REQUIRED"]).toContain(result.state)
    expect(result).toMatchObject({ modelExecutionStarted: false, dispatchStarted: false, candidateQualified: false })
    expect(status.requestCounts.dispatched).toEqual({ target: 0, optimizer: 0, reviewer: 0 })
    expect(inferenceRuns).toBe(0)
  } else {
    expect(["BLOCKED", "FAILED", "CANCELLED", "UNRESOLVED"]).toContain(result.state)
    expect(status.requestCounts.dispatched.optimizer).toBe(0)
    expect(status.requestCounts.dispatched.reviewer).toBe(0)
    expect(inferenceRuns).toBe(status.requestCounts.dispatched.target)
    expect(result.state).not.toBe("COMPLETED")
    expect(result.candidateQualified).toBe(false)
  }
  expect(owner.isReleased).toBe(false)
  owner.assertOwner()
  expect(runtime.runs.status().claim).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain("reviewerEvidence")
  expect(JSON.stringify(result)).not.toContain("candidateSkill")
})

async function prepareCleanupFixture() {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baseline, { mode: 0o600 })
  const input = makeInput(root)
  const runtime = runtimeFor(root)
  const owner = attachFixtureOwner(runtime)
  const service = createNativeSkillOptForeground(runtime, owner)
  const fixture = { worktree, runtime, owner, service }
  fixtures.push(fixture)
  const prepared = await service.prepare(input)
  if (prepared.state !== "PREPARED" || typeof prepared.runId !== "string") throw new Error("cleanup fixture prepare failed")
  const runId = prepared.runId
  const ledgerPath = join(dirname(executionRunDirectory(root)), "skillopt", "automation", "ledger.sqlite")
  const expire = () => {
    // Disposable synthetic row only: exercise the real native same-boot expiry check without waiting seven days.
    const db = new Database(ledgerPath)
    try { db.query("UPDATE runs SET expires_cont='0',expires_wall='0' WHERE run_id=?").run(runId) }
    finally { db.close() }
  }
  return { fixture, root, runtime, owner, service, input, runId, ledgerPath, expire }
}

nativeTest("cleanup CLI cancellation uses a real controlling PTY and preserves the expired synthetic run", async () => {
  const f = await prepareCleanupFixture()
  f.expire()

  const expiryDeadline = () => {
    const db = new Database(f.ledgerPath)
    try {
      return db.query("SELECT expires_cont,expires_wall FROM runs WHERE run_id=?").get(f.runId) as
        { expires_cont: string; expires_wall: string } | undefined
    } finally { db.close() }
  }
  const expiredDeadlineBefore = expiryDeadline()
  expect(expiredDeadlineBefore).toEqual({ expires_cont: "0", expires_wall: "0" })

  const artifactPath = foregroundArtifactPath(f.root, f.runId)
  const sourcePath = join(f.root, f.input.selections![0]!.path)
  const baselinePath = join(f.root, PILOT_SKILL)
  const before = f.service.status()
  expect(before.state).toBe("PREPARED")
  expect(before.requestCounts).toEqual({
    charged: { target: 0, optimizer: 0, reviewer: 0 },
    dispatched: { target: 0, optimizer: 0, reviewer: 0 },
    unknown: { target: 0, optimizer: 0, reviewer: 0 },
  })
  const runUsageBefore = {
    state: before.state,
    runId: before.runId,
    revision: before.revision,
    pendingDispatch: before.pendingDispatch,
    requestCounts: structuredClone(before.requestCounts),
    targetPhaseCounts: structuredClone(before.targetPhaseCounts),
    remaining: structuredClone(before.remaining),
  }
  const retainedFiles = [artifactPath, sourcePath, baselinePath].map(path => ({
    path,
    bytes: readFileSync(path),
    identity: lstatSync(path, { bigint: true }),
  }))
  const metadataCallsBefore = inspectCalls
  const inferenceRunsBefore = inferenceRuns
  const authorityPath = f.fixture.worktree.executionAuthority.keyDirectory
  const authorityBefore = lstatSync(authorityPath, { bigint: true })
  expect(authorityBefore.isDirectory()).toBe(true)
  expect(f.runtime.runs.status().claim).toBeUndefined()

  // Exercise argv fidelity with a literal root path containing spaces; the symlink is within
  // this fixture's stateHome, points only at its worktree, and is removed by fixture cleanup.
  const rootArgument = join(f.fixture.worktree.stateHome, `cleanup root with spaces ${randomUUID()}`)
  symlinkSync(f.root, rootArgument, "dir")

  f.service.dispose()
  const detached = await detachAdmission(f.runtime, f.owner.sessionID, f.owner.epoch, "cleanup_pty_subprocess")
  if (!detached) throw new Error("cleanup PTY fixture owner was not detached before subprocess")

  const helperEnvironment = {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  }
  const helperArgs = [
    "-I", "-S", "-B", cleanupPtyHelper,
    "--bun", process.execPath,
    "--cwd", repositoryRoot,
    "--root", rootArgument,
    "--run", f.runId,
    "--state-home", f.fixture.worktree.stateHome,
  ]
  const reportPathValue = process.env.OTTER_SKILLOPT_CLEANUP_PTY_REPORT
  const reportPath = reportPathValue ? resolve(reportPathValue) : undefined
  if (reportPath) helperArgs.push("--report", reportPath)
  const helperResult = spawnSync("/usr/bin/python3", helperArgs, {
    cwd: repositoryRoot,
    env: helperEnvironment,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 512 * 1024,
  })
  const diagnostic = [helperResult.stdout, helperResult.stderr, helperResult.error?.message].filter(Boolean).join("\n")
  expect(helperResult.error, `system Python PTY helper launch failed: ${diagnostic}`).toBeUndefined()
  expect(helperResult.status, `cleanup PTY helper failed:\n${diagnostic}`).toBe(0)

  const capture = JSON.parse(helperResult.stdout) as {
    status: string
    scope: string
    invocation: { executable: string; argv: string[]; rootArgument: string; runId: string }
    helper: { python: string; isolationFlags: string[]; stdlibOnly: boolean }
    pty: {
      controllingTtyVerified: boolean
      stdinIsTTY: boolean
      stdoutIsTTY: boolean
      stderrIsTTY: boolean
      promptObserved: boolean
      promptText: string
      signal: string
      controlBytesWrittenHex: string
      approvalTextBytesWritten: number
      exitCode: number | null
      terminatingSignal: string | null
      actualChildPid: number
      actualChildWaitStatus: number
      actualChildProcessGroup: number
      foregroundProcessGroup: number
      childReaped: boolean
      captureLimitBytes: number
      outputBytes: number
      outputBase64: string
      outputText: string
      consentMetadata: { operation: string; state: string; runId: string; revision: number; privateInputBytes: number }
      cancellationMetadata: { status: string; reasonCode: string; dispatchStarted: boolean; optimizationSucceeded: boolean }
    }
    supervisor: { pid: number; sessionLeader: boolean; aliveDuringTerminalSnapshot: boolean; exitCode: number | null; terminatingSignal: string | null; reaped: boolean }
    terminal: { canonical: boolean; echo: boolean; isig: boolean; restored: boolean; before: unknown; after: unknown; afterMeasuredBy: string }
    claims: { syntheticExpiredRowOnly: boolean; approvalLineSent: boolean; productionHumanApproval: boolean; wholeTuiProof: boolean }
    persistedReport?: { path: string; mode: string; exclusiveCreate: boolean }
  }
  const ptyOutput = Buffer.from(capture.pty.outputBase64, "base64")
  expect(capture).toMatchObject({
    status: "captured",
    invocation: { executable: process.execPath, argv: ["bun", "scripts/otter-skillopt.ts", "cleanup", "--root", rootArgument, "--run", f.runId],
      rootArgument, runId: f.runId },
    helper: { python: "/usr/bin/python3", isolationFlags: ["-I", "-S", "-B"], stdlibOnly: true },
    pty: {
      controllingTtyVerified: true, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true,
      promptObserved: true, signal: "SIGINT", controlBytesWrittenHex: "03", approvalTextBytesWritten: 0,
      exitCode: 1, terminatingSignal: null, actualChildProcessGroup: capture.pty.actualChildPid,
      foregroundProcessGroup: capture.pty.actualChildPid, childReaped: true,
      consentMetadata: { operation: "cleanup", state: "CONSENT_REQUIRED", runId: f.runId },
      cancellationMetadata: { status: "BLOCKED", reasonCode: "operator_decision_aborted", dispatchStarted: false, optimizationSucceeded: false },
    },
    supervisor: { sessionLeader: true, aliveDuringTerminalSnapshot: true, exitCode: 0, terminatingSignal: null, reaped: true },
    terminal: { canonical: true, echo: true, isig: true, restored: true },
    claims: { syntheticExpiredRowOnly: true, approvalLineSent: false, productionHumanApproval: false, wholeTuiProof: false },
  })
  expect(Number.isSafeInteger(capture.pty.actualChildPid)).toBe(true)
  expect(capture.pty.actualChildPid).toBeGreaterThan(0)
  expect(capture.pty.actualChildWaitStatus).toBe(1 << 8)
  expect(capture.pty.actualChildPid).not.toBe(capture.supervisor.pid)
  expect(capture.pty.actualChildProcessGroup).toBe(capture.pty.actualChildPid)
  expect(capture.pty.foregroundProcessGroup).toBe(capture.pty.actualChildPid)
  expect(capture.terminal.afterMeasuredBy).toContain("live session-leader supervisor after waiting for actual CLI child")
  expect(capture.scope).toContain("synthetic expired PREPARED row")
  expect(capture.scope).toContain("zero-attempt/no-model-dispatch evidence only")
  expect(capture.scope).toContain("not genuine human production approval or whole-TUI proof")
  expect(capture.pty.outputBytes).toBe(ptyOutput.byteLength)
  expect(ptyOutput.byteLength).toBeLessThanOrEqual(capture.pty.captureLimitBytes)
  expect(capture.pty.captureLimitBytes).toBeLessThanOrEqual(64 * 1024)
  expect(capture.pty.promptText).toMatch(new RegExp(`^Inspect the experiment scope, selected data, models, and budget first\\. Type 'APPROVE ${f.runId} [a-f0-9]{64}' or 'REJECT ${f.runId} [a-f0-9]{64} <reason>': $`, "u"))
  expect(capture.pty.outputText).toContain(capture.pty.promptText)
  expect(capture.pty.outputText).toContain('"state":"CONSENT_REQUIRED"')
  expect(capture.pty.outputText).toContain('"reasonCode":"operator_decision_aborted"')
  expect(capture.pty.outputText).not.toContain("Synthetic selected private source")
  expect(capture.pty.outputText).not.toContain("Synthetic protected foreground baseline")
  if (reportPath) {
    expect(capture.persistedReport).toEqual({ path: reportPath, mode: "0600", exclusiveCreate: true })
    const reportStat = lstatSync(reportPath)
    expect(reportStat.isFile()).toBe(true)
    expect(reportStat.mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({ schema: "skillopt-cleanup-pty/v1", status: "captured" })
  }

  expect(f.runtime.runs.status().claim).toBeUndefined()
  const authorityAfter = lstatSync(authorityPath, { bigint: true })
  expect(authorityAfter.isDirectory()).toBe(true)
  expect(authorityAfter.dev).toBe(authorityBefore.dev)
  expect(authorityAfter.ino).toBe(authorityBefore.ino)

  const owner = attachFixtureOwner(f.runtime)
  const service = createNativeSkillOptForeground(f.runtime, owner)
  f.fixture.owner = owner
  f.fixture.service = service
  const after = service.status()
  expect(after).toMatchObject(runUsageBefore)
  expect(after.state).toBe("PREPARED")
  expect(expiryDeadline()).toEqual(expiredDeadlineBefore)
  expect(after.requestCounts).toEqual(runUsageBefore.requestCounts)
  expect(inferenceRuns).toBe(inferenceRunsBefore)
  expect(inferenceRunsBefore).toBe(0)
  expect(inspectCalls).toBe(metadataCallsBefore)
  for (const file of retainedFiles) {
    expect(existsSync(file.path)).toBe(true)
    expect(readFileSync(file.path)).toEqual(file.bytes)
    const identity = lstatSync(file.path, { bigint: true })
    expect(identity.dev).toBe(file.identity.dev)
    expect(identity.ino).toBe(file.identity.ino)
  }
  expect(readFileSync(baselinePath)).toEqual(baseline)
}, 55_000)

nativeTest("private cleanup refuses an unexpired run without approval or model work", async () => {
  const f = await prepareCleanupFixture()
  const before = f.service.status()
  const artifact = foregroundArtifactPath(f.root, f.runId)
  const bytes = readFileSync(artifact)
  const metadataCalls = inspectCalls
  const prompt = spyOn(readline, "createInterface")
  try {
    await expect(f.service.cleanup(f.runId)).rejects.toThrow()
    expect(prompt).not.toHaveBeenCalled()
  } finally { prompt.mockRestore() }
  expect(readFileSync(artifact)).toEqual(bytes)
  expect(f.service.status()).toEqual(before)
  expect(f.runtime.runs.status().claim).toBeUndefined()
  expect(inspectCalls).toBe(metadataCalls)
  expect(inferenceRuns).toBe(0)
})

nativeTest("expired private input cleanup retires before deletion and requires a fresh decision after restart", async () => {
  const f = await prepareCleanupFixture()
  f.expire()
  const before = f.service.status()
  const metadataCalls = inspectCalls
  const sourcePath = join(f.root, f.input.selections[0]!.path)
  const source = readFileSync(sourcePath)
  const first = await withApprovalFromPrompt(() => f.service.cleanup(f.runId))
  expect(first).toMatchObject({ operation: "cleanup", state: "CLEANED", dispatchStarted: false, optimizationSucceeded: false })
  expect(existsSync(foregroundArtifactPath(f.root, f.runId))).toBe(false)
  expect(readFileSync(sourcePath)).toEqual(source)
  expect(readFileSync(join(f.root, PILOT_SKILL))).toEqual(baseline)
  const after = f.service.status()
  const { artifactBytes: beforeArtifactBytes, ...otherRemaining } = before.remaining
  expect(after).toMatchObject({ state: "EXPIRED", requestCounts: before.requestCounts,
    remaining: otherRemaining })
  expect(f.runtime.runs.status().claim).toBeUndefined()
  const saved = readFileSync(join(dirname(foregroundArtifactPath(f.root, f.runId)), `${f.runId}.cleanup.json`), "utf8")
  expect(beforeArtifactBytes - after.remaining.artifactBytes).toBe(Buffer.byteLength(saved) + 8 * 1024)
  expect(saved).not.toContain("Synthetic selected private source")
  expect(saved).not.toContain("Supported foreground fact")
  f.service.dispose()
  await detachAdmission(f.runtime, f.owner.sessionID, f.owner.epoch, "cleanup_restart")
  const owner = attachFixtureOwner(f.runtime)
  const service = createNativeSkillOptForeground(f.runtime, owner)
  f.fixture.owner = owner
  f.fixture.service = service
  await expect(abortAtPrompt(signal => service.cleanup(f.runId, signal))).rejects.toThrow("operator_decision_aborted")
  expect(service.status().revision).toBe(after.revision)
  const resumed = await withApprovalFromPrompt(() => service.cleanup(f.runId))
  expect(resumed.state).toBe("CLEANED")
  expect(service.status().requestCounts).toEqual(before.requestCounts)
  expect(inspectCalls).toBe(metadataCalls)
  expect(inferenceRuns).toBe(0)
})

nativeTest("cleanup preserves a replacement inode after retirement instead of adopting it on retry", async () => {
  const f = await prepareCleanupFixture()
  f.expire()
  const first = await withApprovalFromPrompt(() => f.service.cleanup(f.runId))
  expect(first.state).toBe("CLEANED")
  const artifact = foregroundArtifactPath(f.root, f.runId)
  const replacement = Buffer.from("user replacement must survive\n")
  const temporary = `${artifact}.replacement`
  writeFileSync(temporary, replacement, { flag: "wx", mode: 0o600 })
  renameSync(temporary, artifact)
  const retried = await withApprovalFromPrompt(() => f.service.cleanup(f.runId))
  expect(retried.state).toBe("CLEANUP_INCOMPLETE")
  expect(readFileSync(artifact)).toEqual(replacement)
  expect(f.service.status().state).toBe("EXPIRED")
  expect(f.runtime.runs.status().claim).toBeUndefined()
  expect(inferenceRuns).toBe(0)
})

nativeTest("cleanup quarantines and preserves a replacement installed in the rename window", async () => {
  const f = await prepareCleanupFixture()
  f.expire()
  const artifact = foregroundArtifactPath(f.root, f.runId)
  const replacement = Buffer.from("rename-window replacement must remain preserved\n")
  let injected = false
  const originalRename = nodeFs.renameSync
  const rename = spyOn(nodeFs, "renameSync")
  rename.mockImplementation(((source: unknown, destination: unknown) => {
    const sourcePath = String(source)
    if (!injected && sourcePath === artifact) {
      injected = true
      const replacementPath = `${artifact}.window-replacement`
      writeFileSync(replacementPath, replacement, { flag: "wx", mode: 0o600 })
      originalRename(replacementPath, artifact)
    }
    return originalRename(source as never, destination as never)
  }) as typeof nodeFs.renameSync)
  try {
    const result = await withApprovalFromPrompt(() => f.service.cleanup(f.runId))
    expect(result.state).toBe("CLEANUP_INCOMPLETE")
  } finally { rename.mockRestore() }
  expect(injected).toBe(true)
  expect(existsSync(artifact)).toBe(false)
  const quarantinedReplacement = join(dirname(artifact), `.${f.runId}.cleanup-input.v1`, "captured")
  expect(readFileSync(quarantinedReplacement)).toEqual(replacement)
  const retried = await withApprovalFromPrompt(() => f.service.cleanup(f.runId))
  expect(retried.state).toBe("CLEANUP_INCOMPLETE")
  expect(readFileSync(quarantinedReplacement)).toEqual(replacement)
  expect(f.service.status().state).toBe("EXPIRED")
  expect(f.runtime.runs.status().claim).toBeUndefined()
})

nativeTest("cleanup approval binds the inspected input identity across terminal wait", async () => {
  const f = await prepareCleanupFixture()
  f.expire()
  const artifact = foregroundArtifactPath(f.root, f.runId)
  const replacement = Buffer.from("changed during cleanup approval\n")
  const result = await withApprovalFromPrompt(() => f.service.cleanup(f.runId), () => {
    writeFileSync(artifact, replacement, { mode: 0o600 })
  })
  expect(result.state).toBe("CLEANUP_INCOMPLETE")
  expect(readFileSync(artifact)).toEqual(replacement)
  expect(f.service.status().state).toBe("EXPIRED")
  expect(f.runtime.runs.status().claim).toBeUndefined()
  expect(inferenceRuns).toBe(0)
})

nativeTest("cleanup preserves byte-identical mtime-preserved replacement in the rename window", async () => {
  const f = await prepareCleanupFixture()
  f.expire()
  const artifact = foregroundArtifactPath(f.root, f.runId)
  const bytes = readFileSync(artifact)
  const stamp = new Date("2026-01-01T00:00:00Z")
  nodeFs.utimesSync(artifact, stamp, stamp)
  const original = lstatSync(artifact, { bigint: true })
  const originalRename = nodeFs.renameSync
  let replacementInode: bigint | undefined
  const rename = spyOn(nodeFs, "renameSync")
  rename.mockImplementation(((source: unknown, destination: unknown) => {
    if (String(source) === artifact && replacementInode === undefined) {
      const replacement = `${artifact}.identical-replacement`
      writeFileSync(replacement, bytes, { flag: "wx", mode: 0o600 })
      nodeFs.utimesSync(replacement, stamp, stamp)
      const stat = lstatSync(replacement, { bigint: true })
      expect(stat.ino).not.toBe(original.ino)
      expect(stat.mtimeNs).toBe(original.mtimeNs)
      replacementInode = stat.ino
      originalRename(replacement, artifact)
    }
    return originalRename(source as never, destination as never)
  }) as typeof nodeFs.renameSync)
  try {
    const result = await withApprovalFromPrompt(() => f.service.cleanup(f.runId))
    expect(result.state).toBe("CLEANUP_INCOMPLETE")
  } finally { rename.mockRestore() }
  expect(replacementInode).toBeDefined()
  const captured = join(dirname(artifact), `.${f.runId}.cleanup-input.v1`, "captured")
  expect(readFileSync(captured)).toEqual(bytes)
  expect(lstatSync(captured, { bigint: true }).ino).toBe(replacementInode!)
  expect((await withApprovalFromPrompt(() => f.service.cleanup(f.runId))).state).toBe("CLEANUP_INCOMPLETE")
  expect(readFileSync(captured)).toEqual(bytes)
})

nativeTest("cleanup refuses missing input after quarantine creation without capture or deletion proof", async () => {
  const f = await prepareCleanupFixture()
  f.expire()
  const artifact = foregroundArtifactPath(f.root, f.runId)
  const moved = `${artifact}.externally-moved`
  const bytes = readFileSync(artifact)
  const originalRename = nodeFs.renameSync
  const rename = spyOn(nodeFs, "renameSync")
  rename.mockImplementation(((source: unknown, destination: unknown) => {
    if (String(source) === artifact) {
      originalRename(artifact, moved)
      throw new Error("interrupted before quarantine capture")
    }
    return originalRename(source as never, destination as never)
  }) as typeof nodeFs.renameSync)
  try {
    expect((await withApprovalFromPrompt(() => f.service.cleanup(f.runId))).state).toBe("CLEANUP_INCOMPLETE")
  } finally { rename.mockRestore() }
  const quarantine = join(dirname(artifact), `.${f.runId}.cleanup-input.v1`)
  expect(existsSync(join(quarantine, "marker.json"))).toBe(true)
  expect(existsSync(join(quarantine, "captured"))).toBe(false)
  expect(existsSync(join(quarantine, "deleted.json"))).toBe(false)
  expect((await withApprovalFromPrompt(() => f.service.cleanup(f.runId))).state).toBe("CLEANUP_INCOMPLETE")
  expect(readFileSync(moved)).toEqual(bytes)
  expect(existsSync(join(quarantine, "deleted.json"))).toBe(false)
  expect(f.runtime.runs.status().claim).toBeUndefined()
})
