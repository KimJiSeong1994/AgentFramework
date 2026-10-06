// `/stop`, `/status`, `/plan`, `/approve`, `/reject`, `/cancel` commands (command.execute.before): the user's hard
// stop for the idle loop and the task queue, the live code-rendered status, and the M1 plan-workflow entry points
// (ralplan §5.2/§5.3/§5.5). Writes abort.json (checked by every breaker), deactivates the mode, and aborts the
// running child session for /stop. The command's template text still reaches the model as a normal user message;
// chat.message turns /stop's template into the cancel suffix (so main finishes its current step and stops),
// rewrites /status's template in place with the rendered status (ARCH-08), and rewrites /plan/approve/reject/cancel
// with the outcome of the state work already done here (this file). Approval is only ever triggered from the
// dispatch branch below for an lca-injected `approve` command turn: prose "/approve"/"approved" never approves.
import type { Hooks } from "@opencode-ai/plugin"
import type { HookDeps } from "./types.ts"
import { EMPTY_MODE, abortPath, readModeState, writeJsonAtomic, writeModeState } from "../state/store.ts"
import { getQueue } from "../orchestration/queue.ts"
import { getOpenCodeRuntime } from "../hosts/opencode-runtime.ts"
import { markCommandTurn } from "./command-turns.ts"

export const STOP_COMMAND = "stop"
export const STOP_TEMPLATE = "stop lca: cancel the active mode and the task queue. Finish the current step, then stop."
export const STOP_DESCRIPTION = "lca: stop the task queue / continuation loop"

export const STATUS_COMMAND = "status"
export const STATUS_TEMPLATE = "Reply only: ok"
export const STATUS_DESCRIPTION = "lca: show the plan workflow, mode, ledger and queue status"

export const PLAN_COMMAND = "plan"
export const PLAN_TEMPLATE = 'Investigate read-only, then call lca_flow op:"plan" once. Ask the user if a step cannot be written.'
export const PLAN_DESCRIPTION = "lca: start a plan workflow (read-only investigation, then a validated, reviewed plan)"

export const APPROVE_COMMAND = "approve"
export const APPROVE_TEMPLATE = "The plan is approved and saved. Call delegate with resume:true now."
export const APPROVE_DESCRIPTION = "lca: approve the pending plan and run it"

export const REJECT_COMMAND = "reject"
export const REJECT_TEMPLATE_PREFIX = "Revise the plan using: "
export const REJECT_TEMPLATE_SUFFIX = '. Call lca_flow op:"plan" again.'
// Registered as the config.command template (placeholder reason); chat.message substitutes the real /reject argument.
export const REJECT_TEMPLATE = `${REJECT_TEMPLATE_PREFIX}<reason>${REJECT_TEMPLATE_SUFFIX}`
export const REJECT_DESCRIPTION = "lca: reject the pending (or invalid) plan with a reason"

export const CANCEL_COMMAND = "cancel"
export const CANCEL_TEMPLATE = "The workflow was cancelled; stop."
export const CANCEL_DESCRIPTION = "lca: cancel the active plan workflow"

export const FLOW_COMMANDS = [PLAN_COMMAND, APPROVE_COMMAND, REJECT_COMMAND, CANCEL_COMMAND] as const

/**
 * Names lca actually wrote into `config.command` this load (a user-defined same-named command wins there and is
 * excluded here, ARCH-13). Recorded by the config hook per `deps`; `createCommandHook` reads it lazily on every
 * call so hook construction order at plugin init does not matter.
 */
const injectedRegistry = new WeakMap<HookDeps, Set<string>>()
export function recordInjectedCommands(deps: HookDeps, names: Set<string>): void {
  injectedRegistry.set(deps, names)
}

/**
 * Dispatch keyed on **names lca injected** into the config (recorded by the config hook). A user-defined command
 * with the same name wins in config.ts and is never acted on here (ARCH-13): only an injected name runs lca
 * command logic. Every command turn is still marked so its expanded template is never skill-routed.
 */
export function createCommandHook(
  deps: HookDeps,
  opts: { stop?: boolean; status?: boolean; flow?: boolean; injected?: Set<string> } = {},
): NonNullable<Hooks["command.execute.before"]> {
  const queue = getQueue(getOpenCodeRuntime(deps))
  const stopOn = opts.stop ?? true
  const statusOn = opts.status ?? false
  const flowCmdsOn = opts.flow ?? false
  // Explicit opts.injected wins; otherwise the config hook's recorded set (real injection, e.g. a user override
  // excluded); falling back to stop/status/flow flags keeps direct unit construction (no config hook run) working.
  const fallback = new Set<string>([
    ...(stopOn ? [STOP_COMMAND] : []),
    ...(statusOn ? [STATUS_COMMAND] : []),
    ...(flowCmdsOn ? FLOW_COMMANDS : []),
  ])
  const fixedInjected = opts.injected
  return async (input) => {
    // Every explicit command keeps its own authority: its expanded template must not be skill-routed. Only a
    // name lca actually injected is marked with that literal name; anything else (a foreign command, or a
    // user-defined command shadowing an lca name) is marked with a synthetic name so the turn still bypasses
    // the router, but no lca command logic ever acts on it.
    const injected = fixedInjected ?? injectedRegistry.get(deps) ?? fallback
    const injectedHere = injected.has(input.command)
    markCommandTurn(input.sessionID, injectedHere ? input.command : `__foreign:${input.command}`, input.arguments)
    if (!injectedHere) return
    if (input.command === STATUS_COMMAND) return // status only marks the turn; chat.message rewrites the text in place
    if (flowCmdsOn && (FLOW_COMMANDS as readonly string[]).includes(input.command)) return // §5.2/§5.5 state work happens in chat.message (handleCommand below), which then rewrites the text
    if (!stopOn || input.command !== STOP_COMMAND) return
    const { sessionID } = input
    try {
      writeJsonAtomic(abortPath(deps.worktree, sessionID), { reason: "user_stop", at: Date.now(), arguments: input.arguments })
      const prev = readModeState(deps.worktree, sessionID)
      writeModeState(deps.worktree, sessionID, { ...EMPTY_MODE, stopReason: "user_stop" })
      const queueWasRunning = queue.isRunning(sessionID)
      if (queueWasRunning) {
        // fire-and-forget: a hung abort endpoint must not hang the command hook
        void queue.abort(sessionID, "user_stop").catch((e: unknown) => deps.log("/stop: queue abort failed", { sessionID, error: String(e) }))
      } else {
        // nothing running: settle open tasks of an interrupted run so no resume is offered later
        queue.cancelOpen(sessionID, "user_stop")
      }
      deps.log("/stop", { sessionID, previousMode: prev.mode, wasActive: prev.active, queueWasRunning })
    } catch (e) {
      deps.log("/stop failed", { sessionID, error: (e as Error).message })
    }
  }
}
