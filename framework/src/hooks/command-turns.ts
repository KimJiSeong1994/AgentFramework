// OpenCode expands a slash command into its template before chat.message runs, so the literal "/" is gone by then.
// command.execute.before marks the session; chat.message consumes one mark per turn and treats that turn as an
// explicit command (no skill routing). Marks are counted so back-to-back commands each keep their bypass, and
// they expire so a command that never produced a message cannot suppress routing later.

const TTL_MS = 30_000
const marks = new Map<string, number[]>()

export function markCommandTurn(sessionID: string, now = Date.now()): void {
  for (const [id, times] of marks) {
    const live = times.filter((at) => now - at <= TTL_MS)
    if (live.length) marks.set(id, live)
    else marks.delete(id)
  }
  marks.set(sessionID, [...(marks.get(sessionID) ?? []), now])
}

/** True for one turn per unexpired mark (oldest first); later turns, or only-expired marks, return false. */
export function consumeCommandTurn(sessionID: string, now = Date.now()): boolean {
  const live = (marks.get(sessionID) ?? []).filter((at) => now - at <= TTL_MS)
  const hit = live.shift() !== undefined
  if (live.length) marks.set(sessionID, live)
  else marks.delete(sessionID)
  return hit
}
