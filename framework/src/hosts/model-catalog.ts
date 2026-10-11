import { accessSync, constants, realpathSync, statSync } from "node:fs"
import process from "node:process"
import { delimiter, resolve } from "node:path"
import codexMetadata from "./codex-models-0.159.3.json"
import { CODEX_VERSION, createCodexProfile } from "./codex-profile.ts"
import { createVendorProcess, type VendorProcessHandle } from "./vendor-process.ts"

export type ModelCatalog = {
  models: Array<{ id: string; label: string }>
  notice: string
}

type CodexModelMetadata = { models: Array<{ slug: string; display_name: string }> }

const pinnedCodexMetadata = codexMetadata as CodexModelMetadata
const MAX_MODEL_ID_BYTES = 256
const MAX_OLLAMA_OUTPUT_BYTES = 64 * 1024
const OLLAMA_PROBE_TIMEOUT_MS = 5000
const OLLAMA_CANCEL_GRACE_MS = 750
const OLLAMA_TERM_TO_KILL_MS = 500

const LOCAL_UNAVAILABLE_NOTICE = "Unable to read installed Ollama models. Check that Ollama is installed and its service is available."
const LOCAL_EMPTY_NOTICE = "Ollama returned no installed models. Install a model in Ollama before selecting one."
const LOCAL_MALFORMED_NOTICE = "Ollama returned an unexpected model-list format; no model IDs are shown."
const LOCAL_TRUNCATED_NOTICE = "Ollama's model list exceeded the safe output limit; no model IDs are shown."
const LOCAL_CANCELLED_NOTICE = "Ollama model discovery was cancelled."
const LOCAL_LIST_NOTICE = "Installed IDs are from the current Ollama runtime and may change; enter a native model ID explicitly if needed."
const LOCAL_PARTIAL_NOTICE = "Some invalid Ollama list entries were omitted; enter a native model ID explicitly if needed."
const CODEX_NOTICE = `Pinned Codex ${CODEX_VERSION} bundled model slugs are shown; this list does not check account availability.`
const CLAUDE_NOTICE = "Sonnet, Opus, and Haiku are native Claude CLI aliases, not a fetched account-availability list; enter a native model ID explicitly if needed."

const CLAUDE_ALIASES = [
  { id: "sonnet", label: "Sonnet (Claude CLI alias)" },
  { id: "opus", label: "Opus (Claude CLI alias)" },
  { id: "haiku", label: "Haiku (Claude CLI alias)" },
] as const

function isSafeModelID(id: string): boolean {
  return Buffer.byteLength(id, "utf8") <= MAX_MODEL_ID_BYTES && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(id)
}

const CODEX_MODELS = pinnedCodexMetadata.models.flatMap(({ slug, display_name }) => {
  if (!isSafeModelID(slug) || typeof display_name !== "string" || display_name.length === 0) return []
  try {
    // Keep discovery aligned with the existing pinned-profile admission boundary.
    createCodexProfile(slug)
  } catch {
    return []
  }
  return [{ id: slug, label: display_name }]
})

function findOllamaExecutable(): string {
  const pathValue = process.env.PATH
  if (typeof pathValue !== "string" || pathValue.length === 0 || pathValue.includes("\0")) {
    throw new Error("Ollama executable unavailable")
  }
  for (const entry of pathValue.split(delimiter)) {
    if (entry.length === 0 || entry.includes("\0")) continue
    try {
      const candidate = resolve(entry, "ollama")
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {
      // Ignore unavailable PATH entries without exposing their contents.
    }
  }
  throw new Error("Ollama executable unavailable")
}

function parseOllamaList(output: string): { models: Array<{ id: string; label: string }>; malformed: boolean } | undefined {
  const lines = output.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => line.trim().length > 0)
  if (headerIndex < 0) return undefined

  const header = lines[headerIndex]!.trim().split(/\s+/)
  if (header[0] !== "NAME" || header[1] !== "ID" || header[2] !== "SIZE" || header[3] !== "MODIFIED") return undefined

  const models: Array<{ id: string; label: string }> = []
  const seen = new Set<string>()
  let malformed = false
  for (const line of lines.slice(headerIndex + 1)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const fields = trimmed.split(/\s+/)
    const id = fields[0]!
    if (fields.length < 4 || !isSafeModelID(id)) {
      malformed = true
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    models.push({ id, label: id })
  }
  return { models, malformed }
}

function modelCatalog(models: Array<{ id: string; label: string }>, notice: string): ModelCatalog {
  return { models: models.map(({ id, label }) => ({ id, label })), notice }
}

async function discoverLocalModels(worktree: string, signal?: AbortSignal): Promise<ModelCatalog> {
  if (signal?.aborted) return modelCatalog([], LOCAL_CANCELLED_NOTICE)

  let handle: VendorProcessHandle
  try {
    const cwd = realpathSync(worktree)
    if (!statSync(cwd).isDirectory()) return modelCatalog([], LOCAL_UNAVAILABLE_NOTICE)
    handle = createVendorProcess({
      executable: findOllamaExecutable(),
      argv: ["list"],
      cwd,
      deadlineAt: Date.now() + OLLAMA_PROBE_TIMEOUT_MS,
      maxCombinedOutputBytes: MAX_OLLAMA_OUTPUT_BYTES,
      termToKillMs: OLLAMA_TERM_TO_KILL_MS,
    })
  } catch {
    return modelCatalog([], LOCAL_UNAVAILABLE_NOTICE)
  }

  const cancel = (): void => {
    void handle.requestCancel("Ollama model discovery cancelled", Date.now() + OLLAMA_CANCEL_GRACE_MS).catch(() => {})
  }
  signal?.addEventListener("abort", cancel, { once: true })
  if (signal?.aborted) cancel()

  try {
    const result = await handle.run()
    if (signal?.aborted || result.status === "cancelled") return modelCatalog([], LOCAL_CANCELLED_NOTICE)
    if (result.stdout.truncated || result.stderr.truncated || !result.captureComplete || result.status === "incomplete") {
      return modelCatalog([], LOCAL_TRUNCATED_NOTICE)
    }
    if (result.status !== "completed" || result.code !== 0 || !result.quiescent) {
      return modelCatalog([], LOCAL_UNAVAILABLE_NOTICE)
    }

    const parsed = parseOllamaList(result.stdout.text)
    if (!parsed) return modelCatalog([], LOCAL_MALFORMED_NOTICE)
    if (parsed.models.length === 0) {
      return modelCatalog([], parsed.malformed ? LOCAL_MALFORMED_NOTICE : LOCAL_EMPTY_NOTICE)
    }
    return modelCatalog(parsed.models, parsed.malformed ? LOCAL_PARTIAL_NOTICE : LOCAL_LIST_NOTICE)
  } catch {
    cancel()
    return modelCatalog([], LOCAL_UNAVAILABLE_NOTICE)
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}

export async function discoverModels(
  engine: "local" | "codex" | "claude",
  worktree: string,
  signal?: AbortSignal,
): Promise<ModelCatalog> {
  switch (engine) {
    case "local":
      return discoverLocalModels(worktree, signal)
    case "codex":
      return modelCatalog(CODEX_MODELS, CODEX_NOTICE)
    case "claude":
      return modelCatalog([...CLAUDE_ALIASES], CLAUDE_NOTICE)
  }
}
