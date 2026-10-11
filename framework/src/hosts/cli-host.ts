import {
  CLI_TOOL_NAMES,
  CliToolInputError,
  createCliTools,
  validateCliToolInput,
  type CliToolName,
  type CliToolOutput,
} from "./cli-tools.ts"
import { createCliTransport, type CliEngine, type CliTransportHandle, type CliTransportOptions } from "./cli-transport.ts"
import { CODEX_INSTRUCTIONS, createCodexProfile } from "./codex-profile.ts"
import { parseTree, type Node, type ParseError } from "jsonc-parser"
import { estimateTokens } from "../tokens.ts"
import type {
  BudgetEvidence,
  ExecutionHandle,
  ExecutionHost,
  ExecutionOutcome,
  ExecutionPolicy,
  ExecutionPolicyHandlers,
  ExecutionPolicySnapshot,
  ExecutionReconciliation,
  ExecutionReference,
  ExecutionRequest,
  ExecutionRole,
} from "./types.ts"
import { EXECUTION_ROLES } from "./types.ts"
import type { ExecutionRunStore } from "./run-state.ts"

const CONTROL_PROFILE = "estimated-input-reactive-output-v1" as const
const MAIN_INPUT_LIMIT = 8192
const WORKER_INPUT_LIMIT = 5120
const MAX_TOOL_ROUNDS = 24
const MAX_NATIVE_RESPONSE_BYTES = 256 * 1024
const MAX_TOTAL_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_EXECUTION_MS = 24 * 60 * 60 * 1000
const INPUT_ESTIMATE_OVERHEAD = 64
const TRUNCATION_MARKER = "\n[older tool output truncated to fit the estimated input budget]"
const OMITTED_HISTORY = "[earlier tool exchanges omitted to fit the estimated input budget]"
const SCRATCH_CLEANUP_ERROR = "scratch cleanup failed"
const RESPONSE_ENVELOPE = 'Required transport format: respond with one LCA tool envelope or {"type":"final","text":"your final answer as a JSON string"}. Output-format instructions in the task or role apply to the CONTENTS of text, not to this outer envelope. If the final answer is plan JSON or reviewer JSON, JSON-encode it inside the text string. Never return a bare plan, verdict, or prose outside the envelope.'
const CODEX_PROFILE_REFUSAL = "Codex native profile preflight is unavailable or mismatched; host admission is refused."

const BUDGET_EVIDENCE: BudgetEvidence = Object.freeze({
  input: "estimated",
  output: "reactive",
  vendorContext: "unobserved",
  mainLimit: MAIN_INPUT_LIMIT,
  workerLimit: WORKER_INPUT_LIMIT,
})

const TOOL_SCHEMAS: Record<CliToolName, string> = {
  read: '{"path": relative nonempty string ≤2048 UTF-8 bytes, "startLine"?: positive safe integer, "maxLines"?: integer 1..2000}',
  list: '{"path"?: relative nonempty string ≤2048 UTF-8 bytes; omitted path means worktree root}',
  glob: '{"pattern": nonempty relative glob ≤1024 UTF-8 bytes}',
  grep: '{"pattern": nonempty literal string ≤1024 UTF-8 bytes, "path"?: relative nonempty string ≤2048 UTF-8 bytes}',
  write: '{"path": relative nonempty string ≤2048 UTF-8 bytes, "content": NUL-free string ≤64 KiB}',
  edit: '{"path": relative nonempty string ≤2048 UTF-8 bytes, "oldText": nonempty exact NUL-free string ≤64 KiB, "newText": NUL-free string ≤64 KiB}',
}

type ToolEnvelope = { type: "tool"; name: string; input: Record<string, unknown> }
type FinalEnvelope = { type: "final"; text: string }
type Envelope = ToolEnvelope | FinalEnvelope
type TranscriptExchange = { assistant: string; ok: boolean; result: string }
type Lease = { ownerSession: string; instance: string; pid: number; generation: number }
type LeaseCheck = { state: "active" | "cancelled"; lease: Lease }
type CliTransportFactory = (options: CliTransportOptions) => CliTransportHandle

export type CliHostOptions = {
  engine: CliEngine
  model: string
  policy: ExecutionPolicy
  runs: ExecutionRunStore
  /** A transport factory keeps native inference replaceable in deterministic host fixtures. */
  createTransport?: CliTransportFactory
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key)) && keys.every(key => expected.includes(key))
}

/** Strict JSON syntax check that also rejects duplicate object keys and excessive nesting/nodes. */
function deterministicJson(text: string): boolean {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false })
  if (!root || errors.length > 0) return false

  let nodes = 0
  const validate = (node: Node, depth: number): boolean => {
    if (++nodes > 4096 || depth > 16) return false
    if (node.type === "object") {
      const keys = new Set<string>()
      for (const property of node.children ?? []) {
        if (property.type !== "property") return false
        const [key, value] = property.children ?? []
        if (!key || key.type !== "string" || typeof key.value !== "string" || !value || keys.has(key.value)) return false
        keys.add(key.value)
        if (!validate(value, depth + 1)) return false
      }
    } else if (node.type === "array") {
      for (const child of node.children ?? []) if (!validate(child, depth + 1)) return false
    }
    return true
  }
  return validate(root, 0)
}

function parseEnvelope(output: string): Envelope | undefined {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_NATIVE_RESPONSE_BYTES) return undefined
  let body = output.trim()
  if (body.startsWith("```")) {
    const match = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(body)
    if (!match) return undefined
    body = match[1]!
  }
  if (!deterministicJson(body)) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(body) }
  catch { return undefined }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return undefined
  if (parsed.type === "tool" && exactKeys(parsed, ["type", "name", "input"]) &&
      typeof parsed.name === "string" && isRecord(parsed.input)) {
    return { type: "tool", name: parsed.name, input: parsed.input }
  }
  if (parsed.type === "final" && exactKeys(parsed, ["type", "text"]) && typeof parsed.text === "string") {
    return { type: "final", text: parsed.text }
  }
  return undefined
}

function estimatedTokens(text: string): number {
  // Reuse the project's Gemma-calibrated heuristic; this is not cross-model token proof.
  return INPUT_ESTIMATE_OVERHEAD + estimateTokens(text)
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  if (maxBytes <= 0) return ""
  const bytes = Buffer.from(value, "utf8")
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString("utf8")
}

function renderPrompt(base: string, history: readonly TranscriptExchange[]): string {
  if (history.length === 0) return `${base}\n\n${RESPONSE_ENVELOPE}`
  const transcript = history.map((entry, index) =>
    `Exchange ${index + 1}\nAssistant tool envelope: ${entry.assistant}\nLCA tool result: ${JSON.stringify({ ok: entry.ok, [entry.ok ? "result" : "error"]: entry.result })}`,
  ).join("\n\n")
  return `${base}\n\nEarlier tool transcript:\n${transcript}\n\n${RESPONSE_ENVELOPE}`
}

function shrinkHistoryResult(result: string): string {
  const currentBytes = Buffer.byteLength(result, "utf8")
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8")
  if (result.endsWith(TRUNCATION_MARKER)) {
    const content = result.slice(0, -TRUNCATION_MARKER.length)
    if (!content) return ""
    const reduced = truncateUtf8(content, Math.floor(Buffer.byteLength(content, "utf8") * 0.6))
    const next = `${reduced}${TRUNCATION_MARKER}`
    return Buffer.byteLength(next, "utf8") < currentBytes ? next : ""
  }
  if (currentBytes <= markerBytes) return ""
  const reduced = truncateUtf8(result, Math.floor((currentBytes - markerBytes) * 0.6))
  const next = `${reduced}${TRUNCATION_MARKER}`
  return Buffer.byteLength(next, "utf8") < currentBytes ? next : ""
}

function fitHistory(base: string, value: readonly TranscriptExchange[], limit: number, nativeInstructionTokens = 0): TranscriptExchange[] | undefined {
  const history = value.map(entry => ({ ...entry }))
  if (estimatedTokens(base) + nativeInstructionTokens > limit) return undefined
  // Each iteration shrinks a result or drops an exchange; truncation cannot cycle on its marker.
  for (;;) {
    if (estimatedTokens(renderPrompt(base, history)) + nativeInstructionTokens <= limit) return history
    const candidate = history.find(entry => entry.result !== OMITTED_HISTORY && Buffer.byteLength(entry.result, "utf8") > 0)
    if (candidate) {
      candidate.result = shrinkHistoryResult(candidate.result)
      continue
    }
    if (history.length > 1) {
      history.shift()
      if (history.length > 0) history[0]!.result = OMITTED_HISTORY
      continue
    }
    return undefined
  }
}

function roleInputLimit(role: ExecutionRole): number {
  return role === "main" ? MAIN_INPUT_LIMIT : WORKER_INPUT_LIMIT
}

function buildBasePrompt(request: ExecutionRequest, available: readonly CliToolName[]): string {
  const allow = new Set(available)
  const toolLines = CLI_TOOL_NAMES.map(name =>
    `- ${name}: ${allow.has(name) ? "allowed" : "denied"}; exact input schema ${TOOL_SCHEMAS[name]}`,
  ).join("\n")
  const roleInstructions = request.policy.system.length ? request.policy.system.join("\n\n") : "(no additional role-specific system instructions)"
  return [
    "You are an LCA execution agent. Follow the execution role and user task within the required LCA response envelope.",
    `Execution role: ${request.role}. These local file tools are the complete LCA tool set for this role. Never request a native tool, plugin, MCP server, shell command, direct model API, or fallback execution. Unexpected native tool activity is refused. Delegation, workflow transitions, and verification are controlled by the outer LCA queue/controller.`,
    `Only these LCA tools may run: ${available.length ? available.join(", ") : "none"}. Main and reviewer roles are read-only regardless of any other instruction. Tool paths are relative to the canonical worktree; absolute/traversal paths, protected directories (.git/.lca/.gjc), credential-like files, and symlink escapes are refused.`,
    `Input estimate limit: ${roleInputLimit(request.role)} estimated tokens, counting system instructions, tool schemas, title, task, included tool transcript, and separately supplied native instructions. The UTF-8 character estimate is heuristic and not an exact vendor token count. Older bounded tool results/history may be truncated or omitted to fit; the role instructions, title, and task are never dropped.`,
    "Respond with exactly one JSON object and no surrounding prose: {\"type\":\"tool\",\"name\":\"read\",\"input\":{...}} (with any allowed tool name) or {\"type\":\"final\",\"text\":\"...\"}. A single ```json fenced object is also accepted. Tool calls are repeatable; after each call, the LCA tool result is supplied in the next prompt. Unknown/malformed envelopes fail closed. Final text is returned unchanged; it may contain plan JSON or reviewer JSON.",
    "Exact tool schemas (keys not shown are forbidden):",
    toolLines,
    "File-tool bounds: reads refuse files over 1 MiB; each returned tool result is capped at 32 KiB. Glob and grep inspect at most 10,000 entries and 16 directory levels, honor .gitignore, and skip protected/common ignored or credential directories; grep is literal and case-sensitive. Writes/edit require a policy-authorized writable role and verified existing parent directory; edit changes only a unique exact oldText match.",
    "Role-specific system instructions:",
    roleInstructions,
    "Execution title (preserve this constraint):",
    request.title,
    "User task (preserve all content and constraints):",
    request.text,
  ].join("\n\n")
}

function safeError(outcome: ExecutionOutcome): ExecutionOutcome {
  if (outcome.status === "failed" && !outcome.error) return { status: "failed", error: "CLI execution failed closed." }
  return outcome
}

function toolResultText(output: CliToolOutput, transformed: { result?: unknown; error?: unknown }): { ok: boolean; text: string } {
  const value = transformed.error !== undefined ? transformed.error : transformed.result
  if (typeof value === "string") {
    const marker = "\n[tool output truncated]"
    const maximum = 32 * 1024
    const text = Buffer.byteLength(value, "utf8") > maximum
      ? `${truncateUtf8(value, maximum - Buffer.byteLength(marker, "utf8"))}${marker}`
      : value
    return { ok: transformed.error === undefined && output.ok, text }
  }
  if (value === undefined) return { ok: output.ok, text: output.ok ? output.text : output.error }
  return { ok: false, text: "LCA tool result unavailable." }
}

function emptyTerminalEvidence(status: ExecutionOutcome["status"]): ExecutionReconciliation {
  if (status === "unresolved") return { outcome: "unknown", quiescent: false, evidence: "current CLI process quiescence is unknown" }
  return { outcome: "terminal", quiescent: true, evidence: "current CLI execution is terminal with no owned process remaining; process-group evidence is not OS containment" }
}

function checkRequestShape(request: ExecutionRequest): void {
  if (!request || typeof request !== "object" || typeof request.executionID !== "string" || !request.executionID ||
      typeof request.supervisorSessionID !== "string" || typeof request.taskID !== "string" ||
      typeof request.attemptID !== "string" || !Number.isSafeInteger(request.generation) || request.generation < 1 ||
      !(EXECUTION_ROLES as readonly unknown[]).includes(request.role) ||
      typeof request.cwd !== "string" || !request.cwd || typeof request.title !== "string" || typeof request.text !== "string" ||
      !Number.isSafeInteger(request.deadlineAt) || !request.policy || !Number.isSafeInteger(request.policy.maxOutputTokens) ||
      request.policy.maxOutputTokens < 1 || !request.handlers ||
      typeof request.handlers.beforeTool !== "function" || typeof request.handlers.toolResult !== "function" ||
      typeof request.handlers.assistantText !== "function") throw new Error("invalid CLI execution request")
}

export function createCliHost(options: CliHostOptions): ExecutionHost {
  if (!options || !["local", "codex", "claude"].includes(options.engine) ||
      typeof options.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(options.model) ||
      !options.policy || !options.runs) throw new TypeError("invalid CLI host options")

  let codexProfile: ReturnType<typeof createCodexProfile> | undefined
  if (options.engine === "codex") {
    try { codexProfile = createCodexProfile(options.model) }
    catch { throw new TypeError("unsupported Codex model profile") }
  }

  const transportFactory = options.createTransport ?? createCliTransport
  const currentHandles = new Map<string, { reconcile: () => Promise<ExecutionReconciliation> }>()
  const preflightTransports = new Set<CliTransportHandle>()
  const identity = Object.freeze({ engine: options.engine, profile: "legacy-unowned", controlProfile: CONTROL_PROFILE })

  async function reapPreflightTransports(): Promise<boolean> {
    for (const transport of preflightTransports) {
      let reconciliation: ExecutionReconciliation
      try { reconciliation = await transport.reconcile() }
      catch { return false }
      if (reconciliation.quiescent && !reconciliation.evidence.includes(SCRATCH_CLEANUP_ERROR)) {
        preflightTransports.delete(transport)
        continue
      }
      // Avoid an availability poll loop; a later independent call can retry after cancellation settles.
      await transport.requestCancel("unresolved Codex preflight", Date.now() + 1000).catch(() => undefined)
      try { reconciliation = await transport.reconcile() }
      catch { return false }
      if (reconciliation.quiescent && !reconciliation.evidence.includes(SCRATCH_CLEANUP_ERROR)) preflightTransports.delete(transport)
      else return false
    }
    return preflightTransports.size === 0
  }

  function checkLease(request: ExecutionRequest, fixed?: Lease): LeaseCheck {
    let status: ReturnType<ExecutionRunStore["status"]>
    try { status = options.runs.status() }
    catch { throw new Error("current execution lease is unavailable") }
    const claim = status.claim
    if (!claim || status.generation !== request.generation || claim.generation !== request.generation ||
        claim.ownerSession !== request.supervisorSessionID || !claim.instance || !Number.isSafeInteger(claim.pid) || claim.pid < 1) {
      throw new Error("current execution lease changed")
    }
    const lease: Lease = { ownerSession: claim.ownerSession, instance: claim.instance, pid: claim.pid, generation: claim.generation }
    if (fixed && (lease.ownerSession !== fixed.ownerSession || lease.instance !== fixed.instance ||
        lease.pid !== fixed.pid || lease.generation !== fixed.generation)) throw new Error("current execution lease changed")
    const matching = status.executions.filter(entry => entry.executionId === request.executionID)
    if (matching.length !== 1) throw new Error("registered execution intent is unavailable")
    const entry = matching[0]!
    if (entry.kind !== "host" || entry.engine !== options.engine || entry.profile !== "legacy-unowned" ||
        entry.controlProfile !== CONTROL_PROFILE || entry.executionId !== request.executionID ||
        entry.ownerSession !== request.supervisorSessionID || entry.generation !== request.generation ||
        entry.taskId !== request.taskID || entry.attemptId !== request.attemptID || entry.cwd !== request.cwd ||
        entry.role !== request.role || entry.policyID !== request.policy.id || entry.terminal || entry.fence) {
      throw new Error("registered execution intent changed")
    }
    return { state: entry.cancel ? "cancelled" : "active", lease }
  }

  function assertFixedPolicy(request: ExecutionRequest): void {
    let snapshot: ExecutionPolicySnapshot
    try { snapshot = options.policy.resolve(request.role) }
    catch { throw new Error("fixed execution policy is unavailable") }
    if (snapshot !== request.policy || snapshot.role !== request.role || typeof snapshot.id !== "string" || !snapshot.id ||
        !Object.isFrozen(snapshot) || !snapshot.tools || !Object.isFrozen(snapshot.tools) ||
        !Array.isArray(snapshot.tools.allowed) || !Array.isArray(snapshot.tools.denied) ||
        !Object.isFrozen(snapshot.tools.allowed) || !Object.isFrozen(snapshot.tools.denied) ||
        !Array.isArray(snapshot.system) || !Object.isFrozen(snapshot.system) ||
        !snapshot.model || snapshot.model.providerID !== options.engine || snapshot.model.modelID !== options.model ||
        snapshot.system.some(instruction => typeof instruction !== "string")) {
      throw new Error("execution policy snapshot is not fixed")
    }
    if (options.engine === "codex") {
      const nativeContext = snapshot.nativeContext
      if (!codexProfile || !nativeContext || typeof nativeContext !== "object" || Array.isArray(nativeContext) ||
          !Object.isFrozen(nativeContext) || Reflect.ownKeys(nativeContext).length !== 2 ||
          !Object.hasOwn(nativeContext, "identity") || !Object.hasOwn(nativeContext, "instructions") ||
          nativeContext.identity !== codexProfile.catalogHash || nativeContext.instructions !== CODEX_INSTRUCTIONS) {
        throw new Error("Codex native context does not match the bound profile")
      }
    } else if (snapshot.nativeContext !== undefined) {
      throw new Error("unexpected native context for selected CLI engine")
    }
  }

  return {
    identity,
    async preflight(profile) {
      const pendingProbesClear = options.engine !== "codex" || await reapPreflightTransports()
      let available = profile === identity.profile && pendingProbesClear
      let codexProfileVerified = options.engine !== "codex" && pendingProbesClear
      let candidate: CliTransportHandle | undefined
      if (pendingProbesClear) {
        try {
          // Construction is inert. Codex additionally performs an owned version-only probe.
          candidate = transportFactory({
            engine: options.engine,
            model: options.model,
            prompt: "",
            deadlineAt: Date.now() + 5000,
            maxOutputBytes: 0,
          })
          if (options.engine === "codex") {
            if (typeof candidate.preflight !== "function" || !codexProfile) {
              codexProfileVerified = false
            } else {
              const result = await candidate.preflight()
              codexProfileVerified = result.compatible && result.nativePolicyHash === codexProfile.catalogHash
            }
          }
        } catch {
          available = false
        }
      }
      if (options.engine === "codex" && candidate && !codexProfileVerified) {
        const reconciliation = await candidate.reconcile().catch(() => ({ outcome: "unknown" as const, quiescent: false, evidence: "Codex preflight state is unavailable" }))
        if (!reconciliation.quiescent) {
          preflightTransports.add(candidate)
          await candidate.requestCancel("Codex preflight did not establish compatibility", Date.now() + 1000).catch(() => undefined)
        }
      }
      available = available && codexProfileVerified
      const codexProfileBlocked = options.engine === "codex" && !codexProfileVerified
      const controls: Record<string, "supported" | "unsupported" | "unknown"> = {
        boundedInput: "unsupported",
        boundedOutput: "unsupported",
        estimatedInput: "supported",
        reactiveOutput: "supported",
        preExecutionToolPolicy: codexProfileBlocked ? "unsupported" : "supported",
        headlessPermissionRefusal: "supported",
        ownedCancellation: "supported",
        quiescenceEvidence: "supported",
        identityBinding: "supported",
        noReplayRecovery: "supported",
        readOnlyWorktree: "supported",
        serialWorkerLease: "supported",
      }
      // Quiescence is evidence about the owned native process group, never OS-level containment.
      return {
        compatible: available,
        controls,
        problems: available ? [] : [codexProfileBlocked
          ? CODEX_PROFILE_REFUSAL
          : "selected CLI executable or profile is unavailable"],
        budgetEvidence: BUDGET_EVIDENCE,
      }
    },
    async prepare(rawRequest) {
      if (options.engine === "codex" && !(await reapPreflightTransports())) {
        throw new Error("unresolved Codex preflight process; model dispatch refused")
      }
      checkRequestShape(rawRequest)
      const request: ExecutionRequest = Object.freeze({
        ...rawRequest,
        handlers: Object.freeze({ ...rawRequest.handlers }),
      })
      assertFixedPolicy(request)
      const initial = checkLease(request)
      const reference: ExecutionReference = Object.freeze({ executionID: request.executionID })
      let runPromise: Promise<ExecutionOutcome> | undefined
      let currentTransport: CliTransportHandle | undefined
      let cancelled = initial.state === "cancelled"
      let cancelReason = "execution cancelled"
      let finalReconciliation: ExecutionReconciliation | undefined
      let finalOutcome: ExecutionOutcome | undefined
      let turn = 0
      let outputBytes = 0
      const outputLimit = Math.min(MAX_TOTAL_OUTPUT_BYTES, Math.max(0, request.policy.maxOutputTokens * 4))
      const fixedLease = Object.freeze(initial.lease)
      const cancelOwnedTurn = (reason: string): void => {
        const owned = currentTransport
        if (!owned) return
        const now = Date.now()
        const deadlineAt = Math.max(now + 1, Math.min(request.deadlineAt, now + 1000))
        void owned.requestCancel(reason, deadlineAt).catch(() => {})
      }

      const setFinal = (outcome: ExecutionOutcome): ExecutionOutcome => {
        finalOutcome = safeError(outcome)
        finalReconciliation = emptyTerminalEvidence(finalOutcome.status)
        return finalOutcome
      }

      const handle: ExecutionHandle = {
        reference,
        run(): Promise<ExecutionOutcome> {
          if (runPromise) return runPromise
          runPromise = execute()
          return runPromise
        },
        async requestCancel(reason, deadlineAt) {
          if (typeof reason !== "string" || reason.length > 512 || !Number.isSafeInteger(deadlineAt) || deadlineAt < 0 ||
              deadlineAt - Date.now() > MAX_EXECUTION_MS) {
            throw new TypeError("invalid CLI cancellation request")
          }
          if (finalOutcome && !currentTransport) return {
            requested: false,
            acknowledged: false,
            terminal: finalReconciliation?.outcome === "terminal",
            quiescent: finalReconciliation?.quiescent ?? false,
            evidence: "current execution is already terminal",
          }
          if (deadlineAt <= Date.now()) return {
            requested: false,
            acknowledged: false,
            terminal: !runPromise,
            quiescent: !runPromise,
            evidence: "cancellation deadline elapsed before request",
          }
          if (currentTransport) {
            const owned = currentTransport
            const result = await owned.requestCancel(reason, deadlineAt)
            if (result.requested) {
              cancelled = true
              cancelReason = "execution cancelled"
            }
            return result
          }
          cancelled = true
          cancelReason = "execution cancelled"
          if (!runPromise) return { requested: true, acknowledged: true, terminal: true, quiescent: true, evidence: "cancellation prevented model dispatch" }
          return { requested: true, acknowledged: true, terminal: false, quiescent: false, evidence: "no native turn is active; subsequent turns are prevented" }
        },
        async reconcile() {
          if (currentTransport) {
            const owned = currentTransport
            let reconciliation: ExecutionReconciliation
            try { reconciliation = await owned.reconcile() }
            catch { return { outcome: "unknown", quiescent: false, evidence: "current owned CLI process state is unavailable" } }
            if (reconciliation.quiescent && !reconciliation.evidence.includes(SCRATCH_CLEANUP_ERROR) && currentTransport === owned) {
              currentTransport = undefined
              if (finalOutcome) finalReconciliation = reconciliation
            }
            return reconciliation
          }
          if (finalReconciliation) return finalReconciliation
          if (runPromise) return { outcome: "running", quiescent: false, evidence: "CLI host loop is between native turns" }
          return { outcome: "terminal", quiescent: true, evidence: "execution has not been dispatched by this host handle" }
        },
      }

      if (currentHandles.has(request.executionID)) throw new Error("execution ID is already owned by this CLI host")
      currentHandles.set(request.executionID, { reconcile: () => handle.reconcile() })
      while (currentHandles.size > 128) currentHandles.delete(currentHandles.keys().next().value!)

      async function execute(): Promise<ExecutionOutcome> {
        try {
          if (cancelled) return setFinal({ status: "cancelled", error: cancelReason })
          const currentLease = checkLease(request, fixedLease)
          if (currentLease.state === "cancelled") return setFinal({ status: "cancelled", error: "execution cancellation requested" })
          const tools = createCliTools({
            root: request.cwd,
            role: request.role,
            allowed: request.policy.tools.allowed,
            denied: request.policy.tools.denied,
            beforeEffect() {
              if (cancelled || Date.now() >= request.deadlineAt) throw new Error("execution is no longer active")
              const lease = checkLease(request, fixedLease)
              if (lease.state !== "active") throw new Error("execution is no longer active")
              assertFixedPolicy(request)
            },
          })
          const basePrompt = buildBasePrompt(request, tools.available)
          const inputLimit = roleInputLimit(request.role)
          const nativeInstructionTokens = request.policy.nativeContext ? estimateTokens(request.policy.nativeContext.instructions) : 0
          if (estimatedTokens(basePrompt) + nativeInstructionTokens > inputLimit) return setFinal({ status: "failed", error: "estimated input budget exceeded before model dispatch" })
          const history: TranscriptExchange[] = []
          const callSession = request.executionID
          let toolCalls = 0

          for (turn = 0; turn < MAX_TOOL_ROUNDS + 1; turn++) {
            if (cancelled) return setFinal({ status: "cancelled", error: cancelReason })
            if (Date.now() >= request.deadlineAt) return setFinal({ status: "failed", error: "execution deadline elapsed before the next model turn" })
            assertFixedPolicy(request)
            const lease = checkLease(request, fixedLease)
            if (lease.state === "cancelled") return setFinal({ status: "cancelled", error: "execution cancellation requested" })
            const fitted = fitHistory(basePrompt, history, inputLimit, nativeInstructionTokens)
            if (!fitted) return setFinal({ status: "failed", error: "estimated input budget exceeded; task and role constraints were preserved" })
            history.splice(0, history.length, ...fitted)
            const prompt = renderPrompt(basePrompt, history)
            if (estimatedTokens(prompt) + nativeInstructionTokens > inputLimit) return setFinal({ status: "failed", error: "estimated input budget exceeded" })
            const remainingOutputBytes = outputLimit - outputBytes
            if (remainingOutputBytes <= 0) return setFinal({ status: "failed", error: "reactive output byte limit reached" })

            let assistantPart = 0
            let callbackFailure: string | undefined
            let transport: CliTransportHandle
            try {
              transport = transportFactory({
                engine: options.engine,
                model: options.model,
                prompt,
                deadlineAt: request.deadlineAt,
                maxOutputBytes: remainingOutputBytes,
                onText(text) {
                  if (callbackFailure) return
                  try {
                    if (cancelled || checkLease(request, fixedLease).state === "cancelled") {
                      cancelled = true
                      throw new Error("execution cancelled")
                    }
                    assertFixedPolicy(request)
                    if (Date.now() >= request.deadlineAt) throw new Error("deadline")
                    outputBytes += Buffer.byteLength(text, "utf8")
                    const decision = request.handlers.assistantText({
                      type: "text",
                      sessionID: callSession,
                      partID: `${request.executionID}:turn:${turn}:text:${++assistantPart}`,
                      text,
                      final: false,
                    })
                    if (decision.cancel) {
                      cancelled = true
                      cancelReason = "execution cancelled by LCA policy"
                      callbackFailure = "policy-cancelled"
                      throw new Error(callbackFailure)
                    }
                    if (outputBytes > outputLimit) throw new Error("reactive output byte limit reached")
                  } catch (error) {
                    callbackFailure ??= error instanceof Error && error.message === "policy-cancelled" ? "policy-cancelled"
                      : error instanceof Error && error.message === "current execution lease changed" ? "lease-changed"
                      : "assistant output rejected"
                    cancelOwnedTurn("assistant output callback refused")
                    throw new Error("assistant output rejected")
                  }
                },
              })
            } catch {
              return setFinal({ status: "failed", error: "CLI inference transport could not be prepared" })
            }
            currentTransport = transport
            if (options.engine === "codex") {
              let preflight: Awaited<ReturnType<NonNullable<CliTransportHandle["preflight"]>>> | undefined
              try {
                if (typeof transport.preflight === "function") preflight = await transport.preflight()
              } catch { /* Treat probe errors as an admission refusal; do not launch inference. */ }
              if (!preflight?.compatible || preflight.nativePolicyHash !== codexProfile?.catalogHash) {
                let reconciliation: ExecutionReconciliation | undefined
                try { reconciliation = await transport.reconcile() }
                catch { reconciliation = undefined }
                if (reconciliation?.quiescent && !reconciliation.evidence.includes(SCRATCH_CLEANUP_ERROR) && currentTransport === transport) currentTransport = undefined
                if (cancelled) {
                  const outcome = setFinal({ status: reconciliation?.quiescent ? "cancelled" : "unresolved", error: "Codex version/profile probe did not permit inference" })
                  finalReconciliation = reconciliation ?? { outcome: "unknown", quiescent: false, evidence: "Codex version/profile probe state is unresolved" }
                  return outcome
                }
                if (!reconciliation?.quiescent) {
                  const outcome = setFinal({ status: "unresolved", error: "Codex version/profile probe is unresolved; inference was not launched" })
                  finalReconciliation = reconciliation ?? { outcome: "unknown", quiescent: false, evidence: "Codex version/profile probe state is unresolved" }
                  return outcome
                }
                return setFinal({ status: "failed", error: "Codex version/profile probe refused inference" })
              }
              if (cancelled || checkLease(request, fixedLease).state === "cancelled") {
                cancelled = true
                const reconciliation = await transport.reconcile().catch(() => undefined)
                if (reconciliation?.quiescent && !reconciliation.evidence.includes(SCRATCH_CLEANUP_ERROR) && currentTransport === transport) currentTransport = undefined
                const outcome = setFinal({ status: reconciliation?.quiescent ? "cancelled" : "unresolved", error: "execution cancellation requested" })
                finalReconciliation = reconciliation ?? { outcome: "unknown", quiescent: false, evidence: "Codex version probe state is unresolved" }
                return outcome
              }
              if (Date.now() >= request.deadlineAt) {
                const reconciliation = await transport.reconcile().catch(() => undefined)
                if (reconciliation?.quiescent && !reconciliation.evidence.includes(SCRATCH_CLEANUP_ERROR) && currentTransport === transport) currentTransport = undefined
                const outcome = setFinal({ status: reconciliation?.quiescent ? "failed" : "unresolved", error: "execution deadline elapsed before inference" })
                finalReconciliation = reconciliation ?? { outcome: "unknown", quiescent: false, evidence: "Codex version probe state is unresolved" }
                return outcome
              }
              assertFixedPolicy(request)
            }
            let native: Awaited<ReturnType<CliTransportHandle["run"]>> | undefined
            try { native = await transport.run() }
            catch { native = undefined }
            if (!native) {
              let reconciliation: ExecutionReconciliation | undefined
              try { reconciliation = await transport.reconcile() }
              catch { reconciliation = undefined }
              if (reconciliation?.quiescent && !reconciliation.evidence.includes(SCRATCH_CLEANUP_ERROR) && currentTransport === transport) currentTransport = undefined
              if (cancelled && reconciliation?.outcome === "terminal" && reconciliation.quiescent) {
                const outcome = setFinal({ status: "cancelled", error: cancelReason })
                finalReconciliation = reconciliation
                return outcome
              }
              if (reconciliation?.outcome === "terminal" && reconciliation.quiescent) {
                const outcome = setFinal({ status: "failed", error: "CLI inference turn failed after reaching terminal quiescence" })
                finalReconciliation = reconciliation
                return outcome
              }
              const outcome = setFinal({ status: "unresolved", error: "CLI inference result is unresolved" })
              if (reconciliation?.quiescent) finalReconciliation = reconciliation
              return outcome
            }
            if (!native.quiescent) return setFinal({ status: "unresolved", error: "CLI inference process quiescence is unproven" })
            if (native.error !== SCRATCH_CLEANUP_ERROR && currentTransport === transport) currentTransport = undefined
            if (native.status === "unresolved") {
              const outcome = setFinal({ status: "unresolved", error: "CLI inference result is unresolved after process quiescence" })
              finalReconciliation = { outcome: "unknown", quiescent: true, evidence: "CLI inference result is unresolved after process quiescence" }
              return outcome
            }
            if (cancelled || native.status === "cancelled") return setFinal({ status: "cancelled", error: cancelReason })
            if (callbackFailure === "lease-changed") return setFinal({ status: "failed", error: "current execution lease changed; execution stopped" })
            if (callbackFailure) return setFinal({ status: "failed", error: "assistant output policy rejected the native response" })
            if (native.status !== "completed") {
              return setFinal({ status: "failed", error: "CLI inference turn failed or exceeded its output bound" })
            }
            if (Date.now() >= request.deadlineAt) return setFinal({ status: "failed", error: "execution deadline elapsed" })
            assertFixedPolicy(request)
            let finalTextDecision: ReturnType<ExecutionPolicyHandlers["assistantText"]>
            try {
              finalTextDecision = request.handlers.assistantText({
                type: "text",
                sessionID: callSession,
                partID: `${request.executionID}:turn:${turn}:final`,
                text: "",
                final: true,
              })
            } catch {
              return setFinal({ status: "failed", error: "assistant output policy failed closed" })
            }
            if (finalTextDecision.cancel) return setFinal({ status: "cancelled", error: "execution cancelled by LCA policy" })
            const afterInference = checkLease(request, fixedLease)
            if (afterInference.state === "cancelled") return setFinal({ status: "cancelled", error: "execution cancellation requested" })
            const envelope = parseEnvelope(native.text)
            if (!envelope) return setFinal({ status: "failed", error: "malformed CLI response; no fallback execution was attempted" })
            if (envelope.type === "final") return setFinal({ status: "completed", text: envelope.text })
            if (!CLI_TOOL_NAMES.includes(envelope.name as CliToolName)) return setFinal({ status: "failed", error: "unknown LCA tool refused; no fallback execution was attempted" })
            if (toolCalls >= MAX_TOOL_ROUNDS) return setFinal({ status: "failed", error: "LCA tool round limit reached" })
            const name = envelope.name as CliToolName
            try { validateCliToolInput(name, envelope.input) }
            catch (error) {
              if (error instanceof CliToolInputError) return setFinal({ status: "failed", error: "malformed LCA tool input refused" })
              return setFinal({ status: "failed", error: "malformed LCA tool input refused" })
            }
            if (!request.policy.tools.allowed.includes(name) || request.policy.tools.denied.includes(name) ||
                ((request.role === "main" || request.role === "reviewer") && (name === "write" || name === "edit"))) {
              return setFinal({ status: "failed", error: "LCA tool denied by role policy before effects" })
            }
            if (cancelled) return setFinal({ status: "cancelled", error: cancelReason })
            const beforeLease = checkLease(request, fixedLease)
            if (beforeLease.state === "cancelled") return setFinal({ status: "cancelled", error: "execution cancellation requested" })
            const callID = `${request.executionID}:tool:${toolCalls + 1}`
            const event = { type: "tool-before" as const, sessionID: callSession, callID, toolID: `lca:${name}`, name, input: envelope.input }
            let decision: ReturnType<ExecutionPolicyHandlers["beforeTool"]>
            try { decision = request.handlers.beforeTool(event) }
            catch { return setFinal({ status: "failed", error: "LCA pre-execution tool policy failed closed" }) }
            if (!decision.allow) return setFinal({ status: "failed", error: "LCA pre-execution tool policy denied the tool" })
            const canonicalAssistant = JSON.stringify({ type: "tool", name, input: envelope.input })
            const prospective = fitHistory(basePrompt, [...history, { assistant: canonicalAssistant, ok: true, result: "" }], inputLimit, nativeInstructionTokens)
            if (!prospective) return setFinal({ status: "failed", error: "tool call would exceed the estimated input budget; no effect was performed" })
            history.splice(0, history.length, ...prospective)
            if (cancelled) return setFinal({ status: "cancelled", error: cancelReason })
            const beforeEffect = checkLease(request, fixedLease)
            if (beforeEffect.state === "cancelled") return setFinal({ status: "cancelled", error: "execution cancellation requested" })
            assertFixedPolicy(request)

            let output: CliToolOutput
            try { output = tools.execute(name, envelope.input) }
            catch { return setFinal({ status: "failed", error: "LCA tool input or implementation failed closed" }) }
            const resultEvent = {
              type: "tool-result" as const,
              sessionID: callSession,
              callID,
              toolID: `lca:${name}`,
              name,
              ...(output.ok ? { result: output.text } : { error: output.error }),
            }
            let transformed: ReturnType<ExecutionPolicyHandlers["toolResult"]>
            try { transformed = request.handlers.toolResult(resultEvent) }
            catch { return setFinal({ status: "failed", error: "LCA tool-result policy failed closed" }) }
            const result = toolResultText(output, transformed)
            history[history.length - 1] = { assistant: canonicalAssistant, ok: result.ok, result: result.text }
            const afterTool = fitHistory(basePrompt, history, inputLimit, nativeInstructionTokens)
            if (!afterTool) return setFinal({ status: "failed", error: "tool result exceeded the estimated input budget" })
            history.splice(0, history.length, ...afterTool)
            toolCalls++
            const afterEffectLease = checkLease(request, fixedLease)
            if (afterEffectLease.state === "cancelled" || cancelled) return setFinal({ status: "cancelled", error: cancelReason })
          }
          return setFinal({ status: "failed", error: "LCA tool round limit reached" })
        } catch (error) {
          if (cancelled) return setFinal({ status: "cancelled", error: cancelReason })
          return setFinal({ status: "failed", error: error instanceof Error && error.message === "current execution lease changed"
            ? "current execution lease changed; execution stopped" : "CLI host execution failed closed" })
        }
      }

      return handle
    },
    async reconcile(reference) {
      if (!reference || typeof reference !== "object" || typeof reference.executionID !== "string" ||
          Object.keys(reference).some(key => key !== "executionID")) {
        return { outcome: "unknown", quiescent: false, evidence: "persisted CLI reference is not sufficient to reconcile execution" }
      }
      const current = currentHandles.get(reference.executionID)
      if (!current) return { outcome: "unknown", quiescent: false, evidence: "no current owned CLI process evidence; replay is refused" }
      try { return await current.reconcile() }
      catch { return { outcome: "unknown", quiescent: false, evidence: "current owned CLI process state is unavailable" } }
    },
  }
}
