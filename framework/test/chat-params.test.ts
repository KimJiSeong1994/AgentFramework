import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Hooks, ProviderContext } from "@opencode-ai/plugin"
import type { Model, UserMessage } from "@opencode-ai/sdk"
import type { OtterConfig } from "../src/config.ts"
import { createChatParamsHook, isGemmaOnOllama } from "../src/hooks/chat-params.ts"
import type { HookDeps } from "../src/hooks/types.ts"
import { BASE_CONFIG, fakeDeps } from "./helpers.ts"
import { admitFixtureSession, releaseFixtureSession, tempWorktree } from "./guards-helpers.ts"
import { WORKFLOW_READ_ONLY_ROLES } from "../src/hosts/types.ts"

let worktree: ReturnType<typeof tempWorktree>
beforeEach(() => { worktree = tempWorktree() })
afterEach(() => worktree.cleanup())

type Input = Parameters<NonNullable<Hooks["chat.params"]>>[0]
type Output = Parameters<NonNullable<Hooks["chat.params"]>>[1]

function model(over: Omit<Partial<Model>, "api"> & { api?: Partial<Model["api"]> } = {}): Model {
  return {
    id: "gemma4:26b",
    providerID: "ollama",
    name: "Gemma 4 26B",
    status: "active",
    options: {},
    headers: {},
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 65536, output: 8192 },
    ...over,
    api: { id: "gemma4:26b", url: "http://localhost:11434/v1", npm: "@ai-sdk/openai-compatible", ...over.api },
  }
}

function provider(id: string): ProviderContext {
  return { source: "config", info: { id, name: id, source: "config", env: [], options: {}, models: {} }, options: {} }
}

function input(agent: string, m: Model = model(), p: ProviderContext = provider("ollama")): Input {
  return { sessionID: "s1", agent, model: m, provider: p, message: {} as UserMessage }
}

function output(maxOutputTokens: number | undefined = undefined): Output {
  return { temperature: 0.7, topP: 1, topK: 40, maxOutputTokens, options: {} }
}

function deps(overrides: Partial<OtterConfig> = {}): HookDeps {
  return fakeDeps(worktree.worktree, overrides)
}

describe("chat.params hook", () => {
  test("workflow roles require a code-owned binding before native inference parameters change", async () => {
    const hook = createChatParamsHook(deps())
    for (const role of WORKFLOW_READ_ONLY_ROLES) {
      const o = output()
      const before = structuredClone(o)
      await expect(hook(input(role), o)).rejects.toThrow("code-owned execution binding")
      expect(o).toEqual(before)
    }
  })

  test("an owned main session cannot dispatch an unknown native role", async () => {
    const d = deps()
    const store = admitFixtureSession(d, "s1")
    try {
      const o = output()
      await expect(createChatParamsHook(d)(input("unrecognized-agent"), o)).rejects.toThrow("unknown role")
      expect(o).toEqual(output())
    } finally { releaseFixtureSession(worktree.worktree, store) }
  })

  test("caps maxOutputTokens per agent from config.max_output", async () => {
    const hook = createChatParamsHook(deps())
    const o = output()
    await hook(input("main"), o)
    expect(o.maxOutputTokens).toBe(BASE_CONFIG.max_output.main)

    const w = output()
    await hook(input("worker"), w)
    expect(w.maxOutputTokens).toBe(BASE_CONFIG.max_output.worker)

    const r = output()
    await hook(input("reviewer"), r)
    expect(r.maxOutputTokens).toBe(BASE_CONFIG.max_output.reviewer)
  })

  test("takes the minimum of existing and configured cap", async () => {
    const hook = createChatParamsHook(deps({ max_output: { main: 8192, worker: 4096, reviewer: 2048 } }))
    const lower = output(1000)
    await hook(input("worker"), lower)
    expect(lower.maxOutputTokens).toBe(1000)

    const higher = output(100_000)
    await hook(input("worker"), higher)
    expect(higher.maxOutputTokens).toBe(4096)
  })

  test("applies trusted model output limit and reports configured identity conflicts", async () => {
    const hook = createChatParamsHook(deps({ models: { worker: "ollama/gemma4:26b" } }))
    const capped = output()
    await hook(input("worker", model({ limit: { context: 65536, output: 1024 } })), capped)
    expect(capped.maxOutputTokens).toBe(1024)

    await expect(hook(input("worker", model({ id: "other" })), output())).rejects.toThrow(/conflicts with resolved model/)
    await expect(hook(input("worker", model({ providerID: "google" })), output())).rejects.toThrow(/Conflicting provider IDs/)
  })

  test("does not add reasoning options when model capability does not support reasoning", async () => {
    const hook = createChatParamsHook(deps())
    const o = output()
    await hook(input("worker", model({ capabilities: { ...model().capabilities, reasoning: false } })), o)
    expect(o.options.reasoningEffort).toBeUndefined()
  })

  test("leaves non-otter agents untouched", async () => {
    const hook = createChatParamsHook(deps())
    const o = output(123_456)
    await hook(input("build"), o)
    expect(o.maxOutputTokens).toBe(123_456)
    expect(o.options).toEqual({})
  })

  test("never changes temperature", async () => {
    const hook = createChatParamsHook(deps())
    for (const agent of ["main", "worker", "reviewer"]) {
      const o = output()
      await hook(input(agent), o)
      expect(o.temperature).toBe(0.7)
      expect(o.topP).toBe(1)
      expect(o.topK).toBe(40)
    }
  })

  test("worker/reviewer on gemma+ollama get reasoningEffort=none; main does not", async () => {
    const hook = createChatParamsHook(deps())
    const w = output()
    await hook(input("worker"), w)
    expect(w.options.reasoningEffort).toBe("none")

    const r = output()
    await hook(input("reviewer"), r)
    expect(r.options.reasoningEffort).toBe("none")

    const m = output()
    await hook(input("main"), m)
    expect(m.options.reasoningEffort).toBeUndefined()
  })

  test("preserves existing options when adding reasoningEffort", async () => {
    const hook = createChatParamsHook(deps())
    const w = output()
    w.options = { num_ctx: 65536 }
    await hook(input("worker"), w)
    expect(w.options).toEqual({ num_ctx: 65536, reasoningEffort: "none" })
  })

  test("every option key we set is an AI-SDK providerOptions key (camelCase), never a wire-format key", async () => {
    // output.options becomes providerOptions[provider] (session/llm.ts -> ProviderTransform.providerOptions); the
    // openai-compatible SDK serialises reasoningEffort -> reasoning_effort. A snake_case key is silently dropped
    // (stage-2 e2e run 3: children kept thinking). Keep this list in sync with the AI SDK option names we rely on.
    const KNOWN_PROVIDER_OPTION_KEYS = new Set(["reasoningEffort", "reasoningSummary", "textVerbosity", "parallelToolCalls", "user"])
    const hook = createChatParamsHook(deps())
    for (const agent of ["worker", "reviewer"]) {
      const out = output()
      await hook(input(agent), out)
      for (const k of Object.keys(out.options)) expect(KNOWN_PROVIDER_OPTION_KEYS.has(k)).toBe(true)
      expect(out.options.reasoningEffort).toBe("none")
    }
  })

  test("reasoningEffort=none for every Ollama-served model (qwen too, stage 5); none for non-ollama providers", async () => {
    const hook = createChatParamsHook(deps())

    const qwen = output()
    await hook(input("worker", model({ id: "qwen3.6:35b-a3b", name: "Qwen", api: { id: "qwen3.6:35b-a3b" } })), qwen)
    expect(qwen.options.reasoningEffort).toBe("none")

    const cloudGemma = output()
    const cloudModel = model({
      id: "gemma-4-26b",
      providerID: "google",
      api: { id: "gemma-4-26b", url: "https://generativelanguage.googleapis.com", npm: "@ai-sdk/google" },
    })
    await hook(input("worker", cloudModel, provider("google")), cloudGemma)
    expect(cloudGemma.options.reasoningEffort).toBeUndefined()
  })

  test("isGemmaOnOllama detects openai-compatible providers pointing at ollama by url", () => {
    const viaCompat = model({
      providerID: "local",
      api: { url: "http://127.0.0.1:11434/v1", npm: "@ai-sdk/openai-compatible" },
    })
    expect(isGemmaOnOllama(viaCompat, "local")).toBe(true)
    const named = model({ providerID: "my-ollama", api: { url: "http://gpu-box:8080/v1" } })
    expect(isGemmaOnOllama(named, "my-ollama")).toBe(true)
    expect(isGemmaOnOllama(model({ providerID: "x", api: { url: "http://gpu-box:8080/v1" } }), "x")).toBe(false)
  })
})
