// Chat checkpoints: `/undo` for what the chat model changed in a turn.
//
// Before the first effect of a turn (an approved write, edit or command) the worktree is captured; when the turn ends it
// is captured again. `/undo` puts back the files the turn changed, except files that changed again afterwards (by the
// user or a later turn): those are listed and left alone. In a Git work tree the captures are private snapshot trees
// (orchestration/snapshot.ts: private index and object directory, the user's index/HEAD/objects untouched), so files a
// command created, changed or deleted are covered. Outside Git only the files the model wrote or edited are backed up;
// a command's effects there cannot be undone and are reported as such.
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { createSnapshotStore, type Snapshot, type SnapshotStore } from "../orchestration/snapshot.ts"

/** Turns kept for `/undo`; older ones are dropped. */
export const MAX_CHECKPOINT_TURNS = 10
const MAX_BACKUP_BYTES = 8 * 1024 * 1024

type FileBackup = { path: string; before: Buffer | null; after?: Buffer | null }

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
  const root = resolve(worktree)
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
  const read = (rel: string): Buffer | null => {
    const absolute = join(root, rel)
    try {
      const stat = lstatSync(absolute)
      if (!stat.isFile() || stat.size > MAX_BACKUP_BYTES) return null
      return readFileSync(absolute)
    } catch { return null }
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
      if (rel && !current.files.has(rel)) current.files.set(rel, { path: rel, before: read(rel) })
    },
    async endTurn() {
      const turn = current
      current = undefined
      if (!turn) return
      if (turn.git && store) turn.git.after = await store.snapshot().catch(() => null) ?? undefined
      for (const file of turn.files.values()) file.after = read(file.path)
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
          const now = read(file.path)
          const unchangedSince = (now === null && (file.after ?? null) === null) || (now !== null && file.after && now.equals(file.after))
          if (!unchangedSince) { skipped.push(file.path); continue }
          const absolute = join(root, file.path)
          if (file.before === null) rmSync(absolute, { force: true })
          else { mkdirSync(dirname(absolute), { recursive: true }); writeFileSync(absolute, file.before) }
          restored.push(file.path)
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

