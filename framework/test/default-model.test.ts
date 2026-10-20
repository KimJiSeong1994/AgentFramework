import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { projectConfigPath, userConfigPath } from "../src/config.ts"
import { clearCombo, clearComboRole, clearDefaultModel, fileComboStore, readCombo, readDefaultModel, saveCombo, saveComboRole, saveDefaultModel, validateComboRoutes, validateDefaultModel } from "../src/hosts/default-model.ts"

let root: string
let worktree: string
let previousXdg: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otter-default-model-"))
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

describe("chat.combo", () => {
  test("validates roles, engines and model IDs and never routes main", () => {
    expect(validateComboRoutes({ planner: { engine: "claude", model: "opus" } })).toEqual({ planner: { engine: "claude", model: "opus" } })
    expect(validateComboRoutes({})).toEqual({})
    expect(validateComboRoutes("x")).toContain("object")
    expect(validateComboRoutes({ main: { engine: "claude", model: "opus" } })).toContain("main")
    expect(validateComboRoutes({ nope: { engine: "claude", model: "opus" } })).toContain("nope")
    expect(validateComboRoutes({ planner: { engine: "opencode", model: "x" } })).toContain("engine")
    expect(validateComboRoutes({ planner: { engine: "local", model: "-rf" } })).toContain("model")
    expect(validateComboRoutes({ planner: { engine: "local", model: "a b" } })).toContain("model")
    expect(validateComboRoutes({ planner: "claude/opus" })).toContain("planner")
  })

  test("rejects ids the host regex rejects and Codex slugs the bundled catalog does not know", () => {
    const ok = ["gpt-5.6-sol", "qwen3-coder:30b", "provider/namespace:model", "a@b+c", "x".repeat(256)]
    for (const model of ok) expect(typeof validateComboRoutes({ planner: { engine: "local", model } })).toBe("object")
    const bad = ["", "-rf", "a b", "a\\b", "é", "x".repeat(257), ".dot", "a$b", "a;b", "a\nb"]
    for (const model of bad) expect(validateComboRoutes({ planner: { engine: "local", model } })).toContain("planner.model")
    expect(validateComboRoutes({ architect: { engine: "codex", model: "gpt-5.6-sol" } })).toEqual({ architect: { engine: "codex", model: "gpt-5.6-sol" } })
    expect(validateComboRoutes({ architect: { engine: "codex", model: "gpt-typo" } })).toContain("architect.model")
    expect(validateComboRoutes({ architect: { engine: "claude", model: "gpt-typo" } })).toEqual({ architect: { engine: "claude", model: "gpt-typo" } })
    put(userConfigPath(), '{ "chat": { "combo": { "architect": { "engine": "codex", "model": "gpt-typo" } } } }')
    expect(readCombo(worktree)).toMatchObject({ state: "invalid", reason: expect.stringContaining("gpt-typo") })
  })

  test("a partial project route is invalid instead of merging into the user route; project null removes it", () => {
    put(userConfigPath(), '{ "chat": { "combo": { "worker": { "engine": "local", "model": "qwen3" }, "planner": { "engine": "claude", "model": "opus" } } } }')
    put(projectConfigPath(worktree), '{ "chat": { "combo": { "worker": { "engine": "codex" } } } }')
    expect(readCombo(worktree)).toMatchObject({ state: "invalid", reason: expect.stringContaining("worker.model") })
    expect(readCombo(worktree)).toMatchObject({ reason: expect.stringContaining("(from the project .otter/otter.jsonc)") })
    put(projectConfigPath(worktree), '{ "chat": { "combo": { "worker": { "model": "other" } } } }')
    expect(readCombo(worktree)).toMatchObject({ state: "invalid", reason: expect.stringContaining("worker.engine") })
    put(projectConfigPath(worktree), '{ "chat": { "combo": { "worker": { "engine": "claude", "model": "sonnet" } } } }')
    expect(readCombo(worktree)).toEqual({
      state: "configured",
      routes: { planner: { engine: "claude", model: "opus" }, worker: { engine: "claude", model: "sonnet" } },
      sources: { planner: "user", worker: "project" },
    })
    put(projectConfigPath(worktree), '{ "chat": { "combo": { "worker": null } } }')
    expect(readCombo(worktree)).toEqual({ state: "configured", routes: { planner: { engine: "claude", model: "opus" } }, sources: { planner: "user" } })
  })

  test("clear removes a non-object combo from the user config", () => {
    put(userConfigPath(), '{ "chat": { "combo": "oops" } }')
    expect(readCombo(worktree)).toMatchObject({ state: "invalid" })
    expect(clearCombo()).toBe(true)
    expect(readCombo(worktree)).toEqual({ state: "unset" })
    put(userConfigPath(), '{ "chat": { "combo": { "planner": "oops" } } }')
    expect(clearComboRole("planner")).toBe(true)
    expect(readCombo(worktree)).toEqual({ state: "unset" })
  })

  test("is unset by default and reads per-role sources with project overriding single roles", () => {
    expect(readCombo(worktree)).toEqual({ state: "unset" })
    put(userConfigPath(), '{ "chat": { "combo": { "planner": { "engine": "claude", "model": "opus" }, "worker": { "engine": "local", "model": "qwen3-coder:30b" } } } }')
    expect(readCombo(worktree)).toEqual({
      state: "configured",
      routes: { planner: { engine: "claude", model: "opus" }, worker: { engine: "local", model: "qwen3-coder:30b" } },
      sources: { planner: "user", worker: "user" },
    })
    put(projectConfigPath(worktree), '{ "chat": { "combo": { "worker": { "engine": "codex", "model": "gpt-5.6-sol" }, "critic": { "engine": "claude", "model": "sonnet" } } } }')
    expect(readCombo(worktree)).toEqual({
      state: "configured",
      routes: {
        planner: { engine: "claude", model: "opus" },
        worker: { engine: "codex", model: "gpt-5.6-sol" },
        critic: { engine: "claude", model: "sonnet" },
      },
      sources: { planner: "user", worker: "project", critic: "project" },
    })
  })

  test("an invalid combo is reported whole and never partially applied", () => {
    put(userConfigPath(), '{ "chat": { "combo": { "planner": { "engine": "claude", "model": "opus" }, "critic": { "engine": "x", "model": "m" } } } }')
    expect(readCombo(worktree)).toMatchObject({ state: "invalid", reason: expect.stringContaining("critic") })
    put(userConfigPath(), '{ "chat": { "combo": { "main": { "engine": "claude", "model": "opus" } } } }')
    expect(readCombo(worktree)).toMatchObject({ state: "invalid" })
    put(userConfigPath(), "{ not json")
    expect(readCombo(worktree)).toMatchObject({ state: "invalid", reason: expect.stringContaining("invalid-jsonc") })
  })

  test("save preserves comments and sibling keys, clear removes one role or all", () => {
    put(userConfigPath(), '{\n  // keep me\n  "chat": { "default_model": { "engine": "local", "model": "g" } },\n}\n')
    expect(saveComboRole("architect", { engine: "codex", model: "gpt-5.6-sol" })).toBe(userConfigPath())
    saveComboRole("planner", { engine: "claude", model: "opus" })
    const saved = readFileSync(userConfigPath(), "utf8")
    expect(saved).toContain("// keep me")
    expect(saved).toContain('"default_model"')
    expect(statSync(userConfigPath()).mode & 0o777).toBe(0o600)
    expect(readCombo(worktree)).toMatchObject({ state: "configured", routes: { architect: { engine: "codex", model: "gpt-5.6-sol" }, planner: { engine: "claude", model: "opus" } } })

    expect(clearComboRole("architect")).toBe(true)
    expect(clearComboRole("architect")).toBe(false)
    expect(readCombo(worktree)).toMatchObject({ state: "configured", routes: { planner: { engine: "claude", model: "opus" } } })
    expect(clearCombo()).toBe(true)
    expect(clearCombo()).toBe(false)
    expect(readCombo(worktree)).toEqual({ state: "unset" })
    const after = readFileSync(userConfigPath(), "utf8")
    expect(after).toContain("// keep me")
    expect(after).toContain('"default_model"')
  })

  test("replace removes stale routes while preserving unrelated settings and comments", () => {
    put(userConfigPath(), '{\n  // keep me\n  "memory": { "engine": "off" },\n  "chat": {\n    // keep the default\n    "default_model": { "engine": "local", "model": "g" },\n    "combo": { "planner": { "engine": "claude", "model": "opus" }, "worker": { "engine": "local", "model": "old" } }\n  }\n}\n')
    const routes = { critic: { engine: "claude" as const, model: "sonnet" } }
    expect(fileComboStore.replace(routes)).toBe(userConfigPath())
    expect(readCombo(worktree)).toEqual({ state: "configured", routes, sources: { critic: "user" } })
    expect(readDefaultModel(worktree)).toMatchObject({ state: "configured", value: { engine: "local", model: "g" } })
    const saved = readFileSync(userConfigPath(), "utf8")
    expect(saved).toContain("// keep me")
    expect(saved).toContain("// keep the default")
    expect(saved).toContain('"memory": { "engine": "off" }')
    expect(statSync(userConfigPath()).mode & 0o777).toBe(0o600)
    saveCombo({})
    expect(readCombo(worktree)).toEqual({ state: "unset" })
  })

  test("replace preserves project overrides and null suppression without editing the project", () => {
    const project = '{ "chat": { "combo": { "planner": { "engine": "claude", "model": "opus" }, "worker": null } } }'
    put(projectConfigPath(worktree), project)
    saveCombo({
      planner: { engine: "local", model: "user-planner" },
      worker: { engine: "local", model: "user-worker" },
      critic: { engine: "claude", model: "sonnet" },
    })
    expect(readCombo(worktree)).toEqual({
      state: "configured",
      routes: { planner: { engine: "claude", model: "opus" }, critic: { engine: "claude", model: "sonnet" } },
      sources: { planner: "project", critic: "user" },
    })
    expect(readFileSync(projectConfigPath(worktree), "utf8")).toBe(project)
    put(projectConfigPath(worktree), '{ "chat": { "combo": null } }')
    saveCombo({ planner: { engine: "claude", model: "sonnet" } })
    expect(readCombo(worktree)).toEqual({ state: "unset" })
  })

  test("replace validates the whole map before writing and refuses invalid JSONC", () => {
    const original = '{ "chat": { "combo": { "worker": { "engine": "local", "model": "original" } } } }'
    put(userConfigPath(), original)
    expect(() => saveCombo({
      planner: { engine: "claude", model: "opus" },
      critic: { engine: "codex", model: "gpt-typo" },
    })).toThrow("critic.model")
    expect(readFileSync(userConfigPath(), "utf8")).toBe(original)
    expect(() => saveCombo({ main: { engine: "local", model: "x" } })).toThrow("main")
    expect(readFileSync(userConfigPath(), "utf8")).toBe(original)
    put(userConfigPath(), "{ broken")
    expect(() => saveCombo({ planner: { engine: "claude", model: "opus" } })).toThrow("invalid-jsonc")
    expect(readFileSync(userConfigPath(), "utf8")).toBe("{ broken")
  })

  test("save refuses invalid input and invalid JSONC without writing", () => {
    expect(() => saveComboRole("main" as never, { engine: "local", model: "x" })).toThrow("main")
    expect(() => saveComboRole("planner", { engine: "local", model: "-x" })).toThrow("model")
    put(userConfigPath(), "{ broken")
    expect(() => saveComboRole("planner", { engine: "local", model: "x" })).toThrow("invalid-jsonc")
    expect(() => clearCombo()).toThrow("invalid-jsonc")
    expect(readFileSync(userConfigPath(), "utf8")).toBe("{ broken")
  })
})
