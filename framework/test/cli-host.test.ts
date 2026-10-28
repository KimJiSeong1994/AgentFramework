import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { consumeCliSkillLoaderCompletion, SKILL_CATALOG_LIMIT, SKILL_DROPPED_RESULT, roleInputLimit, createCliHost, fitHistory, type CliToolOutcomeFact } from "../src/hosts/cli-host.ts"
import { assertHostAdmission } from "../src/hosts/required-controls.ts"
import { createCliTransport, type CliNativeIdentity, type CliTransportHandle, type CliTransportOptions } from "../src/hosts/cli-transport.ts"
import type { ActionGate, ChatAction, ComboRoutes, ExecutionPolicy, ExecutionPolicyHandlers, ExecutionRequest, ExecutionRole, SkillToolProvider } from "../src/hosts/types.ts"
import type { ModelApiAction, ModelApiInput } from "../src/hosts/model-api.ts"
import type { ExecutionRunStore, ExecutionRunStatus } from "../src/hosts/run-state.ts"
import type { CliHostActivity } from "../src/hosts/cli-progress.ts"
import { estimateTokens } from "../src/tokens.ts"
import { CODEX_INSTRUCTIONS, createCodexProfile } from "../src/hosts/codex-profile.ts"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { loadConfig } from "../src/config.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import {
  consumeSkillLoaderWitness, finishSkillInvocation, registerSkillLoaderWitness,
  bindSkillInvocation, type SkillInvocationContext, type SkillLoaderCanaryBinding,
} from "../src/skills/context.ts"
import {
  NATIVE_PROTOCOL_SHA256, NATIVE_WIKI_OUTPUT_SCHEMA, type NativeWikiFixture,
} from "../src/skillopt/dataset.ts"
import {
  buildNativeEvaluationPrompt, NATIVE_EVALUATION_PROTOCOL_SHA256, NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA,
  scoreNativeFixtureResponse,
} from "../src/skillopt/evaluation.ts"
import {
  completeNativeSkillLoadWitness, prepareNativeSkillLoadCanary, registerNativeSkillLoadWitness, verifyNativeSkillLoadVerificationProof,
  type NativeSkillLoadCanaryPlan,
} from "../src/skillopt/load-verification.ts"
import { canonicalJson, sha256 } from "../src/skillopt/pilot.ts"
import type { PromotionBindings } from "../src/skillopt/promotion.ts"
import { resolveSkillRoots } from "../src/skills/roots.ts"
import { SkillSession } from "../src/skills/session.ts"
import { makeSkillOptCanaryFixture } from "./skillopt-canary-fixtures.ts"

const CONTROL_PROFILE = "estimated-input-reactive-output-v1" as const
const ALL_TOOLS = ["read", "list", "glob", "grep", "write", "edit"]
const OWNER = "test-owner"
const EXECUTION = "test-execution"
const WORKER_INPUT_LIMIT = 5120
const HISTORY_TRUNCATION_MARKER = "\n[older tool output truncated to fit the estimated input budget]"
const WITNESS_MODEL = "gpt-5.6-sol"
const WITNESS_SKILL_TEXT = "---\nname: llm-wiki\ndescription: Use project wiki guidance\nallowed-tools: [read]\n---\nUse the captured wiki instructions exactly.\r\n"
const REAL_GIT = Bun.which("git")
let cachedWitnessCanary: Readonly<{ taskText: string; binding: Readonly<{
  fixturePackSha256: string; fixtureId: string; fixtureSha256: string; taskSha256: string
  evaluatorPromptSha256: string; evaluatorSystemSha256: string; protocolSha256: string; evaluatorSha256: string
}>; systemInstructions: string
}> | undefined

function witnessCanary() {
  if (cachedWitnessCanary) return cachedWitnessCanary
  const fixture = makeSkillOptCanaryFixture()
  const evaluatorPrompt = buildNativeEvaluationPrompt(fixture.fixture, WITNESS_SKILL_TEXT)
  const systemPrefix = `${WITNESS_SKILL_TEXT}\n\n`
  if (!evaluatorPrompt.system.startsWith(systemPrefix)) throw new Error("Synthetic evaluator prompt has an unexpected skill prefix")
  const systemInstructions = evaluatorPrompt.system.slice(systemPrefix.length)
  const taskText = evaluatorPrompt.user
  cachedWitnessCanary = Object.freeze({
    taskText,
    systemInstructions,
    binding: Object.freeze({
      fixturePackSha256: fixture.packSha256,
      fixtureId: fixture.fixture.id,
      fixtureSha256: fixture.fixtureSha256,
      taskSha256: sha256(taskText),
      evaluatorPromptSha256: evaluatorPrompt.promptSha256,
      evaluatorSystemSha256: sha256(systemInstructions),
      protocolSha256: NATIVE_PROTOCOL_SHA256,
      evaluatorSha256: NATIVE_EVALUATION_PROTOCOL_SHA256,
    }),
  })
  return cachedWitnessCanary
}

function prepareMockNativeCanary(nativeRuntime: Readonly<{ version: string; executableSha256: string }>): Readonly<{
  plan: NativeSkillLoadCanaryPlan
  fixture: NativeWikiFixture
  canary: ReturnType<typeof witnessCanary>
  bindings: PromotionBindings
  projectRootSha256: string
  expectedFileSha256: string
}> {
  const fixturePack = makeSkillOptCanaryFixture()
  const profile = createCodexProfile(WITNESS_MODEL)
  const targetSkillBytes = Buffer.from(WITNESS_SKILL_TEXT, "utf8")
  const bindings: PromotionBindings = {
    witnessMode: "native",
    runId: "synthetic-test-run",
    rootBinding: sha256(`root:${realpathSync.native(root)}`),
    sourceSha256: sha256("synthetic source binding"),
    originalSha256: sha256(targetSkillBytes),
    candidateSha256: sha256(targetSkillBytes),
    fixturePackSha256: fixturePack.packSha256,
    canaryFixtureSha256: fixturePack.fixtureSha256,
    protocolSha256: NATIVE_PROTOCOL_SHA256,
    evaluatorSha256: NATIVE_EVALUATION_PROTOCOL_SHA256,
    runtimeSha256: sha256("synthetic runtime binding"),
    resultsSha256: sha256("synthetic results binding"),
    witnessSha256: sha256("synthetic witness binding"),
    nativeEngine: "codex",
    nativeModel: WITNESS_MODEL,
    nativeProfileId: "codex-restricted-read.v1",
    nativeProfileSha256: profile.catalogHash,
    nativeRuntimeVersion: nativeRuntime.version,
    nativeExecutableSha256: nativeRuntime.executableSha256,
  }
  const plan = prepareNativeSkillLoadCanary({
    fixturePack: fixturePack.pack,
    fixtureId: fixturePack.fixture.id,
    approvedFixtureSha256: fixturePack.fixtureSha256,
    targetSkillBytes,
    projectRoot: realpathSync.native(root),
    bindings,
    operation: "apply",
  })
  const binding: SkillLoaderCanaryBinding = Object.freeze({
    fixturePackSha256: plan.fixturePackSha256,
    fixtureId: plan.fixtureId,
    fixtureSha256: plan.fixtureSha256,
    taskSha256: plan.taskSha256,
    evaluatorPromptSha256: plan.evaluatorPromptSha256,
    evaluatorSystemSha256: plan.evaluatorSystemSha256,
    protocolSha256: plan.protocolSha256,
    evaluatorSha256: plan.evaluatorSha256,
  })
  const canary: ReturnType<typeof witnessCanary> = Object.freeze({
    taskText: plan.taskText,
    systemInstructions: plan.systemInstructions,
    binding,
  })
  return Object.freeze({
    plan,
    fixture: fixturePack.fixture,
    canary,
    bindings,
    projectRootSha256: sha256(realpathSync.native(root)),
    expectedFileSha256: sha256(targetSkillBytes),
  })
}

function successfulSyntheticCanaryResponse(fixture: NativeWikiFixture): string {
  const writes = fixture.outputSlots.map(slot => {
    const ownership = fixture.assertions.ownership.find(item => item.slotId === slot.id)
    const action = ownership?.expected === "preserve-existing" ? "preserve"
      : ownership?.expected === "reject-unowned" ? "reject" : "append"
    const facts = action === "append" ? fixture.assertions.facts
      .filter(item => item.slotId === slot.id)
      .map(item => ({ statement: item.statement, citations: [...item.sourceIds].sort() }))
      .sort((left, right) => left.statement.localeCompare(right.statement)) : []
    const factsById = new Map(fixture.assertions.facts.map(item => [item.id, item]))
    const contradictions = action === "append" ? fixture.assertions.contradictions
      .filter(item => factsById.get(item.leftFactId)?.slotId === slot.id)
      .map(item => {
        const [leftStatement, rightStatement] = [factsById.get(item.leftFactId)!.statement, factsById.get(item.rightFactId)!.statement].sort()
        return { leftStatement, rightStatement, resolution: item.expected }
      })
      .sort((left, right) => `${left.leftStatement}:${left.rightStatement}`.localeCompare(`${right.leftStatement}:${right.rightStatement}`)) : []
    return {
      slotId: slot.id,
      content: canonicalJson({ schema: NATIVE_WIKI_REFERENCE_ANSWER_SCHEMA, action, facts, contradictions }),
    }
  }).sort((left, right) => left.slotId.localeCompare(right.slotId))
  return canonicalJson({ schema: NATIVE_WIKI_OUTPUT_SCHEMA, writes })
}

type HistoryEntry = { assistant: string; ok: boolean; result: string }

function estimatedTokens(text: string): number {
  return 64 + estimateTokens(text)
}

function historyPrompt(base: string, history: readonly HistoryEntry[]): string {
  if (history.length === 0) return base
  const transcript = history.map((entry, index) =>
    `Exchange ${index + 1}\nAssistant tool envelope: ${entry.assistant}\nLCA tool result: ${JSON.stringify({ ok: entry.ok, [entry.ok ? "result" : "error"]: entry.result })}`,
  ).join("\n\n")
  return `${base}\n\nEarlier tool transcript:\n${transcript}`
}

let root: string
let witnessSessions: SkillSession[] = []
let witnessContexts: SkillInvocationContext[] = []
let mockNativeCliPathRestores: Array<() => void> = []
let mockNativeCliDirectories: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otter-cli-host-"))
  witnessSessions = []
  witnessContexts = []
  mockNativeCliPathRestores = []
  mockNativeCliDirectories = []
})
afterEach(() => {
  for (const context of witnessContexts) finishSkillInvocation(context)
  for (const session of witnessSessions) session.close()
  for (const restore of mockNativeCliPathRestores.splice(0).reverse()) restore()
  for (const directory of mockNativeCliDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

function installMockCodexCli(): Readonly<{
  runtime: Readonly<{ version: string; executableSha256: string }>
  setResponse: (response: string) => void
  probes: () => Array<{ args: string[] }>
  invocations: () => Array<{ argv: string[]; prompt: string }>
}> {
  if (!REAL_GIT) throw new Error("Git executable is required for the native witness fixture")
  const gitExecutable = realpathSync.native(REAL_GIT)
  const bin = mkdtempSync(join(tmpdir(), "otter-mock-codex-"))
  mockNativeCliDirectories.push(bin)
  const executable = join(bin, "codex")
  symlinkSync(gitExecutable, join(bin, "git"))
  const responsePath = join(bin, "response.txt")
  const probePath = join(bin, "probes.jsonl")
  const invocationPath = join(bin, "invocations.jsonl")
  writeFileSync(responsePath, "{}")
  const source = `
const fs = require("node:fs")
let prompt = ""
;(async () => {
  for await (const chunk of process.stdin) prompt += chunk.toString("utf8")
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--version") {
    fs.appendFileSync(${JSON.stringify(probePath)}, JSON.stringify({ args }) + "\\n")
    process.stdout.write("codex-cli 0.163.0\\n")
    return
  }
  fs.appendFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ argv: args, prompt }) + "\\n")
  const response = fs.readFileSync(${JSON.stringify(responsePath)}, "utf8")
  const records = [
    { type: "thread.started", thread_id: "synthetic-thread" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: response } },
    { type: "turn.completed", usage: {} },
  ]
  process.stdout.write(records.map(record => JSON.stringify(record)).join("\\n") + "\\n")
})().catch(() => { process.exitCode = 1 })
`
  writeFileSync(executable, `#!${process.execPath}\n${source}\n`, { mode: 0o700 })
  chmodSync(executable, 0o700)
  const previousPath = process.env.PATH
  mockNativeCliPathRestores.push(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  })
  process.env.PATH = bin
  const readJsonLines = (path: string): unknown[] => existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
    : []
  return Object.freeze({
    runtime: Object.freeze({ version: "0.163.0", executableSha256: sha256(readFileSync(executable)) }),
    setResponse: (response: string) => writeFileSync(responsePath, response),
    probes: () => readJsonLines(probePath) as Array<{ args: string[] }>,
    invocations: () => readJsonLines(invocationPath) as Array<{ argv: string[]; prompt: string }>,
  })
}

type HarnessOptions = {
  engine?: "local" | "codex" | "claude"
  role?: ExecutionRole
  useRealTransport?: boolean
  transportOverride?: (options: CliTransportOptions) => CliTransportHandle
  responses?: string[]
  nativeFailure?: string
  taskText?: string
  maxOutputTokens?: number
  denyTool?: boolean
  throwBeforeTool?: boolean
  beforeToolEffect?: () => void
  cancelAssistant?: boolean
  afterNativeTurn?: () => void
  transportBehavior?: "normal" | "unresolved" | "throw"
  omitPreflight?: boolean
  preflightCompatible?: boolean
  preflightNonQuiescent?: boolean
  preflightPolicyHash?: string
  nativeContextIdentity?: string
  cancelRequestAccepted?: boolean
  cancelRequestDelayMs?: number
  deferTransportRun?: boolean
  beforeOutput?: () => void
  observeActivity?: (activity: CliHostActivity) => void
  recordOutcome?: (fact: CliToolOutcomeFact) => void
  tools?: readonly string[]
  omitNativeIdentity?: boolean
  nativeIdentityAfterRun?: CliNativeIdentity
}

function harness(options: HarnessOptions = {}) {
  const engine = options.engine ?? "local"
  const role = options.role ?? "worker"
  const model = engine === "codex" ? WITNESS_MODEL : "fixture-model"
  const codexProfile = engine === "codex" ? createCodexProfile(model) : undefined
  const nativeIdentity: CliNativeIdentity | undefined = engine === "local" ? undefined : Object.freeze({
    engine,
    requestedModel: model,
    runtimeIdentity: Object.freeze({
      version: engine === "codex" ? "0.163.0" : "2.1.27 (Claude Code)",
      executableSha256: "a".repeat(64),
    }),
    profileIdentity: Object.freeze({
      id: engine === "codex" ? "codex-restricted-read.v1" : "claude-native-no-tools.v1",
      sha256: codexProfile?.catalogHash ?? "b".repeat(64),
    }),
  })
  const executionID = `${EXECUTION}-${engine}-${role}`
  const taskID = "task"
  const attemptID = "attempt"
  const generation = 7
  const policyID = `policy-${role}`
  let snapshot = Object.freeze({
    id: policyID,
    role,
    model: Object.freeze({ providerID: engine, modelID: model }),
    maxOutputTokens: options.maxOutputTokens ?? 20_000,
    tools: Object.freeze({ allowed: Object.freeze([...(options.tools ?? ALL_TOOLS)]), denied: Object.freeze([] as string[]) }),
    system: Object.freeze([`fixed ${role} constraint`]),
    ...(codexProfile ? { nativeContext: Object.freeze({
      identity: options.nativeContextIdentity ?? codexProfile.catalogHash,
      instructions: codexProfile.instructions,
    }) } : {}),
    thinking: "inherit" as const,
  })
  let allowBeforeTool = !options.denyTool
  let beforeToolEffect = options.beforeToolEffect
  let preflightCompatible = options.preflightCompatible ?? true
  let preflightQuiescent = !options.preflightNonQuiescent
  let beforeOutput = options.beforeOutput
  let releaseTransportRun: (() => void) | undefined
  const transportRunGate = options.deferTransportRun ? new Promise<void>(resolve => { releaseTransportRun = resolve }) : undefined
  let onToolResult = (): void => {}
  let afterNativeTurn = options.afterNativeTurn
  const observed = { before: 0, results: 0, assistant: 0 }
  const handlers: ExecutionPolicyHandlers = {
    beforeTool(event) {
      observed.before++
      expect(event.sessionID).toBe(executionID)
      if (options.throwBeforeTool) throw new Error("private policy exception")
      beforeToolEffect?.()
      return allowBeforeTool ? { allow: true } : { allow: false, reason: "private denial reason" }
    },
    toolResult(event) {
      observed.results++
      onToolResult()
      return event.error === undefined ? { result: event.result } : { error: event.error }
    },
    assistantText() {
      observed.assistant++
      return { cancel: !!options.cancelAssistant }
    },
  }
  const policy = {
    resolve: () => snapshot,
    handlers: () => handlers,
    bindSession() {},
    unbindSession() {},
    handlersForSession: () => undefined,
    snapshotForSession: () => undefined,
  } as unknown as ExecutionPolicy

  const intent = {
    executionId: executionID,
    ownerSession: OWNER,
    taskId: taskID,
    attemptId: attemptID,
    generation,
    role,
    cwd: root,
    policyID,
    kind: "host" as const,
    engine,
    profile: "legacy-unowned" as const,
    controlProfile: CONTROL_PROFILE,
  }
  let state: ExecutionRunStatus = {
    generation,
    claim: { ownerSession: OWNER, instance: "test-instance", pid: process.pid, generation },
    executions: [intent],
  }
  const runs = { status: () => state } as unknown as ExecutionRunStore
  const transportCalls: CliTransportOptions[] = []
  const prompts: string[] = []
  const controls: Array<{ cancelCalls: number; runCalls: number; reconcileCalls: number; preflightCalls: number }> = []
  let identityInspectionCalls = 0
  const responses = [...(options.responses ?? [])]
  const createTransport = (transportOptions: CliTransportOptions): CliTransportHandle => {
    transportCalls.push(transportOptions)
    prompts.push(transportOptions.prompt)
    const control = { cancelCalls: 0, runCalls: 0, reconcileCalls: 0, preflightCalls: 0 }
    controls.push(control)
    const isFirstTransport = controls.length === 1
    let started = false
    let preflightStarted = false
    let finished = false
    const transport: CliTransportHandle = {
      async run() {
        started = true
        control.runCalls++
        await transportRunGate
        const response = responses.shift() ?? "{}"
        if (options.transportBehavior === "throw") throw new Error("fixture run failed")
        if (options.transportBehavior === "unresolved") return { status: "unresolved", text: response, quiescent: false }
        if (options.nativeFailure !== undefined) {
          finished = true
          return { status: "failed", text: response, quiescent: true, error: options.nativeFailure }
        }
        try {
          beforeOutput?.()
          transportOptions.onText?.(response)
        }
        catch {
          finished = true
          return { status: "failed", text: response, quiescent: true, error: "fixture callback refused" }
        }
        afterNativeTurn?.()
        finished = true
        return { status: "completed", text: response, quiescent: true }
      },
      async requestCancel() {
        control.cancelCalls++
        if (options.cancelRequestAccepted === false) {
          return { requested: false, acknowledged: false, terminal: false, quiescent: false, evidence: "fixture refused cancellation" }
        }
        if (preflightStarted && !started) {
          return {
            requested: true,
            acknowledged: true,
            terminal: preflightQuiescent,
            quiescent: preflightQuiescent,
            evidence: preflightQuiescent ? "fixture version probe quiescent" : "fixture version probe remains active",
          }
        }
        if (!started) {
          finished = true
          return { requested: true, acknowledged: true, terminal: true, quiescent: true, evidence: "fixture cancellation prevented launch" }
        }
        if (options.transportBehavior === "unresolved" || options.transportBehavior === "throw") {
          finished = true
          return { requested: true, acknowledged: true, terminal: false, quiescent: false, evidence: "fixture cancellation acknowledged; quiescence pending" }
        }
        if (options.cancelRequestDelayMs) await new Promise(resolve => setTimeout(resolve, options.cancelRequestDelayMs))
        return { requested: true, acknowledged: true, terminal: finished, quiescent: finished, evidence: "fixture current process cancelled" }
      },
      async reconcile() {
        control.reconcileCalls++
        if (preflightStarted && !started) {
          return {
            outcome: preflightQuiescent ? "terminal" : "unknown",
            quiescent: preflightQuiescent,
            evidence: preflightQuiescent ? "fixture version probe quiescent" : "fixture version probe remains active",
          }
        }
        if (!started) return { outcome: "terminal", quiescent: true, evidence: "fixture has not launched" }
        if (options.transportBehavior === "unresolved" || options.transportBehavior === "throw") {
          return { outcome: finished ? "terminal" : "unknown", quiescent: finished, evidence: "fixture current process state" }
        }
        return { outcome: finished ? "terminal" : "running", quiescent: finished, evidence: "fixture current process state" }
      },
    }
    if (engine === "codex" && !options.omitPreflight) {
      transport.preflight = async () => {
        control.preflightCalls++
        preflightStarted = options.preflightNonQuiescent === true && isFirstTransport
        return {
          compatible: preflightCompatible,
          nativePolicyHash: options.preflightPolicyHash ?? codexProfile?.catalogHash,
        }
      }
    }
    if (nativeIdentity && !options.omitNativeIdentity) {
      transport.inspectIdentity = async () => {
        identityInspectionCalls++
        return identityInspectionCalls === 1 ? nativeIdentity : options.nativeIdentityAfterRun ?? nativeIdentity
      }
    }
    return transport
  }
  const host = createCliHost({
    engine, model, policy, runs,
    loadLocalModel: () => loadConfig(root).local_model,
    ...(!options.useRealTransport ? { createTransport: options.transportOverride ?? createTransport } : {}),
    observeActivity: options.observeActivity,
    recordOutcome: options.recordOutcome,
  })
  const request: ExecutionRequest = {
    executionID,
    supervisorSessionID: OWNER,
    taskID,
    attemptID,
    generation,
    role,
    title: "Implement scoped fixture",
    cwd: root,
    text: options.taskText ?? "Create the requested file using only local tools.",
    deadlineAt: Date.now() + 10_000,
    policy: snapshot,
    handlers,
  }
  return {
    host,
    request,
    prompts,
    transportCalls,
    controls,
    observed,
    policy,
    setSystemInstruction(instruction: string) {
      snapshot = Object.freeze({ ...snapshot, system: Object.freeze([...snapshot.system, instruction]) })
      request.policy = snapshot
    },
    get identityInspectionCalls() { return identityInspectionCalls },
    get state() { return state },
    set state(value: ExecutionRunStatus) { state = value },
    set allowBeforeTool(value: boolean) { allowBeforeTool = value },
    set beforeToolEffect(value: (() => void) | undefined) { beforeToolEffect = value },
    set preflightCompatible(value: boolean) { preflightCompatible = value },
    set preflightQuiescent(value: boolean) { preflightQuiescent = value },
    set beforeOutput(value: (() => void) | undefined) { beforeOutput = value },
    releaseTransportRun() { releaseTransportRun?.(); releaseTransportRun = undefined },
    set onToolResult(value: () => void) { onToolResult = value },
    set afterNativeTurn(value: () => void) { afterNativeTurn = value },
  }
}

async function attachLlmWikiWitness(subject: ReturnType<typeof harness>, canary = witnessCanary(), plan?: NativeSkillLoadCanaryPlan) {
  if (!REAL_GIT) throw new Error("Git executable is required for the native witness fixture")
  const gitExecutable = realpathSync.native(REAL_GIT)
  root = realpathSync.native(root)
  const git = (args: string[]) => execFileSync(gitExecutable, args, {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: "pipe",
  })
  git(["init", "--quiet"])
  const instructions = WITNESS_SKILL_TEXT
  const directory = join(root, ".agents", "skills", "llm-wiki")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "SKILL.md"), instructions)
  git(["add", "--", ".agents/skills/llm-wiki/SKILL.md"])
  git(["-c", "user.name=CLI Host Fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "witness-fixture"])

  const policyModel = subject.request.policy.model
  if (!policyModel) throw new Error("Witness fixture requires an explicit model")
  const engine = policyModel.providerID === "claude" ? "claude" :
    policyModel.providerID === "codex" ? "codex" : "local"
  const model = policyModel.modelID
  const runtime = createCliRuntime({ worktree: root, engine, model })
  const store = attachAdmission(runtime, OWNER, { engine, model })
  const roots = await resolveSkillRoots({ projectRoot: root })
  const session = await SkillSession.create({ roots, store }, new AbortController().signal)
  witnessSessions.push(session)
  const prepared = await session.prepare("llm-wiki", new AbortController().signal)
  subject.setSystemInstruction(`${instructions}\n\n${canary.systemInstructions}`)
  const requestScope = {
    executionID: subject.request.executionID,
    supervisorSessionID: subject.request.supervisorSessionID,
    taskID: subject.request.taskID,
    attemptID: subject.request.attemptID,
    generation: subject.request.generation,
    role: subject.request.role,
    title: subject.request.title,
    cwd: subject.request.cwd,
    text: canary.taskText,
    deadlineAt: subject.request.deadlineAt,
    policy: subject.request.policy,
  }
  const bound = bindSkillInvocation(prepared, requestScope, subject.policy)
  witnessContexts.push(bound.context)
  subject.request.text = `Witness prefix: 한글🦦\n${canary.taskText}`
  subject.request.skillContext = bound.context
  subject.request.handlers = bound.handlers
  return {
    session, bound, observation: plan
      ? registerNativeSkillLoadWitness(bound.context, plan)
      : registerSkillLoaderWitness(bound.context, canary.binding, canary.systemInstructions), instructions,
    canary: canary.binding, taskText: canary.taskText, systemInstructions: canary.systemInstructions, request: subject.request,
  }
}

const toolWrite = (path: string, content: string): string => JSON.stringify({
  type: "tool", name: "write", input: { path, content },
})

describe("common CLI execution host", () => {
  test("local retention reloads between inference turns and null resets it", async () => {
    mkdirSync(join(root, ".otter"))
    const path = join(root, ".otter", "otter.jsonc")
    writeFileSync(path, JSON.stringify({ local_model: { keep_alive: "5m" } }))
    const subject = harness({ responses: [toolWrite("one.txt", "one"), JSON.stringify({ type: "final", text: "done" })], afterNativeTurn: () => {
      writeFileSync(path, JSON.stringify({ local_model: { keep_alive: null } }))
    } })
    const handle = await subject.host.prepare(subject.request)
    expect((await handle.run()).status).toBe("completed")
    expect(subject.transportCalls.map(call => call.localKeepAlive)).toEqual(["5m", undefined])
  })

  test("cloud inference ignores even invalid local config", async () => {
    mkdirSync(join(root, ".otter"))
    writeFileSync(join(root, ".otter", "otter.jsonc"), '{"local_model":{"keep_alive":"bad"}}')
    const subject = harness({ engine: "claude", responses: [JSON.stringify({ type: "final", text: "done" })] })
    expect((await (await subject.host.prepare(subject.request)).run()).status).toBe("completed")
    expect(subject.transportCalls[0]?.localKeepAlive).toBeUndefined()
  })

  test("preflight uses the injected transport factory without running inference", async () => {
    const subject = harness({ responses: [JSON.stringify({ type: "final", text: "still available" })] })
    const preflight = await subject.host.preflight(subject.host.identity.profile)
    expect(preflight.compatible).toBe(true)
    expect(subject.prompts).toEqual([""])
    expect(subject.controls[0]?.runCalls).toBe(0)

    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "completed", text: "still available" })
    expect(subject.controls[1]?.runCalls).toBe(1)
  })

  test("registered native loader witness captures the exact prompt sent through real transport to a synthetic mock CLI", async () => {
    const mockCli = installMockCodexCli()
    mockCli.setResponse(JSON.stringify({ type: "final", text: "fixture response" }))
    const subject = harness({ engine: "codex", role: "main", useRealTransport: true })
    const witness = await attachLlmWikiWitness(subject)
    const outcome = await (await subject.host.prepare(subject.request)).run()
    expect(outcome).toEqual({ status: "completed", text: "fixture response" })
    const invocations = mockCli.invocations()
    expect(invocations).toHaveLength(1)
    const probes = mockCli.probes()
    expect(probes.length).toBeGreaterThan(0)
    expect(probes.every(probe => JSON.stringify(probe.args) === JSON.stringify(["--version"]))).toBe(true)
    const prompt = invocations[0]!.prompt
    expect(invocations[0]!.argv[0]).toBe("exec")
    expect(invocations[0]!.argv).toContain(WITNESS_MODEL)
    const completion = consumeCliSkillLoaderCompletion(outcome)
    expect(completion).toMatchObject({
      status: "completed", quiescent: true, taskSha256: witness.canary.taskSha256,
      canary: witness.canary, responseText: "fixture response", responseSha256: sha256("fixture response"),
      responseBytes: Buffer.byteLength("fixture response", "utf8"),
    })
    expect(completion.requestTextSha256).toBe(sha256(subject.request.text))
    expect(completion.requestTextSha256).not.toBe(completion.taskSha256)
    expect(completion.promptSha256).toBe(sha256(prompt))
    expect(Object.isFrozen(completion)).toBe(true)
    expect(Object.isFrozen(completion.canary)).toBe(true)
    expect(Reflect.set(completion, "taskSha256", "0".repeat(64))).toBe(false)
    expect(Reflect.set(completion, "promptSha256", "0".repeat(64))).toBe(false)
    expect(() => consumeCliSkillLoaderCompletion({ ...outcome })).toThrow("copied")
    expect(() => consumeCliSkillLoaderCompletion({ ...outcome, text: "tampered response" })).toThrow("copied")
    expect(() => consumeCliSkillLoaderCompletion(outcome)).toThrow("already consumed")
    expect(prompt).toContain("Only these Otter tools may run: none.")
    expect(prompt).toContain(witness.instructions)
    expect(prompt).toContain(witness.systemInstructions)
    expect(prompt.indexOf(witness.systemInstructions)).toBe(prompt.lastIndexOf(witness.systemInstructions))

    const receipt = await consumeSkillLoaderWitness(witness.observation)
    const instructionOffset = prompt.indexOf(witness.instructions)
    expect(receipt.instructions.span.startByte).toBe(Buffer.byteLength(prompt.slice(0, instructionOffset), "utf8"))
    expect(receipt.instructions.span.endByte - receipt.instructions.span.startByte).toBe(Buffer.byteLength(witness.instructions, "utf8"))
    expect(receipt.instructions.evaluatorSystem.utf8Sha256).toBe(witness.canary.evaluatorSystemSha256)
    expect(receipt.instructions.evaluatorSystem.endByte - receipt.instructions.evaluatorSystem.startByte)
      .toBe(Buffer.byteLength(witness.systemInstructions, "utf8"))
    expect(receipt.requestTextSha256).toBe(sha256(subject.request.text))
    expect(receipt.native).toMatchObject({
      engine: "codex", profileIdentity: { id: "codex-restricted-read.v1" }, identityStable: true,
    })
    expect(receipt.native.identityBefore).toEqual(receipt.native.identityAfter)
    expect(receipt).toMatchObject({ loaderDelivery: "observed", behavioralCanary: "not-evaluated" })
  })

  test("synthetic native canary adapter binds a successful mock host completion without model evidence", async () => {
    const mockCli = installMockCodexCli()
    const nativeCanary = prepareMockNativeCanary(mockCli.runtime)
    const responseText = successfulSyntheticCanaryResponse(nativeCanary.fixture)
    expect(scoreNativeFixtureResponse(nativeCanary.fixture, responseText)).toMatchObject({ status: "valid", hardPass: true })
    mockCli.setResponse(JSON.stringify({ type: "final", text: responseText }))
    const subject = harness({ engine: "codex", role: "main", useRealTransport: true })
    const witness = await attachLlmWikiWitness(subject, nativeCanary.canary, nativeCanary.plan)
    const outcome = await (await subject.host.prepare(subject.request)).run()
    expect(outcome).toEqual({ status: "completed", text: responseText })

    const completed = await completeNativeSkillLoadWitness({
      plan: nativeCanary.plan,
      observation: witness.observation,
      hostCompletion: outcome,
    })
    expect(completed.record.canary).toMatchObject({
      split: "dev", status: "valid", hardPass: true, outputSha256: sha256(responseText),
    })
    expect(completed.record.invocation.requestTextSha256).toBe(sha256(subject.request.text))
    expect(completed.record.canary.taskSha256).toBe(nativeCanary.plan.taskSha256)
    expect(completed.record.prompt.evaluatorSystemSha256).toBe(nativeCanary.plan.evaluatorSystemSha256)
    expect(completed.sha256).toBe(sha256(completed.bytes))
    const verified = verifyNativeSkillLoadVerificationProof({
      proof: completed.proof,
      bytes: completed.bytes,
      bindings: nativeCanary.bindings,
      expectedFileSha256: nativeCanary.expectedFileSha256,
      projectRootSha256: nativeCanary.projectRootSha256,
      operation: "apply",
    })
    expect(verified).toBe(completed.record)
    expect(() => verifyNativeSkillLoadVerificationProof({
      proof: completed.proof,
      bytes: completed.bytes,
      bindings: nativeCanary.bindings,
      expectedFileSha256: nativeCanary.expectedFileSha256,
      projectRootSha256: nativeCanary.projectRootSha256,
      operation: "apply",
    })).toThrow("native-load-proof-invalid-or-consumed")
    await expect(completeNativeSkillLoadWitness({
      plan: nativeCanary.plan, observation: witness.observation, hostCompletion: outcome,
    })).rejects.toThrow("native-load-observation-does-not-match-plan")
    expect(mockCli.invocations()).toHaveLength(1)
  })

  test("copied, response-altered, and replayed completion objects cannot pass the native adapter", async () => {
    const mockCli = installMockCodexCli()
    const nativeCanary = prepareMockNativeCanary(mockCli.runtime)
    const responseText = successfulSyntheticCanaryResponse(nativeCanary.fixture)
    mockCli.setResponse(JSON.stringify({ type: "final", text: responseText }))
    const subject = harness({ engine: "codex", role: "main", useRealTransport: true })
    const witness = await attachLlmWikiWitness(subject, nativeCanary.canary, nativeCanary.plan)
    const outcome = await (await subject.host.prepare(subject.request)).run()
    expect(outcome.status).toBe("completed")
    const altered = { ...outcome, text: `${responseText} ` }
    await expect(completeNativeSkillLoadWitness({
      plan: nativeCanary.plan, observation: witness.observation, hostCompletion: altered,
    })).rejects.toThrow("copied, altered, unavailable, or already consumed")
    await expect(completeNativeSkillLoadWitness({
      plan: nativeCanary.plan, observation: witness.observation, hostCompletion: outcome,
    })).rejects.toThrow("native-load-observation-does-not-match-plan")
    expect(mockCli.invocations()).toHaveLength(1)
  })

  test("a valid but altered canary answer fails independently scored mock evaluation", async () => {
    const mockCli = installMockCodexCli()
    const nativeCanary = prepareMockNativeCanary(mockCli.runtime)
    const validResponse = successfulSyntheticCanaryResponse(nativeCanary.fixture)
    const alteredResponse = validResponse.replace(nativeCanary.fixture.assertions.facts[0]!.statement, "An unsupported synthetic assertion.")
    expect(scoreNativeFixtureResponse(nativeCanary.fixture, alteredResponse)).toMatchObject({ status: "valid", hardPass: false })
    mockCli.setResponse(JSON.stringify({ type: "final", text: alteredResponse }))
    const subject = harness({ engine: "codex", role: "main", useRealTransport: true })
    const witness = await attachLlmWikiWitness(subject, nativeCanary.canary, nativeCanary.plan)
    const outcome = await (await subject.host.prepare(subject.request)).run()
    expect(outcome).toEqual({ status: "completed", text: alteredResponse })
    await expect(completeNativeSkillLoadWitness({
      plan: nativeCanary.plan, observation: witness.observation, hostCompletion: outcome,
    })).rejects.toThrow("native-load-canary-not-passed")
    expect(mockCli.invocations()).toHaveLength(1)
  })

  test("registered witness runs through real transport without changing the fixed output policy", async () => {
    const mockCli = installMockCodexCli()
    mockCli.setResponse(JSON.stringify({ type: "final", text: "bounded response" }))
    const subject = harness({ engine: "codex", role: "main", maxOutputTokens: 20_000, useRealTransport: true })
    subject.request.deadlineAt = Date.now() + 600_000
    await attachLlmWikiWitness(subject)
    const outcome = await (await subject.host.prepare(subject.request)).run()
    expect(outcome).toEqual({ status: "completed", text: "bounded response" })
    expect(mockCli.invocations()).toHaveLength(1)
    expect(subject.request.policy.maxOutputTokens).toBe(20_000)
  })

  test("oversize witness prompts are refused before native transport preparation", async () => {
    const mockCli = installMockCodexCli()
    mockCli.setResponse(JSON.stringify({ type: "final", text: "must not dispatch" }))
    const subject = harness({ engine: "codex", role: "main", useRealTransport: true })
    await attachLlmWikiWitness(subject)
    subject.request.text += "x".repeat(64 * 1024)
    const outcome = await (await subject.host.prepare(subject.request)).run()
    expect(outcome).toMatchObject({ status: "failed", error: "skill loader witness prompt byte limit exceeded" })
    expect(mockCli.probes()).toHaveLength(0)
    expect(mockCli.invocations()).toHaveLength(0)
  })

  test("registered witness refuses an explicit injected transport override before provider invocation", async () => {
    const subject = harness({ engine: "claude", role: "main", responses: [JSON.stringify({ type: "final", text: "must not dispatch" })] })
    const witness = await attachLlmWikiWitness(subject)
    const outcome = await (await subject.host.prepare(subject.request)).run()
    expect(outcome).toMatchObject({ status: "failed", error: "skill loader witness transport override refused" })
    expect(subject.observed.assistant).toBe(0)
    expect(subject.transportCalls).toHaveLength(0)
    expect(subject.controls).toHaveLength(0)
    expect(subject.identityInspectionCalls).toBe(0)
    expect(() => consumeCliSkillLoaderCompletion(outcome)).toThrow("unavailable")
    await expect(consumeSkillLoaderWitness(witness.observation)).rejects.toThrow()
  })

  test("oversized witness responses fail the real transport output bound without qualifying completion", async () => {
    const mockCli = installMockCodexCli()
    mockCli.setResponse(JSON.stringify({ type: "final", text: "x".repeat(32 * 1024 + 1) }))
    const subject = harness({ engine: "codex", role: "main", useRealTransport: true })
    const witness = await attachLlmWikiWitness(subject)
    const outcome = await (await subject.host.prepare(subject.request)).run()
    expect(outcome).toMatchObject({ status: "failed", error: "output byte limit reached" })
    expect(mockCli.invocations()).toHaveLength(1)
    expect(() => consumeCliSkillLoaderCompletion(outcome)).toThrow("unavailable")
    await expect(consumeSkillLoaderWitness(witness.observation)).rejects.toThrow()
  })

  test("registered witness refuses a misbound real transport override without probing or dispatching", async () => {
    const mockCli = installMockCodexCli()
    mockCli.setResponse(JSON.stringify({ type: "final", text: "unexpected synthetic response" }))
    let overrideCalls = 0
    const subject = harness({
      engine: "codex",
      role: "main",
      transportOverride: transportOptions => {
        overrideCalls++
        return createCliTransport({
          ...transportOptions,
          prompt: `${transportOptions.prompt}\nmisbound transport prompt`,
          deadlineAt: transportOptions.deadlineAt + 1,
        })
      },
    })
    const witness = await attachLlmWikiWitness(subject)
    const outcome = await (await subject.host.prepare(subject.request)).run()
    expect(outcome).toMatchObject({ status: "failed", error: "skill loader witness transport override refused" })
    expect(overrideCalls).toBe(0)
    expect(mockCli.probes()).toHaveLength(0)
    expect(mockCli.invocations()).toHaveLength(0)
    expect(subject.transportCalls).toHaveLength(0)
    expect(() => consumeCliSkillLoaderCompletion(outcome)).toThrow("unavailable")
    await expect(consumeSkillLoaderWitness(witness.observation)).rejects.toThrow()
  })

  test("registered witness refuses local engines before transport inspection or inference", async () => {
    const local = harness({ engine: "local", role: "main", responses: [JSON.stringify({ type: "final", text: "must not dispatch" })] })
    await attachLlmWikiWitness(local)
    const localResult = await (await local.host.prepare(local.request)).run()
    expect(localResult).toMatchObject({ status: "failed", error: "skill loader witness pre-dispatch refused" })
    expect(local.controls[0]?.runCalls).toBe(0)
    expect(local.identityInspectionCalls).toBe(0)
  })

  test("witness tool envelopes from a synthetic mock CLI are refused before effects and do not trigger another dispatch", async () => {
    const mockCli = installMockCodexCli()
    mockCli.setResponse(toolWrite("must-not-exist.txt", "no effect"))
    let effects = 0
    const subject = harness({ engine: "codex", role: "main", beforeToolEffect: () => { effects++ }, useRealTransport: true })
    const witness = await attachLlmWikiWitness(subject)
    const outcome = await (await subject.host.prepare(subject.request)).run()
    expect(outcome).toMatchObject({ status: "failed", error: "skill loader witness refused a tool response before effects" })
    expect(mockCli.invocations()).toHaveLength(1)
    expect(effects).toBe(0)
    expect(existsSync(join(root, "must-not-exist.txt"))).toBe(false)
    expect(() => consumeCliSkillLoaderCompletion(outcome)).toThrow("unavailable")
    await expect(consumeSkillLoaderWitness(witness.observation)).rejects.toThrow("failed closed")
  })

  test("ordinary CLI turns do not opt into runtime identity inspection", async () => {
    const subject = harness({ engine: "codex", responses: [JSON.stringify({ type: "final", text: "ordinary" })] })
    const outcome = await (await subject.host.prepare(subject.request)).run()
    expect(outcome.status).toBe("completed")
    expect(() => consumeCliSkillLoaderCompletion(outcome)).toThrow("unavailable")
    expect(subject.identityInspectionCalls).toBe(0)
  })

  test("native failures preserve only exact allowlisted safe transport errors", async () => {
    const cases: Array<{ engine: "local" | "codex" | "claude"; nativeFailure: string; hostError: string }> = [
      { engine: "claude", nativeFailure: "Claude CLI login required; run claude auth login", hostError: "Claude CLI login required; run claude auth login" },
      { engine: "codex", nativeFailure: "Codex native profile verification failed", hostError: "Codex native profile verification failed" },
      { engine: "codex", nativeFailure: "Codex private profile state verification failed", hostError: "Codex native profile verification failed" },
      { engine: "codex", nativeFailure: "native runtime identity verification failed", hostError: "native runtime identity verification failed" },
      { engine: "claude", nativeFailure: "native runtime identity verification failed", hostError: "native runtime identity verification failed" },
      { engine: "claude", nativeFailure: "native tool activity refused", hostError: "native tool activity refused" },
      { engine: "local", nativeFailure: "execution deadline elapsed", hostError: "execution deadline elapsed" },
      { engine: "local", nativeFailure: "output byte limit reached", hostError: "output byte limit reached" },
      { engine: "claude", nativeFailure: "invalid native CLI output", hostError: "invalid native CLI output" },
      { engine: "claude", nativeFailure: "native CLI result incomplete", hostError: "native CLI result incomplete" },
      { engine: "codex", nativeFailure: "native CLI reported failure", hostError: "native CLI reported failure" },
      { engine: "local", nativeFailure: "native CLI process failed", hostError: "native CLI process failed" },
    ]
    for (const { engine, nativeFailure, hostError } of cases) {
      const subject = harness({ engine, nativeFailure })
      const outcome = await (await subject.host.prepare(subject.request)).run()
      expect(outcome).toEqual({ status: "failed", error: hostError })
    }

    const secret = "PRIVATE_TOKEN /home/private/model-cache"
    const unknown = harness({ nativeFailure: secret })
    const outcome = await (await unknown.host.prepare(unknown.request)).run()
    expect(outcome).toEqual({ status: "failed", error: "CLI inference turn failed or exceeded its output bound" })
    expect(JSON.stringify(outcome)).not.toContain(secret)

    const wrongEngine = harness({ engine: "local", nativeFailure: "Claude CLI login required; run claude auth login" })
    expect(await (await wrongEngine.host.prepare(wrongEngine.request)).run()).toEqual({
      status: "failed", error: "CLI inference turn failed or exceeded its output bound",
    })
  })

  test("host progress reports bounded model and allowed-tool activity without content", async () => {
    const allowedPath = "allowed-private-path.txt"
    const toolPath = "missing-private-path.txt"
    const toolContent = "TOOL_OUTPUT_SECRET_5c21"
    const modelContent = "MODEL_RESPONSE_SECRET_7b4e"
    writeFileSync(join(root, allowedPath), toolContent)
    const activities: CliHostActivity[] = []
    const subject = harness({
      role: "reviewer",
      responses: [
        JSON.stringify({ type: "tool", name: "read", input: { path: allowedPath } }),
        JSON.stringify({ type: "tool", name: "read", input: { path: toolPath } }),
        JSON.stringify({ type: "final", text: modelContent }),
      ],
      observeActivity: activity => activities.push(activity),
    })
    const handle = await subject.host.prepare(subject.request)

    expect(await handle.run()).toEqual({ status: "completed", text: modelContent })
    const execution = activities[0]!.execution
    expect(Number.isSafeInteger(execution)).toBe(true)
    expect(execution).toBeGreaterThan(0)
    expect(execution).toBeLessThanOrEqual(1_000_000)
    const modelReturns = activities.filter(activity => activity.kind === "model-returned")
    expect(modelReturns.map(activity => activity.toolRound)).toEqual([0, 1, 2])
    expect(modelReturns.map(activity => activity.inputChars)).toEqual(subject.prompts.map(prompt => prompt.length))
    for (const activity of modelReturns) {
      expect(Number.isSafeInteger(activity.durationMs)).toBe(true)
      expect(activity.durationMs!).toBeGreaterThanOrEqual(0)
    }
    expect(activities.map(activity => activity.kind === "model-returned"
      ? { kind: activity.kind, role: activity.role, execution: activity.execution, status: activity.status } : activity)).toEqual([
      { kind: "model-started", role: "reviewer", execution, engine: "local", model: "fixture-model" },
      { kind: "model-returned", role: "reviewer", execution, status: "completed" },
      { kind: "tool-started", role: "reviewer", execution, taskID: subject.request.taskID, executionID: subject.request.executionID, callID: `${subject.request.executionID}:tool:1`, tool: "read" },
      { kind: "tool-finished", role: "reviewer", execution, taskID: subject.request.taskID, executionID: subject.request.executionID, callID: `${subject.request.executionID}:tool:1`, tool: "read", outcome: "succeeded", ok: true },
      { kind: "model-started", role: "reviewer", execution, engine: "local", model: "fixture-model" },
      { kind: "model-returned", role: "reviewer", execution, status: "completed" },
      { kind: "tool-started", role: "reviewer", execution, taskID: subject.request.taskID, executionID: subject.request.executionID, callID: `${subject.request.executionID}:tool:2`, tool: "read" },
      { kind: "tool-finished", role: "reviewer", execution, taskID: subject.request.taskID, executionID: subject.request.executionID, callID: `${subject.request.executionID}:tool:2`, tool: "read", outcome: "failed", ok: false },
      { kind: "model-started", role: "reviewer", execution, engine: "local", model: "fixture-model" },
      { kind: "model-returned", role: "reviewer", execution, status: "completed" },
    ])
    const progress = JSON.stringify(activities)
    expect(progress).not.toContain(allowedPath)
    expect(progress).not.toContain(toolPath)
    expect(progress).not.toContain(toolContent)
    expect(progress).not.toContain(modelContent)
    expect(progress).not.toContain("ENOENT")
    expect(progress).not.toContain("path")
  })

  test("throwing activity observers cannot change allowed tool execution or completion", async () => {
    const toolPath = "observer-throw.txt"
    const content = "tool input content must remain private"
    let observerCalls = 0
    const subject = harness({
      responses: [toolWrite(toolPath, content), JSON.stringify({ type: "final", text: "completed despite observer failure" })],
      observeActivity() {
        observerCalls++
        throw new Error("observer failure must not escape")
      },
    })
    const handle = await subject.host.prepare(subject.request)

    expect(await handle.run()).toEqual({ status: "completed", text: "completed despite observer failure" })
    expect(readFileSync(join(root, toolPath), "utf8")).toBe(content)
    expect(observerCalls).toBe(6)
  })

  test("Codex admission requires an exact transport profile probe and carries native instructions outside the prompt", async () => {
    const missing = harness({ engine: "codex", omitPreflight: true })
    const missingPreflight = await missing.host.preflight(missing.host.identity.profile)
    expect(missingPreflight.compatible).toBe(false)
    expect(missingPreflight.controls.preExecutionToolPolicy).toBe("unsupported")
    expect(missing.controls[0]?.runCalls).toBe(0)

    const mismatched = harness({ engine: "codex", preflightPolicyHash: "wrong-profile-hash" })
    const mismatchedPreflight = await mismatched.host.preflight(mismatched.host.identity.profile)
    expect(mismatchedPreflight.compatible).toBe(false)
    expect(mismatchedPreflight.controls.preExecutionToolPolicy).toBe("unsupported")
    expect(mismatched.controls[0]?.runCalls).toBe(0)

    const mismatchedRun = harness({
      engine: "codex",
      preflightPolicyHash: "wrong-profile-hash",
      responses: [JSON.stringify({ type: "final", text: "must not dispatch" })],
    })
    const mismatchedHandle = await mismatchedRun.host.prepare(mismatchedRun.request)
    expect(await mismatchedHandle.run()).toMatchObject({ status: "failed" })
    expect(mismatchedRun.controls[0]?.runCalls).toBe(0)

    const subject = harness({
      engine: "codex",
      responses: [JSON.stringify({ type: "final", text: "Codex profile admitted" })],
    })
    const preflight = await subject.host.preflight(subject.host.identity.profile)
    expect(preflight.compatible).toBe(true)
    expect(preflight.controls.preExecutionToolPolicy).toBe("supported")
    expect(subject.controls[0]?.runCalls).toBe(0)

    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "completed", text: "Codex profile admitted" })
    expect(subject.controls[1]?.preflightCalls).toBe(1)
    expect(subject.controls[1]?.runCalls).toBe(1)
    expect(subject.prompts[0]).not.toContain(CODEX_INSTRUCTIONS)
    expect(estimatedTokens(subject.prompts[0]!) + estimateTokens(CODEX_INSTRUCTIONS)).toBeLessThanOrEqual(WORKER_INPUT_LIMIT)
  })

  test("Codex fixed policy refuses a native context that does not match the admitted catalog", async () => {
    const subject = harness({ engine: "codex", nativeContextIdentity: "changed-catalog-hash" })
    await expect(subject.host.prepare(subject.request)).rejects.toThrow("Codex native context does not match the bound profile")
    expect(subject.prompts).toEqual([])
  })

  test("Codex profile is rechecked before every native inference round", async () => {
    const subject = harness({ engine: "codex", responses: [toolWrite("codex-round.txt", "done"), JSON.stringify({ type: "final", text: "done" })] })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "completed", text: "done" })
    expect(subject.controls).toHaveLength(2)
    expect(subject.controls.map(control => control.preflightCalls)).toEqual([1, 1])
    expect(subject.controls.map(control => control.runCalls)).toEqual([1, 1])
    expect(readFileSync(join(root, "codex-round.txt"), "utf8")).toBe("done")
    expect(subject.prompts.every(prompt => !prompt.includes(CODEX_INSTRUCTIONS) &&
      estimatedTokens(prompt) + estimateTokens(CODEX_INSTRUCTIONS) <= WORKER_INPUT_LIMIT)).toBe(true)
  })

  test("unresolved Codex preflight remains owned until quiescent, then admission recovers", async () => {
    const subject = harness({
      engine: "codex",
      preflightCompatible: false,
      preflightNonQuiescent: true,
      responses: [JSON.stringify({ type: "final", text: "recovered" })],
    })
    const preflight = await subject.host.preflight(subject.host.identity.profile)
    expect(preflight.compatible).toBe(false)
    expect(subject.controls[0]?.cancelCalls).toBe(1)

    await expect(subject.host.prepare(subject.request)).rejects.toThrow("unresolved Codex preflight process; model dispatch refused")
    expect(subject.controls[0]?.cancelCalls).toBe(2)
    expect(subject.controls[0]?.runCalls).toBe(0)

    subject.preflightQuiescent = true
    subject.preflightCompatible = true
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "completed", text: "recovered" })
    expect(subject.controls[1]?.preflightCalls).toBe(1)
    expect(subject.controls[1]?.runCalls).toBe(1)
  })

  test("host cancellation does not cancel on an expired, invalid, or transport-refused request", async () => {
    const beforeRun = harness({ responses: [JSON.stringify({ type: "final", text: "still runs" })] })
    const beforeRunHandle = await beforeRun.host.prepare(beforeRun.request)
    await expect(beforeRunHandle.requestCancel("expired", Date.now() - 1)).resolves.toMatchObject({ requested: false })
    await expect(beforeRunHandle.requestCancel("invalid", Number.NaN)).rejects.toThrow("invalid CLI cancellation request")
    expect(await beforeRunHandle.run()).toEqual({ status: "completed", text: "still runs" })

    const active = harness({
      responses: [JSON.stringify({ type: "final", text: "still runs" })],
      deferTransportRun: true,
      cancelRequestAccepted: false,
    })
    const activeHandle = await active.host.prepare(active.request)
    const running = activeHandle.run()
    expect(active.controls[0]?.runCalls).toBe(1)
    await expect(activeHandle.requestCancel("expired active", Date.now() - 1)).resolves.toMatchObject({ requested: false })
    expect(active.controls[0]?.cancelCalls).toBe(0)
    await expect(activeHandle.requestCancel("refused", Date.now() + 1000)).resolves.toMatchObject({ requested: false })
    active.releaseTransportRun()
    expect(await running).toEqual({ status: "completed", text: "still runs" })
  })

  test("accepted host cancellation remains effective when its acknowledgement arrives after the requested deadline", async () => {
    const active = harness({
      responses: [JSON.stringify({ type: "final", text: "must be cancelled" })],
      deferTransportRun: true,
      cancelRequestDelayMs: 40,
    })
    const handle = await active.host.prepare(active.request)
    const running = handle.run()
    const deadlineAt = Date.now() + 10
    const cancellation = await handle.requestCancel("accepted before deadline", deadlineAt)
    expect(Date.now()).toBeGreaterThan(deadlineAt)
    expect(cancellation.requested).toBe(true)
    active.releaseTransportRun()
    expect(await running).toMatchObject({ status: "cancelled" })
  })

  test("lease change during streamed assistant output uses the lease-changed outcome", async () => {
    const subject = harness({ responses: [JSON.stringify({ type: "final", text: "must not be accepted" })] })
    subject.beforeOutput = () => {
      const state = subject.state
      subject.state = { ...state, generation: state.generation + 1 }
    }
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "failed", error: "current execution lease changed; execution stopped" })
  })

  test("local and Claude use the same repeatable Otter tool loop and preserve final text", async () => {
    const finalText = " {\"plan\":true}\n"
    for (const engine of ["local", "claude"] as const) {
      const subject = harness({ engine, responses: [toolWrite(`result-${engine}.txt`, "done"), JSON.stringify({ type: "final", text: finalText })] })
      const handle = await subject.host.prepare(subject.request)
      const outcome = await handle.run()
      expect(outcome).toEqual({ status: "completed", text: finalText })
      expect(readFileSync(join(root, `result-${engine}.txt`), "utf8")).toBe("done")
      expect(subject.prompts).toHaveLength(2)
      expect(subject.prompts[0]).toContain("fixed worker constraint")
      expect(subject.prompts[0]).toContain('"oldText": nonempty exact')
      expect(subject.prompts[1]).toContain('"type":"tool","name":"write"')
      expect(subject.prompts.every(prompt => prompt.endsWith("Never return a bare plan, verdict, or prose outside the envelope."))).toBe(true)
      expect(subject.observed.before).toBe(1)
      expect(subject.observed.results).toBe(1)
    }
  })

  test("final text can contain reviewer JSON and is returned unchanged without another tool turn", async () => {
    const finalText = '{"verdict":"REJECT","reason":"needs a fix"}\n'
    const subject = harness({ role: "reviewer", responses: [JSON.stringify({ type: "final", text: finalText })] })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "completed", text: finalText })
    expect(subject.prompts).toHaveLength(1)
    expect(subject.observed.before).toBe(0)
  })

  test("a single deterministic JSON fence is accepted and the Otter byte cap remains reactive", async () => {
    const fenced = harness({ responses: ['```json\n{"type":"final","text":"fenced result"}\n```'] })
    const fencedHandle = await fenced.host.prepare(fenced.request)
    expect(await fencedHandle.run()).toEqual({ status: "completed", text: "fenced result" })

    const capped = harness({ maxOutputTokens: 1, responses: [JSON.stringify({ type: "final", text: "too much output" })] })
    const cappedHandle = await capped.host.prepare(capped.request)
    expect(await cappedHandle.run()).toMatchObject({ status: "failed" })
    expect(capped.controls[0]?.cancelCalls).toBeGreaterThan(0)
  })

  test("wrapped, fenced or shorthand read-only calls from any engine are read as one call; known tools only", async () => {
    writeFileSync(join(root, "README.md"), "fixture\n")
    // Live claude-haiku-5-5 / gemma4 replies observed 2026-10-19 that the strict parser refused.
    const wrapped = [
      '<invoke_tool>\n{"type":"tool","name":"read","input":{"path":"README.md"}}\n</invoke_tool>',
      '\n<reasoning_effort>8</reasoning_effort>\n\n{"type":"tool","name":"read","input":{"path":"README.md"}}',
      "I'll read it first. {\"type\":\"tool\",\"name\":\"read\",\"input\":{\"path\":\"README.md\"}}",
      '```\n{"type":"read","input":{"path":"README.md"}}\n```',
      '{"type":"read","path":"README.md"}',
    ]
    for (const engine of ["claude", "codex"] as const) {
      for (const response of wrapped) {
        const subject = harness({ engine, responses: [response, JSON.stringify({ type: "final", text: "done" })] })
        expect(await (await subject.host.prepare(subject.request)).run()).toEqual({ status: "completed", text: "done" })
        expect(subject.observed.before).toBe(1)
        expect(subject.prompts[1]).toContain("fixture")
      }
    }
    const final = harness({ engine: "claude", responses: ["Here is the answer: {\"type\":\"final\",\"text\":\"done\"}"] })
    expect(await (await final.host.prepare(final.request)).run()).toEqual({ status: "completed", text: "done" })

    // gemma4 quoting the user inside the final text without escaping: repaired to the intended final answer only.
    const quoted = '{"type":"final","text":"사용자 요청("여러 파일 수정")을 확인했습니다. 경로 \\"x\\"도 유지."}\n\n'
    for (const engine of ["local", "claude"] as const) {
      const subject = harness({ engine, responses: [quoted] })
      expect(await (await subject.host.prepare(subject.request)).run()).toEqual({ status: "completed", text: '사용자 요청("여러 파일 수정")을 확인했습니다. 경로 "x"도 유지.' })
    }
    const multiline = harness({ engine: "local", responses: ['{"type":"final","text":"첫 줄\n- 둘째\t탭"}'] })
    expect(await (await multiline.host.prepare(multiline.request)).run()).toEqual({ status: "completed", text: "첫 줄\n- 둘째\t탭" })
    // Truncated replies are not "repaired": the closing quote and brace must be present.
    const truncated = harness({ engine: "claude", responses: ['{"type":"final","text":"cut off here'] })
    expect(await (await truncated.host.prepare(truncated.request)).run()).toMatchObject({ status: "failed" })
  })

  test("a write or edit runs only from a strict whole-body envelope, never from prose, wrappers or a batch", async () => {
    writeFileSync(join(root, "a.txt"), "current\n")
    const write = '{"type":"tool","name":"write","input":{"path":"a.txt","content":"old"}}'
    const edit = '{"type":"tool","name":"edit","input":{"path":"a.txt","oldText":"current","newText":"x"}}'
    for (const engine of ["claude", "codex", "local"] as const) {
      for (const response of [
        `Done. Earlier I ran ${write} and it passed.`,
        `<invoke_tool>${write}</invoke_tool>`,
        `Not ${write} but ${edit}`,
        `{"type":"tool","name":"read","input":{"path":"a.txt"}} ${write}`,
        '{"type":"write","path":"a.txt","content":"old"} trailing note',
      ]) {
        const subject = harness({ engine, responses: [response, JSON.stringify({ type: "final", text: "done" })] })
        const outcome = await (await subject.host.prepare(subject.request)).run()
        expect(subject.observed.before).toBe(0)
        expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("current\n")
        if (engine !== "local") expect(outcome).toMatchObject({ status: "failed" })
      }
    }
    // A broken final answer that quotes a call is repaired to text or refused; the quoted call never runs.
    const oddQuotes = `{"type":"final","text":"he said "run ${write.replaceAll('"', '\\"')}" ok"}`
    const odd = harness({ engine: "claude", responses: [oddQuotes] })
    const oddOutcome = await (await odd.host.prepare(odd.request)).run()
    expect(odd.observed.before).toBe(0)
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("current\n")
    expect(oddOutcome.status === "failed" || (oddOutcome.status === "completed" && oddOutcome.text?.includes("he said"))).toBe(true)
    // The strict whole-body form still writes.
    const strict = harness({ engine: "claude", responses: [write, JSON.stringify({ type: "final", text: "done" })] })
    expect(await (await strict.host.prepare(strict.request)).run()).toEqual({ status: "completed", text: "done" })
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("old")
  })

  test("the main role answers with prose that merely mentions an envelope instead of running it", async () => {
    writeFileSync(join(root, "README.md"), "fixture\n")
    const explained = 'To load a skill, reply exactly {"type":"tool","name":"skill","input":{"name":"x"}} and wait.'
    const main = harness({ engine: "claude", role: "main", responses: [explained] })
    expect(await (await main.host.prepare(main.request)).run()).toEqual({ status: "completed", text: explained })
    expect(main.observed.before).toBe(0)
    // A stray "<word" before prose is not markup: the explanation stays the answer.
    const stray = '<b So to load a skill send {"type":"tool","name":"skill","input":{"name":"x"}} first.'
    const strayMain = harness({ engine: "claude", role: "main", responses: [stray] })
    expect(await (await strayMain.host.prepare(strayMain.request)).run()).toEqual({ status: "completed", text: stray })
    expect(strayMain.observed.before).toBe(0)
    // A valid final closed by wrapper markup is that final.
    const closed = harness({ engine: "claude", responses: ['{"type":"final","text":"ok"}\n</final>'] })
    expect(await (await closed.host.prepare(closed.request)).run()).toEqual({ status: "completed", text: "ok" })
    // A pure wrapper around a read-only call is still a call for main.
    const wrapped = harness({ engine: "claude", role: "main", responses: ['<invoke_tool>{"type":"tool","name":"read","input":{"path":"README.md"}}</invoke_tool>', JSON.stringify({ type: "final", text: "done" })] })
    expect(await (await wrapped.host.prepare(wrapped.request)).run()).toEqual({ status: "completed", text: "done" })
    expect(wrapped.observed.before).toBe(1)
  })

  test("a plain prose reply is the final answer for the main role on any engine, but not for a worker", async () => {
    const prose = "let and const are both block-scoped; let can be reassigned."
    const main = harness({ engine: "claude", role: "main", responses: [prose] })
    expect(await (await main.host.prepare(main.request)).run()).toEqual({ status: "completed", text: prose })
    const worker = harness({ engine: "claude", role: "worker", responses: [prose] })
    expect(await (await worker.host.prepare(worker.request)).run()).toMatchObject({ status: "failed" })
  })

  test("malformed, ambiguous and unknown model tool envelopes fail closed without fallback execution", async () => {
    for (const response of ["Here is the answer without an envelope.",
      '{"type":"tool","name":"bash","input":{"command":"touch unsafe"}}',
      '{"type":"bash","command":"touch unsafe"}',
      '<invoke_tool>{"type":"bash","input":{"command":"touch unsafe"}}</invoke_tool>',
      '{"type":"read","input":"README.md"}',
      '{"type":"read","input":{"path":"README.md"},"extra":1}',
      'Done: {"type":"final","text":"a"} or {"type":"final","text":"b"}',
      '{"type":"tool","name":"read","name":"write","input":{"path":"README.md"}}']) {
      const subject = harness({ engine: "claude", responses: [response] })
      const handle = await subject.host.prepare(subject.request)
      expect(await handle.run()).toMatchObject({ status: "failed" })
      expect(subject.observed.before).toBe(0)
      expect(existsSync(join(root, "unsafe"))).toBe(false)
      expect(subject.prompts).toHaveLength(1)
    }
  })

  test("local engines accept unwrapped stage/report text without treating short or unknown tool syntax as a call", async () => {
    const stage = '{"type":"topology","project":"greenfield","components":[{"id":"cli","description":"CLI fixture"}]}'
    for (const response of [stage, "Verified the approved unit without changing files."]) {
      const local = harness({ engine: "local", responses: [response] })
      const handle = await local.host.prepare(local.request)
      expect(await handle.run()).toEqual({ status: "completed", text: response })
      expect(local.observed.before).toBe(0)
      expect(local.observed.results).toBe(0)
    }

    writeFileSync(join(root, "README.md"), "fixture\n")
    const shorthand = harness({ engine: "local", responses: [
      '{"type":"read","input":{"path":"README.md"}}',
      "Verified the approved unit without changing files.",
    ] })
    expect(await (await shorthand.host.prepare(shorthand.request)).run()).toEqual({
      status: "completed",
      text: "Verified the approved unit without changing files.",
    })
    expect(shorthand.observed.before).toBe(1)
    expect(shorthand.observed.results).toBe(1)

    for (const response of ['{"type":"bash","input":{"command":"touch unsafe"}}', '{"type":"tool","name":"bash","input":{"command":"touch unsafe"}}']) {
      const local = harness({ engine: "local", responses: [response] })
      expect(await (await local.host.prepare(local.request)).run()).toMatchObject({ status: "failed" })
      expect(local.observed.before).toBe(0)
      expect(existsSync(join(root, "unsafe"))).toBe(false)
    }

    const foreign = harness({ engine: "claude", responses: [stage] })
    expect(await (await foreign.host.prepare(foreign.request)).run()).toMatchObject({ status: "failed" })
  })

  test("multiread collects three files in one model round with individual read policy results", async () => {
    for (const path of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(root, path), `contents-${path}`)
    const subject = harness({ role: "planner", responses: [
      JSON.stringify({ type: "tool", name: "multiread", input: { reads: ["a.txt", "b.txt", "c.txt"].map(path => ({ path })) } }),
      JSON.stringify({ type: "final", text: "reviewed all three" }),
    ] })
    const calls: string[] = []
    const results: string[] = []
    const original = subject.request.handlers
    subject.request.handlers = { ...original,
      beforeTool(event) { expect(event.name).toBe("read"); calls.push(event.callID); return original.beforeTool(event) },
      toolResult(event) { expect(event.name).toBe("read"); results.push(event.callID); return original.toolResult(event) },
    }
    expect(await (await subject.host.prepare(subject.request)).run()).toEqual({ status: "completed", text: "reviewed all three" })
    expect(subject.prompts).toHaveLength(2)
    for (const path of ["a.txt", "b.txt", "c.txt"]) expect(subject.prompts[1]).toContain(`contents-${path}`)
    expect(calls).toHaveLength(3)
    expect(new Set(calls).size).toBe(3)
    expect(results).toEqual(calls)
  })

  test("multiread settles prior read policies and returns no contents when a member is denied", async () => {
    writeFileSync(join(root, "a.txt"), "private-first")
    writeFileSync(join(root, "b.txt"), "private-second")
    const subject = harness({ responses: [JSON.stringify({ type: "tool", name: "multiread", input: { reads: [{ path: "a.txt" }, { path: "b.txt" }] } })] })
    const before: string[] = []
    const after: string[] = []
    subject.request.handlers = { ...subject.request.handlers,
      beforeTool(event) { before.push(event.callID); return (event.input as { path: string }).path === "b.txt" ? { allow: false, reason: "denied" } : { allow: true } },
      toolResult(event) { after.push(event.callID); expect(event.result).toBeUndefined(); return { error: event.error } },
    }
    expect(await (await subject.host.prepare(subject.request)).run()).toMatchObject({ status: "failed", error: "Otter pre-execution tool policy denied the tool" })
    expect(before).toHaveLength(2)
    expect(after).toEqual(before)
    expect(subject.prompts).toHaveLength(1)
  })

  test("multiread bounds aggregate output after per-file result policy transforms", async () => {
    writeFileSync(join(root, "a.txt"), "a")
    const subject = harness({ responses: [
      JSON.stringify({ type: "tool", name: "multiread", input: { reads: [{ path: "a.txt" }, { path: "a.txt" }] } }),
      JSON.stringify({ type: "final", text: "retry narrower reads" }),
    ] })
    subject.request.handlers = { ...subject.request.handlers, toolResult: () => ({ result: "expanded-private-content".repeat(900) }) }
    expect(await (await subject.host.prepare(subject.request)).run()).toMatchObject({ status: "completed" })
    expect(subject.prompts[1]).toContain("combined read output exceeds 32 KiB")
    expect(subject.prompts[1]).not.toContain("expanded-private-content")
  })

  test("multiread charges each member against the existing read work budget", async () => {
    writeFileSync(join(root, "a.txt"), "a")
    const batch = JSON.stringify({ type: "tool", name: "multiread", input: { reads: Array.from({ length: 8 }, () => ({ path: "a.txt" })) } })
    const subject = harness({ responses: [batch, batch, batch, batch] })
    expect(await (await subject.host.prepare(subject.request)).run()).toMatchObject({ status: "failed", error: "Otter tool round limit reached" })
    expect(subject.observed.before).toBe(24)
    expect(subject.observed.results).toBe(24)
    expect(subject.prompts).toHaveLength(4)
  })

  test("known tools with malformed input still emit a correlated failed lifecycle", async () => {
    const activities: CliHostActivity[] = []
    const subject = harness({
      responses: [JSON.stringify({ type: "tool", name: "read", input: { path: 1 } })],
      observeActivity: activity => activities.push(activity),
    })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toMatchObject({ status: "failed" })
    expect(subject.observed.before).toBe(0)
    const toolActivities = activities.filter(activity => activity.kind === "tool-started" || activity.kind === "tool-finished")
    const execution = toolActivities[0]!.execution
    expect(toolActivities).toEqual([
      { kind: "tool-started", role: "worker", execution, taskID: subject.request.taskID, executionID: subject.request.executionID, callID: `${subject.request.executionID}:tool:1`, tool: "read" },
      { kind: "tool-finished", role: "worker", execution, taskID: subject.request.taskID, executionID: subject.request.executionID, callID: `${subject.request.executionID}:tool:1`, tool: "read", outcome: "failed", ok: false },
    ])
  })

  test("read-only roles and beforeTool policy deny writes before effects", async () => {
    const readonlyActivities: CliHostActivity[] = []
    const readonly = harness({
      role: "reviewer",
      responses: [toolWrite("reviewer-write.txt", "blocked")],
      observeActivity: activity => readonlyActivities.push(activity),
    })
    const readonlyHandle = await readonly.host.prepare(readonly.request)
    expect(await readonlyHandle.run()).toMatchObject({ status: "failed" })
    expect(existsSync(join(root, "reviewer-write.txt"))).toBe(false)
    expect(readonly.observed.before).toBe(0)
    const readonlyToolActivities = readonlyActivities.filter(activity => activity.kind === "tool-started" || activity.kind === "tool-finished")
    const readonlyExecution = readonlyToolActivities[0]!.execution
    expect(readonlyToolActivities).toEqual([
      { kind: "tool-started", role: "reviewer", execution: readonlyExecution, taskID: readonly.request.taskID, executionID: readonly.request.executionID, callID: `${readonly.request.executionID}:tool:1`, tool: "write" },
      { kind: "tool-finished", role: "reviewer", execution: readonlyExecution, taskID: readonly.request.taskID, executionID: readonly.request.executionID, callID: `${readonly.request.executionID}:tool:1`, tool: "write", outcome: "denied", ok: false },
    ])

    const deniedActivities: CliHostActivity[] = []
    const denied = harness({
      responses: [toolWrite("policy-write.txt", "blocked")],
      denyTool: true,
      observeActivity: activity => deniedActivities.push(activity),
    })
    const deniedHandle = await denied.host.prepare(denied.request)
    expect(await deniedHandle.run()).toMatchObject({ status: "failed" })
    expect(denied.observed.before).toBe(1)
    expect(existsSync(join(root, "policy-write.txt"))).toBe(false)
    const deniedToolActivities = deniedActivities.filter(activity => activity.kind === "tool-started" || activity.kind === "tool-finished")
    const deniedExecution = deniedToolActivities[0]!.execution
    expect(deniedToolActivities).toEqual([
      { kind: "tool-started", role: "worker", execution: deniedExecution, taskID: denied.request.taskID, executionID: denied.request.executionID, callID: `${denied.request.executionID}:tool:1`, tool: "write" },
      { kind: "tool-finished", role: "worker", execution: deniedExecution, taskID: denied.request.taskID, executionID: denied.request.executionID, callID: `${denied.request.executionID}:tool:1`, tool: "write", outcome: "denied", ok: false },
    ])

    const thrownActivities: CliHostActivity[] = []
    const thrown = harness({
      responses: [toolWrite("policy-throw.txt", "blocked")],
      throwBeforeTool: true,
      observeActivity: activity => thrownActivities.push(activity),
    })
    const thrownHandle = await thrown.host.prepare(thrown.request)
    expect(await thrownHandle.run()).toMatchObject({ status: "failed" })
    expect(existsSync(join(root, "policy-throw.txt"))).toBe(false)
    const thrownToolActivities = thrownActivities.filter(activity => activity.kind === "tool-started" || activity.kind === "tool-finished")
    const thrownExecution = thrownToolActivities[0]!.execution
    expect(thrownToolActivities).toEqual([
      { kind: "tool-started", role: "worker", execution: thrownExecution, taskID: thrown.request.taskID, executionID: thrown.request.executionID, callID: `${thrown.request.executionID}:tool:1`, tool: "write" },
      { kind: "tool-finished", role: "worker", execution: thrownExecution, taskID: thrown.request.taskID, executionID: thrown.request.executionID, callID: `${thrown.request.executionID}:tool:1`, tool: "write", outcome: "failed", ok: false },
    ])
  })

  test("a lease exception before the tool effect still settles its correlated lifecycle", async () => {
    const activities: CliHostActivity[] = []
    const subject = harness({
      responses: [toolWrite("lease-failure.txt", "blocked")],
      observeActivity: activity => activities.push(activity),
    })
    subject.beforeToolEffect = () => {
      subject.state = { ...subject.state, executions: [] }
    }
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toMatchObject({ status: "failed" })
    expect(existsSync(join(root, "lease-failure.txt"))).toBe(false)
    const toolActivities = activities.filter(activity => activity.kind === "tool-started" || activity.kind === "tool-finished")
    const execution = toolActivities[0]!.execution
    expect(toolActivities).toEqual([
      { kind: "tool-started", role: "worker", execution, taskID: subject.request.taskID, executionID: subject.request.executionID, callID: `${subject.request.executionID}:tool:1`, tool: "write" },
      { kind: "tool-finished", role: "worker", execution, taskID: subject.request.taskID, executionID: subject.request.executionID, callID: `${subject.request.executionID}:tool:1`, tool: "write", outcome: "failed", ok: false },
    ])
  })

  test("missing or changed lease after inference prevents the pending tool effect", async () => {
    for (const change of ["missing", "changed"] as const) {
      const subject = harness({ responses: [toolWrite(`${change}.txt`, "blocked")] })
      subject.afterNativeTurn = () => {
        const state = subject.state
        if (change === "missing") subject.state = { ...state, claim: undefined }
        else subject.state = { ...state, generation: state.generation + 1 }
      }
      const handle = await subject.host.prepare(subject.request)
      expect(await handle.run()).toMatchObject({ status: "failed" })
      expect(existsSync(join(root, `${change}.txt`))).toBe(false)
    }
  })

  test("configured local budget changes dispatch admission while cloud budgets remain fixed", async () => {
    mkdirSync(join(root, ".otter"))
    const path = join(root, ".otter", "otter.jsonc")
    const taskText = "x".repeat(24_000)
    for (const budget of [4096, 65536]) {
      writeFileSync(path, JSON.stringify({ local_model: { context_input_tokens: budget } }))
      const subject = harness({ role: "main", taskText, responses: [JSON.stringify({ type: "final", text: "done" })] })
      const result = await (await subject.host.prepare(subject.request)).run()
      expect(result.status).toBe(budget === 4096 ? "failed" : "completed")
      if (budget === 4096) {
        expect(result).toMatchObject({ error: expect.stringContaining("estimated input budget") })
        expect(subject.prompts).toHaveLength(0)
      } else expect(subject.prompts[0]).toContain("Input estimate limit: 65536")
    }
    writeFileSync(path, '{"local_model":{"context_input_tokens":4096}}')
    const cloud = harness({ engine: "claude", role: "main", taskText, responses: [JSON.stringify({ type: "final", text: "done" })] })
    expect((await (await cloud.host.prepare(cloud.request)).run()).status).toBe("completed")
    expect(cloud.prompts[0]).toContain("Input estimate limit: 49152")
  })

  test("local budget is fixed for an execution even when config changes between tool turns", async () => {
    mkdirSync(join(root, ".otter"))
    const path = join(root, ".otter", "otter.jsonc")
    writeFileSync(path, '{"local_model":{"context_input_tokens":4096}}')
    const subject = harness({ responses: [toolWrite("budget.txt", "ok"), JSON.stringify({ type: "final", text: "done" })], afterNativeTurn: () => {
      writeFileSync(path, '{"local_model":{"context_input_tokens":65536}}')
    } })
    expect((await (await subject.host.prepare(subject.request)).run()).status).toBe("completed")
    expect(subject.prompts).toHaveLength(2)
    for (const prompt of subject.prompts) expect(prompt).toContain("Input estimate limit: 4096")
  })

  test("local read-only roles use context budget; worker limits remain bounded", () => {
    for (const role of ["main", "planner", "architect", "critic"] as const) {
      expect(roleInputLimit(role)).toBe(8192)
      expect(roleInputLimit(role, "local", 4096)).toBe(4096)
      expect(roleInputLimit(role, "local", 65536)).toBe(65536)
      expect(roleInputLimit(role, "claude", 4096)).toBe(49152)
    }
    expect(roleInputLimit("worker", "local", 4096)).toBe(4096)
    expect(roleInputLimit("worker", "local", 65536)).toBe(5120)
    expect(roleInputLimit("worker", "codex", 4096)).toBe(5120)
  })

  test("input estimate rejects an oversized mandatory task without native dispatch", async () => {
    const subject = harness({ taskText: "x".repeat(40_000), responses: [JSON.stringify({ type: "final", text: "unexpected" })] })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toMatchObject({ status: "failed", error: expect.stringContaining("estimated input budget") })
    expect(subject.prompts).toHaveLength(0)
  })

  test("carried CJK plan skills are omitted whole against the full worker and native input budget", async () => {
    for (const engine of ["local", "codex", "claude"] as const) {
      const subject = harness({ engine, responses: [JSON.stringify({ type: "final", text: "done" })] })
      subject.request.planSkills = [{ name: "korean", instructions: "한".repeat(6000) }]
      expect(await (await subject.host.prepare(subject.request)).run()).toMatchObject({ status: "completed" })
      const prompt = subject.prompts.at(-1)!
      expect(prompt).toContain(subject.request.text)
      expect(prompt).not.toContain("한")
      expect(prompt).toContain(SKILL_DROPPED_RESULT)
      expect(estimatedTokens(prompt) + estimateTokens(subject.request.policy.nativeContext?.instructions ?? "")).toBeLessThanOrEqual(WORKER_INPUT_LIMIT)
    }
  })

  test("a nearly full worker task runs even when a plan-skill omission notice cannot fit", async () => {
    const probe = harness({ taskText: "", responses: [JSON.stringify({ type: "final", text: "probe" })] })
    expect(await (await probe.host.prepare(probe.request)).run()).toMatchObject({ status: "completed" })
    const taskText = "x".repeat((WORKER_INPUT_LIMIT - estimatedTokens(probe.prompts[0]!) - 1) * 4)
    const subject = harness({ taskText, responses: [JSON.stringify({ type: "final", text: "done" })] })
    subject.request.planSkills = [{ name: "optional", instructions: "Keep this optional reference whole." }]
    expect(await (await subject.host.prepare(subject.request)).run()).toMatchObject({ status: "completed" })
    expect(subject.prompts[0]).toContain(taskText)
    expect(subject.prompts[0]).not.toContain("Keep this optional reference whole.")
    expect(estimatedTokens(subject.prompts[0]!)).toBeLessThanOrEqual(WORKER_INPUT_LIMIT)
  })

  test("carried plan skills fit whole initially and drop whole for later tool exchanges", async () => {
    const instructions = "Plan reference instruction. ".repeat(20)
    const probe = harness({ taskText: "", responses: [JSON.stringify({ type: "final", text: "probe" })] })
    probe.request.planSkills = [{ name: "reference", instructions }]
    expect(await (await probe.host.prepare(probe.request)).run()).toMatchObject({ status: "completed" })
    expect(probe.prompts[0]).toContain(instructions)
    const taskText = "x".repeat((WORKER_INPUT_LIMIT - estimatedTokens(probe.prompts[0]!) - 1) * 4)
    writeFileSync(join(root, "payload.txt"), "some result")
    const subject = harness({ taskText, responses: [
      JSON.stringify({ type: "tool", name: "read", input: { path: "payload.txt" } }),
      JSON.stringify({ type: "final", text: "done" }),
    ] })
    subject.request.planSkills = [{ name: "reference", instructions }]
    expect(await (await subject.host.prepare(subject.request)).run()).toMatchObject({ status: "completed" })
    expect(subject.prompts[0]).toContain(instructions)
    expect(subject.prompts[1]).not.toContain(instructions)
    expect(subject.prompts[1]).toContain(SKILL_DROPPED_RESULT)
    expect(subject.prompts.every(prompt => estimatedTokens(prompt) <= WORKER_INPUT_LIMIT)).toBe(true)
    expect(subject.prompts[1]).toContain(taskText)
  })

  test("history truncation makes monotonic progress and prunes exchanges without dropping the task", async () => {
    const probe = harness({ taskText: "", responses: [JSON.stringify({ type: "final", text: "probe" })] })
    const probeHandle = await probe.host.prepare(probe.request)
    expect(await probeHandle.run()).toEqual({ status: "completed", text: "probe" })
    const fixedBase = probe.prompts[0]!
    const readAssistant = JSON.stringify({ type: "tool", name: "read", input: { path: "payload.txt" } })
    const listAssistant = JSON.stringify({ type: "tool", name: "list", input: { path: "." } })
    const grepAssistant = JSON.stringify({ type: "tool", name: "grep", input: { pattern: "not-present", path: "." } })
    const firstExchange = { assistant: readAssistant, ok: true, result: HISTORY_TRUNCATION_MARKER }
    const secondExchange = { assistant: listAssistant, ok: true, result: '[{"name":"payload.txt","type":"file"}]' }
    let low = 0
    let high = WORKER_INPUT_LIMIT * 4
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const base = `${fixedBase}${"x".repeat(middle)}`
      if (estimatedTokens(historyPrompt(base, [firstExchange, secondExchange])) <= WORKER_INPUT_LIMIT) low = middle
      else high = middle - 1
    }
    const taskText = "x".repeat(low)
    const base = `${fixedBase}${taskText}`
    expect(estimatedTokens(base)).toBeLessThanOrEqual(WORKER_INPUT_LIMIT)
    expect(estimatedTokens(historyPrompt(base, [firstExchange, secondExchange]))).toBeLessThanOrEqual(WORKER_INPUT_LIMIT)
    expect(estimatedTokens(historyPrompt(base, [firstExchange, secondExchange, { assistant: grepAssistant, ok: true, result: "" }]))).toBeGreaterThan(WORKER_INPUT_LIMIT)

    writeFileSync(join(root, "payload.txt"), "p".repeat(16_384))
    const subject = harness({ taskText, responses: [
      JSON.stringify({ type: "tool", name: "read", input: { path: "payload.txt" } }),
      JSON.stringify({ type: "tool", name: "list", input: { path: "." } }),
      JSON.stringify({ type: "tool", name: "grep", input: { pattern: "not-present", path: "." } }),
      JSON.stringify({ type: "final", text: "pruned history retained the task" }),
    ] })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "completed", text: "pruned history retained the task" })
    expect(subject.prompts).toHaveLength(4)
    expect(subject.prompts.every(prompt => prompt.includes(`User task (preserve all content and constraints):\n\n${taskText}`))).toBe(true)
    expect(subject.prompts.every(prompt => prompt.includes("fixed worker constraint") &&
      prompt.includes("Execution title (preserve this constraint):") && prompt.includes("Input estimate limit:"))).toBe(true)
    expect(subject.prompts.every(prompt => estimatedTokens(prompt) <= WORKER_INPUT_LIMIT)).toBe(true)
    expect(subject.prompts[3]).toContain("[earlier tool exchanges omitted to fit the estimated input budget]")
  })

  test("unresolved and thrown native turns retain owned transports for late cancellation and reconciliation", async () => {
    for (const transportBehavior of ["unresolved", "throw"] as const) {
      const subject = harness({
        transportBehavior,
        responses: [JSON.stringify({ type: "final", text: "must not replay" })],
      })
      const handle = await subject.host.prepare(subject.request)
      expect(await handle.run()).toMatchObject({ status: "unresolved" })
      const control = subject.controls[0]!

      const reconcileCallsBefore = control.reconcileCalls
      expect(await subject.host.reconcile(handle.reference)).toMatchObject({ outcome: "unknown", quiescent: false })
      expect(control.reconcileCalls).toBe(reconcileCallsBefore + 1)

      const cancelResult = await handle.requestCancel("recover owned process", Date.now() + 1000)
      expect(cancelResult).toMatchObject({ requested: true, acknowledged: true, quiescent: false })
      expect(control.cancelCalls).toBe(1)

      const lateReconcileCalls = control.reconcileCalls
      expect(await subject.host.reconcile(handle.reference)).toMatchObject({ outcome: "terminal", quiescent: true })
      expect(control.reconcileCalls).toBe(lateReconcileCalls + 1)
      expect(await subject.host.reconcile(handle.reference)).toMatchObject({ outcome: "terminal", quiescent: true })
      expect(control.reconcileCalls).toBe(lateReconcileCalls + 1)
      expect(control.runCalls).toBe(1)
      expect(subject.prompts).toHaveLength(1)
    }
  })

  test("cancellation between tool rounds prevents another native turn", async () => {
    const subject = harness({ responses: [toolWrite("cancelled-round.txt", "written")] })
    const handle = await subject.host.prepare(subject.request)
    subject.onToolResult = () => { void handle.requestCancel("fixture stop", Date.now() + 1000) }
    expect(await handle.run()).toMatchObject({ status: "cancelled" })
    expect(subject.prompts).toHaveLength(1)
    expect(readFileSync(join(root, "cancelled-round.txt"), "utf8")).toBe("written")
  })

  test("assistant-text policy cancellation reaches the current owned transport", async () => {
    const subject = harness({ responses: [JSON.stringify({ type: "final", text: "ignored" })], cancelAssistant: true })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toMatchObject({ status: "cancelled" })
    expect(subject.controls[0]?.cancelCalls).toBeGreaterThan(0)
    expect(subject.observed.before).toBe(0)
  })

  test("transport JSON parsing rejects duplicate-key or multi-envelope ambiguity", async () => {
    const subject = harness({ responses: [
      '{"type":"final","type":"tool","name":"write","input":{"path":"bad.txt","content":"x"}}',
    ] })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toMatchObject({ status: "failed" })
    expect(existsSync(join(root, "bad.txt"))).toBe(false)
  })

  test("recovery never replays or signals a persisted execution reference", async () => {
    const subject = harness({ responses: [JSON.stringify({ type: "final", text: "done" })] })
    const result = await subject.host.reconcile({ executionID: "not-owned-here" })
    expect(result).toEqual({ outcome: "unknown", quiescent: false, evidence: "no current owned CLI process evidence; replay is refused" })
    expect(subject.prompts).toHaveLength(0)
  })
})

describe("route-aware common CLI host", () => {
  const routes: ComboRoutes = {
    planner: { engine: "claude", model: "opus" },
    architect: { engine: "codex", model: "gpt-5.6-sol" },
  }

  function routed(options: { failPreflightFor?: string; wrongSnapshotModel?: boolean; codexHash?: string; routes?: ComboRoutes; anchor?: { engine: "local" | "codex" | "claude"; model: string }; hashFor?: (model: string) => string } = {}) {
    const anchor = options.anchor ?? { engine: "local" as const, model: "anchor-model" }
    const table: Record<string, { engine: string; model: string }> = { ...(options.routes ?? routes) }
    const snapshotFor = (role: ExecutionRole) => {
      const target = table[role] ?? anchor
      return Object.freeze({
        id: `policy-${role}`,
        role,
        model: Object.freeze({ providerID: target.engine, modelID: options.wrongSnapshotModel ? anchor.model : target.model }),
        maxOutputTokens: 20_000,
        tools: Object.freeze({ allowed: Object.freeze([...ALL_TOOLS]), denied: Object.freeze([] as string[]) }),
        system: Object.freeze([`fixed ${role} constraint`]),
        ...(target.engine === "codex" ? (() => {
          const codex = createCodexProfile(target.model)
          return { nativeContext: Object.freeze({ identity: codex.catalogHash, instructions: codex.instructions }) }
        })() : {}),
        thinking: "inherit" as const,
      })
    }
    const snapshots = new Map<ExecutionRole, ReturnType<typeof snapshotFor>>()
    const resolve = (role: ExecutionRole) => {
      if (!snapshots.has(role)) snapshots.set(role, snapshotFor(role))
      return snapshots.get(role)!
    }
    const handlers: ExecutionPolicyHandlers = {
      beforeTool: () => ({ allow: true }),
      toolResult: event => event.error === undefined ? { result: event.result } : { error: event.error },
      assistantText: () => ({ cancel: false }),
    }
    const policy = { resolve, handlers: () => handlers, bindSession() {}, unbindSession() {}, handlersForSession: () => undefined, snapshotForSession: () => undefined } as unknown as ExecutionPolicy
    const retentionCalls: CliTransportOptions[] = []
    const requests: Array<{ role: ExecutionRole; engine: string; model: string }> = []
    const transports: Array<{ engine: string; model: string; prompt: string }> = []
    let currentRole: ExecutionRole = "worker"
    const createTransport = (opts: CliTransportOptions): CliTransportHandle => {
      retentionCalls.push(opts)
      transports.push({ engine: opts.engine, model: opts.model, prompt: opts.prompt })
      const failing = options.failPreflightFor === `${opts.engine}/${opts.model}`
      const handle: CliTransportHandle = {
        async run() {
          requests.push({ role: currentRole, engine: opts.engine, model: opts.model })
          opts.onText?.(JSON.stringify({ type: "final", text: `done ${opts.engine}/${opts.model}` }))
          return { status: "completed", text: JSON.stringify({ type: "final", text: `done ${opts.engine}/${opts.model}` }), quiescent: true }
        },
        async requestCancel() { return { requested: true, acknowledged: true, terminal: true, quiescent: true, evidence: "fixture" } },
        async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "fixture" } },
      }
      if (opts.engine === "codex") {
        handle.preflight = async () => ({ compatible: !failing, nativePolicyHash: options.codexHash ?? options.hashFor?.(opts.model) ?? createCodexProfile(opts.model).catalogHash })
      }
      if (failing && opts.engine !== "codex") throw new Error("fixture executable missing")
      return handle
    }
    const makeRequest = (role: ExecutionRole): ExecutionRequest => ({
      executionID: `${EXECUTION}-${role}`,
      supervisorSessionID: OWNER,
      taskID: "task",
      attemptID: "attempt",
      generation: 7,
      role,
      title: "Routed fixture",
      cwd: root,
      text: "Answer.",
      deadlineAt: Date.now() + 10_000,
      policy: resolve(role),
      handlers,
    })
    const state = (role: ExecutionRole): ExecutionRunStatus => ({
      generation: 7,
      claim: { ownerSession: OWNER, instance: "test-instance", pid: process.pid, generation: 7 },
      executions: [{
        executionId: `${EXECUTION}-${role}`, ownerSession: OWNER, taskId: "task", attemptId: "attempt", generation: 7,
        role, cwd: root, policyID: `policy-${role}`, kind: "host" as const,
        engine: anchor.engine, profile: "legacy-unowned" as const, controlProfile: CONTROL_PROFILE,
      }],
    })
    let active: ExecutionRole = "worker"
    const runs = { status: () => state(active) } as unknown as ExecutionRunStore
    const host = createCliHost({ engine: anchor.engine, model: anchor.model, routes: options.routes ?? routes, policy, runs, createTransport,
      loadLocalModel: () => loadConfig(root).local_model })
    return {
      host, requests, transports, makeRequest, retentionCalls,
      async dispatch(role: ExecutionRole) {
        active = role
        currentRole = role
        const handle = await host.prepare(makeRequest(role))
        return handle.run()
      },
    }
  }

  test("local combo routes receive retention under a cloud anchor", async () => {
    mkdirSync(join(root, ".otter"))
    writeFileSync(join(root, ".otter", "otter.jsonc"), '{"local_model":{"keep_alive":"0"}}')
    const subject = routed({ anchor: { engine: "claude", model: "opus" }, routes: { planner: { engine: "local", model: "fixture" } } })
    expect((await subject.dispatch("planner")).status).toBe("completed")
    expect((await subject.dispatch("worker")).status).toBe("completed")
    expect(subject.retentionCalls.map(call => call.localKeepAlive)).toEqual(["0", undefined])
  })

  test("each request dispatches on its role route while identity stays the anchor", async () => {
    const subject = routed()
    expect(subject.host.identity.engine).toBe("local")
    expect(await subject.dispatch("planner")).toEqual({ status: "completed", text: "done claude/opus" })
    expect(await subject.dispatch("architect")).toEqual({ status: "completed", text: "done codex/gpt-5.6-sol" })
    expect(await subject.dispatch("worker")).toEqual({ status: "completed", text: "done local/anchor-model" })
    expect(subject.requests).toEqual([
      { role: "planner", engine: "claude", model: "opus" },
      { role: "architect", engine: "codex", model: "gpt-5.6-sol" },
      { role: "worker", engine: "local", model: "anchor-model" },
    ])
  })

  test("preflight probes the anchor and each distinct route once, and succeeds only if all pass", async () => {
    const subject = routed({ routes: { ...routes, critic: { engine: "claude", model: "opus" } } })
    const result = await subject.host.preflight(subject.host.identity.profile)
    expect(result).toMatchObject({ compatible: true, problems: [] })
    expect(subject.transports.map(entry => `${entry.engine}/${entry.model}`).sort())
      .toEqual(["claude/opus", "codex/gpt-5.6-sol", "local/anchor-model"])
    expect(subject.transports.every(entry => entry.prompt === "")).toBe(true)
  })

  test("a failing route makes preflight incompatible, names the role, and never falls back", async () => {
    const claude = routed({ failPreflightFor: "claude/opus" })
    const claudeResult = await claude.host.preflight(claude.host.identity.profile)
    expect(claudeResult.compatible).toBe(false)
    expect(claudeResult.problems.join(" ")).toContain("combo route for planner")

    const codex = routed({ failPreflightFor: "codex/gpt-5.6-sol" })
    const codexResult = await codex.host.preflight(codex.host.identity.profile)
    expect(codexResult.compatible).toBe(false)
    // A Codex route alone is that route's problem (named, so admission can say which route), not a host-wide control.
    expect(codexResult.controls.preExecutionToolPolicy).toBe("supported")
    expect(codexResult.problems.join(" ")).toContain("combo route for architect -> codex / gpt-5.6-sol is unavailable")
    expect(() => assertHostAdmission(codexResult, "estimated-input-reactive-output-v1")).toThrow("combo route unavailable: architect -> codex / gpt-5.6-sol")
    expect(codexResult.problems.join(" ")).toContain("combo route for architect")
    expect(codex.requests).toEqual([])
  })

  test("a failing route's preflight problem names its roles and engine/model", async () => {
    const subject = routed({ failPreflightFor: "claude/opus" })
    const result = await subject.host.preflight(subject.host.identity.profile)
    expect(result.problems).toEqual(["combo route for planner -> claude / opus is unavailable: selected CLI executable or profile is unavailable"])
  })

  test("a failed routed transport never falls back to creating an anchor transport", async () => {
    const subject = routed({ failPreflightFor: "claude/opus" })
    await expect(subject.dispatch("planner")).resolves.toMatchObject({ status: "failed", error: "CLI inference transport could not be prepared" })
    expect(subject.transports.map(entry => `${entry.engine}/${entry.model}`)).toEqual(["claude/opus"])
    expect(subject.requests).toEqual([])
  })

  test("two distinct Codex models are each validated against their own profile hash", async () => {
    const anchor = { engine: "codex" as const, model: "gpt-6-astra" }
    const codexRoutes: ComboRoutes = { architect: { engine: "codex", model: "gpt-5.6-sol" } }
    const astra = createCodexProfile("gpt-6-astra").catalogHash
    const sol = createCodexProfile("gpt-5.6-sol").catalogHash
    expect(astra).not.toBe(sol)

    const good = routed({ anchor, routes: codexRoutes })
    expect(await good.host.preflight(good.host.identity.profile)).toMatchObject({ compatible: true, problems: [] })
    expect(await good.dispatch("architect")).toEqual({ status: "completed", text: "done codex/gpt-5.6-sol" })
    expect(await good.dispatch("worker")).toEqual({ status: "completed", text: "done codex/gpt-6-astra" })

    // The route's transport reports the anchor's hash: only the route is refused, naming its role and model.
    const swapped = routed({ anchor, routes: codexRoutes, hashFor: () => astra })
    const result = await swapped.host.preflight(swapped.host.identity.profile)
    expect(result.compatible).toBe(false)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toContain("combo route for architect -> codex / gpt-5.6-sol is unavailable")
    await expect(swapped.dispatch("architect")).resolves.toMatchObject({ status: "failed" })
    expect(swapped.requests).toEqual([])
    await expect(swapped.dispatch("worker")).resolves.toEqual({ status: "completed", text: "done codex/gpt-6-astra" })

    // The anchor's transport reporting the route's hash refuses the anchor, leaving the matching route unnamed in problems.
    const reversed = routed({ anchor, routes: codexRoutes, hashFor: () => sol })
    const reversedResult = await reversed.host.preflight(reversed.host.identity.profile)
    expect(reversedResult.compatible).toBe(false)
    expect(reversedResult.problems).toHaveLength(1)
    expect(reversedResult.problems[0]).toContain("Codex native profile preflight")
    expect(reversedResult.problems[0]).not.toContain("combo route")
    // The anchor's own Codex profile failing is a host-wide refusal.
    expect(reversedResult.controls.preExecutionToolPolicy).toBe("unsupported")
    await expect(reversed.dispatch("worker")).resolves.toMatchObject({ status: "failed" })
    await expect(reversed.dispatch("architect")).resolves.toEqual({ status: "completed", text: "done codex/gpt-5.6-sol" })
  })

  test("a route whose Codex profile hash mismatches is refused", async () => {
    const subject = routed({ codexHash: "wrong" })
    const result = await subject.host.preflight(subject.host.identity.profile)
    expect(result.compatible).toBe(false)
    await expect(subject.dispatch("architect")).resolves.toMatchObject({ status: "failed" })
  })

  test("a routed role's snapshot carrying the anchor model is refused before dispatch", async () => {
    const subject = routed({ wrongSnapshotModel: true })
    await expect(subject.dispatch("planner")).rejects.toThrow("execution policy snapshot is not fixed")
    expect(subject.requests).toEqual([])
  })

  test("invalid routes refuse host construction", () => {
    const subject = routed()
    const bad = (value: unknown) => () => createCliHost({
      engine: "local", model: "anchor-model", routes: value as never,
      policy: {} as ExecutionPolicy, runs: {} as ExecutionRunStore,
    })
    expect(bad({ main: { engine: "claude", model: "opus" } })).toThrow("invalid CLI host options")
    expect(bad({ planner: { engine: "x", model: "opus" } })).toThrow("invalid CLI host options")
    expect(bad({ planner: { engine: "codex", model: "unknown-slug" } })).toThrow("unsupported Codex model profile")
    expect(subject.host.identity.engine).toBe("local")
  })
})

describe("host-provided skill tool", () => {
  const provider = (loads: string[], delivered: string[] = [], body = "SKILL_BODY_BYTES"): SkillToolProvider => ({
    catalog: [{ name: "wiki-helper", description: "Compile\nwiki pages" }],
    async load(name) {
      loads.push(name)
      return name === "wiki-helper" ? { ok: true, text: body } : { ok: false, error: "refused" }
    },
    delivered(name) { delivered.push(name) },
  })
  const call = (name: string) => JSON.stringify({ type: "tool", name: "skill", input: { name } })

  test("main sees the catalog, loads a listed skill mid-turn and gets its instructions in the next prompt", async () => {
    const loads: string[] = []
    const delivered: string[] = []
    const subject = harness({ role: "main", responses: [call("wiki-helper"), call("wiki-helper"), call("orca-cli"), JSON.stringify({ type: "final", text: "done" })] })
    const handle = await subject.host.prepare({ ...subject.request, skillTool: provider(loads, delivered) })
    expect(await handle.run()).toEqual({ status: "completed", text: "done" })
    expect(subject.prompts[0]).toContain("- skill: allowed")
    expect(subject.prompts[0]).toContain("Available skills")
    expect(subject.prompts[0]).toContain("- wiki-helper: Compile wiki pages")
    expect(subject.prompts[1]).toContain("SKILL_BODY_BYTES")
    expect(subject.prompts[2]).toContain("Skill already loaded in this turn")
    expect(subject.prompts[3]).toContain("not in the Available skills list")
    // The provider is called once; the role policy hook is not consulted for skill loads.
    expect(loads).toEqual(["wiki-helper"])
    expect(delivered).toEqual(["wiki-helper"])
    expect(subject.observed.before).toBe(0)
  })

  test("instructions that would not fit whole are refused as a tool error and never reported as delivered", async () => {
    const delivered: string[] = []
    const subject = harness({ role: "main", responses: [call("wiki-helper"), JSON.stringify({ type: "final", text: "done" })] })
    const handle = await subject.host.prepare({ ...subject.request, skillTool: provider([], delivered, "word ".repeat(40_000)) })
    expect(await handle.run()).toEqual({ status: "completed", text: "done" })
    expect(subject.prompts[1]).toContain("do not fit in the remaining input budget")
    expect(subject.prompts[1]).not.toContain("word word word word")
    expect(delivered).toEqual([])
  })

  test("a later large tool result never truncates loaded instructions; if they must go they are withdrawn whole", async () => {
    writeFileSync(join(root, "big.txt"), "filler line of ordinary text\n".repeat(2_200))
    const delivered: string[] = []
    const withdrawn: string[] = []
    const body = "RULE-START " + "keep this whole. ".repeat(900) + " RULE-END"
    const skillTool: SkillToolProvider = {
      catalog: [{ name: "wiki-helper", description: "Compile wiki pages" }],
      load: async () => ({ ok: true, text: body }),
      delivered(name) { delivered.push(name) },
      withdrawn(name) { withdrawn.push(name) },
    }
    const subject = harness({ role: "main", responses: [call("wiki-helper"), JSON.stringify({ type: "tool", name: "read", input: { path: "big.txt", startLine: 1, maxLines: 2000 } }), JSON.stringify({ type: "tool", name: "read", input: { path: "big.txt", startLine: 1101, maxLines: 2000 } }), JSON.stringify({ type: "final", text: "done" })] })
    const handle = await subject.host.prepare({ ...subject.request, skillTool })
    expect(await handle.run()).toEqual({ status: "completed", text: "done" })
    expect(delivered).toEqual(["wiki-helper"])
    const last = subject.prompts.at(-1)!
    // Either the instructions are all there, or they are gone with an explicit notice and reported as withdrawn.
    if (last.includes("RULE-START")) {
      expect(last).toContain("RULE-END")
      expect(withdrawn).toEqual([])
    } else {
      expect(last).toContain("no longer apply")
      expect(withdrawn).toEqual(["wiki-helper"])
    }
    // The skill's own result is whole: no truncation marker between its start and end.
    const skillResult = last.slice(last.indexOf("RULE-START"), last.indexOf("RULE-END"))
    if (last.includes("RULE-START")) expect(skillResult).not.toContain("older tool output truncated")
  })

  test("history fitting never truncates loaded instructions: others shrink first, then the skill goes whole", () => {
    const skill = { assistant: call("wiki-helper"), ok: true, result: "RULE-START " + "keep. ".repeat(400) + "RULE-END", skill: "wiki-helper" }
    const file = { assistant: "{}", ok: true, result: "filler ".repeat(2_000) }
    const base = "base prompt"
    const roomy = fitHistory(base, [skill, file], 2_000)!
    expect(roomy[0]).toEqual(skill)
    expect(roomy[1]!.result).toContain("older tool output truncated")
    // Too small for the instructions themselves: they are replaced by an explicit notice, never cut.
    const tight = fitHistory(base, [skill, file], 600)!
    expect(tight.some(entry => entry.result.includes("RULE-START"))).toBe(false)
    expect(tight.some(entry => entry.result === SKILL_DROPPED_RESULT)).toBe(true)
    expect(tight.every(entry => entry.skill === undefined)).toBe(true)
  })

  test("pinned instructions are kept and the file result is shrunk when only one has to give", async () => {
    writeFileSync(join(root, "big.txt"), "filler line of ordinary text\n".repeat(2_200))
    const withdrawn: string[] = []
    const skillTool: SkillToolProvider = {
      catalog: [{ name: "wiki-helper", description: "Compile wiki pages" }],
      load: async () => ({ ok: true, text: "RULE-START short rule RULE-END" }),
      withdrawn(name) { withdrawn.push(name) },
    }
    const subject = harness({ role: "main", responses: [call("wiki-helper"), JSON.stringify({ type: "tool", name: "read", input: { path: "big.txt", startLine: 1, maxLines: 2000 } }), JSON.stringify({ type: "tool", name: "read", input: { path: "big.txt", startLine: 1101, maxLines: 2000 } }), JSON.stringify({ type: "final", text: "done" })] })
    const handle = await subject.host.prepare({ ...subject.request, skillTool })
    expect(await handle.run()).toEqual({ status: "completed", text: "done" })
    expect(subject.prompts.at(-1)).toContain("RULE-START short rule RULE-END")
    expect(subject.prompts.at(-1)).toContain("older tool output truncated")
    expect(withdrawn).toEqual([])
  })

  test("a large catalog is capped and ranked, and a catalog that would overflow is dropped instead of failing the turn", async () => {
    const many: SkillToolProvider = {
      catalog: Array.from({ length: 40 }, (_, i) => ({ name: `skill-${String(i).padStart(2, "0")}`, description: `Generic helper number ${i} ` + "with a long description ".repeat(30) })),
      load: async () => ({ ok: true, text: "x" }),
    }
    // Ranked against the provider's query (the latest message), not the whole task text.
    const ranked = harness({ role: "main", taskText: "earlier conversation mentions skill 05 a lot: skill 05 skill 05", responses: [JSON.stringify({ type: "final", text: "ok" })] })
    expect(await (await ranked.host.prepare({ ...ranked.request, skillTool: { ...many, query: "please use skill 37 for this" } })).run()).toEqual({ status: "completed", text: "ok" })
    const listed = ranked.prompts[0]!.split("\n").filter(line => /^- skill-\d\d: /u.test(line))
    expect(listed).toHaveLength(SKILL_CATALOG_LIMIT)
    expect(listed[0]).toStartWith("- skill-37: ")
    expect(listed.every(line => line.length <= "- skill-00: ".length + 160)).toBe(true)

    // A long Korean task that fits on its own but not with the catalog: the turn runs without skills.
    const longText = "가나다라 ".repeat(2_050)
    const plain = harness({ role: "main", taskText: longText, responses: [JSON.stringify({ type: "final", text: "ok" })] })
    expect(await (await plain.host.prepare(plain.request)).run()).toEqual({ status: "completed", text: "ok" })
    const crowded = harness({ role: "main", taskText: longText, responses: [JSON.stringify({ type: "final", text: "ok" })] })
    expect(await (await crowded.host.prepare({ ...crowded.request, skillTool: many })).run()).toEqual({ status: "completed", text: "ok" })
    expect(estimateTokens(plain.prompts[0]!)).toBeLessThanOrEqual(8192)
    expect(crowded.prompts[0]).not.toContain("Available skills")
    expect(crowded.prompts[0]).not.toContain("- skill: allowed")
  })

  test("a refused load is answered from the turn's record when repeated, without loading again", async () => {
    let loads = 0
    const skillTool: SkillToolProvider = {
      catalog: [{ name: "wiki-helper", description: "Compile wiki pages" }],
      load: async () => { loads++; return { ok: false, error: "Tool refused: not usable now." } },
    }
    const subject = harness({ role: "main", responses: [call("wiki-helper"), call("wiki-helper"), JSON.stringify({ type: "final", text: "done" })] })
    expect(await (await subject.host.prepare({ ...subject.request, skillTool })).run()).toEqual({ status: "completed", text: "done" })
    expect(loads).toBe(1)
    expect(subject.prompts[2]).toContain("not usable now")
  })

  test("sticky skills are in the input as already loaded; a reload is answered from the turn, not loaded again", async () => {
    const loads: string[] = []
    const delivered: string[] = []
    const skillTool: SkillToolProvider = {
      catalog: [{ name: "wiki-helper", description: "Compile wiki pages" }, { name: "other", description: "Other" }],
      sticky: [{ name: "wiki-helper", text: "STICKY_RULE" }, { name: "not-listed", text: "NEVER" }],
      async load(name) { loads.push(name); return { ok: true, text: "x" } },
      delivered(name) { delivered.push(name) },
    }
    const subject = harness({ role: "main", responses: [call("wiki-helper"), JSON.stringify({ type: "final", text: "done" })] })
    expect(await (await subject.host.prepare({ ...subject.request, skillTool })).run()).toEqual({ status: "completed", text: "done" })
    expect(subject.prompts[0]).toContain("still active from an earlier turn")
    expect(subject.prompts[0]).toContain("STICKY_RULE")
    expect(subject.prompts[0]).not.toContain("NEVER")
    expect(subject.prompts[1]).toContain("Skill already loaded in this turn")
    expect(loads).toEqual([])
    expect(delivered).toEqual(["wiki-helper"])
  })

  test("a loaded skill's bundled file is read through the skill tool; before loading it is refused", async () => {
    const reads: string[] = []
    const skillTool: SkillToolProvider = {
      catalog: [{ name: "wiki-helper", description: "Compile wiki pages" }],
      async load() { return { ok: true, text: "See references/style.md" } },
      async readResource(name, path) { reads.push(`${name}:${path}`); return { ok: true, text: "STYLE_RULE" } },
    }
    const read = (path: string) => JSON.stringify({ type: "tool", name: "skill", input: { name: "wiki-helper", path } })
    const subject = harness({ role: "main", responses: [read("references/style.md"), call("wiki-helper"), read("references/style.md"), JSON.stringify({ type: "final", text: "done" })] })
    expect(await (await subject.host.prepare({ ...subject.request, skillTool })).run()).toEqual({ status: "completed", text: "done" })
    expect(subject.prompts[1]).toContain("load the skill first")
    expect(subject.prompts[3]).toContain("STYLE_RULE")
    expect(reads).toEqual(["wiki-helper:references/style.md"])
    // Traversal and absolute paths are refused by input validation before any read.
    for (const path of ["../x.md", "/etc/passwd", "a/../../b"]) {
      const bad = harness({ role: "main", responses: [call("wiki-helper"), read(path)] })
      expect(await (await bad.host.prepare({ ...bad.request, skillTool })).run()).toMatchObject({ status: "failed" })
    }
  })

  test("other roles, an empty catalog and no provider offer no skill tool, and a skill call fails closed", async () => {
    for (const [role, skillTool] of [["worker", provider([])], ["main", { catalog: [], load: async () => ({ ok: true as const, text: "x" }) }], ["main", undefined]] as const) {
      const subject = harness({ role, responses: [call("wiki-helper")] })
      const handle = await subject.host.prepare({ ...subject.request, ...(skillTool ? { skillTool } : {}) })
      const outcome = await handle.run()
      expect(subject.prompts[0]).not.toContain("- skill:")
      expect(subject.prompts[0]).not.toContain("Available skills")
      expect(outcome).toEqual({ status: "failed", error: "Otter tool denied by role policy before effects" })
    }
  })
})

describe("chat execution through the action gate", () => {
  const CHAT_TOOLS = ["read", "list", "glob", "grep", "memory", "write", "edit", "bash"]
  const final = (text: string) => JSON.stringify({ type: "final", text })
  const bash = (command: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "tool", name: "bash", input: { command, ...extra } })
  function gate(decide: (action: ChatAction) => boolean, output = "exit 0\nok", extra: Partial<ActionGate> = {}) {
    const approvals: ChatAction[] = []
    const runs: string[] = []
    const value: ActionGate = {
      async approve(action) { approvals.push(action); return decide(action) ? { allow: true } : { allow: false, reason: "denied" } },
      async run(action) { runs.push(action.command); return { ok: true, text: output } },
      ...extra,
    }
    return { value, approvals, runs }
  }

  async function bindModelApiSkill(subject: ReturnType<typeof harness>) {
    root = realpathSync.native(root)
    const directory = join(root, ".agents", "skills", "api-review")
    mkdirSync(directory, { recursive: true })
    const path = join(directory, "SKILL.md")
    writeFileSync(path, "---\nname: api-review\ndescription: Review through an approved model request\nallowed-tools: [model_api]\n---\nUse model_api within its approval gate.\n")
    const runtime = createCliRuntime({ worktree: root, engine: "local", model: "fixture-model" })
    const store = attachAdmission(runtime, OWNER, { engine: "local", model: "fixture-model" })
    const roots = await resolveSkillRoots({ projectRoot: root })
    const session = await SkillSession.create({ roots, store, terminal: {
      stdinIsTTY: true, stderrIsTTY: true, choose: async () => 0,
    } }, new AbortController().signal)
    witnessSessions.push(session)
    const prepared = await session.prepare("api-review", new AbortController().signal)
    const { handlers: _handlers, skillContext: _context, ...scope } = subject.request
    const bound = bindSkillInvocation(prepared, scope, subject.policy)
    witnessContexts.push(bound.context)
    subject.request.skillContext = bound.context
    subject.request.handlers = bound.handlers
    return path
  }

  test("an approved write happens and its result returns to the model; a denied write changes nothing and the turn goes on", async () => {
    const allowed = gate(() => true)
    const subject = harness({ role: "main", tools: CHAT_TOOLS, responses: [toolWrite("notes.md", "hello\n"), final("written")] })
    expect(await (await subject.host.prepare({ ...subject.request, actionGate: allowed.value })).run()).toEqual({ status: "completed", text: "written" })
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("hello\n")
    expect(allowed.approvals).toEqual([{ tool: "write", path: "notes.md", content: "hello\n" }])
    expect(subject.prompts[0]).toContain("- bash: allowed")
    expect(subject.prompts[0]).toContain("File modification is available through the allowed Otter write/edit tools")
    expect(subject.prompts[0]).toContain("Native filesystem restrictions do not mean that an allowed Otter write/edit tool is unavailable")
    expect(subject.prompts[0]).toContain("does not grant native access or bypass approval")
    expect(subject.prompts[1]).toContain("Created file")

    const denied = gate(() => false)
    const refused = harness({ role: "main", tools: CHAT_TOOLS, responses: [toolWrite("other.md", "x"), final("understood")] })
    expect(await (await refused.host.prepare({ ...refused.request, actionGate: denied.value })).run()).toEqual({ status: "completed", text: "understood" })
    expect(existsSync(join(root, "other.md"))).toBe(false)
    expect(refused.prompts[1]).toContain("The user denied this action: denied")
  })

  test("bash runs only through the gate after approval and returns the command result; options reach the gate", async () => {
    const subject = gate(() => true, "exit 1\n1 failing test")
    const run = harness({ role: "main", tools: CHAT_TOOLS, responses: [bash("bun test", { timeoutSeconds: 30 }), bash("vim notes.md", { interactive: true }), final("checked")] })
    expect(await (await run.host.prepare({ ...run.request, actionGate: subject.value })).run()).toEqual({ status: "completed", text: "checked" })
    expect(subject.approvals).toEqual([
      { tool: "bash", command: "bun test", interactive: false, timeoutMs: 30_000 },
      { tool: "bash", command: "vim notes.md", interactive: true, timeoutMs: 120_000 },
    ])
    expect(subject.runs).toEqual(["bun test", "vim notes.md"])
    expect(run.prompts[0]).toContain("Run requested commands and tests through the Otter bash tool")
    expect(run.prompts[0]).not.toContain("Main and reviewer roles are read-only")
    expect(run.prompts[0]).not.toContain("verification are controlled by the outer")
    expect(run.prompts[1]).toContain("1 failing test")

    const denied = gate(() => false)
    const refused = harness({ role: "main", tools: CHAT_TOOLS, responses: [bash("rm -rf build"), final("ok")] })
    expect(await (await refused.host.prepare({ ...refused.request, actionGate: denied.value })).run()).toEqual({ status: "completed", text: "ok" })
    expect(denied.runs).toEqual([])
  })

  test("model_api approves the exact prepared destination and prompt before running, then returns the result", async () => {
    const input = { target: "review", model: "fixture-model", prompt: "Review this exact text.\nDo not change it.", maxOutputTokens: 256, timeoutSeconds: 30 }
    let endpoint = "https://review.example.test/v1/chat/completions"
    const events: string[] = []
    const prepared: ModelApiAction[] = []
    const executed: ModelApiAction[] = []
    const subject = gate(action => {
      events.push("approve")
      expect(action).toBe(prepared.at(-1)!)
      expect(Object.isFrozen(action)).toBe(true)
      // Changing configuration during approval must not retarget the prepared request.
      endpoint = "https://changed.example.test/v1/chat/completions"
      return true
    }, undefined, { modelApi: {
      prepare(value) {
        events.push("prepare")
        const action: ModelApiAction = Object.freeze({ tool: "model_api", ...value, url: endpoint, protocol: "openai-compatible", apiKeyEnv: "FIXTURE_MODEL_KEY" })
        prepared.push(action)
        return action
      },
      async run(action, signal) {
        events.push("run")
        expect(signal.aborted).toBe(false)
        expect(action).toBe(prepared.at(-1)!)
        executed.push(action)
        return { ok: true, text: "API_REVIEW_RESULT" }
      },
    } })
    const run = harness({ role: "main", tools: [...CHAT_TOOLS, "model_api"], responses: [
      JSON.stringify({ type: "tool", name: "model_api", input }), final("review complete"),
    ] })
    expect(await (await run.host.prepare({ ...run.request, actionGate: subject.value })).run()).toEqual({ status: "completed", text: "review complete" })
    expect(events).toEqual(["prepare", "approve", "run"])
    expect(executed).toEqual([{ tool: "model_api", ...input, url: "https://review.example.test/v1/chat/completions", protocol: "openai-compatible", apiKeyEnv: "FIXTURE_MODEL_KEY" }])
    expect(subject.runs).toEqual([])
    expect(run.prompts[0]).toContain("- model_api: allowed")
    expect(run.prompts[1]).toContain("API_REVIEW_RESULT")
  })

  test("model_api denial performs no API request and returns the denial to the model", async () => {
    const inputs: ModelApiInput[] = []
    let requests = 0
    const subject = gate(() => false, undefined, { modelApi: {
      prepare(input) { inputs.push(input); return Object.freeze({ tool: "model_api", ...input, url: "http://127.0.0.1:11434/api/chat", protocol: "ollama" }) },
      async run() { requests++; return { ok: true, text: "must not run" } },
    } })
    const run = harness({ role: "main", tools: [...CHAT_TOOLS, "model_api"], responses: [
      JSON.stringify({ type: "tool", name: "model_api", input: { target: "local", model: "fixture-model", prompt: "hello" } }), final("denial respected"),
    ] })
    expect(await (await run.host.prepare({ ...run.request, actionGate: subject.value })).run()).toEqual({ status: "completed", text: "denial respected" })
    expect(inputs).toEqual([{ target: "local", model: "fixture-model", prompt: "hello", maxOutputTokens: 1024, timeoutSeconds: 120 }])
    expect(subject.approvals).toHaveLength(1)
    expect(requests).toBe(0)
    expect(run.prompts[1]).toContain("The user denied this action: denied")
  })

  test("model_api cancellation during approval prevents the request even if approval returns allow", async () => {
    let requests = 0
    let approvalSignal: AbortSignal | undefined
    const run = harness({ role: "main", tools: [...CHAT_TOOLS, "model_api"], responses: [
      JSON.stringify({ type: "tool", name: "model_api", input: { target: "local", model: "fixture-model", prompt: "hello" } }),
    ] })
    const subject = gate(() => true, undefined, {
      async approve(_action, signal) {
        approvalSignal = signal
        await handle.requestCancel("session closed during approval", Date.now() + 1000)
        return { allow: true }
      },
      modelApi: {
        prepare(input) { return Object.freeze({ tool: "model_api", ...input, url: "http://127.0.0.1:11434/api/chat", protocol: "ollama" }) },
        async run() { requests++; return { ok: true, text: "must not run" } },
      },
    })
    const handle = await run.host.prepare({ ...run.request, actionGate: subject.value })
    expect(await handle.run()).toMatchObject({ status: "cancelled" })
    expect(approvalSignal?.aborted).toBe(true)
    expect(requests).toBe(0)
    expect(run.prompts).toHaveLength(1)
  })

  test.each(["denial", "preparation failure"] as const)("skill-bound model_api settles %s without a request and continues the turn", async failure => {
    let requests = 0
    const subject = gate(() => false, undefined, { modelApi: {
      prepare(input) {
        if (failure === "preparation failure") throw new Error("invalid fixture target")
        return Object.freeze({ tool: "model_api", ...input, url: "http://127.0.0.1:11434/api/chat", protocol: "ollama" })
      },
      async run() { requests++; return { ok: true, text: "must not run" } },
    } })
    const run = harness({ role: "main", tools: [...CHAT_TOOLS, "model_api"], responses: [
      JSON.stringify({ type: "tool", name: "model_api", input: { target: "local", model: "fixture-model", prompt: "hello" } }), final("handled without an API request"),
    ] })
    await bindModelApiSkill(run)
    expect(await (await run.host.prepare({ ...run.request, actionGate: subject.value })).run()).toEqual({ status: "completed", text: "handled without an API request" })
    expect(requests).toBe(0)
    expect(subject.approvals).toHaveLength(failure === "denial" ? 1 : 0)
    expect(run.prompts).toHaveLength(2)
    expect(run.prompts[1]).toContain(failure === "denial" ? "The user denied this action: denied" : "Model API target is unavailable or invalid")
    expect(run.observed.results).toBe(1)
  })

  test("skill-bound model_api revalidates skill content after approval before any request", async () => {
    let requests = 0
    let skillPath = ""
    const subject = gate(() => {
      writeFileSync(skillPath, "---\nname: api-review\ndescription: Changed during approval\nallowed-tools: [model_api]\n---\nChanged instructions.\n")
      return true
    }, undefined, { modelApi: {
      prepare(input) { return Object.freeze({ tool: "model_api", ...input, url: "http://127.0.0.1:11434/api/chat", protocol: "ollama" }) },
      async run() { requests++; return { ok: true, text: "must not run" } },
    } })
    const run = harness({ role: "main", tools: [...CHAT_TOOLS, "model_api"], responses: [
      JSON.stringify({ type: "tool", name: "model_api", input: { target: "local", model: "fixture-model", prompt: "hello" } }),
    ] })
    skillPath = await bindModelApiSkill(run)
    expect(await (await run.host.prepare({ ...run.request, actionGate: subject.value })).run()).toMatchObject({ status: "failed" })
    expect(subject.approvals).toHaveLength(1)
    expect(requests).toBe(0)
    expect(run.prompts).toHaveLength(1)
  })

  test.each(["no gate", "no capability", "worker", "planner", "not allowed"] as const)("model_api is unavailable with %s", async boundary => {
    let prepares = 0
    let requests = 0
    const subject = gate(() => true, undefined, { modelApi: {
      prepare(input) { prepares++; return Object.freeze({ tool: "model_api", ...input, url: "http://127.0.0.1:11434/api/chat", protocol: "ollama" }) },
      async run() { requests++; return { ok: true, text: "must not run" } },
    } })
    const actionGate = boundary === "no gate" ? undefined : boundary === "no capability" ? gate(() => true).value : subject.value
    const run = harness({ role: boundary === "worker" || boundary === "planner" ? boundary : "main", tools: boundary === "not allowed" ? CHAT_TOOLS : [...CHAT_TOOLS, "model_api"], responses: [
      JSON.stringify({ type: "tool", name: "model_api", input: { target: "local", model: "fixture-model", prompt: "hello" } }),
    ] })
    expect(await (await run.host.prepare({ ...run.request, ...(actionGate ? { actionGate } : {}) })).run()).toEqual({ status: "failed", error: "Otter tool denied by role policy before effects" })
    expect(run.prompts[0]).not.toContain("- model_api:")
    expect(subject.approvals).toEqual([])
    expect(prepares).toBe(0)
    expect(requests).toBe(0)
  })

  test("multiedit is approved once as a whole and applies all edits or none; knowledge/raw is never written", async () => {
    writeFileSync(join(root, "m1.ts"), "const a = 1\nconst b = 2\n")
    writeFileSync(join(root, "m2.ts"), "export const c = 3\n")
    const multiedit = (edits: Array<{ path: string; oldText: string; newText: string }>) => JSON.stringify({ type: "tool", name: "multiedit", input: { edits } })
    const allowed = gate(() => true)
    const run = harness({ role: "main", tools: CHAT_TOOLS, responses: [
      multiedit([{ path: "m1.ts", oldText: "const a = 1", newText: "const a = 10" }, { path: "m1.ts", oldText: "const b = 2", newText: "const b = 20" }, { path: "m2.ts", oldText: "c = 3", newText: "c = 30" }]),
      multiedit([{ path: "m1.ts", oldText: "const a = 10", newText: "X" }, { path: "m2.ts", oldText: "missing", newText: "Y" }]),
      multiedit([{ path: "knowledge/raw/x.json", oldText: "a", newText: "b" }]),
      toolWrite("KNOWLEDGE/Raw/y.json", "{}"),
      final("edited"),
    ] })
    expect(await (await run.host.prepare({ ...run.request, actionGate: allowed.value })).run()).toEqual({ status: "completed", text: "edited" })
    expect(allowed.approvals[0]).toEqual({ tool: "multiedit", edits: [
      { path: "m1.ts", oldText: "const a = 1", newText: "const a = 10" }, { path: "m1.ts", oldText: "const b = 2", newText: "const b = 20" }, { path: "m2.ts", oldText: "c = 3", newText: "c = 30" },
    ] })
    expect(readFileSync(join(root, "m1.ts"), "utf8")).toBe("const a = 10\nconst b = 20\n")
    expect(readFileSync(join(root, "m2.ts"), "utf8")).toBe("export const c = 30\n")
    expect(run.prompts[1]).toContain("Edited 2 file(s) with 3 change(s)")
    // The second batch had one non-matching edit: nothing changed, including the edit that would have matched.
    expect(run.prompts[2]).toContain("edit 2 (m2.ts) text must match exactly once; nothing was changed")
    expect(readFileSync(join(root, "m1.ts"), "utf8")).toBe("const a = 10\nconst b = 20\n")
    expect(run.prompts[3]).toContain("knowledge/raw/ is immutable")
    expect(run.prompts[4]).toContain("knowledge/raw/ is immutable")
    expect(existsSync(join(root, "KNOWLEDGE"))).toBe(false)
    expect(run.prompts[0]).toContain("- multiedit: allowed")

    // Not offered without a gate or to other roles.
    const worker = harness({ role: "worker", responses: [final("x")] })
    await (await worker.host.prepare(worker.request)).run()
    expect(worker.prompts[0]).not.toContain("- multiedit: allowed")
  })

  test("every executed tool reaches the outcome history with its exit code; a denied call never ran and is not recorded", async () => {
    const facts: CliToolOutcomeFact[] = []
    const subject = gate(action => action.tool !== "write", "exit 2\nfailed", { run: async () => ({ ok: false, text: "exit 2\nfailed", exitCode: 2 }) })
    const run = harness({ role: "main", tools: CHAT_TOOLS, recordOutcome: fact => facts.push(fact),
      responses: [JSON.stringify({ type: "tool", name: "read", input: { path: "seed.txt" } }), bash("bun test"), toolWrite("x.md", "x"), final("done")] })
    writeFileSync(join(root, "seed.txt"), "seed\n")
    expect(await (await run.host.prepare({ ...run.request, actionGate: subject.value })).run()).toEqual({ status: "completed", text: "done" })
    expect(facts.map(fact => [fact.tool, fact.ok, fact.exitCode])).toEqual([["read", true, undefined], ["bash", false, 2]])
    for (const fact of facts) {
      expect(fact.sessionID).toBe(OWNER)
      expect(fact.finishedAt).toBeGreaterThanOrEqual(fact.startedAt)
      expect(Object.keys(fact).sort()).toEqual(["callID", "finishedAt", "ok", "sessionID", "startedAt", "tool", ...(fact.exitCode !== undefined ? ["exitCode"] : [])].sort())
    }
  })

  test.each([true, false])("multiread crossing the remaining budget asks before any child read (grant=%s)", async grant => {
    writeFileSync(join(root, "seed.txt"), "seed")
    const read = JSON.stringify({ type: "tool", name: "read", input: { path: "seed.txt" } })
    const batch = JSON.stringify({ type: "tool", name: "multiread", input: { reads: [{ path: "seed.txt" }, { path: "seed.txt" }] } })
    const asked: Array<[number, number, number]> = []
    const run = harness({ role: "main", tools: CHAT_TOOLS, responses: [...Array.from({ length: 23 }, () => read), batch, final("done")] })
    const approval = gate(() => true, undefined, { extendRounds: async (used, rounds) => {
      asked.push([used, rounds, run.observed.before])
      return grant
    } })
    const result = await (await run.host.prepare({ ...run.request, actionGate: approval.value })).run()
    expect(asked).toEqual([[23, 24, 23]])
    expect(result).toEqual(grant ? { status: "completed", text: "done" } : { status: "failed", error: "Otter tool round limit reached" })
    expect(run.observed.before).toBe(grant ? 25 : 23)
    expect(run.observed.results).toBe(grant ? 25 : 23)
    expect(run.prompts).toHaveLength(grant ? 25 : 24)
  })

  test("headless planning multiread cannot extend its read budget", async () => {
    writeFileSync(join(root, "seed.txt"), "seed")
    const read = JSON.stringify({ type: "tool", name: "read", input: { path: "seed.txt" } })
    const batch = JSON.stringify({ type: "tool", name: "multiread", input: { reads: [{ path: "seed.txt" }, { path: "seed.txt" }] } })
    let asked = 0
    const approval = gate(() => true, undefined, { extendRounds: async () => { asked++; return true } })
    const run = harness({ role: "planner", responses: [...Array.from({ length: 23 }, () => read), batch] })
    expect(await (await run.host.prepare({ ...run.request, actionGate: approval.value })).run()).toEqual({ status: "failed", error: "Otter tool round limit reached" })
    expect(asked).toBe(0)
    expect(run.observed.before).toBe(23)
    expect(run.observed.results).toBe(23)
  })

  test("at the tool-call limit chat asks to continue; granted rounds keep the turn going, a refusal ends it", async () => {
    const reads = Array.from({ length: 25 }, () => JSON.stringify({ type: "tool", name: "list", input: { path: "." } }))
    const asked: Array<[number, number]> = []
    const granting = gate(() => true, undefined, { extendRounds: async (used: number, rounds: number) => { asked.push([used, rounds]); return true } })
    const run = harness({ role: "main", tools: CHAT_TOOLS, responses: [...reads, final("listed")] })
    expect(await (await run.host.prepare({ ...run.request, actionGate: granting.value })).run()).toEqual({ status: "completed", text: "listed" })
    expect(asked).toEqual([[24, 24]])

    const refusing = gate(() => true, undefined, { extendRounds: async () => false })
    const stopped = harness({ role: "main", tools: CHAT_TOOLS, responses: [...reads, final("listed")] })
    expect(await (await stopped.host.prepare({ ...stopped.request, actionGate: refusing.value })).run()).toEqual({ status: "failed", error: "Otter tool round limit reached" })

    // Without a gate (workers, workflows) the limit is final.
    const worker = harness({ role: "worker", responses: [...reads, final("listed")] })
    expect(await (await worker.host.prepare(worker.request)).run()).toEqual({ status: "failed", error: "Otter tool round limit reached" })
  })

  test("without a gate main has no write, edit or bash, and other roles never get bash even with a gate", async () => {
    const noGate = harness({ role: "main", tools: CHAT_TOOLS, responses: [bash("ls")] })
    expect(await (await noGate.host.prepare(noGate.request)).run()).toEqual({ status: "failed", error: "Otter tool denied by role policy before effects" })
    expect(noGate.prompts[0]).toContain("- bash: denied")
    expect(noGate.prompts[0]).toContain("this role has no bash tool")
    expect(noGate.prompts[0]).toContain("- write: denied")
    expect(noGate.prompts[0]).toContain("File modification is unavailable in this request")
    expect(noGate.prompts[0]).not.toContain("File modification is available through")
    const noGateWrite = harness({ role: "main", tools: CHAT_TOOLS, responses: [toolWrite("x.md", "x")] })
    expect(await (await noGateWrite.host.prepare(noGateWrite.request)).run()).toMatchObject({ status: "failed" })
    expect(existsSync(join(root, "x.md"))).toBe(false)

    const unused = gate(() => true)
    const worker = harness({ role: "worker", tools: CHAT_TOOLS, responses: [bash("ls")] })
    expect(await (await worker.host.prepare({ ...worker.request, actionGate: unused.value })).run()).toMatchObject({ status: "failed" })
    expect(unused.approvals).toEqual([])
  })
})
