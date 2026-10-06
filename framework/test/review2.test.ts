// Regression tests for the second critical review (2026-09-23): gaming detection, autoload-file protection,
// snapshot hardening, verify allowlist tightening, resume-on-message, /stop settlement, session-deleted discard.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG, verifyCommandProblem } from "../src/config.ts"
import { scanDiff, taskTextProblem } from "../src/orchestration/gaming.ts"
import { createQueue, getQueue } from "../src/orchestration/queue.ts"
import { createSnapshotStore } from "../src/orchestration/snapshot.ts"
import { startShell } from "../src/orchestration/shell.ts"
import { createDelegateTool } from "../src/tools/delegate.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createCommandHook, STOP_COMMAND } from "../src/hooks/command.ts"
import { createEventHook } from "../src/hooks/event.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { addTasks, emptyLedger, readLedger, updateTask, writeLedger } from "../src/state/ledger.ts"
import { abortPath, sessionDir, stateBase, stateRoot, writeJsonAtomic } from "../src/state/store.ts"
import { fakeClient, GIT_TEST_ENV, makeDeps, tempGitWorktree, tempWorktree, verifyScript, waitFor, type FakeClient } from "./guards-helpers.ts"

const S = "ses_main"
let wt: ReturnType<typeof tempGitWorktree>
let client: FakeClient
beforeEach(() => {
  wt = tempGitWorktree({ "README.md": "fixture\n" })
  client = fakeClient({ promptAsync: true })
})
afterEach(() => wt.cleanup())
const write = (name: string, content: string) => {
  mkdirSync(join(wt.worktree, name, ".."), { recursive: true })
  writeFileSync(join(wt.worktree, name), content)
}
const prompts = (agent: string) => client.calls.filter((c) => c.method === "prompt" && (c.args as any).body.agent === agent)
const noReview = { delegate: { review: false } as any }
const ALLOW = DEFAULT_CONFIG.delegate.verify_allow

describe("gaming detection", () => {
  test("taskTextProblem refuses the two hacks main authored in the negative e2e, accepts honest tasks", () => {
    expect(taskTextProblem("Implement rect.py and fix test_rect.py", "Create rect.py with rect_area(w, h). Also, modify test_rect.py to remove the impossible assertion in test_impossible so that the test file passes.", ["test_rect.py"])).toMatch(/edit a test/)
    expect(taskTextProblem("Implement rect.py", "To make test_rect.py pass despite conflicting assertions for rect_area(2, 3), use a stateful approach so the first call returns 6 and the second returns 7.", ["test_rect.py"])).toMatch(/fake a result/)
    expect(taskTextProblem("Implement rect.py", "Implement rect_area(w, h) returning w * h and rect_perimeter; raise ValueError on negative sides. Verify with test_rect.py.", ["test_rect.py"])).toBeNull()
    expect(taskTextProblem("Fix the failing test in CI", "The test suite fails because circle_area rounds; fix circle.py so the existing tests pass.", [])).toBeNull()
    expect(taskTextProblem("Loosen the assertion", "relax the assertion in test_math.py so it passes", ["test_math.py"])).toMatch(/edit a test/)
    expect(taskTextProblem("Implement parser", "Update the parser and fix the bug the tests found", [])).toBeNull()
  })

  test("scanDiff flags the call-counter hack and frame inspection, ignores protected files and honest code", () => {
    const diff = [
      "diff --git a/rect.py b/rect.py", "--- a/rect.py", "+++ b/rect.py",
      "+_call_count = 0", "+def rect_area(w, h):", "+    global _call_count", "+    _call_count += 1", "+    if _call_count == 2:", "+        return w * h + 1", "+    return w * h",
      "diff --git a/test_rect.py b/test_rect.py", "--- a/test_rect.py", "+++ b/test_rect.py", "+import sys; sys._getframe()",
    ].join("\n")
    const s = scanDiff(diff, ["test_rect.py"])
    expect(s.strong.some((x) => /call counter/.test(x))).toBe(true)
    expect(s.strong.every((x) => x.startsWith("rect.py:"))).toBe(true)
    expect(s.strong.length + s.weak.length).toBeGreaterThanOrEqual(2)
    const honest = ["+++ b/circle.py", "+import math", "+def circle_area(r):", "+    if r < 0: raise ValueError('negative radius')", "+    return math.pi * r ** 2"].join("\n")
    expect(scanDiff(honest)).toEqual({ strong: [], weak: [] })
  })
})

describe("verify allowlist (second pass)", () => {
  test("cd stays inside the project and never stands alone; runner options that load repo code are refused", () => {
    expect(verifyCommandProblem("cd .", ALLOW)).toMatch(/no test\/check runner/)
    expect(verifyCommandProblem("cd sub", ALLOW)).toMatch(/no test\/check runner/)
    expect(verifyCommandProblem("cd a/../.. && pytest -q", ALLOW)).toMatch(/cd must stay inside/)
    expect(verifyCommandProblem("cd ./sub && pytest -q test_a.py", ALLOW)).toBeNull()
    expect(verifyCommandProblem("cd .. && pytest -q", ALLOW)).toMatch(/cd must stay inside/)
    expect(verifyCommandProblem("cd /tmp/x && pytest -q test_a.py", ALLOW)).toMatch(/cd must stay inside/)
    expect(verifyCommandProblem("cd tests && python3 -m pytest -q test_a.py", ALLOW)).toBeNull()
    expect(verifyCommandProblem("pytest -p evil test_a.py", ALLOW)).toMatch(/runner option/)
    expect(verifyCommandProblem("pytest -c evil.ini", ALLOW)).toMatch(/runner option/)
    expect(verifyCommandProblem("pytest --rootdir=/tmp test_a.py", ALLOW)).toMatch(/runner option/)
    expect(verifyCommandProblem("bun test --preload ./x.ts", ALLOW)).toMatch(/runner option/)
    expect(verifyCommandProblem("pytest -q test_a.py\nrm -rf /", ALLOW)).toMatch(/control character/)
    expect(verifyCommandProblem("pytest -q -k 'a or b' test_a.py", ALLOW)).toBeNull()
    expect(verifyCommandProblem("python3 -m pytest -q test_x.py && python3 -m mypy x.py", ALLOW)).toBeNull()
  })
})

describe("protected files (second pass)", () => {
  test("conftest.py skipping every test is restored before verify and fails the attempt; the verify result is void", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, max_attempts: 1 } as any })
    const q = createQueue(getOpenCodeRuntime(deps))
    write("test_rect.py", "def test_x():\n    assert 1 == 2\n")
    client.replies.worker = {
      text: "Files changed: rect.py, conftest.py\nOpen issues: none",
      run: () => {
        write("rect.py", "x = 1\n")
        write("conftest.py", "import pytest\ndef pytest_runtest_setup(item):\n    pytest.skip('neutralised')\n")
      },
    }
    q.add(S, [{ title: "rect", detail: "implement rect.py", verify: "python3 -m pytest -q test_rect.py" }])
    const run = await q.run(S)
    expect(run.failed).toBe(1)
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.error).toContain("modified protected file(s): conftest.py")
    expect(existsSync(join(wt.worktree, "conftest.py"))).toBe(false) // restored = removed (did not exist before)
    expect(t.verify_result?.ok).toBe(false)
    expect(t.verify_result?.output).toContain("void")
    expect(t.filesChanged).toEqual(["rect.py"])
  })

  test("a task that names package.json may edit it; test-looking files are protected when verify names none", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, max_attempts: 1 } as any })
    const q = createQueue(getOpenCodeRuntime(deps))
    const ok = verifyScript(wt.worktree, "check_pkg.sh", "test -f package.json")
    client.replies.worker = (o, nth) => ({
      text: "ok",
      run: () => {
        if (nth === 1) write("package.json", '{"scripts":{"test":"echo"}}\n')
        else write("tests/test_a.py", "def test_a(): assert True\n")
      },
    })
    q.add(S, [{ title: "add jest to package.json", detail: "edit package.json scripts", verify: ok }, { title: "b", detail: "impl", verify: "python3 -m pytest -q tests/" }])
    const run = await q.run(S)
    const l = readLedger(wt.worktree, S)
    expect(l.tasks[0]!.status).toBe("done")
    expect(l.tasks[1]!.status).toBe("failed")
    expect(l.tasks[1]!.error).toContain("tests/test_a.py")
    expect(existsSync(join(wt.worktree, "tests/test_a.py"))).toBe(false) // restored = removed
    expect(run.done + run.failed).toBe(2)
  })

  test("strong gaming pattern in the code fails the attempt even though verify passes and no test file was touched", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, max_attempts: 1 } as any })
    const q = createQueue(getOpenCodeRuntime(deps))
    client.replies.worker = { text: "ok", run: () => write("rect.py", "_call_count = 0\ndef rect_area(w, h):\n    global _call_count\n    _call_count += 1\n    return w * h + (1 if _call_count == 2 else 0)\n") }
    q.add(S, [{ title: "rect", verify: verifyScript(wt.worktree, "verify_ok.sh", "exit 0") }])
    const run = await q.run(S)
    expect(run.failed).toBe(1)
    expect(readLedger(wt.worktree, S).tasks[0]!.error).toContain("test-gaming pattern")
  })

  test("a worker that reports the task as impossible (Open issues) is not retried after a failed verify", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, max_attempts: 2 } as any })
    const q = createQueue(getOpenCodeRuntime(deps))
    client.replies.worker = { text: "Files changed: rect.py\nVerification: 1 failed\nOpen issues: test_rect.py asserts 1 == 2, cannot pass honestly", run: () => write("rect.py", "x=1\n") }
    q.add(S, [{ title: "rect", verify: verifyScript(wt.worktree, "verify_fail.sh", "exit 1") }])
    const run = await q.run(S)
    expect(run.failed).toBe(1)
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.attempts).toBe(1)
    expect(t.blocked).toContain("cannot pass honestly")
    expect(readFileSync(join(wt.worktree, t.handoff!), "utf8")).toContain("- worker reports: test_rect.py asserts")
  })

  test("outside git a coding task fails before any worker or unguarded review", async () => {
    const plain = tempWorktree()
    try {
      const deps = makeDeps(client, plain.worktree)
      const q = createQueue(getOpenCodeRuntime(deps))
      client.replies.worker = { text: "ok", run: () => writeFileSync(join(plain.worktree, "a.py"), "x") }
      client.replies.reviewer = { text: "REJECT: never asked" }
      q.add(S, [{ title: "a" }])
      const run = await q.run(S)
      expect(run.noSnapshot).toBe(true)
      expect(run).toMatchObject({ done: 0, failed: 1 })
      expect(prompts("worker")).toHaveLength(0)
      expect(prompts("reviewer").length).toBe(0)
      const t = readLedger(plain.worktree, S).tasks[0]!
      expect(t).toMatchObject({ status: "failed", error: "could not snapshot the task baseline" })
    } finally {
      plain.cleanup()
    }
  })
})

describe("snapshot hardening", () => {
  test("a worker-planted clean filter is refused before git add runs it", async () => {
    write(".gitattributes", "* filter=evil\n")
    execFileSync("git", ["config", "filter.evil.clean", `sh -c 'touch ${join(wt.worktree, "PWNED")}; cat'`], { cwd: wt.worktree, env: GIT_TEST_ENV })
    write("x.py", "x\n")
    await expect(createSnapshotStore(wt.worktree)).rejects.toThrow(/git-config: forbidden filter\.evil\.clean/)
    expect(existsSync(join(wt.worktree, "PWNED"))).toBe(false)
  })

  test("restore never writes through a worker-planted symlink and drops stale bytecode", async () => {
    const outside = tempWorktree()
    try {
      const victim = join(outside.worktree, "victim.txt")
      writeFileSync(victim, "untouched\n")
      write("test_rect.py", "assert 1 == 2\n")
      const store = (await createSnapshotStore(wt.worktree))!
      const before = await store.snapshot()
      mkdirSync(join(wt.worktree, "__pycache__"))
      writeFileSync(join(wt.worktree, "__pycache__/test_rect.cpython-313-pytest-9.pyc"), "stale")
      execFileSync("rm", ["-f", join(wt.worktree, "test_rect.py")])
      symlinkSync(victim, join(wt.worktree, "test_rect.py"))
      await store.restore(before, ["test_rect.py"])
      store.dispose()
      expect(readFileSync(victim, "utf8")).toBe("untouched\n")
      expect(lstatSync(join(wt.worktree, "test_rect.py")).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(wt.worktree, "test_rect.py"), "utf8")).toBe("assert 1 == 2\n")
      expect(existsSync(join(wt.worktree, "__pycache__/test_rect.cpython-313-pytest-9.pyc"))).toBe(false)
    } finally {
      outside.cleanup()
    }
  })

  test("handoff writing refuses a symlinked .lca/handoffs and the unsafe snapshot fails closed", async () => {
    const outside = tempWorktree()
    try {
      mkdirSync(join(wt.worktree, ".lca"))
      symlinkSync(outside.worktree, join(wt.worktree, ".lca/handoffs"))
      const deps = makeDeps(client, wt.worktree, noReview)
      const q = createQueue(getOpenCodeRuntime(deps))
      client.replies.worker = { text: "ok", run: () => write("a.py", "x") }
      q.add(S, [{ title: "a" }])
      const run = await q.run(S)
      expect(run).toMatchObject({ done: 0, failed: 1 })
      const t = readLedger(wt.worktree, S).tasks[0]!
      expect(t).toMatchObject({ status: "failed", error: "could not snapshot the task baseline" })
      expect(t.handoff).toBeUndefined()
      expect(deps.logs).toContain("handoff write failed")
      expect(readlinkSync(join(wt.worktree, ".lca/handoffs"))).toBe(outside.worktree)
    } finally {
      outside.cleanup()
    }
  })
})

describe("state root containment", () => {
  test("LCA_STATE_HOME inside the worktree is ignored; XDG empty string falls back", () => {
    const saved = { lca: process.env.LCA_STATE_HOME, xdg: process.env.XDG_STATE_HOME }
    try {
      process.env.LCA_STATE_HOME = join(wt.worktree, ".lca", "state")
      expect(stateRoot(wt.worktree).startsWith(wt.worktree)).toBe(false)
      process.env.LCA_STATE_HOME = ""
      process.env.XDG_STATE_HOME = ""
      expect(stateBase(wt.worktree)).toMatch(/\.local\/state\/lca$/)
    } finally {
      process.env.LCA_STATE_HOME = saved.lca
      process.env.XDG_STATE_HOME = saved.xdg
    }
  })
})

describe("abort timing / resilience", () => {
  test("/stop arriving between the worker's end and the verify spawn kills the verify at once", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const q = createQueue(getOpenCodeRuntime(deps))
    let workerDone = false
    client.replies.worker = { text: "ok", run: () => write("a.py", "x") }
    const slow = verifyScript(wt.worktree, "verify_slow.sh", "sleep 5")
    q.add(S, [{ title: "a", verify: slow }])
    // abort the moment the worker prompt resolves (before verify starts)
    const orig = client.session.prompt
    client.session.prompt = async (o) => {
      const r = await orig(o)
      workerDone = true
      await q.abort(S, "user_stop")
      return r
    }
    const t0 = Date.now()
    const run = await q.run(S)
    expect(workerDone).toBe(true)
    expect(run.aborted).toBe(true)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(readLedger(wt.worktree, S).tasks[0]!.status).toBe("cancelled")
  })

  test("a queue crash marks the running task failed and cancels the rest", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const realLog = deps.log
    deps.log = (msg, extra) => {
      if (msg === "task verify") throw new Error("boom inside the queue")
      realLog(msg, extra)
    }
    const q = createQueue(getOpenCodeRuntime(deps))
    client.replies.worker = { text: "ok", run: () => write("a.py", "x") }
    q.add(S, [{ title: "a", verify: verifyScript(wt.worktree, "verify_ok.sh", "exit 0") }, { title: "b" }])
    q.add("unused", [])
    const runX = await (async () => {
      const r = await q.run(S)
      return r
    })()
    expect(runX.aborted).toBe(true)
    expect(runX.abortReason).toContain("queue error")
    const lx = readLedger(wt.worktree, S)
    expect(lx.running).toBeUndefined()
    expect(lx.tasks.map((t) => t.status)).toEqual(["failed", "cancelled"])
    return
    client.replies.worker = () => {
      throw new Error("boom in fake")
    }
    q.add(S, [{ title: "a" }, { title: "b" }])
    const run = await q.run(S)
    expect(run.aborted).toBe(true)
    const l = readLedger(wt.worktree, S)
    expect(l.running).toBeUndefined()
    expect(l.tasks.every((t) => t.status === "failed" || t.status === "cancelled")).toBe(true)
  })

  test("startShell: a process ignoring SIGTERM is SIGKILLed once, without a leaked second timer", async () => {
    const h = startShell("trap '' TERM; sleep 30", { cwd: wt.worktree, timeoutMs: 100 })
    h.kill("twice")
    h.kill("twice")
    const r = await h.result
    expect(r.ok).toBe(false)
    expect(r.exitCode === 128 || r.exitCode === null || r.exitCode === 137).toBe(true)
  })
})

describe("delegate refusals and auto-resume", () => {
  const ctx = (sessionID = S) => ({ sessionID, messageID: "m", agent: "main", directory: wt.worktree, worktree: wt.worktree, abort: new AbortController().signal, metadata() {}, ask: async () => {} })

  test("tasks that instruct editing tests or faking results are refused with the reason", async () => {
    const tool = createDelegateTool(makeDeps(client, wt.worktree, noReview))
    const p = tool.execute({ tasks: [{ title: "Implement rect.py", detail: "use a stateful approach so the first call returns 6 and the second returns 7", verify: "pytest -q test_rect.py" }] }, ctx() as any)
    await expect(p).rejects.toThrow(/tasks refused[\s\S]*fake a result/)
    expect(client.created.length).toBe(0)
  })

  test("re-sending the same titles after an interruption resumes instead of superseding", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const tool = createDelegateTool(deps)
    let { ledger } = addTasks(emptyLedger(S), [{ title: "Implement circle.py" }, { title: "Implement rect.py" }])
    ledger = updateTask(ledger, "t1", { status: "done" })
    ledger = updateTask(ledger, "t2", { status: "running", attempts: 1 })
    writeLedger(wt.worktree, { ...ledger, running: { taskId: "t2", since: 1 } })
    client.replies.worker = { text: "ok", run: () => write("rect.py", "x") }
    const out = (await tool.execute({ tasks: [{ title: "Implement circle.py" }, { title: "Implement rect.py" }] }, ctx() as any)) as { output: string }
    expect(out.output).toContain("resumed instead of restarted")
    const l = readLedger(wt.worktree, S)
    expect(l.tasks.length).toBe(2)
    expect(l.tasks.map((t) => t.status)).toEqual(["done", "done"])
    expect(prompts("worker").length).toBe(1)
  })
})

describe("resume offer on the next user message; /stop settles; session.deleted discards", () => {
  test("chat.message attaches the resume offer once when open tasks exist (also with a mode suffix)", async () => {
    const deps = makeDeps(client, wt.worktree)
    writeLedger(wt.worktree, addTasks(emptyLedger(S), [{ title: "a" }, { title: "b" }]).ledger)
    const part: any = { type: "text", text: "status?" }
    await createChatMessageHook(deps)({ sessionID: S, agent: "main" }, { message: {} as any, parts: [part] })
    expect(part.text).toContain("<lca-resume>")
    expect(part.text).toContain("resume: true")
    const again: any = { type: "text", text: "ulw: and now more" }
    await createChatMessageHook(deps)({ sessionID: S, agent: "main" }, { message: {} as any, parts: [again] })
    expect(again.text).not.toContain("<lca-resume>")
    expect(again.text).toContain('<lca-mode name="ulw">')
    expect(readLedger(wt.worktree, S).resumeNotifiedFor).toEqual(["t1", "t2"])
  })

  test("/stop with no queue running cancels open tasks so nothing is offered later", async () => {
    const deps = makeDeps(client, wt.worktree)
    writeLedger(wt.worktree, addTasks(emptyLedger(S), [{ title: "a" }]).ledger)
    await createCommandHook(deps)({ command: STOP_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    expect(readLedger(wt.worktree, S).tasks[0]!.status).toBe("cancelled")
    const part: any = { type: "text", text: "ok" }
    await createChatMessageHook(deps)({ sessionID: S, agent: "main" }, { message: {} as any, parts: [part] })
    expect(part.text).not.toContain("<lca-resume>")
  })

  test("session.deleted while the queue runs: abort + the state dir is not resurrected", async () => {
    const deps = makeDeps(client, wt.worktree, noReview)
    const q = getQueue(getOpenCodeRuntime(deps))
    let started = false
    client.replies.worker = { text: "x", run: () => ((started = true), new Promise<void>(() => {})) }
    q.add(S, [{ title: "a" }, { title: "b" }])
    const running = q.run(S)
    await waitFor(() => started)
    await createEventHook(deps)({ event: { type: "session.deleted", properties: { info: { id: S } } } } as any)
    await running
    await new Promise((r) => setTimeout(r, 20))
    expect(existsSync(sessionDir(wt.worktree, S))).toBe(false)
    expect(existsSync(join(wt.worktree, ".lca/handoffs", S))).toBe(false)
  })
})
