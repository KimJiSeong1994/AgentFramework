import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import type { AssistantMessage, Message, Part, ToolPart, UserMessage } from "@opencode-ai/sdk"
import { createConfigHook } from "../src/hooks/config.ts"
import { createChatMessageHook } from "../src/hooks/chat-message.ts"
import { createEventHook } from "../src/hooks/event.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import type { ExecutionClaim } from "../src/hosts/run-state.ts"
import type { HookDeps } from "../src/hooks/types.ts"
import { taskWorktreeOwner } from "../src/orchestration/worktree.ts"
import { admissionEpoch } from "../src/sessions/admission.ts"
import { getOwnedSession } from "../src/sessions/store.ts"
import {
  authenticatedSDKSessionIdentity,
  captureSDKSessionCreationObservation,
  captureSDKSessionOwner,
  captureForMessage,
  type SDKSessionIdentity,
} from "../src/sessions/sdk-transcript.ts"
import type { ExecutionRole } from "../src/hosts/types.ts"
import type { FakeClient } from "./guards-helpers.ts"

type NativeSDKMessage = { info: Message; parts: Part[] }
type NativeSessionState = {
  identity: SDKSessionIdentity
  updatedAt: number
  messages: NativeSDKMessage[]
}
type NativeTransport = { sessions: Map<string, NativeSessionState> }
type NativeClient = FakeClient & {
  session: FakeClient["session"] & {
    get: (options: { path: { id: string }; query: { directory: string } }) => Promise<{ data?: unknown; error?: unknown }>
    message: (options: { path: { id: string; messageID: string } }) => Promise<{ data?: unknown; error?: unknown }>
  }
}

const transports = new WeakMap<object, NativeTransport>()
let fixtureSequence = 0

export type NativeToolFixtureOptions = {
  sessionID: string
  role?: ExecutionRole
  ownerSessionID?: string
}

export type PrimedNativeToolCall = {
  input: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> }
  output: { args: Record<string, unknown> }
  part: ToolPart
  assistantMessage: AssistantMessage
  assistantMessageID: string
  userMessageID: string
}

type NativeToolFixturePartInput = Part extends infer T
  ? T extends Part
    ? Omit<T, "id" | "sessionID" | "messageID">
    : never
  : never

type NativeToolFixtureTurnOptions = {
  messageID?: string
  text?: string
  parts?: NativeToolFixturePartInput[]
}

export type NativeToolFixture = {
  deps: HookDeps
  sessionID: string
  role: ExecutionRole
  ownerSessionID?: string
  acceptUserTurn(messageID?: string): Promise<UserMessage>
  deliverUserTurn(options?: NativeToolFixtureTurnOptions): Promise<{ message: UserMessage; parts: Part[] }>
  deliverAssistantMessage(options?: NativeToolFixtureTurnOptions): Promise<{ message: AssistantMessage; parts: Part[] }>
  primeCall(options: { tool: string; args: Record<string, unknown>; callID?: string }): PrimedNativeToolCall
  readonly messages: readonly NativeSDKMessage[]
}

export type BoundNativeToolChildFixture = {
  native: NativeToolFixture
  claim: ExecutionClaim
  executionID: string
  taskID: string
  cleanup(): void
}

function transportFor(client: NativeClient): NativeTransport {
  const existing = transports.get(client)
  if (existing) return existing

  const transport: NativeTransport = { sessions: new Map() }
  client.session.get = async options => {
    client.calls.push({ method: "get", args: options })
    const session = transport.sessions.get(options.path.id)
    if (!session) return { error: new Error("unknown authoritative SDK session") }
    return {
      data: {
        id: options.path.id,
        projectID: "native-tool-fixture",
        directory: session.identity.directory,
        ...(session.identity.parentID ? { parentID: session.identity.parentID } : {}),
        title: "Native tool fixture",
        version: "fixture",
        time: { created: session.identity.createdAt, updated: session.updatedAt },
      },
    }
  }
  client.session.message = async options => {
    client.calls.push({ method: "message", args: options })
    const session = transport.sessions.get(options.path.id)
    const message = session?.messages.find(entry => entry.info.id === options.path.messageID)
    return message ? { data: message } : { error: new Error("unknown authoritative SDK message") }
  }
  client.session.messages = async options => {
    client.calls.push({ method: "messages", args: options })
    const session = transport.sessions.get(options.path.id)
    if (!session) return { data: [] }
    return { data: session.messages }
  }
  transports.set(client, transport)
  return transport
}

function nextID(prefix: string): string {
  fixtureSequence++
  return `${prefix}_${fixtureSequence}_${randomUUID()}`
}

/**
 * Build a test-only native session around the real config, admission, runtime, system-turn, and SDK proof paths.
 * Main sessions must already be owned by a genuine session handle; child sessions must already have a live owner execution binding.
 * Fixture construction never reopens a held session; chat.message remains responsible for refusing its user turns.
 */
export async function createNativeToolFixture(
  deps: HookDeps,
  options: NativeToolFixtureOptions,
): Promise<NativeToolFixture> {
  const sessionID = options.sessionID
  const role = options.role ?? "main"
  const ownerSessionID = options.ownerSessionID
  if (role === "main" ? ownerSessionID !== undefined : !ownerSessionID) {
    throw new Error("native tool fixture requires main without an owner or a child role with an owner")
  }

  const runtime = getOpenCodeRuntime(deps)
  await createConfigHook(deps)({})
  const directory = realpathSync.native(deps.directory)
  const ownerWorktree = ownerSessionID ? taskWorktreeOwner(deps.worktree)?.mainWorktree ?? deps.worktree : deps.worktree
  const parentEpoch = ownerSessionID ? admissionEpoch(ownerWorktree, ownerSessionID) : undefined
  const mainStore = role === "main" ? getOwnedSession(deps.worktree, sessionID) : undefined
  mainStore?.assertOwner()
  const liveSessionEpoch = role === "main" ? admissionEpoch(deps.worktree, sessionID) : undefined
  const sessionEpoch = role === "main" ? liveSessionEpoch ?? mainStore?.epoch : parentEpoch
  if (role === "main" && (!mainStore || mainStore.sessionID !== sessionID || mainStore.epoch !== sessionEpoch)) {
    throw new Error("native tool fixture requires a genuine owned main session handle")
  }
  if (!sessionEpoch) throw new Error(`native tool fixture requires a live ${role === "main" ? "session" : "owner"} admission`)
  if (role !== "main" && !parentEpoch) throw new Error("native child fixture requires a live owner admission epoch")

  const client = deps.client as unknown as NativeClient
  const transport = transportFor(client)
  let state = transport.sessions.get(sessionID)
  if (!state) {
    const observed = authenticatedSDKSessionIdentity(deps.worktree, sessionID)
    const createdAt = Date.now()
    const identity: SDKSessionIdentity = observed ?? {
      directory,
      ...(ownerSessionID ? { parentID: ownerSessionID, parentEpoch: parentEpoch! } : {}),
      createdAt,
      updatedAt: createdAt + 1,
    }
    if (identity.directory !== directory || identity.parentID !== ownerSessionID || identity.parentEpoch !== parentEpoch) {
      throw new Error(`native SDK session fixture identity changed for ${sessionID}`)
    }
    if (!captureSDKSessionCreationObservation(deps.worktree, sessionID, identity)) {
      throw new Error(`could not capture authoritative SDK creation metadata for ${sessionID}`)
    }
    if (ownerSessionID) captureSDKSessionOwner(deps.worktree, sessionID, ownerSessionID, identity.createdAt)
    const authenticated = authenticatedSDKSessionIdentity(deps.worktree, sessionID)
    if (!authenticated || authenticated.directory !== directory || authenticated.parentID !== ownerSessionID ||
        authenticated.parentEpoch !== parentEpoch) {
      throw new Error(`SDK session identity is not uniquely authenticated for ${sessionID}`)
    }
    state = { identity, updatedAt: Math.max(identity.updatedAt ?? identity.createdAt + 1, identity.createdAt), messages: [] }
    transport.sessions.set(sessionID, state)
  } else if (state.identity.directory !== directory || state.identity.parentID !== ownerSessionID ||
      state.identity.parentEpoch !== parentEpoch) {
    throw new Error(`native SDK session fixture identity changed for ${sessionID}`)
  }

  const sessionState = state
  let currentUser: UserMessage | undefined
  let currentAssistant: AssistantMessage | undefined
  const chatMessage = createChatMessageHook(deps)
  const event = createEventHook(deps)
  const messages = sessionState.messages

  async function deliverNativeUserTurn(
    { messageID = nextID("native_user"), text, parts: partInputs }: NativeToolFixtureTurnOptions = {},
    requireAccepted = false,
  ): Promise<{ message: UserMessage; parts: Part[] }> {
    if (messages.some(entry => entry.info.id === messageID)) throw new Error(`duplicate native SDK message ID ${messageID}`)
    const policy = runtime.policy.resolve(role)
    const created = Date.now()
    const message: UserMessage = {
      id: messageID,
      sessionID,
      role: "user",
      time: { created },
      agent: role,
      model: { providerID: "fixture", modelID: "native-tool-fixture" },
      ...(role === "main" ? {} : { system: policy.system.join("\n\n") }),
    }
    const input = {
      sessionID,
      agent: role,
      model: { providerID: "fixture", modelID: "native-tool-fixture" },
    }
    const inputs = partInputs ?? [{ type: "text" as const, text: text ?? "A real native fixture user request." }]
    const parts = nativeParts(sessionID, messageID, inputs)
    await chatMessage(input as never, { message, parts } as never)
    const accepted = hasAcceptedUserText(parts) && (role !== "main" || captureForMessage(deps.worktree, sessionID, messageID)?.role === "user")
    if (requireAccepted && !accepted) throw new Error(`native ${role} user turn was not accepted for ${sessionID}`)
    messages.push({ info: message, parts })
    currentUser = accepted ? message : undefined
    currentAssistant = undefined
    sessionState.updatedAt = Math.max(sessionState.updatedAt + 1, Date.now())
    return { message, parts }
  }

  return {
    deps,
    sessionID,
    role,
    ...(ownerSessionID ? { ownerSessionID } : {}),
    get messages() { return messages },
    async acceptUserTurn(messageID = nextID("native_user")) {
      const { message } = await deliverNativeUserTurn({ messageID }, true)
      return message
    },
    deliverUserTurn(options = {}) {
      return deliverNativeUserTurn(options)
    },
    async deliverAssistantMessage({ messageID = nextID("native_assistant"), text, parts: partInputs }: NativeToolFixtureTurnOptions = {}) {
      if (!currentUser) throw new Error(`deliver an accepted native user turn before an assistant message for ${sessionID}`)
      if (messages.some(entry => entry.info.id === messageID)) throw new Error(`duplicate native SDK message ID ${messageID}`)
      const createdAt = Math.max(Date.now(), (currentUser.time.created ?? 0) + 1)
      const assistantMessage: AssistantMessage = {
        id: messageID,
        sessionID,
        role: "assistant",
        time: {
          created: createdAt,
          completed: Math.max(Date.now(), createdAt + 1),
        },
        parentID: currentUser.id,
        modelID: "native-tool-fixture",
        providerID: "fixture",
        mode: role,
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      const inputs = partInputs ?? [{ type: "text" as const, text: text ?? "A real native fixture assistant response." }]
      const parts = nativeParts(sessionID, messageID, inputs)
      messages.push({ info: assistantMessage, parts })
      sessionState.updatedAt = Math.max(sessionState.updatedAt + 1, Date.now())
      await event({ event: { type: "message.updated", properties: { info: assistantMessage } } } as never)
      return { message: assistantMessage, parts }
    },
    primeCall({ tool, args, callID = nextID("native_call") }) {
      if (!currentUser) throw new Error(`accept a native user turn before priming a tool call for ${sessionID}`)
      if (messages.some(entry => entry.parts.some(part => part.type === "tool" && part.callID === callID))) {
        throw new Error(`duplicate native tool call ID ${callID}`)
      }
      if (!currentAssistant || currentAssistant.parentID !== currentUser.id) {
        currentAssistant = {
          id: nextID("native_assistant"),
          sessionID,
          role: "assistant",
          time: { created: Math.max(Date.now(), (currentUser.time.created ?? 0) + 1) },
          parentID: currentUser.id,
          modelID: "native-tool-fixture",
          providerID: "fixture",
          mode: role,
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        messages.push({ info: currentAssistant, parts: [] })
      }
      const assistantMessage = currentAssistant
      const part: ToolPart = {
        id: nextID("native_tool_part"),
        sessionID,
        messageID: assistantMessage.id,
        type: "tool",
        callID,
        tool,
        state: { status: "running", input: args, time: { start: Date.now() } },
      }
      const assistantEntry = messages.find(entry => entry.info.id === assistantMessage.id)
      if (!assistantEntry) throw new Error(`native assistant message disappeared for ${callID}`)
      assistantEntry.parts.push(part)
      sessionState.updatedAt = Math.max(sessionState.updatedAt + 1, Date.now())
      return {
        input: { tool, sessionID, callID, args },
        output: { args },
        part,
        assistantMessage,
        assistantMessageID: assistantMessage.id,
        userMessageID: currentUser.id,
      }
    },
  }
}

function nativeParts(sessionID: string, messageID: string, inputs: NativeToolFixturePartInput[]): Part[] {
  return inputs.map(input => ({
    ...input,
    id: nextID("native_part"),
    sessionID,
    messageID,
  }) as Part)
}

function hasAcceptedUserText(parts: Part[]): boolean {
  return parts.some(part => part.type === "text" && !part.synthetic && !part.ignored && part.text.length > 0)
}

/** Create a real host execution record and native child session under an already admitted owner. */
export async function createBoundNativeToolChildFixture(
  deps: HookDeps,
  options: { sessionID: string; ownerSessionID: string; role: Exclude<ExecutionRole, "main">; taskID?: string },
): Promise<BoundNativeToolChildFixture> {
  const runtime = getOpenCodeRuntime(deps)
  const { sessionID, ownerSessionID, role } = options
  const taskID = options.taskID ?? nextID("native_task")
  const executionID = nextID("native_execution")
  const attemptID = nextID("native_attempt")
  const policy = runtime.policy.resolve(role)
  const claim = runtime.runs.claim(ownerSessionID, runtime.instance, process.pid)
  let closed = false
  const cleanup = () => {
    if (closed) return
    const state = runtime.runs.status()
    const currentClaim = state.claim
    if (!currentClaim || currentClaim.generation !== claim.generation || currentClaim.ownerSession !== ownerSessionID) {
      closed = true
      return
    }
    const execution = state.executions.find(record => record.executionId === executionID)
    if (execution && !execution.terminal) {
      const terminalAt = Date.now()
      runtime.runs.recordTerminal(claim, executionID, { outcome: "completed", terminalAt, quiescentAt: terminalAt + 1 })
    }
    runtime.runs.release(claim)
    closed = true
  }

  try {
    runtime.runs.registerIntent(claim, {
      executionId: executionID,
      ownerSession: ownerSessionID,
      taskId: taskID,
      attemptId: attemptID,
      generation: claim.generation,
      role,
      cwd: realpathSync.native(deps.directory),
      policyID: policy.id,
      kind: "host",
      engine: runtime.host.identity.engine,
      profile: "legacy-unowned",
    })
    runtime.runs.markHostDispatched(claim, executionID)
    runtime.runs.bindVendorRef(claim, executionID, JSON.stringify({ executionID, vendorSessionID: sessionID }))
    const native = await createNativeToolFixture(deps, { sessionID, role, ownerSessionID })
    await native.acceptUserTurn()
    return { native, claim, executionID, taskID, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
