// RepetitionDetector: word-level n-gram repetition on streaming assistant text. Evidence: 4 runaway generations
// hit the 8,192 output cap (17 min) in the review session. Cheap: re-checks only after ≥ 200 new chars.

export const RECHECK_GROWTH_CHARS = 200
const MAX_PARTS_PER_SESSION = 20

export type RepetitionResult = { repeating: boolean; sample?: string; count?: number }

type PartState = { checkedLength: number; flagged: boolean }

export class RepetitionDetector {
  private readonly ngram: number
  private readonly count: number
  private readonly sessions = new Map<string, Map<string, PartState>>()

  constructor(ngram: number, count: number) {
    this.ngram = Math.max(2, Math.floor(ngram))
    this.count = Math.max(2, Math.floor(count))
  }

  /** `text` is the full accumulated text of the part (as delivered by message.part.updated). */
  feed(sessionID: string, partID: string, text: string): RepetitionResult {
    const parts = this.parts(sessionID)
    let st = parts.get(partID)
    if (!st) {
      st = { checkedLength: 0, flagged: false }
      parts.set(partID, st)
      while (parts.size > MAX_PARTS_PER_SESSION) parts.delete(parts.keys().next().value as string)
    }
    if (st.flagged) return { repeating: true }
    if (text.length - st.checkedLength < RECHECK_GROWTH_CHARS) return { repeating: false }
    st.checkedLength = text.length
    const res = findRepeatedNgram(text, this.ngram, this.count)
    if (res.repeating) st.flagged = true
    return res
  }

  clear(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  private parts(sessionID: string): Map<string, PartState> {
    let m = this.sessions.get(sessionID)
    if (!m) {
      m = new Map()
      this.sessions.set(sessionID, m)
    }
    return m
  }
}

/** Pure check: does any n-word window occur ≥ count times? Windows are counted as non-overlapping-agnostic. */
export function findRepeatedNgram(text: string, ngram: number, count: number): RepetitionResult {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < ngram * count) return { repeating: false }
  const seen = new Map<string, number>()
  for (let i = 0; i + ngram <= words.length; i++) {
    const key = words.slice(i, i + ngram).join(" ")
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    if (n >= count) return { repeating: true, sample: key, count: n }
  }
  return { repeating: false }
}
