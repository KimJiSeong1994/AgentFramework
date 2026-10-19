import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { TuiApp } from "../../src/tui/app.ts"
import { createReadlineTerminal, runInteractiveSession, type InteractiveDependencies, type Terminal } from "../../src/hosts/interactive-session.ts"
import type { ForegroundController } from "../../src/hosts/controller.ts"
import type { CliHostActivity } from "../../src/hosts/cli-progress.ts"
import type { SkillConversationInvocation } from "../../src/hosts/plan-conversation.ts"
import { createPlanConversation } from "../../src/hosts/plan-conversation.ts"
import { createForegroundController } from "../../src/hosts/controller.ts"
import { createExecutionRunStore } from "../../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../../src/hosts/tool-policy.ts"
import { createLegacyVerifierExecutor } from "../../src/orchestration/legacy-verifier.ts"
import { beginStageReservation } from "../../src/hosts/runtime.ts"
import { observeStopSettlement } from "../../src/flow/runtime.ts"
import { stateRoot } from "../../src/state/store.ts"
import { readEvents, readWorkflow } from "../../src/flow/state.ts"
import { readLedger } from "../../src/state/ledger.ts"
import { createCliRuntime } from "../../src/hosts/cli-runtime.ts"
import { assertHostAdmission } from "../../src/hosts/required-controls.ts"
import { consumeOperatorDecision, humanDecision } from "../../src/hosts/operator.ts"
import type { ExecutionRuntime } from "../../src/hosts/types.ts"
import { DEFAULT_CONFIG } from "../../src/config.ts"
import { inspectSessionAttachment, openSession, readSessionMetadata, replaySession } from "../../src/sessions/store.ts"
import { claimPreparedSkillInvocation } from "../../src/skills/session.ts"
import { readSkillTrust } from "../../src/skills/trust.ts"
import { sessionDir } from "../../src/state/store.ts"
import { readCommitted } from "../../src/workflows/commit.ts"
import { DEEP_INTERVIEW_PROMPTS, RALPLAN_PROMPTS } from "../../src/workflows/prompts/index.ts"
import { fullScript } from "../workflow-fixture.ts"

type Scenario = "approve" | "reject" | "queue" | "signal" | "ctrlc" | "restore" | "sdk-observer" | "skills" | "readline-skills" | "readline-picker" | "skill-grants" | "skill-restore" | "skill-tool-scope" | "skill-tool-cancel" | "skill-main-write" | "pause-resume" | "cancel-unconfirmed" | "paused-cancel" | "workflow-di"

const WORKFLOW_ID = "wf_pty_fixture"
const PLAN_SHA = "c0ffee0000000000000000000000000000000000000000000000000000000000"
const RESTORED_SESSION_ID = "pty-restored-session"
const SDK_SESSION_ID = "pty-retained-sdk-session"
const RESTORED_PAIR_COUNT = 102
const NOTICE_PADDING_BYTES = 850_000
const SKILL_DOCUMENT = "---\nname: pty-inspect\ndescription: Inspect the PTY fixture project\nallowed-tools: [read]\n---\nUse read-only project inspection.\n"
const CANCEL_SKILL_DOCUMENT = "---\nname: pty-cancel\ndescription: Exercise chooser cancellation\nallowed-tools: [read]\n---\nUse read-only project inspection.\n"
const TOOL_SCOPE_DOCUMENT = "---\nname: pty-scope\ndescription: Read-only scope for the PTY fixture project\nallowed-tools: [read]\n---\nUse read-only tools only.\n"
const MAIN_WRITE_DOCUMENT = "---\nname: pty-main-write\ndescription: Deliberately requests a main-role write\nallowed-tools: [write]\n---\nThis declared write scope must not override the fixed main role.\n"
const TOOL_SCOPE_PATTERN = "PTY_SCOPE_NEEDLE"
const scenario = process.env.OTTER_TUI_PTY_SCENARIO as Scenario
// Source-consent skill scenarios share the real CLI runtime, coordinator admission and project skill fixture.
// Real-controller stop scenarios: the production ForegroundController, queue, settlement routine and TUI over a deterministic
// synthetic host (no model). The fixture owns only the termination "proof" timing through a stage reservation it releases on
// a gate file, so the unconfirmed window is observable without sleeps.
const flowScenario = scenario === "pause-resume" || scenario === "cancel-unconfirmed" || scenario === "paused-cancel"
const workflowScenario = scenario === "workflow-di"
const sourceSkillScenario = scenario === "skills" || scenario === "readline-skills" || scenario === "skill-grants" || scenario === "skill-restore"
// A relaunch scenario supplies a durable worktree so a second process observes the first process's real session state.
const persistentWorktree = process.env.OTTER_TUI_PTY_WORKTREE
const sessionPrefix = process.env.OTTER_TUI_PTY_SESSION_PREFIX ?? "pty-session"
const resultPath = process.env.OTTER_TUI_PTY_RESULT
const eventsPath = process.env.OTTER_TUI_PTY_EVENTS
const gatePath = process.env.OTTER_TUI_PTY_GATE
const termiosReleasePath = process.env.OTTER_TUI_PTY_TERMIOS_RELEASE

const report: Record<string, unknown> & {
  skillModelServer: { endpoint: string; requests: number; responses: number; simulated: boolean } | undefined
  skillModelRequests: Array<{ model: string; hasSkillInstructions: boolean; priorGrepResult: boolean }>
  skillModelResponses: Array<{ type: string; name: string; input: Record<string, unknown> }>
  nativeToolActivities: CliHostActivity[]
} = {
  schemaVersion: 1,
  scenario,
  runtime: "synthetic deterministic fixture; no live CLI engine or model is launched",
  workflowID: WORKFLOW_ID,
  planSha: PLAN_SHA,
  events: [] as Array<Record<string, unknown>>,
  turnInputs: [] as string[],
  turnCount: 0,
  activeTurns: 0,
  maxConcurrentTurns: 0,
  validationCount: 0,
  importCount: 0,
  humanDecisionCalls: 0,
  decisionCount: 0,
  runCount: 0,
  receiptConsumed: false,
  runBeforeReceipt: false,
  noPlanExecutionBeforeReceipt: true,
  toolActivityEvents: [] as CliHostActivity[],
  runtimeCreateCount: 0,
  runtimeAdmissionCount: 0,
  controllerCreateCount: 0,
  conversationCreateCount: 0,
  modelCatalogCallCount: 0,
  modelTransportStub: undefined as { command: string; invocations: number } | undefined,
  skillHomeIsolated: undefined as boolean | undefined,
  skillModelServer: undefined,
  skillModelRequests: [],
  skillModelResponses: [],
  toolPermissionChoices: [] as Array<{ sessionID: string | undefined; title: string; values: readonly string[]; answer: number | null }>,
  nativeToolActivities: [],
  policyIDBefore: undefined as string | undefined,
  policyIDAfter: undefined as string | undefined,
  planExecutionEvidence: [] as Array<{
    ownerSession: string; role: string; policyID: string; kind?: string; hostDispatched: boolean;
    outcome?: string; reconciled: boolean;
  }>,
  sourceChoices: [] as Array<{ sessionID: string | undefined; values: readonly string[]; answer: number | null }>,
  skillHandoffs: [] as Array<{ sessionID: string; turn: number; name: string; exactSource: boolean }>,
  controllerStatusCallCount: 0,
  controllerCancelCallCount: 0,
  workflowModelRequests: {} as Record<string, number>,
  shadowSkillReachedModel: false,
  workflowChoices: [] as Array<{ title: string; values: readonly string[]; answer: number | null }>,
  workflowStatuses: [] as Array<string | null>,
  runtimeSelections: [] as Array<{ engine: string; model: string; sessionID?: string }>,
}

function fixtureCounts(): Record<string, unknown> {
  return {
    runtimeCreateCount: report.runtimeCreateCount,
    runtimeAdmissionCount: report.runtimeAdmissionCount,
    controllerCreateCount: report.controllerCreateCount,
    conversationCreateCount: report.conversationCreateCount,
    modelCatalogCallCount: report.modelCatalogCallCount,
    controllerStatusCallCount: report.controllerStatusCallCount,
    controllerCancelCallCount: report.controllerCancelCallCount,
    turnCount: report.turnCount,
    activeTurns: report.activeTurns,
    runCount: report.runCount,
    validationCount: report.validationCount,
    importCount: report.importCount,
    humanDecisionCalls: report.humanDecisionCalls,
    decisionCount: report.decisionCount,
    receiptConsumed: report.receiptConsumed,
  }
}

function recordFixtureCounts(): void {
  record("fixture.counts", fixtureCounts())
}

function startupStage(stage: string): void {
  report.startupStage = stage
  record("fixture.stage", { stage })
}

function record(type: string, fields: Record<string, unknown> = {}): void {
  const event = { type, ...fields }
  ;(report.events as Array<Record<string, unknown>>).push(event)
  if (eventsPath) {
    mkdirSync(join(eventsPath, ".."), { recursive: true })
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`)
  }
}

async function waitForGate(): Promise<void> {
  if (!gatePath) throw new Error("queue fixture gate path was not supplied")
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await Bun.file(gatePath).text()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw new Error("queue fixture gate was not released")
}

async function waitForTermiosEvidence(): Promise<void> {
  if (!termiosReleasePath) throw new Error("PTY termios evidence release path was not supplied")
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await Bun.file(termiosReleasePath).exists()) {
      const evidence = JSON.parse(await Bun.file(termiosReleasePath).text()) as Record<string, unknown>
      if (evidence.schemaVersion !== 1 || evidence.capturedAfterInteractiveCleanup !== true ||
          evidence.capturedBeforeFixtureExit !== true || typeof evidence.termiosRestored !== "boolean") {
        throw new Error("parent supplied invalid post-cleanup termios evidence")
      }
      report.terminalCleanupEvidence = evidence
      record("terminal.cleanupEvidenceCaptured", {
        capturedBeforeFixtureExit: evidence.capturedBeforeFixtureExit,
        termiosRestored: evidence.termiosRestored,
      })
      if (!evidence.termiosRestored) {
        report.exitCode = 1
        report.error = "parent observed terminal attributes were not restored after interactive cleanup"
      }
      writeReport()
      return
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for parent post-cleanup termios evidence")
}

function writeReport(): void {
  if (!resultPath) return
  mkdirSync(join(resultPath, ".."), { recursive: true })
  const temporary = `${resultPath}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`)
  renameSync(temporary, resultPath)
}

function installLocalTransportStub(worktree: string): { restore: () => void; marker: string } {
  const directory = join(worktree, ".pty-cli-bin")
  const marker = join(worktree, ".pty-transport-invocations")
  mkdirSync(directory, { recursive: true })
  const markerForShell = marker.replaceAll("'", "'\\''")
  writeFileSync(join(directory, "ollama"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${markerForShell}'\nexit 97\n`, { mode: 0o700 })
  const previousPath = process.env.PATH
  process.env.PATH = `${directory}${delimiter}${previousPath ?? ""}`
  return {
    marker,
    restore() {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    },
  }
}

type StubSelector = (prompt: string) => { id: string; response: string | undefined; delayMs?: number }

/** `select` chooses the reply by the stage prompt the request carries (deterministic per prompt id); otherwise replies are sequential. */
function installOllamaHttpStub(worktree: string, responses: readonly string[], select?: StubSelector) {
  const directory = join(worktree, ".pty-model-bin")
  mkdirSync(directory, { recursive: true })
  let requestIndex = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/api/generate") {
        return new Response("not found", { status: 404 })
      }
      let body: unknown
      try { body = await request.json() }
      catch { return new Response("invalid request", { status: 400 }) }
      if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).model !== "string" ||
          typeof (body as Record<string, unknown>).prompt !== "string") {
        return new Response("invalid Ollama request", { status: 400 })
      }
      const fields = body as { model: string; prompt: string }
      const selected = select?.(fields.prompt)
      const modelResponse = select ? selected?.response : responses[requestIndex]
      if (selected?.delayMs) await new Promise(resolve => setTimeout(resolve, selected.delayMs))
      const index = requestIndex + 1
      const hasSkillInstructions = fields.prompt.includes("Active skill instructions (captured bytes; base role and execution approval restrictions still apply):")
      const priorGrepResult = fields.prompt.includes("PTY_SCOPE_NEEDLE appears exactly once") && fields.prompt.includes("scope-target.txt")
      report.skillModelRequests.push({
        model: fields.model,
        hasSkillInstructions,
        priorGrepResult,
      })
      requestIndex++
      if (report.skillModelServer) report.skillModelServer.requests = requestIndex
      record("ollama.stub.request", { index, model: fields.model, hasSkillInstructions, priorGrepResult, ...(selected ? { promptId: selected.id } : {}) })
      if (modelResponse === undefined) return new Response("no scripted model response", { status: 500 })
      try {
        const envelope: unknown = JSON.parse(modelResponse)
        if (envelope && typeof envelope === "object" && typeof (envelope as Record<string, unknown>).type === "string" &&
            typeof (envelope as Record<string, unknown>).name === "string" &&
            (envelope as Record<string, unknown>).input && typeof (envelope as Record<string, unknown>).input === "object") {
          report.skillModelResponses.push({
            type: (envelope as Record<string, unknown>).type as string,
            name: (envelope as Record<string, unknown>).name as string,
            input: (envelope as Record<string, unknown>).input as Record<string, unknown>,
          })
        }
      } catch { /* The model host will reject malformed fixture output itself. */ }
      if (report.skillModelServer) report.skillModelServer.responses++
      return Response.json({ model: fields.model, response: modelResponse, done: true })
    },
  })
  const executable = join(directory, "ollama")
  const cli = `#!${process.execPath}\nconst chunks = []\nfor await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))\nconst prompt = Buffer.concat(chunks).toString("utf8")\nconst expected = ["run", "pty-fixture-model", "--think=false", "--nowordwrap"]\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) { process.stderr.write("unexpected CLI transport arguments\\n"); process.exitCode = 1 } else { const response = await fetch("http://127.0.0.1:${server.port}/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "pty-fixture-model", prompt, stream: false }) }); if (!response.ok) { process.stderr.write("deterministic local Ollama stub refused the request\\n"); process.exitCode = 1 } else { const body = await response.json(); if (body.done !== true || typeof body.response !== "string") { process.stderr.write("deterministic local Ollama stub returned an invalid response\\n"); process.exitCode = 1 } else process.stdout.write(body.response) } }\n`
  writeFileSync(executable, cli, { mode: 0o700 })
  const previousPath = process.env.PATH
  process.env.PATH = `${directory}${delimiter}${previousPath ?? ""}`
  report.skillModelServer = {
    endpoint: `http://127.0.0.1:${server.port}/api/generate`, requests: 0, responses: 0, simulated: true,
  }
  return {
    restore() {
      server.stop()
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (report.skillModelServer) report.skillModelServer.requests = requestIndex
    },
  }
}

async function main(): Promise<void> {
  startupStage("fixture-main-entered")
  if (!(scenario === "approve" || scenario === "reject" || scenario === "queue" || scenario === "signal" || scenario === "ctrlc" || scenario === "restore" || scenario === "sdk-observer" || scenario === "readline-picker" || sourceSkillScenario || scenario === "skill-tool-scope" || scenario === "skill-tool-cancel" || scenario === "skill-main-write" || flowScenario || workflowScenario)) {
    throw new Error(`unknown PTY fixture scenario: ${String(scenario)}`)
  }
  if (!resultPath) throw new Error("PTY fixture result path was not supplied")
  if (!process.stdin.isTTY || !process.stderr.isTTY || !process.stdout.isTTY) {
    throw new Error("PTY fixture did not receive three TTY streams")
  }
  startupStage("pty-streams-validated")

  const worktree = flowScenario
    ? realpathSync(persistentWorktree ?? mkdtempSync(join(tmpdir(), "otter-tui-pty-worktree-")))
    : persistentWorktree ?? mkdtempSync(join(tmpdir(), "otter-tui-pty-worktree-"))
  if (flowScenario) {
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: "" }
    const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: worktree, stdio: "pipe", env: gitEnv })
    git("init", "-q"); git("config", "user.email", "pty@localhost"); git("config", "user.name", "pty")
    writeFileSync(join(worktree, "README.md"), "fixture\n")
    git("add", "-A"); git("commit", "-q", "-m", "fixture")
    for (const n of [1, 2, 3]) writeFileSync(join(worktree, `check_${n}.sh`), `test -f mod${n}.py\n`)
  }
  let transportStub: ReturnType<typeof installLocalTransportStub> | undefined
  let ollamaHttpStub: ReturnType<typeof installOllamaHttpStub> | undefined
  let scopedRuntime: ExecutionRuntime | undefined
  startupStage("temporary-worktree-created")
  if (sourceSkillScenario) {
    const expectedHome = process.env.OTTER_TUI_PTY_HOME
    report.skillHomeIsolated = !!expectedHome && process.env.HOME === expectedHome
    if (!report.skillHomeIsolated) throw new Error("PTY skill scenario did not receive its scenario-local HOME before Bun startup")
    mkdirSync(join(worktree, ".agents", "skills", "pty-inspect"), { recursive: true })
    writeFileSync(join(worktree, ".agents", "skills", "pty-inspect", "SKILL.md"), SKILL_DOCUMENT)
    mkdirSync(join(worktree, ".agents", "skills", "pty-cancel"), { recursive: true })
    writeFileSync(join(worktree, ".agents", "skills", "pty-cancel", "SKILL.md"), CANCEL_SKILL_DOCUMENT)
    transportStub = installLocalTransportStub(worktree)
    report.runtime = "createCliRuntime with real CLI host/session admission and a deterministic conversation transport stub; no model inference is launched"
    report.modelTransportStub = { command: "ollama", invocations: 0 }
    startupStage("project-skill-sources-created")
  }
  if (scenario === "skill-tool-scope" || scenario === "skill-tool-cancel" || scenario === "skill-main-write") {
    const expectedHome = process.env.OTTER_TUI_PTY_HOME
    report.skillHomeIsolated = !!expectedHome && process.env.HOME === expectedHome
    if (!report.skillHomeIsolated) throw new Error("PTY skill tool-scope scenario did not receive its scenario-local HOME before Bun startup")
    const name = scenario === "skill-main-write" ? "pty-main-write" : "pty-scope"
    const document = scenario === "skill-main-write" ? MAIN_WRITE_DOCUMENT : TOOL_SCOPE_DOCUMENT
    mkdirSync(join(worktree, ".agents", "skills", name), { recursive: true })
    writeFileSync(join(worktree, ".agents", "skills", name, "SKILL.md"), document)
    writeFileSync(join(worktree, "scope-target.txt"), `${TOOL_SCOPE_PATTERN} appears exactly once\n`)
    if (scenario === "skill-tool-scope") {
      ollamaHttpStub = installOllamaHttpStub(worktree, [
        JSON.stringify({ type: "tool", name: "grep", input: { pattern: TOOL_SCOPE_PATTERN, path: "scope-target.txt" } }),
        JSON.stringify({ type: "tool", name: "grep", input: { pattern: TOOL_SCOPE_PATTERN, path: "scope-target.txt" } }),
      ])
    } else if (scenario === "skill-tool-cancel") {
      ollamaHttpStub = installOllamaHttpStub(worktree, [
        JSON.stringify({ type: "tool", name: "grep", input: { pattern: TOOL_SCOPE_PATTERN, path: "scope-target.txt" } }),
      ])
    } else {
      ollamaHttpStub = installOllamaHttpStub(worktree, [
        JSON.stringify({ type: "tool", name: "write", input: { path: "scope-write-target.txt", content: "SHOULD_NOT_BE_WRITTEN" } }),
      ])
      writeFileSync(join(worktree, "scope-write-target.txt"), "FIXTURE_FILE_MUST_STAY_UNCHANGED\n")
    }
    report.runtime = "createCliRuntime and createPlanConversation with native CLI host/tool execution, real admission/skill broker/context, and a deterministic loopback Ollama /api/generate stub; model inference is simulated"
    startupStage("native-skill-tool-scope-created")
  }
  if (workflowScenario) {
    const expectedHome = process.env.OTTER_TUI_PTY_HOME
    report.skillHomeIsolated = !!expectedHome && process.env.HOME === expectedHome
    if (!report.skillHomeIsolated) throw new Error("PTY workflow scenario did not receive its scenario-local HOME before Bun startup")
    // A project skill with a protected workflow name and sentinel bytes: it must never redirect or reach a model request.
    mkdirSync(join(worktree, ".agents", "skills", "deep-interview"), { recursive: true })
    writeFileSync(join(worktree, ".agents", "skills", "deep-interview", "SKILL.md"), "---\nname: deep-interview\ndescription: shadow\nallowed-tools: [write]\n---\nPTY-SHADOW-SKILL-SENTINEL\n")
    // Deterministic loopback model: the reply is chosen by the Otter stage prompt the request carries and wrapped in the CLI envelope.
    const script = fullScript()
    const prompts = [...DEEP_INTERVIEW_PROMPTS, ...RALPLAN_PROMPTS]
    const delays: Record<string, number> = { "di.interviewer.topology": 900, "di.panel.researcher": 900, "ralplan.planner": 900 }
    ollamaHttpStub = installOllamaHttpStub(worktree, [], prompt => {
      const stage = prompts.find(candidate => prompt.includes(candidate.text))
      if (!stage) return { id: "unknown", response: undefined }
      const text = script[stage.id]?.shift()
      const seen = (report.workflowModelRequests as Record<string, number>)
      seen[stage.id] = (seen[stage.id] ?? 0) + 1
      if (prompt.includes("PTY-SHADOW-SKILL-SENTINEL")) report.shadowSkillReachedModel = true
      return { id: stage.id, response: text === undefined ? undefined : JSON.stringify({ type: "final", text }), ...(delays[stage.id] ? { delayMs: delays[stage.id] } : {}) }
    })
    report.runtime = "createCliRuntime and the real deep-interview/ralplan engines and workflow turns with native CLI host admission, and a deterministic loopback Ollama /api/generate stub selecting scripted stage replies by prompt id; model inference is simulated"
    startupStage("workflow-di-fixture-created")
  }
  if (scenario === "restore") {
    startupStage("restore-seed-starting")
    const seed = openSession(worktree, RESTORED_SESSION_ID, { engine: "codex", model: "pty-fixture-model" })
    const appendPair = (index: number) => {
      const userText = index === 0
        ? "EARLIEST_RESTORED_HISTORY_NEEDLE oldest submitted prompt"
        : index === RESTORED_PAIR_COUNT - 1
          ? "LATEST_RESTORED_HISTORY_NEEDLE latest submitted prompt"
          : `restored submitted prompt ${String(index).padStart(3, "0")}`
      seed.append("user", { text: userText }, `restore-user-${index}`)
      seed.append("assistant", { text: `restored assistant reply ${String(index).padStart(3, "0")}` }, `restore-assistant-${index}`)
    }
    appendPair(0)
    const padding = `deterministic PTY fixture notice padding ${"x".repeat(NOTICE_PADDING_BYTES)}`
    for (let index = 0; index < 4; index += 1) seed.append("notice", { text: padding }, `restore-padding-${index}`)
    for (let index = 1; index < RESTORED_PAIR_COUNT; index += 1) appendPair(index)
    seed.append("notice", { draft: "UNSENT_RESTORED_DRAFT", queued: ["QUEUED_RESTORED_DRAFT"] }, "restore-unsent-drafts")
    const seededReplay = replaySession(worktree, RESTORED_SESSION_ID, { order: "asc", limit: 10_000 })
    const seededSessionDirectory = sessionDir(worktree, RESTORED_SESSION_ID)
    const seededSegmentCount = readdirSync(seededSessionDirectory)
      .filter(name => /^segments\d{6,}\.jsonl$/.test(name)).length
    const firstSegmentRecord = JSON.parse(readFileSync(join(seededSessionDirectory, "segments000001.jsonl"), "utf8").split("\n", 1)[0]!) as { eventID?: unknown }
    if (!seededReplay.complete || seededReplay.totalRecords !== seededReplay.records.length ||
        seededReplay.records.filter(record => record.kind === "user").length !== RESTORED_PAIR_COUNT ||
        seededSegmentCount <= 3 || firstSegmentRecord.eventID !== "restore-user-0" || !seed.metadata.held) {
      throw new Error("restore fixture seed did not create complete held history across more than three segments")
    }
    report.restoreSeed = {
      sessionID: RESTORED_SESSION_ID,
      pairCount: RESTORED_PAIR_COUNT,
      recordCount: seededReplay.totalRecords,
      segmentCount: seededSegmentCount,
      earliestPairInFirstSegment: true,
      metadata: { engine: seed.metadata.engine, model: seed.metadata.model, held: seed.metadata.held },
    }
    seed.release({
      workflowQuiescent: true,
      evidence: "PTY fixture seeded transcript has no workflow or dispatched work",
      workflowID: null,
      revision: null,
    })
    for (let index = 0; index < 205; index += 1) {
      const candidate = openSession(worktree, `pty-session-candidate-${String(index).padStart(3, "0")}`, {
        engine: "codex",
        model: `candidate-model-${index}`,
      })
      candidate.release({
        workflowQuiescent: true,
        evidence: "PTY captured-session chooser fixture has no workflow or dispatched work",
        workflowID: null,
        revision: null,
      })
    }
    report.sessionCandidateCount = 207
    startupStage("restore-seed-released")
  }
  if (scenario === "sdk-observer") {
    startupStage("sdk-observer-seed-starting")
    const seed = openSession(worktree, SDK_SESSION_ID, { engine: "opencode" })
    seed.append("user", { text: "SDK_RETAINED_HISTORY_NEEDLE original upstream user prompt" }, "sdk-observer-user")
    seed.append("assistant", { text: "Retained upstream assistant history remains readable without its vendor." }, "sdk-observer-assistant")
    const seededReplay = replaySession(worktree, SDK_SESSION_ID, { order: "asc", limit: 100 })
    const seedEpoch = seed.epoch
    seed.release({
      workflowQuiescent: true,
      evidence: "PTY fixture retained SDK history has no workflow or dispatched work",
      workflowID: null,
      revision: null,
    })
    const seedMetadata = readSessionMetadata(worktree, SDK_SESSION_ID)
    const seedAttachment = inspectSessionAttachment(worktree, SDK_SESSION_ID, seedEpoch)
    if (!seededReplay.complete || seededReplay.totalRecords !== 2 || !seedMetadata ||
        seedMetadata.engine !== "opencode" || seedMetadata.model !== undefined || seedMetadata.held !== true ||
        seedAttachment?.state !== "released") {
      throw new Error("SDK observer seed did not retain held OpenCode history without model metadata")
    }
    report.sdkSeed = {
      sessionID: SDK_SESSION_ID,
      recordCount: seededReplay.totalRecords,
      attachmentEpoch: seedEpoch,
      attachmentState: seedAttachment.state,
      metadata: { engine: seedMetadata.engine, model: seedMetadata.model, held: seedMetadata.held },
    }
    startupStage("sdk-observer-seed-released")
  }
  const plan = {
    goal: "Exercise a deterministic PTY workflow without launching an engine.",
    steps: [{
      title: "Implement",
      files: ["fixture.ts"],
      detail: scenario === "approve" || scenario === "reject"
        ? Array.from({ length: 220 }, (_, index) => `UX01_CANONICAL_ROW_${String(index + 1).padStart(3, "0")}`).join("\n")
        : "Synthetic fixture step used only to observe terminal progress.",
      verify: "fixture assertion",
    }],
    risks: ["No live engine or filesystem execution is represented."],
  }
  if (flowScenario) {
    // Three real steps with allow-listed verify scripts, so the production plan validator, queue and verifier are exercised.
    plan.goal = "Write three modules through the production queue."
    plan.steps = [1, 2, 3].map(n => ({ title: `module ${n}`, files: [`mod${n}.py`], detail: `write module ${n}`, verify: `sh check_${n}.sh` }))
    plan.risks = ["A regression might escape the individual checks."]
  }
  let receiptWasConsumed = false
  let progressSink: Parameters<InteractiveDependencies["createRuntime"]>[0]["progress"]

  const CONTROLS = {
    boundedInput: "supported", boundedOutput: "supported", preExecutionToolPolicy: "supported", headlessPermissionRefusal: "supported",
    ownedCancellation: "supported", quiescenceEvidence: "supported", identityBinding: "supported", noReplayRecovery: "supported",
    readOnlyWorktree: "supported", serialWorkerLease: "supported",
  } as const
  let blockerRelease: (() => void) | undefined
  let workerCalls = 0
  let firstWorkerRelease: (() => void) | undefined

  /** A synthetic host under the production controller/queue: the first worker blocks until cancelled, later workers finish. */
  function flowRuntime(options: Parameters<InteractiveDependencies["createRuntime"]>[0]): ExecutionRuntime {
    const config = structuredClone(DEFAULT_CONFIG)
    // This fixture proves the plan approval path; intent offers have their own tests (interactive.test.ts).
    config.chat.intent = "off"
    config.delegate = { ...config.delegate, worktree: false, review: false, max_attempts: 2 }
    const runs = createExecutionRunStore(options.worktree)
    const runtime: ExecutionRuntime = {
      instance: "pty-flow-runtime", directory: options.worktree, worktree: options.worktree, stateRoot: stateRoot(options.worktree),
      config, log: () => {}, runs, verificationProfile: "legacy-unowned", verifier: createLegacyVerifierExecutor(),
      policy: createExecutionPolicy(config, { directory: options.worktree, worktree: options.worktree }),
      host: {
        identity: { engine: options.engine, profile: "code" },
        async preflight() { return { compatible: true, controls: CONTROLS, problems: [] } },
        async reconcile() { return { outcome: "unknown" as const, quiescent: false, evidence: "pty flow fixture" } },
        async prepare(request) {
          const reference = { executionID: request.executionID, vendorSessionID: `pty_child_${++workerCalls}` }
          runtime.policy.bindSession(reference.vendorSessionID, request.handlers, request.policy)
          let finished = false
          let resolveRun: ((outcome: { status: "completed" | "cancelled"; text?: string }) => void) | undefined
          const plan = request.title.includes("plan review")
          const firstWorker = request.role === "worker" && !firstWorkerRelease
          return {
            reference,
            async run() {
              record("host.run", { role: request.role, title: request.title })
              if (plan) { finished = true; return { status: "completed" as const, text: "VERDICT: OKAY" } }
              if (request.role === "reviewer") { finished = true; return { status: "completed" as const, text: "ACCEPT" } }
              if (firstWorker) {
                return await new Promise(resolve => { resolveRun = resolve; firstWorkerRelease = () => resolve({ status: "cancelled" }) })
              }
              const n = Number(request.title.match(/module (\d)/)?.[1])
              writeFileSync(join(options.worktree, `mod${n}.py`), "VALUE = 1\n")
              finished = true
              return { status: "completed" as const, text: "Open issues: none" }
            },
            async requestCancel() {
              record("host.cancel", { title: request.title })
              resolveRun?.({ status: "cancelled" }); finished = true
              return { requested: true, acknowledged: true, terminal: true, quiescent: true }
            },
            async reconcile() { return { outcome: finished ? "terminal" as const : "unknown" as const, quiescent: finished, evidence: "pty flow fixture child" } },
          }
        },
      },
    }
    return runtime
  }

  /** Holds a stage reservation (a real stop blocker) until the gate file appears, then runs the production observer. */
  function holdUntilGate(runtime: ExecutionRuntime, sessionID: string, epoch: () => string | undefined): void {
    blockerRelease = beginStageReservation(runtime.worktree, sessionID)
    record("stop.blocker.held")
    const timer = setInterval(() => {
      if (!gatePath || !existsSync(gatePath)) return
      clearInterval(timer)
      blockerRelease?.(); blockerRelease = undefined
      record("stop.blocker.released")
      observeStopSettlement(runtime, sessionID, epoch(), "pty-fixture")
    }, 20)
  }

  const runtimeFactory: InteractiveDependencies["createRuntime"] = options => {
    startupStage("runtime-factory-called")
    report.runtimeCreateCount = Number(report.runtimeCreateCount) + 1
    ;(report.runtimeSelections as Array<{ engine: string; model: string; sessionID?: string }>).push({ engine: options.engine, model: options.model })
    record("runtime.created", { engine: options.engine, model: options.model })
    recordFixtureCounts()
    progressSink = options.progress
    if (sourceSkillScenario || workflowScenario || scenario === "skill-tool-scope" ||
        scenario === "skill-tool-cancel" || scenario === "skill-main-write") {
      const runtime = createCliRuntime(options)
      if (scenario === "skill-tool-scope" || scenario === "skill-tool-cancel" || scenario === "skill-main-write") {
        scopedRuntime = runtime
        report.policyIDBefore = runtime.policy.resolve("main").id
      }
      record("runtime.realCliCreated", { engine: runtime.host.identity.engine, profile: runtime.host.identity.profile })
      return runtime
    }
    if (flowScenario) return flowRuntime(options)
    const runtime = {
      worktree: options.worktree,
      directory: options.worktree,
      instance: "pty-fixture-runtime",
      host: { identity: { engine: options.engine, profile: "pty-fixture" } },
      config: { ...structuredClone(DEFAULT_CONFIG), chat: { intent: "off" as const } },
      log() {},
      selectedEngine: options.engine,
      selectedModel: options.model,
      progress: options.progress,
      runs: { status: () => ({ generation: 0, executions: [] }) },
    }
    return runtime as unknown as ExecutionRuntime
  }

  const controller = {
    validateImportedPlan(value: unknown) {
      report.validationCount = Number(report.validationCount) + 1
      record("plan.validated", { revision: value && typeof value === "object" ? (value as { revision?: unknown }).revision : undefined })
    },
    async importPlan(_sessionID: string, _sourcePath: string, _signal?: AbortSignal, parsed?: unknown) {
      report.importCount = Number(report.importCount) + 1
      record("plan.imported")
      const parsedPlan = parsed as { goal?: string; steps?: Array<{ detail?: string }> } | undefined
      return {
        result: {
          ok: true,
          text: "",
          wf: { id: WORKFLOW_ID, phase: "pending_approval", planRef: { mdPath: `.otter/plans/${WORKFLOW_ID}.md` } },
        },
        planSha: PLAN_SHA,
        renderedPlan: `# PTY canonical plan\n\n${parsedPlan?.goal ?? "Fixture plan."}\n\n${parsedPlan?.steps?.[0]?.detail ?? ""}\n`,
      } as unknown as Awaited<ReturnType<ForegroundController["importPlan"]>>
    },
    decide(value: unknown) {
      const decision = consumeOperatorDecision(value)
      receiptWasConsumed = true
      report.receiptConsumed = true
      report.decisionCount = Number(report.decisionCount) + 1
      record("receipt.consumed", {
        action: decision.action,
        workflowID: decision.workflowID,
        sessionID: decision.sessionID,
        expectedRevision: decision.expectedRevision,
        subject: decision.subject,
        planSha: decision.subject.sha256,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      })
      return {
        ok: true,
        text: "",
        wf: { id: WORKFLOW_ID, phase: decision.action === "approve" ? "approved" : "rejected", taskIds: ["t1"] },
      } as unknown as ReturnType<ForegroundController["decide"]>
    },
    async run(_sessionID: string, _signal?: AbortSignal) {
      report.runCount = Number(report.runCount) + 1
      const beforeReceipt = !receiptWasConsumed
      if (beforeReceipt) {
        report.runBeforeReceipt = true
        report.noPlanExecutionBeforeReceipt = false
      }
      record("controller.run", { beforeReceipt })
      recordFixtureCounts()
      if (beforeReceipt) throw new Error("fixture blocked execution before consuming a real operator receipt")
      if (!progressSink) throw new Error("fixture progress sink was unavailable")
      progressSink.queue("task start", { task: "t1", attempt: 1 })
      progressSink.queue("task verify", { task: "t1", ok: true })
      progressSink.queue("task finished", { task: "t1", status: "done" })
      const toolActivityEvents: CliHostActivity[] = [
        {
          kind: "tool-started", role: "worker", execution: 1, taskID: "t1",
          executionID: "exec-fixture", callID: "call-fixture-1", tool: "read",
        },
        {
          kind: "tool-finished", role: "worker", execution: 1, taskID: "t1",
          executionID: "exec-fixture", callID: "call-fixture-1", tool: "read", outcome: "succeeded", ok: true,
        },
        // Duplicate terminal observations must not create another transcript item or line.
        {
          kind: "tool-finished", role: "worker", execution: 1, taskID: "t1",
          executionID: "exec-fixture", callID: "call-fixture-1", tool: "read", outcome: "succeeded", ok: true,
        },
        {
          kind: "tool-started", role: "worker", execution: 1, taskID: "t1",
          executionID: "exec-fixture", callID: "call-fixture-2", tool: "read",
        },
        {
          kind: "tool-finished", role: "worker", execution: 1, taskID: "t1",
          executionID: "exec-fixture", callID: "call-fixture-2", tool: "read", outcome: "failed", ok: false,
        },
      ]
      report.toolActivityEvents = toolActivityEvents
      for (const activity of toolActivityEvents) {
        progressSink.host(activity)
        record("progress.host", activity)
      }
      return {
        workflow: { id: WORKFLOW_ID, phase: "done", artifacts: [] },
        run: { done: 1, failed: 0, cancelled: 0, skipped: 0 },
      } as unknown as Awaited<ReturnType<ForegroundController["run"]>>
    },
    cancel() {
      report.controllerCancelCallCount = Number(report.controllerCancelCallCount) + 1
      record("controller.cancel")
      recordFixtureCounts()
      return { ok: true, text: "", wf: { id: WORKFLOW_ID, phase: "cancelled" } }
    },
    status() {
      report.controllerStatusCallCount = Number(report.controllerStatusCallCount) + 1
      record("controller.status")
      recordFixtureCounts()
      return "Fixture status: no active workflow or residual approved work."
    },
  } as unknown as ForegroundController

  const terminal: Terminal = scenario === "readline-skills" || scenario === "readline-picker" ? createReadlineTerminal() : new TuiApp()
  if (workflowScenario) {
    const choose = terminal.choose?.bind(terminal)
    const workflowStatus = terminal.workflowStatus?.bind(terminal)
    if (!choose || !workflowStatus) throw new Error("workflow fixture terminal does not expose the inline chooser and status segment")
    terminal.choose = async (title, values, signal) => {
      record("workflow.choice.started", { title, values })
      const answer = await choose(title, values, signal)
      ;(report.workflowChoices as Array<{ title: string; values: readonly string[]; answer: number | null }>).push({ title, values, answer: answer ?? null })
      record("workflow.choice.completed", { title, values, answer: answer ?? null })
      return answer
    }
    terminal.workflowStatus = line => {
      ;(report.workflowStatuses as Array<string | null>).push(line ?? null)
      record("workflow.status", { line: line ?? null })
      workflowStatus(line)
    }
  }
  if (sourceSkillScenario || scenario === "skill-tool-scope" ||
      scenario === "skill-tool-cancel" || scenario === "skill-main-write") {
    const choose = terminal.choose?.bind(terminal)
    if (!choose) throw new Error("skill fixture terminal does not expose an attached source chooser")
    terminal.choose = async (title, values, signal) => {
      const sessionID = (report.runtimeSelections as Array<{ sessionID?: string }>).at(-1)?.sessionID
      const permissionChoice = values[0] === "Allow once"
      const nativeToolScope = scenario === "skill-tool-scope" || scenario === "skill-tool-cancel" || scenario === "skill-main-write"
      record(permissionChoice ? "skill.toolPermission.started" : nativeToolScope ? "skill.sourceConsent.started" : "skill.choice.started", { sessionID, title, values })
      const answer = await choose(title, values, signal)
      const choice = { sessionID, values, answer: answer ?? null }
      if (permissionChoice) {
        ;(report.toolPermissionChoices as Array<{ sessionID: string | undefined; title: string; values: readonly string[]; answer: number | null }>).push({ ...choice, title })
        record("skill.toolPermission.completed", { ...choice, title })
      } else {
        ;(report.sourceChoices as Array<{ sessionID: string | undefined; values: readonly string[]; answer: number | null }>).push(choice)
        record(nativeToolScope ? "skill.sourceConsent.completed" : "skill.choice.completed", choice)
      }
      recordFixtureCounts()
      return answer
    }
    if (scenario === "skill-tool-scope" || scenario === "skill-tool-cancel" || scenario === "skill-main-write") {
      const activity = terminal.activity?.bind(terminal)
      if (!activity) throw new Error("native skill tool scenario requires production TUI activity observation")
      terminal.activity = value => {
        report.nativeToolActivities.push(value)
        record("native.tool.activity", value)
        recordFixtureCounts()
        activity(value)
      }
    }
  }

  const deps: Partial<InteractiveDependencies> = {
    cwd: worktree,
    terminal,
    gitTopLevel: directory => directory,
    createRuntime: runtimeFactory,
    admitRuntime: async runtime => {
      report.runtimeAdmissionCount = Number(report.runtimeAdmissionCount) + 1
      startupStage("runtime-admitted")
      if (sourceSkillScenario || workflowScenario || scenario === "skill-tool-scope" ||
          scenario === "skill-tool-cancel" || scenario === "skill-main-write") {
        const preflight = await runtime.host.preflight(runtime.host.identity.profile)
        assertHostAdmission(preflight, runtime.host.identity.controlProfile)
        record("runtime.preflight.accepted", { engine: runtime.host.identity.engine, compatible: preflight.compatible })
      }
      record("runtime.admitted")
      recordFixtureCounts()
    },
    createController: (runtime) => {
      report.controllerCreateCount = Number(report.controllerCreateCount) + 1
      record("controller.created")
      recordFixtureCounts()
      if (!flowScenario) return controller
      const real = createForegroundController(runtime)
      const wrap = (kind: "pause" | "cancel") => (sid: string) => {
        // The proof stays open (a real stage-reservation blocker) until the parent writes the gate file.
        const hold = kind === "pause" ? scenario === "pause-resume" || scenario === "paused-cancel" : scenario === "cancel-unconfirmed"
        if (hold && !blockerRelease) holdUntilGate(runtime, sid, () => undefined)
        record(`controller.${kind}`)
        return kind === "pause" ? real.pause(sid) : real.cancel(sid)
      }
      return Object.assign(Object.create(real) as ForegroundController, {
        pause: wrap("pause"), cancel: wrap("cancel"),
        async run(sid: string, signal?: AbortSignal) { report.runCount = Number(report.runCount) + 1; record("controller.run", { beforeReceipt: false }); return real.run(sid, signal) },
        async resumePaused(...args: Parameters<ForegroundController["resumePaused"]>) { record("controller.resumePaused"); return real.resumePaused(...args) },
      })
    },
    createConversation: (runtime, sessionID) => {
      report.conversationCreateCount = Number(report.conversationCreateCount) + 1
      const runtimeSelection = (report.runtimeSelections as Array<{ engine: string; model: string; sessionID?: string }>).at(-1)!
      runtimeSelection.sessionID = sessionID
      record("conversation.created", { sessionID, engine: runtime.host.identity.engine, model: runtimeSelection.model })
      recordFixtureCounts()
      if (scenario === "skill-tool-scope" || scenario === "skill-tool-cancel" || scenario === "skill-main-write") {
        const conversation = createPlanConversation(runtime, sessionID)
        record("conversation.planCreated", { sessionID, implementation: "createPlanConversation" })
        return {
          async turn(text: string, signal?: AbortSignal, invocation?: SkillConversationInvocation) {
            const turn = Number(report.turnCount) + 1
            report.turnCount = turn
            ;(report.turnInputs as string[]).push(text)
            const active = Number(report.activeTurns) + 1
            report.activeTurns = active
            report.maxConcurrentTurns = Math.max(Number(report.maxConcurrentTurns), active)
            record("turn.started", { turn, text, active, sessionID, ...(invocation ? { skillName: invocation.prepared.name } : {}) })
            recordFixtureCounts()
            try { return await conversation.turn(text, signal, invocation) }
            finally {
              report.activeTurns = Number(report.activeTurns) - 1
              record("turn.finished", { turn, active: report.activeTurns })
              recordFixtureCounts()
            }
          },
        }
      }
      return {
      async turn(text: string, _signal?: AbortSignal, invocation?: SkillConversationInvocation) {
        const skill = invocation ? claimPreparedSkillInvocation(invocation.prepared) : undefined
        const turn = Number(report.turnCount) + 1
        report.turnCount = turn
        ;(report.turnInputs as string[]).push(text)
        const active = Number(report.activeTurns) + 1
        report.activeTurns = active
        report.maxConcurrentTurns = Math.max(Number(report.maxConcurrentTurns), active)
        if (skill) {
          const name = skill.capture.name
          const exactSource = name === "pty-inspect" && skill.text === SKILL_DOCUMENT
          const handoff = { sessionID, turn, name, exactSource }
          ;(report.skillHandoffs as Array<{ sessionID: string; turn: number; name: string; exactSource: boolean }>).push(handoff)
          record("skill.handoff.claimed", handoff)
        }
        record("turn.started", {
          turn, text, active, sessionID,
          ...(skill ? { skillName: skill.capture.name, exactSkillSource: skill.capture.name === "pty-inspect" && skill.text === SKILL_DOCUMENT } : {}),
        })
        recordFixtureCounts()
        try {
          if (scenario === "queue" && turn === 1) await waitForGate()
          if ((scenario === "approve" || scenario === "reject" || flowScenario) && turn === 1) {
            return { text: "Prepared Café 👩‍💻 and 한글 for review.", plan }
          }
          return { text: `Fixture turn ${turn} completed.` }
        } finally {
          report.activeTurns = Number(report.activeTurns) - 1
          record("turn.finished", { turn, active: report.activeTurns })
          recordFixtureCounts()
        }
      },
    }
    },
    // Automatic skill selection is covered by interactive.test.ts; here it must not depend on the host's skills or a
    // live OpenJev server, so the fixture keeps it off.
    skillPolicy: () => ({ ...readSkillTrust(), auto: { mode: "off", include: new Set(), exclude: new Set() } }),
    selectSkill: async () => ({ skill: null, reason: "off", decisionID: "pty-fixture", candidates: [] }),
    discoverModels: async engine => {
      report.modelCatalogCallCount = Number(report.modelCatalogCallCount) + 1
      record("model.catalog.discovered", { engine })
      recordFixtureCounts()
      if (scenario === "readline-picker") return {
        models: [],
        notice: "Deterministic fixture catalog; availability is not verified.",
      }
      throw new Error("fixture did not expect model discovery")
    },
    humanDecision: async (action, binding, signal) => {
      report.humanDecisionCalls = Number(report.humanDecisionCalls) + 1
      record("humanDecision.begin", { action, workflowID: binding.workflowID, planSha: binding.subject.sha256 })
      // This is the production cooked-terminal reader, not a PTY/UI test double.
      const receipt = await humanDecision(action, binding, signal)
      record("humanDecision.issued")
      return receipt
    },
    randomUUID: (() => {
      let sequence = 0
      return () => {
        sequence += 1
        return sequence === 1 ? sessionPrefix : `${sessionPrefix}-${sequence}`
      }
    })(),
  }

  try {
    startupStage("runInteractiveSession-invoking")
    if (scenario === "readline-picker") {
      report.runtime = "synthetic host; no provider is launched, and no runtime is created before explicit model selection"
      record("readline-picker.ready", fixtureCounts())
    }
    const args = scenario === "readline-picker"
      ? { worktree }
      : { worktree, engine: sourceSkillScenario || workflowScenario || scenario === "skill-tool-scope" ||
        scenario === "skill-tool-cancel" || scenario === "skill-main-write" ? "local" as const : "codex" as const, model: "pty-fixture-model" }
    const result = await runInteractiveSession(args, deps)
    report.exitCode = result.code
    startupStage("runInteractiveSession-returned")
    record("session.exit", { code: result.code })
    if (flowScenario) {
      const wf = readWorkflow(worktree)
      const wid = wf?.id ?? ""
      const sid = wf?.sessionID ?? sessionPrefix
      const root = stateRoot(worktree)
      const listing = (dir: string): string[] => { try { return readdirSync(join(root, dir)) } catch { return [] } }
      report.stopEvidence = {
        phase: wf?.phase ?? null, stopKind: wf?.stopIntent?.kind ?? null,
        eventTypes: readEvents(worktree, wid).map(event => event.type),
        checkpoints: listing(`sessions/${sid}/workflows/${wid}/checkpoints`),
        revisions: listing(`sessions/${sid}/workflows/${wid}/revisions`).length,
        taskStatuses: readLedger(worktree, sid).tasks.map(task => task.status),
        taskErrors: readLedger(worktree, sid).tasks.map(task => task.error ?? null),
        workerRuns: (report.events as Array<Record<string, unknown>>).filter(event => event.type === "host.run" && event.role === "worker").map(event => String(event.title)),
      }
    }
    if (scenario === "restore") {
      const retainedReplay = replaySession(worktree, RESTORED_SESSION_ID, { order: "asc", limit: 10_000 })
      const retainedMetadata = readSessionMetadata(worktree, RESTORED_SESSION_ID)
      const retainedSegmentCount = readdirSync(sessionDir(worktree, RESTORED_SESSION_ID))
        .filter(name => /^segments\d{6,}\.jsonl$/.test(name)).length
      report.restoreRetained = {
        sessionID: RESTORED_SESSION_ID,
        replayComplete: retainedReplay.complete,
        recordCount: retainedReplay.records.length,
        totalRecords: retainedReplay.totalRecords,
        segmentCount: retainedSegmentCount,
        metadata: retainedMetadata ? {
          engine: retainedMetadata.engine,
          model: retainedMetadata.model,
          held: retainedMetadata.held,
        } : null,
      }
      if (!retainedReplay.complete || retainedReplay.totalRecords !== retainedReplay.records.length ||
          retainedSegmentCount <= 3 || !retainedMetadata || retainedMetadata.held !== true ||
          retainedMetadata.engine !== "codex" || retainedMetadata.model !== "pty-fixture-model") {
        throw new Error("restore fixture did not retain complete segmented history and held CLI metadata")
      }
    }
    if (scenario === "sdk-observer") {
      const seed = report.sdkSeed as { attachmentEpoch: string; recordCount: number } | undefined
      if (!seed) throw new Error("SDK observer seed evidence is missing")
      const sdkReplay = replaySession(worktree, SDK_SESSION_ID, { order: "asc", limit: 100 })
      const sdkMetadata = readSessionMetadata(worktree, SDK_SESSION_ID)
      const sdkDirectory = sessionDir(worktree, SDK_SESSION_ID)
      const attachmentReceiptCount = readdirSync(join(sdkDirectory, "attachments"))
        .filter(name => /^.+\.json$/.test(name)).length
      const sdkAttachment = inspectSessionAttachment(worktree, SDK_SESSION_ID, seed.attachmentEpoch)
      const sdkAttachLockExists = existsSync(join(sdkDirectory, "attach.lock"))
      const selections = report.runtimeSelections as Array<{ engine: string; model: string; sessionID?: string }>
      report.sdkRetained = {
        replayComplete: sdkReplay.complete,
        recordCount: sdkReplay.records.length,
        totalRecords: sdkReplay.totalRecords,
        metadata: sdkMetadata ? { engine: sdkMetadata.engine, model: sdkMetadata.model, held: sdkMetadata.held } : null,
        attachmentReceiptCount,
        attachmentState: sdkAttachment?.state ?? null,
        attachLockExists: sdkAttachLockExists,
      }
      const selectionIDs = selections.map(selection => ({ engine: selection.engine, sid: selection.sessionID }))
      if (!sdkReplay.complete || sdkReplay.totalRecords !== seed.recordCount || sdkReplay.records.length !== seed.recordCount ||
          !sdkMetadata || sdkMetadata.engine !== "opencode" || sdkMetadata.model !== undefined || sdkMetadata.held !== true ||
          attachmentReceiptCount !== 1 || sdkAttachment?.state !== "released" || sdkAttachLockExists ||
          Number(report.runtimeCreateCount) !== 2 || Number(report.runtimeAdmissionCount) !== 2 ||
          Number(report.controllerCreateCount) !== 2 || Number(report.conversationCreateCount) !== 2 ||
          Number(report.modelCatalogCallCount) !== 0 || Number(report.controllerStatusCallCount) !== 0 ||
          Number(report.controllerCancelCallCount) !== 0 || Number(report.turnCount) !== 1 || Number(report.runCount) !== 0 ||
          (report.turnInputs as string[]).length !== 1 || (report.turnInputs as string[])[0] !== "ordinary input after SDK observer" ||
          selectionIDs.length !== 2 || selectionIDs.some(selection => selection.engine !== "codex") ||
          selectionIDs[0]?.sid !== "otter-pty-session" || selectionIDs[1]?.sid !== "otter-pty-session-2") {
        throw new Error(`SDK observer violated read-only isolation: ${JSON.stringify({
          sdkRetained: report.sdkRetained, counts: fixtureCounts(), turnInputs: report.turnInputs, selectionIDs,
        })}`)
      }
      record("sdk.observer.retainedVerified", {
        sessionID: SDK_SESSION_ID,
        metadata: report.sdkRetained,
        counts: fixtureCounts(),
        runtimeSelections: selectionIDs,
      })
    }
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    report.exitCode = 1
    record("session.error", { error: report.error })
  } finally {
    if (scopedRuntime) {
      report.policyIDAfter = scopedRuntime.policy.resolve("main").id
      report.planExecutionEvidence = scopedRuntime.runs.status().executions.map(execution => ({
        ownerSession: execution.ownerSession,
        role: execution.role,
        policyID: execution.policyID,
        ...(execution.kind === undefined ? {} : { kind: execution.kind }),
        hostDispatched: execution.hostDispatch === "started",
        ...(execution.terminal?.outcome === undefined ? {} : { outcome: execution.terminal.outcome }),
        reconciled: execution.reconciliation?.outcome === "terminal" && execution.reconciliation.quiescent,
      }))
    }
    if (workflowScenario) {
      const read = readCommitted(worktree)
      const sid = `otter-${sessionPrefix}`
      report.workflowEvidence = {
        state: read.state,
        kind: read.state === "ok" ? read.wf.kind : null,
        stage: read.state === "ok" ? read.wf.stage : null,
        phase: read.state === "ok" ? read.wf.phase : null,
        lineage: read.state === "ok" ? read.wf.lineage ?? null : null,
        created: readEvents(worktree).filter(event => event.type === "created").map(event => (event.data as { kind?: string } | undefined)?.kind ?? null),
        eventTypes: readEvents(worktree).map(event => event.type),
        ledgerTasks: readLedger(worktree, sid).tasks.length,
        gjcDirectory: existsSync(join(worktree, ".gjc")),
        implementationFiles: readdirSync(worktree).filter(name => !["README.md", ".agents", ".git", ".otter", ".pty-model-bin"].includes(name)),
      }
    }
    if (scenario === "skill-main-write") {
      try { report.writeFileContent = readFileSync(join(worktree, "scope-write-target.txt"), "utf8") }
      catch { report.writeFileContent = null }
    }
    if (ollamaHttpStub) {
      ollamaHttpStub.restore()
    }
    if (transportStub) {
      const invocations = existsSync(transportStub.marker)
        ? readFileSync(transportStub.marker, "utf8").split("\n").filter(Boolean).length
        : 0
      report.modelTransportStub = { command: "ollama", invocations }
      transportStub.restore()
      if (invocations > 0) {
        report.error = "model transport stub was unexpectedly invoked"
        report.exitCode = 1
        record("session.error", { error: report.error })
      }
    }
    report.tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY, stderr: process.stderr.isTTY }
    writeReport()
    if (!persistentWorktree) rmSync(worktree, { recursive: true, force: true })
  }
  await waitForTermiosEvidence()
  process.exitCode = Number(report.exitCode ?? 1)
}

await main()
