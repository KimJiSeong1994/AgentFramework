/** Escape control and bidirectional-override characters so untrusted text (model output, answers) cannot drive the terminal. */
export function terminalSafeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/g, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`)
}

export function boundedTerminalDiagnostic(value: string, limit = 240): string {
  const safe = terminalSafeText(value).replace(/\s+/gu, " ").trim()
  return safe.length > limit ? `${safe.slice(0, limit - 3)}...` : safe
}
