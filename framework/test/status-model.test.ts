import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { classifyQueue, renderStatusDetail, renderStatusSnapshot, STATUS_LIMITS, statusBytesRead, statusJson, StatusReadError, type QueueProjection } from "../src/flow/status.ts"
import { appendEvents as appendEventsTx, eventsPath, flowDir, newWorkflow as createWorkflow, parseWorkflow, readEventsTail, workflowPath, withFlowTransaction, type Workflow } from "../src/flow/state.ts"
import { writeWorkflow, publishWorkflow, writeRawSnapshot , committedSnapshotBytes } from "./commit-fixture.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { addTasks, emptyLedger, ledgerPath, parseLedger, updateTask, writeLedger, type LedgerTask } from "../src/state/ledger.ts"
import { executionRunDirectory, parseModeState, readBoundedJson, stateRoot } from "../src/state/store.ts"
import { createExecutionRunStore, type ExecutionRecord } from "../src/hosts/run-state.ts"
import { tempWorktree } from "./guards-helpers.ts"

const SESSION = "ses_status"
const ENGINE = "opencode"
let wt: ReturnType<typeof tempWorktree>
afterEach(() => wt?.cleanup())

function setup() {
  wt = tempWorktree()
  return { worktree: wt.worktree, config: DEFAULT_CONFIG, log: () => {} }
}

function newStatusWorkflow(sessionID: string, owner: Workflow["owner"], entry: Workflow["entry"], request: string, now?: number) {
  return createWorkflow(sessionID, owner, entry, request, ENGINE, now)
}

function writeStatusWorkflow(worktree: string, workflow: Workflow, now?: number) {
  return withFlowTransaction(worktree, tx => writeWorkflow(tx, workflow, now))
}

function appendStatusEvents(worktree: string, events: Parameters<typeof appendEventsTx>[1]) {
  return withFlowTransaction(worktree, tx => appendEventsTx(tx, events))
}

describe("status v1 model", () => {
  test("is SDK-free, resolves no-session honestly, and does not create a state root", () => {
    const deps = setup()
    const status = statusJson(deps)
    expect(status.schemaVersion).toBe(1)
    expect(status.session).toMatchObject({ id: "no-session", source: "none", queue: { state: "unknown", evidence: "no_session" } })
    expect(status.session.queueRunning).toBe(false)
    expect(status.execution.usage).toBe("unknown")
    expect(statusJson(deps, SESSION).freshness.ledgerUpdatedAt).toBeUndefined()
    expect(existsSync(stateRoot(wt.worktree))).toBe(false)
  })

  test("resolves an omitted session from the workflow and reports truthful timestamps", () => {
    const deps = setup()
    const wf = writeStatusWorkflow(wt.worktree, newStatusWorkflow(SESSION, currentOwner(), "command", "request", 500), 500)
    const status = statusJson(deps, undefined, { now: 700 })
    expect(status.session).toMatchObject({ id: SESSION, source: "workflow" })
    expect(status.freshness).toMatchObject({ workflowUpdatedAt: 500, ownerHeartbeatAgeMs: expect.any(Number), staleAfterMs: 90_000 })
    expect(status.generatedAt).toBe(700)
    expect(wf.updatedAt).toBe(500)
  })

  test("foreign status reports the actual owner liveness without taking over", () => {
    const deps = setup()
    const dead = newStatusWorkflow(SESSION, { instance: "dead-instance", pid: 9_999_999}, "command", "request")
    writeStatusWorkflow(wt.worktree, dead)
    expect(statusJson(deps, "ses_viewer").workflow?.ownerLive).toBe(false)
    writeLedger(wt.worktree, emptyLedger(SESSION))
    writeStatusWorkflow(wt.worktree, newStatusWorkflow(SESSION, currentOwner(), "command", "request"))
    expect(statusJson(deps, "ses_viewer").workflow?.ownerLive).toBe(true)
  })

  test("orphan queue pointers are reported stale and never repaired by status", () => {
    const deps = setup()
    const ledger = { ...emptyLedger(SESSION), running: { taskId: "missing-task", since: 100 } }
    writeLedger(wt.worktree, ledger)
    const runs = createExecutionRunStore(wt.worktree)
    runs.claim(SESSION, "test", process.pid)
    const ledgerPathname = ledgerPath(wt.worktree, SESSION)
    const runPathname = join(executionRunDirectory(wt.worktree), "state.json")
    const ledgerBefore = readFileSync(ledgerPathname)
    const runBefore = readFileSync(runPathname)
    const status = statusJson(deps, SESSION, { now: 200 })
    expect(status.session.queue).toMatchObject({ state: "stale", evidence: "claim_retained_here_inactive+no_open_tasks", taskId: "missing-task", ageMs: 100 })
    expect(readFileSync(ledgerPathname)).toEqual(ledgerBefore)
    expect(readFileSync(runPathname)).toEqual(runBefore)
  })

  test("orphan pointers with no open work show the notice without suggesting resume", () => {
    const deps = setup()
    const created = addTasks(emptyLedger(SESSION), [{ title: "finished" }])
    const failed = updateTask(created.ledger, created.added[0]!.id, { status: "failed" })
    writeLedger(wt.worktree, { ...failed, running: { taskId: "missing-task", since: 100 } })
    const status = statusJson(deps, SESSION, { now: 200 })
    const text = renderStatusSnapshot(status, SESSION)
    expect(status.session.queue).toMatchObject({ state: "stale", evidence: "running_without_matching_claim+no_open_tasks" })
    expect(status.session.queue.hint).toBeUndefined()
    expect(text).toContain("no pending work. Status does not change it.")
    expect(text).not.toContain("resume")
  })

  test("same-process orphan claim with no open work never suggests resume", () => {
    const deps = setup()
    const created = addTasks(emptyLedger(SESSION), [{ title: "finished" }])
    const task = created.added[0]!
    const failed = updateTask(created.ledger, task.id, { status: "failed" })
    writeLedger(wt.worktree, { ...failed, running: { taskId: task.id, since: 100 } })
    createExecutionRunStore(wt.worktree).claim(SESSION, "status-model", process.pid)

    const status = statusJson(deps, SESSION, { now: 200 })
    expect(status.session.queue).toMatchObject({
      state: "stale", evidence: "claim_retained_here_inactive+no_open_tasks", taskId: task.id,
    })
    expect(status.session.queue.hint).toBeUndefined()
    expect(renderStatusSnapshot(status, SESSION)).not.toContain("resume")
  })

  test("covers the complete flag, pointer, and claim truth matrix", () => {
    type Input = Parameters<typeof classifyQueue>[0]
    const base: Input = { sessionID: SESSION, now: 1000, openTaskCount: 1, claimLive: false, sameProcess: false, executions: [] }
    const claimRows = [
      { id: "absent", claim: undefined, claimLive: false, sameProcess: false },
      { id: "live-same-pid", claim: { ownerSession: SESSION, pid: process.pid }, claimLive: true, sameProcess: true },
      { id: "live-other-pid", claim: { ownerSession: SESSION, pid: process.pid + 1000 }, claimLive: true, sameProcess: false },
      { id: "dead", claim: { ownerSession: SESSION, pid: 999_999_999 }, claimLive: false, sameProcess: false },
    ]
    const expectedWithoutFlag: Record<string, Pick<QueueProjection, "state" | "evidence" | "hint">> = {
      "absent/absent": { state: "idle", evidence: "no_running" },
      "absent/live-same-pid": { state: "unknown", evidence: "claim_alive_no_task" },
      "absent/live-other-pid": { state: "unknown", evidence: "claim_alive_no_task" },
      "absent/dead": { state: "idle", evidence: "claim_pid_dead" },
      "present/absent": { state: "stale", evidence: "running_without_matching_claim", hint: "resume runs the pending work; the pointer is replaced at the next task start" },
      "present/live-same-pid": { state: "stale", evidence: "claim_retained_here_inactive", hint: "resume" },
      "present/live-other-pid": { state: "running_elsewhere", evidence: "claim_pid_alive" },
      "present/dead": { state: "stale", evidence: "claim_pid_dead", hint: "resume" },
    }

    for (const inProcess of [true, false, undefined] as const) {
      for (const hasRunning of [false, true]) {
        for (const claimCase of claimRows) {
          const key = `${hasRunning ? "present" : "absent"}/${claimCase.id}`
          const expected: Pick<QueueProjection, "state" | "evidence" | "hint"> = inProcess === true
            ? { state: "running_here", evidence: "in_process_flag" }
            : expectedWithoutFlag[key]!
          const flag = inProcess === undefined ? "absent" : inProcess ? "true" : "false"
          const input: Input = {
            ...base, inProcess, claim: claimCase.claim, claimLive: claimCase.claimLive, sameProcess: claimCase.sameProcess,
            ...(hasRunning ? { running: { taskId: "t1", since: 100 }, taskStatus: "running" as const } : {}),
          }
          expect(classifyQueue(input), `${String(inProcess)} / ${key}`).toEqual({
            ...expected, flag, ...(hasRunning ? { taskId: "t1", since: 100, ageMs: 900 } : {}),
          })
        }
      }
    }
    expect(classifyQueue({ ...base, sessionID: undefined, inProcess: true })).toEqual({
      state: "unknown", evidence: "no_session", flag: "true", hint: "pass --session",
    })
  })

  test("pins precedence modifiers, task statuses, review, cancellation, and orphan hints", () => {
    type Input = Parameters<typeof classifyQueue>[0]
    const base: Input = { sessionID: SESSION, now: 1000, openTaskCount: 1, claimLive: true, sameProcess: false, executions: [] }
    const live = { ownerSession: SESSION, pid: process.pid + 1000 }
    const execution = (fields: Record<string, unknown>): ExecutionRecord => ({
      executionId: "execution", ownerSession: SESSION, taskId: "t1", attemptId: "attempt", generation: 1,
      role: "worker", cwd: "/tmp", policyID: "fixture", kind: "host", engine: ENGINE, profile: "legacy-unowned", ...fields,
    }) as ExecutionRecord
    const running = { taskId: "t1", since: 100 }
    const queue = (input: Partial<Input>): QueueProjection => classifyQueue({ ...base, ...input })
    const expected = (state: QueueProjection["state"], evidence: string, hint?: string, withTask = true,
      flag: QueueProjection["flag"] = "absent"): QueueProjection => ({
      state, evidence, flag, ...(withTask ? { taskId: "t1", since: 100, ageMs: 900 } : {}), ...(hint ? { hint } : {}),
    })

    expect(queue({ inProcess: true, running, taskStatus: "running", claim: live, executions: [execution({ fence: { reason: "unknown", at: 1 } })] }))
      .toEqual(expected("running_here", "in_process_flag", undefined, true, "true"))
    expect(queue({ running, taskStatus: "running", claim: live, executions: [execution({ reconciliation: { outcome: "running", quiescent: false, evidence: "still running", at: 1 } })] }))
      .toEqual(expected("blocked", "claim_retained_unresolved", "resume re-attempts reconciliation; it refuses if quiescence cannot be proven"))
    expect(queue({ running, taskStatus: "running", claim: live, executions: [execution({ reconciliation: { outcome: "terminal", quiescent: false, evidence: "not quiescent", at: 1 } })] }))
      .toEqual(expected("blocked", "claim_retained_unresolved", "resume re-attempts reconciliation; it refuses if quiescence cannot be proven"))
    expect(queue({ claim: live, executions: [execution({ reconciliation: { outcome: "terminal", quiescent: false, evidence: "not quiescent", at: 1 } })] }))
      .toEqual(expected("blocked", "claim_retained_unresolved", "resume re-attempts reconciliation; it refuses if quiescence cannot be proven", false))
    expect(queue({ running, taskStatus: "running", claim: live, executions: [execution({ cancel: { requestedAt: 1 } })] }))
      .toEqual(expected("running_elsewhere", "claim_pid_alive+cancel_requested"))
    expect(queue({ running, taskStatus: "running", claim: { ...live, pid: 999_999_999 }, claimLive: false, executions: [execution({ cancel: { requestedAt: 1 } })] }))
      .toEqual(expected("blocked", "dead_owner_unresolved", "resume re-attempts reconciliation; it refuses if quiescence cannot be proven"))
    expect(queue({ claim: live, executions: [execution({ cancel: { requestedAt: 1 } })], workflowSessionID: SESSION, workflowPhase: "reviewing" }))
      .toEqual(expected("unknown", "claim_alive_no_task+cancel_requested+phase_reviewing", undefined, false))
    expect(queue({ claim: live, workflowSessionID: SESSION, workflowPhase: "reviewing" }))
      .toEqual(expected("unknown", "claim_alive_no_task+phase_reviewing", undefined, false))
    expect(queue({ claim: live, workflowSessionID: "ses_foreign", workflowPhase: "reviewing" }))
      .toEqual(expected("unknown", "claim_alive_no_task", undefined, false))
    expect(queue({ running, taskStatus: "running", claim: { ownerSession: "ses_foreign", pid: process.pid + 1000 }, claimLive: true }))
      .toEqual(expected("stale", "running_without_matching_claim", "resume runs the pending work; the pointer is replaced at the next task start"))
    expect(queue({ claim: { ownerSession: "ses_foreign", pid: process.pid + 1000 }, claimLive: true }))
      .toEqual(expected("idle", "claim_other_session", undefined, false))

    for (const taskStatus of ["failed", "cancelled", "done", "pending", undefined] as const) {
      expect(queue({ running, taskStatus, claim: live })).toEqual(expected(
        "stale", "running_pointer_orphaned", "resume runs the pending work; the pointer is replaced at the next task start",
      ))
    }
    expect(queue({ running, taskStatus: "failed", claim: undefined, claimLive: false }))
      .toEqual(expected("stale", "running_without_matching_claim", "resume runs the pending work; the pointer is replaced at the next task start"))
    expect(queue({ running, taskStatus: "failed", claim: undefined, claimLive: false, openTaskCount: 0 }))
      .toEqual(expected("stale", "running_without_matching_claim+no_open_tasks"))
    expect(queue({ running, taskStatus: "cancelled", claim: live, openTaskCount: 0 }))
      .toEqual(expected("stale", "running_pointer_orphaned+no_open_tasks"))
  })

  test("statusJson queueRunning follows the actual queue projection for each state", () => {
    const deps = setup()
    const reset = () => {
      rmSync(stateRoot(wt.worktree), { recursive: true, force: true })
      rmSync(join(executionRunDirectory(wt.worktree), "state.json"), { force: true })
    }
    const writeRunning = (status: "running" | "failed" = "running", taskID = "t1") => {
      const created = addTasks(emptyLedger(SESSION), [{ title: "queue state" }])
      const task = { ...created.added[0]!, id: taskID, status }
      writeLedger(wt.worktree, { ...created.ledger, tasks: [task], ...(status === "running" ? { running: { taskId: taskID, since: 100 } } : {}) })
    }
    const makeClaim = (ownerSession: string, pid: number) => createExecutionRunStore(wt.worktree).claim(ownerSession, "status-model", pid)
    const cases: Array<{ name: string; setup: () => Parameters<typeof statusJson>[2]; state: QueueProjection["state"]; running: boolean }> = [
      { name: "running_here", setup: () => ({ queueRunning: true }), state: "running_here", running: true },
      { name: "running_elsewhere", setup: () => { writeRunning(); makeClaim(SESSION, process.pid + 1000); return { liveness: { claimPidAlive: () => true } } }, state: "running_elsewhere", running: true },
      { name: "stale", setup: () => { writeRunning(); return {} }, state: "stale", running: false },
      { name: "blocked", setup: () => {
        writeRunning()
        const runs = createExecutionRunStore(wt.worktree)
        const claim = runs.claim(SESSION, "status-model", process.pid + 1000)
        runs.registerIntent(claim, { executionId: "fenced", ownerSession: SESSION, taskId: "t1", attemptId: "attempt", generation: claim.generation,
          role: "worker", cwd: wt.worktree, policyID: "fixture", kind: "host", engine: ENGINE, profile: "legacy-unowned" })
        runs.fence(claim, "fenced", "unresolved")
        return { liveness: { claimPidAlive: () => true } }
      }, state: "blocked", running: false },
      { name: "unknown", setup: () => { makeClaim(SESSION, process.pid + 1000); return { liveness: { claimPidAlive: () => true } } }, state: "unknown", running: false },
      { name: "foreign claim is idle", setup: () => { makeClaim("ses_foreign", process.pid + 1000); return { liveness: { claimPidAlive: () => true } } }, state: "idle", running: false },
    ]
    for (const row of cases) {
      reset()
      const options = row.setup()
      const status = statusJson(deps, SESSION, options)
      expect(status.session.queue.state, row.name).toBe(row.state)
      expect(status.session.queueRunning, row.name).toBe(row.running)
    }
  })

  test("surfaces bounded malformed-state errors without exposing file content or mutating it", () => {
    const deps = setup()
    mkdirSync(join(stateRoot(wt.worktree), "workflow"), { recursive: true })
    const path = workflowPath(wt.worktree)
    const secret = "DO_NOT_LEAK_THIS_JSON_CONTENT"
    writeFileSync(path, JSON.stringify({ secret }))
    const before = readFileSync(path)
    let error: unknown
    try { statusJson(deps, SESSION) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(StatusReadError)
    expect(error).toMatchObject({ source: "workflow", code: "invalid_state" })
    expect((error as Error).message).not.toContain(secret)
    expect(readFileSync(path)).toEqual(before)
  })

  test("rejects invalid stuck causes, review notes, and nested ledger fields", () => {
    const deps = setup()
    const workflow = newStatusWorkflow(SESSION, currentOwner(), "command", "request")
    const badWorkflows = [
      { ...workflow, stuckCause: "secret-invalid-cause" },
      { ...workflow, review: { verdict: "none", findings: [], planSha: "a".repeat(64), note: "secret-invalid-note" } },
    ]
    mkdirSync(join(stateRoot(wt.worktree), "workflow"), { recursive: true })
    for (const invalid of badWorkflows) {
      expect(() => parseWorkflow(invalid)).toThrow("invalid workflow state")
      writeRawSnapshot(wt.worktree, invalid, { id: workflow.id, sessionID: SESSION })
      expect(() => statusJson(deps, SESSION)).toThrow(expect.objectContaining({ source: "workflow", code: "invalid_state" }))
    }

    publishWorkflow(wt.worktree, workflow)
    const created = addTasks(emptyLedger(SESSION), [{ title: "nested fields" }])
    const task = created.added[0]!
    writeLedger(wt.worktree, created.ledger)
    const invalidLedgers = [
      { ...created.ledger, tasks: [{ ...task, verify_result: { command: "verify", ok: true, exitCode: "0", timedOut: false, output: "ok" } }] },
      { ...created.ledger, tasks: [{ ...task, review: { verdict: "accept", aborted: "no" } }] },
      { ...created.ledger, tasks: [{ ...task, filesChanged: ["valid", 3] }] },
    ]
    for (const invalid of invalidLedgers) {
      expect(() => parseLedger(invalid, SESSION)).toThrow("invalid ledger state")
      writeFileSync(ledgerPath(wt.worktree, SESSION), JSON.stringify(invalid))
      expect(() => statusJson(deps, SESSION)).toThrow(expect.objectContaining({ source: "ledger", code: "invalid_state" }))
    }
  })

  test("projects only the four approved workflow counter fields", () => {
    const deps = setup()
    const workflow = newStatusWorkflow(SESSION, currentOwner(), "command", "request")
    const secret = "PRIVATE_COUNTER_PAYLOAD\nunapproved text"
    const stored = { ...workflow, counters: { ...workflow.counters, privateNote: secret } }
    writeStatusWorkflow(wt.worktree, stored)
    const status = statusJson(deps, SESSION, { detail: true })
    expect(status.workflow?.counters).toEqual(workflow.counters)
    for (const output of [JSON.stringify(status), renderStatusSnapshot(status), renderStatusDetail(status)]) {
      expect(output).not.toContain("PRIVATE_COUNTER_PAYLOAD")
      expect(output).not.toContain("privateNote")
    }
  })

  test("bounds oversize workflow and task identifiers in status output", () => {
    const deps = setup()
    // Intended P5a schema change: workflow and session IDs are path components of the snapshot layout, so they are
    // bounded to 128 filesystem-safe characters; task IDs remain unbounded input and keep the 4096-char case.
    const workflowID = `wf_${"w".repeat(125)}`
    writeStatusWorkflow(wt.worktree, { ...newStatusWorkflow(SESSION, currentOwner(), "command", "request"), id: workflowID })
    const created = addTasks(emptyLedger(SESSION), [{ title: "long task id" }])
    const taskID = "t".repeat(4096)
    const task = { ...created.added[0]!, id: taskID, status: "running" as const, attempts: 1 }
    writeLedger(wt.worktree, { ...created.ledger, tasks: [task], running: { taskId: taskID, since: 100 } })

    const status = statusJson(deps, SESSION)
    expect(status.workflow?.id).toBe(workflowID)
    expect(status.session.queue.taskId).toBe(taskID.slice(0, 80))
    expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThan(STATUS_LIMITS.detailOutput)
  })

  test("rejects oversize workflow, mode, and ledger files with source-specific errors", () => {
    const deps = setup()
    const root = stateRoot(wt.worktree)
    mkdirSync(join(root, "workflow"), { recursive: true })
    writeFileSync(workflowPath(wt.worktree), " ".repeat(STATUS_LIMITS.workflow + 1))
    expect(() => statusJson(deps, SESSION)).toThrow(expect.objectContaining({ source: "workflow", code: "oversize" }))
    publishWorkflow(wt.worktree, newStatusWorkflow(SESSION, currentOwner(), "command", "request"))
    const modePath = join(root, "sessions", SESSION, "mode.json")
    mkdirSync(join(root, "sessions", SESSION), { recursive: true })
    writeFileSync(modePath, " ".repeat(STATUS_LIMITS.mode + 1))
    expect(() => statusJson(deps, SESSION)).toThrow(expect.objectContaining({ source: "mode", code: "oversize" }))
    writeFileSync(modePath, JSON.stringify({ mode: "none", active: false, startedAt: 0, updatedAt: 0, iterations: 0, stagnation: 0, failures: 0 }))
    writeFileSync(ledgerPath(wt.worktree, SESSION), " ".repeat(STATUS_LIMITS.ledger + 1))
    expect(() => statusJson(deps, SESSION)).toThrow(expect.objectContaining({ source: "ledger", code: "oversize" }))
    writeLedger(wt.worktree, emptyLedger(SESSION))
    const executionDir = executionRunDirectory(wt.worktree)
    mkdirSync(executionDir, { recursive: true })
    writeFileSync(join(executionDir, "state.json"), " ".repeat(STATUS_LIMITS.execution + 1))
    expect(() => statusJson(deps, SESSION)).toThrow(expect.objectContaining({ source: "execution", code: "oversize" }))
  })

  test("execution-store I/O failures remain unreadable rather than corrupt", () => {
    const deps = setup()
    const executionFile = join(executionRunDirectory(wt.worktree), "state.json")
    mkdirSync(executionFile, { recursive: true })
    let error: unknown
    try { statusJson(deps, SESSION) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(StatusReadError)
    expect(error).toMatchObject({ source: "execution", code: "unreadable" })
  })

  test("detail exposes allowlisted task facts only and enforces task/output caps", () => {
    const deps = setup()
    const created = addTasks(emptyLedger(SESSION), Array.from({ length: 55 }, (_, index) => ({ title: `Task ${index}`, detail: "secret detail" })))
    const last = created.added.at(-1)!
    const dirty = updateTask(created.ledger, last.id, {
      status: "failed", blocked: "secret blocked text", error: "secret error", report: "secret report", sql: "secret sql", answer: "secret answer",
      handoff: "secret handoff", workerSessionID: "secret worker", filesChanged: ["secret/path"],
      verify_result: { command: "secret command", output: "secret verifier output", ok: false, exitCode: 1, timedOut: false },
      review: { verdict: "reject", reason: "secret review reason", sessionID: "secret reviewer" },
    })
    writeLedger(wt.worktree, dirty)
    const status = statusJson(deps, SESSION, { detail: true })
    const serialized = renderStatusDetail(status)
    expect(status.detail?.tasks).toHaveLength(50)
    expect(status.detail?.truncated.tasks).toBe(5)
    expect(status.detail?.truncatedTasks).toBe(5)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(STATUS_LIMITS.detailOutput)
    for (const secret of ["secret detail", "secret blocked text", "secret error", "secret report", "secret sql", "secret answer", "secret handoff", "secret worker", "secret/path", "secret command", "secret verifier output", "secret review reason", "secret reviewer"]) {
      expect(serialized).not.toContain(secret)
    }
    expect(status.detail?.tasks.at(-1)).toMatchObject({ blocked: true, outcome: "blocked", filesChangedCount: 1 })
  })

  test("detail outcome enum follows every derivation branch and precedence", () => {
    const deps = setup()
    const cases: Array<{ name: string; status: LedgerTask["status"]; patch?: Partial<LedgerTask>; outcome?: string }> = [
      { name: "blocked wins", status: "failed", patch: {
        blocked: "", verify_result: { command: "verify", output: "output", ok: false, exitCode: 1, timedOut: true },
        review: { verdict: "error" },
      }, outcome: "blocked" },
      { name: "timeout wins", status: "failed", patch: {
        verify_result: { command: "verify", output: "output", ok: false, exitCode: 1, timedOut: true },
        review: { verdict: "reject" },
      }, outcome: "verify_timeout" },
      { name: "verify failure wins", status: "cancelled", patch: {
        verify_result: { command: "verify", output: "output", ok: false, exitCode: 1, timedOut: false },
        review: { verdict: "reject" },
      }, outcome: "verify_failed" },
      { name: "review rejection wins", status: "failed", patch: { review: { verdict: "reject" } }, outcome: "review_rejected" },
      { name: "review error wins", status: "cancelled", patch: { review: { verdict: "error" } }, outcome: "review_error" },
      { name: "cancelled", status: "cancelled", outcome: "cancelled" },
      { name: "failed otherwise", status: "failed", outcome: "failed_other" },
      { name: "no outcome", status: "pending" },
    ]
    const created = addTasks(emptyLedger(SESSION), cases.map(({ name }) => ({ title: name })))
    let ledger = created.ledger
    for (const [index, row] of cases.entries()) {
      const task = created.added[index]!
      ledger = updateTask(ledger, task.id, { status: row.status, ...row.patch })
    }
    writeLedger(wt.worktree, ledger)

    const tasks = statusJson(deps, SESSION, { detail: true }).detail!.tasks
    for (const [index, row] of cases.entries()) {
      const fact = tasks.find(task => task.id === created.added[index]!.id)!
      if (row.outcome === undefined) expect("outcome" in fact, row.name).toBe(false)
      else expect(fact.outcome, row.name).toBe(row.outcome)
    }
  })

  test("full detail output drops events, history, sessions, then tasks with accurate counts", () => {
    const deps = setup()
    const sessionID = `ses_${"s".repeat(100)}_main`
    const workflowID = `wf_${"w".repeat(125)}`
    // Task tags are ledger data, not path components, so they keep the original oversized identifier.
    const taskWorkflowID = "界".repeat(256)
    const planSha = "a".repeat(64)
    const now = Number.MAX_SAFE_INTEGER
    const workflow = {
      ...newStatusWorkflow(sessionID, { ...currentOwner()}, "command", "detail cap", now),
      id: workflowID,
      lastSeq: now, // events at or below the committed revision are admitted; the fixture's tail sits just under it
      phase: "reviewing" as const,
      planRef: { jsonSha: planSha, mdPath: "界".repeat(1024), mdSha: "b".repeat(64), revision: 3 },
      taskIds: [] as string[],
      counters: { code_invalid: now, review_iterations: now, user_rejections: now, nudges: now },
    }
    const created = addTasks(emptyLedger(sessionID), Array.from({ length: STATUS_LIMITS.taskCount }, () => ({ title: "task" })))
    const tasks = created.added.map((task, index) => ({
      ...task,
      id: `${"界".repeat(76)}${String(index).padStart(4, "0")}`,
      n: now,
      batch: now,
      status: "cancelled" as const,
      attempts: now,
      kind: "data" as const,
      title: "\ud800".repeat(80),
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      wf: { id: taskWorkflowID, planSha },
      verify_result: { command: "verify", output: "output", ok: false, exitCode: -now, timedOut: true },
      review: { verdict: "reject" as const },
      filesChanged: Array.from({ length: 100 }, (_, file) => `file-${file}`),
      blocked: "blocked",
    }))
    workflow.taskIds = tasks.map(task => task.id)
    writeStatusWorkflow(wt.worktree, workflow, now)
    writeLedger(wt.worktree, { ...created.ledger, tasks })

    const extraSessionIDs = Array.from({ length: STATUS_LIMITS.sessionsCount }, (_, index) => `ses_${"界".repeat(60)}_${String(index).padStart(2, "0")}`)
    for (const id of extraSessionIDs) writeLedger(wt.worktree, emptyLedger(id, now))

    const archiveDir = join(flowDir(wt.worktree), "archive")
    mkdirSync(archiveDir, { recursive: true })
    const archiveIDs = Array.from({ length: STATUS_LIMITS.historyCount }, (_, index) => `wf_${"w".repeat(120)}_${String(index).padStart(2, "0")}`)
    for (const id of archiveIDs) {
      writeFileSync(join(archiveDir, `${id}.json`), JSON.stringify({ ...newStatusWorkflow(sessionID, currentOwner(), "command", "history", now), id }))
    }

    const eventType = "界".repeat(80)
    const eventTo = "界".repeat(80)
    const eventLines = Array.from({ length: 20 }, (_, index) => JSON.stringify({
      seq: now - 20 + index, at: now, wf: workflowID, type: eventType, to: eventTo, actor: "user_message",
    }))
    mkdirSync(flowDir(wt.worktree), { recursive: true })
    writeFileSync(eventsPath(wt.worktree), `${eventLines.join("\n")}\n`)

    const runs = createExecutionRunStore(wt.worktree)
    const foreignSession = "界".repeat(256)
    const claim = runs.claim(foreignSession, "detail-cap", process.pid)
    runs.registerIntent(claim, {
      executionId: "detail-cap-unresolved", ownerSession: foreignSession, taskId: tasks[0]!.id, attemptId: "attempt",
      generation: claim.generation, role: "worker", cwd: wt.worktree, policyID: "detail-cap", kind: "host", engine: ENGINE, profile: "legacy-unowned",
    })
    runs.fence(claim, "detail-cap-unresolved", "status detail cap fixture")

    const rawTaskFacts = tasks.map(task => ({
      id: task.id.slice(0, 80), n: task.n, batch: task.batch, status: task.status, attempts: task.attempts, kind: task.kind,
      wfId: task.wf!.id.slice(0, 80), title: task.title.slice(0, 80), createdAt: task.createdAt,
      startedAt: task.startedAt, finishedAt: task.finishedAt,
      verify: { ok: task.verify_result!.ok, exitCode: task.verify_result!.exitCode, timedOut: task.verify_result!.timedOut },
      review: { verdict: task.review!.verdict }, outcome: "blocked", filesChangedCount: task.filesChanged!.length, blocked: true,
    }))
    const rawDetailLowerBound = Buffer.byteLength(JSON.stringify({
      tasks: rawTaskFacts,
      sessions: extraSessionIDs.map(id => ({ id })),
      history: archiveIDs.map(id => ({ id })),
      events: Array.from({ length: 20 }, () => ({ type: eventType, to: eventTo })),
    }))
    expect(rawDetailLowerBound).toBeGreaterThan(STATUS_LIMITS.detailOutput)

    const status = statusJson(deps, sessionID, { detail: true, now })
    const detail = status.detail!
    expect(detail.events).toEqual([])
    expect(detail.history).toEqual([])
    expect(detail.sessions).toEqual([])
    expect(detail.tasks).toEqual([])
    expect(detail.truncated).toMatchObject({ events: 20, history: 10, sessions: 20, tasks: STATUS_LIMITS.taskCount })
    expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThanOrEqual(STATUS_LIMITS.detailOutput)

    const stages = new Set<number>([4])
    for (let count = 20; count < STATUS_LIMITS.taskCount; count++) {
      writeLedger(wt.worktree, { ...created.ledger, tasks: tasks.slice(0, count) })
      const snapshot = statusJson(deps, sessionID, { detail: true, now })
      const projected = snapshot.detail!
      const originalCounts = { events: 20, history: 10, sessions: 20, tasks: count }
      let retained = false
      let dropped = 0
      for (const key of ["events", "history", "sessions", "tasks"] as const) {
        if (projected[key].length === 0) {
          expect(retained, `${count} tasks: ${key} dropped after a retained section`).toBe(false)
          expect(projected.truncated[key]).toBe(originalCounts[key])
          dropped++
        } else {
          retained = true
          expect(projected[key]).toHaveLength(originalCounts[key])
          expect(projected.truncated[key]).toBeUndefined()
        }
      }
      stages.add(dropped)
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(STATUS_LIMITS.detailOutput)
    }
    expect([...stages].sort()).toEqual([0, 1, 2, 3, 4])
  })

  test("detail stops after the shared 8 MiB extra-read budget", () => {
    const deps = setup()
    const sessionsRoot = join(stateRoot(wt.worktree), "sessions")
    mkdirSync(sessionsRoot, { recursive: true })
    for (let index = 0; index < 9; index++) {
      const id = `ses_extra_${index}`
      const folder = join(sessionsRoot, id)
      mkdirSync(folder)
      const json = JSON.stringify(emptyLedger(id))
      writeFileSync(join(folder, "ledger.json"), json + " ".repeat(STATUS_LIMITS.extraLedger - Buffer.byteLength(json)))
    }
    const status = statusJson(deps, SESSION, { detail: true })
    expect(status.detail?.sessions).toHaveLength(8)
    expect(status.detail?.budgetExhausted).toBe(true)
    expect(statusBytesRead(status)).toBeLessThanOrEqual(STATUS_LIMITS.detailInput + STATUS_LIMITS.workflow + STATUS_LIMITS.mode + STATUS_LIMITS.ledger + STATUS_LIMITS.execution + STATUS_LIMITS.events)
  })

  test("detail marks oversized extra-session ledgers without reading or exposing their contents", () => {
    const deps = setup()
    const extraSession = "ses_extra_oversize"
    const extraFolder = join(stateRoot(wt.worktree), "sessions", extraSession)
    mkdirSync(extraFolder, { recursive: true })
    const secret = "EXTRA_SESSION_SECRET_MUST_NOT_BE_READ"
    const extraLedger = join(extraFolder, "ledger.json")
    writeFileSync(extraLedger, `${secret}${"x".repeat(STATUS_LIMITS.extraLedger)}`)
    expect(readFileSync(extraLedger).byteLength).toBeGreaterThan(STATUS_LIMITS.extraLedger)

    const status = statusJson(deps, SESSION, { detail: true })
    expect(status.detail?.sessions).toContainEqual({ id: extraSession, oversize: true })
    expect(JSON.stringify(status.detail)).not.toContain(secret)
    expect(statusBytesRead(status)).toBeLessThan(STATUS_LIMITS.extraLedger)
  })

  test("generic view: JSON carries kind/stage/revision/stopIntent/artifacts and artifact state is recomputed after tampering", () => {
    const deps = setup()
    const body = "rendered plan"
    const mdPath = ".lca/plans/generic.md"
    mkdirSync(join(wt.worktree, ".lca/plans"), { recursive: true })
    writeFileSync(join(wt.worktree, mdPath), body)
    const mdSha = createHash("sha256").update(body).digest("hex")
    const workflow = {
      ...newStatusWorkflow(SESSION, currentOwner(), "command", "generic view"),
      id: "wf_generic_view", phase: "pending_approval" as const, stage: "decision" as const,
      planRef: { jsonSha: "a".repeat(64), mdPath, mdSha, revision: 1 },
      artifacts: [{ key: "absent", path: ".lca/workflows/x/y/absent.md", sha256: "c".repeat(64) }],
    }
    writeStatusWorkflow(wt.worktree, workflow)
    const first = statusJson(deps, SESSION)
    expect(first.workflow).toMatchObject({ kind: "plan", stage: "decision", revision: 0, stopIntent: null })
    expect(first.workflow?.artifacts).toEqual([
      { key: "plan.md", path: mdPath, state: "verified" },
      { key: "absent", path: ".lca/workflows/x/y/absent.md", state: "incomplete" },
    ])
    const text = renderStatusSnapshot(first, SESSION)
    expect(text).toContain("kind: plan · stage decision · revision 0")
    expect(text).toContain(`plan.md verified (${mdPath})`)
    writeFileSync(join(wt.worktree, mdPath), "tampered")
    expect(statusJson(deps, SESSION).workflow?.artifacts[0]).toEqual({ key: "plan.md", path: mdPath, state: "incomplete" })
  })

  test("a committed planning-kind envelope renders the generic view and bounds artifact reads (P6a S1)", () => {
    const deps = setup()
    const artifacts = Array.from({ length: 20 }, (_, i) => {
      const path = `.lca/workflows/${SESSION}/wf_gen/a${i}.md`
      mkdirSync(join(wt.worktree, ".lca/workflows", SESSION, "wf_gen"), { recursive: true })
      writeFileSync(join(wt.worktree, path), `body ${i}`)
      return { key: `a${i}`, path, sha256: createHash("sha256").update(`body ${i}`).digest("hex") }
    })
    const base = { ...newStatusWorkflow(SESSION, currentOwner(), "command", "x"), id: "wf_gen", kind: "ralplan", stage: "critic", phase: "reviewing", data: {}, artifacts } as unknown as Workflow
    delete (base as Record<string, unknown>).counters; delete (base as Record<string, unknown>).entry; delete (base as Record<string, unknown>).request
    publishWorkflow(wt.worktree, base as never)
    const status = statusJson(deps, SESSION)
    expect(status.workflow).toMatchObject({ id: "wf_gen", kind: "ralplan", stage: "critic", phase: "reviewing", stopIntent: null, artifactsOmitted: 4 })
    expect(status.workflow?.counters).toBeUndefined()
    expect(status.workflow?.artifacts).toHaveLength(16)
    expect(status.workflow?.artifacts.every(item => item.state === "verified")).toBe(true)
    const text = renderStatusSnapshot(status, SESSION)
    expect(text).toContain("kind: ralplan · stage critic · revision 0")
    expect(text).toContain("(+4 not read)")
    expect(text).not.toContain("counters:")
    // an invalid stage/phase pair in a committed planning envelope is still reported, never rendered
    const bad = { ...base, stage: "question", phase: "reviewing" }
    expect(() => publishWorkflow(wt.worktree, bad as never)).toThrow("invalid workflow state")
  })

  test("default concise status snapshot is rich, bounded to 25 actual lines, and has no detail", () => {
    const deps = setup()
    const wfID = "wf_rich_status"
    const planSha = "a".repeat(64)
    const workflow = {
      ...newStatusWorkflow(SESSION, currentOwner(), "command", "rich status snapshot"),
      id: wfID,
      phase: "reviewing" as const,
      planRef: { jsonSha: planSha, mdPath: ".lca/plans/plan.md", mdSha: "b".repeat(64), revision: 3 },
      review: { verdict: "iterate" as const, findings: ["review finding"], planSha, note: "cap" as const },
      taskIds: ["t1"],
      counters: { code_invalid: 2, review_iterations: 3, user_rejections: 1, nudges: 4 },
    }
    writeStatusWorkflow(wt.worktree, workflow)
    const created = addTasks(emptyLedger(SESSION), Array.from({ length: 60 }, (_, index) => ({
      title: `rich task ${index + 1}`, wf: { id: wfID, planSha },
    })))
    const runningTask = created.added[0]!
    writeLedger(wt.worktree, {
      ...updateTask(created.ledger, runningTask.id, { status: "running", attempts: 1 }),
      running: { taskId: runningTask.id, since: 100 },
    })
    appendStatusEvents(wt.worktree, Array.from({ length: 8 }, (_, index) => ({
      wf: wfID, type: `status-event-${index + 1}`, actor: "user_message" as const,
    })))
    const runs = createExecutionRunStore(wt.worktree)
    const claim = runs.claim(SESSION, "rich-status", process.pid)
    runs.registerIntent(claim, {
      executionId: "rich-status-execution", ownerSession: SESSION, taskId: runningTask.id, attemptId: "attempt",
      generation: claim.generation, role: "worker", cwd: wt.worktree, policyID: "rich-status",
      kind: "host", engine: ENGINE, profile: "legacy-unowned",
    })
    runs.fence(claim, "rich-status-execution", "unresolved status fixture")

    const status = statusJson(deps, SESSION)
    const snapshot = renderStatusSnapshot(status, SESSION)
    const lines = snapshot.split("\n")
    expect(status.detail).toBeUndefined()
    expect(lines.length).toBeGreaterThan(8)
    expect(lines.length).toBeLessThanOrEqual(25)
    expect(snapshot).toContain("workflow: wf_rich_status reviewing")
    expect(snapshot).toContain("plan tasks: 0/60 done, 60 open, 0 failed/cancelled")
    expect(snapshot).toContain("execution: 1 unresolved")
    expect(snapshot).toContain("events:")
  })

  test("detail reports the 500-entry session scan cap", () => {
    const deps = setup()
    const sessionsRoot = join(stateRoot(wt.worktree), "sessions")
    mkdirSync(sessionsRoot, { recursive: true })
    for (let index = 0; index < STATUS_LIMITS.sessionsEntries + 1; index++) mkdirSync(join(sessionsRoot, `ses_${index}`))
    const detail = statusJson(deps, SESSION, { detail: true }).detail!
    expect(detail.sessionsScanTruncated).toBe(true)
    expect(detail.truncated.sessions).toBeUndefined()
  })

  test("detail reports the bounded archive scan cap without inventing omitted counts", () => {
    const deps = setup()
    const archiveDir = join(flowDir(wt.worktree), "archive")
    mkdirSync(archiveDir, { recursive: true })
    for (let index = 0; index <= STATUS_LIMITS.archiveEntries; index++) {
      const id = `wf_archive_${String(index).padStart(4, "0")}`
      const archived = { ...newStatusWorkflow(SESSION, currentOwner(), "command", "archive fixture"), id }
      writeFileSync(join(archiveDir, `${id}.json`), JSON.stringify(archived))
    }

    const detail = statusJson(deps, SESSION, { detail: true }).detail!
    expect(detail.archivesScanTruncated).toBe(true)
    expect(detail.history).toHaveLength(STATUS_LIMITS.historyCount)
    expect(detail.history.every(entry => typeof entry.id === "string" && /^wf_archive_\d{4}$/.test(entry.id))).toBe(true)
    expect(detail.truncated.archives).toBeUndefined()
  })

  test("detail skips and counts an individual oversized archive without reading its contents", () => {
    const deps = setup()
    const archiveDir = join(flowDir(wt.worktree), "archive")
    mkdirSync(archiveDir, { recursive: true })
    const oversized = {
      ...newStatusWorkflow(SESSION, currentOwner(), "command", "archive cap"),
      request: "界".repeat(Math.floor(STATUS_LIMITS.archive / 3) + 1),
    }
    const archiveFile = join(archiveDir, "wf_oversized_archive.json")
    writeFileSync(archiveFile, JSON.stringify(oversized))
    expect(statSync(archiveFile).size).toBeGreaterThan(STATUS_LIMITS.archive)

    const status = statusJson(deps, SESSION, { detail: true })
    expect(status.detail?.history).toEqual([])
    expect(status.detail?.truncated.archives).toBe(1)
    expect(statusBytesRead(status)).toBe(0)
  })

  test("pure shared parsers reject invalid state and bounded reader never creates missing files", () => {
    const deps = setup()
    expect(() => parseWorkflow({ version: 1 })).toThrow("invalid workflow state")
    expect(() => parseModeState({ mode: "other" })).toThrow("invalid mode state")
    const path = join(wt.worktree, "bounded.json")
    expect(readBoundedJson(path, 1024)).toEqual({ value: undefined, bytesRead: 0 })
    writeFileSync(path, JSON.stringify({ value: "ok" }))
    expect(readBoundedJson(path, 1024)).toMatchObject({ value: { value: "ok" }, bytesRead: Buffer.byteLength(JSON.stringify({ value: "ok" })) })
    const before = readFileSync(path)
    expect(() => readBoundedJson(path, 2)).toThrow()
    expect(readFileSync(path)).toEqual(before)
    void deps
  })

  test("ledger running pointer and event tails stay strict and bounded through a large tail", () => {
    const deps = setup()
    const ledger = { ...emptyLedger(SESSION), running: { taskId: "t1", since: 10, childSessionID: "child" } }
    expect(parseLedger(ledger, SESSION).running).toEqual(ledger.running)
    expect(() => parseLedger({ ...ledger, running: { taskId: "t1", since: Number.NaN } }, SESSION)).toThrow("invalid ledger state")
    const wf = "wf_events"
    const event = (seq: number, type: string) => ({ seq, at: seq, wf, type, actor: "user_message" as const })
    const first = JSON.stringify(event(1, "first"))
    const second = JSON.stringify(event(2, "second"))
    mkdirSync(join(stateRoot(wt.worktree), "workflow"), { recursive: true })
    writeFileSync(eventsPath(wt.worktree), "")
    expect(readEventsTail(wt.worktree, { wfId: wf, limit: 5, maxBytes: 1024 })).toMatchObject({ events: [], bytesRead: 0, windowTruncated: false })
    writeFileSync(eventsPath(wt.worktree), `${first}\n${second}`)
    expect(readEventsTail(wt.worktree, { wfId: wf, limit: 5, maxBytes: 1024 })).toMatchObject({
      events: [event(1, "first")], windowTruncated: true,
    })
    writeFileSync(eventsPath(wt.worktree), `${"x".repeat(300)}\n${second}\n`)
    expect(readEventsTail(wt.worktree, { wfId: wf, limit: 5, maxBytes: second.length + 20 })).toMatchObject({
      events: [event(2, "second")], windowTruncated: true,
    })
    const other = JSON.stringify({ ...event(3, "other"), wf: "wf_other" })
    writeFileSync(eventsPath(wt.worktree), `${other}\n${second}\n`)
    expect(readEventsTail(wt.worktree, { wfId: wf, limit: 5, maxBytes: 1024 }).events).toEqual([event(2, "second")])
    const unicode = JSON.stringify(event(1, "é".repeat(100)))
    writeFileSync(eventsPath(wt.worktree), `${unicode}\n${second}\n`)
    expect(readEventsTail(wt.worktree, { wfId: wf, limit: 5, maxBytes: Buffer.byteLength(second) + 20 }).events).toEqual([event(2, "second")])
    writeFileSync(eventsPath(wt.worktree), "é".repeat(100))
    expect(readEventsTail(wt.worktree, { wfId: wf, limit: 5, maxBytes: 64 })).toMatchObject({ events: [], windowTruncated: true, bytesRead: 64 })

    const largeWorkflow = writeStatusWorkflow(wt.worktree, { ...newStatusWorkflow(SESSION, currentOwner(), "command", "large event tail"), lastSeq: 8 })
    writeFileSync(eventsPath(wt.worktree), Buffer.alloc(50 * 1024 * 1024, 0x20))
    const recent = Array.from({ length: 8 }, (_, index) => ({
      seq: index + 1, at: index + 1, wf: largeWorkflow.id, type: `recent-${index + 1}`,
      ...(index === 7 ? { to: { secret: "malformed-event-target" } } : {}),
    }))
    writeFileSync(eventsPath(wt.worktree), `\n${recent.map(value => JSON.stringify(value)).join("\n")}\n`, { flag: "a" })
    const status = statusJson(deps, SESSION)
    expect(status.events.map(value => value.type)).toEqual(["recent-4", "recent-5", "recent-6", "recent-7", "recent-8"])
    expect(status.events.at(-1)).toEqual({ seq: 8, type: "recent-8" })
    expect(JSON.stringify(status)).not.toContain("malformed-event-target")
    expect(status.freshness.eventsWindowTruncated).toBe(true)
    expect(statusBytesRead(status)).toBeLessThanOrEqual(readFileSync(workflowPath(wt.worktree)).byteLength + committedSnapshotBytes(wt.worktree) + STATUS_LIMITS.events)
    void deps
  })
})
