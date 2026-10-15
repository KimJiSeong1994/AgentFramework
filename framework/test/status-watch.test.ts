import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { flowDir, newWorkflow as createWorkflow, workflowPath, withFlowTransaction, writeHeartbeat, type Workflow } from "../src/flow/state.ts"
import { writeWorkflow, publishWorkflow } from "./commit-fixture.ts"
import { addTasks, emptyLedger, ledgerPath, readLedger, updateTask, writeLedger } from "../src/state/ledger.ts"
import * as stateStore from "../src/state/store.ts"
import { stateRoot } from "../src/state/store.ts"
import { createStatusWatchState, watchTick } from "../src/hosts/status-watch.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { tempWorktree } from "./guards-helpers.ts"

const SESSION = "ses_watch"
const ENGINE = "opencode"
let wt: ReturnType<typeof tempWorktree>
afterEach(() => wt?.cleanup())
function setup() {
  wt = tempWorktree()
  return { worktree: wt.worktree, config: DEFAULT_CONFIG, log: () => {} }
}

function newStatusWorkflow(sessionID: string, owner: Workflow["owner"], entry: Workflow["entry"], request: string, now?: number) {
  return createWorkflow(sessionID, owner, entry, request, ENGINE, now)
}

function writeStatusWorkflow(worktree: string, workflow: Workflow, now?: number) {
  return withFlowTransaction(worktree, tx => writeWorkflow(tx, workflow, now))
}

describe("status watch tick", () => {
  test("emits an initial snapshot and performs no state reads on unchanged ticks", () => {
    const runtime = setup()
    const state = createStatusWatchState({ sessionID: SESSION })
    writeLedger(wt.worktree, emptyLedger(SESSION, 999))
    const initial = watchTick(state, runtime, 1000)
    expect(initial.frame).toMatchObject({ type: "snapshot", seq: 1, reason: "initial", status: { schemaVersion: 1 } })
    expect(initial.bytesRead).toBe(readFileSync(ledgerPath(wt.worktree, SESSION)).byteLength)
    const unchanged = watchTick(state, runtime, 1001)
    expect(unchanged.frame).toBeUndefined()
    expect(unchanged.bytesRead).toBe(0)
    expect(unchanged.statCalls).toBeGreaterThan(0)
  })

  test("emits changed only when the status projection changes", () => {
    const runtime = setup()
    const state = createStatusWatchState({ sessionID: SESSION })
    watchTick(state, runtime, 1000)
    writeLedger(wt.worktree, addTasks(emptyLedger(SESSION), [{ title: "pending task" }]).ledger)
    const changed = watchTick(state, runtime, 1002)
    expect(changed.frame).toMatchObject({ type: "snapshot", reason: "changed", status: { session: { ledger: { pending: 1 } } } })
  })

  test("re-evaluates owner heartbeat liveness without reading disk", () => {
    const runtime = setup()
    const state = createStatusWatchState({ sessionID: SESSION })
    writeLedger(wt.worktree, emptyLedger(SESSION, 1000))
    const wf = newStatusWorkflow(SESSION, { instance: "other-instance", pid: process.pid}, "command", "request", 1000)
    writeStatusWorkflow(wt.worktree, wf, 1000)
    const initial = watchTick(state, runtime, 1000)
    expect(initial.frame?.status?.workflow?.ownerLive).toBe(true)
    const ageOnly = watchTick(state, runtime, 5000)
    expect(ageOnly.frame).toBeUndefined()
    expect(ageOnly.bytesRead).toBe(0)
    const firstSnapshot = initial.frame!
    const liveness = watchTick(state, runtime, 91_001)
    expect(liveness.frame).toMatchObject({ type: "snapshot", reason: "liveness", status: { workflow: { ownerLive: false } } })
    expect(firstSnapshot.status?.workflow?.ownerLive).toBe(true)
    expect(liveness.bytesRead).toBe(0)
  })

  test("does not emit a cached liveness snapshot while a read error is pending", () => {
    const runtime = setup()
    const state = createStatusWatchState({ sessionID: SESSION })
    const owner = { instance: "workflow-owner", pid: process.pid, heartbeatAt: 1000 }
    const workflow = newStatusWorkflow(SESSION, owner, "command", "request", 1000)
    writeLedger(wt.worktree, emptyLedger(SESSION, 1000))
    writeStatusWorkflow(wt.worktree, workflow, 1000)
    const liveness = { instance: "watcher", ownerPidAlive: () => true, epochReleased: () => false }

    expect(watchTick(state, runtime, 1000, liveness).frame).toMatchObject({ type: "snapshot", reason: "initial", status: { workflow: { ownerLive: true } } })
    writeFileSync(workflowPath(wt.worktree), "{ invalid json")
    expect(watchTick(state, runtime, 2000, liveness).frame).toMatchObject({ type: "error", error: { source: "workflow", code: "invalid_state" } })

    const crossedThreshold = watchTick(state, runtime, 91_001, liveness)
    expect(crossedThreshold.frame).toBeUndefined()
    expect(crossedThreshold.bytesRead).toBe(0)
    expect(state.status?.workflow?.ownerLive).toBe(true)

    publishWorkflow(wt.worktree, workflow, 91_002)
    // The sidecar still holds the original beat: staleness is evaluated from it, not from the republished snapshot.
    withFlowTransaction(wt.worktree, tx => writeHeartbeat(tx, workflow, 1000))
    expect(watchTick(state, runtime, 91_003, liveness).frame).toMatchObject({
      type: "snapshot", reason: "changed", status: { workflow: { sessionID: SESSION, ownerLive: false } },
    })
  })

  test("forced recovery after an error is reported as changed", () => {
    const runtime = setup()
    const state = createStatusWatchState({ sessionID: SESSION })
    const workflow = newStatusWorkflow(SESSION, currentOwner(), "command", "request", 1000)
    writeLedger(wt.worktree, emptyLedger(SESSION, 1000))
    writeStatusWorkflow(wt.worktree, workflow, 1000)
    expect(watchTick(state, runtime, 1000).frame?.reason).toBe("initial")

    writeFileSync(workflowPath(wt.worktree), "{ invalid json")
    expect(watchTick(state, runtime, 1001).frame).toMatchObject({ type: "error", error: { source: "workflow", code: "invalid_state" } })
    for (let tick = 3; tick < 10; tick++) expect(watchTick(state, runtime, 1000 + tick).frame).toBeUndefined()

    publishWorkflow(wt.worktree, workflow, 1010)
    expect(watchTick(state, runtime, 1010).frame).toMatchObject({ type: "snapshot", reason: "changed" })
  })

  test("unexpected liveness callback exceptions propagate instead of becoming filesystem errors", () => {
    const runtime = setup()
    const state = createStatusWatchState({ sessionID: SESSION })
    writeLedger(wt.worktree, emptyLedger(SESSION))
    writeStatusWorkflow(wt.worktree, newStatusWorkflow(SESSION, { instance: "owner", pid: process.pid}, "command", "request"))
    const failure = new Error("liveness callback bug")

    expect(() => watchTick(state, runtime, 1000, {
      instance: "watcher", epochReleased: () => false, ownerPidAlive: () => { throw failure },
    })).toThrow(failure)
    expect(state.errors.size).toBe(0)
  })

  test("suppresses heartbeat-only workflow rewrites from watch frames", () => {
    const runtime = setup()
    writeLedger(wt.worktree, emptyLedger(SESSION, 1000))
    const wf = newStatusWorkflow(SESSION, { ...currentOwner()}, "command", "request", 1000)
    writeStatusWorkflow(wt.worktree, wf, 1000)
    const state = createStatusWatchState({ sessionID: SESSION })
    expect(watchTick(state, runtime, 1000).frame?.reason).toBe("initial")
    writeStatusWorkflow(wt.worktree, { ...wf, owner: { ...wf.owner} }, 1001)
    const heartbeat = watchTick(state, runtime, 1001)
    expect(heartbeat.frame).toBeUndefined()
    expect(heartbeat.bytesRead).toBeGreaterThan(0)
    for (let tick = 2; tick <= 10; tick++) {
      const result = watchTick(state, runtime, 1000 + tick)
      expect(result.frame).toBeUndefined()
      if (tick === 9) expect(result.bytesRead).toBeGreaterThan(0)
    }
  })

  test("a heartbeat.json-only tick (sidecar touch, index and snapshot untouched) emits no frame", () => {
    const runtime = setup()
    writeLedger(wt.worktree, emptyLedger(SESSION, 1000))
    const wf = writeStatusWorkflow(wt.worktree, newStatusWorkflow(SESSION, { ...currentOwner() }, "command", "request", 1000), 1000)
    const state = createStatusWatchState({ sessionID: SESSION })
    expect(watchTick(state, runtime, 1000).frame?.reason).toBe("initial")
    const indexBefore = readFileSync(workflowPath(wt.worktree))
    withFlowTransaction(wt.worktree, tx => writeHeartbeat(tx, wf, 1001))
    expect(readFileSync(workflowPath(wt.worktree)).equals(indexBefore)).toBe(true)
    const tick = watchTick(state, runtime, 1001)
    expect(tick.frame).toBeUndefined()
    expect(tick.bytesRead).toBeGreaterThan(0)
  })

  test("accepts an injectable claim liveness predicate for unchanged-file ticks", () => {
    const runtime = setup()
    createExecutionRunStore(wt.worktree).claim(SESSION, "test", process.pid)
    const state = createStatusWatchState({ sessionID: SESSION })
    const initial = watchTick(state, runtime, 1000, { claimPidAlive: () => true })
    expect(initial.frame?.status?.session.queue.state).toBe("unknown")
    const liveness = watchTick(state, runtime, 1001, { claimPidAlive: () => false })
    expect(liveness.frame).toMatchObject({ type: "snapshot", reason: "liveness", status: { session: { queue: { state: "idle", evidence: "claim_pid_dead" } } } })
    expect(liveness.bytesRead).toBe(0)
  })

  test("emits an error once per source/code and recovery as changed", () => {
    const runtime = setup()
    const state = createStatusWatchState({ sessionID: SESSION })
    mkdirSync(join(stateRoot(wt.worktree), "workflow"), { recursive: true })
    writeFileSync(workflowPath(wt.worktree), "{ invalid json")
    const first = watchTick(state, runtime, 1000)
    expect(first.frame).toMatchObject({ type: "error", reason: "initial", error: { source: "workflow", code: "invalid_state" } })
    expect(first.bytesRead).toBeGreaterThan(0)
    expect(first.frame?.meta.bytesRead).toBe(first.bytesRead)
    const unchanged = watchTick(state, runtime, 1001)
    expect(unchanged.frame).toBeUndefined()
    expect(unchanged.bytesRead).toBe(0)
    for (let tick = 2; tick < 9; tick++) expect(watchTick(state, runtime, 1000 + tick).bytesRead).toBe(0)
    const forced = watchTick(state, runtime, 1010)
    expect(forced.frame).toBeUndefined()
    expect(forced.bytesRead).toBeGreaterThan(0)
    publishWorkflow(wt.worktree, newStatusWorkflow(SESSION, currentOwner(), "command", "request", 1002), 1002)
    const recovered = watchTick(state, runtime, 1003)
    expect(recovered.frame).toMatchObject({ type: "snapshot", reason: "changed", status: { workflow: { sessionID: SESSION } } })
    expect(state.errors.size).toBe(0)
  })

  test("turns directory-enumeration failures into bounded workflow errors and recovers", () => {
    const runtime = setup()
    const state = createStatusWatchState({ sessionID: SESSION, detail: true })
    const archiveDir = join(flowDir(wt.worktree), "archive")
    mkdirSync(flowDir(wt.worktree), { recursive: true })
    writeFileSync(archiveDir, "not a directory")

    const failed = watchTick(state, runtime, 1000)
    expect(failed.frame).toMatchObject({ type: "error", error: { source: "workflow", code: "unreadable" } })
    expect(state.errors).toContain("workflow:unreadable")

    rmSync(archiveDir)
    const recovered = watchTick(state, runtime, 1001)
    expect(recovered.frame).toMatchObject({ type: "snapshot", reason: "changed" })
    expect(state.errors.size).toBe(0)
  })

  test("rethrows unexpected directory-helper errors", () => {
    const runtime = setup()
    const state = createStatusWatchState({ sessionID: SESSION, detail: true })
    const failure = new TypeError("directory helper bug")
    const helper = spyOn(stateStore, "readDirectoryBounded").mockImplementation(() => { throw failure })
    try {
      expect(() => watchTick(state, runtime, 1000)).toThrow(failure)
      expect(state.errors.size).toBe(0)
    } finally {
      helper.mockRestore()
    }
  })

  test("rethrows unexpected stat errors", () => {
    const runtime = setup()
    const state = createStatusWatchState({ sessionID: SESSION })
    const path = workflowPath(wt.worktree)
    const failure = new Error("stat wrapper bug")
    const original = fs.statSync
    const stat = spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike) => {
      if (String(target) === path) throw failure
      return original(target)
    }) as typeof fs.statSync)
    try {
      expect(() => watchTick(state, runtime, 1000)).toThrow(failure)
      expect(state.errors.size).toBe(0)
    } finally {
      stat.mockRestore()
    }
  })

  test("turns watched-path stat failures into source-tagged errors and recovers", () => {
    const runtime = setup()
    const state = createStatusWatchState({ sessionID: SESSION })
    const workflowDir = flowDir(wt.worktree)
    mkdirSync(stateRoot(wt.worktree), { recursive: true })
    writeFileSync(workflowDir, "not a directory")

    const failed = watchTick(state, runtime, 1000)
    expect(failed.frame).toMatchObject({ type: "error", error: { source: "workflow", code: "unreadable" } })
    expect(failed.statCalls).toBeGreaterThan(0)
    expect(failed.statCalls).toBeLessThanOrEqual(6)
    rmSync(workflowDir)

    expect(watchTick(state, runtime, 1001).frame).toMatchObject({ type: "snapshot", reason: "changed" })
    expect(state.errors.size).toBe(0)
  })

  test("CLI watch emits NDJSON snapshots only and exits promptly on SIGINT", async () => {
    const runtime = setup()
    writeLedger(wt.worktree, emptyLedger(SESSION, 1000))
    const child = Bun.spawn(["bun", "src/hosts/cli.ts", "status", "--worktree", wt.worktree, "--session", SESSION, "--json", "--watch", "--interval", "1"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const nextLine = async (): Promise<string> => {
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          return line
        }
        let timeout: ReturnType<typeof setTimeout>
        const read = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("watch frame timed out")), 5000) }),
        ]).finally(() => clearTimeout(timeout!))
        if (read.done) throw new Error("watch exited before emitting a frame")
        buffer += decoder.decode(read.value, { stream: true })
      }
    }
    try {
      const initial = JSON.parse(await nextLine())
      expect(initial).toMatchObject({ type: "snapshot", reason: "initial", status: { session: { id: SESSION } } })
      child.kill("SIGINT")
      await child.exited
      expect(child.exitCode).toBe(0)
      void runtime
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      reader.releaseLock()
    }
  })

  test("CLI watch reports ledger changes and claim liveness, then exits on SIGTERM", async () => {
    const runtime = setup()
    const created = addTasks(emptyLedger(SESSION), [{ title: "watch liveness" }])
    const task = created.added[0]!
    writeLedger(wt.worktree, { ...updateTask(created.ledger, task.id, { status: "running", attempts: 1 }), running: { taskId: task.id, since: 1000 } })
    const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" })
    createExecutionRunStore(wt.worktree).claim(SESSION, "watch-owner", owner.pid)
    const child = Bun.spawn(["bun", "src/hosts/cli.ts", "status", "--worktree", wt.worktree, "--session", SESSION, "--json", "--watch", "--interval", "1"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const nextFrame = async (): Promise<any> => {
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          return JSON.parse(line)
        }
        let timeout: ReturnType<typeof setTimeout>
        const read = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("watch frame timed out")), 5000) }),
        ]).finally(() => clearTimeout(timeout!))
        if (read.done) throw new Error("watch exited before emitting a frame")
        buffer += decoder.decode(read.value, { stream: true })
      }
    }
    try {
      const initial = await nextFrame()
      expect(initial).toMatchObject({ type: "snapshot", reason: "initial", status: { session: { queue: { state: "running_elsewhere" }, queueRunning: true } } })

      writeLedger(wt.worktree, { ...updateTask(readLedger(wt.worktree, SESSION), task.id, { status: "pending", title: "watch liveness changed" }), running: { taskId: task.id, since: 1000 } })
      const changed = await nextFrame()
      expect(changed).toMatchObject({ type: "snapshot", reason: "changed", status: { session: { queue: { state: "stale" } } } })

      owner.kill("SIGTERM")
      await owner.exited
      const liveness = await nextFrame()
      expect(liveness).toMatchObject({ type: "snapshot", reason: "liveness", meta: { bytesRead: 0 }, status: { session: { queue: { evidence: "claim_pid_dead" } } } })

      child.kill("SIGTERM")
      let stopTimeout: ReturnType<typeof setTimeout>
      await Promise.race([child.exited, new Promise<never>((_, reject) => { stopTimeout = setTimeout(() => reject(new Error("watch did not stop on SIGTERM")), 1000) })])
        .finally(() => clearTimeout(stopTimeout!))
      expect(child.exitCode).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      if (owner.exitCode === null) owner.kill("SIGKILL")
      reader.releaseLock()
      void runtime
    }
  })

  test("CLI watch emits one error and a changed recovery snapshot without restarting", async () => {
    const runtime = setup()
    writeLedger(wt.worktree, emptyLedger(SESSION, 1000))
    const child = Bun.spawn(["bun", "src/hosts/cli.ts", "status", "--worktree", wt.worktree, "--session", SESSION, "--json", "--watch", "--interval", "1"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const nextFrame = async (): Promise<any> => {
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          return JSON.parse(line)
        }
        let timeout: ReturnType<typeof setTimeout>
        const read = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("watch frame timed out")), 5000) }),
        ]).finally(() => clearTimeout(timeout!))
        if (read.done) throw new Error("watch exited before emitting a frame")
        buffer += decoder.decode(read.value, { stream: true })
      }
    }
    try {
      expect(await nextFrame()).toMatchObject({ type: "snapshot", reason: "initial" })
      mkdirSync(join(stateRoot(wt.worktree), "workflow"), { recursive: true })
      writeFileSync(workflowPath(wt.worktree), "{ invalid json")
      expect(await nextFrame()).toMatchObject({ type: "error", error: { source: "workflow", code: "invalid_state" }, meta: { bytesRead: expect.any(Number) } })
      publishWorkflow(wt.worktree, newStatusWorkflow(SESSION, currentOwner(), "command", "repaired"))
      expect(await nextFrame()).toMatchObject({ type: "snapshot", reason: "changed", status: { workflow: { sessionID: SESSION } } })

      child.kill("SIGTERM")
      let stopTimeout: ReturnType<typeof setTimeout>
      await Promise.race([child.exited, new Promise<never>((_, reject) => { stopTimeout = setTimeout(() => reject(new Error("watch did not stop on SIGTERM")), 1000) })])
        .finally(() => clearTimeout(stopTimeout!))
      expect(child.exitCode).toBe(0)
      void runtime
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      reader.releaseLock()
    }
  })
})
