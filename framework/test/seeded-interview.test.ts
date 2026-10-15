// P6b S4: autoresearch verdict productifies into a new seeded deep-interview. The handoff carries facts only;
// no RUN or APPROVE-UNIT consent is inherited.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { realpathSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { readEvents } from "../src/flow/state.ts"
import { createForegroundController } from "../src/hosts/controller.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import type { ExecutionOutcome, ExecutionRequest, ExecutionRuntime } from "../src/hosts/types.ts"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import { stateRoot } from "../src/state/store.ts"
import { readCommitted } from "../src/workflows/commit.ts"
import { approveExperiment, finishAutoresearch, productifyAutoresearch, runAutoresearch, startAutoresearch } from "../src/workflows/autoresearch-driver.ts"
import { autoresearchDataOf, runConfirmation } from "../src/workflows/autoresearch.ts"
import { readRecordedText } from "../src/workflows/autoresearch-evidence.ts"
import { runDeepInterview } from "../src/workflows/deep-interview-driver.ts"
import { dataOf as diDataOf } from "../src/workflows/deep-interview-data.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

const j = (value: unknown) => JSON.stringify(value)
const mission = j({ type: "mission", goal: "measure fixture", metric: "score", direction: "max" })
const hypothesis = j({ type: "hypothesis", hypotheses: ["the script reports score"] })
const evidence = j({ type: "evidence", items: [{ path: "README.md", note: "fixture" }] })
const experiment = j({ type: "experiment", commands: ["sh check_metric.sh"], params: {} })
const okay = j({ type: "lane_verdict", verdict: "OKAY", findings: [], suspect: [] })
const topology = j({ type: "topology", project: "brownfield", components: [{ id: "research", description: "seeded verdict" }] })
const CONTROLS = Object.fromEntries([
  "boundedInput", "boundedOutput", "preExecutionToolPolicy", "headlessPermissionRefusal",
  "ownedCancellation", "quiescenceEvidence", "identityBinding", "noReplayRecovery",
  "readOnlyWorktree", "serialWorkerLease",
].map(key => [key, "supported" as const]))

let wt: ReturnType<typeof tempGitWorktree>
let counter = 0
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree); writeFileSync(join(wt.worktree, "check_metric.sh"), "echo METRIC score=1\n") })
afterEach(() => { stopHeartbeat(); wt.cleanup() })

function harness() {
  const queues: Record<string, string[]> = { researcher: [mission, hypothesis, evidence, experiment], critic: [okay], interviewer: [topology] }
  const requests: ExecutionRequest[] = []
  const base = createLegacyVerifierExecutor()
  const config = { ...DEFAULT_CONFIG, delegate: { ...DEFAULT_CONFIG.delegate, worktree: false, verify_timeout_ms: 20_000 } }
  const runtime: ExecutionRuntime = {
    instance: "seed-fixture", directory: wt.worktree, worktree: wt.worktree, stateRoot: stateRoot(wt.worktree), config,
    log() {}, runs: createExecutionRunStore(wt.worktree), verificationProfile: "legacy-unowned", verifier: base,
    policy: createExecutionPolicy(config, { directory: wt.worktree, worktree: wt.worktree }), observe: { task() {} },
    host: {
      identity: { engine: "fixture", profile: "code" },
      async preflight() { return { compatible: true, controls: CONTROLS, problems: [] } },
      async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "fixture" } },
      async prepare(request) {
        requests.push(request)
        let done = false
        return {
          reference: { executionID: request.executionID },
          async run(): Promise<ExecutionOutcome> { done = true; return { status: "completed", text: queues[request.role]?.shift() ?? "{}" } },
          async requestCancel() { done = true; return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
          async reconcile() { return { outcome: done ? "terminal" : "unknown", quiescent: done, evidence: "fixture" } },
        }
      },
    },
  }
  const sid = `ses_seed${counter++}`
  attachAdmission(runtime, sid, { engine: "fixture", model: "m" })
  return { runtime, sid, requests, controller: createForegroundController(runtime) }
}

async function driveToVerdict(h: ReturnType<typeof harness>) {
  const started = startAutoresearch(h.runtime, h.sid, "research productization")
  if (!started.ok) throw new Error(started.text)
  for (;;) {
    const result = await runAutoresearch(h.runtime, h.sid, started.wf.id)
    if (result.status === "choice") return result.wf!
    if (result.status !== "approval") throw new Error(`unexpected ${result.status}: ${result.reason ?? ""}`)
    const wf = result.wf!
    const sha = autoresearchDataOf(wf).pending!.subject.sha256
    const approved = approveExperiment(h.runtime, h.sid, wf.id, wf.lastSeq, runConfirmation(wf.id, sha))
    if (!approved.ok) throw new Error(approved.text)
  }
}

describe("autoresearch productifies into seeded deep-interview", () => {
  test("verified verdict handoff creates one new deep-interview with exact seed and lineage", async () => {
    const h = harness()
    const ar = await driveToVerdict(h)
    const verdictBytes = readRecordedText(wt.worktree, ar, "verdict.json")
    const product = productifyAutoresearch(h.runtime, h.sid, ar.id, ar.lastSeq)
    if (!product.ok) throw new Error(product.text)
    const read = readCommitted(wt.worktree)
    expect(read.state === "ok" && read.wf.kind).toBe("deep-interview")
    const di = read.state === "ok" ? read.wf : undefined
    expect(di?.lineage?.predecessor).toMatchObject({ id: ar.id, kind: "autoresearch" })
    expect(diDataOf(di as never).seed?.raw).toBe(verdictBytes)
    expect(diDataOf(di as never).seed).toMatchObject({ source: "autoresearch", status: "conclusive" })
    expect(readEvents(wt.worktree).filter(event => event.type === "created").map(event => event.data?.kind)).toEqual(["autoresearch", "deep-interview"])

    const result = await runDeepInterview(h.runtime, h.sid, di!.id, { async choose() { return 0 }, async readAnswer() { return undefined }, async readNote() { return undefined } }, { stopBefore: "question" })
    expect(result.status).toBe("blocked")
    expect(h.requests.find(request => request.role === "interviewer")?.text).toContain(verdictBytes)
  })

  test("tampering with the verdict before productify refuses without changing the index", async () => {
    const h = harness()
    const ar = await driveToVerdict(h)
    const before = readCommitted(wt.worktree)
    const ref = ar.artifacts.find(item => item.key === "verdict.json")!
    writeFileSync(join(wt.worktree, ref.path), "{}\n")
    const refused = productifyAutoresearch(h.runtime, h.sid, ar.id, ar.lastSeq)
    expect(refused.ok).toBe(false)
    expect(readCommitted(wt.worktree)).toEqual(before)
  })

  test("a finished autoresearch can still productify from terminal history and does not inherit execution consent", async () => {
    const h = harness()
    const ar = await driveToVerdict(h)
    const finished = finishAutoresearch(h.runtime, h.sid, ar.id, ar.lastSeq)
    if (!finished.ok) throw new Error(finished.text)
    expect(readCommitted(wt.worktree).state === "ok" && (readCommitted(wt.worktree) as { wf?: { kind?: string; phase?: string } }).wf?.phase).toBe("done")
    const product = productifyAutoresearch(h.runtime, h.sid, ar.id, finished.wf.lastSeq)
    if (!product.ok) throw new Error(product.text)
    const read = readCommitted(wt.worktree)
    expect(read.state === "ok" && read.wf.kind).toBe("deep-interview")
    expect(readEvents(wt.worktree).filter(event => event.type === "productify_selected")).toHaveLength(1)
    expect(readEvents(wt.worktree).some(event => event.type === "execution_approved" || event.type === "experiment_approved")).toBe(true)
    // The only approval was the RUN needed to create the research verdict; the seeded DI did not create queue tasks.
    expect(readEvents(wt.worktree).filter(event => event.wf === (read.state === "ok" ? read.wf.id : "") && event.type.includes("approved"))).toHaveLength(0)
  })
})
