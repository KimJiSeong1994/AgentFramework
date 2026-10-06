import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createOpenCodeHost, openCodeMessageID } from "../src/hosts/opencode.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
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
      recoveryContext() { return undefined },
    },
  }
}

const EXECUTION_ID = "exec/one"
const VENDOR_SESSION_ID = "child-session"
const OWNER_SESSION_ID = "supervisor-session"

function promptMessage(id = openCodeMessageID(EXECUTION_ID)) {
  return {
    info: { id, sessionID: VENDOR_SESSION_ID, role: "user", time: { created: 10 }, agent: "worker", model: { providerID: "vendor", modelID: "model" } },
    parts: [{ id: "user-part", sessionID: VENDOR_SESSION_ID, messageID: id, type: "text", text: "Do this" }],
  }
}

function toolCallMessage(tool: string, number: number, state: Record<string, unknown> = {
  status: "completed", input: {}, output: "ok", title: tool, metadata: {}, time: { start: number * 10, end: number * 10 + 1 },
}) {
  const id = `assistant-tools-${number}`
  const part = (suffix: string, type: string, extra: Record<string, unknown> = {}) => ({
    id: `${id}-${suffix}`, sessionID: VENDOR_SESSION_ID, messageID: id, type, ...extra,
  })
  return {
    info: { id, sessionID: VENDOR_SESSION_ID, role: "assistant", time: { created: number * 10, completed: number * 10 + 2 }, parentID: openCodeMessageID(EXECUTION_ID), finish: "tool-calls", agent: "worker" },
    parts: [
      part("start", "step-start"),
      part("tool", "tool", { callID: `call-${number}`, tool, state }),
      part("finish", "step-finish", { reason: "tool-calls", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ],
  }
}

function completeTranscript() {
  const finalID = "assistant-final"
  return [
    promptMessage(),
    toolCallMessage("glob", 1),
    toolCallMessage("read", 2),
    toolCallMessage("edit", 3),
    {
      info: { id: finalID, sessionID: VENDOR_SESSION_ID, role: "assistant", time: { created: 40, completed: 50 }, parentID: openCodeMessageID(EXECUTION_ID), finish: "stop", agent: "worker" },
      parts: [{ id: "final-text", sessionID: VENDOR_SESSION_ID, messageID: finalID, type: "text", text: "done" }],
    },
  ]
}

function recoveryHarness(options: { record?: boolean; policyID?: string; profile?: "legacy-unowned" | "linux-single-use" } = {}) {
  const stateHome = mkdtempSync(join(tmpdir(), "opencode-recovery-state-"))
  const worktree = mkdtempSync(join(tmpdir(), "opencode-recovery-worktree-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  const previousLcaStateHome = process.env.LCA_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  delete process.env.LCA_STATE_HOME
  const calls: Array<{ method: string; options: unknown }> = []
  const responses = {
    status: async (_options: unknown): Promise<unknown> => ({ data: { [VENDOR_SESSION_ID]: { type: "idle" } } }),
    get: async (_options: unknown): Promise<unknown> => ({ data: { id: VENDOR_SESSION_ID, parentID: OWNER_SESSION_ID, directory: worktree } }),
    messages: async (_options: unknown): Promise<unknown> => ({ data: completeTranscript() }),
  }
  const sdk = {
    session: {
      status: async (options: unknown) => { calls.push({ method: "status", options }); return responses.status(options) },
      get: async (options: unknown) => { calls.push({ method: "get", options }); return responses.get(options) },
      messages: async (options: unknown) => { calls.push({ method: "messages", options }); return responses.messages(options) },
      create: async (options: unknown) => { calls.push({ method: "create", options }); return { data: { id: VENDOR_SESSION_ID } } },
      prompt: async (options: unknown) => { calls.push({ method: "prompt", options }); return { data: {} } },
      abort: async (options: unknown) => { calls.push({ method: "abort", options }); return { data: true } },
    },
  } as unknown as PluginInput["client"]
  const deps = { client: sdk, directory: worktree, worktree, config: DEFAULT_CONFIG, log() {} }
  const originalRuntime = getOpenCodeRuntime(deps)
  const reference = { executionID: EXECUTION_ID, vendorSessionID: VENDOR_SESSION_ID }
  let claim: ReturnType<typeof originalRuntime.runs.claim> | undefined
  if (options.record !== false) {
    claim = originalRuntime.runs.claim(OWNER_SESSION_ID, originalRuntime.instance, process.pid)
    originalRuntime.runs.registerIntent(claim, {
      executionId: EXECUTION_ID, ownerSession: OWNER_SESSION_ID, taskId: "task", attemptId: "attempt",
      generation: claim.generation, role: "worker", cwd: worktree,
      policyID: options.policyID ?? originalRuntime.policy.resolve("worker").id,
      kind: "host", profile: options.profile ?? "legacy-unowned",
    })
    originalRuntime.runs.bindVendorRef(claim, EXECUTION_ID, JSON.stringify(reference))
  }
  // A distinct deps object forces a new host/runtime while retaining only the durable run store.
  const runtime = getOpenCodeRuntime({ ...deps })
  return {
    calls, responses, reference, claim, runtime, worktree,
    cleanup() {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previousStateHome
      if (previousLcaStateHome === undefined) delete process.env.LCA_STATE_HOME
      else process.env.LCA_STATE_HOME = previousLcaStateHome
      rmSync(stateHome, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
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

  it("recovers a complete file-only transcript from a fresh runtime using only durable context", async () => {
    const h = recoveryHarness()
    try {
      const untrustedReference = { ...h.reference, cwd: "/untrusted/caller-path" }
      expect(await h.runtime.host.reconcile(untrustedReference)).toMatchObject({
        outcome: "terminal", quiescent: true,
        evidence: expect.stringContaining(openCodeMessageID(EXECUTION_ID)),
      })
      expect(h.calls.map(call => call.method)).toEqual(["status", "get", "messages", "status"])
      expect(h.calls[0]?.options).toEqual({ query: { directory: h.worktree } })
      expect(h.calls[1]?.options).toEqual({ path: { id: VENDOR_SESSION_ID }, query: { directory: h.worktree } })
      expect(h.calls[2]?.options).toEqual({ path: { id: VENDOR_SESSION_ID }, query: { directory: h.worktree } })
      expect(h.calls[3]?.options).toEqual({ query: { directory: h.worktree } })
      expect(h.calls.some(call => call.method === "create" || call.method === "prompt" || call.method === "abort")).toBe(false)
    } finally { h.cleanup() }
  })

  it("accepts an empty native glob title without weakening tool completion checks", async () => {
    const h = recoveryHarness()
    try {
      const messages = completeTranscript()
      const step = toolCallMessage("glob", 1, {
        status: "completed", input: { pattern: "*.py" }, output: "file.py",
        title: "", metadata: {}, time: { start: 10, end: 11 },
      })
      h.responses.messages = async () => ({ data: [messages[0], step, messages.at(-1)] })
      expect(await h.runtime.host.reconcile(h.reference)).toMatchObject({ outcome: "terminal", quiescent: true })
    } finally { h.cleanup() }
  })

  it("requires complete correlated evidence even when idle sessions are omitted from status", async () => {
    const h = recoveryHarness()
    try {
      h.responses.status = async () => ({ data: {} })
      expect(await h.runtime.host.reconcile(h.reference)).toMatchObject({ outcome: "terminal", quiescent: true })
      h.responses.messages = async () => ({ data: [promptMessage()] })
      expect(await h.runtime.host.reconcile(h.reference)).toMatchObject({ outcome: "unknown", quiescent: false })
      h.responses.get = async () => ({ error: new Error("session missing") })
      expect(await h.runtime.host.reconcile(h.reference)).toMatchObject({ outcome: "unknown", quiescent: false })
    } finally { h.cleanup() }
  })

  it("refuses process-bearing or delegated tool transcripts even without a persisted risk flag", async () => {
    const h = recoveryHarness()
    try {
      for (const tool of ["bash", "task", "delegate"]) {
        const messages = completeTranscript()
        h.responses.messages = async () => ({ data: [messages[0], toolCallMessage(tool, 1), messages.at(-1)] })
        expect(await h.runtime.host.reconcile(h.reference)).toMatchObject({ outcome: "unknown", quiescent: false })
      }
    } finally { h.cleanup() }
  })

  it("keeps idle-only and intermediate tool-call transcripts fenced", async () => {
    const h = recoveryHarness()
    try {
      h.responses.messages = async () => ({ data: [promptMessage()] })
      expect(await h.runtime.host.reconcile(h.reference)).toMatchObject({ outcome: "unknown", quiescent: false })

      h.responses.messages = async () => ({ data: [promptMessage(), toolCallMessage("read", 1)] })
      expect(await h.runtime.host.reconcile(h.reference)).toMatchObject({ outcome: "unknown", quiescent: false })
    } finally { h.cleanup() }
  })

  it("treats busy and retry status at either read as running", async () => {
    for (const busyType of ["busy", "retry"]) {
      const h = recoveryHarness()
      try {
        h.responses.status = async () => ({ data: { [VENDOR_SESSION_ID]: { type: busyType } } })
        expect(await h.runtime.host.reconcile(h.reference)).toMatchObject({ outcome: "running", quiescent: false })
        expect(h.calls.map(call => call.method)).toEqual(["status"])
      } finally { h.cleanup() }

      const duringRead = recoveryHarness()
      try {
        let reads = 0
        duringRead.responses.status = async () => ({ data: { [VENDOR_SESSION_ID]: { type: ++reads === 1 ? "idle" : busyType } } })
        expect(await duringRead.runtime.host.reconcile(duringRead.reference)).toMatchObject({ outcome: "running", quiescent: false })
        expect(duringRead.calls.map(call => call.method)).toEqual(["status", "get", "messages", "status"])
      } finally { duringRead.cleanup() }
    }
  })

  it("fails closed on unbound identities, mismatched transcript fields and incomplete evidence", async () => {
    type MessageFixture = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> }
    const malformed: Array<(h: ReturnType<typeof recoveryHarness>) => void> = [
      h => { h.responses.get = async () => ({ data: { id: VENDOR_SESSION_ID, parentID: "foreign-owner", directory: h.worktree } }) },
      h => { h.responses.get = async () => ({ data: { id: VENDOR_SESSION_ID, parentID: OWNER_SESSION_ID, directory: "/foreign/worktree" } }) },
      h => { h.responses.get = async () => ({ data: { id: "foreign-session", parentID: OWNER_SESSION_ID, directory: h.worktree } }) },
      h => { h.responses.messages = async () => ({ data: [promptMessage("unbound-anchor"), ...completeTranscript().slice(1)] }) },
      h => {
        const records = completeTranscript() as unknown as MessageFixture[]
        records[1]!.info.parentID = "foreign-prompt"
        h.responses.messages = async () => ({ data: records })
      },
      h => {
        const records = completeTranscript() as unknown as MessageFixture[]
        records[1]!.info.sessionID = "foreign-session"
        h.responses.messages = async () => ({ data: records })
      },
      h => {
        const records = completeTranscript() as unknown as MessageFixture[]
        const time = records.at(-1)!.info.time as Record<string, unknown>
        delete time.completed
        h.responses.messages = async () => ({ data: records })
      },
      h => {
        const records = completeTranscript() as unknown as MessageFixture[]
        records.at(-1)!.info.finish = "unknown"
        h.responses.messages = async () => ({ data: records })
      },
      h => {
        const records = completeTranscript() as unknown as MessageFixture[]
        records.push({
          info: { id: "assistant-later", sessionID: VENDOR_SESSION_ID, role: "assistant", time: { created: 60, completed: 70 }, parentID: openCodeMessageID(EXECUTION_ID), finish: "stop", agent: "worker" },
          parts: [],
        })
        h.responses.messages = async () => ({ data: records })
      },
      h => {
        const records = completeTranscript() as unknown as MessageFixture[]
        records[1]!.parts[0]!.sessionID = "foreign-session"
        h.responses.messages = async () => ({ data: records })
      },
      h => {
        const records = completeTranscript() as unknown as MessageFixture[]
        records[1]!.parts[0]!.messageID = "foreign-message"
        h.responses.messages = async () => ({ data: records })
      },
      h => {
        const records = completeTranscript() as unknown as MessageFixture[]
        records[1]!.parts[1]!.state = { status: "pending", input: {}, raw: "" }
        h.responses.messages = async () => ({ data: records })
      },
      h => {
        const records = completeTranscript() as unknown as MessageFixture[]
        records[1]!.parts[1]!.state = { status: "running", input: {}, time: { start: 10 } }
        h.responses.messages = async () => ({ data: records })
      },
      h => { h.responses.messages = async () => ({ data: [...completeTranscript(), promptMessage("msg_later")] }) },
      h => { h.responses.status = async () => ({ error: new Error("status unavailable") }) },
      h => { h.responses.get = async () => ({ error: new Error("session unavailable") }) },
      h => { h.responses.messages = async () => ({ error: new Error("messages unavailable") }) },
      h => { h.responses.status = async () => ({ data: { [VENDOR_SESSION_ID]: null } }) },
      h => { h.responses.status = async () => ({ data: [] }) },
      h => {
        let reads = 0
        h.responses.status = async () => ++reads === 1
          ? { data: { [VENDOR_SESSION_ID]: { type: "idle" } } }
          : { error: new Error("status changed during reconciliation") }
      },
    ]
    for (const corrupt of malformed) {
      const h = recoveryHarness()
      try {
        corrupt(h)
        expect(await h.runtime.host.reconcile(h.reference)).toMatchObject({ outcome: "unknown", quiescent: false })
      } finally { h.cleanup() }
    }

    const foreignReference = recoveryHarness()
    try {
      expect(await foreignReference.runtime.host.reconcile({ ...foreignReference.reference, executionID: "foreign-execution" }))
        .toMatchObject({ outcome: "unknown", quiescent: false })
    } finally { foreignReference.cleanup() }
  })

  it("accepts a correlated completed assistant error without treating it as task success", async () => {
    const h = recoveryHarness()
    try {
      const prompt = promptMessage()
      const id = "assistant-error"
      h.responses.messages = async () => ({ data: [prompt, {
        info: {
          id, sessionID: VENDOR_SESSION_ID, role: "assistant", time: { created: 20, completed: 30 },
          parentID: openCodeMessageID(EXECUTION_ID), error: { name: "APIError" }, agent: "worker",
        },
        parts: [],
      }] })
      expect(await h.runtime.host.reconcile(h.reference)).toMatchObject({ outcome: "terminal", quiescent: true })
    } finally { h.cleanup() }
  })

  it("requires a unique compatible durable host record and fixed policy identity", async () => {
    for (const options of [{ record: false }, { policyID: "foreign-policy" }, { profile: "linux-single-use" as const }]) {
      const h = recoveryHarness(options)
      try {
        expect(await h.runtime.host.reconcile(h.reference)).toMatchObject({ outcome: "unknown", quiescent: false })
      } finally { h.cleanup() }
    }

    const ambiguous = recoveryHarness()
    try {
      const claim = ambiguous.claim!
      ambiguous.runtime.runs.recordTerminal(claim, EXECUTION_ID, { outcome: "completed", terminalAt: 60, quiescentAt: 61 })
      ambiguous.runtime.runs.registerIntent(claim, {
        executionId: "second-execution", ownerSession: OWNER_SESSION_ID, taskId: "task-2", attemptId: "attempt-2",
        generation: claim.generation, role: "worker", cwd: ambiguous.worktree,
        policyID: ambiguous.runtime.policy.resolve("worker").id, kind: "host", profile: "legacy-unowned",
      })
      ambiguous.runtime.runs.bindVendorRef(claim, "second-execution", JSON.stringify({ ...ambiguous.reference, executionID: "second-execution" }))
      expect(await ambiguous.runtime.host.reconcile(ambiguous.reference)).toMatchObject({ outcome: "unknown", quiescent: false })
    } finally { ambiguous.cleanup() }
  })

  it("preserves shell process-risk fences, including risk added during transcript reads", async () => {
    const alreadyRisky = recoveryHarness()
    try {
      alreadyRisky.runtime.runs.markProcessRiskBySession(VENDOR_SESSION_ID)
      expect(await alreadyRisky.runtime.host.reconcile(alreadyRisky.reference)).toMatchObject({ outcome: "terminal", quiescent: false })
    } finally { alreadyRisky.cleanup() }

    const duringRead = recoveryHarness()
    try {
      duringRead.responses.messages = async () => {
        const response = { data: completeTranscript() }
        duringRead.runtime.runs.markProcessRiskBySession(VENDOR_SESSION_ID)
        return response
      }
      expect(await duringRead.runtime.host.reconcile(duringRead.reference)).toMatchObject({ outcome: "terminal", quiescent: false })
    } finally { duringRead.cleanup() }
  })
})
