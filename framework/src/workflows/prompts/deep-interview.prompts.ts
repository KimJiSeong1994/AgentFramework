// The frozen deep-interview prompt set. Otter-authored; provenance in ../ATTRIBUTION.
import type { StagePrompt } from "./prompt.ts"
import { DI_ARCHITECT_PROMPT } from "./deep-interview.architect.ts"
import { DI_CLOSURE_PROMPT } from "./deep-interview.closure.ts"
import { DI_CONTRARIAN_PROMPT } from "./deep-interview.contrarian.ts"
import { DI_CRYSTALLIZE_PROMPT } from "./deep-interview.crystallize.ts"
import { DI_QUESTION_PROMPT, DI_TOPOLOGY_PROMPT } from "./deep-interview.interviewer.ts"
import { DI_RESEARCHER_PROMPT } from "./deep-interview.researcher.ts"
import { DI_RESTATEMENT_PROMPT } from "./deep-interview.restatement.ts"
import { DI_SCORER_PROMPT } from "./deep-interview.scorer.ts"
import { DI_SIMPLIFIER_PROMPT } from "./deep-interview.simplifier.ts"
import { DEEP_INTERVIEW_SUMMARIZE_PROMPT } from "./summarize.ts"

export {
  DI_ARCHITECT_PROMPT, DI_CLOSURE_PROMPT, DI_CONTRARIAN_PROMPT, DI_CRYSTALLIZE_PROMPT, DI_QUESTION_PROMPT, DI_RESEARCHER_PROMPT,
  DI_RESTATEMENT_PROMPT, DI_SCORER_PROMPT, DI_SIMPLIFIER_PROMPT, DI_TOPOLOGY_PROMPT,
}

export const DI_PANEL_PROMPTS = Object.freeze({
  researcher: DI_RESEARCHER_PROMPT, contrarian: DI_CONTRARIAN_PROMPT, simplifier: DI_SIMPLIFIER_PROMPT, architect: DI_ARCHITECT_PROMPT,
} as const)

/** Every deep-interview prompt, for boundary and attribution sweeps. */
export const DEEP_INTERVIEW_PROMPTS: readonly StagePrompt[] = Object.freeze([
  DI_TOPOLOGY_PROMPT, DI_QUESTION_PROMPT, DI_SCORER_PROMPT, DI_RESEARCHER_PROMPT, DI_CONTRARIAN_PROMPT, DI_SIMPLIFIER_PROMPT,
  DI_ARCHITECT_PROMPT, DI_CLOSURE_PROMPT, DI_RESTATEMENT_PROMPT, DI_CRYSTALLIZE_PROMPT, DEEP_INTERVIEW_SUMMARIZE_PROMPT,
])
