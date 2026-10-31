import { test } from "bun:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliHost } from "../src/hosts/cli-host.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
async function memoryCancellationProbe(): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "otter-arch-memory-")))
  mkdirSync(join(root, "knowledge/wiki/concepts"), { recursive: true })
  writeFileSync(join(root, "knowledge/wiki/index.md"), "- [Fixture](concepts/test.md) — testing\n")
  writeFileSync(join(root, "knowledge/wiki/concepts/test.md"), "# Test\nfixture\n")
  const snapshot = Object.freeze({
    id: "policy-main", role: "main", model: Object.freeze({ providerID: "local", modelID: "fixture-model" }),
    maxOutputTokens: 20000,
    tools: Object.freeze({ allowed: Object.freeze(["read", "memory"]), denied: Object.freeze([]) }),
    system: Object.freeze(["fixed main constraint"]), thinking: "inherit",
  })
  const handlers = {
    beforeTool: () => ({ allow: true }),
    toolResult: (event: any) => event.error === undefined ? { result: event.result } : { error: event.error },
    assistantText: () => ({ cancel: false }),
  }
  const policy = {
    resolve: () => snapshot, handlers: () => handlers,
    bindSession() {}, unbindSession() {}, handlersForSession() {}, snapshotForSession() {},
  }
  const state = {
    generation: 7,
    claim: { ownerSession: "owner", instance: "fixture", pid: process.pid, generation: 7 },
    executions: [{
      executionId: "execution", ownerSession: "owner", taskId: "task", attemptId: "attempt", generation: 7,
      role: "main", cwd: root, policyID: "policy-main", kind: "host", engine: "local", profile: "legacy-unowned",
      controlProfile: "estimated-input-reactive-output-v1",
    }],
  }
  let release = () => {}
  let observedSignal: AbortSignal | undefined
  let markStarted = () => {}
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const originalFetch = globalThis.fetch
  let startTimer: ReturnType<typeof setTimeout> | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<unknown> | undefined
  // The real memory tool and recall path run; only HTTP is held in-process.
  globalThis.fetch = (async (_url: unknown, options: any) => {
    observedSignal = options.signal
    markStarted()
    return await new Promise<Response>((resolve, reject) => {
      release = () => resolve(Response.json({}))
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
    })
  }) as any
  try {
    const host = createCliHost({
      engine: "local", model: "fixture-model", policy: policy as any, runs: { status: () => state } as any,
      loadMemory: () => ({ ...DEFAULT_CONFIG.memory, engine: "jev", prefetch: false, timeout_ms: 10000 }),
      createTransport: options => {
        let finished = false
        return {
          async run() {
            const text = JSON.stringify({ type: "tool", name: "memory", input: { query: "testing fixture" } })
            options.onText?.(text)
            finished = true
            return { status: "completed", text, quiescent: true }
          },
          async requestCancel() {
            return { requested: true, acknowledged: true, terminal: finished, quiescent: finished, evidence: "fixture" }
          },
          async reconcile() {
            return { outcome: finished ? "terminal" : "running", quiescent: finished, evidence: "fixture" }
          },
        }
      },
    })
    const handle = await host.prepare({
      executionID: "execution", supervisorSessionID: "owner", taskID: "task", attemptID: "attempt", generation: 7,
      role: "main", title: "probe", cwd: root, text: "Recall memory", deadlineAt: Date.now() + 10000,
      policy: snapshot, handlers,
    } as any)
    running = handle.run()
    let settled = false
    void running.then(() => { settled = true })
    await Promise.race([
      started,
      new Promise((_, reject) => { startTimer = setTimeout(() => reject(Error("memory did not start")), 2000) }),
    ])
    clearTimeout(startTimer)
    const cancellation = await handle.requestCancel("cancel probe", Date.now() + 1000)
    const final = await Promise.race([
      running,
      new Promise((_, reject) => { settleTimer = setTimeout(() => reject(Error("cancelled memory did not settle")), 1000) }),
    ])
    clearTimeout(settleTimer)
    const reconciliation = await handle.reconcile()
    assert.equal(cancellation.acknowledged, true)
    assert.equal(observedSignal?.aborted, true)
    assert.equal(settled, true)
    assert.equal(reconciliation.quiescent, true)
    assert.equal((final as { status: string }).status, "cancelled")
  } finally {
    clearTimeout(settleTimer)
    clearTimeout(startTimer)
    release()
    if (running) await running.catch(() => {})
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
}


test("cancelling an active memory tool aborts inference and reaches quiescence", memoryCancellationProbe)
