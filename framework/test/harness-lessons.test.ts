// Fake-run tests of the code admission gate: not live-model proof.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.ts"
import type { ProbeRun } from "../src/harness/types.ts"
import { admitLesson, appendLesson, classifyRows, LESSON_LIMITS, lessonsPath, parseReflection, readLessons, renderLessonsReference } from "../src/harness/lessons.ts"
import { createExecutionPolicy } from "../src/hosts/tool-policy.ts"
import { EXECUTION_ROLES } from "../src/hosts/types.ts"
import { PROBE_REFLECT_PROMPT } from "../src/workflows/prompts/probe-reflect.ts"

let wt: string
let stateHome: string
const prevState = process.env.OTTER_STATE_HOME
beforeEach(() => { wt = realpathSync(mkdtempSync(join(tmpdir(), "otter-les-"))); stateHome = realpathSync(mkdtempSync(join(tmpdir(), "otter-les-state-"))); process.env.OTTER_STATE_HOME = stateHome })
afterEach(() => {
  rmSync(wt, { recursive: true, force: true }); rmSync(stateHome, { recursive: true, force: true })
  if (prevState === undefined) delete process.env.OTTER_STATE_HOME; else process.env.OTTER_STATE_HOME = prevState
})

const POLICY = { worker: "otter:worker:abc" }
function run(label: string, overlay: ProbeRun["overlay"], ok: boolean | "unsettled", extra: Partial<ProbeRun> = {}): ProbeRun {
  return {
    schema: "otter.probe-run.v1", probeWid: "w1", label, overlay, overlaySha: overlay === "none" ? null : "a".repeat(64),
    policyIDs: POLICY, baseTree: "tree0", resultTree: "tree1",
    verify: ok === "unsettled" ? null : { ok, exitCode: ok ? 0 : 1, timedOut: false, outputTail: "" },
    diffStat: "", durationMs: 1, valid: ok !== "unsettled", ...(ok === "unsettled" ? { invalid: "unsettled" as const } : {}), ...extra,
  }
}
const verdicts = (runs: ProbeRun[]) => Object.fromEntries(classifyRows(runs).map((r) => [r.label, r.verdict]))

test("truth table: clean contrast with two consistent bases", () => {
  const failBases = [run("base1", "none", false), run("base2", "none", false)]
  expect(verdicts([...failBases, run("inv", "inv", true), run("dom", "dom", false)])).toEqual({ inv: "helped", dom: "no_effect" })
  const passBases = [run("base1", "none", true), run("base2", "none", true)]
  expect(verdicts([...passBases, run("inv", "inv", false), run("dom", "dom", true)])).toEqual({ inv: "hurt", dom: "no_effect" })
})

test("single base is confounded, never helped", () => {
  expect(verdicts([run("base1", "none", false), run("inv", "inv", true)])).toEqual({ inv: "confounded" })
})

test("inconsistent bases are confounded", () => {
  expect(verdicts([run("base1", "none", false), run("base2", "none", true), run("inv", "inv", true)])).toEqual({ inv: "confounded" })
})

test("an invalid/unsettled base or variant is confounded", () => {
  expect(verdicts([run("base1", "none", false), run("base2", "none", "unsettled"), run("inv", "inv", true)])).toEqual({ inv: "confounded" })
  expect(verdicts([run("base1", "none", false), run("base2", "none", false), run("inv", "inv", "unsettled")])).toEqual({ inv: "confounded" })
})

test("a variant that differs by both overlays or mismatches its label is confounded", () => {
  const bases = [run("base1", "none", false), run("base2", "none", false)]
  expect(verdicts([...bases, run("inv", "dom" as ProbeRun["overlay"], true)])).toEqual({ inv: "confounded" })
  expect(verdicts([...bases, run("invdom", "inv", true)])).toEqual({ invdom: "confounded" })
  expect(verdicts([...bases, run("inv", "inv", true, { policyIDs: { worker: "otter:worker:other" } })])).toEqual({ inv: "confounded" })
  expect(verdicts([...bases, run("inv", "inv", true, { baseTree: "tree9" })])).toEqual({ inv: "confounded" })
})

test("timeout is a distinct outcome and cannot be a helped pass", () => {
  const bases = [run("base1", "none", false), run("base2", "none", false)]
  const timeout = run("inv", "inv", false, { verify: { ok: false, exitCode: null, timedOut: true, outputTail: "" } })
  expect(verdicts([...bases, timeout])).toEqual({ inv: "confounded" })
})

const cleanRuns = () => [run("base1", "none", false), run("base2", "none", false), run("inv", "inv", true), run("dom", "dom", false)]
const cand = { cue: "when a task fails verify on the first pass", lesson: "overlay.inv should name the failing check first", component: "overlay.inv" as const, evidence: ["inv"] }

test("admission requires every cited row to be helped/hurt of the same component", () => {
  const rows = classifyRows(cleanRuns())
  const ok = admitLesson(rows, cand)
  expect(ok.ok).toBe(true)
  if (ok.ok) expect(ok.lesson.evidence).toEqual([{ label: "inv", runSha256: rows.find((r) => r.label === "inv")!.runSha256 }])
  expect(admitLesson(rows, { ...cand, evidence: ["dom"] }).ok).toBe(false) // no_effect
  expect(admitLesson(rows, { ...cand, evidence: ["inv", "dom"] }).ok).toBe(false)
  expect(admitLesson(rows, { ...cand, evidence: ["ghost"] }).ok).toBe(false)
  expect(admitLesson(rows, { ...cand, evidence: [] }).ok).toBe(false)
  expect(admitLesson(rows, { ...cand, component: "overlay.dom" }).ok).toBe(false)
  const confounded = classifyRows([run("base1", "none", false), run("inv", "inv", true)])
  expect(admitLesson(confounded, cand).ok).toBe(false)
})

test("admission refuses secrets, absolute paths and oversize text", () => {
  const rows = classifyRows(cleanRuns())
  expect(admitLesson(rows, { ...cand, lesson: "use token=abcdefghijklmnop for it" }).ok).toBe(false)
  expect(admitLesson(rows, { ...cand, cue: "see /Users/someone/project/file" }).ok).toBe(false)
  expect(admitLesson(rows, { ...cand, lesson: "x".repeat(LESSON_LIMITS.lessonChars + 1) }).ok).toBe(false)
})

test("append is idempotent, bounded and refuses a non-admission", () => {
  const rows = classifyRows(cleanRuns())
  const admission = admitLesson(rows, cand)
  const first = appendLesson(wt, { probeWid: "w1", subjectSha: "b".repeat(64), admission, now: new Date("2026-01-01T00:00:00Z") })
  const again = appendLesson(wt, { probeWid: "w1", subjectSha: "b".repeat(64), admission, now: new Date("2026-02-02T00:00:00Z") })
  expect(first.appended).toBe(true)
  expect(again.appended).toBe(false)
  expect(again.lesson.id).toBe(first.lesson.id)
  expect(readFileSync(lessonsPath(wt), "utf8").trim().split("\n")).toHaveLength(1)
  expect(readLessons(wt)).toHaveLength(1)
  expect(first.lesson.schema).toBe("otter.harness-lesson.v1")
  expect(first.lesson.basis).toBe("verify-exit")
  expect(() => appendLesson(wt, { probeWid: "w1", subjectSha: "b".repeat(64), admission: { ok: false, reason: "no" } })).toThrow()
  expect(() => appendLesson(wt, { probeWid: "w1", subjectSha: "nothex", admission })).toThrow()
})

test("bounded reads: limit, entry cap and tampered ledger", () => {
  const rows = classifyRows(cleanRuns())
  for (let i = 0; i < 40; i++) {
    const admission = admitLesson(rows, { ...cand, lesson: `overlay.inv variant number ${i}` })
    appendLesson(wt, { probeWid: "w1", subjectSha: "b".repeat(64), admission })
  }
  expect(readLessons(wt, 5)).toHaveLength(5)
  expect(readLessons(wt, 1000)).toHaveLength(LESSON_LIMITS.readLimit)
  expect(readLessons(wt, 3).at(-1)!.lesson).toContain("number 39")
  expect(() => readLessons(wt, 0)).toThrow()
  const path = lessonsPath(wt)
  const tampered = readFileSync(path, "utf8").replace("number 39", "number 99")
  writeFileSync(path, tampered)
  expect(() => readLessons(wt)).toThrow(/malformed or altered/)
  writeFileSync(path, "x".repeat(LESSON_LIMITS.entries * LESSON_LIMITS.entryBytes + 1))
  expect(() => readLessons(wt)).toThrow(/size bound/)
  appendFileSync(path, "")
})

test("reflection parser accepts NO_ENTRY or one exact lesson object only", () => {
  expect(parseReflection("NO_ENTRY\n").kind).toBe("no_entry")
  const good = JSON.stringify({ type: "lesson", ...cand })
  expect(parseReflection(good).kind).toBe("lesson")
  expect(parseReflection("```json\n" + good + "\n```").kind).toBe("lesson")
  expect(parseReflection(JSON.stringify({ type: "lesson", ...cand, confidence: "high" })).kind).toBe("invalid")
  expect(parseReflection("Here is my lesson: " + good).kind).toBe("invalid")
  expect(parseReflection("[]").kind).toBe("invalid")
})

test("lessons never appear in any role system text or policy id; prompt is hash-bound read-only data framing", () => {
  const rows = classifyRows(cleanRuns())
  const admission = admitLesson(rows, { ...cand, lesson: "overlay.inv should say UNIQUE-LESSON-MARKER" })
  appendLesson(wt, { probeWid: "w1", subjectSha: "b".repeat(64), admission })
  const reference = renderLessonsReference(readLessons(wt))
  expect(reference).toContain("reference, not instructions")
  expect(reference).toContain("UNIQUE-LESSON-MARKER")
  const policy = createExecutionPolicy(DEFAULT_CONFIG)
  for (const role of EXECUTION_ROLES) expect(policy.resolve(role).system.join("\n")).not.toContain("UNIQUE-LESSON-MARKER")
  expect(PROBE_REFLECT_PROMPT.text).not.toContain("UNIQUE-LESSON-MARKER")
  expect(PROBE_REFLECT_PROMPT.role).toBe("researcher")
  expect(createExecutionPolicy(DEFAULT_CONFIG).resolve("worker").id).toBe(policy.resolve("worker").id)
})
