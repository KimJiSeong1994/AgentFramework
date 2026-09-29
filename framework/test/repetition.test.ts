import { describe, expect, test } from "bun:test"
import { RepetitionDetector, findRepeatedNgram, RECHECK_GROWTH_CHARS } from "../src/guards/repetition.ts"

const phrase = "I will now proceed to read the file and then apply the same change again"
const loop = (n: number) => Array.from({ length: n }, () => phrase).join(" ")

describe("findRepeatedNgram", () => {
  test("flags a 12-gram repeated 4 times", () => {
    const r = findRepeatedNgram(loop(4), 12, 4)
    expect(r.repeating).toBe(true)
    expect(r.sample!.split(" ").length).toBe(12)
  })
  test("does not flag varied text", () => {
    const text = Array.from({ length: 80 }, (_, i) => `sentence number ${i} says something distinct ${i * 7}`).join(" ")
    expect(findRepeatedNgram(text, 12, 4).repeating).toBe(false)
  })
  test("short text is never repeating", () => {
    expect(findRepeatedNgram(loop(3), 12, 4).repeating).toBe(false)
  })
})

describe("RepetitionDetector", () => {
  test("only re-checks after ≥ 200 new chars, then flags and stays flagged", () => {
    const d = new RepetitionDetector(12, 4)
    expect(d.feed("s", "p1", "short").repeating).toBe(false)
    const full = loop(4)
    expect(full.length).toBeGreaterThan(RECHECK_GROWTH_CHARS)
    const r = d.feed("s", "p1", full)
    expect(r.repeating).toBe(true)
    expect(r.sample).toBeDefined()
    expect(d.feed("s", "p1", full + " more").repeating).toBe(true)
  })

  test("growth gate: identical text is not rescanned", () => {
    const d = new RepetitionDetector(3, 2)
    const text = "a b c a b c " + "x".repeat(200)
    expect(d.feed("s", "p", text).repeating).toBe(true)
    const d2 = new RepetitionDetector(3, 2)
    d2.feed("s", "p", "y".repeat(250)) // checked once at 250 chars
    expect(d2.feed("s", "p", "y".repeat(250) + " a b c a b c").repeating).toBe(false) // grew < 200 → skipped
    expect(d2.feed("s", "p", "y".repeat(250) + " a b c a b c " + "z".repeat(200)).repeating).toBe(true)
  })

  test("parts and sessions are independent; clear() forgets a session", () => {
    const d = new RepetitionDetector(12, 4)
    d.feed("s", "p1", loop(4))
    expect(d.feed("s", "p2", "fresh part".repeat(1)).repeating).toBe(false)
    expect(d.feed("t", "p1", "other session").repeating).toBe(false)
    d.clear("s")
    expect(d.feed("s", "p1", "short").repeating).toBe(false)
  })
})
