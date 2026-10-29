/** Display-only recovery for double-escaped Markdown reports, including mixed line endings.
 * Keep model/history bytes and code examples intact; never decode arbitrary JSON escapes.
 */
export function assistantDisplayText(value: string): string {
  if (/^[\s]*[\[{"`~]/u.test(value)) return value
  // Match entire delimiter runs: a template-literal backtick cannot close a triple fence.
  // An unmatched delimiter protects the remainder rather than guessing at code boundaries.
  const parts: string[] = []
  const delimiters = /`+|~{3,}/gu
  let cursor = 0
  let open: RegExpExecArray | null
  while ((open = delimiters.exec(value))) {
    parts.push(value.slice(cursor, open.index))
    let close: RegExpExecArray | null
    let end = value.length
    while ((close = delimiters.exec(value))) {
      if (close[0] === open[0]) { end = delimiters.lastIndex; break }
    }
    parts.push(value.slice(open.index, end))
    cursor = end
    if (!close) break
  }
  parts.push(value.slice(cursor))
  const prose = parts.filter((_, index) => index % 2 === 0).join("").replace(/(?<!\\)\\r\\n/gu, "\\n")
  // Unquoted Windows paths make literal backslashes ambiguous; leave that answer untouched.
  if (/[A-Za-z]:\\|\\\\[A-Za-z]/u.test(prose)) return value
  if (!prose.includes("\\n\\n") ||
      !/\\n(?:#{1,6} |[-*] |\d+\. |\|)/u.test(prose) ||
      (prose.match(/(?<!\\)\\n/gu)?.length ?? 0) < 3) return value
  const decodeLines = (text: string) => text.replace(/(?<!\\)\\(?:r\\n|n)/gu, "\n")
  return parts.map((part, index) => {
    if (index % 2 === 0) return decodeLines(part)
    // Plain-text tree diagrams carry layout, not string-literal escapes. Other code stays opaque.
    const diagram = /^(`{3,}|~{3,})(?:text|plaintext)\\(?:r\\n|n)([\s\S]*?)\\(?:r\\n|n)\1$/u.exec(part)
    return diagram && /[└├│→]/u.test(diagram[2]!) && !/[A-Za-z]:\\|\\\\[A-Za-z]/u.test(diagram[2]!)
      ? decodeLines(part) : part
  }).join("")
}

/** Escape control and bidirectional-override characters so untrusted text (model output, answers) cannot drive the terminal. */
export function terminalSafeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/g, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`)
}

export function boundedTerminalDiagnostic(value: string, limit = 240): string {
  const safe = terminalSafeText(value).replace(/\s+/gu, " ").trim()
  return safe.length > limit ? `${safe.slice(0, limit - 3)}...` : safe
}
