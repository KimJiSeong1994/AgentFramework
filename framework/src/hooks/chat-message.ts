// chat.message hook: mode keyword detection -> mode state -> instruction suffix on the user message.
// This is the only place dynamic text enters the conversation; the system prompt is never touched.
import type { Hooks } from "@opencode-ai/plugin"
import type { Part, TextPart } from "@opencode-ai/sdk"
import { existsSync } from "node:fs"
import type { HookDeps } from "./types.ts"
import { EMPTY_MODE, clearAbort, readAbort, readModeState, sessionInfoPath, writeJsonAtomic, writeModeState } from "../state/store.ts"
import type { ModeState, SessionInfo } from "../state/store.ts"
import { detectMode, stripModeKeywords } from "../modes/detect.ts"
import { openTasks, readLedger } from "../state/ledger.ts"
import { markResumeOffered, resumeMessage } from "../loop/idle.ts"
import { getQueue } from "../orchestration/queue.ts"
import { enabled } from "./types.ts"
import { hasModeSuffix, modeSuffix } from "../modes/instructions.ts"
import type { ActiveMode } from "../modes/instructions.ts"
import { createSkillRouter } from "../routing/router.ts"

function lastUserText(parts: Part[]): TextPart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p && p.type === "text" && !p.synthetic) return p
  }
  return undefined
}

export function createChatMessageHook(deps: HookDeps): NonNullable<Hooks["chat.message"]> {
  const { worktree, config, log } = deps
  const router = createSkillRouter(deps)
  return async (input, output) => {
    try {
      await handle(input, output)
    } catch (e) {
      // a read-only state dir must never break message handling
      log("chat.message hook error", { sessionID: input.sessionID, error: (e as Error).message })
    }
  }

  async function handle(input: Parameters<NonNullable<Hooks["chat.message"]>>[0], output: Parameters<NonNullable<Hooks["chat.message"]>>[1]) {
    const { sessionID } = input
    const now = Date.now()

    // session -> agent map (chat.message is the only hook that reliably sees the agent). Its own try/catch: a
    // read-only state dir must not silently drop the mode suffix below.
    try {
      const infoPath = sessionInfoPath(worktree, sessionID)
      if (!existsSync(infoPath)) {
        const info: SessionInfo = {
          agent: input.agent,
          model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
          createdAt: now,
        }
        writeJsonAtomic(infoPath, info)
      }
    } catch (e) {
      log("chat.message: session info write failed", { sessionID, error: (e as Error).message })
    }

    // Child sessions (worker/reviewer) get their prompt from the queue: never detect modes in them.
    if (input.agent && input.agent !== "main") {
      log("chat.message: non-main agent, no mode detection", { sessionID, agent: input.agent })
      return
    }
    // Any newer main-agent turn, including /stop or synthetic input, invalidates older advice.
    router.cancel(sessionID)

    const part = lastUserText(output.parts)
    if (!part) {
      log("chat.message: no user text part", { sessionID, parts: output.parts.map((p) => `${p.type}${(p as TextPart).synthetic ? "(synthetic)" : ""}`) })
      return
    }
    if (hasModeSuffix(part.text)) {
      log("chat.message: suffix already present, skipping", { sessionID })
      return
    }

    const detection = detectMode(part.text)
    const originalText = part.text
    log("chat.message: detection", { sessionID, agent: input.agent, detection, chars: part.text.length })
    // A genuine new user message (not the /stop text) lifts a user_stop marker so the next delegate call may run.
    if (!(detection && "cancel" in detection) && readAbort(worktree, sessionID)?.reason === "user_stop") {
      clearAbort(worktree, sessionID)
      log("user_stop marker cleared by a new user message", { sessionID })
    }
    if (detection && "cancel" in detection) {
      const prev = readModeState(worktree, sessionID)
      writeModeState(worktree, sessionID, { ...EMPTY_MODE, stopReason: "user_cancel" })
      if (prev.active) part.text += modeSuffix("cancel")
      log("mode cancelled", { sessionID, previous: prev.mode, wasActive: prev.active })
      return
    }

    // Unfinished delegated tasks (crash/restart/Esc): attach the resume offer to this very message, once, so main
    // resumes instead of re-planning the same work (live review E2a: the idle-only offer was never reached).
    const resume = resumeSuffix(sessionID)

    if (detection && detection.mode !== "none") {
      const mode = detection.mode as ActiveMode
      const state: ModeState = {
        ...EMPTY_MODE,
        mode,
        active: true,
        startedAt: now,
        updatedAt: now,
      }
      writeModeState(worktree, sessionID, state)
      if (clearAbort(worktree, sessionID)) log("mode activation cleared a stale abort marker", { sessionID })
      part.text += resume + modeSuffix(mode, undefined, deps.config)
      log("mode activated", {
        sessionID,
        mode,
        keyword: detection.keyword,
        force: detection.force,
        chars: stripModeKeywords(part.text).length,
      })
      return
    }

    // No keyword: keep the active mode's suffix per turn until it expires or is cancelled.
    const state = readModeState(worktree, sessionID)
    if (!state.active || state.mode === "none") {
      part.text += resume
      // Explicit commands and existing continuation offers retain their own authority.
      if (input.agent !== "main" || resume || originalText.trimStart().startsWith("/") || readAbort(worktree, sessionID)) return
      const recommendation = await router.recommend(sessionID, output.message.id, originalText)
      if (config.skill_router.mode === "suggest" && recommendation.skill) {
        part.text += `\n\n<lca-skill-advice>Potentially relevant skill: ${recommendation.skill}. This is optional advice, not a request to load a skill, change mode, or execute work. Preserve the user's explicit choices and existing authorization requirements.</lca-skill-advice>`
      }
      return
    }
    if (now - state.startedAt > config.loop.ttl_ms) {
      writeModeState(worktree, sessionID, { ...state, active: false, stopReason: "ttl_expired" })
      log("mode expired", { sessionID, mode: state.mode, startedAt: state.startedAt })
      return
    }
    part.text += resume + modeSuffix(state.mode, undefined, deps.config)
    log("mode continued", { sessionID, mode: state.mode, iterations: state.iterations })
  }

  function resumeSuffix(sessionID: string): string {
    try {
      if (!enabled(config, "tool.delegate") || getQueue(deps).isRunning(sessionID)) return ""
      const ledger = readLedger(worktree, sessionID)
      const open = openTasks(ledger)
      if (open.length === 0) return ""
      const told = new Set(ledger.resumeNotifiedFor ?? [])
      if (open.every((t) => told.has(t.id))) return ""
      markResumeOffered(deps, sessionID, open.map((t) => t.id))
      log("resume offer attached to user message", { sessionID, open: open.length })
      return `\n\n<lca-resume>${resumeMessage(open.length, open.map((t) => t.title))}</lca-resume>`
    } catch (e) {
      log("resume suffix failed", { sessionID, error: (e as Error).message })
      return ""
    }
  }
}
