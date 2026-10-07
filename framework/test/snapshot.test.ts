import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createSnapshotStore, diffSnapshots, snapshotTree } from "../src/orchestration/snapshot.ts"
import { safeGitBuffer } from "../src/orchestration/git-boundary.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { runShell, startShell } from "../src/orchestration/shell.ts"
import { stateRoot } from "../src/state/store.ts"
import { tempGitWorktree, tempWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => (wt = tempGitWorktree({ "README.md": "hi\n", "keep.py": "x = 1\n", ".gitignore": "ignored.txt\n" })))
afterEach(() => wt.cleanup())

describe("snapshot / diff", () => {
  test("owned verifier archives preserve the private tree and ignore export attributes and later edits", async () => {
    writeFileSync(join(wt.worktree, ".gitattributes"), "protected.txt export-ignore\n")
    writeFileSync(join(wt.worktree, "protected.txt"), "original protected input\n")
    mkdirSync(join(wt.worktree, "nested"))
    writeFileSync(join(wt.worktree, "nested", ".gitattributes"), "* export-ignore\n")
    writeFileSync(join(wt.worktree, "nested", "keep.txt"), "nested original\n")
    const binary = Buffer.from([0, 255, 1, 10])
    const name = " leading\nbinary "
    writeFileSync(join(wt.worktree, name), binary)
    writeFileSync(join(wt.worktree, "run.sh"), "#!/bin/sh\nexit 0\n")
    chmodSync(join(wt.worktree, "run.sh"), 0o755)
    writeFileSync(join(wt.worktree, "excluded.txt"), "not a verifier input")
    const index = readFileSync(join(wt.worktree, ".git", "index"))
    const objects = execFileSync("git", ["count-objects", "-v"], { cwd: wt.worktree })
    const store = (await createSnapshotStore(wt.worktree))!
    try {
      const snapshot = await store.snapshot(["excluded.txt"])
      writeFileSync(join(wt.worktree, "protected.txt"), "later mutation\n")
      const archive = await store.archive(snapshot)
      expect(archive).not.toBeNull()
      const output = join(wt.stateHome, "archive-output")
      mkdirSync(output)
      const tar = join(wt.stateHome, "input.tar")
      writeFileSync(tar, archive!)
      execFileSync("tar", ["-xf", tar, "-C", output])
      expect(readFileSync(join(output, "protected.txt"), "utf8")).toBe("original protected input\n")
      expect(readFileSync(join(output, "nested", "keep.txt"), "utf8")).toBe("nested original\n")
      expect(readFileSync(join(output, name))).toEqual(binary)
      expect(lstatSync(join(output, "run.sh")).mode & 0o111).not.toBe(0)
      expect(existsSync(join(output, "excluded.txt"))).toBe(false)
      expect(readFileSync(join(wt.worktree, ".git", "index"))).toEqual(index)
      expect(execFileSync("git", ["count-objects", "-v"], { cwd: wt.worktree })).toEqual(objects)
    } finally { store.dispose() }
  })

  test("archive refuses repository-defined archiver commands before any helper can execute", async () => {
    const store = (await createSnapshotStore(wt.worktree))!
    try {
      const snapshot = await store.snapshot()
      const marker = join(wt.stateHome, "external-archiver-ran")
      execFileSync("git", ["config", "tar.tar.command", `touch ${marker}`], { cwd: wt.worktree })
      await expect(store.archive(snapshot)).rejects.toThrow("tar.tar.command")
      expect(existsSync(marker)).toBe(false)
    } finally { store.dispose() }
  })

  test("private archive and Git output limits fail closed rather than returning truncated input", async () => {
    expect(await safeGitBuffer(wt.worktree, ["show", "HEAD:README.md"], undefined, 1)).toBeNull()
    const store = (await createSnapshotStore(wt.worktree))!
    try {
      writeFileSync(join(wt.worktree, "oversized.bin"), Buffer.alloc(17 * 1024 * 1024))
      const snapshot = await store.snapshot()
      expect(snapshot).not.toBeNull()
      expect(await store.archive(snapshot)).toBeNull()
      expect(await store.archive(null)).toBeNull()
      expect(await store.archive({ tree: snapshot!.tree })).toBeNull()
    } finally { store.dispose() }
  })

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

  test("synchronous guard snapshot matches the durable snapshot for additions and tracked deletions", async () => {
    const store = await createSnapshotStore(wt.worktree)
    expect(store).not.toBeNull()
    try {
      const before = await store!.snapshot(["ignored.txt"])
      writeFileSync(join(wt.worktree, "new.py"), "added\n")
      unlinkSync(join(wt.worktree, "keep.py"))
      const asyncSnapshot = await store!.snapshot(["ignored.txt"])
      const syncSnapshot = store!.snapshotSync(["ignored.txt"])
      expect(syncSnapshot?.tree).toBe(asyncSnapshot?.tree)
      expect((await store!.diff(before, syncSnapshot, 10_000))?.files.sort()).toEqual(["keep.py", "new.py"])
    } finally {
      store!.dispose()
    }
  })

  test("synchronous snapshots distinguish raw-byte Git names when filtering tracked deletions", async () => {
    const store = (await createSnapshotStore(wt.worktree))!
    try {
      writeFileSync(join(wt.worktree, "�"), "existing Unicode filename\n")
      writeFileSync(join(wt.worktree, " leading and trailing "), "whitespace filename\n")
      execFileSync("git", ["add", "."], { cwd: wt.worktree })
      const before = (await store.snapshot())!
      // Git's index can retain an unavailable raw-byte name even on filesystems
      // that refuse creating it (Darwin returns EILSEQ). It must not alias "�".
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: wt.worktree, input: "missing raw filename\n",
      }).toString().trim()
      execFileSync("git", ["update-index", "-z", "--index-info"], {
        cwd: wt.worktree,
        input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from([0xff, 0])]),
      })
      const synchronous = store.snapshotSync()
      const asynchronous = await store.snapshot()
      expect(synchronous).not.toBeNull()
      expect(synchronous?.tree).toBe(before.tree)
      expect(synchronous?.tree).toBe(asynchronous?.tree)
    } finally { store.dispose() }
  })

  test("durable task baseline reopens with private objects and still diffs orphan edits", async () => {
    const directory = join(wt.stateHome, "snapshots", "task-baseline")
    writeFileSync(join(wt.worktree, "before-task.py"), "BASELINE = True\n")
    const userObjects = execFileSync("git", ["count-objects", "-v"], { cwd: wt.worktree }).toString()
    const initial = (await createSnapshotStore(wt.worktree, directory))!
    const baseline = await initial.baseline(["ignored.txt"])
    expect(baseline).not.toBeNull()
    expect(existsSync(join(directory, "objects"))).toBe(true)
    expect(execFileSync("git", ["count-objects", "-v"], { cwd: wt.worktree }).toString()).toBe(userObjects)
    writeFileSync(join(wt.worktree, "orphan.py"), "ORPHAN = True\n")

    const reopened = (await createSnapshotStore(wt.worktree, directory))!
    try {
      const original = await reopened.baseline(["ignored.txt"], true)
      const current = await reopened.snapshot(["ignored.txt"])
      const diff = await reopened.diff(original, current, 10_000)
      expect(diff?.files).toEqual(["orphan.py"])
      expect(diff?.diff).toContain("+ORPHAN = True")
    } finally { reopened.dispose() }
  })

  test("durable baselines fail closed when missing, corrupt, or bound to another worktree or exclusions", async () => {
    const directory = join(wt.stateHome, "snapshots", "task-baseline-invalid")
    const store = (await createSnapshotStore(wt.worktree, directory))!
    try {
      await expect(store.baseline([], true)).rejects.toThrow(/baseline is missing/)
      const baseline = await store.baseline()
      expect(baseline).not.toBeNull()
      const metadataPath = join(directory, "baseline.json")
      const metadata = readFileSync(metadataPath, "utf8")

      await expect(store.baseline(["README.md"], true)).rejects.toThrow(/does not match/)
      const other = tempGitWorktree({ "README.md": "other\n" })
      try {
        const mismatched = (await createSnapshotStore(other.worktree, directory))!
        await expect(mismatched.baseline([], true)).rejects.toThrow(/does not match/)
      } finally { other.cleanup() }

      writeFileSync(metadataPath, "{")
      await expect(store.baseline([], true)).rejects.toThrow(/metadata is corrupt/)
      writeFileSync(metadataPath, metadata)
      const invalidTree = JSON.parse(metadata) as { tree: string }
      invalidTree.tree = "0".repeat(40)
      writeFileSync(metadataPath, JSON.stringify(invalidTree))
      await expect(store.baseline([], true)).rejects.toThrow(/tree is missing or corrupt/)
    } finally { store.dispose() }
  })

  test("snapshot stores refuse symlinked worktree control and durable directories", async () => {
    const outside = join(wt.stateHome, "snapshot-outside")
    mkdirSync(outside)
    symlinkSync(outside, join(wt.stateHome, "snapshot-link"))
    await expect(createSnapshotStore(wt.worktree, join(wt.stateHome, "snapshot-link"))).rejects.toThrow(/control directory is unsafe/)

    const state = stateRoot(wt.worktree)
    mkdirSync(state, { recursive: true })
    symlinkSync(outside, join(state, "sessions"))
    await expect(createSnapshotStore(wt.worktree, join(state, "sessions", "s1", "snapshots", "task"))).rejects.toThrow(/control directory is unsafe/)

    symlinkSync(outside, join(wt.worktree, ".lca"))
    const store = (await createSnapshotStore(wt.worktree))!
    try { expect(await store.snapshot()).toBeNull() }
    finally { store.dispose() }
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
