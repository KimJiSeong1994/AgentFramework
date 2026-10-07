import { execFileSync, spawn } from "node:child_process"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const FLAGS = [
  "-c", "core.hooksPath=/opt/lca/git/no-hooks", "-c", "core.fsmonitor=false",
  "-c", "diff.external=", "-c", "credential.helper=", "-c", "core.sshCommand=/bin/false",
  "-c", "protocol.allow=never", "-c", "core.pager=cat", "-c", "gpg.program=/bin/false",
  "-c", "core.attributesFile=/dev/null", "-c", "advice.addEmbeddedRepo=false",
]

// Do not inherit GIT_CONFIG_COUNT, GIT_DIR, GIT_EXEC_PATH, askpass, dynamic loader hooks, etc.
export function controlledGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/opt/lca/git/config",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", GIT_SSH_COMMAND: "/bin/false",
    GIT_ALLOW_PROTOCOL: "", GIT_NO_REPLACE_OBJECTS: "1", ...extra,
  }
}

function gitDir(cwd: string): { dir: string; root: string } | null {
  let parent = resolve(cwd)
  for (;;) {
    const dot = join(parent, ".git")
    if (existsSync(dot)) {
      const stat = lstatSync(dot)
      if (stat.isDirectory()) return { dir: dot, root: parent }
      if (!stat.isFile()) throw new Error("git-config: nonregular .git")
      const match = /^gitdir: (.+)\s*$/m.exec(readFileSync(dot, "utf8"))
      if (!match) throw new Error("git-config: invalid .git pointer")
      return { dir: resolve(parent, match[1]!), root: parent }
    }
    const next = dirname(parent)
    if (next === parent) return null
    parent = next
  }
}

export function hasGitMetadata(cwd: string): boolean {
  return gitDir(cwd) !== null
}

function checkConfig(file: string): void {
  if (!existsSync(file)) return
  if (!lstatSync(file).isFile()) throw new Error("git-config: nonregular config")
  const raw = execFileSync("git", ["config", "--no-includes", "--null", "--list", "--file", file], {
    env: controlledGitEnv(), stdio: ["ignore", "pipe", "pipe"],
  }).toString()
  for (const entry of raw.split("\0")) {
    if (!entry) continue
    const key = entry.split("\n", 1)[0]!.toLowerCase()
    const value = entry.slice(key.length + 1).trim().toLowerCase()
    if (/^(filter\.|include\.|includeif\.|alias\.|credential\.|extensions\.|pager\.|difftool\.|mergetool\.)/.test(key)
      || /^diff\..*\.(command|textconv)$/.test(key)
      || /^merge\..*\.driver$/.test(key)
      || /^core\.(fsmonitor|hookspath|worktree|gitproxy|sshcommand|editor|pager|askpass|attributesfile|excludesfile|alternaterefscommand)$/.test(key)
      || (key === "core.bare" && value !== "false" && value !== "no" && value !== "off" && value !== "0")
      || /^diff\.external$/.test(key)
      || /^tar\..*\.command$/.test(key)
      || /^url\..*\.insteadof$/.test(key)) throw new Error(`git-config: forbidden ${key}`)
  }
}

function checkAttributes(content: string, file: string): void {
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue
    // Git attribute tokens are separated by whitespace; quoted patterns do not change attribute tokens.
    if (/(?:^|\s)(?:filter|diff|merge)=[^\s#]+/.test(line)) throw new Error(`git-config: driver attribute in ${file}`)
  }
}

function inspectBlob(cwd: string, spec: string, path: string): void {
  const blob = execFileSync("git", [...FLAGS, "show", spec], {
    cwd, env: controlledGitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  })
  checkAttributes(blob.toString(), path)
}

/** A read-only, controlled preflight before every Git operation that can touch a repository. */
export function assertGitBoundary(cwd: string): void {
  const found = gitDir(cwd)
  if (!found) return
  const { dir, root } = found
  const commonFile = join(dir, "commondir")
  const common = existsSync(commonFile) ? resolve(dir, readFileSync(commonFile, "utf8").trim()) : dir
  checkConfig(join(common, "config"))
  checkConfig(join(dir, "config.worktree"))
  const info = join(common, "info", "attributes")
  if (existsSync(info)) checkAttributes(readFileSync(info, "utf8"), info)
  const patterns = ["--", ".gitattributes", "**/.gitattributes"]
  const staged = execFileSync("git", [...FLAGS, "ls-files", "--cached", "-z", ...patterns], {
    cwd: root, env: controlledGitEnv(), stdio: ["ignore", "pipe", "pipe"],
  }).toString()
  const others = execFileSync("git", [...FLAGS, "ls-files", "--others", "-z", ...patterns], {
    cwd: root, env: controlledGitEnv(), stdio: ["ignore", "pipe", "pipe"],
  }).toString()
  let head = ""
  try {
    head = execFileSync("git", [...FLAGS, "ls-tree", "-r", "--name-only", "-z", "HEAD", "--", ".gitattributes", "**/.gitattributes"], {
      cwd: root, env: controlledGitEnv(), stdio: ["ignore", "pipe", "pipe"],
    }).toString()
  } catch {} // unborn repository
  const stagedPaths = new Set(staged.split("\0").filter(Boolean))
  const headPaths = new Set(head.split("\0").filter(Boolean))
  for (const path of new Set([...stagedPaths, ...others.split("\0").filter(Boolean), ...headPaths])) {
    const file = join(root, path)
    if (existsSync(file)) {
      if (!lstatSync(file).isFile()) throw new Error(`git-config: nonregular ${path}`)
      checkAttributes(readFileSync(file, "utf8"), path)
    }
    // Both staged and committed attributes can differ from the working file at checkout time.
    if (stagedPaths.has(path)) inspectBlob(root, `:${path}`, path)
    if (headPaths.has(path)) inspectBlob(root, `HEAD:${path}`, path)
  }
}

export async function safeGit(cwd: string, args: string[], extra?: Record<string, string>): Promise<string | null> {
  assertGitBoundary(cwd)
  const result = await safeGitBufferUnchecked(cwd, args, extra)
  return result?.toString().replace(/\n+$/, "") ?? null
}

export async function safeGitBuffer(cwd: string, args: string[], extra?: Record<string, string>, maxBytes = Infinity): Promise<Buffer | null> {
  if (!(maxBytes > 0) || (maxBytes !== Infinity && !Number.isSafeInteger(maxBytes))) throw new TypeError("invalid Git output limit")
  assertGitBoundary(cwd)
  return safeGitBufferUnchecked(cwd, args, extra, maxBytes)
}

function safeGitBufferUnchecked(cwd: string, args: string[], extra?: Record<string, string>, maxBytes = Infinity): Promise<Buffer | null> {
  return new Promise((resolveResult) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let overflow = false
    // Git treats `-c diff.external=` as an enabled (empty-name) external diff, not as disabled.
    // Keep the mandated override but explicitly prohibit invoking any external diff program.
    const command = args[0] === "diff" ? [args[0], "--no-ext-diff", ...args.slice(1)] : args
    const child = spawn("git", [...FLAGS, ...command], {
      cwd, env: controlledGitEnv(extra), stdio: ["ignore", "pipe", "pipe"],
    })
    const count = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > maxBytes) { overflow = true; child.kill("SIGKILL") }
    }
    child.stdout.on("data", (chunk: Buffer) => { count(chunk); if (!overflow) chunks.push(chunk) })
    child.stderr.on("data", count)
    child.on("error", () => resolveResult(null))
    child.on("close", (code) => resolveResult(code === 0 && !overflow ? Buffer.concat(chunks) : null))
  })
}

export function safeGitSync(cwd: string, args: string[], extra?: Record<string, string>): string {
  return safeGitBufferSync(cwd, args, extra).toString().trimEnd()
}

/** Preserve raw NUL-delimited paths, including filenames that are not valid UTF-8. */
export function safeGitBufferSync(cwd: string, args: string[], extra?: Record<string, string>): Buffer {
  assertGitBoundary(cwd)
  return execFileSync("git", [...FLAGS, ...args], { cwd, env: controlledGitEnv(extra), stdio: "pipe" })
}
