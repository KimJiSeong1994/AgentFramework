// Plan workflow state machine (ralplan §5.2). Pure: no I/O. Callers apply side effects (ledger writes, files,
// prompts, toasts) after a successful transition. Any (phase, event) pair not listed here is an error and must
// not write anything.

import { PHASES, TERMINAL, type Phase, type StopKind } from "../workflows/types.ts"

export { PHASES, TERMINAL }
export type { Phase }
export type StuckCause = "plan_invalid" | "no_submission" | "tasks_failed" | "user_stop"

export const EVENTS = [
  "submit_invalid", "submit_valid",
  "review_iterate", "review_okay", "review_none", "review_aborted",
  "approve", "reject",
  "nudge", "nudge_exhausted", "user_message",
  "settle_ok", "settle_fail", "user_stop",
  "pause", "pause_settled", "resume",
  "cancel", "cancel_settled",
] as const
export type FlowEvent = (typeof EVENTS)[number]

export type Counters = { code_invalid: number; review_iterations: number; user_rejections: number; nudges: number }
export const ZERO_COUNTERS: Counters = { code_invalid: 0, review_iterations: 0, user_rejections: 0, nudges: 0 }

/** The machine-relevant slice of a workflow. */
export type FlowCore = {
  phase: Phase
  stuckCause?: StuckCause
  counters: Counters
  /** A recorded stop intent. `pause_settled` keeps it as the settled marker; `cancel_settled` clears it. */
  stop?: { kind: StopKind }
  /** Phase a pause was requested from (history after a settled cancel); `resume` returns here. */
  pausedFrom?: Phase
  reviewNote?: "aborted" | "cap"
}

export type Limits = { max_code_invalid: number; max_review_iterations: number; nudge_max: number }
export const DEFAULT_LIMITS: Limits = { max_code_invalid: 3, max_review_iterations: 2, nudge_max: 1 }

export type TransitionCtx = {
  limits?: Limits
  /** T11/T12 guard: the last assistant message asks the user something */
  lastAssistantAsks?: boolean
  /** Any owned queue/review/stage/broker/reservation/claim/unsettled execution exists (computed in the flow transaction). */
  active?: boolean
  /** resume: every Resume precondition was verified by the caller inside the transaction. */
  resumeChecked?: boolean
  /** T15/T16: status of the workflow's tagged tasks */
  tasks?: { open: number; failedOrCancelled: number; total: number }
}

export type TransitionResult = { core: FlowCore; row: string; toast?: string } | { error: string }

const NON_TERMINAL = (p: Phase) => !TERMINAL.has(p)

function refuse(core: FlowCore, event: FlowEvent, why = "not allowed"): TransitionResult {
  return { error: `${event} in ${core.phase}${core.stuckCause ? `(${core.stuckCause})` : ""}: ${why}` }
}

/** The start of a workflow (T1) is not a transition from an existing phase; it creates a fresh core. */
export function startCore(): FlowCore {
  return { phase: "planning", counters: { ...ZERO_COUNTERS } }
}

export function transition(core: FlowCore, event: FlowEvent, ctx: TransitionCtx = {}): TransitionResult {
  const lim = ctx.limits ?? DEFAULT_LIMITS
  const c = core.counters
  const to = (patch: Partial<FlowCore>, row: string, toast?: string): TransitionResult => {
    const next: FlowCore = { ...core, ...patch, counters: { ...c, ...(patch.counters ?? {}) } }
    if (next.phase !== "stuck") delete next.stuckCause
    if (next.phase === "planning" || next.phase === "reviewing") delete next.reviewNote
    return toast ? { core: next, row, toast } : { core: next, row }
  }
  const p = core.phase
  const stopped = core.stop !== undefined
  // A recorded stop (pending or settled pause, pending cancel) refuses every ordinary event; only the stop events act.
  const STOP_EVENTS: readonly FlowEvent[] = ["pause", "pause_settled", "resume", "cancel", "cancel_settled"]
  if ((stopped || p === "paused") && !STOP_EVENTS.includes(event)) {
    return refuse(core, event, p === "paused" ? "workflow is paused" : `workflow ${core.stop!.kind} is pending`)
  }
  switch (event) {
    case "submit_invalid":
      if (p !== "planning") return refuse(core, event)
      return c.code_invalid + 1 < lim.max_code_invalid
        ? to({ counters: { ...c, code_invalid: c.code_invalid + 1 } }, "T2")
        : to({ phase: "stuck", stuckCause: "plan_invalid", counters: { ...c, code_invalid: c.code_invalid + 1 } }, "T3", "plan rejected by validation 3 times")
    case "submit_valid":
      if (p !== "planning") return refuse(core, event)
      return to({ phase: "reviewing", counters: { ...c, code_invalid: 0 } }, "T4")
    case "review_iterate":
      if (p !== "reviewing") return refuse(core, event)
      return c.review_iterations + 1 < lim.max_review_iterations
        ? to({ phase: "planning", counters: { ...c, review_iterations: c.review_iterations + 1 } }, "T5")
        : to({ phase: "pending_approval", reviewNote: "cap", counters: { ...c, review_iterations: c.review_iterations + 1 } }, "T6")
    case "review_okay":
    case "review_none":
      if (p !== "reviewing") return refuse(core, event)
      return to({ phase: "pending_approval" }, "T7")
    case "review_aborted":
      if (p !== "reviewing") return refuse(core, event)
      return to({ phase: "pending_approval", reviewNote: "aborted" }, "T8")
    case "approve":
      if (p !== "pending_approval") return refuse(core, event)
      return to({ phase: "executing" }, "T9")
    case "reject":
      if (p === "pending_approval" || (p === "stuck" && core.stuckCause === "plan_invalid")) {
        return to(
          { phase: "planning", counters: { code_invalid: 0, review_iterations: 0, nudges: 0, user_rejections: c.user_rejections + 1 } },
          p === "stuck" ? "T14" : "T10",
        )
      }
      return refuse(core, event)
    case "nudge":
      if (p !== "planning") return refuse(core, event)
      if (ctx.lastAssistantAsks) return refuse(core, event, "the model is asking the user")
      if (c.nudges >= lim.nudge_max) return refuse(core, event, "nudge budget used")
      return to({ counters: { ...c, nudges: c.nudges + 1 } }, "T11")
    case "nudge_exhausted":
      if (p !== "planning") return refuse(core, event)
      if (ctx.lastAssistantAsks) return refuse(core, event, "the model is asking the user")
      if (c.nudges < lim.nudge_max) return refuse(core, event, "nudge budget not used")
      return to({ phase: "stuck", stuckCause: "no_submission" }, "T12", "no plan submitted")
    case "user_message":
      if (p === "planning" || (p === "stuck" && core.stuckCause === "no_submission")) {
        return to({ phase: "planning", counters: { ...c, nudges: 0 } }, "T13")
      }
      return refuse(core, event)
    case "settle_ok": {
      if (p !== "executing") return refuse(core, event)
      const t = ctx.tasks
      if (!t || t.open > 0 || t.failedOrCancelled > 0) return refuse(core, event, "tasks not all done")
      return to({ phase: "done" }, "T15", "plan workflow done")
    }
    case "settle_fail": {
      if (p !== "executing") return refuse(core, event)
      const t = ctx.tasks
      if (!t || t.open > 0 || t.failedOrCancelled === 0) return refuse(core, event, "tasks not settled with a failure")
      return to({ phase: "stuck", stuckCause: "tasks_failed" }, "T16", "plan workflow stopped: a task failed")
    }
    case "user_stop":
      if (p !== "executing") return refuse(core, event)
      return to({ phase: "stuck", stuckCause: "user_stop" }, "T17")
    case "pause":
      if (stopped || !(p === "planning" || p === "reviewing" || p === "pending_approval" || p === "executing")) return refuse(core, event)
      return ctx.active
        ? to({ stop: { kind: "pause" }, pausedFrom: p }, "P1")
        : to({ phase: "paused", stop: { kind: "pause" }, pausedFrom: p }, "P2", "plan workflow paused")
    case "pause_settled":
      if (core.stop?.kind !== "pause" || p === "paused" || !NON_TERMINAL(p) || !core.pausedFrom) return refuse(core, event)
      if (ctx.active) return refuse(core, event, "termination unconfirmed")
      return to({ phase: "paused" }, "P3", "plan workflow paused")
    case "resume":
      if (p !== "paused" || core.stop?.kind !== "pause" || !core.pausedFrom) return refuse(core, event)
      if (!ctx.resumeChecked) return refuse(core, event, "resume preconditions not verified")
      return to({ phase: core.pausedFrom, stop: undefined, pausedFrom: undefined }, "P4")
    case "cancel":
      if (!NON_TERMINAL(p) || core.stop?.kind === "cancel") return refuse(core, event)
      // cancel > pause: a pending or settled pause is replaced; the phase stays until termination is proven
      if (ctx.active) return to({ stop: { kind: "cancel" } }, "T18")
      return to({ phase: "cancelled", stop: undefined }, "T18", "plan workflow cancelled")
    case "cancel_settled":
      if (core.stop?.kind !== "cancel" || !NON_TERMINAL(p)) return refuse(core, event)
      if (ctx.active) return refuse(core, event, "termination unconfirmed")
      return to({ phase: "cancelled", stop: undefined }, "T18", "plan workflow cancelled")
  }
}
