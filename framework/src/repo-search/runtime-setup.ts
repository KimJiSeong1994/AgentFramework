import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { assertNoLinks, digest, GRAPHIFY_COMMIT, PYTHON_EXECUTABLE, PYTHON_VERSION, RUNTIME_ROOT, runtimeFileHashes, pythonLibraryHash, verifyPythonPublisher } from "./runtime.ts"

/** Explicit local operator command. This is never called by repo_search. */
export function setupRuntime(args: string[]): void {
  if (args.length !== 1 || args[0] !== "--approve") throw new Error("Usage: bun run src/repo-search/runtime-setup.ts --approve (downloads pinned dependencies; no repository indexing)")
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("repo_search_unsupported_platform")
  if (existsSync(RUNTIME_ROOT)) throw new Error("repo_search_runtime_already_exists: inspect existing runtime; setup never overwrites it")
  const uv = Bun.which("uv")
  if (!uv) throw new Error("repo_search_uv_missing")
  verifyPythonPublisher()
  const parent = dirname(RUNTIME_ROOT)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  assertNoLinks(parent)
  const parentInfo = lstatSync(parent)
  if (parentInfo.uid !== process.getuid?.() || (parentInfo.mode & 0o077) !== 0) throw new Error("repo_search_runtime_parent_permissions")
  const stage = mkdtempSync(join(parent, ".setup-"))
  const installHome = mkdtempSync(join(parent, ".install-home-"))
  chmodSync(stage, 0o700)
  chmodSync(installHome, 0o700)
  let published = false
  try {
    const vendor = resolve(import.meta.dir, "../../vendor/graphify")
    for (const name of ["pyproject.toml", "uv.lock", "SOURCE.json"]) copyFileSync(join(vendor, name), join(stage, name))
    const lock = readFileSync(join(stage, "uv.lock"), "utf8")
    if (!lock.includes(GRAPHIFY_COMMIT) || !lock.includes("https://github.com/Graphify-Labs/graphify")) throw new Error("repo_search_unpinned_lock")
    copyFileSync(join(import.meta.dir, "graphify-adapter.py"), join(stage, "graphify-adapter.py"))
    const result = spawnSync(uv, ["sync", "--frozen", "--no-dev", "--no-editable", "--link-mode", "copy", "--python", PYTHON_EXECUTABLE, "--project", stage], {
      timeout: 300_000,
      stdio: "inherit",
      env: {
        PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: installHome,
        UV_CACHE_DIR: join(installHome, "cache"), UV_PYTHON_DOWNLOADS: "never",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
        // uv clones its fetched Git cache locally before building the pinned wheel.
        GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "/usr/bin/false", GIT_ALLOW_PROTOCOL: "https:file",
        NETRC: join(installHome, "no-netrc"),
      },
    })
    if (result.error || result.status !== 0) throw new Error("repo_search_runtime_install_failed")
    const site = join(stage, ".venv/lib/python3.13/site-packages")
    const distributions = readdirSync(site).filter(name => /^graphifyy-.*\.dist-info$/.test(name))
    if (distributions.length !== 1) throw new Error("repo_search_distribution_missing")
    const provenance = JSON.parse(readFileSync(join(site, distributions[0]!, "direct_url.json"), "utf8"))
    if (provenance.vcs_info?.commit_id !== GRAPHIFY_COMMIT || provenance.vcs_info?.vcs !== "git" || provenance.url !== "https://github.com/Graphify-Labs/graphify.git") throw new Error("repo_search_source_provenance")
    const privatize = (path: string) => {
      const info = lstatSync(path)
      if (info.isSymbolicLink()) return // Validated against the interpreter allowlist below.
      if (info.isDirectory()) {
        chmodSync(path, 0o700)
        for (const name of readdirSync(path)) privatize(join(path, name))
      } else if (info.isFile() && info.nlink === 1) {
        chmodSync(path, info.mode & 0o100 ? 0o700 : 0o600)
      } else throw new Error("repo_search_runtime_file_type")
    }
    privatize(stage)
    const receipt = {
      schema: 1,
      commit: GRAPHIFY_COMMIT,
      pythonVersion: PYTHON_VERSION,
      pythonHash: digest(readFileSync(PYTHON_EXECUTABLE)),
      pythonLibraryHash: pythonLibraryHash(),
      adapterHash: digest(readFileSync(join(stage, "graphify-adapter.py"))),
      lockHash: digest(readFileSync(join(stage, "uv.lock"))),
      files: runtimeFileHashes(stage),
    }
    writeFileSync(join(stage, "runtime.json"), `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(stage, RUNTIME_ROOT)
    published = true
    console.log(`Pinned Graphify runtime installed: ${GRAPHIFY_COMMIT}. No repository files indexed. Build/query remain offline and explicitly approved.`)
  } finally {
    rmSync(installHome, { recursive: true, force: true })
    if (!published) rmSync(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try { setupRuntime(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : "repo_search_setup_failed"); process.exitCode = 1 }
}
