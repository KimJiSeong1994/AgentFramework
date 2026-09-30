// Token estimation for prefix-budget checks. No tokenizer dependency: this must stay cheap and
// run at config time. Calibrated for Gemma-family (SentencePiece, 262K vocab) tokenizers.
//
// Heuristic (per character class, chars-per-token):
//   ASCII letters / digits / spaces ......... 4.0   (typical English prose)
//   ASCII punctuation / symbols ............. 2.0   (`{}()=>;` etc. mostly become their own token,
//                                                   which is what makes code denser than prose)
//   CJK / Hangul / kana ..................... 1.3   (Korean syllables ~0.75 token each on Gemma)
//   other non-ASCII (accents, emoji, ...) ... 2.0
//   newlines ................................ 1 token each (Gemma keeps "\n" as a separate piece)
// Result is rounded up. Expected error is within +-15% against the real tokenizer on mixed
// prose/code; the framework budgets leave more headroom than that.

const CJK_RANGES: Array<[number, number]> = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x3040, 0x30ff], // Hiragana, Katakana
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7af], // Hangul Syllables
  [0xd7b0, 0xd7ff], // Hangul Jamo Extended-B
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
  [0x20000, 0x2ffff], // CJK Extension B..F
]

function isCjk(cp: number): boolean {
  for (const [lo, hi] of CJK_RANGES) if (cp >= lo && cp <= hi) return true
  return false
}

function isAsciiWordOrSpace(cp: number): boolean {
  return (
    cp === 0x20 ||
    cp === 0x09 ||
    (cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a)
  )
}

/** Estimate token count of `text` for a Gemma-like tokenizer. Returns 0 for empty input. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let word = 0 // ascii letters/digits/spaces
  let punct = 0 // ascii punctuation/symbols
  let cjk = 0
  let other = 0
  let newline = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    if (cp === 0x0a) newline++
    else if (cp === 0x0d) continue
    else if (cp < 0x80) {
      if (isAsciiWordOrSpace(cp)) word++
      else punct++
    } else if (isCjk(cp)) cjk++
    else other++
  }
  const est = word / 4 + punct / 2 + cjk / 1.3 + other / 2 + newline
  return Math.ceil(est)
}

/**
 * Estimate the prefix cost of one tool schema as the model sees it: description + JSON-serialised
 * parameters, plus a fixed wrapper overhead (name, "type":"function", quoting).
 */
export function estimateToolSchemaTokens(description: string, parameters: unknown): number {
  const WRAPPER_OVERHEAD = 12
  let json = ""
  try {
    json = JSON.stringify(parameters) ?? ""
  } catch {
    json = String(parameters)
  }
  return estimateTokens(description) + estimateTokens(json) + WRAPPER_OVERHEAD
}
