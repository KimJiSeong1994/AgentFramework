import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

export type GraphHit = { path: string; line?: number; symbol: string; relations?: string[] }
export type GraphRuntime = {
  fingerprint: string
  build(inputDirectory: string, outputDirectory: string, signal?: AbortSignal): Promise<void>
  query(graphPath: string, query: string, limit: number, signal?: AbortSignal): Promise<GraphHit[]>
}

export const GRAPHIFY_COMMIT = "92741d162b2094ffc2fed58cfbd8ee823e9da62c"
export const PYTHON_BASE = "/Library/Frameworks/Python.framework/Versions/3.13"
// Bypass python.org's bin launcher, which spawns Python.app before user code.
export const PYTHON_EXECUTABLE = `${PYTHON_BASE}/Resources/Python.app/Contents/MacOS/Python`
export const PYTHON_VERSION = "3.13.2"
export const RUNTIME_ROOT = join(homedir(), ".local/share/otter/repo-search-runtime", GRAPHIFY_COMMIT)
const ADAPTER_SOURCE = join(import.meta.dir, "graphify-adapter.py")
const VENDOR_ROOT = resolve(import.meta.dir, "../../vendor/graphify")
const HASH = /^[a-f0-9]{64}$/

export function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Reject links in every component, not merely the final path. */
export function assertNoLinks(path: string): void {
  const full = resolve(path)
  let current = full
  while (true) {
    if (lstatSync(current).isSymbolicLink()) throw new Error("repo_search_symlink")
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

export function runtimeFileHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {}
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const key = relative(root, path)
      const info = lstatSync(path)
      // uv's interpreter aliases are the only permitted runtime links.
      if (info.isSymbolicLink()) {
        if (!/^\.venv\/bin\/python(?:3(?:\.13)?)?$/.test(key) || ![PYTHON_EXECUTABLE, `${PYTHON_BASE}/bin/python3.13`].includes(realpathSync(path))) {
          throw new Error(`repo_search_runtime_link:${key}`)
        }
        hashes[key] = digest(`symlink:${realpathSync(path)}`)
      } else if (info.isDirectory()) {
        if ((info.mode & 0o022) !== 0) throw new Error("repo_search_runtime_writable")
        visit(path)
      } else if (info.isFile() && info.nlink === 1) {
        if (key === "runtime.json") continue
        if ((info.mode & 0o022) !== 0) throw new Error("repo_search_runtime_writable")
        hashes[key] = digest(readFileSync(path))
      } else throw new Error("repo_search_runtime_file_type")
    }
  }
  visit(root)
  return hashes
}

export function pythonLibraryHash(): string {
  const hashes: Record<string, string> = { Python: digest(readFileSync(join(PYTHON_BASE, "Python"))) }
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (name === "site-packages" || name === "__pycache__") continue
      const path = join(directory, name)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) {
        if (realpathSync(path) !== join(PYTHON_BASE, "Python")) throw new Error("repo_search_python_library_link")
        hashes[relative(PYTHON_BASE, path)] = digest(`symlink:${realpathSync(path)}`)
      } else if (info.isDirectory()) visit(path)
      else if (info.isFile()) hashes[relative(PYTHON_BASE, path)] = digest(readFileSync(path))
      else throw new Error("repo_search_python_library_type")
    }
  }
  visit(join(PYTHON_BASE, "lib/python3.13"))
  const zip = join(PYTHON_BASE, "lib/python313.zip")
  if (existsSync(zip)) hashes["lib/python313.zip"] = digest(readFileSync(zip))
  return digest(JSON.stringify(hashes))
}

/** Validate publisher-signed native components before trusting a local interpreter. */
export function verifyPythonPublisher(): void {
  const requirement = '=anchor apple generic and certificate leaf[subject.OU] = "BMM5U3QVKW"'
  for (const [target, flags] of [
    [join(PYTHON_BASE, "Resources/Python.app"), []],
    // Installed Python frameworks may contain operator-installed resources.
    // Verify native code signing here; separately pin the non-site stdlib bytes.
    [join(PYTHON_BASE, "Python"), ["--ignore-resources"]],
  ] as const) {
    const checked = spawnSync("/usr/bin/codesign", ["--verify", "--strict", ...flags, "-R", requirement, target], { timeout: 10_000, env: { PATH: "/usr/bin:/bin" }, stdio: "pipe" })
    if (checked.error || checked.status !== 0) throw new Error("repo_search_python_signature")
  }
  const checked = spawnSync("/usr/bin/sandbox-exec", ["-p", graphSandboxProfile([], []), PYTHON_EXECUTABLE, "-I", "-S", "-B", "-c", "import sys,platform;print('.'.join(map(str,sys.version_info[:3]))+' '+platform.machine())"], { timeout: 10_000, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" })
  if (checked.error || checked.status !== 0 || checked.stdout.trim() !== `${PYTHON_VERSION} arm64`) throw new Error("repo_search_python_identity")
}

type RuntimeReceipt = { schema: 1; commit: string; pythonVersion: string; pythonHash: string; pythonLibraryHash: string; adapterHash: string; lockHash: string; files: Record<string, string> }

function inspectRuntime(): { fingerprint: string; site: string; adapter: string } {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("repo_search_unsupported_platform")
  assertNoLinks(RUNTIME_ROOT)
  const rootStat = statSync(RUNTIME_ROOT)
  if (rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o077) !== 0) throw new Error("repo_search_runtime_permissions")
  const receiptPath = join(RUNTIME_ROOT, "runtime.json")
  const info = lstatSync(receiptPath)
  if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024 || (info.mode & 0o077) !== 0) throw new Error("repo_search_runtime_receipt")
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as RuntimeReceipt
  if (receipt.schema !== 1 || receipt.commit !== GRAPHIFY_COMMIT || receipt.pythonVersion !== PYTHON_VERSION || !HASH.test(receipt.pythonHash) || !HASH.test(receipt.pythonLibraryHash) || !HASH.test(receipt.adapterHash) || !HASH.test(receipt.lockHash)) throw new Error("repo_search_runtime_receipt")
  if (digest(readFileSync(PYTHON_EXECUTABLE)) !== receipt.pythonHash || digest(readFileSync(ADAPTER_SOURCE)) !== receipt.adapterHash || digest(readFileSync(join(VENDOR_ROOT, "uv.lock"))) !== receipt.lockHash) throw new Error("repo_search_runtime_changed")
  if (pythonLibraryHash() !== receipt.pythonLibraryHash) throw new Error("repo_search_python_library_changed")
  const files = runtimeFileHashes(RUNTIME_ROOT)
  if (JSON.stringify(files) !== JSON.stringify(receipt.files)) throw new Error("repo_search_runtime_changed")
  const adapter = join(RUNTIME_ROOT, "graphify-adapter.py")
  if (files["graphify-adapter.py"] !== receipt.adapterHash) throw new Error("repo_search_runtime_adapter")
  return { fingerprint: digest(JSON.stringify(receipt)), site: join(RUNTIME_ROOT, ".venv/lib/python3.13/site-packages"), adapter }
}

function quote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("repo_search_invalid_path")
  return JSON.stringify(value)
}

/** Uses the same deny-default Seatbelt primitives as the existing SkillOpt worker. */
export function graphSandboxProfile(readDirectories: readonly string[], readFiles: readonly string[], writeDirectory?: string): string {
  const metadata = new Set<string>()
  for (const target of [PYTHON_EXECUTABLE, PYTHON_BASE, RUNTIME_ROOT, "/System/Library", "/usr/lib", ...readDirectories, ...readFiles, ...(writeDirectory ? [writeDirectory] : [])]) {
    let current = resolve(target)
    while (true) {
      metadata.add(current)
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  const rules = [
    "(version 1)", "(deny default)", `(allow process-exec (literal ${quote(PYTHON_EXECUTABLE)}))`,
    "(deny process-fork)", "(allow sysctl-read)",
    // dyld aborts before Python starts without opening the root directory.
    // This exposes root entry names, not arbitrary descendant data/metadata.
    '(allow file-read-data (literal "/"))',
    ...[...metadata].map(path => `(allow file-read-metadata (literal ${quote(path)}))`),
    ...["/System/Library", "/usr/lib", PYTHON_BASE, RUNTIME_ROOT].map(path => `(allow file-read* file-map-executable (subpath ${quote(path)}))`),
    "(allow file-read* (literal \"/dev/urandom\") (literal \"/dev/random\"))",
    ...readDirectories.map(path => `(allow file-read* (subpath ${quote(path)}))`),
    ...readFiles.map(path => `(allow file-read* (literal ${quote(path)}))`),
  ]
  if (writeDirectory) rules.push(`(allow file-read* file-write* (subpath ${quote(writeDirectory)}))`)
  rules.push(`(deny file-read* (subpath ${quote(join(PYTHON_BASE, "lib/python3.13/site-packages"))}))`)
  return rules.join("\n")
}

const BOOTSTRAP = `import sys,runpy,resource
resource.setrlimit(resource.RLIMIT_CORE,(0,0))
resource.setrlimit(resource.RLIMIT_NOFILE,(128,128))
resource.setrlimit(resource.RLIMIT_FSIZE,(67108864,67108864))
resource.setrlimit(resource.RLIMIT_CPU,(120,120))
sys.path.insert(0,sys.argv[1])
runpy.run_path(sys.argv[2],run_name="__main__")`

function canonicalDirectory(path: string): string {
  assertNoLinks(path)
  const canonical = realpathSync(path)
  if (!statSync(canonical).isDirectory() || canonical === "/" || canonical === homedir()) throw new Error("repo_search_invalid_directory")
  return canonical
}

async function invoke(input: object, reads: string[], files: string[], write: string | undefined, timeout: number, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new Error("repo_search_cancelled")
  const runtime = inspectRuntime()
  const profile = graphSandboxProfile(reads, files, write)
  return await new Promise((accept, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, PYTHON_EXECUTABLE, "-I", "-S", "-B", "-c", BOOTSTRAP, runtime.site, runtime.adapter], {
      cwd: RUNTIME_ROOT,
      env: { PATH: "/usr/bin:/bin", HOME: RUNTIME_ROOT, LANG: "en_US.UTF-8", GRAPHIFY_QUERY_LOG_DISABLE: "1", OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let failure: Error | undefined
    const stop = (reason: string) => { failure ??= new Error(reason); child.kill("SIGKILL") }
    const abort = () => stop("repo_search_cancelled")
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => stop("repo_search_timeout"), timeout)
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 128 * 1024) stop("repo_search_output_limit")
      else stdout = Buffer.concat([stdout, chunk])
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > 32 * 1024) stop("repo_search_stderr_limit")
      else stderr = Buffer.concat([stderr, chunk])
    })
    child.stdin.on("error", () => {})
    child.on("error", error => { failure ??= error })
    child.on("close", code => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error(`repo_search_runtime_failed:${code}:${stderr.toString("utf8").slice(0, 1024)}`))
      try { accept(JSON.parse(stdout.toString("utf8"))) } catch { reject(new Error("repo_search_invalid_runtime_output")) }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

export function createGraphRuntime(): GraphRuntime {
  const initial = inspectRuntime()
  const revalidate = () => {
    if (inspectRuntime().fingerprint !== initial.fingerprint) throw new Error("repo_search_runtime_changed")
  }
  return {
    fingerprint: initial.fingerprint,
    async build(inputDirectory, outputDirectory, signal) {
      revalidate()
      const input = canonicalDirectory(inputDirectory)
      const output = canonicalDirectory(outputDirectory)
      const contains = (parent: string, child: string) => {
        const path = relative(parent, child)
        return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path))
      }
      if (contains(input, output) || contains(output, input)) throw new Error("repo_search_overlapping_directories")
      const result = await invoke({ action: "build", inputDirectory: input, outputDirectory: output }, [input], [], output, 180_000, signal)
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw new Error("repo_search_build_failed")
      const graph = join(output, "graph.json")
      const info = lstatSync(graph)
      if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) throw new Error("repo_search_invalid_graph")
      revalidate()
    },
    async query(graphPath, query, limit, signal) {
      revalidate()
      if (typeof query !== "string" || !query.trim() || query.includes("\0") || Buffer.byteLength(query) > 2048 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("repo_search_invalid_query")
      if (!isAbsolute(graphPath)) throw new Error("repo_search_invalid_graph")
      assertNoLinks(graphPath)
      const graph = realpathSync(graphPath)
      const info = lstatSync(graph)
      if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) throw new Error("repo_search_invalid_graph")
      const result = await invoke({ action: "query", graphPath: graph, query, limit }, [], [graph], undefined, 5000, signal)
      if (!result || typeof result !== "object" || !("hits" in result) || !Array.isArray(result.hits) || result.hits.length > limit) throw new Error("repo_search_invalid_hits")
      const hits: GraphHit[] = []
      for (const hit of result.hits) {
        if (!hit || typeof hit !== "object" || typeof hit.path !== "string" || typeof hit.symbol !== "string" || hit.symbol.length > 1024 || isAbsolute(hit.path) || hit.path.split(/[\\/]/).some((part: string) => part === ".." || part === "")) throw new Error("repo_search_invalid_hit")
        if (hit.line !== undefined && (!Number.isInteger(hit.line) || hit.line < 1)) throw new Error("repo_search_invalid_line")
        if (hit.relations !== undefined && (!Array.isArray(hit.relations) || hit.relations.length > 20 || hit.relations.some((item: unknown) => typeof item !== "string" || item.length > 1024))) throw new Error("repo_search_invalid_relations")
        hits.push({ path: hit.path, symbol: hit.symbol, ...(hit.line !== undefined ? { line: hit.line } : {}), ...(hit.relations !== undefined ? { relations: hit.relations } : {}) })
      }
      if (Buffer.byteLength(JSON.stringify(hits)) > 8192) throw new Error("repo_search_output_limit")
      revalidate()
      return hits
    },
  }
}
