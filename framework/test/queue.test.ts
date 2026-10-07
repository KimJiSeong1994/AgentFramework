import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG, type LcaConfig } from "../src/config.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionHandle, ExecutionOutcome, ExecutionReconciliation, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { createQueue, getQueue, parseVerdict, reviewerPrompt, workerPrompt } from "../src/orchestration/queue.ts"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"
import type { VerificationHandle, VerificationRequest, VerificationResult } from "../src/orchestration/verifier.ts"
import { createSnapshotStore } from "../src/orchestration/snapshot.ts"
import { createTaskWorktree, worktreeRoot } from "../src/orchestration/worktree.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { newWorkflow, writeWorkflow } from "../src/flow/state.ts"
import { addTasks, emptyLedger, readLedger, updateTask, writeLedger } from "../src/state/ledger.ts"
import { sessionDir, stateRoot } from "../src/state/store.ts"
import { tempGitWorktree, verifyScript, waitFor } from "./guards-helpers.ts"

const S = "ses_main"
let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree({ "README.md": "fixture\n" }) })
afterEach(() => wt.cleanup())

const write = (name: string, contents: string) => writeFileSync(join(wt.worktree, name), contents)
const verify = (name: string, body: string) => verifyScript(wt.worktree, name, body)
type Reply = (request: ExecutionRequest) => Promise<ExecutionOutcome> | ExecutionOutcome

function legacyVerificationResult(request: VerificationRequest, patch: Partial<VerificationResult> = {}): VerificationResult {
  return {
    profile: request.profile, parentExit: 0, timedOut: false, cancelled: false,
    isolationEstablished: false, domainState: "unknown", integrity: "unchanged", output: "fixture result",
    ...patch,
  }
}

function fixture(patch: Partial<LcaConfig> = {}) {
  const config: LcaConfig = {
    ...DEFAULT_CONFIG, ...patch,
    delegate: { ...DEFAULT_CONFIG.delegate, ...patch.delegate },
    models: { ...DEFAULT_CONFIG.models, ...patch.models },
  }
  const requests: ExecutionRequest[] = []
  const events: string[] = []
  const replies = new Map<string, Reply>()
  let prepareWait: (() => Promise<void>) | undefined
  let requestCancelWait: (() => Promise<void>) | undefined
  let reconciliation: "settled" | "unknown" = "settled"
  let cancellation: "terminal" | "ack-only" = "terminal"
  let seq = 0
  const runtime: ExecutionRuntime = {
    instance: "queue-fixture", directory: wt.worktree, worktree: wt.worktree,
    stateRoot: stateRoot(wt.worktree), config, verificationProfile: "legacy-unowned",
    log: (event) => { events.push(event) },
    runs: createExecutionRunStore(wt.worktree), verifier: createLegacyVerifierExecutor(), policy: createExecutionPolicy(config, { directory: wt.worktree, worktree: wt.worktree }),
    host: {
      identity: { engine: "fixture", profile: "neutral" },
      async preflight() { return { compatible: true, controls: {}, problems: [] } },
      async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "a detached fixture is not proven quiescent" } },
      async prepare(request): Promise<ExecutionHandle> {
        requests.push(request)
        if (prepareWait) await prepareWait()
        const vendorSessionID = `child_${++seq}`
        runtime.policy.bindSession(vendorSessionID, request.handlers, request.policy)
        let settled = false
        let stopped = false
        return {
          reference: { executionID: request.executionID, vendorSessionID },
          async run() {
            const reply = replies.get(request.role)
            if (!reply) throw new Error(`missing fixture reply for ${request.role}`)
            const outcome = await reply(request)
            if (!stopped || cancellation === "terminal") settled = true
            return outcome
          },
          async requestCancel() {
            if (requestCancelWait) await requestCancelWait()
            stopped = true
            if (cancellation === "terminal") settled = true
            return { requested: true, acknowledged: true, terminal: false, quiescent: false }
          },
          async reconcile(): Promise<ExecutionReconciliation> {
            if (reconciliation === "unknown") return { outcome: "unknown", quiescent: false, evidence: "fixture cannot prove execution quiescence" }
            return settled ? { outcome: "terminal", quiescent: true, evidence: "fixture execution settled" }
              : { outcome: "unknown", quiescent: false, evidence: "fixture execution still pending" }
          },
        }
      },
    },
  }
  return { runtime, requests, events, replies, setCancellation: (value: "terminal" | "ack-only") => { cancellation = value },
    setPrepareWait: (wait: () => Promise<void>) => { prepareWait = wait },
    setRequestCancelWait: (wait: () => Promise<void>) => { requestCancelWait = wait },
    setReconciliation: (value: "settled" | "unknown") => { reconciliation = value } }
}

describe("neutral execution queue", () => {
  test("a failed changed-file diff is not interpreted as an empty diff", async () => {
    const store = (await createSnapshotStore(wt.worktree))!
    try {
      const before = await store.snapshot()
      expect(before).not.toBeNull()
      expect(await store.diff(before, { tree: "0000000000000000000000000000000000000000", store }, 1000)).toBeNull()
    } finally {
      store.dispose()
    }
  })

  test("unknown restart recovery leaves ledger bytes untouched and later runs only unfinished tasks", async () => {
    const f = fixture({ delegate: { worktree: true, review: false, max_attempts: 1 } as LcaConfig["delegate"] })
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "already done" }, { title: "interrupted" }, { title: "still pending" }])
    let ledger = readLedger(wt.worktree, S)
    const [done, interrupted, pending] = ledger.tasks
    const oldWorktree = (await createTaskWorktree(wt.worktree, S, interrupted!.id, f.runtime.config.delegate.diff_exclude))!
    writeFileSync(join(oldWorktree.path, "orphan.py"), "ORPHAN_EDIT = True\n")
    const now = Date.now()
    ledger = updateTask(ledger, done!.id, { status: "done", attempts: 1, startedAt: now - 3000, finishedAt: now - 2000 })
    ledger = updateTask(ledger, interrupted!.id, { status: "running", attempts: 1, startedAt: now - 1000 })
    writeLedger(wt.worktree, { ...ledger, running: { taskId: interrupted!.id, since: now - 1000 } })
    const ledgerPath = join(sessionDir(wt.worktree, S), "ledger.json")
    const originalBytes = readFileSync(ledgerPath)

    const old = f.runtime.runs.claim(S, "dead-owner", 99999999)
    f.runtime.runs.registerIntent(old, { executionId: "recovery-unknown", ownerSession: S, taskId: interrupted!.id,
      attemptId: "old-attempt", generation: old.generation, role: "worker", cwd: oldWorktree.path,
      policyID: "worker-policy", kind: "host", profile: "legacy-unowned" })
    f.runtime.runs.bindVendorRef(old, "recovery-unknown", JSON.stringify({ executionID: "recovery-unknown", vendorSessionID: "old-child" }))
    f.runtime.runs.fence(old, "recovery-unknown", "prior owner ended without proof")
    let hostRecovery: ExecutionReconciliation = { outcome: "unknown", quiescent: false, evidence: "still busy" }
    f.runtime.host.reconcile = async () => hostRecovery

    expect(await q.run(S)).toMatchObject({ aborted: true, done: 0 })
    expect(f.requests).toHaveLength(0)
    expect(readFileSync(ledgerPath)).toEqual(originalBytes)
    expect(existsSync(oldWorktree.path)).toBe(true)
    expect(readFileSync(join(oldWorktree.path, "orphan.py"), "utf8")).toBe("ORPHAN_EDIT = True\n")
    expect(f.runtime.runs.status().claim).toBeDefined()
    expect(f.runtime.runs.status().executions[0]?.fence).toBeDefined()

    hostRecovery = { outcome: "terminal", quiescent: true, evidence: "execution is terminal and quiescent" }
    f.replies.set("worker", () => ({ status: "completed", text: "Files changed: none\nOpen issues: none" }))
    expect(await q.run(S, { resumed: true })).toMatchObject({ done: 2, failed: 0 })
    expect(f.requests.map(request => request.taskID)).toEqual([interrupted!.id, pending!.id])
    expect(readLedger(wt.worktree, S).tasks.map(task => task.status)).toEqual(["done", "done", "done"])
    expect(readFileSync(join(wt.worktree, "orphan.py"), "utf8")).toBe("ORPHAN_EDIT = True\n")
  })

  test("restarted in-place task reviews pre-restart edits even when its new worker is idle", async () => {
    const f = fixture({ delegate: { review: true, max_attempts: 1 } as LcaConfig["delegate"] })
    const q = createQueue(f.runtime)
    const [task] = q.add(S, [{ title: "recover orphan edits" }])
    const snapshots = join(sessionDir(wt.worktree, S), "snapshots", task!.id)
    const baselineStore = (await createSnapshotStore(wt.worktree, snapshots))!
    expect(await baselineStore.baseline(f.runtime.config.delegate.diff_exclude)).not.toBeNull()
    write("orphan.py", "ORPHAN_EDIT = True\n")
    const now = Date.now()
    const running = updateTask(readLedger(wt.worktree, S), task!.id, { status: "running", attempts: 1, startedAt: now - 1000 })
    writeLedger(wt.worktree, { ...running, running: { taskId: task!.id, since: now - 1000 } })

    let reviewPromptText = ""
    f.replies.set("worker", () => ({ status: "completed", text: "Files changed: none\nOpen issues: none" }))
    f.replies.set("reviewer", request => {
      reviewPromptText = request.text
      return { status: "completed", text: "ACCEPT" }
    })
    expect(await q.run(S)).toMatchObject({ done: 1, failed: 0 })
    expect(reviewPromptText).toContain("orphan.py")
    expect(reviewPromptText).toContain("+ORPHAN_EDIT = True")
    expect(f.requests.map(request => request.role)).toEqual(["worker", "reviewer"])
    expect(existsSync(snapshots)).toBe(false)
  })

  test("interrupted isolated task reviews and merges original edits after the replacement worker is idle", async () => {
    const f = fixture({ delegate: { worktree: true, review: true, max_attempts: 1 } as LcaConfig["delegate"] })
    const q = createQueue(f.runtime)
    const [task] = q.add(S, [{ title: "recover isolated orphan" }])
    const old = (await createTaskWorktree(wt.worktree, S, task!.id, f.runtime.config.delegate.diff_exclude))!
    writeFileSync(join(old.path, "orphan.py"), "ORPHAN_EDIT = True\n")
    const now = Date.now()
    const running = updateTask(readLedger(wt.worktree, S), task!.id, { status: "running", attempts: 1, startedAt: now - 1000 })
    writeLedger(wt.worktree, { ...running, running: { taskId: task!.id, since: now - 1000 } })

    let reviewPromptText = ""
    f.replies.set("worker", request => {
      expect(request.cwd).toBe(old.path)
      return { status: "completed", text: "Files changed: none\nOpen issues: none" }
    })
    f.replies.set("reviewer", request => {
      reviewPromptText = request.text
      return { status: "completed", text: "ACCEPT" }
    })
    expect(await q.run(S, { resumed: true })).toMatchObject({ done: 1, failed: 0 })
    expect(reviewPromptText).toContain("orphan.py")
    expect(reviewPromptText).toContain("+ORPHAN_EDIT = True")
    expect(readFileSync(join(wt.worktree, "orphan.py"), "utf8")).toBe("ORPHAN_EDIT = True\n")
    expect(f.requests.map(request => request.role)).toEqual(["worker", "reviewer"])
    expect(existsSync(old.path)).toBe(false)
    const requestCount = f.requests.length
    expect(await q.run(S, { resumed: true })).toMatchObject({ done: 0, failed: 0 })
    expect(f.requests).toHaveLength(requestCount)
    expect(readLedger(wt.worktree, S).tasks[0]?.status).toBe("done")
  })

  test("explicit resume authenticates an owned pre-dispatch worktree without a running ledger entry", async () => {
    const f = fixture({ delegate: { worktree: true, review: true, max_attempts: 1 } as LcaConfig["delegate"] })
    const q = createQueue(f.runtime)
    const [task] = q.add(S, [{ title: "recover pre-dispatch worktree" }])
    const old = (await createTaskWorktree(wt.worktree, S, task!.id, f.runtime.config.delegate.diff_exclude))!
    writeFileSync(join(old.path, "orphan.py"), "PRE_DISPATCH_EDIT = True\n")
    const ledgerPath = join(sessionDir(wt.worktree, S), "ledger.json")
    const ledgerBytes = readFileSync(ledgerPath)
    let reviewPromptText = ""
    f.replies.set("worker", () => ({ status: "completed", text: "Files changed: none\nOpen issues: none" }))
    f.replies.set("reviewer", request => {
      reviewPromptText = request.text
      return { status: "completed", text: "ACCEPT" }
    })
    expect(await q.run(S)).toMatchObject({ aborted: true, done: 0 })
    expect(f.requests).toHaveLength(0)
    expect(readFileSync(ledgerPath)).toEqual(ledgerBytes)
    expect(existsSync(old.path)).toBe(true)
    expect(await q.run(S, { resumed: true })).toMatchObject({ done: 1, failed: 0 })
    expect(reviewPromptText).toContain("PRE_DISPATCH_EDIT = True")
    expect(readFileSync(join(wt.worktree, "orphan.py"), "utf8")).toBe("PRE_DISPATCH_EDIT = True\n")
    expect(f.requests.map(request => request.role)).toEqual(["worker", "reviewer"])
  })

  for (const ownershipState of ["wrong", "missing"] as const) {
    test(`${ownershipState} isolated ownership blocks restart without changing ledger or worktree`, async () => {
      const f = fixture({ delegate: { worktree: true, review: false, max_attempts: 1 } as LcaConfig["delegate"] })
      const q = createQueue(f.runtime)
      const [task] = q.add(S, [{ title: "preserve unauthenticated worktree" }])
      const old = (await createTaskWorktree(wt.worktree, S, task!.id, f.runtime.config.delegate.diff_exclude))!
      writeFileSync(join(old.path, "orphan.py"), "ORPHAN_EDIT = True\n")
      const now = Date.now()
      const running = updateTask(readLedger(wt.worktree, S), task!.id, { status: "running", attempts: 1, startedAt: now - 1000 })
      writeLedger(wt.worktree, { ...running, running: { taskId: task!.id, since: now - 1000 } })
      const ledgerPath = join(sessionDir(wt.worktree, S), "ledger.json")
      const ledgerBytes = readFileSync(ledgerPath)
      const recoveryDir = join(worktreeRoot(wt.worktree), ".recovery", S)
      const ownershipPath = join(recoveryDir, task!.id, "ownership.json")
      if (ownershipState === "wrong") {
        const foreignTaskID = `${task!.id}_foreign`
        await createTaskWorktree(wt.worktree, S, foreignTaskID, f.runtime.config.delegate.diff_exclude)
        writeFileSync(ownershipPath, readFileSync(join(recoveryDir, foreignTaskID, "ownership.json")))
      } else rmSync(ownershipPath)

      f.replies.set("worker", () => ({ status: "completed", text: "Files changed: none\nOpen issues: none" }))
      expect(await q.run(S, { resumed: true })).toMatchObject({ aborted: true, done: 0 })
      expect(f.requests).toHaveLength(0)
      expect(readFileSync(ledgerPath)).toEqual(ledgerBytes)
      expect(existsSync(old.path)).toBe(true)
      expect(readFileSync(join(old.path, "orphan.py"), "utf8")).toBe("ORPHAN_EDIT = True\n")
      const baselinePath = join(recoveryDir, task!.id, "baseline", "baseline.json")
      expect(readFileSync(baselinePath, "utf8")).toContain(old.baseline.tree)
    })
  }

  for (const review of [false, true]) {
    test(`truncated task diff fails before verification or review (review=${review})`, async () => {
      const f = fixture({ delegate: { worktree: true, review, review_strict: false, max_attempts: 1, diff_max_chars: 128 } as LcaConfig["delegate"] })
      const maliciousSource = `${"VALUE = 1\n".repeat(100)}_call_count = 0\n`
      f.replies.set("worker", request => {
        writeFileSync(join(request.cwd, "feature.py"), maliciousSource)
        return { status: "completed", text: "Files changed: feature.py\nOpen issues: none" }
      })
      const q = createQueue(f.runtime)
      q.add(S, [{ title: "truncated diff", verify: verify("check_truncated.sh", "test -f feature.py") }])
      expect(await q.run(S)).toMatchObject({ done: 0, failed: 1 })
      const task = readLedger(wt.worktree, S).tasks[0]!
      expect(task.status).toBe("failed")
      expect(task.error).toContain("diff was truncated")
      expect(task.error).toContain("delegate.diff_max_chars")
      expect(task.filesChanged).toContain("feature.py")
      expect(task.verify_result).toMatchObject({ ok: false, output: expect.stringContaining("truncated") })
      expect(maliciousSource.indexOf("_call_count")).toBeGreaterThan(128)
      expect(f.requests.map(request => request.role)).toEqual(["worker"])
      expect(existsSync(join(wt.worktree, "feature.py"))).toBe(false)
      expect(f.runtime.runs.status().executions.filter(execution => execution.kind === "verifier")).toHaveLength(0)
    })
  }

  for (const reviewStrict of [false, true]) {
    test(`malformed reviewer verdict with passing verify (review_strict=${reviewStrict})`, async () => {
      const f = fixture({ delegate: { review: true, review_strict: reviewStrict, max_attempts: 2 } as LcaConfig["delegate"] })
      f.replies.set("worker", request => {
        writeFileSync(join(request.cwd, "feature.py"), "VALUE = 1\n")
        return { status: "completed", text: "Files changed: feature.py\nOpen issues: none" }
      })
      f.replies.set("reviewer", () => ({ status: "completed", text: "The change looks fine to me." }))
      const q = createQueue(f.runtime)
      q.add(S, [{ title: "malformed reviewer verdict", verify: verify("check_reviewer.sh", "test -f feature.py") }])
      const result = await q.run(S)
      expect(result).toMatchObject(reviewStrict ? { done: 0, failed: 1 } : { done: 1, failed: 0 })
      const task = readLedger(wt.worktree, S).tasks[0]!
      expect(task.verify_result?.ok).toBe(true)
      expect(task.review?.verdict).toBe("error")
      expect(task.attempts).toBe(reviewStrict ? 2 : 1)
      if (reviewStrict) expect(task.error).toContain("review gave no verdict")
      expect(f.requests.filter(request => request.role === "worker")).toHaveLength(reviewStrict ? 2 : 1)
      expect(f.requests.filter(request => request.role === "reviewer")).toHaveLength(reviewStrict ? 2 : 1)
    })
  }

  test("matching persisted workflow cancellation aborts a hanging worker without launching later tasks", async () => {
    const f = fixture({ delegate: { review: false, max_attempts: 1 } as LcaConfig["delegate"] })
    f.setCancellation("ack-only")
    const workflow = { ...newWorkflow(S, currentOwner(), "command", "queue cancellation"), phase: "executing" as const }
    writeWorkflow(wt.worktree, workflow)
    let workerStarted = false
    f.replies.set("worker", () => {
      workerStarted = true
      return new Promise<ExecutionOutcome>(() => {})
    })
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "hanging" }, { title: "must not launch" }])
    const run = q.run(S)
    await waitFor(() => workerStarted)
    writeWorkflow(wt.worktree, { ...workflow, pendingCancel: true })
    const result = await run
    expect(result.aborted).toBe(true)
    expect(f.requests.map(request => request.role)).toEqual(["worker"])
    expect(readLedger(wt.worktree, S).tasks.map(task => task.status)).toEqual(["cancelled", "pending"])
    expect(f.runtime.runs.status().executions[0]?.fence).toBeDefined()
    expect(f.runtime.runs.status().executions[0]?.terminal).toBeUndefined()
  })

  for (const mismatch of ["workflow", "session"] as const) {
    test(`persisted cancellation for a different ${mismatch} does not abort the queue`, async () => {
      const f = fixture({ delegate: { review: false, max_attempts: 1 } as LcaConfig["delegate"] })
      const workflow = newWorkflow(S, currentOwner(), "command", "queue cancellation mismatch")
      writeWorkflow(wt.worktree, workflow)
      let releaseWorker!: (outcome: ExecutionOutcome) => void
      let workerStarted = false
      f.replies.set("worker", () => {
        workerStarted = true
        return new Promise<ExecutionOutcome>(resolve => { releaseWorker = resolve })
      })
      const q = createQueue(f.runtime)
      q.add(S, [{ title: "must finish" }])
      const run = q.run(S)
      await waitFor(() => workerStarted)
      writeWorkflow(wt.worktree, {
        ...workflow,
        ...(mismatch === "workflow" ? { id: `${workflow.id}_other` } : { sessionID: "ses_other" }),
        pendingCancel: true,
      })
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(f.runtime.runs.status().executions[0]?.cancel).toBeUndefined()
      releaseWorker({ status: "completed", text: "done" })
      expect(await run).toMatchObject({ done: 1, aborted: false })
      expect(f.requests.map(request => request.role)).toEqual(["worker"])
    })
  }

  test("worktree snapshot loss with unproven restoration fences before verification or merge", async () => {
    const f = fixture({ delegate: { worktree: true, review: true, max_attempts: 1 } as LcaConfig["delegate"] })
    f.replies.set("worker", (request) => {
      writeFileSync(join(request.cwd, "feature.py"), "VALUE = 1\n")
      rmSync(join(request.cwd, ".git")) // break snapshot commands, without touching main's Git state
      return { status: "completed", text: "Files changed: feature.py\nOpen issues: none" }
    })
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "snapshot fault", verify: verify("check_snapshot.sh", "touch verified-marker") },
      { title: "must not start" }])
    expect(await q.run(S)).toMatchObject({ done: 0, aborted: true, abortReason: expect.stringContaining("queue fenced") })
    const ledger = readLedger(wt.worktree, S)
    expect(ledger.tasks[0]).toMatchObject({ status: "failed", error: expect.stringContaining("could not restore or snapshot") })
    expect(ledger.tasks[1]?.status).toBe("pending")
    expect(f.runtime.runs.status().claim).toBeDefined()
    expect(existsSync(join(wt.worktree, "verified-marker"))).toBe(false)
    expect(existsSync(join(wt.worktree, "feature.py"))).toBe(false)
    expect(f.requests.map((request) => request.role)).toEqual(["worker"])
  })
  test("in-place snapshot loss fences the live queue instead of running another task", async () => {
    const f = fixture({ delegate: { worktree: false, review: true, max_attempts: 1 } as LcaConfig["delegate"] })
    f.replies.set("worker", () => {
      write("test_fixture.py", "assert False\n")
      rmSync(join(wt.worktree, ".git"), { recursive: true, force: true })
      return { status: "completed", text: "Files changed: test_fixture.py\nOpen issues: none" }
    })
    const queue = createQueue(f.runtime)
    queue.add(S, [{ title: "lost Git baseline", verify: verify("check_snapshot.sh", "touch verified-marker") },
      { title: "must not start" }])
    expect(await queue.run(S)).toMatchObject({ aborted: true, done: 0 })
    expect(f.requests.map(request => request.role)).toEqual(["worker"])
    expect(existsSync(join(wt.worktree, "verified-marker"))).toBe(false)
    expect(f.runtime.runs.status().claim?.ownerSession).toBe(S)
    expect(readLedger(wt.worktree, S).tasks.every(task => task.status !== "done")).toBe(true)
  })
  test("stable runtime identity, serial worker/reviewer execution, independent verifier and handoff", async () => {
    const f = fixture()
    const queue = getQueue(f.runtime)
    expect(getQueue(f.runtime)).toBe(queue)
    f.replies.set("worker", (request) => {
      const n = f.requests.filter((r) => r.role === "worker").length
      write(`mod${n}.py`, `V = ${n}\n`)
      return { status: "completed", text: `Files changed: mod${n}.py\nOpen issues: none` }
    })
    f.replies.set("reviewer", () => ({ status: "completed", text: "ACCEPT" }))
    queue.add(S, [
      { title: "one", verify: verify("check_one.sh", "test -f mod1.py") },
      { title: "two", verify: verify("check_two.sh", "test -f mod2.py") },
    ])
    expect(await queue.run(S)).toMatchObject({ done: 2, failed: 0, cancelled: 0 })
    expect(f.requests.map((r) => r.role)).toEqual(["worker", "reviewer", "worker", "reviewer"])
    expect(f.requests[0]?.policy).toBe(f.runtime.policy.resolve("worker"))
    expect(f.requests[1]?.policy).toBe(f.runtime.policy.resolve("reviewer"))
    expect(f.requests[2]?.text).toContain("Task 1 (done): one [files: mod1.py]")
    expect(f.requests[3]?.text).toContain("+V = 2")
    const ledger = readLedger(wt.worktree, S)
    expect(ledger.tasks.map((task) => task.status)).toEqual(["done", "done"])
    expect(ledger.tasks.map((task) => task.verify_result?.ok)).toEqual([true, true])
    expect(existsSync(join(wt.worktree, ledger.tasks[0]!.handoff!))).toBe(true)
    expect(existsSync(sessionDir(wt.worktree, "child_1"))).toBe(false)
    expect(f.runtime.runs.status().executions).toHaveLength(6)
    expect(f.runtime.runs.status().executions.filter(e => e.kind === "verifier")).toHaveLength(2)
    expect(f.runtime.runs.status().executions.filter(e => e.kind === "verifier").every(e => e.descendantRisk === "unproven" && e.terminal?.verification?.isolationEstablished === false && e.terminal?.verification?.domainState === "unknown")).toBe(true)
    expect(f.runtime.runs.status().claim).toBeUndefined()
  })

  test("legacy verifier persists its boundary and terminal risk before the next host intent", async () => {
    const f = fixture({ delegate: { review: false } as LcaConfig["delegate"] })
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    const base = f.runtime.verifier
    let dispatchAtRun: string | undefined
    f.runtime.verifier = { ...base, async prepare(request) {
      const handle = await base.prepare(request)
      return { ...handle, async run() {
        dispatchAtRun = f.runtime.runs.status().executions.find(execution => execution.executionId === request.executionID)?.verifierDispatch
        return handle.run()
      } }
    } }
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "verified", verify: verify("check_first.sh", "test -f README.md") }, { title: "next" }])
    expect(await q.run(S)).toMatchObject({ done: 2 })
    const [worker, verifier, next] = f.runtime.runs.status().executions
    expect(worker).toMatchObject({ kind: "host", profile: "legacy-unowned" })
    expect(verifier).toMatchObject({ kind: "verifier", profile: "legacy-unowned", verifierDispatch: "started", descendantRisk: "unproven", terminal: { outcome: "ok", verification: { parentExit: 0, isolationEstablished: false, domainState: "unknown", integrity: "unchanged" } } })
    expect(verifier?.boundaryRef).toMatchObject({ kind: "verifier", inputSnapshotID: verifier?.inputSnapshotID, inputDigest: verifier?.inputDigest })
    expect(dispatchAtRun).toBe("started")
    expect(next).toMatchObject({ kind: "host", profile: "legacy-unowned" })
    expect(f.runtime.runs.status().claim).toBeUndefined()
  })

  test("unsupported Linux profile refuses before any verifier spawn or intent", async () => {
    const f = fixture({ delegate: { review: false, max_attempts: 1 } as LcaConfig["delegate"] })
    f.runtime.verificationProfile = "linux-single-use"
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "refused", verify: verify("check_linux.sh", "touch spawned-marker") }])
    expect(await q.run(S)).toMatchObject({ failed: 1 })
    expect(f.runtime.runs.status().executions.map(e => e.kind)).toEqual(["host"])
    expect(readLedger(wt.worktree, S).tasks[0]?.verify_result?.output).toContain("verify backend refused")
    expect(existsSync(join(wt.worktree, "spawned-marker"))).toBe(false)
  })

  test("a restored ledger with a disallowed command is refused before verifier preparation", async () => {
    const f = fixture({ delegate: { review: false, max_attempts: 1 } as LcaConfig["delegate"] })
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    const q = createQueue(f.runtime)
    const [task] = q.add(S, [{ title: "stale command", verify: verify("check_safe.sh", "test -f README.md") }])
    const ledger = readLedger(wt.worktree, S)
    writeLedger(wt.worktree, updateTask(ledger, task!.id, { verify: "sh check_safe.sh; touch forbidden-marker" }))
    expect(await q.run(S)).toMatchObject({ failed: 1 })
    expect(readLedger(wt.worktree, S).tasks[0]?.verify_result?.output).toContain("verify command refused")
    expect(f.runtime.runs.status().executions.map(e => e.kind)).toEqual(["host"])
    expect(existsSync(join(wt.worktree, "forbidden-marker"))).toBe(false)
  })

  for (const dispatch of ["started", "markerless", "unknown-terminal"] as const) {
    test(`dead-owner legacy verifier ${dispatch} state remains fenced without replay or baseline mutation`, async () => {
      const f = fixture({ delegate: { worktree: true, review: false } as LcaConfig["delegate"] })
      const q = createQueue(f.runtime)
      const [task] = q.add(S, [{ title: "restart" }])
      const oldWorktree = (await createTaskWorktree(wt.worktree, S, task!.id, f.runtime.config.delegate.diff_exclude))!
      writeFileSync(join(oldWorktree.path, "orphan.py"), "ORPHAN_EDIT = True\n")
      const baselinePath = join(worktreeRoot(wt.worktree), ".recovery", S, task!.id, "baseline", "baseline.json")
      const originalBaseline = readFileSync(baselinePath)
      writeLedger(wt.worktree, { ...updateTask(readLedger(wt.worktree, S), task!.id, { status: "running", attempts: 1 }),
        running: { taskId: task!.id, since: Date.now() } })
      const ledgerPath = join(sessionDir(wt.worktree, S), "ledger.json")
      const originalLedger = readFileSync(ledgerPath)

      const old = f.runtime.runs.claim(S, "dead-owner", 99999999)
      const id = `orphan-verifier-${dispatch}`
      const deadlineAt = Date.now() + 1000
      f.runtime.runs.registerIntent(old, {
        executionId: id, ownerSession: S, taskId: task!.id, attemptId: "old-attempt",
        generation: old.generation, role: "verifier", cwd: oldWorktree.path, policyID: "verify-command",
        kind: "verifier", profile: "legacy-unowned", inputSnapshotID: "old-tree", inputDigest: "a".repeat(64),
        deadlineAt, maxOutputChars: 1500,
      })
      if (dispatch === "started") {
        f.runtime.runs.bindVerifierRef(old, id, {
          kind: "verifier", profile: "legacy-unowned", executionID: id, invocationID: "old-invocation",
          inputSnapshotID: "old-tree", inputDigest: "a".repeat(64), deadlineAt, maxOutputChars: 1500,
        })
        f.runtime.runs.markVerifierDispatched(old, id)
      } else {
        // Simulate a durable record written before verifier dispatch metadata existed.
        const statePath = join(stateRoot(wt.worktree), "execution-runs", "state.json")
        const state = JSON.parse(readFileSync(statePath, "utf8")) as { executions: Array<Record<string, unknown>> }
        const execution = state.executions.find(record => record.executionId === id)!
        delete execution.verifierDispatch
        if (dispatch === "unknown-terminal") execution.terminal = { outcome: "unknown", terminalAt: Date.now() }
        writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
      }
      let reconciliations = 0
      f.runtime.verifier = { ...f.runtime.verifier, async reconcile() {
        reconciliations++
        return { outcome: "unknown", isolationEstablished: false, domainState: "unknown", integrity: "unknown" }
      } }
      f.replies.set("worker", () => ({ status: "completed", text: "must not replay" }))

      expect(await q.run(S, { resumed: dispatch === "markerless" })).toMatchObject({ aborted: true, done: 0 })
      expect(f.requests).toHaveLength(0)
      expect(reconciliations).toBe(0)
      expect(readFileSync(ledgerPath)).toEqual(originalLedger)
      expect(readFileSync(baselinePath)).toEqual(originalBaseline)
      expect(readFileSync(join(oldWorktree.path, "orphan.py"), "utf8")).toBe("ORPHAN_EDIT = True\n")
      const recovered = f.runtime.runs.status()
      expect(recovered.claim).toBeDefined()
      expect(recovered.executions[0]).toMatchObject({ fence: expect.anything(), descendantRisk: "unproven" })
      expect(recovered.executions[0]?.terminal?.outcome).toBe(dispatch === "unknown-terminal" ? "unknown" : undefined)
      expect(recovered.executions[0]?.verifierDispatch).toBe(dispatch === "started" ? "started" : undefined)
    })
  }

  test("dead-owner explicitly prepared verifier retires as not-dispatched without running or reconciling", async () => {
    const f = fixture({ delegate: { review: false } as LcaConfig["delegate"] })
    const q = createQueue(f.runtime)
    const [task] = q.add(S, [{ title: "already complete" }])
    const completed = updateTask(readLedger(wt.worktree, S), task!.id, {
      status: "done", attempts: 1, startedAt: Date.now() - 2000, finishedAt: Date.now() - 1000,
    })
    writeLedger(wt.worktree, completed)
    const ledgerPath = join(sessionDir(wt.worktree, S), "ledger.json")
    const originalLedger = readFileSync(ledgerPath)
    const old = f.runtime.runs.claim(S, "dead-owner", 99999999)
    const id = "prepared-verifier"
    f.runtime.runs.registerIntent(old, {
      executionId: id, ownerSession: S, taskId: task!.id, attemptId: "old-attempt",
      generation: old.generation, role: "verifier", cwd: wt.worktree, policyID: "verify-command",
      kind: "verifier", profile: "legacy-unowned", inputSnapshotID: "old-tree", inputDigest: "a".repeat(64),
      deadlineAt: Date.now() + 1000, maxOutputChars: 1500,
    })
    let reconciliations = 0
    f.runtime.verifier = { ...f.runtime.verifier, async reconcile() {
      reconciliations++
      return { outcome: "unknown", isolationEstablished: false, domainState: "unknown", integrity: "unknown" }
    } }

    expect(await q.run(S)).toMatchObject({ done: 0, failed: 0, aborted: false })
    expect(f.requests).toHaveLength(0)
    expect(reconciliations).toBe(0)
    expect(readFileSync(ledgerPath)).toEqual(originalLedger)
    expect(f.runtime.runs.status().claim).toBeUndefined()
    expect(f.runtime.runs.status().executions[0]).toMatchObject({
      verifierDispatch: "retired", terminal: { outcome: "not-dispatched" }, descendantRisk: "unproven",
    })
  })

  test("a second queue does not retire a prepared verifier owned by a live same-generation claim", async () => {
    const f = fixture({ delegate: { review: false } as LcaConfig["delegate"] })
    const firstQueue = createQueue(f.runtime)
    const [task] = firstQueue.add(S, [{ title: "still running" }])
    const claim = f.runtime.runs.claim(S, f.runtime.instance, process.pid)
    f.runtime.runs.registerIntent(claim, {
      executionId: "live-prepared-verifier", ownerSession: S, taskId: task!.id, attemptId: "live-attempt",
      generation: claim.generation, role: "verifier", cwd: wt.worktree, policyID: "verify-command",
      kind: "verifier", profile: "legacy-unowned", inputSnapshotID: "input-tree", inputDigest: "b".repeat(64),
      deadlineAt: Date.now() + 10_000, maxOutputChars: 1500,
    })
    writeLedger(wt.worktree, { ...updateTask(readLedger(wt.worktree, S), task!.id, { status: "running", attempts: 1 }),
      running: { taskId: task!.id, since: Date.now() } })
    const ledgerPath = join(sessionDir(wt.worktree, S), "ledger.json")
    const originalLedger = readFileSync(ledgerPath)

    const secondQueue = createQueue(f.runtime)
    expect(secondQueue).not.toBe(firstQueue)
    expect(await secondQueue.run(S)).toMatchObject({ aborted: true, done: 0 })
    expect(f.requests).toHaveLength(0)
    expect(readFileSync(ledgerPath)).toEqual(originalLedger)
    expect(f.runtime.runs.status().executions[0]).toMatchObject({
      verifierDispatch: "prepared", fence: expect.anything(),
    })
    expect(f.runtime.runs.status().executions[0]?.terminal).toBeUndefined()
    expect(f.runtime.runs.status().claim).toMatchObject({ generation: claim.generation })
  })

  test("missing Linux proof keeps claim and pending tasks fenced", async () => {
    const f = fixture({ delegate: { review: false } as LcaConfig["delegate"] })
    const old = f.runtime.runs.claim(S, "dead-owner", 99999999)
    f.runtime.runs.registerIntent(old, {
      executionId: "linux-orphan", ownerSession: S, taskId: "old-task", attemptId: "old-attempt",
      generation: old.generation, role: "verifier", cwd: wt.worktree, policyID: "verify-command",
      kind: "verifier", profile: "linux-single-use", inputSnapshotID: "old-tree", inputDigest: "a".repeat(64),
      deadlineAt: Date.now() + 1000, maxOutputChars: 1500,
    })
    const statePath = join(stateRoot(wt.worktree), "execution-runs", "state.json")
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    delete state.executions[0].verifierDispatch
    writeFileSync(statePath, JSON.stringify(state))
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "never started" }])
    expect(await q.run(S)).toMatchObject({ aborted: true, done: 0 })
    expect(f.requests).toHaveLength(0)
    expect(readLedger(wt.worktree, S).tasks[0]?.status).toBe("pending")
    expect(f.runtime.runs.status().claim).toBeDefined()
  })

  test("protected mutation by verifier is invalidated and restored before review", async () => {
    write("test_lock.py", "original\n")
    const f = fixture({ delegate: { review: true, max_attempts: 1 } as LcaConfig["delegate"] })
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "mutating check", verify: verify("check_mutation.sh", "printf 'changed\\n' > test_lock.py") }])
    expect(await q.run(S)).toMatchObject({ failed: 1 })
    expect(readFileSync(join(wt.worktree, "test_lock.py"), "utf8")).toBe("original\n")
    expect(readLedger(wt.worktree, S).tasks[0]?.verify_result?.ok).toBe(false)
    expect(f.requests.map(r => r.role)).toEqual(["worker"])
    expect(f.runtime.runs.status().executions.find(e => e.kind === "verifier")?.terminal?.verification?.integrity).toBe("changed")
  })

  test("isolated task verifies its imported content before review and main-worktree merge", async () => {
    const f = fixture({ delegate: { worktree: true, review: true } as LcaConfig["delegate"] })
    f.replies.set("worker", request => {
      writeFileSync(join(request.cwd, "feature.py"), "VALUE = 7\n")
      writeFileSync(join(request.cwd, "check_feature.sh"), "test -f feature.py\n")
      return { status: "completed", text: "Files changed: feature.py\nOpen issues: none" }
    })
    f.replies.set("reviewer", request => {
      expect(existsSync(join(request.cwd, "feature.py"))).toBe(true)
      expect(existsSync(join(wt.worktree, "feature.py"))).toBe(false)
      return { status: "completed", text: "ACCEPT" }
    })
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "import ordering", verify: verify("check_feature.sh", "test -f feature.py") }])
    expect(await q.run(S)).toMatchObject({ done: 1 })
    expect(readFileSync(join(wt.worktree, "feature.py"), "utf8")).toBe("VALUE = 7\n")
    expect(f.runtime.runs.status().executions.find(e => e.kind === "verifier")?.terminal?.verification?.integrity).toBe("unchanged")
  })

  test("interrupted isolated merge conflict preserves parent edits, child edits, and the original baseline", async () => {
    const f = fixture({ delegate: { worktree: true, review: true, max_attempts: 1 } as LcaConfig["delegate"] })
    const q = createQueue(f.runtime)
    const [task] = q.add(S, [{ title: "conflicting parent edit" }])
    const old = (await createTaskWorktree(wt.worktree, S, task!.id, f.runtime.config.delegate.diff_exclude))!
    const baselineTree = old.baseline.tree
    writeFileSync(join(old.path, "README.md"), "CHILD_EDIT = True\n")
    write("README.md", "PARENT_EDIT = True\n")
    const now = Date.now()
    const running = updateTask(readLedger(wt.worktree, S), task!.id, { status: "running", attempts: 1, startedAt: now - 1000 })
    writeLedger(wt.worktree, { ...running, running: { taskId: task!.id, since: now - 1000 } })
    f.replies.set("worker", () => ({ status: "completed", text: "Files changed: none\nOpen issues: none" }))
    f.replies.set("reviewer", () => ({ status: "completed", text: "ACCEPT" }))

    expect(await q.run(S, { resumed: true })).toMatchObject({ done: 0, failed: 1 })
    expect(readFileSync(join(wt.worktree, "README.md"), "utf8")).toBe("PARENT_EDIT = True\n")
    expect(readFileSync(join(old.path, "README.md"), "utf8")).toBe("CHILD_EDIT = True\n")
    expect(readLedger(wt.worktree, S).tasks[0]?.error).toContain("not merged:")
    expect(existsSync(old.path)).toBe(true)
    expect(readFileSync(join(worktreeRoot(wt.worktree), ".recovery", S, task!.id, "baseline", "baseline.json"), "utf8")).toContain(baselineTree)
    expect(f.requests.map(request => request.role)).toEqual(["worker", "reviewer"])
  })

  test("post-guard isolated worktree mutation is refused and its recovery state is retained", async () => {
    const f = fixture({ delegate: { worktree: true, review: false, max_attempts: 1 } as LcaConfig["delegate"] })
    const q = createQueue(f.runtime)
    const [task] = q.add(S, [{ title: "late isolated mutation", verify: verify("check_feature.sh", "test -f feature.py") }])
    const original = f.runtime.runs.assertQuiescent.bind(f.runtime.runs)
    let guards = 0
    let childPath = ""
    f.runtime.runs.assertQuiescent = claim => {
      original(claim)
      // The first call is startup recovery; mutate synchronously during the final pre-merge guard.
      if (++guards === 2) writeFileSync(join(childPath, "feature.py"), "LATE_MUTATION = True\n")
    }
    f.replies.set("worker", request => {
      childPath = request.cwd
      writeFileSync(join(request.cwd, "feature.py"), "VERIFIED = True\n")
      return { status: "completed", text: "Files changed: feature.py\nOpen issues: none" }
    })

    expect(await q.run(S)).toMatchObject({ done: 0, failed: 1 })
    expect(guards).toBe(2)
    expect(existsSync(join(wt.worktree, "feature.py"))).toBe(false)
    expect(readFileSync(join(childPath, "feature.py"), "utf8")).toBe("LATE_MUTATION = True\n")
    expect(readLedger(wt.worktree, S).tasks[0]?.error).toContain("not merged: worktree changed since verification")
    expect(existsSync(childPath)).toBe(true)
    expect(f.requests.map(request => request.role)).toEqual(["worker"])
  })

  for (const isolated of [false, true]) {
    test(`reviewer mutation invalidates verified tree before ${isolated ? "merge" : "completion"}`, async () => {
      const f = fixture({ delegate: { worktree: isolated, review: true, max_attempts: 1 } as LcaConfig["delegate"] })
      f.replies.set("worker", request => {
        writeFileSync(join(request.cwd, "feature.py"), "SAFE = 1\n")
        return { status: "completed", text: "Files changed: feature.py\nOpen issues: none" }
      })
      f.replies.set("reviewer", request => {
        writeFileSync(join(request.cwd, "feature.py"), "UNVERIFIED = 1\n")
        return { status: "completed", text: "ACCEPT" }
      })
      const q = createQueue(f.runtime)
      q.add(S, [{ title: "reviewer writer", verify: verify("check_feature.sh", "test -f feature.py") }])
      expect(await q.run(S)).toMatchObject({ done: 0, failed: 1 })
      expect(readLedger(wt.worktree, S).tasks[0]?.verify_result?.output).toContain("verified tree changed")
      if (isolated) expect(existsSync(join(wt.worktree, "feature.py"))).toBe(false)
      else expect(readFileSync(join(wt.worktree, "feature.py"), "utf8")).toBe("SAFE = 1\n")
    })
  }

  test("Linux backend booleans and matching evidence cannot authorize verification or settlement", async () => {
    const f = fixture({ delegate: { review: false, max_attempts: 1 } as LcaConfig["delegate"] })
    f.runtime.verificationProfile = "linux-single-use"
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    const base = createLegacyVerifierExecutor()
    f.runtime.verifier = {
      ...base,
      async preflight() { return { compatible: true, problems: [] } },
      async prepare(request) {
        expect(request.inputArchive?.byteLength).toBeGreaterThan(0)
        const reference = { kind: "verifier" as const, profile: "linux-single-use" as const, executionID: request.executionID,
          invocationID: "test-invocation", inputSnapshotID: request.inputSnapshotID, inputDigest: request.inputDigest,
          deadlineAt: request.deadlineAt, maxOutputChars: request.maxOutputChars, unit: "lca-verifier.service", bootID: "test-boot" }
        return { reference,
          async run() { return { profile: "linux-single-use" as const, parentExit: 0, timedOut: false, cancelled: false,
            isolationEstablished: true, domainState: "empty" as const, integrity: "unknown" as const, output: "",
            proof: { reference, evidence: "fixture-proof" } } },
          async reconcile() { return { outcome: "terminal" as const, isolationEstablished: true, domainState: "empty" as const,
            integrity: "unknown" as const, proof: { reference, evidence: "fixture-proof" } } },
          async requestCancel() { return { requested: false, acknowledged: false } },
        }
      },
    }
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "unknown integrity", verify: verify("check_linux_unknown.sh", "test -f README.md") }])
    expect(await q.run(S)).toMatchObject({ done: 0, aborted: true })
    expect(f.requests.map(r => r.role)).toEqual(["worker"])
    expect(readLedger(wt.worktree, S).tasks[0]?.verify_result?.ok).not.toBe(true)
    const execution = f.runtime.runs.status().executions.find(e => e.kind === "verifier")!
    expect(execution.terminal).toBeUndefined()
    expect(execution.fence?.reason).toContain("not authenticated")
    expect(f.runtime.runs.status().claim).toBeDefined()
  })

  test("hanging verifier handle reconciliation fences without retry, review, or cancelling pending tasks", async () => {
    const f = fixture({ delegate: { review: true, max_attempts: 2 } as LcaConfig["delegate"] })
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    const base = f.runtime.verifier
    f.runtime.verifier = { ...base, async prepare(request) {
      const handle = await base.prepare(request)
      return { ...handle, reconcile: async () => new Promise<never>(() => {}) }
    } }
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "hanging reconcile", verify: verify("check_hang.sh", "test -f README.md") }, { title: "pending" }])
    expect(await q.run(S)).toMatchObject({ aborted: true, done: 0 })
    expect(f.requests.map(r => r.role)).toEqual(["worker"])
    expect(readLedger(wt.worktree, S).tasks[1]?.status).toBe("pending")
    expect(f.runtime.runs.status().claim).toBeDefined()
    expect(f.runtime.runs.status().executions.find(e => e.kind === "verifier")?.fence).toBeDefined()
  })

  test("verifier replacement environment supplies a trusted executable path", async () => {
    const f = fixture({ delegate: { review: false } as LcaConfig["delegate"] })
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    const base = f.runtime.verifier
    let suppliedPath: string | undefined
    f.runtime.verifier = { ...base, async prepare(request) {
      suppliedPath = request.env.PATH
      return base.prepare(request)
    } }
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "runner path", verify: verify("check_path.sh", "test -f README.md") }])
    expect(await q.run(S)).toMatchObject({ done: 1 })
    expect(suppliedPath).toContain("/usr/bin:/bin")
    expect(suppliedPath).not.toContain(".")
  })

  test("hanging verifier restart reconciliation fences before repairing or replaying tasks", async () => {
    const f = fixture()
    const old = f.runtime.runs.claim(S, "dead-owner", 99999999)
    const id = "linux-restart-hang"
    const snapshotID = "old-tree"
    const digest = "a".repeat(64)
    const deadlineAt = Date.now() + 5000
    f.runtime.runs.registerIntent(old, { executionId: id, ownerSession: S, taskId: "old-task", attemptId: "old-attempt",
      generation: old.generation, role: "verifier", cwd: wt.worktree, policyID: "verify-command",
      kind: "verifier", profile: "linux-single-use", inputSnapshotID: snapshotID, inputDigest: digest, deadlineAt, maxOutputChars: 1500 })
    f.runtime.runs.bindVerifierRef(old, id, { kind: "verifier", profile: "linux-single-use", executionID: id,
      invocationID: "old-invocation", inputSnapshotID: snapshotID, inputDigest: digest, deadlineAt, maxOutputChars: 1500,
      unit: "lca-verifier.service", bootID: "old-boot" })
    f.runtime.runs.markVerifierDispatched(old, id)
    f.runtime.verifier = { ...f.runtime.verifier, reconcile: async () => new Promise<never>(() => {}) }
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "still pending" }])
    expect(await q.run(S)).toMatchObject({ aborted: true, done: 0 })
    expect(f.requests).toHaveLength(0)
    expect(readLedger(wt.worktree, S).tasks[0]?.status).toBe("pending")
    expect(f.runtime.runs.status().claim).toBeDefined()
    expect(f.runtime.runs.status().executions[0]?.fence).toBeDefined()
  })

  test("forged native restart result cannot repair the ledger or dispatch another task", async () => {
    const f = fixture()
    const old = f.runtime.runs.claim(S, "dead-owner", 99999999)
    const id = "forged-native-retirement"
    const reference = {
      kind: "verifier" as const, profile: "linux-single-use" as const, executionID: id,
      invocationID: "old-ticket", inputSnapshotID: "old-tree", inputDigest: "a".repeat(64),
      deadlineAt: Date.now() + 5000, maxOutputChars: 1500,
      unit: "lca-verifier.service", bootID: "old-boot",
    }
    f.runtime.runs.registerIntent(old, {
      executionId: id, ownerSession: S, taskId: "old-task", attemptId: "old-attempt",
      generation: old.generation, role: "verifier", cwd: wt.worktree, policyID: "verify-command",
      kind: "verifier", profile: "linux-single-use", inputSnapshotID: reference.inputSnapshotID,
      inputDigest: reference.inputDigest, deadlineAt: reference.deadlineAt, maxOutputChars: reference.maxOutputChars,
    })
    f.runtime.runs.bindVerifierRef(old, id, reference)
    f.runtime.runs.markVerifierDispatched(old, id)
    const proof = { reference, evidence: "claimed root retirement", receipt: "{}", signature: Buffer.alloc(64).toString("base64") }
    f.runtime.verifier = { ...f.runtime.verifier, async reconcile() {
      return {
        outcome: "terminal", isolationEstablished: true, domainState: "empty", integrity: "unchanged", proof,
        result: {
          profile: "linux-single-use", parentExit: 0, timedOut: false, cancelled: false,
          isolationEstablished: true, domainState: "empty", integrity: "unchanged", output: "", proof,
        },
      }
    } }
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "must remain pending" }])
    const path = join(sessionDir(wt.worktree, S), "ledger.json")
    const ledger = readFileSync(path)
    expect(await q.run(S)).toMatchObject({ aborted: true, done: 0 })
    expect(f.requests).toHaveLength(0)
    expect(readFileSync(path)).toEqual(ledger)
    expect(f.runtime.runs.status().executions[0]?.reconciliation?.quiescent).toBe(false)
    expect(f.runtime.runs.status().claim).toBeDefined()
  })

  test("hanging host restart reconciliation cannot route through verifier or cancel pending tasks", async () => {
    const f = fixture()
    const old = f.runtime.runs.claim(S, "dead-owner", 99999999)
    f.runtime.runs.registerIntent(old, { executionId: "host-restart-hang", ownerSession: S, taskId: "old-task", attemptId: "old-attempt",
      generation: old.generation, role: "worker", cwd: wt.worktree, policyID: "worker-policy", kind: "host", profile: "legacy-unowned" })
    f.runtime.runs.bindVendorRef(old, "host-restart-hang", JSON.stringify({ executionID: "host-restart-hang", vendorSessionID: "old-child" }))
    f.runtime.host.reconcile = async () => new Promise<never>(() => {})
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "still pending" }])
    expect(await q.run(S)).toMatchObject({ aborted: true, done: 0 })
    expect(f.requests).toHaveLength(0)
    expect(readLedger(wt.worktree, S).tasks[0]?.status).toBe("pending")
    expect(f.runtime.runs.status().claim).toBeDefined()
    expect(f.runtime.runs.status().executions[0]?.fence).toBeDefined()
  })

  for (const signal of ["cancelled", "timeout", "external-signal", "unknown-result"] as const) {
    test(`launched legacy verifier ${signal} stays fenced across resume without replacement children`, async () => {
      const f = fixture({ delegate: { review: true, worktree: true, max_attempts: 2 } as LcaConfig["delegate"] })
      f.replies.set("worker", request => {
        writeFileSync(join(request.cwd, "unmerged.py"), "VALUE = 1\n")
        return { status: "completed", text: "done" }
      })
      const base = f.runtime.verifier
      let runCalls = 0
      let verifierRequest: VerificationRequest | undefined
      f.runtime.verifier = { ...base, async prepare(request) {
        verifierRequest = request
        const inert = await base.prepare(request)
        const result = legacyVerificationResult(request, signal === "timeout"
          ? { parentExit: null, timedOut: true }
          : signal === "unknown-result" ? { parentExit: null } : { parentExit: null, cancelled: true })
        return {
          ...inert,
          async run() {
            runCalls++
            return signal === "cancelled" ? new Promise<VerificationResult>(() => {}) : result
          },
          async requestCancel() { return { requested: true, acknowledged: true, outcome: result } },
          async reconcile() { return { outcome: "unknown", isolationEstablished: false, domainState: "unknown", integrity: "unknown" } },
        }
      } }
      const q = createQueue(f.runtime)
      q.add(S, [{ title: "cancel check", verify: verify("check_never_run.sh", "exit 0") }])
      const run = q.run(S)
      if (signal === "cancelled") {
        await waitFor(() => runCalls === 1)
        await q.abort(S, "stop verifier")
      }
      expect(await run).toMatchObject({ aborted: true })
      expect(runCalls).toBe(1)
      expect(f.requests.map(request => request.role)).toEqual(["worker"])
      expect(existsSync(join(wt.worktree, "unmerged.py"))).toBe(false)
      const execution = f.runtime.runs.status().executions.find(record => record.kind === "verifier")!
      expect(execution).toMatchObject({ verifierDispatch: "started", fence: expect.anything() })
      expect(execution.terminal?.outcome).toBe(signal === "timeout" ? "timeout" :
        signal === "unknown-result" ? "unknown" : signal === "cancelled" || signal === "external-signal" ? "killed" : undefined)
      expect(execution.terminal?.verification).toMatchObject(signal === "timeout"
        ? { parentExit: null, cancelled: false, timedOut: true }
        : signal === "unknown-result" ? { parentExit: null, cancelled: false, timedOut: false }
          : { parentExit: null, cancelled: true, timedOut: false })
      expect(f.runtime.runs.status().claim).toBeDefined()
      expect(await q.run(S)).toMatchObject({ aborted: true, done: 0 })
      expect(f.requests.map(request => request.role)).toEqual(["worker"])
      expect(existsSync(join(wt.worktree, "unmerged.py"))).toBe(false)
      expect(verifierRequest).toBeDefined()
    })
  }

  test("aborting verifier preparation retires without dispatch and ignores late reference callbacks", async () => {
    const f = fixture({ delegate: { review: false } as LcaConfig["delegate"] })
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    const base = f.runtime.verifier
    let pendingRequest: VerificationRequest | undefined
    let releasePrepare!: (handle: VerificationHandle) => void
    let runCalls = 0
    let reconcileCalls = 0
    f.runtime.verifier = { ...base, async prepare(request) {
      pendingRequest = request
      return new Promise<VerificationHandle>(resolve => { releasePrepare = resolve })
    } }
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "prepare hangs", verify: verify("check_prepare.sh", "test -f README.md") }, { title: "pending" }])
    const run = q.run(S)
    await waitFor(() => pendingRequest !== undefined)
    await q.abort(S, "stop preparation")
    expect(await run).toMatchObject({ aborted: true, done: 0, cancelled: 2 })
    const retired = f.runtime.runs.status().executions.find(e => e.kind === "verifier")!
    expect(retired).toMatchObject({ verifierDispatch: "retired", terminal: { outcome: "not-dispatched" } })
    expect(retired.fence).toBeUndefined()
    expect(f.runtime.runs.status().claim).toBeUndefined()
    expect(readLedger(wt.worktree, S).tasks[1]?.status).toBe("cancelled")
    expect(f.requests.map(r => r.role)).toEqual(["worker"])

    const request = pendingRequest!
    const reference = {
      kind: "verifier" as const, profile: "legacy-unowned" as const, executionID: request.executionID,
      invocationID: "late-invocation", inputSnapshotID: request.inputSnapshotID, inputDigest: request.inputDigest,
      deadlineAt: request.deadlineAt, maxOutputChars: request.maxOutputChars,
    }
    request.onReference?.(reference)
    releasePrepare({
      reference,
      async run() { runCalls++; return legacyVerificationResult(request) },
      async requestCancel() { return { requested: false, acknowledged: false } },
      async reconcile() {
        reconcileCalls++
        return { outcome: "unknown", isolationEstablished: false, domainState: "unknown", integrity: "unknown" }
      },
    })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(runCalls).toBe(0)
    expect(reconcileCalls).toBe(0)
    expect(f.runtime.runs.status().executions.find(e => e.kind === "verifier")).toMatchObject({
      verifierDispatch: "retired", terminal: { outcome: "not-dispatched" },
    })
    expect(f.runtime.runs.status().executions.find(e => e.kind === "verifier")?.boundaryRef).toBeUndefined()
  })

  for (const failure of ["deadline", "prepare-error"] as const) {
    test(`verifier ${failure} before dispatch retires without a permanent fence`, async () => {
      const f = fixture({ delegate: { review: false, verify_timeout_ms: failure === "deadline" ? 20 : DEFAULT_CONFIG.delegate.verify_timeout_ms } as LcaConfig["delegate"] })
      f.replies.set("worker", () => ({ status: "completed", text: "done" }))
      const base = f.runtime.verifier
      f.runtime.verifier = { ...base, async prepare() {
        if (failure === "prepare-error") throw new Error("fixture prepare failure")
        return new Promise<VerificationHandle>(() => {})
      } }
      const q = createQueue(f.runtime)
      q.add(S, [{ title: "prepare failure", verify: verify("check_prepare_failure.sh", "test -f README.md") }])

      expect(await q.run(S)).toMatchObject({ aborted: true, done: 0 })
      const execution = f.runtime.runs.status().executions.find(record => record.kind === "verifier")!
      expect(execution).toMatchObject({ verifierDispatch: "retired", terminal: { outcome: "not-dispatched" } })
      expect(execution.fence).toBeUndefined()
      expect(f.runtime.runs.status().claim).toBeUndefined()
      expect(f.requests.map(request => request.role)).toEqual(["worker"])
    })
  }

  test("a prepared verifier returned after its deadline retires even when prepare beats the timer callback", async () => {
    const f = fixture({ delegate: { review: false, verify_timeout_ms: 40 } as LcaConfig["delegate"] })
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    const base = f.runtime.verifier
    let preparedAfterDeadline = false
    let runCalls = 0
    f.runtime.verifier = { ...base, async prepare(request) {
      const handle = await base.prepare(request)
      // Keep the event loop occupied past the deadline so the resolved prepare wins the
      // Promise.race microtask before the overdue timeout callback can run.
      const waitStartedAt = Date.now()
      while (Date.now() <= request.deadlineAt && Date.now() - waitStartedAt < 250) {}
      preparedAfterDeadline = Date.now() > request.deadlineAt
      return {
        ...handle,
        async run() { runCalls++; return legacyVerificationResult(request) },
      }
    } }
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "late prepared verifier", verify: verify("check_late_prepare.sh", "test -f README.md") }])

    expect(await q.run(S)).toMatchObject({
      aborted: true, done: 0, abortReason: expect.stringContaining("deadline expired before dispatch"),
    })
    expect(preparedAfterDeadline).toBe(true)
    expect(runCalls).toBe(0)
    expect(f.requests.map(request => request.role)).toEqual(["worker"])
    expect(f.runtime.runs.status().executions.find(execution => execution.kind === "verifier")).toMatchObject({
      verifierDispatch: "retired", terminal: { outcome: "not-dispatched" },
    })
    expect(f.runtime.runs.status().executions.find(execution => execution.kind === "verifier")?.fence).toBeUndefined()
    expect(f.runtime.runs.status().claim).toBeUndefined()
  })

  test("protected-file mutation restores original test and invalidates verification", async () => {
    write("test_lock.py", "def test_lock():\n    assert True\n")
    const f = fixture({ delegate: { review: false, max_attempts: 1 } as LcaConfig["delegate"] })
    f.replies.set("worker", () => { write("test_lock.py", "def test_lock():\n    assert False\n"); return { status: "completed", text: "done" } })
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "protected", verify: "python3 -m pytest -q test_lock.py" }])
    expect(await q.run(S)).toMatchObject({ failed: 1 })
    expect(readFileSync(join(wt.worktree, "test_lock.py"), "utf8")).toBe("def test_lock():\n    assert True\n")
    expect(readLedger(wt.worktree, S).tasks[0]?.verify_result?.output).toContain("protected file modified")
  })

  test("cancel interleaved with the final merge guard neither applies nor marks done", async () => {
    const f = fixture({ delegate: { worktree: true, review: false, max_attempts: 1 } as LcaConfig["delegate"] })
    f.replies.set("worker", (request) => {
      writeFileSync(join(request.cwd, "feature.py"), "VALUE = 1\n")
      return { status: "completed", text: "Files changed: feature.py\nOpen issues: none" }
    })
    const q = createQueue(f.runtime)
    const original = f.runtime.runs.assertQuiescent.bind(f.runtime.runs)
    let interrupted = false
    let guards = 0
    f.runtime.runs.assertQuiescent = (claim) => {
      original(claim)
      // The first assertion is queue startup; the second is the final merge guard.
      if (++guards === 2) {
        interrupted = true
        void q.abort(S, "cancel at merge guard")
      }
    }
    q.add(S, [{ title: "guarded merge", verify: verify("check_feature.sh", "test -f feature.py") }])
    expect(await q.run(S)).toMatchObject({ done: 0, cancelled: 1 })
    expect(interrupted).toBe(true)
    expect(existsSync(join(wt.worktree, "feature.py"))).toBe(false)
    expect(readLedger(wt.worktree, S).tasks[0]?.status).toBe("cancelled")
  })

  test("failed verification retries with a new generation-safe execution and preserves reason", async () => {
    const f = fixture({ delegate: { review: false, max_attempts: 2 } as LcaConfig["delegate"] })
    f.replies.set("worker", () => {
      if (f.requests.length === 2) write("ready.txt", "ready\n")
      return { status: "completed", text: "done" }
    })
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "retry", verify: verify("check_ready.sh", "test -f ready.txt") }])
    expect(await q.run(S)).toMatchObject({ done: 1 })
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1]?.text).toContain("previous worker already changed files")
    expect(f.requests[0]?.executionID).not.toBe(f.requests[1]?.executionID)
    expect(f.runtime.runs.status().executions.filter(execution => execution.kind === "verifier").map(execution => [execution.verifierDispatch, execution.terminal?.outcome]))
      .toEqual([["started", "fail"], ["started", "ok"]])
  })

  test("ACK without quiescence fences execution and blocks verifier and retry", async () => {
    const f = fixture({ delegate: { review: false, task_ttl_ms: 20 } as LcaConfig["delegate"] })
    f.setCancellation("ack-only")
    f.replies.set("worker", () => new Promise<ExecutionOutcome>(() => {}))
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "stuck", verify: verify("should_not_run.sh", "touch verifier-ran") }])
    expect(await q.run(S)).toMatchObject({ aborted: true })
    expect(f.requests).toHaveLength(1)
    expect(existsSync(join(wt.worktree, "verifier-ran"))).toBe(false)
    const state = f.runtime.runs.status()
    expect(state.executions[0]?.fence).toBeDefined()
    expect(typeof state.executions[0]?.cancel?.acknowledgedAt).toBe("number")
    expect(state.claim).toBeDefined()
    expect(await q.run(S)).toMatchObject({ aborted: true })
    expect(f.requests).toHaveLength(1)
  })

  test("timeout with affirmative terminal reconciliation can retry; policy is unbound only then", async () => {
    const f = fixture({ delegate: { review: false, max_attempts: 2, task_ttl_ms: 20 } as LcaConfig["delegate"] })
    let n = 0
    f.replies.set("worker", () => ++n === 1 ? new Promise<ExecutionOutcome>(() => {}) : { status: "completed", text: "done" })
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "timeout" }])
    expect(await q.run(S)).toMatchObject({ done: 1 })
    expect(f.requests).toHaveLength(2)
    expect(f.runtime.policy.handlersForSession("child_1")).toBeUndefined()
    expect(f.runtime.runs.status().claim).toBeUndefined()
  })

  test("missing data bridge refuses data tasks before ledger mutation", () => {
    const f = fixture()
    expect(() => createQueue(f.runtime).add(S, [{ title: "question", kind: "data" }])).toThrow("data checks unavailable")
    expect(readLedger(wt.worktree, S).tasks).toHaveLength(0)
  })

  test("external stop of a hanging child is bounded and cannot turn an ACK into completion", async () => {
    const f = fixture({ delegate: { review: false } as LcaConfig["delegate"] })
    f.setCancellation("ack-only")
    f.replies.set("worker", () => new Promise<ExecutionOutcome>(() => {}))
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "hang" }])
    const run = q.run(S)
    await waitFor(() => f.requests.length === 1)
    await q.abort(S, "stop")
    expect(f.runtime.runs.status().executions[0]?.fence).toBeDefined()
    // The deadline is configured by the runtime, not a fake terminal response from the host.
    expect(await run).toMatchObject({ aborted: true })
  })

  for (const reconciliation of ["settled", "unknown"] as const) {
    test(`run retains its claim until delayed cancellation bookkeeping finishes (${reconciliation})`, async () => {
      const f = fixture({ delegate: { review: false } as LcaConfig["delegate"] })
      if (reconciliation === "unknown") f.setReconciliation("unknown")
      let workerStarted = false
      let releaseWorker!: (outcome: ExecutionOutcome) => void
      f.replies.set("worker", () => {
        workerStarted = true
        return new Promise<ExecutionOutcome>(resolve => { releaseWorker = resolve })
      })
      let cancellationStarted!: () => void
      const cancellationRequestStarted = new Promise<void>(resolve => { cancellationStarted = resolve })
      let releaseCancellation!: () => void
      const cancellationAck = new Promise<void>(resolve => { releaseCancellation = resolve })
      f.setRequestCancelWait(async () => {
        cancellationStarted()
        await cancellationAck
      })
      const q = createQueue(f.runtime)
      q.add(S, [{ title: "delayed cancellation" }])
      let runSettled = false
      const run = q.run(S).then(result => { runSettled = true; return result }, error => {
        runSettled = true
        throw error
      })
      await waitFor(() => workerStarted)
      const abort = q.abort(S, "delayed stop")
      await cancellationRequestStarted
      releaseWorker({ status: "cancelled", text: "cancelled" })
      await waitFor(() => readLedger(wt.worktree, S).tasks[0]?.status === "cancelled")
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(runSettled).toBe(false)
      expect(q.isRunning(S)).toBe(true)
      expect(f.runtime.runs.status().claim).toBeDefined()

      releaseCancellation()
      await expect(abort).resolves.toBeUndefined()
      expect(await run).toMatchObject({ aborted: true, cancelled: reconciliation === "settled" ? 1 : 0 })
      const state = f.runtime.runs.status()
      expect(f.events).not.toContain("child abort failed")
      expect(f.events).not.toContain("queue claim release failed")
      if (reconciliation === "settled") {
        expect(state.claim).toBeUndefined()
        expect(state.executions[0]?.fence).toBeUndefined()
      } else {
        expect(state.claim).toBeDefined()
        expect(state.executions[0]?.fence).toBeDefined()
      }
    })
  }

  test("external stop while session creation hangs returns and fences without dispatching work", async () => {
    const f = fixture()
    f.setPrepareWait(() => new Promise<void>(() => {}))
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "prepare hang" }])
    const run = q.run(S)
    await waitFor(() => f.requests.length === 1)
    await q.abort(S, "user_stop")
    expect(await run).toMatchObject({ aborted: true, abortReason: "user_stop" })
    expect(f.runtime.runs.status().executions[0]?.fence).toBeDefined()
    expect(f.runtime.runs.status().executions[0]?.cancel?.requestedAt).toBeNumber()
    expect(f.runtime.runs.status().claim).toBeDefined()
    expect(readLedger(wt.worktree, S).tasks[0]?.status).toBe("cancelled")
  })
})

describe("prompt and reviewer contracts", () => {
  test("worker retry prompt counts the batch and reviewer prompt carries full scope", () => {
    let { ledger } = addTasks(emptyLedger(S), [{ title: "a", verify: "bun test test/a.test.ts" }, { title: "b" }])
    ledger = addTasks(ledger, [{ title: "c" }]).ledger
    const p = workerPrompt(ledger, ledger.tasks[0]!, "verify failed", 600)
    expect(p).toContain("Reason: verify failed")
    expect(p).toContain("The framework will run this verification after your edits; do not run it: bun test test/a.test.ts")
    expect(p).not.toContain("Run this once before you finish")
    expect(p).toContain("Never invoke Bash or run tests")
    expect(workerPrompt(ledger, ledger.tasks[2]!, undefined, 600)).toContain("Task 1 of 1: c")
    expect(reviewerPrompt(ledger.tasks[0]!, "+x", undefined)).toContain("Verification: none provided")
  })
  test("verdict parser rejects prose and rule recitals, accepts explicit verdicts", () => {
    expect(parseVerdict("ACCEPT")).toEqual({ verdict: "accept" })
    expect(parseVerdict("**Verdict:** REJECT: test-aware code")).toEqual({ verdict: "reject", reason: "test-aware code" })
    expect(parseVerdict("REJECT when tests fail.\nLooks fine").verdict).toBe("error")
    expect(parseVerdict("Looks good to me").verdict).toBe("error")
  })
})
