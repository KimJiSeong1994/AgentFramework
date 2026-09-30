import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createEventHook } from "../src/hooks/event.ts"
import { EMPTY_MODE, readModeState, removeSessionDir, writeModeState } from "../src/state/store.ts"
import { listToolOutcomes, recordToolOutcome, toolOutcomePath } from "../src/telemetry/outcomes.ts"
import { fakeClient, makeDeps, tempWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempWorktree>

beforeEach(() => { wt = tempWorktree() })
afterEach(() => wt.cleanup())

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
  return { type: "message.part.updated", properties: { part } } as any
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
    removeSessionDir(wt.worktree, "session_1")
    expect(listToolOutcomes(wt.worktree).totalCount).toBe(3)
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
    const disabled = makeDeps(fakeClient(), wt.worktree, { disabled_hooks: ["tool.history"] as any })
    const disabledHook = createEventHook(disabled)
    await disabledHook({ event: partEvent(completed()) } as any)
    expect(listToolOutcomes(wt.worktree).totalCount).toBe(0)

    const deps = makeDeps(fakeClient(), wt.worktree)
    const enabledHook = createEventHook(deps)
    await enabledHook({ event: partEvent(completed()) } as any)
    expect(listToolOutcomes(wt.worktree).totalCount).toBe(1)
  })

  test("continues error bookkeeping after recorder failure", async () => {
    const deps = makeDeps(fakeClient(), wt.worktree)
    const sessionID = "session_error"
    writeModeState(wt.worktree, sessionID, { ...EMPTY_MODE, active: true })
    const outcomePath = toolOutcomePath(wt.worktree)
    mkdirSync(dirname(outcomePath), { recursive: true })
    mkdirSync(outcomePath)
    const hook = createEventHook(deps)
    await hook({ event: partEvent(completed({
      id: "part_error_hook",
      sessionID,
      callID: "call_error_hook",
      state: { status: "error", error: "private error detail", input: {}, time: {} },
    })) } as any)

    expect(readModeState(wt.worktree, sessionID).failures).toBe(1)
    expect(deps.logs).toContain("tool outcome recording failed")
    expect(deps.logs.join(" ")).not.toContain("private error detail")
  })
})
