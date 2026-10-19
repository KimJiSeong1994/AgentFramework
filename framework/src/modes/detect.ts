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
    { label: "stop otter", source: L("stop\\s+otter") },
    { label: "cancel otter", source: L("cancel\\s+otter") },
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

// ---------------------------------------------------------------------------------------------------------------------
// CLI chat intent (otter-intent-v1). Pure, deterministic, no model call. It only *proposes* a route: the interactive
// session turns "ambiguous"/"architecture" into an offer the user answers, and "question" into an answer-only turn.
// Unlike detectMode it has no `!` override (that is the CLI shell escape); only `force:` skips the offers.
// ---------------------------------------------------------------------------------------------------------------------

export const INTENT_CLASSIFIER = "otter-intent-v1"

export type IntentClass = "explicit" | "question" | "implement" | "ambiguous" | "architecture"

export type IntentClassification = {
  class: IntentClass
  /** Auditable reasons for the class, recorded in the transcript; never parsed back. */
  signals: string[]
  /** `force:` prefix present: offers are skipped, the class is still recorded. */
  force: boolean
  /** The text to send: the message without the `force:` prefix. */
  body: string
}

const INTENT_FORCE_PREFIX = /^\s*force\s*:\s*/i

/** `force:` asks to send the line as-is: no intent offer and no automatic skill. */
export function hasIntentForcePrefix(text: string): boolean {
  return INTENT_FORCE_PREFIX.test(unwrapWholeQuote((text ?? "").replace(/\r\n?/g, "\n")))
}
const DETAILED_WORDS = 15

const EN_VERBS = [
  "fix", "add", "implement", "create", "build", "write", "make", "change", "update", "remove", "delete", "refactor",
  "rename", "move", "migrate", "rewrite", "redesign", "replace", "improve", "optimi[sz]e", "clean(?:\\s*up)?", "support",
  "enable", "disable", "install", "configure", "set\\s*up", "extract", "split", "merge", "convert", "port", "integrate",
  "debug", "resolve", "handle", "adjust", "tweak", "upgrade", "wire", "hook", "bump", "revert", "patch", "generate",
].join("|")
const EN_IMPERATIVE = compile(
  `^(?:(?:hey|ok|okay|so)[,\\s]+)?(?:please[,\\s]+)?(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?(?:${EN_VERBS})(?![A-Za-z0-9_])`,
)
const KO_STEMS = "구현|수정|추가|삭제|개선|변경|작성|리팩터링|리팩토링|정리|최적화|생성|제거|적용|설정|통합|이동|교체|마이그레이션|재설계|분리|고치|만들|바꾸|지우|옮기"
const KO_IMPERATIVE = compile(
  `(?:(?:${KO_STEMS})(?:해\\s*줘|해\\s*주세요|해\\s*주라|해라|하세요|해줄래|해봐|하자|해\\s*주실|해줘요)|(?:고쳐|만들어|바꿔|지워|옮겨|써)\\s*(?:줘|주세요|라|봐)|(?:고쳐|만들어|바꿔|지워|옮겨)(?![\\p{L}]))`,
)
const EN_QUESTION_HEAD = compile(
  "^(?:(?:hey|ok|okay|so)[,\\s]+)?(?:what|what's|whats|how|why|when|where|which|who|whose|is|are|was|were|does|do|did|can|could|would|should|explain|describe|define|tell\\s+me|show\\s+me\\s+how|compare|difference)(?![A-Za-z0-9_])",
)
const KO_QUESTION = compile("뭐|무엇|왜|어떻게|어떤|어디|언제|누가|설명|알려|차이|뜻|의미|궁금|인가요|인가\\?|나요|까요|일까|인지|맞나|맞아")
const ARCHITECTURE: Array<{ label: string; re: RegExp }> = [
  { label: "refactor", re: compile(`${L("re-?factor(?:ing|s|ed)?")}`) },
  { label: "migrate", re: compile(`${L("migrat(?:e|es|ed|ing|ion|ions)")}`) },
  { label: "redesign", re: compile(`${L("re-?design(?:ing|s|ed)?")}`) },
  { label: "re-architect", re: compile(`${L("re-?architect(?:ing|s|ed|ure)?")}`) },
  { label: "architecture", re: compile(`${L("architecture")}`) },
  { label: "overhaul", re: compile(`${L("overhaul(?:ing|s|ed)?")}`) },
  { label: "rewrite-whole", re: compile("\\brewrite\\s+(?:the\\s+)?(?:whole|entire|all)\\b") },
  { label: "multi-module", re: compile("\\b(?:multiple|several|many|across|all)\\s+(?:modules|packages|services|components)\\b") },
  { label: "ralplan", re: compile(`${L("ralplan")}`) },
  { label: "plan-first", re: compile("\\b(?:plan\\s+first|plan\\s+(?:this|it)\\s+first|plan\\s+mode)\\b") },
  { label: "아키텍처", re: compile(K("아키텍처")) },
  { label: "마이그레이션", re: compile(K("마이그레이션")) },
  { label: "리팩터링", re: compile(K("리팩(?:터|토)링")) },
  { label: "재설계", re: compile(K("재설계")) },
  { label: "여러 모듈", re: compile(K("(?:여러|다수의?|모든)\\s*(?:모듈|패키지|서비스|컴포넌트)")) },
  { label: "계획부터", re: compile(K("계획\\s*(?:부터|먼저|모드)")) },
]
const UNCERTAIN = [
  { label: "uncertain", re: compile("\\b(?:maybe|perhaps|somehow|something|not\\s+sure|no\\s+idea|better|nicer|cleaner|improve|improvement|whatever|anything)\\b") },
  { label: "uncertain", re: compile("뭔가|어떻게든|알아서|좀\\s|개선|더\\s*좋|나아지|잘\\s*되게|적당히") },
]
// A concrete thing to act on: a path, a file name, inline code, an identifier, an error, a test, a line or issue ref.
const ANCHORS: Array<{ label: string; re: RegExp }> = [
  { label: "path", re: /(?:^|[\s("'`[])(?:\.{0,2}\/|~\/)?[\w@.-]+(?:\/[\w@.-]+)+(?:\.[A-Za-z0-9]{1,8})?(?=$|[\s)"'`\],;:.!?])/ },
  { label: "file", re: /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|md|json|jsonc|ya?ml|toml|sh|c|cc|cpp|h|hpp|css|html|sql|rb|swift)\b/ },
  { label: "code", re: /`[^`\n]+`|```/ },
  { label: "identifier", re: /\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b|\b[a-z0-9]+_[a-z0-9_]+\b|\b[A-Za-z_]\w*\(\)/ },
  { label: "error", re: /\b(?:[A-Z][A-Za-z]*(?:Error|Exception)|E[A-Z]{3,}|segfault|traceback|stack\s*trace|exit\s+code\s+\d+|status\s+\d{3})\b/ },
  { label: "test", re: /\b(?:bun|npm|yarn|pnpm|pytest|cargo|go)\s+test\b|\.test\.|\btests?\/|\bpytest\b/ },
  { label: "ref", re: /(?:^|\s)#\d+\b|:\d+(?::\d+)?\b/ },
]

function wordCount(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length
}

/**
 * Classify one CLI chat line. Slash commands are `explicit` and never reach the offers. Everything that carries no
 * ambiguity signal falls to `implement`, i.e. today's behavior (a planning conversation).
 */
export function classifyIntent(text: string): IntentClassification {
  const raw = (text ?? "").replace(/\r\n?/g, "\n")
  const signals: string[] = []
  const stripped = unwrapWholeQuote(raw)
  const force = INTENT_FORCE_PREFIX.test(stripped)
  const body = (force ? stripped.replace(INTENT_FORCE_PREFIX, "") : raw).trim()
  const result = (cls: IntentClass): IntentClassification => ({ class: cls, signals: force ? ["force", ...signals] : signals, force, body })

  if (body.startsWith("/")) { signals.push("slash-command"); return result("explicit") }
  // A multi-line quoted block is a pasted citation: nothing in it is a request, so no offer is made for its words.
  if (isWholeQuoteCitation(body)) { signals.push("quoted-citation"); return result("implement") }

  const clean = sanitizeForDetection(unwrapWholeQuote(body)).trim()
  const first = clean.split(/(?<=[.!?。！？])\s|\n/u)[0] ?? clean
  const imperative = EN_IMPERATIVE.test(first) || KO_IMPERATIVE.test(clean)
  const questionHead = EN_QUESTION_HEAD.test(first) || (!/[A-Za-z]{3}/.test(first.slice(0, 12)) && KO_QUESTION.test(clean))
  const questionMark = /[?？]\s*$/u.test(clean)
  if (imperative) signals.push("imperative")

  if (!imperative && (questionHead || questionMark || KO_QUESTION.test(clean))) {
    signals.push(questionHead ? "question-head" : questionMark ? "question-mark" : "question-word")
    return result("question")
  }

  const architecture = ARCHITECTURE.find(({ re }) => re.test(clean))
  if (architecture) { signals.push(`architecture:${architecture.label}`); return result("architecture") }

  const anchor = ANCHORS.find(({ re }) => re.test(body))
  if (anchor) { signals.push(`anchor:${anchor.label}`); return result("implement") }

  const uncertain = UNCERTAIN.find(({ re }) => re.test(clean))
  if (uncertain) signals.push(uncertain.label)
  if (imperative || uncertain) {
    if (imperative && !uncertain && wordCount(clean) >= DETAILED_WORDS) { signals.push("detailed"); return result("implement") }
    signals.push("no-anchor")
    return result("ambiguous")
  }
  signals.push("no-ambiguity-signal")
  return result("implement")
}
