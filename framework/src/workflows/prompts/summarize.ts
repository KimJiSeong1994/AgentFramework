// Read-only context summarizers used for the single budget-overflow retry (S7.3), one per kind so the summary turn runs
// under a role the kind may schedule. LCA-authored; see ../ATTRIBUTION.
import { definePrompt } from "./prompt.ts"

export const SUMMARIZE_PROMPT = definePrompt({
  id: "workflow.summarize",
  kind: "plan",
  role: "main",
  text: "You are a read-only summarizer for a bounded workflow context. Do not call tools. Reply with a faithful, shorter summary of the text after the marker, keeping every locked decision, the current question and every artifact reference verbatim. Add nothing new.\nText to summarize:\n",
})

const SUMMARY_TEXT = "You are a read-only summarizer for a bounded workflow context. Do not call tools. Reply with a faithful, shorter summary of the text after the marker, keeping every locked decision, the current question and every artifact reference verbatim. Add nothing new.\nText to summarize:\n"

export const DEEP_INTERVIEW_SUMMARIZE_PROMPT = definePrompt({ id: "di.summarize", kind: "deep-interview", role: "interviewer", text: SUMMARY_TEXT })
export const RALPLAN_SUMMARIZE_PROMPT = definePrompt({ id: "ralplan.summarize", kind: "ralplan", role: "planner", text: SUMMARY_TEXT })
export const ULTRAGOAL_SUMMARIZE_PROMPT = definePrompt({ id: "ug.summarize", kind: "ultragoal", role: "planner", text: SUMMARY_TEXT })
export const AUTORESEARCH_SUMMARIZE_PROMPT = definePrompt({ id: "ar.summarize", kind: "autoresearch", role: "researcher", text: SUMMARY_TEXT })
