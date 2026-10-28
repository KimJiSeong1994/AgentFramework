// Single-index commit protocol (P5a S2). Every workflow mutation is exactly one `commitRevision`:
//   1. events are durably appended (file + directory fsync),
//   2. an immutable snapshot sessions/<sid>/workflows/<wid>/revisions/<seq>.json is durably written (O_EXCL-style: an
//      existing file with other bytes is refused, identical bytes are idempotent),
//   3. the selected session index workflow.json {version,id,sessionID,kind,revision,path,sha256} is durably
//      replaced. The index rename is the commit point.
// Readers admit only the index-bound revision. Snapshots, plan artifacts and events above/outside the committed
// revision are orphans and never authority. Nothing here deletes: terminal history, superseded snapshots and
// retained legacy bytes stay on disk.
import { createHash } from "node:crypto"
import { lstatSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { readBoundedBytes, stateRoot } from "../state/store.ts"
import { workflowDirectory } from "../state/workflow-scope.ts"
import { durableWriteBytes, type DurableWriteStage } from "../state/durable.ts"
import {
  appendEventsDurable, CorruptWorkflowError, flowTxWorktree, flowTxSessionID, lastEventSeq, LegacyWorkflowError, readAllEventLines,
  type FlowEventLine, type FlowTx,
} from "../flow/state.ts"
import { parseEnvelope, requiredArtifactKeys } from "./registry.ts"
import { evidenceSummary as ultragoalEvidenceSummary, ultragoalEvidence } from "./ultragoal-evidence.ts"
import { autoresearchEvidence, evidenceSummary as autoresearchEvidenceSummary } from "./autoresearch-evidence.ts"
import { deepInterviewEvidence, evidenceSummary } from "./deep-interview-evidence.ts"
import { verifyArtifact } from "./artifacts.ts"
import { verifyReceiptRef } from "./receipts.ts"
import { ID_RE, PHASES, TERMINAL, type WorkflowEnvelope, type WorkflowIndex } from "./types.ts"

const INDEX_MAX = 64 * 1024
const SNAPSHOT_MAX = 1024 * 1024

export type CommitStage =
  | "events-fsync"
  | "archive-write"
  | "snapshot-write" | "snapshot-fsync" | "snapshot-rename" | "snapshot-dirfsync"
  | "index-write" | "index-fsync" | "index-rename" | "index-dirfsync"

let faultHook: ((stage: CommitStage) => void) | null = null

/** Test-only fault injection: the hook fires before each durable step and may throw to simulate a crash there. */
export function __setCommitFaultHook(hook: ((stage: CommitStage) => void) | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("commit fault injection is test-only")
  faultHook = hook
}

function fault(stage: CommitStage): void {
  faultHook?.(stage)
}

const indexPath = (worktree: string, sessionID?: string) => join(workflowDirectory(worktree, sessionID), "workflow.json")

export function snapshotRelativePath(sessionID: string, workflowID: string, revision: number): string {
  return `sessions/${sessionID}/workflows/${workflowID}/revisions/${revision}.json`
}

export function snapshotPath(worktree: string, index: Pick<WorkflowIndex, "sessionID" | "id" | "revision">): string {
  return join(stateRoot(worktree), snapshotRelativePath(index.sessionID, index.id, index.revision))
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function invalid(): never {
  throw new Error("invalid workflow state")
}

/** Strict pure parser for the v2 index. */
export function parseIndex(value: unknown): WorkflowIndex {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid()
  const v = value as Record<string, unknown>
  if (v.version !== 2 || typeof v.id !== "string" || !ID_RE.test(v.id) || typeof v.sessionID !== "string" || !ID_RE.test(v.sessionID) ||
    typeof v.kind !== "string" || !Number.isSafeInteger(v.revision) || (v.revision as number) < 0 ||
    typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256) ||
    v.path !== snapshotRelativePath(v.sessionID, v.id, v.revision as number)) invalid()
  return value as WorkflowIndex
}

/** Verify snapshot bytes against the index: hash, strict envelope parse, and identity cross-check. */
export function verifySnapshot(bytes: Buffer, index: WorkflowIndex): WorkflowEnvelope {
  if (sha256Hex(bytes) !== index.sha256) invalid()
  let wf: WorkflowEnvelope
  try { wf = parseEnvelope(JSON.parse(bytes.toString("utf8"))) }
  catch { invalid() }
  if (wf.id !== index.id || wf.sessionID !== index.sessionID || wf.kind !== index.kind || wf.lastSeq !== index.revision) invalid()
  return wf
}

export type CommittedRead =
  | { state: "none" }
  | { state: "ok"; wf: WorkflowEnvelope; index: WorkflowIndex; bytes: Buffer; bytesRead: number }
  | { state: "legacy"; terminal: boolean; id: string; revision: number; bytes: Buffer; bytesRead: number }
  | { state: "corrupt"; reason: string; code: "invalid" | "unreadable" | "oversize"; bytesRead: number }

/** A path chain below the state root must be real directories; a symlinked authority path is corrupt. */
function chainIsPlain(worktree: string, relative: string): boolean {
  let current = stateRoot(worktree)
  const parts = relative.split("/")
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    } catch { return false }
  }
  return true
}

function legacyShape(value: Record<string, unknown>): { terminal: boolean; id: string; revision: number } {
  const phase = value.phase
  const known = typeof phase === "string" && (PHASES as readonly string[]).includes(phase)
  const terminal = known && TERMINAL.has(phase as never) && typeof value.id === "string" && value.id.length > 0 &&
    typeof value.sessionID === "string" && Number.isSafeInteger(value.lastSeq) && (value.lastSeq as number) >= 0
  return {
    terminal,
    id: typeof value.id === "string" ? value.id : "",
    revision: Number.isSafeInteger(value.lastSeq) && (value.lastSeq as number) >= 0 ? value.lastSeq as number : 0,
  }
}

/** Read the committed workflow: index -> bounded no-follow snapshot read -> hash and identity checks. Never mutates. */
export function readCommitted(worktree: string, limits: { index?: number; snapshot?: number } = {}, sessionID?: string): CommittedRead {
  const path = indexPath(worktree, sessionID)
  const failure = (error: unknown, what: string, bytesRead: number): CommittedRead => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code === "oversize" ? "oversize" as const : "unreadable" as const
    const extra = (error as { bytesRead?: unknown }).bytesRead
    return { state: "corrupt", reason: `${what}: ${(error as Error).message}`, code, bytesRead: bytesRead + (typeof extra === "number" ? extra : 0) }
  }
  let raw: Buffer | undefined
  let rawBytes = 0
  try { ({ bytes: raw, bytesRead: rawBytes } = readBoundedBytes(path, limits.index ?? INDEX_MAX)) }
  catch (error) { return failure(error, "index unreadable", 0) }
  if (raw === undefined) return { state: "none" }
  if (!chainIsPlain(worktree, relative(stateRoot(worktree), path))) return { state: "corrupt", reason: "index path is not a plain directory chain", code: "invalid", bytesRead: rawBytes }
  let value: unknown
  try { value = JSON.parse(raw.toString("utf8")) }
  catch { return { state: "corrupt", reason: "index is not valid JSON", code: "invalid", bytesRead: rawBytes } }
  if (value !== null && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).version === 1) {
    if (sessionID !== undefined && (value as Record<string, unknown>).sessionID !== sessionID) return { state: "corrupt", reason: "legacy workflow belongs to another session", code: "invalid", bytesRead: rawBytes }
    return { state: "legacy", bytes: raw, bytesRead: rawBytes, ...legacyShape(value as Record<string, unknown>) }
  }
  let index: WorkflowIndex
  try { index = parseIndex(value) }
  catch { return { state: "corrupt", reason: "index is malformed", code: "invalid", bytesRead: rawBytes } }
  if (sessionID !== undefined && index.sessionID !== sessionID) return { state: "corrupt", reason: "index belongs to another session", code: "invalid", bytesRead: rawBytes }
  if (!chainIsPlain(worktree, index.path)) return { state: "corrupt", reason: "snapshot path is not a plain directory chain", code: "invalid", bytesRead: rawBytes }
  let bytes: Buffer | undefined
  let snapshotBytes = 0
  try { ({ bytes, bytesRead: snapshotBytes } = readBoundedBytes(snapshotPath(worktree, index), limits.snapshot ?? SNAPSHOT_MAX)) }
  catch (error) { return failure(error, "indexed snapshot unreadable", rawBytes) }
  if (bytes === undefined) return { state: "corrupt", reason: "indexed snapshot is missing", code: "invalid", bytesRead: rawBytes }
  try { return { state: "ok", wf: verifySnapshot(bytes, index), index, bytes, bytesRead: rawBytes + snapshotBytes } }
  catch (error) { return { state: "corrupt", reason: `indexed snapshot rejected: ${(error as Error).message}`, code: "invalid", bytesRead: rawBytes + snapshotBytes } }
}

// ------------------------------------------------------------------ event admission
/** Which events count as committed work: sequence at or below the committed revision, minus recorded orphans. */
export type SeqRange = readonly [number, number]
export type EventBound = { all: true } | { revision: number; orphans: ReadonlyArray<SeqRange> }

export function eventBoundOf(wf: { lastSeq: number; orphanedEvents?: ReadonlyArray<SeqRange> }): EventBound {
  return { revision: wf.lastSeq, orphans: wf.orphanedEvents ?? [] }
}

/** Sort and merge overlapping or adjacent inclusive ranges, so consecutive failed commits cost one entry. */
export function mergeRanges(ranges: ReadonlyArray<SeqRange>): Array<[number, number]> {
  const sorted = ranges.map(([a, b]) => [a, b] as [number, number]).sort((x, y) => x[0] - y[0])
  const out: Array<[number, number]> = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1])
    else out.push(range)
  }
  return out
}

/** Audit-only lines (boundary denials) are admitted regardless of revision; they never confer authority. */
export function eventAdmitted(bound: EventBound, event: Pick<FlowEventLine, "seq" | "audit">): boolean {
  if (event.audit === true) return true
  if ("all" in bound) return true
  return event.seq <= bound.revision && !bound.orphans.some(([first, last]) => event.seq >= first && event.seq <= last)
}

export function committedEventBound(worktree: string, sessionID?: string): EventBound {
  const committed = readCommitted(worktree, {}, sessionID)
  switch (committed.state) {
    case "ok": return eventBoundOf(committed.wf)
    case "none": return { revision: 0, orphans: [] }
    case "legacy": return { all: true }
    case "corrupt": return { revision: 0, orphans: [] }
  }
}

// ------------------------------------------------------------------ retained copies
function writeRetained(path: string, bytes: Buffer): void {
  let existing: Buffer | undefined
  try { existing = readBoundedBytes(path, SNAPSHOT_MAX).bytes }
  catch (error) { throw new CorruptWorkflowError(path, `retained workflow file ${path} is unreadable: ${(error as Error).message}`) }
  if (existing) {
    if (existing.equals(bytes)) return
    throw new CorruptWorkflowError(path, `retained workflow file ${path} already exists with different bytes; refusing overwrite`)
  }
  durableWriteBytes(path, bytes)
}

/** Derived history copy used by status; byte-identical to the committed snapshot. */
export function writeArchiveCopy(worktree: string, wf: WorkflowEnvelope, sessionID?: string): void {
  writeRetained(join(workflowDirectory(worktree, sessionID), "archive", `${wf.id}.json`), Buffer.from(`${JSON.stringify(wf)}\n`, "utf8"))
}

/** Preserve a terminal pre-v2 inline record byte-for-byte; it is never deleted or converted. */
export function legacyArchive(worktree: string, id: string, bytes: Buffer, sessionID?: string): void {
  writeRetained(join(workflowDirectory(worktree, sessionID), "legacy", `${id}.v1.json`), bytes)
}

// ------------------------------------------------------------------ commit
export type CommitEvent = Omit<FlowEventLine, "seq" | "at"> & { at?: number }

function stageHook(prefix: "snapshot" | "index"): (stage: DurableWriteStage) => void {
  return (stage) => fault(`${prefix}-${stage}` as CommitStage)
}

/**
 * The only workflow writer. Appends `events` (at least one: the committed revision is the last event seq),
 * publishes an immutable snapshot, then replaces the index. A failure at any step leaves the previous index
 * (and therefore the previous coherent revision) authoritative; events and snapshots written so far are orphans.
 */
export function commitRevision(tx: FlowTx, wf: WorkflowEnvelope, events: CommitEvent[], now = Date.now(), options: CommitOptions = {}): WorkflowEnvelope {
  const worktree = flowTxWorktree(tx)
  const sessionID = flowTxSessionID(tx)
  if (sessionID !== undefined && wf.sessionID !== sessionID) throw new Error("workflow commit belongs to another session")
  if (events.length === 0) throw new TypeError("a workflow commit must append at least one event")
  if (!ID_RE.test(wf.id) || !ID_RE.test(wf.sessionID)) throw new Error("invalid workflow identity")
  const current = readCommitted(worktree, {}, sessionID)
  const path = indexPath(worktree, sessionID)
  if (current.state === "corrupt") throw new CorruptWorkflowError(path)
  if (current.state === "legacy") {
    if (!current.terminal) throw new LegacyWorkflowError(path)
    if (current.id === wf.id || !ID_RE.test(current.id)) throw new LegacyWorkflowError(path)
  }
  if (current.state === "ok") {
    if (current.wf.id !== wf.id) {
      if (!TERMINAL.has(current.wf.phase)) throw new Error(`workflow ${current.wf.id} still occupies the slot; refusing to commit ${wf.id}`)
    } else if (current.wf.lastSeq !== wf.lastSeq || current.wf.sessionID !== wf.sessionID || current.wf.kind !== wf.kind) {
      throw new Error(`workflow ${wf.id} changed meanwhile; refusing stale commit`)
    }
  }
  // A new slot occupant starts from a zero baseline: its first revision is the seq of its own first commit event.
  if ((current.state !== "ok" || current.wf.id !== wf.id) && wf.lastSeq !== 0) {
    throw new Error(`workflow ${wf.id} must start from lastSeq 0 in a new slot`)
  }

  verifyCommitEvidence(worktree, wf, options.receipts ?? [])

  // Cutover baseline: a terminal pre-v2 record's revision is the last seq its own events used, so every older row
  // (including other pre-v2 workflows) stays admitted history and only rows above it can be precommit orphans.
  const previousRevision = current.state === "ok" ? current.wf.lastSeq : current.state === "legacy" ? Math.max(current.revision, lastEventSeq(worktree, sessionID)) : 0
  const carried: SeqRange[] = current.state === "ok" ? current.wf.orphanedEvents ?? [] : []
  const fresh: SeqRange[] = []
  // Non-audit events above the previous committed revision belong to a commit that never reached the index.
  for (const line of readAllEventLines(worktree, sessionID)) {
    if (line.seq > previousRevision && line.audit !== true) fresh.push([line.seq, line.seq])
  }
  const orphans = mergeRanges([...carried, ...fresh])

  const seq = appendEventsDurable(tx, events, now, () => fault("events-fsync"))
  const { orphanedEvents: _carried, ...rest } = wf
  const next = {
    ...rest,
    owner: { instance: wf.owner.instance, pid: wf.owner.pid },
    lastSeq: seq,
    updatedAt: now,
    ...(orphans.length > 0 ? { orphanedEvents: orphans } : {}),
  } as WorkflowEnvelope
  parseEnvelope(next)

  const { relative, bytes } = writeSnapshot(worktree, next, seq)

  if (current.state === "legacy") legacyArchive(worktree, current.id, current.bytes, sessionID)
  const index: WorkflowIndex = { version: 2, id: next.id, sessionID: next.sessionID, kind: next.kind, revision: seq, path: relative, sha256: sha256Hex(bytes) }
  durableWriteBytes(path, Buffer.from(`${JSON.stringify(index)}\n`, "utf8"), stageHook("index"))
  return next
}


/** Receipt references introduced by this commit; each is read back and verified against the workflow before publish. */
export type CommitOptions = { receipts?: readonly string[] }

/**
 * Evidence gate inside the commit transaction, before any durable step: every artifact the target stage/phase requires
 * must be listed with a hash and verify from disk, and every new receipt ref must read back bound to this workflow.
 * A refusal leaves the previous index authoritative and writes nothing.
 */
function verifyCommitEvidence(worktree: string, wf: WorkflowEnvelope, receipts: readonly string[]): void {
  for (const key of requiredArtifactKeys(wf)) {
    const ref = wf.artifacts.find(item => item.key === key)
    if (!ref) throw new Error(`required artifact ${key} is not recorded; refusing commit`)
    if (ref.sha256 === undefined) throw new Error(`required artifact ${key} has no recorded hash; refusing commit`)
    const result = verifyArtifact(worktree, ref)
    if (result.state !== "verified") throw new Error(`required artifact ${key} is ${result.state}: ${result.reason}; refusing commit`)
  }
  if (wf.kind === "deep-interview" && wf.phase === "done") {
    // A finished interview rests on every panel/closure/choice record: re-verified in this transaction (W1/W7).
    const evidence = deepInterviewEvidence(worktree, wf)
    if (evidence.problems.length > 0) throw new Error(`deep-interview evidence ${evidenceSummary(evidence)}; refusing commit`)
  }
  if (wf.kind === "ultragoal" && wf.phase === "done") {
    // A finished ultragoal rests on EVERY goal's current complete checkpoint, its verification and approval receipts, the
    // final review and completion.json: all re-verified from disk in this transaction (W7). A critic OKAY alone is not enough.
    const evidence = ultragoalEvidence(worktree, wf, { final: true })
    if (evidence.problems.length > 0) throw new Error(`ultragoal evidence ${ultragoalEvidenceSummary(evidence)}; refusing commit`)
  }
  if (wf.kind === "autoresearch" && (wf.phase === "done" || (wf.phase === "stuck" && wf.stage === "terminal"))) {
    // A finished autoresearch rests on EVERY recorded run (file, verification and approval receipts) and a verdict whose
    // evidence is a subset of those verified runs; a conclusive one needs a valid run and a critic OKAY (W7).
    const evidence = autoresearchEvidence(worktree, wf, { final: true })
    if (evidence.problems.length > 0) throw new Error(`autoresearch evidence ${autoresearchEvidenceSummary(evidence)}; refusing commit`)
  }
  for (const ref of receipts) {
    const result = verifyReceiptRef(worktree, ref, { sessionID: wf.sessionID, workflowID: wf.id })
    if (!result.ok) throw new Error(`receipt ${ref.split("#")[0]} refused: ${result.reason}`)
  }
}

function writeSnapshot(worktree: string, next: WorkflowEnvelope, seq: number): { relative: string; bytes: Buffer } {
  const bytes = Buffer.from(`${JSON.stringify(next)}\n`, "utf8")
  const relative = snapshotRelativePath(next.sessionID, next.id, seq)
  const target = join(stateRoot(worktree), relative)
  let existing: Buffer | undefined
  try { existing = readBoundedBytes(target, SNAPSHOT_MAX).bytes }
  catch (error) { throw new CorruptWorkflowError(target, `workflow snapshot ${target} is unreadable: ${(error as Error).message}`) }
  if (existing && !existing.equals(bytes)) {
    throw new CorruptWorkflowError(target, `workflow snapshot ${target} already exists with different bytes; refusing overwrite`)
  }
  if (!existing) durableWriteBytes(target, bytes, stageHook("snapshot"))
  return { relative, bytes }
}

function orphansAbove(worktree: string, carried: readonly SeqRange[], previousRevision: number, sessionID?: string): Array<[number, number]> {
  const fresh: SeqRange[] = []
  // Non-audit events above the previous committed revision belong to a commit that never reached the index.
  for (const line of readAllEventLines(worktree, sessionID)) {
    if (line.seq > previousRevision && line.audit !== true) fresh.push([line.seq, line.seq])
  }
  return mergeRanges([...carried, ...fresh])
}

export type HandoffInput = {
  /** The predecessor in its terminal form (phase done, stage terminal); `lastSeq` is the committed revision it replaces. */
  predecessor: WorkflowEnvelope
  /** Key of the predecessor artifact (the verified spec) the successor is seeded from. */
  artifactKey: string
  /** The successor at `lastSeq` 0 without lineage; the commit stamps the lineage. */
  successor: WorkflowEnvelope
  predecessorEvents: CommitEvent[]
  successorEvents: CommitEvent[]
  /** Narrow P6b productification seam: autoresearch terminal stuck may seed a deep-interview. */
  allowStuckPredecessor?: boolean
  /** Narrow P6b productification seam: an already-terminal autoresearch may still be replaced by its seeded DI. */
  allowTerminalPredecessor?: boolean
}

/**
 * Atomic predecessor -> successor swap (DI -> ralplan). Both workflows' events go in one append, both snapshots are
 * written and the predecessor's archive copy retained, and then ONE index rename binds the successor. A crash at any
 * earlier step leaves the predecessor index-bound at its old revision (retry is idempotent: identical snapshot bytes
 * are accepted and extra events are orphans); there is never a gap, two active workflows, or a free slot.
 * Caller-level admission checks (held session, pending stop, live epoch) belong to the caller and run in the same
 * flow transaction; this function enforces everything derivable from the committed state.
 */
export function commitHandoff(tx: FlowTx, input: HandoffInput, now = Date.now()): { predecessor: WorkflowEnvelope; successor: WorkflowEnvelope } {
  const worktree = flowTxWorktree(tx)
  const sessionID = flowTxSessionID(tx)
  const { predecessor, successor } = input
  if (sessionID !== undefined && (predecessor.sessionID !== sessionID || successor.sessionID !== sessionID)) throw new Error("workflow handoff belongs to another session")
  if (input.predecessorEvents.length === 0 || input.successorEvents.length === 0) throw new TypeError("a handoff must append events for both workflows")
  if (!ID_RE.test(predecessor.id) || !ID_RE.test(successor.id) || predecessor.id === successor.id) throw new Error("invalid handoff identity")
  if (successor.lastSeq !== 0) throw new Error(`workflow ${successor.id} must start from lastSeq 0 in a new slot`)
  if (successor.lineage !== undefined) throw new Error("handoff lineage is stamped by the commit")
  if (successor.sessionID !== predecessor.sessionID) throw new Error("handoff refused: successor belongs to another session")
  const donePredecessor = predecessor.phase === "done" && predecessor.stage === "terminal"
  const allowedStuckPredecessor = input.allowStuckPredecessor === true && predecessor.kind === "autoresearch" && successor.kind === "deep-interview" &&
    predecessor.phase === "stuck" && predecessor.stage === "terminal"
  if (!donePredecessor && !allowedStuckPredecessor) throw new Error("handoff requires the predecessor in its done terminal form")
  if (TERMINAL.has(successor.phase) || successor.stopIntent !== null) throw new Error("handoff successor must start live")
  if (successor.owner.instance !== predecessor.owner.instance || successor.owner.pid !== predecessor.owner.pid) throw new Error("handoff refused: owner epoch differs")

  const current = readCommitted(worktree, {}, sessionID)
  const path = indexPath(worktree, sessionID)
  if (current.state === "corrupt") throw new CorruptWorkflowError(path)
  if (current.state === "legacy") throw new LegacyWorkflowError(path)
  if (current.state !== "ok") throw new Error("handoff refused: no committed predecessor")
  const committed = current.wf
  if (committed.id !== predecessor.id || committed.sessionID !== predecessor.sessionID || committed.kind !== predecessor.kind ||
      committed.lastSeq !== predecessor.lastSeq) throw new Error(`workflow ${predecessor.id} changed meanwhile; refusing stale handoff`)
  const terminalProductify = input.allowTerminalPredecessor === true && predecessor.kind === "autoresearch" && successor.kind === "deep-interview" &&
    TERMINAL.has(committed.phase)
  if (TERMINAL.has(committed.phase) && !terminalProductify) throw new Error("handoff refused: predecessor is already terminal")
  if (committed.stopIntent !== null || committed.phase === "paused") throw new Error("handoff refused: a stop is pending or settled")
  if (committed.owner.instance !== predecessor.owner.instance || committed.owner.pid !== predecessor.owner.pid) throw new Error("handoff refused: owner epoch changed")

  const artifact = predecessor.artifacts.find(item => item.key === input.artifactKey)
  if (!artifact?.sha256) throw new Error(`handoff artifact ${input.artifactKey} is not recorded with a hash`)
  verifyCommitEvidence(worktree, predecessor, [])
  const seeded = verifyArtifact(worktree, artifact)
  if (seeded.state !== "verified") throw new Error(`handoff artifact ${input.artifactKey} is ${seeded.state}: ${seeded.reason}; refusing handoff`)

  const orphans = orphansAbove(worktree, committed.orphanedEvents ?? [], committed.lastSeq, sessionID)
  const events = [...input.predecessorEvents, ...input.successorEvents]
  const lastSeq = appendEventsDurable(tx, events, now, () => fault("events-fsync"))
  const predecessorSeq = lastSeq - input.successorEvents.length
  const { orphanedEvents: _p, ...predecessorRest } = predecessor
  const doneEnvelope = {
    ...predecessorRest, owner: { instance: predecessor.owner.instance, pid: predecessor.owner.pid },
    lastSeq: predecessorSeq, updatedAt: now, ...(orphans.length > 0 ? { orphanedEvents: orphans } : {}),
  } as WorkflowEnvelope
  parseEnvelope(doneEnvelope)
  const { orphanedEvents: _s, ...successorRest } = successor
  const successorEnvelope = {
    ...successorRest, owner: { instance: successor.owner.instance, pid: successor.owner.pid },
    lastSeq, updatedAt: now,
    lineage: { predecessor: { id: predecessor.id, kind: predecessor.kind, revision: predecessorSeq, artifact: { path: artifact.path, sha256: artifact.sha256 } } },
    ...(orphans.length > 0 ? { orphanedEvents: orphans } : {}),
  } as WorkflowEnvelope
  parseEnvelope(successorEnvelope)

  writeSnapshot(worktree, doneEnvelope, predecessorSeq)
  const next = writeSnapshot(worktree, successorEnvelope, lastSeq)
  fault("archive-write")
  // The committed occupant was non-terminal, so any existing archive/<id>.json is the derived copy of a failed earlier
  // attempt (an orphan revision); the derived copy is replaced rather than refused, and is rewritten on every retry.
  durableWriteBytes(join(workflowDirectory(worktree, sessionID), "archive", `${doneEnvelope.id}.json`), Buffer.from(`${JSON.stringify(doneEnvelope)}\n`, "utf8"))
  const index: WorkflowIndex = { version: 2, id: successorEnvelope.id, sessionID: successorEnvelope.sessionID, kind: successorEnvelope.kind, revision: lastSeq, path: next.relative, sha256: sha256Hex(next.bytes) }
  durableWriteBytes(path, Buffer.from(`${JSON.stringify(index)}\n`, "utf8"), stageHook("index"))
  return { predecessor: doneEnvelope, successor: successorEnvelope }
}

// ------------------------------------------------------------------ session-bound restore read
export type SessionCommitted = { wf: WorkflowEnvelope; path: string; sha256: string; current: boolean }

/**
 * Restore path for a session: its own committed workflow or its retained terminal history. An index that binds
 * another session's workflow is observed, never adopted.
 */
export function readSessionCommitted(worktree: string, sessionID: string): SessionCommitted | null {
  const committed = readCommitted(worktree, {}, sessionID)
  if (committed.state === "ok" && committed.wf.sessionID === sessionID) {
    return { wf: committed.wf, path: committed.index.path, sha256: committed.index.sha256, current: true }
  }
  if (committed.state === "corrupt" || committed.state === "legacy" && !committed.terminal) return null
  const roots = [...new Set([workflowDirectory(worktree, sessionID), workflowDirectory(worktree)])].map(dir => join(dir, "archive"))
  let best: SessionCommitted | null = null
  for (const root of roots) {
    let names: string[]
    try { names = readdirSync(root).filter((name) => name.endsWith(".json")).sort() }
    catch { continue }
    for (const name of names) {
      try {
        const { bytes } = readBoundedBytes(join(root, name), SNAPSHOT_MAX)
        if (!bytes) continue
        const wf = parseEnvelope(JSON.parse(bytes.toString("utf8")))
        if (wf.sessionID !== sessionID || !TERMINAL.has(wf.phase)) continue
        const relative = snapshotRelativePath(wf.sessionID, wf.id, wf.lastSeq)
        const snapshot = readBoundedBytes(join(stateRoot(worktree), relative), SNAPSHOT_MAX).bytes
        if (!snapshot || !snapshot.equals(bytes) || !chainIsPlain(worktree, relative)) continue
        if (!best || wf.updatedAt >= best.wf.updatedAt) best = { wf, path: relative, sha256: sha256Hex(snapshot), current: false }
      } catch { continue }
    }
  }
  return best
}
