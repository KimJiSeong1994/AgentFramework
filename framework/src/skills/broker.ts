import { createHash, randomUUID } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { captureAdmissionLease, isAdmissionLeaseCurrent, type AdmissionLease } from "../sessions/admission.ts"
import { getOwnedSession, type SessionStore } from "../sessions/store.ts"
import { EXECUTION_TOOL_NAMES, type ExecutionEvent, type ExecutionPolicy, type ExecutionPolicySnapshot, type ExecutionRequest } from "../hosts/types.ts"
import type { Terminal } from "../hosts/interactive-session.ts"
import { registerSkillPermissionActivity } from "./activity.ts"

const MAX_CHOICE_WAIT_MS = 60_000
const REQUEST_DEADLINE_MARGIN_MS = 2_000
const MAX_IDENTIFIER_LENGTH = 256
const MAX_ARGUMENT_BYTES = 1024 * 1024
const MAX_ARGUMENT_NODES = 8192
const MAX_ARGUMENT_DEPTH = 32
const CLI_ENGINES = new Set(["local", "codex", "claude"])
const PERMISSION_CHOICES = Object.freeze(["Allow once", "Deny"] as const)

type ToolBeforeEvent = Extract<ExecutionEvent, { type: "tool-before" }>
type InvocationRequest = Omit<ExecutionRequest, "handlers">

declare const foregroundInvocationBrand: unique symbol
declare const skillHoldTicketBrand: unique symbol
declare const skillPermissionPermitBrand: unique symbol

/** Runtime-minted authority for one interactive main CLI invocation. */
export type ForegroundSkillInvocation = Readonly<{ [foregroundInvocationBrand]: never }>

/** Private in-memory denial ticket; object shape carries no authority. */
export type SkillHoldTicket = Readonly<{ [skillHoldTicketBrand]: never }>

/** One-call permission proof; authenticity and use are held only in WeakMaps. */
export type SkillPermissionPermit = Readonly<{ [skillPermissionPermitBrand]: never }>

export type SkillPermissionView = Readonly<{
  name: string
  classification: "common" | "custom"
  allowedTools?: readonly string[]
}>

export type SkillCallRevalidation = Readonly<{
  /** Synchronous call-bound proof gate; owner, role, path, and arguments must already be admissible. */
  canIssueTicket: () => boolean
  beforeChoice: (signal: AbortSignal) => boolean | Promise<boolean>
  afterChoice: (signal: AbortSignal) => boolean | Promise<boolean>
  beforeConsume: () => boolean
}>

type InvocationState = {
  active: boolean
  worktree: string
  sessionID: string
  epoch: string
  store: SessionStore
  lease: AdmissionLease
  invocationID: string
  executionID: string
  taskID: string
  attemptID: string
  generation: number
  requestDeadlineAt: number
  policyID: string
  policy: ExecutionPolicy
  policySnapshot: ExecutionPolicySnapshot
  choose: NonNullable<Terminal["choose"]>
  lifecycle: AbortController
  callIDs: Set<string>
  tickets: Set<TicketState>
}

type TicketState = {
  invocation: ForegroundSkillInvocation
  owner: InvocationState
  invocationID: string
  executionID: string
  attemptID: string
  generation: number
  callID: string
  tool: string
  argumentDigest: string
  skillHash: string
  policyID: string
  requestDeadlineAt: number
  deadlineAt: number
  view: SkillPermissionView
  revalidation: SkillCallRevalidation
  state: "issued" | "waiting" | "permitted" | "consumed" | "denied" | "invalid"
}

type PermitState = { ticket: TicketState; state: "fresh" | "consuming" | "consumed" | "invalid" }

const invocations = new WeakMap<object, InvocationState>()
const tickets = new WeakMap<object, TicketState>()
const permits = new WeakMap<object, PermitState>()

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
}

function canonicalWorktree(worktree: string): string {
  if (typeof worktree !== "string" || worktree.length === 0 || worktree.includes("\0")) {
    throw new TypeError("invalid foreground worktree")
  }
  const canonical = realpathSync.native(resolve(worktree))
  if (!statSync(canonical).isDirectory()) throw new TypeError("foreground worktree is not a directory")
  return canonical
}

function policySnapshotIsFixed(policy: ExecutionPolicy, request: InvocationRequest): boolean {
  try {
    const snapshot = policy.resolve("main")
    return request.role === "main" && snapshot === request.policy && fixedMainSnapshot(snapshot)
  } catch {
    return false
  }
}

function fixedMainSnapshot(snapshot: ExecutionPolicySnapshot): boolean {
  return snapshot.role === "main" && boundedIdentifier(snapshot.id) && Object.isFrozen(snapshot) &&
    !!snapshot.tools && Object.isFrozen(snapshot.tools) && Array.isArray(snapshot.tools.allowed) &&
    Object.isFrozen(snapshot.tools.allowed) && Array.isArray(snapshot.tools.denied) &&
    Object.isFrozen(snapshot.tools.denied) && Array.isArray(snapshot.system) && Object.isFrozen(snapshot.system)
}

function policyStillFixed(owner: InvocationState): boolean {
  try {
    const model = owner.policySnapshot.model
    return !!model && owner.policy.resolve("main") === owner.policySnapshot && fixedMainSnapshot(owner.policySnapshot) &&
      model.providerID === owner.store.metadata.engine && model.modelID === owner.store.metadata.model
  } catch {
    return false
  }
}

function requestHasInvocationShape(request: InvocationRequest, sessionID: string): boolean {
  return !!request && request.role === "main" && request.supervisorSessionID === sessionID &&
    boundedIdentifier(request.executionID) && boundedIdentifier(request.taskID) && boundedIdentifier(request.attemptID) &&
    Number.isSafeInteger(request.generation) && request.generation >= 0 &&
    Number.isSafeInteger(request.deadlineAt) && request.deadlineAt > Date.now() &&
    boundedIdentifier(request.policy?.id) && request.policy.role === "main"
}

function currentInvocation(owner: InvocationState): boolean {
  if (!owner.active || owner.lifecycle.signal.aborted || owner.store.sessionID !== owner.sessionID ||
      owner.store.epoch !== owner.epoch) return false
  try {
    return getOwnedSession(owner.worktree, owner.sessionID) === owner.store &&
      isAdmissionLeaseCurrent(owner.worktree, owner.sessionID, owner.lease)
  } catch {
    return false
  }
}

function requestMatchesInvocation(owner: InvocationState, request: ExecutionRequest): boolean {
  return requestHasInvocationShape(request, owner.sessionID) && request.executionID === owner.executionID &&
    request.taskID === owner.taskID && request.cwd === owner.worktree && request.attemptID === owner.attemptID &&
    request.generation === owner.generation &&
    request.deadlineAt === owner.requestDeadlineAt && request.policy.id === owner.policyID &&
    request.policy === owner.policySnapshot && policySnapshotIsFixed(owner.policy, request)
}

/**
 * Mint only from the real interactive runtime: the exact owned session and live admission incarnation,
 * main role, fixed policy snapshot, and the supplied Terminal's real TTY eligibility are all required.
 */
export function registerForegroundSkillInvocation(input: Readonly<{
  worktree: string
  store: SessionStore
  request: InvocationRequest
  policy: ExecutionPolicy
  terminal: Pick<Terminal, "stdinIsTTY" | "stderrIsTTY" | "choose">
}>): ForegroundSkillInvocation | undefined {
  try {
    const worktree = canonicalWorktree(input.worktree)
    const store = input.store
    const request = input.request
    const terminal = input.terminal
    const model = request?.policy?.model
    if (!store || !CLI_ENGINES.has(store.metadata.engine) || !terminal || terminal.stdinIsTTY !== true || terminal.stderrIsTTY !== true ||
        typeof terminal.choose !== "function" || !requestHasInvocationShape(request, store.sessionID) ||
        request.cwd !== worktree ||
        !policySnapshotIsFixed(input.policy, request) || !model || model.providerID !== store.metadata.engine ||
        model.modelID !== store.metadata.model) return undefined
    const sessionID = store.sessionID
    if (!boundedIdentifier(sessionID) || getOwnedSession(worktree, sessionID) !== store || store.epoch.length === 0) return undefined
    const lease = captureAdmissionLease(worktree, sessionID)
    if (!lease || !isAdmissionLeaseCurrent(worktree, sessionID, lease)) return undefined

    const invocation: ForegroundSkillInvocation = Object.freeze(Object.create(null)) as ForegroundSkillInvocation
    const owner: InvocationState = {
      active: true,
      worktree,
      sessionID,
      epoch: store.epoch,
      store,
      lease,
      invocationID: randomUUID(),
      executionID: request.executionID,
      taskID: request.taskID,
      attemptID: request.attemptID,
      generation: request.generation,
      requestDeadlineAt: request.deadlineAt,
      policyID: request.policy.id,
      policy: input.policy,
      policySnapshot: request.policy,
      choose: terminal.choose.bind(terminal),
      lifecycle: new AbortController(),
      callIDs: new Set(),
      tickets: new Set(),
    }
    invocations.set(invocation, owner)
    return invocation
  } catch {
    return undefined
  }
}

/** Return the runtime-generated identity for binding into trusted invocation context, never a model field. */
export function foregroundSkillInvocationID(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const owner = invocations.get(value)
  return owner?.active && currentInvocation(owner) ? owner.invocationID : undefined
}

/** Irreversibly revoke this invocation and every ticket it issued. */
export function revokeForegroundSkillInvocation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const owner = invocations.get(value)
  if (!owner || !owner.active) return false
  owner.active = false
  for (const ticket of owner.tickets) ticket.state = "invalid"
  owner.tickets.clear()
  owner.lifecycle.abort(new Error("foreground skill invocation revoked"))
  return true
}

function canonicalArgument(value: unknown): string | undefined {
  let nodes = 0
  let sourceBytes = 0
  const stack = new Set<object>()

  const visit = (current: unknown, depth: number): string | undefined => {
    if (++nodes > MAX_ARGUMENT_NODES || depth > MAX_ARGUMENT_DEPTH) return undefined
    if (current === null) return "null"
    if (typeof current === "string") {
      sourceBytes += Buffer.byteLength(current, "utf8")
      return sourceBytes <= MAX_ARGUMENT_BYTES ? JSON.stringify(current) : undefined
    }
    if (typeof current === "boolean") return current ? "true" : "false"
    if (typeof current === "number") return Number.isFinite(current) ? JSON.stringify(current) : undefined
    if (typeof current !== "object") return undefined
    if (stack.has(current)) return undefined
    stack.add(current)
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype || current.length > MAX_ARGUMENT_NODES) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(current)
        const keys = Reflect.ownKeys(descriptors)
        if (keys.length !== current.length + 1 || !Object.hasOwn(descriptors, "length")) return undefined
        const parts: string[] = []
        for (let index = 0; index < current.length; index++) {
          const descriptor = descriptors[String(index)]
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return undefined
          const part = visit(descriptor.value, depth + 1)
          if (part === undefined) return undefined
          parts.push(part)
        }
        return `[${parts.join(",")}]`
      }
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) return undefined
      const descriptors = Object.getOwnPropertyDescriptors(current)
      const keys = Reflect.ownKeys(descriptors)
      if (keys.some(key => typeof key !== "string")) return undefined
      const names = (keys as string[]).sort()
      const parts: string[] = []
      for (const name of names) {
        const descriptor = descriptors[name]
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return undefined
        sourceBytes += Buffer.byteLength(name, "utf8")
        if (sourceBytes > MAX_ARGUMENT_BYTES) return undefined
        const part = visit(descriptor.value, depth + 1)
        if (part === undefined) return undefined
        parts.push(`${JSON.stringify(name)}:${part}`)
      }
      return `{${parts.join(",")}}`
    } finally {
      stack.delete(current)
    }
  }

  const canonical = visit(value, 0)
  if (canonical === undefined || Buffer.byteLength(canonical, "utf8") > MAX_ARGUMENT_BYTES) return undefined
  return canonical
}

export function skillArgumentDigest(value: unknown): string | undefined {
  const canonical = canonicalArgument(value)
  return canonical === undefined ? undefined : createHash("sha256").update(canonical, "utf8").digest("hex")
}

function validView(value: SkillPermissionView): SkillPermissionView | undefined {
  if (!value || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.name) ||
      (value.classification !== "common" && value.classification !== "custom")) return undefined
  if (value.allowedTools !== undefined && (!Array.isArray(value.allowedTools) || value.allowedTools.length > EXECUTION_TOOL_NAMES.length ||
      value.allowedTools.some(tool => typeof tool !== "string" || !EXECUTION_TOOL_NAMES.includes(tool as typeof EXECUTION_TOOL_NAMES[number])))) {
    return undefined
  }
  return Object.freeze({
    name: value.name,
    classification: value.classification,
    ...(value.allowedTools === undefined ? {} : { allowedTools: Object.freeze([...new Set(value.allowedTools)]) }),
  })
}

function validToolEvent(owner: InvocationState, event: ToolBeforeEvent): boolean {
  const snapshot = owner.policySnapshot
  return !!event && event.type === "tool-before" && event.sessionID === owner.executionID &&
    boundedIdentifier(event.callID) && boundedIdentifier(event.name) &&
    (EXECUTION_TOOL_NAMES as readonly string[]).includes(event.name) &&
    snapshot.tools.allowed.includes(event.name) && !snapshot.tools.denied.includes(event.name)
}

/** Synchronous denial-ticket issuance. Invalid owners, roles, policies, and base tools get no ticket. */
export function createSkillHoldTicket(input: Readonly<{
  invocation: ForegroundSkillInvocation
  event: ToolBeforeEvent
  skillHash: string
  view: SkillPermissionView
  revalidation: SkillCallRevalidation
}>): SkillHoldTicket | undefined {
  if (!input || !input.invocation || typeof input.invocation !== "object") return undefined
  const owner = invocations.get(input.invocation)
  if (!owner || !currentInvocation(owner) || !policyStillFixed(owner) || !validToolEvent(owner, input.event) ||
      !/^[a-f0-9]{64}$/u.test(input.skillHash)) return undefined
  const callID = input.event.callID
  const tool = input.event.name
  const eventSessionID = input.event.sessionID
  const skillHash = input.skillHash
  const initialDigest = skillArgumentDigest(input.event.input)
  if (!initialDigest) return undefined
  const view = validView(input.view)
  const revalidation = input.revalidation && Object.freeze({ ...input.revalidation })
  if (!view || !revalidation || typeof revalidation.canIssueTicket !== "function" ||
      typeof revalidation.beforeChoice !== "function" ||
      typeof revalidation.afterChoice !== "function" || typeof revalidation.beforeConsume !== "function") return undefined
  try {
    if (revalidation.canIssueTicket() !== true) return undefined
  } catch {
    return undefined
  }

  const digest = skillArgumentDigest(input.event.input)
  if (!digest || digest !== initialDigest || !currentInvocation(owner) || !policyStillFixed(owner) ||
      !validToolEvent(owner, input.event) || input.event.callID !== callID || input.event.name !== tool ||
      input.event.sessionID !== eventSessionID || input.skillHash !== skillHash) return undefined
  const callKey = `${owner.executionID}\0${callID}`
  if (owner.callIDs.has(callKey)) return undefined
  const now = Date.now()
  const deadlineAt = Math.min(now + MAX_CHOICE_WAIT_MS, owner.requestDeadlineAt - REQUEST_DEADLINE_MARGIN_MS)
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= now) return undefined

  const ticket: SkillHoldTicket = Object.freeze(Object.create(null)) as SkillHoldTicket
  const state: TicketState = {
    invocation: input.invocation,
    owner,
    invocationID: owner.invocationID,
    executionID: owner.executionID,
    attemptID: owner.attemptID,
    generation: owner.generation,
    callID,
    tool,
    argumentDigest: digest,
    skillHash,
    policyID: owner.policyID,
    requestDeadlineAt: owner.requestDeadlineAt,
    deadlineAt,
    view,
    revalidation,
    state: "issued",
  }
  owner.callIDs.add(callKey)
  owner.tickets.add(state)
  tickets.set(ticket, state)
  return ticket
}

function permissionTitle(ticket: TicketState): string {
  const { view } = ticket
  const scope = view.allowedTools === undefined ? "declared tools: unspecified" : `declared tools: ${view.allowedTools.join(", ") || "none"}`
  return `Skill permission: ${view.name} (${view.classification})\nHash: ${ticket.skillHash}\nTool: ${ticket.tool}\n${scope}`
}

function abortError(): Error {
  const error = new Error("skill permission wait cancelled")
  error.name = "AbortError"
  return error
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(abortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(value => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(value)
    }, error => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(error)
    })
  })
}

function ticketCanWait(ticket: TicketState): boolean {
  return ticket.state === "waiting" && Date.now() < ticket.deadlineAt && currentInvocation(ticket.owner) &&
    ticket.invocationID === ticket.owner.invocationID && policyStillFixed(ticket.owner)
}

/** Await one inline allow-once/deny choice without granting UI authority to headless callers. */
export async function awaitSkillPermission(
  value: unknown,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<SkillPermissionPermit | undefined> {
  if (!value || typeof value !== "object") return undefined
  const ticket = tickets.get(value)
  if (!ticket || ticket.state !== "issued") return undefined
  ticket.state = "waiting"

  const controller = new AbortController()
  let unregisterActivity: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const externalSignal = options?.signal
  const abortFromExternal = () => controller.abort(externalSignal?.reason ?? abortError())
  const abortFromInvocation = () => controller.abort(ticket.owner.lifecycle.signal.reason ?? abortError())

  try {
    unregisterActivity = registerSkillPermissionActivity(ticket.owner.worktree, ticket.owner.sessionID, ticket.owner.epoch, controller)
    if (externalSignal?.aborted) abortFromExternal()
    else externalSignal?.addEventListener("abort", abortFromExternal, { once: true })
    if (ticket.owner.lifecycle.signal.aborted) abortFromInvocation()
    else ticket.owner.lifecycle.signal.addEventListener("abort", abortFromInvocation, { once: true })
    const remaining = ticket.deadlineAt - Date.now()
    if (remaining <= 0) controller.abort(new Error("skill permission deadline elapsed"))
    else timeout = setTimeout(() => controller.abort(new Error("skill permission deadline elapsed")), remaining)

    if (controller.signal.aborted || !ticketCanWait(ticket)) return undefined
    const before = await withAbort(Promise.resolve().then(() => ticket.revalidation.beforeChoice(controller.signal)), controller.signal)
    if (before !== true || controller.signal.aborted || !ticketCanWait(ticket)) return undefined

    const choice = await withAbort(
      Promise.resolve().then(() => ticket.owner.choose(permissionTitle(ticket), PERMISSION_CHOICES, controller.signal)),
      controller.signal,
    )
    if ((choice !== 0 && choice !== 1) || controller.signal.aborted || !ticketCanWait(ticket)) return undefined

    const after = await withAbort(Promise.resolve().then(() => ticket.revalidation.afterChoice(controller.signal)), controller.signal)
    if (after !== true || controller.signal.aborted || !ticketCanWait(ticket) || choice !== 0) return undefined

    const permit: SkillPermissionPermit = Object.freeze(Object.create(null)) as SkillPermissionPermit
    permits.set(permit, { ticket, state: "fresh" })
    ticket.state = "permitted"
    return permit
  } catch {
    return undefined
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    externalSignal?.removeEventListener("abort", abortFromExternal)
    ticket.owner.lifecycle.signal.removeEventListener("abort", abortFromInvocation)
    if (!controller.signal.aborted) controller.abort(new Error("skill permission wait settled"))
    unregisterActivity?.()
    if (ticket.state === "waiting") ticket.state = "denied"
  }
}

function requestAndEventMatch(
  ticket: TicketState,
  invocation: ForegroundSkillInvocation,
  request: ExecutionRequest,
  event: ToolBeforeEvent,
  skillHash: string,
): boolean {
  if (invocation !== ticket.invocation || !requestMatchesInvocation(ticket.owner, request) ||
      ticket.invocationID !== ticket.owner.invocationID || !currentInvocation(ticket.owner) || !policyStillFixed(ticket.owner) ||
      !validToolEvent(ticket.owner, event)) return false
  const digest = skillArgumentDigest(event.input)
  return invocation === ticket.invocation && skillHash === ticket.skillHash && digest === ticket.argumentDigest &&
    event.callID === ticket.callID && event.name === ticket.tool && request.executionID === ticket.executionID &&
    request.attemptID === ticket.attemptID && request.generation === ticket.generation &&
    request.deadlineAt === ticket.requestDeadlineAt && request.policy.id === ticket.policyID &&
    Date.now() < ticket.deadlineAt
}

/** Consume at the same-call policy retry, synchronously before that call's first effect. */
export function consumeSkillPermissionPermit(
  value: unknown,
  input: Readonly<{
    invocation: ForegroundSkillInvocation
    request: ExecutionRequest
    event: ToolBeforeEvent
    skillHash: string
  }>,
): boolean {
  if (!value || typeof value !== "object") return false
  const permit = permits.get(value)
  if (!permit || permit.state !== "fresh") return false
  permit.state = "consuming"
  const ticket = permit.ticket
  const ticketWasPermitted = ticket.state === "permitted"
  let allowed = false
  try {
    if (ticketWasPermitted && requestAndEventMatch(ticket, input.invocation, input.request, input.event, input.skillHash)) {
      const current: unknown = ticket.revalidation.beforeConsume()
      if (current && (typeof current === "object" || typeof current === "function") &&
          typeof (current as { then?: unknown }).then === "function") {
        void Promise.resolve(current).catch(() => {})
      }
      allowed = current === true && ticket.state === "permitted" &&
        requestAndEventMatch(ticket, input.invocation, input.request, input.event, input.skillHash)
    }
  } catch {
    allowed = false
  }
  ticket.state = allowed ? "consumed" : "invalid"
  permit.state = allowed ? "consumed" : "invalid"
  return allowed
}
