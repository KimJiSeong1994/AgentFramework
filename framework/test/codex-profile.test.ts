import { createHash } from "node:crypto"
import { lstatSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { CODEX_INSTRUCTIONS, CODEX_VERSION, CODEX_SUPPORTED_VERSIONS, codexProfileArgv, createCodexProfile } from "../src/hosts/codex-profile.ts"

const BUNDLED_SLUGS = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-daybreak-blue-latest",
  "gpt-daybreak-red-latest",
  "gpt-5.5",
  "codex-auto-review",
] as const

type CatalogModel = Record<string, unknown>

function modelFor(slug: string): CatalogModel {
  const catalog = JSON.parse(createCodexProfile(slug).catalogJson) as { models: CatalogModel[] }
  expect(catalog.models).toHaveLength(1)
  return catalog.models[0]!
}

describe("Codex 0.159.3 static text-only profile", () => {
  test("bundles the catalogue without a runtime JSON file dependency", async () => {
    const directory = mkdtempSync(join(tmpdir(), "otter-profile-bundle-"))
    const identity = lstatSync(directory)
    try {
      const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "../src/hosts/codex-profile.ts")],
        target: "bun",
        outdir: directory,
      })
      expect(build.success).toBe(true)
      expect(build.outputs).toHaveLength(1)
      const bundled = await import(build.outputs[0]!.path)
      expect(bundled.createCodexProfile("gpt-5.6-sol")).toEqual(createCodexProfile("gpt-5.6-sol"))
    } finally {
      const current = lstatSync(directory)
      if (current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino) {
        rmSync(directory, { recursive: true })
      }
    }
  })

  test("exports all 11 bundled model slugs with exact native-tool removals", () => {
    expect(CODEX_VERSION).toBe("0.159.3")
    expect(CODEX_SUPPORTED_VERSIONS).toEqual(["0.159.3", "0.163.0"])
    expect(Object.isFrozen(CODEX_SUPPORTED_VERSIONS)).toBe(true)
    expect(new Set(BUNDLED_SLUGS).size).toBe(11)

    for (const slug of BUNDLED_SLUGS) {
      const model = modelFor(slug)
      expect(model.slug).toBe(slug)
      expect(model.model_messages).toEqual({ instructions_template: CODEX_INSTRUCTIONS })
      expect(model.apply_patch_tool_type).toBeNull()
      expect(model.tool_mode).toBeNull()
      expect(model.shell_type).toBe("disabled")
      expect(model.experimental_supported_tools).toEqual([])
      expect(model.multi_agent_version).toBeNull()
      expect(model.input_modalities).toEqual(["text"])
      expect(model.node_repl_disabled).toBe(true)
      expect(model.supports_search_tool).toBe(false)
      expect(model.include_skills_usage_instructions).toBe(false)
      expect(model.include_plugin_usage_instructions).toBe(false)
      expect(model.include_apps_usage_instructions).toBe(false)

      expect(Number.isSafeInteger(model.context_window)).toBe(true)
      expect(Number.isSafeInteger(model.max_context_window)).toBe(true)
      expect(Number.isSafeInteger(model.priority)).toBe(true)
      const reasoningLevels = model.supported_reasoning_levels as Array<{ effort: string }>
      expect(reasoningLevels.some(({ effort }) => effort === model.default_reasoning_level)).toBe(true)

      const json = JSON.stringify(model)
      expect(json).not.toContain("base_instructions")
      expect(json).not.toContain("You are Codex")
      expect(json).not.toContain("persistent_instructions")
      expect(json).not.toContain("collaboration_modes")
    }
  })

  test("hashes the exact single-model JSON deterministically", () => {
    const profile = createCodexProfile("gpt-5.6-sol")
    expect(profile.version).toBe(CODEX_VERSION)
    expect(profile.instructions).toBe(CODEX_INSTRUCTIONS)
    expect(profile.catalogHash).toBe(createHash("sha256").update(profile.catalogJson, "utf8").digest("hex"))
    expect(createCodexProfile("gpt-5.6-sol")).toEqual(profile)
    expect(Object.isFrozen(profile)).toBe(true)
  })

  test("refuses unknown and non-exact slugs", () => {
    expect(() => createCodexProfile("unknown-model")).toThrow(/unknown Codex bundled model slug/)
    expect(() => createCodexProfile(" gpt-5.6-sol")).toThrow(/unknown Codex bundled model slug/)
    expect(() => createCodexProfile("")).toThrow(/non-empty string/)
  })

  test("emits only A+B config assignments and safely quotes absolute paths", () => {
    const profile = createCodexProfile("gpt-5.6-sol")
    const scratchWorkdir = "/tmp/otter scratch/quo\"te\\dir\nchild"
    const catalogPath = "/tmp/otter config/catalog\"copy\\model.json"
    const args = codexProfileArgv(profile, scratchWorkdir, catalogPath)

    expect(args).toEqual([
      "-c", 'default_permissions="otter_text_only"',
      "-c", String.raw`permissions.otter_text_only={ filesystem = { "/tmp/otter scratch/quo\"te\\dir\nchild" = "read" } }`,
      "-c", String.raw`model_catalog_json="/tmp/otter config/catalog\"copy\\model.json"`,
      "-c", "features.code_mode=false",
      "-c", "features.goals=false",
      "-c", "tools.experimental_request_user_input.enabled=false",
    ])
    expect(args).not.toContain("--sandbox")
  })

  test("rejects relative, empty, and NUL-containing paths and inconsistent profiles", () => {
    const profile = createCodexProfile("gpt-5.6-sol")
    expect(() => codexProfileArgv(profile, "scratch", "/tmp/catalog.json")).toThrow(/absolute path/)
    expect(() => codexProfileArgv(profile, "/tmp/scratch", "catalog.json")).toThrow(/absolute path/)
    expect(() => codexProfileArgv(profile, "", "/tmp/catalog.json")).toThrow(/absolute path/)
    expect(() => codexProfileArgv(profile, "/tmp/scratch\0bad", "/tmp/catalog.json")).toThrow(/absolute path/)
    expect(() => codexProfileArgv({ ...profile, catalogHash: "0".repeat(64) }, "/tmp/scratch", "/tmp/catalog.json")).toThrow(/invalid Codex profile catalog/)
  })

  test("mutating decoded result data cannot affect later profiles", () => {
    const profile = createCodexProfile("gpt-5.6-sol")
    const catalog = JSON.parse(profile.catalogJson) as { models: CatalogModel[] }
    const messages = catalog.models[0]!.model_messages as { instructions_template: string }
    messages.instructions_template = "mutated outside the profile"
    expect(Reflect.set(profile, "catalogJson", "tampered")).toBe(false)

    const later = createCodexProfile("gpt-5.6-sol")
    expect(later.catalogJson).not.toContain("mutated outside the profile")
    expect(later.catalogJson).toBe(createCodexProfile("gpt-5.6-sol").catalogJson)
  })
})
