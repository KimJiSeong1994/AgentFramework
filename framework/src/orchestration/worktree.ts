// Per-task git worktree isolation (stage 4, `delegate.worktree: true`). A code task's worker and verify command run
// in a linked worktree under the plugin's state root (outside the repository); the main worktree is untouched until
// the task is accepted, then the task's cumulative diff is applied to it in code (`git apply --check` first). A patch
// that does not apply cleanly marks the task blocked and leaves the patch in the handoff directory for a human.
//
// The worktree starts from HEAD and then receives the main worktree's uncommitted state (tracked changes via
// `git diff HEAD`, untracked non-ignored files copied), so a task sees earlier tasks' results and the user's WIP.
// Child sessions are bound to the worktree with the SDK's per-request `directory` (verified on OpenCode 1.18.32:
// `POST /session?directory=` and `GET /file/content?directory=` both resolve inside that directory).
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmdirSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"
import { stateBase, worktreeKey } from "../state/store.ts"
import { hasGitMetadata, safeGit as git, safeGitBuffer as gitBuffer, safeGitSync } from "./git-boundary.ts"
import { ALWAYS_EXCLUDED, excludePathspecs } from "./snapshot.ts"

export type TaskWorktree = {
  /** absolute path of the linked worktree */
  path: string
  /** `HEAD` the worktree was created from */
  base: string
  /** apply the worktree's changes (vs its creation state) to the main worktree; returns null or a reason */
  merge(diffExclude: string[], commit?: { guard(): boolean; applied(files: string[]): void }, expectedTree?: string): Promise<{ ok: true; files: string[] } | { ok: false; reason: string; patch: string }>
  /** remove the worktree (always safe to call) */
  remove(): Promise<void>
}

export function worktreeRoot(mainWorktree: string): string {
  return join(stateBase(mainWorktree), worktreeKey(mainWorktree), "worktrees")
}

/** Create `<state>/worktrees/<session>/<task>` from HEAD + the main worktree's uncommitted state. null only for absent/unborn repositories. */
export async function createTaskWorktree(mainWorktree: string, sessionID: string, taskId: string, diffExclude: string[]): Promise<TaskWorktree | null> {
  if (!hasGitMetadata(mainWorktree)) return null
  if ((await git(mainWorktree, ["rev-parse", "--is-inside-work-tree"])) !== "true") throw new Error("git-config: could not inspect the repository")
  const head = await git(mainWorktree, ["rev-parse", "HEAD"])
  if (!head) {
    const branch = await git(mainWorktree, ["symbolic-ref", "-q", "HEAD"])
    if (branch && (await git(mainWorktree, ["show-ref", "--verify", branch])) === null) return null // unborn branch
    throw new Error("git-config: could not resolve HEAD")
  }
  const exclude = excludePathspecs([...ALWAYS_EXCLUDED, ...diffExclude])
  const untrackedOutput = await gitBuffer(mainWorktree, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...exclude])
  if (untrackedOutput === null) throw new Error("git-config: could not inspect untracked files")
  const untracked = nulPaths(untrackedOutput)
  const sourceRoot = realpathSync.native(mainWorktree)
  for (const rel of untracked) {
    const src = join(mainWorktree, rel)
    const parent = realpathSync.native(dirname(src))
    if ((parent !== sourceRoot && !parent.startsWith(sourceRoot + "/")) || !lstatSync(src).isFile()) {
      throw new Error(`git-config: nonregular import ${rel}`)
    }
  }
  const path = join(worktreeRoot(mainWorktree), sessionID, taskId)
  rmSync(path, { recursive: true, force: true })
  if ((await git(mainWorktree, ["worktree", "prune"])) === null) throw new Error("git-config: could not prune worktrees")
  mkdirSync(dirname(path), { recursive: true })
  if ((await git(mainWorktree, ["worktree", "add", "--detach", "--quiet", path, head])) === null) throw new Error("git-config: could not create the task worktree")
  // 1. tracked modifications of the main worktree (incl. staged), as a patch applied to the new worktree
  const patch = await gitBuffer(mainWorktree, ["diff", "--binary", "HEAD", "--", ".", ...exclude])
  if (patch === null) throw new Error("git-config: could not capture main worktree changes")
  if (patch && patch.length) {
    const file = join(dirname(path), `${taskId}.base.patch`)
    writeFileSync(file, patch)
    if ((await git(path, ["apply", "--whitespace=nowarn", file])) === null) {
      await git(mainWorktree, ["worktree", "remove", "--force", path])
      throw new Error("git-config: could not import main worktree changes")
    }
    rmSync(file, { force: true })
  }
  // 2. untracked, non-ignored files (new modules from earlier tasks, the user's new files)
  for (const rel of untracked) {
    const src = join(mainWorktree, rel)
    const dst = join(path, rel)
    mkdirSync(dirname(dst), { recursive: true })
    const destParent = realpathSync.native(dirname(dst))
    const destRoot = realpathSync.native(path)
    if (destParent !== destRoot && !destParent.startsWith(destRoot + "/")) throw new Error(`git-config: unsafe import ${rel}`)
    copyRegularFile(src, dst, rel)
  }
  // the creation state: everything now in the worktree is the baseline for the task's own diff
  const baseTree = await snapshotTreeOf(path, exclude)
  if (!baseTree) {
    await git(mainWorktree, ["worktree", "remove", "--force", path])
    throw new Error("could not snapshot the task worktree baseline")
  }

  return {
    path,
    base: head,
    async merge(exclude2, commit, expectedTree) {
      const ex = excludePathspecs([...ALWAYS_EXCLUDED, ...exclude2])
      const after = await snapshotTreeOf(path, ex)
      if (!after) return { ok: false, reason: "could not snapshot the worktree", patch: "" }
      if (expectedTree !== undefined && after !== expectedTree) return { ok: false, reason: "worktree changed since verification", patch: "" }
      if (baseTree === after) {
        if (commit?.guard && !commit.guard()) return { ok: false, reason: "task cancelled before merge", patch: "" }
        if (expectedTree !== undefined && snapshotTreeOfSync(path, ex) !== expectedTree) return { ok: false, reason: "worktree changed since verification", patch: "" }
        commit?.applied([])
        return { ok: true, files: [] }
      }
      const raw = await gitBuffer(path, ["diff", "--binary", baseTree, after], snapshotEnv(path))
      const names = await gitBuffer(path, ["diff", "--name-only", "-z", baseTree, after], snapshotEnv(path))
      if (raw === null || names === null || !raw.length) return { ok: false, reason: "could not diff the worktree", patch: "" }
      const files = nulPaths(names)
      const patchFile = join(dirname(path), `${taskId}.patch`)
      writeFileSync(patchFile, raw)
      const check = await git(mainWorktree, ["apply", "--check", "--whitespace=nowarn", patchFile])
      if (check === null) return { ok: false, reason: "the task's patch does not apply to the current working tree (it changed underneath the task)", patch: patchFile }
      // The final guard, apply and ledger completion share one synchronous turn: abort/claim transfer cannot
      // interleave after a successful guard while git is applying the patch.
      if (commit && !commit.guard()) return { ok: false, reason: "task cancelled before merge", patch: patchFile }
      if (expectedTree !== undefined && snapshotTreeOfSync(path, ex) !== expectedTree) {
        return { ok: false, reason: "worktree changed since verification", patch: patchFile }
      }
      try {
        safeGitSync(mainWorktree, ["apply", "--whitespace=nowarn", patchFile])
      } catch {
        return { ok: false, reason: "git apply failed", patch: patchFile }
      }
      commit?.applied(files)
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

function nulPaths(bytes: Buffer): string[] {
  const paths: string[] = []
  let start = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) continue
    if (i > start) paths.push(bytes.subarray(start, i).toString("utf8"))
    start = i + 1
  }
  if (start !== bytes.length) throw new Error("invalid NUL-delimited Git output")
  return paths
}

function copyRegularFile(src: string, dst: string, rel: string): void {
  const input = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!fstatSync(input).isFile()) throw new Error(`git-config: nonregular import ${rel}`)
    const output = openSync(dst, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666)
    try {
      const chunk = Buffer.allocUnsafe(64 * 1024)
      let count: number
      while ((count = readSync(input, chunk, 0, chunk.length, null)) !== 0) {
        let offset = 0
        while (offset < count) offset += writeSync(output, chunk, offset, count - offset)
      }
    } finally {
      closeSync(output)
    }
  } finally {
    closeSync(input)
  }
}

function snapshotEnv(path: string): Record<string, string> {
  return { GIT_INDEX_FILE: join(path, ".git-lca-index") }
}

/** Tree object of the worktree's current files (a temporary index in the worktree's own git dir; objects go to the shared store). */
async function snapshotTreeOf(path: string, exclude: string[]): Promise<string | null> {
  const env = snapshotEnv(path)
  rmSync(env.GIT_INDEX_FILE!, { force: true })
  // Git creates this lock inside the worktree during add; it must not become part of the tree.
  if ((await git(path, ["add", "-A", "--", ".", ...exclude, ":(exclude).git-lca-index", ":(exclude).git-lca-index.lock"], env)) === null) return null
  const tree = await git(path, ["write-tree"], env)
  rmSync(env.GIT_INDEX_FILE!, { force: true })
  return tree
}

/** Rebuild the index synchronously so a final guard's writes cannot interleave before apply. */
function snapshotTreeOfSync(path: string, exclude: string[]): string | null {
  const env = snapshotEnv(path)
  rmSync(env.GIT_INDEX_FILE!, { force: true })
  try {
    safeGitSync(path, ["add", "-A", "--", ".", ...exclude, ":(exclude).git-lca-index", ":(exclude).git-lca-index.lock"], env)
    return safeGitSync(path, ["write-tree"], env)
  } catch {
    return null
  } finally {
    rmSync(env.GIT_INDEX_FILE!, { force: true })
  }
}

export function worktreeExists(path: string): boolean {
  return existsSync(join(path, ".git"))
}
