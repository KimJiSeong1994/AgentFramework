import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import type { GraphHit, GraphRuntime } from "../src/repo-search/runtime.ts"
import { parseBuildCliArguments } from "../src/repo-search/build-cli.ts"
import { buildRepoSearchIndex, queryRepoSearch, repoSearchHasApprovedIndex } from "../src/repo-search/store.ts"

const sandboxes: string[] = []
const ROOTS = ["framework/src", "framework/test"]
const RUNTIME_FINGERPRINT = createHash("sha256").update("repo-search-test-runtime").digest("hex")

function sandbox(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "repo-search-store-")))
  sandboxes.push(path)
  return path
}

function git(root: string, args: string[]): void {
  execFileSync("/usr/bin/git", args, {
    cwd: root,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: "ignore",
  })
}

function addFile(root: string, path: string, content: string): void {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function initializeRepo(root: string, files: Record<string, string>): void {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, "framework/src"), { recursive: true })
  mkdirSync(join(root, "framework/test"), { recursive: true })
  for (const [path, content] of Object.entries(files)) addFile(root, path, content)
  git(root, ["init", "--quiet"])
  git(root, ["add", "-A"])
  git(root, ["-c", "user.name=Repo Search Test", "-c", "user.email=repo-search@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"])
}

function allSnapshotFiles(directory: string, relativeDirectory = ""): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...allSnapshotFiles(path, relativePath))
    else if (entry.isFile()) files.push({ path: relativePath, text: readFileSync(path, "utf8") })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

type RuntimeOptions = Readonly<{
  hits?: readonly GraphHit[]
  onBuild?: (inputDirectory: string, outputDirectory: string) => void | Promise<void>
  onQuery?: () => void | Promise<void>
}>

function runtime(options: RuntimeOptions = {}): GraphRuntime {
  return {
    fingerprint: RUNTIME_FINGERPRINT,
    async build(inputDirectory, outputDirectory) {
      await options.onBuild?.(inputDirectory, outputDirectory)
      writeFileSync(join(outputDirectory, "graph.json"), JSON.stringify(allSnapshotFiles(inputDirectory)), { mode: 0o600 })
    },
    async query() {
      await options.onQuery?.()
      return [...(options.hits ?? [])]
    },
  }
}

function fixture(files: Record<string, string> = { "framework/src/main.ts": "export const value = 1\n" }) {
  const base = sandbox()
  const root = join(base, "worktree")
  const storageRoot = join(base, "repo-search-store")
  initializeRepo(root, files)
  return { base, root, storageRoot }
}

function makeWritableForRemoval(path: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) makeWritableForRemoval(join(path, name))
    chmodSync(path, 0o700)
  } else chmodSync(path, 0o600)
}

async function build(root: string, storageRoot: string, graphRuntime = runtime()) {
  return await buildRepoSearchIndex(root, ROOTS, { approve: true, storageRoot, runtime: graphRuntime })
}

afterEach(() => {
  for (const directory of sandboxes.splice(0)) {
    makeWritableForRemoval(directory)
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("repo-search corpus approval and index lifecycle", () => {
  test("indexes tracked dirty bytes and detects modifications, deletions, and newly tracked source files", async () => {
    const { root, storageRoot } = fixture({ "framework/src/main.ts": "export const value = 1\n" })
    const graphRuntime = runtime({ hits: [{ path: "framework/src/main.ts", line: 1, symbol: "value" }] })
    const initial = await build(root, storageRoot, graphRuntime)
    expect(initial.files.map(file => file.path)).toEqual(["framework/src/main.ts"])
    expect(initial.roots).toEqual(ROOTS)
    expect(initial.bridgeFingerprint).toMatch(/^[a-f0-9]{40}$/u)
    expect(initial.runtimeFingerprint).toBe(RUNTIME_FINGERPRINT)
    expect(repoSearchHasApprovedIndex(root, storageRoot)).toBe(true)
    expect(await queryRepoSearch(root, graphRuntime, { query: "value" }, undefined, storageRoot)).toContain("UNTRUSTED repository references")

    writeFileSync(join(root, "framework/src/main.ts"), "export const value = 2\n")
    await expect(queryRepoSearch(root, graphRuntime, { query: "value" }, undefined, storageRoot)).rejects.toThrow("repo_search_stale")
    const modified = await build(root, storageRoot, graphRuntime)
    expect(modified.sourceFingerprint).not.toBe(initial.sourceFingerprint)

    rmSync(join(root, "framework/src/main.ts"))
    git(root, ["add", "-u"])
    addFile(root, "framework/src/new.ts", "export const newlyTracked = true\n")
    git(root, ["add", "--", "framework/src/new.ts"])
    const changed = await build(root, storageRoot, graphRuntime)
    expect(changed.files.map(file => file.path)).toEqual(["framework/src/new.ts"])
    expect(changed.sourceFingerprint).not.toBe(modified.sourceFingerprint)
  })

  test("does not snapshot excluded content, symlinks, hard links, or untracked files", async () => {
    const base = sandbox()
    const root = join(base, "worktree")
    const storageRoot = join(base, "repo-search-store")
    initializeRepo(root, {
      "framework/src/main.ts": "export const visible = true\n",
      "framework/src/secrets/credentials.ts": "EXCLUDED_SECRET_BYTES",
      "framework/src/security/secrets.ts": "EXCLUDED_SECRET_MODULE_BYTES",
      "framework/src/docs/leak.py": "EXCLUDED_DOC_BYTES",
      "framework/src/.env.ts": "EXCLUDED_HIDDEN_BYTES",
      "framework/src/.ssh/config.py": "EXCLUDED_HIDDEN_BYTES",
      "framework/src/generated/client.ts": "EXCLUDED_GENERATED_BYTES",
      "framework/src/hardlinked.ts": "HARD_LINK_SECRET_BYTES",
    })
    const outside = join(base, "outside-secret.ts")
    writeFileSync(outside, "HARD_LINK_SECRET_BYTES")
    rmSync(join(root, "framework/src/hardlinked.ts"))
    linkSync(outside, join(root, "framework/src/hardlinked.ts"))
    const symlinkTarget = join(base, "symlink-secret.ts")
    writeFileSync(symlinkTarget, "SYMLINK_SECRET_BYTES")
    symlinkSync(symlinkTarget, join(root, "framework/src/symlink.ts"))
    addFile(root, "framework/src/untracked.ts", "UNTRACKED_BYTES")
    git(root, ["add", "--", "framework/src/symlink.ts"])
    const included: string[] = []
    const graphRuntime = runtime({ onBuild(inputDirectory) {
      const files = allSnapshotFiles(inputDirectory)
      included.push(...files.map(file => file.path))
      const text = files.map(file => file.text).join("\n")
      expect(text).not.toContain("EXCLUDED_SECRET_BYTES")
      expect(text).not.toContain("EXCLUDED_SECRET_MODULE_BYTES")
      expect(text).not.toContain("EXCLUDED_DOC_BYTES")
      expect(text).not.toContain("EXCLUDED_HIDDEN_BYTES")
      expect(text).not.toContain("EXCLUDED_GENERATED_BYTES")
      expect(text).not.toContain("HARD_LINK_SECRET_BYTES")
      expect(text).not.toContain("SYMLINK_SECRET_BYTES")
      expect(text).not.toContain("UNTRACKED_BYTES")
    } })
    const manifest = await build(root, storageRoot, graphRuntime)
    expect(included).toEqual(["framework/src/main.ts"])
    expect(manifest.files.map(file => file.path)).toEqual(["framework/src/main.ts"])
  })

  test("keeps an earlier generation queryable after a failed build", async () => {
    const { root, storageRoot } = fixture()
    const graphRuntime = runtime({ hits: [{ path: "framework/src/main.ts", line: 1, symbol: "value" }] })
    const first = await build(root, storageRoot, graphRuntime)
    const failed = runtime({ onBuild() { throw new Error("fixture_build_failure") } })
    await expect(build(root, storageRoot, failed)).rejects.toThrow("fixture_build_failure")
    expect(repoSearchHasApprovedIndex(root, storageRoot)).toBe(true)
    expect(await queryRepoSearch(root, graphRuntime, { query: "value" }, undefined, storageRoot)).toContain("framework/src/main.ts")
    expect(first.generationId).toMatch(/^gen-[a-f0-9]{32}$/u)
  })

  test("cancellation before publication leaves the approved generation active", async () => {
    const { root, storageRoot } = fixture()
    const graphRuntime = runtime({ hits: [{ path: "framework/src/main.ts", line: 1, symbol: "value" }] })
    await build(root, storageRoot, graphRuntime)
    const controller = new AbortController()
    const cancelled = runtime({ onBuild() { controller.abort() } })
    await expect(buildRepoSearchIndex(root, ROOTS, { approve: true, storageRoot, runtime: cancelled, signal: controller.signal }))
      .rejects.toThrow("repo_search_cancelled")
    expect(await queryRepoSearch(root, graphRuntime, { query: "value" }, undefined, storageRoot)).toContain("framework/src/main.ts")
  })

  test("source changes during graph construction fail publication and retain the previous generation", async () => {
    const { root, storageRoot } = fixture()
    const graphRuntime = runtime({ hits: [{ path: "framework/src/main.ts", line: 1, symbol: "value" }] })
    await build(root, storageRoot, graphRuntime)
    const changing = runtime({ onBuild() {
      writeFileSync(join(root, "framework/src/main.ts"), "export const changedDuringBuild = true\n")
    } })
    await expect(build(root, storageRoot, changing)).rejects.toThrow("repo_search_stale_source")
    writeFileSync(join(root, "framework/src/main.ts"), "export const value = 1\n")
    expect(await queryRepoSearch(root, graphRuntime, { query: "value" }, undefined, storageRoot)).toContain("framework/src/main.ts")
  })

  test("rechecks source after the runtime and bounds untrusted hit text", async () => {
    const { root, storageRoot } = fixture()
    const goodRuntime = runtime({ hits: [{ path: "framework/src/main.ts", line: 1, symbol: "value" }] })
    await build(root, storageRoot, goodRuntime)
    const mutatingRuntime = runtime({
      hits: [{ path: "framework/src/main.ts", line: 1, symbol: "value" }],
      onQuery() { writeFileSync(join(root, "framework/src/main.ts"), "export const changedDuringQuery = true\n") },
    })
    await expect(queryRepoSearch(root, mutatingRuntime, { query: "x" }, undefined, storageRoot)).rejects.toThrow("repo_search_stale")
    writeFileSync(join(root, "framework/src/main.ts"), "export const value = 1\n")

    const largeHitRuntime = runtime({ hits: [{
      path: "framework/src/main.ts",
      line: 1,
      symbol: "x".repeat(1024),
      relations: Array.from({ length: 20 }, () => "y".repeat(1024)),
    }] })
    const result = await queryRepoSearch(root, largeHitRuntime, { query: "x" }, undefined, storageRoot)
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(8 * 1024)
    expect(result).toContain("Repository state: current")
    expect(result).toContain("UNTRUSTED repository references")
  })

  test("binds approval to the canonical worktree and rejects a replacement at the same path", async () => {
    const { base, root, storageRoot } = fixture()
    const graphRuntime = runtime()
    await build(root, storageRoot, graphRuntime)
    const foreignRoot = join(base, "foreign")
    initializeRepo(foreignRoot, { "framework/src/main.ts": "foreign\n" })
    expect(repoSearchHasApprovedIndex(foreignRoot, storageRoot)).toBe(false)
    await expect(queryRepoSearch(foreignRoot, graphRuntime, { query: "x" }, undefined, storageRoot)).rejects.toThrow("repo_search_missing_artifact")

    const retained = join(base, "retained-worktree")
    renameSync(root, retained)
    initializeRepo(root, { "framework/src/main.ts": "foreign replacement\n" })
    expect(repoSearchHasApprovedIndex(root, storageRoot)).toBe(false)
    await expect(queryRepoSearch(root, graphRuntime, { query: "x" }, undefined, storageRoot)).rejects.toThrow("repo_search_identity_mismatch")
  })

  test("rejects malformed manifests and graph hits outside the manifest", async () => {
    const { root, storageRoot } = fixture()
    const goodRuntime = runtime({ hits: [{ path: "framework/src/main.ts", line: 2, symbol: "value" }] })
    await build(root, storageRoot, goodRuntime)
    const foreignHitRuntime = runtime({ hits: [{ path: "framework/src/not-indexed.ts", line: 1, symbol: "foreign" }] })
    await expect(queryRepoSearch(root, foreignHitRuntime, { query: "x" }, undefined, storageRoot)).rejects.toThrow("repo_search_invalid_hit")
    const badLineRuntime = runtime({ hits: [{ path: "framework/src/main.ts", line: 0, symbol: "bad" }] })
    await expect(queryRepoSearch(root, badLineRuntime, { query: "x" }, undefined, storageRoot)).rejects.toThrow("repo_search_invalid_hit")

    const key = createHash("sha256").update(realpathSync(root), "utf8").digest("hex")
    writeFileSync(join(storageRoot, key, "current.json"), "{\"schema\":1}")
    expect(repoSearchHasApprovedIndex(root, storageRoot)).toBe(false)
    await expect(queryRepoSearch(root, goodRuntime, { query: "x" }, undefined, storageRoot)).rejects.toThrow("repo_search_corrupt_manifest")
  })

  test("rejects symlinked store components and CLI requests without explicit bounded roots", async () => {
    const { base, root } = fixture()
    const actualStore = join(base, "actual-store")
    const linkedStore = join(base, "linked-store")
    mkdirSync(actualStore)
    symlinkSync(actualStore, linkedStore)
    await expect(build(root, linkedStore)).rejects.toThrow("repo_search_store_symlink")
    expect(readdirSync(actualStore)).toEqual([])
    expect(() => parseBuildCliArguments(["--root", "framework/src"])).toThrow("repo_search_approval_required")
    expect(() => parseBuildCliArguments(["--approve", "--root", "."])).toThrow("repo_search_invalid_root")
    expect(() => parseBuildCliArguments(["--approve", "--root", "framework/src", "--surprise"])).toThrow("Usage:")
  })
})
