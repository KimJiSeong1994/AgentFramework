import type { PluginInput } from "@opencode-ai/plugin"
import type {
  ExecutionHandle,
  ExecutionHost,
  ExecutionOutcome,
  ExecutionPolicy,
  ExecutionReconciliation,
  ExecutionReference,
  ExecutionRole,
  ExecutionRequest,
} from "./types.ts"

type Client = PluginInput["client"]
export type OpenCodeRecoveryContext = {
  executionID: string
  vendorSessionID: string
  ownerSession: string
  cwd: string
  role: ExecutionRole
  policyID: string
  profile: "legacy-unowned"
  processRisk: boolean
}
export type OpenCodeHostCapabilities = {
  /** Bound to the plugin hooks by the owning runtime, not synthesized by this adapter. */
  policy: Pick<ExecutionPolicy, "bindSession" | "unbindSession" | "handlersForSession" | "snapshotForSession">
  /** Apply controls in the plugin hook pipeline for this session; false means unenforceable. */
  applyOutputLimit(sessionID: string, maximum: number): boolean
  applyThinking(sessionID: string, mode: "inherit" | "enabled" | "disabled"): boolean
  /** Durable plugin-process evidence that a shell command may have surviving descendants. */
  processRisk(sessionID: string): boolean
  /** Resolve recovery scope from the durable execution run record, never the caller's reference. */
  recoveryContext(reference: ExecutionReference): OpenCodeRecoveryContext | undefined
}

export function openCodeMessageID(executionID: string): string {
  return `msg_${executionID.replace(/[^A-Za-z0-9]/g, "")}`
}

type RecordValue = Record<string, unknown>
const object = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : structuredErrorName(error) ?? String(error)
}

function structuredErrorName(error: unknown): string | undefined {
  if (!object(error) || typeof error.name !== "string" ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(error.name)) return undefined
  return error.name
}

function outcomeError(error: unknown): Pick<ExecutionOutcome, "error" | "errorName"> {
  const errorName = structuredErrorName(error)
  return { error: errorMessage(error), ...(errorName ? { errorName } : {}) }
}

function messagePartsValid(value: unknown, sessionID: string, messageID: string): boolean {
  if (!Array.isArray(value)) return false
  for (const part of value) {
    if (!object(part) || !nonempty(part.id) || part.sessionID !== sessionID || part.messageID !== messageID || !nonempty(part.type)) return false
    switch (part.type) {
      case "text":
        if (typeof part.text !== "string") return false
        break
      case "reasoning":
        if (typeof part.text !== "string" || !object(part.time) || !timestamp(part.time.start)
          || ("end" in part.time && (!timestamp(part.time.end) || part.time.end < part.time.start))) return false
        break
      case "tool": {
        if (!nonempty(part.callID) || !nonempty(part.tool) || !object(part.state)) return false
        if (["bash", "task", "delegate"].includes(part.tool)) return false
        const state = part.state
        if (state.status !== "completed" && state.status !== "error") return false
        if (!object(state.time) || !timestamp(state.time.start) || !timestamp(state.time.end) || state.time.end < state.time.start
          || !object(state.input)) return false
        if (state.status === "completed" && (typeof state.output !== "string" || typeof state.title !== "string" || !object(state.metadata))) return false
        if (state.status === "error" && !nonempty(state.error)) return false
        break
      }
      case "step-finish": {
        const tokens = part.tokens
        if (!nonempty(part.reason) || typeof part.cost !== "number" || !Number.isFinite(part.cost)
          || !object(tokens) || !object(tokens.cache)
          || ![tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write].every(value => typeof value === "number" && Number.isFinite(value))) return false
        if ("snapshot" in part && typeof part.snapshot !== "string") return false
        break
      }
      case "retry":
        if (!Number.isSafeInteger(part.attempt) || (part.attempt as number) <= 0 || !object(part.error)
          || !nonempty(part.error.name) || !object(part.time) || !timestamp(part.time.created)) return false
        break
      case "file":
        if (!nonempty(part.mime) || !nonempty(part.url)) return false
        break
      case "subtask":
        return false
      case "step-start":
        if ("snapshot" in part && typeof part.snapshot !== "string") return false
        break
      case "snapshot":
        if (!nonempty(part.snapshot)) return false
        break
      case "patch":
        if (!nonempty(part.hash) || !Array.isArray(part.files) || !part.files.every(nonempty)) return false
        break
      case "agent":
        return false
      case "compaction":
        return false
      default:
        return false
    }
  }
  return true
}

function correlatedTerminalTranscript(value: unknown, context: OpenCodeRecoveryContext): boolean {
  if (!Array.isArray(value) || !value.length) return false
  const expectedPromptID = openCodeMessageID(context.executionID)
  const messageIDs = new Set<string>()
  const partIDs = new Set<string>()
  let userCount = 0
  let finalAssistant: RecordValue | undefined
  let terminalAssistantSeen = false
  let previousCreated = 0
  for (let index = 0; index < value.length; index++) {
    if (terminalAssistantSeen) return false
    const message = value[index]
    if (!object(message) || !object(message.info)) return false
    const info = message.info
    if (info.sessionID !== context.vendorSessionID || !nonempty(info.id) || messageIDs.has(info.id)) return false
    const parts = message.parts
    if (!messagePartsValid(parts, context.vendorSessionID, info.id)) return false
    const validParts = parts as unknown[]
    for (const part of validParts) {
      if (!object(part) || typeof part.id !== "string" || partIDs.has(part.id)) return false
      partIDs.add(part.id)
    }
    messageIDs.add(info.id)
    if (info.role === "user") {
      userCount++
      if (index !== 0 || info.id !== expectedPromptID || !object(info.time) || !timestamp(info.time.created) || info.time.created < previousCreated) return false
      previousCreated = info.time.created
      continue
    }
    if (info.role !== "assistant" || info.parentID !== expectedPromptID) return false
    if (!object(info.time) || !timestamp(info.time.created) || !timestamp(info.time.completed)
      || info.time.completed < info.time.created || info.time.created < previousCreated) return false
    previousCreated = info.time.completed
    if (finalAssistant && (!nonempty(finalAssistant.finish) || finalAssistant.finish === "unknown")) return false
    if ("finish" in info && !nonempty(info.finish)) return false
    if ("error" in info && (!object(info.error) || !nonempty(info.error.name))) return false
    const tools = validParts.filter((part: unknown) => object(part) && part.type === "tool")
    if (info.finish === "tool-calls" && tools.length === 0) return false
    if (info.agent !== undefined && info.agent !== context.role) return false
    terminalAssistantSeen = (nonempty(info.finish) && info.finish !== "tool-calls" && info.finish !== "unknown")
      || (object(info.error) && nonempty(info.error.name))
    finalAssistant = info
  }
  if (userCount !== 1 || !finalAssistant) return false
  if (!object(finalAssistant.time)) return false
  const completedError = object(finalAssistant.error) && nonempty(finalAssistant.error.name)
  return timestamp(finalAssistant.time.completed)
    && (completedError || (nonempty(finalAssistant.finish) && finalAssistant.finish !== "tool-calls" && finalAssistant.finish !== "unknown"))
}

function unknown(evidence: string): ExecutionReconciliation {
  return { outcome: "unknown", quiescent: false, evidence }
}

function running(evidence: string): ExecutionReconciliation {
  return { outcome: "running", quiescent: false, evidence }
}

function validRecoveryContext(value: OpenCodeRecoveryContext | undefined, reference: ExecutionReference): value is OpenCodeRecoveryContext {
  return !!value && value.executionID === reference.executionID && value.vendorSessionID === reference.vendorSessionID
    && nonempty(value.ownerSession) && nonempty(value.cwd) && nonempty(value.role) && nonempty(value.policyID)
    && value.profile === "legacy-unowned" && typeof value.processRisk === "boolean"
}

function sameRecoveryIdentity(left: OpenCodeRecoveryContext, right: OpenCodeRecoveryContext): boolean {
  return left.executionID === right.executionID && left.vendorSessionID === right.vendorSessionID
    && left.ownerSession === right.ownerSession && left.cwd === right.cwd && left.role === right.role
    && left.policyID === right.policyID && left.profile === right.profile
}

type StatusRead = { outcome: "inactive" } | { outcome: "running" | "unknown"; result: ExecutionReconciliation }

async function readSessionStatus(client: Client, context: OpenCodeRecoveryContext): Promise<StatusRead> {
  const response = await client.session.status({ query: { directory: context.cwd } })
  if (response.error || !object(response.data)) {
    return { outcome: "unknown", result: unknown(response.error ? errorMessage(response.error) : "OpenCode returned no session status") }
  }
  // OpenCode removes idle sessions from its status map. Absence permits further
  // inspection, never quiescence by itself: session identity and a complete
  // correlated terminal transcript are still required below.
  if (!Object.hasOwn(response.data, context.vendorSessionID)) return { outcome: "inactive" }
  const status = response.data[context.vendorSessionID]
  if (!status || typeof status !== "object") {
    return { outcome: "unknown", result: unknown("OpenCode returned no status for the recorded session") }
  }
  if (status.type === "busy" || status.type === "retry") {
    return { outcome: "running", result: running(`OpenCode reports session ${status.type}`) }
  }
  if (status.type !== "idle") {
    return { outcome: "unknown", result: unknown("OpenCode returned an unrecognized session status") }
  }
  return { outcome: "inactive" }
}

export function createOpenCodeHost(client: Client, capabilities?: OpenCodeHostCapabilities): ExecutionHost {
  const policyBound = !!capabilities?.policy
  const controlsAvailable = !!capabilities?.applyOutputLimit && !!capabilities?.applyThinking && !!capabilities?.processRisk
  return {
    identity: { engine: "opencode", candidateVersion: "1.18.32", profile: "opencode-plugin" },

    async preflight(profile) {
      const compatible = policyBound && controlsAvailable
      return {
        compatible,
        controls: {
          session: "supported",
          model: "supported",
          system: "supported",
          tools: policyBound ? "supported" : "unsupported",
          outputLimit: controlsAvailable ? "supported" : "unsupported",
          thinking: controlsAvailable ? "supported" : "unsupported",
          toolPolicyHandlers: policyBound ? "supported" : "unsupported",
          assistantTextHandler: policyBound ? "supported" : "unsupported",
        },
        problems: compatible ? [] : [`OpenCode plugin does not provide all required execution controls for profile ${profile}`],
      }
    },

    async reconcile(reference) {
      if (!object(reference) || !nonempty(reference.executionID) || !nonempty(reference.vendorSessionID)) {
        return unknown("persisted reference has no OpenCode execution or session ID")
      }
      if (!capabilities?.recoveryContext) return unknown("durable OpenCode recovery context is unavailable")
      try {
        const initialContext = capabilities.recoveryContext(reference)
        if (!validRecoveryContext(initialContext, reference)) return unknown("persisted OpenCode execution context is missing or incompatible")
        const status = await readSessionStatus(client, initialContext)
        if (status.outcome !== "inactive") return status.result

        const session = await client.session.get({
          path: { id: initialContext.vendorSessionID },
          query: { directory: initialContext.cwd },
        })
        if (session.error || !session.data) {
          return unknown(session.error ? errorMessage(session.error) : "OpenCode returned no session record")
        }
        if (session.data.id !== initialContext.vendorSessionID
          || session.data.parentID !== initialContext.ownerSession
          || session.data.directory !== initialContext.cwd) {
          return unknown("OpenCode session identity, owner or directory does not match the durable execution")
        }

        const messages = await client.session.messages({
          path: { id: initialContext.vendorSessionID },
          query: { directory: initialContext.cwd },
        })
        if (messages.error || !Array.isArray(messages.data)) {
          return unknown(messages.error ? errorMessage(messages.error) : "OpenCode returned no complete session message list")
        }
        if (!correlatedTerminalTranscript(messages.data, initialContext)) {
          return unknown("OpenCode transcript does not prove one completed correlated prompt")
        }
        const terminalMessageID = messages.data.at(-1)!.info.id

        const finalStatus = await readSessionStatus(client, initialContext)
        const finalContext = capabilities.recoveryContext(reference)
        if (!validRecoveryContext(finalContext, reference) || !sameRecoveryIdentity(initialContext, finalContext)) {
          return unknown("durable OpenCode execution context changed during reconciliation")
        }
        if (finalStatus.outcome !== "inactive") return finalStatus.result
        if (initialContext.processRisk || finalContext.processRisk) {
          return { outcome: "terminal", quiescent: false, evidence: "correlated completed transcript; shell process descendants may survive" }
        }
        return { outcome: "terminal", quiescent: true, evidence: `completed OpenCode request ${openCodeMessageID(reference.executionID)}, assistant ${terminalMessageID}; no active status or recorded shell process risk` }
      } catch (error) {
        return unknown(errorMessage(error))
      }
    },

    async prepare(request: ExecutionRequest): Promise<ExecutionHandle> {
      if (!capabilities || !policyBound || !controlsAvailable) {
        throw new Error("OpenCode execution controls are unavailable; refusing to create a child session")
      }
      const created = await client.session.create({
        body: { title: request.title, parentID: request.supervisorSessionID },
        query: { directory: request.cwd },
      })
      if (created.error || !created.data?.id) {
        throw new Error(`OpenCode session creation failed: ${errorMessage(created.error ?? "empty session response")}`)
      }

      const reference: ExecutionReference = {
        executionID: request.executionID,
        vendorSessionID: created.data.id,
      }
      request.onReference?.(reference)
      capabilities.policy.bindSession(created.data.id, request.handlers, request.policy)
      if (!capabilities.applyOutputLimit(created.data.id, request.policy.maxOutputTokens)
        || !capabilities.applyThinking(created.data.id, request.policy.thinking)) {
        throw new Error("OpenCode plugin hooks could not apply the requested output/thinking controls")
      }
      let outcome: ExecutionOutcome | undefined
      let terminalResponse = false
      let promptStarted = false
      const messageID = openCodeMessageID(request.executionID)

      return {
        reference,
        async run() {
          if (promptStarted) return { status: "unresolved", error: "OpenCode prompt already dispatched" }
          promptStarted = true
          try {
            const result = await client.session.prompt({
              path: { id: created.data.id },
              query: { directory: request.cwd },
              body: {
                messageID,
                model: request.policy.model,
                agent: request.role,
                system: request.policy.system.join("\n\n"),
                tools: Object.fromEntries([
                  ...new Set([...request.policy.tools.allowed, ...request.policy.tools.denied]),
                ].map((name) => [name, !request.policy.tools.denied.includes(name)])),
                parts: [{ type: "text", text: request.text }],
              },
            })
            if (result.error) {
              outcome = { status: "failed", ...outcomeError(result.error) }
            } else {
              const response = result.data
              const parts: unknown = response?.parts
              const text = Array.isArray(parts)
                ? parts.filter((part): part is { type: "text"; text: string } =>
                  typeof part === "object" && part !== null && "type" in part && part.type === "text"
                  && "text" in part && typeof part.text === "string")
                  .map((part) => part.text)
                  .join("\n")
                : ""
              const valid = response?.info?.sessionID === created.data.id
                && response.info.role === "assistant"
                && response.info.parentID === messageID
              if (!valid) {
                outcome = { status: "incomplete", error: "OpenCode returned an incomplete or uncorrelated assistant response" }
              } else if (response.info.error) {
                terminalResponse = true
                outcome = {
                  status: response.info.error.name === "MessageAbortedError" ? "cancelled" : "failed",
                  ...outcomeError(response.info.error),
                }
              } else if (text) {
                terminalResponse = true
                outcome = { status: "completed", text }
                outcome.childMessageID = response.info.id
              } else {
                outcome = { status: "incomplete", error: "OpenCode returned no final assistant text" }
              }
            }
          } catch (error) {
            outcome = { status: "failed", ...outcomeError(error) }
          }
          return outcome
        },
        async requestCancel(_reason: string, deadlineAt: number) {
          const remaining = Math.max(0, deadlineAt - Date.now())
          if (!remaining) {
            return { requested: false, acknowledged: false, terminal: false, quiescent: false, evidence: "cancellation deadline elapsed before abort request" }
          }
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const abort = client.session.abort({ path: { id: created.data.id }, query: { directory: request.cwd } })
            const result = await Promise.race([
              abort,
              new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining) }),
            ])
            if (timer) clearTimeout(timer)
            if (result === null) {
              return { requested: true, acknowledged: false, terminal: false, quiescent: false, evidence: "abort request exceeded cancellation deadline" }
            }
            return { requested: true, acknowledged: !result.error && result.data === true, terminal: false, quiescent: false, evidence: result.error ? errorMessage(result.error) : "abort acknowledged; terminal state unproven" }
          } catch (error) {
            return { requested: true, acknowledged: false, terminal: false, quiescent: false, evidence: errorMessage(error) }
          }
        },
        async reconcile() {
          if (terminalResponse) return capabilities.processRisk(created.data.id)
            ? { outcome: "terminal", quiescent: false, evidence: "shell tool executed; descendant process quiescence is unproven" }
            : { outcome: "terminal", quiescent: true, evidence: "correlated final assistant response without shell process risk" }
          try {
            const status = await client.session.status({ query: { directory: request.cwd } })
            if (!status.error && status.data && status.data[created.data.id]?.type === "idle" && promptStarted) return { outcome: "unknown", quiescent: false, evidence: "session idle without a correlated final response" }
            if (!status.error && status.data?.[created.data.id]?.type === "busy") {
              return { outcome: "running", quiescent: false, evidence: "OpenCode reports session busy" }
            }
            return { outcome: "unknown", quiescent: false, evidence: status.error ? errorMessage(status.error) : "no terminal/quiescence proof" }
          } catch (error) {
            return { outcome: "unknown", quiescent: false, evidence: errorMessage(error) }
          }
        },
      }
    },
  }
}
