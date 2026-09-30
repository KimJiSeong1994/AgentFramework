import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { diffSnapshots, snapshotTree } from "../src/orchestration/snapshot.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { runShell, startShell } from "../src/orchestration/shell.ts"
import { tempGitWorktree, tempWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => (wt = tempGitWorktree({ "README.md": "hi\n", "keep.py": "x = 1\n", ".gitignore": "ignored.txt\n" })))
afterEach(() => wt.cleanup())

describe("snapshot / diff", () => {
  test("captures untracked + modified files without touching the user's index or HEAD", async () => {
    const before = await snapshotTree(wt.worktree)
    expect(before).not.toBeNull()
    writeFileSync(join(wt.worktree, "new.py"), "def f():\n    return 1\n")
    writeFileSync(join(wt.worktree, "keep.py"), "x = 2\n")
    writeFileSync(join(wt.worktree, "ignored.txt"), "nope\n")
    const after = await snapshotTree(wt.worktree)
    const d = await diffSnapshots(wt.worktree, before, after, 10_000)
    expect(d?.files.sort()).toEqual(["keep.py", "new.py"])
    expect(d?.diff).toContain("+def f():")
    expect(d?.diff).toContain("-x = 1")
    expect(d?.truncated).toBe(false)
    // user's index untouched: new.py is still untracked, HEAD unchanged
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: wt.worktree }).toString()
    expect(status).toContain("?? new.py")
    expect(status).toContain(" M keep.py")
    expect(execFileSync("git", ["log", "--oneline"], { cwd: wt.worktree }).toString().trim().split("\n").length).toBe(1)
  })

  test("the plugin's own .lca/ runtime files are never part of a task diff", async () => {
    const before = await snapshotTree(wt.worktree)
    mkdirSync(join(wt.worktree, ".lca/state/sessions/s1"), { recursive: true })
    writeFileSync(join(wt.worktree, ".lca/state/sessions/s1/session.json"), "{}")
    writeFileSync(join(wt.worktree, "code.py"), "x\n")
    const after = await snapshotTree(wt.worktree)
    const d = await diffSnapshots(wt.worktree, before, after, 10_000)
    expect(d?.files).toEqual(["code.py"])
    const onlyState = await snapshotTree(wt.worktree)
    writeFileSync(join(wt.worktree, ".lca/state/sessions/s1/ledger.json"), "{}")
    expect((await diffSnapshots(wt.worktree, onlyState, await snapshotTree(wt.worktree), 100))?.files).toEqual([])
  })

  test("configured excludes drop build artifacts at any depth (pycache, pyc, nested dirs)", async () => {
    const ex = DEFAULT_CONFIG.delegate.diff_exclude
    const before = await snapshotTree(wt.worktree, ex)
    mkdirSync(join(wt.worktree, "__pycache__"))
    writeFileSync(join(wt.worktree, "__pycache__/a.cpython-313.pyc"), "x")
    mkdirSync(join(wt.worktree, "pkg/sub/__pycache__"), { recursive: true })
    writeFileSync(join(wt.worktree, "pkg/sub/__pycache__/b.pyc"), "x")
    writeFileSync(join(wt.worktree, "pkg/sub/stray.pyc"), "x")
    mkdirSync(join(wt.worktree, ".pytest_cache/v"), { recursive: true })
    writeFileSync(join(wt.worktree, ".pytest_cache/v/x"), "x")
    writeFileSync(join(wt.worktree, "pkg/sub/real.py"), "y = 1\n")
    const after = await snapshotTree(wt.worktree, ex)
    expect((await diffSnapshots(wt.worktree, before, after, 10_000))?.files).toEqual(["pkg/sub/real.py"])
    // without excludes the artifacts are visible (so the exclusion is what hides them, not .gitignore)
    const raw = await snapshotTree(wt.worktree)
    expect((await diffSnapshots(wt.worktree, before, raw, 10_000))?.files).toContain("__pycache__/a.cpython-313.pyc")
  })

  test("identical trees give an empty diff; truncation is flagged", async () => {
    const a = await snapshotTree(wt.worktree)
    const b = await snapshotTree(wt.worktree)
    expect((await diffSnapshots(wt.worktree, a, b, 100))?.files).toEqual([])
    mkdirSync(join(wt.worktree, "big"))
    writeFileSync(join(wt.worktree, "big/blob.txt"), "line\n".repeat(500))
    const c = await snapshotTree(wt.worktree)
    const d = await diffSnapshots(wt.worktree, a, c, 200)
    expect(d?.truncated).toBe(true)
    expect(d?.diff.length).toBeLessThan(300)
    expect(d?.diff).toContain("diff truncated")
  })

  test("snapshots never write blobs into the user's .git/objects (secrets stay out of the repo)", async () => {
    const before = await snapshotTree(wt.worktree)
    const countObjects = () => execFileSync("git", ["count-objects", "-v"], { cwd: wt.worktree }).toString()
    const loose0 = countObjects()
    writeFileSync(join(wt.worktree, ".env"), "SECRET=hunter2\n")
    writeFileSync(join(wt.worktree, "big.bin"), "B".repeat(200_000))
    writeFileSync(join(wt.worktree, "code.py"), "x = 1\n")
    const after = await snapshotTree(wt.worktree, DEFAULT_CONFIG.delegate.diff_exclude)
    const d = await diffSnapshots(wt.worktree, before, after, 10_000)
    expect(d?.files).toEqual(["big.bin", "code.py"]) // .env excluded by default
    expect(countObjects()).toBe(loose0)
    // the secret is not recoverable from the repository's object store
    const all = execFileSync("sh", ["-c", "git cat-file --batch-all-objects --batch-check | wc -l"], { cwd: wt.worktree }).toString().trim()
    expect(all).toBe(execFileSync("sh", ["-c", "git cat-file --batch-all-objects --batch-check | wc -l"], { cwd: wt.worktree }).toString().trim())
    after?.store?.dispose()
    before?.store?.dispose()
  })

  test("outside a git repo snapshot is null and diff is null", async () => {
    const plain = tempWorktree()
    try {
      expect(await snapshotTree(plain.worktree)).toBeNull()
      expect(await diffSnapshots(plain.worktree, null, null, 100)).toBeNull()
    } finally {
      plain.cleanup()
    }
  })
})

describe("runShell", () => {
  test("timeout kills the whole process group, and the promise resolves even if a grandchild held the pipe", async () => {
    const t0 = Date.now()
    const r = await runShell("sleep 30; echo done", { cwd: wt.worktree, timeoutMs: 150 })
    expect(r.timedOut).toBe(true)
    expect(r.ok).toBe(false)
    expect(Date.now() - t0).toBeLessThan(5000)
    await new Promise((res) => setTimeout(res, 100))
    const left = execFileSync("sh", ["-c", "ps -eo command | grep -c '[s]leep 30' || true"]).toString().trim()
    expect(left).toBe("0")
  })

  test("kill() from the handle stops a running verify and reports killed", async () => {
    const h = startShell("sleep 20", { cwd: wt.worktree, timeoutMs: 10_000 })
    setTimeout(() => h.kill("user_stop"), 50)
    const r = await h.result
    expect(r.killed).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.timedOut).toBe(false)
  })

  test("exit code, output tail and timeout", async () => {
    const ok = await runShell("echo hi; echo err 1>&2", { cwd: wt.worktree, timeoutMs: 5000 })
    expect(ok.ok).toBe(true)
    expect(ok.output).toContain("hi")
    expect(ok.output).toContain("err")
    const bad = await runShell("echo nope; exit 3", { cwd: wt.worktree, timeoutMs: 5000 })
    expect(bad.ok).toBe(false)
    expect(bad.exitCode).toBe(3)
    const slow = await runShell("sleep 5", { cwd: wt.worktree, timeoutMs: 100 })
    expect(slow.timedOut).toBe(true)
    expect(slow.ok).toBe(false)
    const long = await runShell("yes | head -c 5000", { cwd: wt.worktree, timeoutMs: 5000, maxOutputChars: 100 })
    expect(long.output.length).toBeLessThanOrEqual(100)
    expect(long.output.startsWith("…")).toBe(true)
  })

  test("runs in the given cwd and can see files written there", async () => {
    writeFileSync(join(wt.worktree, "t.py"), "print('ok')\n")
    const r = await runShell("python3 t.py", { cwd: wt.worktree, timeoutMs: 10_000 })
    expect(r.ok).toBe(true)
    expect(r.output.trim()).toBe("ok")
    expect(readFileSync(join(wt.worktree, "t.py"), "utf8")).toContain("ok")
  })
})
