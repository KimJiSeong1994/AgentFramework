// P6a S2: the deep-interview engine. Deterministic fixture host (scripted outputs per prompt id and attempt, recorded
// requests and policies); no live model. Ambiguity, bands, panels, receipts and completion are code-owned.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { resumePaused } from "../src/flow/resume.ts"
import { requestStop, stopHeartbeat } from "../src/flow/runtime.ts"
import { statusJson } from "../src/flow/status.ts"
import { readEvents, withFlowTransaction } from "../src/flow/state.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ExecutionHost, ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import type { SessionStore } from "../src/sessions/store.ts"
import { readLedger } from "../src/state/ledger.ts"
import { stateRoot } from "../src/state/store.ts"
import { sha256 } from "../src/workflows/artifacts.ts"
import { commitRevision, readCommitted } from "../src/workflows/commit.ts"
import {
  agendaProgress, ambiguityOf, bandOf, dataOf, DI_MAX_ROUNDS, finalAmbiguity, earlyExitRefusal, newData, nextStep, panelInputSha, panelRequirement, reduce, roundFileRelative,
  sha256Text, specRelative, stalled, topologyInputSha, type DeepInterviewData, type DiEvent,
} from "../src/workflows/deep-interview.ts"
import {
  commitDeepInterview, deepInterviewView, newDeepInterview, retryDeepInterview, runDeepInterview, startDeepInterview, verifiedSpec, type DiAnswer, type DiIo,
} from "../src/workflows/deep-interview-driver.ts"
import {
  DEEP_INTERVIEW_PROMPTS, DEEP_INTERVIEW_SUMMARIZE_PROMPT, DI_SCORER_PROMPT, promptIntact,
} from "../src/workflows/prompts/index.ts"
import { kindAllowsRole, parseEnvelope, REGISTRY, startRefusal } from "../src/workflows/registry.ts"
import { receiptsDirectory, writeReceipt } from "../src/workflows/receipts.ts"
import { parseStageEventsFor } from "../src/workflows/turn.ts"
import type { DeepInterviewWorkflow } from "../src/workflows/types.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

let SID = "ses_di"
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
type Out = string | ((request: ExecutionRequest) => string)
type Script = Partial<Record<string, Out[]>>
type Seen = { role: string; promptId: string; text: string; allowed: readonly string[] }

const j = (value: unknown) => JSON.stringify(value)
const TOPO = j({ type: "topology", project: "brownfield", components: [{ id: "core", description: "the core engine" }] })
const q = (text = "What exactly must it do?") => j({ type: "question", text })
const score = (goal: number, constraints: number, criteria: number, context: number, extra: Record<string, unknown> = {}) =>
  j({ type: "score", goal, constraints, criteria, context, weakest: "goal", evidence: ["e"], ...extra })
const finding = (persona: string) => j({ type: "panel_finding", finding: `SENTINEL-${persona}`, rationale: ["because"], suggested_options: ["option"], confidence: "high" })
const closure = (pass = true, gaps: string[] = [], agendaIDs: string[] | undefined = pass ? undefined : ["core"]) => j({ type: "closure", pass, gaps, ...(agendaIDs ? { agenda_ids: agendaIDs } : {}) })
const restate = (goal = "Build the engine with tests.") => j({ type: "restatement", goal })
const body = j({ type: "message", text: "## Goal\nBuild it.\n## Acceptance Criteria\n- tests pass" })
const answer = (text = "an answer"): DiAnswer => ({ kind: "answer", text })

function harness(script: Script, hooks: { onRun?(request: ExecutionRequest, promptId: string): void } = {}) {
  const queues: Record<string, Out[]> = Object.fromEntries(Object.entries(script).map(([id, list]) => [id, [...(list ?? [])]]))
  const seen: Seen[] = []
  const promptIds = new Map(DEEP_INTERVIEW_PROMPTS.map(prompt => [prompt.text, prompt.id]))
  const host: ExecutionHost = {
    identity: { engine: "fixture", profile: "legacy-unowned" },
    async preflight() { return { compatible: true, controls, problems: [] } },
    async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "fixture has no recovery" } },
    async prepare(request: ExecutionRequest) {
      let done = false
      return {
        reference: { executionID: request.executionID },
        async run(): Promise<ExecutionOutcome> {
          const promptId = [...promptIds].find(([text]) => request.text.startsWith(text))?.[1] ?? "unknown"
          seen.push({ role: request.role, promptId, text: request.text, allowed: request.policy.tools.allowed })
          hooks.onRun?.(request, promptId)
          const next = queues[promptId]?.shift()
          done = true
          if (next === undefined) return { status: "failed", error: `script exhausted for ${promptId}` }
          return { status: "completed", text: typeof next === "function" ? next(request) : next }
        },
        async requestCancel() { done = true; return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
        async reconcile() { return { outcome: done ? "terminal" : "unknown", quiescent: done, evidence: "fixture owned handle" } },
      }
    },
  }
  const runtime = createExecutionRuntime({
    directory: wt.worktree, worktree: wt.worktree, config: structuredClone(DEFAULT_CONFIG), log() {},
  }, () => host, { planningOnlyMain: true })
  SID = `ses_di${counter++}`
  store = attachAdmission(runtime, SID, { engine: "fixture", model: "fixture-model" })
  return { runtime, seen, queues, ids: () => seen.map(item => item.promptId) }
}
type Harness = ReturnType<typeof harness>

type IoOptions = { choices?: number[]; answers?: DiAnswer[]; notes?: string[]; onChoose?(title: string, choices: readonly string[]): void }
function makeIo(options: IoOptions = {}) {
  const choices = [...(options.choices ?? [])]
  const answers = [...(options.answers ?? [])]
  const notes = [...(options.notes ?? [])]
  const log = { chooses: [] as Array<{ title: string; choices: readonly string[] }>, notices: [] as string[], questions: [] as string[], opens: [] as Array<Parameters<DiIo["readAnswer"]>[0]> }
  const io: DiIo = {
    async choose(title, list) { log.chooses.push({ title, choices: list }); options.onChoose?.(title, list); return choices.shift() ?? 0 },
    async readAnswer(open) { log.questions.push(open.question); log.opens.push(open); return answers.shift() },
    async readNote() { return notes.shift() },
    notice(text) { log.notices.push(text) },
  }
  return { io, log, choices, answers, notes }
}

function begin(h: Harness, request = "build the widget"): DeepInterviewWorkflow {
  const started = startDeepInterview(h.runtime, SID, request)
  if (!started.ok) throw new Error(started.text)
  return started.wf
}
// Historical fixtures deliberately omit the optional policy to exercise persisted legacy interviews.
function legacyData(request: string): DeepInterviewData {
  const { questionPolicy: _policy, ...data } = newData(request)
  return { ...data, threshold: 0.05, thresholdSource: "otter-default" }
}
function beginLegacy(h: Harness): DeepInterviewWorkflow {
  const wf = begin(h)
  return withFlowTransaction(wt.worktree, tx => commitRevision(tx, { ...wf, data: legacyData("build the widget") }, [{ wf: wf.id, type: "legacy_fixture", actor: "code" }]), SID) as DeepInterviewWorkflow
}
const committed = (): DeepInterviewWorkflow => {
  const read = readCommitted(wt.worktree, {}, SID)
  if (read.state !== "ok" || read.wf.kind !== "deep-interview") throw new Error("no committed deep-interview")
  return read.wf
}
const eventTypes = (wid: string) => readEvents(wt.worktree, wid, SID).map(event => event.type)
const dataNow = () => dataOf(committed())
const run = (h: Harness, wf: DeepInterviewWorkflow, io: DiIo, options = {}) => runDeepInterview(h.runtime, SID, wf.id, io, options)

/** Round 1 scores .22 (refined); round 2 scores 0 (ready): a band change, so a researcher/contrarian/simplifier panel. */
function happy(extra: Script = {}): Script {
  return {
    "di.interviewer.topology": [TOPO],
    "di.interviewer.question": [q("Q1"), q("Q2")],
    "di.scorer": [score(0.9, 0.8, 0.7, 0.6), score(1, 1, 1, 1)],
    "di.panel.researcher": [finding("researcher")],
    "di.panel.contrarian": [finding("contrarian")],
    "di.panel.simplifier": [finding("simplifier")],
    "di.closure": [closure()],
    "di.restate": [restate()],
    "di.crystallize": [body],
    ...extra,
  }
}
const twoAnswers = () => [answer("a1"), answer("a2")]

/** Seed a committed interview mid-flight (files for every recorded round are written so the transcript verifies). */
function seed(patch: (d: DeepInterviewData) => DeepInterviewData, stage: DeepInterviewWorkflow["stage"], phase: DeepInterviewWorkflow["phase"] = "planning", rounds: Array<{ n: number; ambiguity?: number; band?: string }> = []): DeepInterviewWorkflow {
  const fresh = newDeepInterview(SID, currentOwner(Date.now(), store!.epoch), "fixture", "seeded request")
  const records = rounds.map(r => {
    const dir = join(wt.worktree, ".otter", "workflows", SID, fresh.id, "rounds")
    mkdirSync(dir, { recursive: true })
    const questionText = `seed question ${r.n}`
    const answerText = `seed answer ${r.n}`
    writeFileSync(join(wt.worktree, roundFileRelative(SID, fresh.id, r.n, "question")), questionText)
    writeFileSync(join(wt.worktree, roundFileRelative(SID, fresh.id, r.n, "answer")), answerText)
    return {
      n: r.n, questionSha: sha256Text(questionText), answerSha: sha256Text(answerText),
      ...(r.ambiguity === undefined ? {} : { scores: { goal: 0.6, constraints: 0.6, criteria: 0.6, context: 0.6 }, weakest: "goal", ambiguity: r.ambiguity, band: r.band }),
    }
  })
  const components = [{ id: "core", description: "the core engine" }]
  // A real topology choice receipt: the completion re-check verifies it like any other record.
  const topologyRef = writeReceipt(wt.worktree, { kind: "choice", wid: fresh.id, sid: SID, revision: 0, action: "choice-topology", inputSha: topologyInputSha("brownfield", components), body: { choice: "confirm" } })
  const base: DeepInterviewData = {
    ...legacyData("seeded request"), type: "brownfield", round: rounds.length ? rounds.at(-1)!.n : 0,
    topology: { confirmed: true, components, receiptRef: topologyRef }, rounds: records as never,
  }
  const wf = { ...fresh, stage, phase, data: patch(base) } as DeepInterviewWorkflow
  return withFlowTransaction(wt.worktree, tx => commitRevision(tx, wf, [{ wf: wf.id, type: "created", actor: "code" }]), SID) as DeepInterviewWorkflow
}

// ---------------------------------------------------------------------------------------------- pure engine
describe("ambiguity is computed by code from component scores", () => {
  test("brownfield .35/.25/.25/.15 and greenfield .40/.30/.30", () => {
    expect(ambiguityOf("brownfield", { goal: 0.9, constraints: 0.8, criteria: 0.7, context: 0.6 })).toBeCloseTo(0.22, 9)
    expect(ambiguityOf("greenfield", { goal: 0.9, constraints: 0.8, criteria: 0.7 })).toBeCloseTo(0.19, 9)
    expect(ambiguityOf("greenfield", { goal: 0.9, constraints: 0.8, criteria: 0.7, context: 0 })).toBeCloseTo(0.19, 9)
    expect(ambiguityOf("brownfield", { goal: 1, constraints: 1, criteria: 1, context: 1 })).toBe(0)
  })

  test("NaN, out-of-range and a missing brownfield context are rejected", () => {
    expect(() => ambiguityOf("brownfield", { goal: Number.NaN, constraints: 1, criteria: 1, context: 1 })).toThrow("finite")
    expect(() => ambiguityOf("brownfield", { goal: 1.2, constraints: 1, criteria: 1, context: 1 })).toThrow("[0,1]")
    expect(() => ambiguityOf("greenfield", { goal: -0.1, constraints: 1, criteria: 1 })).toThrow("[0,1]")
    expect(() => ambiguityOf("brownfield", { goal: 1, constraints: 1, criteria: 1 })).toThrow("context")
  })

  test("an invalid score is an attempt failure with no scores_recorded; twice makes the workflow stuck", async () => {
    const h = harness(happy({ "di.scorer": [score(0.9, 0.8, 0.7, 0.6, { goal: 1.2 }), j({ type: "score", goal: "high", constraints: 1, criteria: 1, context: 1, weakest: "goal", evidence: [] })] }))
    const wf = begin(h)
    const result = await run(h, wf, makeIo({ answers: twoAnswers() }).io)
    expect(result.status).toBe("stuck")
    expect(committed()).toMatchObject({ phase: "stuck", stage: "scoring" })
    expect(eventTypes(wf.id)).not.toContain("scores_recorded")
    expect(h.ids().filter(id => id === "di.scorer")).toHaveLength(2)
  })

  test("the model cannot claim ambiguity: the field is rejected, and the committed value comes from the components", async () => {
    const parse = (extra: Record<string, unknown>) => parseStageEventsFor(score(0.9, 0.8, 0.7, 0.6, extra), "deep-interview", "scoring")
    for (const key of ["ambiguity", "phase", "approved", "stage"]) expect(parse({ [key]: 0 })).toMatchObject({ ok: false })
    const h = harness(happy({ "di.scorer": [score(0.9, 0.8, 0.7, 0.6, {}), score(1, 1, 1, 1)] }))
    const wf = begin(h)
    await run(h, wf, makeIo({ answers: [answer()] }).io, { stopBefore: "panel" })
    expect(dataNow().rounds[0]).toMatchObject({ ambiguity: 0.22, band: "refined" })
    const scored = readEvents(wt.worktree, wf.id, SID).find(event => event.type === "scores_recorded")!
    expect(scored.data).toMatchObject({ ambiguity: 0.22, threshold: 0.2 })
  })
})

describe("bands", () => {
  test("edges: >.60 initial, .60 progress, .30 refined, just above .05 refined, .05 ready", () => {
    expect(bandOf(0.6001)).toBe("initial")
    expect(bandOf(0.6)).toBe("progress")
    expect(bandOf(0.3001)).toBe("progress")
    expect(bandOf(0.3)).toBe("refined")
    expect(bandOf(0.0501)).toBe("refined")
    expect(bandOf(0.05)).toBe("ready")
    expect(bandOf(0)).toBe("ready")
  })
})

describe("panel triggers", () => {
  const base = { threshold: 0.05, shapeChange: false, synthesized: false }
  const req = (prevBand: Parameters<typeof panelRequirement>[0]["prevBand"], band: Parameters<typeof panelRequirement>[0]["band"], history: number[], round: number, extra = {}) =>
    panelRequirement({ ...base, prevBand, band, history, round, ...extra })

  test("a band change in either direction requires researcher, contrarian and simplifier", () => {
    expect(req("progress", "refined", [0.5, 0.25], 2)).toMatchObject({ personas: ["researcher", "contrarian", "simplifier"], ontology: false })
    expect(req("refined", "progress", [0.25, 0.5], 2)).toMatchObject({ personas: ["researcher", "contrarian", "simplifier"] })
  })
  test("no band change and no stall means no panel", () => {
    expect(req("progress", "progress", [0.5, 0.4], 2)).toBeNull()
    expect(req(undefined, "initial", [0.9], 1)).toBeNull()
  })
  test("a synthesized (agent-supplied) answer convenes the panel even without a band change", () => {
    expect(req("progress", "progress", [0.5, 0.4], 2, { synthesized: true })?.triggers).toContain("synthesized-answer")
  })
  test("ambiguities .40/.42/.38 stall: ontology escalation and the architect", () => {
    expect(stalled([0.4, 0.42, 0.38], 3)).toBe(true)
    expect(req("progress", "progress", [0.4, 0.42, 0.38], 3)).toMatchObject({ ontology: true, personas: ["researcher", "contrarian", "simplifier", "architect"] })
  })
  test("round 8 at .31 escalates; a ready score never stalls", () => {
    expect(req("progress", "progress", [0.5, 0.31], 8)).toMatchObject({ ontology: true, personas: expect.arrayContaining(["architect"]) })
    expect(stalled([0.05, 0.05, 0.05], 3)).toBe(false)
  })
  test("scorer shape_change adds the architect without ontology", () => {
    expect(req("progress", "refined", [0.5, 0.25], 2, { shapeChange: true })).toMatchObject({ personas: expect.arrayContaining(["architect"]), ontology: false })
  })
})

describe("registry and prompts", () => {
  test("deep-interview is available and a real kind; ultragoal and autoresearch are available (guarded starts)", () => {
    expect(startRefusal("deep-interview")).toBeUndefined()
  })

  test("every prompt is frozen, intact, read-only schedulable and free of executable GJC instructions", () => {
    expect(DEEP_INTERVIEW_PROMPTS.map(prompt => prompt.id).sort()).toEqual([
      "di.closure", "di.crystallize", "di.interviewer.question", "di.interviewer.topology", "di.panel.architect", "di.panel.contrarian",
      "di.panel.researcher", "di.panel.simplifier", "di.restate", "di.scorer", "di.summarize",
    ])
    for (const prompt of DEEP_INTERVIEW_PROMPTS) {
      expect(Object.isFrozen(prompt)).toBe(true)
      expect(promptIntact(prompt)).toBe(true)
      expect(kindAllowsRole(prompt.kind, prompt.role)).toBe(true)
      expect(prompt.text).not.toMatch(/\bgjc\b|\.gjc\/|\/skill:|otter_flow|GJC_RALPLAN/i)
    }
    expect(DI_SCORER_PROMPT.role).toBe("interviewer")
    expect(new Set(DEEP_INTERVIEW_PROMPTS.map(prompt => prompt.sha256)).size).toBe(DEEP_INTERVIEW_PROMPTS.length)
  })

  test("the envelope parser accepts empty or complete data and rejects malformed data", () => {
    const wf = newDeepInterview("ses_p", { instance: "i", pid: 1 }, "fixture", "x")
    expect(() => parseEnvelope(wf)).not.toThrow()
    expect(() => parseEnvelope({ ...wf, data: {} })).not.toThrow()
    expect(() => parseEnvelope({ ...wf, data: { v: 1, request: 5 } })).toThrow("invalid workflow state")
    expect(() => parseEnvelope({ ...wf, phase: "pending_approval" })).toThrow("invalid workflow state")
    expect(() => parseEnvelope({ ...wf, phase: "executing" })).toThrow("invalid workflow state")
  })
})

// ---------------------------------------------------------------------------------------------- end to end
describe("topology first", () => {
  test("created -> topology_confirmed come first; no question or score is requested before the choice; Adjust re-runs the topology turn", async () => {
    const h = harness(happy({ "di.interviewer.topology": [TOPO, TOPO] }))
    const wf = begin(h)
    const first: string[] = []
    const io = makeIo({
      answers: twoAnswers(), choices: [1, 0, 0, 0],
      onChoose: title => { if (title.startsWith("Confirm the topology")) first.push(h.ids().join(",")) },
      notes: ["add a CLI component"],
    })
    const result = await run(h, wf, io.io)
    expect(result.status).toBe("done")
    expect(first).toEqual(["di.interviewer.topology", "di.interviewer.topology,di.interviewer.topology"])
    const types = eventTypes(wf.id)
    expect(types.slice(0, 3)).toEqual(["created", "transition", "topology_confirmed"])
    expect(types.filter(type => type === "topology_confirmed")).toHaveLength(1)
    expect(h.seen[1]!.text).toContain("add a CLI component")
    expect(h.ids().slice(0, 3)).toEqual(["di.interviewer.topology", "di.interviewer.topology", "di.interviewer.question"])
  })

  test("the engine refuses a second topology confirmation and any question before it", () => {
    const h = harness(happy())
    const wf = begin(h)
    expect(reduce(wf, { type: "question_asked", round: 1, questionSha: "a".repeat(64) }, { worktree: wt.worktree })).toMatchObject({ ok: false })
    expect(reduce(wf, { type: "scores_recorded", round: 1, scores: { goal: 1, constraints: 1, criteria: 1, context: 1 }, weakest: "goal", shapeChange: false, evidence: [] }, { worktree: wt.worktree })).toMatchObject({ ok: false })
    const confirmed = { ...wf, stage: "question", data: { ...dataOf(wf), topology: { confirmed: true, components: [{ id: "x", description: "y" }] } } } as DeepInterviewWorkflow
    expect(reduce(confirmed, { type: "topology_confirmed", projectType: "brownfield", components: [{ id: "x", description: "y" }], receiptRef: "r#" + "0".repeat(64) }, { worktree: wt.worktree })).toMatchObject({ ok: false })
  })
})

describe("one question per round", () => {
  test("0 or 2 question events is an attempt failure; twice in a row is stuck with no further dispatch until Retry", async () => {
    const h = harness(happy({ "di.interviewer.question": [j([{ type: "question", text: "a?" }, { type: "question", text: "b?" }]), j({ type: "message", text: "no question" }), q("fine?")] }))
    const wf = begin(h)
    const result = await run(h, wf, makeIo({ answers: twoAnswers() }).io)
    expect(result.status).toBe("stuck")
    expect(committed()).toMatchObject({ phase: "stuck", stage: "question" })
    const asked = h.ids().filter(id => id === "di.interviewer.question").length
    expect(asked).toBe(2)
    const again = await run(h, committed(), makeIo({ answers: twoAnswers() }).io)
    expect(again.status).toBe("stuck")
    expect(h.ids().filter(id => id === "di.interviewer.question")).toHaveLength(asked)
    const retried = retryDeepInterview(h.runtime, SID, wf.id, committed().lastSeq)
    expect(retried.ok).toBe(true)
    expect(committed()).toMatchObject({ phase: "planning", stage: "question" })
    const resumed = await run(h, committed(), makeIo({ answers: twoAnswers() }).io, { stopBefore: "scoring" })
    expect(resumed.status).toBe("blocked")
    expect(h.ids().filter(id => id === "di.interviewer.question")).toHaveLength(asked + 1)
  })

  test("a failed attempt then a good one still succeeds (max 2 attempts, not 1)", async () => {
    const h = harness(happy({ "di.interviewer.question": [j({ type: "message", text: "bad" }), q("ok?"), q("Q2")] }))
    const wf = begin(h)
    const result = await run(h, wf, makeIo({ answers: twoAnswers() }).io)
    expect(result.status).toBe("done")
  })
})

describe("question options", () => {
  const agenda = (question: number) => ({ id: "core", description: "the core engine", index: 1, total: 1, question, limit: 2 })
  const withOptions = (): Script => happy({
    "di.interviewer.question": [
      j({ type: "question", text: "Which store?", options: ["SQLite", "Postgres"], recommended: 1 }),
      q("Q2"),
    ],
  })

  test("options are stored beside the question, the question text and sha are unchanged, and readAnswer receives them", async () => {
    const h = harness(withOptions())
    const wf = begin(h)
    const io = makeIo({ answers: twoAnswers() })
    expect((await run(h, wf, io.io)).status).toBe("done")
    expect(io.log.opens[0]).toEqual({ round: 1, agenda: agenda(1), question: "Which store?", options: ["SQLite", "Postgres"], recommended: 1 })
    expect(io.log.opens[1]).toEqual({ round: 2, agenda: agenda(2), question: "Q2" })
    const questionPath = join(wt.worktree, roundFileRelative(SID, wf.id, 1, "question"))
    expect(readFileSync(questionPath, "utf8")).toBe("Which store?")
    expect(dataNow().rounds[0]!.questionSha).toBe(sha256Text("Which store?"))
    expect(JSON.parse(readFileSync(questionPath.replace(/\.md$/u, ".options.json"), "utf8"))).toEqual({ options: ["SQLite", "Postgres"], recommended: 1 })
    expect(existsSync(join(wt.worktree, roundFileRelative(SID, wf.id, 2, "question")).replace(/\.md$/u, ".options.json"))).toBe(false)
  })

  test("a corrupt, oversized or out-of-range options file means no options and never fails the round", async () => {
    const h = harness(withOptions())
    const wf = begin(h)
    await run(h, wf, makeIo({ answers: [] }).io)
    const file = join(wt.worktree, roundFileRelative(SID, wf.id, 1, "question")).replace(/\.md$/u, ".options.json")
    for (const bad of ["{not json", JSON.stringify({ options: [] }), JSON.stringify({ options: ["a", 3] }), JSON.stringify({ options: ["a".repeat(201)] }), "x".repeat(20_000), "[]"]) {
      writeFileSync(file, bad)
      const again = makeIo({ answers: [] })
      await run(h, committed(), again.io)
      expect(again.log.opens[0]).toEqual({ round: 1, agenda: agenda(1), question: "Which store?" })
    }
    writeFileSync(file, JSON.stringify({ options: ["A", "B"], recommended: 9 }))
    const again = makeIo({ answers: [] })
    await run(h, committed(), again.io)
    expect(again.log.opens[0]).toEqual({ round: 1, agenda: agenda(1), question: "Which store?", options: ["A", "B"] })
  })
})

describe("the full interview", () => {
  test("topology, two rounds, a band-change panel, closure, restatement and a verified spec reach done", async () => {
    const h = harness(happy())
    const wf = begin(h)
    const trail: string[] = []
    const result = await run(h, wf, makeIo({ answers: twoAnswers() }).io, { onStep: (w: DeepInterviewWorkflow) => trail.push(`${w.stage}:${w.phase}`) })
    expect(result.status).toBe("done")
    const final = committed()
    expect(final).toMatchObject({ stage: "terminal", phase: "done" })
    expect(trail).toEqual(expect.arrayContaining(["topology:planning", "question:planning", "answer:planning", "scoring:planning", "panel:reviewing", "closure:reviewing", "restate:planning", "crystallize:planning"]))
    expect(h.ids()).toEqual([
      "di.interviewer.topology", "di.interviewer.question", "di.scorer", "di.interviewer.question", "di.scorer",
      "di.panel.researcher", "di.panel.contrarian", "di.panel.simplifier", "di.closure", "di.restate", "di.crystallize",
    ])
  })
})

// ---------------------------------------------------------------------------------------------- panels (W1)
const receiptFiles = (wid: string) => { try { return readdirSync(receiptsDirectory(wt.worktree, SID, wid)).sort() } catch { return [] } }
const receiptFor = (wid: string, part: string) => join(receiptsDirectory(wt.worktree, SID, wid), receiptFiles(wid).find(name => name.includes(part))!)

describe("a required panel blocks progress (W1)", () => {
  test("malformed contrarian output twice -> stuck at panel; no question, no closure, no spec, status not done", async () => {
    const h = harness(happy({ "di.panel.contrarian": ["not json", j({ type: "panel_finding", finding: "" })] }))
    const wf = begin(h)
    const result = await run(h, wf, makeIo({ answers: twoAnswers() }).io)
    expect(result.status).toBe("stuck")
    expect(committed()).toMatchObject({ phase: "stuck", stage: "panel" })
    expect(h.ids().filter(id => id === "di.panel.contrarian")).toHaveLength(2)
    expect(h.ids().filter(id => id === "di.interviewer.question")).toHaveLength(2)
    expect(h.ids()).not.toContain("di.closure")
    expect(h.ids()).not.toContain("di.panel.simplifier")
    expect(eventTypes(wf.id)).not.toContain("closure_result")
    expect(existsSync(join(wt.worktree, specRelative(SID, wf.id)))).toBe(false)
    const status = statusJson({ worktree: wt.worktree, config: DEFAULT_CONFIG, log() {} }, SID)
    expect(status.workflow).toMatchObject({ kind: "deep-interview", phase: "stuck" })
    expect(dataNow().stuck?.item).toBe("panel:contrarian")
    expect(dataNow().panelFailures).toBe(1)
    expect(dataNow().stuck?.evidence).toHaveLength(2)
  })

  test("a persona missing from the scripted host (the model produces nothing) has the same result", async () => {
    const h = harness(happy({ "di.panel.contrarian": [] }))
    const wf = begin(h)
    const result = await run(h, wf, makeIo({ answers: twoAnswers() }).io)
    expect(result.status).toBe("stuck")
    expect(committed()).toMatchObject({ phase: "stuck", stage: "panel" })
    expect(h.ids()).not.toContain("di.closure")
    expect(eventTypes(wf.id)).not.toContain("spec_written")
  })

  test("Retry re-runs only the failed persona, then the interview proceeds", async () => {
    const h = harness(happy({ "di.panel.contrarian": ["bad", "bad", finding("contrarian")] }))
    const wf = begin(h)
    await run(h, wf, makeIo({ answers: twoAnswers() }).io)
    expect(retryDeepInterview(h.runtime, SID, wf.id, committed().lastSeq).ok).toBe(true)
    const resumed = await run(h, committed(), makeIo({ answers: [] }).io)
    expect(resumed.status).toBe("done")
    expect(h.ids().filter(id => id === "di.panel.researcher")).toHaveLength(1)
    expect(h.ids().filter(id => id === "di.panel.contrarian")).toHaveLength(3)
  })

  test("removing a persona receipt blocks the next step; tampering is detected and status shows incomplete", async () => {
    const h = harness(happy())
    const wf = begin(h)
    await run(h, wf, makeIo({ answers: twoAnswers() }).io, { stopBefore: "closure" })
    expect(committed().stage).toBe("closure")
    const path = receiptFor(wf.id, "contrarian")
    const bytes = readFileSync(path)
    rmSync(path)
    expect(nextStep(committed(), wt.worktree)).toMatchObject({ kind: "blocked" })
    const before = h.ids().length
    const blocked = await run(h, committed(), makeIo().io)
    expect(blocked.status).toBe("blocked")
    expect(h.ids().length).toBe(before)
    expect(deepInterviewView(committed(), wt.worktree).panel.find(item => item.persona === "contrarian")?.state).toBe("incomplete")
    expect(deepInterviewView(committed(), wt.worktree).line).toContain("incomplete panel records: contrarian")
    expect(reduce(committed(), { type: "closure_result", pass: true, gaps: [], receiptRef: "x#" + "0".repeat(64) }, { worktree: wt.worktree })).toMatchObject({ ok: false, text: expect.stringContaining("panel record") })
    writeFileSync(path, bytes.toString("utf8").replace("SENTINEL-contrarian", "SENTINEL-tampered"))
    expect(nextStep(committed(), wt.worktree)).toMatchObject({ kind: "blocked" })
    writeFileSync(path, bytes)
    expect(nextStep(committed(), wt.worktree)).toMatchObject({ kind: "closure" })
  })

  test("deleting a persona receipt between the turn and panel_result makes the commit refuse", () => {
    const h = harness({})
    const base = seed(d => d, "scoring", "planning", [{ n: 1, ambiguity: 0.22, band: "refined" }])
    const d0 = dataOf(base)
    const round = d0.rounds[0]!
    const requirement = { personas: ["researcher", "contrarian", "simplifier"] as const, ontology: false, triggers: ["band:progress->refined"] }
    const inputSha = panelInputSha(base, d0, round, requirement)
    const pending = { round: 1, inputSha, triggers: [...requirement.triggers], personas: [...requirement.personas], ontology: false, results: {} }
    const wf = { ...base, stage: "panel", phase: "reviewing", data: { ...d0, pendingPanel: pending } } as DeepInterviewWorkflow
    const ref = writeReceipt(wt.worktree, { kind: "panel", wid: wf.id, sid: SID, revision: wf.lastSeq, action: "panel-r1-researcher", inputSha, body: { round: 1, persona: "researcher", finding: "f" } })
    expect(reduce(wf, { type: "panel_result", persona: "researcher", receiptRef: ref }, { worktree: wt.worktree })).toMatchObject({ ok: true })
    rmSync(join(receiptsDirectory(wt.worktree, SID, wf.id), receiptFiles(wf.id).find(name => name.includes("panel-r1-researcher"))!))
    expect(reduce(wf, { type: "panel_result", persona: "researcher", receiptRef: ref }, { worktree: wt.worktree })).toMatchObject({ ok: false })
    void h
  })

  test("a receipt from another round or input is not accepted for this round", () => {
    harness({})
    const base = seed(d => d, "scoring", "planning", [{ n: 2, ambiguity: 0.22, band: "refined" }])
    const d0 = dataOf(base)
    const requirement = { personas: ["researcher", "contrarian", "simplifier"] as const, ontology: false, triggers: ["t"] }
    const inputSha = panelInputSha(base, d0, d0.rounds[0]!, requirement)
    const pending = { round: 2, inputSha, triggers: ["t"], personas: [...requirement.personas], ontology: false, results: {} }
    const wf = { ...base, stage: "panel", phase: "reviewing", data: { ...d0, pendingPanel: pending } } as DeepInterviewWorkflow
    const old = writeReceipt(wt.worktree, { kind: "panel", wid: wf.id, sid: SID, revision: wf.lastSeq, action: "panel-r1-researcher", inputSha: sha256Text("round 1 input"), body: { round: 1, persona: "researcher" } })
    expect(reduce(wf, { type: "panel_result", persona: "researcher", receiptRef: old }, { worktree: wt.worktree })).toMatchObject({ ok: false, text: expect.stringContaining("not bound") })
    const wrongRound = writeReceipt(wt.worktree, { kind: "panel", wid: wf.id, sid: SID, revision: wf.lastSeq, action: "panel-r2-researcher", inputSha, body: { round: 1, persona: "researcher" } })
    expect(reduce(wf, { type: "panel_result", persona: "researcher", receiptRef: wrongRound }, { worktree: wt.worktree })).toMatchObject({ ok: false })
    const wrongPersona = writeReceipt(wt.worktree, { kind: "panel", wid: wf.id, sid: SID, revision: wf.lastSeq, action: "panel-r2-x", inputSha, body: { round: 2, persona: "contrarian" } })
    expect(reduce(wf, { type: "panel_result", persona: "researcher", receiptRef: wrongPersona }, { worktree: wt.worktree })).toMatchObject({ ok: false })
    expect(reduce(wf, { type: "panel_result", persona: "architect", receiptRef: wrongPersona }, { worktree: wt.worktree })).toMatchObject({ ok: false, text: expect.stringContaining("not a required persona") })
  })

  test("closure and the next question are refused while any required persona lacks a record", () => {
    harness({})
    const base = seed(d => d, "scoring", "planning", [{ n: 1, ambiguity: 0.22, band: "refined" }])
    const d0 = dataOf(base)
    const pending = { round: 1, inputSha: "a".repeat(64), triggers: ["t"], personas: ["researcher" as const], ontology: false, results: {} }
    for (const stage of ["question", "closure"] as const) {
      const wf = { ...base, stage, data: { ...d0, pendingPanel: pending } } as DeepInterviewWorkflow
      const event: DiEvent = stage === "question" ? { type: "question_asked", round: 2, questionSha: "b".repeat(64) } : { type: "closure_result", pass: true, gaps: [], receiptRef: "r#" + "0".repeat(64) }
      expect(reduce(wf, event, { worktree: wt.worktree })).toMatchObject({ ok: false, text: expect.stringContaining("required panel record") })
    }
  })
})

describe("panel independence and binding", () => {
  test("every persona request shares one panel input hash, none sees another's finding, and receipts record round and input hash", async () => {
    const h = harness(happy())
    const wf = begin(h)
    await run(h, wf, makeIo({ answers: twoAnswers() }).io)
    const personas = h.seen.filter(item => item.promptId.startsWith("di.panel."))
    expect(personas.map(item => item.promptId)).toEqual(["di.panel.researcher", "di.panel.contrarian", "di.panel.simplifier"])
    expect(personas.map(item => item.role)).toEqual(["researcher", "contrarian", "simplifier"])
    const hashes = personas.map(item => /panel input sha: ([a-f0-9]{64})/.exec(item.text)![1]!)
    expect(new Set(hashes).size).toBe(1)
    for (const item of personas) for (const name of ["researcher", "contrarian", "simplifier"]) expect(item.text).not.toContain(`SENTINEL-${name}`)
    const files = receiptFiles(wf.id).filter(name => name.includes("panel-r2"))
    expect(files).toHaveLength(3)
    for (const name of files) {
      const receipt = JSON.parse(readFileSync(join(receiptsDirectory(wt.worktree, SID, wf.id), name), "utf8"))
      expect(receipt).toMatchObject({ kind: "panel", wid: wf.id, inputSha: hashes[0], body: { round: 2 } })
    }
    const triggered = readEvents(wt.worktree, wf.id, SID).find(event => event.type === "panel_required")!
    expect(triggered.data).toMatchObject({ round: 2, inputSha: hashes[0], personas: ["researcher", "contrarian", "simplifier"] })
  })

  test("the next question folds the verified panel findings and still asks one question", async () => {
    const h = harness(happy({ "di.scorer": [score(0.6, 0.6, 0.6, 0.6), score(0.9, 0.8, 0.7, 0.6), score(1, 1, 1, 1)], "di.interviewer.question": [q("Q1"), q("Q2"), q("Q3")] }))
    const wf = beginLegacy(h)
    // ambiguity .4 (progress) then .22 (refined): a band change panel precedes question 3
    await run(h, wf, makeIo({ answers: [answer(), answer(), answer()] }).io)
    const third = h.seen.filter(item => item.promptId === "di.interviewer.question")[2]!
    expect(third.text).toContain("SENTINEL-researcher")
    expect(third.text).toContain("SENTINEL-contrarian")
    expect(third.text).toContain("SENTINEL-simplifier")
  })

  test("a band change in either direction convenes the panel: initial -> progress -> refined", async () => {
    const h = harness(happy({
      "di.scorer": [score(0.2, 0.2, 0.2, 0.2), score(0.6, 0.6, 0.6, 0.6), score(0.9, 0.8, 0.7, 0.6), score(1, 1, 1, 1)],
      "di.interviewer.question": [q("1"), q("2"), q("3"), q("4")],
      "di.panel.researcher": [finding("researcher"), finding("researcher"), finding("researcher")],
      "di.panel.contrarian": [finding("contrarian"), finding("contrarian"), finding("contrarian")],
      "di.panel.simplifier": [finding("simplifier"), finding("simplifier"), finding("simplifier")],
    }))
    const wf = beginLegacy(h)
    await run(h, wf, makeIo({ answers: [answer(), answer(), answer(), answer()] }).io)
    const panels = readEvents(wt.worktree, wf.id, SID).filter(event => event.type === "panel_required").map(event => (event.data as { triggers: string[] }).triggers[0])
    expect(panels).toEqual(["band:initial->progress", "band:progress->refined", "band:refined->ready"])
    const upward = reduce({ ...committed(), stage: "scoring", phase: "planning", data: { ...legacyData("x"), type: "brownfield", round: 2, topology: { confirmed: true, components: [{ id: "c", description: "d" }] }, rounds: [{ n: 1, questionSha: "a", scores: { goal: 1, constraints: 1, criteria: 1, context: 1 }, ambiguity: 0.22, band: "refined" }, { n: 2, questionSha: "b", answerSha: "c" }] } } as unknown as DeepInterviewWorkflow,
      { type: "scores_recorded", round: 2, scores: { goal: 0.3, constraints: 0.3, criteria: 0.3, context: 0.3 }, weakest: "goal", shapeChange: false, evidence: [] }, { worktree: wt.worktree })
    expect(upward.ok && eventTypesOf(upward)).toContain("panel_required")
  })

  test("a user answer is the only answer the engine accepts (no auto-answer path skips the panel)", () => {
    harness({})
    const wf = seed(d => d, "answer", "planning", [{ n: 1 }])
    const base = { type: "answer_recorded" as const, round: 1, answerSha: "a".repeat(64), chars: 5 }
    expect(reduce(wf, { ...base, source: "agent" }, { worktree: wt.worktree })).toMatchObject({ ok: false, text: expect.stringContaining("only a user answer") })
    expect(reduce(wf, { ...base, source: "user", chars: DI_MAX_ROUNDS * 1000 }, { worktree: wt.worktree })).toMatchObject({ ok: false })
    expect(reduce(wf, { ...base, source: "user" }, { worktree: wt.worktree })).toMatchObject({ ok: true })
    const scoring = { ...wf, stage: "scoring" } as DeepInterviewWorkflow
    const synthesized = reduce(scoring, { type: "scores_recorded", round: 1, scores: { goal: 0.9, constraints: 0.8, criteria: 0.7, context: 0.6 }, weakest: "goal", shapeChange: false, evidence: [], synthesized: true }, { worktree: wt.worktree })
    expect(synthesized.ok && eventTypesOf(synthesized)).toContain("panel_required")
  })
})

function eventTypesOf(result: Extract<ReturnType<typeof reduce>, { ok: true }>): string[] {
  return result.events.map(event => event.type)
}

// ---------------------------------------------------------------------------------------------- cap
describe("the round cap", () => {
  const capScript = (extra: Script = {}): Script => happy({
    "di.interviewer.question": [q("Q100")],
    "di.scorer": [score(0.6, 0.6, 0.6, 0.6)],
    "di.panel.researcher": [finding("researcher")], "di.panel.contrarian": [finding("contrarian")],
    "di.panel.simplifier": [finding("simplifier")], "di.panel.architect": [finding("architect")],
    ...extra,
  })
  const atNinetyNine = () => seed(d => d, "question", "planning", [{ n: 98, ambiguity: 0.4, band: "progress" }, { n: 99, ambiguity: 0.4, band: "progress" }])

  test("seeded at round 99: answering once records round 100 with a cap warning and a Crystallize/Exit choice, never a round-101 question", async () => {
    const h = harness(capScript())
    const wf = atNinetyNine()
    const io = makeIo({ answers: [answer()], choices: [0, 0] })
    const result = await run(h, wf, io.io)
    expect(result.status).toBe("done")
    const cap = io.log.chooses.find(item => item.title.includes("Maximum interview rounds"))!
    expect(cap.title).toContain("Nothing is executed")
    expect(cap.choices).toEqual(["Crystallize with current clarity", "Exit the interview"])
    expect(h.ids().filter(id => id === "di.interviewer.question")).toHaveLength(1)
    expect(committed().stage).toBe("terminal")
    expect(dataNow().round).toBe(100)
    expect(dataNow().cap).toMatchObject({ round: 100, decided: true })
    expect(readFileSync(join(wt.worktree, specRelative(SID, wf.id)), "utf8")).toContain("Status: ROUND_CAP_EXIT")
    // the stalled round-100 score still convened its panel (with the architect) before the cap choice
    expect(h.ids()).toEqual(expect.arrayContaining(["di.panel.researcher", "di.panel.contrarian", "di.panel.simplifier", "di.panel.architect"]))
    expect(h.ids().indexOf("di.panel.architect")).toBeLessThan(h.ids().indexOf("di.closure"))
    expect(readLedger(wt.worktree, SID).tasks).toHaveLength(0)
  })

  test("Exit cancels without a spec; the engine refuses any question past round 100", async () => {
    const h = harness(capScript())
    const wf = atNinetyNine()
    const result = await run(h, wf, makeIo({ answers: [answer()], choices: [1] }).io)
    expect(result.status).toBe("exited")
    expect(committed()).toMatchObject({ phase: "cancelled", stage: "terminal" })
    expect(existsSync(join(wt.worktree, specRelative(SID, wf.id)))).toBe(false)
    expect(h.ids().filter(id => id === "di.interviewer.question")).toHaveLength(1)
    const atCap = { ...wf, data: { ...dataOf(wf), round: 100 } } as DeepInterviewWorkflow
    expect(reduce(atCap, { type: "question_asked", round: 101, questionSha: "a".repeat(64) }, { worktree: wt.worktree })).toMatchObject({ ok: false })
    expect(nextStep(atCap, wt.worktree)).toMatchObject({ kind: "blocked" })
  })
})

// ---------------------------------------------------------------------------------------------- closure and restatement
describe("closure and restatement precede the spec", () => {
  test("a closure gap returns to question with an override recorded and the gap folded into the next question", async () => {
    const h = harness(happy({
      "di.interviewer.question": [q("Q1"), q("Q2"), q("Q3")],
      "di.scorer": [score(0.9, 0.8, 0.7, 0.6), score(1, 1, 1, 1), score(1, 1, 1, 1)],
      "di.closure": [closure(false, ["no acceptance coverage for core"]), closure(true)],
    }))
    const wf = beginLegacy(h)
    const result = await run(h, wf, makeIo({ answers: [answer(), answer(), answer()] }).io)
    expect(result.status).toBe("done")
    const d = dataNow()
    expect(d.closureOverrides).toEqual([{ round: 2, gaps: ["no acceptance coverage for core"] }])
    const third = h.seen.filter(item => item.promptId === "di.interviewer.question")[2]!
    expect(third.text).toContain("no acceptance coverage for core")
    expect(readEvents(wt.worktree, wf.id, SID).filter(event => event.type === "closure_result").map(event => (event.data as { pass: boolean }).pass)).toEqual([false, true])
  })

  test("Adjust wording re-runs the restatement with the note; Yes then crystallizes and writes spec.md", async () => {
    const h = harness(happy({ "di.restate": [restate("First wording."), restate("Second wording.")] }))
    const wf = begin(h)
    const io = makeIo({ answers: twoAnswers(), choices: [0, 1, 0], notes: ["say tests explicitly"] })
    const result = await run(h, wf, io.io)
    expect(result.status).toBe("done")
    const restates = h.seen.filter(item => item.promptId === "di.restate")
    expect(restates).toHaveLength(2)
    expect(restates[1]!.text).toContain("say tests explicitly")
    expect(restates[1]!.text).toContain("First wording.")
    const gate = io.log.chooses.filter(item => item.title.includes("same outcome"))
    expect(gate[0]!.title.startsWith("First wording.")).toBe(true)
    expect(gate[0]!.choices).toEqual(["Yes, crystallize", "Adjust wording", "Missing scope"])
    expect(dataNow().restatement?.goal).toBe("Second wording.")
    const types = eventTypes(wf.id)
    expect(types.indexOf("restatement_confirmed")).toBeLessThan(types.indexOf("spec_written"))
    expect(types.indexOf("closure_result")).toBeLessThan(types.indexOf("restatement_confirmed"))
  })

  test("Missing scope returns to questioning and the confirmed restatement is cleared", async () => {
    const h = harness(happy({
      "di.interviewer.question": [q("Q1"), q("Q2"), q("Q3")],
      "di.scorer": [score(0.9, 0.8, 0.7, 0.6), score(1, 1, 1, 1), score(1, 1, 1, 1)],
      "di.closure": [closure(), closure()], "di.restate": [restate(), restate()],
    }))
    const wf = beginLegacy(h)
    const result = await run(h, wf, makeIo({ answers: [answer(), answer(), answer()], choices: [0, 2, 0] }).io)
    expect(result.status).toBe("done")
    expect(eventTypes(wf.id)).toContain("restatement_missing_scope")
    expect(h.seen.filter(item => item.promptId === "di.interviewer.question")[2]!.text).toContain("missing scope")
  })

  test("the engine refuses a restatement before closure and a spec before the restatement", () => {
    harness({})
    const noClosure = seed(d => d, "restate", "planning", [{ n: 1, ambiguity: 0.04, band: "ready" }])
    expect(reduce(noClosure, { type: "restatement_confirmed", goal: "g", receiptRef: "r#" + "0".repeat(64) }, { worktree: wt.worktree })).toMatchObject({ ok: false, text: expect.stringContaining("closure") })
    const crystallize = { ...noClosure, stage: "crystallize" } as DeepInterviewWorkflow
    expect(reduce(crystallize, { type: "spec_written", path: specRelative(SID, noClosure.id), sha256: "0".repeat(64) }, { worktree: wt.worktree })).toMatchObject({ ok: false, text: expect.stringContaining("restatement") })
  })
})

describe("done requires a verified spec.md", () => {
  test("the spec carries path, final ambiguity, threshold and status; its hash is committed and re-verifiable", async () => {
    const h = harness(happy())
    const wf = begin(h)
    await run(h, wf, makeIo({ answers: twoAnswers() }).io)
    const final = committed()
    const ref = final.artifacts.find(item => item.key === "spec.md")!
    const bytes = readFileSync(join(wt.worktree, ref.path))
    expect(ref.sha256).toBe(sha256(bytes))
    expect(ref.path).toBe(specRelative(SID, wf.id))
    const text = bytes.toString("utf8")
    expect(text).toContain(`Spec path: ${ref.path}`)
    expect(text).toContain("Final Ambiguity Score: 0.0%")
    expect(text).toContain("Threshold: 0.2 (otter-agenda-default)")
    expect(text).toContain("Status: PASSED")
    expect(text).toContain("Early Exit: none")
    expect(text).toContain("Build it.")
    expect(dataNow().specRef).toEqual({ path: ref.path, sha256: ref.sha256! })
    expect(verifiedSpec(wt.worktree, final)).toMatchObject({ ok: true, sha256: ref.sha256 })
    const status = statusJson({ worktree: wt.worktree, config: DEFAULT_CONFIG, log() {} }, SID)
    expect(status.workflow).toMatchObject({ kind: "deep-interview", phase: "done" })
    expect(status.workflow?.artifacts[0]).toMatchObject({ key: "spec.md", state: "verified" })
    writeFileSync(join(wt.worktree, ref.path), "# edited\n")
    expect(verifiedSpec(wt.worktree, final)).toMatchObject({ ok: false, reason: "spec.md hash mismatch" })
    expect(statusJson({ worktree: wt.worktree, config: DEFAULT_CONFIG, log() {} }, SID).workflow?.artifacts[0]).toMatchObject({ state: "incomplete" })
  })

  test("a wrong hash, a missing file, a foreign path, or a spec edited before the commit is refused and the workflow stays at crystallize", async () => {
    const h = harness(happy())
    const wf = begin(h)
    await run(h, wf, makeIo({ answers: twoAnswers() }).io, { stopBefore: "crystallize" })
    const at = committed()
    expect(at.stage).toBe("crystallize")
    const rel = specRelative(SID, wf.id)
    const abs = join(wt.worktree, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, "# spec\n")
    const ctx = { worktree: wt.worktree }
    expect(reduce(at, { type: "spec_written", path: rel, sha256: "f".repeat(64) }, ctx)).toMatchObject({ ok: false, text: expect.stringContaining("hash mismatch") })
    expect(reduce(at, { type: "spec_written", path: ".otter/workflows/other/spec.md", sha256: sha256(Buffer.from("# spec\n")) }, ctx)).toMatchObject({ ok: false, text: expect.stringContaining("own spec.md") })
    rmSync(abs)
    expect(reduce(at, { type: "spec_written", path: rel, sha256: sha256(Buffer.from("# spec\n")) }, ctx)).toMatchObject({ ok: false, text: expect.stringContaining("missing") })
    // edit after the engine verified it but before the commit transaction: the in-transaction check refuses
    writeFileSync(abs, "# spec\n")
    const ok = reduce(at, { type: "spec_written", path: rel, sha256: sha256(Buffer.from("# spec\n")) }, ctx)
    expect(ok.ok).toBe(true)
    writeFileSync(abs, "# tampered\n")
    const outcome = commitDeepInterview(wt.worktree, at, () => ok)
    expect(outcome).toMatchObject({ ok: false, text: expect.stringContaining("hash mismatch") })
    expect(committed()).toMatchObject({ stage: "crystallize", phase: "planning" })
    // a done envelope that omits the artifact never commits, whatever wrote it
    expect(commitDeepInterview(wt.worktree, at, fresh => ({ ok: true, wf: { ...fresh, stage: "terminal", phase: "done" } as DeepInterviewWorkflow, events: [{ wf: fresh.id, type: "x", actor: "code" }], receipts: [] }))).toMatchObject({ ok: false, text: expect.stringContaining("required artifact spec.md") })
  })
})

// ---------------------------------------------------------------------------------------------- early exit
describe("early exit (/finish)", () => {
  test("refused before round 3; at round 3 above threshold it warns, records, and closure + restatement still run", async () => {
    const h = harness(happy({
      "di.interviewer.question": [q("Q1"), q("Q2"), q("Q3")],
      "di.scorer": [score(0.9, 0.8, 0.7, 0.6), score(0.9, 0.8, 0.7, 0.6)],
    }))
    const wf = beginLegacy(h)
    const io = makeIo({ answers: [{ kind: "finish" }, answer(), { kind: "finish" }, answer(), { kind: "finish" }, { kind: "finish" }], choices: [0, 1, 0, 0] })
    // rounds 1-2 refuse /finish; at round 3 the first /finish -> "Keep interviewing", the second -> Finish early; then restate Yes
    const result = await run(h, wf, io.io)
    expect(result.status).toBe("done")
    expect(io.log.notices.filter(text => text.includes("available from round 3"))).toHaveLength(2)
    const warn = io.log.chooses.filter(item => item.title.startsWith("Warning: ambiguity is 0.22"))
    expect(warn).toHaveLength(2)
    expect(warn[0]!.title).toContain("still runs the closure audit and the restatement")
    const d = dataNow()
    expect(d.earlyExit).toMatchObject({ round: 3, ambiguity: 0.22, reason: "finish" })
    const types = eventTypes(wf.id)
    expect(types.filter(type => type === "early_exit_confirmed")).toHaveLength(1)
    expect(types.indexOf("early_exit_confirmed")).toBeLessThan(types.indexOf("closure_result"))
    expect(types.indexOf("closure_result")).toBeLessThan(types.indexOf("restatement_confirmed"))
    expect(types.indexOf("restatement_confirmed")).toBeLessThan(types.indexOf("spec_written"))
    const spec = readFileSync(join(wt.worktree, specRelative(SID, wf.id)), "utf8")
    expect(spec).toContain("Status: BELOW_THRESHOLD_EARLY_EXIT")
    expect(spec).toContain("Early Exit: finish at round 3, ambiguity 22.0% above threshold")
    expect(h.ids().filter(id => id === "di.closure")).toHaveLength(1)
    expect(h.ids().filter(id => id === "di.restate")).toHaveLength(1)
  })

  test("early exit cannot bypass a pending panel, closure or approval; below-threshold and stuck states refuse", () => {
    harness({})
    const rounds = [{ n: 1, ambiguity: 0.2, band: "refined" }, { n: 2, ambiguity: 0.2, band: "refined" }, { n: 3, ambiguity: 0.2, band: "refined" }]
    const ready = seed(d => d, "answer", "planning", rounds)
    expect(earlyExitRefusal(ready)).toBeUndefined()
    for (const stage of ["panel", "scoring", "closure", "restate", "crystallize"] as const) {
      expect(earlyExitRefusal({ ...ready, stage, phase: stage === "panel" || stage === "closure" ? "reviewing" : "planning" } as DeepInterviewWorkflow)).toMatch(/cannot be bypassed/)
    }
    expect(earlyExitRefusal({ ...ready, phase: "stuck" } as DeepInterviewWorkflow)).toContain("stuck")
    expect(earlyExitRefusal({ ...ready, data: { ...dataOf(ready), round: 2 } } as DeepInterviewWorkflow)).toContain("round 3")
    const belowRounds = rounds.map(r => ({ ...r, ambiguity: 0.04 }))
    const below = { ...ready, data: { ...dataOf(ready), rounds: dataOf(ready).rounds.map((r, i) => ({ ...r, ambiguity: belowRounds[i]!.ambiguity })) } } as DeepInterviewWorkflow
    expect(earlyExitRefusal(below)).toContain("already at or below the threshold")
  })

  test("with a panel pending, closure is refused even after an early exit was recorded", () => {
    harness({})
    const rounds = [{ n: 1, ambiguity: 0.2, band: "refined" }, { n: 2, ambiguity: 0.2, band: "refined" }, { n: 3, ambiguity: 0.2, band: "refined" }]
    const wf = seed(d => ({ ...d, earlyExit: { round: 3, ambiguity: 0.2, reason: "finish", receiptRef: "r" }, pendingPanel: { round: 3, inputSha: "a".repeat(64), triggers: ["t"], personas: ["researcher"], ontology: false, results: {} } }), "closure", "reviewing", rounds)
    expect(reduce(wf, { type: "closure_result", pass: true, gaps: [], receiptRef: "r#" + "0".repeat(64) }, { worktree: wt.worktree })).toMatchObject({ ok: false, text: expect.stringContaining("required panel record") })
  })
})

// ---------------------------------------------------------------------------------------------- roles and boundary
describe("roles are read-only and typed", () => {
  test("every execution is a read-only role whose tools are within read/list/glob/grep/memory, and each stage uses its registered role", async () => {
    const h = harness(happy())
    const wf = begin(h)
    await run(h, wf, makeIo({ answers: twoAnswers() }).io)
    const expected: Record<string, string> = {
      "di.interviewer.topology": "interviewer", "di.interviewer.question": "interviewer", "di.scorer": "interviewer", "di.restate": "interviewer", "di.crystallize": "interviewer",
      "di.panel.researcher": "researcher", "di.panel.contrarian": "contrarian", "di.panel.simplifier": "simplifier", "di.closure": "architect",
    }
    expect(h.seen.length).toBeGreaterThan(8)
    for (const item of h.seen) {
      expect(item.role).toBe(expected[item.promptId]!)
      expect(kindAllowsRole("deep-interview", item.role)).toBe(true)
      expect(item.role).not.toBe("main")
      for (const tool of item.allowed) expect(["read", "list", "glob", "grep", "memory"]).toContain(tool)
      expect(item.allowed.length).toBeGreaterThan(0)
    }
  })

  test("scorer output carrying ambiguity, phase or approved is rejected; non-DI events are not allowed at any stage", () => {
    for (const key of ["ambiguity", "phase", "approved", "approval", "receipt", "artifacts"]) {
      expect(parseStageEventsFor(score(0.9, 0.8, 0.7, 0.6, { [key]: 1 }), "deep-interview", "scoring")).toMatchObject({ ok: false })
    }
    expect(parseStageEventsFor(j({ type: "verdict", verdict: "okay", findings: [] }), "deep-interview", "closure")).toMatchObject({ ok: false })
    expect(parseStageEventsFor(j({ type: "plan_doc", sections: [{ title: "t", body: "b" }] }), "deep-interview", "question")).toMatchObject({ ok: false })
    expect(parseStageEventsFor(q(), "deep-interview", "scoring")).toMatchObject({ ok: false })
  })

  test("a DI overflow summary runs as interviewer, never main", async () => {
    const huge = "x".repeat(15_300)
    const rounds: Array<{ n: number; ambiguity: number; band: string }> = []
    const h = harness(happy({ "di.summarize": ["short summary of the context"] }))
    // an oversized request makes the question prompt overflow the 24k budget; the single summarize retry must run as interviewer
    const big = seed(d => ({ ...d, request: huge }), "question", "planning", rounds)
    const result = await run(h, big, makeIo({ answers: [] }).io, { stopBefore: "scoring" })
    expect(["blocked", "awaiting", "stuck"]).toContain(result.status)
    const summaries = h.seen.filter(item => item.promptId === "di.summarize")
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    for (const item of summaries) expect(item.role).toBe("interviewer")
    expect(h.seen.some(item => item.role === "main")).toBe(false)
  })

  test("a main-role binding for the deep-interview kind throws before any host call", async () => {
    const h = harness({})
    const wf = begin(h)
    const { runWorkflowTurn } = await import("../src/workflows/turn.ts")
    await expect(runWorkflowTurn(h.runtime, {
      workflowID: wf.id, revision: wf.lastSeq, kind: "deep-interview", stage: "topology", role: "main", prompt: DEEP_INTERVIEW_SUMMARIZE_PROMPT,
      supervisorSessionID: SID, epoch: null, ownerInstance: wf.owner.instance,
    }, { title: "x", text: DEEP_INTERVIEW_SUMMARIZE_PROMPT.text, budget: { maxChars: 24_000, reserveChars: 8_000 }, label: "x", cancelCause: "x" })).rejects.toThrow("not schedulable")
    expect(h.seen).toHaveLength(0)
  })
})

describe("start and exclusivity", () => {
  test("starts one deep-interview with the fixed threshold and source; a second start is refused naming the occupant", () => {
    const h = harness({})
    const wf = begin(h)
    expect(dataOf(wf)).toMatchObject({ threshold: 0.2, thresholdSource: "otter-agenda-default", questionPolicy: { maxRounds: 12, maxPerAgenda: 2 }, round: 0 })
    expect(wf).toMatchObject({ kind: "deep-interview", stage: "topology", phase: "planning" })
    expect(startDeepInterview(h.runtime, SID, "again")).toMatchObject({ ok: false, text: expect.stringContaining(`deep-interview workflow ${wf.id} is active`) })
    expect(startDeepInterview(h.runtime, SID, "  ")).toMatchObject({ ok: false })
    expect(startDeepInterview(h.runtime, SID, "x".repeat(5000))).toMatchObject({ ok: false })
  })

  test("a held or unknown session cannot start one", () => {
    const h = harness({})
    expect(startDeepInterview(h.runtime, "ses_unattached", "x")).toMatchObject({ ok: false, text: expect.stringContaining("no live admission") })
  })

  test("nothing in a full interview touches the ledger or starts a queue", async () => {
    const h = harness(happy())
    const wf = begin(h)
    await run(h, wf, makeIo({ answers: twoAnswers() }).io)
    expect(readLedger(wt.worktree, SID).tasks).toHaveLength(0)
    expect(eventTypes(wf.id)).not.toContain("tasks_created")
    expect(eventTypes(wf.id)).not.toContain("approved")
    expect(committed().phase).toBe("done")
  })
})

// ---------------------------------------------------------------------------------------------- stop / resume
describe("stop semantics", () => {
  test("pause during a panel persona turn is pausing until quiescent, then paused at panel; resume re-runs only missing personas; cancel retains records", async () => {
    let pauseOnce = true
    const h = harness(happy({ "di.panel.contrarian": [finding("contrarian"), finding("contrarian")] }), {
      onRun(_request, promptId) {
        if (promptId === "di.panel.contrarian" && pauseOnce) {
          pauseOnce = false
          const stop = requestStop(h.runtime, SID, "pause", "user pause")
          expect(stop.result.ok).toBe(true)
          expect(committed().stopIntent?.kind).toBe("pause")
        }
      },
    })
    const wf = begin(h)
    const first = await run(h, wf, makeIo({ answers: twoAnswers() }).io)
    expect(first.status).toBe("stale")
    const paused = committed()
    expect(paused).toMatchObject({ phase: "paused", stage: "panel", pausedFrom: { stage: "panel", phase: "reviewing" } })
    const d = dataNow()
    expect(Object.keys(d.pendingPanel!.results)).toEqual(["researcher"])
    const researcherCalls = h.ids().filter(id => id === "di.panel.researcher").length
    // while paused nothing is dispatched
    expect((await run(h, paused, makeIo().io)).status).toBe("blocked")
    expect(h.ids().filter(id => id === "di.panel.researcher")).toHaveLength(researcherCalls)

    const outcome = await resumePaused(h.runtime, SID, paused.lastSeq, { preflight: async () => {}, fence: () => "f", choose: async () => true })
    expect(outcome.kind).toBe("resumed")
    expect(committed()).toMatchObject({ phase: "reviewing", stage: "panel", stopIntent: null })
    const rest = await run(h, committed(), makeIo({ answers: [] }).io)
    expect(rest.status).toBe("done")
    expect(h.ids().filter(id => id === "di.panel.researcher")).toHaveLength(1)
    expect(h.ids().filter(id => id === "di.panel.contrarian")).toHaveLength(2)
  })

  test("cancel keeps rounds, receipts and the spec directory and ends cancelled", async () => {
    const h = harness(happy())
    const wf = begin(h)
    await run(h, wf, makeIo({ answers: twoAnswers() }).io, { stopBefore: "closure" })
    const filesBefore = receiptFiles(wf.id)
    const stop = requestStop(h.runtime, SID, "cancel", "user cancel")
    expect(stop.result.ok).toBe(true)
    expect(committed()).toMatchObject({ phase: "cancelled", stage: "terminal" })
    expect(receiptFiles(wf.id)).toEqual(filesBefore)
    expect(existsSync(join(wt.worktree, roundFileRelative(SID, wf.id, 1, "answer")))).toBe(true)
    expect(existsSync(join(wt.worktree, specRelative(SID, wf.id)))).toBe(false)
    expect((await run(h, committed(), makeIo().io)).status).toBe("exited")
    expect(dataNow().round).toBe(2)
  })
})

describe("answers are bounded and user-sourced", () => {
  test("an empty or oversized answer is rejected with a notice and the question stays open", async () => {
    const h = harness(happy())
    const wf = begin(h)
    const io = makeIo({ answers: [answer("  "), answer("x".repeat(10_001)), answer("ok"), answer("ok")] })
    const result = await run(h, wf, io.io)
    expect(result.status).toBe("done")
    expect(io.log.notices.filter(text => text.includes("1-10000"))).toHaveLength(2)
    expect(dataNow().round).toBe(2)
  })

  test("Q/A text lives in files, not the snapshot; the snapshot stores hashes only", async () => {
    const h = harness(happy())
    const wf = begin(h)
    await run(h, wf, makeIo({ answers: [answer("SECRET-ANSWER-TEXT"), answer()] }).io)
    const root = stateRoot(wt.worktree)
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
    const snapshots = walk(root).filter(path => path.includes(`/workflows/${wf.id}/revisions/`) || path.endsWith("workflow.json"))
    expect(snapshots.length).toBeGreaterThan(3)
    for (const path of snapshots) expect(readFileSync(path, "utf8")).not.toContain("SECRET-ANSWER-TEXT")
    expect(readFileSync(join(wt.worktree, roundFileRelative(SID, wf.id, 1, "answer")), "utf8")).toBe("SECRET-ANSWER-TEXT")
    expect(Buffer.byteLength(readFileSync(snapshots.sort().at(-1)!, "utf8"))).toBeLessThan(64 * 1024)
  })
})

// ---------------------------------------------------------------------------------------------- completion evidence (critic fix)
describe("completion re-checks every panel and choice record (W1/W7)", () => {
  const roundOnePanel = (wid: string, persona: string) => join(receiptsDirectory(wt.worktree, SID, wid), receiptFiles(wid).find(name => name.includes(`panel-r1-${persona}`))!)

  async function toCrystallize(h: Harness) {
    const wf = begin(h)
    const result = await run(h, wf, makeIo({ answers: twoAnswers() }).io, { stopBefore: "crystallize" })
    expect(result.status).toBe("blocked")
    expect(committed()).toMatchObject({ stage: "crystallize", phase: "planning" })
    expect(dataNow().panels.map(panel => panel.round)).toEqual([2])
    return wf
  }

  for (const damage of ["delete", "tamper"] as const) test(`(a) a round panel record ${damage}d before crystallize refuses spec_written; no spec_written event`, async () => {
    {
      const h = harness(happy({ "di.interviewer.question": [q("Q1"), q("Q2")] }))
      const wf = await toCrystallize(h)
      const file = join(receiptsDirectory(wt.worktree, SID, wf.id), receiptFiles(wf.id).find(name => name.includes("panel-r2-contrarian"))!)
      if (damage === "delete") rmSync(file)
      else writeFileSync(file, readFileSync(file, "utf8").replace("SENTINEL-contrarian", "TAMPERED"))
      const current = committed()
      const written: DiEvent = { type: "spec_written", path: specRelative(SID, wf.id), sha256: "0".repeat(64) }
      writeFileSync(join(wt.worktree, specRelative(SID, wf.id)), "spec bytes\n")
      const sha = sha256(readFileSync(join(wt.worktree, specRelative(SID, wf.id))))
      const outcome = commitDeepInterview(wt.worktree, current, fresh => reduce(fresh, { ...written, sha256: sha } as DiEvent, { worktree: wt.worktree }))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.text).toMatch(/panel|evidence|receipt/)
      expect(committed()).toMatchObject({ stage: "crystallize", phase: "planning", lastSeq: current.lastSeq })
      expect(eventTypes(wf.id)).not.toContain("spec_written")
      // the driver never completes either: the panel receipt no longer verifies, so the commit is refused and the interview stays at crystallize
      const again = await run(h, current, makeIo().io)
      expect(again.status).toBe("stale")
      expect(again.reason).toMatch(/evidence|panel/)
      expect(committed()).toMatchObject({ stage: "crystallize", phase: "planning" })
      expect(eventTypes(wf.id)).not.toContain("spec_written")
    }
  })

  test("(a) the handoff predecessor check refuses a finished interview whose panel record was tampered", async () => {
    const h = harness(happy())
    const wf = await toCrystallize(h)
    // complete normally (preset not connected), keep the done envelope as the handoff predecessor
    const done = await run(h, committed(), makeIo().io)
    expect(done.status).toBe("done")
    const finished = committed()
    const file = join(receiptsDirectory(wt.worktree, SID, wf.id), receiptFiles(wf.id).find(name => name.includes("panel-r2-researcher"))!)
    writeFileSync(file, readFileSync(file, "utf8").replace("SENTINEL-researcher", "TAMPERED"))
    const before = readFileSync(join(stateRoot(wt.worktree), "sessions", SID, "workflow", "workflow.json"))
    const { handoffToRalplan } = await import("../src/workflows/ralplan-driver.ts")
    const refused = handoffToRalplan(h.runtime, SID, finished, "plan it", [{ wf: wf.id, type: "spec_written", actor: "code" as const }])
    expect(refused.ok).toBe(false)
    expect(readFileSync(join(stateRoot(wt.worktree), "sessions", SID, "workflow", "workflow.json")).equals(before)).toBe(true)
  })

  test("(b) after done, a tampered panel receipt makes verifiedSpec, the interview view, statusJson and the status line report incomplete", async () => {
    const h = harness(happy())
    const wf = begin(h)
    expect((await run(h, wf, makeIo({ answers: twoAnswers() }).io)).status).toBe("done")
    const finished = committed()
    expect(verifiedSpec(wt.worktree, finished)).toMatchObject({ ok: true })
    expect(deepInterviewView(finished, wt.worktree)).toMatchObject({ evidenceOk: true })
    const okStatus = statusJson(h.runtime, SID).workflow
    expect(okStatus?.review).toContain("spec verified")
    expect(okStatus?.review).toContain("threshold 0.2 (otter-agenda-default)")
    expect(okStatus?.review).toContain("records verified")
    const file = join(receiptsDirectory(wt.worktree, SID, wf.id), receiptFiles(wf.id).find(name => name.includes("panel-r2-simplifier"))!)
    writeFileSync(file, readFileSync(file, "utf8").replace("SENTINEL-simplifier", "TAMPERED"))
    expect(verifiedSpec(wt.worktree, finished)).toMatchObject({ ok: false, reason: expect.stringContaining("incomplete") })
    expect(deepInterviewView(finished, wt.worktree)).toMatchObject({ evidenceOk: false })
    expect(deepInterviewView(finished, wt.worktree).line).toContain("incomplete")
    const status = statusJson(h.runtime, SID).workflow
    expect(status?.kind).toBe("deep-interview")
    expect(status?.review).toContain("incomplete")
    expect(status?.review).toContain("spec incomplete")
    const { workflowStatusLine } = await import("../src/hosts/workflow-session.ts")
    expect(workflowStatusLine(wt.worktree, finished)).toContain("incomplete")
  })

  test("a deleted closure or restatement choice receipt also shows incomplete", async () => {
    const h = harness(happy())
    const wf = begin(h)
    await run(h, wf, makeIo({ answers: twoAnswers() }).io)
    const finished = committed()
    rmSync(join(receiptsDirectory(wt.worktree, SID, wf.id), receiptFiles(wf.id).find(name => name.includes("choice-restate"))!))
    expect(verifiedSpec(wt.worktree, finished)).toMatchObject({ ok: false })
  })
})

describe("attempt counts survive restarts", () => {
  test("a failed attempt is committed: an interrupted run followed by a fresh run gets only one more attempt before stuck", async () => {
    // topology fails once (garbage), then the run is stopped; a brand-new runDeepInterview call must not reset the count
    const h = harness({ "di.interviewer.topology": ["not json", "still not json"] })
    const wf = begin(h)
    const first = await run(h, wf, makeIo().io, { stopBefore: "topology" })
    expect(first.status).toBe("blocked")
    const aborted = new AbortController()
    let runs = 0
    const second = await runDeepInterview(h.runtime, SID, wf.id, makeIo().io, {
      signal: aborted.signal,
      onStep: () => { if (++runs === 2) aborted.abort() },
    }).catch(() => ({ status: "interrupted" }))
    expect(["interrupted", "awaiting", "blocked", "stale", "stuck"]).toContain(second.status)
    expect(dataNow().attempt).toMatchObject({ item: "topology", count: 1 })
    const third = await run(h, committed(), makeIo().io)
    expect(third.status).toBe("stuck")
    expect(h.ids().filter(id => id === "di.interviewer.topology")).toHaveLength(2)
    expect(eventTypes(wf.id).filter(type => type === "attempt_failed")).toHaveLength(1)
  })
})

describe("agenda policy integration", () => {
  test("answers each confirmed agenda once and retains scorer evidence through completion", async () => {
    const h = harness(happy({
      "di.interviewer.topology": [j({ type: "topology", project: "brownfield", components: [{ id: "core", description: "Core" }, { id: "ui", description: "UI" }] })],
      "di.scorer": [score(1, 1, 1, 1, { evidence: ["Core agreed"] }), score(1, 1, 1, 1, { evidence: ["UI agreed"] })],
    }))
    const wf = begin(h)
    const io = makeIo({ answers: twoAnswers() })
    expect((await run(h, wf, io.io)).status).toBe("done")
    expect(dataNow().rounds.map(r => r.agendaID)).toEqual(["core", "ui"])
    expect(dataNow().rounds.map(r => r.evidence)).toEqual([["Core agreed"], ["UI agreed"]])
    expect(agendaProgress(dataNow()).map(a => a.status)).toEqual(["ready", "ready"])
    expect(h.ids().filter(id => id === "di.interviewer.question")).toHaveLength(2)
    expect(h.ids()).toEqual(expect.arrayContaining(["di.closure", "di.restate", "di.crystallize"]))
    expect(io.log.chooses.some(item => item.choices.includes("Yes, crystallize"))).toBe(true)
    expect(readLedger(wt.worktree, SID).tasks).toHaveLength(0)
  })

  test("an unresolved agenda stops after two questions and explicit Exit produces no spec", async () => {
    const h = harness(happy({ "di.scorer": [score(0.6, 0.6, 0.6, 0.6), score(0.6, 0.6, 0.6, 0.6)] }))
    const wf = begin(h)
    const io = makeIo({ answers: twoAnswers(), choices: [0, 1] })
    expect((await run(h, wf, io.io)).status).toBe("exited")
    expect(dataNow().round).toBe(2)
    expect(h.ids().filter(id => id === "di.interviewer.question")).toHaveLength(2)
    expect(io.log.chooses.some(item => item.choices.includes("Exit the interview"))).toBe(true)
    expect(existsSync(join(wt.worktree, specRelative(SID, wf.id)))).toBe(false)
    expect(readLedger(wt.worktree, SID).tasks).toHaveLength(0)
  })

  test("finish after one scored round preserves ambiguity and still runs closure and restatement", async () => {
    const h = harness(happy({ "di.scorer": [score(0.6, 0.6, 0.6, 0.6)] }))
    const wf = begin(h)
    const io = makeIo({ answers: [answer(), { kind: "finish" }], choices: [0, 0, 0] })
    expect((await run(h, wf, io.io)).status).toBe("done")
    expect(dataNow().earlyExit).toMatchObject({ ambiguity: 0.4, reason: "finish" })
    expect(finalAmbiguity(dataNow())).toBe(0.4)
    expect(h.ids()).toEqual(expect.arrayContaining(["di.closure", "di.restate"]))
    expect(io.log.chooses.some(item => item.choices.includes("Yes, crystallize"))).toBe(true)
    expect(readLedger(wt.worktree, SID).tasks).toHaveLength(0)
  })

  test("repeated closure gaps cannot ask a third question or silently approve a spec", async () => {
    const h = harness(happy({
      "di.scorer": [score(1, 1, 1, 1), score(1, 1, 1, 1)],
      "di.closure": [closure(false, ["Missing core acceptance"]), closure(false, ["Still missing core acceptance"])],
    }))
    const wf = begin(h)
    const io = makeIo({ answers: twoAnswers(), choices: [0, 1] })
    expect((await run(h, wf, io.io)).status).toBe("exited")
    expect(dataNow().round).toBe(2)
    expect(h.ids().filter(id => id === "di.interviewer.question")).toHaveLength(2)
    expect(h.ids()).not.toContain("di.crystallize")
    expect(existsSync(join(wt.worktree, specRelative(SID, wf.id)))).toBe(false)
  })
})

test("the total question budget preserves unanswered agenda ambiguity in an explicitly crystallized spec", async () => {
  const components = Array.from({ length: 13 }, (_, i) => ({ id: `item-${i}`, description: `Agenda ${i}` }))
  const h = harness(happy({
    "di.interviewer.topology": [j({ type: "topology", project: "brownfield", components })],
    "di.interviewer.question": Array.from({ length: 12 }, (_, i) => q(`Question for agenda ${i}?`)),
    "di.scorer": Array.from({ length: 12 }, () => score(1, 1, 1, 1)),
  }))
  const wf = begin(h)
  const io = makeIo({ answers: Array.from({ length: 12 }, () => answer()), choices: [0, 0, 0] })
  expect((await run(h, wf, io.io)).status).toBe("done")
  expect(dataNow().round).toBe(12)
  expect(h.ids().filter(id => id === "di.interviewer.question")).toHaveLength(12)
  expect(dataNow().cap).toMatchObject({ round: 12, ambiguity: 1, decided: true })
  expect(agendaProgress(dataNow()).at(-1)).toMatchObject({ id: "item-12", asked: 0, status: "pending" })
  const spec = readFileSync(join(wt.worktree, specRelative(SID, wf.id)), "utf8")
  expect(spec).toContain("Final Ambiguity Score: 100.0%")
  expect(spec).toContain("Status: ROUND_CAP_EXIT")
  expect(io.log.chooses.some(item => item.choices.includes("Crystallize with current clarity"))).toBe(true)
  expect(io.log.chooses.some(item => item.choices.includes("Yes, crystallize"))).toBe(true)
  expect(readLedger(wt.worktree, SID).tasks).toHaveLength(0)
})

test("a repeated normalized agenda question is rejected before it reaches the user", async () => {
  const h = harness(happy({
    "di.interviewer.question": [q("What must ship?"), q("  WHAT must ship!!!  "), q("What MUST ship.")],
    "di.scorer": [score(0.6, 0.6, 0.6, 0.6)],
  }))
  const wf = begin(h)
  const io = makeIo({ answers: [answer()] })
  expect((await run(h, wf, io.io)).status).toBe("stuck")
  expect(io.log.questions).toEqual(["What must ship?"])
  expect(dataNow().round).toBe(1)
  expect(dataNow().rounds[0]!.questionKey).toBe("what must ship")
  expect(h.ids().filter(id => id === "di.interviewer.question")).toHaveLength(3)
  expect(h.ids()).not.toContain("di.closure")
})

test("long retained evidence across four agendas stays within every turn's conversation budget", async () => {
  const components = Array.from({ length: 4 }, (_, i) => ({ id: `agenda-${i}`, description: `Agenda ${i}` }))
  const evidence = Array.from({ length: 8 }, (_, i) => `${i}:` + "e".repeat(498))
  const h = harness(happy({
    "di.interviewer.topology": [j({ type: "topology", project: "brownfield", components })],
    "di.interviewer.question": components.map(c => q(`What must ${c.id} deliver?`)),
    "di.scorer": components.map(() => score(1, 1, 1, 1, { evidence })),
  }))
  const wf = begin(h)
  expect((await run(h, wf, makeIo({ answers: components.map(() => answer()) }).io)).status).toBe("done")
  expect(dataNow().rounds.map(r => r.evidence)).toEqual(components.map(() => evidence))
  expect(h.ids()).toEqual(expect.arrayContaining(["di.closure", "di.restate", "di.crystallize"]))
  for (const request of h.seen) expect(request.text.length).toBeLessThanOrEqual(16_000)
  const finalQuestion = h.seen.filter(item => item.promptId === "di.interviewer.question").at(-1)!
  expect(finalQuestion.text).toContain("RECORDED EVIDENCE")
  expect(finalQuestion.text).toContain("Round 1, agenda agenda-0:")
  expect(finalQuestion.text).not.toContain(evidence[0]!)
})

test("older answer excerpts retain final decisions without promising protected artifact access", async () => {
  const firstAnswer = "Existing behavior: keep compatibility. " + "background detail ".repeat(130) + "Final decision: export only filtered rows."
  const h = harness(happy())
  const wf = begin(h)
  expect((await run(h, wf, makeIo({ answers: [answer(firstAnswer), answer("Use CSV.")] }).io)).status).toBe("done")
  const secondScore = h.seen.filter(item => item.promptId === "di.scorer")[1]!
  expect(secondScore.text).toContain("Existing behavior: keep compatibility.")
  expect(secondScore.text).toContain("Final decision: export only filtered rows.")
  expect(secondScore.text).toContain("[... middle omitted ...]")
  expect(secondScore.text).toContain("Full records are protected and not available through file tools")
  expect(secondScore.text).not.toContain("inspect before re-asking")
  const stored = readFileSync(join(wt.worktree, roundFileRelative(SID, wf.id, 1, "answer")), "utf8")
  expect(stored).toBe(firstAnswer)
  expect(dataNow().rounds[0]!.answerSha).toBe(sha256Text(stored))
})

test("closure reopens only the identified ready agenda and persists that target before resume", async () => {
  const h = harness(happy({
    "di.interviewer.topology": [j({ type: "topology", project: "brownfield", components: [{ id: "a", description: "First task" }, { id: "b", description: "Second task" }] })],
    "di.interviewer.question": [q("Define A"), q("Define B"), q("Complete B acceptance")],
    "di.scorer": [score(1, 1, 1, 1), score(1, 1, 1, 1), score(1, 1, 1, 1)],
    "di.closure": [closure(false, ["B acceptance incomplete"], ["b"]), closure()],
  }))
  const wf = begin(h)
  // With no third answer the targeted question remains committed, then a fresh driver invocation resumes it.
  expect((await run(h, wf, makeIo({ answers: twoAnswers() }).io)).status).toBe("awaiting")
  expect(dataNow().reopenAgendaIDs).toEqual(["b"])
  expect(dataNow().rounds.map(r => r.agendaID)).toEqual(["a", "b", "b"])
  const resumed = makeIo({ answers: [answer()] })
  expect((await run(h, committed(), resumed.io)).status).toBe("done")
  expect(resumed.log.questions).toEqual(["Complete B acceptance"])
  expect(agendaProgress(dataNow()).map(a => a.asked)).toEqual([1, 2])
  expect(h.ids().filter(id => id === "di.interviewer.question")).toHaveLength(3)
  expect(dataNow().closure?.pass).toBe(true)
})

describe("closure agenda targets are required for new interviews", () => {
  for (const [name, target] of [["missing", undefined], ["empty", []], ["unknown", ["foreign"]]] as const) {
    test(`${name} target refuses failed closure without asking another agenda or writing a spec`, async () => {
      const invalid = j({ type: "closure", pass: false, gaps: ["Acceptance incomplete"], ...(target === undefined ? {} : { agenda_ids: target }) })
      const h = harness(happy({ "di.scorer": [score(1, 1, 1, 1)], "di.closure": [invalid, invalid] }))
      const wf = begin(h)
      const io = makeIo({ answers: [answer()] })
      expect((await run(h, wf, io.io)).status).toBe("stuck")
      expect(committed().stage).toBe("closure")
      expect(io.log.questions).toEqual(["Q1"])
      expect(dataNow().round).toBe(1)
      expect(h.ids()).not.toContain("di.crystallize")
      expect(existsSync(join(wt.worktree, specRelative(SID, wf.id)))).toBe(false)
    })
  }
})
