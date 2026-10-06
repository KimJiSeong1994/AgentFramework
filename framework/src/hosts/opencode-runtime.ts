import { INSTANCE_ID } from "../flow/owner.ts"
import { enabled, type HookDeps } from "../hooks/types.ts"
import { getBackend } from "../data/backend.ts"
import { DEFAULT_SUITE, loadSuite, runChecks } from "../data/check.ts"
import { observeSkillTask, observeSkillVerification } from "../telemetry/skill-observer.ts"
import { createExecutionRunStore, type ExecutionRunStore } from "./run-state.ts"
import { createExecutionPolicy } from "./tool-policy.ts"
import { createOpenCodeHost } from "./opencode.ts"
import { createLegacyVerifierExecutor } from "../orchestration/legacy-verifier.ts"
import { stateRoot } from "../state/store.ts"
import { EXECUTION_ROLES, type ExecutionRuntime, type ExecutionRole } from "./types.ts"

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
