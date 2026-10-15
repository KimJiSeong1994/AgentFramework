// Workflow stage turn (P5a S7.3). One bounded model turn bound to a workflow/revision/kind/stage/role/prompt hash/attempt/
// supervisor SID/epoch, run under the durable intent discipline lifted from the planning conversation:
//   budget -> preflight/admission -> activity -> claim -> durable registerIntent -> inert prepare -> markHostDispatched ->
//   run -> recordTerminal -> reconcile -> release only when quiescent; an unknown/unproven stop keeps the fence.
// The turn never commits workflow state. Ownership, hold, revision and stop are re-checked before and after every await;
// a stale binding yields a diagnostic result only, and late model output is never a state transition. The model returns
// typed stage events (parseStageEvents); lifecycle, owner and receipt fields are rejected outright.
import { randomUUID } from "node:crypto"
import { assertHostAdmission } from "../hosts/required-controls.ts"
import { beginExecutionActivity } from "../hosts/runtime.ts"
import { adoptForeignStop, observeStopSettlement } from "../flow/runtime.ts"
import type { ExecutionClaim } from "../hosts/run-state.ts"
import type { ExecutionHandle, ExecutionOutcome, ExecutionPolicyHandlers, ExecutionRequest, ExecutionRole, ExecutionRuntime } from "../hosts/types.ts"
import { finishSkillInvocation, type SkillInvocationContext } from "../skills/context.ts"
import { getOwnedSession } from "../sessions/store.ts"
import { DEEP_INTERVIEW_SUMMARIZE_PROMPT, RALPLAN_SUMMARIZE_PROMPT, SUMMARIZE_PROMPT, ULTRAGOAL_SUMMARIZE_PROMPT, AUTORESEARCH_SUMMARIZE_PROMPT } from "./prompts/index.ts"
import { promptIntact, type StagePrompt } from "./prompts/prompt.ts"
import { readCommitted } from "./commit.ts"
import { kindAllowsRole, REGISTRY } from "./registry.ts"
import { assertNever, TERMINAL, type WorkflowKind } from "./types.ts"

export type TurnBinding = {
  /** Null for a conversation that is not (yet) bound to a workflow; the revision/owner checks are then skipped. */
  workflowID: string | null
  revision: number | null
  kind: WorkflowKind
  stage: string
  role: ExecutionRole
  prompt: StagePrompt
  supervisorSessionID: string
  /** Attachment epoch of the supervising session store; null when the turn runs without an owned store. */
  epoch: string | null
  /** Owner instance recorded on the bound workflow at bind time; null when no workflow is bound. */
  ownerInstance: string | null
}

export type TurnBudget = { maxChars: number; reserveChars: number }

export type TurnRequest = {
  title: string
  /** Full request text. It MUST begin with the bound prompt text. */
  text: string
  budget: TurnBudget
  /** Label used in refusal text, e.g. "planning". */
  label: string
  /** Opaque cancel cause forwarded to the host (P5b threads `workflow_pause:<token>` through here). */
  cancelCause: string
  /** Read-only compaction used for the single budget-overflow retry. */
  compact?: { source: string; rebuild(summary: string): string }
  /** Runs after claim, before the intent is registered: policy handlers, skill binding, final text. */
  bind?(request: Omit<ExecutionRequest, "handlers">): { handlers: ExecutionPolicyHandlers; skillContext?: SkillInvocationContext; text?: string }
}

export type TurnResult =
  | { status: "completed"; text: string }
  /** Binding went stale (owner/hold/revision/stop). Nothing was committed; `lateText` is diagnostic only. */
  | { status: "diagnostic"; reason: string; lateText?: string }
  /** Visible stuck: the bounded input could not be made to fit. The engine decides how to record it. */
  | { status: "stuck"; cause: "input_budget"; reason: string }

const MAX_LATE_TEXT = 2_000

export type ModelRequestFailureCategory = "model_failed" | "empty_response" | "response_budget"

const MODEL_REQUEST_DIAGNOSTICS: Readonly<Record<ModelRequestFailureCategory, string>> = {
  model_failed: "The model request failed after execution stopped. Check the selected model or CLI, then submit the draft again manually.",
  empty_response: "The model returned no usable response after execution stopped. Review the draft, then submit it again manually.",
  response_budget: "The model response exceeded the configured response budget. Shorten the draft, then submit it again manually.",
}
/** Issued only after settlement; the display diagnostic is fixed, not provider text. */
export class ModelRequestError extends Error {
  readonly category: ModelRequestFailureCategory
  readonly diagnostic: string

  constructor(category: ModelRequestFailureCategory, message: string) {
    super(message)
    if (!Object.hasOwn(MODEL_REQUEST_DIAGNOSTICS, category)) throw new TypeError("invalid model request failure category")
    this.name = "ModelRequestError"
    this.category = category
    this.diagnostic = MODEL_REQUEST_DIAGNOSTICS[category]
  }
}

function fits(text: string, budget: TurnBudget): boolean {
  return text.length + budget.reserveChars <= budget.maxChars
}

/** Why the binding is no longer current, or undefined. Pure reads; never mutates workflow, ledger or session state. */
export function bindingStaleReason(runtime: Pick<ExecutionRuntime, "worktree">, binding: TurnBinding): string | undefined {
  if (binding.epoch !== null) {
    let store: ReturnType<typeof getOwnedSession>
    try { store = getOwnedSession(runtime.worktree, binding.supervisorSessionID) }
    catch { return "session ownership lost" }
    if (!store || store.epoch !== binding.epoch) return "owner epoch changed"
    if (store.metadata.held) return "session is held"
  }
  if (binding.workflowID !== null) {
    let committed: ReturnType<typeof readCommitted>
    try { committed = readCommitted(runtime.worktree) }
    catch { return "workflow state is unreadable" }
    if (committed.state !== "ok") return "workflow state is unavailable"
    const { wf } = committed
    if (wf.id !== binding.workflowID || wf.sessionID !== binding.supervisorSessionID) return "workflow identity changed"
    if (wf.kind !== binding.kind) return "workflow kind changed"
    if (TERMINAL.has(wf.phase)) return "workflow is terminal"
    if (committed.index.revision !== binding.revision || wf.lastSeq !== binding.revision) return "workflow revision changed"
    if (wf.stage !== binding.stage) return "workflow stage changed"
    if (binding.ownerInstance !== null && wf.owner.instance !== binding.ownerInstance) return "workflow owner changed"
    if (wf.stopIntent !== null) return "workflow stop requested"
    if (wf.phase === "paused") return "workflow is paused"
  }
  return undefined
}

/**
 * Ultragoal model turns are role-scoped per stage: a worker (or any other registered role) can never be bound to a
 * review or planning stage, and the code-owned stages (select, approval, execute, verify, checkpoint) take no model turn.
 * The summarizer role (planner) is the only addition at the review stages.
 */
const ULTRAGOAL_STAGE_ROLES: Readonly<Record<string, readonly string[]>> = {
  decompose: ["planner"], unit_plan: ["planner"], unit_review: ["architect", "planner"], final_review: ["critic", "planner"],
}

/** Autoresearch model turns are role-scoped per stage; the code-owned stages (approval, run, verdict) take no model turn. */
const AUTORESEARCH_STAGE_ROLES: Readonly<Record<string, readonly string[]>> = {
  intake: ["researcher"], hypothesis: ["researcher"], evidence: ["researcher", "data-analyst"], experiment_prepare: ["researcher"], evaluate: ["critic", "researcher"],
}

function assertBinding(binding: TurnBinding, request: Pick<TurnRequest, "text">): void {
  if (binding.kind === "autoresearch" && !(AUTORESEARCH_STAGE_ROLES[binding.stage] ?? []).includes(binding.role)) {
    throw new TypeError(`role ${binding.role} is not schedulable at autoresearch stage ${binding.stage}`)
  }
  if (binding.kind === "ultragoal" && !(ULTRAGOAL_STAGE_ROLES[binding.stage] ?? []).includes(binding.role)) {
    throw new TypeError(`role ${binding.role} is not schedulable at ultragoal stage ${binding.stage}`)
  }
  const stages: readonly string[] = REGISTRY[binding.kind].stages
  if (!stages.includes(binding.stage)) throw new TypeError("turn stage is not a stage of the bound kind")
  if (!kindAllowsRole(binding.kind, binding.role)) throw new TypeError(`role ${binding.role} is not schedulable by ${binding.kind} workflows`)
  if (!kindAllowsRole(binding.prompt.kind, binding.prompt.role)) throw new TypeError(`prompt role ${binding.prompt.role} is not schedulable by ${binding.prompt.kind} workflows`)
  if (binding.prompt.kind !== binding.kind || binding.prompt.role !== binding.role) throw new TypeError("turn prompt does not match the bound kind and role")
  if (!promptIntact(binding.prompt)) throw new TypeError("turn prompt hash does not match its text")
  if (!request.text.startsWith(binding.prompt.text)) throw new TypeError("turn request does not carry the bound prompt")
  if (!/^[a-f0-9]{64}$/.test(binding.prompt.sha256)) throw new TypeError("turn prompt hash is malformed")
}

/**
 * The summarizer of a kind. The summary turn is a real dispatch, so its (kind, role) must pass the same guards as any
 * stage turn: a deep-interview overflow never runs as `main`, and a kind without a summarizer cannot overflow-retry.
 */
export function summarizerFor(kind: WorkflowKind): StagePrompt {
  let prompt: StagePrompt
  switch (kind) {
    case "plan": prompt = SUMMARIZE_PROMPT; break
    case "deep-interview": prompt = DEEP_INTERVIEW_SUMMARIZE_PROMPT; break
    case "ralplan": prompt = RALPLAN_SUMMARIZE_PROMPT; break
    case "ultragoal": prompt = ULTRAGOAL_SUMMARIZE_PROMPT; break
    case "autoresearch": prompt = AUTORESEARCH_SUMMARIZE_PROMPT; break
    default: return assertNever(kind, "workflow kind")
  }
  if (prompt.kind !== kind || !kindAllowsRole(kind, prompt.role) || !promptIntact(prompt)) throw new TypeError(`summary prompt ${prompt.id} is not schedulable by ${kind} workflows`)
  return prompt
}

class SummaryUnusable extends Error {}

/** The `workflow_<kind>:<token>` cancel cause when the bound workflow has a recorded stop intent. Pure read. */
function stopCauseOf(runtime: Pick<ExecutionRuntime, "worktree">, binding: TurnBinding): string | undefined {
  if (binding.workflowID === null) return undefined
  try {
    const committed = readCommitted(runtime.worktree)
    if (committed.state !== "ok" || committed.wf.id !== binding.workflowID || !committed.wf.stopIntent) return undefined
    return `workflow_${committed.wf.stopIntent.kind}:${committed.wf.stopIntent.token}`
  } catch { return undefined }
}

/** Lets the stage activity registry and the stop poll reach the live handle of the running dispatch. */
type TurnControl = { abort?: (cause: string) => void; stopped?: boolean }
type Dispatch = { binding: TurnBinding; request: TurnRequest; text: string; signal?: AbortSignal; summary?: boolean; control?: TurnControl }

/** The intent lifecycle for one host execution. Release happens only when the run store proves quiescence. */
async function dispatch(runtime: ExecutionRuntime, input: Dispatch): Promise<TurnResult> {
  const { binding, request, signal } = input
  const sessionID = binding.supervisorSessionID
  let stale: string | undefined
  const checkStale = (): string | undefined => (stale ??= bindingStaleReason(runtime, binding))

  if (checkStale()) return { status: "diagnostic", reason: stale! }
  const executionID = randomUUID()
  const attemptID = randomUUID()
  const policy = runtime.policy.resolve(binding.role)
  const cwd = runtime.worktree
  const deadlineAt = Date.now() + runtime.config.delegate.task_ttl_ms
  const claim: ExecutionClaim = runtime.runs.claim(sessionID, runtime.instance, process.pid)
  let registered = false
  let handle: ExecutionHandle | undefined
  let skillContext: SkillInvocationContext | undefined
  let cancelWork: Promise<void> | undefined
  let cancelCause = request.cancelCause
  let stopPoll: ReturnType<typeof setInterval> | undefined
  const onSignalAbort = () => abort()
  const abort = (cause?: string) => {
    if (typeof cause === "string") cancelCause = cause
    if (cancelWork || !handle) return
    const owned = handle
    cancelWork = (async () => {
      const requestedAt = Date.now()
      let persistenceFailed = false
      let persistenceError: unknown
      try { runtime.runs.recordCancel(claim, executionID, { requestedAt }) }
      catch (error) { persistenceFailed = true; persistenceError = error }

      let cancellationFailed = false
      let cancellationError: unknown
      let acknowledged = false
      try {
        const result = await owned.requestCancel(cancelCause, requestedAt + 2_000)
        acknowledged = result.acknowledged
      } catch (error) { cancellationFailed = true; cancellationError = error }

      try {
        runtime.runs.recordCancel(claim, executionID, {
          requestedAt, ...(acknowledged ? { acknowledgedAt: Date.now() } : {}),
        })
      } catch (error) {
        if (!persistenceFailed) { persistenceFailed = true; persistenceError = error }
      }
      if (persistenceFailed) throw persistenceError
      if (cancellationFailed) throw cancellationError
    })()
    // The normal turn joins this promise; prevent an event-handler rejection from escaping.
    void cancelWork.catch(() => {})
  }
  try {
    const base = {
      executionID, supervisorSessionID: sessionID, taskID: executionID,
      attemptID, generation: claim.generation, role: binding.role,
      title: request.title, cwd, text: input.text, deadlineAt, policy,
    }
    const bound = request.bind?.(base)
    skillContext = bound?.skillContext
    const text = bound?.text ?? base.text
    assertBinding(binding, { text })
    if (!fits(text, request.budget)) {
      return { status: "stuck", cause: "input_budget", reason: `${request.label} request exceeds the input budget` }
    }
    const handlers = bound?.handlers ?? runtime.policy.handlers({ ...base, text })
    const executionRequest = { ...base, text }
    runtime.runs.registerIntent(claim, {
      executionId: executionID, ownerSession: sessionID, taskId: executionRequest.taskID,
      attemptId: executionRequest.attemptID, generation: claim.generation, role: binding.role,
      cwd, policyID: policy.id, kind: "host", engine: runtime.host.identity.engine,
      profile: "legacy-unowned", ...(runtime.host.identity.controlProfile ? { controlProfile: runtime.host.identity.controlProfile } : {}),
      workflowBinding: {
        workflowID: binding.workflowID, revision: binding.revision, kind: binding.kind, stage: binding.stage,
        role: binding.role, promptSha: binding.prompt.sha256, attemptId: attemptID,
        supervisorSessionID: sessionID, epoch: binding.epoch,
      },
    })
    registered = true
    handle = await runtime.host.prepare({
      ...executionRequest, handlers, ...(skillContext ? { skillContext } : {}),
      onReference(reference) { runtime.runs.bindVendorRef(claim, executionID, JSON.stringify(reference)); return undefined },
    })
    if (handle.reference.executionID !== executionID) throw new Error(`${request.label} execution identity mismatch`)
    let outcome: ExecutionOutcome
    // Stale or stopped after the inert prepare: never dispatch; cancel the owned handle and settle it.
    signal?.addEventListener("abort", onSignalAbort, { once: true })
    if (input.control) input.control.abort = (cause) => { input.control!.stopped = true; abort(cause) }
    // A stop recorded while the model runs aborts the owned handle with the stop token as the cancel cause.
    stopPoll = setInterval(() => {
      const cause = stopCauseOf(runtime, binding)
      if (cause) { clearInterval(stopPoll); adoptForeignStop(runtime, { sessionID }); abort(cause) }
    }, 50)
    ;(stopPoll as { unref?: () => void }).unref?.()
    if (signal?.aborted || checkStale()) {
      const stopCause = stopCauseOf(runtime, binding)
      if (stopCause) cancelCause = stopCause
      abort()
      await cancelWork
      outcome = { status: "cancelled" }
    } else {
      runtime.runs.markHostDispatched(claim, executionID)
      outcome = await handle.run()
      if (cancelWork) await cancelWork
    }
    const terminal = ["completed", "failed", "cancelled"].includes(outcome.status)
    if (terminal) runtime.runs.recordTerminal(claim, executionID, { outcome: outcome.status, terminalAt: Date.now() })
    const reconciliation = await handle.reconcile()
    runtime.runs.reconcile(claim, executionID, reconciliation)
    if (!terminal || reconciliation.outcome !== "terminal" || !reconciliation.quiescent) {
      throw new Error(`${request.label} execution quiescence is unproven`)
    }
    if (signal?.aborted || outcome.status === "cancelled" && !stale) throw new Error("conversation cancelled")
    // The binding must still hold after the run: a late result under a stale binding is diagnostic only.
    checkStale()
    if (stale) {
      const lateText = outcome.status === "completed" && typeof outcome.text === "string" ? outcome.text.slice(0, MAX_LATE_TEXT) : undefined
      return { status: "diagnostic", reason: stale, ...(lateText ? { lateText } : {}) }
    }
    if (outcome.status !== "completed" || typeof outcome.text !== "string" || !outcome.text.trim()) {
      if (input.summary && outcome.status === "completed") throw new SummaryUnusable("summary was empty")
      if (outcome.status === "failed") {
        throw new ModelRequestError("model_failed", `${request.label} model did not complete a response`)
      }
      throw new ModelRequestError("empty_response", `${request.label} model did not complete a response`)
    }
    if (outcome.text.length > request.budget.reserveChars) {
      if (input.summary) throw new SummaryUnusable("summary exceeds the reserved response budget")
      throw new ModelRequestError("response_budget", `${request.label} response exceeds the reserved conversation response budget`)
    }
    return { status: "completed", text: outcome.text }
  } catch (error) {
    if (registered) {
      // Never abandon a live owned handle or promote an unknown process into safe recovery.
      if (handle) {
        try {
          if (cancelWork) {
            try { await cancelWork } catch { /* Continue cleanup after a cancellation persistence failure. */ }
          }
          let reconciliation = await handle.reconcile()
          if (reconciliation.outcome !== "terminal" || !reconciliation.quiescent) {
            await handle.requestCancel(`${request.label} turn failed`, Date.now() + 2_000)
            reconciliation = await handle.reconcile()
          }
          runtime.runs.reconcile(claim, executionID, reconciliation)
        } catch { /* The durable fence below preserves unknown ownership. */ }
      }
      try { runtime.runs.assertQuiescent(claim) }
      catch { runtime.runs.fence(claim, executionID, `${request.label} execution requires reconciliation`) }
    }
    throw error
  } finally {
    finishSkillInvocation(skillContext)
    if (stopPoll) clearInterval(stopPoll)
    signal?.removeEventListener("abort", onSignalAbort)
    // release refuses unresolved intents, intentionally retaining crash/no-replay fencing.
    try { runtime.runs.release(claim) } catch { /* Retained for explicit reconciliation. */ }
  }
}

/**
 * Run one bound stage turn. Throws on host/lifecycle failure (fence retained when quiescence is unproven); returns a
 * diagnostic when the binding went stale and `stuck` when the input cannot be made to fit the budget.
 */
export async function runWorkflowTurn(runtime: ExecutionRuntime, binding: TurnBinding, request: TurnRequest, signal?: AbortSignal): Promise<TurnResult> {
  assertBinding(binding, request)
  let text = request.text
  let overflowed = false
  if (!fits(text, request.budget)) {
    if (!request.compact) return { status: "stuck", cause: "input_budget", reason: `${request.label} request exceeds the input budget` }
    overflowed = true
  }
  let releaseActivity: (() => void) | null = null
  const control: TurnControl = {}
  try {
    const stale = () => bindingStaleReason(runtime, binding)
    const cancelled = () => { if (signal?.aborted) throw new Error("conversation cancelled") }
    cancelled()
    const preflight = await runtime.host.preflight(runtime.host.identity.profile)
    assertHostAdmission(preflight, runtime.host.identity.controlProfile)
    cancelled()
    let reason = stale()
    if (reason) return { status: "diagnostic", reason }
    runtime.linuxAdmission?.assertBootEpoch()
    await runtime.linuxAdmission?.admitNewExecution()
    cancelled()
    reason = stale()
    if (reason) return { status: "diagnostic", reason }
    // Stage turns count as active even when no queue is running.
    releaseActivity = beginExecutionActivity(runtime, binding.supervisorSessionID, "stage", {
      ...(binding.workflowID ? { workflowID: binding.workflowID } : {}),
      abort: (cause) => control.abort?.(cause),
    })
    if (!releaseActivity) throw new Error("another execution is active")

    if (overflowed) {
      // One read-only summarize retry; any failure to shrink the input is a visible stuck, never a silent truncation.
      const { source, rebuild } = request.compact!
      const summaryPrompt = summarizerFor(binding.kind)
      const summaryText = `${summaryPrompt.text}${source}`
      const summarizeRequest: TurnRequest = {
        title: `${request.title} (summarize)`, text: summaryText, budget: request.budget, label: request.label, cancelCause: request.cancelCause,
      }
      const summaryBinding: TurnBinding = { ...binding, prompt: summaryPrompt, role: summaryPrompt.role }
      assertBinding(summaryBinding, { text: summaryText })
      if (!fits(summaryText, request.budget)) return { status: "stuck", cause: "input_budget", reason: `${request.label} context is too large to summarize` }
      let summary: TurnResult
      try { summary = await dispatch(runtime, { binding: summaryBinding, request: summarizeRequest, text: summaryText, signal, summary: true, control }) }
      catch (error) {
        // Quiescent settlement already happened inside dispatch; only a bounded-output overflow is a visible stuck.
        if (error instanceof SummaryUnusable) return { status: "stuck", cause: "input_budget", reason: `${request.label} summary exceeds the response budget or is empty` }
        throw error
      }
      if (summary.status !== "completed") return summary
      if (!summary.text.trim()) return { status: "stuck", cause: "input_budget", reason: `${request.label} summary was empty` }
      if (summary.text.length >= source.length) return { status: "stuck", cause: "input_budget", reason: `${request.label} summary did not shrink the context` }
      text = rebuild(summary.text)
      assertBinding(binding, { text })
      if (!fits(text, request.budget)) return { status: "stuck", cause: "input_budget", reason: `${request.label} request exceeds the input budget after summarizing` }
    }
    return await dispatch(runtime, { binding, request, text, signal, control })
  } finally {
    releaseActivity?.()
    // The stage activity is part of the stop proof: settle a recorded stop only after it is released.
    if (binding.workflowID !== null) observeStopSettlement(runtime, binding.supervisorSessionID, binding.epoch ?? undefined, "stage")
  }
}

// ---------------------------------------------------------------------------------------------- typed stage events
export type StageEvent =
  | { type: "message"; text: string }
  | { type: "question"; text: string }
  | { type: "decision"; id: string; text: string }
  | { type: "artifact_ref"; key: string; path: string; sha256?: string }
  | { type: "verdict"; verdict: "okay" | "iterate"; findings: string[] }
  | { type: "topology"; components: Array<{ id: string; description: string }>; project: "greenfield" | "brownfield" }
  | { type: "score"; goal: number; constraints: number; criteria: number; context?: number; weakest: string; shape_change?: boolean; evidence: string[] }
  | { type: "panel_finding"; finding: string; rationale: string[]; suggested_options: string[]; confidence: "high" | "medium" | "low" }
  | { type: "closure"; pass: boolean; gaps: string[] }
  | { type: "restatement"; goal: string }
  | { type: "plan_doc"; sections: Array<{ title: string; body: string }> }
  | { type: "goals"; goals: Array<{ title: string; objective: string }> }
  | { type: "unit_plan"; steps: Array<{ title: string; files: string[]; detail: string; verify: string }>; risks: string[] }
  | { type: "lane_verdict"; status?: "CLEAR" | "WATCH" | "BLOCK"; decision?: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"; verdict?: "OKAY" | "ITERATE" | "REJECT"; findings: string[]; suspect?: number[] }
  | { type: "mission"; goal: string; metric: string; direction: "max" | "min" }
  | { type: "hypothesis"; hypotheses: string[] }
  | { type: "evidence"; items: Array<{ path: string; note: string }> }
  | { type: "experiment"; commands: string[]; params: Record<string, string> }

export type StageEventType = StageEvent["type"]
export type StageEventParse = { ok: true; events: StageEvent[] } | { ok: false; reason: string }

export const MAX_STAGE_EVENTS = 32
const MAX_EVENT_TEXT = 8_000
const MAX_PLAN_DOC_BYTES = 16 * 1024
/** Fields that only the runtime may produce. Their presence anywhere in model output is a hard rejection. */
const FORBIDDEN_FIELDS = new Set([
  "phase", "stage", "lifecycle", "owner", "owner_reattached", "epoch", "stopIntent", "pausedFrom", "workflowID", "sessionID", "revision",
  "lastSeq", "kind", "receipt", "approval", "approved", "approvedBy", "subject", "artifacts", "version", "id_token",
])
type Shape = { required: readonly string[]; optional: readonly string[] }
const SHAPES: Readonly<Record<StageEventType, Shape>> = {
  message: { required: ["text"], optional: [] },
  question: { required: ["text"], optional: [] },
  decision: { required: ["id", "text"], optional: [] },
  artifact_ref: { required: ["key", "path"], optional: ["sha256"] },
  verdict: { required: ["verdict", "findings"], optional: [] },
  topology: { required: ["components", "project"], optional: [] },
  score: { required: ["goal", "constraints", "criteria", "weakest", "evidence"], optional: ["context", "shape_change"] },
  panel_finding: { required: ["finding", "rationale", "suggested_options", "confidence"], optional: [] },
  closure: { required: ["pass", "gaps"], optional: [] },
  restatement: { required: ["goal"], optional: [] },
  plan_doc: { required: ["sections"], optional: [] },
  lane_verdict: { required: ["findings"], optional: ["status", "decision", "verdict", "suspect"] },
  mission: { required: ["goal", "metric", "direction"], optional: [] },
  hypothesis: { required: ["hypotheses"], optional: [] },
  evidence: { required: ["items"], optional: [] },
  experiment: { required: ["commands"], optional: ["params"] },
  goals: { required: ["goals"], optional: [] },
  unit_plan: { required: ["steps", "risks"], optional: [] },
}
/**
 * Which event types each kind/stage may emit. Plan accepts exactly its historical set; deep-interview and ralplan accept
 * only their own typed events per stage, so a verdict from a stage that never produces one is a parse failure.
 */
const ALLOWED: Readonly<Record<WorkflowKind, (stage: string) => readonly StageEventType[]>> = {
  plan: () => ["message", "question", "decision", "artifact_ref", "verdict"],
  "deep-interview": stage => {
    switch (stage) {
      case "topology": return ["topology", "message"]
      case "question": return ["question"]
      case "scoring": return ["score"]
      case "panel": return ["panel_finding"]
      case "closure": return ["closure"]
      case "restate": return ["restatement"]
      case "crystallize": return ["artifact_ref", "message"]
      default: return []
    }
  },
  ralplan: stage => {
    switch (stage) {
      case "planner": case "revision": return ["plan_doc"]
      case "architect": case "critic": return ["lane_verdict"]
      case "consensus_emit": return ["artifact_ref", "message"]
      default: return []
    }
  },
  ultragoal: stage => {
    switch (stage) {
      case "decompose": return ["goals"]
      case "unit_plan": return ["unit_plan"]
      case "unit_review": case "final_review": return ["lane_verdict"]
      default: return []
    }
  },
  autoresearch: stage => {
    switch (stage) {
      case "intake": return ["mission"]
      case "hypothesis": return ["hypothesis"]
      case "evidence": return ["evidence"]
      case "experiment_prepare": return ["experiment"]
      case "evaluate": return ["lane_verdict"]
      default: return []
    }
  },
}
const isText = (value: unknown, max = MAX_EVENT_TEXT): value is string => typeof value === "string" && value.length > 0 && value.length <= max
const isTextList = (value: unknown, maxItems: number, max = 1_000): value is string[] =>
  Array.isArray(value) && value.length <= maxItems && value.every(item => isText(item, max))
const isScore = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
const upper = <T extends string>(allowed: readonly T[], value: unknown): value is T => typeof value === "string" && (allowed as readonly string[]).includes(value)

function buildEvent(type: StageEventType, r: Record<string, unknown>): StageEvent | string {
  switch (type) {
    case "message": case "question":
      return isText(r.text) ? { type, text: r.text } : `stage event ${type} text is invalid`
    case "decision":
      return isText(r.id, 128) && isText(r.text) ? { type, id: r.id, text: r.text } : "stage event decision is invalid"
    case "artifact_ref":
      if (!isText(r.key, 128) || !isText(r.path, 1024) || (r.sha256 !== undefined && (typeof r.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.sha256)))) return "stage event artifact_ref is invalid"
      return { type, key: r.key, path: r.path, ...(r.sha256 === undefined ? {} : { sha256: r.sha256 }) }
    case "verdict":
      return (r.verdict === "okay" || r.verdict === "iterate") && isTextList(r.findings, 32) ? { type, verdict: r.verdict, findings: r.findings } : "stage event verdict is invalid"
    case "topology": {
      const components = r.components
      if (!Array.isArray(components) || components.length === 0 || components.length > 16 || !upper(["greenfield", "brownfield"], r.project)) return "stage event topology is invalid"
      const ids = new Set<string>()
      const out: Array<{ id: string; description: string }> = []
      for (const item of components) {
        if (item === null || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => key !== "id" && key !== "description")) return "stage event topology component is invalid"
        const c = item as Record<string, unknown>
        if (!isText(c.id, 64) || !isText(c.description, 500) || ids.has(c.id)) return "stage event topology component is invalid"
        ids.add(c.id)
        out.push({ id: c.id, description: c.description })
      }
      return { type, components: out, project: r.project }
    }
    case "score":
      if (!isScore(r.goal) || !isScore(r.constraints) || !isScore(r.criteria) || (r.context !== undefined && !isScore(r.context)) ||
        !isText(r.weakest, 200) || !isTextList(r.evidence, 8) || (r.shape_change !== undefined && typeof r.shape_change !== "boolean")) return "stage event score is invalid"
      return { type, goal: r.goal, constraints: r.constraints, criteria: r.criteria, ...(r.context === undefined ? {} : { context: r.context }), weakest: r.weakest,
        ...(r.shape_change === undefined ? {} : { shape_change: r.shape_change }), evidence: r.evidence }
    case "panel_finding":
      if (!isText(r.finding, 2_000) || !isTextList(r.rationale, 3) || r.rationale.length === 0 || !isTextList(r.suggested_options, 3) || r.suggested_options.length === 0 ||
        !upper(["high", "medium", "low"], r.confidence)) return "stage event panel_finding is invalid"
      return { type, finding: r.finding, rationale: r.rationale, suggested_options: r.suggested_options, confidence: r.confidence }
    case "closure":
      return typeof r.pass === "boolean" && isTextList(r.gaps, 16) ? { type, pass: r.pass, gaps: r.gaps } : "stage event closure is invalid"
    case "restatement":
      return isText(r.goal, 2_000) ? { type, goal: r.goal } : "stage event restatement is invalid"
    case "plan_doc": {
      const sections = r.sections
      if (!Array.isArray(sections) || sections.length === 0 || sections.length > 32) return "stage event plan_doc is invalid"
      let total = 0
      const out: Array<{ title: string; body: string }> = []
      for (const item of sections) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return "stage event plan_doc is invalid"
        const c = item as Record<string, unknown>
        if (Object.keys(c).some(key => key !== "title" && key !== "body") || !isText(c.title, 200) || !isText(c.body, MAX_PLAN_DOC_BYTES)) return "stage event plan_doc is invalid"
        total += Buffer.byteLength(c.title) + Buffer.byteLength(c.body)
        out.push({ title: c.title, body: c.body })
      }
      return total <= MAX_PLAN_DOC_BYTES ? { type, sections: out } : "stage event plan_doc exceeds the size limit"
    }
    case "goals": {
      const goals = r.goals
      if (!Array.isArray(goals) || goals.length === 0 || goals.length > 10) return "stage event goals is invalid"
      const out: Array<{ title: string; objective: string }> = []
      for (const item of goals) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return "stage event goals is invalid"
        const c = item as Record<string, unknown>
        if (Object.keys(c).some(key => key !== "title" && key !== "objective") || !isText(c.title, 120) || !isText(c.objective, 1_000)) return "stage event goals is invalid"
        out.push({ title: c.title, objective: c.objective })
      }
      return { type, goals: out }
    }
    case "unit_plan": {
      const steps = r.steps
      if (!Array.isArray(steps) || steps.length === 0 || steps.length > 10 || !isTextList(r.risks, 5, 300) || r.risks.length === 0) return "stage event unit_plan is invalid"
      const out: Array<{ title: string; files: string[]; detail: string; verify: string }> = []
      for (const item of steps) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return "stage event unit_plan is invalid"
        const c = item as Record<string, unknown>
        if (Object.keys(c).some(key => !["title", "files", "detail", "verify"].includes(key)) || !isText(c.title, 120) || !isText(c.detail, 1_000) || !isText(c.verify, 300) ||
          !isTextList(c.files, 8, 200) || c.files.length === 0) return "stage event unit_plan is invalid"
        out.push({ title: c.title, files: c.files, detail: c.detail, verify: c.verify })
      }
      return { type, steps: out, risks: r.risks }
    }
    case "mission":
      return isText(r.goal, 1_000) && typeof r.metric === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(r.metric) && (r.direction === "max" || r.direction === "min")
        ? { type, goal: r.goal, metric: r.metric, direction: r.direction } : "stage event mission is invalid"
    case "hypothesis":
      return isTextList(r.hypotheses, 5, 300) && r.hypotheses.length > 0 ? { type, hypotheses: r.hypotheses } : "stage event hypothesis is invalid"
    case "evidence": {
      const items = r.items
      if (!Array.isArray(items) || items.length === 0 || items.length > 10) return "stage event evidence is invalid"
      const out: Array<{ path: string; note: string }> = []
      for (const item of items) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return "stage event evidence is invalid"
        const c = item as Record<string, unknown>
        if (Object.keys(c).some(key => key !== "path" && key !== "note") || !isText(c.path, 512) || !isText(c.note, 600)) return "stage event evidence is invalid"
        out.push({ path: c.path, note: c.note })
      }
      return { type, items: out }
    }
    case "experiment": {
      const params = r.params === undefined ? {} : r.params
      if (!isTextList(r.commands, 8, 300) || r.commands.length === 0 || params === null || typeof params !== "object" || Array.isArray(params)) return "stage event experiment is invalid"
      const entries = Object.entries(params as Record<string, unknown>)
      if (entries.length > 8 || entries.some(([key, value]) => !isText(key, 64) || !isText(value, 300))) return "stage event experiment is invalid"
      return { type, commands: r.commands, params: Object.fromEntries(entries) as Record<string, string> }
    }
    case "lane_verdict": {
      const { status, decision, verdict } = r
      if (!isTextList(r.findings, 32) || (status !== undefined && !upper(["CLEAR", "WATCH", "BLOCK"], status)) ||
        (decision !== undefined && !upper(["APPROVE", "COMMENT", "REQUEST_CHANGES"], decision)) || (verdict !== undefined && !upper(["OKAY", "ITERATE", "REJECT"], verdict))) return "stage event lane_verdict is invalid"
      // Exactly one lane's vocabulary: architect (status+decision together) or critic (verdict alone).
      const architect = status !== undefined && decision !== undefined && verdict === undefined
      const critic = verdict !== undefined && status === undefined && decision === undefined
      if (!architect && !critic) return "stage event lane_verdict must carry architect status+decision or a critic verdict"
      const suspect = r.suspect
      if (suspect !== undefined && (!Array.isArray(suspect) || suspect.length > 50 || !suspect.every(item => Number.isSafeInteger(item) && item >= 1 && item <= 10_000))) return "stage event lane_verdict suspect is invalid"
      return { type, findings: r.findings, ...(status === undefined ? {} : { status }), ...(decision === undefined ? {} : { decision }), ...(verdict === undefined ? {} : { verdict }), ...(suspect === undefined ? {} : { suspect }) } as StageEvent
    }
  }
}

/**
 * Kind- and stage-scoped strict parse of model stage output. The model can describe progress; it can never carry
 * lifecycle, owner or receipt data, and it can only emit the event types its stage is allowed to produce.
 */
export function parseStageEventsFor(output: string, kind: WorkflowKind, stage: string): StageEventParse {
  const allowedTypes = ALLOWED[kind](stage)
  let value: unknown
  try { value = JSON.parse(output.trim()) } catch { return { ok: false, reason: "stage output is not JSON" } }
  const list = Array.isArray(value) ? value
    : value !== null && typeof value === "object" && Object.keys(value).length === 1 && Array.isArray((value as { events?: unknown }).events) ? (value as { events: unknown[] }).events
    : [value]
  if (list.length === 0 || list.length > MAX_STAGE_EVENTS) return { ok: false, reason: "stage output has no events or too many events" }
  const events: StageEvent[] = []
  for (const item of list) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return { ok: false, reason: "stage event is not an object" }
    const record = item as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (FORBIDDEN_FIELDS.has(key)) return { ok: false, reason: `stage event carries runtime-owned field ${key}` }
    }
    const type = record.type
    if (typeof type !== "string" || !Object.hasOwn(SHAPES, type)) return { ok: false, reason: "stage event type is unknown" }
    if (!(allowedTypes as readonly string[]).includes(type)) return { ok: false, reason: `stage event ${type} is not allowed in ${kind} stage ${stage}` }
    const shape = SHAPES[type as StageEventType]
    const allowed = new Set(["type", ...shape.required, ...shape.optional])
    if (Object.keys(record).some(key => !allowed.has(key)) || shape.required.some(key => !(key in record))) {
      return { ok: false, reason: `stage event ${type} has unexpected or missing fields` }
    }
    const built = buildEvent(type as StageEventType, record)
    if (typeof built === "string") return { ok: false, reason: built }
    events.push(built)
  }
  return { ok: true, events }
}

/** Plan-kind parse (the historical entry point): the plan event set at any stage. */
export function parseStageEvents(output: string): StageEventParse {
  return parseStageEventsFor(output, "plan", "draft")
}
