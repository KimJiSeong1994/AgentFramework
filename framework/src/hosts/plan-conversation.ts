import { randomUUID } from "node:crypto"
import { activeWorkflow, workflowEngineRefusal } from "../flow/state.ts"
import { PLAN_LIMITS } from "../flow/plan.ts"
import { assertHostAdmission } from "./required-controls.ts"
import { beginExecutionActivity } from "./runtime.ts"
import type { ExecutionHandle, ExecutionOutcome, ExecutionRuntime } from "./types.ts"

const MAX_HISTORY_CHARS = 24_000
const MAX_TURNS = 24
const PLAN_INSTRUCTIONS = `You are the planning role of the common LCA terminal. Discuss the user's request and inspect files using the provided read-only tools. Never modify files or run commands. When the user requests a plan, put ONLY the following plan JSON in your final text, without a tool call: {"goal":"...","steps":[{"title":"...","files":["relative/path"],"detail":"...","verify":"bun test ..."}],"risks":["..."]}. A plan requires ${PLAN_LIMITS.minSteps}-${PLAN_LIMITS.maxSteps} concrete steps and ${PLAN_LIMITS.minRisks}-${PLAN_LIMITS.maxRisks} risks. Every step needs affected relative files and an actual allowed verification command. Never treat a request to implement, model text, or prior approval as human approval: the terminal displays the canonical plan and requests a separate local decision. Do not claim work was executed.`

type Message = { role: "user" | "assistant"; text: string }
export type ConversationTurn = { text: string; plan?: unknown }

function extractPlan(text: string): unknown | undefined {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
  let value: unknown
  try { value = JSON.parse(fenced?.[1] ?? trimmed) } catch { return undefined }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const object = value as Record<string, unknown>
  const candidate = object.plan && typeof object.plan === "object" ? object.plan : object
  if (Array.isArray(candidate)) return undefined
  const plan = candidate as Record<string, unknown>
  return typeof plan.goal === "string" && Array.isArray(plan.steps) ? plan : undefined
}

/** Main turns use the same durable intent/lease/owned-handle discipline as queued workers. */
export function createPlanConversation(runtime: ExecutionRuntime, sessionID: string) {
  if (!sessionID || sessionID === "." || sessionID === ".." || /[\\/\x00-\x1f]/.test(sessionID)) {
    throw new TypeError("invalid conversation session")
  }
  const history: Message[] = []
  let busy = false

  return {
    async turn(text: string, signal?: AbortSignal): Promise<ConversationTurn> {
      if (typeof text !== "string" || !text.trim() || text.length > MAX_HISTORY_CHARS) {
        throw new Error("conversation message is empty or too large")
      }
      if (busy) throw new Error("conversation already has an active turn")
      if (signal?.aborted) throw new Error("conversation cancelled")
      const messages = [...history, { role: "user" as const, text }]
      if (messages.length > MAX_TURNS * 2 || messages.reduce((sum, message) => sum + message.text.length, 0) > MAX_HISTORY_CHARS) {
        throw new Error("conversation context limit reached; start a new conversation")
      }
      const workflow = activeWorkflow(runtime.worktree)
      if (workflow) {
        const refusal = workflowEngineRefusal(workflow, runtime.host.identity.engine)
        if (refusal || workflow.sessionID !== sessionID || workflow.phase !== "planning") {
          throw new Error("another workflow or approval must be resolved before continuing the conversation")
        }
      }
      busy = true
      let releaseActivity: (() => void) | null = null
      try {
        const preflight = await runtime.host.preflight(runtime.host.identity.profile)
        assertHostAdmission(preflight, runtime.host.identity.controlProfile)
        if (signal?.aborted) throw new Error("conversation cancelled")
        runtime.linuxAdmission?.assertBootEpoch()
        await runtime.linuxAdmission?.admitNewExecution()
        if (signal?.aborted) throw new Error("conversation cancelled")
        releaseActivity = beginExecutionActivity(runtime, sessionID, "review")
        if (!releaseActivity) throw new Error("another execution is active")
        const executionID = randomUUID()
        const attemptID = randomUUID()
        const policy = runtime.policy.resolve("main")
        const title = "LCA planning conversation"
        const cwd = runtime.worktree
        const requestText = `${PLAN_INSTRUCTIONS}\nAllowed verification patterns: ${JSON.stringify(runtime.config.delegate.verify_allow)}\nConversation:\n${JSON.stringify(messages)}`
        const deadlineAt = Date.now() + runtime.config.delegate.task_ttl_ms
        const claim = runtime.runs.claim(sessionID, runtime.instance, process.pid)
        let registered = false
        let handle: ExecutionHandle | undefined
        let cancelWork: Promise<void> | undefined
        const abort = () => {
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
              const result = await owned.requestCancel("planning conversation cancelled", requestedAt + 2_000)
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
          const request = {
            executionID, supervisorSessionID: sessionID, taskID: executionID,
            attemptID, generation: claim.generation, role: "main" as const,
            title, cwd, text: requestText, deadlineAt, policy,
          }
          const handlers = runtime.policy.handlers(request)
          runtime.runs.registerIntent(claim, {
            executionId: executionID, ownerSession: sessionID, taskId: request.taskID,
            attemptId: request.attemptID, generation: claim.generation, role: "main",
            cwd: request.cwd, policyID: policy.id, kind: "host", engine: runtime.host.identity.engine,
            profile: "legacy-unowned", ...(runtime.host.identity.controlProfile ? { controlProfile: runtime.host.identity.controlProfile } : {}),
          })
          registered = true
          handle = await runtime.host.prepare({
            ...request, handlers,
            onReference(reference) { runtime.runs.bindVendorRef(claim, executionID, JSON.stringify(reference)); return undefined },
          })
          if (handle.reference.executionID !== executionID) throw new Error("planning execution identity mismatch")
          signal?.addEventListener("abort", abort, { once: true })
          let outcome: ExecutionOutcome
          if (signal?.aborted) {
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
            throw new Error("planning execution quiescence is unproven")
          }
          if (signal?.aborted || outcome.status === "cancelled") throw new Error("conversation cancelled")
          if (outcome.status !== "completed" || typeof outcome.text !== "string" || !outcome.text.trim()) {
            throw new Error("planning model did not complete a response")
          }
          if (outcome.text.length > MAX_HISTORY_CHARS) throw new Error("planning response exceeds conversation limit")
          history.push({ role: "user", text }, { role: "assistant", text: outcome.text })
          const plan = extractPlan(outcome.text)
          return { text: outcome.text, ...(plan === undefined ? {} : { plan }) }
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
                  await handle.requestCancel("planning turn failed", Date.now() + 2_000)
                  reconciliation = await handle.reconcile()
                }
                runtime.runs.reconcile(claim, executionID, reconciliation)
              } catch { /* The durable fence below preserves unknown ownership. */ }
            }
            try { runtime.runs.assertQuiescent(claim) }
            catch { runtime.runs.fence(claim, executionID, "planning execution requires reconciliation") }
          }
          throw error
        } finally {
          signal?.removeEventListener("abort", abort)
          // release refuses unresolved intents, intentionally retaining crash/no-replay fencing.
          try { runtime.runs.release(claim) } catch { /* Retained for explicit reconciliation. */ }
        }
      } finally {
        releaseActivity?.()
        busy = false
      }
    },
  }
}
