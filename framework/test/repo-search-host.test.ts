import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, renameSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliTools, type CliToolsOptions } from "../src/hosts/cli-tools.ts"

let directory: string
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "repo-search-host-"))) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }); rmSync(`${directory}-moved`, { recursive: true, force: true }) })
function tools(provider?: CliToolsOptions["repoSearchProvider"], role: CliToolsOptions["role"] = "main") {
  return createCliTools({ root: directory, role, allowed: ["repo_search"], denied: [], repoSearchProvider: provider })
}

test("a policy grant alone or a provider on a non-main role cannot invoke search", async () => {
  let calls = 0
  const provider = async () => { calls++; return "unexpected" }
  for (const candidate of [tools(), tools(provider, "worker"), tools(provider, "planner")]) {
    expect(candidate.available).not.toContain("repo_search")
    expect((await candidate.repoSearch({ query: "session" }, new AbortController().signal)).ok).toBe(false)
  }
  expect(calls).toBe(0)
})

test("query validation prevents provider effects and synchronous dispatch refuses query", async () => {
  let calls = 0
  const candidate = tools(async () => { calls++; return "hint" })
  for (const input of [{ query: "x", path: "/tmp/other" }, { query: "x", refresh: true }, { query: "x", limit: 11 }, { query: "한".repeat(683) }]) {
    expect((await candidate.repoSearch(input, new AbortController().signal)).ok).toBe(false)
  }
  expect(candidate.execute("repo_search", { query: "x" }).ok).toBe(false)
  expect(calls).toBe(0)
})

test("stale status remains explicit without exposing arbitrary internal errors", async () => {
  const stale = await tools(async () => { throw new Error("repo_search_stale") }).repoSearch({ query: "x" }, new AbortController().signal)
  expect(stale).toEqual({ ok: false, error: "Repository search unavailable: repo_search_stale. No automatic rebuild was performed." })
  const hidden = await tools(async () => { throw new Error("/Users/private/credentials") }).repoSearch({ query: "x" }, new AbortController().signal)
  expect(JSON.stringify(hidden)).not.toContain("credentials")
})

test("query output is untrusted, bounded valid UTF-8 and cannot survive cancellation", async () => {
  const output = await tools(async () => "한".repeat(5000)).repoSearch({ query: "x" }, new AbortController().signal)
  expect(output.ok).toBe(true)
  if (output.ok) {
    expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(8192)
    expect(output.text).toContain("Untrusted")
    expect(output.text).not.toContain("�")
    expect(output.text).toContain("truncated")
  }
  const abort = new AbortController()
  const result = await tools(async () => { abort.abort(); return "late result" }).repoSearch({ query: "x" }, abort.signal)
  expect(result.ok).toBe(false)
  expect(JSON.stringify(result)).toContain("repo_search_cancelled")
})

test("replacing the worktree while the provider runs refuses its result", async () => {
  const result = await tools(async () => {
    renameSync(directory, `${directory}-moved`)
    mkdirSync(directory)
    return "stale root hint"
  }).repoSearch({ query: "x" }, new AbortController().signal)
  expect(result.ok).toBe(false)
  expect(JSON.stringify(result)).not.toContain("stale root hint")
})
