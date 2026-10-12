export type InputPresentation = { columns?: number; color?: boolean }

export function inputColorSupported(tty: boolean, env: { NO_COLOR?: string; TERM?: string }): boolean {
  return tty && env.NO_COLOR === undefined && !!env.TERM && env.TERM !== "dumb"
}

// Match the host's visible control escaping, including line breaks for single-line labels.
function safeLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/gu,
    character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`)
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function inputLine(value: string, presentation: InputPresentation = {}): string {
  const columns = Number.isFinite(presentation.columns) ? Math.max(1, Math.floor(presentation.columns!)) : 80
  const safe = safeLabel(value)
  if (Bun.stringWidth(safe) <= columns) return safe
  let result = ""
  let width = 0
  for (const { segment } of graphemes.segment(safe)) {
    const next = Bun.stringWidth(segment)
    if (width + next > columns - 1) break
    result += segment
    width += next
  }
  return `${result}…`
}

export function renderInput(
  title: string,
  hint: string,
  prompt: string,
  presentation: InputPresentation = {},
): { chrome: string; prompt: string } {
  const accent = (text: string) => presentation.color ? `\x1b[36m${text}\x1b[0m` : text
  const dim = (text: string) => presentation.color ? `\x1b[2m${text}\x1b[0m` : text
  // Keep the recognizable marker intact even on terminals narrower than the marker.
  const marker = inputLine(prompt, presentation) === prompt ? prompt : `${prompt.split(" ")[0]!.replace(/[:>]$/, "")}> `
  return {
    chrome: `\n${accent(inputLine(`── ${title}`, presentation))}\n${dim(inputLine(hint, presentation))}\n`,
    prompt: accent(marker),
  }
}
