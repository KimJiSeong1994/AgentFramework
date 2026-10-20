#!/usr/bin/env bun
// Main-model skill load eval: does the model in an ordinary `otter chat` turn call the `skill` tool for the right skill,
// and only then? This measures the production path that decides loading (plan-conversation -> cli-host skill tool),
// not the side classifier that ranks the intent offer (scripts/otter-skill-route-eval.ts).
//
// Setup per run: one scratch git worktree whose committed project skills mirror this repository's (so they are the
// consent-free baseline), the operator's real home skill roots and user skill_trust/skill_auto, and the catalog built by
// SkillSession.autoCandidates exactly as `otter chat` does. Loads return the real captured SKILL.md bytes. Each case is
// one fresh conversation turn. The host failure reason is recorded for failed turns.
//
// Usage: bun scripts/otter-skill-load-eval.ts --engine local|claude|codex --model <id> [--reps N] [--journal f] [--out f]
// Metrics (completed turns; end-to-end counts failures as misses): recall, recall_excl_plan, precision, none_fp,
// wrong_skill, failure reasons. `plan` positives are reported separately: the planning main role already plans, so
// loading the plan skill there is arguably redundant.
import { execFileSync } from "node:child_process"
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { createCliRuntime } from "../framework/src/hosts/cli-runtime.ts"
import { createCliTransport } from "../framework/src/hosts/cli-transport.ts"
import { createPlanConversation, skillInstructionBudget } from "../framework/src/hosts/plan-conversation.ts"
import type { ExecutionOutcome, SkillToolProvider } from "../framework/src/hosts/types.ts"
import { attachAdmission } from "../framework/src/sessions/admission.ts"
import { resolveSkillRoots } from "../framework/src/skills/roots.ts"
import { claimPreparedSkillInvocation, SkillSession } from "../framework/src/skills/session.ts"
import { readSkillTrust } from "../framework/src/skills/trust.ts"
import { hostFailureReason } from "../framework/src/workflows/turn.ts"

const ROOT = resolve(import.meta.dir, "..")
const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    model: { type: "string" },
    reps: { type: "string", default: "1" },
    fixture: { type: "string", default: join(ROOT, "scripts/fixtures/skill-route/labeled.jsonl") },
    journal: { type: "string" },
    out: { type: "string" },
    limit: { type: "string" },
    // Skip these expected labels (e.g. `plan`, which the planning main role already does).
    exclude: { type: "string", multiple: true, default: [] },
    // Keep every Nth `none` case (deterministic sample) to shorten an A/B run; positives are always kept.
    "none-every": { type: "string", default: "1" },
    // Run only cases whose index % n === i ("i/n"), so several workers can share one fixture with separate journals.
    shard: { type: "string", default: "0/1" },
  },
})
if (!values.engine || !["local", "claude", "codex"].includes(values.engine) || !values.model) {
  process.stderr.write("usage: otter-skill-load-eval.ts --engine local|claude|codex --model <id> [--reps N] [--journal f] [--out f]\n")
  process.exit(2)
}
const integerArg = (name: string, raw: string | undefined, min: number) => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) { process.stderr.write(`--${name} must be an integer >= ${min}\n`); process.exit(2) }
  return value
}
const engine = values.engine as "local" | "claude" | "codex"
const model = values.model
const reps = integerArg("reps", values.reps, 1)
type Case = { text: string; expect: string; category: string }
type Row = Case & { index: number; rep: number; loads: string[]; ms: number; failure?: string; lastReply?: string }
const excluded = new Set(values.exclude)
const noneEvery = integerArg("none-every", values["none-every"], 1)
const allCases = readFileSync(values.fixture!, "utf8").trim().split("\n").map(line => JSON.parse(line) as Case)
  .slice(0, values.limit ? Number(values.limit) : undefined)
const shardMatch = /^(\d+)\/(\d+)$/.exec(values.shard!)
const shardIndex = shardMatch ? Number(shardMatch[1]) : NaN
const shardCount = shardMatch ? Number(shardMatch[2]) : NaN
if (!shardMatch || shardCount < 1 || shardIndex >= shardCount) { process.stderr.write("--shard must be i/n with 0 <= i < n\n"); process.exit(2) }
let noneSeen = 0
const selected = new Set(allCases.flatMap((item, index) => {
  if (excluded.has(item.expect)) return []
  if (item.expect === "none" && noneSeen++ % noneEvery !== 0) return []
  return index % shardCount === shardIndex ? [index] : []
}))
const cases = allCases

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "otter-skill-load-eval-")))
process.env.OTTER_STATE_HOME = join(scratch, ".state")
const worktree = join(scratch, "repo")
mkdirSync(worktree)
const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: worktree, stdio: "pipe" })
git("init", "-q"); git("config", "user.email", "eval@otter"); git("config", "user.name", "otter eval")
writeFileSync(join(worktree, "README.md"), "# scratch project\n")
for (const base of [".opencode/skills", ".agents/skills"]) {
  if (existsSync(join(ROOT, base))) cpSync(join(ROOT, base), join(worktree, base), { recursive: true, dereference: true })
}
git("add", "-A"); git("commit", "-q", "-m", "mirror project skills")

// Keep the last raw model reply so a refused reply format can be inspected (local eval data only).
let lastReply = ""
const runtime = createCliRuntime({ worktree, engine, model, createTransport: options => {
  const transport = createCliTransport(options)
  const run = transport.run.bind(transport)
  transport.run = async () => { const result = await run(); lastReply = String(result.text ?? ""); return result }
  return transport
} })
const roots = await resolveSkillRoots({ projectRoot: worktree, homeDirectory: homedir() })
const policy = readSkillTrust()
const requiredTools = (() => { const tools = runtime.policy.resolve("main").tools; return tools.allowed.filter(tool => !tools.denied.includes(tool)) })()

const recorded = new Set<string>()
if (values.journal && existsSync(values.journal)) {
  for (const line of readFileSync(values.journal, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as Row
    if (cases[row.index]?.text === row.text) recorded.add(`${row.index}:${row.rep}`)
  }
}

let catalogNames: string[] = []
const rows: Row[] = []
for (let rep = 0; rep < reps; rep++) {
  for (const [index, item] of cases.entries()) {
    if (!selected.has(index) || recorded.has(`${index}:${rep}`)) continue
    const sessionID = `load-eval-${rep}-${index}`
    const store = attachAdmission(runtime, sessionID, { engine, model })
    const skills = await SkillSession.create({ roots, store, trust: policy.trust }, AbortSignal.timeout(60_000))
    const catalog = await skills.autoCandidates(policy.auto, skillInstructionBudget(runtime.config.delegate.verify_allow, item.text), requiredTools, AbortSignal.timeout(60_000))
    catalogNames = catalog.map(candidate => candidate.name)
    const loads: string[] = []
    const skillTool: SkillToolProvider = {
      catalog: catalog.map(candidate => ({ name: candidate.name, description: candidate.description })),
      query: item.text,
      async load(name, signal) {
        try {
          const prepared = await skills.prepare(name, signal, { consent: "never", requiredTools })
          return { ok: true, text: claimPreparedSkillInvocation(prepared).text }
        } catch { return { ok: false, error: "Tool refused: this skill is not usable without consent right now." } }
      },
      // Count only instructions the host actually placed in the model input, as `otter chat` reports them.
      delivered(name) { if (!loads.includes(name)) loads.push(name) },
      withdrawn(name) { const at = loads.indexOf(name); if (at >= 0) loads.splice(at, 1) },
    }
    const outcomes: ExecutionOutcome[] = []
    const prepare = runtime.host.prepare.bind(runtime.host)
    runtime.host.prepare = async (request) => {
      const handle = await prepare(request)
      const run = handle.run.bind(handle)
      handle.run = async () => { const outcome = await run(); outcomes.push(outcome); return outcome }
      return handle
    }
    const started = Date.now()
    let failure: string | undefined
    try {
      await createPlanConversation(runtime, sessionID).turn(item.text, AbortSignal.timeout(300_000), undefined, catalog.length ? skillTool : undefined)
    } catch (error) {
      const last = outcomes.at(-1)
      failure = last?.status === "failed" ? hostFailureReason(last.error) : last ? `status_${last.status}` : (error as Error).name || "error"
    } finally {
      runtime.host.prepare = prepare
      skills.close()
      store.release({ workflowQuiescent: true, evidence: "load eval case finished", workflowID: null, revision: null })
    }
    const row: Row = { ...item, index, rep, loads, ms: Date.now() - started, ...(failure ? { failure } : {}),
      ...(failure === "malformed_response" ? { lastReply: lastReply.slice(0, 600) } : {}) }
    rows.push(row)
    if (values.journal) appendFileSync(values.journal, JSON.stringify(row) + "\n")
    process.stderr.write(`${rep + 1}.${index + 1}/${allCases.length} (${selected.size} selected) ${item.expect} -> ${loads.join(",") || "none"}${failure ? ` (${failure})` : ""}\n`)
  }
}

const all: Row[] = values.journal && existsSync(values.journal)
  ? readFileSync(values.journal, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Row).filter(row => cases[row.index]?.text === row.text && row.rep < reps && selected.has(row.index))
  : rows
const done = all.filter(row => !row.failure)
const positives = all.filter(row => row.expect !== "none")
const donePositives = done.filter(row => row.expect !== "none")
const noPlan = (list: Row[]) => list.filter(row => row.expect !== "plan")
const hit = (row: Row) => row.loads.includes(row.expect)
const picked = done.filter(row => row.loads.length > 0)
const noneDone = done.filter(row => row.expect === "none")
const ratio = (num: number, den: number) => ({ num, den, value: den ? Number((num / den).toFixed(3)) : null })
const failures: Record<string, number> = {}
for (const row of all) if (row.failure) failures[row.failure] = (failures[row.failure] ?? 0) + 1
const perSkill: Record<string, string> = {}
for (const name of [...new Set(positives.map(row => row.expect))].sort()) {
  const rowsFor = donePositives.filter(row => row.expect === name)
  perSkill[name] = `${rowsFor.filter(hit).length}/${rowsFor.length}`
}
const ms = done.map(row => row.ms).sort((a, b) => a - b)
const report = {
  schema: "otter-skill-load-eval.v1", recordedAt: new Date().toISOString(), engine, model, reps, cases: selected.size,
  excluded: [...excluded], noneEvery,
  catalog: catalogNames, skillAuto: policy.auto.mode,
  metrics: {
    recall: ratio(donePositives.filter(hit).length, donePositives.length),
    recallExcludingPlan: ratio(noPlan(donePositives).filter(hit).length, noPlan(donePositives).length),
    recallEndToEnd: ratio(positives.filter(row => !row.failure && hit(row)).length, positives.length),
    precision: ratio(picked.filter(row => row.expect !== "none" && hit(row)).length, picked.length),
    // Per load: an extra wrong skill loaded beside the right one counts against this.
    loadPrecision: ratio(done.reduce((sum, row) => sum + row.loads.filter(name => name === row.expect).length, 0), done.reduce((sum, row) => sum + row.loads.length, 0)),
    noneFalsePositive: ratio(noneDone.filter(row => row.loads.length > 0).length, noneDone.length),
    wrongSkill: donePositives.filter(row => row.loads.length > 0 && !hit(row)).length,
    failedTurns: ratio(all.length - done.length, all.length),
    p50Ms: ms[Math.floor(ms.length / 2)] ?? null,
  },
  failures, perSkill,
  falsePositives: noneDone.filter(row => row.loads.length > 0).map(({ text, loads, category }) => ({ text, loads, category })),
}
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n")
process.stdout.write(JSON.stringify(report, null, 2) + "\n")
process.exit(0)
