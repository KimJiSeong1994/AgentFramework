// Compile-time exhaustiveness fixtures (P5a). `bun run typecheck` includes this file; every `@ts-expect-error`
// below must keep erroring, otherwise tsc reports "unused @ts-expect-error" and the gate fails.
import type { FlowPhase } from "../../src/modes/instructions.ts"
import { FLOW_INSTRUCTIONS } from "../../src/modes/instructions.ts"
import { narrowPlan, REGISTRY, type KindDescriptor } from "../../src/workflows/registry.ts"
import { assertNever, type Phase, type PlanWorkflow, type WorkflowEnvelope, type WorkflowKind } from "../../src/workflows/types.ts"

// A Record<Phase, ...> must name every phase, including `paused`.
export const allPhases: Record<Phase, true> = {
  planning: true, reviewing: true, pending_approval: true, executing: true, stuck: true, paused: true, done: true, cancelled: true,
}
// @ts-expect-error `paused` is missing
export const missingPhase: Record<Phase, true> = {
  planning: true, reviewing: true, pending_approval: true, executing: true, stuck: true, done: true, cancelled: true,
}
// @ts-expect-error an unknown phase is not a Phase
export const extraPhase: Record<Phase, true> = { ...allPhases, imaginary: true }

// The model-facing instruction table is exhaustive over the non-terminal phases (including paused).
export const instructionPhases: FlowPhase[] = Object.keys(FLOW_INSTRUCTIONS) as FlowPhase[]
// @ts-expect-error terminal phases never get a flow suffix
export const terminalSuffix: FlowPhase = "done"

// A switch over Phase that forgets a case cannot reach assertNever.
export function describePhase(phase: Phase): string {
  switch (phase) {
    case "planning": case "reviewing": case "pending_approval": case "executing": case "stuck": case "paused": case "done": case "cancelled":
      return phase
    default:
      return assertNever(phase, "phase")
  }
}
export function describePhaseMissingCase(phase: Phase): string {
  switch (phase) {
    case "planning": case "reviewing": case "pending_approval": case "executing": case "stuck": case "done": case "cancelled":
      return phase
    default:
      // @ts-expect-error `paused` is unhandled
      return assertNever(phase, "phase")
  }
}

// Registry and kind switches are exhaustive over WorkflowKind.
export const kindNames: Record<WorkflowKind, string> = {
  plan: "plan", "deep-interview": "deep-interview", ralplan: "ralplan", ultragoal: "ultragoal", autoresearch: "autoresearch",
}
// @ts-expect-error `autoresearch` is missing
export const missingKind: Record<WorkflowKind, string> = { plan: "", "deep-interview": "", ralplan: "", ultragoal: "" }
export function describeKind(wf: WorkflowEnvelope): string {
  switch (wf.kind) {
    case "plan": case "deep-interview": case "ralplan": case "ultragoal": case "autoresearch": return wf.kind
    default: return assertNever(wf, "workflow kind")
  }
}
export function describeKindMissingCase(wf: WorkflowEnvelope): string {
  switch (wf.kind) {
    case "plan": case "deep-interview": case "ralplan": case "ultragoal": return wf.kind
    default:
      // @ts-expect-error `autoresearch` is unhandled
      return assertNever(wf, "workflow kind")
  }
}

// Per-kind stage unions are typed: a plan stage is not an autoresearch stage.
export const planStage: PlanWorkflow["stage"] = "decision"
// @ts-expect-error `evidence` is not a plan stage
export const wrongStage: PlanWorkflow["stage"] = "evidence"
export const descriptorKinds: { [K in WorkflowKind]: (typeof REGISTRY)[K]["kind"] } = {
  plan: "plan", "deep-interview": "deep-interview", ralplan: "ralplan", ultragoal: "ultragoal", autoresearch: "autoresearch",
}

// Plan APIs take PlanWorkflow: an unnarrowed envelope is a type error until narrowPlan narrows it.
declare function planApi(wf: PlanWorkflow): void
declare const anyWorkflow: WorkflowEnvelope
// @ts-expect-error an arbitrary WorkflowEnvelope is not a PlanWorkflow
planApi(anyWorkflow)
planApi(narrowPlan(anyWorkflow))

// Every kind descriptor must declare its schedulable roles.
export const rolesPresent: readonly string[] = REGISTRY.plan.roles
// @ts-expect-error a descriptor without `roles` does not compile
export const missingRoles: KindDescriptor<"plan"> = {
  kind: "plan", stages: ["draft"], phaseOf: () => "planning", allowedPhases: () => ["planning"], parseKind: () => {},
}

// StopDisplay (P5b): every presentation table must name each display value; a stop switch must be exhaustive.
import { stopDisplay, type StopDisplay } from "../../src/workflows/types.ts"
export const allStopDisplays: Record<StopDisplay, string> = { none: "", pausing: "pausing", paused: "paused", cancelling: "cancelling" }
// @ts-expect-error `cancelling` is missing
export const missingStopDisplay: Record<StopDisplay, string> = { none: "", pausing: "pausing", paused: "paused" }
export function describeStop(display: StopDisplay): string {
  switch (display) {
    case "none": case "pausing": case "paused": case "cancelling": return display
    default: return assertNever(display, "stop display")
  }
}
export function nonExhaustiveStop(display: StopDisplay): string {
  switch (display) {
    case "none": case "pausing": case "paused": return display
    // @ts-expect-error `cancelling` is unhandled, so `display` is not `never`
    default: return assertNever(display, "stop display")
  }
}
export const displayOf: StopDisplay = stopDisplay({ phase: "paused", stopIntent: null })
