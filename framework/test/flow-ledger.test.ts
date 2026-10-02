// §5.5 plan -> ledger handoff: approvePlanTasks (pure) and runtime.approveWorkflow preconditions.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { addTasks, approvePlanTasks, emptyLedger, readLedger, tasksForWorkflow, updateTask, writeLedger, type TaskInput } from "../src/state/ledger.ts"
import { newWorkflow, writeWorkflow } from "../src/flow/state.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { approveWorkflow } from "../src/flow/runtime.ts"
import { sessionDir } from "../src/state/store.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
  mkdirSync(sessionDir(wt.worktree, S), { recursive: true })
})
afterEach(() => wt.cleanup())

const TAG = { id: "wf_1", planSha: "sha_a" }
const INPUTS: TaskInput[] = [{ title: "task one" }, { title: "task two" }]

describe("approvePlanTasks (pure)", () => {
  test("tags new tasks and marks them already-offered in resumeNotifiedFor", () => {
    const r = approvePlanTasks(emptyLedger(S), INPUTS, TAG)
    expect(r.added.length).toBe(2)
    expect(r.added.every((t) => t.wf)).toBe(true)
    expect(r.added.map((t) => t.wf)).toEqual([TAG, TAG])
    expect(r.cancelledForeign).toEqual([])
    expect(r.ledger.resumeNotifiedFor).toEqual(r.added.map((t) => t.id))
  })

  test("idempotent per planSha: running it twice adds tasks only once", () => {
    const first = approvePlanTasks(emptyLedger(S), INPUTS, TAG)
    const second = approvePlanTasks(first.ledger, INPUTS, TAG)
    expect(second.added).toEqual([])
    expect(second.ledger.tasks.length).toBe(2)
    expect(second.ledger).toEqual(first.ledger)
  })

  test("a different planSha for the same workflow id is treated as a new plan (not idempotent-skipped)", () => {
    const first = approvePlanTasks(emptyLedger(S), INPUTS, TAG)
    const second = approvePlanTasks(first.ledger, [{ title: "task three" }], { id: TAG.id, planSha: "sha_b" })
    expect(second.added.length).toBe(1)
  })

  test("foreign open tasks (no tag, or a different workflow's tag) are cancelled with the superseded reason", () => {
    let { ledger } = addTasks(emptyLedger(S), [{ title: "untagged open" }])
    ledger = { ...ledger, ...addTasks(ledger, [{ title: "other-wf open" }], Date.now(), { id: "wf_other", planSha: "sha_x" }).ledger }
    ledger = updateTask(ledger, "t1", {}) // still pending
    const r = approvePlanTasks(ledger, INPUTS, TAG)
    expect(r.cancelledForeign.sort()).toEqual(["t1", "t2"])
    const foreign = r.ledger.tasks.filter((t) => t.id === "t1" || t.id === "t2")
    expect(foreign.every((t) => t.status === "cancelled")).toBe(true)
    expect(foreign.every((t) => t.error === `superseded by approved plan ${TAG.id}`)).toBe(true)
  })

  test("foreign done/failed/cancelled tasks are left untouched (only open tasks are superseded)", () => {
    let { ledger } = addTasks(emptyLedger(S), [{ title: "already done" }])
    ledger = updateTask(ledger, "t1", { status: "done" })
    const r = approvePlanTasks(ledger, INPUTS, TAG)
    expect(r.cancelledForeign).toEqual([])
    expect(r.ledger.tasks.find((t) => t.id === "t1")!.status).toBe("done")
  })

  test("new ids land in resumeNotifiedFor alongside any pre-existing entries", () => {
    const seeded = { ...emptyLedger(S), resumeNotifiedFor: ["t0"] }
    const r = approvePlanTasks(seeded, INPUTS, TAG)
    expect(new Set(r.ledger.resumeNotifiedFor)).toEqual(new Set(["t0", ...r.added.map((t) => t.id)]))
  })

  test("an untagged (plain delegate) ledger still works: addTasks with no tag produces untagged tasks", () => {
    const { ledger, added } = addTasks(emptyLedger(S), [{ title: "plain" }])
    expect(added[0]!.wf).toBeUndefined()
    expect(ledger.tasks[0]!.wf).toBeUndefined()
  })

  test("tasksForWorkflow filters by wf.id only (any planSha)", () => {
    const r1 = approvePlanTasks(emptyLedger(S), INPUTS, TAG)
    const r2 = approvePlanTasks(r1.ledger, [{ title: "task three" }], { id: TAG.id, planSha: "sha_b" })
    const forWf = tasksForWorkflow(r2.ledger, TAG.id)
    expect(forWf.length).toBe(3)
  })
})

describe("runtime.approveWorkflow preconditions (refuse without writes)", () => {
  function putWorkflow(patch: Record<string, unknown> = {}) {
    const wf = { ...newWorkflow(S, currentOwner(), "command", "req"), phase: "pending_approval" as const, ...patch }
    return writeWorkflow(wt.worktree, wf as any)
  }

  test("wrong phase refuses without writing the ledger", () => {
    const wf = putWorkflow({ phase: "planning", planRef: undefined })
    writeLedger(wt.worktree, emptyLedger(S))
    const deps = makeDeps(client, wt.worktree)
    const before = readLedger(wt.worktree, S)
    const r = approveWorkflow(deps, wf, INPUTS, { queueRunning: false, planShaOk: true, mdShaOk: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.text).toBe("no plan awaiting approval")
    expect(readLedger(wt.worktree, S)).toEqual(before)
  })

  test("queue running refuses without writing the ledger", () => {
    const wf = putWorkflow({ planRef: { jsonSha: "s", mdPath: "p.md", mdSha: "s2", revision: 1 } })
    writeLedger(wt.worktree, emptyLedger(S))
    const deps = makeDeps(client, wt.worktree)
    const before = readLedger(wt.worktree, S)
    const r = approveWorkflow(deps, wf, INPUTS, { queueRunning: true, planShaOk: true, mdShaOk: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.text).toBe("a task queue is running; wait or /stop")
    expect(readLedger(wt.worktree, S)).toEqual(before)
  })

  test("plan json sha mismatch (or no planRef) refuses without writing the ledger", () => {
    const wf = putWorkflow({ planRef: undefined })
    writeLedger(wt.worktree, emptyLedger(S))
    const deps = makeDeps(client, wt.worktree)
    const before = readLedger(wt.worktree, S)
    const r = approveWorkflow(deps, wf, INPUTS, { queueRunning: false, planShaOk: false, mdShaOk: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.text).toBe("the saved plan does not match; /plan again")
    expect(readLedger(wt.worktree, S)).toEqual(before)
  })

  test("plan md sha mismatch refuses without writing the ledger", () => {
    const wf = putWorkflow({ planRef: { jsonSha: "s", mdPath: "p.md", mdSha: "s2", revision: 1 } })
    writeLedger(wt.worktree, emptyLedger(S))
    const deps = makeDeps(client, wt.worktree)
    const before = readLedger(wt.worktree, S)
    const r = approveWorkflow(deps, wf, INPUTS, { queueRunning: false, planShaOk: true, mdShaOk: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.text).toBe("plan file edited; /plan again or revert")
    expect(readLedger(wt.worktree, S)).toEqual(before)
  })

  test("a satisfied precondition set approves: phase -> executing, taskIds set, ledger tagged", () => {
    const wf = putWorkflow({ planRef: { jsonSha: "plan_sha", mdPath: "p.md", mdSha: "s2", revision: 1 } })
    const deps = makeDeps(client, wt.worktree)
    const r = approveWorkflow(deps, wf, INPUTS, { queueRunning: false, planShaOk: true, mdShaOk: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.wf.phase).toBe("executing")
      expect(r.wf.taskIds?.length).toBe(2)
      expect(r.wf.approval?.planSha).toBe("plan_sha")
    }
    const ledger = readLedger(wt.worktree, S)
    expect(tasksForWorkflow(ledger, wf.id).length).toBe(2)
  })
})
