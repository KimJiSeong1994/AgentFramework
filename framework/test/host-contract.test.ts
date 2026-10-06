import { describe, expect, it } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { createOpenCodeHost } from "../src/hosts/opencode.ts"
import type { ExecutionPolicy, ExecutionRequest } from "../src/hosts/types.ts"

function request(): ExecutionRequest {
  return {
    executionID: "execution",
    supervisorSessionID: "supervisor",
    taskID: "task",
    attemptID: "attempt",
    generation: 3,
    role: "worker",
    title: "Implement task",
    cwd: "/tmp/worktree",
    text: "Do this",
    deadlineAt: Date.now() + 10_000,
    policy: {
      id: "policy",
      role: "worker",
      model: { providerID: "vendor", modelID: "with/slash/model" },
      maxOutputTokens: 777,
      tools: { allowed: ["read", "edit", "shared"], denied: ["edit", "bash", "plugin-denied"] },
      system: ["system one", "system two"],
      thinking: "disabled",
    },
    handlers: {
      beforeTool: () => ({ allow: true }),
      toolResult: () => ({}),
      assistantText: () => ({ cancel: false }),
    },
  }
}

function client(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; options: unknown }> = []
  const fake = {
    session: {
      create: async (options: unknown) => {
        calls.push({ method: "create", options })
        return { data: { id: "vendor-session" } }
      },
      prompt: async (options: unknown) => {
        calls.push({ method: "prompt", options })
        return { data: { info: { sessionID: "vendor-session", parentID: "msg_execution", role: "assistant" }, parts: [{ type: "text", text: "done" }] } }
      },
      abort: async (options: unknown) => {
        calls.push({ method: "abort", options })
        return { data: true }
      },
      status: async () => ({ data: { "vendor-session": { type: "busy" } } }),
      ...overrides,
    },
  }
  return { value: fake as unknown as PluginInput["client"], calls }
}

function policyBinding() {
  const bindings = new Map<string, ExecutionRequest["handlers"]>()
  const snapshots = new Map<string, ExecutionRequest["policy"]>()
  const calls: string[] = []
  const policy: Pick<ExecutionPolicy, "bindSession" | "unbindSession" | "handlersForSession" | "snapshotForSession"> = {
    bindSession(sessionID, handlers, snapshot) { calls.push(`bind:${sessionID}`); bindings.set(sessionID, handlers); snapshots.set(sessionID, snapshot) },
    unbindSession(sessionID) { calls.push(`unbind:${sessionID}`); bindings.delete(sessionID); snapshots.delete(sessionID) },
    handlersForSession(sessionID) { return bindings.get(sessionID) },
    snapshotForSession(sessionID) { return snapshots.get(sessionID) },
  }
  return {
    policy,
    snapshots,
    calls,
    capabilities: {
      policy,
      applyOutputLimit(sessionID: string, maximum: number) { calls.push(`output:${sessionID}:${maximum}`); return true },
      applyThinking(sessionID: string, mode: ExecutionRequest["policy"]["thinking"]) { calls.push(`thinking:${sessionID}:${mode}`); return true },
      processRisk() { return false },
    },
  }
}

describe("OpenCode execution host contract", () => {
  it("creates only a session during prepare, binds its reference, then maps exact prompt fields", async () => {
    const sdk = client()
    const executionRequest = request()
    const binding = policyBinding()
    const handle = await createOpenCodeHost(sdk.value, binding.capabilities).prepare(executionRequest)
    expect(handle.reference).toEqual({ executionID: "execution", vendorSessionID: "vendor-session" })
    expect(binding.policy.handlersForSession("vendor-session")).toBe(executionRequest.handlers)
    expect(binding.policy.snapshotForSession("vendor-session")).toBe(executionRequest.policy)
    expect(binding.calls).toEqual(["bind:vendor-session", "output:vendor-session:777", "thinking:vendor-session:disabled"])
    expect(sdk.calls[0]).toEqual({ method: "create", options: { body: { title: "Implement task", parentID: "supervisor" }, query: { directory: "/tmp/worktree" } } })
    expect(sdk.calls.map((call) => call.method)).toEqual(["create"])
    expect(await handle.run()).toEqual({ status: "completed", text: "done" })
    expect(binding.policy.handlersForSession("vendor-session")).toBe(executionRequest.handlers)
    binding.policy.unbindSession("vendor-session")
    expect(binding.policy.handlersForSession("vendor-session")).toBeUndefined()
    expect(sdk.calls[1]).toEqual({
      method: "prompt",
      options: {
        path: { id: "vendor-session" },
        query: { directory: "/tmp/worktree" },
        body: {
          messageID: "msg_execution",
          model: { providerID: "vendor", modelID: "with/slash/model" },
          agent: "worker",
          system: "system one\n\nsystem two",
          tools: { read: true, edit: false, shared: true, bash: false, "plugin-denied": false },
          parts: [{ type: "text", text: "Do this" }],
        },
      },
    })
  })

  it("fails creation and rejects empty, malformed, or uncorrelated responses", async () => {
    const failed = client({ create: async () => ({ error: new Error("create failed") }) })
    await expect(createOpenCodeHost(failed.value, policyBinding().capabilities).prepare(request())).rejects.toThrow("create failed")

    for (const response of [
      { data: { info: { sessionID: "vendor-session", parentID: "msg_execution", role: "assistant" }, parts: [] } },
      { data: { info: { sessionID: "vendor-session", parentID: "msg_execution", role: "assistant" }, parts: null } },
      { data: { info: { sessionID: "other-session", parentID: "msg_execution", role: "assistant" }, parts: [{ type: "text", text: "wrong" }] } },
      { error: new Error("provider failed") },
    ]) {
      const sdk = client({ prompt: async () => response })
      const handle = await createOpenCodeHost(sdk.value, policyBinding().capabilities).prepare(request())
      const outcome = await handle.run()
      expect(["incomplete", "failed"]).toContain(outcome.status)
      expect(outcome.status).not.toBe("completed")
    }
  })

  it("publishes a created vendor session before a policy binding failure", async () => {
    const sdk = client()
    const binding = policyBinding()
    const references: string[] = []
    const original = binding.policy.bindSession
    binding.policy.bindSession = (...args) => { original(...args); throw new Error("bind unavailable") }
    await expect(createOpenCodeHost(sdk.value, binding.capabilities).prepare({
      ...request(), onReference: (reference) => references.push(JSON.stringify(reference)),
    })).rejects.toThrow("bind unavailable")
    expect(references).toEqual([JSON.stringify({ executionID: "execution", vendorSessionID: "vendor-session" })])
    expect(sdk.calls.map((call) => call.method)).toEqual(["create"])
  })

  it("refuses unsupported bindings before creating a child session", async () => {
    const sdk = client()
    await expect(createOpenCodeHost(sdk.value).prepare(request())).rejects.toThrow("refusing to create a child session")
    expect(sdk.calls).toEqual([])
  })

  it("keeps abort acknowledgement separate from terminal/quiescent proof", async () => {
    const sdk = client()
    const binding = policyBinding()
    const handle = await createOpenCodeHost(sdk.value, binding.capabilities).prepare(request())
    const cancel = await handle.requestCancel("stop", Date.now() + 1000)
    expect(cancel).toMatchObject({ requested: true, acknowledged: true, terminal: false, quiescent: false })
    expect(binding.policy.handlersForSession("vendor-session")).toBeDefined()
    expect(await handle.reconcile()).toMatchObject({ outcome: "running", quiescent: false })
  })

  it("recognizes only a correlated completed abort response as terminal", async () => {
    const sdk = client({ prompt: async () => ({ data: {
      info: { sessionID: "vendor-session", parentID: "msg_execution", role: "assistant", error: { name: "MessageAbortedError" } },
      parts: [],
    } }) })
    const handle = await createOpenCodeHost(sdk.value, policyBinding().capabilities).prepare(request())
    expect(await handle.run()).toMatchObject({ status: "cancelled" })
    expect(await handle.reconcile()).toMatchObject({ outcome: "terminal", quiescent: true })
  })

  it("cannot claim quiescence after a native shell tool may leave a descendant", async () => {
    const sdk = client()
    const binding = policyBinding()
    const handle = await createOpenCodeHost(sdk.value, { ...binding.capabilities, processRisk: () => true }).prepare(request())
    expect(await handle.run()).toMatchObject({ status: "completed" })
    expect(await handle.reconcile()).toMatchObject({ outcome: "terminal", quiescent: false })
  })

  it("bounds abort by its deadline and exposes persisted-reference status conservatively", async () => {
    const sdk = client({ abort: async () => new Promise(() => {}), status: async () => ({ data: { "vendor-session": { type: "idle" } } }) })
    const host = createOpenCodeHost(sdk.value, policyBinding().capabilities)
    const handle = await host.prepare(request())
    const cancel = await handle.requestCancel("stop", Date.now() + 5)
    expect(cancel).toMatchObject({ requested: true, acknowledged: false, terminal: false, quiescent: false })
    expect(await host.reconcile(handle.reference)).toMatchObject({ outcome: "unknown", quiescent: false })
  })

  it("sends abort after the execution deadline while preserving ACK versus quiescence", async () => {
    const expired = request()
    expired.deadlineAt = Date.now() - 1000
    const sdk = client()
    const handle = await createOpenCodeHost(sdk.value, policyBinding().capabilities).prepare(expired)
    const cancel = await handle.requestCancel("queue TTL", Date.now() + 1000)
    expect(sdk.calls.some((call) => call.method === "abort")).toBe(true)
    expect(cancel).toMatchObject({ requested: true, acknowledged: true, terminal: false, quiescent: false })
  })

  it("preflight refuses guarantees unavailable through OpenCode plugin hooks", async () => {
    const result = await createOpenCodeHost(client().value).preflight("coding")
    expect(result.compatible).toBe(false)
    expect(result.controls.toolPolicyHandlers).toBe("unsupported")
    expect(result.controls.assistantTextHandler).toBe("unsupported")
    const bound = await createOpenCodeHost(client().value, policyBinding().capabilities).preflight("coding")
    expect(bound.compatible).toBe(true)
    expect(bound.controls.toolPolicyHandlers).toBe("supported")
  })
})
