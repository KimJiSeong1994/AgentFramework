import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { launchInteractive, parseInteractiveArgs, validModelID, type InteractiveDependencies, type Terminal } from "../src/hosts/interactive.ts"
import type { ForegroundController } from "../src/hosts/controller.ts"
import type { ExecutionRuntime } from "../src/hosts/types.ts"
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
}

function harness(options: HarnessOptions = {}) {
  const lines = [...(options.lines ?? [])]
  const calls: {
    prompts: string[]
    output: string[]
    events: string[]
    runtime?: { worktree: string; engine: string; model: string }
    turns: string[]
    sessionID?: string
    validated?: unknown
    validationAttempts: unknown[]
    imported?: unknown
    decision?: OperatorDecision
    approvalRequest?: { action: Parameters<typeof humanDecision>[0]; workflowID: string; planSha: string }
    runCount: number
    signalListeners: Map<string, Set<() => void>>
  } = { prompts: [], output: [], events: [], turns: [], validationAttempts: [], runCount: 0, signalListeners: new Map() }

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
  const fakeRuntime = {} as ExecutionRuntime
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
            id: "wf_fixture",
            phase: options.importResult?.phase ?? "pending_approval",
            planRef: { mdPath: ".lca/plans/wf_fixture.md" },
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
        wf: { id: "wf_fixture", phase: decision.action === "approve" ? "approved" : "rejected" },
      } as unknown as ReturnType<ForegroundController["decide"]>
    },
    async run(_sessionID: string, signal?: AbortSignal) {
      calls.events.push("run")
      calls.runCount++
      options.beforeRun?.(signal)
      return {
        workflow: { id: "wf_fixture", phase: options.runResult?.phase ?? "done" },
        run: { done: options.runResult?.done ?? 1, failed: options.runResult?.failed ?? 0, cancelled: options.runResult?.cancelled ?? 0, skipped: 0 },
      } as unknown as Awaited<ReturnType<ForegroundController["run"]>>
    },
  } as unknown as ForegroundController

  const deps: Partial<InteractiveDependencies> = {
    cwd: wt.worktree,
    terminal,
    gitTopLevel: () => Object.hasOwn(options, "gitTopLevel") ? options.gitTopLevel : wt.worktree,
    createRuntime: ({ worktree, engine, model }) => {
      calls.events.push("runtime")
      calls.runtime = { worktree, engine, model }
      return fakeRuntime
    },
    createConversation: (_runtime, sessionID) => {
      calls.events.push("conversation")
      calls.sessionID = sessionID
      const turns = [...(options.turns ?? [])]
      return {
        turn: async (text) => {
          calls.events.push("turn")
          calls.turns.push(text)
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
    randomUUID: () => "fixture-session",
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
    expect(h.calls.prompts[1]).toBe("Model ID: ")
    expect(h.calls.runtime).toEqual({ worktree: realpathSync(wt.worktree), engine: "codex", model: "gpt-5-codex" })
    expect(h.calls.output.join(" ")).toContain("estimated")
    expect(h.calls.output.join(" ")).toContain("reactive")
    expect(h.calls.output.join(" ")).toContain("No process or filesystem containment is claimed")
  })

  test("engine and model flags skip only the corresponding prompt; local maps to Ollama runtime", async () => {
    const h = harness({ lines: ["gpt-oss:20b", "/quit"] })
    const result = await launchInteractive({ worktree: wt.worktree, engine: "local" }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.prompts).toEqual(["Model ID: ", "You> "])
    expect(h.calls.runtime?.engine).toBe("local")
    expect(h.calls.runtime?.model).toBe("gpt-oss:20b")

    const explicit = harness({ lines: ["/quit"] })
    await launchInteractive({ worktree: wt.worktree, engine: "claude", model: "claude-sonnet-4-5" }, explicit.deps)
    expect(explicit.calls.prompts).toEqual(["You> "])
    expect(explicit.calls.runtime?.engine).toBe("claude")
    expect(explicit.calls.runtime?.model).toBe("claude-sonnet-4-5")
  })

  test("invalid engine and model choices are retried without choosing an implicit default", async () => {
    const h = harness({ lines: ["0", "claude", "bad model", "claude-sonnet-4-5", "/quit"] })
    const result = await launchInteractive({ worktree: wt.worktree }, h.deps)
    expect(result.code).toBe(0)
    expect(h.calls.prompts[0]).toContain("Choose an execution engine")
    expect(h.calls.prompts[1]).toContain("Choose an execution engine")
    expect(h.calls.prompts[2]).toBe("Model ID: ")
    expect(h.calls.prompts[3]).toBe("Model ID: ")
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
          throw new Error(`invalid plan: step 1: do not edit double.test.ts. ${"extra detail ".repeat(40)}`)
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
    expect(h.calls.output.join(" ")).toContain("Revise the plan or enter /quit")
    const feedback = h.calls.output.find(output => output.startsWith("Plan rejected by LCA validation"))
    expect(feedback).toContain("...")
    expect(feedback?.length).toBeLessThanOrEqual(360)
    expect(h.calls.output.join(" ").length).toBeLessThan(900)
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

  test("sanitizes untrusted runtime refusal output without deciding or running", async () => {
    const injection = "CSI-START\u001b[2JOSC-START\u001b]52;c;Y2xpcA==\u0007C1-CSI\u009b31mCR\rBIDI\u202eEND"
    const h = harness({
      lines: ["make the change"],
      turns: [{ text: "Discussion remains.", plan: proposedPlan }],
      importResult: { ok: false, text: `Host refusal remains 日本語. ${injection}` },
    })

    expect((await launchInteractive({ worktree: wt.worktree, engine: "codex", model: "gpt-5-codex" }, h.deps)).code).toBe(1)
    const output = h.calls.output.join("")
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
