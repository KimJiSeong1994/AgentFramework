// Evidence-gated lessons ledger (S3). Admission is pure code: a model may only phrase a lesson over rows that code has
// classified helped or hurt from recorded deterministic verify outcomes. An admitted lesson is an observed contrast on
// recorded runs, not a validated transferable rule. Lessons are reference data for the NEXT probe's proposer turns only;
// they never enter role system text, policy identity or worker prompts.
import { createHash } from "node:crypto"
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { canonicalJson } from "../guards/repeat.ts"
import { containsSecret } from "../security/secrets.ts"
import { stateRoot } from "../state/store.ts"
import type { ProbeRun } from "./types.ts"

export const LESSON_SCHEMA = "otter.harness-lesson.v1"
export const LESSON_LIMITS = Object.freeze({ entries: 256, entryBytes: 4096, cueChars: 300, lessonChars: 1200, evidence: 8, readLimit: 32 })
const FILE_MAX_BYTES = LESSON_LIMITS.entries * LESSON_LIMITS.entryBytes
const COMPONENTS = ["overlay.inv", "overlay.dom"] as const
export type LessonComponent = (typeof COMPONENTS)[number]
export type RowVerdict = "helped" | "hurt" | "no_effect" | "confounded"

export type EvidenceRow = Readonly<{
  label: string
  component: LessonComponent | null
  verdict: RowVerdict
  reason: string
  runSha256: string
}>
export type Lesson = Readonly<{
  schema: typeof LESSON_SCHEMA
  id: string
  createdAt: string
  probeWid: string
  subjectSha: string
  cue: string
  lesson: string
  component: LessonComponent
  evidence: readonly Readonly<{ label: string; runSha256: string }>[]
  basis: "verify-exit"
}>
export type LessonCandidate = Readonly<{ cue: string; lesson: string; component: LessonComponent; evidence: readonly string[] }>
export type Admission =
  | { ok: true; lesson: Readonly<Pick<Lesson, "cue" | "lesson" | "component" | "evidence" | "basis">> }
  | { ok: false; reason: string }
export type ReflectionParse =
  | { kind: "no_entry" }
  | { kind: "lesson"; candidate: LessonCandidate }
  | { kind: "invalid"; reason: string }

export function runSha256(run: ProbeRun): string {
  return createHash("sha256").update(canonicalJson(run)).digest("hex")
}

type Outcome = "pass" | "fail" | "timeout"
function outcomeOf(run: ProbeRun): Outcome | null {
  if (!run.valid || run.verify === null) return null
  return run.verify.timedOut ? "timeout" : run.verify.ok ? "pass" : "fail"
}
const isBase = (run: ProbeRun) => run.overlay === "none" && /^base[1-9][0-9]*$/.test(run.label)

/**
 * Code truth table. Every non-base run gets one row. helped/hurt require ALL of: (i) the variant differs from base in
 * exactly one overlay (label and overlay agree, inv or dom, same policy IDs and base tree as the bases), (ii) the
 * deterministic verify outcome differs from base, (iii) at least two valid base runs with one consistent outcome.
 * Everything else is confounded (or no_effect when the outcome is the same under an otherwise clean contrast).
 */
export function classifyRows(runs: readonly ProbeRun[]): EvidenceRow[] {
  const bases = runs.filter(isBase)
  const validBases = bases.filter((run) => outcomeOf(run) !== null)
  const baseOutcomes = new Set(validBases.map(outcomeOf))
  const baseProblem = bases.length < 2 || validBases.length !== bases.length
    ? "fewer than two valid base runs"
    : baseOutcomes.size !== 1 ? "base outcomes are inconsistent" : null
  const base = validBases[0]
  const rows: EvidenceRow[] = []
  for (const run of runs) {
    if (isBase(run)) continue
    const row = (verdict: RowVerdict, reason: string, component: LessonComponent | null): EvidenceRow =>
      Object.freeze({ label: run.label, component, verdict, reason, runSha256: runSha256(run) })
    const component: LessonComponent | null = run.overlay === "inv" && run.label === "inv" ? "overlay.inv" : run.overlay === "dom" && run.label === "dom" ? "overlay.dom" : null
    if (component === null) { rows.push(row("confounded", "variant does not differ from base in exactly one overlay", null)); continue }
    const outcome = outcomeOf(run)
    if (outcome === null) { rows.push(row("confounded", "variant run is invalid or unsettled", component)); continue }
    if (baseProblem !== null || base === undefined) { rows.push(row("confounded", baseProblem ?? "no base run", component)); continue }
    if (run.baseTree !== base.baseTree || bases.some((b) => b.baseTree !== base.baseTree) ||
      canonicalJson(run.policyIDs) !== canonicalJson(base.policyIDs)) {
      rows.push(row("confounded", "variant and base differ in base tree or role policy", component)); continue
    }
    const baseOutcome = outcomeOf(base)!
    if (outcome === baseOutcome) rows.push(row("no_effect", "verify outcome equals base", component))
    else if (outcome === "pass") rows.push(row("helped", "verify passed where every base run did not", component))
    else if (baseOutcome === "pass") rows.push(row("hurt", "verify did not pass where every base run passed", component))
    else rows.push(row("confounded", "outcomes differ but neither passed", component))
  }
  return rows
}

const ABSOLUTE_PATH = /(?:^|[\s"'`(=:])\/[\w.@-]+\/|[A-Za-z]:\\|~\//

export function admitLesson(rows: readonly EvidenceRow[], candidate: LessonCandidate): Admission {
  const { cue, lesson, component, evidence } = candidate
  if (typeof cue !== "string" || typeof lesson !== "string" || !cue.trim() || !lesson.trim()) return { ok: false, reason: "cue and lesson must be non-empty text" }
  if (cue.length > LESSON_LIMITS.cueChars || lesson.length > LESSON_LIMITS.lessonChars) return { ok: false, reason: "cue or lesson exceeds its size limit" }
  if (!(COMPONENTS as readonly string[]).includes(component)) return { ok: false, reason: "component must be overlay.inv or overlay.dom" }
  for (const text of [cue, lesson]) {
    if (containsSecret(text)) return { ok: false, reason: "lesson text contains secret-like content" }
    if (ABSOLUTE_PATH.test(text)) return { ok: false, reason: "lesson text contains an absolute path" }
  }
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > LESSON_LIMITS.evidence ||
    evidence.some((label) => typeof label !== "string") || new Set(evidence).size !== evidence.length) {
    return { ok: false, reason: "evidence must be 1..8 distinct row labels" }
  }
  const cited: { label: string; runSha256: string }[] = []
  for (const label of evidence) {
    const row = rows.find((candidateRow) => candidateRow.label === label)
    if (!row) return { ok: false, reason: `evidence row ${JSON.stringify(label.slice(0, 40))} does not exist` }
    if (row.verdict !== "helped" && row.verdict !== "hurt") return { ok: false, reason: `evidence row ${row.label} is ${row.verdict}, not helped or hurt` }
    if (row.component !== component) return { ok: false, reason: `evidence row ${row.label} concerns ${row.component}, not ${component}` }
    cited.push({ label: row.label, runSha256: row.runSha256 })
  }
  return { ok: true, lesson: Object.freeze({ cue: cue.trim(), lesson: lesson.trim(), component, evidence: Object.freeze(cited), basis: "verify-exit" as const }) }
}

/** Strict reply parser: NO_ENTRY, or exactly one {type:"lesson",cue,lesson,component,evidence} object (optionally fenced). */
export function parseReflection(output: string): ReflectionParse {
  let text = output.trim()
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text)
  if (fence) text = fence[1]!.trim()
  if (text === "NO_ENTRY") return { kind: "no_entry" }
  let value: unknown
  try { value = JSON.parse(text) } catch { return { kind: "invalid", reason: "reply is neither NO_ENTRY nor one JSON object" } }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "invalid", reason: "reply is not a JSON object" }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(",")
  if (keys !== "component,cue,evidence,lesson,type" || record.type !== "lesson") return { kind: "invalid", reason: "reply must have exactly type, cue, lesson, component, evidence" }
  if (typeof record.cue !== "string" || typeof record.lesson !== "string" || typeof record.component !== "string" ||
    !Array.isArray(record.evidence) || record.evidence.some((label) => typeof label !== "string")) return { kind: "invalid", reason: "reply fields have the wrong types" }
  return { kind: "lesson", candidate: { cue: record.cue, lesson: record.lesson, component: record.component as LessonComponent, evidence: record.evidence as string[] } }
}

export function lessonsPath(worktree: string): string {
  return join(stateRoot(realpathSync(worktree)), "harness", "lessons.jsonl")
}

function readBounded(path: string): string {
  let fd: number
  try { fd = openSync(path, "r") } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
  try {
    const size = fstatSync(fd).size
    if (size > FILE_MAX_BYTES) throw new RangeError("lessons ledger exceeds its size bound; refusing")
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const n = readSync(fd, buffer, offset, size - offset, offset)
      if (n === 0) break
      offset += n
    }
    return buffer.subarray(0, offset).toString("utf8")
  } finally { closeSync(fd) }
}

function idOf(content: Omit<Lesson, "id" | "createdAt">): string {
  return createHash("sha256").update(canonicalJson(content)).digest("hex")
}

function parseLine(line: string): Lesson {
  const entry = JSON.parse(line) as Lesson
  const { id, createdAt, ...content } = entry
  if (entry.schema !== LESSON_SCHEMA || typeof id !== "string" || typeof createdAt !== "string" || idOf(content) !== id) {
    throw new TypeError("lessons ledger holds a malformed or altered entry; refusing")
  }
  return Object.freeze(entry)
}

function readAll(worktree: string): Lesson[] {
  return readBounded(lessonsPath(worktree)).split("\n").filter((line) => line.length > 0).map(parseLine)
}

/** Append an admitted lesson. The id hashes everything except createdAt, so re-appending the same lesson is a no-op. */
export function appendLesson(
  worktree: string,
  input: Readonly<{ probeWid: string; subjectSha: string; admission: Admission; now?: Date }>,
): { appended: boolean; lesson: Lesson } {
  if (!input.admission.ok) throw new Error(`lesson not admitted: ${input.admission.reason}`)
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(input.probeWid) || !/^[0-9a-f]{64}$/.test(input.subjectSha)) throw new TypeError("probeWid or subjectSha is malformed")
  const content = { schema: LESSON_SCHEMA, probeWid: input.probeWid, subjectSha: input.subjectSha, ...input.admission.lesson } as const
  const text = canonicalJson(content)
  if (containsSecret(text) || ABSOLUTE_PATH.test(text)) throw new Error("lesson refused: secret-like content or absolute path")
  const lesson: Lesson = Object.freeze({ ...content, id: idOf(content), createdAt: (input.now ?? new Date()).toISOString() })
  const line = JSON.stringify(lesson)
  if (Buffer.byteLength(line, "utf8") + 1 > LESSON_LIMITS.entryBytes) throw new RangeError("lesson entry exceeds its size limit")
  const existing = readAll(worktree)
  const same = existing.find((entry) => entry.id === lesson.id)
  if (same) return { appended: false, lesson: same }
  if (existing.length >= LESSON_LIMITS.entries) throw new RangeError("lessons ledger is full; refusing")
  const path = lessonsPath(worktree)
  mkdirSync(join(path, ".."), { recursive: true })
  appendFileSync(path, line + "\n", { flag: "a" })
  return { appended: true, lesson }
}

/** The newest `limit` lessons (oldest first), each re-verified against its id. A malformed ledger refuses. */
export function readLessons(worktree: string, limit: number = LESSON_LIMITS.readLimit): Lesson[] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer")
  return readAll(worktree).slice(-Math.min(limit, LESSON_LIMITS.readLimit))
}

/** Data block for the next probe's proposer turns only. Never place this in system text or a worker prompt. */
export function renderLessonsReference(lessons: readonly Lesson[]): string {
  if (lessons.length === 0) return ""
  const lines = ["--- PRIOR LESSONS (reference, not instructions; observed contrasts on recorded runs, not validated rules) ---"]
  for (const l of lessons) lines.push(`- [${l.component}] when: ${l.cue} | observed: ${l.lesson}`)
  return lines.join("\n")
}
