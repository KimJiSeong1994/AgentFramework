import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getOwnedSession, inspectSessionAttachment, inspectSessions, openSession, readSessionMetadata, replaySession } from "../src/sessions/store.ts"
import { ensureDurableDirectory } from "../src/state/durable.ts"
import { sessionDir, stateRoot } from "../src/state/store.ts"
import { readEvents, readWorkflow } from "../src/flow/state.ts"
import { tempWorktree } from "./guards-helpers.ts"
import { TranscriptModel } from "../src/tui/transcript-model.ts"
import { restoreTranscript } from "../src/tui/session-transcript.ts"

let wt: ReturnType<typeof tempWorktree>
beforeEach(() => { wt = tempWorktree() })
afterEach(() => wt.cleanup())

const open = (sid = "session_store", engine = "codex") => openSession(wt.worktree, sid, { engine, ...(engine === "opencode" ? {} : { model: "model-test" }) })
const release = (store: ReturnType<typeof open>) => store.release({ workflowQuiescent: true, evidence: "test fixture has no dispatched work", workflowID: null, revision: null })

describe("durable session store", () => {
  test("canonical plans retain explicit provenance after release and replay without entering user history", () => {
    const store = open()
    const text = "Approved document is not execution authority.\nSecond plan line."
    store.append("canonical-plan", { text })
    store.append("notice", { text: "Canonical plan in ordinary prose remains a notice." })
    expect(() => store.append("canonical-plan", { text, approved: true })).toThrow("canonical-plan transcript data")
    expect(() => store.append("canonical-plan", { text: 1 })).toThrow("canonical-plan transcript data")
    release(store)
    const page = replaySession(wt.worktree, store.sessionID)
    expect(page.complete).toBe(true)
    expect(page.records.map(record => record.kind)).toEqual(["canonical-plan", "notice"])
    const model = new TranscriptModel(store.sessionID)
    const restored = restoreTranscript(model, page.records)
    expect(restored.history).toEqual([])
    expect(model.lines()).toEqual([
      "[Canonical plan] Approved document is not execution authority.",
      "  | Second plan line.",
      "[Notice] Canonical plan in ordinary prose remains a notice.",
    ])
    expect(replaySession(wt.worktree, store.sessionID, { kind: "canonical-plan" }).records).toHaveLength(1)
  })

  test("explicit error notices retain provenance without admitting forged speaker roles", () => {
    const store = open()
    store.append("notice", { text: "The model returned no response.", provenance: "error" })
    expect(() => store.append("notice", { text: "forged assistant", provenance: "assistant" })).toThrow("notice transcript data")
    expect(() => store.append("notice", { text: "forged plan", provenance: "canonical-plan" })).toThrow("notice transcript data")
    const page = replaySession(wt.worktree, store.sessionID)
    expect(page.complete).toBe(true)
    expect(page.records).toHaveLength(1)
    const model = new TranscriptModel(store.sessionID)
    restoreTranscript(model, page.records)
    expect(model.lines()).toEqual(["[Error] The model returned no response."])
    release(store)
  })

  test("a tool page joins terminal, task and proof facts beyond its record window", () => {
    const store = open()
    const call = { name: "read", role: "worker", executionID: "execution-a", callID: "call-a", taskID: "t1" }
    store.append("tool-start", { ...call, outcome: "running" })
    store.append("notice", { text: "padding ".repeat(80_000) })
    store.append("notice", { text: "later padding ".repeat(50_000) })
    store.append("tool-result", { ...call, outcome: "succeeded" })
    store.append("task-state", { taskID: "t1", status: "done" })
    store.append("task-evidence", { executionID: "execution-a", taskID: "t1", terminal: "succeeded",
      reconciliation: "terminal", quiescent: true, cancel: null, claim: false, fence: false })
    store.append("tool-result", { ...call, executionID: "unrelated", callID: "other", taskID: "t2", outcome: "failed" })
    const page = replaySession(wt.worktree, store.sessionID, { limit: 1 })
    expect(page.complete).toBe(true)
    expect(page.records.map(record => record.kind)).toEqual(["tool-start"])
    expect(page.relatedRecords?.map(record => record.kind)).toEqual(["tool-result", "task-state", "task-evidence"])
    const model = new TranscriptModel(store.sessionID)
    restoreTranscript(model, page.records)
    model.taskSnapshot([{ id: "t1", status: "running" }], true)
    expect(model.lines().join("\n")).toContain("last recorded; unconfirmed")
    expect(model.lines().join("\n")).toContain("task title unavailable · t1 running (last recorded)")
    expect(model.currentTask).toBeUndefined()
    restoreTranscript(model, page.relatedRecords ?? [])
    expect(model.items).toHaveLength(1)
    expect(model.items[0]).toMatchObject({ kind: "tool", outcome: "succeeded", taskID: "t1" })
    expect(model.currentTask).toBeUndefined()
    model.toggle(model.items[0]!.id)
    expect(model.lines().join("\n")).toContain("Quiescent: observed")
    expect(model.lines().join("\n")).toContain("task title unavailable · t1 done")
    const searched = replaySession(wt.worktree, store.sessionID, { query: "read t1 done" })
    expect(searched.records.map(record => record.kind)).toEqual(["tool-start", "tool-result"])
    release(store)
  })

  test("creates a fresh un-restored session and refuses same-process second writer", () => {
    const store = open()
    expect(store.restored).toBe(false)
    expect(store.metadata.held).toBe(true)
    expect(getOwnedSession(wt.worktree, store.sessionID)).toBe(store)
    expect(() => open()).toThrow(/already attached/)
    const independent = open("different_session")
    expect(independent.restored).toBe(false)
    release(store)
    expect(getOwnedSession(wt.worktree, store.sessionID)).toBeUndefined()
    expect(readSessionMetadata(wt.worktree, store.sessionID)?.held).toBe(true)
    release(independent)
  })

  test("initial admission can clear only once and cannot bypass a later hold", () => {
    const store = open()
    expect(() => store.clearHold({ authorized: true, reason: "explicit-resume" })).toThrow("validated explicit Resume proof")
    store.clearHold({ authorized: true, reason: "new-session" })
    expect(readSessionMetadata(wt.worktree, store.sessionID)?.held).toBe(false)
    store.hold("pending-stop")
    expect(() => store.clearHold({ authorized: true, reason: "new-session" })).toThrow("validated explicit Resume proof")
    expect(() => store.clearHold({ authorized: true, reason: "explicit-resume" })).toThrow("validated explicit Resume proof")
    expect(readSessionMetadata(wt.worktree, store.sessionID)?.held).toBe(true)
    release(store)
  })

  test("serializes simultaneous stale-epoch reclaimers across real processes", async () => {
    const sid = "stale_reclaim_race"
    const env = {
      ...process.env,
      LCA_STATE_HOME: wt.stateHome,
      SESSION_REBIND_ADMISSION_URL: new URL("../src/sessions/admission.ts", import.meta.url).href,
      SESSION_REBIND_RUNTIME_URL: new URL("../src/hosts/opencode-runtime.ts", import.meta.url).href,
      SESSION_REBIND_HELPERS_URL: new URL("./guards-helpers.ts", import.meta.url).href,
      SESSION_REBIND_FLOW_URL: new URL("../src/flow/state.ts", import.meta.url).href,
      SESSION_REBIND_FIXTURE_URL: new URL("./commit-fixture.ts", import.meta.url).href,
      SESSION_REBIND_OWNER_URL: new URL("../src/flow/owner.ts", import.meta.url).href,
      SESSION_STORE_WORKTREE: wt.worktree,
      SESSION_STORE_ID: sid,
    }
    const seedProgram = `
      (async () => {
        const [{ fakeClient, makeDeps }, { getOpenCodeRuntime }, { attachAdmission, holdAdmission }, owner, flow, fixture] = await Promise.all([
          import(process.env.SESSION_REBIND_HELPERS_URL),
          import(process.env.SESSION_REBIND_RUNTIME_URL),
          import(process.env.SESSION_REBIND_ADMISSION_URL),
          import(process.env.SESSION_REBIND_OWNER_URL),
          import(process.env.SESSION_REBIND_FLOW_URL),
          import(process.env.SESSION_REBIND_FIXTURE_URL),
        ]);
        const client = fakeClient({ promptAsync: true });
        client.session.get = async ({ path }) => ({ data: { id: path.id, directory: process.env.SESSION_STORE_WORKTREE, time: { created: 1, updated: 2 } } });
        const runtime = getOpenCodeRuntime(makeDeps(client, process.env.SESSION_STORE_WORKTREE));
        const store = attachAdmission(runtime, process.env.SESSION_STORE_ID, { engine: "opencode" });
        const workflow = flow.withFlowTransaction(process.env.SESSION_STORE_WORKTREE, tx =>
          fixture.writeWorkflow(tx, flow.newWorkflow(process.env.SESSION_STORE_ID,
            owner.currentOwner(Date.now(), store.epoch, process.pid), "command", "concurrent held-owner rebind", "opencode")));
        holdAdmission(process.env.SESSION_STORE_WORKTREE, process.env.SESSION_STORE_ID, "restore");
        process.stdout.write(JSON.stringify({ kind: "seed", epoch: store.epoch, pid: process.pid, workflowID: workflow.id, revision: workflow.lastSeq }) + "\\n");
        setInterval(() => {}, 1000);
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `
    const seed = Bun.spawn([process.execPath, "-e", seedProgram], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" })
    const seedOutput = lineReader(seed.stdout)
    const children: Array<ReturnType<typeof Bun.spawn>> = [seed]
    try {
      const seeded = JSON.parse(await withTimeout(readLine(seedOutput), 15_000)) as { kind: string; epoch: string; pid: number; workflowID: string; revision: number }
      expect(seeded).toMatchObject({ kind: "seed", pid: seed.pid })
      expect(readWorkflow(wt.worktree)).toMatchObject({
        id: seeded.workflowID,
        sessionID: sid,
        engine: "opencode",
        owner: { instance: seeded.epoch, pid: seeded.pid },
      })
      expect(readSessionMetadata(wt.worktree, sid)?.held).toBe(true)
      seed.kill("SIGKILL")
      await seed.exited
      expect(inspectSessionAttachment(wt.worktree, sid, seeded.epoch)).toMatchObject({ state: "attached", identity: "dead", pid: seeded.pid })
      expect(readSessionMetadata(wt.worktree, sid)?.held).toBe(true)

      const shared = join(wt.stateHome, "stale-reclaim-race")
      mkdirSync(shared)
      const go = join(shared, "go")
      const finish = join(shared, "finish")
      const exit = join(shared, "exit")
      const workers = [0, 1].map(index => {
        const ready = join(shared, `ready-${index}`)
        const program = `
          const { existsSync, writeFileSync } = await import("node:fs");
          const [{ fakeClient, makeDeps }, { getOpenCodeRuntime }, { attachAdmission }, flow] = await Promise.all([
            import(process.env.SESSION_REBIND_HELPERS_URL),
            import(process.env.SESSION_REBIND_RUNTIME_URL),
            import(process.env.SESSION_REBIND_ADMISSION_URL),
            import(process.env.SESSION_REBIND_FLOW_URL),
          ]);
          const waitFor = async path => { while (!existsSync(path)) await new Promise(resolve => setTimeout(resolve, 5)); };
          (async () => {
            writeFileSync(process.env.SESSION_STORE_READY, String(process.pid));
            await waitFor(process.env.SESSION_STORE_GO);
            try {
              const client = fakeClient({ promptAsync: true });
              client.session.get = async ({ path }) => ({ data: { id: path.id, directory: process.env.SESSION_STORE_WORKTREE, time: { created: 1, updated: 2 } } });
              const runtime = getOpenCodeRuntime(makeDeps(client, process.env.SESSION_STORE_WORKTREE));
              const store = attachAdmission(runtime, process.env.SESSION_STORE_ID, { engine: "opencode" });
              const workflow = flow.readWorkflow(process.env.SESSION_STORE_WORKTREE);
              process.stdout.write(JSON.stringify({ kind: "won", epoch: store.epoch, pid: process.pid, held: store.metadata.held, workflowOwner: workflow?.owner.instance }) + "\\n");
              await waitFor(process.env.SESSION_STORE_FINISH);
              const record = store.append("user", { text: "one concurrent winner" }, "race-winner");
              process.stdout.write(JSON.stringify({ kind: "persisted", seq: record.seq, epoch: store.epoch }) + "\\n");
              await waitFor(process.env.SESSION_STORE_EXIT);
            } catch (error) {
              process.stdout.write(JSON.stringify({ kind: "refused", message: String(error) }) + "\\n");
            }
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `
        const child = Bun.spawn([process.execPath, "-e", program], {
          cwd: process.cwd(),
          env: { ...env, SESSION_STORE_READY: ready, SESSION_STORE_GO: go, SESSION_STORE_FINISH: finish, SESSION_STORE_EXIT: exit },
          stdout: "pipe",
          stderr: "pipe",
        })
        children.push(child)
        return { child, ready, output: lineReader(child.stdout) }
      })

      await Promise.all(workers.map(worker => waitForFile(worker.ready, 15_000)))
      writeFileSync(go, "start\n")
      const lines = await withTimeout(Promise.all(workers.map(worker => readLine(worker.output))), 15_000)
      const results = lines.map(line => JSON.parse(line) as { kind: string; epoch?: string; pid?: number; held?: boolean; workflowOwner?: string; message?: string })
      expect(results.filter(result => result.kind === "won")).toHaveLength(1)
      expect(results.filter(result => result.kind === "refused")).toHaveLength(1)
      const winnerResult = results.find(result => result.kind === "won")
      const loserResult = results.find(result => result.kind === "refused")
      if (!winnerResult || typeof winnerResult.epoch !== "string" || typeof winnerResult.pid !== "number" || typeof winnerResult.workflowOwner !== "string" ||
          !loserResult || typeof loserResult.message !== "string") throw new Error(`invalid race receipts: ${JSON.stringify(results)}`)
      expect(loserResult.message).toMatch(/attached|reclaim|lock/i)
      expect(winnerResult.held).toBe(true)
      expect(winnerResult.workflowOwner).toBe(winnerResult.epoch)
      const winnerWorker = workers.find(worker => worker.child.pid === winnerResult.pid)
      if (!winnerWorker) throw new Error("race winner process was not found")
      const winnerPID = winnerResult.pid
      expect(() => process.kill(winnerPID, 0)).not.toThrow()

      const lock = JSON.parse(readFileSync(join(sessionDir(wt.worktree, sid), "attach.lock"), "utf8")) as { epoch: string }
      expect(lock.epoch).toBe(winnerResult.epoch)
      expect(readSessionMetadata(wt.worktree, sid)?.held).toBe(true)
      expect(inspectSessionAttachment(wt.worktree, sid, winnerResult.epoch)).toMatchObject({ state: "attached", identity: "live", pid: winnerPID })
      const reboundWorkflow = readWorkflow(wt.worktree)
      expect(reboundWorkflow).toMatchObject({ id: seeded.workflowID, sessionID: sid, owner: { instance: winnerResult.epoch, pid: winnerPID } })
      const reboundRows = readEvents(wt.worktree, seeded.workflowID).filter(event => event.type === "owner_reattached")
      expect(reboundRows).toHaveLength(1)
      expect(reboundRows[0]).toMatchObject({ data: { sid, wid: seeded.workflowID, fromEpoch: seeded.epoch, toEpoch: winnerResult.epoch, expectedRevision: seeded.revision, proofKind: "dead" } })

      writeFileSync(finish, "append\n")
      const persisted = JSON.parse(await withTimeout(readLine(winnerWorker.output), 15_000)) as { kind: string; seq: number; epoch: string }
      expect(persisted).toEqual({ kind: "persisted", seq: 1, epoch: winnerResult.epoch })
      expect(replaySession(wt.worktree, sid)).toMatchObject({ complete: true, totalRecords: 1, records: [{ eventID: "race-winner" }] })
      expect(() => process.kill(winnerPID, 0)).not.toThrow()
      writeFileSync(exit, "exit\n")
      await Promise.all(workers.map(worker => worker.child.exited))
    } finally {
      for (const child of children) {
        try { child.kill("SIGKILL") } catch { /* already exited */ }
      }
      await Promise.all(children.map(child => child.exited))
    }
  })


  test("requires model except for OpenCode and holds every restored attachment", () => {
    expect(() => openSession(wt.worktree, "missing_model", { engine: "codex" })).toThrow(/model is required/)
    const first = open("opencode_session", "opencode")
    expect(first.metadata).toMatchObject({ engine: "opencode", held: true })
    release(first)
    const restored = openSession(wt.worktree, "opencode_session")
    expect(restored.restored).toBe(true)
    expect(restored.metadata.held).toBe(true)
    expect(() => restored.clearHold({ authorized: true, reason: "explicit test admission" })).toThrow("validated explicit Resume proof")
    expect(() => restored.clearHold({ authorized: true, reason: "new-session" })).toThrow("validated explicit Resume proof")
    expect(readSessionMetadata(wt.worktree, "opencode_session")?.held).toBe(true)
    release(restored)
  })

  test("inspects attached identity and records workflow-bound release receipts", () => {
    const store = open()
    expect(inspectSessionAttachment(wt.worktree, store.sessionID, store.epoch)).toMatchObject({
      state: "attached", epoch: store.epoch, sessionID: store.sessionID, pid: process.pid, identity: "live",
    })
    store.release({ workflowQuiescent: true, evidence: "workflow is quiescent", workflowID: "wf-session", revision: 17 })
    expect(inspectSessionAttachment(wt.worktree, store.sessionID, store.epoch)).toMatchObject({
      state: "released", epoch: store.epoch, workflowID: "wf-session", revision: 17, releaseEvidence: "workflow is quiescent",
    })
  })

  test("segments at 1 MiB and supports bounded earliest, newest, token search, and kind-filtered replay", () => {
    const store = open()
    store.append("user", { text: `EARLIEST_NEEDLE alpha ${"a".repeat(600_000)}` }, "first")
    store.append("tool-start", { name: "read", role: "worker", executionID: "exec-1", callID: "call-1", taskID: "task-1", outcome: "running" }, "tool-start")
    store.append("tool-result", { name: "read", role: "worker", executionID: "exec-1", callID: "call-1", taskID: "task-1", outcome: "failed" }, "tool-result")
    store.append("assistant", { text: `middle answer ${"m".repeat(600_000)}` }, "middle")
    store.append("user", { text: `SECOND_USER alpha ${"u".repeat(600_000)}` }, "second-user")
    store.append("assistant", { text: `final answer ${"z".repeat(600_000)}` }, "last")
    expect(existsSync(join(sessionDir(wt.worktree, store.sessionID), "segments000004.jsonl"))).toBe(true)

    const earliest = replaySession(wt.worktree, store.sessionID, { limit: 1 })
    expect(earliest).toMatchObject({ complete: true, totalRecords: 6, records: [{ eventID: "first" }], nextOffset: 1 })
    const latest = replaySession(wt.worktree, store.sessionID, { order: "desc", limit: 2 })
    expect(latest.records.map(record => record.eventID)).toEqual(["last", "second-user"])
    expect(latest.complete).toBe(true)
    expect(replaySession(wt.worktree, store.sessionID, { order: "desc", offset: 1, limit: 1 }).records[0]?.eventID).toBe("second-user")
    expect(replaySession(wt.worktree, store.sessionID, { query: "FINAL answer", order: "desc", limit: 2 }).records.map(record => record.eventID)).toEqual(["last"])
    const searched = replaySession(wt.worktree, store.sessionID, { query: "READ failed", order: "desc", limit: 4 })
    expect(searched.records.map(record => record.eventID)).toEqual(["tool-result"])
    expect(searched.complete).toBe(true)
    const oldestSearch = replaySession(wt.worktree, store.sessionID, { query: "alpha EARLIEST_NEEDLE", order: "desc", limit: 2 })
    expect(oldestSearch.records.map(record => record.eventID)).toEqual(["first"])
    expect(oldestSearch).toMatchObject({ complete: true, totalRecords: 6 })
    const onlyUsers = replaySession(wt.worktree, store.sessionID, { kind: "user", order: "desc", limit: 2 })
    expect(onlyUsers.records.map(record => record.eventID)).toEqual(["second-user", "first"])
    release(store)
  })

  test("deduplicates identical event IDs and refuses conflicting reuse or tool bodies", () => {
    const store = open()
    const first = store.append("user", { text: "same" }, "event-1")
    expect(store.append("user", { text: "same" }, "event-1")).toEqual(first)
    expect(() => store.append("user", { text: "different" }, "event-1")).toThrow(/conflicts/)
    expect(() => store.append("tool-start", { name: "read", role: "worker", executionID: "exec", callID: "call", taskID: "task", outcome: "running", input: "secret" } as never)).toThrow(/canonical summary shape/)
    release(store)
  })

  test("preserves multiline user, assistant, notice, and unsent draft text exactly", () => {
    const store = open()
    const userText = "first line\nsecond line\tindented"
    const assistantText = "answer line one\nanswer line two"
    const noticeText = "banner line one\n\nbanner line three"
    const draft = "draft line one\ndraft line two"
    const queued = ["queued one\ncontinued", "queued two"]
    store.append("user", { text: userText }, "multiline-user")
    store.append("assistant", { text: assistantText }, "multiline-assistant")
    store.append("notice", { text: noticeText }, "multiline-notice")
    store.append("notice", { draft, queued }, "multiline-draft")
    const replay = replaySession(wt.worktree, store.sessionID)
    expect(replay.complete).toBe(true)
    expect(replay.records.map(record => record.data)).toEqual([
      { text: userText }, { text: assistantText }, { text: noticeText }, { draft, queued },
    ])
    release(store)
  })

  test("refuses segment gaps and interior row corruption for admission and marks replay incomplete", () => {
    const gapStore = open("gap_session")
    gapStore.append("user", { text: "x".repeat(600_000) }, "gap-1")
    gapStore.append("assistant", { text: "y".repeat(600_000) }, "gap-2")
    const gapDir = sessionDir(wt.worktree, "gap_session")
    release(gapStore)
    rmSync(join(gapDir, "segments000001.jsonl"))
    expect(replaySession(wt.worktree, "gap_session").complete).toBe(false)
    expect(() => openSession(wt.worktree, "gap_session")).toThrow(/corrupt/)

    const corruptStore = open("corrupt_session")
    corruptStore.append("user", { text: "first" }, "corrupt-1")
    corruptStore.append("assistant", { text: "second" }, "corrupt-2")
    const corruptDir = sessionDir(wt.worktree, "corrupt_session")
    release(corruptStore)
    const segment = join(corruptDir, "segments000001.jsonl")
    const bytes = readFileSync(segment, "utf8")
    writeFileSync(segment, bytes.replace('"seq":1', '"seq":9'))
    expect(replaySession(wt.worktree, "corrupt_session").complete).toBe(false)
    expect(() => openSession(wt.worktree, "corrupt_session")).toThrow(/corrupt/)
  })

  test("notices and safely repairs a truncated trailing row while retaining original bytes", () => {
    const store = open()
    store.append("user", { text: "keep" }, "complete-row")
    const dir = sessionDir(wt.worktree, store.sessionID)
    release(store)
    appendFileSync(join(dir, "segments000001.jsonl"), '{"seq":2')
    const incomplete = replaySession(wt.worktree, store.sessionID)
    expect(incomplete.complete).toBe(false)
    expect(incomplete.recoveryNotice).toMatch(/incomplete trailing/)
    const restored = openSession(wt.worktree, store.sessionID)
    expect(restored.restored).toBe(true)
    expect(replaySession(wt.worktree, store.sessionID)).toMatchObject({ complete: true, records: [{ eventID: "complete-row" }] })
    expect(readdirNames(dir).some(name => name.startsWith("recovery-") && name.endsWith(".json"))).toBe(true)
    release(restored)
  })

  test("recovers only fully valid contiguous orphan segments and reports session inspection", () => {
    const store = open()
    store.append("user", { text: "orphaned record" }, "orphan-1")
    const dir = sessionDir(wt.worktree, store.sessionID)
    release(store)
    rmSync(join(dir, "manifest.json"))
    const restored = openSession(wt.worktree, store.sessionID)
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toContain('"lastSeq":1')
    expect(inspectSessions(wt.worktree)).toContainEqual(expect.objectContaining({ sessionID: store.sessionID, engine: "codex", model: "model-test", held: true }))
    expect(replaySession(wt.worktree, store.sessionID).records[0]?.eventID).toBe("orphan-1")
    release(restored)
  })

  test("refuses symlinked session directories and unsafe session IDs", () => {
    const root = join(stateRoot(wt.worktree), "sessions")
    ensureDurableDirectory(root)
    const outside = join(wt.stateHome, "outside")
    mkdirSync(outside)
    symlinkSync(outside, join(root, "linked_session"))
    expect(() => openSession(wt.worktree, "linked_session", { engine: "codex", model: "model-test" })).toThrow(/symlink/)
    expect(() => openSession(wt.worktree, "../escape", { engine: "codex", model: "model-test" })).toThrow(/session ID/)
  })
})

function readdirNames(path: string): string[] {
  return readdirSync(path)
}

type ChildLineReader = { reader: ReadableStreamDefaultReader<Uint8Array>; buffer: string; decoder: TextDecoder }

function lineReader(stream: ReadableStream<Uint8Array>): ChildLineReader {
  return { reader: stream.getReader(), buffer: "", decoder: new TextDecoder() }
}

async function readLine(source: ChildLineReader): Promise<string> {
  for (;;) {
    const newline = source.buffer.indexOf("\n")
    if (newline >= 0) {
      const line = source.buffer.slice(0, newline)
      source.buffer = source.buffer.slice(newline + 1)
      return line
    }
    const chunk = await source.reader.read()
    if (chunk.done) throw new Error("child exited before producing its next line")
    source.buffer += source.decoder.decode(chunk.value, { stream: true })
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for child barrier file: ${path}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`child process timed out after ${timeoutMs}ms`)), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
