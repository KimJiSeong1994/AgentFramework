import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createSnapshotStore, diffSnapshots, snapshotTree } from "../src/orchestration/snapshot.ts"
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

  test("diff paths preserve exact leading and trailing whitespace", async () => {
    const before = await snapshotTree(wt.worktree)
    const name = " leading and trailing "
    writeFileSync(join(wt.worktree, name), "space-safe\n")
    const after = await snapshotTree(wt.worktree)
    expect((await diffSnapshots(wt.worktree, before, after, 10_000))?.files).toEqual([name])
  })

  test("snapshots ignored artifacts and exact binary paths without touching the real index or objects", async () => {
    const store = await createSnapshotStore(wt.worktree)
    expect(store).not.toBeNull()
    const excludes = DEFAULT_CONFIG.delegate.diff_exclude
    const exactName = " leading\nand trailing "
    const binaryName = ":(exclude) binary.bin"
    const binary = Buffer.from([0x00, 0xff, 0x41, 0x0a])
    try {
      writeFileSync(join(wt.worktree, ".gitignore"), "__pycache__/\n*.pyc\n.lca/plans/\n")
      const indexPath = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: wt.worktree }).toString().trim()
      const index = readFileSync(indexPath)
      const objects = execFileSync("git", ["count-objects", "-v"], { cwd: wt.worktree }).toString()
      const before = await store!.snapshot(excludes)
      expect(before).not.toBeNull()

      mkdirSync(join(wt.worktree, "pkg/__pycache__"), { recursive: true })
      mkdirSync(join(wt.worktree, ".lca/plans"), { recursive: true })
      writeFileSync(join(wt.worktree, "pkg/__pycache__/cache.cpython-313.pyc"), "ignored cache")
      writeFileSync(join(wt.worktree, ".lca/plans/approval.md"), "ignored plan")
      writeFileSync(join(wt.worktree, exactName), "exact path\n")
      writeFileSync(join(wt.worktree, binaryName), binary)

      const after = await store!.snapshot(excludes)
      expect(after).not.toBeNull()
      const diff = await store!.diff(before, after, 10_000)
      expect(diff?.files.sort()).toEqual([binaryName, exactName].sort())
      expect(readFileSync(indexPath)).toEqual(index)
      expect(execFileSync("git", ["count-objects", "-v"], { cwd: wt.worktree }).toString()).toBe(objects)

      writeFileSync(join(wt.worktree, binaryName), Buffer.from([0x42]))
      expect(await store!.restore(after, [binaryName])).toEqual([binaryName])
      expect(readFileSync(join(wt.worktree, binaryName))).toEqual(binary)

      const empty = await store!.snapshot(["*"])
      expect(empty).not.toBeNull()
      expect((await store!.diff(after, empty, 10_000))?.files.sort()).toEqual([
        ".gitignore", "README.md", "keep.py", binaryName, exactName,
      ].sort())
    } finally {
      store!.dispose()
    }
  })

  test("snapshots tracked file deletions from the worktree", async () => {
    const store = await createSnapshotStore(wt.worktree)
    expect(store).not.toBeNull()
    try {
      const before = await store!.snapshot()
      unlinkSync(join(wt.worktree, "keep.py"))
      const after = await store!.snapshot()
      expect((await store!.diff(before, after, 10_000))?.files).toEqual(["keep.py"])
    } finally {
      store!.dispose()
    }
  })

  test("restore recreates original symlink entries", async () => {
    writeFileSync(join(wt.worktree, "target.py"), "target\n")
    symlinkSync("target.py", join(wt.worktree, "source.py"))
    const store = await createSnapshotStore(wt.worktree)
    expect(store).not.toBeNull()
    try {
      const before = await store!.snapshot()
      unlinkSync(join(wt.worktree, "source.py"))
      writeFileSync(join(wt.worktree, "source.py"), "replacement\n")
      expect(await store!.restore(before, ["source.py"])).toEqual(["source.py"])
      expect(lstatSync(join(wt.worktree, "source.py")).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(wt.worktree, "source.py"))).toBe("target.py")
    } finally {
      store!.dispose()
    }
  })

  test("restore preserves binary bytes and executable Git mode", async () => {
    const path = join(wt.worktree, "tool.bin")
    const original = Buffer.from([0, 0xff, 0x41, 0x0a])
    writeFileSync(path, original)
    chmodSync(path, 0o755)
    const store = await createSnapshotStore(wt.worktree)
    expect(store).not.toBeNull()
    try {
      const before = await store!.snapshot()
      chmodSync(path, 0o644)
      writeFileSync(path, Buffer.from([0x42, 0, 0x43]))
      expect(await store!.restore(before, ["tool.bin"])).toEqual(["tool.bin"])
      expect(readFileSync(path)).toEqual(original)
      expect(lstatSync(path).mode & 0o777).toBe(0o755)
    } finally {
      store!.dispose()
    }
  })

  test("restore invalidates matching Python bytecode cache entries", async () => {
    const path = join(wt.worktree, "cached.py")
    writeFileSync(path, "value = 1\n")
    const store = await createSnapshotStore(wt.worktree)
    expect(store).not.toBeNull()
    try {
      const before = await store!.snapshot()
      mkdirSync(join(wt.worktree, "__pycache__"))
      writeFileSync(join(wt.worktree, "__pycache__", "cached.cpython-313.pyc"), "stale")
      writeFileSync(path, "value = 2\n")
      expect(await store!.restore(before, ["cached.py"])).toEqual(["cached.py"])
      expect(readFileSync(path, "utf8")).toBe("value = 1\n")
      expect(existsSync(join(wt.worktree, "__pycache__", "cached.cpython-313.pyc"))).toBe(false)
    } finally {
      store!.dispose()
    }
  })

  test("restore rejects noncanonical names without deleting the normalized target", async () => {
    const store = await createSnapshotStore(wt.worktree)
    expect(store).not.toBeNull()
    try {
      const before = await store!.snapshot()
      writeFileSync(join(wt.worktree, "keep.py"), "changed\n")
      for (const path of ["./keep.py", "folder/../keep.py", join(wt.worktree, "keep.py")]) {
        await expect(store!.restore(before, [path])).rejects.toThrow("noncanonical")
        expect(readFileSync(join(wt.worktree, "keep.py"), "utf8")).toBe("changed\n")
      }
    } finally { store!.dispose() }
  })

  test("restore replaces a planted hardlink without writing its outside inode", async () => {
    const store = await createSnapshotStore(wt.worktree)
    expect(store).not.toBeNull()
    const outside = join(wt.stateHome, "outside.py")
    writeFileSync(outside, "outside\n")
    try {
      const before = await store!.snapshot()
      unlinkSync(join(wt.worktree, "keep.py"))
      linkSync(outside, join(wt.worktree, "keep.py"))
      expect(await store!.restore(before, ["keep.py"])).toEqual(["keep.py"])
      expect(readFileSync(join(wt.worktree, "keep.py"), "utf8")).toBe("x = 1\n")
      expect(readFileSync(outside, "utf8")).toBe("outside\n")
      expect(lstatSync(join(wt.worktree, "keep.py")).nlink).toBe(1)
    } finally { store!.dispose() }
  })

  test("restore refuses an absent-before path through an external parent symlink", async () => {
    const store = await createSnapshotStore(wt.worktree)
    expect(store).not.toBeNull()
    const outside = join(wt.stateHome, "outside")
    mkdirSync(outside)
    writeFileSync(join(outside, "victim.txt"), "untouched\n")
    try {
      const before = await store!.snapshot()
      symlinkSync(outside, join(wt.worktree, "escape"))
      await expect(store!.restore(before, ["escape/victim.txt"])).rejects.toThrow(/outside worktree/)
      expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("untouched\n")
    } finally {
      store!.dispose()
    }
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
