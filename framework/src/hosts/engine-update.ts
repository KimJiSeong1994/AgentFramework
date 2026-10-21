// Engine CLI updates (`otter engines`, `/engines`): show what each vendor CLI is, how it was installed, and update it
// with the command that matches its install method — only after the human confirms the exact command.
//
// Codex: otter qualifies specific Codex releases (codex-profile CODEX_SUPPORTED_VERSIONS), so an update installs the
// newest *supported* version, pinned. That may be a downgrade when a newer unqualified release is installed; the plan
// says so. A Homebrew cask cannot pin: brew is used only when its current cask version is supported, otherwise the plan
// points to npm. Claude: no otter pin; npm installs follow the vendor's `stable` tag, other installs use the vendor's
// own updater. Commands run without a shell (argv only) in the user's own environment, with the real terminal.
import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, sep } from "node:path"
import { CODEX_SUPPORTED_VERSIONS } from "./codex-profile.ts"
import { findExecutable } from "./cli-transport.ts"

export const UPDATABLE_ENGINES = ["codex", "claude"] as const
export type UpdatableEngine = (typeof UPDATABLE_ENGINES)[number]
export type InstallMethod = "npm" | "bun" | "pnpm" | "homebrew" | "native" | "unknown" | "missing"

export type EngineInfo = Readonly<{
  engine: UpdatableEngine
  /** Resolved executable (symlinks followed), when found on PATH. */
  path?: string
  version?: string
  method: InstallMethod
  /** Codex only: whether otter qualified this version. */
  supported?: boolean
}>

/** One way to run an update: the exact argv and how it is offered to the human. */
export type UpdateChoice = Readonly<{ argv: readonly string[]; label: string; note?: string }>

export type EngineUpdatePlan =
  /** `choices[0]` is the recommended command; later ones are alternatives (for example sudo), each confirmed by the human. */
  | Readonly<{ engine: UpdatableEngine; action: "run"; choices: readonly UpdateChoice[]; target: string; summary: string }>
  | Readonly<{ engine: UpdatableEngine; action: "current"; summary: string }>
  | Readonly<{ engine: UpdatableEngine; action: "manual"; summary: string }>

/** What the plan needs to know about the machine (injectable for tests). */
export type UpdateEnvironment = Readonly<{
  /** Whether `npm install -g` can write its global folder without sudo. */
  npmGlobalWritable: () => boolean
  /** The user-level prefix used when it cannot (binaries land in `<prefix>/bin`). */
  userPrefix: string
  brewVersion: (cask: string) => string | undefined
}>

const VERSION_RE: Record<UpdatableEngine, RegExp> = {
  codex: /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*$/u,
  claude: /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?) \(Claude Code\)\s*$/u,
}

/** How the executable was installed, from where its real file lives. */
export function installMethodOf(engine: UpdatableEngine, realPath: string, home = homedir()): InstallMethod {
  const path = realPath.split(sep).join("/")
  if (path.includes("/Caskroom/")) return "homebrew"
  if (path.includes("/.bun/install/global/")) return "bun"
  if (path.includes("/pnpm/global/") || path.includes("/.pnpm/")) return "pnpm"
  if (path.includes("/node_modules/@openai/codex/") || path.includes("/node_modules/@anthropic-ai/claude-code/")) return "npm"
  if (engine === "claude" && (path.startsWith(`${home.split(sep).join("/")}/.local/share/claude/`) || path.includes("/.claude/local/"))) return "native"
  if (path.includes("/Cellar/")) return "homebrew"
  return "unknown"
}

function versionOf(engine: UpdatableEngine, executable: string): string | undefined {
  try {
    const run = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] })
    return VERSION_RE[engine].exec(typeof run.stdout === "string" ? run.stdout.trim() : "")?.[1]
  } catch { return undefined }
}

/** What is installed (pure reads plus `--version`). */
export function engineInfo(engine: UpdatableEngine): EngineInfo {
  let executable: string
  try { executable = findExecutable(engine) } catch { return { engine, method: "missing" } }
  let real = executable
  try { real = realpathSync(executable) } catch { /* keep the PATH entry */ }
  const version = versionOf(engine, executable)
  return {
    engine, path: real, method: installMethodOf(engine, real),
    ...(version ? { version } : {}),
    ...(engine === "codex" ? { supported: version !== undefined && (CODEX_SUPPORTED_VERSIONS as readonly string[]).includes(version) } : {}),
  }
}

/** The Homebrew cask's current version (what `brew upgrade --cask` would install), or undefined. */
export function brewCaskVersion(cask: string): string | undefined {
  try {
    const run = spawnSync("brew", ["info", "--cask", "--json=v2", cask], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] })
    const value: unknown = JSON.parse(typeof run.stdout === "string" ? run.stdout : "")
    const version = (value as { casks?: Array<{ version?: unknown }> }).casks?.[0]?.version
    return typeof version === "string" && /^[0-9A-Za-z.+-]{1,64}$/u.test(version) ? version : undefined
  } catch { return undefined }
}

const NPM_PACKAGE: Record<UpdatableEngine, string> = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code" }
const BREW_CASK: Record<UpdatableEngine, string> = { codex: "codex", claude: "claude-code" }

function packageInstall(method: "npm" | "bun" | "pnpm", spec: string): string[] {
  return method === "npm" ? ["npm", "install", "-g", spec] : method === "bun" ? ["bun", "add", "-g", spec] : ["pnpm", "add", "-g", spec]
}

/** The global npm folder, from `npm prefix -g` (undefined when npm is missing or silent). */
export function npmGlobalPrefix(): string | undefined {
  try {
    const run = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] })
    const prefix = typeof run.stdout === "string" ? run.stdout.trim() : ""
    return run.status === 0 && isAbsolute(prefix) ? prefix : undefined
  } catch { return undefined }
}

/**
 * Whether `npm install -g` can write without sudo: the global `lib/node_modules` (or, when it does not exist yet, the
 * prefix's `lib`) is writable by this user. A root-owned global folder (Node from apt on Linux/WSL) is not.
 */
export function npmGlobalWritable(prefix = npmGlobalPrefix()): boolean {
  if (!prefix || process.platform === "win32") return true
  for (const candidate of [join(prefix, "lib", "node_modules"), join(prefix, "lib"), prefix]) {
    if (!existsSync(candidate)) continue
    try { accessSync(candidate, constants.W_OK); return true } catch { return false }
  }
  return false
}

export function defaultUpdateEnvironment(): UpdateEnvironment {
  return { npmGlobalWritable: () => npmGlobalWritable(), userPrefix: join(homedir(), ".local"), brewVersion: brewCaskVersion }
}

/**
 * npm install choices for `spec`: plain `-g` when the global folder is writable; otherwise a user-level install into
 * `userPrefix` first (no sudo; binaries in `<userPrefix>/bin`, which otter's installer puts on PATH) and `sudo npm` as an
 * alternative the human may pick.
 */
function npmChoices(spec: string, env: UpdateEnvironment): UpdateChoice[] {
  if (env.npmGlobalWritable()) return [{ argv: ["npm", "install", "-g", spec], label: `npm install -g ${spec}` }]
  return [
    { argv: ["npm", "install", "-g", "--prefix", env.userPrefix, spec], label: `install for your user only (${env.userPrefix}/bin, no sudo)`,
      note: "The global npm folder is not writable by you; this avoids sudo." },
    { argv: ["sudo", "npm", "install", "-g", spec], label: `sudo npm install -g ${spec} (asks for your password)` },
  ]
}

function managerChoices(method: "npm" | "bun" | "pnpm", spec: string, env: UpdateEnvironment): UpdateChoice[] {
  if (method === "npm") return npmChoices(spec, env)
  const argv = method === "bun" ? ["bun", "add", "-g", spec] : ["pnpm", "add", "-g", spec]
  return [{ argv, label: argv.join(" ") }]
}

/** The update for one engine: confirmed command choices, "already current", or what to do by hand. */
export function planEngineUpdate(info: EngineInfo, env: UpdateEnvironment = defaultUpdateEnvironment()): EngineUpdatePlan {
  const engine = info.engine
  if (engine === "codex") {
    const target = CODEX_SUPPORTED_VERSIONS.at(-1)!
    const spec = `${NPM_PACKAGE.codex}@${target}`
    if (info.method === "missing") {
      return { engine, action: "run", choices: npmChoices(spec, env), target, summary: `install Codex CLI ${target} (otter-supported) with npm` }
    }
    if (info.version === target) return { engine, action: "current", summary: `Codex CLI ${target} is the newest version otter supports` }
    const direction = info.version && compareVersions(info.version, target) > 0 ? `downgrade ${info.version} → ${target} (newer releases are not otter-qualified yet)` : `${info.version ?? "unknown version"} → ${target}`
    if (info.method === "npm" || info.method === "bun" || info.method === "pnpm") {
      return { engine, action: "run", choices: managerChoices(info.method, spec, env), target, summary: `Codex CLI ${direction} with ${info.method}` }
    }
    if (info.method === "homebrew") {
      const cask = env.brewVersion(BREW_CASK.codex)
      if (cask && (CODEX_SUPPORTED_VERSIONS as readonly string[]).includes(cask) && (!info.version || compareVersions(cask, info.version) > 0)) {
        return { engine, action: "run", choices: [{ argv: ["brew", "upgrade", "--cask", BREW_CASK.codex], label: "brew upgrade --cask codex" }], target: cask, summary: `Codex CLI ${info.version ?? "?"} → ${cask} with Homebrew` }
      }
      return { engine, action: "manual", summary: `Codex CLI is a Homebrew cask, which cannot install a specific version${cask ? ` (cask is ${cask})` : ""}. Switch to npm: brew uninstall --cask codex && npm install -g ${spec}` }
    }
    return { engine, action: "manual", summary: `Codex CLI at ${info.path ?? "?"} was not installed by npm, bun, pnpm or Homebrew; reinstall it with npm install -g ${spec}` }
  }
  // claude
  const stable = `${NPM_PACKAGE.claude}@stable`
  if (info.method === "missing") {
    return { engine, action: "run", choices: npmChoices(stable, env), target: "stable", summary: "install Claude Code (vendor stable channel) with npm" }
  }
  if (info.method === "npm" && !env.npmGlobalWritable()) {
    // The vendor's native installer needs no sudo and lands in ~/.local/bin; npm alternatives stay available.
    return { engine, action: "run", target: "stable", summary: `Claude Code ${info.version ?? "?"} → vendor stable channel (global npm folder is not writable)`,
      choices: [{ argv: [info.path ?? "claude", "install", "stable"], label: "claude install stable (native build in ~/.local/bin, no sudo)" }, ...npmChoices(stable, env)] }
  }
  if (info.method === "npm" || info.method === "bun" || info.method === "pnpm") {
    return { engine, action: "run", choices: managerChoices(info.method, stable, env), target: "stable", summary: `Claude Code ${info.version ?? "?"} → vendor stable channel with ${info.method}` }
  }
  if (info.method === "homebrew") {
    return { engine, action: "run", choices: [{ argv: ["brew", "upgrade", "--cask", BREW_CASK.claude], label: "brew upgrade --cask claude-code" }], target: "cask", summary: `Claude Code ${info.version ?? "?"} → current Homebrew cask` }
  }
  return { engine, action: "run", choices: [{ argv: [info.path ?? "claude", "update"], label: "claude update" }], target: "latest", summary: `Claude Code ${info.version ?? "?"} → the vendor's own updater (claude update)` }
}

/**
 * After an update: the installed version on PATH, and — when PATH still finds the old binary — the newly installed one
 * that is shadowed (for example `~/.local/bin/codex` behind a root-owned `/usr/bin/codex`).
 */
export function verifyEngineUpdate(engine: UpdatableEngine, userPrefix = join(homedir(), ".local")): { info: EngineInfo; shadowed?: { path: string; version: string } } {
  const info = engineInfo(engine)
  const candidate = join(userPrefix, "bin", engine)
  if (info.path && existsSync(candidate)) {
    let real = candidate
    try { real = realpathSync(candidate) } catch { /* keep */ }
    if (real !== info.path) {
      const version = versionOf(engine, candidate)
      if (version && version !== info.version) return { info, shadowed: { path: candidate, version } }
    }
  }
  return { info }
}

/** Why an update command failed, in words, from its exit status. */
export function describeUpdateFailure(argv: readonly string[], run: { exitCode: number | null; signal: string | null }): string {
  if (run.signal) return `stopped by ${run.signal}`
  if (run.exitCode === null) return `${argv[0]} could not be started (not installed or not on PATH)`
  if (argv[0] === "npm" && run.exitCode === 243) return "exit 243: npm could not write its global folder (permission denied, EACCES)"
  if (run.exitCode === 127) return `exit 127: ${argv[0]} was not found`
  return `exit ${run.exitCode}`
}

/** Numeric dotted-version comparison; pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = "", pre] = value.split("-", 2)
    return { parts: core.split(".").map(part => Number.parseInt(part, 10) || 0), pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index++) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0)
    if (difference) return difference
  }
  if (left.pre && !right.pre) return -1
  if (!left.pre && right.pre) return 1
  return 0
}

/** Run an update command with the real terminal (no shell); resolves with its exit status. */
export function runEngineUpdate(argv: readonly string[]): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try { child = spawn(argv[0]!, argv.slice(1), { stdio: "inherit", env: process.env }) }
    catch { resolve({ exitCode: null, signal: null }); return }
    child.on("error", () => resolve({ exitCode: null, signal: null }))
    child.on("exit", (code, signal) => resolve({ exitCode: code, signal }))
  })
}

/** One line per engine for `otter engines` / `/engines`. */
export function describeEngine(info: EngineInfo, plan: EngineUpdatePlan): string {
  const head = info.method === "missing" ? `${info.engine}: not installed`
    : `${info.engine}: ${info.version ?? "version unknown"}${info.engine === "codex" ? (info.supported ? " (otter-supported)" : " (not otter-supported)") : ""} · ${info.method}`
  const next = plan.action === "run" ? `update: ${plan.summary} — ${plan.choices[0]!.argv.join(" ")}` : plan.action === "current" ? plan.summary : `update by hand: ${plan.summary}`
  return `${head}\n    ${next}`
}
