// AC0.6: the §5.3 authority matrix — owner.authorize (pure) and runtime.resolveAuthority (mutation/side effects),
// including explicit owner resume and the timer heartbeat.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { authorize, currentOwner, ownerLive, startHeartbeat, STALE_MS, type LivenessCtx } from "../src/flow/owner.ts"
import { newWorkflow, readHeartbeat, readWorkflow, workflowPath, eventsPath, readEvents, type Workflow, withFlowTransaction, writeHeartbeat } from "../src/flow/state.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { applyEvent, resolveAuthority, startWorkflow, repairOnLoad, stopHeartbeat } from "../src/flow/runtime.ts"
import { sessionDir } from "../src/state/store.ts"
import { ledgerPath } from "../src/state/ledger.ts"
import { attachAdmission, effectiveHold, resumeAdmission } from "../src/sessions/admission.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { admitFixtureSession, requestCancel, fakeClient, makeDeps, releaseFixtureSession, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_owner"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient
let fixtureSessions: Array<ReturnType<typeof admitFixtureSession>>

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
  fixtureSessions = []
})
afterEach(() => {
  stopHeartbeat()
  for (const store of fixtureSessions.splice(0)) releaseFixtureSession(wt.worktree, store)
  wt.cleanup()
})

function admit(deps: ReturnType<typeof makeDeps>, sessionID: string) {
  const store = admitFixtureSession(deps, sessionID)
  fixtureSessions.push(store)
  return store
}

/** `heartbeatAt` in an owner patch is a test-side liveness hint: it goes to the sidecar, never into the snapshot. */
function putWorkflow(patch: Record<string, unknown> = {}): Workflow {
  const wf = { ...newWorkflow(S, currentOwner(1000, "inst_dead", 999999), "command", "do it", "opencode"), ...patch }
  const beat = (patch.owner as { heartbeatAt?: number } | undefined)?.heartbeatAt
  return withFlowTransaction(wt.worktree, flowTx => {
    const written = writeWorkflow(flowTx, wf as Workflow, 1000)
    if (beat !== undefined) writeHeartbeat(flowTx, written, beat)
    return written
  })
}

const liveCtx = (opts: Partial<LivenessCtx> = {}): LivenessCtx => ({
  now: 1000,
  instance: "inst_this",
  pidAlive: () => true,
  epochReleased: () => false,
  heartbeatAt: wf => readHeartbeat(wt.worktree, wf),
  ...opts,
})

describe("owner.authorize — §5.3 matrix (pure)", () => {
  test("owning session, owner live -> allow for every command", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(1000, "inst_this", 111) })
    const ctx = liveCtx({ instance: "inst_this" })
    for (const cmd of ["status", "plan", "approve", "reject", "cancel"] as const) {
      expect(authorize(cmd, S, wf, ctx).kind).toBe("allow")
    }
    // authorize() itself always says "allow" for the owning-live cell; the caller (startWorkflow) separately
    // refuses a second /plan while non-terminal, non-stuck — that policy lives outside authorize().
  })

  test("dead owning session may inspect but every mutation requires explicit Resume", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(1000, "inst_dead", 111) })
    const ctx = liveCtx({ instance: "inst_this", pidAlive: () => false })
    expect(authorize("status", S, wf, ctx).kind).toBe("allow")
    for (const cmd of ["plan", "approve", "reject", "cancel"] as const) {
      const result = authorize(cmd, S, wf, ctx)
      expect(result.kind).toBe("refuse")
      if (result.kind === "refuse") expect(result.text).toContain(`/resume ${S}`)
    }
  })

  test("other session, owner live -> status allow; every mutation refuses with the owner resume instruction", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(1000, "inst_owner", 111) })
    const ctx = liveCtx({ instance: "inst_owner" }) // same instance as owner => live
    expect(authorize("status", OTHER, wf, ctx).kind).toBe("allow")
    for (const cmd of ["plan", "approve", "reject", "cancel"] as const) {
      const a = authorize(cmd, OTHER, wf, ctx)
      expect(a.kind).toBe("refuse")
      expect((a as any).text).toContain(`session ${S}`)
      expect((a as any).text).toContain(`/resume ${S}`)
    }
  })

  test("other session, dead owner -> status allow; every mutation refuses with the owner resume instruction", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(1000, "inst_dead", 111) })
    const ctx = liveCtx({ instance: "inst_other", pidAlive: () => false })
    expect(authorize("status", OTHER, wf, ctx).kind).toBe("allow")
    for (const cmd of ["plan", "approve", "reject", "cancel"] as const) {
      const a = authorize(cmd, OTHER, wf, ctx)
      expect(a.kind).toBe("refuse")
      expect((a as any).text).toContain(`session ${S}`)
      expect((a as any).text).toContain(`/resume ${S}`)
    }
  })

  test("missing owner session -> status allow; every mutation refuses with the owner resume instruction", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(1000, "inst_owner", 111) })
    const ctx = liveCtx({ instance: "inst_other", epochReleased: () => true })
    expect(authorize("status", OTHER, wf, ctx).kind).toBe("allow")
    for (const cmd of ["plan", "approve", "reject", "cancel"] as const) {
      const a = authorize(cmd, OTHER, wf, ctx)
      expect(a.kind).toBe("refuse")
      expect((a as any).text).toContain(`session ${S}`)
      expect((a as any).text).toContain(`/resume ${S}`)
    }
  })

  test("no workflow -> none for every command", () => {
    const ctx = liveCtx()
    for (const cmd of ["status", "plan", "approve", "reject", "cancel"] as const) {
      expect(authorize(cmd, S, null, ctx).kind).toBe("none")
    }
  })

  test("pid reuse: different pid alive but stale heartbeat = dead", () => {
    const wf = putWorkflow({ sessionID: S, owner: { instance: "inst_prev", pid: 222, heartbeatAt: 0 } })
    const ctx = liveCtx({ now: STALE_MS + 1, instance: "inst_this", pidAlive: () => true })
    expect(ownerLive(wf, ctx)).toBe(false)
    expect(authorize("status", S, wf, ctx).kind).toBe("allow")
    const mutation = authorize("cancel", S, wf, ctx)
    expect(mutation.kind).toBe("refuse")
    if (mutation.kind === "refuse") expect(mutation.text).toContain(`/resume ${S}`)
  })

  test("same instance but session deleted = dead", () => {
    const wf = putWorkflow({ sessionID: S, owner: { instance: "inst_this", pid: 333, heartbeatAt: 999 } })
    const ctx = liveCtx({ now: 1000, instance: "inst_this", pidAlive: () => true, epochReleased: () => true })
    expect(ownerLive(wf, ctx)).toBe(false)
  })

  test("live heartbeat within STALE_MS keeps the same-instance owner live even with a fresh instance mismatch check bypassed", () => {
    const wf = putWorkflow({ sessionID: S, owner: { instance: "inst_a", pid: 444, heartbeatAt: 1000 } })
    const ctx = liveCtx({ now: 1000 + STALE_MS - 1, instance: "inst_b", pidAlive: () => true })
    expect(ownerLive(wf, ctx)).toBe(true)
  })

  test("heartbeat exactly at STALE_MS or past it is dead (different instance)", () => {
    const wf = putWorkflow({ sessionID: S, owner: { instance: "inst_a", pid: 444, heartbeatAt: 1000 } })
    const ctx = liveCtx({ now: 1000 + STALE_MS, instance: "inst_b", pidAlive: () => true })
    expect(ownerLive(wf, ctx)).toBe(false)
  })
})

describe("runtime.resolveAuthority — mutation/side effects", () => {
  function bytes() {
    return readFileSync(workflowPath(wt.worktree, S))
  }

  function eventBytes() {
    try {
      return readFileSync(eventsPath(wt.worktree, S))
    } catch {
      return null
    }
  }

  function ledgerBytes(sessionID = S) {
    try {
      return readFileSync(ledgerPath(wt.worktree, sessionID))
    } catch {
      return null
    }
  }

  test("owning session, owner live -> allow, no mutation", () => {
    const deps = makeDeps(client, wt.worktree)
    const store = admit(deps, S)
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(Date.now(), store.epoch) })
    const before = bytes()
    const r = resolveAuthority(deps, "status", S, "opencode")
    expect(r.wf?.id).toBe(wf.id)
    expect(r.refuse).toBeUndefined()
    expect(r.wf?.owner.instance).toBe(store.epoch)
    expect(bytes()).toEqual(before)
  })

  test("dead owning session status is read-only and mutations refuse without workflow, event, or ledger changes", () => {
    const wf = putWorkflow({ sessionID: S, owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 }, phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    const workflowBefore = bytes()
    const eventsBefore = eventBytes()
    const ledgerBefore = ledgerBytes()
    const callsBefore = client.calls.length

    const status = resolveAuthority(deps, "status", S, "opencode")
    expect(status.refuse).toBeUndefined()
    expect(status.ownerDead).toBe(true)
    expect(status.wf).toEqual(wf)
    expect(bytes()).toEqual(workflowBefore)
    expect(eventBytes()).toEqual(eventsBefore)
    expect(ledgerBytes()).toEqual(ledgerBefore)

    for (const cmd of ["plan", "approve", "reject", "cancel"] as const) {
      const result = resolveAuthority(deps, cmd, S, "opencode")
      expect(result.refuse).toContain(`/resume ${S}`)
      expect(result.wf?.id).toBe(wf.id)
      expect(bytes()).toEqual(workflowBefore)
      expect(eventBytes()).toEqual(eventsBefore)
      expect(ledgerBytes()).toEqual(ledgerBefore)
    }
    const start = startWorkflow(deps, S, "command", "new request", "user_command", "opencode")
    expect(start.ok).toBe(false)
    if (!start.ok) expect(start.text).toContain(`/resume ${S}`)
    expect(bytes()).toEqual(workflowBefore)
    expect(eventBytes()).toEqual(eventsBefore)
    expect(ledgerBytes()).toEqual(ledgerBefore)
    expect(client.calls.length).toBe(callsBefore)
  })

  test("other session sees no workflow and cannot mutate the live owner", () => {
    const deps = makeDeps(client, wt.worktree)
    const store = admit(deps, S)
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(Date.now(), store.epoch) })
    const before = bytes()
    const eventsBefore = eventBytes()
    const ledgerBefore = ledgerBytes()
    for (const cmd of ["plan", "approve", "reject", "cancel"] as const) {
      const r = resolveAuthority(deps, cmd, OTHER, "opencode")
      expect(r.refuse).toBeUndefined()
      expect(r.wf).toBeNull()
      expect(bytes()).toEqual(before)
      expect(eventBytes()).toEqual(eventsBefore)
      expect(ledgerBytes()).toEqual(ledgerBefore)
    }
  })

  test("other session status does not disclose the dead owner and leaves files unchanged", () => {
    putWorkflow({ sessionID: S, owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 } })
    const deps = makeDeps(client, wt.worktree)
    const before = bytes()
    const eventsBefore = eventBytes()
    const ledgerBefore = ledgerBytes()
    const r = resolveAuthority(deps, "status", OTHER, "opencode")
    expect(r.refuse).toBeUndefined()
    expect(r.ownerDead).toBeUndefined()
    expect(r.wf).toBeNull()
    expect(bytes()).toEqual(before)
    expect(eventBytes()).toEqual(eventsBefore)
    expect(ledgerBytes()).toEqual(ledgerBefore)
  })

  test("other session authority lookup returns no workflow without mutation", () => {
    const wf = putWorkflow({ sessionID: S, owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 } })
    const deps = makeDeps(client, wt.worktree)
    const before = bytes()
    const eventsBefore = eventBytes()
    const ledgerBefore = ledgerBytes()
    const callsBefore = client.calls.length
    for (const cmd of ["plan", "approve", "reject", "cancel"] as const) {
      const r = resolveAuthority(deps, cmd, OTHER, "opencode")
      expect(r.refuse).toBeUndefined()
      expect(r.wf).toBeNull()
      expect(bytes()).toEqual(before)
      expect(eventBytes()).toEqual(eventsBefore)
      expect(ledgerBytes()).toEqual(ledgerBefore)
    }
    expect(client.calls.length).toBe(callsBefore)
  })

  test("unadmitted session start refuses without rotating a foreign workflow", () => {
    const wf = putWorkflow({ sessionID: S, owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 } })
    const deps = makeDeps(client, wt.worktree)
    const before = bytes()
    const eventsBefore = eventBytes()
    const ledgerBefore = ledgerBytes()
    const callsBefore = client.calls.length

    const result = startWorkflow(deps, OTHER, "command", "new request", "user_command", "opencode")

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.text).toContain(`session ${OTHER} has no live admission`)
    }
    expect(bytes()).toEqual(before)
    expect(eventBytes()).toEqual(eventsBefore)
    expect(ledgerBytes()).toEqual(ledgerBefore)
    expect(readWorkflow(wt.worktree, S)?.id).toBe(wf.id)
    expect(client.calls.length).toBe(callsBefore)
  })

  test("other session status and mutation lookups never adopt the dead owner", () => {
    // P5a intended change: committed snapshots live under sessions/<sid>/, so deleting that directory would delete
    // the index target (fail-closed corrupt, and session deletion never removes snapshots). Owner death is therefore
    // modelled with a dead pid; unrelated session lookups still cannot adopt this workflow.
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(Date.now(), "inst_owner", 9_999_999) })
    const deps = makeDeps(client, wt.worktree)
    const before = bytes()
    const eventsBefore = eventBytes()
    const ledgerBefore = ledgerBytes()
    const status = resolveAuthority(deps, "status", OTHER, "opencode")
    expect(status.refuse).toBeUndefined()
    expect(status.ownerDead).toBeUndefined()
    expect(status.wf).toBeNull()
    expect(bytes()).toEqual(before)
    expect(eventBytes()).toEqual(eventsBefore)
    expect(ledgerBytes()).toEqual(ledgerBefore)
    const callsBefore = client.calls.length
    for (const cmd of ["plan", "approve", "reject", "cancel"] as const) {
      const r = resolveAuthority(deps, cmd, OTHER, "opencode")
      expect(r.refuse).toBeUndefined()
      expect(r.wf).toBeNull()
      expect(bytes()).toEqual(before)
      expect(eventBytes()).toEqual(eventsBefore)
      expect(ledgerBytes()).toEqual(ledgerBefore)
    }
    expect(client.calls.length).toBe(callsBefore)
  })

  test("repairOnLoad with an unadmitted dead owner is a byte-identical no-op", () => {
    const wf = putWorkflow({ sessionID: S, owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 }, phase: "reviewing" })
    const deps = makeDeps(client, wt.worktree)
    const workflowBefore = bytes()
    const eventsBefore = eventBytes()
    const ledgerBefore = ledgerBytes()

    expect(repairOnLoad(deps, "opencode")).toBeNull()

    expect(bytes()).toEqual(workflowBefore)
    expect(eventBytes()).toEqual(eventsBefore)
    expect(ledgerBytes()).toEqual(ledgerBefore)
    expect(readWorkflow(wt.worktree, S)).toEqual(wf)
  })

  test("held rebind remains blocked until validated explicit Resume, then updates workflow events", () => {
    const deps = makeDeps(client, wt.worktree)
    const host = getOpenCodeRuntime(deps)
    const firstStore = admit(deps, S)
    const original = putWorkflow({ sessionID: S, owner: currentOwner(Date.now(), firstStore.epoch), phase: "planning" })

    releaseFixtureSession(wt.worktree, firstStore)
    const restored = attachAdmission(host, S, { engine: "opencode" })
    fixtureSessions.push(restored)
    expect(restored.restored).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)

    const rebound = readWorkflow(wt.worktree, S)!
    expect(rebound.owner.instance).toBe(restored.epoch)
    expect(readEvents(wt.worktree, original.id, S).some(event => event.type === "owner_reattached")).toBe(true)
    const workflowBeforeResume = bytes()
    const eventsBeforeResume = eventBytes()
    const ledgerBeforeResume = ledgerBytes()

    const held = resolveAuthority(deps, "cancel", S, "opencode")
    expect(held.refuse).toContain(`/resume ${S}`)
    expect(bytes()).toEqual(workflowBeforeResume)
    expect(eventBytes()).toEqual(eventsBeforeResume)
    expect(ledgerBytes()).toEqual(ledgerBeforeResume)

    const resumed = resumeAdmission(host, S, rebound.lastSeq)
    expect(resumed.epoch).toBe(restored.epoch)
    expect(effectiveHold(wt.worktree, S)).toBe(false)
    const allowed = resolveAuthority(deps, "cancel", S, "opencode")
    expect(allowed.refuse).toBeUndefined()
    expect(allowed.wf?.owner.instance).toBe(restored.epoch)
    const workflowBeforeOperation = bytes()
    const eventsBeforeOperation = eventBytes()
    const ledgerBeforeOperation = ledgerBytes()

    const result = applyEvent(deps, rebound, "user_message", "user_message")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.text)
    expect(result.wf.lastSeq).toBeGreaterThan(rebound.lastSeq)
    expect(result.wf.owner.instance).toBe(restored.epoch)
    expect(bytes()).not.toEqual(workflowBeforeOperation)
    expect(eventBytes()).not.toEqual(eventsBeforeOperation)
    expect(ledgerBytes()).toEqual(ledgerBeforeOperation)
    expect(readEvents(wt.worktree, original.id, S).some(event => event.type === "transition" && event.data?.event === "user_message")).toBe(true)
  })

  test("session.deleted of the admitted owner -> cancelled before the dir is removed", () => {
    const deps = makeDeps(client, wt.worktree)
    const store = admit(deps, S)
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(Date.now(), store.epoch), phase: "planning" })
    const r = requestCancel(deps, wf).result
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.wf.id).toBe(wf.id)
      // idle owner: the request and its proof-backed settlement are one commit
      expect(r.wf.phase).toBe("cancelled")
    }
  })

  test("a live admitted owner mid-run remains unchanged", () => {
    const deps = makeDeps(client, wt.worktree)
    const store = admit(deps, S)
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(Date.now(), store.epoch), phase: "executing" })
    const before = bytes()
    const r = resolveAuthority(deps, "status", S, "opencode")
    expect(r.wf!.phase).toBe("executing")
    expect(r.wf?.owner.instance).toBe(store.epoch)
    expect(bytes()).toEqual(before)
  })
})

describe("owner heartbeat timer", () => {
  test("an unref'd timer with an injected interval refreshes heartbeatAt while tick() returns true, and stops when it returns false", async () => {
    let ticks = 0
    let keep = true
    const hb = startHeartbeat(() => {
      ticks++
      return keep
    }, 10)
    await new Promise((r) => setTimeout(r, 60))
    expect(ticks).toBeGreaterThanOrEqual(3)
    keep = false
    const ticksAtStop = ticks
    await new Promise((r) => setTimeout(r, 60))
    // the timer clears itself once tick() returns false; no further ticks accrue
    expect(ticks).toBeLessThanOrEqual(ticksAtStop + 1)
    hb.stop()
  })

  test("repeated ticks keep the heartbeat sidecar within STALE_MS of now, so a long run stays live", async () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(Date.now(), "inst_this", process.pid) })
    let last = 0
    const hb = startHeartbeat(() => {
      const cur = readWorkflow(wt.worktree, S)!
      last = Date.now()
      withFlowTransaction(wt.worktree, flowTx => writeHeartbeat(flowTx, cur, last))
      return true
    }, 10)
    await new Promise((r) => setTimeout(r, 60))
    hb.stop()
    const cur = readWorkflow(wt.worktree, S)!
    expect(cur.lastSeq).toBe(wf.lastSeq) // heartbeats never mint revisions
    const beat = readHeartbeat(wt.worktree, cur)
    expect(beat).toBe(last)
    const ctx = liveCtx({ now: last + 1000, instance: "inst_other", heartbeatAt: () => beat }) // far short of STALE_MS thanks to refresh
    expect(ownerLive(cur, ctx)).toBe(true)
  })
})
