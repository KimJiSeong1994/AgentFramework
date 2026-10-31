// P5a S3: S6.2b host session.deleted is a retained session end. Covers V-session-end-1..3 (the plan's P3/P5b
// session-end-retention.test.ts, which did not exist). Retention means committed snapshots, the index target,
// events, plan artifacts and the ledger survive a real hook-shaped session.deleted byte-for-byte.
//   V-session-end-1 -> "settled delete -> restore"   V-session-end-3 -> "duplicate and stale events"
//   V-session-end-2 -> "active/unresolved"           V-session-end-4 -> "deleted SDK handle"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { currentOwner } from "../src/flow/owner.ts"
import { eventsPath, newWorkflow, planJsonPath, readEvents, readWorkflow, withFlowTransaction, workflowPath, type Workflow } from "../src/flow/state.ts"
import { observeStopSettlement, requestStop, startWorkflow } from "../src/flow/runtime.ts"
import { createEventHook } from "../src/hooks/event.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { beginExecutionActivity, beginStageReservation } from "../src/hosts/runtime.ts"
import { attachAdmission, admissionEpoch, detachAdmission, effectiveHold, endAdmission, resumeAdmission } from "../src/sessions/admission.ts"
import { getOwnedSession, inspectSessions, readSessionMetadata, replaySession } from "../src/sessions/store.ts"
import { emptyLedger, ledgerPath, writeLedger } from "../src/state/ledger.ts"
import { sessionDir, stateRoot } from "../src/state/store.ts"
import { readCommitted, readSessionCommitted } from "../src/workflows/commit.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { fakeClient, makeDeps, tempWorktree, waitFor } from "./guards-helpers.ts"

const S = "ses_retention"
let wt: ReturnType<typeof tempWorktree>
let client: ReturnType<typeof fakeClient>

beforeEach(() => {
  wt = tempWorktree()
  client = fakeClient({ promptAsync: true })
  ;(client.session as any).get = async ({ path }: { path: { id: string } }) => ({
    data: { id: path.id, directory: wt.worktree, time: { created: 1, updated: 2 } },
  })
})
afterEach(() => wt.cleanup())

const info = { id: S, directory: "", time: { created: 1, updated: 2 } }
const deleted = () => ({ event: { type: "session.deleted", properties: { info: { ...info, directory: wt.worktree } } } as any })
const created = () => ({ event: { type: "session.created", properties: { info: { ...info, directory: wt.worktree } } } as any })

function putWorkflow(owner: Workflow["owner"], patch: Partial<Workflow> = {}): Workflow {
  const wf = { ...newWorkflow(S, owner, "command", "retained request", "opencode"), ...patch }
  return withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, wf))
}

/** Every regular file below the state root with its bytes, to prove that nothing was removed or rewritten. */
function snapshotTree(): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) out.set(path, readFileSync(path))
    }
  }
  walk(stateRoot(wt.worktree))
  return out
}

async function attached() {
  const deps = makeDeps(client, wt.worktree)
  const host = getOpenCodeRuntime(deps)
  attachAdmission(host, S, { engine: "opencode" })
  const hook = createEventHook(deps)
  await hook(created())
  const store = getOwnedSession(wt.worktree, S)!
  return { deps, host, hook, store }
}

describe("V-session-end-1 settled delete -> restore", () => {
  test("a real session.deleted retains every snapshot, the index target, events, plan json/md and the ledger byte-for-byte", async () => {
    const { hook, store, host } = await attached()
    store.append("user", { text: "retained question" }, "q1")
    for (let index = 0; index < 4; index++) store.append("notice", { text: `segment ${index}: ${"x".repeat(600_000)}` }, `seg-${index}`)
    const started = startWorkflow(host, S, "command", "retained request", "user_command", "opencode")
    if (!started.ok) throw new Error(started.text)
    const wf = started.wf
    writeLedger(wt.worktree, emptyLedger(S))
    const planJson = planJsonPath(wt.worktree, wf.id, S)
    mkdirSync(dirname(planJson), { recursive: true })
    writeFileSync(planJson, '{"plan":"retained"}')
    const planMd = join(wt.worktree, ".otter", "plans", `${wf.id}.md`)
    mkdirSync(dirname(planMd), { recursive: true })
    writeFileSync(planMd, "# retained plan\n")
    const before = snapshotTree()
    const eventsBefore = readFileSync(eventsPath(wt.worktree, S))
    const planBefore = [readFileSync(planJson), readFileSync(planMd), readFileSync(ledgerPath(wt.worktree, S))]
    const indexTargetBefore = readCommitted(wt.worktree, {}, S)
    if (indexTargetBefore.state !== "ok") throw new Error("index not ok")

    await hook(deleted())

    // nothing disappeared: every pre-existing file is still there; only append-only logs may have grown
    const after = snapshotTree()
    for (const [path, bytes] of before) {
      if (path.endsWith("attach.lock")) continue // the matching attachment lock is the one file release removes
      if (!after.has(path)) throw new Error(`removed: ${path}`)
      if (path === eventsPath(wt.worktree, S)) expect(after.get(path)!.subarray(0, bytes.length).equals(bytes)).toBe(true)
      else if (/segments\d+\.jsonl$/.test(path) || path.endsWith("workflow.json") || path.endsWith("heartbeat.json") ||
        path.endsWith("restore-hold.json") || path.endsWith("metadata.json") || path.endsWith("manifest.json") ||
        path.includes("/attachments/")) continue
      else if (path.endsWith("ledger.json")) {
        // the ledger may gain records but must keep every earlier task and tag: prefix-preserving, never rewritten
        const earlier = JSON.parse(bytes.toString("utf8")) as { tasks: Array<{ id: string }> }
        const later = JSON.parse(after.get(path)!.toString("utf8")) as { tasks: Array<{ id: string }> }
        expect(later.tasks.slice(0, earlier.tasks.length)).toEqual(earlier.tasks)
      }
      else expect(after.get(path)!.equals(bytes)).toBe(true)
    }
    expect(readFileSync(eventsPath(wt.worktree, S)).subarray(0, eventsBefore.length).equals(eventsBefore)).toBe(true)
    // the pre-delete committed snapshot (the former index target) is intact, and the new index target exists
    const oldTarget = join(stateRoot(wt.worktree), indexTargetBefore.index.path)
    expect(readFileSync(oldTarget).equals(indexTargetBefore.bytes)).toBe(true)
    const next = readCommitted(wt.worktree, {}, S)
    if (next.state !== "ok") throw new Error("index not ok after end")
    expect(existsSync(join(stateRoot(wt.worktree), next.index.path))).toBe(true)
    expect(next.wf).toMatchObject({ id: wf.id, phase: "cancelled" })
    expect(readFileSync(planJson).equals(planBefore[0]!)).toBe(true)
    expect(readFileSync(planMd).equals(planBefore[1]!)).toBe(true)
    expect(existsSync(ledgerPath(wt.worktree, S))).toBe(true)
    expect(existsSync(sessionDir(wt.worktree, S))).toBe(true)

    // matching attachment released, no grant survives, hold retained, no dispatch
    expect(getOwnedSession(wt.worktree, S)).toBeUndefined()
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(readSessionMetadata(wt.worktree, S)?.held).toBe(true)
    expect(existsSync(join(sessionDir(wt.worktree, S), "session-ended.json"))).toBe(true)
    expect(client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync")).toHaveLength(0)

    // reopen the same sid: true terminal/cancelled status, still held, no resurrection, restore reads its own history
    const restored = attachAdmission(host, S, { engine: "opencode" })
    expect(restored.metadata.held).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ id: wf.id, phase: "cancelled" })
    expect(readSessionCommitted(wt.worktree, S)).toMatchObject({ current: true, wf: { id: wf.id, phase: "cancelled" } })
    expect(client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync")).toHaveLength(0)
  })

  test("a settled terminal workflow stays terminal and its index target is untouched by deletion", async () => {
    const { hook, store } = await attached()
    putWorkflow(currentOwner(Date.now(), store.epoch), { phase: "done", stage: "terminal" })
    const index = readFileSync(workflowPath(wt.worktree, S))
    const tree = snapshotTree()

    await hook(deleted())

    expect(readFileSync(workflowPath(wt.worktree, S)).equals(index)).toBe(true)
    for (const [path, bytes] of tree) if (path.includes("/workflows/")) expect(readFileSync(path).equals(bytes)).toBe(true)
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "done" })
    expect(getOwnedSession(wt.worktree, S)).toBeUndefined()
  })
})

describe("V-session-end-2 active/unresolved", () => {
  test("while review activity is unresolved the end stays requested, held and unreleased; nothing is deleted", async () => {
    const { hook, host, store } = await attached()
    const wf = putWorkflow(currentOwner(Date.now(), store.epoch), { phase: "planning" })
    const release = beginExecutionActivity(host, S, "review")
    expect(release).toBeTruthy()
    const tree = snapshotTree()

    await hook(deleted())

    expect(getOwnedSession(wt.worktree, S)).toBe(store)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(existsSync(join(sessionDir(wt.worktree, S), "session-end-requested.json"))).toBe(true)
    expect(existsSync(join(sessionDir(wt.worktree, S), "session-ended.json"))).toBe(false)
    for (const [path] of tree) expect(existsSync(path)).toBe(true)
    // the committed workflow (index target) still resolves; cancellation is a new revision, never a removal
    const read = readCommitted(wt.worktree, {}, S)
    expect(read.state).toBe("ok")
    if (read.state === "ok") expect(read.wf.id).toBe(wf.id)
    release!()
  })
})

describe("V-session-end-2 stop observers (P5b)", () => {
  const ended = () => existsSync(join(sessionDir(wt.worktree, S), "session-ended.json"))

  test("deletion during a pending pause becomes a cancel intent; no end or release while review is live; then cancel_settled -> ended -> release", async () => {
    const { hook, host, store } = await attached()
    const wf = putWorkflow(currentOwner(Date.now(), store.epoch), { phase: "executing", stage: "unit" })
    const review = beginExecutionActivity(host, S, "review")!
    expect(requestStop(host, S, "pause", "p", { workflowID: wf.id }).result.ok).toBe(true)
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "executing", stopIntent: { kind: "pause" } })
    const pauseToken = readWorkflow(wt.worktree, S)!.stopIntent!.token

    await hook(deleted())

    // cancel replaced the pause (not `cancelled`), nothing released, endAdmission is false until proof
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "executing", stopIntent: { kind: "cancel" } })
    expect(readEvents(wt.worktree, wf.id, S).find(e => e.type === "stop_requested" && e.data?.kind === "cancel")?.data?.replaces).toBe(pauseToken)
    expect(getOwnedSession(wt.worktree, S)).toBe(store)
    expect(ended()).toBe(false)
    expect(await endAdmission(host, S, store.epoch)).toBe(false)
    expect(ended()).toBe(false)

    review()
    expect(observeStopSettlement(host, S, store.epoch, "review").kind).toBe("settled")
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "cancelled", stopIntent: null })
    // the deletion handler's cancel_settled listener ends the retained session (order: cancel_settled -> ended -> release)
    await waitFor(() => ended())
    expect(getOwnedSession(wt.worktree, S)).toBeUndefined()
    const types = readEvents(wt.worktree, wf.id, S).map(e => e.type)
    expect(types.indexOf("cancel_settled")).toBeGreaterThan(-1)
    expect(existsSync(sessionDir(wt.worktree, S))).toBe(true)
  })

  test("deletion with a live queue-like stage reservation holds the cancel pending and retains every file", async () => {
    const { hook, host, store } = await attached()
    const wf = putWorkflow(currentOwner(Date.now(), store.epoch), { phase: "reviewing", stage: "review" })
    const reservation = beginStageReservation(wt.worktree, S)
    const tree = snapshotTree()
    await hook(deleted())
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ id: wf.id, phase: "reviewing", stopIntent: { kind: "cancel" } })
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(ended()).toBe(false)
    for (const [path] of tree) expect(existsSync(path)).toBe(true)
    reservation()
    observeStopSettlement(host, S, store.epoch, "stage")
    await waitFor(() => ended())
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "cancelled" })
  })

  test("deletion of a settled pause settles the cancel immediately and gives a retained end", async () => {
    const { hook, host, store } = await attached()
    const wf = putWorkflow(currentOwner(Date.now(), store.epoch), { phase: "executing", stage: "unit" })
    expect(requestStop(host, S, "pause", "p", { workflowID: wf.id }).result.ok).toBe(true)
    expect(readWorkflow(wt.worktree, S)!.phase).toBe("paused")
    await hook(deleted())
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "cancelled", stopIntent: null })
    expect(ended()).toBe(true)
    expect(getOwnedSession(wt.worktree, S)).toBeUndefined()
    expect(readEvents(wt.worktree, wf.id, S).map(e => e.type)).toEqual(expect.arrayContaining(["pause_settled", "cancel_settled"]))
  })

  test("an unknown (unreconciled) execution keeps the fence, every file and endAdmission false", async () => {
    const { hook, host, store } = await attached()
    putWorkflow(currentOwner(Date.now(), store.epoch), { phase: "executing", stage: "unit" })
    const claim = host.runs.claim(S, host.instance, process.pid)
    host.runs.registerIntent(claim, {
      executionId: "unknown-exec", ownerSession: S, taskId: "t", attemptId: "a", generation: claim.generation, role: "worker",
      cwd: wt.worktree, policyID: host.policy.resolve("worker").id, kind: "host", engine: "opencode", profile: "legacy-unowned",
    })
    host.runs.fence(claim, "unknown-exec", "termination unknown")
    const tree = snapshotTree()
    await hook(deleted())
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "executing", stopIntent: { kind: "cancel" } })
    expect(await endAdmission(host, S, store.epoch)).toBe(false)
    expect(ended()).toBe(false)
    expect(host.runs.status().claim).toBeDefined()
    for (const [path] of tree) expect(existsSync(path)).toBe(true)
  })

  test("checkpoint bytes and revisions are retained byte-for-byte across the cancel", async () => {
    const { hook, host, store } = await attached()
    const wf = putWorkflow(currentOwner(Date.now(), store.epoch), { phase: "executing", stage: "unit" })
    const hold = beginStageReservation(wt.worktree, S)
    // a pending pause first, so the request checkpoint and a pending-stop revision exist before the deletion
    expect(requestStop(host, S, "pause", "p", { workflowID: wf.id }).result.ok).toBe(true)
    const before = snapshotTree()
    const checkpointPaths = [...before.keys()].filter(path => /\/checkpoints\/.+-request\.json$/.test(path))
    const revisionPaths = [...before.keys()].filter(path => /\/revisions\/\d+\.json$/.test(path))
    expect(checkpointPaths.length).toBeGreaterThan(0)
    expect(revisionPaths.length).toBeGreaterThan(0)
    await hook(deleted())
    hold()
    observeStopSettlement(host, S, store.epoch, "stage")
    expect(readWorkflow(wt.worktree, S)).toMatchObject({ phase: "cancelled" })
    const after = snapshotTree()
    let compared = 0
    for (const path of [...checkpointPaths, ...revisionPaths]) {
      expect(after.has(path)).toBe(true)
      expect(after.get(path)!.equals(before.get(path)!)).toBe(true)
      compared++
    }
    expect(compared).toBe(checkpointPaths.length + revisionPaths.length)
    expect(wf.id).toBe(readWorkflow(wt.worktree, S)!.id)
  })
})

describe("V-session-end-3 duplicate and stale events", () => {
  test("a duplicate deleted event is idempotent: same end marker, same committed revision, same events", async () => {
    const { hook, store } = await attached()
    putWorkflow(currentOwner(Date.now(), store.epoch), { phase: "planning" })
    await hook(deleted())
    const ended = readFileSync(join(sessionDir(wt.worktree, S), "session-ended.json"))
    const index = readFileSync(workflowPath(wt.worktree, S))
    const events = readFileSync(eventsPath(wt.worktree, S))
    const tree = snapshotTree()

    await hook(deleted())

    expect(readFileSync(join(sessionDir(wt.worktree, S), "session-ended.json")).equals(ended)).toBe(true)
    expect(readFileSync(workflowPath(wt.worktree, S)).equals(index)).toBe(true)
    expect(readFileSync(eventsPath(wt.worktree, S)).equals(events)).toBe(true)
    expect(snapshotTree().size).toBe(tree.size)
  })

  test("a stale old-epoch deleted event after a new same-sid epoch attached cannot stop, release or rebind the new attachment", async () => {
    const { deps, hook, host, store } = await attached()
    const wf = putWorkflow(currentOwner(Date.now(), store.epoch), { phase: "planning" })
    await hook(deleted())
    const oldEpoch = store.epoch
    const restored = attachAdmission(host, S, { engine: "opencode" })
    expect(restored.epoch).not.toBe(oldEpoch)
    const index = readFileSync(workflowPath(wt.worktree, S))
    const events = readFileSync(eventsPath(wt.worktree, S))
    const ended = readFileSync(join(sessionDir(wt.worktree, S), "session-ended.json"))

    await createEventHook(deps)(deleted())
    await hook(deleted())

    expect(getOwnedSession(wt.worktree, S)).toBe(restored)
    expect(restored.metadata.held).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(readFileSync(workflowPath(wt.worktree, S)).equals(index)).toBe(true)
    expect(readFileSync(eventsPath(wt.worktree, S)).equals(events)).toBe(true)
    expect(readFileSync(join(sessionDir(wt.worktree, S), "session-ended.json")).equals(ended)).toBe(true)
    expect(readEvents(wt.worktree, wf.id, S).filter(event => event.type === "owner_reattached")).toHaveLength(0)
    // the new epoch can still detach cleanly: it was never ended by the stale callback
    expect(await detachAdmission(host, S, restored.epoch, "retention-fixture-cleanup")).toBe(true)
  })

  test("a deletion for a workflow owned by a foreign epoch is read-only: it neither rebinds nor releases", async () => {
    const hook = createEventHook(makeDeps(client, wt.worktree))
    const foreign = putWorkflow({ instance: "foreign-attachment-epoch", pid: process.pid + 1 }, { phase: "planning" })
    const tree = snapshotTree()

    await hook(deleted())

    expect(readWorkflow(wt.worktree, S)).toMatchObject({ id: foreign.id, phase: "planning", owner: foreign.owner })
    expect(snapshotTree().size).toBe(tree.size)
    expect(getOwnedSession(wt.worktree, S)).toBeUndefined()
  })
})

describe("V-session-end-4 deleted SDK handle", () => {
  test("a retained Otter sid restores for display with the SDK session gone; work resume still refuses; nothing is recreated, purged or re-granted", async () => {
    const { hook, store, host } = await attached()
    store.append("user", { text: "question that outlives the SDK handle" }, "q-sdk")
    store.append("assistant", { text: "answer that outlives the SDK handle" }, "a-sdk")
    const started = startWorkflow(host, S, "command", "retained request", "user_command", "opencode")
    if (!started.ok) throw new Error(started.text)
    const wf = started.wf
    const planMd = join(wt.worktree, ".otter", "plans", `${wf.id}.md`)
    mkdirSync(dirname(planMd), { recursive: true })
    writeFileSync(planMd, "# retained artifact\n")
    await hook(deleted())

    // From here the SDK reports session-exists=false for this id. Otter display must not consult it.
    ;(client.session as any).get = async () => ({ data: undefined, error: { name: "NotFoundError", data: { message: "session not found" } } })
    const callsBefore = client.calls.length
    const treeBefore = snapshotTree()

    // display restore: transcript, listing, committed workflow history, all from Otter state only
    const replay = replaySession(wt.worktree, S, { limit: 10 })
    expect(replay.complete).toBe(true)
    expect(replay.records.map(record => String(record.data.text))).toEqual(expect.arrayContaining([
      "question that outlives the SDK handle", "answer that outlives the SDK handle",
    ]))
    expect(inspectSessions(wt.worktree).find(entry => entry.sessionID === S)).toMatchObject({ sessionID: S, engine: "opencode", held: true })
    expect(readSessionCommitted(wt.worktree, S)).toMatchObject({ current: true, wf: { id: wf.id, sessionID: S, phase: "cancelled" } })
    expect(client.calls.length).toBe(callsBefore)

    // reopening the Otter sid is a held restore, not a resurrection
    const restored = attachAdmission(host, S, { engine: "opencode" })
    expect(restored.restored).toBe(true)
    expect(restored.metadata.held).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()

    // work resume refuses: the retained end marker (the workflow is also terminal)...
    expect(() => resumeAdmission(host, S, readWorkflow(wt.worktree, S)!.lastSeq)).toThrow("session end request remains held")
    // ...and a host without a compatible engine identity
    const incompatible = { ...host, host: { ...host.host, identity: { ...host.host.identity, engine: "codex" } } } as typeof host
    expect(() => resumeAdmission(incompatible, S)).toThrow()
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()

    // no fake SDK recreation or remap, no dispatch, no artifact purge, no grant restoration
    expect(client.calls.filter(call => ["create", "prompt", "promptAsync", "fork"].includes(call.method))).toHaveLength(0)
    expect(readFileSync(planMd, "utf8")).toBe("# retained artifact\n")
    const treeAfter = snapshotTree()
    for (const [path, bytes] of treeBefore) {
      if (!treeAfter.has(path)) {
        if (path.endsWith("attach.lock")) continue
        throw new Error(`purged: ${path}`)
      }
      if (path.includes("/workflows/") && path.includes("/revisions/")) expect(treeAfter.get(path)!.equals(bytes)).toBe(true)
    }
    expect(readSessionMetadata(wt.worktree, S)?.engine).toBe("opencode")
    expect(await detachAdmission(host, S, restored.epoch, "retention-fixture-cleanup")).toBe(true)
  })
})
