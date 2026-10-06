import { INSTANCE_ID } from "../flow/owner.ts"
import { enabled, type HookDeps } from "../hooks/types.ts"
import { getBackend } from "../data/backend.ts"
import { DEFAULT_SUITE, loadSuite, runChecks } from "../data/check.ts"
import { observeSkillTask, observeSkillVerification } from "../telemetry/skill-observer.ts"
import { createExecutionRunStore, type ExecutionRunStore } from "./run-state.ts"
import { createExecutionPolicy } from "./tool-policy.ts"
import { createOpenCodeHost, type OpenCodeRecoveryContext } from "./opencode.ts"
import { createLegacyVerifierExecutor } from "../orchestration/legacy-verifier.ts"
import { stateRoot } from "../state/store.ts"
import { isAbsolute, resolve } from "node:path"
import { EXECUTION_ROLES, type ExecutionReference, type ExecutionRuntime, type ExecutionRole } from "./types.ts"

const runtimes = new WeakMap<HookDeps, ExecutionRuntime>()

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

  const runtime: ExecutionRuntime = {
    instance: INSTANCE_ID,
    directory: deps.directory,
    worktree: deps.worktree,
    stateRoot: stateRoot(deps.worktree),
    config: deps.config,
    log: deps.log,
    host,
    verificationProfile: "legacy-unowned",
    verifier: createLegacyVerifierExecutor(),
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
  const state = runtime.runs.status()
  const managed = state.executions.findLast((record) => {
    if (!record.vendorRef) return false
    try {
      const reference = JSON.parse(record.vendorRef) as { executionID?: unknown; vendorSessionID?: unknown }
      return reference.executionID === record.executionId && reference.vendorSessionID === sessionID
    } catch { return false }
  })
  const execution = managed && state.claim?.generation === managed.generation
    && state.claim.ownerSession === managed.ownerSession && !managed.terminal && !managed.cancel
    && !managed.fence && !(managed.reconciliation?.outcome === "terminal" && managed.reconciliation.quiescent)
    ? managed : undefined
  if (!execution) {
    runtime.policy.unbindSession(sessionID)
    if (managed) throw new Error("lca: execution session is cancelled, fenced or terminal")
    return undefined
  }
  const existing = runtime.policy.handlersForSession(sessionID)
  if (existing) return existing
  if (!enabled(deps.config, "config.agents") || !enabled(deps.config, "chat.params")) {
    throw new Error("lca: required execution policy hooks are disabled")
  }
  if (!(EXECUTION_ROLES as readonly string[]).includes(execution.role)) throw new Error("lca: unrecognized execution role")
  const role = execution.role as ExecutionRole
  const policy = runtime.policy.resolve(role)
  if (execution.policyID !== policy.id) throw new Error("lca: remote execution policy differs from the fixed owner snapshot")
  const request = {
    executionID: execution.executionId, supervisorSessionID: execution.ownerSession,
    taskID: execution.taskId, attemptID: execution.attemptId, generation: execution.generation,
    role, title: "", cwd: execution.cwd, text: "", deadlineAt: 0, policy,
  }
  const handlers = runtime.policy.handlers(request)
  runtime.policy.bindSession(sessionID, handlers, policy)
  return handlers
}
