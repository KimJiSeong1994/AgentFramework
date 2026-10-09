import type { LcaConfig, ModelSelection } from "../config.ts"
import type { CheckRun } from "../data/check.ts"
import type { SkillTaskFactInput, SkillVerificationFactInput } from "../telemetry/skills.ts"
import type { ExecutionRunStore } from "./run-state.ts"
import type { VerificationExecutor, VerificationProfile } from "../orchestration/verifier.ts"

export const EXECUTION_ROLES = ["main", "worker", "reviewer", "data-analyst", "data-verifier", "ontology-evolver", "answer-judge"] as const
export type ExecutionRole = (typeof EXECUTION_ROLES)[number]
export type HostIdentity = {
  engine: string
  candidateVersion?: string
  actualVersion?: string
  schemaVersion?: string
  profile: string
}

export type ExecutionToolPolicy = { allowed: readonly string[]; denied: readonly string[] }
export type ExecutionPolicySnapshot = {
  id: string
  role: ExecutionRole
  model?: ModelSelection
  maxOutputTokens: number
  tools: ExecutionToolPolicy
  system: readonly string[]
  thinking: "inherit" | "enabled" | "disabled"
}

export type ExecutionRequest = {
  executionID: string
  supervisorSessionID: string
  taskID: string
  attemptID: string
  generation: number
  role: ExecutionRole
  title: string
  cwd: string
  text: string
  deadlineAt: number
  policy: ExecutionPolicySnapshot
  handlers: ExecutionPolicyHandlers
  /** Persist this reference immediately when the host learns it, before any fallible policy binding. */
  onReference?: (reference: ExecutionReference) => void
}

export type ExecutionReference = {
  executionID: string
  vendorSessionID?: string
  vendorThreadID?: string
  vendorTurnID?: string
}

export type ExecutionEvent =
  | { type: "reference"; reference: ExecutionReference }
  | { type: "tool-before"; sessionID: string; callID: string; toolID: string; name: string; input: unknown }
  | { type: "tool-result"; sessionID: string; callID: string; toolID: string; name: string; result?: unknown; error?: unknown }
  | { type: "text"; sessionID: string; partID: string; text: string; final: boolean }
  | { type: "approval"; sessionID: string; requestID: string; kind: string; payload: unknown }
  | { type: "terminal"; sessionID: string; outcome: "completed" | "failed" | "cancelled" | "unresolved" | "incomplete"; usage?: unknown }

export type ExecutionOutcome = {
  status: "completed" | "failed" | "cancelled" | "unresolved" | "incomplete"
  text?: string
  error?: string
  /** Bounded SDK error classification, never an inferred cause or unbounded error payload. */
  errorName?: string
  childMessageID?: string
  outputLimitReached?: boolean
  usage?: unknown
}

export type ExecutionCancelResult = {
  requested: boolean
  acknowledged: boolean
  terminal: boolean
  quiescent: boolean
  evidence?: string
}

export type ExecutionReconciliation = {
  outcome: "running" | "terminal" | "unknown"
  quiescent: boolean
  evidence: string
}

export interface ExecutionHandle {
  readonly reference: ExecutionReference
  run(): Promise<ExecutionOutcome>
  /** An acknowledgement is not terminal completion or quiescence. */
  requestCancel(reason: string, deadlineAt: number): Promise<ExecutionCancelResult>
  reconcile(): Promise<ExecutionReconciliation>
}

export interface ExecutionHost {
  readonly identity: HostIdentity
  preflight(profile: string): Promise<{ compatible: boolean; controls: Record<string, "supported" | "unsupported" | "unknown">; problems: string[] }>
  /** Must prepare an inert handle; runtime persists the execution intent before calling handle.run(). */
  prepare(request: ExecutionRequest): Promise<ExecutionHandle>
  /** Reconcile a persisted vendor reference after restart without preparing or replaying execution. */
  reconcile(reference: ExecutionReference): Promise<ExecutionReconciliation>
}

export type ExecutionDecision = { allow: true } | { allow: false; reason: string }
export type ExecutionPolicyHandlers = {
  beforeTool(event: Extract<ExecutionEvent, { type: "tool-before" }>): ExecutionDecision
  toolResult(event: Extract<ExecutionEvent, { type: "tool-result" }>): { result?: unknown; error?: unknown; trimmed?: boolean; hinted?: boolean }
  assistantText(event: Extract<ExecutionEvent, { type: "text" }>): { cancel: boolean }
}
export interface ExecutionPolicy {
  resolve(role: ExecutionRole): ExecutionPolicySnapshot
  handlers(request: Omit<ExecutionRequest, "handlers">): ExecutionPolicyHandlers
  bindSession(sessionID: string, handlers: ExecutionPolicyHandlers, snapshot: ExecutionPolicySnapshot): void
  unbindSession(sessionID: string): void
  handlersForSession(sessionID: string): ExecutionPolicyHandlers | undefined
  snapshotForSession(sessionID: string): ExecutionPolicySnapshot | undefined
}

export type ExecutionObservation = {
  task?: (fact: SkillTaskFactInput) => void
  verification?: (fact: SkillVerificationFactInput) => void
}

export const LINUX_ADMISSION_REASONS = [
  "boot-epoch", "profile-invalid", "unqualified", "journal-persistence", "journal-entry",
  "journal-readable", "unknown-bound", "stale-active", "latched", "capacity-exhausted", "gate-unavailable",
] as const
export type LinuxAdmissionReason = (typeof LINUX_ADMISSION_REASONS)[number]
export type LinuxAdmissionRefusal = { phase: "epoch" | "admit"; reasons: readonly LinuxAdmissionReason[] }

export class LinuxAdmissionRefused extends Error {
  readonly kind = "linux-admission-refused"
  readonly phase: LinuxAdmissionRefusal["phase"]
  readonly reasons: readonly LinuxAdmissionReason[]

  constructor(phase: LinuxAdmissionRefusal["phase"], reasons: readonly LinuxAdmissionReason[]) {
    if ((phase !== "epoch" && phase !== "admit") || !reasons.length ||
        reasons.some(reason => !LINUX_ADMISSION_REASONS.includes(reason))) {
      throw new TypeError("invalid Linux admission refusal")
    }
    const bounded = [...new Set(reasons)]
    super(`lca: linux admission refused (${phase}): ${bounded.join(",")}`)
    this.name = "LinuxAdmissionRefused"
    this.phase = phase
    this.reasons = Object.freeze(bounded)
  }
}

/** Instance-validated, single-use permission for plan writes, never execution or retirement authority. */
export interface PlanSubmissionAdmission {
  readonly purpose: "plan-submission"
  readonly sessionID: string
}

export interface LinuxAdmission {
  assertBootEpoch(): void
  admitNewExecution(): Promise<void>
  admitPlanSubmission(sessionID: string): Promise<PlanSubmissionAdmission>
  consumePlanSubmission(admission: PlanSubmissionAdmission, sessionID: string): void
}

export type ExecutionRuntime = {
  instance: string
  directory: string
  worktree: string
  stateRoot: string
  config: Readonly<LcaConfig>
  log: (message: string, safeFields?: Record<string, unknown>) => void
  host: ExecutionHost
  verificationProfile: VerificationProfile
  verifier: VerificationExecutor
  linuxAdmission?: LinuxAdmission
  runs: ExecutionRunStore
  policy: ExecutionPolicy
  observe?: ExecutionObservation
  dataChecks?: (sql: string, suiteName: string) => Promise<CheckRun>
}

export type FlowRuntime = Pick<ExecutionRuntime, "worktree" | "config" | "log">
