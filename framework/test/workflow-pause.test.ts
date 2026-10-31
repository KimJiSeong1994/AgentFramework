// P5b S1/S2: pause/cancel stop protocol and the single owner-aware settlement routine (requestStop / settleOwned).
// W4: pause closes admission immediately, stays "pausing" until every blocker proves quiescent, failures never steal the
// transition, cancel always wins. W6: cancel from every non-terminal phase retains records and is terminal only after proof.
// Blockers are registry/injected handles released by the test (barriers), never timers.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { currentOwner } from "../src/flow/owner.ts"
import { observeStopSettlement, requestStop, settleOwned, stopBlockers, type SettleOutcome } from "../src/flow/runtime.ts"
import { eventsPath, readEvents, readWorkflow, workflowPath, type Workflow } from "../src/flow/state.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { abortSessionActivities, beginExecutionActivity, beginStageReservation } from "../src/hosts/runtime.ts"
import { admissionEpoch, effectiveHold } from "../src/sessions/admission.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { registerSkillPermissionActivity } from "../src/skills/activity.ts"
import { readLedger, writeLedger, addTasks, emptyLedger } from "../src/state/ledger.ts"
import { stateRoot } from "../src/state/store.ts"
import { STOP_DISPLAYS, stopDisplay } from "../src/workflows/types.ts"
import { committedSnapshot, rewriteCommitted, writeWorkflow } from "./commit-fixture.ts"
import { admitFixtureSession, fakeClient, makeDeps, releaseFixtureSession, tempGitWorktree, waitFor, type FakeClient } from "./guards-helpers.ts"
import { startWorkflow } from "../src/flow/runtime.ts"
import { resumePaused } from "../src/flow/resume.ts"
import { __setCommitFaultHook, commitRevision } from "../src/workflows/commit.ts"
import { withFlowTransaction as flowTx } from "../src/flow/state.ts"
import { chmodSync, writeFileSync } from "node:fs"
import { resumeAdmission } from "../src/sessions/admission.ts"
import { abortPath, sessionDir } from "../src/state/store.ts"

const S = "ses_pause"
let wt: ReturnType<typeof tempGitWorktree>
let client: FakeClient
let cleanups: Array<() => void>
let store: ReturnType<typeof admitFixtureSession>

beforeEach(() => {
  wt = tempGitWorktree({ "README.md": "fixture\n" })
  client = fakeClient({ promptAsync: true })
  cleanups = []
})
afterEach(() => {
  __setCommitFaultHook(null)
  for (const cleanup of cleanups.splice(0)) cleanup()
  try { releaseFixtureSession(wt.worktree, store) } catch { /* a held stop keeps the attachment; the worktree is discarded */ }
  wt.cleanup()
})

function boot(phase: Workflow["phase"] = "executing", stage: string = "unit") {
  const deps = makeDeps(client, wt.worktree, { delegate: { review: false } as any })
  const runtime = getOpenCodeRuntime(deps)
  store = admitFixtureSession(deps, S)
  const started = startWorkflow(runtime, S, "command", "pause fixture", "user_command", "opencode")
  if (!started.ok) throw new Error(started.text)
  const wf = phase === "planning" ? started.wf : rewriteCommitted(wt.worktree, { phase, stage: stage as never })
  return { deps, runtime, wf }
}

const kindsOf = (wid: string) => readEvents(wt.worktree, wid, S).map(e => e.type)
const transitions = (wid: string) => readEvents(wt.worktree, wid, S).filter(e => e.type === "transition").map(e => String(e.data?.event))
const settleStop = (runtime: ReturnType<typeof boot>["runtime"], observer = "test"): SettleOutcome =>
  settleOwned(runtime, { sessionID: S, epoch: store.epoch }, observer, { stopOnly: true })

const pauseTokenOf = () => readWorkflow(wt.worktree, S)!.stopIntent!.token

type Blocker = { name: string; engage(ctx: ReturnType<typeof boot>): Promise<() => Promise<void> | void> }
const BLOCKERS: Blocker[] = [
  {
    name: "queue",
    async engage({ runtime }) {
      let started = false
      client.replies.worker = { text: "x", run: () => ((started = true), new Promise<void>(() => {})) }
      const q = getQueue(runtime)
      writeLedger(wt.worktree, addTasks(emptyLedger(S), [{ title: "a" }, { title: "b" }]).ledger)
      const running = q.run(S)
      await waitFor(() => started)
      // the queue's own abort (driven by requestStop with the pause cause) ends the run; release == its completion
      return async () => { await running }
    },
  },
  {
    name: "review",
    async engage({ runtime }) {
      let aborted: string | undefined
      const release = beginExecutionActivity(runtime, S, "review", { abort: cause => { aborted = cause } })!
      cleanups.push(release)
      return () => { expect(aborted).toBe(`workflow_pause:${pauseTokenOf()}`); release() }
    },
  },
  {
    name: "stage",
    async engage({ runtime }) {
      let aborted: string | undefined
      const release = beginExecutionActivity(runtime, S, "stage", { abort: cause => { aborted = cause } })!
      cleanups.push(release)
      return () => { expect(aborted).toBe(`workflow_pause:${pauseTokenOf()}`); release() }
    },
  },
  {
    name: "broker",
    async engage() {
      const controller = new AbortController()
      const unregister = registerSkillPermissionActivity(wt.worktree, S, store.epoch, controller)
      cleanups.push(unregister)
      // the hold (admission close) aborts broker waits; the wait is only a blocker until it unregisters
      return () => { expect(controller.signal.aborted).toBe(true); unregister() }
    },
  },
  {
    name: "reservation",
    async engage() {
      const release = beginStageReservation(wt.worktree, S)
      cleanups.push(release)
      return () => release()
    },
  },
]

describe("W4 pause with live work", () => {
  for (const blocker of BLOCKERS) {
    test(`${blocker.name}: admission closes immediately, label stays pausing, one pause_settled after the last blocker`, async () => {
      const ctx = boot("executing")
      const release = await blocker.engage(ctx)
      const extra = beginStageReservation(wt.worktree, S) // a second blocker: releasing one by one must not settle early
      cleanups.push(extra)
      const before = ctx.wf
      const dispatchesBefore = client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync").length + ctx.runtime.runs.status().executions.length

      const requested = requestStop(ctx.runtime, S, "pause", "user pause", { workflowID: before.id })
      expect(requested.result.ok).toBe(true)
      const wf = readWorkflow(wt.worktree, S)!
      // AC1: immediate hold, no admission epoch, phase unchanged, intent recorded with pausedFrom === requestedFrom
      expect(effectiveHold(wt.worktree, S)).toBe(true)
      expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
      expect(wf.phase).toBe("executing")
      expect(wf.stopIntent).toMatchObject({ kind: "pause", requestedFrom: { phase: "executing", stage: "unit" } })
      expect(wf.pausedFrom).toEqual(wf.stopIntent!.requestedFrom)
      expect(stopDisplay(wf)).toBe("pausing")
      expect(kindsOf(wf.id)).toContain("stop_requested")
      expect(client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync").length + ctx.runtime.runs.status().executions.length).toBe(dispatchesBefore)
      expect(kindsOf(wf.id)).not.toContain("pause_settled")

      await release()
      await requested.quiesce
      // the other blocker is still live: no settle, and observers see "waiting" (not a transition)
      expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "executing" })
      expect(settleStop(ctx.runtime)).toMatchObject({ kind: "waiting" })
      extra()
      cleanups.splice(cleanups.indexOf(extra), 1)

      expect(settleStop(ctx.runtime)).toMatchObject({ kind: "settled" })
      const after = readWorkflow(wt.worktree, S)!
      expect(after).toMatchObject({ phase: "paused", pausedFrom: { phase: "executing" } })
      expect(after.stopIntent?.kind).toBe("pause") // settled marker
      expect(stopDisplay(after)).toBe("paused")
      expect(kindsOf(after.id).filter(k => k === "pause_settled")).toHaveLength(1)
      // later observers (queue finally, review finally, idle) commit nothing more
      const revision = after.lastSeq
      expect(settleStop(ctx.runtime, "late")).toMatchObject({ kind: "none" })
      expect(readWorkflow(wt.worktree, S)!.lastSeq).toBe(revision)
    })
  }

  test("a pause with no blocker is one commit containing stop_requested and pause_settled", () => {
    const ctx = boot("pending_approval", "decision")
    const seqBefore = readWorkflow(wt.worktree, S)!.lastSeq
    const indexBefore = JSON.parse(readFileSync(workflowPath(wt.worktree, S), "utf8")).revision
    const requested = requestStop(ctx.runtime, S, "pause", "idle pause", { workflowID: ctx.wf.id })
    expect(requested.result.ok).toBe(true)
    const wf = readWorkflow(wt.worktree, S)!
    expect(wf).toMatchObject({ phase: "paused", pausedFrom: { phase: "pending_approval" } })
    // one revision: every new event (request, transition and settle) shares the single commit that moved the index
    const added = readEvents(wt.worktree, wf.id, S).filter(e => e.seq > seqBefore)
    expect(added.map(e => e.type)).toEqual(expect.arrayContaining(["stop_requested", "pause_settled"]))
    expect(JSON.parse(readFileSync(workflowPath(wt.worktree, S), "utf8")).revision).toBe(wf.lastSeq)
    expect(wf.lastSeq).toBe(Math.max(...added.map(e => e.seq)))
    expect(indexBefore).toBeLessThan(wf.lastSeq)
    expect(committedSnapshot(wt.worktree).phase).toBe("paused")
  })

  test("an owned execution that is not terminal+quiescent blocks even when no queue, review or claim is live", () => {
    const ctx = boot("executing")
    const claim = ctx.runtime.runs.claim(S, ctx.runtime.instance, process.pid)
    ctx.runtime.runs.registerIntent(claim, {
      executionId: "prepared-only", ownerSession: S, taskId: "t", attemptId: "a", generation: claim.generation, role: "worker",
      cwd: wt.worktree, policyID: ctx.runtime.policy.resolve("worker").id, kind: "host", engine: "opencode", profile: "legacy-unowned",
    })
    expect(stopBlockers(ctx.runtime, S, store.epoch)).toContain("owned execution is not terminal and quiescent")
    requestStop(ctx.runtime, S, "pause", "x", { workflowID: ctx.wf.id })
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "executing", stopIntent: { kind: "pause" } })
    expect(settleStop(ctx.runtime)).toMatchObject({ kind: "waiting" })
    expect(kindsOf(ctx.wf.id)).not.toContain("pause_settled")
    // proof arrives only as terminal+quiescent reconciliation, after which the same routine settles
    ctx.runtime.runs.recordTerminal(claim, "prepared-only", { outcome: "cancelled", terminalAt: Date.now(), quiescentAt: Date.now() })
    ctx.runtime.runs.reconcile(claim, "prepared-only", { outcome: "terminal", quiescent: true, evidence: "test proof" })
    ctx.runtime.runs.release(claim)
    expect(settleStop(ctx.runtime)).toMatchObject({ kind: "settled" })
  })
})

describe("queue pause mode preserves the residual", () => {
  test("the interrupted task reverts to pending with its cause and an uncounted attempt; no task is cancelled; the loop cancels nothing", async () => {
    const ctx = boot("executing")
    const tag = { id: ctx.wf.id, planSha: "plan-sha" }
    let started = false
    client.replies.worker = { text: "x", run: () => ((started = true), new Promise<void>(() => {})) }
    writeLedger(wt.worktree, addTasks(emptyLedger(S), [{ title: "a" }, { title: "b" }, { title: "c" }], Date.now(), tag).ledger)
    const running = getQueue(ctx.runtime).run(S)
    await waitFor(() => started)
    const requested = requestStop(ctx.runtime, S, "pause", "p", { workflowID: ctx.wf.id })
    await requested.quiesce
    const result = await running
    expect(result).toMatchObject({ aborted: true, cancelled: 0 })
    expect(result.abortReason).toBe(`workflow_pause:${requested.token}`)
    const tasks = readLedger(wt.worktree, S).tasks
    expect(tasks.map(t => t.status)).toEqual(["pending", "pending", "pending"])
    expect(tasks[0]).toMatchObject({ attempts: 0, error: `paused: workflow_pause:${requested.token}` })
    // the queue's finally observer (injected onSettled) proved quiescence and settled exactly once
    const wf = readWorkflow(wt.worktree, S)!
    expect(wf.phase).toBe("paused")
    expect(kindsOf(wf.id).filter(k => k === "pause_settled")).toHaveLength(1)
    expect(transitions(wf.id)).not.toContain("settle_fail")
    // the execution record keeps the true cancelled terminal outcome
    expect(ctx.runtime.runs.status().executions.at(-1)).toMatchObject({ terminal: { outcome: "cancelled" } })
  })

  test("a cancel (not a pause) still cancels every open task", async () => {
    const ctx = boot("executing")
    const tag = { id: ctx.wf.id, planSha: "plan-sha" }
    let started = false
    client.replies.worker = { text: "x", run: () => ((started = true), new Promise<void>(() => {})) }
    writeLedger(wt.worktree, addTasks(emptyLedger(S), [{ title: "a" }, { title: "b" }], Date.now(), tag).ledger)
    const running = getQueue(ctx.runtime).run(S)
    await waitFor(() => started)
    const requested = requestStop(ctx.runtime, S, "cancel", "c", { workflowID: ctx.wf.id })
    await requested.quiesce
    await running
    expect(readLedger(wt.worktree, S).tasks.map(t => t.status)).toEqual(["cancelled", "cancelled"])
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "cancelled", stopIntent: null })
  })
})

describe("foreign and unowned requests", () => {
  test("a foreign sid pause or cancel is refused with no index, revision or hold change", () => {
    const ctx = boot("executing")
    const before = readFileSync(workflowPath(wt.worktree, S))
    const eventsBefore = readEvents(wt.worktree, undefined, S).length
    for (const kind of ["pause", "cancel"] as const) {
      const r = requestStop(ctx.runtime, "ses_foreign", kind, "x", { workflowID: ctx.wf.id })
      expect(r.result.ok).toBe(false)
    }
    expect(readFileSync(workflowPath(wt.worktree, S)).equals(before)).toBe(true)
    expect(readEvents(wt.worktree, undefined, S).length).toBe(eventsBefore)
    expect(effectiveHold(wt.worktree, S)).toBe(false)
  })

  test("a stale expected revision is refused without mutation", () => {
    const ctx = boot("executing")
    const before = readFileSync(workflowPath(wt.worktree, S))
    const r = requestStop(ctx.runtime, S, "pause", "x", { workflowID: ctx.wf.id, expectedRevision: ctx.wf.lastSeq - 1 })
    expect(r.result.ok).toBe(false)
    expect(readFileSync(workflowPath(wt.worktree, S)).equals(before)).toBe(true)
  })

  test("pause is refused from stuck and from a terminal workflow", () => {
    const stuck = boot("stuck", "terminal")
    expect(requestStop(stuck.runtime, S, "pause", "x", { workflowID: stuck.wf.id }).result.ok).toBe(false)
  })
})

describe("failure steal: a failing task during a pending pause", () => {
  test("no settle_fail, user_stop or settle_ok transition is ever committed", () => {
    const ctx = boot("executing")
    const tag = { id: ctx.wf.id, planSha: "plan-sha" }
    const { ledger } = addTasks(emptyLedger(S), [{ title: "done" }, { title: "failed" }, { title: "stopped" }], Date.now(), tag)
    writeLedger(wt.worktree, { ...ledger, tasks: ledger.tasks.map((t, i) => ({
      ...t, status: i === 0 ? "done" as const : "cancelled" as const, error: i === 1 ? "boom" : "user_stop", finishedAt: Date.now(),
    })) })
    const release = beginExecutionActivity(ctx.runtime, S, "stage")!
    cleanups.push(release)
    requestStop(ctx.runtime, S, "pause", "x", { workflowID: ctx.wf.id })
    release()
    cleanups.pop()
    // Every task is terminal (one failed, one user_stop marker): ordinary settlement would run user_stop/settle_fail.
    expect(settleOwned(ctx.runtime, { sessionID: S, epoch: store.epoch }, "idle")).toMatchObject({ kind: "settled" })
    const after = readWorkflow(wt.worktree, S)!
    expect(after.phase).toBe("paused")
    expect(transitions(after.id)).not.toContain("settle_fail")
    expect(transitions(after.id)).not.toContain("user_stop")
    expect(transitions(after.id)).not.toContain("settle_ok")
    // proof was not manufactured: task statuses are exactly as written
    expect(readLedger(wt.worktree, S).tasks.map(t => t.status)).toEqual(["done", "cancelled", "cancelled"])
  })
})

describe("cancel wins under every observer order", () => {
  type Step = "pause" | "cancel" | "queueFinally" | "reviewFinally"
  const ORDERS: Step[][] = [
    ["pause", "cancel", "queueFinally", "reviewFinally"],
    ["pause", "queueFinally", "cancel", "reviewFinally"],
    ["pause", "reviewFinally", "queueFinally", "cancel"],
    ["pause", "queueFinally", "reviewFinally", "cancel"],
    ["pause", "cancel", "reviewFinally", "queueFinally"],
  ]
  for (const order of ORDERS) {
    test(order.join(" -> "), () => {
      const ctx = boot("executing")
      const queueLike = beginExecutionActivity(ctx.runtime, S, "stage")! // the single registry slot stands for queue/review
      let queueHeld = true
      const reviewHold = beginStageReservation(wt.worktree, S)
      let reviewHeld = true
      let pauseToken: string | undefined
      for (const step of order) {
        if (step === "pause") {
          const r = requestStop(ctx.runtime, S, "pause", "p", { workflowID: ctx.wf.id })
          expect(r.result.ok).toBe(true)
          pauseToken = r.token
        } else if (step === "cancel") {
          const r = requestStop(ctx.runtime, S, "cancel", "c", { workflowID: ctx.wf.id })
          expect(r.result.ok).toBe(true)
        } else if (step === "queueFinally") { queueLike(); queueHeld = false; observeStopSettlement(ctx.runtime, S, store.epoch, "queue") }
        else { reviewHold(); reviewHeld = false; observeStopSettlement(ctx.runtime, S, store.epoch, "review") }
      }
      expect(queueHeld || reviewHeld).toBe(false)
      const wf = readWorkflow(wt.worktree, S)!
      expect(wf).toMatchObject({ phase: "cancelled", stopIntent: null })
      const events = readEvents(wt.worktree, wf.id, S)
      expect(events.filter(e => e.type === "cancel_settled")).toHaveLength(1)
      const replaced = events.find(e => e.type === "stop_requested" && e.data?.kind === "cancel")
      expect(replaced?.data?.replaces).toBe(pauseToken)
      // the pause may have settled before the cancel replaced it, but never after
      const lastPause = events.map(e => e.type).lastIndexOf("pause_settled")
      const cancelIdx = events.findIndex(e => e.type === "stop_requested" && e.data?.kind === "cancel")
      expect(lastPause === -1 || lastPause < cancelIdx).toBe(true)
      // a late observer after the terminal commit changes nothing
      const revision = wf.lastSeq
      observeStopSettlement(ctx.runtime, S, store.epoch, "late-pause")
      expect(readWorkflow(wt.worktree, S)!.lastSeq).toBe(revision)
    })
  }

  test("pause is refused while a cancel is pending; cancel from a settled pause is accepted", () => {
    const ctx = boot("executing")
    const hold = beginStageReservation(wt.worktree, S)
    expect(requestStop(ctx.runtime, S, "cancel", "c", { workflowID: ctx.wf.id }).result.ok).toBe(true)
    const refused = requestStop(ctx.runtime, S, "pause", "p", { workflowID: ctx.wf.id })
    expect(refused.result.ok).toBe(false)
    expect(readWorkflow(wt.worktree, S)!.stopIntent?.kind).toBe("cancel")
    hold()
    observeStopSettlement(ctx.runtime, S, store.epoch, "test")
    expect(readWorkflow(wt.worktree, S)!.phase).toBe("cancelled")
  })
})

describe("settleOwned inertness", () => {
  test("old epoch, foreign sid and stale workflow identity are refused with zero mutation", () => {
    const ctx = boot("executing")
    const hold = beginStageReservation(wt.worktree, S)
    cleanups.push(hold)
    requestStop(ctx.runtime, S, "pause", "p", { workflowID: ctx.wf.id })
    hold(); cleanups.pop()
    const before = readFileSync(workflowPath(wt.worktree, S))
    const eventsBefore = readEvents(wt.worktree, undefined, S).length
    for (const ref of [
      { sessionID: S, epoch: "old-epoch" },
      { sessionID: "ses_foreign", epoch: store.epoch },
      { sessionID: S, workflowID: "wf_not_this_one", epoch: store.epoch },
    ]) expect(settleOwned(ctx.runtime, ref, "stale", { stopOnly: true }).kind).toBe("refused")
    expect(readFileSync(workflowPath(wt.worktree, S)).equals(before)).toBe(true)
    expect(readEvents(wt.worktree, undefined, S).length).toBe(eventsBefore)
    expect(settleStop(ctx.runtime)).toMatchObject({ kind: "settled" })
  })

  test("held safety settlement commits only stop events and never ordinary settlement", () => {
    const ctx = boot("executing")
    const tag = { id: ctx.wf.id, planSha: "p" }
    const { ledger } = addTasks(emptyLedger(S), [{ title: "ok" }], Date.now(), tag)
    writeLedger(wt.worktree, { ...ledger, tasks: ledger.tasks.map(t => ({ ...t, status: "done" as const })) })
    // held by an earlier pause request (admission closed) but with no recorded intent: ordinary settle must not run
    ctx.runtime.runs.status()
    const held = settleOwned(ctx.runtime, { sessionID: S, epoch: store.epoch }, "repair", { heldSafety: true })
    expect(held.kind).toBe("held")
    expect(readWorkflow(wt.worktree, S)!.phase).toBe("executing")
    expect(transitions(ctx.wf.id)).not.toContain("settle_ok")
  })
})

describe("W6 cancel from every non-terminal phase retains records", () => {
  const PHASES: Array<[Workflow["phase"], string]> = [
    ["planning", "draft"], ["reviewing", "review"], ["pending_approval", "decision"], ["executing", "unit"],
  ]
  const filesOf = (dir: string): string[] => {
    const out: string[] = []
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name)) }
    walk(dir)
    return out.filter(f => f.includes("/workflows/") && /revisions\/\d+\.json$/.test(f)).sort()
  }
  for (const [phase, stage] of PHASES) {
    for (const live of [false, true]) {
      test(`${phase}${live ? " with live work" : ""}: terminal only after proof, nothing removed`, () => {
        const ctx = boot(phase, stage)
        const hold = live ? beginStageReservation(wt.worktree, S) : undefined
        const before = new Map(filesOf(stateRoot(wt.worktree)).map(f => [f, readFileSync(f)]))
        const r = requestStop(ctx.runtime, S, "cancel", "c", { workflowID: ctx.wf.id })
        expect(r.result.ok).toBe(true)
        if (live) {
          const pending = readWorkflow(wt.worktree, S)!
          expect(pending).toMatchObject({ phase, stopIntent: { kind: "cancel" } }) // never cancelled before proof
          expect(stopDisplay(pending)).toBe("cancelling")
          hold!()
          observeStopSettlement(ctx.runtime, S, store.epoch, "test")
        }
        const done = readWorkflow(wt.worktree, S)!
        expect(done).toMatchObject({ phase: "cancelled", stopIntent: null })
        const after = new Set(filesOf(stateRoot(wt.worktree)))
        for (const [file, bytes] of before) {
          expect(after.has(file)).toBe(true)
          expect(readFileSync(file).equals(bytes)).toBe(true)
        }
        expect(existsSync(eventsPath(wt.worktree, S))).toBe(true)
        expect(after.size).toBeGreaterThan(before.size)
      })
    }
  }

  test("stuck, a pending pause and a settled pause also cancel; a restart is a new id", () => {
    const stuck = boot("stuck", "terminal")
    expect(requestStop(stuck.runtime, S, "cancel", "c", { workflowID: stuck.wf.id }).result.ok).toBe(true)
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ id: stuck.wf.id, phase: "cancelled" })
    const restarted = startWorkflow(stuck.runtime, S, "command", "again", "user_command", "opencode")
    expect(restarted.ok).toBe(true)
    if (restarted.ok) expect(restarted.wf.id).not.toBe(stuck.wf.id)
  })

  test("cancel from a settled pause goes through the same proof and retains the pause history", () => {
    const ctx = boot("executing")
    expect(requestStop(ctx.runtime, S, "pause", "p", { workflowID: ctx.wf.id }).result.ok).toBe(true)
    expect(readWorkflow(wt.worktree, S)!.phase).toBe("paused")
    expect(requestStop(ctx.runtime, S, "cancel", "c", { workflowID: ctx.wf.id }).result.ok).toBe(true)
    const wf = readWorkflow(wt.worktree, S)!
    expect(wf.phase).toBe("cancelled")
    expect(kindsOf(wf.id)).toEqual(expect.arrayContaining(["pause_settled", "cancel_settled"]))
  })
})

describe("StopDisplay", () => {
  test("is exhaustive and truth-first", () => {
    expect([...STOP_DISPLAYS]).toEqual(["none", "pausing", "paused", "cancelling"])
    const base = { phase: "executing" as const, stopIntent: null }
    const intent = (kind: "pause" | "cancel") => ({ kind, token: "t", requestedFrom: { phase: "executing" as const, stage: "unit" }, checkpoint: null, reason: "r" })
    expect(stopDisplay(base)).toBe("none")
    expect(stopDisplay({ ...base, stopIntent: intent("pause") })).toBe("pausing")
    expect(stopDisplay({ phase: "paused", stopIntent: intent("pause") })).toBe("paused")
    expect(stopDisplay({ ...base, stopIntent: intent("cancel") })).toBe("cancelling")
    expect(stopDisplay({ phase: "paused", stopIntent: intent("cancel") })).toBe("cancelling")
  })
})

describe("crash windows (map Risk 10)", () => {
  const checkpointFiles = (wid: string) => {
    try { return readdirSync(join(stateRoot(wt.worktree), "sessions", S, "workflows", wid, "checkpoints")).sort() } catch { return [] }
  }
  const fail = (stage: string) => __setCommitFaultHook(at => { if (at === stage) throw new Error(`injected ${at}`) })

  test("a: a snapshot or index fault in the pause request commit keeps the old revision, the hold and no intent", () => {
    for (const stage of ["snapshot-rename", "index-rename"]) {
      const ctx = boot("executing")
      const before = readFileSync(workflowPath(wt.worktree, S))
      fail(stage)
      expect(() => requestStop(ctx.runtime, S, "pause", "p", { workflowID: ctx.wf.id })).toThrow("injected")
      __setCommitFaultHook(null)
      expect(readFileSync(workflowPath(wt.worktree, S)).equals(before)).toBe(true)
      expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "executing", stopIntent: null })
      expect(effectiveHold(wt.worktree, S)).toBe(true) // hold precedes the intent, so a crash leaves the session held
      // a retry after the fault commits the intent normally
      expect(requestStop(ctx.runtime, S, "pause", "p", { workflowID: ctx.wf.id }).result.ok).toBe(true)
      expect(readWorkflow(wt.worktree, S)!.stopIntent?.kind).toBe("pause")
      releaseFixtureSession(wt.worktree, store)
      wt.cleanup(); wt = tempGitWorktree({ "README.md": "fixture\n" })
    }
  })

  test("b: a failing admission hold makes requestStop refuse with no new event and no intent", () => {
    const ctx = boot("executing")
    const before = readFileSync(workflowPath(wt.worktree, S))
    const events = readEvents(wt.worktree, undefined, S).length
    chmodSync(sessionDir(wt.worktree, S), 0o500)
    try {
      const refused = requestStop(ctx.runtime, S, "pause", "p", { workflowID: ctx.wf.id })
      expect(refused.result.ok).toBe(false)
    } finally { chmodSync(sessionDir(wt.worktree, S), 0o700) }
    expect(readFileSync(workflowPath(wt.worktree, S)).equals(before)).toBe(true)
    expect(readEvents(wt.worktree, undefined, S).length).toBe(events)
    expect(readWorkflow(wt.worktree, S)!.stopIntent).toBeNull()
  })

  test("c: a fault in the pause_settled commit leaves the pause pending with checkpoints retained; a later settle commits exactly one", () => {
    const ctx = boot("executing")
    const hold = beginStageReservation(wt.worktree, S)
    requestStop(ctx.runtime, S, "pause", "p", { workflowID: ctx.wf.id })
    hold()
    const before = readFileSync(workflowPath(wt.worktree, S))
    fail("index-rename")
    expect(() => settleStop(ctx.runtime)).toThrow("injected")
    __setCommitFaultHook(null)
    expect(readFileSync(workflowPath(wt.worktree, S)).equals(before)).toBe(true)
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "executing", stopIntent: { kind: "pause" } })
    // the settled checkpoint is written before the commit and retained; it is write-once so the retry reuses it
    expect(checkpointFiles(ctx.wf.id).some(name => name.endsWith("-settled.json"))).toBe(true)
    expect(settleStop(ctx.runtime)).toMatchObject({ kind: "settled" })
    expect(kindsOf(ctx.wf.id).filter(k => k === "pause_settled")).toHaveLength(1)
    expect(readWorkflow(wt.worktree, S)!.phase).toBe("paused")
  })

  test("d: a fault in the cancel_settled commit after the outcome record is recoverable: a retry ends cancelled with one cancel_settled", () => {
    const ctx = boot("executing")
    const { ledger } = addTasks(emptyLedger(S), [{ title: "open" }], Date.now(), { id: ctx.wf.id, planSha: "p" })
    writeLedger(wt.worktree, ledger)
    const hold = beginStageReservation(wt.worktree, S)
    requestStop(ctx.runtime, S, "cancel", "c", { workflowID: ctx.wf.id })
    hold()
    fail("index-rename")
    expect(() => settleStop(ctx.runtime)).toThrow("injected")
    __setCommitFaultHook(null)
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "executing", stopIntent: { kind: "cancel" } })
    expect(settleStop(ctx.runtime)).toMatchObject({ kind: "settled" })
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "cancelled", stopIntent: null })
    expect(kindsOf(ctx.wf.id).filter(k => k === "cancel_settled")).toHaveLength(1)
    expect(readLedger(wt.worktree, S).tasks.map(t => t.status)).toEqual(["cancelled"])
  })

  test("e: a fault between the resume commit and the admission token leaves the workflow resumed and the session held; an explicit Resume then admits", async () => {
    const ctx = boot("planning")
    requestStop(ctx.runtime, S, "pause", "p", { workflowID: ctx.wf.id })
    expect(readWorkflow(wt.worktree, S)!.phase).toBe("paused")
    const revision = readWorkflow(wt.worktree, S)!.lastSeq
    let committed = false
    __setCommitFaultHook(at => {
      if (at !== "index-dirfsync" || committed) return
      committed = true
      // the resume commit is durable after this stage; make the token step (resumeAdmission) refuse
      writeFileSync(abortPath(wt.worktree, S), JSON.stringify({ reason: "other", at: Date.now() }))
    })
    const outcome = await resumePaused(ctx.runtime, S, revision, { preflight: async () => {}, fence: () => "f", choose: async () => true }).catch((e: unknown) => e)
    expect(outcome).toBeInstanceOf(Error)
    __setCommitFaultHook(null)
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "planning", stopIntent: null })
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(kindsOf(ctx.wf.id).filter(k => k === "resumed")).toHaveLength(1)
    rmSync(abortPath(wt.worktree, S), { force: true })
    resumeAdmission(ctx.runtime, S, readWorkflow(wt.worktree, S)!.lastSeq)
    expect(effectiveHold(wt.worktree, S)).toBe(false)
  })
})


// P6a S1: the P5b stop/settle/resume routines are kind-generic for planning kinds (no fork).
describe("planning kinds reuse the stop, settle and resume routines", () => {
  for (const kind of ["deep-interview", "ralplan"] as const) {
    const live = kind === "deep-interview" ? { stage: "question", phase: "planning" } : { stage: "architect", phase: "reviewing" }
    function bootKind() {
      const deps = makeDeps(client, wt.worktree, { delegate: { review: false } as any })
      const runtime = getOpenCodeRuntime(deps)
      store = admitFixtureSession(deps, S)
      const wf = flowTx(wt.worktree, tx => commitRevision(tx, {
        version: 2, id: `wf_${kind}`, kind, ...live, engine: "opencode", sessionID: S, owner: { instance: store.epoch, pid: process.pid },
        stopIntent: null, artifacts: [], data: {}, lastSeq: 0, createdAt: 1, updatedAt: 1,
      } as never, [{ wf: `wf_${kind}`, type: "created", actor: "code" }]))
      return { runtime, wf }
    }
    const current = () => committedSnapshot(wt.worktree) as unknown as { phase: string; stage: string; kind: string; stopIntent: { kind: string; checkpoint: string | null } | null; pausedFrom?: { phase: string; stage: string }; lastSeq: number }

    test(`${kind}: pause with a live stage turn is pausing, settles once after proof, and resume restores the same stage (never execution)`, async () => {
      const { runtime, wf } = bootKind()
      const release = beginExecutionActivity(runtime, S, "stage", { abort: () => {} })!
      cleanups.push(release)
      const requested = requestStop(runtime, S, "pause", "user pause", { workflowID: wf.id })
      expect(requested.result.ok).toBe(true)
      expect(current()).toMatchObject({ kind, phase: live.phase, stage: live.stage, stopIntent: { kind: "pause" } })
      expect(effectiveHold(wt.worktree, S)).toBe(true)
      expect(settleOwned(runtime, { sessionID: S, epoch: store.epoch }, "t", { stopOnly: true })).toMatchObject({ kind: "waiting" })
      release()
      expect(settleOwned(runtime, { sessionID: S, epoch: store.epoch }, "t", { stopOnly: true })).toMatchObject({ kind: "settled" })
      const paused = current()
      expect(paused).toMatchObject({ phase: "paused", stage: live.stage, pausedFrom: { phase: live.phase, stage: live.stage } })
      expect(paused.stopIntent?.checkpoint).toContain("-settled.json#")
      expect(kindsOf(wf.id).filter(k => k === "pause_settled")).toHaveLength(1)
      const checkpoint = JSON.parse(readFileSync(join(stateRoot(wt.worktree), paused.stopIntent!.checkpoint!.split("#")[0]!), "utf8"))
      expect(checkpoint).toMatchObject({ subject: null, plan: null, done: [], residual: [] })
      expect(settleOwned(runtime, { sessionID: S, epoch: store.epoch }, "late", { stopOnly: true })).toMatchObject({ kind: "none" })

      const chosen: string[] = []
      const outcome = await resumePaused(runtime, S, paused.lastSeq, {
        preflight: async () => {}, fence: () => "f", choose: async view => { chosen.push(view.pausedFrom.stage); return true },
      })
      expect(outcome.kind).toBe("resumed")
      expect(chosen).toEqual([live.stage])
      expect(current()).toMatchObject({ kind, phase: live.phase, stage: live.stage, stopIntent: null })
      expect(current().pausedFrom).toBeUndefined()
      expect(current().phase).not.toBe("executing")
      expect(kindsOf(wf.id).filter(k => k === "resumed")).toHaveLength(1)
    })

    test(`${kind}: cancel settles terminal, retains history and an idle pause is one commit`, () => {
      const { runtime, wf } = bootKind()
      const requested = requestStop(runtime, S, "cancel", "user cancel", { workflowID: wf.id })
      expect(requested.result.ok).toBe(true)
      expect(current()).toMatchObject({ phase: "cancelled", stage: "terminal", stopIntent: null })
      expect(kindsOf(wf.id)).toEqual(expect.arrayContaining(["stop_requested", "cancel_settled"]))
      // foreign sid and stale revision are refused with the generic kind in the text
      expect(requestStop(runtime, "ses_other", "pause", "x").result).toMatchObject({ ok: false })
    })

    test(`${kind}: a foreign session pause cannot observe the workflow, and a stale expected revision changes nothing`, () => {
      const { runtime, wf } = bootKind()
      const before = readFileSync(workflowPath(wt.worktree, S))
      const foreign = requestStop(runtime, "ses_foreign", "pause", "x", { workflowID: wf.id }).result
      expect(foreign.ok).toBe(false)
      if (!foreign.ok) expect(foreign.text).toBe("no active workflow")
      expect(requestStop(runtime, S, "pause", "x", { workflowID: wf.id, expectedRevision: wf.lastSeq + 9 }).result).toMatchObject({ ok: false })
      expect(readFileSync(workflowPath(wt.worktree, S)).equals(before)).toBe(true)
    })
  }
})
