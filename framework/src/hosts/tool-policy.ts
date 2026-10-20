import { AGENT_DEFS, DATA_ANALYST_PROMPT, DATA_VERIFIER_PROMPT, REVIEWER_PROMPT, WORKER_PROMPT, mainPrompt } from "../agents/prompts.ts"
import { createHash } from "node:crypto"
import { parseModelSelection, type OtterConfig, type ModelSelection } from "../config.ts"
import { RepeatGuard, errorExcerpt, repeatBlockMessage } from "../guards/repeat.ts"
import { RepetitionDetector } from "../guards/repetition.ts"
import { trimToolOutput } from "../guards/trim.ts"
import { appendHint, recoveryHint } from "../guards/recover.ts"
import { readModeState, writeModeState } from "../state/store.ts"
import { EXECUTION_ROLES, EXECUTION_TOOL_NAMES, isWorkflowReadOnlyRole, type ExecutionPolicy, type ExecutionPolicyHandlers, type ExecutionPolicySnapshot, type ExecutionRequest, type ExecutionRole } from "./types.ts"

export const PATH_TOOLS: ReadonlySet<string> = new Set(["glob", "grep", "list", "read", "bash"])

export function relativizePaths(text: string, roots: string[]): string {
  let out = text
  const uniq = Array.from(new Set(roots.filter(Boolean).map((r) => r.replace(/\/+$/, "")))).sort((a, b) => b.length - a.length)
  for (const root of uniq) out = out.split(root + "/").join("")
  return out
}

export const ERROR_OUTPUT = /^\s*(Error\b|error:|✗|Failed\b)/
export function isErrorOutput(output: string): boolean { return ERROR_OUTPUT.test(output ?? "") }

const KNOWN_TOOLS: readonly string[] = EXECUTION_TOOL_NAMES
const REVIEW_TOOLS = ["read", "glob", "grep", "list"]
const PLANNING_MAIN_TOOLS: readonly string[] = Object.freeze(["read", "list", "glob", "grep", "memory"])
/** `chat.execute` ask/auto-edit: the chat model may also write, edit and run commands, each approved by the host. */
const CHAT_EXECUTE_TOOLS: readonly string[] = Object.freeze([...PLANNING_MAIN_TOOLS, "write", "edit", "bash"])
const PLANNING_MAIN_PROMPT = "You are the planning role of the common Otter terminal. Discuss the request, inspect files with read-only tools, and create a concrete plan when asked. Never modify files, run commands, execute or approve plans, or delegate work. Do not imply work was executed."
const CHAT_EXECUTE_PROMPT = "You are the coding agent of the common Otter terminal. Inspect files with read-only tools; change files with write/edit and run commands with bash. Every write, edit and command is shown to the local human, who approves or denies it before it happens. Never approve plans or delegate work, and never claim an effect its tool result does not show."
const SYSTEM: Record<ExecutionRole, string> = {
  main: "", worker: WORKER_PROMPT, reviewer: REVIEWER_PROMPT,
  "data-analyst": DATA_ANALYST_PROMPT, "data-verifier": DATA_VERIFIER_PROMPT,
  "ontology-evolver": AGENT_DEFS["ontology-evolver"].prompt!, "answer-judge": AGENT_DEFS["answer-judge"].prompt!,
  interviewer: "You are Otter's interviewer. Clarify requirements, constraints, ambiguities, and acceptance criteria. Inspect only with read, list, glob, and grep. Never modify files, execute commands, approve work, or delegate.",
  planner: "You are Otter's planner. Produce a concrete, dependency-aware plan with verifiable acceptance criteria. Inspect only with read, list, glob, and grep. Never modify files, execute commands, approve work, or delegate.",
  architect: "You are Otter's architect. Assess architecture, invariants, integration risks, and maintainability against evidence. Inspect only with read, list, glob, and grep. Never modify files, execute commands, approve work, or delegate.",
  critic: "You are Otter's critic. Evaluate the supplied proposal against its requirements and identify concrete blockers or a justified verdict. Inspect only with read, list, glob, and grep. Never modify files, execute commands, approve work, or delegate.",
  researcher: "You are Otter's researcher. Gather evidence and distinguish observations, hypotheses, and limitations. Inspect only with read, list, glob, and grep. Never modify files, execute commands, approve work, or delegate.",
  contrarian: "You are Otter's contrarian. Challenge assumptions and develop evidence-backed counterarguments and failure cases. Inspect only with read, list, glob, and grep. Never modify files, execute commands, approve work, or delegate.",
  simplifier: "You are Otter's simplifier. Identify the smallest complete solution and remove unnecessary proposed complexity without weakening requirements. Inspect only with read, list, glob, and grep. Never modify files, execute commands, approve work, or delegate.",
}

export type ExecutionPolicyOptions = {
  directory?: string
  worktree?: string
  planningOnlyMain?: boolean
  /** With planningOnlyMain: the chat model may also write, edit and run commands (each approved through an ActionGate). */
  chatExecuteMain?: boolean
  nativeContext?: Readonly<{ identity: string; instructions: string }>
  /** Per-role model (and Codex native context) overriding the runtime-wide selection; roles absent here are computed exactly as without routes. */
  routes?: Readonly<Partial<Record<ExecutionRole, Readonly<{ model: ModelSelection; nativeContext?: Readonly<{ identity: string; instructions: string }> }>>>>
}

function freezeNativeContext(supplied: unknown): Readonly<{ identity: string; instructions: string }> {
  const value = supplied as { identity?: unknown; instructions?: unknown } | null
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.identity !== "string" || !value.identity.trim() ||
      typeof value.instructions !== "string" || !value.instructions.trim()) {
    throw new TypeError("invalid native execution context")
  }
  return Object.freeze({ identity: value.identity, instructions: value.instructions })
}

export function createExecutionPolicy(config: Readonly<OtterConfig>, options: ExecutionPolicyOptions = {}): ExecutionPolicy {
  const planningOnlyMain = options.planningOnlyMain === true
  const chatExecuteMain = planningOnlyMain && options.chatExecuteMain === true
  const mainTools = chatExecuteMain ? CHAT_EXECUTE_TOOLS : PLANNING_MAIN_TOOLS
  const nativeContext = options.nativeContext === undefined ? undefined : freezeNativeContext(options.nativeContext)
  // `chat` (launch model), `skill_trust` (user-config consent prompt skip), `skill_auto` (user-config per-turn skill
  // selection, which only chooses an already consent-free skill) and `memory` (recall engine, re-read per `memory` call
  // and switched live by /memory) never shape a role's prompt, tools or limits, so they stay out of role identity.
  const { chat: _chat, skill_trust: _trust, skill_auto: _auto, memory: _memory, ...identityConfig } = config as typeof config & { skill_trust?: unknown; skill_auto?: unknown }
  const snapshots = new Map<ExecutionRole, ExecutionPolicySnapshot>()
  const sessions = new Map<string, ExecutionPolicyHandlers>()
  const sessionSnapshots = new Map<string, ExecutionPolicySnapshot>()
  for (const role of EXECUTION_ROLES) {
    const workflowReadOnly = isWorkflowReadOnlyRole(role)
    const agent = isWorkflowReadOnlyRole(role) ? undefined : AGENT_DEFS[role]
    const denied = new Set(agent?.denied_tools ?? [])
    const planningMain = role === "main" && planningOnlyMain
    const roleTools = planningMain ? mainTools : PLANNING_MAIN_TOOLS
    if (planningMain || workflowReadOnly) {
      for (const tool of KNOWN_TOOLS) if (!roleTools.includes(tool)) denied.add(tool)
    }
    const allowed = planningMain || workflowReadOnly
      ? [...roleTools]
      : role === "reviewer" ? REVIEW_TOOLS : KNOWN_TOOLS.filter((tool) => !denied.has(tool))
    const modelSpec = workflowReadOnly ? config.models.main ?? config.models.worker : config.models[role]
    const route = options.routes?.[role]
    const model = route ? { providerID: route.model.providerID, modelID: route.model.modelID } : modelSpec ? parseModelSelection(modelSpec) : undefined
    const roleNativeContext = route ? (route.nativeContext === undefined ? undefined : freezeNativeContext(route.nativeContext)) : nativeContext
    const system = role !== "main"
      ? SYSTEM[role]
      : planningMain
        ? chatExecuteMain ? CHAT_EXECUTE_PROMPT : PLANNING_MAIN_PROMPT
        : mainPrompt(!config.disabled_hooks.includes("tool.delegate"), config.data.backend !== "none" && !config.disabled_hooks.includes("tool.data"), config.flow.enabled && !config.disabled_hooks.includes("flow"))
    const resolved: Omit<ExecutionPolicySnapshot, "id"> = {
      role, ...(model ? { model: Object.freeze(model) } : {}),
      maxOutputTokens: isWorkflowReadOnlyRole(role) ? config.max_output.worker : config.max_output[role] ?? config.max_output.worker,
      tools: Object.freeze({ allowed: Object.freeze([...allowed]), denied: Object.freeze([...new Set([...denied, ...(role === "reviewer" ? KNOWN_TOOLS.filter((t) => !REVIEW_TOOLS.includes(t)) : [])])]) }),
      system: Object.freeze([system]),
      ...(roleNativeContext ? { nativeContext: roleNativeContext } : {}),
      thinking: role !== "main" && model && /ollama|:11434/i.test(model.providerID) ? "disabled" : "inherit",
    }
    const id = `otter:${role}:${createHash("sha256").update(JSON.stringify({ resolved, config: identityConfig })).digest("hex")}`
    snapshots.set(role, Object.freeze({ id, ...resolved }))
  }
  const repeat = new RepeatGuard(config.guards.repeat_limit)
  const repetition = new RepetitionDetector(config.guards.repetition_ngram, config.guards.repetition_count)
  const callInputs = new Map<string, unknown>()
  const callKey = (sessionID: string, callID: string) => `${sessionID}\0${callID}`
  return {
    resolve(role) {
      const snapshot = snapshots.get(role)
      if (!snapshot) throw new Error(`Unsupported execution role: ${role}`)
      return snapshot
    },
    handlers(request: Omit<ExecutionRequest, "handlers">): ExecutionPolicyHandlers {
      const policy = snapshots.get(request.role)
      if (!policy || policy !== request.policy) throw new Error("Execution request policy is not the fixed role snapshot")
      let reviewerCalls = 0
      return {
        beforeTool(event) {
          if (request.role === "reviewer" && ++reviewerCalls > config.flow.review_max_tool_calls) {
            return { allow: false, reason: "otter: reviewer tool-call cap reached; give your verdict now" }
          }
          const key = callKey(event.sessionID, event.callID)
          callInputs.delete(key)
          callInputs.set(key, event.input)
          while (callInputs.size > 1000) callInputs.delete(callInputs.keys().next().value!)
          if (request.role === "reviewer" && !REVIEW_TOOLS.includes(event.name)) return { allow: false, reason: `otter: reviewer tool ${event.name} is not read-only` }
          // The chat's multiedit (several edits approved together) is decided as `edit`; elsewhere multiedit is its own tool.
          const policyName = planningOnlyMain && request.role === "main" && event.name === "multiedit" ? "edit" : event.name
          if (planningOnlyMain && request.role === "main" && !policy.tools.allowed.includes(policyName)) return { allow: false, reason: `otter: tool ${event.name} is not allowed for planning-only main` }
          if (!policy.tools.allowed.includes(policyName) || policy.tools.denied.includes(policyName)) return { allow: false, reason: `otter: tool ${event.name} is not allowed for ${request.role}` }
          if (!config.disabled_hooks.includes("guard.repeat")) {
            const check = repeat.check(event.sessionID, event.name, event.input, event.callID)
            if (check.blocked) return { allow: false, reason: repeatBlockMessage(event.name, check.count, check.lastError) }
          }
          return { allow: true }
        },
        toolResult(event) {
          const returned = typeof event.result === "string" ? event.result : ""
          const errorText = typeof event.error === "string" ? event.error : event.error == null ? undefined : String(event.error)
          const ok = event.error == null && !isErrorOutput(returned)
          const args = callInputs.get(callKey(event.sessionID, event.callID))
          callInputs.delete(callKey(event.sessionID, event.callID))
          if (!config.disabled_hooks.includes("guard.repeat")) repeat.recordResult(event.sessionID, event.callID, ok, ok ? undefined : errorExcerpt(errorText ?? returned))
          if (ok && options.worktree) {
            const state = readModeState(options.worktree, event.sessionID)
            if (state.active && state.failures > 0) writeModeState(options.worktree, event.sessionID, { ...state, failures: 0 })
          }
          let text = errorText ?? returned
          let trimmed = false
          let hinted = false
          if (!config.disabled_hooks.includes("guard.trim")) {
            if (config.guards.relativize_paths && PATH_TOOLS.has(event.name)) text = relativizePaths(text, [options.directory ?? "", options.worktree ?? "", request.cwd])
            const trimmedResult = trimToolOutput(event.name, text, config.guards)
            text = trimmedResult.output
            trimmed = trimmedResult.trimmed
          }
          if (!ok && !config.disabled_hooks.includes("guard.recover")) {
            const hint = recoveryHint(event.name, args, errorText ?? returned)
            if (hint) {
              text = appendHint(text, hint)
              hinted = true
            }
          }
          if (errorText !== undefined) return { error: text, trimmed, hinted }
          return { result: typeof event.result === "string" ? text : event.result, trimmed, hinted }
        },
        assistantText(event) {
          if (config.disabled_hooks.includes("guard.repetition")) return { cancel: false }
          const detected = repetition.feed(event.sessionID, event.partID, event.text)
          return { cancel: detected.repeating && config.guards.abort_on_repetition }
        },
      }
    },
    bindSession(sessionID, handlers, snapshot) {
      if (snapshots.get(snapshot.role) !== snapshot || !Object.isFrozen(snapshot)) {
        throw new Error(`Vendor session ${sessionID} requires the fixed frozen snapshot returned by resolve`)
      }
      const existing = sessions.get(sessionID)
      const existingSnapshot = sessionSnapshots.get(sessionID)
      if (existing && (existing !== handlers || existingSnapshot !== snapshot)) throw new Error(`Vendor session ${sessionID} is already bound to different policy handlers or snapshot`)
      sessions.set(sessionID, handlers)
      sessionSnapshots.set(sessionID, snapshot)
    },
    unbindSession(sessionID) {
      sessions.delete(sessionID)
      sessionSnapshots.delete(sessionID)
    },
    handlersForSession(sessionID) { return sessions.get(sessionID) },
    snapshotForSession(sessionID) { return sessionSnapshots.get(sessionID) },
  }
}
