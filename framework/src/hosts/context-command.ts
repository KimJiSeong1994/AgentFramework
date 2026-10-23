import { applyEdits, modify } from "jsonc-parser"
import { loadConfig, localContextInputTokens, localContextTrimTargetPercent } from "../config.ts"
import { rewriteUserConfig } from "./default-model.ts"
import { runLocalModelCommand } from "./local-model-command.ts"
import type { ConversationContextReport, ConversationContextState } from "./plan-conversation.ts"

export const CONTEXT_USAGE = "Usage: /context [status | optimize [speed|balanced|long|default] | budget <4096-65536>|default | pin <text> | unpin | compact [pairs-to-keep]]"
export type ContextBudgetStore = {
  read(worktree: string): number
  save(tokens: number | null): string
  readTrimTarget?(worktree: string): number
  saveOptimization?(tokens: number | null, trimTargetPercent: number | null): string
}
export const fileContextBudgetStore: ContextBudgetStore = {
  read: worktree => localContextInputTokens(loadConfig(worktree)),
  save(tokens) {
    if (tokens !== null && (!Number.isInteger(tokens) || tokens < 4096 || tokens > 65536)) throw new Error("Invalid context input budget")
    return rewriteUserConfig(text => applyEdits(text, modify(text, ["local_model", "context_input_tokens"], tokens, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    })))
  },
  readTrimTarget: worktree => localContextTrimTargetPercent(loadConfig(worktree)),
  saveOptimization(tokens, trimTargetPercent) {
    if ((tokens !== null && (!Number.isInteger(tokens) || tokens < 4096 || tokens > 65536)) ||
        (trimTargetPercent !== null && (!Number.isInteger(trimTargetPercent) || trimTargetPercent < 50 || trimTargetPercent > 85))) {
      throw new Error("Invalid context optimization settings")
    }
    return rewriteUserConfig(text => {
      for (const [key, value] of [["context_input_tokens", tokens], ["context_trim_target_percent", trimTargetPercent]] as const) {
        text = applyEdits(text, modify(text, ["local_model", key], value, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        }))
      }
      return text
    })
  },
}

const optimizationProfiles = {
  speed: { tokens: 8192, target: 50 },
  balanced: { tokens: 16384, target: 70 },
  long: { tokens: 32768, target: 85 },
} as const
const sharedScope = "Scope: shared by all local models and local combo routes; project settings take precedence. Check smaller-context routes before using them."

/** Use the loaded allocation, not the model's advertised maximum. Unknown CLI layouts fail closed. */
export function loadedContextSize(output: string, model: string): number {
  const rows = output.trim().split(/\r?\n/u).map(row => row.trim().split(/\s{2,}/u))
  const header = rows.shift() ?? []
  const contextIndex = header.indexOf("CONTEXT")
  if (header[0] !== "NAME" || contextIndex < 1) throw new Error("Ollama did not report a loaded context size; use /context budget explicitly")
  const canonical = (name: string) => name.split("/").at(-1)!.includes(":") ? name : `${name}:latest`
  const matches = rows.filter(row => canonical(row[0] ?? "") === canonical(model))
  const value = matches.length === 1 ? matches[0]![contextIndex] ?? "" : ""
  const size = /^\d+$/u.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Selected model is not loaded with a known context size; send a message first, then retry optimization")
  return size
}

export type ContextController = {
  state(): ConversationContextState
  report(): ConversationContextReport
  /** Caller persists the checkpoint and replaces the in-memory window under the idle-session guard. */
  apply(state: ConversationContextState): void
}

export async function contextCommand(
  args: string[], worktree: string, controller?: ContextController, store: ContextBudgetStore = fileContextBudgetStore,
  local?: { model?: string; signal?: AbortSignal; run?: typeof runLocalModelCommand },
): Promise<string> {
  const action = args[0] ?? "status"
  try {
    if (action === "optimize" && args.length <= 2) {
      const profile = args[1] ?? "balanced"
      if (profile !== "default" && !Object.hasOwn(optimizationProfiles, profile)) return CONTEXT_USAGE
      if (!store.saveOptimization || !store.readTrimTarget) throw new Error("Context optimization storage is unavailable")
      store.read(worktree)
      let tokens: number | null = null
      let target: number | null = null
      let observed = ""
      if (profile !== "default") {
        if (!local?.model) return "Select a local model before optimizing its context settings."
        const size = loadedContextSize(await (local.run ?? runLocalModelCommand)(["ps"], worktree, local.signal), local.model)
        const outputReserve = Math.max(2048, Math.ceil(size / 8))
        const preset = optimizationProfiles[profile as keyof typeof optimizationProfiles]
        tokens = Math.floor(Math.min(preset.tokens, size - outputReserve) / 1024) * 1024
        if (tokens < 4096) throw new Error("Loaded context is too small for the minimum 4096 input budget plus output headroom; increase the Ollama context first")
        target = preset.target
        observed = `Observed ${local.model}: ${size} context tokens; reserved at least ${outputReserve} for output.\n`
      }
      if (local?.signal?.aborted) throw new Error("Context optimization cancelled")
      const path = store.saveOptimization(tokens, target)
      const effectiveTokens = store.read(worktree)
      const effectiveTarget = store.readTrimTarget(worktree)
      return `${observed}Saved ${profile} context settings to ${path}. Effective input budget: ${effectiveTokens} estimated tokens; trim target: ${effectiveTarget}%. Applies to the next turn.${effectiveTokens !== (tokens ?? 8192) || effectiveTarget !== (target ?? 70) ? " The project config overrides these user settings." : ""}\n${sharedScope}\nThese are heuristic presets, not a measured speedup. They do not resize Ollama's context. Re-run optimization after changing the model or its loaded context.`
    }
    if (action === "status" && args.length <= 1) {
      const trimming = `Automatic trim target: ${store.readTrimTarget?.(worktree) ?? 70}% of the conversation allowance when older pairs are removed. /context optimize [speed|balanced|long] adjusts both settings.`
      if (!controller) return `Local input budget: ${store.read(worktree)} estimated tokens. Select a local model to inspect its active conversation context.\n${trimming}\n${sharedScope}`
      const report = controller.report()
      return [
        `Local input budget: ${report.inputTokens} estimated tokens (including host instructions and tools).`,
        trimming,
        sharedScope,
        `Retained conversation: ~${report.usedTokens} / ${report.conversationTokens} estimated tokens; ${report.pairs} complete pairs.`,
        `Pinned note: ${report.pinnedNote || "none"}`,
        `Older pairs removed in this process: ${report.droppedPairs}. Full transcript is kept.`,
        "Old pairs are removed in batches when needed; the current request and pinned note are kept. Estimates are not the model's exact token count or cache-hit count.",
      ].join("\n")
    }
    if (action === "budget" && args.length === 2) {
      const raw = args[1]!
      const tokens = raw === "default" ? null : /^\d+$/.test(raw) ? Number(raw) : NaN
      if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 4096 || tokens > 65536)) return CONTEXT_USAGE
      store.read(worktree)
      const path = store.save(tokens)
      const effective = store.read(worktree)
      return `Saved local input budget ${tokens ?? "default (8192)"} to ${path}. Effective: ${effective} estimated tokens; applies to the next turn.${effective !== (tokens ?? 8192) ? " The project config overrides the user setting." : ""}\n${sharedScope}\nThis controls Otter's input window. Keep it below the Ollama model's configured context size with room for its output; it does not resize the server context.`
    }
    if (action === "pin" || action === "unpin" || action === "compact") {
      if (!controller) return "Context changes require an idle local-model conversation; finish active work or select a local model first."
      const current = controller.state()
      if (action === "pin") {
        const note = args.slice(1).join(" ").trim()
        if (!note || note.length > 2000) return `${CONTEXT_USAGE}\nPinned note must contain 1–2000 characters.`
        controller.apply({ ...current, pinnedNote: note })
        return "Pinned context note saved. It stays in context when older conversation pairs are removed."
      }
      if (action === "unpin" && args.length === 1) {
        controller.apply({ ...current, pinnedNote: "" })
        return "Pinned context note cleared. Conversation history is kept."
      }
      if (action === "compact" && args.length <= 2) {
        const keep = args[1] === undefined ? 4 : /^\d+$/.test(args[1]) ? Number(args[1]) : NaN
        if (!Number.isSafeInteger(keep) || keep < 0 || keep > 24) return CONTEXT_USAGE
        const messages = keep === 0 ? [] : current.messages.slice(-keep * 2)
        controller.apply({ messages, pinnedNote: current.pinnedNote })
        return `Context compacted: removed ${(current.messages.length - messages.length) / 2} older pairs; kept ${messages.length / 2} pairs and the pinned note. Full transcript is kept. This trims history without generating a summary; the next request may rebuild the prompt cache.`
      }
    }
    return CONTEXT_USAGE
  } catch (error) {
    return `Context command failed: ${error instanceof Error ? error.message : "operation unavailable"}`
  }
}
