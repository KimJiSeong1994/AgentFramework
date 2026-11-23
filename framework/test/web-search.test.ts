import { describe, expect, test } from "bun:test"
import { parseWebSearchOutput, prepareWebSearchAction, validateWebSearchInput, webSearchArgv } from "../src/hosts/web-search.ts"

describe("web search", () => {
  test("a query is nonblank, at most 500 characters, NUL-free and the only key", () => {
    expect(() => validateWebSearchInput({ query: "latest bun release" })).not.toThrow()
    for (const bad of [{}, { query: "" }, { query: "   " }, { query: "x".repeat(501) }, { query: "a\0b" }, { query: "ok", extra: 1 }, { query: 1 }, null, []]) {
      expect(() => validateWebSearchInput(bad)).toThrow()
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
    expect(codex).toContain('web_search="live"')
    expect(codex).toContain("features.shell_tool=false")
    expect(codex).toContain("mcp_servers={}")
    expect(codex).toContain("--ignore-user-config")
    expect(codex.slice(codex.indexOf("-s"), codex.indexOf("-s") + 2)).toEqual(["-s", "read-only"])
    expect(codex.at(-1)).toBe("-")
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
    expect(parseWebSearchOutput("codex", codexOk.replace('"turn.completed"', '"turn.failed"'))).toBeUndefined()
    expect(parseWebSearchOutput("codex", codexOk.split("\n").slice(0, -1).join("\n"))).toBeUndefined()
    const claudeOk = [line({ type: "system", subtype: "init" }), "not json", line({ type: "result", subtype: "success", is_error: false, result: "Bun 1.4.5" })].join("\n")
    expect(parseWebSearchOutput("claude", claudeOk)).toBe("Bun 1.4.5")
    expect(parseWebSearchOutput("claude", line({ type: "result", subtype: "error_during_execution", is_error: true, result: "x" }))).toBeUndefined()
    expect(parseWebSearchOutput("claude", "")).toBeUndefined()
  })
})
