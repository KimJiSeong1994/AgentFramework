// /status (M0 step 3, ARCH-08/ARCH-13): command.execute.before marks the turn by name, chat.message rewrites the
// command's own text part in place with the code-rendered status marker, and the config hook records only the
// names otter actually injected so a user-defined command with the same name is never acted on.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createCommandHook, STATUS_COMMAND, STATUS_DESCRIPTION, STATUS_TEMPLATE, STOP_COMMAND } from "../src/hooks/command.ts"
import { consumeCommandTurn } from "../src/hooks/command-turns.ts"
import { createConfigHook } from "../src/hooks/config.ts"
import { STATUS_MARKER, statusJson } from "../src/flow/status.ts"
import { eventsPath, newWorkflow, workflowPath, withFlowTransaction } from "../src/flow/state.ts"
import { writeRawSnapshot, writeWorkflow } from "./commit-fixture.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { admitFixtureSession, fakeClient, makeDeps, releaseFixtureSession, tempWorktree, type FakeClient } from "./guards-helpers.ts"
import { fakeDeps } from "./helpers.ts"
import { createNativeToolFixture } from "./native-tool-fixture.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { addTasks, emptyLedger, ledgerPath, updateTask, writeLedger } from "../src/state/ledger.ts"
import { executionRunDirectory, modeStatePath } from "../src/state/store.ts"

const S = "ses_main"
const OTHER = "ses_other"
let wt: ReturnType<typeof tempWorktree>
let client: FakeClient
let fixtureSession: ReturnType<typeof admitFixtureSession>

beforeEach(() => {
  // Command marks are process-global; earlier files in the same run (e.g. command-stop) can leave unconsumed ones.
  for (const id of [S, OTHER]) while (consumeCommandTurn(id)) { /* drain */ }
  wt = tempWorktree()
  client = fakeClient()
  fixtureSession = admitFixtureSession(makeDeps(client, wt.worktree), S)
})
afterEach(() => {
  releaseFixtureSession(wt.worktree, fixtureSession)
  wt.cleanup()
})

function putWorkflow(patch: Record<string, unknown> = {}) {
  const wf = { ...newWorkflow(S, currentOwner(Date.now(), fixtureSession.epoch), "command", "do it", "opencode"), ...patch }
  return withFlowTransaction(wt.worktree, flowTx => writeWorkflow(flowTx, wf as any))
}

async function runStatus(deps = makeDeps(client, wt.worktree), sessionID = S) {
  const extraAdmission = sessionID === S ? undefined : admitFixtureSession(deps, sessionID)
  try {
    const native = await createNativeToolFixture(deps, { sessionID })
    const commandHook = createCommandHook(deps, { stop: true, status: true })
    await commandHook({ command: STATUS_COMMAND, sessionID, arguments: "" }, { parts: [] })
    const { parts } = await native.deliverUserTurn({ text: STATUS_TEMPLATE })
    const part = parts.find(candidate => candidate.type === "text")
    if (!part || part.type !== "text") throw new Error("native status turn did not contain a text part")
    return part.text
  } finally {
    if (extraAdmission) releaseFixtureSession(wt.worktree, extraAdmission)
  }
}

const SECRET_MARKERS = [
  "workflow-request-secret", "workflow-counter-secret", "task-detail-secret", "task-report-secret", "task-sql-secret",
  "task-answer-secret", "task-handoff-secret", "task-error-secret", "task-blocked-secret", "task-verify-command-secret",
  "task-verify-output-secret", "task-review-reason-secret", "task-review-session-secret",
]

function plantStatusSecrets() {
  const wf = putWorkflow({
    phase: "executing",
    request: "workflow-request-secret",
    counters: { code_invalid: 0, review_iterations: 0, user_rejections: 0, nudges: 0, private: "workflow-counter-secret" },
  })
  const created = addTasks(emptyLedger(S), [{ title: "Benign approved task", kind: "data", wf: { id: wf.id, planSha: "safe-plan-sha" } }])
  const task = created.added[0]!
  writeLedger(wt.worktree, updateTask(created.ledger, task.id, {
    status: "failed", attempts: 1, startedAt: 10, finishedAt: 20,
    detail: "task-detail-secret", report: "task-report-secret", sql: "task-sql-secret", answer: "task-answer-secret",
    handoff: "task-handoff-secret", error: "task-error-secret", blocked: "task-blocked-secret",
    verify: "task-verify-command-secret", verify_result: {
      command: "task-verify-command-secret", ok: false, exitCode: 1, timedOut: false, output: "task-verify-output-secret",
    },
    review: { verdict: "reject", reason: "task-review-reason-secret", sessionID: "task-review-session-secret", aborted: false },
    filesChanged: ["src/safe.ts"],
  }))
  return wf
}

function readIfPresent(path: string) {
  try { return readFileSync(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
}

function statusInputSnapshot() {
  return [workflowPath(wt.worktree), ledgerPath(wt.worktree, S), modeStatePath(wt.worktree, S), eventsPath(wt.worktree),
    join(executionRunDirectory(wt.worktree), "state.json")].map(path => [path, readIfPresent(path)])
}

describe("/status", () => {
  test("JSON status exposes original recovery identifiers without taking over the workflow", () => {
    const planSha = "a".repeat(64)
    const wf = putWorkflow({
      engine: "codex",
      phase: "pending_approval",
      owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 },
      planRef: { jsonSha: planSha, mdPath: ".otter/plans/fixture.md", mdSha: "b".repeat(64), revision: 1 },
    })
    const before = readFileSync(workflowPath(wt.worktree))
    const runs = createExecutionRunStore(wt.worktree)
    const runsBefore = runs.status()
    const status = statusJson(makeDeps(client, wt.worktree), OTHER, { queueRunning: false })
    expect(status.workflow).toMatchObject({ id: wf.id, sessionID: S, engine: "codex", planSha })
    expect(status.session.id).toBe(OTHER)
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(before)
    expect(runs.status()).toEqual(runsBefore)
  })

  test("malformed status state replaces the template with a safe source/code error", async () => {
    // Index-bound snapshot whose bytes hash correctly but fail strict parsing: status reports invalid_state only.
    writeRawSnapshot(wt.worktree, { version: 2, id: "wf_bad", kind: "plan", phase: "planning", sessionID: S, secret: "must-not-leak" }, { id: "wf_bad", sessionID: S })
    const text = await runStatus()
    expect(text).toBe("[otter status]\nstatus unavailable: workflow invalid_state\n\nReply only: ok")
    expect(text).not.toContain("must-not-leak")
  })

  test("valid workflow and task free-form fields stay private on the chat status surface", async () => {
    plantStatusSecrets()
    const before = statusInputSnapshot()
    const text = await runStatus()
    for (const secret of SECRET_MARKERS) expect(text).not.toContain(secret)
    expect(text.split("\n").length).toBeLessThanOrEqual(25)
    expect(text).not.toContain('"sessions"')
    expect(text).not.toContain('"history"')
    expect(text).not.toContain('"detail"')
    expect(text).not.toContain('"filesChangedCount"')
    expect(statusInputSnapshot()).toEqual(before)
  })

  test("no workflow: marker, mode none, ledger, queue lines", async () => {
    const text = await runStatus()
    expect(text.startsWith(STATUS_MARKER)).toBe(true)
    expect(text).toContain("workflow: none")
    expect(text).toContain("mode: none")
    expect(text).toContain("ledger: 0 done, 0 open, 0 failed, 0 cancelled; queue idle")
    expect(text.endsWith("Reply only: ok")).toBe(true)
  })

  test("read-only status renders unresolved execution and never clears cancellation ACK", async () => {
    const deps = makeDeps(client, wt.worktree)
    const runtime = getOpenCodeRuntime(deps)
    const runs = runtime.runs
    const claim = runs.claim(S, "fixture", process.pid)
    runs.registerIntent(claim, { executionId: "exec", ownerSession: S, taskId: "task", attemptId: "attempt", generation: claim.generation, role: "worker", cwd: wt.worktree, policyID: "fixture-fixed-policy", kind: "host", engine: runtime.host.identity.engine, profile: "legacy-unowned" })
    runs.recordCancel(claim, "exec", { requestedAt: 1, acknowledgedAt: 2 })
    const before = runs.status()
    const text = await runStatus(deps)
    expect(text).toContain("execution: 1 unresolved, 1 cancel ACK")
    expect(text).toContain("usage unknown")
    expect(runs.status()).toEqual(before)
  })

  test("passed legacy verification visibly retains unproven descendant risk without mutating state", async () => {
    const runs = createExecutionRunStore(wt.worktree)
    const created = addTasks(emptyLedger(S), [{ title: "legacy verifier", verify: "true" }])
    const task = created.added[0]!
    writeLedger(wt.worktree, updateTask(created.ledger, task.id, { status: "done" }))
    const claim = runs.claim(S, "fixture", process.pid)
    const ref = { kind: "verifier" as const, executionID: "verify-1", profile: "legacy-unowned" as const,
      invocationID: "legacy-1", inputSnapshotID: "tree-1", inputDigest: "a".repeat(64), deadlineAt: Date.now() + 1000, maxOutputChars: 4096 }
    runs.registerIntent(claim, { executionId: "verify-1", ownerSession: S, taskId: task.id, attemptId: "attempt-1", generation: claim.generation,
      role: "verifier", cwd: wt.worktree, policyID: "verify-legacy", kind: "verifier", profile: "legacy-unowned",
      inputSnapshotID: ref.inputSnapshotID, inputDigest: ref.inputDigest, deadlineAt: ref.deadlineAt, maxOutputChars: ref.maxOutputChars })
    runs.bindVerifierRef(claim, "verify-1", ref)
    runs.markVerifierDispatched(claim, "verify-1")
    runs.recordTerminal(claim, "verify-1", { outcome: "ok", terminalAt: Date.now(), verification: {
      profile: "legacy-unowned", parentExit: 0, timedOut: false, cancelled: false, isolationEstablished: false,
      domainState: "unknown", integrity: "unchanged", output: "",
    } })
    const before = runs.status()
    expect(await runStatus()).toContain("verification: passed (legacy-unowned, descendants unproven)")
    expect(runs.status()).toEqual(before)
  })

  test("owning session, owner live: renders workflow phase, this session", async () => {
    const wf = putWorkflow({ phase: "planning" })
    const text = await runStatus()
    expect(text).toContain(`workflow: ${wf.id} planning — this session`)
  })

  test("foreign session, dead owner: renders 'owner dead' and mutates nothing (workflow.json + events byte-identical)", async () => {
    putWorkflow({ owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 } })
    const wfBefore = readFileSync(workflowPath(wt.worktree))
    const evBefore = (() => {
      try {
        return readFileSync(eventsPath(wt.worktree))
      } catch {
        return null
      }
    })()
    const text = await runStatus(makeDeps(client, wt.worktree), OTHER)
    expect(text).toContain("owner dead")
    expect(text).toContain(`session ${S}`)
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(wfBefore)
    const evAfter = (() => {
      try {
        return readFileSync(eventsPath(wt.worktree))
      } catch {
        return null
      }
    })()
    expect(evAfter).toEqual(evBefore)
  })

  test("owning session, dead owner: status is read-only and leaves takeover for explicit Resume", async () => {
    const wf = putWorkflow({ phase: "pending_approval", owner: { instance: "inst_dead", pid: 9_999_999, heartbeatAt: 0 } })
    const workflowBefore = readFileSync(workflowPath(wt.worktree))
    const eventsBefore = readIfPresent(eventsPath(wt.worktree))
    const text = await runStatus()
    expect(text).toContain(`workflow: ${wf.id} pending_approval — this session, owner dead`)
    expect(text).toContain("Session held; explicit owner Resume required.")
    expect(readFileSync(workflowPath(wt.worktree))).toEqual(workflowBefore)
    expect(readIfPresent(eventsPath(wt.worktree))).toEqual(eventsBefore)
  })

  test("a user-defined status command is not acted on (text untouched, no otter command logic runs)", async () => {
    const deps = makeDeps(client, wt.worktree)
    const native = await createNativeToolFixture(deps, { sessionID: S })
    await createConfigHook(deps)({ command: { status: { template: "my custom status output" } } })
    const commandHook = createCommandHook(deps, { stop: true, status: true })
    await commandHook({ command: STATUS_COMMAND, sessionID: S, arguments: "" }, { parts: [] })
    const { parts } = await native.deliverUserTurn({ text: "my custom status output" })
    const part = parts.find(candidate => candidate.type === "text")
    if (!part || part.type !== "text") throw new Error("native custom status turn did not contain a text part")
    expect(part.text).toBe("my custom status output")
  })

  test("config hook registers status when flow is on; records injected names; a user-defined status wins", async () => {
    const cfg: any = {}
    await createConfigHook(fakeDeps(wt.worktree))(cfg)
    expect(cfg.command[STATUS_COMMAND]).toEqual({ template: STATUS_TEMPLATE, description: STATUS_DESCRIPTION })

    const own: any = { command: { status: { template: "mine" } } }
    await createConfigHook(fakeDeps(wt.worktree))(own)
    expect(own.command.status.template).toBe("mine")

    const off: any = {}
    await createConfigHook(fakeDeps(wt.worktree, { flow: { enabled: false, max_code_invalid: 3, max_review_iterations: 2, nudge_max: 1, review_max_tool_calls: 6 } }))(off)
    expect(off.command?.status).toBeUndefined()

    const hookOff: any = {}
    await createConfigHook(fakeDeps(wt.worktree, { disabled_hooks: ["command.status"] }))(hookOff)
    expect(hookOff.command?.status).toBeUndefined()
  })

  test("otter_flow tool is absent from the effective config when flow is disabled (M0 AC0.7 semantics: main never denies it)", async () => {
    const cfg: any = {}
    await createConfigHook(fakeDeps(wt.worktree, { flow: { enabled: false, max_code_invalid: 3, max_review_iterations: 2, nudge_max: 1, review_max_tool_calls: 6 } }))(cfg)
    for (const name of ["main", "worker", "reviewer"]) {
      expect((cfg.agent?.[name]?.tools ?? {}).otter_flow).toBeUndefined()
    }
    // main never has otter_flow denied (it is the only agent allowed to call it, when the tool is registered)
    expect((cfg.agent?.main?.permission as Record<string, unknown> | undefined)?.otter_flow).toBeUndefined()
  })

  test("M1: otter_flow is denied for worker/reviewer, not denied for main (default config, flow on)", async () => {
    const cfg: any = {}
    await createConfigHook(fakeDeps(wt.worktree))(cfg)
    expect((cfg.agent?.main?.permission as Record<string, unknown> | undefined)?.otter_flow).toBeUndefined()
    expect((cfg.agent?.worker?.permission as Record<string, unknown> | undefined)?.otter_flow).toBe("deny")
    expect((cfg.agent?.reviewer?.permission as Record<string, unknown> | undefined)?.otter_flow).toBe("deny")
  })
})
