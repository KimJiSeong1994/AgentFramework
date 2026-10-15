import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createEventHook } from "../src/hooks/event.ts"
import { createToolAfterHook } from "../src/hooks/tool-after.ts"
import { createToolBeforeHook } from "../src/hooks/tool-before.ts"
import { clearToolObservations, readToolObservations, recordToolObservation } from "../src/hosts/tool-observation.ts"
import { EMPTY_MODE, readModeState, writeModeState } from "../src/state/store.ts"
import { listToolOutcomes, recordToolOutcome, toolOutcomePath } from "../src/telemetry/outcomes.ts"
import { admitFixtureSession, fakeClient, makeDeps, releaseFixtureSession, tempWorktree } from "./guards-helpers.ts"
import { createNativeToolFixture } from "./native-tool-fixture.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"

let wt: ReturnType<typeof tempWorktree>
let observationSessions: Set<string>
let fixtureStores: ReturnType<typeof admitFixtureSession>[]

beforeEach(() => { wt = tempWorktree(); observationSessions = new Set(); fixtureStores = [] })
afterEach(() => {
  for (const store of fixtureStores) releaseFixtureSession(wt.worktree, store)
  for (const sessionID of observationSessions) clearToolObservations(wt.worktree, sessionID)
  wt.cleanup()
})

function admitSession(deps: ReturnType<typeof makeDeps>, sessionID: string) {
  observationSessions.add(sessionID)
  const store = admitFixtureSession(deps, sessionID)
  fixtureStores.push(store)
  return store
}

function completed(patch: Record<string, unknown> = {}) {
  return {
    id: "part_1",
    sessionID: "session_1",
    messageID: "message_1",
    type: "tool",
    callID: "call_1",
    tool: "bash",
    state: {
      status: "completed",
      input: { password: "input-secret" },
      output: "output-secret",
      title: "Run command",
      metadata: { exit: 0, token: "metadata-secret" },
      time: { start: 10, end: 25 },
    },
    args: { credential: "args-secret" },
    ...patch,
  }
}

function partEvent(part: unknown) {
  if (part && typeof part === "object" && "sessionID" in part && typeof part.sessionID === "string") {
    observationSessions.add(part.sessionID)
  }
  return { type: "message.part.updated", properties: { part } } as any
}

async function createNativeEventFixture(deps: ReturnType<typeof makeDeps>, sessionID: string) {
  observationSessions.add(sessionID)
  const native = await createNativeToolFixture(deps, { role: "main", sessionID })
  const event = createEventHook(deps)
  const userMessage = await native.acceptUserTurn()
  await event({ event: { type: "message.updated", properties: { info: userMessage } } } as any)
  return {
    event,
    async primeCall(options: Parameters<typeof native.primeCall>[0]) {
      const call = native.primeCall(options)
      await event({ event: { type: "message.updated", properties: { info: call.assistantMessage } } } as any)
      return call
    },
  }
}

describe("tool outcome recording", () => {
  test("classifies completed success, host error, and nonzero exit", () => {
    const success = completed()
    const hostError = completed({
      id: "part_error",
      callID: "call_error",
      state: {
        status: "error",
        input: { secret: "input-secret" },
        error: "host error with error-secret",
        metadata: { token: "metadata-secret" },
        time: { start: 4, end: 9 },
      },
    })
    const nonzero = completed({
      id: "part_nonzero",
      callID: "call_nonzero",
      state: { ...((completed().state as any)), metadata: { exitCode: 7 } },
    })

    expect(recordToolOutcome(wt.worktree, success)).toBe(true)
    expect(recordToolOutcome(wt.worktree, hostError)).toBe(true)
    expect(recordToolOutcome(wt.worktree, nonzero)).toBe(true)
    expect(listToolOutcomes(wt.worktree).rows).toHaveLength(3)

    const byCall = new Map(listToolOutcomes(wt.worktree).rows.map((row) => [row.callID, row]))
    expect(byCall.get("call_1")).toMatchObject({ status: "success", basis: "exit_code", startedAt: 10, finishedAt: 25, durationMs: 15 })
    expect(byCall.get("call_error")).toMatchObject({ status: "failure", basis: "tool_error", startedAt: 4, finishedAt: 9, durationMs: 5 })
    expect(byCall.get("call_nonzero")).toMatchObject({ status: "failure", basis: "exit_code" })
  })

  test("records completed transport success without inferring from arbitrary output", () => {
    const part = completed({
      id: "part_transport",
      callID: "call_transport",
      state: {
        status: "completed",
        input: {},
        output: "failed: arbitrary output text is not a host error",
        title: "Completed",
        metadata: {},
        time: {},
      },
    })
    expect(recordToolOutcome(wt.worktree, part)).toBe(true)
    expect(listToolOutcomes(wt.worktree).rows[0]).toMatchObject({
      status: "success",
      basis: "completed",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    })
  })

  test("malformed explicit exit fields remain unknown rather than completed success", () => {
    const malformed = [{ exit: "1" }, { exitCode: null }, { exit: Number.NaN }, { exit: 0, exitCode: "0" }]
    for (const [i, metadata] of malformed.entries()) {
      expect(recordToolOutcome(wt.worktree, completed({
        id: `part_invalid_${i}`, callID: `call_invalid_${i}`,
        state: { status: "completed", metadata, time: {} },
      }))).toBe(true)
    }
    const rows = listToolOutcomes(wt.worktree).rows
    expect(rows).toHaveLength(malformed.length)
    for (const row of rows) expect(row).toMatchObject({ status: "unknown", basis: "invalid_exit" })
  })

  test("rejects malformed terminal schemas and normalizes invalid or inconsistent times", () => {
    expect(recordToolOutcome(wt.worktree, null)).toBe(false)
    expect(recordToolOutcome(wt.worktree, { ...completed(), id: 5 })).toBe(false)
    expect(recordToolOutcome(wt.worktree, { ...completed(), sessionID: " " })).toBe(false)
    expect(recordToolOutcome(wt.worktree, { ...completed(), callID: "x".repeat(513) })).toBe(false)
    expect(recordToolOutcome(wt.worktree, { ...completed(), tool: { name: "bash" } })).toBe(false)
    expect(recordToolOutcome(wt.worktree, { ...completed(), tool: "t".repeat(129) })).toBe(false)
    expect(recordToolOutcome(wt.worktree, { ...completed(), state: { status: "running" } })).toBe(false)
    expect(listToolOutcomes(wt.worktree).totalCount).toBe(0)

    const malformed = completed({
      id: "part_bad_time",
      callID: "call_bad_time",
      state: { status: "completed", metadata: { exit: 0 }, time: { start: -1, end: Number.POSITIVE_INFINITY } },
    })
    const inconsistent = completed({
      id: "part_inconsistent",
      callID: "call_inconsistent",
      state: { status: "completed", metadata: {}, time: { start: 20, end: 15 } },
    })
    expect(recordToolOutcome(wt.worktree, malformed)).toBe(true)
    expect(recordToolOutcome(wt.worktree, inconsistent)).toBe(true)
    const rows = listToolOutcomes(wt.worktree).rows
    expect(rows.find((row) => row.callID === "call_bad_time")).toMatchObject({ startedAt: null, finishedAt: null, durationMs: null })
    expect(rows.find((row) => row.callID === "call_inconsistent")).toMatchObject({ startedAt: 20, finishedAt: 15, durationMs: null })
  })

  test("deduplicates exact replay across calls and appends changed observations and sessions", () => {
    const original = completed()
    expect(recordToolOutcome(wt.worktree, original)).toBe(true)
    expect(recordToolOutcome(wt.worktree, original)).toBe(false)
    expect(recordToolOutcome(wt.worktree, completed({ state: { ...((original as any).state), metadata: { exit: 3 } } }))).toBe(true)
    expect(recordToolOutcome(wt.worktree, completed({
      id: "part_session_2",
      sessionID: "session_2",
    }))).toBe(true)

    const rows = listToolOutcomes(wt.worktree).rows
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((row) => row.id)).size).toBe(3)
    expect(new Set(rows.map((row) => row.sessionID))).toEqual(new Set(["session_1", "session_2"]))
    expect(rows.filter((row) => row.sessionID === "session_1" && row.callID === "call_1")).toHaveLength(2)
  })

  test("the same observation re-delivered under a different part id is one row", () => {
    expect(recordToolOutcome(wt.worktree, completed({ id: "part-A" }))).toBe(true)
    expect(recordToolOutcome(wt.worktree, completed({ id: "part-B" }))).toBe(false)
    expect(recordToolOutcome(wt.worktree, completed({ id: "part-C" }))).toBe(false)
    expect(listToolOutcomes(wt.worktree).totalCount).toBe(1)
  })

  test("marks disagreeing exit metadata as unknown", () => {
    const part = completed({
      id: "part_conflicting_exit",
      callID: "call_conflicting_exit",
      state: { status: "completed", metadata: { exit: 0, exitCode: 1 }, time: { start: 1, end: 2 } },
    })
    expect(recordToolOutcome(wt.worktree, part)).toBe(true)
    expect(listToolOutcomes(wt.worktree).rows[0]).toMatchObject({ status: "unknown", basis: "conflicting_exit" })
  })

  test("persists only the safe outcome whitelist", () => {
    const part = completed({
      state: {
        status: "error",
        input: { secret: "input-secret" },
        error: "error-secret",
        metadata: { token: "metadata-secret" },
        time: { start: 1, end: 2 },
      },
    })
    expect(recordToolOutcome(wt.worktree, part)).toBe(true)
    const rows = listToolOutcomes(wt.worktree).rows
    expect(Object.keys(rows[0]).sort()).toEqual([
      "basis", "callID", "durationMs", "finishedAt", "id", "recordedAt", "schemaVersion", "sessionID", "startedAt", "status", "tool",
    ])
    const database = readFileSync(toolOutcomePath(wt.worktree))
    for (const secret of ["input-secret", "output-secret", "metadata-secret", "args-secret", "error-secret"]) {
      expect(database.includes(Buffer.from(secret))).toBe(false)
    }
  })

  test("uses a missing database as empty and lists through a read-only database file", () => {
    const path = toolOutcomePath(wt.worktree)
    expect(listToolOutcomes(wt.worktree)).toEqual({ rows: [], totalCount: 0 })
    expect(existsSync(path)).toBe(false)

    expect(recordToolOutcome(wt.worktree, completed())).toBe(true)
    chmodSync(path, 0o400)
    const before = statSync(path)
    expect(listToolOutcomes(wt.worktree).totalCount).toBe(1)
    const after = statSync(path)
    expect(after.mode & 0o777).toBe(0o400)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  test("throws on corrupt databases instead of treating them as empty", () => {
    const path = toolOutcomePath(wt.worktree)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "not a sqlite database")
    expect(() => listToolOutcomes(wt.worktree)).toThrow()
  })

  test("bounds newest-first listing and reports the unbounded total", () => {
    for (let i = 0; i < 4; i++) {
      expect(recordToolOutcome(wt.worktree, completed({ id: `part_${i}`, callID: `call_${i}` }))).toBe(true)
    }
    const all = listToolOutcomes(wt.worktree)
    const bounded = listToolOutcomes(wt.worktree, 2)
    expect(all.totalCount).toBe(4)
    expect(bounded.totalCount).toBe(4)
    expect(bounded.rows).toHaveLength(2)
    expect(bounded.rows).toEqual(all.rows.slice(0, 2))
    expect(listToolOutcomes(wt.worktree, 0).rows).toEqual([])
  })
})

describe("tool outcome event hook", () => {
  test("honors tool.history and records enabled terminal events", async () => {
    const disabledSessionID = "history_disabled_session"
    const disabled = makeDeps(fakeClient(), wt.worktree, { disabled_hooks: ["tool.history"] as any })
    admitSession(disabled, disabledSessionID)
    const disabledFixture = await createNativeEventFixture(disabled, disabledSessionID)
    const disabledCall = await disabledFixture.primeCall({ tool: "bash", args: { command: "true" }, callID: "history_disabled_call" })
    await createToolBeforeHook(disabled)(disabledCall.input as any, disabledCall.output as any)
    await disabledFixture.event({ event: partEvent({
      ...disabledCall.part,
      state: { status: "completed", input: disabledCall.output.args, output: "completed", metadata: { exit: 0 }, time: { start: 1, end: 2 } },
    }) } as any)
    expect(listToolOutcomes(wt.worktree).totalCount).toBe(0)

    const enabledSessionID = "history_enabled_session"
    const deps = makeDeps(fakeClient(), wt.worktree)
    admitSession(deps, enabledSessionID)
    const enabledFixture = await createNativeEventFixture(deps, enabledSessionID)
    const enabledCall = await enabledFixture.primeCall({ tool: "bash", args: { command: "true" }, callID: "history_enabled_call" })
    await createToolBeforeHook(deps)(enabledCall.input as any, enabledCall.output as any)
    await enabledFixture.event({ event: partEvent({
      ...enabledCall.part,
      state: { status: "completed", input: enabledCall.output.args, output: "completed", metadata: { exit: 0 }, time: { start: 1, end: 2 } },
    }) } as any)
    expect(listToolOutcomes(wt.worktree).totalCount).toBe(1)
  })

  test("continues error bookkeeping after recorder failure", async () => {
    const deps = makeDeps(fakeClient(), wt.worktree)
    const sessionID = "session_error"
    admitSession(deps, sessionID)
    const native = await createNativeEventFixture(deps, sessionID)
    const call = await native.primeCall({ tool: "write", args: { filePath: "missing.ts" }, callID: "call_error_hook" })
    await createToolBeforeHook(deps)(call.input as any, call.output as any)
    writeModeState(wt.worktree, sessionID, { ...EMPTY_MODE, active: true })
    const outcomePath = toolOutcomePath(wt.worktree)
    mkdirSync(dirname(outcomePath), { recursive: true })
    mkdirSync(outcomePath)
    await native.event({ event: partEvent({
      ...call.part,
      state: { status: "error", error: "private error detail", input: call.output.args, time: {} },
    }) } as any)

    expect(readModeState(wt.worktree, sessionID).failures).toBe(1)
    expect(deps.logs).toContain("tool outcome recording failed")
    expect(deps.logs.join(" ")).not.toContain("private error detail")
  })
})

describe("in-memory tool observations", () => {
  test("keeps only typed facts and separates same call IDs across sessions", () => {
    const first = "observation_session_1"
    const second = "observation_session_2"
    observationSessions.add(first)
    observationSessions.add(second)
    recordToolObservation(wt.worktree, {
      name: "bash", callID: "call_same", sessionID: first, status: "running",
      args: "private-input", time: { start: 1 },
    } as any)
    recordToolObservation(wt.worktree, { name: "bash", callID: "call_same", sessionID: second, status: "running" })
    recordToolObservation(wt.worktree, { name: "bash", callID: "call_other", sessionID: first, status: "running" })

    const firstRows = readToolObservations(wt.worktree, first)
    expect(firstRows).toHaveLength(2)
    expect(firstRows.map(({ name, callID, sessionID, status }) => ({ name, callID, sessionID, status }))).toEqual([
      { name: "bash", callID: "call_same", sessionID: first, status: "running" },
      { name: "bash", callID: "call_other", sessionID: first, status: "running" },
    ])
    expect(Object.keys(firstRows[0]!).sort()).toEqual(["callID", "name", "sessionID", "status"])
    expect(JSON.stringify(firstRows)).not.toContain("private-input")
    expect(JSON.stringify(firstRows)).not.toContain("time")
    expect(readToolObservations(wt.worktree, second)).toHaveLength(1)
    clearToolObservations(wt.worktree, first)
    expect(readToolObservations(wt.worktree, first)).toEqual([])
    expect(readToolObservations(wt.worktree, second)).toHaveLength(1)
  })

  test("deduplicates terminal callbacks per session and retains conflicts without replacing success", () => {
    const sessionID = "observation_conflict_session"
    observationSessions.add(sessionID)
    const event = { name: "write", callID: "call_conflict", sessionID }
    expect(recordToolObservation(wt.worktree, { ...event, status: "running" }).disposition).toBe("recorded")
    expect(recordToolObservation(wt.worktree, { ...event, status: "succeeded" })).toMatchObject({
      disposition: "recorded", terminalStatus: "succeeded",
    })
    expect(recordToolObservation(wt.worktree, { ...event, status: "succeeded" }).disposition).toBe("duplicate")
    expect(recordToolObservation(wt.worktree, { ...event, status: "failed" })).toMatchObject({
      disposition: "conflict", terminalStatus: "succeeded",
    })
    expect(recordToolObservation(wt.worktree, { ...event, status: "failed" }).disposition).toBe("duplicate")
    expect(readToolObservations(wt.worktree, sessionID)).toEqual([
      { ...event, status: "running" },
      { ...event, status: "succeeded" },
      { ...event, status: "failed", diagnostic: "conflicting-terminal" },
    ])
  })

  test("before and after hooks preserve repeated same-name calls with distinct IDs", async () => {
    const sessionID = "observation_repeat_session"
    const deps = makeDeps(fakeClient(), wt.worktree)
    admitSession(deps, sessionID)
    const native = await createNativeToolFixture(deps, { role: "main", sessionID })
    await native.acceptUserTurn()
    const before = createToolBeforeHook(deps)
    const after = createToolAfterHook(deps)

    for (const [callID, command] of [["call_a", "printf a"], ["call_b", "printf b"]] as const) {
      const call = native.primeCall({ tool: "bash", args: { command }, callID })
      await before(call.input as any, call.output as any)
      const output = { output: "completed", metadata: {} }
      await after(call.input as any, output as any)
      await expect(after(call.input as any, output as any)).rejects.toThrow("lca: OpenCode tool call refused (completed-call)")
    }

    expect(readToolObservations(wt.worktree, sessionID).map(({ name, callID, status }) => ({ name, callID, status }))).toEqual([
      { name: "bash", callID: "call_a", status: "running" },
      { name: "bash", callID: "call_a", status: "succeeded" },
      { name: "bash", callID: "call_b", status: "running" },
      { name: "bash", callID: "call_b", status: "succeeded" },
    ])
  })

  test("each before-hook refusal is observed as denied without a running start", async () => {
    const sessionID = "observation_denied_session"
    const deps = makeDeps(fakeClient(), wt.worktree, { guards: { ...DEFAULT_CONFIG.guards, repeat_limit: 1 } })
    admitSession(deps, sessionID)
    const native = await createNativeToolFixture(deps, { role: "main", sessionID })
    await native.acceptUserTurn()
    const before = createToolBeforeHook(deps)
    const first = native.primeCall({ tool: "bash", args: { command: "same command" }, callID: "call_allowed" })
    await before(first.input as any, first.output as any)
    const firstRefusal = native.primeCall({ tool: "bash", args: { command: "same command" }, callID: "call_denied_1" })
    await expect(before(firstRefusal.input as any, firstRefusal.output as any)).rejects.toThrow(/blocked repeated call/)
    await expect(before(firstRefusal.input as any, firstRefusal.output as any)).rejects.toThrow(/duplicate-call/)
    const secondRefusal = native.primeCall({ tool: "bash", args: { command: "same command" }, callID: "call_denied_2" })
    await expect(before(secondRefusal.input as any, secondRefusal.output as any)).rejects.toThrow(/blocked repeated call/)

    expect(readToolObservations(wt.worktree, sessionID).map(({ callID, status }) => ({ callID, status }))).toEqual([
      { callID: "call_allowed", status: "running" },
      { callID: "call_denied_1", status: "denied" },
      { callID: "call_denied_2", status: "denied" },
    ])
  })

  test("thrown error events use the running identity and update failure state once", async () => {
    const sessionID = "observation_error_session"
    const deps = makeDeps(fakeClient(), wt.worktree)
    admitSession(deps, sessionID)
    const native = await createNativeEventFixture(deps, sessionID)
    const call = await native.primeCall({ tool: "bash", args: { command: "false" }, callID: "call_error" })
    await createToolBeforeHook(deps)(call.input as any, call.output as any)
    writeModeState(wt.worktree, sessionID, { ...EMPTY_MODE, active: true })
    const event = partEvent({ ...call.part, state: { status: "error", error: "private failure", input: call.output.args, time: { start: 1, end: 2 } } })
    await native.event({ event } as any)
    await native.event({ event } as any)

    expect(readToolObservations(wt.worktree, sessionID)).toEqual([
      { name: "bash", callID: "call_error", sessionID, status: "running" },
      { name: "bash", callID: "call_error", sessionID, status: "failed" },
    ])
    expect(readModeState(wt.worktree, sessionID).failures).toBe(1)
  })

  test("output-classified failure and its duplicate error event stay one terminal", async () => {
    const sessionID = "observation_output_error_session"
    const deps = makeDeps(fakeClient(), wt.worktree)
    admitSession(deps, sessionID)
    const native = await createNativeEventFixture(deps, sessionID)
    const call = await native.primeCall({ tool: "bash", args: { command: "false" }, callID: "call_output_error" })
    await createToolBeforeHook(deps)(call.input as any, call.output as any)
    const after = createToolAfterHook(deps)
    const output = { output: "Error: command failed", metadata: {} }
    await after(call.input as any, output as any)
    await expect(after(call.input as any, output as any)).rejects.toThrow("lca: OpenCode tool call refused (completed-call)")
    let resultRead = false
    const lateState: Record<string, unknown> = { status: "error", input: call.output.args, time: {} }
    for (const key of ["error", "output", "metadata"]) Object.defineProperty(lateState, key, {
      get() { resultRead = true; return "late PRIVATE result body" },
    })
    const event = partEvent({ ...call.part, state: lateState })
    await native.event({ event } as any)
    await native.event({ event } as any)

    expect(readToolObservations(wt.worktree, sessionID)).toEqual([
      { name: "bash", callID: "call_output_error", sessionID, status: "running" },
      { name: "bash", callID: "call_output_error", sessionID, status: "failed" },
    ])
    expect(listToolOutcomes(wt.worktree)).toMatchObject({
      totalCount: 1, rows: [{ sessionID, callID: "call_output_error", status: "failure", basis: "tool_error" }],
    })
    expect(resultRead).toBe(false)
    expect(readModeState(wt.worktree, sessionID).failures).toBe(0)
  })

  test("after-hook completion keeps its numeric SDK outcome after consuming proof", async () => {
    const sessionID = "observation_after_complete_session"
    const deps = makeDeps(fakeClient(), wt.worktree)
    admitSession(deps, sessionID)
    const native = await createNativeEventFixture(deps, sessionID)
    const call = await native.primeCall({ tool: "bash", args: { command: "printf safe" }, callID: "call_after_complete" })
    await createToolBeforeHook(deps)(call.input as any, call.output as any)

    const after = createToolAfterHook(deps)
    const result = { output: "ordinary result", metadata: {} }
    await after(call.input as any, result as any)
    const afterResult = structuredClone(result)
    const terminalState: Record<string, unknown> = {
      status: "completed", input: call.output.args,
      metadata: { exit: 0, token: "PRIVATE_METADATA_SENTINEL" },
      time: { start: 10, end: 25 },
    }
    let bodyReads = 0
    for (const key of ["output", "error", "title"]) Object.defineProperty(terminalState, key, {
      get() { bodyReads++; return "PRIVATE_RESULT_BODY_SENTINEL" },
    })
    const terminal = { ...call.part, state: terminalState }
    const outputDescriptor = Object.getOwnPropertyDescriptor(terminalState, "output")
    const terminalKeys = Reflect.ownKeys(terminalState)

    await native.event({ event: partEvent(terminal) } as any)
    await native.event({ event: partEvent({ ...terminal, id: "duplicate_terminal_part" }) } as any)

    expect(bodyReads).toBe(0)
    expect(Reflect.ownKeys(terminalState)).toEqual(terminalKeys)
    expect(Object.getOwnPropertyDescriptor(terminalState, "output")).toEqual(outputDescriptor)
    expect(terminalState.input).toBe(call.output.args)
    expect(call.part.state.status).toBe("running")
    expect(result).toEqual(afterResult)
    expect(listToolOutcomes(wt.worktree)).toMatchObject({
      totalCount: 1,
      rows: [{ sessionID, callID: "call_after_complete", tool: "bash", status: "success", basis: "exit_code", startedAt: 10, finishedAt: 25, durationMs: 15 }],
    })
    expect(readToolObservations(wt.worktree, sessionID)).toEqual([
      { name: "bash", callID: "call_after_complete", sessionID, status: "running" },
      { name: "bash", callID: "call_after_complete", sessionID, status: "succeeded" },
    ])
    const database = readFileSync(toolOutcomePath(wt.worktree))
    expect(database.includes(Buffer.from("PRIVATE_METADATA_SENTINEL"))).toBe(false)
    expect(database.includes(Buffer.from("PRIVATE_RESULT_BODY_SENTINEL"))).toBe(false)
  })

  test("a thrown error after a successful after-hook is diagnostic, not a second failure", async () => {
    const sessionID = "observation_conflict_hook_session"
    const deps = makeDeps(fakeClient(), wt.worktree)
    admitSession(deps, sessionID)
    const native = await createNativeEventFixture(deps, sessionID)
    const call = await native.primeCall({ tool: "bash", args: { command: "true" }, callID: "call_success_then_error" })
    await createToolBeforeHook(deps)(call.input as any, call.output as any)
    writeModeState(wt.worktree, sessionID, { ...EMPTY_MODE, active: true, failures: 2 })
    const after = createToolAfterHook(deps)
    const output = { output: "completed", metadata: {} }
    await after(call.input as any, output as any)
    let resultRead = false
    const lateState: Record<string, unknown> = { status: "error", input: call.output.args, time: { start: 1, end: 2 } }
    for (const key of ["error", "output", "metadata"]) Object.defineProperty(lateState, key, {
      get() { resultRead = true; return "late PRIVATE result body" },
    })
    const event = partEvent({ ...call.part, state: lateState })
    await native.event({ event } as any)
    await native.event({ event } as any)

    const observations = readToolObservations(wt.worktree, sessionID)
    expect(observations).toHaveLength(3)
    expect(observations[1]).toMatchObject({ status: "succeeded" })
    expect(observations[2]).toMatchObject({ status: "failed", diagnostic: "conflicting-terminal" })
    expect(recordToolObservation(wt.worktree, { name: "bash", callID: "call_success_then_error", sessionID, status: "succeeded" }))
      .toMatchObject({ disposition: "duplicate", terminalStatus: "succeeded" })
    expect(listToolOutcomes(wt.worktree)).toMatchObject({
      totalCount: 1, rows: [{ sessionID, callID: "call_success_then_error", status: "failure", basis: "tool_error", durationMs: 1 }],
    })
    expect(resultRead).toBe(false)
    expect(readModeState(wt.worktree, sessionID).failures).toBe(0)
  })

  test("uncorrelated completion retains only safe terminal facts across duplicate deliveries", async () => {
    const sessionID = "observation_unknown_session"
    const deps = makeDeps(fakeClient(), wt.worktree)
    admitSession(deps, sessionID)
    const native = await createNativeEventFixture(deps, sessionID)
    const call = await native.primeCall({ tool: "bash", args: { command: "true" }, callID: "uncorrelated_call" })
    const terminal: Record<string, unknown> = {
      ...call.part,
      state: {
        status: "completed", input: call.output.args, metadata: { exitCode: 0, token: "PRIVATE_METADATA_SENTINEL" },
        time: { start: 1, end: 2 },
      },
    }
    let bodyReads = 0
    for (const key of ["output", "error", "title"]) Object.defineProperty((terminal.state as Record<string, unknown>), key, {
      get() { bodyReads++; return "unverified private result body" },
    })
    const outputDescriptor = Object.getOwnPropertyDescriptor(terminal.state as object, "output")
    const terminalKeys = Reflect.ownKeys(terminal.state as object)
    await native.event({ event: partEvent(terminal) } as any)
    await native.event({ event: partEvent({ ...terminal, id: "uncorrelated_duplicate_part" }) } as any)

    expect(bodyReads).toBe(0)
    expect(Reflect.ownKeys(terminal.state as object)).toEqual(terminalKeys)
    expect(Object.getOwnPropertyDescriptor(terminal.state as object, "output")).toEqual(outputDescriptor)
    expect((terminal.state as Record<string, unknown>).input).toBe(call.output.args)
    expect(call.part.state.status).toBe("running")
    expect(listToolOutcomes(wt.worktree)).toMatchObject({
      totalCount: 1,
      rows: [{ sessionID, callID: "uncorrelated_call", tool: "bash", status: "success", basis: "exit_code" }],
    })
    expect(readToolObservations(wt.worktree, sessionID)).toEqual([
      { name: "bash", callID: "uncorrelated_call", sessionID, status: "succeeded" },
    ])
    const database = readFileSync(toolOutcomePath(wt.worktree))
    expect(database.includes(Buffer.from("PRIVATE_METADATA_SENTINEL"))).toBe(false)
    expect(database.includes(Buffer.from("unverified private result body"))).toBe(false)
  })
})
