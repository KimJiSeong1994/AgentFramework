import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
  type BigIntStats,
} from "node:fs"
import { performance } from "node:perf_hooks"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { EXECUTION_ROLES, roleAllowsCliWrites, type ExecutionRole } from "./types.ts"
import { FdTree, fdStatKind, type FdDirectory, type FdEntry } from "../skills/fd-tree.ts"
import type { OtterConfig } from "../config.ts"
import { memoryToolText } from "../wiki/recall.ts"

export const CLI_TOOL_NAMES = ["read", "list", "glob", "grep", "memory", "write", "edit"] as const
export type CliToolName = (typeof CLI_TOOL_NAMES)[number]

export type CliToolOutput = { ok: true; text: string } | { ok: false; error: string }

export class CliToolInputError extends Error {
  constructor() {
    super("invalid Otter file tool input")
    this.name = "CliToolInputError"
  }
}

export type CliToolsOptions = {
  root: string
  role: ExecutionRole
  allowed: readonly string[]
  denied: readonly string[]
  beforeEffect?: () => void
}

export type CliTools = {
  readonly available: readonly CliToolName[]
  validate(name: string, input: unknown): boolean
  execute(name: string, input: unknown): CliToolOutput
  /** `memory` is the one asynchronous tool (local Jev inference); `execute` refuses it. */
  recall(input: unknown, memory: OtterConfig["memory"] | undefined, signal: AbortSignal, prefetchSession?: string): Promise<CliToolOutput>
}

const MAX_READ_BYTES = 1024 * 1024
const MAX_WRITE_BYTES = 64 * 1024
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024
const MAX_TRAVERSED_ENTRIES = 10_000
const MAX_DIRECTORY_DEPTH = 16
const MAX_RESULTS = 200
const MAX_GREP_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_GREP_DURATION_MS = 1000
const MAX_IGNORE_RULES = 1000
const MAX_GREP_FILE_BYTES = 256 * 1024
// Darwin's O_NOFOLLOW_ANY is intentionally used without constants.O_NOFOLLOW.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000
const PROTECTED_DIRECTORIES = new Set([".git", ".otter", ".gjc"])
const IGNORED_DIRECTORIES = new Set([
  ...PROTECTED_DIRECTORIES,
  "node_modules", ".cache", ".turbo", ".next", "dist", "build", "coverage",
  "__pycache__", ".venv", "venv",
])
const CREDENTIAL_DIRECTORIES = new Set([".ssh", ".aws", ".azure", ".gnupg", ".docker", ".kube", "secrets", "credentials"])
const CREDENTIAL_FILES = new Set([
  ".npmrc", ".pypirc", ".netrc", ".htpasswd", "credentials", "credentials.json", "auth.json", "token.json",
  "authorized_keys", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
])

type IgnoreRule = { base: string; pattern: string; negate: boolean; directoryOnly: boolean; matcher: Bun.Glob }
type WalkEntry = { path: string; directory: boolean }
type ScanResult = { entries: WalkEntry[]; partial: boolean }
type RootIdentity = { dev: bigint; ino: bigint }

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key)) &&
    keys.every(key => required.includes(key) || optional.includes(key)) &&
    keys.length === new Set(keys).size
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes && !value.includes("\0")
}

export function validateCliToolInput(name: string, input: unknown): asserts input is Record<string, unknown> {
  if (!record(input)) throw new CliToolInputError()
  const path = (value: unknown): value is string => typeof value === "string" && value.length > 0 && boundedString(value, 2048)
  switch (name) {
    case "read":
      if (!hasExactKeys(input, ["path"], ["startLine", "maxLines"]) || !path(input.path) ||
          (input.startLine !== undefined && (!Number.isSafeInteger(input.startLine) || (input.startLine as number) < 1)) ||
          (input.maxLines !== undefined && (!Number.isSafeInteger(input.maxLines) || (input.maxLines as number) < 1 || (input.maxLines as number) > 2000))) {
        throw new CliToolInputError()
      }
      return
    case "list":
      if (!hasExactKeys(input, [], ["path"]) || (input.path !== undefined && !path(input.path))) throw new CliToolInputError()
      return
    case "glob":
      if (!hasExactKeys(input, ["pattern"]) || !boundedString(input.pattern, 1024) || input.pattern.length === 0) throw new CliToolInputError()
      return
    case "grep":
      if (!hasExactKeys(input, ["pattern"], ["path"]) || !boundedString(input.pattern, 1024) || input.pattern.length === 0 ||
          (input.path !== undefined && !path(input.path))) throw new CliToolInputError()
      return
    case "memory":
      if (!hasExactKeys(input, ["query"]) || typeof input.query !== "string" || input.query.includes("\0") ||
          !input.query.trim() || input.query.length > 2000) throw new CliToolInputError()
      return
    case "write":
      if (!hasExactKeys(input, ["path", "content"]) || !path(input.path) || !boundedString(input.content, MAX_WRITE_BYTES)) throw new CliToolInputError()
      return
    case "edit":
      if (!hasExactKeys(input, ["path", "oldText", "newText"]) || !path(input.path) ||
          !boundedString(input.oldText, MAX_WRITE_BYTES) || input.oldText.length === 0 ||
          !boundedString(input.newText, MAX_WRITE_BYTES)) throw new CliToolInputError()
      return
    default:
      throw new CliToolInputError()
  }
}

function normalizeToolPath(input: string): string {
  if (!input || input.startsWith("/") || input.startsWith("\\") || /^[A-Za-z]:/.test(input) || isAbsolute(input)) {
    throw new Error("path")
  }
  const segments = input.replaceAll("\\", "/").split("/")
  if (segments.some(segment => segment === ".." || segment.includes("\0"))) throw new Error("path")
  const normalized = segments.filter(segment => segment !== "" && segment !== ".").join("/")
  if (isProtectedOrCredentialPath(normalized)) throw new Error("protected")
  return normalized
}

function isProtectedOrCredentialPath(path: string): boolean {
  const segments = path.split(/[\\/]+/).filter(Boolean).map(part => part.toLowerCase())
  if (segments.some(part => IGNORED_DIRECTORIES.has(part) || CREDENTIAL_DIRECTORIES.has(part))) return true
  const file = segments.at(-1) ?? ""
  return CREDENTIAL_FILES.has(file) || /^\.env(?:\.|$)/i.test(file) ||
    /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/i.test(file) ||
    /(?:^|[._-])(?:private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token)(?:[._-]|$)/i.test(file) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i.test(file) ||
    /\.(?:pem|key|p12|pfx|p7b|p7c|jks|keystore)$/i.test(file)
}

function assertSupportedPlatform(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("platform")
}

function noFollowFlags(flags: number): number {
  return flags | (process.platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : constants.O_NOFOLLOW)
}

function directoryOpenFlags(): number {
  return constants.O_RDONLY | constants.O_DIRECTORY | noFollowFlags(0)
}

function sameRoot(stat: BigIntStats, identity: RootIdentity): boolean {
  return stat.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino
}

function openRootDirectory(root: string, identity?: RootIdentity): number {
  assertSupportedPlatform()
  if (process.platform === "darwin") {
    const fd = openSync(root, directoryOpenFlags())
    try {
      if (identity && !sameRoot(fstatSync(fd, { bigint: true }), identity)) throw new Error("root")
      return fd
    } catch (error) {
      closeSync(fd)
      throw error
    }
  }

  // Linux walks from a root descriptor; missing procfs must fail closed.
  let fd = openSync(sep, directoryOpenFlags())
  try {
    for (const part of root.split(sep).filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, directoryOpenFlags())
      const previous = fd
      fd = next
      closeSync(previous)
    }
    if (identity && !sameRoot(fstatSync(fd, { bigint: true }), identity)) throw new Error("root")
    return fd
  } catch (error) {
    try { closeSync(fd) } catch { /* descriptor was already closed */ }
    throw error
  }
}

function openScopedTarget(
  root: string,
  relativePath: string,
  flags: number,
  identity: RootIdentity,
  mode?: number,
  beforeOpen?: () => void,
): number {
  if (isProtectedOrCredentialPath(relativePath)) throw new Error("protected")
  assertSupportedPlatform()
  if (process.platform === "darwin") {
    assertRootIdentity(root, identity)
    beforeOpen?.()
    const target = relativePath ? join(root, relativePath) : root
    return mode === undefined
      ? openSync(target, noFollowFlags(flags))
      : openSync(target, noFollowFlags(flags), mode)
  }

  let parentFd = openRootDirectory(root, identity)
  const parts = relativePath.split("/").filter(Boolean)
  try {
    if (parts.length === 0) {
      const fd = parentFd
      parentFd = -1
      return fd
    }
    for (const part of parts.slice(0, -1)) {
      const next = openSync(`/proc/self/fd/${parentFd}/${part}`, directoryOpenFlags())
      const previous = parentFd
      parentFd = next
      closeSync(previous)
    }
    beforeOpen?.()
    const target = `/proc/self/fd/${parentFd}/${parts.at(-1)!}`
    return mode === undefined
      ? openSync(target, noFollowFlags(flags))
      : openSync(target, noFollowFlags(flags), mode)
  } finally {
    if (parentFd >= 0) {
      try { closeSync(parentFd) } catch { /* descriptor was already closed */ }
    }
  }
}

function assertRootIdentity(root: string, identity: RootIdentity): void {
  const fd = openRootDirectory(root, identity)
  try {
    if (!sameRoot(fstatSync(fd, { bigint: true }), identity)) throw new Error("root")
  } finally {
    closeSync(fd)
  }
}

function checkedDirectoryPath(root: string, relativePath: string, identity: RootIdentity): string {
  const fd = openScopedTarget(
    root,
    relativePath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_DIRECTORY,
    identity,
  )
  try {
    if (!fstatSync(fd).isDirectory()) throw new Error("type")
  } finally {
    closeSync(fd)
  }
  return resolve(root, relativePath || ".")
}

function readDescriptor(fd: number, maximum: number, probeExtraByte = true): Buffer {
  const stat = fstatSync(fd)
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("type")
  if (stat.size > maximum) throw new Error("size")
  const output = Buffer.allocUnsafe(maximum + (probeExtraByte ? 1 : 0))
  let used = 0
  while (used < output.byteLength) {
    const count = readSync(fd, output, used, output.byteLength - used, used)
    if (count === 0) break
    used += count
  }
  if (probeExtraByte && used > maximum) throw new Error("size")
  if (fstatSync(fd).size > maximum) throw new Error("size")
  return output.subarray(0, used)
}

function readTarget(
  root: string,
  relativePath: string,
  identity: RootIdentity,
  maximum = MAX_READ_BYTES,
  probeExtraByte = true,
): Buffer {
  const fd = openScopedTarget(root, relativePath, constants.O_RDONLY | constants.O_NONBLOCK, identity)
  try {
    if (!fstatSync(fd).isFile()) throw new Error("type")
    return readDescriptor(fd, maximum, probeExtraByte)
  } finally {
    closeSync(fd)
  }
}

function safeOutput(value: string, partial = false): string {
  const data = Buffer.from(value, "utf8")
  let suffix = partial ? "\n[partial results: a traversal, result, byte, or time limit was reached]" : ""
  if (data.byteLength + Buffer.byteLength(suffix, "utf8") <= MAX_TOOL_OUTPUT_BYTES) return `${value}${suffix}`
  suffix = `\n[tool output truncated]${suffix}`
  let end = MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength(suffix, "utf8")
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end--
  return `${data.subarray(0, end).toString("utf8")}${suffix}`
}

function publicFailure(error: unknown): CliToolOutput {
  const code = error instanceof Error ? error.message : ""
  const message = code === "protected" ? "Tool refused: protected or credential-like paths are unavailable." :
    code === "root" ? "Tool refused: worktree root changed after file tools were created." :
    code === "path" ? "Tool refused: path must be relative and remain inside the worktree." :
      code === "size" ? "Tool refused: file exceeds the local file-size limit." :
        "Tool failed: requested file or directory is unavailable."
  return { ok: false, error: message }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code
}

function writeAll(fd: number, value: string, beforeEffect?: () => void): void {
  const data = Buffer.from(value, "utf8")
  beforeEffect?.()
  ftruncateSync(fd, 0)
  let offset = 0
  while (offset < data.byteLength) {
    const count = writeSync(fd, data, offset, data.byteLength - offset, offset)
    if (count <= 0) throw new Error("write")
    offset += count
  }
  fsyncSync(fd)
}

function writeTarget(
  root: string,
  relativePath: string,
  identity: RootIdentity,
  content: string,
  oldText?: string,
  beforeEffect?: () => void,
): CliToolOutput {
  if (!relativePath) return publicFailure(new Error("path"))
  let fd: number
  let creating = false
  try {
    try {
      fd = openScopedTarget(root, relativePath, constants.O_RDWR | constants.O_NONBLOCK, identity)
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error
      if (oldText !== undefined) return { ok: false, error: "Tool refused: edit target is unavailable." }
      creating = true
      fd = openScopedTarget(
        root,
        relativePath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NONBLOCK,
        identity,
        0o600,
        beforeEffect,
      )
    }
  } catch (error) {
    return publicFailure(error)
  }

  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("type")
    if (stat.size > MAX_READ_BYTES) throw new Error("size")
    if (oldText !== undefined) {
      const current = readDescriptor(fd, MAX_READ_BYTES).toString("utf8")
      const first = current.indexOf(oldText)
      if (first < 0 || current.indexOf(oldText, first + oldText.length) >= 0) {
        return { ok: false, error: "Tool refused: edit text must match exactly once." }
      }
      const replacement = current.slice(0, first) + content + current.slice(first + oldText.length)
      if (Buffer.byteLength(replacement, "utf8") > MAX_READ_BYTES) throw new Error("size")
      writeAll(fd, replacement, beforeEffect)
      return { ok: true, text: "Edited file; the exact old text occurred once." }
    }
    writeAll(fd, content, creating ? undefined : beforeEffect)
    return { ok: true, text: `${creating ? "Created" : "Wrote"} file (${Buffer.byteLength(content, "utf8")} bytes).` }
  } catch (error) {
    return publicFailure(error)
  } finally {
    closeSync(fd)
  }
}

function parseIgnoreRules(root: string, base: string, identity: RootIdentity): IgnoreRule[] {
  try {
    const ignorePath = base ? `${base}/.gitignore` : ".gitignore"
    const text = readTarget(root, ignorePath, identity, 64 * 1024).toString("utf8")
    const rules: IgnoreRule[] = []
    for (const line of text.split(/\r?\n/)) {
      if (rules.length >= MAX_IGNORE_RULES) break
      if (!line || line.startsWith("#")) continue
      let pattern = line
      let negate = false
      if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) pattern = pattern.slice(1)
      else if (pattern.startsWith("!")) { negate = true; pattern = pattern.slice(1) }
      pattern = pattern.replace(/\\ /g, " ").trimEnd()
      const directoryOnly = pattern.endsWith("/")
      pattern = pattern.replace(/^\//, "").replace(/\/$/, "")
      if (!pattern || pattern.split("/").includes("..")) continue
      try { rules.push({ base, pattern, negate, directoryOnly, matcher: new Bun.Glob(pattern) }) }
      catch { /* An invalid ignore pattern never broadens file-tool access outside the root. */ }
    }
    return rules
  } catch {
    return []
  }
}

function ruleMatches(rule: IgnoreRule, relativePath: string, directory: boolean): boolean {
  const local = rule.base ? relative(rule.base, relativePath) : relativePath
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) return false
  const normalized = local.split(sep).join("/")
  const parts = normalized.split("/")
  const hasSlash = rule.pattern.includes("/")
  if (rule.directoryOnly) {
    const directories = directory ? parts.length : parts.length - 1
    for (let count = 1; count <= directories; count++) {
      const candidate = parts.slice(0, count).join("/")
      if (hasSlash ? rule.matcher.match(candidate) : rule.matcher.match(parts[count - 1]!)) return true
    }
    return false
  }
  if (hasSlash) return rule.matcher.match(normalized)
  return parts.some(part => rule.matcher.match(part))
}

function shouldIgnore(path: string, directory: boolean, rules: readonly IgnoreRule[]): boolean {
  const segments = path.split(/[\\/]+/).filter(Boolean)
  if (segments.some(part => IGNORED_DIRECTORIES.has(part.toLowerCase()) || CREDENTIAL_DIRECTORIES.has(part.toLowerCase()))) return true
  if (isProtectedOrCredentialPath(path)) return true
  let ignored = false
  for (const rule of rules) if (ruleMatches(rule, path, directory)) ignored = !rule.negate
  return ignored
}

function rulesForDirectory(root: string, relativeDirectory: string, identity: RootIdentity): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  let relativePath = ""
  rules.push(...parseIgnoreRules(root, relativePath, identity))
  for (const part of relativeDirectory.split("/").filter(part => part && part !== ".")) {
    relativePath = relativePath ? `${relativePath}/${part}` : part
    rules.push(...parseIgnoreRules(root, relativePath, identity))
  }
  return rules
}

function ignoredTarget(root: string, target: string, directory: boolean, identity: RootIdentity): boolean {
  const relativePath = relative(root, target).split(sep).join("/")
  return relativePath !== "" && shouldIgnore(relativePath, directory, rulesForDirectory(root, dirname(relativePath), identity))
}

function scan(
  root: string,
  start: string,
  seedRules: readonly IgnoreRule[],
  identity: RootIdentity,
  shouldStop?: () => boolean,
): ScanResult {
  const result: WalkEntry[] = []
  let visited = 0
  let partial = false
  let tree: FdTree
  try { tree = FdTree.openRoot(root, identity) }
  catch { return { entries: result, partial: true } }

  const visit = (directory: FdDirectory, relativeDirectory: string, rules: readonly IgnoreRule[], depth: number): void => {
    if (shouldStop?.()) {
      partial = true
      return
    }
    if (depth > MAX_DIRECTORY_DEPTH) {
      partial = true
      return
    }
    const childDirectories: Array<{ entry: FdEntry; relative: string; rules: IgnoreRule[] }> = []
    try {
      for (const entry of tree.list(directory)) {
        if (shouldStop?.()) {
          partial = true
          break
        }
        if (++visited > MAX_TRAVERSED_ENTRIES) {
          partial = true
          break
        }
        const rel = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
        const kind = fdStatKind(entry.stat)
        const isDirectory = kind === "directory"
        if (!isDirectory && kind !== "file") continue
        if (shouldIgnore(rel, isDirectory, rules)) continue
        result.push({ path: rel, directory: isDirectory })
        if (isDirectory) childDirectories.push({
          entry,
          relative: rel,
          rules: [...rules, ...parseIgnoreRules(root, rel, identity)],
        })
        if (result.length >= MAX_TRAVERSED_ENTRIES) {
          partial = true
          break
        }
      }
    } catch { partial = true }
    childDirectories.sort((a, b) => a.relative.localeCompare(b.relative))
    for (const child of childDirectories) {
      if (shouldStop?.()) {
        partial = true
        break
      }
      if (visited >= MAX_TRAVERSED_ENTRIES || result.length >= MAX_TRAVERSED_ENTRIES) {
        partial = true
        break
      }
      const checkpoint = tree.checkpoint()
      try {
        const childDirectory = tree.openDirectoryAt(directory, child.entry)
        visit(childDirectory, child.relative, child.rules, depth + 1)
        tree.assertStableSince(checkpoint)
      } catch { partial = true }
      finally {
        try { tree.releaseSince(checkpoint) } catch { partial = true }
      }
    }
  }
  try {
    const startDirectory = tree.openDirectoryRelative(start)
    visit(startDirectory, start, seedRules, 0)
    tree.assertStable()
  } catch {
    partial = true
  } finally {
    try { tree.close() } catch { partial = true }
  }
  return { entries: result.sort((a, b) => a.path.localeCompare(b.path)), partial }
}

function listDirectory(root: string, relativePath: string, identity: RootIdentity): CliToolOutput {
  let tree: FdTree | undefined
  try {
    tree = FdTree.openRoot(root, identity)
    const directory = tree.openDirectoryRelative(relativePath)
    const target = resolve(root, relativePath || ".")
    const rules = rulesForDirectory(root, relativePath, identity)
    if (ignoredTarget(root, target, true, identity)) {
      return { ok: false, error: "Tool refused: ignored directory is unavailable." }
    }
    const entries: Array<{ name: string; type: "directory" | "file" }> = []
    let visited = 0
    let partial = false
    for (const entry of tree.list(directory)) {
      if (++visited > MAX_TRAVERSED_ENTRIES) {
        partial = true
        break
      }
      const kind = fdStatKind(entry.stat)
      if (kind !== "directory" && kind !== "file") continue
      if (shouldIgnore(relativePath ? `${relativePath}/${entry.name}` : entry.name, kind === "directory", rules)) continue
      entries.push({ name: entry.name, type: kind })
    }
    tree.assertStable()
    entries.sort((a, b) => a.name.localeCompare(b.name))
    partial ||= entries.length > MAX_RESULTS
    return { ok: true, text: safeOutput(JSON.stringify(entries.slice(0, MAX_RESULTS)), partial) }
  } catch (error) {
    return publicFailure(error)
  } finally {
    try { tree?.close() } catch { /* preserve the operation result */ }
  }
}

export function formatCliReadResult(bytes: Uint8Array, input: Record<string, unknown>): CliToolOutput {
  validateCliToolInput("read", input)
  if (bytes.byteLength > MAX_READ_BYTES) return publicFailure(new Error("size"))
  const contents = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")
  const start = (input.startLine as number | undefined) ?? 1
  const count = (input.maxLines as number | undefined) ?? 200
  const lines = contents.split(/\r?\n/)
  return { ok: true, text: safeOutput(lines.slice(start - 1, start - 1 + count).join("\n")) }
}

function readFileTool(root: string, input: Record<string, unknown>, identity: RootIdentity): CliToolOutput {
  try {
    const relativePath = normalizeToolPath(input.path as string)
    return formatCliReadResult(readTarget(root, relativePath, identity), input)
  } catch (error) {
    return publicFailure(error)
  }
}

function globTool(root: string, pattern: string, identity: RootIdentity): CliToolOutput {
  try {
    const normalizedPattern = normalizeToolPath(pattern)
    const matcher = new Bun.Glob(normalizedPattern)
    const scanned = scan(root, "", rulesForDirectory(root, "", identity), identity)
    const matched = scanned.entries.filter(entry => matcher.match(entry.path))
    const entries = matched
      .slice(0, MAX_RESULTS)
      .map(entry => ({ path: entry.path, type: entry.directory ? "directory" : "file" }))
    return { ok: true, text: safeOutput(JSON.stringify(entries), scanned.partial || matched.length > MAX_RESULTS) }
  } catch (error) {
    return publicFailure(error)
  }
}

function grepTool(
  root: string,
  pattern: string,
  inputPath: string,
  identity: RootIdentity,
  beforeEffect?: () => void,
): CliToolOutput {
  try {
    const startedAt = performance.now()
    const relativePath = inputPath ? normalizeToolPath(inputPath) : ""
    const target = checkedDirectoryPath(root, relativePath, identity)
    if (ignoredTarget(root, target, true, identity)) {
      return { ok: false, error: "Tool refused: ignored directory is unavailable." }
    }
    const rules = rulesForDirectory(root, relativePath, identity)
    const scanned = scan(root, relativePath, rules, identity, () => performance.now() - startedAt >= MAX_GREP_DURATION_MS)
    const files = scanned.entries.filter(entry => !entry.directory)
    const matches: Array<{ path: string; line: number; text: string }> = []
    let partial = scanned.partial
    let bytesRead = 0
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      if (matches.length >= MAX_RESULTS || bytesRead >= MAX_GREP_TOTAL_BYTES ||
          performance.now() - startedAt >= MAX_GREP_DURATION_MS) {
        partial = true
        break
      }
      beforeEffect?.()
      if (performance.now() - startedAt >= MAX_GREP_DURATION_MS) {
        partial = true
        break
      }
      const file = files[fileIndex]!
      const filePath = normalizeToolPath(file.path)
      const remainingBytes = MAX_GREP_TOTAL_BYTES - bytesRead
      const maximum = Math.min(MAX_GREP_FILE_BYTES, remainingBytes)
      let contents: Buffer
      try {
        contents = readTarget(root, filePath, identity, maximum, false)
      } catch (error) {
        if (error instanceof Error && error.message === "size") {
          partial = true
          if (remainingBytes < MAX_GREP_FILE_BYTES) break
          continue
        }
        throw error
      }
      bytesRead += contents.byteLength
      const text = contents.toString("utf8")
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length && matches.length < MAX_RESULTS; index++) {
        if (lines[index]!.includes(pattern)) matches.push({ path: file.path, line: index + 1, text: lines[index]!.slice(0, 1000) })
      }
      if (matches.length >= MAX_RESULTS) {
        partial = true
        break
      }
      if (performance.now() - startedAt >= MAX_GREP_DURATION_MS && fileIndex + 1 < files.length) {
        partial = true
        break
      }
    }
    return { ok: true, text: safeOutput(JSON.stringify(matches), partial) }
  } catch (error) {
    return publicFailure(error)
  }
}

function grepSingleFile(
  root: string,
  relativePath: string,
  pattern: string,
  identity: RootIdentity,
  beforeEffect?: () => void,
): CliToolOutput {
  try {
    const target = resolve(root, relativePath)
    if (ignoredTarget(root, target, false, identity)) return { ok: false, error: "Tool refused: ignored file is unavailable." }
    beforeEffect?.()
    let contents: Buffer
    try {
      contents = readTarget(root, relativePath, identity, MAX_GREP_FILE_BYTES)
    } catch (error) {
      if (error instanceof Error && error.message === "size") {
        return { ok: false, error: "Tool refused: file exceeds the search-size limit." }
      }
      throw error
    }
    const lines = contents.toString("utf8").split(/\r?\n/)
    const matches: Array<{ path: string; line: number; text: string }> = []
    for (let index = 0; index < lines.length && matches.length < MAX_RESULTS; index++) {
      if (lines[index]!.includes(pattern)) matches.push({ path: relativePath, line: index + 1, text: lines[index]!.slice(0, 1000) })
    }
    return { ok: true, text: safeOutput(JSON.stringify(matches), matches.length >= MAX_RESULTS) }
  } catch (error) {
    return publicFailure(error)
  }
}

function executeFileTool(
  root: string,
  name: CliToolName,
  input: Record<string, unknown>,
  identity: RootIdentity,
  beforeEffect?: () => void,
): CliToolOutput {
  switch (name) {
    case "read": return readFileTool(root, input, identity)
    case "list": return listDirectory(root, normalizeToolPath((input.path as string | undefined) ?? "."), identity)
    case "glob": return globTool(root, input.pattern as string, identity)
    case "grep": {
      const relativePath = normalizeToolPath((input.path as string | undefined) ?? ".")
      let fd: number
      try {
        fd = openScopedTarget(root, relativePath, constants.O_RDONLY | constants.O_NONBLOCK, identity)
      } catch (error) {
        return publicFailure(error)
      }
      let isFile: boolean
      let isDirectory: boolean
      try {
        const stat = fstatSync(fd)
        isFile = stat.isFile()
        isDirectory = stat.isDirectory()
      } finally { closeSync(fd) }
      if (isFile) return grepSingleFile(root, relativePath, input.pattern as string, identity, beforeEffect)
      if (isDirectory) return grepTool(root, input.pattern as string, relativePath, identity, beforeEffect)
      return publicFailure(new Error("type"))
    }
    case "memory": return { ok: false, error: "Tool refused: memory recall is asynchronous." }
    case "write": return writeTarget(root, normalizeToolPath(input.path as string), identity, input.content as string, undefined, beforeEffect)
    case "edit": return writeTarget(root, normalizeToolPath(input.path as string), identity, input.newText as string, input.oldText as string, beforeEffect)
  }
}

export function createCliTools(options: CliToolsOptions): CliTools {
  if (!options || typeof options.root !== "string" || !Array.isArray(options.allowed) || !Array.isArray(options.denied) ||
      !(EXECUTION_ROLES as readonly unknown[]).includes(options.role) ||
      (options.beforeEffect !== undefined && typeof options.beforeEffect !== "function")) {
    throw new TypeError("invalid CLI tool scope")
  }
  assertSupportedPlatform()
  let root: string
  let rootIdentity: RootIdentity
  try {
    root = realpathSync(options.root)
    const rootFd = openRootDirectory(root)
    try {
      const stat = fstatSync(rootFd, { bigint: true })
      if (!stat.isDirectory()) throw new Error("root")
      rootIdentity = { dev: stat.dev, ino: stat.ino }
    } finally {
      closeSync(rootFd)
    }
  } catch {
    throw new Error("CLI tool worktree is unavailable")
  }
  const readOnly = !roleAllowsCliWrites(options.role)
  const available = CLI_TOOL_NAMES.filter(name => options.allowed.includes(name) && !options.denied.includes(name) &&
    !(readOnly && (name === "write" || name === "edit")))
  const availableSet = new Set<string>(available)
  return {
    available: Object.freeze(available),
    validate(name, input) {
      if (!availableSet.has(name)) return false
      try {
        validateCliToolInput(name, input)
        assertRootIdentity(root, rootIdentity)
        if (name === "memory") return true
        if (name === "glob") normalizeToolPath(input.pattern as string)
        const relativePath = normalizeToolPath(name === "glob" ? "." : (input.path as string | undefined) ?? ".")
        let fd: number
        try {
          fd = openScopedTarget(root, relativePath, constants.O_RDONLY | constants.O_NONBLOCK, rootIdentity)
        } catch (error) {
          if (name !== "write" || !relativePath || !hasErrorCode(error, "ENOENT")) return false
          const parent = normalizeToolPath(dirname(relativePath))
          const parentFd = openScopedTarget(root, parent, directoryOpenFlags(), rootIdentity)
          try { return fstatSync(parentFd).isDirectory() }
          finally { closeSync(parentFd) }
        }
        try {
          const stat = fstatSync(fd)
          if (name === "list" || name === "glob") return stat.isDirectory()
          if (name === "grep") return stat.isDirectory() || stat.isFile() && stat.nlink === 1 && stat.size <= MAX_GREP_FILE_BYTES
          return stat.isFile() && stat.nlink === 1 && stat.size <= MAX_READ_BYTES
        } finally { closeSync(fd) }
      } catch { return false }
    },
    execute(name, input) {
      if (!CLI_TOOL_NAMES.includes(name as CliToolName) || !availableSet.has(name)) {
        return { ok: false, error: "Tool refused: this Otter tool is not allowed for the execution role." }
      }
      validateCliToolInput(name, input)
      try {
        assertRootIdentity(root, rootIdentity)
        return executeFileTool(root, name as CliToolName, input, rootIdentity, options.beforeEffect)
      }
      catch (error) { return publicFailure(error) }
    },
    async recall(input, memory, signal, prefetchSession) {
      if (!availableSet.has("memory")) return { ok: false, error: "Tool refused: this Otter tool is not allowed for the execution role." }
      validateCliToolInput("memory", input)
      try {
        assertRootIdentity(root, rootIdentity)
        return { ok: true, text: safeOutput(await memoryToolText(root, input.query as string, memory, signal, prefetchSession ? { prefetchSession } : {})) }
      }
      catch (error) { return publicFailure(error) }
    },
  }
}
