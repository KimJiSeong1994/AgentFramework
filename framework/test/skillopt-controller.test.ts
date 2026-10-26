import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Database, SQLiteError, Statement } from "bun:sqlite"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { nativeObservedUsageCanonicalByteBound } from "../src/hosts/cli-transport.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import { consumeOperatorDecision, humanDecision, type DecisionBinding, type OperatorDecision } from "../src/hosts/operator.ts"
import type { ExecutionHost, ExecutionRequest, ExecutionReconciliation, ExecutionRuntime } from "../src/hosts/types.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import type { SessionDigest } from "../src/sessions/digest.ts"
import { digestDirectory } from "../src/sessions/digest.ts"
import {
  consumeNativeTrainerProtocolStageAllowance, consumePrivateTextCleanupDeletion, createSkillOptStorageForTests,
  eligibleSkillOptDigests, NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES, SKILLOPT_CONTROLLER_LIMITS,
  createSkillOptController, SkillOptControllerError, validateSkillOptClockSample,
  type SkillOptNativeCampaignArtifactStage, type SkillOptNativeCampaignArtifactStageMetadata,
  type SkillOptNativeCampaignArtifactScheduleEntry, type SkillOptNativeExecutionIdentity, type SkillOptNativeHost,
  type SkillOptReservation,
  type SkillOptNativeCampaignTargetBinding,
  type SkillOptCurrentBinding, type SkillOptDispatchTicket, type SkillOptNativeTrainerMaterializationMetadata,
  type SkillOptClockSample, type SkillOptControllerStatus,
  type SkillOptTestArmedSeed,
  type SkillOptTestReservationInput,
} from "../src/skillopt/controller.ts"
import type { SessionStore } from "../src/sessions/store.ts"
import { createNativeDataset, NATIVE_DATASET_LIMITS, NATIVE_FIXTURE_PACK_SCHEMA, NATIVE_PROTECTED_CHANGES, NATIVE_WIKI_CONTRACT, NATIVE_WIKI_SPLIT_MINIMUMS, NATIVE_WIKI_SPLITS, NATIVE_WIKI_STRATA, NATIVE_PROTOCOL_SHA256, type NativeDataset, type NativeModelBindings, type NativeWikiSplit, type NativeWikiStratum } from "../src/skillopt/dataset.ts"
import { NATIVE_EVALUATION_PROTOCOL_SHA256 } from "../src/skillopt/evaluation.ts"
import { buildNativeCampaignSchedule } from "../src/skillopt/campaign-protocol.ts"
import { canonicalJson, sha256 } from "../src/skillopt/pilot.ts"
import {
  inspectNativeSkillOptTrainerCleanup,
  nativeSkillOptTrainerMaterializationMetadata, NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES,
  planNativeSkillOptTrainerMaterialization,
} from "../src/skillopt/trainer.ts"
import {
  applySkillOptPromotion, assertNativeRollbackAuthorizationCurrent, consumeNativePromotionCanaryHandoff,
  readSkillOptNativeClock, verifyNativePromotionCanaryHandoff, type PromotionBindings,
} from "../src/skillopt/promotion.ts"
import { executionRunDirectory } from "../src/state/store.ts"
import { tempWorktree, type TempWorktree } from "./guards-helpers.ts"
import { withTerminalLine } from "./operator-helpers.ts"
import { makeSkillOptCanaryFixture } from "./skillopt-canary-fixtures.ts"
import { approveSyntheticNativePromotion, createSyntheticPromotionOwner, SYNTHETIC_CANDIDATE_SKILL, syntheticNativeProfileBindings } from "./skillopt-native-load-helpers.ts"

const roots: string[] = []
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")
const bootA = "00000000-0000-0000-0000-000000000001"
const bootB = "00000000-0000-0000-0000-000000000002"
const nativeClockSupported = process.platform === "darwin" || process.platform === "linux"
const childProcessTimeoutMs = 10_000
type SkillOptChildProcess = Bun.Subprocess<"ignore", "pipe", "pipe">
type ReentryWorktree = Pick<TempWorktree, "worktree" | "cleanup">
let nativeClockRoot: string | undefined
let nativeClockPath: string | undefined
let nativeClockSha256: string | undefined
const reentryFixtures: Array<{ worktree: ReentryWorktree; runtime: ExecutionRuntime; owners: SessionStore[] }> = []

const modelBindings: NativeModelBindings = {
  generator: { engine: "codex", requestedModel: "gpt-5-codex", runtimeIdentity: { version: "codex test", executableSha256: "a".repeat(64) }, profileIdentity: { id: "codex-test", sha256: "b".repeat(64) } },
  target: { engine: "claude", requestedModel: "claude-test", runtimeIdentity: { version: "claude test", executableSha256: "c".repeat(64) }, profileIdentity: { id: "claude-test", sha256: "d".repeat(64) } },
  reviewer: { engine: "claude", requestedModel: "claude-review-test", runtimeIdentity: { version: "claude test", executableSha256: "c".repeat(64) }, profileIdentity: { id: "claude-review-test", sha256: "e".repeat(64) } },
}

beforeAll(() => {
  if (!nativeClockSupported) return
  if (process.env.SKILLOPT_POSTSPAWN_CONTROLLER_HARNESS === "enabled") {
    const helperPath = process.env.SKILLOPT_POSTSPAWN_NATIVE_CLOCK_PATH
    const helperSha256 = process.env.SKILLOPT_POSTSPAWN_NATIVE_CLOCK_SHA256
    if (!helperPath || !helperSha256 || hash(readFileSync(helperPath)) !== helperSha256) {
      throw new Error("post-spawn controller harness did not receive the intact parent native-clock helper")
    }
    nativeClockPath = helperPath
    nativeClockSha256 = helperSha256
    return
  }
  nativeClockRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "skillopt-reentry-clock-")))
  chmodSync(nativeClockRoot, 0o700)
  nativeClockPath = join(nativeClockRoot, "skillopt-native")
  const sourcePath = resolve(import.meta.dir, "../src/skillopt/native.c")
  execFileSync(process.env.CC ?? "cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", sourcePath, "-o", nativeClockPath], { stdio: "pipe" })
  chmodSync(nativeClockPath, 0o700)
  nativeClockSha256 = hash(readFileSync(nativeClockPath))
})

afterAll(() => {
  if (nativeClockRoot) rmSync(nativeClockRoot, { recursive: true, force: true })
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const fixture of reentryFixtures.splice(0).reverse()) {
    for (const owner of fixture.owners) {
      if (!owner.isReleased) {
        try { owner.release({ workflowQuiescent: true, evidence: "reentry test completed without execution dispatch", workflowID: null, revision: null }) }
        catch { /* the temporary authority is removed only by its owned fixture cleanup */ }
      }
    }
    fixture.worktree.cleanup()
  }
})

function makeClock(bootId = bootA) {
  let boot = bootId
  let continuous = 5_000_000_000n
  let wall = 1_700_000_000_000n
  return {
    sample: (): SkillOptClockSample => ({
      protocol: "skillopt-promotion.v3", platform: "darwin", bootId: boot,
      continuousNanoseconds: continuous.toString(), wallMilliseconds: wall.toString(),
    }),
    advance(milliseconds: number) {
      const elapsed = BigInt(milliseconds)
      continuous += elapsed * 1_000_000n
      wall += elapsed
    },
    stepMonotonic(nanoseconds: bigint) { continuous += nanoseconds },
    stepWall(milliseconds: number) { wall += BigInt(milliseconds) },
    reboot(nextBoot = bootB) { boot = nextBoot; continuous = 1_000n; wall += 2_000n },
  }
}

function storage(clock: ReturnType<typeof makeClock> = makeClock()) {
  const root = mkdtempSync(join(tmpdir(), "skillopt-controller-test-"))
  chmodSync(root, 0o700)
  roots.push(root)
  const databasePath = join(root, "automation", "ledger.sqlite")
  const store = createSkillOptStorageForTests({ databasePath, worktreeRoot: root, clock: clock.sample })
  return { root, databasePath, store, clock }
}

function retainTestRoot(root: string): void {
  const index = roots.indexOf(root)
  if (index >= 0) roots.splice(index, 1)
}

function armedSeed(runId = randomUUID(), overrides: Partial<SkillOptTestArmedSeed> = {}): SkillOptTestArmedSeed {
  return { runId, bindingHash: "b".repeat(64), consentId: randomUUID(), armId: randomUUID(), expectedRevision: 2, ...overrides }
}

function reserveInput(seed: SkillOptTestArmedSeed, overrides: Partial<SkillOptTestReservationInput> = {}): SkillOptTestReservationInput {
  return {
    runId: seed.runId, consentId: seed.consentId, armId: seed.armId, bindingHash: seed.bindingHash,
    newDigestHashes: Array.from({ length: 5 }, (_, index) => hash(`fresh-session-${index}`)),
    expectedRevision: seed.expectedRevision ?? 2, ...overrides,
  }
}

async function waitForOwnedFiles(paths: readonly string[], description: string, timeoutMs = childProcessTimeoutMs): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (paths.some((path) => !existsSync(path))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
}

async function withChildTimeout<T>(promise: Promise<T>, description: string, timeoutMs = childProcessTimeoutMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function stopOwnedChild(child: SkillOptChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  try {
    await withChildTimeout(child.exited, "owned child process to stop", 1_000)
  } catch {
    child.kill("SIGKILL")
    await withChildTimeout(child.exited, "owned child process to stop after SIGKILL", 1_000)
  }
}

function processOrGroupExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw error
  }
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processOrGroupExists(-processGroupId)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  return true
}

async function stopOwnedProcessGroup(processGroupId: number): Promise<void> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 2 || processGroupId === process.pid) {
    throw new Error("refusing to signal an invalid or non-owned process group")
  }
  if (!processOrGroupExists(-processGroupId)) return
  try { process.kill(-processGroupId, "SIGTERM") }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "ESRCH") return
    throw error
  }
  if (await waitForProcessGroupExit(processGroupId, 1_000)) return
  try { process.kill(-processGroupId, "SIGKILL") }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "ESRCH") return
    throw error
  }
  if (!await waitForProcessGroupExit(processGroupId, 2_000)) {
    throw new Error(`owned process group ${processGroupId} did not exit after SIGKILL`)
  }
}

function digest(sessionID: string, overrides: Partial<SessionDigest> = {}): SessionDigest {
  return {
    schemaVersion: 1, kind: "session-digest", sessionID, engine: "local", model: null, routes: {},
    startedAt: 1, endedAt: 2, turns: 1, tools: {}, decisions: {}, files: ["knowledge/topic.md"],
    commands: [], workflows: [], outcome: "completed", complete: true, ...overrides,
  }
}

const baselineBytes = Buffer.from("# llm-wiki\n\nSynthetic protected baseline.\n", "utf8")

function makeNativeFixture(split: NativeWikiSplit, index: number, stratum: NativeWikiStratum) {
  const id = `${split}-${index}`
  const sourceId = `source-${id}`
  const slotId = `slot-${id}`
  const indexSlotId = `index-${id}`
  const leftId = `fact-${id}-left`
  const rightId = `fact-${id}-right`
  const leftStatement = `Supported fact A for ${id}.`
  const rightStatement = `Supported fact B for ${id}.`
  const sourceContent = `${leftStatement}\n${rightStatement}\n`
  const escape = (value: string) => value.replace(/[\\`*_[\]{}()<>#+.!|~-]/g, "\\$&").replace(/[\r\n]/g, " ")
  const line = (statement: string) => `- ${escape(statement)} ([${escape(sourceId)}](../sources/documents-${sha256(sourceContent)}.md))`
  const existingContent = stratum === "dedup-resume"
    ? `${line(leftStatement)}\n`
    : stratum === "ownership-injection"
      ? `${line(leftStatement)}\n${line(rightStatement)}\n`
      : ""
  const needsIndex = existingContent.length === 0
  return {
    id, familyId: `family-${id}`, lineage: [`lineage-${id}`], split, stratum, authorship: "agent-authored" as const,
    sources: [{ id: sourceId, provenance: "raw" as const, content: sourceContent, sha256: sha256(sourceContent) }],
    task: `Prepare a bounded wiki update for [[slot:${slotId}]] using only its cited evidence.${needsIndex ? ` Update [[slot:${indexSlotId}]].` : ""}`,
    outputSlots: [
      { id: slotId, kind: "page" as const, existingContent },
      ...(needsIndex ? [{ id: indexSlotId, kind: "index" as const, existingContent: "# Synthetic wiki index\n" }] : []),
    ],
    assertions: {
      facts: [
        { id: leftId, slotId, statement: leftStatement, sourceIds: [sourceId] },
        { id: rightId, slotId, statement: rightStatement, sourceIds: [sourceId] },
      ],
      citations: [{ factId: leftId, sourceId }, { factId: rightId, sourceId }],
      contradictions: stratum === "correction-conflict" ? [{ leftFactId: leftId, rightFactId: rightId, expected: "mark-unknown" as const }] : [],
      deduplication: stratum === "dedup-resume" ? [{ slotId, expected: "reuse-existing" as const }] : [],
      ownership: [
        ...(stratum === "ownership-injection" ? [{ slotId, expected: "preserve-existing" as const }] : []),
        ...(needsIndex ? [{ slotId: indexSlotId, expected: "append-only" as const }] : []),
      ],
    },
    forbiddenChanges: [...NATIVE_PROTECTED_CHANGES],
  }
}

function makeNativePack() {
  const fixtures: ReturnType<typeof makeNativeFixture>[] = []
  for (const split of NATIVE_WIKI_SPLITS) {
    for (let index = 0; index < NATIVE_WIKI_SPLIT_MINIMUMS[split]; index += 1) {
      fixtures.push(makeNativeFixture(split, index, NATIVE_WIKI_STRATA[index % NATIVE_WIKI_STRATA.length]!))
    }
  }
  return { schema: NATIVE_FIXTURE_PACK_SCHEMA, contract: NATIVE_WIKI_CONTRACT, fixtures }
}

function installSyntheticNativeClock(root: string, initial: SkillOptClockSample) {
  const helperRoot = realpathSync.native(root)
  const helperPath = join(helperRoot, `synthetic-clock-${randomUUID()}.sh`)
  const samplePath = join(helperRoot, `synthetic-clock-${randomUUID()}.json`)
  const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const protocolLine = JSON.stringify({ protocol: "skillopt-promotion.v3", platform: initial.platform })
  const helper = `#!/bin/sh
if [ "$#" -ne 1 ]; then exit 2; fi
case "$1" in
  protocol) printf '%s\\n' '${protocolLine}' ;;
  clock) exec /bin/cat ${quoteShell(samplePath)} ;;
  *) exit 2 ;;
esac
`
  const writeSample = (sample: SkillOptClockSample) => writeFileSync(samplePath, `${JSON.stringify(sample)}\n`, { mode: 0o600 })
  writeSample(initial)
  writeFileSync(helperPath, helper, { mode: 0o700, flag: "wx" })
  chmodSync(helperPath, 0o700)
  return {
    helper: { nativeHelperPath: helperPath, nativeHelperSha256: hash(readFileSync(helperPath)) },
    setSample(sample: SkillOptClockSample) {
      if (sample.platform !== initial.platform || sample.protocol !== "skillopt-promotion.v3") throw new Error("synthetic clock protocol changed")
      writeSample(sample)
    },
  }
}

function limitLedgerConnectionPageCount(databasePath: string) {
  // Bound the actual controller connection through SQLite; this never exhausts or simulates host filesystem space.
  type Exec = (this: Database, sql: string) => unknown
  type Query = (this: Database, sql: string) => Statement
  type StatementRun = (this: Statement, ...params: any[]) => unknown
  const targetDatabasePath = realpathSync.native(databasePath)
  const prototype = Database.prototype as unknown as { exec: Exec; query: Query }
  const originalExec = prototype.exec
  const originalQuery = prototype.query
  const limitedDatabases = new WeakSet<Database>()
  const wrappedStatements = new Map<Statement, PropertyDescriptor | undefined>()
  let limitedConnections = 0
  const sqliteFullErrors: Array<{ code: string; errno: number; statement: string }> = []
  prototype.query = function (this: Database, sql: string): Statement {
    const statement = originalQuery.call(this, sql)
    if (!limitedDatabases.has(this) || wrappedStatements.has(statement)) return statement
    const originalDescriptor = Object.getOwnPropertyDescriptor(statement, "run")
    const originalRun = (originalDescriptor?.value ?? statement.run) as StatementRun
    if (typeof originalRun !== "function" || (originalDescriptor && !originalDescriptor.configurable)) {
      throw new Error("SQLite pressure instrumentation cannot wrap this statement instance")
    }
    Object.defineProperty(statement, "run", {
      configurable: true,
      enumerable: originalDescriptor?.enumerable ?? false,
      writable: true,
      value: function (this: Statement, ...params: any[]): unknown {
        try { return originalRun.call(this, ...params) } catch (error) {
          if (error instanceof SQLiteError && error.code === "SQLITE_FULL") {
            sqliteFullErrors.push({ code: error.code, errno: error.errno, statement: this.toString() })
          }
          throw error
        }
      },
    })
    wrappedStatements.set(statement, originalDescriptor)
    return statement
  }
  prototype.exec = function (this: Database, sql: string): unknown {
    const result = originalExec.call(this, sql)
    if (sql !== "PRAGMA secure_delete = ON") return result
    const main = (this.query("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main")
    if (!main || realpathSync.native(main.file) !== targetDatabasePath) return result
    if (!this.query("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name LIKE 'force_sqlite_full_%' LIMIT 1").get()) return result
    limitedDatabases.add(this)
    const pageRow = this.query("PRAGMA page_count").get() as Record<string, unknown> | undefined
    const pageCount = Number(pageRow && Object.values(pageRow)[0])
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error("SQLite page count is invalid")
    const limit = pageCount + 1
    originalExec.call(this, `PRAGMA max_page_count = ${limit}`)
    const limitRow = this.query("PRAGMA max_page_count").get() as Record<string, unknown> | undefined
    if (Number(limitRow && Object.values(limitRow)[0]) !== limit) throw new Error("SQLite page limit was not applied")
    limitedConnections += 1
    return result
  }
  return {
    get limitedConnections() { return limitedConnections },
    get sqliteFullErrors() { return sqliteFullErrors },
    restore() {
      prototype.exec = originalExec
      prototype.query = originalQuery
      for (const [statement, descriptor] of wrappedStatements) {
        if (descriptor) Object.defineProperty(statement, "run", descriptor)
        else Reflect.deleteProperty(statement, "run")
      }
      wrappedStatements.clear()
    },
  }
}

function createSQLiteFullPressureTrigger(database: Database, name: string, event: string) {
  const values = Array.from({ length: 32 }, (_, index) =>
    `('sqlite-full-pressure-${name}-${index}',hex(zeroblob(65536)))`).join(",")
  database.exec(`CREATE TRIGGER ${name} ${event} BEGIN INSERT INTO meta(name,value) VALUES ${values}; END`)
  database.exec("VACUUM")
}

async function reentryFixture(
  state: "PREPARED" | "CONSENTED" | "ARMED" = "ARMED",
  syntheticClockSample?: SkillOptClockSample,
  options: { worktree?: ReentryWorktree; sessionID?: string } = {},
) {
  if (!syntheticClockSample && (!nativeClockPath || !nativeClockSha256)) throw new Error("native clock test fixture is unavailable")
  const worktree = options.worktree ?? tempWorktree()
  const fixture = { worktree, runtime: undefined as unknown as ExecutionRuntime, owners: [] as SessionStore[] }
  reentryFixtures.push(fixture)
  const root = worktree.worktree
  const syntheticClock = syntheticClockSample ? installSyntheticNativeClock(root, syntheticClockSample) : undefined
  const skillPath = join(root, ".agents", "skills", "llm-wiki", "SKILL.md")
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, baselineBytes, { mode: 0o600 })
  const source = Buffer.from("Synthetic approved source excerpt for the reentry fixture.\n", "utf8")
  const sourcePath = `knowledge/raw/documents/${sha256(source)}.md`
  const absoluteSource = join(root, sourcePath)
  mkdirSync(dirname(absoluteSource), { recursive: true, mode: 0o700 })
  writeFileSync(absoluteSource, source, { mode: 0o600 })
  const dataset = createNativeDataset({ root, selections: [{ path: sourcePath }], fixturePack: makeNativePack(), modelBindings })
  if (dataset.status !== "STRUCTURALLY_VALID") throw new Error("synthetic reentry dataset is not structurally valid")
  const host: ExecutionHost = {
    identity: { engine: "codex", profile: "legacy-unowned" },
    async preflight() { return { compatible: true, controls: {}, problems: [] } },
    async prepare(_request: ExecutionRequest) { throw new Error("reentry tests must not invoke a model host") },
    async reconcile(): Promise<ExecutionReconciliation> { return { outcome: "unknown", quiescent: false, evidence: "no host recovery was requested" } },
  }
  const runtime = createExecutionRuntime({ directory: root, worktree: root, config: structuredClone(DEFAULT_CONFIG), log() {} }, () => host, { planningOnlyMain: true })
  fixture.runtime = runtime
  const owner = attachAdmission(runtime, options.sessionID ?? `session_${randomUUID().replaceAll("-", "")}`, {
    engine: "codex", model: modelBindings.generator.requestedModel,
  })
  fixture.owners.push(owner)
  const nativeIdentities = new Map<string, SkillOptNativeExecutionIdentity>()
  const nativeHost: SkillOptNativeHost = {
    consumeCompletedTargetWitness() { throw new Error("synthetic native host cannot verify completed-target witnesses") },
    consumeCompletedOptimizerWitness() { throw new Error("synthetic native host cannot verify completed-optimizer witnesses") },
    identityFor(reference) { return nativeIdentities.get(reference.executionID) },
    async reconcile(reference) {
      return nativeIdentities.has(reference.executionID)
        ? { outcome: "terminal", quiescent: true, evidence: "synthetic request completed and quiesced" }
        : { outcome: "unknown", quiescent: false, evidence: "no native request was made" }
    },
  }
  const controller = createSkillOptController(runtime, syntheticClock?.helper ?? {
    nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256!,
  }, nativeHost)
  controller.initialize()
  const current = { dataset, baselineSkillSha256: sha256(baselineBytes) }
  const prepared = controller.prepare({ owner, campaignId: `campaign_${randomUUID().replaceAll("-", "")}`, ...current })
  if (prepared.state !== "PREPARED") throw new Error("reentry fixture campaign was not prepared")
  let consent: ReturnType<typeof controller.consent> | undefined
  let arm: ReturnType<typeof controller.arm> | undefined
  if (state !== "PREPARED") {
    const receipt = await withTerminalLine(`APPROVE ${prepared.runId} ${prepared.consentBindingSha256}`, () =>
      humanDecision("approve", prepared.decisionBinding))
    consent = controller.consent(prepared, receipt, current)
  }
  if (state === "ARMED") arm = controller.arm(prepared, consent!, current)
  return { fixture, root, runtime, owner, controller, current, dataset, prepared, consent, arm, nativeHost, nativeIdentities, syntheticClock }
}

function trainerMaterialization(fixture: Awaited<ReturnType<typeof reentryFixture>>) {
  const worktree = realpathSync.native(fixture.root)
  const runtime = {
    executablePath: join(worktree, "skillopt", "runtime", "fa4ca184573e42ec11472959dd57422381418096", "venv", "bin", "python"),
    nativeRuntimeProofPath: join(worktree, "skillopt", "runtime", "fa4ca184573e42ec11472959dd57422381418096", "native-runtime-proof.json"),
  }
  const plan = planNativeSkillOptTrainerMaterialization({ worktree, runtime,
    dataset: fixture.dataset, prepared: fixture.prepared, baselineSkillBytes: baselineBytes })
  return { runtime, plan, materialization: nativeSkillOptTrainerMaterializationMetadata(plan) }
}

function nativeCampaignArtifactMetadata(
  fixture: Awaited<ReturnType<typeof reentryFixture>>,
  stage: SkillOptNativeCampaignArtifactStage,
  entryKind: "training" | "trainerSelection" | "qualification" = "training",
): SkillOptNativeCampaignArtifactStageMetadata {
  const schedule = buildNativeCampaignSchedule(fixture.dataset.fixturePack)
  let fixtureId = fixture.dataset.fixturePack.fixtures[0]!.id
  let scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry | null = null
  if (stage !== "fixture-preflight") {
    if (entryKind === "training") {
      const entry = schedule.training[0]!
      fixtureId = entry.caseId
      scheduleEntry = { kind: "training", ...entry }
    } else if (entryKind === "trainerSelection") {
      const entry = schedule.trainerSelection[0]!
      fixtureId = entry.caseId
      scheduleEntry = { kind: "trainerSelection", ...entry }
    } else {
      const entry = schedule.qualification.find(item => item.variant === "baseline")!
      fixtureId = entry.fixtureId
      scheduleEntry = { kind: "qualification", ...entry }
    }
  }
  const responseSha256 = stage === "adapter-response" || stage === "trainer-rollout-ipc"
    ? hash(Buffer.from("synthetic native campaign response", "utf8")) : null
  return {
    schema: "skillopt.native-campaign-artifact-stage.v1", stage, runId: fixture.prepared.runId,
    rootBinding: hash(`root:${realpathSync.native(fixture.root)}`), bindingSha256: fixture.prepared.bindingSha256,
    scheduleSha256: schedule.scheduleSha256, fixtureId, scheduleEntry, responseSha256,
    planSha256: hash(`plan:${stage}:${fixtureId}`), bytes: 271,
  }
}

function nativeCampaignTargetPlan(
  fixture: Awaited<ReturnType<typeof reentryFixture>>,
  metadata: SkillOptNativeCampaignArtifactStageMetadata,
) {
  if (!metadata.scheduleEntry) throw new Error("target plan requires a scheduled fixture entry")
  return fixture.controller.prepareNativeCampaignTarget({ owner: fixture.owner, runtime: fixture.runtime,
    prepared: fixture.prepared, current: fixture.current, scheduleEntry: metadata.scheduleEntry })
}

async function makeRunningNativeFixture(
  fixture: Awaited<ReturnType<typeof reentryFixture>>,
  afterReserve?: (reservation: SkillOptReservation) => void,
  beforeRecovery?: (reservation: SkillOptReservation) => void,
  dispatchState: "launched" | "ambiguous" = "launched",
  persistReference = true,
) {
  if (!fixture.consent) throw new Error("running fixture lacks consent")
  const reservation = fixture.controller.reserveManual({ owner: fixture.owner, prepared: fixture.prepared,
    consent: fixture.consent, current: fixture.current })
  afterReserve?.(reservation)
  const grant = fixture.controller.consumeDispatch(fixture.owner, reservation.ticket, fixture.current)
  const claim = fixture.runtime.runs.claim(fixture.owner.sessionID, fixture.runtime.instance, process.pid)
  const identity: SkillOptNativeExecutionIdentity = Object.freeze({
    engine: fixture.dataset.modelBindings.target.engine, profile: "legacy-unowned",
    controlProfile: "estimated-input-reactive-output-v1", policyID: `skillopt-native-v1:${hash("synthetic native controller test policy")}`,
    role: grant.role, phase: grant.phase,
  })
  fixture.nativeIdentities.set(grant.requestId, identity)
  fixture.runtime.runs.registerIntent(claim, {
    executionId: grant.requestId, ownerSession: fixture.owner.sessionID,
    taskId: `skillopt:${grant.role}:${grant.phase}:${grant.requestId}`, attemptId: randomUUID(),
    generation: claim.generation, role: grant.role, cwd: fixture.runtime.worktree, policyID: identity.policyID,
    kind: "host", engine: identity.engine, profile: identity.profile, controlProfile: identity.controlProfile, nativeExecution: true,
  })
  const reference = Object.freeze({ executionID: grant.requestId })
  fixture.runtime.runs.bindNativeExecutionRef(claim, grant.requestId)
  fixture.runtime.runs.markHostDispatched(claim, grant.requestId)
  fixture.controller.recordDispatch(fixture.owner, reservation.receipt, dispatchState === "launched"
    ? { state: "launched", reference }
    : { state: "ambiguous", ...(persistReference ? { reference } : {}) })
  const terminalAt = Date.now()
  fixture.runtime.runs.recordTerminal(claim, grant.requestId, { outcome: "completed", terminalAt, quiescentAt: terminalAt })
  fixture.runtime.runs.reconcile(claim, grant.requestId, {
    outcome: "terminal", quiescent: true, evidence: "synthetic native request completed and quiesced",
  })
  fixture.runtime.runs.assertQuiescent(claim)
  fixture.runtime.runs.release(claim)
  beforeRecovery?.(reservation)
  const status = await fixture.controller.recover(fixture.owner, fixture.prepared.runId)
  if (status.state !== "RUNNING") throw new Error("genuine controller dispatch did not reach RUNNING")
  return reservation
}

async function prepareOwnedChildRecovery(
  fixture: Awaited<ReturnType<typeof reentryFixture>>,
  beforeRecovery?: (reservation: SkillOptReservation) => void,
) {
  if (!fixture.consent) throw new Error("owned child recovery fixture lacks consent")
  const reservation = fixture.controller.reserveManual({ owner: fixture.owner, prepared: fixture.prepared,
    consent: fixture.consent, current: fixture.current })
  const grant = fixture.controller.consumeDispatch(fixture.owner, reservation.ticket, fixture.current)
  const startPath = join(fixture.root, `recovery-child-${randomUUID()}`)
  const childScript = `const { renameSync, writeFileSync } = require("node:fs");
const target = process.env.SKILLOPT_CHILD_STARTED;
const pending = target + ".pending";
writeFileSync(pending, String(process.pid), { mode: 0o600, flag: "wx" });
renameSync(pending, target);
setTimeout(() => process.exit(0), 250);`
  let child: SkillOptChildProcess | undefined
  let claim: ReturnType<ExecutionRuntime["runs"]["claim"]> | undefined
  try {
    child = Bun.spawn([process.execPath, "--no-env-file", "-e", childScript], {
      cwd: fixture.root,
      env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), HOME: join(fixture.root, "owned-child-home"), SKILLOPT_CHILD_STARTED: startPath },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const runningChild = child
    if (!runningChild) throw new Error("owned recovery child handle was not retained")
    await waitForOwnedFiles([startPath], "controller recovery child launch")
    const childPid = Number(readFileSync(startPath, "utf8"))
    if (runningChild.pid !== childPid) throw new Error("owned recovery child identity changed")
    claim = fixture.runtime.runs.claim(fixture.owner.sessionID, fixture.runtime.instance, childPid)
    const identity: SkillOptNativeExecutionIdentity = Object.freeze({
      engine: fixture.dataset.modelBindings.target.engine, profile: "legacy-unowned",
      controlProfile: "estimated-input-reactive-output-v1", policyID: `skillopt-native-v1:${hash("owned recovery child policy")}`,
      role: grant.role, phase: grant.phase,
    })
    fixture.nativeIdentities.set(grant.requestId, identity)
    fixture.runtime.runs.registerIntent(claim, {
      executionId: grant.requestId, ownerSession: fixture.owner.sessionID,
      taskId: `skillopt:${grant.role}:${grant.phase}:${grant.requestId}`, attemptId: randomUUID(),
      generation: claim.generation, role: grant.role, cwd: fixture.runtime.worktree, policyID: identity.policyID,
      kind: "host", engine: identity.engine, profile: identity.profile,
      controlProfile: identity.controlProfile, nativeExecution: true,
    })
    fixture.runtime.runs.bindNativeExecutionRef(claim, grant.requestId)
    fixture.runtime.runs.markHostDispatched(claim, grant.requestId)

    const beforeExit = new Database(reentryDatabase(fixture.root))
    let createdCont: string | undefined
    let reservationAnchor: { last_attempt_boot: string | null; last_attempt_cont: string | null } | undefined
    try {
      const quota = beforeExit.query("SELECT active_run_id,pending_request_id,last_attempt_boot,last_attempt_cont FROM quota WHERE singleton=1")
        .get() as { active_run_id: string | null; pending_request_id: string | null; last_attempt_boot: string | null; last_attempt_cont: string | null }
      if (quota.active_run_id !== fixture.prepared.runId || quota.pending_request_id !== grant.requestId) {
        throw new Error("owned child reservation did not retain the active and pending slots")
      }
      reservationAnchor = { last_attempt_boot: quota.last_attempt_boot, last_attempt_cont: quota.last_attempt_cont }
      const request = beforeExit.query("SELECT dispatch_state,actual_dispatch,reference_json,created_cont,active_reserved_ms FROM requests WHERE request_id=?")
        .get(grant.requestId) as { dispatch_state: string; actual_dispatch: number | null; reference_json: string | null; created_cont: string; active_reserved_ms: number }
      if (request.dispatch_state !== "possible" || request.actual_dispatch !== null || request.reference_json !== null ||
          request.active_reserved_ms !== SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds) {
        throw new Error("owned child was acknowledged before controller recovery")
      }
      createdCont = request.created_cont
    } finally { beforeExit.close() }
    const unresolved = fixture.controller.status()
    if (unresolved.requestCounts.charged.target !== 1 || unresolved.requestCounts.dispatched.target !== 0 ||
        unresolved.requestCounts.unknown.target !== 1 || !unresolved.pendingDispatch) {
      throw new Error("owned child did not remain charged and unknown before recovery")
    }

    const exitCode = await withChildTimeout(runningChild.exited, "owned recovery child exit", 5_000)
    if (exitCode !== 0) throw new Error("owned recovery child did not exit cleanly")
    const terminalAt = Date.now()
    fixture.runtime.runs.recordTerminal(claim, grant.requestId, { outcome: "completed", terminalAt, quiescentAt: terminalAt })
    fixture.runtime.runs.reconcile(claim, grant.requestId, {
      outcome: "terminal", quiescent: true, evidence: "owned harmless child exited and reached quiescence",
    })
    fixture.runtime.runs.assertQuiescent(claim)
    fixture.runtime.runs.release(claim)
    claim = undefined
    beforeRecovery?.(reservation)
    const observedBeforeRecovery = readSkillOptNativeClock({ nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! })
    if (!createdCont || !reservationAnchor) throw new Error("owned recovery child lost its durable reservation clock")
    return { reservation, observedBeforeRecovery, createdCont, reservationAnchor }
  } finally {
    if (child && child.exitCode === null) await stopOwnedChild(child)
    if (claim && child?.exitCode !== null) {
      const terminalAt = Date.now()
      try {
        fixture.runtime.runs.recordTerminal(claim, grant.requestId, { outcome: "completed", terminalAt, quiescentAt: terminalAt })
        fixture.runtime.runs.reconcile(claim, grant.requestId, { outcome: "terminal", quiescent: true, evidence: "test child cleanup completed" })
        fixture.runtime.runs.assertQuiescent(claim)
        fixture.runtime.runs.release(claim)
      } catch { /* fixture cleanup removes the isolated runtime after the assertion failure */ }
    }
  }
}

async function makeGenuinePromotionHandoff(root: string, runId: string, dataset: NativeDataset, projectRootInput?: string) {
  if (!nativeClockPath || !nativeClockSha256) throw new Error("native promotion test helper is unavailable")
  const projectRoot = projectRootInput ? realpathSync.native(projectRootInput) : join(realpathSync.native(root), ".genuine-promotion-handoff")
  const targetDirectory = join(projectRoot, ".agents", "skills", "llm-wiki")
  const transactionRoot = join(projectRoot, ".skillopt-promotion")
  const evidenceDirectory = join(projectRoot, ".skillopt-evidence")
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 })
  mkdirSync(transactionRoot, { mode: 0o700 })
  mkdirSync(evidenceDirectory, { mode: 0o700 })
  for (const directory of [projectRoot, join(projectRoot, ".agents"), join(projectRoot, ".agents", "skills"),
    targetDirectory, transactionRoot, evidenceDirectory]) chmodSync(directory, 0o700)
  const targetPath = join(targetDirectory, "SKILL.md")
  const originalBytes = projectRootInput
    ? readFileSync(targetPath)
    : Buffer.from("# isolated native promotion baseline\n")
  const candidateBytes = Buffer.from(SYNTHETIC_CANDIDATE_SKILL, "utf8")
  writeFileSync(targetPath, originalBytes, { mode: 0o600 })
  const fixture = makeSkillOptCanaryFixture()
  const targetModel = dataset.modelBindings.target
  const bindings: PromotionBindings = {
    witnessMode: "native", runId, rootBinding: sha256(`root:${projectRoot}`),
    sourceSha256: dataset.sourceExportSha256, originalSha256: sha256(originalBytes), candidateSha256: sha256(candidateBytes),
    fixturePackSha256: fixture.packSha256, canaryFixtureSha256: fixture.fixtureSha256,
    protocolSha256: NATIVE_PROTOCOL_SHA256, evaluatorSha256: NATIVE_EVALUATION_PROTOCOL_SHA256,
    runtimeSha256: sha256("synthetic promotion runtime"), resultsSha256: sha256("synthetic promotion results"),
    witnessSha256: hash("synthetic pre-apply witness"),
    ...(projectRootInput ? {
      nativeEngine: targetModel.engine,
      nativeModel: targetModel.requestedModel,
      nativeProfileId: targetModel.profileIdentity.id,
      nativeProfileSha256: targetModel.profileIdentity.sha256,
      nativeRuntimeVersion: targetModel.runtimeIdentity.version,
      nativeExecutableSha256: targetModel.runtimeIdentity.executableSha256,
    } : syntheticNativeProfileBindings()),
  }
  const writeEvidence = (name: string, value: unknown): { path: string; sha256: string } => {
    const path = join(evidenceDirectory, name)
    const bytes = Buffer.from(JSON.stringify(value), "utf8")
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" })
    chmodSync(path, 0o600)
    return { path: resolve(path), sha256: sha256(bytes) }
  }
  const qualification = writeEvidence("qualification.json", { schemaVersion: 1, bindings, decision: "qualified", reasons: [] })
  const semanticReview = ["final", "safety"].map((phase) => ({
    phase,
    status: "valid",
    promptSha256: hash(`${phase}:review-prompt`),
    responseSha256: hash(`${phase}:review-response`),
    assessment: "clear",
    findings: [],
  }))
  const review = writeEvidence("review.json", { schemaVersion: 1, bindings, qualificationSha256: qualification.sha256,
    reviewerId: "independent-reviewer", verdict: "approve", semanticReview })
  const semanticReviewSha256 = hash(canonicalJson(semanticReview))
  if (review.sha256 === semanticReviewSha256) throw new Error("synthetic review wrapper digest unexpectedly equals semantic review digest")
  const common = { targetPath, transactionRoot, nativeHelperPath: nativeClockPath, nativeHelperSha256: nativeClockSha256, bindings }
  const promotionOwner = createSyntheticPromotionOwner(projectRoot)
  try {
    const approval = await approveSyntheticNativePromotion({
      common, owner: promotionOwner.store, operation: "apply",
      runDeadlineAt: Date.now() + 10 * 60_000, candidateBytes, evidence: { qualification, review },
    })
    const evidence = approval.evidence
    if (!evidence) throw new Error("native apply authorization did not return its bound evidence")
    await applySkillOptPromotion({ ...common, candidateBytes, evidence, nativeAuthorization: approval.authorization,
      async verifyEvidence() {
        for (const reference of [qualification, review, evidence.approval]) {
          if (sha256(readFileSync(reference.path)) !== reference.sha256) throw new Error("promotion evidence changed")
        }
      },
    })
    return {
      handoff: await verifyNativePromotionCanaryHandoff({ ...common, evidence }),
      semanticReviewSha256,
      reviewArtifactSha256: review.sha256,
      common,
      evidence,
    }
  } finally {
    await promotionOwner.close()
  }
}

function approveReentry(binding: DecisionBinding): Promise<OperatorDecision> {
  return withTerminalLine(`APPROVE ${binding.workflowID} ${binding.subject.sha256}`, () => humanDecision("approve", binding))
}

function addFreshDigests(root: string): void {
  const directory = digestDirectory(root)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (let index = 0; index < 5; index += 1) {
    const sessionID = `reentry_train_${index}_${randomUUID().replaceAll("-", "")}`
    writeFileSync(join(directory, `${sessionID}.json`), JSON.stringify(digest(sessionID, {
      engine: "codex", model: modelBindings.generator.requestedModel, endedAt: Date.now() + 10_000 + index,
    })), { mode: 0o600 })
  }
}

function reattachOwner(runtime: ExecutionRuntime, owners: SessionStore[]): SessionStore {
  const owner = attachAdmission(runtime, `session_${randomUUID().replaceAll("-", "")}`, {
    engine: "codex", model: modelBindings.generator.requestedModel,
  })
  owners.push(owner)
  return owner
}

function releaseOwner(owner: SessionStore): void {
  if (!owner.isReleased) owner.release({
    workflowQuiescent: true, evidence: "reentry fixture has no execution or workflow activity", workflowID: null, revision: null,
  })
}

function reentryDatabase(root: string): string {
  return join(dirname(executionRunDirectory(root)), "skillopt", "automation", "ledger.sqlite")
}

function seedQualifiedRunningLedger(root: string, runId: string): void {
  if (!nativeClockPath || !nativeClockSha256) throw new Error("native clock test fixture is unavailable")
  const clockSample = readSkillOptNativeClock({ nativeHelperPath: nativeClockPath, nativeHelperSha256: nativeClockSha256 })
  const db = new Database(reentryDatabase(root))
  try {
    db.exec("BEGIN IMMEDIATE")
    const run = db.query(`SELECT owner_session_hash,owner_epoch_hash,binding_hash FROM runs WHERE run_id=?`).get(runId) as {
      owner_session_hash: string; owner_epoch_hash: string; binding_hash: string
    } | undefined
    if (!run) throw new Error("qualified campaign fixture run is missing")
    db.query(`UPDATE runs SET state='RUNNING',revision=revision+1,active_ms=60000,artifact_bytes=4096,candidate_steps=1
      WHERE run_id=?`).run(runId)
    db.query(`UPDATE usage SET target_requests=432,optimizer_requests=1,reviewer_requests=2,final_safety_requests=216,
      canary_requests=0,active_ms=60000,active_reserved_ms=0,artifact_bytes=4096,candidate_steps=1 WHERE run_id=?`).run(runId)
    db.query(`UPDATE quota SET active_run_id=?,active_owner_session_hash=?,active_owner_epoch_hash=?,pending_request_id=NULL,
      last_attempt_id=?,last_attempt_boot=?,last_attempt_cont=?,fence_boot=?,fence_cont=? WHERE singleton=1`)
      .run(runId, run.owner_session_hash, run.owner_epoch_hash, randomUUID(), clockSample.bootId,
        clockSample.continuousNanoseconds, clockSample.bootId, clockSample.continuousNanoseconds)
    const insertRequest = db.query(`INSERT INTO requests(request_id,run_id,reservation_id,role,phase,binding_hash,owner_epoch_hash,
      charged,actual_dispatch,dispatch_state,created_boot,created_cont,created_wall,finished_boot,finished_cont,terminal_class,active_reserved_ms)
      VALUES(?,?,?,?,?,?,?,1,1,'settled',?,?,?,?,?,'completed',0)`)
    for (let index = 0; index < 432; index += 1) {
      const phase = index < 216 ? index % 2 === 0 ? "train" : "dev" : index % 2 === 0 ? "final" : "safety"
      insertRequest.run(randomUUID(), runId, randomUUID(), "target", phase, run.binding_hash, run.owner_epoch_hash,
        clockSample.bootId, clockSample.continuousNanoseconds, clockSample.wallMilliseconds,
        clockSample.bootId, clockSample.continuousNanoseconds)
    }
    for (const [role, phase] of [["optimizer", "train"], ["reviewer", "final"], ["reviewer", "safety"]] as const) {
      insertRequest.run(randomUUID(), runId, randomUUID(), role, phase, run.binding_hash, run.owner_epoch_hash,
        clockSample.bootId, clockSample.continuousNanoseconds, clockSample.wallMilliseconds,
        clockSample.bootId, clockSample.continuousNanoseconds)
    }
    db.exec("COMMIT")
  } catch (error) {
    try { db.exec("ROLLBACK") } catch { /* Preserve the fixture setup failure. */ }
    throw error
  } finally { db.close() }
}

function expirePrivateTextRun(root: string, runId: string, boot = nativeClockPath && nativeClockSha256
  ? readSkillOptNativeClock({ nativeHelperPath: nativeClockPath, nativeHelperSha256: nativeClockSha256 }).bootId
  : bootB): void {
  if (!nativeClockPath || !nativeClockSha256) throw new Error("native clock test fixture is unavailable")
  const sample = readSkillOptNativeClock({ nativeHelperPath: nativeClockPath, nativeHelperSha256: nativeClockSha256 })
  const expiryContinuous = (BigInt(sample.continuousNanoseconds) - 1n).toString()
  const expiryWall = (BigInt(sample.wallMilliseconds) - 1n).toString()
  const db = new Database(reentryDatabase(root))
  try {
    db.exec("BEGIN IMMEDIATE")
    const updated = db.query("UPDATE runs SET expires_boot=?,expires_cont=?,expires_wall=? WHERE run_id=?")
      .run(boot, expiryContinuous, expiryWall, runId)
    if (updated.changes !== 1) throw new Error("cleanup expiry fixture run is missing")
    db.query("UPDATE consents SET expires_boot=?,expires_cont=?,expires_wall=? WHERE run_id=?")
      .run(boot, expiryContinuous, expiryWall, runId)
    db.query("UPDATE arms SET expires_boot=?,expires_cont=?,expires_wall=? WHERE run_id=?")
      .run(boot, expiryContinuous, expiryWall, runId)
    db.exec("COMMIT")
  } catch (error) {
    try { db.exec("ROLLBACK") } catch { /* Preserve the fixture setup failure. */ }
    throw error
  } finally { db.close() }
}

function cleanupLedgerSnapshot(root: string, runId: string) {
  const db = new Database(reentryDatabase(root))
  try {
    return {
      run: db.query("SELECT * FROM runs WHERE run_id=?").get(runId) as Record<string, unknown>,
      consent: db.query("SELECT * FROM consents WHERE run_id=?").get(runId) as Record<string, unknown> | null,
      arm: db.query("SELECT * FROM arms WHERE run_id=?").get(runId) as Record<string, unknown> | null,
      usage: db.query("SELECT * FROM usage WHERE run_id=?").get(runId) as Record<string, unknown>,
      quota: db.query("SELECT * FROM quota WHERE singleton=1").get() as Record<string, unknown>,
      attempts: db.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(runId) as { count: number },
      requests: db.query("SELECT count(*) AS count FROM requests WHERE run_id=?").get(runId) as { count: number },
      provenance: db.query("SELECT count(*) AS count FROM consent_provenance WHERE run_id=?").get(runId) as { count: number },
    }
  } finally { db.close() }
}

function setArtifactBytes(root: string, runId: string, bytes: number): void {
  const db = new Database(reentryDatabase(root))
  try {
    db.exec("BEGIN IMMEDIATE")
    db.query("UPDATE runs SET artifact_bytes=? WHERE run_id=?").run(bytes, runId)
    db.query("UPDATE usage SET artifact_bytes=? WHERE run_id=?").run(bytes, runId)
    db.exec("COMMIT")
  } catch (error) {
    try { db.exec("ROLLBACK") } catch { /* Preserve the fixture setup failure. */ }
    throw error
  } finally { db.close() }
}

describe("native skill-optimization controller primitives", () => {
  if (process.env.SKILLOPT_POSTSPAWN_CONTROLLER_HARNESS === "enabled") {
    test("internal post-spawn controller child harness", async () => {
      const root = process.env.SKILLOPT_POSTSPAWN_ROOT
      const sessionID = process.env.SKILLOPT_POSTSPAWN_SESSION
      const controllerGroupId = process.pid
      const markerPath = process.env.SKILLOPT_POSTSPAWN_MARKER
      if (!root || !sessionID || !markerPath) {
        throw new Error("post-spawn controller child harness inputs are invalid")
      }
      const fixture = await reentryFixture("ARMED", undefined, {
        worktree: { worktree: root, cleanup() {} }, sessionID,
      })
      const consent = fixture.consent
      const arm = fixture.arm
      if (!consent || !arm) throw new Error("post-spawn controller child lacks the synthetic consent/arm fixture")
      addFreshDigests(root)
      const reservation = fixture.controller.reserveAutomatic({
        owner: fixture.owner, prepared: fixture.prepared, consent, arm, current: fixture.current,
      })
      if (process.env.SKILLOPT_POSTSPAWN_STAGE === "prelaunch") {
        const status = fixture.controller.status()
        const executions = fixture.runtime.runs.status()
        if (status.requestCounts.charged.target !== 1 || status.requestCounts.dispatched.target !== 0 ||
            status.requestCounts.unknown.target !== 1 || !status.pendingDispatch ||
            executions.claim || executions.executions.length !== 0) {
          throw new Error("prelaunch fixture did not retain only the committed unknown reservation")
        }
        writeFileSync(markerPath, `${JSON.stringify({
          schemaVersion: 1,
          kind: "skillopt-controller-prelaunch-kill",
          root,
          stateHome: process.env.OTTER_STATE_HOME,
          ledger: reentryDatabase(root),
          executionRunDirectory: executionRunDirectory(root),
          controllerPid: process.pid,
          controllerGroupId,
          sessionID: fixture.owner.sessionID,
          runId: fixture.prepared.runId,
          requestId: reservation.requestId,
          reservationId: reservation.reservationId,
          controllerStatus: status,
          executionStatus: executions,
          consentIsSyntheticTestInput: true,
          qualificationProvided: false,
          modelInvocation: false,
          nativeChildLaunched: false,
          dispatchTicketConsumed: false,
          syntheticFixtureOnly: true,
          realRawKnowledgeRead: false,
        }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
        // Parent kills this real controller process after the reservation COMMIT, before ticket consumption.
        await new Promise<void>(() => {})
      }
      const grant = fixture.controller.consumeDispatch(fixture.owner, reservation.ticket, fixture.current)
      const startPath = join(root, `postspawn-native-child-${grant.requestId}.started`)
      const stoppedPath = join(root, `postspawn-native-child-${grant.requestId}.stopped`)
      const childScript = `const { writeFileSync } = require("node:fs");
const env = process.env;
writeFileSync(env.SKILLOPT_POSTSPAWN_START, String(process.pid), { flag: "wx", mode: 0o600 });
process.on("SIGTERM", () => {
  writeFileSync(env.SKILLOPT_POSTSPAWN_STOPPED, String(process.pid), { flag: "wx", mode: 0o600 });
  process.exit(0);
});
setInterval(() => {}, 1000);`
      mkdirSync(join(root, "postspawn-native-child-home"), { recursive: true, mode: 0o700 })
      // This real harmless subprocess is the test native host's launch after the genuine controller grant.
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", childScript], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          TMPDIR: tmpdir(),
          HOME: join(root, "postspawn-native-child-home"),
          SKILLOPT_POSTSPAWN_START: startPath,
          SKILLOPT_POSTSPAWN_STOPPED: stoppedPath,
        },
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      })
      const childPid = child.pid
      await waitForOwnedFiles([startPath], "the actual native child process to start")
      if (Number(readFileSync(startPath, "utf8")) !== childPid || child.exitCode !== null) {
        throw new Error("post-spawn native child identity was not live and stable")
      }

      const claim = fixture.runtime.runs.claim(fixture.owner.sessionID, fixture.runtime.instance, childPid)
      const identity: SkillOptNativeExecutionIdentity = Object.freeze({
        engine: fixture.dataset.modelBindings.target.engine,
        profile: "legacy-unowned",
        controlProfile: "estimated-input-reactive-output-v1",
        policyID: `skillopt-native-v1:${hash("post-spawn controller SIGKILL test policy")}`,
        role: grant.role,
        phase: grant.phase,
      })
      fixture.nativeIdentities.set(grant.requestId, identity)
      fixture.runtime.runs.registerIntent(claim, {
        executionId: grant.requestId, ownerSession: fixture.owner.sessionID,
        taskId: `skillopt:${grant.role}:${grant.phase}:${grant.requestId}`, attemptId: randomUUID(),
        generation: claim.generation, role: grant.role, cwd: fixture.runtime.worktree, policyID: identity.policyID,
        kind: "host", engine: identity.engine, profile: identity.profile,
        controlProfile: identity.controlProfile, nativeExecution: true,
      })
      fixture.runtime.runs.bindNativeExecutionRef(claim, grant.requestId)
      fixture.runtime.runs.markHostDispatched(claim, grant.requestId)

      const status = fixture.controller.status()
      if (status.requestCounts.charged.target !== 1 || status.requestCounts.dispatched.target !== 0 ||
          status.requestCounts.unknown.target !== 1 || !status.pendingDispatch) {
        throw new Error("post-spawn controller state was not charged and pending before ACK")
      }
      writeFileSync(markerPath, `${JSON.stringify({
        schemaVersion: 1,
        kind: "skillopt-controller-postspawn-kill",
        root,
        stateHome: process.env.OTTER_STATE_HOME,
        ledger: reentryDatabase(root),
        executionRunDirectory: executionRunDirectory(root),
        consentIsSyntheticTestInput: true,
        qualificationProvided: false,
        modelInvocation: false,
        nativeHostLaunch: "harmless test subprocess after consumeDispatch",
        syntheticFixtureOnly: true,
        realRawKnowledgeRead: false,
        controllerPid: process.pid,
        controllerGroupId,
        sessionID: fixture.owner.sessionID,
        runId: fixture.prepared.runId,
        requestId: grant.requestId,
        reservationId: reservation.reservationId,
        nativePid: childPid,
        nativeStartPath: startPath,
        nativeStoppedPath: stoppedPath,
        controllerStatus: status,
        launchCount: 1,
        dispatchAcknowledged: false,
      }, null, 2)}\n`, { flag: "wx", mode: 0o600 })

      // The parent sends SIGKILL after observing the marker; no dispatch ACK or recovery witness is written.
      await new Promise<void>(() => {})
    }, { timeout: 120_000 })
  }

  test.skipIf(!nativeClockSupported)("SIGKILL after actual controller dispatch grant and native child spawn retains unresolved charge", async () => {
    const parentNativeClockPath = nativeClockPath
    const parentNativeClockSha256 = nativeClockSha256
    if (!parentNativeClockPath || !parentNativeClockSha256) throw new Error("native clock test fixture is unavailable")
    const worktree = tempWorktree()
    const root = worktree.worktree
    const sessionID = `session_${randomUUID().replaceAll("-", "")}`
    const markerPath = join(root, "postspawn-controller-marker.json")
    const reportPath = join(root, "postspawn-controller-report.json")
    const childHome = join(root, "postspawn-controller-home")
    const childXdg = join(root, "postspawn-controller-xdg")
    let controllerChild: SkillOptChildProcess | undefined
    let controllerOutput: Promise<[string, string]> | undefined
    let newOwner: SessionStore | undefined
    let report: Record<string, unknown> = {
      schemaVersion: 1,
      kind: "skillopt-controller-postspawn-kill",
      root,
      stateHome: worktree.stateHome,
      ledger: reentryDatabase(root),
      executionRunDirectory: executionRunDirectory(root),
      marker: markerPath,
      childHome,
      childXdg,
      outcome: "incomplete",
    }
    try {
      mkdirSync(childHome, { mode: 0o700 })
      mkdirSync(childXdg, { mode: 0o700 })
      const controllerProcess = Bun.spawn([
        process.execPath, "--no-env-file", "test", import.meta.path, "--test-name-pattern",
        "internal post-spawn controller child harness",
      ], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          TMPDIR: tmpdir(),
          HOME: childHome,
          XDG_STATE_HOME: childXdg,
          OTTER_STATE_HOME: worktree.stateHome,
          SKILLOPT_POSTSPAWN_CONTROLLER_HARNESS: "enabled",
          SKILLOPT_POSTSPAWN_NATIVE_CLOCK_PATH: parentNativeClockPath,
          SKILLOPT_POSTSPAWN_NATIVE_CLOCK_SHA256: parentNativeClockSha256,
          SKILLOPT_POSTSPAWN_ROOT: root,
          SKILLOPT_POSTSPAWN_SESSION: sessionID,
          SKILLOPT_POSTSPAWN_MARKER: markerPath,
        },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
      })
      controllerChild = controllerProcess
      controllerOutput = Promise.all([
        new Response(controllerProcess.stdout).text(), new Response(controllerProcess.stderr).text(),
      ])
      // The process group ID is the PID of this detached child and its launched native descendant.
      const controllerGroupId = controllerProcess.pid
      await waitForOwnedFiles([markerPath], "the controller's post-spawn, pre-ACK marker", 30_000)
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
        schemaVersion: number; kind: string; root: string; stateHome: string; ledger: string
        executionRunDirectory: string
        controllerPid: number; controllerGroupId: number; sessionID: string
        runId: string; requestId: string; reservationId: string; nativePid: number
        nativeStartPath: string; nativeStoppedPath: string; controllerStatus: SkillOptControllerStatus
        launchCount: number; dispatchAcknowledged: boolean; consentIsSyntheticTestInput: boolean
        qualificationProvided: boolean
        modelInvocation: boolean; syntheticFixtureOnly: boolean; realRawKnowledgeRead: boolean
        nativeHostLaunch: string
      }
      expect(marker).toMatchObject({
        schemaVersion: 1, kind: "skillopt-controller-postspawn-kill", root,
        stateHome: worktree.stateHome, ledger: reentryDatabase(root),
        executionRunDirectory: executionRunDirectory(root), sessionID,
        controllerGroupId, launchCount: 1, dispatchAcknowledged: false,
        consentIsSyntheticTestInput: true,
        qualificationProvided: false,
        modelInvocation: false, nativeHostLaunch: "harmless test subprocess after consumeDispatch",
        syntheticFixtureOnly: true, realRawKnowledgeRead: false,
      })
      expect(marker.controllerPid).toBe(controllerProcess.pid)
      expect(marker.nativePid).toBeGreaterThan(1)
      expect(worktree.executionAuthority.directory).toBe(marker.executionRunDirectory)
      expect(processOrGroupExists(marker.nativePid)).toBe(true)
      expect(marker.controllerStatus).toMatchObject({
        state: "UNRESOLVED", runId: marker.runId, pendingDispatch: true,
        requestCounts: { charged: { target: 1 }, dispatched: { target: 0 }, unknown: { target: 1 } },
      })

      controllerProcess.kill("SIGKILL")
      const controllerExit = await withChildTimeout(controllerProcess.exited, "actual controller SIGKILL", 5_000)
      await withChildTimeout(controllerOutput!, "controller child output drain", 5_000)
      expect(controllerProcess.signalCode).toBe("SIGKILL")
      expect(controllerExit).not.toBe(0)
      expect(processOrGroupExists(-controllerGroupId)).toBe(true)
      expect(processOrGroupExists(marker.nativePid)).toBe(true)

      const host: ExecutionHost = {
        identity: { engine: "codex", profile: "legacy-unowned" },
        async preflight() { return { compatible: true, controls: {}, problems: [] } },
        async prepare(_request: ExecutionRequest) { throw new Error("post-crash test must not invoke a model host") },
        async reconcile(): Promise<ExecutionReconciliation> {
          return { outcome: "unknown", quiescent: false, evidence: "post-crash fixture has no authenticated provider observation" }
        },
      }
      const restartedRuntime = createExecutionRuntime({ directory: root, worktree: root, config: structuredClone(DEFAULT_CONFIG), log() {} },
        () => host, { planningOnlyMain: true })
      const takeoverOwner = attachAdmission(restartedRuntime, `new_${randomUUID().replaceAll("-", "")}`, {
        engine: "codex", model: modelBindings.generator.requestedModel,
      })
      newOwner = takeoverOwner
      expect(takeoverOwner.sessionID).not.toBe(marker.sessionID)
      const nativeHost: SkillOptNativeHost = {
        consumeCompletedTargetWitness() { throw new Error("post-crash test has no completed target witness") },
        consumeCompletedOptimizerWitness() { throw new Error("post-crash test has no completed optimizer witness") },
        identityFor() { return undefined },
        async reconcile() {
          return { outcome: "unknown", quiescent: false, evidence: "no original-epoch recovery authority" }
        },
      }
      const controller = createSkillOptController(restartedRuntime,
        { nativeHelperPath: parentNativeClockPath, nativeHelperSha256: parentNativeClockSha256 }, nativeHost)
      controller.initialize()
      const restoredOwner = attachAdmission(restartedRuntime, marker.sessionID, {
        engine: "codex", model: modelBindings.generator.requestedModel,
      })
      expect(restoredOwner.restored).toBe(true)
      expect(restoredOwner.metadata.held).toBe(true)
      const aliveStatus = controller.status()
      expect(aliveStatus).toMatchObject({
        state: "UNRESOLVED", runId: marker.runId, pendingDispatch: true,
        requestCounts: { charged: { target: 1 }, dispatched: { target: 0 }, unknown: { target: 1 } },
      })
      const takeoverDataset = createNativeDataset({
          root, selections: [{ path: `knowledge/raw/documents/${sha256(Buffer.from("Synthetic approved source excerpt for the reentry fixture.\n", "utf8"))}.md` }],
          fixturePack: makeNativePack(), modelBindings,
      })
      expect(takeoverDataset.status).toBe("STRUCTURALLY_VALID")
      expect(() => controller.prepare({
        owner: takeoverOwner, campaignId: `takeover_${randomUUID().replaceAll("-", "")}`,
        dataset: takeoverDataset,
        baselineSkillSha256: sha256(baselineBytes),
      })).toThrow("dispatch-pending")
      await expect(controller.recover(takeoverOwner, marker.runId)).rejects.toThrow("owner-unavailable")
      await expect(controller.recover(restoredOwner, marker.runId)).rejects.toThrow("admission-held")
      const executionWhileAlive = restartedRuntime.runs.status().executions.find(({ executionId }) => executionId === marker.requestId)
      expect(executionWhileAlive).toMatchObject({
        ownerSession: marker.sessionID, hostDispatch: "started", nativeExecution: true,
        boundaryRef: { executionID: marker.requestId },
      })
      expect(executionWhileAlive?.terminal).toBeUndefined()
      expect(executionWhileAlive?.reconciliation).toBeUndefined()

      const db = new Database(marker.ledger)
      let accountingWhileAlive: { quota: unknown; request: unknown; arm: unknown; attempt: unknown; usage: unknown }
      try {
        const quota = db.query(`SELECT active_run_id,pending_request_id,last_attempt_id FROM quota WHERE singleton=1`).get() as {
          active_run_id: string | null; pending_request_id: string | null; last_attempt_id: string | null
        }
        const request = db.query(`SELECT run_id,reservation_id,charged,actual_dispatch,dispatch_state,reference_json
          FROM requests WHERE request_id=?`).get(marker.requestId) as Record<string, unknown>
        const arm = db.query("SELECT state,reservation_id FROM arms WHERE run_id=?").get(marker.runId) as Record<string, unknown>
        const attempt = db.query(`SELECT run_id,reservation_id,trigger_kind,charged,actual_dispatch,dispatch_state
          FROM attempts WHERE request_id=?`).get(marker.requestId) as Record<string, unknown>
        const usage = db.query("SELECT target_requests,active_reserved_ms FROM usage WHERE run_id=?").get(marker.runId) as Record<string, unknown>
        accountingWhileAlive = { quota, request, arm, attempt, usage }
        expect(quota).toEqual({ active_run_id: marker.runId, pending_request_id: marker.requestId, last_attempt_id: marker.reservationId })
        expect(request).toEqual({
          run_id: marker.runId, reservation_id: marker.reservationId,
          charged: 1, actual_dispatch: null, dispatch_state: "possible", reference_json: null,
        })
        expect(arm).toEqual({ state: "consumed", reservation_id: marker.reservationId })
        expect(attempt).toEqual({
          run_id: marker.runId, reservation_id: marker.reservationId,
          trigger_kind: "automatic", charged: 1, actual_dispatch: null, dispatch_state: "possible",
        })
        expect(usage).toEqual({ target_requests: 1, active_reserved_ms: SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds })
      } finally { db.close() }
      report = {
        ...report,
        scenario: "controller automatic dispatch grant -> harmless test-native child spawn -> controller SIGKILL before recordDispatch",
        identities: {
          controllerPid: marker.controllerPid, controllerGroupId, nativePid: marker.nativePid,
          oldSessionID: marker.sessionID, newOwnerSessionID: takeoverOwner.sessionID,
          runId: marker.runId, requestId: marker.requestId, reservationId: marker.reservationId,
          nativeStartPath: marker.nativeStartPath, nativeStoppedPath: marker.nativeStoppedPath,
        },
        whileChildAlive: {
          nativeChildAlive: true, status: aliveStatus, accounting: accountingWhileAlive,
          hostExecution: executionWhileAlive,
          newCampaignRefused: "dispatch-pending", newOwnerRecoverRefused: "owner-unavailable",
          sameSessionReattachHeld: restoredOwner.metadata.held,
          sameSessionRecoverRefused: "admission-held",
          dispatchAcknowledged: false, launchCount: marker.launchCount,
          consentIsSyntheticTestInput: marker.consentIsSyntheticTestInput,
          qualificationProvided: marker.qualificationProvided,
          nativeHostLaunch: marker.nativeHostLaunch,
        },
      }

      await stopOwnedProcessGroup(controllerGroupId)
      expect(existsSync(marker.nativeStoppedPath)).toBe(true)
      expect(await waitForProcessGroupExit(controllerGroupId, 1_000)).toBe(true)
      const afterExitDb = new Database(marker.ledger)
      try {
        const quota = afterExitDb.query(`SELECT active_run_id,pending_request_id,last_attempt_id FROM quota WHERE singleton=1`).get()
        const request = afterExitDb.query(`SELECT run_id,reservation_id,charged,actual_dispatch,dispatch_state,reference_json
          FROM requests WHERE request_id=?`).get(marker.requestId)
        const arm = afterExitDb.query("SELECT state,reservation_id FROM arms WHERE run_id=?").get(marker.runId)
        const attempt = afterExitDb.query(`SELECT run_id,reservation_id,trigger_kind,charged,actual_dispatch,dispatch_state
          FROM attempts WHERE request_id=?`).get(marker.requestId)
        const usage = afterExitDb.query("SELECT target_requests,active_reserved_ms FROM usage WHERE run_id=?").get(marker.runId)
        expect({ quota, request, arm, attempt, usage }).toEqual(accountingWhileAlive)
      } finally { afterExitDb.close() }
      const afterChildExit = controller.status()
      expect(afterChildExit).toMatchObject({
        state: aliveStatus.state, reasonCode: aliveStatus.reasonCode, runId: aliveStatus.runId,
        revision: aliveStatus.revision, pendingDispatch: aliveStatus.pendingDispatch,
        quotaKeySha256: aliveStatus.quotaKeySha256, requestCounts: aliveStatus.requestCounts,
        targetPhaseCounts: aliveStatus.targetPhaseCounts, remaining: aliveStatus.remaining,
      })
      expect(() => controller.prepare({
        owner: takeoverOwner, campaignId: `takeover_${randomUUID().replaceAll("-", "")}`,
        dataset: takeoverDataset,
        baselineSkillSha256: sha256(baselineBytes),
      })).toThrow("dispatch-pending")
      await expect(controller.recover(takeoverOwner, marker.runId)).rejects.toThrow("owner-unavailable")
      await expect(controller.recover(restoredOwner, marker.runId)).rejects.toThrow("admission-held")
      const execution = restartedRuntime.runs.status().executions.find(({ executionId }) => executionId === marker.requestId)
      expect(execution).toMatchObject({
        ownerSession: marker.sessionID, hostDispatch: "started", nativeExecution: true,
        boundaryRef: { executionID: marker.requestId },
      })
      const finalStatus = controller.status()
      expect(finalStatus).toMatchObject({
        state: aliveStatus.state, reasonCode: aliveStatus.reasonCode, runId: aliveStatus.runId,
        revision: aliveStatus.revision, pendingDispatch: aliveStatus.pendingDispatch,
        quotaKeySha256: aliveStatus.quotaKeySha256, requestCounts: aliveStatus.requestCounts,
        targetPhaseCounts: aliveStatus.targetPhaseCounts, remaining: aliveStatus.remaining,
      })
      report = {
        ...report,
        afterChildExit: {
          nativeChildStopped: existsSync(marker.nativeStoppedPath), status: finalStatus,
          newCampaignRefused: "dispatch-pending", newOwnerRecoverRefused: "owner-unavailable",
          sameSessionReattachHeld: restoredOwner.metadata.held,
          sameSessionRecoverRefused: "admission-held",
          executionRecordRemainsUnsettled: true,
          originalOwnerAuthorityRestored: false, refund: false, redispatch: false,
        },
        outcome: "retained-unresolved",
      }
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      report = { ...report, failure: detail, outcome: "failed-retained" }
      if (!existsSync(reportPath)) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
      throw new Error(`post-spawn controller fixture retained at ${root} (report ${reportPath}): ${detail}`)
    } finally {
      try {
        if (controllerChild && controllerChild.exitCode === null) {
          controllerChild.kill("SIGKILL")
          await withChildTimeout(controllerChild.exited, "owned controller child cleanup", 2_000)
        }
      } finally {
        try {
          if (controllerChild) await stopOwnedProcessGroup(controllerChild.pid)
        } finally {
          try {
            if (controllerOutput) {
              const [stdout, stderr] = await withChildTimeout(controllerOutput, "owned controller child output cleanup", 2_000)
              if (report.outcome === "failed-retained") {
                report = { ...report, controllerChildOutput: { stdout, stderr } }
                writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "w", mode: 0o600 })
              }
            }
          } finally {
            try {
              if (newOwner && !newOwner.isReleased) newOwner.release({
                workflowQuiescent: true,
                evidence: "new-owner test attachment performed no workflow or execution; the prior owner's unresolved attempt is retained",
                workflowID: null,
                revision: null,
              })
            } finally { worktree.releaseEnvironment() }
          }
        }
      }
    }
    console.log(`Retained unresolved post-spawn controller fixture: ${reportPath}`)
  }, { timeout: 60_000 })

  test.skipIf(!nativeClockSupported)("SIGKILL after committed automatic reservation but before native launch retains unresolved charge", async () => {
    const parentNativeClockPath = nativeClockPath
    const parentNativeClockSha256 = nativeClockSha256
    if (!parentNativeClockPath || !parentNativeClockSha256) throw new Error("native clock test fixture is unavailable")
    const worktree = tempWorktree()
    const root = worktree.worktree
    const sessionID = `session_${randomUUID().replaceAll("-", "")}`
    const markerPath = join(root, "prelaunch-controller-marker.json")
    const reportPath = join(root, "prelaunch-controller-report.json")
    const childHome = join(root, "prelaunch-controller-home")
    const childXdg = join(root, "prelaunch-controller-xdg")
    let controllerChild: SkillOptChildProcess | undefined
    let controllerOutput: Promise<[string, string]> | undefined
    let newOwner: SessionStore | undefined
    let restoredOwner: SessionStore | undefined
    let report: Record<string, unknown> = {
      schemaVersion: 1,
      kind: "skillopt-controller-prelaunch-kill",
      root,
      stateHome: worktree.stateHome,
      ledger: reentryDatabase(root),
      executionRunDirectory: executionRunDirectory(root),
      marker: markerPath,
      childHome,
      childXdg,
      outcome: "incomplete",
    }
    try {
      mkdirSync(childHome, { mode: 0o700 })
      mkdirSync(childXdg, { mode: 0o700 })
      const controllerProcess = Bun.spawn([
        process.execPath, "--no-env-file", "test", import.meta.path, "--test-name-pattern",
        "internal post-spawn controller child harness",
      ], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          TMPDIR: tmpdir(),
          HOME: childHome,
          XDG_STATE_HOME: childXdg,
          OTTER_STATE_HOME: worktree.stateHome,
          SKILLOPT_POSTSPAWN_CONTROLLER_HARNESS: "enabled",
          SKILLOPT_POSTSPAWN_STAGE: "prelaunch",
          SKILLOPT_POSTSPAWN_NATIVE_CLOCK_PATH: parentNativeClockPath,
          SKILLOPT_POSTSPAWN_NATIVE_CLOCK_SHA256: parentNativeClockSha256,
          SKILLOPT_POSTSPAWN_ROOT: root,
          SKILLOPT_POSTSPAWN_SESSION: sessionID,
          SKILLOPT_POSTSPAWN_MARKER: markerPath,
        },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
      })
      controllerChild = controllerProcess
      controllerOutput = Promise.all([
        new Response(controllerProcess.stdout).text(), new Response(controllerProcess.stderr).text(),
      ])
      const controllerGroupId = controllerProcess.pid
      await waitForOwnedFiles([markerPath], "the committed prelaunch reservation marker", 30_000)
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
        schemaVersion: number; kind: string; root: string; stateHome: string; ledger: string
        executionRunDirectory: string; controllerPid: number; controllerGroupId: number; sessionID: string
        runId: string; requestId: string; reservationId: string
        controllerStatus: SkillOptControllerStatus
        executionStatus: { claim?: unknown; executions: unknown[] }
        consentIsSyntheticTestInput: boolean; qualificationProvided: boolean; modelInvocation: boolean
        nativeChildLaunched: boolean; dispatchTicketConsumed: boolean; syntheticFixtureOnly: boolean
        realRawKnowledgeRead: boolean
      }
      expect(marker).toMatchObject({
        schemaVersion: 1, kind: "skillopt-controller-prelaunch-kill", root,
        stateHome: worktree.stateHome, ledger: reentryDatabase(root),
        executionRunDirectory: executionRunDirectory(root), controllerPid: controllerProcess.pid,
        controllerGroupId, sessionID, consentIsSyntheticTestInput: true,
        qualificationProvided: false, modelInvocation: false, nativeChildLaunched: false,
        dispatchTicketConsumed: false, syntheticFixtureOnly: true, realRawKnowledgeRead: false,
      })
      expect(worktree.executionAuthority.directory).toBe(marker.executionRunDirectory)
      expect(marker.controllerStatus).toMatchObject({
        state: "UNRESOLVED", runId: marker.runId, pendingDispatch: true,
        requestCounts: { charged: { target: 1 }, dispatched: { target: 0 }, unknown: { target: 1 } },
      })
      expect(marker.executionStatus.executions).toEqual([])
      expect(marker.executionStatus.claim).toBeUndefined()
      expect("nativePid" in marker).toBe(false)
      expect(controllerProcess.exitCode).toBeNull()

      controllerProcess.kill("SIGKILL")
      const controllerExit = await withChildTimeout(controllerProcess.exited, "prelaunch controller SIGKILL", 5_000)
      await withChildTimeout(controllerOutput!, "prelaunch controller output drain", 5_000)
      expect(controllerProcess.signalCode).toBe("SIGKILL")
      expect(controllerExit).not.toBe(0)
      await stopOwnedProcessGroup(controllerGroupId)

      const host: ExecutionHost = {
        identity: { engine: "codex", profile: "legacy-unowned" },
        async preflight() { return { compatible: true, controls: {}, problems: [] } },
        async prepare(_request: ExecutionRequest) { throw new Error("prelaunch crash test must not invoke a model host") },
        async reconcile(): Promise<ExecutionReconciliation> {
          return { outcome: "unknown", quiescent: false, evidence: "prelaunch fixture has no dispatch or host observation" }
        },
      }
      const restartedRuntime = createExecutionRuntime({ directory: root, worktree: root, config: structuredClone(DEFAULT_CONFIG), log() {} },
        () => host, { planningOnlyMain: true })
      const takeoverOwner = attachAdmission(restartedRuntime, `new_${randomUUID().replaceAll("-", "")}`, {
        engine: "codex", model: modelBindings.generator.requestedModel,
      })
      newOwner = takeoverOwner
      const nativeHost: SkillOptNativeHost = {
        consumeCompletedTargetWitness() { throw new Error("prelaunch crash has no completed-target witness") },
        consumeCompletedOptimizerWitness() { throw new Error("prelaunch crash has no completed-optimizer witness") },
        identityFor() { return undefined },
        async reconcile() {
          return { outcome: "unknown", quiescent: false, evidence: "no original-epoch recovery authority" }
        },
      }
      const controller = createSkillOptController(restartedRuntime,
        { nativeHelperPath: parentNativeClockPath, nativeHelperSha256: parentNativeClockSha256 }, nativeHost)
      controller.initialize()
      const attachedOldSession = attachAdmission(restartedRuntime, marker.sessionID, {
        engine: "codex", model: modelBindings.generator.requestedModel,
      })
      restoredOwner = attachedOldSession
      expect(attachedOldSession.restored).toBe(true)
      expect(attachedOldSession.metadata.held).toBe(true)
      expect(takeoverOwner.sessionID).not.toBe(marker.sessionID)

      const reopenedStatus = controller.status()
      expect(reopenedStatus).toMatchObject({
        state: "UNRESOLVED", runId: marker.runId, pendingDispatch: true,
        requestCounts: { charged: { target: 1 }, dispatched: { target: 0 }, unknown: { target: 1 } },
      })
      const takeoverSource = Buffer.from("Synthetic approved source excerpt for the reentry fixture.\n", "utf8")
      const takeoverDataset = createNativeDataset({
        root,
        selections: [{ path: `knowledge/raw/documents/${sha256(takeoverSource)}.md` }],
        fixturePack: makeNativePack(), modelBindings,
      })
      expect(takeoverDataset.status).toBe("STRUCTURALLY_VALID")
      expect(() => controller.prepare({
        owner: takeoverOwner, campaignId: `takeover_${randomUUID().replaceAll("-", "")}`,
        dataset: takeoverDataset, baselineSkillSha256: sha256(baselineBytes),
      })).toThrow("dispatch-pending")
      await expect(controller.recover(takeoverOwner, marker.runId)).rejects.toThrow("owner-unavailable")
      await expect(controller.recover(attachedOldSession, marker.runId)).rejects.toThrow("admission-held")
      expect(restartedRuntime.runs.status().claim).toBeUndefined()
      expect(restartedRuntime.runs.status().executions).toEqual([])

      const db = new Database(marker.ledger)
      let accounting: Record<string, unknown>
      try {
        const quota = db.query("SELECT active_run_id,pending_request_id,last_attempt_id FROM quota WHERE singleton=1").get()
        const run = db.query("SELECT state,revision FROM runs WHERE run_id=?").get(marker.runId)
        const request = db.query(`SELECT run_id,reservation_id,charged,actual_dispatch,dispatch_state,reference_json
          FROM requests WHERE request_id=?`).get(marker.requestId)
        const arm = db.query("SELECT state,reservation_id FROM arms WHERE run_id=?").get(marker.runId)
        const attempt = db.query(`SELECT run_id,reservation_id,trigger_kind,charged,actual_dispatch,dispatch_state
          FROM attempts WHERE request_id=?`).get(marker.requestId)
        const usage = db.query("SELECT target_requests,active_reserved_ms FROM usage WHERE run_id=?").get(marker.runId)
        const requests = db.query("SELECT count(*) AS count FROM requests WHERE run_id=?").get(marker.runId)
        const attempts = db.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(marker.runId)
        accounting = { quota, run, request, arm, attempt, usage, requests, attempts }
        expect(quota).toEqual({ active_run_id: marker.runId, pending_request_id: marker.requestId, last_attempt_id: marker.reservationId })
        expect(run).toMatchObject({ state: "RESERVED" })
        expect(request).toEqual({
          run_id: marker.runId, reservation_id: marker.reservationId,
          charged: 1, actual_dispatch: null, dispatch_state: "possible", reference_json: null,
        })
        expect(arm).toEqual({ state: "consumed", reservation_id: marker.reservationId })
        expect(attempt).toEqual({
          run_id: marker.runId, reservation_id: marker.reservationId,
          trigger_kind: "automatic", charged: 1, actual_dispatch: null, dispatch_state: "possible",
        })
        expect(usage).toEqual({ target_requests: 1, active_reserved_ms: SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds })
        expect(requests).toEqual({ count: 1 })
        expect(attempts).toEqual({ count: 1 })
      } finally { db.close() }
      const afterRefusals = controller.status()
      expect(afterRefusals).toMatchObject({
        state: reopenedStatus.state, reasonCode: reopenedStatus.reasonCode, runId: reopenedStatus.runId,
        revision: reopenedStatus.revision, pendingDispatch: reopenedStatus.pendingDispatch,
        requestCounts: reopenedStatus.requestCounts, targetPhaseCounts: reopenedStatus.targetPhaseCounts,
        remaining: reopenedStatus.remaining,
      })
      report = {
        ...report,
        scenario: "automatic reservation COMMIT -> controller SIGKILL before consumeDispatch/native launch -> same authority and ledger reopen",
        identities: {
          controllerPid: marker.controllerPid, controllerGroupId,
          originalSessionID: marker.sessionID, newOwnerSessionID: takeoverOwner.sessionID,
          runId: marker.runId, requestId: marker.requestId, reservationId: marker.reservationId,
        },
        afterReopen: {
          status: reopenedStatus,
          accounting,
          newCampaignRefused: "dispatch-pending",
          newOwnerRecoverRefused: "owner-unavailable",
          sameSessionReattachHeld: attachedOldSession.metadata.held,
          sameSessionRecoverRefused: "admission-held",
          executionIntentCount: restartedRuntime.runs.status().executions.length,
          nativeChildLaunched: false,
          modelInvocation: false,
          armRefunded: false,
          attemptRefunded: false,
          retryOrRedispatch: false,
        },
        outcome: "retained-unresolved",
      }
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      report = { ...report, failure: detail, outcome: "failed-retained" }
      if (!existsSync(reportPath)) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
      throw new Error(`prelaunch controller fixture retained at ${root} (report ${reportPath}): ${detail}`)
    } finally {
      try {
        if (controllerChild && controllerChild.exitCode === null) {
          controllerChild.kill("SIGKILL")
          await withChildTimeout(controllerChild.exited, "owned prelaunch controller cleanup", 2_000)
        }
      } finally {
        try {
          if (controllerChild) await stopOwnedProcessGroup(controllerChild.pid)
        } finally {
          try {
            if (controllerOutput) {
              const [stdout, stderr] = await withChildTimeout(controllerOutput, "prelaunch controller output cleanup", 2_000)
              if (report.outcome === "failed-retained") {
                report = { ...report, controllerChildOutput: { stdout, stderr } }
                writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "w", mode: 0o600 })
              }
            }
          } finally {
            try {
              if (restoredOwner && !restoredOwner.isReleased) releaseOwner(restoredOwner)
            } finally {
              try {
                if (newOwner && !newOwner.isReleased) newOwner.release({
                  workflowQuiescent: true,
                  evidence: "new-owner prelaunch test attachment performed no workflow or execution; original charged reservation is retained",
                  workflowID: null,
                  revision: null,
                })
              } finally { worktree.releaseEnvironment() }
            }
          }
        }
      }
    }
    console.log(`Retained unresolved prelaunch controller fixture: ${reportPath}`)
  }, { timeout: 60_000 })

  test.skipIf(!nativeClockSupported)("requires same-boot native expiry and retires only zero-attempt PREPARED, CONSENTED, and ARMED runs", async () => {
    for (const state of ["PREPARED", "CONSENTED", "ARMED"] as const) {
      const fixture = await reentryFixture(state)
      expirePrivateTextRun(fixture.root, fixture.prepared.runId)
      const before = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
      const mutationClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
      try {
        const artifactsSha256 = hash(`foreground-manifest:${state}`)
        const artifactBytes = 37
        const trainerSnapshotSha256 = state === "ARMED" ? hash("trainer-snapshot:armed") : null
        const prepared = fixture.controller.preparePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
          mutationClaim, runId: fixture.prepared.runId, artifactsSha256, artifactBytes, trainerSnapshotSha256 })
        expect(prepared.metadata).toMatchObject({ runId: fixture.prepared.runId, state, artifactsSha256,
          artifactBytes, operation: "delete-private-experiment-text-only" })
        expect(Object.keys(prepared.challenge)).toEqual([])
        expect(prepared.decisionBinding.subject.kind).toBe("experiment-unit")
        expect(prepared.decisionBinding.subject.sha256).toMatch(/^[a-f0-9]{64}$/u)
        if (state === "PREPARED") {
          const copiedChallenge = structuredClone(prepared.challenge)
          const copiedReceipt = await approveReentry(prepared.decisionBinding)
          expect(() => fixture.controller.retirePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
            mutationClaim, challenge: copiedChallenge, decision: copiedReceipt }))
            .toThrow("consent-required")
        }
        const receipt = await approveReentry(prepared.decisionBinding)
        const retired = fixture.controller.retirePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
          mutationClaim, challenge: prepared.challenge, decision: receipt })
        expect(retired).toMatchObject({ runId: fixture.prepared.runId, state: "EXPIRED", artifactsSha256, artifactBytes, resumed: false })
        expect(JSON.stringify(retired)).not.toContain("inputDeletion")
        expect(JSON.stringify(retired)).not.toContain("trainerDeletion")
        expect(Object.keys(retired.inputDeletion)).toEqual([])
        expect(JSON.parse(JSON.stringify(retired.inputDeletion))).toEqual({})
        const copiedDeletion = JSON.parse(JSON.stringify(retired.inputDeletion)) as never
        expect(() => consumePrivateTextCleanupDeletion(copiedDeletion, { worktree: fixture.root,
          runId: fixture.prepared.runId, kind: "input", snapshotSha256: artifactsSha256 })).toThrow("consent-required")
        consumePrivateTextCleanupDeletion(retired.inputDeletion, { worktree: fixture.root, runId: fixture.prepared.runId,
          kind: "input", snapshotSha256: artifactsSha256 })
        expect(() => consumePrivateTextCleanupDeletion(retired.inputDeletion, { worktree: fixture.root,
          runId: fixture.prepared.runId, kind: "input", snapshotSha256: artifactsSha256 })).toThrow("consent-required")
        if (trainerSnapshotSha256) {
          expect(retired.trainerDeletion).toBeDefined()
          consumePrivateTextCleanupDeletion(retired.trainerDeletion!, { worktree: fixture.root, runId: fixture.prepared.runId,
            kind: "trainer", snapshotSha256: trainerSnapshotSha256 })
        } else expect(retired.trainerDeletion).toBeUndefined()
        const after = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
        expect(after.run.state).toBe("EXPIRED")
        expect(after.run.revision).toBe((before.run.revision as number) + 1)
        expect(after.run.expires_boot).toBe(before.run.expires_boot)
        expect(after.run.expires_cont).toBe(before.run.expires_cont)
        expect(after.run.expires_wall).toBe(before.run.expires_wall)
        for (const key of ["active_ms", "candidate_steps", "fixture_bytes"] as const) {
          expect(after.run[key]).toBe(before.run[key])
        }
        expect(after.run.artifact_bytes).toBe((before.run.artifact_bytes as number) + artifactBytes)
        expect(after.usage).toEqual({ ...before.usage, artifact_bytes: (before.usage.artifact_bytes as number) + artifactBytes })
        expect(after.attempts.count).toBe(0)
        expect(after.requests.count).toBe(0)
        expect(after.provenance).toEqual(before.provenance)
        expect(after.consent?.state).toBe(state === "PREPARED" ? undefined : "revoked")
        expect(after.arm?.state).toBe(state === "ARMED" ? "revoked" : undefined)
        expect(after.quota.active_run_id).toBe(before.quota.active_run_id)
        expect(after.quota.pending_request_id).toBe(before.quota.pending_request_id)
        expect(after.quota.last_attempt_id).toBe(before.quota.last_attempt_id)
        expect(fixture.runtime.runs.status().executions).toHaveLength(0)
        if (state === "PREPARED") {
          expect(() => fixture.controller.retirePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
            mutationClaim, challenge: prepared.challenge, decision: receipt })).toThrow("not issued by the terminal reader")
        }
      } finally { fixture.runtime.runs.release(mutationClaim) }
      expect(() => fixture.controller.prepareReentry({ owner: fixture.owner, runId: fixture.prepared.runId,
        current: fixture.current })).toThrow()
    }
  })

  test.skipIf(!nativeClockSupported)("fails closed on an older ledger without modifying its file", async () => {
    const fixture = await reentryFixture("PREPARED")
    const db = new Database(reentryDatabase(fixture.root))
    try {
      db.exec("BEGIN IMMEDIATE")
      db.exec("DROP TABLE private_cleanup_retirements")
      db.query("UPDATE meta SET value='skillopt.automation-ledger.v6' WHERE name='schema'").run()
      db.exec("PRAGMA user_version = 6")
      db.exec("COMMIT")
    } catch (error) {
      try { db.exec("ROLLBACK") } catch { /* Preserve the fixture setup failure. */ }
      throw error
    } finally { db.close() }
    const oldLedgerBefore = hash(readFileSync(reentryDatabase(fixture.root)))
    const controller = createSkillOptController(fixture.runtime,
      { nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! }, fixture.nativeHost)
    expect(() => controller.initialize()).toThrow("storage-corrupt")
    expect(hash(readFileSync(reentryDatabase(fixture.root)))).toBe(oldLedgerBefore)
  })

  test.skipIf(!nativeClockSupported)("refuses v7 ledgers without migration or writes", async () => {
    const fixture = await reentryFixture("PREPARED")
    const db = new Database(reentryDatabase(fixture.root))
    try {
      db.exec("BEGIN IMMEDIATE")
      db.exec("DROP TABLE trainer_protocol_dispatches; DROP TABLE trainer_protocol_events")
      db.query("UPDATE meta SET value='skillopt.automation-ledger.v7' WHERE name='schema'").run()
      db.exec("PRAGMA user_version = 7")
      db.exec("COMMIT")
    } catch (error) {
      try { db.exec("ROLLBACK") } catch { /* Preserve the fixture setup failure. */ }
      throw error
    } finally { db.close() }
    const before = hash(readFileSync(reentryDatabase(fixture.root)))
    const controller = createSkillOptController(fixture.runtime,
      { nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! }, fixture.nativeHost)
    expect(() => controller.initialize()).toThrow("storage-corrupt")
    expect(hash(readFileSync(reentryDatabase(fixture.root)))).toBe(before)
  })

  test.skipIf(!nativeClockSupported)("quarantines event-only recovery and refuses a fresh protocol capture", async () => {
    const fixture = await reentryFixture("CONSENTED")
    await makeRunningNativeFixture(fixture)
    const beforeForgedEvent = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    expect(() => fixture.controller.reserveNativeTrainerSelectionTarget({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, event: {} as never })).toThrow("binding-invalid")
    expect(cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId).requests).toEqual(beforeForgedEvent.requests)
    const schedule = buildNativeCampaignSchedule(fixture.dataset.fixturePack)
    const training = schedule.training[0]!
    const db = new Database(reentryDatabase(fixture.root))
    try {
      // This row is deliberately injected only as hostile persisted evidence; it never mints a capability.
      db.query(`INSERT INTO trainer_protocol_events(run_id,wire_request_id,worker_profile_sha256,receipt_binding_sha256,ordinal,
        raw_line_sha256,kind,cohort,case_id,replicate,fragment_sha256,optimizer_stage,prompt_sha256)
        VALUES(?,?,?,?,?,?,'rollout',?,?,?, ?,NULL,NULL)`)
        .run(fixture.prepared.runId, `${fixture.prepared.runId}:1`, hash("unowned protocol profile"),
          hash("unowned ready receipt"), 1,
          hash("unowned raw protocol line"), "training", training.caseId, training.replicate, hash(""))
    } finally { db.close() }
    const before = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    expect(() => fixture.controller.openNativeTrainerProtocolCapture({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current,
      trainer: { profile: {} as never, receipt: {} as never } })).toThrow("recovery-unresolved")

    const restarted = createSkillOptController(fixture.runtime,
      { nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! }, fixture.nativeHost)
    restarted.initialize()
    const status = await restarted.recover(fixture.owner, fixture.prepared.runId)
    const after = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    expect(status.state).toBe("UNRESOLVED")
    expect(after.run.state).toBe("UNRESOLVED")
    expect(after.run.reason_code).toBe("recovery-unresolved")
    expect(after.quota.active_run_id).toBe(fixture.prepared.runId)
    expect(after.quota.pending_request_id).toBeNull()
    expect(after.run.artifact_bytes).toBe(before.run.artifact_bytes)
    expect(after.usage.artifact_bytes).toBe(before.usage.artifact_bytes)
    expect(after.usage.target_requests).toBe(before.usage.target_requests)
    expect(after.requests).toEqual(before.requests)
    expect(after.attempts).toEqual(before.attempts)
    expect(after.consent?.state).toBe("valid")
  })

  test.skipIf(!nativeClockSupported)("binds cleanup artifact bytes, preflights the cap, and rechecks it before charging", async () => {
    const invalid = await reentryFixture("PREPARED")
    expirePrivateTextRun(invalid.root, invalid.prepared.runId)
    const invalidClaim = invalid.runtime.runs.claim(invalid.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    try {
      for (const artifactBytes of [-1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => invalid.controller.preparePrivateTextCleanup({ owner: invalid.owner, runtime: invalid.runtime,
          mutationClaim: invalidClaim, runId: invalid.prepared.runId, artifactsSha256: hash("invalid-cleanup-size"),
          artifactBytes, trainerSnapshotSha256: null })).toThrow("binding-invalid")
      }
      expect(() => invalid.controller.preparePrivateTextCleanup({ owner: invalid.owner, runtime: invalid.runtime,
        mutationClaim: invalidClaim, runId: invalid.prepared.runId, artifactsSha256: hash("over-cap-cleanup"),
        artifactBytes: SKILLOPT_CONTROLLER_LIMITS.artifactBytes + 1, trainerSnapshotSha256: null })).toThrow("budget-exhausted")
      expect(() => invalid.controller.preparePrivateTextCleanup({ owner: invalid.owner, runtime: invalid.runtime,
        mutationClaim: invalidClaim, runId: invalid.prepared.runId, artifactsSha256: hash("invalid-trainer-snapshot"),
        artifactBytes: 0, trainerSnapshotSha256: "not-a-hash" })).toThrow("binding-invalid")
    } finally { invalid.runtime.runs.release(invalidClaim) }

    const fixture = await reentryFixture("PREPARED")
    expirePrivateTextRun(fixture.root, fixture.prepared.runId)
    const claim = fixture.runtime.runs.claim(fixture.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    try {
      const prepared = fixture.controller.preparePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: claim, runId: fixture.prepared.runId, artifactsSha256: hash("atomic-cleanup-cap"), artifactBytes: 2,
        trainerSnapshotSha256: null })
      const db = new Database(reentryDatabase(fixture.root))
      try {
        db.exec("BEGIN IMMEDIATE")
        db.query("UPDATE runs SET artifact_bytes=? WHERE run_id=?")
          .run(SKILLOPT_CONTROLLER_LIMITS.artifactBytes - 1, fixture.prepared.runId)
        db.query("UPDATE usage SET artifact_bytes=? WHERE run_id=?")
          .run(SKILLOPT_CONTROLLER_LIMITS.artifactBytes - 1, fixture.prepared.runId)
        db.exec("COMMIT")
      } catch (error) {
        try { db.exec("ROLLBACK") } catch { /* Preserve the fixture setup failure. */ }
        throw error
      } finally { db.close() }
      const decision = await approveReentry(prepared.decisionBinding)
      expect(() => fixture.controller.retirePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: claim, challenge: prepared.challenge, decision }))
        .toThrow("budget-exhausted")
      const after = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
      expect(after.run.state).toBe("PREPARED")
      expect(after.run.artifact_bytes).toBe(SKILLOPT_CONTROLLER_LIMITS.artifactBytes - 1)
      expect(after.usage.artifact_bytes).toBe(SKILLOPT_CONTROLLER_LIMITS.artifactBytes - 1)
      expect(after.attempts.count).toBe(0)
      expect(after.requests.count).toBe(0)
    } finally { fixture.runtime.runs.release(claim) }
  })

  test.skipIf(!nativeClockSupported)("monotonically reserves native preparation artifact bytes only for unstarted owned runs", async () => {
    for (const state of ["PREPARED", "CONSENTED", "ARMED"] as const) {
      const fixture = await reentryFixture(state)
      const before = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
      const bytes = state === "PREPARED" ? 271 : 69_632
      fixture.controller.reserveNativePreparationArtifacts({ owner: fixture.owner, runtime: fixture.runtime,
        runId: fixture.prepared.runId, current: fixture.current, bytes })
      const after = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
      expect(after.run.state).toBe(state)
      expect(after.run.revision).toBe((before.run.revision as number) + 1)
      expect(after.run.artifact_bytes).toBe((before.run.artifact_bytes as number) + bytes)
      expect(after.usage).toEqual({ ...before.usage, artifact_bytes: (before.usage.artifact_bytes as number) + bytes })
      expect(after.consent).toEqual(before.consent)
      expect(after.arm).toEqual(before.arm)
      expect(after.attempts).toEqual({ count: 0 })
      expect(after.requests).toEqual({ count: 0 })
      expect(after.provenance).toEqual(before.provenance)
      expect(fixture.runtime.runs.status().executions).toHaveLength(0)
      if (state === "PREPARED") {
        const consent = fixture.controller.consent(fixture.prepared,
          await approveReentry(fixture.prepared.decisionBinding), fixture.current)
        expect(consent.state).toBe("CONSENTED")
      }
    }
  })

  test.skipIf(!nativeClockSupported)("precharges the exact planned trainer materialization without changing readiness or dispatch state", async () => {
    const fixture = await reentryFixture("ARMED")
    addFreshDigests(fixture.root)
    if (!fixture.consent || !fixture.arm) throw new Error("armed trainer materialization fixture is incomplete")
    const readinessBefore = fixture.controller.automaticReadiness({ owner: fixture.owner, prepared: fixture.prepared,
      consent: fixture.consent, arm: fixture.arm, current: fixture.current })
    const before = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    const { materialization } = trainerMaterialization(fixture)
    expect(Object.keys(materialization).sort()).toEqual([
      "bindingSha256", "manifestBytes", "manifestSha256", "projectionBytes", "projectionSha256", "rootBinding", "runId",
    ])
    expect(JSON.stringify(materialization)).not.toContain("Synthetic approved source excerpt")

    const allowance = fixture.controller.reserveNativeTrainerMaterialization({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, materialization })
    const after = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    const expectedDebit = materialization.projectionBytes + materialization.manifestBytes * 2 +
      NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES + NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES
    expect((after.run.artifact_bytes as number) - (before.run.artifact_bytes as number)).toBe(expectedDebit)
    expect((after.usage.artifact_bytes as number) - (before.usage.artifact_bytes as number)).toBe(expectedDebit)
    expect(after.run.state).toBe("ARMED")
    expect(after.run.revision).toBe((before.run.revision as number) + 1)
    expect(after.consent).toEqual(before.consent)
    expect(after.arm).toEqual(before.arm)
    expect(after.attempts).toEqual({ count: 0 })
    expect(after.requests).toEqual({ count: 0 })
    expect(after.quota.last_attempt_id).toBe(before.quota.last_attempt_id)
    expect(after.quota.pending_request_id).toBe(before.quota.pending_request_id)
    expect(fixture.controller.automaticReadiness({ owner: fixture.owner, prepared: fixture.prepared,
      consent: fixture.consent, arm: fixture.arm, current: fixture.current })).toEqual(readinessBefore)
    expect(fixture.runtime.runs.status().executions).toHaveLength(0)
    const descriptorPath = join(executionRunDirectory(fixture.root), "skillopt-native-foreground", `${fixture.prepared.runId}.trainer.json`)
    expect(existsSync(descriptorPath)).toBe(false)

    const expected = { owner: fixture.owner, runtime: fixture.runtime, prepared: fixture.prepared,
      current: fixture.current, materialization }
    expect(() => fixture.controller.consumeNativeTrainerMaterializationAllowance(structuredClone(allowance), expected))
      .toThrow("binding-invalid")
    const restoredAllowance = JSON.parse(JSON.stringify(allowance))
    expect(() => fixture.controller.consumeNativeTrainerMaterializationAllowance(restoredAllowance, expected))
      .toThrow("binding-invalid")
    const foreignOwner = reattachOwner(fixture.runtime, fixture.fixture.owners)
    try {
      expect(() => fixture.controller.consumeNativeTrainerMaterializationAllowance(allowance,
        { ...expected, owner: foreignOwner })).toThrow("owner-unavailable")
    } finally { releaseOwner(foreignOwner) }
    const descriptors: readonly SkillOptNativeTrainerMaterializationMetadata[] = [
      { ...materialization, runId: randomUUID() },
      { ...materialization, rootBinding: hash(`root:${fixture.root}.elsewhere`) },
      { ...materialization, bindingSha256: hash("different binding") },
      { ...materialization, projectionSha256: hash("different projection") },
      { ...materialization, projectionBytes: materialization.projectionBytes + 1 },
      { ...materialization, manifestSha256: hash("different manifest") },
      { ...materialization, manifestBytes: materialization.manifestBytes + 1 },
    ]
    for (const descriptor of descriptors) {
      expect(() => fixture.controller.consumeNativeTrainerMaterializationAllowance(allowance, { ...expected, materialization: descriptor }))
        .toThrow("binding-invalid")
    }
    expect(existsSync(descriptorPath)).toBe(false)
    const stageAllowance = fixture.controller.consumeNativeTrainerMaterializationAllowance(allowance, expected)
    expect(() => fixture.controller.consumeNativeTrainerMaterializationAllowance(allowance, expected)).toThrow("binding-invalid")
    expect(() => consumeNativeTrainerProtocolStageAllowance(stageAllowance,
      { ...materialization, manifestBytes: materialization.manifestBytes + 1 })).toThrow("binding-invalid")
    consumeNativeTrainerProtocolStageAllowance(stageAllowance, materialization)
    expect(() => consumeNativeTrainerProtocolStageAllowance(stageAllowance, materialization)).toThrow("binding-invalid")

    const afterRefusals = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    expect(afterRefusals.run.artifact_bytes).toBe(after.run.artifact_bytes)
    expect(afterRefusals.usage.artifact_bytes).toBe(after.usage.artifact_bytes)
    expect(afterRefusals.attempts).toEqual({ count: 0 })
    expect(afterRefusals.requests).toEqual({ count: 0 })
    expect(existsSync(descriptorPath)).toBe(false)

    const nearCap = await reentryFixture("PREPARED")
    const nearCapPlan = trainerMaterialization(nearCap)
    const nearCapDebit = nearCapPlan.materialization.projectionBytes + nearCapPlan.materialization.manifestBytes * 2 +
      NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES + NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES
    const database = new Database(reentryDatabase(nearCap.root))
    try {
      database.exec("BEGIN IMMEDIATE")
      const remaining = SKILLOPT_CONTROLLER_LIMITS.artifactBytes - nearCapDebit + 1
      database.query("UPDATE runs SET artifact_bytes=? WHERE run_id=?").run(remaining, nearCap.prepared.runId)
      database.query("UPDATE usage SET artifact_bytes=? WHERE run_id=?").run(remaining, nearCap.prepared.runId)
      database.exec("COMMIT")
    } catch (error) {
      try { database.exec("ROLLBACK") } catch { /* Preserve the fixture setup failure. */ }
      throw error
    } finally { database.close() }
    const beforeCapRefusal = cleanupLedgerSnapshot(nearCap.root, nearCap.prepared.runId)
    expect(nearCap.controller.status().remaining.artifactBytes).toBe(nearCapDebit - 1)
    expect(() => nearCap.controller.reserveNativeTrainerMaterialization({ owner: nearCap.owner, runtime: nearCap.runtime,
      prepared: nearCap.prepared, current: nearCap.current, materialization: nearCapPlan.materialization }))
      .toThrow("budget-exhausted")
    const afterCapRefusal = cleanupLedgerSnapshot(nearCap.root, nearCap.prepared.runId)
    expect(afterCapRefusal.run.artifact_bytes).toBe(beforeCapRefusal.run.artifact_bytes)
    expect(afterCapRefusal.usage.artifact_bytes).toBe(beforeCapRefusal.usage.artifact_bytes)
    expect(nearCap.controller.status().remaining.artifactBytes).toBe(nearCapDebit - 1)
    expect(afterCapRefusal.run.revision).toBe(beforeCapRefusal.run.revision)
    expect(afterCapRefusal.attempts).toEqual({ count: 0 })
    expect(afterCapRefusal.requests).toEqual({ count: 0 })
    expect(existsSync(join(executionRunDirectory(nearCap.root), "skillopt-native-foreground",
      `${nearCap.prepared.runId}.trainer.json`))).toBe(false)
    expect(inspectNativeSkillOptTrainerCleanup(realpathSync.native(nearCap.root), nearCap.prepared.runId)).toBeNull()

    const exactCap = await reentryFixture("PREPARED")
    const exactCapPlan = trainerMaterialization(exactCap)
    const exactCapDebit = exactCapPlan.materialization.projectionBytes + exactCapPlan.materialization.manifestBytes * 2 +
      NATIVE_SKILLOPT_TRAINER_CLEANUP_METADATA_BYTES + NATIVE_SKILLOPT_TRAINER_OUTPUT_RESERVATION_BYTES
    const exactCapDatabase = new Database(reentryDatabase(exactCap.root))
    try {
      exactCapDatabase.exec("BEGIN IMMEDIATE")
      const remaining = SKILLOPT_CONTROLLER_LIMITS.artifactBytes - exactCapDebit
      exactCapDatabase.query("UPDATE runs SET artifact_bytes=? WHERE run_id=?").run(remaining, exactCap.prepared.runId)
      exactCapDatabase.query("UPDATE usage SET artifact_bytes=? WHERE run_id=?").run(remaining, exactCap.prepared.runId)
      exactCapDatabase.exec("COMMIT")
    } catch (error) {
      try { exactCapDatabase.exec("ROLLBACK") } catch { /* Preserve the fixture setup failure. */ }
      throw error
    } finally { exactCapDatabase.close() }
    const beforeExactCap = cleanupLedgerSnapshot(exactCap.root, exactCap.prepared.runId)
    expect(exactCap.controller.status().remaining.artifactBytes).toBe(exactCapDebit)
    exactCap.controller.reserveNativeTrainerMaterialization({ owner: exactCap.owner, runtime: exactCap.runtime,
      prepared: exactCap.prepared, current: exactCap.current, materialization: exactCapPlan.materialization })
    const afterExactCap = cleanupLedgerSnapshot(exactCap.root, exactCap.prepared.runId)
    expect(afterExactCap.run.artifact_bytes).toBe(SKILLOPT_CONTROLLER_LIMITS.artifactBytes)
    expect(afterExactCap.usage.artifact_bytes).toBe(SKILLOPT_CONTROLLER_LIMITS.artifactBytes)
    expect((afterExactCap.run.artifact_bytes as number) - (beforeExactCap.run.artifact_bytes as number)).toBe(exactCapDebit)
    expect((afterExactCap.usage.artifact_bytes as number) - (beforeExactCap.usage.artifact_bytes as number)).toBe(exactCapDebit)
    expect(exactCap.controller.status().remaining.artifactBytes).toBe(0)
    expect(afterExactCap.run.revision).toBe((beforeExactCap.run.revision as number) + 1)
    expect(afterExactCap.attempts).toEqual({ count: 0 })
    expect(afterExactCap.requests).toEqual({ count: 0 })
    expect(inspectNativeSkillOptTrainerCleanup(realpathSync.native(exactCap.root), exactCap.prepared.runId)).toBeNull()
  })

  test.skipIf(!nativeClockSupported)("atomically precharges bounded reviewer capture before issuing its request ticket", async () => {
    const reviewerCaptureBytes = NATIVE_DATASET_LIMITS.nativeResponseBytes + nativeObservedUsageCanonicalByteBound()
    expect(reviewerCaptureBytes).toBe(32_959)

    const short = await reentryFixture("CONSENTED")
    await makeRunningNativeFixture(short)
    setArtifactBytes(short.root, short.prepared.runId, SKILLOPT_CONTROLLER_LIMITS.artifactBytes - reviewerCaptureBytes + 1)
    const shortBefore = cleanupLedgerSnapshot(short.root, short.prepared.runId)
    const shortStatusBefore = short.controller.status()
    expect(shortStatusBefore.remaining.artifactBytes).toBe(reviewerCaptureBytes - 1)
    let deniedReservation: SkillOptReservation | undefined
    expect(() => {
      deniedReservation = short.controller.reserveRequest({ owner: short.owner, runId: short.prepared.runId,
        current: short.current, role: "reviewer", phase: "final" })
    }).toThrow("budget-exhausted")
    expect(deniedReservation).toBeUndefined()
    const shortAfter = cleanupLedgerSnapshot(short.root, short.prepared.runId)
    const shortStatusAfter = short.controller.status()
    expect(shortAfter.run).toEqual(shortBefore.run)
    expect(shortAfter.usage).toEqual(shortBefore.usage)
    expect(shortAfter.quota).toEqual(shortBefore.quota)
    expect(shortAfter.attempts).toEqual(shortBefore.attempts)
    expect(shortAfter.requests).toEqual(shortBefore.requests)
    expect(shortStatusAfter.requestCounts).toEqual(shortStatusBefore.requestCounts)
    expect(shortStatusAfter.remaining).toEqual(shortStatusBefore.remaining)
    expect(shortStatusAfter.pendingDispatch).toBe(false)

    const exact = await reentryFixture("CONSENTED")
    await makeRunningNativeFixture(exact)
    setArtifactBytes(exact.root, exact.prepared.runId, SKILLOPT_CONTROLLER_LIMITS.artifactBytes - reviewerCaptureBytes)
    const exactBefore = cleanupLedgerSnapshot(exact.root, exact.prepared.runId)
    expect(exact.controller.status().remaining.artifactBytes).toBe(reviewerCaptureBytes)
    const reservation = exact.controller.reserveRequest({ owner: exact.owner, runId: exact.prepared.runId,
      current: exact.current, role: "reviewer", phase: "safety" })
    expect(reservation.role).toBe("reviewer")
    expect(reservation.phase).toBe("safety")
    expect(reservation.requestId).toMatch(/^[0-9a-f-]{36}$/iu)
    expect(Object.isFrozen(reservation.ticket)).toBe(true)
    const exactAfter = cleanupLedgerSnapshot(exact.root, exact.prepared.runId)
    expect(exactAfter.run.artifact_bytes).toBe(SKILLOPT_CONTROLLER_LIMITS.artifactBytes)
    expect(exactAfter.usage.artifact_bytes).toBe(SKILLOPT_CONTROLLER_LIMITS.artifactBytes)
    expect((exactAfter.run.artifact_bytes as number) - (exactBefore.run.artifact_bytes as number)).toBe(reviewerCaptureBytes)
    expect(exactAfter.usage.reviewer_requests).toBe((exactBefore.usage.reviewer_requests as number) + 1)
    expect(exactAfter.quota.pending_request_id).toBe(reservation.requestId)
    expect(exactAfter.attempts).toEqual(exactBefore.attempts)
    expect(exactAfter.requests).toEqual({ count: (exactBefore.requests.count as number) + 1 })
    const db = new Database(reentryDatabase(exact.root))
    try {
      const request = db.query(`SELECT request_id,reservation_id,run_id,role,phase,binding_hash,owner_epoch_hash,charged,actual_dispatch
        FROM requests WHERE request_id=?`).get(reservation.requestId) as Record<string, unknown> | undefined
      expect(request).toEqual({ request_id: reservation.requestId, reservation_id: reservation.reservationId,
        run_id: exact.prepared.runId, role: "reviewer", phase: "safety", binding_hash: reservation.bindingSha256,
        owner_epoch_hash: exactAfter.run.owner_epoch_hash, charged: 1, actual_dispatch: null })
    } finally { db.close() }

    exact.controller.consumeDispatch(exact.owner, reservation.ticket, exact.current)
    exact.controller.recordDispatch(exact.owner, reservation.receipt, { state: "not-dispatched" })
    const afterNoDispatch = cleanupLedgerSnapshot(exact.root, exact.prepared.runId)
    expect(afterNoDispatch.run.artifact_bytes).toBe(exactAfter.run.artifact_bytes)
    expect(afterNoDispatch.usage.artifact_bytes).toBe(exactAfter.usage.artifact_bytes)
    expect(afterNoDispatch.usage.reviewer_requests).toBe(exactAfter.usage.reviewer_requests)
    expect(afterNoDispatch.requests).toEqual(exactAfter.requests)
    expect(afterNoDispatch.run.state).toBe("CANCELLED")
    expect(afterNoDispatch.quota.active_run_id).toBeNull()
    expect(afterNoDispatch.quota.pending_request_id).toBeNull()
    const noDispatchStatus = exact.controller.status()
    expect(noDispatchStatus.state).toBe("CANCELLED")
    expect(noDispatchStatus.pendingDispatch).toBe(false)
    const noDispatchDb = new Database(reentryDatabase(exact.root))
    try {
      expect(noDispatchDb.query("SELECT charged,dispatch_state,actual_dispatch FROM requests WHERE request_id=?")
        .get(reservation.requestId)).toStrictEqual({ charged: 1, dispatch_state: "not_dispatched", actual_dispatch: 0 })
    } finally { noDispatchDb.close() }
  })

  test.skipIf(!nativeClockSupported)("reserves and consumes one-use fixture-preflight artifact stages without changing readiness", async () => {
    const fixture = await reentryFixture("ARMED")
    addFreshDigests(fixture.root)
    if (!fixture.consent || !fixture.arm) throw new Error("armed fixture artifact stage is incomplete")
    const metadata = nativeCampaignArtifactMetadata(fixture, "fixture-preflight")
    const readinessBefore = fixture.controller.automaticReadiness({ owner: fixture.owner, prepared: fixture.prepared,
      consent: fixture.consent, arm: fixture.arm, current: fixture.current })
    const before = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    const allowance = fixture.controller.reserveNativeCampaignArtifactStage({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata })
    expect(Object.isFrozen(allowance)).toBe(true)
    expect(Object.keys(allowance)).toEqual([])
    const after = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    expect(after.run.state).toBe("ARMED")
    expect(after.run.revision).toBe((before.run.revision as number) + 1)
    expect(after.run.artifact_bytes).toBe((before.run.artifact_bytes as number) + metadata.bytes)
    expect(after.usage.artifact_bytes).toBe((before.usage.artifact_bytes as number) + metadata.bytes)
    expect(after.consent).toEqual(before.consent)
    expect(after.arm).toEqual(before.arm)
    expect(after.attempts).toEqual({ count: 0 })
    expect(after.requests).toEqual({ count: 0 })
    expect(fixture.runtime.runs.status().executions).toHaveLength(0)
    expect(fixture.controller.automaticReadiness({ owner: fixture.owner, prepared: fixture.prepared,
      consent: fixture.consent, arm: fixture.arm, current: fixture.current })).toEqual(readinessBefore)

    expect(() => fixture.controller.reserveNativeCampaignArtifactStage({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata: { ...metadata, planSha256: hash("changed plan") } }))
      .toThrow("binding-invalid")
    const afterDuplicate = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    expect(afterDuplicate.run.artifact_bytes).toBe(after.run.artifact_bytes)
    expect(afterDuplicate.usage.artifact_bytes).toBe(after.usage.artifact_bytes)

    fixture.controller.consumeNativeCampaignArtifactStage(allowance, { owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata })
    expect(() => fixture.controller.consumeNativeCampaignArtifactStage(allowance, { owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata })).toThrow("binding-invalid")
    const afterConsume = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    expect(afterConsume.run.artifact_bytes).toBe(after.run.artifact_bytes)
    expect(afterConsume.usage.artifact_bytes).toBe(after.usage.artifact_bytes)
  })

  test.skipIf(!nativeClockSupported)("reserves native campaign stages in PREPARED and CONSENTED without creating attempts or requests", async () => {
    for (const state of ["PREPARED", "CONSENTED"] as const) {
      const fixture = await reentryFixture(state)
      const metadata = nativeCampaignArtifactMetadata(fixture, "fixture-preflight")
      const before = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
      const allowance = fixture.controller.reserveNativeCampaignArtifactStage({ owner: fixture.owner, runtime: fixture.runtime,
        prepared: fixture.prepared, current: fixture.current, metadata })
      const after = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
      expect(after.run.state).toBe(state)
      expect(after.run.revision).toBe((before.run.revision as number) + 1)
      expect(after.run.artifact_bytes).toBe((before.run.artifact_bytes as number) + metadata.bytes)
      expect(after.usage.artifact_bytes).toBe((before.usage.artifact_bytes as number) + metadata.bytes)
      expect(after.consent).toEqual(before.consent)
      expect(after.arm).toEqual(before.arm)
      expect(after.attempts).toEqual({ count: 0 })
      expect(after.requests).toEqual({ count: 0 })
      fixture.controller.consumeNativeCampaignArtifactStage(allowance, { owner: fixture.owner, runtime: fixture.runtime,
        prepared: fixture.prepared, current: fixture.current, metadata })
    }
  })

  test.skipIf(!nativeClockSupported)("rejects copied, cross-scope, malformed, and changed native campaign stage allowances", async () => {
    const fixture = await reentryFixture("PREPARED")
    const metadata = nativeCampaignArtifactMetadata(fixture, "target-static", "qualification")
    const targetPlan = nativeCampaignTargetPlan(fixture, metadata)
    const allowance = fixture.controller.reserveNativeCampaignArtifactStage({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata, targetPlan })
    const expected = { owner: fixture.owner, runtime: fixture.runtime, prepared: fixture.prepared,
      current: fixture.current, metadata, targetPlan }
    expect(() => fixture.controller.consumeNativeCampaignArtifactStage(structuredClone(allowance), expected)).toThrow("binding-invalid")
    expect(() => fixture.controller.consumeNativeCampaignArtifactStage(JSON.parse(JSON.stringify(allowance)), expected))
      .toThrow("binding-invalid")

    const otherController = createSkillOptController(fixture.runtime,
      { nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! }, fixture.nativeHost)
    otherController.initialize()
    expect(() => otherController.consumeNativeCampaignArtifactStage(allowance, expected)).toThrow("binding-invalid")
    expect(() => fixture.controller.consumeNativeCampaignArtifactStage(allowance,
      { ...expected, runtime: { ...fixture.runtime } as ExecutionRuntime })).toThrow("owner-unavailable")
    const foreignOwner = reattachOwner(fixture.runtime, fixture.fixture.owners)
    try {
      expect(() => fixture.controller.consumeNativeCampaignArtifactStage(allowance, { ...expected, owner: foreignOwner }))
        .toThrow("owner-unavailable")
    } finally { releaseOwner(foreignOwner) }

    const selectedEntry = metadata.scheduleEntry
    if (!selectedEntry) throw new Error("response stage must bind its schedule entry")
    const changedEntry: SkillOptNativeCampaignArtifactScheduleEntry = selectedEntry.kind === "qualification"
      ? { ...selectedEntry, repeat: Number.MAX_SAFE_INTEGER }
      : { ...selectedEntry, replicate: Number.MAX_SAFE_INTEGER }
    const descriptors: readonly SkillOptNativeCampaignArtifactStageMetadata[] = [
      { ...metadata, rootBinding: hash("different root") },
      { ...metadata, bindingSha256: hash("different binding") },
      { ...metadata, scheduleSha256: hash("different schedule") },
      { ...metadata, fixtureId: fixture.dataset.fixturePack.fixtures[1]!.id },
      { ...metadata, scheduleEntry: changedEntry },
      { ...metadata, planSha256: hash("different plan") },
      { ...metadata, responseSha256: hash("different response") },
      { ...metadata, bytes: metadata.bytes + 1 },
    ]
    for (const changed of descriptors) {
      expect(() => fixture.controller.consumeNativeCampaignArtifactStage(allowance, { ...expected, metadata: changed }))
        .toThrow("binding-invalid")
    }
    expect(() => fixture.controller.consumeNativeCampaignArtifactStage(allowance,
      { ...expected, current: { ...fixture.current, baselineSkillSha256: hash("changed current") } }))
      .toThrow("binding-baseline-drift")
    expect(() => fixture.controller.reserveNativeCampaignArtifactStage({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata: { ...metadata, unexpected: true } as never, targetPlan }))
      .toThrow("binding-invalid")
    expect(() => fixture.controller.reserveNativeCampaignArtifactStage({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata: { ...metadata, fixtureId: "not-a-dataset-fixture" }, targetPlan }))
      .toThrow("binding-invalid")
    expect(() => fixture.controller.reserveNativeCampaignArtifactStage({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata: { ...metadata, scheduleEntry: changedEntry }, targetPlan }))
      .toThrow("binding-invalid")
    const invalidPreflight = nativeCampaignArtifactMetadata(fixture, "fixture-preflight")
    expect(() => fixture.controller.reserveNativeCampaignArtifactStage({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata: { ...invalidPreflight, responseSha256: hash("invented") } }))
      .toThrow("binding-invalid")
    const invalidStatic = nativeCampaignArtifactMetadata(fixture, "target-static")
    expect(() => fixture.controller.reserveNativeCampaignArtifactStage({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata: { ...invalidStatic, responseSha256: hash("invented") },
      targetPlan: nativeCampaignTargetPlan(fixture, invalidStatic) }))
      .toThrow("binding-invalid")
    const afterRefusals = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    expect(afterRefusals.run.artifact_bytes).toBe(metadata.bytes)
    expect(afterRefusals.usage.artifact_bytes).toBe(metadata.bytes)
    expect(afterRefusals.attempts).toEqual({ count: 0 })
    expect(afterRefusals.requests).toEqual({ count: 0 })

    fixture.controller.consumeNativeCampaignArtifactStage(allowance, expected)
  })

  test.skipIf(!nativeClockSupported)("refuses native campaign artifact stages on budget overflow, stale revision, or expiration", async () => {
    const overflow = await reentryFixture("PREPARED")
    const overflowMetadata = nativeCampaignArtifactMetadata(overflow, "target-static", "qualification")
    const overflowTargetPlan = nativeCampaignTargetPlan(overflow, overflowMetadata)
    const overflowDb = new Database(reentryDatabase(overflow.root))
    try {
      const nearCap = SKILLOPT_CONTROLLER_LIMITS.artifactBytes - overflowMetadata.bytes + 1
      overflowDb.query("UPDATE runs SET artifact_bytes=? WHERE run_id=?").run(nearCap, overflow.prepared.runId)
      overflowDb.query("UPDATE usage SET artifact_bytes=? WHERE run_id=?").run(nearCap, overflow.prepared.runId)
    } finally { overflowDb.close() }
    const overflowBefore = cleanupLedgerSnapshot(overflow.root, overflow.prepared.runId)
    expect(() => overflow.controller.reserveNativeCampaignArtifactStage({ owner: overflow.owner, runtime: overflow.runtime,
      prepared: overflow.prepared, current: overflow.current, metadata: overflowMetadata, targetPlan: overflowTargetPlan })).toThrow("budget-exhausted")
    const overflowAfter = cleanupLedgerSnapshot(overflow.root, overflow.prepared.runId)
    expect(overflowAfter.run.artifact_bytes).toBe(overflowBefore.run.artifact_bytes)
    expect(overflowAfter.usage.artifact_bytes).toBe(overflowBefore.usage.artifact_bytes)
    expect(overflowAfter.attempts).toEqual({ count: 0 })
    expect(overflowAfter.requests).toEqual({ count: 0 })

    const stale = await reentryFixture("PREPARED")
    const staleMetadata = nativeCampaignArtifactMetadata(stale, "target-static")
    const staleTargetPlan = nativeCampaignTargetPlan(stale, staleMetadata)
    const staleBefore = cleanupLedgerSnapshot(stale.root, stale.prepared.runId)
    const staleDb = new Database(reentryDatabase(stale.root))
    try { staleDb.query("UPDATE runs SET revision=revision+1 WHERE run_id=?").run(stale.prepared.runId) }
    finally { staleDb.close() }
    expect(() => stale.controller.reserveNativeCampaignArtifactStage({ owner: stale.owner, runtime: stale.runtime,
      prepared: stale.prepared, current: stale.current, metadata: staleMetadata, targetPlan: staleTargetPlan })).toThrow("revision-conflict")
    const staleAfter = cleanupLedgerSnapshot(stale.root, stale.prepared.runId)
    expect(staleAfter.run.artifact_bytes).toBe(staleBefore.run.artifact_bytes)
    expect(staleAfter.usage.artifact_bytes).toBe(staleBefore.usage.artifact_bytes)

    const expired = await reentryFixture("PREPARED")
    const expiredMetadata = nativeCampaignArtifactMetadata(expired, "fixture-preflight")
    expirePrivateTextRun(expired.root, expired.prepared.runId)
    expect(() => expired.controller.reserveNativeCampaignArtifactStage({ owner: expired.owner, runtime: expired.runtime,
      prepared: expired.prepared, current: expired.current, metadata: expiredMetadata })).toThrow("run-expired")
    const expiredAfter = cleanupLedgerSnapshot(expired.root, expired.prepared.runId)
    expect(expiredAfter.run.artifact_bytes).toBe(0)
    expect(expiredAfter.usage.artifact_bytes).toBe(0)
    expect(expiredAfter.attempts).toEqual({ count: 0 })
    expect(expiredAfter.requests).toEqual({ count: 0 })
  })

  test.skipIf(!nativeClockSupported)("atomically precharges and consumes RUNNING campaign stage artifacts from a genuine dispatch", async () => {
    const fixture = await reentryFixture("CONSENTED")
    const metadata = nativeCampaignArtifactMetadata(fixture, "target-static", "training")
    const targetPlan = nativeCampaignTargetPlan(fixture, metadata)
    await makeRunningNativeFixture(fixture)
    const before = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    const allowance = fixture.controller.reserveNativeCampaignArtifactStage({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata, targetPlan })
    const after = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    expect(after.run.state).toBe("RUNNING")
    expect(after.run.revision).toBe(before.run.revision)
    expect(after.run.artifact_bytes).toBe((before.run.artifact_bytes as number) + metadata.bytes)
    expect(after.usage.artifact_bytes).toBe((before.usage.artifact_bytes as number) + metadata.bytes)
    expect(after.attempts).toEqual(before.attempts)
    expect(after.requests).toEqual(before.requests)
    fixture.controller.consumeNativeCampaignArtifactStage(allowance, { owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata, targetPlan })

    const expired = await reentryFixture("CONSENTED")
    const expiredMetadata = nativeCampaignArtifactMetadata(expired, "target-static")
    const expiredTargetPlan = nativeCampaignTargetPlan(expired, expiredMetadata)
    await makeRunningNativeFixture(expired)
    const expiredAllowance = expired.controller.reserveNativeCampaignArtifactStage({ owner: expired.owner, runtime: expired.runtime,
      prepared: expired.prepared, current: expired.current, metadata: expiredMetadata, targetPlan: expiredTargetPlan })
    expirePrivateTextRun(expired.root, expired.prepared.runId)
    expect(() => expired.controller.consumeNativeCampaignArtifactStage(expiredAllowance, { owner: expired.owner,
      runtime: expired.runtime, prepared: expired.prepared, current: expired.current, metadata: expiredMetadata,
      targetPlan: expiredTargetPlan }))
      .toThrow("run-expired")
  })

  test.skipIf(!nativeClockSupported)("refuses fake completed-target witnesses without changing accounting", async () => {
    const fixture = await reentryFixture("CONSENTED")
    const schedule = buildNativeCampaignSchedule(fixture.dataset.fixturePack)
    const scheduleEntry: SkillOptNativeCampaignArtifactScheduleEntry = { kind: "training", ...schedule.training[0]! }
    const targetPlan = fixture.controller.prepareNativeCampaignTarget({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, scheduleEntry })
    let target: SkillOptNativeCampaignTargetBinding | undefined
    const reservation = await makeRunningNativeFixture(fixture, issued => {
      target = fixture.controller.bindNativeCampaignTargetReservation({ owner: fixture.owner, runtime: fixture.runtime,
        prepared: fixture.prepared, current: fixture.current, targetPlan, reservation: issued })
    })
    const targetBinding = target
    if (!targetBinding) throw new Error("test reservation was not bound to its target plan")
    const before = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    expect(() => fixture.controller.admitNativeCampaignTargetResponse({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, target: targetBinding, targetWitness: {} as never }))
      .toThrow("dispatch-not-authorized")
    const responseMetadata = nativeCampaignArtifactMetadata(fixture, "adapter-response")
    expect(() => fixture.controller.reserveNativeCampaignArtifactStage({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, metadata: responseMetadata, reservation }))
      .toThrow("dispatch-not-authorized")
    const after = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    expect(after.run.state).toBe(before.run.state)
    expect(after.run.revision).toBe(before.run.revision)
    expect(after.run.artifact_bytes).toBe(before.run.artifact_bytes)
    expect(after.usage.artifact_bytes).toBe(before.usage.artifact_bytes)
    expect(after.requests).toEqual(before.requests)
  })

  test.skipIf(!nativeClockSupported)("rejects invalid target tuples and forged trainer events", async () => {
    const fixture = await reentryFixture("CONSENTED")
    const schedule = buildNativeCampaignSchedule(fixture.dataset.fixturePack)
    const training = schedule.training[0]!
    const wrongTrainingTuple: SkillOptNativeCampaignArtifactScheduleEntry = { kind: "training", ...training,
      replicate: training.replicate + 1 }
    expect(() => fixture.controller.prepareNativeCampaignTarget({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, scheduleEntry: wrongTrainingTuple })).toThrow("binding-invalid")

    const trainerSelection: SkillOptNativeCampaignArtifactScheduleEntry = {
      kind: "trainerSelection", ...schedule.trainerSelection[0]!,
    }
    const candidateQualification: SkillOptNativeCampaignArtifactScheduleEntry = {
      kind: "qualification", ...schedule.qualification.find(item => item.variant === "candidate")!,
    }
    expect(() => fixture.controller.prepareNativeCampaignTarget({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, scheduleEntry: { kind: "training", ...training },
      trainerEvent: {} as never })).toThrow("dispatch-not-authorized")
    expect(() => fixture.controller.prepareNativeCampaignTarget({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, scheduleEntry: trainerSelection,
      trainerEvent: {} as never })).toThrow("dispatch-not-authorized")
    expect(() => fixture.controller.prepareNativeCampaignTarget({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, scheduleEntry: { kind: "training", ...training },
      trainerEvent: { kind: "rollout", cohort: "candidate-selection" } as never })).toThrow("dispatch-not-authorized")
    expect(() => fixture.controller.prepareNativeCampaignTarget({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, scheduleEntry: trainerSelection,
      trainerEvent: { kind: "rollout", cohort: "training" } as never })).toThrow("dispatch-not-authorized")
    expect(() => fixture.controller.prepareNativeCampaignTarget({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, scheduleEntry: candidateQualification,
      trainerEvent: {} as never })).toThrow("dispatch-not-authorized")

    const running = await reentryFixture("CONSENTED")
    await makeRunningNativeFixture(running)
    const runningSchedule = buildNativeCampaignSchedule(running.dataset.fixturePack)
    expect(() => running.controller.prepareNativeCampaignTarget({ owner: running.owner, runtime: running.runtime,
      prepared: running.prepared, current: running.current,
      scheduleEntry: { kind: "training", ...runningSchedule.training[2]! } })).toThrow("dispatch-not-authorized")
  })

  test.skipIf(!nativeClockSupported)("refuses optimizer-response authority from forged events, reservations, and witnesses", async () => {
    const fixture = await reentryFixture("CONSENTED")
    const before = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    const forgedEvent = Object.freeze({}) as never
    const forgedReservation = Object.freeze({ role: "target", phase: "train" }) as never
    const forgedWitness = Object.freeze({}) as never
    expect(() => fixture.controller.reserveNativeTrainerOptimizerResponse({ owner: fixture.owner, runtime: fixture.runtime,
      prepared: fixture.prepared, current: fixture.current, event: forgedEvent, reservation: forgedReservation,
      optimizerWitness: forgedWitness, responseText: "synthetic optimizer response" })).toThrow("binding-invalid")
    expect(() => fixture.controller.consumeNativeTrainerOptimizerResponse(Object.freeze({}) as never, {
      owner: fixture.owner, runtime: fixture.runtime, prepared: fixture.prepared, current: fixture.current,
      event: forgedEvent, reservation: forgedReservation,
    })).toThrow("binding-invalid")
    const after = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
    expect(after.run.state).toBe(before.run.state)
    expect(after.run.revision).toBe(before.run.revision)
    expect(after.run.artifact_bytes).toBe(before.run.artifact_bytes)
    expect(after.usage.artifact_bytes).toBe(before.usage.artifact_bytes)
    expect(after.requests).toEqual(before.requests)
  })

  test.skipIf(!nativeClockSupported)("refuses preparation charges over cap, stale or busy ownership, expired runs, and dispatch", async () => {
    const fixture = await reentryFixture("PREPARED")
    for (const bytes of [-1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, SKILLOPT_CONTROLLER_LIMITS.artifactBytes + 1]) {
      expect(() => fixture.controller.reserveNativePreparationArtifacts({ owner: fixture.owner, runtime: fixture.runtime,
        runId: fixture.prepared.runId, current: fixture.current, bytes })).toThrow("budget-exhausted")
    }
    expect(() => fixture.controller.reserveNativePreparationArtifacts({ owner: fixture.owner, runtime: fixture.runtime,
      runId: fixture.prepared.runId, current: { ...fixture.current, baselineSkillSha256: hash("stale baseline") }, bytes: 1 }))
      .toThrow("binding-baseline-drift")

    const staleRevision = await reentryFixture("PREPARED")
    const beforeStaleRevision = cleanupLedgerSnapshot(staleRevision.root, staleRevision.prepared.runId)
    let changedRevision = false
    const revisionRaceCurrent = new Proxy(staleRevision.current, {
      get(target, property, receiver) {
        if (property === "dataset" && !changedRevision) {
          changedRevision = true
          const db = new Database(reentryDatabase(staleRevision.root))
          try { db.query("UPDATE runs SET revision=revision+1 WHERE run_id=?").run(staleRevision.prepared.runId) }
          finally { db.close() }
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    expect(() => staleRevision.controller.reserveNativePreparationArtifacts({ owner: staleRevision.owner,
      runtime: staleRevision.runtime, runId: staleRevision.prepared.runId, current: revisionRaceCurrent, bytes: 1 }))
      .toThrow("revision-conflict")
    const afterStaleRevision = cleanupLedgerSnapshot(staleRevision.root, staleRevision.prepared.runId)
    expect(afterStaleRevision.run.revision).toBe((beforeStaleRevision.run.revision as number) + 1)
    expect(afterStaleRevision.run.artifact_bytes).toBe(0)
    expect(afterStaleRevision.usage.artifact_bytes).toBe(0)

    const busyFixture = await reentryFixture("PREPARED")
    const busyClaim = busyFixture.runtime.runs.claim(busyFixture.owner.sessionID, `preparation-reserve-${randomUUID()}`, process.pid)
    try {
      expect(() => busyFixture.controller.reserveNativePreparationArtifacts({ owner: busyFixture.owner, runtime: busyFixture.runtime,
        runId: busyFixture.prepared.runId, current: busyFixture.current, bytes: 1 })).toThrow("owner-busy")
    } finally { busyFixture.runtime.runs.release(busyClaim) }

    const staleOwner = reattachOwner(busyFixture.runtime, busyFixture.fixture.owners)
    try {
      expect(() => busyFixture.controller.reserveNativePreparationArtifacts({ owner: staleOwner, runtime: busyFixture.runtime,
        runId: busyFixture.prepared.runId, current: busyFixture.current, bytes: 1 })).toThrow("owner-unavailable")
    } finally { releaseOwner(staleOwner) }

    const expired = await reentryFixture("PREPARED")
    expirePrivateTextRun(expired.root, expired.prepared.runId)
    expect(() => expired.controller.reserveNativePreparationArtifacts({ owner: expired.owner, runtime: expired.runtime,
      runId: expired.prepared.runId, current: expired.current, bytes: 1 })).toThrow("run-expired")

    const dispatch = await reentryFixture("PREPARED")
    const dispatchDb = new Database(reentryDatabase(dispatch.root))
    try { dispatchDb.query("UPDATE quota SET pending_request_id=? WHERE singleton=1").run(randomUUID()) }
    finally { dispatchDb.close() }
    expect(() => dispatch.controller.reserveNativePreparationArtifacts({ owner: dispatch.owner, runtime: dispatch.runtime,
      runId: dispatch.prepared.runId, current: dispatch.current, bytes: 1 })).toThrow("dispatch-pending")

    const active = await reentryFixture("PREPARED")
    const activeDb = new Database(reentryDatabase(active.root))
    try { activeDb.query("UPDATE quota SET active_run_id=? WHERE singleton=1").run(randomUUID()) }
    finally { activeDb.close() }
    expect(() => active.controller.reserveNativePreparationArtifacts({ owner: active.owner, runtime: active.runtime,
      runId: active.prepared.runId, current: active.current, bytes: 1 })).toThrow("active-run")

    const atCap = await reentryFixture("PREPARED")
    const capDb = new Database(reentryDatabase(atCap.root))
    try {
      capDb.exec("BEGIN IMMEDIATE")
      capDb.query("UPDATE runs SET artifact_bytes=? WHERE run_id=?").run(SKILLOPT_CONTROLLER_LIMITS.artifactBytes, atCap.prepared.runId)
      capDb.query("UPDATE usage SET artifact_bytes=? WHERE run_id=?").run(SKILLOPT_CONTROLLER_LIMITS.artifactBytes, atCap.prepared.runId)
      capDb.exec("COMMIT")
    } catch (error) {
      try { capDb.exec("ROLLBACK") } catch { /* Preserve the fixture setup failure. */ }
      throw error
    } finally { capDb.close() }
    expect(() => atCap.controller.reserveNativePreparationArtifacts({ owner: atCap.owner, runtime: atCap.runtime,
      runId: atCap.prepared.runId, current: atCap.current, bytes: 1 })).toThrow("budget-exhausted")
  })

  test.skipIf(!nativeClockSupported)("preserves resolved failure and cancellation states without deleting ledger evidence", async () => {
    for (const state of ["CANCELLED", "NO_GAIN", "INCONCLUSIVE", "FAILED"] as const) {
      const fixture = await reentryFixture("PREPARED")
      if (state === "CANCELLED") fixture.controller.cancelUnstarted(fixture.owner, fixture.prepared.runId)
      else {
        const db = new Database(reentryDatabase(fixture.root))
        try { db.query("UPDATE runs SET state=?,reason_code=NULL,revision=revision+1 WHERE run_id=?").run(state, fixture.prepared.runId) }
        finally { db.close() }
      }
      expirePrivateTextRun(fixture.root, fixture.prepared.runId)
      const before = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
      const mutationClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
      try {
        const artifactsSha256 = hash(`foreground-manifest:${state}`)
        const prepared = fixture.controller.preparePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
          mutationClaim, runId: fixture.prepared.runId, artifactsSha256, artifactBytes: 0, trainerSnapshotSha256: null })
        const retired = fixture.controller.retirePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
          mutationClaim, challenge: prepared.challenge, decision: await approveReentry(prepared.decisionBinding) })
        const after = cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId)
        expect(retired.state).toBe(state)
        expect(after.run.state).toBe(state)
        expect(after.run.revision).toBe((before.run.revision as number) + 1)
        expect(after.usage).toEqual(before.usage)
        expect(after.attempts).toEqual(before.attempts)
        expect(after.requests).toEqual(before.requests)
        expect(after.provenance).toEqual(before.provenance)
      } finally { fixture.runtime.runs.release(mutationClaim) }
    }
  })

  test.skipIf(!nativeClockSupported)("refuses unexpired, foreign-boot, pending, and unknown dispatch retirement", async () => {
    const unexpired = await reentryFixture("PREPARED")
    const resolvedDb = new Database(reentryDatabase(unexpired.root))
    try { resolvedDb.query("UPDATE runs SET state='NO_GAIN',revision=revision+1 WHERE run_id=?").run(unexpired.prepared.runId) }
    finally { resolvedDb.close() }
    const unexpiredClaim = unexpired.runtime.runs.claim(unexpired.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    try {
      expect(() => unexpired.controller.preparePrivateTextCleanup({ owner: unexpired.owner, runtime: unexpired.runtime,
        mutationClaim: unexpiredClaim, runId: unexpired.prepared.runId, artifactsSha256: hash("unexpired"), artifactBytes: 0,
        trainerSnapshotSha256: null }))
        .toThrow("private-text-cleanup-not-expired")
    } finally { unexpired.runtime.runs.release(unexpiredClaim) }

    const foreignBoot = await reentryFixture("PREPARED")
    expirePrivateTextRun(foreignBoot.root, foreignBoot.prepared.runId, bootB)
    const foreignBootClaim = foreignBoot.runtime.runs.claim(foreignBoot.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    try {
      expect(() => foreignBoot.controller.preparePrivateTextCleanup({ owner: foreignBoot.owner, runtime: foreignBoot.runtime,
        mutationClaim: foreignBootClaim, runId: foreignBoot.prepared.runId, artifactsSha256: hash("foreign-boot"), artifactBytes: 0,
        trainerSnapshotSha256: null }))
        .toThrow("private-text-cleanup-ineligible")
    } finally { foreignBoot.runtime.runs.release(foreignBootClaim) }

    const pending = await reentryFixture("CONSENTED")
    const pendingReservation = pending.controller.reserveManual({ owner: pending.owner, prepared: pending.prepared,
      consent: pending.consent!, current: pending.current })
    const pendingClaim = pending.runtime.runs.claim(pending.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    try {
      expect(() => pending.controller.preparePrivateTextCleanup({ owner: pending.owner, runtime: pending.runtime,
        mutationClaim: pendingClaim, runId: pending.prepared.runId, artifactsSha256: hash("pending"), artifactBytes: 0,
        trainerSnapshotSha256: null }))
        .toThrow("dispatch-pending")
    } finally {
      pending.runtime.runs.release(pendingClaim)
      expect(pendingReservation.requestId).toMatch(/^[0-9a-f-]{36}$/iu)
    }

    const unknown = await reentryFixture("CONSENTED")
    const unknownReservation = unknown.controller.reserveManual({ owner: unknown.owner, prepared: unknown.prepared,
      consent: unknown.consent!, current: unknown.current })
    unknown.controller.consumeDispatch(unknown.owner, unknownReservation.ticket, unknown.current)
    unknown.controller.recordDispatch(unknown.owner, unknownReservation.receipt, { state: "ambiguous" })
    const unknownClaim = unknown.runtime.runs.claim(unknown.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    try {
      expect(() => unknown.controller.preparePrivateTextCleanup({ owner: unknown.owner, runtime: unknown.runtime,
        mutationClaim: unknownClaim, runId: unknown.prepared.runId, artifactsSha256: hash("unknown"), artifactBytes: 0,
        trainerSnapshotSha256: null }))
        .toThrow("dispatch-pending")
    } finally { unknown.runtime.runs.release(unknownClaim) }

    const awaitingApproval = await reentryFixture("PREPARED")
    const awaitingDb = new Database(reentryDatabase(awaitingApproval.root))
    try { awaitingDb.query("UPDATE runs SET state='AWAITING_CANDIDATE_APPROVAL',revision=revision+1 WHERE run_id=?")
      .run(awaitingApproval.prepared.runId) }
    finally { awaitingDb.close() }
    expirePrivateTextRun(awaitingApproval.root, awaitingApproval.prepared.runId)
    const awaitingClaim = awaitingApproval.runtime.runs.claim(awaitingApproval.owner.sessionID,
      `private-cleanup-${randomUUID()}`, process.pid)
    try {
      expect(() => awaitingApproval.controller.preparePrivateTextCleanup({ owner: awaitingApproval.owner,
        runtime: awaitingApproval.runtime, mutationClaim: awaitingClaim, runId: awaitingApproval.prepared.runId,
        artifactsSha256: hash("awaiting-candidate-approval"), artifactBytes: 0, trainerSnapshotSha256: null }))
        .toThrow("private-text-cleanup-ineligible")
    } finally { awaitingApproval.runtime.runs.release(awaitingClaim) }

    for (const state of ["COMPLETED", "ROLLED_BACK"] as const) {
      const terminal = await reentryFixture("PREPARED")
      const terminalDb = new Database(reentryDatabase(terminal.root))
      try { terminalDb.query("UPDATE runs SET state=?,revision=revision+1 WHERE run_id=?").run(state, terminal.prepared.runId) }
      finally { terminalDb.close() }
      const terminalClaim = terminal.runtime.runs.claim(terminal.owner.sessionID,
        `private-cleanup-${randomUUID()}`, process.pid)
      try {
        expect(() => terminal.controller.preparePrivateTextCleanup({ owner: terminal.owner, runtime: terminal.runtime,
          mutationClaim: terminalClaim, runId: terminal.prepared.runId, artifactsSha256: hash(`missing-${state}-handoff`),
          artifactBytes: 0, trainerSnapshotSha256: null })).toThrow("private-text-cleanup-ineligible")
      } finally { terminal.runtime.runs.release(terminalClaim) }
    }
  })

  test.skipIf(!nativeClockSupported)("rejects copied claims, foreign runtimes, stale claims, and changed revisions", async () => {
    const fixture = await reentryFixture("PREPARED")
    expirePrivateTextRun(fixture.root, fixture.prepared.runId)
    const firstClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    const artifactsSha256 = hash("foreground-manifest:resume")
    const foreignRuntime = Object.create(fixture.runtime) as ExecutionRuntime
    expect(() => fixture.controller.preparePrivateTextCleanup({ owner: fixture.owner, runtime: foreignRuntime,
      mutationClaim: firstClaim, runId: fixture.prepared.runId, artifactsSha256, artifactBytes: 0,
      trainerSnapshotSha256: null })).toThrow("owner-unavailable")
    const first = fixture.controller.preparePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
      mutationClaim: firstClaim, runId: fixture.prepared.runId, artifactsSha256, artifactBytes: 0, trainerSnapshotSha256: null })
    const copiedClaim = structuredClone(firstClaim)
    const firstReceipt = await approveReentry(first.decisionBinding)
    expect(() => fixture.controller.retirePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
      mutationClaim: copiedClaim, challenge: first.challenge, decision: firstReceipt })).toThrow("owner-unavailable")
    fixture.runtime.runs.release(firstClaim)

    const currentClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    let staleChallenge: ReturnType<typeof fixture.controller.preparePrivateTextCleanup> | undefined
    let staleReceipt: OperatorDecision | undefined
    try {
      staleChallenge = fixture.controller.preparePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: currentClaim, runId: fixture.prepared.runId, artifactsSha256, artifactBytes: 0, trainerSnapshotSha256: null })
      staleReceipt = await approveReentry(staleChallenge.decisionBinding)
    } finally { fixture.runtime.runs.release(currentClaim) }
    if (!staleChallenge || !staleReceipt) throw new Error("cleanup challenge fixture was not prepared")
    const replacementClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    try {
      expect(() => fixture.controller.retirePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: replacementClaim, challenge: staleChallenge.challenge, decision: staleReceipt })).toThrow("owner-unavailable")
    } finally { fixture.runtime.runs.release(replacementClaim) }

    const revisionClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    try {
      const revisionChallenge = fixture.controller.preparePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: revisionClaim, runId: fixture.prepared.runId, artifactsSha256, artifactBytes: 0, trainerSnapshotSha256: null })
      const revisionReceipt = await approveReentry(revisionChallenge.decisionBinding)
      const db = new Database(reentryDatabase(fixture.root))
      try { db.query("UPDATE runs SET revision=revision+1 WHERE run_id=?").run(fixture.prepared.runId) }
      finally { db.close() }
      expect(() => fixture.controller.retirePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: revisionClaim, challenge: revisionChallenge.challenge, decision: revisionReceipt })).toThrow("revision-conflict")
    } finally { fixture.runtime.runs.release(revisionClaim) }
  })

  test.skipIf(!nativeClockSupported)("requires a fresh genuine decision and identical manifest to resume an existing retirement", async () => {
    const fixture = await reentryFixture("PREPARED")
    expirePrivateTextRun(fixture.root, fixture.prepared.runId)
    const artifactsSha256 = hash("foreground-manifest:resume")
    const artifactBytes = 37
    const firstClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    let initialRetirement: ReturnType<typeof fixture.controller.retirePrivateTextCleanup> | undefined
    try {
      const prepared = fixture.controller.preparePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: firstClaim, runId: fixture.prepared.runId, artifactsSha256, artifactBytes, trainerSnapshotSha256: null })
      initialRetirement = fixture.controller.retirePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: firstClaim, challenge: prepared.challenge, decision: await approveReentry(prepared.decisionBinding) })
    } finally { fixture.runtime.runs.release(firstClaim) }
    if (!initialRetirement) throw new Error("initial cleanup retirement was not created")
    releaseOwner(fixture.owner)
    expect(() => consumePrivateTextCleanupDeletion(initialRetirement!.inputDeletion, { worktree: fixture.root,
      runId: fixture.prepared.runId, kind: "input", snapshotSha256: artifactsSha256 })).toThrow("owner-unavailable")
    const newOwner = reattachOwner(fixture.runtime, fixture.fixture.owners)
    const newClaim = fixture.runtime.runs.claim(newOwner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    try {
      const restarted = createSkillOptController(fixture.runtime,
        { nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! }, fixture.nativeHost)
      restarted.initialize()
      expect(() => restarted.preparePrivateTextCleanup({ owner: newOwner, runtime: fixture.runtime, mutationClaim: newClaim,
        runId: fixture.prepared.runId, artifactsSha256: hash("different-foreground-manifest"), artifactBytes: 0,
        trainerSnapshotSha256: null }))
        .toThrow("consent-binding-drift")
      const resumed = restarted.preparePrivateTextCleanup({ owner: newOwner, runtime: fixture.runtime, mutationClaim: newClaim,
        runId: fixture.prepared.runId, artifactsSha256, artifactBytes, trainerSnapshotSha256: null })
      expect(resumed.metadata.state).toBe("EXPIRED")
      const retirement = restarted.retirePrivateTextCleanup({ owner: newOwner, runtime: fixture.runtime,
        mutationClaim: newClaim, challenge: resumed.challenge, decision: await approveReentry(resumed.decisionBinding) })
      expect(retirement).toMatchObject({ state: "EXPIRED", artifactsSha256, artifactBytes, resumed: true,
        revision: initialRetirement.revision + 1 })
      consumePrivateTextCleanupDeletion(retirement.inputDeletion, { worktree: fixture.root, runId: fixture.prepared.runId,
        kind: "input", snapshotSha256: artifactsSha256 })
      expect(cleanupLedgerSnapshot(fixture.root, fixture.prepared.runId).usage.artifact_bytes).toBe(artifactBytes * 2)
      const db = new Database(reentryDatabase(fixture.root))
      try {
        expect((db.query("SELECT count(*) AS count FROM private_cleanup_retirements WHERE run_id=?")
          .get(fixture.prepared.runId) as { count: number }).count).toBe(2)
        expect(db.query("SELECT artifact_bytes_charged FROM private_cleanup_retirements WHERE run_id=? ORDER BY run_revision_after")
          .all(fixture.prepared.runId)).toEqual([{ artifact_bytes_charged: artifactBytes }, { artifact_bytes_charged: artifactBytes }])
      } finally { db.close() }
      expect(fixture.runtime.runs.status().executions).toHaveLength(0)
    } finally { fixture.runtime.runs.release(newClaim) }
  })

  test.skipIf(!nativeClockSupported)("issues one-use deletion tokens only for the latest exact retirement and snapshot", async () => {
    const fixture = await reentryFixture("PREPARED")
    expirePrivateTextRun(fixture.root, fixture.prepared.runId)
    const artifactsSha256 = hash("foreground-manifest:deletion-token")
    const trainerSnapshotSha256 = hash("trainer-snapshot:deletion-token")
    const claim = fixture.runtime.runs.claim(fixture.owner.sessionID, `private-cleanup-${randomUUID()}`, process.pid)
    try {
      const firstChallenge = fixture.controller.preparePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: claim, runId: fixture.prepared.runId, artifactsSha256, artifactBytes: 0, trainerSnapshotSha256 })
      const firstDecision = await approveReentry(firstChallenge.decisionBinding)
      const firstRetirement = fixture.controller.retirePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: claim, challenge: firstChallenge.challenge, decision: firstDecision })

      const latestChallenge = fixture.controller.preparePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: claim, runId: fixture.prepared.runId, artifactsSha256, artifactBytes: 0, trainerSnapshotSha256 })
      const latestDecision = await approveReentry(latestChallenge.decisionBinding)
      const latestRetirement = fixture.controller.retirePrivateTextCleanup({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: claim, challenge: latestChallenge.challenge, decision: latestDecision })

      expect(() => consumePrivateTextCleanupDeletion(firstRetirement.inputDeletion, { worktree: fixture.root,
        runId: fixture.prepared.runId, kind: "input", snapshotSha256: artifactsSha256 })).toThrow("revision-conflict")
      expect(() => consumePrivateTextCleanupDeletion(latestRetirement.trainerDeletion!, { worktree: fixture.root,
        runId: fixture.prepared.runId, kind: "trainer", snapshotSha256: hash("different trainer snapshot") }))
        .toThrow("consent-binding-drift")
      expect(() => consumePrivateTextCleanupDeletion(latestRetirement.trainerDeletion!, { worktree: fixture.root,
        runId: fixture.prepared.runId, kind: "trainer", snapshotSha256: trainerSnapshotSha256 })).toThrow("consent-required")
      consumePrivateTextCleanupDeletion(latestRetirement.inputDeletion, { worktree: fixture.root,
        runId: fixture.prepared.runId, kind: "input", snapshotSha256: artifactsSha256 })
    } finally { fixture.runtime.runs.release(claim) }
  })

  test("uses fixed native-v1 caps and retains the final/safety and canary target reserve", () => {
    expect(SKILLOPT_CONTROLLER_LIMITS.minimumNewDigests).toBe(5)
    expect(SKILLOPT_CONTROLLER_LIMITS.dailyCooldownMilliseconds).toBe(24 * 60 * 60 * 1000)
    expect(SKILLOPT_CONTROLLER_LIMITS.targetReservedRequests).toBe(232)
    expect(SKILLOPT_CONTROLLER_LIMITS.targetRequests).toBe(512)
    expect(SKILLOPT_CONTROLLER_LIMITS.optimizerRequests).toBe(40)
    expect(SKILLOPT_CONTROLLER_LIMITS.reviewerRequests).toBe(2)
    expect(SKILLOPT_CONTROLLER_LIMITS.activeMilliseconds).toBe(21_600_000)
    expect(SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds).toBe(120_000)
    expect(SKILLOPT_CONTROLLER_LIMITS.artifactBytes).toBe(256 * 1024 * 1024)
    expect(SKILLOPT_CONTROLLER_LIMITS.candidateSteps).toBe(1)
  })

  test("clock sample parser rejects malformed, signed, non-canonical, and wrong-protocol samples", () => {
    const valid: SkillOptClockSample = {
      protocol: "skillopt-promotion.v3", platform: "darwin", bootId: bootA,
      continuousNanoseconds: "42", wallMilliseconds: "1700000000000",
    }
    expect(validateSkillOptClockSample(valid)).toEqual(valid)
    expect(() => validateSkillOptClockSample({ ...valid, continuousNanoseconds: "042" })).toThrow(SkillOptControllerError)
    expect(() => validateSkillOptClockSample({ ...valid, wallMilliseconds: "-1" })).toThrow(SkillOptControllerError)
    expect(() => validateSkillOptClockSample({ ...valid, protocol: "skillopt-promotion.v2" })).toThrow(SkillOptControllerError)
    expect(() => validateSkillOptClockSample({ ...valid, bootId: "" })).toThrow(SkillOptControllerError)
    expect(() => validateSkillOptClockSample({ ...valid, continuousNanoseconds: "18446744073709551616" })).toThrow(SkillOptControllerError)
    expect(() => validateSkillOptClockSample({ ...valid, wallMilliseconds: "18446744073709551616" })).toThrow(SkillOptControllerError)
    expect(() => validateSkillOptClockSample({ ...valid, extra: true })).toThrow(SkillOptControllerError)
  })

  test("uses only complete successful metadata digests with safe knowledge paths, deduplicated by session ID", () => {
    const result = eligibleSkillOptDigests([
      digest("session-a", { endedAt: 10 }),
      digest("session-a", { endedAt: 20 }),
      digest("session-b", { files: ["../knowledge/private.md"] }),
      digest("session-c", { complete: false }),
      digest("session-d", { outcome: "abandoned" }),
      digest("session-e", { files: [".agents/skills/llm-wiki/SKILL.md"] }),
    ])
    expect(result.digests.map(({ sessionID, endedAt }) => [sessionID, endedAt])).toEqual([["session-e", 2], ["session-a", 20]])
    expect(result.digests.every((item) => item.sessionIDHash === hash(item.sessionID))).toBe(true)
    expect(result.watermarkSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  test("JSON-shaped approval data cannot become a real terminal decision or be replayed", () => {
    const fake = { action: "approve", workflowID: randomUUID(), subject: { kind: "experiment-unit", id: "x", sha256: "a".repeat(64) } }
    expect(() => consumeOperatorDecision(fake)).toThrow("not issued by the terminal reader")
    expect(() => consumeOperatorDecision(fake)).toThrow("not issued by the terminal reader")
  })

  test.skipIf(!nativeClockSupported)("new foreground re-enters the same armed run only with a one-use terminal receipt", async () => {
    const fixture = await reentryFixture("ARMED")
    const expectedSchedule = buildNativeCampaignSchedule((fixture.current.dataset as NativeDataset).fixturePack)
    expect(fixture.prepared).toMatchObject({
      scheduleSha256: expectedSchedule.scheduleSha256, targetRequests: 432, canaryReserve: 16, targetRequestCap: 512,
    })
    expect(fixture.consent).toMatchObject({
      scheduleSha256: expectedSchedule.scheduleSha256, targetRequests: 432, canaryReserve: 16, targetRequestCap: 512,
    })
    addFreshDigests(fixture.root)
    const before = fixture.controller.status()
    releaseOwner(fixture.owner)
    const owner = reattachOwner(fixture.runtime, fixture.fixture.owners)
    const controller = createSkillOptController(fixture.runtime,
      { nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! }, fixture.nativeHost)
    controller.initialize()
    const challenge = controller.prepareReentry({ owner, runId: fixture.prepared.runId, current: fixture.current })
    expect(challenge).toMatchObject({
      scheduleSha256: expectedSchedule.scheduleSha256, targetRequests: 432, canaryReserve: 16, targetRequestCap: 512,
    })
    const copied = JSON.parse(JSON.stringify(challenge)) as typeof challenge
    const fake = { action: "approve", ...challenge.decisionBinding } as OperatorDecision
    expect(() => controller.acceptReentry(challenge, fake, fixture.current)).toThrow("terminal reader")
    const firstReceipt = await approveReentry(challenge.decisionBinding)
    expect(() => controller.acceptReentry(copied, firstReceipt, fixture.current)).toThrow("consent-required")
    const receipt = await approveReentry(challenge.decisionBinding)
    const restored = controller.acceptReentry(challenge, receipt, fixture.current)
    expect(restored.state).toBe("ARMED")
    if (restored.state !== "ARMED") throw new Error("armed reentry was not preserved")
    expect(restored.prepared.runId).toBe(fixture.prepared.runId)
    expect(restored.prepared).toMatchObject({ scheduleSha256: expectedSchedule.scheduleSha256, targetRequests: 432, canaryReserve: 16, targetRequestCap: 512 })
    expect(restored.consent).toMatchObject({ scheduleSha256: expectedSchedule.scheduleSha256, targetRequests: 432, canaryReserve: 16, targetRequestCap: 512 })
    expect(restored.arm.armId).toBe(fixture.arm!.armId)
    expect(restored.arm.digestWatermarkSha256).toBe(fixture.arm!.digestWatermarkSha256)
    expect(controller.status().remaining).toEqual(before.remaining)
    expect(controller.status().requestCounts).toEqual(before.requestCounts)
    expect(fixture.runtime.runs.status().claim).toBeUndefined()
    const beforeStaleReservations = controller.status()
    const replayReceipt = await approveReentry(challenge.decisionBinding)
    expect(() => controller.acceptReentry(challenge, replayReceipt, fixture.current)).toThrow("consent-required")
    expect(() => fixture.controller.reserveManual({ owner: fixture.owner, prepared: fixture.prepared,
      consent: fixture.consent!, current: fixture.current })).toThrow("consent-required")
    expect(() => fixture.controller.reserveAutomatic({ owner: fixture.owner, prepared: fixture.prepared,
      consent: fixture.consent!, arm: fixture.arm!, current: fixture.current })).toThrow("owner-unavailable")
    expect(controller.status().requestCounts).toEqual(beforeStaleReservations.requestCounts)
    expect(controller.status().remaining).toEqual(beforeStaleReservations.remaining)

    const reservation = controller.reserveAutomatic({ owner, prepared: restored.prepared, consent: restored.consent,
      arm: restored.arm, current: fixture.current })
    expect(reservation.runId).toBe(fixture.prepared.runId)
    expect(reservation.scheduleSha256).toBe(expectedSchedule.scheduleSha256)
    expect(fixture.runtime.runs.status().executions).toHaveLength(0)
  })

  test.skipIf(!nativeClockSupported)("PREPARED and CONSENTED reentry preserve run identity and never recreate an arm", async () => {
    for (const priorState of ["PREPARED", "CONSENTED"] as const) {
      const fixture = await reentryFixture(priorState)
      const oldExpiry = fixture.consent?.expiresAtMilliseconds
      let quotaBefore: Record<string, unknown> | undefined
      if (priorState === "CONSENTED") {
        const database = new Database(reentryDatabase(fixture.root))
        try {
          const clockSample = readSkillOptNativeClock({ nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! })
          const previousBoot = randomUUID()
          database.query(`UPDATE quota SET last_attempt_id=?,last_attempt_boot=?,last_attempt_cont='100',
            fence_boot=?,fence_cont=?,revision=revision+1 WHERE singleton=1`).run(
            randomUUID(), previousBoot, clockSample.bootId, clockSample.continuousNanoseconds,
          )
          quotaBefore = database.query(`SELECT revision,last_attempt_id,last_attempt_boot,last_attempt_cont,fence_boot,fence_cont
            FROM quota WHERE singleton=1`).get() as Record<string, unknown>
        } finally { database.close() }
      }
      releaseOwner(fixture.owner)
      const owner = reattachOwner(fixture.runtime, fixture.fixture.owners)
      const controller = createSkillOptController(fixture.runtime,
        { nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! }, fixture.nativeHost)
      controller.initialize()
      const challenge = controller.prepareReentry({ owner, runId: fixture.prepared.runId, current: fixture.current })
      const restored = controller.acceptReentry(challenge, await approveReentry(challenge.decisionBinding), fixture.current)
      expect(restored.state).toBe("CONSENTED")
      if (restored.state !== "CONSENTED") throw new Error("reentry unexpectedly issued an arm")
      expect(restored.prepared.runId).toBe(fixture.prepared.runId)
      expect(restored.consent.expiresAtMilliseconds).toBe(oldExpiry ?? restored.consent.expiresAtMilliseconds)
      expect(fixture.runtime.runs.status().claim).toBeUndefined()
      if (quotaBefore) {
        const database = new Database(reentryDatabase(fixture.root))
        try {
          expect(database.query(`SELECT revision,last_attempt_id,last_attempt_boot,last_attempt_cont,fence_boot,fence_cont
            FROM quota WHERE singleton=1`).get()).toEqual(quotaBefore)
        } finally { database.close() }
      }
      expect(fixture.runtime.runs.status().executions).toHaveLength(0)
    }
  })

  test.skipIf(!nativeClockSupported)("reentry rejects live foreign owners, missing locators, expiry, and changed data", async () => {
    const live = await reentryFixture("ARMED")
    const foreign = reattachOwner(live.runtime, live.fixture.owners)
    const liveController = createSkillOptController(live.runtime,
      { nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! }, live.nativeHost)
    liveController.initialize()
    expect(() => liveController.prepareReentry({ owner: foreign, runId: live.prepared.runId, current: live.current })).toThrow("owner-unavailable")
    expect(live.runtime.runs.status().executions).toHaveLength(0)

    const locatorless = await reentryFixture("ARMED")
    const brokenOwnerRow = new Database(reentryDatabase(locatorless.root))
    try { brokenOwnerRow.query("UPDATE runs SET owner_session_id=NULL,owner_epoch=NULL WHERE run_id=?").run(locatorless.prepared.runId) }
    finally { brokenOwnerRow.close() }
    expect(() => locatorless.controller.prepareReentry({ owner: locatorless.owner, runId: locatorless.prepared.runId,
      current: locatorless.current })).toThrow("owner-unavailable")
    expect(locatorless.runtime.runs.status().executions).toHaveLength(0)

    const expired = await reentryFixture("ARMED")
    const expiredRows = new Database(reentryDatabase(expired.root))
    try {
      expiredRows.query("UPDATE consents SET expires_cont='0',expires_wall='0' WHERE run_id=?").run(expired.prepared.runId)
      expiredRows.query("UPDATE arms SET expires_cont='0',expires_wall='0' WHERE run_id=?").run(expired.prepared.runId)
    } finally { expiredRows.close() }
    expect(() => expired.controller.prepareReentry({ owner: expired.owner, runId: expired.prepared.runId,
      current: expired.current })).toThrow("consent-expired")
    expect(expired.runtime.runs.status().executions).toHaveLength(0)

    const changed = await reentryFixture("PREPARED")
    const challenge = changed.controller.prepareReentry({ owner: changed.owner, runId: changed.prepared.runId, current: changed.current })
    writeFileSync(join(changed.root, ".agents/skills/llm-wiki/SKILL.md"), "changed", { mode: 0o600 })
    const approval = await approveReentry(challenge.decisionBinding)
    expect(() => changed.controller.acceptReentry(challenge, approval, changed.current)).toThrow("binding-baseline-drift")
    expect(changed.runtime.runs.status().executions).toHaveLength(0)
  })

  test.skipIf(!nativeClockSupported)("one-use terminal reentry rejects a tampered persisted campaign schedule", async () => {
    const fixture = await reentryFixture("ARMED")
    releaseOwner(fixture.owner)
    const owner = reattachOwner(fixture.runtime, fixture.fixture.owners)
    const controller = createSkillOptController(fixture.runtime,
      { nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! }, fixture.nativeHost)
    controller.initialize()
    const challenge = controller.prepareReentry({ owner, runId: fixture.prepared.runId, current: fixture.current })
    const receipt = await approveReentry(challenge.decisionBinding)
    const before = controller.status()
    const database = new Database(reentryDatabase(fixture.root))
    try {
      database.query("UPDATE consents SET schedule_hash=? WHERE run_id=?").run("f".repeat(64), fixture.prepared.runId)
    } finally { database.close() }
    expect(() => controller.acceptReentry(challenge, receipt, fixture.current)).toThrow("revision-conflict")
    expect(controller.status().requestCounts).toEqual(before.requestCounts)
    expect(controller.status().remaining).toEqual(before.remaining)
    expect(fixture.runtime.runs.status().claim).toBeUndefined()
    expect(fixture.runtime.runs.status().executions).toHaveLength(0)
  })

  test.skipIf(!nativeClockSupported)("reentry refuses clock uncertainty reported by nested ledger status", async () => {
    const fixture = await reentryFixture("PREPARED")
    releaseOwner(fixture.owner)
    const owner = reattachOwner(fixture.runtime, fixture.fixture.owners)
    const controller = createSkillOptController(fixture.runtime,
      { nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! }, fixture.nativeHost)
    controller.initialize()
    const sample = readSkillOptNativeClock({ nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! })
    const database = new Database(reentryDatabase(fixture.root))
    try {
      database.query("UPDATE quota SET clock_boot=?,clock_cont=?,clock_wall=? WHERE singleton=1")
        .run(sample.bootId, sample.continuousNanoseconds, (BigInt(sample.wallMilliseconds) - 600_000n).toString())
    } finally { database.close() }
    expect(controller.status()).toMatchObject({ reasonCode: "clock-uncertain" })
    const before = controller.status()
    expect(() => controller.prepareReentry({ owner, runId: fixture.prepared.runId, current: fixture.current }))
      .toThrow("clock-uncertain")
    expect(controller.status().runId).toBe(before.runId)
    expect(controller.status().revision).toBe(before.revision)
    expect(controller.status().requestCounts).toEqual(before.requestCounts)
    expect(controller.status().remaining).toEqual(before.remaining)
    expect(fixture.runtime.runs.status().claim).toBeUndefined()
    expect(fixture.runtime.runs.status().executions).toHaveLength(0)
  })

  test.skipIf(!nativeClockSupported)("reentry challenge CAS has one winner and pending reservations cannot be demoted", async () => {
    const raced = await reentryFixture("ARMED")
    const firstController = createSkillOptController(raced.runtime,
      { nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! }, raced.nativeHost)
    const secondController = createSkillOptController(raced.runtime,
      { nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! }, raced.nativeHost)
    firstController.initialize()
    secondController.initialize()
    const first = firstController.prepareReentry({ owner: raced.owner, runId: raced.prepared.runId, current: raced.current })
    const second = secondController.prepareReentry({ owner: raced.owner, runId: raced.prepared.runId, current: raced.current })
    const restored = firstController.acceptReentry(first, await approveReentry(first.decisionBinding), raced.current)
    expect(restored.state).toBe("ARMED")
    const secondReceipt = await approveReentry(second.decisionBinding)
    expect(() => secondController.acceptReentry(second, secondReceipt, raced.current)).toThrow("revision-conflict")
    expect(raced.runtime.runs.status().executions).toHaveLength(0)

    const pending = await reentryFixture("CONSENTED")
    const reserved = pending.controller.reserveManual({ owner: pending.owner, prepared: pending.prepared,
      consent: pending.consent!, current: pending.current })
    expect(reserved.requestId).toMatch(/^[0-9a-f-]{36}$/iu)
    expect(reserved.scheduleSha256).toBe(pending.prepared.scheduleSha256)
    expect(() => pending.controller.prepareReentry({ owner: pending.owner, runId: pending.prepared.runId,
      current: pending.current })).toThrow(SkillOptControllerError)
    expect(pending.controller.status().pendingDispatch).toBe(true)
    expect(pending.runtime.runs.status().executions).toHaveLength(0)
  })

  test.skipIf(!nativeClockSupported)("unstarted cancellation is owner-bound, quiescent, atomic, and preserves quota state", async () => {
    const prepared = await reentryFixture("PREPARED")
    const beforePrepared = prepared.controller.status()
    const preparedDb = new Database(reentryDatabase(prepared.root))
    const preparedQuota = preparedDb.query("SELECT * FROM quota WHERE singleton=1").get()
    const preparedUsage = preparedDb.query("SELECT * FROM usage WHERE run_id=?").get(prepared.prepared.runId)
    const preparedExpiry = preparedDb.query("SELECT expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?").get(prepared.prepared.runId)
    preparedDb.close()
    expect(prepared.controller.cancelUnstarted(prepared.owner, prepared.prepared.runId).state).toBe("CANCELLED")
    expect(prepared.controller.status().requestCounts).toEqual(beforePrepared.requestCounts)
    const afterPreparedDb = new Database(reentryDatabase(prepared.root))
    try {
      expect(afterPreparedDb.query("SELECT * FROM quota WHERE singleton=1").get()).toEqual(preparedQuota)
      expect(afterPreparedDb.query("SELECT * FROM usage WHERE run_id=?").get(prepared.prepared.runId)).toEqual(preparedUsage)
      expect(afterPreparedDb.query("SELECT expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?").get(prepared.prepared.runId))
        .toEqual(preparedExpiry)
      expect(afterPreparedDb.query("SELECT state FROM runs WHERE run_id=?").get(prepared.prepared.runId)).toEqual({ state: "CANCELLED" })
    } finally { afterPreparedDb.close() }
    expect(() => prepared.controller.cancelUnstarted(prepared.owner, prepared.prepared.runId)).toThrow("run-stale")

    const consented = await reentryFixture("CONSENTED")
    const foreign = reattachOwner(consented.runtime, consented.fixture.owners)
    expect(() => consented.controller.cancelUnstarted(foreign, consented.prepared.runId)).toThrow("owner-unavailable")
    const busyClaim = consented.runtime.runs.claim(consented.owner.sessionID, `cancel-busy-${randomUUID()}`, process.pid)
    expect(() => consented.controller.cancelUnstarted(consented.owner, consented.prepared.runId)).toThrow("owner-busy")
    consented.runtime.runs.release(busyClaim)
    expect(consented.controller.status().state).toBe("CONSENTED")

    const beforeCancelDb = new Database(reentryDatabase(consented.root))
    const quotaBeforeCancel = beforeCancelDb.query("SELECT * FROM quota WHERE singleton=1").get()
    const usageBeforeCancel = beforeCancelDb.query("SELECT * FROM usage WHERE run_id=?").get(consented.prepared.runId)
    const expiryBeforeCancel = beforeCancelDb.query("SELECT expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?").get(consented.prepared.runId)
    beforeCancelDb.close()
    expect(consented.controller.cancelUnstarted(consented.owner, consented.prepared.runId).state).toBe("CANCELLED")
    expect(() => consented.controller.reserveManual({ owner: consented.owner, prepared: consented.prepared,
      consent: consented.consent!, current: consented.current })).toThrow("consent-required")
    expect(consented.controller.status().pendingDispatch).toBe(false)
    expect(consented.controller.status().requestCounts.charged.target).toBe(0)
    const afterCancelDb = new Database(reentryDatabase(consented.root))
    try {
      expect(afterCancelDb.query("SELECT * FROM quota WHERE singleton=1").get()).toEqual(quotaBeforeCancel)
      expect(afterCancelDb.query("SELECT * FROM usage WHERE run_id=?").get(consented.prepared.runId)).toEqual(usageBeforeCancel)
      expect(afterCancelDb.query("SELECT expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?").get(consented.prepared.runId))
        .toEqual(expiryBeforeCancel)
      expect(afterCancelDb.query("SELECT state FROM consents WHERE run_id=?").get(consented.prepared.runId)).toEqual({ state: "revoked" })
    } finally { afterCancelDb.close() }
    expect(consented.runtime.runs.status().claim).toBeUndefined()
  })

  test.skipIf(!nativeClockSupported)("disarm requires the current idle owner, rejects stale revisions, and preserves quota and expiry", async () => {
    const fixture = await reentryFixture("ARMED")
    const foreign = reattachOwner(fixture.runtime, fixture.fixture.owners)
    expect(() => fixture.controller.disarm(foreign, fixture.prepared.runId)).toThrow("owner-unavailable")
    const busyClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `disarm-busy-${randomUUID()}`, process.pid)
    expect(() => fixture.controller.disarm(fixture.owner, fixture.prepared.runId)).toThrow("owner-busy")
    fixture.runtime.runs.release(busyClaim)

    const sourcePath = join(fixture.root, fixture.current.dataset.sourceManifest.entries[0]!.path)
    writeFileSync(sourcePath, "Source drift must not block a current owner from disarming.\n", { mode: 0o600 })
    const database = new Database(reentryDatabase(fixture.root))
    const quotaBefore = database.query("SELECT * FROM quota WHERE singleton=1").get()
    const usageBefore = database.query("SELECT * FROM usage WHERE run_id=?").get(fixture.prepared.runId)
    const expiryBefore = database.query("SELECT expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?").get(fixture.prepared.runId)
    const revision = (database.query("SELECT revision FROM runs WHERE run_id=?").get(fixture.prepared.runId) as { revision: number }).revision
    database.exec(`CREATE TRIGGER stale_disarm_revision AFTER UPDATE OF state ON arms
      WHEN NEW.run_id='${fixture.prepared.runId}' AND NEW.state='revoked'
      BEGIN UPDATE runs SET revision=revision+1 WHERE run_id=NEW.run_id; END`)
    database.close()

    expect(() => fixture.controller.disarm(fixture.owner, fixture.prepared.runId)).toThrow("revision-conflict")
    const afterStale = new Database(reentryDatabase(fixture.root))
    try {
      expect(afterStale.query("SELECT state,revision FROM runs WHERE run_id=?").get(fixture.prepared.runId))
        .toEqual({ state: "ARMED", revision })
      expect(afterStale.query("SELECT * FROM quota WHERE singleton=1").get()).toEqual(quotaBefore)
      expect(afterStale.query("SELECT * FROM usage WHERE run_id=?").get(fixture.prepared.runId)).toEqual(usageBefore)
      expect(afterStale.query("SELECT state FROM arms WHERE run_id=?").get(fixture.prepared.runId)).toEqual({ state: "armed" })
    } finally {
      afterStale.exec("DROP TRIGGER stale_disarm_revision")
      afterStale.close()
    }

    expect(fixture.controller.disarm(fixture.owner, fixture.prepared.runId).state).toBe("CANCELLED")
    expect(() => fixture.controller.disarm(fixture.owner, fixture.prepared.runId)).toThrow("run-stale")
    const after = new Database(reentryDatabase(fixture.root))
    try {
      expect(after.query("SELECT * FROM quota WHERE singleton=1").get()).toEqual(quotaBefore)
      expect(after.query("SELECT * FROM usage WHERE run_id=?").get(fixture.prepared.runId)).toEqual(usageBefore)
      expect(after.query("SELECT expires_boot,expires_cont,expires_wall FROM runs WHERE run_id=?").get(fixture.prepared.runId))
        .toEqual(expiryBefore)
      expect(after.query("SELECT state FROM arms WHERE run_id=?").get(fixture.prepared.runId)).toEqual({ state: "revoked" })
      expect(after.query("SELECT state FROM consents WHERE run_id=?").get(fixture.prepared.runId)).toEqual({ state: "revoked" })
    } finally { after.close() }
    expect(fixture.runtime.runs.status().claim).toBeUndefined()
  })

  test.skipIf(!nativeClockSupported)("a qualification hold requires its native capability and preserves counters on refusal", async () => {
    const fixture = await reentryFixture("CONSENTED")
    seedQualifiedRunningLedger(fixture.root, fixture.prepared.runId)
    const foreign = reattachOwner(fixture.runtime, fixture.fixture.owners)
    expect(() => fixture.controller.awaitCandidateApproval(foreign, fixture.prepared.runId, fixture.current, undefined as never)).toThrow("owner-unavailable")

    const busyClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `busy-${randomUUID()}`, process.pid)
    expect(() => fixture.controller.awaitCandidateApproval(fixture.owner, fixture.prepared.runId, fixture.current, undefined as never)).toThrow("owner-busy")
    fixture.runtime.runs.release(busyClaim)

    const before = fixture.controller.status()
    const database = new Database(reentryDatabase(fixture.root))
    let usageBefore = {} as Record<string, unknown>
    let quotaBefore = {} as Record<string, unknown>
    let runBefore = {} as Record<string, unknown>
    try {
      usageBefore = database.query("SELECT * FROM usage WHERE run_id=?").get(fixture.prepared.runId) as Record<string, unknown>
      expect(database.query("SELECT 1 FROM campaign_qualifications WHERE run_id=?").get(fixture.prepared.runId)).toBeNull()
      quotaBefore = database.query(`SELECT active_run_id,active_owner_session_hash,active_owner_epoch_hash,pending_request_id,
        last_attempt_id,last_attempt_boot,last_attempt_cont,fence_boot,fence_cont,clock_uncertain,revision
        FROM quota WHERE singleton=1`).get() as Record<string, unknown>
      runBefore = database.query(`SELECT binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,created_boot,created_cont,
        created_wall,expires_boot,expires_cont,expires_wall,fixture_bytes FROM runs WHERE run_id=?`).get(fixture.prepared.runId) as Record<string, unknown>
    } finally { database.close() }

    const genuineHandoff = await makeGenuinePromotionHandoff(fixture.root, fixture.prepared.runId,
      fixture.current.dataset as NativeDataset)
    const handoffReceipt = consumeNativePromotionCanaryHandoff(genuineHandoff.handoff)
    expect(handoffReceipt.semanticReviewSha256).toBe(genuineHandoff.semanticReviewSha256)
    expect(handoffReceipt.semanticReviewSha256).not.toBe(genuineHandoff.reviewArtifactSha256)
    expect(handoffReceipt.evidence.review.sha256).toBe(genuineHandoff.reviewArtifactSha256)
    expect(() => fixture.controller.awaitCandidateApproval(fixture.owner, fixture.prepared.runId,
      fixture.current, genuineHandoff.handoff as never)).toThrow("qualification-required")
    expect(fixture.controller.status().state).toBe("RUNNING")
    const noQualification = new Database(reentryDatabase(fixture.root))
    try { expect(noQualification.query("SELECT 1 FROM campaign_qualifications WHERE run_id=?").get(fixture.prepared.runId)).toBeNull() }
    finally { noQualification.close() }

    expect(() => fixture.controller.awaitCandidateApproval(fixture.owner, fixture.prepared.runId, fixture.current, undefined as never))
      .toThrow("qualification-required")
    expect(before.state).toBe("RUNNING")
    expect(fixture.runtime.runs.status().claim).toBeUndefined()
    expect(fixture.runtime.runs.status().executions).toHaveLength(0)

    const after = fixture.controller.status()
    expect(after.requestCounts).toEqual(before.requestCounts)
    expect(after.targetPhaseCounts).toEqual(before.targetPhaseCounts)
    expect(after.remaining).toEqual(before.remaining)
    expect(after.dailyCooldownRemainingMilliseconds).toBeLessThanOrEqual(before.dailyCooldownRemainingMilliseconds)
    const afterDb = new Database(reentryDatabase(fixture.root))
    try {
      expect(afterDb.query("SELECT * FROM usage WHERE run_id=?").get(fixture.prepared.runId)).toEqual(usageBefore)
      expect(afterDb.query(`SELECT active_run_id,active_owner_session_hash,active_owner_epoch_hash,pending_request_id,
        last_attempt_id,last_attempt_boot,last_attempt_cont,fence_boot,fence_cont,clock_uncertain,revision
        FROM quota WHERE singleton=1`).get()).toEqual(quotaBefore)
      expect(afterDb.query(`SELECT binding_hash,owner_session_hash,owner_epoch_hash,admission_hash,created_boot,created_cont,
        created_wall,expires_boot,expires_cont,expires_wall,fixture_bytes FROM runs WHERE run_id=?`).get(fixture.prepared.runId)).toEqual(runBefore)
      expect(afterDb.query("SELECT state,revision FROM runs WHERE run_id=?").get(fixture.prepared.runId))
        .toEqual({ state: "RUNNING", revision: before.revision })
    } finally { afterDb.close() }

    expect(() => fixture.controller.prepare({ owner: fixture.owner, campaignId: `next_${randomUUID().replaceAll("-", "")}`, ...fixture.current }))
      .toThrow("active-run")
    expect(() => fixture.controller.reserveRequest({ owner: fixture.owner, runId: fixture.prepared.runId,
      current: fixture.current, role: "target", phase: "canary" })).toThrow("dispatch-not-authorized")
    expect(() => fixture.controller.reserveManual({ owner: fixture.owner, prepared: fixture.prepared,
      consent: fixture.consent!, current: fixture.current })).toThrow("active-run")
    expect((await fixture.controller.recover(fixture.owner, fixture.prepared.runId)).state).toBe("RUNNING")
    expect(() => fixture.controller.reserveRequest({ owner: fixture.owner, runId: fixture.prepared.runId,
      current: fixture.current, role: "target", phase: "canary" })).toThrow("dispatch-not-authorized")
    expect(() => fixture.controller.finish(fixture.owner, fixture.prepared.runId, "COMPLETED" as never)).toThrow("run-stale")
    expect(fixture.controller.status().state).toBe("RUNNING")
    expect(fixture.controller.status().requestCounts).toEqual(before.requestCounts)
    const quotaAfterDenied = new Database(reentryDatabase(fixture.root))
    try {
      expect(quotaAfterDenied.query(`SELECT last_attempt_id,last_attempt_boot,last_attempt_cont,fence_boot,fence_cont FROM quota WHERE singleton=1`).get())
        .toEqual({ last_attempt_id: quotaBefore.last_attempt_id, last_attempt_boot: quotaBefore.last_attempt_boot,
          last_attempt_cont: quotaBefore.last_attempt_cont, fence_boot: quotaBefore.fence_boot, fence_cont: quotaBefore.fence_cont })
    } finally { quotaAfterDenied.close() }

    expect(fixture.controller.finish(fixture.owner, fixture.prepared.runId, "CANCELLED").state).toBe("CANCELLED")
    expect(fixture.controller.status().requestCounts).toEqual(before.requestCounts)
    expect(fixture.controller.status().dailyCooldownRemainingMilliseconds).toBeGreaterThan(0)
  })

  test.skipIf(!nativeClockSupported)("candidate-approval hold refuses uncertain native clock without changing run usage", async () => {
    const fixture = await reentryFixture("CONSENTED")
    seedQualifiedRunningLedger(fixture.root, fixture.prepared.runId)
    const database = new Database(reentryDatabase(fixture.root))
    try {
      const sample = readSkillOptNativeClock({ nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! })
      database.query("UPDATE quota SET clock_wall=? WHERE singleton=1")
        .run((BigInt(sample.wallMilliseconds) - 600_000n).toString())
    } finally { database.close() }
    const before = fixture.controller.status()
    expect(before.reasonCode).toBe("clock-uncertain")
    expect(() => fixture.controller.awaitCandidateApproval(fixture.owner, fixture.prepared.runId, fixture.current, undefined as never)).toThrow("clock-uncertain")
    expect(fixture.controller.status().state).toBe("BLOCKED")
    expect(fixture.controller.status().requestCounts).toEqual(before.requestCounts)
    expect(fixture.controller.status().remaining).toEqual(before.remaining)
    expect(fixture.runtime.runs.status().claim).toBeUndefined()
  })

  test.skipIf(!nativeClockSupported)("rollback begin rejects a consented unqualified run and preserves authentic unused authorization and counters", async () => {
    const fixture = await reentryFixture("CONSENTED")
    // Exercise only refusal: do not seed a campaign qualification or manufacture rollback intent.
    const genuineApply = await makeGenuinePromotionHandoff(fixture.root, fixture.prepared.runId,
      fixture.current.dataset as NativeDataset, fixture.root)
    const rollbackAuthorization = await approveSyntheticNativePromotion({
      common: genuineApply.common, owner: fixture.owner, operation: "rollback", runDeadlineAt: Date.now() + 10 * 60_000,
    })
    const approvalBefore = assertNativeRollbackAuthorizationCurrent({ ...genuineApply.common,
      owner: fixture.owner, nativeAuthorization: rollbackAuthorization.authorization })
    expect(approvalBefore.approvalRecordSha256).toMatch(/^[a-f0-9]{64}$/u)
    const before = fixture.controller.status()
    const database = new Database(reentryDatabase(fixture.root))
    let usageBefore: unknown
    let quotaBefore: unknown
    let requestCountBefore: number
    try {
      usageBefore = database.query("SELECT * FROM usage WHERE run_id=?").get(fixture.prepared.runId)
      quotaBefore = database.query(`SELECT active_run_id,active_owner_session_hash,active_owner_epoch_hash,pending_request_id,
        revision,last_attempt_id,last_attempt_boot,last_attempt_cont FROM quota WHERE singleton=1`).get()
      requestCountBefore = (database.query("SELECT count(*) AS count FROM requests WHERE run_id=?")
        .get(fixture.prepared.runId) as { count: number }).count
      expect(database.query("SELECT 1 FROM campaign_qualifications WHERE run_id=?").get(fixture.prepared.runId)).toBeNull()
    } finally { database.close() }
    const foreign = reattachOwner(fixture.runtime, fixture.fixture.owners)
    const foreignClaim = fixture.runtime.runs.claim(foreign.sessionID, `rollback-foreign-${randomUUID()}`, process.pid)
    try {
      expect(() => fixture.controller.beginNativeRollback({ owner: foreign, runtime: fixture.runtime, mutationClaim: foreignClaim,
        runId: fixture.prepared.runId, current: fixture.current, promotion: genuineApply.common,
        nativeAuthorization: rollbackAuthorization.authorization })).toThrow("owner-unavailable")
      expect(() => fixture.controller.beginNativeRollback({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: foreignClaim, runId: fixture.prepared.runId, current: fixture.current,
        promotion: genuineApply.common, nativeAuthorization: rollbackAuthorization.authorization })).toThrow("owner-unavailable")
      expect(fixture.controller.nativeRollbackEligibility({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: foreignClaim, runId: fixture.prepared.runId, current: fixture.current }))
        .toMatchObject({ state: "BLOCKED", reasonCode: "owner-unavailable" })
    } finally { fixture.runtime.runs.release(foreignClaim) }

    const forgedRuntime = Object.create(fixture.runtime) as ExecutionRuntime
    expect(fixture.controller.nativeRollbackEligibility({ owner: fixture.owner, runtime: forgedRuntime,
      runId: fixture.prepared.runId, current: fixture.current }))
      .toMatchObject({ state: "BLOCKED", reasonCode: "canary-runtime-mismatch" })
    expect(() => fixture.controller.reserveNativePublicationArtifacts({ owner: fixture.owner, runtime: forgedRuntime,
      runId: fixture.prepared.runId, current: fixture.current, operation: "apply", bytes: 0, headroomBytes: 0 }))
      .toThrow("canary-runtime-mismatch")
    for (const [bytes, headroomBytes] of [[-1, 0], [0, -1], [1.5, 0], [Number.MAX_SAFE_INTEGER + 1, 0]]) {
      expect(() => fixture.controller.reserveNativePublicationArtifacts({ owner: fixture.owner, runtime: fixture.runtime,
        runId: fixture.prepared.runId, current: fixture.current, operation: "apply", bytes, headroomBytes }))
        .toThrow("budget-exhausted")
    }

    const busyClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `rollback-owner-${randomUUID()}`, process.pid)
    const staleClaimCopy = structuredClone(busyClaim)
    try {
      expect(() => fixture.runtime.runs.claim(fixture.owner.sessionID, `rollback-second-${randomUUID()}`, process.pid)).toThrow()
      expect(fixture.controller.nativeRollbackEligibility({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: busyClaim, runId: fixture.prepared.runId, current: fixture.current }))
        .toMatchObject({ state: "BLOCKED", reasonCode: "run-stale" })
      expect(() => fixture.controller.beginNativeRollback({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: busyClaim, runId: fixture.prepared.runId, current: fixture.current,
        promotion: genuineApply.common, nativeAuthorization: rollbackAuthorization.authorization })).toThrow("run-stale")
    } finally { fixture.runtime.runs.release(busyClaim) }
    const currentClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `rollback-current-${randomUUID()}`, process.pid)
    try {
      expect(fixture.controller.nativeRollbackEligibility({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: staleClaimCopy, runId: fixture.prepared.runId, current: fixture.current }))
        .toMatchObject({ state: "BLOCKED", reasonCode: "owner-busy" })
      expect(() => fixture.controller.reserveNativePublicationArtifacts({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: staleClaimCopy, runId: fixture.prepared.runId, current: fixture.current,
        operation: "apply", bytes: 1, headroomBytes: 0 })).toThrow("owner-busy")
      expect(() => fixture.controller.beginNativeRollback({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: staleClaimCopy, runId: fixture.prepared.runId, current: fixture.current,
        promotion: genuineApply.common, nativeAuthorization: rollbackAuthorization.authorization })).toThrow("owner-busy")
      expect(() => fixture.controller.beginNativeRollback({ owner: fixture.owner, runtime: forgedRuntime,
        mutationClaim: currentClaim, runId: fixture.prepared.runId, current: fixture.current,
        promotion: genuineApply.common, nativeAuthorization: rollbackAuthorization.authorization })).toThrow("canary-runtime-mismatch")
    } finally { fixture.runtime.runs.release(currentClaim) }

    const unqualifiedClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `rollback-unqualified-${randomUUID()}`, process.pid)
    try {
      expect(fixture.controller.nativeRollbackEligibility({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: unqualifiedClaim, runId: fixture.prepared.runId, current: fixture.current }))
        .toMatchObject({ state: "BLOCKED", reasonCode: "run-stale" })
      expect(() => fixture.controller.assertQualifiedPublication({ owner: fixture.owner, runId: fixture.prepared.runId,
        current: fixture.current, candidateSha256: "c".repeat(64), resultsSha256: "d".repeat(64),
        reviewSha256: "e".repeat(64), mutationClaim: unqualifiedClaim })).toThrow("qualification-required")
      expect(() => fixture.controller.beginNativeRollback({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: unqualifiedClaim, runId: fixture.prepared.runId, current: fixture.current,
        promotion: genuineApply.common, nativeAuthorization: rollbackAuthorization.authorization })).toThrow("run-stale")
      expect(() => fixture.controller.reserveNativePublicationArtifacts({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: unqualifiedClaim, runId: fixture.prepared.runId, current: fixture.current,
        operation: "apply", bytes: 1, headroomBytes: 0 })).toThrow("qualification-required")
    } finally { fixture.runtime.runs.release(unqualifiedClaim) }
    expect(() => fixture.controller.prepareNativeRollbackCanary({ owner: fixture.owner, runId: fixture.prepared.runId,
      current: fixture.current, intent: Object.freeze({}) as never, handoff: Object.freeze({}) as never,
      promotion: genuineApply.common })).toThrow("rollback-intent-invalid")
    expect(() => fixture.controller.prepareNativeRollbackCanary({ owner: fixture.owner, runId: fixture.prepared.runId,
      current: fixture.current, intent: JSON.parse(JSON.stringify(Object.freeze({}))) as never,
      handoff: Object.freeze({}) as never, promotion: genuineApply.common })).toThrow("rollback-intent-invalid")
    expect(assertNativeRollbackAuthorizationCurrent({ ...genuineApply.common, owner: fixture.owner,
      nativeAuthorization: rollbackAuthorization.authorization })).toEqual(approvalBefore)
    const afterRefusals = fixture.controller.status()
    expect(afterRefusals).toMatchObject({ state: before.state, runId: before.runId, revision: before.revision,
      requestCounts: before.requestCounts, targetPhaseCounts: before.targetPhaseCounts, remaining: before.remaining })
    const afterDb = new Database(reentryDatabase(fixture.root))
    try {
      expect(afterDb.query("SELECT * FROM usage WHERE run_id=?").get(fixture.prepared.runId)).toEqual(usageBefore)
      expect(afterDb.query(`SELECT active_run_id,active_owner_session_hash,active_owner_epoch_hash,pending_request_id,
        revision,last_attempt_id,last_attempt_boot,last_attempt_cont FROM quota WHERE singleton=1`).get()).toEqual(quotaBefore)
      expect((afterDb.query("SELECT count(*) AS count FROM requests WHERE run_id=?")
        .get(fixture.prepared.runId) as { count: number }).count).toBe(requestCountBefore)
    } finally { afterDb.close() }
    expect(fixture.runtime.runs.status().claim).toBeUndefined()
    expect(fixture.runtime.runs.status().executions).toHaveLength(0)

    const capDb = new Database(reentryDatabase(fixture.root))
    let capUsageBefore: unknown
    let capRunBefore: unknown
    let capQuotaBefore: unknown
    let capRequestCountBefore: number
    try {
      const cap = SKILLOPT_CONTROLLER_LIMITS.artifactBytes
      capDb.query("UPDATE usage SET artifact_bytes=? WHERE run_id=?").run(cap - 1, fixture.prepared.runId)
      capDb.query("UPDATE runs SET artifact_bytes=? WHERE run_id=?").run(cap - 1, fixture.prepared.runId)
      capUsageBefore = capDb.query("SELECT * FROM usage WHERE run_id=?").get(fixture.prepared.runId)
      capRunBefore = capDb.query("SELECT * FROM runs WHERE run_id=?").get(fixture.prepared.runId)
      capQuotaBefore = capDb.query("SELECT * FROM quota WHERE singleton=1").get()
      capRequestCountBefore = (capDb.query("SELECT count(*) AS count FROM requests WHERE run_id=?")
        .get(fixture.prepared.runId) as { count: number }).count
    } finally { capDb.close() }
    expect(() => fixture.controller.reserveNativePublicationArtifacts({ owner: fixture.owner, runtime: fixture.runtime,
      runId: fixture.prepared.runId, current: fixture.current, operation: "apply", bytes: 1, headroomBytes: 1 }))
      .toThrow("budget-exhausted")
    const capAfterDb = new Database(reentryDatabase(fixture.root))
    try {
      expect(capAfterDb.query("SELECT * FROM usage WHERE run_id=?").get(fixture.prepared.runId)).toEqual(capUsageBefore)
      expect(capAfterDb.query("SELECT * FROM runs WHERE run_id=?").get(fixture.prepared.runId)).toEqual(capRunBefore)
      expect(capAfterDb.query("SELECT * FROM quota WHERE singleton=1").get()).toEqual(capQuotaBefore)
      expect((capAfterDb.query("SELECT count(*) AS count FROM requests WHERE run_id=?")
        .get(fixture.prepared.runId) as { count: number }).count).toBe(capRequestCountBefore)
      expect(assertNativeRollbackAuthorizationCurrent({ ...genuineApply.common, owner: fixture.owner,
        nativeAuthorization: rollbackAuthorization.authorization })).toEqual(approvalBefore)
    } finally { capAfterDb.close() }

    const expiredDb = new Database(reentryDatabase(fixture.root))
    try { expiredDb.query("UPDATE runs SET expires_wall='0' WHERE run_id=?").run(fixture.prepared.runId) }
    finally { expiredDb.close() }
    const expiredClaim = fixture.runtime.runs.claim(fixture.owner.sessionID, `rollback-expired-${randomUUID()}`, process.pid)
    try {
      expect(fixture.controller.nativeRollbackEligibility({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: expiredClaim, runId: fixture.prepared.runId, current: fixture.current }))
        .toMatchObject({ state: "BLOCKED", reasonCode: "run-expired" })
      expect(() => fixture.controller.beginNativeRollback({ owner: fixture.owner, runtime: fixture.runtime,
        mutationClaim: expiredClaim, runId: fixture.prepared.runId, current: fixture.current,
        promotion: genuineApply.common, nativeAuthorization: rollbackAuthorization.authorization })).toThrow("run-expired")
    } finally { fixture.runtime.runs.release(expiredClaim) }
    expect(fixture.runtime.runs.status().claim).toBeUndefined()
    expect(fixture.runtime.runs.status().executions).toHaveLength(0)
  })

  test("a serialized or caller-created ticket cannot authorize dispatch in a production controller", () => {
    const testStorage = storage()
    const controller = createSkillOptController(
      { worktree: testStorage.root } as unknown as ExecutionRuntime,
      { nativeHelperPath: join(testStorage.root, "not-executed"), nativeHelperSha256: "a".repeat(64) },
      { consumeCompletedTargetWitness() { throw new Error("synthetic native host cannot verify completed-target witnesses") },
        consumeCompletedOptimizerWitness() { throw new Error("synthetic native host cannot verify completed-optimizer witnesses") },
        identityFor: () => undefined,
        async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "test native handle unavailable" } } },
    )
    expect(() => controller.prepare({ owner: {} as SessionStore, campaignId: "test-campaign" })).toThrow("owner-unavailable")
    expect(() => controller.consumeDispatch(
      {} as SessionStore, {} as SkillOptDispatchTicket, {} as SkillOptCurrentBinding,
    )).toThrow("dispatch-not-authorized")
  })

  test("the test-only storage seam refuses any non-temporary authority path", () => {
    const clock = makeClock()
    expect(() => createSkillOptStorageForTests({
      databasePath: join(tmpdir(), "must-not-be-opened.sqlite"), worktreeRoot: process.cwd(), clock: clock.sample,
    })).toThrow("storage-permission")
  })

  test("status does not initialize a ledger; explicit initialization creates private owned storage", () => {
    const testStorage = storage()
    expect(() => testStorage.store.snapshot()).toThrow(SkillOptControllerError)
    expect(existsSync(testStorage.databasePath)).toBe(false)
    expect(existsSync(join(testStorage.root, "automation"))).toBe(false)

    testStorage.store.initialize()
    expect(lstatSync(join(testStorage.root, "automation")).mode & 0o777).toBe(0o700)
    expect(lstatSync(testStorage.databasePath).mode & 0o777).toBe(0o600)
    expect(testStorage.store.snapshot().state).toBe("DATA_REQUIRED")
  })

  test("an existing private automation directory without a ledger is never silently recreated", () => {
    const testStorage = storage()
    mkdirSync(join(testStorage.root, "automation"), { mode: 0o700 })
    chmodSync(join(testStorage.root, "automation"), 0o700)
    expect(() => testStorage.store.initialize()).toThrow("storage-missing")
    expect(existsSync(testStorage.databasePath)).toBe(false)
  })

  test("corrupt existing SQLite bytes are refused rather than repaired or replaced", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    writeFileSync(testStorage.databasePath, "not a sqlite database", { mode: 0o600 })
    chmodSync(testStorage.databasePath, 0o600)
    const bytesBefore = readFileSync(testStorage.databasePath)
    expect(() => testStorage.store.snapshot()).toThrow(SkillOptControllerError)
    expect(() => testStorage.store.initialize()).toThrow(SkillOptControllerError)
    expect(readFileSync(testStorage.databasePath)).toEqual(bytesBefore)
  })

  test("automatic reservation atomically charges quota and leaves dispatch unresolved until reconciliation", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const seed = armedSeed()
    testStorage.store.seedArmedRun(seed)
    const reservation = testStorage.store.reserveAutomatic(reserveInput(seed))
    expect(reservation.requestId).toMatch(/^[0-9a-f-]{36}$/iu)
    expect("ticket" in reservation).toBe(false)
    expect("receipt" in reservation).toBe(false)
    const status = testStorage.store.snapshot()
    expect(status.state).toBe("UNRESOLVED")
    expect(status.pendingDispatch).toBe(true)
    expect(status.requestCounts.charged.target).toBe(1)
    expect(status.requestCounts.unknown.target).toBe(1)
    expect(status.remaining.optimizer).toBe(40)
    expect(status.remaining.target).toBe(511)
    expect(status.remaining.activeMilliseconds).toBe(SKILLOPT_CONTROLLER_LIMITS.activeMilliseconds - SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds)
  })

  test("the first target reservation preserves target reserves and subsequent role budgets remain independent", () => {
    const training = storage()
    training.store.initialize()
    const trainingSeed = armedSeed(randomUUID(), { initialUsage: { targetRequests: 280 } })
    training.store.seedArmedRun(trainingSeed)
    expect(() => training.store.chargeRequest(trainingSeed.runId, "target", "train")).toThrow("budget-exhausted")
    training.store.chargeRequest(trainingSeed.runId, "target", "canary")
    expect(training.store.snapshot().targetPhaseCounts.canary.charged).toBe(1)
    expect(training.store.snapshot().remaining.target).toBe(231)

    const finalSafety = storage()
    finalSafety.store.initialize()
    const finalSeed = armedSeed(randomUUID(), { initialUsage: { targetRequests: 216, finalSafetyRequests: 216 } })
    finalSafety.store.seedArmedRun(finalSeed)
    expect(() => finalSafety.store.chargeRequest(finalSeed.runId, "target", "safety")).toThrow("budget-exhausted")

    const optimizer = storage()
    optimizer.store.initialize()
    const optimizerSeed = armedSeed(randomUUID(), { initialUsage: { optimizerRequests: 40 } })
    optimizer.store.seedArmedRun(optimizerSeed)
    expect(() => optimizer.store.chargeRequest(optimizerSeed.runId, "optimizer", "train")).toThrow("budget-exhausted")

    const reviewer = storage()
    reviewer.store.initialize()
    const reviewerSeed = armedSeed(randomUUID(), { initialUsage: { reviewerRequests: 2 } })
    reviewer.store.seedArmedRun(reviewerSeed)
    expect(() => reviewer.store.chargeRequest(reviewerSeed.runId, "reviewer", "final")).toThrow("budget-exhausted")
  })

  test("transaction faults before commit roll back counters, arm consumption, and pending reservation", () => {
    for (const faultAt of ["after-counter-charge", "after-arm-consume", "after-attempt-insert", "before-commit"] as const) {
      const testStorage = storage()
      testStorage.store.initialize()
      const seed = armedSeed()
      testStorage.store.seedArmedRun(seed)
      expect(() => testStorage.store.reserveWithFault({
        ...reserveInput(seed), fault(point) { if (point === faultAt) throw new Error("injected transaction failure") },
      })).toThrow(SkillOptControllerError)
      const status = testStorage.store.snapshot()
      expect(status.state).toBe("ARMED")
      expect(status.pendingDispatch).toBe(false)
      expect(status.remaining.optimizer).toBe(40)
      expect(status.requestCounts.charged.target).toBe(0)
    }
  })

  test("an actual SQLite constraint failure rolls back the reservation transaction", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const seed = armedSeed()
    testStorage.store.seedArmedRun(seed)
    const database = new Database(testStorage.databasePath)
    try {
      database.exec(`CREATE TRIGGER reject_attempt BEFORE INSERT ON attempts
        BEGIN SELECT RAISE(ABORT, 'test SQLite constraint failure'); END`)
    } finally { database.close() }

    let failure: unknown
    try { testStorage.store.reserveAutomatic(reserveInput(seed)) } catch (error) { failure = error }
    expect(failure instanceof SkillOptControllerError).toBe(true)
    if (!(failure instanceof SkillOptControllerError)) throw new Error("SQLite constraint failure was not reported as a storage error")
    expect(failure.code).toBe("storage-corrupt")

    const status = testStorage.store.snapshot()
    expect(status.state).toBe("ARMED")
    expect(status.pendingDispatch).toBe(false)
    expect(status.requestCounts.charged.target).toBe(0)
    const reopened = new Database(testStorage.databasePath)
    try {
      const quota = reopened.query("SELECT active_run_id,pending_request_id,last_attempt_id FROM quota WHERE singleton=1").get() as {
        active_run_id: string | null; pending_request_id: string | null; last_attempt_id: string | null
      }
      expect(quota.active_run_id).toBeNull()
      expect(quota.pending_request_id).toBeNull()
      expect(quota.last_attempt_id).toBeNull()
      expect((reopened.query("SELECT state FROM arms WHERE run_id=?").get(seed.runId) as { state: string }).state).toBe("armed")
      const usage = reopened.query("SELECT target_requests,active_reserved_ms FROM usage WHERE run_id=?").get(seed.runId) as {
        target_requests: number; active_reserved_ms: number
      }
      expect(usage.target_requests).toBe(0)
      expect(usage.active_reserved_ms).toBe(0)
      expect((reopened.query("SELECT count(*) AS count FROM attempts").get() as { count: number }).count).toBe(0)
      expect((reopened.query("SELECT count(*) AS count FROM requests").get() as { count: number }).count).toBe(0)
    } finally { reopened.close() }
  })

  test("SQLite SQLITE_FULL on the real reservation connection rolls back charges without filling the filesystem", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const seed = armedSeed()
    testStorage.store.seedArmedRun(seed)
    const setup = new Database(testStorage.databasePath)
    try { createSQLiteFullPressureTrigger(setup, "force_sqlite_full_reservation", "AFTER INSERT ON attempts") }
    finally { setup.close() }

    const pageLimit = limitLedgerConnectionPageCount(testStorage.databasePath)
    let failure: unknown
    try { testStorage.store.reserveAutomatic(reserveInput(seed)) } catch (error) { failure = error }
    finally { pageLimit.restore() }
    expect(pageLimit.limitedConnections).toBe(1)
    expect(pageLimit.sqliteFullErrors.length).toBe(1)
    const sqliteFullError = pageLimit.sqliteFullErrors[0]
    if (!sqliteFullError) throw new Error("reservation pressure did not surface a native SQLite error")
    expect(sqliteFullError.code).toBe("SQLITE_FULL")
    expect(sqliteFullError.errno).toBe(13)
    expect(sqliteFullError.statement.includes("INSERT INTO attempts")).toBe(true)
    expect(failure instanceof SkillOptControllerError).toBe(true)
    if (!(failure instanceof SkillOptControllerError)) throw new Error("SQLite SQLITE_FULL was not reported as a storage error")
    expect(failure.code).toBe("storage-corrupt")

    const status = testStorage.store.snapshot()
    expect(status.state).toBe("ARMED")
    expect(status.pendingDispatch).toBe(false)
    expect(status.requestCounts.charged.target).toBe(0)
    expect(status.requestCounts.unknown.target).toBe(0)
    const reopened = new Database(testStorage.databasePath)
    try {
      const quota = reopened.query("SELECT active_run_id,pending_request_id,last_attempt_id FROM quota WHERE singleton=1").get() as {
        active_run_id: string | null; pending_request_id: string | null; last_attempt_id: string | null
      }
      expect(quota.active_run_id).toBeNull()
      expect(quota.pending_request_id).toBeNull()
      expect(quota.last_attempt_id).toBeNull()
      expect((reopened.query("SELECT state FROM arms WHERE run_id=?").get(seed.runId) as { state: string }).state).toBe("armed")
      expect((reopened.query("SELECT target_requests,active_reserved_ms FROM usage WHERE run_id=?").get(seed.runId) as {
        target_requests: number; active_reserved_ms: number
      }).target_requests).toBe(0)
      expect((reopened.query("SELECT count(*) AS count FROM attempts").get() as { count: number }).count).toBe(0)
      expect((reopened.query("SELECT count(*) AS count FROM requests").get() as { count: number }).count).toBe(0)
      expect((reopened.query("SELECT count(*) AS count FROM meta").get() as { count: number }).count).toBe(4)
    } finally { reopened.close() }
  })

  test("a commit whose result is lost stays charged and blocks a second campaign", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const seed = armedSeed()
    testStorage.store.seedArmedRun(seed)
    expect(() => testStorage.store.reserveWithFault({
      ...reserveInput(seed), fault(point) { if (point === "after-commit") throw new Error("simulated process loss after COMMIT") },
    })).toThrow(SkillOptControllerError)
    expect(testStorage.store.snapshot().requestCounts.charged.target).toBe(1)

    const next = armedSeed()
    testStorage.store.seedArmedRun(next)
    expect(() => testStorage.store.reserveAutomatic(reserveInput(next))).toThrow("dispatch-pending")
    expect(testStorage.store.snapshot().pendingDispatch).toBe(true)
  })

  test("SIGKILL with a hot DELETE rollback journal restores the whole reservation transaction", async () => {
    // Synthetic seed rows set up quota state only; the blocked child uses a real SQLite write transaction.
    const testStorage = storage()
    const worktreeRoot = realpathSync.native(testStorage.root)
    const databasePath = join(worktreeRoot, "automation", "ledger.sqlite")
    const seed = armedSeed()
    const input = reserveInput(seed)
    const journalPath = `${databasePath}-journal`
    const beforeCommitPath = join(testStorage.root, "transaction-before-commit")
    let child: SkillOptChildProcess | undefined
    let recovered = false
    testStorage.store.initialize()
    testStorage.store.seedArmedRun(seed)
    const initial = testStorage.store.snapshot()
    const journalModeDb = new Database(databasePath)
    try {
      const mode = journalModeDb.query("PRAGMA journal_mode").get() as Record<string, unknown>
      expect(String(Object.values(mode)[0]).toLowerCase()).toBe("delete")
      createSQLiteFullPressureTrigger(journalModeDb, "force_hot_journal", "AFTER INSERT ON attempts")
    } finally { journalModeDb.close() }

    const moduleUrl = new URL("../src/skillopt/controller.ts", import.meta.url).href
    const script = `import { createSkillOptStorageForTests } from ${JSON.stringify(moduleUrl)};
import { Database } from "bun:sqlite";
import { realpathSync, writeFileSync } from "node:fs";
const env = process.env;
const clock = JSON.parse(env.SKILLOPT_TEST_CLOCK);
const store = createSkillOptStorageForTests({ databasePath: env.SKILLOPT_TEST_DATABASE, worktreeRoot: env.SKILLOPT_TEST_ROOT, clock: () => clock });
store.initialize();
const originalExec = Database.prototype.exec;
let configuredConnections = 0;
Database.prototype.exec = function (sql) {
  const result = originalExec.call(this, sql);
  if (sql !== "PRAGMA secure_delete = ON") return result;
  const main = this.query("PRAGMA database_list").all().find(row => row.name === "main");
  if (!main || realpathSync.native(main.file) !== realpathSync.native(env.SKILLOPT_TEST_DATABASE)) return result;
  originalExec.call(this, "PRAGMA cache_size = 5");
  originalExec.call(this, "PRAGMA cache_spill = 5");
  if (this.query("PRAGMA cache_size").get().cache_size !== 5 ||
      this.query("PRAGMA cache_spill").get().cache_spill !== 5) {
    throw new Error("bounded SQLite cache spill was not configured");
  }
  configuredConnections += 1;
  return result;
};
store.reserveWithFault({
  ...JSON.parse(env.SKILLOPT_TEST_RESERVATION),
  fault(point) {
    if (point !== "before-commit") return;
    if (configuredConnections !== 1) throw new Error("reservation connection was not uniquely configured");
    Database.prototype.exec = originalExec;
    writeFileSync(env.SKILLOPT_TEST_MARKER, String(process.pid), { flag: "wx", mode: 0o600 });
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + Number(env.SKILLOPT_TEST_HOLD_MS);
    while (Date.now() < deadline) Atomics.wait(waitCell, 0, 0, Math.min(1_000, deadline - Date.now()));
    process.exit(71);
  },
});
process.exit(0);`
    try {
      child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          TMPDIR: tmpdir(),
          HOME: join(testStorage.root, "journal-child-home"),
          XDG_STATE_HOME: join(testStorage.root, "journal-child-xdg"),
          OTTER_STATE_HOME: join(testStorage.root, "journal-child-otter"),
          SKILLOPT_TEST_ROOT: worktreeRoot,
          SKILLOPT_TEST_DATABASE: databasePath,
          SKILLOPT_TEST_CLOCK: JSON.stringify(testStorage.clock.sample()),
          SKILLOPT_TEST_RESERVATION: JSON.stringify(input),
          SKILLOPT_TEST_MARKER: beforeCommitPath,
          SKILLOPT_TEST_HOLD_MS: "20000",
        },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      })

      await waitForOwnedFiles([beforeCommitPath, journalPath], "the active reservation transaction and rollback journal")
      expect(child.exitCode).toBeNull()
      expect(Number(readFileSync(beforeCommitPath, "utf8"))).toBe(child.pid)

      const journalStat = lstatSync(journalPath)
      expect(journalStat.isFile()).toBe(true)
      expect(journalStat.isSymbolicLink()).toBe(false)
      const journalBeforeKill = readFileSync(journalPath)
      const rollbackJournalMagic = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7])
      expect(journalBeforeKill.length).toBeGreaterThan(rollbackJournalMagic.length)
      expect(journalBeforeKill.subarray(0, rollbackJournalMagic.length)).toEqual(rollbackJournalMagic)

      // before-commit follows the charge, arm consume, attempt/request inserts, run update, and quota update.
      // The live journal contains the prior pages while the callback holds the SQLite transaction open.
      child.kill("SIGKILL")
      const [exitCode, stdout, stderr] = await withChildTimeout(Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]), "SIGKILL of the journal-held reservation process")
      expect(exitCode).not.toBe(0)
      expect(child.signalCode).toBe("SIGKILL")
      expect(stdout).toBe("")
      expect(stderr).toBe("")

      const hotJournal = readFileSync(journalPath)
      expect(hotJournal.subarray(0, rollbackJournalMagic.length)).toEqual(rollbackJournalMagic)
      expect(hotJournal.length).toBeGreaterThan(rollbackJournalMagic.length)

      const reopened = createSkillOptStorageForTests({ databasePath, worktreeRoot, clock: testStorage.clock.sample })
      reopened.initialize()
      expect(existsSync(journalPath)).toBe(false)
      expect(reopened.snapshot()).toEqual(initial)

      const db = new Database(databasePath, { readonly: true })
      try {
        const run = db.query("SELECT state,revision FROM runs WHERE run_id=?").get(seed.runId) as { state: string; revision: number }
        expect(run).toEqual({ state: "ARMED", revision: input.expectedRevision })
        expect(db.query("SELECT state,reservation_id FROM arms WHERE arm_id=?").get(seed.armId)).toEqual({ state: "armed", reservation_id: null })
        const usage = db.query("SELECT target_requests,active_reserved_ms FROM usage WHERE run_id=?").get(seed.runId) as {
          target_requests: number; active_reserved_ms: number
        }
        expect(usage).toEqual({ target_requests: 0, active_reserved_ms: 0 })
        expect(db.query("SELECT active_run_id,pending_request_id,last_attempt_id FROM quota WHERE singleton=1").get()).toEqual({
          active_run_id: null, pending_request_id: null, last_attempt_id: null,
        })
        expect((db.query("SELECT count(*) AS count FROM attempts").get() as { count: number }).count).toBe(0)
        expect((db.query("SELECT count(*) AS count FROM requests").get() as { count: number }).count).toBe(0)
      } finally { db.close() }
      recovered = true
    } catch (error) {
      retainTestRoot(testStorage.root)
      const detail = error instanceof Error ? error.message : String(error)
      const reportPath = join(testStorage.root, "failure-report.json")
      writeFileSync(reportPath, `${JSON.stringify({
        schemaVersion: 1,
        kind: "skillopt-delete-journal-sigkill-fixture",
        root: testStorage.root,
        artifacts: { database: databasePath, rollbackJournal: journalPath, beforeCommitMarker: beforeCommitPath },
        failure: detail,
      }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
      throw new Error(`rollback-journal SIGKILL fixture retained at ${testStorage.root} (report ${reportPath}): ${detail}`)
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL")
        await withChildTimeout(child.exited, "owned rollback-journal child process cleanup", 1_000)
      }
      if (!recovered) retainTestRoot(testStorage.root)
    }
  }, { timeout: 30_000 })

  test("independent child processes race one synthetic automatic quota reservation", async () => {
    // Synthetic test-storage seeds exercise quota transaction semantics only, not live admission or approval.
    const testStorage = storage()
    const worktreeRoot = realpathSync.native(testStorage.root)
    const databasePath = join(worktreeRoot, "automation", "ledger.sqlite")
    const candidates = [armedSeed(), armedSeed()]
    testStorage.store.initialize()
    for (const candidate of candidates) testStorage.store.seedArmedRun(candidate)

    const moduleUrl = new URL("../src/skillopt/controller.ts", import.meta.url).href
    const script = `import { createSkillOptStorageForTests } from ${JSON.stringify(moduleUrl)};
import { existsSync, writeFileSync } from "node:fs";
const env = process.env;
const clock = JSON.parse(env.SKILLOPT_TEST_CLOCK);
const store = createSkillOptStorageForTests({ databasePath: env.SKILLOPT_TEST_DATABASE, worktreeRoot: env.SKILLOPT_TEST_ROOT, clock: () => clock });
store.initialize();
writeFileSync(env.SKILLOPT_TEST_READY, String(process.pid), { mode: 0o600 });
const deadline = Date.now() + Number(env.SKILLOPT_TEST_TIMEOUT_MS);
while (!existsSync(env.SKILLOPT_TEST_GO) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
if (!existsSync(env.SKILLOPT_TEST_GO)) { process.stderr.write("ready/go barrier timed out"); process.exit(70); }
const input = JSON.parse(env.SKILLOPT_TEST_RESERVATION);
try {
  const reservation = store.reserveAutomatic(input);
  writeFileSync(env.SKILLOPT_TEST_RESULT, JSON.stringify({ kind: "reserved", runId: input.runId, reservation }), { mode: 0o600 });
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  writeFileSync(env.SKILLOPT_TEST_RESULT, JSON.stringify({ kind: "refused", runId: input.runId, code }), { mode: 0o600 });
}`
    const goPath = join(testStorage.root, "race-go")
    const children: Array<{
      child: SkillOptChildProcess
      readyPath: string
      resultPath: string
    }> = []
    const completed = new Set<SkillOptChildProcess>()
    try {
      for (const [index, candidate] of candidates.entries()) {
        const readyPath = join(testStorage.root, `race-ready-${index}`)
        const resultPath = join(testStorage.root, `race-result-${index}`)
        const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH ?? "",
            TMPDIR: tmpdir(),
            HOME: join(testStorage.root, `child-home-${index}`),
            XDG_STATE_HOME: join(testStorage.root, `child-xdg-${index}`),
            OTTER_STATE_HOME: join(testStorage.root, `child-otter-${index}`),
            SKILLOPT_TEST_ROOT: worktreeRoot,
            SKILLOPT_TEST_DATABASE: databasePath,
            SKILLOPT_TEST_CLOCK: JSON.stringify(testStorage.clock.sample()),
            SKILLOPT_TEST_RESERVATION: JSON.stringify(reserveInput(candidate)),
            SKILLOPT_TEST_READY: readyPath,
            SKILLOPT_TEST_GO: goPath,
            SKILLOPT_TEST_RESULT: resultPath,
            SKILLOPT_TEST_TIMEOUT_MS: String(childProcessTimeoutMs),
          },
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        })
        children.push({ child, readyPath, resultPath })
      }

      await waitForOwnedFiles(children.map(({ readyPath }) => readyPath), "both reservation child processes to become ready")
      writeFileSync(goPath, "go", { flag: "wx", mode: 0o600 })
      type Outcome =
        | { kind: "reserved"; runId: string; reservation: { reservationId: string; requestId: string; revision: number } }
        | { kind: "refused"; runId: string; code: string | null }
      const outcomes = await Promise.all(children.map(async ({ child, resultPath }) => {
        const [exitCode, stdout, stderr] = await withChildTimeout(Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]), "reservation child process completion")
        completed.add(child)
        expect(exitCode).toBe(0)
        expect(stdout).toBe("")
        expect(stderr).toBe("")
        expect(existsSync(resultPath)).toBe(true)
        return JSON.parse(readFileSync(resultPath, "utf8")) as Outcome
      }))

      const winners = outcomes.filter((outcome): outcome is Extract<Outcome, { kind: "reserved" }> => outcome.kind === "reserved")
      const refusals = outcomes.filter((outcome): outcome is Extract<Outcome, { kind: "refused" }> => outcome.kind === "refused")
      expect(winners).toHaveLength(1)
      expect(refusals).toHaveLength(1)
      const winner = winners[0]!
      const refusal = refusals[0]!
      expect(refusal.code).toBe("dispatch-pending")
      expect(refusal.runId).not.toBe(winner.runId)
      expect(winner.reservation.revision).toBe(3)
      expect(winner.reservation.reservationId).toMatch(/^[0-9a-f-]{36}$/iu)
      expect(winner.reservation.requestId).toMatch(/^[0-9a-f-]{36}$/iu)
      // The storage seam intentionally returns no branded dispatch ticket or receipt.
      expect(Object.keys(winner.reservation).sort()).toEqual(["requestId", "reservationId", "revision"])

      const db = new Database(testStorage.databasePath)
      try {
        const armRows = db.query("SELECT run_id,arm_id,state,reservation_id FROM arms ORDER BY run_id").all() as Array<{
          run_id: string; arm_id: string; state: string; reservation_id: string | null
        }>
        expect(armRows).toEqual(candidates.map((candidate) => ({
          run_id: candidate.runId, arm_id: candidate.armId,
          state: candidate.runId === winner.runId ? "consumed" : "armed",
          reservation_id: candidate.runId === winner.runId ? winner.reservation.reservationId : null,
        })).sort((left, right) => left.run_id.localeCompare(right.run_id)))

        const attempts = db.query(`SELECT run_id,reservation_id,request_id,trigger_kind,charged,actual_dispatch,dispatch_state
          FROM attempts ORDER BY run_id`).all() as Array<{
          run_id: string; reservation_id: string; request_id: string; trigger_kind: string; charged: number
          actual_dispatch: number | null; dispatch_state: string
        }>
        expect(attempts).toEqual([{
          run_id: winner.runId, reservation_id: winner.reservation.reservationId, request_id: winner.reservation.requestId,
          trigger_kind: "automatic", charged: 1, actual_dispatch: null, dispatch_state: "possible",
        }])
        const requests = db.query(`SELECT run_id,request_id,reservation_id,role,phase,charged,actual_dispatch,dispatch_state
          FROM requests ORDER BY run_id`).all() as Array<{
          run_id: string; request_id: string; reservation_id: string; role: string; phase: string; charged: number
          actual_dispatch: number | null; dispatch_state: string
        }>
        expect(requests).toEqual([{
          run_id: winner.runId, request_id: winner.reservation.requestId, reservation_id: winner.reservation.reservationId,
          role: "target", phase: "train", charged: 1, actual_dispatch: null, dispatch_state: "possible",
        }])
        const usage = db.query("SELECT run_id,target_requests FROM usage ORDER BY run_id").all() as Array<{ run_id: string; target_requests: number }>
        expect(Object.fromEntries(usage.map(({ run_id, target_requests }) => [run_id, target_requests]))).toEqual({
          [candidates[0]!.runId]: candidates[0]!.runId === winner.runId ? 1 : 0,
          [candidates[1]!.runId]: candidates[1]!.runId === winner.runId ? 1 : 0,
        })

        const rootBinding = hash(worktreeRoot)
        const target = ".agents/skills/llm-wiki/SKILL.md"
        const quotaRows = db.query(`SELECT quota_key,root_binding,target,active_run_id,pending_request_id,last_attempt_id
          FROM quota WHERE singleton=1`).all() as Array<{
          quota_key: string; root_binding: string; target: string; active_run_id: string | null
          pending_request_id: string | null; last_attempt_id: string | null
        }>
        expect(quotaRows).toEqual([{
          quota_key: sha256(canonicalJson({ schema: "skillopt.automation-quota-key.v1", rootBinding, target })),
          root_binding: rootBinding, target, active_run_id: winner.runId,
          pending_request_id: winner.reservation.requestId, last_attempt_id: winner.reservation.reservationId,
        }])
      } finally { db.close() }

      const status = testStorage.store.snapshot()
      expect(status).toMatchObject({
        state: "UNRESOLVED", runId: winner.runId, pendingDispatch: true,
        requestCounts: { charged: { target: 1 }, dispatched: { target: 0 }, unknown: { target: 1 } },
      })
    } catch (error) {
      retainTestRoot(testStorage.root)
      const detail = error instanceof Error ? error.message : String(error)
      const reportPath = join(testStorage.root, "failure-report.json")
      writeFileSync(reportPath, `${JSON.stringify({
        schemaVersion: 1,
        kind: "skillopt-cross-process-quota-race-fixture",
        root: testStorage.root,
        artifacts: {
          database: databasePath,
          goMarker: goPath,
          readyMarkers: children.map(({ readyPath }) => readyPath),
          resultFiles: children.map(({ resultPath }) => resultPath),
        },
        syntheticRunIds: candidates.map(({ runId }) => runId),
        failure: detail,
      }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
      throw new Error(`quota-race fixture retained at ${testStorage.root} (report ${reportPath}): ${detail}`)
    } finally {
      for (const { child } of children) {
        if (!completed.has(child)) await stopOwnedChild(child)
      }
    }
  }, { timeout: 30_000 })

  test("process loss after durable reservation commit survives cold reopen without a retry", async () => {
    // Synthetic storage seeds exercise quota transactions only; this is not live admission or dispatch proof.
    const testStorage = storage()
    const worktreeRoot = realpathSync.native(testStorage.root)
    const databasePath = join(worktreeRoot, "automation", "ledger.sqlite")
    const first = armedSeed()
    const next = armedSeed()
    const firstInput = reserveInput(first)
    const nextInput = reserveInput(next)
    testStorage.store.initialize()
    testStorage.store.seedArmedRun(first)
    testStorage.store.seedArmedRun(next)

    const moduleUrl = new URL("../src/skillopt/controller.ts", import.meta.url).href
    const crashMarker = join(testStorage.root, "after-commit")
    const ackPath = join(testStorage.root, "reservation-ack")
    const reopenPath = join(testStorage.root, "cold-reopen-result")
    const crashScript = `import { createSkillOptStorageForTests } from ${JSON.stringify(moduleUrl)};
import { writeFileSync } from "node:fs";
const env = process.env;
const clock = JSON.parse(env.SKILLOPT_TEST_CLOCK);
const store = createSkillOptStorageForTests({ databasePath: env.SKILLOPT_TEST_DATABASE, worktreeRoot: env.SKILLOPT_TEST_ROOT, clock: () => clock });
store.initialize();
const input = JSON.parse(env.SKILLOPT_TEST_RESERVATION);
store.reserveWithFault({
  ...input,
  fault(point) {
    if (point === "after-commit") {
      writeFileSync(env.SKILLOPT_TEST_CRASH_MARKER, "after-commit", { flag: "wx", mode: 0o600 });
      process.exit(73);
    }
  },
});
writeFileSync(env.SKILLOPT_TEST_ACK, "unexpected reservation acknowledgment", { flag: "wx", mode: 0o600 });
process.exit(74);`
    const crashChild = Bun.spawn([process.execPath, "--no-env-file", "-e", crashScript], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: tmpdir(),
        HOME: join(testStorage.root, "crash-home"),
        XDG_STATE_HOME: join(testStorage.root, "crash-xdg"),
        OTTER_STATE_HOME: join(testStorage.root, "crash-otter"),
        SKILLOPT_TEST_ROOT: worktreeRoot,
        SKILLOPT_TEST_DATABASE: databasePath,
        SKILLOPT_TEST_CLOCK: JSON.stringify(testStorage.clock.sample()),
        SKILLOPT_TEST_RESERVATION: JSON.stringify(firstInput),
        SKILLOPT_TEST_CRASH_MARKER: crashMarker,
        SKILLOPT_TEST_ACK: ackPath,
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    let crashChildCompleted = false
    try {
      const [crashExit, crashStdout, crashStderr] = await withChildTimeout(Promise.all([
        crashChild.exited, new Response(crashChild.stdout).text(), new Response(crashChild.stderr).text(),
      ]), "post-commit crash child completion")
      crashChildCompleted = true
      expect(crashExit).toBe(73)
      expect(crashStdout).toBe("")
      expect(crashStderr).toBe("")
      expect(readFileSync(crashMarker, "utf8")).toBe("after-commit")
      expect(existsSync(ackPath)).toBe(false)

      const reopenScript = `import { createSkillOptStorageForTests } from ${JSON.stringify(moduleUrl)};
import { writeFileSync } from "node:fs";
const env = process.env;
const clock = JSON.parse(env.SKILLOPT_TEST_CLOCK);
const store = createSkillOptStorageForTests({ databasePath: env.SKILLOPT_TEST_DATABASE, worktreeRoot: env.SKILLOPT_TEST_ROOT, clock: () => clock });
store.initialize();
const before = store.snapshot();
const reserve = input => {
  try { return { kind: "reserved", reservation: store.reserveAutomatic(input) }; }
  catch (error) { return { kind: "refused", code: error && typeof error === "object" && "code" in error ? error.code : null }; }
};
const sameRunRetry = reserve(JSON.parse(env.SKILLOPT_TEST_FIRST_RESERVATION));
const nextCampaign = reserve(JSON.parse(env.SKILLOPT_TEST_NEXT_RESERVATION));
const after = store.snapshot();
writeFileSync(env.SKILLOPT_TEST_RESULT, JSON.stringify({ before, sameRunRetry, nextCampaign, after }), { flag: "wx", mode: 0o600 });`
      const reopenChild = Bun.spawn([process.execPath, "--no-env-file", "-e", reopenScript], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          TMPDIR: tmpdir(),
          HOME: join(testStorage.root, "reopen-home"),
          XDG_STATE_HOME: join(testStorage.root, "reopen-xdg"),
          OTTER_STATE_HOME: join(testStorage.root, "reopen-otter"),
          SKILLOPT_TEST_ROOT: worktreeRoot,
          SKILLOPT_TEST_DATABASE: databasePath,
          SKILLOPT_TEST_CLOCK: JSON.stringify(testStorage.clock.sample()),
          SKILLOPT_TEST_FIRST_RESERVATION: JSON.stringify(firstInput),
          SKILLOPT_TEST_NEXT_RESERVATION: JSON.stringify(nextInput),
          SKILLOPT_TEST_RESULT: reopenPath,
        },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      })
      let reopenChildCompleted = false
      try {
        const [exitCode, stdout, stderr] = await withChildTimeout(Promise.all([
          reopenChild.exited, new Response(reopenChild.stdout).text(), new Response(reopenChild.stderr).text(),
        ]), "cold reopen child completion")
        reopenChildCompleted = true
        expect(exitCode).toBe(0)
        expect(stdout).toBe("")
        expect(stderr).toBe("")
        expect(existsSync(reopenPath)).toBe(true)

        type Snapshot = ReturnType<typeof testStorage.store.snapshot>
        const reopened = JSON.parse(readFileSync(reopenPath, "utf8")) as {
          before: Snapshot
          sameRunRetry: { kind: string; code?: string | null; reservation?: unknown }
          nextCampaign: { kind: string; code?: string | null; reservation?: unknown }
          after: Snapshot
        }
        expect(reopened.before).toMatchObject({
          state: "UNRESOLVED", runId: first.runId, pendingDispatch: true,
          requestCounts: { charged: { target: 1 }, dispatched: { target: 0 }, unknown: { target: 1 } },
        })
        expect(reopened.sameRunRetry).toEqual({ kind: "refused", code: "dispatch-pending" })
        expect(reopened.nextCampaign).toEqual({ kind: "refused", code: "dispatch-pending" })
        expect(reopened.after).toEqual(reopened.before)

        const db = new Database(testStorage.databasePath)
        try {
          const attempts = db.query(`SELECT run_id,reservation_id,request_id,trigger_kind,charged,actual_dispatch,dispatch_state
            FROM attempts ORDER BY run_id`).all() as Array<{
            run_id: string; reservation_id: string; request_id: string; trigger_kind: string; charged: number
            actual_dispatch: number | null; dispatch_state: string
          }>
          expect(attempts).toHaveLength(1)
          const attempt = attempts[0]!
          expect(attempt).toMatchObject({
            run_id: first.runId, trigger_kind: "automatic", charged: 1, actual_dispatch: null, dispatch_state: "possible",
          })
          expect(attempt.reservation_id).toMatch(/^[0-9a-f-]{36}$/iu)
          expect(attempt.request_id).toMatch(/^[0-9a-f-]{36}$/iu)

          const arms = db.query("SELECT run_id,arm_id,state,reservation_id FROM arms ORDER BY run_id").all() as Array<{
            run_id: string; arm_id: string; state: string; reservation_id: string | null
          }>
          expect(arms).toEqual([
            { run_id: first.runId, arm_id: first.armId, state: "consumed", reservation_id: attempt.reservation_id },
            { run_id: next.runId, arm_id: next.armId, state: "armed", reservation_id: null },
          ].sort((left, right) => left.run_id.localeCompare(right.run_id)))

          const requests = db.query(`SELECT run_id,request_id,reservation_id,charged,actual_dispatch,dispatch_state
            FROM requests ORDER BY run_id`).all() as Array<{
            run_id: string; request_id: string; reservation_id: string; charged: number
            actual_dispatch: number | null; dispatch_state: string
          }>
          expect(requests).toEqual([{
            run_id: first.runId, request_id: attempt.request_id, reservation_id: attempt.reservation_id,
            charged: 1, actual_dispatch: null, dispatch_state: "possible",
          }])
          const usage = db.query("SELECT run_id,target_requests FROM usage ORDER BY run_id").all() as Array<{ run_id: string; target_requests: number }>
          expect(Object.fromEntries(usage.map(({ run_id, target_requests }) => [run_id, target_requests]))).toEqual({
            [first.runId]: 1, [next.runId]: 0,
          })
          const quota = db.query(`SELECT active_run_id,pending_request_id,last_attempt_id FROM quota WHERE singleton=1`).get() as {
            active_run_id: string | null; pending_request_id: string | null; last_attempt_id: string | null
          }
          expect(quota).toEqual({ active_run_id: first.runId, pending_request_id: attempt.request_id, last_attempt_id: attempt.reservation_id })
        } finally { db.close() }
      } finally {
        if (!reopenChildCompleted) await stopOwnedChild(reopenChild)
      }
    } catch (error) {
      retainTestRoot(testStorage.root)
      const detail = error instanceof Error ? error.message : String(error)
      const reportPath = join(testStorage.root, "failure-report.json")
      writeFileSync(reportPath, `${JSON.stringify({
        schemaVersion: 1,
        kind: "skillopt-post-commit-process-loss-fixture",
        root: testStorage.root,
        artifacts: { database: databasePath, afterCommitMarker: crashMarker, missingAck: ackPath, coldReopenResult: reopenPath },
        syntheticRunIds: [first.runId, next.runId],
        failure: detail,
      }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
      throw new Error(`post-commit process-loss fixture retained at ${testStorage.root} (report ${reportPath}): ${detail}`)
    } finally {
      if (!crashChildCompleted) await stopOwnedChild(crashChild)
    }
  }, { timeout: 30_000 })

  test("a known pre-dispatch cancellation releases the slot but never refunds the committed attempt", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const first = armedSeed()
    testStorage.store.seedArmedRun(first)
    const reservation = testStorage.store.reserveAutomatic(reserveInput(first))
    testStorage.store.settle(first.runId, reservation.requestId)
    const status = testStorage.store.snapshot()
    expect(status.state).toBe("CANCELLED")
    expect(status.pendingDispatch).toBe(false)
    expect(status.requestCounts.charged.target).toBe(1)
    expect(status.requestCounts.dispatched.target).toBe(0)

    const second = armedSeed()
    testStorage.store.seedArmedRun(second)
    expect(() => testStorage.store.reserveAutomatic(reserveInput(second))).toThrow("daily-limit")
  })

  test("different SQLite connections serialize duplicate reservations under one fixed quota key", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const other = createSkillOptStorageForTests({
      databasePath: testStorage.databasePath, worktreeRoot: testStorage.root, clock: testStorage.clock.sample,
    })
    other.initialize()
    const seed = armedSeed()
    testStorage.store.seedArmedRun(seed)
    const input = reserveInput(seed)
    const first = testStorage.store.reserveAutomatic(input)
    expect(() => other.reserveAutomatic(input)).toThrow(SkillOptControllerError)
    expect(first.requestId).toBeTruthy()
    expect(other.snapshot().requestCounts.charged.target).toBe(1)
  })

  test("binding, revision, and consent expiry drift reserve no additional requests", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const seed = armedSeed()
    testStorage.store.seedArmedRun(seed)
    expect(() => testStorage.store.reserveAutomatic(reserveInput(seed, { bindingHash: "c".repeat(64) }))).toThrow("consent-binding-drift")
    expect(() => testStorage.store.reserveAutomatic(reserveInput(seed, { expectedRevision: 3 }))).toThrow("revision-conflict")
    expect(testStorage.store.snapshot().requestCounts.charged.target).toBe(0)

    testStorage.clock.advance(24 * 60 * 60 * 1000 + 1)
    expect(() => testStorage.store.reserveAutomatic(reserveInput(seed))).toThrow("consent-expired")
    expect(testStorage.store.snapshot().requestCounts.charged.target).toBe(0)
  })

  test("wall-clock discontinuity invalidates consent/arms and blocks new reservations", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const seed = armedSeed()
    testStorage.store.seedArmedRun(seed)
    testStorage.clock.stepWall(6 * 60 * 1000)
    expect(() => testStorage.store.reserveAutomatic(reserveInput(seed))).toThrow("clock-uncertain")
    const status = testStorage.store.snapshot()
    expect(status.state).toBe("BLOCKED")
    expect(status.reasonCode).toBe("clock-uncertain")
    expect(status.requestCounts.charged.target).toBe(0)
  })

  test("wall jumps of +48 hours and -1 hour invalidate old consent and cannot be cleared by fresh seed rows", () => {
    for (const wallJump of [48 * 60 * 60 * 1000, -60 * 60 * 1000]) {
      const testStorage = storage()
      testStorage.store.initialize()
      const oldSeed = armedSeed()
      testStorage.store.seedArmedRun(oldSeed)
      testStorage.clock.stepWall(wallJump)

      expect(() => testStorage.store.reserveAutomatic(reserveInput(oldSeed))).toThrow("clock-uncertain")
      const status = testStorage.store.snapshot()
      expect(status.state).toBe("BLOCKED")
      expect(status.reasonCode).toBe("clock-uncertain")
      expect(status.requestCounts.charged.target).toBe(0)

      const database = new Database(testStorage.databasePath)
      try {
        const consent = database.query("SELECT state FROM consents WHERE run_id=?").get(oldSeed.runId) as { state: string }
        const arm = database.query("SELECT state FROM arms WHERE run_id=?").get(oldSeed.runId) as { state: string }
        expect(consent.state).toBe("invalidated")
        expect(arm.state).toBe("revoked")
      } finally { database.close() }

      // This test-only row is not a production consent or authority. It proves a new seed cannot clear
      // the durable anomaly bit; the production controller has no path to issue fresh consent while blocked.
      const freshSeed = armedSeed()
      testStorage.store.seedArmedRun(freshSeed)
      expect(() => testStorage.store.reserveAutomatic(reserveInput(freshSeed))).toThrow("clock-uncertain")
      testStorage.clock.advance(SKILLOPT_CONTROLLER_LIMITS.dailyCooldownMilliseconds)
      const cooledFreshSeed = armedSeed()
      testStorage.store.seedArmedRun(cooledFreshSeed)
      expect(() => testStorage.store.reserveAutomatic(reserveInput(cooledFreshSeed))).toThrow("clock-uncertain")
      expect(testStorage.store.snapshot().requestCounts.charged.target).toBe(0)
      const attempts = new Database(testStorage.databasePath)
      try {
        expect((attempts.query("SELECT count(*) AS count FROM attempts").get() as { count: number }).count).toBe(0)
      } finally { attempts.close() }
    }
  })

  test("a monotonic decrease invalidates consent and blocks the committed clock state", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const seed = armedSeed()
    testStorage.store.seedArmedRun(seed)
    testStorage.clock.stepMonotonic(-1_000_000n)

    expect(() => testStorage.store.reserveAutomatic(reserveInput(seed))).toThrow("clock-uncertain")
    const status = testStorage.store.snapshot()
    expect(status.state).toBe("BLOCKED")
    expect(status.reasonCode).toBe("clock-uncertain")
    expect(status.requestCounts.charged.target).toBe(0)
    const database = new Database(testStorage.databasePath)
    try {
      expect((database.query("SELECT state FROM consents WHERE run_id=?").get(seed.runId) as { state: string }).state)
        .toBe("invalidated")
      expect((database.query("SELECT state FROM arms WHERE run_id=?").get(seed.runId) as { state: string }).state)
        .toBe("revoked")
    } finally { database.close() }
  })

  test.skipIf(!nativeClockSupported)("a native clock discontinuity atomically revokes existing consent and arm state", async () => {
    const fixture = await reentryFixture("ARMED")
    const before = fixture.controller.status()
    const sample = readSkillOptNativeClock({ nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! })
    const database = new Database(reentryDatabase(fixture.root))
    try {
      database.query("UPDATE quota SET clock_wall=? WHERE singleton=1")
        .run((BigInt(sample.wallMilliseconds) - 600_000n).toString())
    } finally { database.close() }

    expect(() => fixture.controller.prepare({ owner: fixture.owner, campaignId: `jump_${randomUUID().replaceAll("-", "")}`,
      ...fixture.current })).toThrow("clock-uncertain")
    const after = fixture.controller.status()
    expect(after.state).toBe("BLOCKED")
    expect(after.reasonCode).toBe("clock-uncertain")
    expect(after.requestCounts.charged.target).toBe(before.requestCounts.charged.target)
    const latched = new Database(reentryDatabase(fixture.root))
    try {
      const quota = latched.query("SELECT clock_uncertain,fence_boot,fence_cont,active_run_id,pending_request_id FROM quota WHERE singleton=1").get() as {
        clock_uncertain: number; fence_boot: string | null; fence_cont: string | null
        active_run_id: string | null; pending_request_id: string | null
      }
      expect(quota.clock_uncertain).toBe(1)
      expect(quota.fence_boot).toBe(sample.bootId)
      expect(quota.fence_cont).not.toBeNull()
      expect(quota.active_run_id).toBeNull()
      expect(quota.pending_request_id).toBeNull()
      expect((latched.query("SELECT state FROM consents WHERE run_id=?").get(fixture.prepared.runId) as { state: string }).state)
        .toBe("invalidated")
      expect((latched.query("SELECT state FROM arms WHERE run_id=?").get(fixture.prepared.runId) as { state: string }).state)
        .toBe("revoked")
      expect((latched.query("SELECT count(*) AS count FROM attempts").get() as { count: number }).count).toBe(0)
    } finally { latched.close() }
  })

  test("clock uncertainty clears only in a fresh preparation at the same-boot 24-hour boundary", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const seed = armedSeed()
    testStorage.store.seedArmedRun(seed)
    testStorage.clock.stepWall(48 * 60 * 60 * 1000)
    expect(() => testStorage.store.reserveAutomatic(reserveInput(seed))).toThrow("clock-uncertain")

    // A wall-clock correction restarts the fence; wall time alone cannot satisfy monotonic cooldown.
    testStorage.clock.stepWall(-48 * 60 * 60 * 1000)
    expect(() => testStorage.store.prepareForTests()).toThrow("clock-uncertain")
    testStorage.clock.advance(SKILLOPT_CONTROLLER_LIMITS.dailyCooldownMilliseconds - 1)
    expect(() => testStorage.store.prepareForTests()).toThrow("clock-uncertain")
    expect(testStorage.store.snapshot().reasonCode).toBe("clock-uncertain")

    testStorage.clock.advance(1)
    const prepared = testStorage.store.prepareForTests()
    expect(prepared.revision).toBe(1)
    const database = new Database(testStorage.databasePath)
    try {
      const quota = database.query("SELECT clock_uncertain,active_run_id,pending_request_id FROM quota WHERE singleton=1").get() as {
        clock_uncertain: number; active_run_id: string | null; pending_request_id: string | null
      }
      expect(quota.clock_uncertain).toBe(0)
      expect(quota.active_run_id).toBeNull()
      expect(quota.pending_request_id).toBeNull()
      expect((database.query("SELECT state FROM runs WHERE run_id=?").get(prepared.runId) as { state: string }).state).toBe("PREPARED")
      expect((database.query("SELECT state FROM consents WHERE run_id=?").get(seed.runId) as { state: string }).state).toBe("invalidated")
      expect((database.query("SELECT state FROM arms WHERE run_id=?").get(seed.runId) as { state: string }).state).toBe("revoked")
      expect((database.query("SELECT count(*) AS count FROM attempts").get() as { count: number }).count).toBe(0)
    } finally { database.close() }
  })

  test("clock uncertainty cannot clear while charged work remains active or pending", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const seed = armedSeed()
    testStorage.store.seedArmedRun(seed)
    const reservation = testStorage.store.reserveAutomatic(reserveInput(seed))
    testStorage.clock.stepWall(6 * 60 * 1000)
    expect(() => testStorage.store.reserveAutomatic(reserveInput(seed))).toThrow("clock-uncertain")
    testStorage.clock.advance(SKILLOPT_CONTROLLER_LIMITS.dailyCooldownMilliseconds)
    expect(() => testStorage.store.prepareForTests()).toThrow("clock-uncertain")

    const status = testStorage.store.snapshot()
    expect(status.reasonCode).toBe("dispatch-pending")
    expect(status.pendingDispatch).toBe(true)
    expect(status.requestCounts.charged.target).toBe(1)
    expect(status.requestCounts.dispatched.target).toBe(0)
    expect(status.requestCounts.unknown.target).toBe(1)
    const database = new Database(testStorage.databasePath)
    try {
      const quota = database.query("SELECT clock_uncertain,active_run_id,pending_request_id FROM quota WHERE singleton=1").get() as {
        clock_uncertain: number; active_run_id: string | null; pending_request_id: string | null
      }
      expect(quota.clock_uncertain).toBe(1)
      expect(quota.active_run_id).toBe(seed.runId)
      expect(quota.pending_request_id).toBe(reservation.requestId)
      expect((database.query("SELECT count(*) AS count FROM attempts").get() as { count: number }).count).toBe(1)
    } finally { database.close() }
  })

  test("a reboot during clock quarantine starts a new 24-hour continuity fence", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const seed = armedSeed()
    testStorage.store.seedArmedRun(seed)
    testStorage.clock.stepWall(48 * 60 * 60 * 1000)
    expect(() => testStorage.store.reserveAutomatic(reserveInput(seed))).toThrow("clock-uncertain")
    testStorage.clock.advance(12 * 60 * 60 * 1000)
    testStorage.clock.reboot()
    expect(() => testStorage.store.prepareForTests()).toThrow("clock-uncertain")

    const database = new Database(testStorage.databasePath)
    try {
      const fence = database.query("SELECT fence_boot,fence_cont FROM quota WHERE singleton=1").get() as {
        fence_boot: string | null; fence_cont: string | null
      }
      expect(fence.fence_boot).toBe(bootB)
      expect(fence.fence_cont).toBe("1000")
    } finally { database.close() }

    testStorage.clock.advance(SKILLOPT_CONTROLLER_LIMITS.dailyCooldownMilliseconds - 1)
    expect(() => testStorage.store.prepareForTests()).toThrow("clock-uncertain")
    testStorage.clock.advance(1)
    const prepared = testStorage.store.prepareForTests()
    expect(prepared.revision).toBe(1)
    expect(testStorage.store.snapshot().reasonCode).not.toBe("clock-uncertain")
  })

  test.skipIf(!nativeClockSupported)("native clock helper failure durably invalidates old prepared authority before blocking", async () => {
    const syntheticClockSample: SkillOptClockSample = {
      protocol: "skillopt-promotion.v3", platform: process.platform === "darwin" ? "darwin" : "linux",
      bootId: bootA, continuousNanoseconds: "1000000000000", wallMilliseconds: String(Date.now()),
    }
    const fixture = await reentryFixture("PREPARED", syntheticClockSample)
    if (!fixture.syntheticClock) throw new Error("synthetic native clock helper was not installed")
    const oldReceipt = await approveReentry(fixture.prepared.decisionBinding)
    const unavailableHelper = join(fixture.root, "missing-native-clock-helper")
    const blockedController = createSkillOptController(fixture.runtime,
      { nativeHelperPath: unavailableHelper, nativeHelperSha256: fixture.syntheticClock.helper.nativeHelperSha256 }, fixture.nativeHost)
    blockedController.initialize()
    expect(() => blockedController.prepare({ owner: fixture.owner, campaignId: `clock_${randomUUID().replaceAll("-", "")}`,
      ...fixture.current })).toThrow("clock-uncertain")
    const recoveryAnchorSample: SkillOptClockSample = {
      ...syntheticClockSample,
      continuousNanoseconds: (BigInt(syntheticClockSample.continuousNanoseconds) + 1_000_000_000n).toString(),
      wallMilliseconds: (BigInt(syntheticClockSample.wallMilliseconds) + 1_000n).toString(),
    }
    fixture.syntheticClock.setSample(recoveryAnchorSample)

    const blocked = fixture.controller.status()
    expect(blocked.state).toBe("BLOCKED")
    expect(blocked.reasonCode).toBe("clock-uncertain")
    expect(blocked.requestCounts.charged.target).toBe(0)
    const database = new Database(reentryDatabase(fixture.root))
    try {
      const quota = database.query("SELECT clock_uncertain,fence_boot,fence_cont,active_run_id,pending_request_id FROM quota WHERE singleton=1").get() as {
        clock_uncertain: number; fence_boot: string | null; fence_cont: string | null
        active_run_id: string | null; pending_request_id: string | null
      }
      const oldRun = database.query("SELECT revision,state FROM runs WHERE run_id=?").get(fixture.prepared.runId) as {
        revision: number; state: string
      }
      expect(quota.clock_uncertain).toBe(1)
      expect(quota.fence_boot).toBeNull()
      expect(quota.fence_cont).toBeNull()
      expect(quota.active_run_id).toBeNull()
      expect(quota.pending_request_id).toBeNull()
      expect(oldRun.revision).toBe(fixture.prepared.decisionBinding.expectedRevision + 1)
      expect(oldRun.state).toBe("PREPARED")
      expect((database.query("SELECT count(*) AS count FROM attempts").get() as { count: number }).count).toBe(0)
    } finally { database.close() }

    expect(() => fixture.controller.prepare({ owner: fixture.owner, campaignId: `anchor_${randomUUID().replaceAll("-", "")}`,
      ...fixture.current })).toThrow("clock-uncertain")
    const anchored = new Database(reentryDatabase(fixture.root))
    try {
      const quota = anchored.query("SELECT fence_boot,fence_cont FROM quota WHERE singleton=1").get() as {
        fence_boot: string | null; fence_cont: string | null
      }
      expect(quota.fence_boot).toBe(recoveryAnchorSample.bootId)
      expect(quota.fence_cont).toBe(recoveryAnchorSample.continuousNanoseconds)
    } finally { anchored.close() }

    const dayMs = BigInt(SKILLOPT_CONTROLLER_LIMITS.dailyCooldownMilliseconds)
    const dayNs = dayMs * 1_000_000n
    fixture.syntheticClock.setSample({ ...recoveryAnchorSample,
      continuousNanoseconds: (BigInt(recoveryAnchorSample.continuousNanoseconds) + dayNs - 1n).toString(),
      wallMilliseconds: (BigInt(recoveryAnchorSample.wallMilliseconds) + dayMs - 1n).toString(),
    })
    expect(() => fixture.controller.prepare({ owner: fixture.owner, campaignId: `early_${randomUUID().replaceAll("-", "")}`,
      ...fixture.current })).toThrow("clock-uncertain")

    fixture.syntheticClock.setSample({ ...recoveryAnchorSample,
      continuousNanoseconds: (BigInt(recoveryAnchorSample.continuousNanoseconds) + dayNs).toString(),
      wallMilliseconds: (BigInt(recoveryAnchorSample.wallMilliseconds) + dayMs).toString(),
    })

    const fresh = fixture.controller.prepare({ owner: fixture.owner, campaignId: `fresh_${randomUUID().replaceAll("-", "")}`,
      ...fixture.current })
    if (fresh.state !== "PREPARED") throw new Error("fresh preparation was not issued after the continuity fence")
    expect(fresh.runId).not.toBe(fixture.prepared.runId)
    expect(() => fixture.controller.consent(fixture.prepared, oldReceipt, fixture.current)).toThrow("revision-conflict")
    const freshConsent = fixture.controller.consent(fresh, await approveReentry(fresh.decisionBinding), fixture.current)
    expect(freshConsent.state).toBe("CONSENTED")
    const recovered = new Database(reentryDatabase(fixture.root))
    try {
      expect((recovered.query("SELECT clock_uncertain FROM quota WHERE singleton=1").get() as { clock_uncertain: number }).clock_uncertain).toBe(0)
      expect((recovered.query("SELECT state FROM consents WHERE run_id=?").get(fixture.prepared.runId) as { state: string } | null))
        .toBeNull()
      expect((recovered.query("SELECT count(*) AS count FROM attempts").get() as { count: number }).count).toBe(0)
    } finally { recovered.close() }
  })

  test.skipIf(!nativeClockSupported)("negative recovered elapsed time latches uncertainty without refunding dispatch", async () => {
    const fixture = await reentryFixture("CONSENTED")
    let requestId: string | undefined
    let failure: unknown
    try {
      await makeRunningNativeFixture(fixture, undefined, (reservation) => {
        requestId = reservation.requestId
        const sample = readSkillOptNativeClock({ nativeHelperPath: nativeClockPath!, nativeHelperSha256: nativeClockSha256! })
        const database = new Database(reentryDatabase(fixture.root))
        try {
          // Synthetic scratch-ledger corruption exercises the recovery branch; system/helper time is untouched.
          database.query("UPDATE requests SET created_cont=? WHERE request_id=?")
            .run((BigInt(sample.continuousNanoseconds) + 60_000_000_000n).toString(), reservation.requestId)
        } finally { database.close() }
      })
    } catch (error) { failure = error }
    if (requestId === undefined) throw new Error("recovery did not retain its charged request id")
    expect(failure instanceof SkillOptControllerError).toBe(true)
    if (!(failure instanceof SkillOptControllerError)) throw new Error("negative recovered elapsed time did not block consent restoration")
    expect(failure.code).toBe("consent-required")

    const status = fixture.controller.status()
    expect(status.state).toBe("BLOCKED")
    expect(status.reasonCode).toBe("clock-uncertain")
    expect(status.requestCounts.charged.target).toBe(1)
    expect(status.requestCounts.dispatched.target).toBe(1)
    expect(status.requestCounts.unknown.target).toBe(0)
    const database = new Database(reentryDatabase(fixture.root))
    try {
      const quota = database.query("SELECT clock_uncertain,active_run_id,pending_request_id FROM quota WHERE singleton=1").get() as {
        clock_uncertain: number; active_run_id: string | null; pending_request_id: string | null
      }
      const request = database.query("SELECT dispatch_state,actual_dispatch,active_reserved_ms FROM requests WHERE request_id=?")
        .get(requestId) as { dispatch_state: string; actual_dispatch: number | null; active_reserved_ms: number }
      const attempt = database.query("SELECT dispatch_state,actual_dispatch FROM attempts WHERE request_id=?")
        .get(requestId) as { dispatch_state: string; actual_dispatch: number | null }
      const usage = database.query("SELECT active_ms,active_reserved_ms FROM usage WHERE run_id=?")
        .get(fixture.prepared.runId) as { active_ms: number; active_reserved_ms: number }
      expect(quota.clock_uncertain).toBe(1)
      expect(quota.active_run_id).toBe(fixture.prepared.runId)
      expect(quota.pending_request_id).toBeNull()
      expect(request.dispatch_state).toBe("settled")
      expect(request.actual_dispatch).toBe(1)
      expect(request.active_reserved_ms).toBe(0)
      expect(attempt.dispatch_state).toBe("settled")
      expect(attempt.actual_dispatch).toBe(1)
      expect(usage.active_ms).toBe(SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds)
      expect(usage.active_reserved_ms).toBe(0)
      expect((database.query("SELECT state FROM consents WHERE run_id=?").get(fixture.prepared.runId) as { state: string }).state)
        .toBe("invalidated")
    } finally { database.close() }
  })

  test.skipIf(!nativeClockSupported)("reference-less ambiguous dispatch remains charged and blocks controller recovery", async () => {
    const fixture = await reentryFixture("CONSENTED")
    let failure: unknown
    let reservationAnchor: { last_attempt_boot: string | null; last_attempt_cont: string | null } | undefined
    try {
      await makeRunningNativeFixture(fixture, () => {
        const database = new Database(reentryDatabase(fixture.root))
        try {
          reservationAnchor = database.query("SELECT last_attempt_boot,last_attempt_cont FROM quota WHERE singleton=1")
            .get() as { last_attempt_boot: string | null; last_attempt_cont: string | null }
        } finally { database.close() }
      }, undefined, "ambiguous", false)
    } catch (error) { failure = error }
    expect(failure instanceof SkillOptControllerError).toBe(true)
    if (!(failure instanceof SkillOptControllerError)) throw new Error("reference-less unknown dispatch was not blocked")
    expect(failure.code).toBe("recovery-unresolved")

    const status = fixture.controller.status()
    expect(status.state).toBe("UNRESOLVED")
    expect(status.requestCounts.charged.target).toBe(1)
    expect(status.requestCounts.dispatched.target).toBe(0)
    expect(status.requestCounts.unknown.target).toBe(1)
    expect(status.pendingDispatch).toBe(true)
    if (!reservationAnchor) throw new Error("reference-less recovery did not retain its reservation anchor")
    expect(() => fixture.controller.prepare({ owner: fixture.owner, campaignId: `blocked_${randomUUID().replaceAll("-", "")}`,
      ...fixture.current })).toThrow("dispatch-pending")

    const database = new Database(reentryDatabase(fixture.root))
    try {
      const quota = database.query("SELECT active_run_id,pending_request_id,last_attempt_boot,last_attempt_cont FROM quota WHERE singleton=1")
        .get() as { active_run_id: string | null; pending_request_id: string | null; last_attempt_boot: string | null; last_attempt_cont: string | null }
      expect(quota.active_run_id).toBe(fixture.prepared.runId)
      expect(quota.pending_request_id).not.toBeNull()
      expect(quota.last_attempt_boot).toBe(reservationAnchor.last_attempt_boot)
      expect(quota.last_attempt_cont).toBe(reservationAnchor.last_attempt_cont)
      const request = database.query("SELECT dispatch_state,actual_dispatch,reference_json,active_reserved_ms FROM requests WHERE request_id=?")
        .get(quota.pending_request_id) as { dispatch_state: string; actual_dispatch: number | null; reference_json: string | null; active_reserved_ms: number }
      expect(request.dispatch_state).toBe("unknown")
      expect(request.actual_dispatch).toBeNull()
      expect(request.reference_json).toBeNull()
      expect(request.active_reserved_ms).toBe(SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds)
      const usage = database.query("SELECT target_requests,active_reserved_ms FROM usage WHERE run_id=?").get(fixture.prepared.runId) as {
        target_requests: number; active_reserved_ms: number
      }
      expect(usage.target_requests).toBe(1)
      expect(usage.active_reserved_ms).toBe(SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds)
      expect(quota.last_attempt_boot).not.toBeNull()
      expect(quota.last_attempt_cont).not.toBeNull()
    } finally { database.close() }
  })

  test.skipIf(!nativeClockSupported)("SQLite SQLITE_FULL during recovered settlement retains the charged unknown request", async () => {
    const fixture = await reentryFixture("CONSENTED")
    const pageLimit = limitLedgerConnectionPageCount(reentryDatabase(fixture.root))
    let failure: unknown
    let originalLastAttempt: { last_attempt_boot: string | null; last_attempt_cont: string | null } | undefined
    try {
      const owned = await prepareOwnedChildRecovery(fixture, () => {
        const database = new Database(reentryDatabase(fixture.root))
        try {
          createSQLiteFullPressureTrigger(database, "force_sqlite_full_settlement",
            "AFTER UPDATE OF dispatch_state ON requests WHEN NEW.dispatch_state='settled'")
        } finally { database.close() }
      })
      originalLastAttempt = owned.reservationAnchor
      await fixture.controller.recover(fixture.owner, fixture.prepared.runId)
    } catch (error) { failure = error }
    finally { pageLimit.restore() }
    expect(pageLimit.limitedConnections).toBe(2)
    expect(pageLimit.sqliteFullErrors.length).toBe(1)
    const sqliteFullError = pageLimit.sqliteFullErrors[0]
    if (!sqliteFullError) throw new Error("recovered settlement pressure did not surface a native SQLite error")
    expect(sqliteFullError.code).toBe("SQLITE_FULL")
    expect(sqliteFullError.errno).toBe(13)
    expect(sqliteFullError.statement.includes("UPDATE requests SET dispatch_state='settled'")).toBe(true)
    expect(failure instanceof SkillOptControllerError).toBe(true)
    if (!(failure instanceof SkillOptControllerError)) throw new Error("SQLite SQLITE_FULL did not block failed settlement")
    expect(failure.code).toBe("storage-corrupt")
    if (!originalLastAttempt) throw new Error("settlement setup did not retain the reservation cooldown anchor")

    const status = fixture.controller.status()
    expect(status.state).toBe("UNRESOLVED")
    expect(status.pendingDispatch).toBe(true)
    expect(status.requestCounts.charged.target).toBe(1)
    expect(status.requestCounts.dispatched.target).toBe(0)
    expect(status.requestCounts.unknown.target).toBe(1)
    const database = new Database(reentryDatabase(fixture.root))
    try {
      const quota = database.query("SELECT active_run_id,pending_request_id,last_attempt_boot,last_attempt_cont FROM quota WHERE singleton=1")
        .get() as { active_run_id: string | null; pending_request_id: string | null; last_attempt_boot: string | null; last_attempt_cont: string | null }
      expect(quota.active_run_id).toBe(fixture.prepared.runId)
      expect(quota.pending_request_id).not.toBeNull()
      expect(quota.last_attempt_boot).toBe(originalLastAttempt.last_attempt_boot)
      expect(quota.last_attempt_cont).toBe(originalLastAttempt.last_attempt_cont)
      const request = database.query("SELECT dispatch_state,actual_dispatch,reference_json,active_reserved_ms FROM requests WHERE request_id=?")
        .get(quota.pending_request_id) as { dispatch_state: string; actual_dispatch: number | null; reference_json: string | null; active_reserved_ms: number }
      expect(request.dispatch_state).toBe("unknown")
      expect(request.actual_dispatch).toBeNull()
      expect(request.reference_json).not.toBeNull()
      expect(request.active_reserved_ms).toBe(SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds)
      const attempt = database.query("SELECT dispatch_state,actual_dispatch FROM attempts WHERE request_id=?")
        .get(quota.pending_request_id) as { dispatch_state: string; actual_dispatch: number | null }
      expect(attempt.dispatch_state).toBe("unknown")
      expect(attempt.actual_dispatch).toBeNull()
      const usage = database.query("SELECT active_ms,active_reserved_ms,target_requests FROM usage WHERE run_id=?")
        .get(fixture.prepared.runId) as { active_ms: number; active_reserved_ms: number; target_requests: number }
      expect(usage.active_ms).toBe(0)
      expect(usage.active_reserved_ms).toBe(SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds)
      expect(usage.target_requests).toBe(1)
      expect((database.query("SELECT count(*) AS count FROM meta").get() as { count: number }).count).toBe(4)
    } finally { database.close() }
  })

  test.skipIf(!nativeClockSupported)("an owned harmless child is acknowledged only through quiescent reference-backed recovery", async () => {
    const fixture = await reentryFixture("CONSENTED")
    const owned = await prepareOwnedChildRecovery(fixture)
    const recovered = await fixture.controller.recover(fixture.owner, fixture.prepared.runId)
    expect(recovered.state).toBe("RUNNING")
    expect(recovered.pendingDispatch).toBe(false)
    expect(recovered.requestCounts.charged.target).toBe(1)
    expect(recovered.requestCounts.dispatched.target).toBe(1)
    expect(recovered.requestCounts.unknown.target).toBe(0)
    expect(() => fixture.controller.prepare({ owner: fixture.owner, campaignId: `still_active_${randomUUID().replaceAll("-", "")}`,
      ...fixture.current })).toThrow("active-run")

    const database = new Database(reentryDatabase(fixture.root))
    try {
      const quota = database.query("SELECT active_run_id,pending_request_id,last_attempt_boot,last_attempt_cont FROM quota WHERE singleton=1")
        .get() as { active_run_id: string | null; pending_request_id: string | null; last_attempt_boot: string | null; last_attempt_cont: string | null }
      expect(quota.active_run_id).toBe(fixture.prepared.runId)
      expect(quota.pending_request_id).toBeNull()
      expect(quota.last_attempt_boot).toBe(owned.observedBeforeRecovery.bootId)
      expect(BigInt(String(quota.last_attempt_cont))).toBeGreaterThanOrEqual(BigInt(owned.observedBeforeRecovery.continuousNanoseconds))
      expect(BigInt(String(quota.last_attempt_cont))).toBeGreaterThan(BigInt(owned.createdCont))
      const request = database.query("SELECT dispatch_state,actual_dispatch,reference_json,terminal_class,active_reserved_ms FROM requests WHERE request_id=?")
        .get(owned.reservation.requestId) as { dispatch_state: string; actual_dispatch: number | null; reference_json: string | null; terminal_class: string | null; active_reserved_ms: number }
      expect(request.dispatch_state).toBe("settled")
      expect(request.actual_dispatch).toBe(1)
      expect(request.reference_json).not.toBeNull()
      expect(request.terminal_class).toBe("reconciled")
      expect(request.active_reserved_ms).toBe(0)
      const usage = database.query("SELECT active_ms,active_reserved_ms,target_requests FROM usage WHERE run_id=?")
        .get(fixture.prepared.runId) as { active_ms: number; active_reserved_ms: number; target_requests: number }
      expect(usage.active_ms).toBeGreaterThan(0)
      expect(usage.active_reserved_ms).toBe(0)
      expect(usage.target_requests).toBe(1)
    } finally { database.close() }
  }, { timeout: 30_000 })

  test("cooldown does not use timezone-local calendar-day boundaries", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const instant = new Date(Number(testStorage.clock.sample().wallMilliseconds))
    const localDate = (timeZone: string) => {
      const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(instant)
      const part = (type: "year" | "month" | "day") => parts.find((item) => item.type === type)!.value
      return `${part("year")}-${part("month")}-${part("day")}`
    }
    expect(localDate("Pacific/Kiritimati")).not.toBe(localDate("Etc/GMT+12"))

    const first = armedSeed()
    testStorage.store.seedArmedRun(first)
    const reservation = testStorage.store.reserveAutomatic(reserveInput(first))
    testStorage.store.settle(first.runId, reservation.requestId)
    const next = armedSeed()
    testStorage.store.seedArmedRun(next)
    expect(() => testStorage.store.reserveAutomatic(reserveInput(next))).toThrow("daily-limit")
    const database = new Database(testStorage.databasePath)
    try {
      expect((database.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(next.runId) as { count: number }).count)
        .toBe(0)
    } finally { database.close() }
  })

  test("same-boot cooldown refuses 24 hours minus one millisecond and permits the exact boundary", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const first = armedSeed()
    testStorage.store.seedArmedRun(first)
    const firstReservation = testStorage.store.reserveAutomatic(reserveInput(first))
    testStorage.store.settle(first.runId, firstReservation.requestId)

    testStorage.clock.advance(SKILLOPT_CONTROLLER_LIMITS.dailyCooldownMilliseconds - 1)
    const next = armedSeed()
    testStorage.store.seedArmedRun(next)
    expect(() => testStorage.store.reserveAutomatic(reserveInput(next))).toThrow("daily-limit")
    const database = new Database(testStorage.databasePath)
    try {
      expect((database.query("SELECT count(*) AS count FROM attempts WHERE run_id=?").get(next.runId) as { count: number }).count)
        .toBe(0)
    } finally { database.close() }

    testStorage.clock.advance(1)
    expect(testStorage.store.reserveAutomatic(reserveInput(next)).requestId).toMatch(/^[0-9a-f-]{36}$/iu)
    expect(testStorage.store.snapshot().requestCounts.charged.target).toBe(1)
  })

  test("new boot creates a persisted cooldown fence that survives controller recreation", () => {
    const testStorage = storage()
    testStorage.store.initialize()
    const first = armedSeed()
    testStorage.store.seedArmedRun(first)
    const firstReservation = testStorage.store.reserveAutomatic(reserveInput(first))
    testStorage.store.settle(first.runId, firstReservation.requestId)

    testStorage.clock.reboot()
    const restarted = createSkillOptStorageForTests({
      databasePath: testStorage.databasePath, worktreeRoot: testStorage.root, clock: testStorage.clock.sample,
    })
    restarted.initialize()
    const next = armedSeed()
    restarted.seedArmedRun(next)
    expect(() => restarted.reserveAutomatic(reserveInput(next))).toThrow("daily-limit")

    const readFence = () => {
      const database = new Database(testStorage.databasePath)
      try {
        return database.query("SELECT fence_boot,fence_cont FROM quota WHERE singleton=1").get() as {
          fence_boot: string | null; fence_cont: string | null
        }
      } finally { database.close() }
    }
    const initialFence = readFence()
    expect(initialFence.fence_boot).toBe(bootB)
    expect(initialFence.fence_cont).toBe("1000")

    testStorage.clock.advance(6 * 60 * 60 * 1000)
    const partiallyReopened = createSkillOptStorageForTests({
      databasePath: testStorage.databasePath, worktreeRoot: testStorage.root, clock: testStorage.clock.sample,
    })
    partiallyReopened.initialize()
    expect(() => partiallyReopened.reserveAutomatic(reserveInput(next))).toThrow("daily-limit")
    const reopenedFence = readFence()
    expect(reopenedFence.fence_boot).toBe(initialFence.fence_boot)
    expect(reopenedFence.fence_cont).toBe(initialFence.fence_cont)

    testStorage.clock.advance(18 * 60 * 60 * 1000)
    const afterCooldown = armedSeed()
    partiallyReopened.seedArmedRun(afterCooldown)
    expect(partiallyReopened.reserveAutomatic(reserveInput(afterCooldown)).requestId).toBeTruthy()
  })

  test.skipIf(!nativeClockSupported)("a launched harmless child without a dispatch acknowledgement retains unknown quota across reopen", async () => {
    const fixture = await reentryFixture("PREPARED")
    const testStorage = storage()
    testStorage.store.initialize()
    const seed = armedSeed()
    testStorage.store.seedArmedRun(seed)
    const reservation = testStorage.store.reserveAutomatic(reserveInput(seed))

    const identity: SkillOptNativeExecutionIdentity = Object.freeze({
      engine: fixture.dataset.modelBindings.target.engine, profile: "legacy-unowned",
      controlProfile: "estimated-input-reactive-output-v1", policyID: `skillopt-native-v1:${hash("synthetic harmless child test policy")}`,
      role: "target" as const, phase: "train" as const,
    })
    const startPath = join(fixture.root, `child-started-${randomUUID()}`)
    const childScript = `import { renameSync, writeFileSync } from "node:fs";
const env = process.env;
process.on("SIGTERM", () => process.exit(0));
const pending = env.SKILLOPT_CHILD_STARTED + ".pending";
writeFileSync(pending, String(process.pid), { mode: 0o600, flag: "wx" });
renameSync(pending, env.SKILLOPT_CHILD_STARTED);
setTimeout(() => process.exit(0), Number(env.SKILLOPT_CHILD_HOLD_MS));`
    let child: SkillOptChildProcess | undefined
    let launchCount = 0

    try {
      child = Bun.spawn([process.execPath, "--no-env-file", "-e", childScript], {
        cwd: fixture.root,
        env: {
          PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), HOME: join(fixture.root, "harmless-child-home"),
          SKILLOPT_CHILD_STARTED: startPath, SKILLOPT_CHILD_HOLD_MS: "20000",
        },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      })
      launchCount += 1
      await waitForOwnedFiles([startPath], "harmless owned child launch")
      const runningChild = child
      if (!runningChild) throw new Error("owned child handle was not retained")
      const childPid = Number(readFileSync(startPath, "utf8"))
      expect(runningChild.pid).toBe(childPid)
      expect(runningChild.exitCode).toBeNull()

      const claim = fixture.runtime.runs.claim(fixture.owner.sessionID, fixture.runtime.instance, childPid)
      fixture.runtime.runs.registerIntent(claim, {
        executionId: reservation.requestId, ownerSession: fixture.owner.sessionID,
        taskId: `skillopt:${identity.role}:${identity.phase}:${reservation.requestId}`, attemptId: randomUUID(),
        generation: claim.generation, role: identity.role, cwd: fixture.runtime.worktree, policyID: identity.policyID,
        kind: "host", engine: identity.engine, profile: identity.profile,
        controlProfile: identity.controlProfile, nativeExecution: true,
      })
      fixture.runtime.runs.bindNativeExecutionRef(claim, reservation.requestId)
      fixture.runtime.runs.markHostDispatched(claim, reservation.requestId)

      // The isolated test ledger has no dispatch-ACK API or production authority. Its pending state
      // models a lost acknowledgement; reopening it does not exercise controller recovery.
      const unresolved = testStorage.store.snapshot()
      expect(unresolved.state).toBe("UNRESOLVED")
      expect(unresolved.pendingDispatch).toBe(true)
      expect(unresolved.requestCounts.charged.target).toBe(1)
      expect(unresolved.requestCounts.dispatched.target).toBe(0)
      expect(unresolved.requestCounts.unknown.target).toBe(1)
      expect(unresolved.remaining.activeMilliseconds)
        .toBe(SKILLOPT_CONTROLLER_LIMITS.activeMilliseconds - SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds)
      expect(launchCount).toBe(1)

      const pendingDatabase = new Database(testStorage.databasePath)
      try {
        const quota = pendingDatabase.query("SELECT active_run_id,pending_request_id FROM quota WHERE singleton=1").get() as {
          active_run_id: string | null; pending_request_id: string | null
        }
        expect(quota.active_run_id).toBe(seed.runId)
        expect(quota.pending_request_id).toBe(reservation.requestId)
        const request = pendingDatabase.query("SELECT dispatch_state,actual_dispatch,active_reserved_ms FROM requests WHERE request_id=?")
          .get(reservation.requestId) as { dispatch_state: string; actual_dispatch: number | null; active_reserved_ms: number }
        expect(request.dispatch_state).toBe("possible")
        expect(request.actual_dispatch).toBeNull()
        expect(request.active_reserved_ms).toBe(SKILLOPT_CONTROLLER_LIMITS.requestMilliseconds)
      } finally { pendingDatabase.close() }

      const reopened = createSkillOptStorageForTests({
        databasePath: testStorage.databasePath, worktreeRoot: testStorage.root, clock: testStorage.clock.sample,
      })
      reopened.initialize()
      const afterReopen = reopened.snapshot()
      expect(afterReopen.state).toBe("UNRESOLVED")
      expect(afterReopen.pendingDispatch).toBe(true)
      expect(afterReopen.requestCounts.charged.target).toBe(1)
      expect(afterReopen.requestCounts.dispatched.target).toBe(0)
      expect(afterReopen.requestCounts.unknown.target).toBe(1)

      const second = armedSeed()
      reopened.seedArmedRun(second)
      expect(() => reopened.reserveAutomatic(reserveInput(second))).toThrow("dispatch-pending")
      const retainedDatabase = new Database(testStorage.databasePath)
      try {
        expect((retainedDatabase.query("SELECT count(*) AS count FROM attempts").get() as { count: number }).count).toBe(1)
        expect((retainedDatabase.query("SELECT count(*) AS count FROM requests").get() as { count: number }).count).toBe(1)
      } finally { retainedDatabase.close() }

      const owned = fixture.runtime.runs.status().executions.find((execution) => execution.executionId === reservation.requestId)
      expect(owned?.ownerSession).toBe(fixture.owner.sessionID)
      expect(owned?.hostDispatch).toBe("started")
      expect(owned?.nativeExecution).toBe(true)

      await stopOwnedChild(runningChild)
      expect(runningChild.exitCode).toBe(0)
      const terminalAt = Date.now()
      fixture.runtime.runs.recordTerminal(claim, reservation.requestId, {
        outcome: "completed", terminalAt, quiescentAt: terminalAt,
      })
      fixture.runtime.runs.assertQuiescent(claim)
      fixture.runtime.runs.release(claim)
    } finally {
      if (child && child.exitCode === null) await stopOwnedChild(child)
    }
  }, { timeout: 30_000 })
})
