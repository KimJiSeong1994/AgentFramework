// Local model serving through an OpenAI-compatible HTTP server (SGLang) instead of the Ollama CLI.
//
// `local_model.server: "sglang"` routes the `local` engine's inference to `<endpoint>/v1/chat/completions` with
// streaming. The endpoint must be loopback http (127.0.0.1, ::1 or localhost): otter never sends local-engine prompts
// off the machine. The server is started by the operator (scripts/sglang-server.sh); otter only talks to it. The
// transport mirrors the CLI transport's contract: one-shot run, bounded output, deadline, cancel, quiescent result,
// vendor-reported usage counters and a failure class, never the server's diagnostic text.
import type { CliObservedUsage, CliTransportHandle, CliTransportOptions, CliTransportResult } from "./cli-transport.ts"
import { classifyEngineFailure } from "./cli-transport.ts"
import type { EngineFailureClass, ExecutionCancelResult, ExecutionReconciliation } from "./types.ts"

export type LocalServerKind = "ollama" | "sglang"
export const DEFAULT_SGLANG_ENDPOINT = "http://127.0.0.1:30000"
const MAX_STREAM_BYTES = 16 * 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024

/** A loopback http(s) base URL with no credentials, query or fragment; returns it without a trailing slash. */
export function loopbackEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512 || /[\s\\]/u.test(value) || value.includes("?") || value.includes("#")) return undefined
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return undefined
  return url.href.replace(/\/+$/u, "")
}

/** The local server otter uses for the `local` engine: Ollama's CLI unless the config selects SGLang. */
export function localServerOf(local: { server?: string | null; endpoint?: string | null } | undefined): { kind: "ollama" } | { kind: "sglang"; endpoint: string } {
  if (local?.server !== "sglang") return { kind: "ollama" }
  return { kind: "sglang", endpoint: loopbackEndpoint(local.endpoint ?? DEFAULT_SGLANG_ENDPOINT) ?? DEFAULT_SGLANG_ENDPOINT }
}

const SAFE = {
  unreachable: "local SGLang server is not reachable; start it with scripts/sglang-server.sh",
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

/** Lists the model ids the server serves (`GET /v1/models`); empty on any failure. */
export async function listServedModels(endpoint: string, signal?: AbortSignal, timeoutMs = 3000): Promise<string[] | undefined> {
  try {
    const response = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) })
    if (!response.ok) return undefined
    const body = await response.json() as { data?: Array<{ id?: unknown }> }
    return Array.isArray(body.data) ? body.data.map(model => model.id).filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u.test(id)) : undefined
  } catch { return undefined }
}

/** A one-shot streaming chat completion against the local SGLang server, shaped like a CLI transport. */
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
      // A server started without a reasoning parser streams "<think>…</think>" as content; hold a leading block back.
      let thinkState = "unknown" as "unknown" | "inside" | "done"
      let held = ""
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
            // Tool calls are never requested; a server that emits one is refused like native tool activity.
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) return result({ status: "failed", text, quiescent: true, error: "native tool activity refused" })
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
