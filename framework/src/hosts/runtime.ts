import { INSTANCE_ID } from "../flow/owner.ts"
import { getBackend } from "../data/backend.ts"
import { DEFAULT_SUITE, loadSuite, runChecks } from "../data/check.ts"
import type { CoreDeps } from "../deps.ts"
import { observeSkillTask, observeSkillVerification } from "../telemetry/skill-observer.ts"
import { createLegacyVerifierExecutor } from "../orchestration/legacy-verifier.ts"
import { createLinuxVerifierExecutor } from "../orchestration/linux-verifier.ts"
import { realpathSync, statSync } from "node:fs"
import { stateRoot } from "../state/store.ts"
import { createExecutionRunStore, type ExecutionRunStore } from "./run-state.ts"
import { createExecutionPolicy, type ExecutionPolicyOptions } from "./tool-policy.ts"
import { inspectLinuxVerifierProfile, linuxBootEpochMatches } from "./linux-domain.ts"
import { firstSkillPermissionActivity } from "../skills/activity.ts"
import {
  LinuxAdmissionRefused,
  type ExecutionHost,
  type ExecutionPolicy,
  type ExecutionRuntime,
  type LinuxAdmission,
  type LinuxAdmissionReason,
  type PlanSubmissionAdmission,
} from "./types.ts"

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

/** Assemble a host-independent execution runtime around the selected host implementation. */
export function createExecutionRuntime(
  deps: CoreDeps,
  hostFactory: (parts: { policy: ExecutionPolicy; runs: ExecutionRunStore }) => ExecutionHost,
  options: Pick<ExecutionPolicyOptions, "planningOnlyMain" | "chatExecuteMain" | "nativeContext" | "routes" | "skillLoaderCanaryInstructions"> = {},
): ExecutionRuntime {
  const verificationProfile = deps.config.delegate.verifier
  if (verificationProfile !== "legacy-unowned" && verificationProfile !== "linux-single-use") {
    throw new TypeError("invalid verifier selection")
  }

  const policy = createExecutionPolicy(deps.config, {
    directory: deps.directory,
    worktree: deps.worktree,
    planningOnlyMain: options.planningOnlyMain,
    chatExecuteMain: options.chatExecuteMain,
    nativeContext: options.nativeContext,
    routes: options.routes,
    skillLoaderCanaryInstructions: options.skillLoaderCanaryInstructions,
  })
  const runs = createExecutionRunStore(deps.worktree)
  const host = hostFactory({ policy, runs })
  return {
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
      ...(deps.verifyRun ? { verifyRun: deps.verifyRun } : {}),
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
}

export type ActivityKind = "queue" | "review" | "stage" | "experiment"
type Activity = { token: symbol; sessionID: string; kind: ActivityKind; workflowID?: string; abort?: (cause: string) => void }
const active = new Map<string, Activity>()
/** Synchronous stage reservations taken before `reviewing` is committed and released when the review begins or is refused. */
const reservations = new Map<string, Map<symbol, string>>()

function canonical(worktree: string): string | undefined {
  try { return realpathSync.native(worktree) } catch { return undefined }
}

/** Read-only local activity evidence; missing filesystem identity is not quiescence. */
export function executionActivity(worktree: string): { sessionID: string; kind: Activity["kind"] | "permission" } | null {
  const key = realpathSync.native(worktree)
  const entry = active.get(key)
  if (entry) return { sessionID: entry.sessionID, kind: entry.kind }
  const permission = firstSkillPermissionActivity(key)
  return permission ? { sessionID: permission.sessionID, kind: "permission" } : null
}

/** True while a registry activity or a stage reservation exists for this session. Unresolvable worktrees fail closed. */
export function sessionActivityBlocker(worktree: string, sessionID: string): string | undefined {
  const key = canonical(worktree)
  if (!key) return "worktree identity is unavailable"
  const entry = active.get(key)
  if (entry?.sessionID === sessionID) return `${entry.kind} activity is still active`
  for (const owner of reservations.get(key)?.values() ?? []) if (owner === sessionID) return "stage reservation is still active"
  return undefined
}

/** Reserve the stage window synchronously; the returned release is idempotent. */
export function beginStageReservation(worktree: string, sessionID: string): () => void {
  const key = canonical(worktree)
  if (!key) throw new Error("worktree identity is unavailable")
  const token = Symbol("stage-reservation")
  let held = reservations.get(key)
  if (!held) reservations.set(key, held = new Map())
  held.set(token, sessionID)
  return () => {
    const current = reservations.get(key)
    current?.delete(token)
    if (current?.size === 0) reservations.delete(key)
  }
}

/** Ask the registered activity for this session to abort with the stop cause. Returns whether a handle was invoked. */
export function abortSessionActivities(worktree: string, sessionID: string, cause: string): boolean {
  const key = canonical(worktree)
  const entry = key ? active.get(key) : undefined
  if (!entry || entry.sessionID !== sessionID || !entry.abort) return false
  entry.abort(cause)
  return true
}

/** Serialize queue and advisory review in one process before either changes a ledger.
 * Cross-process exclusivity and crash recovery remain the run store's responsibility.
 */
export function beginExecutionActivity(
  runtime: ExecutionRuntime,
  sessionID: string,
  kind: ActivityKind,
  options: { workflowID?: string; abort?: (cause: string) => void } = {},
): (() => void) | null {
  let key: string
  try {
    key = realpathSync.native(runtime.worktree)
    if (!statSync(key).isDirectory()) return null
  } catch {
    return null
  }
  try {
    if (active.has(key) || firstSkillPermissionActivity(key)) return null
  } catch {
    return null
  }
  const token = Symbol(kind)
  active.set(key, { token, sessionID, kind, ...(options.workflowID ? { workflowID: options.workflowID } : {}), ...(options.abort ? { abort: options.abort } : {}) })
  return () => {
    if (active.get(key)?.token === token) active.delete(key)
  }
}
