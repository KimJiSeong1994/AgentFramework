// Per-task diffs without touching the user's index, HEAD or object store.
//
// A SnapshotStore owns a temporary directory holding a private GIT_INDEX_FILE and a private GIT_OBJECT_DIRECTORY;
// the user's .git/objects is only READ through GIT_ALTERNATE_OBJECT_DIRECTORIES. `git add -A` + `write-tree` then
// produce a tree of the working directory (tracked + untracked, .gitignore respected) whose new blobs land in the
// temp object dir and vanish with dispose() — no secrets or large untracked files are ever copied into the user's
// repository (review, security M4). Diffing two such trees gives exactly what one task changed, even when earlier
// tasks left the worktree dirty. The plugin's own runtime dirs and configured artifact globs are excluded so the
// reviewer never sees session files or __pycache__ as "changes outside the task". Degrades to null outside git.
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, type Stats } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { safeGit as git, safeGitBuffer as gitBuffer } from "./git-boundary.ts"

/** Always excluded: the plugin's handoffs (control-plane state lives outside the worktree; ".lca/state" kept for old layouts). */
export const ALWAYS_EXCLUDED = [".lca/state", ".lca/handoffs"]

/** Turn a name/glob into git pathspecs that exclude it at any depth (top level and nested). */
export function excludePathspecs(patterns: string[]): string[] {
  const out: string[] = []
  for (const raw of [...ALWAYS_EXCLUDED, ...patterns]) {
    const p = raw.trim().replace(/^\/+|\/+$/g, "")
    if (!p || /^[:!^]/.test(p)) continue // pathspec magic in user config is not honoured
    out.push(`:(exclude,glob)${p}`, `:(exclude,glob)${p}/**`, `:(exclude,glob)**/${p}`, `:(exclude,glob)**/${p}/**`)
  }
  return out
}

export type Snapshot = { tree: string; store?: SnapshotStore } | null

export type TreeDiff = { files: string[]; diff: string; truncated: boolean }

export type SnapshotStore = {
  worktree: string
  env: Record<string, string>
  snapshot(exclude?: string[]): Promise<Snapshot>
  diff(before: Snapshot, after: Snapshot, maxChars: number): Promise<TreeDiff | null>
  /** put `paths` back to their content in `tree` (deleted if absent there); returns the paths actually restored */
  restore(tree: Snapshot, paths: string[]): Promise<string[]>
  dispose(): void
}

/** Null when `worktree` is not inside a git work tree. Call dispose() when the task is finished. */
export async function createSnapshotStore(worktree: string): Promise<SnapshotStore | null> {
  if ((await git(worktree, ["rev-parse", "--is-inside-work-tree"])) !== "true") return null
  // objects live in the common dir (a linked `git worktree` has its own git-dir without objects/)
  const objects = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])
  if (!objects) return null
  const dir = mkdtempSync(join(tmpdir(), "lca-snap-"))
  mkdirSync(join(dir, "objects"), { recursive: true }) // git refuses to create GIT_OBJECT_DIRECTORY itself
  const env: Record<string, string> = {
    GIT_INDEX_FILE: join(dir, "index"),
    GIT_OBJECT_DIRECTORY: join(dir, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
  }
  const root = realpathSync.native(worktree)
  const store: SnapshotStore = {
    worktree,
    env,
    async snapshot(exclude = []) {
      // fresh index every time so removed files disappear from the tree
      rmSync(env.GIT_INDEX_FILE!, { force: true })
      const add = await git(worktree, ["add", "-A", "--", ".", ...excludePathspecs(exclude)], env)
      if (add === null) return null
      const tree = await git(worktree, ["write-tree"], env)
      return tree ? { tree, store } : null
    },
    async diff(before, after, maxChars) {
      if (!before || !after) return null
      if (before.tree === after.tree) return { files: [], diff: "", truncated: false }
      // a tree from another store: expose that store's temp objects as an extra alternate
      const alternates = new Set(env.GIT_ALTERNATE_OBJECT_DIRECTORIES!.split(":"))
      for (const s of [before.store, after.store]) if (s && s !== store) alternates.add(s.env.GIT_OBJECT_DIRECTORY!)
      const denv = { ...env, GIT_ALTERNATE_OBJECT_DIRECTORIES: [...alternates].join(":") }
      const names = await gitBuffer(worktree, ["diff", "--name-only", "-z", before.tree, after.tree], denv)
      if (names === null) return null
      const files = nulPaths(names)
      const raw = await git(worktree, ["diff", "--no-color", "--stat=80", "-p", before.tree, after.tree], denv)
      if (raw === null) return null
      const truncated = raw.length > maxChars
      const diff = truncated ? raw.slice(0, maxChars) + `\n… (diff truncated, ${raw.length} chars total)` : raw
      return { files, diff, truncated }
    },
    async restore(tree, paths) {
      if (!tree) return []
      const restored: string[] = []
      for (const p of paths) {
        const abs = resolve(root, p)
        if (abs === root || !isWithin(root, abs) || relative(root, abs) !== p) throw new Error(`refusing noncanonical restore path: ${p}`)
        const entry = await readTreeEntry(worktree, tree.tree, p, env)
        if (!entry) {
          assertSafeParent(root, dirname(abs))
          removeTarget(root, abs)
          assertSafeParent(root, dirname(abs))
          if (lstatOrNull(abs)) throw new Error(`failed to delete restored path: ${p}`)
          restored.push(p)
          continue
        }

        const supported = (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755"))
          || (entry.type === "blob" && entry.mode === "120000")
        if (!supported) throw new Error(`unsupported Git entry ${entry.mode} ${entry.type}: ${p}`)
        const content = await gitBuffer(worktree, ["cat-file", "blob", entry.oid], env)
        if (content === null) throw new Error(`could not read Git blob for restore: ${p}`)
        const target = entry.mode === "120000" ? content.toString("utf8") : null
        if (target !== null && !Buffer.from(target, "utf8").equals(content)) throw new Error(`unsupported non-UTF-8 symlink target: ${p}`)

        assertSafeParent(root, dirname(abs))
        removeTarget(root, abs)
        ensureParentDirectories(root, dirname(abs))
        assertSafeParent(root, dirname(abs))
        if (target !== null) {
          symlinkSync(target, abs)
        } else {
          const mode = entry.mode === "100755" ? 0o755 : 0o644
          const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
          try {
            writeFileSync(fd, content)
            fchmodSync(fd, mode)
          } finally {
            closeSync(fd)
          }
          // Python caches bytecode by (mtime, size): a same-size cheat written in the same second would keep its
          // compiled form. Drop the file's cache entries and move its mtime so the next run recompiles.
          if (/\.py$/.test(p)) {
            const t = Math.floor(Date.now() / 1000) + 2
            try {
              assertSafeParent(root, dirname(abs))
              utimesSync(abs, t, t)
            } catch {}
          }
        }
        verifyRestored(root, abs, p, entry.mode, content)
        if (/\.py$/.test(p)) invalidatePythonCache(root, abs, p)
        restored.push(p)
      }
      return restored
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return store
}

type TreeEntry = { mode: string; type: string; oid: string }

async function readTreeEntry(worktree: string, tree: string, path: string, env: Record<string, string>): Promise<TreeEntry | null> {
  const raw = await gitBuffer(worktree, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", tree, "--", path], env)
  if (raw === null) throw new Error(`could not inspect Git tree entry: ${path}`)
  const records = nulRecords(raw)
  if (!records.length) return null
  if (records.length !== 1) throw new Error(`ambiguous Git tree entry: ${path}`)
  const record = records[0]!
  const tab = record.indexOf(0x09)
  if (tab < 0 || record.subarray(tab + 1).toString("utf8") !== path) throw new Error(`invalid Git tree entry: ${path}`)
  const fields = record.subarray(0, tab).toString("ascii").split(" ")
  if (fields.length !== 3 || !/^[0-7]{6}$/.test(fields[0]!) || !/^[0-9a-f]{40,64}$/.test(fields[2]!)) {
    throw new Error(`invalid Git tree entry: ${path}`)
  }
  return { mode: fields[0]!, type: fields[1]!, oid: fields[2]! }
}

function nulRecords(bytes: Buffer): Buffer[] {
  const records: Buffer[] = []
  let start = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) continue
    if (i > start) records.push(bytes.subarray(start, i))
    start = i + 1
  }
  if (start !== bytes.length) throw new Error("invalid NUL-delimited Git output")
  return records
}

function nulPaths(bytes: Buffer): string[] {
  return nulRecords(bytes).map((record) => record.toString("utf8"))
}

function isWithin(root: string, path: string): boolean {
  return path === root || (root === sep ? path.startsWith(sep) : path.startsWith(root + sep))
}

/** Resolve the nearest existing parent and refuse any symlink that escapes the worktree. */
function assertSafeParent(root: string, parent: string): void {
  if (!isWithin(root, parent)) throw new Error(`refusing to mutate outside worktree: ${parent}`)
  let existing = parent
  for (;;) {
    try {
      const real = realpathSync.native(existing)
      if (!isWithin(root, real)) throw new Error(`refusing to mutate outside worktree: ${parent}`)
      if (!lstatSync(real).isDirectory()) throw new Error(`restore parent is not a directory: ${existing}`)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
      const next = dirname(existing)
      if (next === existing) throw new Error(`could not resolve restore parent: ${parent}`)
      existing = next
    }
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function removeTarget(root: string, path: string): void {
  assertSafeParent(root, dirname(path))
  if (!lstatOrNull(path)) return
  assertSafeParent(root, dirname(path))
  rmSync(path, { recursive: true, force: true })
}

function ensureParentDirectories(root: string, parent: string): void {
  assertSafeParent(root, parent)
  const parts = relative(root, parent).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      const real = realpathSync.native(current)
      if (!isWithin(root, real)) throw new Error(`refusing to mutate outside worktree: ${current}`)
      if (!lstatSync(real).isDirectory()) throw new Error(`restore parent is not a directory: ${current}`)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") throw error
      assertSafeParent(root, dirname(current))
      mkdirSync(current)
      assertSafeParent(root, current)
    }
  }
}

function verifyRestored(root: string, path: string, rel: string, mode: string, content: Buffer): void {
  assertSafeParent(root, dirname(path))
  const info = lstatOrNull(path)
  if (!info) throw new Error(`restored path is missing: ${rel}`)
  if (mode === "120000") {
    if (!info.isSymbolicLink() || !Buffer.from(readlinkSync(path), "utf8").equals(content)) {
      throw new Error(`restored symlink does not match Git tree: ${rel}`)
    }
    return
  }
  const expectedMode = mode === "100755" ? 0o755 : 0o644
  if (!info.isFile() || (info.mode & 0o777) !== expectedMode || !readFileSync(path).equals(content)) {
    throw new Error(`restored file does not match Git tree: ${rel}`)
  }
}

function invalidatePythonCache(root: string, path: string, rel: string): void {
  const cache = join(dirname(path), "__pycache__")
  let realCache: string
  try {
    realCache = realpathSync.native(cache)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!isWithin(root, realCache) || !lstatSync(realCache).isDirectory()) return
  const stem = basename(rel, ".py")
  for (const file of readdirSafe(cache)) {
    if (!file.startsWith(stem + ".")) continue
    const cached = join(cache, file)
    assertSafeParent(root, dirname(cached))
    rmSync(cached, { recursive: true, force: true })
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// ---- convenience wrappers (tests / one-off): a throwaway store per snapshot ------------------------------------

export async function snapshotTree(worktree: string, exclude: string[] = []): Promise<Snapshot> {
  const store = await createSnapshotStore(worktree)
  if (!store) return null
  const snap = await store.snapshot(exclude)
  if (!snap) store.dispose()
  return snap
}

export async function diffSnapshots(worktree: string, before: Snapshot, after: Snapshot, maxChars: number): Promise<TreeDiff | null> {
  if (!before || !after) return null
  const store = after.store ?? before.store
  if (!store || store.worktree !== worktree) return null
  return store.diff(before, after, maxChars)
}
