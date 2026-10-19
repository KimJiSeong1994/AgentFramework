// Deterministic lexical prefilter for the skill selector: rank candidate skills by BM25 over name + description so a
// catalog larger than the inference prompt can hold is narrowed before one OpenJev choice call. It only ranks; the
// choice (including `none`) stays with inference. No model, no I/O.

export type RankedSkill = Readonly<{ name: string; description: string }>

export const PREFILTER_LIMIT = 8
const K1 = 1.2
const B = 0.75

/** Lowercase Latin/digit words (length >= 2) plus Hangul character bigrams (single syllables when isolated). */
export function lexicalTokens(text: string): string[] {
  const tokens: string[] = []
  for (const word of text.toLowerCase().match(/[a-z0-9]+|[\p{Script=Hangul}]+/gu) ?? []) {
    if (/^[a-z0-9]+$/u.test(word)) {
      if (word.length >= 2) tokens.push(word)
      for (const part of word.split(/(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/u)) if (part !== word && part.length >= 2) tokens.push(part)
      continue
    }
    const chars = [...word]
    if (chars.length === 1) tokens.push(word)
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i]! + chars[i + 1]!)
  }
  return tokens
}

function documentTokens(skill: RankedSkill): string[] {
  // A name like `llm-wiki` contributes `llm`, `wiki` and the joined `llmwiki`.
  const name = skill.name.split(/[-_]/u)
  return [...lexicalTokens(name.join(" ")), ...lexicalTokens(name.join("")), ...lexicalTokens(skill.description)]
}

/**
 * At most `limit` candidates, best BM25 score first (ties by name). A catalog within the limit is returned unchanged in
 * name order. When nothing in a larger catalog matches the request lexically, the first `limit` by name are returned
 * so a cross-language request still reaches inference, which can answer `none`.
 */
export function prefilterSkills<T extends RankedSkill>(request: string, skills: readonly T[], limit = PREFILTER_LIMIT): T[] {
  const ordered = [...skills].sort((a, b) => a.name.localeCompare(b.name, "en"))
  if (ordered.length <= limit) return ordered
  const query = [...new Set(lexicalTokens(request))]
  const docs = ordered.map(documentTokens)
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1
  const frequency = new Map<string, number>()
  for (const doc of docs) for (const token of new Set(doc)) frequency.set(token, (frequency.get(token) ?? 0) + 1)
  const scored = ordered.map((skill, index) => {
    const doc = docs[index]!
    const counts = new Map<string, number>()
    for (const token of doc) counts.set(token, (counts.get(token) ?? 0) + 1)
    let score = 0
    for (const token of query) {
      const tf = counts.get(token)
      if (!tf) continue
      const df = frequency.get(token)!
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
      score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * doc.length / average))
    }
    return { skill, score, index }
  })
  if (!scored.some(entry => entry.score > 0)) return ordered.slice(0, limit)
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(entry => entry.skill)
}
