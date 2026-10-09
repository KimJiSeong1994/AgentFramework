import { INSTANCE_ID } from "../flow/owner.ts"
import { enabled, type HookDeps } from "../hooks/types.ts"
import { getBackend } from "../data/backend.ts"
import { DEFAULT_SUITE, loadSuite, runChecks } from "../data/check.ts"
import { observeSkillTask, observeSkillVerification } from "../telemetry/skill-observer.ts"
import { createExecutionRunStore, type ExecutionRecord, type ExecutionRunStore } from "./run-state.ts"
import { createExecutionPolicy } from "./tool-policy.ts"
import { createOpenCodeHost, type OpenCodeRecoveryContext } from "./opencode.ts"
import { createLegacyVerifierExecutor } from "../orchestration/legacy-verifier.ts"
import { createLinuxVerifierExecutor } from "../orchestration/linux-verifier.ts"
import { inspectLinuxVerifierProfile, linuxBootEpochMatches } from "./linux-domain.ts"
import { taskWorktreeOwner } from "../orchestration/worktree.ts"
import { stateRoot } from "../state/store.ts"
import { realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { EXECUTION_ROLES, LinuxAdmissionRefused, type LinuxAdmission, type LinuxAdmissionReason,
  type PlanSubmissionAdmission, type ExecutionReference, type ExecutionRuntime, type ExecutionRole } from "./types.ts"

const runtimes = new WeakMap<HookDeps, ExecutionRuntime>()

/** Fixed installed-root admission only. This never supplies retirement evidence. */
export function createLinuxAdmission({ qualification = false }: { qualification?: boolean } = {}): LinuxAdmission {
  if (typeof qualification !== "boolean") throw new TypeError("invalid Linux admission mode")
  const verifier = createLinuxVerifierExecutor({ qualification })
  const submissions = new WeakSet<PlanSubmissionAdmission>()
  const admitNewExecution = async (): Promise<void> => {
    const reasons: LinuxAdmissionReason[] = []
    const local = inspectLinuxVerifierProfile(qualification)
    for (const problem of local.problems) {
      reasons.push(problem === "root verifier profile is not qualified for production" ? "unqualified" : "profile-invalid")
    }
    const result = await verifier.preflight("linux-single-use")
    const health = result.admission
    if (!health || (!result.compatible && !health.reasons.length &&
      (!health.bootEpochMatch || !health.journal.persistentEffective ||
        !health.journal.persistentEntry || !health.journal.readable))) {
      reasons.push("gate-unavailable")
    } else {
      if (!health.bootEpochMatch) reasons.push("boot-epoch")
      if (!health.journal.persistentEffective) reasons.push("journal-persistence")
      if (!health.journal.persistentEntry) reasons.push("journal-entry")
      if (!health.journal.readable) reasons.push("journal-readable")
      if (health.unknownBound) reasons.push("unknown-bound")
      if (health.staleActive) reasons.push("stale-active")
      if (health.latched) reasons.push("latched")
      if (!health.capacityAvailable && result.compatible && !reasons.length) reasons.push("capacity-exhausted")
      if ((!result.compatible || health.quarantineRequired) && !reasons.length) reasons.push("gate-unavailable")
    }
    if (reasons.length) throw new LinuxAdmissionRefused("admit", reasons)
  }
  return {
    assertBootEpoch() {
      if (!inspectLinuxVerifierProfile(true).compatible) throw new LinuxAdmissionRefused("epoch", ["profile-invalid"])
      if (!linuxBootEpochMatches()) throw new LinuxAdmissionRefused("epoch", ["boot-epoch"])
    },
    admitNewExecution,
    async admitPlanSubmission(sessionID) {
      if (!sessionID) throw new TypeError("invalid plan submission session")
      await admitNewExecution()
      const admission: PlanSubmissionAdmission = Object.freeze({ purpose: "plan-submission", sessionID })
      submissions.add(admission)
      return admission
    },
    consumePlanSubmission(admission, sessionID) {
      if (!admission || !submissions.has(admission) || admission.purpose !== "plan-submission" ||
          admission.sessionID !== sessionID) throw new TypeError("invalid plan submission admission")
      submissions.delete(admission)
    },
  }
}

/** Assemble the single OpenCode runtime per plugin instance; shared modules only receive ExecutionRuntime. */
export function getOpenCodeRuntime(deps: HookDeps): ExecutionRuntime {
  const cached = runtimes.get(deps)
  if (cached) return cached

  const policy = createExecutionPolicy(deps.config, { directory: deps.directory, worktree: deps.worktree })
  const runs = createExecutionRunStore(deps.worktree)
  const hookPipelineAvailable = enabled(deps.config, "config.agents") && enabled(deps.config, "chat.params")
  const host = createOpenCodeHost(deps.client, hookPipelineAvailable ? {
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
  } : undefined)

  const verificationProfile = deps.config.delegate.verifier
  if (verificationProfile !== "legacy-unowned" && verificationProfile !== "linux-single-use") {
    throw new TypeError("invalid verifier selection")
  }
  const runtime: ExecutionRuntime = {
    instance: INSTANCE_ID,
    directory: deps.directory,
    worktree: deps.worktree,
    stateRoot: stateRoot(deps.worktree),
    config: deps.config,
    log: deps.log,
    host,
    verificationProfile,
    verifier: verificationProfile === "linux-single-use" ? createLinuxVerifierExecutor() : createLegacyVerifierExecutor(),
    ...(verificationProfile === "linux-single-use" ? { linuxAdmission: createLinuxAdmission({ qualification: false }) } : {}),
    runs,
    policy,
    observe: {
      task: (fact) => observeSkillTask(deps, fact),
      verification: (fact) => observeSkillVerification(deps, fact),
    },
    ...(deps.config.data.backend === "none" ? {} : {
      dataChecks: async (sql: string, suiteName: string) => {
        const data = deps.config.data
        const suites = suiteName === DEFAULT_SUITE.name
          ? [DEFAULT_SUITE]
          : [DEFAULT_SUITE, loadSuite(deps.worktree, data.checks_dir, suiteName)]
        return runChecks(getBackend(deps), sql, suites, { timeoutMs: data.statement_timeout_ms, maxRows: data.max_rows })
      },
    }),
  }
  runtimes.set(deps, runtime)
  return runtime
}

export function processRiskForSession(runs: ExecutionRunStore, sessionID: string): boolean {
  const execution = runs.status().executions.findLast(record => {
    if (!record.vendorRef) return false
    try { return (JSON.parse(record.vendorRef) as { vendorSessionID?: unknown }).vendorSessionID === sessionID }
    catch { return false }
  })
  return execution?.processRisk !== undefined || !execution
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
    catch { throw new Error("lca: linked task execution reference is corrupt") }
    if (reference && typeof reference === "object" && !Array.isArray(reference)
      && (reference as Record<string, unknown>).vendorSessionID === sessionID) {
      matches.push({ record, reference })
    }
  }
  if (matches.length !== 1) throw new Error("lca: linked task has no unique execution owner")

  const { record, reference } = matches[0]!
  if (!openCodeReference(reference, record.executionId)
    || record.kind !== "host" || record.profile !== "legacy-unowned") {
    throw new Error("lca: linked task execution reference or profile is invalid")
  }
  const boundary = record.boundaryRef
  if (!openCodeReference(boundary, record.executionId) || !sameOpenCodeReference(reference, boundary)) {
    throw new Error("lca: linked task vendor reference does not match its execution identity")
  }
  if (!state.claim || state.generation !== state.claim.generation
    || record.generation !== state.claim.generation || record.ownerSession !== state.claim.ownerSession
    || record.ownerSession !== owner.sessionID || state.claim.ownerSession !== owner.sessionID
    || record.taskId !== owner.taskId) {
    throw new Error("lca: linked task execution owner, task, or generation does not match")
  }
  if (!isAbsolute(record.cwd) || !sameCanonicalDirectory(record.cwd, childWorktree)) {
    throw new Error("lca: linked task execution cwd does not match its child worktree")
  }
  if (record.cancel || record.terminal || record.fence || record.reconciliation?.outcome === "terminal") {
    throw new Error("lca: linked task execution is cancelled, fenced, or terminal")
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
    && left.generation === right.generation && left.role === right.role
    && left.cwd === right.cwd && left.policyID === right.policyID
    && left.vendorRef === right.vendorRef && sameOpenCodeReference(left.boundaryRef, right.boundaryRef)
}

function fixedPolicyForExecution(runtime: ExecutionRuntime, execution: ExecutionRecord) {
  if (!(EXECUTION_ROLES as readonly string[]).includes(execution.role)) {
    throw new Error("lca: unrecognized execution role")
  }
  const role = execution.role as ExecutionRole
  const policy = runtime.policy.resolve(role)
  if (execution.policyID !== policy.id) {
    throw new Error("lca: remote execution policy differs from the fixed owner snapshot")
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
    runtime.runs.markProcessRiskBySession(sessionID)
    return
  }

  let before: ExecutionRecord
  try {
    before = linkedExecutionForSession(source.runs.status(), source.owner, deps.worktree, sessionID)
    const { role, policy } = fixedPolicyForExecution(runtime, before)
    const snapshot = runtime.policy.snapshotForSession(sessionID)
    if (!runtime.policy.handlersForSession(sessionID) || !snapshot || snapshot.role !== role || snapshot.id !== policy.id) {
      throw new Error("lca: linked task policy is not bound to its OpenCode session")
    }
    source.runs.markProcessRiskBySession(sessionID)
    const after = linkedExecutionForSession(source.runs.status(), source.owner, deps.worktree, sessionID)
    fixedPolicyForExecution(runtime, after)
    if (!sameExecutionIdentity(before, after) || !after.processRisk) {
      throw new Error("lca: linked task execution changed before Bash risk was recorded")
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
  const matches = state.executions.filter(record => record.executionId === reference.executionID)
  if (matches.length !== 1) return undefined
  const record = matches[0]!
  if (record.kind !== "host" || record.profile !== "legacy-unowned" || !record.vendorRef
    || !state.claim || state.claim.ownerSession !== record.ownerSession
    || record.generation > state.generation || !isAbsolute(record.cwd) || resolve(record.cwd) !== record.cwd) return undefined

  let persistedReference: unknown
  try { persistedReference = JSON.parse(record.vendorRef) }
  catch { return undefined }
  if (!openCodeReference(persistedReference, record.executionId)
    || persistedReference.vendorSessionID !== reference.vendorSessionID
    || persistedReference.executionID !== reference.executionID) return undefined

  if (record.boundaryRef !== undefined) {
    if (!openCodeReference(record.boundaryRef, record.executionId)
      || record.boundaryRef.vendorSessionID !== persistedReference.vendorSessionID
      || record.boundaryRef.vendorThreadID !== persistedReference.vendorThreadID
      || record.boundaryRef.vendorTurnID !== persistedReference.vendorTurnID) return undefined
  }

  for (const candidate of state.executions) {
    if (!candidate.vendorRef) continue
    let value: unknown
    try { value = JSON.parse(candidate.vendorRef) }
    catch { return undefined }
    if (!openCodeReference(value, candidate.executionId)) return undefined
    if (candidate.executionId !== record.executionId && value.vendorSessionID === reference.vendorSessionID) return undefined
  }

  if (!(EXECUTION_ROLES as readonly string[]).includes(record.role)) return undefined
  const role = record.role as ExecutionRole
  let fixedPolicy: ReturnType<typeof policy.resolve>
  try { fixedPolicy = policy.resolve(role) }
  catch { return undefined }
  if (record.policyID !== fixedPolicy.id) return undefined

  return {
    executionID: record.executionId,
    vendorSessionID: persistedReference.vendorSessionID,
    ownerSession: record.ownerSession,
    cwd: record.cwd,
    role,
    policyID: record.policyID,
    profile: "legacy-unowned",
    processRisk: record.processRisk !== undefined,
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

/** Resolve a child prepared by a foreground controller in another process.
 * The actual plugin process owns the pre-tool hook; an SDK client outside it
 * cannot enforce policy merely by holding an in-memory callback map.
 */
export function policyForOpenCodeSession(deps: HookDeps, sessionID: string) {
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
      managed = state.executions.findLast((record) => {
        if (!record.vendorRef) return false
        try {
          const reference = JSON.parse(record.vendorRef) as { executionID?: unknown; vendorSessionID?: unknown }
          return reference.executionID === record.executionId && reference.vendorSessionID === sessionID
        } catch { return false }
      })
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
    if (managed) throw new Error("lca: execution session is cancelled, fenced or terminal")
    return undefined
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
    throw new Error("lca: required execution policy hooks are disabled")
  }
  const existing = runtime.policy.handlersForSession(sessionID)
  if (existing) return existing
  const request = {
    executionID: execution.executionId, supervisorSessionID: execution.ownerSession,
    taskID: execution.taskId, attemptID: execution.attemptId, generation: execution.generation,
    role, title: "", cwd: execution.cwd, text: "", deadlineAt: 0, policy,
  }
  const handlers = runtime.policy.handlers(request)
  runtime.policy.bindSession(sessionID, handlers, policy)
  return handlers
}
