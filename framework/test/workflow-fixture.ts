// Deterministic scripted host for the planning workflows: replies per (prompt id, call order) and records every request.
// Used by the handoff, boundary and interactive tests; no live model.
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ExecutionHost, ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { AUTORESEARCH_PROMPTS, DEEP_INTERVIEW_PROMPTS, RALPLAN_PROMPTS, ULTRAGOAL_PROMPTS } from "../src/workflows/prompts/index.ts"

export const WORKFLOW_CONTROLS = Object.fromEntries([
  "boundedInput", "boundedOutput", "preExecutionToolPolicy", "headlessPermissionRefusal",
  "ownedCancellation", "quiescenceEvidence", "identityBinding", "noReplayRecovery",
  "readOnlyWorktree", "serialWorkerLease",
].map(key => [key, "supported" as const]))

const j = (value: unknown) => JSON.stringify(value)
export const stage = {
  topology: j({ type: "topology", project: "brownfield", components: [{ id: "core", description: "the core engine" }] }),
  question: (text = "What exactly must it do?") => j({ type: "question", text }),
  score: (goal: number, constraints: number, criteria: number, context: number) =>
    j({ type: "score", goal, constraints, criteria, context, weakest: "goal", evidence: ["e"] }),
  finding: (persona: string) => j({ type: "panel_finding", finding: `finding-${persona}`, rationale: ["because"], suggested_options: ["option"], confidence: "high" }),
  closure: j({ type: "closure", pass: true, gaps: [] }),
  restate: j({ type: "restatement", goal: "Build the engine with tests." }),
  spec: j({ type: "message", text: "## Goal\nBuild it.\n## Acceptance Criteria\n- tests pass" }),
  plan: j({ type: "plan_doc", sections: [{ title: "Goal", body: "Do the thing with tests." }, { title: "Risks", body: "Few." }] }),
  architect: j({ type: "lane_verdict", status: "CLEAR", decision: "APPROVE", findings: [] }),
  critic: j({ type: "lane_verdict", verdict: "OKAY", findings: [] }),
  goals: j({ type: "goals", goals: [{ title: "One", objective: "Make the fixture pass with one check." }] }),
  unitPlan: j({ type: "unit_plan", steps: [{ title: "Fixture step", files: ["README.md"], detail: "Keep the fixture file valid.", verify: "sh check.sh" }], risks: ["small"] }),
  mission: j({ type: "mission", goal: "Measure the fixture", metric: "score", direction: "max" }),
  hypothesis: j({ type: "hypothesis", hypotheses: ["The fixture command reports score."] }),
  evidence: j({ type: "evidence", items: [{ path: "README.md", note: "fixture file" }] }),
  experiment: j({ type: "experiment", commands: ["sh check_metric.sh"], params: {} }),
}

/** Two answered rounds: round 1 scores .22, round 2 scores 0 (a band change, so one researcher/contrarian/simplifier panel). */
export function fullScript(): Record<string, string[]> {
  return {
    "di.interviewer.topology": [stage.topology],
    "di.interviewer.question": [stage.question("Q1"), stage.question("Q2")],
    "di.scorer": [stage.score(0.9, 0.8, 0.7, 0.6), stage.score(1, 1, 1, 1)],
    "di.panel.researcher": [stage.finding("researcher")],
    "di.panel.contrarian": [stage.finding("contrarian")],
    "di.panel.simplifier": [stage.finding("simplifier")],
    "di.closure": [stage.closure],
    "di.restate": [stage.restate],
    "di.crystallize": [stage.spec],
    "ralplan.planner": [stage.plan],
    "ralplan.architect": [stage.architect],
    "ralplan.critic": [stage.critic],
    "ug.decompose": [stage.goals],
    "ug.unit_plan": [stage.unitPlan],
    "ug.unit_review": [stage.critic],
    "ug.final_review": [stage.critic],
    "ar.intake": [stage.mission],
    "ar.hypothesis": [stage.hypothesis],
    "ar.evidence": [stage.evidence],
    "ar.experiment": [stage.experiment],
    "ar.evaluate": [stage.critic],
  }
}

export type Seen = { role: string; promptId: string; text: string }

export function scriptedHost(script: Record<string, string[]>, engine = "local"): { host: ExecutionHost; seen: Seen[]; queues: Record<string, string[]> } {
  const queues: Record<string, string[]> = Object.fromEntries(Object.entries(script).map(([id, list]) => [id, [...list]]))
  const seen: Seen[] = []
  const prompts = new Map([...DEEP_INTERVIEW_PROMPTS, ...RALPLAN_PROMPTS, ...ULTRAGOAL_PROMPTS, ...AUTORESEARCH_PROMPTS].map(prompt => [prompt.text, prompt.id]))
  const host: ExecutionHost = {
    identity: { engine: engine as never, profile: "legacy-unowned" },
    async preflight() { return { compatible: true, controls: WORKFLOW_CONTROLS, problems: [] } },
    async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "scripted host has no recovery" } },
    async prepare(request: ExecutionRequest) {
      let done = false
      return {
        reference: { executionID: request.executionID },
        async run(): Promise<ExecutionOutcome> {
          const promptId = [...prompts].find(([text]) => request.text.startsWith(text))?.[1] ?? "unknown"
          seen.push({ role: request.role, promptId, text: request.text })
          const next = queues[promptId]?.shift()
          done = true
          if (next === undefined) return { status: "failed", error: `script exhausted for ${promptId}` }
          return { status: "completed", text: next }
        },
        async requestCancel() { done = true; return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
        async reconcile() { return { outcome: done ? "terminal" : "unknown", quiescent: done, evidence: "scripted owned handle" } },
      }
    },
  }
  return { host, seen, queues }
}

export function scriptedRuntime(worktree: string, script: Record<string, string[]>, engine = "local") {
  const scripted = scriptedHost(script, engine)
  const runtime: ExecutionRuntime = createExecutionRuntime({
    directory: worktree, worktree, config: structuredClone(DEFAULT_CONFIG), log() {},
  }, () => scripted.host, { planningOnlyMain: true })
  return { runtime, ...scripted }
}
