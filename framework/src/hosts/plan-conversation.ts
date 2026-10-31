import { loadConfig, localContextInputTokens, localContextTrimTargetPercent } from "../config.ts"
import { estimateTokens } from "../tokens.ts"
import { activeWorkflow, workflowEngineRefusal } from "../flow/state.ts"
import { getOwnedSession } from "../sessions/store.ts"
import { PLAN_CHAT_PROMPT, PLAN_MAIN_PROMPT } from "../workflows/prompts/index.ts"
import { ModelRequestError, runWorkflowTurn, type TurnBinding } from "../workflows/turn.ts"
import type { ActionGate, ExecutionRuntime, SkillToolProvider } from "./types.ts"
import type { Terminal } from "./interactive-session.ts"
import type { PreparedSkillInvocation } from "../skills/session.ts"
import { bindSkillInvocation, finishSkillInvocation, skillInvocationAudit } from "../skills/context.ts"
import { cancelMemoryPrefetch, currentMemoryConfig, startMemoryPrefetch } from "../wiki/recall.ts"
import { FACTS_PROMPT_CHARS, factsPromptBlock, worktreeFacts } from "../sessions/history.ts"

/** Conversation window for a local (Ollama) or OpenCode chat model, and the floor every engine gets. */
export const MAX_PLAN_CONVERSATION_CHARS = 24_000
/**
 * Conversation window for a Claude/Codex chat model. It stays inside the host's vendor main-input estimate
 * (cli-host VENDOR_MAIN_INPUT_LIMIT tokens at ~4 characters per token) with room for tools and skills.
 */
export const VENDOR_PLAN_CONVERSATION_CHARS = 96_000
export const MAX_PLAN_CONVERSATION_TURNS = 24
export const PLAN_RESPONSE_RESERVE_CHARS = 8_000

/** The conversation window for a chat model on `engine`. */
export function planConversationChars(engine: string | undefined, localInputTokens = 8192): number {
  if (engine === "local" && localInputTokens !== 8192) return Math.min(196608, localInputTokens * 3)
  return engine === "codex" || engine === "claude" ? VENDOR_PLAN_CONVERSATION_CHARS : MAX_PLAN_CONVERSATION_CHARS
}

export type ConversationMessage = { role: "user" | "assistant"; text: string }
export type ConversationContextState = { messages: ConversationMessage[]; pinnedNote: string }
export type ConversationContextReport = { inputTokens: number; conversationTokens: number; usedTokens: number; pairs: number; pinnedNote: string; droppedPairs: number }
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

type MainPrompt = typeof PLAN_MAIN_PROMPT | typeof PLAN_CHAT_PROMPT

/**
 * The turn prompt follows the main role's actual tools (the runtime's policy, which cli-runtime derives from
 * `chat.execute`): read-only main gets the planning prompt, a main that may write and run commands the chat prompt.
 */
function mainPromptFor(runtime: ExecutionRuntime): MainPrompt {
  const tools = runtime.policy.resolve("main").tools.allowed
  return tools.includes("bash") && tools.includes("edit") ? PLAN_CHAT_PROMPT : PLAN_MAIN_PROMPT
}

function promptPrefix(prompt: MainPrompt, verifyAllow: unknown, skillInstructions?: string, facts = "", pinnedNote = ""): string {
  const skill = skillInstructions === undefined ? "" :
    `\nActive skill instructions (captured bytes; base role and execution approval restrictions still apply):\n${skillInstructions}\n`
  const note = pinnedNote ? `\nPinned user reference (current instructions and execution approvals take precedence):\n${pinnedNote}\nEnd pinned user reference.\n` : ""
  return `${prompt.text}\nAllowed verification patterns: ${JSON.stringify(verifyAllow)}${facts ? `\n${facts}` : ""}${note}${skill}\nConversation:\n`
}

/**
 * Project facts for the acting chat model: commands that pass or keep failing here, from earlier session digests
 * (deterministic, bounded to FACTS_PROMPT_CHARS, reference data). A read-only planning chat does not carry them.
 */
function turnFacts(runtime: ExecutionRuntime, prompt: MainPrompt): string {
  if (prompt !== PLAN_CHAT_PROMPT) return ""
  try { return factsPromptBlock(worktreeFacts(runtime.worktree)) } catch { return "" }
}

/**
 * Characters left for skill instructions when `message` is sent with no prior history. Automatic selection skips a
 * skill larger than this so an oversized skill never fails the turn; explicit `/skill:` invocations still refuse.
 */
export function skillInstructionBudget(verifyAllow: unknown, message = "", engine?: string, inputTokens?: number): number {
  // The longer prompt bounds both modes, so a skill admitted here fits whichever prompt the turn uses.
  const prompt = PLAN_CHAT_PROMPT.text.length > PLAN_MAIN_PROMPT.text.length ? PLAN_CHAT_PROMPT : PLAN_MAIN_PROMPT
  const base = `${promptPrefix(prompt, verifyAllow, "")}${JSON.stringify([{ role: "user", text: message }])}`
  // Room for the project-facts block a turn may carry, so an admitted skill still fits.
  return Math.max(0, planConversationChars(engine, inputTokens) - PLAN_RESPONSE_RESERVE_CHARS - base.length - FACTS_PROMPT_CHARS - 1)
}

function fitsConversationBudget(requestText: string, limit: number): boolean {
  return requestText.length + PLAN_RESPONSE_RESERVE_CHARS <= limit
}

function selectWindow(
  history: readonly ConversationMessage[],
  pending: ConversationMessage,
  prefix: string,
  limit = MAX_PLAN_CONVERSATION_CHARS,
  tokenLimit?: number,
  trimTargetPercent = 70,
): { messages: ConversationMessage[]; requestText: string } | undefined {
  const fits = (text: string) => fitsConversationBudget(text, limit) && (tokenLimit === undefined || estimateTokens(text) <= tokenLimit)
  let messages = [pending]
  let requestText = `${prefix}${JSON.stringify(messages)}`
  if (!fits(requestText)) return undefined

  let start = history.length
  let includedPairs = 0
  while (start >= 2 && includedPairs < MAX_PLAN_CONVERSATION_TURNS - 1) {
    const candidate = [history[start - 2]!, history[start - 1]!, ...messages]
    const candidateRequestText = `${prefix}${JSON.stringify(candidate)}`
    if (!fits(candidateRequestText)) break
    messages = candidate
    requestText = candidateRequestText
    start -= 2
    includedPairs++
  }
  if (tokenLimit !== undefined && start > 0) {
    // Prune in batches to keep the retained prefix stable for several subsequent turns.
    const pendingRequest = `${prefix}${JSON.stringify([pending])}`
    const tokenTarget = Math.max(estimateTokens(pendingRequest), Math.floor(tokenLimit * trimTargetPercent / 100))
    const charTarget = Math.max(pendingRequest.length, Math.floor((limit - PLAN_RESPONSE_RESERVE_CHARS) * trimTargetPercent / 100))
    while (messages.length > 1 && (messages.length > 33 || estimateTokens(requestText) > tokenTarget || requestText.length > charTarget)) {
      messages = messages.slice(2)
      requestText = `${prefix}${JSON.stringify(messages)}`
    }
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
  pinnedNote = "",
) {
  if (!sessionID || sessionID === "." || sessionID === ".." || /[\\/\x00-\x1f]/.test(sessionID)) {
    throw new TypeError("invalid conversation session")
  }
  const history = validatePriorMessages(prior)
  if (typeof pinnedNote !== "string" || pinnedNote.length > 2000) throw new TypeError("pinned note exceeds 2000 characters")
  let busy = false
  let droppedPairs = 0
  const engine = runtime.host.identity.engine
  const currentInputTokens = () => engine === "local" ? localContextInputTokens(loadConfig(runtime.worktree)) : engine === "claude" || engine === "codex" ? 49152 : 8192

  function contextState(): ConversationContextState {
    return { messages: history.map(message => ({ ...message })), pinnedNote }
  }

  return {
    contextState,
    contextReport(): ConversationContextReport {
      const inputTokens = currentInputTokens()
      const prompt = mainPromptFor(runtime)
      const prefix = promptPrefix(prompt, runtime.config.delegate.verify_allow, undefined, turnFacts(runtime, prompt), pinnedNote)
      return { inputTokens, conversationTokens: Math.max(512, inputTokens - 3072),
        usedTokens: estimateTokens(`${prefix}${JSON.stringify(history)}`), pairs: history.length / 2, pinnedNote, droppedPairs }
    },
    replaceContext(state: ConversationContextState): void {
      if (busy) throw new Error("conversation already has an active turn")
      if (!state || !Array.isArray(state.messages) || state.messages.length > 48 ||
          typeof state.pinnedNote !== "string" || state.pinnedNote.length > 2000 || JSON.stringify(state.messages).length > 196608) {
        throw new TypeError("invalid conversation context: at most 48 messages, 196608 JSON characters and a 2000-character pinned note")
      }
      const messages = validatePriorMessages(state.messages)
      droppedPairs += Math.max(0, (history.length - messages.length) / 2)
      history.splice(0, history.length, ...messages)
      pinnedNote = state.pinnedNote
    },
    /**
     * `skill` binds an explicit `/skill:` invocation. `skillTool` lets the model load listed consent-free skills on its
     * own during the turn; it is ignored when an explicit skill is bound.
     */
    async turn(text: string, signal?: AbortSignal, skill?: SkillConversationInvocation, skillTool?: SkillToolProvider, actionGate?: ActionGate): Promise<ConversationTurn> {
      const inputTokens = currentInputTokens()
      const trimTargetPercent = engine === "local" ? localContextTrimTargetPercent(loadConfig(runtime.worktree)) : 70
      const limit = planConversationChars(engine, inputTokens)
      const tokenLimit = engine === "local" ? Math.max(512, inputTokens - 3072) : undefined
      if (typeof text !== "string" || !text.trim()) throw new TypeError("conversation message is empty or invalid")
      if (text.length > limit) throw new ModelRequestError("input_budget", "conversation message is too large")
      if (busy) throw new Error("conversation already has an active turn")
      if (signal?.aborted) throw new Error("conversation cancelled")
      const pending = { role: "user" as const, text }
      const mainPrompt = mainPromptFor(runtime)
      // Read-only mode never carries a gate, whatever the caller passes.
      const gate = mainPrompt === PLAN_CHAT_PROMPT ? actionGate : undefined
      const facts = turnFacts(runtime, mainPrompt)
      let window = selectWindow(history, pending, promptPrefix(mainPrompt, runtime.config.delegate.verify_allow, undefined, facts, pinnedNote), limit, tokenLimit, trimTargetPercent)
      if (!window) throw new ModelRequestError("input_budget", "conversation message is too large for the reserved context budget")
      const workflow = activeWorkflow(runtime.worktree, sessionID)
      if (workflow?.sessionID === sessionID) {
        const refusal = workflowEngineRefusal(workflow, runtime.host.identity.engine)
        if (refusal || workflow.phase !== "planning") {
          throw new Error("another workflow or approval must be resolved before continuing the conversation")
        }
      }
      busy = true
      const cancelPrefetch = () => cancelMemoryPrefetch(sessionID)
      signal?.addEventListener("abort", cancelPrefetch, { once: true })
      // Opt-in: recall of this user message overlaps the main model's first step; the turn's first memory call takes it.
      if (!skill) startMemoryPrefetch(runtime.worktree, sessionID, text, currentMemoryConfig(runtime.worktree))
      else cancelMemoryPrefetch(sessionID)
      try {
        const title = "Otter planning conversation"
        const owned = workflow?.sessionID === sessionID ? workflow : null
        let store: ReturnType<typeof getOwnedSession>
        try { store = getOwnedSession(runtime.worktree, sessionID) } catch { store = undefined }
        const binding: TurnBinding = {
          workflowID: owned?.id ?? null, revision: owned?.lastSeq ?? null, kind: "plan", stage: owned?.stage ?? "draft", role: "main",
          prompt: mainPrompt, supervisorSessionID: sessionID, epoch: store?.epoch ?? null, ownerInstance: owned?.owner.instance ?? null,
        }
        let audit: Readonly<Record<string, string>> | undefined
        const result = await runWorkflowTurn(runtime, binding, {
          title, text: window.requestText, label: "planning", cancelCause: "planning conversation cancelled",
          budget: { maxChars: limit, reserveChars: PLAN_RESPONSE_RESERVE_CHARS },
          bind(request) {
            const bound = skill ? bindSkillInvocation(skill.prepared, request, runtime.policy, skill.terminal) : undefined
            if (!bound) return { handlers: runtime.policy.handlers(request), ...(skillTool && skillTool.catalog.length ? { skillTool } : {}), ...(gate ? { actionGate: gate } : {}) }
            window = selectWindow(history, pending, promptPrefix(mainPrompt, runtime.config.delegate.verify_allow, bound.instructions, facts, pinnedNote), limit, tokenLimit, trimTargetPercent)
            if (!window) { finishSkillInvocation(bound.context); throw new ModelRequestError("input_budget", "skill instructions exceed the reserved conversation context budget") }
            audit = skillInvocationAudit(bound.context)
            return { handlers: bound.handlers, skillContext: bound.context, text: window.requestText, ...(gate ? { actionGate: gate } : {}) }
          },
        }, signal)
        if (result.status === "diagnostic") throw new Error(`planning conversation superseded: ${result.reason}`)
        if (result.status === "stuck") throw new ModelRequestError("input_budget", result.reason)
        if (!result.text.trim()) throw new ModelRequestError("empty_response", "planning conversation model returned only whitespace")
        const next: ConversationMessage[] = [...window.messages, { role: "assistant", text: result.text }]
        // JSON escaping can make a completed response larger than its raw character reserve.
        // Keep checkpointable whole pairs; the full result remains in the returned turn/transcript.
        if (engine === "local") {
          while (next.length > 48 || JSON.stringify(next).length > 196608) next.splice(0, 2)
        }
        droppedPairs += Math.max(0, (history.length + 2 - next.length) / 2)
        history.splice(0, history.length, ...next)
        const plan = extractPlan(result.text)
        return { text: result.text, ...(plan === undefined ? {} : { plan }), ...(audit ? { skill: audit } : {}) }
      } finally {
        signal?.removeEventListener("abort", cancelPrefetch)
        cancelPrefetch()
        busy = false
      }
    },
  }
}
