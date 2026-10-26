// Crystallize prompt: the narrative body of the specification. The runtime writes the metadata and the file. Otter-authored; see ../ATTRIBUTION.
import { definePrompt } from "./prompt.ts"
import { DI_CONTEXT_MARKER, DI_READ_ONLY_RULES } from "./deep-interview.rules.ts"

export const DI_CRYSTALLIZE_PROMPT = definePrompt({
  id: "di.crystallize",
  kind: "deep-interview",
  role: "interviewer",
  text:
    "Write the narrative body of the requirements specification as markdown from the confirmed goal, the confirmed task agendas (components), the transcript decisions and retained evidence and any known gaps in the context. " +
    "Use these sections: Goal, Constraints, Non-Goals, Acceptance Criteria, Assumptions and Open Gaps. Within these sections group the relevant decisions, acceptance criteria and residual gaps by task agenda, so an implementer can see what is settled and what remains open. Distinguish grounded repository facts from assumptions and explicit operator decisions. Preserve material gaps even when a question budget ended the interview. Quote operator decisions faithfully; invent nothing. " +
    "Do not write metadata, scores, file paths or approvals: the runtime adds them and writes the file.\n" +
    DI_READ_ONLY_RULES + "\n" +
    "Schema: {\"type\":\"message\",\"text\":\"markdown body\"}" +
    DI_CONTEXT_MARKER,
})
