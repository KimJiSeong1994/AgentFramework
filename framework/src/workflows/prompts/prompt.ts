// Immutable, hash-bound stage prompts. A prompt is a frozen descriptor; its sha256 is bound into every turn binding and
// re-verified before dispatch, so a prompt edited in memory or substituted by a caller cannot run under the old hash.
import { createHash } from "node:crypto"
import type { ExecutionRole } from "../../hosts/types.ts"
import type { WorkflowKind } from "../types.ts"

export type StagePrompt = Readonly<{ id: string; kind: WorkflowKind; role: ExecutionRole; text: string; sha256: string }>

export function promptSha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export function definePrompt(input: { id: string; kind: WorkflowKind; role: ExecutionRole; text: string }): StagePrompt {
  return Object.freeze({ ...input, sha256: promptSha(input.text) })
}

/** True when the descriptor still matches its recorded hash (guards against a forged or mutated descriptor object). */
export function promptIntact(prompt: StagePrompt): boolean {
  return promptSha(prompt.text) === prompt.sha256
}
