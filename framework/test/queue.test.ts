import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG, type LcaConfig } from "../src/config.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionHandle, ExecutionOutcome, ExecutionReconciliation, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { createQueue, getQueue, parseVerdict, reviewerPrompt, workerPrompt } from "../src/orchestration/queue.ts"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"
import { createSnapshotStore } from "../src/orchestration/snapshot.ts"
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
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "verified", verify: verify("check_first.sh", "test -f README.md") }, { title: "next" }])
    expect(await q.run(S)).toMatchObject({ done: 2 })
    const [worker, verifier, next] = f.runtime.runs.status().executions
    expect(worker).toMatchObject({ kind: "host", profile: "legacy-unowned" })
    expect(verifier).toMatchObject({ kind: "verifier", profile: "legacy-unowned", descendantRisk: "unproven", terminal: { outcome: "ok", verification: { parentExit: 0, isolationEstablished: false, domainState: "unknown", integrity: "unchanged" } } })
    expect(verifier?.boundaryRef).toMatchObject({ kind: "verifier", inputSnapshotID: verifier?.inputSnapshotID, inputDigest: verifier?.inputDigest })
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

  test("dead-owner legacy missing terminal becomes unknown and repairs the running task", async () => {
    const f = fixture({ delegate: { review: false } as LcaConfig["delegate"] })
    const q = createQueue(f.runtime)
    const [task] = q.add(S, [{ title: "restart" }])
    const old = f.runtime.runs.claim(S, "dead-owner", 99999999)
    f.runtime.runs.registerIntent(old, {
      executionId: "orphan-verifier", ownerSession: S, taskId: task!.id, attemptId: "old-attempt",
      generation: old.generation, role: "verifier", cwd: wt.worktree, policyID: "verify-command",
      kind: "verifier", profile: "legacy-unowned", inputSnapshotID: "old-tree", inputDigest: "a".repeat(64),
      deadlineAt: Date.now() + 1000, maxOutputChars: 1500,
    })
    writeLedger(wt.worktree, { ...updateTask(readLedger(wt.worktree, S), task!.id, { status: "running", attempts: 1 }),
      running: { taskId: task!.id, since: Date.now() } })
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    expect(await q.run(S)).toMatchObject({ done: 1 })
    expect(f.requests).toHaveLength(1)
    expect(readLedger(wt.worktree, S).tasks[0]?.attempts).toBe(1)
    expect(f.runtime.runs.status().executions[0]).toMatchObject({ terminal: { outcome: "unknown" }, descendantRisk: "unproven" })
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

  test("Linux unknown integrity cannot become a pass from equal worktree snapshots", async () => {
    const f = fixture({ delegate: { review: false, max_attempts: 1 } as LcaConfig["delegate"] })
    f.runtime.verificationProfile = "linux-single-use"
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    const base = createLegacyVerifierExecutor()
    f.runtime.verifier = {
      ...base,
      async preflight() { return { compatible: true, problems: [] } },
      async prepare(request) {
        const reference = { kind: "verifier" as const, profile: "linux-single-use" as const, executionID: request.executionID,
          invocationID: "test-invocation", inputSnapshotID: request.inputSnapshotID, inputDigest: request.inputDigest,
          deadlineAt: request.deadlineAt, maxOutputChars: request.maxOutputChars, unit: "test-unit", bootID: "test-boot", cgroupInode: "123" }
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
    expect(await q.run(S)).toMatchObject({ done: 0, failed: 1 })
    expect(readLedger(wt.worktree, S).tasks[0]?.verify_result?.ok).toBe(false)
    expect(f.runtime.runs.status().executions.find(e => e.kind === "verifier")?.terminal?.verification?.integrity).toBe("unknown")
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
      unit: "old-unit", bootID: "old-boot", cgroupInode: "123" })
    f.runtime.verifier = { ...f.runtime.verifier, reconcile: async () => new Promise<never>(() => {}) }
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "still pending" }])
    expect(await q.run(S)).toMatchObject({ aborted: true, done: 0 })
    expect(f.requests).toHaveLength(0)
    expect(readLedger(wt.worktree, S).tasks[0]?.status).toBe("pending")
    expect(f.runtime.runs.status().claim).toBeDefined()
    expect(f.runtime.runs.status().executions[0]?.fence).toBeDefined()
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

  test("cancelled legacy verifier records a terminal, never passes, and does not review", async () => {
    const f = fixture({ delegate: { review: true, max_attempts: 1 } as LcaConfig["delegate"] })
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "cancel check", verify: verify("check_slow.sh", "touch verifier-started; sleep 10") }])
    const run = q.run(S)
    await waitFor(() => existsSync(join(wt.worktree, "verifier-started")))
    await q.abort(S, "stop verifier")
    expect(await run).toMatchObject({ done: 0, cancelled: 1 })
    expect(readLedger(wt.worktree, S).tasks[0]?.verify_result?.ok).not.toBe(true)
    expect(f.requests.map(r => r.role)).toEqual(["worker"])
    expect(f.runtime.runs.status().executions.find(e => e.kind === "verifier")?.terminal?.verification?.cancelled).toBe(true)
  })

  test("aborting verifier preparation fences the claim without cancelling pending ledger tasks", async () => {
    const f = fixture({ delegate: { review: false } as LcaConfig["delegate"] })
    f.replies.set("worker", () => ({ status: "completed", text: "done" }))
    const base = f.runtime.verifier
    f.runtime.verifier = { ...base, prepare: async () => new Promise(() => {}) }
    const q = createQueue(f.runtime)
    q.add(S, [{ title: "prepare hangs", verify: verify("check_prepare.sh", "test -f README.md") }, { title: "pending" }])
    const run = q.run(S)
    await waitFor(() => f.runtime.runs.status().executions.some(e => e.kind === "verifier"))
    await q.abort(S, "stop preparation")
    expect(await run).toMatchObject({ aborted: true, done: 0 })
    expect(f.runtime.runs.status().claim).toBeDefined()
    expect(f.runtime.runs.status().executions.find(e => e.kind === "verifier")?.fence).toBeDefined()
    expect(readLedger(wt.worktree, S).tasks[1]?.status).toBe("pending")
    expect(f.requests.map(r => r.role)).toEqual(["worker"])
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
