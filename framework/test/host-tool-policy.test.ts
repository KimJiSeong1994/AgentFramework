import { describe, expect, test } from "bun:test"
import { mainPrompt } from "../src/agents/prompts.ts"
import { DEFAULT_CONFIG, type OtterConfig } from "../src/config.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import { EXECUTION_ROLES, EXECUTION_TOOL_NAMES, WORKFLOW_READ_ONLY_ROLES, type ExecutionRequest, type ExecutionRole } from "../src/hosts/types.ts"
import { EMPTY_MODE, readModeState, writeModeState } from "../src/state/store.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const config = (patch: Partial<OtterConfig> = {}): OtterConfig => ({
  ...DEFAULT_CONFIG,
  ...patch,
  guards: { ...DEFAULT_CONFIG.guards, ...patch.guards },
  models: { ...DEFAULT_CONFIG.models, ...patch.models },
  max_output: { ...DEFAULT_CONFIG.max_output, ...patch.max_output },
  disabled_hooks: patch.disabled_hooks ?? [],
})

function request(policy: ReturnType<typeof createExecutionPolicy>, role: ExecutionRole = "worker"): ExecutionRequest {
  return {
    executionID: "exec", supervisorSessionID: "parent", taskID: "task", attemptID: "attempt", generation: 1,
    role, title: "task", cwd: "/repo", text: "dynamic task", deadlineAt: Date.now() + 1000,
    policy: policy.resolve(role), handlers: undefined as never,
  }
}

describe("host-neutral execution tool policy", () => {
  test("every role enforces its actual allowlist and denials, including data roles", () => {
    const p = createExecutionPolicy(config())
    for (const role of EXECUTION_ROLES) {
      const snapshot = p.resolve(role)
      for (const name of [...EXECUTION_TOOL_NAMES, "future_mutator", "approve", "constructor"]) {
        const handlers = p.handlers(request(p, role))
        const decision = handlers.beforeTool({
          type: "tool-before", sessionID: role, callID: name, toolID: name, name, input: {},
        })
        expect(decision.allow).toBe(snapshot.tools.allowed.includes(name) && !snapshot.tools.denied.includes(name))
      }
    }
    expect(() => p.resolve("unknown" as ExecutionRole)).toThrow("Unsupported execution role")
    expect(() => p.handlers({ ...request(p), role: "unknown" as ExecutionRole })).toThrow("fixed role snapshot")
    expect(() => p.handlers({ ...request(p), role: "architect" })).toThrow("fixed role snapshot")
  })

  test("workflow roles have fixed read-only capabilities without adding model configuration keys", () => {
    const input = config({ models: { main: "local/selected-model" } })
    const before = JSON.stringify(input)
    const p = createExecutionPolicy(input)
    for (const role of WORKFLOW_READ_ONLY_ROLES) {
      const snapshot = p.resolve(role)
      expect(snapshot.tools.allowed).toEqual(["read", "list", "glob", "grep", "memory"])
      expect(snapshot.tools.denied).toEqual(expect.arrayContaining(["write", "edit", "bash", "delegate", "task", "otter_flow", "skill"]))
      expect(snapshot.model).toEqual({ providerID: "local", modelID: "selected-model" })
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot.tools.allowed)).toBe(true)
      expect(Object.isFrozen(snapshot.model)).toBe(true)
      expect(snapshot.system.join("\n")).toContain("Never modify files")
      expect(snapshot.id).not.toBe(p.resolve("main").id)
      expect(() => p.bindSession(role, p.handlers(request(p, role)), Object.freeze({ ...snapshot }))).toThrow("fixed frozen snapshot")
    }
    expect(JSON.stringify(input)).toBe(before)
    expect(new Set(WORKFLOW_READ_ONLY_ROLES.map(role => p.resolve(role).id)).size).toBe(WORKFLOW_READ_ONLY_ROLES.length)
  })

  test("returns stable frozen per-role prompt, model, budget and tool snapshots", () => {
    const p = createExecutionPolicy(config({ models: { worker: "ollama/org/model:v2" } }))
    const first = p.resolve("worker")
    expect(p.resolve("worker")).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.system)).toBe(true)
    expect(first.model).toEqual({ providerID: "ollama", modelID: "org/model:v2" })
    expect(first.maxOutputTokens).toBe(4096)
    expect(first.thinking).toBe("disabled")
    expect(p.resolve("main").thinking).toBe("inherit")
  })

  test("planning-only main has a fixed read-only tool and prompt snapshot", () => {
    const p = createExecutionPolicy(config(), { planningOnlyMain: true })
    const main = p.resolve("main")
    expect(Object.isFrozen(main)).toBe(true)
    expect(Object.isFrozen(main.tools)).toBe(true)
    expect(Object.isFrozen(main.tools.allowed)).toBe(true)
    expect(Object.isFrozen(main.tools.denied)).toBe(true)
    expect(Object.isFrozen(main.system)).toBe(true)
    expect(main.tools.allowed).toEqual(["read", "list", "glob", "grep", "memory"])
    expect(main.tools.denied).toEqual(expect.arrayContaining([
      "write", "edit", "patch", "apply_patch", "multiedit", "bash", "delegate", "otter_flow",
      "webfetch", "skill", "todowrite", "todoread", "db_query", "schema_lookup", "task",
    ]))
    expect(main.system.join("\n")).toContain("Discuss the request, inspect files with read-only tools, and create a concrete plan")
    expect(main.system.join("\n")).toContain("Never modify files, run commands, execute or approve plans, or delegate work")
    expect(main.system.join("\n")).not.toMatch(/do it yourself|after changing code|run existing tests|call the delegate tool|submit plans only with otter_flow/i)
    expect(main.id).not.toBe(createExecutionPolicy(config()).resolve("main").id)
    const handlers = p.handlers(request(p, "main"))
    expect(handlers.beforeTool({ type: "tool-before", sessionID: "main", callID: "read", toolID: "t", name: "read", input: {} })).toEqual({ allow: true })
    expect(handlers.beforeTool({ type: "tool-before", sessionID: "main", callID: "memory", toolID: "t", name: "memory", input: { query: "cache" } })).toEqual({ allow: true })
    expect(handlers.beforeTool({ type: "tool-before", sessionID: "main", callID: "bash", toolID: "t", name: "bash", input: {} })).toMatchObject({ allow: false })
  })

  test("planning-only selection leaves legacy main and worker/reviewer policies unchanged by default", () => {
    const ordinary = createExecutionPolicy(config())
    const planning = createExecutionPolicy(config(), { planningOnlyMain: true })
    expect(ordinary.resolve("main").system).toEqual([mainPrompt(
      !config().disabled_hooks.includes("tool.delegate"),
      config().data.backend !== "none" && !config().disabled_hooks.includes("tool.data"),
      config().flow.enabled && !config().disabled_hooks.includes("flow"),
    )])
    expect(planning.resolve("worker")).toEqual(ordinary.resolve("worker"))
    expect(planning.resolve("reviewer")).toEqual(ordinary.resolve("reviewer"))
  })

  test("native context is copied, frozen and included in the resolved policy identity", () => {
    const input = { identity: "catalog-a", instructions: "Follow the native profile." }
    const withNativeContext = createExecutionPolicy(config(), { nativeContext: input })
    const snapshot = withNativeContext.resolve("main")
    expect(snapshot.nativeContext).toEqual(input)
    expect(Object.isFrozen(snapshot.nativeContext)).toBe(true)
    input.identity = "mutated"
    input.instructions = "Mutated after policy construction."
    expect(snapshot.nativeContext).toEqual({ identity: "catalog-a", instructions: "Follow the native profile." })
    expect(snapshot.system.join("\n")).not.toContain("Follow the native profile.")
    expect(snapshot.id).not.toBe(createExecutionPolicy(config()).resolve("main").id)
    expect(snapshot.id).not.toBe(createExecutionPolicy(config(), {
      nativeContext: { identity: "catalog-a", instructions: "Different instructions." },
    }).resolve("main").id)
    expect(() => createExecutionPolicy(config(), { nativeContext: { identity: "", instructions: "valid" } })).toThrow("invalid native execution context")
    expect(() => createExecutionPolicy(config(), { nativeContext: null as never })).toThrow("invalid native execution context")
  })

  test("fails closed for unknown worker tools and denies reviewer mutations", () => {
    const p = createExecutionPolicy(config())
    const worker = p.handlers(request(p))
    const reviewer = p.handlers(request(p, "reviewer"))
    expect(worker.beforeTool({ type: "tool-before", sessionID: "v1", callID: "c", toolID: "t", name: "unknown", input: {} })).toMatchObject({ allow: false })
    expect(reviewer.beforeTool({ type: "tool-before", sessionID: "v2", callID: "c", toolID: "t", name: "write", input: {} })).toMatchObject({ allow: false })
    expect(reviewer.beforeTool({ type: "tool-before", sessionID: "v2", callID: "c2", toolID: "t", name: "read", input: {} })).toEqual({ allow: true })
  })

  test("bounds reviewer calls independently of the plugin-local review registry", () => {
    const p = createExecutionPolicy(config({ flow: { ...DEFAULT_CONFIG.flow, review_max_tool_calls: 1 } }))
    const h = p.handlers(request(p, "reviewer"))
    expect(h.beforeTool({ type: "tool-before", sessionID: "vendor", callID: "1", toolID: "1", name: "read", input: {} })).toEqual({ allow: true })
    expect(h.beforeTool({ type: "tool-before", sessionID: "vendor", callID: "2", toolID: "2", name: "read", input: {} })).toMatchObject({ allow: false, reason: expect.stringContaining("tool-call cap") })
  })

  test("records failures and resets repeats only after successful result", () => {
    const p = createExecutionPolicy(config({ guards: { repeat_limit: 1 } as OtterConfig["guards"] }))
    const h = p.handlers(request(p))
    const before = (callID: string) => h.beforeTool({ type: "tool-before", sessionID: "vendor", callID, toolID: "t", name: "bash", input: { command: "bad" } })
    expect(before("1")).toEqual({ allow: true })
    h.toolResult({ type: "tool-result", sessionID: "vendor", callID: "1", toolID: "t", name: "bash", result: "Error: failed" })
    expect(before("2")).toMatchObject({ allow: false, reason: expect.stringContaining("failed with") })
    h.toolResult({ type: "tool-result", sessionID: "vendor", callID: "2", toolID: "t", name: "bash", result: "ok" })
    expect(before("3")).toEqual({ allow: true })
  })

  test("binds exact handler instances and honors repetition cancellation configuration", () => {
    const p = createExecutionPolicy(config({ guards: { abort_on_repetition: false } as OtterConfig["guards"] }))
    const h = p.handlers(request(p))
    const snapshot = p.resolve("worker")
    p.bindSession("vendor", h, snapshot)
    p.bindSession("vendor", h, snapshot)
    expect(p.handlersForSession("vendor")).toBe(h)
    expect(p.snapshotForSession("vendor")).toBe(snapshot)
    expect(() => p.bindSession("vendor", p.handlers(request(p)), snapshot)).toThrow(/already bound/)
    const differentSnapshot = { ...snapshot }
    expect(() => p.bindSession("vendor", h, differentSnapshot)).toThrow(/fixed frozen snapshot/)
    expect(() => p.bindSession("foreign", h, Object.freeze({ ...snapshot }))).toThrow(/fixed frozen snapshot/)
    expect(h.assistantText({ type: "text", sessionID: "vendor", partID: "part", text: `${"same phrase ".repeat(30)}`, final: false })).toEqual({ cancel: false })
    p.unbindSession("vendor")
    expect(p.handlersForSession("vendor")).toBeUndefined()
    expect(p.snapshotForSession("vendor")).toBeUndefined()
  })

  test("returns trimming and recovery metadata from result shaping", () => {
    const p = createExecutionPolicy(config({ guards: { read_max_lines: 2 } as OtterConfig["guards"] }))
    const h = p.handlers(request(p))
    const trimmed = h.toolResult({ type: "tool-result", sessionID: "vendor", callID: "read", toolID: "t", name: "read", result: "one\ntwo\nthree\nfour" })
    expect(trimmed).toMatchObject({ trimmed: true, hinted: false })
    const hinted = h.toolResult({ type: "tool-result", sessionID: "vendor", callID: "write", toolID: "t", name: "write", result: "Error: File already exists" })
    expect(hinted).toMatchObject({ trimmed: false, hinted: true })
  })

  test("resets active mode failures only after a successful result for that session", () => {
    const worktree = mkdtempSync(join(tmpdir(), "policy-state-"))
    try {
      writeModeState(worktree, "vendor", { ...EMPTY_MODE, active: true, failures: 2 })
      const p = createExecutionPolicy(config(), { worktree })
      const h = p.handlers(request(p))
      h.toolResult({ type: "tool-result", sessionID: "vendor", callID: "failed", toolID: "t", name: "bash", error: "failed" })
      expect(readModeState(worktree, "vendor").failures).toBe(2)
      h.toolResult({ type: "tool-result", sessionID: "vendor", callID: "ok", toolID: "t", name: "bash", result: "ok" })
      expect(readModeState(worktree, "vendor").failures).toBe(0)
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })
})
