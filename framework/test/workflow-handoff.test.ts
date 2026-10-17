// P6a S4: the DI -> ralplan preset (AC-W3). One committed successor with lineage in the same live epoch; refused when held,
// paused/stopping or foreign; consensus is planning only and never consent to execute. Deterministic scripted host, no model.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { requestStop, stopHeartbeat } from "../src/flow/runtime.ts"
import { readEvents, withFlowTransaction, workflowPath } from "../src/flow/state.ts"
import { attachAdmission, holdAdmission } from "../src/sessions/admission.ts"
import type { SessionStore } from "../src/sessions/store.ts"
import { readLedger } from "../src/state/ledger.ts"
import { stateRoot } from "../src/state/store.ts"
import { sha256, workflowArtifactDirectory } from "../src/workflows/artifacts.ts"
import { __setCommitFaultHook, commitRevision, readCommitted, type CommitStage } from "../src/workflows/commit.ts"
import { runDeepInterview, startDeepInterview, verifiedSpec, type DiAnswer, type DiIo } from "../src/workflows/deep-interview-driver.ts"
import { ralplanDataOf } from "../src/workflows/ralplan.ts"
import { confirmExecute, executeConfirmation, handoffToRalplan, runRalplan, stopHere } from "../src/workflows/ralplan-driver.ts"
import { startRalplan } from "../src/workflows/ralplan-driver.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { tempGitWorktree } from "./guards-helpers.ts"
import { fullScript, scriptedRuntime } from "./workflow-fixture.ts"

let wt: ReturnType<typeof tempGitWorktree>
let stores: SessionStore[] = []
let counter = 0
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree); stores = [] })
afterEach(() => {
  __setCommitFaultHook(null)
  stopHeartbeat()
  for (const store of stores.splice(0)) {
    try { store.release({ workflowQuiescent: true, evidence: "fixture awaited all session work", workflowID: null, revision: null }) } catch { /* discarded worktree */ }
  }
  wt.cleanup()
})

const answer = (text: string): DiAnswer => ({ kind: "answer", text })
function io(answers: DiAnswer[]): DiIo {
  const queue = [...answers]
  return { async choose() { return 0 }, async readAnswer() { return queue.shift() }, async readNote() { return undefined } }
}

function setup(script = fullScript()) {
  const SID = `ses_ho${counter++}`
  const fixture = scriptedRuntime(wt.worktree, script)
  const store = attachAdmission(fixture.runtime, SID, { engine: "local", model: "fixture-model" })
  stores.push(store)
  return { SID, store, ...fixture }
}
type Setup = ReturnType<typeof setup>

/** Run a real interview to the crystallize step with the preset connected; the handoff goes through `handoffToRalplan`. */
async function interview(h: Setup, request = "build the widget") {
  const started = startDeepInterview(h.runtime, h.SID, request)
  if (!started.ok) throw new Error(started.text)
  const result = await runDeepInterview(h.runtime, h.SID, started.wf.id, io([answer("a1"), answer("a2")]), {
    handoff: (done, events) => {
      const handed = handoffToRalplan(h.runtime, h.SID, done, request, events)
      return handed.ok ? { ok: true, successor: handed.wf } : { ok: false, text: handed.text }
    },
  })
  return { started: started.wf, result }
}

const committedKind = () => {
  const read = readCommitted(wt.worktree)
  if (read.state !== "ok") throw new Error(`no committed workflow (${read.state})`)
  return read.wf
}

describe("live DI -> ralplan handoff (W3)", () => {
  test("a verified spec connects to exactly one committed ralplan with lineage, an archived terminal DI and contiguous events", async () => {
    const h = setup()
    const { started, result } = await interview(h)
    expect(result.status).toBe("handed_off")
    const wf = committedKind()
    expect(wf.kind).toBe("ralplan")
    expect(wf.sessionID).toBe(h.SID)
    expect(wf.owner.instance).toBe(h.store.epoch)
    const spec = join(wt.worktree, `.otter/workflows/${h.SID}/${started.id}/spec.md`)
    expect(wf.lineage?.predecessor).toMatchObject({ id: started.id, kind: "deep-interview", artifact: { path: `.otter/workflows/${h.SID}/${started.id}/spec.md`, sha256: sha256(readFileSync(spec)) } })
    expect(ralplanDataOf(wf as never).seed).toMatchObject({ workflowID: started.id, specSha: sha256(readFileSync(spec)) })

    const archive = JSON.parse(readFileSync(join(stateRoot(wt.worktree), "workflow", "archive", `${started.id}.json`), "utf8"))
    expect(archive).toMatchObject({ id: started.id, kind: "deep-interview", phase: "done", stage: "terminal" })
    expect(verifiedSpec(wt.worktree, archive)).toMatchObject({ ok: true })

    const events = readEvents(wt.worktree)
    expect(events.map(event => event.seq)).toEqual(events.map((_, i) => events[0]!.seq + i))
    expect(events.filter(event => event.wf === wf.id && event.type === "created")).toHaveLength(1)
    expect(events.filter(event => event.wf === started.id && event.type === "spec_written")).toHaveLength(1)
    expect(events.filter(event => event.type === "created" && event.wf !== started.id && event.wf !== wf.id)).toHaveLength(0)

    const done = await runRalplan(h.runtime, h.SID, wf.id)
    expect(done.status).toBe("pending_execution")
    const planner = h.seen.find(item => item.promptId === "ralplan.planner")!
    expect(planner.text).toContain(`.otter/workflows/${h.SID}/${started.id}/spec.md`)
    expect(planner.text).toContain(sha256(readFileSync(spec)))
    expect(planner.text).toContain("Build it.")
  })

  test("consensus is not consent: nothing executes, execute refuses, a stale revision is refused, the ledger stays empty", async () => {
    const h = setup()
    const { result } = await interview(h)
    expect(result.status).toBe("handed_off")
    const id = committedKind().id
    await runRalplan(h.runtime, h.SID, id)
    const pending = committedKind()
    expect(pending).toMatchObject({ kind: "ralplan", stage: "pending_execution", phase: "pending_approval" })
    expect(readLedger(wt.worktree, h.SID).tasks).toHaveLength(0)
    expect(readEvents(wt.worktree, id).map(event => event.type)).not.toContain("tasks_created")

    const planSha = ralplanDataOf(pending as never).consensus!.planSha
    expect(confirmExecute(h.runtime, h.SID, id, pending.lastSeq, "yes")).toMatchObject({ ok: false })
    expect(stopHere(h.runtime, h.SID, id, pending.lastSeq - 1)).toMatchObject({ ok: false })
    expect(committedKind()).toMatchObject({ stage: "pending_execution", phase: "pending_approval", lastSeq: pending.lastSeq })
    // the typed confirmation is a handoff to ultragoal (decompose) and still executes nothing
    const typed = confirmExecute(h.runtime, h.SID, id, pending.lastSeq, executeConfirmation(id, planSha))
    expect(typed).toMatchObject({ ok: true })
    expect(committedKind()).toMatchObject({ kind: "ultragoal", stage: "decompose", phase: "planning" })
    expect(readLedger(wt.worktree, h.SID).tasks).toHaveLength(0)
  })

  test("a refused connection keeps the verified specification: the interview completes without a successor", async () => {
    const h = setup()
    const started = startDeepInterview(h.runtime, h.SID, "build the widget")
    if (!started.ok) throw new Error(started.text)
    const notices: string[] = []
    const result = await runDeepInterview(h.runtime, h.SID, started.wf.id, { ...io([answer("a1"), answer("a2")]), notice: text => notices.push(text) }, {
      handoff: () => ({ ok: false, text: "not now" }),
    })
    expect(result.status).toBe("done")
    expect(committedKind()).toMatchObject({ kind: "deep-interview", phase: "done" })
    expect(notices.some(text => text.includes("Connecting to ralplan was refused: not now"))).toBe(true)
  })
})

describe("fault matrix", () => {
  const STAGES: CommitStage[] = [
    "events-fsync", "archive-write", "snapshot-write", "snapshot-fsync", "snapshot-rename", "snapshot-dirfsync",
    "index-write", "index-fsync", "index-rename", "index-dirfsync",
  ]
  for (const stage of STAGES) {
    test(`a fault at ${stage} leaves the DI at crystallize or the ralplan committed; never two active, never a free slot`, async () => {
      const script = fullScript()
      script["di.crystallize"] = [...script["di.crystallize"]!, ...script["di.crystallize"]!]
      const h = setup(script)
      const other = `ses_other${counter++}`
      stores.push(attachAdmission(h.runtime, other, { engine: "local", model: "fixture-model" }))
      const started = startDeepInterview(h.runtime, h.SID, "build the widget")
      if (!started.ok) throw new Error(started.text)
      // drive to the crystallize step with the handoff armed, but the fault hook firing only inside the handoff commit
      let armed = false
      const result = await runDeepInterview(h.runtime, h.SID, started.wf.id, io([answer("a1"), answer("a2")]), {
        handoff: (done, events) => {
          armed = true
          __setCommitFaultHook(at => { if (at === stage) throw new Error(`injected ${at}`) })
          try {
            const handed = handoffToRalplan(h.runtime, h.SID, done, "build the widget", events)
            return handed.ok ? { ok: true, successor: handed.wf } : { ok: false, text: handed.text }
          } finally { /* the hook stays armed through the fallback commit so the window is observable */ }
        },
      })
      expect(armed).toBe(true)
      const wf = committedKind()
      if (stage === "index-dirfsync") {
        // the index rename is the commit point: a later fault can only report failure for a committed handoff
        expect(result.status).toBe("handed_off")
        expect(wf.kind).toBe("ralplan")
      } else if (stage === "archive-write") {
        // the handoff wrote nothing durable; the plain completion keeps the verified specification and no successor exists
        expect(result.status).toBe("done")
        expect(wf).toMatchObject({ id: started.wf.id, kind: "deep-interview", stage: "terminal", phase: "done" })
        expect(verifiedSpec(wt.worktree, wf as never)).toMatchObject({ ok: true })
      } else {
        expect(result.status).toBe("stale")
        expect(wf).toMatchObject({ id: started.wf.id, kind: "deep-interview", stage: "crystallize", phase: "planning" })
      }
      // exactly one live occupant, and a competing start from another session is refused in the fault window
      // (a completed interview is terminal and legitimately yields the slot; only a live occupant must refuse)
      if (wf.phase !== "done") {
        const competing = startDeepInterview(h.runtime, other, "steal the slot")
        expect(competing.ok).toBe(false)
        if (!competing.ok) expect(competing.text).toContain("is active")
        expect(startRalplan(h.runtime, other, "steal the slot").ok).toBe(false)
      }
      __setCommitFaultHook(null)
      if (wf.kind === "deep-interview" && wf.phase !== "done") {
        // retry is idempotent: the spec is recrystallized and the handoff now commits exactly once
        const again = await runDeepInterview(h.runtime, h.SID, started.wf.id, io([]), {
          handoff: (done, events) => {
            const handed = handoffToRalplan(h.runtime, h.SID, done, "build the widget", events)
            return handed.ok ? { ok: true, successor: handed.wf } : { ok: false, text: handed.text }
          },
        })
        expect(again.status).toBe("handed_off")
        expect(committedKind()).toMatchObject({ kind: "ralplan", lineage: { predecessor: { id: started.wf.id } } })
      }
      expect(readEvents(wt.worktree).filter(event => event.type === "created" && event.data?.kind === "ralplan").length).toBeLessThanOrEqual(1)
    })
  }
})

describe("refused handoffs change nothing", () => {
  /** A committed DI at crystallize plus its done terminal form with the spec on disk, as the driver would hand it over. */
  function atCrystallize(h: Setup, owner = currentOwner(Date.now(), h.store.epoch)) {
    const id = `wf_di_ho${counter++}`
    const base = {
      version: 2 as const, id, kind: "deep-interview" as const, stage: "crystallize" as const, phase: "planning" as const, engine: "local",
      sessionID: h.SID, owner: { instance: owner.instance, pid: owner.pid }, stopIntent: null, artifacts: [], data: {}, lastSeq: 0, createdAt: 1, updatedAt: 1,
    }
    const live = withFlowTransaction(wt.worktree, tx => commitRevision(tx, base as never, [{ wf: id, type: "created", actor: "code" }]))
    const directory = workflowArtifactDirectory(wt.worktree, h.SID, id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "spec.md"), "SPEC-BYTES\n")
    const spec = { key: "spec.md", path: `.otter/workflows/${h.SID}/${id}/spec.md`, sha256: sha256(Buffer.from("SPEC-BYTES\n")) }
    const done = { ...live, stage: "terminal", phase: "done", artifacts: [spec] } as never as Parameters<typeof handoffToRalplan>[2]
    const events = [{ wf: id, type: "spec_written", actor: "code" as const }]
    return { id, live, done, events, specPath: join(wt.worktree, spec.path) }
  }
  const indexBytes = () => readFileSync(workflowPath(wt.worktree))

  test("a held session", () => {
    const h = setup()
    const s = atCrystallize(h)
    holdAdmission(wt.worktree, h.SID, "operator_hold")
    const before = indexBytes()
    expect(handoffToRalplan(h.runtime, h.SID, s.done, "plan it", s.events)).toMatchObject({ ok: false })
    expect(indexBytes().equals(before)).toBe(true)
  })

  for (const kind of ["pause", "cancel"] as const) test(`a pending ${kind}`, () => {
    {
      const h = setup()
      const s = atCrystallize(h)
      const stop = requestStop(h.runtime, h.SID, kind, "user")
      expect(stop.result.ok).toBe(true)
      const current = committedKind()
      const before = indexBytes()
      const refused = handoffToRalplan(h.runtime, h.SID, { ...s.done, lastSeq: current.lastSeq } as never, "plan it", s.events)
      expect(refused.ok).toBe(false)
      expect(indexBytes().equals(before)).toBe(true)
    }
  })

  test("a foreign session id", () => {
    const h = setup()
    const s = atCrystallize(h)
    const foreign = `ses_foreign${counter++}`
    stores.push(attachAdmission(h.runtime, foreign, { engine: "local", model: "fixture-model" }))
    const before = indexBytes()
    expect(handoffToRalplan(h.runtime, foreign, s.done, "plan it", s.events)).toMatchObject({ ok: false })
    expect(indexBytes().equals(before)).toBe(true)
  })

  test("a changed live epoch", () => {
    const h = setup()
    const s = atCrystallize(h)
    const before = indexBytes()
    const refused = handoffToRalplan(h.runtime, h.SID, { ...s.done, owner: { instance: "att_other_epoch", pid: process.pid } } as never, "plan it", s.events)
    expect(refused.ok).toBe(false)
    expect(indexBytes().equals(before)).toBe(true)
  })

  test("a spec edited before the commit", () => {
    const h = setup()
    const s = atCrystallize(h)
    writeFileSync(s.specPath, "EDITED\n")
    const before = indexBytes()
    const refused = handoffToRalplan(h.runtime, h.SID, s.done, "plan it", s.events)
    expect(refused.ok).toBe(false)
    expect(indexBytes().equals(before)).toBe(true)
    expect(existsSync(s.specPath)).toBe(true)
  })

  test("a verified spec that is stale after completion cannot seed a second connection", async () => {
    const h = setup()
    const { started, result } = await interview(h)
    expect(result.status).toBe("handed_off")
    const archived = JSON.parse(readFileSync(join(stateRoot(wt.worktree), "workflow", "archive", `${started.id}.json`), "utf8"))
    const before = indexBytes()
    expect(handoffToRalplan(h.runtime, h.SID, archived, "again", [{ wf: started.id, type: "spec_written", actor: "code" as const }])).toMatchObject({ ok: false })
    expect(indexBytes().equals(before)).toBe(true)
  })
})
