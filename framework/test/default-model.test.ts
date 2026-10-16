import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { projectConfigPath, userConfigPath } from "../src/config.ts"
import { clearDefaultModel, readDefaultModel, saveDefaultModel, validateDefaultModel } from "../src/hosts/default-model.ts"

let root: string
let worktree: string
let previousXdg: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lca-default-model-"))
  worktree = join(root, "worktree")
  mkdirSync(worktree)
  previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(root, "config")
})
afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdg
  rmSync(root, { recursive: true, force: true })
})
function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe("chat.default_model", () => {
  test("is unset by default and validates engine and model", () => {
    expect(readDefaultModel(worktree)).toEqual({ state: "unset" })
    expect(validateDefaultModel({ engine: "local", model: "gemma4:31b" })).toEqual({ engine: "local", model: "gemma4:31b" })
    expect(validateDefaultModel({ engine: "opencode", model: "x" })).toContain("engine")
    expect(validateDefaultModel({ engine: "local", model: "two words" })).toContain("model")
    expect(validateDefaultModel("local/gemma")).toContain("object")
  })

  test("reads user config, lets the project win, and treats null as unset", () => {
    put(userConfigPath(), '{ "chat": { "default_model": { "engine": "local", "model": "user-model" } } }')
    expect(readDefaultModel(worktree)).toEqual({ state: "configured", value: { engine: "local", model: "user-model" }, source: "user" })
    put(projectConfigPath(worktree), '{ "chat": { "default_model": { "engine": "codex", "model": "gpt-5-codex" } } }')
    expect(readDefaultModel(worktree)).toEqual({ state: "configured", value: { engine: "codex", model: "gpt-5-codex" }, source: "project" })
    put(projectConfigPath(worktree), '{ "chat": { "default_model": null } }')
    expect(readDefaultModel(worktree)).toEqual({ state: "unset" })
  })

  test("reports invalid values and unreadable config without throwing", () => {
    put(userConfigPath(), '{ "chat": { "default_model": { "engine": "local", "model": "-rf" } } }')
    expect(readDefaultModel(worktree)).toMatchObject({ state: "invalid", reason: expect.stringContaining("model") })
    put(userConfigPath(), "{ not json")
    expect(readDefaultModel(worktree)).toMatchObject({ state: "invalid", reason: expect.stringContaining("invalid-jsonc") })
  })

  test("save writes only the default key, preserves comments, and clear removes it", () => {
    put(userConfigPath(), '{\n  // keep me\n  "skill_router": { "mode": "suggest" },\n}\n')
    expect(saveDefaultModel({ engine: "local", model: "gemma4-26b-mtp:latest" })).toBe(userConfigPath())
    const saved = readFileSync(userConfigPath(), "utf8")
    expect(saved).toContain("// keep me")
    expect(saved).toContain('"skill_router"')
    expect(readDefaultModel(worktree)).toEqual({ state: "configured", value: { engine: "local", model: "gemma4-26b-mtp:latest" }, source: "user" })
    expect(statSync(userConfigPath()).mode & 0o777).toBe(0o600)

    expect(clearDefaultModel()).toBe(true)
    expect(readDefaultModel(worktree)).toEqual({ state: "unset" })
    expect(readFileSync(userConfigPath(), "utf8")).toContain("// keep me")
    expect(clearDefaultModel()).toBe(false)
  })

  test("save creates a missing user config and refuses to overwrite invalid JSONC", () => {
    saveDefaultModel({ engine: "claude", model: "sonnet" })
    expect(readDefaultModel(worktree)).toMatchObject({ state: "configured", value: { engine: "claude", model: "sonnet" } })
    put(userConfigPath(), "{ broken")
    expect(() => saveDefaultModel({ engine: "local", model: "x" })).toThrow("invalid-jsonc")
    expect(readFileSync(userConfigPath(), "utf8")).toBe("{ broken")
  })
})
