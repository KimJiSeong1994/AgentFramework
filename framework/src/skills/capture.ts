import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
import { isAbsolute, relative, sep } from "node:path"
import {
  canonicalExternalTargetConsent,
  discoverSkills,
  hasExternalTargetConsent,
  openSkillRoot,
  parseSkillFrontmatter,
  PROTECTED_WORKFLOWS,
  resolveSkillRoots,
  skillDirectoryPath,
  SkillOperationAbortError,
  throwIfSkillOperationAborted,
  type ExternalTargetConsent,
} from "./roots.ts"
import type {
  LocalSkillDescriptor,
  ProtectedWorkflowDescriptor,
  SkillCapture,
  SkillClassification,
  SkillDescriptor,
  SkillDiscovery,
  SkillRoots,
  SkillSnapshotEntry,
} from "./types.ts"
import { FdDirectory, FdTree, FdTreeError, fdStatKind } from "./fd-tree.ts"

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024
const MAX_CAPTURE_ENTRIES = 20_000
const MAX_GIT_STDOUT_BYTES = 64 * 1024 * 1024
const MAX_GIT_STDERR_BYTES = 1024 * 1024
const GIT_COMMAND_TIMEOUT_MS = 15_000
const GIT_TERMINATION_GRACE_MS = 250
const CAPTURE_STATE = new WeakMap<object, Readonly<{ classification: SkillClassification; files: ReadonlyMap<string, Buffer> }>>()

export type SkillCaptureFailureReason = "refused" | "unsafe" | "race" | "external-consent-required"

export type SkillCaptureOptions = Readonly<{
  /** Canonical targets returned by an external-consent-required error; directory consent covers that subtree for capture reads only. */
  consentedExternalTargets?: readonly string[]
  signal?: AbortSignal
}>

export class SkillCaptureError extends Error {
  readonly reason: SkillCaptureFailureReason
  readonly externalTargets: readonly string[]

  constructor(reason: SkillCaptureFailureReason, message: string, externalTargets: readonly string[] = []) {
    super(message)
    this.name = "SkillCaptureError"
    this.reason = reason
    this.externalTargets = Object.freeze([...externalTargets])
  }
}

class CaptureRace extends Error {}
class CaptureUnsafe extends Error {}
class GitProcessLimitError extends Error {}
class CaptureExternalConsentRequired extends Error {
  readonly targets: readonly string[]
  constructor(targets: readonly string[]) {
    super("external symlink targets require explicit capture-read consent")
    this.targets = Object.freeze([...targets])
  }
}

type GitEntry = Readonly<{ mode: string; type: string; oid: string; stage: number }>
type GitSnapshot = Readonly<{
  root: string
  head: string
  objectFormat: "sha1" | "sha256"
  treeRaw: Buffer
  indexRaw: Buffer
  tree: ReadonlyMap<string, GitEntry>
  index: ReadonlyMap<string, readonly GitEntry[]>
  attributes: Buffer
  config: Buffer
  transforms: boolean
}>

type Group = { id: number; rootPath: string; rootGitPath?: string; directories: Set<string> }
type NodeRecord = {
  path: string
  type: "file" | "directory" | "symlink"
  mode: number
  size?: number
  linkTarget?: string
  linkIdentity?: string
  bytes?: Buffer
  sourcePath?: string
  group?: Group
  groupPath?: string
}
type TreeCapture = {
  nodes: NodeRecord[]
  fileBytes: Map<string, Buffer>
  fileModes: Map<string, number>
  groups: Group[]
  looseFiles: Array<{ sourcePath: string; bytes: Buffer; mode: number }>
  escaped: boolean
  externalTargets: readonly string[]
  assertStable: () => Promise<void>
  close: () => Promise<void>
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined
}

function relativePosix(root: string, path: string): string {
  return relative(root, path).split(sep).join("/")
}

function pathInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}

function strictUtf8(bytes: Uint8Array, description: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new CaptureUnsafe(`${description} is not valid UTF-8`)
  }
}

function canonicalName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) && name !== "none"
}

function equalsDescriptor(a: LocalSkillDescriptor, b: LocalSkillDescriptor): boolean {
  return a.identity === b.identity && a.source === b.source && a.name === b.name &&
    a.description === b.description && JSON.stringify(a.allowedTools ?? null) === JSON.stringify(b.allowedTools ?? null) &&
    a.disableModelInvocation === b.disableModelInvocation
}

function frame(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  const size = Buffer.allocUnsafe(8)
  size.writeBigUInt64BE(BigInt(bytes.byteLength))
  hash.update(size)
  hash.update(bytes)
}

function hashFile(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function manifestHash(
  source: string,
  identity: string,
  entries: readonly NodeRecord[],
  files: ReadonlyMap<string, Buffer>,
  fileModes: ReadonlyMap<string, number>,
): string {
  const hash = createHash("sha256")
  frame(hash, Buffer.from("otter-skill-capture-v1", "utf8"))
  frame(hash, Buffer.from(source, "utf8"))
  frame(hash, Buffer.from(identity, "utf8"))
  for (const entry of [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    frame(hash, Buffer.from(entry.path, "utf8"))
    frame(hash, Buffer.from(entry.type, "ascii"))
    const mode = Buffer.allocUnsafe(4)
    mode.writeUInt32BE(entry.mode >>> 0)
    frame(hash, mode)
    frame(hash, entry.linkTarget === undefined ? Buffer.alloc(0) : Buffer.from(entry.linkTarget, "utf8"))
    frame(hash, entry.linkIdentity === undefined ? Buffer.alloc(0) : Buffer.from(entry.linkIdentity, "utf8"))
  }
  for (const [path, bytes] of [...files].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    frame(hash, Buffer.from(path, "utf8"))
    const mode = Buffer.allocUnsafe(4)
    mode.writeUInt32BE((fileModes.get(path) ?? 0) >>> 0)
    frame(hash, mode)
    frame(hash, bytes)
  }
  return hash.digest("hex")
}

function makeCapture(
  descriptor: SkillDescriptor,
  classification: SkillClassification,
  entries: readonly NodeRecord[],
  files: ReadonlyMap<string, Buffer>,
  fileModes: ReadonlyMap<string, number>,
): SkillCapture {
  const publicEntries: SkillSnapshotEntry[] = entries.map((entry) => Object.freeze({
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(entry.linkTarget === undefined ? {} : { linkTarget: entry.linkTarget }),
    ...(entry.linkIdentity === undefined ? {} : { linkIdentity: entry.linkIdentity }),
  })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  const publicFiles = [...files].map(([path, bytes]) => Object.freeze({ path, mode: fileModes.get(path) ?? 0, size: bytes.byteLength, sha256: hashFile(bytes) }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  const source = descriptor.source
  const capture = Object.freeze({
    kind: "skill-capture" as const,
    descriptor,
    identity: descriptor.identity,
    source,
    name: descriptor.name,
    classification,
    contentHash: manifestHash(source, descriptor.identity, entries, files, fileModes),
    entries: Object.freeze(publicEntries),
    files: Object.freeze(publicFiles),
  }) as SkillCapture
  CAPTURE_STATE.set(capture, Object.freeze({ classification, files: new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)])) }))
  return capture
}

export function isAuthenticSkillCapture(value: unknown): value is SkillCapture {
  return typeof value === "object" && value !== null && CAPTURE_STATE.has(value)
}

/** Return a proof-derived class, never a caller-supplied `classification` field. */
export function authenticSkillClassification(value: unknown): SkillClassification | undefined {
  if (typeof value !== "object" || value === null) return undefined
  return CAPTURE_STATE.get(value)?.classification
}

export function isAuthenticCommonSkillCapture(value: unknown): value is SkillCapture {
  return authenticSkillClassification(value) === "common"
}

/** Snapshot access always returns a copy; mutating it cannot alter this capture or later reads. */
export function readCapturedFile(capture: SkillCapture, path: string): Uint8Array | undefined {
  const state = CAPTURE_STATE.get(capture)
  const bytes = state?.files.get(path)
  return bytes === undefined ? undefined : Uint8Array.from(bytes)
}

export function readCapturedSkill(capture: SkillCapture): Uint8Array | undefined {
  return readCapturedFile(capture, "SKILL.md")
}

async function runGit(cwd: string, args: readonly string[], input?: Buffer, signal?: AbortSignal): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    throwIfSkillOperationAborted(signal)
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
    for (const key of [
      "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_PREFIX",
    ]) delete env[key]
    const child = spawn("git", ["--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputSize = 0
    let errorSize = 0
    let terminationFailure: GitProcessLimitError | SkillOperationAbortError | undefined
    let processError: Error | undefined
    let streamError: Error | undefined
    let closed = false
    let escalationTimer: ReturnType<typeof setTimeout> | undefined
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let terminationStarted = false

    const removeListeners = () => {
      signal?.removeEventListener("abort", onAbort)
      child.stdout.removeListener("data", onStdout)
      child.stderr.removeListener("data", onStderr)
      child.stdin.removeListener("error", onStdinError)
      child.removeListener("error", onProcessError)
      child.removeListener("close", onClose)
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      if (escalationTimer !== undefined) clearTimeout(escalationTimer)
    }

    const terminate = (failure: GitProcessLimitError | SkillOperationAbortError) => {
      if (closed) return
      if (failure instanceof SkillOperationAbortError) terminationFailure = failure
      else if (terminationFailure === undefined) terminationFailure = failure
      if (terminationStarted) return
      terminationStarted = true
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      child.kill("SIGTERM")
      escalationTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL")
      }, GIT_TERMINATION_GRACE_MS)
    }

    const onAbort = () => terminate(new SkillOperationAbortError())
    const onStdout = (chunk: Buffer) => {
      if (terminationFailure !== undefined) return
      if (outputSize + chunk.byteLength > MAX_GIT_STDOUT_BYTES) {
        terminate(new GitProcessLimitError("Git output exceeds the capture limit"))
        return
      }
      outputSize += chunk.byteLength
      stdout.push(Buffer.from(chunk))
    }
    const onStderr = (chunk: Buffer) => {
      if (terminationFailure !== undefined) return
      if (errorSize + chunk.byteLength > MAX_GIT_STDERR_BYTES) {
        terminate(new GitProcessLimitError("Git error output exceeds the capture limit"))
        return
      }
      errorSize += chunk.byteLength
      stderr.push(Buffer.from(chunk))
    }
    const onStdinError = (error: Error) => { streamError ??= error }
    const onProcessError = (error: Error) => { processError ??= error }
    const onClose = (code: number | null, signalName: NodeJS.Signals | null) => {
      closed = true
      removeListeners()
      if (terminationFailure !== undefined) {
        reject(terminationFailure)
        return
      }
      if (processError !== undefined) {
        reject(processError)
        return
      }
      if (streamError !== undefined) {
        reject(streamError)
        return
      }
      if (code === 0) resolve(Buffer.concat(stdout))
      else {
        const error = new Error(Buffer.concat(stderr).toString("utf8").trim() || `git exited ${code ?? signalName}`) as Error & { code?: number }
        error.code = code ?? undefined
        reject(error)
      }
    }

    child.stdout.on("data", onStdout)
    child.stderr.on("data", onStderr)
    child.stdin.on("error", onStdinError)
    child.once("error", onProcessError)
    child.once("close", onClose)
    if (signal) signal.addEventListener("abort", onAbort, { once: true })
    deadlineTimer = setTimeout(() => {
      terminate(new GitProcessLimitError(`Git subprocess exceeded its ${GIT_COMMAND_TIMEOUT_MS}ms deadline`))
    }, GIT_COMMAND_TIMEOUT_MS)
    if (signal?.aborted) onAbort()
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

function nulRecords(buffer: Buffer): Buffer[] {
  if (buffer.byteLength === 0) return []
  if (buffer[buffer.byteLength - 1] !== 0) throw new CaptureUnsafe("Git returned a non-NUL-terminated manifest")
  const records: Buffer[] = []
  let start = 0
  for (let i = 0; i < buffer.byteLength; i++) {
    if (buffer[i] !== 0) continue
    records.push(buffer.subarray(start, i))
    start = i + 1
  }
  return records
}

async function waitForGitProcesses(tasks: readonly Promise<Buffer>[], signal?: AbortSignal): Promise<Buffer[]> {
  const settled = await Promise.allSettled(tasks)
  throwIfSkillOperationAborted(signal)
  const failure = settled.find((result) => result.status === "rejected" && result.reason instanceof GitProcessLimitError) ??
    settled.find((result) => result.status === "rejected")
  if (failure?.status === "rejected") throw failure.reason
  return settled.map((result) => {
    if (result.status !== "fulfilled") throw new Error("Git process settlement invariant failed")
    return result.value
  })
}

function parseTree(buffer: Buffer): Map<string, GitEntry> {
  const result = new Map<string, GitEntry>()
  for (const record of nulRecords(buffer)) {
    const tab = record.indexOf(9)
    if (tab < 0) throw new CaptureUnsafe("Git tree record has no path delimiter")
    const metadata = record.subarray(0, tab).toString("ascii").split(" ")
    if (metadata.length !== 3 || !/^[0-7]{6}$/.test(metadata[0]!) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(metadata[2]!)) {
      throw new CaptureUnsafe("Git tree record is malformed")
    }
    const path = record.subarray(tab + 1)
    const key = path.toString("base64")
    if (result.has(key)) throw new CaptureUnsafe("Git tree contains a duplicate path")
    result.set(key, { mode: metadata[0]!, type: metadata[1]!, oid: metadata[2]!, stage: 0 })
  }
  return result
}

function parseIndex(buffer: Buffer): Map<string, readonly GitEntry[]> {
  const mutable = new Map<string, GitEntry[]>()
  for (const record of nulRecords(buffer)) {
    const tab = record.indexOf(9)
    if (tab < 0) throw new CaptureUnsafe("Git index record has no path delimiter")
    const metadata = record.subarray(0, tab).toString("ascii").split(" ")
    if (metadata.length !== 3 || !/^[0-7]{6}$/.test(metadata[0]!) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(metadata[1]!) || !/^[0-3]$/.test(metadata[2]!)) {
      throw new CaptureUnsafe("Git index record is malformed")
    }
    const key = record.subarray(tab + 1).toString("base64")
    const entries = mutable.get(key) ?? []
    entries.push({ mode: metadata[0]!, type: "blob", oid: metadata[1]!, stage: Number(metadata[2]) })
    mutable.set(key, entries)
  }
  const result = new Map<string, readonly GitEntry[]>()
  for (const [key, entries] of mutable) result.set(key, Object.freeze(entries))
  return result
}

function indexMatchesHead(snapshot: Pick<GitSnapshot, "tree" | "index">): boolean {
  if (snapshot.tree.size !== snapshot.index.size) return false
  for (const [path, treeEntry] of snapshot.tree) {
    const indexed = snapshot.index.get(path)
    if (!indexed || indexed.length !== 1 || indexed[0]!.stage !== 0 ||
      indexed[0]!.mode !== treeEntry.mode || indexed[0]!.oid !== treeEntry.oid) return false
  }
  return true
}

async function optionalGitConfig(cwd: string, key: string, signal?: AbortSignal): Promise<Buffer> {
  try {
    throwIfSkillOperationAborted(signal)
    const result = await runGit(cwd, ["config", "--null", "--get", key], undefined, signal)
    throwIfSkillOperationAborted(signal)
    return result
  } catch (error) {
    if (error instanceof SkillOperationAbortError || signal?.aborted) throw new SkillOperationAbortError()
    if (typeof error === "object" && error !== null && "code" in error && Number(error.code) === 1) return Buffer.alloc(0)
    throw error
  }
}

function attributesHaveTransforms(buffer: Buffer): boolean {
  const records = nulRecords(buffer)
  for (let index = 1; index + 1 < records.length; index += 3) {
    const attribute = records[index]!.toString("ascii")
    const value = records[index + 1]!.toString("ascii")
    if (["filter", "text", "eol", "ident", "working-tree-encoding"].includes(attribute) && value !== "unspecified" && value !== "unset") return true
  }
  return false
}

async function getGitSnapshot(projectRoot: string, candidatePaths: readonly string[], signal?: AbortSignal): Promise<GitSnapshot | null> {
  try {
    throwIfSkillOperationAborted(signal)
    const [topOutput, formatOutput, headOutput, treeRaw, indexRaw] = await waitForGitProcesses([
      runGit(projectRoot, ["rev-parse", "--show-toplevel"], undefined, signal),
      runGit(projectRoot, ["rev-parse", "--show-object-format"], undefined, signal),
      runGit(projectRoot, ["rev-parse", "--verify", "HEAD"], undefined, signal),
      runGit(projectRoot, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], undefined, signal),
      runGit(projectRoot, ["ls-files", "--full-name", "--stage", "-z"], undefined, signal),
    ], signal)
    const rootOutput = strictUtf8(topOutput, "Git worktree root")
    if (!rootOutput.endsWith("\n")) return null
    const root = await realpath(rootOutput.slice(0, -1))
    throwIfSkillOperationAborted(signal)
    if (!pathInside(root, projectRoot)) return null
    const objectFormatText = strictUtf8(formatOutput, "Git object format").trim()
    if (objectFormatText !== "sha1" && objectFormatText !== "sha256") return null
    const head = strictUtf8(headOutput, "Git HEAD identity").trim()
    const tree = parseTree(treeRaw)
    const index = parseIndex(indexRaw)
    const paths = [...new Set(candidatePaths)].map((path) => Buffer.from(path, "utf8"))
    const attributeInput = Buffer.concat(paths.flatMap((path) => [path, Buffer.from([0])]))
    throwIfSkillOperationAborted(signal)
    const [workingAttributes, cachedAttributes, headAttributes, autocrlf, coreEol] = await waitForGitProcesses([
      runGit(projectRoot, ["check-attr", "--all", "-z", "--stdin"], attributeInput, signal),
      runGit(projectRoot, ["check-attr", "--cached", "--all", "-z", "--stdin"], attributeInput, signal),
      runGit(projectRoot, ["check-attr", "--source=HEAD", "--all", "-z", "--stdin"], attributeInput, signal),
      optionalGitConfig(projectRoot, "core.autocrlf", signal),
      optionalGitConfig(projectRoot, "core.eol", signal),
    ], signal)
    const attributes = Buffer.concat([workingAttributes, Buffer.from([0]), cachedAttributes, Buffer.from([0]), headAttributes])
    const autocrlfValue = autocrlf.toString("utf8").replace(/\0+$/, "").trim().toLowerCase()
    const coreEolValue = coreEol.toString("utf8").replace(/\0+$/, "").trim().toLowerCase()
    const transforms = attributesHaveTransforms(workingAttributes) || attributesHaveTransforms(cachedAttributes) ||
      attributesHaveTransforms(headAttributes) || (autocrlfValue !== "" && autocrlfValue !== "false") ||
      (coreEolValue !== "" && coreEolValue !== "lf")
    return Object.freeze({ root, head, objectFormat: objectFormatText, treeRaw, indexRaw, tree, index, attributes, config: Buffer.concat([autocrlf, Buffer.from([0]), coreEol]), transforms })
  } catch (error) {
    if (error instanceof SkillOperationAbortError || signal?.aborted) throw new SkillOperationAbortError()
    if (error instanceof GitProcessLimitError) throw error
    return null
  }
}

function sameGitIdentity(a: GitSnapshot | null, b: GitSnapshot | null): boolean {
  if (a === null || b === null) return a === b
  return a.root === b.root && a.head === b.head && a.objectFormat === b.objectFormat &&
    a.treeRaw.equals(b.treeRaw) && a.indexRaw.equals(b.indexRaw) && a.config.equals(b.config)
}

function sameGitSnapshot(a: GitSnapshot | null, b: GitSnapshot | null): boolean {
  if (a === null || b === null) return a === b
  return a.root === b.root && a.head === b.head && a.objectFormat === b.objectFormat &&
    a.treeRaw.equals(b.treeRaw) && a.indexRaw.equals(b.indexRaw) && a.attributes.equals(b.attributes) && a.config.equals(b.config)
}

function gitBlobOid(format: "sha1" | "sha256", bytes: Uint8Array): string {
  const hash = createHash(format)
  hash.update(Buffer.from(`blob ${bytes.byteLength}\0`, "ascii"))
  hash.update(bytes)
  return hash.digest("hex")
}

function gitPathKey(path: string): string | undefined {
  if (path.startsWith("../") || path === ".." || isAbsolute(path)) return undefined
  return Buffer.from(path, "utf8").toString("base64")
}

function gitModeForNode(node: NodeRecord): string | undefined {
  if (node.type === "symlink") return "120000"
  if (node.type === "file") return (node.mode & 0o111) === 0 ? "100644" : "100755"
  return undefined
}

function verifyGitLeaf(snapshot: GitSnapshot, path: string, bytes: Uint8Array, mode: string): boolean {
  const key = gitPathKey(path)
  if (key === undefined) return false
  const tree = snapshot.tree.get(key)
  const index = snapshot.index.get(key)
  return tree !== undefined && tree.type === "blob" && tree.mode === mode && tree.oid === gitBlobOid(snapshot.objectFormat, bytes) &&
    index !== undefined && index.length === 1 && index[0]!.stage === 0 && index[0]!.mode === tree.mode && index[0]!.oid === tree.oid
}

function verifyGitGroups(snapshot: GitSnapshot, tree: TreeCapture): boolean {
  if (!indexMatchesHead(snapshot) || snapshot.transforms) return false
  for (const group of tree.groups) {
    if (group.rootGitPath === undefined) return false
    const rootKey = gitPathKey(group.rootGitPath)
    if (rootKey === undefined) return false
    const rootBytes = Buffer.from(group.rootGitPath, "utf8")
    const prefix = rootBytes.byteLength === 0 ? Buffer.alloc(0) : Buffer.concat([rootBytes, Buffer.from("/")])
    const expected = new Map<string, GitEntry>()
    for (const [key, entry] of snapshot.tree) {
      const pathBytes = Buffer.from(key, "base64")
      if (!pathBytes.subarray(0, prefix.byteLength).equals(prefix)) continue
      const relativePath = pathBytes.subarray(prefix.byteLength).toString("base64")
      expected.set(relativePath, entry)
    }
    const leaves = tree.nodes.filter((node) => node.group === group && (node.type === "file" || node.type === "symlink"))
    if (leaves.length !== expected.size) return false
    const actual = new Set<string>()
    for (const node of leaves) {
      if (!node.groupPath || node.bytes === undefined) return false
      const key = Buffer.from(node.groupPath, "utf8").toString("base64")
      const entry = expected.get(key)
      const mode = gitModeForNode(node)
      if (!entry || !mode || entry.mode !== mode || entry.type !== "blob" || entry.oid !== gitBlobOid(snapshot.objectFormat, node.bytes)) return false
      actual.add(key)
    }
    if (actual.size !== expected.size) return false
    const expectedDirectories = new Set<string>([""])
    for (const key of expected.keys()) {
      let path = Buffer.from(key, "base64").toString("utf8")
      while (path.includes("/")) {
        path = path.slice(0, path.lastIndexOf("/"))
        expectedDirectories.add(path)
      }
    }
    if (group.directories.size !== expectedDirectories.size) return false
    for (const directory of group.directories) if (!expectedDirectories.has(directory === "." ? "" : directory)) return false
    for (const [key, entry] of expected) {
      const index = snapshot.index.get(Buffer.from(Buffer.concat([prefix, Buffer.from(key, "base64")])).toString("base64"))
      if (!index || index.length !== 1 || index[0]!.stage !== 0 || index[0]!.oid !== entry.oid || index[0]!.mode !== entry.mode) return false
    }
  }

  for (const node of tree.nodes) {
    if (node.group || node.sourcePath === undefined || node.type === "directory") continue
    if (node.bytes === undefined) return false
    const mode = gitModeForNode(node)
    if (!mode || !verifyGitLeaf(snapshot, node.sourcePath, node.bytes, mode)) return false
  }
  for (const file of tree.looseFiles) {
    if (!verifyGitLeaf(snapshot, file.sourcePath, file.bytes, (file.mode & 0o111) === 0 ? "100644" : "100755")) return false
  }
  return true
}

function fdSourcePath(scope: FdTree, directory: FdDirectory, name: string, projectScope: FdTree): string | undefined {
  if (scope !== projectScope) return undefined
  return directory.relativePath === "." ? name : `${directory.relativePath}/${name}`
}

function fdGitMode(mode: number): string {
  return (mode & 0o111) === 0 ? "100644" : "100755"
}

async function captureTreeFd(
  sourceScope: FdTree,
  contentScope: FdTree,
  contentRoot: FdDirectory,
  source: "project" | "home",
  projectScope: FdTree | undefined,
  externalConsent: ExternalTargetConsent,
  signal: AbortSignal | undefined,
  rootLink?: NodeRecord,
): Promise<TreeCapture> {
  throwIfSkillOperationAborted(signal)
  const nodes: NodeRecord[] = []
  const fileBytes = new Map<string, Buffer>()
  const fileModes = new Map<string, number>()
  const groups: Group[] = []
  const looseFiles: Array<{ sourcePath: string; bytes: Buffer; mode: number }> = []
  const externalTargets = new Set<string>()
  const scopes = new Set<FdTree>([sourceScope, contentScope])
  const activeDirectories = new Set<string>()
  let totalBytes = 0
  let nextGroup = 0
  let escaped = rootLink !== undefined && rootLink.linkIdentity === undefined

  if (rootLink) nodes.push(rootLink)

  const addFile = (displayPath: string, bytes: Buffer, mode: number, sourcePath?: string, group?: Group, groupPath?: string) => {
    if (fileBytes.has(displayPath)) throw new CaptureUnsafe("skill snapshot path is ambiguous")
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_CAPTURE_BYTES) throw new CaptureUnsafe("skill snapshot exceeds byte limit")
    fileBytes.set(displayPath, Buffer.from(bytes))
    fileModes.set(displayPath, mode)
    if (sourcePath !== undefined) looseFiles.push({ sourcePath, bytes: Buffer.from(bytes), mode })
    nodes.push({
      path: displayPath,
      type: "file",
      mode,
      size: bytes.byteLength,
      bytes: Buffer.from(bytes),
      ...(sourcePath === undefined ? {} : { sourcePath }),
      ...(group === undefined ? {} : { group, groupPath }),
    })
    if (nodes.length > MAX_CAPTURE_ENTRIES) throw new CaptureUnsafe("skill snapshot exceeds entry limit")
  }

  const addReadThroughLink = (displayPath: string, bytes: Buffer, mode: number) => {
    if (fileBytes.has(displayPath)) throw new CaptureUnsafe("skill snapshot path is ambiguous")
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_CAPTURE_BYTES) throw new CaptureUnsafe("skill snapshot exceeds byte limit")
    fileBytes.set(displayPath, Buffer.from(bytes))
    fileModes.set(displayPath, mode)
  }

  const addGroup = (scope: FdTree, directory: FdDirectory): Group => {
    const rootGitPath = source === "project" && scope === projectScope && directory.relativePath !== "."
      ? directory.relativePath
      : undefined
    const group: Group = {
      id: ++nextGroup,
      rootPath: directory.path,
      ...(rootGitPath === undefined ? {} : { rootGitPath }),
      directories: new Set(),
    }
    groups.push(group)
    return group
  }

  const visitDirectory = async (
    scope: FdTree,
    directory: FdDirectory,
    displayPrefix: string,
    group: Group,
    groupPath: string,
    root = false,
    addRootEntry = true,
  ): Promise<void> => {
    throwIfSkillOperationAborted(signal)
    const identity = `${directory.openedStat.dev}:${directory.openedStat.ino}`
    if (activeDirectories.has(identity)) throw new CaptureUnsafe("symlink cycle in skill tree")
    activeDirectories.add(identity)
    throwIfSkillOperationAborted(signal)
    const entries = scope.list(directory)
    if (nodes.length + entries.length > MAX_CAPTURE_ENTRIES) throw new CaptureUnsafe("skill snapshot exceeds entry limit")
    if (root && !addRootEntry) {
      nodes.push({
        path: displayPrefix ? `${displayPrefix}/` : "./",
        type: "directory",
        mode: Number(directory.openedStat.mode & 0o7777),
        ...(scope === projectScope && source === "project" ? { sourcePath: directory.relativePath } : {}),
        group,
        groupPath,
      })
    } else {
      nodes.push({
        path: root && displayPrefix === "" ? "." : displayPrefix,
        type: "directory",
        mode: Number(directory.openedStat.mode & 0o7777),
        ...(scope === projectScope && source === "project" ? { sourcePath: directory.relativePath } : {}),
        group,
        groupPath,
      })
    }
    group.directories.add(groupPath)
    if (nodes.length > MAX_CAPTURE_ENTRIES) throw new CaptureUnsafe("skill snapshot exceeds entry limit")

    for (const entry of entries) {
      throwIfSkillOperationAborted(signal)
      const { name, stat } = entry
      const displayPath = displayPrefix ? `${displayPrefix}/${name}` : name
      const sourcePath = projectScope === undefined ? undefined : fdSourcePath(scope, directory, name, projectScope)
      const kind = fdStatKind(stat)
      if (kind === "file") {
        throwIfSkillOperationAborted(signal)
        const read = scope.readFileAt(directory, entry)
        addFile(displayPath, read.bytes, Number(read.stat.mode & 0o7777), sourcePath, group, `${groupPath === "." ? "" : `${groupPath}/`}${name}`)
        continue
      }
      if (kind === "directory") {
        const child = scope.openDirectoryAt(directory, entry)
        const childGroupPath = groupPath === "." ? name : `${groupPath}/${name}`
        await visitDirectory(scope, child, displayPath, group, childGroupPath)
        continue
      }
      if (kind !== "symlink") throw new CaptureUnsafe("unsupported filesystem object in skill tree")

      throwIfSkillOperationAborted(signal)
      const resolved = scope.resolveLinkAt(directory, entry)
      const linkTarget = Buffer.from(resolved.target)
      const linkIdentity = resolved.internal ? `${source}:${resolved.relativeTarget}` : undefined
      const linkNode: NodeRecord = {
        path: displayPath,
        type: "symlink",
        mode: Number(stat.mode & 0o7777),
        size: linkTarget.byteLength,
        linkTarget: strictUtf8(linkTarget, "symlink target"),
        ...(linkIdentity === undefined ? {} : { linkIdentity }),
        bytes: linkTarget,
        ...(sourcePath === undefined ? {} : { sourcePath }),
        group,
        groupPath: `${groupPath === "." ? "" : `${groupPath}/`}${name}`,
      }
      nodes.push(linkNode)
      if (nodes.length > MAX_CAPTURE_ENTRIES) throw new CaptureUnsafe("skill snapshot exceeds entry limit")

      if (!resolved.internal && !hasExternalTargetConsent(externalConsent, resolved.canonicalTarget)) {
        escaped = true
        externalTargets.add(resolved.canonicalTarget)
        continue
      }
      if (!resolved.internal) escaped = true
      throwIfSkillOperationAborted(signal)
      const targetPath = resolved.internal
        ? resolved.relativeTarget!
        : relative("/", resolved.canonicalTarget).split(sep).join("/")
      const targetScope = resolved.internal ? scope : FdTree.openRoot("/")
      if (!resolved.internal) {
        if (scopes.size >= 16) throw new CaptureUnsafe("external directory scope limit exceeded")
        scopes.add(targetScope)
      }
      const targetStat = resolved.internal ? scope.statRelative(targetPath) : targetScope.statRelative(targetPath)
      const targetKind = fdStatKind(targetStat)
      if (targetKind === "file") {
        throwIfSkillOperationAborted(signal)
        const target = targetScope.readFileRelative(targetPath)
        const targetSourcePath = resolved.internal && targetScope === projectScope && source === "project" ? targetPath : undefined
        addReadThroughLink(displayPath, target.bytes, Number(target.stat.mode & 0o7777))
        if (targetSourcePath !== undefined) looseFiles.push({ sourcePath: targetSourcePath, bytes: Buffer.from(target.bytes), mode: Number(target.stat.mode & 0o7777) })
        if (!resolved.internal) {
          targetScope.assertStable()
          targetScope.close()
          scopes.delete(targetScope)
        }
        continue
      }
      if (targetKind !== "directory") throw new CaptureUnsafe("symlink target is not a supported file or directory")
      const targetDirectory = resolved.internal
        ? targetPath === "" ? scope.root : scope.openDirectoryRelative(targetPath)
        : targetScope.openDirectoryRelative(targetPath)
      const targetGroup = addGroup(targetScope, targetDirectory)
      const targetGroupPath = "."
      await visitDirectory(targetScope, targetDirectory, displayPath, targetGroup, targetGroupPath, true, false)
    }
    activeDirectories.delete(identity)
  }

  try {
    throwIfSkillOperationAborted(signal)
    const group = addGroup(contentScope, contentRoot)
    await visitDirectory(contentScope, contentRoot, "", group, ".", true, rootLink === undefined)
    const assertStable = async () => {
      for (const scope of scopes) scope.assertStable()
    }
    const close = async () => {
      let closeError: unknown
      for (const scope of [...scopes].reverse()) {
        try { scope.close() } catch (error) { closeError ??= error }
      }
      scopes.clear()
      if (closeError !== undefined) throw closeError
    }
    return {
      nodes,
      fileBytes,
      fileModes,
      groups,
      looseFiles,
      escaped,
      externalTargets: Object.freeze([...externalTargets].sort()),
      assertStable,
      close,
    }
  } catch (error) {
    for (const scope of [...scopes].reverse()) {
      try { scope.close() } catch {}
    }
    throw error
  }
}

function toCaptureError(error: unknown): SkillCaptureError {
  if (error instanceof SkillCaptureError) return error
  if (error instanceof GitProcessLimitError) return new SkillCaptureError("refused", error.message)
  if (error instanceof FdTreeError) {
    return new SkillCaptureError(error.reason === "race" ? "race" : "unsafe", error.message)
  }
  if (error instanceof CaptureExternalConsentRequired) {
    return new SkillCaptureError("external-consent-required", error.message, error.targets)
  }
  if (error instanceof CaptureRace) return new SkillCaptureError("race", error.message)
  if (error instanceof CaptureUnsafe) return new SkillCaptureError("unsafe", error.message)
  if (["ENOENT", "ESTALE", "EAGAIN"].includes(errorCode(error) ?? "")) {
    return new SkillCaptureError("race", "filesystem changed or became unavailable during capture")
  }
  return new SkillCaptureError("unsafe", error instanceof Error ? error.message : String(error))
}

function protectedDescriptor(name: string, identity: string): ProtectedWorkflowDescriptor | undefined {
  return PROTECTED_WORKFLOWS.find((descriptor) => descriptor.name === name && descriptor.identity === identity)
}

function makeProtectedCapture(descriptor: ProtectedWorkflowDescriptor): SkillCapture {
  const node: NodeRecord = { path: ".", type: "directory", mode: 0 }
  return makeCapture(descriptor, "common", [node], new Map(), new Map())
}

/**
 * Take a fresh byte-exact snapshot. The common classification is minted only after Git/working-tree proof;
 * it is runtime-authenticated and cannot be obtained by mutating a public capture value.
 */
export async function captureSkill(
  roots: SkillRoots,
  requested: SkillDescriptor,
  options: SkillCaptureOptions = {},
): Promise<SkillCapture> {
  throwIfSkillOperationAborted(options.signal)
  if (requested.kind === "protected-workflow") {
    const builtIn = protectedDescriptor(requested.name, requested.identity)
    if (!builtIn) throw new SkillCaptureError("refused", "unknown protected workflow descriptor")
    return makeProtectedCapture(builtIn)
  }
  if (requested.kind !== "skill" || !canonicalName(requested.name)) throw new SkillCaptureError("refused", "invalid skill descriptor")
  try {
    throwIfSkillOperationAborted(options.signal)
    roots = await resolveSkillRoots(roots)
    throwIfSkillOperationAborted(options.signal)
  } catch (error) {
    if (error instanceof SkillOperationAbortError || options.signal?.aborted) throw new SkillOperationAbortError()
    throw new SkillCaptureError("unsafe", error instanceof Error ? error.message : String(error))
  }
  let consentedExternalTargets: ExternalTargetConsent
  try {
    consentedExternalTargets = await canonicalExternalTargetConsent(options.consentedExternalTargets, options.signal)
    throwIfSkillOperationAborted(options.signal)
  } catch (error) {
    if (error instanceof SkillOperationAbortError || options.signal?.aborted) throw new SkillOperationAbortError()
    throw new SkillCaptureError("refused", error instanceof Error ? error.message : String(error))
  }

  let lastRace: SkillCaptureError | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfSkillOperationAborted(options.signal)
    let discovery: SkillDiscovery
    try {
      discovery = await discoverSkills(roots, options)
      throwIfSkillOperationAborted(options.signal)
    } catch (error) {
      if (error instanceof SkillOperationAbortError || options.signal?.aborted) throw new SkillOperationAbortError()
      const converted = toCaptureError(error)
      if (converted.reason === "race" && attempt === 0) {
        lastRace = converted
        continue
      }
      if (converted.reason === "race") throw new SkillCaptureError("race", `${converted.message}; retry was exhausted`)
      throw converted
    }
    const current: SkillDescriptor | undefined = discovery.descriptors.find((descriptor) => descriptor.identity === requested.identity)
    if (!current || current.kind !== "skill" || current.name !== requested.name || current.source !== requested.source) {
      const ambiguous = discovery.refusals.some((refusal) => refusal.source === requested.source &&
        refusal.name === requested.name && refusal.reason === "ambiguous",
      )
      if (ambiguous) throw new SkillCaptureError("refused", "skill identity is ambiguous in its source tier")
      const externalRefusal = discovery.refusals.find((refusal) => refusal.source === requested.source &&
        refusal.reason === "external-consent-required" && refusal.identities.some((identity) =>
          identity === requested.identity || requested.identity.startsWith(`${identity}/`),
        ),
      )
      if (externalRefusal) {
        throw new SkillCaptureError("external-consent-required", "external descriptor targets require capture-read consent", externalRefusal.externalTargets)
      }
      const raced = discovery.refusals.some((refusal) => refusal.reason === "raced" && refusal.identities.some((identity) =>
        identity === requested.identity || requested.identity.startsWith(`${identity}/`),
      ))
      if (raced && attempt === 0) {
        lastRace = new SkillCaptureError("race", "skill descriptor changed during discovery")
        continue
      }
      if (raced) throw new SkillCaptureError("race", "skill descriptor remained unstable after retry")
      if (lastRace) throw new SkillCaptureError("race", `${lastRace.message}; retry could not reacquire the descriptor`)
      throw new SkillCaptureError("refused", "skill descriptor is no longer discoverable")
    }
    const path = skillDirectoryPath(roots, current)
    let tree: TreeCapture | undefined
    let sourceScope: FdTree | undefined
    let detachedContentScope: FdTree | undefined
    try {
      throwIfSkillOperationAborted(options.signal)
      const boundary = current.source === "home" ? roots.homeDirectory : roots.projectRoot
      if (!boundary) throw new CaptureUnsafe("home skill root is unavailable")
      sourceScope = openSkillRoot(roots, current.source)
      if (!sourceScope) throw new CaptureUnsafe("home skill root is unavailable")
      throwIfSkillOperationAborted(options.signal)
      sourceScope.assertStable()
      throwIfSkillOperationAborted(options.signal)
      throwIfSkillOperationAborted(options.signal)
      const gitBefore = current.source === "project" ? await getGitSnapshot(roots.projectRoot, [], options.signal) : null
      throwIfSkillOperationAborted(options.signal)
      sourceScope.assertStable()
      const gitRoot = gitBefore?.root
      const relativeSkill = relative(boundary, path).split(sep).join("/")
      if (!relativeSkill || relativeSkill === "." || relativeSkill.startsWith("../") || relativeSkill === "..") {
        throw new CaptureUnsafe("skill path is outside its trusted source root")
      }
      const pathComponents = relativeSkill.split("/")
      const name = pathComponents.pop()!
      const parentPath = pathComponents.join("/")
      const parentDirectory = sourceScope.openDirectoryRelative(parentPath)
      const rootStat = sourceScope.statAt(parentDirectory, name)
      let contentScope = sourceScope
      let contentRoot: FdDirectory
      let rootLink: NodeRecord | undefined
      const rootKind = fdStatKind(rootStat)
      if (rootKind === "directory") {
        contentRoot = sourceScope.openDirectoryAt(parentDirectory, name)
      } else if (rootKind === "symlink") {
        throwIfSkillOperationAborted(options.signal)
        const resolved = sourceScope.resolveLinkAt(parentDirectory, name)
        const target = Buffer.from(resolved.target)
        const gitSourcePath = current.source === "project" && gitRoot && pathInside(gitRoot, path)
          ? relativePosix(gitRoot, path)
          : undefined
        rootLink = {
          path: ".",
          type: "symlink",
          mode: Number(rootStat.mode & 0o7777),
          size: target.byteLength,
          linkTarget: strictUtf8(target, "skill root symlink target"),
          ...(resolved.internal ? { linkIdentity: `${current.source}:${resolved.relativeTarget}` } : {}),
          bytes: target,
          ...(gitSourcePath === undefined ? {} : { sourcePath: gitSourcePath }),
        }
        if (!resolved.internal) {
          if (!hasExternalTargetConsent(consentedExternalTargets, resolved.canonicalTarget)) {
            throw new CaptureExternalConsentRequired([resolved.canonicalTarget])
          }
          throwIfSkillOperationAborted(options.signal)
          detachedContentScope = FdTree.openRoot(resolved.canonicalTarget)
          contentScope = detachedContentScope
          contentRoot = detachedContentScope.root
        } else {
          const targetStat = sourceScope.statRelative(resolved.relativeTarget!)
          if (fdStatKind(targetStat) !== "directory") throw new CaptureUnsafe("skill root link does not target a directory")
          contentRoot = resolved.relativeTarget === "" ? sourceScope.root : sourceScope.openDirectoryRelative(resolved.relativeTarget!)
        }
      } else throw new CaptureUnsafe("skill descriptor path is not a directory")
      const projectScope = current.source === "project" ? sourceScope : undefined
      throwIfSkillOperationAborted(options.signal)
      tree = await captureTreeFd(sourceScope, contentScope, contentRoot, current.source, projectScope, consentedExternalTargets, options.signal, rootLink)
      throwIfSkillOperationAborted(options.signal)
      detachedContentScope = undefined
      sourceScope = undefined
      await tree.assertStable()
      throwIfSkillOperationAborted(options.signal)
      if (tree.externalTargets.length > 0) {
        throw new CaptureExternalConsentRequired(tree.externalTargets)
      }
      const descriptorBytes = tree.fileBytes.get("SKILL.md")
      if (!descriptorBytes) throw new CaptureUnsafe("SKILL.md is not a captured regular file")
      const metadata = parseSkillFrontmatter(descriptorBytes, current.name)
      const capturedDescriptor: LocalSkillDescriptor = Object.freeze({
        kind: "skill",
        source: current.source,
        identity: current.identity,
        name: current.name,
        description: metadata.description,
        ...(metadata.allowedTools === undefined ? {} : { allowedTools: metadata.allowedTools }),
        ...(metadata.disableModelInvocation ? { disableModelInvocation: true as const } : {}),
      })
      if (!equalsDescriptor(current, capturedDescriptor)) throw new CaptureRace("skill metadata changed during capture")

      await tree.assertStable()
      throwIfSkillOperationAborted(options.signal)
      const afterDiscovery = await discoverSkills(roots, options)
      throwIfSkillOperationAborted(options.signal)
      const afterDescriptor = afterDiscovery.descriptors.find((descriptor) => descriptor.identity === current.identity)
      if (!afterDescriptor || afterDescriptor.kind !== "skill" || !equalsDescriptor(capturedDescriptor, afterDescriptor)) {
        throw new CaptureRace("skill descriptor or root priority changed during capture")
      }
      const candidatePaths = tree.nodes.flatMap((node) => node.sourcePath === undefined ? [] : [node.sourcePath])
      candidatePaths.push(...tree.looseFiles.map((file) => file.sourcePath))
      const gitProofBefore = current.source === "project" ? await getGitSnapshot(roots.projectRoot, candidatePaths, options.signal) : null
      throwIfSkillOperationAborted(options.signal)
      if (current.source === "project" && !sameGitIdentity(gitBefore, gitProofBefore)) {
        throw new CaptureRace("Git HEAD, index, or object tree changed during capture")
      }
      await tree.assertStable()
      throwIfSkillOperationAborted(options.signal)
      const gitAfter = current.source === "project" ? await getGitSnapshot(roots.projectRoot, candidatePaths, options.signal) : null
      throwIfSkillOperationAborted(options.signal)
      if (current.source === "project" && !sameGitSnapshot(gitProofBefore, gitAfter)) {
        throw new CaptureRace("Git HEAD, index, attributes, or object tree changed during capture")
      }
      const gitCommon = current.source === "project" && gitBefore !== null && gitProofBefore !== null && gitAfter !== null &&
        verifyGitGroups(gitAfter, tree) && !tree.escaped
      await tree.assertStable()
      const capturedNodes = tree.nodes
      const capturedFiles = new Map(tree.fileBytes)
      const capturedFileModes = new Map(tree.fileModes)
      await tree.close()
      tree = undefined
      throwIfSkillOperationAborted(options.signal)
      return makeCapture(capturedDescriptor, gitCommon ? "common" : "custom", capturedNodes, capturedFiles, capturedFileModes)
    } catch (error) {
      let cleanupError: unknown
      if (tree) {
        try { await tree.close() } catch (closeError) { cleanupError = closeError }
      }
      else {
        try { detachedContentScope?.close() } catch (closeError) { cleanupError = closeError }
        try { sourceScope?.close() } catch (closeError) { cleanupError ??= closeError }
      }
      if (error instanceof SkillOperationAbortError || options.signal?.aborted) throw new SkillOperationAbortError()
      if (cleanupError !== undefined) throw cleanupError
      const converted = toCaptureError(error)
      if (converted.reason === "race" && attempt === 0) {
        lastRace = converted
        continue
      }
      if (converted.reason === "race") throw new SkillCaptureError("race", `${converted.message}; retry was exhausted`)
      throw converted
    }
  }
  throw lastRace ?? new SkillCaptureError("race", "skill capture retry was exhausted")
}

/** Always recaptures the current descriptor; `unchanged` includes provenance class as well as the manifest hash. */
export async function revalidateSkillCapture(
  roots: SkillRoots,
  previous: SkillCapture,
  options: SkillCaptureOptions = {},
): Promise<Readonly<{ capture: SkillCapture; unchanged: boolean }>> {
  throwIfSkillOperationAborted(options.signal)
  if (!isAuthenticSkillCapture(previous)) throw new SkillCaptureError("refused", "cannot revalidate an unauthenticated skill capture")
  const capture = await captureSkill(roots, previous.descriptor, options)
  throwIfSkillOperationAborted(options.signal)
  const unchanged = previous.contentHash === capture.contentHash &&
    authenticSkillClassification(previous) === authenticSkillClassification(capture)
  return Object.freeze({ capture, unchanged })
}

