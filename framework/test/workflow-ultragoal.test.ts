// P6b S2: the ultragoal engine and the ralplan -> ultragoal handoff. Deterministic fixture host (scripted outputs per
// role, a real queue with real verifier scripts); no live model. Model prose never completes anything: only code-run
// verification receipts, typed APPROVE-UNIT receipts and the in-transaction all-goal evidence do.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { reattachOwner, stopHeartbeat } from "../src/flow/runtime.ts"
import { readEvents } from "../src/flow/state.ts"
import { createForegroundController } from "../src/hosts/controller.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"
import { worktreeRoot } from "../src/orchestration/worktree.ts"
import { attachAdmission, holdAdmission } from "../src/sessions/admission.ts"
import { openSession } from "../src/sessions/store.ts"
import { readLedger } from "../src/state/ledger.ts"
import { stateRoot } from "../src/state/store.ts"
import { sha256 } from "../src/workflows/artifacts.ts"
import { __setCommitFaultHook, readCommitted } from "../src/workflows/commit.ts"
import { ULTRAGOAL_DECOMPOSE_PROMPT } from "../src/workflows/prompts/index.ts"
import { RALPLAN_PROMPTS } from "../src/workflows/prompts/index.ts"
import { ralplanDataOf } from "../src/workflows/ralplan.ts"
import { confirmExecute, executeConfirmation, runRalplan, startRalplan } from "../src/workflows/ralplan-driver.ts"
import { writeReceipt } from "../src/workflows/receipts.ts"
import { kindAllowsRole, parseEnvelope } from "../src/workflows/registry.ts"
import { parseStageEventsFor, runWorkflowTurn } from "../src/workflows/turn.ts"
import { approveUnitConfirmation, nextStep, reduce, ultragoalDataOf, type UltragoalWorkflow } from "../src/workflows/ultragoal.ts"
import { commitUltragoal } from "../src/workflows/ultragoal-commit.ts"
import { approveUnit, retryUltragoal, runUltragoal, ultragoalView } from "../src/workflows/ultragoal-driver.ts"
import { parseUltragoalData, ultragoalDoneKeys } from "../src/workflows/ultragoal-data.ts"
import { readRecordedText, renderCompletion, ultragoalEvidence } from "../src/workflows/ultragoal-evidence.ts"
import { tempGitWorktree, waitFor } from "./guards-helpers.ts"

const ENGINE = "fixture"
const CONTROLS = Object.fromEntries([
  "boundedInput", "boundedOutput", "preExecutionToolPolicy", "headlessPermissionRefusal", "ownedCancellation",
  "quiescenceEvidence", "identityBinding", "noReplayRecovery", "readOnlyWorkflow", "readOnlyWorktree", "serialWorkerLease",
].map(key => [key, "supported" as const]))

let wt: ReturnType<typeof tempGitWorktree>
let counter = 0
let SID: string
/** Runs inside the final critic's turn, i.e. after the pre-check and before the commit transaction. */
let onFinalCritic: (() => void) | undefined
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree) })
afterEach(() => { onFinalCritic = undefined; __setCommitFaultHook(null); stopHeartbeat(); wt.cleanup() })

// ---------------------------------------------------------------------------------------------- fixture
const j = (value: unknown) => JSON.stringify(value)
const goals = (n: number) => j({ type: "goals", goals: Array.from({ length: n }, (_, i) => ({ title: `goal ${i + 1}`, objective: `module ${i + 1} exists and its check passes` })) })
const unitPlan = (n: number, detail = `write module ${n}`) => j({
  type: "unit_plan", risks: ["risk"], steps: [{ title: `make mod${n}`, files: [`mod${n}.py`], detail, verify: `sh check_g${n}.sh` }],
})
const verdict = (value: string, findings: string[] = []) => j({ type: "lane_verdict", verdict: value, findings })
const OKAY = verdict("OKAY")
const ARCH = { status: "CLEAR", decision: "APPROVE" }
const ralplanPlan = j({ type: "plan_doc", sections: [{ title: "Goal", body: "Build modules." }, { title: "Risks", body: "Few." }] })

type Script = { planner?: string[]; architect?: string[]; critic?: string[] }
type Options = {
  script: Script
  worker?: (request: ExecutionRequest) => ExecutionOutcome | Promise<ExecutionOutcome>
  /** Intercepts a read-only role request (return a promise to block the turn). */
  intercept?: (request: ExecutionRequest) => Promise<ExecutionOutcome> | undefined
  onCancel?: () => void | Promise<void>
  /** Run every unit in the workflow's plan worktree (`chat.worktree: "plan"`). */
  isolate?: boolean
}

function harness(options: Options) {
  const queues: Record<string, string[]> = {
    planner: [ralplanPlan, ...(options.script.planner ?? [])],
    architect: [j({ type: "lane_verdict", ...ARCH, findings: [] }), ...(options.script.architect ?? [])],
    critic: [OKAY, ...(options.script.critic ?? [])],
  }
  const config = { ...DEFAULT_CONFIG, delegate: { ...DEFAULT_CONFIG.delegate, worktree: false, max_attempts: 2 } }
  const requests: ExecutionRequest[] = []
  let sequence = 0
  const runs = createExecutionRunStore(wt.worktree)
  const sid = `ses_ug${counter++}`
  const runtime: ExecutionRuntime = {
    instance: "ug-controller", directory: wt.worktree, worktree: wt.worktree, stateRoot: stateRoot(wt.worktree), config,
    log: () => {}, runs, verificationProfile: "legacy-unowned", verifier: createLegacyVerifierExecutor(),
    observe: { task() {} },
    policy: createExecutionPolicy(config, { directory: wt.worktree, worktree: wt.worktree }),
    host: {
      identity: { engine: ENGINE, profile: "code" },
      async preflight() { return { compatible: true, controls: CONTROLS as never, problems: [] } },
      async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "fixture reconciliation" } },
      async prepare(request) {
        requests.push(request)
        const vendorSessionID = `child_${++sequence}`
        runtime.policy.bindSession(vendorSessionID, request.handlers, request.policy)
        let completed = false
        return {
          reference: { executionID: request.executionID, vendorSessionID },
          async run(): Promise<ExecutionOutcome> {
            let result: ExecutionOutcome
            if (request.role === "reviewer") result = { status: "completed", text: "ACCEPT" }
            else if (request.role === "worker") result = options.worker ? await options.worker(request) : { status: "completed", text: "Open issues: none" }
            else {
              if (request.role === "critic" && request.text.includes("GOALS AND VERIFIED CHECKPOINTS")) onFinalCritic?.()
      const blocked = options.intercept?.(request)
              if (blocked) result = await blocked
              else {
                const text = queues[request.role]?.shift()
                result = text === undefined ? { status: "failed", error: `script exhausted for ${request.role}` } : { status: "completed", text }
              }
            }
            completed = true
            return result
          },
          async requestCancel() { await options.onCancel?.(); return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
          async reconcile() { return { outcome: completed ? "terminal" as const : "unknown" as const, quiescent: completed, evidence: "fixture child" } },
        }
      },
    },
  }
  SID = sid
  const store = attachAdmission(runtime, sid, { engine: ENGINE, model: "m" })
  const controller = createForegroundController(runtime, { planWorktree: options.isolate === true })
  return {
    runtime, store, sid, controller, requests, queues,
    workers: () => requests.filter(r => r.role === "worker"),
    modelTurns: () => requests.filter(r => r.role !== "worker" && r.role !== "reviewer"),
  }
}
type H = ReturnType<typeof harness>

const committed = (): UltragoalWorkflow => {
  const read = readCommitted(wt.worktree, {}, SID)
  if (read.state !== "ok" || read.wf.kind !== "ultragoal") throw new Error("no committed ultragoal")
  return read.wf
}
const anyCommitted = () => { const read = readCommitted(wt.worktree, {}, SID); if (read.state !== "ok") throw new Error("no workflow"); return read.wf }

/** Write the verification scripts: `pass` goals check for their module, `fail` goals always exit 1. */
function scripts(n: number, failing: number[] = []): void {
  for (let i = 1; i <= n; i++) writeFileSync(join(wt.worktree, `check_g${i}.sh`), failing.includes(i) ? "exit 1\n" : `test -f mod${i}.py\n`)
}
const writer = (request: ExecutionRequest): ExecutionOutcome => {
  const n = request.title.match(/make mod(\d+)/)?.[1]
  if (n) writeFileSync(join(wt.worktree, `mod${n}.py`), "VALUE = 1\n")
  return { status: "completed", text: "Open issues: none. Everything is done." }
}

/** ralplan -> typed execute confirmation -> ultragoal at decompose (one handoff). */
async function toUltragoal(h: H): Promise<UltragoalWorkflow> {
  const started = startRalplan(h.runtime, h.sid, "build the modules")
  if (!started.ok) throw new Error(started.text)
  const pending = await runRalplan(h.runtime, h.sid, started.wf.id)
  expect(pending.status).toBe("pending_execution")
  const wf = pending.wf!
  const sha = ralplanDataOf(wf).consensus!.planSha
  const handed = confirmExecute(h.runtime, h.sid, wf.id, wf.lastSeq, executeConfirmation(wf.id, sha))
  if (!handed.ok) throw new Error(handed.text)
  return committed()
}

type Drive = { final: Awaited<ReturnType<typeof runUltragoal>>; approvals: string[]; trail: string[] }
/** Drive to completion, approving every reviewed unit with its typed receipt (the human step). */
async function drive(h: H, options: { stopAt?: (wf: UltragoalWorkflow) => boolean; approve?: boolean } = {}): Promise<Drive> {
  const approvals: string[] = []
  const trail: string[] = []
  for (;;) {
    const wf = committed()
    const result = await runUltragoal(h.runtime, h.controller, h.sid, wf.id, { onStep: step => trail.push(`${step.stage}:${step.phase}`) })
    if (result.status !== "approval" || options.approve === false) return { final: result, approvals, trail }
    const current = result.wf!
    if (options.stopAt?.(current)) return { final: result, approvals, trail }
    const sha = ultragoalDataOf(current).pending!.subject.sha256
    const approved = approveUnit(h.runtime, h.sid, current.id, current.lastSeq, approveUnitConfirmation(current.id, sha))
    if (!approved.ok) throw new Error(approved.text)
    approvals.push(sha)
  }
}

// ---------------------------------------------------------------------------------------------- tests
describe("ultragoal stage and phase order (1)", () => {
  test("two goals follow the PA:274 stage/phase order and every revision parses", async () => {
    scripts(2)
    const h = harness({ script: { planner: [goals(2), unitPlan(1), unitPlan(2)], architect: [OKAY, OKAY], critic: [OKAY] }, worker: writer })
    await toUltragoal(h)
    const { final, trail, approvals } = await drive(h)
    expect(final.status).toBe("done")
    expect(approvals).toHaveLength(2)
    const unit = (n: number) => ["unit_plan:planning", "unit_review:reviewing", "unit_approval:pending_approval", "unit_execute:executing", "verify:executing", "checkpoint:planning"].filter(Boolean)
    void unit
    expect(trail).toEqual([
      "decompose:planning", "goal_select:planning",
      "unit_plan:planning", "unit_review:reviewing", "unit_approval:pending_approval",
      "unit_execute:executing", "verify:executing", "checkpoint:planning", "goal_select:planning",
      "unit_plan:planning", "unit_review:reviewing", "unit_approval:pending_approval",
      "unit_execute:executing", "verify:executing", "checkpoint:planning", "goal_select:planning",
      "final_review:reviewing", "terminal:done",
    ])
    const types = readEvents(wt.worktree, committed().id, SID).map(event => event.type)
    for (const type of ["goals_saved", "unit_prepared", "unit_reviewed", "execution_approved", "unit_terminal", "verification_recorded", "goal_checkpointed", "aggregate_verified"]) expect(types).toContain(type)
    const done = committed()
    expect(done).toMatchObject({ stage: "terminal", phase: "done" })
    parseEnvelope(done)
    for (const key of ["goals.json", "completion.json", "checkpoints/g1-1.json", "checkpoints/g2-1.json", "units/g1-1.json", "units/g1-1.md"]) expect(done.artifacts.map(ref => ref.key)).toContain(key)
    expect(ultragoalDoneKeys(done.data)).toEqual(["goals.json", "completion.json", "checkpoints/g1-1.json", "checkpoints/g2-1.json"])
    expect(ultragoalEvidence(wt.worktree, done, { final: true }).problems).toEqual([])
    expect(ultragoalView(done)).toContain("2 complete")
    // roles: only the registered read-only roles took model turns; the queue worker is the only code writer
    expect(h.modelTurns().map(r => r.role)).toEqual(expect.arrayContaining(["planner", "architect", "critic"]))
    expect(h.modelTurns().every(r => kindAllowsRole("ultragoal", r.role) || r.role === "planner")).toBe(true)
  })
})

describe("approval gate (2) and handoff (3)", () => {
  test("at unit_approval there are 0 tasks and 0 prepares of workers or verifiers; a wrong sha, the name and a ralplan receipt grant nothing", async () => {
    scripts(1)
    const h = harness({ script: { planner: [goals(1), unitPlan(1)], architect: [OKAY], critic: [OKAY] }, worker: writer })
    const ralplan = await toUltragoal(h)
    void ralplan
    const first = await drive(h, { approve: false })
    expect(first.final.status).toBe("approval")
    const wf = committed()
    expect(wf).toMatchObject({ stage: "unit_approval", phase: "pending_approval" })
    const data = ultragoalDataOf(wf)
    expect(h.workers()).toHaveLength(0)
    expect(readLedger(wt.worktree, h.sid).tasks).toHaveLength(0)
    expect(h.runtime.runs.status().executions.every(e => e.kind === "host")).toBe(true)
    const sha = data.pending!.subject.sha256
    const before = readFileSync(join(stateRoot(wt.worktree), "sessions", SID, "workflow", "workflow.json"))
    const planSha = data.seed!.planSha
    for (const typed of [
      `APPROVE-UNIT ${wf.id} ${"0".repeat(64)}`, `APPROVE-UNIT ${wf.id}`, "APPROVE", "ultragoal", `EXECUTE ${data.seed!.workflowID} ${planSha}`,
      executeConfirmation(data.seed!.workflowID, planSha), `APPROVE-UNIT other ${sha}`, "",
    ]) {
      expect(approveUnit(h.runtime, h.sid, wf.id, wf.lastSeq, typed)).toMatchObject({ ok: false })
    }
    expect(approveUnit(h.runtime, h.sid, wf.id, wf.lastSeq + 1, approveUnitConfirmation(wf.id, sha))).toMatchObject({ ok: false })
    expect(readFileSync(join(stateRoot(wt.worktree), "sessions", SID, "workflow", "workflow.json")).equals(before)).toBe(true)
    expect(h.workers()).toHaveLength(0)
    expect(readLedger(wt.worktree, h.sid).tasks).toHaveLength(0)
    // the run itself never advances past approval without the receipt
    expect((await runUltragoal(h.runtime, h.controller, h.sid, wf.id)).status).toBe("approval")
    expect(h.workers()).toHaveLength(0)
  })

  test("confirmExecute makes 1 handoff with lineage = ralplan id/rev/pending-approval; ralplan is done; ultragoal starts at decompose; the execute receipt cannot approve a unit", async () => {
    scripts(1)
    const h = harness({ script: { planner: [goals(1), unitPlan(1)], architect: [OKAY], critic: [OKAY] }, worker: writer })
    const started = startRalplan(h.runtime, h.sid, "build the modules")
    if (!started.ok) throw new Error(started.text)
    const pending = (await runRalplan(h.runtime, h.sid, started.wf.id)).wf!
    const sha = ralplanDataOf(pending).consensus!.planSha
    const planRef = pending.artifacts.find(ref => ref.key === "pending-approval.md")!
    const handoffsBefore = readEvents(wt.worktree, undefined, SID).filter(event => event.type === "execute_confirmed").length
    expect(confirmExecute(h.runtime, h.sid, pending.id, pending.lastSeq, "yes")).toMatchObject({ ok: false })
    expect(anyCommitted().kind).toBe("ralplan")
    const handed = confirmExecute(h.runtime, h.sid, pending.id, pending.lastSeq, executeConfirmation(pending.id, sha))
    if (!handed.ok) throw new Error(handed.text)
    expect(handed.wf).toMatchObject({ kind: "ralplan", stage: "terminal", phase: "done" })
    const ug = committed()
    expect(ug).toMatchObject({ stage: "decompose", phase: "planning" })
    expect(ug.lineage?.predecessor).toMatchObject({ id: pending.id, kind: "ralplan", artifact: { path: planRef.path, sha256: planRef.sha256 } })
    expect(ug.lineage!.predecessor.revision).toBeGreaterThan(pending.lastSeq - 1)
    expect(readEvents(wt.worktree, undefined, SID).filter(event => event.type === "execute_confirmed")).toHaveLength(handoffsBefore + 1)
    expect(ultragoalDataOf(ug).seed).toMatchObject({ workflowID: pending.id, planSha: planRef.sha256 })
    expect(h.workers()).toHaveLength(0)
    expect(readLedger(wt.worktree, h.sid).tasks).toHaveLength(0)
    // the ralplan execute receipt authorizes only the handoff: it is not accepted as a unit approval
    expect(approveUnit(h.runtime, h.sid, ug.id, ug.lastSeq, executeConfirmation(pending.id, sha))).toMatchObject({ ok: false })
    // a second confirmation after the handoff finds no pending ralplan
    expect(confirmExecute(h.runtime, h.sid, pending.id, pending.lastSeq, executeConfirmation(pending.id, sha))).toMatchObject({ ok: false })
    expect(committed().id).toBe(ug.id)
  })
})

describe("review iteration (4)", () => {
  test("an ITERATE review yields a new unit sha, the old approval is stale and the next plan prompt carries the findings", async () => {
    scripts(1)
    const h = harness({
      script: { planner: [goals(1), unitPlan(1, "first try"), unitPlan(1, "second try, tightened")], architect: [verdict("ITERATE", ["the check is too weak"]), OKAY], critic: [OKAY] },
      worker: writer,
    })
    await toUltragoal(h)
    const first = await drive(h, { approve: false })
    expect(first.final.status).toBe("approval")
    const wf = committed()
    const data = ultragoalDataOf(wf)
    expect(data.pending!.attempt).toBe(2)
    expect(data.progress.g1!.noProgress).toBe(1)
    const planPrompts = h.modelTurns().filter(r => r.role === "planner").map(r => r.text)
    expect(planPrompts.at(-1)).toContain("the check is too weak")
    // the first unit's documents were superseded: its sha is not approvable now
    const oldSubjectSha = sha256("stale")
    expect(approveUnit(h.runtime, h.sid, wf.id, wf.lastSeq, approveUnitConfirmation(wf.id, oldSubjectSha))).toMatchObject({ ok: false })
    const events = readEvents(wt.worktree, wf.id, SID).filter(event => event.type === "unit_prepared").map(event => event.data?.subject)
    expect(events).toHaveLength(2)
    expect(events[0]).not.toBe(events[1])
    expect(events[1]).toBe(data.pending!.subject.sha256)
    expect(approveUnit(h.runtime, h.sid, wf.id, wf.lastSeq, approveUnitConfirmation(wf.id, String(events[0])))).toMatchObject({ ok: false })
    expect(h.workers()).toHaveLength(0)
  })
})

describe("no-progress cap and worker prose (5, 7)", () => {
  async function failing(unitCount: number) {
    scripts(1, [1])
    const planner = [goals(1), ...Array.from({ length: unitCount }, (_, i) => unitPlan(1, `attempt ${i + 1}`))]
    const h = harness({ script: { planner, architect: Array.from({ length: unitCount }, () => OKAY), critic: [OKAY] }, worker: writer })
    await toUltragoal(h)
    return h
  }

  test("with verification always failing: at 9 continuations it is still running; at 10 the goal is blocked, stuck at checkpoint, with no completion.json and no complete checkpoint", async () => {
    const h = await failing(10)
    const result = await drive(h, { stopAt: wf => ultragoalDataOf(wf).pending!.attempt === 10 })
    // attempt 10 is reviewed and waiting for its approval: 9 no-progress continuations so far, still live
    expect(result.final.status).toBe("approval")
    expect(ultragoalDataOf(committed()).progress.g1).toMatchObject({ noProgress: 9, attempt: 10 })
    expect(committed()).toMatchObject({ stage: "unit_approval", phase: "pending_approval" })
    const wf = committed()
    const approved = approveUnit(h.runtime, h.sid, wf.id, wf.lastSeq, approveUnitConfirmation(wf.id, ultragoalDataOf(wf).pending!.subject.sha256))
    expect(approved.ok).toBe(true)
    const last = await runUltragoal(h.runtime, h.controller, h.sid, wf.id)
    expect(last.status).toBe("stuck")
    const stuck = committed()
    expect(stuck).toMatchObject({ stage: "checkpoint", phase: "stuck" })
    const data = ultragoalDataOf(stuck)
    expect(data.stuck).toMatchObject({ kind: "goal_blocked", goalId: "g1" })
    expect(data.stuck!.evidence.length).toBeGreaterThan(0)
    expect(data.progress.g1).toMatchObject({ noProgress: 10 })
    expect(data.progress.g1!.lastCheckpoint).toBeUndefined()
    expect(stuck.artifacts.map(ref => ref.key)).not.toContain("completion.json")
    expect(existsSync(join(wt.worktree, ".otter", "workflows", h.sid, stuck.id, "completion.json"))).toBe(false)
    expect(ultragoalView(stuck)).toContain("ULTRAGOAL-STUCK")
    // a blocked goal cannot be retried into completion
    expect(retryUltragoal(h.runtime, h.sid, stuck.id, stuck.lastSeq)).toMatchObject({ ok: false })
    expect(nextStep(stuck).kind).toBe("blocked")
  }, 120_000)

  test("worker prose saying it is done with verification exit 1 does not complete the goal", async () => {
    const h = await failing(1)
    const result = await drive(h, { stopAt: () => false })
    expect(["approval", "blocked", "stuck"]).toContain(result.final.status)
    const wf = committed()
    const data = ultragoalDataOf(wf)
    expect(data.progress.g1!.lastCheckpoint).toBeUndefined()
    expect(data.progress.g1!.noProgress).toBeGreaterThanOrEqual(1)
    expect(wf.phase).not.toBe("done")
    const events = readEvents(wt.worktree, wf.id, SID)
    expect(events.find(event => event.type === "verification_recorded")?.data).toMatchObject({ ok: false })
    expect(events.find(event => event.type === "goal_checkpointed")?.data).toMatchObject({ complete: false })
    const worker = h.workers()
    expect(worker.length).toBeGreaterThan(0)
    // the ledger's own verify result is what counted, not the worker's text
    const task = readLedger(wt.worktree, h.sid).tasks[0]!
    expect(task.report ?? "").toContain("done")
    expect(task.verify_result?.exitCode).toBe(1)
  })
})

describe("all-goal aggregate proof (6)", () => {
  async function toFinal(): Promise<H> {
    scripts(3)
    const h = harness({ script: { planner: [goals(3), unitPlan(1), unitPlan(2), unitPlan(3)], architect: [OKAY, OKAY, OKAY], critic: [OKAY] }, worker: writer })
    await toUltragoal(h)
    const result = await drive(h, { stopAt: () => false })
    void result
    return h
  }
  // stop right before the final review so the proof can be tampered with
  async function atFinalReview(): Promise<H> {
    scripts(3)
    const h = harness({ script: { planner: [goals(3), unitPlan(1), unitPlan(2), unitPlan(3)], architect: [OKAY, OKAY, OKAY], critic: [OKAY] }, worker: writer })
    await toUltragoal(h)
    for (;;) {
      const wf = committed()
      const result = await runUltragoal(h.runtime, h.controller, h.sid, wf.id, { stopBefore: "final_review" })
      if (result.status === "approval") {
        const cur = result.wf!
        const ok = approveUnit(h.runtime, h.sid, cur.id, cur.lastSeq, approveUnitConfirmation(cur.id, ultragoalDataOf(cur).pending!.subject.sha256))
        if (!ok.ok) throw new Error(ok.text)
        continue
      }
      expect(result.reason).toBe("stopped before final_review")
      break
    }
    expect(committed()).toMatchObject({ stage: "final_review", phase: "reviewing" })
    return h
  }
  void toFinal

  const checkpointPath = (key: string) => join(wt.worktree, ".otter", "workflows", "X", key)
  const tamper: Array<[string, (h: H, wf: UltragoalWorkflow) => void]> = [
    ["altering g2's checkpoint", (_h, wf) => writeFileSync(join(wt.worktree, wf.artifacts.find(r => r.key === "checkpoints/g2-1.json")!.path), "{}\n")],
    ["deleting g2's checkpoint", (_h, wf) => rmSync(join(wt.worktree, wf.artifacts.find(r => r.key === "checkpoints/g2-1.json")!.path))],
    ["removing g2's verification receipt", (h, wf) => {
      const doc = JSON.parse(readFileSync(join(wt.worktree, wf.artifacts.find(r => r.key === "checkpoints/g2-1.json")!.path), "utf8")) as { verificationRef: string }
      rmSync(join(stateRoot(wt.worktree), doc.verificationRef.split("#")[0]!))
      void h
    }],
    ["editing g2's unit document", (_h, wf) => writeFileSync(join(wt.worktree, wf.artifacts.find(r => r.key === "units/g2-1.md")!.path), "tampered\n")],
    ["altering goals.json", (_h, wf) => writeFileSync(join(wt.worktree, wf.artifacts.find(r => r.key === "goals.json")!.path), "{}\n")],
  ]
  void checkpointPath

  for (const [name, break_] of tamper) {
    test(`${name} makes the final commit refuse even though the critic said OKAY`, async () => {
      const h = await atFinalReview()
      const wf = committed()
      // the proof is broken while the critic is answering OKAY: the context was built from intact files
      onFinalCritic = () => break_(h, wf)
      const result = await runUltragoal(h.runtime, h.controller, h.sid, wf.id)
      expect(result.status).toBe("stuck")
      const stuck = committed()
      expect(stuck.phase).toBe("stuck")
      expect(ultragoalDataOf(stuck).stuck).toMatchObject({ kind: "evidence" })
      expect(stuck.artifacts.map(ref => ref.key)).not.toContain("completion.json")
      expect(h.modelTurns().filter(r => r.role === "critic").length).toBeGreaterThanOrEqual(1)
    }, 120_000)
  }

  test("the commit transaction itself refuses done when a checkpoint changed after the critic and completion were written", async () => {
    const h = await atFinalReview()
    const wf = committed()
    const evidence = ultragoalEvidence(wt.worktree, wf)
    expect(evidence.problems).toEqual([])
    const finalRef = writeReceipt(wt.worktree, {
      kind: "consensus", wid: wf.id, sid: wf.sessionID, revision: wf.lastSeq, action: "final-review-manual", inputSha: evidence.goalsSha!, body: { role: "critic", verdict: "OKAY", findings: [] },
    })
    const completionText = renderCompletion(wf, evidence.goalsSha!, evidence.entries!, finalRef)
    const dir = join(wt.worktree, ".otter", "workflows", wf.sessionID, wf.id)
    writeFileSync(join(dir, "completion.json"), completionText)
    const completion = { key: "completion.json", path: join(".otter", "workflows", wf.sessionID, wf.id, "completion.json"), sha256: sha256(completionText) }
    // g2's checkpoint changes after everything else was prepared
    writeFileSync(join(wt.worktree, wf.artifacts.find(r => r.key === "checkpoints/g2-1.json")!.path), "{}\n")
    const refused = commitUltragoal(wt.worktree, wf, fresh => ({ ...reduce(fresh, { type: "aggregate_verified", completion, ref: finalRef }), receipts: [finalRef] }))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.text).toMatch(/checkpoints\/g2-1\.json|ultragoal evidence/)
    expect(committed()).toMatchObject({ stage: "final_review", phase: "reviewing", lastSeq: wf.lastSeq })
  }, 120_000)

  test("model-influenced data cannot shrink the proof: a done record without its fixed goal list or with a missing checkpoint is unsatisfiable", () => {
    expect(() => ultragoalDoneKeys({})).toThrow()
    expect(() => ultragoalDoneKeys({ v: 1, request: "x", progress: {}, findings: [], attempts: 0 })).toThrow()
    const base = { v: 1, request: "x", findings: [], attempts: 0, goals: { path: "p", sha256: "a".repeat(64), ids: ["g1", "g2"] } }
    expect(() => ultragoalDoneKeys({ ...base, progress: { g1: { noProgress: 0, attempt: 1, lastCheckpoint: "checkpoints/g1-1.json" }, g2: { noProgress: 0, attempt: 0 } } })).toThrow()
    expect(() => parseUltragoalData({ ...base, progress: { g1: { noProgress: 0, attempt: 0 } } })).toThrow()
    expect(() => parseUltragoalData({ ...base, goals: { ...base.goals, ids: Array.from({ length: 11 }, (_, i) => `g${i + 1}`) }, progress: {} })).toThrow()
    expect(ultragoalDoneKeys({ ...base, progress: { g1: { noProgress: 0, attempt: 1, lastCheckpoint: "checkpoints/g1-1.json" }, g2: { noProgress: 0, attempt: 1, lastCheckpoint: "checkpoints/g2-1.json" } } }))
      .toEqual(["goals.json", "completion.json", "checkpoints/g1-1.json", "checkpoints/g2-1.json"])
  })
})

describe("malformed model output (8)", () => {
  test("two malformed outputs make it stuck; Retry runs the same stage", async () => {
    scripts(1)
    const h = harness({ script: { planner: ["not json at all", "still { not json", goals(1), unitPlan(1)], architect: [OKAY], critic: [OKAY] }, worker: writer })
    await toUltragoal(h)
    const id = committed().id
    const result = await runUltragoal(h.runtime, h.controller, h.sid, id)
    expect(result.status).toBe("stuck")
    const stuck = committed()
    expect(stuck).toMatchObject({ stage: "decompose", phase: "stuck" })
    expect(ultragoalDataOf(stuck).stuck).toMatchObject({ kind: "attempts" })
    expect(ultragoalDataOf(stuck).goals).toBeUndefined()
    const turnsBefore = h.modelTurns().length
    const retried = retryUltragoal(h.runtime, h.sid, id, stuck.lastSeq)
    if (!retried.ok) throw new Error(retried.text)
    expect(retried.wf).toMatchObject({ stage: "decompose", phase: "planning" })
    const next = await runUltragoal(h.runtime, h.controller, h.sid, id)
    expect(next.status).toBe("approval")
    expect(h.modelTurns().length).toBeGreaterThan(turnsBefore)
    expect(h.modelTurns().at(turnsBefore)!.text.startsWith(ULTRAGOAL_DECOMPOSE_PROMPT.text)).toBe(true)
  })

  test("a unit plan that fails the plan gates (forbidden path, unlisted verify command) is an attempt failure, never a unit", async () => {
    scripts(1)
    const bad = j({ type: "unit_plan", risks: ["r"], steps: [{ title: "x", files: [".otter/state.json"], detail: "d", verify: "curl http://x" }] })
    const h = harness({ script: { planner: [goals(1), bad, bad], architect: [OKAY], critic: [OKAY] }, worker: writer })
    await toUltragoal(h)
    const result = await runUltragoal(h.runtime, h.controller, h.sid, committed().id)
    expect(result.status).toBe("stuck")
    expect(committed()).toMatchObject({ stage: "unit_plan", phase: "stuck" })
    expect(ultragoalDataOf(committed()).pending).toBeUndefined()
    expect(readLedger(wt.worktree, h.sid).tasks).toHaveLength(0)
  })
})

describe("pause, cancel and reattach (9, 10, 11)", () => {
  test("a pause during unit_review settles and resumes into review with no tasks", async () => {
    scripts(1)
    let release: ((outcome: ExecutionOutcome) => void) | undefined
    let blockedOnce = false
    const h = harness({
      script: { planner: [goals(1), unitPlan(1)], architect: [OKAY], critic: [OKAY] }, worker: writer,
      intercept: request => {
        if (request.role !== "architect" || blockedOnce || !request.text.includes("UNIT TO REVIEW")) return undefined
        blockedOnce = true
        return new Promise<ExecutionOutcome>(resolve => { release = resolve })
      },
      onCancel: async () => { release?.({ status: "cancelled" }); await new Promise<void>(resolve => setImmediate(resolve)) },
    })
    await toUltragoal(h)
    const id = committed().id
    const running = runUltragoal(h.runtime, h.controller, h.sid, id).then(result => result, (error: unknown) => ({ status: "error", error }))
    await waitFor(() => blockedOnce)
    expect(committed()).toMatchObject({ stage: "unit_review", phase: "reviewing" })
    expect(h.controller.pause(h.sid).ok).toBe(true)
    await running
    await waitFor(() => committed().phase === "paused")
    expect(committed()).toMatchObject({ phase: "paused", pausedFrom: { phase: "reviewing", stage: "unit_review" } })
    expect(readLedger(wt.worktree, h.sid).tasks).toHaveLength(0)
    const outcome = await h.controller.resumePaused(h.sid, async () => true)
    expect(outcome.kept).toBe(false)
    expect(committed()).toMatchObject({ stage: "unit_review", phase: "reviewing" })
    expect(h.workers()).toHaveLength(0)
    expect(readLedger(wt.worktree, h.sid).tasks).toHaveLength(0)
    // the review turn runs again from the same stage and the workflow reaches approval
    const next = await runUltragoal(h.runtime, h.controller, h.sid, id)
    expect(next.status).toBe("approval")
    expect(h.workers()).toHaveLength(0)
  }, 60_000)

  test("cancel at approval retains every file, /continue is refused, a new start gets a new id", async () => {
    scripts(1)
    const h = harness({ script: { planner: [goals(1), unitPlan(1), ralplanPlan], architect: [OKAY], critic: [OKAY] }, worker: writer })
    await toUltragoal(h)
    await drive(h, { approve: false })
    const wf = committed()
    expect(wf.stage).toBe("unit_approval")
    const files = wf.artifacts.map(ref => join(wt.worktree, ref.path))
    expect(h.controller.cancel(h.sid).ok).toBe(true)
    const cancelled = anyCommitted()
    expect(cancelled).toMatchObject({ id: wf.id, phase: "cancelled" })
    for (const file of files) expect(existsSync(file)).toBe(true)
    expect(readLedger(wt.worktree, h.sid).tasks).toHaveLength(0)
    await expect(h.controller.resume(h.sid)).rejects.toThrow()
    expect((await runUltragoal(h.runtime, h.controller, h.sid, wf.id)).status).toBe("done")
    expect(approveUnit(h.runtime, h.sid, wf.id, cancelled.lastSeq, approveUnitConfirmation(wf.id, "a".repeat(64)))).toMatchObject({ ok: false })
    const fresh = startRalplan(h.runtime, h.sid, "start again")
    if (!fresh.ok) throw new Error(fresh.text)
    expect(fresh.wf.id).not.toBe(wf.id)
    for (const file of files) expect(existsSync(file)).toBe(true)
  })

  test("a reattached held epoch keeps the slot and the id and dispatches nothing before an explicit Resume", async () => {
    scripts(1)
    const h = harness({ script: { planner: [goals(1), unitPlan(1)], architect: [OKAY], critic: [OKAY] }, worker: writer })
    await toUltragoal(h)
    await drive(h, { approve: false })
    const wf = committed()
    holdAdmission(wt.worktree, h.sid, "restore")
    h.store.release({ workflowQuiescent: true, evidence: "fixture has no queue, activity, claim or unsettled execution", workflowID: wf.id, revision: wf.lastSeq })
    const store = openSession(wt.worktree, h.sid, { engine: ENGINE, model: "m" })
    holdAdmission(wt.worktree, h.sid, "restore")
    const dispatchesBefore = h.requests.length
    const result = reattachOwner(h.runtime, store, wf.id, wf.lastSeq)
    if ("refuse" in result) throw new Error(result.refuse)
    expect(result.wf).toMatchObject({ id: wf.id, kind: "ultragoal", stage: "unit_approval", owner: { instance: store.epoch } })
    expect(committed().id).toBe(wf.id)
    expect(readEvents(wt.worktree, wf.id, SID).filter(event => event.type === "owner_reattached")).toHaveLength(1)
    // held: the engine refuses to advance, approve or dispatch
    const after = committed()
    const blocked = await runUltragoal(h.runtime, h.controller, h.sid, wf.id)
    expect(blocked.status).toBe("approval")
    expect(approveUnit(h.runtime, h.sid, wf.id, after.lastSeq, approveUnitConfirmation(wf.id, ultragoalDataOf(after).pending!.subject.sha256))).toMatchObject({ ok: false })
    expect(h.requests.length).toBe(dispatchesBefore)
    expect(readLedger(wt.worktree, h.sid).tasks).toHaveLength(0)
    expect(committed()).toMatchObject({ stage: "unit_approval", lastSeq: after.lastSeq })
    void currentOwner
  })
})

describe("role and event guards (12)", () => {
  test("binding the worker (or any non-review role) at review throws, and a model event carrying stage/approval is rejected", async () => {
    scripts(1)
    const h = harness({ script: { planner: [goals(1), unitPlan(1)], architect: [OKAY], critic: [OKAY] }, worker: writer })
    await toUltragoal(h)
    await drive(h, { approve: false })
    const wf = committed()
    expect(wf.stage).toBe("unit_approval")
    const binding = (stage: string, role: string, prompt = ULTRAGOAL_DECOMPOSE_PROMPT) => ({
      workflowID: wf.id, revision: wf.lastSeq, kind: "ultragoal" as const, stage, role: role as never, prompt, supervisorSessionID: h.sid, epoch: h.store.epoch, ownerInstance: wf.owner.instance,
    })
    const request = { title: "t", text: ULTRAGOAL_DECOMPOSE_PROMPT.text, label: "ultragoal", cancelCause: "x", budget: { maxChars: 24_000, reserveChars: 8_000 } }
    for (const [stage, role] of [["unit_review", "worker"], ["unit_review", "reviewer"], ["final_review", "worker"], ["unit_plan", "worker"], ["decompose", "architect"], ["unit_execute", "planner"], ["verify", "worker"], ["unit_approval", "planner"]] as const) {
      await expect(runWorkflowTurn(h.runtime, binding(stage, role), request)).rejects.toThrow()
    }
    expect(h.requests.filter(r => r.role === "worker")).toHaveLength(0)
    const before = h.modelTurns().length
    for (const field of ["stage", "approval", "phase", "subject", "receipt", "owner", "revision", "approved", "artifacts"]) {
      const withField = j({ type: "lane_verdict", verdict: "OKAY", findings: [], [field]: "x" })
      expect(parseStageEventsFor(withField, "ultragoal", "unit_review").ok).toBe(false)
      const goalsWithField = j({ type: "goals", goals: [{ title: "a", objective: "b" }], [field]: "x" })
      expect(parseStageEventsFor(goalsWithField, "ultragoal", "decompose").ok).toBe(false)
    }
    // events from another stage's vocabulary are not allowed either, and code-owned stages accept no model events at all
    expect(parseStageEventsFor(goals(1), "ultragoal", "unit_review").ok).toBe(false)
    expect(parseStageEventsFor(OKAY, "ultragoal", "unit_execute").ok).toBe(false)
    expect(parseStageEventsFor(OKAY, "ultragoal", "verify").ok).toBe(false)
    expect(parseStageEventsFor(goals(11), "ultragoal", "decompose").ok).toBe(false)
    expect(parseStageEventsFor(j({ type: "goals", goals: [] }), "ultragoal", "decompose").ok).toBe(false)
    expect(h.modelTurns().length).toBe(before)
  })

  test("reducer guards: no complete checkpoint over failed verification, no out-of-order goal, no approval of another unit", async () => {
    scripts(2)
    const h = harness({ script: { planner: [goals(2), unitPlan(1)], architect: [OKAY], critic: [OKAY] }, worker: writer })
    await toUltragoal(h)
    await drive(h, { approve: false })
    const wf = committed()
    expect(() => reduce(wf, { type: "goal_selected", goalId: "g1" })).toThrow()
    expect(() => reduce(wf, { type: "all_goals_complete" })).toThrow()
    expect(() => reduce(wf, { type: "unit_terminal" })).toThrow()
    const data = ultragoalDataOf(wf)
    const other = { ...data.pending!, subject: { ...data.pending!.subject, sha256: sha256("other") } }
    expect(() => reduce(wf, { type: "execution_approved", current: { ...other, approval: { subject: other.subject, receiptRef: "x#y" }, taskIds: [], done: [], remaining: [] } })).toThrow()
  })
})

describe("architect S3 items: shared legacy pause policy and runner failures", () => {
  test("a pause during a sleeping legacy verify lets it exit, settles exactly once, and leaves no fence (shared let-run policy)", async () => {
    writeFileSync(join(wt.worktree, "check_g1.sh"), "sleep 1\ntest -f mod1.py\n")
    const h = harness({ script: { planner: [goals(1), unitPlan(1)], architect: [OKAY], critic: [OKAY] }, worker: writer })
    await toUltragoal(h)
    await drive(h, { approve: false })
    const wf = committed()
    const approved = approveUnit(h.runtime, h.sid, wf.id, wf.lastSeq, approveUnitConfirmation(wf.id, ultragoalDataOf(wf).pending!.subject.sha256))
    if (!approved.ok) throw new Error(approved.text)
    const running = runUltragoal(h.runtime, h.controller, h.sid, wf.id).then(result => result, (error: unknown) => ({ status: "error", error }))
    await waitFor(() => h.runtime.runs.status().executions.some(e => e.kind === "verifier" && e.verifierDispatch === "started"), 10_000)
    expect(h.controller.pause(h.sid).ok).toBe(true)
    expect(committed()).toMatchObject({ phase: "executing", stopIntent: { kind: "pause" } })
    await running
    await waitFor(() => committed().phase === "paused", 10_000)
    expect(readEvents(wt.worktree, wf.id, SID).filter(event => event.type === "pause_settled")).toHaveLength(1)
    const verifier = h.runtime.runs.status().executions.find(e => e.kind === "verifier")!
    expect(verifier.fence).toBeUndefined()
    expect(verifier.cancel).toBeUndefined()
    expect(h.runtime.runs.status().claim).toBeUndefined()
  }, 60_000)

  test("a non-stop runApprovedUnit failure is a visible stuck at unit_execute with the reason, never a silent throw", async () => {
    scripts(1)
    const h = harness({ script: { planner: [goals(1), unitPlan(1)], architect: [OKAY], critic: [OKAY] }, worker: writer })
    await toUltragoal(h)
    await drive(h, { approve: false })
    const wf = committed()
    const approved = approveUnit(h.runtime, h.sid, wf.id, wf.lastSeq, approveUnitConfirmation(wf.id, ultragoalDataOf(wf).pending!.subject.sha256))
    if (!approved.ok) throw new Error(approved.text)
    const broken = { async runApprovedUnit(): Promise<unknown> { throw new Error("execution unresolved; fence retained; cancel and retry") } }
    const result = await runUltragoal(h.runtime, broken, h.sid, wf.id)
    expect(result.status).toBe("stuck")
    expect(result.reason).toContain("fence retained")
    const stuck = committed()
    expect(stuck).toMatchObject({ stage: "unit_execute", phase: "stuck" })
    expect(ultragoalDataOf(stuck).stuck).toMatchObject({ kind: "runner" })
    expect(ultragoalView(stuck)).toContain("fence retained")
    expect(stuck.artifacts.map(ref => ref.key)).not.toContain("completion.json")
  }, 30_000)
})

describe("isolated stage recovery", () => {
  test.each(["missing", "changed git identity", "deleted during preflight", "deleted before first checkpoint"])("later stages refuse %s implementation worktree", async damage => {
    scripts(1)
    const h = harness({ script: { planner: [goals(1), unitPlan(1)], architect: [OKAY], critic: [OKAY] }, isolate: true,
      worker: request => { writeFileSync(join(request.cwd, "mod1.py"), "VALUE = 1\n"); return { status: "completed", text: "Open issues: none" } },
    })
    await toUltragoal(h)
    await drive(h, { approve: false })
    const pending = committed()
    expect(approveUnit(h.runtime, h.sid, pending.id, pending.lastSeq, approveUnitConfirmation(pending.id, ultragoalDataOf(pending).pending!.subject.sha256)).ok).toBe(true)
    expect((await runUltragoal(h.runtime, h.controller, h.sid, pending.id, { stopBefore: damage === "deleted before first checkpoint" ? "verify" : "final_review" })).status).toBe("blocked")
    const count = h.requests.length
    if (damage === "deleted during preflight") {
      const preflight = h.runtime.host.preflight.bind(h.runtime.host)
      h.runtime.host.preflight = async profile => {
        await h.controller.discardPlanWorktree(h.sid, pending.id)
        return preflight(profile)
      }
      await expect(runUltragoal(h.runtime, h.controller, h.sid, pending.id)).rejects.toThrow()
    } else if (damage === "deleted before first checkpoint") {
      await h.controller.discardPlanWorktree(h.sid, pending.id)
      await expect(runUltragoal(h.runtime, h.controller, h.sid, pending.id)).rejects.toThrow("worktree is missing")
    } else if (damage === "missing") {
      await h.controller.discardPlanWorktree(h.sid, pending.id)
      const result = await runUltragoal(h.runtime, h.controller, h.sid, pending.id)
      expect(result.status).toBe("stuck")
      expect(result.reason).toContain("worktree is missing")
    } else {
      writeFileSync(join(h.workers()[0]!.cwd, ".git"), "gitdir: /nonexistent/otter-test-forged\n")
      await expect(runUltragoal(h.runtime, h.controller, h.sid, pending.id)).rejects.toThrow()
    }
    expect(h.requests).toHaveLength(count)
    expect(committed().phase).not.toBe("done")
  }, 30_000)
})

describe("shared workflow worktree (S4)", () => {
  const cwdWriter = (request: ExecutionRequest): ExecutionOutcome => {
    const n = request.title.match(/make mod(\d+)/)?.[1]
    if (n) writeFileSync(join(request.cwd, `mod${n}.py`), `VALUE = ${n}\n`)
    return { status: "completed", text: "Open issues: none. Everything is done." }
  }

  test("units share one workflow worktree, see each other's unapplied changes, and the checkpoint digest points at it; the checkout changes only on Apply at final review", async () => {
    scripts(2)
    const seen: Array<{ cwd: string; hadMod1: boolean }> = []
    const stageReads: Array<{ cwd: string; hadMod1: boolean }> = []
    const h = harness({
      script: { planner: [goals(2), unitPlan(1), unitPlan(2)], architect: [OKAY, OKAY], critic: [OKAY] }, isolate: true,
      intercept: request => {
        if (request.text.includes("CURRENT GOAL g2") || request.text.includes("GOALS AND VERIFIED CHECKPOINTS")) stageReads.push({ cwd: request.cwd, hadMod1: existsSync(join(request.cwd, "mod1.py")) })
        return undefined
      },
      worker: request => {
        if (request.title.includes("make mod2")) seen.push({ cwd: request.cwd, hadMod1: existsSync(join(request.cwd, "mod1.py")) })
        return cwdWriter(request)
      },
    })
    await toUltragoal(h)
    const { final } = await drive(h)
    expect(final.status).toBe("done")
    const done = committed()
    const planPath = join(worktreeRoot(wt.worktree), h.sid, `wf-${done.id}`)
    expect(new Set(h.workers().map(request => request.cwd))).toEqual(new Set([planPath]))
    expect(stageReads).toEqual([{ cwd: planPath, hadMod1: true }, { cwd: planPath, hadMod1: true }])
    expect(seen).toEqual([{ cwd: planPath, hadMod1: true }]) // unit 2 saw unit 1's unapplied change
    expect(existsSync(join(wt.worktree, "mod1.py"))).toBe(false)
    expect(existsSync(join(wt.worktree, "mod2.py"))).toBe(false)
    // each checkpoint digest describes the workflow worktree, not the checkout
    for (const key of ["checkpoints/g1-1.json", "checkpoints/g2-1.json"]) {
      const doc = JSON.parse(readRecordedText(wt.worktree, done, key)) as { worktree: { head: string | null; statusSha: string | null; isolatedAs?: string } }
      expect(doc.worktree.isolatedAs).toBe(`wf-${done.id}`)
    }
    expect(ultragoalEvidence(wt.worktree, done, { final: true }).problems).toEqual([])
    // Apply happens once, at final review, through the controller; until then the worktree is kept
    expect(h.controller.pendingPlanWorktree(h.sid)).toBe(done.id)
    expect(await h.controller.reviewPlanWorktree(h.sid, done.id)).toMatchObject({ ok: true, files: ["mod1.py", "mod2.py"] })
    expect(existsSync(join(wt.worktree, "mod1.py"))).toBe(false)
    expect(await h.controller.applyPlanWorktree(h.sid, done.id)).toMatchObject({ ok: true, files: ["mod1.py", "mod2.py"] })
    expect(readFileSync(join(wt.worktree, "mod2.py"), "utf8")).toBe("VALUE = 2\n")
    expect(existsSync(planPath)).toBe(false)
    expect(h.controller.pendingPlanWorktree(h.sid)).toBeUndefined()
  }, 60_000)
})
