// event hook: (a) runaway-generation guard on streaming assistant text, (b) tool outcomes/error bookkeeping,
// (c) session.compacted -> lastCompactedAt, (d) session.idle -> continuation loop. Never throws (a rejection here
// would surface as a defect inside OpenCode's bus subscriber).
import type { Hooks } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { enabled, type HookDeps } from "./types.ts"
import { readModeState, removeSessionDir, writeJsonAtomic, writeModeState } from "../state/store.ts"
import { getGuards } from "../guards/registry.ts"
import { abortPath, createIdleLoop } from "../loop/idle.ts"
import { getQueue } from "../orchestration/queue.ts"
import { recordToolOutcome } from "../telemetry/outcomes.ts"
import { onSessionDeleted } from "../flow/runtime.ts"
import { flowOn } from "../flow/status.ts"
import { observeSkillMessage, observeSkillPart, observeRelatedToolPart, observeSkillBoundary } from "../telemetry/skill-observer.ts"
import { getOpenCodeRuntime, policyForOpenCodeSession } from "../hosts/opencode-runtime.ts"

const MAX_TRACKED_MESSAGES = 200
const MAX_TRACKED_CALLS = 200

export function createEventHook(deps: HookDeps): NonNullable<Hooks["event"]> {
  const guards = getGuards(deps)
  const repetitionOn = enabled(deps.config, "guard.repetition")
  const repeatOn = enabled(deps.config, "guard.repeat")
  const toolHistoryOn = enabled(deps.config, "tool.history")
  const idle = createIdleLoop(deps)
  const queue = getQueue(getOpenCodeRuntime(deps))

  /** messageID -> role, from message.updated (TextPart carries no role). */
  const roles = new Map<string, "user" | "assistant">()
  /** parts already aborted for repetition */
  const abortedParts = new Set<string>()
  /** tool callIDs whose error we already recorded (part.updated may repeat) */
  const failedCalls = new Set<string>()

  return async ({ event }) => {
    try {
      await handle(event as Event)
    } catch (e) {
      deps.log("event hook error", { type: (event as Event)?.type, error: (e as Error)?.message ?? String(e) })
    }
  }

  async function handle(event: Event): Promise<void> {
    switch (event.type) {
      case "message.updated": {
        const info = event.properties.info
        observeSkillMessage(deps, info)
        roles.set(info.id, info.role)
        while (roles.size > MAX_TRACKED_MESSAGES) roles.delete(roles.keys().next().value as string)
        return
      }
      case "message.part.updated": {
        const part = event.properties.part
        if (part.type === "text") return onText(part.sessionID, part.messageID, part.id, part.text, event.properties.delta)
        if (part.type === "tool") {
          observeSkillPart(deps, part)
          observeRelatedToolPart(deps, part)
          if (toolHistoryOn && (part.state.status === "error" || part.state.status === "completed")) {
            try {
              recordToolOutcome(deps.worktree, part)
            } catch {
              try {
                deps.log("tool outcome recording failed")
              } catch {}
            }
          }
          if (part.state.status === "error") return onToolError(part.sessionID, part.callID, part.state.error)
        }
        return
      }
      case "session.compacted": {
        const sessionID = event.properties.sessionID
        observeSkillBoundary(deps, sessionID, "compacted")
        const state = readModeState(deps.worktree, sessionID)
        writeModeState(deps.worktree, sessionID, { ...state, lastCompactedAt: Date.now() })
        deps.log("session compacted", { sessionID })
        return
      }
      case "session.idle": {
        // The workflow branch inside idle() must run even when loop.idle is disabled (settle is state repair,
        // not continuation); idle() itself decides whether it is on the workflow path.
        await idle(event.properties.sessionID)
        return
      }
      case "session.deleted": {
        const id = event.properties.info?.id
        if (id) {
          observeSkillBoundary(deps, id, "deleted")
          guards.repetition.clear(id)
          guards.repeat.clear(id)
          const running = queue.isRunning(id)
          if (flowOn(deps.config)) {
            try {
              onSessionDeleted(deps, id, running, () => {
                void queue.abort(id, "session deleted", { discard: true })
              })
            } catch (e) {
              deps.log("session.deleted: workflow handling failed", { sessionID: id, error: (e as Error).message })
            }
          }
          if (running) {
            // discard: the queue must not resurrect the deleted session's state dir while it winds down
            void queue.abort(id, "session deleted", { discard: true }).finally(() => removeSessionDir(deps.worktree, id))
          } else {
            removeSessionDir(deps.worktree, id)
          }
        }
        return
      }
      default:
        return
    }
  }

  async function onText(sessionID: string, messageID: string, partID: string, text: string, delta: string | undefined) {
    const bound = policyForOpenCodeSession(deps, sessionID)
    if (!repetitionOn && !bound) return
    const role = roles.get(messageID)
    // Unknown role + no streaming delta: most likely a user part; never abort on pasted user text.
    if (role === "user" || (role === undefined && delta === undefined)) return
    if (abortedParts.has(partID)) return
    const res = bound ? null : guards.repetition.feed(sessionID, partID, text)
    const cancel = bound
      ? bound.assistantText({ type: "text", sessionID, partID, text, final: false }).cancel
      : res!.repeating && deps.config.guards.abort_on_repetition
    if (res?.repeating) deps.log("repetition detected", { sessionID, partID, sample: res.sample })
    if (!cancel) return
    if (bound) deps.log("repetition detected", { sessionID, partID })
    abortedParts.add(partID)
    writeJsonAtomic(abortPath(deps.worktree, sessionID), {
      reason: "repetition",
      at: Date.now(),
      messageID,
      partID,
      ...(res ? { sample: res.sample } : {}),
      chars: text.length,
    })
    try {
      await deps.client.session.abort({ path: { id: sessionID } })
      deps.log("session aborted for repetition", { sessionID })
    } catch (e) {
      deps.log("abort failed", { sessionID, error: (e as Error).message })
    }
  }

  function onToolError(sessionID: string, callID: string, error: string) {
    if (failedCalls.has(callID)) return
    failedCalls.add(callID)
    while (failedCalls.size > MAX_TRACKED_CALLS) failedCalls.delete(failedCalls.values().next().value as string)
    const bound = policyForOpenCodeSession(deps, sessionID)
    if (bound) bound.toolResult({ type: "tool-result", sessionID, callID, toolID: callID, name: "unknown", error })
    else if (repeatOn) guards.repeat.recordResult(sessionID, callID, false, error)
    const state = readModeState(deps.worktree, sessionID)
    if (state.active) writeModeState(deps.worktree, sessionID, { ...state, failures: state.failures + 1 })
  }
}
