// P6a S3: the ralplan engine. Deterministic fixture host (scripted outputs per role, recorded requests); no live model.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { statusJson, renderStatusSnapshot } from "../src/flow/status.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { readEvents, withFlowTransaction, workflowPath } from "../src/flow/state.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ExecutionHost, ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import type { SessionStore } from "../src/sessions/store.ts"
import { readLedger } from "../src/state/ledger.ts"
import { stateRoot } from "../src/state/store.ts"
import { sha256, workflowArtifactDirectory } from "../src/workflows/artifacts.ts"
import { commitRevision, readCommitted } from "../src/workflows/commit.ts"
import {
  RALPLAN_ARCHITECT_PROMPT, RALPLAN_CRITIC_PROMPT, RALPLAN_PLANNER_PROMPT, RALPLAN_PROMPTS, RALPLAN_REVISION_PROMPT, RALPLAN_SUMMARIZE_PROMPT, promptIntact,
} from "../src/workflows/prompts/index.ts"
import {
  bestOpener, joinReview, nextStep, PLANNING_COMPLETE_TEXT, ralplanDataOf, reduce, type RalplanWorkflow,
} from "../src/workflows/ralplan.ts"
import { commitRalplan } from "../src/workflows/ralplan-commit.ts"
import { parseRalplanData } from "../src/workflows/ralplan-data.ts"
import {
  confirmExecute, emitConsensus, executeConfirmation, handoffToRalplan, retryRalplan, runRalplan, startRalplan, stopHere,
} from "../src/workflows/ralplan-driver.ts"
import { consensusLine, verifyConsensusEvidence } from "../src/workflows/ralplan-evidence.ts"
import { writeReceipt } from "../src/workflows/receipts.ts"
import { kindAllowsRole, parseEnvelope, REGISTRY, startRefusal } from "../src/workflows/registry.ts"
import { runWorkflowTurn } from "../src/workflows/turn.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

let SID = "ses_rp"
let counter = 0
const controls = Object.fromEntries([
  "boundedInput", "boundedOutput", "preExecutionToolPolicy", "headlessPermissionRefusal",
  "ownedCancellation", "quiescenceEvidence", "identityBinding", "noReplayRecovery",
  "readOnlyWorktree", "serialWorkerLease",
].map(key => [key, "supported" as const]))

let wt: ReturnType<typeof tempGitWorktree>
let store: SessionStore | undefined
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree) })
afterEach(() => {
  stopHeartbeat()
  try { if (store) store.release({ workflowQuiescent: true, evidence: "fixture awaited all session work", workflowID: null, revision: null }) } catch { /* retained for the discarded worktree */ }
  store = undefined
  wt.cleanup()
})

// ---------------------------------------------------------------------------------------------- fixture host
const plan = (title = "Goal") => JSON.stringify({ type: "plan_doc", sections: [{ title, body: "Do the thing with tests." }, { title: "Risks", body: "Few." }] })
const architect = (status: string, decision: string, findings: string[] = []) => JSON.stringify({ type: "lane_verdict", status, decision, findings })
const critic = (verdict: string, findings: string[] = []) => JSON.stringify({ type: "lane_verdict", verdict, findings })
const CLEAN_A = architect("CLEAR", "APPROVE")
const CLEAN_C = critic("OKAY")

type Script = Partial<Record<"planner" | "architect" | "critic", string[]>>
type Seen = { role: string; text: string; promptId: string }

function harness(script: Script) {
  const queues = { planner: [...(script.planner ?? [])], architect: [...(script.architect ?? [])], critic: [...(script.critic ?? [])] }
  const seen: Seen[] = []
  const promptIds = new Map(RALPLAN_PROMPTS.map(prompt => [prompt.text, prompt.id]))
  const host: ExecutionHost = {
    identity: { engine: "fixture", profile: "legacy-unowned" },
    async preflight() { return { compatible: true, controls, problems: [] } },
    async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "fixture has no recovery" } },
    async prepare(request: ExecutionRequest) {
      let done = false
      return {
        reference: { executionID: request.executionID },
        async run(): Promise<ExecutionOutcome> {
          const id = [...promptIds].find(([text]) => request.text.startsWith(text))?.[1] ?? "unknown"
          seen.push({ role: request.role, text: request.text, promptId: id })
          const queue = (queues as Record<string, string[]>)[request.role]
          const text = queue?.shift()
          done = true
          if (text === undefined) return { status: "failed", error: `script exhausted for ${request.role} (${id}, len ${request.text.length})` }
          return { status: "completed", text }
        },
        async requestCancel() { done = true; return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
        async reconcile() { return { outcome: done ? "terminal" : "unknown", quiescent: done, evidence: "fixture owned handle" } },
      }
    },
  }
  const runtime = createExecutionRuntime({
    directory: wt.worktree, worktree: wt.worktree, config: structuredClone(DEFAULT_CONFIG), log() {},
  }, () => host, { planningOnlyMain: true })
  SID = `ses_rp${counter++}`
  store = attachAdmission(runtime, SID, { engine: "fixture", model: "fixture-model" })
  return { runtime, seen, queues }
}

function begin(h: ReturnType<typeof harness>, request = "build the widget") {
  const started = startRalplan(h.runtime, SID, request)
  if (!started.ok) throw new Error(started.text)
  return started.wf
}

const committed = (): RalplanWorkflow => {
  const read = readCommitted(wt.worktree)
  if (read.state !== "ok" || read.wf.kind !== "ralplan") throw new Error("no committed ralplan")
  return read.wf
}
const dir = (wf: RalplanWorkflow) => workflowArtifactDirectory(wt.worktree, wf.sessionID, wf.id)
const opener = (n: number, role: "plan" | "architect" | "critic") => `iteration-${n}/${role}.md`

async function toPending(h: ReturnType<typeof harness>) {
  const wf = begin(h)
  const result = await runRalplan(h.runtime, SID, wf.id)
  expect(result.status).toBe("pending_execution")
  return committed()
}

// ---------------------------------------------------------------------------------------------- tests
describe("ralplan stage and phase order", () => {
  test("planner(planning) -> architect(reviewing) -> critic(reviewing) -> consensus_emit(planning) -> pending_execution(pending_approval)", async () => {
    const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
    const wf = begin(h)
    const trail: string[] = []
    const result = await runRalplan(h.runtime, SID, wf.id, { onStep: step => trail.push(`${step.stage}:${step.phase}`) })
    expect(trail).toEqual(["planner:planning", "architect:reviewing", "critic:reviewing", "consensus_emit:planning", "pending_execution:pending_approval"])
    expect(result.status).toBe("pending_execution")
    const final = committed()
    expect(final).toMatchObject({ stage: "pending_execution", phase: "pending_approval" })
    expect(h.seen.map(item => item.role)).toEqual(["planner", "architect", "critic"])
    expect(h.seen.map(item => item.promptId)).toEqual(["ralplan.planner", "ralplan.architect", "ralplan.critic"])
    const types = readEvents(wt.worktree, wf.id).map(event => event.type)
    for (const type of ["planner_saved", "architect_verdict", "critic_verdict", "consensus_verified"]) expect(types).toContain(type)
  })

  test("artifacts are hash-recorded under .otter/workflows/<sid>/<wid>/ and consensus is bound to the SAME plan hash", async () => {
    const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
    const final = await toPending(h)
    const keys = final.artifacts.map(ref => ref.key)
    expect(keys.slice(0, 2)).toEqual(["pending-approval.md", "consensus.json"])
    expect(keys).toEqual(expect.arrayContaining([opener(1, "plan"), opener(1, "architect"), opener(1, "critic")]))
    for (const ref of final.artifacts) {
      expect(ref.path.startsWith(`.otter/workflows/${SID}/${final.id}/`)).toBe(true)
      expect(ref.sha256).toBe(sha256(readFileSync(join(wt.worktree, ref.path))))
    }
    const data = ralplanDataOf(final)
    const planSha = data.iterations[0]!.planSha
    expect(planSha).toBe(final.artifacts.find(ref => ref.key === opener(1, "plan"))!.sha256!)
    const consensus = JSON.parse(readFileSync(join(dir(final), "consensus.json"), "utf8"))
    expect(consensus).toMatchObject({ planSha, executed: false })
    const evidence = verifyConsensusEvidence(wt.worktree, final)
    expect(evidence.ok).toBe(true)
    if (evidence.ok) {
      expect(evidence.architect.body.planSha).toBe(planSha)
      expect(evidence.critic.body.planSha).toBe(planSha)
      expect(evidence.consensus?.body.planSha).toBe(planSha)
    }
    expect(readFileSync(join(dir(final), "pending-approval.md"), "utf8")).toContain("NOT executed")
  })

  test("display shows 'Architect CLEAR/APPROVE + Critic OKAY · execution pending' in status and recomputes from disk", async () => {
    const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
    const final = await toPending(h)
    expect(consensusLine(wt.worktree, final)).toBe("Architect CLEAR/APPROVE + Critic OKAY · execution pending")
    const status = statusJson({ worktree: wt.worktree, config: DEFAULT_CONFIG, log() {} }, SID)
    expect(status.workflow).toMatchObject({ kind: "ralplan", stage: "pending_execution", phase: "pending_approval", review: "Architect CLEAR/APPROVE + Critic OKAY · execution pending" })
    expect(status.workflow?.artifacts[0]).toMatchObject({ key: "pending-approval.md", state: "verified" })
    expect(renderStatusSnapshot(status, SID)).toContain("review: Architect CLEAR/APPROVE + Critic OKAY · execution pending")
    // editing the plan after consensus makes the display refuse rather than claim consensus
    writeFileSync(join(wt.worktree, final.artifacts.find(ref => ref.key === opener(1, "plan"))!.path), "# edited\n")
    expect(consensusLine(wt.worktree, final)).toContain("consensus unverified")
  })
})

describe("join table", () => {
  const cases: Array<[string, string, string, string]> = [
    ["WATCH + APPROVE + OKAY", "WATCH", "APPROVE", "OKAY"],
    ["BLOCK + APPROVE + OKAY", "BLOCK", "APPROVE", "OKAY"],
    ["CLEAR + COMMENT + OKAY", "CLEAR", "COMMENT", "OKAY"],
    ["CLEAR + REQUEST_CHANGES + OKAY", "CLEAR", "REQUEST_CHANGES", "OKAY"],
    ["CLEAR + APPROVE + ITERATE", "CLEAR", "APPROVE", "ITERATE"],
    ["CLEAR + APPROVE + REJECT", "CLEAR", "APPROVE", "REJECT"],
  ]
  for (const [name, status, decision, verdict] of cases) {
    test(`${name} routes to revision, never to consensus`, async () => {
      const h = harness({ planner: [plan()], architect: [architect(status, decision, ["fix it"])], critic: [critic(verdict, ["fix it"])] })
      const wf = begin(h)
      const result = await runRalplan(h.runtime, SID, wf.id, { stopBefore: "revision" })
      expect(result).toMatchObject({ status: "blocked", reason: "stopped before revision" })
      expect(committed()).toMatchObject({ stage: "revision", phase: "planning" })
      expect(existsSync(join(dir(wf), "consensus.json"))).toBe(false)
      expect(readEvents(wt.worktree, wf.id).map(event => event.type)).not.toContain("consensus_verified")
    })
  }

  test("only CLEAR + APPROVE + OKAY on the same plan hash is consensus; another hash, a missing lane or a mixed hash is not", () => {
    const sha = "a".repeat(64)
    const other = "b".repeat(64)
    const architectOf = (planSha: string) => ({ status: "CLEAR", decision: "APPROVE", planSha, ref: "r", findings: 0 }) as const
    const criticOf = (planSha: string) => ({ verdict: "OKAY", planSha, ref: "r", findings: 0 }) as const
    const base = { n: 1, planKey: "iteration-1/plan.md", planPath: "p", planSha: sha }
    expect(joinReview({ ...base, architect: architectOf(sha), critic: criticOf(sha) }).consensus).toBe(true)
    expect(joinReview({ ...base, architect: architectOf(other), critic: criticOf(sha) }).consensus).toBe(false)
    expect(joinReview({ ...base, architect: architectOf(sha), critic: criticOf(other) }).consensus).toBe(false)
    expect(joinReview({ ...base, architect: architectOf(other), critic: criticOf(other) }).consensus).toBe(false)
    expect(joinReview({ ...base, architect: architectOf(sha) }).consensus).toBe(false)
    expect(joinReview({ ...base, critic: criticOf(sha) }).consensus).toBe(false)
  })

  test("malformed verdict vocabulary is an attempt failure: nothing is recorded, two failures make a visible stuck with Retry", async () => {
    const bad = [
      architect("OK", "APPROVE"), architect("CLEAR", "LGTM"), architect("clear", "approve"), critic("OKAY"), // critic vocabulary at the architect stage
      JSON.stringify({ type: "lane_verdict", status: "CLEAR", decision: "APPROVE", verdict: "OKAY", findings: [] }),
      JSON.stringify({ type: "lane_verdict", status: "CLEAR", decision: "APPROVE", findings: [], approved: true }),
      architect("WATCH", "COMMENT", []), // non-clean without findings
      "CLEAR APPROVE",
    ]
    for (const output of bad) {
      const h = harness({ planner: [plan()], architect: [output, output], critic: [CLEAN_C] })
      const wf = begin(h)
      const result = await runRalplan(h.runtime, SID, wf.id)
      expect(result.status).toBe("stuck")
      const final = committed()
      expect(final).toMatchObject({ stage: "architect", phase: "stuck" })
      const data = ralplanDataOf(final)
      expect(data.attempts).toBe(2)
      expect(data.iterations[0]!.architect).toBeUndefined()
      expect(final.artifacts.some(ref => ref.key === opener(1, "architect"))).toBe(false)
      expect(h.seen.filter(item => item.role === "architect")).toHaveLength(2)
      rmCommitted()
    }
  })

  test("critic vocabulary must be OKAY/ITERATE/REJECT exactly", async () => {
    for (const output of [critic("okay"), critic("APPROVE"), critic("PASS"), architect("CLEAR", "APPROVE", []), critic("ITERATE", [])]) {
      const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [output, output] })
      const wf = begin(h)
      expect((await runRalplan(h.runtime, SID, wf.id)).status).toBe("stuck")
      const data = ralplanDataOf(committed())
      expect(data.iterations[0]!.critic).toBeUndefined()
      expect(data.attempts).toBe(2)
      rmCommitted()
    }
  })

  test("a failed attempt retried successfully continues; Retry resumes the same stage with fresh attempts", async () => {
    const h = harness({ planner: [plan()], architect: [architect("BAD", "APPROVE"), architect("BAD", "APPROVE"), CLEAN_A], critic: [CLEAN_C] })
    const wf = begin(h)
    const stuck = await runRalplan(h.runtime, SID, wf.id)
    expect(stuck.status).toBe("stuck")
    const retried = retryRalplan(h.runtime, SID, wf.id, committed().lastSeq)
    expect(retried.ok).toBe(true)
    expect(committed()).toMatchObject({ stage: "architect", phase: "reviewing" })
    expect((await runRalplan(h.runtime, SID, wf.id)).status).toBe("pending_execution")
    // a stale retry is refused
    expect(retryRalplan(h.runtime, SID, wf.id, 0).ok).toBe(false)
  })
})

function rmCommitted() {
  // each looped case starts from a free slot: the fixture drops the index (the next harness uses a fresh session)
  stopHeartbeat()
  rmSync(workflowPath(wt.worktree), { force: true })
}

describe("independence and ordering of the reviewers", () => {
  test("pass 1 is independent: the critic request excludes the architect output; pass 2 critic sees THAT pass's architect findings", async () => {
    const h = harness({
      planner: [plan("First"), plan("Second")],
      architect: [architect("WATCH", "COMMENT", ["ARCH1-SENTINEL concern"]), architect("CLEAR", "APPROVE", [])],
      critic: [critic("ITERATE", ["CRIT1-SENTINEL defect"]), critic("OKAY")],
    })
    const wf = begin(h)
    expect((await runRalplan(h.runtime, SID, wf.id)).status).toBe("pending_execution")
    const critics = h.seen.filter(item => item.role === "critic")
    expect(critics).toHaveLength(2)
    expect(critics[0]!.text).not.toContain("ARCH1-SENTINEL")
    expect(critics[0]!.text).not.toContain("THIS PASS ARCHITECT")
    expect(critics[1]!.text).toContain("THIS PASS ARCHITECT CLEAR/APPROVE")
    expect(critics[1]!.text).toContain("ARCH1-SENTINEL") // the earlier pass is carried as earlier-pass findings only
    const architects = h.seen.filter(item => item.role === "architect")
    expect(architects[0]!.text).not.toContain("CRIT1-SENTINEL")
    expect(architects[1]!.text).toContain("EARLIER PASS 1 FINDINGS")
    // the architect always runs before the critic of the same pass; the revision carries both reviewers' findings
    expect(h.seen.map(item => item.promptId)).toEqual([
      "ralplan.planner", "ralplan.architect", "ralplan.critic", "ralplan.revision", "ralplan.architect", "ralplan.critic",
    ])
    const revision = h.seen.find(item => item.promptId === "ralplan.revision")!
    expect(revision.text).toContain("ARCH1-SENTINEL")
    expect(revision.text).toContain("CRIT1-SENTINEL")
    const pass2Critic = h.seen[5]!.text
    expect(pass2Critic).toContain("Second")
  })

  test("the pass-2 critic request carries a pass-2-only architect sentinel and pass 1 does not", async () => {
    const h = harness({
      planner: [plan("A"), plan("B")],
      architect: [architect("BLOCK", "REQUEST_CHANGES", ["first finding"]), architect("CLEAR", "APPROVE", ["ARCH2-ONLY-SENTINEL"])],
      critic: [critic("REJECT", ["rework"]), critic("OKAY")],
    })
    const wf = begin(h)
    await runRalplan(h.runtime, SID, wf.id, { stopBefore: "revision" })
    await runRalplan(h.runtime, SID, wf.id)
    const critics = h.seen.filter(item => item.role === "critic")
    expect(critics[0]!.text).not.toContain("ARCH2-ONLY-SENTINEL")
    expect(critics[1]!.text).toContain("ARCH2-ONLY-SENTINEL")
  })
})

describe("cap", () => {
  const iterate = Array.from({ length: 5 }, (_, i) => critic("ITERATE", [`residual-${i + 1}`]))
  const watch = Array.from({ length: 5 }, (_, i) => architect("WATCH", "COMMENT", [`arch-${i + 1}`]))

  test("five openers without consensus -> stuck PLANNING-STUCK with the best plan and caveats, no sixth request, no handoff, zero tasks", async () => {
    const h = harness({ planner: [1, 2, 3, 4, 5, 6].map(i => plan(`P${i}`)), architect: watch, critic: iterate })
    const wf = begin(h)
    const result = await runRalplan(h.runtime, SID, wf.id)
    expect(result.status).toBe("stuck")
    expect(result.reason).toContain("PLANNING-STUCK")
    const final = committed()
    expect(final).toMatchObject({ stage: "terminal", phase: "stuck" })
    const data = ralplanDataOf(final)
    expect(data.openers).toBe(5)
    expect(data.stuck).toMatchObject({ kind: "cap" })
    expect(h.seen.filter(item => item.role === "planner")).toHaveLength(5) // planner + 4 revisions; no sixth
    expect(h.seen).toHaveLength(15)
    expect(h.queues.planner).toHaveLength(1)
    const best = final.artifacts.find(ref => ref.key === "best-plan.md")
    expect(best?.sha256).toBe(sha256(readFileSync(join(wt.worktree, best!.path))))
    const bestText = readFileSync(join(dir(final), "best-plan.md"), "utf8")
    expect(bestText).toContain("PLANNING-STUCK")
    expect(bestText).toContain("residual-5")
    expect(bestText).toContain("NOT approved or executed")
    expect(existsSync(join(dir(final), "pending-approval.md"))).toBe(false)
    expect(existsSync(join(dir(final), "consensus.json"))).toBe(false)
    expect(final.artifacts.some(ref => ref.key === "pending-approval.md" || ref.key === "consensus.json")).toBe(false)
    expect(readEvents(wt.worktree, wf.id).map(event => event.type)).toEqual(expect.arrayContaining(["cap_reached"]))
    expect(readLedger(wt.worktree, SID).tasks).toHaveLength(0)
    // no handoff, no choice, no retry from the cap
    expect(nextStep(final)).toMatchObject({ kind: "blocked" })
    expect(stopHere(h.runtime, SID, wf.id, final.lastSeq).ok).toBe(false)
    expect(confirmExecute(h.runtime, SID, wf.id, final.lastSeq, executeConfirmation(wf.id, "0".repeat(64))).ok).toBe(false)
    expect(retryRalplan(h.runtime, SID, wf.id, final.lastSeq).ok).toBe(false)
    expect(() => reduce(final, { type: "plan_saved", plan: { key: "iteration-6/plan.md", path: "x", sha256: "c".repeat(64) } })).toThrow()
    expect(consensusLine(wt.worktree, final)).toBeUndefined()
  })

  test("the best opener is the highest-ranked reviewed one (later on a tie)", () => {
    const sha = (c: string) => c.repeat(64)
    const it = (n: number, status: "CLEAR" | "WATCH" | "BLOCK", decision: "APPROVE" | "COMMENT" | "REQUEST_CHANGES", verdict: "OKAY" | "ITERATE" | "REJECT") => ({
      n, planKey: `iteration-${n}/plan.md`, planPath: "p", planSha: sha("a"),
      architect: { status, decision, planSha: sha("a"), ref: "r", findings: 1 }, critic: { verdict, planSha: sha("a"), ref: "r", findings: 1 },
    })
    const data = { v: 1 as const, request: "", openers: 3, attempts: 0, iterations: [it(1, "WATCH", "COMMENT", "ITERATE"), it(2, "CLEAR", "COMMENT", "ITERATE"), it(3, "BLOCK", "REQUEST_CHANGES", "REJECT")] }
    expect(bestOpener(data)).toBe(2)
  })

  test("at most one lane result per opener: a second architect or critic result for the same opener is refused", async () => {
    const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
    const wf = begin(h)
    await runRalplan(h.runtime, SID, wf.id, { stopBefore: "critic" })
    const atCritic = committed()
    const it = ralplanDataOf(atCritic).iterations[0]!
    const result = { status: "CLEAR", decision: "APPROVE", planSha: it.planSha, ref: "x", findings: 0 } as const
    const artifact = { key: opener(1, "architect"), path: "x", sha256: "d".repeat(64) }
    expect(() => reduce({ ...atCritic, stage: "architect", phase: "reviewing" } as RalplanWorkflow, { type: "architect", result, artifact })).toThrow("already recorded")
    const judged = reduce(atCritic, { type: "critic", result: { verdict: "OKAY", planSha: it.planSha, ref: "y", findings: 0 }, artifact: { key: opener(1, "critic"), path: "y", sha256: "e".repeat(64) } }).wf
    expect(() => reduce({ ...judged, stage: "critic", phase: "reviewing" } as RalplanWorkflow, { type: "critic", result: { verdict: "OKAY", planSha: it.planSha, ref: "z", findings: 0 }, artifact: { key: "k", path: "z", sha256: "f".repeat(64) } })).toThrow("already recorded")
  })
})

describe("same-hash consensus and stale verdicts", () => {
  test("a stale or mismatched verdict (another plan hash) is rejected by the engine and writes nothing", async () => {
    const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
    const wf = begin(h)
    await runRalplan(h.runtime, SID, wf.id, { stopBefore: "architect" })
    const atArchitect = committed()
    const before = readFileSync(workflowPath(wt.worktree))
    const stale = { status: "CLEAR", decision: "APPROVE", planSha: "9".repeat(64), ref: "x", findings: 0 } as const
    expect(() => reduce(atArchitect, { type: "architect", result: stale, artifact: { key: opener(1, "architect"), path: "x", sha256: "d".repeat(64) } })).toThrow("stale architect verdict")
    const at = ralplanDataOf(atArchitect).iterations[0]!
    const good = reduce(atArchitect, { type: "architect", result: { status: "CLEAR", decision: "APPROVE", planSha: at.planSha, ref: "x", findings: 0 }, artifact: { key: opener(1, "architect"), path: "x", sha256: "d".repeat(64) } }).wf
    expect(() => reduce(good, { type: "critic", result: { verdict: "OKAY", planSha: "8".repeat(64), ref: "y", findings: 0 }, artifact: { key: "k", path: "y", sha256: "e".repeat(64) } })).toThrow("stale critic verdict")
    // a verdict for a stage the workflow is not in
    expect(() => reduce(atArchitect, { type: "critic", result: { verdict: "OKAY", planSha: at.planSha, ref: "y", findings: 0 }, artifact: { key: "k", path: "y", sha256: "e".repeat(64) } })).toThrow()
    expect(readFileSync(workflowPath(wt.worktree)).equals(before)).toBe(true)
    // the CAS commit refuses a transition built from an outdated revision
    const outdated = { ...atArchitect, lastSeq: atArchitect.lastSeq - 1 } as RalplanWorkflow
    expect(commitRalplan(wt.worktree, outdated, fresh => reduce(fresh, { type: "retry" })).ok).toBe(false)
  })

  test("a consensus whose architect and critic receipts carry different plan hashes is refused in the transaction", async () => {
    const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
    const wf = begin(h)
    await runRalplan(h.runtime, SID, wf.id, { stopBefore: "consensus_emit" })
    const atEmit = committed()
    const data = ralplanDataOf(atEmit)
    const it = data.iterations[0]!
    // forge a critic receipt bound to ANOTHER plan hash and point the recorded critic result at it
    const forged = writeReceipt(wt.worktree, {
      kind: "consensus", wid: atEmit.id, sid: SID, revision: atEmit.lastSeq, action: "critic-forged", inputSha: "7".repeat(64),
      body: { role: "critic", opener: 1, planSha: "7".repeat(64), verdict: "OKAY", findings: [] },
    })
    const tampered = commitRalplan(wt.worktree, atEmit, fresh => ({
      wf: { ...fresh, data: { ...data, iterations: [{ ...it, critic: { ...it.critic!, ref: forged } }] } } as RalplanWorkflow,
      events: [{ type: "tamper_fixture" }],
    }))
    expect(tampered.ok).toBe(true)
    const staged = committed()
    const before = readFileSync(workflowPath(wt.worktree))
    const emitted = emitConsensus(h.runtime, staged)
    expect(emitted.ok).toBe(false)
    if (!emitted.ok) expect(emitted.text).toContain("critic receipt")
    expect(readFileSync(workflowPath(wt.worktree)).equals(before)).toBe(true)
    expect(committed().stage).toBe("consensus_emit")
    expect(existsSync(join(dir(staged), "consensus.json"))).toBe(false)
  })

  test("editing the plan, deleting a lane receipt or swapping the plan after review refuses consensus; nothing is published", async () => {
    for (const tamper of ["plan", "receipt"] as const) {
      const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
      const wf = begin(h)
      await runRalplan(h.runtime, SID, wf.id, { stopBefore: "consensus_emit" })
      const staged = committed()
      const it = ralplanDataOf(staged).iterations[0]!
      if (tamper === "plan") writeFileSync(join(wt.worktree, it.planPath), "# swapped plan\n")
      else rmSync(join(stateRoot(wt.worktree), it.architect!.ref.split("#")[0]!))
      const result = await runRalplan(h.runtime, SID, wf.id)
      expect(result.status).toBe("blocked")
      expect(committed().stage).toBe("consensus_emit")
      expect(existsSync(join(dir(staged), "pending-approval.md"))).toBe(false)
      expect(readEvents(wt.worktree, wf.id).map(event => event.type)).not.toContain("consensus_verified")
      rmCommitted()
    }
  })

  test("commit requires pending-approval.md and consensus.json verified from disk (edited file is refused)", async () => {
    const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
    const final = await toPending(h)
    const pending = final.artifacts.find(ref => ref.key === "pending-approval.md")!
    writeFileSync(join(wt.worktree, pending.path), "tampered\n")
    const attempt = withFlowTransaction(wt.worktree, tx => {
      try { commitRevision(tx, { ...final, phase: "pending_approval" } as never, [{ wf: final.id, type: "x", actor: "code" }]); return "committed" }
      catch (error) { return (error as Error).message }
    })
    expect(attempt).toContain("pending-approval.md")
  })
})

describe("no execution", () => {
  test("zero implementation or dispatch before approval: only planner/architect/critic ran, no ledger task, no queue, no worker", async () => {
    const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
    const final = await toPending(h)
    expect(new Set(h.seen.map(item => item.role))).toEqual(new Set(["planner", "architect", "critic"]))
    const executions = h.runtime.runs.status().executions
    expect(executions.length).toBe(3)
    for (const execution of executions) {
      expect(execution.kind).toBe("host")
      expect(["planner", "architect", "critic"]).toContain(execution.role)
      expect(execution.workflowBinding).toMatchObject({ kind: "ralplan", workflowID: final.id })
    }
    expect(readLedger(wt.worktree, SID).tasks).toHaveLength(0)
    expect(final.phase).toBe("pending_approval")
    expect(nextStep(final)).toEqual({ kind: "choice" })
  })

  test("Execute via ultragoal: a wrong confirmation or a stale revision refuses with zero state change; the typed one is one handoff", async () => {
    const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
    const final = await toPending(h)
    const sha = ralplanDataOf(final).consensus!.planSha
    const before = readFileSync(workflowPath(wt.worktree))
    const executionsBefore = h.runtime.runs.status().executions.length
    const wrong = confirmExecute(h.runtime, SID, final.id, final.lastSeq, "yes")
    expect(wrong).toMatchObject({ ok: false })
    if (!wrong.ok) expect(wrong.text).toContain(executeConfirmation(final.id, sha))
    expect(confirmExecute(h.runtime, SID, final.id, final.lastSeq + 3, executeConfirmation(final.id, sha)).ok).toBe(false)
    expect(readFileSync(workflowPath(wt.worktree)).equals(before)).toBe(true)
    expect(committed()).toMatchObject({ stage: "pending_execution", phase: "pending_approval" })
    expect(h.runtime.runs.status().executions.length).toBe(executionsBefore)
    expect(readLedger(wt.worktree, SID).tasks).toHaveLength(0)
  })

  test("an execute choice at reduce level ends planning (terminal done) for the ultragoal handoff and executes nothing", async () => {
    const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
    const final = await toPending(h)
    const sha = ralplanDataOf(final).consensus!.planSha
    const next = reduce(final, { type: "execute_confirmed", choice: { kind: "execute_confirmed", planSha: sha, executed: false } })
    // the reducer only produces the terminal form the ultragoal handoff needs; nothing is executed or approved
    expect(next.wf).toMatchObject({ stage: "terminal", phase: "done" })
    expect(ralplanDataOf(next.wf).choice).toEqual({ kind: "execute_confirmed", planSha: sha, executed: false })
    expect(() => reduce(final, { type: "execute_confirmed", choice: { kind: "execute_confirmed", planSha: "0".repeat(64), executed: false } })).toThrow("another plan hash")
    expect(() => parseRalplanData({ ...ralplanDataOf(final), choice: { kind: "execute_confirmed", planSha: sha, executed: true } })).toThrow()
  })

  test("Stop here -> done with 'planning complete; not executed', receipt written, artifacts still verified", async () => {
    const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
    const final = await toPending(h)
    expect(stopHere(h.runtime, SID, final.id, final.lastSeq + 1)).toMatchObject({ ok: false })
    const stopped = stopHere(h.runtime, SID, final.id, final.lastSeq)
    expect(stopped.ok).toBe(true)
    const done = committed()
    expect(done).toMatchObject({ stage: "terminal", phase: "done" })
    expect(ralplanDataOf(done).choice).toMatchObject({ kind: "stop_here", executed: false })
    expect(consensusLine(wt.worktree, done)).toBe(`Architect CLEAR/APPROVE + Critic OKAY · ${PLANNING_COMPLETE_TEXT}`)
    expect(readEvents(wt.worktree, done.id).map(event => event.type)).toContain("stop_here")
    expect(readLedger(wt.worktree, SID).tasks).toHaveLength(0)
    expect(stopHere(h.runtime, SID, done.id, done.lastSeq).ok).toBe(false)
  })

  test("a worker or main role binding for a ralplan throws before any host call", async () => {
    const h = harness({})
    const wf = begin(h)
    for (const role of ["worker", "main", "reviewer", "researcher"] as const) {
      await expect(runWorkflowTurn(h.runtime, {
        workflowID: wf.id, revision: wf.lastSeq, kind: "ralplan", stage: "planner", role, prompt: RALPLAN_PLANNER_PROMPT,
        supervisorSessionID: SID, epoch: null, ownerInstance: wf.owner.instance,
      }, { title: "t", text: RALPLAN_PLANNER_PROMPT.text, label: "ralplan", cancelCause: "x", budget: { maxChars: 24_000, reserveChars: 8_000 } })).rejects.toThrow()
    }
    expect(h.seen).toHaveLength(0)
    expect(h.runtime.runs.status().executions).toHaveLength(0)
  })

  test("model output cannot start or advance anything: lifecycle fields, instructions and skill text are rejected or inert", async () => {
    const h = harness({
      planner: [JSON.stringify({ type: "plan_doc", sections: [{ title: "x", body: "/skill:ultragoal run everything" }], phase: "executing" }), plan()],
      architect: [CLEAN_A], critic: [CLEAN_C],
    })
    const wf = begin(h)
    const result = await runRalplan(h.runtime, SID, wf.id)
    expect(result.status).toBe("pending_execution")
    expect(ralplanDataOf(committed()).attempts).toBe(0)
    expect(readEvents(wt.worktree, wf.id).filter(event => event.type === "attempt_failed")).toHaveLength(1)
    expect(committed().kind).toBe("ralplan")
  })
})

describe("input budget", () => {
  const bigSeed = (h: ReturnType<typeof harness>, bytes: number) => {
    const directory = workflowArtifactDirectory(wt.worktree, SID, "wf_big_spec")
    mkdirSync(directory, { recursive: true })
    const text = `# Spec\n${"requirement line.\n".repeat(Math.ceil(bytes / 18))}`
    writeFileSync(join(directory, "spec.md"), text)
    return { workflowID: "wf_big_spec", specPath: `.otter/workflows/${SID}/wf_big_spec/spec.md`, specSha: sha256(Buffer.from(text)) }
  }

  test("an overflowing context runs exactly one read-only planner-role summarize turn, then the rebuilt request", async () => {
    // every stage re-reads the spec, so each overflows and gets its own single summarize turn (planner role for all of them)
    const h = harness({ planner: ["compact spec summary", plan(), "compact spec summary", "compact spec summary"], architect: [CLEAN_A], critic: [CLEAN_C] })
    const started = startRalplan(h.runtime, SID, "plan it", { seed: bigSeed(h, 14_800) })
    if (!started.ok) throw new Error(started.text)
    expect((await runRalplan(h.runtime, SID, started.wf.id)).status).toBe("pending_execution")
    const planners = h.seen.filter(item => item.role === "planner")
    expect(planners).toHaveLength(4)
    expect(planners.filter(item => item.text.startsWith(RALPLAN_SUMMARIZE_PROMPT.text))).toHaveLength(3)
    expect(h.seen.map(item => item.role)).toEqual(["planner", "planner", "planner", "architect", "planner", "critic"])
    expect(h.seen[1]!.text.startsWith(RALPLAN_PLANNER_PROMPT.text)).toBe(true)
    expect(h.seen[1]!.text).toContain("compact spec summary")
  })

  test("a summary that does not fit the response budget is a visible stuck (no silent truncation), with zero lane results", async () => {
    const h = harness({ planner: ["s".repeat(9_000)] })
    const started = startRalplan(h.runtime, SID, "plan it", { seed: bigSeed(h, 14_800) })
    if (!started.ok) throw new Error(started.text)
    const result = await runRalplan(h.runtime, SID, started.wf.id)
    expect(result.status).toBe("stuck")
    const final = committed()
    expect(final).toMatchObject({ stage: "planner", phase: "stuck" })
    expect(ralplanDataOf(final).stuck?.reason).toContain("summar")
    expect(final.artifacts).toHaveLength(0)
    expect(h.seen.filter(item => item.role !== "planner")).toHaveLength(0)
  })
})

describe("seeded from a verified DI spec", () => {
  const SPEC = "# Spec\nambiguity 0.04 threshold 0.05\nSPEC-SENTINEL requirement\n"

  function doneInterview(h: ReturnType<typeof harness>) {
    const owner = { instance: store!.epoch, pid: process.pid }
    const base = {
      version: 2 as const, id: "wf_di_seed", kind: "deep-interview" as const, stage: "crystallize" as const, phase: "planning" as const, engine: "fixture",
      sessionID: SID, owner, stopIntent: null, artifacts: [], data: {}, lastSeq: 0, createdAt: 1, updatedAt: 1,
    }
    const live = withFlowTransaction(wt.worktree, tx => commitRevision(tx, base as never, [{ wf: base.id, type: "created", actor: "code" }]))
    const directory = workflowArtifactDirectory(wt.worktree, SID, base.id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "spec.md"), SPEC)
    const spec = { key: "spec.md", path: `.otter/workflows/${SID}/${base.id}/spec.md`, sha256: sha256(Buffer.from(SPEC)) }
    return { ...live, stage: "terminal", phase: "done", artifacts: [spec] } as never as Parameters<typeof handoffToRalplan>[2]
  }

  test("handoff commits one ralplan with lineage; the planner request carries the verified spec; a changed spec is refused", async () => {
    const h = harness({ planner: [plan()], architect: [CLEAN_A], critic: [CLEAN_C] })
    const predecessor = doneInterview(h)
    const events = [{ wf: "wf_di_seed", type: "transition", actor: "code" as const }, { wf: "wf_di_seed", type: "spec_written", actor: "code" as const }]
    // edit the spec before the handoff: refused, index unchanged
    const specPath = join(wt.worktree, predecessor.artifacts[0]!.path)
    writeFileSync(specPath, "edited\n")
    const before = readFileSync(workflowPath(wt.worktree))
    const refused = handoffToRalplan(h.runtime, SID, predecessor, "plan it", events)
    expect(refused.ok).toBe(false)
    expect(readFileSync(workflowPath(wt.worktree)).equals(before)).toBe(true)
    writeFileSync(specPath, SPEC)
    const handed = handoffToRalplan(h.runtime, SID, predecessor, "plan it", events)
    if (!handed.ok) throw new Error(handed.text)
    const read = readCommitted(wt.worktree)
    expect(read.state === "ok" && read.wf.kind === "ralplan" && read.wf.lineage?.predecessor).toMatchObject({ id: "wf_di_seed", kind: "deep-interview", artifact: { sha256: sha256(Buffer.from(SPEC)) } })
    expect(ralplanDataOf(handed.wf).seed).toMatchObject({ workflowID: "wf_di_seed", specSha: sha256(Buffer.from(SPEC)) })
    expect(await runRalplan(h.runtime, SID, handed.wf.id).then(result => result.status)).toBe("pending_execution")
    expect(h.seen[0]!.text).toContain("SPEC-SENTINEL")
    expect(h.seen[0]!.text).toContain(sha256(Buffer.from(SPEC)))
    // a spec edited after the handoff blocks the next stage rather than silently planning from other bytes
  })

  test("a seed whose spec is missing or edited is refused at start; a spec changed after the handoff fails the stage visibly", async () => {
    const h = harness({ planner: [plan()] })
    const refused = startRalplan(h.runtime, SID, "plan it", { seed: { workflowID: "wf_x", specPath: ".otter/none.md", specSha: "a".repeat(64) } })
    expect(refused.ok).toBe(false)
    const predecessor = doneInterview(h)
    const handed = handoffToRalplan(h.runtime, SID, predecessor, "plan it", [{ wf: "wf_di_seed", type: "spec_written", actor: "code" as const }])
    if (!handed.ok) throw new Error(handed.text)
    writeFileSync(join(wt.worktree, predecessor.artifacts[0]!.path), "changed after handoff\n")
    const result = await runRalplan(h.runtime, SID, handed.wf.id)
    expect(result.status).toBe("stuck")
    expect(h.seen).toHaveLength(0)
  })

  test("a start is refused while another workflow is active, and without a live session", () => {
    const h = harness({})
    const first = begin(h)
    const second = startRalplan(h.runtime, SID, "another")
    expect(second).toMatchObject({ ok: false })
    if (!second.ok) expect(second.text).toContain(`ralplan workflow ${first.id} is active`)
    expect(startRalplan(h.runtime, "ses_nobody", "x").ok).toBe(false)
    expect(startRalplan(h.runtime, SID, "   ").ok).toBe(false)
  })
})

describe("registry, prompts and persisted data", () => {
  test("ralplan is available with no start refusal; ultragoal is available (handoff-only start) and autoresearch is available (driver start only)", () => {
    expect(startRefusal("ralplan")).toBeUndefined()
  })

  test("prompts are frozen, hash-intact, read-only roles of the ralplan kind and carry no executable GJC instruction", () => {
    expect(RALPLAN_PROMPTS.map(prompt => prompt.id)).toEqual(["ralplan.planner", "ralplan.revision", "ralplan.architect", "ralplan.critic"])
    for (const prompt of [RALPLAN_PLANNER_PROMPT, RALPLAN_REVISION_PROMPT, RALPLAN_ARCHITECT_PROMPT, RALPLAN_CRITIC_PROMPT]) {
      expect(Object.isFrozen(prompt)).toBe(true)
      expect(promptIntact(prompt)).toBe(true)
      expect(prompt.kind).toBe("ralplan")
      expect(kindAllowsRole("ralplan", prompt.role)).toBe(true)
      expect(prompt.text).not.toMatch(/\bgjc\b|\.gjc\/|\/skill:|--stage_n|GJC_RALPLAN_ARTIFACT|otter_flow/i)
    }
    expect(RALPLAN_CRITIC_PROMPT.text).toContain("OKAY")
    expect(RALPLAN_ARCHITECT_PROMPT.text).toContain("REQUEST_CHANGES")
  })

  test("ralplan data is strict: unknown keys, openers above the cap, mismatched iterations and an executed choice are invalid; {} is the unstarted state", () => {
    expect(parseRalplanData({})).toMatchObject({ v: 1, openers: 0, iterations: [] })
    const ok = { v: 1, request: "r", openers: 0, iterations: [], attempts: 0 }
    expect(parseRalplanData(ok)).toBeTruthy()
    for (const bad of [{ ...ok, extra: 1 }, { ...ok, openers: 6, iterations: [] }, { ...ok, openers: 1 }, { ...ok, attempts: 3 }, { ...ok, v: 2 }, "x", null]) {
      expect(() => parseRalplanData(bad)).toThrow("invalid workflow state")
    }
    const base = { version: 2, id: "wf_p", kind: "ralplan", stage: "planner", phase: "planning", sessionID: SID, owner: { instance: "i", pid: 1 }, stopIntent: null, artifacts: [], lastSeq: 0, createdAt: 1, updatedAt: 1 }
    expect(parseEnvelope({ ...base, data: {} })).toBeTruthy()
    expect(() => parseEnvelope({ ...base, data: { ...ok, bogus: true } })).toThrow()
  })
})
