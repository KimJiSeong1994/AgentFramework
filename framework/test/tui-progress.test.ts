import { describe, expect, test } from "bun:test"
import { progressState, renderProgress, stagePosition } from "../src/tui/progress.ts"
import { REGISTRY } from "../src/workflows/registry.ts"
import { displayWidth, renderFrame } from "../src/tui/render.ts"

const none = { done: 0, failed: 0, cancelled: 0, running: 0, total: 0 }

describe("composer progress", () => {
  test("stage position follows the driver flow; a revision redrafts at the planner step", () => {
    expect(stagePosition("ralplan", "planner")).toEqual({ index: 1, count: 5 })
    expect(stagePosition("ralplan", "revision")).toEqual({ index: 1, count: 5 })
    expect(stagePosition("ralplan", "architect")).toEqual({ index: 2, count: 5 })
    expect(stagePosition("ralplan", "pending_execution")).toEqual({ index: 5, count: 5 })
    expect(stagePosition("ralplan", "terminal")).toBeUndefined()
    expect(stagePosition("nope", "planner")).toBeUndefined()
  })

  test("every non-terminal registry stage of every kind has a step", () => {
    for (const [kind, descriptor] of Object.entries(REGISTRY)) {
      for (const stage of descriptor.stages) {
        if (stage === "terminal") continue
        expect([kind, stage, stagePosition(kind, stage) !== undefined]).toEqual([kind, stage, true])
      }
    }
  })

  test("a live task run wins over the workflow stage and shows finished/total and percent", () => {
    const state = progressState({
      tasks: { done: 2, failed: 1, cancelled: 0, running: 1, total: 5 },
      workflow: { kind: "ultragoal", stage: "unit_execute", phase: "executing" },
      busy: true, frame: 0,
    })
    expect(state).toEqual({ kind: "tasks", counts: { done: 2, failed: 1, cancelled: 0, running: 1, total: 5 } })
    const line = renderProgress(state!, 60)
    expect(line).toContain("3/5 tasks · 1 failed · 60%")
    expect(line.startsWith("█".repeat(1))).toBe(true)
    expect(displayWidth(line)).toBeLessThanOrEqual(60)
  })

  test("finished tasks with nothing running no longer claim the bar", () => {
    expect(progressState({ tasks: { done: 3, failed: 0, cancelled: 0, running: 0, total: 3 }, busy: false, frame: 0 })).toBeUndefined()
  })

  test("workflow stage is a position, not a percent; idle phases are labeled", () => {
    const active = progressState({ tasks: none, workflow: { kind: "ralplan", stage: "critic", phase: "reviewing" }, busy: true, frame: 3 })
    expect(active).toMatchObject({ kind: "stage", index: 3, count: 5, settled: false })
    expect(renderProgress(active!, 70)).toContain("step 3/5 · ralplan · critic")
    expect(renderProgress(active!, 70)).not.toContain("%")
    const waiting = progressState({ tasks: none, workflow: { kind: "ralplan", stage: "pending_execution", phase: "pending_approval" }, busy: false, frame: 0 })
    expect(renderProgress(waiting!, 70)).toContain("step 5/5 · ralplan · pending_execution · pending approval")
  })

  test("ultragoal goals give a completion bar", () => {
    const state = progressState({ tasks: none, workflow: { kind: "ultragoal", stage: "unit_plan", phase: "planning", goals: { complete: 1, total: 4 } }, busy: true, frame: 0 })
    expect(renderProgress(state!, 60)).toContain("1/4 goals · ultragoal · unit_plan")
  })

  test("done workflows and idle chat show nothing; a bare busy request slides", () => {
    expect(progressState({ tasks: none, workflow: { kind: "ralplan", stage: "terminal", phase: "done" }, busy: false, frame: 0 })).toBeUndefined()
    expect(progressState({ tasks: none, busy: false, frame: 0 })).toBeUndefined()
    const first = renderProgress(progressState({ tasks: none, busy: true, frame: 2, activity: "model working" })!, 40)
    const later = renderProgress(progressState({ tasks: none, busy: true, frame: 5, activity: "model working" })!, 40)
    expect(first).toContain("model working")
    expect(first).not.toBe(later)
    expect(renderProgress(progressState({ tasks: none, busy: true, frame: 2 })!, 40, true)).toMatch(/^[#-]+ working$/u)
  })

  test("the input box top border carries the progress line; a picker title takes precedence", () => {
    const base = { columns: 80, rows: 24, transcript: [], status: "", draft: "", cursor: 0 }
    const withProgress = renderFrame({ ...base, progress: "████░░░░ 2/4 tasks · 50%" })
    expect(withProgress).toContain("╭─ ████░░░░ 2/4 tasks · 50% ─")
    const withTitle = renderFrame({ ...base, progress: "████░░░░ 2/4 tasks · 50%", composerTitle: "Commands" })
    expect(withTitle).toContain("╭─ Commands ─")
    expect(withTitle).not.toContain("2/4 tasks")
    expect(renderFrame(base)).not.toContain("tasks")
  })
})
