import { createHash } from "node:crypto"
import { appendFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { authenticatedSDKSessionIdentity, hasSDKSessionCreationObservation } from "../../src/sessions/sdk-transcript.ts"
import { getOwnedSession } from "../../src/sessions/store.ts"

type RecordValue = Record<string, unknown>
type NativeToolName = "skill" | "read"
type CallProof = Readonly<{
  sessionID: string
  callID: string
  assistantMessageID: string
  parentUserMessageID: string
  partID: string
  canonicalMessageCount: number
  prompt: string
  tool: NativeToolName
  args: Readonly<RecordValue>
  sessionIdentity: { id: string; directory: string; parentID: string | null }
}>

const proofs = new Map<string, CallProof>()
const key = (sessionID: string, callID: string) => `${sessionID}\u0000${callID}`
const referenceRelativePath = ".agents/skills/otter-native-contract/reference.txt"
const isRecord = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value)
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
function assertReadArgs(args: RecordValue, directory: string): void {
  requireCondition(typeof args.filePath === "string" && resolve(directory, args.filePath) === resolve(directory, referenceRelativePath),
    "native read arguments do not identify the tracked captured companion resource")
  requireCondition(Object.keys(args).every(name => name === "filePath" || name === "offset" || name === "limit"),
    "native read arguments contain an unsupported SDK field")
  requireCondition(args.offset === undefined || typeof args.offset === "number" && Number.isSafeInteger(args.offset) && args.offset >= 0,
    "native read offset differs from the SDK read contract")
  requireCondition(args.limit === undefined || typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit >= 1,
    "native read limit differs from the SDK read contract")
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`native Otter product qualification observer: ${message}`)
}

function configuredPrompts(): Record<string, string> {
  const raw = process.env.OTTER_NATIVE_PRODUCT_PROMPTS
  if (!raw) throw new Error("OTTER_NATIVE_PRODUCT_PROMPTS is not configured")
  const value: unknown = JSON.parse(raw)
  requireCondition(isRecord(value), "prompt map is not an object")
  requireCondition(typeof value.common === "string" && typeof value.changed === "string", "common and changed prompts are required")
  return value as Record<string, string>
}

async function appendEvidence(value: RecordValue): Promise<void> {
  const path = process.env.OTTER_NATIVE_PRODUCT_EVIDENCE
  if (!path) throw new Error("OTTER_NATIVE_PRODUCT_EVIDENCE is not configured")
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8")
}

function promptForText(text: string, prompts: Record<string, string>): { scenario: string; prompt: string }[] {
  return Object.entries(prompts)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && text.includes(entry[1]))
    .map(([scenario, prompt]) => ({ scenario, prompt }))
}

export default async function nativeOtterProductContractObserver(pluginInput: PluginInput): Promise<Hooks> {
  const prompts = configuredPrompts()
  let productMainPrompt: string | undefined
  let transformCount = 0
  requireCondition(pluginInput.worktree === pluginInput.directory, "observer must run in the canonical isolated project root")
  await appendEvidence({
    phase: "observer.initialized",
    pid: process.pid,
    pluginURL: import.meta.url,
    directory: pluginInput.directory,
    worktree: pluginInput.worktree,
    promptSha256: Object.fromEntries(Object.entries(prompts).map(([name, prompt]) => [name, sha256(prompt)])),
  })

  async function canonicalCall(input: { sessionID: string; callID: string }, tool: NativeToolName, args: unknown, expectedStatus: "running" | "completed"): Promise<CallProof> {
    requireCondition(isRecord(args), "native tool arguments are not an object")
    if (tool === "skill") {
      requireCondition(Object.keys(args).length === 1 && args.name === "otter-native-contract", "native skill arguments are not the exact product fixture")
    } else {
      assertReadArgs(args, pluginInput.directory)
    }
    const messagesResult = await pluginInput.client.session.messages({ path: { id: input.sessionID }, query: { directory: pluginInput.directory } })
    requireCondition(!messagesResult.error, `canonical session.messages failed: ${JSON.stringify(messagesResult.error)}`)
    requireCondition(messagesResult.response?.status === 200, "canonical session.messages did not return HTTP 200")
    const messages: unknown = messagesResult.data
    requireCondition(Array.isArray(messages), "canonical session.messages did not return an array")

    const matches: Array<{ info: RecordValue; part: RecordValue; state: RecordValue }> = []
    const parents: Array<{ info: RecordValue; text: string }> = []
    for (const message of messages) {
      if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) continue
      const info = message.info
      for (const part of message.parts) {
        if (!isRecord(part)) continue
        if (part.type === "tool" && part.callID === input.callID && isRecord(part.state)) {
          matches.push({ info, part, state: part.state })
        }
        if (info.role === "user" && part.type === "text" && part.synthetic !== true && part.ignored !== true && typeof part.text === "string") {
          for (const match of promptForText(part.text, prompts)) {
            parents.push({ info, text: match.prompt })
          }
        }
      }
    }
    requireCondition(matches.length === 1, `expected exactly one canonical tool part for ${input.callID}, got ${matches.length}`)
    const match = matches[0]!
    const { info, part, state } = match
    requireCondition(info.role === "assistant" && info.sessionID === input.sessionID, "canonical call parent is not an assistant message in the actual session")
    requireCondition(part.sessionID === input.sessionID && part.messageID === info.id && part.tool === tool, "canonical call part identity differs from the live native call")
    requireCondition(state.status === expectedStatus, `canonical tool status is ${String(state.status)}, expected ${expectedStatus}`)
    requireCondition(isRecord(state.input), "canonical tool input is not an object")
    const stateInput = state.input as Record<string, unknown>
    if (tool === "skill") {
      requireCondition(stateInput.name === "otter-native-contract" && Object.keys(stateInput).length === 1, "canonical skill input differs from the actual hook arguments")
    } else {
      assertReadArgs(stateInput, pluginInput.directory)
      requireCondition(Object.keys(args).every(name => stateInput[name] === args[name]), "canonical read input differs from the actual native read arguments")
    }
    requireCondition(typeof info.id === "string" && typeof info.parentID === "string" && typeof part.id === "string", "canonical assistant or tool-part identity is absent")
    const parent = parents.filter(candidate => candidate.info.id === info.parentID && candidate.info.sessionID === input.sessionID)
    requireCondition(parent.length === 1, "assistant tool call has no unique canonical submitted-user parent")

    const sessionResult = await pluginInput.client.session.get({ path: { id: input.sessionID }, query: { directory: pluginInput.directory } })
    requireCondition(!sessionResult.error, `canonical session.get failed: ${JSON.stringify(sessionResult.error)}`)
    requireCondition(sessionResult.response?.status === 200 && isRecord(sessionResult.data), "canonical session.get did not return HTTP 200 and a session")
    const session = sessionResult.data
    requireCondition(session.id === input.sessionID && session.directory === pluginInput.directory, "canonical native session identity or directory differs")
    requireCondition(session.parentID === undefined || session.parentID === null, "main qualification session unexpectedly has a parent session")
    const selected = promptForText(parent[0]!.text, prompts)
    requireCondition(selected.length === 1, "canonical submitted prompt does not identify exactly one qualification scenario")

    return Object.freeze({
      sessionID: input.sessionID,
      callID: input.callID,
      assistantMessageID: info.id,
      parentUserMessageID: parent[0]!.info.id as string,
      partID: part.id,
      canonicalMessageCount: messages.length,
      prompt: parent[0]!.text,
      tool,
      args: Object.freeze({ ...(tool === "read" ? state.input : args) }),
      sessionIdentity: { id: session.id as string, directory: session.directory as string, parentID: null },
    })
  }

  function sameCall(before: CallProof, after: CallProof, phase: string): void {
    requireCondition(before.sessionID === after.sessionID && before.callID === after.callID, `${phase}: native session or call ID changed`)
    requireCondition(before.assistantMessageID === after.assistantMessageID && before.parentUserMessageID === after.parentUserMessageID, `${phase}: canonical assistant parent changed`)
    requireCondition(before.partID === after.partID && before.prompt === after.prompt && before.canonicalMessageCount === after.canonicalMessageCount, `${phase}: canonical part, history cardinality or prompt identity changed`)
    requireCondition(before.tool === after.tool && JSON.stringify(before.args) === JSON.stringify(after.args), `${phase}: native tool or arguments changed`)
    requireCondition(JSON.stringify(before.sessionIdentity) === JSON.stringify(after.sessionIdentity), `${phase}: canonical session identity changed`)
  }

  return {
    "chat.message": async (input, output) => {
      const identity = authenticatedSDKSessionIdentity(pluginInput.worktree, input.sessionID)
      const store = getOwnedSession(pluginInput.worktree, input.sessionID)
      await appendEvidence({
        at: new Date().toISOString(), phase: "product.chat.message.after",
        sessionID: input.sessionID, inputMessageID: input.messageID, outputMessageID: output.message.id,
        agent: input.agent, outputAgent: output.message.agent,
        authenticatedIdentity: identity ?? null,
        createdObserved: identity ? hasSDKSessionCreationObservation(pluginInput.worktree, input.sessionID, identity) : false,
        attachedEpoch: store?.epoch ?? null,
      })
    },
    config: async (value) => {
      const config = value as unknown as { agent?: Record<string, Record<string, unknown> | undefined> }
      const main = config.agent?.main
      requireCondition(main && typeof main.prompt === "string" && main.prompt.length > 0, "actual Otter config hook did not install a main system prompt")
      requireCondition(main.system === undefined, "main agent has an explicit system prompt outside the actual Otter policy")
      productMainPrompt = main.prompt
      await appendEvidence({
        at: new Date().toISOString(),
        phase: "product.config.after",
        role: "main",
        prompt: productMainPrompt,
        promptSha256: sha256(productMainPrompt),
        skillPermission: main.permission && isRecord(main.permission) ? main.permission.skill ?? null : null,
      })
    },

    "experimental.chat.system.transform": async (input, output) => {
      requireCondition(productMainPrompt !== undefined, "the actual product main configuration was not observed before system transformation")
      requireCondition(Array.isArray(output.system), "native product system transform output is not an array")
      const system = [...output.system]
      requireCondition(system.length === 1 && system[0] === productMainPrompt, "system channel differs from the actual Otter main policy prompt")
      transformCount++
      await appendEvidence({
        at: new Date().toISOString(),
        phase: "product.system.transform.after",
        sequence: transformCount,
        sessionID: input.sessionID ?? null,
        system,
        systemSha256: sha256(JSON.stringify(system)),
        uncheckedDescriptionMarkerPresent: system.some(text => text.includes(process.env.OTTER_NATIVE_PRODUCT_VENDOR_DESCRIPTION_MARKER ?? "\u0000")),
        uncheckedBodyMarkerPresent: system.some(text => text.includes(process.env.OTTER_NATIVE_PRODUCT_VENDOR_BODY_MARKER ?? "\u0000")),
        changedBodyMarkerPresent: system.some(text => text.includes(process.env.OTTER_NATIVE_PRODUCT_CHANGED_BODY_MARKER ?? "\u0000")),
        trustedReferenceMarkerPresent: system.some(text => text.includes(process.env.OTTER_NATIVE_PRODUCT_REFERENCE_MARKER ?? "\u0000")),
      })
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "skill" && input.tool !== "read") return
      const proof = await canonicalCall(input, input.tool, output.args, "running")
      const id = key(input.sessionID, input.callID)
      requireCondition(!proofs.has(id), "actual native call ID already has an active observer proof")
      proofs.set(id, proof)
      const scenario = promptForText(proof.prompt, prompts)
      requireCondition(scenario.length === 1, "before-hook prompt does not identify one scenario")
      requireCondition(input.tool !== "read" || scenario[0]!.scenario === "common", "native read was used outside the authorized common-skill continuation")
      await appendEvidence({
        at: new Date().toISOString(),
        phase: `product.${input.tool}.execute.before.observed`,
        scenario: scenario[0]!.scenario,
        tool: input.tool,
        sessionID: proof.sessionID,
        callID: proof.callID,
        args: output.args,
        canonicalAssistantMessageID: proof.assistantMessageID,
        canonicalParentUserMessageID: proof.parentUserMessageID,
        canonicalParentExists: true,
        canonicalPartID: proof.partID,
        canonicalToolStatus: "running",
        canonicalArgs: proof.args,
        canonicalMessageCount: proof.canonicalMessageCount,
        sessionIdentity: proof.sessionIdentity,
      })
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "skill" && input.tool !== "read") return
      const id = key(input.sessionID, input.callID)
      const before = proofs.get(id)
      requireCondition(before && before.tool === input.tool, "actual native after-hook has no exact same-tool before-hook proof")
      const after = await canonicalCall(input, input.tool, input.args, "running")
      sameCall(before, after, `${input.tool}.tool.execute.after`)
      requireCondition(typeof output.output === "string", "actual product skill tool result is not text")
      const scenario = promptForText(after.prompt, prompts)
      requireCondition(scenario.length === 1, "after-hook prompt does not identify one scenario")
      requireCondition(input.tool !== "read" || scenario[0]!.scenario === "common", "native captured read was used outside the common-skill continuation")
      await appendEvidence({
        at: new Date().toISOString(),
        phase: `product.${input.tool}.execute.after.observed`,
        scenario: scenario[0]!.scenario,
        tool: input.tool,
        sessionID: after.sessionID,
        callID: after.callID,
        canonicalAssistantMessageID: after.assistantMessageID,
        canonicalParentUserMessageID: after.parentUserMessageID,
        canonicalParentExists: true,
        canonicalPartID: after.partID,
        canonicalToolStatus: "running",
        canonicalMessageCount: after.canonicalMessageCount,
        args: input.args,
        canonicalArgs: after.args,
        title: output.title,
        output: output.output,
        outputBytes: Buffer.byteLength(output.output, "utf8"),
        outputSha256: sha256(output.output),
        metadata: output.metadata,
        sessionIdentity: after.sessionIdentity,
      })
      proofs.delete(id)
    },

    event: async (input) => {
      const event = input.event as unknown
      if (!isRecord(event) || !isRecord(event.properties)) return
      if (event.type === "session.created") {
        const session = event.properties.info ?? event.properties.session
        if (isRecord(session)) {
          await appendEvidence({
            at: new Date().toISOString(),
            phase: "native.session.created",
            sessionID: session.id ?? null,
            directory: session.directory ?? null,
            parentID: session.parentID ?? null,
          })
        }
      }
    },
  }
}
