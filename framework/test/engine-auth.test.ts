// Engine sign-in delegates to the vendor CLIs; otter keeps only the signed-in verdict and the method label.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authStatus, describeAuth, loginArgv, loginHint, logoutArgv, parseAuthStatus, runVendorAuth } from "../src/hosts/engine-auth.ts"
import { usablePathEntry } from "../src/hosts/cli-transport.ts"

describe("engine CLI lookup under WSL", () => {
  test("Windows drive mounts never supply an engine CLI under WSL (their sign-in lives on the Windows side)", () => {
    for (const windows of ["/mnt/c/Users/me/AppData/Roaming/npm", "/mnt/c/Program Files/nodejs", "/mnt/d", "/MNT/C/tools"]) {
      expect(usablePathEntry(windows, true)).toBe(false)
      expect(usablePathEntry(windows, false)).toBe(true)
    }
    for (const linux of ["/home/me/.local/bin", "/home/me/.nvm/versions/node/v22/bin", "/usr/local/bin", "/mnt/data/bin", "/mnt"]) {
      expect(usablePathEntry(linux, true)).toBe(true)
    }
    expect(usablePathEntry("", false)).toBe(false)
  })

  test("a browser sign-in under WSL says what to do when the Windows browser or the localhost callback fails", () => {
    expect(loginHint("codex", "browser", true)).toContain("/login codex device")
    expect(loginHint("claude", "browser", true)).toContain("paste the code back")
    expect(loginHint("codex", "device", true)).toBeUndefined()
    expect(loginHint("codex", "browser", false)).toBeUndefined()
  })
})

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

  test("descriptions point at /login for a signed-out engine, and explain an environment-only key", () => {
    expect(describeAuth({ engine: "codex", state: "signed-in", method: "ChatGPT" })).toBe("codex: signed in (ChatGPT)")
    expect(describeAuth({ engine: "claude", state: "signed-out" })).toBe("claude: not signed in · /login claude")
    expect(describeAuth({ engine: "claude", state: "signed-out", envOnly: "ANTHROPIC_API_KEY" }))
      .toBe("claude: not signed in · ANTHROPIC_API_KEY is set, but otter never passes API keys to the CLI; sign in with /login claude (console uses API billing)")
    expect(describeAuth({ engine: "codex", state: "signed-out", envOnly: "OPENAI_API_KEY" })).toContain("/login codex (api-key stores a key in the CLI)")
  })

  test("claude JSON after a notice line is still read", () => {
    expect(parseAuthStatus("claude", 0, "Update available: 2.1.302\n{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}\n"))
      .toEqual({ engine: "claude", state: "signed-in", method: "claude.ai" })
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

  test("status sees exactly what a model call sees: the sign-in location is passed, an environment-only key is not", async () => {
    const bin = mkdtempSync(join(tmpdir(), "otter-auth-env-"))
    // Signed in only when the key is visible or the configured sign-in home is the one holding the login.
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nif [ -n \"$OPENAI_API_KEY\" ] || [ \"$CODEX_HOME\" = /fixture/signed-in ]; then echo 'Logged in using ChatGPT'; exit 0; fi\necho 'Not logged in'; exit 1\n")
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nif [ -n \"$ANTHROPIC_API_KEY\" ] || [ \"$CLAUDE_CONFIG_DIR\" = /fixture/signed-in ]; then echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}'; else echo '{\"loggedIn\":false}'; fi\n")
    chmodSync(join(bin, "codex"), 0o755)
    chmodSync(join(bin, "claude"), 0o755)
    const keys = ["PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    try {
      process.env.PATH = bin
      process.env.CODEX_HOME = "/fixture/signed-in"
      process.env.CLAUDE_CONFIG_DIR = "/fixture/signed-in"
      expect(await authStatus("codex", tmpdir())).toMatchObject({ state: "signed-in" })
      expect(await authStatus("claude", tmpdir())).toMatchObject({ state: "signed-in" })
      delete process.env.CODEX_HOME
      delete process.env.CLAUDE_CONFIG_DIR
      process.env.OPENAI_API_KEY = "sk-fixture"
      process.env.ANTHROPIC_API_KEY = "sk-ant-fixture"
      expect(await authStatus("codex", tmpdir())).toEqual({ engine: "codex", state: "signed-out", envOnly: "OPENAI_API_KEY" })
      expect(await authStatus("claude", tmpdir())).toEqual({ engine: "claude", state: "signed-out", envOnly: "ANTHROPIC_API_KEY" })
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  })

  test("vendor sign-in runs without credential variables, so the login lands in the CLI's own store", async () => {
    const bin = mkdtempSync(join(tmpdir(), "otter-auth-login-"))
    const out = join(bin, "seen")
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "key=\${ANTHROPIC_API_KEY:-none} home=\${CLAUDE_CONFIG_DIR:-none} browser=\${BROWSER:-none}" > ${out}\n`)
    chmodSync(join(bin, "claude"), 0o755)
    const keys = ["PATH", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "BROWSER"] as const
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    try {
      process.env.PATH = bin
      process.env.ANTHROPIC_API_KEY = "sk-ant-fixture"
      process.env.CLAUDE_CONFIG_DIR = "/fixture/claude"
      process.env.BROWSER = "wslview"
      expect(await runVendorAuth("claude", ["auth", "login"], tmpdir())).toEqual({ exitCode: 0, signal: null })
      expect(readFileSync(out, "utf8").trim()).toBe("key=none home=/fixture/claude browser=wslview")
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  })
})
