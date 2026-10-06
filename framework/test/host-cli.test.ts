import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseCliArgs, runCli } from "../src/hosts/cli.ts"
import { stateRoot } from "../src/state/store.ts"
import { tempWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempWorktree>
beforeEach(() => { wt = tempWorktree() })
afterEach(() => wt.cleanup())

describe("foreground CLI", () => {
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
    expect(() => parseCliArgs(["import", "--worktree", wt.worktree, "--session", "s", "--plan", "plan.json"])).toThrow("--server")
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
