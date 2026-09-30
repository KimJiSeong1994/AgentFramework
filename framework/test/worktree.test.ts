// Stage 4: per-task git worktree isolation (delegate.worktree). The worktree module alone (creation state, merge,
// conflicts) and the queue path (worker + verify bound to the worktree, main worktree untouched until accepted,
// failed/cancelled tasks discarded, patch kept when the merge no longer applies).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createQueue } from "../src/orchestration/queue.ts"
import { createTaskWorktree, worktreeRoot } from "../src/orchestration/worktree.ts"
import { readLedger } from "../src/state/ledger.ts"
import { fakeClient, GIT_TEST_ENV, makeDeps, tempGitWorktree, verifyScript, type FakeClient } from "./guards-helpers.ts"

const S = "ses_wt"
let wt: ReturnType<typeof tempGitWorktree>
let client: FakeClient
beforeEach(() => {
  wt = tempGitWorktree({ "README.md": "fixture\n", "lib.py": "X = 1\n" })
  client = fakeClient({ promptAsync: true })
})
afterEach(() => wt.cleanup())

const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe", env: GIT_TEST_ENV }).toString().trim()
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8")
const prompts = (agent: string) => client.calls.filter((c) => c.method === "prompt" && (c.args as any).body.agent === agent).map((c) => c.args as any)

describe("task worktree", () => {
  test("starts from HEAD plus the main worktree's uncommitted and untracked state; merge applies the task's diff to main", async () => {
    writeFileSync(join(wt.worktree, "lib.py"), "X = 2\n") // uncommitted tracked change
    writeFileSync(join(wt.worktree, "new_from_earlier_task.py"), "Y = 1\n") // untracked
    mkdirSync(join(wt.worktree, "__pycache__"))
    writeFileSync(join(wt.worktree, "__pycache__", "lib.pyc"), "junk") // excluded by diff_exclude
    const t = await createTaskWorktree(wt.worktree, S, "t1", ["__pycache__", "*.pyc"])
    expect(t).not.toBeNull()
    expect(t!.path).toBe(join(worktreeRoot(wt.worktree), S, "t1"))
    expect(t!.path.startsWith(wt.worktree)).toBe(false) // outside the repository
    expect(read(t!.path, "lib.py")).toBe("X = 2\n")
    expect(read(t!.path, "new_from_earlier_task.py")).toBe("Y = 1\n")
    expect(existsSync(join(t!.path, "__pycache__"))).toBe(false)
    expect(g(wt.worktree, "worktree", "list")).toContain(t!.path)

    // the task edits and adds files in the worktree; main is untouched until merge
    writeFileSync(join(t!.path, "lib.py"), "X = 3\n")
    writeFileSync(join(t!.path, "feature.py"), "def f():\n    return 3\n")
    expect(read(wt.worktree, "lib.py")).toBe("X = 2\n")
    const m = await t!.merge(["__pycache__", "*.pyc"])
    expect(m).toEqual({ ok: true, files: ["feature.py", "lib.py"] })
    expect(read(wt.worktree, "lib.py")).toBe("X = 3\n")
    expect(read(wt.worktree, "feature.py")).toBe("def f():\n    return 3\n")
    expect(read(wt.worktree, "new_from_earlier_task.py")).toBe("Y = 1\n") // still there, unchanged
    await t!.remove()
    expect(existsSync(t!.path)).toBe(false)
    expect(g(wt.worktree, "worktree", "list")).not.toContain("/t1")
  })

  test("a patch that no longer applies (main changed underneath) is reported, main is left alone, the patch is kept", async () => {
    const t = (await createTaskWorktree(wt.worktree, S, "t2", []))!
    writeFileSync(join(t.path, "lib.py"), "X = 10\n")
    writeFileSync(join(wt.worktree, "lib.py"), "X = 99\n") // the user edited the same line meanwhile
    const m = await t.merge([])
    expect(m.ok).toBe(false)
    if (!m.ok) {
      expect(m.reason).toMatch(/does not apply/)
      expect(existsSync(m.patch)).toBe(true)
      expect(readFileSync(m.patch, "utf8")).toContain("+X = 10")
    }
    expect(read(wt.worktree, "lib.py")).toBe("X = 99\n")
    await t.remove()
  })

  test("returns null without a commit (unborn repository) and for a non-git directory", async () => {
    const bare = tempGitWorktree()
    g(bare.worktree, "update-ref", "-d", "HEAD")
    expect(await createTaskWorktree(bare.worktree, S, "t1", [])).toBeNull()
    bare.cleanup()
    mkdirSync(join(wt.worktree, "plain"))
    expect(await createTaskWorktree(join(wt.worktree, "plain"), S, "t1", [])).not.toBeNull() // inside the repo: fine
    expect(await createTaskWorktree("/", S, "t1", [])).toBeNull()
  })
})

describe("queue with delegate.worktree", () => {
  test("worker and verify run in the worktree; main gets the files only after the task is accepted", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, worktree: true } as any })
    const q = createQueue(deps)
    const verify = verifyScript(wt.worktree, "check_feature.sh", "test -f feature.py && grep -q 'return 3' feature.py")
    let seenMainDuringTask: boolean | undefined
    client.replies.worker = (o) => ({
      text: "Files changed: feature.py\nVerification: ok\nOpen issues: none",
      run: () => {
        const dir = o.query?.directory as string
        writeFileSync(join(dir, "feature.py"), "def f():\n    return 3\n")
        seenMainDuringTask = existsSync(join(wt.worktree, "feature.py"))
      },
    })
    q.add(S, [{ title: "add feature", detail: "create feature.py", verify }])
    const run = await q.run(S)
    expect(run).toMatchObject({ done: 1, failed: 0 })
    expect(seenMainDuringTask).toBe(false)
    // the child session was bound to the worktree, and the verify command found the file there
    const created = client.created[0]!
    expect(created.directory).toBe(join(worktreeRoot(wt.worktree), S, "t1"))
    expect(prompts("worker")[0].query.directory).toBe(created.directory)
    const t = readLedger(wt.worktree, S).tasks[0]!
    expect(t.status).toBe("done")
    expect(t.verify_result?.ok).toBe(true)
    expect(t.filesChanged).toEqual(["feature.py"])
    expect(read(wt.worktree, "feature.py")).toBe("def f():\n    return 3\n")
    expect(existsSync(created.directory!)).toBe(false) // removed after the merge
    expect(deps.logs.some((l) => l === "task worktree merged")).toBe(true)
  })

  test("a failed task's worktree changes never reach main; a merge conflict marks the task failed with the patch kept", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, worktree: true, max_attempts: 1 } as any })
    const q = createQueue(deps)
    const failing = verifyScript(wt.worktree, "check_fail.sh", "exit 1")
    const passing = verifyScript(wt.worktree, "check_ok.sh", "exit 0")
    client.replies.worker = (o) => {
      const dir = o.query?.directory as string
      const text = o.body.parts[0].text as string
      if (text.startsWith("Task 1 of")) return { text: "Files changed: junk.py\nVerification: fail\nOpen issues: none", run: () => writeFileSync(join(dir, "junk.py"), "BAD = 1\n") }
      return {
        text: "Files changed: lib.py\nVerification: ok\nOpen issues: none",
        run: () => {
          writeFileSync(join(dir, "lib.py"), "X = 2\n")
          writeFileSync(join(wt.worktree, "lib.py"), "X = 7\n") // the user edits the same line while the task runs
        },
      }
    }
    q.add(S, [
      { title: "bad task", verify: failing },
      { title: "conflicting task", verify: passing },
    ])
    const run = await q.run(S)
    expect(run).toMatchObject({ done: 0, failed: 2 })
    expect(existsSync(join(wt.worktree, "junk.py"))).toBe(false)
    expect(read(wt.worktree, "lib.py")).toBe("X = 7\n")
    const [t1, t2] = readLedger(wt.worktree, S).tasks
    expect(t1!.error).toMatch(/verify failed/)
    expect(t2!.status).toBe("failed")
    expect(t2!.blocked).toMatch(/does not apply/)
    expect(t2!.error).toMatch(/not merged/)
    const patch = join(wt.worktree, ".lca", "handoffs", S, "task-2.patch")
    expect(existsSync(patch)).toBe(true)
    expect(readFileSync(patch, "utf8")).toContain("+X = 2")
    expect(g(wt.worktree, "worktree", "list").split("\n").length).toBe(1) // both worktrees removed
  })

  test("falls back to in-place execution when the repository has no commit", async () => {
    const bare = tempGitWorktree()
    g(bare.worktree, "update-ref", "-d", "HEAD")
    const deps = makeDeps(client, bare.worktree, { delegate: { review: false, worktree: true } as any })
    const q = createQueue(deps)
    client.replies.worker = (o) => ({ text: "Files changed: a.py\nVerification: ok\nOpen issues: none", run: () => writeFileSync(join(bare.worktree, "a.py"), "A = 1\n") })
    q.add(S, [{ title: "in place", verify: verifyScript(bare.worktree, "check_a.sh", "test -f a.py") }])
    expect(await q.run(S)).toMatchObject({ done: 1 })
    expect(client.created[0]!.directory).toBeUndefined()
    expect(deps.logs.some((l) => l.startsWith("task worktree unavailable"))).toBe(true)
    bare.cleanup()
  })
})
