import type { Logger } from "../deps.ts"
import type { Todo } from "../guards/todos.ts"

type SessionOperation = (options: { path: { id: string } }) => Promise<unknown>

/** The narrow part of an OpenCode client used to retrieve session todos. */
export type OpenCodeTodoClient = {
  session?: {
    todo?: SessionOperation
    messages?: SessionOperation
  }
}

export async function fetchOpenCodeTodos(client: OpenCodeTodoClient, sessionID: string, log?: Logger): Promise<Todo[]> {
  const session = client.session
  if (session && typeof session.todo === "function") {
    try {
      const res = await session.todo({ path: { id: sessionID } })
      const data = responseData(res)
      if (Array.isArray(data)) return normalize(data)
      if (hasTruthyError(res)) {
        log?.("todo endpoint returned error, falling back to messages()", { error: "endpoint_error" })
      }
    } catch (error) {
      log?.("todo endpoint threw, falling back to messages()", { error: errorCategory(error) })
    }
  }
  return fetchFromMessages(session, sessionID, log)
}

async function fetchFromMessages(
  session: OpenCodeTodoClient["session"],
  sessionID: string,
  log?: Logger,
): Promise<Todo[]> {
  if (!session || typeof session.messages !== "function") return []
  try {
    const data = responseData(await session.messages({ path: { id: sessionID } }))
    if (!Array.isArray(data)) return []
    for (let i = data.length - 1; i >= 0; i--) {
      const message = record(data[i])
      const parts = Array.isArray(message?.parts) ? message.parts : []
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = record(parts[j])
        if (part?.type !== "tool" || part.tool !== "todowrite") continue
        const state = record(part.state)
        if (state?.status !== "completed") continue
        const metadata = record(state.metadata)
        const input = record(state.input)
        const todos = metadata?.todos ?? input?.todos
        if (Array.isArray(todos)) return normalize(todos)
      }
    }
  } catch (error) {
    log?.("messages() failed while looking for todos", { error: errorCategory(error) })
  }
  return []
}

function responseData(response: unknown): unknown {
  const envelope = record(response)
  return envelope && "data" in envelope ? envelope.data : response
}

function hasTruthyError(response: unknown): boolean {
  const envelope = record(response)
  return !!envelope?.error
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}

function errorCategory(error: unknown): string {
  return error instanceof Error ? "Error" : "non-Error rejection"
}

function normalize(rows: unknown[]): Todo[] {
  return rows
    .filter(isRecord)
    .map((row, index) => ({
      id: String(row.id ?? index),
      content: String(row.content ?? ""),
      status: String(row.status ?? "pending"),
      priority: String(row.priority ?? "medium"),
    }))
}
