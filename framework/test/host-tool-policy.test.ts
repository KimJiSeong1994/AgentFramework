import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG, type LcaConfig } from "../src/config.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionRequest } from "../src/hosts/types.ts"
import { EMPTY_MODE, readModeState, writeModeState } from "../src/state/store.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const config = (patch: Partial<LcaConfig> = {}): LcaConfig => ({
  ...DEFAULT_CONFIG,
  ...patch,
  guards: { ...DEFAULT_CONFIG.guards, ...patch.guards },
  models: { ...DEFAULT_CONFIG.models, ...patch.models },
  max_output: { ...DEFAULT_CONFIG.max_output, ...patch.max_output },
  disabled_hooks: patch.disabled_hooks ?? [],
})

function request(policy: ReturnType<typeof createExecutionPolicy>, role: "worker" | "reviewer" = "worker"): ExecutionRequest {
  return {
    executionID: "exec", supervisorSessionID: "parent", taskID: "task", attemptID: "attempt", generation: 1,
    role, title: "task", cwd: "/repo", text: "dynamic task", deadlineAt: Date.now() + 1000,
    policy: policy.resolve(role), handlers: undefined as never,
  }
}

describe("host-neutral execution tool policy", () => {
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
    const p = createExecutionPolicy(config({ guards: { repeat_limit: 1 } as LcaConfig["guards"] }))
    const h = p.handlers(request(p))
    const before = (callID: string) => h.beforeTool({ type: "tool-before", sessionID: "vendor", callID, toolID: "t", name: "bash", input: { command: "bad" } })
    expect(before("1")).toEqual({ allow: true })
    h.toolResult({ type: "tool-result", sessionID: "vendor", callID: "1", toolID: "t", name: "bash", result: "Error: failed" })
    expect(before("2")).toMatchObject({ allow: false, reason: expect.stringContaining("failed with") })
    h.toolResult({ type: "tool-result", sessionID: "vendor", callID: "2", toolID: "t", name: "bash", result: "ok" })
    expect(before("3")).toEqual({ allow: true })
  })

  test("binds exact handler instances and honors repetition cancellation configuration", () => {
    const p = createExecutionPolicy(config({ guards: { abort_on_repetition: false } as LcaConfig["guards"] }))
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
    const p = createExecutionPolicy(config({ guards: { read_max_lines: 2 } as LcaConfig["guards"] }))
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
