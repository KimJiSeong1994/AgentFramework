// Recovery hints: short, actionable text appended to failing tool outputs so a small model changes approach
// instead of re-issuing the same call (ported idea from OMO's edit/json recovery).

export const HINT_PREFIX = "\n\n[otter hint] "
export const HINT_MAX_CHARS = 200

type Rule = { tool: string | null; pattern: RegExp; hint: string }

const RULES: Rule[] = [
  { tool: "write", pattern: /file already exists/i, hint: "Use the edit tool with oldString/newString, or read the file first." },
  {
    tool: "edit",
    pattern: /oldString not found|could not find|not found in (the )?(file|content)|no match(es)? found|did not find/i,
    hint: "Read the file and copy the exact text including whitespace; oldString must be unique.",
  },
  {
    tool: "edit",
    pattern: /multiple (matches|occurrences)|found multiple|more than one match|not unique|appears \d+ times/i,
    hint: "oldString matched more than once; include surrounding lines so it is unique, or set replaceAll.",
  },
  { tool: "bash", pattern: /command not found|not recognized as an internal or external command/i, hint: "Check the tool exists with `which`; do not retry the same command." },
  {
    tool: "read",
    pattern: /file not found|no such file or directory|ENOENT/i,
    hint: "The path does not exist; locate it with glob or list before reading again.",
  },
  {
    tool: null,
    pattern: /JSON parse error|Unexpected token .* in JSON|invalid JSON|JSON\.parse|not valid JSON|Failed to parse (tool )?(arguments|input)/i,
    hint: "Your arguments were not valid JSON; re-send with proper quoting.",
  },
]

/** Returns a hint (≤ 200 chars, without prefix) or null when no failure pattern matches. */
export function recoveryHint(tool: string, args: unknown, output: string): string | null {
  void args
  if (!output) return null
  const probe = output.length > 4000 ? output.slice(0, 4000) : output
  for (const rule of RULES) {
    if (rule.tool !== null && rule.tool !== tool) continue
    if (rule.pattern.test(probe)) return rule.hint.slice(0, HINT_MAX_CHARS)
  }
  return null
}

export function appendHint(output: string, hint: string): string {
  return `${output}${HINT_PREFIX}${hint}`
}
