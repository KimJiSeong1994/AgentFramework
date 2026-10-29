import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import catalog from "./codex-models-0.159.3.json"
import { HOST_INFERENCE_INSTRUCTIONS } from "./inference-instructions.ts"

// Generated from Codex 0.159.3's public `codex debug models --bundled` metadata export.
// Original base instructions and source model-message prompts are excluded; only verified
// model metadata remains, with every emitted entry carrying the fixed Otter-owned instructions.
const bundledModels = catalog as {
  models: Array<{ slug: string } & Record<string, unknown>>
}

export const CODEX_VERSION = "0.159.3"
// Catalog provenance stays fixed; CLI releases are admitted only after qualifying
// this profile's instructions, native-tool removal, and execution protocol.
export const CODEX_SUPPORTED_VERSIONS = Object.freeze(["0.159.3", "0.163.0"] as const)
export const CODEX_INSTRUCTIONS = HOST_INFERENCE_INSTRUCTIONS

export type CodexProfile = Readonly<{
  version: string
  catalogJson: string
  catalogHash: string
  instructions: string
}>

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")

function serializeModel(source: { slug: string } & Record<string, unknown>): string {
  const model = JSON.parse(JSON.stringify(source)) as Record<string, unknown>
  model.model_messages = { instructions_template: CODEX_INSTRUCTIONS }
  model.apply_patch_tool_type = null
  model.tool_mode = null
  model.shell_type = "disabled"
  model.experimental_supported_tools = []
  model.multi_agent_version = null
  model.input_modalities = ["text"]
  model.node_repl_disabled = true
  model.supports_search_tool = false
  model.include_skills_usage_instructions = false
  model.include_plugin_usage_instructions = false
  model.include_apps_usage_instructions = false
  return JSON.stringify({ models: [model] })
}

export function createCodexProfile(model: string): CodexProfile {
  if (typeof model !== "string" || model.length === 0) throw new TypeError("Codex model slug must be a non-empty string")
  const source = bundledModels.models.find((entry) => entry.slug === model)
  if (!source) throw new Error(`unknown Codex bundled model slug: ${model}`)

  const catalogJson = serializeModel(source)
  return Object.freeze({
    version: CODEX_VERSION,
    catalogJson,
    catalogHash: sha256(catalogJson),
    instructions: CODEX_INSTRUCTIONS,
  })
}

function assertCodexProfile(value: unknown): asserts value is CodexProfile {
  if (typeof value !== "object" || value === null) throw new TypeError("invalid Codex profile")
  const profile = value as Partial<CodexProfile>
  if (
    profile.version !== CODEX_VERSION || profile.instructions !== CODEX_INSTRUCTIONS ||
    typeof profile.catalogJson !== "string" || typeof profile.catalogHash !== "string"
  ) throw new TypeError("invalid Codex profile")

  let parsed: unknown
  try {
    parsed = JSON.parse(profile.catalogJson)
  } catch {
    throw new TypeError("invalid Codex profile catalog")
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { models?: unknown }).models)) {
    throw new TypeError("invalid Codex profile catalog")
  }
  const models = (parsed as { models: unknown[] }).models
  const first = models[0]
  if (models.length !== 1 || typeof first !== "object" || first === null || typeof (first as { slug?: unknown }).slug !== "string") {
    throw new TypeError("invalid Codex profile catalog")
  }
  const expected = createCodexProfile((first as { slug: string }).slug)
  if (profile.catalogJson !== expected.catalogJson || profile.catalogHash !== expected.catalogHash) {
    throw new TypeError("invalid Codex profile catalog")
  }
}

function assertAbsolutePath(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new TypeError(`${name} must be a non-empty absolute path`)
  }
}

function tomlBasicString(value: string): string {
  let escaped = '"'
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw new TypeError("path contains invalid Unicode")
    switch (codePoint) {
      case 0x08: escaped += "\\b"; break
      case 0x09: escaped += "\\t"; break
      case 0x0a: escaped += "\\n"; break
      case 0x0c: escaped += "\\f"; break
      case 0x0d: escaped += "\\r"; break
      case 0x22: escaped += "\\\""; break
      case 0x5c: escaped += "\\\\"; break
      default:
        if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
          escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`
        } else {
          escaped += character
        }
    }
  }
  return `${escaped}"`
}

export function codexProfileArgv(profile: CodexProfile, scratchWorkdir: string, catalogPath: string): string[] {
  assertCodexProfile(profile)
  assertAbsolutePath(scratchWorkdir, "scratchWorkdir")
  assertAbsolutePath(catalogPath, "catalogPath")

  return [
    "-c", 'default_permissions="otter_text_only"',
    "-c", `permissions.otter_text_only={ filesystem = { ${tomlBasicString(scratchWorkdir)} = "read" } }`,
    "-c", `model_catalog_json=${tomlBasicString(catalogPath)}`,
    "-c", "features.code_mode=false",
    "-c", "features.goals=false",
    "-c", "tools.experimental_request_user_input.enabled=false",
  ]
}
