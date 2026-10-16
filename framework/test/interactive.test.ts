import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { launchInteractive, parseInteractiveArgs, validModelID, type InteractiveDependencies, type Terminal } from "../src/hosts/interactive.ts"
import type { TerminalControl } from "../src/hosts/interactive-session.ts"
import type { ModelCatalog } from "../src/hosts/model-catalog.ts"
import type { ChoicePresentation, InteractiveViewFacts, TranscriptText } from "../src/hosts/interactive-view.ts"
import { newWorkflow, withFlowTransaction, workflowPath } from "../src/flow/state.ts"
import { publishWorkflow, writeWorkflow } from "./commit-fixture.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { readSessionCommitted } from "../src/workflows/commit.ts"
import { AdmissionRefusal } from "../src/hosts/required-controls.ts"
import { ModelRequestError } from "../src/workflows/turn.ts"
import { holdAdmission } from "../src/sessions/admission.ts"
import type { ForegroundController } from "../src/hosts/controller.ts"
import type { ExecutionRuntime } from "../src/hosts/types.ts"
import type { CliProgressSink } from "../src/hosts/cli-progress.ts"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { bindSkillInvocation, finishSkillInvocation, skillInvocationAudit } from "../src/skills/context.ts"
import { SkillSession, type SkillCatalog } from "../src/skills/session.ts"
import { humanDecision, type OperatorDecision } from "../src/hosts/operator.ts"
import { planBinding, withTerminalLine } from "./operator-helpers.ts"
import { tempGitWorktree } from "./guards-helpers.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { interactiveActions } from "../src/hosts/interactive-actions.ts"
import { getOwnedSession, inspectSessionAttachment, openSession, replaySession, readSessionMetadata, type ReplayOptions, type ReplayResult } from "../src/sessions/store.ts"
import { sessionDir } from "../src/state/store.ts"
import type { ConversationMessage, SkillConversationInvocation } from "../src/hosts/plan-conversation.ts"

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
    runtimes: Array<{ worktree: string; engine: string; model: string }>
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
  } = { prompts: [], output: [], events: [], turns: [], runtimes: [], sessionIDs: [], turnBindings: [], discoveries: [], validationAttempts: [], runCount: 0, controllerStatusCalls: 0, controllerCancelCalls: 0, signalListeners: new Map(), choices: [], actionContexts: [], drafts: [], viewFacts: [], skillCatalogs: [], catalogSessions: [], progressSinks: [], boundSessions: [], transcriptSources: [], queueAdmissions: [], controllerCreations: 0, conversationRestores: [] }
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
            planRef: { mdPath: `.lca/plans/${workflowID}.md` },
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
    async run(_sessionID: string, signal?: AbortSignal) {
      calls.events.push("run")
      calls.runCount++
      options.beforeRun?.(signal)
      await runGate
      return {
        workflow: { id: workflowID, phase: options.runResult?.phase ?? "done", artifacts: [] },
        run: { done: options.runResult?.done ?? 1, failed: options.runResult?.failed ?? 0, cancelled: options.runResult?.cancelled ?? 0, skipped: 0 },
      } as unknown as Awaited<ReturnType<ForegroundController["run"]>>
    },
  } as unknown as ForegroundController

  const deps: Partial<InteractiveDependencies> = {
    cwd: wt.worktree,
    terminal,
    gitTopLevel: () => Object.hasOwn(options, "gitTopLevel") ? options.gitTopLevel : wt.worktree,
    createRuntime: ({ worktree, engine, model, progress }) => {
      calls.events.push("runtime")
      if (options.failRuntimeFor?.(engine, model)) throw new TypeError("fixture runtime setup failed")
      const selected = { worktree, engine, model }
      calls.runtime = selected
      calls.runtimes.push(selected)
      if (progress) calls.progressSinks.push(progress)
      return {
        worktree,
        directory: worktree,
        instance: "interactive-test-runtime",
        host: { identity: { engine, profile: "interactive-fixture" } },
        config: structuredClone(DEFAULT_CONFIG),
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
    humanDecision: async (action, binding) => {
      calls.events.push("humanDecision")
      calls.approvalRequest = { action, workflowID: binding.workflowID, planSha: binding.subject.sha256 }
      return { action: options.decision ?? "approve", ...binding } as unknown as OperatorDecision
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

function useRealSkillCoordinator(h: ReturnType<typeof harness>) {
  const handoffs: Array<{ text: string; sessionID: string; invocation?: SkillConversationInvocation }> = []
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
    turn: async (text, signal, invocation) => {
      if (signal?.aborted) throw new Error("test turn cancelled")
      h.calls.events.push("turn")
      h.calls.turns.push(text)
      handoffs.push({ text, sessionID, ...(invocation ? { invocation } : {}) })
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
  owner.append("assistant", { text: "retained LCA reply" })
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

    expect(h.calls.catalogSessions[0]).toBe("lca-fixture-session")
    expect(h.calls.skillCatalogs.length).toBeGreaterThanOrEqual(2)
    expect(h.calls.skillCatalogs[0]?.entries.some(entry => entry.descriptor.name === "inspect" && entry.classification === "custom")).toBe(true)
    expect(h.calls.output.join("")).toContain("/skill:inspect · project · custom · Inspect this project")
    expect(h.calls.output.join("")).toContain("Refused project broken · invalid-metadata")

    expect(h.calls.turns).toEqual(["/skill:inspect inspect data.txt"])
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]?.invocation?.prepared.name).toBe("inspect")
    expect(handoffs[0]?.invocation?.terminal?.stdinIsTTY).toBe(true)
    const replay = replaySession(wt.worktree, "lca-fixture-session", { order: "asc" })
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
    const replay = replaySession(wt.worktree, "lca-fixture-session", { order: "asc" })
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
    expect(handoffs.map(handoff => handoff.sessionID)).toEqual(["lca-fixture-session-2"])
    expect(replaySession(wt.worktree, "lca-fixture-session", { order: "asc" }).records.some(record => record.kind === "assistant")).toBe(false)
    expect(replaySession(wt.worktree, "lca-fixture-session-2", { order: "asc" }).records.some(record => record.kind === "assistant")).toBe(true)
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
    const rows = h.calls.output.join("").split("\n").filter(line => line.startsWith("lca-fixture-session · inspect · "))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(/^lca-fixture-session · inspect · project · custom · [0-9a-f]{64} · read$/u)
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
    const replay = replaySession(wt.worktree, "lca-fixture-session", { order: "asc" })
    expect(replay.records.some(record => record.kind === "assistant")).toBe(false)
    expect(replay.records.some(record => record.kind === "notice" && String(record.data.text).startsWith("Skill invocation audit "))).toBe(false)
  })

  test("deleted upstream SDK session restores only retained LCA history without creating an SDK runtime", async () => {
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
    expect(restored?.records.map(record => record.data.text)).toEqual(["history from a deleted SDK session", "retained LCA reply"])
    expect(readFileSync(metadataPath)).toEqual(metadataBefore)
    expect(readSessionMetadata(wt.worktree, "lca-fixture-session")?.held).toBe(true)
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
    expect(h.calls.turnBindings).toMatchObject([{ sessionID: "lca-fixture-session-2", text: "fresh CLI message" }])
    expect(h.calls.runtimes).toHaveLength(2)
    expect(h.calls.runtimes.every(runtime => runtime.engine === "codex")).toBe(true)
    expect(h.calls.controllerCreations).toBe(2)
    expect(h.calls.controllerStatusCalls).toBe(0)
    expect(h.calls.controllerCancelCalls).toBe(0)
    expect(h.calls.discoveries).toHaveLength(0)
    expect(h.calls.runCount).toBe(0)
    expect(h.calls.conversationRestores).toHaveLength(2)
    expect(h.calls.conversationRestores[1]).toEqual({ sessionID: "lca-fixture-session-2" })
    expect(readSessionMetadata(wt.worktree, "lca-fixture-session-2")).toMatchObject({ engine: "codex", model: "fixture" })
    expect(readFileSync(metadataPath)).toEqual(metadataBefore)
    expect(h.calls.output.join("")).toContain(`Retained SDK session ${writer.sessionID} · read-only history`)
    expect(h.calls.output.join("")).toContain("command or message was not applied")
    expect(h.calls.output.join("")).toContain("Skill catalog is unavailable in retained read-only SDK history")
    expect(h.calls.output.join("")).toContain("tool-start ·")
    expect(h.calls.queueAdmissions).toContain(false)
    expect(h.calls.events.filter(event => event === "sessionChanged").length).toBeGreaterThanOrEqual(2)
    expect(readSessionMetadata(wt.worktree, "lca-fixture-session")?.held).toBe(true)
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
        claim: { ownerSession: "lca-fixture-session", instance: "unsettled-owner", pid: process.pid, generation: 1 },
        executions: [],
      },
    })

    await launchInteractive({ worktree: wt.worktree, engine: "claude", model: "fixture" }, h.deps)

    expect(h.calls.output.join("")).toContain("execution ownership is unresolved")
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.boundSessions.at(-1)).toBe("lca-fixture-session")
    expect(readFileSync(metadataPath)).toEqual(metadataBefore)
    expect(inspectSessionAttachment(wt.worktree, writer.sessionID, writer.epoch)?.state).toBe("attached")
    writer.assertOwner()
    releaseTestSession(writer)
  })

  test("switching sessions retains transcript and restored drafts never dispatch without Resume", async () => {
    const h = harness({ lines: ["first retained message", "/new", "second retained message", "/resume lca-fixture-session", "held message", "/quit"] })
    let admissions = 0
    h.deps.admitRuntime = async () => {
      if (++admissions > 2) throw AdmissionRefusal.hostIncompatible()
    }
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "fixture" }, h.deps)
    expect(h.calls.turns).toEqual(["first retained message", "second retained message"])
    const first = replaySession(wt.worktree, "lca-fixture-session")
    const second = replaySession(wt.worktree, "lca-fixture-session-2")
    expect(first.complete).toBe(true)
    expect(second.complete).toBe(true)
    expect(first.records.filter(record => record.kind === "user").map(record => record.data.text)).toEqual(["first retained message"])
    expect(second.records.filter(record => record.kind === "user").map(record => record.data.text)).toEqual(["second retained message"])
    expect(readSessionMetadata(wt.worktree, "lca-fixture-session")?.held).toBe(true)
    expect(h.calls.output.join("")).toContain("Restored session held")
    expect(admissions).toBe(2)
  })

  test("restore prints the retained workflow id, phase, path, sha256 and an [artifacts] line recomputed from disk", async () => {
    const mdPath = ".lca/plans/retained.md"
    mkdirSync(join(wt.worktree, ".lca/plans"), { recursive: true })
    writeFileSync(join(wt.worktree, mdPath), "original")
    const mdSha = createHash("sha256").update("original").digest("hex")
    const retained = publishWorkflow(wt.worktree, {
      ...newWorkflow("lca-fixture-session", currentOwner(), "command", "retained", "codex"),
      id: "wf_retained_restore", phase: "cancelled", stage: "terminal",
      planRef: { jsonSha: "a".repeat(64), mdPath, mdSha, revision: 1 },
    })
    writeFileSync(join(wt.worktree, mdPath), "tampered after the session ended")
    const h = harness({ lines: ["first retained message", "/new", "second retained message", "/resume lca-fixture-session", "/quit"] })
    let admissions = 0
    h.deps.admitRuntime = async () => { if (++admissions > 2) throw AdmissionRefusal.hostIncompatible() }
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "fixture" }, h.deps)
    const output = h.calls.output.join("")
    const committed = readSessionCommitted(wt.worktree, "lca-fixture-session")!
    expect(committed.wf.id).toBe(retained.id)
    expect(output).toContain(`[workflow] wf_retained_restore cancelled · ${committed.path} · sha256 ${committed.sha256}`)
    expect(output).toMatch(/\[artifacts\] artifacts incomplete: plan\.md \(\.lca\/plans\/retained\.md: hash mismatch\)/)
  })

  test("restored history remains readable when explicit Resume host preflight refuses", async () => {
    const h = harness({ lines: ["retained", "/new", "/resume lca-fixture-session", "/continue", "RESUME", "not dispatched", "/quit"] })
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
    expect(readSessionMetadata(wt.worktree, "lca-fixture-session")?.held).toBe(true)
    expect(replaySession(wt.worktree, "lca-fixture-session").records.some(record => record.kind === "user" && record.data.text === "retained")).toBe(true)
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
    expect(h.calls.prompts).toEqual(["You> ", "Engine [1-3]: ", "Model [1-2 or native ID]: ", "You> "])
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
    expect(output).toContain("/model [engine native-id]")
    expect(output).toContain("/theme <neutral|light|dark>")
    expect(output).toContain("/details")
  })

  test.each(["", "/cancel"])("cancelled startup model picker returns to the unselected composer (%j)", async (cancel) => {
    const h = harness({ lines: ["/model", "codex", cancel, "hello without selection", "/quit"] })
    expect(await launchInteractive({ worktree: wt.worktree }, h.deps)).toEqual({ code: 0 })

    expect(h.calls.prompts).toEqual(["You> ", "Engine [1-3]: ", "Model [1-2 or native ID]: ", "You> ", "You> "])
    expect(h.calls.discoveries).toEqual([{ engine: "codex", worktree: realpathSync(wt.worktree) }])
    expect(h.calls.runtimes).toHaveLength(0)
    expect(h.calls.controllerCreations).toBe(0)
    expect(h.calls.turns).toEqual([])
    expect(h.calls.output.join("")).toContain("No model selected; use /model to choose an engine and model. Nothing was sent.")
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
    expect(commands).toEqual(["/help", "/model", "/theme", "/ascii", "/quit"])
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
    expect(h.calls.output).toContain("New conversation: local / native-secondary.")
    expect(h.calls.viewFacts[0]?.selection).toEqual({ engine: "codex", model: "original" })
    expect(h.calls.viewFacts.at(-1)?.selection).toEqual({ engine: "local", model: "native-secondary" })
    expect(h.calls.turns).toEqual([])
    const records = replaySession(wt.worktree, h.calls.sessionIDs.at(-1)!, { order: "asc" }).records
    expect(records.some(record => record.kind === "notice" &&
      record.data.text === "New conversation: local / native-secondary.")).toBe(true)
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
      { engine: "local", model: "qwen3:8b", sessionID: "lca-fixture-session-2", text: "hello" },
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
        if (prompt === "Engine [1-3]: ") selectionStarted = true
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
    expect(h.calls.prompts[2]).toBe("Engine [1-3]: ")
    expect(h.calls.output.join("")).toContain("Choose an execution engine")
    expect(h.calls.prompts[3]).toBe("Model [1-2 or native ID]: ")
    expect(h.calls.runtime).toEqual({ worktree: realpathSync(wt.worktree), engine: "codex", model: "gpt-5-codex" })
    expect(h.calls.discoveries).toEqual([{ engine: "codex", worktree: realpathSync(wt.worktree) }])
    expect(h.calls.turnBindings).toEqual([{
      engine: "codex", model: "gpt-5-codex", sessionID: "lca-fixture-session", text: "hello after selection",
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
    expect(h.calls.choices[0]?.values).toEqual(["local — Ollama CLI", "codex — Codex CLI", "claude — Claude CLI"])
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
    expect(h.calls.sessionIDs).toEqual(["lca-fixture-session"])
    expect(h.calls.turnBindings).toEqual([{
      engine: "codex", model: "original", sessionID: "lca-fixture-session", text: "hello on original model",
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
    expect(modelOnly.calls.prompts).toEqual(["You> ", "You> ", "Engine [1-3]: ", "You> "])
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
    expect(h.calls.prompts[1]).toBe("Engine [1-3]: ")
    expect(h.calls.prompts[2]).toBe("Engine [1-3]: ")
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
    const SID = "lca-fixture-session"
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

  test("local help, picker and unknown slash commands never reach inference; /plan stays a prompt", async () => {
    const h = harness({ lines: ["/help", "/unknown", "/model", "2", "native-secondary", "hello", "/plan", "/quit"] })
    const result = await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.turns).toEqual(["hello", "/plan"])
    expect(h.calls.turnBindings).toEqual([
      { engine: "codex", model: "native-secondary", sessionID: "lca-fixture-session-2", text: "hello" },
      { engine: "codex", model: "native-secondary", sessionID: "lca-fixture-session-2", text: "/plan" },
    ])
    expect(h.calls.runtimes).toEqual([
      { worktree: realpathSync(wt.worktree), engine: "codex", model: "gpt-5-codex" },
      { worktree: realpathSync(wt.worktree), engine: "codex", model: "native-secondary" },
    ])
    expect(h.calls.sessionIDs).toEqual(["lca-fixture-session", "lca-fixture-session-2"])
    expect(h.calls.discoveries).toEqual([{ engine: "codex", worktree: realpathSync(wt.worktree) }])
    expect(h.calls.output.join("")).toContain("Commands (chat):\n/help — show contextual commands and keys")
    expect(h.calls.output.join("")).toContain("Conversation context reset after model switch.")
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

    const records = replaySession(wt.worktree, "lca-fixture-session", { order: "asc" }).records
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
        const store = getOwnedSession(wt.worktree, "lca-fixture-session")
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
            executionStatus.claim = { ownerSession: "lca-fixture-session", instance: "fixture", pid: process.pid, generation: 1 }
          } else if (scenario === "unsettled") {
            executionStatus.executions.push({ executionId: "unsettled", ownerSession: "lca-fixture-session", generation: 1,
              reconciliation: { outcome: "running", quiescent: false } })
          } else if (scenario === "fenced") {
            executionStatus.executions.push({ executionId: "fenced", ownerSession: "lca-fixture-session", generation: 1,
              kind: "host", terminal: { outcome: "failed", terminalAt: Date.now() },
              reconciliation: { outcome: "terminal", quiescent: true }, fence: { reason: "fixture fence", at: Date.now() } })
          } else if (scenario === "held") {
            holdAdmission(realpathSync(wt.worktree), "lca-fixture-session", "fixture_hold")
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
    expect(h.calls.sessionIDs).toEqual(["lca-fixture-session", "lca-fixture-session-2"])
    expect(h.calls.turnBindings).toEqual([
      { engine: "local", model: "qwen3:8b", sessionID: "lca-fixture-session-2", text: "hello" },
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
    expect(h.calls.sessionIDs).toEqual(["lca-fixture-session"])
    expect(h.calls.turnBindings[0]).toEqual({
      engine: "codex", model: "gpt-5-codex", sessionID: "lca-fixture-session", text: "hello",
    })
    expect(h.calls.output.join("")).toContain("conversation context is unchanged")
  })

  test("invalid picker entries preserve the old runtime and conversation", async () => {
    const h = harness({ lines: ["/model", "codex", "0", "bad model", "gpt-5-codex", "hello", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.sessionIDs).toEqual(["lca-fixture-session"])
    expect(h.calls.turnBindings[0]).toEqual({
      engine: "codex", model: "gpt-5-codex", sessionID: "lca-fixture-session", text: "hello",
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
    expect(h.calls.sessionIDs).toEqual(["lca-fixture-session"])
    expect(h.calls.turnBindings[0]).toEqual({
      engine: "codex", model: "gpt-5-codex", sessionID: "lca-fixture-session", text: "hello",
    })
    expect(h.calls.output.join("")).toContain("current selection and conversation are unchanged")
  })

  test.each(["", "/cancel"])("picker cancellation %j keeps the current conversation usable", async (cancel) => {
    const h = harness({ lines: ["/model", "local", cancel, "hello", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    expect(h.calls.runtimes).toHaveLength(1)
    expect(h.calls.turnBindings).toEqual([
      { engine: "codex", model: "gpt-5-codex", sessionID: "lca-fixture-session", text: "hello" },
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
    expect(h.calls.sessionIDs).toEqual(["lca-fixture-session"])
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

  test("active workflow and corrupt workflow state refuse model switching", async () => {
    const path = workflowPath(wt.worktree)
    withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, newWorkflow("another-session",
      { instance: "fixture", pid: process.pid }, "command", "active plan", "codex")))
    const active = harness({ lines: ["/model local qwen3:8b", "hello", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, active.deps)
    expect(active.calls.runtimes).toHaveLength(1)
    expect(active.calls.runtimes[0]?.engine).toBe("codex")
    expect(active.calls.turnBindings).toEqual([])
    expect(active.calls.imported).toBeUndefined()
    expect(active.calls.output.join("")).toContain("resolve the active workflow first")
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

    withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, newWorkflow("another-session",
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
    expect(workflow.calls.sessionIDs).toEqual(["lca-fixture-session"])
    expect(workflow.calls.turnBindings).toEqual([])
    expect(readSessionMetadata(wt.worktree, "lca-fixture-session")).toMatchObject({ engine: "codex", model: "gpt-5-codex" })

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
    const records = replaySession(wt.worktree, "lca-fixture-session", { order: "asc" }).records
    expect(result.code).toBe(0)
    expect(h.calls.sessionID).toBe("lca-fixture-session")
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

    expect(h.calls.sessionID).toBe("lca-fixture-session")
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
    expect(h.calls.output.join(" ")).toContain("Plan rejected by LCA validation")
    expect(h.calls.output.join(" ")).toContain("do not edit double.test.ts")
    expect(h.calls.output.join("")).toContain("step 1: do not edit double.test.ts. \\u001b[2J\\u202e")
    expect(h.calls.output.join("")).not.toMatch(unsafeTerminalControls)
    expect(h.calls.output.join("")).not.toContain("\u001b[2J\u202e")
    expect(h.calls.output.join(" ")).toContain("Revise the plan or enter /quit")
    const feedback = h.calls.output.find(output => output.startsWith("[error] Plan rejected by LCA validation"))
    expect(feedback).toContain("...")
    expect(feedback?.length).toBeLessThanOrEqual(360)
    expect(h.calls.output.filter(output => output.startsWith("[error] Plan rejected by LCA validation"))).toHaveLength(1)
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
