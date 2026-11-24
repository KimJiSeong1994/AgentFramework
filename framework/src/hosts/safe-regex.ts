// A regular-expression matcher whose running time is linear in the text, for patterns written by a model.
//
// JavaScript's RegExp backtracks: a pattern such as `(a+)+$` takes exponential time on some inputs and cannot be
// interrupted, so a model-supplied pattern handed to RegExp could stall the host. This matcher compiles a common subset
// of the syntax to a nondeterministic automaton and steps every live state once per character (Thompson's
// construction), so a search costs at most (states x characters) however the pattern is written.
//
// Supported: literals, `.`, `|`, `( )` and `(?: )` grouping, `[...]` and `[^...]` classes with ranges, the quantifiers
// `*` `+` `?` (a lazy `?` after one is accepted and has no effect on whether a line matches), the anchors `^` `$`, and
// the escapes `\d \D \w \W \s \S \b \B \t \n \r` plus any escaped punctuation.
// Refused: backreferences, lookaround, named groups, counted repetition `{n,m}` and Unicode property escapes.

export const MAX_SAFE_REGEX_CHARS = 256
/** Characters of a line that are tested; a longer line is matched on this prefix only. */
export const MAX_SAFE_REGEX_LINE_CHARS = 10_000

type CharTest = (code: number) => boolean
type State =
  | { kind: "char"; test: CharTest; out: number }
  | { kind: "split"; out: number; alt: number }
  | { kind: "assert"; check: "start" | "end" | "boundary" | "not-boundary"; out: number }
  | { kind: "match" }
/** A partly built automaton: its entry state and the dangling exits still to be connected. */
type Fragment = { start: number; exits: Array<(target: number) => void> }

const isDigit: CharTest = code => code >= 48 && code <= 57
const isWord: CharTest = code => isDigit(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
const isSpace: CharTest = code => code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0xfeff || code === 0x2028 || code === 0x2029
const not = (test: CharTest): CharTest => code => !test(code)

function foldCase(test: CharTest): CharTest {
  return code => {
    if (test(code)) return true
    const text = String.fromCharCode(code)
    const lower = text.toLowerCase(), upper = text.toUpperCase()
    return (lower.length === 1 && test(lower.charCodeAt(0))) || (upper.length === 1 && test(upper.charCodeAt(0)))
  }
}

class Compiler {
  private position = 0
  readonly states: State[] = []
  constructor(private readonly pattern: string, private readonly ignoreCase: boolean) {}

  compile(): number {
    const fragment = this.alternation()
    if (this.position < this.pattern.length) throw new Error("unbalanced")
    const match = this.add({ kind: "match" })
    for (const exit of fragment.exits) exit(match)
    return fragment.start
  }

  private add(state: State): number { this.states.push(state); return this.states.length - 1 }
  private peek(): string | undefined { return this.pattern[this.position] }

  private char(test: CharTest): Fragment {
    const index = this.add({ kind: "char", test: this.ignoreCase ? foldCase(test) : test, out: -1 })
    return { start: index, exits: [target => { (this.states[index] as { out: number }).out = target }] }
  }

  private empty(): Fragment {
    // A split whose two branches meet again: an epsilon step that keeps fragments uniform.
    const index = this.add({ kind: "split", out: -1, alt: -1 })
    return { start: index, exits: [target => { const state = this.states[index] as { out: number; alt: number }; state.out = target; state.alt = target }] }
  }

  private alternation(): Fragment {
    let left = this.sequence()
    while (this.peek() === "|") {
      this.position++
      const right = this.sequence()
      const split = this.add({ kind: "split", out: left.start, alt: right.start })
      left = { start: split, exits: [...left.exits, ...right.exits] }
    }
    return left
  }

  private sequence(): Fragment {
    let result: Fragment | undefined
    while (this.position < this.pattern.length && this.peek() !== "|" && this.peek() !== ")") {
      const next = this.repeated()
      if (!result) result = next
      else {
        for (const exit of result.exits) exit(next.start)
        result = { start: result.start, exits: next.exits }
      }
    }
    return result ?? this.empty()
  }

  private repeated(): Fragment {
    let fragment = this.atom()
    for (;;) {
      const operator = this.peek()
      if (operator === "{" && /^\{\d+(?:,\d*)?\}/u.test(this.pattern.slice(this.position))) throw new Error("counted repetition")
      if (operator !== "*" && operator !== "+" && operator !== "?") return fragment
      this.position++
      if (this.peek() === "?") this.position++
      const inner = fragment
      if (operator === "?") {
        const split = this.add({ kind: "split", out: inner.start, alt: -1 })
        fragment = { start: split, exits: [...inner.exits, target => { (this.states[split] as { alt: number }).alt = target }] }
      } else {
        const split = this.add({ kind: "split", out: inner.start, alt: -1 })
        for (const exit of inner.exits) exit(split)
        fragment = { start: operator === "*" ? split : inner.start, exits: [target => { (this.states[split] as { alt: number }).alt = target }] }
      }
    }
  }

  private assertion(check: "start" | "end" | "boundary" | "not-boundary"): Fragment {
    const index = this.add({ kind: "assert", check, out: -1 })
    return { start: index, exits: [target => { (this.states[index] as { out: number }).out = target }] }
  }

  private atom(): Fragment {
    const current = this.pattern[this.position++]
    switch (current) {
      case undefined: throw new Error("unexpected end")
      case "(": {
        if (this.peek() === "?") {
          if (this.pattern.slice(this.position, this.position + 2) !== "?:") throw new Error("unsupported group")
          this.position += 2
        }
        const inner = this.alternation()
        if (this.pattern[this.position++] !== ")") throw new Error("unbalanced")
        return inner
      }
      case "[": return this.char(this.characterClass())
      case ".": return this.char(code => code !== 10 && code !== 13)
      case "^": return this.assertion("start")
      case "$": return this.assertion("end")
      case "*": case "+": case "?": throw new Error("nothing to repeat")
      case "\\": {
        const escaped = this.pattern[this.position++]
        if (escaped === "b") return this.assertion("boundary")
        if (escaped === "B") return this.assertion("not-boundary")
        return this.char(this.escape(escaped))
      }
      default: {
        const code = current.charCodeAt(0)
        return this.char(candidate => candidate === code)
      }
    }
  }

  private escape(escaped: string | undefined): CharTest {
    switch (escaped) {
      case undefined: throw new Error("trailing backslash")
      case "d": return isDigit
      case "D": return not(isDigit)
      case "w": return isWord
      case "W": return not(isWord)
      case "s": return isSpace
      case "S": return not(isSpace)
      case "t": return code => code === 9
      case "n": return code => code === 10
      case "r": return code => code === 13
      default: {
        // Letters and digits after a backslash mean something in RegExp (backreference, \p, \k, \x, \u, \c …).
        if (/[A-Za-z0-9]/u.test(escaped)) throw new Error("unsupported escape")
        const code = escaped.charCodeAt(0)
        return candidate => candidate === code
      }
    }
  }

  private characterClass(): CharTest {
    const negated = this.peek() === "^"
    if (negated) this.position++
    const tests: CharTest[] = []
    for (;;) {
      let current = this.pattern[this.position++]
      if (current === undefined) throw new Error("unbalanced class")
      // As in RegExp, a `]` closes the class even when it comes first (`[]` matches nothing, `[^]` anything).
      if (current === "]") break
      let low: number
      if (current === "\\") {
        const escaped = this.pattern[this.position++]
        if (escaped !== undefined && "dDwWsS".includes(escaped)) { tests.push(this.escape(escaped)); continue }
        if (escaped === "b") low = 8
        else if (escaped === "t") low = 9
        else if (escaped === "n") low = 10
        else if (escaped === "r") low = 13
        else if (escaped === undefined || /[A-Za-z0-9]/u.test(escaped)) throw new Error("unsupported escape")
        else low = escaped.charCodeAt(0)
      } else low = current.charCodeAt(0)
      if (this.peek() === "-" && this.pattern[this.position + 1] !== undefined && this.pattern[this.position + 1] !== "]") {
        this.position++
        current = this.pattern[this.position++]!
        let high: number
        if (current === "\\") {
          const escaped = this.pattern[this.position++]
          if (escaped === undefined || /[A-Za-z0-9]/u.test(escaped)) throw new Error("unsupported escape")
          high = escaped.charCodeAt(0)
        } else high = current.charCodeAt(0)
        if (high < low) throw new Error("range out of order")
        tests.push(code => code >= low && code <= high)
      } else tests.push(code => code === low)
    }
    const any: CharTest = code => tests.some(test => test(code))
    return negated ? not(any) : any
  }
}

/**
 * Compiles `pattern` to a line matcher (true when the pattern occurs anywhere in the line), or returns undefined when
 * the pattern is too long, malformed or uses syntax outside the supported subset.
 */
export function compileSafeRegex(pattern: string, ignoreCase = false): ((line: string) => boolean) | undefined {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_SAFE_REGEX_CHARS) return undefined
  let states: State[]
  let start: number
  try {
    const compiler = new Compiler(pattern, ignoreCase)
    start = compiler.compile()
    states = compiler.states
  } catch { return undefined }
  const count = states.length
  // Generation stamps mark the states already added at the current position, so each is followed once per character.
  const seen = new Int32Array(count)
  let generation = 0
  let current: number[] = []
  let next: number[] = []
  const stack: number[] = []

  return (input: string): boolean => {
    const line = input.length > MAX_SAFE_REGEX_LINE_CHARS ? input.slice(0, MAX_SAFE_REGEX_LINE_CHARS) : input
    const length = line.length
    // The cut is not the end of the line, so `$` does not hold there.
    const truncated = input.length > length
    const wordAt = (index: number): boolean => index >= 0 && index < length && isWord(line.charCodeAt(index))
    /** Adds a state and everything reachable from it without consuming a character; true when that includes the match state. */
    const add = (list: number[], from: number, position: number): boolean => {
      stack.length = 0
      stack.push(from)
      while (stack.length) {
        const index = stack.pop()!
        if (seen[index] === generation) continue
        seen[index] = generation
        const state = states[index]!
        if (state.kind === "match") return true
        if (state.kind === "char") list.push(index)
        else if (state.kind === "split") { stack.push(state.alt); stack.push(state.out) }
        else {
          const holds = state.check === "start" ? position === 0
            : state.check === "end" ? position === length && !truncated
            : (wordAt(position - 1) !== wordAt(position)) === (state.check === "boundary")
          if (holds) stack.push(state.out)
        }
      }
      return false
    }
    current.length = 0
    for (let position = 0; position <= length; position++) {
      if (generation === 0x7fffffff) { seen.fill(0); generation = 0 }
      generation++
      // The pattern may start at any position, so the start state joins the live set at each one. The carried-over
      // states were stamped at the previous position; they are char states and need no closure of their own.
      for (const index of current) seen[index] = generation
      if (add(current, start, position)) return true
      if (position === length) return false
      const code = line.charCodeAt(position)
      next.length = 0
      generation++
      for (const index of current) {
        const state = states[index] as { test: CharTest; out: number }
        // Assertions on the way out are evaluated at the position after this character.
        if (state.test(code) && add(next, state.out, position + 1)) return true
      }
      const swap = current; current = next; next = swap
    }
    return false
  }
}
