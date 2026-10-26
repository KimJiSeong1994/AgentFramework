import { expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { stopHeartbeat } from "../src/flow/runtime.ts"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { createCliTransport } from "../src/hosts/cli-transport.ts"
import { createForegroundController } from "../src/hosts/controller.ts"
import type { CliHostActivity, CliToolDisplay } from "../src/hosts/cli-progress.ts"
import { planWorktreePath } from "../src/orchestration/worktree.ts"
import { attachAdmission } from "../src/sessions/admission.ts"
import { readLedger } from "../src/state/ledger.ts"
import { readCommitted } from "../src/workflows/commit.ts"
import { approveUnit, runUltragoal, startUltragoal } from "../src/workflows/ultragoal-driver.ts"
import { approveUnitConfirmation, ultragoalDataOf } from "../src/workflows/ultragoal.ts"
import { TERMINAL } from "../src/workflows/types.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

// Opt-in: all model responses, tools and verification use the production runtime.
// OTTER_ISOLATION_LIVE_MODEL=gemma4-26b-mtp:latest bun test test/local-isolation.live.test.ts
const model = process.env.OTTER_ISOLATION_LIVE_MODEL
const reportPath = process.env.OTTER_ISOLATION_LIVE_REPORT

test.skipIf(!model)("real Ollama writes two isolated units and reviews their cumulative implementation", async () => {
  const wt = tempGitWorktree({
    ".gitignore": ".otter/\n",
    "README.md": "# Live isolation fixture\nTwo tiny TypeScript functions; existing checks must not be changed.\n",
    "check-first.sh": "set -eu\nbun test verify-first.test.ts\n",
    "check-second.sh": "set -eu\nbun test verify-second.test.ts\n",
    "verify-first.test.ts": 'import {expect,test} from "bun:test"; import {double} from "./first.ts"; test("double",()=>{expect(double(3)).toBe(6);expect(double(-2)).toBe(-4);expect(double(0)).toBe(0)})\n',
    "verify-second.test.ts": 'import {expect,test} from "bun:test"; import {twicePlusOne} from "./second.ts"; test("composition",()=>{expect(twicePlusOne(3)).toBe(7);expect(twicePlusOne(-2)).toBe(-3);expect(twicePlusOne(0)).toBe(1)})\n',
  })
  wt.worktree = realpathSync(wt.worktree)
  const sid = "live-isolation"
  const startedAt = performance.now()
  const calls: Array<Record<string, unknown>> = []
  const requests: Array<{ executionID: string; role: string; title: string; cwd: string; firstExists: boolean; secondExists: boolean; secondPlan: boolean; finalReview: boolean }> = []
  const activity: CliHostActivity[] = []
  const displays: CliToolDisplay[] = []
  const tools: Array<Record<string, unknown>> = []
  const report: Record<string, unknown> = { model, worktree: wt.worktree, stateHome: wt.stateHome, startedAt: new Date().toISOString(), calls, requests, activity, displays, tools, ok: false }
  const save = () => {
    if (reportPath) { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n") }
  }
  mkdirSync(join(wt.worktree, ".otter"), { recursive: true })
  writeFileSync(join(wt.worktree, ".otter", "otter.jsonc"), JSON.stringify({
    local_model: { context_input_tokens: 4096, keep_alive: "5m" }, memory: { engine: "off" },
    delegate: { task_ttl_ms: 90_000, max_attempts: 1 },
  }))
  let activeExecution: (typeof requests)[number] | undefined
  const runtime = createCliRuntime({
    worktree: wt.worktree, engine: "local", model: model!,
    progress: { queue() {}, host(event) { activity.push(event) }, toolDisplay(event) { displays.push(event) } },
    createTransport(options) {
      const entry: Record<string, unknown> = { executionID: activeExecution?.executionID,
        role: activeExecution?.role, title: activeExecution?.title, engine: options.engine, keepAlive: options.localKeepAlive,
        inputLimit: Number(options.prompt.match(/Input estimate limit: (\d+)/)?.[1]), inputChars: options.prompt.length }
      const transport = createCliTransport({ ...options, deadlineAt: Math.min(options.deadlineAt, Date.now() + 90_000) })
      return { ...transport, async run() {
        if (calls.length >= 48) throw new Error("live isolation inference cap reached")
        entry.index = calls.length + 1
        calls.push(entry)
        const began = performance.now()
        const result = await transport.run()
        Object.assign(entry, { elapsedMs: Math.round(performance.now() - began), status: result.status, response: result.text })
        save()
        console.log("LIVE_ISOLATION_CALL", JSON.stringify({ ...entry, response: undefined }))
        return result
      } }
    },
  })
  const prepare = runtime.host.prepare.bind(runtime.host)
  runtime.host.prepare = async request => {
    activeExecution = { executionID: request.executionID, role: request.role, title: request.title, cwd: request.cwd,
      firstExists: existsSync(join(request.cwd, "first.ts")), secondExists: existsSync(join(request.cwd, "second.ts")),
      secondPlan: request.role === "planner" && request.text.includes("CURRENT GOAL g2"),
      finalReview: request.role === "critic" && request.text.includes("GOALS AND VERIFIED CHECKPOINTS") }
    requests.push(activeExecution)
    return prepare({ ...request, handlers: { ...request.handlers,
      beforeTool(event) {
        const decision = request.handlers.beforeTool(event)
        tools.push({ executionID: request.executionID, callID: event.callID, name: event.name, input: event.input, allowed: decision.allow })
        return decision
      },
      toolResult(event) {
        const result = request.handlers.toolResult(event)
        const call = tools.findLast(item => item.executionID === request.executionID && item.callID === event.callID)
        if (call) Object.assign(call, { result: result.result ?? event.result, error: result.error ?? event.error, completed: true })
        return result
      },
    } })
  }
  const store = attachAdmission(runtime, sid, { engine: "local", model: model! })
  const controller = createForegroundController(runtime, { planWorktree: true })
  const signal = AbortSignal.timeout(480_000)
  let workflowID: string | undefined
  try {
    const started = startUltragoal(runtime, sid,
      "Implement exactly two ordered goals, one step per goal, with no new package dependencies or edits to existing check files. " +
      "Goal 1: create first.ts exporting double(value: number): number returning value * 2. Verify with exactly sh check-first.sh. " +
      "Goal 2: create second.ts importing double from ./first.ts and exporting twicePlusOne(value: number): number returning double(value) + 1. Verify with exactly sh check-second.sh. " +
      "Both scripts and their Bun tests already exist. Include only first.ts in goal 1's file scope and only second.ts in goal 2's file scope. " +
      "When planning a unit, implement ONLY the CURRENT GOAL, never both goals in one unit. " +
      "Goal 2 planning must read first.ts before proposing the unit. Final review must read first.ts and second.ts to inspect the actual implementation. Keep output concise.")
    if (!started.ok) throw new Error(started.text)
    workflowID = started.wf.id
    let result = await runUltragoal(runtime, controller, sid, workflowID, { signal })
    let approvals = 0
    while (result.status === "approval" && approvals < 2) {
      const wf = result.wf!
      const data = ultragoalDataOf(wf)
      expect(data.goals?.ids).toHaveLength(2)
      report.pending = data.pending
      save()
      expect(data.pending!.input.scope).toHaveLength(1)
      expect(data.pending!.input.allowedPaths).toEqual([approvals === 0 ? "first.ts" : "second.ts"])
      expect(data.pending!.input.verification).toEqual([approvals === 0 ? "sh check-first.sh" : "sh check-second.sh"])
      const approved = approveUnit(runtime, sid, wf.id, wf.lastSeq, approveUnitConfirmation(wf.id, data.pending!.subject.sha256))
      if (!approved.ok) throw new Error(approved.text)
      approvals++
      result = await runUltragoal(runtime, controller, sid, workflowID, { signal })
    }
    report.result = { status: result.status, reason: result.reason, approvals }
    report.committed = readCommitted(wt.worktree)
    report.tasks = readLedger(wt.worktree, sid).tasks
    const isolated = planWorktreePath(wt.worktree, sid, workflowID)
    report.files = isolated ? Object.fromEntries(["first.ts", "second.ts"].map(path => [path, existsSync(join(isolated, path)) ? readFileSync(join(isolated, path), "utf8") : null])) : {}
    save()
    expect(result.status).toBe("done")
    expect(approvals).toBe(2)
    expect(isolated).toBeDefined()
    expect(existsSync(join(isolated!, ".otter", "otter.jsonc"))).toBe(false)
    expect(existsSync(join(wt.worktree, "first.ts"))).toBe(false)
    expect(existsSync(join(wt.worktree, "second.ts"))).toBe(false)
    const tasks = readLedger(wt.worktree, sid).tasks
    expect(tasks).toHaveLength(2)
    expect(tasks.every(task => task.status === "done" && task.verify_result?.ok && task.verify_result.exitCode === 0)).toBe(true)
    const stages = requests.filter(request => request.secondPlan || request.finalReview)
    expect(stages.some(request => request.secondPlan)).toBe(true)
    expect(stages.some(request => request.finalReview)).toBe(true)
    expect(stages.every(request => request.cwd === isolated && request.firstExists)).toBe(true)
    expect(stages.filter(request => request.finalReview).every(request => request.secondExists)).toBe(true)
    for (const stage of stages) {
      // multiread is authorized and settled as individual child reads by the same policy handlers.
      expect(tools.some(call => call.executionID === stage.executionID && call.name === "read" && call.allowed && call.completed &&
        call.error === undefined && (call.input as { path?: string })?.path === "first.ts")).toBe(true)
    }
    expect(calls.every(call => call.engine === "local" && call.keepAlive === "5m" && Number(call.inputLimit) <= 4096)).toBe(true)
    expect(runtime.runs.status().claim).toBeUndefined()
    report.ok = true
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error)
    try { report.committed = readCommitted(wt.worktree); report.tasks = readLedger(wt.worktree, sid).tasks } catch { /* Preserve the original failure. */ }
    throw error
  } finally {
    report.elapsedMs = Math.round(performance.now() - startedAt)
    save()
    const cleanupErrors: string[] = []
    const clean = async (action: () => unknown | Promise<unknown>) => { try { await action() } catch (error) { cleanupErrors.push(String(error)) } }
    if (workflowID) await clean(async () => {
      const current = readCommitted(wt.worktree)
      if (current.state === "ok" && current.wf.id === workflowID && !TERMINAL.has(current.wf.phase)) controller.cancel(sid)
    })
    if (workflowID) await clean(async () => {
      if (planWorktreePath(wt.worktree, sid, workflowID!)) await controller.discardPlanWorktree(sid, workflowID!)
    })
    stopHeartbeat()
    await clean(() => store.release({ workflowQuiescent: true, evidence: "bounded real-model fixture settled", workflowID: null, revision: null }))
    await clean(() => wt.cleanup())
    report.cleanupErrors = cleanupErrors
    const completed = report.ok === true
    if (cleanupErrors.length) report.ok = false
    save()
    if (completed) expect(cleanupErrors).toEqual([])
  }
}, 510_000)
