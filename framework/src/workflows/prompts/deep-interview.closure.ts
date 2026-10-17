// Closure audit prompt: an independent readiness check, never the clarity math alone. Otter-authored; see ../ATTRIBUTION.
import { definePrompt } from "./prompt.ts"
import { DI_CONTEXT_MARKER, DI_READ_ONLY_RULES } from "./deep-interview.rules.ts"

export const DI_CLOSURE_PROMPT = definePrompt({
  id: "di.closure",
  kind: "deep-interview",
  role: "architect",
  text:
    "You run the closure audit of a requirements interview, independently of the clarity numbers. Check the locked request and the confirmed components in the context: " +
    "every component has goal, constraint and acceptance coverage; no disputed or unresolved point remains on a path that matters; no guess stands in for something the operator confirmed. " +
    "Set pass true only when there is no material gap. List every material gap as one short sentence; an empty list means none.\n" +
    DI_READ_ONLY_RULES + "\n" +
    "Schema: {\"type\":\"closure\",\"pass\":true,\"gaps\":[\"...\"]}" +
    DI_CONTEXT_MARKER,
})
