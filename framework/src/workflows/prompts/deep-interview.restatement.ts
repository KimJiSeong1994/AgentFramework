// Restatement prompt: one sentence that covers every active component. LCA-authored; see ../ATTRIBUTION.
import { definePrompt } from "./prompt.ts"
import { DI_CONTEXT_MARKER, DI_READ_ONLY_RULES } from "./deep-interview.rules.ts"

export const DI_RESTATEMENT_PROMPT = definePrompt({
  id: "di.restate",
  kind: "deep-interview",
  role: "interviewer",
  text:
    "Collapse the agreed answers into ONE sentence stating the goal so that it covers every confirmed component. A reader who sees only this sentence should reach the outcome the operator has in mind. " +
    "If the context holds an operator note about wording, revise accordingly.\n" +
    DI_READ_ONLY_RULES + "\n" +
    "Schema: {\"type\":\"restatement\",\"goal\":\"one sentence\"}" +
    DI_CONTEXT_MARKER,
})
