// P5a S3: S6.2a same-SID held owner reattachment on the generic commit protocol.
// Covers V-reattach-1..7 (revision-3 deterministic reattach tests) with injected clock/process identity
// (ReattachOptions.now / .inspect), the commit fault seam, and barrier-controlled competing writers (a competing
// attempt is launched from inside the commit, so ordering never depends on sleeps).
//
// Mapping to the plan's P3 test names (session-reattach.test.ts does not exist; this file carries it):
//   V-reattach-1 -> "same-process switch-back"          V-reattach-5 -> "concurrent"
//   V-reattach-2 -> "released epoch vs live PID"        V-reattach-6 -> "commit faults" (+ session-admission-crash
//   V-reattach-3 -> "crash/stale lock"                                    for release/hold-file crash boundaries)
//   V-reattach-4 -> "foreign sid"                       V-reattach-7 -> "explicit Resume separation"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { currentOwner } from "../src/flow/owner.ts"
import { applyEvent, OWNER_REATTACHED, reattachOwner, requestStop, settleOwned } from "../src/flow/runtime.ts"
import { resumePaused } from "../src/flow/resume.ts"
import { addTasks, emptyLedger, readLedger, writeLedger } from "../src/state/ledger.ts"
import { existsSync } from "node:fs"
import { readAllEventLines, readEvents, readWorkflow, withFlowTransaction, workflowPath, writeHeartbeat, type Workflow } from "../src/flow/state.ts"
import { beginExecutionActivity } from "../src/hosts/runtime.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { admissionEpoch, attachAdmission, effectiveHold, isAdmissionCurrent, resumeAdmission } from "../src/sessions/admission.ts"
import { inspectSessionAttachment, openSession, readSessionMetadata } from "../src/sessions/store.ts"
import { stateRoot } from "../src/state/store.ts"
import { __setCommitFaultHook, readCommitted, readSessionCommitted, sha256Hex, type CommitStage } from "../src/workflows/commit.ts"
import { committedSnapshot, rewriteCommitted } from "./commit-fixture.ts"
import { tempWorktree } from "./guards-helpers.ts"
import { holdAdmission } from "../src/sessions/admission.ts"
import { controlTree, openHeldStore, ownerHost, putWorkflow, releasedWithHeldStore, releaseWorkflow, stableTree } from "./ownership-fixture.ts"

const S = "ses_reattach"
const OTHER = "ses_reattach_foreign"
let wt: ReturnType<typeof tempWorktree>

beforeEach(() => { wt = tempWorktree() })
afterEach(() => {
  __setCommitFaultHook(null)
  wt.cleanup()
})

const RICH: Partial<Workflow> = {
  phase: "pending_approval",
  stage: "decision",
  planRef: { jsonSha: "a".repeat(64), mdPath: ".otter/plans/plan.md", mdSha: "b".repeat(64), revision: 3 },
  review: { verdict: "okay", findings: ["note"], planSha: "a".repeat(64) },
  approval: { by: "user_command", subject: { kind: "plan", id: "wf_fault", sha256: "a".repeat(64) }, receiptRevision: 0, at: 1_700_000_000_000 },
  taskIds: ["task-a", "task-b"],
  counters: { code_invalid: 2, review_iterations: 1, user_rejections: 3, nudges: 1 },
  artifacts: [{ key: "plan", path: ".otter/plans/plan.md", sha256: "b".repeat(64) }],
}

function reattachEvents(workflowID: string) {
  return readEvents(wt.worktree, workflowID).filter(event => event.type === OWNER_REATTACHED)
}

function indexRevision(): number {
  const read = readCommitted(wt.worktree)
  if (read.state !== "ok") throw new Error(`index is ${read.state}`)
  return read.index.revision
}

/** A real attachment in another process that has since exited: an exact-dead identity with its receipt on disk. */
function deadAttachmentEpoch(sid: string): { epoch: string; pid: number } {
  const moduleURL = new URL("../src/sessions/store.ts", import.meta.url).href
  const source = `import(${JSON.stringify(moduleURL)}).then(({ openSession }) => {
    const store = openSession(${JSON.stringify(wt.worktree)}, ${JSON.stringify(sid)}, { engine: "opencode" });
    console.log(store.epoch);
  });`
  const child = spawnSync(process.execPath, ["-e", source], { cwd: wt.worktree, encoding: "utf8", env: process.env })
  expect(child.status).toBe(0)
  const pid = child.pid
  if (typeof pid !== "number") throw new Error("child pid unavailable")
  return { epoch: child.stdout.trim(), pid }
}

describe("V-reattach-1 same-process switch-back", () => {
  test("exactly one committed owner_reattached with the full tuple; only owner and lastSeq change; hold retained; zero dispatch", () => {
    const host = ownerHost(wt.worktree)
    const { wf, store } = releasedWithHeldStore(wt.worktree, host, S, RICH)
    const before = committedSnapshot(wt.worktree)
    const NOW = 1_800_000_000_000

    const result = reattachOwner(host, store, wf.id, wf.lastSeq, { now: NOW })
    if ("refuse" in result) throw new Error(result.refuse)

    const rows = reattachEvents(wf.id)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    const data = row.data as Record<string, any>
    const index = readCommitted(wt.worktree)
    if (index.state !== "ok") throw new Error("index not ok")
    expect(data).toMatchObject({
      sid: S, wid: wf.id, fromEpoch: before.owner.instance, toEpoch: store.epoch,
      expectedRevision: wf.lastSeq, newRevision: index.index.revision, proofKind: "released",
    })
    expect(row.seq).toBe(index.index.revision)
    expect(result.wf.lastSeq).toBe(index.index.revision)
    expect(row.at).toBe(NOW)
    // proofRef resolves to the old epoch's released attachment receipt with a matching hash
    expect(data.proofRef.path).toBe(`sessions/${S}/attachments/${before.owner.instance}.json`)
    const proof = readFileSync(join(stateRoot(wt.worktree), data.proofRef.path))
    expect(data.proofRef.sha256).toBe(sha256Hex(proof))
    expect(JSON.parse(proof.toString("utf8"))).toMatchObject({ state: "released", workflowID: wf.id, revision: wf.lastSeq })

    // snapshot diff against the previous committed revision is only owner, lastSeq (and the commit timestamp)
    const after = committedSnapshot(wt.worktree)
    const { owner: _o, lastSeq: _l, updatedAt: _u, ...beforeRest } = before
    const { owner: _o2, lastSeq: _l2, updatedAt: _u2, ...afterRest } = after
    expect(afterRest).toEqual(beforeRest)
    expect(after.owner).toEqual({ instance: store.epoch, pid: process.pid })
    expect(after.phase).toBe("pending_approval")
    expect(after.stage).toBe("decision")
    expect(after.approval).toEqual(before.approval)
    expect(after.stopIntent).toBe(before.stopIntent)
    expect(after.artifacts).toEqual(before.artifacts)
    expect(after.taskIds).toEqual(before.taskIds)

    // held, no grants, no starts
    expect(store.metadata.held).toBe(true)
    expect(readSessionMetadata(wt.worktree, S)?.held).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(host.runs.status().claim).toBeUndefined()
    expect(host.testCalls).toHaveLength(0)
    // old-epoch callbacks are fenced
    expect(isAdmissionCurrent(wt.worktree, S, before.owner.instance)).toBe(false)
    // restore reads the same committed revision path+hash for its own sid
    const restored = readSessionCommitted(wt.worktree, S)
    expect(restored).toMatchObject({ current: true, wf: { id: wf.id, lastSeq: index.index.revision } })
    expect(restored?.sha256).toBe(index.index.sha256)
  })

  test("the audit constant is the single name used for emit and lookup: a legacy owner_rebound row is not reattach proof", () => {
    const host = ownerHost(wt.worktree)
    const { wf, store } = releasedWithHeldStore(wt.worktree, host, S)
    expect(OWNER_REATTACHED).toBe("owner_reattached")
    const result = reattachOwner(host, store, wf.id, wf.lastSeq)
    if ("refuse" in result) throw new Error(result.refuse)
    expect(readEvents(wt.worktree, wf.id).some(event => event.type === "owner_rebound")).toBe(false)
    const repeated = reattachOwner(host, store, wf.id, wf.lastSeq)
    if ("refuse" in repeated) throw new Error(repeated.refuse)
    expect(repeated.wf).toEqual(result.wf)
    expect(reattachEvents(wf.id)).toHaveLength(1)
  })

  test("reattach never writes a heartbeat", () => {
    const host = ownerHost(wt.worktree)
    const { wf, store } = releasedWithHeldStore(wt.worktree, host, S)
    const heartbeat = join(stateRoot(wt.worktree), "workflow", "heartbeat.json")
    const before = controlTree(wt.worktree)[heartbeat]
    const result = reattachOwner(host, store, wf.id, wf.lastSeq)
    if ("refuse" in result) throw new Error(result.refuse)
    expect(controlTree(wt.worktree)[heartbeat]).toBe(before)
  })
})

describe("V-reattach-2 released epoch vs live PID", () => {
  test("a released old epoch with a live PID and a fresh heartbeat reattaches while held", () => {
    const host = ownerHost(wt.worktree)
    const { wf, store } = releasedWithHeldStore(wt.worktree, host, S)
    withFlowTransaction(wt.worktree, tx => writeHeartbeat(tx, wf, Date.now()))
    const result = reattachOwner(host, store, wf.id, wf.lastSeq)
    if ("refuse" in result) throw new Error(result.refuse)
    expect(result.wf.owner.instance).toBe(store.epoch)
    expect(reattachEvents(wf.id)).toHaveLength(1)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("the same fixture without a release receipt (old epoch live and unreleased) refuses with zero mutation", () => {
    const host = ownerHost(wt.worktree)
    const { wf, store } = releasedWithHeldStore(wt.worktree, host, S)
    withFlowTransaction(wt.worktree, tx => writeHeartbeat(tx, wf, Date.now()))
    const before = controlTree(wt.worktree)
    const result = reattachOwner(host, store, wf.id, wf.lastSeq, {
      inspect: (worktree, sid, epoch) => {
        const real = inspectSessionAttachment(worktree, sid, epoch)
        if (!real || real.state !== "released") return real
        // the old epoch never released: its attachment is attached to a live process (this one)
        return { state: "attached", epoch, sessionID: sid, worktree: real.worktree, bootID: "boot", pid: process.pid, processStart: "start", identity: "live" }
      },
    })
    expect("refuse" in result).toBe(true)
    if ("refuse" in result) expect(result.refuse).toContain("live or ambiguous")
    expect(controlTree(wt.worktree)).toEqual(before)
    expect(store.metadata.held).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("unknown old epoch (no lifecycle receipt) refuses without mutation", () => {
    const host = ownerHost(wt.worktree)
    const store = openHeldStore(wt.worktree, S)
    const wf = putWorkflow(wt.worktree, S, currentOwner(Date.now(), "e0c4b83c-3446-46b5-a8d1-986f160e43a1", process.pid))
    const before = controlTree(wt.worktree)
    const result = reattachOwner(host, store, wf.id, wf.lastSeq)
    expect("refuse" in result).toBe(true)
    if ("refuse" in result) expect(result.refuse).toContain("lifecycle proof")
    expect(controlTree(wt.worktree)).toEqual(before)
  })
})

describe("V-reattach-3 crash/stale lock", () => {
  test("an exact-dead old process identity reattaches once with proofKind dead", () => {
    const host = ownerHost(wt.worktree)
    const dead = deadAttachmentEpoch(S)
    const wf = putWorkflow(wt.worktree, S, currentOwner(Date.now(), dead.epoch, dead.pid), { phase: "planning" })
    const store = attachAdmission(host, S, { engine: "opencode" })
    expect(readWorkflow(wt.worktree)?.owner.instance).toBe(store.epoch)
    const rows = reattachEvents(wf.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.data).toMatchObject({ proofKind: "dead", fromEpoch: dead.epoch, toEpoch: store.epoch })
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(host.testCalls).toHaveLength(0)
  })

  const unproven: Array<[string, (epoch: string, pid: number, base: ReturnType<typeof inspectSessionAttachment>) => ReturnType<typeof inspectSessionAttachment>]> = [
    ["unknown liveness", (epoch, pid, base) => ({ ...(base as any), state: "attached", identity: "ambiguous", pid, bootID: "b", processStart: "s" })],
    ["PID reuse (recorded pid differs from the receipt pid)", (epoch, pid, base) => ({ ...(base as any), state: "attached", identity: "dead", pid: pid + 1, bootID: "b", processStart: "s" })],
    ["a live process", (epoch, pid, base) => ({ ...(base as any), state: "attached", identity: "live", pid, bootID: "b", processStart: "s" })],
  ]
  for (const [name, make] of unproven) {
    test(`${name} refuses with no index change`, () => {
      const host = ownerHost(wt.worktree)
      const { wf, store } = releasedWithHeldStore(wt.worktree, host, S)
      const before = controlTree(wt.worktree)
      const result = reattachOwner(host, store, wf.id, wf.lastSeq, {
        inspect: (worktree, sid, epoch) => make(epoch, wf.owner.pid, inspectSessionAttachment(worktree, sid, epoch)),
      })
      expect("refuse" in result).toBe(true)
      expect(controlTree(wt.worktree)).toEqual(before)
    })
  }

  test("reviewer activity, a pre-dispatch claim with an unsettled intent, and a running queue each refuse with no index change", () => {
    const host = ownerHost(wt.worktree)
    const { wf, store } = releasedWithHeldStore(wt.worktree, host, S)
    const before = stableTree(wt.worktree)

    const releaseReview = beginExecutionActivity(host, S, "review")
    expect(releaseReview).toBeTruthy()
    const review = reattachOwner(host, store, wf.id, wf.lastSeq)
    releaseReview!()
    expect("refuse" in review && review.refuse).toContain("reviewer")

    const queue = getQueue(host)
    const isRunning = queue.isRunning
    queue.isRunning = () => true
    let running: ReturnType<typeof reattachOwner>
    try { running = reattachOwner(host, store, wf.id, wf.lastSeq) }
    finally { queue.isRunning = isRunning }
    expect("refuse" in running && running.refuse).toContain("queue")

    const claim = host.runs.claim(S, host.instance, process.pid)
    host.runs.registerIntent(claim, {
      executionId: "reattach-blocked-intent", ownerSession: S, taskId: "task", attemptId: "attempt", generation: claim.generation,
      role: "reviewer", cwd: wt.worktree, policyID: "reattach-test", kind: "host", engine: host.host.identity.engine, profile: "legacy-unowned",
    })
    const intent = reattachOwner(host, store, wf.id, wf.lastSeq)
    expect("refuse" in intent && intent.refuse).toContain("claim")

    for (const path of Object.keys(before)) if (path.includes("workflow") || path.endsWith("events.jsonl")) expect(stableTree(wt.worktree)[path]).toBe(before[path])
    expect(readWorkflow(wt.worktree)?.owner.instance).not.toBe(store.epoch)
    expect(host.testCalls).toHaveLength(0)
  })
})

describe("V-reattach-4 foreign sid", () => {
  test("another session never rebinds the workflow while the owner is released, dead, paused, or held", () => {
    const host = ownerHost(wt.worktree)
    const released = releaseWorkflow(wt.worktree, host, S)
    const foreign = openHeldStore(wt.worktree, OTHER)
    const metadataBefore = readSessionMetadata(wt.worktree, OTHER)
    const before = controlTree(wt.worktree)
    const result = reattachOwner(host, foreign, released.id, released.lastSeq)
    expect("refuse" in result).toBe(true)
    expect(controlTree(wt.worktree)).toEqual(before)
    expect(readSessionMetadata(wt.worktree, OTHER)).toEqual(metadataBefore)

    // dead owner of S
    const dead = deadAttachmentEpoch(S)
    const deadWf = rewriteCommitted(wt.worktree, { owner: { instance: dead.epoch, pid: dead.pid } })
    const deadBefore = controlTree(wt.worktree)
    const deadResult = reattachOwner(host, foreign, deadWf.id, deadWf.lastSeq)
    expect("refuse" in deadResult).toBe(true)
    expect(controlTree(wt.worktree)).toEqual(deadBefore)

    // paused (non-terminal, slot occupied)
    const paused = rewriteCommitted(wt.worktree, { phase: "paused", stage: "draft" })
    const pausedBefore = controlTree(wt.worktree)
    const pausedResult = reattachOwner(host, foreign, paused.id, paused.lastSeq)
    expect("refuse" in pausedResult).toBe(true)
    expect(controlTree(wt.worktree)).toEqual(pausedBefore)
    expect(reattachEvents(paused.id)).toHaveLength(0)
    expect(readWorkflow(wt.worktree)?.sessionID).toBe(S)
  })
})

describe("V-reattach-5 concurrent", () => {
  test("a competing attempt launched at the commit barrier cannot double-commit; exactly one audit row and one index revision", () => {
    const host = ownerHost(wt.worktree)
    const { wf, store } = releasedWithHeldStore(wt.worktree, host, S)
    const startRevision = indexRevision()
    let competitor: ReturnType<typeof reattachOwner> | undefined
    let secondAttach: unknown
    __setCommitFaultHook(stage => {
      if (stage !== "events-fsync") return
      // barrier: the first writer is inside its commit holding the flow lock and the attach lock
      competitor = reattachOwner(host, store, wf.id, wf.lastSeq)
      try { openSession(wt.worktree, S, { engine: "opencode" }); secondAttach = "acquired" } catch (error) { secondAttach = error }
    })
    const first = reattachOwner(host, store, wf.id, wf.lastSeq)
    __setCommitFaultHook(null)
    if ("refuse" in first) throw new Error(first.refuse)
    expect(competitor && "refuse" in competitor).toBe(true)
    expect(secondAttach).toBeInstanceOf(Error)
    expect(reattachEvents(wf.id)).toHaveLength(1)
    expect(indexRevision()).toBeGreaterThan(startRevision)
    expect(indexRevision()).toBe(first.wf.lastSeq)
    expect(readAllEventLines(wt.worktree).filter(line => line.type === OWNER_REATTACHED)).toHaveLength(1)
  })

  test("an old-epoch callback holding the pre-reattach snapshot cannot mutate after the commit (CAS on epoch + lastSeq)", () => {
    const host = ownerHost(wt.worktree)
    const { wf, store } = releasedWithHeldStore(wt.worktree, host, S)
    const stale = committedSnapshot(wt.worktree)
    const result = reattachOwner(host, store, wf.id, wf.lastSeq)
    if ("refuse" in result) throw new Error(result.refuse)
    const before = controlTree(wt.worktree)
    const callback = applyEvent(host, stale, "user_message", "user_message")
    expect(callback.ok).toBe(false)
    expect(controlTree(wt.worktree)).toEqual(before)
    expect(readWorkflow(wt.worktree)?.owner.instance).toBe(store.epoch)
    // the old tuple against the new owner is a differing expectedRevision: fresh validation required
    const mismatched = reattachOwner(host, store, wf.id, wf.lastSeq - 1)
    expect("refuse" in mismatched).toBe(true)
    expect(controlTree(wt.worktree)).toEqual(before)
  })
})

const FAULT_STAGES: CommitStage[] = [
  "events-fsync", "snapshot-write", "snapshot-fsync", "snapshot-rename", "snapshot-dirfsync",
  "index-write", "index-fsync", "index-rename", "index-dirfsync",
]

describe("V-reattach-6 commit faults", () => {
  for (const stage of FAULT_STAGES) {
    test(`a fault at ${stage} leaves the old or the new coherent revision, held, and retry is exact-once`, () => {
      const host = ownerHost(wt.worktree)
      const { wf, store } = releasedWithHeldStore(wt.worktree, host, S)
      const oldEpoch = committedSnapshot(wt.worktree).owner.instance
      const oldIndex = readFileSync(workflowPath(wt.worktree))
      __setCommitFaultHook(at => { if (at === stage) throw new Error(`injected ${at}`) })
      let faulted: ReturnType<typeof reattachOwner>
      try { faulted = reattachOwner(host, store, wf.id, wf.lastSeq) }
      finally { __setCommitFaultHook(null) }
      expect("refuse" in faulted).toBe(true)

      // restart simulation: nothing in memory is trusted; a fresh read sees one coherent revision
      const read = readCommitted(wt.worktree)
      expect(read.state).toBe("ok")
      if (read.state !== "ok") return
      expect(sha256Hex(read.bytes)).toBe(read.index.sha256)
      const published = !readFileSync(workflowPath(wt.worktree)).equals(oldIndex)
      expect(published).toBe(stage === "index-dirfsync")
      expect(read.wf.owner.instance).toBe(published ? store.epoch : oldEpoch)
      expect(effectiveHold(wt.worktree, S)).toBe(true)
      expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
      expect(store.metadata.held).toBe(true)
      expect(host.testCalls).toHaveLength(0)
      expect(reattachEvents(wf.id)).toHaveLength(published ? 1 : 0)

      // retrying the exact tuple: observational if committed, a single commit otherwise
      const retry = reattachOwner(host, store, wf.id, wf.lastSeq)
      if ("refuse" in retry) throw new Error(retry.refuse)
      expect(retry.wf.owner.instance).toBe(store.epoch)
      expect(reattachEvents(wf.id)).toHaveLength(1)
      const settledIndex = readFileSync(workflowPath(wt.worktree))
      const again = reattachOwner(host, store, wf.id, wf.lastSeq)
      if ("refuse" in again) throw new Error(again.refuse)
      expect(readFileSync(workflowPath(wt.worktree))).toEqual(settledIndex)
      expect(reattachEvents(wf.id)).toHaveLength(1)

      // a mismatched expectedRevision requires fresh validation and refuses
      const mismatched = reattachOwner(host, store, wf.id, wf.lastSeq + 1)
      expect("refuse" in mismatched).toBe(true)
      expect(readFileSync(workflowPath(wt.worktree))).toEqual(settledIndex)
    })
  }

  test("a snapshot file already holding other bytes at the next revision refuses the reattach and preserves it", () => {
    const host = ownerHost(wt.worktree)
    const { wf, store } = releasedWithHeldStore(wt.worktree, host, S)
    const before = committedSnapshot(wt.worktree)
    const next = (readAllEventLines(wt.worktree).at(-1)?.seq ?? 0) + 1
    const target = join(stateRoot(wt.worktree), `sessions/${S}/workflows/${wf.id}/revisions/${next}.json`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, "foreign")
    const result = reattachOwner(host, store, wf.id, wf.lastSeq)
    expect("refuse" in result).toBe(true)
    expect(readFileSync(target, "utf8")).toBe("foreign")
    expect(committedSnapshot(wt.worktree)).toEqual(before)
  })
})

describe("V-reattach-7 explicit Resume separation", () => {
  function reattached(patch: Partial<Workflow> = {}) {
    const host = ownerHost(wt.worktree)
    const wf = releaseWorkflow(wt.worktree, host, S, { phase: "planning", ...patch })
    const store = attachAdmission(host, S, { engine: "opencode" })
    const current = readWorkflow(wt.worktree)!
    expect(current.owner.instance).toBe(store.epoch)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    return { host, wf, store, current }
  }

  test("a stale expected revision (including a receipt minted before the reattach) leaves zero starts and no token", () => {
    const { host, wf, store, current } = reattached()
    expect(() => resumeAdmission(host, S, wf.lastSeq)).toThrow("revision")
    expect(() => resumeAdmission(host, S, current.lastSeq + 1)).toThrow("revision")
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(store.metadata.held).toBe(true)
    expect(host.testCalls).toHaveLength(0)
  })

  test("a cancel intent or a terminal workflow after the reattach cannot be resumed", () => {
    const { host, current } = reattached()
    rewriteCommitted(wt.worktree, { stopIntent: { kind: "cancel", token: "t", requestedFrom: { phase: current.phase, stage: current.stage }, checkpoint: null, reason: "cancel" } })
    expect(() => resumeAdmission(host, S, readWorkflow(wt.worktree)!.lastSeq)).toThrow()
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    rewriteCommitted(wt.worktree, { stopIntent: null, phase: "cancelled", stage: "terminal" })
    expect(() => resumeAdmission(host, S, readWorkflow(wt.worktree)?.lastSeq)).toThrow()
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(host.testCalls).toHaveLength(0)
  })

  test("a successful explicit Resume binds a token to the new epoch only; the old epoch stays refused", () => {
    const { host, wf, store, current } = reattached()
    const oldEpoch = wf.owner.instance
    const resumed = resumeAdmission(host, S, current.lastSeq)
    expect(resumed).toBe(store)
    expect(admissionEpoch(wt.worktree, S)).toBe(store.epoch)
    expect(isAdmissionCurrent(wt.worktree, S, store.epoch)).toBe(true)
    expect(isAdmissionCurrent(wt.worktree, S, oldEpoch)).toBe(false)
    expect(readWorkflow(wt.worktree)).toMatchObject({ id: wf.id, phase: "planning", owner: { instance: store.epoch } })
    expect(host.testCalls).toHaveLength(0)
  })

  test("terminal retained history never becomes active work through attach", () => {
    const host = ownerHost(wt.worktree)
    const wf = releaseWorkflow(wt.worktree, host, S, { phase: "done", stage: "terminal" })
    const before = controlTree(wt.worktree)
    const store = attachAdmission(host, S, { engine: "opencode" })
    expect(readWorkflow(wt.worktree)).toMatchObject({ id: wf.id, phase: "done", owner: { instance: wf.owner.instance } })
    expect(reattachEvents(wf.id)).toHaveLength(0)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(store.metadata.held).toBe(true)
    for (const [path, hash] of Object.entries(before)) if (path.includes("workflow") || path.includes("/revisions/")) expect(controlTree(wt.worktree)[path]).toBe(hash)
  })
})


describe("V-reattach-7 / D5 pending and settled stops across a reattach", () => {
  /** Pause (settled or pending) in epoch one, release the attachment held, then attach epoch two (which reattaches). */
  function stoppedThenReattached(kind: "pause" | "cancel", blocked: boolean) {
    const host = ownerHost(wt.worktree)
    const first = attachAdmission(host, S, { engine: "opencode" })
    const wf = putWorkflow(wt.worktree, S, currentOwner(Date.now(), first.epoch), { phase: "planning", stage: "draft" })
    const release = blocked ? beginExecutionActivity(host, S, "stage") : undefined
    const requested = requestStop(host, S, kind, `${kind} test`, { workflowID: wf.id })
    expect(requested.result.ok).toBe(true)
    release?.()
    holdAdmission(wt.worktree, S, "restore")
    const stopped = readWorkflow(wt.worktree)!
    first.release({ workflowQuiescent: true, evidence: "test fixture", workflowID: stopped.id, revision: stopped.lastSeq })
    const second = attachAdmission(host, S, { engine: "opencode" })
    return { host, first, second, before: stopped, after: readWorkflow(wt.worktree)! }
  }

  for (const [kind, blocked] of [["pause", true], ["cancel", true], ["pause", false]] as const) {
    test(`a ${blocked ? "pending" : "settled"} ${kind} reattaches held, keeping its intent, phase and checkpoint, with zero dispatch`, () => {
      const { host, second, before, after } = stoppedThenReattached(kind, blocked)
      expect(after.owner.instance).toBe(second.epoch)
      expect(after.phase).toBe(before.phase)
      expect(after.stopIntent).toEqual(before.stopIntent)
      expect(after.pausedFrom).toEqual(before.pausedFrom)
      expect(effectiveHold(wt.worktree, S)).toBe(true)
      expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
      expect(host.testCalls).toHaveLength(0)
      expect(reattachEvents(after.id)).toHaveLength(1)
    })
  }

  type Mutation = [string, RegExp, (wid: string) => void]
  const MUTATIONS: Mutation[] = [
    ["stop-proof (checkpoint bytes)", /checkpoint/, (wid) => {
      const path = join(stateRoot(wt.worktree), readWorkflow(wt.worktree)!.stopIntent!.checkpoint!.split("#")[0]!)
      writeFileSync(path, readFileSync(path, "utf8").replace('"residual"', '"residual" '))
      void wid
    }],
    ["subject/hash (a plan appears that no saved plan matches)", /subject|approved plan/, () => {
      rewriteCommitted(wt.worktree, current => ({ ...current, planRef: { jsonSha: "a".repeat(64), mdPath: ".otter/plans/none.md", mdSha: "b".repeat(64), revision: 1 }, pausedFrom: { phase: "executing", stage: "unit" } }))
    }],
    ["artifacts (a retained artifact is missing)", /artifact/, () => {
      rewriteCommitted(wt.worktree, current => ({ ...current, artifacts: [{ key: "evidence", path: ".otter/missing-evidence.txt", sha256: "c".repeat(64) }] }))
    }],
    ["unrelated open task", /unrelated|residual/, (wid) => {
      writeLedger(wt.worktree, addTasks(emptyLedger(S), [{ title: "stray" }], Date.now(), { id: `${wid}_other`, planSha: "x" }).ledger)
    }],
  ]
  for (const [name, message, mutate] of MUTATIONS) {
    test(`after a successful reattach, ${name} fails alone: zero starts, still paused and held`, async () => {
      const { host, second, after } = stoppedThenReattached("pause", false)
      expect(after.phase).toBe("paused")
      mutate(after.id)
      const revision = readWorkflow(wt.worktree)!.lastSeq
      const hooks = { preflight: async () => {}, fence: () => "f", choose: async () => true }
      await expect(resumePaused(host, S, revision, hooks)).resolves.toMatchObject({ kind: "refused", reason: expect.stringMatching(message) })
      expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "paused", lastSeq: revision })
      expect(effectiveHold(wt.worktree, S)).toBe(true)
      expect(host.testCalls).toHaveLength(0)
      expect(second.metadata.held).toBe(true)
    })
  }

  test("a clean Resume after the reattach commits one resume and binds a token to the new epoch only; the old ticket fails", async () => {
    const { host, first, second, after } = stoppedThenReattached("pause", false)
    // Real credentials of the released attachment: its epoch, its (released) store and its attachment receipt.
    const oldEpoch = first.epoch
    expect(oldEpoch).not.toBe(second.epoch)
    expect(inspectSessionAttachment(wt.worktree, S, oldEpoch)?.state).toBe("released")
    const outcome = await resumePaused(host, S, after.lastSeq, { preflight: async () => {}, fence: () => "f", choose: async () => true })
    expect(outcome.kind).toBe("resumed")
    const resumed = readWorkflow(wt.worktree)!
    expect(resumed).toMatchObject({ phase: "planning", stage: "draft", stopIntent: null })
    expect(readEvents(wt.worktree, resumed.id).filter(event => event.type === "resumed")).toHaveLength(1)
    expect(admissionEpoch(wt.worktree, S)).toBe(second.epoch)
    expect(isAdmissionCurrent(wt.worktree, S, second.epoch)).toBe(true)
    expect(isAdmissionCurrent(wt.worktree, S, oldEpoch)).toBe(false)
    expect(() => first.assertOwner()).toThrow()
    expect(host.testCalls).toHaveLength(0) // a planning pause resumes its stage and never starts a turn
  })

  test("the reattach receipt is not a Resume, and a stale revision (pre-reattach) is refused", async () => {
    const { host, before } = stoppedThenReattached("pause", false)
    const outcome = await resumePaused(host, S, before.lastSeq, { preflight: async () => {}, fence: () => "f", choose: async () => true })
    expect(outcome).toMatchObject({ kind: "refused", precondition: "owner" })
    expect(readWorkflow(wt.worktree)!.phase).toBe("paused")
  })

  // R3 / D5
  test("a pid mismatch and a dead owner without reattach are refused with byte-identical state", () => {
    const { host, second, after } = stoppedThenReattached("pause", true)
    void after
    // pid mismatch: the committed owner names another process
    const wf = readWorkflow(wt.worktree)!
    rewriteCommitted(wt.worktree, current => ({ ...current, owner: { instance: second.epoch, pid: process.pid + 1 } }))
    const mismatched = controlTree(wt.worktree)
    expect(settleOwned(host, { sessionID: S, epoch: second.epoch }, "pid", { stopOnly: true }).kind).toBe("refused")
    expect(controlTree(wt.worktree)).toEqual(mismatched)
    // dead owner without reattach: the committed owner is a released/dead epoch, not this attachment
    // an owner whose attachment epoch is not the live one and whose process is gone (pid far above any live pid)
    rewriteCommitted(wt.worktree, current => ({ ...current, owner: { instance: "dead-attachment-epoch", pid: 2_147_483_000 } }))
    const deadTree = controlTree(wt.worktree)
    expect(settleOwned(host, { sessionID: S, epoch: second.epoch }, "dead", { stopOnly: true }).kind).toBe("refused")
    expect(controlTree(wt.worktree)).toEqual(deadTree)
    expect(wf.id).toBe(readWorkflow(wt.worktree)!.id)
  })

  test("D5: after a pending pause reattaches held, held safety settlement commits exactly one pause_settled and the session stays held", () => {
    const { host, second, after } = stoppedThenReattached("pause", true)
    expect(after.phase).toBe("planning")
    expect(after.stopIntent?.kind).toBe("pause")
    // the blocker from the old process is gone (it is process-local); the new owner settles under hold, stop events only
    const outcome = settleOwned(host, { sessionID: S, epoch: second.epoch }, "idle", { heldSafety: true, stopOnly: true })
    expect(outcome.kind).toBe("settled")
    const settled = readWorkflow(wt.worktree)!
    expect(settled).toMatchObject({ phase: "paused", stopIntent: { kind: "pause" } })
    expect(readEvents(wt.worktree, settled.id).filter(event => event.type === "pause_settled")).toHaveLength(1)
    expect(readEvents(wt.worktree, settled.id).some(event => event.type === "transition" && ["review_aborted", "settle_ok", "settle_fail"].includes(String((event.data as { event?: string })?.event)))).toBe(false)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(second.metadata.held).toBe(true)
    expect(settleOwned(host, { sessionID: S, epoch: second.epoch }, "again", { heldSafety: true, stopOnly: true }).kind).toBe("none")
    expect(host.testCalls).toHaveLength(0)
  })
})
