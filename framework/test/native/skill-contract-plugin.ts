import { createHash } from "node:crypto"
import { appendFile, readFile } from "node:fs/promises"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"

const SKILL_TOOL_DESCRIPTION =
  "Load the registered runtime-owned skill by its fixed identifier. Returns adapter-controlled skill text."
const OWNED_SYSTEM_PROMPT =
  "You are running an isolated skill-tool contract probe. Only text returned by the registered runtime-owned skill tool is trusted skill content. Use that tool when prompted, follow its exact instructions, and do not attempt filesystem, shell, network, or delegation actions."

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

type NativeToolProof = {
  sessionID: string
  callID: string
  assistantMessageID: string
  parentUserMessageID: string
  assistantRole: "assistant"
  parentUserRole: "user"
  canonicalParentExists: true
  partID: string
  args: { name: "skill" }
  toolStatus: string
  promptSha256: string
  canonicalMessageCount: number
  sessionIdentity: { id: string; directory: string; parentID: string | null }
  pluginDirectory: string
  pluginWorktree: string
}

function proofKey(sessionID: string, callID: string): string {
  return `${sessionID}\u0000${callID}`
}

async function appendEvidence(value: Record<string, unknown>) {
  const path = process.env.OTTER_SKILL_CONTRACT_TOOL_EVIDENCE
  if (!path) throw new Error("skill contract tool evidence path is not configured")
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8")
}

export default async function skillContractPlugin(pluginInput: PluginInput): Promise<Hooks> {
  const outputPath = process.env.OTTER_SKILL_CONTRACT_OUTPUT
  const expectedHash = process.env.OTTER_SKILL_CONTRACT_OUTPUT_SHA256
  const expectedSystemHash = process.env.OTTER_SKILL_CONTRACT_SYSTEM_SHA256
  const expectedPrompt = process.env.OTTER_SKILL_CONTRACT_PROMPT
  const uncheckedBodyMarker = process.env.OTTER_SKILL_CONTRACT_UNCHECKED_BODY_MARKER
  const uncheckedDescriptionMarker = process.env.OTTER_SKILL_CONTRACT_UNCHECKED_DESCRIPTION_MARKER
  if (!outputPath || !expectedHash || !expectedSystemHash || !expectedPrompt || !uncheckedBodyMarker || !uncheckedDescriptionMarker) {
    throw new Error("runtime-owned skill contract fixtures are not configured")
  }
  const actualSystemHash = sha256(Buffer.from(OWNED_SYSTEM_PROMPT, "utf8"))
  if (actualSystemHash !== expectedSystemHash) throw new Error("runtime-owned system fixture hash differs from harness")
  let systemTransformCount = 0
  const nativeToolProofs = new Map<string, NativeToolProof>()
  await appendEvidence({
    phase: "plugin.initialized",
    pid: process.pid,
    pluginURL: import.meta.url,
    systemSha256: actualSystemHash,
  })

  async function observeNativeToolCall(input: {
    sessionID: string
    callID: string
    tool: string
  }, args: unknown): Promise<NativeToolProof> {
    requireCondition(input.tool === "skill", "unexpected tool reached the runtime-owned skill contract hook")
    requireCondition(
      isRecord(args) && Object.keys(args).length === 1 && args.name === "skill",
      "native skill call arguments are not the exact fixed fixture schema",
    )

    const messagesResult = await pluginInput.client.session.messages({ path: { id: input.sessionID } })
    requireCondition(!messagesResult.error, `native session.messages failed: ${JSON.stringify(messagesResult.error)}`)
    requireCondition(messagesResult.response?.status === 200, "native session.messages did not return HTTP 200")
    const messages: unknown = messagesResult.data
    requireCondition(Array.isArray(messages), "native session.messages did not return canonical default history")

    const matchingParts: Array<{
      info: Record<string, unknown>
      part: Record<string, unknown>
      state: Record<string, unknown>
    }> = []
    const promptUsers: Array<{ info: Record<string, unknown>; textPart: Record<string, unknown> }> = []
    for (const message of messages) {
      if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) continue
      const info = message.info
      for (const part of message.parts) {
        if (!isRecord(part)) continue
        if (
          part.type === "tool" &&
          part.callID === input.callID &&
          isRecord(part.state)
        ) {
          matchingParts.push({ info, part, state: part.state })
        }
        if (
          info.role === "user" &&
          part.type === "text" &&
          part.synthetic !== true &&
          part.ignored !== true &&
          part.text === expectedPrompt
        ) {
          promptUsers.push({ info, textPart: part })
        }
      }
    }
    requireCondition(matchingParts.length === 1, `expected one canonical tool part for call ${input.callID}; observed ${matchingParts.length}`)
    requireCondition(promptUsers.length === 1, `expected one canonical user message matching the submitted prompt; observed ${promptUsers.length}`)

    const match = matchingParts[0]!
    const { info, part, state } = match
    const user = promptUsers[0]!
    requireCondition(info.role === "assistant", "canonical skill tool part parent message is not assistant role")
    requireCondition(info.sessionID === input.sessionID, "canonical assistant message session identity differs from hook input")
    requireCondition(part.sessionID === input.sessionID, "canonical tool part session identity differs from hook input")
    requireCondition(part.messageID === info.id, "canonical tool part message identity differs from its assistant record")
    requireCondition(part.tool === input.tool, "canonical call ID is attached to a different tool")
    requireCondition(state.status === "running", `canonical tool call was not running before adapter execution: ${String(state.status)}`)
    requireCondition(
      isRecord(state.input) && Object.keys(state.input).length === 1 && state.input.name === "skill",
      "canonical tool part input differs from native hook arguments",
    )
    requireCondition(typeof info.id === "string" && typeof info.parentID === "string", "canonical assistant message omitted its actual identity or parent")
    requireCondition(user.info.id === info.parentID, "canonical assistant parent does not identify the submitted user message")
    requireCondition(user.info.sessionID === input.sessionID && user.info.role === "user", "canonical assistant parent is not the submitted user message in this session")
    requireCondition(user.textPart.sessionID === input.sessionID, "submitted prompt text part belongs to a different session")
    requireCondition(user.textPart.messageID === user.info.id, "submitted prompt text part does not belong to the canonical parent user message")
    requireCondition(typeof user.info.id === "string", "submitted canonical user message omitted its ID")
    requireCondition(typeof part.id === "string", "canonical tool part omitted its part identity")

    const sessionResult = await pluginInput.client.session.get({ path: { id: input.sessionID } })
    requireCondition(!sessionResult.error, `native session.get failed: ${JSON.stringify(sessionResult.error)}`)
    requireCondition(sessionResult.response?.status === 200, "native session.get did not return HTTP 200")
    const session: unknown = sessionResult.data
    requireCondition(isRecord(session), "native session.get did not return the canonical session identity")
    requireCondition(typeof session.id === "string", "native session.get omitted its session ID")
    requireCondition(session.id === input.sessionID, "native session.get returned a different session ID")
    requireCondition(typeof session.directory === "string", "native session.get omitted its project directory")
    requireCondition(session.directory === pluginInput.directory, "native session directory differs from plugin-owned project directory")
    requireCondition(pluginInput.worktree === pluginInput.directory, "probe plugin directory is not the isolated project worktree")

    return {
      sessionID: input.sessionID,
      callID: input.callID,
      assistantMessageID: info.id,
      parentUserMessageID: user.info.id,
      assistantRole: "assistant",
      parentUserRole: "user",
      canonicalParentExists: true,
      partID: part.id,
      args: { name: "skill" },
      toolStatus: String(state.status),
      promptSha256: sha256(Buffer.from(promptUsers[0]!.textPart.text as string, "utf8")),
      canonicalMessageCount: messages.length,
      sessionIdentity: {
        id: session.id,
        directory: session.directory,
        parentID: typeof session.parentID === "string" ? session.parentID : null,
      },
      pluginDirectory: pluginInput.directory,
      pluginWorktree: pluginInput.worktree,
    }
  }

  function assertSameProof(expected: NativeToolProof, actual: NativeToolProof, phase: string) {
    requireCondition(actual.sessionID === expected.sessionID, `${phase}: session ID changed after native before-hook proof`)
    requireCondition(actual.callID === expected.callID, `${phase}: call ID changed after native before-hook proof`)
    requireCondition(actual.assistantMessageID === expected.assistantMessageID, `${phase}: assistant message ID changed after native before-hook proof`)
    requireCondition(actual.parentUserMessageID === expected.parentUserMessageID, `${phase}: submitted parent user message ID changed`)
    requireCondition(actual.partID === expected.partID, `${phase}: canonical tool part ID changed`)
    requireCondition(actual.toolStatus === expected.toolStatus, `${phase}: canonical tool status changed during adapter dispatch`)
    requireCondition(JSON.stringify(actual.args) === JSON.stringify(expected.args), `${phase}: canonical tool arguments changed`)
    requireCondition(actual.promptSha256 === expected.promptSha256, `${phase}: submitted user prompt identity changed`)
    requireCondition(actual.canonicalMessageCount === expected.canonicalMessageCount, `${phase}: canonical session history cardinality changed during adapter dispatch`)
    requireCondition(JSON.stringify(actual.sessionIdentity) === JSON.stringify(expected.sessionIdentity), `${phase}: session identity or directory changed`)
    requireCondition(actual.pluginDirectory === expected.pluginDirectory && actual.pluginWorktree === expected.pluginWorktree, `${phase}: plugin project directory identity changed`)
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      const before = [...output.system]
      const beforeText = before.join("\n")
      const beforeHash = sha256(Buffer.from(beforeText, "utf8"))
      output.system.splice(0, output.system.length, OWNED_SYSTEM_PROMPT)
      const afterHash = sha256(Buffer.from(output.system.join("\n"), "utf8"))
      systemTransformCount += 1
      if (afterHash !== expectedSystemHash) throw new Error("runtime-owned system replacement hash mismatch")

      await appendEvidence({
        at: new Date().toISOString(),
        phase: "experimental.chat.system.transform",
        sequence: systemTransformCount,
        sessionID: input.sessionID ?? null,
        beforeEntryCount: before.length,
        beforeSha256: beforeHash,
        beforeBytes: Buffer.byteLength(beforeText, "utf8"),
        uncheckedBodyMarkerBefore: beforeText.includes(uncheckedBodyMarker),
        uncheckedDescriptionMarkerBefore: beforeText.includes(uncheckedDescriptionMarker),
        afterEntryCount: output.system.length,
        afterSha256: afterHash,
        afterBytes: Buffer.byteLength(output.system.join("\n"), "utf8"),
        uncheckedBodyMarkerAfter: output.system.some((item) => item.includes(uncheckedBodyMarker)),
        uncheckedDescriptionMarkerAfter: output.system.some((item) => item.includes(uncheckedDescriptionMarker)),
        replacementMode: "wholesale-fixed-system-array-replacement",
      })
    },

    tool: {
      skill: tool({
        description: SKILL_TOOL_DESCRIPTION,
        args: {
          name: tool.schema.enum(["skill"]).describe("The registered runtime-owned skill identifier."),
        },
        async execute(args, context) {
          if (args.name !== "skill") throw new Error("unknown runtime-owned skill identifier")
          const nativeContext = context as typeof context & { callID?: unknown }
          requireCondition(typeof nativeContext.callID === "string", "native plugin tool context omitted the actual OpenCode callID")
          const key = proofKey(context.sessionID, nativeContext.callID)
          const proof = nativeToolProofs.get(key)
          requireCondition(proof, "runtime-owned skill adapter was invoked without a native canonical before-hook proof")
          requireCondition(context.messageID === proof.assistantMessageID, "adapter context.messageID differs from the canonical assistant tool-call message")
          requireCondition(context.directory === proof.pluginDirectory && context.worktree === proof.pluginWorktree, "adapter context project identity differs from native before-hook proof")

          const bytes = await readFile(outputPath)
          const output = bytes.toString("utf8")
          const actualHash = sha256(bytes)
          if (actualHash !== expectedHash) throw new Error("runtime-owned skill fixture changed after capture")

          await appendEvidence({
            at: new Date().toISOString(),
            phase: "adapter.execute",
            tool: "skill",
            sessionID: context.sessionID,
            messageID: context.messageID,
            callID: nativeContext.callID,
            canonicalAssistantMessageID: proof.assistantMessageID,
            parentUserMessageID: proof.parentUserMessageID,
            assistantRole: proof.assistantRole,
            parentUserRole: proof.parentUserRole,
            canonicalParentExists: proof.canonicalParentExists,
            canonicalPartID: proof.partID,
            canonicalToolStatusBeforeExecute: proof.toolStatus,
            canonicalMessageCount: proof.canonicalMessageCount,
            historyLimitSupplied: false,
            sessionIdentity: proof.sessionIdentity,
            directory: context.directory,
            worktree: context.worktree,
            args,
            output,
            outputBytes: bytes.length,
            outputSha256: actualHash,
          })
          return {
            title: "Runtime-owned skill loaded",
            output,
            metadata: { source: "runtime-owned-contract-fixture", sha256: actualHash },
          }
        },
      }),
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "skill") return
      const proof = await observeNativeToolCall(input, output.args)
      const key = proofKey(input.sessionID, input.callID)
      requireCondition(!nativeToolProofs.has(key), "duplicate native skill call ID already has an active proof")
      nativeToolProofs.set(key, proof)
      await appendEvidence({
        at: new Date().toISOString(),
        phase: "tool.execute.before",
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        args: output.args,
        canonicalCallVisibleBeforeAdapter: true,
        canonicalAssistantMessageID: proof.assistantMessageID,
        canonicalParentUserMessageID: proof.parentUserMessageID,
        canonicalAssistantRole: proof.assistantRole,
        canonicalParentUserRole: proof.parentUserRole,
        canonicalParentExists: proof.canonicalParentExists,
        canonicalPartID: proof.partID,
        canonicalToolStatus: proof.toolStatus,
        canonicalMessageCount: proof.canonicalMessageCount,
        historyLimitSupplied: false,
        canonicalPromptSha256: proof.promptSha256,
        sessionIdentity: proof.sessionIdentity,
        pluginDirectory: proof.pluginDirectory,
        pluginWorktree: proof.pluginWorktree,
      })
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "skill") return
      const key = proofKey(input.sessionID, input.callID)
      const proof = nativeToolProofs.get(key)
      requireCondition(proof, "native tool.execute.after has no matching canonical before-hook proof")
      requireCondition(
        isRecord(input.args) && Object.keys(input.args).length === 1 && input.args.name === "skill",
        "native tool.execute.after arguments differ from the fixed adapter fixture",
      )
      const afterProof = await observeNativeToolCall(input, input.args)
      assertSameProof(proof, afterProof, "tool.execute.after")
      requireCondition(output.output === (await readFile(outputPath, "utf8")), "native tool.execute.after output differs from captured runtime-owned fixture")
      await appendEvidence({
        at: new Date().toISOString(),
        phase: "tool.execute.after",
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        args: input.args,
        canonicalCallVisibleAfterAdapter: true,
        canonicalAssistantMessageID: afterProof.assistantMessageID,
        canonicalParentUserMessageID: afterProof.parentUserMessageID,
        canonicalAssistantRole: afterProof.assistantRole,
        canonicalParentUserRole: afterProof.parentUserRole,
        canonicalParentExists: afterProof.canonicalParentExists,
        sameAsBeforeHookProof: true,
        canonicalPartID: afterProof.partID,
        canonicalToolStatus: afterProof.toolStatus,
        canonicalMessageCount: afterProof.canonicalMessageCount,
        historyLimitSupplied: false,
        canonicalPromptSha256: afterProof.promptSha256,
        sessionIdentity: afterProof.sessionIdentity,
        directory: afterProof.pluginDirectory,
        worktree: afterProof.pluginWorktree,
        title: output.title,
        output: output.output,
        metadata: output.metadata,
      })
      nativeToolProofs.delete(key)
    },
  }
}
