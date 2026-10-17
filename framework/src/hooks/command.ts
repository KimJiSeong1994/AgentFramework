// Explicit SDK commands. /stop durably holds the proven owner before cancellation; /continue confirm is the
// only SDK command that can acknowledge a settled user_stop. Plan approval remains tied to an injected command
// turn, never prose. chat.message renders the command status receipt but performs no admission or workflow work.
import type { Hooks } from "@opencode-ai/plugin"
import type { HookDeps } from "./types.ts"
import { EMPTY_MODE, abortPath, readModeState, writeModeState } from "../state/store.ts"
import { getQueue } from "../orchestration/queue.ts"
import { getOpenCodeRuntime } from "../hosts/opencode-runtime.ts"
import { markCommandTurn } from "./command-turns.ts"
import { executionActivity } from "../hosts/runtime.ts"
import { settled } from "../hosts/run-state.ts"
import { readWorkflowChecked } from "../flow/state.ts"
import { resumePaused } from "../flow/resume.ts"
import { admissionFence, attachHeldAdmission, effectiveHold, holdOwnedAdmission, resumeAdmission } from "../sessions/admission.ts"
import { getOwnedSession, readSessionMetadata } from "../sessions/store.ts"
import { assertSDKSessionQuiescent, readSDKResumeIdentity } from "../sessions/sdk-quiescence.ts"
import { captureSDKSessionLifetime } from "../sessions/sdk-transcript.ts"
import { durableWriteJson } from "../state/durable.ts"

export const STOP_COMMAND = "stop"
export const STOP_TEMPLATE = "stop otter: cancel the active mode and the task queue. Finish the current step, then stop."
export const STOP_DESCRIPTION = "otter: stop the task queue / continuation loop"

export const STATUS_COMMAND = "status"
export const STATUS_TEMPLATE = "Reply only: ok"
export const STATUS_DESCRIPTION = "otter: show the plan workflow, mode, ledger and queue status"

export const PLAN_COMMAND = "plan"
export const PLAN_TEMPLATE = 'Investigate read-only, then call otter_flow op:"plan" once. Ask the user if a step cannot be written.'
export const PLAN_DESCRIPTION = "otter: start a plan workflow (read-only investigation, then a validated, reviewed plan)"

export const APPROVE_COMMAND = "approve"
export const APPROVE_TEMPLATE = "The plan is approved and saved. Call delegate with resume:true now."
export const APPROVE_DESCRIPTION = "otter: approve the pending plan and run it"

export const REJECT_COMMAND = "reject"
export const REJECT_TEMPLATE_PREFIX = "Revise the plan using: "
export const REJECT_TEMPLATE_SUFFIX = '. Call otter_flow op:"plan" again.'
// Registered as the config.command template (placeholder reason); chat.message substitutes the real /reject argument.
export const REJECT_TEMPLATE = `${REJECT_TEMPLATE_PREFIX}<reason>${REJECT_TEMPLATE_SUFFIX}`
export const REJECT_DESCRIPTION = "otter: reject the pending (or invalid) plan with a reason"

export const CANCEL_COMMAND = "cancel"
export const CANCEL_TEMPLATE = "The workflow was cancelled; stop."
export const CANCEL_DESCRIPTION = "otter: cancel the active plan workflow"

export const CONTINUE_COMMAND = "continue"
export const CONTINUE_TEMPLATE = "Otter explicit Resume command. Use /continue confirm to acknowledge a held session."
export const CONTINUE_DESCRIPTION = "otter: explicitly resume the current held session (requires confirm)"
export const CONTINUE_CONFIRMATION_PROMPT = "To acknowledge explicit owner Resume, run /continue confirm. This command did not change session admission."
export const CONTINUE_HELD_RECEIPT = "Resume was refused; this command granted no admission and started no work."
export const CONTINUE_PAUSED_RESUMED_RECEIPT = "Paused workflow resumed for this attachment epoch only. Residual approved tasks are not started; ask main to call delegate with resume:true."
export const CONTINUE_RESUMED_RECEIPT = "Session admission resumed for this attachment epoch only. No workflow or task was started."

export const FLOW_COMMANDS = [PLAN_COMMAND, APPROVE_COMMAND, REJECT_COMMAND, CANCEL_COMMAND] as const
const CONTINUE_RECEIPT_TTL_MS = 30_000
type ContinueReceipt = { arguments: string; text: string; at: number }
const continueReceipts = new WeakMap<HookDeps, Map<string, ContinueReceipt[]>>()

function recordContinueReceipt(deps: HookDeps, sessionID: string, args: string, text: string): void {
  let bySession = continueReceipts.get(deps)
  if (!bySession) continueReceipts.set(deps, bySession = new Map())
  const now = Date.now()
  for (const [id, entries] of bySession) {
    const live = entries.filter(entry => now - entry.at <= CONTINUE_RECEIPT_TTL_MS)
    if (live.length) bySession.set(id, live)
    else bySession.delete(id)
  }
  bySession.set(sessionID, [...(bySession.get(sessionID) ?? []), { arguments: args, text, at: now }])
}

/** Consume the status produced by this exact command-argument turn; receipts never authorize admission. */
export function consumeContinueReceipt(deps: HookDeps, sessionID: string, args: string): string | undefined {
  const bySession = continueReceipts.get(deps)
  const entries = bySession?.get(sessionID)
  if (!entries) return undefined
  const now = Date.now()
  const live = entries.filter(entry => now - entry.at <= CONTINUE_RECEIPT_TTL_MS)
  const index = live.findIndex(entry => entry.arguments === args)
  const receipt = index < 0 ? undefined : live.splice(index, 1)[0]
  if (live.length) bySession!.set(sessionID, live)
  else bySession!.delete(sessionID)
  return receipt?.text
}

function canCancelOpenQueue(runtime: ReturnType<typeof getOpenCodeRuntime>, queueRunning: boolean): boolean {
  if (queueRunning || executionActivity(runtime.worktree)) return false
  try {
    const status = runtime.runs.status()
    return !status.claim && status.executions.every(settled)
  } catch {
    return false
  }
}

/**
 * Names otter actually wrote into `config.command` this load (a user-defined same-named command wins there and is
 * excluded here, ARCH-13). Recorded by the config hook per `deps`; `createCommandHook` reads it lazily on every
 * call so hook construction order at plugin init does not matter.
 */
const injectedRegistry = new WeakMap<HookDeps, Set<string>>()
export function recordInjectedCommands(deps: HookDeps, names: Set<string>): void {
  injectedRegistry.set(deps, names)
}

/**
 * Dispatch keyed on **names otter injected** into the config (recorded by the config hook). A user-defined command
 * with the same name wins in config.ts and is never acted on here (ARCH-13): only an injected name runs otter
 * command logic. Every command turn is still marked so its expanded template is never skill-routed.
 */
export function createCommandHook(
  deps: HookDeps,
  opts: { stop?: boolean; status?: boolean; flow?: boolean; continue?: boolean } = {},
): NonNullable<Hooks["command.execute.before"]> {
  const runtime = getOpenCodeRuntime(deps)
  const queue = getQueue(runtime)
  const stopOn = opts.stop ?? true
  const statusOn = opts.status ?? false
  const flowCmdsOn = opts.flow ?? false
  const continueOn = opts.continue ?? true
  const enabledCommands = new Set<string>([
    ...(stopOn ? [STOP_COMMAND] : []),
    ...(statusOn ? [STATUS_COMMAND] : []),
    ...(flowCmdsOn ? FLOW_COMMANDS : []),
    ...(continueOn ? [CONTINUE_COMMAND] : []),
  ])
  return async (input) => {
    // Every explicit command keeps its own authority: its expanded template must not be skill-routed. Only a
    // name otter actually injected is marked with that literal name; anything else (a foreign command, or a
    // user-defined command shadowing an otter name) is marked with a synthetic name so the turn still bypasses
    // the router, but no otter command logic ever acts on it.
    const injectedHere = injectedRegistry.get(deps)?.has(input.command) === true && enabledCommands.has(input.command)
    markCommandTurn(input.sessionID, injectedHere ? input.command : `__foreign:${input.command}`, input.arguments)
    if (!injectedHere) return
    if (input.command === STATUS_COMMAND) return // status only marks the turn; chat.message rewrites the text in place
    if (flowCmdsOn && (FLOW_COMMANDS as readonly string[]).includes(input.command)) return // §5.2/§5.5 state work happens in chat.message (handleCommand below), which then rewrites the text
    if (continueOn && input.command === CONTINUE_COMMAND) {
      if (input.arguments.trim() !== "confirm") {
        recordContinueReceipt(deps, input.sessionID, input.arguments, CONTINUE_CONFIRMATION_PROMPT)
        return
      }
      try {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionID)) throw new Error("invalid OpenCode session ID")
        if (runtime.host.identity.engine !== "opencode") throw new Error("the selected owner is not OpenCode")
        let expectedStore = getOwnedSession(deps.worktree, input.sessionID)
        let expectedFence = admissionFence(deps.worktree, input.sessionID)
        const revalidate = () => {
          if (getOwnedSession(deps.worktree, input.sessionID) !== expectedStore) throw new Error("session attachment changed during explicit Resume")
          expectedStore?.assertOwner()
          if (admissionFence(deps.worktree, input.sessionID) !== expectedFence) throw new Error("session authority changed during explicit Resume")
        }
        const context = { client: deps.client, sessionID: input.sessionID, directory: deps.directory, worktree: deps.worktree, revalidate }
        const vendor = await readSDKResumeIdentity(context)

        const store = expectedStore ?? attachHeldAdmission(
          runtime,
          input.sessionID,
          { engine: runtime.host.identity.engine },
        )
        expectedStore = store
        expectedFence = admissionFence(deps.worktree, input.sessionID)
        if (store.sessionID !== input.sessionID || getOwnedSession(deps.worktree, input.sessionID) !== store) {
          throw new Error("session attachment is not owned by this process")
        }
        store.assertOwner()
        if (!effectiveHold(deps.worktree, input.sessionID)) {
          recordContinueReceipt(deps, input.sessionID, input.arguments, "Session is already admitted. No workflow or task was started.")
          return
        }
        const metadata = readSessionMetadata(deps.worktree, input.sessionID)
        if (!metadata || !metadata.held || metadata.engine !== runtime.host.identity.engine) {
          throw new Error("held session metadata or engine does not match this owner")
        }
        if (queue.isRunning(input.sessionID) || executionActivity(runtime.worktree)) {
          throw new Error("session execution is not quiescent")
        }
        const runState = runtime.runs.status()
        if (runState.claim || runState.executions.some(execution => !settled(execution))) {
          throw new Error("session execution claim or intent is not settled")
        }
        const checked = readWorkflowChecked(runtime.worktree)
        if (checked.corrupt) throw new Error("workflow state is corrupt")
        const workflow = checked.wf?.sessionID === input.sessionID ? checked.wf : null
        await assertSDKSessionQuiescent(context, vendor)
        if (!captureSDKSessionLifetime(deps.worktree, input.sessionID, store.epoch, vendor.createdAt)) {
          throw new Error("OpenCode session lifetime could not be retained; admission remains held")
        }
        if (workflow && (workflow.phase === "paused" || workflow.stopIntent)) {
          // A pause resumes only through the workflow Resume: every precondition is checked, the explicit
          // `/continue confirm` is the human choice, and everything is rechecked inside the commit.
          if (workflow.stopIntent?.kind === "cancel") throw new Error("workflow cancellation is pending")
          // A reviewing pause would re-enter `reviewing` and need a review dispatch, which a command hook cannot host
          // (A3). Refuse before any commit so the workflow stays paused; resume it from the TUI/CLI or /cancel it.
          if (workflow.pausedFrom?.phase === "reviewing") throw new Error("a pause taken in reviewing resumes only from the TUI or CLI; the workflow stays paused")
          const outcome = await resumePaused(runtime, input.sessionID, workflow.lastSeq, {
            async preflight() {
              // OpenCode /continue dispatches nothing (the model is driven by the user's next turn), so host control
              // preflight is not an admission for this command; the boot epoch still gates it.
              runtime.linuxAdmission?.assertBootEpoch()
            },
            fence: () => admissionFence(deps.worktree, input.sessionID),
            choose: async () => true,
          })
          if (outcome.kind !== "resumed") throw new Error(outcome.kind === "refused" ? `resume refused (${outcome.precondition}): ${outcome.reason}` : "resume kept held")
          recordContinueReceipt(deps, input.sessionID, input.arguments, CONTINUE_PAUSED_RESUMED_RECEIPT)
          return
        }
        resumeAdmission(runtime, input.sessionID, workflow?.lastSeq)
        recordContinueReceipt(deps, input.sessionID, input.arguments, CONTINUE_RESUMED_RECEIPT)
        deps.log("/continue acknowledged explicit owner Resume", {
          sessionID: input.sessionID,
          epoch: store.epoch,
          workflowID: workflow?.id,
          workflowRevision: workflow?.lastSeq,
        })
      } catch (error) {
        recordContinueReceipt(deps, input.sessionID, input.arguments, CONTINUE_HELD_RECEIPT)
        deps.log("/continue remains held", { sessionID: input.sessionID, error: (error as Error)?.message ?? String(error) })
      }
      return
    }
    if (!stopOn || input.command !== STOP_COMMAND) return
    const { sessionID } = input
    try {
      const epoch = holdOwnedAdmission(deps.worktree, sessionID, "user_stop")
      const prev = readModeState(deps.worktree, sessionID)
      const queueWasRunning = queue.isRunning(sessionID)
      durableWriteJson(abortPath(deps.worktree, sessionID), { reason: "user_stop", at: Date.now(), arguments: "" })
      if (queueWasRunning) {
        // fire-and-forget: a hung abort endpoint must not hang the command hook
        void queue.abort(sessionID, "user_stop").catch((e: unknown) => deps.log("/stop: queue abort failed", { sessionID, error: String(e) }))
      } else if (canCancelOpenQueue(runtime, queueWasRunning)) {
        // Open tasks are settled only when no queue, execution activity, claim or unsettled intent remains.
        queue.cancelOpen(sessionID, "user_stop")
      }
      writeModeState(deps.worktree, sessionID, { ...EMPTY_MODE, stopReason: "user_stop" })
      deps.log("/stop", { sessionID, epoch, previousMode: prev.mode, wasActive: prev.active, queueWasRunning })
    } catch (e) {
      deps.log("/stop failed", { sessionID, error: (e as Error).message })
    }
  }
}
