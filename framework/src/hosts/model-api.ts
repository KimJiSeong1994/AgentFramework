import { readFileSync } from "node:fs"
import { parseJsonc, userConfigPath } from "../config.ts"

export type ModelApiInput = {
  target: string
  model: string
  prompt: string
  maxOutputTokens: number
  timeoutSeconds: number
}

export type ModelApiAction = Readonly<ModelApiInput & {
  tool: "model_api"
  url: string
  protocol: "ollama" | "openai-compatible"
  apiKeyEnv?: string
}>

const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_TEXT_BYTES = 16 * 1024
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const targetName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u
const invalid = () => new Error("Model API configuration or request is invalid.")

export function validateModelApiInput(value: unknown): asserts value is ModelApiInput {
  if (!record(value) || typeof value.target !== "string" || !targetName.test(value.target) ||
      typeof value.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u.test(value.model) ||
      typeof value.prompt !== "string" || !value.prompt.trim() || Buffer.byteLength(value.prompt) > 16 * 1024 || value.prompt.includes("\0") ||
      !Number.isSafeInteger(value.maxOutputTokens) || (value.maxOutputTokens as number) < 1 || (value.maxOutputTokens as number) > 4096 ||
      !Number.isSafeInteger(value.timeoutSeconds) || (value.timeoutSeconds as number) < 1 || (value.timeoutSeconds as number) > 600) throw invalid()
}

function endpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\]/u.test(value)) throw invalid()
  let url: URL
  try { url = new URL(value) } catch { throw invalid() }
  if (url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#") ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:[0-9]+)?(\/|$)/u.test(value)))) throw invalid()
  return url.href
}

function target(value: unknown): Pick<ModelApiAction, "url" | "protocol" | "apiKeyEnv"> {
  if (!record(value) || Object.keys(value).some(key => !["url", "protocol", "api_key_env"].includes(key)) ||
      (value.protocol !== "ollama" && value.protocol !== "openai-compatible") ||
      (value.api_key_env !== undefined && (typeof value.api_key_env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value.api_key_env)))) throw invalid()
  return { url: endpoint(value.url), protocol: value.protocol,
    ...(value.api_key_env === undefined ? {} : { apiKeyEnv: value.api_key_env as string }) }
}

/** Resolve only the operator's user config, before approval; neither project files nor model input choose a URL or secret. */
export function prepareModelApiAction(input: ModelApiInput, configPath = userConfigPath()): ModelApiAction {
  validateModelApiInput(input)
  let config: unknown = {}
  try { config = parseJsonc(readFileSync(configPath, "utf8")) }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw invalid()
  }
  if (!record(config)) throw invalid()
  let selected: ReturnType<typeof target> | undefined
  if (Object.hasOwn(config, "model_api")) {
    const section = config.model_api
    if (!record(section) || Object.keys(section).some(key => key !== "targets") || !record(section.targets)) throw invalid()
    for (const [name, value] of Object.entries(section.targets)) {
      if (!targetName.test(name)) throw invalid()
      const parsed = target(value)
      if (name === input.target) selected = parsed
    }
  }
  if (!selected && input.target === "local") selected = { url: "http://127.0.0.1:11434/api/chat", protocol: "ollama" }
  if (!selected) throw new Error("Model API target is not configured in the user otter.jsonc.")
  return Object.freeze({ tool: "model_api", target: input.target, model: input.model, prompt: input.prompt,
    maxOutputTokens: input.maxOutputTokens, timeoutSeconds: input.timeoutSeconds, ...selected })
}

function boundedText(text: string): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= MAX_TEXT_BYTES) return text
  const suffix = "\n[model API output truncated]"
  // Decode only complete UTF-8 code points so the bound also holds after re-encoding.
  const prefix = new TextDecoder().decode(bytes.subarray(0, MAX_TEXT_BYTES - Buffer.byteLength(suffix)), { stream: true })
  return prefix + suffix
}

/** Called by the host only after approving this exact action. Aborting stops the local request, not guaranteed provider billing. */
export async function runModelApi(action: ModelApiAction, signal: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (signal.aborted) return { ok: false, error: "Model API request cancelled." }
  let combined: AbortSignal | undefined
  try {
    validateModelApiInput(action)
    const url = endpoint(action.url)
    if (action.protocol !== "ollama" && action.protocol !== "openai-compatible") throw invalid()
    const key = action.apiKeyEnv === undefined ? undefined : process.env[action.apiKeyEnv]
    if (action.apiKeyEnv !== undefined && (!key || /[\r\n\0]/u.test(key))) return { ok: false, error: "Model API credential is missing or invalid." }
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (key) headers.Authorization = `Bearer ${key}`
    combined = AbortSignal.any([signal, AbortSignal.timeout(action.timeoutSeconds * 1000)])
    const body = { model: action.model, messages: [{ role: "user", content: action.prompt }], stream: false,
      ...(action.protocol === "ollama" ? { options: { num_predict: action.maxOutputTokens } } : { max_tokens: action.maxOutputTokens }) }
    combined.throwIfAborted()
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: combined })
    if (!response.ok) {
      await response.body?.cancel()
      return { ok: false, error: `Model API returned HTTP ${response.status}.` }
    }
    if (!response.body) throw invalid()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        combined.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel()
          return { ok: false, error: "Model API response exceeded the size limit." }
        }
        chunks.push(chunk.value)
      }
    } finally { reader.releaseLock() }
    combined.throwIfAborted()
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    let text: unknown
    if (record(parsed) && !Object.hasOwn(parsed, "error")) {
      if (action.protocol === "ollama" && parsed.done === true && record(parsed.message)) text = parsed.message.content
      if (action.protocol === "openai-compatible" && Array.isArray(parsed.choices) && record(parsed.choices[0]) && record(parsed.choices[0].message)) text = parsed.choices[0].message.content
    }
    if (typeof text !== "string") return { ok: false, error: "Model API returned an invalid text response." }
    return { ok: true, text: boundedText(key ? text.replaceAll(key, "[redacted]") : text) }
  } catch {
    return { ok: false, error: signal.aborted ? "Model API request cancelled."
      : combined?.aborted ? "Model API request timed out." : "Model API request failed; check the target configuration and service." }
  }
}
