import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { chatExecuteMode, DEFAULT_CONFIG } from "../src/config.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { eventsPath, planJsonPath, readWorkflow, workflowPath } from "../src/flow/state.ts"
import { observeStopSettlement } from "../src/flow/runtime.ts"
import { rewriteCommitted } from "./commit-fixture.ts"
import { parseCliArgs, runCli } from "../src/hosts/cli.ts"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { createCliHost } from "../src/hosts/cli-host.ts"
import type { CliEngine, CliTransportHandle, CliTransportOptions } from "../src/hosts/cli-transport.ts"
import { createForegroundController, PlanIsolationUnavailableError } from "../src/hosts/controller.ts"
import { worktreeRoot } from "../src/orchestration/worktree.ts"
import { humanDecision } from "../src/hosts/operator.ts"
import { createPlanConversation } from "../src/hosts/plan-conversation.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import { EXECUTION_ROLES, type ComboRoutes } from "../src/hosts/types.ts"
import { executionRunDirectory, sessionDir } from "../src/state/store.ts"
import { attachAdmission, detachAdmission, effectiveHold } from "../src/sessions/admission.ts"
import { readSessionMetadata } from "../src/sessions/store.ts"
import { ledgerPath, readLedger, writeLedger } from "../src/state/ledger.ts"
import { GIT_TEST_ENV, tempGitWorktree } from "./guards-helpers.ts"
import { planBinding, withTerminalLine } from "./operator-helpers.ts"

let wt: ReturnType<typeof tempGitWorktree> | undefined
let previousXdgConfigHome: string | undefined
let configHomeCaptured = false
afterEach(() => {
  stopHeartbeat()
  wt?.cleanup()
  wt = undefined
  if (configHomeCaptured) {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    previousXdgConfigHome = undefined
    configHomeCaptured = false
  }
})

const fixturePlan = {
  goal: "Update three tracked text values with verified contents",
  steps: ["a", "b", "c"].map(letter => ({ title: `Update ${letter}`, files: [`${letter}.txt`],
    detail: `Write after-${letter} followed by a newline to ${letter}.txt. Do not alter tests.`, verify: `sh verify-${letter}.test.sh` })),
  risks: ["Unexpected changes must not be accepted"],
}
const finalEnvelope = (text: string) => JSON.stringify({ type: "final", text })

async function pendingCommonWorkflow(routes?: ComboRoutes) {
  const files: Record<string, string> = {}
  for (const letter of ["a", "b", "c"]) {
    files[`${letter}.txt`] = letter === "a" ? "after-a\n" : "before\n"
    files[`verify-${letter}.test.sh`] = `test "$(cat ${letter}.txt)" = after-${letter}\n`
  }
  wt = tempGitWorktree(files)
  if (!configHomeCaptured) {
    previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    configHomeCaptured = true
  }
  process.env.XDG_CONFIG_HOME = join(wt.stateHome, "config")
  const root = realpathSync(wt.worktree)
  const engine: CliEngine = "local"
  const model = "fixture-model"
  const selected = createCliRuntime({ worktree: root, engine, model, ...(routes ? { routes } : {}) })
  const config = structuredClone(selected.config)
  const responses = [finalEnvelope(JSON.stringify(fixturePlan)), finalEnvelope("VERDICT: OKAY")]
  const dispatched: CliTransportOptions[] = []
  let cancelCalls = 0
  let reconcileCalls = 0
  const transportFactory = (options: CliTransportOptions): CliTransportHandle => {
    let done = false
    let cancelled = false
    return {
      async run() {
        dispatched.push(options)
        if (cancelled) return { status: "cancelled", text: "", quiescent: true }
        const response = responses.shift()
        if (response === undefined) throw new Error("unexpected model request in recovery fixture")
        options.onText?.(response)
        done = true
        return { status: "completed", text: response, quiescent: true }
      },
      async requestCancel() {
        cancelCalls++
        cancelled = true
        return { requested: true, acknowledged: true, terminal: true, quiescent: true }
      },
      async reconcile() {
        reconcileCalls++
        return { outcome: done ? "terminal" : "unknown", quiescent: done, evidence: "owned recovery fixture" }
      },
    }
  }
  const runtime = createExecutionRuntime({ directory: root, worktree: root, config, log() {} }, ({ policy, runs }) =>
    // Same main policy as createCliRuntime (what the recovery CLI rebuilds): chat.execute decides whether main may act.
    createCliHost({ engine, model, ...(routes ? { routes } : {}), policy, runs, createTransport: transportFactory }), { planningOnlyMain: true, chatExecuteMain: chatExecuteMode(config) !== "plan", ...(routes ? { routes: Object.fromEntries(Object.entries(routes).map(([role, r]) => [role, { model: { providerID: r.engine, modelID: r.model } }])) } : {}) })
  const sessionID = "common-recovery-session"
  const session = attachAdmission(runtime, sessionID, { engine, model, ...(routes ? { routes } : {}) })
  const controller = createForegroundController(runtime)
  const conversation = createPlanConversation(runtime, sessionID)
  const discussed = await conversation.turn("Plan the requested three file changes")
  expect(discussed.plan).toEqual(fixturePlan)
  const submitted = await controller.importPlan(sessionID, "", undefined, { ...fixturePlan, revision: 1 })
  if (!submitted.result.ok) throw new Error(submitted.result.text)
  return { root, engine, model, sessionID, session, runtime, controller, workflow: submitted.result.wf, planSha: submitted.planSha,
    responses, dispatched, get cancelCalls() { return cancelCalls }, get reconcileCalls() { return reconcileCalls } }
}

function recoverySnapshot(root: string, sessionID: string, workflowID: string): Array<{ path: string; exists: boolean; bytes?: Buffer }> {
  const workflow = readWorkflow(root, sessionID)
  const paths = [workflowPath(root, sessionID), eventsPath(root, sessionID), join(executionRunDirectory(root), "state.json"), planJsonPath(root, workflowID, sessionID),
    ledgerPath(root, sessionID), ...(workflow?.planRef ? [join(root, workflow.planRef.mdPath)] : []),
    join(root, "a.txt"), join(root, "b.txt"), join(root, "c.txt")]
  return paths.map(path => existsSync(path) ? { path, exists: true, bytes: readFileSync(path) } : { path, exists: false })
}

async function invokeCommonCli(root: string, argv: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/hosts/cli.ts"), ...argv], {
    cwd: root, env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe("common CLI controlled workflow", () => {
  for (const engine of ["local", "claude"] as const) {
    test(`${engine}: real controller and host require human approval before scoped writes`, async () => {
      const files: Record<string, string> = {}
      const letters = ["a", "b", "c"]
      for (const letter of letters) {
        files[`${letter}.txt`] = "before\n"
        files[`verify-${letter}.test.sh`] = `test "$(cat ${letter}.txt)" = after-${letter}\n`
      }
      wt = tempGitWorktree(files)
      const root = realpathSync(wt.worktree)
      const plan = {
        goal: "Update the three tracked text values with verified contents",
        steps: letters.map(letter => ({ title: `Update ${letter}`, files: [`${letter}.txt`],
          detail: `Write after-${letter} followed by a newline to ${letter}.txt. Do not alter tests.`, verify: `sh verify-${letter}.test.sh` })),
        risks: ["Unexpected changes must not be accepted"],
      }
      const final = (text: string) => JSON.stringify({ type: "final", text })
      const responses = [final(JSON.stringify(plan)), final("VERDICT: OKAY")]
      for (const letter of letters) {
        responses.push(JSON.stringify({ type: "tool", name: "write", input: { path: `${letter}.txt`, content: `after-${letter}\n` } }))
        responses.push(final("Open issues: none"), final("ACCEPT"))
      }
      const dispatched: CliTransportOptions[] = []
      const transportFactory = (options: CliTransportOptions): CliTransportHandle => {
        let done = false
        let cancelled = false
        return {
          async run() {
            dispatched.push(options)
            if (cancelled) return { status: "cancelled", text: "", quiescent: true }
            const text = responses.shift()
            if (text === undefined) throw new Error("unexpected model request in workflow fixture")
            options.onText?.(text)
            done = true
            return { status: "completed", text, quiescent: true }
          },
          async requestCancel() { cancelled = true; done = true; return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
          async reconcile() { return { outcome: done ? "terminal" : "unknown", quiescent: done, evidence: "owned inference fixture" } },
        }
      }
      const config = structuredClone(DEFAULT_CONFIG)
      config.models = Object.fromEntries(EXECUTION_ROLES.map(role => [role, `${engine}/fixture-model`]))
      config.delegate.max_attempts = 1
      const sessionID = `common-${engine}`
      const runtime = createExecutionRuntime({ directory: root, worktree: root, config, log() {} }, ({ policy, runs }) =>
        createCliHost({ engine: engine as CliEngine, model: "fixture-model", policy, runs, createTransport: transportFactory }))
      const session = attachAdmission(runtime, sessionID, { engine, model: "fixture-model" })
      const controller = createForegroundController(runtime)
      const conversation = createPlanConversation(runtime, sessionID)
      const discussed = await conversation.turn("Plan the requested three file changes")
      expect(discussed.plan).toEqual(plan)
      const submission = await controller.importPlan(sessionID, "", undefined, { ...plan, revision: 1 })
      if (!submission.result.ok) throw new Error(submission.result.text)
      const workflow = submission.result.wf
      expect(workflow.phase).toBe("pending_approval")
      for (const letter of letters) expect(readFileSync(join(root, `${letter}.txt`), "utf8")).toBe("before\n")
      await expect(controller.run(sessionID)).rejects.toThrow()
      expect(dispatched).toHaveLength(2)
      const approval = await withTerminalLine(`APPROVE ${workflow.id} ${submission.planSha}`, () =>
        humanDecision("approve", planBinding(sessionID, workflow, submission.planSha)))
      expect(controller.assertRecoveryIdentity(sessionID, workflow.id, submission.planSha).id).toBe(workflow.id)
      expect(controller.decide(approval, sessionID).ok).toBe(true)
      await controller.run(sessionID)
      for (const letter of letters) expect(readFileSync(join(root, `${letter}.txt`), "utf8")).toBe(`after-${letter}\n`)
      expect(readLedger(root, sessionID).tasks.map(task => task.status)).toEqual(["done", "done", "done"])
      expect(readWorkflow(root, sessionID)?.phase).toBe("done")
      expect(responses).toHaveLength(0)
      expect(runtime.runs.status().claim).toBeUndefined()
      for (const execution of runtime.runs.status().executions.filter(record => record.kind === "host")) {
        expect(execution.engine).toBe(engine)
        expect(execution.profile).toBe("legacy-unowned")
        expect(execution.controlProfile).toBe("estimated-input-reactive-output-v1")
      }
      expect(await detachAdmission(runtime, sessionID, session.epoch, "test-complete")).toBe(true)
    }, 30_000)
  }

  test("common CLI approval and rejection use the explicit owner session, workflow and plan SHA", async () => {
    const approved = await pendingCommonWorkflow()
    expect(await detachAdmission(approved.runtime, approved.sessionID, approved.session.epoch, "test-cli-recovery")).toBe(true)
    const approval = await withTerminalLine(`APPROVE ${approved.workflow.id} ${approved.planSha}`, () => runCli(parseCliArgs([
      "approve", "--worktree", approved.root, "--engine", approved.engine, "--model", approved.model,
      "--session", approved.sessionID, "--workflow", approved.workflow.id, "--sha", approved.planSha,
    ]), () => createCliRuntime({ worktree: approved.root, engine: approved.engine, model: approved.model })))
    expect(approval).toBe(`workflow ${approved.workflow.id} executing`)
    expect(readWorkflow(approved.root, approved.sessionID)?.sessionID).toBe(approved.sessionID)
    wt?.cleanup()
    wt = undefined

    const rejected = await pendingCommonWorkflow()
    expect(await detachAdmission(rejected.runtime, rejected.sessionID, rejected.session.epoch, "test-cli-recovery")).toBe(true)
    const rejection = await withTerminalLine(`REJECT ${rejected.workflow.id} ${rejected.planSha} defer this plan`, () => runCli(parseCliArgs([
      "reject", "--worktree", rejected.root, "--engine", rejected.engine, "--model", rejected.model,
      "--session", rejected.sessionID, "--workflow", rejected.workflow.id, "--sha", rejected.planSha,
    ]), () => createCliRuntime({ worktree: rejected.root, engine: rejected.engine, model: rejected.model })))
    expect(rejection).toBe(`workflow ${rejected.workflow.id} planning`)
    expect(readWorkflow(rejected.root, rejected.sessionID)?.phase).toBe("planning")
  })

  test("combo session recovers with metadata routes after config changes; tampered routes refuse before mutation", async () => {
    const routes: ComboRoutes = { reviewer: { engine: "local", model: "review-model" } }
    const fixture = await pendingCommonWorkflow(routes)
    expect(readSessionMetadata(fixture.root, fixture.sessionID)?.routes).toEqual(routes)
    expect(await detachAdmission(fixture.runtime, fixture.sessionID, fixture.session.epoch, "test-combo-recovery")).toBe(true)
    // Current config now holds a different combo; recovery must ignore it and use the pinned routes.
    const configDir = join(wt!.stateHome, "config", "otter")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "otter.jsonc"), JSON.stringify({ chat: { combo: { planner: { engine: "codex", model: "gpt-5.6-sol" } } } }))
    const seen: unknown[] = []
    const factory: typeof createCliRuntime = options => { seen.push(options.routes); return fixture.runtime }
    const approval = await withTerminalLine(`APPROVE ${fixture.workflow.id} ${fixture.planSha}`, () => runCli(parseCliArgs([
      "approve", "--worktree", fixture.root, "--engine", fixture.engine, "--model", fixture.model,
      "--session", fixture.sessionID, "--workflow", fixture.workflow.id, "--sha", fixture.planSha,
    ]), factory))
    expect(approval).toBe(`workflow ${fixture.workflow.id} executing`)
    expect(seen).toEqual([routes])
    wt?.cleanup()
    wt = undefined

    const tampered = await pendingCommonWorkflow(routes)
    expect(await detachAdmission(tampered.runtime, tampered.sessionID, tampered.session.epoch, "test-combo-tamper")).toBe(true)
    const metadataPath = join(sessionDir(tampered.root, tampered.sessionID), "metadata.json")
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { routes?: unknown }
    metadata.routes = { reviewer: { engine: "local", model: "tampered-model" } }
    writeFileSync(metadataPath, JSON.stringify(metadata))
    const before = recoverySnapshot(tampered.root, tampered.sessionID, tampered.workflow.id)
    await expect(withTerminalLine(`APPROVE ${tampered.workflow.id} ${tampered.planSha}`, () => runCli(parseCliArgs([
      "approve", "--worktree", tampered.root, "--engine", tampered.engine, "--model", tampered.model,
      "--session", tampered.sessionID, "--workflow", tampered.workflow.id, "--sha", tampered.planSha,
    ]), createCliRuntime))).rejects.toThrow("policy identity evidence")
    const after = recoverySnapshot(tampered.root, tampered.sessionID, tampered.workflow.id)
    expect(recoverySnapshot(tampered.root, tampered.sessionID, tampered.workflow.id)).toEqual(before)
    expect(readWorkflow(tampered.root, tampered.sessionID)?.phase).toBe("pending_approval")
  })

  test("cancel and pause never pass pinned routes to runtime construction", async () => {
    for (const command of ["cancel", "pause"] as const) {
      const routes: ComboRoutes = { planner: { engine: "claude", model: "opus" } }
      const fixture = await pendingCommonWorkflow(routes)
      const seen: unknown[] = []
      const factory: typeof createCliRuntime = options => {
        seen.push(options.routes)
        return createCliRuntime({ ...options, createTransport: () => { throw new Error("stop requests never dispatch") } })
      }
      expect(readSessionMetadata(fixture.root, fixture.sessionID)?.routes).toEqual(routes)
      const result = await runCli(parseCliArgs([command, "--worktree", fixture.root, "--engine", fixture.engine,
        "--model", fixture.model, "--session", fixture.sessionID]), factory)
      expect(result).toContain(command === "cancel" ? "cancel" : "pause")
      expect(seen).toEqual([undefined])
      wt?.cleanup()
      wt = undefined
    }
  })

  test("a role with no recorded execution is not covered by pinned-route evidence (documented limit)", async () => {
    const routes: ComboRoutes = { worker: { engine: "local", model: "worker-model" } }
    const fixture = await pendingCommonWorkflow(routes)
    expect(await detachAdmission(fixture.runtime, fixture.sessionID, fixture.session.epoch, "test-unrecorded-role")).toBe(true)
    // The fixture only executed planning roles; the worker route has no recorded execution.
    const recorded = new Set(fixture.runtime.runs.status().executions.map(execution => execution.role))
    expect(recorded.has("worker")).toBe(false)
    const metadataPath = join(sessionDir(fixture.root, fixture.sessionID), "metadata.json")
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { routes?: unknown }
    metadata.routes = { worker: { engine: "local", model: "tampered-unexecuted-model" } }
    writeFileSync(metadataPath, JSON.stringify(metadata))
    const seen: unknown[] = []
    const factory: typeof createCliRuntime = options => {
      seen.push(options.routes)
      return createCliRuntime({ ...options, createTransport: () => { throw new Error("no dispatch expected") } })
    }
    const approval = await withTerminalLine(`APPROVE ${fixture.workflow.id} ${fixture.planSha}`, () => runCli(parseCliArgs([
      "approve", "--worktree", fixture.root, "--engine", fixture.engine, "--model", fixture.model,
      "--session", fixture.sessionID, "--workflow", fixture.workflow.id, "--sha", fixture.planSha,
    ]), factory))
    expect(approval).toBe(`workflow ${fixture.workflow.id} executing`)
    expect(seen).toEqual([{ worker: { engine: "local", model: "tampered-unexecuted-model" } }])
  })

  test("status JSON does not attach, rebind, or repair a restored owner", async () => {
    const fixture = await pendingCommonWorkflow()
    expect(await detachAdmission(fixture.runtime, fixture.sessionID, fixture.session.epoch, "test-status-readonly")).toBe(true)
    const workflowBefore = readFileSync(workflowPath(fixture.root, fixture.sessionID))
    const metadataBefore = readFileSync(join(sessionDir(fixture.root, fixture.sessionID), "metadata.json"))
    expect(effectiveHold(fixture.root, fixture.sessionID)).toBe(true)

    const result = await runCli(parseCliArgs(["status", "--worktree", fixture.root, "--session", fixture.sessionID, "--json"]))
    expect(JSON.parse(result)).toMatchObject({ workflow: { id: fixture.workflow.id } })
    expect(readFileSync(workflowPath(fixture.root, fixture.sessionID))).toEqual(workflowBefore)
    expect(readFileSync(join(sessionDir(fixture.root, fixture.sessionID), "metadata.json"))).toEqual(metadataBefore)
    expect(effectiveHold(fixture.root, fixture.sessionID)).toBe(true)
  })

  test("restored CLI approval stays held until explicit run and then dispatches against the exact session", async () => {
    const fixture = await pendingCommonWorkflow()
    expect(await detachAdmission(fixture.runtime, fixture.sessionID, fixture.session.epoch, "test-explicit-run")).toBe(true)
    const approval = await withTerminalLine(`APPROVE ${fixture.workflow.id} ${fixture.planSha}`, () => runCli(parseCliArgs([
      "approve", "--worktree", fixture.root, "--engine", fixture.engine, "--model", fixture.model,
      "--session", fixture.sessionID, "--workflow", fixture.workflow.id, "--sha", fixture.planSha,
    ]), () => fixture.runtime))
    expect(approval).toBe(`workflow ${fixture.workflow.id} executing`)
    expect(effectiveHold(fixture.root, fixture.sessionID)).toBe(true)
    const workflowBeforeStatus = readFileSync(workflowPath(fixture.root, fixture.sessionID))
    const dispatchesBeforeStatus = fixture.dispatched.length
    await runCli(parseCliArgs(["status", "--worktree", fixture.root, "--session", fixture.sessionID, "--json"]))
    expect(readFileSync(workflowPath(fixture.root, fixture.sessionID))).toEqual(workflowBeforeStatus)
    expect(fixture.dispatched).toHaveLength(dispatchesBeforeStatus)

    for (const letter of ["a", "b", "c"]) {
      fixture.responses.push(JSON.stringify({ type: "tool", name: "write", input: { path: `${letter}.txt`, content: `after-${letter}\n` } }))
      fixture.responses.push(finalEnvelope("Open issues: none"), finalEnvelope("ACCEPT"))
    }
    const result = await runCli(parseCliArgs(["run", "--worktree", fixture.root, "--engine", fixture.engine,
      "--model", fixture.model, "--session", fixture.sessionID]), () => fixture.runtime)
    expect(result).toContain(`workflow ${fixture.workflow.id} done`)
    expect(readWorkflow(fixture.root, fixture.sessionID)?.phase).toBe("done")
    expect(fixture.dispatched.length).toBeGreaterThan(dispatchesBeforeStatus)
  }, 15_000)

  test("a fresh-process common CLI cancellation settles a pending-approval workflow", async () => {
    const fixture = await pendingCommonWorkflow()
    const runStatePath = join(executionRunDirectory(fixture.root), "state.json")
    const runStateBefore = readFileSync(runStatePath)
    const result = await invokeCommonCli(fixture.root, ["cancel", "--worktree", fixture.root,
      "--engine", fixture.engine, "--model", fixture.model, "--session", fixture.sessionID])
    expect(result.exitCode).toBe(0)
    // Fail-closed liveness (architect finding 1): a non-owner process records the intent and never settles from proof it
    // cannot see; the owning process's observer settles it.
    expect(result.stdout).toContain(`workflow ${fixture.workflow.id} pending_approval; cancellation requested; execution retirement pending; termination unconfirmed`)
    expect(result.stderr).toBe("")
    expect(readWorkflow(fixture.root, fixture.sessionID)).toMatchObject({ phase: "pending_approval", stopIntent: { kind: "cancel" } })
    expect(observeStopSettlement(fixture.runtime, fixture.sessionID, readWorkflow(fixture.root, fixture.sessionID)!.owner.instance, "owner").kind).toBe("settled")
    expect(readWorkflow(fixture.root, fixture.sessionID)?.phase).toBe("cancelled")
    expect(readFileSync(runStatePath)).toEqual(runStateBefore)
  })

  test("approve -> run -> Apply: the whole plan runs in one worktree and the checkout changes only on Apply", async () => {
    const fixture = await pendingCommonWorkflow()
    const controller = createForegroundController(fixture.runtime, { planWorktree: true })
    const approval = await withTerminalLine(`APPROVE ${fixture.workflow.id} ${fixture.planSha}`, () =>
      humanDecision("approve", planBinding(fixture.sessionID, fixture.workflow, fixture.planSha)))
    expect(controller.decide(approval, fixture.sessionID).ok).toBe(true)
    fixture.responses.push(finalEnvelope("Open issues: none")) // a.txt already holds after-a: nothing to change or review
    for (const letter of ["b", "c"]) {
      fixture.responses.push(JSON.stringify({ type: "tool", name: "write", input: { path: `${letter}.txt`, content: `after-${letter}\n` } }))
      fixture.responses.push(finalEnvelope("Open issues: none"), finalEnvelope("ACCEPT"))
    }
    const checkoutBefore = ["a", "b", "c"].map(letter => readFileSync(join(fixture.root, `${letter}.txt`), "utf8"))

    const ran = await controller.run(fixture.sessionID)
    expect(ran.run).toMatchObject({ done: 3, failed: 0 })
    expect(ran.workflow.phase).toBe("done")
    expect(ran.planWorktree).toEqual({ workflowID: fixture.workflow.id })
    const planPath = join(worktreeRoot(fixture.root), fixture.sessionID, `wf-${fixture.workflow.id}`)
    expect(readFileSync(join(planPath, "b.txt"), "utf8")).toBe("after-b\n") // both tasks wrote into the one worktree
    expect(controller.pendingPlanWorktree(fixture.sessionID)).toBe(fixture.workflow.id)
    // nothing reached the checkout during the run
    expect(["a", "b", "c"].map(letter => readFileSync(join(fixture.root, `${letter}.txt`), "utf8"))).toEqual(checkoutBefore)
    expect(readFileSync(join(planPath, "c.txt"), "utf8")).toBe("after-c\n")

    const review = await controller.reviewPlanWorktree(fixture.sessionID, fixture.workflow.id)
    expect(review).toMatchObject({ ok: true, path: planPath, files: ["b.txt", "c.txt"] })
    if (!review.ok) throw new Error(review.reason)
    expect(review.stat).toContain("2 files changed")
    expect(existsSync(review.patch)).toBe(true)
    expect(readFileSync(join(fixture.root, "b.txt"), "utf8")).toBe("before\n")

    const applied = await controller.applyPlanWorktree(fixture.sessionID, fixture.workflow.id, review.tree)
    expect(applied).toEqual({ ok: true, workflowID: fixture.workflow.id, files: ["b.txt", "c.txt"] })
    expect(readFileSync(join(fixture.root, "b.txt"), "utf8")).toBe("after-b\n")
    expect(readFileSync(join(fixture.root, "c.txt"), "utf8")).toBe("after-c\n")
    expect(existsSync(planPath)).toBe(false)
    expect(controller.pendingPlanWorktree(fixture.sessionID)).toBeUndefined()
  }, 60_000)

  test("Discard removes the plan worktree and leaves the checkout unchanged; an Apply conflict keeps worktree and checkout", async () => {
    const fixture = await pendingCommonWorkflow()
    const controller = createForegroundController(fixture.runtime, { planWorktree: true })
    const approval = await withTerminalLine(`APPROVE ${fixture.workflow.id} ${fixture.planSha}`, () =>
      humanDecision("approve", planBinding(fixture.sessionID, fixture.workflow, fixture.planSha)))
    expect(controller.decide(approval, fixture.sessionID).ok).toBe(true)
    fixture.responses.push(finalEnvelope("Open issues: none"))
    for (const letter of ["b", "c"]) {
      fixture.responses.push(JSON.stringify({ type: "tool", name: "write", input: { path: `${letter}.txt`, content: `after-${letter}\n` } }))
      fixture.responses.push(finalEnvelope("Open issues: none"), finalEnvelope("ACCEPT"))
    }
    await controller.run(fixture.sessionID)
    writeFileSync(join(fixture.root, "b.txt"), "user edit\n") // the user edits the same line meanwhile
    const preview = await controller.reviewPlanWorktree(fixture.sessionID, fixture.workflow.id)
    if (!preview.ok) throw new Error(preview.reason)
    const conflict = await controller.applyPlanWorktree(fixture.sessionID, fixture.workflow.id, preview.tree)
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) {
      expect(conflict.reason).toMatch(/does not apply/)
      expect(readFileSync(conflict.patch, "utf8")).toContain("+after-b")
    }
    expect(readFileSync(join(fixture.root, "b.txt"), "utf8")).toBe("user edit\n")
    expect(readFileSync(join(fixture.root, "c.txt"), "utf8")).toBe("before\n")
    expect(controller.pendingPlanWorktree(fixture.sessionID)).toBe(fixture.workflow.id)

    await controller.discardPlanWorktree(fixture.sessionID, fixture.workflow.id)
    expect(controller.pendingPlanWorktree(fixture.sessionID)).toBeUndefined()
    expect(readFileSync(join(fixture.root, "b.txt"), "utf8")).toBe("user edit\n")
    expect(readFileSync(join(fixture.root, "c.txt"), "utf8")).toBe("before\n")
  }, 60_000)

  test("without a commit the run refuses with PlanIsolationUnavailableError until the caller chooses in place explicitly", async () => {
    const fixture = await pendingCommonWorkflow()
    execFileSync("git", ["update-ref", "-d", "HEAD"], { cwd: fixture.root, env: GIT_TEST_ENV })
    const controller = createForegroundController(fixture.runtime, { planWorktree: true })
    const approval = await withTerminalLine(`APPROVE ${fixture.workflow.id} ${fixture.planSha}`, () =>
      humanDecision("approve", planBinding(fixture.sessionID, fixture.workflow, fixture.planSha)))
    expect(controller.decide(approval, fixture.sessionID).ok).toBe(true)
    await expect(controller.run(fixture.sessionID)).rejects.toBeInstanceOf(PlanIsolationUnavailableError)
    expect(fixture.dispatched).toHaveLength(2) // only the planning turn and plan review ran; nothing was dispatched silently in place
    expect(readFileSync(join(fixture.root, "b.txt"), "utf8")).toBe("before\n")
  }, 30_000)

  test("settled resume keeps completed tasks and dispatches only the open tasks", async () => {
    const fixture = await pendingCommonWorkflow()
    const approval = await withTerminalLine(`APPROVE ${fixture.workflow.id} ${fixture.planSha}`, () =>
      humanDecision("approve", planBinding(fixture.sessionID, fixture.workflow, fixture.planSha)))
    expect(fixture.controller.decide(approval, fixture.sessionID).ok).toBe(true)
    const ledger = readLedger(fixture.root, fixture.sessionID)
    writeLedger(fixture.root, { ...ledger, tasks: ledger.tasks.map((task, index) => index === 0
      ? { ...task, status: "done" as const, attempts: 1, finishedAt: Date.now(), report: "completed before interruption" }
      : task) })
    for (const letter of ["b", "c"]) {
      fixture.responses.push(JSON.stringify({ type: "tool", name: "write", input: { path: `${letter}.txt`, content: `after-${letter}\n` } }))
      fixture.responses.push(finalEnvelope("Open issues: none"), finalEnvelope("ACCEPT"))
    }

    const resumed = await fixture.controller.resume(fixture.sessionID)
    expect(resumed.run.done).toBe(2)
    expect(resumed.workflow.phase).toBe("done")
    expect(readLedger(fixture.root, fixture.sessionID).tasks.map(task => task.status)).toEqual(["done", "done", "done"])
    expect(fixture.dispatched).toHaveLength(8)
    expect(fixture.responses).toHaveLength(0)
    expect(readFileSync(join(fixture.root, "a.txt"), "utf8")).toBe("after-a\n")
    expect(readFileSync(join(fixture.root, "b.txt"), "utf8")).toBe("after-b\n")
    expect(readFileSync(join(fixture.root, "c.txt"), "utf8")).toBe("after-c\n")
  }, 30_000)

  test("common CLI resume fails when the resumed workflow does not finish successfully", async () => {
    const fixture = await pendingCommonWorkflow()
    const approval = await withTerminalLine(`APPROVE ${fixture.workflow.id} ${fixture.planSha}`, () =>
      humanDecision("approve", planBinding(fixture.sessionID, fixture.workflow, fixture.planSha)))
    expect(fixture.controller.decide(approval, fixture.sessionID).ok).toBe(true)
    fixture.responses.push(
      finalEnvelope("Open issues: unable to complete task"),
      finalEnvelope("Open issues: unable to complete task"),
      finalEnvelope("Open issues: unable to complete task"),
    )

    const args = parseCliArgs(["resume", "--worktree", fixture.root, "--engine", fixture.engine,
      "--model", fixture.model, "--session", fixture.sessionID])
    await expect(runCli(args, () => fixture.runtime)).rejects.toThrow(
      "common-engine resume incomplete; inspect read-only status",
    )
    expect(readWorkflow(fixture.root, fixture.sessionID)?.phase).toBe("stuck")
    expect(readLedger(fixture.root, fixture.sessionID).tasks.map(task => task.status)).toEqual(["done", "failed", "failed"])
  }, 30_000)

  test("live foreign common-engine cancellation is request-only and preserves its execution claim", async () => {
    const fixture = await pendingCommonWorkflow()
    const claim = fixture.runtime.runs.claim(fixture.sessionID, "foreign-live-owner", process.pid)
    const executionID = "live-foreign-owner-execution"
    fixture.runtime.runs.registerIntent(claim, {
      executionId: executionID, ownerSession: fixture.sessionID, taskId: fixture.workflow.id,
      attemptId: "live-foreign-attempt", generation: claim.generation, role: "worker", cwd: fixture.root,
      policyID: fixture.runtime.policy.resolve("worker").id, kind: "host", engine: fixture.engine, profile: "legacy-unowned",
    })
    fixture.runtime.runs.markHostDispatched(claim, executionID)
    const workflow = readWorkflow(fixture.root, fixture.sessionID)!
    const owner = workflow.owner
    expect(owner.instance).toBe(fixture.session.epoch)

    const statePath = join(executionRunDirectory(fixture.root), "state.json")
    const stateBefore = readFileSync(statePath)
    const claimBefore = fixture.runtime.runs.status().claim
    const cancellationCallsBefore = fixture.cancelCalls
    const signals: Array<{ pid: number; signal: Parameters<typeof process.kill>[1] }> = []
    const processKill = spyOn(process, "kill").mockImplementation((pid, signal) => {
      signals.push({ pid, signal })
      return true
    })
    try {
      const result = await runCli(parseCliArgs(["cancel", "--worktree", fixture.root, "--engine", fixture.engine,
        "--model", fixture.model, "--session", fixture.sessionID]))
      expect(result).toContain("cancellation requested; execution retirement pending")
      expect(readWorkflow(fixture.root, fixture.sessionID)).toMatchObject({ stopIntent: expect.objectContaining({ kind: "cancel" }), owner: { instance: owner.instance, pid: owner.pid } })
      expect(fixture.runtime.runs.status().claim).toEqual(claimBefore)
      expect(readFileSync(statePath)).toEqual(stateBefore)
      expect(fixture.cancelCalls).toBe(cancellationCallsBefore)
      expect(signals.every(call => call.signal === 0)).toBe(true)
    } finally {
      processKill.mockRestore()
    }
  })

  test("unsettled dead-owner execution refuses cancel and resume without changing state or signalling a handle", async () => {
    const fixture = await pendingCommonWorkflow()
    const runStatePath = join(executionRunDirectory(fixture.root), "state.json")
    const runState = JSON.parse(readFileSync(runStatePath, "utf8")) as { generation: number; executions: unknown[]; claim?: unknown }
    const at = Date.now()
    const executionId = "dead-owner-unresolved-execution"
    runState.executions.push({
      executionId, ownerSession: fixture.sessionID, taskId: fixture.workflow.id, attemptId: "dead-owner-attempt",
      generation: runState.generation, role: "worker", cwd: fixture.root,
      policyID: fixture.runtime.policy.resolve("worker").id, kind: "host", engine: fixture.engine,
      profile: "legacy-unowned", hostDispatch: "started",
      fence: { reason: "dead owner recovery unknown", at },
      reconciliation: { outcome: "unknown", quiescent: false, evidence: "dead owner recovery proof unavailable", at },
    })
    delete runState.claim
    writeFileSync(runStatePath, JSON.stringify(runState))
    rewriteCommitted(fixture.root, { owner: { instance: "dead-owner-fixture", pid: 2_147_483_647 } })
    const stateBefore = readFileSync(runStatePath)
    const artifactsBefore = recoverySnapshot(fixture.root, fixture.sessionID, fixture.workflow.id)
    const cancelsBefore = fixture.cancelCalls
    const reconcilesBefore = fixture.reconcileCalls

    expect(() => fixture.controller.cancel(fixture.sessionID)).toThrow("execution unresolved")
    await expect(fixture.controller.resume(fixture.sessionID)).rejects.toThrow("workflow owner is not bound to this attachment epoch")
    for (const command of ["cancel", "resume"]) {
      await expect(runCli(parseCliArgs([command, "--worktree", fixture.root, "--engine", fixture.engine,
        "--model", fixture.model, "--session", fixture.sessionID]))).rejects.toThrow(command === "cancel"
          ? "execution unresolved" : "workflow owner is not bound to this attachment epoch")
    }
    expect(readFileSync(runStatePath)).toEqual(stateBefore)
    expect(recoverySnapshot(fixture.root, fixture.sessionID, fixture.workflow.id)).toEqual(artifactsBefore)
    expect(fixture.cancelCalls).toBe(cancelsBefore)
    expect(fixture.reconcileCalls).toBe(reconcilesBefore)
  })

  test("wrong recovery engine, model, or session refuses before any workflow or file mutation", async () => {
    const fixture = await pendingCommonWorkflow()
    const before = recoverySnapshot(fixture.root, fixture.sessionID, fixture.workflow.id)
    const args = (engine: string, model: string, session: string) => parseCliArgs([
      "cancel", "--worktree", fixture.root, "--engine", engine, "--model", model, "--session", session,
    ])
    await expect(runCli(args("claude", "fixture-model", fixture.sessionID))).rejects.toThrow("engine identity mismatch")
    await expect(runCli(args("local", "different-model", fixture.sessionID))).rejects.toThrow("policy identity evidence")
    await expect(runCli(args("local", fixture.model, "different-session"))).rejects.toThrow("no workflow owned by this session")
    expect(recoverySnapshot(fixture.root, fixture.sessionID, fixture.workflow.id)).toEqual(before)
    expect(fixture.dispatched).toHaveLength(2)
    expect(fixture.cancelCalls).toBe(0)

    const runStatePath = join(executionRunDirectory(fixture.root), "state.json")
    const runState = JSON.parse(readFileSync(runStatePath, "utf8")) as { executions: Array<{ ownerSession: string; kind?: string }> }
    runState.executions = runState.executions.filter(execution => execution.ownerSession !== fixture.sessionID || execution.kind !== "host")
    writeFileSync(runStatePath, JSON.stringify(runState))
    const missingEvidenceBefore = recoverySnapshot(fixture.root, fixture.sessionID, fixture.workflow.id)
    await expect(runCli(args("local", fixture.model, fixture.sessionID))).rejects.toThrow("policy identity evidence is absent")
    expect(recoverySnapshot(fixture.root, fixture.sessionID, fixture.workflow.id)).toEqual(missingEvidenceBefore)
  })

  test("Codex controller admission refuses before running inference", async () => {
    const letters = ["a", "b", "c"]
    const files: Record<string, string> = {}
    for (const letter of letters) {
      files[`${letter}.txt`] = "before\n"
      files[`verify-${letter}.test.sh`] = `test "$(cat ${letter}.txt)" = after-${letter}\n`
    }
    wt = tempGitWorktree(files)
    const root = realpathSync(wt.worktree)
    const dispatched: CliTransportOptions[] = []
    const transportFactory = (options: CliTransportOptions): CliTransportHandle => ({
      async run() {
        dispatched.push(options)
        return { status: "completed", text: "unexpected inference", quiescent: true }
      },
      async requestCancel() { return { requested: true, acknowledged: true, terminal: true, quiescent: true } },
      async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "fixture transport" } },
    })
    const config = structuredClone(DEFAULT_CONFIG)
    config.models = Object.fromEntries(EXECUTION_ROLES.map(role => [role, "codex/gpt-5.6-sol"]))
    const runtime = createExecutionRuntime({ directory: root, worktree: root, config, log() {} }, ({ policy, runs }) =>
      createCliHost({ engine: "codex", model: "gpt-5.6-sol", policy, runs, createTransport: transportFactory }))
    const session = attachAdmission(runtime, "codex-admission", { engine: "codex", model: "gpt-5.6-sol" })
    const controller = createForegroundController(runtime)
    const plan = {
      goal: "Update the three tracked text values with verified contents",
      steps: letters.map(letter => ({ title: `Update ${letter}`, files: [`${letter}.txt`],
        detail: `Write after-${letter} followed by a newline to ${letter}.txt. Do not alter tests.`, verify: `sh verify-${letter}.test.sh` })),
      risks: ["Unexpected changes must not be accepted"],
    }

    await expect(controller.importPlan("codex-admission", "", undefined, { ...plan, revision: 1 }))
      .rejects.toThrow("host incompatible")
    expect(dispatched).toHaveLength(0)
    for (const letter of letters) expect(readFileSync(join(root, `${letter}.txt`), "utf8")).toBe("before\n")
    expect(readWorkflow(root)).toBeNull()
    expect(await detachAdmission(runtime, "codex-admission", session.epoch, "test-host-refusal")).toBe(true)
  }, 30_000)
})
