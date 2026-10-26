import { EXECUTION_ROLES } from "../hosts/types.ts"
import { AUTORESEARCH_STAGES, DEEP_INTERVIEW_STAGES, PLAN_STAGES, RALPLAN_STAGES, ULTRAGOAL_STAGES } from "../workflows/types.ts"

const STAGES: Readonly<Record<string, readonly string[]>> = {
  plan: PLAN_STAGES, "deep-interview": DEEP_INTERVIEW_STAGES, ralplan: RALPLAN_STAGES,
  ultragoal: ULTRAGOAL_STAGES, autoresearch: AUTORESEARCH_STAGES,
}
const WORKFLOW_KEYS = ["turnID", "workflowID", "kind", "stage", "role", "operation", "status", "durationMs", "inputChars", "preflightMs", "summaryMs", "executionMs", "summaryCount"] as const
const MODEL_KEYS = ["role", "execution", "status", "durationMs", "inputChars", "toolRound"] as const
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const turnID = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value)
export const MAX_MODEL_TIMINGS = 64

/** Copy only fixed enums and counters; request text, model output and tool arguments never enter timing records. */
export function planningTiming(category: "workflow" | "model", value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const v = value as Record<string, unknown>
  if (!(EXECUTION_ROLES as readonly unknown[]).includes(v.role) || !count(v.durationMs) || !count(v.inputChars)) return
  if (category === "workflow") {
    if (!turnID(v.turnID) || typeof v.kind !== "string" || !Object.hasOwn(STAGES, v.kind) || !STAGES[v.kind]!.includes(v.stage as string) ||
        (v.workflowID !== null && (typeof v.workflowID !== "string" || !/^wf_[A-Za-z0-9_.-]{1,124}$/u.test(v.workflowID))) ||
        (v.operation !== "stage" && v.operation !== "summary") ||
        !["completed", "diagnostic", "stuck", "failed", "cancelled"].includes(v.status as string) ||
        ![v.preflightMs, v.summaryMs, v.executionMs, v.summaryCount].every(count) ||
        (v.droppedModelTimings !== undefined && !count(v.droppedModelTimings)) ||
        (v.models !== undefined && (!Array.isArray(v.models) || v.models.length > MAX_MODEL_TIMINGS ||
          v.models.some(model => !model || typeof model !== "object" || Array.isArray(model) || model.category !== "model" || !validPlanningTiming(model))))) return
  } else if (!count(v.execution) || v.execution < 1 || !count(v.toolRound) ||
      !["completed", "failed", "cancelled", "unresolved", "incomplete"].includes(v.status as string)) return
  const keys = category === "workflow" ? WORKFLOW_KEYS : MODEL_KEYS
  return { ...Object.fromEntries([["category", category], ...keys.map(key => [key, v[key]])]),
    ...(category === "workflow" ? { models: v.models ?? [], droppedModelTimings: v.droppedModelTimings ?? 0 } : {}) }
}

/** One bounded collection per admitted turn; never retain queue-model activity between workflow turns. */
export function createPlanningTimingCollector() {
  let active: { id: string; models: Record<string, unknown>[]; dropped: number } | undefined
  return {
    start(value: unknown): void {
      const id = value && typeof value === "object" ? (value as Record<string, unknown>).turnID : undefined
      if (!active && turnID(id)) active = { id, models: [], dropped: 0 }
    },
    model(value: unknown): void {
      if (!active || !value || typeof value !== "object" || (value as Record<string, unknown>).kind !== "model-returned") return
      const measured = planningTiming("model", value)
      if (!measured) return
      if (active.models.length < MAX_MODEL_TIMINGS) active.models.push(measured)
      else active.dropped++
    },
    finish(value: unknown): Record<string, unknown> | undefined {
      const timing = planningTiming("workflow", value)
      if (!timing) return
      if (!active || timing.turnID !== active.id) return timing
      const captured = active
      active = undefined
      return { ...timing, models: captured.models, droppedModelTimings: captured.dropped }
    },
  }
}

export function validPlanningTiming(value: Record<string, unknown>): boolean {
  if (value.category !== "workflow" && value.category !== "model") return false
  const projected = planningTiming(value.category, value)
  return projected !== undefined && Object.keys(value).length === Object.keys(projected).length &&
    Object.keys(value).every(key => Object.hasOwn(projected, key))
}
