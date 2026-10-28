// P5a S2: single-index commit protocol (events -> immutable snapshot -> index), fault injection at every step,
// legacy v1 cutover, heartbeat sidecar, orphan handling and retention.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { __setCommitFaultHook, commitHandoff, commitRevision, readCommitted, readSessionCommitted, sha256Hex, type CommitStage } from "../src/workflows/commit.ts"
import {
  eventsPath, FlowTransactionBusyError, flowDir, heartbeatPath, newWorkflow, readEvents, readEventsTail, readHeartbeat, readWorkflow, readWorkflowChecked,
  withFlowTransaction, workflowPath, writeHeartbeat, LegacyWorkflowError, type Workflow,
} from "../src/flow/state.ts"
import { applyEvent, approveWorkflow, ensureHeartbeat, repairOnLoad, settleOwned, startWorkflow, stopHeartbeat } from "../src/flow/runtime.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { readForegroundStatus } from "../src/hosts/controller.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { statusJson, StatusReadError } from "../src/flow/status.ts"
import { stateRoot } from "../src/state/store.ts"
import { receiptRelativePath, verifyReceiptRef, writeReceipt } from "../src/workflows/receipts.ts"
import { describeArtifactsBudgeted, sha256 as sha256Text } from "../src/workflows/artifacts.ts"
import { writeFileSync as writeFile2 } from "node:fs"
import { committedSnapshot, rewriteCommitted, writeWorkflow } from "./commit-fixture.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { admitFixtureSession, requestCancel, fakeClient, makeDeps, releaseFixtureSession, tempWorktree } from "./guards-helpers.ts"

const S = "ses_tx"
const S2 = "ses_tx2"
let wt: ReturnType<typeof tempWorktree>
let stores: Array<ReturnType<typeof admitFixtureSession>>

beforeEach(() => { wt = tempWorktree(); stores = [] })
afterEach(() => {
  __setCommitFaultHook(null)
  stopHeartbeat()
  for (const store of stores.splice(0)) releaseFixtureSession(wt.worktree, store)
  wt.cleanup()
})

function deps() { return makeDeps(fakeClient(), wt.worktree) }
function admit(d: ReturnType<typeof makeDeps>, sid: string) {
  const store = admitFixtureSession(d, sid)
  stores.push(store)
  return store
}
function started(d = deps(), sid = S): Workflow {
  admit(d, sid)
  const r = startWorkflow(d, sid, "command", "request", "user_command", "opencode")
  if (!r.ok) throw new Error(r.text)
  return r.wf
}
const bytes = (path: string): Buffer | null => { try { return readFileSync(path) } catch { return null } }
const mode = (path: string) => statSync(path).mode & 0o777
const revisionsDir = (wf: Pick<Workflow, "sessionID" | "id">) => join(stateRoot(wt.worktree), "sessions", wf.sessionID, "workflows", wf.id, "revisions")
const revisionFiles = (wf: Pick<Workflow, "sessionID" | "id">) => { try { return readdirSync(revisionsDir(wf)).sort() } catch { return [] } }
const indexOf = () => JSON.parse(readFileSync(workflowPath(wt.worktree, S), "utf8")) as { version: number; id: string; sessionID: string; kind: string; revision: number; path: string; sha256: string }

/** Every byte under the workflow control directories, for byte-identity assertions. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) walk(path)
      else if (stat.isSymbolicLink()) out[path] = "symlink"
      else out[path] = sha256Hex(readFileSync(path))
    }
  }
  walk(root)
  return out
}
const controlTree = () => tree(stateRoot(wt.worktree))

describe("one commit per transition", () => {
  test("a transition produces exactly one revision snapshot bound by a sha-checked index with private modes", () => {
    const d = deps()
    const wf = started(d)
    const index0 = indexOf()
    expect(index0).toMatchObject({ version: 2, id: wf.id, sessionID: S, kind: "plan", revision: wf.lastSeq })
    expect(index0.path).toBe(`sessions/${S}/workflows/${wf.id}/revisions/${wf.lastSeq}.json`)
    expect(revisionFiles(wf)).toEqual([`${wf.lastSeq}.json`])

    const next = applyEvent(d, wf, "user_message", "user_message")
    if (!next.ok) throw new Error(next.text)
    const index1 = indexOf()
    expect(revisionFiles(wf)).toEqual([`${wf.lastSeq}.json`, `${next.wf.lastSeq}.json`].sort())
    expect(index1.revision).toBe(next.wf.lastSeq)
    expect(index1.revision).toBeGreaterThan(index0.revision)
    const snapshotBytes = readFileSync(join(stateRoot(wt.worktree), index1.path))
    expect(index1.sha256).toBe(sha256Hex(snapshotBytes))
    expect(JSON.parse(snapshotBytes.toString("utf8"))).toMatchObject({ version: 2, id: wf.id, lastSeq: index1.revision, kind: "plan", stage: "draft" })
    expect(index1.path.startsWith(`sessions/${S}/workflows/${wf.id}/revisions/`)).toBe(true)

    expect(mode(workflowPath(wt.worktree, S))).toBe(0o600)
    expect(mode(join(stateRoot(wt.worktree), index1.path))).toBe(0o600)
    expect(mode(eventsPath(wt.worktree, S))).toBe(0o600)
    for (const dir of [revisionsDir(wf), join(revisionsDir(wf), ".."), flowDir(wt.worktree, S)]) expect(mode(dir)).toBe(0o700)
  })

  test("the first transition and the double-write collapse: a start commits once with both events and one snapshot", () => {
    const wf = started()
    expect(revisionFiles(wf)).toHaveLength(1)
    expect(readEvents(wt.worktree, wf.id, S).map((e) => e.type)).toEqual(["created", "transition"])
    expect(wf.lastSeq).toBe(2)
  })

  test("an event-only follow-up (typed) writes one snapshot per transition and never rewrites an earlier one", () => {
    const d = deps()
    const wf = started(d)
    const first = bytes(join(revisionsDir(wf), `${wf.lastSeq}.json`))
    const r = applyEvent(d, wf, "user_message", "user_message")
    if (!r.ok) throw new Error(r.text)
    expect(bytes(join(revisionsDir(wf), `${wf.lastSeq}.json`))!.equals(first!)).toBe(true)
    expect(revisionFiles(wf)).toHaveLength(2)
  })
})

const STAGES: CommitStage[] = [
  "events-fsync", "snapshot-write", "snapshot-fsync", "snapshot-rename", "snapshot-dirfsync",
  "index-write", "index-fsync", "index-rename", "index-dirfsync",
]

describe("fault injection", () => {
  for (const stage of STAGES) {
    test(`a failure at ${stage} leaves one coherent revision, ignores orphans, and a retry commits cleanly`, () => {
      const d = deps()
      const wf = started(d)
      const before = committedSnapshot(wt.worktree, S)
      const indexBefore = bytes(workflowPath(wt.worktree, S))!
      const committedEvents = readEvents(wt.worktree, wf.id, S).length
      __setCommitFaultHook((at) => { if (at === stage) throw new Error(`injected ${at}`) })

      expect(() => applyEvent(d, wf, "user_message", "user_message")).toThrow(`injected ${stage}`)
      __setCommitFaultHook(null)

      const read = readCommitted(wt.worktree, {}, S)
      expect(read.state).toBe("ok")
      if (read.state !== "ok") return
      const indexAfter = bytes(workflowPath(wt.worktree, S))!
      const published = !indexAfter.equals(indexBefore)
      // The index rename is the commit point: faults before it keep the old revision byte-for-byte, a fault after
      // it (dir fsync) may expose the new one, but never a mixture.
      if (stage === "index-dirfsync") expect(published).toBe(true)
      else expect(published).toBe(false)
      if (published) {
        expect(read.wf.lastSeq).toBeGreaterThan(before.lastSeq)
        expect(read.index.sha256).toBe(sha256Hex(read.bytes))
        expect(read.wf.phase).toBe("planning")
      } else {
        expect(read.wf).toEqual(before)
        expect(read.index.sha256).toBe(sha256Hex(read.bytes))
        // precommit event rows may exist on disk but are not committed work anywhere readEvents feeds authority
        expect(readEvents(wt.worktree, wf.id, S)).toHaveLength(committedEvents)
        expect(readEventsTail(wt.worktree, { wfId: wf.id, limit: 50, bound: { revision: read.wf.lastSeq, orphans: [] } }, S).events).toHaveLength(committedEvents)
      }

      // restart: a fresh read of the same state sees the same coherent revision
      expect(readWorkflow(wt.worktree, S)?.lastSeq).toBe(read.wf.lastSeq)

      // retry from the stale caller snapshot: refused if the new revision was published, committed otherwise
      const retry = applyEvent(d, wf, "user_message", "user_message")
      if (published) expect(retry.ok).toBe(false)
      else {
        expect(retry.ok).toBe(true)
        if (retry.ok) {
          const current = readWorkflow(wt.worktree, S)!
          expect(current.lastSeq).toBe(retry.wf.lastSeq)
          expect(readEvents(wt.worktree, wf.id, S).every((e) => e.seq <= current.lastSeq)).toBe(true)
          // the failed attempt's rows are recorded as orphans and stay excluded
          expect(current.orphanedEvents?.length ?? 0).toBeGreaterThan(0)
          for (const [first, last] of current.orphanedEvents ?? []) expect(readEvents(wt.worktree, wf.id, S).some((e) => e.seq >= first && e.seq <= last)).toBe(false)
        }
      }
    })
  }

  test("orphan rows are excluded from the status event tail and detail", () => {
    const d = deps()
    const wf = started(d)
    __setCommitFaultHook((at) => { if (at === "snapshot-rename") throw new Error("boom") })
    expect(() => applyEvent(d, wf, "user_message", "user_message")).toThrow("boom")
    __setCommitFaultHook(null)
    expect(readAllLines()).toContain("user_message")
    const status = statusJson(d, S, { detail: true })
    expect(status.events.map((e) => e.type)).toEqual(["created", "transition"])
    expect(JSON.stringify(status.detail?.events)).not.toContain("user_message")
  })

  function readAllLines(): string { return readFileSync(eventsPath(wt.worktree, S), "utf8") }

  test("a snapshot path that already holds different bytes is refused and preserved", () => {
    const d = deps()
    const wf = started(d)
    // pre-seed the next revision's snapshot file with foreign bytes: seq after the next append is lastSeq+1 (one event)
    const target = join(revisionsDir(wf), `${wf.lastSeq + 1}.json`)
    writeFileSync(target, "foreign")
    const indexBefore = bytes(workflowPath(wt.worktree, S))!
    expect(() => withFlowTransaction(wt.worktree, (tx) => commitRevision(tx, wf, [{ wf: wf.id, type: "x", actor: "code" }]), S)).toThrow("different bytes")
    expect(readFileSync(target, "utf8")).toBe("foreign")
    expect(bytes(workflowPath(wt.worktree, S))!.equals(indexBefore)).toBe(true)
  })
})

describe("index integrity", () => {
  function expectWritersRefuse(d: ReturnType<typeof makeDeps>, wf: Workflow) {
    const before = controlTree()
    const attempts: Array<() => unknown> = [
      () => applyEvent(d, wf, "user_message", "user_message"),
      () => startWorkflow(d, S, "command", "again", "user_command", "opencode"),
      () => requestCancel(d, wf).result,
      () => settleOwned(getOpenCodeRuntime(d), { sessionID: S }, "test"),
      () => approveWorkflow(d, wf, [], { queueRunning: false, planShaOk: true, mdShaOk: true }),
      () => requestCancel(d, { sessionID: S, id: wf.id }).result,
      () => repairOnLoad(d, "opencode", undefined, S),
    ]
    for (const attempt of attempts) {
      let outcome: unknown
      try { outcome = attempt() } catch (error) { outcome = error }
      const refused = outcome instanceof Error || (outcome && typeof outcome === "object" && "ok" in outcome && (outcome as { ok: boolean }).ok === false) || outcome === null
      expect(refused).toBe(true)
    }
    expect(controlTree()).toEqual(before)
  }

  test("an index with a mismatched snapshot hash refuses all writes and leaves bytes untouched", () => {
    const d = deps()
    const wf = started(d)
    const index = indexOf()
    writeFileSync(workflowPath(wt.worktree, S), `${JSON.stringify({ ...index, sha256: "0".repeat(64) })}\n`)
    expect(readWorkflowChecked(wt.worktree, S).corrupt).toBe(workflowPath(wt.worktree, S))
    expectWritersRefuse(d, wf)
  })

  test("a symlinked snapshot, a missing snapshot and an identity mismatch are all corrupt", () => {
    const d = deps()
    const wf = started(d)
    const index = indexOf()
    const snapshot = join(stateRoot(wt.worktree), index.path)
    const backup = `${snapshot}.bak`

    renameSync(snapshot, backup)
    expect(readCommitted(wt.worktree, {}, S).state).toBe("corrupt") // missing
    symlinkSync(backup, snapshot)
    expect(readCommitted(wt.worktree, {}, S).state).toBe("corrupt") // symlink, never followed
    expectWritersRefuse(d, wf)
    unlinkSync(snapshot)
    renameSync(backup, snapshot)
    expect(readCommitted(wt.worktree, {}, S).state).toBe("ok")

    // identity: id, session, kind and revision must each match the snapshot content
    for (const patch of [{ id: "wf_other" }, { sessionID: "ses_other" }, { kind: "ralplan" }, { revision: index.revision + 1 }]) {
      const changed = { ...index, ...patch }
      changed.path = `sessions/${changed.sessionID}/workflows/${changed.id}/revisions/${changed.revision}.json`
      const target = join(stateRoot(wt.worktree), changed.path)
      mkdirSync(join(target, ".."), { recursive: true })
      writeFileSync(target, readFileSync(snapshot))
      changed.sha256 = sha256Hex(readFileSync(target))
      writeFileSync(workflowPath(wt.worktree, S), `${JSON.stringify(changed)}\n`)
      expect(readCommitted(wt.worktree, {}, S).state).toBe("corrupt")
    }
    writeFileSync(workflowPath(wt.worktree, S), `${JSON.stringify(index)}\n`)
    expect(readCommitted(wt.worktree, {}, S).state).toBe("ok")
  })

  test("an index whose path is not the canonical snapshot path is rejected", () => {
    const d = deps()
    started(d)
    const index = indexOf()
    writeFileSync(workflowPath(wt.worktree, S), `${JSON.stringify({ ...index, path: "../../../etc/passwd" })}\n`)
    expect(readCommitted(wt.worktree, {}, S)).toMatchObject({ state: "corrupt", code: "invalid" })
  })

  test("an oversize or non-JSON index is corrupt, bytes preserved", () => {
    const d = deps()
    const wf = started(d)
    const garbage = Buffer.from("{not json")
    writeFileSync(workflowPath(wt.worktree, S), garbage)
    expect(readCommitted(wt.worktree, {}, S).state).toBe("corrupt")
    expectWritersRefuse(d, wf)
    expect(bytes(workflowPath(wt.worktree, S))!.equals(garbage)).toBe(true)
  })
})

describe("legacy v1 cutover", () => {
  function legacyRecord(overrides: Record<string, unknown> = {}) {
    const wf = newWorkflow(S, currentOwner(), "command", "legacy", "opencode")
    const { version: _v, stage: _s, stopIntent: _i, artifacts: _a, ...rest } = wf
    return { ...rest, version: 1, owner: { ...wf.owner, heartbeatAt: Date.now() }, phase: "planning", ...overrides }
  }
  function writeLegacy(record: Record<string, unknown>): Buffer {
    mkdirSync(flowDir(wt.worktree, S), { recursive: true, mode: 0o700 })
    const text = `${JSON.stringify(record, null, 2)}\n`
    writeFileSync(workflowPath(wt.worktree, S), text)
    return Buffer.from(text)
  }

  for (const phase of ["planning", "reviewing", "pending_approval", "executing", "stuck"] as const) {
    test(`a non-terminal v1 record (${phase}) makes every writer refuse with byte-identical files`, () => {
      const d = deps()
      admit(d, S)
      admit(d, S2)
      const record = legacyRecord({ phase })
      const original = writeLegacy(record)
      const wf = newWorkflow(S, currentOwner(), "command", "legacy", "opencode")
      Object.assign(wf, { id: record.id as string })
      const before = controlTree()

      const results: unknown[] = []
      const attempt = (fn: () => unknown) => { try { results.push(fn()) } catch (error) { results.push(error) } }
      attempt(() => startWorkflow(d, S, "command", "new", "user_command", "opencode"))
      attempt(() => applyEvent(d, wf, "user_message", "user_message"))
      attempt(() => requestCancel(d, wf).result)
      attempt(() => approveWorkflow(d, wf, [], { queueRunning: false, planShaOk: true, mdShaOk: true }))
      attempt(() => settleOwned(getOpenCodeRuntime(d), { sessionID: S }, "test"))
      attempt(() => requestCancel(d, { sessionID: S, id: wf.id }).result)
      attempt(() => repairOnLoad(d, "opencode", undefined, S))
      attempt(() => ensureHeartbeat(d, "opencode", wf))
      attempt(() => withFlowTransaction(wt.worktree, (tx) => commitRevision(tx, wf, [{ wf: wf.id, type: "x", actor: "code" }]), S))
      attempt(() => withFlowTransaction(wt.worktree, (tx) => writeWorkflow(tx, wf), S))

      for (const result of results) {
        const refused = result instanceof Error || result === null || result === undefined ||
          (typeof result === "object" && "ok" in (result as object) && (result as { ok: boolean }).ok === false)
        expect(refused).toBe(true)
      }
      expect(results.some((r) => r instanceof LegacyWorkflowError)).toBe(true)
      expect(bytes(workflowPath(wt.worktree, S))!.equals(original)).toBe(true)
      expect(controlTree()).toEqual(before)
      expect(existsSync(heartbeatPath(wt.worktree, S))).toBe(false)
      expect(existsSync(join(flowDir(wt.worktree, S), "legacy"))).toBe(false)
    })
  }

  test("status reports a non-terminal v1 record as invalid_state and never reads it as a workflow", () => {
    writeLegacy(legacyRecord())
    expect(readWorkflow(wt.worktree, S)).toBeNull()
    expect(readWorkflowChecked(wt.worktree, S)).toMatchObject({ wf: null, corrupt: workflowPath(wt.worktree, S), legacy: { terminal: false } })
    expect(() => statusJson(deps(), S)).toThrow(expect.objectContaining({ source: "workflow", code: "invalid_state" }))
    expect(() => readForegroundStatus({ worktree: wt.worktree, config: DEFAULT_CONFIG, log: () => {} }, S)).toThrow()
  })

  for (const phase of ["done", "cancelled"] as const) {
    test(`a terminal v1 record (${phase}) allows a new start and its bytes are archived, not deleted`, () => {
      const d = deps()
      admit(d, S)
      const record = legacyRecord({ phase })
      const original = writeLegacy(record)
      expect(readWorkflowChecked(wt.worktree, S)).toMatchObject({ wf: null, legacy: { terminal: true } })
      expect(readWorkflowChecked(wt.worktree, S).corrupt).toBeUndefined()

      const result = startWorkflow(d, S, "command", "fresh", "user_command", "opencode")
      if (!result.ok) throw new Error(result.text)
      const archived = join(flowDir(wt.worktree, S), "legacy", `${record.id as string}.v1.json`)
      expect(bytes(archived)!.equals(original)).toBe(true)
      expect(indexOf()).toMatchObject({ version: 2, id: result.wf.id })
      expect(readWorkflow(wt.worktree, S)?.id).toBe(result.wf.id)
    })
  }

  test("a v2 commit over a v1 terminal record keeps the legacy bytes if the index publish fails", () => {
    const d = deps()
    admit(d, S)
    const original = writeLegacy(legacyRecord({ phase: "done" }))
    __setCommitFaultHook((at) => { if (at === "index-write") throw new Error("injected") })
    expect(() => startWorkflow(d, S, "command", "fresh", "user_command", "opencode")).toThrow("injected")
    __setCommitFaultHook(null)
    expect(bytes(workflowPath(wt.worktree, S))!.equals(original)).toBe(true)
    expect(readWorkflowChecked(wt.worktree, S)).toMatchObject({ wf: null, legacy: { terminal: true } })
  })
})

describe("session slots", () => {
  test("two sessions starting back to back retain independent indexes", () => {
    const d = deps()
    admit(d, S)
    admit(d, S2)
    const first = startWorkflow(d, S, "command", "one", "user_command", "opencode")
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.text)
    const before = bytes(workflowPath(wt.worktree, S))!
    const second = startWorkflow(d, S2, "command", "two", "user_command", "opencode")
    expect(second.ok).toBe(true)
    expect(bytes(workflowPath(wt.worktree, S))!.equals(before)).toBe(true)
    expect(readWorkflow(wt.worktree, S)?.id).toBe(first.wf.id)
    if (second.ok) expect(readWorkflow(wt.worktree, S2)?.id).toBe(second.wf.id)
  })

  test("a start that races a held flow lock gets the busy refusal and writes nothing", () => {
    const d = deps()
    admit(d, S)
    admit(d, S2)
    const before = controlTree()
    // another process holds the flow lock (a symlink with a foreign identity)
    const lock = join(flowDir(wt.worktree, S), "workflow.lock")
    mkdirSync(flowDir(wt.worktree, S), { recursive: true, mode: 0o700 })
    symlinkSync(JSON.stringify({ pid: 99_999_999, instance: "busy", token: "busy" }), lock)
    const withLock = controlTree()
    let loserError: unknown
    try { startWorkflow(d, S, "command", "late", "user_command", "opencode") } catch (error) { loserError = error }
    expect(loserError).toBeInstanceOf(FlowTransactionBusyError)
    expect(controlTree()).toEqual(withLock)
    unlinkSync(lock)
    expect(controlTree()).toEqual(before)
  })

  test("two processes in distinct sessions start independently under a barrier", async () => {
    const script = `
      const { startWorkflow } = await import(${JSON.stringify(new URL("../src/flow/runtime.ts", import.meta.url).href)});
      const { makeDeps, fakeClient } = await import(${JSON.stringify(new URL("./guards-helpers.ts", import.meta.url).href)});
      const { getOpenCodeRuntime } = await import(${JSON.stringify(new URL("../src/hosts/opencode-runtime.ts", import.meta.url).href)});
      const { attachAdmission } = await import(${JSON.stringify(new URL("../src/sessions/admission.ts", import.meta.url).href)});
      const { existsSync, writeFileSync } = await import("node:fs");
      const deps = makeDeps(fakeClient({ promptAsync: true }), process.env.WT);
      const runtime = getOpenCodeRuntime(deps);
      attachAdmission(runtime, process.env.SID, { engine: "opencode" });
      writeFileSync(process.env.READY, "1");
      while (!existsSync(process.env.GO)) await new Promise(r => setTimeout(r, 1));
      let outcome;
      for (let attempt = 0; attempt < 200; attempt++) {
        try { const r = startWorkflow(deps, process.env.SID, "command", "race", "user_command", "opencode"); outcome = r.ok ? "won:" + r.wf.id : "refused:" + r.text; break }
        catch (e) { if (e.name !== "FlowTransactionBusyError") { outcome = "threw:" + e.message; break } await new Promise(r => setTimeout(r, 2)) }
      }
      console.log(outcome);
      await new Promise(r => setTimeout(r, 300));
    `
    const go = join(wt.stateHome, "go")
    const children = ["ses_race_a", "ses_race_b"].map((sid, index) => {
      const ready = join(wt.stateHome, `ready-${index}`)
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, WT: wt.worktree, SID: sid, GO: go, READY: ready, OTTER_STATE_HOME: wt.stateHome },
      })
      return { child, ready }
    })
    const deadline = Date.now() + 20_000
    while (children.some(({ ready }) => !existsSync(ready))) {
      if (Date.now() > deadline) throw new Error("race children never became ready")
      await new Promise((r) => setTimeout(r, 5))
    }
    writeFileSync(go, "go")
    const outputs = await Promise.all(children.map(async ({ child }) => {
      const text = await new Response(child.stdout).text()
      await child.exited
      return text.trim()
    }))
    const winners = outputs.filter((o) => o.startsWith("won:"))
    expect(outputs).toHaveLength(2)
    expect(winners).toHaveLength(2)
    const ids = winners.map(value => value.slice("won:".length))
    const sessionsRoot = join(stateRoot(wt.worktree), "sessions")
    const committedTrees = readdirSync(sessionsRoot).filter((sid) => existsSync(join(sessionsRoot, sid, "workflows"))).sort()
    expect(committedTrees).toEqual(["ses_race_a", "ses_race_b"])
    for (const sid of committedTrees) {
      const wf = readWorkflow(wt.worktree, sid)!
      expect(ids).toContain(wf.id)
      expect(readEvents(wt.worktree, undefined, sid).map(e => e.wf)).toEqual([wf.id, wf.id])
    }
  }, 60_000)
})

describe("terminal history", () => {
  test("a terminal revision stays index-bound and readable; the next start replaces only the pointer and retains every revision", () => {
    const d = deps()
    const first = started(d)
    const cancelled = requestCancel(d, first).result
    if (!cancelled.ok) throw new Error(cancelled.text)
    expect(cancelled.wf.phase).toBe("cancelled")
    expect(readWorkflowChecked(wt.worktree, S)).toMatchObject({ wf: { id: first.id, phase: "cancelled" } })
    expect(indexOf().revision).toBe(cancelled.wf.lastSeq)
    const firstRevisions = Object.fromEntries(revisionFiles(first).map((name) => [name, bytes(join(revisionsDir(first), name))!]))
    expect(Object.keys(firstRevisions)).toHaveLength(2)
    const archived = join(flowDir(wt.worktree, S), "archive", `${first.id}.json`)

    const second = startWorkflow(d, S, "command", "next", "user_command", "opencode")
    if (!second.ok) throw new Error(second.text)
    expect(indexOf()).toMatchObject({ id: second.wf.id, sessionID: S })
    for (const [name, content] of Object.entries(firstRevisions)) expect(bytes(join(revisionsDir(first), name))!.equals(content)).toBe(true)
    expect(JSON.parse(readFileSync(archived, "utf8"))).toMatchObject({ id: first.id, phase: "cancelled" })
    // the old workflow's events remain in the append-only log and keep their order
    const all = readFileSync(eventsPath(wt.worktree, S), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { seq: number; wf: string })
    expect(all.map((e) => e.seq)).toEqual([...all.map((e) => e.seq)].sort((a, b) => a - b))
    expect(all.some((e) => e.wf === first.id)).toBe(true)
  })

  test("restore reads its own session history and never adopts another session's current index", () => {
    const d = deps()
    const first = started(d)
    const cancelled = requestCancel(d, first).result
    if (!cancelled.ok) throw new Error(cancelled.text)
    admit(d, S2)
    const second = startWorkflow(d, S2, "command", "next", "user_command", "opencode")
    if (!second.ok) throw new Error(second.text)

    const mine = readSessionCommitted(wt.worktree, S)
    expect(mine).toMatchObject({ current: true, wf: { id: first.id, phase: "cancelled" } })
    expect(mine?.path).toBe(`sessions/${S}/workflows/${first.id}/revisions/${cancelled.wf.lastSeq}.json`)
    expect(mine?.sha256).toBe(sha256Hex(readFileSync(join(stateRoot(wt.worktree), mine!.path))))
    expect(readSessionCommitted(wt.worktree, S2)).toMatchObject({ current: true, wf: { id: second.wf.id } })
    expect(readSessionCommitted(wt.worktree, "ses_unrelated")).toBeNull()
  })

  test("retention: a hook-shaped session deletion in a settled state retains every snapshot, the index target and events", () => {
    const d = deps()
    const wf = started(d)
    const done = rewriteCommitted(wt.worktree, { phase: "done", stage: "terminal" }, S)
    const beforeIndex = bytes(workflowPath(wt.worktree, S))!
    const snapshots = Object.fromEntries(revisionFiles(done).map((name) => [name, bytes(join(revisionsDir(done), name))!]))
    const eventsBefore = bytes(eventsPath(wt.worktree, S))!
    const result = requestCancel(d, { sessionID: S, id: wf.id }).result
    expect(result === null || result.ok === false).toBe(true)
    expect(bytes(workflowPath(wt.worktree, S))!.equals(beforeIndex)).toBe(true)
    for (const [name, content] of Object.entries(snapshots)) expect(bytes(join(revisionsDir(done), name))!.equals(content)).toBe(true)
    expect(bytes(eventsPath(wt.worktree, S))!.subarray(0, eventsBefore.length).equals(eventsBefore)).toBe(true)
    expect(wf.id).toBe(done.id)
  })

  test("session deletion of an active workflow commits a cancelled revision and removes nothing", () => {
    const d = deps()
    const wf = started(d)
    const before = revisionFiles(wf)
    const eventsBefore = bytes(eventsPath(wt.worktree, S))!
    const result = requestCancel(d, { sessionID: S, id: wf.id }).result
    expect(result?.ok).toBe(true)
    expect(readWorkflow(wt.worktree, S)?.phase).toBe("cancelled")
    for (const name of before) expect(revisionFiles(wf)).toContain(name)
    expect(revisionFiles(wf).length).toBe(before.length + 1)
    expect(bytes(eventsPath(wt.worktree, S))!.subarray(0, eventsBefore.length).equals(eventsBefore)).toBe(true)
  })
})

describe("heartbeat sidecar", () => {
  test("a heartbeat changes only heartbeat.json: index, snapshots and events stay byte-identical", () => {
    const d = deps()
    const wf = started(d)
    const before = controlTree()
    const indexBefore = bytes(workflowPath(wt.worktree, S))!
    const eventsBefore = bytes(eventsPath(wt.worktree, S))!
    withFlowTransaction(wt.worktree, (tx) => writeHeartbeat(tx, wf, 123_456), S)
    const after = controlTree()
    const changed = Object.keys(after).filter((path) => before[path] !== after[path])
    expect(changed).toEqual([heartbeatPath(wt.worktree, S)])
    expect(bytes(workflowPath(wt.worktree, S))!.equals(indexBefore)).toBe(true)
    expect(bytes(eventsPath(wt.worktree, S))!.equals(eventsBefore)).toBe(true)
    expect(readHeartbeat(wt.worktree, wf, S)).toBe(123_456)
    expect(readWorkflow(wt.worktree, S)?.lastSeq).toBe(wf.lastSeq)
    expect(mode(heartbeatPath(wt.worktree, S))).toBe(0o600)
  })

  test("a heartbeat for another owner binding or workflow is ignored", () => {
    const wf = started()
    withFlowTransaction(wt.worktree, (tx) => writeHeartbeat(tx, { ...wf, owner: { ...wf.owner, instance: "other" } }, 5), S)
    expect(readHeartbeat(wt.worktree, wf, S)).toBeUndefined()
    withFlowTransaction(wt.worktree, (tx) => writeHeartbeat(tx, { ...wf, id: "wf_other" }, 5), S)
    expect(readHeartbeat(wt.worktree, wf, S)).toBeUndefined()
    writeFileSync(heartbeatPath(wt.worktree, S), "{not json")
    expect(readHeartbeat(wt.worktree, wf, S)).toBeUndefined()
  })

  test("the process heartbeat tick writes the sidecar only and the status owner liveness follows it", () => {
    const d = deps()
    const wf = started(d)
    stopHeartbeat()
    let tick: (() => void) | undefined
    const realSetInterval = globalThis.setInterval
    globalThis.setInterval = ((callback: () => void) => { tick = callback; return { unref() {} } }) as unknown as typeof setInterval
    try { ensureHeartbeat(d, "opencode", wf) } finally { globalThis.setInterval = realSetInterval }
    const before = controlTree()
    tick!()
    const after = controlTree()
    expect(Object.keys(after).filter((path) => before[path] !== after[path])).toEqual([heartbeatPath(wt.worktree, S)])
    expect(readHeartbeat(wt.worktree, wf, S)).toBeGreaterThan(0)
    const status = statusJson(d, S, { liveness: { instance: "watcher", ownerPidAlive: () => true, epochReleased: () => false } })
    expect(status.workflow?.ownerLive).toBe(true)
    expect(status.freshness.ownerHeartbeatAgeMs).toBeLessThan(5_000)
    expect(StatusReadError).toBeDefined()
  })
})

describe("transaction primitives", () => {
  test("commitRevision requires at least one event and a regular-file events log", () => {
    const wf = started()
    expect(() => withFlowTransaction(wt.worktree, (tx) => commitRevision(tx, wf, []), S)).toThrow("at least one event")
  })

  test("commit refuses to replace a non-terminal workflow of another id", () => {
    const wf = started()
    const intruder = newWorkflow(S, currentOwner(), "command", "x", "opencode")
    const before = controlTree()
    expect(() => withFlowTransaction(wt.worktree, (tx) => commitRevision(tx, intruder, [{ wf: intruder.id, type: "x", actor: "code" }]), S)).toThrow("still occupies the slot")
    // the refused commit appended nothing
    expect(controlTree()).toEqual(before)
    expect(readWorkflow(wt.worktree, S)?.id).toBe(wf.id)
  })

  test("commit refuses a stale caller snapshot", () => {
    const d = deps()
    const wf = started(d)
    const r = applyEvent(d, wf, "user_message", "user_message")
    if (!r.ok) throw new Error(r.text)
    const before = controlTree()
    expect(() => withFlowTransaction(wt.worktree, (tx) => commitRevision(tx, wf, [{ wf: wf.id, type: "x", actor: "code" }]), S)).toThrow("changed meanwhile")
    expect(controlTree()).toEqual(before)
  })

  test("the control directories are never removed by workflow operations", () => {
    const d = deps()
    const wf = started(d)
    const dirs = [flowDir(wt.worktree, S), join(stateRoot(wt.worktree), "sessions", S, "workflows", wf.id, "revisions")]
    requestCancel(d, wf).result
    for (const dir of dirs) expect(existsSync(dir)).toBe(true)
    expect(() => rmSync).not.toThrow()
  })
})

describe("review hardening", () => {
  test("orphan ranges stay bounded: many consecutive failed commits cost one range, not one entry per event", () => {
    const d = deps()
    const wf = started(d)
    const size0 = bytes(join(stateRoot(wt.worktree), indexOf().path))!.length
    __setCommitFaultHook((at) => { if (at === "snapshot-rename") throw new Error("boom") })
    for (let attempt = 0; attempt < 60; attempt++) expect(() => applyEvent(d, wf, "user_message", "user_message")).toThrow("boom")
    __setCommitFaultHook(null)
    const ok = applyEvent(d, wf, "user_message", "user_message")
    if (!ok.ok) throw new Error(ok.text)
    const committed = committedSnapshot(wt.worktree, S)
    expect(committed.orphanedEvents).toHaveLength(1)
    const [first, last] = committed.orphanedEvents![0]!
    expect(last - first + 1).toBeGreaterThanOrEqual(60)
    expect(bytes(join(stateRoot(wt.worktree), indexOf().path))!.length - size0).toBeLessThan(400)
    for (let seq = first; seq <= last; seq++) expect(readEvents(wt.worktree, wf.id, S).some((e) => e.seq === seq)).toBe(false)
  })

  test("identity and kind gates: bad ids, a non-zero baseline in a new slot are refused before any write", () => {
    const d = deps()
    const wf = started(d)
    const before = controlTree()
    const commit = (patch: Record<string, unknown>) => withFlowTransaction(wt.worktree, (tx) => commitRevision(tx, { ...wf, ...patch } as never, [{ wf: wf.id, type: "x", actor: "code" }]), S)
    expect(() => commit({ id: "../escape" })).toThrow("invalid workflow identity")
    expect(() => commit({ sessionID: "a/b" })).toThrow("belongs to another session")
    expect(controlTree()).toEqual(before)
    const cancelled = requestCancel(d, wf).result
    if (!cancelled.ok) throw new Error(cancelled.text)
    const afterCancel = controlTree()
    expect(() => commit({ id: "wf_new_slot", lastSeq: 5 })).toThrow("lastSeq 0")
    expect(controlTree()).toEqual(afterCancel)
  })

  test("a terminal legacy record with an unsafe id is not archived", () => {
    const d = deps()
    admit(d, S)
    mkdirSync(flowDir(wt.worktree, S), { recursive: true, mode: 0o700 })
    writeFileSync(workflowPath(wt.worktree, S), `${JSON.stringify({ version: 1, id: "../evil", sessionID: S, phase: "done", lastSeq: 1 })}\n`)
    expect(() => startWorkflow(d, S, "command", "next", "user_command", "opencode")).toThrow()
    expect(existsSync(join(flowDir(wt.worktree, S), "legacy"))).toBe(false)
  })

  test("cutover baseline: pre-v2 history in the event log is never turned into orphans", () => {
    const d = deps()
    admit(d, S)
    mkdirSync(flowDir(wt.worktree, S), { recursive: true, mode: 0o700 })
    const old = [1, 2, 3, 4, 5].map((seq) => JSON.stringify({ seq, at: 1, wf: "wf_old", type: "transition" })).join("\n") + "\n"
    writeFileSync(eventsPath(wt.worktree, S), old)
    writeFileSync(workflowPath(wt.worktree, S), `${JSON.stringify({ version: 1, id: "wf_old", sessionID: S, phase: "done", lastSeq: 2 })}\n`)
    const wf = started(d)
    expect(wf.orphanedEvents).toBeUndefined()
    expect(readEvents(wt.worktree, "wf_old", S).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  test("a torn event-log tail is never truncated: the next append starts on a fresh line", () => {
    const d = deps()
    const wf = started(d)
    const torn = Buffer.concat([bytes(eventsPath(wt.worktree, S))!, Buffer.from('{"seq":99,"at":1,"wf":"x","ty')])
    writeFileSync(eventsPath(wt.worktree, S), torn)
    const next = applyEvent(d, wf, "user_message", "user_message")
    if (!next.ok) throw new Error(next.text)
    const after = bytes(eventsPath(wt.worktree, S))!
    expect(after.subarray(0, torn.length).equals(torn)).toBe(true)
    expect(after.subarray(torn.length, torn.length + 1).toString()).toBe("\n")
    expect(readEvents(wt.worktree, wf.id, S).at(-1)?.seq).toBe(next.wf.lastSeq)
  })
})


// ---------------------------------------------------------------------------------------------- P6a S1 substrate

function planning(kind: "deep-interview" | "ralplan", id: string, extra: Record<string, unknown> = {}): never {
  const base = newWorkflow(S, currentOwner(), "command", "r", "opencode") as unknown as Record<string, unknown>
  delete base.entry; delete base.request; delete base.counters
  const stage = kind === "deep-interview" ? "crystallize" : "planner"
  return { ...base, id, kind, stage, phase: "planning", data: {}, lastSeq: 0, ...extra } as never
}

function commitPlanning(wf: unknown, type = "x", receipts: string[] = []) {
  return withFlowTransaction(wt.worktree, tx => commitRevision(tx, wf as never, [{ wf: (wf as { id: string }).id, type, actor: "code" }], Date.now(), { receipts }), S)
}

function writeArtifact(rel: string, text: string) {
  const abs = join(wt.worktree, rel)
  mkdirSync(join(abs, ".."), { recursive: true })
  writeFile2(abs, text)
  return { key: rel.split("/").pop()!, path: rel, sha256: sha256Text(text) }
}

describe("receipts (P6a S1)", () => {
  const input = { kind: "panel" as const, wid: "wf_r", sid: S, revision: 4, action: "panel-r1-contrarian", inputSha: "a".repeat(64), body: { findings: ["x"] } }

  test("write-once beside the snapshot, bound to wf/session/revision/input, verified on read", () => {
    const ref = writeReceipt(wt.worktree, input)
    expect(ref.startsWith(receiptRelativePath(S, "wf_r", 4, "panel-r1-contrarian"))).toBe(true)
    expect(receiptRelativePath(S, "wf_r", 4, "a")).toBe(`sessions/${S}/workflows/wf_r/receipts/4-a.json`)
    expect(writeReceipt(wt.worktree, input)).toBe(ref)
    expect(() => writeReceipt(wt.worktree, { ...input, body: { findings: ["y"] } })).toThrow("refusing overwrite")
    const ok = verifyReceiptRef(wt.worktree, ref, { sessionID: S, workflowID: "wf_r", kind: "panel", revision: 4, inputSha: input.inputSha })
    expect(ok.ok).toBe(true)
    const refuse = (binding: Record<string, unknown>) => verifyReceiptRef(wt.worktree, ref, { sessionID: S, workflowID: "wf_r", ...binding })
    expect(refuse({ workflowID: "wf_other" })).toMatchObject({ ok: false })
    expect(refuse({ sessionID: "ses_other" })).toMatchObject({ ok: false })
    expect(refuse({ kind: "consensus" })).toMatchObject({ ok: false, reason: "receipt kind mismatch" })
    expect(refuse({ revision: 5 })).toMatchObject({ ok: false, reason: "receipt is bound to another revision" })
    expect(refuse({ inputSha: "b".repeat(64) })).toMatchObject({ ok: false, reason: "receipt is bound to another input" })
  })

  test("tamper, deletion, forged hash, traversal and foreign paths are refused", () => {
    const ref = writeReceipt(wt.worktree, input)
    const rel = ref.slice(0, ref.lastIndexOf("#"))
    const abs = join(stateRoot(wt.worktree), rel)
    const binding = { sessionID: S, workflowID: "wf_r" }
    expect(verifyReceiptRef(wt.worktree, `${rel}#${"0".repeat(64)}`, binding)).toMatchObject({ ok: false, reason: "receipt bytes changed" })
    expect(verifyReceiptRef(wt.worktree, `sessions/${S}/workflows/wf_r/receipts/../receipts/4-panel-r1-contrarian.json#${"0".repeat(64)}`, binding)).toMatchObject({ ok: false })
    expect(verifyReceiptRef(wt.worktree, rel, binding)).toMatchObject({ ok: false })
    writeFileSync(abs, readFileSync(abs, "utf8").replace("wf_r", "wf_x"))
    expect(verifyReceiptRef(wt.worktree, ref, binding)).toMatchObject({ ok: false })
    rmSync(abs)
    expect(verifyReceiptRef(wt.worktree, ref, binding)).toMatchObject({ ok: false, reason: "receipt missing" })
    expect(() => writeReceipt(wt.worktree, { ...input, action: "../x" })).toThrow("invalid receipt")
    expect(() => writeReceipt(wt.worktree, { ...input, inputSha: "short" })).toThrow("invalid receipt")
  })

  test("commitRevision verifies every supplied receipt in the transaction and refuses without writing", () => {
    const wf = planning("deep-interview", "wf_di")
    const ref = writeReceipt(wt.worktree, { ...input, wid: "wf_di", action: "choice-topology" })
    const before = controlTree()
    expect(() => commitPlanning(wf, "x", [`${ref.slice(0, ref.lastIndexOf("#"))}#${"1".repeat(64)}`])).toThrow("receipt")
    expect(existsSync(eventsPath(wt.worktree, S))).toBe(false)
    expect(controlTree()).toEqual(before)
    const other = writeReceipt(wt.worktree, { ...input, wid: "wf_other", action: "choice-topology" })
    expect(() => commitPlanning(wf, "x", [other])).toThrow("receipt")
    const committed = commitPlanning(wf, "x", [ref])
    expect(committed.lastSeq).toBe(1)
  })
})

describe("required artifacts are verified inside commitRevision (P6a S1)", () => {
  test("deep-interview done needs spec.md recorded, hashed and verified; every failure leaves state untouched", () => {
    const live = commitPlanning(planning("deep-interview", "wf_a"))
    const spec = writeArtifact(".otter/workflows/ses_tx/wf_a/spec.md", "# spec\n")
    const done = (artifacts: unknown[]) => ({ ...live, stage: "terminal", phase: "done", artifacts })
    const snapshot = () => ({ index: bytes(workflowPath(wt.worktree, S)), events: bytes(eventsPath(wt.worktree, S)) })
    const before = snapshot()
    expect(() => commitPlanning(done([]))).toThrow("required artifact spec.md is not recorded")
    expect(() => commitPlanning(done([{ key: "spec.md", path: spec.path }]))).toThrow("no recorded hash")
    expect(() => commitPlanning(done([{ ...spec, sha256: "f".repeat(64) }]))).toThrow("hash mismatch")
    expect(() => commitPlanning(done([{ ...spec, path: ".otter/workflows/ses_tx/wf_a/missing.md" }]))).toThrow("missing")
    expect(() => commitPlanning(done([{ ...spec, path: "/etc/hosts" }]))).toThrow("relative")
    expect(snapshot().index!.equals(before.index!)).toBe(true)
    expect(snapshot().events!.equals(before.events!)).toBe(true)
    // edited after hashing: refused at commit even though the file exists
    writeFile2(join(wt.worktree, spec.path), "# edited\n")
    expect(() => commitPlanning(done([spec]))).toThrow("hash mismatch")
    writeFile2(join(wt.worktree, spec.path), "# spec\n")
    expect(commitPlanning(done([spec])).phase).toBe("done")
    // terminal written once; the committed state shows the verified artifact
    expect(readCommitted(wt.worktree, {}, S)).toMatchObject({ state: "ok", wf: { phase: "done" } })
  })

  test("ralplan pending_execution and done need pending-approval.md + consensus.json; PLANNING-STUCK needs best-plan.md; cancel needs nothing", () => {
    const live = commitPlanning(planning("ralplan", "wf_b"))
    const pa = writeArtifact(".otter/workflows/ses_tx/wf_b/pending-approval.md", "plan")
    const cj = writeArtifact(".otter/workflows/ses_tx/wf_b/consensus.json", "{}")
    const best = writeArtifact(".otter/workflows/ses_tx/wf_b/best-plan.md", "best")
    const pending = (artifacts: unknown[]) => ({ ...live, stage: "pending_execution", phase: "pending_approval", artifacts })
    expect(() => commitPlanning(pending([pa]))).toThrow("consensus.json is not recorded")
    expect(() => commitPlanning(pending([cj]))).toThrow("pending-approval.md is not recorded")
    expect(() => commitPlanning({ ...live, stage: "terminal", phase: "stuck", artifacts: [pa, cj] })).toThrow("best-plan.md is not recorded")
    expect(() => commitPlanning({ ...live, stage: "terminal", phase: "done", artifacts: [best] })).toThrow("pending-approval.md")
    const stuck = commitPlanning({ ...live, stage: "terminal", phase: "stuck", artifacts: [best] })
    expect(stuck.phase).toBe("stuck")
    const again = commitPlanning({ ...stuck, stage: "terminal", phase: "cancelled", artifacts: [] })
    expect(again.phase).toBe("cancelled")
    // a stuck (non-terminal) ralplan is still slot-occupying; the pending commit above never happened
    expect(existsSync(join(revisionsDir(live as never), `${live.lastSeq}.json`))).toBe(true)
  })

  test("plan commits are unaffected (no required artifacts)", () => {
    const d = deps()
    const wf = started(d)
    const next = applyEvent(d, wf, "user_message", "user_message")
    expect(next.ok).toBe(true)
  })
})

describe("commitHandoff (P6a S1)", () => {
  const SPEC_TEXT = "# spec\nambiguity .04\n"

  function setup() {
    const live = commitPlanning(planning("deep-interview", "wf_di"))
    const spec = writeArtifact(".otter/workflows/ses_tx/wf_di/spec.md", SPEC_TEXT)
    const predecessor = { ...live, stage: "terminal", phase: "done", artifacts: [spec] } as never as WorkflowEnvelopeLike
    const successor = planning("ralplan", "wf_rp") as WorkflowEnvelopeLike
    return { live, spec, predecessor, successor }
  }
  type WorkflowEnvelopeLike = Parameters<typeof commitHandoff>[1]["predecessor"]
  const input = (s: ReturnType<typeof setup>) => ({
    predecessor: s.predecessor, artifactKey: "spec.md", successor: s.successor,
    predecessorEvents: [{ wf: "wf_di", type: "transition", actor: "code" as const }, { wf: "wf_di", type: "spec_written", actor: "code" as const }],
    successorEvents: [{ wf: "wf_rp", type: "created", actor: "code" as const }],
  })
  const handoff = (i: ReturnType<typeof input>) => withFlowTransaction(wt.worktree, tx => commitHandoff(tx, i), S)

  test("one index rename: successor bound with lineage, predecessor terminal snapshot + archive retained, seqs contiguous", () => {
    const s = setup()
    const result = handoff(input(s))
    const read = readCommitted(wt.worktree, {}, S)
    expect(read.state).toBe("ok")
    if (read.state !== "ok") return
    expect(read.wf.id).toBe("wf_rp")
    expect(read.index).toMatchObject({ id: "wf_rp", kind: "ralplan", revision: result.successor.lastSeq })
    expect(read.wf.lineage).toEqual({ predecessor: { id: "wf_di", kind: "deep-interview", revision: result.predecessor.lastSeq, artifact: { path: s.spec.path, sha256: s.spec.sha256 } } })
    expect(result.successor.lastSeq).toBe(result.predecessor.lastSeq + 1)
    const pred = JSON.parse(readFileSync(join(stateRoot(wt.worktree), `sessions/${S}/workflows/wf_di/revisions/${result.predecessor.lastSeq}.json`), "utf8"))
    expect(pred).toMatchObject({ phase: "done", stage: "terminal" })
    expect(JSON.parse(readFileSync(join(flowDir(wt.worktree, S), "archive", "wf_di.json"), "utf8"))).toMatchObject({ id: "wf_di", phase: "done" })
    const seqs = [...readEvents(wt.worktree, "wf_di", S), ...readEvents(wt.worktree, "wf_rp", S)].map(e => e.seq).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1))
    expect(readSessionCommitted(wt.worktree, S)?.wf.id).toBe("wf_rp")
  })

  const HANDOFF_STAGES: CommitStage[] = [
    "events-fsync", "snapshot-write", "snapshot-fsync", "snapshot-rename", "snapshot-dirfsync", "archive-write",
    "index-write", "index-fsync", "index-rename", "index-dirfsync",
  ]
  for (const stage of HANDOFF_STAGES) {
    test(`a fault at ${stage}: predecessor stays index-bound (or successor fully committed); never neither, never two active; retry is idempotent`, () => {
      const s = setup()
      let hits = 0
      __setCommitFaultHook(at => { if (at === stage && ++hits === 1) throw new Error(`injected ${at}`) })
      expect(() => handoff(input(s))).toThrow(`injected ${stage}`)
      __setCommitFaultHook(null)
      const read = readCommitted(wt.worktree, {}, S)
      expect(read.state).toBe("ok")
      if (read.state !== "ok") return
      const published = stage === "index-dirfsync"
      if (published) {
        expect(read.wf).toMatchObject({ id: "wf_rp", kind: "ralplan" })
      } else {
        // never a gap: the live DI is still the occupant, at its old revision, and still active
        expect(read.wf).toMatchObject({ id: "wf_di", phase: "planning", stage: "crystallize", lastSeq: s.live.lastSeq })
        // a competing start is refused while the DI is index-bound
        expect(() => commitPlanning(planning("deep-interview", "wf_intruder"))).toThrow("still occupies the slot")
      }
      expect(read.index.sha256).toBe(sha256Hex(read.bytes))
      if (!published) {
        const retry = withFlowTransaction(wt.worktree, tx => commitHandoff(tx, input(s)), S)
        expect(retry.successor.id).toBe("wf_rp")
        const after = readCommitted(wt.worktree, {}, S)
        expect(after).toMatchObject({ state: "ok", wf: { id: "wf_rp", lineage: { predecessor: { id: "wf_di" } } } })
        // exactly one active workflow, and the failed attempt's rows are recorded orphans, not committed work
        if (after.state === "ok") {
          for (const [first, last] of after.wf.orphanedEvents ?? []) {
            expect([...readEvents(wt.worktree, "wf_di", S), ...readEvents(wt.worktree, "wf_rp", S)].some(e => e.seq >= first && e.seq <= last)).toBe(false)
          }
        }
      } else {
        expect(() => handoff(input(s))).toThrow("changed meanwhile")
      }
    })
  }

  test("refusals change nothing: stale predecessor, foreign session/owner, held stop, unverified or edited spec, bad shapes", () => {
    const s = setup()
    const before = controlTree()
    const refuse = (patch: Record<string, unknown>, message: string, source = input(s)) =>
      expect(() => handoff({ ...source, ...patch } as never)).toThrow(message)
    refuse({ predecessor: { ...s.predecessor, lastSeq: s.live.lastSeq + 1 } }, "changed meanwhile")
    refuse({ predecessor: { ...s.predecessor, id: "wf_ghost" } }, "changed meanwhile")
    refuse({ predecessor: { ...s.predecessor, phase: "planning" } }, "done terminal form")
    refuse({ successor: { ...s.successor, sessionID: "ses_other" } }, "another session")
    refuse({ successor: { ...s.successor, owner: { instance: "other", pid: 1 } } }, "owner epoch differs")
    refuse({ successor: { ...s.successor, lastSeq: 3 } }, "lastSeq 0")
    refuse({ successor: { ...s.successor, id: "wf_di" } }, "invalid handoff identity")
    refuse({ successor: { ...s.successor, lineage: { predecessor: {} } } }, "stamped by the commit")
    refuse({ successor: { ...s.successor, stopIntent: { kind: "pause", token: "t", requestedFrom: { phase: "planning", stage: "planner" }, checkpoint: null, reason: "r" } } }, "start live")
    refuse({ predecessorEvents: [] }, "events for both")
    refuse({ artifactKey: "nope.md" }, "not recorded with a hash")
    // the committed DI is paused/stopping: handoff refuses (held)
    const stopped = rewriteCommittedKind({ stopIntent: { kind: "pause", token: "t", requestedFrom: { phase: "planning", stage: "crystallize" }, checkpoint: null, reason: "r" } })
    expect(stopped).toBeTruthy()
    expect(() => handoff({ ...input(s), predecessor: { ...s.predecessor, lastSeq: stopped.lastSeq } as never })).toThrow("stop is pending")
    expect(() => handoff({ ...input(s), predecessor: { ...s.predecessor, lastSeq: stopped.lastSeq, owner: { instance: "x", pid: 2 } } as never })).toThrow("owner epoch")
    rewriteCommittedKind({ stopIntent: null })
    writeFile2(join(wt.worktree, s.spec.path), "# edited after verification\n")
    refuse({}, "hash mismatch")
    expect(readCommitted(wt.worktree, {}, S)).toMatchObject({ state: "ok", wf: { id: "wf_di" } })
    expect(Object.keys(controlTree()).some(path => path.includes("wf_rp"))).toBe(false)
    void before
  })

  function rewriteCommittedKind(patch: Record<string, unknown>) {
    const read = readCommitted(wt.worktree, {}, S)
    if (read.state !== "ok") throw new Error("no committed")
    const wf = { ...read.wf, ...patch }
    const out = Buffer.from(`${JSON.stringify(wf)}\n`, "utf8")
    const rel = `sessions/${wf.sessionID}/workflows/${wf.id}/revisions/${wf.lastSeq}.json`
    writeFile2(join(stateRoot(wt.worktree), rel), out)
    writeFile2(workflowPath(wt.worktree, S), `${JSON.stringify({ version: 2, id: wf.id, sessionID: wf.sessionID, kind: wf.kind, revision: wf.lastSeq, path: rel, sha256: sha256Hex(out) })}\n`)
    return wf as { lastSeq: number }
  }

  test("a competing start from the same session is refused during the fault window and after the handoff only a terminal occupant yields the slot", () => {
    const s = setup()
    __setCommitFaultHook(at => { if (at === "index-rename") throw new Error("boom") })
    expect(() => handoff(input(s))).toThrow("boom")
    __setCommitFaultHook(null)
    expect(() => commitPlanning(planning("deep-interview", "wf_race", { sessionID: S }))).toThrow("still occupies the slot")
    handoff(input(s))
    expect(() => commitPlanning(planning("deep-interview", "wf_race2", { sessionID: S }))).toThrow("still occupies the slot")
  })
})

describe("status artifact read budget (P6a S1)", () => {
  test("refs are sliced before any read, bytes are budgeted, and over-budget refs are unverified (budget) never verified", () => {
    const refs = Array.from({ length: 20 }, (_, i) => writeArtifact(`.otter/out/f${i}.txt`, `content-${i}`))
    const all = describeArtifactsBudgeted(wt.worktree, { artifacts: refs })
    expect(all.items).toHaveLength(16)
    expect(all.omitted).toBe(4)
    expect(all.items.every(item => item.state === "verified")).toBe(true)
    const tight = describeArtifactsBudgeted(wt.worktree, { artifacts: refs }, { bytes: 25 })
    expect(tight.items.filter(item => item.state === "verified").length).toBeLessThanOrEqual(2)
    const over = tight.items.find(item => item.state === "unverified")!
    expect(over.reason).toBe("unverified (budget)")
    expect(tight.bytes).toBeLessThanOrEqual(25)
    const big = writeArtifact(".otter/out/big.bin", "x".repeat(100))
    const budgeted = describeArtifactsBudgeted(wt.worktree, { artifacts: [big] }, { bytes: 50 })
    expect(budgeted.items[0]).toMatchObject({ state: "unverified" })
  })

  test("status reads a committed deep-interview / ralplan envelope as a generic view (no longer invalid_state) with no counters", () => {
    const d = deps()
    admit(d, S)
    const live = commitPlanning(planning("ralplan", "wf_view"))
    const art = writeArtifact(".otter/workflows/ses_tx/wf_view/note.md", "n")
    commitPlanning({ ...live, artifacts: [art] })
    const status = statusJson(d, S)
    expect(status.workflow).toMatchObject({ id: "wf_view", kind: "ralplan", stage: "planner", phase: "planning", stopIntent: null })
    expect(status.workflow?.counters).toBeUndefined()
    expect(status.workflow?.artifacts).toEqual([{ key: "note.md", path: art.path, state: "verified" }])
    expect(readWorkflowChecked(wt.worktree, S)).toMatchObject({ wf: null, occupiedBy: { id: "wf_view", kind: "ralplan" } })
    expect(readWorkflowChecked(wt.worktree, S).corrupt).toBeUndefined()
    expect(readWorkflow(wt.worktree, S)).toBeNull()
    const start = startWorkflow(d, S, "command", "x", "user_command", "opencode")
    expect(start.ok).toBe(false)
  })
})
