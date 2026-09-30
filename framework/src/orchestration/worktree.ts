// Per-task git worktree isolation (stage 4, `delegate.worktree: true`). A code task's worker and verify command run
// in a linked worktree under the plugin's state root (outside the repository); the main worktree is untouched until
// the task is accepted, then the task's cumulative diff is applied to it in code (`git apply --check` first). A patch
// that does not apply cleanly marks the task blocked and leaves the patch in the handoff directory for a human.
//
// The worktree starts from HEAD and then receives the main worktree's uncommitted state (tracked changes via
// `git diff HEAD`, untracked non-ignored files copied), so a task sees earlier tasks' results and the user's WIP.
// Child sessions are bound to the worktree with the SDK's per-request `directory` (verified on OpenCode 1.18.32:
// `POST /session?directory=` and `GET /file/content?directory=` both resolve inside that directory).
import { copyFileSync, existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { stateBase, worktreeKey } from "../state/store.ts"
import { git, gitBuffer } from "./shell.ts"
import { ALWAYS_EXCLUDED, excludePathspecs, filterOverrides } from "./snapshot.ts"

export type TaskWorktree = {
  /** absolute path of the linked worktree */
  path: string
  /** `HEAD` the worktree was created from */
  base: string
  /** apply the worktree's changes (vs its creation state) to the main worktree; returns null or a reason */
  merge(diffExclude: string[]): Promise<{ ok: true; files: string[] } | { ok: false; reason: string; patch: string }>
  /** remove the worktree (always safe to call) */
  remove(): Promise<void>
}

export function worktreeRoot(mainWorktree: string): string {
  return join(stateBase(mainWorktree), worktreeKey(mainWorktree), "worktrees")
}

/** Create `<state>/worktrees/<session>/<task>` from HEAD + the main worktree's uncommitted state. null when not a git repo. */
export async function createTaskWorktree(mainWorktree: string, sessionID: string, taskId: string, diffExclude: string[]): Promise<TaskWorktree | null> {
  if ((await git(mainWorktree, ["rev-parse", "--is-inside-work-tree"])) !== "true") return null
  const head = await git(mainWorktree, ["rev-parse", "HEAD"])
  if (!head) return null // unborn repository: nothing to branch from
  const path = join(worktreeRoot(mainWorktree), sessionID, taskId)
  rmSync(path, { recursive: true, force: true })
  await git(mainWorktree, ["worktree", "prune"])
  mkdirSync(dirname(path), { recursive: true })
  const overrides = await filterOverrides(mainWorktree)
  if ((await git(mainWorktree, [...overrides, "worktree", "add", "--detach", "--quiet", path, head])) === null) return null
  const exclude = excludePathspecs([...ALWAYS_EXCLUDED, ...diffExclude])
  // 1. tracked modifications of the main worktree (incl. staged), as a patch applied to the new worktree
  const patch = await gitBuffer(mainWorktree, [...overrides, "diff", "--binary", "HEAD", "--", ".", ...exclude])
  if (patch && patch.length) {
    const file = join(dirname(path), `${taskId}.base.patch`)
    writeFileSync(file, patch)
    if ((await git(path, [...overrides, "apply", "--whitespace=nowarn", file])) === null) {
      await git(mainWorktree, ["worktree", "remove", "--force", path])
      return null
    }
    rmSync(file, { force: true })
  }
  // 2. untracked, non-ignored files (new modules from earlier tasks, the user's new files)
  const untracked = (await git(mainWorktree, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...exclude])) ?? ""
  for (const rel of untracked.split("\0").filter(Boolean)) {
    const src = join(mainWorktree, rel)
    const dst = join(path, rel)
    try {
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(src, dst)
    } catch {}
  }
  // the creation state: everything now in the worktree is the baseline for the task's own diff
  const baseTree = await snapshotTreeOf(path, exclude, overrides)

  return {
    path,
    base: head,
    async merge(exclude2) {
      const ex = excludePathspecs([...ALWAYS_EXCLUDED, ...exclude2])
      const ov = await filterOverrides(path)
      const after = await snapshotTreeOf(path, ex, ov)
      if (!baseTree || !after) return { ok: false, reason: "could not snapshot the worktree", patch: "" }
      if (baseTree === after) return { ok: true, files: [] }
      const raw = await gitBuffer(path, [...ov, "diff", "--binary", baseTree, after], snapshotEnv(path))
      const names = (await git(path, [...ov, "diff", "--name-only", "-z", baseTree, after], snapshotEnv(path))) ?? ""
      const files = names.split("\0").map((s) => s.trim()).filter(Boolean)
      if (!raw || !raw.length) return { ok: true, files: [] }
      const patchFile = join(dirname(path), `${taskId}.patch`)
      writeFileSync(patchFile, raw)
      const mainOv = await filterOverrides(mainWorktree)
      const check = await git(mainWorktree, [...mainOv, "apply", "--check", "--whitespace=nowarn", patchFile])
      if (check === null) return { ok: false, reason: "the task's patch does not apply to the current working tree (it changed underneath the task)", patch: patchFile }
      if ((await git(mainWorktree, [...mainOv, "apply", "--whitespace=nowarn", patchFile])) === null) return { ok: false, reason: "git apply failed", patch: patchFile }
      rmSync(patchFile, { force: true })
      return { ok: true, files }
    },
    async remove() {
      await git(mainWorktree, ["worktree", "remove", "--force", path])
      rmSync(path, { recursive: true, force: true })
      await git(mainWorktree, ["worktree", "prune"])
      try {
        rmdirSync(dirname(path)) // the session's directory, once its last task worktree is gone (fails while others exist)
      } catch {}
    },
  }
}

function snapshotEnv(path: string): Record<string, string> {
  return { GIT_INDEX_FILE: join(path, ".git-lca-index") }
}

/** Tree object of the worktree's current files (a temporary index in the worktree's own git dir; objects go to the shared store). */
async function snapshotTreeOf(path: string, exclude: string[], overrides: string[]): Promise<string | null> {
  const env = snapshotEnv(path)
  rmSync(env.GIT_INDEX_FILE!, { force: true })
  if ((await git(path, [...overrides, "add", "-A", "--", ".", ...exclude, ":(exclude).git-lca-index"], env)) === null) return null
  const tree = await git(path, [...overrides, "write-tree"], env)
  rmSync(env.GIT_INDEX_FILE!, { force: true })
  return tree
}

export function worktreeExists(path: string): boolean {
  return existsSync(join(path, ".git"))
}
