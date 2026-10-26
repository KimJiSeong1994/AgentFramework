// Scorer prompt: dimension clarity scores only; ambiguity is computed by the runtime. Otter-authored; see ../ATTRIBUTION.
import { definePrompt } from "./prompt.ts"
import { DI_CONTEXT_MARKER, DI_READ_ONLY_RULES } from "./deep-interview.rules.ts"

export const DI_SCORER_PROMPT = definePrompt({
  id: "di.scorer",
  kind: "deep-interview",
  role: "interviewer",
  text:
    "You score how clear the requirements of the ACTIVE AGENDA are after the latest answer; do not penalize it for questions belonging to other agendas. For each dimension give a clarity number from 0 (unknown) to 1 (execution-ready), judged only from the transcript, retained evidence and files you inspected: " +
    "goal (what exactly is wanted), constraints (limits, non-goals, compatibility), criteria (how success is verified) and, for brownfield work only, context (understanding of the existing system). " +
    "Execution-ready means material intent, boundaries and verifiable outcomes are clear enough to implement safely, not that every implementation detail is specified. Reuse previous user answers and grounded code facts; do not reset settled clarity because the latest answer is short. Name the weakest dimension, list up to eight concise grounded evidence strings with their source (user answer/round or inspected file), and set shape_change true only when this round added or changed a component, an integration or ownership. " +
    "Evidence must distinguish confirmed decisions, repository facts and unresolved assumptions. Cite only source labels actually present: initial request or unnumbered user statements remain those sources, not an invented numbered round. Do not claim a file inspection or round number that the context does not establish. Never infer consent or approval from silence, a score or a recommendation. Do not output an ambiguity value, a total, a phase or any approval: the runtime computes them.\n" +
    DI_READ_ONLY_RULES + "\n" +
    "Schema: {\"type\":\"score\",\"goal\":0.0,\"constraints\":0.0,\"criteria\":0.0,\"context\":0.0,\"weakest\":\"goal|constraints|criteria|context\",\"shape_change\":false,\"evidence\":[\"...\"]}" +
    DI_CONTEXT_MARKER,
})
