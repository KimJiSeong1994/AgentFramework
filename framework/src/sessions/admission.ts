import { randomUUID } from "node:crypto"
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync } from "node:fs"
import { join } from "node:path"
import { settled } from "../hosts/run-state.ts"
import { executionActivity, sessionActivityBlocker } from "../hosts/runtime.ts"
import type { ComboRoutes, ExecutionRuntime } from "../hosts/types.ts"
import { getQueue } from "../orchestration/queue.ts"
import { ensureHeartbeat, reattachOwner, stopHeartbeat } from "../flow/runtime.ts"
import { readAnyWorkflowChecked as readWorkflowChecked, withFlowTransaction, readAnyWorkflowForWrite as readWorkflowForWrite, workflowEngineRefusal } from "../flow/state.ts"
import { TERMINAL } from "../flow/machine.ts"
import { abortPath, sessionDir } from "../state/store.ts"
import { durableWriteJson } from "../state/durable.ts"
import { getOwnedSession, inspectSessionAttachment, openSession, readSessionMetadata, routesKey, type SessionStore } from "./store.ts"
import { cancelSkillPermissionActivities, pendingSkillPermissionActivityCount, pendingSkillPermissionActivityCountForSession } from "../skills/activity.ts"
import { isCancelPending } from "../workflows/types.ts"

type HoldMarker = {
  version: 1
  sid: string
  held: boolean
  reason: string
  epoch: string
  requestID: string
  workflowID?: string
  workflowRevision?: number
  updatedAt: number
}

type AdmissionToken = { epoch: string; store: SessionStore; engine: string }

const tokens = new Map<string, AdmissionToken>()
const resumeProofs = new WeakMap<object, { store: SessionStore; epoch: string }>()
declare const admissionLeaseBrand: unique symbol
export type AdmissionLease = Readonly<{ [admissionLeaseBrand]: true }>
const admissionLeases = new WeakMap<object, { registryKey: string; token: AdmissionToken }>()

/** Consumption only: the sole issuer is the validated synchronous Resume transaction below. */
export function consumeValidatedResumeProof(store: SessionStore, proof: object): boolean {
  const admitted = resumeProofs.get(proof)
  resumeProofs.delete(proof)
  return admitted?.store === store && admitted.epoch === store.epoch
}

function clearValidatedResume(store: SessionStore): void {
  const proof = { authorized: true as const, reason: "explicit-resume" }
  resumeProofs.set(proof, { store, epoch: store.epoch })
  try { store.clearHold(proof) }
  finally { resumeProofs.delete(proof) }
}

function admitValidatedStore(runtime: ExecutionRuntime, sid: string, store: SessionStore): SessionStore {
  const registryKey = key(runtime.worktree, sid)
  tokens.set(registryKey, { epoch: store.epoch, store, engine: runtime.host.identity.engine })
  if (!tokenIsCurrent(runtime.worktree, sid, tokens.get(registryKey)!)) {
    tokens.delete(registryKey)
    try {
      writeHold(runtime.worktree, sid, store, "resume-revalidation-failed")
      store.hold("resume-revalidation-failed")
    } catch {
      // No live admission survives a failed durable rollback.
    }
    throw new Error("resumed session could not be admitted")
  }
  const checked = readWorkflowChecked(runtime.worktree, sid)
  if (!checked.corrupt && checked.wf?.sessionID === sid) ensureHeartbeat(runtime, runtime.host.identity.engine, checked.wf.kind === "plan" ? checked.wf : undefined, undefined, sid)
  return store
}

function key(worktree: string, sid: string): string {
  return sessionDir(worktree, sid)
}

function markerPath(worktree: string, sid: string): string {
  return join(sessionDir(worktree, sid), "restore-hold.json")
}

function endRequestedPath(worktree: string, sid: string): string {
  return join(sessionDir(worktree, sid), "session-end-requested.json")
}

function endedPath(worktree: string, sid: string): string {
  return join(sessionDir(worktree, sid), "session-ended.json")
}

function readJsonFile(path: string): { exists: false } | { exists: true; value: unknown } | { exists: true; corrupt: true } {
  let fd: number
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) return { exists: true, corrupt: true }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }
    return { exists: true, corrupt: true }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 16 * 1024) return { exists: true, corrupt: true }
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"))
    return { exists: true, value }
  } catch {
    return { exists: true, corrupt: true }
  } finally {
    closeSync(fd)
  }
}

function holdMarker(worktree: string, sid: string, epoch: string): HoldMarker | undefined {
  const checked = readWorkflowChecked(worktree, sid)
  if (checked.corrupt) throw new Error("workflow state is corrupt; admission remains held")
  const workflow = checked.wf?.sessionID === sid ? checked.wf : null
  return {
    version: 1,
    sid,
    held: true,
    reason: "restore",
    epoch,
    requestID: randomUUID(),
    ...(workflow ? { workflowID: workflow.id, workflowRevision: workflow.lastSeq } : {}),
    updatedAt: Date.now(),
  }
}

function writeHold(worktree: string, sid: string, store: SessionStore, reason: string): void {
  const marker = holdMarker(worktree, sid, store.epoch)
  if (!marker) throw new Error("could not establish durable hold")
  durableWriteJson(markerPath(worktree, sid), { ...marker, reason })
}

/** Snapshot authority, not transcript facts, across asynchronous host identity/quiescence checks. */
export function admissionFence(worktree: string, sid: string): string {
  const workflow = readWorkflowChecked(worktree, sid)
  if (workflow.corrupt) throw new Error("workflow state is corrupt; admission remains held")
  return JSON.stringify([
    readSessionMetadata(worktree, sid), workflow.wf,
    readJsonFile(markerPath(worktree, sid)), readJsonFile(abortPath(worktree, sid)),
    readJsonFile(endRequestedPath(worktree, sid)), readJsonFile(endedPath(worktree, sid)),
  ])
}

function validateMarker(worktree: string, sid: string, epoch: string): boolean {
  const marker = readJsonFile(markerPath(worktree, sid))
  if (!marker.exists) return true
  if ("corrupt" in marker) return false
  const value = marker.value
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 1 &&
    (value as Record<string, unknown>).sid === sid &&
    (value as Record<string, unknown>).epoch === epoch &&
    (value as Record<string, unknown>).held === false
}

export function hasEndMarker(worktree: string, sid: string): boolean {
  for (const path of [endRequestedPath(worktree, sid), endedPath(worktree, sid)]) {
    const checked = readJsonFile(path)
    if (checked.exists) return true
  }
  return false
}

function hasStopOrEndMarker(worktree: string, sid: string): boolean {
  if (hasEndMarker(worktree, sid)) return true
  const stop = readJsonFile(abortPath(worktree, sid))
  return stop.exists
}

function exactUserStop(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const marker = value as Record<string, unknown>
  return marker.reason === "user_stop" && Object.keys(marker).length === 3 &&
    Object.keys(marker).every(key => ["reason", "at", "arguments"].includes(key)) &&
    typeof marker.at === "number" && Number.isFinite(marker.at) && marker.at >= 0 &&
    typeof marker.arguments === "string"
}

function stopAuditPrefix(): string {
  return "abort-user-stop-"
}

function hasUserStopAudit(worktree: string, sid: string): boolean {
  const directory = sessionDir(worktree, sid)
  const prefix = stopAuditPrefix()
  let found = false
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue
    const archived = readJsonFile(join(directory, name))
    if (!archived.exists || "corrupt" in archived || !exactUserStop(archived.value)) {
      throw new Error("retained user_stop evidence is corrupt")
    }
    found = true
  }
  return found
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!fstatSync(fd).isDirectory()) throw new Error("session directory changed during stop acknowledgement")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Retain an exact user_stop marker under the same private session directory before acknowledging it. */
function archiveUserStop(worktree: string, sid: string): void {
  const source = abortPath(worktree, sid)
  const stop = readJsonFile(source)
  if (!stop.exists) {
    if (hasUserStopAudit(worktree, sid)) return
    throw new Error("exact user_stop marker is missing")
  }
  if ("corrupt" in stop || !exactUserStop(stop.value)) {
    throw new Error("only an exact user_stop marker can be acknowledged")
  }

  const directory = sessionDir(worktree, sid)
  const prefix = stopAuditPrefix()
  let destination: string | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate = join(directory, `${prefix}${randomUUID()}.json`)
    try { lstatSync(candidate) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      destination = candidate
      break
    }
  }
  if (!destination) throw new Error("could not allocate a retained user_stop evidence name")
  renameSync(source, destination)
  syncDirectory(directory)
}

function pendingUserStop(worktree: string, sid: string): boolean {
  const stop = readJsonFile(abortPath(worktree, sid))
  if (stop.exists) return !("corrupt" in stop) && exactUserStop(stop.value)
  const binding = readJsonFile(markerPath(worktree, sid))
  if (!binding.exists || "corrupt" in binding || !binding.value || typeof binding.value !== "object" || Array.isArray(binding.value)) {
    return false
  }
  const value = binding.value as Record<string, unknown>
  return value.version === 1 && value.sid === sid && typeof value.epoch === "string" &&
    value.held === true && value.reason === "user_stop"
}

function heldRebindReason(worktree: string, sid: string, epoch: string): "user_stop" | "restore-owner-rebound" | undefined {
  if (hasEndMarker(worktree, sid)) return undefined
  const binding = readJsonFile(markerPath(worktree, sid))
  if (!binding.exists || "corrupt" in binding || !binding.value || typeof binding.value !== "object" || Array.isArray(binding.value)) {
    return undefined
  }
  const marker = binding.value as Record<string, unknown>
  if (marker.version !== 1 || marker.sid !== sid || marker.epoch !== epoch || marker.held !== true) return undefined
  const stop = readJsonFile(abortPath(worktree, sid))
  if (stop.exists) {
    return !("corrupt" in stop) && exactUserStop(stop.value) && marker.reason === "user_stop" ? "user_stop" : undefined
  }
  if (marker.reason === "user_stop") return "user_stop"
  return "restore-owner-rebound"
}

function validWorkflowBinding(worktree: string, sid: string, engine: string, epoch: string): boolean {
  const checked = readWorkflowChecked(worktree, sid)
  if (checked.corrupt) return false
  const workflow = checked.wf
  if (!workflow || workflow.sessionID !== sid) return true
  return !workflowEngineRefusal(workflow, engine) && workflow.owner.instance === epoch &&
    workflow.owner.pid === process.pid && workflow.stopIntent === null && workflow.phase !== "paused"
}

/** True while an exact or unrecognised stop marker (`/stop` abort file) exists; Resume must not run over it. */
export function hasStopMarker(worktree: string, sid: string): boolean {
  return readJsonFile(abortPath(worktree, sid)).exists
}

/** Read-only view of the durable hold binding for display and Resume preconditions; it grants nothing. */
export function readHoldBinding(worktree: string, sid: string): { held: boolean; reason: string; epoch: string; workflowID?: string; workflowRevision?: number } | undefined {
  const marker = readJsonFile(markerPath(worktree, sid))
  if (!marker.exists || "corrupt" in marker || !marker.value || typeof marker.value !== "object" || Array.isArray(marker.value)) return undefined
  const value = marker.value as Record<string, unknown>
  if (value.version !== 1 || value.sid !== sid || typeof value.epoch !== "string" || typeof value.reason !== "string" || typeof value.held !== "boolean") return undefined
  return {
    held: value.held, reason: value.reason, epoch: value.epoch,
    ...(typeof value.workflowID === "string" ? { workflowID: value.workflowID } : {}),
    ...(typeof value.workflowRevision === "number" ? { workflowRevision: value.workflowRevision } : {}),
  }
}

function tokenIsCurrent(worktree: string, sid: string, token: AdmissionToken): boolean {
  try {
    if (!token.epoch || !validateMarker(worktree, sid, token.epoch) || hasStopOrEndMarker(worktree, sid)) return false
    token.store.assertOwner()
    const owned = getOwnedSession(worktree, sid)
    if (!owned || owned.epoch !== token.epoch || owned.sessionID !== sid) return false
    const metadata = readSessionMetadata(worktree, sid)
    if (!metadata || metadata.held || metadata.engine !== token.engine) return false
    if (!validWorkflowBinding(worktree, sid, token.engine, token.epoch)) return false
    return true
  } catch {
    return false
  }
}

/** A session without a live, epoch-matched in-process token is held, including absent and corrupt authority. */
export function effectiveHold(worktree: string, sid: string): boolean {
  const token = tokens.get(key(worktree, sid))
  return !token || !tokenIsCurrent(worktree, sid, token)
}

/** Return only the current live, unheld epoch; absent, corrupt, or held authority never yields an epoch. */
export function admissionEpoch(worktree: string, sid: string): string | undefined {
  const token = tokens.get(key(worktree, sid))
  return token && tokenIsCurrent(worktree, sid, token) ? token.epoch : undefined
}

/** Read-only proof of this token incarnation; it can neither grant nor resume admission. */
export function captureAdmissionLease(worktree: string, sid: string): AdmissionLease | undefined {
  const registryKey = key(worktree, sid)
  const token = tokens.get(registryKey)
  if (!token || !tokenIsCurrent(worktree, sid, token)) return undefined
  const lease = Object.freeze({}) as AdmissionLease
  admissionLeases.set(lease, { registryKey, token })
  return lease
}

/** A same-epoch Resume issues a new token and can never revive an older lease. */
export function isAdmissionLeaseCurrent(worktree: string, sid: string, value: unknown): value is AdmissionLease {
  if (!value || typeof value !== "object") return false
  const lease = admissionLeases.get(value)
  if (!lease) return false
  try {
    return lease.registryKey === key(worktree, sid) &&
      tokens.get(lease.registryKey) === lease.token && tokenIsCurrent(worktree, sid, lease.token)
  } catch { return false }
}

/** Revalidate an asynchronous callback's captured epoch; undefined is never an authorization value. */
export function isAdmissionCurrent(worktree: string, sid: string, expectedEpoch: string | undefined): boolean {
  if (typeof expectedEpoch !== "string" || expectedEpoch.length === 0) return false
  const token = tokens.get(key(worktree, sid))
  return !!token && token.epoch === expectedEpoch && tokenIsCurrent(worktree, sid, token)
}

function rebindHeldWorkflow(runtime: ExecutionRuntime, store: SessionStore, sid: string): void {
  const holdReason = heldRebindReason(runtime.worktree, sid, store.epoch)
  if (!holdReason) return
  const checked = readWorkflowChecked(runtime.worktree, sid)
  if (checked.corrupt) {
    runtime.log("held workflow reattach refused", { sessionID: sid, reason: "workflow state is corrupt" })
    return
  }
  const workflow = checked.wf
  if (!workflow || workflow.sessionID !== sid || workflowEngineRefusal(workflow, runtime.host.identity.engine) ||
      TERMINAL.has(workflow.phase)) return
  if (workflow.owner.instance === store.epoch && workflow.owner.pid === process.pid) return

  const result = reattachOwner(runtime, store, workflow.id, workflow.lastSeq)
  if ("refuse" in result) {
    runtime.log("held workflow reattach refused", { sessionID: sid, workflowID: workflow.id, reason: result.refuse })
    return
  }
  if (result.wf.id !== workflow.id || result.wf.sessionID !== sid || result.wf.owner.instance !== store.epoch ||
      result.wf.owner.pid !== process.pid || workflowEngineRefusal(result.wf, runtime.host.identity.engine)) {
    runtime.log("held workflow reattach refused", { sessionID: sid, workflowID: workflow.id, reason: "rebind result did not match this attachment" })
    return
  }
  try {
    const refreshed = withFlowTransaction<boolean>(runtime.worktree, tx => {
      const current = readWorkflowForWrite(tx)
      const wf = current.wf
      if (current.corrupt || !wf || wf.id !== result.wf.id || wf.sessionID !== sid ||
          wf.lastSeq !== result.wf.lastSeq || wf.owner.instance !== store.epoch ||
          wf.owner.pid !== process.pid || TERMINAL.has(wf.phase) ||
          workflowEngineRefusal(wf, runtime.host.identity.engine) ||
          heldRebindReason(runtime.worktree, sid, store.epoch) !== holdReason) return false
      assertAdmissionQuiescent(runtime, sid)
      store.assertOwner()
      holdAdmission(runtime.worktree, sid, holdReason)
      return true
    }, sid)
    if (!refreshed) runtime.log("held workflow reattach marker refresh refused", { sessionID: sid, workflowID: workflow.id })
  } catch (error) {
    runtime.log("held workflow reattach marker refresh failed", { sessionID: sid, workflowID: workflow.id, error: (error as Error)?.message ?? String(error) })
  }
}

/** Open an attachment held first. Only a genuinely new Otter session receives its initial process-local token. */
export function attachAdmission(
  runtime: ExecutionRuntime,
  sid: string,
  metadata: { engine: string; model?: string; routes?: ComboRoutes },
  options: { startHeld?: boolean } = {},
): SessionStore {
  if (metadata.engine !== runtime.host.identity.engine) throw new Error("session admission engine does not match the selected host")
  const requestedRoutes = routesKey(metadata.routes)
  const registryKey = key(runtime.worktree, sid)
  const alreadyOwned = getOwnedSession(runtime.worktree, sid)
  if (alreadyOwned) {
    alreadyOwned.assertOwner()
    if (routesKey(alreadyOwned.metadata.routes) !== requestedRoutes) throw new Error("session admission routes do not match the selected host")
    if (alreadyOwned.metadata.held) {
      if (pendingSkillPermissionActivityCountForSession(runtime.worktree, sid) > 0) {
        throw new Error("session permission activity is still settling; held owner cannot be rebound")
      }
      tokens.delete(registryKey)
      rebindHeldWorkflow(runtime, alreadyOwned, sid)
    }
    return alreadyOwned
  }

  if (pendingSkillPermissionActivityCountForSession(runtime.worktree, sid) > 0) {
    throw new Error("session permission activity is still settling; attachment cannot be reclaimed")
  }

  const priorState = existsSync(sessionDir(runtime.worktree, sid))
  const workflowState = readWorkflowChecked(runtime.worktree, sid)
  if (workflowState.corrupt) throw new Error("workflow state is corrupt; new-session admission refused")
  const priorWorkflow = workflowState.wf?.sessionID === sid
  const priorMetadata = readSessionMetadata(runtime.worktree, sid)
  const store = openSession(runtime.worktree, sid, priorMetadata ? undefined : metadata)
  if (store.sessionID !== sid) throw new Error("session store identity mismatch")
  if (store.metadata.engine !== metadata.engine || (metadata.model !== undefined && store.metadata.model !== metadata.model)) {
    throw new Error("session admission metadata does not match the selected host")
  }
  if (routesKey(store.metadata.routes) !== requestedRoutes) throw new Error("session admission routes do not match the selected host")
  tokens.delete(registryKey)

  if (options.startHeld || store.restored || priorState || priorWorkflow) {
    const reason = pendingUserStop(runtime.worktree, sid) ? "user_stop" : "restore"
    writeHold(runtime.worktree, sid, store, reason)
    if (options.startHeld && !store.restored && !priorState && !priorWorkflow) {
      // Burn the creation-only clear capability without registering an admission token. The durable hold
      // marker is already present and the attachment lock prevents another owner from observing this window.
      try { store.clearHold({ authorized: true, reason: "new-session" }) }
      catch (error) {
        try { store.hold(reason) } catch { /* the durable hold marker and absent token remain fail-closed */ }
        throw error
      }
    }
    store.hold(reason)
    rebindHeldWorkflow(runtime, store, sid)
    return store
  }

  // openSession durably creates held metadata before this process-local admission becomes visible.
  store.clearHold({ authorized: true, reason: "new-session" })
  tokens.set(registryKey, { epoch: store.epoch, store, engine: metadata.engine })
  if (!tokenIsCurrent(runtime.worktree, sid, tokens.get(registryKey)!)) {
    tokens.delete(registryKey)
    store.hold("new-session-admission-validation-failed")
    throw new Error("new session admission could not be validated")
  }
  return store
}

/** Attach a vendor-selected session without ever granting the initial new-session admission. */
export function attachHeldAdmission(
  runtime: ExecutionRuntime,
  sid: string,
  metadata: { engine: string; model?: string; routes?: ComboRoutes },
): SessionStore {
  return attachAdmission(runtime, sid, metadata, { startHeld: true })
}

/** A live or already-held exact owner may request stop; a later stop invalidates in-flight Resume checks. */
export function holdOwnedAdmission(worktree: string, sid: string, reason: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) throw new TypeError("invalid session ID")
  if (!reason.trim() || reason.length > 512) throw new TypeError("invalid session hold reason")
  const registryKey = key(worktree, sid)
  const token = tokens.get(registryKey)
  const store = getOwnedSession(worktree, sid)
  if (!store || store.sessionID !== sid) throw new Error("session attachment has no matching admission owner")
  let validatedOwner = false
  try {
    store.assertOwner()
    const live = token?.store === store && token.epoch === store.epoch && tokenIsCurrent(worktree, sid, token)
    if (!live) {
      const marker = readJsonFile(markerPath(worktree, sid))
      const held = marker.exists && "value" in marker && marker.value && typeof marker.value === "object" &&
        (marker.value as HoldMarker).sid === sid && (marker.value as HoldMarker).epoch === store.epoch &&
        (marker.value as HoldMarker).held === true && store.metadata.held && readSessionMetadata(worktree, sid)?.held === true
      const checked = readWorkflowChecked(worktree, sid)
      const workflow = checked.wf?.sessionID === sid ? checked.wf : null
      if (!held || checked.corrupt || workflow &&
          (workflow.owner.instance !== store.epoch || workflow.owner.pid !== process.pid || workflow.engine !== store.metadata.engine)) {
        throw new Error("session attachment admission is not current")
      }
    }
    validatedOwner = true
    writeHold(worktree, sid, store, reason)
    store.hold(reason)
    return store.epoch
  } finally {
    tokens.delete(registryKey)
    if (validatedOwner) cancelSkillPermissionActivities(worktree, sid, store.epoch, new Error(`session owner held: ${reason}`))
  }
}

/** Durably hold this process's attachment before a safety cancellation or other lifecycle mutation. */
export function holdAdmission(worktree: string, sid: string, reason: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) throw new TypeError("invalid session ID")
  if (!reason.trim() || reason.length > 512) throw new TypeError("invalid session hold reason")
  const registryKey = key(worktree, sid)
  const token = tokens.get(registryKey)
  tokens.delete(registryKey)
  const store = getOwnedSession(worktree, sid)
  if (!store) {
    if (readJsonFile(endRequestedPath(worktree, sid)).exists || readJsonFile(endedPath(worktree, sid)).exists) return
    const checked = readWorkflowChecked(worktree, sid)
    if (checked.corrupt) throw new Error("workflow state is corrupt; admission remains held")
    const workflow = checked.wf?.sessionID === sid ? checked.wf : null
    const epoch = "unowned-request"
    durableWriteJson(markerPath(worktree, sid), {
      version: 1,
      sid,
      held: true,
      reason,
      epoch,
      ...(workflow ? { workflowID: workflow.id, workflowRevision: workflow.lastSeq } : {}),
      updatedAt: Date.now(),
    })
    if (reason === "host_session_deleted") {
      durableWriteJson(endRequestedPath(worktree, sid), {
        version: 1,
        sid,
        epoch,
        reason,
        requestedAt: Date.now(),
      })
    }
    return
  }
  store.assertOwner()
  if (token && token.epoch !== store.epoch) throw new Error("session attachment epoch changed")
  cancelSkillPermissionActivities(worktree, sid, store.epoch, new Error(`session owner held: ${reason}`))
  let endRequestExists = false
  if (reason === "host_session_deleted") {
    const ended = readJsonFile(endedPath(worktree, sid))
    if (ended.exists && ("corrupt" in ended || (ended.value as Record<string, unknown>).sid !== sid || (ended.value as Record<string, unknown>).epoch !== store.epoch)) {
      throw new Error("session end marker belongs to another or unknown attachment epoch")
    }
    const request = readJsonFile(endRequestedPath(worktree, sid))
    if (request.exists) {
      if ("corrupt" in request || (request.value as Record<string, unknown>).sid !== sid ||
          (request.value as Record<string, unknown>).epoch !== store.epoch) {
        throw new Error("session end request belongs to another or unknown attachment epoch")
      }
      endRequestExists = true
    }
  }
  writeHold(worktree, sid, store, reason)
  store.hold(reason)
  if (reason === "host_session_deleted" && !endRequestExists) {
    durableWriteJson(endRequestedPath(worktree, sid), {
      version: 1,
      sid,
      epoch: store.epoch,
      reason,
      requestedAt: Date.now(),
    })
  }
}

function hasUnsettledExecution(runtime: ExecutionRuntime): boolean {
  const status = runtime.runs.status()
  return !!status.claim || status.executions.some(execution => !settled(execution))
}

export function assertAdmissionQuiescent(runtime: ExecutionRuntime, sid: string): void {
  const owned = getOwnedSession(runtime.worktree, sid)
  if (owned && pendingSkillPermissionActivityCount(runtime.worktree, sid, owned.epoch) > 0) {
    throw new Error("skill permission activity is still settling")
  }
  const activity = executionActivity(runtime.worktree)
  if (activity && activity.kind !== "permission") throw new Error("execution activity is still active")
  if (getQueue(runtime).isRunning(sid)) throw new Error("session queue is still active")
  if (sessionActivityBlocker(runtime.worktree, sid)) throw new Error("stage reservation or activity is still active")
  if (hasUnsettledExecution(runtime)) throw new Error("execution claim or intent is unsettled")
}

function retainedEndAllowsDetach(worktree: string, sid: string, epoch: string): boolean {
  const request = readJsonFile(endRequestedPath(worktree, sid))
  const end = readJsonFile(endedPath(worktree, sid))
  if (!request.exists && !end.exists) return true
  if (!request.exists || !end.exists || "corrupt" in request || "corrupt" in end) return false
  const requested = request.value as Record<string, unknown> | null
  const ended = end.value as Record<string, unknown> | null
  if (!requested || !ended || requested.version !== 1 || ended.version !== 1 ||
      requested.sid !== sid || ended.sid !== sid || requested.reason !== "host_session_deleted" ||
      ended.reason !== "host_session_deleted" || typeof ended.epoch !== "string" ||
      ended.epoch === epoch || requested.epoch !== ended.epoch) return false
  const released = inspectSessionAttachment(worktree, sid, ended.epoch)
  return released?.state === "released" &&
    released.workflowID === (ended.workflowID ?? null) &&
    released.revision === (ended.workflowRevision ?? null)
}

/** Safely detach a held session for switching without marking its retained history ended. */
export async function detachAdmission(
  runtime: ExecutionRuntime,
  sid: string,
  expectedEpoch: string,
  reason: string,
): Promise<boolean> {
  if (!expectedEpoch || typeof reason !== "string" || !reason.trim() || reason.length > 512) return false
  const owned = getOwnedSession(runtime.worktree, sid)
  if (!owned || owned.epoch !== expectedEpoch || owned.sessionID !== sid) return false
  try {
    holdAdmission(runtime.worktree, sid, reason)
    const detached = withFlowTransaction<boolean>(runtime.worktree, tx => {
      const checked = readWorkflowForWrite(tx)
      if (checked.corrupt) return false
      const workflow = checked.wf
      if (workflow?.sessionID === sid && (
        workflowEngineRefusal(workflow, runtime.host.identity.engine) ||
        (!TERMINAL.has(workflow.phase) &&
          (workflow.owner.instance !== expectedEpoch || workflow.owner.pid !== process.pid)) ||
        isCancelPending(workflow)
      )) return false
      if (!retainedEndAllowsDetach(runtime.worktree, sid, expectedEpoch)) return false
      assertAdmissionQuiescent(runtime, sid)
      if (getOwnedSession(runtime.worktree, sid)?.epoch !== expectedEpoch) return false
      owned.assertOwner()
      if (workflow?.sessionID === sid) stopHeartbeat(runtime.worktree, sid)
      owned.release({
        workflowQuiescent: true,
        evidence: `held session detached after quiescence: ${reason}`,
        workflowID: workflow?.sessionID === sid ? workflow.id : null,
        revision: workflow?.sessionID === sid ? workflow.lastSeq : null,
      })
      tokens.delete(key(runtime.worktree, sid))
      return true
    }, sid)
    return detached
  } catch (error) {
    runtime.log("session detach remains held", { sessionID: sid, epoch: expectedEpoch, error: (error as Error)?.message ?? String(error) })
    return false
  }
}

/**
 * Change the model/routes of the session this process owns, in place: same session ID, epoch, history and workflow.
 * Refused unless the admission is live and epoch-current (not held, not foreign), the engine is unchanged, any
 * workflow bound to the session is owned by this attachment and not stopping, and nothing is running or unsettled.
 * Settled execution records keep the policy ID they ran under; only unsettled ones are policy-checked by recovery.
 */
export function rebindAdmissionModel(
  runtime: ExecutionRuntime,
  sid: string,
  expectedEpoch: string,
  next: { engine: string; model: string; routes?: ComboRoutes },
): { from: { engine: string; model?: string; routes?: ComboRoutes }; to: { engine: string; model?: string; routes?: ComboRoutes }; workflowID?: string } {
  if (!expectedEpoch) throw new Error("model rebind refused: no session epoch")
  const owned = getOwnedSession(runtime.worktree, sid)
  if (!owned || owned.epoch !== expectedEpoch || owned.sessionID !== sid) throw new Error("model rebind refused: session attachment is not owned by this process")
  if (owned.metadata.engine !== next.engine || runtime.host.identity.engine !== next.engine) throw new Error("model rebind refused: the session engine cannot change")
  if (!isAdmissionCurrent(runtime.worktree, sid, expectedEpoch)) throw new Error("model rebind refused: the session is held or its admission is not current")
  return withFlowTransaction(runtime.worktree, tx => {
    const checked = readWorkflowForWrite(tx)
    if (checked.corrupt) throw new Error("model rebind refused: workflow state is corrupt")
    const workflow = checked.wf?.sessionID === sid && !TERMINAL.has(checked.wf.phase) ? checked.wf : undefined
    if (workflow) {
      if (workflowEngineRefusal(workflow, next.engine)) throw new Error("model rebind refused: workflow engine identity mismatch")
      if (workflow.owner.instance !== expectedEpoch || workflow.owner.pid !== process.pid) throw new Error("model rebind refused: workflow is not owned by this attachment")
      if (isCancelPending(workflow) || workflow.stopIntent) throw new Error("model rebind refused: workflow stop is pending")
    }
    assertAdmissionQuiescent(runtime, sid)
    owned.assertOwner()
    const changed = owned.rebindModel({ engine: next.engine, model: next.model, ...(next.routes ? { routes: next.routes } : {}) })
    return { ...changed, ...(workflow ? { workflowID: workflow.id } : {}) }
  }, sid)
}

/** Explicit Resume clears admission only after a held attachment is already bound to this workflow epoch. */
export function resumeAdmission(
  runtime: ExecutionRuntime,
  sid: string,
  expectedWorkflowRevision?: number,
): SessionStore {
  const store = getOwnedSession(runtime.worktree, sid)
  if (!store) throw new Error("session attachment is not owned by this process")
  store.assertOwner()
  const marker = readJsonFile(markerPath(runtime.worktree, sid))
  if (!marker.exists || "corrupt" in marker) throw new Error("durable held-owner binding is missing or corrupt")
  const binding = marker.value as Record<string, unknown>
  if (binding.version !== 1 || binding.sid !== sid || binding.epoch !== store.epoch || binding.held !== true ||
      typeof binding.reason !== "string" || binding.reason.length === 0 || binding.reason.length > 512) {
    throw new Error("durable held-owner binding does not match this attachment")
  }
  const metadata = readSessionMetadata(runtime.worktree, sid)
  if (!metadata || !metadata.held || metadata.engine !== runtime.host.identity.engine ||
      runtime.host.identity.engine !== store.metadata.engine) {
    throw new Error("session engine or held metadata does not match this owner")
  }

  const acknowledgingUserStop = binding.reason === "user_stop"
  if (hasEndMarker(runtime.worktree, sid)) throw new Error("session end request remains held")
  const stop = readJsonFile(abortPath(runtime.worktree, sid))
  if (stop.exists) {
    if (!acknowledgingUserStop || "corrupt" in stop || !exactUserStop(stop.value)) {
      throw new Error("only an exact user_stop marker can be acknowledged")
    }
  } else if (acknowledgingUserStop && !hasUserStopAudit(runtime.worktree, sid)) {
    throw new Error("exact user_stop marker is missing")
  }

  const before = readWorkflowChecked(runtime.worktree, sid)
  if (before.corrupt) throw new Error("workflow state is corrupt")
  const workflow = before.wf
  const ownedWorkflow = workflow?.sessionID === sid ? workflow : null
  if (!ownedWorkflow) {
    if (expectedWorkflowRevision !== undefined || binding.workflowID !== undefined || binding.workflowRevision !== undefined) {
      throw new Error("held session workflow binding changed")
    }
  } else {
    if (workflowEngineRefusal(ownedWorkflow, runtime.host.identity.engine)) throw new Error("workflow engine does not match this owner")
    const requestedRevision = expectedWorkflowRevision ?? ownedWorkflow.lastSeq
    if (requestedRevision !== ownedWorkflow.lastSeq) throw new Error("workflow revision changed; explicit resume refused")
    if (binding.workflowID !== ownedWorkflow.id || binding.workflowRevision !== requestedRevision) {
      throw new Error("held owner binding workflow identity or revision changed")
    }
    if (isCancelPending(ownedWorkflow) || TERMINAL.has(ownedWorkflow.phase)) throw new Error("terminal or cancelling workflow cannot be resumed")
    if (ownedWorkflow.phase === "paused" || ownedWorkflow.stopIntent) throw new Error("a paused or stopping workflow resumes only through the workflow Resume")
    if (ownedWorkflow.owner.instance !== store.epoch || ownedWorkflow.owner.pid !== process.pid) {
      throw new Error("workflow is not bound to this attachment epoch")
    }
    if (acknowledgingUserStop && (ownedWorkflow.phase !== "stuck" || (ownedWorkflow as { stuckCause?: string }).stuckCause !== "user_stop")) {
      throw new Error("workflow user_stop has not settled")
    }
  }

  let admissionMutationStarted = false
  try {
    withFlowTransaction<number | undefined>(runtime.worktree, tx => {
      const checked = readWorkflowForWrite(tx)
      if (checked.corrupt) throw new Error("workflow state is corrupt")
      const current = checked.wf?.sessionID === sid ? checked.wf : null
      if ((current?.id ?? undefined) !== (ownedWorkflow?.id ?? undefined) ||
          (current?.lastSeq ?? undefined) !== (ownedWorkflow?.lastSeq ?? undefined)) {
        throw new Error("workflow changed after attachment; explicit resume refused")
      }
      if (current && (current.owner.instance !== store.epoch || current.owner.pid !== process.pid)) {
        throw new Error("workflow is not bound to this attachment epoch")
      }
      if (current && workflowEngineRefusal(current, runtime.host.identity.engine)) {
        throw new Error("workflow engine does not match this owner")
      }
      if (current && (isCancelPending(current) || TERMINAL.has(current.phase))) {
        throw new Error("terminal or cancelling workflow cannot be resumed")
      }
      if (current && (current.phase === "paused" || current.stopIntent)) {
        throw new Error("a paused or stopping workflow resumes only through the workflow Resume")
      }
      if (acknowledgingUserStop && current && (current.phase !== "stuck" || (current as { stuckCause?: string }).stuckCause !== "user_stop")) {
        throw new Error("workflow user_stop has not settled")
      }
      if (current && expectedWorkflowRevision !== undefined && current.lastSeq !== expectedWorkflowRevision) {
        throw new Error("workflow revision changed; explicit resume refused")
      }
      if (getOwnedSession(runtime.worktree, sid) !== store || store.sessionID !== sid || store.epoch !== binding.epoch) {
        throw new Error("session attachment epoch changed before explicit resume")
      }
      store.assertOwner()
      const currentMetadata = readSessionMetadata(runtime.worktree, sid)
      if (!currentMetadata || !currentMetadata.held || currentMetadata.engine !== runtime.host.identity.engine) {
        throw new Error("session engine or held metadata changed before explicit resume")
      }
      assertAdmissionQuiescent(runtime, sid)
      if (hasEndMarker(runtime.worktree, sid)) throw new Error("session end request remains held")
      const latestMarker = readJsonFile(markerPath(runtime.worktree, sid))
      if (!latestMarker.exists || "corrupt" in latestMarker) throw new Error("held owner binding is missing or corrupt")
      const latestBinding = latestMarker.value as Record<string, unknown>
      if (latestBinding.version !== 1 || latestBinding.sid !== sid || latestBinding.epoch !== store.epoch ||
          latestBinding.workflowID !== current?.id || latestBinding.workflowRevision !== current?.lastSeq ||
          latestBinding.held !== true || latestBinding.reason !== binding.reason) {
        throw new Error("held owner binding changed before admission")
      }
      const currentStop = readJsonFile(abortPath(runtime.worktree, sid))
      if (currentStop.exists) {
        if (!acknowledgingUserStop || "corrupt" in currentStop || !exactUserStop(currentStop.value)) {
          throw new Error("only an exact user_stop marker can be acknowledged")
        }
      } else if (acknowledgingUserStop && !hasUserStopAudit(runtime.worktree, sid)) {
        throw new Error("exact user_stop marker is missing")
      }
      if (!acknowledgingUserStop && currentStop.exists) throw new Error("session stop request remains held")

      if (acknowledgingUserStop) {
        admissionMutationStarted = true
        archiveUserStop(runtime.worktree, sid)
      }
      admissionMutationStarted = true
      clearValidatedResume(store)
      const cleared = holdMarker(runtime.worktree, sid, store.epoch)
      if (!cleared) throw new Error("could not persist resume binding")
      durableWriteJson(markerPath(runtime.worktree, sid), { ...cleared, held: false, reason: "explicit-resume" })
      return current?.lastSeq
    }, sid)
  } catch (error) {
    tokens.delete(key(runtime.worktree, sid))
    if (admissionMutationStarted) {
      try { writeHold(runtime.worktree, sid, store, binding.reason) } catch { /* the absent token still fails closed */ }
      try { store.hold(binding.reason) } catch { /* the absent token still fails closed */ }
    }
    throw error
  }

  return admitValidatedStore(runtime, sid, store)
}

/** End only this process's matching held epoch after cancellation and execution retirement are proven. */
export async function endAdmission(runtime: ExecutionRuntime, sid: string, expectedEpoch: string): Promise<boolean> {
  if (!expectedEpoch) return false
  const owned = getOwnedSession(runtime.worktree, sid)
  if (!owned || owned.epoch !== expectedEpoch || owned.sessionID !== sid) return false
  try {
    owned.assertOwner()
    const request = readJsonFile(endRequestedPath(runtime.worktree, sid))
    if (!request.exists || "corrupt" in request) return false
    const requested = request.value as Record<string, unknown>
    if (requested.version !== 1 || requested.sid !== sid || requested.epoch !== expectedEpoch) return false
    holdAdmission(runtime.worktree, sid, "host_session_deleted")

    return withFlowTransaction<boolean>(runtime.worktree, tx => {
      const checked = readWorkflowForWrite(tx)
      if (checked.corrupt) return false
      const workflow = checked.wf
      const activity = executionActivity(runtime.worktree)
      if (pendingSkillPermissionActivityCount(runtime.worktree, sid, expectedEpoch) > 0 ||
          (activity && activity.kind !== "permission") || sessionActivityBlocker(runtime.worktree, sid) ||
          getQueue(runtime).isRunning(sid) || hasUnsettledExecution(runtime)) return false
      if (workflow?.sessionID === sid && (
        workflowEngineRefusal(workflow, runtime.host.identity.engine) ||
        workflow.owner.instance !== expectedEpoch || workflow.owner.pid !== process.pid ||
        !TERMINAL.has(workflow.phase) || isCancelPending(workflow)
      )) return false
      if (getOwnedSession(runtime.worktree, sid)?.epoch !== expectedEpoch) return false
      owned.assertOwner()

      durableWriteJson(endedPath(runtime.worktree, sid), {
        version: 1,
        sid,
        epoch: expectedEpoch,
        reason: "host_session_deleted",
        ...(workflow?.sessionID === sid ? { workflowID: workflow.id, workflowRevision: workflow.lastSeq } : {}),
        endedAt: Date.now(),
      })
      if (workflow?.sessionID === sid) stopHeartbeat(runtime.worktree, sid)
      owned.release({
        workflowQuiescent: true,
        evidence: "owned queue and execution state are quiescent; workflow cancellation is settled",
        workflowID: workflow?.sessionID === sid ? workflow.id : null,
        revision: workflow?.sessionID === sid ? workflow.lastSeq : null,
      })
      tokens.delete(key(runtime.worktree, sid))
      return true
    }, sid)
  } catch (error) {
    runtime.log("session end remains held", { sessionID: sid, epoch: expectedEpoch, error: (error as Error)?.message ?? String(error) })
    return false
  }
}
