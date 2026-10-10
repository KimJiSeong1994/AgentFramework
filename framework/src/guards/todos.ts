// Neutral todo state helpers shared by the idle loop and compaction checkpoint.
import { createHash } from "node:crypto"

export type Todo = {
  content: string
  status: string
  priority: string
  id: string
}

const DONE = new Set(["completed", "cancelled", "canceled"])

export function isIncomplete(todo: Todo): boolean {
  return !DONE.has(String(todo.status ?? "").toLowerCase())
}

export function incompleteTodos(todos: Todo[]): Todo[] {
  return todos.filter(isIncomplete)
}

/** Stable hash of the todo list state (id + status + content), independent of order. */
export function todoFingerprint(todos: Todo[]): string {
  const rows = todos.map((t) => `${t.id}\u0000${t.status}\u0000${t.content}`).sort()
  return createHash("sha1").update(rows.join("\n")).digest("hex")
}
