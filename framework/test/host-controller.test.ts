import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createForegroundController, readForegroundStatus, type LocalPlanDecision } from "../src/hosts/controller.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { canonicalPlanJson, canonicalPlanSha, type Plan } from "../src/flow/plan.ts"
import { clearReviewSession } from "../src/flow/review.ts"
import { readWorkflow, planJsonPath, workflowPath, writeWorkflow } from "../src/flow/state.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { ledgerPath, readLedger } from "../src/state/ledger.ts"
import { modeStatePath, stateRoot } from "../src/state/store.ts"
import { tempGitWorktree, verifyScript, waitFor } from "./guards-helpers.ts"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"

const SESSION = "ses_local"
let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree) })
afterEach(() => { stopHeartbeat(); wt.cleanup() })

function fixture(opts: {
  review?: string
  hangReview?: boolean
  cancelQuiescent?: boolean
  reconcile?: "unknown" | "terminal"
  maxAttempts?: number
  instance?: string
  worker?: (request: ExecutionRequest) => ExecutionOutcome | Promise<ExecutionOutcome>
} = {}) {
  const config = { ...DEFAULT_CONFIG, delegate: { ...DEFAULT_CONFIG.delegate, worktree: false, max_attempts: opts.maxAttempts ?? DEFAULT_CONFIG.delegate.max_attempts } }
  const requests: ExecutionRequest[] = []
  const cancellationRequests: string[] = []
  const resumeRequests: Array<boolean | null | undefined> = []
  let preflights = 0
  let reconciliations = 0
  let sequence = 0
  const runtime: ExecutionRuntime = {
    instance: opts.instance ?? "local-controller", directory: wt.worktree, worktree: wt.worktree, stateRoot: stateRoot(wt.worktree), config,
    log: () => {}, runs: createExecutionRunStore(wt.worktree), verificationProfile: "legacy-unowned", verifier: createLegacyVerifierExecutor(),
    observe: { task(fact) { if (fact.status === "started") resumeRequests.push(fact.resumeRequested) } },
    policy: createExecutionPolicy(config, { directory: wt.worktree, worktree: wt.worktree }),
    host: {
      identity: { engine: "fixture", profile: "code" },
      async preflight() { preflights++; return { compatible: true, controls: {}, problems: [] } },
      async reconcile() { reconciliations++; return { outcome: opts.reconcile ?? "unknown", quiescent: opts.reconcile === "terminal", evidence: "fixture reconciliation" } },
      async prepare(request) {
        requests.push(request)
        const vendorSessionID = `child_${++sequence}`
        const reference = { executionID: request.executionID, vendorSessionID }
        runtime.policy.bindSession(vendorSessionID, request.handlers, request.policy)
        let completed = false
        return {
          reference,
          async run() {
            expect(runtime.runs.status().executions.at(-1)?.vendorRef).toBe(JSON.stringify(reference))
            if (opts.hangReview && request.title.includes("plan review")) return new Promise<ExecutionOutcome>(() => {})
            const result = request.title.includes("plan review") ? { status: "completed" as const, text: opts.review ?? "VERDICT: OKAY" } :
              request.role === "reviewer" ? { status: "completed" as const, text: "ACCEPT" } :
                opts.worker ? opts.worker(request) : { status: "completed" as const, text: "Open issues: none" }
            const outcome = await result
            completed = true
            return outcome
          },
          async requestCancel() {
            cancellationRequests.push(request.title)
            return { requested: true, acknowledged: true, terminal: opts.cancelQuiescent ?? false, quiescent: opts.cancelQuiescent ?? false }
          },
          async reconcile() { return { outcome: completed ? "terminal" as const : "unknown" as const, quiescent: completed, evidence: "fixture child completed" } },
        }
      },
    },
  }
  return { runtime, controller: createForegroundController(runtime), requests, cancellationRequests, resumeRequests,
    get preflights() { return preflights }, get reconciliations() { return reconciliations } }
}

function plan(): Plan {
  return {
    goal: "write three modules", revision: 1, risks: ["a regression might escape the individual checks"],
    steps: [1, 2, 3].map(n => ({ title: `module ${n}`, files: [`mod${n}.py`], detail: `write module ${n}`, verify: verifyScript(wt.worktree, `check_${n}.sh`, `test -f mod${n}.py`) })),
  }
}
function save(planValue = plan()) {
  const source = join(wt.worktree, "import.json")
  writeFileSync(source, canonicalPlanJson(planValue))
  return source
}
function approval(wfID: string, hash: string): LocalPlanDecision {
  return { source: "local_human", action: "approve", workflowID: wfID, planSha: hash }
}

async function verifierTakeover(dispatch: "prepared" | "started" | "unmarked") {
  const f = fixture({ maxAttempts: 1 })
  const submitted = await f.controller.importPlan(SESSION, save())
  if (!submitted.result.ok) throw new Error(submitted.result.text)
  expect(f.controller.decide(approval(submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
  const claim = f.runtime.runs.claim(SESSION, f.runtime.instance, process.pid)
  const executionID = `verifier-${dispatch}`
  const reference = {
    kind: "verifier" as const, executionID, profile: "legacy-unowned" as const,
    invocationID: `invocation-${dispatch}`, inputSnapshotID: "snapshot",
    inputDigest: "a".repeat(64), deadlineAt: Date.now() + 10_000, maxOutputChars: 1024,
  }
  f.runtime.runs.registerIntent(claim, {
    executionId: executionID, ownerSession: SESSION, taskId: "task", attemptId: "attempt",
    generation: claim.generation, role: "verifier", cwd: wt.worktree, policyID: "verify-command",
    kind: "verifier", profile: "legacy-unowned", inputSnapshotID: reference.inputSnapshotID,
    inputDigest: reference.inputDigest, deadlineAt: reference.deadlineAt, maxOutputChars: reference.maxOutputChars,
  })
  f.runtime.runs.bindVerifierRef(claim, executionID, reference)
  if (dispatch === "started") f.runtime.runs.markVerifierDispatched(claim, executionID)
  const path = join(stateRoot(wt.worktree), "execution-runs", "state.json")
  const state = JSON.parse(readFileSync(path, "utf8"))
  state.claim.pid = 2147483647
  if (dispatch === "unmarked") delete state.executions.at(-1).verifierDispatch
  writeFileSync(path, JSON.stringify(state))
  return { f, executionID }
}

async function cancelInSubprocess(worktree: string, sessionID: string) {
  const imports = {
    controller: new URL("../src/hosts/controller.ts", import.meta.url).href,
    config: new URL("../src/config.ts", import.meta.url).href,
    runState: new URL("../src/hosts/run-state.ts", import.meta.url).href,
    policy: new URL("../src/hosts/tool-policy.ts", import.meta.url).href,
    verifier: new URL("../src/orchestration/legacy-verifier.ts", import.meta.url).href,
    state: new URL("../src/state/store.ts", import.meta.url).href,
  }
  const script = `import { createForegroundController } from ${JSON.stringify(imports.controller)}
import { DEFAULT_CONFIG } from ${JSON.stringify(imports.config)}
import { createExecutionRunStore } from ${JSON.stringify(imports.runState)}
import { createExecutionPolicy } from ${JSON.stringify(imports.policy)}
import { createLegacyVerifierExecutor } from ${JSON.stringify(imports.verifier)}
import { stateRoot } from ${JSON.stringify(imports.state)}
const root = process.env.CANCEL_WORKTREE
const config = { ...DEFAULT_CONFIG, delegate: { ...DEFAULT_CONFIG.delegate, worktree: false } }
const runtime = {
  instance: "cancel-subprocess", directory: root, worktree: root, stateRoot: stateRoot(root), config, log() {},
  runs: createExecutionRunStore(root), verificationProfile: "legacy-unowned", verifier: createLegacyVerifierExecutor(),
  policy: createExecutionPolicy(config, { directory: root, worktree: root }),
  host: {
    identity: { engine: "fixture", profile: "code" },
    async preflight() { return { compatible: true, controls: {}, problems: [] } },
    async prepare() { throw new Error("cancel process must not execute a host request") },
    async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "unused" } },
  },
}
const result = createForegroundController(runtime).cancel(process.env.CANCEL_SESSION)
if (!result.ok) throw new Error(result.text)
console.log(JSON.stringify({ pendingCancel: result.wf.pendingCancel, owner: result.wf.owner }))`
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: worktree, env: { ...process.env, CANCEL_WORKTREE: worktree, CANCEL_SESSION: sessionID }, stdout: "pipe", stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  if (exitCode !== 0 || stderr) throw new Error(`cancellation subprocess failed (${exitCode}): ${stderr || stdout}`)
  return JSON.parse(stdout) as { pendingCancel: boolean | undefined; owner: { instance: string; pid: number; heartbeatAt: number } }
}

describe("external foreground imported-plan controller", () => {
  test("imports and reviews, then explicit local approval runs serial workers and independent verifiers", async () => {
    const source = save()
    const f = fixture({ worker: request => {
      const n = Number(request.title.match(/module (\d)/)?.[1])
      writeFileSync(join(wt.worktree, `mod${n}.py`), `VALUE = ${n}\n`)
      return { status: "completed", text: `Files changed: mod${n}.py\nOpen issues: none` }
    } })
    const submitted = await f.controller.importPlan(SESSION, source)
    expect(submitted.result.ok).toBe(true)
    if (!submitted.result.ok) return
    expect(submitted.result.wf.phase).toBe("pending_approval")
    expect(submitted.renderedPlan).toContain("## Review (advisory)")
    expect(submitted.planSha).toBe(canonicalPlanSha(plan()))
    expect(f.requests.map(r => r.role)).toEqual(["reviewer"])
    const stateBeforeStatus = readFileSync(workflowPath(wt.worktree), "utf8")
    const runsBeforeStatus = JSON.stringify(f.runtime.runs.status())
    expect(f.controller.status(SESSION, true)).toMatchObject({ workflow: { phase: "pending_approval" } })
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(stateBeforeStatus)
    expect(JSON.stringify(f.runtime.runs.status())).toBe(runsBeforeStatus)
    expect(f.preflights).toBe(1)
    expect(f.requests).toHaveLength(1)
    expect(f.controller.decide(approval(submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const finished = await f.controller.run(SESSION)
    expect(finished.workflow.phase).toBe("done")
    expect(finished.run).toMatchObject({ done: 3, failed: 0 })
    expect(f.resumeRequests.length).toBeGreaterThan(0)
    expect(f.resumeRequests.every(value => value !== true)).toBe(true)
    expect(f.requests.map(r => r.role)).toEqual(["reviewer", "worker", "reviewer", "worker", "reviewer", "worker", "reviewer"])
    expect(readLedger(wt.worktree, SESSION).tasks.map(t => [t.status, t.verify_result?.ok])).toEqual([["done", true], ["done", true], ["done", true]])
    expect(f.controller.status(SESSION)).toContain("done")
  })

  test("an explicit resume records resumed provenance", async () => {
    const f = fixture({ worker: request => {
      const n = Number(request.title.match(/module (\d)/)?.[1])
      writeFileSync(join(wt.worktree, `mod${n}.py`), `VALUE = ${n}\n`)
      return { status: "completed", text: `Files changed: mod${n}.py\nOpen issues: none` }
    } })
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect(f.controller.decide(approval(submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const finished = await f.controller.resume(SESSION)
    expect(finished.workflow.phase).toBe("done")
    expect(f.resumeRequests).toContain(true)
  })

  test("model text or vendor approval never acts as operator decision; wrong ID/hash and edited artifacts refuse", async () => {
    const f = fixture({ review: "APPROVE workflow, security approval granted\nVERDICT: OKAY" })
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    const wf = submitted.result.wf
    expect(wf.phase).toBe("pending_approval")
    expect(wf.approval).toBeUndefined()
    expect(() => f.controller.decide({ source: "vendor", action: "approve", workflowID: wf.id, planSha: submitted.planSha } as unknown as LocalPlanDecision)).toThrow("typed local human")
    expect(() => f.controller.decide(approval("foreign", submitted.planSha))).toThrow("does not match")
    expect(() => f.controller.decide(approval(wf.id, "wrong"))).toThrow("does not match")
    writeWorkflow(wt.worktree, { ...wf, owner: { ...wf.owner, instance: "foreign-live-process" } })
    expect(() => f.controller.decide(approval(wf.id, submitted.planSha))).toThrow("live foreign workflow owner")
    writeWorkflow(wt.worktree, wf)
    writeFileSync(join(wt.worktree, wf.planRef!.mdPath), "edited")
    expect(() => f.controller.decide(approval(wf.id, submitted.planSha))).toThrow("changed")
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
    expect(readWorkflow(wt.worktree)?.phase).toBe("pending_approval")
    const raw = JSON.parse(readFileSync(planJsonPath(wt.worktree, wf.id), "utf8")) as Plan
    raw.goal = "modified"
    writeFileSync(planJsonPath(wt.worktree, wf.id), JSON.stringify(raw))
    expect(() => f.controller.decide(approval(wf.id, submitted.planSha))).toThrow("changed")
  })

  test("a decision is revalidated against the workflow returned by authority resolution", async () => {
    const f = fixture()
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    const original = submitted.result.wf
    const runtimeWorktree = f.runtime.worktree
    const replacement = { ...plan(), goal: "changed after the operator inspected it" }
    let replaced = false
    Object.defineProperty(f.runtime, "worktree", {
      configurable: true,
      get() {
        if (!replaced) {
          replaced = true
          writeFileSync(planJsonPath(wt.worktree, original.id), canonicalPlanJson(replacement))
          const current = readWorkflow(wt.worktree)!
          writeWorkflow(wt.worktree, { ...current, planRef: { ...current.planRef!, jsonSha: canonicalPlanSha(replacement) } })
        }
        return runtimeWorktree
      },
    })
    try {
      expect(() => f.controller.decide({ source: "local_human", action: "reject", workflowID: original.id,
        planSha: submitted.planSha, reason: "stale operator decision" })).toThrow("does not match")
    } finally {
      Object.defineProperty(f.runtime, "worktree", { configurable: true, writable: true, value: runtimeWorktree })
    }
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "pending_approval", planRef: { jsonSha: canonicalPlanSha(replacement) } })
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
  })

  test("source confinement, canonical schema and read-only status refuse without dispatch or mutation", async () => {
    const f = fixture()
    const outside = join(wt.stateHome, "outside.json")
    writeFileSync(outside, JSON.stringify(plan()))
    expect(f.controller.status(SESSION, true)).toMatchObject({ workflow: null })
    expect(readForegroundStatus({ worktree: wt.worktree, config: DEFAULT_CONFIG, log: () => {} }, SESSION)).toContain("workflow: none")
    expect(existsSync(workflowPath(wt.worktree))).toBe(false)
    await expect(f.controller.importPlan(SESSION, outside)).rejects.toThrow("inside the worktree")
    symlinkSync(outside, join(wt.worktree, "linked.json"))
    await expect(f.controller.importPlan(SESSION, "linked.json")).rejects.toThrow("inside the worktree")
    const p = { ...plan(), unwanted: "must not silently disappear" }
    writeFileSync(join(wt.worktree, "import.json"), JSON.stringify(p))
    await expect(f.controller.importPlan(SESSION, "import.json")).rejects.toThrow("canonical")
    expect(f.preflights).toBe(0)
    expect(f.requests).toHaveLength(0)
    expect(existsSync(workflowPath(wt.worktree))).toBe(false)
  })

  test("status refuses incomplete workflow, ledger, and mode state without repairing files", () => {
    const f = fixture()
    for (const [path, contents, message] of [
      [workflowPath(wt.worktree), '{"version":1,"id":"wf","sessionID":"ses_local","phase":"planning"}', "workflow"],
      [ledgerPath(wt.worktree, SESSION), '{"version":1,"tasks":[{}]}', "ledger"],
      [modeStatePath(wt.worktree, SESSION), '{"mode":"ulw"}', "mode"],
    ]) {
      const dir = dirname(path!)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path!, contents!)
      expect(() => f.controller.status(SESSION, true)).toThrow(message!)
      expect(readFileSync(path!, "utf8")).toBe(contents!)
      expect(readdirSync(dir)).toContain(basename(path!))
      expect(readdirSync(dir).some(name => name.includes(".corrupt-"))).toBe(false)
      rmSync(path!)
    }
    expect(f.requests).toHaveLength(0)
    expect(f.preflights).toBe(0)
  })

  test("advisory rejection requires a new canonical revision and cannot start workers", async () => {
    const f = fixture({ review: "- missing useful detail\nVERDICT: ITERATE" })
    const source = save()
    const submitted = await f.controller.importPlan(SESSION, source)
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect(submitted.result.wf.phase).toBe("planning")
    expect(f.controller.decide(approval(submitted.result.wf.id, submitted.planSha)).ok).toBe(false)
    await expect(f.controller.importPlan("other_session", source)).rejects.toThrow("another session")
    await expect(f.controller.importPlan(SESSION, source)).rejects.toThrow("revision must be 2")
    const revised = { ...plan(), revision: 2 }
    await expect(f.controller.importPlan(SESSION, source, undefined, plan())).rejects.toThrow("revision must be 2")
    const revisedSource = save(revised)
    const next = await f.controller.importPlan(SESSION, revisedSource, undefined, JSON.parse(readFileSync(revisedSource, "utf8")))
    if (!next.result.ok) throw new Error(next.result.text)
    expect(next.result.wf.phase).toBe("pending_approval")
    const rejected = f.controller.decide({ source: "local_human", action: "reject", workflowID: next.result.wf.id, planSha: next.planSha, reason: "not ready" })
    expect(rejected.ok && rejected.wf.phase).toBe("planning")
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
    expect(f.requests.map(r => r.role)).toEqual(["reviewer", "reviewer"])
  })

  test("an unresolved prior child blocks resume before queue mutation or replay", async () => {
    const f = fixture({ reconcile: "unknown" })
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect(f.controller.decide(approval(submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const claim = f.runtime.runs.claim(SESSION, f.runtime.instance, process.pid)
    f.runtime.runs.registerIntent(claim, { executionId: "lost", ownerSession: SESSION, taskId: "task", attemptId: "attempt", generation: claim.generation, role: "worker", cwd: wt.worktree, policyID: f.runtime.policy.resolve("worker").id, kind: "host", profile: "legacy-unowned" })
    f.runtime.runs.bindVendorRef(claim, "lost", JSON.stringify({ executionID: "lost", vendorSessionID: "unknown-child" }))
    const before = readFileSync(workflowPath(wt.worktree), "utf8")
    const ledger = JSON.stringify(readLedger(wt.worktree, SESSION))
    await expect(f.controller.resume("other_session")).rejects.toThrow("no workflow owned by this session")
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(before)
    await expect(f.controller.resume(SESSION)).rejects.toThrow("quiescent")
    expect(f.reconciliations).toBe(1)
    expect(f.requests).toHaveLength(1)
    expect(JSON.stringify(readLedger(wt.worktree, SESSION))).toBe(ledger)
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(before)
    expect(f.runtime.runs.status().claim).toBeDefined()
  })

  test("dead-owner takeover retires only an explicitly prepared verifier", async () => {
    const { f, executionID } = await verifierTakeover("prepared")
    const stopBeforeQueue = new AbortController()
    stopBeforeQueue.abort()
    await expect(f.controller.resume(SESSION, stopBeforeQueue.signal)).rejects.toThrow("run cancelled before dispatch")
    expect(f.runtime.runs.status().executions.at(-1)).toMatchObject({
      executionId: executionID, verifierDispatch: "retired", terminal: { outcome: "not-dispatched" },
    })
    expect(f.runtime.runs.status().claim).toBeUndefined()
  })

  for (const dispatch of ["started", "unmarked"] as const) {
    test(`dead-owner takeover leaves ${dispatch} legacy verifier unresolved without inventing a terminal`, async () => {
      const { f, executionID } = await verifierTakeover(dispatch)
      await expect(f.controller.resume(SESSION)).rejects.toThrow("quiescent")
      const execution = f.runtime.runs.status().executions.at(-1)!
      expect(execution.executionId).toBe(executionID)
      expect(execution.terminal).toBeUndefined()
      expect(execution.verifierDispatch).toBe(dispatch === "unmarked" ? undefined : "started")
      expect(f.runtime.runs.status().claim).toBeDefined()
    })
  }

  test("controller delegates protected-test restoration and failed verification to the shared queue", async () => {
    const source = save()
    const original = readFileSync(join(wt.worktree, "check_1.sh"), "utf8")
    const f = fixture({ maxAttempts: 1, worker: request => {
      const n = Number(request.title.match(/module (\d)/)?.[1])
      writeFileSync(join(wt.worktree, `mod${n}.py`), `VALUE = ${n}\n`)
      if (n === 1) writeFileSync(join(wt.worktree, "check_1.sh"), "exit 0\n")
      return { status: "completed", text: "Open issues: none" }
    } })
    const submitted = await f.controller.importPlan(SESSION, source)
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect(f.controller.decide(approval(submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const finished = await f.controller.run(SESSION)
    expect(finished.workflow.phase).toBe("stuck")
    expect(finished.run.failed).toBe(1)
    expect(readFileSync(join(wt.worktree, "check_1.sh"), "utf8")).toBe(original)
    expect(readLedger(wt.worktree, SESSION).tasks[0]?.verify_result?.output).toContain("protected file modified")
  })

  test("another foreground controller cancels a live plan review without taking over or claiming quiescence", async () => {
    const owner = fixture({ hangReview: true })
    const submitting = owner.controller.importPlan(SESSION, save())
    await waitFor(() => owner.requests.length === 1)
    const canceller = fixture({ instance: "cancel-controller" })
    const workflowBefore = readFileSync(workflowPath(wt.worktree), "utf8")
    expect(() => canceller.controller.cancel("wrong_session")).toThrow("no workflow owned by this session")
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(workflowBefore)
    const reviewing = readWorkflow(wt.worktree)!
    const originalOwner = { ...reviewing.owner, instance: "foreign-live-owner" }
    writeWorkflow(wt.worktree, { ...reviewing, owner: originalOwner })
    const cancelled = canceller.controller.cancel(SESSION)
    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) expect(cancelled.wf.pendingCancel).toBe(true)
    expect(readWorkflow(wt.worktree)?.owner).toEqual(originalOwner)
    expect(canceller.controller.status(SESSION, true)).toMatchObject({ workflow: { phase: "reviewing", pendingCancel: true } })
    const result = await submitting
    expect(result.result.ok).toBe(false)
    expect(owner.cancellationRequests).toHaveLength(1)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "reviewing", pendingCancel: true, owner: originalOwner })
    expect(owner.runtime.runs.status().executions.at(-1)).toMatchObject({ fence: expect.anything(), reconciliation: { outcome: "unknown", quiescent: false } })
    expect(owner.runtime.runs.status().claim).toBeDefined()
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
    clearReviewSession("child_1")
  })

  test("a quiescently cancelled plan review settles cancelled, never approved", async () => {
    const owner = fixture({ hangReview: true, cancelQuiescent: true })
    const submitting = owner.controller.importPlan(SESSION, save())
    await waitFor(() => owner.requests.length === 1)
    const canceller = fixture({ instance: "cancel-controller" })
    const cancelled = canceller.controller.cancel(SESSION)
    expect(cancelled.ok && cancelled.wf.pendingCancel).toBe(true)
    const result = await submitting
    expect(result.result.ok).toBe(false)
    expect(owner.cancellationRequests).toHaveLength(1)
    expect(readWorkflow(wt.worktree)?.phase).toBe("cancelled")
    expect(readWorkflow(wt.worktree)?.pendingCancel).toBeUndefined()
    expect(owner.runtime.runs.status().claim).toBeUndefined()
    expect(owner.runtime.runs.status().executions.at(-1)?.terminal?.quiescentAt).toBeGreaterThan(0)
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
    clearReviewSession("child_1")
  })

  test("a subprocess foreground controller aborts a hanging worker without dispatching the next task or clearing its fence", async () => {
    const owner = fixture({ worker: () => new Promise<ExecutionOutcome>(() => {}) })
    const submitted = await owner.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect(owner.controller.decide(approval(submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const running = owner.controller.run(SESSION)
    await waitFor(() => owner.requests.some(request => request.role === "worker"))
    const runningWorkflow = readWorkflow(wt.worktree)!
    const originalOwner = { ...runningWorkflow.owner, instance: "foreign-live-owner" }
    writeWorkflow(wt.worktree, { ...runningWorkflow, owner: originalOwner })
    const cancelled = await cancelInSubprocess(wt.worktree, SESSION)
    expect(cancelled.pendingCancel).toBe(true)
    expect(cancelled.owner).toEqual(originalOwner)
    expect(readWorkflow(wt.worktree)?.owner).toEqual(originalOwner)
    await expect(running).rejects.toThrow("execution unresolved; fence retained")
    expect(owner.cancellationRequests).toHaveLength(1)
    expect(owner.requests.filter(request => request.role === "worker")).toHaveLength(1)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "executing", pendingCancel: true, owner: originalOwner })
    const execution = owner.runtime.runs.status().executions.at(-1)!
    expect(execution.fence).toBeDefined()
    expect(execution.terminal?.quiescentAt).toBeUndefined()
    expect(execution.reconciliation).toMatchObject({ outcome: "unknown", quiescent: false })
    expect(owner.runtime.runs.status().claim).toBeDefined()
    expect(readLedger(wt.worktree, SESSION).tasks.filter(task => task.status === "running")).toHaveLength(0)
  })
})
