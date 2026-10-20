// Update notice and `otter update` for installer-managed copies (install.sh / install.ps1).
//
// Modeled on GJC's startup check: only interactive starts check, the check runs in the background and never blocks or
// fails startup, it only notifies ("Update available ... Run: otter update"), and `otter update` performs the install.
// GJC compares release versions; otter installs a branch checkout, so it compares the installed commit with the
// remote branch head (`git ls-remote`). Source checkouts are never checked: they update through their own git workflow.
import { execFile, spawn } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseJsonc, userConfigPath } from "../config.ts"
import { stateBase } from "../state/store.ts"

/** install.sh writes this marker into the checkout it manages. */
const MARKER = join(".git", "otter-installer")
/** A full commit id: the only remote answer accepted as a branch head. */
const COMMIT_RE = /^[0-9a-f]{40}$/u
const DEFAULT_REF = "master"
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const GIT_TIMEOUT_MS = 8000

export type Install = {
  /** The managed checkout (`$OTTER_HOME/AgentFramework`). */
  readonly root: string
  readonly repo: string
  /** Branch the installer follows (`master` when the marker predates `ref=`). */
  readonly ref: string
  readonly binDir?: string
}

export type UpdateNotice = { readonly current: string; readonly latest: string; readonly ref: string }

/** `repo=…`/`ref=…`/`bin=…` lines of the installer marker; undefined for a source checkout. */
export function readInstall(root: string): Install | undefined {
  let text: string
  try { text = readFileSync(join(root, MARKER), "utf8") } catch { return undefined }
  const fields = new Map<string, string>()
  for (const line of text.split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const repo = fields.get("repo")
  if (!repo) return undefined
  const binDir = fields.get("bin")
  return { root, repo, ref: fields.get("ref") || DEFAULT_REF, ...(binDir ? { binDir } : {}) }
}

/** The checkout this code runs from: framework/src/hosts -> repository root. */
export function installRoot(): string {
  return resolve(import.meta.dir, "..", "..", "..")
}

export type UpdateCheckDeps = {
  readonly now: () => number
  /** `git <args>` in `cwd`; resolves stdout, rejects on failure or timeout. */
  readonly git: (cwd: string, args: readonly string[]) => Promise<string>
  readonly cachePath: string
  readonly ttlMs: number
}

type Cache = { checkedAt: number; local: string; latest: string; ref: string; repo: string }

function readCache(path: string): Cache | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Cache>
    return typeof value.checkedAt === "number" && typeof value.local === "string" && typeof value.latest === "string" &&
      typeof value.ref === "string" && typeof value.repo === "string" ? value as Cache : undefined
  } catch { return undefined }
}

function writeCache(path: string, cache: Cache): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  } catch { /* A cache that cannot be written only costs one more remote check next launch. */ }
}

/**
 * Whether the remote branch has moved past the installed commit. Never throws: a source checkout, a pinned tag/commit,
 * an unreachable remote or any git failure answers "no notice". The remote is asked at most once per `ttlMs` for the
 * same installed commit.
 */
export async function checkForUpdate(install: Install, deps: UpdateCheckDeps): Promise<UpdateNotice | undefined> {
  try {
    const local = (await deps.git(install.root, ["rev-parse", "HEAD"])).trim()
    if (!COMMIT_RE.test(local)) return undefined
    const cached = readCache(deps.cachePath)
    let latest: string
    if (cached && cached.local === local && cached.ref === install.ref && cached.repo === install.repo &&
        deps.now() - cached.checkedAt >= 0 && deps.now() - cached.checkedAt < deps.ttlMs) {
      latest = cached.latest
    } else {
      const line = (await deps.git(install.root, ["ls-remote", "--", install.repo, `refs/heads/${install.ref}`])).trim().split("\n")[0] ?? ""
      latest = line.split(/\s+/u)[0] ?? ""
      // An empty answer means the ref is not a branch (a pinned tag or commit): nothing to follow.
      if (!COMMIT_RE.test(latest)) return undefined
      writeCache(deps.cachePath, { checkedAt: deps.now(), local, latest, ref: install.ref, repo: install.repo })
    }
    return latest !== local ? { current: local.slice(0, 7), latest: latest.slice(0, 7), ref: install.ref } : undefined
  } catch {
    return undefined
  }
}

export function updateNoticeText(notice: UpdateNotice): string {
  return `Update available: a newer otter is on ${notice.ref} (${notice.current} -> ${notice.latest}). Run: otter update`
}

/** `update.check` in the user config (default true). Read on its own so it never enters role or policy identity. */
export function updateCheckEnabled(path = userConfigPath()): boolean {
  if (process.env.OTTER_NO_UPDATE_CHECK === "1") return false
  try {
    const parsed = parseJsonc<Record<string, unknown>>(readFileSync(path, "utf8"))
    const update = parsed && typeof parsed === "object" ? parsed.update : undefined
    return !(update && typeof update === "object" && !Array.isArray(update) && (update as Record<string, unknown>).check === false)
  } catch {
    return true
  }
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_COMMON_DIR
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-C", cwd, ...args], { env, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error)
      else resolvePromise(stdout)
    })
  })
}

/** The startup check for this installation; undefined (no network) for a source checkout or when disabled. */
export function defaultUpdateCheck(): Promise<UpdateNotice | undefined> {
  if (!updateCheckEnabled()) return Promise.resolve(undefined)
  const install = readInstall(installRoot())
  if (!install) return Promise.resolve(undefined)
  return checkForUpdate(install, { now: Date.now, git: runGit, cachePath: join(stateBase(), "update-check.json"), ttlMs: DEFAULT_TTL_MS })
}

/**
 * `otter update`: re-run the installer for this installation, which fetches the branch head, reinstalls dependencies
 * and rewrites the launcher in place. `--check` only reports. Returns the exit code.
 */
export async function updateCli(argv: readonly string[], root = installRoot()): Promise<number> {
  const checkOnly = argv.length === 1 && (argv[0] === "--check" || argv[0] === "-c")
  if (argv.length > (checkOnly ? 1 : 0)) {
    console.error("Usage: otter update [--check]")
    return 2
  }
  const install = readInstall(root)
  if (!install) {
    console.error(`otter: ${root} is a source checkout, not an installer-managed copy; update it with git (git pull) instead.`)
    return 1
  }
  const notice = await checkForUpdate(install, { now: Date.now, git: runGit, cachePath: join(stateBase(), "update-check.json"), ttlMs: 0 })
  if (checkOnly) {
    console.log(notice ? updateNoticeText(notice) : `otter is up to date with ${install.ref}.`)
    return 0
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OTTER_REPO: install.repo,
    OTTER_REF: install.ref,
    OTTER_HOME: dirname(install.root),
    // The first install already decided about the shell rc file; an update never edits it again.
    OTTER_NO_MODIFY_PATH: "1",
    ...(install.binDir ? { OTTER_BIN_DIR: install.binDir } : {}),
  }
  return new Promise(resolvePromise => {
    const child = spawn("bash", [join(install.root, "install.sh")], { env, stdio: "inherit" })
    child.on("error", () => { console.error("otter: could not run bash to update"); resolvePromise(1) })
    child.on("exit", code => resolvePromise(code ?? 1))
  })
}
