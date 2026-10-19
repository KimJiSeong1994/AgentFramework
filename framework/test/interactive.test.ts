import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { launchInteractive, parseInteractiveArgs, validModelID, type InteractiveDependencies, type Terminal } from "../src/hosts/interactive.ts"
import type { TerminalControl } from "../src/hosts/interactive-session.ts"
import type { ShellResult } from "../src/hosts/operator-shell.ts"
import type { ModelCatalog } from "../src/hosts/model-catalog.ts"
import type { ChoicePresentation, InteractiveViewFacts, TranscriptText } from "../src/hosts/interactive-view.ts"
import { newWorkflow, withFlowTransaction, workflowPath } from "../src/flow/state.ts"
import { publishWorkflow, writeWorkflow } from "./commit-fixture.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { readSessionCommitted } from "../src/workflows/commit.ts"
import { AdmissionRefusal } from "../src/hosts/required-controls.ts"
import { ModelRequestError } from "../src/workflows/turn.ts"
import { holdAdmission } from "../src/sessions/admission.ts"
import { PlanIsolationUnavailableError, type ForegroundController } from "../src/hosts/controller.ts"
import type { ExecutionRuntime } from "../src/hosts/types.ts"
import type { CliProgressSink } from "../src/hosts/cli-progress.ts"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { bindSkillInvocation, finishSkillInvocation, skillInvocationAudit } from "../src/skills/context.ts"
import { SkillSession, type SkillCatalog } from "../src/skills/session.ts"
import { DEFAULT_SKILL_AUTO, NO_SKILL_TRUST, parseSkillTrust, type SkillTrust, type SkillTrustLookup } from "../src/skills/trust.ts"
import type { AutoSkillSelection } from "../src/routing/router.ts"
import type { AutoSkillSelectInput } from "../src/hosts/interactive-session.ts"
import { humanDecision, type OperatorDecision } from "../src/hosts/operator.ts"
import { planBinding, withTerminalLine } from "./operator-helpers.ts"
import { tempGitWorktree } from "./guards-helpers.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { interactiveActions } from "../src/hosts/interactive-actions.ts"
import type { ComboLookup, DefaultModelLookup } from "../src/hosts/default-model.ts"
import type { AuthState } from "../src/hosts/engine-auth.ts"
import { getOwnedSession, inspectSessionAttachment, openSession, replaySession, readSessionMetadata, type ReplayOptions, type ReplayResult } from "../src/sessions/store.ts"
import { sessionDir } from "../src/state/store.ts"
import type { ConversationMessage, SkillConversationInvocation } from "../src/hosts/plan-conversation.ts"
import type { SkillToolProvider } from "../src/hosts/types.ts"

let wt: ReturnType<typeof tempGitWorktree>
let harnessSequence = 0
beforeEach(() => { wt = tempGitWorktree(); harnessSequence = 0 })
afterEach(() => wt.cleanup())

type HarnessOptions = {
  lines?: Array<string | undefined>
  turns?: Array<{ text: string; plan?: unknown }>
  turnErrors?: unknown[]
  onTurnError?: () => void
  decision?: "approve" | "reject"
  tty?: { stdin: boolean; stderr: boolean }
  fullscreen?: boolean
  gitTopLevel?: string | undefined
  beforeRead?: (prompt: string, signal?: AbortSignal) => void
  beforeWrite?: (text: string) => void
  choose?: (title: string, choices: readonly string[], signal: AbortSignal, presentation?: ChoicePresentation) => Promise<number | undefined>
  beforeRun?: (signal?: AbortSignal) => void
  /** Plan-worktree fixture: `run`/`resume` report an isolated run and the controller exposes review/apply/discard. */
  isolated?: {
    review?: { ok: true; workflowID: string; path: string; files: string[]; stat: string; patch: string } | { ok: false; workflowID: string; reason: string }
    apply?: { ok: true; workflowID: string; files: string[] } | { ok: false; workflowID: string; reason: string; patch: string }
    /** run() throws PlanIsolationUnavailableError once (no commit), then succeeds only when called with inPlace. */
    unavailable?: "no-commit" | "no-git"
  }
  validatePlan?: (plan: unknown) => void
  runResult?: { phase: string; done: number; failed: number; cancelled: number }
  renderedPlan?: string
  planSha?: string
  importResult?: { ok: boolean; text?: string; phase?: string }
  catalog?: ModelCatalog
  executionStatus?: { generation: number; claim?: { ownerSession: string; instance: string; pid: number; generation: number }; executions: Array<Record<string, unknown>> }
  executionStatusError?: boolean
  failRuntimeFor?: (engine: string, model: string) => boolean
  failConversationFor?: (engine: string, model: string) => boolean
  taskIDs?: string[]
  workflowID?: string
  deferRun?: boolean
  activityForTurn?: (selection: { engine: string; model: string }, progress?: CliProgressSink) => void
  defaultModel?: DefaultModelLookup
  defaultModelSaveError?: Error
  combo?: ComboLookup
  /** chat.intent for the fixture runtime. The legacy tests exercise the plan path with vague lines, so the harness defaults to "off". */
  intent?: "offer" | "off"
  /** Vendor sign-in fixture: status per engine (default signed in), and what the vendor login/logout run changes. */
  auth?: { codex?: AuthState["state"]; claude?: AuthState["state"]; afterRun?: AuthState["state"]; runThrows?: boolean }
  /** User skill policy (default: no trust, automatic selection off) and the automatic selector (default: abstain). */
  skillPolicy?: SkillTrustLookup
  selectSkill?: (input: AutoSkillSelectInput) => Promise<AutoSkillSelection> | AutoSkillSelection
}

function harness(options: HarnessOptions = {}) {
  const sessionPrefix = harnessSequence++ === 0 ? "fixture-session" : `fixture-run-${harnessSequence}`
  const lines = [...(options.lines ?? [])]
  const workflowID = options.workflowID ?? "wf_fixture"
  const calls: {
    prompts: string[]
    output: string[]
    events: string[]
    runtime?: { worktree: string; engine: string; model: string }
    runtimes: Array<{ worktree: string; engine: string; model: string; routes?: unknown }>
    sessionIDs: string[]
    turnBindings: Array<{ engine: string; model: string; sessionID: string; text: string }>
    discoveries: Array<{ engine: string; worktree: string }>
    turns: string[]
    sessionID?: string
    validated?: unknown
    validationAttempts: unknown[]
    imported?: unknown
    decision?: OperatorDecision
    approvalRequest?: { action: Parameters<typeof humanDecision>[0]; workflowID: string; planSha: string }
    runCount: number
    controllerStatusCalls: number
    controllerCancelCalls: number
    signalListeners: Map<string, Set<() => void>>
    choices: Array<{ title: string; values: readonly string[]; presentation?: ChoicePresentation }>
    actionContexts: string[]
    drafts: string[]
    viewFacts: InteractiveViewFacts[]
    skillCatalogs: SkillCatalog[]
    catalogSessions: Array<string | undefined>
    control?: (action: TerminalControl) => void
    progressSinks: CliProgressSink[]
    boundSessions: string[]
    transcriptSources: Array<(options: ReplayOptions) => ReplayResult>
    queueAdmissions: boolean[]
    controllerCreations: number
    conversationRestores: Array<{ sessionID: string; prior?: readonly ConversationMessage[] }>
    defaultModel: DefaultModelLookup
    defaultModelWrites: Array<{ engine: string; model: string } | null>
    combo: ComboLookup
    comboWrites: Array<{ role: string; route: { engine: string; model: string } | null }>
    authRuns: Array<{ engine: string; argv: readonly string[] }>
    authStatusChecks: string[]
    autoSelections: Array<{ text: string; mode: string; candidates: string[] }>
  } = { autoSelections: [], authRuns: [], authStatusChecks: [], prompts: [], output: [], events: [], turns: [], runtimes: [], sessionIDs: [], turnBindings: [], discoveries: [], validationAttempts: [], runCount: 0, controllerStatusCalls: 0, controllerCancelCalls: 0, signalListeners: new Map(), choices: [], actionContexts: [], drafts: [], viewFacts: [], skillCatalogs: [], catalogSessions: [], progressSinks: [], boundSessions: [], transcriptSources: [], queueAdmissions: [], controllerCreations: 0, conversationRestores: [], defaultModel: options.defaultModel ?? { state: "unset" }, defaultModelWrites: [], combo: options.combo ?? { state: "unset" }, comboWrites: [] }
  let boundSessionID: string | undefined

  let releaseRun: (() => void) | undefined
  const runGate = options.deferRun ? new Promise<void>(resolve => { releaseRun = resolve }) : undefined

  const terminal: Terminal = {
    stdinIsTTY: options.tty?.stdin ?? true,
    stderrIsTTY: options.tty?.stderr ?? true,
    fullscreen: options.fullscreen ?? false,
    readLine: async (prompt, signal) => {
      calls.prompts.push(prompt)
      options.beforeRead?.(prompt, signal)
      if (signal?.aborted) return undefined
      return lines.shift()
    },
    ...(options.choose ? { choose: async (title: string, values: readonly string[], signal: AbortSignal, presentation?: ChoicePresentation) => {
      calls.choices.push({ title, values, ...(presentation ? { presentation } : {}) })
      return options.choose!(title, values, signal, presentation)
    } } : {}),
    actionContext: context => { calls.actionContexts.push(context) },
    setDraft: draft => { calls.drafts.push(draft) },
    controls: handler => { calls.control = handler },
    queueAdmission: allowed => { calls.queueAdmissions.push(allowed) },
    sessionChanged: () => { calls.events.push("sessionChanged") },
    skillCatalog: catalog => { calls.skillCatalogs.push(catalog); calls.catalogSessions.push(boundSessionID) },
    bindSession: sessionID => { boundSessionID = sessionID; calls.boundSessions.push(sessionID) },
    transcriptSource: source => { calls.transcriptSources.push(source) },
    viewSnapshot: facts => { calls.viewFacts.push(facts) },
    write: (text) => { calls.output.push(text); options.beforeWrite?.(text) },
    close: () => { calls.events.push("terminal.close") },
  }
  const controller = {
    status() { calls.controllerStatusCalls++; return "Fixture session status" },
    cancel() { calls.controllerCancelCalls++; return { ok: true, text: "cancelled" } },
    validateImportedPlan(plan: unknown) {
      calls.events.push("validate")
      calls.validationAttempts.push(plan)
      options.validatePlan?.(plan)
      calls.validated = plan
    },
    async importPlan(_sessionID: string, _sourcePath: string, _signal?: AbortSignal, plan?: unknown) {
      calls.events.push("import")
      calls.imported = plan
      return {
        result: {
          ok: options.importResult?.ok ?? true,
          text: options.importResult?.text ?? "",
          wf: {
            id: workflowID,
            lastSeq: 11,
            phase: options.importResult?.phase ?? "pending_approval",
            planRef: { mdPath: `.otter/plans/${workflowID}.md` },
          },
        },
        planSha: options.planSha ?? "sha-fixture",
        renderedPlan: options.renderedPlan ?? "# Canonical plan\n\nDo the requested work.\n",
      } as unknown as Awaited<ReturnType<ForegroundController["importPlan"]>>
    },
    decide(decision: OperatorDecision) {
      calls.events.push("decide")
      calls.decision = decision
      return {
        ok: true,
        text: "",
        wf: {
          id: workflowID,
          phase: decision.action === "approve" ? "approved" : "rejected",
          ...(options.taskIDs ? { taskIds: options.taskIDs } : {}),
        },
      } as unknown as ReturnType<ForegroundController["decide"]>
    },
    async run(_sessionID: string, signal?: AbortSignal, runOptions?: { inPlace?: boolean }) {
      calls.events.push(runOptions?.inPlace ? "run-in-place" : "run")
      calls.runCount++
      options.beforeRun?.(signal)
      await runGate
      if (options.isolated?.unavailable && !runOptions?.inPlace) throw new PlanIsolationUnavailableError(options.isolated.unavailable)
      return {
        workflow: { id: workflowID, phase: options.runResult?.phase ?? "done", artifacts: [] },
        run: { done: options.runResult?.done ?? 1, failed: options.runResult?.failed ?? 0, cancelled: options.runResult?.cancelled ?? 0, skipped: 0 },
        ...(options.isolated && !options.isolated.unavailable ? { planWorktree: { workflowID } } : {}),
      } as unknown as Awaited<ReturnType<ForegroundController["run"]>>
    },
    pendingPlanWorktree() { return options.isolated && !options.isolated.unavailable ? workflowID : undefined },
    async reviewPlanWorktree() { calls.events.push("review"); return options.isolated?.review },
    async applyPlanWorktree() { calls.events.push("apply"); return options.isolated?.apply },
    async discardPlanWorktree() { calls.events.push("discard") },
  } as unknown as ForegroundController

  const deps: Partial<InteractiveDependencies> = {
    cwd: wt.worktree,
    terminal,
    gitTopLevel: () => Object.hasOwn(options, "gitTopLevel") ? options.gitTopLevel : wt.worktree,
    createRuntime: ({ worktree, engine, model, progress, routes }) => {
      calls.events.push("runtime")
      if (options.failRuntimeFor?.(engine, model)) throw new TypeError("fixture runtime setup failed")
      const selected = { worktree, engine, model, ...(routes ? { routes } : {}) }
      calls.runtime = selected
      calls.runtimes.push(selected)
      if (progress) calls.progressSinks.push(progress)
      return {
        worktree,
        directory: worktree,
        instance: "interactive-test-runtime",
        host: { identity: { engine, profile: "interactive-fixture" } },
        config: { ...structuredClone(DEFAULT_CONFIG), chat: { intent: options.intent ?? "off" } },
        log() {},
        selectedEngine: engine,
        selectedModel: model,
        progress,
        runs: {
          status() {
            calls.events.push("execution.status")
            if (options.executionStatusError) throw new Error("fixture execution state unavailable")
            return options.executionStatus ?? { generation: 0, executions: [] }
          },
        },
      } as unknown as ExecutionRuntime
    },
    admitRuntime: async () => { calls.events.push("admitRuntime") },
    createConversation: (runtime, sessionID, prior) => {
      calls.events.push("conversation")
      calls.sessionID = sessionID
      calls.sessionIDs.push(sessionID)
      calls.conversationRestores.push({ sessionID, ...(prior ? { prior } : {}) })
      const selectedRuntime = runtime as ExecutionRuntime & { selectedEngine: string; selectedModel: string; progress?: CliProgressSink }
      if (options.failConversationFor?.(selectedRuntime.selectedEngine, selectedRuntime.selectedModel)) {
        throw new Error("fixture conversation setup failed")
      }
      const turns = [...(options.turns ?? [])]
      return {
        turn: async (text) => {
          calls.events.push("turn")
          calls.turns.push(text)
          calls.turnBindings.push({ engine: selectedRuntime.selectedEngine, model: selectedRuntime.selectedModel, sessionID, text })
          options.activityForTurn?.(
            { engine: selectedRuntime.selectedEngine, model: selectedRuntime.selectedModel },
            selectedRuntime.progress,
          )
          const turnError = options.turnErrors?.shift()
          if (turnError !== undefined) {
            options.onTurnError?.()
            throw turnError
          }
          return turns.shift() ?? { text: "Acknowledged." }
        },
      }
    },
    createController: () => { calls.controllerCreations++; return controller },
    skillPolicy: () => options.skillPolicy ?? { trust: NO_SKILL_TRUST, auto: { ...DEFAULT_SKILL_AUTO, mode: "off" }, source: "/fixture/otter.jsonc" },
    selectSkill: async (_runtime, input) => {
      calls.autoSelections.push({ text: input.text, mode: input.mode, candidates: input.candidates.map(candidate => candidate.name) })
      return options.selectSkill ? options.selectSkill(input) : { skill: null, reason: "abstained", decisionID: "d-fixture", candidates: [] }
    },
    auth: {
      status: async engine => {
        calls.authStatusChecks.push(engine)
        const state = (calls.authRuns.some(run => run.engine === engine) && options.auth?.afterRun) || options.auth?.[engine] || "signed-in"
        return state === "signed-in" ? { engine, state, method: "fixture" } : state === "signed-out" ? { engine, state } : { engine, state: "unknown", reason: "fixture" }
      },
      run: async (engine, argv) => {
        calls.authRuns.push({ engine, argv })
        if (options.auth?.runThrows) throw new Error("fixture vendor CLI missing")
        return { exitCode: 0, signal: null }
      },
    },
    humanDecision: async (action, binding) => {
      calls.events.push("humanDecision")
      calls.approvalRequest = { action, workflowID: binding.workflowID, planSha: binding.subject.sha256 }
      return { action: options.decision ?? "approve", ...binding } as unknown as OperatorDecision
    },
    defaultModel: {
      read: () => calls.defaultModel,
      save: value => {
        if (options.defaultModelSaveError) throw options.defaultModelSaveError
        calls.defaultModelWrites.push({ ...value })
        calls.defaultModel = { state: "configured", value, source: "user" }
        return "/config/otter/otter.jsonc"
      },
      clear: () => {
        calls.defaultModelWrites.push(null)
        const present = calls.defaultModel.state !== "unset"
        calls.defaultModel = { state: "unset" }
        return present
      },
    },
    combo: {
      read: () => calls.combo,
      save: (role, route) => {
        calls.comboWrites.push({ role, route: { ...route } })
        const prior = calls.combo.state === "configured" ? calls.combo : undefined
        calls.combo = { state: "configured", routes: { ...prior?.routes, [role]: route }, sources: { ...prior?.sources, [role]: "user" } }
        return "/config/otter/otter.jsonc"
      },
      clearRole: role => { calls.comboWrites.push({ role, route: null }); return true },
      clear: () => { calls.comboWrites.push({ role: "*", route: null }); calls.combo = { state: "unset" }; return true },
    },
    discoverModels: async (engine, worktree) => {
      calls.discoveries.push({ engine, worktree })
      return options.catalog ?? {
        models: [
          { id: engine === "local" ? "llama3.2" : engine === "codex" ? "gpt-5-codex" : "claude-sonnet-4-5", label: "Primary model" },
          { id: "native-secondary", label: "Secondary model" },
        ],
        notice: "Fixture catalog notice",
      }
    },
    randomUUID: (() => {
      let sequence = 0
      return () => sequence++ === 0 ? sessionPrefix : `${sessionPrefix}-${sequence}`
    })(),
    signals: {
      on: (signal, listener) => {
        let listeners = calls.signalListeners.get(signal)
        if (!listeners) calls.signalListeners.set(signal, listeners = new Set())
        listeners.add(listener)
      },
      off: (signal, listener) => { calls.signalListeners.get(signal)?.delete(listener) },
    },
  }
  return {
    calls,
    deps,
    releaseRun() { releaseRun?.(); releaseRun = undefined },
    emitSignal(signal: "SIGINT" | "SIGTERM") {
      for (const listener of calls.signalListeners.get(signal) ?? []) listener()
    },
  }
}

/** `modelLoads` simulates the main model calling the `skill` tool for these names during the turn. */
function useRealSkillCoordinator(h: ReturnType<typeof harness>, modelLoads: string[] = []) {
  const handoffs: Array<{ text: string; sessionID: string; invocation?: SkillConversationInvocation; skillTool?: SkillToolProvider; loads?: Array<{ name: string; ok: boolean; text?: string; error?: string }> }> = []
  const requestedRoot = realpathSync.native(wt.worktree)
  const gitRoot = h.deps.gitTopLevel?.(requestedRoot)
  if (!gitRoot) throw new Error("skill coordinator fixture requires a real Git worktree root")
  const projectRoot = realpathSync.native(gitRoot)
  wt.worktree = projectRoot
  h.deps.cwd = projectRoot
  h.deps.gitTopLevel = () => projectRoot
  h.deps.createRuntime = options => createCliRuntime(options)
  // Keep host preflight independent of installed external CLIs; admission itself remains the coordinator's real attachAdmission path.
  h.deps.admitRuntime = async () => {}
  h.deps.createConversation = (runtime, sessionID) => ({
    turn: async (text, signal, invocation, skillTool) => {
      if (signal?.aborted) throw new Error("test turn cancelled")
      h.calls.events.push("turn")
      h.calls.turns.push(text)
      const handoff: (typeof handoffs)[number] = { text, sessionID, ...(invocation ? { invocation } : {}), ...(skillTool ? { skillTool } : {}) }
      handoffs.push(handoff)
      if (!invocation && skillTool && modelLoads.length) {
        handoff.loads = []
        for (const name of modelLoads) {
          const loaded = await skillTool.load(name, new AbortController().signal)
          // The real host reports delivery once the instructions are placed in the model input.
          if (loaded.ok) skillTool.delivered?.(name)
          handoff.loads.push({ name, ...loaded })
        }
      }
      if (!invocation) return { text: "Acknowledged." }
      const binding = bindSkillInvocation(invocation.prepared, {
        executionID: randomUUID(), supervisorSessionID: sessionID, taskID: randomUUID(), attemptID: randomUUID(),
        generation: 1, role: "main", title: "Interactive skill test", cwd: runtime.worktree,
        text, deadlineAt: Date.now() + 60_000, policy: runtime.policy.resolve("main"),
      }, runtime.policy, invocation.terminal)
      try { return { text: "Skill response.", skill: skillInvocationAudit(binding.context) } }
      finally { finishSkillInvocation(binding.context) }
    },
  })
  return handoffs
}

function retainedSDKHistory(sessionID = "sdk-retained-history", includeTool = false) {
  const owner = openSession(wt.worktree, sessionID, { engine: "opencode" })
  owner.append("user", { text: "history from a deleted SDK session" })
  owner.append("assistant", { text: "retained Otter reply" })
  if (includeTool) {
    const activity = { executionID: "sdk-execution", callID: "sdk-call", taskID: "t1", name: "read", role: "worker" }
    owner.append("tool-start", { ...activity, outcome: "running" })
    owner.append("tool-result", { ...activity, outcome: "succeeded" })
  }
  return owner
}

function releaseTestSession(store: ReturnType<typeof openSession>): void {
  store.release({ workflowQuiescent: true, evidence: "test owner cleanup", workflowID: null, revision: null })
}

const proposedPlan = {
  goal: "Do the requested work",
  steps: [
    { title: "Implement", files: ["src/app.ts"], detail: "Make the change.", verify: "bun test" },
    { title: "Review", files: ["src/app.ts"], detail: "Check the result.", verify: "bun test" },
    { title: "Report", files: ["src/app.ts"], detail: "Summarize the change.", verify: "bun test" },
  ],
  risks: ["The change may need adjustment."],
}

const unsafeTerminalControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u

describe("interactive terminal", () => {
  test("lists catalog metadata and explicitly dispatches only an ordinary skill with a safe source audit", async () => {
    const directory = join(wt.worktree, ".agents", "skills", "inspect")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "SKILL.md"), "---\nname: inspect\ndescription: Inspect this project\nallowed-tools: [read]\n---\nUNIQUE_SKILL_SOURCE_BYTES\n")
    const invalid = join(wt.worktree, ".agents", "skills", "broken")
    mkdirSync(invalid, { recursive: true })
    writeFileSync(join(invalid, "SKILL.md"), "not valid skill metadata\n")
    const h = harness({
      lines: ["/skills", "/skill:inspect inspect data.txt", "/quit"],
      choose: async () => 0,
    })
    const handoffs = useRealSkillCoordinator(h)

    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)

    expect(h.calls.catalogSessions[0]).toBe("otter-fixture-session")
    expect(h.calls.skillCatalogs.length).toBeGreaterThanOrEqual(2)
    expect(h.calls.skillCatalogs[0]?.entries.some(entry => entry.descriptor.name === "inspect" && entry.classification === "custom")).toBe(true)
    expect(h.calls.output.join("")).toContain("/skill:inspect · project · custom · Inspect this project")
    expect(h.calls.output.join("")).toContain("Refused project broken · invalid-metadata")

    expect(h.calls.turns).toEqual(["/skill:inspect inspect data.txt"])
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]?.invocation?.prepared.name).toBe("inspect")
    expect(handoffs[0]?.invocation?.terminal?.stdinIsTTY).toBe(true)
    const replay = replaySession(wt.worktree, "otter-fixture-session", { order: "asc" })
    const audit = replay.records.find(record => record.kind === "notice" && String(record.data.text).startsWith("Skill invocation audit "))
    expect(audit?.data.text).toContain('"userSeq":')
    expect(audit?.data.text).toContain('"assistantSeq":')
    expect(audit?.data.text).toContain('"name":"inspect"')
    expect(audit?.data.text).not.toContain("canonicalSource")
    expect(JSON.stringify(replay.records)).not.toContain("UNIQUE_SKILL_SOURCE_BYTES")
    expect(JSON.stringify(replay.records)).not.toContain(join(directory, "SKILL.md"))
  })

  test("a declined or dismissed skill-source choice never dispatches a conversation turn", async () => {
    const directory = join(wt.worktree, ".agents", "skills", "inspect")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "SKILL.md"), "---\nname: inspect\ndescription: Inspect this project\n---\nRead-only source instructions.\n")
    const h = harness({ lines: ["/skill:inspect inspect files", "/quit"], choose: async () => undefined })
    useRealSkillCoordinator(h)

    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)

    expect(h.calls.choices).toHaveLength(1)
    expect(h.calls.turns).toEqual([])
    const replay = replaySession(wt.worktree, "otter-fixture-session", { order: "asc" })
    expect(replay.records.some(record => record.kind === "user" && record.data.text === "/skill:inspect inspect files")).toBe(true)
    expect(replay.records.some(record => record.kind === "assistant")).toBe(false)
    expect(replay.records.some(record => record.kind === "notice" && String(record.data.text).startsWith("Skill invocation audit "))).toBe(false)
  })

  test("cancellation owns pending source consent and a late answer cannot dispatch after a session switch", async () => {
    const directory = join(wt.worktree, ".agents", "skills", "inspect")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "SKILL.md"), "---\nname: inspect\ndescription: Inspect this project\n---\nRead-only source instructions.\n")
    let entered!: () => void
    let lateAnswer!: (value: number) => void
    let choiceCount = 0
    const choiceStarted = new Promise<void>(resolve => { entered = resolve })
    const h = harness({
      lines: ["/skill:inspect before switch", "/new", "/skill:inspect after switch", "/quit"],
      choose: (_title, _values, signal) => {
        choiceCount++
        if (choiceCount > 1) return Promise.resolve(0)
        return new Promise(resolve => {
          lateAnswer = resolve
          signal.addEventListener("abort", () => resolve(undefined), { once: true })
          entered()
        })
      },
    })
    const handoffs = useRealSkillCoordinator(h)
    const operation = launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)
    await choiceStarted
    h.calls.control?.("cancel")
    lateAnswer(0)
    await operation

    expect(choiceCount).toBe(2)
    expect(h.calls.turns).toEqual(["/skill:inspect after switch"])
    expect(handoffs.map(handoff => handoff.sessionID)).toEqual(["otter-fixture-session-2"])
    expect(replaySession(wt.worktree, "otter-fixture-session", { order: "asc" }).records.some(record => record.kind === "assistant")).toBe(false)
    expect(replaySession(wt.worktree, "otter-fixture-session-2", { order: "asc" }).records.some(record => record.kind === "assistant")).toBe(true)
  })

  test("source grants do not survive switching to a new foreground session", async () => {
    const directory = join(wt.worktree, ".agents", "skills", "inspect")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "SKILL.md"), "---\nname: inspect\ndescription: Inspect this project\n---\nRead-only source instructions.\n")
    let choices = 0
    const h = harness({
      lines: ["/skill:inspect first request", "/new", "/skill:inspect second request", "/quit"],
      choose: async () => { choices++; return 0 },
    })
    useRealSkillCoordinator(h)

    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)

    expect(h.calls.turns).toEqual(["/skill:inspect first request", "/skill:inspect second request"])
    expect(choices).toBe(2)
  })

  test("lists and revokes source grants without dispatching extra model turns", async () => {
    const directory = join(wt.worktree, ".agents", "skills", "inspect")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "SKILL.md"), "---\nname: inspect\ndescription: Inspect this project\nallowed-tools: [read]\n---\nPrivate source instructions.\n")
    let choices = 0
    const h = harness({
      lines: ["/skill:inspect first", "/skills grants", "/skills revoke inspect", "/skills grants", "/skill:inspect again", "/quit"],
      choose: async () => { choices++; return 0 },
    })
    useRealSkillCoordinator(h)
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)
    expect(h.calls.turns).toEqual(["/skill:inspect first", "/skill:inspect again"])
    expect(choices).toBe(2)
    expect(h.calls.output.join("")).toContain("Revoked 1 session skill grant(s) for inspect")
    expect(h.calls.output.join("")).toContain("No session skill grants.")
    expect(h.calls.output.join("")).not.toContain("Private source instructions.")
    const rows = h.calls.output.join("").split("\n").filter(line => line.startsWith("otter-fixture-session · inspect · "))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(/^otter-fixture-session · inspect · project · custom · [0-9a-f]{64} · read$/u)
  })

  test("revoking while a skill invocation is in flight cancels it with the real failure and never reports a stopped label", async () => {
    const directory = join(wt.worktree, ".agents", "skills", "inspect")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "SKILL.md"), "---\nname: inspect\ndescription: Inspect this project\nallowed-tools: [read]\n---\nIN_FLIGHT_SKILL_BYTES\n")
    const h = harness({ lines: ["/skill:inspect long request", "/quit"], choose: async () => 0 })
    useRealSkillCoordinator(h)
    const register = SkillSession.prototype.registerInvocationCancellation
    let owner: SkillSession | undefined
    let inFlight: AbortSignal | undefined
    const spy = spyOn(SkillSession.prototype, "registerInvocationCancellation").mockImplementation(function (this: SkillSession, name, revision, controller) {
      owner = this
      inFlight = controller.signal
      return register.call(this, name, revision, controller)
    })
    let revoked: number | undefined
    let grantsAfterRevoke: number | undefined
    let signalAbortedAfterRevoke: boolean | undefined
    h.deps.createConversation = (runtime, sessionID) => ({
      turn: async (text, _signal, invocation) => {
        h.calls.turns.push(text)
        const binding = bindSkillInvocation(invocation!.prepared, {
          executionID: randomUUID(), supervisorSessionID: sessionID, taskID: randomUUID(), attemptID: randomUUID(),
          generation: 1, role: "main", title: "Interactive skill test", cwd: runtime.worktree,
          text, deadlineAt: Date.now() + 60_000, policy: runtime.policy.resolve("main"),
        }, runtime.policy, invocation!.terminal)
        try {
          expect(owner?.listGrants()).toHaveLength(1)
          expect(inFlight?.aborted).toBe(false)
          revoked = owner!.revoke("inspect")
          grantsAfterRevoke = owner!.listGrants().length
          signalAbortedAfterRevoke = inFlight!.aborted
          // A revoked invocation is no longer an authentic current context.
          expect(() => skillInvocationAudit(binding.context)).toThrow()
          throw new Error("conversation cancelled")
        } finally { finishSkillInvocation(binding.context) }
      },
    })
    try {
      await expect(launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)).rejects.toThrow("conversation cancelled")
    } finally { spy.mockRestore() }

    expect(revoked).toBe(1)
    expect(grantsAfterRevoke).toBe(0)
    expect(signalAbortedAfterRevoke).toBe(true)
    const output = h.calls.output.join("")
    expect(output).not.toContain("stopped")
    expect(output).not.toContain("termination proof")
    expect(output).not.toContain("IN_FLIGHT_SKILL_BYTES")
    const replay = replaySession(wt.worktree, "otter-fixture-session", { order: "asc" })
    expect(replay.records.some(record => record.kind === "assistant")).toBe(false)
    expect(replay.records.some(record => record.kind === "notice" && String(record.data.text).startsWith("Skill invocation audit "))).toBe(false)
  })

  test("deleted upstream SDK session restores only retained Otter history without creating an SDK runtime", async () => {
    const writer = retainedSDKHistory()
    const metadataPath = join(sessionDir(wt.worktree, writer.sessionID), "metadata.json")
    const metadataBefore = readFileSync(metadataPath)
    const h = harness({ lines: [`/resume ${writer.sessionID}`, "/status", "/quit"] })

    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "fixture" }, h.deps)

    expect(h.calls.output.join("")).toContain(`Retained SDK session ${writer.sessionID} · read-only history`)
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.events.filter(event => event === "admitRuntime")).toHaveLength(1)
    expect(h.calls.controllerCreations).toBe(1)
    expect(h.calls.controllerStatusCalls).toBe(0)
    expect(h.calls.controllerCancelCalls).toBe(0)
    expect(h.calls.conversationRestores).toHaveLength(1)
    expect(h.calls.discoveries).toHaveLength(0)
    expect(h.calls.runCount).toBe(0)
    expect(h.calls.boundSessions.at(-1)).toBe(writer.sessionID)
    const restored = h.calls.transcriptSources.at(-1)?.({ order: "asc" })
    expect(restored?.records.map(record => record.data.text)).toEqual(["history from a deleted SDK session", "retained Otter reply"])
    expect(readFileSync(metadataPath)).toEqual(metadataBefore)
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session")?.held).toBe(true)
    writer.assertOwner()
    releaseTestSession(writer)
  })

  test("retained SDK history never adopts an existing writer in this process", async () => {
    const writer = retainedSDKHistory("sdk-live-writer")
    const metadataPath = join(sessionDir(wt.worktree, writer.sessionID), "metadata.json")
    const metadataBefore = readFileSync(metadataPath)
    const attachmentBefore = inspectSessionAttachment(wt.worktree, writer.sessionID, writer.epoch)
    expect(attachmentBefore?.state).toBe("attached")
    const h = harness({ lines: [`/resume ${writer.sessionID}`, "/quit"] })

    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)

    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.controllerCreations).toBe(1)
    expect(h.calls.controllerStatusCalls).toBe(0)
    expect(h.calls.controllerCancelCalls).toBe(0)
    expect(h.calls.conversationRestores).toHaveLength(1)
    expect(h.calls.discoveries).toHaveLength(0)
    expect(h.calls.runCount).toBe(0)
    expect(readFileSync(metadataPath)).toEqual(metadataBefore)
    expect(inspectSessionAttachment(wt.worktree, writer.sessionID, writer.epoch)).toEqual(attachmentBefore)
    writer.assertOwner()
    expect(writer.append("notice", { text: "upstream writer still owns this session" }).data.text)
      .toBe("upstream writer still owns this session")
    releaseTestSession(writer)
  })

  test("read-only SDK history blocks work commands and /new starts an isolated CLI session", async () => {
    const writer = retainedSDKHistory("sdk-blocked-commands", true)
    const metadataPath = join(sessionDir(wt.worktree, writer.sessionID), "metadata.json")
    const metadataBefore = readFileSync(metadataPath)
    const h = harness({ lines: [
      `/resume ${writer.sessionID}`, "must not be sent", "/continue", "/cancel", "/model", "/plan change it",
      "/status", "/search history", "/expand 1", "/skills", "/sessions", "/new", "fresh CLI message", "/quit",
    ] })

    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "fixture" }, h.deps)

    expect(h.calls.turns).toEqual(["fresh CLI message"])
    expect(h.calls.turnBindings).toMatchObject([{ sessionID: "otter-fixture-session-2", text: "fresh CLI message" }])
    expect(h.calls.runtimes).toHaveLength(2)
    expect(h.calls.runtimes.every(runtime => runtime.engine === "codex")).toBe(true)
    expect(h.calls.controllerCreations).toBe(2)
    expect(h.calls.controllerStatusCalls).toBe(0)
    expect(h.calls.controllerCancelCalls).toBe(0)
    expect(h.calls.discoveries).toHaveLength(0)
    expect(h.calls.runCount).toBe(0)
    expect(h.calls.conversationRestores).toHaveLength(2)
    expect(h.calls.conversationRestores[1]).toEqual({ sessionID: "otter-fixture-session-2" })
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session-2")).toMatchObject({ engine: "codex", model: "fixture" })
    expect(readFileSync(metadataPath)).toEqual(metadataBefore)
    expect(h.calls.output.join("")).toContain(`Retained SDK session ${writer.sessionID} · read-only history`)
    expect(h.calls.output.join("")).toContain("command or message was not applied")
    expect(h.calls.output.join("")).toContain("Skill catalog is unavailable in retained read-only SDK history")
    expect(h.calls.output.join("")).toContain("tool-start ·")
    expect(h.calls.queueAdmissions).toContain(false)
    expect(h.calls.events.filter(event => event === "sessionChanged").length).toBeGreaterThanOrEqual(2)
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session")?.held).toBe(true)
    writer.assertOwner()
    releaseTestSession(writer)
  })

  test("unsettled CLI ownership refuses switching into retained SDK history", async () => {
    const writer = retainedSDKHistory("sdk-blocked-by-cli-owner")
    const metadataPath = join(sessionDir(wt.worktree, writer.sessionID), "metadata.json")
    const metadataBefore = readFileSync(metadataPath)
    const h = harness({
      lines: [`/resume ${writer.sessionID}`, "/quit"],
      executionStatus: {
        generation: 1,
        claim: { ownerSession: "otter-fixture-session", instance: "unsettled-owner", pid: process.pid, generation: 1 },
        executions: [],
      },
    })

    await launchInteractive({ worktree: wt.worktree, engine: "claude", model: "fixture" }, h.deps)

    expect(h.calls.output.join("")).toContain("execution ownership is unresolved")
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.boundSessions.at(-1)).toBe("otter-fixture-session")
    expect(readFileSync(metadataPath)).toEqual(metadataBefore)
    expect(inspectSessionAttachment(wt.worktree, writer.sessionID, writer.epoch)?.state).toBe("attached")
    writer.assertOwner()
    releaseTestSession(writer)
  })

  test("switching sessions retains transcript and restored drafts never dispatch without Resume", async () => {
    const h = harness({ lines: ["first retained message", "/new", "second retained message", "/resume otter-fixture-session", "held message", "/quit"] })
    let admissions = 0
    h.deps.admitRuntime = async () => {
      if (++admissions > 2) throw AdmissionRefusal.hostIncompatible()
    }
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "fixture" }, h.deps)
    expect(h.calls.turns).toEqual(["first retained message", "second retained message"])
    const first = replaySession(wt.worktree, "otter-fixture-session")
    const second = replaySession(wt.worktree, "otter-fixture-session-2")
    expect(first.complete).toBe(true)
    expect(second.complete).toBe(true)
    expect(first.records.filter(record => record.kind === "user").map(record => record.data.text)).toEqual(["first retained message"])
    expect(second.records.filter(record => record.kind === "user").map(record => record.data.text)).toEqual(["second retained message"])
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session")?.held).toBe(true)
    expect(h.calls.output.join("")).toContain("Restored session held")
    expect(admissions).toBe(2)
  })

  test("restore prints the retained workflow id, phase, path, sha256 and an [artifacts] line recomputed from disk", async () => {
    const mdPath = ".otter/plans/retained.md"
    mkdirSync(join(wt.worktree, ".otter/plans"), { recursive: true })
    writeFileSync(join(wt.worktree, mdPath), "original")
    const mdSha = createHash("sha256").update("original").digest("hex")
    const retained = publishWorkflow(wt.worktree, {
      ...newWorkflow("otter-fixture-session", currentOwner(), "command", "retained", "codex"),
      id: "wf_retained_restore", phase: "cancelled", stage: "terminal",
      planRef: { jsonSha: "a".repeat(64), mdPath, mdSha, revision: 1 },
    })
    writeFileSync(join(wt.worktree, mdPath), "tampered after the session ended")
    const h = harness({ lines: ["first retained message", "/new", "second retained message", "/resume otter-fixture-session", "/quit"] })
    let admissions = 0
    h.deps.admitRuntime = async () => { if (++admissions > 2) throw AdmissionRefusal.hostIncompatible() }
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "fixture" }, h.deps)
    const output = h.calls.output.join("")
    const committed = readSessionCommitted(wt.worktree, "otter-fixture-session")!
    expect(committed.wf.id).toBe(retained.id)
    expect(output).toContain(`[workflow] wf_retained_restore cancelled · ${committed.path} · sha256 ${committed.sha256}`)
    expect(output).toMatch(/\[artifacts\] artifacts incomplete: plan\.md \(\.otter\/plans\/retained\.md: hash mismatch\)/)
  })

  test("restored history remains readable when explicit Resume host preflight refuses", async () => {
    const h = harness({ lines: ["retained", "/new", "/resume otter-fixture-session", "/continue", "RESUME", "not dispatched", "/quit"] })
    let admissions = 0
    h.deps.admitRuntime = async () => {
      if (++admissions > 2) throw AdmissionRefusal.hostIncompatible()
    }
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "fixture" }, h.deps)
    expect(admissions).toBe(3)
    expect(h.calls.turns).toEqual(["retained"])
    expect(h.calls.runCount).toBe(0)
    expect(h.calls.output.join("")).toContain("Restored session held")
    expect(h.calls.output.join("")).toContain("Resume refused or incomplete:")
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session")?.held).toBe(true)
    expect(replaySession(wt.worktree, "otter-fixture-session").records.some(record => record.kind === "user" && record.data.text === "retained")).toBe(true)
  })

  test("opens the unselected composer before /model picker and selected-session chrome", async () => {
    const chrome: string[] = []
    const h = harness({
      lines: ["/model", "codex", "1", "/quit"],
      beforeRead(prompt) {
        expect(prompt).not.toMatch(/[\r\n\x1b]/u)
        chrome.push(h.calls.output.at(-1)!)
      },
    })
    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })
    expect(chrome[0]).toContain("── Model not selected\n")
    expect(chrome[0]).toContain("/model choose | /help | /quit")
    expect(chrome[1]).toContain("── Engine selection\n")
    expect(chrome[2]).toContain("── Model selection · codex\n")
    expect(chrome[3]).toContain("── codex · gpt-5-codex\n")
    expect(chrome[3]).toContain("Enter send · /help commands · /model switch · /quit exit")
    expect(h.calls.prompts).toEqual(["You> ", "Engine [1-4]: ", "Model [1-2 or native ID]: ", "You> "])
    expect(h.calls.approvalRequest).toBeUndefined()
  })

  test("bare startup refuses chat and workflow work until selection while local help stays available", async () => {
    let h: ReturnType<typeof harness>
    h = harness({
      lines: ["hello", "/skill:ralplan make a plan", "/invalid", "/model codex bad model", "/model codex -bad", "/theme dark", "/details", "/help", "/quit"],
      beforeRead() {
        expect(h.calls.runtimes).toHaveLength(0)
        expect(h.calls.discoveries).toEqual([])
        expect(h.calls.turns).toEqual([])
      },
    })

    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })

    const output = h.calls.output.join("")
    expect(h.calls.runtimes).toHaveLength(0)
    expect(h.calls.controllerCreations).toBe(0)
    expect(h.calls.discoveries).toEqual([])
    expect(h.calls.turns).toEqual([])
    expect(h.calls.runCount).toBe(0)
    expect(output).toContain("No model selected; use /model to choose an engine and model. Nothing was sent.")
    expect(output).toContain("Usage: /model or /model <local|codex|claude> <native-id>")
    expect(output).toContain("Commands (unselected):")
    expect(output).toContain("/model [engine native-id | default ... | combo ...]")
    expect(output).toContain("/theme <neutral|light|dark>")
    expect(output).toContain("/details")
  })

  test.each(["", "/cancel"])("cancelled startup model picker returns to the unselected composer (%j)", async (cancel) => {
    const h = harness({ lines: ["/model", "codex", cancel, "hello without selection", "/quit"] })
    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })

    expect(h.calls.prompts).toEqual(["You> ", "Engine [1-4]: ", "Model [1-2 or native ID]: ", "You> ", "You> "])
    expect(h.calls.discoveries).toEqual([{ engine: "codex", worktree: realpathSync(wt.worktree) }])
    expect(h.calls.runtimes).toHaveLength(0)
    expect(h.calls.controllerCreations).toBe(0)
    expect(h.calls.turns).toEqual([])
    expect(h.calls.output.join("")).toContain("No model selected; use /model to choose an engine and model. Nothing was sent.")
  })

  test("!command runs before any model is selected without creating a runtime or session", async () => {
    const h = harness({ lines: ["!echo before-model", "/help", "/quit"] })
    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })
    const output = h.calls.output.join("")
    expect(output).toContain("$ echo before-model\nbefore-model\n[shell] exit 0 · ")
    expect(output).toContain("!<command> — run one shell command in the worktree")
    expect(output).not.toContain("No model selected")
    expect(h.calls.runtimes).toHaveLength(0)
    expect(h.calls.sessionIDs).toEqual([])
    expect(h.calls.turns).toEqual([])
  })

  test("engine picker cancellation returns to the unselected composer", async () => {
    const h = harness({
      fullscreen: true,
      lines: ["/model", "/quit"],
      choose: async () => undefined,
    })
    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })

    expect(h.calls.choices[0]).toMatchObject({ title: "Choose an execution engine" })
    expect(h.calls.runtimes).toHaveLength(0)
    expect(h.calls.controllerCreations).toBe(0)
    expect(h.calls.discoveries).toEqual([])
    expect(h.calls.turns).toEqual([])
    expect(h.calls.actionContexts).toContain("unselected")
  })

  test("TUI command palette inserts a contextual command without executing it", async () => {
    const h = harness({
      fullscreen: true,
      lines: ["/help", "/quit"],
      choose: async (title, values) => title === "Commands" ? values.findIndex(value => value.startsWith("/model ")) : undefined,
    })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)

    const palette = h.calls.choices.find(choice => choice.title === "Commands")
    expect(palette?.presentation).toMatchObject({ kind: "picker", purpose: "command" })
    expect(palette?.values.some(value => value.includes("/skill:<name>"))).toBe(false)
    expect(h.calls.drafts).toEqual(["/model"])
    expect(h.calls.turns).toEqual([])
    expect(h.calls.runtimes).toHaveLength(1)
  })

  test("unselected help offers setup and accessibility rather than empty-session tools", async () => {
    const h = harness({ fullscreen: true, lines: ["/help", "/quit"], choose: async () => undefined })
    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })
    const commands = h.calls.choices.find(choice => choice.title === "Commands")!.values
      .map(value => value.split(" ")[0])
    expect(commands).toEqual(["/help", "/model", "/memory", "/login", "/theme", "/ascii", "!", "/quit"])
    expect(h.calls.runtimes).toEqual([])
    expect(h.calls.discoveries).toEqual([])
    expect(h.calls.turns).toEqual([])
  })

  test("fullscreen selection uses view facts without logging paths or empty banner rows", async () => {
    const h = harness({ fullscreen: true, lines: ["/model local native-secondary", "/quit"] })
    expect(await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "original" }, h.deps)).toEqual({ code: 0 })
    const output = h.calls.output.join("")
    expect(output).not.toContain("Native execution selection:")
    expect(output).not.toContain(realpathSync(wt.worktree))
    expect(h.calls.output).toContain("Now using local / native-secondary. New conversation: no earlier turns to carry.")
    expect(h.calls.viewFacts[0]?.selection).toEqual({ engine: "codex", model: "original" })
    expect(h.calls.viewFacts.at(-1)?.selection).toEqual({ engine: "local", model: "native-secondary" })
    expect(h.calls.turns).toEqual([])
    const records = replaySession(wt.worktree, h.calls.sessionIDs.at(-1)!, { order: "asc" }).records
    expect(records.some(record => record.kind === "notice" &&
      record.data.text === "Now using local / native-secondary. New conversation: no earlier turns to carry.")).toBe(true)
    expect(records.some(record => typeof record.data.text === "string" && record.data.text.includes("Native execution selection:"))).toBe(false)
  })

  test("reads width anew and retains selected context across cancelled and failed switches", async () => {
    const chrome: string[] = []
    let columns = 100
    const h = harness({
      lines: ["/model local qwen3:8b", "/model", "/cancel", "/model claude broken", "hello", undefined],
      failRuntimeFor: engine => engine === "claude",
      beforeRead(prompt) {
        if (prompt === "You> ") chrome.push(h.calls.output.at(-1)!)
        if (chrome.length === 4) columns = 12
      },
    })
    h.deps.terminal!.presentation = () => ({ columns })
    expect(await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "original" }, h.deps)).toEqual({ code: 0 })
    expect(chrome[0]).toContain("codex · original")
    for (const entry of chrome.slice(1, 4)) expect(entry).toContain("local · qwen3:8b")
    expect(chrome.at(-1)).toContain("…")
    for (const line of chrome.at(-1)!.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(12)
    expect(h.calls.turnBindings).toEqual([
      { engine: "local", model: "qwen3:8b", sessionID: "otter-fixture-session-2", text: "hello" },
    ])
    expect(h.calls.runCount).toBe(0)
    expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("buffers progress during both chrome writes and readline ownership", async () => {
    const h = harness({
      lines: ["/quit"],
      beforeWrite(text) {
        if (!text.startsWith("\n── codex")) return
        h.calls.progressSinks[0]!.host({ kind: "tool-started", role: "worker", execution: 1, executionID: "exec1", callID: "call1", taskID: "t1", tool: "read" })
        expect(h.calls.output.join("")).not.toContain("[activity] Worker")
      },
      beforeRead() {
        expect(h.calls.output.join("")).not.toContain("[activity] Worker")
        h.calls.progressSinks[0]!.host({ kind: "tool-finished", role: "worker", execution: 1, executionID: "exec1", callID: "call1", taskID: "t1", tool: "read", ok: true, outcome: "succeeded" })
        expect(h.calls.output.join("")).not.toContain("[activity] Worker")
      },
    })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "original" }, h.deps)
    expect(h.calls.output.join("")).toContain("[activity] Worker started read tool.")
    expect(h.calls.output.join("")).toContain("[activity] Worker finished read tool.")
  })

  test("parses worktree, engine, and plain native model flags, including bare flags", () => {
    expect(parseInteractiveArgs([], wt.worktree)).toEqual({ worktree: wt.worktree })
    expect(parseInteractiveArgs(["--worktree", "project", "--engine", "codex", "--model", "gpt-5-codex"], wt.worktree))
      .toEqual({ worktree: "project", engine: "codex", model: "gpt-5-codex" })
    expect(parseInteractiveArgs(["--engine", "local", "--model", "gpt-oss:20b"], wt.worktree))
      .toEqual({ worktree: wt.worktree, engine: "local", model: "gpt-oss:20b" })
    expect(() => parseInteractiveArgs(["--engine", "opencode"], wt.worktree)).toThrow("invalid --engine")
    expect(() => parseInteractiveArgs(["--model", "provider/ model"], wt.worktree)).toThrow("invalid --model")
    expect(() => parseInteractiveArgs(["--worktree", wt.worktree, "--worktree", wt.worktree])).toThrow("duplicate")
    expect(() => parseInteractiveArgs(["--model"], wt.worktree)).toThrow("missing value")
  })

  test("requires an interactive terminal before Git lookup or runtime construction", async () => {
    const h = harness({ tty: { stdin: false, stderr: true } })
    await expect(launchInteractive({ worktree: wt.worktree, engine: "local", model: "llama3.2" }, h.deps))
      .rejects.toThrow("interactive terminal")
    expect(h.calls.runtime).toBeUndefined()
    expect(h.calls.signalListeners.size).toBe(0)
  })

  test("canonicalizes nested Git worktree paths and rejects non-Git directories", async () => {
    const nested = join(wt.worktree, "src")
    mkdirSync(nested, { recursive: true })
    const h = harness({ lines: ["/quit"] })
    const result = await launchInteractive({ worktree: nested, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.runtime?.worktree).toBe(realpathSync(wt.worktree))

    const notGit = harness({ gitTopLevel: undefined })
    await expect(launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, notGit.deps))
      .rejects.toThrow("canonical Git worktree")
    expect(notGit.calls.runtime).toBeUndefined()
  })

  test("bare chat stays unselected until /model opens engine and model selection", async () => {
    let h: ReturnType<typeof harness>
    let selectionStarted = false
    h = harness({
      lines: ["hello before selection", "/model", "2", "gpt-5-codex", "hello after selection", "/quit"],
      beforeRead(prompt) {
        if (prompt === "Engine [1-4]: ") selectionStarted = true
        if (!selectionStarted) {
          expect(h.calls.runtimes).toHaveLength(0)
          expect(h.calls.discoveries).toEqual([])
          expect(h.calls.turns).toEqual([])
        }
        if (prompt === "Model [1-2 or native ID]: ") expect(h.calls.runtimes).toHaveLength(0)
      },
    })
    const result = await launchInteractive({ worktree: wt.worktree }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.prompts[0]).toBe("You> ")
    expect(h.calls.prompts[1]).toBe("You> ")
    expect(h.calls.prompts[2]).toBe("Engine [1-4]: ")
    expect(h.calls.output.join("")).toContain("Choose an execution engine")
    expect(h.calls.prompts[3]).toBe("Model [1-2 or native ID]: ")
    expect(h.calls.runtime).toEqual({ worktree: realpathSync(wt.worktree), engine: "codex", model: "gpt-5-codex" })
    expect(h.calls.discoveries).toEqual([{ engine: "codex", worktree: realpathSync(wt.worktree) }])
    expect(h.calls.turnBindings).toEqual([{
      engine: "codex", model: "gpt-5-codex", sessionID: "otter-fixture-session", text: "hello after selection",
    }])
    expect(h.calls.output.join(" ")).toContain("estimated")
    expect(h.calls.output.join(" ")).toContain("reactive")
    expect(h.calls.output.join(" ")).toContain("No process or filesystem containment is claimed")
  })

  test("/model displays numbered native models and the selected execution banner", async () => {
    const h = harness({ lines: ["/model", "1", "2", "/quit"] })
    h.deps.terminal!.presentation = () => ({ columns: 512 })
    const result = await launchInteractive({ worktree: wt.worktree }, h.deps)
    const output = h.calls.output.join("")
    expect(result.code).toBe(0)
    expect(h.calls.runtime).toEqual({ worktree: realpathSync(wt.worktree), engine: "local", model: "native-secondary" })
    expect(output).toContain("1) Primary model — llama3.2")
    expect(output).toContain("2) Secondary model — native-secondary")
    expect(output).toContain("Fixture catalog notice")
    expect(output).toContain(`Engine: local\n  Model: native-secondary\n  Worktree: ${realpathSync(wt.worktree)}`)
    expect(h.calls.discoveries).toHaveLength(1)
    expect(h.calls.viewFacts.at(-1)?.discovery).toBe("completed")
  })

  test("TUI /model opens filterable engine then model picker; selection is explicit", async () => {
    let h: ReturnType<typeof harness>
    let modelPickerSeen = false
    h = harness({
      fullscreen: true,
      lines: ["/model", "hello after selection", "/quit"],
      choose: async (title) => {
        if (title === "Choose an execution engine") return 1
        modelPickerSeen = true
        return 1
      },
      beforeRead(prompt) {
        if (!modelPickerSeen && prompt === "You> ") {
          expect(h.calls.runtimes).toHaveLength(0)
          expect(h.calls.discoveries).toEqual([])
          expect(h.calls.turns).toEqual([])
        }
      },
    })
    await launchInteractive({ worktree: wt.worktree }, h.deps)

    expect(h.calls.choices.map(choice => choice.presentation?.kind)).toEqual(["picker", "picker"])
    expect(h.calls.choices[0]?.values).toEqual(["local — Ollama CLI", "codex — Codex CLI", "claude — Claude CLI", "combo — per-role models"])
    expect(h.calls.choices[1]?.title).toContain("Choose a model · codex")
    expect(h.calls.choices[1]?.presentation).toMatchObject({ kind: "picker", purpose: "selection" })
    expect(h.calls.discoveries).toEqual([{ engine: "codex", worktree: realpathSync(wt.worktree) }])
    expect(h.calls.runtimes[0]).toMatchObject({ engine: "codex", model: "native-secondary" })
    expect(h.calls.turnBindings).toMatchObject([{ engine: "codex", model: "native-secondary", text: "hello after selection" }])
  })

  test("canceling the model picker after choosing another engine keeps the selected session", async () => {
    const h = harness({
      fullscreen: true,
      lines: ["/model", "hello on original model", "/quit"],
      choose: async title => title === "Choose an execution engine" ? 0 : undefined,
    })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "original" }, h.deps)

    expect(h.calls.discoveries).toEqual([{ engine: "local", worktree: realpathSync(wt.worktree) }])
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.sessionIDs).toEqual(["otter-fixture-session"])
    expect(h.calls.turnBindings).toEqual([{
      engine: "codex", model: "original", sessionID: "otter-fixture-session", text: "hello on original model",
    }])
  })

  test("failed model discovery is reflected as failed; explicit model startup remains unobserved", async () => {
    const failed = harness({ lines: ["/model", "codex", "native-manual", "/quit"] })
    failed.deps.discoverModels = async () => { throw new Error("fixture discovery failure") }
    await launchInteractive({ worktree: wt.worktree }, failed.deps)
    expect(failed.calls.viewFacts.at(-1)?.discovery).toBe("failed")
    expect(failed.calls.runtimes[0]).toMatchObject({ engine: "codex", model: "native-manual" })

    const explicit = harness({ lines: ["/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "native-model" }, explicit.deps)
    expect(explicit.calls.viewFacts.at(-1)?.discovery).toBe("not-observed")
  })

  test("a configured default selects at launch without discovery, exactly like full flags", async () => {
    const h = harness({ lines: ["hello", "/quit"], defaultModel: { state: "configured", value: { engine: "local", model: "native-default" }, source: "user" } })
    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })
    expect(h.calls.discoveries).toEqual([])
    expect(h.calls.runtimes[0]).toMatchObject({ engine: "local", model: "native-default" })
    expect(h.calls.turnBindings).toMatchObject([{ engine: "local", model: "native-default", text: "hello" }])
    expect(h.calls.output.join("")).toContain("Using default model local / native-default from user config")
    expect(h.calls.actionContexts).not.toContain("unselected")
  })

  test("explicit or partial flags ignore the configured default", async () => {
    const configured: DefaultModelLookup = { state: "configured", value: { engine: "local", model: "native-default" }, source: "user" }
    const full = harness({ lines: ["/quit"], defaultModel: configured })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, full.deps)
    expect(full.calls.runtimes[0]).toMatchObject({ engine: "codex", model: "gpt-5-codex" })
    const partial = harness({ lines: ["/quit"], defaultModel: configured })
    await launchInteractive({ worktree: wt.worktree, engine: "claude" }, partial.deps)
    expect(partial.calls.runtimes).toEqual([])
    expect(partial.calls.actionContexts).toContain("unselected")
  })

  test("an invalid default is reported and leaves the composer unselected", async () => {
    const h = harness({ lines: ["/quit"], defaultModel: { state: "invalid", reason: "chat.default_model.engine must be local, codex, or claude" } })
    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })
    expect(h.calls.output.join("")).toContain("Default model ignored: chat.default_model.engine must be local, codex, or claude")
    expect(h.calls.runtimes).toEqual([])
    expect(h.calls.discoveries).toEqual([])
  })

  test("/model default before selection saves and selects only an explicitly named model", async () => {
    const h = harness({ lines: ["/model default", "/model default save", "/model default local bad id", "/model default local native-default", "hello", "/quit"] })
    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })
    const output = h.calls.output.join("")
    expect(output).toContain("No default model is set.")
    expect(output).toContain("No model is selected yet")
    expect(output).toContain("Usage: /model default")
    expect(output).toContain("Saved default model local / native-default to /config/otter/otter.jsonc.")
    expect(h.calls.defaultModelWrites).toEqual([{ engine: "local", model: "native-default" }])
    expect(h.calls.discoveries).toEqual([])
    expect(h.calls.turnBindings).toMatchObject([{ engine: "local", model: "native-default", text: "hello" }])
  })

  test("/model default in chat saves or clears without switching the session", async () => {
    const h = harness({ lines: ["/model default save", "/model default claude sonnet", "/model default", "/model default clear", "/model default clear", "/quit"] })
    expect(await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)).toEqual({ code: 0 })
    const output = h.calls.output.join("")
    expect(h.calls.defaultModelWrites).toEqual([{ engine: "codex", model: "gpt-5-codex" }, { engine: "claude", model: "sonnet" }, null, null])
    expect(output).toContain("Saved default model codex / gpt-5-codex")
    expect(output).toContain("use /model claude sonnet to switch now")
    expect(output).toContain("Default model: claude / sonnet (user config).")
    expect(output).toContain("Default model cleared from user config.")
    expect(output).toContain("No user default model was set.")
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.turns).toEqual([])
  })

  test("a failed default save is reported and nothing is selected", async () => {
    const h = harness({ lines: ["/model default local native-default", "/quit"], defaultModelSaveError: new Error("otter: config /config/otter/otter.jsonc: invalid-jsonc") })
    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })
    expect(h.calls.output.join("")).toContain("Default model not saved: Error: otter: config /config/otter/otter.jsonc: invalid-jsonc")
    expect(h.calls.runtimes).toEqual([])
  })

  test("partial flags stay unselected until /model and fill only the missing choice", async () => {
    let h: ReturnType<typeof harness>
    let selectionStarted = false
    h = harness({
      lines: ["hello before selection", "/model", "gpt-oss:20b", "/quit"],
      beforeRead(prompt) {
        if (prompt === "Model [1-2 or native ID]: ") {
          expect(h.calls.runtimes).toHaveLength(0)
          expect(h.calls.turns).toEqual([])
          selectionStarted = true
        } else if (!selectionStarted) {
          expect(h.calls.runtimes).toHaveLength(0)
          expect(h.calls.discoveries).toEqual([])
          expect(h.calls.turns).toEqual([])
        }
      },
    })
    const result = await launchInteractive({ worktree: wt.worktree, engine: "local" }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.prompts).toEqual(["You> ", "You> ", "Model [1-2 or native ID]: ", "You> "])
    expect(h.calls.runtime?.engine).toBe("local")
    expect(h.calls.runtime?.model).toBe("gpt-oss:20b")
    expect(h.calls.discoveries).toEqual([{ engine: "local", worktree: realpathSync(wt.worktree) }])
    expect(h.calls.turns).toEqual([])
    expect(h.calls.output.join("")).toContain("Engine local selected; model unselected")

    const explicit = harness({ lines: ["/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "claude", model: "claude-sonnet-4-5" }, explicit.deps)
    expect(explicit.calls.prompts).toEqual(["You> "])
    expect(explicit.calls.runtime?.engine).toBe("claude")
    expect(explicit.calls.runtime?.model).toBe("claude-sonnet-4-5")
    expect(explicit.calls.discoveries).toEqual([])

    let modelOnly: ReturnType<typeof harness>
    modelOnly = harness({
      lines: ["hello before selection", "/model", "2", "/quit"],
      beforeRead() {
        expect(modelOnly.calls.runtimes).toHaveLength(modelOnly.calls.prompts.length <= 3 ? 0 : 1)
        expect(modelOnly.calls.discoveries).toEqual([])
        expect(modelOnly.calls.turns).toEqual([])
      },
    })
    await launchInteractive({ worktree: wt.worktree, model: "manual-native-id" }, modelOnly.deps)
    expect(modelOnly.calls.prompts).toEqual(["You> ", "You> ", "Engine [1-4]: ", "You> "])
    expect(modelOnly.calls.runtime?.engine).toBe("codex")
    expect(modelOnly.calls.runtime?.model).toBe("manual-native-id")
    expect(modelOnly.calls.discoveries).toEqual([])
    expect(modelOnly.calls.turns).toEqual([])
    expect(modelOnly.calls.output.join("")).toContain("Model supplied; engine unselected")
  })

  test("invalid engine and model choices are retried without choosing an implicit default", async () => {
    let h: ReturnType<typeof harness>
    h = harness({
      lines: ["/model", "0", "claude", "bad model", "claude-sonnet-4-5", "/quit"],
      beforeRead() { expect(h.calls.runtimes).toHaveLength(h.calls.prompts.length <= 5 ? 0 : 1) },
    })
    const result = await launchInteractive({ worktree: wt.worktree }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.prompts[0]).toBe("You> ")
    expect(h.calls.prompts[1]).toBe("Engine [1-4]: ")
    expect(h.calls.prompts[2]).toBe("Engine [1-4]: ")
    expect(h.calls.output.join("").split("Choose an execution engine:")).toHaveLength(2)
    expect(h.calls.output.join("").split("Model choices for claude:")).toHaveLength(2)
    expect(h.calls.prompts[3]).toBe("Model [1-2 or native ID]: ")
    expect(h.calls.prompts[4]).toBe("Model [1-2 or native ID]: ")
    expect(h.calls.runtime?.engine).toBe("claude")
    expect(h.calls.runtime?.model).toBe("claude-sonnet-4-5")
    expect(h.calls.output.join(" ")).toContain("Invalid model ID")
  })

  test("EOF during either selection exits safely without constructing a runtime", async () => {
    for (const lines of [[undefined], ["/model", undefined], ["/model", "1", undefined]]) {
      const h = harness({ lines })
      expect((await launchInteractive({ worktree: wt.worktree }, h.deps)).code).toBe(0)
      expect(h.calls.runtime).toBeUndefined()
      expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
    }
  })

  describe("B7 Ctrl+Z and SIGCONT", () => {
    const SID = "otter-fixture-session"
    function putStopped(settled: boolean) {
      const wf = {
        ...newWorkflow(SID, currentOwner(), "command", "stop fixture", "interactive-fixture"),
        phase: (settled ? "paused" : "executing") as "paused" | "executing", stage: "unit" as const,
        stopIntent: { kind: "pause" as const, token: "tok", requestedFrom: { phase: "executing" as const, stage: "unit" }, checkpoint: null, reason: "p" },
        pausedFrom: { phase: "executing" as const, stage: "unit" },
      }
      withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, wf))
    }
    for (const settled of [true, false]) {
      test(`Ctrl+Z ${settled ? "suspends only after the pause is settled" : "is refused while the pause is unconfirmed"}`, async () => {
        putStopped(settled)
        const kill = spyOn(process, "kill").mockImplementation((() => true) as never)
        try {
          let fired = false
          const h = harness({ lines: ["/status"], beforeRead: (prompt) => {
            if (!fired && prompt.startsWith("You>")) { fired = true; h.calls.control?.("suspend") }
          } })
          ;(h.deps.terminal as { fullscreen?: boolean }).fullscreen = true
          await launchInteractive({ worktree: wt.worktree, engine: "local", model: "llama3.2" }, h.deps)
          const stops = kill.mock.calls.filter(call => call[1] === "SIGSTOP")
          if (settled) expect(stops).toHaveLength(1)
          else {
            expect(stops).toHaveLength(0)
            expect(h.calls.output.join("")).toContain("Suspension refused: pause/termination remains unconfirmed.")
          }
        } finally { kill.mockRestore() }
      })
    }

    test("SIGCONT redraws the Keep/Resume decision for a settled pause and takes no action", async () => {
      putStopped(true)
      let fired = false
      const h = harness({ lines: ["/status"], beforeRead: (prompt) => {
        if (!fired && prompt.startsWith("You>")) { fired = true; for (const listener of h.calls.signalListeners.get("SIGCONT") ?? []) listener() }
      } })
      ;(h.deps.terminal as { fullscreen?: boolean }).fullscreen = true // SIGTSTP/SIGCONT handlers exist only for the full-screen TUI
      await launchInteractive({ worktree: wt.worktree, engine: "local", model: "llama3.2" }, h.deps)
      const text = h.calls.output.join("")
      expect(text).toContain("Terminal resumed; no work was automatically restarted.")
      expect(text).toContain("Kept held; /continue offers Keep or Resume.")
      expect(h.calls.runCount).toBe(0)
    })
  })

  test("/cancel in chat never executes a plan; signal listeners are removed", async () => {
    const h = harness({ lines: ["hello", "/cancel"], turns: [{ text: "Hello." }] })
    expect((await launchInteractive({ worktree: wt.worktree, engine: "local", model: "llama3.2" }, h.deps)).code).toBe(0)
    expect(h.calls.runCount).toBe(0)
    expect(h.calls.turns).toEqual(["hello"])
    expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test.each([false, true])("shows deferred model progress through the active presentation (fullscreen=%s)", async fullscreen => {
    let markTurnStarted!: () => void
    const turnStarted = new Promise<void>(resolve => { markTurnStarted = resolve })
    let resolveDelayedTurn!: (value: { text: string; plan?: unknown }) => void
    const delayedTurn = new Promise<{ text: string; plan?: unknown }>(resolve => { resolveDelayedTurn = resolve })
    const h = harness({ fullscreen, lines: ["hello", "/quit"] })
    const createConversation = h.deps.createConversation!
    h.deps.createConversation = (runtime, sessionID) => {
      const conversation = createConversation(runtime, sessionID)
      return {
        turn: async (text, signal) => {
          await conversation.turn(text, signal)
          markTurnStarted()
          return delayedTurn
        },
      }
    }

    const operation = launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    await turnStarted
    const waiting = "[progress] Waiting for the planning model.\n"
    const response = "[activity] Planning model response received.\n"
    expect(h.calls.output.includes(waiting)).toBe(!fullscreen)
    expect(h.calls.output).not.toContain(response)
    expect(h.calls.viewFacts.at(-1)?.request.state).toBe("in-progress")

    resolveDelayedTurn({ text: "Delayed model response." })
    expect(await operation).toEqual({ code: 0 })
    expect(h.calls.output.includes(response)).toBe(!fullscreen)
    expect(h.calls.output.join("")).toContain("Delayed model response.")
  })

  test("/model switch carries the conversation into the new model with provenance", async () => {
    const h = harness({
      lines: ["first question", "second question", "/model local native-secondary", "third question", "/quit"],
      turns: [{ text: "first answer" }, { text: "second answer" }, { text: "third answer" }],
    })
    expect(await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)).toEqual({ code: 0 })
    const carried: ConversationMessage[] = [
      { role: "user", text: "first question" }, { role: "assistant", text: "first answer" },
      { role: "user", text: "second question" }, { role: "assistant", text: "second answer" },
    ]
    expect(h.calls.conversationRestores.at(-1)).toEqual({ sessionID: "otter-fixture-session-2", prior: carried })
    expect(h.calls.turnBindings.at(-1)).toMatchObject({ engine: "local", model: "native-secondary", sessionID: "otter-fixture-session-2", text: "third question" })
    expect(h.calls.output.join("").replace(/\s+/g, " ")).toContain("Conversation continues: 2 earlier turns from codex / gpt-5-codex, sent with your next message.")

    const records = replaySession(wt.worktree, "otter-fixture-session-2", { order: "asc" }).records
    expect(records[0]).toMatchObject({ kind: "carried-context", data: { sourceSessionID: "otter-fixture-session", engine: "codex", model: "gpt-5-codex", messages: carried } })
    // The new session's own replay never attributes the earlier answers to the new model as fresh assistant records.
    // Each fixture conversation replays its scripted replies from the start; only the new turn is recorded here.
    expect(records.filter(record => record.kind === "assistant").map(record => record.data.text)).toEqual(["first answer"])
    expect(records.filter(record => record.kind === "user").map(record => record.data.text)).toEqual(["third question"])
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session")).toMatchObject({ engine: "codex", model: "gpt-5-codex" })
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session-2")).toMatchObject({ engine: "local", model: "native-secondary" })
  })

  test("carried context survives resume and chains through later switches", async () => {
    const h = harness({
      lines: ["q1", "/model local native-secondary", "q2", "/model claude sonnet", "q3", "/resume otter-fixture-session-2", "/quit"],
      turns: [{ text: "a1" }],
    })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    // The fixture gives each new conversation the same scripted reply queue, so every first answer is "a1".
    expect(h.calls.conversationRestores[2]).toEqual({ sessionID: "otter-fixture-session-3", prior: [
      { role: "user", text: "q1" }, { role: "assistant", text: "a1" }, { role: "user", text: "q2" }, { role: "assistant", text: "a1" },
    ] })
    expect(h.calls.conversationRestores.at(-1)).toEqual({ sessionID: "otter-fixture-session-2", prior: [
      { role: "user", text: "q1" }, { role: "assistant", text: "a1" }, { role: "user", text: "q2" }, { role: "assistant", text: "a1" },
    ] })
  })

  const comboRoutes = { architect: { engine: "codex", model: "gpt-5.6-sol" } } as const
  const configuredCombo: ComboLookup = { state: "configured", routes: comboRoutes, sources: { architect: "user" } }

  test("a configured combo passes routes to the runtime and the banner lists them", async () => {
    const h = harness({ lines: ["hello", "/quit"], combo: configuredCombo })
    expect(await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)).toEqual({ code: 0 })
    expect(h.calls.runtimes[0]).toMatchObject({ engine: "local", model: "native", routes: comboRoutes })
    expect(h.calls.output.join("")).toContain("Route architect: codex / gpt-5.6-sol")
    expect(h.calls.viewFacts.at(-1)?.selection.routes).toEqual(comboRoutes)
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session")?.routes).toEqual(comboRoutes)
  })

  test("a route equal to the anchor is dropped, and an invalid combo is reported and not applied", async () => {
    const same = harness({ lines: ["/quit"], combo: configuredCombo })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5.6-sol" }, same.deps)
    expect(same.calls.runtimes[0]).not.toHaveProperty("routes")
    const bad = harness({ lines: ["/quit"], combo: { state: "invalid", reason: "chat.combo.main is not a routable role" } })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, bad.deps)
    expect(bad.calls.output.join("")).toContain("Combo ignored: chat.combo.main is not a routable role")
    expect(bad.calls.output.join("")).toContain("every role uses local / native")
    expect(bad.calls.runtimes[0]).not.toHaveProperty("routes")
  })

  test("/model combo saves a role route without switching and shows sources", async () => {
    const h = harness({ lines: ["/model combo architect codex gpt-5.6-sol", "/model combo show", "/model combo clear architect", "/model combo clear", "/model combo bogus x y", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    const output = h.calls.output.join("")
    expect(h.calls.comboWrites).toEqual([
      { role: "architect", route: { engine: "codex", model: "gpt-5.6-sol" } },
      { role: "architect", route: null },
      { role: "*", route: null },
    ])
    expect(output).toContain("Saved combo route architect -> codex / gpt-5.6-sol to /config/otter/otter.jsonc.")
    expect(output).toContain("architect: codex / gpt-5.6-sol (user config)")
    expect(output).toContain("/model combo apply starts a new session")
    expect(output).toContain("Usage: /model combo (menu) or /model combo [show")
    expect(h.calls.runtimes).toHaveLength(1)
  })

  test("/model combo opens a role -> engine -> model menu that saves through the same validation", async () => {
    const titles: string[] = []
    const h = harness({
      fullscreen: true,
      lines: ["/model combo", "/quit"],
      choose: async (title, values) => {
        titles.push(title)
        if (title.startsWith("Combo · main")) return titles.filter(t => t.startsWith("Combo · main")).length === 1
          ? values.findIndex(value => value.startsWith("architect —"))
          : values.indexOf("Done")
        if (title === "Combo · architect · engine") return 1
        if (title === "Choose a model · codex") return 0
        return undefined
      },
    })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(titles).toEqual(["Combo · main: local / native", "Combo · architect · engine", "Choose a model · codex", "Combo · main: local / native"])
    expect(h.calls.comboWrites).toEqual([{ role: "architect", route: { engine: "codex", model: "gpt-5-codex" } }])
    expect(h.calls.discoveries).toEqual([{ engine: "codex", worktree: realpathSync(wt.worktree) }])
    expect(h.calls.output.join("")).toContain("Saved combo route architect -> codex / gpt-5-codex")
    expect(h.calls.runtimes).toHaveLength(1)
  })

  test("/model lists combo under the engines and opens the same combo menu", async () => {
    const titles: string[] = []
    const h = harness({
      fullscreen: true,
      lines: ["/model", "/quit"],
      choose: async (title, values) => {
        titles.push(title)
        if (title === "Choose an execution engine") return values.indexOf("combo — per-role models")
        if (title.startsWith("Combo · main")) return titles.filter(t => t.startsWith("Combo · main")).length === 1
          ? values.findIndex(value => value.startsWith("critic —"))
          : values.indexOf("Done")
        if (title === "Combo · critic · engine") return 0
        if (title === "Choose a model · local") return 0
        return undefined
      },
    })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "original" }, h.deps)
    expect(titles[0]).toBe("Choose an execution engine")
    expect(titles[1]).toBe("Combo · main: codex / original")
    expect(h.calls.comboWrites).toEqual([{ role: "critic", route: { engine: "local", model: "llama3.2" } }])
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.runtimes[0]).toMatchObject({ engine: "codex", model: "original" })
  })

  test("combo menu: 'use the main model' clears the role, apply starts a new session, Escape saves nothing", async () => {
    let mainVisits = 0
    const h = harness({
      fullscreen: true, combo: configuredCombo,
      lines: ["/model combo", "/model combo", "/quit"],
      choose: async (title, values) => {
        if (title.startsWith("Combo · main")) {
          mainVisits += 1
          if (mainVisits === 1) return values.findIndex(value => value.startsWith("architect —"))
          if (mainVisits === 2) return values.indexOf("Apply to a new session")
          return undefined
        }
        if (title === "Combo · architect · engine") return values.indexOf("Use the main model (remove this route)")
        return undefined
      },
    })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(h.calls.comboWrites).toEqual([{ role: "architect", route: null }])
    expect(h.calls.runtimes.length).toBeGreaterThanOrEqual(1)
    expect(mainVisits).toBe(3)
  })

  test("readline /model offers combo as entry 4; the combo menu works before a model is selected", async () => {
    // Engine 4 = combo. Role list: 13 roles + "Clear all routes" (14) + "Done" (15); no Apply entry yet.
    const h = harness({ lines: ["/model", "4", "2", "1", "1", "16", "15", "/quit"] })
    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })
    const output = h.calls.output.join("")
    expect(output).toContain("4) combo  — per-role models")
    expect(output).toContain("Choose a listed number (1-15).")
    expect(output).toContain("15) Done")
    expect(output).toContain("Combo · main: not selected yet:")
    expect(output).toContain("2) architect — main model")
    expect(h.calls.comboWrites).toEqual([{ role: "architect", route: { engine: "local", model: "llama3.2" } }])
    expect(output).toContain("It applies when a model is selected.")
    expect(output).not.toContain("Apply to a new session")
    expect(h.calls.runtimes).toEqual([])
  })

  test("/auth shows each vendor CLI's sign-in status without running a login", async () => {
    const h = harness({ lines: ["/auth", "/quit"], auth: { codex: "signed-out" } })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    const output = h.calls.output.join("")
    expect(output).toContain("codex: not signed in · /login codex")
    expect(output).toContain("claude: signed in (fixture)")
    expect(output).toContain("local: no sign-in")
    expect(h.calls.authRuns).toEqual([])
  })

  test("/login asks for the engine and method, hands the terminal to the vendor CLI and reports the new status", async () => {
    const h = harness({ lines: ["/login", "1", "2", "/quit"], auth: { codex: "signed-out", afterRun: "signed-in" } })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(h.calls.authRuns).toEqual([{ engine: "codex", argv: ["login", "--device-auth"] }])
    const output = h.calls.output.join("")
    expect(output).toContain("Sign in to which engine?")
    expect(output).not.toContain("Sign in to which engine?:")
    expect(output).toContain("device — one-time code for a remote or headless machine")
    expect(output).toContain("codex login --device-auth exited 0. Now signed in (fixture).")
  })

  test("typed /login claude console and /logout with confirmation; Keep does nothing", async () => {
    const h = harness({ lines: ["/login claude console", "/logout claude", "1", "/logout claude", "2", "/quit"], auth: { afterRun: "signed-out" } })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(h.calls.authRuns).toEqual([
      { engine: "claude", argv: ["auth", "login", "--console"] },
      { engine: "claude", argv: ["auth", "logout"] },
    ])
    expect(h.calls.output.join("")).toContain("Still signed in to claude.")
  })

  test("/login refuses local, unknown methods and engines; it works before a model is selected", async () => {
    const h = harness({ lines: ["/login local", "/login codex console", "/login gemini", "/login codex", "1", "/quit"] })
    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })
    const output = h.calls.output.join("")
    expect(output).toContain("The local engine (Ollama) needs no sign-in.")
    expect(output).toContain("codex sign-in methods: browser, device, api-key.")
    expect(output).toContain("Usage: /auth · /login [codex|claude]")
    expect(h.calls.authRuns).toEqual([{ engine: "codex", argv: ["login"] }])
    expect(h.calls.runtimes).toEqual([])
  })

  test("Ctrl+C during the vendor sign-in is not the session's SIGINT; a missing vendor CLI is reported", async () => {
    let interruptListeners = -1
    const h = harness({ lines: ["/login codex", "1", "/quit"], auth: { runThrows: true } })
    const auth = h.deps.auth!
    const run = auth.run
    auth.run = async (engine, argv, cwd) => {
      interruptListeners = h.calls.signalListeners.get("SIGINT")?.size ?? 0
      for (const listener of h.calls.signalListeners.get("SIGINT") ?? []) listener()
      return run(engine, argv, cwd)
    }
    expect(await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)).toEqual({ code: 0 })
    expect(interruptListeners).toBe(1)
    expect(h.calls.output.join("")).toContain("codex login could not run: fixture vendor CLI missing")
  })

  test("a failed model request names a signed-out engine and how to sign in", async () => {
    const h = harness({ lines: ["hello", "/quit"], auth: { codex: "signed-out" } })
    h.deps.createConversation = () => ({ turn: async () => { throw new ModelRequestError("model_failed", "fixture") } })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.output.join("")).toContain("codex is not signed in; run /login codex.")
    const local = harness({ lines: ["hello", "/quit"] })
    local.deps.createConversation = () => ({ turn: async () => { throw new ModelRequestError("model_failed", "fixture") } })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, local.deps)
    expect(local.calls.authStatusChecks).toEqual([])
  })

  test("there is no top-level /combo command; combo lives under /model", async () => {
    const h = harness({ lines: ["/combo", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(h.calls.comboWrites).toEqual([])
    expect(h.calls.choices).toEqual([])
  })

  test("/model combo apply is a no-op when the session already uses the saved routes", async () => {
    const h = harness({ lines: ["q1", "/model combo apply", "/quit"], combo: configuredCombo })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.output.join("")).toContain("Already using that engine, model and routes")
  })

  test("/model combo apply after saving carries context under the new routes", async () => {
    const h = harness({ lines: ["q1", "/model combo architect codex gpt-5.6-sol", "/model combo apply", "q2", "/model combo apply", "/quit"], turns: [{ text: "a1" }] })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(h.calls.runtimes).toHaveLength(2)
    expect(h.calls.runtimes[0]).not.toHaveProperty("routes")
    expect(h.calls.runtimes[1]).toMatchObject({ engine: "local", model: "native", routes: comboRoutes })
    expect(h.calls.conversationRestores.at(-1)).toEqual({ sessionID: "otter-fixture-session-2", prior: [{ role: "user", text: "q1" }, { role: "assistant", text: "a1" }] })
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session")?.routes).toBeUndefined()
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session-2")?.routes).toEqual(comboRoutes)
    expect(h.calls.output.join("")).toContain("Already using that engine, model and routes")
    expect(h.calls.viewFacts.at(-1)?.selection.routes).toEqual(comboRoutes)
  })

  test("/model combo apply is refused while execution ownership is unresolved and with an invalid combo", async () => {
    const active = harness({ lines: ["/model combo apply", "/quit"], combo: configuredCombo, executionStatus: { generation: 1, claim: { ownerSession: "another-session", instance: "other-instance", pid: 1, generation: 1 }, executions: [] } })
    active.calls.combo = { state: "configured", routes: { reviewer: { engine: "claude", model: "sonnet" } }, sources: { reviewer: "user" } }
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, active.deps)
    expect(active.calls.runtimes).toHaveLength(1)
    expect(active.calls.output.join("")).toContain("Combo not applied: model selection is unavailable while this session is held")
    const bad = harness({ lines: ["/model combo apply", "/quit"], combo: { state: "invalid", reason: "chat.combo.main is not a routable role" } })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, bad.deps)
    expect(bad.calls.runtimes).toHaveLength(1)
    expect(bad.calls.output.join("")).toContain("Combo is invalid and was not applied")
  })

  function useRealRuntime(h: ReturnType<typeof harness>) {
    const root = realpathSync.native(wt.worktree)
    wt.worktree = root
    h.deps.cwd = root
    h.deps.gitTopLevel = () => root
    h.deps.createRuntime = options => createCliRuntime(options)
    h.deps.admitRuntime = async () => {}
  }
  const typoCombo: ComboLookup = { state: "configured", routes: { architect: { engine: "codex", model: "gpt-typo" } }, sources: { architect: "user" } }

  test("an unknown Codex slug in the saved combo is reported at startup and not applied (real runtime)", async () => {
    const h = harness({ lines: ["hello", "/quit"], combo: typoCombo })
    useRealRuntime(h)
    expect(await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)).toEqual({ code: 0 })
    expect(h.calls.output.join("")).toContain("Combo ignored:")
    expect(h.calls.output.join("")).toContain("gpt-typo")
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session")?.routes).toBeUndefined()
    expect(h.calls.turns).toEqual(["hello"])
  })

  test("/model combo apply with an unknown Codex slug is refused and the session stays alive (real runtime)", async () => {
    const h = harness({ lines: ["q1", "/model combo apply", "q2", "/quit"] })
    useRealRuntime(h)
    h.calls.combo = typoCombo
    expect(await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)).toEqual({ code: 0 })
    expect(h.calls.output.join("")).toContain("Combo is invalid and was not applied")
    expect(h.calls.turns).toEqual(["q1", "q2"])
    expect(h.calls.sessionIDs).toEqual(["otter-fixture-session"])
  })

  test("a plain /model switch derives routes from the saved combo, so a route hidden by an intermediate anchor returns", async () => {
    const h = harness({ lines: ["/model codex gpt-5.6-sol", "/model local native", "/new", "/quit"], combo: configuredCombo })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(h.calls.runtimes[0]).toMatchObject({ routes: comboRoutes })
    expect(h.calls.runtimes[1]).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" })
    expect(h.calls.runtimes[1]).not.toHaveProperty("routes")
    expect(h.calls.runtimes[2]).toMatchObject({ engine: "local", model: "native", routes: comboRoutes })
    expect(h.calls.runtimes[3]).toMatchObject({ engine: "local", model: "native", routes: comboRoutes })
  })

  test("/new and a plain switch use the saved combo, not the current session's routes", async () => {
    const h = harness({ lines: ["/model combo clear", "/new", "/model codex gpt-5.6-sol", "/quit"], combo: configuredCombo })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(h.calls.runtimes[1]).toMatchObject({ engine: "local", model: "native" })
    expect(h.calls.runtimes[1]).not.toHaveProperty("routes")
  })

  test("a switch with an invalid saved combo reports it and starts the session without routes", async () => {
    const h = harness({ lines: ["/model codex gpt-5.6-sol", "/quit"], combo: configuredCombo })
    h.calls.combo = { state: "invalid", reason: "chat.combo.main is not a routable role" }
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(h.calls.runtimes[1]).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" })
    expect(h.calls.runtimes[1]).not.toHaveProperty("routes")
    expect(h.calls.output.join("")).toContain("Combo ignored: chat.combo.main is not a routable role")
  })

  test("combo show, set and clear work while the session is held; only apply is refused", async () => {
    const h = harness({ lines: ["/model combo show", "/model combo architect codex gpt-5.6-sol", "/model combo clear architect", "/model combo apply", "/quit"], combo: configuredCombo, executionStatus: { generation: 1, claim: { ownerSession: "another-session", instance: "other-instance", pid: 1, generation: 1 }, executions: [] } })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    const output = h.calls.output.join("")
    expect(h.calls.actionContexts).toContain("held")
    expect(output).toContain("Combo routes (main is the /model selection)")
    expect(output).toContain("Saved combo route architect")
    expect(output).toContain("route architect cleared")
    expect(output).toContain("Combo not applied: model selection is unavailable while this session is held")
    expect(h.calls.comboWrites).toHaveLength(2)
    expect(h.calls.runtimes).toHaveLength(1)
  })

  test("saving a route before a model is selected does not promise a new session", async () => {
    const h = harness({ lines: ["/model combo architect codex gpt-5.6-sol", "/quit"] })
    await launchInteractive({ worktree: wt.worktree }, h.deps)
    const output = h.calls.output.join("")
    expect(output).toContain("Saved combo route architect")
    expect(output).toContain("It applies when a model is selected.")
    expect(output).not.toContain("starts a new session")
  })

  test("/memory selects the recall engine from the composer, before and during a session, without a model turn", async () => {
    const base = { endpoint: "http://127.0.0.1:8080", timeout_ms: 120_000, min_probability: 0.3, max_pages: 3 }
    type Engine = "auto" | "jev" | "claude" | "codex" | "local" | "off"
    let memory: { engine: Engine; model?: string; endpoint: string; timeout_ms: number; min_probability: number; max_pages: number } = { ...base, engine: "jev" }
    const saved: unknown[] = []
    const store = {
      read: () => memory,
      save: (engine: Engine, model?: string) => { saved.push([engine, model]); memory = { ...base, engine, ...(model ? { model } : {}) }; return "/u/otter.jsonc" },
      resolve: (m: typeof memory) => m.engine === "claude" ? { ok: true as const, engine: "claude" as const, model: m.model ?? "claude-haiku-5-5", auto: false } : { ok: false as const, reason: "off" as const },
    }
    const unselected = harness({ lines: ["/memory", "/memory claude haiku", "/quit"] })
    await launchInteractive({ worktree: wt.worktree }, { ...unselected.deps, memory: store })
    const before = unselected.calls.output.join("")
    expect(before).toContain("Memory engine: jev (local OpenJev server at memory.endpoint)")
    expect(before).toContain("Saved memory engine claude / haiku")
    expect(unselected.calls.runtimes).toHaveLength(0)
    const chat = harness({ lines: ["/memory show", "/memory off", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, { ...chat.deps, memory: store })
    const during = chat.calls.output.join("")
    expect(during).toContain("Memory engine: claude / haiku")
    expect(during).toContain("Saved memory engine off")
    expect(chat.calls.runtimes).toHaveLength(1)
    expect(saved).toEqual([["claude", "haiku"], ["off", undefined]])
  })

  test("clear says when a project route still supplies the effective combo", async () => {
    const h = harness({ lines: ["/model combo clear architect", "/quit"], combo: { state: "configured", routes: comboRoutes, sources: { architect: "project" } } })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(h.calls.output.join("")).toContain("still routes architect from this project's .otter/otter.jsonc")
  })

  test("/resume rebuilds the pinned routes from session metadata after config changed", async () => {
    const h = harness({ lines: ["q1", "/model combo clear", "/model combo apply", "/resume otter-fixture-session", "/quit"], combo: configuredCombo })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(h.calls.runtimes).toHaveLength(3)
    expect(h.calls.runtimes[1]).not.toHaveProperty("routes")
    expect(h.calls.runtimes[2]).toMatchObject({ engine: "local", model: "native", routes: comboRoutes })
    expect(h.calls.viewFacts.at(-1)?.selection.routes).toEqual(comboRoutes)
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session-2")?.routes).toBeUndefined()
  })

  test("/new keeps the current session's routes", async () => {
    const h = harness({ lines: ["/new", "/quit"], combo: configuredCombo })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "native" }, h.deps)
    expect(h.calls.runtimes.at(-1)).toMatchObject({ routes: comboRoutes })
  })

  test("/new starts without carried context and an unreadable conversation refuses the switch", async () => {
    const h = harness({ lines: ["q1", "/new", "q2", "/quit"], turns: [{ text: "a1" }, { text: "a2" }] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.conversationRestores.at(-1)).toEqual({ sessionID: "otter-fixture-session-2" })
    expect(replaySession(wt.worktree, "otter-fixture-session-2", { order: "asc" }).records.some(record => record.kind === "carried-context")).toBe(false)
  })

  test("!command runs in the worktree, prints and persists the run, and never reaches the model", async () => {
    const h = harness({ lines: ["!pwd; printf 'a\\nb\\n'; exit 3", "!", "/quit"] })
    const result = await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.turns).toEqual([])
    const output = h.calls.output.join("")
    expect(output).toContain(`$ pwd; printf 'a\\nb\\n'; exit 3\n${realpathSync(wt.worktree)}\na\nb\n[shell] exit 3 · `)
    expect(output).toContain("Usage: !<command> runs one shell command in the worktree.")
    const records = replaySession(wt.worktree, "otter-fixture-session", { order: "asc" }).records
    expect(records.some(record => record.kind === "user")).toBe(false)
    const shell = records.find(record => record.kind === "shell")
    expect(shell?.eventID).toStartWith("shell:")
    expect(shell?.data).toMatchObject({ command: "pwd; printf 'a\\nb\\n'; exit 3", status: "error", exitCode: 3, signal: null,
      lines: [realpathSync(wt.worktree), "a", "b"], totalLines: 3 })
  })

  test("a shell window streams through shellStart and Esc cancels only the shell", async () => {
    let h: ReturnType<typeof harness>
    const runs: Array<{ id: string; command: string }> = []
    const snapshots: string[][] = []
    const results: ShellResult[] = []
    h = harness({ lines: ["!echo started; sleep 30", "/quit"] })
    h.deps.terminal!.shellStart = run => {
      runs.push(run)
      return {
        output: snapshot => {
          snapshots.push([...snapshot.lines])
          if (snapshot.lines.includes("started")) h.calls.control?.("cancel")
        },
        finish: result => { results.push(result) },
      }
    }
    const result = await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(result.code).toBe(0)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.command).toBe("echo started; sleep 30")
    expect(snapshots.at(-1)).toEqual(["started"])
    expect(results[0]).toMatchObject({ status: "cancelled", lines: ["started"] })
    expect(results[0]!.durationMs).toBeLessThan(10_000)
    // The cancelled shell left the session alive: /quit was still read afterwards.
    expect(h.calls.prompts.length).toBeGreaterThanOrEqual(2)
    expect(h.calls.output.join("")).not.toContain("[shell]")
    const shell = replaySession(wt.worktree, "otter-fixture-session", { order: "asc" }).records.find(record => record.kind === "shell")
    expect(shell?.eventID).toBe(runs[0]!.id)
    expect(shell?.data.status).toBe("cancelled")
  })

  test("local help, picker and unknown slash commands never reach inference; /plan stays a prompt", async () => {
    const h = harness({ lines: ["/help", "/unknown", "/model", "2", "native-secondary", "hello", "/plan", "/quit"] })
    const result = await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.turns).toEqual(["hello", "/plan"])
    expect(h.calls.turnBindings).toEqual([
      { engine: "codex", model: "native-secondary", sessionID: "otter-fixture-session-2", text: "hello" },
      { engine: "codex", model: "native-secondary", sessionID: "otter-fixture-session-2", text: "/plan" },
    ])
    expect(h.calls.runtimes).toEqual([
      { worktree: realpathSync(wt.worktree), engine: "codex", model: "gpt-5-codex" },
      { worktree: realpathSync(wt.worktree), engine: "codex", model: "native-secondary" },
    ])
    expect(h.calls.sessionIDs).toEqual(["otter-fixture-session", "otter-fixture-session-2"])
    expect(h.calls.discoveries).toEqual([{ engine: "codex", worktree: realpathSync(wt.worktree) }])
    expect(h.calls.output.join("")).toContain("Commands (chat):\n/help — show contextual commands and keys")
    expect(h.calls.output.join("")).toContain("New conversation: no earlier turns to carry.")
  })

  test("a settled model response failure returns to the composer for an explicitly submitted next request", async () => {
    const secret = "PRIVATE_PROVIDER_SECRET_recovery_fixture_6b22"
    let h: ReturnType<typeof harness>
    h = harness({
      lines: ["first manual request", "second manual request", "/quit"],
      turnErrors: [new ModelRequestError("model_failed", secret)],
      beforeRead() {
        if (h.calls.turns.length === 1) expect(h.calls.queueAdmissions.at(-1)).toBe(false)
      },
    })
    h.deps.terminal!.draftSnapshot = () => ({ draft: "", queued: ["retained queued request"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)

    expect(h.calls.turns).toEqual(["first manual request", "second manual request"])
    expect(h.calls.drafts).toEqual(["first manual request"])
    expect(h.calls.output.join("")).toContain("[error] The model request failed after execution stopped.")
    expect(h.calls.output.join("")).toContain("submit the draft again manually")
    expect(h.calls.output.join("")).not.toContain(secret)
    expect(h.calls.viewFacts.some(fact => fact.request.state === "failed" && fact.request.category.state === "known" &&
      fact.request.category.value === "model_failed" && fact.request.retryable.state === "unknown")).toBe(true)

    const records = replaySession(wt.worktree, "otter-fixture-session", { order: "asc" }).records
    expect(records.filter(record => record.kind === "user").map(record => record.data.text)).toEqual([
      "first manual request", "second manual request",
    ])
    expect(records.filter(record => record.kind === "assistant").map(record => record.data.text)).toEqual(["Acknowledged."])
    expect(records.some(record => record.kind === "notice" && record.data.provenance === "error")).toBe(true)
  })

  test("transcript append failure during model-error recovery remains fail-closed and does not leak diagnostics", async () => {
    const storageSecret = "PRIVATE_TRANSCRIPT_APPEND_SECRET_b6"
    const providerSecret = "PRIVATE_PROVIDER_SECRET_b6"
    const h = harness({
      lines: ["first request", "must not be read or retried"],
      turnErrors: [new ModelRequestError("model_failed", providerSecret)],
      onTurnError() {
        const store = getOwnedSession(wt.worktree, "otter-fixture-session")
        if (!store) throw new Error("fixture session store was not attached")
        const append = store.append.bind(store)
        store.append = (kind, data, eventID) => {
          if (kind === "notice" && data.provenance === "error") throw new Error(storageSecret)
          return append(kind, data, eventID)
        }
      },
    })
    h.deps.terminal!.draftSnapshot = () => ({ draft: "", queued: [] })

    const failure = await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps).catch(error => error)
    expect(failure).toMatchObject({ message: "Session transcript persistence failed; the session remains held." })
    expect(String(failure)).not.toContain(storageSecret)

    expect(h.calls.turns).toEqual(["first request"])
    expect(h.calls.prompts).toEqual(["You> "])
    expect(h.calls.drafts).toEqual([])
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.output.join("")).not.toContain(storageSecret)
    expect(h.calls.output.join("")).not.toContain(providerSecret)
  })

  test("generic errors remain fail-closed instead of being treated as recoverable model failures", async () => {
    const secret = "PRIVATE_INTEGRITY_DIAGNOSTIC_fatal_25a3"
    const h = harness({
      lines: ["first request", "must not be retried"],
      turnErrors: [new Error(secret)],
    })
    await expect(launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)).rejects.toThrow(secret)

    expect(h.calls.turns).toEqual(["first request"])
    expect(h.calls.output.join("")).not.toContain(secret)
    expect(h.calls.viewFacts.some(fact => fact.request.state === "failed" && fact.request.category.state === "unknown")).toBe(true)
  })

  test.each(["claim", "unsettled", "fenced", "held", "foreign-workflow"] as const)(
    "a settled model failure does not restore chat when %s ownership/safety state appears",
    async scenario => {
      const executionStatus: NonNullable<HarnessOptions["executionStatus"]> = { generation: 0, executions: [] }
      const h = harness({
        lines: ["first request", "must not be retried"],
        executionStatus,
        turnErrors: [new ModelRequestError("empty_response", "planning model did not complete a response")],
        onTurnError() {
          if (scenario === "claim") {
            executionStatus.claim = { ownerSession: "otter-fixture-session", instance: "fixture", pid: process.pid, generation: 1 }
          } else if (scenario === "unsettled") {
            executionStatus.executions.push({ executionId: "unsettled", ownerSession: "otter-fixture-session", generation: 1,
              reconciliation: { outcome: "running", quiescent: false } })
          } else if (scenario === "fenced") {
            executionStatus.executions.push({ executionId: "fenced", ownerSession: "otter-fixture-session", generation: 1,
              kind: "host", terminal: { outcome: "failed", terminalAt: Date.now() },
              reconciliation: { outcome: "terminal", quiescent: true }, fence: { reason: "fixture fence", at: Date.now() } })
          } else if (scenario === "held") {
            holdAdmission(realpathSync(wt.worktree), "otter-fixture-session", "fixture_hold")
          } else {
            withFlowTransaction(wt.worktree, tx => writeWorkflow(tx,
              newWorkflow("foreign-owner", { instance: "fixture", pid: process.pid }, "command", "foreign workflow", "codex")))
          }
        },
      })
      const operation = launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
      await expect(operation).rejects.toBeInstanceOf(ModelRequestError)
      expect(h.calls.turns).toEqual(["first request"])
      expect(h.calls.output.join("")).not.toContain("submit the draft again manually")
    },
  )

  test("readline refuses full-screen local presentation commands without model dispatch", async () => {
    const h = harness({ lines: ["/search task", "/expand 1", "/details", "/theme dark", "/ascii", "/quit"] })
    const result = await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.turns).toEqual([])
    expect(h.calls.output.join("")).toContain("/search is a local full-screen TUI action")
    expect(h.calls.output.join("")).toContain("/ascii is a local full-screen TUI action")
  })

  test("captured session chooser hands the stable target to the shared opener exactly once", async () => {
    const target = openSession(wt.worktree, "captured-target", { engine: "local", model: "qwen3:8b" })
    target.release({ workflowQuiescent: true, evidence: "chooser fixture", workflowID: null, revision: null })
    const h = harness({
      lines: ["/sessions", "/quit"],
      choose: async (_title, values) => values.findIndex(value => value.includes("captured-target")),
    })
    const result = await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.choices).toHaveLength(1)
    expect(h.calls.boundSessions.filter(sessionID => sessionID === "captured-target")).toHaveLength(1)
    expect(h.calls.turns).toEqual([])
  })

  test("direct model switch uses the new runtime and session on the next turn without discovery", async () => {
    const h = harness({
      lines: ["/model local qwen3:8b", "hello", "/quit"],
      activityForTurn(selection, progress) {
        progress?.host({
          kind: "tool-started",
          role: "worker",
          execution: 1,
          executionID: "exec1", callID: "call1", taskID: "t1",
          tool: selection.engine === "local" ? "write" : "read",
        })
      },
    })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.runtimes).toEqual([
      { worktree: realpathSync(wt.worktree), engine: "codex", model: "gpt-5-codex" },
      { worktree: realpathSync(wt.worktree), engine: "local", model: "qwen3:8b" },
    ])
    expect(h.calls.sessionIDs).toEqual(["otter-fixture-session", "otter-fixture-session-2"])
    expect(h.calls.turnBindings).toEqual([
      { engine: "local", model: "qwen3:8b", sessionID: "otter-fixture-session-2", text: "hello" },
    ])
    expect(h.calls.discoveries).toEqual([])
    expect(h.calls.viewFacts.at(-1)?.discovery).toBe("not-observed")
    expect(h.calls.progressSinks).toHaveLength(2)
    expect(h.calls.progressSinks[0]).not.toBe(h.calls.progressSinks[1])
    const beforeStaleCallback = [...h.calls.output]
    h.calls.progressSinks[0]!.host({ kind: "tool-started", role: "worker", execution: 2, executionID: "old-execution", callID: "old-call", taskID: "t1", tool: "read" })
    expect(h.calls.output).toEqual(beforeStaleCallback)
    expect(h.calls.output.filter(line => line.startsWith("[activity] Worker"))).toEqual([
      "[activity] Worker started write tool.\n",
    ])
  })

  test("same engine and model is a no-op and does not reset conversation context", async () => {
    const h = harness({ lines: ["/model codex gpt-5-codex", "hello", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.sessionIDs).toEqual(["otter-fixture-session"])
    expect(h.calls.turnBindings[0]).toEqual({
      engine: "codex", model: "gpt-5-codex", sessionID: "otter-fixture-session", text: "hello",
    })
    expect(h.calls.output.join("")).toContain("conversation context is unchanged")
  })

  test("invalid picker entries preserve the old runtime and conversation", async () => {
    const h = harness({ lines: ["/model", "codex", "0", "bad model", "gpt-5-codex", "hello", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.sessionIDs).toEqual(["otter-fixture-session"])
    expect(h.calls.turnBindings[0]).toEqual({
      engine: "codex", model: "gpt-5-codex", sessionID: "otter-fixture-session", text: "hello",
    })
    expect(h.calls.output.join("")).toContain("Invalid model choice")
    expect(h.calls.output.join("")).toContain("Invalid model ID")
  })

  test("candidate setup failure preserves the old selection and session", async () => {
    const h = harness({
      lines: ["/model local qwen3:8b", "hello", "/quit"],
      failRuntimeFor: engine => engine === "local",
    })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.sessionIDs).toEqual(["otter-fixture-session"])
    expect(h.calls.turnBindings[0]).toEqual({
      engine: "codex", model: "gpt-5-codex", sessionID: "otter-fixture-session", text: "hello",
    })
    expect(h.calls.output.join("")).toContain("current selection and conversation are unchanged")
  })

  test.each(["", "/cancel"])("picker cancellation %j keeps the current conversation usable", async (cancel) => {
    const h = harness({ lines: ["/model", "local", cancel, "hello", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.turnBindings).toEqual([
      { engine: "codex", model: "gpt-5-codex", sessionID: "otter-fixture-session", text: "hello" },
    ])
  })

  test("candidate preflight refusal preserves the old session before creating a conversation", async () => {
    const h = harness({ lines: ["/model local qwen3:8b", "hello", "/quit"] })
    let admissions = 0
    h.deps.admitRuntime = async () => {
      if (++admissions === 2) throw AdmissionRefusal.hostIncompatible()
    }
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(admissions).toBe(2)
    expect(h.calls.sessionIDs).toEqual(["otter-fixture-session"])
    expect(h.calls.turnBindings[0]?.engine).toBe("codex")
    expect(h.calls.output.join("")).toContain("current selection and conversation are unchanged")
  })

  test("default startup admission rejects an incompatible native host before conversation", async () => {
    const h = harness({ lines: ["/quit"] })
    const factory = h.deps.createRuntime!
    h.deps.createRuntime = options => Object.assign(factory(options), {
      host: {
        identity: { engine: "local", profile: "legacy-unowned" },
        preflight: async () => ({ compatible: false, controls: {}, problems: ["missing CLI"] }),
      },
    }) as unknown as ExecutionRuntime
    delete h.deps.admitRuntime
    await expect(launchInteractive({ worktree: wt.worktree, engine: "local", model: "model" }, h.deps))
      .rejects.toBeInstanceOf(AdmissionRefusal)
    expect(h.calls.sessionIDs).toEqual([])
  })

  test("unexpected candidate setup errors propagate rather than hiding state defects", async () => {
    const h = harness({
      lines: ["/model local qwen3:8b", "hello", "/quit"],
      failConversationFor: engine => engine === "local",
    })
    await expect(launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps))
      .rejects.toThrow("fixture conversation setup failed")
    expect(h.calls.turns).toEqual([])
    expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("another session's workflow allows a model switch but no new chat; corrupt workflow state refuses switching", async () => {
    const path = workflowPath(wt.worktree)
    withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, newWorkflow("another-session",
      { instance: "fixture", pid: process.pid }, "command", "active plan", "codex")))
    const active = harness({ lines: ["/help", "/model local qwen3:8b", "hello", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, active.deps)
    expect(active.calls.actionContexts).toContain("observer")
    expect(active.calls.output.find(text => text.includes("Commands (observer):")) ?? "").toContain("/model")
    expect(active.calls.runtimes).toHaveLength(2)
    expect(active.calls.runtimes[1]).toMatchObject({ engine: "local", model: "qwen3:8b" })
    expect(active.calls.turnBindings).toEqual([])
    expect(active.calls.output.join("")).not.toContain("resolve the active workflow first")
    expect(active.calls.output.join("")).toContain("workflow belongs to another-session")
    expect(active.calls.output.join("")).toContain("No new workflow can start here")

    writeFileSync(path, "{")
    const corrupt = harness({ lines: ["/model local qwen3:8b", "hello", "/quit"] })
    await expect(launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, corrupt.deps)).rejects.toThrow("workflow state is corrupt")
    expect(corrupt.calls.runtimes).toHaveLength(1)
    expect(corrupt.calls.runtimes[0]?.engine).toBe("codex")
    expect(corrupt.calls.turnBindings).toEqual([])
  })

  test("held workflow and claim contexts hide /model and refuse typed switches before discovery", async () => {
    expect(interactiveActions("held").some(action => action.id === "model")).toBe(false)
    expect(interactiveActions("observer").some(action => action.id === "model")).toBe(true)

    // This session's own held workflow (not another session's) keeps /model refused.
    withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, newWorkflow("otter-fixture-session",
      { instance: "fixture", pid: process.pid }, "command", "active plan", "codex")))
    const workflow = harness({ lines: ["/help", "/model local qwen3:8b", "hello", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, workflow.deps)
    const workflowHelp = workflow.calls.output.find(text => text.includes("Commands (held):"))
    expect(workflowHelp).toBeDefined()
    expect(workflowHelp ?? "").not.toContain("/model")
    expect(workflow.calls.actionContexts).toContain("held")
    expect(workflow.calls.output.join(" ")).toContain("Model selection is unavailable while this session is held")
    expect(workflow.calls.discoveries).toEqual([])
    expect(workflow.calls.runtimes).toHaveLength(1)
    expect(workflow.calls.sessionIDs).toEqual(["otter-fixture-session"])
    expect(workflow.calls.turnBindings).toEqual([])
    expect(readSessionMetadata(wt.worktree, "otter-fixture-session")).toMatchObject({ engine: "codex", model: "gpt-5-codex" })

    const claimWorktree = tempGitWorktree()
    try {
      const claim = {
        generation: 1,
        claim: { ownerSession: "another-session", instance: "other-instance", pid: 1, generation: 1 },
        executions: [],
      }
      const claimed = harness({ lines: ["/help", "/model local qwen3:8b", "hello", "/quit"], executionStatus: claim })
      claimed.deps.cwd = claimWorktree.worktree
      claimed.deps.gitTopLevel = () => claimWorktree.worktree
      await launchInteractive({ worktree: claimWorktree.worktree, engine: "codex", model: "gpt-5-codex" }, claimed.deps)
      const claimSessionID = claimed.calls.sessionIDs[0]!
      const claimHelp = claimed.calls.output.find(text => text.includes("Commands (held):"))
      expect(claimHelp).toBeDefined()
      expect(claimHelp ?? "").not.toContain("/model")
      expect(claimed.calls.actionContexts).toContain("held")
      expect(claimed.calls.output.join(" ")).toContain("Model selection is unavailable while this session is held")
      expect(claimed.calls.discoveries).toEqual([])
      expect(claimed.calls.runtimes).toHaveLength(1)
      expect(claimed.calls.sessionIDs).toEqual([claimSessionID])
      expect(claimed.calls.turnBindings).toEqual([])
      expect(readSessionMetadata(claimWorktree.worktree, claimSessionID)).toMatchObject({ engine: "codex", model: "gpt-5-codex" })
    } finally {
      claimWorktree.cleanup()
    }
  })

  test("unresolved execution claims or intents refuse switching", async () => {
    const cases = [
      {
        generation: 1,
        claim: { ownerSession: "another-session", instance: "other-instance", pid: 1, generation: 1 },
        executions: [],
      },
      {
        generation: 1,
        executions: [{ executionId: "unfinished", kind: "host", profile: "legacy-unowned" }],
      },
    ]
    for (const executionStatus of cases) {
      const h = harness({
        lines: ["/model local qwen3:8b", "hello", "/quit"],
        executionStatus,
      })
      await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
      expect(h.calls.runtimes).toHaveLength(1)
      expect(h.calls.runtimes[0]?.engine).toBe("codex")
      expect(h.calls.turnBindings).toEqual([])
      expect(h.calls.output.join("")).toContain("execution ownership is unresolved")
    }
  })

  test("EOF and signals in the model picker preserve the current runtime and clean listeners", async () => {
    const eof = harness({ lines: ["/model", "codex", undefined] })
    expect((await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, eof.deps)).code).toBe(0)
    expect(eof.calls.runtimes).toHaveLength(1)
    expect([...eof.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)

    let interrupted: ReturnType<typeof harness>
    interrupted = harness({
      lines: ["/model", "codex"],
      beforeRead: prompt => { if (prompt.startsWith("Model [")) interrupted.emitSignal("SIGTERM") },
    })
    expect((await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, interrupted.deps)).code).toBe(143)
    expect(interrupted.calls.runtimes).toHaveLength(1)
    expect([...interrupted.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("discovered labels and notices are terminal-safe", async () => {
    const h = harness({
      lines: ["/model", "1", "/quit"],
      catalog: { models: [{ id: "native-safe", label: "Label\u001b[2J\nYou> forged" }], notice: "Notice\u202eunsafe" },
    })
    await launchInteractive({ worktree: wt.worktree, engine: "codex" }, h.deps)
    const output = h.calls.output.join("")
    expect(output).toContain("Label\\u001b[2J\\u000aYou> forged")
    expect(output).not.toContain("\nYou> forged")
    expect(output).toContain("Notice\\u202eunsafe")
    expect(unsafeTerminalControls.test(output)).toBe(false)
  })

  test("EOF at the chat prompt exits without execution", async () => {
    const h = harness({ lines: [] })
    expect((await launchInteractive({ worktree: wt.worktree, engine: "local", model: "llama3.2" }, h.deps)).code).toBe(0)
    expect(h.calls.turns).toEqual([])
    expect(h.calls.runCount).toBe(0)
    expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("external cancellation while waiting for chat input exits with signal status and cleans listeners", async () => {
    let h: ReturnType<typeof harness>
    h = harness({
      lines: [],
      beforeRead: (prompt) => { if (prompt === "You> ") h.emitSignal("SIGINT") },
    })
    expect((await launchInteractive({ worktree: wt.worktree, engine: "local", model: "llama3.2" }, h.deps)).code).toBe(130)
    expect(h.calls.turns).toEqual([])
    expect(h.calls.runCount).toBe(0)
    expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("displays the canonical plan and SHA, and runs only after an explicit approval receipt", async () => {
    const h = harness({
      lines: ["make the change"],
      turns: [{ text: "Proposed plan follows.", plan: proposedPlan }],
    })
    const presented: TranscriptText[] = []
    h.deps.terminal!.writeText = value => {
      presented.push(value)
      h.calls.output.push(value.text)
    }
    const result = await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    const parsedPlan = { ...proposedPlan, revision: 1 }
    const records = replaySession(wt.worktree, "otter-fixture-session", { order: "asc" }).records
    expect(result.code).toBe(0)
    expect(h.calls.sessionID).toBe("otter-fixture-session")
    expect(h.calls.validated).toEqual(parsedPlan)
    expect(h.calls.imported).toEqual(parsedPlan)
    expect(h.calls.output.join(" ")).toContain("# Canonical plan")
    expect(h.calls.output.join(" ")).toContain("Plan SHA: sha-fixture")
    expect(presented.some(value => value.provenance === "canonical-plan" && value.text === "# Canonical plan\n\nDo the requested work.\n")).toBe(true)
    expect(records.filter(record => record.kind === "canonical-plan").map(record => record.data)).toEqual([
      { text: "# Canonical plan\n\nDo the requested work.\n" },
    ])
    expect(records.some(record => record.kind === "notice" && typeof record.data.text === "string" &&
      record.data.text.includes("Do the requested work."))).toBe(false)
    expect(h.calls.events.indexOf("humanDecision")).toBeLessThan(h.calls.events.indexOf("decide"))
    expect(h.calls.events.indexOf("decide")).toBeLessThan(h.calls.events.indexOf("run"))
    expect(h.calls.runCount).toBe(1)
  })

  test("keeps task lifecycle and reviewer activity visible until a deferred queue run settles", async () => {
    let markRunStarted!: () => void
    const runStarted = new Promise<void>(resolve => { markRunStarted = resolve })
    const h = harness({
      lines: ["make the change"],
      turns: [{ text: "Proposed plan follows.", plan: proposedPlan }],
      taskIDs: ["t1"],
      workflowID: "wf_20261011220000_abcd",
      deferRun: true,
      beforeRun: () => markRunStarted(),
    })
    const operation = launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    await runStarted
    const progress = h.calls.progressSinks[0]!
    expect(h.calls.output).toContain("[tasks] t1 pending — Implement.\n")
    expect(h.calls.output.join(" ")).not.toContain("[final]")

    progress.queue("task start", { task: "t1", attempt: 1 })
    progress.host({ kind: "model-started", role: "reviewer", execution: 1 })
    progress.host({ kind: "tool-started", role: "reviewer", execution: 1, executionID: "exec1", callID: "call1", taskID: "t1", tool: "read" })
    progress.host({ kind: "tool-finished", role: "reviewer", execution: 1, executionID: "exec1", callID: "call1", taskID: "t1", tool: "read", ok: true, outcome: "succeeded" })
    progress.host({ kind: "model-returned", role: "reviewer", execution: 1, status: "completed" })
    progress.queue("task verify", { task: "t1", ok: false, output: "PRIVATE_VERIFIER_OUTPUT_9a37" })
    progress.queue("task attempt failed", { task: "t1", attempt: 1 })
    progress.queue("task start", { task: "t1", attempt: 2 })
    for (let repeat = 0; repeat < 20; repeat++) progress.queue("task verify", { task: "t1", ok: true })
    progress.queue("task finished", { task: "t1", status: "done" })

    const repeatedProgress = h.calls.output.join("")
    expect(h.calls.runCount).toBe(1)
    expect(h.calls.output).toContain("[tasks] t1 running (attempt 1).\n")
    expect(h.calls.output).toContain("[tasks] t1 running (attempt 2).\n")
    expect(h.calls.output).toContain("[activity] t1 verification failed.\n")
    expect(h.calls.output).toContain("[activity] t1 verification passed.\n")
    expect(h.calls.output.filter(line => line === "[activity] t1 verification passed.\n")).toHaveLength(1)
    expect(h.calls.output).toContain("[error] t1 attempt 1 failed; final task status is not yet settled.\n")
    expect(h.calls.output).toContain("[activity] Reviewer model is working.\n")
    expect(h.calls.output).toContain("[activity] Reviewer started read tool.\n")
    expect(h.calls.output).toContain("[activity] Reviewer finished read tool.\n")
    expect(h.calls.output).toContain("[activity] Reviewer model response received.\n")
    expect(h.calls.output).toContain("[tasks] t1 done.\n")
    expect(repeatedProgress).not.toContain("PRIVATE_VERIFIER_OUTPUT_9a37")
    expect(h.calls.output.filter(line => /^\[(?:progress|activity|tasks|error|final)\]/u.test(line))
      .every(line => line.endsWith("\n") && line.trimEnd().split("\n").length === 1)).toBe(true)
    expect(h.calls.output.join(" ")).not.toContain("[final]")

    h.releaseRun()
    expect(await operation).toEqual({ code: 0 })
    expect(h.calls.output).toContain("[final] Workflow wf_20261011220000_abcd done; done 1, failed 0, cancelled 0.\n")
  })

  test("invalid plan feedback lets the user revise in the same conversation before real approval", async () => {
    const invalidPlan = {
      ...proposedPlan,
      steps: proposedPlan.steps.map((step, index) => index === 0
        ? { ...step, detail: "Do not edit double.test.ts." }
        : step),
    }
    const revisedPlan = {
      ...proposedPlan,
      goal: "Make the requested change without touching the protected test.",
    }
    const h = harness({
      lines: ["make the requested change", "revise the plan to avoid the protected test"],
      turns: [
        { text: "First plan draft.", plan: invalidPlan },
        { text: "Revised plan.", plan: revisedPlan },
      ],
      validatePlan(plan) {
        const value = plan as typeof invalidPlan & { revision: number }
        if (value.steps[0]?.detail === "Do not edit double.test.ts.") {
          throw new Error(`invalid plan: step 1: do not edit double.test.ts. \u001b[2J\u202e ${"extra detail ".repeat(40)}`)
        }
      },
    })
    await launchInteractive(
      { worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" },
      { ...h.deps, humanDecision: (...args) => withTerminalLine(
        "APPROVE wf_fixture sha-fixture", () => humanDecision(...args),
      ) },
    )

    expect(h.calls.sessionID).toBe("otter-fixture-session")
    expect(h.calls.turns).toEqual([
      "make the requested change",
      "revise the plan to avoid the protected test",
    ])
    expect(h.calls.validationAttempts).toEqual([
      { ...invalidPlan, revision: 1 },
      { ...revisedPlan, revision: 1 },
    ])
    expect(h.calls.imported).toEqual({ ...revisedPlan, revision: 1 })
    expect(h.calls.events.filter(event => event === "validate")).toHaveLength(2)
    expect(h.calls.events.filter(event => event === "import")).toHaveLength(1)
    expect(h.calls.events.indexOf("import")).toBeGreaterThan(h.calls.events.lastIndexOf("validate"))
    expect(h.calls.output.join(" ")).toContain("Plan rejected by Otter validation")
    expect(h.calls.output.join(" ")).toContain("do not edit double.test.ts")
    expect(h.calls.output.join("")).toContain("step 1: do not edit double.test.ts. \\u001b[2J\\u202e")
    expect(h.calls.output.join("")).not.toMatch(unsafeTerminalControls)
    expect(h.calls.output.join("")).not.toContain("\u001b[2J\u202e")
    expect(h.calls.output.join(" ")).toContain("Revise the plan or enter /quit")
    const feedback = h.calls.output.find(output => output.startsWith("[error] Plan rejected by Otter validation"))
    expect(feedback).toContain("...")
    expect(feedback?.length).toBeLessThanOrEqual(360)
    expect(h.calls.output.filter(output => output.startsWith("[error] Plan rejected by Otter validation"))).toHaveLength(1)
    expect(h.calls.decision?.action).toBe("approve")
    expect(h.calls.runCount).toBe(1)
  })

  test("sanitizes discussion and displayed canonical plan without changing the real SHA approval binding", async () => {
    const injection = "CSI-START\u001b[2JOSC-START\u001b]52;c;Y2xpcA==\u0007C1-CSI\u009b31mCR\rBIDI\u202eEND"
    const planSha = "a".repeat(64)
    const h = harness({
      lines: ["make the change"],
      turns: [{ text: `Discussion remains 日本語\tordinary text. ${injection}`, plan: proposedPlan }],
      renderedPlan: `# Canonical plan remains\n\nPlan text remains 日本語. ${injection}\n`,
      planSha,
    })
    h.deps.humanDecision = async (action, binding) => {
      h.calls.events.push("humanDecision")
      h.calls.approvalRequest = { action, workflowID: binding.workflowID, planSha: binding.subject.sha256 }
      return withTerminalLine(`APPROVE ${binding.workflowID} ${binding.subject.sha256}`, () => humanDecision(action, binding))
    }

    const result = await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    const output = h.calls.output.join("")
    expect(result.code).toBe(0)
    expect(output).toContain("Discussion remains 日本語\tordinary text.")
    expect(output).toContain("Canonical plan remains")
    expect(output).toContain("Plan text remains 日本語.")
    expect(output).toContain("CSI-START\\u001b[2J")
    expect(output).toContain("OSC-START\\u001b]52;c;Y2xpcA==\\u0007")
    expect(output).toContain("C1-CSI\\u009b31m")
    expect(output).toContain("CR\\u000dBIDI\\u202eEND")
    expect(output).toContain(`Plan SHA: ${planSha}`)
    expect(output).not.toMatch(unsafeTerminalControls)
    expect(output).not.toContain(injection)
    expect(h.calls.imported).toEqual({ ...proposedPlan, revision: 1 })
    expect(h.calls.approvalRequest).toEqual({ action: "choose", workflowID: "wf_fixture", planSha })
    expect(h.calls.decision).toMatchObject({ action: "approve", workflowID: "wf_fixture", expectedRevision: 11, subject: { kind: "plan", id: "wf_fixture", sha256: planSha } })
    expect(h.calls.runCount).toBe(1)
  })

  test("buffers progress activity while the human approval reader owns input", async () => {
    let markDecisionStarted!: () => void
    const decisionStarted = new Promise<void>(resolve => { markDecisionStarted = resolve })
    let resolveDecision!: (decision: OperatorDecision) => void
    const decisionResult = new Promise<OperatorDecision>(resolve => { resolveDecision = resolve })
    const h = harness({
      lines: ["make the change"],
      turns: [{ text: "Plan draft.", plan: proposedPlan }],
      planSha: "canonical-sha-fixture",
    })
    h.deps.humanDecision = async (action, binding) => {
      h.calls.events.push("humanDecision")
      h.calls.approvalRequest = { action, workflowID: binding.workflowID, planSha: binding.subject.sha256 }
      markDecisionStarted()
      return decisionResult
    }

    const operation = launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    await decisionStarted
    const outputWhileWaiting = [...h.calls.output]
    h.calls.progressSinks[0]!.host({
      kind: "tool-started",
      role: "worker",
      execution: 1,
      executionID: "exec1", callID: "call1", taskID: "t1",
      tool: "read",
    })
    expect(h.calls.output).toEqual(outputWhileWaiting)
    expect(h.calls.output.join("")).toContain("Canonical plan")
    expect(h.calls.output.join("")).toContain("Plan SHA: canonical-sha-fixture")

    resolveDecision(await withTerminalLine("APPROVE wf_fixture canonical-sha-fixture",
      () => humanDecision("choose", planBinding(h.calls.sessionIDs[0]!, { id: "wf_fixture", lastSeq: 0 }, "canonical-sha-fixture"))))
    expect(await operation).toEqual({ code: 0 })
    expect(h.calls.output).toContain("[activity] Worker started read tool.\n")
    expect(h.calls.approvalRequest).toEqual({ action: "choose", workflowID: "wf_fixture", planSha: "canonical-sha-fixture" })
    expect(h.calls.decision).toMatchObject({ action: "approve", workflowID: "wf_fixture", subject: { kind: "plan", id: "wf_fixture", sha256: "canonical-sha-fixture" } })
    expect(h.calls.runCount).toBe(1)
  })

  test("sanitizes untrusted runtime refusal output without deciding or running", async () => {
    const injection = "CSI-START\u001b[2JOSC-START\u001b]52;c;Y2xpcA==\u0007C1-CSI\u009b31mCR\rBIDI\u202eEND"
    const h = harness({
      lines: ["make the change"],
      turns: [{ text: "Discussion remains.", plan: proposedPlan }],
      importResult: { ok: false, text: `Host refusal remains 日本語. ${injection}` },
    })

    expect((await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)).code).toBe(1)
    const output = h.calls.output.join("")
    const refusal = h.calls.output.find(line => line.startsWith("[error] Plan submission failed"))
    expect(refusal).toContain("Host refusal remains 日本語.")
    expect(refusal!.length).toBeLessThanOrEqual(320)
    expect(output).toContain("Host refusal remains 日本語.")
    expect(output).toContain("CSI-START\\u001b[2J")
    expect(output).toContain("OSC-START\\u001b]52;c;Y2xpcA==\\u0007")
    expect(output).toContain("C1-CSI\\u009b31m")
    expect(output).toContain("CR\\u000dBIDI\\u202eEND")
    expect(output).not.toMatch(unsafeTerminalControls)
    expect(output).not.toContain(injection)
    expect(h.calls.events).not.toContain("humanDecision")
    expect(h.calls.events).not.toContain("decide")
    expect(h.calls.events).not.toContain("run")
  })

  test("EOF after an invalid plan closes safely without import, approval, or execution", async () => {
    const invalidPlan = {
      ...proposedPlan,
      steps: proposedPlan.steps.map((step, index) => index === 0
        ? { ...step, detail: "Do not edit double.test.ts." }
        : step),
    }
    const h = harness({
      lines: ["make the requested change"],
      turns: [{ text: "Invalid plan draft.", plan: invalidPlan }],
      validatePlan() { throw new Error("invalid plan: step 1: do not edit double.test.ts") },
    })
    expect((await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)).code).toBe(0)
    expect(h.calls.turns).toEqual(["make the requested change"])
    expect(h.calls.events.filter(event => event === "validate")).toHaveLength(1)
    expect(h.calls.events).not.toContain("import")
    expect(h.calls.events).not.toContain("humanDecision")
    expect(h.calls.events).not.toContain("decide")
    expect(h.calls.events).not.toContain("run")
    expect(h.calls.output.join(" ")).toContain("Revise the plan or enter /quit")
    expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("non-validation validation-stage errors still propagate without importing or approving", async () => {
    const h = harness({
      lines: ["make the requested change"],
      turns: [{ text: "Plan draft.", plan: proposedPlan }],
      validatePlan() { throw new Error("another session owns the workflow") },
    })
    await expect(launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps))
      .rejects.toThrow("another session owns the workflow")
    expect(h.calls.events).not.toContain("import")
    expect(h.calls.events).not.toContain("humanDecision")
    expect(h.calls.events).not.toContain("run")
    expect(h.calls.output).toContain("[error] Operation failed; diagnostic details are not shown in progress output.\n")
    expect(h.calls.output.filter(line => line.startsWith("[error]")).join(" ")).not.toContain("another session owns the workflow")
  })

  test.each([
    { phase: "stuck", done: 0, failed: 1, cancelled: 0 },
    { phase: "stuck", done: 0, failed: 0, cancelled: 1 },
    { phase: "stuck", done: 0, failed: 0, cancelled: 0 },
  ])("unfinished execution returns failure rather than success: %j", async (runResult) => {
    const h = harness({ lines: ["make the change"], turns: [{ text: "", plan: proposedPlan }], runResult })
    const result = await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(result.code).toBe(1)
    expect(h.calls.runCount).toBe(1)
  })

  test("rejection never starts the queue", async () => {
    const h = harness({
      decision: "reject",
      lines: ["make the change"],
      turns: [{ text: "Proposed plan follows.", plan: proposedPlan }],
    })
    const result = await launchInteractive({ worktree: wt.worktree, engine: "local", model: "llama3.2" }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.decision?.action).toBe("reject")
    expect(h.calls.runCount).toBe(0)
    expect(h.calls.events).not.toContain("run")
  })

  test("EOF or reader failure during approval never falls through to execution", async () => {
    const h = harness({
      lines: ["make the change"],
      turns: [{ text: "Proposed plan follows.", plan: proposedPlan }],
    })
    h.deps.humanDecision = async () => {
      h.calls.events.push("humanDecision")
      throw new Error("operator input ended")
    }
    await expect(launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps))
      .rejects.toThrow("operator input ended")
    expect(h.calls.events).not.toContain("decide")
    expect(h.calls.runCount).toBe(0)
    expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("an interrupted operator prompt cannot decide or run and leaves no signal listeners", async () => {
    const h = harness({
      lines: ["make the change"],
      turns: [{ text: "Proposed plan follows.", plan: proposedPlan }],
    })
    h.deps.humanDecision = async () => {
      h.calls.events.push("humanDecision")
      expect(h.calls.signalListeners.get("SIGINT")?.size).toBe(0)
      h.emitSignal("SIGINT")
      throw new Error("operator prompt interrupted")
    }
    await expect(launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps))
      .rejects.toThrow("operator prompt interrupted")
    expect(h.calls.events).not.toContain("decide")
    expect(h.calls.runCount).toBe(0)
    expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("SIGINT at the approval prompt boundary prevents operator decision and queue dispatch", async () => {
    let h: ReturnType<typeof harness>
    h = harness({
      lines: ["make the change"],
      turns: [{ text: "Proposed plan follows.", plan: proposedPlan }],
      beforeWrite: (text) => { if (text.includes("Canonical plan")) h.emitSignal("SIGINT") },
    })
    expect((await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)).code).toBe(130)
    expect(h.calls.events).not.toContain("humanDecision")
    expect(h.calls.events).not.toContain("decide")
    expect(h.calls.runCount).toBe(0)
    expect(h.calls.output).toContain("[progress] Cancellation requested; outcome is not yet settled.\n")
    expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("restores signal cancellation around execution and removes listeners on completion", async () => {
    let h: ReturnType<typeof harness>
    h = harness({
      lines: ["make the change"],
      turns: [{ text: "Proposed plan follows.", plan: proposedPlan }],
      beforeRun: (signal) => {
        h.emitSignal("SIGTERM")
        expect(signal?.aborted).toBe(true)
      },
    })
    expect((await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)).code).toBe(143)
    expect(h.calls.runCount).toBe(1)
    expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("uses the existing real operator reader for the local decision", async () => {
    const h = harness({
      lines: ["make the change"],
      turns: [{ text: "Proposed plan follows.", plan: proposedPlan }],
    })
    await launchInteractive(
      { worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" },
      { ...h.deps, humanDecision: (...args) => withTerminalLine(
        "REJECT wf_fixture sha-fixture declined", () => humanDecision(...args),
      ) },
    )
    expect(h.calls.decision?.action).toBe("reject")
    expect(h.calls.runCount).toBe(0)
  })

  test("model IDs are native strings rather than provider/model selectors", () => {
    expect(validModelID("gpt-5-codex")).toBe(true)
    expect(validModelID("gpt-oss:20b")).toBe(true)
    expect(validModelID("provider/namespace:model")).toBe(true)
    expect(validModelID("")).toBe(false)
    expect(validModelID("-option")).toBe(false)
    expect(validModelID("bad\\name")).toBe(false)
    expect(validModelID("bad model")).toBe(false)
    expect(validModelID(" model")).toBe(false)
    expect(validModelID("x".repeat(257))).toBe(false)
  })
})

describe("intent routing", () => {
  const intentRoutes = (h: ReturnType<typeof harness>) => replaySession(wt.worktree, h.calls.sessionID!, { order: "asc" }).records
    .filter(record => record.kind === "notice" && String(record.data.text).startsWith("Intent route "))
    .map(record => JSON.parse(String(record.data.text).slice("Intent route ".length)))

  test("a question whose reply carries plan JSON is answered but never imported; the hint names /plan", async () => {
    const h = harness({ intent: "offer", lines: ["How does the planner work?", "/quit"], turns: [{ text: "It works like this.", plan: proposedPlan }] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.turns).toEqual(["How does the planner work?"])
    expect(h.calls.output.join("")).toContain("The reply contains a plan proposal; send /plan to submit it.")
    expect(h.calls.events).not.toContain("import")
    expect(h.calls.events).not.toContain("validate")
    expect(h.calls.runCount).toBe(0)
    expect(h.calls.choices).toEqual([])
    expect(intentRoutes(h)).toEqual([{ classifier: "otter-intent-v1", class: "question", signals: ["question-head"], offered: [], choice: null, route: "chat" }])
  })

  test("an anchored implement request still imports the plan and reaches approval, with no offer", async () => {
    const h = harness({ intent: "offer", lines: ["Fix the failing test in src/app.ts", "/quit"], turns: [{ text: "Plan.", plan: proposedPlan }], choose: async () => 2 })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.events).toContain("import")
    expect(h.calls.choices.map(choice => choice.title)).toEqual(["Execution decision"])
    expect(intentRoutes(h)[0]).toMatchObject({ class: "implement", offered: [], route: "chat" })
  })

  test("an ambiguous line offers Continue in chat first; choosing it sends the line unchanged and records the choice", async () => {
    const h = harness({ intent: "offer", lines: ["make it better", "/quit"], choose: async () => 0 })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.choices).toHaveLength(1)
    expect(h.calls.choices[0]!.values).toEqual(["Continue in chat", "Start deep-interview", "Cancel"])
    expect(h.calls.turns).toEqual(["make it better"])
    expect(intentRoutes(h)).toEqual([{ classifier: "otter-intent-v1", class: "ambiguous", signals: ["imperative", "uncertain", "no-anchor"],
      offered: ["Continue in chat", "Start deep-interview", "Cancel"], choice: "Continue in chat", route: "chat" }])
  })

  test("an architecture line offers ralplan and deep-interview, both after Continue in chat", async () => {
    const h = harness({ intent: "offer", lines: ["Refactor the auth module", "/quit"], choose: async () => 0 })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.choices[0]!.values).toEqual(["Continue in chat", "Start ralplan", "Start deep-interview first", "Cancel"])
  })

  test("dismissing the offer (Cancel or Escape) sends nothing and restores the draft", async () => {
    for (const pick of [2, undefined]) {
      const h = harness({ intent: "offer", lines: ["make it better", "/quit"], choose: async () => pick })
      await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
      expect(h.calls.turns).toEqual([])
      expect(h.calls.drafts).toEqual(["make it better"])
      expect(h.calls.output.join("")).toContain("nothing was sent")
      expect(intentRoutes(h)[0]).toMatchObject({ class: "ambiguous", route: "none" })
      expect(replaySession(wt.worktree, h.calls.sessionID!, { order: "asc" }).records.some(record => record.kind === "user")).toBe(false)
    }
  })

  test("force: skips the offer and sends the text without the prefix", async () => {
    const h = harness({ intent: "offer", lines: ["force: make it better", "/quit"], choose: async () => 2 })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.choices).toEqual([])
    expect(h.calls.turns).toEqual(["make it better"])
    expect(intentRoutes(h)[0]).toMatchObject({ class: "ambiguous", signals: expect.arrayContaining(["force"]), offered: [], route: "chat" })
  })

  test("without a chooser the offer is a numbered readline menu; empty input dismisses", async () => {
    const h = harness({ intent: "offer", lines: ["make it better", "", "make it better", "1", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    const output = h.calls.output.join("")
    expect(output).toContain("  1) Continue in chat")
    expect(output).toContain("  2) Start deep-interview")
    expect(h.calls.turns).toEqual(["make it better"])
    expect(h.calls.drafts).toEqual(["make it better"])
  })

  test("chat.intent off keeps the old behavior: no classifier, no offer, no notice", async () => {
    const h = harness({ intent: "off", lines: ["make it better", "How does it work?", "/quit"], turns: [{ text: "a" }, { text: "b", plan: proposedPlan }], choose: async () => 2 })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.choices.map(choice => choice.title)).toEqual(["Execution decision"])
    expect(h.calls.turns).toEqual(["make it better", "How does it work?"])
    expect(h.calls.events).toContain("import")
    expect(intentRoutes(h)).toEqual([])
  })

  test("a held session shows no offer and sends nothing", async () => {
    const h = harness({ intent: "offer", lines: ["make it better", "/quit"], choose: async () => 0,
      executionStatus: { generation: 1, claim: { id: "claim" }, executions: [] } as never })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.choices).toEqual([])
    expect(h.calls.turns).toEqual([])
    expect(h.calls.output.join("")).toContain("Conversation held")
  })

  test("!cmd still runs the shell and slash commands are never classified", async () => {
    const h = harness({ intent: "offer", lines: ["!echo intent-shell-ok", "/plan make it better", "/quit"], choose: async () => 2 })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.output.join("")).toContain("intent-shell-ok")
    expect(h.calls.choices).toEqual([])
    expect(h.calls.turns).toEqual(["/plan make it better"])
  })
})

describe("plan worktree chooser (interactive)", () => {
  const review = (workflowID: string) => ({ ok: true as const, workflowID, path: "/state/worktrees/s/wf-x", files: ["a.txt", "b.txt"], stat: " 2 files changed, 2 insertions(+)", patch: "/state/worktrees/s/wf-x.patch" })
  const launch = (h: ReturnType<typeof harness>) => launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
  const choices = (h: ReturnType<typeof harness>) => h.calls.choices.map(choice => choice.title)
  const approveThenPick = (pick: number) => async (title: string) => title === "Execution decision" ? 0 : title === "Apply the plan worktree?" ? pick : undefined

  test("after an isolated run it shows files, stat and patch path, then Apply applies and records the choice", async () => {
    const h = harness({ lines: ["make the change", "/quit"], turns: [{ text: "plan", plan: proposedPlan }], choose: approveThenPick(0),
      isolated: { review: review("wf_fixture"), apply: { ok: true, workflowID: "wf_fixture", files: ["a.txt", "b.txt"] } } })
    await launch(h)
    const out = h.calls.output.join("")
    expect(out).toContain("a.txt")
    expect(out).toContain("2 files changed")
    expect(out).toContain("/state/worktrees/s/wf-x.patch")
    expect(out).toContain("Your checkout is unchanged until you apply")
    expect(h.calls.choices.find(choice => choice.title === "Apply the plan worktree?")!.values).toEqual(["Apply to my checkout", "Keep worktree", "Discard"])
    expect(h.calls.events).toEqual(expect.arrayContaining(["review", "apply"]))
    expect(h.calls.events).not.toContain("discard")
    expect(out).toContain("Applied 2 file(s) to your checkout")
    const records = replaySession(wt.worktree, "otter-fixture-session", { order: "asc" }).records
    expect(records.some(record => record.kind === "workflow-choice" && record.data.planWorktree === "apply")).toBe(true)
  })

  test("Discard removes the worktree without applying; Keep and dismissal do neither and say /continue re-offers", async () => {
    const discard = harness({ lines: ["make the change", "/quit"], turns: [{ text: "plan", plan: proposedPlan }], choose: approveThenPick(2), isolated: { review: review("wf_fixture") } })
    await launch(discard)
    expect(discard.calls.events).toContain("discard")
    expect(discard.calls.events).not.toContain("apply")
    for (const pick of [1, undefined]) {
      const kept = harness({ lines: ["make the change", "/quit"], turns: [{ text: "plan", plan: proposedPlan }], choose: async (title) => title === "Execution decision" ? 0 : (pick as number | undefined), isolated: { review: review("wf_fixture") } })
      await launch(kept)
      expect(kept.calls.events).not.toContain("apply")
      expect(kept.calls.events).not.toContain("discard")
      expect(kept.calls.output.join("")).toContain("/continue offers Apply, Keep or Discard again")
    }
  })

  test("an Apply conflict keeps the worktree, copies the patch to .otter/handoffs/<sid>/ and leaves the checkout untouched", async () => {
    const source = join(wt.worktree, "source.patch")
    writeFileSync(source, "conflicting patch bytes\n")
    const h = harness({ lines: ["make the change", "/quit"], turns: [{ text: "plan", plan: proposedPlan }], choose: approveThenPick(0),
      isolated: { review: review("wf_fixture"), apply: { ok: false, workflowID: "wf_fixture", reason: "the task's patch does not apply to the current working tree", patch: source } } })
    await launch(h)
    const kept = join(wt.worktree, ".otter", "handoffs", "otter-fixture-session", "plan-wf_fixture.patch")
    expect(readFileSync(kept, "utf8")).toBe("conflicting patch bytes\n")
    const out = h.calls.output.join("")
    expect(out).toContain("Apply refused")
    expect(out).toContain("checkout is untouched")
    expect(out).toContain("/continue offers the choice again")
    expect(h.calls.events).not.toContain("discard")
  })

  test("/continue with a kept worktree re-offers Apply/Keep/Discard", async () => {
    const h = harness({ lines: ["/continue", "/quit"], choose: approveThenPick(0),
      isolated: { review: review("wf_fixture"), apply: { ok: true, workflowID: "wf_fixture", files: ["a.txt"] } } })
    await launch(h)
    expect(choices(h)).toEqual(["Apply the plan worktree?"])
    expect(h.calls.events).toContain("apply")
  })

  test("no commit: the run does not start silently; the explicit in-place prompt runs in place only on choice, and records it", async () => {
    const inPlace = harness({ lines: ["make the change", "/quit"], turns: [{ text: "plan", plan: proposedPlan }],
      choose: async (title) => title === "Execution decision" ? 0 : 0, isolated: { unavailable: "no-commit" } })
    await launch(inPlace)
    const prompt = inPlace.calls.choices.find(choice => choice.title.includes("Plan worktree unavailable"))!
    expect(prompt.values).toEqual(["Run in place in my checkout", "Cancel"])
    expect(inPlace.calls.events.filter(event => event === "run")).toHaveLength(1)
    expect(inPlace.calls.events).toContain("run-in-place")
    expect(replaySession(wt.worktree, "otter-fixture-session", { order: "asc" }).records.some(record => record.kind === "workflow-choice" && record.data.planIsolation === "in-place")).toBe(true)

    const cancelled = harness({ lines: ["make the change", "/quit"], turns: [{ text: "plan", plan: proposedPlan }],
      choose: async (title) => title === "Execution decision" ? 0 : 1, isolated: { unavailable: "no-commit" } })
    await launch(cancelled)
    expect(cancelled.calls.events).not.toContain("run-in-place")
    expect(replaySession(wt.worktree, cancelled.calls.sessionIDs[0]!, { order: "asc" }).records.some(record => record.kind === "workflow-choice" && record.data.planIsolation === "cancelled")).toBe(true)
  })
})

describe("model-loaded skills in otter chat", () => {
  function projectSkill(base: string, name: string, body = "AUTO_SKILL_BYTES\n") {
    const directory = join(wt.worktree, base, "skills", name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} helper for wiki pages\n---\n${body}`)
  }
  function commitAll() {
    Bun.spawnSync(["git", "-C", wt.worktree, "add", "-A"])
    Bun.spawnSync(["git", "-C", wt.worktree, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "skills"])
  }
  const policy = (mode: "off" | "auto", trust: string[] = [], include: string[] = []): SkillTrustLookup => ({
    trust: parseSkillTrust(trust) as SkillTrust,
    auto: { mode, include: new Set(include), exclude: new Set() },
    source: "/fixture/otter.jsonc",
  })

  test("the main model gets the consent-free catalog and loads a skill mid-turn without a prompt", async () => {
    projectSkill(".agents", "wiki-helper")
    commitAll()
    const h = harness({ lines: ["compile the wiki", "/quit"], choose: async () => 0, skillPolicy: policy("auto") })
    const handoffs = useRealSkillCoordinator(h, ["wiki-helper"])
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]?.invocation).toBeUndefined()
    expect(handoffs[0]?.skillTool?.catalog).toEqual([{ name: "wiki-helper", description: "wiki-helper helper for wiki pages" }])
    expect(handoffs[0]?.loads?.[0]).toMatchObject({ name: "wiki-helper", ok: true })
    expect(handoffs[0]?.loads?.[0]?.text).toContain("AUTO_SKILL_BYTES")
    // No router call decides for the model, and nothing prompted.
    expect(h.calls.autoSelections).toEqual([])
    expect(h.calls.choices).toEqual([])
    expect(h.calls.output.join("")).toContain("Skills used: wiki-helper")
    const replay = replaySession(wt.worktree, "otter-fixture-session", { order: "asc" })
    expect(replay.records.some(record => record.kind === "notice" && String(record.data.text).startsWith("Skill tool load "))).toBe(true)
    expect(JSON.stringify(replay.records)).not.toContain("AUTO_SKILL_BYTES")
  })

  test("a load the model attempts outside the consent-free set is refused as a tool error, never a prompt", async () => {
    projectSkill(".agents", "wiki-helper")
    commitAll()
    // Changed after the catalog was built: the content is no longer the committed baseline.
    const h = harness({ lines: ["compile the wiki", "/quit"], choose: async () => 0, skillPolicy: policy("auto") })
    const handoffs = useRealSkillCoordinator(h, ["wiki-helper"])
    h.deps.createConversation = ((original) => (runtime, sessionID, prior) => {
      const conversation = original!(runtime, sessionID, prior)
      return { turn: async (text, signal, invocation, skillTool) => {
        writeFileSync(join(wt.worktree, ".agents", "skills", "wiki-helper", "SKILL.md"), "---\nname: wiki-helper\ndescription: changed\n---\nTAMPERED\n")
        return conversation.turn(text, signal, invocation, skillTool)
      } }
    })(h.deps.createConversation)
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)
    expect(handoffs[0]?.loads?.[0]).toMatchObject({ name: "wiki-helper", ok: false })
    expect(h.calls.choices).toEqual([])
    expect(h.calls.output.join("")).not.toContain("Skills used:")
  })

  test("off, force:, /skills auto off, slash lines and explicit /skill: offer no skill tool", async () => {
    projectSkill(".agents", "wiki-helper")
    commitAll()
    const off = harness({ lines: ["compile the wiki", "/quit"], skillPolicy: policy("off") })
    const offHandoffs = useRealSkillCoordinator(off)
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, off.deps)
    expect(offHandoffs[0]?.skillTool).toBeUndefined()

    const h = harness({
      lines: ["force: compile the wiki", "/skills auto off", "compile the wiki", "/skills auto on", "/skills auto", "/plan compile again", "/skill:wiki-helper explicit", "compile again", "/quit"],
      choose: async () => 0, skillPolicy: policy("auto"),
    })
    const handoffs = useRealSkillCoordinator(h)
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)
    expect(handoffs.map(handoff => [handoff.text, handoff.skillTool !== undefined, handoff.invocation !== undefined])).toEqual([
      ["compile the wiki", false, false],
      ["compile the wiki", false, false],
      ["/plan compile again", false, false],
      ["/skill:wiki-helper explicit", false, true],
      ["compile again", true, false],
    ])
    expect(h.calls.output.join("")).toContain("Automatic skills: off for this session")
    expect(h.calls.output.join("")).toContain("Automatic skills: on for this session · skill_auto.mode auto · candidates: wiki-helper")
  })

  test("only consent-free, policy-eligible skills within the budget and role tools are listed", async () => {
    projectSkill(".agents", "committed")
    projectSkill(".agents", "huge", "x".repeat(20_000) + "\n")
    projectSkill(".codex", "imported")
    projectSkill(".agents", "read-only")
    writeFileSync(join(wt.worktree, ".agents", "skills", "read-only", "SKILL.md"), "---\nname: read-only\ndescription: narrow\nallowed-tools: [read]\n---\nBody\n")
    commitAll()
    projectSkill(".agents", "uncommitted")
    const h = harness({ lines: ["do work", "/quit"], choose: async () => 0, skillPolicy: policy("auto") })
    const handoffs = useRealSkillCoordinator(h, ["uncommitted"])
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)
    const names = handoffs[0]?.skillTool?.catalog.map(skill => skill.name) ?? []
    expect(names).toContain("committed")
    for (const excluded of ["huge", "imported", "read-only", "uncommitted"]) expect(names).not.toContain(excluded)
    expect(handoffs[0]?.loads?.[0]).toMatchObject({ name: "uncommitted", ok: false })
    expect(h.calls.choices).toEqual([])

    const included = harness({ lines: ["do work", "/quit"], skillPolicy: policy("auto", ["imported"], ["imported"]) })
    const includedHandoffs = useRealSkillCoordinator(included)
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, included.deps)
    expect(includedHandoffs[0]?.skillTool?.catalog.map(skill => skill.name)).toContain("imported")
  })
})

describe("intent offer ranking by the automatic selector", () => {
  test("in auto mode the predicted workflow is listed first and marked, but nothing starts without a choice", async () => {
    const h = harness({
      lines: ["refactor the whole session store architecture", "/quit"], intent: "offer", choose: async () => undefined,
      skillPolicy: { trust: NO_SKILL_TRUST, auto: { ...DEFAULT_SKILL_AUTO, mode: "auto" }, source: "/fixture/otter.jsonc" },
      selectSkill: async () => ({ skill: "deep-interview", reason: "recommended", decisionID: "d-offer", candidates: [] }),
    })
    await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)
    const offer = h.calls.choices.find(choice => choice.title.includes("design-level"))
    expect(offer?.values).toEqual(["Continue in chat", "Start deep-interview first (suggested)", "Start ralplan", "Cancel"])
    expect(h.calls.autoSelections[0]?.candidates).toEqual(["ralplan", "deep-interview"])
    expect(h.calls.turns).toEqual([])
  })

  test("off mode and selector failure keep the fixed offer order", async () => {
    for (const setup of [
      { mode: "off" as const, select: async () => ({ skill: "deep-interview", reason: "recommended", decisionID: "d", candidates: [] }) },
      { mode: "auto" as const, select: async (): Promise<AutoSkillSelection> => { throw new Error("down") } },
    ]) {
      const h = harness({
        lines: ["refactor the whole session store architecture", "/quit"], intent: "offer", choose: async () => undefined,
        skillPolicy: { trust: NO_SKILL_TRUST, auto: { ...DEFAULT_SKILL_AUTO, mode: setup.mode }, source: "/fixture/otter.jsonc" },
        selectSkill: setup.select,
      })
      await launchInteractive({ worktree: wt.worktree, engine: "local", model: "fixture" }, h.deps)
      expect(h.calls.choices.find(choice => choice.title.includes("design-level"))?.values)
        .toEqual(["Continue in chat", "Start ralplan", "Start deep-interview first", "Cancel"])
    }
  })
})
