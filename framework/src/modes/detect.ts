// Mode keyword detection on sanitized user text. Priority: cancel > ulw > plan.
// Informational questions about a keyword ("what is ultrawork", "ulw가 뭐야") are suppressed unless the
// message is prefixed with `force:` or `!`. Slash commands other than /stop are ignored.
import type { Mode } from "../config.ts"
import { sanitizeForDetection } from "./sanitize.ts"

export type Detection =
  | { mode: Mode; keyword: string; force: boolean }
  | { mode: "none"; cancel: true }
  | null

type Kind = "cancel" | "ulw" | "plan" | "data"

// Latin keywords: bounded by non-[A-Za-z0-9_] so Korean particles may follow ("ulw로", "ulw가").
const L = (s: string) => `(?<![A-Za-z0-9_])${s}(?![A-Za-z0-9_])`
// Korean keywords: not glued to a preceding letter; particles may follow unless a suffix set is given.
const K = (s: string, allowedTail?: string) =>
  `(?<![\\p{L}\\p{N}_])${s}${allowedTail ? `(?=${allowedTail})` : ""}`
const TAIL_END = "\\s|$|[!.,?~]"

const KEYWORDS: Record<Kind, Array<{ label: string; source: string }>> = {
  cancel: [
    { label: "/stop", source: "(?<![A-Za-z0-9_/])/stop(?![A-Za-z0-9_])" },
    { label: "stop lca", source: L("stop\\s+lca") },
    { label: "cancel lca", source: L("cancel\\s+lca") },
    { label: "중단", source: K("중단", `${TAIL_END}|해|하|시|되|돼|을|이`) },
    { label: "그만", source: K("그만", `${TAIL_END}|해|하|둬|두`) },
  ],
  ulw: [
    { label: "ultrawork", source: L("ultrawork") },
    { label: "ulw", source: L("ulw") },
    { label: "울트라워크", source: K("울트라워크") },
    // "끝까지" alone is ordinary Korean ("파일 끝까지 읽어줘"); require a do/finish verb right after it
    { label: "끝까지", source: K("끝까지", "\\s*(해|하|끝내|진행|밀어|가\\b|완료|구현|작업|처리|고쳐|고치|수정|만들|마무리)") },
    { label: "멈추지 말고", source: K("멈추지\\s*말고") },
  ],
  data: [
    { label: "data mode", source: L("data\\s+mode") },
    { label: "데이터 모드", source: K("데이터\\s*모드") },
    { label: "질의 모드", source: K("질의\\s*모드") },
    { label: "db 질의", source: K("db\\s*질의") },
  ],
  plan: [
    { label: "ralplan", source: L("ralplan") },
    { label: "hyperplan", source: L("hyperplan") },
    { label: "plan mode", source: L("plan\\s+mode") },
    { label: "계획부터", source: K("계획부터") },
    { label: "계획 모드", source: K("계획\\s*모드") },
  ],
}

const ORDER: Kind[] = ["cancel", "ulw", "plan", "data"]
const FORCE_PREFIX = /^\s*(?:force\s*:|!)\s*/i

function compile(source: string, flags = "iu"): RegExp {
  return new RegExp(source, flags)
}

/** Split into sentences; Korean sentences often end without punctuation, so newlines split too. */
function sentenceAround(text: string, index: number): string {
  const boundary = /[.!?。！？\n]/g
  let start = 0
  let end = text.length
  let m: RegExpExecArray | null
  while ((m = boundary.exec(text))) {
    if (m.index < index) start = m.index + 1
    else {
      end = m.index + 1
      break
    }
  }
  return text.slice(start, end)
}

/** Question-about-the-keyword patterns (OMC "informational intent"), evaluated on the sentence. */
function isInformational(sentence: string, kwSource: string): boolean {
  const kw = kwSource
  const patterns = [
    // what is/are/does X ... | what's X | whats X
    `\\b(?:what|what's|whats|which)\\s+(?:is|are|does|do|was|were)?\\b[^.?!]*?${kw}`,
    // how do I use X | how does X work | how to X
    `\\bhow\\s+(?:do|does|to|can|should|is|are|would)\\b[^.?!]*?${kw}`,
    // explain/describe/define/tell me about/meaning of X
    `\\b(?:explain|describe|define|definition\\s+of|meaning\\s+of|tell\\s+me\\s+about|do\\s+you\\s+know|know\\s+about|difference\\s+between)\\b[^.?!]*?${kw}`,
    // X mean(s)? | is X a ...?
    `${kw}\\s+(?:mean|means|meaning|do|does)\\b`,
    `\\b(?:is|are|does)\\s+${kw}\\b[^.?!]*\\?`,
    // Korean: X란 | X이란 | X라는 게
    `${kw}\\s*(?:이란|란|이라는\\s*게|라는\\s*게|이라는\\s*건|라는\\s*건)(?=\\s|$|[?.!,])`,
    // Korean: X(가|이|은|는|을|를|의)? 뭐야 / 무엇 / 설명 / 뜻 / 의미 / 사용법 / 어떻게 써
    `${kw}\\s*(?:가|이|은|는|을|를|의|이라|라)?\\s*(?:뭐|무엇|무슨|어떤|설명|의미|뜻|정의|사용법|쓰는\\s*법|어떻게\\s*(?:써|사용|쓰))`,
    // Korean question head before keyword: 뭐가 X / 무엇이 X
    `(?:뭐가|무엇이)\\s*${kw}`,
  ]
  return patterns.some((p) => compile(p).test(sentence))
}

/**
 * A message that is entirely wrapped in one pair of quotes is not a citation: `opencode run "ulw: ..."` delivers the
 * text with the shell's double quotes kept (seen 2026-09-22, opencode 1.18.32), and the sanitizer would otherwise
 * drop the whole message as quoted text. Unwrap one level, only when the quotes match and enclose everything.
 */
export function unwrapWholeQuote(text: string): string {
  const t = text.trim()
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ["“", "”"], ["„", "“"], ["‘", "’"]]
  for (const [open, close] of pairs) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) {
      const inner = t.slice(open.length, t.length - close.length)
      // the closing quote must not be matched by an earlier one (e.g. "a" and "b"); a multi-line quote is a citation
      if (open === close && inner.includes(open)) continue
      if (inner.includes("\n")) continue
      return inner.trim()
    }
  }
  return t
}

/** A multi-line message wrapped entirely in one pair of quotes is a pasted citation: nothing in it is a request. */
export function isWholeQuoteCitation(text: string): boolean {
  const t = text.trim()
  if (!t.includes("\n")) return false
  for (const [open, close] of [['"', '"'], ["'", "'"], ["“", "”"], ["„", "“"], ["‘", "’"]] as Array<[string, string]>) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) return true
  }
  return false
}

export function detectMode(text: string): Detection {
  if (!text) return null
  const raw = text.replace(/\r\n?/g, "\n")
  if (isWholeQuoteCitation(raw)) return null
  const trimmed = unwrapWholeQuote(raw)
  if (trimmed.startsWith("/")) {
    return /^\/stop(?![A-Za-z0-9_])/i.test(trimmed) ? { mode: "none", cancel: true } : null
  }
  const force = FORCE_PREFIX.test(trimmed)
  const body = force ? trimmed.replace(FORCE_PREFIX, "") : trimmed
  // Activation uses strict markup hiding (pasted data must never start a mode); cancel uses lenient hiding so a
  // stop written after `List<String>` or `a<b` is still honored. Stopping is always the safe direction.
  const strict = sanitizeForDetection(body)
  const lenient = sanitizeForDetection(body, { lenientMarkup: true })
  if (!strict && !lenient) return null

  for (const kind of ORDER) {
    const clean = kind === "cancel" ? lenient : strict
    if (!clean) continue
    for (const { label, source } of KEYWORDS[kind]) {
      const re = compile(source, "giu")
      let m: RegExpExecArray | null
      while ((m = re.exec(clean))) {
        if (!force && isInformational(sentenceAround(clean, m.index), source)) continue
        if (kind === "cancel") return { mode: "none", cancel: true }
        return { mode: kind, keyword: label, force }
      }
    }
  }
  return null
}

/** Remove every mode keyword token from raw text. For logging only; never applied to the user's message. */
export function stripModeKeywords(text: string): string {
  let out = text
  for (const kind of ORDER) {
    for (const { source } of KEYWORDS[kind]) out = out.replace(compile(source, "giu"), "")
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/gm, "").trim()
}
