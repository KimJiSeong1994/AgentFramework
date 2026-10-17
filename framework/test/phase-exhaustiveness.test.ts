// P5b: every phase x stop-state pair has an explicit presentation/gate decision. The compile-time half lives in
// test/types/workflow-exhaustive.ts (`bun run typecheck`); this is the runtime half for the S1/S2 surfaces.
import { describe, expect, test } from "bun:test"
import { PHASES, TERMINAL } from "../src/flow/machine.ts"
import { PHASE_LABEL } from "../src/flow/status.ts"
import { FLOW_INSTRUCTIONS } from "../src/modes/instructions.ts"
import { STOP_DISPLAYS, stopDisplay, type Phase, type StopIntent } from "../src/workflows/types.ts"

const intent = (kind: "pause" | "cancel"): StopIntent => ({ kind, token: "t", requestedFrom: { phase: "executing", stage: "unit" }, checkpoint: null, reason: "r" })

describe("phase x stop-state exhaustiveness", () => {
  test("every phase has a label and every non-terminal phase has instructions", () => {
    for (const phase of PHASES) {
      expect(PHASE_LABEL[phase]).toBeTruthy()
      if (!TERMINAL.has(phase)) expect(FLOW_INSTRUCTIONS[phase as Exclude<Phase, "done" | "cancelled">]).toBeTruthy()
    }
  })

  test("stopDisplay is defined for every phase with every stop intent, and never claims paused without the settled phase", () => {
    for (const phase of PHASES) {
      for (const stopIntent of [null, intent("pause"), intent("cancel")]) {
        const display = stopDisplay({ phase, stopIntent })
        expect(STOP_DISPLAYS).toContain(display)
        if (display === "paused") expect(phase).toBe("paused")
        if (stopIntent?.kind === "cancel") expect(display).toBe("cancelling")
        if (stopIntent === null) expect(display).toBe("none")
      }
    }
  })
})

describe("S4 presentation", () => {
  test("STOP_LABEL names every StopDisplay with the exact unconfirmed wording", async () => {
    const { STOP_LABEL, stopLabel } = await import("../src/flow/status.ts")
    expect(STOP_LABEL.none).toBe("")
    expect(STOP_LABEL.pausing).toBe("pausing — termination unconfirmed")
    expect(STOP_LABEL.cancelling).toBe("cancelling — termination unconfirmed")
    expect(stopLabel({ stop: "paused", pausedFrom: { phase: "executing", stage: "unit" } })).toBe("paused (from executing/unit)")
    for (const display of STOP_DISPLAYS) expect(display in STOP_LABEL).toBe(true)
  })

  test("/pause is a completion and `otter pause` parses with the same session requirement as cancel", async () => {
    const { commandCompletions } = await import("../src/tui/skill-completion.ts")
    expect(commandCompletions("/pa")).toEqual(["/pause"])
    const { parseCliArgs } = await import("../src/hosts/cli.ts")
    expect(() => parseCliArgs(["pause", "--worktree", process.cwd()])).toThrow("requires explicit --engine, --model, and --session")
    expect(parseCliArgs(["pause", "--worktree", process.cwd(), "--session", "s", "--engine", "local", "--model", "m"]).command).toBe("pause")
  })
})


describe("P6a S1 stage tables and evidence gates", () => {
  test("requiredArtifactKeys is defined for every kind/stage/phase triple and only gates the documented completions", async () => {
    const { requiredArtifactKeys, REGISTRY } = await import("../src/workflows/registry.ts")
    const { WORKFLOW_KINDS } = await import("../src/workflows/types.ts")
    for (const kind of WORKFLOW_KINDS) {
      const d = REGISTRY[kind] as { stages: readonly string[]; allowedPhases(stage: string): readonly Phase[] }
      for (const stage of d.stages) for (const phase of d.allowedPhases(stage)) {
        const keys = requiredArtifactKeys({ kind, stage, phase } as never)
        if (kind === "plan" || kind === "ultragoal" || kind === "autoresearch") expect(keys).toEqual([])
        if (phase === "cancelled") expect(keys).toEqual([])
      }
    }
    expect(requiredArtifactKeys({ kind: "deep-interview", stage: "terminal", phase: "done" })).toEqual(["spec.md"])
    expect(requiredArtifactKeys({ kind: "deep-interview", stage: "crystallize", phase: "planning" })).toEqual([])
    expect(requiredArtifactKeys({ kind: "ralplan", stage: "pending_execution", phase: "pending_approval" })).toEqual(["pending-approval.md", "consensus.json"])
    expect(requiredArtifactKeys({ kind: "ralplan", stage: "pending_execution", phase: "paused" })).toEqual(["pending-approval.md", "consensus.json"])
    expect(requiredArtifactKeys({ kind: "ralplan", stage: "terminal", phase: "done" })).toEqual(["pending-approval.md", "consensus.json"])
    expect(requiredArtifactKeys({ kind: "ralplan", stage: "terminal", phase: "stuck" })).toEqual(["best-plan.md"])
  })

  test("input budget B1: workflow read-only roles use the main limit; every legacy role keeps its limit and policy ids", async () => {
    const { roleInputLimit } = await import("../src/hosts/cli-host.ts")
    const { EXECUTION_ROLES, WORKFLOW_READ_ONLY_ROLES, CONFIG_MODEL_ROLES } = await import("../src/hosts/types.ts")
    for (const role of WORKFLOW_READ_ONLY_ROLES) expect(roleInputLimit(role)).toBe(8192)
    for (const role of CONFIG_MODEL_ROLES) expect(roleInputLimit(role)).toBe(role === "main" ? 8192 : 5120)
    expect(EXECUTION_ROLES.length as number).toBe(CONFIG_MODEL_ROLES.length + WORKFLOW_READ_ONLY_ROLES.length)
    // policy identity itself is asserted byte-for-byte by test/policy-identity.test.ts (legacy-policy-ids.json)
  })
})
