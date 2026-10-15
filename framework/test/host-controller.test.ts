import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { createForegroundController, readForegroundStatus } from "../src/hosts/controller.ts"
import { humanDecision, type DecisionBinding, type OperatorDecision } from "../src/hosts/operator.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import { LinuxAdmissionRefused, type ExecutionOutcome, type ExecutionRequest, type ExecutionRuntime, type LinuxAdmission } from "../src/hosts/types.ts"
import { canonicalPlanJson, canonicalPlanSha, planMdPath, type Plan } from "../src/flow/plan.ts"
import { clearReviewSession } from "../src/flow/review.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { eventsPath, FlowTransactionBusyError, flowDir, readEvents, readWorkflow, newWorkflow, planJsonPath, workflowPath, withFlowTransaction } from "../src/flow/state.ts"
import { writeWorkflow, rewriteCommitted } from "./commit-fixture.ts"
import { repairOnLoad, startWorkflow, stopHeartbeat } from "../src/flow/runtime.ts"
import { __setCommitFaultHook } from "../src/workflows/commit.ts"
import { registerSkillPermissionActivity } from "../src/skills/activity.ts"
import { observeStopSettlement } from "../src/flow/runtime.ts"
import { ledgerPath, readLedger, writeLedger } from "../src/state/ledger.ts"
import { executionRunDirectory, modeStatePath, sessionDir, stateRoot } from "../src/state/store.ts"
import { readSessionMetadata } from "../src/sessions/store.ts"
import { admissionEpoch, attachAdmission, detachAdmission, effectiveHold, holdAdmission } from "../src/sessions/admission.ts"
import { tempGitWorktree, verifyScript, waitFor } from "./guards-helpers.ts"
import { createLegacyVerifierExecutor } from "../src/orchestration/legacy-verifier.ts"
import { getQueue } from "../src/orchestration/queue.ts"
import { planBinding, withTerminalLine } from "./operator-helpers.ts"

const SESSION = "ses_local"
const ENGINE = "fixture"
const MODEL = "fixture-model"
// Synthetic lifecycle fixture statuses exercise checks only; they are not vendor capability evidence.
const SYNTHETIC_CONTROL_STATUSES = {
  boundedInput: "supported",
  boundedOutput: "supported",
  preExecutionToolPolicy: "supported",
  headlessPermissionRefusal: "supported",
  ownedCancellation: "supported",
  quiescenceEvidence: "supported",
  identityBinding: "supported",
  noReplayRecovery: "supported",
  readOnlyWorktree: "supported",
  serialWorkerLease: "supported",
} as const
let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree) })
afterEach(() => { __setCommitFaultHook(null); stopHeartbeat(); wt.cleanup() })

function fixture(opts: {
  review?: string
  hangReview?: boolean
  cancelQuiescent?: boolean
  reconcile?: "unknown" | "terminal"
  maxAttempts?: number
  instance?: string
  attach?: boolean
  worker?: (request: ExecutionRequest) => ExecutionOutcome | Promise<ExecutionOutcome>
  linuxAdmission?: LinuxAdmission
  preflightControls?: (count: number) => Record<string, "supported" | "unsupported" | "unknown">
  onReviewComplete?: () => void | Promise<void>
  /** Runs inside requestCancel before it answers, so a fixture worker can finish before the owner reconciles it. */
  onCancel?: (title: string) => void | Promise<void>
} = {}) {
  const config = { ...DEFAULT_CONFIG, delegate: { ...DEFAULT_CONFIG.delegate, worktree: false, max_attempts: opts.maxAttempts ?? DEFAULT_CONFIG.delegate.max_attempts } }
  const requests: ExecutionRequest[] = []
  const cancellationRequests: string[] = []
  const resumeRequests: Array<boolean | null | undefined> = []
  let preflights = 0
  let reconciliations = 0
  let claims = 0
  let sequence = 0
  const runs = createExecutionRunStore(wt.worktree)
  const claimRun = runs.claim.bind(runs)
  runs.claim = (...args: Parameters<typeof runs.claim>) => { claims++; return claimRun(...args) }
  const runtime: ExecutionRuntime = {
    instance: opts.instance ?? "local-controller", directory: wt.worktree, worktree: wt.worktree, stateRoot: stateRoot(wt.worktree), config,
    log: () => {}, runs, verificationProfile: "legacy-unowned", verifier: createLegacyVerifierExecutor(),
    ...(opts.linuxAdmission ? { linuxAdmission: opts.linuxAdmission } : {}),
    observe: { task(fact) { if (fact.status === "started") resumeRequests.push(fact.resumeRequested) } },
    policy: createExecutionPolicy(config, { directory: wt.worktree, worktree: wt.worktree }),
    host: {
      identity: { engine: ENGINE, profile: "code" },
      async preflight() { preflights++; return { compatible: true, controls: opts.preflightControls?.(preflights) ?? SYNTHETIC_CONTROL_STATUSES, problems: [] } },
      async reconcile() { reconciliations++; return { outcome: opts.reconcile ?? "unknown", quiescent: opts.reconcile === "terminal", evidence: "fixture reconciliation" } },
      async prepare(request) {
        requests.push(request)
        const vendorSessionID = `child_${++sequence}`
        const reference = { executionID: request.executionID, vendorSessionID }
        let reviewCompletionObserved = false
        runtime.policy.bindSession(vendorSessionID, request.handlers, request.policy)
        let completed = false
        return {
          reference,
          async run() {
            expect(runtime.runs.status().executions.at(-1)?.vendorRef).toBe(JSON.stringify(reference))
            if (opts.hangReview && request.title.includes("plan review")) return new Promise<ExecutionOutcome>(() => {})
            const result = request.title.includes("plan review") ? { status: "completed" as const, text: opts.review ?? "VERDICT: OKAY" } :
              request.role === "reviewer" ? { status: "completed" as const, text: "ACCEPT" } :
                opts.worker ? opts.worker(request) : { status: "completed" as const, text: "Open issues: none" }
            const outcome = await result
            completed = true
            return outcome
          },
          async requestCancel() {
            cancellationRequests.push(request.title)
            await opts.onCancel?.(request.title)
            return { requested: true, acknowledged: true, terminal: opts.cancelQuiescent ?? false, quiescent: opts.cancelQuiescent ?? false }
          },
          async reconcile() {
            if (completed && request.title.includes("plan review") && !reviewCompletionObserved) {
              reviewCompletionObserved = true
              await opts.onReviewComplete?.()
            }
            return { outcome: completed ? "terminal" as const : "unknown" as const, quiescent: completed, evidence: "fixture child completed" }
          },
        }
      },
    },
  }
  const session = opts.attach === false ? undefined : attachAdmission(runtime, SESSION, { engine: ENGINE, model: MODEL })
  return { runtime, session, controller: createForegroundController(runtime), requests, cancellationRequests, resumeRequests,
    get preflights() { return preflights }, get reconciliations() { return reconciliations }, get claims() { return claims } }
}

function plan(): Plan {
  return {
    goal: "write three modules", revision: 1, risks: ["a regression might escape the individual checks"],
    steps: [1, 2, 3].map(n => ({ title: `module ${n}`, files: [`mod${n}.py`], detail: `write module ${n}`, verify: verifyScript(wt.worktree, `check_${n}.sh`, `test -f mod${n}.py`) })),
  }
}
function save(planValue = plan()) {
  const source = join(wt.worktree, "import.json")
  writeFileSync(source, canonicalPlanJson(planValue))
  return source
}
/** A real terminal-reader receipt bound to the committed revision the operator inspected. */
function binding(workflowID: string, hash: string, overrides: Partial<DecisionBinding> = {}): DecisionBinding {
  return { ...planBinding(SESSION, { id: workflowID, lastSeq: readWorkflow(wt.worktree)?.lastSeq ?? 0 }, hash), ...overrides }
}
async function operatorReceipt(mode: "approve" | "reject" | "choose", workflowID: string, hash: string, line: string, overrides: Partial<DecisionBinding> = {}): Promise<OperatorDecision> {
  return withTerminalLine(line, () => humanDecision(mode, binding(workflowID, hash, overrides)))
}
function approve(controller: ReturnType<typeof createForegroundController>, workflowID: string, hash: string) {
  return withTerminalLine(`APPROVE ${workflowID} ${hash}`, async () =>
    controller.decide(await humanDecision("approve", binding(workflowID, hash))))
}
function reject(controller: ReturnType<typeof createForegroundController>, workflowID: string, hash: string, reason: string) {
  return withTerminalLine(`REJECT ${workflowID} ${hash} ${reason}`, async () =>
    controller.decide(await humanDecision("reject", binding(workflowID, hash))))
}

async function verifierTakeover(dispatch: "prepared" | "started" | "unmarked") {
  const f = fixture({ maxAttempts: 1 })
  const submitted = await f.controller.importPlan(SESSION, save())
  if (!submitted.result.ok) throw new Error(submitted.result.text)
  expect((await approve(f.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
  const claim = f.runtime.runs.claim(SESSION, f.runtime.instance, process.pid)
  const executionID = `verifier-${dispatch}`
  const reference = {
    kind: "verifier" as const, executionID, profile: "legacy-unowned" as const,
    invocationID: `invocation-${dispatch}`, inputSnapshotID: "snapshot",
    inputDigest: "a".repeat(64), deadlineAt: Date.now() + 10_000, maxOutputChars: 1024,
  }
  f.runtime.runs.registerIntent(claim, {
    executionId: executionID, ownerSession: SESSION, taskId: "task", attemptId: "attempt",
    generation: claim.generation, role: "verifier", cwd: wt.worktree, policyID: "verify-command",
    kind: "verifier", profile: "legacy-unowned", inputSnapshotID: reference.inputSnapshotID,
    inputDigest: reference.inputDigest, deadlineAt: reference.deadlineAt, maxOutputChars: reference.maxOutputChars,
  })
  f.runtime.runs.bindVerifierRef(claim, executionID, reference)
  if (dispatch === "started") f.runtime.runs.markVerifierDispatched(claim, executionID)
  const path = join(executionRunDirectory(wt.worktree), "state.json")
  const state = JSON.parse(readFileSync(path, "utf8"))
  state.claim.pid = 2147483647
  if (dispatch === "unmarked") delete state.executions.at(-1).verifierDispatch
  writeFileSync(path, JSON.stringify(state))
  return { f, executionID }
}

async function cancelInSubprocess(worktree: string, sessionID: string, kind: "cancel" | "pause" = "cancel") {
  const imports = {
    controller: new URL("../src/hosts/controller.ts", import.meta.url).href,
    config: new URL("../src/config.ts", import.meta.url).href,
    runState: new URL("../src/hosts/run-state.ts", import.meta.url).href,
    policy: new URL("../src/hosts/tool-policy.ts", import.meta.url).href,
    verifier: new URL("../src/orchestration/legacy-verifier.ts", import.meta.url).href,
    state: new URL("../src/state/store.ts", import.meta.url).href,
  }
  const script = `import { createForegroundController } from ${JSON.stringify(imports.controller)}
import { DEFAULT_CONFIG } from ${JSON.stringify(imports.config)}
import { createExecutionRunStore } from ${JSON.stringify(imports.runState)}
import { createExecutionPolicy } from ${JSON.stringify(imports.policy)}
import { createLegacyVerifierExecutor } from ${JSON.stringify(imports.verifier)}
import { stateRoot } from ${JSON.stringify(imports.state)}
const root = process.env.CANCEL_WORKTREE
const config = { ...DEFAULT_CONFIG, delegate: { ...DEFAULT_CONFIG.delegate, worktree: false } }
const runtime = {
  instance: "cancel-subprocess", directory: root, worktree: root, stateRoot: stateRoot(root), config, log() {},
  runs: createExecutionRunStore(root), verificationProfile: "legacy-unowned", verifier: createLegacyVerifierExecutor(),
  policy: createExecutionPolicy(config, { directory: root, worktree: root }),
  host: {
    identity: { engine: ${JSON.stringify(ENGINE)}, profile: "code" },
    async preflight() { return { compatible: true, controls: {}, problems: [] } },
    async prepare() { throw new Error("cancel process must not execute a host request") },
    async reconcile() { return { outcome: "unknown", quiescent: false, evidence: "unused" } },
  },
}
const result = createForegroundController(runtime)[${JSON.stringify(kind)}](process.env.CANCEL_SESSION)
console.log(JSON.stringify({ ok: result.ok, text: result.ok ? undefined : result.text,
  pendingCancel: result.wf?.stopIntent?.kind === "cancel", stop: result.wf?.stopIntent?.kind ?? null, phase: result.wf?.phase, owner: result.wf?.owner }))`
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: worktree, env: { ...process.env, CANCEL_WORKTREE: worktree, CANCEL_SESSION: sessionID }, stdout: "pipe", stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  if (exitCode !== 0 || stderr) throw new Error(`cancellation subprocess failed (${exitCode}): ${stderr || stdout}`)
  return JSON.parse(stdout) as { ok: boolean; text?: string; pendingCancel?: boolean; stop?: string | null; phase?: string; owner?: { instance: string; pid: number } }
}

describe("external foreground imported-plan controller", () => {
  test("controller refuses a workflow without a live attachment epoch instead of using runtime.instance", async () => {
    const f = fixture({ attach: false })
    await expect(f.controller.importPlan(SESSION, save())).rejects.toThrow("session remains held")
    expect(readWorkflow(wt.worktree)).toBeNull()
    expect(f.requests).toHaveLength(0)
    expect(existsSync(sessionDir(wt.worktree, SESSION))).toBe(false)
  })

  test("restored attachment rebinds while held and emits no execution before explicit Resume", async () => {
    const f = fixture()
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    const beforeDispatches = f.requests.length
    const first = f.session!
    expect(await detachAdmission(f.runtime, SESSION, first.epoch, "test-restore")).toBe(true)

    const restored = attachAdmission(f.runtime, SESSION, { engine: ENGINE, model: MODEL })
    expect(restored.restored).toBe(true)
    expect(restored.metadata.held).toBe(true)
    expect(effectiveHold(wt.worktree, SESSION)).toBe(true)
    expect(admissionEpoch(wt.worktree, SESSION)).toBeUndefined()
    expect(readWorkflow(wt.worktree)?.owner.instance).toBe(restored.epoch)
    expect(f.requests).toHaveLength(beforeDispatches)

    const workflowBeforeStatus = readFileSync(workflowPath(wt.worktree))
    f.controller.status(SESSION, true)
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(workflowBeforeStatus)
    expect(f.requests).toHaveLength(beforeDispatches)
    expect(await detachAdmission(f.runtime, SESSION, restored.epoch, "test-restore-exit")).toBe(true)
  })

  test("a stale foreground callback after host preflight cannot dispatch under a held epoch", async () => {
    const f = fixture()
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(f.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const workflowBefore = readFileSync(workflowPath(wt.worktree))
    const dispatchesBefore = f.requests.length
    let releasePreflight!: (value: { compatible: boolean; controls: Record<string, "supported">; problems: string[] }) => void
    let entered = false
    f.runtime.host.preflight = () => {
      entered = true
      return new Promise(resolve => { releasePreflight = resolve })
    }
    const running = f.controller.run(SESSION)
    await waitFor(() => entered)
    holdAdmission(wt.worktree, SESSION, "stale-controller-test")
    releasePreflight({ compatible: true, controls: SYNTHETIC_CONTROL_STATUSES, problems: [] })
    await expect(running).rejects.toThrow("session remains held")
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(workflowBefore)
    expect(f.requests).toHaveLength(dispatchesBefore)
    expect(effectiveHold(wt.worktree, SESSION)).toBe(true)
  })

  test("incomplete role controls refuse import before reconciliation, workflow creation, or claim", async () => {
    const without = (key: string) => {
      const controls: Record<string, "supported" | "unsupported" | "unknown"> = { ...SYNTHETIC_CONTROL_STATUSES }
      delete controls[key]
      return controls
    }
    const cases: Record<string, "supported" | "unsupported" | "unknown">[] = [{}, without("serialWorkerLease"), without("readOnlyWorktree")]
    for (const controls of cases) {
      const f = fixture({ preflightControls: () => controls })
      await expect(f.controller.importPlan(SESSION, save())).rejects.toThrow("required control statuses unavailable")
      expect(f.reconciliations).toBe(0)
      expect(f.claims).toBe(0)
      expect(f.requests).toHaveLength(0)
      expect(existsSync(workflowPath(wt.worktree))).toBe(false)
    }
  })

  test("run-time loss of a required control refuses before claim or prepare and preserves workflow bytes", async () => {
    const lost: Record<string, "supported" | "unsupported" | "unknown"> = { ...SYNTHETIC_CONTROL_STATUSES }
    delete lost.serialWorkerLease
    const f = fixture({ preflightControls: count => count === 1 ? SYNTHETIC_CONTROL_STATUSES : lost })
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(f.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const requestsBefore = f.requests.length
    const claimsBefore = f.claims
    const workflowBefore = readFileSync(workflowPath(wt.worktree))

    await expect(f.controller.run(SESSION)).rejects.toThrow("required control statuses unavailable")

    expect(f.claims).toBe(claimsBefore)
    expect(f.requests).toHaveLength(requestsBefore)
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(workflowBefore)
  })
  test("imports and reviews, then explicit local approval runs serial workers and independent verifiers", async () => {
    const source = save()
    const f = fixture({ worker: request => {
      const n = Number(request.title.match(/module (\d)/)?.[1])
      writeFileSync(join(wt.worktree, `mod${n}.py`), `VALUE = ${n}\n`)
      return { status: "completed", text: `Files changed: mod${n}.py\nOpen issues: none` }
    } })
    const submitted = await f.controller.importPlan(SESSION, source)
    expect(submitted.result.ok).toBe(true)
    if (!submitted.result.ok) return
    expect(submitted.result.wf.phase).toBe("pending_approval")
    expect(submitted.result.wf.engine).toBe(ENGINE)
    expect(readEvents(wt.worktree, submitted.result.wf!.id).find(event => event.type === "created")?.data).toMatchObject({ engine: ENGINE })
    expect(submitted.renderedPlan).toContain("## Review (advisory)")
    expect(submitted.planSha).toBe(canonicalPlanSha(plan()))
    expect(f.requests.map(r => r.role)).toEqual(["reviewer"])
    const stateBeforeStatus = readFileSync(workflowPath(wt.worktree), "utf8")
    const runsBeforeStatus = JSON.stringify(f.runtime.runs.status())
    expect(f.controller.status(SESSION, true)).toMatchObject({ workflow: { phase: "pending_approval" } })
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(stateBeforeStatus)
    expect(JSON.stringify(f.runtime.runs.status())).toBe(runsBeforeStatus)
    expect(f.preflights).toBe(1)
    expect(f.requests).toHaveLength(1)
    expect((await approve(f.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const finished = await f.controller.run(SESSION)
    expect(finished.workflow.phase).toBe("done")
    expect(finished.run).toMatchObject({ done: 3, failed: 0 })
    expect(f.resumeRequests.length).toBeGreaterThan(0)
    expect(f.resumeRequests.every(value => value !== true)).toBe(true)
    expect(f.requests.map(r => r.role)).toEqual(["reviewer", "worker", "reviewer", "worker", "reviewer", "worker", "reviewer"])
    expect(readLedger(wt.worktree, SESSION).tasks.map(t => [t.status, t.verify_result?.ok])).toEqual([["done", true], ["done", true], ["done", true]])
    expect(f.controller.status(SESSION)).toContain("done")
  }, 15_000)

  test("an explicit resume records resumed provenance", async () => {
    const f = fixture({ worker: request => {
      const n = Number(request.title.match(/module (\d)/)?.[1])
      writeFileSync(join(wt.worktree, `mod${n}.py`), `VALUE = ${n}\n`)
      return { status: "completed", text: `Files changed: mod${n}.py\nOpen issues: none` }
    } })
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(f.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const finished = await f.controller.resume(SESSION)
    expect(finished.workflow.phase).toBe("done")
    expect(f.resumeRequests).toContain(true)
  }, 15_000)

  test("model text or vendor approval never acts as operator decision; wrong ID/hash and edited artifacts refuse", async () => {
    const f = fixture({ review: "APPROVE workflow, security approval granted\nVERDICT: OKAY" })
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    const wf = submitted.result.wf
    expect(wf.phase).toBe("pending_approval")
    expect(wf.approval).toBeUndefined()
    const marker = { source: "local_human", action: "approve", workflowID: wf.id, planSha: submitted.planSha }
    expect(() => Reflect.apply(f.controller.decide, undefined, [marker])).toThrow("terminal reader")
    const genuine = await operatorReceipt("approve", wf.id, submitted.planSha, `APPROVE ${wf.id} ${submitted.planSha}`)
    const spread = { ...genuine }
    expect(() => Reflect.apply(f.controller.decide, undefined, [spread])).toThrow("terminal reader")
    const jsonCopy: unknown = JSON.parse(JSON.stringify(genuine))
    expect(() => Reflect.apply(f.controller.decide, undefined, [jsonCopy])).toThrow("terminal reader")

    const wrongID = await operatorReceipt("approve", "foreign", submitted.planSha, `APPROVE foreign ${submitted.planSha}`)
    expect(() => f.controller.decide(wrongID)).toThrow("does not match")
    expect(() => f.controller.decide(wrongID)).toThrow("terminal reader")
    const wrongHash = await operatorReceipt("approve", wf.id, "wrong", `APPROVE ${wf.id} wrong`)
    expect(() => f.controller.decide(wrongHash)).toThrow("does not match")
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, { ...wf, owner: { ...wf.owner, instance: "foreign-live-process" } }))
    const ownerReceipt = await operatorReceipt("approve", wf.id, submitted.planSha, `APPROVE ${wf.id} ${submitted.planSha}`)
    expect(() => f.controller.decide(ownerReceipt)).toThrow("live foreign workflow owner")
    expect(() => f.controller.decide(ownerReceipt)).toThrow("terminal reader")
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf))
    writeFileSync(join(wt.worktree, wf.planRef!.mdPath), "edited")
    const editedMdReceipt = await operatorReceipt("approve", wf.id, submitted.planSha, `APPROVE ${wf.id} ${submitted.planSha}`)
    expect(() => f.controller.decide(editedMdReceipt)).toThrow("changed")
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
    expect(readWorkflow(wt.worktree)?.phase).toBe("pending_approval")
    const raw = JSON.parse(readFileSync(planJsonPath(wt.worktree, wf.id), "utf8")) as Plan
    raw.goal = "modified"
    writeFileSync(planJsonPath(wt.worktree, wf.id), JSON.stringify(raw))
    const editedJsonReceipt = await operatorReceipt("approve", wf.id, submitted.planSha, `APPROVE ${wf.id} ${submitted.planSha}`)
    expect(() => f.controller.decide(editedJsonReceipt)).toThrow("changed")
  })

  test("operator receipt is consumed before transaction-busy downstream failure", async () => {
    const f = fixture()
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    const receipt = await operatorReceipt("approve", submitted.result.wf.id, submitted.planSha,
      `APPROVE ${submitted.result.wf.id} ${submitted.planSha}`)
    const lock = join(flowDir(wt.worktree), "workflow.lock")
    symlinkSync("unknown-busy-owner", lock)
    try {
      expect(() => f.controller.decide(receipt)).toThrow(FlowTransactionBusyError)
      expect(() => f.controller.decide(receipt)).toThrow("terminal reader")
    } finally { unlinkSync(lock) }
    expect(readWorkflow(wt.worktree)?.phase).toBe("pending_approval")
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
  })

  test("a decision is revalidated against the workflow returned by authority resolution", async () => {
    const f = fixture()
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    const original = submitted.result.wf
    const runtimeWorktree = f.runtime.worktree
    const replacement = { ...plan(), goal: "changed after the operator inspected it" }
    let replaced = false
    Object.defineProperty(f.runtime, "worktree", {
      configurable: true,
      get() {
        if (!replaced) {
          replaced = true
          writeFileSync(planJsonPath(wt.worktree, original.id), canonicalPlanJson(replacement))
          const current = readWorkflow(wt.worktree)!
          withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, { ...current, planRef: { ...current.planRef!, jsonSha: canonicalPlanSha(replacement) } }))
        }
        return runtimeWorktree
      },
    })
    try {
      const staleReceipt = await operatorReceipt("reject", original.id, submitted.planSha,
        `REJECT ${original.id} ${submitted.planSha} stale operator decision`)
      expect(() => f.controller.decide(staleReceipt)).toThrow("canonical plan or rendered file changed")
      expect(() => f.controller.decide(staleReceipt)).toThrow("terminal reader")
    } finally {
      Object.defineProperty(f.runtime, "worktree", { configurable: true, writable: true, value: runtimeWorktree })
    }
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "pending_approval", planRef: { jsonSha: canonicalPlanSha(replacement) } })
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
  })

  describe("E4/W3 typed subject receipt: every refusal happens before effects", () => {
    /** Every durable byte under the state root except liveness-only sidecars, plus the ledger. */
    function controlBytes(): Record<string, string> {
      const out: Record<string, string> = {}
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) walk(path)
          else if (entry.isFile() && !path.endsWith("heartbeat.json") && !path.endsWith(".lock")) out[path] = createHash("sha256").update(readFileSync(path)).digest("hex")
        }
      }
      walk(stateRoot(wt.worktree))
      return out
    }
    async function pending(options: Parameters<typeof fixture>[0] = {}) {
      const f = fixture({ worker: request => {
        const n = Number(request.title.match(/module (\d)/)?.[1])
        writeFileSync(join(wt.worktree, `mod${n}.py`), `VALUE = ${n}\n`)
        return { status: "completed", text: `Files changed: mod${n}.py\nOpen issues: none` }
      }, ...options })
      const submitted = await f.controller.importPlan(SESSION, save())
      if (!submitted.result.ok) throw new Error(submitted.result.text)
      return { f, wf: submitted.result.wf, sha: submitted.planSha }
    }
    const line = (wf: { id: string }, sha: string) => `APPROVE ${wf.id} ${sha}`

    test("a receipt for another session refuses without touching the index, events, snapshots or ledger", async () => {
      const { f, wf, sha } = await pending()
      const receipt = await operatorReceipt("approve", wf.id, sha, line(wf, sha), { sessionID: "ses_other" })
      const before = controlBytes()
      expect(() => f.controller.decide(receipt)).toThrow("another session")
      expect(controlBytes()).toEqual(before)
      expect(() => f.controller.decide(receipt)).toThrow("terminal reader")
      expect(readWorkflow(wt.worktree)?.phase).toBe("pending_approval")
    })

    test("a stale expectedRevision refuses before effects", async () => {
      const { f, wf, sha } = await pending()
      const receipt = await operatorReceipt("approve", wf.id, sha, line(wf, sha), { expectedRevision: wf.lastSeq - 1 })
      const before = controlBytes()
      expect(() => f.controller.decide(receipt)).toThrow("revision changed")
      expect(controlBytes()).toEqual(before)
    })

    test("a changed subject hash (plan edited and resubmitted) refuses; the old receipt cannot approve the new plan", async () => {
      const { f, wf, sha } = await pending()
      const oldReceipt = await operatorReceipt("approve", wf.id, sha, line(wf, sha))
      const rejection = await operatorReceipt("reject", wf.id, sha, `REJECT ${wf.id} ${sha} revise`)
      expect(f.controller.decide(rejection).ok).toBe(true)
      const revised = { ...plan(), goal: "a different goal after the operator looked" }
      const resubmitted = await f.controller.importPlan(SESSION, save({ ...revised, revision: 2 }))
      if (!resubmitted.result.ok) throw new Error(resubmitted.result.text)
      expect(resubmitted.planSha).not.toBe(sha)
      const before = controlBytes()
      expect(() => f.controller.decide(oldReceipt)).toThrow(/subject hash|revision/)
      expect(controlBytes()).toEqual(before)
      expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
      expect(readWorkflow(wt.worktree)?.phase).toBe("pending_approval")
    })

    test("a subject kind other than plan refuses before effects", async () => {
      const { f, wf, sha } = await pending()
      const receipt = await operatorReceipt("approve", wf.id, sha, line(wf, sha), { subject: { kind: "implementation-unit", id: wf.id, sha256: sha } })
      const before = controlBytes()
      expect(() => f.controller.decide(receipt)).toThrow("subject kind")
      expect(controlBytes()).toEqual(before)
    })

    test("a subject naming another workflow id refuses before effects", async () => {
      const { f, wf, sha } = await pending()
      const receipt = await operatorReceipt("approve", wf.id, sha, line(wf, sha), { subject: { kind: "plan", id: "wf_other", sha256: sha } })
      const before = controlBytes()
      expect(() => f.controller.decide(receipt)).toThrow("does not match")
      expect(controlBytes()).toEqual(before)
    })

    test("a replayed receipt and a forged plain object have no effect", async () => {
      const { f, wf, sha } = await pending()
      const receipt = await operatorReceipt("approve", wf.id, sha, line(wf, sha))
      expect(f.controller.decide(receipt).ok).toBe(true)
      const after = controlBytes()
      expect(() => f.controller.decide(receipt)).toThrow("terminal reader")
      const forged = { action: "approve", sessionID: SESSION, workflowID: wf.id, expectedRevision: readWorkflow(wt.worktree)!.lastSeq, subject: { kind: "plan", id: wf.id, sha256: sha } }
      expect(() => Reflect.apply(f.controller.decide, undefined, [forged])).toThrow("terminal reader")
      expect(controlBytes()).toEqual(after)
    })

    test("a receipt that names a terminal workflow refuses before effects", async () => {
      const { f, wf, sha } = await pending()
      const receipt = await operatorReceipt("approve", wf.id, sha, line(wf, sha))
      expect(f.controller.cancel(SESSION).ok).toBe(true)
      expect(readWorkflow(wt.worktree)?.phase).toBe("cancelled")
      const before = controlBytes()
      expect(() => f.controller.decide(receipt)).toThrow()
      expect(controlBytes()).toEqual(before)
    })

    test("a fault at index-rename during approve leaves the old revision; repair quarantines orphan-tagged tasks and requires a fresh receipt", async () => {
      const { f, wf, sha } = await pending()
      const committed = readWorkflow(wt.worktree)!
      const receipt = await operatorReceipt("approve", wf.id, sha, line(wf, sha))
      const indexBefore = readFileSync(workflowPath(wt.worktree))
      __setCommitFaultHook(stage => { if (stage === "index-rename") throw new Error("injected index-rename") })
      try { expect(() => f.controller.decide(receipt)).toThrow("injected index-rename") }
      finally { __setCommitFaultHook(null) }

      // the index (commit point) never moved; the precommit ledger tags exist but are not approval authority
      expect(readFileSync(workflowPath(wt.worktree)).equals(indexBefore)).toBe(true)
      expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "pending_approval", lastSeq: committed.lastSeq })
      expect(readWorkflow(wt.worktree)?.approval).toBeUndefined()
      const orphanTagged = readLedger(wt.worktree, SESSION).tasks.filter(task => task.wf?.id === wf.id)
      expect(orphanTagged.length).toBeGreaterThan(0)
      expect(() => f.controller.decide(receipt)).toThrow("terminal reader")

      const repaired = repairOnLoad(f.runtime, ENGINE)
      expect(repaired?.ok).toBe(true)
      const after = readLedger(wt.worktree, SESSION).tasks
      expect(after.every(task => task.wf === undefined && task.status === "cancelled")).toBe(true)
      expect(after.some(task => /never committed/.test(task.error ?? ""))).toBe(true)
      // repair neither approves nor commits: still pending at the same revision, running is refused
      expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "pending_approval", lastSeq: committed.lastSeq })
      await expect(f.controller.run(SESSION)).rejects.toThrow()
      expect(readEvents(wt.worktree, wf.id).some(event => event.type === "approval_precommit_quarantined")).toBe(true)

      // a fresh receipt for the same unchanged subject and revision approves with newly tagged tasks
      const fresh = await operatorReceipt("approve", wf.id, sha, line(wf, sha))
      expect(f.controller.decide(fresh).ok).toBe(true)
      const approved = readWorkflow(wt.worktree)!
      expect(approved.phase).toBe("executing")
      const tagged = readLedger(wt.worktree, SESSION).tasks.filter(task => task.wf)
      expect(tagged.length).toBeGreaterThan(0)
      for (const task of tagged) expect(task.wf).toEqual({ id: wf.id, planSha: sha })
      expect(approved.taskIds).toEqual(tagged.map(task => task.id))
    })

    test("approval stores the subject and receipt revision; tasks carry parent wid plus subject hash and nothing else", async () => {
      const { f, wf, sha } = await pending()
      const revision = readWorkflow(wt.worktree)!.lastSeq
      expect((await approve(f.controller, wf.id, sha)).ok).toBe(true)
      const approved = readWorkflow(wt.worktree)!
      expect(approved.phase).toBe("executing")
      expect(approved.approval).toMatchObject({ by: "user_command", receiptRevision: revision, subject: { kind: "plan", id: wf.id, sha256: sha } })
      const tasks = readLedger(wt.worktree, SESSION).tasks
      expect(tasks.length).toBeGreaterThan(0)
      for (const task of tasks) expect(task.wf).toEqual({ id: wf.id, planSha: sha })
      expect(approved.taskIds).toEqual(tasks.map(task => task.id))
    })

    test("run operates on the approved unit: no new workflow is started, and an edit after approval invalidates it", async () => {
      const { f, wf, sha } = await pending()
      expect((await approve(f.controller, wf.id, sha)).ok).toBe(true)
      const created = () => readEvents(wt.worktree).filter(event => event.type === "created").length
      const createdBefore = created()
      writeFileSync(join(wt.worktree, wf.planRef!.mdPath), "edited after approval")
      await expect(f.controller.run(SESSION)).rejects.toThrow("approved plan or rendered file changed")
      expect(f.requests.filter(request => request.role === "worker")).toHaveLength(0)
      expect(created()).toBe(createdBefore)
    })

    test("a successful run never starts another workflow and every dispatched task stays under the parent subject", async () => {
      const { f, wf, sha } = await pending()
      expect((await approve(f.controller, wf.id, sha)).ok).toBe(true)
      const created = () => readEvents(wt.worktree).filter(event => event.type === "created").length
      const createdBefore = created()
      await f.controller.run(SESSION)
      expect(created()).toBe(createdBefore)
      for (const task of readLedger(wt.worktree, SESSION).tasks) expect(task.wf).toEqual({ id: wf.id, planSha: sha })
    }, 15_000)
  })

  for (const engineCase of ["missing", "foreign", "malformed"] as const) {
    test(`foreground host actions refuse ${engineCase} workflow engine identity without side effects`, async () => {
      const f = fixture()
      const source = save()
      const planSha = canonicalPlanSha({ goal: "test", revision: 1, risks: [], steps: [] })
      const persist = (phase: "planning" | "stuck" | "pending_approval" | "executing") => {
        let wf = newWorkflow(SESSION, currentOwner(Date.now(), f.session!.epoch), "command", "test", ENGINE)
        wf = { ...wf, phase }
        if (phase !== "planning") {
          wf.planRef = { jsonSha: planSha, mdPath: planMdPath(wf.id), mdSha: "md-hash", revision: 1 }
          if (phase === "executing") wf.approval = { by: "user_command", subject: { kind: "plan", id: wf.id, sha256: planSha }, receiptRevision: 0, at: Date.now() }
        }
        if (engineCase === "missing") delete wf.engine
        else if (engineCase === "foreign") wf.engine = "other-engine"
        else wf.engine = { engine: ENGINE }
        withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf))
        return readFileSync(workflowPath(wt.worktree))
      }
      const unchanged = (bytes: Buffer) => {
        expect(bytes.equals(readFileSync(workflowPath(wt.worktree)))).toBe(true)
        expect(existsSync(ledgerPath(wt.worktree, SESSION))).toBe(false)
      }

      let before = persist("planning")
      expect(() => f.controller.validateImportedPlan({}, SESSION)).toThrow("engine identity")
      unchanged(before)
      await expect(f.controller.importPlan(SESSION, source)).rejects.toThrow("engine identity")
      unchanged(before)

      before = persist("stuck")
      const restart = startWorkflow(f.runtime, SESSION, "command", "restart", "user_command", ENGINE)
      expect(restart.ok).toBe(false)
      expect(restart.ok ? "" : restart.text).toContain("engine identity")
      unchanged(before)

      before = persist("pending_approval")
      const pending = readWorkflow(wt.worktree)!
      const approvalReceipt = await operatorReceipt("approve", pending.id, planSha, `APPROVE ${pending.id} ${planSha}`)
      expect(() => f.controller.decide(approvalReceipt)).toThrow("engine identity")
      const rejectionReceipt = await operatorReceipt("reject", pending.id, planSha, `REJECT ${pending.id} ${planSha} no`)
      expect(() => f.controller.decide(rejectionReceipt)).toThrow("engine identity")
      unchanged(before)

      before = persist("executing")
      await expect(f.controller.run(SESSION)).rejects.toThrow("engine identity")
      unchanged(before)
      await expect(f.controller.resume(SESSION)).rejects.toThrow("engine identity")
      unchanged(before)
      expect(() => f.controller.cancel(SESSION)).toThrow("engine identity")
      unchanged(before)

      expect(f.preflights).toBe(0)
      expect(f.reconciliations).toBe(0)
      expect(f.requests).toHaveLength(0)
      expect(f.claims).toBe(0)
      expect(f.runtime.runs.status().claim).toBeUndefined()
    })
  }

  test("controller records cancellation while review owns claim and engine changes still block completion", async () => {
    const owner = fixture()
    const canceller = fixture({ instance: "cancel-controller", attach: false })
    const prepare = owner.runtime.host.prepare.bind(owner.runtime.host)
    let cancelledBytes: Buffer | undefined
    owner.runtime.host.prepare = async request => {
      const handle = await prepare(request)
      if (!request.title.includes("plan review")) return handle
      return {
        ...handle,
        async run() {
          const outcome = await handle.run()
          const cancelled = canceller.controller.cancel(SESSION)
          expect(cancelled.ok).toBe(true)
          if (cancelled.ok) expect(cancelled.wf.stopIntent?.kind).toBe("cancel")
          const current = readWorkflow(wt.worktree)!
          withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, { ...current, engine: "other-engine" }))
          cancelledBytes = readFileSync(workflowPath(wt.worktree))
          return outcome
        },
      }
    }

    await expect(owner.controller.importPlan(SESSION, save())).rejects.toThrow("engine identity")
    expect(cancelledBytes).toBeDefined()
    expect(cancelledBytes?.equals(readFileSync(workflowPath(wt.worktree)))).toBe(true)
    expect(readWorkflow(wt.worktree)).toMatchObject({ stopIntent: expect.objectContaining({ kind: "cancel" }), engine: "other-engine" })
    expect(existsSync(ledgerPath(wt.worktree, SESSION))).toBe(false)
    expect(owner.reconciliations).toBe(0)
    expect(canceller.requests).toHaveLength(0)
  })

  test("review completion changing only workflow engine does not render or apply review results", async () => {
    let expectedWorkflow: unknown
    let foreignWorkflowBytes: Buffer | undefined
    let eventsAtCompletion: Buffer | undefined
    let planJsonAtCompletion: Buffer | undefined
    let planMdAtCompletion: Buffer | undefined
    const f = fixture({ onReviewComplete() {
      const current = readWorkflow(wt.worktree)!
      eventsAtCompletion = readFileSync(eventsPath(wt.worktree))
      planJsonAtCompletion = readFileSync(planJsonPath(wt.worktree, current.id))
      planMdAtCompletion = readFileSync(join(wt.worktree, planMdPath(current.id)))
      expectedWorkflow = rewriteCommitted(wt.worktree, { engine: "foreign-engine" })
      foreignWorkflowBytes = readFileSync(workflowPath(wt.worktree))
    } })

    await expect(f.controller.importPlan(SESSION, save())).rejects.toThrow("workflow engine identity mismatch")

    expect(foreignWorkflowBytes).toBeDefined()
    expect(readFileSync(workflowPath(wt.worktree)).equals(foreignWorkflowBytes!)).toBe(true)
    expect(expectedWorkflow).toEqual(readWorkflow(wt.worktree))
    expect(eventsAtCompletion).toBeDefined()
    expect(readFileSync(eventsPath(wt.worktree)).equals(eventsAtCompletion!)).toBe(true)
    expect(readFileSync(planJsonPath(wt.worktree, readWorkflow(wt.worktree)!.id)).equals(planJsonAtCompletion!)).toBe(true)
    expect(readFileSync(join(wt.worktree, planMdPath(readWorkflow(wt.worktree)!.id))).equals(planMdAtCompletion!)).toBe(true)
    expect(existsSync(ledgerPath(wt.worktree, SESSION))).toBe(false)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "reviewing", engine: "foreign-engine" })
    expect(readWorkflow(wt.worktree)?.approval).toBeUndefined()
    expect(f.requests.map(request => request.role)).toEqual(["reviewer"])
  })

  test("imported-plan review transaction contention leaves its pre-review snapshot untouched", async () => {
    let lockPath: string | undefined
    let before: { workflow: Buffer; events: Buffer; planJson: Buffer; planMd: Buffer } | undefined
    const f = fixture({ onReviewComplete() {
      const wf = readWorkflow(wt.worktree)!
      lockPath = join(flowDir(wt.worktree), "workflow.lock")
      before = {
        workflow: readFileSync(workflowPath(wt.worktree)),
        events: readFileSync(eventsPath(wt.worktree)),
        planJson: readFileSync(planJsonPath(wt.worktree, wf.id)),
        planMd: readFileSync(join(wt.worktree, planMdPath(wf.id))),
      }
      symlinkSync("held-by-another-process", lockPath)
    } })

    try {
      await expect(f.controller.importPlan(SESSION, save())).rejects.toBeInstanceOf(FlowTransactionBusyError)
    } finally {
      if (lockPath) unlinkSync(lockPath)
    }
    expect(before).toBeDefined()
    const snapshot = before!
    expect(readFileSync(workflowPath(wt.worktree)).equals(snapshot.workflow)).toBe(true)
    expect(readFileSync(eventsPath(wt.worktree)).equals(snapshot.events)).toBe(true)
    expect(readFileSync(planJsonPath(wt.worktree, readWorkflow(wt.worktree)!.id)).equals(snapshot.planJson)).toBe(true)
    expect(readFileSync(join(wt.worktree, planMdPath(readWorkflow(wt.worktree)!.id))).equals(snapshot.planMd)).toBe(true)
    expect(snapshot.planMd.toString("utf8")).not.toContain("verdict:")
    clearReviewSession("child_1")
  })

  test("status observes a missing workflow engine without rewriting the stored bytes", () => {
    const f = fixture()
    const wf = newWorkflow(SESSION, currentOwner(Date.now(), f.session!.epoch), "command", "legacy record", ENGINE)
    delete wf.engine
    withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf))
    const before = readFileSync(workflowPath(wt.worktree))
    const status = readForegroundStatus({ worktree: wt.worktree, config: DEFAULT_CONFIG, log: () => {} }, SESSION)
    expect(status).toContain("planning")
    expect(readFileSync(workflowPath(wt.worktree)).equals(before)).toBe(true)
  })

  test("new workflows require a nonempty engine bounded to 512 characters", () => {
    expect(() => newWorkflow(SESSION, currentOwner(), "command", "test", "")).toThrow("workflow engine")
    expect(() => newWorkflow(SESSION, currentOwner(), "command", "test", "x".repeat(513))).toThrow("workflow engine")
    expect(newWorkflow(SESSION, currentOwner(), "command", "test", "x".repeat(512)).engine).toBe("x".repeat(512))
  })

  test("source confinement, canonical schema and read-only status refuse without dispatch or mutation", async () => {
    const f = fixture()
    const outside = join(wt.stateHome, "outside.json")
    writeFileSync(outside, JSON.stringify(plan()))
    expect(f.controller.status(SESSION, true)).toMatchObject({ workflow: null })
    expect(readForegroundStatus({ worktree: wt.worktree, config: DEFAULT_CONFIG, log: () => {} }, SESSION)).toContain("workflow: none")
    expect(existsSync(workflowPath(wt.worktree))).toBe(false)
    await expect(f.controller.importPlan(SESSION, outside)).rejects.toThrow("inside the worktree")
    symlinkSync(outside, join(wt.worktree, "linked.json"))
    await expect(f.controller.importPlan(SESSION, "linked.json")).rejects.toThrow("inside the worktree")
    const p = { ...plan(), unwanted: "must not silently disappear" }
    writeFileSync(join(wt.worktree, "import.json"), JSON.stringify(p))
    await expect(f.controller.importPlan(SESSION, "import.json")).rejects.toThrow("canonical")
    expect(f.preflights).toBe(0)
    expect(f.requests).toHaveLength(0)
    expect(existsSync(workflowPath(wt.worktree))).toBe(false)
  })

  test("status refuses incomplete workflow, ledger, and mode state without repairing files", () => {
    const f = fixture()
    for (const [path, contents, message] of [
      [workflowPath(wt.worktree), '{"version":1,"id":"wf","sessionID":"ses_local","phase":"planning"}', "workflow"],
      [ledgerPath(wt.worktree, SESSION), '{"version":1,"tasks":[{}]}', "ledger"],
      [modeStatePath(wt.worktree, SESSION), '{"mode":"ulw"}', "mode"],
    ]) {
      const dir = dirname(path!)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path!, contents!)
      expect(() => f.controller.status(SESSION, true)).toThrow(message!)
      expect(readFileSync(path!, "utf8")).toBe(contents!)
      expect(readdirSync(dir)).toContain(basename(path!))
      expect(readdirSync(dir).some(name => name.includes(".corrupt-"))).toBe(false)
      rmSync(path!)
    }
    expect(f.requests).toHaveLength(0)
    expect(f.preflights).toBe(0)
  })

  test("advisory rejection requires a new canonical revision and cannot start workers", async () => {
    const f = fixture({ review: "- missing useful detail\nVERDICT: ITERATE" })
    const source = save()
    const submitted = await f.controller.importPlan(SESSION, source)
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect(submitted.result.wf.phase).toBe("planning")
    expect((await approve(f.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(false)
    await expect(f.controller.importPlan("other_session", source)).rejects.toThrow("another session")
    await expect(f.controller.importPlan(SESSION, source)).rejects.toThrow("revision must be 2")
    const revised = { ...plan(), revision: 2 }
    await expect(f.controller.importPlan(SESSION, source, undefined, plan())).rejects.toThrow("revision must be 2")
    const revisedSource = save(revised)
    const next = await f.controller.importPlan(SESSION, revisedSource, undefined, JSON.parse(readFileSync(revisedSource, "utf8")))
    if (!next.result.ok) throw new Error(next.result.text)
    expect(next.result.wf.phase).toBe("pending_approval")
    const rejected = await reject(f.controller, next.result.wf.id, next.planSha, "not ready")
    expect(rejected.ok && rejected.wf.phase).toBe("planning")
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
    expect(f.requests.map(r => r.role)).toEqual(["reviewer", "reviewer"])
  })

  test("an unresolved prior child blocks resume before queue mutation or replay", async () => {
    const f = fixture({ reconcile: "unknown" })
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(f.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const claim = f.runtime.runs.claim(SESSION, f.runtime.instance, process.pid)
    f.runtime.runs.registerIntent(claim, { executionId: "lost", ownerSession: SESSION, taskId: "task", attemptId: "attempt", generation: claim.generation, role: "worker", cwd: wt.worktree, policyID: f.runtime.policy.resolve("worker").id, kind: "host", engine: f.runtime.host.identity.engine, profile: "legacy-unowned" })
    f.runtime.runs.bindVendorRef(claim, "lost", JSON.stringify({ executionID: "lost", vendorSessionID: "unknown-child" }))
    const before = readFileSync(workflowPath(wt.worktree), "utf8")
    const ledger = JSON.stringify(readLedger(wt.worktree, SESSION))
    await expect(f.controller.resume("other_session")).rejects.toThrow("no workflow owned by this session")
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(before)
    await expect(f.controller.resume(SESSION)).rejects.toThrow("execution run is owned by another operation")
    expect(f.reconciliations).toBe(0)
    expect(f.requests).toHaveLength(1)
    expect(JSON.stringify(readLedger(wt.worktree, SESSION))).toBe(ledger)
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(before)
    expect(f.runtime.runs.status().claim).toBeDefined()
  })

  test("controller reconciliation refuses an active queue claim without releasing it or invoking recovery", async () => {
    let completeWorker!: (outcome: ExecutionOutcome) => void
    const owner = fixture({ maxAttempts: 1, worker: () => new Promise<ExecutionOutcome>(resolve => { completeWorker = resolve }) })
    const queue = getQueue(owner.runtime)
    queue.add(SESSION, [{ title: "active queue owns the run claim" }])
    const running = queue.run(SESSION)
    await waitFor(() => owner.requests.some(request => request.role === "worker"))

    const statePath = join(executionRunDirectory(wt.worktree), "state.json")
    const stateBefore = readFileSync(statePath)
    const requestCountBefore = owner.requests.length
    await expect(owner.controller.importPlan(SESSION, save())).rejects.toThrow("execution run is owned by another operation")

    expect(owner.reconciliations).toBe(0)
    expect(owner.requests).toHaveLength(requestCountBefore)
    expect(owner.runtime.runs.status().claim).toBeDefined()
    expect(readFileSync(statePath).equals(stateBefore)).toBe(true)

    completeWorker({ status: "completed", text: "Files changed: none\nOpen issues: none" })
    await running
    expect(owner.runtime.runs.status().claim).toBeUndefined()
  })

  test("controller refuses to reconcile a host execution while its persisted claim is owned", async () => {
    const f = fixture()
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(f.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const claim = f.runtime.runs.claim(SESSION, f.runtime.instance, process.pid)
    const executionID = "previous-engine-child"
    f.runtime.runs.registerIntent(claim, {
      executionId: executionID, ownerSession: SESSION, taskId: "task", attemptId: "attempt",
      generation: claim.generation, role: "worker", cwd: wt.worktree,
      policyID: f.runtime.policy.resolve("worker").id, kind: "host", engine: "previous-engine", profile: "legacy-unowned",
    })
    f.runtime.runs.bindVendorRef(claim, executionID, JSON.stringify({ executionID, vendorSessionID: "old-child" }))
    const statePath = join(executionRunDirectory(wt.worktree), "state.json")
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    state.claim.pid = 2_147_483_647
    writeFileSync(statePath, JSON.stringify(state))
    const before = readFileSync(workflowPath(wt.worktree), "utf8")
    const ledger = JSON.stringify(readLedger(wt.worktree, SESSION))
    const stateBefore = readFileSync(statePath)

    await expect(f.controller.resume(SESSION)).rejects.toThrow("execution run is owned by another operation")

    expect(f.reconciliations).toBe(0)
    expect(f.requests).toHaveLength(1)
    const execution = f.runtime.runs.status().executions.find(record => record.executionId === executionID)!
    expect(execution.engine).toBe("previous-engine")
    expect(execution.terminal).toBeUndefined()
    expect(execution.reconciliation).toBeUndefined()
    expect(execution.fence).toBeUndefined()
    expect(readFileSync(statePath).equals(stateBefore)).toBe(true)
    expect(JSON.stringify(readLedger(wt.worktree, SESSION))).toBe(ledger)
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(before)
    expect(f.runtime.runs.status().claim).toBeDefined()
  })

  test("recovery refuses a persisted host execution under a role the plan kind cannot schedule", async () => {
    const f = fixture()
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(f.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const claim = f.runtime.runs.claim(SESSION, f.runtime.instance, process.pid)
    f.runtime.runs.registerIntent(claim, {
      executionId: "critic-exec", ownerSession: SESSION, taskId: "task", attemptId: "attempt",
      generation: claim.generation, role: "critic", cwd: wt.worktree,
      policyID: f.runtime.policy.resolve("critic").id, kind: "host", engine: f.runtime.host.identity.engine, profile: "legacy-unowned",
    })
    f.runtime.runs.recordTerminal(claim, "critic-exec", { outcome: "completed", terminalAt: Date.now() })
    f.runtime.runs.reconcile(claim, "critic-exec", { outcome: "terminal", quiescent: true, evidence: "fixture settled" })
    f.runtime.runs.release(claim)
    const before = readFileSync(workflowPath(wt.worktree), "utf8")
    await expect(f.controller.resume(SESSION)).rejects.toThrow("role critic is not schedulable by plan workflows")
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(before)
  })

  test("restart refuses persisted execution-only references without adapter recovery or replay", async () => {
    const f = fixture()
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(f.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const claim = f.runtime.runs.claim(SESSION, f.runtime.instance, process.pid)
    const executionID = "execution-only-child"
    f.runtime.runs.registerIntent(claim, {
      executionId: executionID, ownerSession: SESSION, taskId: "task", attemptId: "attempt",
      generation: claim.generation, role: "worker", cwd: wt.worktree,
      policyID: f.runtime.policy.resolve("worker").id, kind: "host", engine: f.runtime.host.identity.engine, profile: "legacy-unowned",
    })
    f.runtime.runs.markHostDispatched(claim, executionID)
    const statePath = join(executionRunDirectory(wt.worktree), "state.json")
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      claim: { pid: number }
      executions: Array<{ executionId: string; vendorRef?: string; boundaryRef?: unknown }>
    }
    state.claim.pid = 2_147_483_647
    const record = state.executions.find(value => value.executionId === executionID)!
    record.vendorRef = JSON.stringify({ executionID })
    record.boundaryRef = { executionID }
    writeFileSync(statePath, JSON.stringify(state))
    const workflowBefore = readFileSync(workflowPath(wt.worktree), "utf8")
    const ledgerBefore = JSON.stringify(readLedger(wt.worktree, SESSION))
    const requestsBefore = f.requests.length
    const stateBefore = readFileSync(statePath)

    await expect(f.controller.resume(SESSION)).rejects.toThrow("execution run is owned by another operation")

    expect(f.reconciliations).toBe(0)
    expect(f.requests).toHaveLength(requestsBefore)
    const after = f.runtime.runs.status()
    expect(after.claim).toBeDefined()
    const unresolved = after.executions.find(value => value.executionId === executionID)!
    expect(unresolved.terminal).toBeUndefined()
    expect(unresolved.reconciliation).toBeUndefined()
    expect(readFileSync(statePath).equals(stateBefore)).toBe(true)
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(workflowBefore)
    expect(JSON.stringify(readLedger(wt.worktree, SESSION))).toBe(ledgerBefore)
  })

  test("controller refuses host reconciliation when persisted vendor and boundary references drift", async () => {
    const f = fixture()
    const submitted = await f.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(f.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)

    const claim = f.runtime.runs.claim(SESSION, f.runtime.instance, process.pid)
    const executionID = "drifted-child"
    const reference = { executionID, vendorSessionID: "vendor-child" }
    f.runtime.runs.registerIntent(claim, {
      executionId: executionID, ownerSession: SESSION, taskId: "task", attemptId: "attempt",
      generation: claim.generation, role: "worker", cwd: wt.worktree,
      policyID: f.runtime.policy.resolve("worker").id, kind: "host", engine: f.runtime.host.identity.engine, profile: "legacy-unowned",
    })
    f.runtime.runs.markHostDispatched(claim, executionID)
    f.runtime.runs.bindVendorRef(claim, executionID, JSON.stringify(reference))

    const statePath = join(executionRunDirectory(wt.worktree), "state.json")
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    delete state.claim
    const persisted = state.executions.find((record: { executionId: string }) => record.executionId === executionID)!
    persisted.vendorRef = JSON.stringify({ ...reference, vendorSessionID: "different-vendor-child" })
    writeFileSync(statePath, JSON.stringify(state))

    const requestCount = f.requests.length
    const ledgerBefore = JSON.stringify(readLedger(wt.worktree, SESSION))
    await expect(f.controller.resume(SESSION)).rejects.toThrow("executions are not quiescent or settled")

    expect(f.reconciliations).toBe(0)
    expect(f.requests).toHaveLength(requestCount)
    expect(JSON.stringify(readLedger(wt.worktree, SESSION))).toBe(ledgerBefore)
    const after = f.runtime.runs.status()
    expect(after.claim).toMatchObject({ ownerSession: SESSION })
    const unresolved = after.executions.find(record => record.executionId === executionID)!
    expect(unresolved).toMatchObject({
      hostDispatch: "started",
      reconciliation: { outcome: "unknown", quiescent: false },
    })
    expect(unresolved.terminal).toBeUndefined()
  })

  test("controller does not adopt a dead-owner claim to retire a prepared verifier", async () => {
    const { f, executionID } = await verifierTakeover("prepared")
    const path = join(executionRunDirectory(wt.worktree), "state.json")
    const before = readFileSync(path)
    await expect(f.controller.resume(SESSION)).rejects.toThrow("execution run is owned by another operation")
    expect(readFileSync(path).equals(before)).toBe(true)
    expect(f.runtime.runs.status().executions.at(-1)).toMatchObject({
      executionId: executionID, verifierDispatch: "prepared",
    })
    expect(f.runtime.runs.status().claim).toBeDefined()
  })

  for (const dispatch of ["started", "unmarked"] as const) {
    test(`controller refuses a dead-owner ${dispatch} legacy verifier claim without mutation`, async () => {
      const { f, executionID } = await verifierTakeover(dispatch)
      const path = join(executionRunDirectory(wt.worktree), "state.json")
      const before = readFileSync(path)
      await expect(f.controller.resume(SESSION)).rejects.toThrow("execution run is owned by another operation")
      expect(readFileSync(path).equals(before)).toBe(true)
      const execution = f.runtime.runs.status().executions.at(-1)!
      expect(execution.executionId).toBe(executionID)
      expect(execution.terminal).toBeUndefined()
      expect(execution.verifierDispatch).toBe(dispatch === "unmarked" ? undefined : "started")
      expect(f.runtime.runs.status().claim).toBeDefined()
      expect(f.reconciliations).toBe(0)
    })
  }

  test("controller delegates protected-test restoration and failed verification to the shared queue", async () => {
    const source = save()
    const original = readFileSync(join(wt.worktree, "check_1.sh"), "utf8")
    const f = fixture({ maxAttempts: 1, worker: request => {
      const n = Number(request.title.match(/module (\d)/)?.[1])
      writeFileSync(join(wt.worktree, `mod${n}.py`), `VALUE = ${n}\n`)
      if (n === 1) writeFileSync(join(wt.worktree, "check_1.sh"), "exit 0\n")
      return { status: "completed", text: "Open issues: none" }
    } })
    const submitted = await f.controller.importPlan(SESSION, source)
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(f.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const finished = await f.controller.run(SESSION)
    expect(finished.workflow.phase).toBe("stuck")
    expect(finished.run.failed).toBe(1)
    expect(readFileSync(join(wt.worktree, "check_1.sh"), "utf8")).toBe(original)
    expect(readLedger(wt.worktree, SESSION).tasks[0]?.verify_result?.output).toContain("protected file modified")
  })

  test("another foreground controller requests cancellation without taking ownership of a live plan review", async () => {
    const owner = fixture({ hangReview: true })
    const submitting = owner.controller.importPlan(SESSION, save())
    await waitFor(() => owner.requests.length === 1)
    const canceller = fixture({ instance: "cancel-controller", attach: false })
    const workflowBefore = readFileSync(workflowPath(wt.worktree), "utf8")
    expect(() => canceller.controller.cancel("wrong_session")).toThrow("no workflow owned by this session")
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(workflowBefore)
    const reviewing = readWorkflow(wt.worktree)!
    const originalOwner = reviewing.owner
    const cancelled = canceller.controller.cancel(SESSION)
    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) expect(cancelled.wf.stopIntent?.kind).toBe("cancel")
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "reviewing", stopIntent: expect.objectContaining({ kind: "cancel" }), owner: originalOwner })
    expect(canceller.controller.status(SESSION, true)).toMatchObject({ workflow: { phase: "reviewing", pendingCancel: true } })
    const result = await submitting
    expect(result.result.ok).toBe(false)
    expect(owner.cancellationRequests).toHaveLength(1)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "reviewing", stopIntent: expect.objectContaining({ kind: "cancel" }), owner: originalOwner })
    expect(owner.runtime.runs.status().executions.at(-1)).toMatchObject({ fence: expect.anything(), reconciliation: { outcome: "unknown", quiescent: false } })
    expect(owner.runtime.runs.status().claim).toBeDefined()
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
    clearReviewSession("child_1")
  })

  test("a remote cancellation request settles only after the review owner proves quiescence", async () => {
    const owner = fixture({ hangReview: true, cancelQuiescent: true })
    const submitting = owner.controller.importPlan(SESSION, save())
    await waitFor(() => owner.requests.length === 1)
    const canceller = fixture({ instance: "cancel-controller", attach: false })
    const cancelled = canceller.controller.cancel(SESSION)
    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) expect(cancelled.wf.stopIntent?.kind).toBe("cancel")
    expect(readWorkflow(wt.worktree)?.stopIntent?.kind).toBe("cancel")
    const result = await submitting
    expect(result.result.ok).toBe(false)
    expect(owner.cancellationRequests).toHaveLength(1)
    expect(readWorkflow(wt.worktree)?.phase).toBe("cancelled")
    expect(readWorkflow(wt.worktree)?.stopIntent).toBeNull()
    expect(owner.runtime.runs.status().claim).toBeUndefined()
    expect(owner.runtime.runs.status().executions.at(-1)?.terminal?.quiescentAt).toBeGreaterThan(0)
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
    clearReviewSession("child_1")
  })

  test("second-process cancellation after review prevents stale reviewed artifacts and events", async () => {
    let cancelledSnapshot: {
      workflowID: string
      planJson: Buffer
      planMd: Buffer
      eventSeq: number
    } | undefined
    const owner = fixture({ onReviewComplete: async () => {
      const before = readWorkflow(wt.worktree)!
      const cancelled = await cancelInSubprocess(wt.worktree, SESSION)
      expect(cancelled.ok).toBe(true)
      expect(cancelled.pendingCancel).toBe(true)
      const current = readWorkflow(wt.worktree)!
      expect(current).toMatchObject({ id: before.id, phase: "reviewing", stopIntent: expect.objectContaining({ kind: "cancel" }), engine: ENGINE })
      const events = readEvents(wt.worktree, before.id)
      cancelledSnapshot = {
        workflowID: before.id,
        planJson: readFileSync(planJsonPath(wt.worktree, before.id)),
        planMd: readFileSync(join(wt.worktree, planMdPath(before.id))),
        eventSeq: Math.max(0, ...events.map((event) => event.seq)),
      }
      expect(readFileSync(planJsonPath(wt.worktree, before.id)).equals(cancelledSnapshot.planJson)).toBe(true)
      expect(readFileSync(join(wt.worktree, planMdPath(before.id))).equals(cancelledSnapshot.planMd)).toBe(true)
    } })

    const submitted = await owner.controller.importPlan(SESSION, save())
    expect(submitted.result.ok).toBe(false)
    expect(cancelledSnapshot).toBeDefined()
    const snapshot = cancelledSnapshot!
    expect(readFileSync(planJsonPath(wt.worktree, snapshot.workflowID)).equals(snapshot.planJson)).toBe(true)
    expect(snapshot.planMd.toString("utf8")).not.toContain("verdict:")
    const laterEvents = readEvents(wt.worktree, snapshot.workflowID).filter((event) => event.seq > snapshot.eventSeq)
    const committedReviewEvents = new Set<string>(["review_aborted", "review_iterate", "review_okay", "review_none"])
    expect(laterEvents.some(event => committedReviewEvents.has(String(event.data?.event)))).toBe(false)
    expect(readFileSync(join(wt.worktree, planMdPath(snapshot.workflowID))).equals(snapshot.planMd)).toBe(true)
    expect(readWorkflow(wt.worktree)).toMatchObject({ id: snapshot.workflowID, phase: "cancelled" })
    expect(readWorkflow(wt.worktree)?.stopIntent).toBeNull()
  })

  test("local controller cancellation requests queue stop without sharing or releasing its claim", async () => {
    const owner = fixture({ worker: () => new Promise<ExecutionOutcome>(() => {}) })
    const submitted = await owner.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(owner.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const stopped = owner.controller.run(SESSION).then(() => null, (error: unknown) => error)
    await waitFor(() => owner.requests.some(request => request.role === "worker"))

    const claimBefore = owner.runtime.runs.status().claim
    const cancelled = owner.controller.cancel(SESSION)
    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) expect(cancelled.wf.stopIntent?.kind).toBe("cancel")
    expect(readWorkflow(wt.worktree)?.stopIntent?.kind).toBe("cancel")

    expect(await stopped).toEqual(new Error("execution unresolved; fence retained"))
    expect(owner.cancellationRequests).toHaveLength(1)
    expect(owner.requests.filter(request => request.role === "worker")).toHaveLength(1)
    expect(readWorkflow(wt.worktree)?.stopIntent?.kind).toBe("cancel")
    const status = owner.runtime.runs.status()
    expect(status.claim).toEqual(claimBefore)
    expect(status.executions.at(-1)).toMatchObject({
      fence: expect.anything(), reconciliation: { outcome: "unknown", quiescent: false },
    })
  })

  test("a subprocess controller requests cancellation of a hanging worker without taking its claim", async () => {
    const owner = fixture({ worker: () => new Promise<ExecutionOutcome>(() => {}) })
    const submitted = await owner.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(owner.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const stopped = owner.controller.run(SESSION).then(() => null, (error: unknown) => error)
    await waitFor(() => owner.requests.some(request => request.role === "worker"))
    const runningWorkflow = readWorkflow(wt.worktree)!
    const originalOwner = runningWorkflow.owner
    const cancelled = await cancelInSubprocess(wt.worktree, SESSION)
    expect(cancelled.ok).toBe(true)
    expect(cancelled.pendingCancel).toBe(true)
    expect(cancelled.owner).toEqual(originalOwner)
    expect(readWorkflow(wt.worktree)?.owner).toEqual(originalOwner)
    expect(readWorkflow(wt.worktree)?.stopIntent?.kind).toBe("cancel")
    expect(await stopped).toEqual(new Error("execution unresolved; fence retained"))
    expect(owner.cancellationRequests).toHaveLength(1)
    expect(owner.requests.filter(request => request.role === "worker")).toHaveLength(1)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "executing", stopIntent: expect.objectContaining({ kind: "cancel" }), owner: originalOwner })
    const execution = owner.runtime.runs.status().executions.at(-1)!
    expect(execution.fence).toBeDefined()
    expect(execution.terminal?.quiescentAt).toBeUndefined()
    expect(execution.reconciliation).toMatchObject({ outcome: "unknown", quiescent: false })
    expect(owner.runtime.runs.status().claim).toBeDefined()
    expect(readLedger(wt.worktree, SESSION).tasks.filter(task => task.status === "running")).toHaveLength(0)
  })

  test("pause with a live controller review aborts the review with the pause cause and settles only after proof", async () => {
    const owner = fixture({ hangReview: true, cancelQuiescent: true })
    const submitting = owner.controller.importPlan(SESSION, save())
    await waitFor(() => owner.requests.length === 1)
    const paused = owner.controller.pause(SESSION)
    expect(paused.ok).toBe(true)
    if (paused.ok) expect(paused.wf.stopIntent).toMatchObject({ kind: "pause" })
    // pause keeps the phase and stays pending while the review activity is registered
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "reviewing", stopIntent: { kind: "pause" } })
    expect(owner.controller.status(SESSION, true)).toMatchObject({ workflow: { phase: "reviewing", stopIntent: "pause" } })
    await submitting
    expect(owner.cancellationRequests).toHaveLength(1)
    // the review's finally released the activity and ran the one settlement routine
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "paused", pausedFrom: { phase: "reviewing" } })
    expect(readEvents(wt.worktree, readWorkflow(wt.worktree)!.id).filter(e => e.type === "pause_settled")).toHaveLength(1)
    expect(readLedger(wt.worktree, SESSION).tasks).toHaveLength(0)
    clearReviewSession("child_1")
  })

  test("cancel replaces a pending pause on the same controller and ends cancelled with one cancel_settled", async () => {
    const owner = fixture({ hangReview: true, cancelQuiescent: true })
    const submitting = owner.controller.importPlan(SESSION, save())
    await waitFor(() => owner.requests.length === 1)
    const paused = owner.controller.pause(SESSION)
    expect(paused.ok).toBe(true)
    const pauseToken = readWorkflow(wt.worktree)!.stopIntent!.token
    const cancelled = owner.controller.cancel(SESSION)
    expect(cancelled.ok).toBe(true)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "reviewing", stopIntent: { kind: "cancel" } })
    // the review finally may settle the cancel before importPlan re-reads the record; either outcome is a refusal
    await submitting.then(() => null, () => null)
    const wf = readWorkflow(wt.worktree)!
    expect(wf).toMatchObject({ phase: "cancelled", stopIntent: null })
    const events = readEvents(wt.worktree, wf.id)
    expect(events.filter(e => e.type === "cancel_settled")).toHaveLength(1)
    expect(events.filter(e => e.type === "pause_settled")).toHaveLength(0)
    expect(events.find(e => e.type === "stop_requested" && e.data?.kind === "cancel")?.data?.replaces).toBe(pauseToken)
    // pause after a cancel is refused
    expect(() => owner.controller.pause(SESSION)).toThrow()
    clearReviewSession("child_1")
  })

  test("pause during runInternal settles after the run without a 'workflow changed' throw and keeps the residual pending", async () => {
    let release!: () => void
    const owner = fixture({ worker: () => new Promise<ExecutionOutcome>((resolve) => { release = () => resolve({ status: "cancelled" }) }) })
    const submitted = await owner.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(owner.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const running = owner.controller.run(SESSION).then(() => null, (error: unknown) => error)
    await waitFor(() => owner.requests.some(request => request.role === "worker"))
    const paused = owner.controller.pause(SESSION)
    expect(paused.ok).toBe(true)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "executing", stopIntent: { kind: "pause" } })
    release()
    const error = await running
    expect(String(error ?? "")).not.toContain("workflow changed")
    // the interrupted task was not counted as an outcome; no task is cancelled by the pause
    expect(readLedger(wt.worktree, SESSION).tasks.some(task => task.status === "cancelled" && /pause/.test(task.error ?? ""))).toBe(false)
    const wf = readWorkflow(wt.worktree)!
    expect(["executing", "paused"]).toContain(wf.phase)
    expect(wf.stopIntent?.kind).toBe("pause")
    expect(readEvents(wt.worktree, wf.id).some(e => e.type === "transition" && ["settle_fail", "settle_ok", "user_stop"].includes(String(e.data?.event)))).toBe(false)
  })

  test("a foreign sid pause or cancel is refused with no index or revision change", async () => {
    const owner = fixture({ hangReview: true })
    const submitting = owner.controller.importPlan(SESSION, save())
    await waitFor(() => owner.requests.length === 1)
    const before = readFileSync(workflowPath(wt.worktree), "utf8")
    expect(() => owner.controller.pause("wrong_session")).toThrow()
    expect(() => owner.controller.cancel("wrong_session")).toThrow()
    expect(readFileSync(workflowPath(wt.worktree), "utf8")).toBe(before)
    owner.controller.cancel(SESSION)
    await submitting
    clearReviewSession("child_1")
  })

  // ---- W5: Resume of a settled pause. Every precondition is exercised alone; refusals start nothing.
  async function pausedExecuting(opts: { workers?: string[]; via?: "owner" | "subprocess"; lateComplete?: boolean } = {}) {
    let release!: () => void
    let first = true
    const owner = fixture({ cancelQuiescent: true, reconcile: "terminal", maxAttempts: 2,
      // the worker honours the cancel: it finishes (cancelled) before the owner reconciles its handle
      onCancel: async () => { release?.(); await new Promise<void>(resolve => setImmediate(resolve)) },
      worker: (request) => {
      opts.workers?.push(request.title)
      if (first) { first = false; return new Promise<ExecutionOutcome>((resolve) => { release = () => { if (opts.lateComplete) writeFileSync(join(wt.worktree, "mod1.py"), "VALUE = 1\n"); resolve(opts.lateComplete ? { status: "completed", text: "Open issues: none" } : { status: "cancelled" }) } }) }
      writeFileSync(join(wt.worktree, `mod${Number(request.title.match(/module (\d)/)?.[1])}.py`), "VALUE = 1\n")
      return { status: "completed", text: "Open issues: none" }
    } })
    const submitted = await owner.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(owner.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const running = owner.controller.run(SESSION).then(() => null, (error: unknown) => error)
    await waitFor(() => owner.requests.some(request => request.role === "worker"))
    if (opts.via === "subprocess") expect((await cancelInSubprocess(wt.worktree, SESSION, "pause")).ok).toBe(true)
    else expect(owner.controller.pause(SESSION).ok).toBe(true)
    await running
    const wf = readWorkflow(wt.worktree)!
    expect(wf).toMatchObject({ phase: "paused", pausedFrom: { phase: "executing" } })
    return { owner, wf, planSha: submitted.planSha }
  }
  const readSessionHeld = (sid: string) => readSessionMetadata(wt.worktree, sid)?.held === true
  const starts = (owner: ReturnType<typeof fixture>) => owner.requests.length
  const keep = async () => false
  const resumeIt = (owner: ReturnType<typeof fixture>) => owner.controller.resumePaused(SESSION, async () => true)

  test("the settled pause records request and settled checkpoints with path+hash and an untouched residual", async () => {
    const { wf } = await pausedExecuting()
    const ref = wf.stopIntent!.checkpoint!
    expect(ref).toMatch(new RegExp(`^sessions/${SESSION}/workflows/${wf.id}/checkpoints/${wf.stopIntent!.token}-settled\\.json#[a-f0-9]{64}$`))
    const settled = JSON.parse(readFileSync(join(stateRoot(wt.worktree), ref.split("#")[0]!), "utf8"))
    expect(settled.residual.length).toBe(3)
    expect(existsSync(join(stateRoot(wt.worktree), `sessions/${SESSION}/workflows/${wf.id}/checkpoints/${wf.stopIntent!.token}-request.json`))).toBe(true)
    expect(readLedger(wt.worktree, SESSION).tasks.map(task => task.status)).toEqual(["pending", "pending", "pending"])
  })

  test("Keep starts nothing and leaves the workflow paused and held", async () => {
    const { owner, wf } = await pausedExecuting()
    const before = starts(owner)
    const outcome = await owner.controller.resumePaused(SESSION, keep)
    expect(outcome.kept).toBe(true)
    expect(starts(owner)).toBe(before)
    expect(readWorkflow(wt.worktree)).toMatchObject({ id: wf.id, phase: "paused", lastSeq: wf.lastSeq })
  })

  const PRECONDITIONS: Array<[string, (ctx: Awaited<ReturnType<typeof pausedExecuting>>) => void | Promise<void>, RegExp]> = [
    ["subject: the saved plan json changed", ({ wf }) => writeFileSync(planJsonPath(wt.worktree, wf.id), "{}"), /subject|approved plan/],
    ["subject: the rendered plan changed", ({ wf }) => writeFileSync(join(wt.worktree, wf.planRef!.mdPath), "tampered\n"), /subject|approved plan|rendered/],
    ["unrelated-tasks: an unrelated open task exists", () => {
      const ledger = readLedger(wt.worktree, SESSION)
      writeLedger(wt.worktree, { ...ledger, tasks: [...ledger.tasks, { ...ledger.tasks[0]!, id: "t99", n: 99, title: "unrelated", wf: undefined }] })
    }, /unrelated|residual/],
    ["stop-proof: the settled checkpoint bytes changed", ({ wf }) => {
      const path = join(stateRoot(wt.worktree), wf.stopIntent!.checkpoint!.split("#")[0]!)
      writeFileSync(path, readFileSync(path, "utf8").replace('"residual"', '"residual" '))
    }, /checkpoint/],
    ["stop-proof: an unreconciled execution reappears", ({ owner }) => {
      const claim = owner.runtime.runs.claim(SESSION, owner.runtime.instance, process.pid)
      owner.runtime.runs.registerIntent(claim, { executionId: "late", ownerSession: SESSION, taskId: "t", attemptId: "a", generation: claim.generation, role: "worker", cwd: wt.worktree, policyID: owner.runtime.policy.resolve("worker").id, kind: "host", engine: ENGINE, profile: "legacy-unowned" })
    }, /termination|claim|execution/],
    ["owner: the workflow owner epoch is not this attachment", () => {
      rewriteCommitted(wt.worktree, current => ({ ...current, owner: { instance: "other-epoch", pid: process.pid } }))
    }, /epoch|owner|attachment/],
    ["cancel-or-end: a cancel intent is pending", ({ wf }) => {
      rewriteCommitted(wt.worktree, current => ({ ...current, stopIntent: { ...current.stopIntent!, kind: "cancel" }, phase: wf.phase }))
    }, /cancel/],
  ]
  for (const [name, mutate, message] of PRECONDITIONS) {
    test(`W5 ${name} -> refused with zero model, queue, review or idle starts and the workflow stays paused`, async () => {
      const ctx = await pausedExecuting()
      const before = starts(ctx.owner)
      await mutate(ctx)
      const revision = readWorkflow(wt.worktree)!.lastSeq
      await expect(resumeIt(ctx.owner)).rejects.toThrow(message)
      expect(starts(ctx.owner)).toBe(before)
      expect(readWorkflow(wt.worktree)!.lastSeq).toBe(revision)
      expect(readWorkflow(wt.worktree)!.phase === "paused" || readWorkflow(wt.worktree)!.stopIntent?.kind === "cancel").toBe(true)
      expect(getQueue(ctx.owner.runtime).isRunning(SESSION)).toBe(false)
    })
  }

  test("W5 preflight failure is its own refusal and starts nothing", async () => {
    let failPreflight = false
    const ctx = await pausedExecuting()
    const original = ctx.owner.runtime.host.preflight.bind(ctx.owner.runtime.host)
    ctx.owner.runtime.host.preflight = async (profile: string) => failPreflight ? { compatible: false, controls: {}, problems: ["host drifted"] } : original(profile)
    failPreflight = true
    const before = starts(ctx.owner)
    await expect(resumeIt(ctx.owner)).rejects.toThrow(/preflight|admission|host|control/)
    expect(starts(ctx.owner)).toBe(before)
    expect(readWorkflow(wt.worktree)!.phase).toBe("paused")
  })

  test("W5 a change injected between the choice and the commit is caught by the recheck", async () => {
    const ctx = await pausedExecuting()
    const before = starts(ctx.owner)
    await expect(ctx.owner.controller.resumePaused(SESSION, async () => {
      writeFileSync(join(wt.worktree, ctx.wf.planRef!.mdPath), "tampered after the choice\n")
      return true
    })).rejects.toThrow(/subject|approved plan|rendered|authority/)
    expect(starts(ctx.owner)).toBe(before)
    expect(readWorkflow(wt.worktree)!.phase).toBe("paused")
  })

  test("W5 clean resume: one resume commit, attempt 2, only residual tasks run, done tasks retained, new token on the current epoch", async () => {
    const workers: string[] = []
    const ctx = await pausedExecuting({ workers })
    const first = readLedger(wt.worktree, SESSION).tasks
    expect(workers).toHaveLength(1)
    // complete the first task before the pause is resumed? it was interrupted: all three are residual
    const done = first.filter(task => task.status === "done").map(task => task.id)
    const outcome = await ctx.owner.controller.resumePaused(SESSION, async (view) => {
      expect(view.attempt).toBe(2)
      expect(view.residual).toEqual(first.filter(task => task.status === "pending").map(task => task.id))
      return true
    })
    expect(outcome.kept).toBe(false)
    const finished = readWorkflow(wt.worktree)!
    const events = readEvents(wt.worktree, finished.id)
    expect(events.filter(event => event.type === "resumed")).toHaveLength(1)
    expect(events.find(event => event.type === "resumed")?.data).toMatchObject({ attempt: 2, token: ctx.wf.stopIntent!.token })
    expect(finished.stopIntent).toBeNull()
    expect(finished.pausedFrom).toBeUndefined()
    expect(["done", "executing", "stuck"]).toContain(finished.phase)
    for (const id of done) expect(readLedger(wt.worktree, SESSION).tasks.find(task => task.id === id)?.status).toBe("done")
    expect(workers.slice(1).every(title => /module/.test(title))).toBe(true)
    expect(finished.owner.instance).toBe(ctx.wf.owner.instance)
  }, 60_000)

  test("W5 a pause taken in reviewing resumes into reviewing with exactly one new review attempt on the same subject", async () => {
    const options = { hangReview: true, cancelQuiescent: true }
    const owner = fixture(options)
    const submitting = owner.controller.importPlan(SESSION, save())
    await waitFor(() => owner.requests.length === 1)
    expect(owner.controller.pause(SESSION).ok).toBe(true)
    await submitting.then(() => null, () => null)
    clearReviewSession("child_1")
    const paused = readWorkflow(wt.worktree)!
    expect(paused).toMatchObject({ phase: "paused", pausedFrom: { phase: "reviewing" } })
    const reviewsBefore = owner.requests.filter(request => request.title.includes("plan review")).length
    options.hangReview = false
    const outcome = await resumeIt(owner)
    expect(outcome.kept).toBe(false)
    expect(owner.requests.filter(request => request.title.includes("plan review"))).toHaveLength(reviewsBefore + 1)
    expect(owner.requests.some(request => request.role === "worker")).toBe(false)
    const after = readWorkflow(wt.worktree)!
    expect(after).toMatchObject({ id: paused.id, phase: "pending_approval", stopIntent: null })
    expect(after.planRef?.jsonSha).toBe(paused.planRef?.jsonSha)
    // a receipt minted before the pause/resume no longer matches the revision
    expect(after.lastSeq).toBeGreaterThan(paused.lastSeq)
  })

  test("architect 1: a non-owner pause or cancel in pending_approval records the intent only; the owner settles after the broker wait is released", async () => {
    for (const kind of ["pause", "cancel"] as const) {
      const owner = fixture()
      const submitted = await owner.controller.importPlan(SESSION, save())
      if (!submitted.result.ok) throw new Error(submitted.result.text)
      expect(submitted.result.wf.phase).toBe("pending_approval")
      const wait = new AbortController()
      const unregister = registerSkillPermissionActivity(wt.worktree, SESSION, submitted.result.wf!.owner.instance, wait)
      const requested = await cancelInSubprocess(wt.worktree, SESSION, kind)
      expect(requested.ok).toBe(true)
      expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "pending_approval", stopIntent: { kind } })
      const types = () => readEvents(wt.worktree, submitted.result.wf!.id).map(e => e.type)
      expect(types().filter(t => t === "pause_settled" || t === "cancel_settled")).toHaveLength(0)
      // the owner observes the foreign stop: it holds, aborts the broker wait, and still waits for the wait to unregister
      const waiting = observeStopSettlement(owner.runtime, SESSION, submitted.result.wf!.owner.instance, "owner")
      expect(waiting.kind).toBe("waiting")
      expect(wait.signal.aborted).toBe(true)
      unregister()
      expect(observeStopSettlement(owner.runtime, SESSION, submitted.result.wf!.owner.instance, "owner").kind).toBe("settled")
      expect(readWorkflow(wt.worktree)!.phase).toBe(kind === "pause" ? "paused" : "cancelled")
      rmSync(join(wt.worktree, ".lca"), { recursive: true, force: true })
      wt.cleanup(); wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree)
    }
  })

  test("architect 2: a subprocess pause of a running owner holds the owner, settles, and the Resume runs the residual only", async () => {
    const workers: string[] = []
    const ctx = await pausedExecuting({ via: "subprocess", workers })
    expect(readSessionHeld(ctx.wf.sessionID)).toBe(true)
    const before = workers.length
    const outcome = await resumeIt(ctx.owner)
    expect(outcome.kept).toBe(false)
    expect(workers.length - before).toBe(3)
    expect(readLedger(wt.worktree, SESSION).tasks.every(task => task.status === "done" || task.status === "failed")).toBe(true)
  }, 60_000)

  test("architect 3: a user stop marker after the pause refuses the Resume with zero commits", async () => {
    const ctx = await pausedExecuting()
    writeFileSync(join(sessionDir(wt.worktree, SESSION), "abort.json"), JSON.stringify({ reason: "user_stop", at: Date.now() }))
    const revision = readWorkflow(wt.worktree)!.lastSeq
    await expect(resumeIt(ctx.owner)).rejects.toThrow(/stop marker|cancel-or-end/)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "paused", lastSeq: revision })
  })

  test("architect 5: a worker that completes (and writes a file) after the stop never advances a task, verification or the ledger", async () => {
    for (const via of ["owner", "subprocess"] as const) {
      const ctx = await pausedExecuting({ via, lateComplete: true })
      const tasks = readLedger(wt.worktree, SESSION).tasks
      expect(tasks.map(task => task.status)).toEqual(["pending", "pending", "pending"])
      expect(tasks.every(task => task.verify_result === undefined && task.review === undefined && task.finishedAt === undefined)).toBe(true)
      // the late write really happened (worktree isolation is off) yet no ledger, verification or review effect followed
      expect(existsSync(join(wt.worktree, "mod1.py"))).toBe(true)
      expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "paused" })
      void ctx
      wt.cleanup(); wt = tempGitWorktree(); wt.worktree = realpathSync(wt.worktree)
    }
  }, 60_000)

  test("RC4 pending_approval pause: an approve receipt minted before the pause is refused after the resume, with control bytes and ledger unchanged", async () => {
    const owner = fixture()
    const submitted = await owner.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    const wid = submitted.result.wf.id
    expect(submitted.result.wf.phase).toBe("pending_approval")
    const oldReceipt = await operatorReceipt("approve", wid, submitted.planSha, `APPROVE ${wid} ${submitted.planSha}`)
    expect(owner.controller.pause(SESSION).ok).toBe(true)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "paused", pausedFrom: { phase: "pending_approval" } })
    const outcome = await resumeIt(owner)
    expect(outcome.kept).toBe(false)
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "pending_approval", stopIntent: null })
    const control = readFileSync(workflowPath(wt.worktree))
    const ledger = existsSync(ledgerPath(wt.worktree, SESSION)) ? readFileSync(ledgerPath(wt.worktree, SESSION)) : undefined
    expect(() => owner.controller.decide(oldReceipt)).toThrow(/revision/)
    expect(readFileSync(workflowPath(wt.worktree)).equals(control)).toBe(true)
    if (ledger) expect(readFileSync(ledgerPath(wt.worktree, SESSION)).equals(ledger)).toBe(true)
    else expect(existsSync(ledgerPath(wt.worktree, SESSION))).toBe(false)
    expect(owner.requests.some(request => request.role === "worker")).toBe(false)
  })

  test("RC5 W5 clean resume with task 1 completed before the pause: its record is byte-equal and only the residual runs", async () => {
    const workers: string[] = []
    let releaseSecond!: () => void
    let call = 0
    const owner = fixture({ cancelQuiescent: true, reconcile: "terminal", maxAttempts: 2,
      onCancel: async () => { releaseSecond?.(); await new Promise<void>(resolve => setImmediate(resolve)) },
      worker: (request) => {
        workers.push(request.title)
        call++
        if (call === 2) return new Promise<ExecutionOutcome>((resolve) => { releaseSecond = () => resolve({ status: "cancelled" }) })
        writeFileSync(join(wt.worktree, `mod${Number(request.title.match(/module (\d)/)?.[1])}.py`), "VALUE = 1\n")
        return { status: "completed", text: "Open issues: none" }
      } })
    const submitted = await owner.controller.importPlan(SESSION, save())
    if (!submitted.result.ok) throw new Error(submitted.result.text)
    expect((await approve(owner.controller, submitted.result.wf.id, submitted.planSha)).ok).toBe(true)
    const running = owner.controller.run(SESSION).then(() => null, (error: unknown) => error)
    await waitFor(() => workers.length === 2)
    expect(owner.controller.pause(SESSION).ok).toBe(true)
    await running
    expect(readWorkflow(wt.worktree)).toMatchObject({ phase: "paused" })
    const paused = readLedger(wt.worktree, SESSION).tasks
    expect(paused.map(task => task.status)).toEqual(["done", "pending", "pending"])
    const doneBefore = JSON.stringify(paused[0])
    const viewed: Array<{ residual: string[]; done: string[]; attempt: number }> = []
    const before = workers.length
    const outcome = await owner.controller.resumePaused(SESSION, async (view) => { viewed.push({ residual: view.residual, done: view.done, attempt: view.attempt }); return true })
    expect(outcome.kept).toBe(false)
    expect(viewed).toEqual([{ residual: [paused[1]!.id, paused[2]!.id], done: [paused[0]!.id], attempt: 2 }])
    const after = readLedger(wt.worktree, SESSION).tasks
    expect(JSON.stringify(after[0])).toBe(doneBefore)
    expect(workers.slice(before).sort()).toEqual(["lca task 2: module 2", "lca task 3: module 3"])
    expect(after.map(task => task.status)).toEqual(["done", "done", "done"])
  }, 60_000)

  test("W5 /continue-style resume refuses while a cancel is pending (plain resume and paused resume)", async () => {
    const ctx = await pausedExecuting()
    rewriteCommitted(wt.worktree, current => ({ ...current, stopIntent: { ...current.stopIntent!, kind: "cancel" } }))
    await expect(ctx.owner.controller.resume(SESSION)).rejects.toThrow("cancellation is pending")
    await expect(resumeIt(ctx.owner)).rejects.toThrow("cancellation is pending")
  })

  test("plain resume of a paused workflow requires the explicit choice path", async () => {
    const ctx = await pausedExecuting()
    await expect(ctx.owner.controller.resume(SESSION)).rejects.toThrow(/paused|Keep\/Resume/)
    expect(readWorkflow(wt.worktree)!.phase).toBe("paused")
  })

  test("boot-epoch refusal precedes controller import, run, and resume state access", async () => {
    const refused = new LinuxAdmissionRefused("epoch", ["boot-epoch"])
    let epochChecks = 0
    const f = fixture({ linuxAdmission: {
      assertBootEpoch() { epochChecks++; throw refused },
      async admitNewExecution() { throw refused },
      async admitPlanSubmission() { throw refused },
      consumePlanSubmission() { throw refused },
    } })
    const runs = f.runtime.runs
    let claimCalls = 0
    let statusCalls = 0
    const claim = runs.claim.bind(runs)
    const status = runs.status.bind(runs)
    runs.claim = (...args) => { claimCalls++; return claim(...args) }
    runs.status = () => { statusCalls++; return status() }

    const source = save()
    await expect(f.controller.importPlan(SESSION, source)).rejects.toBe(refused)
    expect(existsSync(workflowPath(wt.worktree))).toBe(false)
    expect(existsSync(sessionDir(wt.worktree, SESSION))).toBe(true)

    const workflow = withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, { ...newWorkflow(SESSION, currentOwner(Date.now(), f.session!.epoch), "command", "test", ENGINE), phase: "executing" }))
    const before = readFileSync(workflowPath(wt.worktree))
    await expect(f.controller.run(SESSION)).rejects.toBe(refused)
    await expect(f.controller.resume(SESSION)).rejects.toBe(refused)
    expect(readFileSync(workflowPath(wt.worktree)).equals(before)).toBe(true)
    expect(readWorkflow(wt.worktree)?.id).toBe(workflow.id)
    expect(epochChecks).toBe(3)
    expect(claimCalls).toBe(0)
    expect(statusCalls).toBe(0)
  })

  test("A4b refusal leaves no workflow or plan artifact after same-boot reconciliation", async () => {
    const refused = new LinuxAdmissionRefused("admit", ["latched"])
    let submissions = 0
    let hostCalls = 0
    const f = fixture({ linuxAdmission: {
      assertBootEpoch() {},
      async admitNewExecution() { throw refused },
      async admitPlanSubmission() { submissions++; throw refused },
      consumePlanSubmission() { throw new TypeError("unexpected token consumption") },
    } })
    f.runtime.host.prepare = async () => { hostCalls++; throw new Error("unexpected host execution") }
    await expect(f.controller.importPlan(SESSION, save())).rejects.toBe(refused)
    expect(submissions).toBe(1)
    expect(existsSync(workflowPath(wt.worktree))).toBe(false)
    expect(existsSync(sessionDir(wt.worktree, SESSION))).toBe(true)
    expect(existsSync(join(wt.worktree, ".lca", "plans"))).toBe(false)
    expect(hostCalls).toBe(0)
    expect(f.runtime.runs.status().claim).toBeUndefined()
  })

  test("A13 A4b admits writes once; a later A5 refusal keeps submitted plan, releases claim, and propagates", async () => {
    const refused = new LinuxAdmissionRefused("admit", ["latched"])
    const events: string[] = []
    let admissions = 0
    let a5HadClaimAndNoIntent = false
    let readAdmissionState: (() => ReturnType<ExecutionRuntime["runs"]["status"]>) | undefined
    const admitNewExecution = async () => {
      admissions++
      events.push(`admitNewExecution:${admissions}`)
      if (admissions === 2) {
        const status = readAdmissionState!()
        a5HadClaimAndNoIntent = !!status.claim && status.executions.length === 0
        throw refused
      }
    }
    const linuxAdmission: LinuxAdmission = {
      assertBootEpoch() {},
      admitNewExecution,
      async admitPlanSubmission(sessionID) {
        events.push("admitPlanSubmission")
        expect(sessionID).toBe(SESSION)
        await admitNewExecution()
        return Object.freeze({ purpose: "plan-submission" as const, sessionID })
      },
      consumePlanSubmission(admission, sessionID) {
        events.push("consumePlanSubmission")
        expect(admission).toEqual({ purpose: "plan-submission", sessionID })
        expect(sessionID).toBe(SESSION)
      },
    }
    const f = fixture({ linuxAdmission })
    readAdmissionState = () => f.runtime.runs.status()
    const source = save()
    let thrown: unknown
    try { await f.controller.importPlan(SESSION, source) }
    catch (error) { thrown = error }

    expect(thrown).toBe(refused)
    expect(events).toEqual(["admitPlanSubmission", "admitNewExecution:1", "consumePlanSubmission", "admitNewExecution:2"])
    expect(a5HadClaimAndNoIntent).toBe(true)
    expect(f.requests).toHaveLength(0)
    const workflow = readWorkflow(wt.worktree)!
    expect(workflow).toMatchObject({ phase: "pending_approval", review: { verdict: "none", note: "aborted" } })
    expect(JSON.parse(readFileSync(planJsonPath(wt.worktree, workflow.id), "utf8"))).toEqual(plan())
    expect(readFileSync(join(wt.worktree, planMdPath(workflow.id)), "utf8")).toContain("verdict: none")
    expect(f.runtime.runs.status()).toMatchObject({ executions: [], claim: undefined })
    const otherOwner = f.runtime.runs.claim("other-session", "same-boot-owner", process.pid)
    expect(otherOwner.ownerSession).toBe("other-session")
    f.runtime.runs.release(otherOwner)
  })
})
