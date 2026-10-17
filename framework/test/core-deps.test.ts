import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import type { CoreDeps } from "../src/deps.ts"
import { getBackend } from "../src/data/backend.ts"
import { getGuards } from "../src/guards/registry.ts"

let worktree: string
let deps: CoreDeps

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "otter-core-deps-"))
  const config = structuredClone(DEFAULT_CONFIG)
  config.data.backend = "sqlite"
  config.data.sqlite_path = join(worktree, "test.sqlite")
  deps = { directory: worktree, worktree, config, log() {} }
})

afterEach(() => rmSync(worktree, { recursive: true, force: true }))

function createDatabase(): void {
  const db = new Database(deps.config.data.sqlite_path, { create: true })
  db.exec("CREATE TABLE values_for_test (value INTEGER); INSERT INTO values_for_test VALUES (7)")
  db.close()
}

test("guard state is shared only by dependency-object identity without a host client", () => {
  const first = getGuards(deps)
  first.lastContinuation.set("session", 123)
  expect(getGuards(deps)).toBe(first)
  expect(getGuards(deps).lastContinuation.get("session")).toBe(123)
  const separate = getGuards({ ...deps })
  expect(separate).not.toBe(first)
  expect(separate.repeat).not.toBe(first.repeat)
  expect(separate.repetition).not.toBe(first.repetition)
  expect(separate.lastContinuation.has("session")).toBe(false)
})

test("database backends preserve dependency-object identity without a host client", async () => {
  createDatabase()
  const first = getBackend(deps)
  expect(getBackend(deps)).toBe(first)
  expect(getBackend({ ...deps })).not.toBe(first)
  const result = await first.query("SELECT value FROM values_for_test", { timeoutMs: 2000, maxRows: 10 })
  expect(result.columns).toEqual(["value"])
  expect(result.rows).toEqual([[7]])
})

test("failed backend creation does not poison the dependency cache", () => {
  expect(() => getBackend(deps)).toThrow("sqlite file not found")
  createDatabase()
  const backend = getBackend(deps)
  expect(getBackend(deps)).toBe(backend)
})

test("disabled data backend is refused without a host client", () => {
  deps.config.data.backend = "none"
  expect(() => getBackend(deps)).toThrow("no database backend configured")
})
