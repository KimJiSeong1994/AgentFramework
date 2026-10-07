// Per-task diffs without touching the user's index, HEAD or object store.
//
// A SnapshotStore owns a private directory holding a private GIT_INDEX_FILE and a private GIT_OBJECT_DIRECTORY;
// the user's .git/objects is only READ through GIT_ALTERNATE_OBJECT_DIRECTORIES. `git add -A` + `write-tree` then
// produce a tree of the working directory (tracked + untracked, .gitignore respected) whose new blobs land in the
// private object dir and vanish with dispose() — no secrets or large untracked files are ever copied into the user's
// repository (review, security M4). A caller may provide an external durable directory for a task baseline. Diffing
// two such trees gives exactly what one task changed, even when earlier
// tasks left the worktree dirty. The plugin's own runtime dirs and configured artifact globs are excluded so the
// reviewer never sees session files or __pycache__ as "changes outside the task". Degrades to null outside git.
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync, symlinkSync, utimesSync, writeFileSync, type Stats } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { stateBase, stateRoot } from "../state/store.ts"
import { safeGit as git, safeGitBuffer as gitBuffer, safeGitBufferSync, safeGitSync } from "./git-boundary.ts"

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
  /** Synchronous counterpart for final guard-to-apply checks. */
  snapshotSync(exclude?: string[]): Snapshot
  /** Capture a baseline once, or reopen and validate the persisted baseline when requireExisting is true. */
  baseline(exclude?: string[], requireExisting?: boolean): Promise<Snapshot>
  /** Export a private tree without repository export attributes or configuration. */
  archive(snapshot: Snapshot): Promise<Buffer | null>
  diff(before: Snapshot, after: Snapshot, maxChars: number): Promise<TreeDiff | null>
  /** put `paths` back to their content in `tree` (deleted if absent there); returns the paths actually restored */
  restore(tree: Snapshot, paths: string[]): Promise<string[]>
  dispose(): void
}

/** Null when `worktree` is not inside a git work tree. Call dispose() when the task is finished. */
export async function createSnapshotStore(worktree: string, durableDirectory?: string): Promise<SnapshotStore | null> {
  if ((await git(worktree, ["rev-parse", "--is-inside-work-tree"])) !== "true") return null
  // objects live in the common dir (a linked `git worktree` has its own git-dir without objects/)
  const objects = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])
  if (!objects) return null
  const root = realpathSync.native(worktree)
  const requestedDirectory = durableDirectory === undefined ? undefined : resolve(durableDirectory)
  if (requestedDirectory && (isWithin(root, requestedDirectory) || isWithin(requestedDirectory, root))) {
    throw new Error("snapshot store must be outside the worktree")
  }
  if (requestedDirectory) assertNoStateSymlinks(worktree, requestedDirectory)
  const dir = requestedDirectory ? ensureDirectory(requestedDirectory, root) : realpathSync.native(mkdtempSync(join(tmpdir(), "lca-snap-")))
  const durable = requestedDirectory !== undefined
  if (durable && (isWithin(root, dir) || isWithin(dir, root))) throw new Error("snapshot store must be outside the worktree")
  try {
    if (durable) {
      const allowed = new Set(["baseline.json", "index", "objects", "pathspecs"])
      if (readdirSync(dir).some((name) => !allowed.has(name))) throw new Error("snapshot store directory contains unexpected entries")
    }
    ensureDirectory(join(dir, "objects")) // git refuses to create GIT_OBJECT_DIRECTORY itself
  } catch (error) {
    if (!durable) rmSync(dir, { recursive: true, force: true })
    throw error
  }
  const env: Record<string, string> = {
    GIT_INDEX_FILE: join(dir, "index"),
    GIT_OBJECT_DIRECTORY: join(dir, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
  }
  const store: SnapshotStore = {
    worktree,
    env,
    async snapshot(exclude = []) {
      if (durable) assertNoStateSymlinks(worktree, dir)
      assertPrivateDirectory(dir)
      assertPrivateDirectory(env.GIT_OBJECT_DIRECTORY!)
      // Excluding runtime paths must not hide a planted control-directory symlink.
      if (!safeControlDirectories(root)) return null
      // fresh index every time so removed files disappear from the tree
      rmSync(env.GIT_INDEX_FILE!, { force: true })
      const pathspecs = snapshotPathspecs(exclude)
      const [cached, untracked, deleted] = await Promise.all([
        gitBuffer(worktree, ["ls-files", "--cached", "-z", ...pathspecs]),
        gitBuffer(worktree, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspecs]),
        gitBuffer(worktree, ["ls-files", "--deleted", "-z", ...pathspecs]),
      ])
      if (cached === null || untracked === null || deleted === null) return null

      const { trackedPaths, untrackedPaths } = snapshotEntries(cached, untracked, deleted)

      // Initialize the private index even when all paths are excluded; write-tree then yields the empty tree.
      if (await git(worktree, ["read-tree", "--empty"], env) === null) return null

      const pathspecFile = join(dir, "pathspecs")
      const addPaths = async (paths: Buffer[], force: boolean): Promise<boolean> => {
        if (!paths.length) return true
        rmSync(pathspecFile, { force: true })
        const fd = openSync(pathspecFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
          writeFileSync(fd, nulPathspecs(paths))
          const add = await git(worktree, [
            "--literal-pathspecs", "add", "-A", ...(force ? ["-f"] : []),
            `--pathspec-from-file=${pathspecFile}`, "--pathspec-file-nul",
          ], env)
          return add !== null
        } finally {
          closeSync(fd)
          rmSync(pathspecFile, { force: true })
        }
      }

      // The real index identified tracked paths; force only those because the fresh index has no tracked entries.
      // Untracked paths were enumerated with --exclude-standard and remain subject to ignore rules when added.
      if (!(await addPaths(trackedPaths, true)) || !(await addPaths(untrackedPaths, false))) return null
      const tree = await git(worktree, ["write-tree"], env)
      return tree ? { tree, store } : null
    },
    snapshotSync(exclude = []) {
      if (durable) assertNoStateSymlinks(worktree, dir)
      assertPrivateDirectory(dir)
      assertPrivateDirectory(env.GIT_OBJECT_DIRECTORY!)
      if (!safeControlDirectories(root)) return null
      rmSync(env.GIT_INDEX_FILE!, { force: true })
      const pathspecs = snapshotPathspecs(exclude)
      try {
        const cached = safeGitBufferSync(worktree, ["ls-files", "--cached", "-z", ...pathspecs])
        const untracked = safeGitBufferSync(worktree, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspecs])
        const deleted = safeGitBufferSync(worktree, ["ls-files", "--deleted", "-z", ...pathspecs])
        const { trackedPaths, untrackedPaths } = snapshotEntries(cached, untracked, deleted)
        safeGitSync(worktree, ["read-tree", "--empty"], env)

        const pathspecFile = join(dir, "pathspecs")
        const addPaths = (paths: Buffer[], force: boolean): boolean => {
          if (!paths.length) return true
          rmSync(pathspecFile, { force: true })
          let fd: number | undefined
          try {
            fd = openSync(pathspecFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
            writeFileSync(fd, nulPathspecs(paths))
            safeGitSync(worktree, [
              "--literal-pathspecs", "add", "-A", ...(force ? ["-f"] : []),
              `--pathspec-from-file=${pathspecFile}`, "--pathspec-file-nul",
            ], env)
            return true
          } catch {
            return false
          } finally {
            if (fd !== undefined) closeSync(fd)
            rmSync(pathspecFile, { force: true })
          }
        }

        if (!addPaths(trackedPaths, true) || !addPaths(untrackedPaths, false)) return null
        const tree = safeGitSync(worktree, ["write-tree"], env)
        return tree ? { tree, store } : null
      } catch {
        return null
      } finally {
        rmSync(join(dir, "pathspecs"), { force: true })
      }
    },
    async baseline(exclude = [], requireExisting = false) {
      if (durable) assertNoStateSymlinks(worktree, dir)
      assertPrivateDirectory(dir)
      assertPrivateDirectory(env.GIT_OBJECT_DIRECTORY!)
      if (!safeControlDirectories(root)) throw new Error("snapshot control directory is unsafe")
      const metadataPath = join(dir, "baseline.json")
      const exclusions = excludePathspecs(exclude)
      const existing = lstatOrNull(metadataPath)
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("persisted task baseline metadata is unsafe")
        let value: unknown
        try { value = JSON.parse(readFileSync(metadataPath, "utf8")) }
        catch { throw new Error("persisted task baseline metadata is corrupt") }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("persisted task baseline metadata is invalid")
        const metadata = value as Record<string, unknown>
        const tree = metadata.tree
        const storedExclusions = metadata.exclusions
        if (metadata.version !== 1 || metadata.worktree !== root || typeof tree !== "string" ||
          !/^[0-9a-f]{40,64}$/.test(tree) || !Array.isArray(storedExclusions) ||
          storedExclusions.length !== exclusions.length ||
          !storedExclusions.every((path, index) => path === exclusions[index])) {
          throw new Error("persisted task baseline does not match this worktree and exclusion set")
        }
        if (!(await validTreeObject(worktree, tree, env))) {
          throw new Error("persisted task baseline tree is missing or corrupt")
        }
        return { tree, store }
      }
      if (requireExisting) throw new Error("persisted task baseline is missing")
      const snap = await store.snapshot(exclude)
      // write-tree has just constructed this tree. Full integrity validation is
      // required when reopening persisted objects, not again on fresh capture.
      if (!snap || !/^[0-9a-f]{40,64}$/.test(snap.tree)) return null
      const metadata = JSON.stringify({ version: 1, worktree: root, exclusions, tree: snap.tree }) + "\n"
      const fd = openSync(metadataPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(fd, metadata)
        fsyncSync(fd)
      } finally { closeSync(fd) }
      const directoryFD = openSync(dir, "r")
      try { fsyncSync(directoryFD) }
      finally { closeSync(directoryFD) }
      return snap
    },
    async archive(snapshot) {
      if (!snapshot || snapshot.store !== store || !/^[0-9a-f]{40,64}$/.test(snapshot.tree)) return null
      if (durable) assertNoStateSymlinks(worktree, dir)
      assertPrivateDirectory(dir)
      assertPrivateDirectory(env.GIT_OBJECT_DIRECTORY!)
      const exportDir = mkdtempSync(join(tmpdir(), "lca-archive-"))
      try {
        const initialized = await git(worktree, ["init", "--bare", "--template=", exportDir])
        if (initialized === null) return null
        // Private info attributes override transformations from the archived tree
        // without reading live attributes or editing the user's repository.
        mkdirSync(join(exportDir, "info"), { recursive: true, mode: 0o700 })
        writeFileSync(join(exportDir, "info", "attributes"), "* -export-ignore -export-subst\n", { mode: 0o600 })
        return await gitBuffer(worktree, ["archive", "--format=tar", snapshot.tree], {
          ...env, GIT_DIR: exportDir,
          GIT_INDEX_FILE: join(exportDir, "empty-index"), GIT_ATTR_NOSYSTEM: "1",
        }, 16 * 1024 * 1024)
      } finally { rmSync(exportDir, { recursive: true, force: true }) }
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
      if (!durable) {
        rmSync(dir, { recursive: true, force: true })
        return
      }
      try { assertNoStateSymlinks(worktree, dir) }
      catch { return }
      try {
        assertPrivateDirectory(dir)
        assertPrivateDirectory(env.GIT_OBJECT_DIRECTORY!)
      } catch { return }
      const info = lstatOrNull(dir)
      if (!info || !info.isDirectory() || info.isSymbolicLink()) return
      for (const name of ["baseline.json", "index", "pathspecs", "objects"]) {
        rmSync(join(dir, name), { recursive: true, force: true })
      }
      try { rmdirSync(dir) } catch { /* Preserve unexpected contents rather than deleting user data. */ }
    },
  }
  return store
}

type TreeEntry = { mode: string; type: string; oid: string }

function snapshotPathspecs(exclude: string[]): string[] {
  return ["--", ".", ...excludePathspecs(exclude)]
}

async function validTreeObject(worktree: string, tree: string, env: Record<string, string>): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/.test(tree) || await git(worktree, ["cat-file", "-t", tree], env) !== "tree") return false
  return await git(worktree, ["fsck", "--no-reflogs", tree], env) !== null
}

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

function snapshotEntries(cached: Buffer, untracked: Buffer, deleted: Buffer) {
  // The empty private index cannot stage absent tracked paths. Keep byte identity:
  // decoding non-UTF-8 names could alias a different file and hide a new addition.
  const missing = new Set(nulRecords(deleted).map((path) => path.toString("hex")))
  return {
    trackedPaths: nulRecords(cached).filter((path) => !missing.has(path.toString("hex"))),
    untrackedPaths: nulRecords(untracked),
  }
}

function nulPathspecs(paths: Buffer[]): Buffer {
  const output = Buffer.allocUnsafe(paths.reduce((size, path) => size + path.length + 1, 0))
  let offset = 0
  for (const path of paths) {
    path.copy(output, offset)
    offset += path.length
    output[offset++] = 0
  }
  return output
}

function isWithin(root: string, path: string): boolean {
  return path === root || (root === sep ? path.startsWith(sep) : path.startsWith(root + sep))
}

function ensureDirectory(path: string, forbiddenRoot?: string): string {
  const target = resolve(path)
  let existing = target
  const missing: string[] = []
  for (;;) {
    const info = lstatOrNull(existing)
    if (info) {
      if (existing === target && info.isSymbolicLink()) throw new Error(`snapshot control directory is unsafe: ${target}`)
      if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error(`snapshot control directory is unsafe: ${existing}`)
      break
    }
    const parent = dirname(existing)
    if (parent === existing) throw new Error(`snapshot control directory has no existing parent: ${target}`)
    missing.unshift(basename(existing))
    existing = parent
  }
  const parentInfo = lstatSync(existing)
  if (!parentInfo.isDirectory() && !parentInfo.isSymbolicLink()) throw new Error(`snapshot control directory is unsafe: ${existing}`)
  let current = realpathSync.native(existing)
  const canonicalTarget = join(current, ...missing)
  if (forbiddenRoot && (isWithin(forbiddenRoot, canonicalTarget) || isWithin(canonicalTarget, forbiddenRoot))) {
    throw new Error("snapshot store must be outside the worktree")
  }
  for (const part of missing) {
    current = join(current, part)
    let info = lstatOrNull(current)
    if (!info) {
      mkdirSync(current, { mode: 0o700 })
      info = lstatSync(current)
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`snapshot control directory is unsafe: ${current}`)
  }
  const result = realpathSync.native(target)
  if (forbiddenRoot && (isWithin(forbiddenRoot, result) || isWithin(result, forbiddenRoot))) {
    throw new Error("snapshot store must be outside the worktree")
  }
  return result
}

function assertPrivateDirectory(path: string): void {
  const info = lstatOrNull(path)
  if (!info || !info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== resolve(path)) {
    throw new Error(`snapshot control directory is unsafe: ${path}`)
  }
}

function safeControlDirectories(root: string): boolean {
  for (const path of [".lca", ...ALWAYS_EXCLUDED]) {
    const entry = lstatOrNull(join(root, path))
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) return false
  }
  return true
}

function assertNoStateSymlinks(worktree: string, directory: string): void {
  const basePath = resolve(stateBase(worktree))
  const baseInfo = lstatOrNull(basePath)
  if (baseInfo?.isSymbolicLink()) throw new Error(`snapshot control directory is unsafe: ${basePath}`)
  const canonicalBase = baseInfo ? realpathSync.native(basePath) : basePath
  const statePath = resolve(stateRoot(worktree))
  const stateInfo = lstatOrNull(statePath)
  if (stateInfo?.isSymbolicLink()) throw new Error(`snapshot control directory is unsafe: ${statePath}`)
  const canonicalState = stateInfo ? realpathSync.native(statePath) : statePath
  const target = resolve(directory)
  const roots = [basePath, canonicalBase, statePath, canonicalState]
  const state = roots.find(root => isWithin(root, target)) ?? null
  if (!state) return
  let current = state
  for (const part of relative(state, target).split(sep).filter(Boolean)) {
    current = join(current, part)
    const child = lstatOrNull(current)
    if (child?.isSymbolicLink()) throw new Error(`snapshot control directory is unsafe: ${current}`)
  }
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
