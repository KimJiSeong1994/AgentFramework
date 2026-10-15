import { readFile, writeFile } from "node:fs/promises"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"

const commandName = "lca-contract"

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function persist(path: string, value: Record<string, unknown>) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export default async function sdkContractPlugin({ client }: PluginInput): Promise<Hooks> {
  let firstChatMessageCaptured = false
  return {
    "chat.message": async (input, output) => {
      if (firstChatMessageCaptured) return
      firstChatMessageCaptured = true

      const evidencePath = process.env.LCA_CONTRACT_CHAT_MESSAGE_EVIDENCE
      if (!evidencePath) {
        throw new Error("SDK contract plugin is missing its chat.message evidence path")
      }

      const currentMessage = output.message
      const evidence: Record<string, unknown> = {
        phase: "captured",
        hook: "chat.message",
        observedAt: new Date().toISOString(),
        hookInputSessionID: input.sessionID,
        hookInputMessageID: input.messageID ?? null,
        currentMessage: {
          id: currentMessage.id,
          role: currentMessage.role,
          sessionID: currentMessage.sessionID,
          timeCreated: currentMessage.time.created,
        },
        defaultEnumeration: true,
        limitSupplied: false,
        sdkErrors: [],
      }
      const sdkErrors: string[] = []
      try {
        const identity = await client.session.get({ path: { id: input.sessionID } })
        if (identity.error || identity.data?.id !== input.sessionID) {
          sdkErrors.push("session.get could not authenticate the current chat session")
        }
        evidence.vendorSessionAtChat = identity.data ? {
          id: identity.data.id,
          directory: identity.data.directory,
          parentID: identity.data.parentID ?? null,
          time: identity.data.time,
        } : null
        const result = await client.session.messages({ path: { id: input.sessionID } })
        const messages = result.data
        evidence.messagesSdkResult = {
          httpStatus: result.response?.status ?? null,
          error: result.error ?? null,
        }
        if (result.error) sdkErrors.push(`session.messages returned an SDK error: ${JSON.stringify(result.error)}`)
        if (!Array.isArray(messages)) {
          sdkErrors.push("session.messages did not return its canonical default array")
        } else {
          const canonicalIDs = messages.flatMap((entry) => {
            if (!isRecord(entry) || !isRecord(entry.info) || typeof entry.info.id !== "string") return []
            return [entry.info.id]
          })
          evidence.canonicalMessageCount = messages.length
          evidence.canonicalMessageIDs = canonicalIDs
          evidence.currentAlreadyIncluded = canonicalIDs.includes(currentMessage.id)
          evidence.historyShape =
            messages.length === 0
              ? "empty"
              : messages.length === 1 && canonicalIDs[0] === currentMessage.id
                ? "only_current"
                : "other"
          if (canonicalIDs.length !== messages.length) {
            sdkErrors.push("session.messages returned malformed canonical message records")
          }
        }
      } catch (error) {
        const message = `chat history probe threw: ${errorText(error)}`
        sdkErrors.push(message)
        evidence.messagesSdkException = message
      }
      evidence.sdkErrors = sdkErrors
      await persist(evidencePath, evidence)
    },

    "command.execute.before": async (input) => {
      if (input.command !== commandName) return

      const evidencePath = process.env.LCA_CONTRACT_EVIDENCE
      const inputPath = process.env.LCA_CONTRACT_INPUT
      const sentinel = process.env.LCA_CONTRACT_SENTINEL
      if (!evidencePath || !inputPath || !sentinel) {
        throw new Error("SDK contract plugin is missing its isolated evidence/input/sentinel paths")
      }

      const evidence: Record<string, unknown> = {
        phase: "entered",
        hook: "command.execute.before",
        enteredAt: new Date().toISOString(),
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        sentinel,
        sdkErrors: [],
      }
      await persist(evidencePath, evidence)

      const sdkErrors: string[] = []
      let expected: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(await readFile(inputPath, "utf8"))
        if (!isRecord(parsed)) throw new Error("plugin input artifact is not a JSON object")
        expected = parsed
      } catch (error) {
        sdkErrors.push(`input artifact: ${errorText(error)}`)
      }

      evidence.expectedInput = expected
      if (input.command !== expected.command) sdkErrors.push("command differs from the Python probe input")
      if (input.sessionID !== expected.sessionID) sdkErrors.push("session ID differs from the Python probe input")

      let statusMap: unknown = null
      try {
        const result = await client.session.status()
        statusMap = result.data ?? null
        evidence.statusSdkResult = {
          data: result.data ?? null,
          error: result.error ?? null,
          httpStatus: result.response?.status ?? null,
        }
        if (result.error) sdkErrors.push(`session.status returned an SDK error: ${JSON.stringify(result.error)}`)
        if (!isRecord(result.data)) sdkErrors.push("session.status did not return its native status map")
      } catch (error) {
        const message = `session.status threw: ${errorText(error)}`
        sdkErrors.push(message)
        evidence.statusSdkException = message
      }

      let messages: unknown = null
      try {
        const result = await client.session.messages({ path: { id: input.sessionID } })
        messages = result.data ?? null
        evidence.messagesSdkResult = {
          data: result.data ?? null,
          error: result.error ?? null,
          httpStatus: result.response?.status ?? null,
          query: "default enumeration; no limit supplied",
        }
        if (result.error) sdkErrors.push(`session.messages returned an SDK error: ${JSON.stringify(result.error)}`)
        if (!Array.isArray(result.data)) sdkErrors.push("session.messages did not return its canonical default array")
      } catch (error) {
        const message = `session.messages threw: ${errorText(error)}`
        sdkErrors.push(message)
        evidence.messagesSdkException = message
      }

      const statusPresent = isRecord(statusMap) && Object.prototype.hasOwnProperty.call(statusMap, input.sessionID)
      const sessionStatus = statusPresent && isRecord(statusMap) ? statusMap[input.sessionID] : null
      const statusObservation = !statusPresent
        ? "omitted"
        : isRecord(sessionStatus) && sessionStatus.type === "idle"
          ? "explicit_idle"
          : "explicit_non_idle"
      evidence.statusMap = statusMap
      evidence.statusEntryPresent = statusPresent
      evidence.statusEntry = sessionStatus
      evidence.statusObservation = statusObservation
      evidence.messages = messages

      const entries = Array.isArray(messages) ? messages : []
      const ids = entries.flatMap((entry) => {
        if (!isRecord(entry) || !isRecord(entry.info) || typeof entry.info.id !== "string") return []
        return [entry.info.id]
      })
      const firstMessageID = expected.firstMessageID
      const firstMessage = entries.find(
        (entry) => isRecord(entry) && isRecord(entry.info) && entry.info.id === firstMessageID,
      )
      evidence.messageCount = entries.length
      evidence.messageIDs = ids
      evidence.firstMessageIDExpected = firstMessageID ?? null
      evidence.firstMessageRetained = typeof firstMessageID === "string" && ids.includes(firstMessageID)
      evidence.earliestCreatedMessage = firstMessage ?? null
      evidence.expectedMessageCount = expected.expectedMessageCount ?? null
      const expectedIDs = expected.messageIDsInCreationOrder
      if (Array.isArray(expectedIDs)) {
        evidence.expectedMessageIDsInCreationOrder = expectedIDs
        if (expectedIDs.length !== entries.length || new Set(ids).size !== ids.length) {
          sdkErrors.push("session.messages did not return a unique record for every created user message")
        }
        if (expectedIDs.some((id) => typeof id !== "string" || !ids.includes(id))) {
          sdkErrors.push("session.messages omitted one or more created user messages")
        }
      } else {
        sdkErrors.push("plugin input artifact omitted the message creation-order IDs")
      }
      if (typeof expected.expectedMessageCount === "number" && entries.length !== expected.expectedMessageCount) {
        sdkErrors.push(`session.messages returned ${entries.length} entries; expected ${expected.expectedMessageCount}`)
      }
      if (typeof firstMessageID !== "string" || !ids.includes(firstMessageID)) {
        sdkErrors.push("session.messages omitted the earliest created user message")
      }
      if (statusObservation === "explicit_non_idle") {
        sdkErrors.push("session.status reported a non-idle entry at command.execute.before")
      }

      evidence.sdkErrors = sdkErrors
      evidence.sentinelThrowAttempted = sdkErrors.length === 0
      evidence.phase = sdkErrors.length === 0 ? "sentinel-ready" : "sdk-error"
      evidence.completedAt = new Date().toISOString()
      await persist(evidencePath, evidence)

      if (sdkErrors.length > 0) {
        throw new Error(`${sentinel}: SDK hook contract checks failed: ${sdkErrors.join("; ")}`)
      }
      throw new Error(sentinel)
    },
  }
}
