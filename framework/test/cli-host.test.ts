import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliHost } from "../src/hosts/cli-host.ts"
import type { CliTransportHandle, CliTransportOptions } from "../src/hosts/cli-transport.ts"
import type { ExecutionPolicy, ExecutionPolicyHandlers, ExecutionRequest, ExecutionRole } from "../src/hosts/types.ts"
import type { ExecutionRunStore, ExecutionRunStatus } from "../src/hosts/run-state.ts"
import { estimateTokens } from "../src/tokens.ts"
import { CODEX_INSTRUCTIONS, createCodexProfile } from "../src/hosts/codex-profile.ts"

const CONTROL_PROFILE = "estimated-input-reactive-output-v1" as const
const ALL_TOOLS = ["read", "list", "glob", "grep", "write", "edit"]
const OWNER = "test-owner"
const EXECUTION = "test-execution"
const WORKER_INPUT_LIMIT = 5120
const HISTORY_TRUNCATION_MARKER = "\n[older tool output truncated to fit the estimated input budget]"

type HistoryEntry = { assistant: string; ok: boolean; result: string }

function estimatedTokens(text: string): number {
  return 64 + estimateTokens(text)
}

function historyPrompt(base: string, history: readonly HistoryEntry[]): string {
  if (history.length === 0) return base
  const transcript = history.map((entry, index) =>
    `Exchange ${index + 1}\nAssistant tool envelope: ${entry.assistant}\nLCA tool result: ${JSON.stringify({ ok: entry.ok, [entry.ok ? "result" : "error"]: entry.result })}`,
  ).join("\n\n")
  return `${base}\n\nEarlier tool transcript:\n${transcript}`
}

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lca-cli-host-")) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

type HarnessOptions = {
  engine?: "local" | "codex" | "claude"
  role?: ExecutionRole
  responses?: string[]
  taskText?: string
  maxOutputTokens?: number
  denyTool?: boolean
  cancelAssistant?: boolean
  afterNativeTurn?: () => void
  transportBehavior?: "normal" | "unresolved" | "throw"
  omitPreflight?: boolean
  preflightCompatible?: boolean
  preflightNonQuiescent?: boolean
  preflightPolicyHash?: string
  nativeContextIdentity?: string
  cancelRequestAccepted?: boolean
  cancelRequestDelayMs?: number
  deferTransportRun?: boolean
  beforeOutput?: () => void
}

function harness(options: HarnessOptions = {}) {
  const engine = options.engine ?? "local"
  const role = options.role ?? "worker"
  const model = engine === "codex" ? "gpt-5.6-sol" : "fixture-model"
  const codexProfile = engine === "codex" ? createCodexProfile(model) : undefined
  const executionID = `${EXECUTION}-${engine}-${role}`
  const taskID = "task"
  const attemptID = "attempt"
  const generation = 7
  const policyID = `policy-${role}`
  const snapshot = Object.freeze({
    id: policyID,
    role,
    model: Object.freeze({ providerID: engine, modelID: model }),
    maxOutputTokens: options.maxOutputTokens ?? 20_000,
    tools: Object.freeze({ allowed: Object.freeze([...ALL_TOOLS]), denied: Object.freeze([] as string[]) }),
    system: Object.freeze([`fixed ${role} constraint`]),
    ...(codexProfile ? { nativeContext: Object.freeze({
      identity: options.nativeContextIdentity ?? codexProfile.catalogHash,
      instructions: codexProfile.instructions,
    }) } : {}),
    thinking: "inherit" as const,
  })
  let allowBeforeTool = !options.denyTool
  let preflightCompatible = options.preflightCompatible ?? true
  let preflightQuiescent = !options.preflightNonQuiescent
  let beforeOutput = options.beforeOutput
  let releaseTransportRun: (() => void) | undefined
  const transportRunGate = options.deferTransportRun ? new Promise<void>(resolve => { releaseTransportRun = resolve }) : undefined
  let onToolResult = (): void => {}
  let afterNativeTurn = options.afterNativeTurn
  const observed = { before: 0, results: 0, assistant: 0 }
  const handlers: ExecutionPolicyHandlers = {
    beforeTool(event) {
      observed.before++
      expect(event.sessionID).toBe(executionID)
      return allowBeforeTool ? { allow: true } : { allow: false, reason: "private denial reason" }
    },
    toolResult(event) {
      observed.results++
      onToolResult()
      return event.error === undefined ? { result: event.result } : { error: event.error }
    },
    assistantText() {
      observed.assistant++
      return { cancel: !!options.cancelAssistant }
    },
  }
  const policy = {
    resolve: () => snapshot,
    handlers: () => handlers,
    bindSession() {},
    unbindSession() {},
    handlersForSession: () => undefined,
    snapshotForSession: () => undefined,
  } as unknown as ExecutionPolicy

  const intent = {
    executionId: executionID,
    ownerSession: OWNER,
    taskId: taskID,
    attemptId: attemptID,
    generation,
    role,
    cwd: root,
    policyID,
    kind: "host" as const,
    engine,
    profile: "legacy-unowned" as const,
    controlProfile: CONTROL_PROFILE,
  }
  let state: ExecutionRunStatus = {
    generation,
    claim: { ownerSession: OWNER, instance: "test-instance", pid: process.pid, generation },
    executions: [intent],
  }
  const runs = { status: () => state } as unknown as ExecutionRunStore
  const prompts: string[] = []
  const controls: Array<{ cancelCalls: number; runCalls: number; reconcileCalls: number; preflightCalls: number }> = []
  const responses = [...(options.responses ?? [])]
  const createTransport = (transportOptions: CliTransportOptions): CliTransportHandle => {
    prompts.push(transportOptions.prompt)
    const control = { cancelCalls: 0, runCalls: 0, reconcileCalls: 0, preflightCalls: 0 }
    controls.push(control)
    const isFirstTransport = controls.length === 1
    let started = false
    let preflightStarted = false
    let finished = false
    const transport: CliTransportHandle = {
      async run() {
        started = true
        control.runCalls++
        await transportRunGate
        const response = responses.shift() ?? "{}"
        if (options.transportBehavior === "throw") throw new Error("fixture run failed")
        if (options.transportBehavior === "unresolved") return { status: "unresolved", text: response, quiescent: false }
        try {
          beforeOutput?.()
          transportOptions.onText?.(response)
        }
        catch {
          finished = true
          return { status: "failed", text: response, quiescent: true, error: "fixture callback refused" }
        }
        afterNativeTurn?.()
        finished = true
        return { status: "completed", text: response, quiescent: true }
      },
      async requestCancel() {
        control.cancelCalls++
        if (options.cancelRequestAccepted === false) {
          return { requested: false, acknowledged: false, terminal: false, quiescent: false, evidence: "fixture refused cancellation" }
        }
        if (preflightStarted && !started) {
          return {
            requested: true,
            acknowledged: true,
            terminal: preflightQuiescent,
            quiescent: preflightQuiescent,
            evidence: preflightQuiescent ? "fixture version probe quiescent" : "fixture version probe remains active",
          }
        }
        if (!started) {
          finished = true
          return { requested: true, acknowledged: true, terminal: true, quiescent: true, evidence: "fixture cancellation prevented launch" }
        }
        if (options.transportBehavior === "unresolved" || options.transportBehavior === "throw") {
          finished = true
          return { requested: true, acknowledged: true, terminal: false, quiescent: false, evidence: "fixture cancellation acknowledged; quiescence pending" }
        }
        if (options.cancelRequestDelayMs) await new Promise(resolve => setTimeout(resolve, options.cancelRequestDelayMs))
        return { requested: true, acknowledged: true, terminal: finished, quiescent: finished, evidence: "fixture current process cancelled" }
      },
      async reconcile() {
        control.reconcileCalls++
        if (preflightStarted && !started) {
          return {
            outcome: preflightQuiescent ? "terminal" : "unknown",
            quiescent: preflightQuiescent,
            evidence: preflightQuiescent ? "fixture version probe quiescent" : "fixture version probe remains active",
          }
        }
        if (!started) return { outcome: "terminal", quiescent: true, evidence: "fixture has not launched" }
        if (options.transportBehavior === "unresolved" || options.transportBehavior === "throw") {
          return { outcome: finished ? "terminal" : "unknown", quiescent: finished, evidence: "fixture current process state" }
        }
        return { outcome: finished ? "terminal" : "running", quiescent: finished, evidence: "fixture current process state" }
      },
    }
    if (engine === "codex" && !options.omitPreflight) {
      transport.preflight = async () => {
        control.preflightCalls++
        preflightStarted = options.preflightNonQuiescent === true && isFirstTransport
        return {
          compatible: preflightCompatible,
          nativePolicyHash: options.preflightPolicyHash ?? codexProfile?.catalogHash,
        }
      }
    }
    return transport
  }
  const host = createCliHost({ engine, model, policy, runs, createTransport })
  const request: ExecutionRequest = {
    executionID,
    supervisorSessionID: OWNER,
    taskID,
    attemptID,
    generation,
    role,
    title: "Implement scoped fixture",
    cwd: root,
    text: options.taskText ?? "Create the requested file using only local tools.",
    deadlineAt: Date.now() + 10_000,
    policy: snapshot,
    handlers,
  }
  return {
    host,
    request,
    prompts,
    controls,
    observed,
    get state() { return state },
    set state(value: ExecutionRunStatus) { state = value },
    set allowBeforeTool(value: boolean) { allowBeforeTool = value },
    set preflightCompatible(value: boolean) { preflightCompatible = value },
    set preflightQuiescent(value: boolean) { preflightQuiescent = value },
    set beforeOutput(value: (() => void) | undefined) { beforeOutput = value },
    releaseTransportRun() { releaseTransportRun?.(); releaseTransportRun = undefined },
    set onToolResult(value: () => void) { onToolResult = value },
    set afterNativeTurn(value: () => void) { afterNativeTurn = value },
  }
}

const toolWrite = (path: string, content: string): string => JSON.stringify({
  type: "tool", name: "write", input: { path, content },
})

describe("common CLI execution host", () => {
  test("preflight uses the injected transport factory without running inference", async () => {
    const subject = harness({ responses: [JSON.stringify({ type: "final", text: "still available" })] })
    const preflight = await subject.host.preflight(subject.host.identity.profile)
    expect(preflight.compatible).toBe(true)
    expect(subject.prompts).toEqual([""])
    expect(subject.controls[0]?.runCalls).toBe(0)

    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "completed", text: "still available" })
    expect(subject.controls[1]?.runCalls).toBe(1)
  })

  test("Codex admission requires an exact transport profile probe and carries native instructions outside the prompt", async () => {
    const missing = harness({ engine: "codex", omitPreflight: true })
    const missingPreflight = await missing.host.preflight(missing.host.identity.profile)
    expect(missingPreflight.compatible).toBe(false)
    expect(missingPreflight.controls.preExecutionToolPolicy).toBe("unsupported")
    expect(missing.controls[0]?.runCalls).toBe(0)

    const mismatched = harness({ engine: "codex", preflightPolicyHash: "wrong-profile-hash" })
    const mismatchedPreflight = await mismatched.host.preflight(mismatched.host.identity.profile)
    expect(mismatchedPreflight.compatible).toBe(false)
    expect(mismatchedPreflight.controls.preExecutionToolPolicy).toBe("unsupported")
    expect(mismatched.controls[0]?.runCalls).toBe(0)

    const mismatchedRun = harness({
      engine: "codex",
      preflightPolicyHash: "wrong-profile-hash",
      responses: [JSON.stringify({ type: "final", text: "must not dispatch" })],
    })
    const mismatchedHandle = await mismatchedRun.host.prepare(mismatchedRun.request)
    expect(await mismatchedHandle.run()).toMatchObject({ status: "failed" })
    expect(mismatchedRun.controls[0]?.runCalls).toBe(0)

    const subject = harness({
      engine: "codex",
      responses: [JSON.stringify({ type: "final", text: "Codex profile admitted" })],
    })
    const preflight = await subject.host.preflight(subject.host.identity.profile)
    expect(preflight.compatible).toBe(true)
    expect(preflight.controls.preExecutionToolPolicy).toBe("supported")
    expect(subject.controls[0]?.runCalls).toBe(0)

    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "completed", text: "Codex profile admitted" })
    expect(subject.controls[1]?.preflightCalls).toBe(1)
    expect(subject.controls[1]?.runCalls).toBe(1)
    expect(subject.prompts[0]).not.toContain(CODEX_INSTRUCTIONS)
    expect(estimatedTokens(subject.prompts[0]!) + estimateTokens(CODEX_INSTRUCTIONS)).toBeLessThanOrEqual(WORKER_INPUT_LIMIT)
  })

  test("Codex fixed policy refuses a native context that does not match the admitted catalog", async () => {
    const subject = harness({ engine: "codex", nativeContextIdentity: "changed-catalog-hash" })
    await expect(subject.host.prepare(subject.request)).rejects.toThrow("Codex native context does not match the bound profile")
    expect(subject.prompts).toEqual([])
  })

  test("Codex profile is rechecked before every native inference round", async () => {
    const subject = harness({ engine: "codex", responses: [toolWrite("codex-round.txt", "done"), JSON.stringify({ type: "final", text: "done" })] })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "completed", text: "done" })
    expect(subject.controls).toHaveLength(2)
    expect(subject.controls.map(control => control.preflightCalls)).toEqual([1, 1])
    expect(subject.controls.map(control => control.runCalls)).toEqual([1, 1])
    expect(readFileSync(join(root, "codex-round.txt"), "utf8")).toBe("done")
    expect(subject.prompts.every(prompt => !prompt.includes(CODEX_INSTRUCTIONS) &&
      estimatedTokens(prompt) + estimateTokens(CODEX_INSTRUCTIONS) <= WORKER_INPUT_LIMIT)).toBe(true)
  })

  test("unresolved Codex preflight remains owned until quiescent, then admission recovers", async () => {
    const subject = harness({
      engine: "codex",
      preflightCompatible: false,
      preflightNonQuiescent: true,
      responses: [JSON.stringify({ type: "final", text: "recovered" })],
    })
    const preflight = await subject.host.preflight(subject.host.identity.profile)
    expect(preflight.compatible).toBe(false)
    expect(subject.controls[0]?.cancelCalls).toBe(1)

    await expect(subject.host.prepare(subject.request)).rejects.toThrow("unresolved Codex preflight process; model dispatch refused")
    expect(subject.controls[0]?.cancelCalls).toBe(2)
    expect(subject.controls[0]?.runCalls).toBe(0)

    subject.preflightQuiescent = true
    subject.preflightCompatible = true
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "completed", text: "recovered" })
    expect(subject.controls[1]?.preflightCalls).toBe(1)
    expect(subject.controls[1]?.runCalls).toBe(1)
  })

  test("host cancellation does not cancel on an expired, invalid, or transport-refused request", async () => {
    const beforeRun = harness({ responses: [JSON.stringify({ type: "final", text: "still runs" })] })
    const beforeRunHandle = await beforeRun.host.prepare(beforeRun.request)
    await expect(beforeRunHandle.requestCancel("expired", Date.now() - 1)).resolves.toMatchObject({ requested: false })
    await expect(beforeRunHandle.requestCancel("invalid", Number.NaN)).rejects.toThrow("invalid CLI cancellation request")
    expect(await beforeRunHandle.run()).toEqual({ status: "completed", text: "still runs" })

    const active = harness({
      responses: [JSON.stringify({ type: "final", text: "still runs" })],
      deferTransportRun: true,
      cancelRequestAccepted: false,
    })
    const activeHandle = await active.host.prepare(active.request)
    const running = activeHandle.run()
    expect(active.controls[0]?.runCalls).toBe(1)
    await expect(activeHandle.requestCancel("expired active", Date.now() - 1)).resolves.toMatchObject({ requested: false })
    expect(active.controls[0]?.cancelCalls).toBe(0)
    await expect(activeHandle.requestCancel("refused", Date.now() + 1000)).resolves.toMatchObject({ requested: false })
    active.releaseTransportRun()
    expect(await running).toEqual({ status: "completed", text: "still runs" })
  })

  test("accepted host cancellation remains effective when its acknowledgement arrives after the requested deadline", async () => {
    const active = harness({
      responses: [JSON.stringify({ type: "final", text: "must be cancelled" })],
      deferTransportRun: true,
      cancelRequestDelayMs: 40,
    })
    const handle = await active.host.prepare(active.request)
    const running = handle.run()
    const deadlineAt = Date.now() + 10
    const cancellation = await handle.requestCancel("accepted before deadline", deadlineAt)
    expect(Date.now()).toBeGreaterThan(deadlineAt)
    expect(cancellation.requested).toBe(true)
    active.releaseTransportRun()
    expect(await running).toMatchObject({ status: "cancelled" })
  })

  test("lease change during streamed assistant output uses the lease-changed outcome", async () => {
    const subject = harness({ responses: [JSON.stringify({ type: "final", text: "must not be accepted" })] })
    subject.beforeOutput = () => {
      const state = subject.state
      subject.state = { ...state, generation: state.generation + 1 }
    }
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "failed", error: "current execution lease changed; execution stopped" })
  })

  test("local and Claude use the same repeatable LCA tool loop and preserve final text", async () => {
    const finalText = " {\"plan\":true}\n"
    for (const engine of ["local", "claude"] as const) {
      const subject = harness({ engine, responses: [toolWrite(`result-${engine}.txt`, "done"), JSON.stringify({ type: "final", text: finalText })] })
      const handle = await subject.host.prepare(subject.request)
      const outcome = await handle.run()
      expect(outcome).toEqual({ status: "completed", text: finalText })
      expect(readFileSync(join(root, `result-${engine}.txt`), "utf8")).toBe("done")
      expect(subject.prompts).toHaveLength(2)
      expect(subject.prompts[0]).toContain("fixed worker constraint")
      expect(subject.prompts[0]).toContain('"oldText": nonempty exact')
      expect(subject.prompts[1]).toContain('"type":"tool","name":"write"')
      expect(subject.prompts.every(prompt => prompt.endsWith("Never return a bare plan, verdict, or prose outside the envelope."))).toBe(true)
      expect(subject.observed.before).toBe(1)
      expect(subject.observed.results).toBe(1)
    }
  })

  test("final text can contain reviewer JSON and is returned unchanged without another tool turn", async () => {
    const finalText = '{"verdict":"REJECT","reason":"needs a fix"}\n'
    const subject = harness({ role: "reviewer", responses: [JSON.stringify({ type: "final", text: finalText })] })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "completed", text: finalText })
    expect(subject.prompts).toHaveLength(1)
    expect(subject.observed.before).toBe(0)
  })

  test("a single deterministic JSON fence is accepted and the LCA byte cap remains reactive", async () => {
    const fenced = harness({ responses: ['```json\n{"type":"final","text":"fenced result"}\n```'] })
    const fencedHandle = await fenced.host.prepare(fenced.request)
    expect(await fencedHandle.run()).toEqual({ status: "completed", text: "fenced result" })

    const capped = harness({ maxOutputTokens: 1, responses: [JSON.stringify({ type: "final", text: "too much output" })] })
    const cappedHandle = await capped.host.prepare(capped.request)
    expect(await cappedHandle.run()).toMatchObject({ status: "failed" })
    expect(capped.controls[0]?.cancelCalls).toBeGreaterThan(0)
  })

  test("malformed and unknown model tool envelopes fail closed without fallback execution", async () => {
    for (const response of ["Here is the answer: {\"type\":\"final\",\"text\":\"done\"}",
      '{"goal":"bare plan","steps":[],"risks":[]}',
      '{"type":"tool","name":"bash","input":{"command":"touch unsafe"}}']) {
      const subject = harness({ responses: [response] })
      const handle = await subject.host.prepare(subject.request)
      expect(await handle.run()).toMatchObject({ status: "failed" })
      expect(subject.observed.before).toBe(0)
      expect(existsSync(join(root, "unsafe"))).toBe(false)
      expect(subject.prompts).toHaveLength(1)
    }
  })

  test("read-only roles and beforeTool policy deny writes before effects", async () => {
    const readonly = harness({ role: "reviewer", responses: [toolWrite("reviewer-write.txt", "blocked")] })
    const readonlyHandle = await readonly.host.prepare(readonly.request)
    expect(await readonlyHandle.run()).toMatchObject({ status: "failed" })
    expect(existsSync(join(root, "reviewer-write.txt"))).toBe(false)
    expect(readonly.observed.before).toBe(0)

    const denied = harness({ responses: [toolWrite("policy-write.txt", "blocked")], denyTool: true })
    const deniedHandle = await denied.host.prepare(denied.request)
    expect(await deniedHandle.run()).toMatchObject({ status: "failed" })
    expect(denied.observed.before).toBe(1)
    expect(existsSync(join(root, "policy-write.txt"))).toBe(false)
  })

  test("missing or changed lease after inference prevents the pending tool effect", async () => {
    for (const change of ["missing", "changed"] as const) {
      const subject = harness({ responses: [toolWrite(`${change}.txt`, "blocked")] })
      subject.afterNativeTurn = () => {
        const state = subject.state
        if (change === "missing") subject.state = { ...state, claim: undefined }
        else subject.state = { ...state, generation: state.generation + 1 }
      }
      const handle = await subject.host.prepare(subject.request)
      expect(await handle.run()).toMatchObject({ status: "failed" })
      expect(existsSync(join(root, `${change}.txt`))).toBe(false)
    }
  })

  test("input estimate rejects an oversized mandatory task without native dispatch", async () => {
    const subject = harness({ taskText: "x".repeat(40_000), responses: [JSON.stringify({ type: "final", text: "unexpected" })] })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toMatchObject({ status: "failed", error: expect.stringContaining("estimated input budget") })
    expect(subject.prompts).toHaveLength(0)
  })

  test("history truncation makes monotonic progress and prunes exchanges without dropping the task", async () => {
    const probe = harness({ taskText: "", responses: [JSON.stringify({ type: "final", text: "probe" })] })
    const probeHandle = await probe.host.prepare(probe.request)
    expect(await probeHandle.run()).toEqual({ status: "completed", text: "probe" })
    const fixedBase = probe.prompts[0]!
    const readAssistant = JSON.stringify({ type: "tool", name: "read", input: { path: "payload.txt" } })
    const listAssistant = JSON.stringify({ type: "tool", name: "list", input: { path: "." } })
    const grepAssistant = JSON.stringify({ type: "tool", name: "grep", input: { pattern: "not-present", path: "." } })
    const firstExchange = { assistant: readAssistant, ok: true, result: HISTORY_TRUNCATION_MARKER }
    const secondExchange = { assistant: listAssistant, ok: true, result: '[{"name":"payload.txt","type":"file"}]' }
    let low = 0
    let high = WORKER_INPUT_LIMIT * 4
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const base = `${fixedBase}${"x".repeat(middle)}`
      if (estimatedTokens(historyPrompt(base, [firstExchange, secondExchange])) <= WORKER_INPUT_LIMIT) low = middle
      else high = middle - 1
    }
    const taskText = "x".repeat(low)
    const base = `${fixedBase}${taskText}`
    expect(estimatedTokens(base)).toBeLessThanOrEqual(WORKER_INPUT_LIMIT)
    expect(estimatedTokens(historyPrompt(base, [firstExchange, secondExchange]))).toBeLessThanOrEqual(WORKER_INPUT_LIMIT)
    expect(estimatedTokens(historyPrompt(base, [firstExchange, secondExchange, { assistant: grepAssistant, ok: true, result: "" }]))).toBeGreaterThan(WORKER_INPUT_LIMIT)

    writeFileSync(join(root, "payload.txt"), "p".repeat(16_384))
    const subject = harness({ taskText, responses: [
      JSON.stringify({ type: "tool", name: "read", input: { path: "payload.txt" } }),
      JSON.stringify({ type: "tool", name: "list", input: { path: "." } }),
      JSON.stringify({ type: "tool", name: "grep", input: { pattern: "not-present", path: "." } }),
      JSON.stringify({ type: "final", text: "pruned history retained the task" }),
    ] })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toEqual({ status: "completed", text: "pruned history retained the task" })
    expect(subject.prompts).toHaveLength(4)
    expect(subject.prompts.every(prompt => prompt.includes(`User task (preserve all content and constraints):\n\n${taskText}`))).toBe(true)
    expect(subject.prompts.every(prompt => prompt.includes("fixed worker constraint") &&
      prompt.includes("Execution title (preserve this constraint):") && prompt.includes("Input estimate limit:"))).toBe(true)
    expect(subject.prompts.every(prompt => estimatedTokens(prompt) <= WORKER_INPUT_LIMIT)).toBe(true)
    expect(subject.prompts[3]).toContain("[earlier tool exchanges omitted to fit the estimated input budget]")
  })

  test("unresolved and thrown native turns retain owned transports for late cancellation and reconciliation", async () => {
    for (const transportBehavior of ["unresolved", "throw"] as const) {
      const subject = harness({
        transportBehavior,
        responses: [JSON.stringify({ type: "final", text: "must not replay" })],
      })
      const handle = await subject.host.prepare(subject.request)
      expect(await handle.run()).toMatchObject({ status: "unresolved" })
      const control = subject.controls[0]!

      const reconcileCallsBefore = control.reconcileCalls
      expect(await subject.host.reconcile(handle.reference)).toMatchObject({ outcome: "unknown", quiescent: false })
      expect(control.reconcileCalls).toBe(reconcileCallsBefore + 1)

      const cancelResult = await handle.requestCancel("recover owned process", Date.now() + 1000)
      expect(cancelResult).toMatchObject({ requested: true, acknowledged: true, quiescent: false })
      expect(control.cancelCalls).toBe(1)

      const lateReconcileCalls = control.reconcileCalls
      expect(await subject.host.reconcile(handle.reference)).toMatchObject({ outcome: "terminal", quiescent: true })
      expect(control.reconcileCalls).toBe(lateReconcileCalls + 1)
      expect(await subject.host.reconcile(handle.reference)).toMatchObject({ outcome: "terminal", quiescent: true })
      expect(control.reconcileCalls).toBe(lateReconcileCalls + 1)
      expect(control.runCalls).toBe(1)
      expect(subject.prompts).toHaveLength(1)
    }
  })

  test("cancellation between tool rounds prevents another native turn", async () => {
    const subject = harness({ responses: [toolWrite("cancelled-round.txt", "written")] })
    const handle = await subject.host.prepare(subject.request)
    subject.onToolResult = () => { void handle.requestCancel("fixture stop", Date.now() + 1000) }
    expect(await handle.run()).toMatchObject({ status: "cancelled" })
    expect(subject.prompts).toHaveLength(1)
    expect(readFileSync(join(root, "cancelled-round.txt"), "utf8")).toBe("written")
  })

  test("assistant-text policy cancellation reaches the current owned transport", async () => {
    const subject = harness({ responses: [JSON.stringify({ type: "final", text: "ignored" })], cancelAssistant: true })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toMatchObject({ status: "cancelled" })
    expect(subject.controls[0]?.cancelCalls).toBeGreaterThan(0)
    expect(subject.observed.before).toBe(0)
  })

  test("transport JSON parsing rejects duplicate-key or multi-envelope ambiguity", async () => {
    const subject = harness({ responses: [
      '{"type":"final","type":"tool","name":"write","input":{"path":"bad.txt","content":"x"}}',
    ] })
    const handle = await subject.host.prepare(subject.request)
    expect(await handle.run()).toMatchObject({ status: "failed" })
    expect(existsSync(join(root, "bad.txt"))).toBe(false)
  })

  test("recovery never replays or signals a persisted execution reference", async () => {
    const subject = harness({ responses: [JSON.stringify({ type: "final", text: "done" })] })
    const result = await subject.host.reconcile({ executionID: "not-owned-here" })
    expect(result).toEqual({ outcome: "unknown", quiescent: false, evidence: "no current owned CLI process evidence; replay is refused" })
    expect(subject.prompts).toHaveLength(0)
  })
})
