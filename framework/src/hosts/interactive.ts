import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process"
import {
  accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseTree, type Node } from "jsonc-parser"
import { loadConfig, parseJsonc, parseModelSelection, type LcaConfig } from "../config.ts"

const REQUIRED_HOOKS = ["config.agents", "chat.params", "tool.delegate", "guard.plan_boundary", "flow"]
export const CHAT_INSTRUCTIONS = "lca chat: isolated LCA-only profile; non-LCA plugins are disabled. Describe a request; inspect its plan before /approve, use /reject to decline, /status if enabled, and /cancel to stop."
const PROJECT_LCA_BRIDGE = [
  "// Project-local loader for the lca plugin during development. OpenCode auto-loads .opencode/plugins/*.ts.",
  'export { LcaPlugin } from "../../framework/src/index.ts"',
].join("\n") + "\n"

export class InteractiveLaunchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InteractiveLaunchError"
  }
}

export type InteractiveArgs = { worktree: string }
export type InteractiveExit = { code: number | null; signal: NodeJS.Signals | null }

type TerminalState = { stdin: boolean; stdout: boolean }
type SpawnedChild = Pick<ChildProcess, "once" | "kill">
type RuntimeProfile = { configHome: string; cleanup: () => void }
export type OpenCodeConfig = Record<string, unknown>
export type InteractiveDependencies = {
  env: NodeJS.ProcessEnv
  cwd: string
  terminal: TerminalState
  findExecutable: (name: string, pathValue: string | undefined) => string | undefined
  gitTopLevel: (directory: string, env: NodeJS.ProcessEnv) => string | undefined
  readConfig: (worktree: string) => LcaConfig
  createRuntimeProfile: (config: OpenCodeConfig, lcaConfigPath?: string) => RuntimeProfile
  spawn: (command: string, args: string[], options: SpawnOptions) => SpawnedChild
  printInstructions: (text: string) => void
}

export function parseInteractiveArgs(argv: string[], cwd = process.cwd()): InteractiveArgs {
  let worktree: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (flag !== "--worktree") throw new InteractiveLaunchError("unknown chat option; use only --worktree PATH")
    if (worktree !== undefined) throw new InteractiveLaunchError("duplicate --worktree option")
    const value = argv[++i]
    if (!value || value.startsWith("--")) throw new InteractiveLaunchError("missing value for --worktree")
    worktree = value
  }
  return { worktree: worktree ?? cwd }
}

function defaultFindExecutable(name: string, pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return realpathSync(candidate)
    } catch { /* try the next PATH entry */ }
  }
  return undefined
}

function defaultGitTopLevel(directory: string, env: NodeJS.ProcessEnv): string | undefined {
  const gitEnv: NodeJS.ProcessEnv = { ...env, GIT_OPTIONAL_LOCKS: "0" }
  delete gitEnv.GIT_DIR
  delete gitEnv.GIT_WORK_TREE
  delete gitEnv.GIT_COMMON_DIR
  const result = spawnSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: gitEnv,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0 || !result.stdout.trim()) return undefined
  try { return realpathSync(result.stdout.trim()) } catch { return undefined }
}

function createRuntimeProfile(config: OpenCodeConfig, lcaConfigPath?: string): RuntimeProfile {
  let profileHome: string | undefined
  try {
    profileHome = mkdtempSync(join(tmpdir(), "lca-opencode-profile-"))
    chmodSync(profileHome, 0o700)
    const configDirectory = join(profileHome, "opencode")
    mkdirSync(configDirectory, { mode: 0o700 })
    chmodSync(configDirectory, 0o700)
    writeFileSync(join(configDirectory, "opencode.json"), JSON.stringify(config), { mode: 0o600, flag: "wx" })
    if (lcaConfigPath && existsSync(lcaConfigPath)) {
      const lcaDirectory = join(profileHome, "lca")
      mkdirSync(lcaDirectory, { mode: 0o700 })
      chmodSync(lcaDirectory, 0o700)
      const source = realpathSync(lcaConfigPath)
      if (!statSync(source).isFile()) throw new Error()
      writeFileSync(join(lcaDirectory, "lca.jsonc"), readFileSync(source), { mode: 0o600, flag: "wx" })
    }
    return { configHome: profileHome, cleanup: () => rmSync(profileHome!, { recursive: true, force: true }) }
  } catch {
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    throw new InteractiveLaunchError("could not create a private temporary OpenCode profile")
  }
}

function defaultDependencies(): InteractiveDependencies {
  return {
    env: process.env,
    cwd: process.cwd(),
    terminal: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
    findExecutable: defaultFindExecutable,
    gitTopLevel: defaultGitTopLevel,
    readConfig: loadConfig,
    createRuntimeProfile,
    spawn: (command, args, options) => spawn(command, args, options),
    printInstructions: (text) => console.error(text),
  }
}

function canonicalWorktree(requested: string, deps: InteractiveDependencies): string {
  let directory: string
  try {
    directory = realpathSync(resolve(deps.cwd, requested))
    if (!statSync(directory).isDirectory()) throw new Error()
    accessSync(directory, constants.R_OK | constants.X_OK)
  } catch {
    throw new InteractiveLaunchError("chat requires an accessible Git worktree")
  }
  const topLevel = deps.gitTopLevel(directory, deps.env)
  if (!topLevel || !isAbsolute(topLevel)) throw new InteractiveLaunchError("chat requires a canonical Git worktree")
  try {
    const canonical = realpathSync(topLevel)
    if (!statSync(canonical).isDirectory()) throw new Error()
    return canonical
  } catch {
    throw new InteractiveLaunchError("chat requires a canonical Git worktree")
  }
}

function validateLcaConfig(config: LcaConfig): void {
  if (config.flow?.enabled !== true) {
    throw new InteractiveLaunchError("chat requires flow.enabled=true in the LCA configuration")
  }
  if (!Array.isArray(config.disabled_hooks) || config.disabled_hooks.some((hook) => typeof hook !== "string")) {
    throw new InteractiveLaunchError("chat requires a valid LCA disabled_hooks configuration")
  }
  const disabled = new Set<string>(config.disabled_hooks)
  const missing = REQUIRED_HOOKS.filter((hook) => disabled.has(hook))
  if (missing.length) {
    throw new InteractiveLaunchError(`chat requires enabled LCA safety hooks: ${missing.join(", ")}`)
  }
}

function assertNoProjectOpenCodeConfig(root: string): void {
  const paths = [
    join(root, "opencode.json"), join(root, "opencode.jsonc"),
    join(root, ".opencode", "opencode.json"), join(root, ".opencode", "opencode.jsonc"),
  ]
  if (paths.some(existsSync)) {
    throw new InteractiveLaunchError("chat refuses project OpenCode config files; move model selection to global OpenCode or LCA config")
  }
  for (const name of ["agent", "agents", "command", "commands"]) {
    const folder = join(root, ".opencode", name)
    let entries
    try { entries = readdirSync(folder, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw new InteractiveLaunchError("chat could not safely inspect project OpenCode profiles")
    }
    if (entries.some((entry) => entry.isFile() || entry.isSymbolicLink())) {
      throw new InteractiveLaunchError("chat refuses project OpenCode agents or commands that could override the LCA profile")
    }
  }
}

function assertNoLegacyHomeOpenCodeInputs(root: string, env: NodeJS.ProcessEnv): void {
  const home = resolve(env.HOME || homedir())
  const legacy = join(home, ".opencode")
  if (legacy === root) return
  const configs = ["config.json", "opencode.json", "opencode.jsonc"].map((name) => join(legacy, name))
  if (configs.some(existsSync)) {
    throw new InteractiveLaunchError("chat refuses legacy ~/.opencode config; migrate supported model settings to the standard OpenCode config")
  }
  for (const name of ["plugin", "plugins", "agent", "agents", "command", "commands"]) {
    const folder = join(legacy, name)
    let entries
    try { entries = readdirSync(folder, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw new InteractiveLaunchError("chat could not safely inspect legacy ~/.opencode plugins")
    }
    if (entries.some((entry) => entry.isFile() || entry.isSymbolicLink())) {
      throw new InteractiveLaunchError("chat refuses legacy ~/.opencode profiles or plugins; migrate supported settings to standard config")
    }
  }
}

function knownBridge(root: string): { path: string } | undefined {
  const matches: Array<{ path: string }> = []
  for (const folder of [join(root, ".opencode", "plugins"), join(root, ".opencode", "plugin")]) {
    let entries
    try { entries = readdirSync(folder, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw new InteractiveLaunchError("chat could not safely inspect project OpenCode plugins")
    }
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (!/\.(?:ts|js)$/.test(entry.name)) continue
      const path = join(folder, entry.name)
      if (entry.name.toLowerCase() === "lca.js") {
        throw new InteractiveLaunchError("chat found a conflicting project LCA plugin; use the exact project bridge")
      }
      if (entry.name !== "lca.ts") {
        throw new InteractiveLaunchError("chat refuses conflicting project OpenCode plugins; only the exact LCA bridge is supported")
      }
      try {
        if (entry.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new Error()
        const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n")
        if (source !== PROJECT_LCA_BRIDGE) throw new Error()
        const target = resolve(folder, "../../framework/src/index.ts")
        if (!statSync(target).isFile()) throw new Error()
      } catch {
        throw new InteractiveLaunchError("chat found a conflicting project LCA plugin; use the exact project bridge")
      }
      matches.push({ path })
    }
  }
  if (matches.length > 1) throw new InteractiveLaunchError("chat found duplicate project LCA plugin bridges")
  return matches[0]
}

function defaultPluginUrl(): string {
  const path = resolve(import.meta.dir, "../index.ts")
  try {
    if (!statSync(path).isFile()) throw new Error()
    return pathToFileURL(realpathSync(path)).href
  } catch {
    throw new InteractiveLaunchError("chat cannot locate the bundled LCA plugin")
  }
}

function configObject(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = parseJsonc<unknown>(raw) } catch {
    throw new InteractiveLaunchError(`${source} must contain valid JSONC`)
  }
  const tree = parseTree(raw, [], { allowTrailingComma: true })
  if (!tree || hasDuplicateKeys(tree)) {
    throw new InteractiveLaunchError(`${source} must not contain duplicate keys`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InteractiveLaunchError(`${source} must contain a JSONC object`)
  }
  return parsed as Record<string, unknown>
}

function hasDuplicateKeys(node: Node): boolean {
  if (node.type === "object") {
    const names = new Set<string>()
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value
      if (typeof key !== "string" || names.has(key)) return true
      names.add(key)
      const value = property.children?.[1]
      if (value && hasDuplicateKeys(value)) return true
    }
    return false
  }
  return (node.children ?? []).some((child) => hasDuplicateKeys(child))
}

type PluginEntry = string | [string, Record<string, unknown>]
function pluginEntries(config: Record<string, unknown>, source: string): PluginEntry[] {
  if (!Object.hasOwn(config, "plugin")) return []
  if (!Array.isArray(config.plugin)) throw new InteractiveLaunchError(`${source} plugin setting must be an array`)
  return config.plugin.map((entry) => {
    if (typeof entry === "string" && entry.length > 0) return entry
    if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && entry[0].length > 0 &&
      entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1])) return [entry[0], entry[1] as Record<string, unknown>]
    throw new InteractiveLaunchError(`${source} contains an invalid plugin entry`)
  })
}

function pluginName(entry: PluginEntry): string {
  return typeof entry === "string" ? entry : entry[0]
}

function resolvedPluginPath(spec: string, root: string): string | undefined {
  try {
    const candidate = spec.startsWith("file:") ? fileURLToPath(spec) : isAbsolute(spec) ? spec : resolve(root, spec)
    return realpathSync(candidate)
  } catch { return undefined }
}

function validatePluginOverrides(
  config: Record<string, unknown>, source: string, root: string,
  bridge: { path: string } | undefined,
): void {
  const plugins = pluginEntries(config, source)
  const fallbackUrl = defaultPluginUrl()
  const fallbackPath = fileURLToPath(fallbackUrl)
  const projectPath = bridge?.path
  if (plugins.length > 1) throw new InteractiveLaunchError(`${source} contains duplicate LCA plugin entries`)
  for (const entry of plugins) {
    const name = pluginName(entry)
    if (typeof entry !== "string" && Object.keys(entry[1]).length > 0) {
      throw new InteractiveLaunchError(`${source} LCA plugin options are not supported in the isolated chat profile`)
    }
    const resolved = resolvedPluginPath(name, root)
    if (projectPath !== undefined && resolved === projectPath) {
      throw new InteractiveLaunchError(`${source} duplicates the auto-loaded project LCA plugin`)
    }
    if (!bridge && resolved === fallbackPath) continue
    if (/(^|\/)lca(?:\.ts|\.js)?$/i.test(name)) {
      throw new InteractiveLaunchError(`${source} references a conflicting LCA plugin source`)
    }
    if (name.toLowerCase().startsWith("oh-my-openagent")) {
      throw new InteractiveLaunchError(`${source} requests an unsupported conflicting plugin`)
    }
    throw new InteractiveLaunchError(`${source} requests a plugin outside the isolated LCA-only profile`)
  }
}

function validateOverrideKeys(config: Record<string, unknown>, source: string): void {
  const allowed = new Set(["model", "small_model", "provider", "plugin"])
  if (Object.keys(config).some((key) => !allowed.has(key))) {
    throw new InteractiveLaunchError(`${source} contains settings unsupported by the isolated LCA-only chat profile`)
  }
}

function validateSelectedConfig(config: Record<string, unknown>, source: string, strict: boolean): void {
  if (strict) validateOverrideKeys(config, source)
  for (const key of ["model", "small_model"] as const) {
    if (Object.hasOwn(config, key)) {
      try {
        if (typeof config[key] !== "string") throw new Error()
        parseModelSelection(config[key] as string)
      } catch {
        throw new InteractiveLaunchError(`${source} ${key} must be a valid provider/model selection`)
      }
    }
  }
  if (Object.hasOwn(config, "provider") &&
    (!config.provider || typeof config.provider !== "object" || Array.isArray(config.provider))) {
    throw new InteractiveLaunchError(`${source} provider setting must be an object`)
  }
  if (config.provider && typeof config.provider === "object") {
    if (Object.values(config.provider).some((provider) => !provider || typeof provider !== "object" || Array.isArray(provider))) {
      throw new InteractiveLaunchError(`${source} provider entries must be objects`)
    }
  }
}

function mergeObjects(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key]
    result[key] = value && typeof value === "object" && !Array.isArray(value) &&
      existing && typeof existing === "object" && !Array.isArray(existing)
      ? mergeObjects(existing as Record<string, unknown>, value as Record<string, unknown>)
      : value
  }
  return result
}

function mergeSelectedConfig(
  target: OpenCodeConfig, patch: Record<string, unknown>,
): OpenCodeConfig {
  for (const key of ["model", "small_model"] as const) {
    if (Object.hasOwn(patch, key)) target[key] = patch[key]
  }
  if (patch.provider) {
    target.provider = mergeObjects(
      (target.provider as Record<string, unknown> | undefined) ?? {},
      patch.provider as Record<string, unknown>,
    )
  }
  return target
}

function readGlobalOpenCodeConfig(env: NodeJS.ProcessEnv): OpenCodeConfig {
  const configHome = resolve(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"))
  const directory = join(configHome, "opencode")
  let selected: OpenCodeConfig = {}
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    const path = join(directory, name)
    if (!existsSync(path)) continue
    let parsed: Record<string, unknown>
    try { parsed = configObject(readFileSync(path, "utf8"), "global OpenCode configuration") }
    catch (error) {
      if (error instanceof InteractiveLaunchError) throw error
      throw new InteractiveLaunchError("could not read global OpenCode model configuration")
    }
    validateSelectedConfig(parsed, "global OpenCode configuration", false)
    selected = mergeSelectedConfig(selected, parsed)
  }
  return selected
}

function readCustomConfig(path: string): Record<string, unknown> {
  let parsed: Record<string, unknown>
  try { parsed = configObject(readFileSync(path, "utf8"), "OPENCODE_CONFIG") }
  catch (error) {
    if (error instanceof InteractiveLaunchError) throw error
    throw new InteractiveLaunchError("could not read the explicit OPENCODE_CONFIG override")
  }
  validateSelectedConfig(parsed, "OPENCODE_CONFIG", true)
  return parsed
}

function readContentConfig(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {}
  const parsed = configObject(raw, "OPENCODE_CONFIG_CONTENT")
  validateSelectedConfig(parsed, "OPENCODE_CONFIG_CONTENT", true)
  return parsed
}

function buildChildConfigContent(
  rawConfigs: Record<string, unknown>[], root: string, bridge: { path: string } | undefined,
): string {
  const configuredPlugins: PluginEntry[] = []
  for (const config of rawConfigs) {
    validatePluginOverrides(config, "OpenCode override", root, bridge)
    configuredPlugins.push(...pluginEntries(config, "OpenCode override"))
  }
  if (configuredPlugins.length > 1) throw new InteractiveLaunchError("chat refuses duplicate LCA plugin entries across explicit overrides")
  if (bridge) return JSON.stringify({ plugin: [pathToFileURL(bridge.path).href] })
  const fallbackUrl = defaultPluginUrl()
  return JSON.stringify({ plugin: configuredPlugins.length ? configuredPlugins : [fallbackUrl] })
}

function childEnvironment(
  env: NodeJS.ProcessEnv,
  worktree: string,
  configHome: string,
  configContent: string,
): NodeJS.ProcessEnv {
  const child = { ...env }
  for (const name of [
    "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION",
    "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_TUI_CONFIG", "OPENCODE_PLUGIN_META_FILE",
    "OPENCODE_MODELS_URL", "OPENCODE_MODELS_PATH", "OPENCODE_PURE", "OPENCODE_TEST_HOME",
  ]) delete child[name]
  return {
    ...child,
    XDG_CONFIG_HOME: configHome,
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    LCA_INTERACTIVE_WORKTREE: worktree,
    OPENCODE_CONFIG_CONTENT: configContent,
  }
}

function assertNoUnsupportedEnvironmentOverrides(env: NodeJS.ProcessEnv): void {
  for (const name of [
    "OPENCODE_CONFIG_DIR", "OPENCODE_PERMISSION", "OPENCODE_TUI_CONFIG", "OPENCODE_PLUGIN_META_FILE",
    "OPENCODE_MODELS_URL", "OPENCODE_MODELS_PATH", "OPENCODE_TEST_HOME",
  ]) {
    if (env[name]) throw new InteractiveLaunchError(`${name} is unsupported in the isolated LCA-only chat profile`)
  }
  if (env.OPENCODE_PURE && /^(?:true|1)$/i.test(env.OPENCODE_PURE)) {
    throw new InteractiveLaunchError("OPENCODE_PURE cannot be enabled for LCA chat")
  }
}

function waitForChild(child: SpawnedChild): Promise<InteractiveExit> {
  return new Promise((resolveExit, reject) => {
    let spawnFailed = false
    child.once("error", () => { spawnFailed = true })
    child.once("close", (code, signal) => {
      if (spawnFailed) reject(new InteractiveLaunchError("could not start the installed OpenCode host"))
      else resolveExit({ code, signal })
    })
  })
}

export async function launchInteractive(
  args: InteractiveArgs,
  overrides: Partial<InteractiveDependencies> = {},
): Promise<InteractiveExit> {
  const deps = { ...defaultDependencies(), ...overrides }
  if (!deps.terminal.stdin || !deps.terminal.stdout) {
    throw new InteractiveLaunchError("chat requires an interactive terminal on stdin and stdout")
  }
  const worktree = canonicalWorktree(args.worktree, deps)
  let config: LcaConfig
  try { config = deps.readConfig(worktree) } catch {
    throw new InteractiveLaunchError("chat could not validate the LCA configuration")
  }
  validateLcaConfig(config)
  assertNoUnsupportedEnvironmentOverrides(deps.env)
  assertNoProjectOpenCodeConfig(worktree)
  assertNoLegacyHomeOpenCodeInputs(worktree, deps.env)
  const host = deps.findExecutable("opencode", deps.env.PATH)
  if (!host) throw new InteractiveLaunchError("chat requires the installed opencode host on PATH")
  const bridge = knownBridge(worktree)
  let selectedConfig = readGlobalOpenCodeConfig(deps.env)
  const configOverrides: Record<string, unknown>[] = []
  if (deps.env.OPENCODE_CONFIG) {
    const custom = readCustomConfig(resolve(deps.cwd, deps.env.OPENCODE_CONFIG))
    validatePluginOverrides(custom, "OPENCODE_CONFIG", worktree, bridge)
    configOverrides.push(custom)
    selectedConfig = mergeSelectedConfig(selectedConfig, custom)
  }
  const contentConfig = readContentConfig(deps.env.OPENCODE_CONFIG_CONTENT)
  validatePluginOverrides(contentConfig, "OPENCODE_CONFIG_CONTENT", worktree, bridge)
  configOverrides.push(contentConfig)
  selectedConfig = mergeSelectedConfig(selectedConfig, contentConfig)
  if (!selectedConfig.model && typeof config.models.main === "string" && config.models.main.trim()) {
    try { parseModelSelection(config.models.main) }
    catch { throw new InteractiveLaunchError("LCA models.main must be a valid provider/model selection") }
    selectedConfig.model = config.models.main
  }
  if (typeof selectedConfig.model !== "string" || !selectedConfig.model.trim()) {
    throw new InteractiveLaunchError("chat requires an explicitly configured OpenCode model or LCA models.main; no model fallback is selected")
  }
  try { parseModelSelection(selectedConfig.model) }
  catch { throw new InteractiveLaunchError("chat requires a valid explicitly configured provider/model selection") }
  const configContent = buildChildConfigContent(configOverrides, worktree, bridge)
  deps.printInstructions(CHAT_INSTRUCTIONS)
  const lcaConfigPath = join(
    deps.env.XDG_CONFIG_HOME || join(deps.env.HOME || homedir(), ".config"),
    "lca", "lca.jsonc",
  )
  const profile = deps.createRuntimeProfile(selectedConfig, lcaConfigPath)
  const childEnv = childEnvironment(deps.env, worktree, profile.configHome, configContent)
  const childArgs = [worktree, "--agent", "main"]
  let child: SpawnedChild
  try {
    child = deps.spawn(host, childArgs, { cwd: worktree, env: childEnv, stdio: "inherit" })
  } catch {
    profile.cleanup()
    throw new InteractiveLaunchError("could not start the installed OpenCode host")
  }
  let parentSignal: NodeJS.Signals | undefined
  const forwardSignal = (signal: NodeJS.Signals) => {
    parentSignal ??= signal
    try {
      if (!child.kill(signal)) {
        deps.printInstructions("lca: host signal was not delivered; waiting for its actual exit")
      }
    } catch {
      deps.printInstructions("lca: host signal failed; waiting for its actual exit")
    }
  }
  const onSigint = () => forwardSignal("SIGINT")
  const onSigterm = () => forwardSignal("SIGTERM")
  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigterm)
  try {
    const exit = await waitForChild(child)
    return parentSignal && !exit.signal ? { code: null, signal: parentSignal } : exit
  } finally {
    process.off("SIGINT", onSigint)
    process.off("SIGTERM", onSigterm)
    profile.cleanup()
  }
}

export function propagateInteractiveExit(
  exit: InteractiveExit,
  handlers: { setExitCode: (code: number) => void; reRaise: (signal: NodeJS.Signals) => void } = {
    setExitCode: (code) => { process.exitCode = code },
    reRaise: (signal) => { process.kill(process.pid, signal) },
  },
): void {
  if (exit.signal) {
    handlers.reRaise(exit.signal)
    return
  }
  handlers.setExitCode(exit.code ?? 1)
}
