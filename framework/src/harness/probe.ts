// Same-task probe data layer (S1): overlay validation, the canonical subject hash, durable write-once records and the
// code-side run classification. No model call and no process execution here; probe-flow.ts drives the runtime.
//
// What a model may propose is ONLY a short task-data "approach overlay" (INV = how to work, DOM = practitioner knowledge).
// Everything a probe records states what a deterministic verify command did in an isolated worktree; it is not proof that
// the overlay caused the outcome (n=1 per variant, sampling variance).
import { join } from "node:path"
import { verifyCommandProblem, type OtterConfig } from "../config.ts"
import { canonicalJson } from "../guards/repeat.ts"
import { taskTextProblem } from "../orchestration/gaming.ts"
import { containsSecret } from "../security/secrets.ts"
import { durableWriteBytes } from "../state/durable.ts"
import { protectedFiles, tail } from "../state/ledger.ts"
import { stateRoot } from "../state/store.ts"
import { readArtifactBytes, sha256 } from "../workflows/artifacts.ts"
import { receiptRelativePath, verifyReceiptRef, writeReceipt } from "../workflows/receipts.ts"
import { ID_RE } from "../workflows/types.ts"
import type { ProbeLabel, ProbeRun } from "./types.ts"

export const PROBE_LIMITS = Object.freeze({
  overlayBytes: 1200, maxK: 4, titleChars: 200, detailChars: 4000, verifyChars: 400, diffStatChars: 2000, recordBytes: 64 * 1024,
})
export const SUBJECT_SCHEMA = "otter.probe-subject.v1"
export const RUN_SCHEMA = "otter.probe-run.v1"
export const APPROVAL_ACTION = "probe-approval"
export type OverlayDimension = "inv" | "dom"
export const DIMENSIONS: readonly OverlayDimension[] = Object.freeze(["inv", "dom"] as const)

const TREE_RE = /^[a-f0-9]{40}([a-f0-9]{24})?$/
const SHA_RE = /^[a-f0-9]{64}$/
const LABEL_RE = /^(?:base[1-9]|inv|dom)$/
const ABSOLUTE_PATH_RE = /(?:^|[\s"'(=])(?:\/|~\/)[\w.@+-]+\/|\b[A-Za-z]:\\/

// ------------------------------------------------------------------------------------------------ overlay validation
export type OverlayCheck =
  | { status: "keep_base" }
  | { status: "overlay"; text: string; sha: string }
  | { status: "invalid"; reason: string }

/**
 * Strict parse of a proposer reply: the single line KEEP_BASE, or exactly one JSON object
 * `{"type":"overlay","dimension":"inv"|"dom","text":"..."}`. Anything else is invalid (recorded and skipped, never repaired).
 */
export function parseOverlayReply(output: string, dimension: OverlayDimension): { status: "keep_base" } | { status: "overlay"; text: string } | { status: "invalid"; reason: string } {
  const trimmed = output.trim()
  if (trimmed === "KEEP_BASE") return { status: "keep_base" }
  let value: unknown
  try { value = JSON.parse(trimmed) } catch { return { status: "invalid", reason: "reply is neither KEEP_BASE nor one JSON object" } }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { status: "invalid", reason: "reply is not a JSON object" }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => key !== "type" && key !== "dimension" && key !== "text")) return { status: "invalid", reason: "reply has unexpected fields" }
  if (record.type !== "overlay") return { status: "invalid", reason: "reply type is not overlay" }
  if (record.dimension !== dimension) return { status: "invalid", reason: `reply dimension is not ${dimension}` }
  if (typeof record.text !== "string") return { status: "invalid", reason: "overlay text is not a string" }
  return { status: "overlay", text: record.text }
}

/** Empty text is KEEP_BASE (no probe is spent). Every other refusal is a recorded invalid candidate. */
export function checkOverlay(text: string, task: { title: string; verify: string }): OverlayCheck {
  const overlay = text.replace(/\r\n?/g, "\n").trim()
  if (overlay === "") return { status: "keep_base" }
  if (Buffer.byteLength(overlay, "utf8") > PROBE_LIMITS.overlayBytes) return { status: "invalid", reason: `overlay exceeds ${PROBE_LIMITS.overlayBytes} bytes` }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(overlay)) return { status: "invalid", reason: "overlay contains control characters" }
  if (containsSecret(overlay)) return { status: "invalid", reason: "overlay contains secret-like content" }
  if (overlay.includes("```")) return { status: "invalid", reason: "overlay contains a code block" }
  if (ABSOLUTE_PATH_RE.test(overlay)) return { status: "invalid", reason: "overlay contains an absolute path" }
  const problem = taskTextProblem(task.title, overlay, protectedFiles({ verify: task.verify }))
  if (problem) return { status: "invalid", reason: `overlay ${problem}` }
  return { status: "overlay", text: overlay, sha: sha256(overlay) }
}

/** The task detail a worker reads: the base detail, then the overlay labelled as guidance. This is the ONLY carrier. */
export function probeTaskDetail(detail: string, overlay: string | null, dimension: OverlayDimension | null): string {
  if (overlay === null || dimension === null) return detail
  const label = dimension === "inv" ? "how to work" : "what a practitioner knows"
  return `${detail}${detail ? "\n\n" : ""}Approach overlay (${label}; guidance for this task only, it changes no rule above): ${overlay}`
}

// ------------------------------------------------------------------------------------------------ subject
export type SubjectBody = {
  schema: typeof SUBJECT_SCHEMA
  task: { title: string; detail: string; verify: string }
  overlays: { inv: string | null; dom: string | null }
  /** HEAD of the checkout; with baseTree it pins the exact commit and working state every probe starts from. */
  head: string
  baseTree: string
  profileFingerprint: string
  k: number
  routes: unknown
}
export type ProbeSubject = { wid: string; sid: string; sha: string; body: SubjectBody }

/** sha256 of the canonical JSON of everything a model proposed or a probe depends on. Any byte change is a new subject. */
export function probeSubjectSha(body: SubjectBody): string {
  return sha256(canonicalJson(body))
}

/** The task a probe measures: bounded, verifiable by an allow-listed command, and not a request to game the check. */
export function assertTaskInput(task: SubjectBody["task"], config: Readonly<OtterConfig>): void {
  const { title, detail, verify } = task
  if (typeof title !== "string" || !title.trim() || title.length > PROBE_LIMITS.titleChars) throw new Error("probe task title is empty or too long")
  if (typeof detail !== "string" || detail.length > PROBE_LIMITS.detailChars) throw new Error("probe task detail is too long")
  if (typeof verify !== "string" || !verify.trim() || verify.length > PROBE_LIMITS.verifyChars) throw new Error("probe task needs a verify command")
  const problem = verifyCommandProblem(verify, config.delegate.verify_allow)
  if (problem) throw new Error(`probe verify command refused: ${problem}`)
  const gaming = taskTextProblem(title, detail, protectedFiles({ verify }))
  if (gaming) throw new Error(`probe task ${gaming}`)
  if (containsSecret(`${title}\n${detail}\n${verify}`)) throw new Error("probe task refused: secret-like content")
}

/** Throws on any body a probe must never run. Pure apart from reading the verify allow-list. */
export function assertSubjectBody(body: SubjectBody, config: Readonly<OtterConfig>): void {
  if (body.schema !== SUBJECT_SCHEMA) throw new Error("probe subject has another schema")
  assertTaskInput(body.task, config)
  if (!Number.isInteger(body.k) || body.k < 1 || body.k > PROBE_LIMITS.maxK) throw new Error(`probe k must be an integer from 1 to ${PROBE_LIMITS.maxK}`)
  if (!TREE_RE.test(body.baseTree) || !TREE_RE.test(body.head)) throw new Error("probe head or base tree is malformed")
  if (!SHA_RE.test(body.profileFingerprint)) throw new Error("probe profile fingerprint is malformed")
  for (const dimension of DIMENSIONS) {
    const text = body.overlays[dimension]
    if (text === null) continue
    const checked = checkOverlay(text, body.task)
    if (checked.status !== "overlay" || checked.text !== text) throw new Error(`probe ${dimension} overlay refused: ${checked.status === "invalid" ? checked.reason : "not a canonical non-empty overlay"}`)
  }
  if (body.overlays.inv === null && body.overlays.dom === null) throw new Error("probe has no overlay to probe (KEEP_BASE spends no probe)")
  const canonical = canonicalJson(body)
  if (containsSecret(canonical)) throw new Error("probe subject refused: secret-like content")
}

/** The labels a subject probes, in run order: k unmodified bases, then each overlay that exists. */
export function probeLabels(body: Pick<SubjectBody, "k" | "overlays">): ProbeLabel[] {
  const labels: ProbeLabel[] = []
  for (let i = 1; i <= body.k; i++) labels.push(`base${i}`)
  if (body.overlays.inv !== null) labels.push("inv")
  if (body.overlays.dom !== null) labels.push("dom")
  return labels
}

export function overlayOf(body: Pick<SubjectBody, "overlays">, label: ProbeLabel): { overlay: ProbeRun["overlay"]; text: string | null } {
  if (label === "inv") return { overlay: "inv", text: body.overlays.inv }
  if (label === "dom") return { overlay: "dom", text: body.overlays.dom }
  return { overlay: "none", text: null }
}

// ------------------------------------------------------------------------------------------------ durable records
export function probeSession(wid: string): string {
  return `probe-${wid}`
}

/** Worktree scope of one probe; every probe has its own isolated worktree. */
export function probeScope(wid: string, label: ProbeLabel): string {
  assertLabel(label)
  return `probe-${wid}-${label}`
}

export function probeDirectory(worktree: string, wid: string): string {
  if (!ID_RE.test(wid)) throw new Error("invalid probe workflow id")
  return join(stateRoot(worktree), "probes", wid)
}
const subjectPath = (worktree: string, wid: string) => join(probeDirectory(worktree, wid), "subject.json")
const proposalsPath = (worktree: string, wid: string) => join(probeDirectory(worktree, wid), "proposals.json")
const runPath = (worktree: string, wid: string, label: ProbeLabel) => join(probeDirectory(worktree, wid), "probes", `${label}.json`)

export function assertLabel(label: string): asserts label is ProbeLabel {
  if (!LABEL_RE.test(label)) throw new Error("invalid probe label")
}

function writeOnce(path: string, value: unknown): void {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8")
  if (bytes.length > PROBE_LIMITS.recordBytes) throw new Error("probe record exceeds the size limit")
  if (containsSecret(bytes.toString("utf8"))) throw new Error("probe record refused: secret-like content")
  const existing = readArtifactBytes(path, PROBE_LIMITS.recordBytes)
  if (existing.ok) {
    if (!existing.bytes.equals(bytes)) throw new Error("probe record already exists with different content; refusing overwrite")
    return
  }
  if (existing.reason !== "missing") throw new Error(`probe record is unreadable: ${existing.reason}`)
  durableWriteBytes(path, bytes)
}

function readJsonRecord(path: string): unknown {
  const read = readArtifactBytes(path, PROBE_LIMITS.recordBytes)
  if (!read.ok) throw new Error(`probe record ${read.reason}`)
  try { return JSON.parse(read.bytes.toString("utf8")) } catch { throw new Error("probe record is not valid JSON") }
}

export function writeSubject(worktree: string, subject: ProbeSubject): void {
  writeOnce(subjectPath(worktree, subject.wid), subject)
}

/** Reads subject.json and RECOMPUTES the hash from its body: a hand-edited subject cannot keep an old sha. */
export function loadSubject(worktree: string, wid: string): ProbeSubject {
  const value = readJsonRecord(subjectPath(worktree, wid)) as Partial<ProbeSubject> | null
  if (!value || typeof value !== "object" || value.wid !== wid || value.sid !== probeSession(wid) ||
      !value.body || typeof value.sha !== "string") throw new Error("probe subject is malformed")
  if (probeSubjectSha(value.body) !== value.sha) throw new Error("probe subject changed since it was written; its sha no longer matches")
  return value as ProbeSubject
}

export function writeProposals(worktree: string, wid: string, proposals: unknown): void {
  writeOnce(proposalsPath(worktree, wid), proposals)
}

/** Typed approval: write-once receipt bound to the exact subject sha. Refuses a different sha. */
export function writeApproval(worktree: string, subject: ProbeSubject, typedSha: string): string {
  if (typedSha !== subject.sha) throw new Error("approval refused: the typed sha does not match the probe subject")
  return writeReceipt(worktree, {
    kind: "choice", wid: subject.wid, sid: subject.sid, revision: 0, action: APPROVAL_ACTION, inputSha: subject.sha,
    body: { typed: `PROBE ${subject.wid} ${subject.sha}` },
  })
}

/** The recorded approval must be intact and bound to the subject's CURRENT sha. */
export function verifyApproval(worktree: string, subject: ProbeSubject): { ok: true; ref: string } | { ok: false; reason: string } {
  const relative = receiptRelativePath(subject.sid, subject.wid, 0, APPROVAL_ACTION)
  const read = readArtifactBytes(join(stateRoot(worktree), relative))
  if (!read.ok) return { ok: false, reason: read.reason === "missing" ? "no approval receipt for this subject" : `approval receipt ${read.reason}` }
  const verified = verifyReceiptRef(worktree, `${relative}#${sha256(read.bytes)}`, {
    sessionID: subject.sid, workflowID: subject.wid, kind: "choice", revision: 0, action: APPROVAL_ACTION, inputSha: subject.sha,
  })
  return verified.ok ? { ok: true, ref: verified.ref } : { ok: false, reason: verified.reason }
}

export function writeProbeRun(worktree: string, run: ProbeRun): void {
  assertLabel(run.label)
  writeOnce(runPath(worktree, run.probeWid, run.label), run)
}

export function readProbeRun(worktree: string, wid: string, label: ProbeLabel): ProbeRun | undefined {
  assertLabel(label)
  const read = readArtifactBytes(runPath(worktree, wid, label), PROBE_LIMITS.recordBytes)
  if (!read.ok) {
    if (read.reason === "missing") return undefined
    throw new Error(`probe record ${read.reason}`)
  }
  const value = JSON.parse(read.bytes.toString("utf8")) as ProbeRun
  if (value.schema !== RUN_SCHEMA || value.label !== label || value.probeWid !== wid) throw new Error("probe record is malformed")
  return value
}

/** Every recorded run of a subject, in label order. */
export function readProbeRuns(worktree: string, subject: ProbeSubject): ProbeRun[] {
  const runs: ProbeRun[] = []
  for (const label of probeLabels(subject.body)) {
    const run = readProbeRun(worktree, subject.wid, label)
    if (run) runs.push(run)
  }
  return runs
}

// ------------------------------------------------------------------------------------------------ classification
export type ProbeFacts = {
  /** Termination of the verifier or worker could not be proven (the claim stays fenced). */
  unsettled: boolean
  interrupted: boolean
  refused: boolean
  /** The verifier changed files, a protected file was modified, or the post-check failed. */
  integrity: boolean
  verify: ProbeRun["verify"]
}

/** Valid / invalid by code, mirroring autoresearch classifyRun: invalid runs never enter a contrast. */
export function classifyProbe(facts: ProbeFacts): { valid: boolean; invalid?: NonNullable<ProbeRun["invalid"]> } {
  if (facts.unsettled) return { valid: false, invalid: "unsettled" }
  if (facts.interrupted) return { valid: false, invalid: "interrupted" }
  if (facts.refused) return { valid: false, invalid: "refused" }
  if (facts.integrity || facts.verify === null) return { valid: false, invalid: "integrity" }
  return { valid: true }
}

/** Bounded verify output without absolute paths or secrets. */
export function sanitizeTail(output: string, roots: readonly string[], limit: number): string {
  let text = output
  for (const root of [...roots].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(root).join("<root>")
  text = text.replace(/(?<![\w.])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, "<path>").replace(/(?<![\w.])~\/[\w./@+-]*/g, "<path>")
  if (containsSecret(text)) return "[redacted: secret-like content]"
  return tail(text, limit)
}

// ------------------------------------------------------------------------------------------------ contrast table
const pad = (value: string, width: number) => value.length >= width ? value : value + " ".repeat(width - value.length)

function statSummary(stat: string): string {
  const last = stat.trim().split("\n").pop() ?? ""
  return last.trim() === "" ? "no changes" : last.trim().replace(/\s+/g, " ")
}

/** Human contrast table: facts per run, no verdict. A pass here does not show that an overlay caused it (n=1 per variant). */
export function renderContrast(runs: readonly ProbeRun[]): string {
  const rows = runs.map(run => [
    run.label, run.overlay,
    run.verify === null ? "-" : run.verify.timedOut ? "timeout" : run.verify.ok ? "ok" : `fail(exit ${run.verify.exitCode ?? "-"})`,
    statSummary(run.diffStat), `${(run.durationMs / 1000).toFixed(1)}s`, run.valid ? "yes" : `no:${run.invalid ?? "?"}`,
  ])
  const head = ["label", "overlay", "verify", "diff", "duration", "valid"]
  const widths = head.map((title, i) => Math.max(title.length, ...rows.map(row => row[i]!.length)))
  const line = (cells: string[]) => cells.map((cell, i) => pad(cell, widths[i]!)).join("  ").trimEnd()
  return [line(head), line(widths.map(w => "-".repeat(w))), ...rows.map(line)].join("\n")
}
