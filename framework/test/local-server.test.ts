import { afterEach, describe, expect, test } from "bun:test"
import { createCliTransport } from "../src/hosts/cli-transport.ts"
import { listServedModels, localServerOf, loopbackEndpoint } from "../src/hosts/local-server.ts"

type Server = ReturnType<typeof Bun.serve>
const servers: Server[] = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })

function sse(events: unknown[]): string {
  return events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("")
}

function fakeSglang(handler: (body: Record<string, unknown>) => Response | Promise<Response>): { endpoint: string; requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "qwen3.8-27b" }, { id: "bad id" }] })
      const body = await request.json() as Record<string, unknown>
      requests.push(body)
      return handler(body)
    },
  })
  servers.push(server)
  return { endpoint: `http://127.0.0.1:${server.port}`, requests }
}

const options = (endpoint: string, extra: Record<string, unknown> = {}) => ({
  engine: "local" as const, model: "qwen3.8-27b", prompt: "Say OK.", deadlineAt: Date.now() + 10_000, maxOutputBytes: 4096,
  localServer: { kind: "sglang" as const, endpoint }, ...extra,
})

describe("local server selection", () => {
  test("only loopback http(s) endpoints without credentials, query or fragment are accepted", () => {
    expect(loopbackEndpoint("http://127.0.0.1:30000/")).toBe("http://127.0.0.1:30000")
    expect(loopbackEndpoint("http://[::1]:30000")).toBe("http://[::1]:30000")
    expect(loopbackEndpoint("http://localhost:30000")).toBe("http://localhost:30000")
    for (const bad of ["http://10.0.0.2:30000", "http://example.com", "http://u:p@127.0.0.1:1", "http://127.0.0.1:1/?x=1", "ftp://127.0.0.1", "", 42]) {
      expect(loopbackEndpoint(bad)).toBeUndefined()
    }
    expect(localServerOf(undefined)).toEqual({ kind: "ollama" })
    expect(localServerOf({ server: "sglang" })).toEqual({ kind: "sglang", endpoint: "http://127.0.0.1:30000" })
    expect(localServerOf({ server: "sglang", endpoint: "http://127.0.0.1:31000" })).toEqual({ kind: "sglang", endpoint: "http://127.0.0.1:31000" })
    expect(localServerOf({ server: "mlx" })).toEqual({ kind: "mlx", endpoint: "http://127.0.0.1:30000" })
    expect(localServerOf({ server: "vllm" })).toEqual({ kind: "ollama" })
  })

  test("a non-loopback endpoint is refused before any request", () => {
    expect(() => createCliTransport(options("http://192.168.1.9:30000"))).toThrow()
    expect(() => createCliTransport({ ...options("http://127.0.0.1:30000"), engine: "codex", model: "gpt-6-astra" } as never)).toThrow()
  })

  test("served models come from /v1/models and malformed ids are dropped; an unreachable server lists nothing", async () => {
    const { endpoint } = fakeSglang(() => new Response("unused"))
    expect(await listServedModels(endpoint)).toEqual(["qwen3.8-27b"])
    expect(await listServedModels("http://127.0.0.1:1", undefined, 500)).toBeUndefined()
  })
})

describe("SGLang transport", () => {
  test("streams the answer, drops reasoning text, reports usage and passes the thinking switch", async () => {
    const { endpoint, requests } = fakeSglang(() => new Response(sse([
      { choices: [{ delta: { reasoning_content: "PRIVATE reasoning" } }] },
      { choices: [{ delta: { content: "{\"type\":\"final\"," } }] },
      { choices: [{ delta: { content: "\"text\":\"OK\"}" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 100 } } },
      "[DONE]",
    ]), { headers: { "content-type": "text/event-stream" } }))
    const seen: string[] = []
    const result = await createCliTransport(options(endpoint, { onText: (text: string) => seen.push(text), localThink: true })).run()
    expect(result).toEqual({ status: "completed", text: "{\"type\":\"final\",\"text\":\"OK\"}", quiescent: true, usage: { inputTokens: 120, outputTokens: 9, cachedInputTokens: 100 } })
    expect(seen.join("")).toBe(result.text)
    expect(result.text).not.toContain("PRIVATE")
    expect(requests[0]).toMatchObject({ model: "qwen3.8-27b", stream: true, messages: [{ role: "user", content: "Say OK." }], chat_template_kwargs: { enable_thinking: true } })
    expect(requests[0]).not.toHaveProperty("tools")
  })

  test("a leading <think> block streamed as content (server without a reasoning parser) is dropped", async () => {
    const { endpoint } = fakeSglang(() => new Response(sse([
      { choices: [{ delta: { content: "<thi" } }] }, { choices: [{ delta: { content: "nk>\nPRIVATE plan" } }] },
      { choices: [{ delta: { content: " more</think>\n\n{\"type\":\"final\"" } }] },
      { choices: [{ delta: { content: ",\"text\":\"OK\"}" }, finish_reason: "stop" }] }, "[DONE]",
    ])))
    const seen: string[] = []
    const result = await createCliTransport(options(endpoint, { onText: (text: string) => seen.push(text) })).run()
    expect(result).toMatchObject({ status: "completed", text: '{"type":"final","text":"OK"}' })
    expect(seen.join("")).toBe(result.text)
    const plain = fakeSglang(() => new Response(sse([{ choices: [{ delta: { content: "<b>bold</b> answer" }, finish_reason: "stop" }] }, "[DONE]"])))
    expect((await createCliTransport(options(plain.endpoint)).run()).text).toBe("<b>bold</b> answer")
    const short = fakeSglang(() => new Response(sse([{ choices: [{ delta: { content: "<th" }, finish_reason: "stop" }] }, "[DONE]"])))
    expect((await createCliTransport(options(short.endpoint)).run()).text).toBe("<th")
    const unclosed = fakeSglang(() => new Response(sse([{ choices: [{ delta: { content: "<think>never closed" }, finish_reason: "length" }] }, "[DONE]"])))
    expect(await createCliTransport(options(unclosed.endpoint)).run()).toMatchObject({ status: "incomplete", text: "" })
  })

  test("thinking is off unless requested", async () => {
    const { endpoint, requests } = fakeSglang(() => new Response(sse([{ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }, "[DONE]"])))
    await createCliTransport(options(endpoint)).run()
    expect(requests[0]!.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  test("server errors fail with a fixed message and a failure class, never the server's text", async () => {
    const busy = fakeSglang(() => new Response("SECRET overloaded: too many requests", { status: 429 }))
    const limited = await createCliTransport(options(busy.endpoint)).run()
    expect(limited).toMatchObject({ status: "failed", error: "native CLI reported failure", failureClass: "rate_limited", quiescent: true })
    expect(JSON.stringify(limited)).not.toContain("SECRET")
    const broken = fakeSglang(() => new Response(sse([{ error: { message: "SECRET internal server error" } }])))
    expect(await createCliTransport(options(broken.endpoint)).run()).toMatchObject({ status: "failed", failureClass: "transient" })
    const down = await createCliTransport(options("http://127.0.0.1:1")).run()
    expect(down).toMatchObject({ status: "failed", quiescent: true, failureClass: "transient" })
    expect(down.error).toContain("scripts/sglang-server.sh")
  })

  test("tool calls the server reports in its own form become envelope text for the host; nothing is requested or run", async () => {
    const call = (index: number, name: string | undefined, args: unknown) => ({ index, id: `call_${index}`, type: "function", function: { ...(name === undefined ? {} : { name }), arguments: args } })
    const { endpoint, requests } = fakeSglang(() => new Response(sse([
      { choices: [{ delta: { reasoning_content: "PRIVATE reasoning" } }] },
      { choices: [{ delta: { content: "I will read both files." } }] },
      { choices: [{ delta: { tool_calls: [call(0, "read", '{"path":')] } }] },
      { choices: [{ delta: { tool_calls: [call(0, undefined, '"src/cart.ts"}'), call(1, "glob", { pattern: "**/*.ts" })] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 20 } },
      "[DONE]",
    ])))
    const seen: string[] = []
    const result = await createCliTransport(options(endpoint, { onText: (text: string) => seen.push(text) })).run()
    const expected = '{"type":"tool","name":"read","input":{"path":"src/cart.ts"}}\n{"type":"tool","name":"glob","input":{"pattern":"**/*.ts"}}'
    // The calls are the whole reply: prose beside them is dropped so a prose-answer role does not end its turn on it.
    expect(result).toEqual({ status: "completed", text: expected, quiescent: true, usage: { inputTokens: 50, outputTokens: 20 } })
    expect(seen.at(-1)).toBe(expected)
    expect(requests[0]).not.toHaveProperty("tools")

    // Empty arguments are an empty input; arguments that are not a JSON object stay a string the host refuses as malformed.
    const empty = fakeSglang(() => new Response(sse([{ choices: [{ delta: { tool_calls: [call(0, "list", "")] }, finish_reason: "tool_calls" }] }, "[DONE]"])))
    expect((await createCliTransport(options(empty.endpoint)).run()).text).toBe('{"type":"tool","name":"list","input":{}}')
    const broken = fakeSglang(() => new Response(sse([{ choices: [{ delta: { tool_calls: [call(0, "read", '{"path":')] }, finish_reason: "tool_calls" }] }, "[DONE]"])))
    expect((await createCliTransport(options(broken.endpoint)).run()).text).toBe('{"type":"tool","name":"read","input":"{\\"path\\":"}')
  })

  test("native tool calls without a name, out of bounds, cut short or over the output bound are refused", async () => {
    const run = async (events: unknown[]) => await createCliTransport(options(fakeSglang(() => new Response(sse(events))).endpoint)).run()
    const fn = (index: unknown, name: unknown, args = "{}") => ({ index, function: { name, arguments: args } })
    expect(await run([{ choices: [{ delta: { tool_calls: [fn(8, "read")] } }] }, "[DONE]"])).toMatchObject({ status: "failed", error: "native tool activity refused" })
    expect(await run([{ choices: [{ delta: { tool_calls: [fn(-1, "read")] } }] }, "[DONE]"])).toMatchObject({ status: "failed", error: "native tool activity refused" })
    expect(await run([{ choices: [{ delta: { tool_calls: [fn(0, 7)] } }] }, "[DONE]"])).toMatchObject({ status: "failed", error: "native tool activity refused" })
    expect(await run([{ choices: [{ delta: { tool_calls: [fn(0, "x".repeat(129))] } }] }, "[DONE]"])).toMatchObject({ status: "failed", error: "native tool activity refused" })
    expect(await run([{ choices: [{ delta: { tool_calls: ["read"] } }] }, "[DONE]"])).toMatchObject({ status: "failed", error: "native tool activity refused" })
    // A stream that ends without a finish is incomplete; the collected call is not used.
    expect(await run([{ choices: [{ delta: { tool_calls: [fn(0, "read")] } }] }])).toMatchObject({ status: "incomplete", text: "" })
    expect(await run([{ choices: [{ delta: { tool_calls: [fn(0, "write", JSON.stringify({ content: "x".repeat(5000) }))] } }] }, "[DONE]"])).toMatchObject({ status: "incomplete", error: "output byte limit reached" })
  })

  test("a reply that spends its allowance on hidden reasoning, or hits the token limit with no text, is cut off as no answer", async () => {
    const reasoning = (bytes: number) => ({ choices: [{ delta: { reasoning_content: "r".repeat(bytes) } }] })
    const answer = { choices: [{ delta: { content: "{\"type\":\"final\",\"text\":\"OK\"}" }, finish_reason: "stop" }] }
    const run = async (events: unknown[], extra: Record<string, unknown> = {}) => await createCliTransport(options(fakeSglang(() => new Response(sse(events))).endpoint, extra)).run()
    const noAnswer = { status: "incomplete", text: "", error: "local model produced no answer before its output limit" }
    // Thinking off: over 32 KiB of reasoning with no answer text is stopped; under it the answer still arrives.
    expect(await run([reasoning(20_000), reasoning(20_000), answer, "[DONE]"])).toMatchObject(noAnswer)
    expect(await run([reasoning(20_000), answer, "[DONE]"])).toMatchObject({ status: "completed", text: '{"type":"final","text":"OK"}' })
    // Thinking on widens the bound; reasoning after the answer started is never a reason to stop.
    expect(await run([reasoning(20_000), reasoning(20_000), answer, "[DONE]"], { localThink: true })).toMatchObject({ status: "completed" })
    expect(await run([reasoning(70_000), reasoning(70_000), answer, "[DONE]"], { localThink: true })).toMatchObject(noAnswer)
    expect(await run([{ choices: [{ delta: { content: "{\"type\":" } }] }, reasoning(40_000), { choices: [{ delta: { content: "\"final\",\"text\":\"OK\"}" }, finish_reason: "stop" }] }, "[DONE]"])).toMatchObject({ status: "completed" })
    // The server's own token limit with nothing visible is the same condition; with text it stays a completed reply.
    expect(await run([reasoning(100), { choices: [{ delta: {}, finish_reason: "length" }] }, "[DONE]"])).toMatchObject(noAnswer)
    expect(await run([{ choices: [{ delta: { content: "partial answer" }, finish_reason: "length" }] }, "[DONE]"])).toMatchObject({ status: "completed", text: "partial answer" })
  })

  test("nameless tool calls, malformed events, a missing finish and the output bound are refused", async () => {
    const tool = fakeSglang(() => new Response(sse([{ choices: [{ delta: { tool_calls: [{ id: "1" }] } }] }, "[DONE]"])))
    expect(await createCliTransport(options(tool.endpoint)).run()).toMatchObject({ status: "failed", error: "native tool activity refused" })
    const malformed = fakeSglang(() => new Response("data: {not json}\n\n"))
    expect(await createCliTransport(options(malformed.endpoint)).run()).toMatchObject({ status: "failed", error: "invalid native CLI output" })
    const unfinished = fakeSglang(() => new Response(sse([{ choices: [{ delta: { content: "partial" } }] }])))
    expect(await createCliTransport(options(unfinished.endpoint)).run()).toMatchObject({ status: "incomplete", text: "partial" })
    const long = fakeSglang(() => new Response(sse([{ choices: [{ delta: { content: "x".repeat(5000) } }] }, "[DONE]"])))
    expect(await createCliTransport(options(long.endpoint)).run()).toMatchObject({ status: "incomplete", error: "output byte limit reached" })
  })

  test("cancel aborts an in-flight request; the transport is one-shot and always quiescent", async () => {
    const { endpoint } = fakeSglang(() => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(sse([{ choices: [{ delta: { content: "slow" } }] }])))
    } })))
    const transport = createCliTransport(options(endpoint))
    const running = transport.run()
    await Bun.sleep(100)
    expect(await transport.reconcile()).toMatchObject({ outcome: "running", quiescent: true })
    expect(await transport.requestCancel("test", Date.now() + 1000)).toMatchObject({ requested: true, quiescent: true })
    expect(await running).toMatchObject({ status: "cancelled", quiescent: true })
    expect(await transport.reconcile()).toMatchObject({ outcome: "terminal", quiescent: true })
    await expect(transport.run()).rejects.toThrow("one-shot")
  })

  test("the deadline bounds the request", async () => {
    const { endpoint } = fakeSglang(() => new Response(new ReadableStream({ start() {} })))
    const result = await createCliTransport(options(endpoint, { deadlineAt: Date.now() + 300 })).run()
    expect(result).toMatchObject({ status: "failed", error: "execution deadline elapsed", quiescent: true })
  })
})
