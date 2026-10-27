// Stage 4: per-task git worktree isolation (delegate.worktree). The worktree module alone (creation state, merge,
// conflicts) and the queue path (worker + verify bound to the worktree, main worktree untouched until accepted,
// failed/cancelled tasks preserved, patch kept when the merge no longer applies).
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createQueue } from "../src/orchestration/queue.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { createTaskWorktree, hasPlanWorktreeState, hasTaskWorktreeState, planIsolationAvailability, planWorktreePath, planWorktreeScope, reopenPlanWorktree, reopenTaskWorktree, taskWorktreeOwner, worktreeRoot } from "../src/orchestration/worktree.ts"
import { createSnapshotStore } from "../src/orchestration/snapshot.ts"
import * as snapshots from "../src/orchestration/snapshot.ts"
import * as gitBoundary from "../src/orchestration/git-boundary.ts"
import { readLedger } from "../src/state/ledger.ts"
import { fakeClient, GIT_TEST_ENV, makeDeps, tempGitWorktree, verifyScript, waitFor, type FakeClient } from "./guards-helpers.ts"

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
const recoveryDir = (taskId: string) => join(worktreeRoot(wt.worktree), ".recovery", S, taskId)

describe("task worktree", () => {
  test.each(["symlink", "non-directory state"])("failed initial baseline is rolled back so the same task can retry after source repair: %s", async obstruction => {
    mkdirSync(join(wt.worktree, "safe-data"))
    if (obstruction === "symlink") symlinkSync("safe-data", join(wt.worktree, ".otter"))
    else { mkdirSync(join(wt.worktree, ".otter")); writeFileSync(join(wt.worktree, ".otter", "state"), "not a directory\n") }
    g(wt.worktree, "add", ".otter")
    g(wt.worktree, "commit", "-qm", "unsafe control directory fixture")
    const head = g(wt.worktree, "rev-parse", "HEAD")
    await expect(createTaskWorktree(wt.worktree, S, "retry-baseline", [])).rejects.toThrow("snapshot control directory is unsafe")
    expect(hasTaskWorktreeState(wt.worktree, S, "retry-baseline")).toBe(false)
    expect(g(wt.worktree, "worktree", "list", "--porcelain")).not.toContain("retry-baseline")
    expect(g(wt.worktree, "rev-parse", "HEAD")).toBe(head)
    expect(read(wt.worktree, "lib.py")).toBe("X = 1\n")
    if (obstruction === "symlink") { unlinkSync(join(wt.worktree, ".otter")); mkdirSync(join(wt.worktree, ".otter")) }
    else {
      // .otter/state is always excluded from dirty imports; repair its committed source too.
      g(wt.worktree, "rm", ".otter/state")
      g(wt.worktree, "commit", "-qm", "repair excluded control directory fixture")
    }
    const retried = await createTaskWorktree(wt.worktree, S, "retry-baseline", [])
    expect(retried).not.toBeNull()
    await retried!.remove()
    expect(hasTaskWorktreeState(wt.worktree, S, "retry-baseline")).toBe(false)
  })

  test.each(["child", "owner", "baseline", "objects", "owner symlink", "unknown entry", "baseline metadata", "object file"])("creation rollback preserves %s changed during initialization", async replacement => {
    const task = "rollback-refusal"
    const child = join(worktreeRoot(wt.worktree), S, task)
    const owner = recoveryDir(task)
    const objects = join(owner, "baseline", "objects")
    let sentinel = ""
    const original = snapshots.createSnapshotStore
    const intercepted = spyOn(snapshots, "createSnapshotStore").mockImplementation(async (...args) => {
      const store = await original(...args)
      if (!store) return store
      return { ...store, async baseline() {
        if (["unknown entry", "baseline metadata", "object file"].includes(replacement)) {
          sentinel = replacement === "baseline metadata" ? join(owner, "baseline", "baseline.json")
            : replacement === "object file" ? join(objects, "unrelated.txt") : join(owner, "unrelated.txt")
          writeFileSync(sentinel, "KEEP\n")
        } else {
          const target = replacement === "child" ? child : replacement === "objects" ? objects : replacement === "baseline" ? join(owner, "baseline") : owner
          renameSync(target, `${target}.retained`)
          if (replacement === "owner symlink") {
            const victim = join(wt.stateHome, "unrelated-victim")
            mkdirSync(victim)
            symlinkSync(victim, target)
            sentinel = join(victim, "unrelated.txt")
          } else {
            mkdirSync(target)
            sentinel = join(target, "unrelated.txt")
          }
          writeFileSync(sentinel, "KEEP\n")
        }
        throw new Error("injected initial baseline failure")
      } }
    })
    try {
      await expect(createTaskWorktree(wt.worktree, S, task, [])).rejects.toThrow(/injected initial baseline failure; creation cleanup refused:/)
      expect(readFileSync(sentinel, "utf8")).toBe("KEEP\n")
      expect(existsSync(child)).toBe(true)
      expect(read(wt.worktree, "lib.py")).toBe("X = 1\n")
    } finally { intercepted.mockRestore() }
  })

  test("failed initial patch import removes its owned patch and permits retry", async () => {
    writeFileSync(join(wt.worktree, "lib.py"), "X = 2\n")
    const task = "retry-import"
    const original = gitBoundary.safeGit
    const intercepted = spyOn(gitBoundary, "safeGit").mockImplementation(async (cwd, args, extra) =>
      args[0] === "apply" ? null : original(cwd, args, extra))
    try {
      await expect(createTaskWorktree(wt.worktree, S, task, [])).rejects.toThrow("could not import main worktree changes")
      expect(hasTaskWorktreeState(wt.worktree, S, task)).toBe(false)
      expect(existsSync(join(worktreeRoot(wt.worktree), S, `${task}.base.patch`))).toBe(false)
      expect(read(wt.worktree, "lib.py")).toBe("X = 2\n")
    } finally { intercepted.mockRestore() }
    const retried = (await createTaskWorktree(wt.worktree, S, task, []))!
    expect(read(retried.path, "lib.py")).toBe("X = 2\n")
    await retried.remove()
  })

  test.each([
    ["filter.evil.clean", "sh -c 'touch sentinel'"],
    ["diff.evil.textconv", "sh -c 'touch sentinel'"],
    ["merge.evil.driver", "sh -c 'touch sentinel'"],
    ["include.path", "sentinel"],
    ["includeIf.onbranch:main.path", "sentinel"],
    ["core.fsmonitor", "sh -c 'touch sentinel'"],
    ["core.hooksPath", "sentinel"],
    ["alias.evil", "!touch sentinel"],
    ["credential.helper", "!touch sentinel"],
    ["url.file:///tmp/.insteadOf", "https://invalid.example/"],
  ])("refuses executable Git config %s before creating a worktree or snapshot", async (key, value) => {
    g(wt.worktree, "config", "--local", key, value)
    expect(createSnapshotStore(wt.worktree)).rejects.toThrow(/git-config:/)
    expect(createTaskWorktree(wt.worktree, S, "config-refusal", [])).rejects.toThrow(/git-config:/)
    expect(existsSync(join(wt.worktree, "sentinel"))).toBe(false)
    expect(existsSync(join(worktreeRoot(wt.worktree), S, "config-refusal"))).toBe(false)
  })

  test("refuses tracked driver attributes before running Git filters", async () => {
    writeFileSync(join(wt.worktree, ".gitattributes"), "*.py filter=evil\n")
    g(wt.worktree, "add", ".gitattributes")
    g(wt.worktree, "config", "--local", "filter.evil.clean", "touch sentinel")
    expect(createSnapshotStore(wt.worktree)).rejects.toThrow(/git-config:/)
    g(wt.worktree, "config", "--local", "--unset", "filter.evil.clean")
    expect(createTaskWorktree(wt.worktree, S, "attr-refusal", [])).rejects.toThrow(/driver attribute/)
    expect(existsSync(join(wt.worktree, "sentinel"))).toBe(false)
  })

  test("refuses symlink import instead of following or copying it", async () => {
    symlinkSync("lib.py", join(wt.worktree, "untracked-link.py"))
    expect(createTaskWorktree(wt.worktree, S, "link-refusal", [])).rejects.toThrow(/nonregular import/)
  })

  test.each(["core.worktree", "core.bare"])("refuses %s without modifying an external victim", async (key) => {
    const victim = join(wt.stateHome, "external-victim")
    mkdirSync(victim)
    writeFileSync(join(victim, "lib.py"), "DO NOT MODIFY\n")
    g(wt.worktree, "config", "--local", key, key === "core.bare" ? "true" : victim)
    expect(createSnapshotStore(wt.worktree)).rejects.toThrow(/git-config: forbidden core\./)
    expect(createTaskWorktree(wt.worktree, S, "redirection", [])).rejects.toThrow(/git-config: forbidden core\./)
    expect(read(victim, "lib.py")).toBe("DO NOT MODIFY\n")
    expect(existsSync(join(worktreeRoot(wt.worktree), S, "redirection"))).toBe(false)
  })

  test("operational Git failure does not fall back to an in-place worker", async () => {
    // A real repository whose worktree metadata is unusable must not be treated as an absent repository.
    writeFileSync(join(wt.worktree, ".git", "worktrees"), "cannot create linked worktree metadata")
    expect(createTaskWorktree(wt.worktree, S, "broken", [])).rejects.toThrow(/git-config: could not/)
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, worktree: true } as any })
    const queue = createQueue(getOpenCodeRuntime(deps))
    queue.add(S, [{ title: "must remain isolated", verify: verifyScript(wt.worktree, "check.sh", "exit 0") }])
    expect(await queue.run(S)).toMatchObject({ aborted: true, done: 0, abortReason: expect.stringMatching(/git-config: could not/) })
    expect(prompts("worker")).toHaveLength(0)
    expect(client.created).toHaveLength(0)
    expect(existsSync(join(worktreeRoot(wt.worktree), S, "broken"))).toBe(false)
  })

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

  test("reopens the owned worktree with its original edits and durable baseline without replaying main WIP", async () => {
    writeFileSync(join(wt.worktree, "lib.py"), "X = 2\n")
    writeFileSync(join(wt.worktree, "earlier.py"), "EARLIER = True\n")
    const original = (await createTaskWorktree(wt.worktree, S, "reopen", []))!
    expect(original.store).toBeDefined()
    expect(original.baseline.tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(original.baseline.store).toBe(original.store)
    expect(taskWorktreeOwner(original.path)).toEqual({ mainWorktree: realpathSync(wt.worktree), sessionID: S, taskId: "reopen" })
    expect(taskWorktreeOwner(wt.worktree)).toBeUndefined()
    expect(hasTaskWorktreeState(wt.worktree, S, "reopen")).toBe(true)
    writeFileSync(join(original.path, "recovered.py"), "RECOVERED = True\n")
    const control = recoveryDir("reopen")
    const ownership = readFileSync(join(control, "ownership.json"))
    const baseline = readFileSync(join(control, "baseline", "baseline.json"))
    expect(existsSync(join(control, "baseline", "objects"))).toBe(true)

    const reopened = await reopenTaskWorktree(wt.worktree, S, "reopen", [])
    expect(reopened.path).toBe(original.path)
    expect(reopened.base).toBe(original.base)
    expect(read(reopened.path, "recovered.py")).toBe("RECOVERED = True\n")
    expect(read(wt.worktree, "lib.py")).toBe("X = 2\n")
    expect(existsSync(join(wt.worktree, "recovered.py"))).toBe(false)
    expect(readFileSync(join(control, "ownership.json"))).toEqual(ownership)
    expect(readFileSync(join(control, "baseline", "baseline.json"))).toEqual(baseline)

    expect(await reopened.merge([])).toEqual({ ok: true, files: ["recovered.py"] })
    expect(read(wt.worktree, "lib.py")).toBe("X = 2\n")
    expect(read(wt.worktree, "earlier.py")).toBe("EARLIER = True\n")
    expect(read(wt.worktree, "recovered.py")).toBe("RECOVERED = True\n")
    await expect(reopenTaskWorktree(wt.worktree, S, "reopen", [])).rejects.toThrow(/ambiguous/)
    await reopened.remove()
    expect(existsSync(original.path)).toBe(false)
    expect(existsSync(control)).toBe(false)
    expect(hasTaskWorktreeState(wt.worktree, S, "reopen")).toBe(false)
  })

  test("reopen refuses wrong session, task, and exclusion configuration without changing the worktree", async () => {
    const task = (await createTaskWorktree(wt.worktree, S, "identity-check", []))!
    await expect(reopenTaskWorktree(wt.worktree, "other-session", "identity-check", [])).rejects.toThrow()
    await expect(reopenTaskWorktree(wt.worktree, S, "other-task", [])).rejects.toThrow()
    await expect(reopenTaskWorktree(wt.worktree, S, "identity-check", ["ignored.txt"])).rejects.toThrow(/metadata/)
    expect(existsSync(task.path)).toBe(true)
    expect(g(wt.worktree, "worktree", "list")).toContain(task.path)
    await task.remove()
  })

  test("parent HEAD drift refuses recovery and native ownership without discarding edits", async () => {
    const task = (await createTaskWorktree(wt.worktree, S, "parent-head", []))!
    writeFileSync(join(task.path, "lib.py"), "X = 19\n")
    g(wt.worktree, "commit", "--allow-empty", "-m", "new parent checkout state")
    await expect(reopenTaskWorktree(wt.worktree, S, "parent-head", [])).rejects.toThrow(/HEAD|identity/)
    expect(() => taskWorktreeOwner(task.path)).toThrow(/HEAD|identity/)
    expect((await task.merge([])).ok).toBe(false)
    expect(read(task.path, "lib.py")).toBe("X = 19\n")
    expect(read(wt.worktree, "lib.py")).toBe("X = 1\n")
    expect(existsSync(join(recoveryDir("parent-head"), "baseline", "baseline.json"))).toBe(true)
  })

  test("reopen refuses mismatched Git identity and changed original HEAD", async () => {
    const task = (await createTaskWorktree(wt.worktree, S, "git-identity", []))!
    const metadataPath = join(recoveryDir("git-identity"), "ownership.json")
    const originalMetadata = readFileSync(metadataPath)
    const value = JSON.parse(originalMetadata.toString("utf8")) as { commonGitDir: string }
    value.commonGitDir = join(wt.stateHome, "other-git")
    writeFileSync(metadataPath, JSON.stringify(value) + "\n")
    await expect(reopenTaskWorktree(wt.worktree, S, "git-identity", [])).rejects.toThrow(/identity|ownership/)
    writeFileSync(metadataPath, originalMetadata)

    g(task.path, "commit", "--allow-empty", "-m", "unexpected child HEAD")
    await expect(reopenTaskWorktree(wt.worktree, S, "git-identity", [])).rejects.toThrow(/HEAD|identity/)
    expect(read(wt.worktree, "lib.py")).toBe("X = 1\n")
  })

  test("reopen revalidates Git configuration before inspecting the child", async () => {
    const task = (await createTaskWorktree(wt.worktree, S, "config-changed", []))!
    g(wt.worktree, "config", "--local", "core.fsmonitor", "touch sentinel")
    await expect(reopenTaskWorktree(wt.worktree, S, "config-changed", [])).rejects.toThrow(/git-config: forbidden/)
    expect(existsSync(join(wt.worktree, "sentinel"))).toBe(false)
    expect(existsSync(task.path)).toBe(true)
    expect(existsSync(join(recoveryDir("config-changed"), "baseline", "baseline.json"))).toBe(true)
  })

  test("missing or corrupt ownership and missing baseline refuse recovery without recreation", async () => {
    const missing = (await createTaskWorktree(wt.worktree, S, "missing-owner", []))!
    const missingControl = recoveryDir("missing-owner")
    rmSync(join(missingControl, "ownership.json"))
    await expect(reopenTaskWorktree(wt.worktree, S, "missing-owner", [])).rejects.toThrow(/metadata is missing/)
    expect(() => taskWorktreeOwner(missing.path)).toThrow(/metadata is missing/)
    expect(hasTaskWorktreeState(wt.worktree, S, "missing-owner")).toBe(true)
    expect(existsSync(missing.path)).toBe(true)
    expect(existsSync(join(missingControl, "baseline", "baseline.json"))).toBe(true)

    const corrupt = (await createTaskWorktree(wt.worktree, S, "corrupt-owner", []))!
    const corruptMetadata = join(recoveryDir("corrupt-owner"), "ownership.json")
    const saved = readFileSync(corruptMetadata)
    writeFileSync(corruptMetadata, "{")
    await expect(reopenTaskWorktree(wt.worktree, S, "corrupt-owner", [])).rejects.toThrow(/corrupt/)
    writeFileSync(corruptMetadata, saved)

    const noBaseline = (await createTaskWorktree(wt.worktree, S, "missing-baseline", []))!
    const objects = join(recoveryDir("missing-baseline"), "baseline", "objects")
    rmSync(objects, { recursive: true })
    await expect(reopenTaskWorktree(wt.worktree, S, "missing-baseline", [])).rejects.toThrow(/baseline/)
    expect(existsSync(objects)).toBe(false)
    expect(existsSync(noBaseline.path)).toBe(true)
    expect(existsSync(corrupt.path)).toBe(true)
  })

  test("reopen refuses a symlink replacement and preserves the outside target", async () => {
    const task = (await createTaskWorktree(wt.worktree, S, "symlink-replacement", []))!
    const outside = join(wt.stateHome, "outside")
    mkdirSync(outside)
    writeFileSync(join(outside, "keep.txt"), "untouched\n")
    const moved = `${task.path}.saved`
    renameSync(task.path, moved)
    symlinkSync(outside, task.path)
    await expect(reopenTaskWorktree(wt.worktree, S, "symlink-replacement", [])).rejects.toThrow(/replaced|symlink|unsafe/)
    expect(() => taskWorktreeOwner(task.path)).toThrow(/replaced|symlink|unsafe/)
    expect(read(outside, "keep.txt")).toBe("untouched\n")
    unlinkSync(task.path)
    renameSync(moved, task.path)
    await task.remove()
  })

  test("fresh creation refuses an occupied deterministic path without deleting it", async () => {
    const path = join(worktreeRoot(wt.worktree), S, "occupied")
    mkdirSync(dirname(path), { recursive: true })
    mkdirSync(path)
    writeFileSync(join(path, "sentinel"), "preserve\n")
    await expect(createTaskWorktree(wt.worktree, S, "occupied", [])).rejects.toThrow(/occupied/)
    expect(read(path, "sentinel")).toBe("preserve\n")
  })

  test("recovery state is rejected before creation when the configured state base is inside the repository", async () => {
    const oldLca = process.env.OTTER_STATE_HOME
    const oldXdg = process.env.XDG_STATE_HOME
    delete process.env.OTTER_STATE_HOME
    process.env.XDG_STATE_HOME = join(wt.worktree, ".inside-state")
    try {
      await expect(createTaskWorktree(wt.worktree, S, "inside-state", [])).rejects.toThrow(/outside the main worktree/)
      expect(existsSync(join(wt.worktree, ".inside-state"))).toBe(false)
    } finally {
      if (oldLca === undefined) delete process.env.OTTER_STATE_HOME
      else process.env.OTTER_STATE_HOME = oldLca
      if (oldXdg === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = oldXdg
    }
  })

  test("task-state lookup detects a child-only path and recovery-only residue", async () => {
    const childOnly = (await createTaskWorktree(wt.worktree, S, "child-only", []))!
    rmSync(recoveryDir("child-only"), { recursive: true })
    expect(hasTaskWorktreeState(wt.worktree, S, "child-only")).toBe(true)

    const recoveryOnly = (await createTaskWorktree(wt.worktree, S, "recovery-only", []))!
    g(wt.worktree, "worktree", "remove", "--force", recoveryOnly.path)
    expect(hasTaskWorktreeState(wt.worktree, S, "recovery-only")).toBe(true)
    expect(existsSync(childOnly.path)).toBe(true)
  })

  test("worktree merge preserves exact leading and trailing whitespace in filenames", async () => {
    const inheritedName = " main whitespace "
    writeFileSync(join(wt.worktree, inheritedName), "inherited\n")
    const t = (await createTaskWorktree(wt.worktree, S, "whitespace-path", []))!
    expect(read(t.path, inheritedName)).toBe("inherited\n")
    const name = " task whitespace "
    writeFileSync(join(t.path, name), "merged\n")
    expect(await t.merge([])).toEqual({ ok: true, files: [name] })
    expect(read(wt.worktree, name)).toBe("merged\n")
    await t.remove()
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
    expect(existsSync(join(recoveryDir("t2"), "ownership.json"))).toBe(true)
    expect(existsSync(join(recoveryDir("t2"), "baseline", "baseline.json"))).toBe(true)
    await t.remove()
    expect(existsSync(recoveryDir("t2"))).toBe(false)
  })

  test("failed worktree snapshot and cancellation at the final guard never apply a patch", async () => {
    const t = (await createTaskWorktree(wt.worktree, S, "snapshot-fault", []))!
    writeFileSync(join(t.path, "lib.py"), "X = 10\n")
    symlinkSync(wt.stateHome, join(t.path, ".otter"))
    const failed = await t.merge([])
    expect(failed).toMatchObject({ ok: false, reason: "could not snapshot the worktree" })
    expect(read(wt.worktree, "lib.py")).toBe("X = 1\n")
    unlinkSync(join(t.path, ".otter"))
    let applied = false
    const cancelled = await t.merge([], { guard: () => false, applied: () => { applied = true } })
    expect(cancelled).toMatchObject({ ok: false, reason: "task cancelled before merge" })
    expect(applied).toBe(false)
    expect(read(wt.worktree, "lib.py")).toBe("X = 1\n")
    await t.remove()
  })

  test("rejects a worktree tree different from the verified tree before diff or merge", async () => {
    const t = (await createTaskWorktree(wt.worktree, S, "verified-mismatch", []))!
    writeFileSync(join(t.path, "lib.py"), "X = 2\n")
    const store = (await createSnapshotStore(t.path))!
    const verified = (await store.snapshot())!
    writeFileSync(join(t.path, "lib.py"), "X = 3\n")
    const result = await t.merge([], undefined, verified.tree)
    expect(result).toMatchObject({ ok: false, reason: "worktree changed since verification", patch: "" })
    expect(read(wt.worktree, "lib.py")).toBe("X = 1\n")
    store.dispose()
    await t.remove()
  })

  test("SnapshotStore's verified tree matches the worktree merge tree for an ordinary change", async () => {
    const t = (await createTaskWorktree(wt.worktree, S, "verified-match", []))!
    writeFileSync(join(t.path, "lib.py"), "X = 2\n")
    const store = (await createSnapshotStore(t.path))!
    const verified = (await store.snapshot())!
    expect(verified.tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(await t.merge([], { guard: () => true, applied: () => {} }, verified.tree)).toMatchObject({ ok: true, files: ["lib.py"] })
    expect(read(wt.worktree, "lib.py")).toBe("X = 2\n")
    store.dispose()
    await t.remove()
  })

  test("tracked legacy handoff paths share the verifier and merge exclusion set", async () => {
    mkdirSync(join(wt.worktree, ".otter", "handoffs"), { recursive: true })
    writeFileSync(join(wt.worktree, ".otter", "handoffs", "legacy.txt"), "previous\n")
    g(wt.worktree, "add", "-f", ".otter/handoffs/legacy.txt")
    g(wt.worktree, "commit", "-m", "tracked historical handoff")
    const t = (await createTaskWorktree(wt.worktree, S, "excluded-match", []))!
    writeFileSync(join(t.path, "lib.py"), "X = 2\n")
    writeFileSync(join(t.path, ".otter", "handoffs", "legacy.txt"), "unverified handoff\n")
    const store = (await createSnapshotStore(t.path))!
    const verified = (await store.snapshot())!
    expect(await t.merge([], { guard: () => true, applied: () => {} }, verified.tree)).toMatchObject({ ok: true, files: ["lib.py"] })
    expect(read(wt.worktree, "lib.py")).toBe("X = 2\n")
    expect(read(wt.worktree, ".otter/handoffs/legacy.txt")).toBe("previous\n")
    store.dispose()
    await t.remove()
  })

  test("rechecks verified tree synchronously after the final guard mutates the worktree", async () => {
    const t = (await createTaskWorktree(wt.worktree, S, "late-writer", []))!
    writeFileSync(join(t.path, "lib.py"), "X = 2\n")
    const store = (await createSnapshotStore(t.path))!
    const verified = (await store.snapshot())!
    let applied = false
    const result = await t.merge([], {
      guard: () => {
        writeFileSync(join(t.path, "lib.py"), "X = 3\n")
        return true
      },
      applied: () => { applied = true },
    }, verified.tree)
    expect(result).toMatchObject({ ok: false, reason: "worktree changed since verification" })
    expect(applied).toBe(false)
    expect(read(wt.worktree, "lib.py")).toBe("X = 1\n")
    store.dispose()
    await t.remove()
  })

  test("final guard recheck detects a new file and tracked deletion before applying", async () => {
    const t = (await createTaskWorktree(wt.worktree, S, "late-add-delete", []))!
    writeFileSync(join(t.path, "lib.py"), "X = 2\n")
    const store = (await createSnapshotStore(t.path))!
    const verified = (await store.snapshot())!
    const result = await t.merge([], {
      guard: () => {
        unlinkSync(join(t.path, "lib.py"))
        writeFileSync(join(t.path, "late-added.py"), "LATE = True\n")
        return true
      },
      applied: () => { throw new Error("must not apply") },
    }, verified.tree)
    expect(result).toMatchObject({ ok: false, reason: "worktree changed since verification" })
    expect(read(wt.worktree, "lib.py")).toBe("X = 1\n")
    expect(existsSync(join(wt.worktree, "late-added.py"))).toBe(false)
    store.dispose()
    await t.remove()
  })

  test("returns null without Git history and refuses a non-root Git directory before creation", async () => {
    const bare = tempGitWorktree()
    g(bare.worktree, "update-ref", "-d", "HEAD")
    expect(await createTaskWorktree(bare.worktree, S, "t1", [])).toBeNull()
    bare.cleanup()
    mkdirSync(join(wt.worktree, "plain"))
    await expect(createTaskWorktree(join(wt.worktree, "plain"), S, "t1", [])).rejects.toThrow(/unchanged Git root/)
    expect(g(wt.worktree, "worktree", "list").split("\n")).toHaveLength(1)
    expect(await createTaskWorktree("/", S, "t1", [])).toBeNull()
  })
})

describe("queue with delegate.worktree", () => {

  test("without a Git baseline no worker, verifier, or review is launched", async () => {
    rmSync(join(wt.worktree, ".git"), { recursive: true, force: true })
    const deps = makeDeps(client, wt.worktree, { delegate: { worktree: false, review: true } as any })
    const queue = createQueue(getOpenCodeRuntime(deps))
    queue.add(S, [{ title: "unverifiable change", verify: verifyScript(wt.worktree, "check_untracked.sh", "touch verified-marker") }])
    expect(await queue.run(S)).toMatchObject({ done: 0, failed: 1 })
    expect(readLedger(wt.worktree, S).tasks[0]).toMatchObject({ status: "failed", error: "could not snapshot the task baseline" })
    expect(prompts("worker")).toHaveLength(0)
    expect(prompts("reviewer")).toHaveLength(0)
    expect(existsSync(join(wt.worktree, "verified-marker"))).toBe(false)
  })

  test("a verifier that synchronously rewrites a protected test invalidates its own result", async () => {
    writeFileSync(join(wt.worktree, "test_guard.py"), "def test_guard():\n    assert True\n")
    g(wt.worktree, "add", "test_guard.py")
    g(wt.worktree, "commit", "-m", "tracked guard")
    const verify = verifyScript(wt.worktree, "check_guard.sh", "printf 'def test_guard():\\n    assert False\\n' > \"$1\"\nexit 0") + " test_guard.py"
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, worktree: false, max_attempts: 1 } as any })
    const queue = createQueue(getOpenCodeRuntime(deps))
    client.replies.worker = { text: "Files changed: lib.py\nVerification: ok\nOpen issues: none",
      run: () => writeFileSync(join(wt.worktree, "lib.py"), "X = 2\n") }
    queue.add(S, [{ title: "update lib", verify }])
    expect(await queue.run(S)).toMatchObject({ done: 0, failed: 1 })
    expect(read(wt.worktree, "test_guard.py")).toBe("def test_guard():\n    assert True\n")
    const task = readLedger(wt.worktree, S).tasks[0]!
    expect(task.verify_result).toMatchObject({ ok: false, exitCode: 0 })
    expect(task.verify_result?.output).toContain("verifier changed files")
  })

  test("refuses an unallowlisted verifier before it or its descendant launches or merges work", async () => {
    const verifierLaunched = join(wt.stateHome, "refused-verifier-launched")
    const descendantLaunched = join(wt.stateHome, "refused-descendant-launched")
    const verify = verifyScript(wt.worktree, "check_refused.sh", [
      `touch "${verifierLaunched}"`,
      `(touch "${descendantLaunched}") &`,
      "wait",
    ].join("\n")) + " && python3 -c 'print(1)'" // not an allowed test runner; neither command may start
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, worktree: true, max_attempts: 1 } as any })
    const queue = createQueue(getOpenCodeRuntime(deps))
    client.replies.worker = (o) => ({
      text: "Files changed: lib.py\nVerification: not run\nOpen issues: none",
      run: () => writeFileSync(join(o.query?.directory as string, "lib.py"), "X = 2\n"),
    })
    queue.add(S, [{ title: "update lib", verify }])
    const run = await queue.run(S)
    const task = readLedger(wt.worktree, S).tasks[0]!
    expect(prompts("worker")).toHaveLength(1)
    expect(task.verify_result).toMatchObject({ ok: false, exitCode: null, timedOut: false })
    expect(task.verify_result?.output).toContain("verify command refused")
    expect(run).toMatchObject({ done: 0, failed: 1 })
    expect(task.status).toBe("failed")
    expect(read(wt.worktree, "lib.py")).toBe("X = 1\n")
    expect(existsSync(verifierLaunched)).toBe(false)
    expect(existsSync(descendantLaunched)).toBe(false)
  })

  test("records the escaped detached verifier as unproven on legacy; Linux requires retained ownership", async () => {
    writeFileSync(join(wt.worktree, "test_guard.py"), "def test_guard():\n    assert True\n")
    g(wt.worktree, "add", "test_guard.py")
    g(wt.worktree, "commit", "-m", "tracked guard")
    const ready = join(wt.stateHome, "writer-ready")
    const release = join(wt.stateHome, "writer-release")
    const finished = join(wt.stateHome, "writer-finished")
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const child = [
      "import os, pathlib, sys, time",
      "os.setsid()", // escape the verifier shell's process group before the shell exits
      "ready, release, target, finished = map(pathlib.Path, sys.argv[1:])",
      "ready.touch()",
      "while not release.exists(): time.sleep(0.01)",
      "outcome = 'write-error'",
      "try:",
      "  target.write_text('def test_guard():\\n    assert False\\n')",
      "  outcome = 'written'",
      "except PermissionError:",
      "  outcome = 'write-denied'",
      "finally:",
      "  completion = finished.with_suffix('.complete')",
      "  completion.write_text(outcome + '\\n')",
      "  completion.replace(finished)",
    ].join("\n")
    const verify = verifyScript(wt.worktree, "check_delayed.sh", [
      `python3 -c ${quote(child)} ${quote(ready)} ${quote(release)} "$1" ${quote(finished)} </dev/null >/dev/null 2>&1 &`,
      `while [ ! -f ${quote(ready)} ]; do sleep 0.01; done`,
      "exit 0",
    ].join("\n")) + " test_guard.py"
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, worktree: false, max_attempts: 1 } as any })
    const runtime = getOpenCodeRuntime(deps)
    const q = createQueue(runtime)
    client.replies.worker = { text: "Files changed: lib.py\nVerification: ok\nOpen issues: none", run: () => writeFileSync(join(wt.worktree, "lib.py"), "X = 2\n") }
    q.add(S, [{ title: "update lib", verify }])
    let resolvedRun: Awaited<ReturnType<typeof q.run>> | undefined
    const runPromise = q.run(S).then((run) => { resolvedRun = run; return run })
    let beforeRelease: {
      childReady: boolean
      queueResolved: boolean
      resolvedDone: number | null
      taskStatus: string | undefined
      claimRetained: boolean
      unresolvedExecutions: number
      fencedExecutions: number
      safeBeforeRelease: boolean
    } | undefined
    try {
      await waitFor(() => existsSync(ready))
      // The legacy oracle must release the escaped child *after* acceptance,
      // not race a slower snapshot/merge and accidentally test a pre-merge write.
      if (runtime.verificationProfile === "legacy-unowned") await waitFor(() => !!resolvedRun, 10_000)
      else await new Promise((resolve) => setTimeout(resolve, 100))
      const task = readLedger(wt.worktree, S).tasks[0]!
      const state = runtime.runs.status()
      const claimRetained = state.claim?.ownerSession === S
      const unresolved = state.executions.filter((execution) => execution.ownerSession === S && execution.taskId === task.id
        && (execution.processRisk || (!execution.terminal?.quiescentAt
          && !(execution.reconciliation?.outcome === "terminal" && execution.reconciliation.quiescent))))
      const activeWithClaim = !resolvedRun && task.status !== "done" && claimRetained
      const settledWithFence = !!resolvedRun && resolvedRun.done === 0 && task.status !== "done"
        && claimRetained && unresolved.some((execution) => !!execution.fence)
      beforeRelease = {
        childReady: existsSync(ready), queueResolved: !!resolvedRun, resolvedDone: resolvedRun?.done ?? null,
        taskStatus: task.status, claimRetained, unresolvedExecutions: unresolved.length,
        fencedExecutions: unresolved.filter((execution) => !!execution.fence).length,
        safeBeforeRelease: activeWithClaim || settledWithFence,
      }
    } finally {
      writeFileSync(release, "go\n")
    }
    const run = await runPromise
    await waitFor(() => existsSync(finished))
    const childWriteOutcome = readFileSync(finished, "utf8").trim()
    const afterRelease = {
      childFinished: existsSync(finished), childWriteOutcome,
      childWriteObserved: childWriteOutcome === "written" || childWriteOutcome === "write-denied", queueDone: run.done,
      ledgerDone: readLedger(wt.worktree, S).tasks[0]?.status === "done",
      protectedContent: read(wt.worktree, "test_guard.py"),
    }
    const verifier = runtime.runs.status().executions.find(e => e.kind === "verifier")
    if (runtime.verificationProfile === "linux-single-use") {
      expect({ beforeRelease, afterRelease }).toMatchObject({
        beforeRelease: { childReady: true, safeBeforeRelease: true },
        afterRelease: { childFinished: true, childWriteObserved: true, queueDone: 0, ledgerDone: false,
          protectedContent: "def test_guard():\n    assert True\n" },
      }) // Linux never accepts a detached writer before complete-family retirement.
    } else {
      expect(runtime.verificationProfile).toBe("legacy-unowned")
      expect(verifier).toMatchObject({ kind: "verifier", profile: "legacy-unowned", descendantRisk: "unproven",
        terminal: { outcome: "ok", verification: { isolationEstablished: false, domainState: "unknown" } } })
      expect({ beforeRelease, afterRelease }).toMatchObject({
        beforeRelease: { childReady: true, queueResolved: true, resolvedDone: 1, claimRetained: false },
        afterRelease: { childFinished: true, childWriteOutcome: "written", queueDone: 1, ledgerDone: true,
          protectedContent: "def test_guard():\n    assert False\n" },
      }) // Historical unsafe behavior is retained only with an explicit unproven label; no F2/F3 credit.
    }
  })

  test("Linux-only detached verifier control reports blocked/not-run without a qualified systemd lab", async () => {
    if (process.platform !== "linux") {
      const runtime = getOpenCodeRuntime(makeDeps(client, wt.worktree))
      expect((await runtime.verifier.preflight("linux-single-use")).compatible).toBe(false)
      console.info("blocked/not-run: Linux native verifier qualification is not applicable on this platform")
      return
    }
    if (process.env.OTTER_RUN_LINUX_QUALIFICATION !== "1") {
      console.info("blocked/not-run: set OTTER_RUN_LINUX_QUALIFICATION=1 in the isolated Linux systemd verifier guest")
      return
    }
    const driver = join(import.meta.dir, "../../scripts/otter-linux-verifier-queue.ts")
    const receiptPath = join(wt.stateHome, `linux-verifier-${process.pid}-${Date.now()}.json`)
    const result = spawnSync(process.execPath, [driver, "--scenario", "success", "--receipt", receiptPath], {
      cwd: join(import.meta.dir, "../.."), env: { ...process.env }, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"))
    expect(receipt).toMatchObject({
      schema: "otter.linux-verifier.queue-e2.v1",
      scenario: "success",
      qualification: "pass",
      observation: { queue: { done: 1, failed: 0 }, authenticatedReceiptCount: 1,
        forgedEvidence: { mismatchedReferenceRefused: true, tamperedReceiptRefused: true } },
    })
    expect(JSON.stringify(receipt)).not.toContain("signing-key.pem")
    expect(JSON.stringify(receipt)).not.toContain("inputArchive")
  }, 125_000)

  test("worker and verify run in the worktree; main gets the files only after the task is accepted", async () => {
    const deps = makeDeps(client, wt.worktree, { delegate: { review: false, worktree: true } as any })
    const q = createQueue(getOpenCodeRuntime(deps))
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
    const q = createQueue(getOpenCodeRuntime(deps))
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
    const patch = join(wt.worktree, ".otter", "handoffs", S, "task-2.patch")
    expect(existsSync(patch)).toBe(true)
    expect(readFileSync(patch, "utf8")).toContain("+X = 2")
    expect(read(join(worktreeRoot(wt.worktree), S, "t1"), "junk.py")).toBe("BAD = 1\n")
    expect(read(join(worktreeRoot(wt.worktree), S, "t2"), "lib.py")).toBe("X = 2\n")
    expect(existsSync(join(recoveryDir("t1"), "baseline", "baseline.json"))).toBe(true)
    expect(existsSync(join(recoveryDir("t2"), "baseline", "baseline.json"))).toBe(true)
  })

  test("falls back to in-place execution when the repository has no commit", async () => {
    const bare = tempGitWorktree()
    g(bare.worktree, "update-ref", "-d", "HEAD")
    const deps = makeDeps(client, bare.worktree, { delegate: { review: false, worktree: true } as any })
    const q = createQueue(getOpenCodeRuntime(deps))
    client.replies.worker = (o) => ({ text: "Files changed: a.py\nVerification: ok\nOpen issues: none", run: () => writeFileSync(join(bare.worktree, "a.py"), "A = 1\n") })
    q.add(S, [{ title: "in place", verify: verifyScript(bare.worktree, "check_a.sh", "test -f a.py") }])
    expect(await q.run(S)).toMatchObject({ done: 1 })
    expect(client.created[0]!.directory).toBe(bare.worktree)
    expect(deps.logs.some((l) => l.startsWith("task worktree unavailable"))).toBe(true)
    bare.cleanup()
  })
})

describe("plan worktree (one worktree per approved plan)", () => {
  const WF = "wf_plan1"
  const checkoutBytes = () => g(wt.worktree, "status", "--porcelain", "--untracked-files=all") + "|" + read(wt.worktree, "lib.py") + read(wt.worktree, "README.md")
  const make = async () => (await createTaskWorktree(wt.worktree, S, planWorktreeScope(WF), []))!

  test("scope id is wf-<workflowID> and the managed owner round-trips", async () => {
    const plan = await make()
    expect(planWorktreeScope(WF)).toBe("wf_plan1".replace(/^/, "wf-"))
    expect(plan.path).toBe(join(worktreeRoot(wt.worktree), S, `wf-${WF}`))
    expect(taskWorktreeOwner(plan.path)).toMatchObject({ sessionID: S, taskId: `wf-${WF}` })
    expect(hasPlanWorktreeState(wt.worktree, S, WF)).toBe(true)
    expect(planWorktreePath(wt.worktree, S, WF)).toBe(plan.path)
    expect(planWorktreePath(wt.worktree, S, "wf_other")).toBeUndefined()
  })

  test("tasks accumulate in one worktree and the checkout is byte-identical until Apply", async () => {
    const before = checkoutBytes()
    const plan = await make()
    writeFileSync(join(plan.path, "task1.py"), "ONE = 1\n") // task 1
    writeFileSync(join(plan.path, "lib.py"), "X = 2\n") // task 2 builds on the same tree
    expect(read(plan.path, "task1.py")).toBe("ONE = 1\n")
    const preview = await plan.preview([])
    expect(preview).toMatchObject({ ok: true, files: ["lib.py", "task1.py"] })
    if (!preview.ok) throw new Error(preview.reason)
    expect(preview.stat).toContain("2 files changed")
    expect(preview.patch).toBe(join(worktreeRoot(wt.worktree), S, `wf-${WF}.patch`))
    expect(readFileSync(preview.patch, "utf8")).toContain("+ONE = 1")
    expect(existsSync(join(wt.worktree, "task1.py"))).toBe(false)
    expect(checkoutBytes()).toBe(before)
    // a second preview (re-offer after Keep) replaces the preserved patch instead of failing
    expect(await plan.preview([])).toMatchObject({ ok: true, files: ["lib.py", "task1.py"] })

    const applied = await plan.merge([])
    expect(applied).toEqual({ ok: true, files: ["lib.py", "task1.py"] })
    expect(read(wt.worktree, "task1.py")).toBe("ONE = 1\n")
    expect(read(wt.worktree, "lib.py")).toBe("X = 2\n")
    await plan.remove()
    expect(existsSync(plan.path)).toBe(false)
    expect(hasPlanWorktreeState(wt.worktree, S, WF)).toBe(false)
    expect(existsSync(join(worktreeRoot(wt.worktree), S, `wf-${WF}.patch`))).toBe(false)
  })

  test("an unchanged plan worktree previews as empty", async () => {
    const plan = await make()
    expect(await plan.preview([])).toEqual({ ok: true, files: [], stat: "", patch: "" })
    await plan.remove()
  })

  test("a conflicting Apply keeps the worktree and the patch and leaves the checkout untouched; reopen still works", async () => {
    const plan = await make()
    writeFileSync(join(plan.path, "lib.py"), "X = 10\n")
    writeFileSync(join(wt.worktree, "lib.py"), "X = 99\n") // the user edited the same line meanwhile
    const before = checkoutBytes()
    const applied = await plan.merge([])
    expect(applied.ok).toBe(false)
    if (!applied.ok) {
      expect(applied.reason).toMatch(/does not apply/)
      expect(readFileSync(applied.patch, "utf8")).toContain("+X = 10")
    }
    expect(checkoutBytes()).toBe(before)
    expect(existsSync(plan.path)).toBe(true)
    const reopened = await reopenPlanWorktree(wt.worktree, S, WF, [])
    expect(read(reopened.path, "lib.py")).toBe("X = 10\n")
    expect(await reopened.preview([])).toMatchObject({ ok: true, files: ["lib.py"] })
    await reopened.remove()
  })

  test("Discard removes the worktree, its recovery data and the patch without touching the checkout", async () => {
    const before = checkoutBytes()
    const plan = await make()
    writeFileSync(join(plan.path, "gone.py"), "G = 1\n")
    await plan.preview([])
    await plan.remove()
    expect(existsSync(plan.path)).toBe(false)
    expect(hasPlanWorktreeState(wt.worktree, S, WF)).toBe(false)
    expect(g(wt.worktree, "worktree", "list")).not.toContain(`wf-${WF}`)
    expect(existsSync(join(wt.worktree, "gone.py"))).toBe(false)
    expect(checkoutBytes()).toBe(before)
  })

  test("an unborn HEAD or a non-repository is reported, and creation returns null instead of silently running in place", async () => {
    const bare = tempGitWorktree()
    try {
      g(bare.worktree, "update-ref", "-d", "HEAD")
      expect(await planIsolationAvailability(bare.worktree)).toBe("no-commit")
      expect(await createTaskWorktree(bare.worktree, S, planWorktreeScope(WF), [])).toBeNull()
    } finally { bare.cleanup() }
    expect(await planIsolationAvailability(wt.worktree)).toBe("ready")
    expect(await planIsolationAvailability("/")).toBe("no-git")
  })
})
