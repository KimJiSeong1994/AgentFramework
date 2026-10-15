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
  // T19 (session_deleted -> cancelled with no proof) is removed: deletion is a cancel request (documented, PA:376).
  ROWS.push({ from: c, event: "cancel", to: "cancelled", row: "T18" })
  ROWS.push({ from: { ...c, stop: { kind: "cancel" } }, event: "cancel_settled", to: "cancelled", row: "T18" })
}
// Pause is legal only from the four live phases; idle pauses settle in the same step, active ones stay pending.
for (const p of ["planning", "reviewing", "pending_approval", "executing"] as const) {
  ROWS.push({ from: core(p), event: "pause", ctx: { active: true }, to: p, row: "P1" })
  ROWS.push({ from: core(p), event: "pause", ctx: { active: false }, to: "paused", row: "P2" })
  ROWS.push({ from: core(p, { stop: { kind: "pause" }, pausedFrom: p }), event: "pause_settled", ctx: { active: false }, to: "paused", row: "P3" })
  // cancel replaces a pending pause; the phase stays until termination is proven
  ROWS.push({ from: core(p, { stop: { kind: "pause" }, pausedFrom: p }), event: "cancel", ctx: { active: true }, to: p, row: "T18" })
  ROWS.push({ from: core(p, { stop: { kind: "pause" }, pausedFrom: p }), event: "cancel", ctx: { active: false }, to: "cancelled", row: "T18" })
  ROWS.push({ from: core("paused", { stop: { kind: "pause" }, pausedFrom: p }), event: "resume", ctx: { resumeChecked: true }, to: p, row: "P4" })
}
// cancel is allowed from a settled pause (the gate removes the old "paused refuses everything").
ROWS.push({ from: core("paused", { stop: { kind: "pause" }, pausedFrom: "executing" }), event: "cancel", ctx: { active: false }, to: "cancelled", row: "T18" })
ROWS.push({ from: core("paused", { stop: { kind: "pause" }, pausedFrom: "executing" }), event: "cancel", ctx: { active: true }, to: "paused", row: "T18" })

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
  // Rows whose source carries a stop are exercised separately; the stop-free cores are enumerated against ROWS here.
  const allowed = new Set(ROWS.filter((r) => !r.from.stop && r.from.phase !== "paused").map((r) => key(r.from, r.event)))
  const cores: FlowCore[] = [...NON_TERMINAL_CORES, core("done"), core("cancelled")]
  let errors = 0
  for (const c of cores) {
    for (const e of EVENTS) {
      if (allowed.has(key(c, e))) continue
      const ctx: TransitionCtx = e === "settle_ok" ? { tasks: done } : e === "settle_fail" ? { tasks: failed } : e === "resume" ? { resumeChecked: true } : {}
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
  expect("error" in transition(core("executing", { stop: { kind: "cancel" } }), "settle_ok", { tasks: done })).toBe(true)
  // cancel_settled waits for every activity term (the full predicate is `active`, not just the queue)
  expect("error" in transition(core("executing", { stop: { kind: "cancel" } }), "cancel_settled", { active: true, tasks: { open: 1, failedOrCancelled: 0, total: 1 } })).toBe(true)
  expect("error" in transition(core("executing", { stop: { kind: "pause" }, pausedFrom: "executing" }), "pause_settled", { active: true })).toBe(true)
})

test("cancel with active work only records the stop intent (mirrors /stop)", () => {
  const r = transition(core("executing"), "cancel", { active: true })
  if ("error" in r) throw new Error(r.error)
  expect(r.core.phase).toBe("executing")
  expect(r.core.stop).toEqual({ kind: "cancel" })
})

test("every ordinary event is refused under any pending or settled stop", () => {
  const ORDINARY = EVENTS.filter((e) => !["pause", "pause_settled", "resume", "cancel", "cancel_settled"].includes(e))
  const stopped: FlowCore[] = [
    core("executing", { stop: { kind: "cancel" } }), core("executing", { stop: { kind: "pause" }, pausedFrom: "executing" }),
    core("planning", { stop: { kind: "pause" }, pausedFrom: "planning" }), core("reviewing", { stop: { kind: "cancel" } }),
    core("paused", { stop: { kind: "pause" }, pausedFrom: "executing" }),
  ]
  for (const c of stopped) for (const e of ORDINARY) {
    const res = transition(c, e, { tasks: done, active: false })
    if (!("error" in res)) throw new Error(`${key(c, e)} under a ${c.stop?.kind} stop must be refused, got ${res.row}`)
  }
})

test("precedence: pause is refused under a cancel, resume needs a settled pause and verified preconditions", () => {
  expect("error" in transition(core("executing", { stop: { kind: "cancel" } }), "pause", { active: true })).toBe(true)
  expect("error" in transition(core("executing", { stop: { kind: "pause" }, pausedFrom: "executing" }), "pause_settled", { active: false, tasks: done }) ).toBe(false)
  expect("error" in transition(core("paused", { stop: { kind: "cancel" } }), "pause_settled", { active: false })).toBe(true)
  expect("error" in transition(core("paused", { stop: { kind: "pause" }, pausedFrom: "executing" }), "resume")).toBe(true)
  expect("error" in transition(core("executing", { stop: { kind: "pause" }, pausedFrom: "executing" }), "resume", { resumeChecked: true })).toBe(true)
  for (const p of ["stuck", "done", "cancelled", "paused"] as const) expect("error" in transition(core(p), "pause", { active: false })).toBe(true)
})

test("pause_settled keeps the stop intent as the settled marker; cancel_settled clears it", () => {
  const settledPause = transition(core("executing", { stop: { kind: "pause" }, pausedFrom: "executing" }), "pause_settled", { active: false })
  if ("error" in settledPause) throw new Error(settledPause.error)
  expect(settledPause.core).toMatchObject({ phase: "paused", stop: { kind: "pause" }, pausedFrom: "executing" })
  const resumed = transition(settledPause.core, "resume", { resumeChecked: true })
  if ("error" in resumed) throw new Error(resumed.error)
  expect(resumed.core.stop).toBeUndefined()
  expect(resumed.core.pausedFrom).toBeUndefined()
  const cancelled = transition(core("executing", { stop: { kind: "cancel" } }), "cancel_settled", { active: false })
  if ("error" in cancelled) throw new Error(cancelled.error)
  expect(cancelled.core.stop).toBeUndefined()
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
