// Shared stage-context helpers for the model-turn workflows (ultragoal, autoresearch): labelled sections, the bound-prompt
// composition with its summarize-retry rebuild, and fenced-JSON unwrapping. A leaf module: no process or queue imports.
import type { StagePrompt } from "./prompts/index.ts"

export function section(label: string, body: string): string {
  return `=== ${label} ===\n${body.trim()}\n`
}

export function compose(prompt: StagePrompt, sections: ReadonlyArray<readonly [string, string]>): { text: string; source: string; rebuild(summary: string): string } {
  const source = sections.map(([label, body]) => section(label, body)).join("\n")
  return { text: `${prompt.text}${source}`, source, rebuild: summary => `${prompt.text}${section("SUMMARIZED CONTEXT", summary)}` }
}

export const listed = (items: readonly string[]) => items.length ? items.map(item => `- ${item}`).join("\n") : "- none"


const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/
export function unfenced(output: string): string {
  const match = FENCE.exec(output.trim())
  return match ? match[1]! : output
}
