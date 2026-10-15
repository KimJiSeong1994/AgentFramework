// P6b S3: the autoresearch engine and the verifier-backed experiment runner. Deterministic fixture host (scripted outputs per
// role, the real legacy verifier running real allow-listed scripts); no live model. Model prose never produces a metric,
// a run status or a verdict: code parses verifier output, classifies runs and re-verifies every proof in the commit.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { readEvents } from "../src/flow/state.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { createForegroundController } from "../src/hosts/controller.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"
import { abortVerifierExecution, runVerifierExecution, type VerifierRunEntry } from "../src/orchestration/verifier-run.ts"
import { createSnapshotStore } from "../src/orchestration/snapshot.ts"
import type { VerificationHandle, VerificationResult } from "../src/orchestration/verifier.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import { sessionDir, stateRoot } from "../src/state/store.ts"
import { sha256 } from "../src/workflows/artifacts.ts"
import { classifyRun, parseMetric, runConfirmation, reduce } from "../src/workflows/autoresearch.ts"
import { approveExperiment, finishAutoresearch, retryAutoresearch, runAutoresearch, startAutoresearch, autoresearchView } from "../src/workflows/autoresearch-driver.ts"
import { autoresearchDataOf } from "../src/workflows/autoresearch.ts"
import { autoresearchEvidence } from "../src/workflows/autoresearch-evidence.ts"
import { autoresearchRunKeys, parseAutoresearchData } from "../src/workflows/autoresearch-data.ts"
import { __setCommitFaultHook, readCommitted } from "../src/workflows/commit.ts"
import { writeReceipt } from "../src/workflows/receipts.ts"
import { kindAllowsRole, parseEnvelope, requiredArtifactKeys, REGISTRY } from "../src/workflows/registry.ts"
import { approveUnitConfirmation } from "../src/workflows/ultragoal.ts"
import { parseStageEventsFor } from "../src/workflows/turn.ts"
import { tempGitWorktree, waitFor } from "./guards-helpers.ts"

const ENGINE = "fixture"
const CONTROLS = Object.fromEntries([
  "boundedInput", "boundedOutput", "preExecutionToolPolicy", "headlessPermissionRefusal", "ownedCancellation",
  "quiescenceEvidence", "identityBinding", "noReplayRecovery", "readOnlyWorkflow", "readOnlyWorktree", "serialWorkerLease",
].map(key => [key, "supported" as const]))

let wt: ReturnType<typeof tempGitWorktree>
let counter = 0
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree) })
afterEach(() => { __setCommitFaultHook(null); stopHeartbeat(); wt.cleanup() })

// ---------------------------------------------------------------------------------------------- fixture
const j = (value: unknown) => JSON.stringify(value)
const mission = j({ type: "mission", goal: "find the fastest setting", metric: "speed", direction: "max" })
const hypothesis = j({ type: "hypothesis", hypotheses: ["raising the setting raises speed"] })
const evidence = (...paths: string[]) => j({ type: "evidence", items: paths.map(path => ({ path, note: `see ${path}` })) })
const experiment = (commands: string[], params: Record<string, string> = {}) => j({ type: "experiment", commands, params })
const verdict = (value: string, findings: string[] = [], suspect: number[] = []) => j({ type: "lane_verdict", verdict: value, findings, ...(suspect.length ? { suspect } : {}) })
const OKAY = verdict("OKAY")
const ITERATE = verdict("ITERATE", ["measure again"])

type Script = { researcher: string[]; critic: string[] }
type Options = { verifyTimeoutMs?: number; script: Script; intercept?: (request: ExecutionRequest) => Promise<ExecutionOutcome> | undefined }

function harness(options: Options) {
  const queues: Record<string, string[]> = { researcher: [...options.script.researcher], critic: [...options.script.critic] }
  const config = { ...DEFAULT_CONFIG, delegate: { ...DEFAULT_CONFIG.delegate, worktree: false, max_attempts: 2, verify_timeout_ms: options.verifyTimeoutMs ?? 20_000 } }
  const requests: ExecutionRequest[] = []
  const verifierPrepares: string[] = []
  let sequence = 0
  const runs = createExecutionRunStore(wt.worktree)
  const sid = `ses_ar${counter++}`
  const base = createLegacyVerifierExecutor()
  const runtime: ExecutionRuntime = {
    instance: "ar-controller", directory: wt.worktree, worktree: wt.worktree, stateRoot: stateRoot(wt.worktree), config,
    log: () => {}, runs, verificationProfile: "legacy-unowned",
    verifier: { ...base, async prepare(request) { verifierPrepares.push(request.command); return base.prepare(request) } },
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
            const blocked = options.intercept?.(request)
            const text = queues[request.role]?.shift()
            const result: ExecutionOutcome = blocked ? await blocked : text === undefined ? { status: "failed", error: `script exhausted for ${request.role}` } : { status: "completed", text }
            completed = true
            return result
          },
          async requestCancel() { return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
          async reconcile() { return { outcome: completed ? "terminal" as const : "unknown" as const, quiescent: completed, evidence: "fixture child" } },
        }
      },
    },
  }
  const store = attachAdmission(runtime, sid, { engine: ENGINE, model: "m" })
  const controller = createForegroundController(runtime)
  return { runtime, store, sid, controller, requests, queues, verifierPrepares, workers: () => requests.filter(r => r.role === "worker" || r.role === "reviewer") }
}
type H = ReturnType<typeof harness>

const committed = () => {
  const read = readCommitted(wt.worktree)
  if (read.state !== "ok" || read.wf.kind !== "autoresearch") throw new Error("no committed autoresearch")
  return read.wf
}
const dataNow = () => autoresearchDataOf(committed())
const script = (name: string, body: string) => { writeFileSync(join(wt.worktree, name), `${body}\n`); return `sh ${name}` }

function begin(h: H): string {
  const started = startAutoresearch(h.runtime, h.sid, "which setting is fastest?")
  if (!started.ok) throw new Error(started.text)
  return started.wf.id
}
/** Approve the pending experiment with its typed RUN receipt (the human step). */
function approve(h: H, wid = committed().id) {
  const wf = committed()
  const sha = dataNow().pending!.subject.sha256
  const approved = approveExperiment(h.runtime, h.sid, wid, wf.lastSeq, runConfirmation(wid, sha))
  if (!approved.ok) throw new Error(approved.text)
  return sha
}
/** Drive to the verdict choice, approving every proposed experiment. */
async function drive(h: H, options: { approve?: boolean; signal?: AbortSignal } = {}) {
  const wid = committed().id
  const trail: string[] = []
  for (;;) {
    const result = await runAutoresearch(h.runtime, h.sid, wid, { onStep: wf => trail.push(`${wf.stage}:${wf.phase}`), ...(options.signal ? { signal: options.signal } : {}) })
    if (result.status !== "approval" || options.approve === false) return { result, trail }
    approve(h, wid)
  }
}

const SPEED = ["3", "5", "4"]
function metricScripts(): string[] {
  return [
    script("check_a.sh", `echo "METRIC speed=${SPEED[0]}"`),
    script("check_b.sh", `echo "METRIC speed=${SPEED[1]}"`),
    script("check_c.sh", `echo "METRIC speed=${SPEED[2]}"`),
    script("check_d.sh", "echo crashing\nexit 1"),
    script("check_e.sh", "echo no metric here"),
  ]
}

// ---------------------------------------------------------------------------------------------- tests
describe("stage and phase order (1)", () => {
  test("stages follow the PA:275 order, every revision parses, events and artifacts are recorded, conclusive -> done", async () => {
    const commands = metricScripts().slice(0, 2)
    const h = harness({ script: { researcher: [mission, hypothesis, evidence("README.md", "missing/file.py"), experiment(commands)], critic: [OKAY] } })
    begin(h)
    const { result, trail } = await drive(h)
    expect(result.status).toBe("choice")
    expect(trail).toEqual([
      "intake:planning", "hypothesis:planning", "evidence:planning", "experiment_prepare:planning", "experiment_approval:pending_approval",
      "experiment_run:executing", "evaluate:reviewing", "verdict_emit:planning", "verdict_emit:planning",
    ])
    const choice = committed()
    parseEnvelope(choice)
    const finished = finishAutoresearch(h.runtime, h.sid, choice.id, choice.lastSeq, { productify: true })
    if (!finished.ok) throw new Error(finished.text)
    const done = committed()
    expect(done).toMatchObject({ stage: "terminal", phase: "done" })
    parseEnvelope(done)
    const types = readEvents(wt.worktree, done.id).map(event => event.type)
    for (const type of ["intake_confirmed", "evidence_recorded", "experiment_proposed", "experiment_approved", "run_recorded", "evaluation_recorded", "verdict_written", "productify_selected"]) expect(types).toContain(type)
    for (const key of ["mission.json", "evidence.json", "runs/1.json", "runs/2.json", "verdict.json"]) expect(done.artifacts.map(ref => ref.key)).toContain(key)
    expect(requiredArtifactKeys(done)).toEqual(["mission.json", "verdict.json", "runs/1.json", "runs/2.json"])
    expect(autoresearchRunKeys(done.data)).toEqual(["runs/1.json", "runs/2.json"])
    expect(autoresearchEvidence(wt.worktree, done, { final: true }).problems).toEqual([])
    expect(autoresearchView(done)).toContain("iter 1/10")
    // roles: only the registered read-only roles took model turns; no worker or reviewer ever ran
    expect(kindAllowsRole("autoresearch", "worker")).toBe(false)
    expect(h.requests.every(r => kindAllowsRole("autoresearch", r.role))).toBe(true)
    expect(h.workers()).toHaveLength(0)
    expect(dataNow().productify).toEqual({ chosen: true })
  })
})

describe("commands run only through the verifier (2, 3)", () => {
  test("approved commands are prepared exactly N times; shell metacharacters and network commands are refused with 0 prepares; AR modules use no child_process", async () => {
    const [a, b] = metricScripts()
    const h = harness({ script: { researcher: [mission, hypothesis, evidence("README.md"), experiment([a!, b!, a!])], critic: [OKAY] } })
    begin(h)
    const first = await drive(h, { approve: false })
    expect(first.result.status).toBe("approval")
    expect(h.verifierPrepares).toHaveLength(0)
    await drive(h)
    expect(h.verifierPrepares).toEqual([a, b, a])

    const bad = harness({ script: { researcher: [mission, hypothesis, evidence("README.md"), experiment(["rm -rf x; echo hi"]), experiment(["curl http://example.com/x"])], critic: [OKAY] } })
    wt.cleanup(); wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree)
    const again = harness({ script: bad.queues as Script })
    begin(again)
    const result = await runAutoresearch(again.runtime, again.sid, committed().id)
    expect(result.status).toBe("stuck")
    expect(committed()).toMatchObject({ stage: "experiment_prepare", phase: "stuck" })
    expect(dataNow().stuck?.kind).toBe("attempts")
    expect(dataNow().pending).toBeUndefined()
    expect(again.verifierPrepares).toHaveLength(0)

    // Import graph of the AR modules: no process-spawning module is reachable except through the verifier-run sequence, the
    // checkpoint module's read-only `git rev-parse/status` digest (an allow-listed, documented exception) and the
    // existing stop machinery; the queue, the plan shell helper and the worker controller are never imported.
    const root = join(import.meta.dir, "..", "src")
    const arFiles = ["autoresearch.ts", "autoresearch-data.ts", "autoresearch-driver.ts", "autoresearch-runner.ts", "autoresearch-evidence.ts", "autoresearch-commit.ts", "autoresearch-docs.ts", "prompts/autoresearch.ts"].map(file => join(root, "workflows", file))
    const FORBIDDEN_IMPORT = /^(node:child_process|child_process|\.\.\/orchestration\/(queue|shell|worktree)\.ts|\.\.\/hosts\/controller\.ts|\.\.\/flow\/runtime\.ts#startWorkflow)$/
    const ALLOWED_SPAWNING = new Set(["checkpoint.ts"]) // git digest, read-only, bounded timeout
    for (const file of arFiles) {
      const source = readFileSync(file, "utf8")
      expect(source, file).not.toMatch(/Bun\.spawn|runShell|startShell|queue\.run|runInternal|startWorkflow\(|execSync|execFileSync|spawn\(/)
      for (const match of source.matchAll(/^import[^"\n]*"([^"]+)"/gm)) {
        const specifier = match[1]!
        expect(FORBIDDEN_IMPORT.test(specifier), `${file} imports ${specifier}`).toBe(false)
        if (specifier.startsWith("./")) { // workflow-local dependencies (the framework-wide graph reaches session/state stores that own their own git helpers)
          const target = join(file, "..", specifier)
          const dependency = readFileSync(target, "utf8")
          if (/node:child_process/.test(dependency)) expect(ALLOWED_SPAWNING.has(target.split("/").pop()!), `${target} spawns`).toBe(true)
        }
      }
    }
  })

  test("0 prepares before RUN; a typed APPROVE-UNIT or wrong sha grants nothing; a param change rehashes and needs a new approval; the same subject re-runs without one", async () => {
    const [a] = metricScripts()
    const h = harness({
      script: {
        researcher: [mission, hypothesis, evidence("README.md"), experiment([a!], { level: "1" }), experiment([a!], { level: "2" }), experiment([a!], { level: "2" })],
        critic: [ITERATE, ITERATE, OKAY],
      },
    })
    begin(h)
    const wid = committed().id
    expect((await runAutoresearch(h.runtime, h.sid, wid)).status).toBe("approval")
    const wf = committed()
    const sha1 = dataNow().pending!.subject.sha256
    for (const typed of [`RUN ${wid} ${"0".repeat(64)}`, `RUN ${wid}`, "RUN", approveUnitConfirmation(wid, sha1), "", `RUN other ${sha1}`]) {
      expect(approveExperiment(h.runtime, h.sid, wid, wf.lastSeq, typed)).toMatchObject({ ok: false })
    }
    expect(approveExperiment(h.runtime, h.sid, wid, wf.lastSeq + 1, runConfirmation(wid, sha1))).toMatchObject({ ok: false })
    expect(h.verifierPrepares).toHaveLength(0)
    expect((await runAutoresearch(h.runtime, h.sid, wid)).status).toBe("approval")
    expect(h.verifierPrepares).toHaveLength(0)

    approve(h, wid)
    // iteration 2 changes a param: new subject, new approval required, nothing runs yet
    const second = await runAutoresearch(h.runtime, h.sid, wid)
    expect(second.status).toBe("approval")
    expect(h.verifierPrepares).toHaveLength(1)
    const sha2 = dataNow().pending!.subject.sha256
    expect(sha2).not.toBe(sha1)
    expect(approveExperiment(h.runtime, h.sid, wid, committed().lastSeq, runConfirmation(wid, sha1))).toMatchObject({ ok: false })
    approve(h, wid)
    // iteration 3 repeats the identical subject: it runs with no new receipt
    const third = await runAutoresearch(h.runtime, h.sid, wid)
    expect(third.status).toBe("choice")
    expect(h.verifierPrepares).toHaveLength(3)
    const approvals = readEvents(wt.worktree, wid).filter(event => event.type === "experiment_approved")
    expect(approvals.map(event => event.data?.reused)).toEqual([undefined, undefined, true])
    expect(dataNow().iteration).toBe(3)
  }, 60_000)
})

describe("metric runs and integrity (4)", () => {
  test("METRIC 3,5,4, exit 1, no METRIC -> baseline, keep, discard, crash, checks_failed with best 5; a writing script is checks_failed/invalid and restored; a suspect run is excluded", async () => {
    const commands = [...metricScripts(), script("check_w.sh", 'echo polluted > stray.txt\necho "METRIC speed=9"')]
    const h = harness({ script: { researcher: [mission, hypothesis, evidence("README.md"), experiment(commands)], critic: [verdict("OKAY", [], [2])] } })
    begin(h)
    const wid = committed().id
    expect((await runAutoresearch(h.runtime, h.sid, wid)).status).toBe("approval")
    approve(h, wid)
    // stop right after the run stage by letting the evaluate turn happen, then inspect runs
    const result = await runAutoresearch(h.runtime, h.sid, wid, { stopBefore: "evaluate" })
    expect(result.status).toBe("blocked")
    const before = dataNow()
    expect(before.runs.map(run => run.status)).toEqual(["baseline", "keep", "discard", "crash", "checks_failed", "checks_failed"])
    expect(before.runs.map(run => run.valid)).toEqual([true, true, true, true, true, false])
    expect(before.runs[5]).toMatchObject({ invalid: "integrity" })
    expect(before.runs.map(run => run.metric)).toEqual([3, 5, 4, undefined, undefined, undefined])
    expect(before.best).toEqual({ attempt: 2, value: 5 })
    expect(existsSync(join(wt.worktree, "stray.txt"))).toBe(false)
    const files = before.runs.map(run => JSON.parse(readFileSync(join(wt.worktree, run.path), "utf8")))
    expect(files[5]).toMatchObject({ integrity: "changed", valid: false })

    await runAutoresearch(h.runtime, h.sid, wid)
    const after = dataNow()
    expect(after.runs[1]).toMatchObject({ valid: false, invalid: "suspect" })
    expect(after.best).toEqual({ attempt: 3, value: 4 })
    expect(after.evaluation).toMatchObject({ verdict: "OKAY", suspect: [2] })
    expect(autoresearchEvidence(wt.worktree, committed()).problems).toEqual([])
  }, 60_000)

  test("pure classifier and parser: last METRIC line wins, minimising direction, no fabricated metric from other text", () => {
    expect(parseMetric("noise\nMETRIC speed=1\nMETRIC speed=2.5e1\n", "speed")).toBe(25)
    expect(parseMetric("METRIC other=1\nspeed=3", "speed")).toBeUndefined()
    expect(parseMetric("  METRIC speed=3 and more", "speed")).toBeUndefined()
    const facts = { refused: false, interrupted: false, integrity: "unchanged" as const, invalidated: false, exitCode: 0, timedOut: false, cancelled: false, output: "METRIC speed=2" }
    const min = { name: "speed", direction: "min" as const }
    const base = classifyRun(facts, min, [])
    expect(base).toMatchObject({ status: "baseline", metric: 2 })
    const prior = [{ attempt: 1, iteration: 1, slot: 0, path: "p", sha256: "a".repeat(64), receiptRef: "r", status: "baseline" as const, valid: true, metric: 2 }]
    expect(classifyRun({ ...facts, output: "METRIC speed=1" }, min, prior).status).toBe("keep")
    expect(classifyRun({ ...facts, output: "METRIC speed=2" }, min, prior).status).toBe("discard")
    expect(classifyRun({ ...facts, timedOut: true }, min, prior)).toMatchObject({ status: "crash", valid: true })
    expect(classifyRun({ ...facts, interrupted: true }, min, prior)).toMatchObject({ valid: false, invalid: "interrupted" })
    expect(classifyRun({ ...facts, integrity: "changed" }, min, prior)).toMatchObject({ status: "checks_failed", valid: false })
  })
})

describe("iteration cap (5)", () => {
  test("a critic that always ITERATEs gets exactly 10 iterations, a cap caveat and no 11th prepare", async () => {
    const [a] = metricScripts()
    const h = harness({ script: { researcher: [mission, hypothesis, evidence("README.md"), ...Array.from({ length: 11 }, () => experiment([a!]))], critic: Array.from({ length: 11 }, () => ITERATE) } })
    begin(h)
    const { result } = await drive(h)
    expect(result.status).toBe("choice")
    expect(h.verifierPrepares).toHaveLength(10)
    const data = dataNow()
    expect(data.iteration).toBe(10)
    expect(data.runs).toHaveLength(10)
    expect(data.capped).toBe(true)
    expect(data.caveats.some(item => item.includes("iteration cap"))).toBe(true)
    expect(h.queues.researcher.length).toBeGreaterThan(0)
    const experiments = h.requests.filter(r => r.role === "researcher" && r.text.includes("propose the next experiment"))
    expect(experiments).toHaveLength(10)
    const verdictFile = JSON.parse(readFileSync(join(wt.worktree, data.verdict!.path), "utf8"))
    expect(verdictFile.status).toBe("inconclusive")
    const choice = committed()
    const finished = finishAutoresearch(h.runtime, h.sid, choice.id, choice.lastSeq)
    if (!finished.ok) throw new Error(finished.text)
    expect(committed()).toMatchObject({ stage: "terminal", phase: "stuck" })
    expect(dataNow().stuck?.kind).toBe("inconclusive")
    expect(requiredArtifactKeys(committed())).toHaveLength(12)
  }, 120_000)
})

describe("verdict (6)", () => {
  async function toChoice(researcher: string[], critic: string[]) {
    const h = harness({ script: { researcher, critic } })
    begin(h)
    const { result } = await drive(h)
    expect(result.status).toBe("choice")
    return h
  }

  test("verdict.json has status/evidence/caveats/evaluator; evidence is a subset of verified runs and receipts; a nonexistent path is a caveat; conclusive -> done", async () => {
    const [a, b] = metricScripts()
    const h = await toChoice([mission, hypothesis, evidence("README.md", "nope/missing.py"), experiment([a!, b!])], [OKAY])
    const data = dataNow()
    expect(data.evidence).toMatchObject({ verified: 1, unverified: 1 })
    const doc = JSON.parse(readFileSync(join(wt.worktree, data.verdict!.path), "utf8"))
    expect(Object.keys(doc).sort()).toEqual(["caveats", "evaluator", "evidence", "status", "v", "wid"])
    expect(doc.status).toBe("conclusive")
    expect(doc.caveats.some((item: string) => item.includes("nope/missing.py"))).toBe(true)
    expect(doc.evaluator).toMatchObject({ verdict: "OKAY", promptSha: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const runShas = new Set(data.runs.map(run => run.sha256))
    const receipts = new Set(data.runs.map(run => run.receiptRef))
    for (const entry of doc.evidence) {
      if (entry.kind === "run") expect(runShas.has(entry.sha256)).toBe(true)
      else expect(receipts.has(entry.ref)).toBe(true)
    }
    const choice = committed()
    expect(finishAutoresearch(h.runtime, h.sid, choice.id, choice.lastSeq).ok).toBe(true)
    expect(committed()).toMatchObject({ phase: "done", stage: "terminal" })
    expect(h.workers()).toHaveLength(0)
  })

  test("a deleted, altered or foreign run blocks the terminal commit; a conclusive verdict needs a valid run and a critic OKAY", async () => {
    const [a] = metricScripts()
    const h = await toChoice([mission, hypothesis, evidence("README.md"), experiment([a!])], [OKAY])
    const choice = committed()
    const runPath = join(wt.worktree, dataNow().runs[0]!.path)
    const original = readFileSync(runPath, "utf8")
    writeFileSync(runPath, original.replace('"valid": true', '"valid": false'))
    expect(finishAutoresearch(h.runtime, h.sid, choice.id, choice.lastSeq)).toMatchObject({ ok: false })
    expect(committed()).toMatchObject({ stage: "verdict_emit", lastSeq: choice.lastSeq })
    writeFileSync(runPath, original)
    // the verification receipt is the metric authority: swapping the run for another hash-consistent file is still refused
    const swapped = JSON.stringify({ ...JSON.parse(original), metric: 99 }, null, 2) + "\n"
    writeFileSync(runPath, swapped)
    expect(finishAutoresearch(h.runtime, h.sid, choice.id, choice.lastSeq)).toMatchObject({ ok: false })
    writeFileSync(runPath, original)
    const { rmSync } = await import("node:fs")
    rmSync(runPath)
    expect(finishAutoresearch(h.runtime, h.sid, choice.id, choice.lastSeq)).toMatchObject({ ok: false })
    expect(committed().phase).toBe("planning")
    writeFileSync(runPath, original)
    // a verdict claiming evidence that is not a recorded run is refused by the evidence check
    const verdictPath = join(wt.worktree, dataNow().verdict!.path)
    const doc = JSON.parse(readFileSync(verdictPath, "utf8"))
    writeFileSync(verdictPath, JSON.stringify({ ...doc, evidence: [...doc.evidence, { kind: "run", key: "runs/9.json", sha256: sha256("x") }] }, null, 2) + "\n")
    expect(autoresearchEvidence(wt.worktree, committed(), { final: true }).problems.length).toBeGreaterThan(0)
    expect(finishAutoresearch(h.runtime, h.sid, choice.id, choice.lastSeq)).toMatchObject({ ok: false })
    expect(() => requiredArtifactKeys({ kind: "autoresearch", stage: "terminal", phase: "done", data: { runs: [] } } as never)).toThrow()
  })

  test("an OKAY with no valid metric run is inconclusive (stuck@terminal), never conclusive", async () => {
    const c = script("check_e.sh", "echo no metric here")
    const h = await toChoice([mission, hypothesis, evidence("README.md"), experiment([c])], [OKAY])
    const doc = JSON.parse(readFileSync(join(wt.worktree, dataNow().verdict!.path), "utf8"))
    expect(doc.status).toBe("inconclusive")
    const choice = committed()
    expect(finishAutoresearch(h.runtime, h.sid, choice.id, choice.lastSeq).ok).toBe(true)
    expect(committed()).toMatchObject({ stage: "terminal", phase: "stuck" })
  })
})

describe("pause, resume and cancel (7, 8)", () => {
  async function toRunning(commands: string[], critic = [OKAY]) {
    const h = harness({ script: { researcher: [mission, hypothesis, evidence("README.md"), experiment(commands)], critic } })
    begin(h)
    const wid = committed().id
    expect((await runAutoresearch(h.runtime, h.sid, wid)).status).toBe("approval")
    approve(h, wid)
    return { h, wid }
  }

  test("a pause during a sleep run stays pausing until settled; the run is invalid (interrupted), not crash; resume runs only the remainder with 0 worker prepares", async () => {
    const fast = script("check_fast.sh", 'echo "METRIC speed=3"')
    const slow = script("check_sleep.sh", "sleep 1\necho \"METRIC speed=5\"")
    const { h, wid } = await toRunning([fast, slow])
    const running = runAutoresearch(h.runtime, h.sid, wid).then(result => result, (error: unknown) => ({ status: "error", error }))
    await waitFor(() => h.verifierPrepares.length === 2, 10_000)
    expect(h.controller.pause(h.sid).ok).toBe(true)
    const pausing = committed()
    expect(pausing.phase).toBe("executing")
    expect(pausing.stopIntent).toMatchObject({ kind: "pause" })
    expect(pausing.stopIntent!.token).toBeTruthy()
    const settledBefore = readEvents(wt.worktree, wid).filter(event => event.type === "pause_settled")
    expect(settledBefore).toHaveLength(0)
    const result = await running
    expect(result).toMatchObject({ status: "blocked" })
    await waitFor(() => committed().phase === "paused")
    expect(readEvents(wt.worktree, wid).filter(event => event.type === "pause_settled")).toHaveLength(1)
    const data = dataNow()
    expect(data.runs.map(run => [run.status, run.valid, run.invalid])).toEqual([["baseline", true, undefined], ["checks_failed", false, "interrupted"]])
    expect(data.runs[1]!.status).not.toBe("crash")
    expect(data.experiment).toMatchObject({ done: ["c0"], remaining: ["c1"] })
    expect(h.runtime.runs.status().claim).toBeUndefined()

    const preparesBefore = h.requests.length
    const resumed = await h.controller.resumePaused(h.sid, async () => true)
    expect(resumed.kept).toBe(false)
    expect(committed()).toMatchObject({ stage: "experiment_run", phase: "executing" })
    expect(h.workers()).toHaveLength(0)
    expect(h.requests.length).toBe(preparesBefore)
    expect(h.verifierPrepares).toHaveLength(2)
    const done = await runAutoresearch(h.runtime, h.sid, wid)
    expect(done.status).toBe("choice")
    expect(h.verifierPrepares).toEqual([fast, slow, slow])
    expect(dataNow().runs.map(run => run.valid)).toEqual([true, false, true])
    expect(dataNow().best).toEqual({ attempt: 3, value: 5 })
    expect(h.workers()).toHaveLength(0)
  }, 60_000)

  test("cancel mid-run -> cancelled after quiescence, runs are kept and no verdict is written", async () => {
    const fast = script("check_fast.sh", 'echo "METRIC speed=3"')
    const slow = script("check_sleep.sh", "sleep 1\necho \"METRIC speed=5\"")
    const { h, wid } = await toRunning([fast, slow])
    const running = runAutoresearch(h.runtime, h.sid, wid).then(result => result, (error: unknown) => ({ status: "error", error }))
    await waitFor(() => h.verifierPrepares.length === 2, 10_000)
    expect(h.controller.cancel(h.sid).ok).toBe(true)
    expect(committed().phase).toBe("executing")
    await running
    await waitFor(() => committed().phase === "cancelled")
    const wf = committed()
    expect(readEvents(wt.worktree, wid).filter(event => event.type === "cancel_settled")).toHaveLength(1)
    expect(readEvents(wt.worktree, wid).filter(event => event.type === "pause_settled")).toHaveLength(0)
    expect(dataNow().runs).toHaveLength(2)
    expect(dataNow().verdict).toBeUndefined()
    expect(wf.artifacts.map(ref => ref.key)).not.toContain("verdict.json")
    for (const run of dataNow().runs) expect(existsSync(join(wt.worktree, run.path))).toBe(true)
    expect(h.runtime.runs.status().claim).toBeUndefined()
    await expect(h.controller.resume(h.sid)).rejects.toThrow()
    expect((await runAutoresearch(h.runtime, h.sid, wid)).status).toBe("done")
    expect(h.verifierPrepares).toHaveLength(2)
    expect(retryAutoresearch(h.runtime, h.sid, wid, wf.lastSeq)).toMatchObject({ ok: false })
  }, 60_000)
})

describe("diff stays within .lca/workflows (9)", () => {
  test("every file the engine adds is under .lca/workflows/", async () => {
    const [a, b] = metricScripts()
    const h = harness({ script: { researcher: [mission, hypothesis, evidence("README.md"), experiment([a!, b!])], critic: [OKAY] } })
    const status = () => execFileSync("git", ["-C", wt.worktree, "status", "--porcelain", "-uall"], { encoding: "utf8" }).split("\n").filter(Boolean).map(line => line.slice(3))
    const before = new Set(status())
    begin(h)
    await drive(h)
    const added = status().filter(path => !before.has(path))
    expect(added.length).toBeGreaterThan(0)
    expect(added.every(path => path.startsWith(".lca/workflows/"))).toBe(true)
    expect(existsSync(join(wt.worktree, "stray.txt"))).toBe(false)
  })
})

describe("guards", () => {
  test("model events carrying runtime-owned fields or another stage's vocabulary are rejected; wrong roles are refused", () => {
    for (const field of ["stage", "approval", "phase", "subject", "receipt", "owner", "revision", "approved", "artifacts"]) {
      expect(parseStageEventsFor(j({ type: "mission", goal: "g", metric: "speed", direction: "max", [field]: "x" }), "autoresearch", "intake").ok).toBe(false)
      expect(parseStageEventsFor(j({ type: "experiment", commands: ["sh check_a.sh"], [field]: "x" }), "autoresearch", "experiment_prepare").ok).toBe(false)
    }
    expect(parseStageEventsFor(mission, "autoresearch", "experiment_prepare").ok).toBe(false)
    expect(parseStageEventsFor(OKAY, "autoresearch", "experiment_run").ok).toBe(false)
    expect(parseStageEventsFor(OKAY, "autoresearch", "verdict_emit").ok).toBe(false)
    expect(parseStageEventsFor(verdict("OKAY", [], [3]), "autoresearch", "evaluate").ok).toBe(true)
    expect(parseStageEventsFor(j({ type: "lane_verdict", verdict: "OKAY", findings: [], suspect: ["a"] }), "autoresearch", "evaluate").ok).toBe(false)
    expect(parseStageEventsFor(j({ type: "mission", goal: "g", metric: "bad name", direction: "max" }), "autoresearch", "intake").ok).toBe(false)
  })

  test("reducer guards: no run without an approved experiment, no 11th iteration, no out-of-order run, strict data parser", async () => {
    const [a] = metricScripts()
    const h = harness({ script: { researcher: [mission, hypothesis, evidence("README.md"), experiment([a!])], critic: [OKAY] } })
    begin(h)
    await runAutoresearch(h.runtime, h.sid, committed().id)
    const wf = committed()
    expect(() => reduce(wf, { type: "experiment_finished" })).toThrow()
    expect(() => reduce(wf, { type: "verdict_written", verdict: { key: "verdict.json", path: "p", sha256: sha256("x") }, status: "conclusive" })).toThrow()
    expect(() => reduce(wf, { type: "autoresearch_finished" })).toThrow()
    const data = dataNow()
    const other = { ...data.pending!, subject: { ...data.pending!.subject, sha256: sha256("other") } }
    expect(() => reduce(wf, { type: "experiment_approved", experiment: { subject: other.subject, input: other.input, approval: { subject: other.subject, receiptRef: "x#y" }, artifacts: other.artifacts, taskIds: [], done: [], remaining: ["c0"], iteration: 1 } })).toThrow()
    expect(() => parseAutoresearchData({ v: 1, request: "x", hypotheses: [], iteration: 11, attempts: 0, findings: [], caveats: [], runs: [] })).toThrow()
    expect(() => parseAutoresearchData({ v: 1, request: "x", hypotheses: [], iteration: 1, attempts: 0, findings: [], caveats: [], runs: [], extra: 1 })).toThrow()
  })

  test("an experiment document edited after the proposal makes the approval refuse and the run never starts", async () => {
    const [a] = metricScripts()
    const h = harness({ script: { researcher: [mission, hypothesis, evidence("README.md"), experiment([a!])], critic: [OKAY] } })
    begin(h)
    const wid = committed().id
    await runAutoresearch(h.runtime, h.sid, wid)
    const pending = dataNow().pending!
    writeFileSync(join(wt.worktree, pending.artifacts[0]!.path), "{}\n")
    const wf = committed()
    expect(approveExperiment(h.runtime, h.sid, wid, wf.lastSeq, runConfirmation(wid, pending.subject.sha256))).toMatchObject({ ok: false })
    expect(h.verifierPrepares).toHaveLength(0)
    void writeReceipt
  })
})

describe("legacy verifier past its deadline (architect S3 item 1)", () => {
  test("a sleep-past-deadline legacy script is recorded valid:false/unsettled with its receipt, the fence is kept, the stuck reason is visible, Retry is refused and a cancel never reports cancelled", async () => {
    const slow = script("check_slow.sh", "sleep 30\necho \"METRIC speed=9\"")
    const h = harness({ verifyTimeoutMs: 400, script: { researcher: [mission, hypothesis, evidence("README.md"), experiment([slow])], critic: [OKAY] } })
    begin(h)
    const wid = committed().id
    expect((await runAutoresearch(h.runtime, h.sid, wid)).status).toBe("approval")
    approve(h, wid)
    const result = await runAutoresearch(h.runtime, h.sid, wid)
    expect(result.status).toBe("stuck")
    const wf = committed()
    expect(wf).toMatchObject({ stage: "experiment_run", phase: "stuck" })
    const data = autoresearchDataOf(wf)
    expect(data.stuck).toMatchObject({ kind: "runner" })
    expect(data.stuck!.reason).toMatch(/timed out|terminated/)
    expect(data.stuck!.reason).toContain("fenced")
    expect(data.runs).toHaveLength(1)
    expect(data.runs[0]).toMatchObject({ valid: false, invalid: "unsettled", status: "crash" })
    expect(data.best).toBeUndefined()
    const doc = JSON.parse(readFileSync(join(wt.worktree, data.runs[0]!.path), "utf8"))
    expect(doc).toMatchObject({ valid: false, invalid: "unsettled", timedOut: true })
    expect(autoresearchEvidence(wt.worktree, wf).problems).toEqual([])
    // the fence is retained: claim held, execution not settled, Retry refused with the reason, workflow never cancels/pauses past it
    expect(h.runtime.runs.status().claim).toBeDefined()
    const fenced = h.runtime.runs.status().executions.find(e => e.kind === "verifier")!
    expect(fenced.fence?.reason).toContain("settlement unproven")
    const retry = retryAutoresearch(h.runtime, h.sid, wid, wf.lastSeq)
    expect(retry).toMatchObject({ ok: false })
    expect((retry as { text: string }).text).toContain("fenced")
    expect(h.controller.pause(h.sid)).toMatchObject({ ok: false })
    h.controller.cancel(h.sid)
    expect(committed().phase).not.toBe("cancelled")
    expect(committed().stopIntent).toMatchObject({ kind: "cancel" })
    expect(h.verifierPrepares).toHaveLength(1)
  }, 30_000)
})

describe("approval receipts are the typed choice of their kind (architect S3 item 5)", () => {
  test("a receipt bound to the right subject but of another choice (execute_confirmed) or executed:true is not an approval", async () => {
    const { approvalBodyProblem } = await import("../src/workflows/execution-unit.ts")
    expect(approvalBodyProblem("autoresearch", { choice: "run-experiment", executed: false })).toBeNull()
    expect(approvalBodyProblem("autoresearch", { choice: "execute_confirmed", executed: false })).toContain("run-experiment")
    expect(approvalBodyProblem("autoresearch", { choice: "approve-unit", executed: false })).toContain("run-experiment")
    expect(approvalBodyProblem("autoresearch", { choice: "run-experiment", executed: true })).toContain("executed:false")
    expect(approvalBodyProblem("ultragoal", { choice: "run-experiment", executed: false })).toContain("approve-unit")
    // end to end: swap the run's approval for an execute_confirmed receipt bound to the same subject; the evidence check refuses it
    const [a] = metricScripts()
    const h = harness({ script: { researcher: [mission, hypothesis, evidence("README.md"), experiment([a!])], critic: [OKAY] } })
    begin(h)
    const wid = committed().id
    await runAutoresearch(h.runtime, h.sid, wid)
    approve(h, wid)
    await runAutoresearch(h.runtime, h.sid, wid, { stopBefore: "evaluate" })
    const wf = committed()
    const experiment_ = autoresearchDataOf(wf).experiment!
    const forged = writeReceipt(wt.worktree, { kind: "choice", wid, sid: h.sid, revision: 0, action: "choice-execute-confirmed", inputSha: experiment_.subject.sha256, body: { choice: "execute_confirmed", subjectId: experiment_.subject.id, subjectSha: experiment_.subject.sha256, executed: false } })
    const swapped = { ...wf, data: { ...wf.data, experiment: { ...experiment_, approval: { ...experiment_.approval, receiptRef: forged } } } }
    const { unitRecord, unitRecordProblem } = await import("../src/workflows/execution-unit.ts")
    expect(unitRecordProblem(swapped as never, unitRecord(swapped as never), wt.worktree)).toContain("run-experiment")
    expect(unitRecordProblem(wf as never, unitRecord(wf as never), wt.worktree)).toBeNull()
  }, 30_000)
})

describe("conclusive verdict gate (architect S3 item 4)", () => {
  test("a conclusive verdict that cites an invalid run, or has no valid metric run, is refused by the evidence check", async () => {
    const [a] = metricScripts()
    const h = harness({ script: { researcher: [mission, hypothesis, evidence("README.md"), experiment([a!])], critic: [OKAY] } })
    begin(h)
    await drive(h)
    const wf = committed()
    const data = autoresearchDataOf(wf)
    expect(autoresearchEvidence(wt.worktree, wf, { final: true }).problems).toEqual([])
    const invalidated = { ...wf, data: { ...data, runs: data.runs.map(run => ({ ...run, valid: false, invalid: "suspect" })) } }
    const problems = autoresearchEvidence(wt.worktree, invalidated as never, { final: true }).problems
    expect(problems.some(item => item.includes("cites invalid run"))).toBe(true)
    expect(problems.some(item => item.includes("valid run with a metric"))).toBe(true)
    const noMetric = { ...wf, data: { ...data, runs: data.runs.map(({ metric: _m, ...run }) => run) } }
    expect(autoresearchEvidence(wt.worktree, noMetric as never, { final: true }).problems.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------------------------- architect items
describe("shared verifier abort parity (queue.abort and the experiment runner)", () => {
  async function rig(patch: (base: ReturnType<typeof createLegacyVerifierExecutor>) => Partial<ReturnType<typeof createLegacyVerifierExecutor>>) {
    const h = harness({ script: { researcher: [], critic: [] } })
    const base = createLegacyVerifierExecutor()
    h.runtime.verifier = { ...base, ...patch(base) }
    const store = (await createSnapshotStore(wt.worktree, join(sessionDir(wt.worktree, h.sid), "snapshots", "parity")))!
    const claim = h.runtime.runs.claim(h.sid, h.runtime.instance, process.pid)
    const entry: VerifierRunEntry = { aborted: false, claim }
    const config = { diff_exclude: DEFAULT_CONFIG.delegate.diff_exclude, diff_max_chars: 6000, verify_timeout_ms: 20_000, verify_output_chars: 1500 }
    const run = () => runVerifierExecution(h.runtime, entry, { sessionID: h.sid, taskID: "t1", attemptID: "a1", attemptNumber: 1, command: "sh check_a.sh", root: wt.worktree, store, config })
    return { h, entry, claim, run }
  }
  const cancelled: VerificationResult = { profile: "legacy-unowned", parentExit: null, timedOut: false, cancelled: true, isolationEstablished: false, domainState: "unknown", integrity: "unknown", output: "killed" }
  const hung = (handle: VerificationHandle, request: (reason: string, deadlineAt: number) => ReturnType<VerificationHandle["requestCancel"]>): VerificationHandle => ({
    reference: handle.reference, run: () => new Promise<VerificationResult>(() => {}), requestCancel: request, reconcile: handle.reconcile,
  })

  test("mid-run cancel with ack and terminal outcome records killed + acknowledged cancel, and the legacy execution stays fenced (never settled)", async () => {
    metricScripts()
    const r = await rig(base => ({ async prepare(request) { return hung(await base.prepare(request), async () => ({ requested: true, acknowledged: true, outcome: cancelled })) } }))
    const running = r.run().then(outcome => outcome, (error: Error) => error.message)
    await waitFor(() => r.entry.verify?.run !== undefined)
    await abortVerifierExecution(r.h.runtime, r.entry, "session end")
    // a killed legacy command is returned as an unresolved outcome carrying its terminal result (the caller records it)
    expect(await running).toMatchObject({ kind: "unresolved", r: { cancelled: true } })
    expect(r.entry.unresolved).toBe(true)
    const execution = r.h.runtime.runs.status().executions.find(e => e.kind === "verifier")!
    expect(execution.cancel).toMatchObject({ acknowledgedAt: expect.any(Number) })
    expect(execution.terminal?.outcome).toBe("killed")
    expect(execution.terminal?.verification).toMatchObject({ cancelled: true })
    expect(execution.fence).toBeDefined()
  })

  test("no ack and no outcome fences the claim and marks the entry unresolved", async () => {
    metricScripts()
    const r = await rig(base => ({ async prepare(request) { return hung(await base.prepare(request), async () => ({ requested: true, acknowledged: false })) } }))
    const running = r.run().then(() => "ran", (error: Error) => error.message)
    await waitFor(() => r.entry.verify?.run !== undefined)
    await abortVerifierExecution(r.h.runtime, r.entry, "session end")
    expect(await running).toContain("cancellation unresolved")
    expect(r.entry.unresolved).toBe(true)
    const execution = r.h.runtime.runs.status().executions.find(e => e.kind === "verifier")!
    expect(execution.fence?.reason).toContain("cancellation")
    expect(execution.cancel?.acknowledgedAt).toBeUndefined()
    expect(r.h.runtime.runs.status().claim).toBeDefined()
  }, 15_000)

  test("a refused preflight is a refused outcome with 0 prepares and nothing dispatched", async () => {
    metricScripts()
    let prepares = 0
    const r = await rig(base => ({
      async preflight() { return { compatible: false, problems: ["backend down"] } },
      async prepare(request) { prepares++; return base.prepare(request) },
    }))
    const outcome = await r.run()
    expect(outcome).toMatchObject({ kind: "refused" })
    expect((outcome as { output: string }).output).toContain("backend down")
    expect(prepares).toBe(0)
    expect(r.h.runtime.runs.status().executions.filter(e => e.kind === "verifier")).toHaveLength(0)
  })
})
