// Crystallize prompt: the narrative body of the specification. The runtime writes the metadata and the file. LCA-authored; see ../ATTRIBUTION.
import { definePrompt } from "./prompt.ts"
import { DI_CONTEXT_MARKER, DI_READ_ONLY_RULES } from "./deep-interview.rules.ts"

export const DI_CRYSTALLIZE_PROMPT = definePrompt({
  id: "di.crystallize",
  kind: "deep-interview",
  role: "interviewer",
  text:
    "Write the narrative body of the requirements specification as markdown from the confirmed goal, the confirmed components, the transcript decisions and any known gaps in the context. " +
    "Use these sections: Goal, Constraints, Non-Goals, Acceptance Criteria, Assumptions and Open Gaps. Quote operator decisions faithfully; invent nothing. " +
    "Do not write metadata, scores, file paths or approvals: the runtime adds them and writes the file.\n" +
    DI_READ_ONLY_RULES + "\n" +
    "Schema: {\"type\":\"message\",\"text\":\"markdown body\"}" +
    DI_CONTEXT_MARKER,
})
