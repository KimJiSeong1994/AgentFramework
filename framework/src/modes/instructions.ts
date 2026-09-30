// Per-mode instruction suffixes. Each ≤ 300 chars, English, imperative. They are appended to the END of the
// user message inside an <lca-mode> marker block and never enter the system prompt (static-prefix contract).
// The long-form procedure lives in .opencode/skills/<mode>/SKILL.md, read on demand.
import type { LcaConfig, Mode } from "../config.ts"

export type ActiveMode = Exclude<Mode, "none">
export type SuffixName = ActiveMode | "cancel"

export const MODE_INSTRUCTIONS: Record<ActiveMode, string> = {
  ulw:
    "Do not do the work yourself: split it into independent tasks (title, detail, verify command) and call the delegate tool once with the whole list. Call delegate at most once per request. Never task a worker to edit tests or fake results. When it returns, report the result in ≤10 lines and stop.",
  plan:
    "Do not edit files. Produce a numbered plan: goal, steps (each: title, files, verify command), risks. Ask at most 2 clarifying questions, only if a step is ambiguous.",
  data:
    "Answer from the database only, through the analyst: call the delegate tool once with one task per question, kind \"data\", title = the question, no verify. Do not query or guess yourself. Then report each task's SQL and ANSWER lines and stop.",
}

/** Used when the delegate tool is disabled (config.disabled_hooks has "tool.delegate"): the stage-1 direct loop. */
export const MODE_INSTRUCTIONS_NO_DELEGATE: Record<ActiveMode, string> = {
  ulw:
    "Work through the task list without asking for confirmation. After each step run the relevant test or check. Stop only when every item is verified or you are blocked; then report in ≤10 lines.",
  plan: MODE_INSTRUCTIONS.plan,
  data: "Answer from the database only. Resolve the concepts with resolve_semantics first, then write one read-only SQL and run it with db_query at most twice. Reply with SQL:, RESULT: (≤10 rows) and ANSWER: one sentence. Never guess columns or values.",
}

export const CANCEL_INSTRUCTION = "Mode cancelled. Finish the current step and stop."

export const MODE_MARKER_RE = /(?:\n\n)?<lca-mode name="[a-z]+">[\s\S]*?<\/lca-mode>/g

/** Build the marker block appended to the end of a user message. */
export function modeSuffix(mode: SuffixName, extra?: string, config?: Pick<LcaConfig, "disabled_hooks">): string {
  const table = config?.disabled_hooks.includes("tool.delegate") ? MODE_INSTRUCTIONS_NO_DELEGATE : MODE_INSTRUCTIONS
  const base = mode === "cancel" ? CANCEL_INSTRUCTION : table[mode]
  const tail = extra?.trim() ? ` ${extra.trim()}` : ""
  return `\n\n<lca-mode name="${mode}">${base}${tail}</lca-mode>`
}

/** Inverse of modeSuffix: remove every <lca-mode> block (used by tests and log formatting). */
export function stripModeSuffix(text: string): string {
  return text.replace(MODE_MARKER_RE, "")
}

export function hasModeSuffix(text: string): boolean {
  return /<lca-mode name="[a-z]+">[\s\S]*?<\/lca-mode>\s*$/.test(text)
}
