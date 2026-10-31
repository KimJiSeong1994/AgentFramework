import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG, type OtterConfig } from "../src/config.ts"
import { createCliTools } from "../src/hosts/cli-tools.ts"
import type { CliTransportOptions, CliTransportResult } from "../src/hosts/cli-transport.ts"
import { memoryCommand, type MemoryCommandStore } from "../src/hosts/memory-command.ts"
import {
  cancelMemoryPrefetch, formatMemoryRecall, memoryCatalog, memoryCliPrompt, memoryLatency, memoryToolText, parseCliDistribution,
  recallMemory, resetMemoryRecallState, resolveMemoryEngine, startMemoryPrefetch, takeMemoryPrefetch, type MemoryEngine,
} from "../src/wiki/recall.ts"

// Real loopback HTTP with a controlled Jev answer; these tests check the contract, not model accuracy.
let root: string
let outside: string
let server: ReturnType<typeof Bun.serve>
let requests: any[]
let handler: (body: any) => Response | Promise<Response>
let memory: OtterConfig["memory"]

const CACHE = "concepts/cache.md"
const BUDGET = "concepts/budget.md"
const ROUTER = "entities/router.md"

function page(path: string, text: string) {
  const full = join(root, "knowledge", "wiki", path)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, text)
}

/** A valid distribution over exactly the asked labels; unspecified labels share the remainder. */
function answer(body: any, given: Record<string, number>, choice?: string) {
  const labels = Object.keys(body.questions.memory.criteria)
  const rest = labels.filter((label) => !Object.hasOwn(given, label))
  const left = 1 - Object.values(given).reduce((a, b) => a + b, 0)
  const probabilities = Object.fromEntries(labels.map((label) => [label, given[label] ?? left / rest.length]))
  const top = choice ?? labels.reduce((a, b) => probabilities[a]! >= probabilities[b]! ? a : b)
  return Response.json({ model: "openjev-0.1", answers: { memory: { type: "choice", choice: top, probabilities, confidence: probabilities[top] ?? 0.5 } } })
}

beforeEach(() => {
  resetMemoryRecallState()
  root = mkdtempSync(join(tmpdir(), "otter-memory-"))
  outside = mkdtempSync(join(tmpdir(), "otter-memory-outside-"))
  page("index.md", [
    "# 지식 위키 색인", "", "## 개념", "",
    `- [컨텍스트와 프롬프트 캐시](${CACHE}) — 프리픽스 안정성·요약.`,
    `- [예산](${BUDGET}) — 프리픽스 토큰 예산.`,
    `- [중복](${CACHE}) — 같은 페이지는 한 번만.`,
    "- [없는 페이지](concepts/missing.md) — 실제 파일이 없다.",
    "", "## 엔터티", "",
    `- [라우터](${ROUTER}) — 스킬 추천.`,
    "", "## 캡처 산출물", "",
    "- [보고서](reports/tool-outcomes.md) — 기계 산출물.",
    "- [출처](sources/documents-abc.md) — 등록 문서.",
  ].join("\n"))
  page(CACHE, "# 컨텍스트와 프롬프트 캐시\n\n[색인](../index.md)\n\n시스템 프롬프트 앞부분의 시간 문자열은 캐시 재사용을 줄인다.\n")
  page(BUDGET, "# 예산\n\n툴 포함 8K 토큰 이하.\n")
  page(ROUTER, "# 라우터\n\n추천은 권한이 아니다.\n")
  page("reports/tool-outcomes.md", "# 보고서\n")
  requests = []
  handler = (body) => answer(body, { [CACHE]: 0.7, [BUDGET]: 0.2, none: 0.05 })
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const body = await request.json()
    requests.push(body)
    return handler(body)
  } })
  // The fixture pins the loopback Jev fake; the product default (`auto`) would run a real vendor CLI.
  memory = { ...DEFAULT_CONFIG.memory, engine: "jev", prefetch: false, endpoint: `http://127.0.0.1:${server.port}`, timeout_ms: 2000 }
})

afterEach(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe("memory catalog", () => {
  test("is the index's concepts/entities links to real pages, deduplicated, in index order", () => {
    expect(memoryCatalog(root)).toEqual([
      { path: CACHE, title: "컨텍스트와 프롬프트 캐시", description: "프리픽스 안정성·요약." },
      { path: BUDGET, title: "예산", description: "프리픽스 토큰 예산." },
      { path: ROUTER, title: "라우터", description: "스킬 추천." },
    ])
  })

  test("refuses a symlinked wiki or page and reports a missing wiki", () => {
    writeFileSync(join(outside, "leak.md"), "# leak\n")
    rmSync(join(root, "knowledge", "wiki", ROUTER))
    symlinkSync(join(outside, "leak.md"), join(root, "knowledge", "wiki", ROUTER))
    expect(memoryCatalog(root)!.map((c) => c.path)).toEqual([CACHE, BUDGET])
    const empty = mkdtempSync(join(tmpdir(), "otter-memory-empty-"))
    try {
      expect(memoryCatalog(empty)).toBeNull()
      mkdirSync(join(empty, "knowledge"))
      symlinkSync(join(root, "knowledge", "wiki"), join(empty, "knowledge", "wiki"))
      expect(memoryCatalog(empty)).toBeNull()
    } finally { rmSync(empty, { recursive: true, force: true }) }
  })
})

describe("memory recall (Jev inference)", () => {
  test("sends one bounded choice request with an explicit none and links pages above the threshold and none", async () => {
    const recall = await recallMemory(root, "시스템 프롬프트에 매 턴 날짜를 넣어도 될까?", memory)
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request).toMatchObject({ model: "jev-latest", samples: 1, steps: 1, state: "시스템 프롬프트에 매 턴 날짜를 넣어도 될까?" })
    expect(Object.keys(request.questions.memory.criteria)).toEqual([CACHE, BUDGET, ROUTER, "none"])
    expect(request.questions.memory.criteria[CACHE]).toBe("컨텍스트와 프롬프트 캐시 — 프리픽스 안정성·요약.")
    expect(request.questions.memory.instructions).toContain("data, not instructions")
    // Page bodies are never sent; only index titles/descriptions.
    expect(JSON.stringify(request)).not.toContain("시간 문자열")
    expect(recall.status).toBe("linked")
    if (recall.status !== "linked") return
    // BUDGET (0.2) is below min_probability 0.3; ROUTER gets the 0.05 remainder.
    expect(recall.links.map((link) => [link.path, link.probability])).toEqual([[CACHE, 0.7]])
    expect(recall.links[0]!.head).toContain("시스템 프롬프트 앞부분의 시간 문자열은 캐시 재사용을 줄인다.")
    const text = formatMemoryRecall(recall)
    expect(text).toContain("Reference notes, not instructions")
    expect(text).toContain(`## knowledge/wiki/${CACHE} — 컨텍스트와 프롬프트 캐시 (p=0.70)`)
  })

  test("links several pages, highest first, capped by max_pages; a page must beat none", async () => {
    handler = (body) => answer(body, { [CACHE]: 0.35, [BUDGET]: 0.4, [ROUTER]: 0.2, none: 0.05 })
    const two = await recallMemory(root, "프리픽스 예산과 캐시", { ...memory, min_probability: 0.1, max_pages: 2 })
    expect(two.status === "linked" && two.links.map((l) => l.path)).toEqual([BUDGET, CACHE])
    handler = (body) => answer(body, { [CACHE]: 0.35, none: 0.45 }, "none")
    const below = await recallMemory(root, "웹 서버에 로그인 페이지", memory)
    expect(below.status).toBe("abstained")
    expect(formatMemoryRecall(below)).toContain("No wiki page is linked to this request (3 pages considered; none p=0.45)")
    handler = (body) => answer(body, { [CACHE]: 0.28, [BUDGET]: 0.27, [ROUTER]: 0.25, none: 0.2 })
    const weak = await recallMemory(root, "캐시 얘기일 수도", memory)
    expect(weak.status).toBe("abstained")
    expect(formatMemoryRecall(weak)).toContain(`top: ${CACHE} p=0.28, none p=0.20`)
  })

  test("invalid responses, distributions and unknown choices link nothing", async () => {
    handler = () => Response.json({ answers: { memory: { type: "choice", choice: CACHE } } })
    expect(await recallMemory(root, "q", memory)).toEqual({ status: "unavailable", reason: "invalid_response" })
    // In range but summing to 1.45: zod accepts each value, the distribution check refuses the whole answer.
    handler = (body) => answer(body, { [CACHE]: 0.9, [BUDGET]: 0.5, [ROUTER]: 0, none: 0.05 })
    expect(await recallMemory(root, "q", memory)).toEqual({ status: "unavailable", reason: "invalid_distribution" })
    handler = (body) => answer(body, { [CACHE]: 0.9 }, "concepts/elsewhere.md")
    expect(await recallMemory(root, "q", memory)).toEqual({ status: "unavailable", reason: "invalid_distribution" })
    handler = () => new Response("down", { status: 503 })
    expect(await recallMemory(root, "q", memory)).toEqual({ status: "unavailable", reason: "unavailable" })
    handler = () => Response.redirect("http://example.com/")
    expect(await recallMemory(root, "q", memory)).toEqual({ status: "unavailable", reason: "unavailable" })
  })

  test("refuses before inference: config, endpoint, input bounds, credentials, missing wiki", async () => {
    expect(await recallMemory(root, "q", { ...memory, timeout_ms: 1 })).toEqual({ status: "unavailable", reason: "invalid_config" })
    for (const endpoint of ["http://localhost:8080", "https://127.0.0.1/", "http://u:p@127.0.0.1/", "http://127.0.0.1/x"]) {
      expect(await recallMemory(root, "q", { ...memory, endpoint })).toEqual({ status: "unavailable", reason: "invalid_endpoint" })
    }
    for (const query of ["", "   ", "x".repeat(2001)]) {
      expect(await recallMemory(root, query, memory)).toEqual({ status: "unavailable", reason: "input_bound" })
    }
    expect(await recallMemory(root, "use key sk-test-not-a-real-key-000", memory)).toEqual({ status: "unavailable", reason: "sensitive_input" })
    const empty = mkdtempSync(join(tmpdir(), "otter-memory-empty-"))
    try { expect(await memoryToolText(empty, "q", memory)).toContain("No memory: knowledge/wiki/index.md does not exist") }
    finally { rmSync(empty, { recursive: true, force: true }) }
    expect(requests).toHaveLength(0)
  })

  test.each(["concepts", "knowledge", "root"])("recall refuses %s ancestor substitution during inference", async level => {
    writeFileSync(join(outside, "cache.md"), "# External\nPRIVATE_OUTSIDE_CONTENT")
    mkdirSync(join(outside, "wiki", "concepts"), { recursive: true })
    writeFileSync(join(outside, "wiki", "concepts", "cache.md"), "# External\nPRIVATE_OUTSIDE_CONTENT")
    mkdirSync(join(outside, "knowledge", "wiki", "concepts"), { recursive: true })
    writeFileSync(join(outside, "knowledge", "wiki", "concepts", "cache.md"), "# External\nPRIVATE_OUTSIDE_CONTENT")
    let saved: string | undefined
    handler = body => {
      const target = level === "root" ? root : level === "knowledge" ? join(root, "knowledge") : join(root, "knowledge", "wiki", "concepts")
      saved = `${target}-original`
      renameSync(target, saved)
      symlinkSync(outside, target)
      return answer(body, { [CACHE]: 0.9, none: 0.1 })
    }
    try {
      const result = await recallMemory(root, "cache", memory)
      expect(result.status).toBe("abstained")
      expect(JSON.stringify(result)).not.toContain("PRIVATE_OUTSIDE_CONTENT")
    } finally {
      if (level === "root" && saved) { rmSync(root); renameSync(saved, root) }
    }
  })

  test("times out, honors cancellation, and admits one inference at a time", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    handler = async (body) => { await held; return answer(body, { [CACHE]: 0.9 }) }
    const first = recallMemory(root, "first", memory)
    await Bun.sleep(50)
    expect(await recallMemory(root, "second", memory)).toEqual({ status: "unavailable", reason: "busy" })
    const cancel = new AbortController()
    cancel.abort()
    release()
    expect((await first).status).toBe("linked")
    expect(await recallMemory(root, "cancelled", memory, cancel.signal)).toEqual({ status: "unavailable", reason: "aborted" })
    handler = async (body) => { await Bun.sleep(1500); return answer(body, { [CACHE]: 0.9 }) }
    expect(await recallMemory(root, "slow", { ...memory, timeout_ms: 1000 })).toEqual({ status: "unavailable", reason: "aborted" })
    expect(formatMemoryRecall({ status: "unavailable", reason: "aborted" })).toContain("Read knowledge/wiki/index.md directly")
  })
})

describe("memory recall (Claude/Codex/Ollama CLI engines)", () => {
  /** Fake Otter CLI transport: records options, replies with fixed text or status. */
  function fakeTransport(reply: (options: CliTransportOptions) => Partial<CliTransportResult> | Promise<Partial<CliTransportResult>>) {
    const calls: CliTransportOptions[] = []
    const cancels: string[] = []
    const factory = (options: CliTransportOptions) => {
      calls.push(options)
      return {
        async run(): Promise<CliTransportResult> { return { status: "completed", text: "", quiescent: true, ...(await reply(options)) } },
        async requestCancel(reason: string) { cancels.push(reason); return { requested: true } as never },
        async reconcile() { return { outcome: "terminal", quiescent: true, evidence: "fake" } as never },
      }
    }
    return { calls, cancels, factory }
  }
  const distribution = (given: Record<string, number>) => JSON.stringify({ probabilities: { [CACHE]: 0, [BUDGET]: 0, [ROUTER]: 0, none: 0, ...given } })

  test("local recall refreshes retention without forwarding it to cloud models", async () => {
    mkdirSync(join(root, ".otter"), { recursive: true })
    const path = join(root, ".otter", "otter.jsonc")
    const fake = fakeTransport(() => ({ text: distribution({ none: 1 }) }))
    const run = (engine: "local" | "claude" = "local") => recallMemory(root, "q", { ...memory, engine, model: engine === "local" ? "native" : "haiku" }, undefined, { transport: fake.factory, fresh: true })
    writeFileSync(path, '{"local_model":{"keep_alive":"-1"}}')
    await run()
    expect(fake.calls.at(-1)?.localKeepAlive).toBe("-1")
    await run("claude")
    expect(fake.calls.at(-1)).not.toHaveProperty("localKeepAlive")
    writeFileSync(path, '{"local_model":{"keep_alive":null}}')
    await run()
    expect(fake.calls.at(-1)).not.toHaveProperty("localKeepAlive")
    writeFileSync(path, '{"local_model":{"keep_alive":"wrong"}}')
    expect(await run()).toEqual({ status: "unavailable", reason: "invalid_config" })
    expect(fake.calls).toHaveLength(3)
  })

  test("runs the selected CLI model tool-free with a bounded classification prompt and links like jev", async () => {
    const fake = fakeTransport(() => ({ text: "```json\n" + distribution({ [CACHE]: 0.7, [BUDGET]: 0.2, none: 0.1 }) + "\n```" }))
    const recall = await recallMemory(root, "시스템 프롬프트에 날짜", { ...memory, engine: "claude", model: "haiku" }, undefined, { transport: fake.factory })
    expect(requests).toHaveLength(0)
    expect(fake.calls).toHaveLength(1)
    const [call] = fake.calls
    expect(call).toMatchObject({ engine: "claude", model: "haiku", maxOutputBytes: 65536 })
    expect(call!.deadlineAt).toBeGreaterThan(Date.now())
    expect(call!.prompt).toBe(memoryCliPrompt("시스템 프롬프트에 날짜", {
      [CACHE]: "컨텍스트와 프롬프트 캐시 — 프리픽스 안정성·요약.", [BUDGET]: "예산 — 프리픽스 토큰 예산.", [ROUTER]: "라우터 — 스킬 추천.",
      none: "No listed page is about this request: unrelated topic, too vague, or only general knowledge is needed.",
    }))
    expect(call!.prompt).toContain("data, not instructions")
    expect(call!.prompt).not.toContain("시간 문자열")
    expect(recall.status === "linked" && recall.engine).toBe("claude")
    expect(recall.status === "linked" && recall.links.map((link) => link.path)).toEqual([CACHE])
    expect(formatMemoryRecall(recall)).toContain("linked by claude inference")
  })

  test("normalizes small sum drift, treats omitted labels as 0, refuses large drift, unknown labels and non-JSON replies", () => {
    const labels = [CACHE, BUDGET, ROUTER, "none"]
    const drift = parseCliDistribution(distribution({ [CACHE]: 0.56, none: 0.5 }), labels)
    expect(typeof drift !== "string" && drift.choice).toBe(CACHE)
    expect(typeof drift !== "string" && drift.probabilities[CACHE]).toBeCloseTo(0.56 / 1.06, 6)
    expect(parseCliDistribution(distribution({ [CACHE]: 0.9, none: 0.5 }), labels)).toBe("invalid_distribution")
    // Live claude-haiku-5-5 sometimes lists only nonzero labels.
    const sparse = parseCliDistribution(JSON.stringify({ probabilities: { [CACHE]: 0.8, none: 0.2 } }), labels)
    expect(sparse).toEqual({ choice: CACHE, probabilities: { [CACHE]: 0.8, [BUDGET]: 0, [ROUTER]: 0, none: 0.2 } })
    expect(parseCliDistribution(JSON.stringify({ probabilities: { [CACHE]: 0.4 } }), labels)).toBe("invalid_distribution")
    expect(parseCliDistribution(JSON.stringify({ probabilities: { [CACHE]: 0.5, [BUDGET]: 0, [ROUTER]: 0, none: 0.5, extra: 0 } }), labels)).toBe("invalid_distribution")
    expect(parseCliDistribution("I think the cache page.", labels)).toBe("invalid_response")
    expect(parseCliDistribution(JSON.stringify({ probabilities: { [CACHE]: 2, [BUDGET]: 0, [ROUTER]: 0, none: 0 } }), labels)).toBe("invalid_response")
  })

  test("maps CLI failure, cancellation and invalid replies to unavailable without a fallback", async () => {
    const failed = fakeTransport(() => ({ status: "failed", error: "native CLI reported failure" }))
    expect(await recallMemory(root, "q", { ...memory, engine: "claude", model: "haiku" }, undefined, { transport: failed.factory })).toEqual({ status: "unavailable", reason: "unavailable" })
    const prose = fakeTransport(() => ({ text: "no idea" }))
    expect(await recallMemory(root, "q", { ...memory, engine: "local", model: "llama3.2:3b" }, undefined, { transport: prose.factory })).toEqual({ status: "unavailable", reason: "invalid_response" })
    const slow = fakeTransport(async () => { await Bun.sleep(1500); return { text: distribution({ [CACHE]: 1 }) } })
    expect(await recallMemory(root, "q", { ...memory, engine: "claude", model: "haiku", timeout_ms: 1000 }, undefined, { transport: slow.factory })).toEqual({ status: "unavailable", reason: "aborted" })
    expect(slow.cancels).toEqual(["memory recall cancelled"])
    expect(requests).toHaveLength(0)
  })

  test("engine off and invalid models refuse before any inference", async () => {
    const fake = fakeTransport(() => ({ text: distribution({ [CACHE]: 1 }) }))
    const run = (patch: Partial<OtterConfig["memory"]>) => recallMemory(root, "q", { ...memory, ...patch }, undefined, { transport: fake.factory })
    expect(await run({ engine: "off" })).toEqual({ status: "unavailable", reason: "off" })
    expect(formatMemoryRecall({ status: "unavailable", reason: "off" })).toContain("select an engine with /memory")
    expect(await run({ engine: "local" })).toEqual({ status: "unavailable", reason: "invalid_model" })
    expect(await run({ engine: "claude", model: "--dangerously-skip-permissions" })).toEqual({ status: "unavailable", reason: "invalid_model" })
    expect(await run({ engine: "codex", model: "not-a-codex-slug" })).toEqual({ status: "unavailable", reason: "invalid_model" })
    expect(await run({ engine: "bogus" as MemoryEngine })).toEqual({ status: "unavailable", reason: "invalid_config" })
    expect(fake.calls).toHaveLength(0)
    expect(await memoryToolText(root, "q", undefined)).toContain("the `memory` config block is invalid")
  })
})

describe("default engine: auto over installed vendor CLIs, no local server needed", () => {
  const only = (...installed: string[]) => (engine: string) => installed.includes(engine)

  test("auto picks claude (claude-haiku-5-5), else codex (gpt-5.6-luna), else reports engine_missing", () => {
    expect(DEFAULT_CONFIG.memory).toMatchObject({ engine: "auto", prefetch: true, timeout_ms: 30_000 })
    expect(DEFAULT_CONFIG.memory.model).toBeUndefined()
    expect(resolveMemoryEngine({ engine: "auto" }, only("claude", "codex"))).toEqual({ ok: true, engine: "claude", model: "claude-haiku-5-5", auto: true })
    expect(resolveMemoryEngine({ engine: "auto" }, only("codex"))).toEqual({ ok: true, engine: "codex", model: "gpt-5.6-luna", auto: true })
    expect(resolveMemoryEngine({ engine: "auto" }, only("local"))).toEqual({ ok: false, reason: "engine_missing" })
    // A model valid only for the other vendor is not forced onto the picked one.
    expect(resolveMemoryEngine({ engine: "auto", model: "gpt-5.6-sol" }, only("claude"))).toMatchObject({ engine: "claude", model: "gpt-5.6-sol" })
    expect(resolveMemoryEngine({ engine: "auto", model: "sonnet" }, only("codex"))).toMatchObject({ engine: "codex", model: "gpt-5.6-luna" })
  })

  test("pinned claude/codex use the built-in model when unset and refuse a missing CLI before any run", () => {
    expect(resolveMemoryEngine({ engine: "claude" }, only("claude"))).toEqual({ ok: true, engine: "claude", model: "claude-haiku-5-5", auto: false })
    expect(resolveMemoryEngine({ engine: "codex" }, only("codex"))).toEqual({ ok: true, engine: "codex", model: "gpt-5.6-luna", auto: false })
    expect(resolveMemoryEngine({ engine: "codex", model: "gpt-5.6-sol" }, only("codex"))).toMatchObject({ model: "gpt-5.6-sol" })
    expect(resolveMemoryEngine({ engine: "claude" }, only("codex"))).toEqual({ ok: false, reason: "engine_missing" })
    expect(resolveMemoryEngine({ engine: "local" }, only("local"))).toEqual({ ok: false, reason: "invalid_model" })
    expect(resolveMemoryEngine({ engine: "jev" }, only())).toEqual({ ok: true, engine: "jev", auto: false })
  })

  test("auto runs the picked CLI through the transport and names it; no CLI means a clear refusal, not a fallback", async () => {
    const calls: CliTransportOptions[] = []
    const transport = (options: CliTransportOptions) => {
      calls.push(options)
      return {
        async run(): Promise<CliTransportResult> { return { status: "completed", quiescent: true, text: JSON.stringify({ probabilities: { [CACHE]: 0.9, [BUDGET]: 0, [ROUTER]: 0, none: 0.1 } }) } },
        async requestCancel() { return {} as never },
        async reconcile() { return {} as never },
      }
    }
    const auto = { ...memory, engine: "auto" as const }
    const viaCodex = await recallMemory(root, "프롬프트 날짜", auto, undefined, { transport, available: only("codex") })
    expect(calls.map((c) => [c.engine, c.model])).toEqual([["codex", "gpt-5.6-luna"]])
    expect(viaCodex.status === "linked" && viaCodex.engine).toBe("codex")
    expect(formatMemoryRecall(viaCodex)).toContain("linked by codex inference")
    const none = await recallMemory(root, "다른 요청", auto, undefined, { transport, available: only() })
    expect(none).toEqual({ status: "unavailable", reason: "engine_missing" })
    expect(formatMemoryRecall(none)).toContain("auto needs the claude or codex CLI on PATH")
    expect(calls).toHaveLength(1)
    expect(requests).toHaveLength(0)
  })
})

describe("recall speed: score cache, latency samples, prefetch", () => {
  test("an identical request reuses cached scores; a changed index or engine re-infers; page openings are re-read", async () => {
    const first = await recallMemory(root, "프롬프트 날짜", memory)
    expect(requests).toHaveLength(1)
    page(CACHE, "# 컨텍스트와 프롬프트 캐시\n\n갱신된 본문.\n")
    const second = await recallMemory(root, "  프롬프트 날짜  ", memory)
    expect(requests).toHaveLength(1)
    expect(second.status === "linked" && second.links[0]!.head).toBe("갱신된 본문.")
    expect(first.status === "linked" && first.links[0]!.head).not.toBe("갱신된 본문.")
    await recallMemory(root, "프롬프트 날짜", memory, undefined, { fresh: true })
    expect(requests).toHaveLength(2)
    page("index.md", `# 색인\n\n- [컨텍스트와 프롬프트 캐시](${CACHE}) — 설명이 바뀜.\n- [예산](${BUDGET}) — 프리픽스 토큰 예산.\n`)
    await recallMemory(root, "프롬프트 날짜", memory)
    expect(requests).toHaveLength(3)
    handler = () => new Response("down", { status: 503 })
    expect((await recallMemory(root, "실패는 캐시하지 않음", memory)).status).toBe("unavailable")
    expect((await recallMemory(root, "실패는 캐시하지 않음", memory)).status).toBe("unavailable")
    expect(requests).toHaveLength(5)
  })

  test("records inference latency per engine, excluding cache hits and pre-inference refusals", async () => {
    await recallMemory(root, "a", memory)
    await recallMemory(root, "a", memory)
    await recallMemory(root, "", memory)
    handler = () => new Response("down", { status: 503 })
    await recallMemory(root, "b", memory)
    const stats = memoryLatency("jev")
    expect(stats).toMatchObject({ samples: 2, ok: 1 })
    expect(stats.medianMs).toBeGreaterThanOrEqual(0)
    expect(memoryLatency("claude", "haiku").samples).toBe(0)
  })

  test("an already cancelled consumer aborts prefetch immediately", async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    handler = async body => { await held; return answer(body, { [CACHE]: 0.9 }) }
    expect(startMemoryPrefetch(root, "cancelled-prefetch", "cache", { ...memory, prefetch: true })).toBe(true)
    const signal = AbortSignal.abort()
    try {
      expect(await takeMemoryPrefetch("cancelled-prefetch", signal)).toBeUndefined()
      expect(await takeMemoryPrefetch("cancelled-prefetch")).toBeUndefined()
    } finally { release() }
  })

  test("prefetch is opt-in, runs once per turn, is consumed by the first memory call, and is cancelled by a newer turn", async () => {
    expect(startMemoryPrefetch(root, "s1", "프롬프트 날짜", memory)).toBe(false)
    expect(await takeMemoryPrefetch("s1")).toBeUndefined()
    const on = { ...memory, prefetch: true }
    expect(startMemoryPrefetch(root, "s1", "프롬프트 날짜", on)).toBe(true)
    // The agent's own wording is not re-inferred: the first call takes the user-turn recall.
    const text = await memoryToolText(root, "에이전트가 바꾼 문장", on, undefined, { prefetchSession: "s1" })
    expect(text).toContain(`knowledge/wiki/${CACHE}`)
    expect(requests.map((r) => r.state)).toEqual(["프롬프트 날짜"])
    await memoryToolText(root, "두 번째 질문", on, undefined, { prefetchSession: "s1" })
    expect(requests.map((r) => r.state)).toEqual(["프롬프트 날짜", "두 번째 질문"])

    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    handler = async (body) => { await held; return answer(body, { [CACHE]: 0.9 }) }
    startMemoryPrefetch(root, "s2", "오래된 턴", on)
    await Bun.sleep(30)
    cancelMemoryPrefetch("s2")
    expect(await takeMemoryPrefetch("s2")).toBeUndefined()
    release()
    await Bun.sleep(30)
    // A failed prefetch is not reused: the agent's query still runs.
    handler = () => new Response("down", { status: 503 })
    startMemoryPrefetch(root, "s3", "실패할 턴", on)
    handler = (body) => answer(body, { [BUDGET]: 0.8 })
    await Bun.sleep(30)
    const fallback = await memoryToolText(root, "예산 질문", on, undefined, { prefetchSession: "s3" })
    expect(fallback).toContain(`knowledge/wiki/${BUDGET}`)
    expect(startMemoryPrefetch(root, "s4", "x", { ...on, engine: "off" })).toBe(false)
  })
})

describe("/memory command", () => {
  function store(initial: Partial<OtterConfig["memory"]>, project?: Partial<OtterConfig["memory"]>, extra: Partial<MemoryCommandStore> = {}) {
    let user = { ...DEFAULT_CONFIG.memory, ...initial }
    const saved: Array<[MemoryEngine, string | undefined]> = []
    const value: MemoryCommandStore = {
      read: () => project ? { ...DEFAULT_CONFIG.memory, ...project } : user,
      resolve: (m) => resolveMemoryEngine(m, (engine) => engine !== "local" || true),
      save: (engine, model) => {
        saved.push([engine, model])
        const { model: _drop, ...rest } = user
        user = { ...rest, engine, ...(model ? { model } : {}) }
        return "/home/u/.config/otter/otter.jsonc"
      },
      ...extra,
    }
    return { value, saved }
  }

  test("shows, selects and validates engines, warning about remote vendors", async () => {
    const s = store({ engine: "jev", prefetch: false })
    expect(await memoryCommand([], root, s.value)).toBe("Memory engine: jev (local OpenJev server at memory.endpoint)")
    expect(await memoryCommand(["claude"], root, s.value)).toBe(
      "Saved memory engine claude / claude-haiku-5-5 — sends the request text and wiki index titles/descriptions to Anthropic to /home/u/.config/otter/otter.jsonc; it applies to the next memory call.")
    expect(await memoryCommand(["codex", "gpt-5.6-sol"], root, s.value)).toContain("codex / gpt-5.6-sol — sends the request text and wiki index titles/descriptions to OpenAI")
    expect(await memoryCommand(["auto"], root, s.value)).toContain("Saved memory engine auto → claude / claude-haiku-5-5")
    expect(await memoryCommand(["show"], root, s.value)).toContain("auto → claude / claude-haiku-5-5")
    expect(await memoryCommand(["local", "llama3.2:3b"], root, s.value)).toContain("local / llama3.2:3b (local Ollama)")
    expect(await memoryCommand(["off"], root, s.value)).toContain("Saved memory engine off")
    expect(s.saved).toEqual([["claude", undefined], ["codex", "gpt-5.6-sol"], ["auto", undefined], ["local", "llama3.2:3b"], ["off", undefined]])
    expect(await memoryCommand(["local"], root, s.value)).toContain("local needs an Ollama model ID")
    expect(await memoryCommand(["auto", "x"], root, s.value)).toContain("Usage: /memory")
    expect(await memoryCommand(["jev", "x"], root, s.value)).toContain("Usage: /memory")
    expect(await memoryCommand(["codex", "nope"], root, s.value)).toBe("memory.model is not a bundled Codex model slug: nope")
    expect(await memoryCommand(["gpt"], root, s.value)).toContain("Usage: /memory")
    expect(s.saved).toHaveLength(5)
    const noCli = store({ engine: "auto" }, undefined, { resolve: (m) => resolveMemoryEngine(m, () => false) })
    expect(await memoryCommand([], root, noCli.value)).toContain("auto — no usable CLI on PATH (install and log in to claude or codex)")
  })

  test("reports a project override instead of claiming the switch took effect", async () => {
    const s = store({ engine: "jev" }, { engine: "off" })
    expect(await memoryCommand(["claude", "haiku"], root, s.value)).toContain("The project .otter/otter.jsonc overrides it: effective engine off")
  })

  test("show includes latency observed in this process", async () => {
    await recallMemory(root, "a", memory)
    const s = store({ engine: "jev", prefetch: true })
    expect(await memoryCommand(["show"], root, s.value)).toMatch(/Observed in this process: 1 call\(s\), 1 answered, median \d+\.\d s; prefetch on\./)
  })

  test("test measures one fresh recall and names swap pressure as the cause of a slow Jev", async () => {
    const slowJev = store({ engine: "jev" }, undefined, {
      probe: async () => { await Bun.sleep(5); return { status: "abstained", engine: "jev", candidates: 3, scores: { choice: "none", probabilities: { none: 1 } } } },
      swapUse: () => 0.98,
    })
    const realNow = performance.now.bind(performance)
    let calls = 0
    performance.now = () => realNow() + (calls++ === 0 ? 0 : 60_000)
    try {
      const report = await memoryCommand(["test"], root, slowJev.value)
      expect(report).toContain("Memory test: jev (local OpenJev server at memory.endpoint) answered (no page linked) in 60.")
      expect(report).toContain("Swap is 98% used: Jev's weights are being paged back in on each call.")
      expect(report).toContain("/memory auto")
    } finally { performance.now = realNow }
    const fast = store({ engine: "claude", model: "haiku" }, undefined, {
      probe: async () => ({ status: "unavailable", reason: "unavailable" }), swapUse: () => 0.98,
    })
    const failed = await memoryCommand(["test"], root, fast.value)
    expect(failed).toContain("failed (unavailable)")
    expect(failed).toContain("Check that the CLI is logged in and within its usage limit, or pin the other vendor (/memory claude or /memory codex).")
    expect(failed).not.toContain("Swap")
    expect(await memoryCommand(["test"], root, store({ engine: "off" }).value)).toBe("Memory engine is off; nothing to test.")
  })
})

describe("memory CLI tool", () => {
  test("is read-only, available to main, exact-schema validated, and asynchronous", async () => {
    const tools = createCliTools({ root, role: "main", allowed: ["read", "memory"], denied: [] })
    expect(tools.available).toEqual(["read", "multiread", "memory"])
    expect(tools.validate("memory", { query: "캐시" })).toBe(true)
    expect(tools.validate("memory", { query: " " })).toBe(false)
    expect(tools.validate("memory", { query: "캐시", path: "x" })).toBe(false)
    expect(tools.execute("memory", { query: "캐시" }).ok).toBe(false)
    const result = await tools.recall({ query: "캐시" }, memory, AbortSignal.timeout(5000))
    expect(result.ok && result.text).toContain(`knowledge/wiki/${CACHE}`)
  })

  test("is refused when the role policy denies it", async () => {
    const tools = createCliTools({ root, role: "worker", allowed: ["read", "memory"], denied: ["memory"] })
    expect(tools.available).not.toContain("memory")
    expect((await tools.recall({ query: "캐시" }, memory, AbortSignal.timeout(5000))).ok).toBe(false)
    expect(requests).toHaveLength(0)
  })
})
