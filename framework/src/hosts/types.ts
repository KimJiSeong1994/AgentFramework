import type { OtterConfig, ModelSelection } from "../config.ts"
import type { CheckRun } from "../data/check.ts"
import type { SkillTaskFactInput, SkillVerificationFactInput } from "../telemetry/skills.ts"
import type { ExecutionRunStore } from "./run-state.ts"
import type { VerificationExecutor, VerificationProfile } from "../orchestration/verifier.ts"
import type { SkillInvocationContext } from "../skills/context.ts"
import type { SkillHoldTicket } from "../skills/broker.ts"

/** These keys are the existing serialized model configuration, not every runtime role. */
export const CONFIG_MODEL_ROLES = Object.freeze(["main", "worker", "reviewer", "data-analyst", "data-verifier", "ontology-evolver", "answer-judge"] as const)
export const WORKFLOW_READ_ONLY_ROLES = Object.freeze(["interviewer", "planner", "architect", "critic", "researcher", "contrarian", "simplifier"] as const)
export const EXECUTION_ROLES = Object.freeze([...CONFIG_MODEL_ROLES, ...WORKFLOW_READ_ONLY_ROLES] as const)
export type ExecutionRole = (typeof EXECUTION_ROLES)[number]
export type ComboEngine = "local" | "codex" | "claude"
/** Native model IDs the CLI host accepts as argv; combo validation and the host share this one pattern. */
export const NATIVE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/
export type ComboRoute = Readonly<{ engine: ComboEngine; model: string }>
/** role -> route; only roles that differ from the anchor; keys are ExecutionRole */
export type ComboRoutes = Readonly<Partial<Record<ExecutionRole, ComboRoute>>>
export type WorkflowReadOnlyRole = (typeof WORKFLOW_READ_ONLY_ROLES)[number]
export const EXECUTION_TOOL_NAMES = Object.freeze(["read", "glob", "grep", "list", "bash", "write", "edit", "patch", "apply_patch", "multiedit", "webfetch", "skill", "todowrite", "todoread", "delegate", "otter_flow", "db_query", "schema_lookup", "task"] as const)

const CLI_WRITE_CAPABILITY = Object.freeze({
  main: false, worker: true, reviewer: false,
  "data-analyst": true, "data-verifier": true, "ontology-evolver": true, "answer-judge": true,
  interviewer: false, planner: false, architect: false, critic: false,
  researcher: false, contrarian: false, simplifier: false,
} satisfies Record<ExecutionRole, boolean>)

export function isWorkflowReadOnlyRole(role: string): role is WorkflowReadOnlyRole {
  return (WORKFLOW_READ_ONLY_ROLES as readonly string[]).includes(role)
}

/** Capability is necessary, not sufficient: the fixed tool allowlist and denials still apply. */
export function roleAllowsCliWrites(role: ExecutionRole): boolean {
  return Object.hasOwn(CLI_WRITE_CAPABILITY, role) && CLI_WRITE_CAPABILITY[role] === true
}
export type ControlProfile = "estimated-input-reactive-output-v1"
export type BudgetEvidence = {
  input: "estimated"
  output: "reactive"
  vendorContext: "unobserved"
  mainLimit: 8192
  workerLimit: 5120
}
export type HostIdentity = {
  engine: string
  candidateVersion?: string
  actualVersion?: string
  schemaVersion?: string
  profile: string
  controlProfile?: ControlProfile
}

export type ExecutionToolPolicy = { allowed: readonly string[]; denied: readonly string[] }
export type ExecutionPolicySnapshot = {
  id: string
  role: ExecutionRole
  model?: ModelSelection
  maxOutputTokens: number
  tools: ExecutionToolPolicy
  system: readonly string[]
  /** Otter-authored native input outside the JSON prompt; included in policy identity and input estimates. */
  nativeContext?: Readonly<{ identity: string; instructions: string }>
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
  /** Runtime-owned invocation authority, outside policy snapshots and serialized native inputs. */
  skillContext?: SkillInvocationContext
  /**
   * Persist one canonical recovery reference synchronously. During prepare, call before policy binding
   * or returning; during run, emit immediately once the adapter learns a stable engine recovery ID and
   * before run() settles. Never delay it to collect optional metadata or emit an enriched replacement.
   * Identical repeats are permitted. The callback must return undefined.
   */
  onReference?: (reference: ExecutionReference) => undefined
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
  /** Immutable preparation-time identity; later vendor IDs are persisted only through onReference. */
  readonly reference: ExecutionReference
  run(): Promise<ExecutionOutcome>
  /** An acknowledgement is not terminal completion or quiescence. */
  requestCancel(reason: string, deadlineAt: number): Promise<ExecutionCancelResult>
  reconcile(): Promise<ExecutionReconciliation>
}

export interface ExecutionHost {
  readonly identity: HostIdentity
  preflight(profile: string): Promise<{
    compatible: boolean
    controls: Record<string, "supported" | "unsupported" | "unknown">
    problems: string[]
    budgetEvidence?: BudgetEvidence
  }>
  /**
   * Must prepare an inert handle; runtime persists the execution intent before calling handle.run().
   * Until an engine recovery ID is known, handle.reference may contain only executionID. Any later
   * actual vendor ID is persisted through onReference; a process with no ID remains unknown after restart.
   */
  prepare(request: ExecutionRequest): Promise<ExecutionHandle>
  /** Reconcile a persisted vendor reference after restart without preparing or replaying execution. */
  reconcile(reference: ExecutionReference): Promise<ExecutionReconciliation>
}

export type ExecutionDecision = { allow: true } | { allow: false; reason: string; holdTicket?: SkillHoldTicket }
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
    super(`otter: linux admission refused (${phase}): ${bounded.join(",")}`)
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
  config: Readonly<OtterConfig>
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
