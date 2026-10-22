import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CODEX_SUPPORTED_VERSIONS } from "../src/hosts/codex-profile.ts"
import { compareVersions, describeEngine, describeUpdateFailure, engineInfo, installMethodOf, npmGlobalWritable, planEngineUpdate, verifyEngineUpdate, type EngineInfo, type UpdateEnvironment } from "../src/hosts/engine-update.ts"

const target = CODEX_SUPPORTED_VERSIONS.at(-1)!
const codex = (method: EngineInfo["method"], version?: string): EngineInfo =>
  ({ engine: "codex", method, ...(version ? { version } : {}), path: "/x/codex", supported: version !== undefined && (CODEX_SUPPORTED_VERSIONS as readonly string[]).includes(version) })
const claude = (method: EngineInfo["method"], version = "2.1.301"): EngineInfo => ({ engine: "claude", method, version, path: "/x/claude" })
const writable: UpdateEnvironment = { npmGlobalWritable: () => true, userPrefix: "/home/u/.local", brewVersion: () => undefined }
const rootOwned: UpdateEnvironment = { ...writable, npmGlobalWritable: () => false }
const argvs = (plan: ReturnType<typeof planEngineUpdate>) => plan.action === "run" ? plan.choices.map(choice => choice.argv) : []

describe("install method", () => {
  test.each([
    ["codex", "/opt/homebrew/Caskroom/codex/0.163.0/bin/codex", "homebrew"],
    ["codex", "/usr/local/lib/node_modules/@openai/codex/bin/codex.js", "npm"],
    ["codex", "/home/u/.bun/install/global/node_modules/@openai/codex/bin/codex.js", "bun"],
    ["codex", "/home/u/.local/share/pnpm/global/5/node_modules/@openai/codex/bin/codex.js", "pnpm"],
    ["claude", "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe", "npm"],
    ["claude", "/home/u/.local/share/claude/versions/2.1.301", "native"],
    ["claude", "/opt/homebrew/Caskroom/claude-code/2.1.304/claude", "homebrew"],
    ["codex", "/usr/bin/codex", "unknown"],
  ] as const)("%s at %s is %s", (engine, path, method) => {
    expect(installMethodOf(engine, path, "/home/u")).toBe(method)
  })
})

describe("update plan", () => {
  test("codex is pinned to the newest otter-supported version with the tool that installed it", () => {
    expect(planEngineUpdate(codex("npm", "0.150.0"), writable)).toEqual({ engine: "codex", action: "run", target, summary: `Codex CLI 0.150.0 → ${target} with npm`,
      choices: [{ argv: ["npm", "install", "-g", `@openai/codex@${target}`], label: `npm install -g @openai/codex@${target}` }] })
    expect(argvs(planEngineUpdate(codex("bun", "0.150.0"), writable))).toEqual([["bun", "add", "-g", `@openai/codex@${target}`]])
    expect(argvs(planEngineUpdate(codex("pnpm", "0.150.0"), writable))).toEqual([["pnpm", "add", "-g", `@openai/codex@${target}`]])
    expect(argvs(planEngineUpdate(codex("missing"), writable))).toEqual([["npm", "install", "-g", `@openai/codex@${target}`]])
    expect(planEngineUpdate(codex("npm", target), writable)).toMatchObject({ action: "current" })
  })

  test("a root-owned global npm folder (exit 243 / EACCES) gets a no-sudo user install first, sudo only as an alternative", () => {
    const plan = planEngineUpdate(codex("npm", "0.150.0"), rootOwned)
    expect(argvs(plan)).toEqual([
      ["npm", "install", "-g", "--prefix", "/home/u/.local", `@openai/codex@${target}`],
      ["sudo", "npm", "install", "-g", `@openai/codex@${target}`],
    ])
    expect(plan.action === "run" && plan.choices[0]!.label).toBe("install for your user only (/home/u/.local/bin, no sudo)")
    expect(argvs(planEngineUpdate(codex("missing"), rootOwned))[0]).toEqual(["npm", "install", "-g", "--prefix", "/home/u/.local", `@openai/codex@${target}`])
    // bun/pnpm install per user already; no sudo variant.
    expect(argvs(planEngineUpdate(codex("bun", "0.150.0"), rootOwned))).toEqual([["bun", "add", "-g", `@openai/codex@${target}`]])
  })

  test("claude from a root-owned npm folder prefers the vendor's native installer (no sudo)", () => {
    expect(argvs(planEngineUpdate(claude("npm"), rootOwned))).toEqual([
      ["/x/claude", "install", "stable"],
      ["npm", "install", "-g", "--prefix", "/home/u/.local", "@anthropic-ai/claude-code@stable"],
      ["sudo", "npm", "install", "-g", "@anthropic-ai/claude-code@stable"],
    ])
  })

  test("a newer unqualified codex is a stated downgrade", () => {
    expect(planEngineUpdate(codex("npm", "0.170.0"), writable)).toMatchObject({ action: "run", summary: `Codex CLI downgrade 0.170.0 → ${target} (newer releases are not otter-qualified yet) with npm` })
  })

  test("a Homebrew codex upgrades only to a supported cask version; otherwise it says how to switch to npm", () => {
    expect(planEngineUpdate(codex("homebrew", "0.150.0"), { ...writable, brewVersion: () => target })).toMatchObject({ action: "run", target, choices: [{ argv: ["brew", "upgrade", "--cask", "codex"] }] })
    const unsupported = planEngineUpdate(codex("homebrew", "0.150.0"), { ...writable, brewVersion: () => "0.170.0" })
    expect(unsupported).toMatchObject({ action: "manual" })
    expect(unsupported.summary).toContain(`brew uninstall --cask codex && npm install -g @openai/codex@${target}`)
    expect(planEngineUpdate(codex("unknown", "0.150.0"), writable).action).toBe("manual")
  })

  test("claude follows the vendor's stable channel or its own updater", () => {
    expect(argvs(planEngineUpdate(claude("npm"), writable))).toEqual([["npm", "install", "-g", "@anthropic-ai/claude-code@stable"]])
    expect(argvs(planEngineUpdate(claude("homebrew"), writable))).toEqual([["brew", "upgrade", "--cask", "claude-code"]])
    expect(argvs(planEngineUpdate(claude("native"), writable))).toEqual([["/x/claude", "update"]])
    expect(argvs(planEngineUpdate({ engine: "claude", method: "missing" }, writable))).toEqual([["npm", "install", "-g", "@anthropic-ai/claude-code@stable"]])
  })

  test("descriptions name the version, support and the next step", () => {
    expect(describeEngine(codex("homebrew", target), planEngineUpdate(codex("homebrew", target), writable))).toBe(`codex: ${target} (otter-supported) · homebrew\n    Codex CLI ${target} is the newest version otter supports`)
    expect(describeEngine({ engine: "codex", method: "missing" }, planEngineUpdate({ engine: "codex", method: "missing" }, writable))).toStartWith("codex: not installed\n    update: install Codex CLI")
  })
})

describe("executable permission diagnostics", () => {
  test.each(["codex", "claude"] as const)("%s with no execute permission is not treated as missing", engine => {
    const root = mkdtempSync(join(tmpdir(), "otter-engine-permissions-"))
    const executable = join(root, engine)
    const savedPath = process.env.PATH
    writeFileSync(executable, "#!/bin/sh\nexit 0\n")
    chmodSync(executable, 0o644)
    try {
      process.env.PATH = root
      const info = engineInfo(engine)
      expect(info).toEqual({ engine, method: "missing", failure: "permission-denied" })

      const plan = planEngineUpdate(info, writable)
      expect(plan).toMatchObject({ engine, action: "manual" })
      expect(argvs(plan)).toEqual([])
      if (plan.action === "manual") {
        expect(plan.summary).toContain("permission denied")
        expect(plan.summary).toContain("correct them manually")
        expect(plan.summary).not.toContain("install")
      }
      const description = describeEngine(info, plan)
      expect(description).toContain("permission denied")
      expect(description).not.toContain("not installed")
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("after the update", () => {
  test("failures are named: npm EACCES (243), missing tool, signal", () => {
    expect(describeUpdateFailure(["npm", "install", "-g", "x"], { exitCode: 243, signal: null })).toBe("exit 243: npm could not write its global folder (permission denied, EACCES)")
    expect(describeUpdateFailure(["npm"], { exitCode: null, signal: null })).toBe("npm could not be started (not installed or not on PATH)")
    expect(describeUpdateFailure(["brew"], { exitCode: 127, signal: null })).toBe("exit 127: brew was not found")
    expect(describeUpdateFailure(["npm"], { exitCode: 1, signal: "SIGINT" })).toBe("stopped by SIGINT")
    expect(describeUpdateFailure(["npm"], { exitCode: 1, signal: null })).toBe("exit 1")
  })

  test("a new user-level copy that PATH does not reach yet is reported as shadowed", () => {
    const root = mkdtempSync(join(tmpdir(), "otter-shadow-"))
    const system = join(root, "system")
    const prefix = join(root, "home", ".local")
    mkdirSync(system, { recursive: true })
    mkdirSync(join(prefix, "bin"), { recursive: true })
    writeFileSync(join(system, "codex"), "#!/bin/sh\necho 'codex-cli 0.150.0'\n")
    writeFileSync(join(prefix, "bin", "codex"), `#!/bin/sh\necho 'codex-cli ${target}'\n`)
    chmodSync(join(system, "codex"), 0o755)
    chmodSync(join(prefix, "bin", "codex"), 0o755)
    const saved = process.env.PATH
    try {
      process.env.PATH = `${system}:/usr/bin:/bin`
      expect(verifyEngineUpdate("codex", prefix)).toMatchObject({ info: { version: "0.150.0" }, shadowed: { path: join(prefix, "bin", "codex"), version: target } })
      process.env.PATH = `${join(prefix, "bin")}:${system}:/usr/bin:/bin`
      const reached = verifyEngineUpdate("codex", prefix)
      expect(reached.info.version).toBe(target)
      expect(reached.shadowed).toBeUndefined()
    } finally { process.env.PATH = saved }
  })

  test("a read-only global npm folder is detected", () => {
    const prefix = mkdtempSync(join(tmpdir(), "otter-npm-prefix-"))
    mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true })
    expect(npmGlobalWritable(prefix)).toBe(true)
    chmodSync(join(prefix, "lib", "node_modules"), 0o555)
    try { expect(npmGlobalWritable(prefix)).toBe(false) } finally { chmodSync(join(prefix, "lib", "node_modules"), 0o755) }
  })
})

test("version comparison is numeric and puts pre-releases first", () => {
  expect(compareVersions("0.163.0", "0.159.3")).toBeGreaterThan(0)
  expect(compareVersions("0.99.0", "0.100.0")).toBeLessThan(0)
  expect(compareVersions("0.164.0-alpha.8", "0.164.0")).toBeLessThan(0)
  expect(compareVersions("0.163.0", "0.163.0")).toBe(0)
})
