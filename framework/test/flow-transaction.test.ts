import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, spyOn, test } from "bun:test"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { readForegroundStatus } from "../src/hosts/controller.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { applyEventIn, ensureHeartbeat, repairOnLoad, resolveAuthority, stopHeartbeat } from "../src/flow/runtime.ts"
import { appendEvents, eventsPath, FlowTransactionBusyError, FlowTransactionIntegrityError, type FlowTx, flowDir, newWorkflow, renderArtifact, rotate, withFlowTransaction, workflowPath, writePlanJson } from "../src/flow/state.ts"
import { committedSnapshot, writeWorkflow } from "./commit-fixture.ts"
import { ledgerPath } from "../src/state/ledger.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { beginExecutionActivity } from "../src/hosts/runtime.ts"
import { admitFixtureSession, requestCancel, fakeClient, makeDeps, releaseFixtureSession, tempWorktree } from "./guards-helpers.ts"

const worktrees: Array<ReturnType<typeof tempWorktree>> = []
const fixtureSessions: Array<{ worktree: string; store: ReturnType<typeof admitFixtureSession> }> = []
function makeWorktree() {
  const wt = tempWorktree()
  worktrees.push(wt)
  return wt
}
function admit(deps: ReturnType<typeof makeDeps>, sessionID: string) {
  const store = admitFixtureSession(deps, sessionID)
  fixtureSessions.push({ worktree: deps.worktree, store })
  return store
}
afterEach(() => {
  stopHeartbeat()
  for (const { worktree, store } of fixtureSessions.splice(0)) releaseFixtureSession(worktree, store)
  for (const wt of worktrees.splice(0)) wt.cleanup()
})

test("transactions reject nesting and asynchronous callbacks, and invalidate escaped handles", async () => {
  const wt = makeWorktree()
  let escaped!: FlowTx
  const result = withFlowTransaction(wt.worktree, tx => {
    escaped = tx
    expect(() => withFlowTransaction(wt.worktree, () => undefined)).toThrow("nested flow transaction")
    return "complete"
  })
  expect(result).toBe("complete")
  expect(() => appendEvents(escaped, [])).toThrow("no longer active")

  if (false) {
    // @ts-expect-error flow transaction callbacks must be synchronous
    withFlowTransaction(wt.worktree, async () => undefined)
  }
  const dynamic = withFlowTransaction as unknown as (worktree: string, fn: (tx: FlowTx) => unknown) => unknown
  let asyncTx!: FlowTx
  expect(() => dynamic(wt.worktree, async tx => {
    asyncTx = tx
    await Promise.resolve()
    appendEvents(tx, [])
  })).toThrow("must be synchronous")
  await Promise.resolve()
  expect(() => appendEvents(asyncTx, [])).toThrow("no longer active")
  expect(existsSync(eventsPath(wt.worktree))).toBe(false)
})

test("applyEventIn rejects a transaction belonging to another runtime worktree", () => {
  const txWorktree = makeWorktree()
  const runtimeWorktree = makeWorktree()
  const deps = makeDeps(fakeClient(), runtimeWorktree.worktree)
  const workflow = newWorkflow("ses_wrong_tx", currentOwner(), "command", "wrong transaction", "observed-engine")
  withFlowTransaction(txWorktree.worktree, tx => {
    expect(() => applyEventIn(tx, deps, workflow, "user_message", "user_message")).toThrow("different worktree")
  })
})

test("existing dead-owner locks are preserved without PID probes or signals", () => {
  const wt = makeWorktree()
  const lock = join(flowDir(wt.worktree), "workflow.lock")
  mkdirSync(flowDir(wt.worktree), { recursive: true })
  const identity = JSON.stringify({ pid: 2_147_483_647, instance: "unknown-dead-owner", token: "unknown" })
  symlinkSync(identity, lock)
  const kill = spyOn(process, "kill")
  const before = readlinkSync(lock)
  try {
    expect(() => withFlowTransaction(wt.worktree, () => undefined)).toThrow(FlowTransactionBusyError)
    expect(readlinkSync(lock)).toBe(before)
    expect(kill).not.toHaveBeenCalled()
    expect(existsSync(workflowPath(wt.worktree))).toBe(false)
  } finally {
    kill.mockRestore()
  }
})

test("transaction release leaves a tampered lock and reports an integrity failure", () => {
  const wt = makeWorktree()
  const lock = join(flowDir(wt.worktree), "workflow.lock")
  const replacement = JSON.stringify({ pid: 2_147_483_647, instance: "replacement", token: "not-owned" })
  expect(() => withFlowTransaction(wt.worktree, () => {
    unlinkSync(lock)
    symlinkSync(replacement, lock)
  })).toThrow(FlowTransactionIntegrityError)
  expect(readlinkSync(lock)).toBe(replacement)
})

test("a second process cannot enter the transaction or append events while it is held", () => {
  const wt = makeWorktree()
  const workflow = newWorkflow("ses_transaction", currentOwner(), "command", "lock test", "observed-engine")
  withFlowTransaction(wt.worktree, tx => {
    writeWorkflow(tx, workflow)
    appendEvents(tx, [{ wf: workflow.id, type: "before", actor: "code" }])
  })
  const stateBefore = readFileSync(workflowPath(wt.worktree))
  const eventsBefore = readFileSync(eventsPath(wt.worktree))
  const modulePath = fileURLToPath(new URL("../src/flow/state.ts", import.meta.url))
  const runtimePath = fileURLToPath(new URL("../src/flow/runtime.ts", import.meta.url))
  const configPath = fileURLToPath(new URL("../src/config.ts", import.meta.url))
  const source = `
const { withFlowTransaction, appendEvents } = await import(${JSON.stringify(modulePath)});
const { requestStopIn, repairOnLoad, startWorkflow } = await import(${JSON.stringify(runtimePath)});
const { DEFAULT_CONFIG } = await import(${JSON.stringify(configPath)});
const root = process.env.FLOW_ROOT;
const deps = { worktree: root, config: DEFAULT_CONFIG, log() {} };
const wf = (await import(${JSON.stringify(modulePath)})).readWorkflow(root);
const operations = [
  () => withFlowTransaction(root, tx => appendEvents(tx, [{ wf: "child", type: "forbidden", actor: "code" }])),
  () => withFlowTransaction(root, tx => requestStopIn(tx, deps, wf.sessionID, "cancel", "x")),
  () => startWorkflow(deps, wf.sessionID, "command", "child", "user_command", "observed-engine"),
  () => repairOnLoad(deps, "observed-engine"),
];
const results = operations.map(operation => {
  try { operation(); return "entered"; }
  catch (error) { return error instanceof Error ? error.name : "unknown"; }
});
console.log(JSON.stringify(results));`
  withFlowTransaction(wt.worktree, () => {
    const child = spawnSync(process.execPath, ["-e", source], {
      cwd: wt.worktree,
      encoding: "utf8",
      env: { ...process.env, FLOW_ROOT: wt.worktree },
    })
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual(Array(4).fill("FlowTransactionBusyError"))
    expect(readFileSync(workflowPath(wt.worktree)).equals(stateBefore)).toBe(true)
    expect(readFileSync(eventsPath(wt.worktree)).equals(eventsBefore)).toBe(true)
  })
  expect(readFileSync(workflowPath(wt.worktree)).equals(stateBefore)).toBe(true)
  expect(readFileSync(eventsPath(wt.worktree)).equals(eventsBefore)).toBe(true)
})

test("a matching-engine cancel remains a successful FlowResult after transaction release", () => {
  const wt = makeWorktree()
  const deps = makeDeps(fakeClient(), wt.worktree)
  const sessionID = "ses_cancel"
  const store = admit(deps, sessionID)
  const workflow = { ...newWorkflow(sessionID, currentOwner(Date.now(), store.epoch), "command", "cancel", "opencode"), phase: "executing" as const }
  expect(workflow.owner.instance).toBe(store.epoch)
  withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, workflow))
  // a registered stage activity keeps the cancel pending (the full predicate, not a caller-supplied boolean)
  const releaseActivity = beginExecutionActivity(getOpenCodeRuntime(deps), sessionID, "stage", { workflowID: workflow.id, abort: () => { aborts++ } })!
  let aborts = 0
  const requested = requestCancel(deps, workflow)
  const result = requested.result
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.wf.stopIntent?.kind).toBe("cancel")
  expect(aborts).toBe(1)
  releaseActivity()
  // Intended schema change (P5a): pendingCancel is a cancel stopIntent inside the committed snapshot.
  expect(committedSnapshot(wt.worktree).stopIntent).toMatchObject({ kind: "cancel" })
})

for (const engineCase of ["foreign", "missing"] as const) {
  test(`no-workflow-input operations refuse ${engineCase} engine under transaction without side effects`, () => {
    const wt = makeWorktree()
    const deps = makeDeps(fakeClient(), wt.worktree)
    const workflow = newWorkflow("ses_engine_refusal", currentOwner(), "command", "engine refusal", "expected-engine")
    if (engineCase === "missing") delete workflow.engine
    else workflow.engine = "foreign-engine"
    withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, workflow))
    const before = readFileSync(workflowPath(wt.worktree))
    let aborts = 0

    const authority = resolveAuthority(deps, "status", workflow.sessionID, "expected-engine")
    expect(authority.refuse).toContain("engine identity")
    const repair = repairOnLoad(deps, "expected-engine")
    expect(repair?.ok).toBe(false)
    if (repair && !repair.ok) expect(repair.text).toContain("engine identity")
    const deleted = requestCancel(deps, workflow).result
    expect(deleted.ok).toBe(false)
    if (!deleted.ok) expect(deleted.text).toContain("engine identity")
    expect(aborts).toBe(0)

    stopHeartbeat()
    const timer = spyOn(globalThis, "setInterval").mockImplementation(((_callback: () => void) => {
      return { unref() {} } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)
    const clear = spyOn(globalThis, "clearInterval").mockImplementation((() => {}) as typeof clearInterval)
    try {
      ensureHeartbeat(deps, "expected-engine")
      expect(timer).not.toHaveBeenCalled()
      expect(readFileSync(workflowPath(wt.worktree)).equals(before)).toBe(true)
      expect(existsSync(eventsPath(wt.worktree))).toBe(false)
      expect(existsSync(ledgerPath(wt.worktree, workflow.sessionID))).toBe(false)
    } finally {
      stopHeartbeat()
      clear.mockRestore()
      timer.mockRestore()
    }
    expect(readFileSync(workflowPath(wt.worktree)).equals(before)).toBe(true)
    expect(existsSync(eventsPath(wt.worktree))).toBe(false)
    expect(existsSync(ledgerPath(wt.worktree, workflow.sessionID))).toBe(false)
    expect(existsSync(join(flowDir(wt.worktree), "workflow.lock"))).toBe(false)
  })
}

test("status is lock-free, engine-free, and nonmutating while a transaction is held", () => {
  const wt = makeWorktree()
  const workflow = newWorkflow("ses_status", currentOwner(), "command", "status", "observed-engine")
  delete workflow.engine
  withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, workflow))
  const before = readFileSync(workflowPath(wt.worktree))
  const status = withFlowTransaction(wt.worktree, () => readForegroundStatus({
    worktree: wt.worktree, config: DEFAULT_CONFIG, log: () => {},
  }, workflow.sessionID))
  expect(status).toContain("planning")
  expect(readFileSync(workflowPath(wt.worktree)).equals(before)).toBe(true)
  expect(existsSync(join(flowDir(wt.worktree), "workflow.lock"))).toBe(false)
})

test("heartbeat skips a busy tick and stops for pending cancellation", () => {
  const wt = makeWorktree()
  const deps = makeDeps(fakeClient(), wt.worktree)
  const sessionID = "ses_heartbeat"
  const store = admit(deps, sessionID)
  const owner = currentOwner(Date.now() - 10_000, store.epoch)
  const workflow = { ...newWorkflow(sessionID, owner, "command", "heartbeat", "opencode"), phase: "executing" as const }
  expect(workflow.owner.instance).toBe(store.epoch)
  withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, workflow))
  let tick: (() => void) | undefined
  stopHeartbeat()
  const timer = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    tick = callback
    return { unref() {} } as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const clear = spyOn(globalThis, "clearInterval").mockImplementation((() => {}) as typeof clearInterval)
  try {
    ensureHeartbeat(deps, "opencode")
    const lock = join(flowDir(wt.worktree), "workflow.lock")
    symlinkSync(JSON.stringify({ pid: 99_999_999, instance: "busy", token: "busy" }), lock)
    const beforeBusyTick = readFileSync(workflowPath(wt.worktree))
    tick!()
    expect(readFileSync(workflowPath(wt.worktree)).equals(beforeBusyTick)).toBe(true)
    unlinkSync(lock)

    const releaseActivity = beginExecutionActivity(getOpenCodeRuntime(deps), workflow.sessionID, "stage", { workflowID: workflow.id })!
    const cancelled = requestCancel(deps, workflow).result
    releaseActivity()
    expect(cancelled.ok).toBe(true)
    if (!cancelled.ok) return
    const beforeRefresh = committedSnapshot(wt.worktree)
    const indexBeforeRefresh = readFileSync(workflowPath(wt.worktree))
    tick!()
    const refreshed = committedSnapshot(wt.worktree)
    expect(readFileSync(workflowPath(wt.worktree)).equals(indexBeforeRefresh)).toBe(true)
    expect(refreshed.stopIntent?.kind).toBe("cancel")
    expect(refreshed.phase).toBe("executing")
    expect(refreshed).toEqual(beforeRefresh)
    expect(clear).toHaveBeenCalledTimes(1)
  } finally {
    stopHeartbeat()
    clear.mockRestore()
    timer.mockRestore()
  }
})

test.each(["{not json", "null", "[]"])("corrupt workflow %s remains unchanged by reads and transactional writes", corrupt => {
  const wt = makeWorktree()
  mkdirSync(flowDir(wt.worktree), { recursive: true })
  writeFileSync(workflowPath(wt.worktree), corrupt)
  const before = readFileSync(workflowPath(wt.worktree))
  expect(() => withFlowTransaction(wt.worktree, tx => {
    expect(() => writeWorkflow(tx, newWorkflow("ses_corrupt", currentOwner(), "command", "x", "engine"))).toThrow("corrupt workflow state")
    expect(() => appendEvents(tx, [{ wf: "corrupt", type: "blocked", actor: "code" }])).toThrow("corrupt workflow state")
    expect(() => rotate(tx)).toThrow("corrupt workflow state")
    expect(() => renderArtifact(tx, ".lca/plans/blocked.md", "blocked")).toThrow("corrupt workflow state")
    expect(() => writePlanJson(tx, "corrupt", { goal: "blocked", steps: [], risks: [], revision: 1 })).toThrow("corrupt workflow state")
  })).not.toThrow()
  expect(() => readForegroundStatus({ worktree: wt.worktree, config: DEFAULT_CONFIG, log: () => {} }, "ses_corrupt")).toThrow()
  expect(readFileSync(workflowPath(wt.worktree)).equals(before)).toBe(true)
  expect(readdirSync(flowDir(wt.worktree))).toEqual(["workflow.json"])
  expect(existsSync(eventsPath(wt.worktree))).toBe(false)
  expect(existsSync(join(wt.worktree, ".lca/plans/blocked.md"))).toBe(false)
})
