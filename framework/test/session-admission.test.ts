import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createEventHook } from "../src/hooks/event.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { newWorkflow, readWorkflow, readWorkflowForWrite, withFlowTransaction, type Workflow } from "../src/flow/state.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { beginExecutionActivity } from "../src/hosts/runtime.ts"
import { sessionDir } from "../src/state/store.ts"
import { emptyLedger, ledgerPath, writeLedger } from "../src/state/ledger.ts"
import { getOwnedSession, inspectSessionAttachment, replaySession, readSessionMetadata } from "../src/sessions/store.ts"
import {
  admissionEpoch,
  attachAdmission,
  attachHeldAdmission,
  captureAdmissionLease,
  detachAdmission,
  effectiveHold,
  endAdmission,
  holdAdmission,
  isAdmissionCurrent,
  isAdmissionLeaseCurrent,
  resumeAdmission,
} from "../src/sessions/admission.ts"
import { fakeClient, makeDeps, tempWorktree } from "./guards-helpers.ts"

const S = "ses_admission"
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

function runtime() {
  return getOpenCodeRuntime(makeDeps(client, wt.worktree))
}

function putWorkflow(patch: Partial<Workflow> = {}): Workflow {
  const workflow = { ...newWorkflow(S, currentOwner(), "command", "resume admission", "opencode"), ...patch }
  return withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, workflow))
}

function updateWorkflow(patch: Partial<Workflow>): Workflow {
  return withFlowTransaction(wt.worktree, tx => {
    const current = readWorkflowForWrite(tx).wf
    if (!current) throw new Error("test workflow is missing")
    return writeWorkflow(tx, { ...current, ...patch })
  })
}

const deleted = (sessionID = S) => ({
  event: { type: "session.deleted", properties: { info: { id: sessionID, directory: wt.worktree, time: { created: 1, updated: 2 } } } } as any,
})
const created = (sessionID = S) => ({
  event: { type: "session.created", properties: { info: { id: sessionID, directory: wt.worktree, time: { created: 1, updated: 2 } } } } as any,
})

describe("session admission", () => {
  test("read-only admission leases cannot revive across same-epoch Resume or grant authority", () => {
    const host = runtime()
    expect(captureAdmissionLease(wt.worktree, S)).toBeUndefined()
    const store = attachAdmission(host, S, { engine: "opencode" })
    const lease = captureAdmissionLease(wt.worktree, S)!
    expect(Object.isFrozen(lease)).toBe(true)
    expect(isAdmissionLeaseCurrent(wt.worktree, S, lease)).toBe(true)
    expect(isAdmissionLeaseCurrent(wt.worktree, `${S}_foreign`, lease)).toBe(false)
    for (const forged of [{}, { ...lease }, JSON.parse(JSON.stringify(lease)), undefined, null, true]) {
      expect(isAdmissionLeaseCurrent(wt.worktree, S, forged)).toBe(false)
    }
    holdAdmission(wt.worktree, S, "test-token-revocation")
    expect(captureAdmissionLease(wt.worktree, S)).toBeUndefined()
    expect(isAdmissionLeaseCurrent(wt.worktree, S, lease)).toBe(false)
    expect(() => store.clearHold(lease as never)).toThrow()
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(resumeAdmission(host, S)).toBe(store)
    expect(admissionEpoch(wt.worktree, S)).toBe(store.epoch)
    expect(isAdmissionLeaseCurrent(wt.worktree, S, lease)).toBe(false)
    const renewed = captureAdmissionLease(wt.worktree, S)!
    expect(renewed).not.toBe(lease)
    expect(isAdmissionLeaseCurrent(wt.worktree, S, renewed)).toBe(true)
    expect(client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync")).toHaveLength(0)
  })

  test("attachment receipt inspection rejects non-UUID and traversing epoch paths", () => {
    const store = attachAdmission(runtime(), S, { engine: "opencode" })
    expect(inspectSessionAttachment(wt.worktree, S, store.epoch)?.state).toBe("attached")
    for (const epoch of ["../session-ended", "../../other/attachments/epoch", `${store.epoch}/../other`, "", "inst_123_legacy"]) {
      expect(() => inspectSessionAttachment(wt.worktree, S, epoch)).toThrow("invalid session attachment epoch")
    }
  })

  test("admission refuses routes that differ from the pinned session routes", () => {
    const host = runtime()
    const routes = { planner: { engine: "claude", model: "opus" } } as const
    const first = attachAdmission(host, S, { engine: "opencode", routes })
    expect(first.metadata.routes).toEqual(routes)
    expect(attachAdmission(host, S, { engine: "opencode", routes: { planner: { engine: "claude", model: "opus" } } })).toBe(first)
    expect(() => attachAdmission(host, S, { engine: "opencode" })).toThrow("routes do not match")
    expect(() => attachAdmission(host, S, { engine: "opencode", routes: { planner: { engine: "codex", model: "gpt-5.6-sol" } } })).toThrow("routes do not match")
    holdAdmission(wt.worktree, S, "test-detach")
    first.release({ workflowQuiescent: true, evidence: "test fixture has no execution state", workflowID: null, revision: null })
    expect(() => attachAdmission(host, S, { engine: "opencode" })).toThrow("routes do not match")
    expect(() => attachHeldAdmission(host, S, { engine: "opencode", routes: { critic: { engine: "local", model: "qwen" } } })).toThrow("routes do not match")
    const restored = attachAdmission(host, S, { engine: "opencode", routes })
    expect(restored.restored).toBe(true)
    expect(restored.metadata.routes).toEqual(routes)
  })

  test("restored attachments stay held and do not acquire an initial token", () => {
    const host = runtime()
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    const first = attachAdmission(host, S, { engine: "opencode" })
    expect(first.restored).toBe(false)
    expect(first.metadata.held).toBe(false)
    expect(effectiveHold(wt.worktree, S)).toBe(false)
    expect(admissionEpoch(wt.worktree, S)).toBe(first.epoch)
    const oldEpoch = first.epoch
    holdAdmission(wt.worktree, S, "test-detach")
    first.release({ workflowQuiescent: true, evidence: "test fixture has no execution state", workflowID: null, revision: null })

    const restored = attachAdmission(host, S, { engine: "opencode" })
    expect(restored.restored).toBe(true)
    expect(restored.epoch).not.toBe(oldEpoch)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(isAdmissionCurrent(wt.worktree, S, oldEpoch)).toBe(false)
  })

  test("preexisting LCA state without session-store metadata attaches held", () => {
    const host = runtime()
    mkdirSync(sessionDir(wt.worktree, S), { recursive: true, mode: 0o700 })
    writeFileSync(join(sessionDir(wt.worktree, S), "ledger.json"), "legacy ledger")

    const store = attachAdmission(host, S, { engine: "opencode" })
    expect(store.restored).toBe(false)
    expect(store.metadata.held).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("explicit Resume admits restored conversation history without inventing a workflow", async () => {
    const host = runtime()
    const original = attachAdmission(host, S, { engine: "opencode" })
    original.append("user", { text: "retained question" })
    original.append("assistant", { text: "retained answer" })
    expect(await detachAdmission(host, S, original.epoch, "test-detach")).toBe(true)
    const restored = attachAdmission(host, S, { engine: "opencode" })
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(() => restored.clearHold({ authorized: true, reason: "explicit-resume" })).toThrow()
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(resumeAdmission(host, S)).toBe(restored)
    expect(admissionEpoch(wt.worktree, S)).toBe(restored.epoch)
    expect(readWorkflow(wt.worktree)).toBeNull()
    expect(replaySession(wt.worktree, S).records.filter(record => record.kind === "user").map(record => record.data.text)).toEqual(["retained question"])
    expect(client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync")).toHaveLength(0)
  })

  test("explicit resume requires the same owner, engine, revision, epoch and quiescent execution state", () => {
    const host = runtime()
    const first = attachAdmission(host, S, { engine: "opencode" })
    const workflow = putWorkflow({ owner: { ...currentOwner(), instance: first.epoch } })
    holdAdmission(wt.worktree, S, "restore")
    first.release({ workflowQuiescent: true, evidence: "test fixture has no execution state", workflowID: workflow.id, revision: workflow.lastSeq })
    const store = attachAdmission(host, S, { engine: "opencode" })
    expect(store.restored).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    const rebound = readWorkflow(wt.worktree)!
    expect(rebound.owner.instance).toBe(store.epoch)
    expect(rebound.lastSeq).not.toBe(workflow.lastSeq)

    expect(() => resumeAdmission(host, S, rebound.lastSeq + 1)).toThrow(/revision/)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(() => resumeAdmission(host, S, workflow.lastSeq)).toThrow(/revision/)
    const resumed = resumeAdmission(host, S, rebound.lastSeq)
    expect(resumed.epoch).toBe(store.epoch)
    expect(admissionEpoch(wt.worktree, S)).toBe(store.epoch)
    expect(isAdmissionCurrent(wt.worktree, S, store.epoch)).toBe(true)
    expect(isAdmissionCurrent(wt.worktree, S, undefined)).toBe(false)
  })

  test("restored attach remains held when prior release evidence does not match the workflow", () => {
    const host = runtime()
    const first = attachAdmission(host, S, { engine: "opencode" })
    const workflow = putWorkflow({ owner: { ...currentOwner(), instance: first.epoch } })
    holdAdmission(wt.worktree, S, "test-detach")
    first.release({
      workflowQuiescent: true,
      evidence: "fixture release is deliberately bound to another workflow",
      workflowID: "different-workflow",
      revision: workflow.lastSeq,
    })

    const restored = attachAdmission(host, S, { engine: "opencode" })
    expect(restored.restored).toBe(true)
    expect(readWorkflow(wt.worktree)?.owner.instance).toBe(first.epoch)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("foreign owner and engine mismatches cannot resume a held session", () => {
    const host = runtime()
    attachAdmission(host, S, { engine: "opencode" })
    const workflow = putWorkflow({ owner: { instance: "foreign-instance", pid: process.pid + 1} })
    holdAdmission(wt.worktree, S, "restore")
    expect(() => resumeAdmission(host, S, workflow.lastSeq)).toThrow(/epoch/)
    expect(effectiveHold(wt.worktree, S)).toBe(true)

    const sameOwner = updateWorkflow({ owner: currentOwner(), engine: "different-engine" })
    expect(() => resumeAdmission(host, S, sameOwner.lastSeq)).toThrow(/engine/)
    expect(readWorkflow(wt.worktree)?.engine).toBe("different-engine")
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("local activity and unsettled execution claims block explicit resume", () => {
    const host = runtime()
    const store = attachAdmission(host, S, { engine: "opencode" })
    const workflow = putWorkflow({ owner: { ...currentOwner(), instance: store.epoch } })
    holdAdmission(wt.worktree, S, "restore")

    const releaseActivity = beginExecutionActivity(host, S, "review")
    expect(releaseActivity).toBeTruthy()
    expect(() => resumeAdmission(host, S, workflow.lastSeq)).toThrow(/activity/)
    releaseActivity!()

    const claim = host.runs.claim(S, host.instance, process.pid)
    host.runs.registerIntent(claim, {
      executionId: "resume-blocked-intent",
      ownerSession: S,
      taskId: "task",
      attemptId: "attempt",
      generation: claim.generation,
      role: "worker",
      cwd: wt.worktree,
      policyID: "resume-admission-test",
      kind: "host",
      engine: host.host.identity.engine,
      profile: "legacy-unowned",
    })
    expect(() => resumeAdmission(host, S, workflow.lastSeq)).toThrow(/claim|intent/)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("stale epochs cannot affect a replacement attachment", async () => {
    const host = runtime()
    const original = attachAdmission(host, S, { engine: "opencode" })
    const staleEpoch = original.epoch
    holdAdmission(wt.worktree, S, "test-detach")
    original.release({ workflowQuiescent: true, evidence: "test fixture has no execution state", workflowID: null, revision: null })
    const replacement = attachAdmission(host, S, { engine: "opencode" })

    expect(replacement.epoch).not.toBe(staleEpoch)
    expect(await endAdmission(host, S, staleEpoch)).toBe(false)
    expect(isAdmissionCurrent(wt.worktree, S, staleEpoch)).toBe(false)
    expect(getOwnedEpoch(host.worktree)).toBe(replacement.epoch)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("normal detach holds first, refuses uncertain activity, and retains history without an ended marker", async () => {
    const host = runtime()
    const store = attachAdmission(host, S, { engine: "opencode" })
    const releaseActivity = beginExecutionActivity(host, S, "review")
    expect(releaseActivity).toBeTruthy()
    expect(await detachAdmission(host, S, store.epoch, "session-switch")).toBe(false)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    releaseActivity!()

    expect(await detachAdmission(host, S, store.epoch, "session-switch")).toBe(true)
    expect(getOwnedSession(wt.worktree, S)).toBeUndefined()
    expect(readSessionMetadata(wt.worktree, S)?.held).toBe(true)
    expect(existsSync(join(sessionDir(wt.worktree, S), "session-ended.json"))).toBe(false)
    expect(existsSync(sessionDir(wt.worktree, S))).toBe(true)
  })

  test("corrupt hold authority and failed durable writes remain fail-closed", () => {
    const host = runtime()
    attachAdmission(host, S, { engine: "opencode" })
    const marker = join(sessionDir(wt.worktree, S), "restore-hold.json")
    writeFileSync(marker, "{not-json")
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()

    const other = "ses_hold_write_failure"
    const second = attachAdmission(host, other, { engine: "opencode" })
    mkdirSync(join(sessionDir(wt.worktree, other), "restore-hold.json"))
    expect(() => holdAdmission(wt.worktree, other, "test-hold")).toThrow()
    expect(admissionEpoch(wt.worktree, other)).toBeUndefined()
    expect(effectiveHold(wt.worktree, other)).toBe(true)
    expect(second.epoch).toBeTruthy()
  })

  test("session end retains transcript and metadata; duplicate end does not replay work", async () => {
    const deps = makeDeps(client, wt.worktree)
    attachAdmission(getOpenCodeRuntime(deps), S, { engine: "opencode" })
    const hook = createEventHook(deps)
    await hook(created())
    const attached = getOwnedEpoch(wt.worktree)
    expect(attached).toBeTruthy()
    const store = getOwnedSession(wt.worktree, S)!
    store.append("user", { text: "retained transcript" }, "transcript-event")
    for (let index = 0; index < 4; index++) {
      store.append("notice", { text: `retained segment ${index}: ${"x".repeat(600_000)}` }, `segment-${index}`)
    }
    putWorkflow({ owner: currentOwner(Date.now(), store.epoch) })
    writeLedger(wt.worktree, emptyLedger(S))
    const directory = sessionDir(wt.worktree, S)
    const retained = new Map<string, Buffer>()
    for (const [name, content] of [
      ["checkpoint.json", '{"checkpoint":"retained after host end"}'],
      ["artifact-receipt.json", '{"kind":"artifact","path":"retained-artifact.txt"}'],
      ["retained-artifact.txt", "retained artifact bytes"],
    ]) {
      const path = join(directory, name!)
      writeFileSync(path, content!, { mode: 0o600 })
      retained.set(path, readFileSync(path))
    }
    retained.set(ledgerPath(wt.worktree, S), readFileSync(ledgerPath(wt.worktree, S)))
    const segments = readdirSync(directory).filter(name => /^segments\d+\.jsonl$/.test(name))
    expect(segments.length).toBeGreaterThan(3)
    const segmentBytes = new Map(segments.map(name => [name, readFileSync(join(directory, name))]))
    const originalIDs = replaySession(wt.worktree, S).records.map(record => record.eventID)

    await hook(deleted())
    expect(existsSync(sessionDir(wt.worktree, S))).toBe(true)
    expect(readSessionMetadata(wt.worktree, S)?.held).toBe(true)
    const replay = replaySession(wt.worktree, S)
    expect(replay.complete).toBe(true)
    expect(replay.records.some(record => record.eventID === "transcript-event")).toBe(true)
    expect(replay.records.slice(0, originalIDs.length).map(record => record.eventID)).toEqual(originalIDs)
    expect(readWorkflow(wt.worktree)?.phase).toBe("cancelled")
    expect(getOwnedSession(wt.worktree, S)).toBeUndefined()
    for (const [path, bytes] of retained) expect(readFileSync(path).equals(bytes)).toBe(true)
    for (const [name, bytes] of segmentBytes) {
      expect(readFileSync(join(directory, name)).subarray(0, bytes.length).equals(bytes)).toBe(true)
    }
    const endedBefore = readFileSync(join(sessionDir(wt.worktree, S), "session-ended.json"), "utf8")

    await hook(deleted())
    const endedAfter = readFileSync(join(sessionDir(wt.worktree, S), "session-ended.json"), "utf8")
    expect(endedAfter).toBe(endedBefore)
    expect(replaySession(wt.worktree, S).records).toHaveLength(replay.records.length)
    expect(client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync")).toHaveLength(0)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    const host = getOpenCodeRuntime(deps)
    const restored = attachAdmission(host, S, { engine: "opencode" })
    expect(restored.metadata.held).toBe(true)
    expect(admissionEpoch(wt.worktree, S)).toBeUndefined()
    expect(readWorkflow(wt.worktree)?.phase).toBe("cancelled")
    const oldest = replaySession(wt.worktree, S, { query: "retained transcript" })
    expect(oldest.complete).toBe(true)
    expect(oldest.records.map(record => record.eventID)).toEqual(["transcript-event"])
    await hook(deleted())
    expect(getOwnedSession(wt.worktree, S)).toBe(restored)
    expect(readFileSync(join(directory, "session-ended.json"), "utf8")).toBe(endedBefore)
    writeFileSync(join(directory, "session-ended.json"), JSON.stringify({ ...JSON.parse(endedBefore), epoch: restored.epoch }))
    expect(await detachAdmission(host, S, restored.epoch, "refuse-unproven-current-end")).toBe(false)
    expect(getOwnedSession(wt.worktree, S)).toBe(restored)
    writeFileSync(join(directory, "session-ended.json"), endedBefore)
    expect(await detachAdmission(host, S, restored.epoch, "retention-fixture-cleanup")).toBe(true)
    expect(readFileSync(join(directory, "session-ended.json"), "utf8")).toBe(endedBefore)
  })

  test("unconfirmed execution keeps the attachment and session held", async () => {
    const deps = makeDeps(client, wt.worktree)
    const host = getOpenCodeRuntime(deps)
    attachAdmission(host, S, { engine: "opencode" })
    const hook = createEventHook(deps)
    await hook(created())
    const epoch = getOwnedEpoch(host.worktree)
    const releaseActivity = beginExecutionActivity(host, S, "review")
    expect(releaseActivity).toBeTruthy()

    await hook(deleted())
    expect(getOwnedEpoch(host.worktree)).toBe(epoch)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(existsSync(join(sessionDir(wt.worktree, S), "session-end-requested.json"))).toBe(true)
    expect(existsSync(join(sessionDir(wt.worktree, S), "session-ended.json"))).toBe(false)
    expect(readSessionMetadata(wt.worktree, S)?.held).toBe(true)
    releaseActivity!()
  })

  test("an unbound deletion callback remains read-only and cannot mutate or release a foreign workflow", async () => {
    const foreign = putWorkflow({
      phase: "planning",
      owner: { instance: "foreign-attachment-epoch", pid: process.pid + 1},
    })
    const hook = createEventHook(makeDeps(client, wt.worktree))

    await hook(deleted())

    expect(readWorkflow(wt.worktree)).toMatchObject({ id: foreign.id, phase: "planning", owner: foreign.owner })
    expect(getOwnedSession(wt.worktree, S)).toBeUndefined()
    expect(existsSync(join(sessionDir(wt.worktree, S), "session-end-requested.json"))).toBe(false)
    expect(existsSync(join(sessionDir(wt.worktree, S), "session-ended.json"))).toBe(false)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })
})

function getOwnedEpoch(worktree: string): string | undefined {
  return getOwnedSession(worktree, S)?.epoch
}
