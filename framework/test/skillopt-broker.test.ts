import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Database } from "bun:sqlite"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import { humanDecision } from "../src/hosts/operator.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import { createNativeDataset, NATIVE_DATASET_LIMITS, NATIVE_FIXTURE_PACK_SCHEMA, NATIVE_PROTECTED_CHANGES, NATIVE_WIKI_CONTRACT, NATIVE_WIKI_SPLIT_MINIMUMS, NATIVE_WIKI_SPLITS, NATIVE_WIKI_STRATA, type NativeModelBindings, type NativeWikiFixture, type NativeWikiSplit, type NativeWikiStratum } from "../src/skillopt/dataset.ts"
import type { NativeSkillOptDispatchInput } from "../src/skillopt/broker.ts"
import { canonicalJson, COMPILE_ANCHOR, sha256 } from "../src/skillopt/pilot.ts"
import { buildNativeCampaignSchedule } from "../src/skillopt/campaign-protocol.ts"
import { renderNativeEvaluationPrompt } from "../src/skillopt/evaluation.ts"
import { digestDirectory } from "../src/sessions/digest.ts"
import type { CliNativeIdentity, CliTransportOptions, CliTransportResult } from "../src/hosts/cli-transport.ts"
import type { ExecutionHost, ExecutionRequest, ExecutionReconciliation } from "../src/hosts/types.ts"
import { executionRunDirectory } from "../src/state/store.ts"
import { tempWorktree, type TempWorktree } from "./guards-helpers.ts"
import { withTerminalLine } from "./operator-helpers.ts"

// These fixtures replace only the native transport boundary. No model CLI or real data is invoked.
const transportModule = fileURLToPath(new URL("../src/hosts/cli-transport.ts", import.meta.url))
const originalTransportModule = { ...await import("../src/hosts/cli-transport.ts") }
type MockPlan = {
  identity?: CliNativeIdentity
  run: () => CliTransportResult | Promise<CliTransportResult>
  reconcile: () => ExecutionReconciliation
  onInspect?: () => void
  onRun?: () => void
  onCancel?: () => void
  cancelResult?: { requested: boolean; acknowledged: boolean; terminal: boolean; quiescent: boolean; evidence?: string }
  calls: { inspect: number; run: number; cancel: number; reconcile: number }
}
const plans = new Map<string, MockPlan>()
mock.module(transportModule, () => ({
  ...originalTransportModule,
  createCliTransport(options: CliTransportOptions) {
    const plan = plans.get(options.prompt)
    if (!plan) throw new Error("synthetic test transport plan missing")
    return {
      async inspectIdentity() {
        plan.calls.inspect += 1
        plan.onInspect?.()
        return plan.identity ?? identityFor(options.engine, options.model)
      },
      async run() {
        plan.calls.run += 1
        plan.onRun?.()
        return plan.run()
      },
      async requestCancel() {
        plan.calls.cancel += 1
        plan.onCancel?.()
        return plan.cancelResult ?? { requested: true, acknowledged: true, terminal: false, quiescent: false }
      },
      async reconcile() {
        plan.calls.reconcile += 1
        return plan.reconcile()
      },
    }
  },
}))
const { createNativeSkillOptBroker, getNativeSkillOptBrokerWorktree, SkillOptBrokerError } = await import("../src/skillopt/broker.ts")

const supportedNative = process.platform === "darwin" || process.platform === "linux"
let nativeHelperRoot: string | undefined
let nativeHelperPath = ""
let nativeHelperSha256 = ""
const worktrees: Array<{ worktree: TempWorktree; owner: ReturnType<typeof attachAdmission>; runtime: ReturnType<typeof createExecutionRuntime> }> = []
const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")
const baselineBytes = Buffer.from("# llm-wiki\n\nProtected synthetic baseline.\n", "utf8")

const models: NativeModelBindings = {
  generator: {
    engine: "codex", requestedModel: "gpt-5-codex",
    runtimeIdentity: { version: "codex 1.18.33", executableSha256: "a".repeat(64) },
    profileIdentity: { id: "codex-restricted-read.v1", sha256: "b".repeat(64) },
  },
  target: {
    engine: "claude", requestedModel: "claude-sonnet-4-5",
    runtimeIdentity: { version: "claude 2.1.0", executableSha256: "c".repeat(64) },
    profileIdentity: { id: "claude-native-no-tools.v1", sha256: "d".repeat(64) },
  },
  reviewer: {
    engine: "claude", requestedModel: "claude-opus-4-1",
    runtimeIdentity: { version: "claude 2.1.0", executableSha256: "c".repeat(64) },
    profileIdentity: { id: "claude-native-no-tools.v1", sha256: "e".repeat(64) },
  },
}

beforeAll(() => {
  if (!supportedNative) return
  nativeHelperRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "skillopt-broker-native-clock-")))
  chmodSync(nativeHelperRoot, 0o700)
  nativeHelperPath = join(nativeHelperRoot, "skillopt-native")
  const sourcePath = resolve(import.meta.dir, "../src/skillopt/native.c")
  execFileSync(process.env.CC ?? "cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", sourcePath, "-o", nativeHelperPath], { stdio: "pipe" })
  chmodSync(nativeHelperPath, 0o700)
  nativeHelperSha256 = digest(readFileSync(nativeHelperPath))
})

afterAll(() => {
  mock.module(transportModule, () => originalTransportModule)
  if (nativeHelperRoot) rmSync(nativeHelperRoot, { recursive: true, force: true })
})

afterEach(() => {
  plans.clear()
  for (const fixture of worktrees.splice(0).reverse()) {
    if (!fixture.runtime.runs.status().claim && !fixture.owner.isReleased) {
      try {
        fixture.owner.release({ workflowQuiescent: true, evidence: "synthetic fixture finished without running a model", workflowID: null, revision: null })
      } catch { /* Nonquiescent synthetic launch fixtures intentionally keep their owner and run fence. */ }
    }
    fixture.worktree.cleanup()
  }
})

function identityFor(engine: CliTransportOptions["engine"], model: string): CliNativeIdentity | undefined {
  if (engine === "local") return undefined
  const binding = [models.generator, models.target, models.reviewer].find((candidate) => candidate.engine === engine && candidate.requestedModel === model)
  if (!binding) return undefined
  return structuredClone({
    engine: binding.engine, requestedModel: binding.requestedModel,
    runtimeIdentity: binding.runtimeIdentity, profileIdentity: binding.profileIdentity,
  })
}

function makeFixture(split: NativeWikiSplit, index: number, stratum: NativeWikiStratum) {
  const id = `${split}-${index}`
  const sourceId = `source-${id}`
  const slotId = `slot-${id}`
  const leftId = `fact-${id}-left`
  const rightId = `fact-${id}-right`
  const leftStatement = `Supported fact A for ${id}.`
  const rightStatement = `Supported fact B for ${id}.`
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

function makePack(withTargetIndex = false) {
  const fixtures: NativeWikiFixture[] = []
  for (const split of NATIVE_WIKI_SPLITS) {
    for (let index = 0; index < NATIVE_WIKI_SPLIT_MINIMUMS[split]; index += 1) {
      const fixture = makeFixture(split, index, NATIVE_WIKI_STRATA[index % NATIVE_WIKI_STRATA.length]!)
      if (withTargetIndex && split === "train" && index === 0) {
        const indexId = `index-${fixture.id}`
        fixtures.push({
          ...fixture,
          task: `${fixture.task} Register the new page in [[slot:${indexId}]].`,
          outputSlots: [...fixture.outputSlots, { id: indexId, kind: "index", existingContent: "# Synthetic wiki index\n" }],
          assertions: {
            ...fixture.assertions,
            ownership: [...fixture.assertions.ownership, { slotId: indexId, expected: "append-only" }],
          },
        })
      } else fixtures.push(fixture)
    }
  }
  return { schema: NATIVE_FIXTURE_PACK_SCHEMA, contract: NATIVE_WIKI_CONTRACT, fixtures }
}

function mockPlan(prompt: string, values: Partial<Omit<MockPlan, "calls">> = {}): MockPlan {
  const plan: MockPlan = {
    run: () => ({ status: "completed", text: "{\"writes\":[]}", quiescent: true }),
    reconcile: () => ({ outcome: "terminal", quiescent: true, evidence: "synthetic mock evidence" }),
    calls: { inspect: 0, run: 0, cancel: 0, reconcile: 0 },
    ...values,
  }
  plans.set(prompt, plan)
  return plan
}

async function fixture(trigger: "manual" | "automatic" = "manual", skillBytes = baselineBytes, planInitialTarget = false) {
  const worktree = tempWorktree()
  const root = worktree.worktree
  const skillPath = join(root, ".agents", "skills", "llm-wiki", "SKILL.md")
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 })
  writeFileSync(skillPath, skillBytes, { mode: 0o600 })
  const source = Buffer.from("Synthetic approved source excerpt for native broker fixtures.\n", "utf8")
  const sourcePath = `knowledge/raw/documents/${sha256(source)}.md`
  const absoluteSource = join(root, sourcePath)
  mkdirSync(dirname(absoluteSource), { recursive: true, mode: 0o700 })
  writeFileSync(absoluteSource, source, { mode: 0o600 })
  const dataset = createNativeDataset({ root, selections: [{ path: sourcePath }], fixturePack: makePack(planInitialTarget), modelBindings: models })
  if (dataset.status !== "STRUCTURALLY_VALID") throw new Error("synthetic broker dataset is not structurally valid")

  const host: ExecutionHost = {
    identity: { engine: "codex", profile: "legacy-unowned" },
    async preflight() { return { compatible: true, controls: {}, problems: [] } },
    async prepare(_request: ExecutionRequest) { throw new Error("the native broker must not use the generic host") },
    async reconcile(): Promise<ExecutionReconciliation> { return { outcome: "unknown", quiescent: false, evidence: "no generic host recovery" } },
  }
  const runtime = createExecutionRuntime({ directory: root, worktree: root, config: structuredClone(DEFAULT_CONFIG), log() {} }, () => host, { planningOnlyMain: true })
  const owner = attachAdmission(runtime, `session_${randomUUID().replaceAll("-", "")}`, { engine: "codex", model: models.generator.requestedModel })
  const broker = createNativeSkillOptBroker(runtime, { nativeHelperPath, nativeHelperSha256 })
  broker.controller.initialize()
  const current = { dataset, baselineSkillSha256: sha256(skillBytes) }
  const prepared = broker.controller.prepare({ owner, campaignId: `campaign_${randomUUID().replaceAll("-", "")}`, dataset, baselineSkillSha256: current.baselineSkillSha256 })
  if (prepared.state !== "PREPARED") throw new Error("synthetic broker campaign was not prepared")
  const receipt = await withTerminalLine(`APPROVE ${prepared.runId} ${prepared.consentBindingSha256}`, () =>
    humanDecision("approve", prepared.decisionBinding))
  const consent = broker.controller.consent(prepared, receipt, current)
  const initialTargetPlan = planInitialTarget ? broker.controller.prepareNativeCampaignTarget({
    owner, runtime, prepared, current,
    scheduleEntry: { kind: "training", ...buildNativeCampaignSchedule(dataset.fixturePack).training[0]! },
  }) : undefined
  let reservation: NativeSkillOptDispatchInput["reservation"]
  if (trigger === "manual") {
    reservation = broker.controller.reserveManual({ owner, prepared, consent, current })
  } else {
    const arm = broker.controller.arm(prepared, consent, current)
    const directory = digestDirectory(root)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    for (let index = 0; index < 5; index += 1) {
      const sessionID = `synthetic_train_${index}`
      writeFileSync(join(directory, `${sessionID}.json`), JSON.stringify({
        schemaVersion: 1, kind: "session-digest", sessionID, engine: "codex", model: models.generator.requestedModel,
        routes: {}, startedAt: Date.now(), endedAt: Date.now() + 5 * 60 * 1000 + index,
        turns: 1, tools: {}, decisions: {}, files: ["knowledge/topic.md"], commands: [], workflows: [],
        outcome: "completed", complete: true,
      }), { mode: 0o600 })
    }
    reservation = broker.controller.reserveAutomatic({ owner, prepared, consent, arm, current })
  }
  worktrees.push({ worktree, owner, runtime })
  return { worktree, root, owner, runtime, broker, current, prepared, consent, reservation, dataset, absoluteSource, initialTargetPlan }
}

function inputFor(f: Awaited<ReturnType<typeof fixture>>, prompt: string, patch: Partial<NativeSkillOptDispatchInput> = {}): NativeSkillOptDispatchInput {
  return {
    owner: f.owner, reservation: f.reservation, getCurrent: () => f.current,
    role: f.reservation.role, phase: f.reservation.phase, prompt,
    ...patch,
  }
}

async function targetPlanFixture() {
  const skill = `---\nname: llm-wiki\ndescription: Synthetic target provenance fixture\n---\n${COMPILE_ANCHOR}Preserve the synthetic suffix.\n`
  const f = await fixture("manual", Buffer.from(skill, "utf8"), true)
  const schedule = buildNativeCampaignSchedule(f.dataset.fixturePack)
  const item = schedule.training[0]!
  const targetFixture = f.dataset.fixturePack.fixtures.find(value => value.id === item.caseId)!
  const context = { owner: f.owner, runtime: f.runtime, prepared: f.prepared, current: f.current }
  const targetPlan = f.initialTargetPlan
  if (!targetPlan) throw new Error("synthetic target plan was not prepared before reservation")
  const rendered = renderNativeEvaluationPrompt(targetFixture, skill)
  const prompt = canonicalJson({ system: rendered.system, user: rendered.user })
  return { f, context, targetPlan, prompt }
}

async function targetWitnessFixture() {
  const planned = await targetPlanFixture()
  const target = planned.f.broker.controller.bindNativeCampaignTargetReservation({
    ...planned.context, targetPlan: planned.targetPlan, reservation: planned.f.reservation,
  })
  return { ...planned, target }
}

function expectBrokerError(error: unknown, code: InstanceType<typeof SkillOptBrokerError>["code"]): void {
  if (!(error instanceof SkillOptBrokerError)) throw new Error(`expected SkillOptBrokerError with code ${code}`)
  expect(error.code).toBe(code)
  expect(error.message).toBe(code)
}

const nativeTest = supportedNative ? test : test.skip

nativeTest("completed target witnesses admit the exact prospective request once without another dispatch", async () => {
  const { f, context, target, prompt } = await targetWitnessFixture()
  const plan = mockPlan(prompt)
  const result = await f.broker.dispatch(inputFor(f, prompt))
  expect(result.status).toBe("completed")
  expect(result.targetWitness).toBeDefined()
  const proof = f.broker.controller.admitNativeCampaignTargetResponse({
    ...context, target, targetWitness: result.targetWitness!,
  })
  expect(Object.isFrozen(proof)).toBe(true)
  expect(Reflect.ownKeys(proof)).toEqual([])
  expect(() => f.broker.controller.admitNativeCampaignTargetResponse({
    ...context, target, targetWitness: result.targetWitness!,
  })).toThrow()
  expect(plan.calls.run).toBe(1)
  expect(f.broker.controller.status().requestCounts.charged.target).toBe(1)
  expect(f.broker.controller.status().pendingDispatch).toBe(false)
  expect(f.runtime.runs.status().claim).toBeUndefined()
})

nativeTest("copied and serialized completed target witnesses cannot authorize response writes", async () => {
  for (const copy of [
    (witness: object) => ({ ...witness }),
    (witness: object) => JSON.parse(JSON.stringify(witness)),
  ]) {
    const { f, context, target, prompt } = await targetWitnessFixture()
    const plan = mockPlan(prompt)
    const result = await f.broker.dispatch(inputFor(f, prompt))
    expect(result.status).toBe("completed")
    expect(result.targetWitness).toBeDefined()
    expect(() => f.broker.controller.admitNativeCampaignTargetResponse({
      ...context, target, targetWitness: copy(result.targetWitness!) as never,
    })).toThrow()
    expect(plan.calls.run).toBe(1)
    expect(f.broker.controller.status().requestCounts.charged.target).toBe(1)
  }
})

nativeTest("target plans cannot be bound retrospectively after a request has completed", async () => {
  const { f, context, targetPlan, prompt } = await targetPlanFixture()
  const plan = mockPlan(prompt)
  const result = await f.broker.dispatch(inputFor(f, prompt))
  expect(result.status).toBe("completed")
  expect(result.targetWitness).toBeDefined()
  expect(() => f.broker.controller.bindNativeCampaignTargetReservation({
    ...context, targetPlan, reservation: f.reservation,
  })).toThrow()
  expect(plan.calls.run).toBe(1)
  expect(f.broker.controller.status().requestCounts.charged.target).toBe(1)
})

nativeTest("a copied reservation cannot receive a prospective target binding", async () => {
  const { f, context, targetPlan, prompt } = await targetPlanFixture()
  const plan = mockPlan(prompt)
  expect(() => f.broker.controller.bindNativeCampaignTargetReservation({
    ...context, targetPlan, reservation: { ...f.reservation },
  })).toThrow()
  expect(plan.calls.inspect).toBe(0)
  expect(plan.calls.run).toBe(0)
  expect(f.broker.controller.status().requestCounts.charged.target).toBe(1)
})

nativeTest("a genuine completed witness cannot substitute a different prompt for the planned fixture", async () => {
  const { f, context, target } = await targetWitnessFixture()
  const prompt = `Different synthetic task ${randomUUID()}`
  const plan = mockPlan(prompt)
  const result = await f.broker.dispatch(inputFor(f, prompt))
  expect(result.status).toBe("completed")
  expect(result.targetWitness).toBeDefined()
  expect(() => f.broker.controller.admitNativeCampaignTargetResponse({
    ...context, target, targetWitness: result.targetWitness!,
  })).toThrow()
  expect(plan.calls.run).toBe(1)
  expect(f.broker.controller.status().requestCounts.charged.target).toBe(1)
})

nativeTest("identical target prompts do not allow completed witnesses to cross broker owners", async () => {
  const first = await targetWitnessFixture()
  const firstPlan = mockPlan(first.prompt)
  const firstResult = await first.f.broker.dispatch(inputFor(first.f, first.prompt))
  expect(firstResult.status).toBe("completed")
  expect(firstResult.targetWitness).toBeDefined()
  const second = await targetWitnessFixture()
  expect(second.prompt).toBe(first.prompt)
  const secondPlan = mockPlan(second.prompt)
  const secondResult = await second.f.broker.dispatch(inputFor(second.f, second.prompt))
  expect(secondResult.status).toBe("completed")
  expect(secondResult.targetWitness).toBeDefined()
  expect(() => first.f.broker.controller.admitNativeCampaignTargetResponse({
    ...first.context, target: first.target, targetWitness: secondResult.targetWitness!,
  })).toThrow()
  expect(firstPlan.calls.run).toBe(1)
  expect(secondPlan.calls.run).toBe(1)
  expect(first.f.broker.controller.status().requestCounts.charged.target).toBe(1)
  expect(second.f.broker.controller.status().requestCounts.charged.target).toBe(1)
})

nativeTest("a completed optimizer witness cannot authorize target response artifacts", async () => {
  const { f, context, target, prompt } = await targetWitnessFixture()
  mockPlan(prompt)
  expect((await f.broker.dispatch(inputFor(f, prompt))).status).toBe("completed")
  const reservation = f.broker.controller.reserveRequest({
    owner: f.owner, runId: f.prepared.runId, current: f.current, role: "optimizer", phase: "train",
  })
  const plan = mockPlan(prompt)
  const result = await f.broker.dispatch(inputFor(f, prompt, { reservation, role: "optimizer" }))
  expect(result.status).toBe("completed")
  expect(result.optimizerWitness).toBeDefined()
  expect(result).not.toHaveProperty("targetWitness")
  expect(() => f.broker.controller.admitNativeCampaignTargetResponse({
    ...context, target, targetWitness: result.optimizerWitness as never,
  })).toThrow()
  expect(plan.calls.run).toBe(1)
})

nativeTest("only the frozen factory broker retains its runtime worktree identity", async () => {
  const f = await fixture()
  expect(Object.isFrozen(f.broker)).toBe(true)
  expect(getNativeSkillOptBrokerWorktree(f.broker)).toBe(realpathSync.native(f.root))
  expect(getNativeSkillOptBrokerWorktree({ ...f.broker })).toBeUndefined()
  expect(getNativeSkillOptBrokerWorktree(JSON.parse(JSON.stringify(f.broker)))).toBeUndefined()
  expect(Reflect.set(f.broker, "dispatch", async () => undefined)).toBe(false)
})

test("manual TTY-consented start is one-shot and persists the manual trigger without a fake arm", () => {
  if (!supportedNative) return
  // The actual terminal reader issued this fixture's consent; no production consent/test factory is involved.
  return fixture().then(async (f) => {
    const path = join(dirname(executionRunDirectory(f.root)), "skillopt", "automation", "ledger.sqlite")
    const db = new Database(path, { readonly: true, readwrite: false, create: false })
    try {
      expect(db.query("SELECT trigger_kind,arm_id FROM attempts WHERE run_id=?").get(f.reservation.runId))
        .toEqual({ trigger_kind: "manual", arm_id: null })
      expect(db.query("SELECT role,phase FROM requests WHERE request_id=?").get(f.reservation.requestId))
        .toEqual({ role: "target", phase: "train" })
      expect(db.query("SELECT COUNT(*) AS count FROM arms WHERE run_id=?").get(f.reservation.runId))
        .toEqual({ count: 0 })
    } finally { db.close() }
    expect(() => f.broker.controller.reserveManual({ owner: f.owner, prepared: f.prepared, consent: f.consent, current: f.current }))
      .toThrow()

    const prompt = `synthetic completed first request ${randomUUID()}`
    const plan = mockPlan(prompt)
    const firstResult = await f.broker.dispatch(inputFor(f, prompt))
    expect(firstResult.status).toBe("completed")
    expect(firstResult.targetWitness).toBeDefined()
    expect(Object.isFrozen(firstResult.targetWitness)).toBe(true)
    expect(Reflect.ownKeys(firstResult.targetWitness!)).toEqual([])
    expect(firstResult).not.toHaveProperty("optimizerWitness")
    expect(plan.calls.run).toBe(1)
    expect(f.broker.controller.status().pendingDispatch).toBe(false)
    f.broker.controller.finish(f.owner, f.reservation.runId, "CANCELLED")
    const nextPrepared = f.broker.controller.prepare({
      owner: f.owner, campaignId: `campaign_${randomUUID().replaceAll("-", "")}`,
      dataset: f.dataset, baselineSkillSha256: f.current.baselineSkillSha256,
    })
    if (nextPrepared.state !== "PREPARED") throw new Error("second synthetic campaign was not prepared")
    const nextReceipt = await withTerminalLine(`APPROVE ${nextPrepared.runId} ${nextPrepared.consentBindingSha256}`, () =>
      humanDecision("approve", nextPrepared.decisionBinding))
    const nextConsent = f.broker.controller.consent(nextPrepared, nextReceipt, f.current)
    expect(() => f.broker.controller.reserveManual({ owner: f.owner, prepared: nextPrepared, consent: nextConsent, current: f.current }))
      .toThrow("daily-limit")
  })
})

nativeTest("automatic first reservations also bind target/train and retain automatic trigger evidence", async () => {
  const f = await fixture("automatic")
  expect(f.reservation).toMatchObject({ role: "target", phase: "train" })
  const path = join(dirname(executionRunDirectory(f.root)), "skillopt", "automation", "ledger.sqlite")
  const db = new Database(path, { readonly: true, readwrite: false, create: false })
  try {
    expect(db.query("SELECT trigger_kind,arm_id FROM attempts WHERE run_id=?").get(f.reservation.runId))
      .toMatchObject({ trigger_kind: "automatic" })
    expect(db.query("SELECT role,phase FROM requests WHERE request_id=?").get(f.reservation.requestId))
      .toEqual({ role: "target", phase: "train" })
  } finally { db.close() }
})

async function baselineReflactFlow(trigger: "manual" | "automatic"): Promise<void> {
  const f = await fixture(trigger)
  expect(f.reservation).toMatchObject({ role: "target", phase: "train" })
  const caseId = "same-case-empty-fragment"
  const firstObservation = { caseId, answer: "synthetic baseline A" }
  const secondObservation = { caseId, answer: "synthetic baseline B" }
  const firstPrompt = `synthetic baseline target train ${randomUUID()}`
  const first = mockPlan(firstPrompt, { run: () => ({ status: "completed", text: JSON.stringify(firstObservation), quiescent: true, usage: { inputTokens: 0, outputTokens: 0 } }) })
  const result = await f.broker.dispatch(inputFor(f, firstPrompt))
  expect(result).toMatchObject({ requestId: f.reservation.requestId, status: "completed", text: JSON.stringify(firstObservation), usage: { inputTokens: 0, outputTokens: 0 } })
  expect(first.calls.run).toBe(1)
  expect(first.calls.inspect).toBe(1) // the --version identity probe is not an inference
  const stored = f.runtime.runs.status().executions.find((record) => record.executionId === f.reservation.requestId)
  expect(stored).toMatchObject({
    executionId: f.reservation.requestId, ownerSession: f.owner.sessionID, role: "target", engine: "claude",
    profile: "legacy-unowned", controlProfile: "estimated-input-reactive-output-v1", nativeExecution: true,
    vendorRef: JSON.stringify({ executionID: f.reservation.requestId }), boundaryRef: { executionID: f.reservation.requestId },
    hostDispatch: "started",
  })

  const baselineReservation = f.broker.controller.reserveRequest({ owner: f.owner, runId: f.reservation.runId, current: f.current, role: "target", phase: "train" })
  const baselinePrompt = `synthetic second baseline target train ${randomUUID()}`
  const second = mockPlan(baselinePrompt, { run: () => ({ status: "completed", text: JSON.stringify(secondObservation), quiescent: true }) })
  const secondResult = await f.broker.dispatch({ owner: f.owner, reservation: baselineReservation, getCurrent: () => f.current,
    role: "target", phase: "train", prompt: baselinePrompt })
  expect(secondResult).toMatchObject({ status: "completed", text: JSON.stringify(secondObservation), usage: null })
  expect(second.calls.run).toBe(1)

  const reactReservation = f.broker.controller.reserveRequest({ owner: f.owner, runId: f.reservation.runId, current: f.current, role: "optimizer", phase: "train" })
  const reactPrompt = JSON.stringify({ task: "ReflACT", caseId, emptyFragment: "", baselineObservations: [JSON.parse(result.text!), JSON.parse(secondResult.text!)] })
  const react = mockPlan(reactPrompt)
  const reactResult = await f.broker.dispatch({ owner: f.owner, reservation: reactReservation, getCurrent: () => f.current,
    role: "optimizer", phase: "train", prompt: reactPrompt })
  expect(reactResult.requestId).toBe(reactReservation.requestId)
  expect(reactResult).not.toHaveProperty("targetWitness")
  expect(reactResult.optimizerWitness).toBeDefined()
  expect(Object.isFrozen(reactResult.optimizerWitness)).toBe(true)
  expect(Reflect.ownKeys(reactResult.optimizerWitness!)).toEqual([])
  expect(react.calls.run).toBe(1)
  expect(react.calls.inspect).toBe(1)
  expect(f.broker.controller.status().requestCounts.dispatched.target).toBe(2)
  expect(f.broker.controller.status().requestCounts.dispatched.optimizer).toBe(1)
}

nativeTest("manual start routes two observed baseline train results to one same-case empty-fragment ReflACT request", async () => {
  await baselineReflactFlow("manual")
})

nativeTest("automatic start routes two observed baseline train results to one same-case empty-fragment ReflACT request", async () => {
  await baselineReflactFlow("automatic")
})

nativeTest("unsafe optimizer completions never mint target or optimizer response witnesses", async () => {
  const f = await fixture()
  const warmupPrompt = `Synthetic warmup ${randomUUID()}`
  mockPlan(warmupPrompt)
  expect((await f.broker.dispatch(inputFor(f, warmupPrompt))).status).toBe("completed")
  const reservation = f.broker.controller.reserveRequest({
    owner: f.owner, runId: f.prepared.runId, current: f.current, role: "optimizer", phase: "train",
  })
  const prompt = `Synthetic optimizer ${randomUUID()}`
  const plan = mockPlan(prompt, {
    run: () => ({ status: "completed", text: "password=long-secret-value", quiescent: true }),
  })
  const result = await f.broker.dispatch(inputFor(f, prompt, { reservation, role: "optimizer" }))
  expect(result).toMatchObject({ requestId: reservation.requestId, status: "failed", errorCode: "unsafe_response" })
  expect(result).not.toHaveProperty("text")
  expect(result).not.toHaveProperty("targetWitness")
  expect(result).not.toHaveProperty("optimizerWitness")
  expect(plan.calls.run).toBe(1)
  expect(f.broker.controller.status().pendingDispatch).toBe(false)
  expect(f.runtime.runs.status().claim).toBeUndefined()
})

nativeTest("manual and automatic first-ticket role/phase mismatches never reach native run", async () => {
  for (const trigger of ["manual", "automatic"] as const) {
    for (const mismatch of [
      { role: "optimizer" as const, phase: "train" as const },
      { role: "target" as const, phase: "dev" as const },
    ]) {
      const f = await fixture(trigger)
      expect(f.reservation).toMatchObject({ role: "target", phase: "train" })
      const prompt = `${trigger} first-ticket mismatch ${mismatch.role}/${mismatch.phase} ${randomUUID()}`
      const plan = mockPlan(prompt)
      const forgedReservation = { ...f.reservation, role: mismatch.role, phase: mismatch.phase }
      let caught: unknown
      try {
        await f.broker.dispatch(inputFor(f, prompt, {
          reservation: forgedReservation as NativeSkillOptDispatchInput["reservation"],
          role: mismatch.role, phase: mismatch.phase,
        }))
      } catch (error) { caught = error }
      expectBrokerError(caught, "dispatch_not_authorized")
      expect(plan.calls.run).toBe(0)
    }
  }
})

nativeTest("denied request ids do not accumulate and the controller rejects replay of a consumed ticket", async () => {
  const f = await fixture()
  const countsBefore = f.broker.controller.status().requestCounts
  const remainingBefore = f.broker.controller.status().remaining
  const releasedOwner = attachAdmission(f.runtime, `released_${randomUUID().replaceAll("-", "")}`, {
    engine: "codex", model: models.generator.requestedModel,
  })
  releasedOwner.release({
    workflowQuiescent: true, evidence: "synthetic denied-dispatch fixture has no execution", workflowID: null, revision: null,
  })

  for (let attempt = 0; attempt < 1025; attempt += 1) {
    const prompt = `released-owner denied attempt ${attempt}`
    const reservation = { ...f.reservation, reservationId: randomUUID(), requestId: randomUUID() }
    let caught: unknown
    try {
      await f.broker.dispatch(inputFor(f, prompt, { owner: releasedOwner, reservation }))
    } catch (error) { caught = error }
    expectBrokerError(caught, "owner_unavailable")
  }

  expect(f.broker.controller.status().requestCounts).toEqual(countsBefore)
  expect(f.broker.controller.status().remaining).toEqual(remainingBefore)
  expect(f.runtime.runs.status().executions).toHaveLength(0)

  const prompt = `valid request after denied attempts ${randomUUID()}`
  const plan = mockPlan(prompt)
  const result = await f.broker.dispatch(inputFor(f, prompt))
  expect(result.status).toBe("completed")
  expect(plan.calls.run).toBe(1)

  const replayPrompt = `consumed ticket replay ${randomUUID()}`
  const replayPlan = mockPlan(replayPrompt)
  let replayError: unknown
  try { await f.broker.dispatch(inputFor(f, replayPrompt)) }
  catch (error) { replayError = error }
  expectBrokerError(replayError, "dispatch_not_authorized")
  expect(replayPlan.calls.inspect).toBe(1)
  expect(replayPlan.calls.run).toBe(0)
  expect(plan.calls.run).toBe(1)
})

nativeTest("secret prompts and optimizer input over 96 KiB are rejected before transport or dispatch", async () => {
  const secret = await fixture()
  const secretPrompt = "password=long-secret-value"
  const secretPlan = mockPlan(secretPrompt)
  let caught: unknown
  try { await secret.broker.dispatch(inputFor(secret, secretPrompt)) }
  catch (error) { caught = error }
  expectBrokerError(caught, "sensitive_input")
  expect(secretPlan.calls.inspect).toBe(0)
  expect(secretPlan.calls.run).toBe(0)
  expect(secret.broker.controller.status().requestCounts.dispatched.target).toBe(0)

  const optimizer = await fixture()
  const baselinePrompt = `synthetic baseline before optimizer bound ${randomUUID()}`
  const baselinePlan = mockPlan(baselinePrompt)
  const baselineResult = await optimizer.broker.dispatch(inputFor(optimizer, baselinePrompt))
  expect(baselineResult.status).toBe("completed")
  expect(baselinePlan.calls.run).toBe(1)
  const reservation = optimizer.broker.controller.reserveRequest({ owner: optimizer.owner, runId: optimizer.reservation.runId,
    current: optimizer.current, role: "optimizer", phase: "train" })
  const oversizedPrompt = "x".repeat(NATIVE_DATASET_LIMITS.optimizerInputBytes + 1)
  const oversizedPlan = mockPlan(oversizedPrompt)
  caught = undefined
  try {
    await optimizer.broker.dispatch({ owner: optimizer.owner, reservation, getCurrent: () => optimizer.current,
      role: "optimizer", phase: "train", prompt: oversizedPrompt })
  } catch (error) { caught = error }
  expectBrokerError(caught, "invalid_request")
  expect(oversizedPlan.calls.inspect).toBe(0)
  expect(oversizedPlan.calls.run).toBe(0)
  expect(optimizer.broker.controller.status().requestCounts.dispatched.optimizer).toBe(0)
})

nativeTest("secret or malformed UTF-16 completed output settles charged and never returns raw text", async () => {
  const responses = [
    { text: "password=long-secret-value", usage: { inputTokens: 0, outputTokens: 0 } },
    { text: "malformed-\ud800-output", usage: undefined },
  ] as const
  for (const response of responses) {
    const f = await fixture()
    const prompt = `synthetic unsafe response ${randomUUID()}`
    const plan = mockPlan(prompt, { run: () => ({ status: "completed", text: response.text, quiescent: true, usage: response.usage }) })
    const result = await f.broker.dispatch(inputFor(f, prompt))
    expect(result).toMatchObject({ requestId: f.reservation.requestId, status: "failed", errorCode: "unsafe_response" })
    expect(result).not.toHaveProperty("text")
    expect(result).not.toHaveProperty("targetWitness")
    expect(result).not.toHaveProperty("optimizerWitness")
    expect(JSON.stringify(result)).not.toContain("password=long-secret-value")
    expect(plan.calls.run).toBe(1)
    expect(plan.calls.reconcile).toBe(1)
    expect(f.broker.controller.status().requestCounts.charged.target).toBe(1)
    expect(f.broker.controller.status().requestCounts.dispatched.target).toBe(1)
    if (response.usage) expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    else expect(result.usage).toBeNull()
  }
})

nativeTest("the synchronous getCurrent callback is re-read after the async identity probe", async () => {
  const f = await fixture()
  const changedBindings: NativeModelBindings = {
    ...structuredClone(f.dataset.modelBindings),
    target: { ...f.dataset.modelBindings.target, requestedModel: "changed-after-probe" },
  }
  const changedDataset = createNativeDataset({
    root: f.root,
    selections: f.dataset.sourceManifest.entries.map(({ path }) => ({ path })),
    fixturePack: f.dataset.fixturePack,
    modelBindings: changedBindings,
  })
  let current = f.current
  let getCurrentCalls = 0
  const prompt = `synchronous getCurrent recheck ${randomUUID()}`
  const plan = mockPlan(prompt, { onInspect() { current = { dataset: changedDataset, baselineSkillSha256: f.current.baselineSkillSha256 } } })
  let caught: unknown
  try {
    await f.broker.dispatch(inputFor(f, prompt, { getCurrent: () => { getCurrentCalls += 1; return current } }))
  } catch (error) { caught = error }
  expectBrokerError(caught, "binding_drift")
  expect(plan.calls.inspect).toBe(1)
  expect(plan.calls.run).toBe(0)
  expect(getCurrentCalls).toBeGreaterThanOrEqual(2)
})

nativeTest("copied tickets, foreign owners, model/profile drift, source drift, and sealed holdout input dispatch zero inferences", async () => {
  const copied = await fixture()
  const copiedPrompt = `copied ticket ${randomUUID()}`
  const copiedPlan = mockPlan(copiedPrompt)
  const copiedReservation = { ...copied.reservation, ticket: { ...copied.reservation.ticket } }
  let caught: unknown
  try { await copied.broker.dispatch(inputFor(copied, copiedPrompt, { reservation: copiedReservation })) }
  catch (error) { caught = error }
  expectBrokerError(caught, "dispatch_not_authorized")
  expect(copiedPlan.calls.run).toBe(0)

  const foreign = await fixture()
  const otherOwner = attachAdmission(foreign.runtime, `foreign_${randomUUID().replaceAll("-", "")}`, {
    engine: "codex", model: models.generator.requestedModel,
  })
  const foreignPrompt = `foreign owner ${randomUUID()}`
  const foreignPlan = mockPlan(foreignPrompt)
  caught = undefined
  try { await foreign.broker.dispatch(inputFor(foreign, foreignPrompt, { owner: otherOwner })) }
  catch (error) { caught = error }
  expectBrokerError(caught, "dispatch_not_authorized")
  expect(foreignPlan.calls.run).toBe(0)
  try { otherOwner.release({ workflowQuiescent: true, evidence: "synthetic foreign-owner fixture completed without running a model", workflowID: null, revision: null }) }
  catch { /* Fixture cleanup still removes its isolated admission files. */ }

  const model = await fixture()
  const modelPrompt = `model drift ${randomUUID()}`
  const modelPlan = mockPlan(modelPrompt)
  const changedDataset = structuredClone(model.dataset)
  ;(changedDataset.modelBindings.target as { requestedModel: string }).requestedModel = "different-approved-model"
  caught = undefined
  try { await model.broker.dispatch(inputFor(model, modelPrompt, { getCurrent: () => ({ dataset: changedDataset, baselineSkillSha256: model.current.baselineSkillSha256 }) })) }
  catch (error) { caught = error }
  expectBrokerError(caught, "dataset_invalid")
  expect(modelPlan.calls.run).toBe(0)

  const profile = await fixture()
  const profilePrompt = `profile drift ${randomUUID()}`
  const wrongIdentity = identityFor("claude", models.target.requestedModel)!
  const profilePlan = mockPlan(profilePrompt, { identity: { ...wrongIdentity, profileIdentity: { ...wrongIdentity.profileIdentity, sha256: "f".repeat(64) } } })
  caught = undefined
  try { await profile.broker.dispatch(inputFor(profile, profilePrompt)) }
  catch (error) { caught = error }
  expectBrokerError(caught, "native_identity_unavailable")
  expect(profilePlan.calls.run).toBe(0)

  const data = await fixture()
  const dataPrompt = `source drift ${randomUUID()}`
  const dataPlan = mockPlan(dataPrompt)
  writeFileSync(data.absoluteSource, "mutated synthetic source\n")
  caught = undefined
  try { await data.broker.dispatch(inputFor(data, dataPrompt)) }
  catch (error) { caught = error }
  expect(caught).toBeInstanceOf(SkillOptBrokerError)
  expect(dataPlan.calls.run).toBe(0)

  const sealed = await fixture()
  const sealedPrompt = sealed.dataset.fixturePack.fixtures.find((item) => item.split === "final")!.sources[0]!.content
  const sealedPlan = mockPlan(sealedPrompt)
  const firstPrompt = `synthetic baseline before sealed optimizer input ${randomUUID()}`
  const firstPlan = mockPlan(firstPrompt)
  await sealed.broker.dispatch(inputFor(sealed, firstPrompt))
  expect(firstPlan.calls.run).toBe(1)
  const sharedEnumPrompt = "Use mark-unknown for an ungrounded assertion and preserve-existing for owned content."
  const sharedEnumPlan = mockPlan(sharedEnumPrompt)
  const optimizerReservation = sealed.broker.controller.reserveRequest({ owner: sealed.owner, runId: sealed.reservation.runId,
    current: sealed.current, role: "optimizer", phase: "train" })
  const sharedEnumResult = await sealed.broker.dispatch({ owner: sealed.owner, reservation: optimizerReservation,
    getCurrent: () => sealed.current, role: "optimizer", phase: "train", prompt: sharedEnumPrompt })
  expect(sharedEnumResult.status).toBe("completed")
  expect(sharedEnumPlan.calls.run).toBe(1)
  const holdoutOptimizerReservation = sealed.broker.controller.reserveRequest({ owner: sealed.owner, runId: sealed.reservation.runId,
    current: sealed.current, role: "optimizer", phase: "train" })
  caught = undefined
  try { await sealed.broker.dispatch({ owner: sealed.owner, reservation: holdoutOptimizerReservation, getCurrent: () => sealed.current,
    role: "optimizer", phase: "train", prompt: sealedPrompt }) }
  catch (error) { caught = error }
  expectBrokerError(caught, "invalid_request")
  expect(sealedPlan.calls.run).toBe(0)
})

nativeTest("cancellation waits for the owned handle and retains the execution fence when quiescence is unknown", async () => {
  const f = await fixture()
  const prompt = `nonquiescent synthetic request ${randomUUID()}`
  let started!: () => void
  let resolveRun!: (result: CliTransportResult) => void
  let cancelled!: () => void
  const runStarted = new Promise<void>((resolve) => { started = resolve })
  const cancelStarted = new Promise<void>((resolve) => { cancelled = resolve })
  const plan = mockPlan(prompt, {
    run: () => new Promise<CliTransportResult>((resolve) => { resolveRun = resolve; started() }),
    onCancel: () => cancelled(),
    reconcile: () => ({ outcome: "running", quiescent: false, evidence: "scripted nonquiescence" }),
    cancelResult: { requested: true, acknowledged: true, terminal: false, quiescent: false },
  })
  const dispatch = f.broker.dispatch(inputFor(f, prompt))
  await runStarted
  const cancelling = f.broker.cancel(f.owner, f.reservation.requestId)
  await cancelStarted
  resolveRun({ status: "unresolved", text: "", quiescent: false })
  const cancelResult = await cancelling
  expect(cancelResult).toMatchObject({ requestId: f.reservation.requestId, state: "unresolved", requested: true, acknowledged: true })
  let caught: unknown
  try { await dispatch } catch (error) { caught = error }
  expectBrokerError(caught, "execution_unresolved")
  expect(plan.calls.run).toBe(1)
  expect(plan.calls.cancel).toBe(1)
  expect(f.runtime.runs.status().claim).toBeDefined()
  const persisted = f.runtime.runs.status().executions.find((record) => record.executionId === f.reservation.requestId)
  expect(persisted?.fence).toBeDefined()
  expect(persisted?.cancel).toMatchObject({ acknowledgedAt: expect.any(Number) })
  expect(persisted?.reconciliation).toMatchObject({ outcome: "running", quiescent: false })
  let replayError: unknown
  try { await f.broker.dispatch(inputFor(f, `unresolved replay ${randomUUID()}`)) }
  catch (error) { replayError = error }
  expectBrokerError(replayError, "dispatch_not_authorized")
  expect(plan.calls.run).toBe(1)
})
