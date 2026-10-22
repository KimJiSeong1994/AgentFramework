import { constants } from "node:fs"
import { accessSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { TextDecoder } from "node:util"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createVendorProcess, vendorProcessEnvironment, type VendorProcessHandle, type VendorProcessResult } from "./vendor-process.ts"
import type { ExecutionCancelResult, ExecutionReconciliation } from "./types.ts"
import { CODEX_INSTRUCTIONS, CODEX_VERSION, CODEX_SUPPORTED_VERSIONS, codexProfileArgv, createCodexProfile } from "./codex-profile.ts"

export type CliEngine = "local" | "codex" | "claude"

export type CliTransportOptions = {
  engine: CliEngine
  model: string
  prompt: string
  deadlineAt: number
  maxOutputBytes: number
  onText?: (text: string) => void
}

export type CliTransportResult = {
  status: "completed" | "failed" | "cancelled" | "incomplete" | "unresolved"
  text: string
  quiescent: boolean
  error?: string
}

export type CliTransportHandle = {
  run(): Promise<CliTransportResult>
  requestCancel(reason: string, deadlineAt: number): Promise<ExecutionCancelResult>
  reconcile(): Promise<ExecutionReconciliation>
  preflight?(): Promise<{ compatible: boolean; nativePolicyHash?: string }>
}

export type CliTransportPreflight = { compatible: boolean; nativePolicyHash?: string }

const MAX_PROMPT_BYTES = 1024 * 1024
const MAX_MODEL_BYTES = 256
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024
const MAX_FRAME_BYTES = 1024 * 1024
const MAX_EXECUTION_MS = 24 * 60 * 60 * 1000
const TERM_TO_KILL_MS = 1000
const CALLBACK_CHUNK_BYTES = 16 * 1024
const CLAUDE_STOP_REASONS = new Set(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"])
const CLAUDE_RATE_LIMIT_STATUSES = new Set(["allowed", "allowed_warning", "rejected"])

const SAFE_ERRORS = {
  options: "invalid CLI transport options",
  executable: "CLI executable not found",
  executablePermissionDenied: "CLI executable permission denied",
  scratch: "safe CLI scratch directory unavailable",
  process: "native CLI process failed",
  deadline: "execution deadline elapsed",
  incomplete: "native CLI result incomplete",
  malformed: "invalid native CLI output",
  native: "native CLI reported failure",
  claudeLogin: "Claude CLI login required; run claude auth login",
  tool: "native tool activity refused",
  profile: "Codex native profile verification failed",
  profileState: "Codex private profile state verification failed",
  outputLimit: "output byte limit reached",
  callback: "output callback failed",
  cleanup: "scratch cleanup failed",
} as const

export class CliExecutableError extends Error {
  readonly reason: "not-found" | "permission-denied"

  constructor(reason: "not-found" | "permission-denied") {
    super(reason === "not-found" ? SAFE_ERRORS.executable : SAFE_ERRORS.executablePermissionDenied)
    this.name = "CliExecutableError"
    this.reason = reason
  }
}

type NativeProtocol = {
  consume(chunk: Uint8Array): void
  finish(): void
  readonly failure?: string
  readonly incomplete: boolean
  readonly outputText: string
  readonly outputLimitReached: boolean
}

type OwnedScratchDirectory = {
  path: string
  dev: number
  ino: number
}

type OwnedScratchFile = {
  path: string
  dev: number
  ino: number
}

type CodexProfile = ReturnType<typeof createCodexProfile>

type OwnedCodexScratchState = {
  root: OwnedScratchDirectory
  profile: CodexProfile
  workdir?: OwnedScratchDirectory
  catalog?: OwnedScratchFile
}

type OwnedCodexState = OwnedCodexScratchState & {
  workdir: OwnedScratchDirectory
  catalog: OwnedScratchFile
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function safeOptions(options: CliTransportOptions): CliTransportOptions {
  if (!options || typeof options !== "object" ||
      (options.engine !== "local" && options.engine !== "codex" && options.engine !== "claude") ||
      typeof options.model !== "string" || Buffer.byteLength(options.model) > MAX_MODEL_BYTES ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(options.model) ||
      typeof options.prompt !== "string" || !isWellFormedUtf16(options.prompt) || Buffer.byteLength(options.prompt, "utf8") > MAX_PROMPT_BYTES ||
      !Number.isSafeInteger(options.deadlineAt) || options.deadlineAt < 0 || options.deadlineAt - Date.now() > MAX_EXECUTION_MS ||
      !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 0 || options.maxOutputBytes > MAX_OUTPUT_BYTES ||
      (options.onText !== undefined && typeof options.onText !== "function")) {
    throw new TypeError(SAFE_ERRORS.options)
  }
  return { ...options }
}

function executableName(engine: CliEngine): string {
  switch (engine) {
    case "local": return "ollama"
    case "codex": return "codex"
    case "claude": return "claude"
  }
}

/** Whether a PATH entry may supply an engine CLI; under WSL, Windows drive mounts (/mnt/<letter>/…) never do. */
export function usablePathEntry(entry: string, wsl: boolean): boolean {
  if (entry.length === 0 || entry.includes("\0")) return false
  return !(wsl && /^\/mnt\/[a-z](?:\/|$)/iu.test(entry))
}

let wslKernel: boolean | undefined
/** Running inside WSL (Windows drives are mounted under /mnt/<letter>). */
export function insideWsl(): boolean {
  if (wslKernel === undefined) {
    try { wslKernel = process.platform === "linux" && /microsoft/iu.test(readFileSync("/proc/sys/kernel/osrelease", "utf8")) }
    catch { wslKernel = false }
  }
  return wslKernel
}

/**
 * Absolute real path of the engine CLI on PATH (the same lookup a transport run uses); throws when absent. Under WSL the
 * Windows PATH entries (/mnt/c/…) are skipped: a Windows codex/claude keeps its sign-in on the Windows side, so it would
 * report "not signed in" (or fail to start) even when the user signed in.
 */
export function findExecutable(engine: CliEngine): string {
  const pathValue = process.env.PATH
  if (typeof pathValue !== "string" || pathValue.length === 0 || pathValue.includes("\0")) {
    throw new CliExecutableError("not-found")
  }
  const name = executableName(engine)
  const wsl = insideWsl()
  let permissionDenied = false
  for (const entry of pathValue.split(delimiter)) {
    if (!usablePathEntry(entry, wsl)) continue
    try {
      const candidate = resolve(entry, name)
      if (!usablePathEntry(candidate, wsl)) continue
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      const realCandidate = realpathSync(candidate)
      if (!usablePathEntry(realCandidate, wsl)) continue
      return realCandidate
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
        permissionDenied = true
      }
      // An unavailable PATH entry is not an execution failure worth exposing.
    }
  }
  throw new CliExecutableError(permissionDenied ? "permission-denied" : "not-found")
}

/** Whether the engine's CLI is an executable file on PATH (the same lookup a transport run uses). */
export function cliExecutableAvailable(engine: CliEngine): boolean {
  try { findExecutable(engine); return true } catch { return false }
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path))
}

function sourceRoot(): string {
  let current = realpathSync(process.cwd())
  for (;;) {
    if (existsSync(join(current, ".git"))) return current
    const parent = dirname(current)
    if (parent === current) return realpathSync(process.cwd())
    current = parent
  }
}

function hasOwnedScratchIdentity(owned: OwnedScratchDirectory): boolean {
  try {
    const current = lstatSync(owned.path)
    return current.isDirectory() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino
  } catch {
    return false
  }
}

function removeOwnedScratchDirectory(owned: OwnedScratchDirectory): boolean {
  if (!hasOwnedScratchIdentity(owned)) return false
  try {
    rmSync(owned.path, { recursive: true, force: false })
    return true
  } catch {
    return false
  }
}

function removeOwnedEmptyScratchDirectory(owned: OwnedScratchDirectory): boolean {
  if (!hasOwnedScratchIdentity(owned)) return false
  try {
    if (readdirSync(owned.path).length !== 0) return false
    rmdirSync(owned.path)
    return true
  } catch {
    return false
  }
}

function hasOwnedScratchFileIdentity(owned: OwnedScratchFile): boolean {
  try {
    const current = lstatSync(owned.path)
    return current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino &&
      (current.mode & 0o777) === 0o600 && current.nlink === 1
  } catch {
    return false
  }
}

function hasPrivateScratchDirectory(owned: OwnedScratchDirectory): boolean {
  if (!hasOwnedScratchIdentity(owned)) return false
  try { return (lstatSync(owned.path).mode & 0o777) === 0o700 }
  catch { return false }
}

function profileIntegrity(profile: CodexProfile): boolean {
  return profile.version === CODEX_VERSION && profile.instructions === CODEX_INSTRUCTIONS &&
    createHash("sha256").update(profile.catalogJson, "utf8").digest("hex") === profile.catalogHash
}

function verifyOwnedCodexState(state: OwnedCodexScratchState): state is OwnedCodexState {
  if (!state.workdir || !state.catalog) return false
  if (!profileIntegrity(state.profile) || !hasPrivateScratchDirectory(state.root) || !hasPrivateScratchDirectory(state.workdir) ||
      !hasOwnedScratchFileIdentity(state.catalog) || dirname(state.workdir.path) !== state.root.path ||
      dirname(state.catalog.path) !== state.root.path) return false
  try {
    const rootNames = readdirSync(state.root.path).sort()
    const expectedNames = [state.workdir.path, state.catalog.path].map(path => path.slice(state.root.path.length + 1)).sort()
    if (rootNames.length !== expectedNames.length || rootNames.some((name, index) => name !== expectedNames[index]) ||
        readdirSync(state.workdir.path).length !== 0) return false
    const contents = readFileSync(state.catalog.path, "utf8")
    return contents === state.profile.catalogJson && createHash("sha256").update(contents, "utf8").digest("hex") === state.profile.catalogHash
  } catch {
    return false
  }
}

function removePartialCodexState(state: OwnedCodexScratchState): boolean {
  const { root, workdir, catalog, profile } = state
  if (!profileIntegrity(profile) || !hasPrivateScratchDirectory(root)) return false
  try {
    const expected = [workdir?.path, catalog?.path].filter((path): path is string => path !== undefined)
    const names = readdirSync(root.path).sort()
    const expectedNames = expected.map(path => path.slice(root.path.length + 1)).sort()
    if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) return false
    if (catalog) {
      if (!hasOwnedScratchFileIdentity(catalog) || readFileSync(catalog.path, "utf8") !== profile.catalogJson ||
          createHash("sha256").update(profile.catalogJson, "utf8").digest("hex") !== profile.catalogHash) return false
    }
    if (workdir && (!hasPrivateScratchDirectory(workdir) || readdirSync(workdir.path).length !== 0)) return false
    if (catalog) {
      unlinkSync(catalog.path)
      delete state.catalog
    }
    if (workdir) {
      rmdirSync(workdir.path)
      delete state.workdir
    }
    rmdirSync(root.path)
    return true
  } catch {
    return false
  }
}

function createOwnedCodexState(profile: CodexProfile, onOwnership: (state: OwnedCodexScratchState | undefined) => void): OwnedCodexState {
  if (!profileIntegrity(profile)) throw new Error(SAFE_ERRORS.profile)
  const root = createScratchDirectory()
  const partial: OwnedCodexScratchState = { root, profile }
  onOwnership(partial)
  try {
    if (!hasPrivateScratchDirectory(root)) throw new Error(SAFE_ERRORS.scratch)
    const workdirPath = join(root.path, "workdir")
    mkdirSync(workdirPath, { mode: 0o700 })
    const workdirStat = lstatSync(workdirPath)
    if (!workdirStat.isDirectory() || workdirStat.isSymbolicLink()) throw new Error(SAFE_ERRORS.scratch)
    partial.workdir = { path: workdirPath, dev: workdirStat.dev, ino: workdirStat.ino }
    onOwnership(partial)
    if ((workdirStat.mode & 0o777) !== 0o700) throw new Error(SAFE_ERRORS.scratch)

    const catalogPath = join(root.path, `codex-${profile.version}-catalog.json`)
    writeFileSync(catalogPath, profile.catalogJson, { flag: "wx", mode: 0o600 })
    const catalogStat = lstatSync(catalogPath)
    if (!catalogStat.isFile() || catalogStat.isSymbolicLink()) throw new Error(SAFE_ERRORS.scratch)
    partial.catalog = { path: catalogPath, dev: catalogStat.dev, ino: catalogStat.ino }
    onOwnership(partial)
    if ((catalogStat.mode & 0o777) !== 0o600 || catalogStat.nlink !== 1) throw new Error(SAFE_ERRORS.scratch)

    if (!verifyOwnedCodexState(partial)) throw new Error(SAFE_ERRORS.profileState)
    const state = partial
    return state
  } catch (error) {
    if (!removePartialCodexState(partial)) throw new Error(SAFE_ERRORS.cleanup)
    onOwnership(undefined)
    if (error instanceof Error && (error.message === SAFE_ERRORS.scratch || error.message === SAFE_ERRORS.profileState)) throw error
    throw new Error(SAFE_ERRORS.scratch)
  }
}

function createScratchDirectory(): OwnedScratchDirectory {
  let worktree: string
  try {
    worktree = sourceRoot()
  } catch {
    throw new Error(SAFE_ERRORS.scratch)
  }

  const bases = [...new Set([tmpdir(), "/tmp", "/var/tmp"])]
  for (const base of bases) {
    let canonicalBase: string
    try {
      canonicalBase = realpathSync(base)
    } catch {
      continue
    }
    if (isWithin(worktree, canonicalBase)) continue

    let directory: string
    try {
      directory = mkdtempSync(join(canonicalBase, "otter-cli-"))
    } catch {
      continue
    }

    let owned: OwnedScratchDirectory | undefined
    try {
      const created = lstatSync(directory)
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(SAFE_ERRORS.scratch)
      owned = { path: directory, dev: created.dev, ino: created.ino }
      if (isWithin(worktree, realpathSync(directory))) {
        if (!removeOwnedScratchDirectory(owned)) throw new Error(SAFE_ERRORS.cleanup)
        continue
      }
      if (!hasOwnedScratchIdentity(owned)) throw new Error(SAFE_ERRORS.cleanup)
      return owned
    } catch (error) {
      if (owned && !removeOwnedScratchDirectory(owned)) throw new Error(SAFE_ERRORS.cleanup)
      if (error instanceof Error && error.message === SAFE_ERRORS.cleanup) throw error
      throw new Error(SAFE_ERRORS.scratch)
    }
  }
  throw new Error(SAFE_ERRORS.scratch)
}

function nativeArgv(engine: CliEngine, model: string, scratch: string, codexState?: OwnedCodexState): string[] {
  if (engine === "claude") {
    return [
      "-p", "--restricted", "--safe-mode", "--tools", "", "--strict-mcp-config", "--permission-prompts", "none",
      "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands",
      "--no-chrome", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--model", model,
    ]
  }
  if (engine === "codex") {
    if (!codexState || !verifyOwnedCodexState(codexState)) throw new Error(SAFE_ERRORS.profile)
    return [
      "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
      "-C", scratch, "-m", model,
      ...codexProfileArgv(codexState.profile, scratch, codexState.catalog.path),
      "-c", "features.shell_tool=false", "-c", "features.multi_agent=false", "-c", "web_search=disabled",
      "-c", "features.view_image=false", "-c", "features.sleep_tool=false", "-c", "features.apps=false",
      "-c", "features.plugins=false", "-c", "include_environment_context=false", "-c", "project_doc_max_bytes=0",
      "-c", "mcp_servers={}", "-",
    ]
  }
  // Disable reasoning at generation time instead of hiding it. `--hidethinking` can discard the entire response when
  // a reasoning model never emits a post-thinking channel, leaving a successful Ollama process with an empty answer.
  return ["run", model, "--think=false", "--nowordwrap"]
}

function prefixByUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let usedBytes = 0
  let end = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8")
    if (usedBytes + size > maxBytes) break
    usedBytes += size
    end += character.length
  }
  return value.slice(0, end)
}

function utf8Chunk(value: string, start: number, maxBytes: number): string {
  let usedBytes = 0
  let end = start
  while (end < value.length) {
    const codePoint = value.codePointAt(end)!
    const bytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (usedBytes + bytes > maxBytes) break
    usedBytes += bytes
    end += codePoint > 0xffff ? 2 : 1
  }
  return value.slice(start, end)
}

function createNativeProtocol(options: CliTransportOptions, stopAtOutputLimit: () => void): NativeProtocol {
  const outputBlocks: Buffer[] = []
  let outputBlock = Buffer.allocUnsafe(CALLBACK_CHUNK_BYTES)
  let outputBlockUsed = 0
  let outputBytes = 0
  let outputLimitReached = false
  let failure: string | undefined
  let incomplete = false
  let frame = Buffer.alloc(0)
  let frameBytes = 0
  let terminalSeen = false
  let codexThreadSeen = false
  let codexTurnStarted = false
  let claudeSessionSeen = false
  let claudeSessionID: string | undefined
  let claudeDeltaText = ""
  let lastClaudeMessageText: string | undefined
  let localDecoder: TextDecoder | undefined

  const outputText = (): string => {
    const blocks = outputBlockUsed > 0 ? [...outputBlocks, outputBlock.subarray(0, outputBlockUsed)] : outputBlocks
    return Buffer.concat(blocks, outputBytes).toString("utf8")
  }

  const writeOutput = (value: string): void => {
    const bytes = Buffer.from(value, "utf8")
    let offset = 0
    while (offset < bytes.byteLength) {
      if (outputBlockUsed === outputBlock.byteLength) {
        outputBlocks.push(outputBlock)
        outputBlock = Buffer.allocUnsafe(CALLBACK_CHUNK_BYTES)
        outputBlockUsed = 0
      }
      const copied = Math.min(bytes.byteLength - offset, outputBlock.byteLength - outputBlockUsed)
      bytes.copy(outputBlock, outputBlockUsed, offset, offset + copied)
      outputBlockUsed += copied
      outputBytes += copied
      offset += copied
    }
  }

  const emit = (value: string): void => {
    if (value.length === 0 || outputLimitReached) return
    if (!isWellFormedUtf16(value)) fail(SAFE_ERRORS.malformed)
    const available = options.maxOutputBytes - outputBytes
    const accepted = prefixByUtf8Bytes(value, available)
    for (let offset = 0; offset < accepted.length;) {
      const chunk = utf8Chunk(accepted, offset, CALLBACK_CHUNK_BYTES)
      if (chunk.length === 0) break
      writeOutput(chunk)
      offset += chunk.length
      if (options.onText) {
        try {
          const callbackResult: unknown = options.onText(chunk)
          if ((typeof callbackResult === "object" && callbackResult !== null || typeof callbackResult === "function") &&
              typeof (callbackResult as { then?: unknown }).then === "function") {
            try { void Promise.resolve(callbackResult).catch(() => {}) } catch { /* The callback itself is already refused. */ }
            throw new Error(SAFE_ERRORS.callback)
          }
        } catch {
          failure = SAFE_ERRORS.callback
          throw new Error(SAFE_ERRORS.callback)
        }
      }
    }
    if (Buffer.byteLength(accepted, "utf8") < Buffer.byteLength(value, "utf8")) {
      outputLimitReached = true
      stopAtOutputLimit()
    }
  }

  function fail(message: string = SAFE_ERRORS.malformed): never {
    failure ??= message
    throw new Error(message)
  }

  const parseTextContent = (message: unknown): string => {
    if (!isRecord(message) || (message.role !== undefined && message.role !== "assistant") || !Array.isArray(message.content)) {
      return fail()
    }
    if (message.stop_reason === "tool_use") return fail(SAFE_ERRORS.tool)
    let text = ""
    for (const item of message.content) {
      if (!isRecord(item) || typeof item.type !== "string") return fail()
      if (item.type === "text") {
        if (typeof item.text !== "string") return fail()
        text += item.text
      } else if (item.type !== "thinking" && item.type !== "redacted_thinking") {
        return fail(SAFE_ERRORS.tool)
      }
    }
    return text
  }

  const processCodexRecord = (record: Record<string, unknown>): void => {
    const type = record.type
    if (type === "thread.started") {
      if (codexThreadSeen || typeof record.thread_id !== "string" || record.thread_id.trim().length === 0 || record.thread_id.length > 512 || record.thread_id.includes("\0")) fail()
      codexThreadSeen = true
      return
    }
    if (!codexThreadSeen) fail()
    if (terminalSeen) fail()
    if (type === "turn.started") {
      if (codexTurnStarted) fail()
      codexTurnStarted = true
      return
    }
    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      if (!codexTurnStarted) fail()
      const item = record.item
      if (!isRecord(item) || typeof item.type !== "string") fail()
      if (item.type === "reasoning") return
      if (item.type !== "agent_message") fail(SAFE_ERRORS.tool)
      if (type === "item.completed") {
        if (typeof item.text !== "string") fail()
        emit(item.text)
      }
      return
    }
    if (type === "turn.completed") {
      if (!codexTurnStarted || (record.usage !== undefined && !isRecord(record.usage))) fail()
      terminalSeen = true
      return
    }
    if (type === "turn.failed" || type === "error") {
      if (!codexTurnStarted) fail()
      failure ??= SAFE_ERRORS.native
      terminalSeen = true
      return
    }
    fail()
  }

  const processClaudeRecord = (record: Record<string, unknown>): void => {
    const type = record.type
    if (type === "system" && record.subtype === "init") {
      if (claudeSessionSeen || typeof record.session_id !== "string" || record.session_id.trim().length === 0 || record.session_id.length > 512 || record.session_id.includes("\0")) fail()
      for (const key of ["tools", "mcp_servers"]) {
        if (record[key] !== undefined && (!Array.isArray(record[key]) || record[key].length > 0)) fail(SAFE_ERRORS.tool)
      }
      if (record.plugins !== undefined) {
        // Builtins observed under --safe-mode with --tools "" (Claude CLI 2.1.301 added plugin-authoring);
        // init still must report no tools and no MCP servers, and any other plugin is refused.
        const allowedPlugins = new Set(["cc-plugin-agents-md", "cc-plugin-telemetry", "cc-plugin-plugin-authoring"])
        if (!Array.isArray(record.plugins) || record.plugins.some(plugin => {
          const name = typeof plugin === "string" ? plugin : isRecord(plugin) ? plugin.name : undefined
          return typeof name !== "string" || !allowedPlugins.has(name)
        })) fail(SAFE_ERRORS.tool)
      }
      claudeSessionSeen = true
      claudeSessionID = record.session_id
      return
    }
    if (record.parent_tool_use_id !== undefined && record.parent_tool_use_id !== null) fail(SAFE_ERRORS.tool)
    if (record.session_id !== undefined && claudeSessionSeen && record.session_id !== claudeSessionID) fail()
    if (!claudeSessionSeen || terminalSeen) fail()
    if (type === "system") {
      const isSafeCounter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      if (record.subtype !== "thinking_tokens" || !Object.hasOwn(record, "session_id") || record.session_id !== claudeSessionID ||
          !Object.hasOwn(record, "estimated_tokens") || !isSafeCounter(record.estimated_tokens) ||
          !Object.hasOwn(record, "estimated_tokens_delta") || !isSafeCounter(record.estimated_tokens_delta)) fail()
      return
    }
    if (type === "rate_limit_event") {
      if (record.session_id !== claudeSessionID || !Object.hasOwn(record, "rate_limit_info") || !isRecord(record.rate_limit_info) ||
          !Object.hasOwn(record.rate_limit_info, "status") || typeof record.rate_limit_info.status !== "string" ||
          !CLAUDE_RATE_LIMIT_STATUSES.has(record.rate_limit_info.status)) fail()
      return
    }
    if (type === "stream_event") {
      if (!isRecord(record.event) || typeof record.event.type !== "string") fail()
      const event = record.event
      if (event.type === "message_start") {
        if (!isRecord(event.message) || event.message.type !== "message" || event.message.role !== "assistant" ||
            !Array.isArray(event.message.content) ||
            (event.message.stop_reason !== null && event.message.stop_reason !== undefined &&
              (typeof event.message.stop_reason !== "string" || !CLAUDE_STOP_REASONS.has(event.message.stop_reason)))) fail()
        if (claudeDeltaText.length > 0) fail()
        claudeDeltaText = ""
        return
      }
      if (event.type === "content_block_start") {
        if (!Number.isSafeInteger(event.index) || (event.index as number) < 0 || !isRecord(event.content_block) || typeof event.content_block.type !== "string") fail()
        const block = event.content_block
        if (block.type === "text") {
          if (typeof block.text !== "string") fail()
        } else if (block.type === "thinking") {
          if (typeof block.thinking !== "string" || (block.signature !== undefined && typeof block.signature !== "string")) fail()
        } else if (block.type === "redacted_thinking") {
          if (typeof block.data !== "string") fail()
        } else if (block.type === "tool_use" || block.type === "server_tool_use") {
          if (typeof block.id !== "string" || typeof block.name !== "string" || !isRecord(block.input)) fail()
          fail(SAFE_ERRORS.tool)
        } else if (block.type === "web_search_tool_result") {
          if (typeof block.tool_use_id !== "string" || !Array.isArray(block.content)) fail()
          fail(SAFE_ERRORS.tool)
        } else {
          fail()
        }
        return
      }
      if (event.type === "content_block_delta") {
        if (!Number.isSafeInteger(event.index) || (event.index as number) < 0 || !isRecord(event.delta) || typeof event.delta.type !== "string") fail()
        const delta = event.delta
        if (delta.type === "text_delta") {
          if (typeof delta.text !== "string") fail()
          claudeDeltaText += delta.text
          if (Buffer.byteLength(claudeDeltaText, "utf8") <= options.maxOutputBytes) emit(delta.text)
          else {
            emit(delta.text)
            claudeDeltaText = ""
          }
          return
        }
        if (delta.type === "thinking_delta") {
          if (typeof delta.thinking !== "string") fail()
          return
        }
        if (delta.type === "signature_delta") {
          if (typeof delta.signature !== "string") fail()
          return
        }
        if (delta.type === "input_json_delta") {
          if (typeof delta.partial_json !== "string") fail()
          fail(SAFE_ERRORS.tool)
        }
        if (delta.type === "citations_delta") {
          if (!isRecord(delta.citation) || typeof delta.citation.type !== "string") fail()
          if (delta.citation.type !== "char_location" && delta.citation.type !== "page_location" &&
              delta.citation.type !== "content_block_location" && delta.citation.type !== "web_search_result_location") fail()
          return
        }
        fail()
      }
      if (event.type === "message_delta") {
        if (!isRecord(event.delta)) fail()
        if (!Object.hasOwn(event.delta, "stop_reason") ||
            (event.delta.stop_reason !== null &&
            (typeof event.delta.stop_reason !== "string" || !CLAUDE_STOP_REASONS.has(event.delta.stop_reason)))) fail()
        if (event.delta.stop_reason === "tool_use") fail(SAFE_ERRORS.tool)
        if (event.delta.stop_sequence !== undefined && event.delta.stop_sequence !== null && typeof event.delta.stop_sequence !== "string") fail()
        if (event.usage !== undefined && !isRecord(event.usage)) fail()
        return
      }
      if (event.type === "content_block_stop") {
        if (!Number.isSafeInteger(event.index) || (event.index as number) < 0) fail()
        return
      }
      if (event.type === "message_stop" || event.type === "ping") return
      fail()
    }
    if (type === "assistant") {
      if (record.parent_tool_use_id !== undefined && record.parent_tool_use_id !== null) fail(SAFE_ERRORS.tool)
      const text = parseTextContent(record.message)
      if (claudeDeltaText.length > 0) {
        if (text === claudeDeltaText) {
          claudeDeltaText = ""
          lastClaudeMessageText = text
          return
        }
        if (text.startsWith(claudeDeltaText)) {
          emit(text.slice(claudeDeltaText.length))
          claudeDeltaText = ""
          lastClaudeMessageText = text
          return
        }
        fail(SAFE_ERRORS.malformed)
      }
      if (text !== lastClaudeMessageText) emit(text)
      lastClaudeMessageText = text
      return
    }
    if (type === "result") {
      if (record.subtype === "success" && record.is_error === true && record.result === "Not logged in · Please run /login") {
        failure = SAFE_ERRORS.claudeLogin
        terminalSeen = true
        return
      }
      if (record.subtype !== "success" || record.is_error !== false ||
          (record.permission_denials !== undefined && (!Array.isArray(record.permission_denials) || record.permission_denials.length !== 0)) ||
          typeof record.result !== "string") {
        failure ??= Array.isArray(record.permission_denials) && record.permission_denials.length > 0 ? SAFE_ERRORS.tool : SAFE_ERRORS.native
        terminalSeen = true
        return
      }
      const emitted = outputText()
      if (record.result === emitted || (record.result.length > 0 && emitted.endsWith(record.result))) {
        terminalSeen = true
        return
      }
      if (emitted.length === 0 || record.result.startsWith(emitted)) {
        emit(record.result.slice(emitted.length))
        terminalSeen = true
        return
      }
      fail(SAFE_ERRORS.malformed)
    }
    if (type === "error") {
      failure ??= SAFE_ERRORS.native
      terminalSeen = true
      return
    }
    fail()
  }

  const processFrame = (): void => {
    let length = frameBytes
    if (length > 0 && frame[length - 1] === 0x0d) length--
    if (length === 0) fail()
    let record: unknown
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, length))
      record = JSON.parse(text)
    } catch {
      fail()
    }
    if (!isRecord(record)) fail()
    if (options.engine === "codex") processCodexRecord(record)
    else processClaudeRecord(record)
  }

  const appendFrame = (chunk: Uint8Array, start: number, end: number): void => {
    const added = end - start
    if (frameBytes + added > MAX_FRAME_BYTES) fail()
    if (frameBytes + added > frame.byteLength) {
      const capacity = Math.min(MAX_FRAME_BYTES, Math.max(frameBytes + added, frame.byteLength === 0 ? 1024 : frame.byteLength * 2))
      const grown = Buffer.allocUnsafe(capacity)
      if (frameBytes > 0) frame.copy(grown, 0, 0, frameBytes)
      frame = grown
    }
    frame.set(chunk.subarray(start, end), frameBytes)
    frameBytes += added
  }

  if (options.engine === "local") localDecoder = new TextDecoder("utf-8", { fatal: true })

  return {
    consume(chunk): void {
      if (failure) throw new Error(failure)
      if (!(chunk instanceof Uint8Array)) fail()
      if (options.engine === "local") {
        try {
          emit(localDecoder!.decode(chunk, { stream: true }))
        } catch {
          fail(failure ?? SAFE_ERRORS.malformed)
        }
        return
      }
      try {
        let segmentStart = 0
        for (let index = 0; index < chunk.byteLength; index++) {
          if (chunk[index] !== 0x0a) continue
          appendFrame(chunk, segmentStart, index)
          processFrame()
          frameBytes = 0
          segmentStart = index + 1
        }
        appendFrame(chunk, segmentStart, chunk.byteLength)
      } catch {
        if (failure) throw new Error(failure)
        failure = SAFE_ERRORS.malformed
        throw new Error(SAFE_ERRORS.malformed)
      }
    },
    finish(): void {
      if (failure) return
      if (options.engine === "local") {
        try {
          emit(localDecoder!.decode())
        } catch {
          failure = SAFE_ERRORS.malformed
        }
        return
      }
      if (frameBytes > 0 || !terminalSeen) incomplete = true
    },
    get failure(): string | undefined { return failure },
    get incomplete(): boolean { return incomplete },
    get outputText(): string { return outputText() },
    get outputLimitReached(): boolean { return outputLimitReached },
  }
}

function validateCancel(reason: string, deadlineAt: number): void {
  if (typeof reason !== "string" || reason.length > 512 || !Number.isSafeInteger(deadlineAt) || deadlineAt < 0 || deadlineAt - Date.now() > MAX_EXECUTION_MS) {
    throw new TypeError("invalid local process cancellation request")
  }
}

function reconcileWithoutProcess(): ExecutionReconciliation {
  return { outcome: "terminal", quiescent: true, evidence: "process has not been started" }
}

function statusFromProcess(result: VendorProcessResult, protocol: NativeProtocol, runFailure?: string): CliTransportResult {
  const text = protocol.outputText
  if (!result.quiescent || result.status === "unresolved") {
    return runFailure
      ? { status: "unresolved", text, quiescent: false, error: runFailure }
      : { status: "unresolved", text, quiescent: false }
  }
  if (protocol.outputLimitReached) return { status: "incomplete", text, quiescent: true, error: SAFE_ERRORS.outputLimit }
  if (runFailure) return { status: "failed", text, quiescent: true, error: runFailure }
  if (protocol.failure) return { status: "failed", text, quiescent: true, error: protocol.failure }
  if (result.status === "timed-out") return { status: "failed", text, quiescent: true, error: SAFE_ERRORS.deadline }
  if (result.status === "cancelled") return { status: "cancelled", text, quiescent: true }
  if (result.status === "failed") return { status: "failed", text, quiescent: true, error: SAFE_ERRORS.process }
  if (result.status === "incomplete" || !result.captureComplete || protocol.incomplete) {
    return { status: "incomplete", text, quiescent: true, error: SAFE_ERRORS.incomplete }
  }
  if (result.status !== "completed") return { status: "incomplete", text, quiescent: true, error: SAFE_ERRORS.incomplete }
  return { status: "completed", text, quiescent: true }
}

type CodexProbeResult = {
  compatible: boolean
  nativePolicyHash?: string
  quiescent: boolean
  cancelled: boolean
  error?: string
}

function supportedCodexVersion(result: VendorProcessResult): boolean {
  if (result.status !== "completed" || result.code !== 0 || !result.captureComplete ||
      result.stdout.truncated || result.stderr.truncated || result.stderr.text.trim().length > 0) return false
  const output = result.stdout.text.trim()
  return CODEX_SUPPORTED_VERSIONS.some(version => output === `codex-cli ${version}`)
}

/**
 * The installed Codex CLI version (`0.163.0`), for diagnostics only: undefined when codex is missing, slow or reports
 * something else. Admission never relies on this; the owned version probe decides compatibility.
 */
export function installedCodexVersion(): string | undefined {
  let executable: string
  try { executable = findExecutable("codex") } catch { return undefined }
  try {
    const run = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, env: vendorProcessEnvironment(), stdio: ["ignore", "pipe", "ignore"] })
    const match = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*$/u.exec(typeof run.stdout === "string" ? run.stdout : "")
    return match?.[1]
  } catch { return undefined }
}

/** Creates an inert, single-use native CLI transport backed by an owned process group. */
export function createCliTransport(rawOptions: CliTransportOptions): CliTransportHandle {
  const options = safeOptions(rawOptions)
  const executable = findExecutable(options.engine)
  let codexProfile: CodexProfile | undefined
  if (options.engine === "codex") {
    try { codexProfile = createCodexProfile(options.model) }
    catch { throw new TypeError("unsupported Codex model profile") }
  }
  let runCalled = false
  let cancelledBeforeRun = false
  let processHandle: VendorProcessHandle | undefined
  let finalResult: CliTransportResult | undefined
  let scratch: OwnedScratchDirectory | undefined
  let codexState: OwnedCodexScratchState | undefined
  let probePromise: Promise<CodexProbeResult> | undefined
  let activeProcessKind: "probe" | "inference" | undefined
  let stopReason: "output-limit" | undefined

  const cleanupScratch = (): boolean => {
    if (!scratch) return true
    const removed = options.engine === "codex"
      ? codexState ? removePartialCodexState(codexState) : removeOwnedEmptyScratchDirectory(scratch)
      : removeOwnedScratchDirectory(scratch)
    if (!removed) return false
    scratch = undefined
    codexState = undefined
    return true
  }

  const runCodexVersionProbe = async (): Promise<CodexProbeResult> => {
    if (options.engine !== "codex" || !codexProfile || !profileIntegrity(codexProfile) ||
        (process.platform !== "darwin" && process.platform !== "linux")) {
      return { compatible: false, quiescent: true, cancelled: false, error: SAFE_ERRORS.profile }
    }

    if (processHandle) {
      let reconciliation: ExecutionReconciliation
      try { reconciliation = await processHandle.reconcile() }
      catch { return { compatible: false, quiescent: false, cancelled: false, error: SAFE_ERRORS.process } }
      if (!reconciliation.quiescent) return { compatible: false, quiescent: false, cancelled: false, error: SAFE_ERRORS.process }
      if (!cleanupScratch()) return { compatible: false, quiescent: true, cancelled: false, error: SAFE_ERRORS.cleanup }
      processHandle = undefined
      activeProcessKind = undefined
    }

    try { scratch = createScratchDirectory() }
    catch { return { compatible: false, quiescent: true, cancelled: false, error: SAFE_ERRORS.scratch } }
    try {
      if (!hasOwnedScratchIdentity(scratch)) throw new Error(SAFE_ERRORS.cleanup)
      processHandle = createVendorProcess({
        executable,
        argv: ["--version"],
        cwd: scratch.path,
        deadlineAt: Math.min(options.deadlineAt, Date.now() + 5000),
        maxCombinedOutputBytes: 4096,
        termToKillMs: 500,
      })
      activeProcessKind = "probe"
    } catch (error) {
      const cleaned = cleanupScratch()
      return {
        compatible: false,
        quiescent: cleaned,
        cancelled: false,
        error: cleaned ? (error instanceof Error && error.message === SAFE_ERRORS.cleanup ? SAFE_ERRORS.cleanup : SAFE_ERRORS.process) : SAFE_ERRORS.cleanup,
      }
    }

    let result: VendorProcessResult
    try { result = await processHandle.run() }
    catch {
      const reconciliation = await processHandle.reconcile().catch(() => ({ outcome: "unknown" as const, quiescent: false, evidence: "process state is unknown" }))
      if (!reconciliation.quiescent) return { compatible: false, quiescent: false, cancelled: false, error: SAFE_ERRORS.process }
      const cleaned = cleanupScratch()
      if (cleaned) { processHandle = undefined; activeProcessKind = undefined }
      return { compatible: false, quiescent: true, cancelled: false, error: cleaned ? SAFE_ERRORS.process : SAFE_ERRORS.cleanup }
    }

    if (!result.quiescent) {
      return { compatible: false, quiescent: false, cancelled: result.status === "cancelled", error: SAFE_ERRORS.process }
    }
    const versionMatches = supportedCodexVersion(result)
    if (!cleanupScratch()) return { compatible: false, quiescent: true, cancelled: result.status === "cancelled", error: SAFE_ERRORS.cleanup }
    processHandle = undefined
    activeProcessKind = undefined
    if (result.status === "cancelled") return { compatible: false, quiescent: true, cancelled: true, error: SAFE_ERRORS.process }
    if (!versionMatches) return { compatible: false, quiescent: true, cancelled: false, error: SAFE_ERRORS.profile }
    return { compatible: true, nativePolicyHash: codexProfile.catalogHash, quiescent: true, cancelled: false }
  }

  const ensureCodexVersionProbe = async (): Promise<CodexProbeResult> => {
    if (probePromise) return probePromise
    const pending = runCodexVersionProbe()
    probePromise = pending
    try { return await pending }
    finally { if (probePromise === pending) probePromise = undefined }
  }

  const stopAtOutputLimit = (): void => {
    if (stopReason || !processHandle || activeProcessKind !== "inference") return
    stopReason = "output-limit"
    const now = Date.now()
    const deadlineAt = Math.min(options.deadlineAt, now + TERM_TO_KILL_MS)
    if (deadlineAt <= now) return
    void processHandle.requestCancel("output-limit", deadlineAt).catch(() => {})
  }

  const handle: CliTransportHandle = {
    async run(): Promise<CliTransportResult> {
      if (runCalled) throw new TypeError("CLI transport is one-shot")
      runCalled = true
      if (cancelledBeforeRun) {
        finalResult = { status: "cancelled", text: "", quiescent: true }
        return finalResult
      }

      if (options.engine === "codex") {
        const probe = await ensureCodexVersionProbe()
        if (cancelledBeforeRun || probe.cancelled) {
          finalResult = { status: probe.quiescent ? "cancelled" : "unresolved", text: "", quiescent: probe.quiescent, error: probe.error }
          return finalResult
        }
        if (!probe.compatible || probe.nativePolicyHash !== codexProfile?.catalogHash) {
          finalResult = { status: probe.quiescent ? "failed" : "unresolved", text: "", quiescent: probe.quiescent, error: probe.error ?? SAFE_ERRORS.profile }
          return finalResult
        }
      }

      let protocol: NativeProtocol
      try {
        if (options.engine === "codex") {
          if (!codexProfile) throw new Error(SAFE_ERRORS.profile)
          const state = createOwnedCodexState(codexProfile, owned => {
            codexState = owned
            scratch = owned?.root
          })
          codexState = state
          scratch = state.root
          const cwd = state.workdir.path
          const argv = nativeArgv(options.engine, options.model, cwd, state)
          protocol = createNativeProtocol(options, stopAtOutputLimit)
          processHandle = createVendorProcess({
            executable,
            argv,
            cwd,
            stdin: options.prompt,
            deadlineAt: options.deadlineAt,
            maxCombinedOutputBytes: MAX_CAPTURE_BYTES,
            termToKillMs: TERM_TO_KILL_MS,
            onStdoutChunk(chunk): undefined {
              protocol.consume(chunk)
              return undefined
            },
          })
        } else {
          scratch = createScratchDirectory()
          if (!hasOwnedScratchIdentity(scratch)) throw new Error(SAFE_ERRORS.cleanup)
          const argv = nativeArgv(options.engine, options.model, scratch.path)
          protocol = createNativeProtocol(options, stopAtOutputLimit)
          processHandle = createVendorProcess({
            executable,
            argv,
            cwd: scratch.path,
            stdin: options.prompt,
            deadlineAt: options.deadlineAt,
            maxCombinedOutputBytes: MAX_CAPTURE_BYTES,
            termToKillMs: TERM_TO_KILL_MS,
            onStdoutChunk(chunk): undefined {
              protocol.consume(chunk)
              return undefined
            },
          })
        }
        activeProcessKind = "inference"
      } catch (error) {
        const cleaned = cleanupScratch()
        const setupErrors: readonly string[] = [SAFE_ERRORS.scratch, SAFE_ERRORS.profile, SAFE_ERRORS.profileState, SAFE_ERRORS.cleanup]
        const failure = error instanceof Error && setupErrors.includes(error.message) ? error.message : SAFE_ERRORS.process
        finalResult = { status: "failed", text: "", quiescent: true, error: cleaned ? failure : SAFE_ERRORS.cleanup }
        return finalResult
      }

      let processResult: VendorProcessResult
      try {
        processResult = await processHandle.run()
      } catch {
        const reconciled = await processHandle.reconcile().catch(() => ({ outcome: "unknown" as const, quiescent: false, evidence: "process state is unknown" }))
        if (reconciled.quiescent && !cleanupScratch()) {
          finalResult = { status: "failed", text: protocol.outputText, quiescent: true, error: SAFE_ERRORS.cleanup }
          return finalResult
        }
        finalResult = {
          status: reconciled.quiescent ? "failed" : "unresolved",
          text: protocol.outputText,
          quiescent: reconciled.quiescent,
          error: SAFE_ERRORS.process,
        }
        return finalResult
      }

      if (processResult.status === "completed" && processResult.captureComplete) protocol.finish()
      if (processResult.quiescent && !cleanupScratch()) {
        finalResult = { status: "failed", text: protocol.outputText, quiescent: true, error: SAFE_ERRORS.cleanup }
        return finalResult
      }

      finalResult = statusFromProcess(processResult, protocol)
      return finalResult
    },

    async requestCancel(reason, deadlineAt): Promise<ExecutionCancelResult> {
      validateCancel(reason, deadlineAt)
      if (processHandle) {
        const result = await processHandle.requestCancel(reason, deadlineAt)
        if (!runCalled && result.requested) cancelledBeforeRun = true
        return result
      }
      if (finalResult) return {
        requested: false,
        acknowledged: false,
        terminal: true,
        quiescent: finalResult.quiescent,
        evidence: finalResult.quiescent ? "process is terminal" : "process state is unresolved",
      }
      if (deadlineAt <= Date.now()) return { requested: false, acknowledged: false, terminal: true, quiescent: true, evidence: "cancellation deadline elapsed before request" }
      if (runCalled) {
        cancelledBeforeRun = true
        return { requested: true, acknowledged: true, terminal: false, quiescent: true, evidence: "cancellation queued before native process launch" }
      }
      cancelledBeforeRun = true
      return { requested: true, acknowledged: true, terminal: true, quiescent: true, evidence: "cancellation prevented process launch" }
    },

    async reconcile(): Promise<ExecutionReconciliation> {
      if (processHandle) {
        const reconciliation = await processHandle.reconcile()
        if (reconciliation.quiescent && scratch) {
          if (!cleanupScratch()) {
            return { ...reconciliation, evidence: `${reconciliation.evidence}; ${SAFE_ERRORS.cleanup}` }
          }
        }
        return reconciliation
      }
      if (scratch && !cleanupScratch()) {
        return { outcome: "terminal", quiescent: true, evidence: `process was not launched; ${SAFE_ERRORS.cleanup}` }
      }
      if (finalResult) return {
        outcome: finalResult.quiescent ? "terminal" : "unknown",
        quiescent: finalResult.quiescent,
        evidence: finalResult.quiescent ? "process is terminal" : "process state is unresolved",
      }
      return reconcileWithoutProcess()
    },
  }

  if (options.engine === "codex") {
    handle.preflight = async (): Promise<CliTransportPreflight> => {
      if (runCalled || cancelledBeforeRun) return { compatible: false }
      const result = await ensureCodexVersionProbe()
      return result.compatible && result.nativePolicyHash
        ? { compatible: true, nativePolicyHash: result.nativePolicyHash }
        : { compatible: false }
    }
  }

  return handle
}
