import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  addTasks,
  cancelOpen,
  counts,
  readLedgerChecked,
  emptyLedger,
  handoffContext,
  ledgerFingerprint,
  ledgerPath,
  nextPending,
  openIssues,
  openTasks,
  protectedFiles,
  protectedViolations,
  readLedger,
  summarizeLedger,
  updateTask,
  writeHandoff,
  writeLedger,
  type LedgerTask,
} from "../src/state/ledger.ts"
import { tempWorktree } from "./guards-helpers.ts"

const S = "ses_main"
let wt: ReturnType<typeof tempWorktree>
beforeEach(() => (wt = tempWorktree()))
afterEach(() => wt.cleanup())

describe("ledger", () => {
  test("empty when missing or malformed; round-trips through the atomic writer", () => {
    expect(readLedger(wt.worktree, S).tasks).toEqual([])
    const { ledger } = addTasks(emptyLedger(S), [{ title: "  a  b ", detail: " d ", verify: "true" }, { title: "second" }])
    writeLedger(wt.worktree, ledger)
    expect(existsSync(ledgerPath(wt.worktree, S))).toBe(true)
    const back = readLedger(wt.worktree, S)
    expect(back.tasks.map((t) => [t.id, t.n, t.title, t.status])).toEqual([
      ["t1", 1, "a b", "pending"],
      ["t2", 2, "second", "pending"],
    ])
    expect(back.tasks[0]!.detail).toBe("d")
    expect(back.tasks[1]!.detail).toBeUndefined()
    expect(back.updatedAt).toBeGreaterThan(0)
  })

  test("ids keep counting across add calls so handoff files never collide", () => {
    let { ledger } = addTasks(emptyLedger(S), [{ title: "one" }])
    ledger = updateTask(ledger, "t1", { status: "done" })
    const second = addTasks(ledger, [{ title: "two" }])
    expect(second.added[0]!.id).toBe("t2")
    expect(nextPending(second.ledger)?.id).toBe("t2")
  })

  test("nextPending / openTasks / counts / fingerprint follow status changes", () => {
    let { ledger } = addTasks(emptyLedger(S), [{ title: "a" }, { title: "b" }, { title: "c" }])
    const f0 = ledgerFingerprint(ledger)
    ledger = updateTask(ledger, "t1", { status: "done" })
    ledger = updateTask(ledger, "t2", { status: "running", attempts: 1 })
    expect(nextPending(ledger)?.id).toBe("t3")
    expect(openTasks(ledger).map((t) => t.id)).toEqual(["t2", "t3"])
    expect(counts(ledger)).toEqual({ pending: 1, running: 1, done: 1, failed: 0, cancelled: 0 })
    expect(ledgerFingerprint(ledger)).not.toBe(f0)
    expect(ledgerFingerprint(ledger)).toBe(ledgerFingerprint({ ...ledger, updatedAt: 1 }))
  })

  test("handoff file is short markdown with status, files, verify and the worker report", () => {
    const { ledger } = addTasks(emptyLedger(S), [{ title: "impl fib", verify: "pytest -q" }])
    const task: LedgerTask = {
      ...ledger.tasks[0]!,
      status: "done",
      attempts: 1,
      filesChanged: ["fib.py"],
      report: "Files changed: fib.py\nVerification: pytest -q -> 2 passed\nOpen issues: none",
      verify_result: { command: "pytest -q", ok: true, exitCode: 0, timedOut: false, output: "2 passed" },
      review: { verdict: "accept" },
    }
    const rel = writeHandoff(wt.worktree, S, task)
    expect(rel).toBe(`.lca/handoffs/${S}/task-1.md`)
    const text = readFileSync(join(wt.worktree, rel), "utf8")
    expect(text).toContain("# Task 1: impl fib")
    expect(text).toContain("- status: done")
    expect(text).toContain("- files changed: fib.py")
    expect(text).toContain("- verify: PASS `pytest -q`")
    expect(text).toContain("- review: ACCEPT")
    expect(text).toContain("Files changed: fib.py")
    expect(text.split("\n").length).toBeLessThanOrEqual(22)
  })

  test("handoffContext only sees the same batch", () => {
    let { ledger } = addTasks(emptyLedger(S), [{ title: "old" }])
    ledger = updateTask(ledger, "t1", { status: "done", filesChanged: ["old.py"] })
    ledger = addTasks(ledger, [{ title: "new1" }, { title: "new2" }]).ledger
    ledger = updateTask(ledger, "t2", { status: "done" })
    const ctx = handoffContext(ledger, "t3", 600)
    expect(ctx).toContain("Task 2 (done): new1")
    expect(ctx).not.toContain("old")
  })

  test("handoffContext lists only finished earlier tasks and respects the char cap", () => {
    let { ledger } = addTasks(emptyLedger(S), [{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }])
    ledger = updateTask(ledger, "t1", { status: "done", filesChanged: ["x.py", "y.py"] })
    ledger = updateTask(ledger, "t2", { status: "failed", error: "verify failed: boom" })
    ledger = updateTask(ledger, "t4", { status: "done" })
    const ctx = handoffContext(ledger, "t3", 600)
    expect(ctx).toContain("Task 1 (done): a [files: x.py, y.py]")
    expect(ctx).toContain("Task 2 (failed (verify failed: boom)): b")
    expect(ctx).not.toContain("Task 4")
    expect(handoffContext(ledger, "t1", 600)).toBe("")
    const tiny = handoffContext(ledger, "t3", 60)
    expect(tiny.length).toBeLessThanOrEqual(60)
    expect(tiny).toContain("…")
  })

  test("protectedFiles: test files named in the verify command, matched by path or basename", () => {
    expect(protectedFiles({ verify: "python3 -m pytest -q test_rect.py" })).toEqual(["test_rect.py"])
    expect(protectedFiles({ verify: "bun test src/x.test.ts && pytest tests/test_a.py::test_b" })).toEqual(["src/x.test.ts", "tests/test_a.py"])
    expect(protectedFiles({ verify: "pytest -q" })).toEqual([])
    expect(protectedFiles({ verify: "python3 -m pytest -q rect.py" })).toEqual([]) // not a test file name
    const task = { title: "impl rect", detail: "write rect.py" }
    expect(protectedViolations(["rect.py", "tests/test_rect.py"], ["test_rect.py"], task)).toEqual({ violations: ["tests/test_rect.py"], suspicious: [] })
    expect(protectedViolations(["rect.py"], ["test_rect.py"], task)).toEqual({ violations: [], suspicious: [] })
    // same basename in another directory: suspicious (shown to the reviewer), not restored
    expect(protectedViolations(["pkg/other/test_rect.py"], ["src/test_rect.py"], task)).toEqual({ violations: [], suspicious: ["pkg/other/test_rect.py"] })
    // runner-autoloaded files are protected unless the task names them
    expect(protectedViolations(["conftest.py", "Makefile", "package.json", "src/x.py"], ["test_rect.py"], task).violations).toEqual(["conftest.py", "Makefile", "package.json"])
    expect(protectedViolations(["package.json"], [], { title: "add jest to package.json", detail: "" }).violations).toEqual([])
    // no file named in verify (pytest -q tests/, bun test): test-looking changes are violations
    expect(protectedViolations(["tests/test_a.py", "src/a.py", "x.test.ts", "b_test.go", "spec/c_spec.rb"], [], task).violations).toEqual(["tests/test_a.py", "x.test.ts", "b_test.go", "spec/c_spec.rb"])
  })

  test("openIssues recognizes plain and bracketed empty markers without hiding reasons", () => {
    expect(openIssues("Files changed: a\nVerification: ok\nOpen issues: none")).toBeUndefined()
    expect(openIssues("Open issues: n/a")).toBeUndefined()
    expect(openIssues("Open issues: no")).toBeUndefined()
    expect(openIssues("Open issues: -")).toBeUndefined()
    expect(openIssues("Open issues: nothing")).toBeUndefined()
    expect(openIssues("Open issues: <none>")).toBeUndefined()
    expect(openIssues("Open issues: <n/a>")).toBeUndefined()
    expect(openIssues("Open issues: <no>")).toBeUndefined()
    expect(openIssues("Open issues: <->")).toBeUndefined()
    expect(openIssues("Open issues: <nothing>")).toBeUndefined()
    expect(openIssues("Open issues: test_rect.py asserts 1 == 2, cannot pass")).toBe("test_rect.py asserts 1 == 2, cannot pass")
    expect(openIssues("Open issues: <network access is blocked>")).toBe("<network access is blocked>")
    expect(openIssues("Open issues: <none; tests still fail>")).toBe("<none; tests still fail>")
    expect(openIssues("Open issues:\n- the test is impossible")).toBe("the test is impossible")
  })

  test("tasks added in one call share a batch number; a later call starts a new batch", () => {
    let { ledger } = addTasks(emptyLedger(S), [{ title: "a" }, { title: "b" }])
    ledger = addTasks(ledger, [{ title: "c" }]).ledger
    expect(ledger.tasks.map((t) => t.batch)).toEqual([1, 1, 2])
  })

  test("cancelOpen settles every pending/running task with the reason and clears running", () => {
    let { ledger } = addTasks(emptyLedger(S), [{ title: "a" }, { title: "b" }, { title: "c" }])
    ledger = updateTask(updateTask(ledger, "t1", { status: "done" }), "t2", { status: "running" })
    const r = cancelOpen({ ...ledger, running: { taskId: "t2", since: 1 } }, "superseded")
    expect(r.ids).toEqual(["t2", "t3"])
    expect(r.ledger.tasks.map((t) => t.status)).toEqual(["done", "cancelled", "cancelled"])
    expect(r.ledger.tasks[2]!.error).toBe("superseded")
    expect(r.ledger.running).toBeUndefined()
  })

  test("a corrupt or wrong-shape ledger is moved aside, never overwritten", () => {
    const p = ledgerPath(wt.worktree, S)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, "{not json")
    const r = readLedgerChecked(wt.worktree, S)
    expect(r.ledger.tasks).toEqual([])
    expect(r.corrupt).toMatch(/ledger\.json\.corrupt-\d+$/)
    expect(existsSync(r.corrupt!)).toBe(true)
    expect(existsSync(p)).toBe(false)
    writeFileSync(p, JSON.stringify({ version: 2, tasks: [] }))
    const r2 = readLedgerChecked(wt.worktree, S)
    expect(r2.corrupt).toBeDefined()
    expect(readFileSync(r2.corrupt!, "utf8")).toContain('"version":2')
  })

  test("summarizeLedger: header counts, one line per task, char cap", () => {
    let { ledger } = addTasks(emptyLedger(S), [{ title: "a" }, { title: "b", verify: "false" }, { title: "c" }])
    ledger = updateTask(ledger, "t1", { status: "done", filesChanged: ["a.py"], review: { verdict: "accept" } })
    ledger = updateTask(ledger, "t2", {
      status: "failed",
      error: "verify failed (exit 1): boom",
      verify_result: { command: "false", ok: false, exitCode: 1, timedOut: false, output: "line1\nboom" },
      handoff: ".lca/handoffs/ses_main/task-2.md",
    })
    const text = summarizeLedger(ledger)
    expect(text.split("\n")[0]).toBe("Delegate result: 3 task(s) — 1 done, 1 failed, 1 not run.")
    expect(text).toContain("1. [done] a — files: a.py; review: accept")
    expect(text).toContain("2. [failed] b — verify: FAIL; error: verify failed (exit 1): boom")
    expect(text).toContain("Handoffs with details: .lca/handoffs/ses_main/task-2.md")
    expect(summarizeLedger(ledger, ["t1"])).toContain("1 task(s) — 1 done, 0 failed.")
    expect(summarizeLedger(ledger, undefined, { note: "1 stale task cancelled." })).toContain("1 stale task cancelled.")
  })

  test("summary keeps one line per task and the handoffs line even when every task failed (12 tasks)", () => {
    let { ledger } = addTasks(emptyLedger(S), Array.from({ length: 12 }, (_, i) => ({ title: `Implement module number ${i + 1} with a long descriptive title that goes on and on`, verify: "false" })))
    for (const t of ledger.tasks) {
      ledger = updateTask(ledger, t.id, {
        status: "failed",
        error: "verify failed (exit 1): assertion boom in test_something_long",
        filesChanged: ["a/b/c/d/file1.py", "a/b/c/d/file2.py", "a/b/c/d/file3.py", "a/b/c/d/file4.py", "a/b/c/d/file5.py", "a/b/c/d/file6.py", "a/b/c/d/file7.py"],
        verify_result: { command: "false", ok: false, exitCode: 1, timedOut: false, output: "x".repeat(400) },
        handoff: `.lca/handoffs/${S}/task-${t.n}.md`,
      })
    }
    const s = summarizeLedger(ledger)
    for (let n = 1; n <= 12; n++) expect(s).toContain(`${n}. [failed]`)
    expect(s).toContain("Handoffs with details")
    expect(s.length).toBeLessThanOrEqual(2400)
    // no-verdict reviews are reported as such, never as an "error" word for the user
    const one = updateTask(ledger, "t1", { status: "done", error: undefined, review: { verdict: "error", reason: "unparseable verdict: x" } })
    expect(summarizeLedger(one, ["t1"])).toContain("review: no verdict")
    expect(summarizeLedger(one, ["t1"])).not.toContain("unparseable")
  })
})
