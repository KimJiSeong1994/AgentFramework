import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { readLedger } from "../src/state/ledger.ts"
import { readCommitted } from "../src/workflows/commit.ts"
import { startDeepInterview, runDeepInterview, verifiedSpec, type DiIo } from "../src/workflows/deep-interview-driver.ts"
import { handoffToRalplan, retryRalplan, runRalplan } from "../src/workflows/ralplan-driver.ts"
import { startUltragoal, runUltragoal, approveUnit, type UnitController } from "../src/workflows/ultragoal-driver.ts"
import { approveUnitConfirmation, ultragoalDataOf } from "../src/workflows/ultragoal.ts"
import { startAutoresearch, runAutoresearch, approveExperiment, finishAutoresearch, productifyAutoresearch } from "../src/workflows/autoresearch-driver.ts"
import { autoresearchDataOf, runConfirmation } from "../src/workflows/autoresearch.ts"
import type { ExecutionRuntime } from "../src/hosts/types.ts"
import type { DeepInterviewWorkflow, RalplanWorkflow, WorkflowEnvelope } from "../src/workflows/types.ts"
import { createForegroundController } from "../src/hosts/controller.ts"

const rawEngine = process.env.OTTER_WORKFLOW_LIVE_ENGINE || "local"
if (rawEngine !== "local" && rawEngine !== "codex" && rawEngine !== "claude") throw new Error(`invalid live engine ${rawEngine}`)
const engine = rawEngine
const model = process.env.OTTER_WORKFLOW_LIVE_MODEL || "qwen3.6:35b-a3b-coding-mtp-q4_K_M"
const out = process.env.OTTER_WORKFLOW_LIVE_OUT || ""
const smokes = (process.env.OTTER_WORKFLOW_LIVE_SMOKES || "deep-interview,ralplan,ultragoal,autoresearch").split(",").map(s => s.trim()).filter(Boolean)
const attemptsPerSmoke = Math.max(1, Math.min(5, Number(process.env.OTTER_WORKFLOW_LIVE_RETRIES || (engine === "local" ? "3" : "1")) || 1))

type Smoke = { name: string; ok: boolean; worktree: string; evidence: Record<string, unknown>; error?: string }
type Attempt = { attempt: number; ok: boolean; worktree: string; status: string; error?: string }
const results: Smoke[] = []

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function committedWorkflow(evidence: Record<string, unknown>): Record<string, unknown> | undefined {
  const committed = recordOf(evidence.committed)
  return recordOf(committed?.wf)
}
function workflowData(evidence: Record<string, unknown>): Record<string, unknown> | undefined {
  return recordOf(committedWorkflow(evidence)?.data)
}
function workflowSummary(wf: WorkflowEnvelope): Record<string, unknown> {
  return {
    id: wf.id, kind: wf.kind, stage: wf.stage, phase: wf.phase, revision: wf.lastSeq,
    artifacts: wf.artifacts, ...(wf.lineage ? { lineage: wf.lineage } : {}), data: "data" in wf ? wf.data : {},
  }
}
function evidenceStatus(name: string, evidence: Record<string, unknown>): string {
  if (name === "deep-interview" || name === "ralplan" || name === "autoresearch") return String(evidence.result ?? "unknown")
  if (name === "ultragoal") return String(evidence.result ?? "unknown")
  return "unknown"
}
function smokeOk(name: string, evidence: Record<string, unknown>): boolean {
  if (name === "deep-interview") {
    const predecessor = recordOf(evidence.predecessor)
    const successor = recordOf(evidence.successor)
    const lineage = recordOf(successor?.lineage)
    const parent = recordOf(lineage?.predecessor)
    const spec = recordOf(evidence.spec)
    const personas = Array.isArray(evidence.panelPersonas) ? evidence.panelPersonas : []
    return evidence.result === "handed_off" && predecessor?.kind === "deep-interview" &&
      predecessor.stage === "terminal" && predecessor.phase === "done" && successor?.kind === "ralplan" &&
      parent?.id === predecessor.id && spec?.ok === true && typeof spec.path === "string" &&
      typeof spec.sha256 === "string" && ["researcher", "contrarian", "simplifier"].every(persona => personas.includes(persona))
  }
  if (name === "ralplan") {
    const wf = committedWorkflow(evidence)
    const data = workflowData(evidence)
    const consensus = recordOf(data?.consensus)
    return (evidence.result === "pending_execution" || evidence.result === "done") &&
      (wf?.stage === "pending_execution" || wf?.stage === "terminal") && typeof consensus?.ref === "string" &&
      evidence.ledgerTasks === 0 && !data?.stuck
  }
  if (name === "ultragoal") {
    const wf = committedWorkflow(evidence)
    const data = workflowData(evidence)
    const ledger = Array.isArray(evidence.ledger) ? evidence.ledger : []
    const goals = recordOf(data?.goals)
    const progress = recordOf(data?.progress)
    const goalIds = Array.isArray(goals?.ids) ? goals.ids : []
    const approvals = Array.isArray(evidence.approvals) ? evidence.approvals : []
    return evidence.result === "done" && wf?.stage === "terminal" && wf.phase === "done" &&
      goalIds.length === 2 && approvals.length === 2 && goalIds.every(id => typeof id === "string" && typeof recordOf(progress?.[id])?.lastCheckpoint === "string") &&
      ledger.length === 2 && ledger.every(status => status === "done") && !data?.stuck
  }
  if (name === "autoresearch") {
    const predecessor = recordOf(evidence.predecessor)
    const successor = recordOf(evidence.successor)
    const predecessorData = recordOf(predecessor?.data)
    const verdict = recordOf(predecessorData?.verdict)
    const runs = Array.isArray(predecessorData?.runs) ? predecessorData.runs.map(recordOf).filter(Boolean) : []
    const lineage = recordOf(successor?.lineage)
    const lineagePredecessor = recordOf(lineage?.predecessor)
    const artifact = recordOf(lineagePredecessor?.artifact)
    return evidence.result === "choice" && evidence.productify === true && successor?.kind === "deep-interview" &&
      lineagePredecessor?.kind === "autoresearch" && runs.length >= 2 && runs.every(run => run?.valid === true && typeof run.receiptRef === "string") &&
      typeof verdict?.path === "string" && typeof verdict.sha256 === "string" && typeof verdict.status === "string" &&
      typeof artifact?.path === "string" && typeof artifact?.sha256 === "string"
  }
  return false
}
function tempWorktree(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `otter-live-${name}-`))
  execFileSync("git", ["init", "--quiet"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "Workflow live smoke"], { cwd: dir })
  execFileSync("git", ["config", "user.email", "workflow-live@localhost"], { cwd: dir })
  writeFileSync(join(dir, "README.md"), `# ${name}\n`)
  execFileSync("git", ["add", "README.md"], { cwd: dir })
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "seed"], { cwd: dir })
  return realpathSync(dir)
}
function commitFixture(worktree: string, files: string[]) {
  execFileSync("git", ["add", ...files], { cwd: worktree })
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "add live smoke fixtures"], { cwd: worktree })
}
function runtime(worktree: string, sid: string): ExecutionRuntime {
  const rt = createCliRuntime({ worktree, engine, model })
  attachAdmission(rt, sid, { engine, model })
  return rt
}
const io: DiIo = {
  async choose() { return 0 },
  async readAnswer(prompt) {
    if (prompt.round >= 3) return { kind: "finish" }
    return {
      kind: "answer",
      text: prompt.round === 1
        ? "This changes the system shape: use a separate pure greeting formatter called by the Bun TypeScript CLI. It prints exactly `Hello, smoke!` to stdout, exits 0, writes nothing else, and is verified by a focused shell test."
        : "Acceptance is exact stdout bytes `Hello, smoke!\\n`, exit code 0, no stderr, no file writes, and one deterministic test covering those observations.",
    }
  },
  async readNote() { return "Keep the topology limited to the CLI entry point and its focused verification." },
}

type InterviewPlanPipeline = {
  worktree: string
  sid: string
  runtime: ExecutionRuntime
  predecessor: DeepInterviewWorkflow
  successor: RalplanWorkflow
  spec: { ok: true; path: string; sha256: string }
}
let interviewPlanPipeline: InterviewPlanPipeline | undefined

async function smokeDeepInterview() {
  const worktree = tempWorktree("di"); const sid = "live-di"; const rt = runtime(worktree, sid)
  const started = startDeepInterview(rt, sid,
    "Clarify a tiny Bun TypeScript CLI greeting fixture. It must print exactly `Hello, smoke!` plus one newline to stdout, exit 0, emit no stderr, make no file changes at runtime, and have a deterministic focused shell test. Keep scope to the CLI entry point and test.")
  if (!started.ok) throw new Error(started.text)
  let predecessor: DeepInterviewWorkflow | undefined
  let spec: InterviewPlanPipeline["spec"] | undefined
  const result = await runDeepInterview(rt, sid, started.wf.id, io, {
    handoff(done, events) {
      const checked = verifiedSpec(worktree, done)
      if (!checked.ok) return { ok: false, text: checked.reason }
      const handed = handoffToRalplan(rt, sid, done,
        "Plan the verified tiny CLI greeting specification exactly. Keep the plan pending execution and do not implement anything.", events)
      if (!handed.ok) return handed
      predecessor = done
      spec = checked
      return { ok: true, successor: handed.wf }
    },
  })
  const successor = result.successor?.kind === "ralplan" ? result.successor : undefined
  if (result.status === "handed_off" && predecessor && spec && successor) {
    interviewPlanPipeline = { worktree, sid, runtime: rt, predecessor, successor, spec }
  }
  const data = predecessor ? recordOf(predecessor.data) : undefined
  const panels = Array.isArray(data?.panels) ? data.panels.map(recordOf).filter(Boolean) : []
  const panelPersonas = [...new Set(panels.flatMap(panel => {
    const results = recordOf(panel?.results)
    return results ? Object.keys(results) : []
  }))]
  return {
    worktree,
    evidence: {
      result: result.status,
      reason: result.reason,
      committed: readCommitted(worktree),
      ...(predecessor ? { predecessor: workflowSummary(predecessor) } : {}),
      ...(successor ? { successor: workflowSummary(successor) } : {}),
      ...(spec ? { spec } : {}),
      panelPersonas,
    },
  }
}
async function smokeRalplan() {
  if (!interviewPlanPipeline) await smokeDeepInterview()
  if (!interviewPlanPipeline) throw new Error("deep-interview did not produce a verified ralplan handoff")
  const { worktree, sid, runtime: rt, successor } = interviewPlanPipeline
  const before = readCommitted(worktree)
  if (before.state === "ok" && before.wf.kind === "ralplan" && before.wf.phase === "stuck") {
    const retried = retryRalplan(rt, sid, before.wf.id, before.wf.lastSeq)
    if (!retried.ok) throw new Error(retried.text)
  }
  const result = await runRalplan(rt, sid, successor.id)
  return {
    worktree,
    evidence: {
      result: result.status,
      committed: readCommitted(worktree),
      ledgerTasks: readLedger(worktree, sid).tasks.length,
      seedSpec: interviewPlanPipeline.spec,
      lineageParent: interviewPlanPipeline.predecessor.id,
    },
  }
}
async function smokeUltragoal() {
  const worktree = tempWorktree("ug"); const sid = "live-ug"; const rt = runtime(worktree, sid)
  writeFileSync(join(worktree, "SECOND.md"), "# second fixture\n")
  writeFileSync(join(worktree, "verify-readme.test.sh"), "set -eu\ntest \"$(cat README.md)\" = '# ug'\n")
  writeFileSync(join(worktree, "verify-second.test.sh"), "set -eu\ntest \"$(cat SECOND.md)\" = '# second fixture'\n")
  commitFixture(worktree, ["SECOND.md", "verify-readme.test.sh", "verify-second.test.sh"])
  const started = startUltragoal(rt, sid,
    "Complete exactly two goals without editing files. Goal 1 verifies README.md with exactly `sh verify-readme.test.sh`. Goal 2 verifies SECOND.md with exactly `sh verify-second.test.sh`. Each goal must have exactly one scoped unit and its corresponding verification command. Do not merge the goals, do not substitute echo, and do not create any other goal.")
  if (!started.ok) throw new Error(started.text)
  const foreground = createForegroundController(rt)
  const controller: UnitController = { runApprovedUnit: (sessionID, signal, resumed) => foreground.runApprovedUnit(sessionID, signal, resumed) }
  const approvals: Array<{ goalId: string; subjectSha: string; receiptRef: string }> = []
  let result = await runUltragoal(rt, controller, sid, started.wf.id)
  for (let guard = 0; guard < 4 && result.status === "approval"; guard++) {
    const wf = result.wf!
    const pending = ultragoalDataOf(wf).pending!
    const approved = approveUnit(rt, sid, wf.id, wf.lastSeq, approveUnitConfirmation(wf.id, pending.subject.sha256))
    if (!approved.ok) throw new Error(approved.text)
    const current = ultragoalDataOf(approved.wf).current!
    approvals.push({ goalId: current.goalId, subjectSha: current.subject.sha256, receiptRef: current.approval.receiptRef })
    result = await runUltragoal(rt, controller, sid, wf.id)
  }
  return {
    worktree,
    evidence: {
      result: result.status,
      approvals,
      committed: readCommitted(worktree),
      ledger: readLedger(worktree, sid).tasks.map(task => task.status),
    },
  }
}
async function smokeAutoresearch() {
  const worktree = tempWorktree("ar"); const sid = "live-ar"; const rt = runtime(worktree, sid)
  writeFileSync(join(worktree, "measure-lines.test.sh"), `set -eu
lines=$(wc -l < README.md | tr -d ' ')
printf 'METRIC score=%s\\n' "$lines"
`)
  writeFileSync(join(worktree, "measure-headings.test.sh"), `set -eu
headings=$(grep -c '^#' README.md)
printf 'METRIC score=%s\\n' "$headings"
`)
  commitFixture(worktree, ["measure-lines.test.sh", "measure-headings.test.sh"])
  const started = startAutoresearch(rt, sid,
    "Compare two existing deterministic repository checks using metric `score`: exactly `sh measure-lines.test.sh` and `sh measure-headings.test.sh`. The experiment must contain both commands, each must actually run after typed approval, and the verdict must record evidence and caveats before productification.")
  if (!started.ok) throw new Error(started.text)
  let wf = started.wf
  const approvals: Array<{ subjectSha: string; receiptRef: string }> = []
  for (let i = 0; i < 8; i++) {
    const result = await runAutoresearch(rt, sid, wf.id)
    if (result.status === "approval") {
      wf = result.wf!
      const sha = autoresearchDataOf(wf).pending!.subject.sha256
      const approved = approveExperiment(rt, sid, wf.id, wf.lastSeq, runConfirmation(wf.id, sha))
      if (!approved.ok) throw new Error(approved.text)
      const experiment = autoresearchDataOf(approved.wf).experiment!
      approvals.push({ subjectSha: experiment.subject.sha256, receiptRef: experiment.approval.receiptRef })
      wf = approved.wf
      continue
    }
    if (result.status === "choice") {
      wf = result.wf!
      const predecessor = workflowSummary(wf)
      const product = productifyAutoresearch(rt, sid, wf.id, wf.lastSeq)
      const finish = product.ok ? undefined : finishAutoresearch(rt, sid, wf.id, wf.lastSeq)
      const committed = readCommitted(worktree)
      return {
        worktree,
        evidence: {
          result: result.status,
          approvals,
          productify: product.ok,
          finish: finish?.ok,
          predecessor,
          ...(committed.state === "ok" ? { successor: workflowSummary(committed.wf) } : {}),
          committed,
        },
      }
    }
    return { worktree, evidence: { result: result.status, reason: result.reason, committed: readCommitted(worktree) } }
  }
  throw new Error("autoresearch did not reach choice/approval bound")
}

const fns: Record<string, () => Promise<{ worktree: string; evidence: Record<string, unknown> }>> = {
  "deep-interview": smokeDeepInterview,
  ralplan: smokeRalplan,
  ultragoal: smokeUltragoal,
  autoresearch: smokeAutoresearch,
}
for (const name of smokes) {
  const fn = fns[name]
  if (!fn) throw new Error(`unknown smoke ${name}`)
  const attempts: Attempt[] = []
  let accepted: Smoke | undefined
  let last: { worktree: string; evidence: Record<string, unknown> } | undefined
  for (let attempt = 1; attempt <= attemptsPerSmoke; attempt++) {
    try {
      const r = await fn()
      last = r
      const ok = smokeOk(name, r.evidence)
      attempts.push({ attempt, ok, worktree: r.worktree, status: evidenceStatus(name, r.evidence), ...(ok ? {} : { error: `unexpected live workflow status for ${name}` }) })
      if (ok) {
        accepted = { name, ok, worktree: r.worktree, evidence: { ...r.evidence, attempts } }
        break
      }
    } catch (error) {
      attempts.push({ attempt, ok: false, worktree: "", status: "threw", error: (error as Error).stack || String(error) })
    } finally { stopHeartbeat() }
  }
  results.push(accepted ?? {
    name,
    ok: false,
    worktree: last?.worktree ?? attempts.at(-1)?.worktree ?? "",
    evidence: { ...(last?.evidence ?? {}), attempts },
    error: `live workflow smoke did not meet acceptance after ${attempts.length} attempt(s)`,
  })
}
const summary = { schemaVersion: 1, engine, model, smokes: results, ok: results.every(r => r.ok), at: new Date().toISOString() }
if (out) { mkdirSync(join(out, ".."), { recursive: true }); writeFileSync(out, JSON.stringify(summary, null, 2) + "\n") }
console.log(JSON.stringify(summary, null, 2))
if (!summary.ok) process.exit(1)
