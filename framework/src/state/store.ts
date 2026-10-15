// Control-plane state store: single writer (this plugin), atomic writes.
//
// Location: OUTSIDE the worktree, under $XDG_STATE_HOME/lca/<sha1(worktree)[:12]>/ (default ~/.local/state/lca/...).
// Execution claims are the exception: executionRunDirectory resolves the effective UID's native account home,
// independent of HOME/XDG_STATE_HOME/LCA_STATE_HOME, and refuses distinct configured legacy authority.
// Stage 2 review (security M3/M5): a ledger inside the worktree could be edited by a worker (bash/edit allowed
// inside the worktree) to schedule a `verify` command that the framework would later run outside any transcript,
// and other repositories would commit .lca/state by accident. Handoffs (data plane, human-readable) stay in the
// worktree under .lca/handoffs (see ledger.ts). The e2e script isolates this via XDG_STATE_HOME.
import { createHash } from "node:crypto"
import * as childProcess from "node:child_process"
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs"
import * as os from "node:os"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Mode } from "../config.ts"

function canonical(p: string): string {
  const abs = resolve(p)
  let base = abs
  let rest = ""
  for (;;) {
    try {
      const real = realpathSync.native(base)
      return rest ? join(real, rest) : real
    } catch {
      const parent = dirname(base)
      if (parent === base) return abs
      rest = rest ? join(basename(base), rest) : basename(base)
      base = parent
    }
  }
}

/** Base directory for all control-plane state. An override that points INSIDE the worktree is ignored (it would let a worker edit the ledger again). */
export function stateBase(worktree?: string): string {
  const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  const fallback = join(xdg, "lca")
  const override = process.env.LCA_STATE_HOME
  if (!override) return fallback
  if (worktree) {
    const root = canonical(worktree)
    const o = canonical(override)
    if (o === root || o.startsWith(root.endsWith("/") ? root : root + "/")) return fallback
  }
  return resolve(override)
}

export function worktreeKey(worktree: string): string {
  return createHash("sha1").update(canonical(worktree)).digest("hex").slice(0, 12)
}

export function stateRoot(worktree: string): string {
  return join(stateBase(worktree), worktreeKey(worktree))
}

function canonicalExistingOrMissing(path: string): { path: string; exists: boolean } {
  let base = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      lstatSync(base)
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
      const parent = dirname(base)
      if (parent === base) throw new Error("cannot resolve path from an existing filesystem root")
      rest.unshift(basename(base))
      base = parent
      continue
    }

    const canonicalBase = realpathSync.native(base)
    if (rest.length) {
      if (!statSync(canonicalBase).isDirectory()) throw new Error("a non-directory blocks the execution authority path")
      return { path: join(canonicalBase, ...rest), exists: false }
    }
    return { path: canonicalBase, exists: true }
  }
}

const ACCOUNT_LOOKUP_DIAGNOSTIC = "cannot establish trusted operating-system account identity for execution authority"
const ACCOUNT_LOOKUP_OPTIONS = {
  encoding: "utf8" as const,
  env: { LC_ALL: "C" },
  cwd: "/",
  timeout: 2000,
  killSignal: "SIGKILL" as const,
  maxBuffer: 16 * 1024,
}

function accountLookupOutput(command: string, args: string[], input?: string): string {
  if (input !== undefined && Buffer.byteLength(input, "utf8") > ACCOUNT_LOOKUP_OPTIONS.maxBuffer) {
    throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
  }
  const stdio: Array<"ignore" | "pipe"> = input === undefined
    ? ["ignore", "pipe", "pipe"]
    : ["pipe", "pipe", "pipe"]
  const output = childProcess.execFileSync(command, args, {
    ...ACCOUNT_LOOKUP_OPTIONS,
    stdio,
    ...(input === undefined ? {} : { input }),
  })
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > ACCOUNT_LOOKUP_OPTIONS.maxBuffer || output.includes("\0")) {
    throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
  }
  return output
}

function oneAccountLine(output: string): string {
  const line = output.endsWith("\n") ? output.slice(0, -1) : output
  if (!line || line.includes("\n") || line.includes("\r")) throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
  return line
}

function accountUID(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
  const uid = Number(value)
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
  return uid
}

function accountName(value: string): string {
  if (!value || value.length > 255 || value === "." || value === ".." || /[\\/\0\r\n\u0001-\u001f\u007f\u0085\u2028\u2029]/.test(value)) {
    throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
  }
  return value
}

function plainJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function uniqueJsonObjectKeys(json: string): Set<string> {
  const keys = new Set<string>()
  let objectDepth = 0
  let arrayDepth = 0
  for (let index = 0; index < json.length; index++) {
    const character = json[index]!
    if (character === "{") { objectDepth++; continue }
    if (character === "}") { objectDepth--; continue }
    if (character === "[") { arrayDepth++; continue }
    if (character === "]") { arrayDepth--; continue }
    if (character !== '"') continue

    const start = index
    for (index++; index < json.length; index++) {
      if (json[index] === "\\") { index++; continue }
      if (json[index] === '"') break
    }
    if (index >= json.length) throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
    if (objectDepth !== 1 || arrayDepth !== 0) continue
    let next = index + 1
    while (/\s/.test(json[next] ?? "")) next++
    if (json[next] !== ":") continue
    const key: unknown = JSON.parse(json.slice(start, index + 1))
    if (typeof key !== "string" || keys.has(key)) throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
    keys.add(key)
  }
  return keys
}

function accountAttributes(json: string): { uid: string; home: string } {
  const value: unknown = JSON.parse(json)
  if (!plainJsonObject(value)) throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
  const keys = uniqueJsonObjectKeys(json)
  const uniqueIDKey = "dsAttrTypeStandard:UniqueID"
  const homeKey = "dsAttrTypeStandard:NFSHomeDirectory"
  if (keys.size !== 2 || !keys.has(uniqueIDKey) || !keys.has(homeKey) || Object.keys(value).length !== 2) {
    throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
  }
  const uniqueID = value[uniqueIDKey]
  const homeDirectory = value[homeKey]
  if (!Array.isArray(uniqueID) || uniqueID.length !== 1 || typeof uniqueID[0] !== "string" ||
    !Array.isArray(homeDirectory) || homeDirectory.length !== 1 || typeof homeDirectory[0] !== "string") {
    throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
  }
  return { uid: uniqueID[0], home: homeDirectory[0] }
}

function accountHomeForUID(uid: number): string {
  const platform = os.platform()
  if (platform === "darwin") {
    const name = accountName(oneAccountLine(accountLookupOutput("/usr/bin/id", ["-un"])))
    const plist = accountLookupOutput("/usr/bin/dscl", ["-plist", "/Search", "-read", `/Users/${name}`, "UniqueID", "NFSHomeDirectory"])
    const json = accountLookupOutput("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], plist)
    const attributes = accountAttributes(json)
    if (accountUID(attributes.uid) !== uid || !attributes.home || !isAbsolute(attributes.home)) {
      throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
    }
    return attributes.home
  }

  if (platform === "linux") {
    const record = oneAccountLine(accountLookupOutput("/usr/bin/getent", ["passwd", String(uid)]))
    const fields = record.split(":")
    if (fields.length !== 7) throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
    accountName(fields[0]!)
    if (accountUID(fields[2]!) !== uid) throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
    const home = fields[5]!
    if (!home || !isAbsolute(home)) throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
    return home
  }

  throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
}

/** Resolve the fixed authority for execution claims without creating or migrating state. */
export function executionRunDirectory(worktree: string): string {
  let uid: number
  let accountHome: string
  try {
    if (typeof process.geteuid !== "function") throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
    uid = process.geteuid()
    if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
    accountHome = accountHomeForUID(uid)
  } catch {
    throw new Error(ACCOUNT_LOOKUP_DIAGNOSTIC)
  }

  let worktreePath: string
  try {
    worktreePath = realpathSync.native(worktree)
  } catch {
    throw new Error("cannot canonicalize the execution authority worktree")
  }
  const worktreeStat = statSync(worktreePath)
  if (!worktreeStat.isDirectory()) throw new Error("execution authority worktree is not a directory")
  if (!Number.isSafeInteger(worktreeStat.uid) || worktreeStat.uid !== uid) {
    throw new Error("execution authority worktree is owned by a different operating-system user")
  }

  let homePath: string
  try {
    homePath = realpathSync.native(accountHome)
  } catch {
    throw new Error("operating-system home does not exist or cannot be canonicalized")
  }
  if (!statSync(homePath).isDirectory()) throw new Error("operating-system home is not a directory")

  const candidate = join(homePath, ".local", "state", "lca", worktreeKey(worktreePath), "execution-runs")
  const resolvedAuthority = canonicalExistingOrMissing(candidate)
  const authority = resolvedAuthority.path
  if (resolvedAuthority.exists) {
    const authorityStat = statSync(authority)
    if (!authorityStat.isDirectory()) throw new Error("fixed execution authority is not a directory")
    if (!Number.isSafeInteger(authorityStat.uid) || authorityStat.uid !== uid) {
      throw new Error("fixed execution authority is owned by a different operating-system user")
    }
  }

  const worktreeRelative = relative(worktreePath, authority)
  if (worktreeRelative === "" || (worktreeRelative !== ".." && !worktreeRelative.startsWith(`..${sep}`) && !isAbsolute(worktreeRelative))) {
    throw new Error("fixed execution authority resolves inside the worktree")
  }

  const legacy = join(stateRoot(worktreePath), "execution-runs")
  let legacyCanonical: { path: string; exists: boolean }
  try {
    legacyCanonical = canonicalExistingOrMissing(legacy)
  } catch {
    throw new Error("cannot inspect the configured legacy execution authority")
  }
  if (legacyCanonical.exists && legacyCanonical.path !== authority) {
    throw new Error("configured legacy execution authority exists; refusing an automatic authority change")
  }

  return authority
}

export function sessionDir(worktree: string, sessionID: string): string {
  return join(stateRoot(worktree), "sessions", sessionID)
}

export type ReadJsonResult<T> = { value: T; corrupt?: string }

/** Parse a JSON file; a missing file gives the fallback, a corrupt one is moved aside (never silently overwritten). */
export function readJsonChecked<T>(path: string, fallback: T): ReadJsonResult<T> {
  if (!existsSync(path)) return { value: fallback }
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) as T }
  } catch {
    const moved = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, moved)
      return { value: fallback, corrupt: moved }
    } catch {
      return { value: fallback, corrupt: `${path} (unreadable, could not be moved aside)` }
    }
  }
}

export function readJson<T>(path: string, fallback: T): T {
  return readJsonChecked(path, fallback).value
}

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n")
  renameSync(tmp, path)
}


export type ModeState = {
  mode: Mode
  active: boolean
  startedAt: number
  updatedAt: number
  iterations: number
  stagnation: number
  failures: number
  lastFingerprint?: string
  lastCompactedAt?: number
  /** why the loop stopped, if it did */
  stopReason?: string
}

/** Strict pure parser for status readers; it has no filesystem side effects. */
export function parseModeState(value: unknown): ModeState {
  const object = value !== null && typeof value === "object" && !Array.isArray(value)
  if (!object) throw new Error("invalid mode state")
  const state = value as Record<string, unknown>
  const timestamp = (input: unknown): boolean => typeof input === "number" && Number.isFinite(input) && input >= 0
  const counter = (input: unknown): boolean => Number.isSafeInteger(input) && (input as number) >= 0
  const optional = (key: string, check: (input: unknown) => boolean): boolean => !(key in state) || check(state[key])
  if (!["none", "ulw", "plan", "data"].includes(state.mode as string) || typeof state.active !== "boolean" ||
    !timestamp(state.startedAt) || !timestamp(state.updatedAt) ||
    !["iterations", "stagnation", "failures"].every(key => counter(state[key])) ||
    !optional("lastFingerprint", input => typeof input === "string") ||
    !optional("lastCompactedAt", timestamp) || !optional("stopReason", input => typeof input === "string")) {
    throw new Error("invalid mode state")
  }
  return value as ModeState
}

export type BoundedJson = { value: unknown | undefined; bytesRead: number }

function withBytesRead(error: unknown, bytesRead: number): Error {
  const failure = error instanceof Error ? error : new Error("unreadable")
  Object.defineProperty(failure, "bytesRead", { value: bytesRead, configurable: true, writable: true })
  return failure
}

/** Retain at most maxEntries directory entries and inspect one more to detect truncation. */
export function readDirectoryBounded(path: string, maxEntries: number): { entries: Dirent[]; truncated: boolean } {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new TypeError("invalid directory read limit")
  const directory = opendirSync(path, { bufferSize: 1 })
  const entries: Dirent[] = []
  try {
    while (entries.length < maxEntries) {
      const entry = directory.readSync()
      if (!entry) return { entries, truncated: false }
      entries.push(entry)
    }
    const lookahead = directory.readSync()
    return { entries, truncated: !!lookahead }
  } finally {
    directory.closeSync()
  }
}

/** Read at most maxBytes without creating, renaming, or otherwise mutating state. Missing file gives `bytes: undefined`. */
export function readBoundedBytes(path: string, maxBytes: number): { bytes: Buffer | undefined; bytesRead: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("invalid JSON read limit")
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: undefined, bytesRead: 0 }
    throw withBytesRead(error, 0)
  }
  let bytesRead = 0
  let result: { bytes: Buffer | undefined; bytesRead: number } | undefined
  let failure: Error | undefined
  try {
    const initial = fstatSync(fd)
    if (!initial.isFile()) throw Object.assign(new Error("unreadable"), { code: "unreadable" })
    if (initial.size > maxBytes) throw Object.assign(new Error("oversize"), { code: "oversize" })
    const buffer = Buffer.alloc(maxBytes)
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (count === 0) break
      bytesRead += count
    }
    // A writer may have extended the file after the initial size check. The
    // fixed-size buffer enforces the byte cap; fstat detects such growth.
    if (fstatSync(fd).size > maxBytes) throw Object.assign(new Error("oversize"), { code: "oversize" })
    result = { bytes: Buffer.from(buffer.subarray(0, bytesRead)), bytesRead }
  } catch (error) {
    failure = withBytesRead(error, bytesRead)
  }
  try { closeSync(fd) }
  catch (error) { if (!failure) failure = withBytesRead(error, bytesRead) }
  if (failure) throw failure
  return result!
}

/** Read and parse at most maxBytes without creating, renaming, or otherwise mutating state. */
export function readBoundedJson(path: string, maxBytes: number): BoundedJson {
  const { bytes, bytesRead } = readBoundedBytes(path, maxBytes)
  if (bytes === undefined) return { value: undefined, bytesRead: 0 }
  try { return { value: JSON.parse(bytes.toString("utf8")) as unknown, bytesRead } }
  catch (error) { throw withBytesRead(error, bytesRead) }
}

export const EMPTY_MODE: ModeState = {
  mode: "none",
  active: false,
  startedAt: 0,
  updatedAt: 0,
  iterations: 0,
  stagnation: 0,
  failures: 0,
}

export type AbortMarker = { reason: string; at: number; [k: string]: unknown }

/** Presence of this file stops the idle loop and the task queue (written by /stop, repetition abort). */
export function abortPath(worktree: string, sessionID: string): string {
  return join(sessionDir(worktree, sessionID), "abort.json")
}

export function readAbort(worktree: string, sessionID: string): AbortMarker | null {
  return readJson<AbortMarker | null>(abortPath(worktree, sessionID), null)
}

/**
 * Remove a stale abort marker. A user's /stop (`user_stop`) is only cleared by a new user message (chat.message);
 * `delegate` must not clear it, otherwise a model reacting to the /stop text could restart the queue.
 */
export function clearAbort(worktree: string, sessionID: string, opts: { keepUserStop?: boolean } = {}): boolean {
  const p = abortPath(worktree, sessionID)
  if (!existsSync(p)) return false
  if (opts.keepUserStop && readAbort(worktree, sessionID)?.reason === "user_stop") return false
  rmSync(p, { force: true })
  return true
}

export function modeStatePath(worktree: string, sessionID: string): string {
  return join(sessionDir(worktree, sessionID), "mode.json")
}

export function readModeState(worktree: string, sessionID: string): ModeState {
  return readJson(modeStatePath(worktree, sessionID), EMPTY_MODE)
}

export function writeModeState(worktree: string, sessionID: string, state: ModeState): ModeState {
  const next = { ...state, updatedAt: Date.now() }
  writeJsonAtomic(modeStatePath(worktree, sessionID), next)
  return next
}

/** session -> agent map, kept because experimental.chat.system.transform does not pass the agent. */
export type SessionInfo = { agent?: string; model?: string; createdAt: number }

export function sessionInfoPath(worktree: string, sessionID: string): string {
  return join(sessionDir(worktree, sessionID), "session.json")
}

export function readSessionInfo(worktree: string, sessionID: string): SessionInfo | null {
  return readJson<SessionInfo | null>(sessionInfoPath(worktree, sessionID), null)
}
