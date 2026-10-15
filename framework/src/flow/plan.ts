// Plan contract (ralplan §5.1): code gates on the model's structured plan, the canonical sha that approval binds to,
// the human-readable markdown view, and the plan -> delegate task conversion. Pure except for path checks.
import { isAbsolute, normalize, relative, resolve } from "node:path"
import { verifyCommandProblem } from "../config.ts"
import { taskTextProblem } from "../orchestration/gaming.ts"
import { protectedFiles, type TaskInput } from "../state/ledger.ts"
import { sha256 } from "./state.ts"

export type PlanStep = { title: string; files: string[]; detail: string; verify: string }
export type Plan = { goal: string; steps: PlanStep[]; risks: string[]; revision: number }

export const PLAN_LIMITS = { minSteps: 3, maxSteps: 10, title: 120, goal: 300, detail: 1000, minRisks: 1, maxRisks: 5 }
/** Ultragoal units are 1-10 steps; the only limits other than PLAN_LIMITS that validatePlan accepts. */
export const UNIT_LIMITS = { minSteps: 1, maxSteps: 10 } as const
const FORBIDDEN_ROOTS = [".git", ".lca", "knowledge/raw"]

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/** Normalise the model's input into a Plan shape (no validation). */
export function coercePlan(input: unknown, revision: number): Plan {
  const o = (input ?? {}) as Record<string, unknown>
  const steps = Array.isArray(o.steps) ? o.steps : []
  return {
    goal: str(o.goal),
    steps: steps.map((s) => {
      const r = (s ?? {}) as Record<string, unknown>
      return {
        title: str(r.title),
        files: Array.isArray(r.files) ? r.files.map(str).filter(Boolean) : [],
        detail: str(r.detail),
        verify: str(r.verify),
      }
    }),
    risks: Array.isArray(o.risks) ? o.risks.map(str).filter(Boolean) : [],
    revision,
  }
}

function fileProblem(worktree: string, f: string): string | null {
  if (isAbsolute(f)) return `path must be relative: ${f}`
  const n = normalize(f)
  if (n.split(/[\\/]/).includes("..")) return `path must not contain '..': ${f}`
  const abs = resolve(worktree, n)
  const rel = relative(worktree, abs)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return `path must be inside the repository: ${f}`
  const unix = rel.split("\\").join("/")
  for (const root of FORBIDDEN_ROOTS) if (unix === root || unix.startsWith(`${root}/`)) return `path under ${root}/ is not allowed: ${f}`
  return null
}

/** §5.1 hard gates. Returns every problem (empty = valid). File existence is not required (new files/dirs OK). */
export function validatePlan(plan: Plan, worktree: string, verifyAllow: string[], limits: Partial<Pick<typeof PLAN_LIMITS, "minSteps" | "maxSteps">> = {}): string[] {
  const bounded = (limits.minSteps === undefined || limits.minSteps === UNIT_LIMITS.minSteps || limits.minSteps === PLAN_LIMITS.minSteps) &&
    (limits.maxSteps === undefined || limits.maxSteps === UNIT_LIMITS.maxSteps)
  if (!bounded) throw new RangeError("validatePlan accepts only the plan limits or UNIT_LIMITS")
  const L = { ...PLAN_LIMITS, ...limits }
  const errs: string[] = []
  if (!plan.goal) errs.push("goal is empty")
  else if (plan.goal.length > L.goal) errs.push(`goal longer than ${L.goal} chars`)
  if (plan.steps.length < L.minSteps || plan.steps.length > L.maxSteps) errs.push(`plan needs ${L.minSteps}-${L.maxSteps} steps (got ${plan.steps.length})`)
  if (plan.risks.length < L.minRisks || plan.risks.length > L.maxRisks) errs.push(`risks needs ${L.minRisks}-${L.maxRisks} items (got ${plan.risks.length})`)
  const seen = new Set<string>()
  plan.steps.forEach((s, i) => {
    const at = `step ${i + 1}`
    if (!s.title) errs.push(`${at}: title is empty`)
    else if (s.title.length > L.title) errs.push(`${at}: title longer than ${L.title} chars`)
    const key = s.title.toLowerCase()
    if (s.title && seen.has(key)) errs.push(`${at}: duplicate title "${s.title}"`)
    seen.add(key)
    if (s.detail.length > L.detail) errs.push(`${at}: detail longer than ${L.detail} chars`)
    if (s.files.length === 0) errs.push(`${at}: list at least one file`)
    for (const f of s.files) {
      const p = fileProblem(worktree, f)
      if (p) errs.push(`${at}: ${p}`)
    }
    if (!s.verify) errs.push(`${at}: verify command is empty`)
    else {
      const v = verifyCommandProblem(s.verify, verifyAllow)
      if (v) errs.push(`${at}: verify ${v}`)
    }
    const g = taskTextProblem(s.title, s.detail, protectedFiles({ verify: s.verify }))
    if (g) errs.push(`${at}: ${g}`)
  })
  return errs
}

/** Canonical JSON (fixed key order) -> sha256; the value approval and ledger tags bind to. */
export function canonicalPlanJson(plan: Plan): string {
  return JSON.stringify({
    goal: plan.goal,
    steps: plan.steps.map((s) => ({ title: s.title, files: s.files, detail: s.detail, verify: s.verify })),
    risks: plan.risks,
    revision: plan.revision,
  })
}

export function canonicalPlanSha(plan: Plan): string {
  return sha256(canonicalPlanJson(plan))
}

export type ReviewView = { verdict: "okay" | "iterate" | "none"; findings: string[]; note?: "aborted" | "cap" }

export function renderPlanMd(wfId: string, plan: Plan, review?: ReviewView): string {
  const lines = [
    `# Plan ${wfId} (revision ${plan.revision})`,
    "",
    "> Rendered by lca from the canonical plan. Editing this file does not change the approved plan; an edited file blocks /approve.",
    "",
    `**Goal:** ${plan.goal}`,
    "",
    "## Steps",
    "",
  ]
  plan.steps.forEach((s, i) => {
    lines.push(`${i + 1}. **${s.title}**`)
    lines.push(`   - files: ${s.files.map((f) => `\`${f}\``).join(", ")}`)
    if (s.detail) lines.push(`   - detail: ${s.detail.replace(/\n+/g, " ")}`)
    lines.push(`   - verify: \`${s.verify}\``)
  })
  lines.push("", "## Risks", "", ...plan.risks.map((r) => `- ${r}`))
  if (review) {
    lines.push("", "## Review (advisory)", "", `verdict: ${review.verdict}${review.note ? ` (${review.note})` : ""}`)
    for (const f of review.findings) lines.push(`- ${f}`)
  }
  lines.push("", "Next: `/approve` to run these steps, or `/reject <reason>` to revise.", "")
  return lines.join("\n")
}

export function planMdPath(wfId: string): string {
  return `.lca/plans/${wfId}.md`
}

/** Plan steps -> delegate tasks, 1:1 in order; the step's files are carried in the task detail. */
export function planToTasks(plan: Plan): TaskInput[] {
  return plan.steps.map((s) => ({
    title: s.title,
    detail: `files: ${s.files.join(", ")}${s.detail ? `; ${s.detail}` : ""}`,
    verify: s.verify,
    kind: "code" as const,
  }))
}
