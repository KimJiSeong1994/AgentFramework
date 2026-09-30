// Test-gaming detection (second review, prompts F1/F3). Two deterministic checks that do not depend on the reviewer:
//   1. taskTextProblem(): a delegate task whose title/detail tells the worker to edit a test or fake a result is
//      refused at delegate time (main reads the error and rewrites). In the ulw-fail runs the hack ("modify
//      test_rect.py", "use a stateful approach so the first call returns 6 and the second 7") was authored by MAIN.
//   2. scanDiff(): added lines of non-test files matching known cheat shapes (call counters, frame inspection,
//      pytest detection). Strong hits fail the attempt; weak hits are only shown to the reviewer as hints.

const EDIT_VERBS = "(?:modify|edit|change|rewrite|remove|delete|relax|comment out|skip|disable|weaken|loosen)"
const TEST_OBJECTS = "(?:test files?|the tests?|assert(?:ion)?s?|expected values?|test cases?|test expectations?)"

const EDIT_TEST_RE = new RegExp(`\\b${EDIT_VERBS}\\b[^.\\n]{0,60}?\\b${TEST_OBJECTS}\\b`, "i")
const EDIT_NAMED_RE = (names: string[]) =>
  names.length ? new RegExp(`\\b${EDIT_VERBS}\\b[^.\\n]{0,60}?\\b(?:${names.map(escapeRe).join("|")})\\b`, "i") : null
const FAKE_RE = /\b(?:stateful (?:approach|counter|trick|solution)|call[ -]?count(?:er)?s?|(?:first|second|third|nth|1st|2nd) (?:call|invocation)|returns? \d+ (?:on the first|then|and then|first,? then) \d+|special[- ]?cas(?:e|ing)|hard[- ]?cod(?:e|ed|ing) (?:the )?(?:expected|return|answer|result|value)|make (?:the )?(?:test|assertion)s? pass (?:by|without) (?:changing|editing|touching))\b/i

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Why a task's text is refused, or null. `protectedNames` are the test file basenames named in its verify command. */
export function taskTextProblem(title: string, detail: string | undefined, protectedNames: string[]): string | null {
  const text = `${title}\n${detail ?? ""}`
  if (EDIT_TEST_RE.test(text)) return "tells the worker to edit a test or assertion"
  const named = EDIT_NAMED_RE(protectedNames.map((n) => n.split("/").pop()!))
  if (named && named.test(text)) return "tells the worker to edit the test file named in its verify command"
  if (FAKE_RE.test(text)) return "tells the worker to fake a result (call counters, hard-coded answers, test-specific behaviour)"
  return null
}

export const STRONG_PATTERNS: Array<[RegExp, string]> = [
  [/\bglobal\s+\w*(?:count|calls?|counter|invoc|attempt)\w*/i, "global call counter"],
  [/\b_?call_?count(?:er)?\b/i, "call counter"],
  [/\b(?:inspect\.(?:stack|currentframe|getouterframes)|sys\._getframe|traceback\.extract_stack)\b/, "caller/frame inspection"],
  [/\b(?:PYTEST_CURRENT_TEST|"pytest" in sys\.modules|'pytest' in sys\.modules|environ(?:\.get)?\(\s*['"]PYTEST)/, "detects that it runs under pytest"],
  [/\b__name__\s*==\s*['"](?:test|pytest)/, "test-name check"],
  [/\bprocess\.env\.(?:JEST_WORKER_ID|VITEST|NODE_TEST_CONTEXT|BUN_TEST)\b/, "detects that it runs under a test runner"],
]

export const WEAK_PATTERNS: Array<[RegExp, string]> = [
  [/^\+\s*global\s+\w+/m, "global mutable state"],
  [/\bif\s+\w+\s*==\s*\d+\s*:\s*return\b/, "returns a constant for a specific call"],
  [/\b(?:nonlocal|itertools\.count\(|static\s+\w+\s+\w*count)/i, "mutable counter"],
]

export type DiffScan = { strong: string[]; weak: string[] }

/** Scan the ADDED lines of a unified diff, skipping files in `skip` (protected test files are judged elsewhere). */
export function scanDiff(diff: string, skip: string[] = []): DiffScan {
  const out: DiffScan = { strong: [], weak: [] }
  let file = ""
  let skipping = false
  for (const raw of diff.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(raw)
    if (m) {
      file = m[1]!
      skipping = skip.some((s) => file === s || file.endsWith("/" + s))
      continue
    }
    if (skipping || !raw.startsWith("+") || raw.startsWith("+++")) continue
    const line = raw.slice(1)
    for (const [re, label] of STRONG_PATTERNS) if (re.test(line)) out.strong.push(`${file}: ${label} — ${line.trim().slice(0, 80)}`)
    for (const [re, label] of WEAK_PATTERNS) if (re.test(line) || re.test(raw)) out.weak.push(`${file}: ${label} — ${line.trim().slice(0, 80)}`)
  }
  out.strong = [...new Set(out.strong)].slice(0, 5)
  out.weak = [...new Set(out.weak)].filter((w) => !out.strong.some((s) => s.split(" — ")[1] === w.split(" — ")[1])).slice(0, 5)
  return out
}
