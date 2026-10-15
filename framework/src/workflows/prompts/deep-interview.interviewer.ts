// Interviewer prompts: topology proposal and the single question of a round. LCA-authored; see ../ATTRIBUTION.
import { definePrompt } from "./prompt.ts"
import { DI_CONTEXT_MARKER, DI_READ_ONLY_RULES } from "./deep-interview.rules.ts"

export const DI_TOPOLOGY_PROMPT = definePrompt({
  id: "di.interviewer.topology",
  kind: "deep-interview",
  role: "interviewer",
  text:
    "You are the interviewer of a requirements interview. Propose the topology: the distinct components the requested work touches (1-16, each with a short stable id and a one-sentence description) and whether the work is greenfield or brownfield (brownfield when it changes existing code in this worktree; inspect it if unsure). " +
    "If the context holds an operator note or a previous proposal, revise the proposal accordingly. Do not ask questions yet.\n" +
    DI_READ_ONLY_RULES + "\n" +
    "Schema: {\"type\":\"topology\",\"project\":\"greenfield|brownfield\",\"components\":[{\"id\":\"core\",\"description\":\"...\"}]}" +
    DI_CONTEXT_MARKER,
})

export const DI_QUESTION_PROMPT = definePrompt({
  id: "di.interviewer.question",
  kind: "deep-interview",
  role: "interviewer",
  text:
    "You are the interviewer of a requirements interview. Ask exactly ONE question that targets the weakest dimension named in the context. Prefer a question the operator can answer in a sentence. " +
    "If panel findings are listed, fold the concrete ones into this single question as two or three ranked answer options or one recommended draft; never add a second question. " +
    "If closure gaps are listed, address the highest-impact gap. Do not repeat a settled decision.\n" +
    DI_READ_ONLY_RULES + "\n" +
    "Schema: {\"type\":\"question\",\"text\":\"the single question\"}" +
    DI_CONTEXT_MARKER,
})
