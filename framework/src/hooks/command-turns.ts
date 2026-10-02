// OpenCode expands a slash command into its template before chat.message runs, so the literal "/" is gone by then.
// command.execute.before marks the session with the command name; chat.message consumes one mark per turn and
// treats that turn as an explicit command (no skill routing). Marks are counted so back-to-back commands each keep
// their bypass, and they expire so a command that never produced a message cannot suppress routing later.

const TTL_MS = 30_000
export type CommandMark = { name: string; at: number; data?: string }
const marks = new Map<string, CommandMark[]>()

/** `data` carries the command's raw arguments (e.g. /plan's request, /reject's reason) for the chat.message branch that does the state work. */
export function markCommandTurn(sessionID: string, name: string, data?: string, now = Date.now()): void {
  for (const [id, times] of marks) {
    const live = times.filter((m) => now - m.at <= TTL_MS)
    if (live.length) marks.set(id, live)
    else marks.delete(id)
  }
  marks.set(sessionID, [...(marks.get(sessionID) ?? []), { name, at: now, data }])
}

/** The marked command for one turn per unexpired mark (oldest first); later turns, or only-expired marks, return null. */
export function consumeCommandTurn(sessionID: string, now = Date.now()): CommandMark | null {
  const live = (marks.get(sessionID) ?? []).filter((m) => now - m.at <= TTL_MS)
  const hit = live.shift()
  if (live.length) marks.set(sessionID, live)
  else marks.delete(sessionID)
  return hit ?? null
}
