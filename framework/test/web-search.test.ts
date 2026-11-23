import { describe, expect, test } from "bun:test"
import { parseWebSearchOutput, prepareWebSearchAction, validateWebSearchInput, webSearchArgv, webSearchCodexCatalog } from "../src/hosts/web-search.ts"

describe("web search", () => {
  test("a query is nonblank, at most 500 characters, NUL-free and the only key", () => {
    expect(() => validateWebSearchInput({ query: "latest bun release" })).not.toThrow()
    expect(() => validateWebSearchInput({ query: "Bun 런타임 최신 버전 — release notes (2026)?" })).not.toThrow()
    for (const bad of [{}, { query: "" }, { query: "   " }, { query: "x".repeat(501) }, { query: "a\0b" }, { query: "ok", extra: 1 }, { query: 1 }, null, []]) {
      expect(() => validateWebSearchInput(bad)).toThrow()
    }
  })

  test("a query may not carry anything the approval prompt would not show", () => {
    const tags = [..."SECRET=hunter2"].map(ch => String.fromCodePoint(0xe0000 + ch.codePointAt(0)!)).join("")
    for (const hidden of [`bun release${tags}`, "bun\u200brelease", "bun\u2060release", "bun\ufeffrelease", "bun\u00adrelease", "bun\u202erelease",
      "bun release\nAllowed: everything", "bun\rrelease", "bun\u001b[2Krelease", "bun\u2028release", "bun\ue200cite", "bun\ufe0f", "bun\ud800"]) {
      expect(() => validateWebSearchInput({ query: hidden })).toThrow()
    }
  })

  test("the action is bound to a vendor engine and a plain model id, and is frozen", () => {
    const action = prepareWebSearchAction({ query: "  latest bun release  " }, "codex", "gpt-6-astra")
    expect(action).toEqual({ tool: "web_search", query: "latest bun release", engine: "codex", model: "gpt-6-astra" })
    expect(Object.isFrozen(action)).toBe(true)
    expect(() => prepareWebSearchAction({ query: "q" }, "local" as "codex", "m")).toThrow()
    expect(() => prepareWebSearchAction({ query: "q" }, "claude", "--dangerous")).toThrow()
  })

  test("the search worker gets web search and nothing else, and never the query in its argv", () => {
    const codex = webSearchArgv(prepareWebSearchAction({ query: "secret-free query" }, "codex", "gpt-6-astra"), "/scratch")
    for (const flag of ['web_search="live"', "features.shell_tool=false", "features.multi_agent=false", "features.code_mode=false", "features.goals=false",
      "tools.experimental_request_user_input.enabled=false", "features.plugins=false", "features.apps=false", "mcp_servers={}",
      "include_environment_context=false", "project_doc_max_bytes=0", 'default_permissions="otter_text_only"', "--ignore-user-config",
      'model_catalog_json="/scratch/catalog.json"', 'permissions.otter_text_only={ filesystem = { "/scratch" = "read" } }']) {
      expect(codex).toContain(flag)
    }
    expect(codex.at(-1)).toBe("-")
    // The worker catalog is otter's stripped inference catalog with only the search tool switched back on.
    const model = JSON.parse(webSearchCodexCatalog("gpt-6-astra")).models[0]
    expect(model).toMatchObject({ supports_search_tool: true, shell_type: "disabled", apply_patch_tool_type: null, tool_mode: null,
      multi_agent_version: null, experimental_supported_tools: [], input_modalities: ["text"] })
    const claude = webSearchArgv(prepareWebSearchAction({ query: "secret-free query" }, "claude", "fable"), "/scratch")
    expect(claude.slice(claude.indexOf("--tools"), claude.indexOf("--tools") + 2)).toEqual(["--tools", "WebSearch"])
    expect(claude).toContain("--safe-mode")
    expect(claude).toContain("--strict-mcp-config")
    expect(claude).toContain("--no-session-persistence")
    for (const argv of [codex, claude]) expect(argv.some(argument => argument.includes("secret-free query"))).toBe(false)
  })

  test("only a completed vendor turn yields an answer", () => {
    const line = (value: unknown) => JSON.stringify(value)
    const codexOk = [
      line({ type: "thread.started", thread_id: "t" }), line({ type: "turn.started" }),
      line({ type: "item.completed", item: { type: "agent_message", text: "I will search." } }),
      line({ type: "item.completed", item: { type: "web_search", query: "bun" } }),
      line({ type: "item.completed", item: { type: "agent_message", text: "Bun 1.4.5\nSource: https://bun.com" } }),
      line({ type: "turn.completed", usage: {} }),
    ].join("\n")
    expect(parseWebSearchOutput("codex", codexOk)).toBe("Bun 1.4.5\nSource: https://bun.com")
    // Citation markers are removed; an announcement without a search is not a result; any other activity refuses it all.
    expect(parseWebSearchOutput("codex", codexOk.replace("Bun 1.4.5", "Bun 1.4.5\ue200cite\ue202turn0search0\ue201"))).toBe("Bun 1.4.5\nSource: https://bun.com")
    expect(parseWebSearchOutput("codex", codexOk.split("\n").filter(entry => !entry.includes('"web_search"')).join("\n"))).toBeUndefined()
    for (const foreign of ["collab_tool_call", "mcp_tool_call", "command_execution", "file_change"]) {
      const withForeign = codexOk.replace(line({ type: "turn.completed", usage: {} }), `${line({ type: "item.started", item: { type: foreign } })}\n${line({ type: "turn.completed", usage: {} })}`)
      expect(parseWebSearchOutput("codex", withForeign)).toBeUndefined()
    }
    expect(parseWebSearchOutput("codex", codexOk.replace('"turn.completed"', '"turn.failed"'))).toBeUndefined()
    expect(parseWebSearchOutput("codex", codexOk.split("\n").slice(0, -1).join("\n"))).toBeUndefined()
    const use = (name: string) => line({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } })
    const claudeOk = [line({ type: "system", subtype: "init", tools: ["WebSearch"], mcp_servers: [] }), "not json", use("WebSearch"),
      line({ type: "result", subtype: "success", is_error: false, result: "Bun 1.4.5" })].join("\n")
    expect(parseWebSearchOutput("claude", claudeOk)).toBe("Bun 1.4.5")
    expect(parseWebSearchOutput("claude", claudeOk.replace('["WebSearch"]', '["WebSearch","Read"]'))).toBeUndefined()
    expect(parseWebSearchOutput("claude", claudeOk.replace('"mcp_servers":[]', '"mcp_servers":[{"name":"x"}]'))).toBeUndefined()
    expect(parseWebSearchOutput("claude", claudeOk.replace(use("WebSearch"), use("Bash")))).toBeUndefined()
    expect(parseWebSearchOutput("claude", claudeOk.replace(`${use("WebSearch")}\n`, ""))).toBeUndefined()
    expect(parseWebSearchOutput("claude", line({ type: "result", subtype: "error_during_execution", is_error: true, result: "x" }))).toBeUndefined()
    expect(parseWebSearchOutput("claude", "")).toBeUndefined()
  })
})
