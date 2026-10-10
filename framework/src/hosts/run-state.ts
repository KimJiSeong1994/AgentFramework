import { randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { executionRunDirectory } from "../state/store.ts"
import type { VerificationProfile, VerificationReference, VerificationResult } from "../orchestration/verifier.ts"
import { EXECUTION_ROLES, type ExecutionReference, type ExecutionRole } from "./types.ts"
import { authenticateLinuxVerification } from "./linux-domain.ts"

export type ExecutionClaim = { ownerSession: string; instance: string; pid: number; generation: number; token: string }
export type ExecutionIntent = {
  executionId: string; ownerSession: string; taskId: string; attemptId: string; generation: number; role: string; cwd: string; policyID: string
  kind?: "host" | "verifier"
  engine?: string
  profile?: VerificationProfile
  inputSnapshotID?: string
  inputDigest?: string
  deadlineAt?: number
  maxOutputChars?: number
}
export type ExecutionRecord = ExecutionIntent & {
  vendorRef?: string
  boundaryRef?: ExecutionReference | VerificationReference
  descendantRisk?: "unproven"
  verifierDispatch?: "prepared" | "started" | "retired"
  hostDispatch?: "started"
  cancel?: { requestedAt: number; acknowledgedAt?: number }
  terminal?: { outcome: string; terminalAt?: number; quiescentAt?: number; verification?: VerificationResult }
  fence?: { reason: string; at: number }
  reconciliation?: { outcome: "running" | "terminal" | "unknown"; quiescent: boolean; evidence: string; at: number; verification?: VerificationResult }
  usage?: "unknown"
  processRisk?: { tool: "bash"; at: number }
}
export type ExecutionRunStatus = { generation: number; claim?: Omit<ExecutionClaim, "token">; executions: ExecutionRecord[] }
export type HostRecoveryContext = {
  executionID: string
  engine: string
  ownerSession: string
  cwd: string
  role: ExecutionRole
  policyID: string
  profile: VerificationProfile
  processRisk: boolean
}
export class ExecutionRunBusyError extends Error {}
export class ExecutionRunUnresolvedError extends Error {}
export class ExecutionRunCorruptError extends Error {}

export interface ExecutionRunStore {
  claim(ownerSession: string, instance: string, pid: number): ExecutionClaim
  registerIntent(claim: ExecutionClaim, execution: ExecutionIntent): void
  bindVendorRef(claim: ExecutionClaim, executionId: string, vendorRef: string): void
  bindVerifierRef(claim: ExecutionClaim, executionId: string, reference: VerificationReference): void
  markVerifierDispatched(claim: ExecutionClaim, executionId: string): void
  markHostDispatched(claim: ExecutionClaim, executionId: string): void
  retireUndispatchedVerifier(claim: ExecutionClaim, executionId: string): void
  markProcessRiskBySession(sessionID: string, expectedEngine: string): void
  recordCancel(claim: ExecutionClaim, executionId: string, value: { requestedAt: number; acknowledgedAt?: number }): void
  recordTerminal(claim: ExecutionClaim, executionId: string, value: { outcome: string; terminalAt?: number; quiescentAt?: number; verification?: VerificationResult }): void
  fence(claim: ExecutionClaim, executionId: string, reason: string): void
  reconcile(claim: ExecutionClaim, executionId: string, value: { outcome: "running" | "terminal" | "unknown"; quiescent: boolean; evidence: string; verification?: VerificationResult }): void
  assertQuiescent(claim: ExecutionClaim): void
  release(claim: ExecutionClaim): void
  status(): ExecutionRunStatus
}

type State = ExecutionRunStatus & { claim?: ExecutionClaim }
const empty = (): State => ({ generation: 0, executions: [] })
const bounded = (s: string, label: string): void => {
  if (typeof s !== "string" || !s.length || s.length > 512) throw new TypeError(`invalid ${label}`)
}
const sameBoundary = (e: ExecutionRecord, ref: VerificationReference): boolean => {
  const bound = e.boundaryRef as VerificationReference | undefined
  return !!bound && ref.executionID === e.executionId && ref.profile === e.profile &&
    ref.invocationID === bound.invocationID && ref.inputSnapshotID === bound.inputSnapshotID &&
    ref.inputDigest === bound.inputDigest && ref.deadlineAt === bound.deadlineAt &&
    ref.maxOutputChars === bound.maxOutputChars && ref.unit === bound.unit &&
    ref.bootID === bound.bootID && isDeepStrictEqual(ref, bound)
}
// Only authenticated root-gate retirement can establish owned verifier quiescence.
const verifiedBoundary = (e: ExecutionRecord, result?: VerificationResult): boolean => !!result &&
  result.profile === e.profile && result.isolationEstablished && result.domainState === "empty" &&
  !!result.proof && sameBoundary(e, result.proof.reference) &&
  authenticateLinuxVerification(result, result.proof.reference)
export const strictQuiescent = (e: ExecutionRecord): boolean => {
  if (!e.kind || !e.profile || e.processRisk || (e.kind === "verifier" && e.fence)) return false
  if (e.kind === "verifier" && e.profile === "legacy-unowned") return false
  // A host ACK/terminal timestamp is not an owned-domain retirement proof.
  // Linux host executions remain fenced until a host boundary authenticates retirement.
  if (e.kind === "host" && e.profile === "linux-single-use") return false
  const terminal = !!e.terminal?.quiescentAt && (e.kind === "host" || verifiedBoundary(e, e.terminal.verification))
  const reconciled = e.reconciliation?.outcome === "terminal" && e.reconciliation.quiescent &&
    (e.kind === "host" || verifiedBoundary(e, e.reconciliation.verification))
  return !!(terminal || reconciled)
}
// The caller persists `started` before run(), so an explicit prepared->retired transition proves no launch.
const retiredBeforeDispatch = (e: ExecutionRecord): boolean => e.kind === "verifier" &&
  e.verifierDispatch === "retired" && e.terminal?.outcome === "not-dispatched" &&
  typeof e.terminal.terminalAt === "number" && Number.isFinite(e.terminal.terminalAt) && e.terminal.terminalAt >= 0 &&
  !e.terminal.verification && e.terminal.quiescentAt === undefined && !e.fence && !e.processRisk &&
  e.reconciliation?.outcome !== "running"
// This preserves the documented parent-exit workflow only; it is not descendant-retirement proof.
const ordinaryLegacyTerminal = (e: ExecutionRecord): boolean => {
  if (e.kind !== "verifier" || e.profile !== "legacy-unowned" || e.verifierDispatch !== "started" ||
    e.descendantRisk !== "unproven" || e.cancel || e.fence || e.processRisk || e.reconciliation?.outcome === "running" ||
    !e.terminal || (e.terminal.outcome !== "ok" && e.terminal.outcome !== "fail") ||
    typeof e.terminal.terminalAt !== "number" || !Number.isFinite(e.terminal.terminalAt) || e.terminal.terminalAt < 0) return false
  const result = e.terminal.verification
  const reference = e.boundaryRef
  return !!result && verificationShape(result) && result.profile === "legacy-unowned" && result.parentExit !== null &&
    !result.timedOut && !result.cancelled && !!reference && "kind" in reference &&
    verifierRefShape(reference) && reference.kind === "verifier" && reference.executionID === e.executionId &&
    reference.profile === e.profile && reference.inputSnapshotID === e.inputSnapshotID &&
    reference.inputDigest === e.inputDigest && reference.deadlineAt === e.deadlineAt &&
    reference.maxOutputChars === e.maxOutputChars &&
    ((e.terminal.outcome === "ok" && result.parentExit === 0) ||
      (e.terminal.outcome === "fail" && result.parentExit > 0))
}
export const settled = (e: ExecutionRecord): boolean => strictQuiescent(e) || retiredBeforeDispatch(e) || ordinaryLegacyTerminal(e)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
const optional = (value: Record<string, unknown>, key: string, check: (value: unknown) => boolean) => !(key in value) || check(value[key])
const profileShape = (value: unknown): value is VerificationProfile => value === "legacy-unowned" || value === "linux-single-use"
const hostReferenceIDs = ["vendorSessionID", "vendorThreadID", "vendorTurnID"] as const
const preparedHostReferenceKeys = new Set(["executionID", ...hostReferenceIDs])
const hostRefShape = (value: unknown): value is ExecutionReference => object(value) && text(value.executionID) &&
  optional(value, "vendorSessionID", text) && optional(value, "vendorThreadID", text) && optional(value, "vendorTurnID", text) && !("kind" in value)
export const hostReferenceHasVendorID = (value: unknown): boolean => object(value) &&
  hostReferenceIDs.some(key => text(value[key]))
export function persistedHostReference(record: ExecutionRecord): ExecutionReference | undefined {
  if (record.kind !== "host" || !text(record.vendorRef) || !hostRefShape(record.boundaryRef)) return undefined
  let reference: unknown
  try { reference = JSON.parse(record.vendorRef) }
  catch { return undefined }
  if (!hostRefShape(reference) || !hostReferenceHasVendorID(reference) || reference.executionID !== record.executionId ||
    !isDeepStrictEqual(reference, record.boundaryRef)) return undefined
  return reference
}
export function assertPreparedHostReference(value: unknown, executionID: string): asserts value is ExecutionReference {
  if (!object(value) || value.executionID !== executionID) {
    throw new TypeError("execution host returned an invalid reference")
  }
  const referenceKeys = Reflect.ownKeys(value)
  const enumerableKeys = Object.keys(value)
  const hasVendorID = hostReferenceHasVendorID(value)
  if (referenceKeys.length !== enumerableKeys.length
    || referenceKeys.some(key => typeof key !== "string" || !preparedHostReferenceKeys.has(key))
    || !enumerableKeys.includes("executionID")
    || (hasVendorID && !hostRefShape(value))
    || (!hasVendorID && (enumerableKeys.length !== 1 || enumerableKeys[0] !== "executionID"))) {
    throw new TypeError("execution host returned an invalid reference")
  }
}
const verifierRefShape = (value: unknown): value is VerificationReference => object(value) && value.kind === "verifier" &&
  text(value.executionID) && profileShape(value.profile) && text(value.invocationID) && text(value.inputSnapshotID) &&
  typeof value.inputDigest === "string" && /^[a-f0-9]{64}$/.test(value.inputDigest) && timestamp(value.deadlineAt) &&
  integer(value.maxOutputChars) && value.maxOutputChars <= 65536 &&
  optional(value, "unit", text) && optional(value, "bootID", text) && !("cgroupInode" in value) &&
  (value.profile === "legacy-unowned" || (value.unit === "lca-verifier.service" && text(value.bootID)))
const verificationShape = (value: unknown): value is VerificationResult => object(value) && profileShape(value.profile) &&
  (value.parentExit === null || Number.isSafeInteger(value.parentExit)) && typeof value.timedOut === "boolean" &&
  typeof value.cancelled === "boolean" && typeof value.isolationEstablished === "boolean" &&
  ["active", "empty", "unknown"].includes(value.domainState as string) &&
  ["unchanged", "changed", "unknown"].includes(value.integrity as string) &&
  typeof value.output === "string" && value.output.length <= 65536 &&
  optional(value, "proof", x => object(x) && verifierRefShape(x.reference) && text(x.evidence) &&
    optional(x, "receipt", y => typeof y === "string" && y.length > 0 && Buffer.byteLength(y, "utf8") <= 16384) &&
    optional(x, "signature", text)) &&
  (value.profile !== "legacy-unowned" || (!value.isolationEstablished && value.domainState === "unknown"))
const validProof = (record: ExecutionRecord, result: VerificationResult): boolean => result.profile === record.profile &&
  (!result.proof || sameBoundary(record, result.proof.reference))
const verifierTerminalShape = (record: ExecutionRecord, terminal: Record<string, unknown>): boolean => {
  if (terminal.outcome === "not-dispatched") {
    return record.kind === "verifier" && record.verifierDispatch === "retired" &&
      timestamp(terminal.terminalAt) && terminal.verification === undefined && terminal.quiescentAt === undefined
  }
  if (record.kind !== "verifier") return true
  if (!["ok", "fail", "timeout", "killed", "unknown"].includes(terminal.outcome as string)) return false
  if (terminal.outcome === "unknown") return true
  if (!verificationShape(terminal.verification) || !verifierRefShape(record.boundaryRef) ||
    terminal.verification.output.length > (record.maxOutputChars as number)) return false
  const result = terminal.verification
  if (terminal.outcome === "ok") return result.parentExit === 0 && !result.timedOut && !result.cancelled
  if (terminal.outcome === "fail") return result.parentExit !== null && result.parentExit !== 0 && !result.timedOut && !result.cancelled
  if (terminal.outcome === "timeout") return result.timedOut && !result.cancelled
  return result.cancelled
}
const claimShape = (value: unknown): value is ExecutionClaim => object(value) && text(value.ownerSession) && text(value.instance) && integer(value.pid) && integer(value.generation) && text(value.token)
const recordShape = (value: unknown): value is ExecutionRecord => {
  if (!object(value) || !text(value.executionId) || !text(value.ownerSession) || !text(value.taskId) || !text(value.attemptId) || !integer(value.generation) || !text(value.role) || !text(value.cwd) || !text(value.policyID)) return false
  if (("kind" in value || "profile" in value) &&
    ((value.kind !== "host" && value.kind !== "verifier") || !profileShape(value.profile))) return false
  if (value.kind === "host" && !text(value.engine)) return false
  if (value.kind === "verifier" && "engine" in value) return false
  if (value.kind === "verifier" && (!text(value.inputSnapshotID) || typeof value.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.inputDigest) ||
    !timestamp(value.deadlineAt) || !integer(value.maxOutputChars) || value.maxOutputChars > 65536)) return false
  if (value.kind !== "verifier" && ["inputSnapshotID", "inputDigest", "deadlineAt", "maxOutputChars"].some(key => key in value)) return false
  if (!optional(value, "boundaryRef", x => value.kind === "host" ? hostRefShape(x) && x.executionID === value.executionId :
    value.kind === "verifier" && verifierRefShape(x) && x.executionID === value.executionId && x.profile === value.profile &&
    x.inputSnapshotID === value.inputSnapshotID && x.inputDigest === value.inputDigest && x.deadlineAt === value.deadlineAt && x.maxOutputChars === value.maxOutputChars)) return false
  if (!optional(value, "descendantRisk", x => value.kind === "verifier" && value.profile === "legacy-unowned" && x === "unproven")) return false
  if (value.kind === "verifier" && value.profile === "legacy-unowned" && value.descendantRisk !== "unproven") return false
  if (value.kind === "verifier" && ("vendorRef" in value || "processRisk" in value)) return false
  if (!optional(value, "verifierDispatch", x => value.kind === "verifier" && ["prepared", "started", "retired"].includes(x as string))) return false
  if (value.kind === "verifier" && value.verifierDispatch === "prepared" && "terminal" in value) return false
  if (value.kind === "verifier" && value.verifierDispatch === "retired" &&
    (!object(value.terminal) || value.terminal.outcome !== "not-dispatched")) return false
  if (value.kind === "verifier" && value.verifierDispatch !== "retired" && object(value.terminal) && value.terminal.outcome === "not-dispatched") return false
  if (!optional(value, "hostDispatch", x => value.kind === "host" && x === "started")) return false
  if (!optional(value, "vendorRef", text) || !optional(value, "usage", x => x === "unknown")) return false
  if (!optional(value, "processRisk", x => object(x) && x.tool === "bash" && timestamp(x.at))) return false
  if (!optional(value, "cancel", x => object(x) && timestamp(x.requestedAt) && optional(x, "acknowledgedAt", timestamp))) return false
  if (!optional(value, "terminal", x => object(x) && text(x.outcome) && optional(x, "terminalAt", timestamp) && optional(x, "quiescentAt", timestamp) &&
    optional(x, "verification", y => verificationShape(y) && validProof(value as ExecutionRecord, y) && (value.kind !== "verifier" || y.output.length <= (value.maxOutputChars as number))) &&
    verifierTerminalShape(value as ExecutionRecord, x) &&
    (value.kind !== "verifier" || value.profile !== "legacy-unowned" || !("quiescentAt" in x)) &&
    (!("quiescentAt" in x) || value.kind !== "verifier" || (verificationShape(x.verification) && verifiedBoundary(value as ExecutionRecord, x.verification))))) return false
  if (!optional(value, "fence", x => object(x) && text(x.reason) && timestamp(x.at))) return false
  return optional(value, "reconciliation", x => object(x) && (x.outcome === "running" || x.outcome === "terminal" || x.outcome === "unknown") && typeof x.quiescent === "boolean" && (!x.quiescent || x.outcome === "terminal") && text(x.evidence) && timestamp(x.at) &&
    optional(x, "verification", y => verificationShape(y) && validProof(value as ExecutionRecord, y) && (value.kind !== "verifier" || y.output.length <= (value.maxOutputChars as number))) &&
    (!x.quiescent || value.kind !== "verifier" || (verificationShape(x.verification) && verifiedBoundary(value as ExecutionRecord, x.verification))))
}

export function hostRecoveryContext(
  state: ExecutionRunStatus,
  reference: ExecutionReference,
  expectedEngine: string,
  policyIDForRole: (role: ExecutionRole) => string,
): HostRecoveryContext | undefined {
  if (!Number.isSafeInteger(state.generation) || state.generation < 0 || !Array.isArray(state.executions)
    || !state.claim || state.claim.generation !== state.generation || !text(state.claim.ownerSession)
    || !hostRefShape(reference) || !text(expectedEngine)) return undefined

  // Caller metadata never selects the recovery directory; use only the durable record below.
  const matches = state.executions.filter(record => record.executionId === reference.executionID)
  if (matches.length !== 1) return undefined
  const record = matches[0]!
  if (record.kind !== "host" || !text(record.engine) || record.engine !== expectedEngine
    || !profileShape(record.profile) || !text(record.vendorRef)
    || record.ownerSession !== state.claim.ownerSession || !integer(record.generation)
    || record.generation > state.generation || !isAbsolute(record.cwd) || resolve(record.cwd) !== record.cwd) return undefined

  const references = new Map<string, ExecutionReference>()
  for (const candidate of state.executions) {
    if (candidate.kind !== "host") {
      if (candidate.kind === "verifier" && "engine" in candidate) return undefined
      if (candidate.vendorRef !== undefined) return undefined
      continue
    }
    if (!text(candidate.engine)) return undefined
    if (candidate.vendorRef === undefined) {
      if (candidate.boundaryRef !== undefined) return undefined
      continue
    }
    const candidateReference = persistedHostReference(candidate)
    if (!candidateReference) return undefined
    references.set(candidate.executionId, candidateReference)
  }

  const identifiers = new Map<typeof hostReferenceIDs[number], Set<string>>()
  for (const key of hostReferenceIDs) identifiers.set(key, new Set())
  for (const candidateReference of references.values()) {
    for (const key of hostReferenceIDs) {
      const value = candidateReference[key]
      if (value === undefined) continue
      const seen = identifiers.get(key)!
      if (seen.has(value)) return undefined
      seen.add(value)
    }
  }

  const persisted = references.get(record.executionId)
  if (!persisted) return undefined
  if (persisted.executionID !== reference.executionID
    || hostReferenceIDs.some(key => reference[key] !== undefined && reference[key] !== persisted[key])
  ) return undefined

  if (!(EXECUTION_ROLES as readonly string[]).includes(record.role)) return undefined
  const role = record.role as ExecutionRole
  let fixedPolicyID: string
  try { fixedPolicyID = policyIDForRole(role) }
  catch { return undefined }
  if (record.policyID !== fixedPolicyID) return undefined

  return {
    executionID: record.executionId,
    engine: record.engine,
    ownerSession: record.ownerSession,
    cwd: record.cwd,
    role,
    policyID: record.policyID,
    profile: record.profile,
    processRisk: record.processRisk !== undefined,
  }
}

export function createExecutionRunStore(worktree: string): ExecutionRunStore {
  const dir = executionRunDirectory(worktree)
  const path = join(dir, "state.json")
  const lock = join(dir, "claim.lock")
  const persist = (state: State): void => {
    const temporary = join(dir, `.state-${randomUUID()}.tmp`)
    try {
      const file = openSync(temporary, "wx", 0o600)
      try {
        writeFileSync(file, JSON.stringify(state, null, 2) + "\n")
        fsyncSync(file)
      } finally { closeSync(file) }
      renameSync(temporary, path)
      const directory = openSync(dir, "r")
      try { fsyncSync(directory) }
      finally { closeSync(directory) }
    } finally { rmSync(temporary, { force: true }) }
  }
  const read = (): State => {
    let file: number
    try { file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return empty()
      throw new ExecutionRunCorruptError("execution run state cannot be opened safely")
    }
    let value: State
    try {
      if (!fstatSync(file).isFile()) throw new ExecutionRunCorruptError("execution run state is not a regular file")
      value = JSON.parse(readFileSync(file, "utf8")) as State
    }
    catch { throw new ExecutionRunCorruptError("execution run state is corrupt") }
    finally { closeSync(file) }
    if (!object(value) || !Number.isSafeInteger(value.generation) || value.generation < 0 || !Array.isArray(value.executions) ||
      ("claim" in value && (!claimShape(value.claim) || value.claim.generation !== value.generation)) ||
      !value.executions.every(recordShape) || value.executions.some(e => e.generation > value.generation) ||
      new Set(value.executions.map(e => e.executionId)).size !== value.executions.length) throw new ExecutionRunCorruptError("execution run state has invalid shape")
    return value
  }
  const mutate = <T>(fn: (state: State) => T, shouldPersist: (result: T) => boolean = () => true): T => {
    mkdirSync(dir, { recursive: true })
    // The identity is present atomically with acquisition. Existing locks are
    // never recovered from process metadata; their owner may merely be paused.
    const identity = JSON.stringify({ pid: process.pid, token: randomUUID() })
    try { symlinkSync(identity, lock) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      throw new ExecutionRunBusyError("execution run store is locked")
    }
    try {
      const state = read()
      const result = fn(state)
      if (shouldPersist(result)) persist(state)
      return result
    } finally {
      // Cooperating writers never replace a held lock. This detects observed
      // replacement; it is not atomic compare-and-unlink against external writes.
      let owner: string
      try {
        owner = readlinkSync(lock)
      } catch {
        throw new ExecutionRunBusyError("execution run lock ownership changed")
      }
      if (owner !== identity) throw new ExecutionRunBusyError("execution run lock ownership changed")
      unlinkSync(lock)
    }
  }
  const validate = (state: State, claim: ExecutionClaim) => {
    if (!state.claim || state.claim.token !== claim.token || state.claim.generation !== claim.generation || state.claim.ownerSession !== claim.ownerSession || state.claim.instance !== claim.instance || state.claim.pid !== claim.pid) throw new ExecutionRunBusyError("stale execution claim")
  }
  const execution = (state: State, id: string) => {
    const e = state.executions.find(x => x.executionId === id)
    if (!e) throw new Error(`unknown execution ${id}`)
    return e
  }
  return {
    claim(ownerSession, instance, pid) {
      bounded(ownerSession, "ownerSession"); bounded(instance, "instance")
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("invalid pid")
      return mutate(state => {
        if (state.claim) throw new ExecutionRunUnresolvedError("an existing execution claim prevents acquisition")
        const next: ExecutionClaim = { ownerSession, instance, pid, generation: ++state.generation, token: randomUUID() }
        state.claim = next
        return next
      })
    },
    registerIntent(claim, value) { mutate(state => { validate(state, claim); if ("hostDispatch" in value) throw new TypeError("host dispatch state is store-owned"); const record = { ...value, ...(value.kind === "verifier" ? { verifierDispatch: "prepared" as const } : {}), ...(value.kind === "verifier" && value.profile === "legacy-unowned" ? { descendantRisk: "unproven" as const } : {}), usage: "unknown" as const }; if (!value.kind || !value.profile || !recordShape(record)) throw new TypeError("invalid execution intent"); if (value.generation !== claim.generation || value.ownerSession !== claim.ownerSession) throw new Error("intent identity mismatch"); if (state.executions.some(x => x.executionId === value.executionId)) throw new Error("duplicate executionId"); if (state.executions.some(x => !settled(x))) throw new ExecutionRunUnresolvedError("an execution is already unresolved"); state.executions.push(record) }) },
    bindVendorRef(claim, id, ref) {
      bounded(ref, "vendorRef")
      let parsed: unknown
      try { parsed = JSON.parse(ref) }
      catch { throw new TypeError("invalid host reference") }
      mutate(s => {
        validate(s, claim)
        const e = execution(s, id)
        if (e.kind !== "host" || !hostRefShape(parsed) || parsed.executionID !== id || !hostReferenceHasVendorID(parsed)) {
          throw new TypeError("invalid host reference")
        }
        const nextReference = parsed

        if (e.vendorRef !== undefined) {
          const existing = persistedHostReference(e)
          if (!existing) throw new ExecutionRunUnresolvedError("existing host reference is ambiguous")
          if (!isDeepStrictEqual(existing, nextReference)) throw new TypeError("host reference is immutable")
          return false
        }
        if (e.boundaryRef !== undefined) throw new ExecutionRunUnresolvedError("host boundary reference is already ambiguous")
        if (e.generation !== claim.generation || e.ownerSession !== claim.ownerSession || e.terminal) {
          throw new ExecutionRunUnresolvedError("host reference cannot be bound to this execution state")
        }

        for (const candidate of s.executions) {
          if (candidate.executionId === id || candidate.kind !== "host") continue
          if (candidate.vendorRef === undefined) {
            if (candidate.boundaryRef !== undefined) throw new ExecutionRunUnresolvedError("another host reference is ambiguous")
            continue
          }
          const existing = persistedHostReference(candidate)
          if (!existing) throw new ExecutionRunUnresolvedError("another host reference is ambiguous")
          if (hostReferenceIDs.some(key => typeof nextReference[key] === "string" && nextReference[key] === existing[key])) {
            throw new ExecutionRunUnresolvedError("vendor reference identifier is already bound")
          }
        }

        e.vendorRef = ref
        if (e.kind === "host") e.boundaryRef = nextReference
        return true
      }, changed => changed)
    },
    bindVerifierRef(claim, id, reference) { mutate(s => { validate(s, claim); const e = execution(s, id); if (e.kind !== "verifier" || e.verifierDispatch !== "prepared" || e.terminal || !verifierRefShape(reference) || reference.executionID !== id || reference.profile !== e.profile || reference.inputSnapshotID !== e.inputSnapshotID || reference.inputDigest !== e.inputDigest || reference.deadlineAt !== e.deadlineAt || reference.maxOutputChars !== e.maxOutputChars || (e.boundaryRef && !sameBoundary(e, reference))) throw new TypeError("invalid verifier reference"); e.boundaryRef = { ...reference } }) },
    markVerifierDispatched(claim, id) {
      mutate(s => {
        validate(s, claim)
        const e = execution(s, id)
        if (e.kind !== "verifier" || e.verifierDispatch !== "prepared" || e.generation !== claim.generation ||
          !verifierRefShape(e.boundaryRef) || e.cancel || e.fence || e.terminal || e.reconciliation) {
          throw new ExecutionRunUnresolvedError("verifier is not eligible for dispatch")
        }
        e.verifierDispatch = "started"
      })
    },
    markHostDispatched(claim, id) {
      mutate(s => {
        validate(s, claim)
        const e = execution(s, id)
        const referenceInvalid = e.vendorRef === undefined
          ? e.boundaryRef !== undefined
          : !persistedHostReference(e)
        if (e.kind !== "host" || e.generation !== claim.generation || e.ownerSession !== claim.ownerSession ||
          referenceInvalid || e.cancel || e.fence || e.terminal || e.reconciliation || e.hostDispatch !== undefined) {
          throw new ExecutionRunUnresolvedError("host execution is not eligible for dispatch")
        }
        e.hostDispatch = "started"
      })
    },
    retireUndispatchedVerifier(claim, id) {
      mutate(s => {
        validate(s, claim)
        const e = execution(s, id)
        if (e.kind !== "verifier" || e.verifierDispatch !== "prepared" || e.ownerSession !== claim.ownerSession ||
          e.generation > claim.generation || e.terminal || e.fence || e.reconciliation) {
          throw new ExecutionRunUnresolvedError("verifier cannot be retired as undispatched")
        }
        e.verifierDispatch = "retired"
        e.terminal = { outcome: "not-dispatched", terminalAt: Date.now() }
      })
    },
    markProcessRiskBySession(sessionID, expectedEngine) {
      bounded(sessionID, "sessionID")
      bounded(expectedEngine, "engine")
      mutate(s => {
        const matches: Array<{ record: ExecutionRecord; reference: Record<string, unknown> }> = []
        for (const record of s.executions) {
          if (!record.vendorRef) continue
          let value: unknown
          try {
            value = JSON.parse(record.vendorRef)
          } catch { throw new ExecutionRunUnresolvedError("shell tool execution reference is corrupt") }
          if (!object(value)) throw new ExecutionRunUnresolvedError("shell tool execution reference is corrupt")
          if (value.vendorSessionID === sessionID) {
            if (!persistedHostReference(record)) {
              throw new ExecutionRunUnresolvedError("shell tool execution reference is not durably bound")
            }
            matches.push({ record, reference: value })
          }
        }
        const match = matches[0]
        const claim = s.claim
        const e = matches.length === 1 && !!claim && match?.record.kind === "host"
          && match.record.engine === expectedEngine && match.reference.executionID === match.record.executionId
          && match.record.generation === claim.generation && match.record.ownerSession === claim.ownerSession
          ? match.record : undefined
        if (!e || e.cancel || e.terminal || e.fence) throw new ExecutionRunUnresolvedError("shell tool has no active execution owner")
        e.processRisk ??= { tool: "bash", at: Date.now() }
      })
    },
    recordCancel(claim, id, value) { if (!object(value) || !timestamp(value.requestedAt) || !optional(value, "acknowledgedAt", timestamp)) throw new TypeError("invalid cancel record"); mutate(s => { validate(s, claim); execution(s, id).cancel = { ...value } }) },
    recordTerminal(claim, id, value) { mutate(s => { validate(s, claim); const e = execution(s, id); if (e.kind === "verifier" && e.terminal) { if (isDeepStrictEqual(e.terminal, value)) return; throw new ExecutionRunUnresolvedError("terminal verifier result is immutable") }; if (e.kind === "verifier" && (value.outcome === "not-dispatched" || e.verifierDispatch !== "started" || e.generation !== claim.generation)) throw new ExecutionRunUnresolvedError("verifier terminal requires a dispatched current-generation invocation"); if ((e.processRisk || (e.kind === "host" && e.profile === "linux-single-use")) && value.quiescentAt !== undefined) throw new ExecutionRunUnresolvedError("host process quiescence is unproven"); const candidate = { ...e, terminal: value }; if (!recordShape(candidate)) throw new TypeError("invalid terminal record"); e.terminal = { ...value } }) },
    fence(claim, id, reason) { bounded(reason, "reason"); mutate(s => { validate(s, claim); execution(s, id).fence = { reason, at: Date.now() } }) },
    reconcile(claim, id, value) { mutate(s => { validate(s, claim); const e = execution(s, id); if ((e.processRisk || (e.kind === "host" && e.profile === "linux-single-use")) && value.quiescent) throw new ExecutionRunUnresolvedError("host process quiescence is unproven"); const candidate = { ...e, reconciliation: { ...value, at: Date.now() } }; if (!recordShape(candidate)) throw new TypeError("invalid reconciliation"); e.reconciliation = candidate.reconciliation; if (e.kind === "verifier" && e.terminal && value.outcome === "running") e.fence = { reason: "verifier observed running after terminal result", at: Date.now() }; if (value.quiescent) delete e.fence }) },
    assertQuiescent(claim) { const s = read(); validate(s, claim); if (s.executions.some(x => !settled(x))) throw new ExecutionRunUnresolvedError("executions are not quiescent or settled") },
    release(claim) { mutate(s => { validate(s, claim); if (s.executions.some(x => !settled(x))) throw new ExecutionRunUnresolvedError("executions are not quiescent or settled"); delete s.claim }) },
    status() { const s = read(); const { claim, ...visible } = s; return { ...visible, claim: claim && { ownerSession: claim.ownerSession, instance: claim.instance, pid: claim.pid, generation: claim.generation } } },
  }
}
