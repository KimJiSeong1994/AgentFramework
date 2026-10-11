import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { CliUsageError, parseCliArgs, runCli } from "../src/hosts/cli.ts"
import { stateRoot } from "../src/state/store.ts"
import { tempWorktree } from "./guards-helpers.ts"
import { withTerminalLine } from "./operator-helpers.ts"

let wt: ReturnType<typeof tempWorktree>
beforeEach(() => { wt = tempWorktree() })
afterEach(() => wt.cleanup())

async function invokeCli(argv: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/hosts/cli.ts"), ...argv], {
    cwd: wt.worktree,
    env: { ...process.env, XDG_CONFIG_HOME: join(wt.stateHome, "config") },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function admissionServer(worktree: string, sessionID: string) {
  const plugin = pathToFileURL(join(realpathSync(worktree), ".opencode/plugins/lca.ts")).href
  const dangerous = ["edit", "write", "patch", "bash", "task", "delegate", "webfetch"]
  const denied = Object.fromEntries(dangerous.map(tool => [tool, "deny"]))
  const nativeRules = [{ permission: "*", pattern: "*", action: "allow" },
    ...dangerous.map(tool => ({ permission: tool, pattern: "*", action: "deny" }))]
  let parentReads = 0
  let sessionPosts = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname
    if (path === "/path") return Response.json({ worktree })
    if (path === "/config") return Response.json({ plugin: [plugin], agent: { reviewer: { mode: "subagent", permission: denied } } })
    if (path === "/agent") return Response.json([
      { name: "main", mode: "primary" }, { name: "worker", mode: "subagent" },
      { name: "reviewer", mode: "subagent", permission: nativeRules },
    ])
    if (req.method === "GET" && path === `/session/${sessionID}`) {
      parentReads++
      return Response.json({ id: sessionID, directory: worktree })
    }
    if (req.method === "POST" && path.startsWith("/session")) {
      sessionPosts++
      return Response.json({ id: "unexpected-child-session" })
    }
    return Response.json({})
  } })
  return { server, get parentReads() { return parentReads }, get sessionPosts() { return sessionPosts } }
}

describe("foreground CLI", () => {
  test("help flags print usage without touching state", async () => {
    for (const argv of [["--help"], ["-h"], ["chat", "--help"], ["chat", "-h"]]) {
      const result = await invokeCli(argv)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Usage:")
      expect(result.stdout).toContain("lca status --worktree")
      expect(result.stdout).toContain("lca run --plan")
      expect(result.stdout).toContain("Common-engine workflow recovery")
      expect(result.stdout).toContain("--engine local|codex|claude --model ID --session ID")
      expect(result.stdout).toContain("Standalone commands do not start a server")
      expect(result.stdout).toContain("--engine local|codex|claude")
      expect(result.stdout).toContain("/model <engine> <native-id>")
      expect(result.stdout).toContain("/help lists local commands")
      expect(result.stdout).toContain("input limits are estimated and output limits are reactive")
      expect(result.stdout).toContain("Interactive chat requires a terminal on stdin and stderr")
      expect(result.stdout).not.toContain("OpenCode TUI")
      expect(result.stderr).toBe("")
      expect(existsSync(stateRoot(wt.worktree))).toBe(false)
    }
  })

  test("bare chat and bare selection flags refuse non-TTY input before runtime construction", async () => {
    for (const argv of [
      [],
      ["chat", "--worktree", wt.worktree],
      ["--engine", "codex", "--model", "gpt-5-codex"],
      ["--model", "gpt-5-codex"],
    ]) {
      const result = await invokeCli(argv)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("chat requires an interactive terminal")
      expect(existsSync(stateRoot(wt.worktree))).toBe(false)
    }
  })

  test("valid status succeeds in a subprocess without creating state", async () => {
    const result = await invokeCli(["status", "--worktree", wt.worktree, "--json"])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ workflow: null })
    expect(result.stderr).toBe("")
    expect(existsSync(stateRoot(wt.worktree))).toBe(false)
  })

  test("malformed and missing arguments exit 2 with safe diagnostics and no state mutation", async () => {
    const secret = "cli-private-argument-sentinel"
    const cases = [
      { argv: ["status"], diagnostic: "--worktree is required" },
      { argv: ["status", "--worktree"], diagnostic: "missing value for --worktree" },
      { argv: ["status", "--worktree", wt.worktree, "--json", "--json"], diagnostic: "duplicate --json" },
      { argv: ["status", "--worktree", wt.worktree, "--session", secret, "--session", secret], diagnostic: "duplicate --session" },
      { argv: ["status", "--worktree", wt.worktree, `--${secret}`], diagnostic: "unknown option" },
      { argv: ["status", "--worktree", wt.worktree, "--engine", secret], diagnostic: "invalid --engine" },
      { argv: [secret], diagnostic: "unknown command" },
    ]
    for (const { argv, diagnostic } of cases) {
      const result = await invokeCli(argv)
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain(diagnostic)
      expect(result.stderr).toContain("lca --help")
      expect(result.stderr).not.toContain(secret)
      expect(existsSync(stateRoot(wt.worktree))).toBe(false)
    }
  })

  test("inaccessible worktree paths exit 2 without disclosing the supplied path", async () => {
    const privatePath = join(wt.worktree, "missing-private-worktree-sentinel")
    const result = await invokeCli(["status", "--worktree", privatePath])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("--worktree must name an accessible directory")
    expect(result.stderr).not.toContain(privatePath)
    expect(result.stdout).toBe("")
    expect(existsSync(stateRoot(wt.worktree))).toBe(false)
  })

  test("runtime configuration failures remain redacted", async () => {
    const secret = "private-config-sentinel"
    const config = join(wt.worktree, ".lca", "lca.jsonc")
    mkdirSync(join(wt.worktree, ".lca"), { recursive: true })
    writeFileSync(config, `{"private":"${secret}", broken`)
    const result = await invokeCli(["status", "--worktree", wt.worktree])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("lca: command refused or failed")
    expect(result.stderr).not.toContain(secret)
    expect(result.stderr).not.toContain(config)
    expect(result.stdout).toBe("")
    expect(existsSync(stateRoot(wt.worktree))).toBe(false)
  })

  test("admission refusals print a bounded actionable message without leaking input", async () => {
    const secret = "private-admission-control-sentinel"
    const sessionID = `ses_${secret}`
    const planPath = `revision-${secret}.json`
    writeFileSync(join(wt.worktree, planPath), JSON.stringify({
      goal: "fix the bug",
      steps: [
        { title: "one", files: ["src/a.py"], detail: "d", verify: "sh verify-a.test.sh" },
        { title: "two", files: ["src/b.py"], detail: "d", verify: "sh verify-b.test.sh" },
        { title: "three", files: ["src/c.py"], detail: "d", verify: "sh verify-c.test.sh" },
      ],
      risks: ["might break x"],
      revision: 1,
    }))
    mkdirSync(join(wt.worktree, ".lca"), { recursive: true })

    for (const disabledHooks of [["config.agents"], []]) {
      writeFileSync(join(wt.worktree, ".lca/lca.jsonc"), JSON.stringify({ disabled_hooks: disabledHooks, flow: { enabled: true } }))
      const fixture = admissionServer(wt.worktree, sessionID)
      try {
        const result = await invokeCli(["import", "--worktree", wt.worktree, "--server", `http://127.0.0.1:${fixture.server.port}`,
          "--session", sessionID, "--plan", planPath])
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("host admission refused")
        expect(result.stderr).toContain("required host control evidence is unavailable")
        expect(result.stderr).toContain("required execution controls")
        expect(result.stderr).not.toContain(secret)
        expect(result.stderr).not.toContain("OpenCode plugin does not provide")
        expect(result.stderr).not.toContain(planPath)
        expect(fixture.parentReads).toBe(1)
        expect(fixture.sessionPosts).toBe(0)
        expect(existsSync(stateRoot(wt.worktree))).toBe(false)
      } finally { fixture.server.stop(true) }
    }
  })

  test("run with an imported plan refuses admission before creating a parent session", async () => {
    const sessionID = "ses_unused"
    const source = join(wt.worktree, "revision.json")
    writeFileSync(source, JSON.stringify({
      goal: "fix the bug",
      steps: [
        { title: "one", files: ["src/a.py"], detail: "d", verify: "sh verify-a.test.sh" },
        { title: "two", files: ["src/b.py"], detail: "d", verify: "sh verify-b.test.sh" },
        { title: "three", files: ["src/c.py"], detail: "d", verify: "sh verify-c.test.sh" },
      ],
      risks: ["might break x"],
      revision: 1,
    }))
    mkdirSync(join(wt.worktree, ".lca"), { recursive: true })
    writeFileSync(join(wt.worktree, ".lca/lca.jsonc"), JSON.stringify({ flow: { enabled: true } }))
    const fixture = admissionServer(wt.worktree, sessionID)
    try {
      const args = parseCliArgs(["run", "--worktree", wt.worktree, "--server", `http://127.0.0.1:${fixture.server.port}`,
        "--plan", "revision.json"])
      await withTerminalLine("", async () => {
        await expect(runCli(args)).rejects.toThrow("required control statuses unavailable")
      })
      expect(fixture.sessionPosts).toBe(0)
      expect(fixture.parentReads).toBe(0)
      expect(existsSync(stateRoot(wt.worktree))).toBe(false)
    } finally { fixture.server.stop(true) }
  })

  test("invalid server addresses are usage errors before config or server access", async () => {
    const secret = "private-config-sentinel"
    mkdirSync(join(wt.worktree, ".lca"), { recursive: true })
    writeFileSync(join(wt.worktree, ".lca", "lca.jsonc"), `{"private":"${secret}", broken`)
    const result = await invokeCli(["run", "--worktree", wt.worktree, "--server", "https://192.0.2.1:4096", "--session", "ses_local"])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("loopback IP")
    expect(result.stderr).not.toContain(secret)
    expect(result.stderr).toContain("lca --help")
    expect(existsSync(stateRoot(wt.worktree))).toBe(false)
  })

  test("status is read-only without a server, SDK session, credential, or model", async () => {
    const args = parseCliArgs(["status", "--worktree", wt.worktree, "--json"])
    expect(existsSync(stateRoot(wt.worktree))).toBe(false)
    const status = JSON.parse(await runCli(args))
    expect(status.workflow).toBeNull()
    expect(status.execution).toMatchObject({ unresolved: 0, usage: "unknown" })
    expect(existsSync(stateRoot(wt.worktree))).toBe(false)
  })

  test("corrupt workflow status cannot repair or rename state", async () => {
    const folder = join(stateRoot(wt.worktree), "workflow")
    mkdirSync(folder, { recursive: true })
    const file = join(folder, "workflow.json")
    writeFileSync(file, "{ invalid json")
    await expect(runCli(parseCliArgs(["status", "--worktree", wt.worktree]))).rejects.toThrow()
    expect(readFileSync(file, "utf8")).toBe("{ invalid json")
    expect(readdirSync(folder)).toEqual(["workflow.json"])
  })

  test("competing plugins and conflicting reviewer configuration refuse admission before session/model execution", async () => {
    const plugin = pathToFileURL(join(realpathSync(wt.worktree), ".opencode/plugins/lca.ts")).href
    const dangerous = ["edit", "write", "patch", "bash", "task", "delegate", "webfetch"]
    const denied = Object.fromEntries(dangerous.map(tool => [tool, "deny"]))
    const nativeRules = [{ permission: "*", pattern: "*", action: "allow" },
      ...dangerous.map(tool => ({ permission: tool, pattern: "*", action: "deny" }))]
    let sessions = 0
    const cases = [
      { plugins: [plugin, "oh-my-openagent"], mode: "subagent", override: false, expected: "only the project LCA plugin" },
      { plugins: [plugin], mode: "primary", override: false, expected: "reviewer agent or model conflicts" },
      { plugins: [plugin], mode: "subagent", override: true, expected: "reviewer agent or model conflicts" },
    ]
    writeFileSync(join(wt.worktree, "revision.json"), JSON.stringify({ revision: 2 }))
    const servers: Array<ReturnType<typeof Bun.serve>> = []
    try { for (const { plugins, mode, override, expected } of cases) {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/path") return Response.json({ worktree: wt.worktree })
        if (path === "/config") return Response.json({ plugin: plugins, agent: { reviewer: { mode, permission: denied } } })
        if (path === "/agent") return Response.json([
          { name: "main", mode: "primary" }, { name: "worker", mode: "subagent" },
          { name: "reviewer", mode: "subagent", permission: override ? [...nativeRules,
            { permission: "write", pattern: "fixture.py", action: "allow" }] : nativeRules },
        ])
        sessions++
        return Response.json({ id: "should-not-be-created" })
      } })
      servers.push(server)
      const args = parseCliArgs(["run", "--worktree", wt.worktree, "--server", `http://127.0.0.1:${server.port}`,
        "--session", "ses_local"])
      await expect(runCli(args)).rejects.toThrow(expected)
      expect(sessions).toBe(0)
      expect(existsSync(stateRoot(wt.worktree))).toBe(false)
    } } finally { for (const server of servers) server.stop(true) }
  })

  test("disabled execution policy hooks refuse imported plans before child session creation or prompts", async () => {
    const plugin = pathToFileURL(join(realpathSync(wt.worktree), ".opencode/plugins/lca.ts")).href
    const dangerous = ["edit", "write", "patch", "bash", "task", "delegate", "webfetch"]
    const denied = Object.fromEntries(dangerous.map(tool => [tool, "deny"]))
    const nativeRules = [{ permission: "*", pattern: "*", action: "allow" },
      ...dangerous.map(tool => ({ permission: tool, pattern: "*", action: "deny" }))]
    const plan = {
      goal: "fix the bug",
      steps: [
        { title: "one", files: ["src/a.ts"], detail: "d", verify: "sh verify-a.test.sh" },
        { title: "two", files: ["src/b.ts"], detail: "d", verify: "sh verify-b.test.sh" },
        { title: "three", files: ["src/c.ts"], detail: "d", verify: "sh verify-c.test.sh" },
      ],
      risks: ["might break x"],
      revision: 1,
    }
    writeFileSync(join(wt.worktree, "revision.json"), JSON.stringify(plan))
    mkdirSync(join(wt.worktree, ".lca"), { recursive: true })

    for (const disabledHook of ["config.agents", "chat.params"]) {
      writeFileSync(join(wt.worktree, ".lca/lca.jsonc"), JSON.stringify({
        disabled_hooks: [disabledHook], flow: { enabled: true },
      }))
      let parentReads = 0
      const sessionPosts: string[] = []
      let promptPosts = 0
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/path") return Response.json({ worktree: wt.worktree })
        if (path === "/config") return Response.json({ plugin: [plugin], agent: { reviewer: { mode: "subagent", permission: denied } } })
        if (path === "/agent") return Response.json([
          { name: "main", mode: "primary" }, { name: "worker", mode: "subagent" },
          { name: "reviewer", mode: "subagent", permission: nativeRules },
        ])
        if (req.method === "GET" && path === "/session/ses_parent") {
          parentReads++
          return Response.json({ id: "ses_parent", directory: wt.worktree })
        }
        if (req.method === "POST" && path.startsWith("/session")) {
          sessionPosts.push(path)
          if (path.includes("/message")) promptPosts++
          return Response.json({ id: "unexpected-child-session" })
        }
        return Response.json({})
      } })
      try {
        const args = parseCliArgs(["import", "--worktree", wt.worktree, "--server", `http://127.0.0.1:${server.port}`,
          "--session", "ses_parent", "--plan", "revision.json"])
        await expect(runCli(args)).rejects.toThrow("host incompatible")
        expect(parentReads).toBe(1)
        expect(sessionPosts).toEqual([])
        expect(promptPosts).toBe(0)
        expect(existsSync(stateRoot(wt.worktree))).toBe(false)
      } finally { server.stop(true) }
    }
  })

  test("noninteractive integrated plan refuses before any server request or session mutation", async () => {
    const source = join(wt.worktree, "revision.json")
    writeFileSync(source, JSON.stringify({ revision: 2 }))
    const args = parseCliArgs(["run", "--worktree", wt.worktree, "--server", "http://127.0.0.1:49999",
      "--plan", "revision.json"])
    await expect(runCli(args)).rejects.toThrow("interactive terminal")
    expect(existsSync(stateRoot(wt.worktree))).toBe(false)
  })

  test("a later native wildcard allow cannot reopen reviewer tools after explicit denials", async () => {
    const plugin = pathToFileURL(join(realpathSync(wt.worktree), ".opencode/plugins/lca.ts")).href
    const dangerous = ["edit", "write", "patch", "bash", "task", "delegate", "webfetch"]
    const permissions = Object.fromEntries(dangerous.map(tool => [tool, "deny"]))
    const rules = [{ permission: "*", pattern: "*", action: "allow" },
      ...dangerous.map(tool => ({ permission: tool, pattern: "*", action: "deny" })),
      { permission: "*", pattern: "*", action: "allow" }]
    writeFileSync(join(wt.worktree, "revision.json"), JSON.stringify({ revision: 1 }))
    let sessions = 0
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const path = new URL(req.url).pathname
      if (path === "/path") return Response.json({ worktree: wt.worktree })
      if (path === "/config") return Response.json({ plugin: [plugin], agent: { reviewer: { mode: "subagent", permission: permissions } } })
      if (path === "/agent") return Response.json([
        { name: "main", mode: "primary" }, { name: "worker", mode: "subagent" },
        { name: "reviewer", mode: "subagent", permission: rules },
      ])
      sessions++
      return Response.json({ id: "should-not-be-created" })
    } })
    try {
      const args = parseCliArgs(["run", "--worktree", wt.worktree, "--server", `http://127.0.0.1:${server.port}`, "--session", "ses_local"])
      await expect(runCli(args)).rejects.toThrow("reviewer agent or model conflicts")
      expect(sessions).toBe(0)
      expect(existsSync(stateRoot(wt.worktree))).toBe(false)
    } finally { server.stop(true) }
  })

  test("mutations need an explicit local server, while options reject duplicates", () => {
    expect(() => parseCliArgs(["import", "--worktree", wt.worktree, "--session", "s", "--plan", "plan.json"])).toThrow(CliUsageError)
    expect(() => parseCliArgs(["import", "--worktree", wt.worktree, "--session", "s", "--plan", "plan.json"])).toThrow("--server")
    expect(() => parseCliArgs(["resume", "--worktree", wt.worktree])).toThrow("explicit --engine, --model, and --session")
    expect(() => parseCliArgs(["resume", "--worktree", wt.worktree, "--engine", "local", "--session", "s"])).toThrow("--model")
    expect(() => parseCliArgs(["approve", "--worktree", wt.worktree, "--engine", "local", "--model", "m", "--workflow", "w", "--sha", "h"])).toThrow("--session")
    expect(() => parseCliArgs(["cancel", "--worktree", wt.worktree, "--engine", "local", "--model", "m", "--session", "s", "--server", "http://127.0.0.1:4096"])).toThrow("does not accept --server")
    const common = parseCliArgs(["resume", "--worktree", wt.worktree, "--engine", "local", "--model", "llama3.2:3b", "--session", "s"])
    expect(common).toMatchObject({ command: "resume", engine: "local", model: "llama3.2:3b", session: "s" })
    const opencode = parseCliArgs(["resume", "--worktree", wt.worktree, "--server", "http://127.0.0.1:4096", "--session", "s"])
    expect(opencode).toMatchObject({ engine: "opencode", server: "http://127.0.0.1:4096", session: "s" })
    expect(() => parseCliArgs(["resume", "--worktree", wt.worktree, "--server", "http://127.0.0.1:4096"])).toThrow("--session")
    expect(() => parseCliArgs(["status", "--worktree", wt.worktree, "--worktree", wt.worktree])).toThrow("duplicate")
    expect(() => parseCliArgs(["status", "--worktree", wt.worktree, "--json", "--json"])).toThrow("duplicate")
  })

  test("remote and hostname-based services are refused before any SDK request", async () => {
    for (const server of ["https://127.0.0.1:4096", "http://localhost:4096", "http://192.0.2.1:4096", "http://127.0.0.1:4096/prefix"]) {
      await expect(runCli(parseCliArgs(["resume", "--worktree", wt.worktree, "--server", server, "--session", "ses_local"]))).rejects.toThrow("loopback IP")
    }
  })
})
