// chat.message hook: mode keyword detection -> mode state -> instruction suffix on the user message.
// This is the only place dynamic text enters the conversation; the system prompt is never touched.
import type { Hooks } from "@opencode-ai/plugin"
import type { Part, TextPart } from "@opencode-ai/sdk"
import { existsSync } from "node:fs"
import type { HookDeps } from "./types.ts"
import { EMPTY_MODE, clearAbort, readAbort, readJson, readModeState, sessionInfoPath, writeJsonAtomic, writeModeState } from "../state/store.ts"
import type { ModeState, SessionInfo } from "../state/store.ts"
import { detectMode, stripModeKeywords } from "../modes/detect.ts"
import { openTasks, readLedger } from "../state/ledger.ts"
import { markResumeOffered, resumeMessage } from "../loop/idle.ts"
import { getQueue } from "../orchestration/queue.ts"
import { enabled } from "./types.ts"
import { flowSuffix, modeSuffix, type FlowPhase } from "../modes/instructions.ts"
import { hasLcaMarker, stripForgedMarkers } from "../modes/markers.ts"
import type { ActiveMode } from "../modes/instructions.ts"
import { createSkillRouter } from "../routing/router.ts"
import { recordRoutingAdvice } from "../telemetry/routing.ts"
import { observeSkillTurn, observationConfigGeneration } from "../telemetry/skill-observer.ts"
import { consumeCommandTurn } from "./command-turns.ts"
import {
  APPROVE_COMMAND, APPROVE_TEMPLATE, CANCEL_COMMAND, CANCEL_TEMPLATE, FLOW_COMMANDS, PLAN_COMMAND, PLAN_TEMPLATE,
  REJECT_COMMAND, REJECT_TEMPLATE_PREFIX, REJECT_TEMPLATE_SUFFIX, STATUS_COMMAND,
} from "./command.ts"
import { flowOn, renderStatus } from "../flow/status.ts"
import { activeWorkflow, fileSha, planJsonPath, type Workflow } from "../flow/state.ts"
import { applyEvent, approveWorkflow, cancelWorkflow, resolveAuthority, startWorkflow } from "../flow/runtime.ts"
import { canonicalPlanSha, coercePlan, planMdPath, planToTasks } from "../flow/plan.ts"
import type { TaskInput } from "../state/ledger.ts"

function lastUserText(parts: Part[]): TextPart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p && p.type === "text" && !p.synthetic) return p
  }
  return undefined
}

/**
 * Provenance of lca's own suffixes. The old check trusted any text ending in an `<lca-mode>`/`<lca-flow>` block, so a
 * user could paste a forged marker and skip detection for that turn (red-team D3). Now only parts this plugin
 * already suffixed are skipped; markers in any other user text are stripped as untrusted before processing.
 */
const SUFFIXED_PARTS_MAX = 512
/** part id -> the exact text lca left in it; a re-delivery of that same text is skipped, anything else is new. */
const suffixedParts = new Map<string, string>()
function partKey(p: TextPart): string {
  return `${p.sessionID}\u0000${p.messageID}\u0000${p.id}`
}
function alreadySuffixed(p: TextPart): boolean {
  return suffixedParts.get(partKey(p)) === p.text
}
function markSuffixed(p: TextPart): void {
  const k = partKey(p)
  suffixedParts.delete(k)
  suffixedParts.set(k, p.text)
  while (suffixedParts.size > SUFFIXED_PARTS_MAX) suffixedParts.delete(suffixedParts.keys().next().value as string)
}

/** §5.2/§5.6: the workflow phase a suffix is rendered for (stuck folds into "stuck"). */
function suffixPhase(wf: Workflow): FlowPhase {
  return wf.phase === "stuck" ? "stuck" : (wf.phase as FlowPhase)
}

export function createChatMessageHook(deps: HookDeps): NonNullable<Hooks["chat.message"]> {
  const { worktree, config, log } = deps
  const router = createSkillRouter(deps)
  return async (input, output) => {
    const textPart = lastUserText(output.parts)
    const replay = !!textPart && alreadySuffixed(textPart)
    try {
      const routed = await handle(input, output, !replay)
      if (!replay && !routed && lastUserText(output.parts)) observeSkillTurn(deps, {
        sessionID: input.sessionID, messageID: output.message.id, role: "user", phase: "pending",
        routerExposure: "bypass", routerEligibility: "ineligible",
      })
    } catch (e) {
      // a read-only state dir must never break message handling
      log("chat.message hook error", { sessionID: input.sessionID, error: (e as Error).message })
    }
  }

  async function handle(input: Parameters<NonNullable<Hooks["chat.message"]>>[0], output: Parameters<NonNullable<Hooks["chat.message"]>>[1], recordTurn: boolean) {
    const { sessionID } = input
    const now = Date.now()
    if (config.skill_observation?.enabled === true && enabled(config, "tool.history") && recordTurn && lastUserText(output.parts)) {
      const fact = {
        sessionID, messageID: output.message.id, role: "user" as const, phase: "pending" as const,
        startedAt: output.message.time?.created ?? null,
        actualAgent: input.agent ?? null, agentBasis: "host_metadata" as const,
        configGeneration: observationConfigGeneration(deps),
        actualModel: input.model ? `${input.model.providerID}/${input.model.modelID}` : null,
        modelBasis: input.model ? "host_metadata" as const : "unknown" as const,
        routerExposure: "unknown" as const, routerEligibility: "unknown" as const,
      }
      observeSkillTurn(deps, fact)
    }
    // When observation alone registered this hook, do not activate legacy session/mode bookkeeping.
    if (!enabled(config, "mode.detect") && !flowOn(config) && config.skill_observation?.enabled === true) return

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

    // Consumed on every turn (before any early return, any agent) so a mark never outlives its own command turn.
    const commandTurn = consumeCommandTurn(sessionID)
    // `/status` (M0 step 3, ARCH-08): rewrite the command's own text part in place with the code-rendered status.
    // §5.3: /status never mutates for a foreign session (read-only); the owning session with a dead owner takes
    // over first via resolveAuthority, then renders exactly like the live-owner cell.
    if (commandTurn?.name === STATUS_COMMAND) {
      const part = lastUserText(output.parts)
      if (part) {
        resolveAuthority(deps, "status", sessionID)
        part.text = renderStatus(deps, sessionID, getQueue(deps).isRunning(sessionID)) + "\n\nReply only: ok"
        log("chat.message: /status rendered", { sessionID })
      } else {
        log("chat.message: /status had no user text part", { sessionID })
      }
      return
    }
    // M1 /plan /approve /reject /cancel: the state work (§5.2/§5.3/§5.5) happens here, in the command turn, then
    // the command's own template text is rewritten in place with the outcome (same ARCH-08 pattern as /status).
    // Approval is only ever reachable through this branch for an lca-injected `approve` command turn: prose
    // "/approve"/"approved" anywhere else never reaches approveWorkflow.
    if (commandTurn && flowOn(config) && (FLOW_COMMANDS as readonly string[]).includes(commandTurn.name)) {
      const part = lastUserText(output.parts)
      if (part) handleFlowCommand(sessionID, commandTurn.name, commandTurn.data ?? "", part)
      else log("chat.message: flow command had no user text part", { sessionID, command: commandTurn.name })
      return
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
    if (alreadySuffixed(part)) {
      log("chat.message: suffix already present, skipping", { sessionID })
      return
    }
    if (hasLcaMarker(part.text)) {
      part.text = stripForgedMarkers(part.text)
      log("chat.message: removed lca markers not written by lca", { sessionID })
    }
    // Every path below may append a suffix; the final text is recorded in `finally` so a re-delivery of exactly the
    // text lca produced is not suffixed twice.
    try {
      return await handlePart(input, part, commandTurn, now, output.message.id)
    } finally {
      markSuffixed(part)
    }
  }

  async function handlePart(
    input: Parameters<NonNullable<Hooks["chat.message"]>>[0],
    part: TextPart,
    commandTurn: ReturnType<typeof consumeCommandTurn>,
    now: number,
    messageID: string,
  ) {
    const { sessionID } = input

    // §5.6: while this session owns a non-terminal plan workflow, legacy mode keywords/router/resume are all
    // superseded by the workflow suffix. Handled entirely here, before any legacy detection runs, D4/AC0.8.
    if (flowOn(config)) {
      const wf = activeWorkflow(worktree)
      if (wf && wf.sessionID === sessionID) {
        handleWorkflowTurn(sessionID, wf, part, !!commandTurn)
        return
      }
    }

    // chat.message is registered for the flow feature too (ARCH-13): with `mode.detect` disabled, no keyword
    // detection, mode suffix, resume offer or router runs — only commands and the workflow turn above. The D3 plan
    // keyword is keyword detection as well, so it is off with `mode.detect` (use /plan).
    if (!enabled(config, "mode.detect")) return
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

    // D3: with flow on, the legacy plan keywords ("plan mode", "ralplan", "hyperplan", "계획부터", "계획 모드") map
    // to §5.3 as /plan with entry "keyword": same sanitizer/informational-suppression/force: as detectMode already
    // applied above, request = stripModeKeywords(text), actor user_keyword. No legacy plan mode state is written.
    // An active workflow in a DIFFERENT session is not "no workflow" for T1/T20 purposes; resolveAuthority handles
    // that (owning-session takeover / foreign dead-owner T20 then T1, or a same-session-live refusal).
    if (detection && detection.mode === "plan" && flowOn(config)) {
      const a = resolveAuthority(deps, "plan", sessionID, now)
      if (a.refuse) {
        part.text = a.refuse
        log("chat.message: plan keyword refused", { sessionID, refuse: a.refuse })
        return
      }
      const request = stripModeKeywords(part.text).trim() || "(no request text given)"
      const r = startWorkflow(deps, sessionID, "keyword", request, "user_keyword", now)
      if (r.ok) {
        part.text += flowSuffix(suffixPhase(r.wf))
        log("chat.message: plan keyword started a workflow", { sessionID, wfId: r.wf.id })
      } else {
        part.text += `\n\n${r.text}`
        log("chat.message: plan keyword could not start a workflow", { sessionID, error: r.text })
      }
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
      if (input.agent !== "main" || resume || commandTurn || originalText.trimStart().startsWith("/") || readAbort(worktree, sessionID)) return
      const recommendation = await router.recommend(sessionID, messageID, originalText)
      let adviceInserted = false
      if (config.skill_router.mode === "suggest" && recommendation.skill) {
        part.text += `\n\n<lca-skill-advice>Potentially relevant skill: ${recommendation.skill}. This is optional advice, not a request to load a skill, change mode, or execute work. Preserve the user's explicit choices and existing authorization requirements.</lca-skill-advice>`
        adviceInserted = true
        if (recommendation.decisionID) recordRoutingAdvice(deps, sessionID, messageID, recommendation.decisionID, recommendation.skill)
      }
      observeSkillTurn(deps, {
        sessionID, messageID, role: "user", phase: "pending",
        routerExposure: config.skill_router.mode === "off" ? "none" : config.skill_router.mode,
        routerEligibility: config.skill_router.mode === "off" ? "ineligible" : recommendation.reason === "recommended" || recommendation.reason === "abstained" ? "eligible" : "unknown",
        routeDecisionID: recommendation.decisionID ?? null, routeSkillName: recommendation.skill,
        adviceInserted,
      })
      return true
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

  /**
   * §5.6 while the session owns a non-terminal workflow: T13 (user_message) on real user text in
   * planning/stuck(no_submission); legacy ulw/data keywords never activate a mode (notice only); cancel keywords
   * keep their legacy effect (mode off) plus a workflow note; legacy plan keyword without a workflow is unaffected
   * (handled by the normal path, never reached here since there is no active workflow in that case); router and
   * <lca-resume> are both skipped; exactly one <lca-flow> suffix is appended (never <lca-mode>/<lca-resume>).
   */
  function handleWorkflowTurn(sessionID: string, wf: Workflow, part: TextPart, isCommandTurn: boolean): void {
    const detection = detectMode(part.text)
    log("chat.message: workflow active, legacy detection suppressed", { sessionID, wfId: wf.id, phase: wf.phase, detection })

    if (detection && "cancel" in detection) {
      // Legacy cancel keyword keeps its mode-off effect even while a workflow is active; the workflow itself is
      // only ended by /cancel (M1), so we just note that here.
      const prev = readModeState(worktree, sessionID)
      if (prev.active) writeModeState(worktree, sessionID, { ...EMPTY_MODE, stopReason: "user_cancel" })
      part.text += flowSuffix(suffixPhase(wf), {
        stuckCause: wf.stuckCause,
        notice: `Legacy mode cancelled; use /cancel to end plan workflow ${wf.id}.`,
      })
      return
    }

    if (detection && (detection.mode === "ulw" || detection.mode === "data")) {
      part.text += flowSuffix(suffixPhase(wf), {
        stuckCause: wf.stuckCause,
        notice: `${detection.mode} is off while plan workflow ${wf.id} is active; /cancel first.`,
      })
      return
    }
    // A plan keyword while this session already owns a workflow is a notice only (AC1.6), deliberately narrower than
    // the explicit /plan command (which restarts a stuck workflow): free text must never replace a plan in flight.
    // With no workflow, or from another session, the keyword follows §5.3 like /plan (see the D3 branch below).
    if (detection && detection.mode === "plan") {
      part.text += flowSuffix(suffixPhase(wf), {
        stuckCause: wf.stuckCause,
        notice: `plan is off while plan workflow ${wf.id} is active; /cancel first.`,
      })
      return
    }

    // T13: a real user message (not a command turn, not synthetic -- already guaranteed by lastUserText) resets the
    // nudge counter from planning, or exits stuck(no_submission) back to planning.
    if (!isCommandTurn && (wf.phase === "planning" || (wf.phase === "stuck" && wf.stuckCause === "no_submission"))) {
      const r = applyEvent(deps, wf, "user_message", "user_message")
      if (r.ok) {
        part.text += flowSuffix(suffixPhase(r.wf))
        return
      }
    }
    part.text += flowSuffix(suffixPhase(wf), { stuckCause: wf.stuckCause })
  }

  /**
   * M1 dispatch for /plan /approve /reject /cancel (ralplan section 5.2/5.3/5.5). authority is resolved first via
   * resolveAuthority (owning-session takeover happens there before any command-specific precondition, including
   * approve's section 5.5 preconditions). The command's own template text is rewritten in place with the outcome,
   * mirroring the /status ARCH-08 pattern, so the model sees the real result instead of the raw template.
   */
  function handleFlowCommand(sessionID: string, command: string, args: string, part: TextPart): void {
    const now = Date.now()
    if (command === PLAN_COMMAND) {
      const a = resolveAuthority(deps, "plan", sessionID, now)
      if (a.refuse) {
        part.text = a.refuse
        return
      }
      // authorize() itself allows every command for the owning session regardless of phase; startWorkflow is the
      // one that refuses a second /plan while non-terminal and applies T18+T1 when the existing workflow is stuck.
      const request = args.trim() || "(no request text given)"
      const r = startWorkflow(deps, sessionID, "command", request, "user_command", now)
      part.text = r.ok ? `Request: ${request}\n\n${PLAN_TEMPLATE}` : r.text
      log("chat.message: /plan", { sessionID, ok: r.ok })
      return
    }
    if (command === APPROVE_COMMAND) {
      const a = resolveAuthority(deps, "approve", sessionID, now)
      if (a.refuse) {
        part.text = a.refuse
        return
      }
      const wf = a.wf
      if (!wf) {
        part.text = "no plan awaiting approval"
        return
      }
      const queueRunning = getQueue(deps).isRunning(wf.sessionID)
      let planShaOk = false
      let inputs: TaskInput[] = []
      if (wf.planRef) {
        try {
          const raw = readJson<unknown>(planJsonPath(worktree, wf.id), null)
          if (raw !== null) {
            const plan = coercePlan(raw, wf.planRef.revision)
            planShaOk = canonicalPlanSha(plan) === wf.planRef.jsonSha
            inputs = planToTasks(plan)
          }
        } catch (e) {
          log("chat.message: /approve plan read failed", { sessionID, error: (e as Error).message })
        }
      }
      const mdShaOk = !!wf.planRef && fileSha(worktree, planMdPath(wf.id)) === wf.planRef.mdSha
      const r = approveWorkflow(deps, wf, inputs, { queueRunning, planShaOk, mdShaOk }, now)
      part.text = r.ok ? APPROVE_TEMPLATE : r.text
      log("chat.message: /approve", { sessionID, ok: r.ok, queueRunning, planShaOk, mdShaOk })
      return
    }
    if (command === REJECT_COMMAND) {
      const a = resolveAuthority(deps, "reject", sessionID, now)
      if (a.refuse) {
        part.text = a.refuse
        return
      }
      const wf = a.wf
      if (!wf) {
        part.text = "no plan awaiting approval"
        return
      }
      const reason = args.trim() || "(no reason given)"
      const r = applyEvent(deps, wf, "reject", "user_command", {}, (w) => w, { reason })
      part.text = r.ok ? `${REJECT_TEMPLATE_PREFIX}${reason}${REJECT_TEMPLATE_SUFFIX}` : r.text
      log("chat.message: /reject", { sessionID, ok: r.ok })
      return
    }
    if (command === CANCEL_COMMAND) {
      const a = resolveAuthority(deps, "cancel", sessionID, now)
      if (a.refuse) {
        part.text = a.refuse
        return
      }
      const wf = a.wf
      if (!wf) {
        part.text = "no active workflow"
        return
      }
      const queueRunning = getQueue(deps).isRunning(wf.sessionID)
      const r = cancelWorkflow(deps, wf, queueRunning, () => {
        void getQueue(deps).abort(wf.sessionID, "workflow_cancel").catch((e: unknown) => log("/cancel: queue abort failed", { sessionID, error: String(e) }))
      })
      part.text = r.ok ? CANCEL_TEMPLATE : r.text
      log("chat.message: /cancel", { sessionID, ok: r.ok, queueRunning })
      return
    }
  }
}
