import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { Terminal } from "../hosts/interactive-session.ts"
import type { ExecutionDecision, ExecutionEvent, ExecutionPolicy, ExecutionPolicyHandlers, ExecutionRequest } from "../hosts/types.ts"
import { EXECUTION_ROLES, EXECUTION_TOOL_NAMES } from "../hosts/types.ts"
import {
  consumeSkillPermissionPermit, createSkillHoldTicket, foregroundSkillInvocationID,
  registerForegroundSkillInvocation, revokeForegroundSkillInvocation, skillArgumentDigest,
  type ForegroundSkillInvocation, type SkillPermissionPermit,
} from "./broker.ts"
import { claimPreparedSkillInvocation, SkillAdmissionError, type PreparedSkillInvocation } from "./session.ts"
import { skillDirectoryPath } from "./roots.ts"
import { readCapturedSkillResource } from "./resources.ts"
import type { SkillCapture, SkillToolName } from "./types.ts"

type Scope = Omit<ExecutionRequest, "handlers" | "skillContext">
type ToolBefore = Extract<ExecutionEvent, { type: "tool-before" }>
declare const skillContextBrand: unique symbol
export type SkillInvocationContext = Readonly<{
  supervisorSessionID: string
  attachmentEpoch: string
  canonicalSource: string
  name: string
  contentHash: string
  allowedTools: readonly SkillToolName[]
  invocationID: string
  capture: SkillCapture
  [skillContextBrand]: never
}>

type Source = ReturnType<typeof claimPreparedSkillInvocation>
type CallState = {
  event: ToolBefore
  callID: string
  tool: string
  digest: string
  validate: () => boolean
  observed: boolean
  baseAllowed: boolean
  effectReady: boolean
  consumed: boolean
  snapshotRead: boolean
}
type ContextState = {
  active: boolean
  source: Source
  context: SkillInvocationContext
  scope: Readonly<Scope>
  policy: ExecutionPolicy
  foreground?: ForegroundSkillInvocation
  cancel: AbortController
  unregister: () => void
  calls: Map<string, CallState>
  seenCalls: Set<string>
  beforeTool: ExecutionPolicyHandlers["beforeTool"]
}
const contexts = new WeakMap<object, ContextState>()
const boundaries = new WeakMap<ExecutionPolicyHandlers["beforeTool"], ContextState>()

function refuse(message: string): never { throw new SkillAdmissionError(message) }
function current(state: ContextState): boolean {
  return state.active && !state.cancel.signal.aborted && Date.now() < state.scope.deadlineAt &&
    state.source.session.authorizes(state.source.capture, state.source.lease, state.source.revision) &&
    state.policy.resolve(state.scope.role) === state.scope.policy
}
function scopeMatches(state: ContextState, request: Scope): boolean {
  const scope = state.scope
  return request.supervisorSessionID === scope.supervisorSessionID && request.executionID === scope.executionID &&
    request.taskID === scope.taskID && request.attemptID === scope.attemptID && request.generation === scope.generation &&
    request.cwd === scope.cwd && request.role === scope.role && request.policy === scope.policy && request.deadlineAt === scope.deadlineAt
}
function callMatches(state: ContextState, call: CallState, event = call.event): boolean {
  const tupleMatches = () => current(state) && !call.consumed && event.type === "tool-before" && event.sessionID === state.scope.executionID &&
    event.callID === call.callID && event.name === call.tool && skillArgumentDigest(event.input) === call.digest &&
    state.scope.policy.tools.allowed.includes(event.name) && !state.scope.policy.tools.denied.includes(event.name)
  return tupleMatches() && call.validate() === true && tupleMatches()
}
function callFor(state: ContextState, event: ToolBefore): CallState {
  const call = state.calls.get(event.callID)
  if (!call || !callMatches(state, call, event)) return refuse("Skill tool call has no current exact-call proof.")
  return call
}

/** Called only by an execution builder, never by parsing model text or persisted audit fields. */
export function bindSkillInvocation(
  prepared: PreparedSkillInvocation,
  request: Scope,
  policy: ExecutionPolicy,
  terminal?: Pick<Terminal, "stdinIsTTY" | "stderrIsTTY" | "choose" | "resume">,
): Readonly<{ context: SkillInvocationContext; handlers: ExecutionPolicyHandlers; instructions: string }> {
  if ("skillContext" in request || !(EXECUTION_ROLES as readonly string[]).includes(request.role) || policy.resolve(request.role) !== request.policy ||
      !Number.isSafeInteger(request.generation) || request.generation < 1 ||
      !Number.isSafeInteger(request.deadlineAt) || request.deadlineAt <= Date.now()) {
    return refuse("Skill execution requires one fixed code-owned request.")
  }
  const source = claimPreparedSkillInvocation(prepared)
  if (request.supervisorSessionID !== source.session.store.sessionID) return refuse("Skill invocation cannot cross supervisor sessions.")
  if (source.capture.descriptor.kind !== "skill") return refuse("Protected workflows cannot become ordinary skill execution contexts.")
  const declared = source.capture.descriptor.kind === "skill" ? source.capture.descriptor.allowedTools : undefined
  const allowedTools = EXECUTION_TOOL_NAMES.filter(tool => request.policy.tools.allowed.includes(tool) &&
    !request.policy.tools.denied.includes(tool) && (declared === undefined || declared.includes(tool)))
  const cancel = new AbortController()
  const unregister = source.session.registerInvocationCancellation(source.capture.name, source.revision, cancel)
  let foreground: ForegroundSkillInvocation | undefined
  try {
    foreground = terminal ? registerForegroundSkillInvocation({
      worktree: source.session.roots.projectRoot, store: source.session.store, request, policy,
      terminal: {
        stdinIsTTY: terminal.stdinIsTTY,
        stderrIsTTY: terminal.stderrIsTTY,
        ...(terminal.choose ? { choose: async (title, choices, signal) => {
          try { return await terminal.choose!(title, choices, signal) }
          finally { terminal.resume?.() }
        } } : {}),
      },
    }) : undefined
    const context = Object.freeze({
      supervisorSessionID: source.session.store.sessionID,
      attachmentEpoch: source.session.store.epoch,
      canonicalSource: skillDirectoryPath(source.session.roots, source.capture.descriptor),
      name: source.capture.name,
      contentHash: source.capture.contentHash,
      allowedTools: Object.freeze(allowedTools),
      invocationID: foregroundSkillInvocationID(foreground) ?? randomUUID(),
      capture: source.capture,
    }) as SkillInvocationContext
    const scope = Object.freeze({ ...request })
    const base = policy.handlers(scope)
    const state: ContextState = {
      active: true, source, context, scope, policy, foreground, cancel, unregister,
      calls: new Map(), seenCalls: new Set(), beforeTool,
    }
    function beforeTool(event: ToolBefore): ExecutionDecision {
      try {
        const call = callFor(state, event)
        if (call.observed) return { allow: false, reason: "Skill tool observation cannot be replayed." }
        call.observed = true
        const decision = base.beforeTool(event)
        if (!decision.allow) return { allow: false, reason: decision.reason }
        call.baseAllowed = true
        if (context.allowedTools.includes(event.name as SkillToolName)) return { allow: true }
        const ticket = foreground ? createSkillHoldTicket({
          invocation: foreground, event, skillHash: context.contentHash,
          view: { name: context.name, classification: source.capture.classification, allowedTools: context.allowedTools },
          revalidation: {
            canIssueTicket: () => call.baseAllowed && callMatches(state, call),
            beforeChoice: signal => refreshCall(state, call, signal),
            afterChoice: signal => refreshCall(state, call, signal),
            beforeConsume: () => call.effectReady && call.baseAllowed && callMatches(state, call),
          },
        }) : undefined
        return { allow: false, reason: "Tool is outside this skill's declared scope.", ...(ticket ? { holdTicket: ticket } : {}) }
      } catch { return { allow: false, reason: "Skill tool authorization failed closed." } }
    }
    const handlers: ExecutionPolicyHandlers = Object.freeze({
      beforeTool,
      toolResult(event) {
        const call = state.calls.get(event.callID)
        if (!current(state) || !call?.consumed || event.sessionID !== scope.executionID || event.name !== call.tool) {
          return refuse("Skill tool result does not belong to a consumed current call.")
        }
        state.calls.delete(event.callID)
        return base.toolResult(event)
      },
      assistantText(event) {
        if (!current(state)) return { cancel: true }
        return base.assistantText(event)
      },
    })
    contexts.set(context, state)
    boundaries.set(beforeTool, state)
    return Object.freeze({ context, handlers, instructions: source.text })
  } catch (error) {
    unregister()
    cancel.abort()
    revokeForegroundSkillInvocation(foreground)
    throw error
  }
}

function stateFor(request: ExecutionRequest): ContextState | undefined {
  if (request.skillContext === undefined) {
    if (boundaries.has(request.handlers.beforeTool)) return refuse("Skill-bound handlers require their authentic invocation context.")
    return undefined
  }
  const value: unknown = request.skillContext
  const state = value && typeof value === "object" ? contexts.get(value) : undefined
  if (!state || !current(state) || !scopeMatches(state, request) || boundaries.get(request.handlers.beforeTool) !== state) {
    return refuse("Skill execution context is missing, copied, expired, or bound to another request.")
  }
  return state
}

/** No-op only for an ordinary execution with no skill context; malformed context always refuses. */
export function assertSkillExecution(request: ExecutionRequest): void { stateFor(request) }

async function refreshCall(state: ContextState, call: CallState, signal: AbortSignal): Promise<boolean> {
  call.effectReady = false
  if (signal.aborted || !callMatches(state, call)) return false
  await state.source.session.recapture(state.source.capture, state.source.lease, state.source.revision, signal)
  return !signal.aborted && callMatches(state, call)
}

/** Async capture precedes the synchronous policy observation, and supplies no effects or reusable grant. */
export async function prepareSkillToolCall(
  request: ExecutionRequest,
  event: ToolBefore,
  signal: AbortSignal,
  validate: () => boolean,
): Promise<void> {
  const state = stateFor(request)
  if (!state) return
  if (state.seenCalls.has(event.callID) || event.sessionID !== request.executionID || typeof event.callID !== "string" || !event.callID ||
      !(EXECUTION_TOOL_NAMES as readonly string[]).includes(event.name) ||
      !request.policy.tools.allowed.includes(event.name) || request.policy.tools.denied.includes(event.name)) {
    return refuse("Skill tool call identity or base role is not admissible.")
  }
  const digest = skillArgumentDigest(event.input)
  if (!digest || typeof validate !== "function") return refuse("Skill tool arguments cannot be bound safely.")
  const call: CallState = { event, callID: event.callID, tool: event.name, digest, validate, observed: false, baseAllowed: false, effectReady: false, consumed: false, snapshotRead: false }
  state.seenCalls.add(event.callID)
  state.calls.set(event.callID, call)
  if (!(await refreshCall(state, call, signal))) return refuse("Skill source or tool path is no longer admissible.")
  stateFor(request)
}

/** Last async boundary: recheck the actual source and path before consuming any allow-once permit. */
export async function revalidateSkillToolEffect(request: ExecutionRequest, event: ToolBefore, signal: AbortSignal): Promise<void> {
  const state = stateFor(request)
  if (!state) return
  const call = callFor(state, event)
  if (!call.observed || !call.baseAllowed || !(await refreshCall(state, call, signal))) return refuse("Skill effect has no current source proof.")
  stateFor(request)
  call.effectReady = true
}

/** Consume exactly once immediately before effects; re-observation never increments base policy counters. */
export function consumeSkillToolEffect(request: ExecutionRequest, event: ToolBefore, permit?: SkillPermissionPermit): void {
  const state = stateFor(request)
  if (!state) {
    if (permit !== undefined) return refuse("An ordinary execution cannot consume a skill permission permit.")
    return
  }
  const call = callFor(state, event)
  if (!call.observed || !call.baseAllowed || !call.effectReady) return refuse("Skill effect proof is absent or stale.")
  if (!state.context.allowedTools.includes(event.name as SkillToolName)) {
    if (!state.foreground || !consumeSkillPermissionPermit(permit, {
      invocation: state.foreground, request, event, skillHash: state.context.contentHash,
    })) return refuse("Skill allow-once permission was denied, expired, or already consumed.")
  } else if (permit !== undefined) return refuse("Skill permit does not match an out-of-scope call.")
  if (!callMatches(state, call, event)) return refuse("Skill effect context changed at final admission.")
  call.consumed = true
  call.effectReady = false
}

/** Source references use captured bytes only after the ordinary path/role/call admission. */
export function readSkillToolSnapshot(request: ExecutionRequest, event: ToolBefore): Uint8Array | undefined {
  const state = stateFor(request)
  if (!state || event.name !== "read") return undefined
  const call = state.calls.get(event.callID)
  if (!call?.consumed || call.snapshotRead || event.sessionID !== state.scope.executionID ||
      call.tool !== event.name || skillArgumentDigest(event.input) !== call.digest) {
    return refuse("Skill snapshot read has no consumed exact-call proof.")
  }
  const input = event.input as Record<string, unknown>
  if (typeof input.path !== "string") return refuse("Skill snapshot path is invalid.")
  const resource = readCapturedSkillResource(state.source.session.roots, state.source.capture, resolve(request.cwd, input.path.replaceAll("\\", "/")))
  if (!resource) return undefined
  if (resource.kind !== "file") return refuse("Skill read requires a captured regular file.")
  call.snapshotRead = true
  return resource.bytes
}

export function skillExecutionSignal(request: ExecutionRequest, signal: AbortSignal): AbortSignal {
  const state = stateFor(request)
  return state ? AbortSignal.any([signal, state.cancel.signal]) : signal
}

export function finishSkillInvocation(context: SkillInvocationContext | undefined): void {
  if (context === undefined) return
  const state = contexts.get(context)
  if (!state || !state.active) return
  state.active = false
  state.cancel.abort()
  state.unregister()
  state.calls.clear()
  state.seenCalls.clear()
  revokeForegroundSkillInvocation(state.foreground)
}

/** Audit data is deliberately insufficient to recreate a context or a grant. */
export function skillInvocationAudit(context: SkillInvocationContext): Readonly<Record<string, string>> {
  const state = contexts.get(context)
  if (!state || !current(state)) return refuse("Skill invocation audit requires a current authentic context.")
  return Object.freeze({
    supervisorSessionID: context.supervisorSessionID, attachmentEpoch: context.attachmentEpoch,
    source: context.canonicalSource, name: context.name, contentHash: context.contentHash, invocationID: context.invocationID,
  })
}
