// AC0.3: the §5.2 transition table as an oracle. Every (phase, event) pair is enumerated; listed rows transition
// exactly as tabled (including guard boundaries at the cap values), every other pair is an error.
import { expect, test } from "bun:test"
import { EVENTS, PHASES, transition, ZERO_COUNTERS, type FlowCore, type FlowEvent, type Phase, type StuckCause, type TransitionCtx } from "../src/flow/machine.ts"

const core = (phase: Phase, patch: Partial<FlowCore> = {}): FlowCore => ({ phase, counters: { ...ZERO_COUNTERS }, ...patch })
const done = { open: 0, failedOrCancelled: 0, total: 2 }
const failed = { open: 0, failedOrCancelled: 1, total: 2 }

// Each row: from core, event, ctx, expected phase (+cause) and row id. These are the ONLY allowed pairs.
type Row = { from: FlowCore; event: FlowEvent; ctx?: TransitionCtx; to: Phase; cause?: StuckCause; row: string }
const ROWS: Row[] = [
  { from: core("planning"), event: "submit_invalid", to: "planning", row: "T2" },
  { from: core("planning", { counters: { ...ZERO_COUNTERS, code_invalid: 1 } }), event: "submit_invalid", to: "planning", row: "T2" },
  { from: core("planning", { counters: { ...ZERO_COUNTERS, code_invalid: 2 } }), event: "submit_invalid", to: "stuck", cause: "plan_invalid", row: "T3" },
  { from: core("planning"), event: "submit_valid", to: "reviewing", row: "T4" },
  { from: core("reviewing"), event: "review_iterate", to: "planning", row: "T5" },
  { from: core("reviewing", { counters: { ...ZERO_COUNTERS, review_iterations: 1 } }), event: "review_iterate", to: "pending_approval", row: "T6" },
  { from: core("reviewing"), event: "review_okay", to: "pending_approval", row: "T7" },
  { from: core("reviewing"), event: "review_none", to: "pending_approval", row: "T7" },
  { from: core("reviewing"), event: "review_aborted", to: "pending_approval", row: "T8" },
  { from: core("pending_approval"), event: "approve", to: "executing", row: "T9" },
  { from: core("pending_approval"), event: "reject", to: "planning", row: "T10" },
  { from: core("planning"), event: "nudge", to: "planning", row: "T11" },
  { from: core("planning", { counters: { ...ZERO_COUNTERS, nudges: 1 } }), event: "nudge_exhausted", to: "stuck", cause: "no_submission", row: "T12" },
  { from: core("planning"), event: "user_message", to: "planning", row: "T13" },
  { from: core("stuck", { stuckCause: "no_submission" }), event: "user_message", to: "planning", row: "T13" },
  { from: core("stuck", { stuckCause: "plan_invalid" }), event: "reject", to: "planning", row: "T14" },
  { from: core("executing"), event: "settle_ok", ctx: { tasks: done }, to: "done", row: "T15" },
  { from: core("executing"), event: "settle_fail", ctx: { tasks: failed }, to: "stuck", cause: "tasks_failed", row: "T16" },
  { from: core("executing"), event: "user_stop", to: "stuck", cause: "user_stop", row: "T17" },
]
const NON_TERMINAL_CORES: FlowCore[] = [
  core("planning"), core("reviewing"), core("pending_approval"), core("executing"),
  core("stuck", { stuckCause: "plan_invalid" }), core("stuck", { stuckCause: "no_submission" }),
  core("stuck", { stuckCause: "tasks_failed" }), core("stuck", { stuckCause: "user_stop" }),
]
for (const c of NON_TERMINAL_CORES) {
  ROWS.push({ from: c, event: "cancel", to: "cancelled", row: "T18" })
  ROWS.push({ from: c, event: "session_deleted", to: "cancelled", row: "T19" })
  ROWS.push({ from: c, event: "owner_dead", to: "cancelled", row: "T20" })
  ROWS.push({ from: { ...c, pendingCancel: true }, event: "cancel_settled", to: "cancelled", row: "T18" })
}

const key = (c: FlowCore, e: FlowEvent) => `${c.phase}|${c.stuckCause ?? ""}|${e}`

test("every tabled row transitions exactly as specified", () => {
  for (const r of ROWS) {
    const res = transition(r.from, r.event, r.ctx)
    if ("error" in res) throw new Error(`${key(r.from, r.event)} expected ${r.row}, got error ${res.error}`)
    expect(res.row).toBe(r.row)
    expect(res.core.phase).toBe(r.to)
    expect(res.core.stuckCause).toBe(r.cause)
  }
})

test("every other (phase, event) pair is an error", () => {
  const allowed = new Set(ROWS.filter((r) => !r.from.pendingCancel).map((r) => key(r.from, r.event)))
  const cores: FlowCore[] = [...NON_TERMINAL_CORES, core("done"), core("cancelled")]
  let errors = 0
  for (const c of cores) {
    for (const e of EVENTS) {
      if (allowed.has(key(c, e))) continue
      const ctx: TransitionCtx = e === "settle_ok" ? { tasks: done } : e === "settle_fail" ? { tasks: failed } : {}
      const res = transition(c, e, ctx)
      if (!("error" in res)) throw new Error(`${key(c, e)} should be an error, got ${res.row}`)
      errors++
    }
  }
  expect(errors).toBeGreaterThan(PHASES.length * 5)
})

test("guards at the cap values", () => {
  // nudge budget: second nudge refused; exhausted before the first nudge refused
  expect("error" in transition(core("planning", { counters: { ...ZERO_COUNTERS, nudges: 1 } }), "nudge")).toBe(true)
  expect("error" in transition(core("planning"), "nudge_exhausted")).toBe(true)
  // a question to the user suppresses both
  expect("error" in transition(core("planning"), "nudge", { lastAssistantAsks: true })).toBe(true)
  expect("error" in transition(core("planning", { counters: { ...ZERO_COUNTERS, nudges: 1 } }), "nudge_exhausted", { lastAssistantAsks: true })).toBe(true)
  // settle needs all tasks settled; a pending cancel blocks settle_ok/fail
  expect("error" in transition(core("executing"), "settle_ok", { tasks: { open: 1, failedOrCancelled: 0, total: 2 } })).toBe(true)
  expect("error" in transition(core("executing"), "settle_ok", { tasks: failed })).toBe(true)
  expect("error" in transition(core("executing"), "settle_fail", { tasks: done })).toBe(true)
  expect("error" in transition(core("executing", { pendingCancel: true }), "settle_ok", { tasks: done })).toBe(true)
  // cancel_settled waits for a running queue
  expect("error" in transition(core("executing", { pendingCancel: true }), "cancel_settled", { queueRunning: true, tasks: { open: 1, failedOrCancelled: 0, total: 1 } })).toBe(true)
})

test("cancel with a running queue only marks pendingCancel (mirrors /stop)", () => {
  const r = transition(core("executing"), "cancel", { queueRunning: true })
  if ("error" in r) throw new Error(r.error)
  expect(r.core.phase).toBe("executing")
  expect(r.core.pendingCancel).toBe(true)
})

test("counters are split: a user reject resets model/reviewer counters and is never capped", () => {
  let c = core("pending_approval", { counters: { code_invalid: 2, review_iterations: 2, user_rejections: 7, nudges: 1 } })
  const r = transition(c, "reject")
  if ("error" in r) throw new Error(r.error)
  expect(r.core.counters).toEqual({ code_invalid: 0, review_iterations: 0, user_rejections: 8, nudges: 0 })
  c = core("planning", { counters: { ...ZERO_COUNTERS, code_invalid: 1 } })
  const v = transition(c, "submit_valid")
  if ("error" in v) throw new Error(v.error)
  expect(v.core.counters.code_invalid).toBe(0)
})

test("T6 records the review cap note; returning to planning clears it", () => {
  const r = transition(core("reviewing", { counters: { ...ZERO_COUNTERS, review_iterations: 1 } }), "review_iterate")
  if ("error" in r) throw new Error(r.error)
  expect(r.core.reviewNote).toBe("cap")
  const back = transition(r.core, "reject")
  if ("error" in back) throw new Error(back.error)
  expect(back.core.reviewNote).toBeUndefined()
})
