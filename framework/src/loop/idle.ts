// Continuation loop ("loop.idle"): on session.idle of a main session.
//   1. Ledger has open tasks and no queue is running (a delegate call was interrupted: crash, restart, Esc) ->
//      tell main ONCE that it can call `delegate` with resume:true. The queue itself only runs inside a tool call,
//      so main is busy while workers run and the user cannot race it (review F4). This works in every mode.
//   2. Otherwise, mode==="ulw" active -> stage-1 behaviour: re-prompt main with the next incomplete todo.
// Breakers (abort file, max_iterations, ttl, stagnation, failures) are evaluated before the todo path.
// All decisions come from state files + SDK todo list, never from parsing model text (review §5.4).
import { existsSync } from "node:fs"
import { enabled, type HookDeps } from "../hooks/types.ts"
import { abortPath, readModeState, writeModeState, type ModeState } from "../state/store.ts"
import { getGuards } from "../guards/registry.ts"
import { fetchTodos, incompleteTodos, todoFingerprint } from "../guards/todos.ts"
import { openTasks, readLedger, writeLedger } from "../state/ledger.ts"
import { getQueue } from "../orchestration/queue.ts"

export { abortPath }

export const CONTINUE_PROMPT = "Continue with the next incomplete task from your list. Do not restate the plan."
export const IDLE_DEBOUNCE_MS = 3000

export type StopReason = "aborted" | "max_iterations" | "ttl" | "stagnation" | "failures" | "todos_done"

export type IdleOutcome =
  | { action: "ignored"; why: "inactive" | "debounced" | "compaction_guard" | "queue_running" | "state_changed" | "already_notified" }
  | { action: "stopped"; reason: StopReason }
  | { action: "continued"; iterations: number; stagnation: number; remaining: number }
  | { action: "resume_offered"; open: number }

/** Breakers evaluated against the persisted state before we touch todos. */
export function checkBreakers(deps: HookDeps, sessionID: string, state: ModeState, now: number): StopReason | null {
  const { loop } = deps.config
  if (existsSync(abortPath(deps.worktree, sessionID))) return "aborted"
  if (state.iterations >= loop.max_iterations) return "max_iterations"
  if (state.startedAt > 0 && now - state.startedAt > loop.ttl_ms) return "ttl"
  if (state.stagnation >= loop.stagnation) return "stagnation"
  if (state.failures >= loop.failures) return "failures"
  return null
}

export function resumeMessage(open: number, titles: string[]): string {
  const list = titles.slice(0, 5).map((t) => `- ${t}`).join("\n")
  return `[lca] ${open} delegated task(s) from an interrupted run are unfinished:\n${list}${titles.length > 5 ? "\n- …" : ""}\nCall the delegate tool with resume: true to run them, or tell the user they were left unfinished.`
}

export function createIdleLoop(deps: HookDeps): (sessionID: string, now?: number) => Promise<IdleOutcome> {
  const guards = getGuards(deps)
  const queue = getQueue(deps)

  const stop = (sessionID: string, reason: StopReason): IdleOutcome => {
    // write on top of the latest state so a concurrent writer's change is not lost
    const cur = readModeState(deps.worktree, sessionID)
    writeModeState(deps.worktree, sessionID, { ...cur, active: false, stopReason: reason })
    deps.log("loop stopped", { sessionID, reason, iterations: cur.iterations })
    return { action: "stopped", reason }
  }

  return async (sessionID, now = Date.now()) => {
    if (queue.isRunning(sessionID)) return { action: "ignored", why: "queue_running" }

    // ---- interrupted delegation: offer a resume once (any mode); an already-notified ledger falls through to the
    // todo path so a session is never stuck (chat.message also attaches the offer to the user's next message)
    const offered = await offerResume(deps, sessionID)
    if (offered) return { action: "resume_offered", open: offered }

    // ---- stage-1 todo continuation (ulw only)
    const state = readModeState(deps.worktree, sessionID)
    if (state.mode !== "ulw" || !state.active) return { action: "ignored", why: "inactive" }

    const last = guards.lastContinuation.get(sessionID) ?? 0
    if (now - last < IDLE_DEBOUNCE_MS) return { action: "ignored", why: "debounced" }
    guards.lastContinuation.set(sessionID, now) // claim this tick before the first await (double idle)

    const tripped = checkBreakers(deps, sessionID, state, now)
    if (tripped) return stop(sessionID, tripped)

    // Right after a compaction the idle event is noise: skip this tick only, keep the mode active.
    if (state.lastCompactedAt && now - state.lastCompactedAt < deps.config.loop.compaction_guard_ms) {
      deps.log("loop skipped: compaction guard", { sessionID })
      return { action: "ignored", why: "compaction_guard" }
    }

    const todos = await fetchTodos(deps.client, sessionID, deps.log)
    // Optimistic check: a user cancel (/stop, "그만"), a compaction or a tool error may have written mode.json
    // while we were waiting; never overwrite that with our stale copy.
    const cur = readModeState(deps.worktree, sessionID)
    if (!cur.active || cur.updatedAt !== state.updatedAt) {
      deps.log("loop skipped: state changed during todo fetch", { sessionID })
      return { action: "ignored", why: "state_changed" }
    }
    const remaining = incompleteTodos(todos)
    if (remaining.length === 0) return stop(sessionID, "todos_done")

    const fingerprint = todoFingerprint(todos)
    const stagnation = fingerprint === cur.lastFingerprint ? cur.stagnation + 1 : 0
    const next: ModeState = { ...cur, iterations: cur.iterations + 1, stagnation, lastFingerprint: fingerprint }
    if (stagnation >= deps.config.loop.stagnation) {
      writeModeState(deps.worktree, sessionID, next)
      return stop(sessionID, "stagnation")
    }
    writeModeState(deps.worktree, sessionID, next)
    await sendMessage(deps, sessionID, CONTINUE_PROMPT)
    deps.log("loop continued", { sessionID, iterations: next.iterations, stagnation, remaining: remaining.length })
    return { action: "continued", iterations: next.iterations, stagnation, remaining: remaining.length }
  }
}

/**
 * Open tasks left by an interrupted run and nobody told main yet -> inject the resume message once per task id.
 * Returns the number of open tasks when a message was sent, 0 otherwise. Skipped when the delegate tool is disabled
 * (nothing could resume them) or an abort marker is in force.
 */
export async function offerResume(deps: HookDeps, sessionID: string): Promise<number> {
  if (!enabled(deps.config, "tool.delegate")) return 0
  if (existsSync(abortPath(deps.worktree, sessionID))) return 0
  const ledger = readLedger(deps.worktree, sessionID)
  const open = openTasks(ledger)
  if (open.length === 0) return 0
  const told = new Set(ledger.resumeNotifiedFor ?? [])
  if (open.every((t) => told.has(t.id))) return 0
  const sent = await sendMessage(deps, sessionID, resumeMessage(open.length, open.map((t) => t.title)))
  if (!sent) return 0
  const ids = [...new Set([...told, ...open.map((t) => t.id)])]
  writeLedger(deps.worktree, { ...readLedger(deps.worktree, sessionID), resumeNotifiedFor: ids })
  deps.log("loop offered resume", { sessionID, open: open.length })
  return open.length
}

/** Mark open tasks as already offered (chat.message attaches the offer text itself). */
export function markResumeOffered(deps: HookDeps, sessionID: string, ids: string[]): void {
  const ledger = readLedger(deps.worktree, sessionID)
  writeLedger(deps.worktree, { ...ledger, resumeNotifiedFor: [...new Set([...(ledger.resumeNotifiedFor ?? []), ...ids])] })
}

/**
 * Prefer promptAsync (POST /session/{id}/prompt_async, returns immediately). `prompt` blocks until the whole
 * assistant turn finishes, which would stall the event bus, so it is fired without awaiting as a fallback.
 * Parts are marked synthetic so chat.message does not treat them as user text (no mode suffix / detection).
 */
async function sendMessage(deps: HookDeps, sessionID: string, text: string): Promise<boolean> {
  const session = (deps.client as any).session
  const body = { parts: [{ type: "text" as const, text, synthetic: true }] }
  try {
    if (typeof session.promptAsync === "function") {
      const res = await session.promptAsync({ path: { id: sessionID }, body })
      if (res?.error) {
        deps.log("promptAsync returned an error", { sessionID, error: JSON.stringify(res.error).slice(0, 200) })
        return false
      }
      return true
    }
    const p = session.prompt({ path: { id: sessionID }, body })
    if (p && typeof p.then === "function") p.catch((e: unknown) => deps.log("continuation prompt failed", { error: String(e) }))
    return true
  } catch (e) {
    deps.log("continuation prompt threw", { sessionID, error: (e as Error).message })
    return false
  }
}
