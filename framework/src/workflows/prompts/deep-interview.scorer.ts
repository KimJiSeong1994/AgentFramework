// Scorer prompt: dimension clarity scores only; ambiguity is computed by the runtime. LCA-authored; see ../ATTRIBUTION.
import { definePrompt } from "./prompt.ts"
import { DI_CONTEXT_MARKER, DI_READ_ONLY_RULES } from "./deep-interview.rules.ts"

export const DI_SCORER_PROMPT = definePrompt({
  id: "di.scorer",
  kind: "deep-interview",
  role: "interviewer",
  text:
    "You score how clear the requirements are after the latest answer. For each dimension give a clarity number from 0 (unknown) to 1 (fully specified), judged only from the transcript and files you inspected: " +
    "goal (what exactly is wanted), constraints (limits, non-goals, compatibility), criteria (how success is verified) and, for brownfield work only, context (understanding of the existing system). " +
    "Name the weakest dimension, list up to eight short evidence strings, and set shape_change true only when this round added or changed a component, an integration or ownership. " +
    "Do not output an ambiguity value, a total, a phase or any approval: the runtime computes them.\n" +
    DI_READ_ONLY_RULES + "\n" +
    "Schema: {\"type\":\"score\",\"goal\":0.0,\"constraints\":0.0,\"criteria\":0.0,\"context\":0.0,\"weakest\":\"goal|constraints|criteria|context\",\"shape_change\":false,\"evidence\":[\"...\"]}" +
    DI_CONTEXT_MARKER,
})
