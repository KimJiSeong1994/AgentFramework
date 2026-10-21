import { describe, expect, test } from "bun:test"
import { CODEX_SUPPORTED_VERSIONS } from "../src/hosts/codex-profile.ts"
import { compareVersions, describeEngine, installMethodOf, planEngineUpdate, type EngineInfo } from "../src/hosts/engine-update.ts"

const target = CODEX_SUPPORTED_VERSIONS.at(-1)!
const codex = (method: EngineInfo["method"], version?: string): EngineInfo =>
  ({ engine: "codex", method, ...(version ? { version } : {}), path: "/x/codex", supported: version !== undefined && (CODEX_SUPPORTED_VERSIONS as readonly string[]).includes(version) })
const claude = (method: EngineInfo["method"], version = "2.1.301"): EngineInfo => ({ engine: "claude", method, version, path: "/x/claude" })

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
    expect(planEngineUpdate(codex("npm", "0.150.0"))).toEqual({ engine: "codex", action: "run", argv: ["npm", "install", "-g", `@openai/codex@${target}`], target, summary: `Codex CLI 0.150.0 → ${target} with npm` })
    expect(planEngineUpdate(codex("bun", "0.150.0"))).toMatchObject({ action: "run", argv: ["bun", "add", "-g", `@openai/codex@${target}`] })
    expect(planEngineUpdate(codex("pnpm", "0.150.0"))).toMatchObject({ action: "run", argv: ["pnpm", "add", "-g", `@openai/codex@${target}`] })
    expect(planEngineUpdate(codex("missing"))).toMatchObject({ action: "run", argv: ["npm", "install", "-g", `@openai/codex@${target}`] })
    expect(planEngineUpdate(codex("npm", target))).toMatchObject({ action: "current" })
  })

  test("a newer unqualified codex is a stated downgrade", () => {
    expect(planEngineUpdate(codex("npm", "0.170.0"))).toMatchObject({ action: "run", summary: `Codex CLI downgrade 0.170.0 → ${target} (newer releases are not otter-qualified yet) with npm` })
  })

  test("a Homebrew codex upgrades only to a supported cask version; otherwise it says how to switch to npm", () => {
    expect(planEngineUpdate(codex("homebrew", "0.150.0"), () => target)).toEqual({ engine: "codex", action: "run", argv: ["brew", "upgrade", "--cask", "codex"], target, summary: `Codex CLI 0.150.0 → ${target} with Homebrew` })
    const unsupported = planEngineUpdate(codex("homebrew", "0.150.0"), () => "0.170.0")
    expect(unsupported).toMatchObject({ action: "manual" })
    expect(unsupported.summary).toContain(`brew uninstall --cask codex && npm install -g @openai/codex@${target}`)
    expect(planEngineUpdate(codex("unknown", "0.150.0")).action).toBe("manual")
  })

  test("claude follows the vendor's stable channel or its own updater", () => {
    expect(planEngineUpdate(claude("npm"))).toMatchObject({ action: "run", argv: ["npm", "install", "-g", "@anthropic-ai/claude-code@stable"] })
    expect(planEngineUpdate(claude("homebrew"))).toMatchObject({ action: "run", argv: ["brew", "upgrade", "--cask", "claude-code"] })
    expect(planEngineUpdate(claude("native"))).toMatchObject({ action: "run", argv: ["/x/claude", "update"] })
    expect(planEngineUpdate({ engine: "claude", method: "missing" })).toMatchObject({ action: "run", argv: ["npm", "install", "-g", "@anthropic-ai/claude-code@stable"] })
  })

  test("descriptions name the version, support and the next step", () => {
    expect(describeEngine(codex("homebrew", target), planEngineUpdate(codex("homebrew", target)))).toBe(`codex: ${target} (otter-supported) · homebrew\n    Codex CLI ${target} is the newest version otter supports`)
    expect(describeEngine({ engine: "codex", method: "missing" }, planEngineUpdate({ engine: "codex", method: "missing" }))).toStartWith("codex: not installed\n    update: install Codex CLI")
  })
})

test("version comparison is numeric and puts pre-releases first", () => {
  expect(compareVersions("0.163.0", "0.159.3")).toBeGreaterThan(0)
  expect(compareVersions("0.99.0", "0.100.0")).toBeLessThan(0)
  expect(compareVersions("0.164.0-alpha.8", "0.164.0")).toBeLessThan(0)
  expect(compareVersions("0.163.0", "0.163.0")).toBe(0)
})
