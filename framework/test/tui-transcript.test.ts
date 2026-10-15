import { expect, test } from "bun:test"
import { TranscriptModel } from "../src/tui/transcript-model.ts"
import type { CliHostActivity } from "../src/hosts/cli-progress.ts"
import type { ExecutionRunStatus } from "../src/hosts/run-state.ts"

function start(callID: string, executionID = "exec"): CliHostActivity {
  return { kind: "tool-started", role: "worker", execution: 1, executionID, callID, taskID: "t1", tool: "read" }
}
function finish(callID: string, outcome: "succeeded" | "failed" | "denied" = "succeeded"): CliHostActivity {
  return { ...start(callID), kind: "tool-finished", ok: outcome === "succeeded", outcome } as CliHostActivity
}

test("repeated same-name calls remain individual and duplicate terminals are idempotent", () => {
  const model = new TranscriptModel("sid")
  model.activity(start("one")); model.activity(finish("one")); model.activity(finish("one"))
  model.activity(start("two")); model.activity(finish("two", "denied"))
  expect(model.items).toHaveLength(2)
  expect(model.search("read denied t1")).toHaveLength(1)
  expect(model.lines().join("\n")).not.toContain("Call one")
  expect(model.toggle(model.items[0]!.id)).toBe(true)
  expect(model.lines().join("\n")).toContain("Call one")
  expect(() => model.activity(finish("one", "failed"))).toThrow("conflicting transcript terminal")
})

test("current session search retains earliest items without tool bodies or timestamps", () => {
  const model = new TranscriptModel("sid")
  model.activity(start("oldest")); model.activity(finish("oldest", "failed"))
  for (let i = 0; i < 4000; i++) model.append(`message ${i}`)
  model.activity(start("newest")); model.activity(finish("newest"))
  model.taskSnapshot([{ id: "t1", status: "running" }])
  expect(model.search("read failed running")).toHaveLength(1)
  expect(model.currentTask).toBe("t1 running")
  expect(new TranscriptModel("other").search("read")).toHaveLength(0)
  expect(JSON.stringify(model.items[0])).not.toMatch(/requestedAt|input|output|timestamp/)
})

test("call and execution identities cannot alias through delimiters", () => {
  const model = new TranscriptModel("sid")
  model.activity(start("b:c", "a"))
  model.activity(start("c", "a:b"))
  expect(model.items).toHaveLength(2)
  expect(model.items[0]!.id).not.toBe(model.items[1]!.id)
})

test("cancellation ACK alone never becomes stopped and claims retain the fence", () => {
  const model = new TranscriptModel("sid")
  model.activity(start("one")); model.activity(finish("one", "failed")); model.toggle(model.items[0]!.id)
  const state: ExecutionRunStatus = { generation: 1, executions: [{
    executionId: "exec", ownerSession: "sid", taskId: "t1", attemptId: "attempt", generation: 1,
    role: "worker", cwd: "/repo", policyID: "policy", kind: "host", profile: "legacy-unowned",
    cancel: { requestedAt: 1, acknowledgedAt: 2 },
  }] }
  model.executionSnapshot(state, false)
  expect(model.lines().join("\n")).toContain("Cancellation: unconfirmed")
  state.executions[0]!.terminal = { outcome: "cancelled", terminalAt: 3 }
  model.executionSnapshot(state, false)
  expect(model.lines().join("\n")).toContain("Cancellation: unconfirmed")
  state.executions[0]!.reconciliation = { outcome: "terminal", quiescent: true, evidence: "owned transport joined", at: 4 }
  state.claim = { ownerSession: "sid", instance: "instance", pid: 1, generation: 1 }
  model.executionSnapshot(state, false)
  expect(model.lines().join("\n")).toContain("Cancellation: unconfirmed")
  delete state.claim
  model.executionSnapshot(state, true)
  expect(model.lines().join("\n")).toContain("Cancellation: unconfirmed")
  model.executionSnapshot(state, false)
  expect(model.lines().join("\n")).toContain("Cancellation: stopped with proof")
  expect(model.lines().join("\n")).not.toContain("requestedAt")
})

test("multiline provenance uses a stable continuation gutter without changing stored content", () => {
  const model = new TranscriptModel("sid")
  const text = "first\nsecond\n\nlast"
  for (const provenance of ["user", "assistant", "error", "canonical-plan"] as const) {
    model.append({ provenance, text })
  }
  expect(model.lines()).toEqual([
    "[You] first", "  | second", "  | ", "  | last",
    "[Assistant] first", "  | second", "  | ", "  | last",
    "[Error] first", "  | second", "  | ", "  | last",
    "[Canonical plan] first", "  | second", "  | ", "  | last",
  ])
  expect(model.items.every(item => item.kind === "text" && item.text === text)).toBe(true)
})

test("successful call summaries retain unsettled execution and claim warnings before expansion", () => {
  const model = new TranscriptModel("sid")
  model.activity(start("one"))
  model.activity(finish("one"))
  expect(model.lines()[0]).toContain("call succeeded")
  expect(model.lines()[0]).toContain("execution not observed")
  const state: ExecutionRunStatus = {
    generation: 1,
    claim: { ownerSession: "sid", instance: "instance", pid: 1, generation: 1 },
    executions: [{
      executionId: "exec", ownerSession: "sid", taskId: "t1", attemptId: "attempt", generation: 1,
      role: "worker", cwd: "/repo", policyID: "policy", kind: "host", profile: "legacy-unowned",
      terminal: { outcome: "done", terminalAt: 3 },
      reconciliation: { outcome: "terminal", quiescent: true, evidence: "joined", at: 4 },
    }],
  }
  model.executionSnapshot(state, false)
  expect(model.lines()[0]).toContain("call succeeded")
  expect(model.lines()[0]).toContain("execution unconfirmed")
  expect(model.lines()[0]).toContain("claim retained")
  expect(model.lines().join("\n")).not.toContain("Execution terminal:")
  delete state.claim
  model.executionSnapshot(state, false)
  expect(model.lines()[0]).not.toContain("unconfirmed")
  expect(model.lines()[0]).not.toContain("claim retained")
  model.evidenceSnapshot("exec", ["Unresolved execution fence retained"], { state: "historical", fence: true, claim: false })
  expect(model.lines()[0]).toContain("execution last recorded")
  expect(model.lines()[0]).toContain("fence retained")
})
