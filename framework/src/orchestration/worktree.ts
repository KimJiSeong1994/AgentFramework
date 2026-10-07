// Per-task git worktree isolation (stage 4, `delegate.worktree: true`). A code task's worker and verify command run
// in a linked worktree under the plugin's state root (outside the repository); the main worktree is untouched until
// the task is accepted, then the task's cumulative diff is applied to it in code (`git apply --check` first). A patch
// that does not apply cleanly marks the task blocked and leaves the patch in the handoff directory for a human.
//
// The worktree starts from HEAD and then receives the main worktree's uncommitted state (tracked changes via
// `git diff HEAD`, untracked non-ignored files copied), so a task sees earlier tasks' results and the user's WIP.
// Child sessions are bound to the worktree with the SDK's per-request `directory` (verified on OpenCode 1.18.32:
// `POST /session?directory=` and `GET /file/content?directory=` both resolve inside that directory).
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, writeSync, type Stats } from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { stateBase, worktreeKey } from "../state/store.ts"
import { hasGitMetadata, safeGit as git, safeGitBuffer as gitBuffer, safeGitSync } from "./git-boundary.ts"
import { createSnapshotStore, excludePathspecs, type SnapshotStore, type Snapshot } from "./snapshot.ts"

export type TaskWorktree = {
  /** absolute path of the linked worktree */
  path: string
  /** `HEAD` the worktree was created from */
  base: string
  /** Private snapshot store retained with the worktree for orphan recovery. */
  store: SnapshotStore
  /** Durable merge baseline captured when this worktree was created. */
  baseline: NonNullable<Snapshot>
  /** apply the worktree's changes (vs its creation state) to the main worktree; returns null or a reason */
  merge(diffExclude: string[], commit?: { guard(): boolean; applied(files: string[]): void }, expectedTree?: string): Promise<{ ok: true; files: string[] } | { ok: false; reason: string; patch: string }>
  /** Remove only the verified linked worktree and its durable recovery data. */
  remove(): Promise<void>
}

export function worktreeRoot(mainWorktree: string): string {
  let base = resolve(stateBase(mainWorktree))
  try { base = realpathSync.native(base) } catch {}
  return join(base, worktreeKey(mainWorktree), "worktrees")
}

/** Return the authenticated owner of a managed linked worktree; unmanaged paths return undefined. */
export function taskWorktreeOwner(path: string): { mainWorktree: string; sessionID: string; taskId: string } | undefined {
  const candidate = lexicalManagedWorktree(resolve(path))
  if (!candidate) return undefined
  validateManagedParents(candidate)
  const ownership = readOwnership(candidate.ownershipFile)
  const mainWorktree = canonicalMainWorktree(ownership.mainWorktree)
  if (mainWorktree !== ownership.mainWorktree) throw new Error("task worktree recovery refused: original main path is not canonical")
  const paths = resolveWorktreePaths(mainWorktree, candidate.sessionID, candidate.taskId, false)
  if (paths.child !== candidate.child) throw new Error("task worktree recovery refused: managed state key does not match the original main")
  validateOwnershipFields(ownership, mainWorktree, paths, candidate.sessionID, candidate.taskId, ownership.diffExclude)
  assertOwnershipSync(mainWorktree, paths, ownership)
  return { mainWorktree, sessionID: candidate.sessionID, taskId: candidate.taskId }
}

/** Whether a deterministic child or its durable recovery directory exists for this task. */
export function hasTaskWorktreeState(mainWorktree: string, sessionID: string, taskId: string): boolean {
  assertIdentifier(sessionID, "session ID")
  assertIdentifier(taskId, "task ID")
  const mainPath = canonicalMainWorktree(mainWorktree)
  const basePath = resolve(stateBase(mainPath))
  const baseInfo = lstatOrNull(basePath)
  if (!baseInfo) return false
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw new Error("task worktree state directory is unsafe")
  const baseDir = realpathSync.native(basePath)
  assertStateOutsideWorktrees(baseDir, mainPath)
  const root = join(baseDir, worktreeKey(mainPath), "worktrees")
  const keyDir = dirname(root)
  if (!existingSafeDirectory(baseDir, keyDir) || !existingSafeDirectory(baseDir, root)) return false
  const childParent = join(root, sessionID)
  const ownerParent = join(root, ".recovery", sessionID)
  const childParentExists = existingSafeDirectory(baseDir, childParent)
  const ownerParentExists = existingSafeDirectory(baseDir, ownerParent)
  const childExists = childParentExists && lstatOrNull(join(childParent, taskId)) !== null
  const ownerExists = ownerParentExists && lstatOrNull(join(ownerParent, taskId)) !== null
  return childExists || ownerExists
}

type WorktreeOwnership = {
  version: 1
  mainWorktree: string
  childWorktree: string
  sessionID: string
  taskId: string
  commonGitDir: string
  mainGitDir: string
  childGitDir: string
  originalHead: string
  diffExclude: string[]
  baselineTree: string
}

type WorktreePaths = {
  child: string
  ownerDir: string
  baselineDir: string
  ownershipFile: string
  applyMarker: string
}

type ManagedWorktreePath = {
  baseDir: string
  keyDir: string
  root: string
  child: string
  sessionID: string
  taskId: string
  ownerDir: string
  ownershipFile: string
}

/** Create `<state>/worktrees/<session>/<task>` from HEAD + the main worktree's uncommitted state. null only for absent/unborn repositories. */
export async function createTaskWorktree(mainWorktree: string, sessionID: string, taskId: string, diffExclude: string[]): Promise<TaskWorktree | null> {
  assertIdentifier(sessionID, "session ID")
  assertIdentifier(taskId, "task ID")
  if (!hasGitMetadata(mainWorktree)) return null
  if ((await git(mainWorktree, ["rev-parse", "--is-inside-work-tree"])) !== "true") throw new Error("git-config: could not inspect the repository")
  const head = await git(mainWorktree, ["rev-parse", "HEAD"])
  if (!head) {
    const branch = await git(mainWorktree, ["symbolic-ref", "-q", "HEAD"])
    if (branch && (await git(mainWorktree, ["show-ref", "--verify", branch])) === null) return null // unborn branch
    throw new Error("git-config: could not resolve HEAD")
  }
  const mainPath = canonicalMainWorktree(mainWorktree)
  const mainIdentity = gitIdentitySync(mainPath)
  if (mainIdentity.top !== mainPath || mainIdentity.head !== head) {
    throw new Error("task worktree main path must be the unchanged Git root")
  }
  const paths = resolveWorktreePaths(mainPath, sessionID, taskId, true)
  ensureWorktreeParents(paths, sessionID, true)
  const patchFiles = [join(dirname(paths.child), `${taskId}.base.patch`), join(dirname(paths.child), `${taskId}.patch`)]
  if ([paths.child, paths.ownerDir, ...patchFiles].some((path) => lstatOrNull(path))) {
    throw new Error("task worktree path is already occupied")
  }
  const exclude = excludePathspecs(diffExclude)
  const untrackedOutput = await gitBuffer(mainWorktree, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...exclude])
  if (untrackedOutput === null) throw new Error("git-config: could not inspect untracked files")
  const untracked = nulPaths(untrackedOutput)
  const sourceRoot = mainPath
  for (const rel of untracked) {
    const src = join(mainPath, rel)
    const parent = realpathSync.native(dirname(src))
    if ((parent !== sourceRoot && !parent.startsWith(sourceRoot + "/")) || !lstatSync(src).isFile()) {
      throw new Error(`git-config: nonregular import ${rel}`)
    }
  }
  if ((await git(mainWorktree, ["worktree", "prune"])) === null) throw new Error("git-config: could not prune worktrees")
  if ((await git(mainPath, ["worktree", "add", "--detach", "--quiet", paths.child, head])) === null) throw new Error("git-config: could not create the task worktree")
  // 1. tracked modifications of the main worktree (incl. staged), as a patch applied to the new worktree
  const patch = await gitBuffer(mainPath, ["diff", "--binary", "HEAD", "--", ".", ...exclude])
  if (patch === null) throw new Error("git-config: could not capture main worktree changes")
  if (patch && patch.length) {
    const file = join(dirname(paths.child), `${taskId}.base.patch`)
    writeFileSync(file, patch, { flag: "wx", mode: 0o600 })
    if ((await git(paths.child, ["apply", "--whitespace=nowarn", file])) === null) {
      await git(mainPath, ["worktree", "remove", "--force", paths.child])
      throw new Error("git-config: could not import main worktree changes")
    }
    unlinkOwnedFile(file)
  }
  // 2. untracked, non-ignored files (new modules from earlier tasks, the user's new files)
  for (const rel of untracked) {
    const src = join(mainPath, rel)
    const dst = join(paths.child, rel)
    mkdirSync(dirname(dst), { recursive: true })
    const destParent = realpathSync.native(dirname(dst))
    const destRoot = realpathSync.native(paths.child)
    if (destParent !== destRoot && !destParent.startsWith(destRoot + "/")) throw new Error(`git-config: unsafe import ${rel}`)
    copyRegularFile(src, dst, rel)
  }
  const store = await createSnapshotStore(paths.child, paths.baselineDir)
  if (!store) throw new Error("could not create the task worktree snapshot store")
  const baseline = await store.baseline(diffExclude)
  if (!baseline) throw new Error("could not snapshot the task worktree baseline")
  const childIdentity = gitIdentitySync(paths.child)
  const ownership: WorktreeOwnership = {
    version: 1,
    mainWorktree: mainPath,
    childWorktree: paths.child,
    sessionID,
    taskId,
    commonGitDir: mainIdentity.commonGitDir,
    mainGitDir: mainIdentity.gitDir,
    childGitDir: childIdentity.gitDir,
    originalHead: head,
    diffExclude: [...diffExclude],
    baselineTree: baseline.tree,
  }
  writeOwnership(paths.ownershipFile, ownership)
  assertOwnershipSync(mainPath, paths, ownership)
  return bindTaskWorktree(mainPath, paths, ownership, store)
}

/** Reopen an existing task worktree without recreating, importing, or recapturing its baseline. */
export async function reopenTaskWorktree(mainWorktree: string, sessionID: string, taskId: string, diffExclude: string[]): Promise<TaskWorktree> {
  assertIdentifier(sessionID, "session ID")
  assertIdentifier(taskId, "task ID")
  const mainPath = canonicalMainWorktree(mainWorktree)
  if (!hasGitMetadata(mainPath)) throw new Error("task worktree recovery refused: main repository is unavailable")
  const paths = resolveWorktreePaths(mainPath, sessionID, taskId, false)
  assertWorktreeDirectories(paths, sessionID)
  const ownership = readOwnership(paths.ownershipFile)
  validateOwnershipFields(ownership, mainPath, paths, sessionID, taskId, diffExclude)
  assertOwnershipSync(mainPath, paths, ownership)
  if (lstatOrNull(paths.applyMarker)) throw new Error("task worktree recovery refused: merge application may be ambiguous")
  assertBaselineDirectory(paths.baselineDir)
  const store = await createSnapshotStore(paths.child, paths.baselineDir)
  if (!store) throw new Error("task worktree recovery refused: baseline store is unavailable")
  const baseline = await store.baseline(diffExclude, true)
  if (!baseline || baseline.tree !== ownership.baselineTree) {
    throw new Error("task worktree recovery refused: persisted merge baseline does not match ownership metadata")
  }
  assertOwnershipSync(mainPath, paths, ownership)
  return bindTaskWorktree(mainPath, paths, ownership, store)
}

function assertIdentifier(value: string, name: string): void {
  if (!value || value === "." || value === ".." || value === ".recovery" || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`invalid task worktree ${name}`)
  }
}

function canonicalMainWorktree(mainWorktree: string): string {
  const path = resolve(mainWorktree)
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("task worktree main path is not a canonical directory")
  return realpathSync.native(path)
}

function resolveWorktreePaths(mainWorktree: string, sessionID: string, taskId: string, createBase: boolean): WorktreePaths & { baseDir: string } {
  const basePath = resolve(stateBase(mainWorktree))
  assertStateOutsideWorktrees(canonicalDestination(basePath), mainWorktree)
  if (createBase) mkdirSync(basePath, { recursive: true, mode: 0o700 })
  const baseInfo = lstatOrNull(basePath)
  if (!baseInfo || !baseInfo.isDirectory() || baseInfo.isSymbolicLink()) {
    throw new Error("task worktree state directory is unavailable or unsafe")
  }
  const baseDir = realpathSync.native(basePath)
  const root = join(baseDir, worktreeKey(mainWorktree), "worktrees")
  const child = join(root, sessionID, taskId)
  const ownerDir = join(root, ".recovery", sessionID, taskId)
  if (isPathWithin(child, ownerDir) || isPathWithin(ownerDir, child)) {
    throw new Error("task worktree ownership data must be outside the child worktree")
  }
  assertStateOutsideWorktrees(baseDir, mainWorktree)
  return {
    baseDir,
    child,
    ownerDir,
    baselineDir: join(ownerDir, "baseline"),
    ownershipFile: join(ownerDir, "ownership.json"),
    applyMarker: join(ownerDir, "apply-in-progress"),
  }
}

function ensureWorktreeParents(paths: WorktreePaths & { baseDir: string }, sessionID: string, create: boolean): void {
  if (!create) {
    assertDirectoryComponents(paths.baseDir, relative(paths.baseDir, dirname(paths.child)).split(sep))
    assertDirectoryComponents(paths.baseDir, relative(paths.baseDir, dirname(paths.ownerDir)).split(sep))
    return
  }
  ensureSafeDirectoryComponents(paths.baseDir, relative(paths.baseDir, dirname(paths.child)).split(sep))
  ensureSafeDirectoryComponents(paths.baseDir, relative(paths.baseDir, dirname(paths.ownerDir)).split(sep))
  // Validate the requested session names against the paths just constructed, not merely their lexical form.
  if (basename(dirname(paths.child)) !== sessionID) throw new Error("task worktree state path is inconsistent")
}

function lexicalManagedWorktree(path: string): ManagedWorktreePath | undefined {
  if (!path.startsWith(sep)) return undefined
  const taskId = basename(path)
  const sessionID = basename(dirname(path))
  const root = dirname(dirname(path))
  if (basename(root) !== "worktrees") return undefined
  const keyDir = dirname(root)
  if (!/^[0-9a-f]{12}$/.test(basename(keyDir))) return undefined
  assertIdentifier(sessionID, "session ID")
  assertIdentifier(taskId, "task ID")
  const baseDir = dirname(keyDir)
  const ownerDir = join(root, ".recovery", sessionID, taskId)
  return { baseDir, keyDir, root, child: path, sessionID, taskId, ownerDir, ownershipFile: join(ownerDir, "ownership.json") }
}

function validateManagedParents(candidate: ManagedWorktreePath): void {
  const baseInfo = lstatOrNull(candidate.baseDir)
  if (!baseInfo || !baseInfo.isDirectory() || baseInfo.isSymbolicLink() || realpathSync.native(candidate.baseDir) !== candidate.baseDir) {
    throw new Error("task worktree recovery refused: managed state base is missing or unsafe")
  }
  assertDirectoryComponents(candidate.baseDir, [basename(candidate.keyDir), "worktrees"])
  assertDirectoryComponents(candidate.baseDir, [basename(candidate.keyDir), "worktrees", candidate.sessionID])
  assertDirectoryComponents(candidate.baseDir, [basename(candidate.keyDir), "worktrees", ".recovery", candidate.sessionID])
}

function existingSafeDirectory(base: string, directory: string): boolean {
  if (!isPathWithin(base, directory)) throw new Error("task worktree state path escaped its state base")
  let current = base
  for (const part of relative(base, directory).split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = lstatOrNull(current)
    if (!info) return false
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(current) !== current) {
      throw new Error(`task worktree state directory is unsafe: ${current}`)
    }
  }
  return true
}

function assertStateOutsideWorktrees(stateBasePath: string, mainWorktree: string): void {
  if (isPathWithin(mainWorktree, stateBasePath) || isPathWithin(stateBasePath, mainWorktree)) {
    throw new Error("task worktree recovery storage must be outside the main worktree")
  }
}

/** Resolve aliases in existing ancestors without creating the requested path. */
function canonicalDestination(path: string): string {
  let current = resolve(path)
  const missing: string[] = []
  while (!lstatOrNull(current)) {
    const parent = dirname(current)
    if (parent === current) throw new Error("task worktree state has no existing ancestor")
    missing.unshift(basename(current))
    current = parent
  }
  return join(realpathSync.native(current), ...missing)
}

function ensureSafeDirectoryComponents(base: string, components: string[]): void {
  let current = base
  for (const part of components.filter(Boolean)) {
    current = join(current, part)
    let info = lstatOrNull(current)
    if (!info) {
      mkdirSync(current, { mode: 0o700 })
      info = lstatSync(current)
    }
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(current) !== resolve(current)) {
      throw new Error(`task worktree state directory is unsafe: ${current}`)
    }
  }
}

function assertDirectoryComponents(base: string, components: string[]): void {
  let current = base
  for (const part of components.filter(Boolean)) {
    current = join(current, part)
    const info = lstatOrNull(current)
    if (!info || !info.isDirectory() || info.isSymbolicLink() || realpathSync.native(current) !== resolve(current)) {
      throw new Error(`task worktree state directory is missing or unsafe: ${current}`)
    }
  }
}

function assertWorktreeDirectories(paths: WorktreePaths & { baseDir: string }, sessionID: string): void {
  ensureWorktreeParents(paths, sessionID, false)
  const ownerInfo = lstatOrNull(paths.ownerDir)
  if (!ownerInfo || !ownerInfo.isDirectory() || ownerInfo.isSymbolicLink() || (ownerInfo.mode & 0o077) !== 0 || realpathSync.native(paths.ownerDir) !== paths.ownerDir) {
    throw new Error("task worktree recovery refused: ownership directory is missing or unsafe")
  }
}

function gitIdentitySync(worktree: string): { top: string; gitDir: string; commonGitDir: string; head: string } {
  const fields = safeGitSync(worktree, ["rev-parse", "--path-format=absolute", "--is-inside-work-tree",
    "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "HEAD"]).split("\n")
  if (fields.length !== 5 || fields[0] !== "true") throw new Error("git-config: could not inspect the worktree identity")
  const top = realpathSync.native(fields[1]!)
  const gitDir = realpathSync.native(fields[2]!)
  const commonGitDir = realpathSync.native(fields[3]!)
  const head = fields[4]!
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error("git-config: could not resolve worktree HEAD")
  return { top, gitDir, commonGitDir, head }
}

function assertOwnershipSync(mainWorktree: string, paths: WorktreePaths & { baseDir: string }, ownership: WorktreeOwnership): void {
  assertWorktreeDirectories(paths, ownership.sessionID)
  const childInfo = lstatOrNull(paths.child)
  if (!childInfo || !childInfo.isDirectory() || childInfo.isSymbolicLink() || realpathSync.native(paths.child) !== paths.child) {
    throw new Error("task worktree recovery refused: child path is missing or was replaced")
  }
  const persisted = readOwnership(paths.ownershipFile)
  if (!sameOwnership(persisted, ownership)) throw new Error("task worktree recovery refused: ownership metadata changed")
  if (ownership.mainWorktree !== mainWorktree || ownership.childWorktree !== paths.child) {
    throw new Error("task worktree recovery refused: ownership paths do not match")
  }
  const main = gitIdentitySync(mainWorktree)
  const child = gitIdentitySync(paths.child)
  if (main.top !== mainWorktree || main.head !== ownership.originalHead ||
    main.gitDir !== ownership.mainGitDir || main.commonGitDir !== ownership.commonGitDir ||
    child.top !== ownership.childWorktree || child.gitDir !== ownership.childGitDir ||
    child.commonGitDir !== ownership.commonGitDir || child.head !== ownership.originalHead) {
    throw new Error("task worktree recovery refused: Git worktree identity or original HEAD changed")
  }
  if (gitDirectoryPointer(paths.child) !== ownership.childGitDir) {
    throw new Error("task worktree recovery refused: linked worktree Git pointer changed")
  }
  const registration = safeGitSync(mainWorktree, ["worktree", "list", "--porcelain", "-z"])
  if (!registeredWorktree(registration, ownership.childWorktree, ownership.originalHead)) {
    throw new Error("task worktree recovery refused: child is not the registered linked worktree")
  }
}

function gitDirectoryPointer(worktree: string): string {
  const path = join(worktree, ".git")
  const info = lstatOrNull(path)
  if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error("task worktree recovery refused: linked worktree pointer is missing or unsafe")
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isFile()) throw new Error("task worktree recovery refused: linked worktree pointer is unsafe")
    const content = readFileSync(fd, "utf8")
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(content)
    if (!match) throw new Error("task worktree recovery refused: linked worktree pointer is corrupt")
    return realpathSync.native(resolve(dirname(path), match[1]!))
  } finally {
    closeSync(fd)
  }
}

function registeredWorktree(output: string, childPath: string, head: string): boolean {
  const entries: Record<string, string>[] = []
  let entry: Record<string, string> = {}
  for (const field of output.split("\0")) {
    if (!field) {
      if (Object.keys(entry).length) entries.push(entry)
      entry = {}
      continue
    }
    const split = field.indexOf(" ")
    const key = split < 0 ? field : field.slice(0, split)
    if (key === "worktree" && entry.worktree !== undefined) {
      entries.push(entry)
      entry = {}
    }
    entry[key] = split < 0 ? "" : field.slice(split + 1)
  }
  if (Object.keys(entry).length) entries.push(entry)
  return entries.filter((item) => item.worktree === childPath && item.HEAD === head).length === 1
}

function writeOwnership(path: string, ownership: WorktreeOwnership): void {
  const dir = dirname(path)
  const info = lstatOrNull(dir)
  if (!info || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || realpathSync.native(dir) !== dir) {
    throw new Error("task worktree ownership directory is unsafe")
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeFileSync(fd, JSON.stringify(ownership) + "\n")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const dirFD = openSync(dir, "r")
  try { fsyncSync(dirFD) }
  finally { closeSync(dirFD) }
}

function readOwnership(path: string): WorktreeOwnership {
  const directory = dirname(path)
  const directoryInfo = lstatOrNull(directory)
  if (!directoryInfo || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
    (directoryInfo.mode & 0o077) !== 0 || realpathSync.native(directory) !== directory) {
    throw new Error("task worktree recovery refused: ownership directory is unsafe")
  }
  const info = lstatOrNull(path)
  if (!info) throw new Error("task worktree recovery refused: ownership metadata is missing")
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 || (info.mode & 0o077) !== 0) {
    throw new Error("task worktree recovery refused: ownership metadata is unsafe")
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let value: unknown
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 64 * 1024 || (opened.mode & 0o077) !== 0) {
      throw new Error("task worktree recovery refused: ownership metadata is unsafe")
    }
    value = JSON.parse(readFileSync(fd, "utf8")) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("task worktree recovery refused: ownership metadata is corrupt")
    throw error
  } finally {
    closeSync(fd)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task worktree recovery refused: ownership metadata is invalid")
  const metadata = value as Record<string, unknown>
  const keys = ["version", "mainWorktree", "childWorktree", "sessionID", "taskId", "commonGitDir", "mainGitDir", "childGitDir", "originalHead", "diffExclude", "baselineTree"].sort()
  if (Object.keys(metadata).sort().join("\0") !== keys.join("\0") || metadata.version !== 1 ||
    typeof metadata.mainWorktree !== "string" || typeof metadata.childWorktree !== "string" ||
    typeof metadata.sessionID !== "string" || typeof metadata.taskId !== "string" ||
    typeof metadata.commonGitDir !== "string" || typeof metadata.mainGitDir !== "string" || typeof metadata.childGitDir !== "string" ||
    typeof metadata.originalHead !== "string" || !Array.isArray(metadata.diffExclude) ||
    !metadata.diffExclude.every((path) => typeof path === "string") || typeof metadata.baselineTree !== "string") {
    throw new Error("task worktree recovery refused: ownership metadata is invalid")
  }
  return metadata as WorktreeOwnership
}

function validateOwnershipFields(ownership: WorktreeOwnership, mainWorktree: string, paths: WorktreePaths, sessionID: string, taskId: string, diffExclude: string[]): void {
  if (ownership.version !== 1 || ownership.mainWorktree !== mainWorktree || ownership.childWorktree !== paths.child ||
    ownership.sessionID !== sessionID || ownership.taskId !== taskId || !sameStrings(ownership.diffExclude, diffExclude) ||
    !/^[0-9a-f]{40,64}$/.test(ownership.originalHead) || !/^[0-9a-f]{40,64}$/.test(ownership.baselineTree) ||
    ![ownership.commonGitDir, ownership.mainGitDir, ownership.childGitDir].every((path) => resolve(path) === path)) {
    throw new Error("task worktree recovery refused: ownership metadata does not match this task or Git configuration")
  }
}

function sameOwnership(left: WorktreeOwnership, right: WorktreeOwnership): boolean {
  return left.version === right.version && left.mainWorktree === right.mainWorktree && left.childWorktree === right.childWorktree &&
    left.sessionID === right.sessionID && left.taskId === right.taskId && left.commonGitDir === right.commonGitDir &&
    left.mainGitDir === right.mainGitDir && left.childGitDir === right.childGitDir && left.originalHead === right.originalHead &&
    left.baselineTree === right.baselineTree && sameStrings(left.diffExclude, right.diffExclude)
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isPathWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function assertBaselineDirectory(path: string): void {
  const info = lstatOrNull(path)
  if (!info || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || realpathSync.native(path) !== path) {
    throw new Error("task worktree recovery refused: baseline directory is missing or unsafe")
  }
  const names = readdirSync(path)
  const allowed = new Set(["baseline.json", "index", "objects", "pathspecs"])
  if (!names.includes("baseline.json") || !names.includes("objects") || names.some((name) => !allowed.has(name))) {
    throw new Error("task worktree recovery refused: baseline store is incomplete or contains unexpected entries")
  }
  for (const name of names) {
    const item = lstatSync(join(path, name))
    if (item.isSymbolicLink() || (name === "objects" ? !item.isDirectory() : !item.isFile())) {
      throw new Error("task worktree recovery refused: baseline store contains an unsafe entry")
    }
  }
}

function bindTaskWorktree(mainWorktree: string, paths: WorktreePaths & { baseDir: string }, ownership: WorktreeOwnership, store: SnapshotStore): TaskWorktree {
  const baseline: NonNullable<Snapshot> = { tree: ownership.baselineTree, store }
  return {
    path: paths.child,
    base: ownership.originalHead,
    store,
    baseline,
    async merge(diffExclude, commit, expectedTree) {
      if (!sameStrings(diffExclude, ownership.diffExclude)) {
        return { ok: false, reason: "task worktree exclusion set changed", patch: "" }
      }
      try {
        assertOwnershipSync(mainWorktree, paths, ownership)
        if (lstatOrNull(paths.applyMarker)) return { ok: false, reason: "merge application may be ambiguous", patch: "" }
      } catch {
        return { ok: false, reason: "task worktree ownership changed", patch: "" }
      }
      const after = await store.snapshot(ownership.diffExclude)
      if (!after) return { ok: false, reason: "could not snapshot the worktree", patch: "" }
      if (expectedTree !== undefined && after.tree !== expectedTree) return { ok: false, reason: "worktree changed since verification", patch: "" }
      if (baseline.tree === after.tree) {
        if (commit && !commit.guard()) return { ok: false, reason: "task cancelled before merge", patch: "" }
        if (expectedTree !== undefined && store.snapshotSync(ownership.diffExclude)?.tree !== expectedTree) {
          return { ok: false, reason: "worktree changed since verification", patch: "" }
        }
        try { assertOwnershipSync(mainWorktree, paths, ownership) }
        catch { return { ok: false, reason: "task worktree ownership changed", patch: "" } }
        commit?.applied([])
        return { ok: true, files: [] }
      }
      const raw = await gitBuffer(paths.child, ["diff", "--binary", baseline.tree, after.tree], store.env)
      const names = await gitBuffer(paths.child, ["diff", "--name-only", "-z", baseline.tree, after.tree], store.env)
      if (raw === null || names === null || !raw.length) return { ok: false, reason: "could not diff the worktree", patch: "" }
      const files = nulPaths(names)
      const patchFile = join(dirname(paths.child), `${ownership.taskId}.patch`)
      try { writeFileSync(patchFile, raw, { flag: "wx", mode: 0o600 }) }
      catch { return { ok: false, reason: "could not preserve the task patch", patch: patchFile } }
      const check = await git(mainWorktree, ["apply", "--check", "--whitespace=nowarn", patchFile])
      if (check === null) return { ok: false, reason: "the task's patch does not apply to the current working tree (it changed underneath the task)", patch: patchFile }
      // The final guard, tree/ownership rechecks, marker and apply share one synchronous turn.
      if (commit && !commit.guard()) return { ok: false, reason: "task cancelled before merge", patch: patchFile }
      if (expectedTree !== undefined && store.snapshotSync(ownership.diffExclude)?.tree !== expectedTree) {
        return { ok: false, reason: "worktree changed since verification", patch: patchFile }
      }
      try { assertOwnershipSync(mainWorktree, paths, ownership) }
      catch { return { ok: false, reason: "task worktree ownership changed", patch: patchFile } }
      try { writeApplyMarker(paths, ownership) }
      catch { return { ok: false, reason: "could not persist merge application marker", patch: patchFile } }
      try { safeGitSync(mainWorktree, ["apply", "--whitespace=nowarn", patchFile]) }
      catch { return { ok: false, reason: "git apply failed; merge recovery is ambiguous", patch: patchFile } }
      commit?.applied(files)
      unlinkOwnedFile(patchFile)
      return { ok: true, files }
    },
    async remove() {
      assertOwnershipSync(mainWorktree, paths, ownership)
      const baselineNow = await store.baseline(ownership.diffExclude, true)
      if (!baselineNow || baselineNow.tree !== ownership.baselineTree) throw new Error("refusing to remove task worktree with an invalid baseline")
      assertOwnershipSync(mainWorktree, paths, ownership)
      assertOwnerContents(paths)
      if (await git(mainWorktree, ["worktree", "remove", "--force", paths.child]) === null) {
        throw new Error("could not safely remove the registered task worktree")
      }
      if (lstatOrNull(paths.child)) throw new Error("task worktree path remains after Git removal; preserving recovery metadata")
      if (await git(mainWorktree, ["worktree", "prune"]) === null) throw new Error("could not prune the removed task worktree")
      assertWorktreeDirectories(paths, ownership.sessionID)
      assertOwnerContents(paths)
      store.dispose()
      if (lstatOrNull(paths.baselineDir)) throw new Error("task baseline could not be safely removed; preserving ownership metadata")
      assertWorktreeDirectories(paths, ownership.sessionID)
      unlinkOwnedFile(paths.ownershipFile)
      if (lstatOrNull(paths.applyMarker)) unlinkOwnedFile(paths.applyMarker)
      rmdirSync(paths.ownerDir)
      for (const dir of [dirname(paths.ownerDir), dirname(dirname(paths.ownerDir)), dirname(paths.child)]) {
        try { rmdirSync(dir) } catch {}
      }
    },
  }
}

function assertOwnerContents(paths: WorktreePaths & { baseDir: string }): void {
  const allowed = new Set(["baseline", "ownership.json", "apply-in-progress"])
  if (readdirSync(paths.ownerDir).some((name) => !allowed.has(name))) throw new Error("refusing to remove task worktree with unexpected ownership files")
  assertBaselineDirectory(paths.baselineDir)
  const marker = lstatOrNull(paths.applyMarker)
  if (marker && (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || (marker.mode & 0o077) !== 0)) {
    throw new Error("refusing to remove task worktree with an unsafe apply marker")
  }
}

function writeApplyMarker(paths: WorktreePaths & { baseDir: string }, ownership: WorktreeOwnership): void {
  const dirInfo = lstatOrNull(paths.ownerDir)
  if (!dirInfo || !dirInfo.isDirectory() || dirInfo.isSymbolicLink() || (dirInfo.mode & 0o077) !== 0 || realpathSync.native(paths.ownerDir) !== paths.ownerDir) {
    throw new Error("task worktree ownership directory is unsafe")
  }
  const fd = openSync(paths.applyMarker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, originalHead: ownership.originalHead, baselineTree: ownership.baselineTree }) + "\n")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const dirFD = openSync(paths.ownerDir, "r")
  try { fsyncSync(dirFD) }
  finally { closeSync(dirFD) }
}

function unlinkOwnedFile(path: string): void {
  const parent = dirname(path)
  const parentInfo = lstatOrNull(parent)
  if (!parentInfo || !parentInfo.isDirectory() || parentInfo.isSymbolicLink() || realpathSync.native(parent) !== parent) {
    throw new Error(`refusing to remove file through an unsafe worktree state directory: ${path}`)
  }
  const info = lstatOrNull(path)
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`refusing to remove unsafe worktree state file: ${path}`)
  unlinkSync(path)
}

function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
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

export function worktreeExists(path: string): boolean {
  return existsSync(join(path, ".git"))
}
