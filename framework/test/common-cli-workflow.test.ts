import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { eventsPath, planJsonPath, readWorkflow, workflowPath } from "../src/flow/state.ts"
import { parseCliArgs, runCli } from "../src/hosts/cli.ts"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { createCliHost } from "../src/hosts/cli-host.ts"
import type { CliEngine, CliTransportHandle, CliTransportOptions } from "../src/hosts/cli-transport.ts"
import { createForegroundController } from "../src/hosts/controller.ts"
import { humanDecision } from "../src/hosts/operator.ts"
import { createPlanConversation } from "../src/hosts/plan-conversation.ts"
import { createExecutionRuntime } from "../src/hosts/runtime.ts"
import { EXECUTION_ROLES } from "../src/hosts/types.ts"
import { executionRunDirectory } from "../src/state/store.ts"
import { ledgerPath, readLedger, writeLedger } from "../src/state/ledger.ts"
import { tempGitWorktree } from "./guards-helpers.ts"
import { withTerminalLine } from "./operator-helpers.ts"

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
    detail: `Write after-${letter} followed by a newline to ${letter}.txt. Do not alter tests.`, verify: `bun test verify-${letter}.test.ts` })),
  risks: ["Unexpected changes must not be accepted"],
}
const finalEnvelope = (text: string) => JSON.stringify({ type: "final", text })

async function pendingCommonWorkflow() {
  const files: Record<string, string> = {}
  for (const letter of ["a", "b", "c"]) {
    files[`${letter}.txt`] = letter === "a" ? "after-a\n" : "before\n"
    files[`verify-${letter}.test.ts`] = `import {expect,test} from 'bun:test';import{readFileSync}from'node:fs';test('updated ${letter}',()=>expect(readFileSync('${letter}.txt','utf8')).toBe('after-${letter}\\n'));\n`
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
  const selected = createCliRuntime({ worktree: root, engine, model })
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
    createCliHost({ engine, model, policy, runs, createTransport: transportFactory }), { planningOnlyMain: true })
  const controller = createForegroundController(runtime)
  const sessionID = "common-recovery-session"
  const conversation = createPlanConversation(runtime, sessionID)
  const discussed = await conversation.turn("Plan the requested three file changes")
  expect(discussed.plan).toEqual(fixturePlan)
  const submitted = await controller.importPlan(sessionID, "", undefined, { ...fixturePlan, revision: 1 })
  if (!submitted.result.ok) throw new Error(submitted.result.text)
  return { root, engine, model, sessionID, runtime, controller, workflow: submitted.result.wf, planSha: submitted.planSha,
    responses, dispatched, get cancelCalls() { return cancelCalls }, get reconcileCalls() { return reconcileCalls } }
}

function recoverySnapshot(root: string, sessionID: string, workflowID: string): Array<{ path: string; exists: boolean; bytes?: Buffer }> {
  const workflow = readWorkflow(root)
  const paths = [workflowPath(root), eventsPath(root), join(executionRunDirectory(root), "state.json"), planJsonPath(root, workflowID),
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
        files[`verify-${letter}.test.ts`] = `import {expect,test} from 'bun:test';import{readFileSync}from'node:fs';test('updated ${letter}',()=>expect(readFileSync('${letter}.txt','utf8')).toBe('after-${letter}\\n'));\n`
      }
      wt = tempGitWorktree(files)
      const root = realpathSync(wt.worktree)
      const plan = {
        goal: "Update the three tracked text values with verified contents",
        steps: letters.map(letter => ({ title: `Update ${letter}`, files: [`${letter}.txt`],
          detail: `Write after-${letter} followed by a newline to ${letter}.txt. Do not alter tests.`, verify: `bun test verify-${letter}.test.ts` })),
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
      const runtime = createExecutionRuntime({ directory: root, worktree: root, config, log() {} }, ({ policy, runs }) =>
        createCliHost({ engine: engine as CliEngine, model: "fixture-model", policy, runs, createTransport: transportFactory }))
      const controller = createForegroundController(runtime)
      const sessionID = `common-${engine}`
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
        humanDecision("approve", workflow.id, submission.planSha))
      expect(controller.assertRecoveryIdentity(sessionID, workflow.id, submission.planSha).id).toBe(workflow.id)
      expect(controller.decide(approval, sessionID).ok).toBe(true)
      await controller.run(sessionID)
      for (const letter of letters) expect(readFileSync(join(root, `${letter}.txt`), "utf8")).toBe(`after-${letter}\n`)
      expect(readLedger(root, sessionID).tasks.map(task => task.status)).toEqual(["done", "done", "done"])
      expect(readWorkflow(root)?.phase).toBe("done")
      expect(responses).toHaveLength(0)
      expect(runtime.runs.status().claim).toBeUndefined()
      for (const execution of runtime.runs.status().executions.filter(record => record.kind === "host")) {
        expect(execution.engine).toBe(engine)
        expect(execution.profile).toBe("legacy-unowned")
        expect(execution.controlProfile).toBe("estimated-input-reactive-output-v1")
      }
    }, 30_000)
  }

  test("common CLI approval and rejection use the explicit owner session, workflow and plan SHA", async () => {
    const approved = await pendingCommonWorkflow()
    const approval = await withTerminalLine(`APPROVE ${approved.workflow.id} ${approved.planSha}`, () => runCli(parseCliArgs([
      "approve", "--worktree", approved.root, "--engine", approved.engine, "--model", approved.model,
      "--session", approved.sessionID, "--workflow", approved.workflow.id, "--sha", approved.planSha,
    ])))
    expect(approval).toBe(`workflow ${approved.workflow.id} executing`)
    expect(readWorkflow(approved.root)?.sessionID).toBe(approved.sessionID)
    wt?.cleanup()
    wt = undefined

    const rejected = await pendingCommonWorkflow()
    const rejection = await withTerminalLine(`REJECT ${rejected.workflow.id} ${rejected.planSha} defer this plan`, () => runCli(parseCliArgs([
      "reject", "--worktree", rejected.root, "--engine", rejected.engine, "--model", rejected.model,
      "--session", rejected.sessionID, "--workflow", rejected.workflow.id, "--sha", rejected.planSha,
    ])))
    expect(rejection).toBe(`workflow ${rejected.workflow.id} planning`)
    expect(readWorkflow(rejected.root)?.phase).toBe("planning")
  })

  test("a fresh-process common CLI cancellation settles a pending-approval workflow", async () => {
    const fixture = await pendingCommonWorkflow()
    const runStatePath = join(executionRunDirectory(fixture.root), "state.json")
    const runStateBefore = readFileSync(runStatePath)
    const result = await invokeCommonCli(fixture.root, ["cancel", "--worktree", fixture.root,
      "--engine", fixture.engine, "--model", fixture.model, "--session", fixture.sessionID])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`workflow ${fixture.workflow.id} cancelled`)
    expect(result.stderr).toBe("")
    expect(readWorkflow(fixture.root)?.phase).toBe("cancelled")
    expect(readFileSync(runStatePath)).toEqual(runStateBefore)
  })

  test("settled resume keeps completed tasks and dispatches only the open tasks", async () => {
    const fixture = await pendingCommonWorkflow()
    const approval = await withTerminalLine(`APPROVE ${fixture.workflow.id} ${fixture.planSha}`, () =>
      humanDecision("approve", fixture.workflow.id, fixture.planSha))
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
      humanDecision("approve", fixture.workflow.id, fixture.planSha))
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
    expect(readWorkflow(fixture.root)?.phase).toBe("stuck")
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
    const workflow = readWorkflow(fixture.root)!
    const owner = { instance: "foreign-live-owner", pid: process.pid, heartbeatAt: Date.now() }
    writeFileSync(workflowPath(fixture.root), JSON.stringify({ ...workflow, owner }))

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
      expect(readWorkflow(fixture.root)).toMatchObject({ pendingCancel: true, owner })
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
    const persistedWorkflow = JSON.parse(readFileSync(workflowPath(fixture.root), "utf8")) as { owner: unknown }
    persistedWorkflow.owner = { instance: "dead-owner-fixture", pid: 2_147_483_647, heartbeatAt: 0 }
    writeFileSync(workflowPath(fixture.root), JSON.stringify(persistedWorkflow))
    const stateBefore = readFileSync(runStatePath)
    const artifactsBefore = recoverySnapshot(fixture.root, fixture.sessionID, fixture.workflow.id)
    const cancelsBefore = fixture.cancelCalls
    const reconcilesBefore = fixture.reconcileCalls

    expect(() => fixture.controller.cancel(fixture.sessionID)).toThrow("execution unresolved")
    await expect(fixture.controller.resume(fixture.sessionID)).rejects.toThrow("execution unresolved")
    for (const command of ["cancel", "resume"]) {
      await expect(runCli(parseCliArgs([command, "--worktree", fixture.root, "--engine", fixture.engine,
        "--model", fixture.model, "--session", fixture.sessionID]))).rejects.toThrow("execution unresolved")
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
      files[`verify-${letter}.test.ts`] = `import {expect,test} from 'bun:test';import{readFileSync}from'node:fs';test('updated ${letter}',()=>expect(readFileSync('${letter}.txt','utf8')).toBe('after-${letter}\\n'));\n`
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
    const controller = createForegroundController(runtime)
    const plan = {
      goal: "Update the three tracked text values with verified contents",
      steps: letters.map(letter => ({ title: `Update ${letter}`, files: [`${letter}.txt`],
        detail: `Write after-${letter} followed by a newline to ${letter}.txt. Do not alter tests.`, verify: `bun test verify-${letter}.test.ts` })),
      risks: ["Unexpected changes must not be accepted"],
    }

    await expect(controller.importPlan("codex-admission", "", undefined, { ...plan, revision: 1 }))
      .rejects.toThrow("host incompatible")
    expect(dispatched).toHaveLength(0)
    for (const letter of letters) expect(readFileSync(join(root, `${letter}.txt`), "utf8")).toBe("before\n")
    expect(readWorkflow(root)).toBeNull()
  }, 30_000)
})
