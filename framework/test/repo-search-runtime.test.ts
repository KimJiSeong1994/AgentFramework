import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGraphRuntime } from "../src/repo-search/runtime.ts"
import { buildRepoSearchIndex, queryRepoSearch } from "../src/repo-search/store.ts"

// Full-suite runs do not silently install dependencies. Explicit runtime qualification
// uses OTTER_REPO_SEARCH_RUNTIME_TEST=1 and fails when prerequisites are missing.
describe.skipIf(process.env.OTTER_REPO_SEARCH_RUNTIME_TEST !== "1")("real pinned Graphify execution", () => {
  test("approved real index refuses dirty state until an explicit refresh", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-search-e2e-")))
    const worktree = join(root, "worktree")
    const storageRoot = join(root, "store")
    mkdirSync(join(worktree, "src"), { recursive: true })
    const source = join(worktree, "src/session.ts")
    writeFileSync(source, "export function authenticateSession(token: string) { return token.length > 0 }\n")
    for (const args of [["init", "--quiet"], ["add", "--", "src/session.ts"]]) {
      execFileSync("/usr/bin/git", args, { cwd: worktree, env: { PATH: "/usr/bin:/bin", HOME: "/", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "ignore" })
    }
    try {
      const runtime = createGraphRuntime()
      const first = await buildRepoSearchIndex(worktree, ["src"], { approve: true, storageRoot, runtime })
      expect(await queryRepoSearch(worktree, runtime, { query: "authenticateSession" }, undefined, storageRoot)).toContain("authenticateSession")
      writeFileSync(source, "export function revokeSession(token: string) { return token.length === 0 }\n")
      await expect(queryRepoSearch(worktree, runtime, { query: "authenticateSession" }, undefined, storageRoot)).rejects.toThrow("repo_search_stale")
      const refreshed = await buildRepoSearchIndex(worktree, ["src"], { approve: true, storageRoot, runtime })
      expect(refreshed.generationId).not.toBe(first.generationId)
      const result = await queryRepoSearch(worktree, runtime, { query: "revokeSession" }, undefined, storageRoot)
      expect(result).toContain("revokeSession")
      expect(result).not.toContain("authenticateSession")
    } finally {
      const writable = (path: string) => {
        chmodSync(path, 0o700)
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name)
          if (entry.isDirectory()) writable(child)
          else if (entry.isFile()) chmodSync(child, 0o600)
        }
      }
      writable(root)
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)

  test("AST build, TS/Python retrieval, read-only query and cancellation", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-search-runtime-")))
    try {
      const input = join(root, "input")
      const output = join(root, "output")
      mkdirSync(input); mkdirSync(output)
      writeFileSync(join(input, "session.ts"), `export function authenticateSession(token: string): boolean { return token.length > 0 }\nexport function refreshSession(token: string): boolean { return authenticateSession(token) }\n`)
      writeFileSync(join(input, "invoice.py"), `def calculate_invoice_total(prices):\n    return sum(prices)\n`)
      const runtime = createGraphRuntime()
      await runtime.build(input, output)
      const graph = join(output, "graph.json")
      const before = readFileSync(graph)
      const ts = await runtime.query(graph, "authenticateSession", 5)
      expect(ts.some(hit => hit.path === "session.ts" && hit.symbol.includes("authenticateSession"))).toBe(true)
      const py = await runtime.query(graph, "calculate_invoice_total", 5)
      expect(py.some(hit => hit.path === "invoice.py" && hit.symbol.includes("calculate_invoice_total"))).toBe(true)
      expect(readFileSync(graph).equals(before)).toBe(true)
      expect(ts.every(hit => hit.line === undefined || hit.line > 0)).toBe(true)
      const controller = new AbortController()
      controller.abort()
      await expect(runtime.query(graph, "authenticateSession", 5, controller.signal)).rejects.toThrow("cancelled")
      await expect(runtime.query(graph, "", 5)).rejects.toThrow("invalid_query")
      await expect(runtime.query(graph, "session", 11)).rejects.toThrow("invalid_query")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
