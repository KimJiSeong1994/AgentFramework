import { describe, expect, test } from "bun:test"
import { compileSafeRegex, MAX_SAFE_REGEX_CHARS, MAX_SAFE_REGEX_LINE_CHARS } from "../src/hosts/safe-regex.ts"

const matches = (pattern: string, line: string, ignoreCase = false): boolean => {
  const compiled = compileSafeRegex(pattern, ignoreCase)
  if (!compiled) throw new Error(`pattern refused: ${pattern}`)
  return compiled(line)
}

describe("linear-time regex subset", () => {
  test("alternation, grouping, classes, quantifiers, anchors and escapes match as RegExp does", () => {
    const cases: Array<[string, string]> = [
      ["Retry on|failureClass|engine failure", "const failureClass = 1"], ["Retry on|failureClass", "nothing here"],
      ["^export (async )?function \\w+\\(", "export async function run(a) {"], ["^export (async )?function \\w+\\(", "  export function run("],
      ["foo(bar|baz)+$", "xfoobarbaz"], ["foo(bar|baz)+$", "foobarbazq"], ["[A-Z][a-z]+Error\\b", "throw new ConfigError(p)"],
      ["[^a-z0-9_]id\\s*=", "let id = 4"], ["\\bcat\\b", "concat cat"], ["\\bcat\\b", "concatenate"], ["\\Bcat", "concat"],
      ["a.c", "abc"], ["a.c", "a\nc"], ["a\\.c", "abc"], ["a\\.c", "a.c"], ["x*", ""], ["(a|b)*c", "ababc"], ["(?:ab)+?c", "ababc"],
      ["\\d{", "5{"], ["[\\]a]", "]"], ["[]a", "a"], ["[^]b", "ab"], ["[a\\-z]", "-"], ["[\\d.]+px", "12.5px"], ["^$", ""], ["^$", "x"], ["a|", "zzz"],
      ["TODO|FIXME|XXX", "// fixme later"], ["\\(\\)\\s*=>", "run(() => 1)"], ["\\$\\{\\w+\\}", "`${name}`"], ["a??b", "b"],
    ]
    for (const [pattern, line] of cases) {
      expect([pattern, line, matches(pattern, line)]).toEqual([pattern, line, new RegExp(pattern).test(line)])
      expect([pattern, line, matches(pattern, line, true)]).toEqual([pattern, line, new RegExp(pattern, "i").test(line)])
    }
    expect(matches("todo|fixme", "// FIXME later", true)).toBe(true)
    expect(matches("[a-c]+z", "ABCZ", true)).toBe(true)
  })

  test("random patterns from the subset agree with RegExp", () => {
    let seed = 20261124
    const random = (limit: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % limit }
    const atoms = ["a", "b", "c", ".", "\\d", "\\w", "\\s", "[ab]", "[^a]", "[a-c0-9]", "\\b", "^", "$", "\\.", "x"]
    const build = (depth: number): string => {
      let out = ""
      for (let count = 1 + random(3); count > 0; count--) {
        let atom = depth > 0 && random(4) === 0 ? `(${build(depth - 1)})` : atoms[random(atoms.length)]!
        if (random(3) === 0 && !/^(?:\\b|\^|\$)$/u.test(atom)) atom += ["*", "+", "?"][random(3)]
        out += atom
      }
      return depth > 0 && random(3) === 0 ? `${out}|${build(depth - 1)}` : out
    }
    const alphabet = ["a", "b", "c", "x", "1", " ", ".", "_"]
    for (let round = 0; round < 3000; round++) {
      const pattern = build(2)
      let line = ""
      for (let length = random(9); length > 0; length--) line += alphabet[random(alphabet.length)]
      expect([pattern, line, matches(pattern, line)]).toEqual([pattern, line, new RegExp(pattern).test(line)])
    }
  })

  test("patterns that blow up a backtracking engine finish at once", () => {
    const started = performance.now()
    const line = `${"a".repeat(5000)}!`
    for (const pattern of ["(a+)+$", "(a|aa)+$", "(a*)*b", "(a|a)*b", "a*a*a*a*a*a*a*b"]) expect(matches(pattern, line)).toBe(false)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  test("syntax outside the subset, an overlong pattern and malformed patterns are refused", () => {
    for (const pattern of ["(a)\\1", "(?=a)b", "(?!a)b", "(?<=a)b", "(?<name>a)", "a{2,3}", "a{2}", "\\p{L}", "\\x41", "\\u0041", "\\k<n>",
      "(a", "a)", "[a", "*a", "a\\", "[z-a]", "", "a".repeat(MAX_SAFE_REGEX_CHARS + 1)]) {
      expect([pattern, compileSafeRegex(pattern)]).toEqual([pattern, undefined])
    }
    expect(compileSafeRegex("a".repeat(MAX_SAFE_REGEX_CHARS))).toBeDefined()
  })

  test("a very long line is matched on its bounded prefix, and a matcher is reusable", () => {
    const find = compileSafeRegex("needle$")!
    expect(find(`${"x".repeat(MAX_SAFE_REGEX_LINE_CHARS - 6)}needle`)).toBe(true)
    expect(find(`${"x".repeat(MAX_SAFE_REGEX_LINE_CHARS)}needle`)).toBe(false)
    expect(find("a needle")).toBe(true)
    expect(find("needle a")).toBe(false)
  })
})
