import { afterEach, beforeEach, expect, test } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureOwnedCodexHome, OwnedCodexHomeError, ownedCodexHomePath, realCodexHome } from "../src/hosts/codex-home.ts"

let root: string
const saved = { OTTER_STATE_HOME: process.env.OTTER_STATE_HOME, CODEX_HOME: process.env.CODEX_HOME }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otter-codex-home-"))
  process.env.OTTER_STATE_HOME = join(root, "state")
  process.env.CODEX_HOME = join(root, "real-codex")
  mkdirSync(process.env.CODEX_HOME)
})
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
})

test("realCodexHome follows an absolute CODEX_HOME and otherwise ~/.codex", () => {
  expect(realCodexHome({ CODEX_HOME: "/abs/codex" })).toBe("/abs/codex")
  expect(realCodexHome({ CODEX_HOME: "relative" })).toMatch(/\/\.codex$/u)
  expect(realCodexHome({})).toMatch(/\/\.codex$/u)
})

test("creates a private owned home holding only an auth.json symlink to the real sign-in file", () => {
  const owned = ensureOwnedCodexHome()
  expect(owned.path).toBe(realpathSync(ownedCodexHomePath()))
  expect(statSync(owned.path).mode & 0o777).toBe(0o700)
  expect(lstatSync(owned.authLink).isSymbolicLink()).toBe(true)
  expect(readlinkSync(owned.authLink)).toBe(join(process.env.CODEX_HOME!, "auth.json"))
  // Idempotent, and the link survives a dangling target (the user may not be signed in yet).
  expect(ensureOwnedCodexHome()).toEqual(owned)
})

test("re-points the link when the real Codex home changes", () => {
  const first = ensureOwnedCodexHome()
  process.env.CODEX_HOME = join(root, "other-codex")
  mkdirSync(process.env.CODEX_HOME)
  const second = ensureOwnedCodexHome()
  expect(second.path).toBe(first.path)
  expect(readlinkSync(second.authLink)).toBe(join(process.env.CODEX_HOME, "auth.json"))
})

test("refuses a regular auth.json (a credential copy) and instruction files placed in the owned home", () => {
  const owned = ensureOwnedCodexHome()
  rmSync(owned.authLink)
  writeFileSync(owned.authLink, "{}")
  expect(() => ensureOwnedCodexHome()).toThrow(OwnedCodexHomeError)
  rmSync(owned.authLink)
  writeFileSync(join(owned.path, "AGENTS.md"), "injected")
  expect(() => ensureOwnedCodexHome()).toThrow(/AGENTS\.md/u)
})
