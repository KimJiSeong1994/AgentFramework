import { constants, chmodSync, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeSync, type BigIntStats, type Stats } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { GRAPHIFY_COMMIT, createGraphRuntime, type GraphHit, type GraphRuntime } from "./runtime.ts"
import {
  captureRepoCorpus,
  inspectRepoIdentity,
  isEligibleRepoSearchPath,
  normalizeRepoSearchRoots,
  REPO_SEARCH_POLICY_FINGERPRINT,
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILES,
  type CorpusSnapshot,
  type GitIdentity,
} from "./corpus.ts"

export const DEFAULT_REPO_SEARCH_STORAGE_ROOT = join(homedir(), ".local", "share", "otter", "repo-search")
export const MAX_GRAPH_BYTES = 64 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
export const MAX_REPO_SEARCH_OUTPUT_BYTES = 8 * 1024
const HASH = /^[a-f0-9]{64}$/u
const GENERATION = /^gen-[a-f0-9]{32}$/u
const UNTRUSTED_NOTICE = "UNTRUSTED repository references: navigation hints only; verify each reference against the current worktree."

export type RepoSearchFile = Readonly<{ path: string; sha256: string; size: number }>
export type RepoSearchManifest = Readonly<{
  schema: 1
  approved: true
  generationId: string
  canonicalRoot: string
  rootDev: string
  rootIno: string
  gitIdentity: GitIdentity
  roots: readonly string[]
  files: readonly RepoSearchFile[]
  sourceFingerprint: string
  policyFingerprint: string
  bridgeFingerprint: string
  runtimeFingerprint: string
  graphSha256: string
  graphSize: number
  createdAt: string
}>

type LoadedIndex = Readonly<{
  manifest: RepoSearchManifest
  generationDirectory: string
  graphPath: string
}>

export type BuildRepoSearchOptions = Readonly<{
  approve: true
  storageRoot?: string
  runtime?: GraphRuntime
  signal?: AbortSignal
}>

function fail(code: string): never { throw new Error(code) }
function uid(): number {
  if (typeof process.getuid !== "function") return fail("repo_search_unsupported_platform")
  return process.getuid()
}
function hashText(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex") }
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined
}
function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) fail("repo_search_cancelled")
}

function checkPathComponents(path: string, createDirectories: boolean): string {
  const full = resolve(path)
  const components = full.split(sep).filter(Boolean)
  let current: string = sep
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]!)
    let info: Stats
    try { info = lstatSync(current) } catch (error) {
      if (errorCode(error) !== "ENOENT") fail("repo_search_store_unsafe")
      if (!createDirectories) fail("repo_search_missing_artifact")
      try { mkdirSync(current, 0o700) } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") fail("repo_search_store_unsafe")
      }
      try { info = lstatSync(current) } catch { fail("repo_search_store_unsafe") }
    }
    if (info.isSymbolicLink()) fail("repo_search_store_symlink")
    if (!info.isDirectory()) fail("repo_search_store_unsafe")
  }
  return full
}

function ensurePrivateDirectory(path: string): string {
  const full = checkPathComponents(path, true)
  const info = lstatSync(full)
  if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o777) !== 0o700) fail("repo_search_store_permissions")
  return full
}
function checkPrivateDirectory(path: string, expectedMode = 0o700): string {
  const full = checkPathComponents(path, false)
  const info = lstatSync(full)
  if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o777) !== expectedMode) fail("repo_search_store_permissions")
  return full
}

function assertNoSymlinkComponents(path: string): void {
  const full = resolve(path)
  const components = full.split(sep).filter(Boolean)
  let current: string = sep
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]!)
    let info: Stats
    try { info = lstatSync(current) } catch { fail("repo_search_store_missing") }
    if (info.isSymbolicLink()) fail("repo_search_store_symlink")
    if (index < components.length - 1 && !info.isDirectory()) fail("repo_search_store_unsafe")
  }
}

function ensureStoreDirectories(canonicalRoot: string, storageRoot: string, create: boolean): { entry: string; generations: string } {
  const root = create ? ensurePrivateDirectory(storageRoot) : checkPrivateDirectory(storageRoot)
  const key = hashText(canonicalRoot)
  const entryPath = join(root, key)
  const entry = create ? ensurePrivateDirectory(entryPath) : checkPrivateDirectory(entryPath)
  const generationsPath = join(entry, "generations")
  const generations = create ? ensurePrivateDirectory(generationsPath) : checkPrivateDirectory(generationsPath)
  return { entry, generations }
}

function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

function assertPrivateFileStat(info: BigIntStats, expectedMode: number, maximumBytes: number): void {
  if (!info.isFile() || info.uid !== BigInt(uid()) || info.nlink !== 1n || (info.mode & 0o777n) !== BigInt(expectedMode) ||
    info.size < 0n || info.size > BigInt(maximumBytes)) fail("repo_search_store_file_unsafe")
}

function readPrivateFile(path: string, expectedMode: number, maximumBytes: number): Buffer {
  assertNoSymlinkComponents(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true })
    const named = lstatSync(path, { bigint: true })
    assertPrivateFileStat(before, expectedMode, maximumBytes)
    if (!sameStat(before, named)) fail("repo_search_store_race")
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) fail("repo_search_store_race")
      offset += count
    }
    const after = fstatSync(fd, { bigint: true })
    assertNoSymlinkComponents(path)
    const afterName = lstatSync(path, { bigint: true })
    if (!sameStat(before, after) || !sameStat(before, afterName)) fail("repo_search_store_race")
    return bytes
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("repo_search_")) throw error
    fail("repo_search_store_unreadable")
  } finally { closeSync(fd) }
}

function writePrivateFile(path: string, bytes: Uint8Array, mode: 0o400 | 0o600): void {
  assertNoSymlinkComponents(dirname(path))
  let fd: number
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) } catch {
    fail("repo_search_store_write_failed")
  }
  try {
    const buffer = Buffer.from(bytes)
    let offset = 0
    while (offset < buffer.length) {
      const count = writeSync(fd, buffer, offset, buffer.length - offset)
      if (count <= 0) fail("repo_search_store_write_failed")
      offset += count
    }
    fchmodSync(fd, mode)
    fsyncSync(fd)
    const info = fstatSync(fd, { bigint: true })
    assertPrivateFileStat(info, mode, MAX_GRAPH_BYTES)
    assertNoSymlinkComponents(path)
    if (!sameStat(info, lstatSync(path, { bigint: true }))) fail("repo_search_store_race")
  } finally { closeSync(fd) }
}

function writeAtomicCurrent(path: string, bytes: Uint8Array): void {
  const parent = dirname(path)
  assertNoSymlinkComponents(parent)
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) fail("repo_search_store_symlink")
    if (!info.isFile() || info.uid !== uid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) fail("repo_search_store_file_unsafe")
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }
  const temporary = join(parent, `.current-${randomUUID()}`)
  try {
    writePrivateFile(temporary, bytes, 0o600)
    renameSync(temporary, path)
  } finally {
    if (pathExists(temporary)) rmSync(temporary, { force: true })
  }
}

function validateGitIdentity(value: unknown): value is GitIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const keys = ["topLevel", "gitDirectory", "gitDirectoryDev", "gitDirectoryIno", "commonDirectory", "commonDirectoryDev", "commonDirectoryIno", "objectFormat", "head"]
  if (Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))) return false
  for (const key of ["topLevel", "gitDirectory", "commonDirectory"]) {
    if (typeof item[key] !== "string" || !isAbsolute(item[key] as string) || (item[key] as string).length > 4096) return false
  }
  for (const key of ["gitDirectoryDev", "gitDirectoryIno", "commonDirectoryDev", "commonDirectoryIno"]) {
    if (typeof item[key] !== "string" || !/^\d{1,32}$/u.test(item[key] as string)) return false
  }
  if (item.objectFormat !== "sha1" && item.objectFormat !== "sha256") return false
  return typeof item.head === "string" && (item.head === "unborn" || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(item.head))
}

function validateManifest(value: unknown): RepoSearchManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("repo_search_corrupt_manifest")
  const manifest = value as Record<string, unknown>
  const keys = ["schema", "approved", "generationId", "canonicalRoot", "rootDev", "rootIno", "gitIdentity", "roots", "files", "sourceFingerprint", "policyFingerprint", "bridgeFingerprint", "runtimeFingerprint", "graphSha256", "graphSize", "createdAt"]
  if (Object.keys(manifest).length !== keys.length || keys.some(key => !Object.hasOwn(manifest, key)) || manifest.schema !== 1 || manifest.approved !== true ||
    typeof manifest.generationId !== "string" || !GENERATION.test(manifest.generationId) || typeof manifest.canonicalRoot !== "string" || !isAbsolute(manifest.canonicalRoot) ||
    typeof manifest.rootDev !== "string" || !/^\d{1,32}$/u.test(manifest.rootDev) || typeof manifest.rootIno !== "string" || !/^\d{1,32}$/u.test(manifest.rootIno) ||
    !validateGitIdentity(manifest.gitIdentity) || !Array.isArray(manifest.roots) || !Array.isArray(manifest.files) ||
    typeof manifest.sourceFingerprint !== "string" || !HASH.test(manifest.sourceFingerprint) || typeof manifest.policyFingerprint !== "string" || !HASH.test(manifest.policyFingerprint) ||
    typeof manifest.bridgeFingerprint !== "string" || !/^[a-f0-9]{40}$/u.test(manifest.bridgeFingerprint) || typeof manifest.runtimeFingerprint !== "string" || !HASH.test(manifest.runtimeFingerprint) ||
    typeof manifest.graphSha256 !== "string" || !HASH.test(manifest.graphSha256) || !Number.isSafeInteger(manifest.graphSize) ||
    (manifest.graphSize as number) < 0 || (manifest.graphSize as number) > MAX_GRAPH_BYTES || typeof manifest.createdAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(manifest.createdAt) || !Number.isFinite(Date.parse(manifest.createdAt))) return fail("repo_search_corrupt_manifest")
  let roots: string[]
  try { roots = normalizeRepoSearchRoots(manifest.roots as string[]) } catch { return fail("repo_search_corrupt_manifest") }
  if (JSON.stringify(roots) !== JSON.stringify(manifest.roots)) return fail("repo_search_corrupt_manifest")
  const files: RepoSearchFile[] = []
  let total = 0
  let previousPath: string | undefined
  for (const file of manifest.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) return fail("repo_search_corrupt_manifest")
    const record = file as Record<string, unknown>
    if (Object.keys(record).length !== 3 || typeof record.path !== "string" || !isEligibleRepoSearchPath(record.path, roots) ||
      typeof record.sha256 !== "string" || !HASH.test(record.sha256) || !Number.isSafeInteger(record.size) ||
      (record.size as number) < 0 || (record.size as number) > MAX_SOURCE_FILE_BYTES ||
      (previousPath !== undefined && Buffer.compare(Buffer.from(previousPath), Buffer.from(record.path)) >= 0)) return fail("repo_search_corrupt_manifest")
    total += record.size as number
    if (total > MAX_SOURCE_BYTES || files.length >= MAX_SOURCE_FILES) return fail("repo_search_corrupt_manifest")
    previousPath = record.path
    files.push(Object.freeze({ path: record.path, sha256: record.sha256, size: record.size as number }))
  }
  const identity = manifest.gitIdentity as GitIdentity
  if (identity.topLevel !== manifest.canonicalRoot) return fail("repo_search_corrupt_manifest")
  return Object.freeze({
    schema: 1,
    approved: true,
    generationId: manifest.generationId,
    canonicalRoot: manifest.canonicalRoot,
    rootDev: manifest.rootDev,
    rootIno: manifest.rootIno,
    gitIdentity: identity,
    roots: Object.freeze(roots),
    files: Object.freeze(files),
    sourceFingerprint: manifest.sourceFingerprint,
    policyFingerprint: manifest.policyFingerprint,
    bridgeFingerprint: manifest.bridgeFingerprint,
    runtimeFingerprint: manifest.runtimeFingerprint,
    graphSha256: manifest.graphSha256,
    graphSize: manifest.graphSize as number,
    createdAt: manifest.createdAt,
  })
}

function parseManifest(bytes: Buffer): RepoSearchManifest {
  let value: unknown
  try { value = JSON.parse(bytes.toString("utf8")) } catch { return fail("repo_search_corrupt_manifest") }
  const manifest = validateManifest(value)
  if (JSON.stringify(manifest) !== bytes.toString("utf8")) fail("repo_search_corrupt_manifest")
  return manifest
}

function parseStoreFile(path: string, mode: 0o400 | 0o600, limit: number): Buffer {
  try { return readPrivateFile(path, mode, limit) } catch (error) {
    if (errorCode(error) === "ENOENT" || (error instanceof Error && error.message === "repo_search_store_missing")) fail("repo_search_missing_artifact")
    throw error
  }
}

function inspectCurrentIndex(worktree: string, storageRoot = DEFAULT_REPO_SEARCH_STORAGE_ROOT): LoadedIndex {
  const identity = inspectRepoIdentity(worktree)
  const { entry } = ensureStoreDirectories(identity.canonicalRoot, storageRoot, false)
  const currentPath = join(entry, "current.json")
  const activeBytes = parseStoreFile(currentPath, 0o600, MAX_MANIFEST_BYTES)
  const manifest = parseManifest(activeBytes)
  if (manifest.canonicalRoot !== identity.canonicalRoot || manifest.rootDev !== identity.rootDev || manifest.rootIno !== identity.rootIno ||
    JSON.stringify(manifest.gitIdentity) !== JSON.stringify(identity.gitIdentity)) fail("repo_search_identity_mismatch")
  if (manifest.policyFingerprint !== REPO_SEARCH_POLICY_FINGERPRINT || manifest.bridgeFingerprint !== GRAPHIFY_COMMIT) fail("repo_search_stale")
  const generationDirectory = join(entry, "generations", manifest.generationId)
  checkPrivateDirectory(generationDirectory, 0o500)
  const generationManifest = parseStoreFile(join(generationDirectory, "manifest.json"), 0o400, MAX_MANIFEST_BYTES)
  if (!generationManifest.equals(activeBytes)) fail("repo_search_corrupt_manifest")
  const graphPath = join(generationDirectory, "graph.json")
  const graph = parseStoreFile(graphPath, 0o400, MAX_GRAPH_BYTES)
  if (graph.byteLength !== manifest.graphSize) fail("repo_search_corrupt_artifact")
  const graphDigest = createHash("sha256").update(graph).digest("hex")
  if (graphDigest !== manifest.graphSha256) fail("repo_search_corrupt_artifact")
  return Object.freeze({ manifest, generationDirectory, graphPath })
}

export function repoSearchHasApprovedIndex(worktree: string, storageRoot = DEFAULT_REPO_SEARCH_STORAGE_ROOT): boolean {
  try { inspectCurrentIndex(worktree, storageRoot); return true } catch { return false }
}

function makeWritableForRemoval(path: string): void {
  let info: Stats
  try { info = lstatSync(path) } catch { return }
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) makeWritableForRemoval(join(path, name))
    chmodSync(path, 0o700)
  } else chmodSync(path, 0o600)
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

function removeTree(path: string): void {
  if (!pathExists(path)) return
  makeWritableForRemoval(path)
  rmSync(path, { recursive: true, force: true })
}

function writeSnapshot(snapshot: CorpusSnapshot, inputDirectory: string): void {
  mkdirSync(inputDirectory, 0o700)
  const directories = new Set<string>([inputDirectory])
  for (const file of snapshot.files) {
    const parts = file.path.split("/")
    const name = parts.pop()!
    let current = inputDirectory
    for (const part of parts) {
      current = join(current, part)
      if (!directories.has(current)) {
        mkdirSync(current, 0o700)
        directories.add(current)
      }
    }
    writePrivateFile(join(current, name), file.bytes, 0o400)
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) chmodSync(directory, 0o500)
}

function protectRuntimeGraph(path: string): Buffer {
  assertNoSymlinkComponents(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd, { bigint: true })
    const named = lstatSync(path, { bigint: true })
    if (!info.isFile() || info.uid !== BigInt(uid()) || info.nlink !== 1n || info.size < 0n || info.size > BigInt(MAX_GRAPH_BYTES) || !sameStat(info, named)) {
      fail("repo_search_invalid_graph")
    }
    fchmodSync(fd, 0o400)
  } finally { closeSync(fd) }
  return readPrivateFile(path, 0o400, MAX_GRAPH_BYTES)
}

function validateRuntime(runtime: GraphRuntime): void {
  if (!runtime || typeof runtime !== "object" || typeof runtime.fingerprint !== "string" || !HASH.test(runtime.fingerprint) ||
    typeof runtime.build !== "function" || typeof runtime.query !== "function") fail("repo_search_runtime_invalid")
}

export async function buildRepoSearchIndex(worktree: string, requestedRoots: readonly string[], options: BuildRepoSearchOptions): Promise<RepoSearchManifest> {
  if (!options || options.approve !== true) fail("repo_search_approval_required")
  const roots = normalizeRepoSearchRoots(requestedRoots)
  const runtime = options.runtime ?? createGraphRuntime()
  validateRuntime(runtime)
  abortIfRequested(options.signal)
  const snapshot = captureRepoCorpus(worktree, roots, options.signal)
  const initialRuntimeFingerprint = runtime.fingerprint
  const storageRoot = options.storageRoot ?? DEFAULT_REPO_SEARCH_STORAGE_ROOT
  const { entry, generations } = ensureStoreDirectories(snapshot.canonicalRoot, storageRoot, true)
  const generationId = `gen-${randomUUID().replaceAll("-", "")}`
  const staging = join(generations, `.stage-${randomUUID()}`)
  const finalDirectory = join(generations, generationId)
  mkdirSync(staging, 0o700)
  let published = false
  let activePublished = false
  try {
    const inputDirectory = join(staging, "input")
    const outputDirectory = join(staging, "output")
    writeSnapshot(snapshot, inputDirectory)
    mkdirSync(outputDirectory, 0o700)
    abortIfRequested(options.signal)
    await runtime.build(inputDirectory, outputDirectory, options.signal)
    abortIfRequested(options.signal)
    if (runtime.fingerprint !== initialRuntimeFingerprint) fail("repo_search_runtime_changed")
    const graph = protectRuntimeGraph(join(outputDirectory, "graph.json"))
    writePrivateFile(join(staging, "graph.json"), graph, 0o400)
    removeTree(outputDirectory)

    const manifest: RepoSearchManifest = Object.freeze({
      schema: 1,
      approved: true,
      generationId,
      canonicalRoot: snapshot.canonicalRoot,
      rootDev: snapshot.rootDev,
      rootIno: snapshot.rootIno,
      gitIdentity: snapshot.gitIdentity,
      roots: snapshot.roots,
      files: Object.freeze(snapshot.files.map(file => Object.freeze({ path: file.path, sha256: file.sha256, size: file.size }))),
      sourceFingerprint: snapshot.sourceFingerprint,
      policyFingerprint: REPO_SEARCH_POLICY_FINGERPRINT,
      bridgeFingerprint: GRAPHIFY_COMMIT,
      runtimeFingerprint: initialRuntimeFingerprint,
      graphSha256: createHash("sha256").update(graph).digest("hex"),
      graphSize: graph.byteLength,
      createdAt: new Date().toISOString(),
    })
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8")
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) fail("repo_search_manifest_size_limit")
    writePrivateFile(join(staging, "manifest.json"), manifestBytes, 0o400)
    renameSync(staging, finalDirectory)
    published = true
    chmodSync(finalDirectory, 0o500)
    const rechecked = captureRepoCorpus(snapshot.canonicalRoot, roots, options.signal)
    if (rechecked.sourceFingerprint !== snapshot.sourceFingerprint) fail("repo_search_stale_source")
    if (runtime.fingerprint !== initialRuntimeFingerprint) fail("repo_search_runtime_changed")
    abortIfRequested(options.signal)
    writeAtomicCurrent(join(entry, "current.json"), manifestBytes)
    activePublished = true
    return manifest
  } finally {
    if (!published) removeTree(staging)
    else if (!activePublished) {
      // The generation is immutable but unreferenced; the previous current manifest remains authoritative.
      removeTree(finalDirectory)
    }
  }
}

function sameManifestGeneration(a: RepoSearchManifest, b: RepoSearchManifest): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = ""
  let used = 0
  for (const point of value) {
    const size = Buffer.byteLength(point, "utf8")
    if (used + size > maximumBytes) break
    result += point
    used += size
  }
  return result
}

function renderHits(hits: readonly GraphHit[], provenance?: Pick<RepoSearchManifest, "generationId" | "sourceFingerprint">): string {
  const lines: string[] = []
  const identity = provenance ? `Index generation: ${provenance.generationId}; source fingerprint: ${provenance.sourceFingerprint}\n` : ""
  const prefix = `${identity}Repository state: current (source fingerprint verified before and after query).\n${UNTRUSTED_NOTICE}\n`
  const limit = MAX_REPO_SEARCH_OUTPUT_BYTES
  let used = Buffer.byteLength(prefix, "utf8")
  for (const hit of hits) {
    const display = {
      path: hit.path,
      ...(hit.line === undefined ? {} : { line: hit.line }),
      symbol: truncateUtf8(hit.symbol.replace(/[\x00-\x1f\x7f]/gu, " "), 256),
      ...(hit.relations === undefined ? {} : { relations: hit.relations.slice(0, 3).map(item => truncateUtf8(item.replace(/[\x00-\x1f\x7f]/gu, " "), 128)) }),
    }
    const line = `${JSON.stringify(display)}\n`
    const size = Buffer.byteLength(line, "utf8")
    if (used + size > limit) break
    lines.push(line)
    used += size
  }
  if (hits.length === 0) lines.push("No matching references.\n")
  return prefix + lines.join("")
}

function validateHits(value: unknown, limit: number, files: ReadonlySet<string>): GraphHit[] {
  if (!Array.isArray(value) || value.length > limit) return fail("repo_search_invalid_hits")
  const result: GraphHit[] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail("repo_search_invalid_hit")
    const hit = item as Record<string, unknown>
    if (typeof hit.path !== "string" || !files.has(hit.path) || typeof hit.symbol !== "string" || hit.symbol.length > 1024 ||
      (hit.line !== undefined && (!Number.isSafeInteger(hit.line) || (hit.line as number) < 1)) ||
      (hit.relations !== undefined && (!Array.isArray(hit.relations) || hit.relations.length > 20 || hit.relations.some(entry => typeof entry !== "string" || entry.length > 1024)))) {
      return fail("repo_search_invalid_hit")
    }
    result.push(Object.freeze({
      path: hit.path,
      symbol: hit.symbol,
      ...(hit.line === undefined ? {} : { line: hit.line as number }),
      ...(hit.relations === undefined ? {} : { relations: [...(hit.relations as string[])] }),
    }))
  }
  const output = renderHits(result)
  if (Buffer.byteLength(output, "utf8") > MAX_REPO_SEARCH_OUTPUT_BYTES) return fail("repo_search_output_limit")
  return result
}

export async function queryRepoSearch(
  worktree: string,
  runtime: GraphRuntime,
  input: { query: string; limit?: number },
  signal?: AbortSignal,
  storageRoot = DEFAULT_REPO_SEARCH_STORAGE_ROOT,
): Promise<string> {
  if (!input || typeof input.query !== "string" || input.query.trim().length === 0 || input.query.includes("\0") || Buffer.byteLength(input.query, "utf8") > 2048) {
    fail("repo_search_invalid_query")
  }
  const limit = input.limit ?? 5
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) fail("repo_search_invalid_limit")
  validateRuntime(runtime)
  abortIfRequested(signal)
  const beforeIndex = inspectCurrentIndex(worktree, storageRoot)
  if (runtime.fingerprint !== beforeIndex.manifest.runtimeFingerprint) fail("repo_search_runtime_mismatch")
  const beforeCorpus = captureRepoCorpus(worktree, beforeIndex.manifest.roots, signal)
  if (beforeCorpus.sourceFingerprint !== beforeIndex.manifest.sourceFingerprint) fail("repo_search_stale")
  let hits: unknown
  let queryFailure: unknown
  let queryFailed = false
  try { hits = await runtime.query(beforeIndex.graphPath, input.query, limit, signal) } catch (error) { queryFailure = error; queryFailed = true }

  const afterCorpus = captureRepoCorpus(worktree, beforeIndex.manifest.roots)
  if (afterCorpus.sourceFingerprint !== beforeIndex.manifest.sourceFingerprint) fail("repo_search_stale")
  const afterIndex = inspectCurrentIndex(worktree, storageRoot)
  if (!sameManifestGeneration(beforeIndex.manifest, afterIndex.manifest)) fail("repo_search_index_changed")
  abortIfRequested(signal)
  if (queryFailed) {
    if (queryFailure instanceof Error) throw queryFailure
    fail("repo_search_runtime_failed")
  }
  if (runtime.fingerprint !== beforeIndex.manifest.runtimeFingerprint) fail("repo_search_runtime_changed")
  const filePaths = new Set(beforeIndex.manifest.files.map(file => file.path))
  return renderHits(validateHits(hits, limit, filePaths), beforeIndex.manifest)
}
