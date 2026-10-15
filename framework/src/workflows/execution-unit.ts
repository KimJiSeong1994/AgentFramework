// Approved execution unit (P5a). The controller runs on an ApprovedExecutionUnit, never on an arbitrary workflow
// record: it names the parent workflow, the exact approved subject, the task ids it owns, attempts so far and any
// residual stop checkpoint. Ledger tasks are tagged with the parent workflow id plus the subject hash, never another
// workflow's id. Plan APIs accept a narrowed PlanWorkflow or this unit; nothing here casts an unnarrowed envelope.
import type { LedgerTask, WorkflowTag } from "../state/ledger.ts"
import { join } from "node:path"
import { readArtifactBytes, sha256, verifyArtifact, planArtifactRefs } from "./artifacts.ts"
import { verifyReceiptRef } from "./receipts.ts"
import type { ArtifactRef, PlanWorkflow, Subject, SubjectKind, WorkflowEnvelope } from "./types.ts"

/** Rendered unit documents stay small enough for the 5120-token worker and 8192-token read-only role budgets. */
export const UNIT_DOC_MAX_BYTES = 16 * 1024

export type ApprovedExecutionUnit = {
  readonly parentWorkflowID: string
  readonly sessionID: string
  readonly subject: Readonly<Subject>
  readonly taskIds: readonly string[]
  readonly attempts: number
  readonly residualCheckpoint: string | null
}

/** Inputs of a generic subject; every field participates in the hash, so any edit invalidates an approval. */
export type SubjectInput = {
  kind: SubjectKind
  id: string
  scope: readonly string[]
  commands: readonly string[]
  inputs: readonly string[]
  allowedPaths: readonly string[]
  verification: readonly string[]
  /** sha256 of every source the unit was derived from */
  sourceHashes: readonly string[]
  /** sha256 of every artifact the unit is bound to */
  artifactHashes: readonly string[]
}

/**
 * Canonical subject hash: fixed key order; order-insensitive sets (allowed paths, source and artifact hashes) are
 * sorted, order-significant lists (scope, commands, inputs, verification) keep their order.
 */
export function subjectSha256(input: SubjectInput): string {
  const sorted = (values: readonly string[]) => [...values].sort()
  return sha256(JSON.stringify({
    kind: input.kind,
    id: input.id,
    scope: [...input.scope],
    commands: [...input.commands],
    inputs: [...input.inputs],
    allowedPaths: sorted(input.allowedPaths),
    verification: [...input.verification],
    sourceHashes: sorted(input.sourceHashes),
    artifactHashes: sorted(input.artifactHashes),
  }))
}

/**
 * The plan subject. Its hash is the canonical plan hash: the canonical plan JSON already covers every step's
 * scope files, detail, verify command and revision, and the rendered view is bound separately through `planRef.mdSha`
 * and verified as an artifact. The CLI `--sha` and the typed `APPROVE <wid> <sha>` line therefore name this value.
 */
export function planSubject(wf: Pick<PlanWorkflow, "id" | "planRef">): Subject | null {
  return wf.planRef ? { kind: "plan", id: wf.id, sha256: wf.planRef.jsonSha } : null
}

export function sameSubject(a: Subject | null | undefined, b: Subject | null | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id && a.sha256 === b.sha256
}

/** True when the stored approval names exactly the plan's current subject. */
export function approvalIsCurrent(wf: PlanWorkflow): boolean {
  return !!wf.approval && sameSubject(wf.approval.subject, planSubject(wf))
}

export function unitTag(unit: Pick<ApprovedExecutionUnit, "parentWorkflowID" | "subject">): WorkflowTag {
  return { id: unit.parentWorkflowID, planSha: unit.subject.sha256 }
}

/**
 * Build the unit for an executing plan. Refuses unless the stored approval still names the current subject and the
 * rendered plan artifact verifies from disk. The canonical plan JSON is verified by `savedPlan` (it needs the
 * runtime's plan validator), which callers run alongside this.
 */
export function planUnit(wf: PlanWorkflow, options: { worktree: string; tasks?: readonly LedgerTask[] }): ApprovedExecutionUnit {
  if (wf.phase !== "executing") throw new Error(`workflow is ${wf.phase}, not executing`)
  const subject = planSubject(wf)
  if (!subject || !wf.approval || !approvalIsCurrent(wf)) throw new Error("approved plan or rendered file changed")
  for (const ref of planArtifactRefs(wf)) {
    if (verifyArtifact(options.worktree, ref).state !== "verified") throw new Error("approved plan or rendered file changed")
  }
  const tagged = (options.tasks ?? []).filter(task => task.wf?.id === wf.id && task.wf.planSha === subject.sha256)
  return Object.freeze({
    parentWorkflowID: wf.id,
    sessionID: wf.sessionID,
    subject: Object.freeze({ ...subject }),
    taskIds: Object.freeze([...(wf.taskIds ?? [])]),
    attempts: tagged.reduce((total, task) => total + task.attempts, 0),
    residualCheckpoint: wf.stopIntent?.checkpoint ?? null,
  })
}

/** Stages whose live work is an approved unit: ultragoal unit_execute/verify and the autoresearch run stage. */
const UNIT_STAGES: Readonly<Record<"ultragoal" | "autoresearch", readonly string[]>> = { ultragoal: ["unit_execute", "verify"], autoresearch: ["experiment_run"] }
const UNIT_SUBJECT_KIND = { ultragoal: "implementation-unit", autoresearch: "experiment-unit" } as const satisfies Record<"ultragoal" | "autoresearch", SubjectKind>
const UNIT_RECORD_KEY = { ultragoal: "current", autoresearch: "experiment" } as const

/**
 * The approved-unit record a non-plan workflow stores in its opaque `data`: the subject, the approval naming it, the
 * unit documents it is bound to, and (autoresearch) the run ids done and remaining. It is never authority on its own;
 * `unitFor` re-verifies the approval against the subject and the documents against disk.
 */
export type UnitRecord = {
  subject: Subject
  /** The exact inputs the subject hash was computed over (artifactHashes must equal the hashes of `artifacts`). */
  input: Omit<SubjectInput, "kind"> | null
  /** `receiptRef` is the typed APPROVE-UNIT / RUN choice receipt, verified bound to this workflow and subject. */
  approval: { subject: Subject; receiptRef: string | null }
  artifacts: ArtifactRef[]
  taskIds: string[]
  done: string[]
  remaining: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const isSubject = (value: unknown): value is Subject =>
  isObject(value) && typeof value.kind === "string" && typeof value.id === "string" && value.id.length > 0 && typeof value.sha256 === "string" && value.sha256.length > 0
const strings = (value: unknown): string[] => Array.isArray(value) && value.every(item => typeof item === "string") ? value as string[] : []

/** Tasks of a unit must be exactly the approved scope: one per step, titles and verify commands equal the subject's inputs. */
export function unitTaskProblem(record: UnitRecord, tasks: ReadonlyArray<{ title: string; verify?: string }>): string | null {
  if (!record.input) return "approved unit has no recorded inputs"
  const { scope, verification } = record.input
  if (tasks.length !== scope.length || tasks.some((task, index) => task.title !== scope[index] || task.verify !== verification[index])) {
    return "unit tasks differ from the approved subject"
  }
  return null
}

export function isUnitKind(kind: WorkflowEnvelope["kind"]): kind is "ultragoal" | "autoresearch" {
  return kind === "ultragoal" || kind === "autoresearch"
}

/** The unit record of an ultragoal/autoresearch envelope, or null when the data does not carry a well-formed one. */
export function unitRecord(wf: WorkflowEnvelope): UnitRecord | null {
  if (!isUnitKind(wf.kind)) return null
  const raw = (wf as { data: Record<string, unknown> }).data[UNIT_RECORD_KEY[wf.kind]]
  if (!isObject(raw) || !isSubject(raw.subject) || !isObject(raw.approval) || !isSubject(raw.approval.subject)) return null
  const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts.filter((item): item is ArtifactRef =>
    isObject(item) && typeof item.key === "string" && typeof item.path === "string" && typeof item.sha256 === "string") : []
  const i = raw.input
  const input = isObject(i) && typeof i.id === "string" && ["scope", "commands", "inputs", "allowedPaths", "verification", "sourceHashes", "artifactHashes"].every(key => Array.isArray(i[key]) && (i[key] as unknown[]).every(item => typeof item === "string"))
    ? { id: i.id, scope: strings(i.scope), commands: strings(i.commands), inputs: strings(i.inputs), allowedPaths: strings(i.allowedPaths), verification: strings(i.verification), sourceHashes: strings(i.sourceHashes), artifactHashes: strings(i.artifactHashes) }
    : null
  const receiptRef = typeof raw.approval.receiptRef === "string" ? raw.approval.receiptRef : null
  return { subject: raw.subject, input, approval: { subject: raw.approval.subject, receiptRef }, artifacts, taskIds: strings(raw.taskIds), done: strings(raw.done), remaining: strings(raw.remaining) }
}

/**
 * The subject an executing stop is taken against: plan -> plan subject; ultragoal unit_execute/verify -> the current
 * unit; autoresearch experiment_run -> the experiment. Null for every non-executing stage (nothing approved to protect).
 */
export function stopSubjectOf(wf: WorkflowEnvelope): Subject | null {
  if (wf.kind === "plan") return planSubject(wf)
  if (!isUnitKind(wf.kind) || !UNIT_STAGES[wf.kind].includes(wf.stage)) return null
  return unitRecord(wf)?.subject ?? null
}

/** The subject the stored approval names (plan or unit), regardless of whether it is still current. */
export function approvedSubjectOf(wf: WorkflowEnvelope): Subject | null {
  if (wf.kind === "plan") return wf.approval?.subject ?? null
  return unitRecord(wf)?.approval.subject ?? null
}

/** A unit's documents must be hash-bound, verify from disk, and stay within the document budget. */
function unitArtifactProblem(worktree: string, artifacts: readonly ArtifactRef[]): string | null {
  for (const ref of artifacts) {
    if (!ref.sha256) return `unit artifact ${ref.key} has no recorded hash`
    const verified = verifyArtifact(worktree, ref)
    if (verified.state !== "verified") return `unit artifact ${ref.key} is ${verified.state}: ${verified.reason}`
    if (!readArtifactBytes(join(worktree, ref.path), UNIT_DOC_MAX_BYTES).ok) return `unit artifact ${ref.key} exceeds ${UNIT_DOC_MAX_BYTES} bytes`
  }
  return null
}

const subjectFor = (kind: "implementation-unit" | "experiment-unit", input: Omit<SubjectInput, "kind">): Subject =>
  ({ kind, id: input.id, sha256: subjectSha256({ ...input, kind }) })

/** Implementation-unit subject (ultragoal): the hash covers steps, verify commands, files and every bound source. */
export const implementationUnitSubject = (input: Omit<SubjectInput, "kind">): Subject => subjectFor("implementation-unit", input)
/** Experiment-unit subject (autoresearch): the hash covers commands, params, mission and metric spec. */
export const experimentUnitSubject = (input: Omit<SubjectInput, "kind">): Subject => subjectFor("experiment-unit", input)

const APPROVAL_CHOICE = { ultragoal: "approve-unit", autoresearch: "run-experiment" } as const satisfies Record<"ultragoal" | "autoresearch", string>

/** A unit approval is exactly the typed choice of its kind and authorizes no execution by itself (`executed:false`). Any other choice receipt bound to the same subject (e.g. execute_confirmed) is not an approval. */
export function approvalBodyProblem(kind: "ultragoal" | "autoresearch", body: Readonly<Record<string, unknown>>): string | null {
  if (body.choice !== APPROVAL_CHOICE[kind]) return `is not a ${APPROVAL_CHOICE[kind]} choice`
  if (body.executed !== false) return "must record executed:false"
  return null
}

/**
 * Why a unit record is not currently approved, or null. The approval is never the stored flag alone: the subject is
 * recomputed from the stored inputs and the verified documents' hashes, at least one document must exist, and the
 * approval's choice receipt must read back bound to this workflow, session and exact subject hash.
 */
export function unitRecordProblem(wf: WorkflowEnvelope & { kind: "ultragoal" | "autoresearch" }, record: UnitRecord | null, worktree: string): string | null {
  if (!record) return "approved unit or its documents changed"
  if (record.subject.kind !== UNIT_SUBJECT_KIND[wf.kind] || !sameSubject(record.approval.subject, record.subject)) return "approved unit or its documents changed"
  if (record.artifacts.length === 0 || !record.input) return "approved unit has no bound documents"
  if (unitArtifactProblem(worktree, record.artifacts)) return "approved unit or its documents changed"
  const docHashes = record.artifacts.map(ref => ref.sha256 ?? "").sort()
  if (JSON.stringify([...record.input.artifactHashes].sort()) !== JSON.stringify(docHashes)) return "approved unit documents differ from the approved subject"
  const recomputed = subjectFor(UNIT_SUBJECT_KIND[wf.kind], record.input)
  if (!sameSubject(recomputed, record.subject)) return "approved subject does not match its inputs and documents"
  if (!record.approval.receiptRef) return "approved unit has no approval receipt"
  const read = verifyReceiptRef(worktree, record.approval.receiptRef, { sessionID: wf.sessionID, workflowID: wf.id, kind: "choice", inputSha: record.subject.sha256 })
  if (!read.ok) return `approval receipt: ${read.reason}`
  if (read.receipt.body.subjectSha !== record.subject.sha256 || read.receipt.body.subjectId !== record.subject.id) return "approval receipt names another subject"
  const problem = approvalBodyProblem(wf.kind, read.receipt.body)
  return problem ? `approval receipt: ${problem}` : null
}

function recordUnit(wf: WorkflowEnvelope & { kind: "ultragoal" | "autoresearch" }, options: { worktree: string; tasks?: readonly LedgerTask[] }): ApprovedExecutionUnit {
  if (wf.phase !== "executing") throw new Error(`workflow is ${wf.phase}, not executing`)
  const record = unitRecord(wf)
  if (!record || !UNIT_STAGES[wf.kind].includes(wf.stage) || unitRecordProblem(wf, record, options.worktree)) {
    throw new Error("approved unit or its documents changed")
  }
  const tagged = (options.tasks ?? []).filter(task => task.wf?.id === wf.id && task.wf.planSha === record.subject.sha256)
  return Object.freeze({
    parentWorkflowID: wf.id,
    sessionID: wf.sessionID,
    subject: Object.freeze({ ...record.subject }),
    taskIds: Object.freeze([...record.taskIds]),
    attempts: tagged.reduce((total, task) => total + task.attempts, 0),
    residualCheckpoint: wf.stopIntent?.checkpoint ?? null,
  })
}

/** The unit adapter: the one constructor of an ApprovedExecutionUnit for plan, ultragoal and autoresearch workflows. */
export function unitFor(wf: WorkflowEnvelope, options: { worktree: string; tasks?: readonly LedgerTask[] }): ApprovedExecutionUnit {
  if (wf.kind === "plan") return planUnit(wf, options)
  if (isUnitKind(wf.kind)) return recordUnit(wf as WorkflowEnvelope & { kind: "ultragoal" | "autoresearch" }, options)
  throw new Error(`${wf.kind} workflows have no execution unit`)
}

/** The unit must still describe the committed workflow: same parent, still executing, same approved subject. */
export function assertUnitCurrent(unit: ApprovedExecutionUnit, committed: WorkflowEnvelope): void {
  if (committed.id !== unit.parentWorkflowID || committed.sessionID !== unit.sessionID) throw new Error("workflow changed during foreground operation")
  if (committed.phase !== "executing" || !sameSubject(approvedSubjectOf(committed), unit.subject) || !sameSubject(stopSubjectOf(committed), unit.subject)) {
    throw new Error("approved plan changed during reconciliation")
  }
}
