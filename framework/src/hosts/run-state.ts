import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { stateRoot } from "../state/store.ts"
import type { VerificationProfile, VerificationReference, VerificationResult } from "../orchestration/verifier.ts"
import type { ExecutionReference } from "./types.ts"
import { authenticateLinuxVerification } from "./linux-domain.ts"

export type ExecutionClaim = { ownerSession: string; instance: string; pid: number; generation: number; token: string }
export type ExecutionIntent = {
  executionId: string; ownerSession: string; taskId: string; attemptId: string; generation: number; role: string; cwd: string; policyID: string
  kind?: "host" | "verifier"
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
  cancel?: { requestedAt: number; acknowledgedAt?: number }
  terminal?: { outcome: string; terminalAt?: number; quiescentAt?: number; verification?: VerificationResult }
  fence?: { reason: string; at: number }
  reconciliation?: { outcome: "running" | "terminal" | "unknown"; quiescent: boolean; evidence: string; at: number; verification?: VerificationResult }
  usage?: "unknown"
  processRisk?: { tool: "bash"; at: number }
}
export type ExecutionRunStatus = { generation: number; claim?: Omit<ExecutionClaim, "token">; executions: ExecutionRecord[] }
export class ExecutionRunBusyError extends Error {}
export class ExecutionRunUnresolvedError extends Error {}
export class ExecutionRunCorruptError extends Error {}

export interface ExecutionRunStore {
  claim(ownerSession: string, instance: string, pid: number): ExecutionClaim
  registerIntent(claim: ExecutionClaim, execution: ExecutionIntent): void
  bindVendorRef(claim: ExecutionClaim, executionId: string, vendorRef: string): void
  bindVerifierRef(claim: ExecutionClaim, executionId: string, reference: VerificationReference): void
  markVerifierDispatched(claim: ExecutionClaim, executionId: string): void
  retireUndispatchedVerifier(claim: ExecutionClaim, executionId: string): void
  markProcessRiskBySession(sessionID: string): void
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
const hostRefShape = (value: unknown): value is ExecutionReference => object(value) && text(value.executionID) &&
  optional(value, "vendorSessionID", text) && optional(value, "vendorThreadID", text) && optional(value, "vendorTurnID", text) && !("kind" in value)
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
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH" }
}

export function createExecutionRunStore(worktree: string): ExecutionRunStore {
  const dir = join(stateRoot(worktree), "execution-runs")
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
    if (!existsSync(path)) return empty()
    let value: State
    try { value = JSON.parse(readFileSync(path, "utf8")) as State }
    catch { throw new ExecutionRunCorruptError("execution run state is corrupt") }
    if (!object(value) || !Number.isSafeInteger(value.generation) || value.generation < 0 || !Array.isArray(value.executions) ||
      ("claim" in value && (!claimShape(value.claim) || value.claim.generation !== value.generation)) ||
      !value.executions.every(recordShape) || value.executions.some(e => e.generation > value.generation) ||
      new Set(value.executions.map(e => e.executionId)).size !== value.executions.length) throw new ExecutionRunCorruptError("execution run state has invalid shape")
    return value
  }
  const mutate = <T>(fn: (state: State) => T): T => {
    mkdirSync(dir, { recursive: true })
    // The identity is present atomically with acquisition; an empty mkdir lock
    // cannot safely be recovered because its owner may merely be paused.
    const identity = JSON.stringify({ pid: process.pid, token: randomUUID() })
    try { symlinkSync(identity, lock) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let stale: { pid: number; token: string }
      try {
        stale = JSON.parse(readlinkSync(lock))
        if (!object(stale) || !integer(stale.pid) || !text(stale.token) || alive(stale.pid)) throw new ExecutionRunBusyError("execution run store is locked")
      } catch { throw new ExecutionRunBusyError("execution run store is locked") }
      // One contender per stale identity may move it. Others cannot rename
      // the successor's live lock based on an earlier stale observation.
      const gate = `${lock}.recovery-${createHash("sha256").update(stale.token).digest("hex")}`
      try { symlinkSync(identity, gate) }
      catch { throw new ExecutionRunBusyError("execution run store recovery is locked") }
      try {
        if (readlinkSync(lock) !== JSON.stringify(stale) || alive(stale.pid)) throw new ExecutionRunBusyError("execution run store is locked")
        const retired = `${lock}.retired-${randomUUID()}`
        renameSync(lock, retired)
        rmSync(retired)
      } catch (error) {
        if (error instanceof ExecutionRunBusyError) throw error
        throw new ExecutionRunBusyError("execution run store recovery failed")
      } finally { rmSync(gate, { force: true }) }
      try { symlinkSync(identity, lock) }
      catch { throw new ExecutionRunBusyError("execution run store is locked") }
    }
    try {
      const state = read()
      const result = fn(state)
      persist(state)
      return result
    } finally { rmSync(lock) }
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
        if (state.claim) {
          if (state.claim.ownerSession === ownerSession && state.claim.instance === instance && state.claim.pid === pid) {
            return state.claim
          }
          if (alive(state.claim.pid)) throw new ExecutionRunUnresolvedError("existing live owner prevents takeover")
        }
        const next: ExecutionClaim = { ownerSession, instance, pid, generation: ++state.generation, token: randomUUID() }
        state.claim = next
        return next
      })
    },
    registerIntent(claim, value) { mutate(state => { validate(state, claim); const record = { ...value, ...(value.kind === "verifier" ? { verifierDispatch: "prepared" as const } : {}), ...(value.kind === "verifier" && value.profile === "legacy-unowned" ? { descendantRisk: "unproven" as const } : {}), usage: "unknown" as const }; if (!value.kind || !value.profile || !recordShape(record)) throw new TypeError("invalid execution intent"); if (value.generation !== claim.generation || value.ownerSession !== claim.ownerSession) throw new Error("intent identity mismatch"); if (state.executions.some(x => x.executionId === value.executionId)) throw new Error("duplicate executionId"); if (state.executions.some(x => !settled(x))) throw new ExecutionRunUnresolvedError("an execution is already unresolved"); state.executions.push(record) }) },
    bindVendorRef(claim, id, ref) { bounded(ref, "vendorRef"); let parsed: unknown; try { parsed = JSON.parse(ref) } catch { throw new TypeError("invalid host reference") }; mutate(s => { validate(s, claim); const e = execution(s, id); if (e.kind === "verifier" || !hostRefShape(parsed) || parsed.executionID !== id) throw new TypeError("invalid host reference"); e.vendorRef = ref; if (e.kind === "host") e.boundaryRef = parsed }) },
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
    markProcessRiskBySession(sessionID) {
      bounded(sessionID, "sessionID")
      mutate(s => {
        const e = s.executions.find(record => {
          if (record.kind === "verifier" || !record.vendorRef || !s.claim || record.generation !== s.claim.generation || record.ownerSession !== s.claim.ownerSession) return false
          try {
            const ref = JSON.parse(record.vendorRef) as { executionID?: unknown; vendorSessionID?: unknown }
            return ref.executionID === record.executionId && ref.vendorSessionID === sessionID
          } catch { return false }
        })
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
