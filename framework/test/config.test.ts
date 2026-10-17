import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { chatIntentMode, chatWorktreeMode, ConfigError, DEFAULT_CONFIG, loadConfig, parseJsonc, projectConfigPath, userConfigPath } from "../src/config.ts"

let root: string
let worktree: string
let previousXdg: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otter-config-admission-"))
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
function refused(path: string, kind: string) {
  let error: unknown
  try { loadConfig(worktree) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(ConfigError)
  expect(error).toMatchObject({ path, kind })
  expect((error as Error).message).toBe(`otter: config ${path}: ${kind}`)
}

describe("chat.intent", () => {
  test("absent means offer; off is accepted; any other value is refused at load", () => {
    expect(chatIntentMode(loadConfig(worktree))).toBe("offer")
    put(projectConfigPath(worktree), '{"chat":{"intent":"off"}}')
    expect(chatIntentMode(loadConfig(worktree))).toBe("off")
    put(projectConfigPath(worktree), '{"chat":{"intent":"always"}}')
    refused(projectConfigPath(worktree), "invalid-chat-intent")
    expect(DEFAULT_CONFIG.chat).toEqual({})
  })
})

describe("chat.worktree", () => {
  test("absent means plan; off is accepted; any other value is refused at load; the default config stays policy-neutral", () => {
    expect(chatWorktreeMode(loadConfig(worktree))).toBe("plan")
    put(projectConfigPath(worktree), '{"chat":{"worktree":"off"}}')
    expect(chatWorktreeMode(loadConfig(worktree))).toBe("off")
    put(projectConfigPath(worktree), '{"chat":{"worktree":"task"}}')
    refused(projectConfigPath(worktree), "invalid-chat-worktree")
    expect(DEFAULT_CONFIG.chat).toEqual({})
    expect(DEFAULT_CONFIG.delegate.worktree).toBe(false)
  })
})

describe("explicit verifier configuration", () => {
  test("JSONC comments never rewrite string literals into a valid verifier selector", () => {
    const path = projectConfigPath(worktree)
    put(path, '{"delegate":{"verifier":"linux-/*literal*/single-use"}}')
    refused(path, "invalid-verifier-selector")
    expect(parseJsonc<Record<string, unknown>>('{"literal":"a,}/*b*/ //c", // comment\n"enabled":true,}'))
      .toEqual({ literal: "a,}/*b*/ //c", enabled: true })
    expect(() => parseJsonc('{"delegate": }')).toThrow(SyntaxError)
  })

  test("project overrides user selection without mutating bundled defaults", () => {
    put(userConfigPath(), '{"delegate":{"verifier":"linux-single-use","review":false}}')
    put(projectConfigPath(worktree), '{"delegate":{"verifier":"legacy-unowned"}}')
    expect(loadConfig(worktree).delegate).toMatchObject({ verifier: "legacy-unowned", review: false })
    expect(DEFAULT_CONFIG.delegate.review).toBe(true)
    expect(DEFAULT_CONFIG.delegate.verifier).toBe("legacy-unowned")
  })

  test("an absent selector preserves a valid earlier opt-in; a valid absent setting uses legacy", () => {
    put(projectConfigPath(worktree), '{"delegate":{"review":false}}')
    expect(loadConfig(worktree).delegate.verifier).toBe("legacy-unowned")
    put(userConfigPath(), '{"delegate":{"verifier":"linux-single-use"}}')
    expect(loadConfig(worktree).delegate.verifier).toBe("linux-single-use")
  })

  for (const scope of ["user", "project"] as const) {
    test(`${scope} malformed or non-object configuration refuses without disclosing contents`, () => {
      const path = scope === "user" ? userConfigPath() : projectConfigPath(worktree)
      for (const text of ['{"private":"sensitive-config-sentinel", broken', "null", "[]", '"sensitive-config-sentinel"']) {
        put(path, text)
        const before = readFileSync(path)
        refused(path, "invalid-jsonc")
        expect(readFileSync(path)).toEqual(before)
      }
    })

    test(`${scope} invalid verifier selector never silently chooses legacy`, () => {
      const path = scope === "user" ? userConfigPath() : projectConfigPath(worktree)
      for (const value of ["sensitive-config-sentinel", "", null, false, 1, {}]) {
        put(path, JSON.stringify({ delegate: { verifier: value } }))
        refused(path, "invalid-verifier-selector")
      }
      for (const delegate of [null, [], "invalid"]) {
        put(path, JSON.stringify({ delegate }))
        refused(path, "invalid-verifier-selector")
      }
    })

    test(`${scope} directory or non-directory ancestor is not an absent configuration`, () => {
      const path = scope === "user" ? userConfigPath() : projectConfigPath(worktree)
      mkdirSync(path, { recursive: true })
      refused(path, "not-a-file")
      rmSync(dirname(path), { recursive: true })
      writeFileSync(dirname(path), "not a directory")
      refused(path, "not-a-file")
    })

    test(`${scope} dangling configuration link is unreadable, not missing`, () => {
      const path = scope === "user" ? userConfigPath() : projectConfigPath(worktree)
      mkdirSync(dirname(path), { recursive: true })
      symlinkSync(join(root, "missing-target"), path)
      refused(path, "unreadable")
    })

    test(`${scope} dangling ancestor cannot hide configuration but a valid linked directory may be empty`, () => {
      const path = scope === "user" ? userConfigPath() : projectConfigPath(worktree)
      const target = join(root, "config-target")
      mkdirSync(dirname(dirname(path)), { recursive: true })
      symlinkSync(target, dirname(path))
      refused(path, "unreadable")
      mkdirSync(target)
      expect(loadConfig(worktree).delegate.verifier).toBe("legacy-unowned")
    })

    test.skipIf(process.getuid?.() === 0)(`${scope} unreadable file and inaccessible ancestor cannot hide an opt-in`, () => {
      const path = scope === "user" ? userConfigPath() : projectConfigPath(worktree)
      put(path, '{"delegate":{"verifier":"linux-single-use"}}')
      chmodSync(path, 0)
      try { refused(path, "unreadable") } finally { chmodSync(path, 0o600) }
      chmodSync(dirname(path), 0)
      try { refused(path, "unreadable") } finally { chmodSync(dirname(path), 0o700) }
    })
  }
})
