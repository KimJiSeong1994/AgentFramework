import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { CliUsageError, parseCliArgs, runCli } from "../src/hosts/cli.ts"
import { currentOwner } from "../src/flow/owner.ts"
import { eventsPath, newWorkflow, workflowPath, withFlowTransaction } from "../src/flow/state.ts"
import { writeWorkflow } from "./commit-fixture.ts"
import { addTasks, emptyLedger, ledgerPath, updateTask, writeLedger } from "../src/state/ledger.ts"
import { createExecutionRunStore } from "../src/hosts/run-state.ts"
import { executionRunDirectory, modeStatePath, stateRoot } from "../src/state/store.ts"
import { tempWorktree } from "./guards-helpers.ts"
import { withTerminalLine } from "./operator-helpers.ts"

let wt: ReturnType<typeof tempWorktree>
beforeEach(() => { wt = tempWorktree() })
afterEach(() => wt.cleanup())

async function invokeCli(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/hosts/cli.ts"), ...argv], {
    cwd: wt.worktree,
    env: { ...process.env, XDG_CONFIG_HOME: join(wt.stateHome, "config"), ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function fakeCodexCli(script: string): NodeJS.ProcessEnv {
  const bin = join(wt.worktree, "fake-cli-secret-path")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, "codex"), script, { mode: 0o755 })
  return { PATH: bin }
}

async function statusSubprocess(args: string[]) {
  return invokeCli(["status", "--worktree", wt.worktree, ...args])
}

async function statusWatchSubprocess(args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/hosts/cli.ts"), "status", "--worktree", wt.worktree, ...args], {
    cwd: wt.worktree,
    env: { ...process.env, XDG_CONFIG_HOME: join(wt.stateHome, "config") },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  let resolveFirst!: (line: string) => void
  let rejectFirst!: (error: Error) => void
  const firstLine = new Promise<string>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject })
  const stdout = (async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    let resolved = false
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      output += decoder.decode(value, { stream: true })
      if (!resolved) {
        const newline = output.indexOf("\n")
        if (newline >= 0) { resolved = true; resolveFirst(output.slice(0, newline)) }
      }
    }
    if (!resolved) rejectFirst(new Error(`watch exited before an NDJSON frame: ${output}`))
    return output
  })()
  const stderr = new Response(child.stderr).text()
  try { await firstLine }
  catch (error) { child.kill("SIGKILL"); await child.exited; throw error }
  child.kill("SIGTERM")
  await child.exited
  return { exitCode: child.exitCode, firstLine: await firstLine, stdout: await stdout, stderr: await stderr }
}

const SESSION = "ses_cli_status"

function newStatusWorkflow(sessionID: string, request: string) {
  return newWorkflow(sessionID, { instance: "fixture", pid: process.pid, heartbeatAt: Date.now() }, "command", request, "opencode")
}

function writeStatusWorkflow(workflow: ReturnType<typeof newStatusWorkflow>) {
  return withFlowTransaction(wt.worktree, tx => writeWorkflow(tx, workflow))
}

const SECRET_MARKERS = [
  "workflow-request-secret", "workflow-counter-secret", "task-detail-secret", "task-report-secret", "task-sql-secret",
  "task-answer-secret", "task-handoff-secret", "task-error-secret", "task-blocked-secret", "task-verify-command-secret",
  "task-verify-output-secret", "task-review-reason-secret", "task-review-session-secret",
]

function plantStatusSecrets() {
  const wf = writeStatusWorkflow({
    ...newStatusWorkflow(SESSION, "safe default"),
    phase: "executing",
    request: "workflow-request-secret",
    counters: { code_invalid: 0, review_iterations: 0, user_rejections: 0, nudges: 0, private: "workflow-counter-secret" },
  } as any)
  const primary = addTasks(emptyLedger(SESSION), [{ title: "Benign approved task", kind: "data", wf: { id: wf.id, planSha: "safe-plan-sha" } }])
  const task = primary.added[0]!
  writeLedger(wt.worktree, updateTask(primary.ledger, task.id, {
    status: "failed", attempts: 1, startedAt: 10, finishedAt: 20,
    detail: "task-detail-secret", report: "task-report-secret", sql: "task-sql-secret", answer: "task-answer-secret",
    handoff: "task-handoff-secret", error: "task-error-secret", blocked: "task-blocked-secret",
    verify: "task-verify-command-secret", verify_result: {
      command: "task-verify-command-secret", ok: false, exitCode: 1, timedOut: false, output: "task-verify-output-secret",
    },
    review: { verdict: "reject", reason: "task-review-reason-secret", sessionID: "task-review-session-secret", aborted: false },
    filesChanged: ["src/safe.ts"],
  }))
  const extra = addTasks(emptyLedger("ses_cli_other"), [{ title: "Benign extra task" }])
  writeLedger(wt.worktree, extra.ledger)
}

function readIfPresent(path: string) {
  try { return readFileSync(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
}

function statusInputSnapshot() {
  return [workflowPath(wt.worktree), ledgerPath(wt.worktree, SESSION), ledgerPath(wt.worktree, "ses_cli_other"),
    modeStatePath(wt.worktree, SESSION), eventsPath(wt.worktree), join(executionRunDirectory(wt.worktree), "state.json")].map(path => [path, readIfPresent(path)])
}

function admissionServer(worktree: string, sessionID: string) {
  const plugin = pathToFileURL(join(realpathSync(worktree), ".opencode/plugins/otter.ts")).href
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
      expect(result.stdout).toContain("otter status --worktree")
      expect(result.stdout).toContain("otter run --plan")
      expect(result.stdout).toContain("Common-engine workflow commands")
      expect(result.stdout).toContain("--engine local|codex|claude --model ID --session ID")
      expect(result.stdout).toContain("Standalone commands do not start a server")
      expect(result.stdout).toContain("--engine local|codex|claude")
      expect(result.stdout).toContain("/model <engine> <native-id>")
      expect(result.stdout).toContain("/help lists local commands")
      expect(result.stdout).toContain("/skill:deep-interview <request>")
      expect(result.stdout).toContain("/skill:ralplan <request>")
      expect(result.stdout).toContain("invoking a name is not consent to execute")
      expect(result.stdout).toContain("/skill:ultragoal <objective>")
      expect(result.stdout).toContain("/skill:autoresearch <mission>")
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
      expect(result.stderr).toContain("otter --help")
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
    const config = join(wt.worktree, ".otter", "otter.jsonc")
    mkdirSync(join(wt.worktree, ".otter"), { recursive: true })
    writeFileSync(config, `{"private":"${secret}", broken`)
    const result = await invokeCli(["status", "--worktree", wt.worktree])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("otter: command refused or failed")
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
    mkdirSync(join(wt.worktree, ".otter"), { recursive: true })

    for (const disabledHooks of [["config.agents"], []]) {
      writeFileSync(join(wt.worktree, ".otter/otter.jsonc"), JSON.stringify({ disabled_hooks: disabledHooks, flow: { enabled: true } }))
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
    mkdirSync(join(wt.worktree, ".otter"), { recursive: true })
    writeFileSync(join(wt.worktree, ".otter/otter.jsonc"), JSON.stringify({ flow: { enabled: true } }))
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
    mkdirSync(join(wt.worktree, ".otter"), { recursive: true })
    writeFileSync(join(wt.worktree, ".otter", "otter.jsonc"), `{"private":"${secret}", broken`)
    const result = await invokeCli(["run", "--worktree", wt.worktree, "--server", "https://192.0.2.1:4096", "--session", "ses_local"])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("loopback IP")
    expect(result.stderr).not.toContain(secret)
    expect(result.stderr).toContain("otter --help")
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
    const plugin = pathToFileURL(join(realpathSync(wt.worktree), ".opencode/plugins/otter.ts")).href
    const dangerous = ["edit", "write", "patch", "bash", "task", "delegate", "webfetch"]
    const denied = Object.fromEntries(dangerous.map(tool => [tool, "deny"]))
    const nativeRules = [{ permission: "*", pattern: "*", action: "allow" },
      ...dangerous.map(tool => ({ permission: tool, pattern: "*", action: "deny" }))]
    let sessions = 0
    const cases = [
      { plugins: [plugin, "oh-my-openagent"], mode: "subagent", override: false, expected: "only the project Otter plugin" },
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
    const plugin = pathToFileURL(join(realpathSync(wt.worktree), ".opencode/plugins/otter.ts")).href
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
    mkdirSync(join(wt.worktree, ".otter"), { recursive: true })

    for (const disabledHook of ["config.agents", "chat.params"]) {
      writeFileSync(join(wt.worktree, ".otter/otter.jsonc"), JSON.stringify({
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
    const plugin = pathToFileURL(join(realpathSync(wt.worktree), ".opencode/plugins/otter.ts")).href
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

  test("status read failures exit 3 and reveal only source and code", async () => {
    mkdirSync(join(stateRoot(wt.worktree), "workflow"), { recursive: true })
    writeFileSync(workflowPath(wt.worktree), JSON.stringify({ secret: "must-not-leak" }))
    const result = await statusSubprocess([])
    expect(result).toEqual({ exitCode: 3, stdout: "", stderr: "otter status: workflow invalid_state\n" })
    expect(result.stderr).not.toContain("must-not-leak")
  })

  test("subprocess status distinguishes live, dead, orphaned, and fenced claims", async () => {
    const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" })
    try {
      const created = addTasks(emptyLedger(SESSION), [{ title: "CLI classifier" }])
      const task = created.added[0]!
      const running = updateTask(created.ledger, task.id, { status: "running", attempts: 1 })
      writeLedger(wt.worktree, { ...running, running: { taskId: task.id, since: 100 } })
      let runs = createExecutionRunStore(wt.worktree)
      runs.claim(SESSION, "live-child", owner.pid)

      const live = await statusSubprocess(["--session", SESSION, "--json"])
      expect(live.exitCode).toBe(0)
      expect(JSON.parse(live.stdout)).toMatchObject({ session: { queue: { state: "running_elsewhere", evidence: "claim_pid_alive" }, queueRunning: true } })

      owner.kill("SIGTERM")
      await owner.exited
      const dead = await statusSubprocess(["--session", SESSION, "--json"])
      expect(JSON.parse(dead.stdout)).toMatchObject({ session: { queue: { state: "stale", evidence: "claim_pid_dead" }, queueRunning: false } })

      rmSync(join(executionRunDirectory(wt.worktree), "state.json"), { force: true })
      const orphan = await statusSubprocess(["--session", SESSION, "--json"])
      expect(JSON.parse(orphan.stdout)).toMatchObject({ session: { queue: { state: "stale", evidence: "running_without_matching_claim" }, queueRunning: false } })

      runs = createExecutionRunStore(wt.worktree)
      const claim = runs.claim(SESSION, "fenced-owner", process.pid)
      runs.registerIntent(claim, { executionId: "fenced", ownerSession: SESSION, taskId: task.id, attemptId: "attempt",
        generation: claim.generation, role: "worker", cwd: wt.worktree, policyID: "fixture", kind: "host", engine: "opencode", profile: "legacy-unowned" })
      runs.fence(claim, "fenced", "unresolved child")
      const fenced = await statusSubprocess(["--session", SESSION, "--json"])
      expect(JSON.parse(fenced.stdout)).toMatchObject({ session: { queue: { state: "blocked", evidence: "claim_retained_unresolved" }, queueRunning: false } })
    } finally {
      if (owner.exitCode === null) owner.kill("SIGKILL")
    }
  })

  test("subprocess status reports typed non-workflow errors and preserves usage exit two", async () => {
    const root = stateRoot(wt.worktree)
    const runStatePath = join(executionRunDirectory(wt.worktree), "state.json")
    const cases = [
      { source: "ledger", setup: () => { mkdirSync(join(root, "sessions", SESSION), { recursive: true }); writeFileSync(ledgerPath(wt.worktree, SESSION), "{") }, code: "invalid_state" },
      { source: "mode", setup: () => { mkdirSync(join(root, "sessions", SESSION), { recursive: true }); writeFileSync(modeStatePath(wt.worktree, SESSION), "{}") }, code: "invalid_state" },
      { source: "execution", setup: () => { mkdirSync(executionRunDirectory(wt.worktree), { recursive: true }); writeFileSync(runStatePath, "{") }, code: "invalid_state" },
      { source: "events", setup: () => { writeStatusWorkflow(newStatusWorkflow(SESSION, "fixture")); mkdirSync(eventsPath(wt.worktree), { recursive: true }) }, code: "unreadable" },
    ]
    for (const row of cases) {
      rmSync(root, { recursive: true, force: true })
      rmSync(runStatePath, { force: true })
      row.setup()
      const result = await statusSubprocess(["--session", SESSION])
      expect(result).toEqual({ exitCode: 3, stdout: "", stderr: `otter status: ${row.source} ${row.code}\n` })
    }

    const argumentError = await statusSubprocess(["--json", "--watch", "--interval", "0"])
    expect(argumentError).toEqual({ exitCode: 2, stdout: "", stderr: "otter: --interval must be an integer from 1 to 60\nRun 'otter --help' for usage.\n" })
  })

  test("status details and watch flags are scoped and validated", async () => {
    const args = parseCliArgs(["status", "--worktree", wt.worktree, "--json", "--detail"])
    const status = JSON.parse(await runCli(args))
    expect(status.schemaVersion).toBe(1)
    expect(status.detail).toMatchObject({ tasks: [], sessions: [], history: [], events: [] })
    const watch = parseCliArgs(["status", "--worktree", wt.worktree, "--json", "--watch", "--interval", "3"])
    expect(watch).toMatchObject({ watch: true, interval: 3 })
    expect(() => parseCliArgs(["status", "--worktree", wt.worktree, "--watch"])).toThrow("requires a TTY")
    expect(() => parseCliArgs(["status", "--worktree", wt.worktree, "--interval", "3"])).toThrow("requires --watch")
    expect(() => parseCliArgs(["status", "--worktree", wt.worktree, "--json", "--watch", "--interval", "61"])).toThrow("integer from 1 to 60")
    expect(() => parseCliArgs(["resume", "--worktree", wt.worktree, "--server", "http://127.0.0.1:4096", "--detail"])).toThrow("only available for status")
  })

  test("watch rejects unexpected stat errors and restores signal listeners", async () => {
    const args = parseCliArgs(["status", "--worktree", wt.worktree, "--json", "--watch", "--interval", "3"])
    const listenersBefore = { sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") }
    const failure = new Error("unexpected status stat failure")
    const original = fs.statSync
    const stat = spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike) => {
      if (String(target) === workflowPath(wt.worktree)) throw failure
      return original(target)
    }) as typeof fs.statSync)
    try {
      let caught: unknown
      try { await runCli(args) } catch (error) { caught = error }
      expect(caught).toBe(failure)
      expect({ sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") }).toEqual(listenersBefore)
    } finally {
      stat.mockRestore()
    }
  })

  test("valid workflow and task free-form secrets are absent from CLI text, JSON, and detail surfaces", async () => {
    plantStatusSecrets()
    const before = statusInputSnapshot()
    const text = await runCli(parseCliArgs(["status", "--worktree", wt.worktree, "--session", SESSION]))
    const jsonText = await runCli(parseCliArgs(["status", "--worktree", wt.worktree, "--session", SESSION, "--json"]))
    const detailText = await runCli(parseCliArgs(["status", "--worktree", wt.worktree, "--session", SESSION, "--detail"]))
    const detailJsonText = await runCli(parseCliArgs(["status", "--worktree", wt.worktree, "--session", SESSION, "--json", "--detail"]))
    for (const output of [text, jsonText, detailText, detailJsonText]) {
      for (const secret of SECRET_MARKERS) expect(output).not.toContain(secret)
    }
    expect(text.split("\n").length).toBeLessThanOrEqual(25)
    const concise = JSON.parse(jsonText)
    expect(concise.detail).toBeUndefined()
    expect(concise.workflow.counters).toEqual({ code_invalid: 0, review_iterations: 0, user_rejections: 0, nudges: 0 })
    const detailTextStart = detailText.indexOf("\n{")
    expect(detailTextStart).toBeGreaterThan(0)
    expect(JSON.parse(detailText.slice(detailTextStart + 1)).tasks[0]).toMatchObject({
      id: "t1", title: "Benign approved task", blocked: true, verify: { ok: false, exitCode: 1, timedOut: false }, review: { verdict: "reject" },
    })
    const detailJson = JSON.parse(detailJsonText)
    expect(detailJson.detail.tasks[0]).toMatchObject({ id: "t1", title: "Benign approved task", blocked: true })
    expect(detailJson.detail.sessions).toContainEqual(expect.objectContaining({ id: "ses_cli_other" }))
    expect(statusInputSnapshot()).toEqual(before)
  })

  test("watch NDJSON frames exclude valid workflow and task free-form secrets without mutating state", async () => {
    plantStatusSecrets()
    const before = statusInputSnapshot()
    const result = await statusWatchSubprocess(["--session", SESSION, "--json", "--detail", "--watch", "--interval", "1"])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.firstLine).toBe(result.stdout.slice(0, result.stdout.indexOf("\n")))
    const frames = result.stdout.trim().split("\n").map(line => JSON.parse(line))
    expect(frames[0]).toMatchObject({ type: "snapshot", reason: "initial", status: { detail: { tasks: [{ id: "t1", title: "Benign approved task" }] } } })
    for (const secret of SECRET_MARKERS) expect(result.stdout).not.toContain(secret)
    expect(statusInputSnapshot()).toEqual(before)
  })

  test("remote and hostname-based services are refused before any SDK request", async () => {
    for (const server of ["https://127.0.0.1:4096", "http://localhost:4096", "http://192.0.2.1:4096", "http://127.0.0.1:4096/prefix"]) {
      await expect(runCli(parseCliArgs(["resume", "--worktree", wt.worktree, "--server", server, "--session", "ses_local"]))).rejects.toThrow("loopback IP")
    }
  })
})

describe("auth CLI subprocess failure handling", () => {
  test("login keeps the existing message when the CLI is missing", async () => {
    const env = fakeCodexCli("#!/bin/sh\nexit 0\n")
    fs.rmSync(join(env.PATH!, "codex"))
    const result = await invokeCli(["login", "codex"], env)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("codex CLI not found on PATH.")
    expect(result.stderr).not.toContain("fake-cli-secret-path")
  })

  test("auth status distinguishes an inaccessible CLI from a missing one", async () => {
    const env = fakeCodexCli("#!/bin/sh\necho 'Logged in using ChatGPT'\n")
    fs.chmodSync(join(env.PATH!, "codex"), 0o600)
    const result = await invokeCli(["auth", "status"], env)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("codex: unknown (codex CLI executable permission denied")
    expect(result.stdout).toContain("parent directories")
    expect(result.stdout).not.toContain("fake-cli-secret-path")
    expect(result.stdout).not.toContain("codex CLI not found on PATH")
    expect(result.stdout).toContain("claude CLI not found on PATH")
  })

  test("login reports a mode-0600 CLI as a permission problem without leaking paths or secrets", async () => {
    const env = fakeCodexCli("#!/bin/sh\nexit 0\n")
    fs.chmodSync(join(env.PATH!, "codex"), 0o600)
    const secret = "sk-auth-error-secret"
    const result = await invokeCli(["login", "codex"], { ...env, OPENAI_API_KEY: secret })
    const output = `${result.stdout}\n${result.stderr}`
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("codex CLI executable permission denied")
    expect(result.stderr).toContain("parent directories")
    expect(result.stderr).toContain("Do not run Otter with sudo")
    expect(output).not.toContain("fake-cli-secret-path")
    expect(output).not.toContain(secret)
    expect(output).not.toContain("EACCES")
  })

  test("failed login is not success when existing credentials keep status signed in", async () => {
    const env = fakeCodexCli(`#!/bin/sh
if [ "$1" = login ] && [ "$2" = status ]; then
  printf '%s\\n' 'Logged in using ChatGPT' >&2
  exit 0
fi
exit 23
`)
    const result = await invokeCli(["login", "codex"], env)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("codex: signed in")
    expect(result.stderr).toContain("codex login command exited with code 23.")
  })

  test("signal-terminated login is reported distinctly from a nonzero exit", async () => {
    const env = fakeCodexCli(`#!/bin/sh
if [ "$1" = login ] && [ "$2" = status ]; then
  printf '%s\\n' 'Logged in using ChatGPT' >&2
  exit 0
fi
kill -TERM "$$"
exit 0
`)
    const result = await invokeCli(["login", "codex"], env)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("codex: signed in")
    expect(result.stderr).toContain("codex login command was terminated by SIGTERM.")
    expect(result.stderr).not.toContain("exited with code")
  })

  test("an executable with a missing interpreter is a launch failure, not a PATH lookup miss", async () => {
    const env = fakeCodexCli("#!/missing/fake-cli-interpreter\nexit 0\n")
    const result = await invokeCli(["login", "codex"], env)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("codex CLI could not be started.")
    expect(result.stderr).toContain("found on PATH")
    expect(result.stderr).toContain("interpreter or runtime may be missing")
    expect(result.stderr).not.toContain("not found on PATH")
    expect(result.stderr).not.toContain("ENOENT")
    expect(result.stderr).not.toContain("fake-cli-secret-path")
    expect(result.stderr).not.toContain("fake-cli-interpreter")
  })
})
