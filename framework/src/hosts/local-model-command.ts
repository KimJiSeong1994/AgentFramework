import { realpathSync } from "node:fs"
import { applyEdits, modify } from "jsonc-parser"
import { isLocalKeepAlive, loadConfig } from "../config.ts"
import { rewriteUserConfig } from "./default-model.ts"
import { findExecutable } from "./cli-transport.ts"
import { NATIVE_MODEL_ID_RE } from "./types.ts"
import { createVendorProcess } from "./vendor-process.ts"

export const LOCAL_MODEL_USAGE = "Usage: /local [status | profile memory|balanced|speed|default | keepalive 0|-1|<duration>|default | unload [model]]"
const profiles = { memory: "0", balanced: "5m", speed: "-1", default: null } as const

export type LocalModelStore = {
  read(worktree: string): string | null | undefined
  save(keepAlive: string | null): string
  run(argv: readonly string[], worktree: string, signal?: AbortSignal): Promise<string>
}

/** Same bounded process and environment as local inference; no shell, pull, deletion or server restart. */
export async function runLocalModelCommand(argv: readonly string[], worktree: string, signal?: AbortSignal): Promise<string> {
  if (!(argv.length === 1 && argv[0] === "ps") &&
      !(argv.length === 2 && argv[0] === "stop" && NATIVE_MODEL_ID_RE.test(argv[1]!))) {
    throw new Error("Unsupported local model operation")
  }
  if (signal?.aborted) throw new Error("Local model operation cancelled")
  const handle = createVendorProcess({
    executable: findExecutable("local"), argv, cwd: realpathSync(worktree),
    deadlineAt: Date.now() + 10_000, maxCombinedOutputBytes: 64 * 1024, termToKillMs: 500,
  })
  const cancel = () => { void handle.requestCancel("local model operation cancelled", Date.now() + 1000).catch(() => {}) }
  signal?.addEventListener("abort", cancel, { once: true })
  if (signal?.aborted) cancel()
  try {
    const result = await handle.run()
    if (signal?.aborted) throw new Error("Local model operation cancelled")
    if (result.status !== "completed" || result.code !== 0 || !result.quiescent || !result.captureComplete ||
        result.stdout.truncated || result.stderr.truncated) {
      throw new Error("Ollama operation failed or was incomplete; check that its local service is running")
    }
    return result.stdout.text.trim()
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}

export const fileLocalModelStore: LocalModelStore = {
  read: worktree => loadConfig(worktree).local_model?.keep_alive,
  save(keepAlive) {
    if (keepAlive !== null && !isLocalKeepAlive(keepAlive)) throw new Error("Invalid local model keepalive")
    return rewriteUserConfig(text => applyEdits(text, modify(text, ["local_model", "keep_alive"], keepAlive, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    })))
  },
  run: runLocalModelCommand,
}

function describe(value: string | null | undefined): string {
  if (value == null) return "server default"
  if (value === "0") return "0 (release after each response; reload and rebuild prompt cache next time)"
  if (value === "-1") return "-1 (keep loaded indefinitely; uses memory between requests)"
  return `${value} idle (reuse the loaded model and eligible prompt cache until eviction)`
}

export async function localModelCommand(
  args: string[], worktree: string,
  context: { model?: string; allowUnload: boolean; signal?: AbortSignal },
  store: LocalModelStore = fileLocalModelStore,
): Promise<string> {
  const action = args[0] ?? "status"
  try {
    if (action === "status" && args.length <= 1) {
      const setting = `Local model keepalive: ${describe(store.read(worktree))}`
      try {
        const loaded = await store.run(["ps"], worktree, context.signal)
        return `${setting}\nLoaded Ollama models (size, processor and expiry reported by Ollama):\n${loaded || "No loaded models."}\nProfiles: memory = release after response; balanced = 5m idle; speed = keep loaded. Cache reuse is not guaranteed.`
      } catch (error) {
        return `${setting}\nStatus unavailable: ${error instanceof Error ? error.message : "Ollama unavailable"}`
      }
    }
    if ((action === "profile" || action === "keepalive") && args.length === 2) {
      const value = args[1]!
      let keepAlive: string | null
      if (action === "profile") {
        if (!Object.hasOwn(profiles, value)) return LOCAL_MODEL_USAGE
        keepAlive = profiles[value as keyof typeof profiles]
      } else {
        if (value !== "default" && !isLocalKeepAlive(value)) return `${LOCAL_MODEL_USAGE}\nDuration: positive whole seconds (s), minutes (m), or hours (h), up to 24h.`
        keepAlive = value === "default" ? null : value
      }
      store.read(worktree) // Refuse malformed effective config before saving.
      const path = store.save(keepAlive)
      const effective = store.read(worktree)
      return [
        `Saved local model keepalive ${keepAlive ?? "default"} to ${path}. Applies to subsequent Otter local CLI inference requests.`,
        `Effective keepalive: ${describe(effective)}`,
        ...((effective ?? null) !== keepAlive ? ["The project .otter/otter.jsonc overrides this user setting."] : []),
        "Already loaded models keep their current expiry until the next request; /local unload releases a model now.",
      ].join("\n")
    }
    if (action === "unload" && args.length <= 2) {
      if (!context.allowUnload) return "Model unload is unavailable while this session is held or before a model is selected; finish active work first."
      const model = args[1] ?? context.model
      if (!model || !NATIVE_MODEL_ID_RE.test(model)) return `${LOCAL_MODEL_USAGE}\nSelect a local model or specify its exact model ID.`
      await store.run(["stop", model], worktree, context.signal)
      return `Unloaded ${model}. Its runtime prompt cache is released; installed model files and conversation history are kept. Other clients using this Ollama model may need to reload it.`
    }
    return LOCAL_MODEL_USAGE
  } catch (error) {
    return `Local model command failed: ${error instanceof Error ? error.message : "operation unavailable"}`
  }
}
