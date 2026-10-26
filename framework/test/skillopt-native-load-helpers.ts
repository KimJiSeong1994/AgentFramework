import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createCliHost } from "../src/hosts/cli-host.ts"
import { createCodexProfile } from "../src/hosts/codex-profile.ts"
import { humanDecision, type DecisionBinding, type OperatorDecision } from "../src/hosts/operator.ts"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionRequest } from "../src/hosts/types.ts"
import type { ExecutionRunStore, ExecutionRunStatus } from "../src/hosts/run-state.ts"
import { attachAdmission, detachAdmission, resumeAdmission } from "../src/sessions/admission.ts"
import type { SessionStore } from "../src/sessions/store.ts"
import { bindSkillInvocation, finishSkillInvocation, type SkillInvocationContext } from "../src/skills/context.ts"
import { resolveSkillRoots } from "../src/skills/roots.ts"
import { SkillSession } from "../src/skills/session.ts"
import { NO_SKILL_TRUST } from "../src/skills/trust.ts"
import { NATIVE_PROTOCOL_SHA256 } from "../src/skillopt/dataset.ts"
import {
  completeNativeSkillLoadWitness, prepareNativeSkillLoadCanary, registerNativeSkillLoadWitness,
  type NativeSkillLoadCanaryPlan,
} from "../src/skillopt/load-verification.ts"
import {
  authorizeNativePromotionApproval, previewNativePromotionApproval,
  type NativePromotionApprovalOperation, type NativePromotionAuthorizationResult, type PromotionBindings,
} from "../src/skillopt/promotion.ts"
import { sha256 } from "../src/skillopt/pilot.ts"
import { makeSkillOptCanaryFixture, successfulSkillOptCanaryResponse } from "./skillopt-canary-fixtures.ts"
import { withTerminalLine } from "./operator-helpers.ts"

export const SYNTHETIC_ORIGINAL_SKILL = "---\nname: llm-wiki\ndescription: Preserve original test wiki guidance\nallowed-tools: [read]\n---\nUse only the original synthetic wiki instructions.\n"
export const SYNTHETIC_CANDIDATE_SKILL = "---\nname: llm-wiki\ndescription: Candidate test wiki guidance\nallowed-tools: [read]\n---\nUse the candidate synthetic wiki instructions exactly.\n"
export const SYNTHETIC_CODEX_MODEL = "gpt-5.6-sol"
export const SYNTHETIC_CODEX_RUNTIME = "0.163.0"
const SYNTHETIC_CODEX_CLI_SOURCE = `
const fs = require("node:fs")
const path = require("node:path")
let prompt = ""
;(async () => {
  for await (const chunk of process.stdin) prompt += chunk.toString("utf8")
  const args = process.argv.slice(2)
  const root = path.dirname(process.argv[1])
  if (args.length === 1 && args[0] === "--version") {
    fs.appendFileSync(path.join(root, "probes.jsonl"), JSON.stringify({ args }) + "\\n")
    process.stdout.write("codex-cli ${SYNTHETIC_CODEX_RUNTIME}\\n")
    return
  }
  fs.appendFileSync(path.join(root, "invocations.jsonl"), JSON.stringify({ args, prompt }) + "\\n")
  const response = fs.readFileSync(path.join(root, "response.json"), "utf8")
  const records = [
    { type: "thread.started", thread_id: "synthetic-thread" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: response } },
    { type: "turn.completed", usage: {} },
  ]
  process.stdout.write(records.map(record => JSON.stringify(record)).join("\\n") + "\\n")
})().catch(() => { process.exitCode = 1 })
`
const syntheticCodexExecutableBytes = (): Buffer => Buffer.from(`#!${process.execPath}\n${SYNTHETIC_CODEX_CLI_SOURCE}\n`, "utf8")
export const SYNTHETIC_CODEX_EXECUTABLE_SHA256 = sha256(syntheticCodexExecutableBytes())
const REAL_GIT = Bun.which("git")

function gitExecutable(): string {
  if (!REAL_GIT) throw new Error("Git executable is required for the synthetic native-load fixture")
  return realpathSync.native(REAL_GIT)
}

function createSyntheticCodexCli(): Readonly<{ directory: string; executableSha256: string }> {
  const git = gitExecutable()
  const directory = mkdtempSync(join(tmpdir(), "skillopt-synthetic-codex-"))
  try {
    const executable = join(directory, "codex")
    const bytes = syntheticCodexExecutableBytes()
    writeFileSync(executable, bytes, { mode: 0o700, flag: "wx" })
    chmodSync(executable, 0o700)
    symlinkSync(git, join(directory, "git"))
    writeFileSync(join(directory, "response.json"), "{}", { mode: 0o600, flag: "wx" })
    return Object.freeze({ directory, executableSha256: sha256(readFileSync(executable)) })
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

/** Test-only runtime for transactions bound to the disposable synthetic Codex subprocess. */
export function createSyntheticNativeRuntime(projectRoot: string) {
  return createCliRuntime({ worktree: projectRoot, engine: "codex", model: SYNTHETIC_CODEX_MODEL })
}

/** Initialize/advance only the private synthetic project's Git baseline for SkillSession's project-skill capture. */
export function initializeSyntheticSkillProject(projectRoot: string): void {
  execFileSync(gitExecutable(), ["init", "--quiet"], {
    cwd: projectRoot,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: "pipe",
  })
}

export function commitSyntheticSkillBaseline(projectRoot: string, message: string): void {
  const git = (args: string[]) => execFileSync(gitExecutable(), ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "SkillOpt Test",
      GIT_AUTHOR_EMAIL: "skillopt@example.test",
      GIT_COMMITTER_NAME: "SkillOpt Test",
      GIT_COMMITTER_EMAIL: "skillopt@example.test",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdio: "pipe",
  })
  git(["add", "--", ".agents/skills/llm-wiki/SKILL.md"])
  git(["commit", "--quiet", "-m", message])
}

export type SyntheticPromotionOwner = Readonly<{
  runtime: ReturnType<typeof createCliRuntime>
  store: SessionStore
  close: () => Promise<boolean>
}>

export function createSyntheticPromotionOwner(projectRoot: string, sessionID = `skillopt-approval-owner-${randomUUID()}`): SyntheticPromotionOwner {
  const runtime = createSyntheticNativeRuntime(projectRoot)
  let store = attachAdmission(runtime, sessionID, { engine: "codex", model: SYNTHETIC_CODEX_MODEL })
  if (store.metadata.held) store = resumeAdmission(runtime, sessionID)
  let closed = false
  return Object.freeze({
    runtime,
    store,
    async close() {
      if (closed) return true
      closed = await detachAdmission(runtime, sessionID, store.epoch, "synthetic promotion approval fixture complete")
      return closed
    },
  })
}

/** Exercise the production preview -> terminal reader -> fixed authorization consumer path, with no proof factory. */
export async function readSyntheticNativeDecision(binding: DecisionBinding): Promise<OperatorDecision> {
  return withTerminalLine(
    `APPROVE ${binding.workflowID} ${binding.subject.sha256}`,
    () => humanDecision("approve", binding),
  )
}

export async function approveSyntheticNativePromotion(input: Readonly<{
  common: {
    targetPath: string
    transactionRoot: string
    nativeHelperPath: string
    nativeHelperSha256: string
    bindings: PromotionBindings
  }
  owner: SessionStore
  operation: NativePromotionApprovalOperation
  runDeadlineAt: number
  candidateBytes?: Uint8Array
  evidence?: Readonly<{ qualification: { path: string; sha256: string }; review: { path: string; sha256: string } }>
}>): Promise<NativePromotionAuthorizationResult> {
  const preview = await previewNativePromotionApproval({
    ...input.common,
    owner: input.owner,
    operation: input.operation,
    runDeadlineAt: input.runDeadlineAt,
    ...(input.candidateBytes ? { candidateBytes: input.candidateBytes } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  })
  const receipt = await readSyntheticNativeDecision(preview.decisionBinding)
  return authorizeNativePromotionApproval({ preview: preview.preview, owner: input.owner, receipt })
}

export function syntheticNativeProfileBindings(): Pick<PromotionBindings,
  "nativeEngine" | "nativeModel" | "nativeProfileId" | "nativeProfileSha256" | "nativeRuntimeVersion" | "nativeExecutableSha256"> {
  const profile = createCodexProfile(SYNTHETIC_CODEX_MODEL)
  return {
    nativeEngine: "codex",
    nativeModel: SYNTHETIC_CODEX_MODEL,
    nativeProfileId: "codex-restricted-read.v1",
    nativeProfileSha256: profile.catalogHash,
    nativeRuntimeVersion: SYNTHETIC_CODEX_RUNTIME,
    nativeExecutableSha256: SYNTHETIC_CODEX_EXECUTABLE_SHA256,
  }
}

/** Mint a native canary plan over exact private transaction bytes and the reusable synthetic dev fixture pack. */
export function prepareSyntheticNativeCanary(input: Readonly<{
  projectRoot: string
  bindings: PromotionBindings
  skillBytes: Uint8Array
  operation: "apply" | "rollback"
}>): Readonly<{ plan: NativeSkillLoadCanaryPlan; fixture: ReturnType<typeof makeSkillOptCanaryFixture>["fixture"] }> {
  const fixturePack = makeSkillOptCanaryFixture()
  const plan = prepareNativeSkillLoadCanary({
    fixturePack: fixturePack.pack,
    fixtureId: fixturePack.fixture.id,
    approvedFixtureSha256: fixturePack.fixtureSha256,
    targetSkillBytes: input.skillBytes,
    projectRoot: input.projectRoot,
    bindings: input.bindings,
    operation: input.operation,
  })
  return Object.freeze({ plan, fixture: fixturePack.fixture })
}

/** Run the normal SkillSession/host witness path through real transport and a disposable synthetic Codex subprocess. */
export async function createSyntheticNativeLoadProof(input: Readonly<{
  projectRoot: string
  bindings: PromotionBindings
  skillBytes: Uint8Array
  operation: "apply" | "rollback"
  runtime: ReturnType<typeof createCliRuntime>
}>): Promise<Readonly<{
  record: Awaited<ReturnType<typeof completeNativeSkillLoadWitness>>["record"]
  bytes: Uint8Array
  sha256: string
  proof: Awaited<ReturnType<typeof completeNativeSkillLoadWitness>>["proof"]
  responseText: string
  fixture: ReturnType<typeof makeSkillOptCanaryFixture>["fixture"]
}>> {
  const expectedSha256 = input.operation === "apply" ? input.bindings.candidateSha256 : input.bindings.originalSha256
  if (sha256(input.skillBytes) !== expectedSha256 || input.bindings.witnessMode !== "native" ||
      sha256(`root:${input.projectRoot}`) !== input.bindings.rootBinding) {
    throw new Error("synthetic native load input is not bound to the private promotion transaction")
  }
  const targetPath = join(input.projectRoot, ".agents", "skills", "llm-wiki", "SKILL.md")
  if (!readFileSync(targetPath).equals(Buffer.from(input.skillBytes))) throw new Error("synthetic project skill bytes differ from the proof input")
  const { plan, fixture } = prepareSyntheticNativeCanary(input)
  if (plan.fixturePackSha256 !== input.bindings.fixturePackSha256 || plan.fixtureSha256 !== input.bindings.canaryFixtureSha256 ||
      plan.protocolSha256 !== NATIVE_PROTOCOL_SHA256) throw new Error("synthetic native canary does not match approved bindings")
  const responseText = successfulSkillOptCanaryResponse(fixture)
  const profile = createCodexProfile(input.bindings.nativeModel)
  const nativeContext = input.runtime.policy.resolve("main").nativeContext
  if (input.bindings.nativeEngine !== "codex" || input.bindings.nativeModel !== SYNTHETIC_CODEX_MODEL ||
      input.bindings.nativeRuntimeVersion !== SYNTHETIC_CODEX_RUNTIME ||
      !nativeContext || nativeContext.identity !== input.bindings.nativeProfileSha256 ||
      profile.catalogHash !== input.bindings.nativeProfileSha256 || input.bindings.nativeProfileId !== "codex-restricted-read.v1") {
    throw new Error("synthetic native profile does not match the bound Codex identity")
  }
  const supervisorSessionID = `skillopt-native-test-${randomUUID()}`
  const nativeCli = createSyntheticCodexCli()
  if (input.bindings.nativeExecutableSha256 !== nativeCli.executableSha256 ||
      input.bindings.nativeExecutableSha256 !== SYNTHETIC_CODEX_EXECUTABLE_SHA256) {
    rmSync(nativeCli.directory, { recursive: true, force: true })
    throw new Error("synthetic Codex executable bytes do not match the bound runtime identity")
  }
  const previousPath = process.env.PATH
  process.env.PATH = nativeCli.directory
  const skillInstructions = Buffer.from(input.skillBytes).toString("utf8")
  let store: SessionStore | undefined
  let session: SkillSession | undefined
  let context: SkillInvocationContext | undefined
  try {
    const policy = createExecutionPolicy(input.runtime.config, {
      planningOnlyMain: true,
      chatExecuteMain: false,
      nativeContext,
      skillLoaderCanaryInstructions: `${skillInstructions}\n\n${plan.systemInstructions}`,
    })
    store = attachAdmission(input.runtime, supervisorSessionID, {
      engine: "codex", model: input.bindings.nativeModel,
    })
    const roots = await resolveSkillRoots({ projectRoot: input.projectRoot })
    session = await SkillSession.create({
      roots,
      store,
      trust: NO_SKILL_TRUST,
      terminal: { stdinIsTTY: true, stderrIsTTY: true, choose: async () => 0 },
    }, new AbortController().signal)
    const prepared = await session.prepare("llm-wiki", new AbortController().signal)
    const scope = {
      executionID: `skillopt-native-execution-${randomUUID()}`,
      supervisorSessionID,
      taskID: `skillopt-native-task-${randomUUID()}`,
      attemptID: `skillopt-native-attempt-${randomUUID()}`,
      generation: 1,
      role: "main" as const,
      title: "Synthetic native skill-load canary",
      cwd: input.projectRoot,
      text: plan.taskText,
      deadlineAt: Date.now() + 60_000,
      policy: policy.resolve("main"),
    }
    const bound = bindSkillInvocation(prepared, scope, policy)
    context = bound.context
    if (bound.instructions !== skillInstructions) throw new Error("normal SkillSession instructions differ from the exact promoted bytes")
    const request: ExecutionRequest = {
      ...scope,
      text: plan.taskText,
      skillContext: bound.context,
      handlers: bound.handlers,
    }
    const observation = registerNativeSkillLoadWitness(bound.context, plan)
    const responseEnvelope = JSON.stringify({ type: "final", text: responseText })
    writeFileSync(join(nativeCli.directory, "response.json"), responseEnvelope)
    const executionIntent = {
      executionId: request.executionID,
      ownerSession: supervisorSessionID,
      taskId: request.taskID,
      attemptId: request.attemptID,
      generation: request.generation,
      role: request.role,
      cwd: request.cwd,
      policyID: request.policy.id,
      kind: "host" as const,
      engine: "codex",
      profile: "legacy-unowned" as const,
      controlProfile: "estimated-input-reactive-output-v1" as const,
    }
    const status: ExecutionRunStatus = {
      generation: request.generation,
      claim: { ownerSession: supervisorSessionID, instance: "skillopt-native-test", pid: process.pid, generation: request.generation },
      executions: [executionIntent],
    }
    const runs = { status: () => status } as unknown as ExecutionRunStore
    const host = createCliHost({
      engine: "codex", model: input.bindings.nativeModel, policy, runs,
    })
    const outcome = await (await host.prepare(request)).run()
    if (outcome.status !== "completed" || outcome.text !== responseText) {
      throw new Error("synthetic Codex subprocess did not return the exact passing canary response")
    }
    const probeLog = readFileSync(join(nativeCli.directory, "probes.jsonl"), "utf8").trimEnd()
    const invocationLog = readFileSync(join(nativeCli.directory, "invocations.jsonl"), "utf8").trimEnd()
    const probes = probeLog.split("\n").map(line => JSON.parse(line) as { args: string[] })
    const invocations = invocationLog.split("\n").map(line => JSON.parse(line) as { args: string[]; prompt: string })
    if (probes.length === 0 || probes.some(probe => JSON.stringify(probe.args) !== JSON.stringify(["--version"])) ||
        invocations.length !== 1 || invocations[0]!.args[0] !== "exec" ||
        !invocations[0]!.args.includes(input.bindings.nativeModel) || invocations[0]!.prompt.length === 0) {
      throw new Error("synthetic Codex subprocess received unexpected native transport requests")
    }
    const completed = await completeNativeSkillLoadWitness({ plan, observation, hostCompletion: outcome })
    return Object.freeze({ ...completed, responseText, fixture })
  } finally {
    try {
      finishSkillInvocation(context)
      session?.close()
      if (store && !(await detachAdmission(input.runtime, supervisorSessionID, store.epoch, "synthetic native load proof complete"))) {
        throw new Error("synthetic native proof session could not be detached")
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      rmSync(nativeCli.directory, { recursive: true, force: true })
    }
  }
}
