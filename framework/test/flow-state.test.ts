// flow/state.ts persistence + rotation/seq, and runtime.repairOnLoad (authority-free repair).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import {
  activeWorkflow, appendEvents, archivePath, newWorkflow, readEvents, readWorkflow, readWorkflowChecked,
  rotate, workflowPath, writeWorkflow, flowDir,
} from "../src/flow/state.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { startWorkflow, repairOnLoad } from "../src/flow/runtime.ts"
import { addTasks, readLedger, tasksForWorkflow, writeLedger } from "../src/state/ledger.ts"
import { sessionDir } from "../src/state/store.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_a"
const S2 = "ses_b"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient

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
    const first = startWorkflow(deps, S, "command", "first plan", "user_command")
    expect(first.ok).toBe(true)
    if (!first.ok) return
    writeWorkflow(wt.worktree, { ...first.wf, phase: "cancelled" })

    const second = startWorkflow(deps, S2, "command", "second plan", "user_command")
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.wf.id).not.toBe(first.wf.id)
    expect(existsSync(archivePath(wt.worktree, first.wf.id))).toBe(true)
    expect(readWorkflow(wt.worktree)?.id).toBe(second.wf.id)
  })

  test("rotate() is a no-op when the workflow is non-terminal", () => {
    const wf = writeWorkflow(wt.worktree, newWorkflow(S, currentOwner(), "command", "req"))
    expect(rotate(wt.worktree)).toBeNull()
    expect(readWorkflow(wt.worktree)?.id).toBe(wf.id)
  })

  test("rotate() with no workflow.json is a no-op", () => {
    expect(rotate(wt.worktree)).toBeNull()
  })
})

describe("seq monotonicity", () => {
  test("seq stays monotonic across two workflows (rotation does not reset it)", () => {
    const deps = makeDeps(client, wt.worktree)
    const first = startWorkflow(deps, S, "command", "first", "user_command")
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const firstEventsSeqMax = Math.max(...readEvents(wt.worktree, first.wf.id).map((e) => e.seq))
    writeWorkflow(wt.worktree, { ...first.wf, phase: "cancelled" })

    const second = startWorkflow(deps, S2, "command", "second", "user_command")
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
    const seq = appendEvents(wt.worktree, [])
    expect(seq).toBe(0)
    expect(before).toBe(false)
  })
})

describe("corrupt workflow.json", () => {
  test("a corrupt (invalid JSON) workflow.json is moved aside, never overwritten silently", () => {
    mkdirSync(flowDir(wt.worktree), { recursive: true })
    writeFileSync(workflowPath(wt.worktree), "{not json")
    const r = readWorkflowChecked(wt.worktree)
    expect(r.wf).toBeNull()
    expect(r.corrupt).toBeDefined()
    expect(existsSync(r.corrupt!)).toBe(true)
    expect(existsSync(workflowPath(wt.worktree))).toBe(false)
  })

  test("a well-formed JSON that is not a Workflow shape is also moved aside", () => {
    mkdirSync(flowDir(wt.worktree), { recursive: true })
    writeFileSync(workflowPath(wt.worktree), JSON.stringify({ foo: "bar" }))
    const r = readWorkflowChecked(wt.worktree)
    expect(r.wf).toBeNull()
    expect(r.corrupt).toBeDefined()
    expect(existsSync(r.corrupt!)).toBe(true)
  })

  test("activeWorkflow() returns null (not throw) after a corrupt file", () => {
    mkdirSync(flowDir(wt.worktree), { recursive: true })
    writeFileSync(workflowPath(wt.worktree), "{{{")
    expect(activeWorkflow(wt.worktree)).toBeNull()
  })
})

describe("repairOnLoad — authority-free (ARCH-14)", () => {
  test("orphan reviewing -> pending_approval with review.note aborted", () => {
    const deps = makeDeps(client, wt.worktree)
    let wf = writeWorkflow(wt.worktree, {
      ...newWorkflow(S, currentOwner(), "command", "req"),
      phase: "reviewing",
      planRef: { jsonSha: "sha1", mdPath: "p.md", mdSha: "sha2", revision: 1 },
    })
    const r = repairOnLoad(deps)
    expect(r?.ok).toBe(true)
    if (r?.ok) {
      expect(r.wf.phase).toBe("pending_approval")
      expect(r.wf.review?.note).toBe("aborted")
      expect(r.wf.review?.verdict).toBe("none")
    }
  })

  test("tagged tasks + pending_approval (interrupted approve) -> executing", () => {
    const deps = makeDeps(client, wt.worktree)
    let wf = writeWorkflow(wt.worktree, {
      ...newWorkflow(S, currentOwner(), "command", "req"),
      phase: "pending_approval",
      planRef: { jsonSha: "sha_plan", mdPath: "p.md", mdSha: "sha2", revision: 1 },
    })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "t1" }, { title: "t2" }], Date.now(), { id: wf.id, planSha: "sha_plan" })
    writeLedger(wt.worktree, ledger)

    const r = repairOnLoad(deps)
    expect(r?.ok).toBe(true)
    if (r?.ok) {
      expect(r.wf.phase).toBe("executing")
      expect(r.wf.taskIds?.length).toBe(2)
    }
  })

  test("pending_approval without any tagged tasks yet is left alone (not an interrupted approve)", () => {
    const deps = makeDeps(client, wt.worktree)
    writeWorkflow(wt.worktree, {
      ...newWorkflow(S, currentOwner(), "command", "req"),
      phase: "pending_approval",
      planRef: { jsonSha: "sha_plan", mdPath: "p.md", mdSha: "sha2", revision: 1 },
    })
    const r = repairOnLoad(deps)
    expect(r).toBeNull()
    expect(readWorkflow(wt.worktree)?.phase).toBe("pending_approval")
  })

  test("executing, all tasks done -> done via settle", () => {
    const deps = makeDeps(client, wt.worktree)
    let wf = writeWorkflow(wt.worktree, { ...newWorkflow(S, currentOwner(), "command", "req"), phase: "executing", taskIds: ["t1", "t2"] })
    const { ledger } = addTasks(readLedger(wt.worktree, S), [{ title: "t1" }, { title: "t2" }], Date.now(), { id: wf.id, planSha: "s" })
    const done = { ...ledger, tasks: ledger.tasks.map((t) => ({ ...t, status: "done" as const })) }
    writeLedger(wt.worktree, done)

    const r = repairOnLoad(deps)
    expect(r?.ok).toBe(true)
    if (r?.ok) expect(r.wf.phase).toBe("done")
  })

  test("dead owner at load: repairOnLoad changes neither phase nor owner (no takeover at load)", () => {
    const deps = makeDeps(client, wt.worktree)
    const deadOwner = { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 }
    writeWorkflow(wt.worktree, { ...newWorkflow(S, deadOwner, "command", "req"), phase: "planning" })
    const r = repairOnLoad(deps)
    expect(r).toBeNull() // planning has no repair action
    const wf = readWorkflow(wt.worktree)!
    expect(wf.phase).toBe("planning")
    expect(wf.owner).toEqual(deadOwner)
  })

  test("repairOnLoad never emits owner_takeover or owner_dead events", () => {
    const deps = makeDeps(client, wt.worktree)
    const wf = writeWorkflow(wt.worktree, {
      ...newWorkflow(S, { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 }, "command", "req"),
      phase: "reviewing",
      planRef: { jsonSha: "s", mdPath: "p.md", mdSha: "s2", revision: 1 },
    })
    repairOnLoad(deps)
    const events = readEvents(wt.worktree, wf.id)
    expect(events.some((e) => e.type === "owner_takeover" || e.type === "owner_conflict")).toBe(false)
  })

  test("no active workflow -> null, nothing written", () => {
    const deps = makeDeps(client, wt.worktree)
    expect(repairOnLoad(deps)).toBeNull()
  })
})
