import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { launchInteractive, parseInteractiveArgs, validModelID, type InteractiveDependencies, type Terminal } from "../src/hosts/interactive.ts"
import type { ModelCatalog } from "../src/hosts/model-catalog.ts"
import { newWorkflow, workflowPath } from "../src/flow/state.ts"
import { AdmissionRefusal } from "../src/hosts/required-controls.ts"
import type { ForegroundController } from "../src/hosts/controller.ts"
import type { ExecutionRuntime } from "../src/hosts/types.ts"
import type { CliProgressSink } from "../src/hosts/cli-progress.ts"
import { humanDecision, type OperatorDecision } from "../src/hosts/operator.ts"
import { withTerminalLine } from "./operator-helpers.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree() })
afterEach(() => wt.cleanup())

type HarnessOptions = {
  lines?: Array<string | undefined>
  turns?: Array<{ text: string; plan?: unknown }>
  decision?: "approve" | "reject"
  tty?: { stdin: boolean; stderr: boolean }
  gitTopLevel?: string | undefined
  beforeRead?: (prompt: string, signal?: AbortSignal) => void
  beforeWrite?: (text: string) => void
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
    signalListeners: Map<string, Set<() => void>>
    progressSinks: CliProgressSink[]
  } = { prompts: [], output: [], events: [], turns: [], runtimes: [], sessionIDs: [], turnBindings: [], discoveries: [], validationAttempts: [], runCount: 0, signalListeners: new Map(), progressSinks: [] }

  let releaseRun: (() => void) | undefined
  const runGate = options.deferRun ? new Promise<void>(resolve => { releaseRun = resolve }) : undefined

  const terminal: Terminal = {
    stdinIsTTY: options.tty?.stdin ?? true,
    stderrIsTTY: options.tty?.stderr ?? true,
    readLine: async (prompt, signal) => {
      calls.prompts.push(prompt)
      options.beforeRead?.(prompt, signal)
      if (signal?.aborted) return undefined
      return lines.shift()
    },
    write: (text) => { calls.output.push(text); options.beforeWrite?.(text) },
    close: () => { calls.events.push("terminal.close") },
  }
  const controller = {
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
        workflow: { id: workflowID, phase: options.runResult?.phase ?? "done" },
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
    admitRuntime: async () => {},
    createConversation: (runtime, sessionID) => {
      calls.events.push("conversation")
      calls.sessionID = sessionID
      calls.sessionIDs.push(sessionID)
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
          return turns.shift() ?? { text: "Acknowledged." }
        },
      }
    },
    createController: () => controller,
    humanDecision: async (action, workflowID, planSha) => {
      calls.events.push("humanDecision")
      calls.approvalRequest = { action, workflowID, planSha }
      return { action: options.decision ?? "approve", workflowID, planSha } as unknown as OperatorDecision
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
      return () => sequence++ === 0 ? "fixture-session" : `fixture-session-${sequence}`
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

  test("bare chat offers engine selection first and asks for a native model ID", async () => {
    const h = harness({ lines: ["2", "gpt-5-codex", "/quit"] })
    const result = await launchInteractive({ worktree: wt.worktree }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.prompts[0]).toContain("Choose an execution engine")
    expect(h.calls.prompts[1]).toBe("Model [1-2 or native ID]: ")
    expect(h.calls.runtime).toEqual({ worktree: realpathSync(wt.worktree), engine: "codex", model: "gpt-5-codex" })
    expect(h.calls.discoveries).toEqual([{ engine: "codex", worktree: realpathSync(wt.worktree) }])
    expect(h.calls.output.join(" ")).toContain("estimated")
    expect(h.calls.output.join(" ")).toContain("reactive")
    expect(h.calls.output.join(" ")).toContain("No process or filesystem containment is claimed")
  })

  test("startup picker displays numbered native models and the selected execution banner", async () => {
    const h = harness({ lines: ["1", "2", "/quit"] })
    const result = await launchInteractive({ worktree: wt.worktree }, h.deps)
    const output = h.calls.output.join("")
    expect(result.code).toBe(0)
    expect(h.calls.runtime).toEqual({ worktree: realpathSync(wt.worktree), engine: "local", model: "native-secondary" })
    expect(output).toContain("1) Primary model — llama3.2")
    expect(output).toContain("2) Secondary model — native-secondary")
    expect(output).toContain("Fixture catalog notice")
    expect(output).toContain(`Engine: local\n  Model: native-secondary\n  Worktree: ${realpathSync(wt.worktree)}`)
    expect(h.calls.discoveries).toHaveLength(1)
  })

  test("engine and model flags skip only the corresponding prompt; local maps to Ollama runtime", async () => {
    const h = harness({ lines: ["gpt-oss:20b", "/quit"] })
    const result = await launchInteractive({ worktree: wt.worktree, engine: "local" }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.prompts).toEqual(["Model [1-2 or native ID]: ", "You> "])
    expect(h.calls.runtime?.engine).toBe("local")
    expect(h.calls.runtime?.model).toBe("gpt-oss:20b")

    const explicit = harness({ lines: ["/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "claude", model: "claude-sonnet-4-5" }, explicit.deps)
    expect(explicit.calls.prompts).toEqual(["You> "])
    expect(explicit.calls.runtime?.engine).toBe("claude")
    expect(explicit.calls.runtime?.model).toBe("claude-sonnet-4-5")
    expect(explicit.calls.discoveries).toEqual([])

    const modelOnly = harness({ lines: ["2", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, model: "manual-native-id" }, modelOnly.deps)
    expect(modelOnly.calls.prompts[0]).toContain("Choose an execution engine")
    expect(modelOnly.calls.prompts[1]).toBe("You> ")
    expect(modelOnly.calls.runtime?.engine).toBe("codex")
    expect(modelOnly.calls.runtime?.model).toBe("manual-native-id")
    expect(modelOnly.calls.discoveries).toEqual([])
  })

  test("invalid engine and model choices are retried without choosing an implicit default", async () => {
    const h = harness({ lines: ["0", "claude", "bad model", "claude-sonnet-4-5", "/quit"] })
    const result = await launchInteractive({ worktree: wt.worktree }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.prompts[0]).toContain("Choose an execution engine")
    expect(h.calls.prompts[1]).toContain("Choose an execution engine")
    expect(h.calls.prompts[2]).toBe("Model [1-2 or native ID]: ")
    expect(h.calls.prompts[3]).toBe("Model [1-2 or native ID]: ")
    expect(h.calls.runtime?.engine).toBe("claude")
    expect(h.calls.runtime?.model).toBe("claude-sonnet-4-5")
    expect(h.calls.output.join(" ")).toContain("Invalid model ID")
  })

  test("EOF during either selection exits safely without constructing a runtime", async () => {
    for (const lines of [[undefined], ["1", undefined]]) {
      const h = harness({ lines })
      expect((await launchInteractive({ worktree: wt.worktree }, h.deps)).code).toBe(0)
      expect(h.calls.runtime).toBeUndefined()
      expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
    }
  })

  test("/cancel in chat never executes a plan; signal listeners are removed", async () => {
    const h = harness({ lines: ["local", "llama3.2", "hello", "/cancel"], turns: [{ text: "Hello." }] })
    expect((await launchInteractive({ worktree: wt.worktree }, h.deps)).code).toBe(0)
    expect(h.calls.runCount).toBe(0)
    expect(h.calls.turns).toEqual(["hello"])
    expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("shows planning wait before a deferred model turn returns", async () => {
    let markTurnStarted!: () => void
    const turnStarted = new Promise<void>(resolve => { markTurnStarted = resolve })
    let resolveDelayedTurn!: (value: { text: string; plan?: unknown }) => void
    const delayedTurn = new Promise<{ text: string; plan?: unknown }>(resolve => { resolveDelayedTurn = resolve })
    const h = harness({ lines: ["hello", "/quit"] })
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
    expect(h.calls.output).toContain(waiting)
    expect(h.calls.output).not.toContain(response)

    resolveDelayedTurn({ text: "Delayed model response." })
    expect(await operation).toEqual({ code: 0 })
    expect(h.calls.output).toContain(response)
    expect(h.calls.output.join("")).toContain("Delayed model response.")
  })

  test("local help, picker and unknown slash commands never reach inference; /plan stays a prompt", async () => {
    const h = harness({ lines: ["/help", "/unknown", "/model", "2", "hello", "/plan", "/quit"] })
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
    expect(h.calls.output.join("")).toContain("Local commands: /help, /model")
    expect(h.calls.output.join("")).toContain("Conversation context reset after model switch.")
  })

  test("direct model switch uses the new runtime and session on the next turn without discovery", async () => {
    const h = harness({
      lines: ["/model local qwen3:8b", "hello", "/quit"],
      activityForTurn(selection, progress) {
        progress?.host({
          kind: "tool-started",
          role: "worker",
          execution: 1,
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
    expect(h.calls.progressSinks).toHaveLength(2)
    expect(h.calls.progressSinks[0]).toBe(h.calls.progressSinks[1])
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
    const h = harness({ lines: ["/model", "0", "bad model", "gpt-5-codex", "hello", "/quit"] })
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
    const h = harness({ lines: ["/model", cancel, "hello", "/quit"] })
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
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(newWorkflow("another-session",
      { instance: "fixture", pid: process.pid, heartbeatAt: Date.now() }, "command", "active plan", "codex")))
    const active = harness({ lines: ["/model local qwen3:8b", "hello", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, active.deps)
    expect(active.calls.runtimes).toHaveLength(1)
    expect(active.calls.turnBindings[0]?.engine).toBe("codex")
    expect(active.calls.output.join("")).toContain("resolve the active workflow first")

    writeFileSync(path, "{")
    const corrupt = harness({ lines: ["/model local qwen3:8b", "hello", "/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, corrupt.deps)
    expect(corrupt.calls.runtimes).toHaveLength(1)
    expect(corrupt.calls.turnBindings[0]?.engine).toBe("codex")
    expect(corrupt.calls.output.join("")).toContain("workflow state is corrupt")
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
      expect(h.calls.turnBindings[0]?.engine).toBe("codex")
      expect(h.calls.output.join("")).toContain("execution ownership is unresolved")
    }
  })

  test("EOF and signals in the model picker preserve the current runtime and clean listeners", async () => {
    const eof = harness({ lines: ["/model", undefined] })
    expect((await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, eof.deps)).code).toBe(0)
    expect(eof.calls.runtimes).toHaveLength(1)
    expect([...eof.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)

    let interrupted: ReturnType<typeof harness>
    interrupted = harness({
      lines: ["/model"],
      beforeRead: prompt => { if (prompt.startsWith("Model [")) interrupted.emitSignal("SIGTERM") },
    })
    expect((await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, interrupted.deps)).code).toBe(143)
    expect(interrupted.calls.runtimes).toHaveLength(1)
    expect([...interrupted.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("discovered labels and notices are terminal-safe", async () => {
    const h = harness({
      lines: ["1", "/quit"],
      catalog: { models: [{ id: "native-safe", label: "Label\u001b[2J" }], notice: "Notice\u202eunsafe" },
    })
    await launchInteractive({ worktree: wt.worktree, engine: "codex" }, h.deps)
    const output = h.calls.output.join("")
    expect(output).toContain("Label\\u001b[2J")
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
      lines: ["local", "llama3.2"],
      beforeRead: (prompt) => { if (prompt === "You> ") h.emitSignal("SIGINT") },
    })
    expect((await launchInteractive({ worktree: wt.worktree }, h.deps)).code).toBe(130)
    expect(h.calls.turns).toEqual([])
    expect(h.calls.runCount).toBe(0)
    expect([...h.calls.signalListeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test("displays the canonical plan and SHA, and runs only after an explicit approval receipt", async () => {
    const h = harness({
      lines: ["make the change"],
      turns: [{ text: "Proposed plan follows.", plan: proposedPlan }],
    })
    const result = await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)
    const parsedPlan = { ...proposedPlan, revision: 1 }
    expect(result.code).toBe(0)
    expect(h.calls.sessionID).toBe("lca-fixture-session")
    expect(h.calls.validated).toEqual(parsedPlan)
    expect(h.calls.imported).toEqual(parsedPlan)
    expect(h.calls.output.join(" ")).toContain("# Canonical plan")
    expect(h.calls.output.join(" ")).toContain("Plan SHA: sha-fixture")
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
    progress.host({ kind: "tool-started", role: "reviewer", execution: 1, tool: "read" })
    progress.host({ kind: "tool-finished", role: "reviewer", execution: 1, tool: "read", ok: true })
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
    h.deps.humanDecision = async (action, workflowID, sha) => {
      h.calls.events.push("humanDecision")
      h.calls.approvalRequest = { action, workflowID, planSha: sha }
      return withTerminalLine(`APPROVE ${workflowID} ${sha}`, () => humanDecision(action, workflowID, sha))
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
    expect(h.calls.decision).toMatchObject({ action: "approve", workflowID: "wf_fixture", planSha })
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
    h.deps.humanDecision = async (action, workflowID, planSha) => {
      h.calls.events.push("humanDecision")
      h.calls.approvalRequest = { action, workflowID, planSha }
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
      tool: "read",
    })
    expect(h.calls.output).toEqual(outputWhileWaiting)
    expect(h.calls.output.join("")).toContain("Canonical plan")
    expect(h.calls.output.join("")).toContain("Plan SHA: canonical-sha-fixture")

    resolveDecision(await withTerminalLine("APPROVE wf_fixture canonical-sha-fixture",
      () => humanDecision("choose", "wf_fixture", "canonical-sha-fixture")))
    expect(await operation).toEqual({ code: 0 })
    expect(h.calls.output).toContain("[activity] Worker started read tool.\n")
    expect(h.calls.approvalRequest).toEqual({ action: "choose", workflowID: "wf_fixture", planSha: "canonical-sha-fixture" })
    expect(h.calls.decision).toMatchObject({ action: "approve", workflowID: "wf_fixture", planSha: "canonical-sha-fixture" })
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
