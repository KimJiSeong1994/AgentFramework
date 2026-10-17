import { enabled, type HookDeps } from "../hooks/types.ts"
import { createExecutionRunStore, hostRecoveryContext, type ExecutionRecord, type ExecutionRunStore } from "./run-state.ts"
import { createExecutionPolicy } from "./tool-policy.ts"
import { createOpenCodeHost, type OpenCodeRecoveryContext } from "./opencode.ts"
import { taskWorktreeOwner } from "../orchestration/worktree.ts"
import { realpathSync } from "node:fs"
import { isAbsolute } from "node:path"
import { createExecutionRuntime } from "./runtime.ts"
import {
  EXECUTION_ROLES, type ExecutionPolicyHandlers, type ExecutionPolicySnapshot,
  type ExecutionReference, type ExecutionRuntime, type ExecutionRole,
} from "./types.ts"
import { getOwnedSession, inspectCurrentSessionAttachment, readSessionMetadata } from "../sessions/store.ts"
import { effectiveHold } from "../sessions/admission.ts"

const runtimes = new WeakMap<HookDeps, ExecutionRuntime>()

/** Assemble the single OpenCode runtime per plugin instance; shared modules only receive ExecutionRuntime. */
export function getOpenCodeRuntime(deps: HookDeps): ExecutionRuntime {
  const cached = runtimes.get(deps)
  if (cached) return cached

  const hookPipelineAvailable = enabled(deps.config, "config.agents") && enabled(deps.config, "chat.params")
  const runtime = createExecutionRuntime(deps, ({ policy, runs }) => createOpenCodeHost(deps.client, hookPipelineAvailable ? {
    policy,
    applyOutputLimit(sessionID, maximum) {
      return policy.snapshotForSession(sessionID)?.maxOutputTokens === maximum
    },
    applyThinking(sessionID, mode) {
      return policy.snapshotForSession(sessionID)?.thinking === mode
    },
    processRisk(sessionID) {
      return processRiskForSession(runs, sessionID)
    },
    recoveryContext(reference) {
      return recoveryContextForOpenCodeReference(runs, policy, reference)
    },
  } : undefined))
  runtimes.set(deps, runtime)
  return runtime
}

export function processRiskForSession(runs: ExecutionRunStore, sessionID: string): boolean {
  const matches: ExecutionRecord[] = []
  for (const record of runs.status().executions) {
    if (!record.vendorRef) continue
    let value: unknown
    try { value = JSON.parse(record.vendorRef) }
    catch { return true }
    if (!value || typeof value !== "object" || Array.isArray(value)) return true
    const reference = value as Record<string, unknown>
    if (reference.vendorSessionID !== sessionID) continue
    if (!boundOpenCodeReference(record)) return true
    matches.push(record)
  }
  return matches.length !== 1 || matches[0]!.processRisk !== undefined
}

type ExecutionStoreSource = {
  owner?: NonNullable<ReturnType<typeof taskWorktreeOwner>>
  runs: ExecutionRunStore
}

function executionStoreFor(deps: HookDeps, runtime: ExecutionRuntime): ExecutionStoreSource {
  const owner = taskWorktreeOwner(deps.worktree)
  return { owner, runs: owner ? createExecutionRunStore(owner.mainWorktree) : runtime.runs }
}

function linkedExecutionForSession(
  state: ReturnType<ExecutionRunStore["status"]>,
  owner: NonNullable<ReturnType<typeof taskWorktreeOwner>>,
  childWorktree: string,
  sessionID: string,
): ExecutionRecord {
  const matches: Array<{ record: ExecutionRecord; reference: unknown }> = []
  for (const record of state.executions) {
    if (!record.vendorRef) continue
    let reference: unknown
    try { reference = JSON.parse(record.vendorRef) }
    catch { throw new Error("otter: linked task execution reference is corrupt") }
    if (reference && typeof reference === "object" && !Array.isArray(reference)
      && (reference as Record<string, unknown>).vendorSessionID === sessionID) {
      matches.push({ record, reference })
    }
  }
  if (matches.length !== 1) throw new Error("otter: linked task has no unique execution owner")

  const { record, reference } = matches[0]!
  if (!openCodeReference(reference, record.executionId)
    || record.kind !== "host" || record.engine !== "opencode" || record.profile !== "legacy-unowned") {
    throw new Error("otter: linked task execution reference or profile is invalid")
  }
  const boundary = record.boundaryRef
  if (!openCodeReference(boundary, record.executionId) || !sameOpenCodeReference(reference, boundary)) {
    throw new Error("otter: linked task vendor reference does not match its execution identity")
  }
  if (!state.claim || state.generation !== state.claim.generation
    || record.generation !== state.claim.generation || record.ownerSession !== state.claim.ownerSession
    || record.ownerSession !== owner.sessionID || state.claim.ownerSession !== owner.sessionID
    || record.taskId !== owner.taskId) {
    throw new Error("otter: linked task execution owner, task, or generation does not match")
  }
  if (!isAbsolute(record.cwd) || !sameCanonicalDirectory(record.cwd, childWorktree)) {
    throw new Error("otter: linked task execution cwd does not match its child worktree")
  }
  if (record.cancel || record.terminal || record.fence || record.reconciliation?.outcome === "terminal") {
    throw new Error("otter: linked task execution is cancelled, fenced, or terminal")
  }
  return record
}

function sameCanonicalDirectory(left: string, right: string): boolean {
  try { return left === realpathSync.native(left) && left === realpathSync.native(right) }
  catch { return false }
}

function sameOpenCodeReference(left: unknown, right: unknown): boolean {
  if (!left || typeof left !== "object" || Array.isArray(left)
    || !right || typeof right !== "object" || Array.isArray(right)) return false
  const a = left as ExecutionReference
  const b = right as ExecutionReference
  return a.executionID === b.executionID && a.vendorSessionID === b.vendorSessionID
    && a.vendorThreadID === b.vendorThreadID && a.vendorTurnID === b.vendorTurnID
}

function sameExecutionIdentity(left: ExecutionRecord, right: ExecutionRecord): boolean {
  return left.executionId === right.executionId && left.ownerSession === right.ownerSession
    && left.taskId === right.taskId && left.attemptId === right.attemptId
    && left.generation === right.generation && left.engine === right.engine && left.role === right.role
    && left.cwd === right.cwd && left.policyID === right.policyID
    && left.vendorRef === right.vendorRef && sameOpenCodeReference(left.boundaryRef, right.boundaryRef)
}

function fixedPolicyForExecution(runtime: ExecutionRuntime, execution: ExecutionRecord) {
  if (execution.kind !== "host" || execution.engine !== "opencode") {
    throw new Error("otter: execution is not owned by the OpenCode engine")
  }
  if (!(EXECUTION_ROLES as readonly string[]).includes(execution.role)) {
    throw new Error("otter: unrecognized execution role")
  }
  const role = execution.role as ExecutionRole
  const policy = runtime.policy.resolve(role)
  if (execution.policyID !== policy.id) {
    throw new Error("otter: remote execution policy differs from the fixed owner snapshot")
  }
  return { role, policy }
}

/** Mark Bash risk in the store that owns this execution; linked workers never write child-local run state. */
export function markOpenCodeProcessRiskForSession(deps: HookDeps, sessionID: string): void {
  const runtime = getOpenCodeRuntime(deps)
  let source: ExecutionStoreSource
  try { source = executionStoreFor(deps, runtime) }
  catch (error) {
    runtime.policy.unbindSession(sessionID)
    throw error
  }
  if (!source.owner) {
    try {
      const matches = source.runs.status().executions.filter(record => {
        if (!record.vendorRef) return false
        try {
          const reference = JSON.parse(record.vendorRef) as { executionID?: unknown; vendorSessionID?: unknown }
          return reference.executionID === record.executionId && reference.vendorSessionID === sessionID
        } catch { return false }
      })
      if (matches.length !== 1 || matches[0]!.kind !== "host" || matches[0]!.engine !== "opencode") {
        throw new Error("otter: shell tool has no unique OpenCode execution owner")
      }
      runtime.runs.markProcessRiskBySession(sessionID, runtime.host.identity.engine)
    } catch (error) {
      runtime.policy.unbindSession(sessionID)
      throw error
    }
    return
  }

  let before: ExecutionRecord
  try {
    before = linkedExecutionForSession(source.runs.status(), source.owner, deps.worktree, sessionID)
    const { role, policy } = fixedPolicyForExecution(runtime, before)
    const snapshot = runtime.policy.snapshotForSession(sessionID)
    if (!runtime.policy.handlersForSession(sessionID) || !snapshot || snapshot.role !== role || snapshot.id !== policy.id) {
      throw new Error("otter: linked task policy is not bound to its OpenCode session")
    }
    source.runs.markProcessRiskBySession(sessionID, runtime.host.identity.engine)
    const after = linkedExecutionForSession(source.runs.status(), source.owner, deps.worktree, sessionID)
    fixedPolicyForExecution(runtime, after)
    if (!sameExecutionIdentity(before, after) || !after.processRisk) {
      throw new Error("otter: linked task execution changed before Bash risk was recorded")
    }
  } catch (error) {
    runtime.policy.unbindSession(sessionID)
    throw error
  }
}

function recoveryContextForOpenCodeReference(
  runs: ExecutionRunStore,
  policy: ReturnType<typeof createExecutionPolicy>,
  reference: ExecutionReference,
): OpenCodeRecoveryContext | undefined {
  if (typeof reference.executionID !== "string" || !reference.executionID
    || typeof reference.vendorSessionID !== "string" || !reference.vendorSessionID) return undefined

  const state = runs.status()
  const context = hostRecoveryContext(state, reference, "opencode", role => policy.resolve(role).id)
  if (!context || context.engine !== "opencode" || context.profile !== "legacy-unowned") return undefined

  for (const candidate of state.executions) {
    if (!candidate.vendorRef) continue
    let value: unknown
    try { value = JSON.parse(candidate.vendorRef) }
    catch { return undefined }
    if (!openCodeReference(value, candidate.executionId)) return undefined
    if (candidate.executionId !== context.executionID && value.vendorSessionID === reference.vendorSessionID) return undefined
  }

  return {
    ...context,
    vendorSessionID: reference.vendorSessionID,
    profile: "legacy-unowned",
  }
}

function openCodeReference(value: unknown, executionID: string): value is ExecutionReference & { vendorSessionID: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const reference = value as Record<string, unknown>
  const known = new Set(["executionID", "vendorSessionID", "vendorThreadID", "vendorTurnID"])
  if (Object.keys(reference).some(key => !known.has(key)) || reference.executionID !== executionID
    || typeof reference.vendorSessionID !== "string" || !reference.vendorSessionID) return false
  return ["vendorThreadID", "vendorTurnID"].every(key => !(key in reference)
    || (typeof reference[key] === "string" && (reference[key] as string).length > 0))
}

function boundOpenCodeReference(record: ExecutionRecord): (ExecutionReference & { vendorSessionID: string }) | undefined {
  if (record.kind !== "host" || record.engine !== "opencode" || !record.vendorRef) return undefined
  let reference: unknown
  try { reference = JSON.parse(record.vendorRef) }
  catch { return undefined }
  if (!openCodeReference(reference, record.executionId)
    || !openCodeReference(record.boundaryRef, record.executionId)
    || !sameOpenCodeReference(reference, record.boundaryRef)) return undefined
  return reference
}

export type OpenCodeSessionPolicyBinding = Readonly<{
  sessionID: string
  ownerWorktree: string
  ownerSessionID: string
  ownerEpoch: string
  executionID: string
  taskID: string
  attemptID: string
  generation: number
  role: ExecutionRole
  policy: ExecutionPolicySnapshot
  handlers: ExecutionPolicyHandlers
}>

/** Resolve a child prepared by a foreground controller in another process.
 * The actual plugin process owns the pre-tool hook; an SDK client outside it
 * cannot enforce policy merely by holding an in-memory callback map.
 */
export function policyBindingForOpenCodeSession(deps: HookDeps, sessionID: string): OpenCodeSessionPolicyBinding | undefined {
  const runtime = getOpenCodeRuntime(deps)
  let source: ExecutionStoreSource
  let execution: ExecutionRecord | undefined
  let managed: ExecutionRecord | undefined
  try {
    source = executionStoreFor(deps, runtime)
    const state = source.runs.status()
    if (source.owner) {
      execution = linkedExecutionForSession(state, source.owner, deps.worktree, sessionID)
    } else {
      let invalidReference = false
      const matches = state.executions.filter((record) => {
        if (!record.vendorRef) return false
        let reference: unknown
        try {
          reference = JSON.parse(record.vendorRef)
        } catch { return false }
        if (!reference || typeof reference !== "object" || Array.isArray(reference)
          || (reference as Record<string, unknown>).vendorSessionID !== sessionID) return false
        if (!boundOpenCodeReference(record)) {
          invalidReference = true
          return false
        }
        return true
      })
      if (invalidReference || matches.length > 1) throw new Error("otter: execution session reference is invalid or ambiguous")
      const unique = matches.length === 1 ? matches[0] : undefined
      managed = unique?.kind === "host" && unique.engine === "opencode" ? unique : undefined
      execution = managed && state.claim?.generation === managed.generation
        && state.claim.ownerSession === managed.ownerSession && !managed.terminal && !managed.cancel
        && !managed.fence && !(managed.reconciliation?.outcome === "terminal" && managed.reconciliation.quiescent)
        ? managed : undefined
    }
  } catch (error) {
    runtime.policy.unbindSession(sessionID)
    throw error
  }
  if (!execution) {
    runtime.policy.unbindSession(sessionID)
    if (managed) throw new Error("otter: execution session is cancelled, fenced or terminal")
    return undefined
  }
  const supervisorWorktree = source.owner?.mainWorktree ?? deps.worktree
  const supervisor = readSessionMetadata(supervisorWorktree, execution.ownerSession)
  const attachment = inspectCurrentSessionAttachment(supervisorWorktree, execution.ownerSession)
  if (!supervisor || supervisor.held || !attachment || attachment.state !== "attached" || attachment.identity !== "live" ||
      getOwnedSession(supervisorWorktree, execution.ownerSession) && effectiveHold(supervisorWorktree, execution.ownerSession)) {
    runtime.policy.unbindSession(sessionID)
    throw new Error("otter: execution supervisor is held or has no proven live session attachment")
  }
  let fixed: ReturnType<typeof fixedPolicyForExecution>
  try {
    fixed = fixedPolicyForExecution(runtime, execution)
  } catch (error) {
    runtime.policy.unbindSession(sessionID)
    throw error
  }
  const { role, policy } = fixed
  if (!enabled(deps.config, "config.agents") || !enabled(deps.config, "chat.params")) {
    runtime.policy.unbindSession(sessionID)
    throw new Error("otter: required execution policy hooks are disabled")
  }
  let canonicalOwnerWorktree: string
  try { canonicalOwnerWorktree = realpathSync.native(supervisorWorktree) }
  catch {
    runtime.policy.unbindSession(sessionID)
    throw new Error("otter: OpenCode execution owner worktree is unavailable")
  }
  if (attachment.worktree !== canonicalOwnerWorktree || attachment.sessionID !== execution.ownerSession || !attachment.epoch ||
      !execution.executionId) {
    runtime.policy.unbindSession(sessionID)
    throw new Error("otter: OpenCode execution binding identity is incomplete")
  }
  const existing = runtime.policy.handlersForSession(sessionID)
  let handlers = existing
  if (handlers) {
    if (runtime.policy.snapshotForSession(sessionID) !== policy) {
      runtime.policy.unbindSession(sessionID)
      throw new Error("otter: OpenCode execution policy snapshot changed")
    }
  } else {
    const request = {
      executionID: execution.executionId, supervisorSessionID: execution.ownerSession,
      taskID: execution.taskId, attemptID: execution.attemptId, generation: execution.generation,
      role, title: "", cwd: execution.cwd, text: "", deadlineAt: 0, policy,
    }
    handlers = runtime.policy.handlers(request)
    runtime.policy.bindSession(sessionID, handlers, policy)
  }
  if (!handlers) {
    runtime.policy.unbindSession(sessionID)
    throw new Error("otter: OpenCode execution handlers are unavailable")
  }
  const finalAttachment = inspectCurrentSessionAttachment(supervisorWorktree, execution.ownerSession)
  const finalSupervisor = readSessionMetadata(supervisorWorktree, execution.ownerSession)
  if (!finalAttachment || finalAttachment.state !== "attached" || finalAttachment.identity !== "live" ||
      finalAttachment.epoch !== attachment.epoch || finalAttachment.worktree !== canonicalOwnerWorktree ||
      !finalSupervisor || finalSupervisor.held ||
      (getOwnedSession(supervisorWorktree, execution.ownerSession) && effectiveHold(supervisorWorktree, execution.ownerSession)) ||
      runtime.policy.handlersForSession(sessionID) !== handlers || runtime.policy.snapshotForSession(sessionID) !== policy) {
    runtime.policy.unbindSession(sessionID)
    throw new Error("otter: OpenCode execution binding changed during policy validation")
  }
  return Object.freeze({
    sessionID,
    ownerWorktree: canonicalOwnerWorktree,
    ownerSessionID: execution.ownerSession,
    ownerEpoch: attachment.epoch,
    executionID: execution.executionId,
    taskID: execution.taskId,
    attemptID: execution.attemptId,
    generation: execution.generation,
    role,
    policy,
    handlers,
  })
}

/** Preserve the existing handler-only API for tool hooks and other callers. */
export function policyForOpenCodeSession(deps: HookDeps, sessionID: string) {
  return policyBindingForOpenCodeSession(deps, sessionID)?.handlers
}
