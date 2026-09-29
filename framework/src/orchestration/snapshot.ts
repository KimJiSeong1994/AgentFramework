// Per-task diffs without touching the user's index, HEAD or object store.
//
// A SnapshotStore owns a temporary directory holding a private GIT_INDEX_FILE and a private GIT_OBJECT_DIRECTORY;
// the user's .git/objects is only READ through GIT_ALTERNATE_OBJECT_DIRECTORIES. `git add -A` + `write-tree` then
// produce a tree of the working directory (tracked + untracked, .gitignore respected) whose new blobs land in the
// temp object dir and vanish with dispose() — no secrets or large untracked files are ever copied into the user's
// repository (review, security M4). Diffing two such trees gives exactly what one task changed, even when earlier
// tasks left the worktree dirty. The plugin's own runtime dirs and configured artifact globs are excluded so the
// reviewer never sees session files or __pycache__ as "changes outside the task". Degrades to null outside git.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { git, gitBuffer } from "./shell.ts"

/** Always excluded: the plugin's handoffs (control-plane state lives outside the worktree; ".lca/state" kept for old layouts). */
export const ALWAYS_EXCLUDED = [".lca/state", ".lca/handoffs"]

/** Turn a name/glob into git pathspecs that exclude it at any depth (top level and nested). */
export function excludePathspecs(patterns: string[]): string[] {
  const out: string[] = []
  for (const raw of [...ALWAYS_EXCLUDED, ...patterns]) {
    const p = raw.trim().replace(/^\/+|\/+$/g, "")
    if (!p || /^[:!^]/.test(p)) continue // pathspec magic in user config is not honoured
    out.push(`:(exclude,glob)${p}`, `:(exclude,glob)${p}/**`, `:(exclude,glob)**/${p}`, `:(exclude,glob)**/${p}/**`)
  }
  return out
}

export type Snapshot = { tree: string; store?: SnapshotStore } | null

export type TreeDiff = { files: string[]; diff: string; truncated: boolean }

export type SnapshotStore = {
  worktree: string
  env: Record<string, string>
  snapshot(exclude?: string[]): Promise<Snapshot>
  diff(before: Snapshot, after: Snapshot, maxChars: number): Promise<TreeDiff | null>
  /** put `paths` back to their content in `tree` (deleted if absent there); returns the paths actually restored */
  restore(tree: Snapshot, paths: string[]): Promise<string[]>
  dispose(): void
}

/**
 * `git add` runs clean filters declared in in-tree .gitattributes (+ .git/config drivers); a worker can plant both
 * (second review S2). Every driver named in a tracked or untracked .gitattributes is neutralised with -c overrides,
 * and the attributes file / hooks path are pointed at nothing.
 */
export async function filterOverrides(worktree: string): Promise<string[]> {
  const names = new Set<string>()
  const files = (await git(worktree, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".gitattributes", "**/.gitattributes"])) ?? ""
  for (const f of files.split("\0").filter(Boolean)) {
    try {
      for (const m of readFileSync(join(worktree, f), "utf8").matchAll(/\b(?:filter|diff|merge)=([A-Za-z0-9_.-]+)/g)) names.add(m[1]!)
    } catch {}
  }
  const cfg = (await git(worktree, ["config", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"])) ?? ""
  for (const m of cfg.matchAll(/^filter\.([^.]+)\./gm)) names.add(m[1]!)
  const out = ["-c", "core.attributesFile=/dev/null", "-c", "core.hooksPath=/dev/null", "-c", "advice.addEmbeddedRepo=false"]
  for (const n of names) out.push("-c", `filter.${n}.clean=cat`, "-c", `filter.${n}.smudge=cat`, "-c", `filter.${n}.process=`, "-c", `filter.${n}.required=false`)
  return out
}

/** Null when `worktree` is not inside a git work tree. Call dispose() when the task is finished. */
export async function createSnapshotStore(worktree: string): Promise<SnapshotStore | null> {
  if ((await git(worktree, ["rev-parse", "--is-inside-work-tree"])) !== "true") return null
  // objects live in the common dir (a linked `git worktree` has its own git-dir without objects/)
  const objects = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])
  if (!objects) return null
  const dir = mkdtempSync(join(tmpdir(), "lca-snap-"))
  mkdirSync(join(dir, "objects"), { recursive: true }) // git refuses to create GIT_OBJECT_DIRECTORY itself
  const env: Record<string, string> = {
    GIT_INDEX_FILE: join(dir, "index"),
    GIT_OBJECT_DIRECTORY: join(dir, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
  }
  const root = realpathSync.native(worktree)
  let overrides: string[] = []
  const store: SnapshotStore = {
    worktree,
    env,
    async snapshot(exclude = []) {
      // fresh index every time so removed files disappear from the tree
      rmSync(env.GIT_INDEX_FILE!, { force: true })
      overrides = await filterOverrides(worktree) // recomputed per snapshot: the worker may have added drivers
      const add = await git(worktree, [...overrides, "add", "-A", "--", ".", ...excludePathspecs(exclude)], env)
      if (add === null) return null
      // write-tree re-reads "racy" index entries through the clean filter too: keep the overrides
      const tree = await git(worktree, [...overrides, "write-tree"], env)
      return tree ? { tree, store } : null
    },
    async diff(before, after, maxChars) {
      if (!before || !after) return null
      if (before.tree === after.tree) return { files: [], diff: "", truncated: false }
      // a tree from another store: expose that store's temp objects as an extra alternate
      const alternates = new Set(env.GIT_ALTERNATE_OBJECT_DIRECTORIES!.split(":"))
      for (const s of [before.store, after.store]) if (s && s !== store) alternates.add(s.env.GIT_OBJECT_DIRECTORY!)
      const denv = { ...env, GIT_ALTERNATE_OBJECT_DIRECTORIES: [...alternates].join(":") }
      const names = (await git(worktree, [...overrides, "diff", "--name-only", "-z", before.tree, after.tree], denv)) ?? ""
      const files = names.split("\0").map((s) => s.trim()).filter(Boolean)
      const raw = (await git(worktree, [...overrides, "diff", "--no-color", "--stat=80", "-p", before.tree, after.tree], denv)) ?? ""
      const truncated = raw.length > maxChars
      const diff = truncated ? raw.slice(0, maxChars) + `\n… (diff truncated, ${raw.length} chars total)` : raw
      return { files, diff, truncated }
    },
    async restore(tree, paths) {
      if (!tree) return []
      const restored: string[] = []
      for (const p of paths) {
        const abs = join(worktree, p)
        // never follow a link the worker may have planted (second review S4): unlink the path itself first, and only
        // write when its parent really is inside the worktree
        try {
          if (lstatSync(abs).isSymbolicLink()) unlinkSync(abs)
        } catch {}
        const content = await gitBuffer(worktree, [...overrides, "cat-file", "-p", `${tree.tree}:${p}`], env)
        if (content === null) {
          rmSync(abs, { force: true })
        } else {
          mkdirSync(dirname(abs), { recursive: true })
          const parent = realpathSync.native(dirname(abs))
          if (parent !== root && !parent.startsWith(root + "/")) continue
          writeFileSync(abs, content)
          // Python caches bytecode by (mtime, size): a same-size cheat written in the same second would keep its
          // compiled form. Drop the file's cache entries and move its mtime so the next run recompiles.
          const t = Math.floor(Date.now() / 1000) + 2
          try {
            utimesSync(abs, t, t)
          } catch {}
          if (/\.py$/.test(p)) {
            const stem = basename(p, ".py")
            const cache = join(dirname(abs), "__pycache__")
            if (existsSync(cache)) for (const f of readdirSafe(cache)) if (f.startsWith(stem + ".")) rmSync(join(cache, f), { force: true })
          }
        }
        restored.push(p)
      }
      return restored
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return store
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// ---- convenience wrappers (tests / one-off): a throwaway store per snapshot ------------------------------------

export async function snapshotTree(worktree: string, exclude: string[] = []): Promise<Snapshot> {
  const store = await createSnapshotStore(worktree)
  if (!store) return null
  const snap = await store.snapshot(exclude)
  if (!snap) store.dispose()
  return snap
}

export async function diffSnapshots(worktree: string, before: Snapshot, after: Snapshot, maxChars: number): Promise<TreeDiff | null> {
  if (!before || !after) return null
  const store = after.store ?? before.store
  if (!store || store.worktree !== worktree) return null
  return store.diff(before, after, maxChars)
}
