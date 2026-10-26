import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { FdTree, FdTreeError, type FdStat } from "../skills/fd-tree.ts"

export const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024
export const MAX_SOURCE_FILES = 20_000
export const MAX_ROOTS = 32
export const MAX_ROOT_DEPTH = 64
export const MAX_TOTAL_ROOT_DEPTH = 120
export const MAX_SOURCE_PATH_BYTES = 4096

const SOURCE_SUFFIXES = new Set([".ts", ".tsx", ".py"])
const EXCLUDED_COMPONENTS = new Set([
  ".git", ".gjc", ".otter", "artifacts", "build", "cache", "credential", "credentials", "dist",
  "docs", "knowledge", "media", "node_modules", "secret", "secrets", "vendor",
  "__pycache__", "coverage", "generated", "out", "target", "temp", "tmp",
])
const SENSITIVE_NAME_PREFIX = /^(?:secret|secrets|credential|credentials)(?:$|[._-])/u
const GIT_CONFIG = [
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.excludesfile=/dev/null",
  "-c", "core.attributesFile=/dev/null", "-c", "credential.helper=", "-c", "core.sshCommand=/bin/false",
  "-c", "diff.external=", "-c", "protocol.allow=never", "-c", "core.pager=cat",
]
const GIT_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
})

export const REPO_SEARCH_POLICY_FINGERPRINT = createHash("sha256").update(JSON.stringify({
  schema: 1,
  trackedOnly: true,
  gitEnumeration: "fixed-no-shell;config-hooks-fsmonitor-locks-lazy-fetch-disabled",
  suffixes: [...SOURCE_SUFFIXES].sort(),
  excludedComponents: [...EXCLUDED_COMPONENTS].sort(),
  sensitiveNamePrefix: SENSITIVE_NAME_PREFIX.source,
  hiddenComponents: "excluded",
  maxSourceFileBytes: MAX_SOURCE_FILE_BYTES,
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxSourceFiles: MAX_SOURCE_FILES,
  maxRoots: MAX_ROOTS,
  maxRootDepth: MAX_ROOT_DEPTH,
  maxTotalRootDepth: MAX_TOTAL_ROOT_DEPTH,
  maxSourcePathBytes: MAX_SOURCE_PATH_BYTES,
  noSymlinkOrHardlink: true,
}), "utf8").digest("hex")

export type GitIdentity = Readonly<{
  topLevel: string
  gitDirectory: string
  gitDirectoryDev: string
  gitDirectoryIno: string
  commonDirectory: string
  commonDirectoryDev: string
  commonDirectoryIno: string
  objectFormat: string
  head: string
}>

export type CorpusFile = Readonly<{
  path: string
  sha256: string
  size: number
  bytes: Buffer
}>

export type CorpusSnapshot = Readonly<{
  canonicalRoot: string
  rootDev: string
  rootIno: string
  gitIdentity: GitIdentity
  roots: readonly string[]
  files: readonly CorpusFile[]
  sourceFingerprint: string
}>

export type RepoIdentity = Readonly<{
  canonicalRoot: string
  rootDev: string
  rootIno: string
  gitIdentity: GitIdentity
}>

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("repo_search_cancelled")
}

function git(args: string[], cwd: string): Buffer {
  return execFileSync("/usr/bin/git", ["-C", cwd, ...GIT_CONFIG, ...args], {
    cwd,
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
    timeout: 15_000,
    maxBuffer: 128 * 1024 * 1024,
  })
}

function textOutput(bytes: Buffer, reason: string): string {
  let text = bytes.toString("utf8")
  if (text.endsWith("\n")) text = text.slice(0, -1)
  if (!text || text.includes("\0") || text.includes("\n") || text.includes("\r")) throw new Error(reason)
  return text
}

function canonicalGitRoot(worktree: string): string {
  let supplied: string
  try { supplied = realpathSync(worktree) } catch { throw new Error("repo_search_worktree_unavailable") }
  const topLevel = textOutput(git(["rev-parse", "--show-toplevel"], supplied), "repo_search_not_git_worktree")
  let canonical: string
  try { canonical = realpathSync(topLevel) } catch { throw new Error("repo_search_not_git_worktree") }
  const fromTop = relative(canonical, supplied)
  if (fromTop === ".." || fromTop.startsWith(`..${sep}`) || fromTop.startsWith(sep)) throw new Error("repo_search_not_git_worktree")
  return canonical
}

function canonicalGitDirectory(raw: string, root: string): string {
  let path = raw
  if (!path.startsWith("/")) path = resolve(root, path)
  try { return realpathSync(path) } catch { throw new Error("repo_search_git_identity_unavailable") }
}

function directoryIdentity(path: string): { dev: string; ino: string } {
  const info = statSync(path, { bigint: true })
  if (!info.isDirectory()) throw new Error("repo_search_git_identity_unavailable")
  return { dev: info.dev.toString(), ino: info.ino.toString() }
}

function gitIdentity(root: string): GitIdentity {
  const gitDirectory = canonicalGitDirectory(textOutput(git(["rev-parse", "--absolute-git-dir"], root), "repo_search_git_identity_unavailable"), root)
  const commonDirectory = canonicalGitDirectory(textOutput(git(["rev-parse", "--git-common-dir"], root), "repo_search_git_identity_unavailable"), root)
  const objectFormat = textOutput(git(["rev-parse", "--show-object-format"], root), "repo_search_git_identity_unavailable")
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("repo_search_git_identity_unavailable")
  let head: string
  try {
    head = textOutput(git(["rev-parse", "--verify", "--quiet", "HEAD"], root), "repo_search_git_identity_unavailable")
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) throw new Error("repo_search_git_identity_unavailable")
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 1) head = "unborn"
    else throw error
  }
  const gitStat = directoryIdentity(gitDirectory)
  const commonStat = directoryIdentity(commonDirectory)
  return Object.freeze({
    topLevel: root,
    gitDirectory,
    gitDirectoryDev: gitStat.dev,
    gitDirectoryIno: gitStat.ino,
    commonDirectory,
    commonDirectoryDev: commonStat.dev,
    commonDirectoryIno: commonStat.ino,
    objectFormat,
    head,
  })
}

export function inspectRepoIdentity(worktree: string): RepoIdentity {
  const canonicalRoot = canonicalGitRoot(worktree)
  const tree = FdTree.openRoot(canonicalRoot)
  try {
    const identity = gitIdentity(canonicalRoot)
    tree.assertStable()
    return Object.freeze({
      canonicalRoot,
      rootDev: tree.root.openedStat.dev.toString(),
      rootIno: tree.root.openedStat.ino.toString(),
      gitIdentity: identity,
    })
  } finally { tree.close() }
}

function hasExcludedComponent(path: string): boolean {
  return path.split("/").some(component => {
    const name = component.toLowerCase()
    return name.startsWith(".") || EXCLUDED_COMPONENTS.has(name) || SENSITIVE_NAME_PREFIX.test(name)
  })
}

export function isEligibleRepoSearchPath(path: string, roots: readonly string[]): boolean {
  if (!path || Buffer.byteLength(path, "utf8") > MAX_SOURCE_PATH_BYTES || /[\x00-\x1f\x7f]/u.test(path) || path.startsWith("/") || path.includes("\\") ||
    Buffer.from(path, "utf8").toString("utf8") !== path || path.split("/").some(part => !part || part === "." || part === "..")) return false
  if (hasExcludedComponent(path)) return false
  if (!roots.some(root => path.startsWith(`${root}/`))) return false
  const lastSlash = path.lastIndexOf("/")
  const name = path.slice(lastSlash + 1)
  const dot = name.lastIndexOf(".")
  return dot >= 0 && SOURCE_SUFFIXES.has(name.slice(dot))
}

function parseTrackedPaths(bytes: Buffer, roots: readonly string[]): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  let start = 0
  while (start < bytes.length) {
    const end = bytes.indexOf(0, start)
    if (end < 0) throw new Error("repo_search_invalid_git_listing")
    const entry = bytes.subarray(start, end)
    start = end + 1
    const tab = entry.indexOf(9)
    if (tab < 0) throw new Error("repo_search_invalid_git_listing")
    const metadata = entry.subarray(0, tab).toString("ascii")
    const match = /^(100644|100755) (?:[a-f0-9]{40}|[a-f0-9]{64}) ([0-3])$/u.exec(metadata)
    if (match && match[1] !== undefined) {
      const rawPath = entry.subarray(tab + 1)
      let path: string
      try { path = new TextDecoder("utf-8", { fatal: true }).decode(rawPath) } catch { continue }
      if (match[2] !== "0") {
        if (isEligibleRepoSearchPath(path, roots)) throw new Error("repo_search_index_conflict")
        continue
      }
      if (!isEligibleRepoSearchPath(path, roots)) continue
      if (seen.has(path)) throw new Error("repo_search_duplicate_git_path")
      seen.add(path)
      paths.push(path)
      if (paths.length > MAX_SOURCE_FILES) throw new Error("repo_search_file_limit")
      continue
    }
    const nonRegular = /^(?:120000|160000) (?:[a-f0-9]{40}|[a-f0-9]{64}) 0$/u.test(metadata)
    if (nonRegular) continue
    if (/^(?:100644|100755) (?:[a-f0-9]{40}|[a-f0-9]{64}) 0$/u.test(metadata)) throw new Error("repo_search_invalid_git_listing")
  }
  return paths.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
}

function isRegularFile(mode: number): boolean {
  return (mode & 0o170000) === 0o100000
}

export function normalizeRepoSearchRoots(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ROOTS) throw new Error("repo_search_roots_required")
  const roots: string[] = []
  const seen = new Set<string>()
  let totalDepth = 1
  for (const root of input) {
    if (typeof root !== "string" || Buffer.byteLength(root, "utf8") > 1024 || root.includes("\0") || root.includes("\\") ||
      Buffer.from(root, "utf8").toString("utf8") !== root ||
      root.startsWith("/") || root.endsWith("/") || root === "." || root.split("/").some(part => !part || part === "." || part === "..") ||
      root.split("/").length > MAX_ROOT_DEPTH || hasExcludedComponent(root) || /[\x00-\x1f\x7f]/u.test(root)) throw new Error("repo_search_invalid_root")
    if (seen.has(root)) throw new Error("repo_search_duplicate_root")
    seen.add(root)
    totalDepth += root.split("/").length
    if (totalDepth > MAX_TOTAL_ROOT_DEPTH) throw new Error("repo_search_invalid_root")
    roots.push(root)
  }
  return roots.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
}

export function captureRepoCorpus(worktree: string, requestedRoots: readonly string[], signal?: AbortSignal): CorpusSnapshot {
  abortIfRequested(signal)
  const roots = normalizeRepoSearchRoots(requestedRoots)
  const initialIdentity = inspectRepoIdentity(worktree)
  const { canonicalRoot, gitIdentity: initialGitIdentity } = initialIdentity
  const tree = FdTree.openRoot(canonicalRoot)
  try {
    const rootStat = tree.root.openedStat
    if (rootStat.dev.toString() !== initialIdentity.rootDev || rootStat.ino.toString() !== initialIdentity.rootIno) {
      throw new Error("repo_search_identity_mismatch")
    }
    for (const root of roots) tree.openDirectoryRelative(root)
    const tracked = parseTrackedPaths(git(["ls-files", "--stage", "-z", "--cached"], canonicalRoot), roots)
    const files: CorpusFile[] = []
    let totalBytes = 0
    for (const path of tracked) {
      abortIfRequested(signal)
      const checkpoint = tree.checkpoint()
      try {
        let info: FdStat
        try { info = tree.statRelative(path) } catch (error) {
          if (error instanceof FdTreeError && error.code === 2) continue
          throw error
        }
        if (!isRegularFile(Number(info.mode)) || info.nlink !== 1n) continue
        if (info.size < 0n || info.size > BigInt(MAX_SOURCE_FILE_BYTES)) throw new Error("repo_search_file_size_limit")
        const read = tree.readFileRelative(path)
        totalBytes += read.bytes.byteLength
        if (totalBytes > MAX_SOURCE_BYTES) throw new Error("repo_search_source_size_limit")
        const content = Buffer.from(read.bytes)
        const sha256 = createHash("sha256").update(content).digest("hex")
        files.push(Object.freeze({ path, sha256, size: content.byteLength, bytes: content }))
        tree.assertStableSince(checkpoint)
      } finally {
        tree.releaseSince(checkpoint)
      }
    }
    tree.assertStable()
    const finalGitIdentity = gitIdentity(canonicalRoot)
    if (JSON.stringify(initialGitIdentity) !== JSON.stringify(finalGitIdentity)) throw new Error("repo_search_git_identity_changed")
    tree.assertStable()
    const metadata = files.map(file => [file.path, file.sha256, file.size])
    const sourceFingerprint = createHash("sha256").update(JSON.stringify({
      schema: 1,
      canonicalRoot,
      rootDev: rootStat.dev.toString(),
      rootIno: rootStat.ino.toString(),
      gitIdentity: initialGitIdentity,
      roots,
      policyFingerprint: REPO_SEARCH_POLICY_FINGERPRINT,
      files: metadata,
    }), "utf8").digest("hex")
    return Object.freeze({
      canonicalRoot,
      rootDev: rootStat.dev.toString(),
      rootIno: rootStat.ino.toString(),
      gitIdentity: initialGitIdentity,
      roots: Object.freeze(roots),
      files: Object.freeze(files),
      sourceFingerprint,
    })
  } finally {
    tree.close()
  }
}
