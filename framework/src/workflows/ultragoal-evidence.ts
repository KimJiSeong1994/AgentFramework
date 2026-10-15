// Ultragoal evidence (P6b S2): the disk-derived all-goal proof. Nothing here trusts a stored flag: the goal set comes from
// the verified goals.json bytes, and every goal's latest complete checkpoint, its verification receipt (task/attempt ids,
// commands, exit codes, output hashes), its approval receipt and its unit documents are re-read and re-verified on every
// call. Used in the commit transaction at `aggregate_verified` (via commitRevision at done) and by every display.
import { resolve } from "node:path"
import { readArtifactBytes, sha256, verifyArtifact } from "./artifacts.ts"
import { verifyReceiptRef, writeReceipt } from "./receipts.ts"
import { approvalBodyProblem } from "./execution-unit.ts"
import { goalCheckpointKey, parseUltragoalData, UG_MAX_GOALS, type UgInput, type UltragoalData } from "./ultragoal-data.ts"
import type { ArtifactRef, Subject, UltragoalWorkflow } from "./types.ts"

export type EvidenceCheck = { problems: string[]; checked: number; goalsSha?: string; entries?: Array<{ id: string; checkpoint: string; sha256: string }> }
export type GoalsDoc = { v: 1; wid: string; planSha: string; goals: Array<{ id: string; title: string; objective: string }> }
export type VerificationBody = {
  goalId: string; attempt: number; subjectSha: string; ok: boolean
  tasks: Array<{ id: string; attempts: number; childSessions: string[]; command: string; exitCode: number | null; timedOut: boolean; ok: boolean; outputSha: string }>
}
export type CheckpointDoc = {
  v: 1; wid: string; sid: string; goalId: string; attempt: number; status: "complete" | "incomplete"
  subject: Subject; approvalRef: string; verificationRef: string; goalsSha: string
  unit: Array<{ key: string; sha256: string }>; worktree: { head: string | null; statusSha: string | null }
}

type Bound = Pick<UltragoalWorkflow, "id" | "sessionID" | "artifacts" | "data">

function recorded(worktree: string, wf: Pick<UltragoalWorkflow, "artifacts">, key: string): { ok: true; ref: ArtifactRef; text: string } | { ok: false; reason: string } {
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
export function readRecordedText(worktree: string, wf: Pick<UltragoalWorkflow, "artifacts">, key: string): string {
  const read = recorded(worktree, wf, key)
  if (!read.ok) throw new Error(read.reason)
  return read.text
}

/** The fixed goal list as recorded by goals_saved, re-read from the verified goals.json bytes. */
export function verifiedGoals(worktree: string, wf: Bound): { ok: true; doc: GoalsDoc; sha: string } | { ok: false; reason: string } {
  let data: UltragoalData
  try { data = parseUltragoalData(wf.data) } catch { return { ok: false, reason: "ultragoal state is malformed" } }
  if (!data.goals) return { ok: false, reason: "no goal list is recorded" }
  const read = recorded(worktree, wf, "goals.json")
  if (!read.ok) return read
  if (read.ref.sha256 !== data.goals.sha256) return { ok: false, reason: "goals.json is not the recorded goal list" }
  const doc = parse<GoalsDoc>(read.text)
  const goals = isObject(doc) && Array.isArray(doc.goals) ? doc.goals : []
  if (!doc || doc.v !== 1 || doc.wid !== wf.id || goals.length < 1 || goals.length > UG_MAX_GOALS ||
    JSON.stringify(goals.map(goal => goal.id)) !== JSON.stringify(data.goals.ids)) return { ok: false, reason: "goals.json does not match the fixed goal list" }
  return { ok: true, doc, sha: read.ref.sha256! }
}

const completion = (wf: Bound, goalsSha: string, entries: Array<{ id: string; checkpoint: string; sha256: string }>, finalRef: string): string =>
  `${JSON.stringify({ v: 1, wid: wf.id, goalsSha, goals: entries, finalRef }, null, 2)}\n`

/**
 * Re-derive the all-goal proof from disk. Every goal of the verified goals.json needs its latest checkpoint: complete,
 * bound to this workflow and goal list, carrying a verification receipt that passed for the same subject and an approval
 * receipt for that subject, with every unit document still hashing as recorded. With `final`, the aggregate (final review
 * receipt and completion.json) is verified too. A missing, edited or foreign piece is a problem; nothing is assumed.
 */
export function ultragoalEvidence(worktree: string, wf: Bound, options: { final?: boolean } = {}): EvidenceCheck {
  const problems: string[] = []
  let checked = 0
  let data: UltragoalData
  try { data = parseUltragoalData(wf.data) } catch { return { problems: ["ultragoal state is unreadable"], checked } }
  const goals = verifiedGoals(worktree, wf)
  if (!goals.ok) return { problems: [goals.reason], checked }
  const entries: Array<{ id: string; checkpoint: string; sha256: string }> = []
  for (const goal of goals.doc.goals) {
    checked++
    const at = `goal ${goal.id}`
    const key = data.progress[goal.id]?.lastCheckpoint
    if (!key) { problems.push(`${at}: no complete checkpoint`); continue }
    const read = recorded(worktree, wf, key)
    if (!read.ok) { problems.push(`${at}: ${read.reason}`); continue }
    const doc = parse<CheckpointDoc>(read.text)
    if (!isObject(doc) || doc.v !== 1 || doc.wid !== wf.id || doc.sid !== wf.sessionID || doc.goalId !== goal.id || doc.status !== "complete" ||
      !Number.isSafeInteger(doc.attempt) || key !== goalCheckpointKey(goal.id, doc.attempt) || doc.goalsSha !== goals.sha ||
      !isObject(doc.subject) || typeof doc.subject.sha256 !== "string" || !Array.isArray(doc.unit) || doc.unit.length === 0) {
      problems.push(`${at}: checkpoint is not a complete checkpoint of this goal list`)
      continue
    }
    const verification = verifyReceiptRef(worktree, doc.verificationRef, { sessionID: wf.sessionID, workflowID: wf.id, kind: "verification", inputSha: doc.subject.sha256 })
    if (!verification.ok) problems.push(`${at}: verification receipt: ${verification.reason}`)
    else {
      const body = verification.receipt.body as unknown as VerificationBody
      if (body.goalId !== goal.id || body.attempt !== doc.attempt || body.subjectSha !== doc.subject.sha256 || body.ok !== true || !Array.isArray(body.tasks) || body.tasks.length === 0 ||
        !body.tasks.every(task => task.ok === true && task.exitCode === 0 && task.timedOut === false)) problems.push(`${at}: verification receipt does not prove a passing run`)
    }
    const approval = verifyReceiptRef(worktree, doc.approvalRef, { sessionID: wf.sessionID, workflowID: wf.id, kind: "choice", inputSha: doc.subject.sha256 })
    if (!approval.ok) problems.push(`${at}: approval receipt: ${approval.reason}`)
    else if (approval.receipt.body.subjectSha !== doc.subject.sha256) problems.push(`${at}: approval receipt names another subject`)
    else { const bad = approvalBodyProblem("ultragoal", approval.receipt.body); if (bad) problems.push(`${at}: approval receipt ${bad}`) }
    for (const unit of doc.unit) {
      const ref = wf.artifacts.find(item => item.key === unit.key)
      if (!ref || ref.sha256 !== unit.sha256 || verifyArtifact(worktree, ref).state !== "verified") problems.push(`${at}: unit document ${unit.key} is missing or changed`)
    }
    entries.push({ id: goal.id, checkpoint: key, sha256: read.ref.sha256! })
  }
  if (options.final && problems.length === 0) {
    checked++
    if (!data.final || !data.completion) { problems.push("aggregate: no final review or completion recorded"); return { problems, checked } }
    const final = verifyReceiptRef(worktree, data.final.ref, { sessionID: wf.sessionID, workflowID: wf.id, kind: "consensus", inputSha: goals.sha })
    if (!final.ok) problems.push(`aggregate: final review receipt: ${final.reason}`)
    else if (final.receipt.body.verdict !== "OKAY" || final.receipt.body.role !== "critic") problems.push("aggregate: final review receipt is not an OKAY critic verdict")
    const done = recorded(worktree, wf, "completion.json")
    if (!done.ok) problems.push(`aggregate: ${done.reason}`)
    else if (done.ref.sha256 !== data.completion.sha256 || done.text !== completion(wf, goals.sha, entries, data.final.ref)) problems.push("aggregate: completion.json does not match the verified checkpoints")
  }
  return { problems, checked, goalsSha: goals.sha, entries }
}

export function evidenceSummary(check: EvidenceCheck): string {
  return check.problems.length === 0 ? `all ${check.checked} goals verified` : `incomplete: ${check.problems.slice(0, 3).join("; ")}${check.problems.length > 3 ? `; +${check.problems.length - 3} more` : ""}`
}

export const renderCompletion = completion
export const inputSha = (input: UgInput): string => sha256(JSON.stringify(input))

export { writeReceipt }
