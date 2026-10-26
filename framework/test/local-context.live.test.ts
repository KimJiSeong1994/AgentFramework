import { expect, test } from "bun:test"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCliRuntime } from "../src/hosts/cli-runtime.ts"
import { createCliTransport } from "../src/hosts/cli-transport.ts"
import { contextCommand } from "../src/hosts/context-command.ts"
import { createPlanConversation, type ConversationMessage } from "../src/hosts/plan-conversation.ts"
import { defaultDependencies } from "../src/hosts/interactive-session.ts"
import { estimateTokens } from "../src/tokens.ts"
import { loadConfig, localContextInputTokens, localContextTrimTargetPercent } from "../src/config.ts"
import { tempGitWorktree } from "./guards-helpers.ts"

// Opt-in, real Ollama inference. Select an already installed model explicitly.
// OTTER_CONTEXT_LIVE_MODEL=gemma4-26b-mtp:latest bun test test/local-context.live.test.ts
const model = process.env.OTTER_CONTEXT_LIVE_MODEL
// Exercise the production adapter as well as the constructor; it must forward restored pinned notes.
const createConversation = defaultDependencies().createConversation as typeof createPlanConversation

test.skipIf(!model)("real Ollama retains pinned context across compaction, budget pressure and state reload", async () => {
  const wt = tempGitWorktree()
  wt.worktree = realpathSync(wt.worktree)
  try {
    const configPath = join(wt.worktree, ".otter", "otter.jsonc")
    mkdirSync(join(wt.worktree, ".otter"), { recursive: true })
    const configure = (tokens: number) => writeFileSync(configPath, JSON.stringify({
      local_model: { context_input_tokens: tokens }, chat: { execute: "plan" }, memory: { engine: "off" },
    }))
    configure(8192)
    const prompts: string[] = []
    const runtime = createCliRuntime({ worktree: wt.worktree, engine: "local", model: model!,
      createTransport(options) {
        // Observe the actual prompt, then use the unchanged production Ollama transport.
        const transport = createCliTransport(options)
        return { ...transport, run() { prompts.push(options.prompt); return transport.run() } }
      },
    })
    let conversation = createConversation(runtime, "local-context-live")
    const controller = {
      state: () => conversation.contextState(), report: () => conversation.contextReport(),
      apply: (state: ReturnType<typeof conversation.contextState>) => conversation.replaceContext(state),
    }
    const marker = `OTTER-${crypto.randomUUID().slice(0, 8)}`
    expect(await contextCommand(["pin", `프로젝트 식별코드는 ${marker} 입니다.`], wt.worktree, controller)).toContain("saved")
    const ask = async (stage: string) => {
      const start = performance.now()
      const firstPrompt = prompts.length
      const result = await conversation.turn("고정된 참고 정보의 프로젝트 식별코드만 답하세요. 도구는 사용하지 마세요.", AbortSignal.timeout(90_000))
      const report = conversation.contextReport()
      console.log("LIVE_CONTEXT", JSON.stringify({ stage, model, elapsedMs: Math.round(performance.now() - start),
        response: result.text, report, promptTokens: prompts.slice(firstPrompt).map(text => 64 + estimateTokens(text)) }))
      expect(result.text).toContain(marker)
      expect(prompts.length).toBeGreaterThan(firstPrompt)
      for (const prompt of prompts.slice(firstPrompt)) {
        expect(prompt).toContain(marker)
        expect(64 + estimateTokens(prompt)).toBeLessThanOrEqual(report.inputTokens)
      }
      expect(runtime.runs.status().claim).toBeUndefined()
    }
    await ask("pinned-8192")
    expect(conversation.contextReport().pairs).toBe(1)
    expect(await contextCommand(["compact", "0"], wt.worktree, controller)).toContain("removed 1 older pairs")
    expect(conversation.contextState().messages).toEqual([])
    await ask("after-manual-compact")

    const history: ConversationMessage[] = Array.from({ length: 24 }, (_, index) => [
      { role: "user" as const, text: `OLD-${index}: ` + "이전 대화의 코드 검토 기록입니다. const value = { valid: true }; ".repeat(18) },
      { role: "assistant" as const, text: `검토 ${index} 완료. ` + "배열과 예외 처리를 확인했습니다. ".repeat(10) },
    ]).flat()
    conversation.replaceContext({ messages: history, pinnedNote: conversation.contextState().pinnedNote })
    configure(4096)
    expect(conversation.contextReport().inputTokens).toBe(4096)
    await ask("automatic-trim-4096")
    expect(conversation.contextReport().droppedPairs).toBeGreaterThan(1)
    expect(conversation.contextReport().pairs).toBeLessThan(24)
    expect(prompts.at(-1)).not.toContain("OLD-0:")

    const statePath = join(wt.worktree, "context-checkpoint.json")
    const state = conversation.contextState()
    writeFileSync(statePath, JSON.stringify(state))
    const restored = JSON.parse(readFileSync(statePath, "utf8"))
    conversation = createConversation(runtime, "local-context-live-restored", restored.messages, restored.pinnedNote)
    expect(conversation.contextState()).toEqual(state)
    await ask("reloaded-context-4096")
    const before = conversation.contextState()
    const calls = prompts.length
    await expect(conversation.turn("초과 입력 ".repeat(5000))).rejects.toThrow("too large")
    expect(prompts).toHaveLength(calls)
    expect(conversation.contextState()).toEqual(before)
    const optimized = await contextCommand(["optimize", "balanced"], wt.worktree, controller, {
      read: directory => localContextInputTokens(loadConfig(directory)),
      readTrimTarget: directory => localContextTrimTargetPercent(loadConfig(directory)),
      save: () => { throw new Error("test only applies complete optimization settings") },
      saveOptimization: (tokens, target) => {
        writeFileSync(configPath, JSON.stringify({ local_model: { context_input_tokens: tokens, context_trim_target_percent: target },
          chat: { execute: "plan" }, memory: { engine: "off" } }))
        return configPath
      },
    }, { model })
    console.log("LIVE_CONTEXT_OPTIMIZATION", optimized)
    expect(optimized).toContain("Saved balanced context settings")
    expect(localContextTrimTargetPercent(loadConfig(wt.worktree))).toBe(70)
    await ask("optimized-balanced")
  } finally {
    wt.cleanup()
  }
}, 390_000)
