import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import * as readline from "node:readline/promises"
import { PassThrough } from "node:stream"
import { dirname, join, resolve } from "node:path"
import type { Terminal } from "../src/hosts/interactive-session.ts"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { createCliTransport, findExecutable, type CliNativeIdentity } from "../src/hosts/cli-transport.ts"
import { attachAdmission, detachAdmission } from "../src/sessions/admission.ts"
import { executionRunDirectory } from "../src/state/store.ts"
import { createNativeSkillOptForeground, SKILLOPT_FOREGROUND_INPUT_SCHEMA } from "../src/skillopt/foreground.ts"
import { validateNativeFixturePack, type NativeWikiFixturePack } from "../src/skillopt/dataset.ts"
import type { NativeSkillLoadWitnessRecord } from "../src/skillopt/load-verification.ts"
import { COMPILE_ANCHOR, PILOT_SKILL, canonicalJson, sha256 } from "../src/skillopt/pilot.ts"
import {
  createSyntheticForegroundCli, makeAutomaticPack,
  type SyntheticForegroundInvocation, type SyntheticForegroundModels,
} from "./skillopt-foreground-fixtures.ts"
import { tempWorktree } from "./guards-helpers.ts"
import { commitSyntheticSkillBaseline, initializeSyntheticSkillProject } from "./skillopt-native-load-helpers.ts"

const integrationDeadlineMs = 50 * 60 * 1000
const outerTestDeadlineMs = 55 * 60 * 1000
const promptAcquisitionDeadlineMs = 30_000

const models: SyntheticForegroundModels = Object.freeze({
  generator: Object.freeze({ engine: "codex" as const, requestedModel: "gpt-6-astra" }),
  target: Object.freeze({ engine: "claude" as const, requestedModel: "claude-target-test" }),
  reviewer: Object.freeze({ engine: "claude" as const, requestedModel: "claude-review-test" }),
})
const reverseModels: SyntheticForegroundModels = Object.freeze({
  generator: Object.freeze({ engine: "claude" as const, requestedModel: "claude-generator-test" }),
  target: Object.freeze({ engine: "codex" as const, requestedModel: "gpt-6-astra" }),
  reviewer: Object.freeze({ engine: "codex" as const, requestedModel: "gpt-6-luna" }),
})
type NativeEngine = SyntheticForegroundModels["generator"]["engine"]
type PublicationDirection = Readonly<{
  name: string
  models: SyntheticForegroundModels
  expectedEngines: Readonly<{ generator: NativeEngine; target: NativeEngine; reviewer: NativeEngine }>
}>
const primaryDirection: PublicationDirection = Object.freeze({ name: "Codex generator -> Claude target/reviewer", models,
  expectedEngines: Object.freeze({ generator: "codex", target: "claude", reviewer: "claude" }) })
const reverseDirection: PublicationDirection = Object.freeze({ name: "Claude generator -> Codex target/reviewer", models: reverseModels,
  expectedEngines: Object.freeze({ generator: "claude", target: "codex", reviewer: "codex" }) })

const targetBaseline = Buffer.from(`---\nname: llm-wiki\ndescription: Synthetic automatic campaign fixture\n---\n\n${COMPILE_ANCHOR}3. Preserve supported Wiki facts.\n`, "utf8")

type ApprovalBinding = Readonly<{ workflowID: string; subjectSha256: string }>
type Settled<T> = Readonly<{ status: "fulfilled"; value: T } | { status: "rejected"; error: unknown }>
type ProcessEnvironmentSnapshot = Readonly<Record<string, string | undefined>>

function replaceProcessEnvironment(environment: ProcessEnvironmentSnapshot): void {
  for (const key of Object.keys(process.env)) delete process.env[key]
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[key] = value
  }
}

function isolatePublicationEnvironment(input: Readonly<{
  cliDirectory: string
  stateHome: string
  originalEnvironment: ProcessEnvironmentSnapshot
}>): Readonly<{
  home: string
  restore(): void
}> {
  const prior = { ...input.originalEnvironment }
  const home = join(input.stateHome, "publication-private-home")
  const codexHome = join(home, "codex")
  const claudeHome = join(home, "claude")
  const xdgConfigHome = join(home, "config")
  const xdgDataHome = join(home, "data")
  const xdgStateHome = join(home, "state")
  const xdgCacheHome = join(home, "cache")
  for (const directory of [home, codexHome, claudeHome, xdgConfigHome, xdgDataHome, xdgStateHome, xdgCacheHome]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const environment: Record<string, string> = {
    PATH: `${input.cliDirectory}:/usr/bin:/bin`,
    HOME: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
    XDG_STATE_HOME: xdgStateHome,
    XDG_CACHE_HOME: xdgCacheHome,
    OTTER_STATE_HOME: input.stateHome,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
  }
  for (const key of ["SKILLOPT_PYTHON", "TMPDIR", "TMP", "TEMP", "CC"] as const) {
    const value = prior[key]
    if (value !== undefined) environment[key] = value
  }
  replaceProcessEnvironment(environment)
  return Object.freeze({
    home,
    restore() { replaceProcessEnvironment(prior) },
  })
}

function selectedWorkerRuntime(): Readonly<{ executablePath: string; nativeRuntimeProofPath: string }> {
  const executablePath = process.env.SKILLOPT_PYTHON
  if (executablePath === undefined) throw new Error("contained trainer runtime was absent after integration skip selection")
  const runtimeRoot = resolve(dirname(dirname(executablePath)))
  return Object.freeze({ executablePath, nativeRuntimeProofPath: resolve(dirname(runtimeRoot), "native-runtime-proof.json") })
}

function makeInput(root: string, fixturePack: NativeWikiFixturePack, runtime: ReturnType<typeof selectedWorkerRuntime>,
  models: SyntheticForegroundModels) {
  const source = Buffer.from("Synthetic selected private source for service publication fixture.\n", "utf8")
  const sourcePath = `knowledge/raw/documents/${sha256(source)}.md`
  const absoluteSource = join(root, sourcePath)
  mkdirSync(dirname(absoluteSource), { recursive: true, mode: 0o700 })
  writeFileSync(absoluteSource, source, { mode: 0o600 })
  return Object.freeze({
    schema: SKILLOPT_FOREGROUND_INPUT_SCHEMA,
    models,
    selections: Object.freeze([{ path: sourcePath }]),
    fixturePack,
    runtime,
  })
}

async function inspectDefaultIdentity(engine: "codex" | "claude", model: string): Promise<CliNativeIdentity> {
  const transport = createCliTransport({ engine, model, prompt: "", deadlineAt: Date.now() + 10_000, maxOutputBytes: 1024 })
  const identity = await transport.inspectIdentity?.()
  if (!identity) throw new Error(`default ${engine} transport could not inspect its private synthetic executable`)
  return identity
}

function linuxFilesystemTypeFor(path: string): string {
  const target = resolve(path)
  let selected: Readonly<{ mountPoint: string; type: string }> | undefined
  for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const fields = line.split(" ")
    const separator = fields.indexOf("-")
    if (separator < 0 || fields.length < 5 || typeof fields[separator + 1] !== "string") continue
    const mountPoint = fields[4]!.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
    const containsTarget = mountPoint === "/" ? target.startsWith("/")
      : target === mountPoint || target.startsWith(`${mountPoint}/`)
    if (!containsTarget || (selected && selected.mountPoint.length >= mountPoint.length)) continue
    selected = Object.freeze({ mountPoint, type: fields[separator + 1]! })
  }
  if (!selected) throw new Error("test state directory has no Linux mount identity")
  return selected.type
}

function syntheticTerminal() {
  const choices: Array<ReadonlyArray<string>> = []
  const terminal: Terminal = Object.freeze({
    stdinIsTTY: true,
    stderrIsTTY: true,
    async choose(_title, options, signal) {
      if (signal.aborted) throw new Error("synthetic loader consent was aborted")
      if (options.length !== 2 || options[0] !== "Allow this content in this session" || options[1] !== "Deny") {
        throw new Error("normal SkillSession requested unexpected skill-content consent")
      }
      choices.push(Object.freeze([...options]))
      return 0
    },
    async readLine() { return undefined },
    write() {},
    close() {},
  })
  return Object.freeze({ terminal, choices })
}

async function withApprovalFromPrompt<T>(input: Readonly<{
  action(signal: AbortSignal): Promise<T>
  parentSignal: AbortSignal
  beforeApproval(binding: ApprovalBinding): void
}>): Promise<Readonly<{ value: T; binding: ApprovalBinding }>> {
  const terminalInput = new PassThrough()
  const terminalOutput = new PassThrough()
  const originalCreate = readline.createInterface
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")
  if (process.stdin.isTTY !== true) Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
  if (process.stderr.isTTY !== true) Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true })
  const intercepted = spyOn(readline, "createInterface")
    .mockImplementation(() => originalCreate({ input: terminalInput, output: terminalOutput, terminal: false }))
  const localAbort = new AbortController()
  const abortFromParent = () => localAbort.abort()
  input.parentSignal.addEventListener("abort", abortFromParent, { once: true })
  let binding: ApprovalBinding | undefined
  let callbackError: unknown
  let resolvePrompt!: () => void
  const promptSeen = new Promise<void>(resolvePromptValue => { resolvePrompt = resolvePromptValue })
  let approvalToken = ""
  terminalOutput.on("data", (chunk: Buffer) => {
    const combined = approvalToken + chunk.toString("utf8")
    const marker = combined.indexOf("APPROVE ")
    if (marker < 0) {
      approvalToken = combined.slice(-("APPROVE ".length - 1))
      return
    }
    const candidate = combined.slice(marker, marker + 256)
    const match = /APPROVE ([A-Za-z0-9_-]+) ([a-f0-9]{64})/u.exec(candidate)
    approvalToken = match ? "" : candidate
    if (!match || binding) return
    binding = Object.freeze({ workflowID: match[1]!, subjectSha256: match[2]! })
    queueMicrotask(() => {
      try {
        input.beforeApproval(binding!)
        if (!localAbort.signal.aborted) terminalInput.write(`APPROVE ${binding!.workflowID} ${binding!.subjectSha256}\n`)
      } catch (error) {
        callbackError = error
        localAbort.abort()
      } finally {
        resolvePrompt()
      }
    })
  })

  const operation = Promise.resolve().then(() => input.action(localAbort.signal))
  const settled: Promise<Settled<T>> = operation.then(
    value => Object.freeze({ status: "fulfilled" as const, value }),
    error => Object.freeze({ status: "rejected" as const, error }),
  )
  let acquisitionTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const first = await Promise.race([
      promptSeen.then(() => Object.freeze({ kind: "prompt" as const })),
      settled.then(result => Object.freeze({ kind: "settled" as const, result })),
      new Promise<Readonly<{ kind: "timeout" }>>(resolveTimeout => {
        acquisitionTimer = setTimeout(() => resolveTimeout(Object.freeze({ kind: "timeout" })), promptAcquisitionDeadlineMs)
      }),
    ])
    if (first.kind === "timeout") {
      localAbort.abort()
      await settled
      throw callbackError ?? new Error("terminal approval prompt acquisition timed out; action was aborted and joined")
    }
    if (first.kind === "settled") {
      if (first.result.status === "rejected") throw first.result.error
      throw new Error("service action settled without acquiring its terminal approval prompt")
    }
    if (acquisitionTimer) clearTimeout(acquisitionTimer)
    const result = await settled
    if (callbackError !== undefined) throw callbackError
    if (result.status === "rejected") throw result.error
    if (!binding) throw new Error("terminal approval binding was not captured")
    return Object.freeze({ value: result.value, binding })
  } finally {
    if (acquisitionTimer) clearTimeout(acquisitionTimer)
    input.parentSignal.removeEventListener("abort", abortFromParent)
    intercepted.mockRestore()
    terminalInput.destroy()
    terminalOutput.destroy()
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY)
    else Reflect.deleteProperty(process.stdin, "isTTY")
    if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY)
    else Reflect.deleteProperty(process.stderr, "isTTY")
  }
}

function requestCounts(target: number) {
  return {
    charged: { target, optimizer: 3, reviewer: 2 },
    dispatched: { target, optimizer: 3, reviewer: 2 },
    unknown: { target: 0, optimizer: 0, reviewer: 0 },
  }
}

function invocationCounts(invocations: readonly SyntheticForegroundInvocation[]) {
  return Object.freeze({
    target: invocations.filter(item => item.role === "target" && item.status === "completed").length,
    optimizer: invocations.filter(item => item.role === "optimizer" && item.status === "completed").length,
    reviewer: invocations.filter(item => item.role === "reviewer" && item.status === "completed").length,
    unexpected: invocations.filter(item => item.role === "unexpected" || item.status !== "completed").length,
  })
}

function safeDiagnostics(phase: string, invocations: readonly SyntheticForegroundInvocation[]): string {
  const counts = invocationCounts(invocations)
  return `phase=${phase} target=${counts.target} optimizer=${counts.optimizer} reviewer=${counts.reviewer} unexpected=${counts.unexpected}`
}

function boundedResultSummary(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "result=unavailable"
  const record = value as Record<string, unknown>
  const fields = ["operation", "state", "reasonCode", "controllerState", "revision", "publicationAuthorized",
    "postApplyHandoffAuthorized", "rollbackAuthorized", "postRollbackHandoffAuthorized", "canaryStatus",
    "canaryReasonCode", "canaryPhase", "canaryErrorCode", "canaryPromotionState", "canaryControllerState"] as const
  const summary = fields.flatMap(key => {
    const field = record[key]
    if (typeof field === "string" && /^[A-Z][A-Z0-9_:-]{0,95}$/iu.test(field)) return [`${key}=${field}`]
    if (typeof field === "number" && Number.isSafeInteger(field) && field >= 0) return [`${key}=${field}`]
    if (typeof field === "boolean") return [`${key}=${field}`]
    return []
  })
  return summary.length > 0 ? summary.join(" ") : "result=unavailable"
}

async function withIntegrationDeadline<T>(input: Readonly<{
  run(signal: AbortSignal): Promise<T>
  diagnostics(): string
}>): Promise<T> {
  const abort = new AbortController()
  const operation = Promise.resolve().then(() => input.run(abort.signal))
  const settled: Promise<Settled<T>> = operation.then(
    value => Object.freeze({ status: "fulfilled" as const, value }),
    error => Object.freeze({ status: "rejected" as const, error }),
  )
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"deadline">(resolveDeadline => {
    deadlineTimer = setTimeout(() => resolveDeadline("deadline"), integrationDeadlineMs)
  })
  try {
    const outcome = await Promise.race([settled, deadline])
    if (outcome !== "deadline") {
      if (outcome.status === "rejected") throw outcome.error
      return outcome.value
    }
    abort.abort()
    const joined = await settled
    if (joined.status === "rejected") {
      throw new Error(`integration deadline elapsed; cancellation settled and joined; ${input.diagnostics()}`)
    }
    throw new Error(`integration deadline elapsed; cancellation joined with a terminal result; ${input.diagnostics()}`)
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer)
  }
}

function readTrainerEvidence(root: string, runId: string) {
  const ledgerPath = join(dirname(executionRunDirectory(root)), "skillopt", "automation", "ledger.sqlite")
  const database = new Database(ledgerPath, { readonly: true, readwrite: false, create: false })
  try {
    const events = database.query("SELECT ordinal,kind,optimizer_stage AS optimizerStage FROM trainer_protocol_events WHERE run_id=? ORDER BY ordinal")
      .all(runId) as Array<{ ordinal: number; kind: string; optimizerStage: string | null }>
    return Object.freeze({
      events,
      optimizerDispatches: database.query(`SELECT e.ordinal,e.optimizer_stage AS optimizerStage,d.native_request_id AS nativeRequestId,
        r.role,r.actual_dispatch AS actualDispatch,r.dispatch_state AS dispatchState FROM trainer_protocol_events e
        JOIN trainer_protocol_dispatches d ON d.run_id=e.run_id AND d.wire_request_id=e.wire_request_id
        JOIN requests r ON r.request_id=d.native_request_id WHERE e.run_id=? AND e.kind='optimizer' ORDER BY e.ordinal`)
        .all(runId) as Array<{ ordinal: number; optimizerStage: string; nativeRequestId: string; role: string;
          actualDispatch: number; dispatchState: string }>,
      dispatchCount: database.query("SELECT count(*) AS count FROM trainer_protocol_dispatches WHERE run_id=?").get(runId) as { count: number },
      distinctDispatchCount: database.query("SELECT count(DISTINCT native_request_id) AS count FROM trainer_protocol_dispatches WHERE run_id=?")
        .get(runId) as { count: number },
      settledDispatchCount: database.query(`SELECT count(*) AS count FROM trainer_protocol_events e
        JOIN trainer_protocol_dispatches d ON d.run_id=e.run_id AND d.wire_request_id=e.wire_request_id
        JOIN requests r ON r.request_id=d.native_request_id WHERE e.run_id=? AND r.actual_dispatch=1 AND r.dispatch_state='settled'`)
        .get(runId) as { count: number },
      roleCounts: database.query(`SELECT r.role,count(*) AS count FROM trainer_protocol_dispatches d
        JOIN requests r ON r.request_id=d.native_request_id WHERE d.run_id=? GROUP BY r.role ORDER BY r.role`)
        .all(runId) as Array<{ role: string; count: number }>,
    })
  } finally { database.close() }
}

function readAccounting(root: string, runId: string) {
  const ledgerPath = join(dirname(executionRunDirectory(root)), "skillopt", "automation", "ledger.sqlite")
  const database = new Database(ledgerPath, { readonly: true, readwrite: false, create: false })
  try {
    return Object.freeze({
      roleCounts: database.query(`SELECT role,count(*) AS count FROM requests WHERE run_id=? GROUP BY role ORDER BY role`)
        .all(runId) as Array<{ role: string; count: number }>,
      settledCount: database.query(`SELECT count(*) AS count FROM requests WHERE run_id=? AND
        actual_dispatch=1 AND dispatch_state='settled'`).get(runId) as { count: number },
      unresolvedCount: database.query(`SELECT count(*) AS count FROM requests WHERE run_id=? AND
        (actual_dispatch IS NULL OR actual_dispatch<>1 OR dispatch_state<>'settled')`).get(runId) as { count: number },
      qualificationCount: database.query("SELECT count(*) AS count FROM campaign_qualifications WHERE run_id=?").get(runId) as { count: number },
      canaryHandoffCount: database.query("SELECT count(*) AS count FROM canary_handoffs WHERE run_id=?").get(runId) as { count: number },
      canaryPhaseCount: database.query("SELECT count(*) AS count FROM requests WHERE run_id=? AND phase='canary'").get(runId) as { count: number },
    })
  } finally { database.close() }
}

type JournalEntry = Readonly<{ state: string; details: Record<string, unknown> }>
type PromotionManifest = Readonly<{
  runId: string
  bindings: Record<string, unknown> & Readonly<{
    witnessMode: string
    runId: string
    originalSha256: string
    candidateSha256: string
    fixturePackSha256: string
    canaryFixtureSha256: string
    nativeEngine: string
    nativeModel: string
    nativeProfileId: string
    nativeProfileSha256: string
    nativeRuntimeVersion: string
    nativeExecutableSha256: string
  }>
  bindingsSha256: string
  originalSha256: string
  candidateSha256: string
  approvalSha256: string
  backupName: string
  stageName: string
}>

function promotionState(root: string, runId: string) {
  const runDirectory = join(executionRunDirectory(root), "skillopt-native-promotion", runId)
  const manifest = JSON.parse(readFileSync(join(runDirectory, "manifest.json"), "utf8")) as PromotionManifest
  const journal = readFileSync(join(runDirectory, "journal.jsonl"), "utf8").trimEnd().split("\n")
    .map(line => JSON.parse(line) as JournalEntry)
  return Object.freeze({ runDirectory, manifest, journal })
}

function readWitnessArtifacts(root: string, runId: string): readonly Readonly<{
  path: string
  record: NativeSkillLoadWitnessRecord
}>[] {
  const { runDirectory } = promotionState(root, runId)
  return Object.freeze(readdirSync(runDirectory).filter(name => /^native-load-canary-[0-9a-f-]+\.json$/u.test(name))
    .map(name => {
      const path = join(runDirectory, name)
      const stat = lstatSync(path)
      expect(stat.isFile()).toBe(true)
      expect(stat.isSymbolicLink()).toBe(false)
      expect(stat.mode & 0o777).toBe(0o600)
      expect(stat.nlink).toBe(1)
      const bytes = readFileSync(path)
      expect(bytes.byteLength).toBeGreaterThan(0)
      return Object.freeze({ path, record: JSON.parse(bytes.toString("utf8")) as NativeSkillLoadWitnessRecord })
    }))
}

function assertWitnessBindings(input: Readonly<{
  witness: NativeSkillLoadWitnessRecord
  manifest: PromotionManifest
  runId: string
  operation: "apply" | "rollback"
  originalSha256: string
  campaignFixtureSha256: string
  fixturePackSha256: string
  targetIdentity: CliNativeIdentity
}>): void {
  const { witness, manifest } = input
  const expectedFileSha256 = input.operation === "apply" ? manifest.candidateSha256 : manifest.originalSha256
  expect(witness.schema).toBe("skillopt.native-load-witness.v1")
  expect(witness.operation).toBe(input.operation)
  expect(witness.runId).toBe(input.runId)
  expect(witness.witnessMode).toBe("native")
  expect(witness.originalSha256).toBe(input.originalSha256)
  expect(witness.candidateSha256).toBe(manifest.candidateSha256)
  expect(witness.expectedFileSha256).toBe(expectedFileSha256)
  expect(witness.capture.skillFileSha256).toBe(expectedFileSha256)
  expect(witness.fixturePackSha256).toBe(input.fixturePackSha256)
  expect(witness.canaryFixtureSha256).toBe(input.campaignFixtureSha256)
  expect(witness.canary.fixturePackSha256).toBe(input.fixturePackSha256)
  expect(witness.canary.fixtureId).toBe("dev-0")
  expect(witness.canary.fixtureSha256).toBe(input.campaignFixtureSha256)
  expect(witness.canary.split).toBe("dev")
  expect(witness.canary.status).toBe("valid")
  expect(witness.canary.hardPass).toBe(true)
  expect(witness.bindingsSha256).toBe(manifest.bindingsSha256)
  expect(manifest.bindings.witnessMode).toBe("native")
  expect(manifest.bindings.runId).toBe(input.runId)
  expect(manifest.bindings.originalSha256).toBe(input.originalSha256)
  expect(manifest.bindings.candidateSha256).toBe(manifest.candidateSha256)
  expect(manifest.bindings.fixturePackSha256).toBe(input.fixturePackSha256)
  expect(manifest.bindings.canaryFixtureSha256).toBe(input.campaignFixtureSha256)
  expect(manifest.bindings.nativeEngine).toBe(input.targetIdentity.engine)
  expect(manifest.bindings.nativeModel).toBe(input.targetIdentity.requestedModel)
  expect(manifest.bindings.nativeProfileId).toBe(input.targetIdentity.profileIdentity.id)
  expect(manifest.bindings.nativeProfileSha256).toBe(input.targetIdentity.profileIdentity.sha256)
  expect(manifest.bindings.nativeRuntimeVersion).toBe(input.targetIdentity.runtimeIdentity.version)
  expect(manifest.bindings.nativeExecutableSha256).toBe(input.targetIdentity.runtimeIdentity.executableSha256)
  expect(witness.native.engine).toBe(input.targetIdentity.engine)
  expect(witness.native.requestedModel).toBe(input.targetIdentity.requestedModel)
  expect(witness.native.identityBefore).toEqual(input.targetIdentity)
  expect(witness.native.identityAfter).toEqual(input.targetIdentity)
  expect(witness.native.identitySha256).toBe(sha256(canonicalJson(input.targetIdentity)))
  expect(witness.native.identityStable).toBe(true)
}

// Only a missing optional runtime skips; on Linux any supplied path reaches the fail-closed trainer verifier.
const publicationTest = process.platform === "linux" && process.env.SKILLOPT_PYTHON !== undefined ? test : test.skip

async function runPublicationDirection(direction: PublicationDirection): Promise<void> {
  const { models, expectedEngines } = direction
  const originalEnvironment = { ...process.env }
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, PILOT_SKILL)
  const fixturePack = makeAutomaticPack()
  const validatedFixturePack = validateNativeFixturePack(fixturePack)
  if (validatedFixturePack.status !== "STRUCTURALLY_VALID" || validatedFixturePack.requirements.length !== 0) {
    throw new Error("service-publication fixture pack is not structurally qualified")
  }
  const canaryFixture = validatedFixturePack.pack.fixtures.find(fixture => fixture.split === "dev")
  if (!canaryFixture) throw new Error("qualified campaign has no dev canary fixture")
  const nativeCli = createSyntheticForegroundCli({ models, fixturePack })
  const isolatedEnvironment = isolatePublicationEnvironment({ cliDirectory: nativeCli.directory, stateHome: worktree.stateHome,
    originalEnvironment })
  let runtime: ReturnType<typeof createCliRuntime> | undefined
  let owner: ReturnType<typeof attachAdmission> | undefined
  let service: ReturnType<typeof createNativeSkillOptForeground> | undefined
  let lastPhase = "setup"
  let lastOutcomeSummary = "no operation result"
  let retainForDiagnosis: string | undefined
  const diagnostic = () => `${safeDiagnostics(lastPhase, nativeCli.invocations())} ${lastOutcomeSummary}`
  const observeOutcome = (phase: string, result: unknown, expectedState: string): void => {
    lastPhase = phase
    lastOutcomeSummary = boundedResultSummary(result)
    const state = typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>).state : undefined
    if (state !== expectedState) retainForDiagnosis = `${phase} expected=${expectedState}`
  }
  const progressTimer = setInterval(() => process.stderr.write(`[skillopt-publication] ${diagnostic()}\n`), 60_000)
  try {
    expect(process.env.HOME).toBe(isolatedEnvironment.home)
    expect(process.env.CODEX_HOME).toBe(join(isolatedEnvironment.home, "codex"))
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(isolatedEnvironment.home, "claude"))
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.CODEX_API_KEY).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(linuxFilesystemTypeFor(root)).toBe("ext4")
    expect(linuxFilesystemTypeFor(worktree.stateHome)).toBe("ext4")
    mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
    writeFileSync(skillPath, targetBaseline, { mode: 0o600 })
    initializeSyntheticSkillProject(root)
    commitSyntheticSkillBaseline(root, "synthetic foreground publication baseline")
    const input = makeInput(root, fixturePack, selectedWorkerRuntime(), models)

    expect(findExecutable("codex")).toBe(nativeCli.codexExecutable)
    expect(findExecutable("claude")).toBe(nativeCli.claudeExecutable)
    const [generatorIdentity, targetIdentity, reviewerIdentity] = await Promise.all([
      inspectDefaultIdentity(expectedEngines.generator, models.generator.requestedModel),
      inspectDefaultIdentity(expectedEngines.target, models.target.requestedModel),
      inspectDefaultIdentity(expectedEngines.reviewer, models.reviewer.requestedModel),
    ])
    const identities = { generator: generatorIdentity, target: targetIdentity, reviewer: reviewerIdentity }
    for (const role of ["generator", "target", "reviewer"] as const) {
      const expectedEngine = expectedEngines[role]
      const identity = identities[role]
      const expectedRuntime = expectedEngine === "codex"
        ? { version: "0.163.0", executableSha256: nativeCli.codexExecutableSha256, profileId: "codex-restricted-read.v1" }
        : { version: "2.1.301", executableSha256: nativeCli.claudeExecutableSha256, profileId: "claude-native-no-tools.v1" }
      expect(models[role].engine).toBe(expectedEngine)
      expect(identity.engine).toBe(expectedEngine)
      expect(identity.requestedModel).toBe(models[role].requestedModel)
      expect(identity.runtimeIdentity.version).toBe(expectedRuntime.version)
      expect(identity.runtimeIdentity.executableSha256).toBe(expectedRuntime.executableSha256)
      expect(identity.profileIdentity.id).toBe(expectedRuntime.profileId)
    }
    expect(models.reviewer.requestedModel).not.toBe(models.target.requestedModel)
    expect(expectedEngines.reviewer).toBe(expectedEngines.target)
    if (expectedEngines.target === "claude") {
      expect(targetIdentity.profileIdentity.sha256).not.toBe(reviewerIdentity.profileIdentity.sha256)
    }
    expect(nativeCli.invocations()).toEqual([])

    runtime = createCliRuntime({ worktree: root, engine: models.generator.engine, model: models.generator.requestedModel })
    owner = attachAdmission(runtime, `skillopt-foreground-owner-${randomUUID()}`, {
      engine: models.generator.engine, model: models.generator.requestedModel,
    })
    service = createNativeSkillOptForeground(runtime, owner)
    nativeCli.useCampaignResponses()

    await withIntegrationDeadline({
      diagnostics: diagnostic,
      async run(signal) {
        lastPhase = "prepare"
        const inputRun = await service!.prepare(input, signal)
        if (inputRun.state !== "PREPARED" || typeof inputRun.runId !== "string" || typeof inputRun.bindingSha256 !== "string") {
          throw new Error(`foreground service preparation failed (${diagnostic()})`)
        }
        const runId = inputRun.runId
        const bindingSha256 = inputRun.bindingSha256
        const promotionRunDirectory = join(executionRunDirectory(root), "skillopt-native-promotion", runId)
        expect(service!.status().state).toBe("PREPARED")
        expect(service!.status().requestCounts).toEqual({
          charged: { target: 0, optimizer: 0, reviewer: 0 },
          dispatched: { target: 0, optimizer: 0, reviewer: 0 },
          unknown: { target: 0, optimizer: 0, reviewer: 0 },
        })
        expect(readFileSync(skillPath)).toEqual(targetBaseline)
        expect(existsSync(promotionRunDirectory)).toBe(false)
        expect(readAccounting(root, runId).qualificationCount).toEqual({ count: 0 })
        expect(readAccounting(root, runId).canaryHandoffCount).toEqual({ count: 0 })

        lastPhase = "campaign-hitl"
        const campaignApproval = await withApprovalFromPrompt({
          parentSignal: signal,
          action: activeSignal => service!.run(runId, input, bindingSha256, activeSignal),
          beforeApproval(binding) {
            expect(binding.workflowID).toBe(runId)
            expect(/^[a-f0-9]{64}$/u.test(binding.subjectSha256)).toBe(true)
            expect(nativeCli.invocations()).toEqual([])
            expect(service!.status().requestCounts).toEqual({
              charged: { target: 0, optimizer: 0, reviewer: 0 },
              dispatched: { target: 0, optimizer: 0, reviewer: 0 },
              unknown: { target: 0, optimizer: 0, reviewer: 0 },
            })
            expect(readAccounting(root, runId).qualificationCount).toEqual({ count: 0 })
            expect(existsSync(promotionRunDirectory)).toBe(false)
          },
        })
        const campaignResult = campaignApproval.value as Record<string, unknown>
        observeOutcome("campaign-hitl", campaignResult, "AWAITING_CANDIDATE_APPROVAL")
        expect(campaignResult.state).toBe("AWAITING_CANDIDATE_APPROVAL")
        expect(campaignResult.controllerState).toBe("AWAITING_CANDIDATE_APPROVAL")
        expect(campaignResult.candidateQualified).toBe(true)
        expect(campaignResult.metricsStatus).toBe("METRICS_PASSED")
        expect(campaignResult.reviewerCount).toBe(2)
        expect(campaignResult.pendingDispatch).toBe(false)
        expect(campaignResult.publicationAuthorized).toBe(false)
        expect(campaignResult.postApplyHandoffAuthorized).toBe(false)
        expect(campaignResult.requestCounts).toEqual(requestCounts(432))
        expect(service!.status().state).toBe("AWAITING_CANDIDATE_APPROVAL")
        expect(service!.status().requestCounts).toEqual(requestCounts(432))
        expect(readFileSync(skillPath)).toEqual(targetBaseline)
        expect(runtime!.runs.status().claim).toBeUndefined()
        expect(owner!.isReleased).toBe(false)
        owner!.assertOwner()
        expect(readAccounting(root, runId)).toEqual({
          roleCounts: [{ role: "optimizer", count: 3 }, { role: "reviewer", count: 2 }, { role: "target", count: 432 }],
          settledCount: { count: 437 },
          unresolvedCount: { count: 0 },
          qualificationCount: { count: 1 },
          canaryHandoffCount: { count: 0 },
          canaryPhaseCount: { count: 0 },
        })
        const trainerEvidence = readTrainerEvidence(root, runId)
        expect(trainerEvidence.events).toHaveLength(123)
        trainerEvidence.events.forEach((event, index) => expect(event.ordinal).toBe(index + 1))
        expect(trainerEvidence.events[0]).toEqual({ ordinal: 1, kind: "rollout", optimizerStage: null })
        const optimizerStages = trainerEvidence.optimizerDispatches.map(event => event.optimizerStage)
        const stageOrder = { analyst: 0, merge: 1, ranking: 2 } as const
        expect(optimizerStages).toHaveLength(3)
        expect(optimizerStages.every(stage => Object.hasOwn(stageOrder, stage))).toBe(true)
        console.error(`[skillopt-publication] optimizerStages=${optimizerStages.join(",")}`)
        const stageRanks = optimizerStages.map(stage => stageOrder[stage as keyof typeof stageOrder])
        expect(stageRanks).toEqual([...stageRanks].sort((left, right) => left - right))
        expect(new Set(trainerEvidence.optimizerDispatches.map(event => event.nativeRequestId)).size).toBe(3)
        for (const dispatch of trainerEvidence.optimizerDispatches) {
          expect(dispatch.role).toBe("optimizer")
          expect(dispatch.actualDispatch).toBe(1)
          expect(dispatch.dispatchState).toBe("settled")
        }
        expect(trainerEvidence.events.filter(event => event.kind === "rollout")).toHaveLength(120)
        expect(trainerEvidence.events.filter(event => event.kind === "optimizer")).toHaveLength(3)
        expect(trainerEvidence.dispatchCount).toEqual({ count: 123 })
        expect(trainerEvidence.distinctDispatchCount).toEqual({ count: 123 })
        expect(trainerEvidence.settledDispatchCount).toEqual({ count: 123 })
        expect(trainerEvidence.roleCounts).toEqual([{ role: "optimizer", count: 3 }, { role: "target", count: 120 }])
        expect(nativeCli.invocations()).toHaveLength(437)
        expect(invocationCounts(nativeCli.invocations())).toEqual({ target: 432, optimizer: 3, reviewer: 2, unexpected: 0 })
        expect(nativeCli.invocations().every(item => item.mode === "campaign" && item.status === "completed")).toBe(true)

        lastPhase = "apply-hitl"
        nativeCli.useCanaryResponse(canaryFixture)
        const terminal = syntheticTerminal()
        const applyApproval = await withApprovalFromPrompt({
          parentSignal: signal,
          action: activeSignal => service!.publish(runId, terminal.terminal, activeSignal),
          beforeApproval(binding) {
            expect(binding.workflowID).toBe(`apply-${runId}`.slice(0, 128))
            expect(binding.subjectSha256).not.toBe(campaignApproval.binding.subjectSha256)
            expect(service!.status().state).toBe("AWAITING_CANDIDATE_APPROVAL")
            expect(service!.status().requestCounts).toEqual(requestCounts(432))
            expect(readAccounting(root, runId).canaryPhaseCount).toEqual({ count: 0 })
            expect(nativeCli.invocations()).toHaveLength(437)
            expect(existsSync(promotionRunDirectory)).toBe(false)
            expect(readFileSync(skillPath)).toEqual(targetBaseline)
          },
        })
        const publishResult = applyApproval.value as Record<string, unknown>
        observeOutcome("apply-hitl", publishResult, "COMMITTED")
        expect(publishResult.operation).toBe("publish")
        expect(publishResult.state).toBe("COMMITTED")
        expect(publishResult.runId).toBe(runId)
        expect(publishResult.controllerState).toBe("COMPLETED")
        expect(publishResult.publicationAuthorized).toBe(true)
        expect(publishResult.postApplyHandoffAuthorized).toBe(true)
        expect(service!.status().state).toBe("COMPLETED")
        expect(service!.status().requestCounts).toEqual(requestCounts(433))
        expect(terminal.choices).toHaveLength(1)
        expect(terminal.choices[0]?.[0]).toBe("Allow this content in this session")
        expect(terminal.choices[0]?.[1]).toBe("Deny")
        expect(readFileSync(skillPath)).not.toEqual(targetBaseline)
        expect(runtime!.runs.status().claim).toBeUndefined()
        expect(readAccounting(root, runId)).toEqual({
          roleCounts: [{ role: "optimizer", count: 3 }, { role: "reviewer", count: 2 }, { role: "target", count: 433 }],
          settledCount: { count: 438 },
          unresolvedCount: { count: 0 },
          qualificationCount: { count: 1 },
          canaryHandoffCount: { count: 1 },
          canaryPhaseCount: { count: 1 },
        })
        expect(nativeCli.invocations()).toHaveLength(438)
        expect(invocationCounts(nativeCli.invocations())).toEqual({ target: 433, optimizer: 3, reviewer: 2, unexpected: 0 })
        expect(nativeCli.invocations().filter(item => item.mode === "canary")).toHaveLength(1)

        const originalSha256 = sha256(targetBaseline)
        const fixturePackSha256 = validatedFixturePack.packSha256
        const campaignFixtureSha256 = sha256(canonicalJson(canaryFixture))
        const appliedState = promotionState(root, runId)
        const appliedDirectory = lstatSync(appliedState.runDirectory, { bigint: true })
        expect(appliedDirectory.isDirectory()).toBe(true)
        expect(appliedDirectory.isSymbolicLink()).toBe(false)
        expect(appliedDirectory.nlink).toBeGreaterThan(1n)
        expect(appliedState.manifest.runId).toBe(runId)
        expect(appliedState.manifest.originalSha256).toBe(originalSha256)
        expect(appliedState.manifest.bindings.nativeEngine).toBe(targetIdentity.engine)
        expect(appliedState.manifest.bindings.nativeModel).toBe(targetIdentity.requestedModel)
        expect(appliedState.manifest.bindings.nativeProfileId).toBe(targetIdentity.profileIdentity.id)
        expect(appliedState.manifest.bindings.nativeProfileSha256).toBe(targetIdentity.profileIdentity.sha256)
        expect(appliedState.manifest.bindings.nativeRuntimeVersion).toBe(targetIdentity.runtimeIdentity.version)
        expect(appliedState.manifest.bindings.nativeExecutableSha256).toBe(targetIdentity.runtimeIdentity.executableSha256)
        expect(appliedState.manifest.bindings.fixturePackSha256).toBe(fixturePackSha256)
        expect(appliedState.manifest.bindings.canaryFixtureSha256).toBe(campaignFixtureSha256)
        expect(appliedState.journal.at(-1)?.state).toBe("COMMITTED")
        const applyWitnesses = readWitnessArtifacts(root, runId)
        expect(applyWitnesses).toHaveLength(1)
        const applyWitness = applyWitnesses[0]!.record
        assertWitnessBindings({ witness: applyWitness, manifest: appliedState.manifest, runId,
          operation: "apply", originalSha256, campaignFixtureSha256, fixturePackSha256, targetIdentity })
        expect(applyWitness.invocation.sessionID).not.toBe(owner!.sessionID)
        expect(applyWitness.invocation.attachmentEpoch).not.toBe(owner!.epoch)
        const candidateBytes = readFileSync(skillPath)
        expect(sha256(candidateBytes)).toBe(applyWitness.candidateSha256)
        expect(readFileSync(join(appliedState.runDirectory, appliedState.manifest.backupName))).toEqual(targetBaseline)
        expect(readFileSync(join(dirname(skillPath), appliedState.manifest.stageName))).toEqual(targetBaseline)
        expect(readFileSync(applyWitnesses[0]!.path).byteLength).toBeGreaterThan(0)

        const beforeCommittedReentry = nativeCli.invocations()
        const beforeCommittedAccounting = readAccounting(root, runId)
        const repeatedCommittedPublish = await service!.publish(runId, terminal.terminal, signal)
        expect(repeatedCommittedPublish).toEqual(publishResult)
        expect(nativeCli.invocations()).toEqual(beforeCommittedReentry)
        expect(readAccounting(root, runId)).toEqual(beforeCommittedAccounting)
        expect(terminal.choices).toHaveLength(1)

        lastPhase = "rollback-hitl"
        const rollbackApproval = await withApprovalFromPrompt({
          parentSignal: signal,
          action: activeSignal => service!.rollback(runId, terminal.terminal, activeSignal),
          beforeApproval(binding) {
            expect(binding.workflowID).toBe(`rollback-${runId}`.slice(0, 128))
            expect(binding.subjectSha256).not.toBe(applyApproval.binding.subjectSha256)
            expect(service!.status().state).toBe("COMPLETED")
            expect(service!.status().requestCounts).toEqual(requestCounts(433))
            expect(readAccounting(root, runId).canaryPhaseCount).toEqual({ count: 1 })
            expect(nativeCli.invocations()).toHaveLength(438)
            expect(readFileSync(skillPath)).toEqual(candidateBytes)
            const stateBeforeRollbackApproval = promotionState(root, runId)
            expect(stateBeforeRollbackApproval.journal.at(-1)?.state).toBe("COMMITTED")
            expect(stateBeforeRollbackApproval.journal.some(item => item.state === "ROLLBACK_SWAP_INTENT")).toBe(false)
            expect(readWitnessArtifacts(root, runId)).toHaveLength(1)
          },
        })
        const rollbackResult = rollbackApproval.value as Record<string, unknown>
        observeOutcome("rollback-hitl", rollbackResult, "ROLLED_BACK")
        expect(rollbackResult.operation).toBe("rollback")
        expect(rollbackResult.state).toBe("ROLLED_BACK")
        expect(rollbackResult.runId).toBe(runId)
        expect(rollbackResult.controllerState).toBe("ROLLED_BACK")
        expect(rollbackResult.rollbackAuthorized).toBe(true)
        expect(rollbackResult.postRollbackHandoffAuthorized).toBe(true)
        expect(rollbackApproval.binding.subjectSha256).not.toBe(applyApproval.binding.subjectSha256)
        expect(rollbackApproval.binding.subjectSha256).not.toBe(campaignApproval.binding.subjectSha256)
        expect(terminal.choices).toHaveLength(2)
        expect(terminal.choices[0]?.[0]).toBe("Allow this content in this session")
        expect(terminal.choices[0]?.[1]).toBe("Deny")
        expect(terminal.choices[1]?.[0]).toBe("Allow this content in this session")
        expect(terminal.choices[1]?.[1]).toBe("Deny")
        expect(service!.status().state).toBe("ROLLED_BACK")
        expect(service!.status().requestCounts).toEqual(requestCounts(434))
        expect(readFileSync(skillPath)).toEqual(targetBaseline)
        expect(runtime!.runs.status().claim).toBeUndefined()
        expect(readAccounting(root, runId)).toEqual({
          roleCounts: [{ role: "optimizer", count: 3 }, { role: "reviewer", count: 2 }, { role: "target", count: 434 }],
          settledCount: { count: 439 },
          unresolvedCount: { count: 0 },
          qualificationCount: { count: 1 },
          canaryHandoffCount: { count: 2 },
          canaryPhaseCount: { count: 2 },
        })
        const finalInvocations = nativeCli.invocations()
        expect(finalInvocations).toHaveLength(439)
        expect(invocationCounts(finalInvocations)).toEqual({ target: 434, optimizer: 3, reviewer: 2, unexpected: 0 })
        const invocationModels = { optimizer: models.generator, target: models.target, reviewer: models.reviewer }
        expect(finalInvocations.every(invocation => {
          const expected = invocation.role === "unexpected" ? undefined : invocationModels[invocation.role]
          return expected !== undefined && invocation.engine === expected.engine && invocation.model === expected.requestedModel
        })).toBe(true)
        expect(finalInvocations.every(item => item.status === "completed")).toBe(true)
        expect(finalInvocations.filter(item => item.mode === "canary")).toHaveLength(2)

        const rolledBackState = promotionState(root, runId)
        const rolledBackDirectory = lstatSync(rolledBackState.runDirectory, { bigint: true })
        expect(rolledBackDirectory.nlink).toBeGreaterThan(1n)
        expect(rolledBackState.journal.at(-1)?.state).toBe("ROLLED_BACK")
        expect(rolledBackState.manifest.bindings.candidateSha256).toBe(applyWitness.candidateSha256)
        const rollbackIntent = [...rolledBackState.journal].reverse().find(item => item.state === "ROLLBACK_SWAP_INTENT")
        if (!rollbackIntent || typeof rollbackIntent.details.rollbackStageName !== "string" ||
            typeof rollbackIntent.details.operatorApprovalSha256 !== "string") {
          throw new Error("settled rollback journal omitted its distinct approval and displaced candidate identity")
        }
        expect(rollbackIntent.details.operatorApprovalSha256).not.toBe(rolledBackState.manifest.approvalSha256)
        const rollbackStageName = rollbackIntent.details.rollbackStageName
        expect(readFileSync(join(dirname(skillPath), rollbackStageName))).toEqual(candidateBytes)
        expect(readFileSync(join(rolledBackState.runDirectory, rolledBackState.manifest.backupName))).toEqual(targetBaseline)
        const allWitnesses = readWitnessArtifacts(root, runId)
        expect(allWitnesses).toHaveLength(2)
        const rollbackWitness = allWitnesses.find(item => item.record.operation === "rollback")
        if (!rollbackWitness) throw new Error("service did not persist a rollback witness artifact")
        assertWitnessBindings({ witness: rollbackWitness.record, manifest: rolledBackState.manifest, runId,
          operation: "rollback", originalSha256, campaignFixtureSha256, fixturePackSha256, targetIdentity })
        expect(rollbackWitness.record.invocation.sessionID).not.toBe(owner!.sessionID)
        expect(rollbackWitness.record.invocation.sessionID).not.toBe(applyWitness.invocation.sessionID)
        expect(rollbackWitness.record.invocation.attachmentEpoch).not.toBe(owner!.epoch)
        expect(rollbackWitness.record.invocation.attachmentEpoch).not.toBe(applyWitness.invocation.attachmentEpoch)

        const beforeSettledCalls = nativeCli.invocations()
        const beforeSettledAccounting = readAccounting(root, runId)
        lastPhase = "settled-reentry"
        const repeatedPublish = await service!.publish(runId, terminal.terminal, signal)
        expect(repeatedPublish.state).toBe("BLOCKED")
        expect(repeatedPublish.reasonCode).toBe("publication_already_settled")
        const repeatedRollback = await service!.rollback(runId, terminal.terminal, signal)
        expect(repeatedRollback.state).toBe("BLOCKED")
        expect(repeatedRollback.reasonCode).toBe("rollback_already_settled")
        expect(nativeCli.invocations()).toEqual(beforeSettledCalls)
        expect(readAccounting(root, runId)).toEqual(beforeSettledAccounting)
        expect(terminal.choices).toHaveLength(2)
        expect(readFileSync(skillPath)).toEqual(targetBaseline)
        expect(runtime!.runs.status().claim).toBeUndefined()
        expect(sha256(readFileSync(nativeCli.codexExecutable))).toBe(nativeCli.codexExecutableSha256)
        expect(sha256(readFileSync(nativeCli.claudeExecutable))).toBe(nativeCli.claudeExecutableSha256)
      },
    })
  } catch (error) {
    retainForDiagnosis ??= `${lastPhase} test failure`
    if (lastPhase !== "setup") {
      const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : "Error"
      const errorCode = typeof error === "object" && error !== null && "code" in error &&
        typeof error.code === "string" && /^[a-z0-9][a-z0-9_:-]{0,95}$/iu.test(error.code) ? error.code : undefined
      lastOutcomeSummary = `${lastOutcomeSummary} errorName=${errorName}${errorCode ? ` errorCode=${errorCode}` : ""}`
    }
    throw error
  } finally {
    clearInterval(progressTimer)
    let activeClaim: unknown
    try {
      try { activeClaim = runtime?.runs.status().claim }
      catch {
        retainForDiagnosis ??= "runtime claim state unavailable"
      }
      if (activeClaim) retainForDiagnosis ??= "unresolved owner execution claim"
      if (!retainForDiagnosis) {
        service?.dispose()
        if (owner && runtime && !owner.isReleased) {
          const ownerDetached = await detachAdmission(runtime, owner.sessionID, owner.epoch, "foreground publication fixture complete")
          if (!ownerDetached) retainForDiagnosis = "foreground publication owner release failed"
        }
      }
      if (retainForDiagnosis) {
        process.stderr.write(`[skillopt-publication] retainedRoot=${root} retainedStateHome=${worktree.stateHome} ` +
          `retainedCli=${nativeCli.directory} ` +
          `preserveReason=${retainForDiagnosis} ${diagnostic()}\n`)
      } else {
        nativeCli.dispose()
        worktree.cleanup()
      }
    } finally {
      worktree.releaseEnvironment()
      isolatedEnvironment.restore()
    }
    if (activeClaim) throw new Error(`foreground publication fixture retained an unresolved owner claim; ${diagnostic()}`)
  }
}

publicationTest(`Linux default transport service qualifies, commits a fresh loader canary, and separately rolls back (${primaryDirection.name})`,
  async () => runPublicationDirection(primaryDirection), outerTestDeadlineMs)

publicationTest(`Linux default transport service qualifies, commits a fresh loader canary, and separately rolls back (${reverseDirection.name})`,
  async () => runPublicationDirection(reverseDirection), outerTestDeadlineMs)
