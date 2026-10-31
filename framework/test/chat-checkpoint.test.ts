import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createChatCheckpoints } from "../src/hosts/chat-checkpoint.ts"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function workdir(git: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "otter-ckpt-")))
  dirs.push(dir)
  writeFileSync(join(dir, "a.txt"), "one\n")
  writeFileSync(join(dir, "b.txt"), "bee\n")
  if (git) {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
    run("init", "-q")
    run("add", "-A")
    run("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init")
  }
  return dir
}

describe("chat checkpoints (Git work tree)", () => {
  test("undo restores edits, removes files a command created and brings back deleted ones", async () => {
    const dir = workdir(true)
    const checkpoints = createChatCheckpoints(dir, () => "fix it")
    await checkpoints.beforeEffect({ tool: "edit", path: "a.txt" })
    writeFileSync(join(dir, "a.txt"), "changed\n")
    await checkpoints.beforeEffect({ tool: "bash" })
    writeFileSync(join(dir, "new.txt"), "made by a command\n")
    rmSync(join(dir, "b.txt"))
    await checkpoints.endTurn()
    expect(checkpoints.list()).toEqual([{ id: 1, label: "fix it", at: expect.any(Number), files: undefined }])
    const result = await checkpoints.undo()
    expect(result?.restored.sort()).toEqual(["a.txt", "b.txt", "new.txt"])
    expect(result?.skipped).toEqual([])
    expect(result?.partial).toBe(false)
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n")
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("bee\n")
    expect(existsSync(join(dir, "new.txt"))).toBe(false)
    expect(checkpoints.list()).toEqual([])
    expect(await checkpoints.undo()).toBeUndefined()
    // The user's index and HEAD are untouched by snapshots and restore.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("")
    checkpoints.dispose()
  })

  test("a file changed again after the turn is left alone and reported", async () => {
    const dir = workdir(true)
    const checkpoints = createChatCheckpoints(dir, () => "turn")
    await checkpoints.beforeEffect({ tool: "edit", path: "a.txt" })
    writeFileSync(join(dir, "a.txt"), "model\n")
    writeFileSync(join(dir, "b.txt"), "model too\n")
    await checkpoints.endTurn()
    writeFileSync(join(dir, "a.txt"), "the user edited this afterwards\n")
    const result = await checkpoints.undo()
    expect(result?.restored).toEqual(["b.txt"])
    expect(result?.skipped).toEqual(["a.txt"])
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("the user edited this afterwards\n")
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("bee\n")
    checkpoints.dispose()
  })

  test("turns undo newest first; at most 10 are kept; a turn with no effect takes no checkpoint", async () => {
    const dir = workdir(true)
    let label = ""
    const checkpoints = createChatCheckpoints(dir, () => label)
    await checkpoints.endTurn()
    expect(checkpoints.list()).toEqual([])
    for (let index = 1; index <= 12; index++) {
      label = `turn ${index}`
      await checkpoints.beforeEffect({ tool: "write", path: "a.txt" })
      writeFileSync(join(dir, "a.txt"), `v${index}\n`)
      await checkpoints.endTurn()
    }
    expect(checkpoints.list().map(turn => turn.label)).toEqual(Array.from({ length: 10 }, (_, index) => `turn ${12 - index}`))
    await checkpoints.undo()
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("v11\n")
    await checkpoints.undo()
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("v10\n")
    checkpoints.dispose()
  }, 30_000)
})

describe("chat checkpoints (outside Git)", () => {
  test("written and edited files are backed up; a command's effects are reported as not undoable", async () => {
    const dir = workdir(false)
    const checkpoints = createChatCheckpoints(dir, () => "plain")
    await checkpoints.beforeEffect({ tool: "edit", path: "a.txt" })
    writeFileSync(join(dir, "a.txt"), "changed\n")
    await checkpoints.beforeEffect({ tool: "write", path: "fresh.txt" })
    writeFileSync(join(dir, "fresh.txt"), "new\n")
    await checkpoints.beforeEffect({ tool: "bash" })
    await checkpoints.endTurn()
    expect(checkpoints.list()[0]?.files).toBe(2)
    const result = await checkpoints.undo()
    expect(result?.restored.sort()).toEqual(["a.txt", "fresh.txt"])
    expect(result?.partial).toBe(true)
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n")
    expect(existsSync(join(dir, "fresh.txt"))).toBe(false)
  })

  test("paths outside the worktree are never backed up or restored", async () => {
    const dir = workdir(false)
    const checkpoints = createChatCheckpoints(dir, () => "escape")
    await checkpoints.beforeEffect({ tool: "write", path: "../outside.txt" })
    await checkpoints.endTurn()
    expect(checkpoints.list()[0]?.files).toBe(0)
    expect((await checkpoints.undo())?.restored).toEqual([])
  })
})


describe("checkpoint recovery boundaries", () => {
  test.each(["parent-symlink", "hardlink", "root-symlink", "root-replacement"])("undo refuses %s substitution without touching outside content", async mode => {
    const root = workdir(false)
    const outside = workdir(false)
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src/a.txt"), "before")
    mkdirSync(join(outside, "src"))
    writeFileSync(join(outside, "src/a.txt"), "after")
    const checkpoints = createChatCheckpoints(root, () => "edit")
    await checkpoints.beforeEffect({ tool: "edit", path: "src/a.txt" })
    writeFileSync(join(root, "src/a.txt"), "after")
    await checkpoints.endTurn()
    try {
      if (mode === "parent-symlink") {
        renameSync(join(root, "src"), join(root, "saved"))
        symlinkSync(join(outside, "src"), join(root, "src"))
      } else if (mode === "hardlink") {
        rmSync(join(root, "src/a.txt"))
        linkSync(join(outside, "src/a.txt"), join(root, "src/a.txt"))
      } else {
        const saved = `${root}-saved`
        renameSync(root, saved)
        dirs.push(saved)
        if (mode === "root-symlink") symlinkSync(outside, root)
        else {
          mkdirSync(join(root, "src"), { recursive: true })
          writeFileSync(join(root, "src/a.txt"), "after")
        }
      }
      expect(await checkpoints.undo()).toMatchObject({ restored: [], skipped: ["src/a.txt"] })
      expect(readFileSync(join(outside, "src/a.txt"), "utf8")).toBe("after")
      expect(readFileSync(join(root, "src/a.txt"), "utf8")).toBe("after")
    } finally { checkpoints.dispose() }
  })

  test("failed final Git capture refuses undo and retains its checkpoint", async () => {
    const root = workdir(true)
    const checkpoints = createChatCheckpoints(root, () => "edit")
    try {
      await checkpoints.beforeEffect({ tool: "edit", path: "a.txt" })
      writeFileSync(join(root, "a.txt"), "after")
      writeFileSync(join(root, ".otter"), "not a safe directory")
      await checkpoints.endTurn()
      rmSync(join(root, ".otter"))
      await expect(checkpoints.undo()).rejects.toThrow("final Git checkpoint")
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("after")
      expect(checkpoints.list()).toHaveLength(1)
      await expect(checkpoints.undo()).rejects.toThrow("final Git checkpoint")
    } finally { checkpoints.dispose() }
  })
})
