// P6b S1: the approved-unit substrate for ultragoal / autoresearch. A unit's tasks are inserted into the existing queue under the PARENT workflow id and the unit's
// subject hash; no workflow is ever started for a unit. Stop/resume/cancel treat the unit as the checkpoint subject.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createForegroundController } from "../src/hosts/controller.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { adoptForeignStop, insertApprovedUnitTasks, stopHeartbeat } from "../src/flow/runtime.ts"
import { planJsonPath, readEvents, readAnyWorkflowChecked, workflowPath } from "../src/flow/state.ts"
import { UNIT_LIMITS, validatePlan, type Plan } from "../src/flow/plan.ts"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"
import { runVerifierExecution, type VerifierRunEntry } from "../src/orchestration/verifier-run.ts"
import { createSnapshotStore } from "../src/orchestration/snapshot.ts"
import { attachAdmission, effectiveHold } from "../src/sessions/admission.ts"
import { readLedger, writeLedger } from "../src/state/ledger.ts"
import { sessionDir, stateRoot } from "../src/state/store.ts"
import { readSessionMetadata } from "../src/sessions/store.ts"
import { UNIT_DOC_MAX_BYTES, experimentUnitSubject, implementationUnitSubject, stopSubjectOf, unitFor, type SubjectInput } from "../src/workflows/execution-unit.ts"
import { sha256 } from "../src/workflows/artifacts.ts"
import { requiredArtifactKeys } from "../src/workflows/registry.ts"
import { writeReceipt, RECEIPT_KINDS } from "../src/workflows/receipts.ts"
import { subjectSha256 } from "../src/workflows/execution-unit.ts"
import { __setCommitFaultHook } from "../src/workflows/commit.ts"
import { beginExecutionActivity } from "../src/hosts/runtime.ts"
import { publishWorkflow, rewriteCommitted, committedSnapshot } from "./commit-fixture.ts"
import { tempGitWorktree, waitFor } from "./guards-helpers.ts"

const SESSION = "ses_unit"
const ENGINE = "fixture"
const CONTROLS = Object.fromEntries([
  "boundedInput", "boundedOutput", "preExecutionToolPolicy", "headlessPermissionRefusal", "ownedCancellation",
  "quiescenceEvidence", "identityBinding", "noReplayRecovery", "readOnlyWorkflow", "readOnlyWorktree", "serialWorkerLease",
].map(key => [key, "supported" as const]))

let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => {
  wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree)
})
afterEach(() => { __setCommitFaultHook(null); stopHeartbeat(); wt.cleanup() })

function fixture(opts: { worker?: (request: ExecutionRequest) => ExecutionOutcome | Promise<ExecutionOutcome>; onCancel?: () => void | Promise<void>; cancelQuiescent?: boolean; controls?: () => Record<string, "supported" | "unsupported"> } = {}) {
  const config = { ...DEFAULT_CONFIG, delegate: { ...DEFAULT_CONFIG.delegate, worktree: false, max_attempts: 2 } }
  const requests: ExecutionRequest[] = []
  let sequence = 0
  const runs = createExecutionRunStore(wt.worktree)
  const runtime: ExecutionRuntime = {
    instance: "unit-controller", directory: wt.worktree, worktree: wt.worktree, stateRoot: stateRoot(wt.worktree), config,
    log: () => {}, runs, verificationProfile: "legacy-unowned", verifier: createLegacyVerifierExecutor(),
    observe: { task() {} },
    policy: createExecutionPolicy(config, { directory: wt.worktree, worktree: wt.worktree }),
    host: {
      identity: { engine: ENGINE, profile: "code" },
      async preflight() { return { compatible: true, controls: (opts.controls?.() ?? CONTROLS) as never, problems: [] } },
      async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "fixture reconciliation" } },
      async prepare(request) {
        requests.push(request)
        const vendorSessionID = `child_${++sequence}`
        const reference = { executionID: request.executionID, vendorSessionID }
        runtime.policy.bindSession(vendorSessionID, request.handlers, request.policy)
        let completed = false
        return {
          reference,
          async run() {
            const result = request.role === "reviewer" ? { status: "completed" as const, text: "ACCEPT" }
              : opts.worker ? await opts.worker(request) : { status: "completed" as const, text: "Open issues: none" }
            completed = true
            return result
          },
          async requestCancel() {
            await opts.onCancel?.()
            return { requested: true, acknowledged: true, terminal: opts.cancelQuiescent ?? true, quiescent: opts.cancelQuiescent ?? true }
          },
          async reconcile() { return { outcome: completed ? "terminal" as const : "unknown" as const, quiescent: completed, evidence: "fixture child" } },
        }
      },
    },
  }
  const session = attachAdmission(runtime, SESSION, { engine: ENGINE, model: "m" })
  return { runtime, session, controller: createForegroundController(runtime), requests,
    workers: () => requests.filter(r => r.role === "worker") }
}
type Fixture = ReturnType<typeof fixture>

const STEPS = [1, 2].map(n => ({ title: `module ${n}`, files: [`mod${n}.py`], detail: `write module ${n}`, verify: `sh check_${n}.sh` }))
const WID = "wf_ug_unit"

function docDir(): string { return join(wt.worktree, ".lca", "workflows", SESSION, WID, "units") }
const docPath = ".lca/workflows/" + SESSION + "/" + WID + "/units/g1-1.md"
const jsonDocPath = ".lca/workflows/" + SESSION + "/" + WID + "/units/g1-1.json"

function unitInput(overrides: Partial<SubjectInput> = {}): SubjectInput {
  return {
    kind: "implementation-unit", id: `${WID}:g1:1`, scope: STEPS.map(s => s.title), commands: STEPS.map(s => s.verify),
    inputs: STEPS.flatMap(s => s.files), allowedPaths: ["mod1.py", "mod2.py"], verification: STEPS.map(s => s.verify),
    sourceHashes: [sha256("goals")], artifactHashes: [], ...overrides,
  }
}

/** The approval receipt the typed APPROVE-UNIT choice would have written. */
function approvalReceipt(subject: { id: string; sha256: string }, sid = SESSION, wid = WID): string {
  return writeReceipt(wt.worktree, { kind: "choice", wid, sid, revision: 0, action: `choice-approve-unit-${subject.sha256.slice(0, 12)}`, inputSha: subject.sha256, body: { choice: "approve-unit", subjectId: subject.id, subjectSha: subject.sha256, executed: false } })
}

/** A committed ultragoal at unit_execute whose approval names its implementation-unit subject. */
function seedUnitWorkflow(f: Fixture, extra: { phase?: "executing"; stage?: string; mutate?: (current: Record<string, unknown>) => void } = {}) {
  for (const s of STEPS) writeFileSync(join(wt.worktree, s.verify.replace("sh ", "")), `test -f ${s.files[0]}\n`)
  mkdirSync(docDir(), { recursive: true })
  const md = "# unit g1-1\n" + STEPS.map(s => `- ${s.title}: ${s.verify}`).join("\n") + "\n"
  writeFileSync(join(wt.worktree, docPath), md)
  const artifact = { key: "units/g1-1.md", path: docPath, sha256: sha256(md) }
  const planJson = `${JSON.stringify({ goal: "unit", revision: 1, risks: ["r"], steps: STEPS })}\n`
  writeFileSync(join(wt.worktree, jsonDocPath), planJson)
  const jsonArtifact = { key: "units/g1-1.json", path: jsonDocPath, sha256: sha256(planJson) }
  const { kind: _kind, ...input } = { ...unitInput(), artifactHashes: [artifact.sha256, jsonArtifact.sha256] }
  const subject = implementationUnitSubject(input)
  const current: Record<string, unknown> = { goalId: "g1", attempt: 1, subject, input, approval: { subject, receiptRef: approvalReceipt(subject) }, artifacts: [artifact, jsonArtifact], taskIds: [], done: [], remaining: [] }
  extra.mutate?.(current)
  const wf = publishWorkflow(wt.worktree, {
    id: WID, kind: "ultragoal", sessionID: SESSION, engine: ENGINE, phase: extra.phase ?? "executing", stage: (extra.stage ?? "unit_execute") as never,
    lastSeq: 0, createdAt: Date.now(), owner: { instance: f.session.epoch, pid: process.pid },
    data: { v: 1, request: "unit fixture", progress: {}, findings: [], attempts: 0, current },
  } as never)
  return { wf, subject, artifact, jsonArtifact, md }
}
const inputs = () => STEPS.map(s => ({ title: s.title, detail: `files: ${s.files.join(", ")}`, verify: s.verify, kind: "code" as const }))
const current = () => readAnyWorkflowChecked(wt.worktree).wf!
const prepares = (f: Fixture) => f.requests.length

describe("unit subject", () => {
  test("every SubjectInput field changes the hash; reordering allowedPaths does not", () => {
    const base = subjectSha256(unitInput())
    const changes: Array<Partial<SubjectInput>> = [
      { kind: "experiment-unit" }, { id: "other" }, { scope: ["x"] }, { commands: ["sh x.sh"] }, { inputs: ["x"] },
      { allowedPaths: ["z.py"] }, { verification: ["sh y.sh"] }, { sourceHashes: [sha256("other")] }, { artifactHashes: [sha256("a")] },
    ]
    for (const change of changes) expect(subjectSha256(unitInput(change))).not.toBe(base)
    expect(subjectSha256(unitInput({ allowedPaths: ["mod2.py", "mod1.py"] }))).toBe(base)
    expect(implementationUnitSubject(unitInput()).kind).toBe("implementation-unit")
    expect(experimentUnitSubject(unitInput()).kind).toBe("experiment-unit")
  })
})

describe("unit insertion", () => {
  test("a 2-step unit produces exactly 2 tasks tagged {parent wid, sha}; the index stays on the parent; no plan snapshot and no second workflow", () => {
    const f = fixture()
    const { wf, subject } = seedUnitWorkflow(f)
    const result = insertApprovedUnitTasks(f.runtime, wf)
    expect(result.ok).toBe(true)
    const tasks = readLedger(wt.worktree, SESSION).tasks
    expect(tasks).toHaveLength(2)
    for (const task of tasks) expect(task.wf).toEqual({ id: WID, planSha: subject.sha256 })
    expect(JSON.parse(readFileSync(workflowPath(wt.worktree), "utf8"))).toMatchObject({ id: WID, kind: "ultragoal" })
    expect(existsSync(planJsonPath(wt.worktree, WID))).toBe(false)
    // no startWorkflow: only the parent was ever committed, and no `created` event exists for any workflow
    expect(readEvents(wt.worktree).some(event => event.type === "created")).toBe(false)
    // idempotent per tag
    expect(insertApprovedUnitTasks(f.runtime, wf)).toMatchObject({ ok: true })
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(2)
    expect(prepares(f)).toBe(0)
  })

  test("editing the unit document after approval refuses: 0 tasks, 0 prepares, and a run refuses too", async () => {
    const f = fixture()
    const { wf } = seedUnitWorkflow(f)
    writeFileSync(join(wt.worktree, docPath), "tampered\n")
    const result = insertApprovedUnitTasks(f.runtime, wf)
    expect(result.ok).toBe(false)
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
    await expect(f.controller.runApprovedUnit(SESSION)).rejects.toThrow(/changed/)
    expect(prepares(f)).toBe(0)
  })

  test("an oversize unit document or an unhashed one is not a unit", () => {
    const f = fixture()
    const { wf } = seedUnitWorkflow(f)
    const big = "x".repeat(UNIT_DOC_MAX_BYTES + 1)
    writeFileSync(join(wt.worktree, docPath), big)
    const record = (wf as unknown as { data: { current: { artifacts: Array<{ sha256: string }> } } }).data.current
    record.artifacts[0]!.sha256 = sha256(big)
    expect(() => unitFor(wf, { worktree: wt.worktree })).toThrow(/changed/)
  })

  test("an untagged open task refuses the insertion and is left unchanged (no foreign cancel)", () => {
    const f = fixture()
    const { wf } = seedUnitWorkflow(f)
    writeLedger(wt.worktree, { ...readLedger(wt.worktree, SESSION), tasks: [{ id: "t1", n: 1, batch: 1, title: "stray", status: "pending", attempts: 0, childSessions: [], createdAt: 1 } as never] })
    const before = JSON.stringify(readLedger(wt.worktree, SESSION))
    const result = insertApprovedUnitTasks(f.runtime, wf)
    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(readLedger(wt.worktree, SESSION))).toBe(before)
    expect(readLedger(wt.worktree, SESSION).tasks[0]!.status).toBe("pending")
    expect(prepares(f)).toBe(0)
  })
})

/** Worker 1 completes (writes mod1.py); worker 2 blocks until released. Returns the paused state. */
async function pausedUnit(opts: { controls?: () => Record<string, "supported" | "unsupported"> } = {}) {
  let release!: () => void
  let calls = 0
  const f = fixture({
    controls: opts.controls,
    onCancel: async () => { release?.(); await new Promise<void>(resolve => setImmediate(resolve)) },
    worker: request => {
      const n = Number(request.title.match(/module (\d)/)?.[1])
      calls++
      if (n === 2 && calls === 2) return new Promise<ExecutionOutcome>(resolve => { release = () => resolve({ status: "cancelled" }) })
      writeFileSync(join(wt.worktree, `mod${n}.py`), "VALUE = 1\n")
      return { status: "completed", text: "Open issues: none" }
    },
  })
  const seeded = seedUnitWorkflow(f)
  expect(insertApprovedUnitTasks(f.runtime, seeded.wf).ok).toBe(true)
  const running = f.controller.runApprovedUnit(SESSION).then(() => null, (error: unknown) => error)
  await waitFor(() => f.workers().length === 2)
  const paused = f.controller.pause(SESSION)
  expect(paused.ok).toBe(true)
  const pending = current()
  expect(pending.stopIntent).toMatchObject({ kind: "pause" })
  await running
  return { f, seeded, pending }
}

describe("stop, resume and cancel of a unit", () => {
  test("pause while a worker is blocked: pause reason, stays pausing until settled, one pause_settled, unit checkpoint with the remaining task", async () => {
    const { f, seeded, pending } = await pausedUnit()
    const wf = current()
    expect(wf.phase).toBe("paused")
    const tasks = readLedger(wt.worktree, SESSION).tasks
    expect(tasks.map(t => t.status)).toEqual(["done", "pending"])
    expect(tasks[1]!.error).toBe(`paused: workflow_pause:${pending.stopIntent!.token}`)
    const events = readEvents(wt.worktree, WID)
    expect(events.filter(e => e.type === "pause_settled")).toHaveLength(1)
    const stopRequested = events.find(e => e.type === "stop_requested")!
    expect(stopRequested.data?.token).toBe(pending.stopIntent!.token)
    const checkpoint = JSON.parse(readFileSync(join(stateRoot(wt.worktree), wf.stopIntent!.checkpoint!.split("#")[0]!), "utf8"))
    expect(checkpoint.subject).toEqual(seeded.subject)
    expect(checkpoint.done).toEqual([tasks[0]!.id])
    expect(checkpoint.residual).toEqual([tasks[1]!.id])
    expect(effectiveHold(wt.worktree, SESSION)).toBe(true)
    expect(stopSubjectOf(wf)).toEqual(seeded.subject)
    void f
  })

  test("the pause state is `pausing` (pending, not paused) until the owner settles", async () => {
    let release!: () => void
    const f = fixture({ cancelQuiescent: false, onCancel: () => {}, worker: () => new Promise<ExecutionOutcome>(resolve => { release = () => resolve({ status: "cancelled" }) }) })
    const seeded = seedUnitWorkflow(f)
    expect(insertApprovedUnitTasks(f.runtime, seeded.wf).ok).toBe(true)
    const running = f.controller.runApprovedUnit(SESSION).then(() => null, (error: unknown) => error)
    await waitFor(() => f.workers().length === 1)
    expect(f.controller.pause(SESSION).ok).toBe(true)
    expect(current()).toMatchObject({ phase: "executing", stopIntent: { kind: "pause" } })
    expect(readEvents(wt.worktree, WID).filter(e => e.type === "pause_settled")).toHaveLength(0)
    release()
    await running
    expect(readEvents(wt.worktree, WID).filter(e => e.type === "pause_settled")).toHaveLength(1)
  })

  test("pause then cancel: cancelled with no pause_settled; tasks cancelled after proof; files retained", async () => {
    let release!: () => void
    const f = fixture({ cancelQuiescent: false, onCancel: () => {}, worker: () => new Promise<ExecutionOutcome>(resolve => { release = () => resolve({ status: "cancelled" }) }) })
    const seeded = seedUnitWorkflow(f)
    expect(insertApprovedUnitTasks(f.runtime, seeded.wf).ok).toBe(true)
    const running = f.controller.runApprovedUnit(SESSION).then(() => null, (error: unknown) => error)
    await waitFor(() => f.workers().length === 1)
    const pauseToken = (() => { f.controller.pause(SESSION); return current().stopIntent!.token })()
    expect(f.controller.cancel(SESSION).ok).toBe(true)
    expect(current().stopIntent).toMatchObject({ kind: "cancel" })
    expect(readEvents(wt.worktree, WID).find(e => e.type === "stop_requested" && e.data?.kind === "cancel")?.data?.replaces).toBe(pauseToken)
    expect(f.controller.pause(SESSION)).toMatchObject({ ok: false, text: expect.stringContaining("pause refused") })
    release()
    await running
    expect(current().phase).toBe("cancelled")
    const events = readEvents(wt.worktree, WID)
    expect(events.filter(e => e.type === "pause_settled")).toHaveLength(0)
    expect(events.filter(e => e.type === "cancel_settled")).toHaveLength(1)
    expect(readLedger(wt.worktree, SESSION).tasks.every(t => t.status === "cancelled")).toBe(true)
    expect(existsSync(join(wt.worktree, docPath))).toBe(true)
  })

  test("resume makes exactly one prepare, for the residual task, and keeps the done task untouched", async () => {
    const { f } = await pausedUnit()
    const done = JSON.stringify(readLedger(wt.worktree, SESSION).tasks[0])
    const before = prepares(f)
    const outcome = await f.controller.resumePaused(SESSION, async view => {
      expect(view.residual).toHaveLength(1)
      return true
    })
    expect(outcome.kept).toBe(false)
    const after = f.requests.slice(before)
    expect(after.filter(r => r.role === "worker")).toHaveLength(1)
    expect(after[0]!.title).toContain("module 2")
    expect(JSON.stringify(readLedger(wt.worktree, SESSION).tasks[0])).toBe(done)
    expect(readLedger(wt.worktree, SESSION).tasks.map(t => t.status)).toEqual(["done", "done"])
    expect(current()).toMatchObject({ phase: "executing", stopIntent: null })
  }, 60_000)

  const REFUSALS: Array<[string, (ctx: Awaited<ReturnType<typeof pausedUnit>>) => void, RegExp]> = [
    ["subject tamper (unit document edited)", () => writeFileSync(join(wt.worktree, docPath), "tampered\n"), /subject|unit/],
    ["foreign task (untagged open task)", () => {
      const ledger = readLedger(wt.worktree, SESSION)
      writeLedger(wt.worktree, { ...ledger, tasks: [...ledger.tasks, { ...ledger.tasks[1]!, id: "t99", n: 99, title: "stray", wf: undefined }] })
    }, /unrelated|residual/],
    ["cancel pending", () => rewriteCommitted(wt.worktree, wf => ({ ...wf, stopIntent: { ...wf.stopIntent!, kind: "cancel" } })), /cancel/],
    ["wrong epoch", () => rewriteCommitted(wt.worktree, wf => ({ ...wf, owner: { instance: "other-epoch", pid: process.pid } })), /epoch|owner|attachment/],
  ]
  for (const [name, mutate, message] of REFUSALS) {
    test(`resume refused: ${name}; zero starts and the workflow stays paused`, async () => {
      const ctx = await pausedUnit()
      mutate(ctx)
      const starts = prepares(ctx.f)
      await expect(ctx.f.controller.resumePaused(SESSION, async () => true)).rejects.toThrow(message)
      expect(prepares(ctx.f)).toBe(starts)
      expect(readSessionMetadata(wt.worktree, SESSION)?.held).toBe(true)
    })
  }

  test("resume refused: host preflight failure; zero starts", async () => {
    let lost = false
    const ctx = await pausedUnit({ controls: () => lost ? { ...CONTROLS, ownedCancellation: "unsupported" } : CONTROLS })
    lost = true
    const starts = prepares(ctx.f)
    await expect(ctx.f.controller.resumePaused(SESSION, async () => true)).rejects.toThrow(/preflight|control|admission|refus/i)
    expect(prepares(ctx.f)).toBe(starts)
    expect(current().phase).toBe("paused")
  })

  test("a planning-stage unit-kind pause resumes its own stage and starts nothing", async () => {
    const f = fixture()
    seedUnitWorkflow(f, { phase: "executing", stage: "unit_execute" })
    rewriteCommitted(wt.worktree, wf => ({ ...wf, phase: "planning", stage: "unit_plan" }) as never)
    expect(f.controller.pause(SESSION).ok).toBe(true)
    expect(current()).toMatchObject({ phase: "paused", pausedFrom: { phase: "planning", stage: "unit_plan" } })
    const outcome = await f.controller.resumePaused(SESSION, async () => true)
    expect(outcome.kept).toBe(false)
    expect(current()).toMatchObject({ phase: "planning", stage: "unit_plan" })
    expect(prepares(f)).toBe(0)
  })
})

describe("unit approval is recomputed, receipt-backed and bound to documents (architect H1)", () => {
  const refuses = async (f: Fixture, wf: ReturnType<typeof seedUnitWorkflow>["wf"]) => {
    expect(insertApprovedUnitTasks(f.runtime, wf).ok).toBe(false)
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
    await expect(f.controller.runApprovedUnit(SESSION)).rejects.toThrow(/changed|no bound|approval|subject/)
    expect(prepares(f)).toBe(0)
  }

  test("swapping the artifact list for another verified document under the same subject refuses (insert and run)", async () => {
    const f = fixture()
    const other = "# a different but verified document\n"
    const otherPath = docPath.replace("g1-1.md", "other.md")
    const { wf } = seedUnitWorkflow(f, { mutate: current => {
      writeFileSync(join(wt.worktree, otherPath), other)
      current.artifacts = [{ key: "units/other.md", path: otherPath, sha256: sha256(other) }]
    } })
    await refuses(f, wf)
  })

  test("a unit with no documents refuses", async () => {
    const f = fixture()
    const { wf } = seedUnitWorkflow(f, { mutate: current => { current.artifacts = [] } })
    await refuses(f, wf)
  })

  test("a subject hash that does not match its stored inputs refuses", async () => {
    const f = fixture()
    const bogus = { kind: "implementation-unit" as const, id: `${WID}:g1:1`, sha256: sha256("forged") }
    const { wf } = seedUnitWorkflow(f, { mutate: current => { current.subject = bogus; current.approval = { subject: bogus, receiptRef: approvalReceipt(bogus) } } })
    await refuses(f, wf)
  })

  test("a missing, foreign-workflow or wrong-subject approval receipt refuses", async () => {
    for (const make of [
      () => "sessions/x/workflows/y/receipts/0-none.json#" + "0".repeat(64),
      () => approvalReceipt({ id: "x", sha256: sha256("other") }),
      () => approvalReceipt({ id: `${WID}:g1:1`, sha256: sha256("n/a") }, SESSION, "wf_other"),
    ]) {
      wt.cleanup(); wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree)
      const f = fixture()
      const { wf } = seedUnitWorkflow(f, { mutate: current => { (current.approval as { receiptRef: string | null }).receiptRef = make() } })
      await refuses(f, wf)
    }
  })

  test("approval subject different from the unit subject, a wrong subject kind or a non-executing stage refuses", async () => {
    const other = { kind: "implementation-unit" as const, id: `${WID}:g1:1`, sha256: sha256("other") }
    const f = fixture()
    const { wf: mismatch } = seedUnitWorkflow(f, { mutate: current => { (current.approval as { subject: unknown }).subject = other } })
    await refuses(f, mismatch)
    wt.cleanup(); wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree)
    // an experiment-unit subject on an ultragoal is not even a parseable ultragoal record
    const g = fixture()
    expect(() => seedUnitWorkflow(g, { mutate: current => { (current.subject as { kind: string }).kind = "experiment-unit" } })).toThrow()
    wt.cleanup(); wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree)
    const h = fixture()
    const { wf: wrongStage } = seedUnitWorkflow(h, { stage: "unit_plan" as never, phase: "planning" as never })
    expect(() => unitFor(wrongStage, { worktree: wt.worktree })).toThrow()
  })

  test("tasks are derived from the verified unit JSON: an altered detail/files/verify in that document refuses with 0 tasks (the caller supplies nothing)", () => {
    for (const edit of [(plan: { steps: Array<Record<string, unknown>> }) => { plan.steps[0]!.detail = "do something else" }, (plan: { steps: Array<Record<string, unknown>> }) => { plan.steps[0]!.files = ["../x.py"] },
      (plan: { steps: Array<Record<string, unknown>> }) => { plan.steps[0]!.verify = "sh check_9.sh" }]) {
      wt.cleanup(); wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree)
      const f = fixture()
      const { wf, jsonArtifact } = seedUnitWorkflow(f)
      const plan = JSON.parse(readFileSync(join(wt.worktree, jsonArtifact.path), "utf8"))
      edit(plan)
      writeFileSync(join(wt.worktree, jsonArtifact.path), `${JSON.stringify(plan)}\n`)
      expect(insertApprovedUnitTasks(f.runtime, wf)).toMatchObject({ ok: false })
      expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
      expect(prepares(f)).toBe(0)
    }
  })
})

describe("controller and stop negatives", () => {
  test("a foreign-observed pause intent on a unit workflow is adopted: the session is held", () => {
    const f = fixture()
    seedUnitWorkflow(f)
    rewriteCommitted(wt.worktree, wf => ({ ...wf, stopIntent: { kind: "pause", token: "tok", requestedFrom: { phase: "executing", stage: "unit_execute" }, checkpoint: null, reason: "foreign" } }) as never)
    expect(readSessionMetadata(wt.worktree, SESSION)?.held).toBe(false)
    adoptForeignStop(f.runtime, { sessionID: SESSION, epoch: f.session.epoch })
    expect(readSessionMetadata(wt.worktree, SESSION)?.held).toBe(true)
  })

  test("a deep-interview occupant is refused by run/runApprovedUnit and by controller pause/cancel; no prepares", async () => {
    const f = fixture()
    publishWorkflow(wt.worktree, {
      id: "wf_di", kind: "deep-interview", sessionID: SESSION, engine: ENGINE, phase: "planning", stage: "topology" as never,
      lastSeq: 0, createdAt: Date.now(), owner: { instance: f.session.epoch, pid: process.pid }, data: {},
    } as never)
    await expect(f.controller.runApprovedUnit(SESSION)).rejects.toThrow()
    await expect(f.controller.run(SESSION)).rejects.toThrow()
    expect(() => f.controller.pause(SESSION)).toThrow()
    expect(() => f.controller.cancel(SESSION)).toThrow()
    expect(current()).toMatchObject({ id: "wf_di", phase: "planning", stopIntent: null })
    expect(prepares(f)).toBe(0)
  })

  test("an autoresearch unit cannot dispatch queue workers through runApprovedUnit", async () => {
    const f = fixture()
    const { subject, artifact } = seedUnitWorkflow(f)
    const { kind: _kind, ...input } = { ...unitInput(), artifactHashes: [artifact.sha256] }
    const exp = { subject: { ...subject, kind: "experiment-unit" }, input, approval: { subject: { ...subject, kind: "experiment-unit" }, receiptRef: "x#y" }, artifacts: [artifact], taskIds: [], done: [], remaining: ["c0"], iteration: 1 }
    rewriteCommitted(wt.worktree, wf => ({ ...wf, kind: "autoresearch", stage: "experiment_run", data: { v: 1, request: "x", hypotheses: [], iteration: 1, attempts: 0, findings: [], caveats: [], runs: [], experiment: exp } }) as never)
    await expect(f.controller.runApprovedUnit(SESSION)).rejects.toThrow()
    expect(prepares(f)).toBe(0)
  })
})

describe("done evidence invariants (architect MEDIUM)", () => {
  const goals = (extra: Record<string, unknown> = {}) => ({ kind: "ultragoal", stage: "terminal", phase: "done", ...extra }) as never
  test("a done ultragoal/autoresearch with non-object data or no per-goal proof is not satisfiable", () => {
    expect(() => requiredArtifactKeys(goals({ data: null }))).toThrow()
    expect(() => requiredArtifactKeys(goals({ data: {} }))).toThrow()
    expect(() => requiredArtifactKeys(goals({ data: { progress: {} } }))).toThrow()
    expect(() => requiredArtifactKeys(goals({ data: { v: 1, request: "x", findings: [], attempts: 0, progress: {} } }))).toThrow()
    expect(() => requiredArtifactKeys({ kind: "autoresearch", stage: "terminal", phase: "done", data: null } as never)).toThrow()
  })
  test("validatePlan accepts only plan limits or UNIT_LIMITS", () => {
    const plan: Plan = { goal: "g", revision: 1, risks: ["r"], steps: [{ title: "one", files: ["a.py"], detail: "d", verify: "sh check.sh" }] }
    const allow = DEFAULT_CONFIG.delegate.verify_allow
    expect(() => validatePlan(plan, wt.worktree, allow, { minSteps: 0 })).toThrow()
    expect(() => validatePlan(plan, wt.worktree, allow, { minSteps: 1, maxSteps: 50 })).toThrow()
    expect(validatePlan(plan, wt.worktree, allow, UNIT_LIMITS)).toEqual([])
  })
})

describe("registry and substrate seams", () => {
  test("requiredArtifactKeys reads data: ultragoal/autoresearch done need their evidence; other phases gate nothing", () => {
    const goalsRef = { path: "p", sha256: "a".repeat(64), ids: ["g1", "g2"] }
    const progress = { g1: { noProgress: 0, attempt: 1, lastCheckpoint: "checkpoints/g1-1.json" }, g2: { noProgress: 0, attempt: 1, lastCheckpoint: "checkpoints/g2-1.json" } }
    expect(requiredArtifactKeys({ kind: "ultragoal", stage: "terminal", phase: "done", data: { v: 1, request: "x", findings: [], attempts: 0, goals: goalsRef, progress } } as never))
      .toEqual(["goals.json", "completion.json", "checkpoints/g1-1.json", "checkpoints/g2-1.json"])
    expect(requiredArtifactKeys({ kind: "autoresearch", stage: "terminal", phase: "done", data: { runs: [{ attempt: 1 }, { attempt: 2 }] } } as never))
      .toEqual(["mission.json", "verdict.json", "runs/1.json", "runs/2.json"])
    expect(requiredArtifactKeys({ kind: "ultragoal", stage: "unit_execute", phase: "executing", data: {} } as never)).toEqual([])
    expect(requiredArtifactKeys({ kind: "autoresearch", stage: "terminal", phase: "cancelled", data: {} } as never)).toEqual([])
  })

  test("verification receipts are a receipt kind; experiment is a registry activity kind", () => {
    expect(RECEIPT_KINDS).toContain("verification")
    const f = fixture()
    const ref = writeReceipt(wt.worktree, { kind: "verification", wid: WID, sid: SESSION, revision: 0, action: "verification-t1", inputSha: sha256("x"), body: { exitCode: 0 } })
    expect(ref).toMatch(/#[a-f0-9]{64}$/)
    const release = beginExecutionActivity(f.runtime, SESSION, "experiment")
    expect(release).not.toBeNull()
    release!()
  })

  test("validatePlan limits: 1-step units are valid only with an explicit limits param; the default stays 3-10", () => {
    const plan: Plan = { goal: "g", revision: 1, risks: ["r"], steps: [{ title: "one", files: ["a.py"], detail: "d", verify: "sh check.sh" }] }
    const allow = DEFAULT_CONFIG.delegate.verify_allow
    expect(validatePlan(plan, wt.worktree, allow).join(";")).toContain("3-10 steps")
    expect(validatePlan(plan, wt.worktree, allow, { minSteps: 1 }).join(";")).not.toContain("steps")
    const eleven = { ...plan, steps: Array.from({ length: 11 }, (_, i) => ({ ...plan.steps[0]!, title: `s${i}` })) }
    expect(validatePlan(eleven, wt.worktree, allow, { minSteps: 1, maxSteps: 10 }).join(";")).toContain("1-10 steps")
  })

  test("the committed snapshot of a unit workflow is the unit kind, not a plan", () => {
    const f = fixture()
    seedUnitWorkflow(f)
    expect(committedSnapshot(wt.worktree)).toMatchObject({ kind: "ultragoal", id: WID })
  })
})

describe("verifier-run parity", () => {
  async function harness() {
    const f = fixture()
    const store = (await createSnapshotStore(wt.worktree, join(sessionDir(wt.worktree, SESSION), "snapshots", "parity")))!
    const claim = f.runtime.runs.claim(SESSION, f.runtime.instance, process.pid)
    const entry: VerifierRunEntry = { aborted: false, claim }
    const config = { diff_exclude: DEFAULT_CONFIG.delegate.diff_exclude, diff_max_chars: 6000, verify_timeout_ms: 20_000, verify_output_chars: 1500 }
    const run = (command: string) => runVerifierExecution(f.runtime, entry, { sessionID: SESSION, taskID: "t1", attemptID: "a1", attemptNumber: 1, command, root: wt.worktree, store, config })
    return { f, entry, claim, run, store }
  }

  test("an ok script is ok/unchanged and settled", async () => {
    writeFileSync(join(wt.worktree, "ok.sh"), "exit 0\n")
    const h = await harness()
    const out = await h.run("sh ok.sh")
    expect(out).toMatchObject({ kind: "ran", ok: true, integrity: "unchanged", invalidated: false })
    h.f.runtime.runs.release(h.claim)
  })

  test("a file-writing script is integrity changed and the file is restored", async () => {
    writeFileSync(join(wt.worktree, "write.sh"), "echo polluted > stray.txt\nexit 0\n")
    const h = await harness()
    const out = await h.run("sh write.sh")
    expect(out).toMatchObject({ kind: "ran", ok: false, integrity: "changed", invalidated: true })
    expect(existsSync(join(wt.worktree, "stray.txt"))).toBe(false)
    h.f.runtime.runs.release(h.claim)
  })

  test("abort before prepare is retired, not run", async () => {
    writeFileSync(join(wt.worktree, "marker.sh"), "echo ran > marker.txt\n")
    const h = await harness()
    h.entry.aborted = true
    const out = await h.run("sh marker.sh")
    expect(out).toEqual({ kind: "cancelled" })
    expect(existsSync(join(wt.worktree, "marker.txt"))).toBe(false)
    const executions = h.f.runtime.runs.status().executions
    expect(executions).toHaveLength(1)
    expect(executions[0]!.verifierDispatch).not.toBe("started")
    h.f.runtime.runs.release(h.claim)
  })
})
