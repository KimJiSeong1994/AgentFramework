// Chat checkpoints: `/undo` for what the chat model changed in a turn.
//
// Before the first effect of a turn (an approved write, edit or command) the worktree is captured; when the turn ends it
// is captured again. `/undo` puts back the files the turn changed, except files that changed again afterwards (by the
// user or a later turn): those are listed and left alone. In a Git work tree the captures are private snapshot trees
// (orchestration/snapshot.ts: private index and object directory, the user's index/HEAD/objects untouched), so files a
// command created, changed or deleted are covered. Outside Git only the files the model wrote or edited are backed up;
// a command's effects there cannot be undone and are reported as such.
import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { createSnapshotStore, type Snapshot, type SnapshotStore } from "../orchestration/snapshot.ts"
import { FdTree, FdTreeError, type FdStat } from "../skills/fd-tree.ts"

/** Turns kept for `/undo`; older ones are dropped. */
export const MAX_CHECKPOINT_TURNS = 10
const MAX_BACKUP_BYTES = 8 * 1024 * 1024

type FileState = { bytes: Buffer; stat: FdStat } | null
type FileBackup = { path: string; before: FileState; after?: FileState }

type TurnCheckpoint = {
  id: number
  label: string
  at: number
  git?: { before: Snapshot; after?: Snapshot }
  files: Map<string, FileBackup>
  /** A command ran outside Git: its effects are not covered. */
  uncovered: boolean
  undone: boolean
}

export type UndoResult = {
  restored: string[]
  /** Changed again after the turn ended; left as they are. */
  skipped: string[]
  /** True when some of the turn's effects (commands outside Git) could not be undone. */
  partial: boolean
}

export type ChatCheckpoints = {
  /** Called right before an effect of the current turn; captures the worktree once per turn. */
  beforeEffect(effect: { tool: "write" | "edit" | "bash"; path?: string }): Promise<void>
  /** The turn ended: capture what it left, so later changes can be told apart. */
  endTurn(): Promise<void>
  /** Turns that changed something and can still be undone, newest first. */
  list(): Array<{ id: number; label: string; at: number; files: number | undefined }>
  /** Undo the newest not-yet-undone turn, or the one with `id`. */
  undo(id?: number): Promise<UndoResult | undefined>
  dispose(): void
}

export function createChatCheckpoints(worktree: string, label: () => string): ChatCheckpoints {
  const root = realpathSync(worktree)
  const rootIdentity = lstatSync(root, { bigint: true })
  const turns: TurnCheckpoint[] = []
  let current: TurnCheckpoint | undefined
  let store: SnapshotStore | null | undefined
  let sequence = 0

  const snapshotStore = async (): Promise<SnapshotStore | null> => {
    if (store === undefined) {
      try { store = await createSnapshotStore(worktree) } catch { store = null }
    }
    return store
  }
  const inside = (path: string): string | undefined => {
    const absolute = resolve(root, path)
    const rel = relative(root, absolute)
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : undefined
  }
  const readFrom = (tree: FdTree, rel: string): FileState => {
    try {
      if (tree.statRelative(rel).size > BigInt(MAX_BACKUP_BYTES)) throw new Error("checkpoint file exceeds limit")
      return tree.readFileRelative(rel)
    } catch (error) {
      if (error instanceof FdTreeError && error.code === 2) return null
      throw error
    }
  }
  const read = (rel: string): FileState => {
    const tree = FdTree.openRoot(root, rootIdentity)
    try {
      const value = readFrom(tree, rel)
      tree.assertStable()
      return value
    } finally { tree.close() }
  }

  return {
    async beforeEffect(effect) {
      if (!current) {
        current = { id: ++sequence, label: label(), at: Date.now(), files: new Map(), uncovered: false, undone: false }
        const git = await snapshotStore()
        if (git) {
          const before = await git.snapshot().catch(() => null)
          if (before) current.git = { before }
        }
        turns.push(current)
        while (turns.length > MAX_CHECKPOINT_TURNS) turns.shift()
      }
      if (current.git) return
      if (effect.tool === "bash") { current.uncovered = true; return }
      const rel = effect.path ? inside(effect.path) : undefined
      if (rel && !current.files.has(rel)) {
        try { current.files.set(rel, { path: rel, before: read(rel) }) }
        catch { current.uncovered = true }
      }
    },
    async endTurn() {
      const turn = current
      current = undefined
      if (!turn) return
      if (turn.git && store) turn.git.after = await store.snapshot().catch(() => null) ?? undefined
      for (const file of turn.files.values()) {
        try { file.after = read(file.path) } catch { turn.uncovered = true }
      }
    },
    list() {
      return turns.filter(turn => !turn.undone).reverse().map(turn => ({ id: turn.id, label: turn.label, at: turn.at,
        files: turn.git ? undefined : turn.files.size }))
    },
    async undo(id) {
      const turn = id === undefined ? [...turns].reverse().find(candidate => !candidate.undone) : turns.find(candidate => candidate.id === id && !candidate.undone)
      if (!turn || turn === current) return undefined
      const restored: string[] = []
      const skipped: string[] = []
      if (turn.git && (!turn.git.after || !store)) throw new Error("undo unavailable: the turn's final Git checkpoint could not be captured")
      if (turn.git?.before && turn.git.after && store) {
        const changed = await store.diff(turn.git.before, turn.git.after, 0)
        const now = await store.snapshot().catch(() => null)
        const later = now ? await store.diff(turn.git.after, now, 0) : null
        if (!changed || !later) throw new Error("the worktree could not be compared with the checkpoint")
        const changedLater = new Set(later.files)
        const restorable = changed.files.filter(file => {
          if (changedLater.has(file)) { skipped.push(file); return false }
          return true
        })
        restored.push(...await store.restore(turn.git.before, restorable))
      } else {
        for (const file of turn.files.values()) {
          let tree: FdTree | undefined
          try {
            if (file.after === undefined) throw new Error("checkpoint unavailable")
            tree = FdTree.openRoot(root, rootIdentity)
            const now = readFrom(tree, file.path)
            const unchangedSince = now === null ? file.after === null : file.after !== null &&
              now.stat.dev === file.after.stat.dev && now.stat.ino === file.after.stat.ino && now.bytes.equals(file.after.bytes)
            if (!unchangedSince) throw new Error("checkpoint target changed")
            const parent = dirname(file.path) === "." ? tree.root : tree.openDirectoryRelative(dirname(file.path))
            tree.restoreFileAt(parent, basename(file.path), now, file.before?.bytes ?? null)
            restored.push(file.path)
          } catch { skipped.push(file.path) }
          finally { tree?.close() }
        }
      }
      turn.undone = true
      return { restored, skipped, partial: turn.uncovered }
    },
    dispose() {
      store?.dispose()
      store = null
      turns.length = 0
      current = undefined
    },
  }
}

