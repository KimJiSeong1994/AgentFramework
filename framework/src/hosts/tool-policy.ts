import { AGENT_DEFS, DATA_ANALYST_PROMPT, DATA_VERIFIER_PROMPT, REVIEWER_PROMPT, WORKER_PROMPT, mainPrompt } from "../agents/prompts.ts"
import { createHash } from "node:crypto"
import { parseModelSelection, type LcaConfig } from "../config.ts"
import { RepeatGuard, errorExcerpt, repeatBlockMessage } from "../guards/repeat.ts"
import { RepetitionDetector } from "../guards/repetition.ts"
import { trimToolOutput } from "../guards/trim.ts"
import { appendHint, recoveryHint } from "../guards/recover.ts"
import { readModeState, writeModeState } from "../state/store.ts"
import type { ExecutionPolicy, ExecutionPolicyHandlers, ExecutionPolicySnapshot, ExecutionRequest, ExecutionRole } from "./types.ts"

export const PATH_TOOLS: ReadonlySet<string> = new Set(["glob", "grep", "list", "read", "bash"])

export function relativizePaths(text: string, roots: string[]): string {
  let out = text
  const uniq = Array.from(new Set(roots.filter(Boolean).map((r) => r.replace(/\/+$/, "")))).sort((a, b) => b.length - a.length)
  for (const root of uniq) out = out.split(root + "/").join("")
  return out
}

export const ERROR_OUTPUT = /^\s*(Error\b|error:|✗|Failed\b)/
export function isErrorOutput(output: string): boolean { return ERROR_OUTPUT.test(output ?? "") }

const KNOWN_TOOLS = ["read", "glob", "grep", "list", "bash", "write", "edit", "patch", "apply_patch", "multiedit", "webfetch", "skill", "todowrite", "todoread", "delegate", "lca_flow", "db_query", "schema_lookup", "task"]
const REVIEW_TOOLS = ["read", "glob", "grep", "list"]
const SYSTEM: Record<ExecutionRole, string> = {
  main: "", worker: WORKER_PROMPT, reviewer: REVIEWER_PROMPT,
  "data-analyst": DATA_ANALYST_PROMPT, "data-verifier": DATA_VERIFIER_PROMPT,
  "ontology-evolver": AGENT_DEFS["ontology-evolver"].prompt!, "answer-judge": AGENT_DEFS["answer-judge"].prompt!,
}

export type ExecutionPolicyOptions = { directory?: string; worktree?: string }

export function createExecutionPolicy(config: Readonly<LcaConfig>, options: ExecutionPolicyOptions = {}): ExecutionPolicy {
  const snapshots = new Map<ExecutionRole, ExecutionPolicySnapshot>()
  const sessions = new Map<string, ExecutionPolicyHandlers>()
  const sessionSnapshots = new Map<string, ExecutionPolicySnapshot>()
  for (const role of Object.keys(SYSTEM) as ExecutionRole[]) {
    const agent = AGENT_DEFS[role]
    const denied = new Set(agent.denied_tools)
    const allowed = (role === "reviewer" ? REVIEW_TOOLS : KNOWN_TOOLS.filter((tool) => !denied.has(tool)))
    const model = config.models[role] ? parseModelSelection(config.models[role]!) : undefined
    const resolved: Omit<ExecutionPolicySnapshot, "id"> = {
      role, ...(model ? { model: Object.freeze(model) } : {}),
      maxOutputTokens: config.max_output[role] ?? config.max_output.worker,
      tools: Object.freeze({ allowed: Object.freeze([...allowed]), denied: Object.freeze([...new Set([...denied, ...(role === "reviewer" ? KNOWN_TOOLS.filter((t) => !REVIEW_TOOLS.includes(t)) : [])])]) }),
      system: Object.freeze([role === "main" ? mainPrompt(!config.disabled_hooks.includes("tool.delegate"), config.data.backend !== "none" && !config.disabled_hooks.includes("tool.data"), config.flow.enabled && !config.disabled_hooks.includes("flow")) : SYSTEM[role]]),
      thinking: role !== "main" && model && /ollama|:11434/i.test(model.providerID) ? "disabled" : "inherit",
    }
    const id = `lca:${role}:${createHash("sha256").update(JSON.stringify({ resolved, config })).digest("hex")}`
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
            return { allow: false, reason: "lca: reviewer tool-call cap reached; give your verdict now" }
          }
          const key = callKey(event.sessionID, event.callID)
          callInputs.delete(key)
          callInputs.set(key, event.input)
          while (callInputs.size > 1000) callInputs.delete(callInputs.keys().next().value!)
          if (request.role === "reviewer" && !REVIEW_TOOLS.includes(event.name)) return { allow: false, reason: `lca: reviewer tool ${event.name} is not read-only` }
          if ((request.role === "worker" || request.role === "reviewer") && !policy.tools.allowed.includes(event.name)) return { allow: false, reason: `lca: tool ${event.name} is not allowed for ${request.role}` }
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
