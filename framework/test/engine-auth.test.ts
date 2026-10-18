// Engine sign-in delegates to the vendor CLIs; otter keeps only the signed-in verdict and the method label.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authStatus, describeAuth, loginArgv, logoutArgv, parseAuthStatus } from "../src/hosts/engine-auth.ts"

describe("vendor auth commands", () => {
  test("login/logout map to the vendor's own commands; unsupported methods are refused", () => {
    expect(loginArgv("codex")).toEqual(["login"])
    expect(loginArgv("codex", "device")).toEqual(["login", "--device-auth"])
    expect(loginArgv("codex", "api-key")).toEqual(["login", "--with-api-key"])
    expect(loginArgv("claude")).toEqual(["auth", "login"])
    expect(loginArgv("claude", "console")).toEqual(["auth", "login", "--console"])
    expect(() => loginArgv("codex", "console")).toThrow("codex has no Anthropic Console sign-in")
    expect(() => loginArgv("claude", "device")).toThrow("claude does not offer device sign-in")
    expect(logoutArgv("codex")).toEqual(["logout"])
    expect(logoutArgv("claude")).toEqual(["auth", "logout"])
  })
})

describe("status parsing keeps only the verdict and method", () => {
  test("claude JSON: account identity (email, org) is never kept", () => {
    const signedIn = parseAuthStatus("claude", 0, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "me@example.com", orgId: "org-1", orgName: "Mine" }))
    expect(signedIn).toEqual({ engine: "claude", state: "signed-in", method: "claude.ai" })
    expect(JSON.stringify(signedIn)).not.toContain("example.com")
    expect(parseAuthStatus("claude", 1, JSON.stringify({ loggedIn: false, authMethod: "none" }))).toEqual({ engine: "claude", state: "signed-out" })
    expect(parseAuthStatus("claude", 0, "not json")).toMatchObject({ state: "unknown" })
    // A method label that is not a plain short word is dropped, not echoed.
    expect(parseAuthStatus("claude", 0, JSON.stringify({ loggedIn: true, authMethod: "\u001b[2Jx" }))).toEqual({ engine: "claude", state: "signed-in" })
  })

  test("codex text status", () => {
    expect(parseAuthStatus("codex", 0, "Logged in using ChatGPT\n")).toEqual({ engine: "codex", state: "signed-in", method: "ChatGPT" })
    expect(parseAuthStatus("codex", 0, "Logged in using an API key - sk-proj-***ABCD\n")).toEqual({ engine: "codex", state: "signed-in" })
    expect(parseAuthStatus("codex", 1, "Not logged in\n")).toEqual({ engine: "codex", state: "signed-out" })
    expect(parseAuthStatus("codex", 2, "boom")).toMatchObject({ state: "unknown" })
  })

  test("descriptions point at /login for a signed-out engine", () => {
    expect(describeAuth({ engine: "codex", state: "signed-in", method: "ChatGPT" })).toBe("codex: signed in (ChatGPT)")
    expect(describeAuth({ engine: "claude", state: "signed-out" })).toBe("claude: not signed in · /login claude")
  })
})

describe("authStatus runs the vendor CLI found on PATH", () => {
  test("a fake vendor CLI is asked for status; a missing CLI is unknown, not signed in", async () => {
    const bin = mkdtempSync(join(tmpdir(), "otter-auth-bin-"))
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n[ \"$1 $2\" = \"login status\" ] && { echo 'Not logged in'; exit 1; }\nexit 3\n")
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"email\":\"x@y.z\"}'\n")
    chmodSync(join(bin, "codex"), 0o755)
    chmodSync(join(bin, "claude"), 0o755)
    const saved = process.env.PATH
    try {
      process.env.PATH = bin
      expect(await authStatus("codex", tmpdir())).toEqual({ engine: "codex", state: "signed-out" })
      expect(await authStatus("claude", tmpdir())).toEqual({ engine: "claude", state: "signed-in", method: "claude.ai" })
      process.env.PATH = mkdtempSync(join(tmpdir(), "otter-auth-empty-"))
      expect(await authStatus("codex", tmpdir())).toEqual({ engine: "codex", state: "unknown", reason: "codex CLI not found on PATH" })
    } finally {
      process.env.PATH = saved
    }
  })
})
