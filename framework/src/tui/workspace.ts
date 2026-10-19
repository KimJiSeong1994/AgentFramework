import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

const CACHE_MS = 2000

/** The checked-out branch (or a short detached sha) for `cwd`, read from `.git/HEAD` without running git. */
export function gitBranch(cwd: string): string | undefined {
  let directory = resolve(cwd)
  for (;;) {
    const marker = join(directory, ".git")
    if (existsSync(marker)) {
      try {
        let gitDir = marker
        if (statSync(marker).isFile()) {
          const pointer = /^gitdir:\s*(.+)$/mu.exec(readFileSync(marker, "utf8"))?.[1]?.trim()
          if (!pointer) return undefined
          gitDir = isAbsolute(pointer) ? pointer : resolve(directory, pointer)
        }
        const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim()
        const ref = /^ref:\s*refs\/heads\/(.+)$/u.exec(head)?.[1]
        if (ref) return ref
        return /^[0-9a-f]{7,}$/iu.test(head) ? head.slice(0, 7) : undefined
      } catch {
        return undefined
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** `cwd` with the home directory shown as `~`. */
export function displayPath(cwd: string, home = homedir()): string {
  const path = resolve(cwd)
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`
  return path
}

/** GJC-style rule-bar context: `⑂ branch / ~/path` (`git:branch / ~/path` in ASCII). */
export function workspaceLabel(cwd: string, ascii: boolean, separator = " / "): string {
  const branch = gitBranch(cwd)
  const path = displayPath(cwd)
  return branch ? `${ascii ? "git:" : "⑂ "}${branch}${separator}${path}` : path
}

/** Re-reads the branch at most every two seconds so a `!git switch` shows up without a git call per frame. */
export class WorkspaceLabel {
  private cached?: { at: number; ascii: boolean; value: string }
  constructor(private readonly cwd: () => string = () => process.cwd()) {}

  value(ascii: boolean, now = Date.now()): string {
    const cached = this.cached
    if (cached && cached.ascii === ascii && now - cached.at < CACHE_MS) return cached.value
    const value = workspaceLabel(this.cwd(), ascii)
    this.cached = { at: now, ascii, value }
    return value
  }
}
