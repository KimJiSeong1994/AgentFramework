// Local model serving through an OpenAI-compatible HTTP server (SGLang or otter's MLX server) instead of the Ollama CLI.
//
// `local_model.server: "sglang"` or `"mlx"` routes the `local` engine's inference to `<endpoint>/v1/chat/completions` with
// streaming. The endpoint must be loopback http (127.0.0.1, ::1 or localhost): otter never sends local-engine prompts
// off the machine. The server is started by the operator (scripts/sglang-server.sh or scripts/mlx-server.sh); otter only talks to it. The
// transport mirrors the CLI transport's contract: one-shot run, bounded output, deadline, cancel, quiescent result,
// vendor-reported usage counters and a failure class, never the server's diagnostic text.
import type { CliObservedUsage, CliTransportHandle, CliTransportOptions, CliTransportResult } from "./cli-transport.ts"
import { classifyEngineFailure } from "./cli-transport.ts"
import type { EngineFailureClass, ExecutionCancelResult, ExecutionReconciliation } from "./types.ts"

export type LocalServerKind = "ollama" | "sglang" | "mlx"
/** An OpenAI-compatible loopback server for the local engine. */
export type HttpLocalServer = { kind: "sglang" | "mlx"; endpoint: string }

/** How a server is named to the user, and the script that starts it. */
export function localServerLabel(kind: HttpLocalServer["kind"]): string { return kind === "mlx" ? "MLX server" : "SGLang" }
export function localServerScript(kind: HttpLocalServer["kind"]): string { return kind === "mlx" ? "scripts/mlx-server.sh" : "scripts/sglang-server.sh" }
export const DEFAULT_SGLANG_ENDPOINT = "http://127.0.0.1:30000"
const MAX_STREAM_BYTES = 16 * 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024
/** Bounds on tool calls a server reports in its own `tool_calls` form (see nativeCallText). */
const MAX_NATIVE_CALLS = 8
const MAX_NATIVE_CALL_NAME_CHARS = 128
const NATIVE_REFUSED = "native tool activity refused"
/**
 * Hidden output (reasoning the server streams apart from the answer) a reply may produce before any answer text. A
 * local model can loop in its reasoning: Inkling 2 Mini twice generated the server's whole 32,768-token allowance over
 * 9 and 12 minutes and answered nothing (2026-11-24). With thinking off that much reasoning is never an answer on its
 * way; with thinking on the bound is wider.
 */
const MAX_HIDDEN_BYTES = 32 * 1024
const MAX_HIDDEN_BYTES_THINKING = 128 * 1024
/** The reply was cut off without an answer (hidden-output bound, or the server's token limit with no text). */
export const LOCAL_NO_ANSWER_ERROR = "local model produced no answer before its output limit"

/** A loopback http(s) base URL with no credentials, query or fragment; returns it without a trailing slash. */
export function loopbackEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512 || /[\s\\]/u.test(value) || value.includes("?") || value.includes("#")) return undefined
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return undefined
  return url.href.replace(/\/+$/u, "")
}

/** The local server otter uses for the `local` engine: Ollama's CLI unless the config selects SGLang or the MLX server. */
export function localServerOf(local: { server?: string | null; endpoint?: string | null } | undefined): { kind: "ollama" } | HttpLocalServer {
  if (local?.server !== "sglang" && local?.server !== "mlx") return { kind: "ollama" }
  return { kind: local.server, endpoint: loopbackEndpoint(local.endpoint ?? DEFAULT_SGLANG_ENDPOINT) ?? DEFAULT_SGLANG_ENDPOINT }
}

const SAFE = {
  unreachable: "local model server is not reachable; start it with scripts/mlx-server.sh or scripts/sglang-server.sh",
  native: "native CLI reported failure",
  malformed: "invalid native CLI output",
  incomplete: "native CLI result incomplete",
  deadline: "execution deadline elapsed",
  outputLimit: "output byte limit reached",
  callback: "output callback failed",
} as const

function counter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** OpenAI-style usage → CliObservedUsage (counters only). */
function observedUsage(value: unknown): CliObservedUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const usage = value as Record<string, unknown>
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object" ? usage.prompt_tokens_details as Record<string, unknown> : {}
  const observed: { -readonly [K in keyof CliObservedUsage]: CliObservedUsage[K] } = {}
  const input = counter(usage.prompt_tokens), output = counter(usage.completion_tokens), cached = counter(details.cached_tokens)
  if (input !== undefined) observed.inputTokens = input
  if (output !== undefined) observed.outputTokens = output
  if (cached !== undefined) observed.cachedInputTokens = cached
  return Object.keys(observed).length ? Object.freeze(observed) : undefined
}

type NativeCall = { name: string; arguments: string }

/**
 * A reply the server reported as OpenAI `tool_calls`, rewritten as the envelope text otter asks models for
 * ({"type":"tool","name":...,"input":{...}}, one per line). otter never sends `tools`, so the server runs nothing: a
 * model (Inkling 2 Mini, for one) wrote the call in its own tool-call syntax and the server parsed it out of the text.
 * The result is model text like any other reply: the host parses it and applies tool names, input schemas, policy and
 * approval exactly as for a call written as JSON. Arguments that are not a JSON object stay in the envelope as a string,
 * which the host refuses as malformed. Undefined (refused) when a call has no name.
 */
function nativeCallText(calls: Map<number, NativeCall>): string | undefined {
  const lines: string[] = []
  for (const [, call] of [...calls].sort(([left], [right]) => left - right)) {
    if (!call.name.trim()) return undefined
    let input: unknown = call.arguments
    try { input = call.arguments.trim() ? JSON.parse(call.arguments) : {} } catch { /* kept as the raw string */ }
    lines.push(JSON.stringify({ type: "tool", name: call.name, input }))
  }
  return lines.length ? lines.join("\n") : undefined
}

/** Lists the model ids the server serves (`GET /v1/models`); empty on any failure. */
export async function listServedModels(endpoint: string, signal?: AbortSignal, timeoutMs = 3000): Promise<string[] | undefined> {
  try {
    const response = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) })
    if (!response.ok) return undefined
    const body = await response.json() as { data?: Array<{ id?: unknown }> }
    return Array.isArray(body.data) ? body.data.map(model => model.id).filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u.test(id)) : undefined
  } catch { return undefined }
}

/** A one-shot streaming chat completion against the local OpenAI-compatible server, shaped like a CLI transport. */
export function createSglangTransport(options: CliTransportOptions, endpoint: string): CliTransportHandle {
  const controller = new AbortController()
  let runCalled = false
  let settled = false
  let cancelled = false

  const result = (value: CliTransportResult): CliTransportResult => { settled = true; return value }

  return {
    async run(): Promise<CliTransportResult> {
      if (runCalled) throw new TypeError("CLI transport is one-shot")
      runCalled = true
      if (cancelled) return result({ status: "cancelled", text: "", quiescent: true })
      const remaining = options.deadlineAt - Date.now()
      if (remaining <= 0) return result({ status: "failed", text: "", quiescent: true, error: SAFE.deadline })
      const timer = setTimeout(() => controller.abort("deadline"), remaining)
      let text = ""
      let outputBytes = 0
      let usage: CliObservedUsage | undefined
      let finished = false
      let failureClass: EngineFailureClass | undefined
      let hiddenBytes = 0
      let cutShort = false
      const hiddenLimit = options.localThink === true ? MAX_HIDDEN_BYTES_THINKING : MAX_HIDDEN_BYTES
      // A server started without a reasoning parser streams "<think>…</think>" as content; hold a leading block back.
      let thinkState = "unknown" as "unknown" | "inside" | "done"
      let held = ""
      const nativeCalls = new Map<number, NativeCall>()
      /** Collects streamed `tool_calls` fragments; false when they are not a bounded list of function calls. */
      const collectNativeCalls = (fragments: unknown[]): boolean => {
        for (const [position, fragment] of fragments.entries()) {
          if (!fragment || typeof fragment !== "object" || Array.isArray(fragment)) return false
          const call = fragment as Record<string, unknown>
          const index = call.index === undefined ? position : call.index
          if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= MAX_NATIVE_CALLS) return false
          const fn = call.function && typeof call.function === "object" && !Array.isArray(call.function) ? call.function as Record<string, unknown> : {}
          const slot = nativeCalls.get(index) ?? { name: "", arguments: "" }
          nativeCalls.set(index, slot)
          if (typeof fn.name === "string") slot.name += fn.name
          else if (fn.name !== undefined && fn.name !== null) return false
          if (slot.name.length > MAX_NATIVE_CALL_NAME_CHARS) return false
          const piece = typeof fn.arguments === "string" ? fn.arguments
            : fn.arguments !== undefined && fn.arguments !== null ? JSON.stringify(fn.arguments) : ""
          outputBytes += Buffer.byteLength(piece, "utf8")
          slot.arguments += piece
        }
        return true
      }
      const visible = (piece: string): string => {
        if (thinkState === "done") return piece
        held += piece
        const lead = held.trimStart()
        if (thinkState === "unknown") {
          if ("<think>".startsWith(lead) && lead.length < 7) return ""
          if (!lead.startsWith("<think>")) { thinkState = "done"; const out = held; held = ""; return out }
          thinkState = "inside"
        }
        const close = held.indexOf("</think>")
        if (close < 0) return ""
        thinkState = "done"
        const out = held.slice(close + "</think>".length).replace(/^\s+/u, "")
        held = ""
        return out
      }
      try {
        let response: Response
        try {
          response = await fetch(`${endpoint}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify({
              model: options.model,
              messages: [{ role: "user", content: options.prompt }],
              stream: true,
              stream_options: { include_usage: true },
              // Qwen3-family chat templates read enable_thinking; other models ignore it. Reasoning text is dropped below.
              chat_template_kwargs: { enable_thinking: options.localThink === true },
            }),
            signal: controller.signal,
          })
        } catch {
          if (cancelled) return result({ status: "cancelled", text: "", quiescent: true })
          if (controller.signal.reason === "deadline") return result({ status: "failed", text: "", quiescent: true, error: SAFE.deadline })
          return result({ status: "failed", text: "", quiescent: true, error: SAFE.unreachable, failureClass: "transient" })
        }
        if (!response.ok || !response.body) {
          let detail = ""
          try { detail = (await response.text()).slice(0, 4096) } catch { /* class only */ }
          failureClass = classifyEngineFailure(detail) ?? (response.status === 429 ? "rate_limited" : response.status >= 500 ? "transient" : undefined)
          return result({ status: "failed", text: "", quiescent: true, error: SAFE.native, ...(failureClass ? { failureClass } : {}) })
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder("utf-8", { fatal: true })
        let buffer = ""
        let streamBytes = 0
        const handleLine = (line: string): "continue" | "done" | CliTransportResult => {
          if (!line.startsWith("data:")) return "continue"
          const data = line.slice(5).trim()
          if (data === "[DONE]") { finished = true; return "done" }
          let event: Record<string, unknown>
          try { event = JSON.parse(data) as Record<string, unknown> } catch { return result({ status: "failed", text, quiescent: true, error: SAFE.malformed }) }
          if (event.error) {
            const message = typeof event.error === "object" && event.error ? (event.error as Record<string, unknown>).message : event.error
            failureClass = classifyEngineFailure(message)
            return result({ status: "failed", text, quiescent: true, error: SAFE.native, ...(failureClass ? { failureClass } : {}) })
          }
          if (event.usage) usage = observedUsage(event.usage) ?? usage
          const choices = Array.isArray(event.choices) ? event.choices as Array<Record<string, unknown>> : []
          for (const choice of choices) {
            const delta = choice.delta && typeof choice.delta === "object" ? choice.delta as Record<string, unknown> : {}
            // Tool calls are never requested, so a server reports one only when the model wrote it in its own syntax.
            // It is collected and handed to the host as envelope text (nativeCallText); nothing has run.
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
              if (!collectNativeCalls(delta.tool_calls)) { controller.abort("native-calls"); return result({ status: "failed", text, quiescent: true, error: NATIVE_REFUSED }) }
              if (outputBytes > options.maxOutputBytes) { controller.abort("output-limit"); return result({ status: "incomplete", text, quiescent: true, error: SAFE.outputLimit }) }
            }
            for (const hidden of [delta.reasoning_content, delta.reasoning]) {
              if (typeof hidden === "string") hiddenBytes += Buffer.byteLength(hidden, "utf8")
            }
            if (hiddenBytes > hiddenLimit && !text && nativeCalls.size === 0) {
              controller.abort("no-answer")
              return result({ status: "incomplete", text: "", quiescent: true, error: LOCAL_NO_ANSWER_ERROR })
            }
            if (choice.finish_reason === "length") cutShort = true
            if (typeof delta.content === "string" && delta.content) {
              outputBytes += Buffer.byteLength(delta.content, "utf8")
              if (outputBytes > options.maxOutputBytes) { controller.abort("output-limit"); return result({ status: "incomplete", text, quiescent: true, error: SAFE.outputLimit }) }
              const shown = visible(delta.content)
              if (shown) {
                text += shown
                try { options.onText?.(shown) }
                catch { controller.abort("callback"); return result({ status: "failed", text, quiescent: true, error: SAFE.callback }) }
              }
            }
            if (typeof choice.finish_reason === "string" && choice.finish_reason) finished = true
          }
          return "continue"
        }
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>
          try { chunk = await reader.read() }
          catch {
            if (cancelled) return result({ status: "cancelled", text, quiescent: true })
            if (controller.signal.reason === "deadline") return result({ status: "failed", text, quiescent: true, error: SAFE.deadline })
            return result({ status: "incomplete", text, quiescent: true, error: SAFE.incomplete })
          }
          if (chunk.done) break
          streamBytes += chunk.value.byteLength
          if (streamBytes > MAX_STREAM_BYTES) { controller.abort("output-limit"); return result({ status: "incomplete", text, quiescent: true, error: SAFE.outputLimit }) }
          try { buffer += decoder.decode(chunk.value, { stream: true }) }
          catch { return result({ status: "failed", text, quiescent: true, error: SAFE.malformed }) }
          for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
            const line = buffer.slice(0, newline).replace(/\r$/u, "")
            buffer = buffer.slice(newline + 1)
            const outcome = handleLine(line)
            if (outcome === "done") break
            if (outcome !== "continue") return outcome
          }
          if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) return result({ status: "failed", text, quiescent: true, error: SAFE.malformed })
        }
        if (buffer.trim()) {
          const outcome = handleLine(buffer.trim())
          if (outcome !== "continue" && outcome !== "done") return outcome
        }
        if (cancelled) return result({ status: "cancelled", text, quiescent: true })
        // An unterminated reasoning block never became an answer; a held partial "<thi" prefix was real text.
        if (thinkState === "inside") return result({ status: "incomplete", text, quiescent: true, error: SAFE.incomplete })
        if (held) { text += held; try { options.onText?.(held) } catch { return result({ status: "failed", text, quiescent: true, error: SAFE.callback }) } }
        if (!finished) return result({ status: "incomplete", text, quiescent: true, error: SAFE.incomplete })
        // The server's token limit ended the reply before any answer text or call: that is not an empty answer.
        if (cutShort && !text.trim() && nativeCalls.size === 0) return result({ status: "incomplete", text: "", quiescent: true, error: LOCAL_NO_ANSWER_ERROR })
        if (nativeCalls.size) {
          // The calls are the reply: prose the model wrote beside them is dropped, as a prose-answer role would
          // otherwise end its turn on that prose.
          const calls = nativeCallText(nativeCalls)
          if (calls === undefined) return result({ status: "failed", text, quiescent: true, error: NATIVE_REFUSED })
          try { options.onText?.(calls) } catch { return result({ status: "failed", text, quiescent: true, error: SAFE.callback }) }
          return result({ status: "completed", text: calls, quiescent: true, ...(usage ? { usage } : {}) })
        }
        return result({ status: "completed", text, quiescent: true, ...(usage ? { usage } : {}) })
      } finally {
        clearTimeout(timer)
        settled = true
      }
    },
    async requestCancel(reason: string): Promise<ExecutionCancelResult> {
      if (typeof reason !== "string" || reason.length > 512) throw new TypeError("invalid local process cancellation request")
      cancelled = true
      controller.abort("cancel")
      return { requested: true, acknowledged: true, terminal: settled || !runCalled, quiescent: true }
    },
    async reconcile(): Promise<ExecutionReconciliation> {
      // An HTTP request owns no local process; once aborted or settled nothing keeps running on this machine.
      return { outcome: settled || !runCalled ? "terminal" : "running", quiescent: true, evidence: settled || !runCalled ? "HTTP request settled" : "HTTP request in flight" }
    },
  }
}
