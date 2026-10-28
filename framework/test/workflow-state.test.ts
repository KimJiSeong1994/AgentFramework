// P5a S1: versioned envelope, kind registry, phases, stop intent and plan narrowing. Compile-time exhaustiveness is
// enforced by test/types/workflow-exhaustive.ts (included by `bun run typecheck`).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { activeWorkflow, newWorkflow, readWorkflowChecked, workflowPath, flowDir, type Workflow } from "../src/flow/state.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { TERMINAL as MACHINE_TERMINAL, transition, type FlowCore } from "../src/flow/machine.ts"
import { startWorkflow, stopHeartbeat } from "../src/flow/runtime.ts"
import { statusJson } from "../src/flow/status.ts"
import { FLOW_INSTRUCTIONS } from "../src/modes/instructions.ts"
import { isPlanWorkflow, narrowPlan, parseEnvelope, REGISTRY, startRefusal } from "../src/workflows/registry.ts"
import {
  isCancelPending, PHASES, STOP_KINDS, SUBJECT_KINDS, TERMINAL, WORKFLOW_KINDS, type Phase, type WorkflowEnvelope,
} from "../src/workflows/types.ts"
import { committedSnapshot, rewriteCommitted } from "./commit-fixture.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { beginExecutionActivity } from "../src/hosts/runtime.ts"
import { admitFixtureSession, requestCancel, fakeClient, makeDeps, releaseFixtureSession, tempWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempWorktree>
const stores: Array<ReturnType<typeof admitFixtureSession>> = []

beforeEach(() => { wt = tempWorktree() })
afterEach(() => {
  stopHeartbeat()
  for (const store of stores.splice(0)) releaseFixtureSession(wt.worktree, store)
  wt.cleanup()
})

function plan(overrides: Record<string, unknown> = {}): Workflow {
  const base = newWorkflow("ses_state", currentOwner(), "command", "request", "opencode")
  return { ...base, ...overrides } as Workflow
}

function parseRejects(value: unknown) {
  expect(() => parseEnvelope(value)).toThrow("invalid workflow state")
}

describe("envelope parsing", () => {
  test("accepts a v2 plan envelope and every other registered kind with its own stage union", () => {
    const wf = plan()
    expect(parseEnvelope(wf)).toEqual(wf)
    expect(narrowPlan(parseEnvelope(wf))).toEqual(wf)
    for (const kind of WORKFLOW_KINDS) {
      if (kind === "plan") continue
      const other = { ...wf, kind, stage: REGISTRY[kind].stages[0], data: {} }
      delete (other as Record<string, unknown>).entry
      delete (other as Record<string, unknown>).request
      delete (other as Record<string, unknown>).counters
      expect(parseEnvelope(other).kind).toBe(kind)
    }
  })

  test("rejects an unknown kind", () => parseRejects({ ...plan(), kind: "imaginary" }))
  test("rejects a version other than 2", () => { parseRejects({ ...plan(), version: 1 }); parseRejects({ ...plan(), version: 3 }) })
  test("rejects a stage that belongs to another kind", () => {
    parseRejects({ ...plan(), stage: "evidence" })
    const other = { ...plan(), kind: "autoresearch", stage: "decision", data: {} }
    parseRejects(other)
  })
  test("rejects a phase outside PHASES", () => parseRejects({ ...plan(), phase: "imaginary" }))
  test("rejects a missing or malformed stopIntent", () => {
    const wf = plan()
    const { stopIntent: _omit, ...without } = wf
    parseRejects(without)
    const intent = { kind: "cancel", token: "t", requestedFrom: { phase: "planning", stage: "draft" }, checkpoint: null, reason: "r" }
    expect(parseEnvelope({ ...wf, stopIntent: intent }).stopIntent).toEqual(intent as never)
    expect(parseEnvelope({ ...wf, stopIntent: { ...intent, kind: "pause" } }).stopIntent?.kind).toBe("pause")
    parseRejects({ ...wf, stopIntent: { ...intent, kind: "halt" } })
    parseRejects({ ...wf, stopIntent: { ...intent, token: "" } })
    parseRejects({ ...wf, stopIntent: { ...intent, token: undefined } })
    parseRejects({ ...wf, stopIntent: { ...intent, requestedFrom: undefined } })
    parseRejects({ ...wf, stopIntent: { ...intent, requestedFrom: { phase: "nope", stage: "draft" } } })
    parseRejects({ ...wf, stopIntent: { ...intent, checkpoint: 3 } })
    parseRejects({ ...wf, stopIntent: "cancel" })
  })
  test("rejects malformed artifacts, pausedFrom and orphan lists", () => {
    const wf = plan()
    parseRejects({ ...wf, artifacts: [{ key: "k" }] })
    parseRejects({ ...wf, artifacts: "none" })
    parseRejects({ ...wf, pausedFrom: { phase: "nope", stage: "draft" } })
    parseRejects({ ...wf, orphanedEvents: ["x"] })
    expect(parseEnvelope({ ...wf, artifacts: [{ key: "plan", path: "p", sha256: "a".repeat(64) }], pausedFrom: { phase: "planning", stage: "draft" } })).toBeTruthy()
  })
  test("rejects malformed plan data and owner", () => {
    parseRejects({ ...plan(), counters: { code_invalid: -1, review_iterations: 0, user_rejections: 0, nudges: 0 } })
    parseRejects({ ...plan(), owner: { instance: "", pid: 1 } })
    parseRejects({ ...plan(), owner: { instance: "x", pid: 0 } })
    parseRejects({ ...plan(), stuckCause: "secret-cause" })
  })
  test("subject kinds are the closed set from the plan and a malformed subject is not representable", () => {
    expect([...SUBJECT_KINDS]).toEqual(["plan", "implementation-unit", "experiment-unit"])
    expect([...STOP_KINDS]).toEqual(["pause", "cancel"])
  })
  test("parse failure never mutates or renames state", () => {
    mkdirSync(flowDir(wt.worktree), { recursive: true })
    const bytes = Buffer.from(JSON.stringify({ version: 2, kind: "imaginary" }))
    writeFileSync(workflowPath(wt.worktree), bytes)
    const read = readWorkflowChecked(wt.worktree)
    expect(read.wf).toBeNull()
    expect(read.corrupt).toBe(workflowPath(wt.worktree))
    expect(readFileSync(workflowPath(wt.worktree)).equals(bytes)).toBe(true)
  })
})

describe("phases", () => {
  test("PHASES contains paused and TERMINAL is exactly done and cancelled", () => {
    expect([...PHASES]).toEqual(["planning", "reviewing", "pending_approval", "executing", "stuck", "paused", "done", "cancelled"])
    expect([...TERMINAL].sort()).toEqual(["cancelled", "done"])
    expect(MACHINE_TERMINAL).toBe(TERMINAL)
    expect(TERMINAL.has("paused")).toBe(false)
  })

  test("every non-terminal phase has instruction text and terminal phases have none", () => {
    for (const phase of PHASES) expect(Object.hasOwn(FLOW_INSTRUCTIONS, phase)).toBe(!TERMINAL.has(phase))
    expect(FLOW_INSTRUCTIONS.paused).toContain("paused")
  })

  test("plan stageOf is total and paused keeps the previous stage", () => {
    for (const phase of PHASES) expect(REGISTRY.plan.stages).toContain(REGISTRY.plan.stageOf(phase, REGISTRY.plan.stages[1]))
    expect(REGISTRY.plan.stageOf("paused", REGISTRY.plan.stages[1])).toBe(REGISTRY.plan.stages[1]!)
  })

  test("phaseOf is total over every stage of every kind and is always an allowed phase; paused is allowed at every live stage", () => {
    for (const kind of WORKFLOW_KINDS) {
      const d = REGISTRY[kind] as { stages: readonly string[]; phaseOf(stage: string): Phase; allowedPhases(stage: string): readonly Phase[] }
      for (const stage of d.stages) {
        expect(PHASES).toContain(d.phaseOf(stage))
        const allowed = d.allowedPhases(stage)
        if (stage === "terminal") expect(allowed.every(phase => TERMINAL.has(phase) || phase === "stuck")).toBe(true)
        else {
          expect(allowed).toContain(d.phaseOf(stage))
          expect(allowed).toContain("paused")
          expect(allowed.some(phase => TERMINAL.has(phase))).toBe(false)
        }
      }
    }
  })

  test("deep-interview and ralplan follow the S7.2 stage tables exactly", () => {
    const di = REGISTRY["deep-interview"]
    expect(Object.fromEntries(di.stages.map(stage => [stage, di.phaseOf(stage)]))).toEqual({
      intake: "planning", topology: "planning", question: "planning", answer: "planning", scoring: "planning",
      panel: "reviewing", closure: "reviewing", restate: "planning", crystallize: "planning", terminal: "done",
    })
    const rp = REGISTRY.ralplan
    expect(Object.fromEntries(rp.stages.map(stage => [stage, rp.phaseOf(stage)]))).toEqual({
      planner: "planning", revision: "planning", architect: "reviewing", critic: "reviewing",
      consensus_emit: "planning", pending_execution: "pending_approval", terminal: "done",
    })
    // A deep-interview is never awaiting approval or executing; ralplan never executes.
    for (const stage of di.stages) {
      expect(di.allowedPhases(stage)).not.toContain("pending_approval")
      expect(di.allowedPhases(stage)).not.toContain("executing")
    }
    for (const stage of rp.stages) expect(rp.allowedPhases(stage)).not.toContain("executing")
    expect(rp.allowedPhases("pending_execution")).toContain("pending_approval")
    expect(rp.allowedPhases("terminal")).toContain("stuck")
    expect(di.allowedPhases("terminal")).not.toContain("stuck")
  })

  test("strict parseKind rejects a phase the stage does not allow and a pausedFrom that is not the live stage", () => {
    const base = { ...plan(), kind: "deep-interview", stage: "question", phase: "planning", data: {} } as Record<string, unknown>
    delete base.entry; delete base.request; delete base.counters
    expect(parseEnvelope(base)).toBeTruthy()
    for (const bad of [{ phase: "pending_approval" }, { phase: "executing" }, { phase: "done" }, { stage: "terminal", phase: "planning" }, { stage: "terminal", phase: "stuck" }]) parseRejects({ ...base, ...bad })
    expect(parseEnvelope({ ...base, phase: "stuck" })).toBeTruthy()
    expect(parseEnvelope({ ...base, phase: "paused", pausedFrom: { phase: "planning", stage: "question" } })).toBeTruthy()
    parseRejects({ ...base, phase: "paused", pausedFrom: { phase: "reviewing", stage: "question" } })
    parseRejects({ ...base, data: "x" })
    parseRejects({ ...base, kind: "ralplan", stage: "question" })
    const rp = { ...base, kind: "ralplan", stage: "pending_execution", phase: "pending_approval" }
    expect(parseEnvelope(rp)).toBeTruthy()
    parseRejects({ ...rp, phase: "executing" })
    expect(parseEnvelope({ ...rp, stage: "terminal", phase: "stuck" })).toBeTruthy()
  })

  test("lineage is strictly parsed", () => {
    const base = { ...plan(), kind: "ralplan", stage: "planner", phase: "planning", data: {} } as Record<string, unknown>
    delete base.entry; delete base.request; delete base.counters
    const lineage = { predecessor: { id: "wf_a", kind: "deep-interview", revision: 3, artifact: { path: "spec.md", sha256: "a".repeat(64) } } }
    expect(parseEnvelope({ ...base, lineage })).toBeTruthy()
    parseRejects({ ...base, lineage: { ...lineage, extra: 1 } })
    parseRejects({ ...base, lineage: { predecessor: { ...lineage.predecessor, artifact: { path: "spec.md", sha256: "bad" } } } })
    parseRejects({ ...base, lineage: { predecessor: { ...lineage.predecessor, kind: "nope" } } })
  })

  test("the machine refuses every ordinary event in paused; cancel is now allowed from paused (intended P5b change)", () => {
    const core: FlowCore = { phase: "paused", counters: { code_invalid: 0, review_iterations: 0, user_rejections: 0, nudges: 0 } }
    expect("error" in transition(core, "cancel", { active: false })).toBe(false)
    for (const event of ["submit_valid", "approve", "reject", "cancel_settled", "user_message", "settle_ok"] as const) {
      const result = transition(core, event, { tasks: { open: 0, failedOrCancelled: 0, total: 1 } })
      expect("error" in result).toBe(true)
      if ("error" in result) expect(result.error).toContain("paused")
    }
  })

  test("a paused workflow occupies only its own session slot", () => {
    const deps = makeDeps(fakeClient(), wt.worktree)
    const owner = admitFixtureSession(deps, "ses_state")
    stores.push(owner)
    const other = admitFixtureSession(deps, "ses_other")
    stores.push(other)
    const started = startWorkflow(deps, "ses_state", "command", "first", "user_command", "opencode")
    if (!started.ok) throw new Error(started.text)
    const paused = rewriteCommitted(wt.worktree, { phase: "paused", stage: REGISTRY.plan.stageOf("paused", started.wf.stage) }, "ses_state")
    expect(activeWorkflow(wt.worktree, "ses_state")).toMatchObject({ id: paused.id, phase: "paused" })
    const before = readFileSync(workflowPath(wt.worktree, "ses_state"))
    expect(startWorkflow(deps, "ses_state", "command", "second", "user_command", "opencode").ok).toBe(false)
    expect(startWorkflow(deps, "ses_other", "command", "second", "user_command", "opencode").ok).toBe(true)
    expect(readFileSync(workflowPath(wt.worktree, "ses_state")).equals(before)).toBe(true)
    expect(activeWorkflow(wt.worktree, "ses_state")?.id).toBe(started.wf.id)
  })
})

describe("kind registry", () => {
  test("every kind has an engine; the non-plan kinds have a documented start path", () => {
    expect(startRefusal("plan")).toBeUndefined()
    for (const kind of WORKFLOW_KINDS) {
      if (kind === "plan") continue
      if (kind === "deep-interview" || kind === "ralplan" || kind === "ultragoal" || kind === "autoresearch") {
        expect(startRefusal(kind)).toBeUndefined()
        continue
      }
    }
  })

  test("narrowPlan throws on a non-plan or ill-formed record and returns a plan unchanged", () => {
    const wf = plan()
    expect(narrowPlan(wf)).toBe(wf)
    const other = parseEnvelope({ ...wf, kind: "ralplan", stage: "planner", data: {} }) as WorkflowEnvelope
    expect(isPlanWorkflow(other)).toBe(false)
    expect(() => narrowPlan(other)).toThrow("plan workflow required, got ralplan")
    expect(() => narrowPlan(null)).toThrow("plan workflow required")
    expect(() => narrowPlan({ ...wf, stage: "evidence" } as never)).toThrow("ill-formed plan workflow")
  })
})

describe("stop intent", () => {
  test("isCancelPending mirrors a cancel stopIntent and status JSON keeps the derived pendingCancel", () => {
    const deps = makeDeps(fakeClient(), wt.worktree)
    const store = admitFixtureSession(deps, "ses_state")
    stores.push(store)
    const started = startWorkflow(deps, "ses_state", "command", "x", "user_command", "opencode")
    if (!started.ok) throw new Error(started.text)
    expect(isCancelPending(started.wf)).toBe(false)
    expect(statusJson(deps, "ses_state").workflow?.pendingCancel).toBe(false)

    const intent = { kind: "cancel" as const, token: "tok", requestedFrom: { phase: "planning" as const, stage: "draft" as const }, checkpoint: null, reason: "r" }
    const cancelling = rewriteCommitted(wt.worktree, { stopIntent: intent })
    expect(isCancelPending(cancelling)).toBe(true)
    expect(statusJson(deps, "ses_state").workflow?.pendingCancel).toBe(true)
    expect(committedSnapshot(wt.worktree).stopIntent).toEqual(intent)

    const paused = rewriteCommitted(wt.worktree, { stopIntent: { ...intent, kind: "pause" } })
    expect(isCancelPending(paused)).toBe(false)
    expect(statusJson(deps, "ses_state").workflow?.pendingCancel).toBe(false)
  })

  test("the machine's cancel with a running queue records a cancel stopIntent bound to the requesting phase and stage", () => {
    const deps = makeDeps(fakeClient(), wt.worktree)
    const store = admitFixtureSession(deps, "ses_state")
    stores.push(store)
    const started = startWorkflow(deps, "ses_state", "command", "x", "user_command", "opencode")
    if (!started.ok) throw new Error(started.text)
    const executing = rewriteCommitted(wt.worktree, { phase: "executing", stage: "unit" })
    let aborts = 0
    const releaseActivity = beginExecutionActivity(getOpenCodeRuntime(deps), "ses_state", "stage", { workflowID: executing.id, abort: () => { aborts++ } })!
    const cancelled = requestCancel(deps, executing).result
    releaseActivity()
    expect(cancelled.ok).toBe(true)
    expect(aborts).toBe(1)
    const snapshot = committedSnapshot(wt.worktree)
    expect(snapshot.phase).toBe("executing")
    expect(snapshot.stopIntent).toMatchObject({ kind: "cancel", requestedFrom: { phase: "executing", stage: "unit" }, checkpoint: expect.stringMatching(/-request\.json#[a-f0-9]{64}$/) })
    expect(typeof snapshot.stopIntent?.token).toBe("string")
    expect(isCancelPending(snapshot)).toBe(true)
  })
})
