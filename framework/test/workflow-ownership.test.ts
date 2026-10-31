// P5a S3 ownership half (SE5, SE6, W9 reattach-keeps-slot, plan S8.2): mutation authority is the persisted sid plus
// the caller's current attachment epoch. PID liveness and heartbeat age never grant or block it. The receipt /
// approval-subject half (E4 receipt shape, W3 subject, R4-R7, R14) is the final describe block; the refusal-before-effects
// matrix through controller.decide lives in host-controller.test.ts ("E4/W3 typed subject receipt").
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { authorize, currentOwner, type LivenessCtx } from "../src/flow/owner.ts"
import { approveWorkflow, reattachOwner, repairOnLoad, resolveAuthority, startWorkflow } from "../src/flow/runtime.ts"
import { newWorkflow, readEvents, readHeartbeat, readWorkflow, renderArtifact, withFlowTransaction, writeHeartbeat, writePlanJson, type Workflow } from "../src/flow/state.ts"
import { canonicalPlanSha, planMdPath, planToTasks, renderPlanMd, type Plan } from "../src/flow/plan.ts"
import { addTasks, readLedger, writeLedger } from "../src/state/ledger.ts"
import { assertUnitCurrent, planSubject, planUnit, sameSubject, subjectSha256, unitTag, type SubjectInput } from "../src/workflows/execution-unit.ts"
import { narrowPlan } from "../src/workflows/registry.ts"
import { attachAdmission, effectiveHold } from "../src/sessions/admission.ts"
import { readSessionCommitted } from "../src/workflows/commit.ts"
import { stateRoot } from "../src/state/store.ts"
import { requestCancel, tempWorktree } from "./guards-helpers.ts"
import { controlTree, openHeldStore, ownerHost, putWorkflow, releasedWithHeldStore, releaseWorkflow, stableTree } from "./ownership-fixture.ts"

const A = "ses_own_a"
const B = "ses_own_b"
const EPOCH_A1 = "11111111-1111-4111-8111-111111111111"
const EPOCH_A2 = "22222222-2222-4222-8222-222222222222"
let wt: ReturnType<typeof tempWorktree>

beforeEach(() => { wt = tempWorktree() })
afterEach(() => wt.cleanup())

const ctx = (patch: Partial<LivenessCtx> = {}): LivenessCtx => ({
  now: 10_000, instance: EPOCH_A1, pidAlive: () => true, epochReleased: () => false, heartbeatAt: () => 10_000, ...patch,
})
const MUTATIONS = ["plan", "approve", "reject", "cancel"] as const

function wfFor(sid: string, epoch: string, pid = 1234): Workflow {
  return putWorkflow(wt.worktree, sid, currentOwner(1000, epoch, pid))
}

describe("authorize: persisted sid + current epoch", () => {
  test("the owning sid on its current epoch is allowed for every command regardless of PID or heartbeat", () => {
    const wf = wfFor(A, EPOCH_A1)
    for (const probe of [ctx(), ctx({ pidAlive: () => false }), ctx({ heartbeatAt: () => 0, now: 10_000_000 }), ctx({ epochReleased: () => true })]) {
      for (const cmd of ["status", ...MUTATIONS] as const) expect(authorize(cmd, A, wf, probe).kind).toBe("allow")
    }
  })

  test("same sid, different epoch is refused for mutation even with a live old PID and a fresh heartbeat; status still works", () => {
    const wf = wfFor(A, EPOCH_A1)
    const other = ctx({ instance: EPOCH_A2, pidAlive: () => true, heartbeatAt: () => 10_000 })
    expect(authorize("status", A, wf, other).kind).toBe("allow")
    for (const cmd of MUTATIONS) {
      const result = authorize(cmd, A, wf, other)
      expect(result.kind).toBe("refuse")
      if (result.kind === "refuse") expect(result.text).toContain(`/resume ${A}`)
    }
  })

  test("a released old epoch with a live old PID is not 'active': the refusal names ownership, and it still needs S6.2a", () => {
    const wf = wfFor(A, EPOCH_A1)
    const result = authorize("cancel", A, wf, ctx({ instance: EPOCH_A2, epochReleased: () => true }))
    expect(result.kind).toBe("refuse")
    if (result.kind === "refuse") {
      expect(result.text).toContain(`owned by session ${A}`)
      expect(result.text).not.toContain("already active")
    }
  })

  test("a foreign sid never mutates, whether the owner is live, dead, released or on the same epoch string", () => {
    const wf = wfFor(A, EPOCH_A1)
    for (const probe of [ctx(), ctx({ pidAlive: () => false }), ctx({ epochReleased: () => true }), ctx({ heartbeatAt: () => 0, now: 10_000_000 })]) {
      expect(authorize("status", B, wf, probe).kind).toBe("allow")
      for (const cmd of MUTATIONS) expect(authorize(cmd, B, wf, probe).kind).toBe("refuse")
    }
  })

  test("no workflow -> none", () => {
    for (const cmd of ["status", ...MUTATIONS] as const) expect(authorize(cmd, A, null, ctx()).kind).toBe("none")
  })
})

describe("SE5 resolveAuthority and reattach against real attachments", () => {
  test("a reattached held epoch refuses mutation until explicit Resume; status stays read-only and byte-identical", () => {
    const host = ownerHost(wt.worktree)
    const wf = releaseWorkflow(wt.worktree, host, A, { phase: "planning" })
    const store = attachAdmission(host, A, { engine: "opencode" })
    const rebound = readWorkflow(wt.worktree)!
    expect(rebound.owner.instance).toBe(store.epoch)
    const before = stableTree(wt.worktree)
    const status = resolveAuthority(host, "status", A, "opencode")
    expect(status.refuse).toBeUndefined()
    expect(status.wf?.id).toBe(wf.id)
    for (const cmd of MUTATIONS) expect(resolveAuthority(host, cmd, A, "opencode").refuse).toContain(`/resume ${A}`)
    expect(stableTree(wt.worktree)).toEqual(before)
    expect(effectiveHold(wt.worktree, A)).toBe(true)
  })

  test("a live unreleased old epoch cannot be reattached by the same sid and nothing is mutated", () => {
    const host = ownerHost(wt.worktree)
    const old = attachAdmission(host, A, { engine: "opencode" })
    const wf = putWorkflow(wt.worktree, A, currentOwner(Date.now(), old.epoch))
    withFlowTransaction(wt.worktree, tx => writeHeartbeat(tx, wf, Date.now()))
    // a second attachment of the same sid in this process is refused outright; the old epoch is still live
    expect(() => openHeldStore(wt.worktree, A)).toThrow()
    const before = controlTree(wt.worktree)
    const result = reattachOwner(host, old, wf.id, wf.lastSeq)
    expect("refuse" in result).toBe(true)
    expect(controlTree(wt.worktree)).toEqual(before)
  })

  test("a foreign sid cannot take over a dead or released owner's workflow through resolveAuthority or start", () => {
    const host = ownerHost(wt.worktree)
    const wf = releaseWorkflow(wt.worktree, host, A, { phase: "planning" })
    const before = controlTree(wt.worktree)
    for (const cmd of MUTATIONS) {
      const result = resolveAuthority(host, cmd, B, "opencode")
      expect(result.refuse).toBeUndefined()
      expect(result.wf).toBeNull()
    }
    const start = startWorkflow(host, B, "command", "steal", "user_command", "opencode")
    expect(start.ok).toBe(false)
    if (!start.ok) expect(start.text).toContain(`session ${B} has no live admission`)
    expect(controlTree(wt.worktree)).toEqual(before)
    expect(readWorkflow(wt.worktree)?.id).toBe(wf.id)
  })
})

describe("W9 reattach keeps the same id and slot", () => {
  test("the reattached workflow keeps its id; an unadmitted sid cannot start and the heartbeat is untouched", () => {
    const host = ownerHost(wt.worktree)
    const { wf, store } = releasedWithHeldStore(wt.worktree, host, A, { phase: "planning" })
    const heartbeatBefore = readHeartbeat(wt.worktree, wf)
    const result = reattachOwner(host, store, wf.id, wf.lastSeq)
    if ("refuse" in result) throw new Error(result.refuse)
    expect(result.wf.id).toBe(wf.id)
    expect(readWorkflow(wt.worktree)?.id).toBe(wf.id)
    const start = startWorkflow(host, B, "command", "other", "user_command", "opencode")
    expect(start.ok).toBe(false)
    if (!start.ok) expect(start.text).toContain(`session ${B} has no live admission`)
    expect(readHeartbeat(wt.worktree, wf)).toBe(heartbeatBefore)
  })
})

describe("SE6 restore follows its own sid-bound workflow", () => {
  test("each session retains its own current index and never adopts the other workflow", () => {
    const host = ownerHost(wt.worktree)
    attachAdmission(host, A, { engine: "opencode" })
    const first = startWorkflow(host, A, "command", "a work", "user_command", "opencode")
    if (!first.ok) throw new Error(first.text)
    expect(readSessionCommitted(wt.worktree, B)).toBeNull()
    const cancelled = requestCancel(host, first.wf).result
    if (!cancelled.ok) throw new Error(cancelled.text)
    attachAdmission(host, B, { engine: "opencode" })
    const second = startWorkflow(host, B, "command", "b work", "user_command", "opencode")
    if (!second.ok) throw new Error(second.text)

    const mine = readSessionCommitted(wt.worktree, A)
    expect(mine).toMatchObject({ current: true, wf: { id: first.wf.id, sessionID: A, phase: "cancelled" } })
    expect(mine?.path).toContain(`sessions/${A}/workflows/${first.wf.id}/revisions/`)
    expect(mine?.wf.id).not.toBe(second.wf.id)
    expect(readSessionCommitted(wt.worktree, B)).toMatchObject({ current: true, wf: { id: second.wf.id } })
  })

  test("a foreign current workflow with no retained history for A yields null for A", () => {
    const host = ownerHost(wt.worktree)
    attachAdmission(host, B, { engine: "opencode" })
    const second = startWorkflow(host, B, "command", "b work", "user_command", "opencode")
    if (!second.ok) throw new Error(second.text)
    expect(readSessionCommitted(wt.worktree, A)).toBeNull()
  })
})

// ---------------------------------------------------------------- approval subject half (E4, W3, R4-R7, R14)
const RECEIPT_PLAN: Plan = {
  goal: "subject goal", revision: 1, risks: ["r"],
  steps: [1, 2, 3].map(n => ({ title: `step ${n}`, files: [`f${n}.py`], detail: `do ${n}`, verify: "sh check.sh" })),
}

function pendingPlanWorkflow(host: ReturnType<typeof ownerHost>, sid: string): Workflow {
  const store = attachAdmission(host, sid, { engine: "opencode" })
  mkdirSync(wt.worktree, { recursive: true })
  writeFileSync(join(wt.worktree, "check.sh"), "true\n")
  const id = "wf_subject"
  const mdPath = planMdPath(id)
  const mdSha = withFlowTransaction(wt.worktree, tx => {
    writePlanJson(tx, id, RECEIPT_PLAN)
    return renderArtifact(tx, mdPath, renderPlanMd(id, RECEIPT_PLAN))
  })
  return putWorkflow(wt.worktree, sid, currentOwner(Date.now(), store.epoch), {
    id, phase: "pending_approval", stage: "decision",
    planRef: { jsonSha: canonicalPlanSha(RECEIPT_PLAN), mdPath, mdSha, revision: 1 },
  })
}

describe("subject hashing (R4): every canonical field participates, so an edit invalidates approval", () => {
  const base: SubjectInput = {
    kind: "implementation-unit", id: "unit-1", scope: ["src/a.ts"], commands: ["bun test"], inputs: ["spec.md"],
    allowedPaths: ["src/a.ts", "test/a.test.ts"], verification: ["bun test test/a.test.ts"], sourceHashes: ["b".repeat(64), "a".repeat(64)], artifactHashes: ["c".repeat(64)],
  }
  test("each field changes the hash; set-like fields ignore order, list-like fields keep it", () => {
    const hash = subjectSha256(base)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(subjectSha256({ ...base })).toBe(hash)
    const edits: Array<Partial<SubjectInput>> = [
      { kind: "experiment-unit" }, { id: "unit-2" }, { scope: ["src/b.ts"] }, { commands: ["bun run x"] }, { inputs: ["other.md"] },
      { allowedPaths: ["src/a.ts"] }, { verification: ["true"] }, { sourceHashes: ["d".repeat(64)] }, { artifactHashes: ["e".repeat(64)] },
    ]
    for (const edit of edits) expect(subjectSha256({ ...base, ...edit })).not.toBe(hash)
    expect(subjectSha256({ ...base, allowedPaths: [...base.allowedPaths].reverse(), sourceHashes: [...base.sourceHashes].reverse() })).toBe(hash)
    expect(subjectSha256({ ...base, commands: ["bun test", "extra"] })).not.toBe(subjectSha256({ ...base, commands: ["extra", "bun test"] }))
  })

  test("the plan subject is the canonical plan hash under the plan kind", () => {
    const wf = { id: "wf_x", planRef: { jsonSha: "f".repeat(64), mdPath: "p.md", mdSha: "e".repeat(64), revision: 1 } }
    expect(planSubject(wf)).toEqual({ kind: "plan", id: "wf_x", sha256: "f".repeat(64) })
    expect(planSubject({ id: "wf_x" })).toBeNull()
    expect(sameSubject(planSubject(wf), { kind: "plan", id: "wf_x", sha256: "f".repeat(64) })).toBe(true)
    expect(sameSubject(planSubject(wf), { kind: "implementation-unit", id: "wf_x", sha256: "f".repeat(64) })).toBe(false)
    expect(sameSubject(null, null)).toBe(false)
  })
})

describe("approval stores the subject; the unit tags tasks with parent wid + subject hash (R5-R7, R14)", () => {
  test("approveWorkflow stores approval.subject and receiptRevision, and only the parent wid appears on tasks", () => {
    const host = ownerHost(wt.worktree)
    const wf = pendingPlanWorkflow(host, A)
    const sha = canonicalPlanSha(RECEIPT_PLAN)
    const revisionsBefore = readdirSync(join(stateRoot(wt.worktree), "sessions", A, "workflows", wf.id, "revisions")).length
    const result = approveWorkflow(host, wf, planToTasks(RECEIPT_PLAN), {
      queueRunning: false, planShaOk: true, mdShaOk: true, subject: { kind: "plan", id: wf.id, sha256: sha }, receiptRevision: wf.lastSeq,
    })
    if (!result.ok) throw new Error(result.text)
    const revisionsDir = join(stateRoot(wt.worktree), "sessions", A, "workflows", wf.id, "revisions")
    expect(readdirSync(revisionsDir).length).toBe(revisionsBefore + 1)
    expect(readEvents(wt.worktree, wf.id).filter(event => event.seq > wf.lastSeq).map(event => event.type)).toContain("tasks_created")
    expect(result.wf.lastSeq).toBe(readEvents(wt.worktree, wf.id).at(-1)!.seq)
    expect(result.wf.approval).toMatchObject({ by: "user_command", receiptRevision: wf.lastSeq, subject: { kind: "plan", id: wf.id, sha256: sha } })
    const tasks = readLedger(wt.worktree, A).tasks
    expect(tasks).toHaveLength(3)
    for (const task of tasks) expect(task.wf).toEqual({ id: wf.id, planSha: sha })
    expect(readEvents(wt.worktree, wf.id).find(event => event.type === "transition" && (event.data as { event?: string })?.event === "approve")?.data)
      .toMatchObject({ subject: { kind: "plan", id: wf.id, sha256: sha } })

    const unit = planUnit(narrowPlan(result.wf), { worktree: wt.worktree, tasks })
    expect(unit).toMatchObject({ parentWorkflowID: wf.id, sessionID: A, subject: { kind: "plan", id: wf.id, sha256: sha }, taskIds: result.wf.taskIds })
    expect(unitTag(unit)).toEqual({ id: wf.id, planSha: sha })
    assertUnitCurrent(unit, narrowPlan(result.wf))
  })

  test("approval refuses a different subject or a stale receipt revision before any ledger or index write", () => {
    const host = ownerHost(wt.worktree)
    const wf = pendingPlanWorkflow(host, A)
    const sha = canonicalPlanSha(RECEIPT_PLAN)
    const before = controlTree(wt.worktree)
    const wrong = approveWorkflow(host, wf, planToTasks(RECEIPT_PLAN), {
      queueRunning: false, planShaOk: true, mdShaOk: true, subject: { kind: "plan", id: wf.id, sha256: "0".repeat(64) }, receiptRevision: wf.lastSeq,
    })
    const stale = approveWorkflow(host, wf, planToTasks(RECEIPT_PLAN), {
      queueRunning: false, planShaOk: true, mdShaOk: true, subject: { kind: "plan", id: wf.id, sha256: sha }, receiptRevision: wf.lastSeq + 1,
    })
    expect(wrong.ok).toBe(false)
    expect(stale.ok).toBe(false)
    expect(controlTree(wt.worktree)).toEqual(before)
  })

  test("planUnit refuses a plan whose approval subject no longer names the current plan, or whose rendered file was edited", () => {
    const host = ownerHost(wt.worktree)
    const wf = pendingPlanWorkflow(host, A)
    const sha = canonicalPlanSha(RECEIPT_PLAN)
    const approved = approveWorkflow(host, wf, planToTasks(RECEIPT_PLAN), {
      queueRunning: false, planShaOk: true, mdShaOk: true, subject: { kind: "plan", id: wf.id, sha256: sha }, receiptRevision: wf.lastSeq,
    })
    if (!approved.ok) throw new Error(approved.text)
    const executing = narrowPlan(approved.wf)
    expect(() => planUnit({ ...executing, approval: { ...executing.approval!, subject: { kind: "plan", id: wf.id, sha256: "1".repeat(64) } } }, { worktree: wt.worktree }))
      .toThrow("approved plan or rendered file changed")
    expect(() => planUnit({ ...executing, phase: "pending_approval" }, { worktree: wt.worktree })).toThrow("not executing")
    const unit = planUnit(executing, { worktree: wt.worktree })
    expect(() => assertUnitCurrent(unit, { ...executing, planRef: { ...executing.planRef!, jsonSha: "2".repeat(64) } })).toThrow("approved plan changed")
    expect(() => assertUnitCurrent(unit, { ...executing, id: "wf_other" })).toThrow("workflow changed")
    writeFileSync(join(wt.worktree, executing.planRef!.mdPath), "edited after approval")
    expect(() => planUnit(executing, { worktree: wt.worktree })).toThrow("approved plan or rendered file changed")
  })
})

describe("repairOnLoad never turns precommit approval tags into authority (architect finding, R25-adjacent)", () => {
  test("orphan-tagged open tasks under a pending_approval workflow are quarantined and the workflow stays pending", () => {
    const host = ownerHost(wt.worktree)
    const wf = pendingPlanWorkflow(host, A)
    const sha = canonicalPlanSha(RECEIPT_PLAN)
    const tagged = addTasks(readLedger(wt.worktree, A), planToTasks(RECEIPT_PLAN), Date.now(), { id: wf.id, planSha: sha })
    writeLedger(wt.worktree, tagged.ledger)
    const indexBefore = readWorkflow(wt.worktree)!

    const repaired = repairOnLoad(host, "opencode")
    expect(repaired?.ok).toBe(true)
    const after = readWorkflow(wt.worktree)!
    expect(after).toEqual(indexBefore)
    expect(after.phase).toBe("pending_approval")
    expect(after.approval).toBeUndefined()
    expect(readLedger(wt.worktree, A).tasks.every(task => task.status === "cancelled" && task.wf === undefined)).toBe(true)
    expect(readEvents(wt.worktree, wf.id).some(event => event.type === "approval_precommit_quarantined")).toBe(true)
    expect(repairOnLoad(host, "opencode")).toBeNull()
  })
})
