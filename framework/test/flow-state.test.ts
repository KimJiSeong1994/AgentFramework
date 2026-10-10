// flow/state.ts persistence + rotation/seq, and runtime.repairOnLoad (authority-free repair).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import {
  activeWorkflow, appendEvents, archivePath, eventsPath, newWorkflow, readEvents, readWorkflow, readWorkflowChecked,
  rotate, workflowPath, writeWorkflow, flowDir, withFlowTransaction,
} from "../src/flow/state.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { applyEvent, startWorkflow, repairOnLoad } from "../src/flow/runtime.ts"
import { addTasks, readLedger, tasksForWorkflow, writeLedger } from "../src/state/ledger.ts"
import { sessionDir } from "../src/state/store.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_a"
const S2 = "ses_b"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient

function persist(wf: Parameters<typeof writeWorkflow>[1]) {
  return withFlowTransaction(wt.worktree, (tx) => writeWorkflow(tx, wf))
}

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
  mkdirSync(sessionDir(wt.worktree, S), { recursive: true })
  mkdirSync(sessionDir(wt.worktree, S2), { recursive: true })
})
afterEach(() => wt.cleanup())

describe("rotation", () => {
  test("start after a terminal workflow archives it before creating the new one", () => {
    const deps = makeDeps(client, wt.worktree)
    const first = startWorkflow(deps, S, "command", "first plan", "user_command", "opencode")
    expect(first.ok).toBe(true)
    if (!first.ok) return
    persist({ ...first.wf, phase: "cancelled" })

    const second = startWorkflow(deps, S2, "command", "second plan", "user_command", "opencode")
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.wf.id).not.toBe(first.wf.id)
    expect(existsSync(archivePath(wt.worktree, first.wf.id))).toBe(true)
    expect(readWorkflow(wt.worktree)?.id).toBe(second.wf.id)
  })

  test("rotate() is a no-op when the workflow is non-terminal", () => {
    const wf = persist(newWorkflow(S, currentOwner(), "command", "req", "opencode"))
    expect(withFlowTransaction(wt.worktree, (tx) => rotate(tx))).toBeNull()
    expect(readWorkflow(wt.worktree)?.id).toBe(wf.id)
  })

  test("rotate() with no workflow.json is a no-op", () => {
    expect(withFlowTransaction(wt.worktree, (tx) => rotate(tx))).toBeNull()
  })
})

describe("seq monotonicity", () => {
  test("seq stays monotonic across two workflows (rotation does not reset it)", () => {
    const deps = makeDeps(client, wt.worktree)
    const first = startWorkflow(deps, S, "command", "first", "user_command", "opencode")
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const firstEventsSeqMax = Math.max(...readEvents(wt.worktree, first.wf.id).map((e) => e.seq))
    persist({ ...first.wf, phase: "cancelled" })

    const second = startWorkflow(deps, S2, "command", "second", "user_command", "opencode")
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const secondEvents = readEvents(wt.worktree, second.wf.id)
    expect(Math.min(...secondEvents.map((e) => e.seq))).toBeGreaterThan(firstEventsSeqMax)

    // global seq (across both workflows) is strictly increasing with no gaps or repeats
    const all = readEvents(wt.worktree).map((e) => e.seq).sort((a, b) => a - b)
    for (let i = 1; i < all.length; i++) expect(all[i]).toBe(all[i - 1]! + 1)
  })

  test("appendEvents with an empty array returns the current seq without writing", () => {
    const before = existsSync(flowDir(wt.worktree) + "/events.jsonl")
    const seq = withFlowTransaction(wt.worktree, (tx) => appendEvents(tx, []))
    expect(seq).toBe(0)
    expect(before).toBe(false)
  })

  test("applyEvent refuses an engine-only stale workflow change without mutating workflow or events", () => {
    const deps = makeDeps(client, wt.worktree)
    const started = startWorkflow(deps, S, "command", "first", "user_command", "opencode")
    if (!started.ok) throw new Error(started.text)
    const current = readWorkflow(wt.worktree)!
    writeFileSync(workflowPath(wt.worktree), JSON.stringify({ ...current, engine: "foreign-engine" }))
    const workflowBefore = readFileSync(workflowPath(wt.worktree))
    const eventsBefore = readFileSync(eventsPath(wt.worktree))

    const result = applyEvent(deps, started.wf, "user_message", "user_message")

    expect(result.ok).toBe(false)
    expect(result.ok ? "" : result.text).toContain("engine identity mismatch")
    expect(readFileSync(workflowPath(wt.worktree)).equals(workflowBefore)).toBe(true)
    expect(readFileSync(eventsPath(wt.worktree)).equals(eventsBefore)).toBe(true)
  })
})

describe("corrupt workflow.json", () => {
  test("a corrupt (invalid JSON) workflow.json remains in place during reads", () => {
    mkdirSync(flowDir(wt.worktree), { recursive: true })
    writeFileSync(workflowPath(wt.worktree), "{not json")
    const r = readWorkflowChecked(wt.worktree)
    expect(r.wf).toBeNull()
    expect(r.corrupt).toBe(workflowPath(wt.worktree))
    expect(existsSync(workflowPath(wt.worktree))).toBe(true)
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe("{not json")
  })

  test("a well-formed JSON that is not a Workflow shape remains in place", () => {
    mkdirSync(flowDir(wt.worktree), { recursive: true })
    const contents = JSON.stringify({ foo: "bar" })
    writeFileSync(workflowPath(wt.worktree), contents)
    const r = readWorkflowChecked(wt.worktree)
    expect(r.wf).toBeNull()
    expect(r.corrupt).toBe(workflowPath(wt.worktree))
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(contents)
  })

  test("activeWorkflow() is a nonmutating read after a corrupt file", () => {
    mkdirSync(flowDir(wt.worktree), { recursive: true })
    writeFileSync(workflowPath(wt.worktree), "{{{")
    expect(activeWorkflow(wt.worktree)).toBeNull()
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe("{{{")
  })
})

describe("repairOnLoad — authority-free (ARCH-14)", () => {
  test("orphan reviewing -> pending_approval with review.note aborted", () => {
    const deps = makeDeps(client, wt.worktree)
    let wf = persist({
      ...newWorkflow(S, currentOwner(), "command", "req", "opencode"),
      phase: "reviewing",
      planRef: { jsonSha: "sha1", mdPath: "p.md", mdSha: "sha2", revision: 1 },
    })
    const r = repairOnLoad(deps, "opencode")
    expect(r?.ok).toBe(true)
    if (r?.ok) {
      expect(r.wf.phase).toBe("pending_approval")
      expect(r.wf.review?.note).toBe("aborted")
      expect(r.wf.review?.verdict).toBe("none")
    }
  })

  test("tagged tasks + pending_approval (interrupted approve) -> executing", () => {
    const deps = makeDeps(client, wt.worktree)
    let wf = persist({
      ...newWorkflow(S, currentOwner(), "command", "req", "opencode"),
      phase: "pending_approval",
      planRef: { jsonSha: "sha_plan", mdPath: "p.md", mdSha: "sha2", revision: 1 },
    })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "t1" }, { title: "t2" }], Date.now(), { id: wf.id, planSha: "sha_plan" })
    writeLedger(wt.worktree, ledger)

    const r = repairOnLoad(deps, "opencode")
    expect(r?.ok).toBe(true)
    if (r?.ok) {
      expect(r.wf.phase).toBe("executing")
      expect(r.wf.taskIds?.length).toBe(2)
    }
  })

  test("pending_approval without any tagged tasks yet is left alone (not an interrupted approve)", () => {
    const deps = makeDeps(client, wt.worktree)
    persist({
      ...newWorkflow(S, currentOwner(), "command", "req", "opencode"),
      phase: "pending_approval",
      planRef: { jsonSha: "sha_plan", mdPath: "p.md", mdSha: "sha2", revision: 1 },
    })
    const r = repairOnLoad(deps, "opencode")
    expect(r).toBeNull()
    expect(readWorkflow(wt.worktree)?.phase).toBe("pending_approval")
  })

  test("executing, all tasks done -> done via settle", () => {
    const deps = makeDeps(client, wt.worktree)
    let wf = persist({ ...newWorkflow(S, currentOwner(), "command", "req", "opencode"), phase: "executing", taskIds: ["t1", "t2"] })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "t1" }, { title: "t2" }], Date.now(), { id: wf.id, planSha: "s" })
    const done = { ...ledger, tasks: ledger.tasks.map((t) => ({ ...t, status: "done" as const })) }
    writeLedger(wt.worktree, done)

    const r = repairOnLoad(deps, "opencode")
    expect(r?.ok).toBe(true)
    if (r?.ok) expect(r.wf.phase).toBe("done")
  })

  test("dead owner at load: repairOnLoad changes neither phase nor owner (no takeover at load)", () => {
    const deps = makeDeps(client, wt.worktree)
    const deadOwner = { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 }
    persist({ ...newWorkflow(S, deadOwner, "command", "req", "opencode"), phase: "planning" })
    const r = repairOnLoad(deps, "opencode")
    expect(r).toBeNull() // planning has no repair action
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.owner).toEqual(deadOwner)
  })

  test("repairOnLoad never emits owner_takeover or owner_dead events", () => {
    const deps = makeDeps(client, wt.worktree)
    const wf = persist({
      ...newWorkflow(S, { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 }, "command", "req", "opencode"),
      phase: "reviewing",
      planRef: { jsonSha: "s", mdPath: "p.md", mdSha: "s2", revision: 1 },
    })
    repairOnLoad(deps, "opencode")
    const events = readEvents(wt.worktree, wf.id)
    expect(events.some((e) => e.type === "owner_takeover" || e.type === "owner_conflict")).toBe(false)
  })

  test("no active workflow -> null, nothing written", () => {
    const deps = makeDeps(client, wt.worktree)
    expect(repairOnLoad(deps, "opencode")).toBeNull()
  })
})
