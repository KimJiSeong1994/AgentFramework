import { afterEach, beforeEach, expect, test } from "bun:test"
import { createPlanningTimingCollector, MAX_MODEL_TIMINGS, planningTiming, validPlanningTiming } from "../src/telemetry/planning.ts"
import { openSession, replaySession } from "../src/sessions/store.ts"
import { createCliProgressPresenter } from "../src/hosts/cli-progress.ts"
import { restoreTranscript } from "../src/tui/session-transcript.ts"
import { TranscriptModel } from "../src/tui/transcript-model.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempGitWorktree>
beforeEach(() => { wt = tempGitWorktree() })
afterEach(() => wt.cleanup())

const workflow = {
  turnID: "00000000-0000-0000-0000-000000000001",
  workflowID: "wf_timing", kind: "ralplan", stage: "architect", role: "architect", operation: "stage", status: "completed",
  durationMs: 110, preflightMs: 10, summaryMs: 0, executionMs: 100, summaryCount: 0, inputChars: 3500,
}

test("turn timing buffers bounded model observations and never attaches unrelated or late activity", () => {
  const collector = createPlanningTimingCollector()
  const model = { kind: "model-returned", role: "planner", execution: 1, status: "completed", durationMs: 12, inputChars: 300, toolRound: 0 }
  collector.model(model)
  collector.start(workflow)
  for (let i = 0; i < MAX_MODEL_TIMINGS + 2; i++) collector.model(model)
  const foreign = { ...workflow, turnID: "00000000-0000-0000-0000-000000000002" }
  collector.start(foreign)
  expect(collector.finish(foreign)?.models).toEqual([])
  const result = collector.finish(workflow)!
  expect(result.models).toHaveLength(MAX_MODEL_TIMINGS)
  expect(result.droppedModelTimings).toBe(2)
  expect(validPlanningTiming(result)).toBe(true)
  collector.model(model)
  expect(collector.finish(workflow)?.models).toEqual([])
  expect(validPlanningTiming({ ...result, models: [{ ...(result.models as Record<string, unknown>[])[0], prompt: "PRIVATE" }] })).toBe(false)
})

test("timing projection drops private payloads and rejects malformed measurements", () => {
  const timing = planningTiming("workflow", { ...workflow, prompt: "PRIVATE", response: "PRIVATE", path: ".env" })!
  expect(validPlanningTiming(timing)).toBe(true)
  expect(JSON.stringify(timing)).not.toContain("PRIVATE")
  expect(JSON.stringify(timing)).not.toContain(".env")
  expect(validPlanningTiming({ ...timing, prompt: "PRIVATE" })).toBe(false)
  for (const patch of [{ durationMs: -1 }, { executionMs: NaN }, { inputChars: Infinity }, { stage: "untrusted text" }, { kind: "__proto__" }, { workflowID: "private/path" }]) {
    expect(planningTiming("workflow", { ...workflow, ...patch })).toBeUndefined()
  }
})

test("model timing survives the sanitized progress boundary without extra payloads", () => {
  const seen: unknown[] = []
  const progress = createCliProgressPresenter(() => {}, activity => seen.push(activity))
  progress.host({ kind: "model-returned", role: "planner", execution: 1, status: "completed", durationMs: 12, inputChars: 300, toolRound: 0, prompt: "PRIVATE" } as never)
  expect(planningTiming("model", seen[0])).toEqual({ category: "model", role: "planner", execution: 1, status: "completed", durationMs: 12, inputChars: 300, toolRound: 0 })
  expect(JSON.stringify(seen)).not.toContain("PRIVATE")
  progress.host({ kind: "model-returned", role: "planner", execution: 1, status: "completed", durationMs: NaN, inputChars: 300, toolRound: 0 })
  expect(planningTiming("model", seen[1])).toBeUndefined()
})

test("timing records persist and replay without entering the restored conversation", () => {
  const store = openSession(wt.worktree, "timing_session", { engine: "fixture", model: "fixture" })
  store.append("user", { text: "Plan this change." })
  store.append("timing", planningTiming("workflow", workflow)!)
  expect(() => store.append("timing", { ...planningTiming("workflow", workflow), content: "PRIVATE" })).toThrow("timing transcript data")
  store.append("assistant", { text: "Here is the plan." })
  const replay = replaySession(wt.worktree, store.sessionID)
  expect(replay.complete).toBe(true)
  expect(replaySession(wt.worktree, store.sessionID, { kind: "timing" }).records).toHaveLength(1)
  const restored = restoreTranscript(new TranscriptModel("timing_session"), replay.records)
  expect(restored.history).toEqual(["Plan this change."])
  store.release({ workflowQuiescent: true, evidence: "timing fixture complete", workflowID: null, revision: null })
})
