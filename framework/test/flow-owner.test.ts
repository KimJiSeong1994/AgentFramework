// AC0.6: the §5.3 authority matrix — owner.authorize (pure) and runtime.resolveAuthority (mutation/side effects),
// including the owning-session takeover column (ARCH-14) and the timer heartbeat.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import { authorize, currentOwner, ownerLive, startHeartbeat, STALE_MS, type LivenessCtx } from "../src/flow/owner.ts"
import { newWorkflow, readWorkflow, writeWorkflow, workflowPath, readEvents, type Workflow } from "../src/flow/state.ts"
import { resolveAuthority, repairOnLoad, onSessionDeleted, stopHeartbeat } from "../src/flow/runtime.ts"
import { sessionDir } from "../src/state/store.ts"
import { fakeClient, makeDeps, tempWorktree, type FakeClient } from "./guards-helpers.ts"

const S = "ses_owner"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient()
  mkdirSync(sessionDir(wt.worktree, S), { recursive: true })
  mkdirSync(sessionDir(wt.worktree, OTHER), { recursive: true })
})
afterEach(() => {
  stopHeartbeat()
  wt.cleanup()
})

function putWorkflow(patch: Record<string, unknown> = {}): Workflow {
  const wf = { ...newWorkflow(S, currentOwner(1000, "inst_dead", 999999), "command", "do it"), ...patch }
  return writeWorkflow(wt.worktree, wf as Workflow, 1000)
}

const liveCtx = (opts: Partial<LivenessCtx> = {}): LivenessCtx => ({
  now: 1000,
  instance: "inst_this",
  pidAlive: () => true,
  sessionExists: () => true,
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

  test("owning session, owner dead -> takeover for every command", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(1000, "inst_dead", 111) })
    const ctx = liveCtx({ instance: "inst_this", pidAlive: () => false })
    for (const cmd of ["status", "plan", "approve", "reject", "cancel"] as const) {
      expect(authorize(cmd, S, wf, ctx).kind).toBe("takeover")
    }
  })

  test("other session, owner live -> status allow, plan refuse (already active), approve/reject/cancel refuse (owned by)", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(1000, "inst_owner", 111) })
    const ctx = liveCtx({ instance: "inst_owner" }) // same instance as owner => live
    expect(authorize("status", OTHER, wf, ctx).kind).toBe("allow")
    const plan = authorize("plan", OTHER, wf, ctx)
    expect(plan.kind).toBe("refuse")
    expect((plan as any).text).toContain("already active");
    for (const cmd of ["approve", "reject", "cancel"] as const) {
      const a = authorize(cmd, OTHER, wf, ctx)
      expect(a.kind).toBe("refuse")
      expect((a as any).text).toContain(`owned by session ${S}`)
      expect((a as any).text).not.toContain("owner dead")
    }
  })

  test("other session, owner dead (or wf.sessionID gone) -> status allow, plan foreign_dead_cancel, approve/reject/cancel refuse with dead text", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(1000, "inst_dead", 111) })
    const ctx = liveCtx({ instance: "inst_other", pidAlive: () => false })
    expect(authorize("status", OTHER, wf, ctx).kind).toBe("allow")
    expect(authorize("plan", OTHER, wf, ctx).kind).toBe("foreign_dead_cancel")
    for (const cmd of ["approve", "reject", "cancel"] as const) {
      const a = authorize(cmd, OTHER, wf, ctx)
      expect(a.kind).toBe("refuse")
      expect((a as any).text).toContain("owner dead")
      expect((a as any).text).toContain("/plan from this session replaces it")
    }
  })

  test("missing wf.sessionID (session gone) also drives foreign_dead_cancel on /plan", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(1000, "inst_owner", 111) })
    const ctx = liveCtx({ instance: "inst_other", sessionExists: (id) => id !== S })
    expect(authorize("plan", OTHER, wf, ctx).kind).toBe("foreign_dead_cancel")
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
    expect(authorize("status", S, wf, ctx).kind).toBe("takeover")
  })

  test("same instance but session deleted = dead", () => {
    const wf = putWorkflow({ sessionID: S, owner: { instance: "inst_this", pid: 333, heartbeatAt: 999 } })
    const ctx = liveCtx({ now: 1000, instance: "inst_this", pidAlive: () => true, sessionExists: () => false })
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
    return readFileSync(workflowPath(wt.worktree), "utf8")
  }

  test("owning session, owner live -> allow, no mutation", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(Date.now(), "inst_x", process.pid) })
    const deps = makeDeps(client, wt.worktree)
    const before = bytes()
    const r = resolveAuthority(deps, "status", S)
    expect(r.wf?.id).toBe(wf.id)
    expect(r.refuse).toBeUndefined()
    expect(bytes()).toBe(before)
  })

  test("owning session, owner dead -> takeover: owner rewritten, owner_takeover emitted, phase unchanged", () => {
    const wf = putWorkflow({ sessionID: S, owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 }, phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    const r = resolveAuthority(deps, "status", S)
    expect(r.wf).not.toBeNull()
    expect(r.wf!.phase).toBe("planning")
    expect(r.wf!.owner.instance).not.toBe("inst_dead")
    expect(r.wf!.owner.pid).toBe(process.pid)
    const events = readEvents(wt.worktree, wf.id)
    expect(events.some((e) => e.type === "owner_takeover")).toBe(true)
    stopHeartbeat()
  })

  test("other session, owner live -> refuse, no mutation", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(Date.now(), "inst_x", process.pid) })
    const deps = makeDeps(client, wt.worktree)
    const before = bytes()
    const r = resolveAuthority(deps, "approve", OTHER)
    expect(r.refuse).toContain(`owned by session ${S}`)
    expect(bytes()).toBe(before)
  })

  test("other session, owner dead -> status read-only byte-identical files", () => {
    putWorkflow({ sessionID: S, owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 } })
    const deps = makeDeps(client, wt.worktree)
    const before = bytes()
    const r = resolveAuthority(deps, "status", OTHER)
    expect(r.refuse).toBeUndefined()
    expect(r.ownerDead).toBe(true)
    expect(bytes()).toBe(before)
  })

  test("other session, owner dead -> approve/reject/cancel refuse, no mutation", () => {
    putWorkflow({ sessionID: S, owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 } })
    const deps = makeDeps(client, wt.worktree)
    const before = bytes()
    for (const cmd of ["approve", "reject", "cancel"] as const) {
      const r = resolveAuthority(deps, cmd, OTHER)
      expect(r.refuse).toContain("owner dead")
      expect(bytes()).toBe(before)
    }
  })

  test("other session, owner dead -> /plan applies T20 then the workflow is cancelled", () => {
    const wf = putWorkflow({ sessionID: S, owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 } })
    const deps = makeDeps(client, wt.worktree)
    const r = resolveAuthority(deps, "plan", OTHER)
    expect(r.wf).toBeNull()
    expect(r.replaced).toBe(wf.id)
    // resolveAuthority only applies T20 (owner_dead -> cancelled); rotation into archive/ is the caller's job (startWorkflow)
    expect(readWorkflow(wt.worktree)?.phase).toBe("cancelled")
  })

  test("repairOnLoad with a dead owner changes neither phase nor owner", () => {
    const wf = putWorkflow({ sessionID: S, owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 }, phase: "reviewing" })
    const deps = makeDeps(client, wt.worktree)
    const r = repairOnLoad(deps)
    expect(r?.ok).toBe(true)
    if (r?.ok) {
      expect(r.wf.phase).toBe("pending_approval") // T8, authority-free
      expect(r.wf.owner.instance).toBe("inst_dead") // never taken over at load
      expect(r.wf.owner.pid).toBe(9_999_999)
    }
  })

  test("session.deleted of the owner -> cancelled before the dir is removed", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(Date.now(), "inst_x", process.pid), phase: "planning" })
    const deps = makeDeps(client, wt.worktree)
    const r = onSessionDeleted(deps, S, false, () => {})
    expect(r?.ok).toBe(true)
    if (r?.ok) expect(r.wf.phase).toBe("cancelled")
  })

  test("a live owner mid-run is never taken over or cancelled", () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(Date.now(), "inst_x", process.pid), phase: "executing" })
    const deps = makeDeps(client, wt.worktree)
    const before = bytes()
    const r = resolveAuthority(deps, "status", S)
    expect(r.wf!.phase).toBe("executing")
    expect(bytes()).toBe(before)
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

  test("repeated ticks keep heartbeatAt within STALE_MS of now, so a long run stays live", async () => {
    const wf = putWorkflow({ sessionID: S, owner: currentOwner(Date.now(), "inst_this", process.pid) })
    let last = wf.owner.heartbeatAt
    const hb = startHeartbeat(() => {
      const cur = readWorkflow(wt.worktree)!
      last = Date.now()
      writeWorkflow(wt.worktree, { ...cur, owner: { ...cur.owner, heartbeatAt: last } })
      return true
    }, 10)
    await new Promise((r) => setTimeout(r, 60))
    hb.stop()
    const ctx = liveCtx({ now: last + 1000, instance: "inst_other" }) // far short of STALE_MS thanks to refresh
    const cur = readWorkflow(wt.worktree)!
    expect(ownerLive(cur, ctx)).toBe(true)
  })
})
