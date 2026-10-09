import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { DEFAULT_CONFIG, type LcaConfig } from "../src/config.ts"
import {
  CHAT_INSTRUCTIONS,
  launchInteractive,
  parseInteractiveArgs,
  propagateInteractiveExit,
  type InteractiveDependencies,
  type InteractiveExit,
} from "../src/hosts/interactive.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree() })
afterEach(() => wt.cleanup())

type TestOptions = {
  env?: NodeJS.ProcessEnv
  config?: LcaConfig
  gitRoot?: string | undefined
  host?: string | undefined
  exit?: InteractiveExit
  spawnError?: Error
  spawnErrorEvent?: Error
  globalConfig?: Record<string, unknown>
}

function launcher(options: TestOptions = {}) {
  const calls: {
    hostLookups: number
    gitChecks: number
    spawns: Array<{ command: string; args: string[]; options: any }>
    instructions: string[]
    profileConfig?: Record<string, unknown>
    lcaUserConfig?: Record<string, unknown>
    lcaUserConfigMode?: number
    profileHomeMode?: number
    profileConfigMode?: number
  } = {
    hostLookups: 0,
    gitChecks: 0,
    spawns: [],
    instructions: [],
  }
  const home = join(wt.stateHome, "home")
  const xdgConfigHome = join(home, ".config")
  mkdirSync(home, { recursive: true })
  const globalConfigDirectory = join(xdgConfigHome, "opencode")
  mkdirSync(globalConfigDirectory, { recursive: true })
  const lcaConfigDirectory = join(xdgConfigHome, "lca")
  mkdirSync(lcaConfigDirectory, { recursive: true })
  writeFileSync(join(lcaConfigDirectory, "lca.jsonc"), JSON.stringify({ models: { main: "local/lca-user" } }))
  writeFileSync(join(globalConfigDirectory, "opencode.json"), JSON.stringify(options.globalConfig ?? {
    model: "local/global-model",
    small_model: "local/global-small",
    provider: { local: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:11434/v1" } } },
    plugin: ["oh-my-openagent"],
  }))
  const env = {
    PATH: "/mock/bin",
    HOME: home,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    LCA_STATE_HOME: join(home, "lca-state"),
    ...options.env,
  }
  const deps: Partial<InteractiveDependencies> = {
    env,
    cwd: wt.worktree,
    terminal: { stdin: true, stdout: true },
    findExecutable: (name, pathValue) => {
      calls.hostLookups++
      expect(name).toBe("opencode")
      expect(pathValue).toBe(env.PATH)
      return Object.hasOwn(options, "host") ? options.host : "/mock/bin/opencode"
    },
    gitTopLevel: () => {
      calls.gitChecks++
      return Object.hasOwn(options, "gitRoot") ? options.gitRoot : wt.worktree
    },
    readConfig: () => options.config ?? DEFAULT_CONFIG,
    printInstructions: (text) => calls.instructions.push(text),
    spawn: (command, args, spawnOptions) => {
      calls.spawns.push({ command, args, options: spawnOptions })
      const childEnv = spawnOptions.env as NodeJS.ProcessEnv
      if (childEnv.XDG_CONFIG_HOME) {
        const profileConfigPath = join(childEnv.XDG_CONFIG_HOME, "opencode", "opencode.json")
        calls.profileConfig = JSON.parse(readFileSync(profileConfigPath, "utf8"))
        calls.profileHomeMode = statSync(childEnv.XDG_CONFIG_HOME).mode & 0o777
        calls.profileConfigMode = statSync(profileConfigPath).mode & 0o777
        const profileLcaConfigPath = join(childEnv.XDG_CONFIG_HOME, "lca", "lca.jsonc")
        if (existsSync(profileLcaConfigPath)) {
          calls.lcaUserConfig = JSON.parse(readFileSync(profileLcaConfigPath, "utf8"))
          calls.lcaUserConfigMode = statSync(profileLcaConfigPath).mode & 0o777
        }
      }
      if (options.spawnError) throw options.spawnError
      const child = Object.assign(new EventEmitter(), { kill: () => true })
      queueMicrotask(() => {
        if (options.spawnErrorEvent) {
          child.emit("error", options.spawnErrorEvent)
          child.emit("close", null, null)
        }
        else child.emit("close", options.exit ? options.exit.code : 0, options.exit?.signal ?? null)
      })
      return child as unknown as ReturnType<InteractiveDependencies["spawn"]>
    },
  }
  return { calls, deps }
}

function configWithDisabledHook(hook: LcaConfig["disabled_hooks"][number]): LcaConfig {
  return { ...DEFAULT_CONFIG, disabled_hooks: [...DEFAULT_CONFIG.disabled_hooks, hook] }
}

const defaultPluginUrl = pathToFileURL(realpathSync(join(import.meta.dir, "../src/index.ts"))).href
const bridgeSource = [
  "// Project-local loader for the lca plugin during development. OpenCode auto-loads .opencode/plugins/*.ts.",
  'export { LcaPlugin } from "../../framework/src/index.ts"',
].join("\n") + "\n"

describe("interactive OpenCode launcher", () => {
  test("parses only the explicit worktree option and defaults to cwd", () => {
    expect(parseInteractiveArgs([], wt.worktree)).toEqual({ worktree: wt.worktree })
    expect(parseInteractiveArgs(["--worktree", "project"], wt.worktree)).toEqual({ worktree: "project" })
    expect(() => parseInteractiveArgs(["--model", "provider/model"], wt.worktree)).toThrow("unknown chat option")
    expect(() => parseInteractiveArgs(["--worktree", wt.worktree, "--worktree", wt.worktree])).toThrow("duplicate")
  })

  test("requires a TTY before worktree, host, or spawn checks", async () => {
    const { calls, deps } = launcher()
    deps.terminal = { stdin: false, stdout: true }
    await expect(launchInteractive({ worktree: wt.worktree }, deps)).rejects.toThrow("interactive terminal")
    expect(calls.gitChecks).toBe(0)
    expect(calls.hostLookups).toBe(0)
    expect(calls.spawns).toEqual([])
  })

  test("canonicalizes a nested directory to its Git worktree and injects only child-scoped settings", async () => {
    const nested = join(wt.worktree, "src")
    const canonicalRoot = realpathSync(wt.worktree)
    mkdirSync(nested)
    const customConfigPath = join(wt.worktree, "custom-opencode.json")
    writeFileSync(customConfigPath, JSON.stringify({ model: "local/custom-model", small_model: "local/custom-small" }))
    const parentEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LCA_INTERACTIVE_WORKTREE: "parent-value",
      OPENCODE_CONFIG: customConfigPath,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "local/content-model", small_model: "local/content-small" }),
    }
    const { calls, deps } = launcher({ env: parentEnv })
    delete deps.gitTopLevel
    const result = await launchInteractive({ worktree: nested }, deps)
    expect(result).toEqual({ code: 0, signal: null })
    expect(calls.spawns).toHaveLength(1)
    const call = calls.spawns[0]!
    expect(call.command).toBe("/mock/bin/opencode")
    expect(call.args).toEqual([canonicalRoot, "--agent", "main"])
    expect(call.args).not.toContain("--auto")
    expect(call.options).toMatchObject({ cwd: canonicalRoot, stdio: "inherit" })
    const childEnv = call.options.env as NodeJS.ProcessEnv
    expect(childEnv.LCA_INTERACTIVE_WORKTREE).toBe(canonicalRoot)
    expect(childEnv.OPENCODE_CONFIG).toBeUndefined()
    expect(childEnv.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(childEnv.OPENCODE_PERMISSION).toBeUndefined()
    expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT!)).toEqual({ plugin: [defaultPluginUrl] })
    expect(childEnv.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true")
    expect(calls.profileConfig).toMatchObject({
      model: "local/content-model",
      small_model: "local/content-small",
      provider: { local: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:11434/v1" } } },
    })
    expect(calls.profileHomeMode).toBe(0o700)
    expect(calls.profileConfigMode).toBe(0o600)
    expect(calls.lcaUserConfig).toEqual({ models: { main: "local/lca-user" } })
    expect(calls.lcaUserConfigMode).toBe(0o600)
    expect(existsSync(childEnv.XDG_CONFIG_HOME!)).toBe(false)
    expect(childEnv.XDG_DATA_HOME).toBe(join(wt.stateHome, "home", "data"))
    expect(childEnv.XDG_STATE_HOME).toBe(join(wt.stateHome, "home", "state"))
    expect(childEnv.LCA_STATE_HOME).toBe(join(wt.stateHome, "home", "lca-state"))
    expect(parentEnv.LCA_INTERACTIVE_WORKTREE).toBe("parent-value")
    expect(parentEnv.OPENCODE_CONFIG).toBe(customConfigPath)
    expect(parentEnv.OPENCODE_CONFIG_CONTENT).toContain("content-model")
    expect(calls.instructions).toEqual([CHAT_INSTRUCTIONS])
    expect(calls.instructions[0]).toContain("LCA-only")
    expect(existsSync(join(wt.worktree, "opencode.json"))).toBe(false)
  })

  test("reuses the exact project bridge without adding a second plugin URL", async () => {
    const pluginFolder = join(wt.worktree, ".opencode", "plugins")
    mkdirSync(pluginFolder, { recursive: true })
    mkdirSync(join(wt.worktree, "framework", "src"), { recursive: true })
    writeFileSync(join(wt.worktree, "framework", "src", "index.ts"), "export {}\n")
    writeFileSync(join(pluginFolder, "lca.ts"), bridgeSource)
    const { calls, deps } = launcher({ env: { PATH: "/mock/bin", OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "local/existing" }) } })
    await launchInteractive({ worktree: wt.worktree }, deps)
    const content = JSON.parse(calls.spawns[0]!.options.env.OPENCODE_CONFIG_CONTENT)
    expect(content).toEqual({ plugin: [pathToFileURL(join(realpathSync(wt.worktree), ".opencode/plugins/lca.ts")).href] })
    expect(calls.profileConfig?.model).toBe("local/existing")
    expect(calls.spawns[0]!.options.env.LCA_INTERACTIVE_WORKTREE).toBe(realpathSync(wt.worktree))
  })

  test("uses child-only inline configuration when no override or project bridge exists", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/mock/bin" }
    const { calls, deps } = launcher({ env })
    await launchInteractive({ worktree: wt.worktree }, deps)
    const childEnv = calls.spawns[0]!.options.env as NodeJS.ProcessEnv
    expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT!)).toMatchObject({ plugin: [defaultPluginUrl] })
    expect(calls.profileConfig).toMatchObject({ model: "local/global-model", small_model: "local/global-small" })
    expect(calls.profileConfig?.plugin).toBeUndefined()
    expect(childEnv.OPENCODE_CONFIG_CONTENT).toBeDefined()
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    expect(existsSync(join(wt.worktree, "opencode.json"))).toBe(false)
  })

  test("honors an existing exact fallback plugin entry without loading it twice", async () => {
    const original = JSON.stringify({ model: "provider/existing", plugin: [defaultPluginUrl] })
    const { calls, deps } = launcher({ env: { PATH: "/mock/bin", OPENCODE_CONFIG_CONTENT: original } })
    await launchInteractive({ worktree: wt.worktree }, deps)
    expect(JSON.parse(calls.spawns[0]!.options.env.OPENCODE_CONFIG_CONTENT)).toEqual({ plugin: [defaultPluginUrl] })
    expect(calls.profileConfig?.model).toBe("provider/existing")
  })

  test("refuses duplicate or known-conflicting plugins before host launch", async () => {
    for (const plugins of [[defaultPluginUrl, defaultPluginUrl], ["oh-my-openagent"]]) {
      const { calls, deps } = launcher({ env: { PATH: "/mock/bin", OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: plugins }) } })
      await expect(launchInteractive({ worktree: wt.worktree }, deps)).rejects.toThrow()
      expect(calls.spawns).toEqual([])
    }
  })

  test("refuses malformed child overrides and non-exact project LCA bridges", async () => {
    const malformed = launcher({ env: { PATH: "/mock/bin", OPENCODE_CONFIG_CONTENT: "{broken" } })
    await expect(launchInteractive({ worktree: wt.worktree }, malformed.deps)).rejects.toThrow("valid JSONC")
    expect(malformed.calls.spawns).toEqual([])

    const duplicateKey = launcher({ env: { PATH: "/mock/bin", OPENCODE_CONFIG_CONTENT: `{"plugin":["${defaultPluginUrl}"],"plugin":[]}` } })
    await expect(launchInteractive({ worktree: wt.worktree }, duplicateKey.deps)).rejects.toThrow("duplicate keys")
    expect(duplicateKey.calls.spawns).toEqual([])

    const pluginFolder = join(wt.worktree, ".opencode", "plugins")
    mkdirSync(pluginFolder, { recursive: true })
    writeFileSync(join(pluginFolder, "lca.ts"), "export default {}\n")
    const conflicting = launcher()
    await expect(launchInteractive({ worktree: wt.worktree }, conflicting.deps)).rejects.toThrow("conflicting project LCA plugin")
    expect(conflicting.calls.spawns).toEqual([])
  })

  test("requires the flow boundary and execution hooks before resolving the host", async () => {
    for (const hook of ["config.agents", "chat.params", "flow", "guard.plan_boundary", "tool.delegate"] as const) {
      const { calls, deps } = launcher({ config: configWithDisabledHook(hook) })
      await expect(launchInteractive({ worktree: wt.worktree }, deps)).rejects.toThrow(hook)
      expect(calls.hostLookups).toBe(0)
      expect(calls.spawns).toEqual([])
    }

    const flowOff = launcher({ config: { ...DEFAULT_CONFIG, flow: { ...DEFAULT_CONFIG.flow, enabled: false } } })
    await expect(launchInteractive({ worktree: wt.worktree }, flowOff.deps)).rejects.toThrow("flow.enabled=true")
    expect(flowOff.calls.hostLookups).toBe(0)

    const lcaModelOnly = launcher({
      config: { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models, main: "local/lca-main" } },
      globalConfig: {},
    })
    await launchInteractive({ worktree: wt.worktree }, lcaModelOnly.deps)
    expect(lcaModelOnly.calls.profileConfig?.model).toBe("local/lca-main")
  })

  test("refuses non-worktrees and missing OpenCode without spawning", async () => {
    const notGit = launcher({ gitRoot: undefined })
    await expect(launchInteractive({ worktree: wt.worktree }, notGit.deps)).rejects.toThrow("canonical Git worktree")
    expect(notGit.calls.hostLookups).toBe(0)

    const noHost = launcher({ host: undefined })
    await expect(launchInteractive({ worktree: wt.worktree }, noHost.deps)).rejects.toThrow("installed opencode host")
    expect(noHost.calls.spawns).toEqual([])
  })

  test("redacts synchronous and asynchronous spawn failures", async () => {
    const thrown = launcher({ spawnError: new Error("/private/host/path") })
    await expect(launchInteractive({ worktree: wt.worktree }, thrown.deps)).rejects.toThrow("could not start the installed OpenCode host")
    const syncProfile = thrown.calls.spawns[0]!.options.env.XDG_CONFIG_HOME
    expect(existsSync(syncProfile)).toBe(false)

    const asyncFailure = launcher({ spawnErrorEvent: new Error("private detail") })
    await expect(launchInteractive({ worktree: wt.worktree }, asyncFailure.deps))
      .rejects.toThrow("could not start the installed OpenCode host")
    const asyncProfile = asyncFailure.calls.spawns[0]!.options.env.XDG_CONFIG_HOME
    expect(existsSync(asyncProfile)).toBe(false)
  })

  test("refuses missing model selection and unsupported explicit config overrides", async () => {
    const missing = launcher({ globalConfig: {} })
    await expect(launchInteractive({ worktree: wt.worktree }, missing.deps)).rejects.toThrow("no model fallback")
    expect(missing.calls.hostLookups).toBe(1)
    expect(missing.calls.spawns).toEqual([])

    const unsupported = launcher({ env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "*": "allow" } }) } })
    await expect(launchInteractive({ worktree: wt.worktree }, unsupported.deps)).rejects.toThrow("unsupported by the isolated")
    expect(unsupported.calls.spawns).toEqual([])

    const extraOverride = launcher({ env: { OPENCODE_CONFIG_DIR: "/custom/plugin-dir" } })
    await expect(launchInteractive({ worktree: wt.worktree }, extraOverride.deps)).rejects.toThrow("OPENCODE_CONFIG_DIR")
    expect(extraOverride.calls.spawns).toEqual([])
  })

  test("allows the standard home binary installation without loading legacy configuration", async () => {
    const { deps, calls } = launcher()
    const installation = join(deps.env!.HOME!, ".opencode")
    mkdirSync(join(installation, "bin"), { recursive: true })
    writeFileSync(join(installation, "bin", "opencode"), "installation fixture")
    writeFileSync(join(installation, "package.json"), '{"dependencies":{}}\n')
    expect(await launchInteractive({ worktree: wt.worktree }, deps)).toEqual({ code: 0, signal: null })
    expect(calls.spawns).toHaveLength(1)
    expect(readFileSync(join(installation, "package.json"), "utf8")).toBe('{"dependencies":{}}\n')
  })

  test("refuses project config, non-LCA project plugins, and legacy home config", async () => {
    const projectConfig = launcher()
    writeFileSync(join(wt.worktree, "opencode.json"), JSON.stringify({ model: "local/project" }))
    await expect(launchInteractive({ worktree: wt.worktree }, projectConfig.deps)).rejects.toThrow("project OpenCode config")
    expect(projectConfig.calls.spawns).toEqual([])
    expect(existsSync(join(wt.worktree, "opencode.json"))).toBe(true)
    rmSync(join(wt.worktree, "opencode.json"))

    const { calls, deps } = launcher()
    const pluginFolder = join(wt.worktree, ".opencode", "plugins")
    mkdirSync(pluginFolder, { recursive: true })
    writeFileSync(join(pluginFolder, "other.ts"), "export default {}\n")
    await expect(launchInteractive({ worktree: wt.worktree }, deps)).rejects.toThrow("conflicting project OpenCode plugins")
    expect(calls.spawns).toEqual([])

    const legacy = launcher()
    const legacyDirectory = join(legacy.deps.env!.HOME!, ".opencode")
    mkdirSync(legacyDirectory, { recursive: true })
    writeFileSync(join(legacyDirectory, "opencode.json"), JSON.stringify({ model: "local/legacy" }))
    await expect(launchInteractive({ worktree: wt.worktree }, legacy.deps)).rejects.toThrow("legacy ~/.opencode config")
    expect(legacy.calls.spawns).toEqual([])
  })

  test("failed signal delivery retains the private profile until the child exits", async () => {
    for (const throws of [false, true]) {
      const { deps, calls } = launcher()
      const child = Object.assign(new EventEmitter(), {
        kill: () => { if (throws) throw new Error("private signal failure"); return false },
      })
      let profile = ""
      deps.spawn = (_command, _args, options) => {
        profile = options.env!.XDG_CONFIG_HOME!
        return child as unknown as ReturnType<InteractiveDependencies["spawn"]>
      }
      const pending = launchInteractive({ worktree: wt.worktree }, deps)
      expect(() => process.emit("SIGTERM")).not.toThrow()
      expect(existsSync(profile)).toBe(true)
      expect(calls.instructions.at(-1)).toContain("waiting for its actual exit")
      expect(calls.instructions.join("\n")).not.toContain("private signal failure")
      child.emit("close", 0, null)
      expect(await pending).toEqual({ code: null, signal: "SIGTERM" })
      expect(existsSync(profile)).toBe(false)
    }
  })

  test("returns the child's real exit code or signal unchanged", async () => {
    const exited = launcher({ exit: { code: 23, signal: null } })
    const exit = await launchInteractive({ worktree: wt.worktree }, exited.deps)
    expect(exit).toEqual({ code: 23, signal: null })
    let exitCode: number | undefined
    propagateInteractiveExit(exit, { setExitCode: (code) => { exitCode = code }, reRaise: () => { throw new Error("unexpected signal") } })
    expect(exitCode).toBe(23)

    const signaled = launcher({ exit: { code: null, signal: "SIGTERM" } })
    const signal = await launchInteractive({ worktree: wt.worktree }, signaled.deps)
    expect(signal).toEqual({ code: null, signal: "SIGTERM" })
    let reRaised: NodeJS.Signals | undefined
    propagateInteractiveExit(signal, { setExitCode: () => { throw new Error("unexpected exit code") }, reRaise: (value) => { reRaised = value } })
    expect(reRaised).toBe("SIGTERM")
  })
})
