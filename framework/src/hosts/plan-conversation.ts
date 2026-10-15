import { activeWorkflow, workflowEngineRefusal } from "../flow/state.ts"
import { getOwnedSession } from "../sessions/store.ts"
import { PLAN_MAIN_PROMPT } from "../workflows/prompts/index.ts"
import { runWorkflowTurn, type TurnBinding } from "../workflows/turn.ts"
import type { ExecutionRuntime } from "./types.ts"
import type { Terminal } from "./interactive-session.ts"
import type { PreparedSkillInvocation } from "../skills/session.ts"
import { bindSkillInvocation, finishSkillInvocation, skillInvocationAudit } from "../skills/context.ts"

export const MAX_PLAN_CONVERSATION_CHARS = 24_000
export const MAX_PLAN_CONVERSATION_TURNS = 24
export const PLAN_RESPONSE_RESERVE_CHARS = 8_000

export type ConversationMessage = { role: "user" | "assistant"; text: string }
export type ConversationTurn = { text: string; plan?: unknown; skill?: Readonly<Record<string, string>> }
export type SkillConversationInvocation = {
  prepared: PreparedSkillInvocation
  terminal?: Pick<Terminal, "stdinIsTTY" | "stderrIsTTY" | "choose" | "resume">
}

function validatePriorMessages(prior: readonly ConversationMessage[] | undefined): ConversationMessage[] {
  if (prior === undefined) return []
  if (!Array.isArray(prior) || prior.length % 2 !== 0) {
    throw new TypeError("prior conversation must contain complete user/assistant pairs")
  }
  return prior.map((message, index) => {
    const role = index % 2 === 0 ? "user" : "assistant"
    if (!message || message.role !== role || typeof message.text !== "string" || !message.text.trim()) {
      throw new TypeError("prior conversation must contain alternating non-empty user/assistant pairs")
    }
    return { role, text: message.text }
  })
}

function promptPrefix(verifyAllow: unknown, skillInstructions?: string): string {
  const skill = skillInstructions === undefined ? "" :
    `\nActive skill instructions (captured bytes; base role and execution approval restrictions still apply):\n${skillInstructions}\n`
  return `${PLAN_MAIN_PROMPT.text}\nAllowed verification patterns: ${JSON.stringify(verifyAllow)}${skill}\nConversation:\n`
}

function fitsConversationBudget(requestText: string): boolean {
  return requestText.length + PLAN_RESPONSE_RESERVE_CHARS <= MAX_PLAN_CONVERSATION_CHARS
}

function selectWindow(
  history: readonly ConversationMessage[],
  pending: ConversationMessage,
  prefix: string,
): { messages: ConversationMessage[]; requestText: string } | undefined {
  let messages = [pending]
  let requestText = `${prefix}${JSON.stringify(messages)}`
  if (!fitsConversationBudget(requestText)) return undefined

  let start = history.length
  let includedPairs = 0
  while (start >= 2 && includedPairs < MAX_PLAN_CONVERSATION_TURNS - 1) {
    const candidate = [history[start - 2]!, history[start - 1]!, ...messages]
    const candidateRequestText = `${prefix}${JSON.stringify(candidate)}`
    if (!fitsConversationBudget(candidateRequestText)) break
    messages = candidate
    requestText = candidateRequestText
    start -= 2
    includedPairs++
  }
  return { messages, requestText }
}

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
export function createPlanConversation(
  runtime: ExecutionRuntime,
  sessionID: string,
  prior?: readonly ConversationMessage[],
) {
  if (!sessionID || sessionID === "." || sessionID === ".." || /[\\/\x00-\x1f]/.test(sessionID)) {
    throw new TypeError("invalid conversation session")
  }
  const history = validatePriorMessages(prior)
  let busy = false

  return {
    async turn(text: string, signal?: AbortSignal, skill?: SkillConversationInvocation): Promise<ConversationTurn> {
      if (typeof text !== "string" || !text.trim() || text.length > MAX_PLAN_CONVERSATION_CHARS) {
        throw new Error("conversation message is empty or too large")
      }
      if (busy) throw new Error("conversation already has an active turn")
      if (signal?.aborted) throw new Error("conversation cancelled")
      const pending = { role: "user" as const, text }
      let window = selectWindow(history, pending, promptPrefix(runtime.config.delegate.verify_allow))
      if (!window) throw new Error("conversation message is too large for the reserved context budget")
      const workflow = activeWorkflow(runtime.worktree)
      if (workflow?.sessionID === sessionID) {
        const refusal = workflowEngineRefusal(workflow, runtime.host.identity.engine)
        if (refusal || workflow.phase !== "planning") {
          throw new Error("another workflow or approval must be resolved before continuing the conversation")
        }
      }
      busy = true
      try {
        const title = "LCA planning conversation"
        const owned = workflow?.sessionID === sessionID ? workflow : null
        let store: ReturnType<typeof getOwnedSession>
        try { store = getOwnedSession(runtime.worktree, sessionID) } catch { store = undefined }
        const binding: TurnBinding = {
          workflowID: owned?.id ?? null, revision: owned?.lastSeq ?? null, kind: "plan", stage: owned?.stage ?? "draft", role: "main",
          prompt: PLAN_MAIN_PROMPT, supervisorSessionID: sessionID, epoch: store?.epoch ?? null, ownerInstance: owned?.owner.instance ?? null,
        }
        let audit: Readonly<Record<string, string>> | undefined
        const result = await runWorkflowTurn(runtime, binding, {
          title, text: window.requestText, label: "planning", cancelCause: "planning conversation cancelled",
          budget: { maxChars: MAX_PLAN_CONVERSATION_CHARS, reserveChars: PLAN_RESPONSE_RESERVE_CHARS },
          bind(request) {
            const bound = skill ? bindSkillInvocation(skill.prepared, request, runtime.policy, skill.terminal) : undefined
            if (!bound) return { handlers: runtime.policy.handlers(request) }
            window = selectWindow(history, pending, promptPrefix(runtime.config.delegate.verify_allow, bound.instructions))
            if (!window) { finishSkillInvocation(bound.context); throw new Error("skill instructions exceed the reserved conversation context budget") }
            audit = skillInvocationAudit(bound.context)
            return { handlers: bound.handlers, skillContext: bound.context, text: window.requestText }
          },
        }, signal)
        if (result.status === "diagnostic") throw new Error(`planning conversation superseded: ${result.reason}`)
        if (result.status === "stuck") throw new Error(result.reason)
        history.splice(0, history.length, ...window.messages, { role: "assistant", text: result.text })
        const plan = extractPlan(result.text)
        return { text: result.text, ...(plan === undefined ? {} : { plan }), ...(audit ? { skill: audit } : {}) }
      } finally {
        busy = false
      }
    },
  }
}
