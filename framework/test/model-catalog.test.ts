import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import process from "node:process"
import { createCodexProfile } from "../src/hosts/codex-profile.ts"
import { discoverModels } from "../src/hosts/model-catalog.ts"

const directories: string[] = []
const restoreEnvironment: Array<() => void> = []

const CODEX_SLUGS = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-daybreak-blue-latest",
  "gpt-daybreak-red-latest",
  "gpt-5.5",
  "codex-auto-review",
]

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function installFakeOllama(source: string): void {
  const directory = temporaryDirectory("model-catalog-bin-")
  const executable = join(directory, "ollama")
  const previousPath = process.env.PATH
  restoreEnvironment.push(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  })
  process.env.PATH = directory
  writeFileSync(executable, `#!${process.execPath}\n${source}\n`, { mode: 0o700 })
  chmodSync(executable, 0o700)
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  if (!existsSync(path)) throw new Error("fake Ollama did not start")
}

afterEach(() => {
  for (const restore of restoreEnvironment.splice(0).reverse()) restore()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("local discovery parses installed names, ignores unsafe rows, and deduplicates IDs", async () => {
  installFakeOllama(`
if (JSON.stringify(process.argv.slice(2)) !== '["list"]') process.exit(90)
process.stdout.write("NAME ID SIZE MODIFIED\\n")
process.stdout.write("gemma4:26b abcdef123456 17 GB 2 weeks ago\\n")
process.stdout.write("qwen3.6:35b-a3b fedcba654321 20 GB 3 days ago\\n")
process.stdout.write("gemma4:26b abcdef123456 17 GB 2 weeks ago\\n")
process.stdout.write("bad!id abcdef123456 1 GB today\\n")
`)
  const catalog = await discoverModels("local", temporaryDirectory("model-catalog-worktree-"))

  expect(catalog.models).toEqual([
    { id: "gemma4:26b", label: "gemma4:26b" },
    { id: "qwen3.6:35b-a3b", label: "qwen3.6:35b-a3b" },
  ])
  expect(catalog.notice).toContain("invalid Ollama list entries were omitted")
})

test("local discovery reports malformed listings without exposing their contents", async () => {
  installFakeOllama(`
if (JSON.stringify(process.argv.slice(2)) !== '["list"]') process.exit(90)
process.stdout.write("this is not an Ollama model table\\nprivate-output-secret\\n")
`)
  const catalog = await discoverModels("local", temporaryDirectory("model-catalog-worktree-"))

  expect(catalog.models).toEqual([])
  expect(catalog.notice).toContain("unexpected model-list format")
  expect(catalog.notice).not.toContain("private-output-secret")
})

test("local discovery rejects bounded-output truncation instead of returning a partial list", async () => {
  installFakeOllama(`
if (JSON.stringify(process.argv.slice(2)) !== '["list"]') process.exit(90)
process.stdout.write("NAME ID SIZE MODIFIED\\n" + "x".repeat(100000))
`)
  const catalog = await discoverModels("local", temporaryDirectory("model-catalog-worktree-"))

  expect(catalog.models).toEqual([])
  expect(catalog.notice).toContain("exceeded the safe output limit")
})

test("local discovery returns a fixed notice for command errors without echoing stderr", async () => {
  installFakeOllama(`
if (JSON.stringify(process.argv.slice(2)) !== '["list"]') process.exit(90)
process.stderr.write("private-token-secret\\n")
process.exitCode = 7
`)
  const catalog = await discoverModels("local", temporaryDirectory("model-catalog-worktree-"))

  expect(catalog.models).toEqual([])
  expect(catalog.notice).toContain("Check that Ollama is installed")
  expect(catalog.notice).not.toContain("private-token-secret")
})

test("local discovery distinguishes an empty installation from malformed output", async () => {
  installFakeOllama(`
if (JSON.stringify(process.argv.slice(2)) !== '["list"]') process.exit(90)
process.stdout.write("NAME ID SIZE MODIFIED\\n")
`)
  const catalog = await discoverModels("local", temporaryDirectory("model-catalog-worktree-"))

  expect(catalog.models).toEqual([])
  expect(catalog.notice).toContain("no installed models")
})

test("local discovery cancels its owned process when the signal aborts", async () => {
  const started = join(temporaryDirectory("model-catalog-marker-"), "started")
  installFakeOllama(`
const fs = require("node:fs")
if (JSON.stringify(process.argv.slice(2)) !== '["list"]') process.exit(90)
fs.writeFileSync(${JSON.stringify(started)}, "started")
setInterval(() => {}, 1000)
`)
  const controller = new AbortController()
  const pending = discoverModels("local", temporaryDirectory("model-catalog-worktree-"), controller.signal)
  await waitForPath(started)
  controller.abort()
  const catalog = await pending

  expect(catalog.models).toEqual([])
  expect(catalog.notice).toContain("discovery was cancelled")
})

test.each(["empty", "missing"])("local discovery reports unavailable executable with %s PATH", async (kind) => {
  const previousPath = process.env.PATH
  restoreEnvironment.push(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  })
  process.env.PATH = kind === "empty" ? "" : temporaryDirectory("model-catalog-no-cli-")

  const catalog = await discoverModels("local", temporaryDirectory("model-catalog-worktree-"))

  expect(catalog.models).toEqual([])
  expect(catalog.notice).toContain("Check that Ollama is installed")
})

test("already-cancelled discovery does not dispatch an executable", async () => {
  const marker = join(temporaryDirectory("model-catalog-cancel-marker-"), "dispatched")
  installFakeOllama(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected")`)
  const controller = new AbortController()
  controller.abort()

  const catalog = await discoverModels("local", temporaryDirectory("model-catalog-worktree-"), controller.signal)

  expect(catalog.models).toEqual([])
  expect(catalog.notice).toContain("discovery was cancelled")
  expect(existsSync(marker)).toBe(false)
})

test("Codex options are pinned bundled slugs with metadata labels, not account discovery", async () => {
  const catalog = await discoverModels("codex", "/worktree-is-not-needed-for-static-metadata")

  expect(catalog.models.map(({ id }) => id)).toEqual(CODEX_SLUGS)
  expect(catalog.models.map(({ label }) => label)).toEqual([
    "GPT-6-Astra",
    "GPT-6.1-Sol",
    "GPT-6-Sol",
    "GPT-6-Luna",
    "GPT-5.6-Sol",
    "GPT-5.6-Terra",
    "GPT-5.6-Luna",
    "Daybreak Blue",
    "Daybreak Red",
    "GPT-5.5",
    "Codex Auto Review",
  ])
  for (const { id } of catalog.models) expect(() => createCodexProfile(id)).not.toThrow()
  expect(catalog.notice).toContain("Codex 0.159.3")
  expect(catalog.notice).toContain("does not check account availability")
})

test("Claude options are explicitly labeled native aliases rather than entitlements", async () => {
  const catalog = await discoverModels("claude", "/worktree-is-not-needed-for-static-metadata")

  expect(catalog.models).toEqual([
    { id: "fable", label: "Fable (Claude CLI alias)" },
    { id: "sonnet", label: "Sonnet (Claude CLI alias)" },
    { id: "opus", label: "Opus (Claude CLI alias)" },
    { id: "haiku", label: "Haiku (Claude CLI alias)" },
  ])
  expect(catalog.notice).toContain("native Claude CLI aliases")
  expect(catalog.notice).toContain("not a fetched account-availability list")
})
