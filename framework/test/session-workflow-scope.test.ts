import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eventsPath, flowDir, flowTxSessionID, newWorkflow, readEvents, readWorkflow, readWorkflowChecked, withFlowTransaction, workflowPath, type FlowTx } from "../src/flow/state.ts"
import { commitRevision, readCommitted, readSessionCommitted, writeArchiveCopy } from "../src/workflows/commit.ts"
import { stateRoot } from "../src/state/store.ts"
import type { WorkflowEnvelope } from "../src/workflows/types.ts"

let root: string
let worktree: string
let oldHome: string | undefined
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "otter-session-scope-")))
  worktree = join(root, "worktree")
  mkdirSync(worktree)
  oldHome = process.env.OTTER_STATE_HOME
  process.env.OTTER_STATE_HOME = join(root, "state")
})
afterEach(() => {
  if (oldHome === undefined) delete process.env.OTTER_STATE_HOME
  else process.env.OTTER_STATE_HOME = oldHome
  rmSync(root, { recursive: true, force: true })
})
const make = (sid: string) => newWorkflow(sid, { instance: "test-owner", pid: process.pid }, "command", "request", "opencode")
function commit(wf: WorkflowEnvelope, sid?: string): WorkflowEnvelope {
  return withFlowTransaction(worktree, tx => commitRevision(tx, wf, [{ wf: wf.id, type: "test", actor: "code" }]), sid)
}

test("two sessions independently commit, update, and read their own event sequences", () => {
  const a = commit(make("ses_a"), "ses_a")
  const b = commit(make("ses_b"), "ses_b")
  const a2 = commit(a, "ses_a")
  expect(a.lastSeq).toBe(1)
  expect(b.lastSeq).toBe(1)
  expect(a2.lastSeq).toBe(2)
  expect(readWorkflow(worktree, "ses_a")?.lastSeq).toBe(2)
  expect(readWorkflow(worktree, "ses_b")?.id).toBe(b.id)
  expect(readEvents(worktree, undefined, "ses_a").map(e => e.seq)).toEqual([1, 2])
  expect(readEvents(worktree, undefined, "ses_b").map(e => e.wf)).toEqual([b.id])
  expect(readCommitted(worktree).state).toBe("none")
})

test("a scoped transaction refuses a foreign session before writing events or a commit", () => {
  expect(() => commit(make("ses_a"), "ses_b")).toThrow("another session")
  expect(existsSync(workflowPath(worktree, "ses_b"))).toBe(false)
  expect(existsSync(eventsPath(worktree, "ses_b"))).toBe(false)
})

test("a new session leaves the existing global session byte-for-byte untouched", () => {
  const a = commit(make("ses_a"))
  const index = readFileSync(workflowPath(worktree))
  const events = readFileSync(eventsPath(worktree))
  const b = commit(make("ses_b"), "ses_b")
  expect(readFileSync(workflowPath(worktree))).toEqual(index)
  expect(readFileSync(eventsPath(worktree))).toEqual(events)
  expect(flowDir(worktree, "ses_a")).toBe(flowDir(worktree))
  expect(readWorkflow(worktree, "ses_b")?.id).toBe(b.id)
  expect(commit(a, "ses_a").lastSeq).toBe(2)
  expect(readWorkflow(worktree)?.id).toBe(a.id)
})

test("existing corrupt own scope never falls back to a valid matching legacy workflow", () => {
  commit(make("ses_a"))
  const scoped = join(stateRoot(worktree), "sessions", "ses_a", "workflow")
  mkdirSync(scoped, { recursive: true })
  writeFileSync(join(scoped, "workflow.json"), "{broken")
  expect(flowDir(worktree, "ses_a")).toBe(scoped)
  expect(readWorkflowChecked(worktree, "ses_a").corrupt).toBeTruthy()
  expect(readSessionCommitted(worktree, "ses_a")).toBeNull()
  expect(readCommitted(worktree).state).toBe("ok")
})

test.each(["truncated", "unreadable", "missing-session", "invalid-version", "invalid-index"])(
  "damaged legacy authority (%s) blocks a second workflow and recovers in place",
  damage => {
    const original = commit(make("ses_a"))
    const path = workflowPath(worktree)
    const bytes = readFileSync(path)
    const events = readFileSync(eventsPath(worktree))
    if (damage === "unreadable") {
      rmSync(path)
      mkdirSync(path)
    } else if (damage === "truncated") {
      writeFileSync(path, bytes.subarray(0, 10))
    } else {
      const index = JSON.parse(bytes.toString("utf8"))
      if (damage === "missing-session") delete index.sessionID
      if (damage === "invalid-version") index.version = 99
      if (damage === "invalid-index") { index.sessionID = "ses_foreign"; index.revision = -1 }
      writeFileSync(path, JSON.stringify(index))
    }
    for (const sid of ["ses_a", "ses_new"]) {
      expect(flowDir(worktree, sid)).toBe(flowDir(worktree))
      expect(readCommitted(worktree, {}, sid).state).toBe("corrupt")
      expect(readWorkflowChecked(worktree, sid).corrupt).toBeTruthy()
      expect(() => commit(make(sid), sid)).toThrow("corrupt workflow state")
      expect(existsSync(join(stateRoot(worktree), "sessions", sid, "workflow"))).toBe(false)
    }
    expect(readFileSync(eventsPath(worktree))).toEqual(events)
    if (damage === "unreadable") rmSync(path, { recursive: true })
    writeFileSync(path, bytes)
    expect(readWorkflow(worktree, "ses_a")?.id).toBe(original.id)
    expect(commit(original, "ses_a").lastSeq).toBe(2)
  },
)

test("nested distinct session transactions remain explicitly pinned", () => {
  withFlowTransaction(worktree, a => {
    expect(flowTxSessionID(a)).toBe("ses_a")
    withFlowTransaction(worktree, b => {
      expect(flowTxSessionID(b)).toBe("ses_b")
      commitRevision(b, make("ses_b"), [{ wf: "b", type: "test", actor: "code" }])
    }, "ses_b")
    expect(flowTxSessionID(a)).toBe("ses_a")
    commitRevision(a, make("ses_a"), [{ wf: "a", type: "test", actor: "code" }])
  }, "ses_a")
  expect(readWorkflow(worktree, "ses_a")?.sessionID).toBe("ses_a")
  expect(readWorkflow(worktree, "ses_b")?.sessionID).toBe("ses_b")
})

test("async callbacks are refused and their resumed writes cannot reuse the transaction", async () => {
  let later: Promise<void> | undefined
  let refused = false
  const callback = (tx: FlowTx) => {
    later = Promise.resolve().then(() => {
      try { commitRevision(tx, make("ses_a"), [{ wf: "a", type: "test", actor: "code" }]) }
      catch { refused = true }
    })
    return later
  }
  expect(() => withFlowTransaction(worktree, callback as unknown as (tx: FlowTx) => void, "ses_a")).toThrow("synchronous")
  await later
  expect(refused).toBe(true)
  expect(readCommitted(worktree, {}, "ses_a").state).toBe("none")
})

test("session restore can find its verified terminal legacy archive without adopting the current foreign index", () => {
  const a = commit({ ...make("ses_a"), phase: "cancelled", stage: "terminal" })
  writeArchiveCopy(worktree, a)
  const b = commit(make("ses_b"))
  expect(readSessionCommitted(worktree, "ses_a")).toMatchObject({ current: false, wf: { id: a.id } })
  expect(readWorkflow(worktree)?.id).toBe(b.id)
  expect(readWorkflow(worktree, "ses_a")).toBeNull()
})

test("invalid session path components are refused", () => {
  expect(() => flowDir(worktree, "../other")).toThrow("invalid workflow session ID")
})

test("a foreign index placed inside an existing scope is rejected without changing either index", () => {
  commit(make("ses_a"), "ses_a")
  const foreign = readFileSync(workflowPath(worktree, "ses_a"))
  mkdirSync(flowDir(worktree, "ses_b"), { recursive: true })
  writeFileSync(workflowPath(worktree, "ses_b"), foreign)
  expect(readCommitted(worktree, {}, "ses_b").state).toBe("corrupt")
  expect(() => commit(make("ses_b"), "ses_b")).toThrow("corrupt workflow state")
  expect(readFileSync(workflowPath(worktree, "ses_b"))).toEqual(foreign)
  expect(readFileSync(workflowPath(worktree, "ses_a"))).toEqual(foreign)
  expect(existsSync(eventsPath(worktree, "ses_b"))).toBe(false)
})
