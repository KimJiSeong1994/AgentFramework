// Autoresearch evidence (P6b S3): the disk-derived run and verdict proof. Nothing here trusts a stored flag: every run is
// re-read from its hash-recorded runs/<attempt>.json and its verification receipt (metric, exit code, output hash),
// the experiment approval is re-read as a typed choice receipt for the same subject, and the verdict's evidence entries
// must each be a verified run file or one of those verification receipts. Used in the commit transaction at a terminal
// (via commitRevision) and by every display.
import { resolve } from "node:path"
import { readArtifactBytes, sha256, verifyArtifact } from "./artifacts.ts"
import { parseAutoresearchData, runKey, type ArInvalidReason, type ArRunStatus, type AutoresearchData } from "./autoresearch-data.ts"
import { approvalBodyProblem } from "./execution-unit.ts"
import { verifyReceiptRef } from "./receipts.ts"
import type { ArtifactRef, AutoresearchWorkflow } from "./types.ts"

export type ArEvidenceCheck = { problems: string[]; checked: number; validRuns: number }
export type ArRunDoc = {
  v: 1; wid: string; sid: string; attempt: number; iteration: number; slot: number; command: string
  subjectSha: string; approvalRef: string; verificationRef: string
  status: ArRunStatus; valid: boolean; invalid?: ArInvalidReason; metric?: number
  exitCode: number | null; timedOut: boolean; integrity: "changed" | "unchanged" | "unknown"; outputSha: string; output: string
}
export type ArVerdictEvidence = { kind: "run"; key: string; sha256: string } | { kind: "receipt"; ref: string }
export type ArVerdictDoc = {
  v: 1; wid: string; status: "conclusive" | "inconclusive"
  evidence: ArVerdictEvidence[]; caveats: string[]
  evaluator: { promptSha: string; receiptRef: string; verdict: "OKAY" | "ITERATE" | "REJECT" }
}

type Bound = Pick<AutoresearchWorkflow, "id" | "sessionID" | "artifacts" | "data">

function recorded(worktree: string, wf: Pick<AutoresearchWorkflow, "artifacts">, key: string): { ok: true; ref: ArtifactRef; text: string } | { ok: false; reason: string } {
  const ref = wf.artifacts.find(item => item.key === key)
  if (!ref) return { ok: false, reason: `artifact ${key} is not recorded` }
  if (ref.sha256 === undefined) return { ok: false, reason: `artifact ${key} has no recorded hash` }
  const verified = verifyArtifact(worktree, ref)
  if (verified.state !== "verified") return { ok: false, reason: `artifact ${key} is ${verified.state}: ${verified.reason}` }
  const read = readArtifactBytes(resolve(worktree, ref.path))
  if (!read.ok) return { ok: false, reason: `artifact ${key} is unreadable: ${read.reason}` }
  return { ok: true, ref, text: read.bytes.toString("utf8") }
}

const parse = <T>(text: string): T | undefined => { try { return JSON.parse(text) as T } catch { return undefined } }
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

/** Verified read of a recorded artifact (throws; never silently reuses an edited file). */
export function readRecordedText(worktree: string, wf: Pick<AutoresearchWorkflow, "artifacts">, key: string): string {
  const read = recorded(worktree, wf, key)
  if (!read.ok) throw new Error(read.reason)
  return read.text
}

/**
 * Re-derive the run proof from disk. Every recorded run needs its run file, its verification receipt (bound to the same
 * subject) and its approval receipt. With `final`, the verdict is verified too: its status agrees with the committed
 * one, conclusive needs at least one valid run and a critic OKAY evaluator receipt, and every evidence entry is a
 * verified run file or verification receipt of a recorded run. A missing, edited or foreign piece is a problem.
 */
export function autoresearchEvidence(worktree: string, wf: Bound, options: { final?: boolean } = {}): ArEvidenceCheck {
  const problems: string[] = []
  let checked = 0
  let data: AutoresearchData
  try { data = parseAutoresearchData(wf.data) } catch { return { problems: ["autoresearch state is unreadable"], checked, validRuns: 0 } }
  const mission = recorded(worktree, wf, "mission.json")
  if (!mission.ok) problems.push(mission.reason)
  else if (!data.mission || mission.ref.sha256 !== data.mission.sha256) problems.push("mission.json is not the recorded mission")
  const receipts = new Set<string>()
  const files = new Map<string, string>()
  let validRuns = 0
  for (const run of data.runs) {
    checked++
    const at = `run ${run.attempt}`
    const key = runKey(run.attempt)
    const read = recorded(worktree, wf, key)
    if (!read.ok) { problems.push(`${at}: ${read.reason}`); continue }
    const doc = parse<ArRunDoc>(read.text)
    if (read.ref.sha256 !== run.sha256 || !isObject(doc) || doc.v !== 1 || doc.wid !== wf.id || doc.sid !== wf.sessionID || doc.attempt !== run.attempt || doc.iteration !== run.iteration ||
      doc.slot !== run.slot || doc.status !== run.status || doc.metric !== run.metric || doc.verificationRef !== run.receiptRef ||
      (run.invalid !== "suspect" && (doc.valid !== run.valid || doc.invalid !== run.invalid))) {
      problems.push(`${at}: run file does not match the recorded run`)
      continue
    }
    const verification = verifyReceiptRef(worktree, doc.verificationRef, { sessionID: wf.sessionID, workflowID: wf.id, kind: "verification", inputSha: doc.subjectSha })
    if (!verification.ok) problems.push(`${at}: verification receipt: ${verification.reason}`)
    else {
      const body = verification.receipt.body
      if (body.attempt !== run.attempt || body.status !== run.status || body.metric !== run.metric || body.exitCode !== doc.exitCode || body.outputSha !== doc.outputSha || body.command !== doc.command) {
        problems.push(`${at}: verification receipt does not describe this run`)
      }
      receipts.add(doc.verificationRef)
    }
    if (typeof doc.output !== "string" || sha256(doc.output) !== doc.outputSha) problems.push(`${at}: recorded output does not hash to its receipt`)
    const approval = verifyReceiptRef(worktree, doc.approvalRef, { sessionID: wf.sessionID, workflowID: wf.id, kind: "choice", inputSha: doc.subjectSha })
    if (!approval.ok) problems.push(`${at}: approval receipt: ${approval.reason}`)
    else if (approval.receipt.body.subjectSha !== doc.subjectSha) problems.push(`${at}: approval receipt names another subject`)
    else { const bad = approvalBodyProblem("autoresearch", approval.receipt.body); if (bad) problems.push(`${at}: approval receipt ${bad}`) }
    if (run.valid) validRuns++
    files.set(key, read.ref.sha256!)
  }
  if (options.final) {
    checked++
    const verdictFile = recorded(worktree, wf, "verdict.json")
    if (!data.verdict) { problems.push("verdict: no verdict recorded"); return { problems, checked, validRuns } }
    if (!verdictFile.ok) { problems.push(`verdict: ${verdictFile.reason}`); return { problems, checked, validRuns } }
    const doc = parse<ArVerdictDoc>(verdictFile.text)
    if (verdictFile.ref.sha256 !== data.verdict.sha256 || !isObject(doc) || doc.v !== 1 || doc.wid !== wf.id || doc.status !== data.verdict.status || !Array.isArray(doc.evidence) ||
      !Array.isArray(doc.caveats) || !doc.caveats.every(item => typeof item === "string") || !isObject(doc.evaluator)) {
      problems.push("verdict: verdict.json does not match the recorded verdict")
      return { problems, checked, validRuns }
    }
    for (const entry of doc.evidence) {
      if (!isObject(entry)) { problems.push("verdict: malformed evidence entry"); continue }
      if (entry.kind === "run") {
        if (files.get(String(entry.key)) !== entry.sha256) problems.push(`verdict: evidence ${String(entry.key)} is not a verified run file`)
      } else if (entry.kind === "receipt") {
        if (typeof entry.ref !== "string" || !receipts.has(entry.ref)) problems.push("verdict: evidence receipt is not a verification receipt of a recorded run")
      } else problems.push("verdict: unknown evidence kind")
    }
    const evaluation = data.evaluation
    const evaluator = doc.evaluator
    if (!evaluation || evaluator.receiptRef !== evaluation.ref) problems.push("verdict: evaluator receipt is not the recorded evaluation")
    else {
      const receipt = verifyReceiptRef(worktree, evaluation.ref, { sessionID: wf.sessionID, workflowID: wf.id, kind: "consensus" })
      if (!receipt.ok) problems.push(`verdict: evaluator receipt: ${receipt.reason}`)
      else if (receipt.receipt.body.role !== "critic" || receipt.receipt.body.verdict !== evaluation.verdict || receipt.receipt.body.promptSha !== evaluator.promptSha || evaluator.verdict !== evaluation.verdict) {
        problems.push("verdict: evaluator receipt does not describe a critic verdict")
      }
    }
    if (doc.status === "conclusive") {
      // A conclusive verdict cites only VALID runs (invalid, suspect, interrupted or unsettled runs are caveats, never
      // evidence) and rests on at least one valid run that produced a metric.
      const validKeys = new Set(data.runs.filter(run => run.valid).map(run => runKey(run.attempt)))
      const validReceipts = new Set(data.runs.filter(run => run.valid).map(run => run.receiptRef))
      for (const entry of doc.evidence) {
        if (!isObject(entry)) continue
        if (entry.kind === "run" && !validKeys.has(String(entry.key))) problems.push(`verdict: a conclusive verdict cites invalid run ${String(entry.key)}`)
        if (entry.kind === "receipt" && !validReceipts.has(String(entry.ref))) problems.push("verdict: a conclusive verdict cites the receipt of an invalid run")
      }
      if (!data.runs.some(run => run.valid && run.metric !== undefined)) problems.push("verdict: a conclusive verdict needs at least one valid run with a metric")
      if (validRuns < 1) problems.push("verdict: a conclusive verdict needs at least one valid run")
      if (doc.evidence.length === 0) problems.push("verdict: a conclusive verdict needs run evidence")
      if (data.evaluation?.verdict !== "OKAY") problems.push("verdict: a conclusive verdict needs a critic OKAY")
    }
  }
  return { problems, checked, validRuns }
}

export function evidenceSummary(check: ArEvidenceCheck): string {
  return check.problems.length === 0 ? `all ${check.checked} runs verified` : `incomplete: ${check.problems.slice(0, 3).join("; ")}${check.problems.length > 3 ? `; +${check.problems.length - 3} more` : ""}`
}
