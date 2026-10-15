import { spawnSync } from "node:child_process"
import { readFileSync, renameSync, symlinkSync, unlinkSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { currentOwner } from "../src/flow/owner.ts"
import { __setCommitFaultHook } from "../src/workflows/commit.ts"
import { eventsPath, newWorkflow, readAllEventLines, readEvents, readWorkflow, withFlowTransaction, workflowPath, type Workflow } from "../src/flow/state.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { ensureHeartbeat, reattachOwner, resolveAuthority, startWorkflow, stopHeartbeat } from "../src/flow/runtime.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { beginExecutionActivity } from "../src/hosts/runtime.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { attachAdmission, effectiveHold, holdAdmission } from "../src/sessions/admission.ts"
import { openSession, readSessionMetadata } from "../src/sessions/store.ts"
import { fakeClient, makeDeps, tempWorktree } from "./guards-helpers.ts"

const S = "ses_owner_rebind"
const OTHER = "ses_owner_foreign"
let wt: ReturnType<typeof tempWorktree>

beforeEach(() => { wt = tempWorktree() })
afterEach(() => {
  stopHeartbeat()
  wt.cleanup()
})

function runtime() {
  const client = fakeClient()
  return Object.assign(getOpenCodeRuntime(makeDeps(client, wt.worktree)), { testCalls: client.calls })
}

function putWorkflow(sessionID: string, owner: Workflow["owner"], patch: Partial<Workflow> = {}): Workflow {
  const wf = { ...newWorkflow(sessionID, owner, "command", "resume held session", "opencode"), ...patch }
  return withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, wf))
}

function fileBytes(path: string): Buffer | null {
  try { return readFileSync(path) }
  catch { return null }
}

function releaseWorkflow(host: ReturnType<typeof runtime>, wfPatch: Partial<Workflow> = {}) {
  const previous = attachAdmission(host, S, { engine: "opencode" })
  const wf = putWorkflow(S, currentOwner(Date.now(), previous.epoch), wfPatch)
  holdAdmission(wt.worktree, S, "restore")
  previous.release({
    workflowQuiescent: true,
    evidence: "test fixture has no queue, activity, claim, or unsettled execution",
    workflowID: wf.id,
    revision: wf.lastSeq,
  })
  return wf
}

/** Open a held replacement epoch without invoking attachAdmission's automatic rebind path. */
function openHeldStore() {
  const store = openSession(wt.worktree, S, { engine: "opencode" })
  holdAdmission(wt.worktree, S, "restore")
  return store
}

function releasedWorkflowWithHeldStore(host: ReturnType<typeof runtime>, wfPatch: Partial<Workflow> = {}) {
  const wf = releaseWorkflow(host, wfPatch)
  const store = openHeldStore()
  return { wf, store }
}

describe("held workflow owner epoch reattachment", () => {
  test("matching same-PID release receipt rebinds once and preserves all workflow content while remaining held", () => {
    const host = runtime()
    const { wf, store } = releasedWorkflowWithHeldStore(host, {
      phase: "pending_approval",
      planRef: { jsonSha: "plan-json-hash", mdPath: ".lca/plans/plan.md", mdSha: "plan-md-hash", revision: 3 },
      review: { verdict: "okay", findings: ["review note"], planSha: "plan-json-hash" },
      approval: { by: "user_command", subject: { kind: "plan", id: "wf_owner", sha256: "plan-json-hash" }, receiptRevision: 0, at: 1_700_000_000_000 },
      taskIds: ["task-a", "task-b"],
      counters: { code_invalid: 2, review_iterations: 1, user_rejections: 3, nudges: 1 },
    })
    const original = readWorkflow(wt.worktree)!

    const result = reattachOwner(host, store, wf.id, wf.lastSeq)

    expect("refuse" in result).toBe(false)
    if ("refuse" in result) throw new Error(result.refuse)
    const rebound = result.wf
    expect(rebound.owner.instance).toBe(store.epoch)
    expect(rebound.owner.pid).toBe(process.pid)
    expect(rebound.lastSeq).toBeGreaterThan(wf.lastSeq)
    const { owner: _owner, lastSeq: _lastSeq, updatedAt: _updatedAt, ...beforeContent } = original
    const { owner: _newOwner, lastSeq: _newLastSeq, updatedAt: _newUpdatedAt, ...afterContent } = rebound
    expect(afterContent).toEqual(beforeContent)
    expect(readEvents(wt.worktree, wf.id).filter(event => event.type === "owner_reattached")).toHaveLength(1)
    expect(store.metadata.held).toBe(true)
    expect(readSessionMetadata(wt.worktree, S)?.held).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(host.runs.status().claim).toBeUndefined()
    expect(host.testCalls).toHaveLength(0)

    const committedBytes = readFileSync(workflowPath(wt.worktree))
    const repeated = reattachOwner(host, store, wf.id, wf.lastSeq)
    expect("refuse" in repeated).toBe(false)
    if ("refuse" in repeated) throw new Error(repeated.refuse)
    expect(repeated.wf).toEqual(rebound)
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(committedBytes)
    expect(readEvents(wt.worktree, wf.id).filter(event => event.type === "owner_reattached")).toHaveLength(1)
  })

  test("a new workflow binds its owner instance to the active attachment epoch", () => {
    const host = runtime()
    const store = attachAdmission(host, S, { engine: "opencode" })

    const result = startWorkflow(host, S, "command", "start under this attachment", "user_command", "opencode")

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.text)
    expect(result.wf.owner.instance).toBe(store.epoch)
    expect(result.wf.owner.pid).toBe(process.pid)
  })

  test("an attached second writer cannot acquire or mutate the held workflow", () => {
    const host = runtime()
    const first = attachAdmission(host, S, { engine: "opencode" })
    const wf = putWorkflow(S, currentOwner(Date.now(), first.epoch))
    holdAdmission(wt.worktree, S, "restore")
    const beforeWorkflow = readFileSync(workflowPath(wt.worktree))
    const beforeEvents = fileBytes(eventsPath(wt.worktree))

    const moduleURL = new URL("../src/sessions/store.ts", import.meta.url).href
    const source = `import(${JSON.stringify(moduleURL)}).then(({ openSession }) => {
      try {
        openSession(${JSON.stringify(wt.worktree)}, ${JSON.stringify(S)}, { engine: "opencode" });
        console.log("unexpected-acquire");
      } catch {
        console.log("refused");
      }
    });`
    const secondWriter = spawnSync(process.execPath, ["-e", source], { cwd: wt.worktree, encoding: "utf8", env: process.env })
    expect(secondWriter.status).toBe(0)
    expect(secondWriter.stdout.trim()).toBe("refused")
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(beforeWorkflow)
    expect(fileBytes(eventsPath(wt.worktree))).toEqual(beforeEvents)
    expect(readWorkflow(wt.worktree)?.id).toBe(wf.id)
    expect(first.metadata.held).toBe(true)
  })

  test("a real dead attachment identity permits rebind without relying on same-PID or heartbeat liveness", () => {
    const host = runtime()
    const moduleURL = new URL("../src/sessions/store.ts", import.meta.url).href
    const source = `import(${JSON.stringify(moduleURL)}).then(({ openSession }) => {
      const store = openSession(${JSON.stringify(wt.worktree)}, ${JSON.stringify(S)}, { engine: "opencode" });
      console.log(store.epoch);
    });`
    const child = spawnSync(process.execPath, ["-e", source], { cwd: wt.worktree, encoding: "utf8", env: process.env })
    expect(child.status).toBe(0)
    expect(child.error).toBeUndefined()
    const oldEpoch = child.stdout.trim()
    expect(oldEpoch).toMatch(/^[0-9a-f-]{36}$/)
    const childPID = child.pid
    if (typeof childPID !== "number") throw new Error("child attachment process ID is unavailable")
    const deadWorkflow = putWorkflow(S, currentOwner(Date.now(), oldEpoch, childPID), { phase: "planning" })

    const store = attachAdmission(host, S, { engine: "opencode" })
    const result = reattachOwner(host, store, deadWorkflow.id, deadWorkflow.lastSeq)

    expect("refuse" in result).toBe(false)
    if ("refuse" in result) throw new Error(result.refuse)
    expect(result.wf.owner.instance).toBe(store.epoch)
    expect(result.wf.owner.pid).toBe(process.pid)
    expect(readEvents(wt.worktree, deadWorkflow.id).filter(event => event.type === "owner_reattached")).toHaveLength(1)
    expect(store.metadata.held).toBe(true)
    expect(host.testCalls).toHaveLength(0)
  })

  test("foreign session and stale workflow revision refuse without any workflow or event mutation", () => {
    const host = runtime()
    const store = openSession(wt.worktree, OTHER, { engine: "opencode" })
    holdAdmission(wt.worktree, OTHER, "restore")
    const wf = putWorkflow(S, currentOwner(Date.now(), "e0c4b83c-3446-46b5-a8d1-986f160e43a1", process.pid))
    const beforeWorkflow = readFileSync(workflowPath(wt.worktree))
    const beforeEvents = fileBytes(eventsPath(wt.worktree))

    const foreign = reattachOwner(host, store, wf.id, wf.lastSeq)
    expect("refuse" in foreign).toBe(true)
    const stale = reattachOwner(host, store, "not-the-current-workflow", wf.lastSeq + 1)
    expect("refuse" in stale).toBe(true)
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(beforeWorkflow)
    expect(fileBytes(eventsPath(wt.worktree))).toEqual(beforeEvents)
  })

  test("missing old-epoch lifecycle proof refuses without mutation", () => {
    const host = runtime()
    const store = openSession(wt.worktree, S, { engine: "opencode" })
    holdAdmission(wt.worktree, S, "restore")
    const wf = putWorkflow(S, currentOwner(Date.now(), "e0c4b83c-3446-46b5-a8d1-986f160e43a1", process.pid))
    const beforeWorkflow = readFileSync(workflowPath(wt.worktree))
    const beforeEvents = fileBytes(eventsPath(wt.worktree))

    const authority = resolveAuthority(host, "approve", S, "opencode")
    expect(authority.refuse).toContain(`/resume ${S}`)
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(beforeWorkflow)
    expect(fileBytes(eventsPath(wt.worktree))).toEqual(beforeEvents)

    const result = reattachOwner(host, store, wf.id, wf.lastSeq)

    expect("refuse" in result).toBe(true)
    if ("refuse" in result) expect(result.refuse).toContain("lifecycle proof")
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(beforeWorkflow)
    expect(fileBytes(eventsPath(wt.worktree))).toEqual(beforeEvents)
    expect(store.metadata.held).toBe(true)
  })

  test("attach rebinds while held, then status stays read-only without dispatch", () => {
    const host = runtime()
    const wf = releaseWorkflow(host)
    const store = attachAdmission(host, S, { engine: "opencode" })
    const rebound = readWorkflow(wt.worktree)!
    expect(rebound.owner.instance).toBe(store.epoch)
    expect(rebound.owner.pid).toBe(process.pid)
    expect(readEvents(wt.worktree, wf.id).filter(event => event.type === "owner_reattached")).toHaveLength(1)
    expect(store.metadata.held).toBe(true)
    expect(readSessionMetadata(wt.worktree, S)?.held).toBe(true)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
    expect(host.testCalls).toHaveLength(0)

    const beforeWorkflow = readFileSync(workflowPath(wt.worktree))
    const beforeEvents = fileBytes(eventsPath(wt.worktree))

    const status = resolveAuthority(host, "status", S, "opencode")
    expect(status.refuse).toBeUndefined()
    expect(status.wf?.id).toBe(wf.id)
    expect(status.wf?.owner.instance).toBe(store.epoch)
    for (const cmd of ["plan", "approve", "reject", "cancel"] as const) {
      const result = resolveAuthority(host, cmd, S, "opencode")
      expect(result.refuse).toContain(`/resume ${S}`)
      expect(result.wf?.owner.instance).toBe(store.epoch)
    }
    expect(store.metadata.held).toBe(true)
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(beforeWorkflow)
    expect(fileBytes(eventsPath(wt.worktree))).toEqual(beforeEvents)
    expect(host.testCalls).toHaveLength(0)
  })

  test("stale CAS refuses before mutation even when the held epoch has a valid release receipt", () => {
    const host = runtime()
    const { wf, store } = releasedWorkflowWithHeldStore(host)
    const beforeWorkflow = readFileSync(workflowPath(wt.worktree))
    const beforeEvents = fileBytes(eventsPath(wt.worktree))

    const result = reattachOwner(host, store, wf.id, wf.lastSeq + 1)

    expect("refuse" in result).toBe(true)
    if ("refuse" in result) expect(result.refuse).toContain("revision")
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(beforeWorkflow)
    expect(fileBytes(eventsPath(wt.worktree))).toEqual(beforeEvents)
    expect(store.metadata.held).toBe(true)
  })

  test("active reviewer or unsettled execution intent blocks rebind before workflow mutation", () => {
    const host = runtime()
    const { wf, store } = releasedWorkflowWithHeldStore(host)
    const beforeWorkflow = readFileSync(workflowPath(wt.worktree))
    const beforeEvents = fileBytes(eventsPath(wt.worktree))

    const releaseReview = beginExecutionActivity(host, S, "review")
    expect(releaseReview).toBeTruthy()
    const reviewResult = reattachOwner(host, store, wf.id, wf.lastSeq)
    expect("refuse" in reviewResult).toBe(true)
    if ("refuse" in reviewResult) expect(reviewResult.refuse).toContain("reviewer")
    releaseReview!()

    const claim = host.runs.claim(S, host.instance, process.pid)
    host.runs.registerIntent(claim, {
      executionId: "rebind-blocked-intent",
      ownerSession: S,
      taskId: "task",
      attemptId: "attempt",
      generation: claim.generation,
      role: "reviewer",
      cwd: wt.worktree,
      policyID: "session-owner-test",
      kind: "host",
      engine: host.host.identity.engine,
      profile: "legacy-unowned",
    })
    const intentResult = reattachOwner(host, store, wf.id, wf.lastSeq)
    expect("refuse" in intentResult).toBe(true)
    if ("refuse" in intentResult) expect(intentResult.refuse).toContain("claim")
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(beforeWorkflow)
    expect(fileBytes(eventsPath(wt.worktree))).toEqual(beforeEvents)
    expect(store.metadata.held).toBe(true)
  })

  test("an active queue blocks rebind without dispatch or workflow mutation", () => {
    const host = runtime()
    const { wf, store } = releasedWorkflowWithHeldStore(host)
    const beforeWorkflow = readFileSync(workflowPath(wt.worktree))
    const beforeEvents = fileBytes(eventsPath(wt.worktree))
    const queue = getQueue(host)
    const isRunning = queue.isRunning
    queue.isRunning = () => true
    let result: ReturnType<typeof reattachOwner> | undefined
    try {
      result = reattachOwner(host, store, wf.id, wf.lastSeq)
    } finally {
      queue.isRunning = isRunning
    }

    if (!result) throw new Error("queue rebind check did not return a result")
    expect("refuse" in result).toBe(true)
    if ("refuse" in result) expect(result.refuse).toContain("queue")
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(beforeWorkflow)
    expect(fileBytes(eventsPath(wt.worktree))).toEqual(beforeEvents)
    expect(host.testCalls).toHaveLength(0)
  })

  for (const stage of ["events-fsync", "snapshot-rename", "index-write", "index-rename"] as const) {
    test(`a commit fault at ${stage} leaves the old epoch committed and held; retry commits exactly one owner_reattached and records the orphan`, () => {
      const host = runtime()
      const { wf, store } = releasedWorkflowWithHeldStore(host)
      const path = workflowPath(wt.worktree)
      const beforeIndex = readFileSync(path)
      const beforeEventCount = readAllEventLines(wt.worktree).length
      __setCommitFaultHook(at => { if (at === stage) throw new Error(`injected ${at}`) })
      let failed: ReturnType<typeof reattachOwner>
      try { failed = reattachOwner(host, store, wf.id, wf.lastSeq) }
      finally { __setCommitFaultHook(null) }
      expect("refuse" in failed).toBe(true)
      if ("refuse" in failed) expect(failed.refuse).toContain(`injected ${stage}`)
      expect(readFileSync(path)).toEqual(beforeIndex)
      expect(readWorkflow(wt.worktree)?.owner.instance).not.toBe(store.epoch)
      expect(effectiveHold(wt.worktree, S)).toBe(true)
      expect(store.metadata.held).toBe(true)
      // the raw owner_reattached line reached the log before the fault, but it is an orphan, not committed work
      const raw = readAllEventLines(wt.worktree)
      expect(raw).toHaveLength(beforeEventCount + 1)
      const orphanSeq = raw.at(-1)!.seq
      expect(raw.at(-1)!.type).toBe("owner_reattached")
      expect(readEvents(wt.worktree, wf.id).filter(event => event.type === "owner_reattached")).toHaveLength(0)

      const recovered = reattachOwner(host, store, wf.id, wf.lastSeq)
      if ("refuse" in recovered) throw new Error(recovered.refuse)
      expect(recovered.wf.owner.instance).toBe(store.epoch)
      expect(readEvents(wt.worktree, wf.id).filter(event => event.type === "owner_reattached")).toHaveLength(1)
      expect(recovered.wf.orphanedEvents).toEqual([[orphanSeq, orphanSeq]])
      expect(readEvents(wt.worktree, wf.id).some(event => event.seq === orphanSeq)).toBe(false)
      expect(store.metadata.held).toBe(true)
      expect(effectiveHold(wt.worktree, S)).toBe(true)
    })
  }

  test("a symlinked index is a corrupt-state refusal: nothing is written and bytes are preserved", () => {
    const host = runtime()
    const { wf, store } = releasedWorkflowWithHeldStore(host)
    const path = workflowPath(wt.worktree)
    const backup = `${path}.before-fault`
    const beforeWorkflow = readFileSync(path)
    const beforeEvents = fileBytes(eventsPath(wt.worktree))
    renameSync(path, backup)
    symlinkSync(backup, path)
    let failed: ReturnType<typeof reattachOwner> | undefined
    try { failed = reattachOwner(host, store, wf.id, wf.lastSeq) }
    finally {
      unlinkSync(path)
      renameSync(backup, path)
    }
    expect("refuse" in failed!).toBe(true)
    expect(readFileSync(path)).toEqual(beforeWorkflow)
    expect(fileBytes(eventsPath(wt.worktree))).toEqual(beforeEvents)
    expect(effectiveHold(wt.worktree, S)).toBe(true)
  })

  test("a stale heartbeat snapshot cannot overwrite a rebound owner", async () => {
    const host = runtime()
    const { wf, store } = releasedWorkflowWithHeldStore(host)
    const rebound = reattachOwner(host, store, wf.id, wf.lastSeq)
    if ("refuse" in rebound) throw new Error(rebound.refuse)
    const before = readFileSync(workflowPath(wt.worktree))

    ensureHeartbeat(host, "opencode", wf, 5)
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(readFileSync(workflowPath(wt.worktree))).toEqual(before)
    expect(readWorkflow(wt.worktree)?.owner.instance).toBe(store.epoch)
    stopHeartbeat()
  })
})
