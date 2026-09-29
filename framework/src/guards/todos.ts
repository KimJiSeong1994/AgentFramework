// Todo access shared by the idle loop and the compaction checkpoint. Uses the SDK endpoint GET /session/{id}/todo
// (client.session.todo, verified in @opencode-ai/sdk types.gen.d.ts: SessionTodoResponses[200] = Array<Todo>).
// Falls back to scanning messages() for the last completed `todowrite` tool part.
import { createHash } from "node:crypto"
import type { Todo } from "@opencode-ai/sdk"
import type { HookDeps, Logger } from "../hooks/types.ts"

export type { Todo }

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

export async function fetchTodos(client: HookDeps["client"], sessionID: string, log?: Logger): Promise<Todo[]> {
  const session = (client as any)?.session
  if (session && typeof session.todo === "function") {
    try {
      const res = await session.todo({ path: { id: sessionID } })
      const data = res && typeof res === "object" && "data" in res ? (res as { data: unknown }).data : res
      if (Array.isArray(data)) return normalize(data)
      if (res && typeof res === "object" && "error" in res && (res as any).error) {
        log?.("todo endpoint returned error, falling back to messages()", { error: String((res as any).error) })
      }
    } catch (e) {
      log?.("todo endpoint threw, falling back to messages()", { error: (e as Error).message })
    }
  }
  return fetchTodosFromMessages(client, sessionID, log)
}

async function fetchTodosFromMessages(client: HookDeps["client"], sessionID: string, log?: Logger): Promise<Todo[]> {
  const session = (client as any)?.session
  if (!session || typeof session.messages !== "function") return []
  try {
    const res = await session.messages({ path: { id: sessionID } })
    const data = res && typeof res === "object" && "data" in res ? (res as { data: unknown }).data : res
    if (!Array.isArray(data)) return []
    for (let i = data.length - 1; i >= 0; i--) {
      const parts: any[] = Array.isArray(data[i]?.parts) ? data[i].parts : []
      for (let j = parts.length - 1; j >= 0; j--) {
        const p = parts[j]
        if (p?.type !== "tool" || p.tool !== "todowrite" || p.state?.status !== "completed") continue
        const todos = p.state.metadata?.todos ?? p.state.input?.todos
        if (Array.isArray(todos)) return normalize(todos)
      }
    }
  } catch (e) {
    log?.("messages() failed while looking for todos", { error: (e as Error).message })
  }
  return []
}

function normalize(rows: unknown[]): Todo[] {
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r, i) => ({
      id: String(r.id ?? i),
      content: String(r.content ?? ""),
      status: String(r.status ?? "pending"),
      priority: String(r.priority ?? "medium"),
    }))
}
