import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareModelApiAction, runModelApi, type ModelApiInput } from "../src/hosts/model-api.ts"

let root: string
let configPath: string
let server: ReturnType<typeof Bun.serve> | undefined
let requests: Request[]
const keyName = "OTTER_MODEL_API_TEST_SECRET"
const originalKey = process.env[keyName]
const input: ModelApiInput = { target: "local", model: "test-model:1b", prompt: "Answer briefly", maxOutputTokens: 128, timeoutSeconds: 5 }
const signal = () => new AbortController().signal

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otter-model-api-"))
  configPath = join(root, "otter.jsonc")
  requests = []
  delete process.env[keyName]
})
afterEach(() => {
  server?.stop(true)
  server = undefined
  rmSync(root, { recursive: true, force: true })
  if (originalKey === undefined) delete process.env[keyName]
  else process.env[keyName] = originalKey
})

function configured(handler: (request: Request) => Response | Promise<Response>, protocol: "ollama" | "openai-compatible" = "ollama", credential = false) {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { requests.push(request); return handler(request) } })
  const url = `http://127.0.0.1:${server.port}/${protocol === "ollama" ? "api/chat" : "v1/chat/completions"}`
  writeFileSync(configPath, JSON.stringify({ model_api: { targets: { local: { url, protocol, ...(credential ? { api_key_env: keyName } : {}) } } } }))
  return prepareModelApiAction(input, configPath)
}

describe("model API target preparation", () => {
  test("missing user config uses a frozen local target and does not read project config", () => {
    mkdirSync(join(root, ".otter"))
    writeFileSync(join(root, ".otter", "otter.jsonc"), JSON.stringify({ model_api: { targets: { local: { url: "https://example.test/chat", protocol: "ollama" } } } }))
    const action = prepareModelApiAction(input, configPath)
    expect(action.url).toBe("http://127.0.0.1:11434/api/chat")
    expect(Object.isFrozen(action)).toBe(true)
    expect(() => prepareModelApiAction({ ...input, target: "other" }, configPath)).toThrow("not configured")
  })

  test.each(["{invalid", "null", "[]", '{"model_api":null}', '{"model_api":{"targets":[]}}',
    '{"model_api":{"targets":{"local":null}}}', '{"model_api":{"targets":{"local":{"protocol":"ollama"}}}}',
    '{"model_api":{"targets":{"local":{"url":"https://example.test/api","protocol":"unknown"}}}}'])
  ("invalid user config fails closed: %s", text => {
    writeFileSync(configPath, text)
    expect(() => prepareModelApiAction(input, configPath)).toThrow("invalid")
  })

  test.each(["http://example.test/chat", "http://127.1/chat", "http://2130706433/chat", "ftp://localhost/chat", "https://user:secret@example.test/chat", "https://example.test/chat?key=secret", "https://example.test/chat#secret", "https://example.test/chat?", "https://example.test/chat#", "https://example.test/\nchat"])
  ("refuses unsafe endpoint %s", url => {
    writeFileSync(configPath, JSON.stringify({ model_api: { targets: { local: { url, protocol: "ollama" } } } }))
    expect(() => prepareModelApiAction(input, configPath)).toThrow("invalid")
  })

  test.each(["http://127.0.0.1:1234/api/chat", "http://[::1]:1234/api/chat", "http://localhost:1234/api/chat", "https://example.test/v1/chat/completions"])
  ("accepts explicit endpoint %s without sending requests", url => {
    writeFileSync(configPath, JSON.stringify({ model_api: { targets: { local: { url, protocol: "ollama", api_key_env: keyName } } } }))
    const action = prepareModelApiAction(input, configPath)
    expect(action.url).toBe(url)
    expect(action.apiKeyEnv).toBe(keyName)
    expect(Object.keys(action)).not.toContain("apiKey")
  })

  test("invalid bounds and target credentials fail before effects", () => {
    for (const patch of [{ maxOutputTokens: 0 }, { maxOutputTokens: 4097 }, { timeoutSeconds: 0 }, { timeoutSeconds: 601 },
      { prompt: "" }, { prompt: "x".repeat(16 * 1024 + 1) }, { model: "bad model" }, { target: "../local" }]) {
      expect(() => prepareModelApiAction({ ...input, ...patch }, configPath)).toThrow("invalid")
    }
    writeFileSync(configPath, JSON.stringify({ model_api: { targets: { local: { url: "https://example.test/chat", protocol: "ollama", api_key: "secret" } } } }))
    expect(() => prepareModelApiAction(input, configPath)).toThrow("invalid")
  })
})

describe("model API execution", () => {
  test("Ollama sends bounded nonstreaming text generation to the prepared target", async () => {
    let body: unknown
    const action = configured(async request => { body = await request.json(); return Response.json({ done: true, message: { content: "hello" } }) })
    writeFileSync(configPath, "invalid config changed after preparation")
    expect(await runModelApi(action, signal())).toEqual({ ok: true, text: "hello" })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe("POST")
    expect(requests[0]!.headers.get("authorization")).toBeNull()
    expect(body).toEqual({ model: input.model, messages: [{ role: "user", content: input.prompt }], stream: false, options: { num_predict: 128 } })
  })

  test("compatible API resolves its key only at execution and redacts echoed credentials", async () => {
    let body: unknown
    const action = configured(async request => { body = await request.json(); return Response.json({ choices: [{ message: { content: "secret-value returned secret-value" } }] }) }, "openai-compatible", true)
    expect(JSON.stringify(action)).not.toContain("secret-value")
    process.env[keyName] = "secret-value"
    expect(await runModelApi(action, signal())).toEqual({ ok: true, text: "[redacted] returned [redacted]" })
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer secret-value")
    expect(body).toEqual({ model: input.model, messages: [{ role: "user", content: input.prompt }], stream: false, max_tokens: 128 })
  })

  test("missing credentials and pre-aborted requests never contact the endpoint", async () => {
    const action = configured(() => Response.json({ done: true, message: { content: "unused" } }), "ollama", true)
    expect((await runModelApi(action, signal())).ok).toBe(false)
    process.env[keyName] = "secret-value"
    const abort = new AbortController()
    abort.abort()
    expect(await runModelApi(action, abort.signal)).toEqual({ ok: false, error: "Model API request cancelled." })
    expect(requests).toHaveLength(0)
  })

  test("abort during response collection cancels the pending request", async () => {
    const abort = new AbortController()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const action = configured(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"message":')); started() } })))
    const running = runModelApi(action, abort.signal)
    await ready
    abort.abort()
    expect(await running).toEqual({ ok: false, error: "Model API request cancelled." })
    expect(requests).toHaveLength(1)
  })

  test("timeout is bounded without retry", async () => {
    const action = configured(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")) } })))
    expect(await runModelApi({ ...action, timeoutSeconds: 1 }, signal())).toEqual({ ok: false, error: "Model API request timed out." })
    expect(requests).toHaveLength(1)
  })

  test("redirects are refused without forwarding prompt or authorization", async () => {
    const action = configured(() => Response.redirect(`http://127.0.0.1:${server!.port}/redirected`, 307), "ollama", true)
    process.env[keyName] = "secret-value"
    const result = await runModelApi(action, signal())
    expect(result.ok).toBe(false)
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain("secret-value")
  })

  test("HTTP errors do not expose provider bodies or retry", async () => {
    const action = configured(() => new Response("secret-value internal diagnostics", { status: 401 }), "ollama", true)
    process.env[keyName] = "secret-value"
    expect(await runModelApi(action, signal())).toEqual({ ok: false, error: "Model API returned HTTP 401." })
    expect(requests).toHaveLength(1)
  })

  test.each(["not JSON", JSON.stringify({ done: false, message: { content: "unfinished" } }), JSON.stringify({ done: true, message: { content: null } }), JSON.stringify({ error: "secret-value", done: true, message: { content: "secret-value" } })])
  ("malformed or incomplete responses fail without raw body: %s", async body => {
    const action = configured(() => new Response(body))
    const result = await runModelApi(action, signal())
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain("secret-value")
  })

  test("oversized streamed response is stopped at the byte limit", async () => {
    const action = configured(() => new Response(new ReadableStream({ start(controller) {
      for (let index = 0; index < 5; index++) controller.enqueue(new Uint8Array(64 * 1024).fill(120))
      controller.close()
    } })))
    expect(await runModelApi(action, signal())).toEqual({ ok: false, error: "Model API response exceeded the size limit." })
  })

  test("returned Unicode text is capped at 16KiB with a truncation marker", async () => {
    const action = configured(() => Response.json({ done: true, message: { content: "한".repeat(20_000) } }))
    const result = await runModelApi(action, signal())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16 * 1024)
    expect(result.text).toEndWith("[model API output truncated]")
    expect(result.text).not.toContain("�")
  })
})
