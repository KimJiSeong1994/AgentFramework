// Closure audit prompt: an independent readiness check, never the clarity math alone. Otter-authored; see ../ATTRIBUTION.
import { definePrompt } from "./prompt.ts"
import { DI_CONTEXT_MARKER, DI_READ_ONLY_RULES } from "./deep-interview.rules.ts"

export const DI_CLOSURE_PROMPT = definePrompt({
  id: "di.closure",
  kind: "deep-interview",
  role: "architect",
  text:
    "You run the closure audit of a requirements interview, independently of the clarity numbers. Check the locked request and the confirmed task agendas (components) in the context, including previous answers and retained evidence across all agendas: " +
    "every agenda has material goal, constraint and acceptance coverage; no disputed or unresolved point remains on a path that matters; no guess stands in for something the operator confirmed. " +
    "Routine implementation details that can be resolved from the repository are not missing human decisions. A question budget being exhausted is not evidence of readiness or approval. Preserve unresolved safety, authorization and scope decisions as gaps; do not treat assumptions as operator confirmation. Set pass true only when there is no material gap. List every material gap as one short sentence; an empty list means none.\n" +
    DI_READ_ONLY_RULES + "\n" +
    "When gaps remain, retain every explicitly unresolved material decision; do not drop an access/visibility decision merely because a recipient decision is also unresolved. Include agenda_ids naming only the confirmed task agendas that need clarification. For a cross-task gap include each affected id; never reopen an unrelated ready agenda. When pass is true use an empty agenda_ids list.\n" +
    "Schema: {\"type\":\"closure\",\"pass\":true,\"gaps\":[],\"agenda_ids\":[]}" +
    DI_CONTEXT_MARKER,
})
