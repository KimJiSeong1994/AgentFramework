// `/memory` in the Otter terminal: show, select or measure the inference engine that links requests to wiki memory.
// Selection only edits the user config; recall reads the config per call, so it applies to the next `memory` call.
import { spawnSync } from "node:child_process"
import { loadConfig, ConfigError, type OtterConfig } from "../config.ts"
import { saveMemoryEngine } from "./default-model.ts"
import {
  MEMORY_ENGINES, memoryLatency, memoryModelProblem, recallMemory, resolveMemoryEngine,
  type MemoryEngine, type MemoryEngineResolution, type MemoryRecall,
} from "../wiki/recall.ts"

export const MEMORY_USAGE = "Usage: /memory [show | test | auto | claude [model] | codex [model] | local <model> | jev | off]"
/** A fixed, content-free probe request: it measures the engine, not the wiki. */
export const MEMORY_PROBE_QUERY = "Should the system prompt include the current date on every turn?"

export type MemoryCommandStore = {
  read: (worktree: string) => OtterConfig["memory"] | string
  save: (engine: MemoryEngine, model?: string) => string
  /** Engine resolution (installed CLIs); injectable for tests. */
  resolve?: (memory: OtterConfig["memory"]) => MemoryEngineResolution
  /** Recall for `/memory test`; injectable for tests. */
  probe?: (worktree: string, memory: OtterConfig["memory"]) => Promise<MemoryRecall>
  /** Swap use as a fraction, or undefined when unknown (non-macOS or unreadable). */
  swapUse?: () => number | undefined
}

/** macOS `sysctl vm.swapusage`: "total = 21504.00M  used = 21050.50M ...". */
export function macSwapUse(): number | undefined {
  if (process.platform !== "darwin") return undefined
  try {
    const out = spawnSync("/usr/sbin/sysctl", ["-n", "vm.swapusage"], { encoding: "utf8", timeout: 2000 }).stdout ?? ""
    const total = /total = ([\d.]+)M/.exec(out)?.[1]
    const used = /used = ([\d.]+)M/.exec(out)?.[1]
    return total && used && Number(total) > 0 ? Number(used) / Number(total) : undefined
  } catch {
    return undefined
  }
}

export const fileMemoryStore: MemoryCommandStore = {
  read(worktree) {
    try { return loadConfig(worktree).memory }
    catch (error) { return error instanceof ConfigError ? error.message : "otter config could not be read" }
  },
  save: saveMemoryEngine,
  resolve: (memory) => resolveMemoryEngine(memory),
  probe: (worktree, memory) => recallMemory(worktree, MEMORY_PROBE_QUERY, memory, undefined, { fresh: true }),
  swapUse: macSwapUse,
}

const vendor = (engine: string) => engine === "claude" ? "Anthropic" : "OpenAI"

/** What a configured engine does right now, after `auto` and default models are resolved. */
function describe(memory: Pick<OtterConfig["memory"], "engine" | "model">, store: MemoryCommandStore): string {
  if (memory.engine === "off") return "off (the memory tool reports recall as off)"
  if (memory.engine === "jev") return "jev (local OpenJev server at memory.endpoint)"
  const resolved = (store.resolve ?? resolveMemoryEngine)(memory as OtterConfig["memory"])
  const label = memory.engine === "auto" ? "auto" : memory.engine
  if (!resolved.ok) {
    return resolved.reason === "engine_missing"
      ? `${label} — no usable CLI on PATH (${memory.engine === "auto" ? "install and log in to claude or codex" : `install the ${memory.engine} CLI`})`
      : `${label} — invalid model`
  }
  const target = `${resolved.engine} / ${resolved.model}`
  const remote = resolved.engine === "claude" || resolved.engine === "codex"
    ? ` — sends the request text and wiki index titles/descriptions to ${vendor(resolved.engine)}`
    : " (local Ollama)"
  return `${memory.engine === "auto" ? `auto → ${target}` : target}${remote}`
}

function latencyLine(memory: OtterConfig["memory"], store: MemoryCommandStore): string | undefined {
  const resolved = (store.resolve ?? resolveMemoryEngine)(memory)
  if (!resolved.ok) return undefined
  const stats = memoryLatency(resolved.engine, resolved.model)
  if (!stats.samples) return memory.prefetch ? "Prefetch on." : undefined
  const median = stats.medianMs === null ? "no successful call" : `median ${(stats.medianMs / 1000).toFixed(1)} s`
  return `Observed in this process: ${stats.samples} call(s), ${stats.ok} answered, ${median}${memory.prefetch ? "; prefetch on" : ""}.`
}

/** Returns the text to show; never throws for operator input. `test` runs one real inference. */
export async function memoryCommand(args: readonly string[], worktree: string, store: MemoryCommandStore = fileMemoryStore): Promise<string> {
  const read = () => store.read(worktree)
  const current = () => {
    const value = read()
    if (typeof value === "string") return `Memory engine is unreadable: ${value}`
    return [`Memory engine: ${describe(value, store)}`, latencyLine(value, store)].filter(Boolean).join("\n")
  }
  if (args.length === 0 || (args.length === 1 && args[0] === "show")) return current()
  if (args.length === 1 && args[0] === "test") return memoryTest(worktree, store)
  const [name, model, ...extra] = args
  if (!MEMORY_ENGINES.includes(name as MemoryEngine) || extra.length) return MEMORY_USAGE
  const engine = name as MemoryEngine
  if (model !== undefined && (engine === "auto" || engine === "jev" || engine === "off")) return MEMORY_USAGE
  if (engine === "local" && model === undefined) return `local needs an Ollama model ID. ${MEMORY_USAGE}`
  const problem = memoryModelProblem(engine, model)
  if (problem) return problem
  let path: string
  try { path = store.save(engine, model) }
  catch (error) { return `Memory engine not saved: ${error instanceof Error ? error.message : "user config could not be written"}` }
  const effective = read()
  const shadowed = typeof effective !== "string" && (effective.engine !== engine || (model !== undefined && effective.model !== model))
  const chosen = typeof effective === "string" || shadowed ? { engine, ...(model ? { model } : {}) } : effective
  return [
    `Saved memory engine ${describe(chosen, store)} to ${path}; it applies to the next memory call.`,
    ...(shadowed ? [`The project .otter/otter.jsonc overrides it: ${current().split("\n")[0]!.replace(/^Memory engine: /, "effective engine ")}.`] : []),
  ].join("\n")
}

async function memoryTest(worktree: string, store: MemoryCommandStore): Promise<string> {
  const memory = store.read(worktree)
  if (typeof memory === "string") return `Memory engine is unreadable: ${memory}`
  if (memory.engine === "off") return "Memory engine is off; nothing to test."
  if (!store.probe) return "Memory test is unavailable in this terminal."
  const started = performance.now()
  const recall = await store.probe(worktree, memory)
  const seconds = (performance.now() - started) / 1000
  const outcome = recall.status === "unavailable" ? `failed (${recall.reason})` : recall.status === "linked" ? `linked ${recall.links.map((l) => l.path).join(", ")}` : "answered (no page linked)"
  const lines = [`Memory test: ${describe(memory, store)} ${outcome} in ${seconds.toFixed(1)} s.`]
  const swap = store.swapUse?.()
  // Measured cause on this class of machine: when unified memory is full, the 15 GB MLX weights are swapped back in
  // on every Jev read (~15 GB of swap-ins per call), so latency is paging, not the model.
  if (memory.engine === "jev" && seconds >= 10) {
    lines.push(swap !== undefined && swap >= 0.8
      ? `Swap is ${Math.round(swap * 100)}% used: Jev's weights are being paged back in on each call. Free unified memory (unload idle Ollama models, e.g. \`ollama stop <model>\` or a shorter OLLAMA_KEEP_ALIVE), or switch with /memory auto.`
      : "Jev is slow but swap does not look full; check other GPU users, or switch with /memory auto.")
  }
  if (recall.status === "unavailable" && recall.reason === "unavailable" && memory.engine !== "jev") {
    lines.push("Check that the CLI is logged in and within its usage limit, or pin the other vendor (/memory claude or /memory codex).")
  }
  return lines.join("\n")
}
