import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import type { ExecutionHost, ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { readCommitted } from "../src/workflows/commit.ts"
import { startDeepInterview, runDeepInterview, type DiIo } from "../src/workflows/deep-interview-driver.ts"
import { startRalplan, runRalplan } from "../src/workflows/ralplan-driver.ts"
import { startUltragoal, runUltragoal } from "../src/workflows/ultragoal-driver.ts"
import { startAutoresearch, runAutoresearch } from "../src/workflows/autoresearch-driver.ts"
import { DEEP_INTERVIEW_PROMPTS, RALPLAN_PROMPTS, ULTRAGOAL_PROMPTS, AUTORESEARCH_PROMPTS } from "../src/workflows/prompts/index.ts"

const model = process.env.OTTER_WORKFLOW_ACTUAL_MODEL || "llama3.2:3b"
const out = process.env.OTTER_WORKFLOW_ACTUAL_OUT || ""
const controls = Object.fromEntries(["boundedInput", "boundedOutput", "preExecutionToolPolicy", "headlessPermissionRefusal", "ownedCancellation", "quiescenceEvidence", "identityBinding", "noReplayRecovery", "readOnlyWorktree", "serialWorkerLease"].map(k => [k, "supported" as const]))
const prompts = new Map([...DEEP_INTERVIEW_PROMPTS, ...RALPLAN_PROMPTS, ...ULTRAGOAL_PROMPTS, ...AUTORESEARCH_PROMPTS].map(p => [p.text, p.id]))
const generated: Record<string, string> = {}

function jsonFromModel(id: string, schema: string): string {
  const prompt = `Return exactly one minified JSON object and no markdown. Schema/example: ${schema}`
  const raw = execFileSync("ollama", ["run", model, "--think=false", "--nowordwrap"], { input: prompt, encoding: "utf8", timeout: 180_000, maxBuffer: 2_000_000 })
  const start = raw.indexOf("{"); const end = raw.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error(`model ${model} produced no JSON for ${id}: ${raw.slice(0, 200)}`)
  const text = raw.slice(start, end + 1)
  JSON.parse(text)
  generated[id] = text
  return text
}
const stage = {
  topology: jsonFromModel("di.interviewer.topology", '{"type":"topology","project":"brownfield","components":[{"id":"core","description":"core engine"}]}'),
  question: jsonFromModel("di.interviewer.question", '{"type":"question","text":"What should the tiny feature prove?"}'),
  score: jsonFromModel("di.scorer", '{"type":"score","goal":1,"constraints":1,"criteria":1,"context":1,"weakest":"goal","evidence":["clear"]}'),
  spec: jsonFromModel("di.crystallize", '{"type":"message","text":"## Goal\\nBuild a tiny fixture.\\n## Acceptance Criteria\\n- Evidence is recorded."}'),
  plan: jsonFromModel("ralplan.planner", '{"type":"plan_doc","sections":[{"title":"Goal","body":"Record tiny evidence and verify it with a focused smoke."}]}'),
  architect: jsonFromModel("ralplan.architect", '{"type":"lane_verdict","status":"CLEAR","decision":"APPROVE","findings":[]}'),
  critic: jsonFromModel("critic", '{"type":"lane_verdict","verdict":"OKAY","findings":[]}'),
  goals: jsonFromModel("ug.decompose", '{"type":"goals","goals":[{"title":"Evidence","objective":"Verify README exists."}]}'),
  unit: jsonFromModel("ug.unit_plan", '{"type":"unit_plan","steps":[{"title":"Check README","files":["README.md"],"detail":"Verify the seed file exists.","verify":"sh check_smoke.sh"}],"risks":["none"]}'),
  mission: jsonFromModel("ar.intake", '{"type":"mission","goal":"Measure fixture score.","metric":"score","direction":"max"}'),
  hypothesis: jsonFromModel("ar.hypothesis", '{"type":"hypothesis","hypotheses":["The fixture script reports score."]}'),
  evidence: jsonFromModel("ar.evidence", '{"type":"evidence","items":[{"path":"README.md","note":"seed file"}]}'),
  experiment: jsonFromModel("ar.experiment", '{"type":"experiment","commands":["sh check_metric.sh"],"params":{}}'),
}
const script: Record<string, string[]> = {
  "di.interviewer.topology": [stage.topology],
  "di.interviewer.question": [stage.question],
  "di.scorer": [stage.score],
  "di.crystallize": [stage.spec],
  "ralplan.planner": [stage.plan],
  "ralplan.architect": [stage.architect],
  "ralplan.critic": [stage.critic],
  "ug.decompose": [stage.goals],
  "ug.unit_plan": [stage.unit],
  "ug.unit_review": [stage.critic],
  "ar.intake": [stage.mission],
  "ar.hypothesis": [stage.hypothesis],
  "ar.evidence": [stage.evidence],
  "ar.experiment": [stage.experiment],
}
function tempWorktree(name: string) { const dir = mkdtempSync(join(tmpdir(), `otter-actual-${name}-`)); writeFileSync(join(dir, "README.md"), `${name}\n`); writeFileSync(join(dir, "check_smoke.sh"), "test -f README.md\n"); writeFileSync(join(dir, "check_metric.sh"), "echo METRIC score=1\n"); return realpathSync(dir) }
function runtime(worktree: string, sid: string): { rt: ExecutionRuntime; seen: string[] } {
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]))
  const seen: string[] = []
  const host: ExecutionHost = {
    identity: { engine: "local" as never, profile: "code" },
    async preflight() { return { compatible: true, controls, problems: [] } },
    async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "actual model replay fixture" } },
    async prepare(request: ExecutionRequest) {
      return { reference: { executionID: request.executionID }, async run(): Promise<ExecutionOutcome> {
        const id = [...prompts].find(([text]) => request.text.startsWith(text))?.[1] ?? "unknown"
        seen.push(id)
        const text = queues[id]?.shift()
        return text === undefined ? { status: "failed", error: `missing generated output for ${id}` } : { status: "completed", text }
      }, async requestCancel() { return { requested: true, acknowledged: true, terminal: true, quiescent: true } }, async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "actual model replay child" } } }
    },
  }
  const rt = createExecutionRuntime({ directory: worktree, worktree, config: structuredClone(DEFAULT_CONFIG), log() {} }, () => host, { planningOnlyMain: true })
  attachAdmission(rt, sid, { engine: "local", model })
  return { rt, seen }
}
async function main() {
  const results: Record<string, unknown> = {}
  { const worktree = tempWorktree("di"), sid = "actual-di", { rt, seen } = runtime(worktree, sid); const st = startDeepInterview(rt, sid, "clarify smoke"); if (!st.ok) throw new Error(st.text); const io: DiIo = { async choose() { return 0 }, async readAnswer() { return undefined }, async readNote() { return undefined } }; const r = await runDeepInterview(rt, sid, st.wf.id, io, { stopBefore: "question" }); results["deep-interview"] = { status: r.status, seen, committed: readCommitted(worktree).state }; stopHeartbeat() }
  { const worktree = tempWorktree("ral"), sid = "actual-ral", { rt, seen } = runtime(worktree, sid); const st = startRalplan(rt, sid, "plan smoke"); if (!st.ok) throw new Error(st.text); const r = await runRalplan(rt, sid, st.wf.id); results.ralplan = { status: r.status, seen, committed: readCommitted(worktree).state }; stopHeartbeat() }
  { const worktree = tempWorktree("ug"), sid = "actual-ug", { rt, seen } = runtime(worktree, sid); const st = startUltragoal(rt, sid, "goal smoke"); if (!st.ok) throw new Error(st.text); const r = await runUltragoal(rt, { async runApprovedUnit() { throw new Error("approval not part of smoke") } }, sid, st.wf.id); results.ultragoal = { status: r.status, seen, committed: readCommitted(worktree).state }; stopHeartbeat() }
  { const worktree = tempWorktree("ar"), sid = "actual-ar", { rt, seen } = runtime(worktree, sid); const st = startAutoresearch(rt, sid, "research smoke"); if (!st.ok) throw new Error(st.text); const r = await runAutoresearch(rt, sid, st.wf.id); results.autoresearch = { status: r.status, seen, committed: readCommitted(worktree).state }; stopHeartbeat() }
  const summary = { schemaVersion: 1, model, generated, results, ok: true, at: new Date().toISOString() }
  if (out) { mkdirSync(join(out, ".."), { recursive: true }); writeFileSync(out, JSON.stringify(summary, null, 2) + "\n") }
  console.log(JSON.stringify(summary, null, 2))
}
main().catch(error => { const summary = { schemaVersion: 1, model, generated, ok: false, error: error.stack || String(error), at: new Date().toISOString() }; if (out) { mkdirSync(join(out, ".."), { recursive: true }); writeFileSync(out, JSON.stringify(summary, null, 2) + "\n") } console.error(summary.error); process.exit(1) })
