// Plan workflow state machine (ralplan §5.2). Pure: no I/O. Callers apply side effects (ledger writes, files,
// prompts, toasts) after a successful transition. Any (phase, event) pair not listed here is an error and must
// not write anything.

export const PHASES = ["planning", "reviewing", "pending_approval", "executing", "stuck", "done", "cancelled"] as const
export type Phase = (typeof PHASES)[number]
export type StuckCause = "plan_invalid" | "no_submission" | "tasks_failed" | "user_stop"
export const TERMINAL: ReadonlySet<Phase> = new Set(["done", "cancelled"])

export const EVENTS = [
  "submit_invalid", "submit_valid",
  "review_iterate", "review_okay", "review_none", "review_aborted",
  "approve", "reject",
  "nudge", "nudge_exhausted", "user_message",
  "settle_ok", "settle_fail", "user_stop",
  "cancel", "cancel_settled", "session_deleted", "owner_dead",
] as const
export type FlowEvent = (typeof EVENTS)[number]

export type Counters = { code_invalid: number; review_iterations: number; user_rejections: number; nudges: number }
export const ZERO_COUNTERS: Counters = { code_invalid: 0, review_iterations: 0, user_rejections: 0, nudges: 0 }

/** The machine-relevant slice of a workflow. */
export type FlowCore = {
  phase: Phase
  stuckCause?: StuckCause
  counters: Counters
  pendingCancel?: boolean
  reviewNote?: "aborted" | "cap"
}

export type Limits = { max_code_invalid: number; max_review_iterations: number; nudge_max: number }
export const DEFAULT_LIMITS: Limits = { max_code_invalid: 3, max_review_iterations: 2, nudge_max: 1 }

export type TransitionCtx = {
  limits?: Limits
  /** T11/T12 guard: the last assistant message asks the user something */
  lastAssistantAsks?: boolean
  /** T18: the owning session's queue is running (cancel then settles at delegate return) */
  queueRunning?: boolean
  /** T15/T16/cancel_settled: status of the workflow's tagged tasks */
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
      if (core.pendingCancel || !t || t.open > 0 || t.failedOrCancelled > 0) return refuse(core, event, "tasks not all done")
      return to({ phase: "done" }, "T15", "plan workflow done")
    }
    case "settle_fail": {
      if (p !== "executing") return refuse(core, event)
      const t = ctx.tasks
      if (core.pendingCancel || !t || t.open > 0 || t.failedOrCancelled === 0) return refuse(core, event, "tasks not settled with a failure")
      return to({ phase: "stuck", stuckCause: "tasks_failed" }, "T16", "plan workflow stopped: a task failed")
    }
    case "user_stop":
      if (p !== "executing") return refuse(core, event)
      return to({ phase: "stuck", stuckCause: "user_stop" }, "T17")
    case "cancel":
      if (!NON_TERMINAL(p)) return refuse(core, event)
      // mirrors /stop: a running queue is aborted and the cancel completes at settle (cancel_settled)
      if (ctx.queueRunning) return to({ pendingCancel: true }, "T18")
      return to({ phase: "cancelled", pendingCancel: undefined }, "T18", "plan workflow cancelled")
    case "cancel_settled":
      if (!core.pendingCancel || !NON_TERMINAL(p)) return refuse(core, event)
      if (ctx.tasks && ctx.tasks.open > 0 && ctx.queueRunning) return refuse(core, event, "queue still running")
      return to({ phase: "cancelled", pendingCancel: undefined }, "T18", "plan workflow cancelled")
    case "session_deleted":
      if (!NON_TERMINAL(p)) return refuse(core, event)
      return to({ phase: "cancelled", pendingCancel: undefined }, "T19")
    case "owner_dead":
      if (!NON_TERMINAL(p)) return refuse(core, event)
      return to({ phase: "cancelled", pendingCancel: undefined }, "T20")
  }
}
